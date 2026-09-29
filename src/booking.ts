import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Paths, Room, Settings } from './config.js';
import { SqliteBookingStore } from './bookingStore.js';
import type { BookingStore } from './bookingStore.js';
import { GoogleError, resourceResponse } from './workspace.js';
import type { BusyInterval, GoogleEvent, WorkspaceApi } from './workspace.js';

export type BookingState = 'pending' | 'confirmed' | 'declined' | 'failed';
export type MailState = 'unsent' | 'sending' | 'sent' | 'failed' | 'unknown';
export interface BookingResult {
  id: string;
  state: BookingState;
  notifications?: { requester: MailState; secretariat: MailState };
}
export interface ReserveInput {
  room: string; start: string; end?: string;
  name: string; last_name?: string; email: string;
  instrument?: string; relation?: string; note?: string;
}
export interface BookingRow {
  id: string; room_email: string; starts_at: string; ends_at: string;
  requester_name: string; requester_last_name: string; requester_email: string;
  instrument: string; relation: string; note: string; room_name: string;
  state: BookingState; created_at: string; updated_at: string;
  requester_mail_state: MailState; secretariat_mail_state: MailState;
}
export interface DayStart { value: string; label: string; time: string; ends: Array<{value: string; label: string; time: string; minutes: number}> }
export interface DayAvailability {
  date: string;
  rooms: Record<string, {busy: BusyInterval[]; starts: DayStart[]}>;
  opening_hour: number; closing_hour: number;
  opening_at: string; closing_at: string;
  step_minutes: number; min_minutes: number; max_minutes: number;
}

