import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Paths } from './config.js';

export interface AdminIdentity {
  authorizationUrl(state: string, verifier: string, redirectUri: string): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<string>;
  isAdmin(email: string): Promise<boolean>;
}
export interface AdminSession { email: string; csrf: string }
export interface AdminSessionStore {
  start(redirectUri:string):Promise<{state:string;url:string}>|{state:string;url:string};
  complete(code:string,state:string,stateCookie:string,redirectUri:string):Promise<{token:string;session:AdminSession}>;
  authorize(token:string|undefined):Promise<AdminSession|null>;
  logout(token:string|undefined):Promise<void>|void;
  close():Promise<void>|void;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface GoogleCredentials { installed?: {client_id: string; client_secret: string}; web?: {client_id: string; client_secret: string} }
interface SupabaseCredentials { url: string; service_role_key: string }

export class WorkspaceAdminIdentity implements AdminIdentity {
  private clientId: string;
  private clientSecret: string;
  private webClient: boolean;
  private supabase: SupabaseCredentials;

  constructor(paths: Paths) {
    const webClientPath = join(paths.privateDir, 'cliente-oauth-web.json');
    const useWebClient = process.env.SJMA_PUBLIC_ORIGIN?.startsWith('https://') && existsSync(webClientPath);
    const google = JSON.parse(readFileSync(useWebClient
      ? webClientPath : join(paths.privateDir, 'cliente-oauth.json'), 'utf8')) as GoogleCredentials;
    const credentials = google.installed ?? google.web;
    if (!credentials?.client_id || !credentials.client_secret) throw new Error('Falta el client OAuth de Google');
    this.clientId = credentials.client_id;
    this.clientSecret = credentials.client_secret;
    this.webClient = Boolean(google.web);
    const privateConfig = join(paths.privateDir, 'supabase-admin.json');
    this.supabase = existsSync(privateConfig)
      ? JSON.parse(readFileSync(privateConfig, 'utf8')) as SupabaseCredentials
      : {url:process.env.SJMA_SUPABASE_URL ?? '',service_role_key:process.env.SJMA_SUPABASE_SERVICE_ROLE_KEY ?? ''};
    const parsed = URL.canParse(this.supabase.url) ? new URL(this.supabase.url) : null;
    if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co')
      || !this.supabase.service_role_key) throw new Error('Falta la configuració privada de Supabase per a administració');
    this.supabase.url = parsed.origin;
  }

  private client(redirectUri: string): OAuth2Client {
    return new OAuth2Client(this.clientId, this.clientSecret, redirectUri);
  }

  authorizationUrl(state: string, verifier: string, redirectUri: string): string {
    if (redirectUri.startsWith('https:') && !this.webClient) {
      throw new Error('El login HTTPS necessita un client OAuth de tipus web');
    }
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return this.client(redirectUri).generateAuthUrl({
      response_type:'code', scope:['openid','email'], state,
      code_challenge:challenge, code_challenge_method:CodeChallengeMethod.S256,
      prompt:'select_account', hd:'sjmalbal.com',
    });
  }

  async exchange(code: string, verifier: string, redirectUri: string): Promise<string> {
    const client = this.client(redirectUri);
    const {tokens} = await client.getToken({code,codeVerifier:verifier});
    if (!tokens.id_token) throw new Error('Google no ha retornat una identitat');
    const ticket = await client.verifyIdToken({idToken:tokens.id_token,audience:this.clientId});
    const identity = ticket.getPayload();
    if (!identity?.email || identity.email_verified !== true || identity.hd !== 'sjmalbal.com') {
      throw new Error('Cal un compte verificat de Google Workspace de la SJMA');
    }
    return identity.email.toLowerCase();
  }

  async isAdmin(email: string): Promise<boolean> {
    const url = new URL(`${this.supabase.url}/rest/v1/empleados`);
    url.search = new URLSearchParams({
      select:'emp_id,emp_admin', emp_email_profesional:`eq.${email.toLowerCase()}`, limit:'2',
    }).toString();
    const response = await fetch(url, {
      headers:{apikey:this.supabase.service_role_key,authorization:`Bearer ${this.supabase.service_role_key}`},
      signal:AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`No es pot verificar l'administració (HTTP ${response.status})`);
    const rows = await response.json() as Array<{emp_id: number; emp_admin: boolean}>;
    return Array.isArray(rows) && rows.length === 1 && rows[0].emp_admin === true;
  }
}

export class AdminSessions implements AdminSessionStore {
  private db: Database.Database;
  constructor(path: string, private identity: AdminIdentity) {
    mkdirSync(dirname(path), {recursive:true,mode:0o700});
    this.db = new Database(path);
    chmodSync(path,0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS admin_oauth_states (
      state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
  }

  close(): void { this.db.close(); }

  start(redirectUri: string): {state: string; url: string} {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const url = this.identity.authorizationUrl(state,verifier,redirectUri);
    this.db.prepare('DELETE FROM admin_oauth_states WHERE expires_at < ?').run(Date.now());
    this.db.prepare('INSERT INTO admin_oauth_states VALUES (?,?,?)').run(hash(state),verifier,Date.now()+10*60_000);
    return {state,url};
  }

  async complete(code: string, state: string, stateCookie: string, redirectUri: string): Promise<{token: string;session: AdminSession}> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(state) || !safeEqual(state,stateCookie)) throw new Error('Sessió d’autorització no vàlida');
    const row = this.db.prepare('SELECT verifier,expires_at FROM admin_oauth_states WHERE state_hash=?')
      .get(hash(state)) as {verifier:string;expires_at:number} | undefined;
    this.db.prepare('DELETE FROM admin_oauth_states WHERE state_hash=?').run(hash(state));
    if (!row || row.expires_at < Date.now()) throw new Error('L’autorització ha caducat');
    const email = await this.identity.exchange(code,row.verifier,redirectUri);
    if (!await this.identity.isAdmin(email)) throw new Error('Aquest compte no té permís d’administració');
    const token = randomBytes(32).toString('base64url');
    const session = {email,csrf:randomBytes(32).toString('base64url')};
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now());
    this.db.prepare('INSERT INTO admin_sessions VALUES (?,?,?,?)')
      .run(hash(token),email,session.csrf,Date.now()+8*60*60_000);
    return {token,session};
  }

  async authorize(token: string | undefined): Promise<AdminSession | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = hash(token);
    const row = this.db.prepare('SELECT email,csrf,expires_at FROM admin_sessions WHERE token_hash=?')
      .get(tokenHash) as (AdminSession & {expires_at:number}) | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now() || !await this.identity.isAdmin(row.email)) {
      this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(tokenHash);
      return null;
    }
    return {email:row.email,csrf:row.csrf};
  }

  logout(token: string | undefined): void {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token))
      this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hash(token));
  }
}
