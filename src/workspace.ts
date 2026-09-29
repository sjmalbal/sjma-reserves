import { readFileSync, existsSync } from 'node:fs';
import { JWT, OAuth2Client } from 'google-auth-library';
import type { Paths, Settings } from './config.js';

export const RESOURCE_SCOPE = 'https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly';
export const FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.freebusy';
export const EVENT_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const MAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1';

export interface BusyInterval { start: string; end: string }
export interface CalendarResource {
  resourceId?: string;
  resourceEmail: string;
  resourceName?: string;
}
export interface GoogleEvent {
  id?: string;
  attendees?: Array<{ email: string; responseStatus?: string }>;
  start?: { dateTime: string };
  end?: { dateTime: string };
}
export interface WorkspaceApi {
  listResources(): Promise<CalendarResource[]>;
  busyMany(emails: string[], start: string, end: string): Promise<Record<string, BusyInterval[]>>;
  busy(email: string, start: string, end: string): Promise<BusyInterval[]>;
  insert(id: string, resourceEmail: string, start: string, end: string): Promise<GoogleEvent>;
  insertBlock(id:string,resourceEmail:string,start:string,end:string,label:string):Promise<GoogleEvent>;
  move(id:string,resourceEmail:string,start:string,end:string):Promise<GoogleEvent>;
  get(id: string): Promise<GoogleEvent>;
  delete(id: string): Promise<void>;
  sendMail(to: string, subject: string, body: string, sender: string): Promise<string>;
  writeCredentialsReady(): boolean;
}

export class GoogleError extends Error {
  constructor(public status: number, message: string) { super(`Google HTTP ${status}: ${message}`); }
}

interface PythonToken {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token?: string;
  expiry?: string;
  scopes?: string[];
}

function oauthClient(path: string, requiredScopes: string[]): OAuth2Client {
  if (!existsSync(path)) throw new Error(`Falta l'autorització OAuth: ${path}`);
  const data = JSON.parse(readFileSync(path, 'utf8')) as PythonToken;
  if (!requiredScopes.every(scope => data.scopes?.includes(scope))) {
    throw new Error(`Falten permisos OAuth en ${path}; cal repetir l'autorització`);
  }
  const client = new OAuth2Client(data.client_id, data.client_secret);
  client.setCredentials({
    access_token: data.token,
    refresh_token: data.refresh_token,
    expiry_date: data.expiry ? Date.parse(data.expiry) : undefined,
  });
  return client;
}

async function accessToken(client: OAuth2Client | JWT): Promise<string> {
  const result = await client.getAccessToken();
  if (!result.token) throw new Error('Google no ha retornat un token d’accés');
  return result.token;
}

async function googleJson<T>(client: OAuth2Client | JWT, method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken(client)}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return {} as T;
  if (!response.ok) {
    let message = 'sense detall';
    try { message = (await response.json() as { error?: { message?: string } }).error?.message ?? message; } catch { /* Empty response. */ }
    throw new GoogleError(response.status, message);
  }
  return await response.json() as T;
}

function encodeAddress(address: string): string {
  if (!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(address)) throw new Error('Adreça de correu no vàlida');
  return address;
}

