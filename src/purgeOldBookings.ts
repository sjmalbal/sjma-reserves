import { DateTime } from 'luxon';
import { pathsFor } from './config.js';
import { supabaseServerClient } from './supabaseClient.js';
import { bookingRetentionCutoff } from './retention.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) {
  console.error('Ús: node dist/purgeOldBookings.js [--apply]');
  process.exitCode = 2;
} else {
  try {
    const client = supabaseServerClient(pathsFor());
    const cutoff = bookingRetentionCutoff(DateTime.now());
    const {count,error} = await client.from('sjma_reservas_bookings')
      .select('id',{head:true,count:'exact'}).lt('ends_at',cutoff);
    if (error) throw error;
    console.log(`Reserves finalitzades abans de ${cutoff}: ${count ?? 0}`);

    if (args[0] === '--apply') {
      let deleted = 0;
      while (true) {
        const {data:rows,error:readError} = await client.from('sjma_reservas_bookings')
          .select('id').lt('ends_at',cutoff).order('ends_at').limit(500);
        if (readError) throw readError;
        if (!rows?.length) break;
        const ids = rows.map(row => row.id);
        const {data:removed,error:deleteError} = await client.from('sjma_reservas_bookings')
          .delete().in('id',ids).lt('ends_at',cutoff).select('id');
        if (deleteError) throw deleteError;
        if (!removed?.length) throw new Error('No s’ha pogut eliminar cap registre del lot');
        deleted += removed.length;
      }
      console.log(`Registres eliminats: ${deleted}`);
    } else {
      console.log('Simulació: cap registre eliminat. Per a executar: --apply');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
