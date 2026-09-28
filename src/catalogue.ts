import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Paths, PublicRoom, Settings } from './config.js';
import { readJson, writeJsonAtomic } from './config.js';
import type { CalendarResource, WorkspaceApi } from './workspace.js';

export const FEATURES = ['Piano', 'Espill', 'Pissarra Digital', 'Pissarra',
  'Micròfon de gravació', 'Altaveus', 'Projector'] as const;
export const MAX_PHOTOS = 12;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

interface Metadata {
  title?: string;
  features?: string[];
  photos?: string[];
  address?: string;
  source_url?: string;
  resource_email?: string;
  sort_order?: number;
}
type MetadataMap = Record<string, Metadata>;
export interface AdminRow {
  key: string; room_id: string; workspace_name: string; email: string;
  published: boolean; title: string; features: string[]; photos: string[]; sortOrder: number;
}
export interface ResourceEdit {
  title: string; features: string[]; removePhotos: string[];
  published: boolean; uploads: Buffer[]; coverPhoto?: string; sortOrder: number;
}

export function validateSortOrder(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 9999) throw new RangeError('L’ordre ha de ser un número enter entre 1 i 9999');
}

export function keyFor(resource: CalendarResource): string {
  return createHash('sha256').update(resource.resourceId || resource.resourceEmail.toLowerCase()).digest('hex').slice(0, 20);
}

export class Catalogue {
  constructor(private paths: Paths, private settings: Settings, private workspace: WorkspaceApi) {}

  async refresh(): Promise<void> {}

  private metadata(): MetadataMap {
    return readJson<MetadataMap>(this.paths.catalogue, {});
  }
  private overrides(): MetadataMap {
    return readJson<MetadataMap>(this.paths.overrides, {});
  }

  publicRooms(): PublicRoom[] {
    const base = this.metadata(), overrides = this.overrides();
    return this.settings.rooms.map((configured,index) => {
      const metadata = { ...base[configured.id], ...overrides[configured.id] };
      return {
        ...configured,
        sortOrder: metadata.sort_order ?? (index+1)*10,
        title: metadata.title || configured.name,
        features: metadata.features ?? [],
        photos: metadata.photos ?? [],
        address: metadata.address,
      };
    }).sort((a,b)=>a.sortOrder-b.sortOrder || a.id.localeCompare(b.id,'ca'));
  }

  async adminRows(): Promise<AdminRow[]> {
    const resources = await this.workspace.listResources();
    const base = this.metadata(), overrides = this.overrides();
    const configured = new Map(this.settings.rooms.map((room,index) => [room.email.toLowerCase(), {room,index}] as const));
    const savedIds = new Map(Object.entries(overrides)
      .filter(([, value]) => value.resource_email)
      .map(([id, value]) => [value.resource_email!.toLowerCase(), id]));
    return resources.filter(resource => resource.resourceEmail).map(resource => {
      const email = resource.resourceEmail;
      const configuredRoom = configured.get(email.toLowerCase());
      const id = configuredRoom?.room.id || savedIds.get(email.toLowerCase()) || `workspace-${keyFor(resource)}`;
      const metadata = { ...base[id], ...overrides[id] };
      return {
        key: keyFor(resource), room_id: id,
        workspace_name: resource.resourceName || email,
        email, published: Boolean(configuredRoom),
        title: metadata.title || resource.resourceName || email,
        features: metadata.features ?? [], photos: metadata.photos ?? [],
        sortOrder: metadata.sort_order ?? (configuredRoom ? (configuredRoom.index+1)*10 : 1000),
      };
    }).sort((a,b)=>Number(b.published)-Number(a.published) || a.sortOrder-b.sortOrder || a.workspace_name.localeCompare(b.workspace_name,'ca'));
  }

