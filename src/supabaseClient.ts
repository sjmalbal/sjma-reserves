import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { Paths } from './config.js';

export interface SupabaseCredentials { url: string; service_role_key: string }

export function supabaseCredentials(paths: Paths): SupabaseCredentials {
  const file = join(paths.privateDir, 'supabase-admin.json');
  const credentials = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8')) as SupabaseCredentials
    : {url:process.env.SJMA_SUPABASE_URL ?? '',service_role_key:process.env.SJMA_SUPABASE_SERVICE_ROLE_KEY ?? ''};
  const parsed = URL.canParse(credentials.url) ? new URL(credentials.url) : null;
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co')
    || !credentials.service_role_key) throw new Error('Falta la configuració privada de Supabase');
  return {url:parsed.origin,service_role_key:credentials.service_role_key};
}

export function supabaseServerClient(paths: Paths) {
  const {url,service_role_key} = supabaseCredentials(paths);
  return createClient(url,service_role_key,{
    auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false},
    global:{headers:{'X-Client-Info':'sjma-reserves-server'}},
  });
}

export type ServerSupabase = ReturnType<typeof supabaseServerClient>;
