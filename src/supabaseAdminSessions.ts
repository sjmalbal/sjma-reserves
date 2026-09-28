import { createHash,randomBytes,timingSafeEqual } from 'node:crypto';
import type { AdminIdentity,AdminSession,AdminSessionStore } from './adminAuth.js';
import type { ServerSupabase } from './supabaseClient.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function equal(a:string,b:string):boolean {
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length && timingSafeEqual(left,right);
}

export class SupabaseAdminSessions implements AdminSessionStore {
  constructor(private client:ServerSupabase,private identity:AdminIdentity) {}
  close():void {}
  async start(redirectUri:string):Promise<{state:string;url:string}> {
    const now=new Date().toISOString();
    const expiredStates=await this.client.from('sjma_reservas_admin_oauth_states').delete().lt('expires_at',now);
    const expiredSessions=await this.client.from('sjma_reservas_admin_sessions').delete().lt('expires_at',now);
    if (expiredStates.error || expiredSessions.error) throw expiredStates.error ?? expiredSessions.error;
    const state=randomBytes(24).toString('base64url');
    const verifier=randomBytes(32).toString('base64url');
    const url=this.identity.authorizationUrl(state,verifier,redirectUri);
    const {error}=await this.client.from('sjma_reservas_admin_oauth_states').insert({
      state_hash:hash(state),verifier,expires_at:new Date(Date.now()+10*60_000).toISOString(),
    });
    if (error) throw error;
    return {state,url};
  }
  async complete(code:string,state:string,stateCookie:string,redirectUri:string):Promise<{token:string;session:AdminSession}> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(state) || !equal(state,stateCookie) || !code)
      throw new Error('Sessió d’autorització no vàlida');
    const {data,error}=await this.client.from('sjma_reservas_admin_oauth_states')
      .delete().eq('state_hash',hash(state)).gt('expires_at',new Date().toISOString()).select('verifier');
    if (error) throw error;
    if (data?.length!==1) throw new Error('L’autorització ha caducat');
    const email=await this.identity.exchange(code,data[0].verifier as string,redirectUri);
    if (!await this.identity.isAdmin(email)) throw new Error('Aquest compte no té permís d’administració');
    const token=randomBytes(32).toString('base64url');
    const session={email,csrf:randomBytes(32).toString('base64url')};
    const {error:sessionError}=await this.client.from('sjma_reservas_admin_sessions').insert({
      token_hash:hash(token),email,csrf:session.csrf,expires_at:new Date(Date.now()+8*60*60_000).toISOString(),
    });
    if (sessionError) throw sessionError;
    return {token,session};
  }
  async authorize(token:string|undefined):Promise<AdminSession|null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash=hash(token);
    const {data,error}=await this.client.from('sjma_reservas_admin_sessions')
      .select('email,csrf,expires_at').eq('token_hash',tokenHash).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (Date.parse(data.expires_at as string)<Date.now() || !await this.identity.isAdmin(data.email as string)) {
      const result=await this.client.from('sjma_reservas_admin_sessions').delete().eq('token_hash',tokenHash);
      if (result.error) throw result.error;
      return null;
    }
    return {email:data.email as string,csrf:data.csrf as string};
  }
  async logout(token:string|undefined):Promise<void> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const {error}=await this.client.from('sjma_reservas_admin_sessions').delete().eq('token_hash',hash(token));
    if (error) throw error;
  }
}
