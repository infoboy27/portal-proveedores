# Infra — Supabase self-hosted

El stack de Supabase que corre este portal es el **kit estándar de self-hosting de
`supabase/supabase`** (docker compose, sin fork ni modificaciones), desplegado en
`/home/ubuntu/adsemble/supabase` en el servidor de desarrollo. Ese kit completo
(los `docker-compose*.yml` genéricos, `volumes/db/init`, `volumes/api/kong.yml`,
etc.) **no se versiona aquí** porque es boilerplate público reproducible desde la
[guía oficial](https://supabase.com/docs/guides/self-hosting/docker) — lo único
que vive en este repo es lo que Adsemble construyó encima:

| Carpeta | Qué es | Se monta en el servidor como |
|---|---|---|
| `functions/` | Edge Functions (Deno) — integración con Business Central y OCR | `supabase/volumes/functions/` |
| `ocr-service/` | Microservicio Python (Tesseract) para extracción de fecha/NCF, sin IA de pago | contenedor `adsemble-ocr-service` |

## Edge Functions

- `_shared/bc-client.ts` — cliente mínimo de Business Central API v2.0 (OAuth2 client-credentials). Requiere `BC_TENANT_ID`, `BC_CLIENT_ID`, `BC_CLIENT_SECRET`, `BC_ENVIRONMENT`, `BC_COMPANY_ID` en `supabase/.env` (nunca versionados).
- `bc-sync-orders` — BC → Supabase, sincroniza `purchaseOrders` + líneas
  (API estándar). Automatizada por cron cada 15 min.
- `bc-sync-receipts` — BC → Supabase, sincroniza `purchaseReceipts` (Custom
  API propia, `infra/business-central/`, publicada 2026-08-20). Automatizada
  cada 15 min.
- `bc-sync-payments` — BC → Supabase, sincroniza `vendorLedgerEntries`
  (Custom API propia) hacia el estado de pago de las facturas (`paid_at`,
  `payment_due_date`, `payment_source='bc'`). Match por `externalDocumentNo`
  (no por el número del documento borrador — ver comentario en el código:
  BC renumera al postear). Automatizada cada 30 min.
- `bc-export-invoice` — Supabase → BC, exporta una factura aprobada como `purchaseInvoices` (cabecera + líneas + PDF adjunto). Validado en vivo contra el sandbox `Test672026`.
- `extract-invoice-data` — llama a `ocr-service` para prellenar `invoice_date`/NCF desde el PDF subido, sin pisar datos ya cargados por el proveedor.

Los cuatro syncs cron (`scripts/sync-*.sh` + referencia `.crontab`) siguen el
mismo patrón — el crontab real con la anon key vive solo en el servidor.
`sync-vendors.sh` **nunca** invita automáticamente (ver incidente 2026-08-20
en `docs/BITACORA.md`) — solo mantiene el perfil de proveedor al día.

- `invite-user` — único camino para crear un login nuevo desde la app
  (botón "Crear usuario" en `Users.tsx`). Revalida server-side que quien
  llama sea admin.
- `resolve-login-identifier` — resuelve RNC/cédula al correo real antes del
  login (Supabase Auth solo soporta login por correo).
- `bc-sync-vendors` — sincroniza el perfil completo de proveedores (email
  incluido). `inviteNewVendors` en el body, default `false` y con límite
  duro de 10 invitaciones por corrida incluso si se activa — ver el
  incidente en `docs/BITACORA.md` antes de activarlo.

## Configuración del contenedor `auth` (plantillas de correo + SITE_URL)

El `docker-compose.override.yml` real vive solo en el servidor (no en git,
mismo criterio que el resto de este archivo). `docker-compose.override.reference.yml`
en esta misma carpeta es una copia de referencia — incluye:

- Plantillas de correo con marca Adsemble (`auth-templates/invite.html`,
  `recovery.html`) montadas en el contenedor `auth`.
- `SITE_URL` pasado al contenedor `functions` (lo necesita `invite-user`
  para armar el enlace que cae en `/set-password`, no en la raíz del sitio).

## Variables de entorno requeridas (además de las estándar de Supabase)

```
BC_TENANT_ID=
BC_CLIENT_ID=
BC_CLIENT_SECRET=
BC_ENVIRONMENT=
BC_COMPANY_ID=
```

Estas se agregan a `supabase/.env` en el servidor — nunca al repo.

## Esquema de base de datos

El esquema real vive en `app/schema.sql` (se aplica directo contra el Postgres
del stack self-hosted). Ver `docs/DATABASE_SCHEMA.md` para el detalle documentado.
