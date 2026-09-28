import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DateTime } from 'luxon';
import sharp from 'sharp';
import { BookingService } from '../src/booking.js';
import { Catalogue } from '../src/catalogue.js';
import { pathsFor } from '../src/config.js';
import type { Paths, Settings } from '../src/config.js';
import type { BusyInterval, CalendarResource, GoogleEvent, WorkspaceApi } from '../src/workspace.js';
import { buildApp } from '../src/server.js';
import { EVENT_SCOPE, MAIL_SCOPE, Workspace } from '../src/workspace.js';
import type { AdminIdentity } from '../src/adminAuth.js';

class FakeWorkspace implements WorkspaceApi {
  resources: CalendarResource[] = [
    { resourceId: 'resource-1', resourceEmail: 'aula@example.org', resourceName: 'Aula 1' },
    { resourceId: 'resource-2', resourceEmail: 'secretaria@example.org', resourceName: 'Secretaria' },
  ];
  externalBusy: BusyInterval[] = [];
  response = 'accepted';
  events = new Map<string, GoogleEvent>();
  mails: Array<{to: string; subject: string; body: string; sender: string}> = [];
  writeCredentialsReady(): boolean { return true; }
  async listResources(): Promise<CalendarResource[]> { return this.resources; }
  async busyMany(emails: string[]): Promise<Record<string, BusyInterval[]>> {
    return Object.fromEntries(await Promise.all(emails.map(async email => [email, await this.busy(email)])));
  }
  async busy(_email: string): Promise<BusyInterval[]> {
    const booked = [...this.events.values()].filter(event => event.attendees?.[0]?.responseStatus === 'accepted')
      .map(event => ({ start: event.start!.dateTime, end: event.end!.dateTime }));
    return [...this.externalBusy, ...booked];
  }
  async insert(id: string, resourceEmail: string, start: string, end: string): Promise<GoogleEvent> {
    const event: GoogleEvent = { id, start: {dateTime: start}, end: {dateTime: end},
      attendees: [{email: resourceEmail, responseStatus: this.response}] };
    this.events.set(id, event);
    return event;
  }
  async get(id: string): Promise<GoogleEvent> { return this.events.get(id)!; }
  async delete(id: string): Promise<void> { this.events.delete(id); }
  async sendMail(to: string, subject: string, body: string, sender: string): Promise<string> {
    this.mails.push({to, subject, body, sender});
    return 'message-id';
  }
}

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, {recursive:true,force:true}); });

function fixture(): {paths: Paths; settings: Settings; workspace: FakeWorkspace; service: BookingService} {
  const root = mkdtempSync(join(tmpdir(), 'sjma-ts-'));
  temporary.push(root);
  const paths = pathsFor(root);
  mkdirSync(paths.assets, {recursive:true});
  const settings: Settings = {
    timezone: 'Europe/Madrid', opening_hour: 9, closing_hour: 21,
    slot_minutes: 60, slot_step_minutes: 30, min_minutes: 30, max_minutes: 300,
    max_days_ahead: 30, organizer_email: 'reserves@example.org',
    rooms: [{id:'aula-1',name:'Aula 1',email:'aula@example.org'}],
  };
  const workspace = new FakeWorkspace();
  const service = new BookingService(paths, settings, workspace,
    () => DateTime.fromISO('2026-09-26T09:00:00', {zone:'Europe/Madrid'}));
  return {paths,settings,workspace,service};
}

test('Google busy interval ends at 18:30 and allows that start', async () => {
  const {workspace, service} = fixture();
  workspace.externalBusy = [{start:'2026-09-28T14:00:00+02:00', end:'2026-09-28T18:30:00+02:00'}];
  const day = await service.dayAvailability('2026-09-28');
  const starts = day.rooms['aula-1'].starts;
  assert.equal(starts.find(start => start.label === '13:00')?.ends.at(-1)?.label, '14:00');
  assert.equal(starts.some(start => start.label === '18:00'), false);
  assert.equal(starts.some(start => start.label === '18:30'), true);
  service.close();
});

test('autumn clock change keeps both distinct 02:00 starts', async () => {
  const {settings,service} = fixture();
  settings.opening_hour = 0;
  settings.closing_hour = 24;
  const day = await service.dayAvailability('2026-10-25');
  const repeated = day.rooms['aula-1'].starts.filter(start => start.time === '02:00');
  assert.deepEqual(repeated.map(start => start.label), ['02:00 (UTC+2)', '02:00 (UTC+1)']);
  assert.deepEqual(repeated.map(start => start.value), ['2026-10-25T02:00:00+02:00', '2026-10-25T02:00:00+01:00']);
  service.close();
});

