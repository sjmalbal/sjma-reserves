/** One-time guarded import of the current local reservation data into new Supabase tables. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pathsFor, readJson, readSettings } from './config.js';
import type { BookingRow } from './booking.js';
import { supabaseServerClient } from './supabaseClient.js';
import { PHOTO_BUCKET } from './supabaseCatalogue.js';
import { Workspace } from './workspace.js';

const apply=process.argv.includes('--apply');
const paths=pathsFor();
const settings=readSettings(paths);
const client=supabaseServerClient(paths);
const base=readJson<Record<string,{title?:string;features?:string[];photos?:string[];address?:string}>>(paths.catalogue,{});
const overrides=readJson<typeof base>(paths.overrides,{});
const sqlite=new Database(paths.db,{readonly:true,fileMustExist:true});
const bookings=sqlite.prepare('select * from bookings order by id').all() as BookingRow[];
sqlite.close();

const workspace=new Workspace(paths,settings);
const resources=await workspace.listResources();
const emails=new Set(resources.map(resource=>resource.resourceEmail.toLowerCase()));
const missing=settings.rooms.filter(room=>!emails.has(room.email.toLowerCase()));
if (missing.length) throw new Error(`${missing.length} aules locals ja no existeixen a Google Workspace`);

const roomInputs=settings.rooms.map(room=>{
  const metadata={...base[room.id],...overrides[room.id]};
  return {resource_email:room.email.toLowerCase(),room_id:room.id,published:true,
    title:metadata.title || room.name,features:metadata.features ?? [],
    photos:metadata.photos ?? [],address:metadata.address ?? null};
});
if (new Set(roomInputs.map(room=>room.resource_email)).size!==roomInputs.length) throw new Error('Hi ha correus de recurs duplicats');
const photoSources=new Set(roomInputs.flatMap(room=>room.photos));
for (const photo of photoSources) {
  if (!photo.startsWith('/static/rooms/') && !photo.startsWith('/room-photos/'))
    throw new Error(`Origen de foto inesperat: ${photo}`);
  const file=photo.startsWith('/static/rooms/')
    ? join(paths.assets,'static','rooms',photo.split('/').at(-1)!)
    : join(paths.photos,photo.split('/').at(-1)!);
  if (!existsSync(file)) throw new Error(`Falta una fotografia local: ${photo}`);
}
const {count:remoteRooms,error:roomsError}=await client.from('sjma_reservas_rooms').select('*',{head:true,count:'exact'});
const {count:remoteBookings,error:bookingsError}=await client.from('sjma_reservas_bookings').select('*',{head:true,count:'exact'});
if (roomsError || bookingsError) throw roomsError ?? bookingsError;
if (remoteRooms || remoteBookings) throw new Error('Les taules de destí ja tenen dades; revisa-les abans de repetir la importació');
console.log(JSON.stringify({localRooms:roomInputs.length,localBookings:bookings.length,photos:photoSources.size,
  destinationRooms:remoteRooms,destinationBookings:remoteBookings,mode:apply?'apply':'dry-run'}));
if (!apply) process.exit(0);

const {data:existingBucket,error:bucketReadError}=await client.storage.getBucket(PHOTO_BUCKET);
if (!existingBucket) {
  if (bucketReadError && String(bucketReadError.message).toLowerCase().includes('not authorized')) throw bucketReadError;
  const {error}=await client.storage.createBucket(PHOTO_BUCKET,
    {public:true,allowedMimeTypes:['image/jpeg'],fileSizeLimit:'5MB'});
  if (error) throw error;
} else if (!existingBucket.public) throw new Error('El bucket de fotos existeix però no és públic');

const photoUrls=new Map<string,string>();
for (const photo of photoSources) {
  const file=photo.startsWith('/static/rooms/')
    ? join(paths.assets,'static','rooms',photo.split('/').at(-1)!)
    : join(paths.photos,photo.split('/').at(-1)!);
  const bytes=readFileSync(file);
  const digest=createHash('sha256').update(bytes).digest('hex');
  const storagePath=`initial/${digest}.jpg`;
  const {error}=await client.storage.from(PHOTO_BUCKET).upload(storagePath,bytes,
    {contentType:'image/jpeg',cacheControl:'3600',upsert:false});
  if (error && !String(error.message).toLowerCase().includes('already exists')) throw error;
  photoUrls.set(photo,client.storage.from(PHOTO_BUCKET).getPublicUrl(storagePath).data.publicUrl);
}

const rows=roomInputs.map(room=>({...room,photos:room.photos.map(photo=>photoUrls.get(photo)!)}));
const {error:roomWriteError}=await client.from('sjma_reservas_rooms').insert(rows);
if (roomWriteError) throw roomWriteError;
if (bookings.length) {
  const {error:bookingWriteError}=await client.from('sjma_reservas_bookings').insert(bookings);
  if (bookingWriteError) throw bookingWriteError;
}
const {data:importedRooms,error:verifyRoomsError}=await client.from('sjma_reservas_rooms')
  .select('resource_email,room_id,published,title,features,photos,address');
const {data:importedBookings,error:verifyBookingsError}=await client.from('sjma_reservas_bookings').select('id');
if (verifyRoomsError || verifyBookingsError) throw verifyRoomsError ?? verifyBookingsError;
if (importedRooms?.length!==roomInputs.length || importedBookings?.length!==bookings.length
  || importedRooms.some(row=>{
    const source=roomInputs.find(input=>input.resource_email===row.resource_email);
    return !source || source.room_id!==row.room_id || source.title!==row.title
      || row.photos.length!==source.photos.length || !row.published;
  })) throw new Error('La verificació després de la importació ha fallat');
console.log(JSON.stringify({verifiedRooms:importedRooms.length,verifiedBookings:importedBookings.length,
  verifiedPhotos:importedRooms.reduce((total,row)=>total+row.photos.length,0)}));
