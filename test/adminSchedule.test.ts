import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import Database from 'better-sqlite3';
import { AdminSchedule } from '../src/adminSchedule.js';
import { SqliteAdminStore } from '../src/adminStore.js';
import { BookingService } from '../src/booking.js';
import { SqliteBookingStore } from '../src/bookingStore.js';
import { pathsFor } from '../src/config.js';
import type { Settings } from '../src/config.js';
import type { BusyInterval, CalendarResource, GoogleEvent, WorkspaceApi } from '../src/workspace.js';

class FakeWorkspace implements WorkspaceApi {
  accept=true;
  events=new Map<string,GoogleEvent>();
  mails:Array<{to:string;subject:string}>=[];
  external:Record<string,BusyInterval[]>={};
  resources:CalendarResource[]=[
    {resourceId:'a',resourceEmail:'aula1@example.org',resourceName:'Aula 1'},
    {resourceId:'b',resourceEmail:'aula2@example.org',resourceName:'Aula 2'},
  ];
  writeCredentialsReady():boolean { return true; }
  async listResources():Promise<CalendarResource[]> { return this.resources; }
  async busyMany(emails:string[],start:string,end:string):Promise<Record<string,BusyInterval[]>> {
    return Object.fromEntries(await Promise.all(emails.map(async email=>[email,await this.busy(email,start,end)])));
  }
  async busy(email:string,start:string,end:string):Promise<BusyInterval[]> {
    return [...(this.external[email]??[]),...Array.from(this.events.values())
      .filter(event=>event.attendees?.some(item=>item.email===email&&item.responseStatus==='accepted'))
      .map(event=>({start:event.start!.dateTime,end:event.end!.dateTime}))]
      .filter(item=>Date.parse(item.start)<Date.parse(end)&&Date.parse(item.end)>Date.parse(start));
  }
  async insert(id:string,email:string,start:string,end:string):Promise<GoogleEvent> {
    const event:GoogleEvent={id,start:{dateTime:start},end:{dateTime:end},
      attendees:[{email,responseStatus:this.accept?'accepted':'declined'}]};
    this.events.set(id,event);return event;
  }
  async insertBlock(id:string,email:string,start:string,end:string,_label:string):Promise<GoogleEvent> {
    return this.insert(id,email,start,end);
  }
  async move(id:string,email:string,start:string,end:string):Promise<GoogleEvent> {
    const event=this.events.get(id)!;
    event.start={dateTime:start};event.end={dateTime:end};
    event.attendees=[{email,responseStatus:'accepted'}];return event;
  }
  async get(id:string):Promise<GoogleEvent> { return this.events.get(id)!; }
  async delete(id:string):Promise<void> { this.events.delete(id); }
  async sendMail(to:string,subject:string,_body:string,_sender:string):Promise<string> {
    this.mails.push({to,subject});return 'sent';
  }
}

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'sjma-admin-schedule-'));
  const paths=pathsFor(root);
  const settings:Settings={timezone:'Europe/Madrid',opening_hour:9,closing_hour:22,
    weekly_hours:Object.fromEntries(Array.from({length:7},(_,i)=>[String(i+1),{opening:'09:00',closing:'22:00'}])),
    slot_minutes:30,slot_step_minutes:30,min_minutes:30,max_minutes:300,max_days_ahead:90,
    organizer_email:'reserves@example.org',rooms:[
      {id:'aula-1',name:'Aula 1',email:'aula1@example.org'},
      {id:'aula-2',name:'Aula 2',email:'aula2@example.org'},
    ]};
  const workspace=new FakeWorkspace();
  const booking=new BookingService(paths,settings,workspace);
  const store=new SqliteAdminStore(paths);
  const schedule=new AdminSchedule(settings,workspace,booking,store);
  const day=DateTime.now().setZone('Europe/Madrid').plus({days:3}).toISODate()!;
  const close=()=>{schedule.close();booking.close();rmSync(root,{recursive:true,force:true});};
  return {workspace,booking,store,schedule,settings,day,close};
}

