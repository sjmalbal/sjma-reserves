import { DateTime } from 'luxon';

/** A completed booking expires one calendar year after it ended in Madrid. */
export function bookingRetentionCutoff(now: DateTime): string {
  if (!now.isValid) throw new RangeError('Invalid retention clock');
  return now.setZone('Europe/Madrid').minus({years: 1}).toUTC().toISO()!;
}
