/** Local OAuth authorization for Workspace resource reads or organizer writes. */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { pathsFor, readSettings, writeJsonAtomic } from './config.js';
import { EVENT_SCOPE, FREEBUSY_SCOPE, MAIL_SCOPE, RESOURCE_SCOPE } from './workspace.js';

interface ClientFile { installed?: {client_id: string; client_secret: string}; web?: {client_id: string; client_secret: string} }

async function authorize(mode: 'read' | 'write'): Promise<void> {
  const paths = pathsFor();
  const settings = readSettings(paths);
  const clientPath = join(paths.privateDir, 'cliente-oauth.json');
  if (!existsSync(clientPath)) throw new Error('Falta .private/cliente-oauth.json');
  const clientInfo = JSON.parse(readFileSync(clientPath, 'utf8')) as ClientFile;
  const credentials = clientInfo.installed ?? clientInfo.web;
  if (!credentials) throw new Error('El client OAuth no té credencials d’escriptori');
  const scopes = mode === 'read'
    ? [RESOURCE_SCOPE, FREEBUSY_SCOPE]
    : [EVENT_SCOPE, MAIL_SCOPE, 'openid', 'https://www.googleapis.com/auth/userinfo.email'];
  const tokenPath = mode === 'read' ? paths.readToken : paths.writeToken;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');

  let finish!: (value: void) => void;
  let fail!: (reason: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') { response.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400, {'content-type':'text/plain; charset=utf-8'}).end('Enllaç caducat o no vàlid.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      response.writeHead(400, {'content-type':'text/plain; charset=utf-8'}).end('Google no ha tornat un codi d’autorització.');
      fail(new Error('Google no ha retornat el codi OAuth'));
      server.close();
      return;
    }
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Port OAuth no disponible');
      const redirectUri = `http://127.0.0.1:${address.port}/`;
      const client = new OAuth2Client(credentials.client_id, credentials.client_secret, redirectUri);
      const { tokens } = await client.getToken({code,codeVerifier:verifier});
      if (!tokens.access_token || !tokens.refresh_token) throw new Error('Google no ha retornat un token renovable');
      const info = await client.getTokenInfo(tokens.access_token);
      if (!scopes.every(scope => info.scopes.includes(scope))) throw new Error('No s’han concedit tots els permisos');
      if (mode === 'write') {
        const user = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers:{authorization:`Bearer ${tokens.access_token}`}, signal:AbortSignal.timeout(15000),
        });
        const identity = await user.json() as {email?: string};
        if (!user.ok || identity.email?.toLowerCase() !== settings.organizer_email?.toLowerCase()) {
          throw new Error('S’ha autoritzat un compte diferent de l’organitzador configurat');
        }
      }
      writeJsonAtomic(tokenPath, {
        token: tokens.access_token, refresh_token: tokens.refresh_token,
        token_uri: 'https://oauth2.googleapis.com/token',
        client_id: credentials.client_id, client_secret: credentials.client_secret,
        scopes, expiry: new Date(tokens.expiry_date ?? Date.now() + 3600000).toISOString(),
      });
      response.writeHead(200, {'content-type':'text/plain; charset=utf-8'}).end('Autorització completada. Ja pots tancar esta finestra.');
      finish();
    } catch (error) {
      response.writeHead(400, {'content-type':'text/plain; charset=utf-8'}).end('No s’ha pogut completar l’autorització.');
      fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      server.close();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port OAuth no disponible');
  const client = new OAuth2Client(credentials.client_id, credentials.client_secret,
    `http://127.0.0.1:${address.port}/`);
  const link = client.generateAuthUrl({
    access_type:'offline', prompt:'consent', scope:scopes, state,
    code_challenge:challenge, code_challenge_method:CodeChallengeMethod.S256,
  });
  console.log(`Obri este enllaç amb el compte ${mode === 'read' ? 'administrador' : settings.organizer_email}:\n${link}`);
  try { await completed; console.log('Autorització guardada localment.'); }
  finally { server.close(); }
}

const mode = process.argv[2];
if (mode !== 'read' && mode !== 'write') {
  console.error('Ús: npm run authorize -- read|write');
  process.exitCode = 2;
} else {
  authorize(mode).catch(error => {console.error(error.message); process.exitCode = 1;});
}
