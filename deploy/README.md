# Desplegament de reserves de la SJMA

El 28-09-2026 es va instal·lar el contenidor `sjma-reserves` a la VM Azure existent (`158.158.51.246`), en `/opt/sjma-reserves`, separat del projecte Docker de DocuSeal. El servei només està connectat a la xarxa Docker `docuseal_default`: no publica cap port. Caddy publica <https://espais.sjmalbal.com> amb HTTPS. Les reserves públiques estan activades. El domini DocuSeal continua responent 200.

## Estat i passos pendents

1. El registre DNS A `espais` → `158.158.51.246`, el certificat HTTPS i la regla de Caddy estan actius.
2. El client OAuth de tipus **Aplicació web** del projecte `sjmalbal1` està guardat en `../.private/cliente-oauth-web.json` localment i al servidor amb permisos 0600. L'inici d'OAuth retorna a `https://espais.sjmalbal.com/admin/auth/callback` i envia una cookie segura. El 29-09-2026 un administrador va confirmar que havia accedit al panell; es va comprovar una sessió activa en Supabase sense consultar dades d'identitat.
3. `SJMA_ENABLE_BOOKINGS=1` en `deploy.env` activa les reserves. `reservas-config.json` en la carpeta privada fixa l'horari: dilluns a dijous 08:30–22:00, divendres i dissabte 08:30–01:00 de l'endemà, i diumenge 09:00–13:00. La duració continua sent de 30 minuts a 5 hores, fins a 90 dies d'antelació.
4. La web pública es va provar en un navegador d'escriptori i mòbil: 10 aules, fotos carregades, detall accessible, sense desbordament horitzontal ni errors de JavaScript. `/api/day` respon 200. La prova real del circuit de reserva i dels correus es va fer en local amb Google Workspace i Supabase el 28-09-2026, amb neteja posterior.

El contenidor utilitza `/app/.private` com a volum de només lectura, amb els tokens de Workspace, el client OAuth i la clau servidor de Supabase. No incloure esta carpeta en la imatge Docker ni en cap repositori. Les dades de reserves, catàleg i sessions es guarden en Supabase; la VM no és la font d'estes dades.

La configuració de Compose es troba en `compose.yaml`. `deploy.env` guarda `SJMA_PUBLIC_ORIGIN`, `SJMA_ENABLE_BOOKINGS`, `SJMA_PRIVATE_DIR` i `SJMA_PROXY_NETWORK` al servidor. El proxy Caddy compartit queda en el projecte DocuSeal.

## CI/CD

`.github/workflows/ci-cd.yml` comprova TypeScript, proves i compilació en cada push i pull request a `main`. Després d'un push a `main`, GitHub Actions entra en Azure amb OIDC de curta durada i executa `/opt/sjma-reserves/deploy.sh` en la VM. L'aplicació d'Azure té una credencial federada limitada a l'entorn GitHub `production`; el seu rol personalitzat només permet llegir la VM i executar-hi Run Command. No hi ha credencials d'Azure ni de SJMA guardades en GitHub.

El script del servidor baixa el commit exacte de `main`, crea una imatge Docker, substituïx el contenidor i comprova salut i HTTPS. Si falla, restaura la imatge anterior. Les credencials i la configuració continuen fora del repositori, en `/opt/sjma-reserves/.private` i `deploy.env`. El script i `deploy.env` són còpies instal·lades al servidor: modificar-los en Git no els actualitza automàticament.
