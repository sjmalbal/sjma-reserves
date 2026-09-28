/** Manual retry of definitively failed mail notifications. Unknown outcomes are never retried. */
import { BookingService } from './booking.js';
import { pathsFor, readSettings } from './config.js';
import { Workspace } from './workspace.js';
import { supabaseServerClient } from './supabaseClient.js';
import { SupabaseBookingStore } from './bookingStore.js';

const id = process.argv[process.argv.indexOf('--booking-id') + 1];
if (!process.argv.includes('--retry-failed') || !id || !/^[a-f0-9]{32}$/.test(id)) {
  console.error('Ús: npm run retry-mail -- --booking-id REFERÈNCIA --retry-failed');
  process.exitCode = 2;
} else {
  const paths = pathsFor(), settings = readSettings(paths);
  const store=process.env.SJMA_DATA_BACKEND==='sqlite' ? undefined : new SupabaseBookingStore(supabaseServerClient(paths));
  const service = new BookingService(paths, settings, new Workspace(paths, settings),undefined,store);
  try { console.log(await service.retryFailedNotifications(id)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally { service.close(); }
}
