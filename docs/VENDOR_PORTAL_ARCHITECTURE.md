# Vendor Portal — Arquitectura

> Este documento reemplaza una versión anterior que describía un plan
> (Next.js + Prisma + Auth.js + BullMQ) nunca construido. Lo de abajo es la
> arquitectura **real**, verificada contra el código que corre en producción
> interna. Ver `docs/BITACORA.md` para el historial de esta corrección.

## 1. Contexto

Adsemble operaba un Vendor Portal en `https://portalproveedores.adsemble.do`,
construido por un tercero sobre **Supabase** (Postgres + Auth + Storage) con
automatizaciones en **n8n** (`automate.smartautomation.cloud`) sincronizando
contra Microsoft Dynamics 365 Business Central. Solo el bundle compilado del
frontend estaba disponible — sin acceso al código fuente original. `extraido/*.md`
documenta lo recuperado por ingeniería inversa de ese bundle.

Este proyecto **reemplaza** ese sistema, pero conservando el mismo paradigma
tecnológico (Supabase), no migrando a otro stack: se levantó una instancia
**Supabase self-hosted** propia (sin depender del proveedor original), con
Edge Functions propias para la integración con Business Central.

## 2. Stack real

| Capa | Elección |
|---|---|
| Frontend | Vite + React 18 + TypeScript, Tailwind CSS |
| Estado | Zustand (`store/domain.ts`, `store/session.ts`) |
| Ruteo | React Router |
| Backend / datos | **Supabase self-hosted** (Postgres + Auth + Storage + Realtime + Studio + Kong), kit estándar de `supabase/supabase`, sin fork |
| Integración con BC | Edge Functions en Deno (`infra/supabase/functions/`) — `bc-sync-orders`, `bc-export-invoice`, `extract-invoice-data`, cliente compartido `_shared/bc-client.ts` |
| OCR | Microservicio propio en Python (Tesseract) — `infra/supabase/ocr-service/` — sin dependencia de IA de pago |
| Despliegue | Docker + Docker Compose, Traefik como reverse proxy (`proveedores.jfmcss.com`) |

No hay Prisma, no hay Next.js, no hay BullMQ/Redis en este proyecto — esas
fueron decisiones de un plan preliminar que quedó descartado en la práctica.

## 3. Capas

```
┌──────────────────────────────────────────────┐
│ UI (React + Zustand, Vite)                     │
├──────────────────────────────────────────────┤
│ Supabase client (@supabase/supabase-js)        │
│  - queries directas a Postgres (RLS)           │
│  - RPCs (rpc_update_invoice_status, ...)       │
│  - Storage (PDFs de factura, signed URLs)      │
│  - invoke() a Edge Functions                    │
├──────────────────────────────────────────────┤
│ Edge Functions (Deno, corren en el propio       │
│ stack self-hosted, no en la nube de Supabase)  │
│  - bc-sync-orders, bc-export-invoice,          │
│    extract-invoice-data                        │
├──────────────────────────────────────────────┤
│ Business Central API v2.0 (OAuth2 client-       │
│ credentials, Entra ID) + ocr-service (interno) │
└──────────────────────────────────────────────┘
```

Regla: la UI nunca llama a Business Central directo — siempre pasa por una
Edge Function con `service_role`, para no exponer credenciales de BC al
cliente.

## 4. Roles

Definidos en `user_profiles.role` (`check` constraint, ver `app/schema-v3.sql`):
`admin`, `superadmin`, `approver`, `supplier`, `service_uploader`.

Compromiso con Adsemble (correo de alcance): Administrador, Proveedor,
Analista, y un rol interno adicional para carga de facturas de proveedores
recurrentes de servicios. Mapeo:

| Rol comprometido | Rol actual | Estado |
|---|---|---|
| Administrador | `admin` / `superadmin` | ✅ |
| Proveedor | `supplier` | ✅ |
| Analista | `approver` (copy en UI ajustado a "Analista") | ✅ |
| Rol interno — facturas de proveedores recurrentes | `service_uploader` | ✅ — usa `user_vendor_mapping` igual que `supplier` para asociarse a uno o varios vendors recurrentes |

## 5. Aislamiento de datos por proveedor — estado real

**Aplicado a nivel de base de datos (RLS), no solo UI** — ver `app/schema-v3.sql`
y `docs/BITACORA.md` (2026-08-20). Tres funciones `SECURITY DEFINER`
(`portal_role()`, `portal_company_id()`, `portal_vendor_ids()`) resuelven el
rol/empresa/vendors del usuario autenticado (`auth.uid()`) y las políticas
de cada tabla filtran por eso:

- `admin`/`superadmin`: sin restricción.
- `approver`: filtrado por `company_id` propio.
- `supplier`/`service_uploader`: filtrado por los `vendor_id` alcanzables vía
  `user_vendor_mapping`.

Verificado con sesiones simuladas antes de aplicar a la base viva (detalle en
`BITACORA.md`). El filtrado que hacían las páginas en el cliente
(`Orders.tsx`, `Approvals.tsx`, etc.) sigue ahí pero ahora es una capa
redundante — el aislamiento real ya no depende de que la UI no tenga bugs.

## 6. Referencias

- `BUSINESS_CENTRAL_INTEGRATION.md` — qué endpoints de BC están confirmados y
  cuáles no.
- `DATABASE_SCHEMA.md` — esquema real en Postgres.
- `IMPLEMENTATION_PLAN.md` — plan de cierre mapeado a los 15 días comprometidos.
- `BITACORA.md` — avance fecha por fecha.
