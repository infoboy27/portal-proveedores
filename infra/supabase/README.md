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
- `bc-sync-orders` — BC → Supabase, sincroniza `purchaseOrders` + líneas.
  Automatizada por cron cada 15 min desde 2026-08-20 (`scripts/sync-purchase-orders.sh`
  + `scripts/sync-purchase-orders.crontab` como referencia — el crontab real
  vive en el servidor, no en git, porque lleva la anon key inline).
- `bc-export-invoice` — Supabase → BC, exporta una factura aprobada como `purchaseInvoices` (cabecera + líneas + PDF adjunto). Validado en vivo contra el sandbox `Test672026`.
- `extract-invoice-data` — llama a `ocr-service` para prellenar `invoice_date`/NCF desde el PDF subido, sin pisar datos ya cargados por el proveedor.

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
