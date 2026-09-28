import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Room { id: string; name: string; email: string }
export interface Settings {
  timezone: string;
  opening_hour: number;
  closing_hour: number;
  slot_minutes: number;
  slot_step_minutes?: number;
  min_minutes?: number;
  max_minutes?: number;
  max_days_ahead: number;
  auth_mode?: 'oauth' | 'service_account';
  organizer_email?: string;
  notification_email?: string;
  rooms: Room[];
}
export interface PublicRoom extends Room {
  title: string;
  features: string[];
  photos: string[];
  sortOrder?: number;
  address?: string;
}
export interface Paths {
  root: string;
  assets: string;
  privateDir: string;
  config: string;
  db: string;
  catalogue: string;
  overrides: string;
  photos: string;
  adminSessions: string;
  readToken: string;
  writeToken: string;
  serviceAccount: string;
}

export function pathsFor(root = resolve(import.meta.dirname, '../..')): Paths {
  const privateDir = join(root, '.private');
  const assets = join(root, 'reservas-ts', 'assets');
  return {
    root, assets, privateDir,
    config: join(privateDir, 'reservas-config.json'),
    db: join(privateDir, 'reservas.sqlite3'),
    catalogue: join(assets, 'catalogue.json'),
    overrides: join(privateDir, 'catalogue-overrides.json'),
    photos: join(privateDir, 'room-photos'),
    adminSessions: join(privateDir, 'admin-sessions.sqlite3'),
    readToken: join(privateDir, 'token-lectura-workspace.json'),
    writeToken: join(privateDir, 'token-reservas-workspace.json'),
    serviceAccount: join(privateDir, 'service-account.json'),
  };
}

export function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback;
}

export function readSettings(paths: Paths): Settings {
  return readJson<Settings>(existsSync(paths.config) ? paths.config : join(paths.assets, 'config.example.json'), {} as Settings);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.sjma-${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