function iso(value: DateTime): string { return value.toISO({ suppressMilliseconds: true })!; }
function utc(value: DateTime): string { return value.toUTC().toISO({ suppressMilliseconds: true })!.replace('Z', '+00:00'); }
function minutes(value: DateTime): number { return value.toMillis(); }
function dateOnly(value: DateTime): string { return value.toISODate()!; }
function fmt(value: DateTime, format: string): string { return value.toFormat(format); }
function timeLabel(value: DateTime): string {
  const time = fmt(value, 'HH:mm');
  if (value.getPossibleOffsets().length < 2) return time;
  const hours = value.offset / 60;
  return `${time} (UTC${hours >= 0 ? '+' : ''}${hours})`;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRETARIAT = 'secretaria@sjmalbal.com';

export class BookingService {
  private store: BookingStore;
  constructor(private paths: Paths, readonly settings: Settings, private workspace: WorkspaceApi,
              private clock: () => DateTime = () => DateTime.now(), store?: BookingStore) {
    this.store = store ?? new SqliteBookingStore(paths);
  }

  close(): void { this.store.close(); }
  private now(): DateTime { return this.clock().setZone(this.settings.timezone); }
  private room(id: string): Room | undefined { return this.settings.rooms.find(room => room.id === id); }
  private parseTime(value: string): DateTime {
    if (!value || typeof value !== 'string') throw new RangeError('Fecha u hora no válida');
    const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    const parsed = DateTime.fromISO(value, zoned ? { setZone: true } : { zone: this.settings.timezone });
    if (!parsed.isValid) throw new RangeError('Fecha u hora no válida');
    return parsed.setZone(this.settings.timezone);
  }

  private parseDay(day: string): DateTime {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError('Data no vàlida');
    const parsed = DateTime.fromISO(day, { zone: this.settings.timezone });
    if (!parsed.isValid || dateOnly(parsed) !== day) throw new RangeError('Data no vàlida');
    const now = this.now();
    if (day < dateOnly(now) || day > dateOnly(now.plus({ days: this.settings.max_days_ahead }))) {
      throw new RangeError('La data està fora del termini de reserva');
    }
    return parsed;
  }

  private dayBounds(day: DateTime): [DateTime, DateTime] {
    const midnight = day.startOf('day');
    const hours = this.settings.weekly_hours?.[String(day.weekday)];
    const parse = (value: string): number => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Horari setmanal no vàlid');
      const [hour, minute] = value.split(':').map(Number);
      return hour * 60 + minute;
    };
    const openMinutes = hours ? parse(hours.opening) : this.settings.opening_hour * 60;
    const closeMinutes = hours ? parse(hours.closing) : this.settings.closing_hour * 60;
    const at = (date: DateTime, value: number): DateTime => date.set({hour:Math.floor(value / 60),minute:value % 60});
    const opening = at(midnight, openMinutes);
    const closing = closeMinutes === 1440 || closeMinutes <= openMinutes
      ? at(midnight.plus({days:1}), closeMinutes % 1440)
      : at(midnight, closeMinutes);
    return [opening, closing];
  }

  private parseRange(startText: string, endText?: string): [DateTime, DateTime] {
    const start = this.parseTime(startText);
    const step = this.settings.slot_step_minutes ?? this.settings.slot_minutes;
    const today = this.dayBounds(start);
    const yesterday = this.dayBounds(start.minus({days:1}));
    const [opening, closing] = [today, yesterday].find(([open, close]) =>
      minutes(start) >= minutes(open) && minutes(start) < minutes(close)) ?? today;
    const sinceOpen = (minutes(start) - minutes(opening)) / 60_000;
    if (sinceOpen < 0 || sinceOpen % step !== 0 || start.second || start.millisecond)
      throw new RangeError('L’hora no coincidix amb els torns disponibles');
    const now = this.now();
    if (minutes(start) <= minutes(now)
      || dateOnly(opening) > dateOnly(now.plus({ days: this.settings.max_days_ahead }))) {
      throw new RangeError('La fecha está fuera del plazo de reserva');
    }
    const end = endText ? this.parseTime(endText) : start.plus({ minutes: this.settings.slot_minutes });
    const duration = (minutes(end) - minutes(start)) / 60_000;
    if (duration < (this.settings.min_minutes ?? this.settings.slot_minutes)
      || duration > (this.settings.max_minutes ?? this.settings.slot_minutes)
      || duration % step !== 0) throw new RangeError('La duració no està permesa');
    if (minutes(start) < minutes(opening) || minutes(end) > minutes(closing)) {
      throw new RangeError('Fora de l’horari de reserva');
    }
    return [start, end];
  }

  private overlaps(start: DateTime, end: DateTime, busy: BusyInterval[]): boolean {
    return busy.some(interval => minutes(start) < Date.parse(interval.end)
      && Date.parse(interval.start) < minutes(end));
  }

  private async localBusy(email: string, start: DateTime, end: DateTime): Promise<BusyInterval[]> {
    return this.store.busy(email,utc(start),utc(end));
  }

  private async setState(id: string, state: BookingState): Promise<void> {
    await this.store.setState(id,state);
  }

  async reserve(input: ReserveInput): Promise<BookingResult> {
    const room = this.room(input.room);
    if (!room) throw new RangeError('Aula no disponible');
    const [start, end] = this.parseRange(input.start, input.end);
    const name = (input.name ?? '').trim();
    const email = (input.email ?? '').trim();
    const lastName = (input.last_name ?? '').trim();
    const instrument = (input.instrument ?? '').trim();
    const relation = (input.relation ?? '').trim();
    const note = (input.note ?? '').trim();
    if (name.length < 2 || name.length > 100 || !EMAIL.test(email) || email.length > 254) {
      throw new RangeError('Indica un nombre y un correo válidos');
    }
    if (lastName.length > 100 || instrument.length > 100 || relation.length > 100 || note.length > 1000) {
      throw new RangeError('Les dades del formulari són massa llargues');
    }

    // Google remains the source for external occupancy. The store also enforces
    // local overlap atomically when it inserts the pending reservation.
    if (this.overlaps(start, end, await this.workspace.busy(room.email, iso(start), iso(end)))) {
      throw new RangeError('Ese turno está ocupado en Google Workspace');
    }
    const id = randomBytes(16).toString('hex');
    const stamp = new Date().toISOString();
    await this.store.insert({
      id, room_email:room.email.toLowerCase(), starts_at:utc(start), ends_at:utc(end),
      requester_name:name, requester_last_name:lastName, requester_email:email,
      instrument,relation,note,room_name:room.name,state:'pending',
      created_at:stamp,updated_at:stamp,requester_mail_state:'unsent',secretariat_mail_state:'unsent',
    });

    let event: GoogleEvent;
    try {
      event = await this.workspace.insert(id, room.email, iso(start), iso(end));
    } catch (error) {
      if (error instanceof GoogleError && error.status === 409) return this.refresh(id);
      if (error instanceof GoogleError && [400, 401, 403, 404].includes(error.status)) {
        await this.setState(id, 'failed');
        return { id, state: 'failed' };
      }
      return { id, state: 'pending' };
    }
    return this.updateFromEvent(id, event);
  }

  private async updateFromEvent(id: string, event: GoogleEvent): Promise<BookingResult> {
    const row = await this.store.get(id);
    if (!row) throw new RangeError('Reserva no encontrada');
    let state = row.state;
    if (state === 'pending') {
      const response = resourceResponse(event, row.room_email);
      if (response === 'declined') state = 'declined';
      else if (response === 'accepted') {
        const start = DateTime.fromISO(row.starts_at), end = DateTime.fromISO(row.ends_at);
        state = this.overlaps(start, end, await this.workspace.busy(row.room_email, iso(start), iso(end)))
          ? 'confirmed' : 'pending';
      }
      if (state !== 'pending') await this.setState(id, state);
    }
    return this.resultWithNotifications(id, state);
  }

  async refresh(id: string): Promise<BookingResult> {
    const row = await this.store.get(id);
    if (!row) throw new RangeError('Reserva no encontrada');
    if (row.state !== 'pending') return this.resultWithNotifications(id, row.state);
    let event: GoogleEvent;
    try {
      event = await this.workspace.get(id);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 404
        && Date.now() - Date.parse(row.created_at) >= 120_000) {
        await this.setState(id, 'failed');
        return { id, state: 'failed' };
      }
      return { id, state: 'pending' };
    }
    return this.updateFromEvent(id, event);
  }

  async retryFailedNotifications(id: string): Promise<BookingResult> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new RangeError('Referència de reserva no vàlida');
    await this.store.resetFailed(id);
    return this.refresh(id);
  }

  private async notify(id: string): Promise<{requester: MailState; secretariat: MailState}> {
    const booking = await this.store.get(id);
    if (!booking || booking.state !== 'confirmed') return { requester: 'unsent', secretariat: 'unsent' };
    const start = DateTime.fromISO(booking.starts_at).setZone(this.settings.timezone);
    const end = DateTime.fromISO(booking.ends_at).setZone(this.settings.timezone);
    const when = `${fmt(start, 'dd/MM/yyyy')}, de ${fmt(start, 'HH:mm')} a ${fmt(end, 'HH:mm')} (hora local)`;
    const roomName = booking.room_name || this.settings.rooms.find(room => room.email === booking.room_email)?.name || 'Aula SJMA';
    const details = `Espai: ${roomName}\nData i hora: ${when}\nReferència: ${id}\nLloc: Casa de la Cultura d'Albal - 2n Pis, Carrer de Sant Carles 80, Albal.\n`;
    const person = [booking.requester_name, booking.requester_last_name].filter(Boolean).join(' ');
    const messages: Array<{column: 'requester_mail_state' | 'secretariat_mail_state'; to: string; subject: string; body: string}> = [
      {
        column: 'requester_mail_state', to: booking.requester_email,
        subject: `Reserva confirmada · ${roomName}`,
        body: `Hola, ${booking.requester_name}.\n\nLa teua reserva està confirmada.\n\n${details}\nPer a qualsevol consulta, escriu a ${SECRETARIAT}.\n\nSocietat Joventut Musical d'Albal\n`,
      },
      {
        column: 'secretariat_mail_state', to: this.settings.notification_email || SECRETARIAT,
        subject: `Nova reserva confirmada · ${roomName}`,
        body: `S'ha confirmat una reserva d'espai.\n\n${details}\nPersona: ${person}\nCorreu: ${booking.requester_email}\nInstrument: ${booking.instrument || 'No indicat'}\nVinculació: ${booking.relation || 'No indicada'}\nNota: ${booking.note || 'Cap'}\n`,
      },
    ];
    for (const message of messages) {
      if (!await this.store.claimNotification(id, message.column)) continue;
      let state: MailState;
      try {
        if (!this.settings.organizer_email) throw new Error('Falta organizer_email');
        await this.workspace.sendMail(message.to, message.subject, message.body, this.settings.organizer_email);
        state = 'sent';
      } catch (error) {
        state = error instanceof GoogleError && error.status >= 400 && error.status < 500 && error.status !== 429
          ? 'failed' : error instanceof Error && error.message === 'Falta organizer_email' ? 'failed' : 'unknown';
        console.error(`Booking notification ${state}: ${id}, ${message.column}`);
      }
      await this.store.setMailState(id,message.column,state);
    }
    const row = await this.store.get(id);
    if (!row) throw new RangeError('Reserva no encontrada');
    return { requester: row.requester_mail_state, secretariat: row.secretariat_mail_state };
  }

  private async resultWithNotifications(id: string, state: BookingState): Promise<BookingResult> {
    return state === 'confirmed' ? { id, state, notifications: await this.notify(id) } : { id, state };
  }

  async availability(roomId: string, day: string): Promise<Array<{start: string; label: string}>> {
    const room = this.room(roomId);
    if (!room) throw new RangeError('Aula no disponible');
    const date = this.parseDay(day), now = this.now();
    const [opening, closing] = this.dayBounds(date);
    const busy = await this.workspace.busy(room.email, iso(opening), iso(closing));
    const slots = [];
    const step = this.settings.slot_step_minutes ?? this.settings.slot_minutes;
    for (let current = opening; minutes(current.plus({minutes: this.settings.slot_minutes})) <= minutes(closing);
         current = current.plus({minutes: step})) {
      const end = current.plus({minutes: this.settings.slot_minutes});
      if (minutes(current) > minutes(now) && !this.overlaps(current, end, busy)
        && !(await this.localBusy(room.email, current, end)).length) {
        slots.push({ start: iso(current), label: `${timeLabel(current)}–${timeLabel(end)}` });
      }
    }
    return slots;
  }

  async dayAvailability(day: string): Promise<DayAvailability> {
    const date = this.parseDay(day), now = this.now();
    const [opening, closing] = this.dayBounds(date);
    const emails = this.settings.rooms.map(room => room.email);
    const googleBusy = await this.workspace.busyMany(emails, iso(opening), iso(closing));
    const step = this.settings.slot_step_minutes ?? 30;
    const minimum = this.settings.min_minutes ?? 30;
    const maximum = this.settings.max_minutes ?? 300;
    const output: DayAvailability['rooms'] = {};
    for (const room of this.settings.rooms) {
      const busy = [...googleBusy[room.email], ...await this.localBusy(room.email, opening, closing)];
      const starts: DayStart[] = [];
      for (let current = opening; minutes(current.plus({minutes: minimum})) <= minutes(closing);
           current = current.plus({minutes: step})) {
        if (minutes(current) <= minutes(now)) continue;
        const ends: DayStart['ends'] = [];
        for (let duration = minimum; duration <= maximum; duration += step) {
          const candidate = current.plus({minutes: duration});
          if (minutes(candidate) > minutes(closing) || this.overlaps(current, candidate, busy)) break;
          ends.push({ value: iso(candidate), label: timeLabel(candidate), time: fmt(candidate, 'HH:mm'), minutes: duration });
        }
        if (ends.length) starts.push({ value: iso(current), label: timeLabel(current), time: fmt(current, 'HH:mm'), ends });
      }
      output[room.id] = { busy, starts };
    }
    return {
      date: dateOnly(date), rooms: output,
      opening_hour: opening.hour + opening.minute / 60,
      closing_hour: closing.hour + closing.minute / 60,
      opening_at: iso(opening), closing_at: iso(closing), step_minutes: step,
      min_minutes: minimum, max_minutes: maximum,
    };
  }
}
