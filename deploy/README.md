# Desplegament de reserves de la SJMA

El 28-09-2026 es va instal·lar el contenidor `sjma-reserves` a la VM Azure existent (`158.158.51.246`), en `/opt/sjma-reserves`, separat del projecte Docker de DocuSeal. El servei només està connectat a la xarxa Docker `docuseal_default`: no publica cap port. Caddy publica <https://espais.sjmalbal.com> amb HTTPS. La pàgina i `/api/day` responen 200, `/admin` redirigix al login i `POST /api/bookings` respon 503 perquè les reserves públiques estan desactivades. El domini DocuSeal continua responent 200.

## Estat i passos pendents

1. El registre DNS A `espais` → `158.158.51.246`, el certificat HTTPS i la regla de Caddy estan actius.
2. El client OAuth de tipus **Aplicació web** del projecte `sjmalbal1` està guardat en `../.private/cliente-oauth-web.json` localment i al servidor amb permisos 0600. L'inici d'OAuth retorna a `https://espais.sjmalbal.com/admin/auth/callback` i envia una cookie segura. Encara cal completar el retorn amb un administrador real.
3. Cal aprovar les regles definitives de reserva i la informació de privacitat abans d'activar `SJMA_ENABLE_BOOKINGS=1`. Els valors actuals permeten reserves durant les 24 hores, de 30 minuts a 5 hores i fins a 90 dies d'antelació.
4. Cal provar el login amb un administrador real i confirmar en el navegador que les fotos i la disponibilitat es mostren correctament. La prova real del circuit de reserva i dels correus es va fer en local amb Google Workspace i Supabase el 28-09-2026, amb neteja posterior.

El contenidor utilitza `/app/.private` com a volum de només lectura, amb els tokens de Workspace, el client OAuth i la clau servidor de Supabase. No incloure esta carpeta en la imatge Docker ni en cap repositori. Les dades de reserves, catàleg i sessions es guarden en Supabase; la VM no és la font d'estes dades.

La configuració de Compose es troba en `compose.yaml`. Per actualitzar el contenidor cal indicar `SJMA_PUBLIC_ORIGIN` i el valor aprovat de `SJMA_ENABLE_BOOKINGS`. El proxy Caddy compartit queda en el projecte DocuSeal.
