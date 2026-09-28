/** Real end-to-end test: HTTP booking, Workspace resource, two Gmail sends and cleanup. */
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DateTime } from 'luxon';
import { pathsFor, readSettings } from './config.js';
import { supabaseServerClient } from './supabaseClient.js';
import { GoogleError, resourceResponse, Workspace } from './workspace.js';
import type { BookingResult, DayAvailability } from './booking.js';

if (!process.argv.includes('--confirmar-prueba-real'))
  throw new Error('Falta --confirmar-prueba-real: aquesta prova crea una reserva i envia correus reals');
const root=new URL(process.env.SJMA_TEST_BASE_URL ?? 'http://127.0.0.1:8767/');
if (root.protocol!=='http:' || root.hostname!=='127.0.0.1') throw new Error('La prova només pot utilitzar el servidor local');

const paths=pathsFor(),settings=readSettings(paths),client=supabaseServerClient(paths);
const workspace=new Workspace(paths,settings);
const roomId='aula-2';
const room=settings.rooms.find(item=>item.id===roomId);
if (!room || !settings.organizer_email || !workspace.writeCredentialsReady()) throw new Error('Falten el recurs o les credencials de Gmail i Calendar');
const marker=`PROVA TÈCNICA SJMA ${randomBytes(8).toString('hex')}`;

async function json<T>(path:string,init?:RequestInit):Promise<T> {
  const response=await fetch(new URL(path,root),{...init,signal:AbortSignal.timeout(30_000)});
  const body=await response.json() as T & {error?:string};
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error ?? 'error'}`);
  return body;
}

let start='',end='',id='';
let result:BookingResult|undefined;
let cleaned=false;
let released=false;
let cleanupMailSent=false;
let failure:unknown;
try {
  for (let offset=1;offset<=7 && !start;offset++) {
    const day=DateTime.now().setZone(settings.timezone).plus({days:offset}).toISODate()!;
    const availability=await json<DayAvailability>(`/api/day?date=${day}`);
    const candidate=availability.rooms[roomId]?.starts.find(slot=>{
      const hour=Number(slot.time.slice(0,2));
      return hour>=21 && hour<=22 && slot.ends.some(option=>option.minutes===30);
    });
    const ending=candidate?.ends.find(option=>option.minutes===30);
    if (candidate && ending) {start=candidate.value;end=ending.value;}
  }
  if (!start) throw new Error('No hi ha cap franja lliure de 30 minuts per a la prova');
  const [beforeStart,beforeEnd]=[Date.parse(start),Date.parse(end)];
  const before=await workspace.busy(room.email,start,end);
  if (before.some(interval=>beforeStart<Date.parse(interval.end) && Date.parse(interval.start)<beforeEnd))
    throw new Error('La franja ha passat a estar ocupada abans de la prova');
  console.log(JSON.stringify({stage:'selected',room:roomId,start,end}));
  result=await json<BookingResult>('/api/bookings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    room:roomId,start,end,name:'Prova tècnica',last_name:'SJMA',email:settings.organizer_email,
    instrument:'Prova tècnica',relation:'Altres',note:`${marker}. NO ÉS UNA RESERVA REAL. S'ELIMINARÀ EN ACABAR LA PROVA.`,
    privacy_accepted:true,
  })});
  id=result.id;
  for (let attempt=0;attempt<12 && result.state==='pending';attempt++) {
    await delay(5000);
    result=await json<BookingResult>(`/api/bookings/${id}`);
  }
  if (result.state!=='confirmed') throw new Error(`El recurs no ha confirmat la reserva: ${result.state}`);
  const event=await workspace.get(id);
  if (resourceResponse(event,room.email)!=='accepted') throw new Error('El recurs no figura com a acceptat en Workspace');
  const occupied=await workspace.busy(room.email,start,end);
  if (!occupied.some(interval=>beforeStart<Date.parse(interval.end) && Date.parse(interval.start)<beforeEnd))
    throw new Error('La reserva confirmada no figura com a ocupada en FreeBusy');
  if (result.notifications?.requester!=='sent' || result.notifications?.secretariat!=='sent')
    throw new Error(`Gmail no ha acceptat els dos avisos: ${JSON.stringify(result.notifications)}`);
  const {data:row,error}=await client.from('sjma_reservas_bookings')
    .select('state,requester_mail_state,secretariat_mail_state').eq('id',id).single();
  if (error || row.state!=='confirmed' || row.requester_mail_state!=='sent' || row.secretariat_mail_state!=='sent')
    throw new Error('Supabase no reflecteix la confirmació i els dos enviaments');
  console.log(JSON.stringify({stage:'verified',reference:id,workspaceAccepted:true,freeBusyOccupied:true,
    requesterMail:'sent',secretariatMail:'sent',database:'confirmed'}));
} catch(error) {failure=error;}
finally {
  const {data:rows,error:lookupError}=await client.from('sjma_reservas_bookings')
    .select('id').eq('note',`${marker}. NO ÉS UNA RESERVA REAL. S'ELIMINARÀ EN ACABAR LA PROVA.`);
  if (lookupError) throw lookupError;
  for (const row of rows ?? []) {
    try {
      await workspace.delete(row.id);
    } catch(error) {
      if (!(error instanceof GoogleError && error.status===404)) throw error;
    }
    const {data:deleted,error}=await client.from('sjma_reservas_bookings').delete().eq('id',row.id).select('id');
    if (error || deleted?.length!==1) throw error ?? new Error('No s’ha eliminat la reserva de prova de Supabase');
    cleaned=true;
  }
  if (cleaned && start && end) {
    for (let attempt=0;attempt<8;attempt++) {
      const busy=await workspace.busy(room.email,start,end);
      released=!busy.some(interval=>Date.parse(start)<Date.parse(interval.end) && Date.parse(interval.start)<Date.parse(end));
      if (released) break;
      await delay(5000);
    }
    // Secretaria receives an explicit closure for the earlier automatic test notice.
    const subject='PROVA TÈCNICA SJMA · reserva eliminada';
    const body=`La reserva de prova ${id} (${room.name}, ${start}–${end}) s'ha eliminat del calendari i de la base de dades. Ignoreu l'avís automàtic anterior.\n`;
    await workspace.sendMail(settings.notification_email || 'secretaria@sjmalbal.com',subject,body,settings.organizer_email);
    cleanupMailSent=true;
  }
  console.log(JSON.stringify({stage:'cleanup',cleaned,released,cleanupMailSent}));
}
if (failure) throw failure;
if (!cleaned || !released || !cleanupMailSent) throw new Error('La neteja de la prova no s’ha completat');
