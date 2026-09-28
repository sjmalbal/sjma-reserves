/** Explicit, temporary end-to-end resource test. Creates and removes a real Google event. */
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DateTime } from 'luxon';
import { pathsFor, readSettings } from './config.js';
import { GoogleError, resourceResponse, Workspace } from './workspace.js';

async function main() {
  if (!process.argv.includes('--confirmar-prueba-real')) {
    throw new Error('Falta --confirmar-prueba-real: esta prova crea i elimina un esdeveniment real');
  }
  const roomFlag = process.argv.indexOf('--room');
  const roomId = roomFlag < 0 ? 'aula-2' : process.argv[roomFlag + 1];
  const paths = pathsFor(), settings = readSettings(paths);
  const room = settings.rooms.find(item => item.id === roomId);
  if (!room) throw new Error('El recurs no està publicat');
  const workspace = new Workspace(paths, settings);
  const now = DateTime.now().setZone(settings.timezone);
  let start: DateTime | undefined;
  for (let day = 1; day <= 7; day++) {
    const candidate = now.plus({ days: day }).set({hour:20,minute:0,second:0,millisecond:0});
    const end = candidate.plus({minutes:10});
    const busy = await workspace.busy(room.email, candidate.toISO()!, end.toISO()!);
    if (!busy.some(interval => candidate.toMillis() < Date.parse(interval.end)
      && Date.parse(interval.start) < end.toMillis())) { start = candidate; break; }
  }
  if (!start) throw new Error('No hi ha un interval lliure de 20:00 a 20:10 en els pròxims set dies');
  const end = start.plus({minutes:10});
  const id = randomBytes(16).toString('hex');
  console.log(`Recurs: ${room.name}; inici: ${start.toISO()}; referència: ${id}`);
  let accepted = false, occupied = false, released = false;
  try {
    await workspace.insert(id, room.email, start.toISO()!, end.toISO()!);
    for (let attempt = 0; attempt < 12; attempt++) {
      const event = await workspace.get(id);
      const response = resourceResponse(event, room.email);
      const busy = await workspace.busy(room.email, start.toISO()!, end.toISO()!);
      occupied = busy.some(interval => start!.toMillis() < Date.parse(interval.end)
        && Date.parse(interval.start) < end.toMillis());
      if (response === 'accepted' && occupied) { accepted = true; break; }
      if (response === 'declined') break;
      await delay(5000);
    }
    console.log(`Acceptat: ${accepted}; ocupació visible: ${occupied}`);
  } finally {
    try { await workspace.delete(id); console.log('Esdeveniment temporal eliminat.'); }
    catch (error) { if (!(error instanceof GoogleError && error.status === 404)) throw error; }
    for (let attempt = 0; attempt < 6; attempt++) {
      const busy = await workspace.busy(room.email, start.toISO()!, end.toISO()!);
      if (!busy.some(interval => start!.toMillis() < Date.parse(interval.end)
        && Date.parse(interval.start) < end.toMillis())) { released = true; break; }
      await delay(5000);
    }
    console.log(`Interval alliberat: ${released}`);
  }
  if (!accepted || !occupied || !released) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