  async save(key: string, edit: ResourceEdit): Promise<void> {
    // Always verify the resource still exists in Workspace immediately before saving.
    const row = (await this.adminRows()).find(item => item.key === key);
    if (!row) throw new RangeError('Recurs no trobat a Workspace');
    const title = edit.title.trim();
    validateSortOrder(edit.sortOrder);
    if (!title || title.length > 120 || /[\x00-\x1f]/.test(title)) throw new RangeError('Nom públic no vàlid');
    if (new Set(edit.features).size !== edit.features.length
      || edit.features.some(feature => !FEATURES.includes(feature as typeof FEATURES[number]))) {
      throw new RangeError('Característiques no vàlides');
    }
    if (edit.removePhotos.some(photo => !row.photos.includes(photo))) throw new RangeError('Fotografies no vàlides');
    if (edit.uploads.length > 4) throw new RangeError('Puja com a màxim quatre fotos cada vegada');
    const remaining = row.photos.filter(photo => !edit.removePhotos.includes(photo));
    if (remaining.length + edit.uploads.length > MAX_PHOTOS) throw new RangeError('Cada espai pot tindre com a màxim dotze fotos');
    if (edit.coverPhoto && !remaining.includes(edit.coverPhoto)) throw new RangeError('La foto de portada no és vàlida');

    const processed: Buffer[] = [];
    for (const image of edit.uploads) {
      if (!image.length || image.length > MAX_PHOTO_BYTES) throw new RangeError('Cada foto ha de tindre entre 1 byte i 5 MB');
      try {
        const transformer = sharp(image, { limitInputPixels: 20_000_000 });
        const info = await transformer.metadata();
        if (!['jpeg', 'png', 'webp'].includes(info.format || '')) throw new RangeError('Només s’accepten fotos JPG, PNG o WebP');
        processed.push(await transformer.rotate().resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: true }).toBuffer());
      } catch (error) {
        if (error instanceof RangeError) throw error;
        throw new RangeError('La foto no és vàlida o és massa gran');
      }
    }

    mkdirSync(this.paths.photos, { recursive: true, mode: 0o700 });
    const files: string[] = [];
    let metadataSaved = false;
    try {
      for (const image of processed) {
        const name = `${randomBytes(16).toString('hex')}.jpg`;
        const path = join(this.paths.photos, name);
        writeFileSync(path, image, { flag: 'wx', mode: 0o600 });
        files.push(path);
      }
      const overrides = this.overrides();
      const photos = [...remaining, ...files.map(path => `/room-photos/${path.split('/').at(-1)}`)];
      if (edit.coverPhoto) {
        photos.splice(photos.indexOf(edit.coverPhoto), 1);
        photos.unshift(edit.coverPhoto);
      }
      overrides[row.room_id] = {
        ...overrides[row.room_id], resource_email: row.email,
        title, features: edit.features,
        sort_order: edit.sortOrder,
        photos,
      };
      writeJsonAtomic(this.paths.overrides, overrides);
      metadataSaved = true;

      const current = this.settings.rooms;
      const index = current.findIndex(room => room.email.toLowerCase() === row.email.toLowerCase());
      const updated = [...current];
      if (edit.published) {
        const resource = { ...current[index], id: row.room_id, name: title, email: row.email };
        if (index < 0) updated.push(resource);
        else updated[index] = resource;
      } else if (index >= 0) updated.splice(index, 1);
      if (JSON.stringify(updated) !== JSON.stringify(current)) {
        writeJsonAtomic(this.paths.config, { ...this.settings, rooms: updated });
        this.settings.rooms = updated;
      }
    } catch (error) {
      if (!metadataSaved) for (const path of files) unlinkSync(path);
      throw error;
    }
  }

  async removePhoto(key: string, photo: string): Promise<string[]> {
    const row = (await this.adminRows()).find(item => item.key === key);
    if (!row) throw new RangeError('Recurs no trobat a Workspace');
    if (!row.photos.includes(photo)) throw new RangeError('Fotografia no trobada');
    const photos = row.photos.filter(item => item !== photo);
    const overrides = this.overrides();
    overrides[row.room_id] = { ...overrides[row.room_id], resource_email: row.email, photos };
    writeJsonAtomic(this.paths.overrides, overrides);
    return photos;
  }

  photoPath(filename: string): string | null {
    return /^[a-f0-9]{32}\.jpg$/.test(filename) ? join(this.paths.photos, filename) : null;
  }
}
