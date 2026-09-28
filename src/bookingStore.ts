import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Paths } from './config.js';
import type { BookingRow, BookingState, MailState } from './booking.js';
import type { BusyInterval } from './workspace.js';
import type { ServerSupabase } from './supabaseClient.js';

type MailColumn = 'requester_mail_state' | 'secretariat_mail_state';
export interface BookingStore {
  busy(email: string, start: string, end: string): Promise<BusyInterval[]>;
  insert(row: BookingRow): Promise<void>;
  setState(id: string, state: BookingState): Promise<void>;
  get(id: string): Promise<BookingRow | undefined>;
  resetFailed(id: string): Promise<void>;
  claimNotification(id: string, column: MailColumn): Promise<boolean>;
  setMailState(id: string, column: MailColumn, state: MailState): Promise<void>;
  close(): void;
}

export class SqliteBookingStore implements BookingStore {
  readonly db: Database.Database;
  constructor(paths: Paths) {
    mkdirSync(dirname(paths.db), {recursive:true,mode:0o700});
    this.db = new Database(paths.db,{timeout:30_000});
    this.db.pragma('busy_timeout = 30000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, room_email TEXT NOT NULL,
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
      requester_name TEXT NOT NULL, requester_email TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'declined', 'failed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const columns = new Set((this.db.pragma('table_info(bookings)') as Array<{name:string}>).map(row=>row.name));
    for (const column of ['requester_last_name','instrument','relation','note','room_name'])
      if (!columns.has(column)) this.db.exec(`ALTER TABLE bookings ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    for (const column of ['requester_mail_state','secretariat_mail_state'])
      if (!columns.has(column)) this.db.exec(`ALTER TABLE bookings ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'unsent'`);
  }
  close(): void { this.db.close(); }
  async busy(email: string, start: string, end: string): Promise<BusyInterval[]> {
    return this.db.prepare(`SELECT starts_at AS start, ends_at AS end FROM bookings
      WHERE room_email = ? AND state IN ('pending','confirmed')
      AND julianday(starts_at) < julianday(?) AND julianday(ends_at) > julianday(?)`)
      .all(email,end,start) as BusyInterval[];
  }
  async insert(row: BookingRow): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conflict = this.db.prepare(`SELECT id FROM bookings WHERE room_email=? AND state IN ('pending','confirmed')
        AND julianday(starts_at)<julianday(?) AND julianday(ends_at)>julianday(?) LIMIT 1`)
        .get(row.room_email,row.ends_at,row.starts_at);
      if (conflict) throw new RangeError('Ese turno ya está reservado');
      this.db.prepare(`INSERT INTO bookings
        (id,room_email,starts_at,ends_at,requester_name,requester_email,state,created_at,updated_at,
         requester_last_name,instrument,relation,note,room_name,requester_mail_state,secretariat_mail_state)
        VALUES (@id,@room_email,@starts_at,@ends_at,@requester_name,@requester_email,@state,@created_at,@updated_at,
         @requester_last_name,@instrument,@relation,@note,@room_name,@requester_mail_state,@secretariat_mail_state)`).run(row);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async setState(id: string, state: BookingState): Promise<void> {
    this.db.prepare("UPDATE bookings SET state=?,updated_at=? WHERE id=? AND state='pending'")
      .run(state,new Date().toISOString(),id);
  }
  async get(id: string): Promise<BookingRow | undefined> {
    return this.db.prepare('SELECT * FROM bookings WHERE id=?').get(id) as BookingRow | undefined;
  }
  async resetFailed(id: string): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT state,requester_mail_state,secretariat_mail_state FROM bookings WHERE id=?')
        .get(id) as Pick<BookingRow,'state'|MailColumn> | undefined;
      if (!row || row.state !== 'confirmed') throw new RangeError('La reserva no existeix o no està confirmada');
      const columns = (['requester_mail_state','secretariat_mail_state'] as const).filter(column=>row[column]==='failed');
      if (!columns.length) throw new RangeError('No hi ha avisos amb un error definitiu');
      for (const column of columns) this.db.prepare(`UPDATE bookings SET ${column}='unsent' WHERE id=?`).run(id);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async claimNotification(id: string, column: MailColumn): Promise<boolean> {
    return this.db.prepare(`UPDATE bookings SET ${column}='sending'
      WHERE id=? AND state='confirmed' AND ${column}='unsent'`).run(id).changes===1;
  }
  async setMailState(id: string,column:MailColumn,state:MailState):Promise<void> {
    this.db.prepare(`UPDATE bookings SET ${column}=? WHERE id=? AND ${column}='sending'`).run(state,id);
  }
}

export class SupabaseBookingStore implements BookingStore {
  constructor(private client: ServerSupabase) {}
  close(): void {}
  async busy(email: string, start: string, end: string): Promise<BusyInterval[]> {
    const {data,error}=await this.client.from('sjma_reservas_bookings').select('starts_at,ends_at')
      .eq('room_email',email).in('state',['pending','confirmed']).lt('starts_at',end).gt('ends_at',start);
    if (error) throw error;
    return (data ?? []).map(row=>({start:row.starts_at as string,end:row.ends_at as string}));
  }
  async insert(row: BookingRow): Promise<void> {
    const {error}=await this.client.from('sjma_reservas_bookings').insert(row);
    if (error?.code==='23P01') throw new RangeError('Ese turno ya está reservado');
    if (error) throw error;
  }
  async setState(id:string,state:BookingState):Promise<void> {
    const {error}=await this.client.from('sjma_reservas_bookings')
      .update({state,updated_at:new Date().toISOString()}).eq('id',id).eq('state','pending');
    if (error) throw error;
  }
  async get(id:string):Promise<BookingRow|undefined> {
    const {data,error}=await this.client.from('sjma_reservas_bookings').select('*').eq('id',id).maybeSingle();
    if (error) throw error;
    return data as BookingRow | undefined ?? undefined;
  }
  async resetFailed(id:string):Promise<void> {
    const row=await this.get(id);
    if (!row || row.state!=='confirmed') throw new RangeError('La reserva no existeix o no està confirmada');
    const columns=(['requester_mail_state','secretariat_mail_state'] as const).filter(column=>row[column]==='failed');
    if (!columns.length) throw new RangeError('No hi ha avisos amb un error definitiu');
    for (const column of columns) {
      const {error}=await this.client.from('sjma_reservas_bookings').update({[column]:'unsent'})
        .eq('id',id).eq('state','confirmed').eq(column,'failed');
      if (error) throw error;
    }
  }
  async claimNotification(id:string,column:MailColumn):Promise<boolean> {
    const {data,error}=await this.client.from('sjma_reservas_bookings').update({[column]:'sending'})
      .eq('id',id).eq('state','confirmed').eq(column,'unsent').select('id');
    if (error) throw error;
    return data?.length===1;
  }
  async setMailState(id:string,column:MailColumn,state:MailState):Promise<void> {
    const {error}=await this.client.from('sjma_reservas_bookings').update({[column]:state})
      .eq('id',id).eq(column,'sending');
    if (error) throw error;
  }
}
