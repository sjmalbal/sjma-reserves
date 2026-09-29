import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { AdminStore, BlockRow } from './adminStore.js';
import type { BookingRow, BookingService, ReserveInput } from './booking.js';
import type { Room, Settings } from './config.js';
import { GoogleError, resourceResponse } from './workspace.js';
import type { BusyInterval, GoogleEvent, WorkspaceApi } from './workspace.js';

const id=()=>randomBytes(16).toString('hex');
const zone='Europe/Madrid';
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const utc=(date:DateTime)=>date.toUTC().toISO()!;
const overlaps=(a:string,b:string,interval:BusyInterval)=>Date.parse(a)<Date.parse(interval.end)
  && Date.parse(interval.start)<Date.parse(b);

export interface BlockInput {
  rooms:string[]; start:string; end:string; label:string;
  kind:'block'|'holiday'; repeat?:'none'|'daily'|'weekly'; until?:string;
}

export class AdminSchedule {
  private activeBookings=new Set<string>();
  constructor(private settings:Settings,private workspace:WorkspaceApi,
    private booking:BookingService,private store:AdminStore) {}
  close():void { this.store.close(); }

  private room(id:string):Room {
    const room=this.settings.rooms.find(item=>item.id===id);
    if (!room) throw new RangeError('Aula no publicada o inexistent');
    return room;
  }
  private datetime(value:string):DateTime {
    if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value))
      throw new RangeError('Data i hora no vàlides');
    const date=DateTime.fromISO(value,/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? {setZone:true} : {zone});
    if (!date.isValid) throw new RangeError('Data i hora no vàlides');
    return date.setZone(zone);
  }

  async calendar(day:string,view:'day'|'week') {
    const selected=DateTime.fromISO(day,{zone});
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !selected.isValid || selected.toISODate()!==day)
      throw new RangeError('Data no vàlida');
    const first=(view==='week' ? selected.startOf('week') : selected).startOf('day');
    const last=first.plus({days:view==='week'?7:1});
    const start=utc(first),end=utc(last);
    const [bookings,blocks,google]=await Promise.all([
      this.store.listBookings(start,end),this.store.listBlocks(start,end),
      this.workspace.busyMany(this.settings.rooms.map(room=>room.email),start,end),
    ]);
    const known=[...bookings.filter(item=>['confirmed','pending'].includes(item.state))
      .map(item=>({room:item.room_email,start:item.starts_at,end:item.ends_at})),
      ...blocks.map(item=>({room:item.room_email,start:item.starts_at,end:item.ends_at}))];
    const external=this.settings.rooms.flatMap(room=>(google[room.email]??[])
      .filter(interval=>!known.some(item=>item.room.toLowerCase()===room.email.toLowerCase()
        && overlaps(item.start,item.end,interval)))
      .map(interval=>({room_email:room.email,...interval})));
    return {start,end,rooms:this.settings.rooms.map(room=>({id:room.id,title:room.name,email:room.email})),
      bookings,blocks,external};
  }

  private async eventAccepted(id:string,email:string,start:string,end:string):Promise<boolean> {
    for (let attempt=0;attempt<5;attempt++) {
      const event=await this.workspace.get(id);
      if (resourceResponse(event,email)==='declined') return false;
      if (Date.parse(event.start?.dateTime??'')===Date.parse(start)
        && Date.parse(event.end?.dateTime??'')===Date.parse(end)
        && resourceResponse(event,email)==='accepted') return true;
      const busy=await this.workspace.busy(email,start,end);
      if (busy.some(interval=>Date.parse(interval.start)<=Date.parse(start)
        && Date.parse(interval.end)>=Date.parse(end))) return true;
      await new Promise(resolve=>setTimeout(resolve,450));
    }
    return false;
  }

  private async conflict(room:Room,start:string,end:string,ignoreBookingId?:string):Promise<void> {
    const buffer=room.rules?.buffer_minutes ?? 0;
    const lookupStart=utc(DateTime.fromISO(start).minus({minutes:buffer}));
    const lookupEnd=utc(DateTime.fromISO(end).plus({minutes:buffer}));
    const [google,bookings,blocks]=await Promise.all([
      this.workspace.busy(room.email,lookupStart,lookupEnd),
      this.store.listBookings(lookupStart,lookupEnd),
      this.store.listBlocks(lookupStart,lookupEnd),
    ]);
    const conflict=(interval:BusyInterval)=>overlaps(lookupStart,lookupEnd,interval);
    const knownBooking=bookings.filter(row=>row.id!==ignoreBookingId
      && row.room_email.toLowerCase()===room.email.toLowerCase()
      && ['pending','confirmed'].includes(row.state));
    const knownBlock=blocks.filter(row=>row.room_email.toLowerCase()===room.email.toLowerCase());
    if (knownBooking.some(row=>conflict({start:row.starts_at,end:row.ends_at}))
      || knownBlock.some(row=>conflict({start:row.starts_at,end:row.ends_at})))
      throw new RangeError('La franja té una reserva o un bloqueig existent');
    // The current booking is represented in FreeBusy and may overlap its new time.
    const ignored=ignoreBookingId ? bookings.find(row=>row.id===ignoreBookingId) : undefined;
    const external=google.filter(interval=>!ignored
      || room.email.toLowerCase()!==ignored.room_email.toLowerCase()
      || interval.start!==ignored.starts_at && Date.parse(interval.start)!==Date.parse(ignored.starts_at)
      || interval.end!==ignored.ends_at && Date.parse(interval.end)!==Date.parse(ignored.ends_at));
    if (external.some(conflict)) throw new RangeError('La franja està ocupada en Google Workspace');
  }

  async createBlock(input:BlockInput,actor:string):Promise<{group_id:string;count:number}> {
    if (!Array.isArray(input.rooms) || !input.rooms.length || input.rooms.length>this.settings.rooms.length)
      throw new RangeError('Selecciona les aules del bloqueig');
    const rooms=[...new Set(input.rooms)].map(value=>this.room(value));
    const label=(input.label??'').trim();
    if (!label || label.length>120 || /[\x00-\x1f]/.test(label)) throw new RangeError('Motiu del bloqueig no vàlid');
    if (!['block','holiday'].includes(input.kind)) throw new RangeError('Tipus de bloqueig no vàlid');
    const start=this.datetime(input.start),end=this.datetime(input.end);
    if (end<=start || start<DateTime.now().setZone(zone).startOf('day')
      || end<=DateTime.now().setZone(zone) || end.diff(start,'days').days>90)
      throw new RangeError('El bloqueig ha de ser futur i durar com a màxim 90 dies');
    const repeat=input.repeat??'none';
    if (!['none','daily','weekly'].includes(repeat) || input.kind==='holiday' && repeat!=='none')
      throw new RangeError('Repetició no vàlida');
    const until=repeat==='none' ? start : DateTime.fromISO(input.until??'',{zone});
    if (!until.isValid || until<start.startOf('day') || until.diff(start,'days').days>365)
      throw new RangeError('Indica una data de finalització dins d’un any');
    const dates:DateTime[]=[];
    for (let current=start;current.startOf('day')<=until.startOf('day');
      current=current.plus({days:repeat==='weekly'?7:1})) {
      dates.push(current);
      if (repeat==='none') break;
    }
    if (dates.length*rooms.length>80) throw new RangeError('Crea com a màxim 80 bloquejos cada vegada');
    const group=id(),created:BlockRow[]=[];
    try {
      for (const date of dates) for (const room of rooms) {
        const endDayOffset=Math.round(end.startOf('day').diff(start.startOf('day'),'days').days);
        const recurringEnd=date.plus({days:endDayOffset}).set({hour:end.hour,minute:end.minute,second:0,millisecond:0});
        const blockStart=utc(date),blockEnd=utc(recurringEnd);
        await this.conflict(room,blockStart,blockEnd);
        const row:BlockRow={id:id(),group_id:group,room_email:room.email.toLowerCase(),
          starts_at:blockStart,ends_at:blockEnd,label,kind:input.kind,created_by:actor,
          created_at:new Date().toISOString(),cancelled_at:null};
        created.push(row);
        await this.workspace.insertBlock(row.id,room.email,date.toISO()!,recurringEnd.toISO()!,label);
        if (!await this.eventAccepted(row.id,room.email,blockStart,blockEnd))
          throw new RangeError(`Google Workspace no ha acceptat el bloqueig de ${room.name}`);
        await this.store.insertBlock(row);
      }
      await this.store.audit(actor,'block.create',group,{kind:input.kind,count:created.length});
      return {group_id:group,count:created.length};
    } catch(error) {
      let rollbackFailed=false;
      for (const row of created.reverse()) {
        try { await this.workspace.delete(row.id); }
        catch(deleteError) {
          if (!(deleteError instanceof GoogleError && deleteError.status===404)) {
            rollbackFailed=true;
            continue;
          }
        }
        try { await this.store.cancelBlock(row.id); } catch { rollbackFailed=true; }
      }
      if (rollbackFailed) throw new RangeError(`Cal revisar manualment el bloqueig ${group}: la reversió no s’ha completat`);
      throw error;
    }
  }

  async cancelBlock(group:string,actor:string):Promise<number> {
    if (!/^[a-f0-9]{32}$/.test(group)) throw new RangeError('Bloqueig no vàlid');
    const rows=await this.store.blocksByGroup(group);
    if (!rows.length) throw new RangeError('Bloqueig no trobat');
    let removed=0;
    for (const row of rows) {
      try { await this.workspace.delete(row.id); }
      catch(error) { if (!(error instanceof GoogleError && error.status===404)) throw error; }
      if (await this.store.cancelBlock(row.id)) removed++;
    }
    await this.store.audit(actor,'block.cancel',group,{count:removed});
    return removed;
  }

  async createBooking(input:ReserveInput,actor:string) {
    const result=await this.booking.reserve(input,'admin');
    await this.store.audit(actor,'booking.create',result.id,{room:input.room,state:result.state});
    return result;
  }

  private async mailChange(row:BookingRow,subject:string,description:string):Promise<{sent:number;failed:number}> {
    const sender=this.settings.organizer_email;
    if (!sender || !EMAIL.test(row.requester_email)) return {sent:0,failed:2};
    const body=`Hola, ${row.requester_name}.\n\n${description}\n\nReferència: ${row.id}\nPer a qualsevol consulta, escriu a secretaria@sjmalbal.com.\n\nSocietat Joventut Musical d'Albal\n`;
    let sent=0,failed=0;
    for (const [to,text] of [[row.requester_email,body],
      [this.settings.notification_email||'secretaria@sjmalbal.com',
        `${description}\n\nReferència: ${row.id}\nPersona: ${row.requester_name} ${row.requester_last_name}\nCorreu: ${row.requester_email}\n`]]) {
      try { await this.workspace.sendMail(to,subject,text,sender);sent++; }
      catch { failed++;console.error(`Admin booking mail failed: ${row.id}`); }
    }
    return {sent,failed};
  }

  async cancelBooking(id:string,actor:string):Promise<{sent:number;failed:number}> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new RangeError('Referència no vàlida');
    if (this.activeBookings.has(id)) throw new RangeError('Esta reserva ja s’està modificant');
    this.activeBookings.add(id);
    try {
    const row=await this.store.getBooking(id);
    if (!row || !['pending','confirmed'].includes(row.state)) throw new RangeError('La reserva no es pot cancel·lar');
    try { await this.workspace.delete(id); }
    catch(error) { if (!(error instanceof GoogleError && error.status===404)) throw error; }
    if (!await this.store.cancelBooking(id)) throw new Error('Reserva eliminada en Google però no actualitzada en la base de dades');
    await this.store.audit(actor,'booking.cancel',id,{room:row.room_email});
    return await this.mailChange(row,'Reserva d’espai cancel·lada',
      `La reserva de ${row.room_name} del ${DateTime.fromISO(row.starts_at).setZone(zone).toFormat('dd/MM/yyyy HH:mm')} ha sigut cancel·lada.`);
    } finally { this.activeBookings.delete(id); }
  }

  async moveBooking(id:string,roomId:string,startText:string,endText:string,actor:string):Promise<{sent:number;failed:number}> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new RangeError('Referència no vàlida');
    if (this.activeBookings.has(id)) throw new RangeError('Esta reserva ja s’està modificant');
    this.activeBookings.add(id);
    try {
    const old=await this.store.getBooking(id);
    if (!old || old.state!=='confirmed') throw new RangeError('Només es poden canviar reserves confirmades');
    const target=this.booking.validateAdminRange(roomId,startText,endText);
    if (old.room_email.toLowerCase()===target.room.email.toLowerCase()
      && Date.parse(old.starts_at)===Date.parse(target.startUtc)
      && Date.parse(old.ends_at)===Date.parse(target.endUtc))
      throw new RangeError('No hi ha cap canvi en la reserva');
    await this.conflict(target.room,target.startUtc,target.endUtc,id);
    try { await this.workspace.move(id,target.room.email,target.start,target.end); }
    catch(error) {
      try {
        const event=await this.workspace.get(id);
        if (Date.parse(event.start?.dateTime??'')!==Date.parse(target.startUtc)
          || Date.parse(event.end?.dateTime??'')!==Date.parse(target.endUtc)) throw error;
      } catch(checkError) {
        if (checkError===error) throw error;
        throw new Error('Cal revisar manualment esta reserva: no es pot confirmar el canvi en Google');
      }
    }
    try {
      if (!await this.eventAccepted(id,target.room.email,target.startUtc,target.endUtc))
        throw new RangeError('Google Workspace no ha acceptat la nova aula o hora');
      if (!await this.store.moveBooking(id,target.room.email.toLowerCase(),target.room.name,target.startUtc,target.endUtc))
        throw new Error('No s’ha actualitzat la reserva');
    } catch(error) {
      try { await this.workspace.move(id,old.room_email,DateTime.fromISO(old.starts_at).setZone(zone).toISO()!,
        DateTime.fromISO(old.ends_at).setZone(zone).toISO()!); }
      catch { throw new Error('Cal revisar manualment esta reserva: la reversió en Google ha fallat'); }
      throw error;
    }
    await this.store.audit(actor,'booking.move',id,{from_room:old.room_email,to_room:target.room.email,
      from_start:old.starts_at,to_start:target.startUtc});
    return await this.mailChange({...old,room_name:target.room.name,starts_at:target.startUtc},
      'Canvi en la reserva d’espai',
      `La reserva s’ha canviat a ${target.room.name}, el ${DateTime.fromISO(target.startUtc).setZone(zone).toFormat('dd/MM/yyyy')} de ${DateTime.fromISO(target.startUtc).setZone(zone).toFormat('HH:mm')} a ${DateTime.fromISO(target.endUtc).setZone(zone).toFormat('HH:mm')}.`);
    } finally { this.activeBookings.delete(id); }
  }

  async audit(limit=100) { return this.store.listAudit(Math.min(Math.max(limit,1),200)); }
  async record(actor:string,action:string,target:string,details:Record<string,unknown>={}) {
    await this.store.audit(actor,action,target,details);
  }
}
