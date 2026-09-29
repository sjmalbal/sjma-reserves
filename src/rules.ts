import type { OpeningHours } from './config.js';

export interface RoomBookingRules {
  weekly_hours?: Record<string, OpeningHours | {closed:true}>;
  max_minutes?: number;
  min_notice_hours?: number;
  buffer_minutes?: number;
}

const CLOCK=/^([01]\d|2[0-3]):[0-5]\d$/;

export function validateRoomRules(value: RoomBookingRules): RoomBookingRules {
  const rules:RoomBookingRules={};
  if (value.max_minutes !== undefined) {
    if (!Number.isInteger(value.max_minutes) || value.max_minutes < 30 || value.max_minutes > 720)
      throw new RangeError('La duració màxima ha de ser entre 30 minuts i 12 hores');
    rules.max_minutes=value.max_minutes;
  }
  if (value.min_notice_hours !== undefined) {
    if (!Number.isInteger(value.min_notice_hours) || value.min_notice_hours < 0 || value.min_notice_hours > 720)
      throw new RangeError('L’antelació mínima ha de ser entre 0 i 720 hores');
    rules.min_notice_hours=value.min_notice_hours;
  }
  if (value.buffer_minutes !== undefined) {
    if (!Number.isInteger(value.buffer_minutes) || value.buffer_minutes < 0 || value.buffer_minutes > 120
      || value.buffer_minutes % 5 !== 0)
      throw new RangeError('El temps entre reserves ha de ser un múltiple de 5 entre 0 i 120 minuts');
    rules.buffer_minutes=value.buffer_minutes;
  }
  if (value.weekly_hours) {
    const hours:NonNullable<RoomBookingRules['weekly_hours']>={};
    for (const [day,entry] of Object.entries(value.weekly_hours)) {
      if (!/^[1-7]$/.test(day)) throw new RangeError('Dia de la setmana no vàlid');
      if ('closed' in entry) {
        if (entry.closed !== true) throw new RangeError('Horari de l’aula no vàlid');
        hours[day]={closed:true};
      } else {
        if (!CLOCK.test(entry.opening) || !CLOCK.test(entry.closing) || entry.opening===entry.closing)
          throw new RangeError('Horari de l’aula no vàlid');
        hours[day]={opening:entry.opening,closing:entry.closing};
      }
    }
    if (Object.keys(hours).length) rules.weekly_hours=hours;
  }
  return rules;
}