test('block and holiday create Workspace occupancy and cancel as a group',async()=>{
  const f=fixture();
  try {
    const block=await f.schedule.createBlock({rooms:['aula-1'],start:`${f.day}T10:00`,
      end:`${f.day}T11:00`,label:'Assaig',kind:'block'},'admin@example.org');
    assert.equal(block.count,1);
    assert.equal(f.workspace.events.size,1);
    const view=await f.schedule.calendar(f.day,'day');
    assert.equal(view.blocks.length,1);
    assert.equal(view.external.length,0);
    await assert.rejects(f.schedule.createBlock({rooms:['aula-1'],start:`${f.day}T10:30`,
      end:`${f.day}T11:30`,label:'Duplicat',kind:'block'},'admin@example.org'),/reserva|ocupad|bloqueig/);
    assert.equal(await f.schedule.cancelBlock(block.group_id,'admin@example.org'),1);
    assert.equal(f.workspace.events.size,0);
    const holiday=await f.schedule.createBlock({rooms:['aula-1','aula-2'],start:`${f.day}T00:00`,
      end:DateTime.fromISO(f.day).plus({days:1}).toISODate()+'T00:00',label:'Vacances',kind:'holiday'},
      'admin@example.org');
    assert.equal(holiday.count,2);
    assert.equal(f.workspace.events.size,2);
    assert.equal((await f.schedule.audit()).filter(item=>item.action==='block.create').length,2);
  } finally { f.close(); }
});

test('a resource decline rolls back a new block',async()=>{
  const f=fixture();
  try {
    f.workspace.accept=false;
    await assert.rejects(f.schedule.createBlock({rooms:['aula-1'],start:`${f.day}T10:00`,
      end:`${f.day}T11:00`,label:'Assaig',kind:'block'},'admin@example.org'),/no ha acceptat/);
    assert.equal(f.workspace.events.size,0);
    assert.equal((await f.schedule.calendar(f.day,'day')).blocks.length,0);
  } finally { f.close(); }
});

test('a failed Workspace rollback reports the group for manual review',async()=>{
  const f=fixture();
  try {
    f.workspace.accept=false;
    f.workspace.delete=async()=>{ throw new Error('Google is unavailable'); };
    await assert.rejects(f.schedule.createBlock({rooms:['aula-1'],start:`${f.day}T10:00`,
      end:`${f.day}T11:00`,label:'Assaig',kind:'block'},'admin@example.org'),
    /Cal revisar manualment el bloqueig [a-f0-9]{32}/);
    assert.equal(f.workspace.events.size,1);
  } finally { f.close(); }
});

test('external Workspace occupancy is visible without details and prevents blocking',async()=>{
  const f=fixture();
  try {
    f.workspace.external['aula1@example.org']=[{
      start:DateTime.fromISO(`${f.day}T10:00`,{zone:'Europe/Madrid'}).toISO()!,
      end:DateTime.fromISO(`${f.day}T11:00`,{zone:'Europe/Madrid'}).toISO()!,
    }];
    const view=await f.schedule.calendar(f.day,'day');
    assert.equal(view.external.length,1);
    assert.deepEqual(Object.keys(view.external[0]).sort(),['end','room_email','start']);
    await assert.rejects(f.schedule.createBlock({rooms:['aula-1'],start:`${f.day}T10:00`,
      end:`${f.day}T11:00`,label:'Assaig',kind:'block'},'admin@example.org'),/Workspace/);
  } finally { f.close(); }
});

test('secretariat booking can move and cancel with notifications and audit',async()=>{
  const f=fixture();
  try {
    const result=await f.schedule.createBooking({room:'aula-1',start:`${f.day}T10:00`,
      end:`${f.day}T11:00`,name:'Anna',last_name:'Soler',email:'anna@example.org',
      instrument:'Piano',relation:'Sòcia'},'admin@example.org');
    assert.equal(result.state,'confirmed');
    assert.equal((await f.store.getBooking(result.id))?.source,'admin');
    assert.equal(f.workspace.mails.length,2);
    await assert.rejects(f.schedule.createBlock({rooms:['aula-1'],start:`${f.day}T10:00`,
      end:`${f.day}T11:00`,label:'Tancat',kind:'block'},'admin@example.org'),/reserva|ocupad/);
    await f.schedule.moveBooking(result.id,'aula-2',`${f.day}T12:00`,`${f.day}T13:00`,'admin@example.org');
    assert.equal((await f.store.getBooking(result.id))?.room_email,'aula2@example.org');
    assert.equal(f.workspace.mails.length,4);
    await f.schedule.cancelBooking(result.id,'admin@example.org');
    assert.equal((await f.store.getBooking(result.id))?.state,'cancelled');
    assert.equal(f.workspace.events.size,0);
    assert.equal(f.workspace.mails.length,6);
    assert.deepEqual((await f.schedule.audit()).map(item=>item.action),
      ['booking.cancel','booking.move','booking.create']);
  } finally { f.close(); }
});

