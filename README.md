# Reserves d'espais de la SJMA

Aplicació en **TypeScript**: servidor Node/Fastify, pàgina pública compilada amb Vite, PostgreSQL de Supabase per a les dades de producció i connexió directa amb els recursos de Google Workspace. El panell mostra els recursos existents de Workspace i permet editar-ne el nom públic, les característiques, les fotos i la publicació. La reserva convida el recurs a un esdeveniment del compte organitzador; quan el recurs l'accepta, envia un correu a la persona que ha reservat i un altre a secretaria.

La web està publicada a <https://espais.sjmalbal.com> amb HTTPS. El formulari de reserva continua desactivat fins que la SJMA aprove les regles i la informació de privacitat. L'estat i la configuració del desplegament estan en [deploy/README.md](deploy/README.md).

## Posada en marxa local

Cal Node.js 22 o superior. Des d'aquest directori:

```sh
npm ci
npm run check
npm test
npm run build
npm start
```

La web s'obri a <http://127.0.0.1:8766/> i l'administració a <http://127.0.0.1:8766/admin>. El detall d'una aula té una ruta pròpia, per exemple `/aules/aula-2`, i admet recàrrega i navegació amb Arrere/Endavant. El servidor només escolta en localhost. `SJMA_PORT` canvia el port. Les reserves públiques estan desactivades per defecte; `SJMA_ENABLE_BOOKINGS=1 npm start` les activa **i pot crear esdeveniments i enviar correus reals**. El 28-09-2026 se'n va fer una prova real controlada en un port temporal, sense activar el servidor públic habitual.

El panell d'administració té una pàgina de login pròpia. La identitat s'autoritza amb el compte de Google Workspace de la SJMA i el servidor consulta `empleados.emp_admin` en Supabase per al correu verificat abans de crear la sessió i en cada accés al panell. Sols entra si hi ha exactament una fitxa amb `emp_admin = true`. La sessió caduca al cap de 8 hores, es pot tancar des del panell i els formularis tenen protecció CSRF. L'antiga contrasenya d'administració ja no dona accés. El panell permet ampliar fotos, llevar-les amb confirmació i triar la portada; l'elecció de portada s'aplica en guardar la fitxa.

## Configuració i dades

- `assets/config.example.json` conté valors de prova per a horari, duració i antelació. La configuració activa d'horari és `../.private/reservas-config.json`.
- Per defecte les reserves, el catàleg i les sessions d'administració es guarden en quatre taules noves de Supabase (`sjma_reservas_*`); les fotos públiques estan en el bucket `sjma-reserves-photos`. Els recursos i l'ocupació continuen en Google Workspace. `empleados.emp_admin` es consulta, però no es modifica.
- `SJMA_DATA_BACKEND=sqlite npm start` recupera el mode local anterior. La còpia de les dades locals anterior a la migració es conserva en `../.private/backups/`. Si s'utilitzen tots dos modes per a fer reserves alhora, les bases divergiran; no s'ha d'activar eixe mode com a segon servidor públic.
- El servidor llig `../.private/supabase-admin.json` amb `url` i `service_role_key` del projecte SJMA, o les variables `SJMA_SUPABASE_URL` i `SJMA_SUPABASE_SERVICE_ROLE_KEY`. El fitxer ha de ser privat (permisos `0600`) i la clau mai s'envia al navegador. Per a un domini públic amb HTTPS, configura `SJMA_PUBLIC_ORIGIN` i guarda un client OAuth de tipus web en `../.private/cliente-oauth-web.json` amb la URL `https://<domini>/admin/auth/callback` autoritzada. El client d'escriptori es manté per a l'ús local.
- El catàleg base i les imatges originals són en `assets/`; les 10 fitxes i 14 fotos s'han importat a Supabase. El navegador carrega `public/catalogue.js`, generat amb `npm run build`.
- El compte organitzador configurat és `anny-workspace-integration@sjmalbal.com`; els avisos a secretaria van a `secretaria@sjmalbal.com`.

Per renovar l'autorització OAuth amb el client local guardat a `../.private/cliente-oauth.json`:

```sh
npm run authorize -- read
npm run authorize -- write
```

`read` s'ha de completar amb un compte que puga llistar recursos i consultar-ne l'ocupació; `write`, amb el compte organitzador configurat. La sessió d'escriptura actual ja s'ha autoritzat, així que no cal repetir-la per a l'ús local.

`npm run retry-mail -- --booking-id REFERÈNCIA --retry-failed` reintenta només avisos que tenen un error definitiu. `npm run probe -- --confirmar-prueba-real` crea i elimina un esdeveniment real de prova: és una acció amb efectes en Workspace i cal decidir expressament quan fer-la.

`npm run probe-full -- --confirmar-prueba-real` prova el circuit HTTP de reserva amb un servidor local temporal que tinga `SJMA_ENABLE_BOOKINGS=1` i `SJMA_PORT=8767`. Usa el compte organitzador com a sol·licitant, envia els dos avisos reals, elimina l'esdeveniment i la fila de Supabase, comprova que l'aula queda lliure i envia a secretaria un missatge final que identifica l'avís anterior com a prova. Cal comprovar l'eixida del procés i que la neteja s'ha completat.

## Estat de verificació

El 28-09-2026 es va comprovar una reserva real de l'Aula 2 (29-09-2026, 21:00–21:30): acceptació del recurs, ocupació visible en FreeBusy, estat confirmat en Supabase i acceptació de l'enviament dels dos avisos per Gmail API. La reserva i l'esdeveniment es van eliminar i la franja va tornar a quedar lliure; també es va enviar l'avís de neteja a secretaria. L'estat `sent` acredita que Gmail API ha acceptat l'enviament, no que els missatges hagen arribat a la safata dels destinataris. La compilació, les 8 proves automatitzades i una prova de navegador d'escriptori i mòbil també passen. El 29-09-2026 un administrador va confirmar l'accés al panell públic després del retorn OAuth i es va comprovar una sessió activa en Supabase. Abans d'activar reserves públiques cal tancar les regles de reserva, el tractament de cancel·lacions i els textos de privacitat.
