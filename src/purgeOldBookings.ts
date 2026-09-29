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
    for (const [table,column,label] of [
      ['sjma_reservas_bookings','ends_at','Reserves'],
      ['sjma_reservas_blocks','ends_at','Bloquejos'],
      ['sjma_reservas_audit','created_at','Accions administratives'],
    ] as const) {
      const {count,error} = await client.from(table)
        .select('id',{head:true,count:'exact'}).lt(column,cutoff);
      if (error) throw error;
      console.log(`${label} anteriors a ${cutoff}: ${count ?? 0}`);
      if (args[0] !== '--apply') continue;
      let deleted=0;
      while (true) {
        const {data:rows,error:readError}=await client.from(table)
          .select('id').lt(column,cutoff).order(column).limit(500);
        if (readError) throw readError;
        if (!rows?.length) break;
        const {data:removed,error:deleteError}=await client.from(table)
          .delete().in('id',rows.map(row=>row.id)).lt(column,cutoff).select('id');
        if (deleteError) throw deleteError;
        if (!removed?.length) throw new Error(`No s’ha pogut eliminar cap registre de ${table}`);
        deleted+=removed.length;
      }
      console.log(`${label} eliminats: ${deleted}`);
    }
    if (args[0] !== '--apply') console.log('Simulació: cap registre eliminat. Per a executar: --apply');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
