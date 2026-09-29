import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BookingRow } from './booking.js';
import type { Paths } from './config.js';
import type { ServerSupabase } from './supabaseClient.js';

export interface BlockRow {
  id:string; group_id:string; room_email:string; starts_at:string; ends_at:string;
  label:string; kind:'block'|'holiday'; created_by:string; created_at:string; cancelled_at:string|null;
}
export interface AuditRow {
  id:string; actor_email:string; action:string; target_id:string;
  details:Record<string,unknown>; created_at:string;
}
export interface AdminStore {
  listBookings(start:string,end:string):Promise<BookingRow[]>;
  getBooking(id:string):Promise<BookingRow|undefined>;
  cancelBooking(id:string):Promise<boolean>;
  moveBooking(id:string,roomEmail:string,roomName:string,start:string,end:string):Promise<boolean>;
  listBlocks(start:string,end:string):Promise<BlockRow[]>;
  blocksByGroup(group:string):Promise<BlockRow[]>;
  insertBlock(row:BlockRow):Promise<void>;
  cancelBlock(id:string):Promise<boolean>;
  audit(actor:string,action:string,target:string,details?:Record<string,unknown>):Promise<void>;
  listAudit(limit:number):Promise<AuditRow[]>;
  close():void;
}

export class SqliteAdminStore implements AdminStore {
  private db:Database.Database;
  constructor(paths:Paths) {
    this.db=new Database(paths.db,{timeout:30_000});
    this.db.pragma('busy_timeout = 30000');
    const cols=new Set((this.db.pragma('table_info(bookings)') as Array<{name:string}>).map(row=>row.name));
    if (!cols.has('source')) this.db.exec("ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'public'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, room_email TEXT NOT NULL,
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, label TEXT NOT NULL,
      kind TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      cancelled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_audit (
      id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, action TEXT NOT NULL,
      target_id TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
  }
  close():void { this.db.close(); }
  async listBookings(start:string,end:string):Promise<BookingRow[]> {
    return this.db.prepare('SELECT * FROM bookings WHERE julianday(starts_at) < julianday(?) AND julianday(ends_at) > julianday(?) ORDER BY starts_at')
      .all(end,start) as BookingRow[];
  }
  async getBooking(id:string):Promise<BookingRow|undefined> {
    return this.db.prepare('SELECT * FROM bookings WHERE id=?').get(id) as BookingRow|undefined;
  }
  async cancelBooking(id:string):Promise<boolean> {
    return this.db.prepare("UPDATE bookings SET state='cancelled',updated_at=? WHERE id=? AND state IN ('pending','confirmed')")
      .run(new Date().toISOString(),id).changes===1;
  }
  async moveBooking(id:string,roomEmail:string,roomName:string,start:string,end:string):Promise<boolean> {
    try {
      return this.db.prepare(`UPDATE bookings SET room_email=?,room_name=?,starts_at=?,ends_at=?,updated_at=?
        WHERE id=? AND state='confirmed'`).run(roomEmail,roomName,start,end,new Date().toISOString(),id).changes===1;
    } catch (error) {
      if (error instanceof Error && /constraint|overlap/i.test(error.message)) throw new RangeError('La nova franja ja està ocupada');
      throw error;
    }
  }
  async listBlocks(start:string,end:string):Promise<BlockRow[]> {
    return this.db.prepare('SELECT * FROM blocks WHERE cancelled_at IS NULL AND julianday(starts_at) < julianday(?) AND julianday(ends_at) > julianday(?) ORDER BY starts_at')
      .all(end,start) as BlockRow[];
  }
  async blocksByGroup(group:string):Promise<BlockRow[]> {
    return this.db.prepare('SELECT * FROM blocks WHERE group_id=? AND cancelled_at IS NULL ORDER BY starts_at')
      .all(group) as BlockRow[];
  }
  async insertBlock(row:BlockRow):Promise<void> {
    const busy=this.db.prepare(`SELECT id FROM blocks WHERE cancelled_at IS NULL AND room_email=?
      AND julianday(starts_at)<julianday(?) AND julianday(ends_at)>julianday(?) LIMIT 1`).get(row.room_email,row.ends_at,row.starts_at);
    if (busy) throw new RangeError('Ja hi ha un bloqueig en eixa franja');
    this.db.prepare(`INSERT INTO blocks
      (id,group_id,room_email,starts_at,ends_at,label,kind,created_by,created_at,cancelled_at)
      VALUES (@id,@group_id,@room_email,@starts_at,@ends_at,@label,@kind,@created_by,@created_at,@cancelled_at)`)
      .run(row);
  }
  async cancelBlock(id:string):Promise<boolean> {
    return this.db.prepare('UPDATE blocks SET cancelled_at=? WHERE id=? AND cancelled_at IS NULL')
      .run(new Date().toISOString(),id).changes===1;
  }
  async audit(actor:string,action:string,target:string,details:Record<string,unknown>={}):Promise<void> {
    this.db.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?,?)').run(
      randomBytes(16).toString('hex'),actor,action,target,JSON.stringify(details),new Date().toISOString());
  }
  async listAudit(limit:number):Promise<AuditRow[]> {
    const rows=this.db.prepare('SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Omit<AuditRow,'details'> & {details:string}>;
    return rows.map(row=>({...row,details:JSON.parse(row.details)}));
  }
}

export class SupabaseAdminStore implements AdminStore {
  constructor(private client:ServerSupabase) {}
  close():void {}
  async listBookings(start:string,end:string):Promise<BookingRow[]> {
    const {data,error}=await this.client.from('sjma_reservas_bookings').select('*')
      .lt('starts_at',end).gt('ends_at',start).order('starts_at').limit(1000);
    if (error) throw error;
    return data as BookingRow[] ?? [];
  }
  async getBooking(id:string):Promise<BookingRow|undefined> {
    const {data,error}=await this.client.from('sjma_reservas_bookings').select('*').eq('id',id).maybeSingle();
    if (error) throw error;
    return data as BookingRow|undefined ?? undefined;
  }
  async cancelBooking(id:string):Promise<boolean> {
    const {data,error}=await this.client.from('sjma_reservas_bookings')
      .update({state:'cancelled',updated_at:new Date().toISOString()})
      .eq('id',id).in('state',['pending','confirmed']).select('id');
    if (error) throw error;
    return data?.length===1;
  }
  async moveBooking(id:string,roomEmail:string,roomName:string,start:string,end:string):Promise<boolean> {
    const {data,error}=await this.client.from('sjma_reservas_bookings')
      .update({room_email:roomEmail,room_name:roomName,starts_at:start,ends_at:end,
        updated_at:new Date().toISOString()}).eq('id',id).eq('state','confirmed').select('id');
    if (error?.code==='23P01') throw new RangeError('La nova franja ja està ocupada');
    if (error) throw error;
    return data?.length===1;
  }
  async listBlocks(start:string,end:string):Promise<BlockRow[]> {
    const {data,error}=await this.client.from('sjma_reservas_blocks').select('*')
      .is('cancelled_at',null).lt('starts_at',end).gt('ends_at',start).order('starts_at').limit(1000);
    if (error) throw error;
    return data as BlockRow[] ?? [];
  }
  async blocksByGroup(group:string):Promise<BlockRow[]> {
    const {data,error}=await this.client.from('sjma_reservas_blocks').select('*')
      .eq('group_id',group).is('cancelled_at',null).order('starts_at').limit(1000);
    if (error) throw error;
    return data as BlockRow[] ?? [];
  }
  async insertBlock(row:BlockRow):Promise<void> {
    const {error}=await this.client.from('sjma_reservas_blocks').insert(row);
    if (error?.code==='23P01') throw new RangeError('Ja hi ha un bloqueig en eixa franja');
    if (error) throw error;
  }
  async cancelBlock(id:string):Promise<boolean> {
    const {data,error}=await this.client.from('sjma_reservas_blocks')
      .update({cancelled_at:new Date().toISOString()}).eq('id',id).is('cancelled_at',null).select('id');
    if (error) throw error;
    return data?.length===1;
  }
  async audit(actor:string,action:string,target:string,details:Record<string,unknown>={}):Promise<void> {
    const {error}=await this.client.from('sjma_reservas_audit').insert({
      id:randomBytes(16).toString('hex'),actor_email:actor,action,target_id:target,details,
    });
    if (error) throw error;
  }
  async listAudit(limit:number):Promise<AuditRow[]> {
    const {data,error}=await this.client.from('sjma_reservas_audit').select('*')
      .order('created_at',{ascending:false}).limit(limit);
    if (error) throw error;
    return data as AuditRow[] ?? [];
  }
}