test('confirmed booking blocks overlaps and sends exactly two mails', async () => {
  const {workspace, service} = fixture();
  const input = {room:'aula-1',start:'2026-09-28T10:00:00+02:00',end:'2026-09-28T11:00:00+02:00',
    name:'Anna',last_name:'Pérez',email:'anna@example.org',instrument:'Piano',relation:'Sòcia',note:'Faré classe'};
  const result = await service.reserve(input);
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(result.notifications, {requester:'sent',secretariat:'sent'});
  assert.deepEqual(workspace.mails.map(mail => mail.to), ['anna@example.org','secretaria@sjmalbal.com']);
  assert.match(workspace.mails[1].body, /Faré classe/);
  assert.equal((await service.refresh(result.id)).state, 'confirmed');
  assert.equal(workspace.mails.length, 2);
  await assert.rejects(service.reserve(input), /reservado|ocupado/);
  service.close();
});

test('declined resource sends no mail and pending waits for acceptance', async () => {
  const {workspace, service} = fixture();
  const input = {room:'aula-1',start:'2026-09-28T10:00:00+02:00',end:'2026-09-28T11:00:00+02:00',
    name:'Anna',email:'anna@example.org'};
  workspace.response = 'declined';
  assert.equal((await service.reserve(input)).state, 'declined');
  workspace.response = 'needsAction';
  const pending = await service.reserve({...input,start:'2026-09-28T12:00:00+02:00',end:'2026-09-28T13:00:00+02:00'});
  assert.equal(pending.state, 'pending');
  assert.equal(workspace.mails.length, 0);
  workspace.events.get(pending.id)!.attendees![0].responseStatus = 'accepted';
  assert.equal((await service.refresh(pending.id)).state, 'confirmed');
  assert.equal(workspace.mails.length, 2);
  service.close();
});

test('admin lists only Workspace resources and saves local photo metadata', async () => {
  const {paths,settings,workspace,service} = fixture();
  writeFileSync(paths.catalogue, '{}');
  const catalogue = new Catalogue(paths, settings, workspace);
  assert.equal((await catalogue.adminRows()).length, 2);
  const row = (await catalogue.adminRows())[1];
  const photo = await sharp({create:{width:20,height:20,channels:3,background:'red'}}).png().toBuffer();
  await catalogue.save(row.key,{title:'Sala pública',features:['Piano'],removePhotos:[],published:true,uploads:[photo],sortOrder:20});
  assert.equal(settings.rooms.length, 2);
  assert.equal(catalogue.publicRooms()[1].title, 'Sala pública');
  assert.equal(catalogue.publicRooms()[1].photos.length, 1);
  assert.equal(workspace.resources.length, 2);
  const override = JSON.parse(readFileSync(paths.overrides,'utf8'));
  assert.equal(override[row.room_id].resource_email, row.email);
  service.close();
});

test('admin order controls the public room list', async () => {
  const {paths,settings,workspace,service}=fixture();
  const catalogue=new Catalogue(paths,settings,workspace);
  const second=(await catalogue.adminRows()).find(row=>row.email==='secretaria@example.org')!;
  await catalogue.save(second.key,{title:'Sala B',features:[],removePhotos:[],published:true,uploads:[],sortOrder:1});
  assert.deepEqual(catalogue.publicRooms().map(room=>room.title),['Sala B','Aula 1']);
  await catalogue.save(second.key,{title:'Sala B',features:[],removePhotos:[],published:true,uploads:[],sortOrder:30});
  assert.deepEqual(catalogue.publicRooms().map(room=>room.title),['Aula 1','Sala B']);
  await assert.rejects(catalogue.save(second.key,{title:'Sala B',features:[],removePhotos:[],published:true,uploads:[],sortOrder:0}),/ordre/);
  service.close();
});

