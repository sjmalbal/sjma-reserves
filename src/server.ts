import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import nunjucks from 'nunjucks';
import { BookingService } from './booking.js';
import type { ReserveInput } from './booking.js';
import { Catalogue, FEATURES, MAX_PHOTO_BYTES } from './catalogue.js';
import { pathsFor, readSettings } from './config.js';
import type { Paths, Settings } from './config.js';
import { Workspace } from './workspace.js';
import type { WorkspaceApi } from './workspace.js';
import { AdminSessions, WorkspaceAdminIdentity } from './adminAuth.js';
import type { AdminIdentity, AdminSession,AdminSessionStore } from './adminAuth.js';
import type { FastifyRequest } from 'fastify';
import { supabaseServerClient } from './supabaseClient.js';
import { SupabaseBookingStore } from './bookingStore.js';
import { SupabaseCatalogue } from './supabaseCatalogue.js';
import { SupabaseAdminSessions } from './supabaseAdminSessions.js';

declare module 'fastify' { interface FastifyRequest { adminSession?: AdminSession } }
export interface AppOptions { paths?: Paths; settings?: Settings; workspace?: WorkspaceApi; adminIdentity?: AdminIdentity; dataBackend?: 'sqlite'|'supabase' }

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function htmlJson(value: unknown): nunjucks.runtime.SafeString {
  const json = JSON.stringify(value).replace(/[<>&]/g, char => ({'<':'\\u003c','>':'\\u003e','&':'\\u0026'})[char]!);
  return new nunjucks.runtime.SafeString(json);
}