function mimeMessage(to: string, subject: string, body: string, sender: string): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const mime = [
    `From: ${encodeAddress(sender)}`,
    `To: ${encodeAddress(to)}`,
    'Reply-To: secretaria@sjmalbal.com',
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

export function resourceResponse(event: GoogleEvent, email: string): string {
  return event.attendees?.find(attendee => attendee.email.toLowerCase() === email.toLowerCase())?.responseStatus ?? 'missing';
}

export class Workspace implements WorkspaceApi {
  private reader?: OAuth2Client;
  private writer?: OAuth2Client | JWT;
  private freebusyClient?: OAuth2Client | JWT;
  constructor(private paths: Paths, private settings: Settings) {}

  writeCredentialsReady(): boolean {
    return this.settings.auth_mode === 'service_account'
      ? existsSync(this.paths.serviceAccount) && Boolean(this.settings.organizer_email)
      : existsSync(this.paths.writeToken);
  }

  private readClient(): OAuth2Client {
    return this.reader ??= oauthClient(this.paths.readToken, [RESOURCE_SCOPE, FREEBUSY_SCOPE]);
  }

  private writeClient(scopes: string[]): OAuth2Client | JWT {
    if (this.settings.auth_mode === 'service_account') {
      if (!this.settings.organizer_email || !existsSync(this.paths.serviceAccount)) throw new Error('Falta la delegació de domini');
      const key = JSON.parse(readFileSync(this.paths.serviceAccount, 'utf8')) as { client_email: string; private_key: string };
      return new JWT({ email: key.client_email, key: key.private_key, scopes, subject: this.settings.organizer_email });
    }
    return this.writer ??= oauthClient(this.paths.writeToken, [EVENT_SCOPE, MAIL_SCOPE]);
  }

  async listResources(): Promise<CalendarResource[]> {
    const resources: CalendarResource[] = [];
    let next: string | undefined;
    do {
      const params = new URLSearchParams({ maxResults: '500' });
      if (next) params.set('pageToken', next);
      const data = await googleJson<{ items?: CalendarResource[]; nextPageToken?: string }>(
        this.readClient(), 'GET', `${DIRECTORY}/customer/my_customer/resources/calendars?${params}`,
      );
      resources.push(...(data.items ?? []));
      next = data.nextPageToken;
    } while (next);
    return resources;
  }

  async busyMany(emails: string[], start: string, end: string): Promise<Record<string, BusyInterval[]>> {
    if (!emails.length) return {};
    const client = this.freebusyClient ??= this.settings.auth_mode === 'service_account'
      ? this.writeClient([FREEBUSY_SCOPE])
      : oauthClient(this.paths.readToken, [FREEBUSY_SCOPE]);
    const result = await googleJson<{ calendars?: Record<string, { busy?: BusyInterval[]; errors?: unknown[] }> }>(
      client, 'POST', `${CALENDAR}/freeBusy`,
      { timeMin: start, timeMax: end, items: emails.map(id => ({ id })) },
    );
    const output: Record<string, BusyInterval[]> = {};
    for (const email of emails) {
      const item = result.calendars?.[email];
      if (!item || item.errors?.length) throw new Error(`No es pot consultar la disponibilitat del recurs ${email}`);
      output[email] = item.busy ?? [];
    }
    return output;
  }

  async busy(email: string, start: string, end: string): Promise<BusyInterval[]> {
    return (await this.busyMany([email], start, end))[email];
  }

  async insert(id: string, resourceEmail: string, start: string, end: string): Promise<GoogleEvent> {
    return googleJson<GoogleEvent>(this.writeClient([EVENT_SCOPE]), 'POST',
      `${CALENDAR}/calendars/primary/events?sendUpdates=all`, {
        id, summary: 'Reserva de aula SJMA', description: `Referencia de reserva SJMA: ${id}`,
        start: { dateTime: start }, end: { dateTime: end },
        attendees: [{ email: resourceEmail, resource: true }],
        extendedProperties: { private: { sjmaBookingId: id } },
      });
  }

  async insertBlock(id:string,resourceEmail:string,start:string,end:string,_label:string):Promise<GoogleEvent> {
    return googleJson<GoogleEvent>(this.writeClient([EVENT_SCOPE]),'POST',
      `${CALENDAR}/calendars/primary/events?sendUpdates=all`,{
        id,summary:'Espai no disponible · SJMA',
        description:`Bloqueig SJMA: ${id}`,
        start:{dateTime:start},end:{dateTime:end},
        attendees:[{email:resourceEmail,resource:true}],
        extendedProperties:{private:{sjmaBlockId:id}},
      });
  }

  async move(id:string,resourceEmail:string,start:string,end:string):Promise<GoogleEvent> {
    return googleJson<GoogleEvent>(this.writeClient([EVENT_SCOPE]),'PATCH',
      `${CALENDAR}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`,{
        start:{dateTime:start},end:{dateTime:end},attendees:[{email:resourceEmail,resource:true}],
      });
  }

  async get(id: string): Promise<GoogleEvent> {
    return googleJson<GoogleEvent>(this.writeClient([EVENT_SCOPE]), 'GET',
      `${CALENDAR}/calendars/primary/events/${encodeURIComponent(id)}`);
  }

  async delete(id: string): Promise<void> {
    await googleJson(this.writeClient([EVENT_SCOPE]), 'DELETE',
      `${CALENDAR}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`);
  }

  async sendMail(to: string, subject: string, body: string, sender: string): Promise<string> {
    const result = await googleJson<{ id?: string }>(this.writeClient([MAIL_SCOPE]), 'POST',
      `${GMAIL}/users/me/messages/send`, { raw: mimeMessage(to, subject, body, sender) });
    if (!result.id) throw new Error('Gmail no ha confirmat l’enviament');
    return result.id;
  }
}