test('admin can choose a cover and remove a photo without changing Workspace resources', async () => {
  const {paths,settings,workspace,service} = fixture();
  writeFileSync(paths.catalogue, '{}');
  const catalogue = new Catalogue(paths,settings,workspace);
  const row = (await catalogue.adminRows())[0];
  const photo = await sharp({create:{width:20,height:20,channels:3,background:'blue'}}).png().toBuffer();
  await catalogue.save(row.key,{title:'Aula 1',features:[],removePhotos:[],published:true,uploads:[photo,photo],sortOrder:10});
  const before = catalogue.publicRooms()[0].photos;
  assert.equal(before.length,2);
  await catalogue.save(row.key,{title:'Aula 1',features:[],removePhotos:[],published:true,uploads:[],coverPhoto:before[1],sortOrder:10});
  assert.equal(catalogue.publicRooms()[0].photos[0],before[1]);
  assert.deepEqual(await catalogue.removePhoto(row.key,before[1]),[before[0]]);
  assert.deepEqual(catalogue.publicRooms()[0].photos,[before[0]]);
  await assert.rejects(catalogue.removePhoto(row.key,before[1]),/Fotografia no trobada/);
  assert.equal(workspace.resources.length,2);
  service.close();
});

test('Fastify keeps public booking writes disabled by default and protects admin', async () => {
  const {paths,settings,workspace,service} = fixture();
  paths.assets = join(import.meta.dirname, '../assets');
  paths.catalogue = join(paths.assets, 'catalogue.json');
  let allowed = true;
  const identity: AdminIdentity = {
    authorizationUrl: (state) => `https://accounts.example.test/authorize?state=${state}`,
    exchange: async () => 'admin@sjmalbal.com',
    isAdmin: async (email) => allowed && email === 'admin@sjmalbal.com',
  };
  const app = await buildApp({paths,settings,workspace,adminIdentity:identity,dataBackend:'sqlite'});
  const publicPage = await app.inject({url:'/'});
  assert.equal(publicPage.statusCode, 200);
  assert.match(publicPage.body, /Reserves temporalment tancades/);
  assert.equal((await app.inject({url:'/aules/aula-1'})).statusCode, 200);
  assert.equal((await app.inject({url:'/aules/aula-1/reserves/'+'a'.repeat(32)})).statusCode, 200);
  assert.equal((await app.inject({url:'/aules/aula-inexistent'})).statusCode, 404);
  assert.equal((await app.inject({method:'POST',url:'/api/bookings',payload:{}})).statusCode, 503);
  assert.equal((await app.inject({url:'/admin'})).headers.location, '/admin/login');
  assert.equal((await app.inject({method:'POST',url:'/admin/resources/key/photos/remove',payload:{}})).statusCode,401);
  assert.equal((await app.inject({url:'/admin',headers:{authorization:'Basic YWRtaW46dGVzdC1zZWNyZXQ='}})).statusCode,303);
  assert.match((await app.inject({url:'/admin/login'})).body,/Continua amb Google/);
  const start = await app.inject({url:'/admin/auth/start'});
  assert.equal(start.statusCode,303);
  const state = new URL(String(start.headers.location)).searchParams.get('state')!;
  const stateCookie = (start.headers['set-cookie'] as string).split(';')[0];
  assert.equal((await app.inject({url:`/admin/auth/callback?code=ok&state=${state}`,headers:{cookie:'sjma_admin_state=wrong'}})).statusCode,403);
  const callback = await app.inject({url:`/admin/auth/callback?code=ok&state=${state}`,headers:{cookie:stateCookie}});
  assert.equal(callback.statusCode,303);
  const sessionCookie = (callback.headers['set-cookie'] as string[]).find(value => value.startsWith('sjma_admin_session='))!.split(';')[0];
  const authorized = await app.inject({url:'/admin',headers:{cookie:sessionCookie}});
  assert.equal(authorized.statusCode, 200);
  assert.match(authorized.body, /Secretaria/);
  assert.match(authorized.body, /admin@sjmalbal.com/);
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(authorized.body)?.[1];
  assert.ok(csrf);
  const key = (await new Catalogue(paths,settings,workspace).adminRows())[0].key;
  const boundary = 'sjma-test-boundary';
  const form = (token: string) => ['csrf_token', 'title', 'sort_order', 'published', 'features'].map((name, index) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${[token,'Aula renovada','10','on','Piano'][index]}\r\n`).join('') + `--${boundary}--\r\n`;
  const headers = {cookie:sessionCookie,
    'content-type':`multipart/form-data; boundary=${boundary}`};
  assert.equal((await app.inject({method:'POST',url:`/admin/resources/${key}`,headers,payload:form('bad')})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:`/admin/resources/${key}`,headers,payload:form(csrf)})).statusCode,303);
  assert.equal(new Catalogue(paths,settings,workspace).publicRooms()[0].title,'Aula renovada');
  const catalogue = new Catalogue(paths,settings,workspace);
  const image = await sharp({create:{width:20,height:20,channels:3,background:'green'}}).png().toBuffer();
  await catalogue.save(key,{title:'Aula renovada',features:['Piano'],removePhotos:[],published:true,uploads:[image],sortOrder:10});
  const photo = catalogue.publicRooms()[0].photos[0];
  assert.equal((await app.inject({method:'POST',url:`/admin/resources/${key}/photos/remove`,
    headers:{cookie:sessionCookie},payload:{photo,csrf_token:'wrong'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:`/admin/resources/${key}/photos/remove`,
    headers:{cookie:sessionCookie},payload:{photo,csrf_token:csrf}})).statusCode,200);
  assert.deepEqual(catalogue.publicRooms()[0].photos,[]);
  allowed = false;
  assert.equal((await app.inject({url:'/admin',headers:{cookie:sessionCookie}})).statusCode,303);
  assert.equal((await app.inject({method:'POST',url:`/admin/resources/${key}/photos/remove`,headers:{cookie:sessionCookie},payload:{photo,csrf_token:csrf}})).statusCode,401);
  const deniedStart = await app.inject({url:'/admin/auth/start'});
  const deniedState = new URL(String(deniedStart.headers.location)).searchParams.get('state')!;
  assert.equal((await app.inject({url:`/admin/auth/callback?code=ok&state=${deniedState}`,
    headers:{cookie:(deniedStart.headers['set-cookie'] as string).split(';')[0]}})).statusCode,403);
  allowed = true;
  const logoutStart = await app.inject({url:'/admin/auth/start'});
  const logoutState = new URL(String(logoutStart.headers.location)).searchParams.get('state')!;
  const logoutCallback = await app.inject({url:`/admin/auth/callback?code=ok&state=${logoutState}`,
    headers:{cookie:(logoutStart.headers['set-cookie'] as string).split(';')[0]}});
  const logoutCookie = (logoutCallback.headers['set-cookie'] as string[]).find(value => value.startsWith('sjma_admin_session='))!.split(';')[0];
  const logoutPage = await app.inject({url:'/admin',headers:{cookie:logoutCookie}});
  const logoutCsrf = /name="csrf_token" value="([^"]+)"/.exec(logoutPage.body)?.[1];
  assert.ok(logoutCsrf);
  assert.equal((await app.inject({method:'POST',url:'/admin/logout',headers:{cookie:logoutCookie,'content-type':'application/x-www-form-urlencoded'},
    payload:`csrf_token=${logoutCsrf}`})).statusCode,303);
  assert.equal((await app.inject({url:'/admin',headers:{cookie:logoutCookie}})).statusCode,303);
  await app.close();
  service.close();
});

test('Workspace invites the resource and sends the two MIME messages through Gmail', async () => {
  const {paths,settings,service} = fixture();
  settings.organizer_email = 'reserves@example.org';
  writeFileSync(paths.writeToken, JSON.stringify({
    client_id:'local-test-client', client_secret:'local-test-secret', refresh_token:'local-test-refresh',
    token:'local-test-access', expiry:'2099-01-01T00:00:00Z', scopes:[EVENT_SCOPE,MAIL_SCOPE],
  }));
  const calls: Array<{url: string; body: Record<string, unknown>}> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({url:String(url),body:JSON.parse(String(init?.body)) as Record<string,unknown>});
    return new Response(JSON.stringify(calls.length === 1 ? {id:'booking123'} : {id:'message123'}),
      {status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const workspace = new Workspace(paths,settings);
    await workspace.insert('booking123','aula@example.org','2026-09-28T10:00:00+02:00','2026-09-28T11:00:00+02:00');
    await workspace.sendMail('anna@example.org','Reserva confirmada','Hola Anna','reserves@example.org');
  } finally { globalThis.fetch = originalFetch; service.close(); }
  assert.match(calls[0].url,/\/calendars\/primary\/events\?sendUpdates=all$/);
  assert.deepEqual(calls[0].body.attendees,[{email:'aula@example.org',resource:true}]);
  assert.match(calls[1].url,/\/users\/me\/messages\/send$/);
  const mime = Buffer.from(String(calls[1].body.raw),'base64url').toString('utf8');
  assert.match(mime,/To: anna@example.org/);
  assert.match(mime,/From: reserves@example.org/);
  assert.match(mime,/Reply-To: secretaria@sjmalbal.com/);
});