test('room rules limit duration and keep a buffer between reservations',async()=>{
  const f=fixture();
  try {
    f.settings.rooms[0].rules={max_minutes:60,buffer_minutes:30};
    await assert.rejects(f.booking.reserve({room:'aula-1',start:`${f.day}T10:00`,
      end:`${f.day}T11:30`,name:'Anna',email:'anna@example.org'}),/duració/);
    await f.booking.reserve({room:'aula-1',start:`${f.day}T10:00`,end:`${f.day}T11:00`,
      name:'Anna',email:'anna@example.org'});
    await assert.rejects(f.booking.reserve({room:'aula-1',start:`${f.day}T11:00`,
      end:`${f.day}T11:30`,name:'Pau',email:'pau@example.org'}),/ocupado|ocupat/);
    const availability=await f.booking.dayAvailability(f.day);
    assert.equal(availability.rooms['aula-1'].starts.some(item=>item.time==='11:00'),false);
    assert.equal(availability.rooms['aula-1'].starts.some(item=>item.time==='11:30'),true);
  } finally { f.close(); }
});

test('per-room closed day, custom hours and minimum notice affect public slots',async()=>{
  const f=fixture();
  try {
    const weekday=String(DateTime.fromISO(f.day,{zone:'Europe/Madrid'}).weekday);
    f.settings.rooms[0].rules={weekly_hours:{[weekday]:{closed:true}}};
    assert.deepEqual((await f.booking.dayAvailability(f.day)).rooms['aula-1'].starts,[]);
    await assert.rejects(f.booking.reserve({room:'aula-1',start:`${f.day}T10:00`,
      end:`${f.day}T11:00`,name:'Anna',email:'anna@example.org'}),/horari|torns/);
    f.settings.rooms[0].rules={weekly_hours:{[weekday]:{opening:'15:00',closing:'17:00'}}};
    const starts=(await f.booking.dayAvailability(f.day)).rooms['aula-1'].starts;
    assert.equal(starts.some(item=>item.time==='10:00'),false);
    assert.equal(starts.some(item=>item.time==='15:00'),true);
    f.settings.rooms[0].rules={min_notice_hours:120};
    assert.deepEqual((await f.booking.dayAvailability(f.day)).rooms['aula-1'].starts,[]);
  } finally { f.close(); }
});

test('existing SQLite bookings survive the cancelled-state upgrade',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sjma-old-bookings-'));
  const paths=pathsFor(root);
  try {
    mkdirSync(paths.privateDir,{recursive:true});
    const db=new Database(paths.db);
    db.exec(`CREATE TABLE bookings (
      id TEXT PRIMARY KEY,room_email TEXT NOT NULL,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,
      requester_name TEXT NOT NULL,requester_email TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'declined', 'failed')),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );`);
    db.prepare(`INSERT INTO bookings VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'a'.repeat(32),'aula1@example.org','2026-10-01T10:00:00Z','2026-10-01T11:00:00Z',
      'Anna','anna@example.org','confirmed','2026-09-29T10:00:00Z','2026-09-29T10:00:00Z');
    db.close();
    const store=new SqliteBookingStore(paths);
    assert.equal((await store.get('a'.repeat(32)))?.requester_name,'Anna');
    store.close();
    const admin=new SqliteAdminStore(paths);
    assert.equal(await admin.cancelBooking('a'.repeat(32)),true);
    assert.equal((await admin.getBooking('a'.repeat(32)))?.state,'cancelled');
    admin.close();
  } finally { rmSync(root,{recursive:true,force:true}); }
});
