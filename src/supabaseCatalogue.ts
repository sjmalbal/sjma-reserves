import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Paths, PublicRoom, Settings } from './config.js';
import { readJson } from './config.js';
import { FEATURES, MAX_PHOTO_BYTES, MAX_PHOTOS, keyFor, validateSortOrder } from './catalogue.js';
import type { AdminRow, ResourceEdit } from './catalogue.js';
import type { WorkspaceApi } from './workspace.js';
import type { ServerSupabase } from './supabaseClient.js';

export const PHOTO_BUCKET = 'sjma-reserves-photos';
interface RoomRow {
  resource_email:string; room_id:string; title:string; published:boolean;
  features:string[]; photos:string[]; address:string|null; sort_order:number;
}
interface BaseMetadata { title?:string; features?:string[]; photos?:string[]; address?:string }

export class SupabaseCatalogue {
  private rooms: RoomRow[] = [];
  constructor(private paths:Paths,private settings:Settings,private workspace:WorkspaceApi,
              private client:ServerSupabase) {}

  async refresh():Promise<void> {
    const {data,error}=await this.client.from('sjma_reservas_rooms').select('*').order('room_id');
    if (error) throw error;
    this.rooms=(data ?? []) as RoomRow[];
    this.settings.rooms=this.publicRooms().map(room=>({id:room.id,name:room.title,email:room.email}));
  }
  publicRooms():PublicRoom[] {
    return this.rooms.filter(room=>room.published)
      .sort((a,b)=>a.sort_order-b.sort_order || a.room_id.localeCompare(b.room_id,'ca'))
      .map(room=>({
      id:room.room_id,name:room.title,email:room.resource_email,title:room.title,
      features:room.features,photos:room.photos,address:room.address ?? undefined,sortOrder:room.sort_order,
    }));
  }
  async adminRows():Promise<AdminRow[]> {
    await this.refresh();
    const resources=await this.workspace.listResources();
    const saved=new Map(this.rooms.map(room=>[room.resource_email.toLowerCase(),room]));
    const base=readJson<Record<string,BaseMetadata>>(this.paths.catalogue,{});
    return resources.filter(resource=>resource.resourceEmail).map(resource=>{
      const email=resource.resourceEmail;
      const room=saved.get(email.toLowerCase());
      const id=room?.room_id ?? `workspace-${keyFor(resource)}`;
      const metadata=base[id];
      return {
        key:keyFor(resource),room_id:id,workspace_name:resource.resourceName || email,email,
        published:room?.published ?? false,
        title:room?.title ?? metadata?.title ?? resource.resourceName ?? email,
        features:room?.features ?? metadata?.features ?? [],
        photos:room?.photos ?? metadata?.photos ?? [],
        sortOrder:room?.sort_order ?? 1000,
      };
    }).sort((a,b)=>Number(b.published)-Number(a.published) || a.sortOrder-b.sortOrder || a.workspace_name.localeCompare(b.workspace_name,'ca'));
  }
  async save(key:string,edit:ResourceEdit):Promise<void> {
    const row=(await this.adminRows()).find(item=>item.key===key);
    if (!row) throw new RangeError('Recurs no trobat a Workspace');
    const title=edit.title.trim();
    validateSortOrder(edit.sortOrder);
    if (!title || title.length>120 || /[\x00-\x1f]/.test(title)) throw new RangeError('Nom públic no vàlid');
    if (new Set(edit.features).size!==edit.features.length
      || edit.features.some(feature=>!FEATURES.includes(feature as typeof FEATURES[number])))
      throw new RangeError('Característiques no vàlides');
    if (edit.removePhotos.some(photo=>!row.photos.includes(photo))) throw new RangeError('Fotografies no vàlides');
    if (edit.uploads.length>4) throw new RangeError('Puja com a màxim quatre fotos cada vegada');
    const remaining=row.photos.filter(photo=>!edit.removePhotos.includes(photo));
    if (remaining.length+edit.uploads.length>MAX_PHOTOS) throw new RangeError('Cada espai pot tindre com a màxim dotze fotos');
    if (edit.coverPhoto && !remaining.includes(edit.coverPhoto)) throw new RangeError('La foto de portada no és vàlida');
    const processed:Buffer[]=[];
    for (const image of edit.uploads) {
      if (!image.length || image.length>MAX_PHOTO_BYTES) throw new RangeError('Cada foto ha de tindre entre 1 byte i 5 MB');
      try {
        const transformer=sharp(image,{limitInputPixels:20_000_000});
        const info=await transformer.metadata();
        if (!['jpeg','png','webp'].includes(info.format || '')) throw new RangeError('Només s’accepten fotos JPG, PNG o WebP');
        processed.push(await transformer.rotate().resize(2000,2000,{fit:'inside',withoutEnlargement:true})
          .jpeg({quality:85,mozjpeg:true}).toBuffer());
      } catch(error) {
        if (error instanceof RangeError) throw error;
        throw new RangeError('La foto no és vàlida o és massa gran');
      }
    }
    const uploaded:string[]=[];
    let metadataSaved=false;
    try {
      for (const image of processed) {
        const path=`rooms/${row.room_id}/${randomBytes(16).toString('hex')}.jpg`;
        const {error}=await this.client.storage.from(PHOTO_BUCKET).upload(path,image,
          {contentType:'image/jpeg',cacheControl:'3600',upsert:false});
        if (error) throw error;
        uploaded.push(path);
      }
      const photos=[...remaining,...uploaded.map(path=>this.client.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl)];
      if (edit.coverPhoto) {
        photos.splice(photos.indexOf(edit.coverPhoto),1);
        photos.unshift(edit.coverPhoto);
      }
      const prior=this.rooms.find(item=>item.resource_email.toLowerCase()===row.email.toLowerCase());
      const base=readJson<Record<string,BaseMetadata>>(this.paths.catalogue,{});
      const {error}=await this.client.from('sjma_reservas_rooms').upsert({
        resource_email:row.email.toLowerCase(),room_id:row.room_id,published:edit.published,
        title,features:edit.features,photos,sort_order:edit.sortOrder,
        address:prior?.address ?? base[row.room_id]?.address ?? null,
        updated_at:new Date().toISOString(),
      },{onConflict:'resource_email'});
      if (error) throw error;
      metadataSaved=true;
      await this.refresh();
    } catch(error) {
      if (!metadataSaved && uploaded.length) await this.client.storage.from(PHOTO_BUCKET).remove(uploaded);
      throw error;
    }
  }
  async removePhoto(key:string,photo:string):Promise<string[]> {
    const row=(await this.adminRows()).find(item=>item.key===key);
    if (!row) throw new RangeError('Recurs no trobat a Workspace');
    if (!row.photos.includes(photo)) throw new RangeError('Fotografia no trobada');
    const photos=row.photos.filter(item=>item!==photo);
    const current=this.rooms.find(item=>item.resource_email.toLowerCase()===row.email.toLowerCase());
    if (!current) throw new RangeError('Recurs no guardat');
    const {error}=await this.client.from('sjma_reservas_rooms')
      .update({photos,updated_at:new Date().toISOString()}).eq('resource_email',current.resource_email);
    if (error) throw error;
    await this.refresh();
    const marker=`/storage/v1/object/public/${PHOTO_BUCKET}/`;
    const path=photo.includes(marker) ? photo.split(marker)[1] : '';
    if (path && !path.includes('..')) await this.client.storage.from(PHOTO_BUCKET).remove([path]);
    return photos;
  }
  photoPath(filename:string):string|null {
    const path=join(this.paths.photos,filename);
    return /^[a-f0-9]{32}\.jpg$/.test(filename) && existsSync(path) ? path : null;
  }
}