export async function buildApp(options: AppOptions = {}) {
  const paths = options.paths ?? pathsFor();
  const settings = options.settings ?? readSettings(paths);
  const workspace = options.workspace ?? new Workspace(paths, settings);
  const backend=options.dataBackend ?? process.env.SJMA_DATA_BACKEND ?? 'supabase';
  if (!['sqlite','supabase'].includes(backend)) throw new Error('SJMA_DATA_BACKEND no vàlid');
  const supabase=backend==='supabase' ? supabaseServerClient(paths) : null;
  const catalogue=supabase ? new SupabaseCatalogue(paths,settings,workspace,supabase)
    : new Catalogue(paths,settings,workspace);
  await catalogue.refresh();
  const booking = new BookingService(paths, settings, workspace,undefined,
    supabase ? new SupabaseBookingStore(supabase) : undefined);
  const identity = options.adminIdentity ?? new WorkspaceAdminIdentity(paths);
  const sessions:AdminSessionStore = supabase ? new SupabaseAdminSessions(supabase,identity)
    : new AdminSessions(paths.adminSessions, identity);
  const app = Fastify({ logger: false, bodyLimit: 22 * 1024 * 1024 });
  const templates = nunjucks.configure(join(paths.assets, 'templates'), { autoescape: true, noCache: true });
  templates.addFilter('tojson', htmlJson);
  templates.addFilter('format', (format: string, value: number) => format.replace('%02d', String(value).padStart(2, '0')));

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { files: 4, fileSize: MAX_PHOTO_BYTES, fields: 25 } });
  await app.register(fastifyStatic, { root: join(paths.assets, 'static'), prefix: '/static/' });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/admin')) return;
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const path = request.url.split('?')[0];
    if (['/admin/login','/admin/auth/start','/admin/auth/callback'].includes(path)) return;
    try { request.adminSession = await sessions.authorize(request.cookies.sjma_admin_session) ?? undefined; }
    catch (error) { request.log.error(error); return reply.code(503).send('No es pot verificar el permís d’administració ara'); }
    if (request.adminSession) return;
    if (request.method === 'GET') return reply.code(303).header('Location','/admin/login').send();
    return reply.code(401).send('Cal iniciar sessió com a administrador');
  });

  const callbackUri = (request: FastifyRequest): string => {
    const origin = process.env.SJMA_PUBLIC_ORIGIN ?? `${request.protocol}://${request.headers.host ?? ''}`;
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1','localhost'].includes(parsed.hostname)))
      throw new Error('Cal configurar un origen HTTPS per a administració');
    return new URL('/admin/auth/callback', parsed).toString();
  };
  const secureCookie = (request: FastifyRequest): boolean => callbackUri(request).startsWith('https:');
  app.get('/admin/login', async (_request, reply) => reply.type('text/html; charset=utf-8')
    .send(templates.render('admin-login.html')));
  app.get('/admin/auth/start', async (request, reply) => {
    try {
      const {state,url} = await sessions.start(callbackUri(request));
      return reply.setCookie('sjma_admin_state',state,{path:'/admin/auth/callback',httpOnly:true,sameSite:'lax',secure:secureCookie(request),maxAge:600})
        .code(303).header('Location',url).send();
    } catch (error) { request.log.error(error); return reply.code(503).send('No es pot iniciar la sessió ara'); }
  });
  app.get<{Querystring:{code?:string;state?:string;error?:string}}>('/admin/auth/callback', async (request, reply) => {
    if (request.query.error) return reply.code(403).send('No s’ha autoritzat l’accés a Google');
    try {
      const {token} = await sessions.complete(request.query.code ?? '',request.query.state ?? '',
        request.cookies.sjma_admin_state ?? '',callbackUri(request));
      return reply.clearCookie('sjma_admin_state',{path:'/admin/auth/callback'})
        .setCookie('sjma_admin_session',token,{path:'/admin',httpOnly:true,sameSite:'lax',secure:secureCookie(request),maxAge:8*60*60})
        .code(303).header('Location','/admin').send();
    } catch (error) {
      request.log.warn(error);
      return reply.clearCookie('sjma_admin_state',{path:'/admin/auth/callback'})
        .code(403).type('text/html; charset=utf-8').send(templates.render('admin-login.html',{
          error:'No tens accés al panell. Utilitza un compte de la SJMA marcat com a administrador.',
        }));
    }
  });
  app.post<{Body:{csrf_token?:string}}>('/admin/logout', async (request, reply) => {
    if (!safeEqual(request.body?.csrf_token ?? '',request.adminSession!.csrf)) return reply.code(403).send('Formulari no vàlid');
    await sessions.logout(request.cookies.sjma_admin_session);
    return reply.clearCookie('sjma_admin_session',{path:'/admin'}).code(303).header('Location','/admin/login').send();
  });

  app.get<{Params: {name: string}}>('/static/:name.js', async (request, reply) => {
    if (!['catalogue', 'admin'].includes(request.params.name)) return reply.code(404).send('No trobat');
    const script = join(paths.assets, '..', 'public', `${request.params.name}.js`);
    if (!existsSync(script)) return reply.code(503).send('Cal compilar el frontend TypeScript');
    return reply.type('application/javascript').send(readFileSync(script));
  });

  const renderCatalogue = async () => {
    await catalogue.refresh();
    const rooms = catalogue.publicRooms();
    return templates.render('catalogue.html', {
      rooms, slot_minutes: settings.slot_minutes,
      slot_step_minutes: settings.slot_step_minutes ?? settings.slot_minutes,
      max_days: settings.max_days_ahead,
      min_minutes: settings.min_minutes ?? 30,
      max_minutes: settings.max_minutes ?? 300,
      bookings_enabled: process.env.SJMA_ENABLE_BOOKINGS === '1',
    });
  };
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(await renderCatalogue()));
  app.get<{Params: {id: string}}>('/aules/:id', async (request, reply) => {
    await catalogue.refresh();
    if (!catalogue.publicRooms().some(room => room.id === request.params.id)) return reply.code(404).send('Aula no trobada');
    return reply.type('text/html; charset=utf-8').send(await renderCatalogue());
  });
  app.get<{Params: {id: string; ref: string}}>('/aules/:id/reserves/:ref', async (request, reply) => {
    await catalogue.refresh();
    if (!catalogue.publicRooms().some(room => room.id === request.params.id)
      || !/^[a-f0-9]{32}$/.test(request.params.ref)) return reply.code(404).send('Reserva no trobada');
    return reply.type('text/html; charset=utf-8').send(await renderCatalogue());
  });

  app.get<{Querystring: {date?: string}}>('/api/day', async (request, reply) => {
    try { await catalogue.refresh(); return await booking.dayAvailability(request.query.date ?? ''); }
    catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({error: error.message});
      request.log.error(error); return reply.code(503).send({error:'No podem consultar la disponibilitat ara'});
    }
  });

  app.get<{Querystring: {room?: string; date?: string}}>('/api/availability', async (request, reply) => {
    try { await catalogue.refresh(); return {slots: await booking.availability(request.query.room ?? '', request.query.date ?? '')}; }
    catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({error: error.message});
      request.log.error(error); return reply.code(503).send({error:'No podem consultar la disponibilitat ara'});
    }
  });

  app.post<{Body: ReserveInput & {privacy_accepted?: boolean}}>('/api/bookings', { bodyLimit: 4096 }, async (request, reply) => {
    if (process.env.SJMA_ENABLE_BOOKINGS !== '1') return reply.code(503).send({error:'Les reserves encara no estan activades'});
    if (!workspace.writeCredentialsReady()) return reply.code(503).send({error:'Falta autoritzar el compte organitzador'});
    const data = request.body;
    if (!data || !['name','last_name','email','instrument','relation'].every(key =>
      typeof data[key as keyof typeof data] === 'string' && String(data[key as keyof typeof data]).trim())
      || data.privacy_accepted !== true) {
      return reply.code(400).send({error:'Completa les dades obligatòries i la informació de privacitat'});
    }
    try {
      await catalogue.refresh();
      const result = await booking.reserve(data);
      return reply.code(result.state === 'confirmed' ? 201 : result.state === 'pending' ? 202 : 200).send(result);
    } catch (error) {
      if (error instanceof RangeError) return reply.code(409).send({error: error.message});
      request.log.error(error); return reply.code(503).send({error:'No s’ha pogut processar la reserva'});
    }
  });

  app.get<{Params: {id: string}}>('/api/bookings/:id', async (request, reply) => {
    if (!/^[a-f0-9]{32}$/.test(request.params.id)) return reply.code(400).send({error:'Referència no vàlida'});
    try { return await booking.refresh(request.params.id); }
    catch (error) {
      if (error instanceof RangeError) return reply.code(404).send({error:'Reserva no trobada'});
      request.log.error(error); return reply.code(503).send({error:'No podem comprovar la reserva ara'});
    }
  });

  app.get<{Params: {filename: string}}>('/room-photos/:filename', async (request, reply) => {
    const path = catalogue.photoPath(request.params.filename);
    if (!path || !existsSync(path)) return reply.code(404).send('No trobat');
    return reply.type('image/jpeg').header('X-Content-Type-Options', 'nosniff').send(readFileSync(path));
  });

  app.get<{Querystring: {saved?: string}}>('/admin', async (request, reply) => {
    try {
      const resources = await catalogue.adminRows();
      return reply.type('text/html; charset=utf-8').send(templates.render('admin.html', {
        resources, features: FEATURES, csrf_token: request.adminSession!.csrf,
        admin_email: request.adminSession!.email,
        saved: request.query.saved === '1',
      }));
    } catch (error) {
      request.log.error(error); return reply.code(503).send('No s’han pogut consultar els recursos de Google Workspace');
    }
  });

  app.post<{Params: {key: string}}>('/admin/resources/:key', async (request, reply) => {
    const fields = new Map<string, string[]>();
    const uploads: Buffer[] = [];
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.filename) uploads.push(await part.toBuffer());
          else part.file.resume();
        } else {
          fields.set(part.fieldname, [...(fields.get(part.fieldname) ?? []), String(part.value ?? '')]);
        }
      }
      const first = (name: string) => fields.get(name)?.[0] ?? '';
      if (!safeEqual(first('csrf_token'), request.adminSession!.csrf)) return reply.code(403).send('La sessió del formulari ha caducat. Recarrega el panell.');
      await catalogue.save(request.params.key, {
        title: first('title'), features: fields.get('features') ?? [],
        removePhotos: fields.get('remove_photo') ?? [],
        published: first('published') === 'on', uploads, coverPhoto: first('cover_photo'),
        sortOrder: Number(first('sort_order')),
      });
      return reply.code(303).header('Location', `/admin?saved=1#resource-${request.params.key}`).send();
    } catch (error) {
      if (error instanceof RangeError) return reply.code(error.message === 'Recurs no trobat a Workspace' ? 404 : 400).send(error.message);
      request.log.error(error); return reply.code(500).send('No s’han pogut guardar els canvis');
    }
  });

  app.post<{Params: {key: string}; Body: {photo?: string; csrf_token?: string}}>('/admin/resources/:key/photos/remove', async (request, reply) => {
    if (!request.body || !safeEqual(request.body.csrf_token ?? '', request.adminSession!.csrf)) return reply.code(403).send({error:'La sessió del formulari ha caducat'});
    try {
      const photos = await catalogue.removePhoto(request.params.key, request.body.photo ?? '');
      return { photos };
    } catch (error) {
      if (error instanceof RangeError) return reply.code(400).send({error:error.message});
      request.log.error(error); return reply.code(503).send({error:'No s’ha pogut llevar la foto'});
    }
  });

  app.addHook('onClose', async () => { booking.close(); sessions.close(); });
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const app = await buildApp();
  const host = process.env.SJMA_BIND_HOST ?? '127.0.0.1';
  const port = Number(process.env.SJMA_PORT || '8766');
  await app.listen({ host, port });
  console.log(`Reserva SJMA: http://${host}:${port}/`);
}
