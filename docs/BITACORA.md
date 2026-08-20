# Bitácora del proyecto

Registro vivo de avance. Se actualiza en cada sesión de trabajo — qué se hizo,
qué quedó pendiente y por qué. No reemplaza al plan (`IMPLEMENTATION_PLAN.md`);
lo complementa con el estado real fecha por fecha.

Formato de cada entrada: fecha, qué se hizo, qué quedó pendiente/bloqueado.

---

## 2026-08-20 — Auditoría inicial + puesta en git

**Contexto:** el correo enviado a Adsemble compromete 15 días hábiles de
desarrollo, pero el reloj **aún no ha arrancado**. Se aprovechó para auditar
el estado real antes de que empiece a contar.

**Hecho hoy:**
- Auditoría completa del servidor de dev (`jfmc-server`, `/home/ubuntu/adsemble`)
  contra lo prometido en el correo a Adsemble y contra lo que el repo de GitHub
  documentaba.
- Se confirmó que el repo `infoboy27/portal-proveedores` solo contenía el
  material de ingeniería inversa del portal legacy (`build-original/`,
  `extraido/`) y una carpeta `docs/` que describía una arquitectura
  (Next.js + Prisma + Auth.js + BullMQ) **que nunca se construyó**.
- El código real — funcionando hace 2+ semanas en el servidor, sin ningún
  respaldo en git — usa otro stack: Vite + React + TS + Zustand sobre
  **Supabase self-hosted** (no Next.js/Prisma), con Edge Functions en Deno
  para la integración con Business Central.
- Se migró ese código real al repo: `app/` (frontend) e `infra/supabase/`
  (Edge Functions + servicio OCR). Se reescribió toda la documentación en
  `docs/` para que refleje la arquitectura real en vez de la abandonada.
- `.env`, `node_modules`, `dist`, y los datos/volúmenes de Postgres **no** se
  suben al repo (ver `.gitignore` en cada carpeta).

**Verificado como YA implementado y funcionando (no solo "planeado"):**
- Cliente OAuth2 client-credentials contra Business Central API v2.0,
  validado en vivo contra el sandbox `Test672026`.
- `bc-sync-orders`: trae `purchaseOrders` + líneas desde BC a Supabase
  (idempotente por `bc_id`) — corrige el bug legacy de "líneas SIN DATOS".
- `bc-export-invoice`: exporta una factura aprobada a BC (`purchaseInvoices`,
  cabecera + líneas + PDF adjunto), guarda `bc_invoice_id`/`bc_invoice_number`.
- Flujo de aprobación (`Approvals.tsx` + RPC `rpc_update_invoice_status`),
  con umbral de "alto valor" (>= 10,000) y scoping por rol/empresa.
- `extract-invoice-data`: OCR propio (Tesseract, sin IA de pago) para
  prellenar fecha/NCF sin pisar datos ya cargados por el proveedor.
- Frontend desplegado y accesible en `https://proveedores.jfmcss.com` (200 OK).

**Brechas reales identificadas frente al correo enviado a Adsemble:**

| Compromiso | Estado |
|---|---|
| Roles: Administrador, Proveedor, Analista, + rol interno para facturas de proveedores recurrentes | Existen `admin/superadmin/approver/supplier` en el `check` constraint de `user_profiles.role`. **Falta el rol interno** para carga de facturas de proveedores recurrentes de servicios |
| Aislamiento de datos por proveedor | Solo a nivel de UI (el frontend filtra por `vendorId`/`companyId`). **RLS en Postgres es "authenticated read-all"** — sin aislamiento real a nivel de base de datos |
| Confirmación de órdenes de compra | No existe ningún botón "Confirmar"/"Solicitar cambio" en `OrderDetail.tsx` — solo lectura + carga de factura |
| Validación de facturas (duplicados, montos, cantidades) | Comentario explícito en el código: "se omite el flujo de factura duplicada". No hay validación real hoy |
| Consulta de pagos + estado de cuenta | No existe — ni estado `pending_payment`/`paid`, ni sync de pagos/vendor ledger desde BC, ni página |
| SMTP real (correos de bienvenida/aprobación) | Sigue apuntando al mailer fake de desarrollo (`supabase-mail`) — ningún correo real sale hoy |
| Sync de órdenes automatizado | `bc-sync-orders` es invocación manual, sin cron/schedule |

**Pendiente / próximo paso:** empezar a cerrar las brechas de arriba,
priorizando aislamiento de datos (seguridad) y roles antes de tocar
validación de facturas y pagos. Ver `IMPLEMENTATION_PLAN.md` para el mapeo
completo contra los 15 días comprometidos.

---

## 2026-08-20 (continuación) — Aislamiento de datos real (RLS) + rol interno

**Hecho:**
- Antes de escribir la migración se detectó **deriva de esquema**: la base
  viva tenía 5 columnas en `invoices` (`bc_invoice_id`, `bc_invoice_number`,
  `export_error_reason`, `exported_at`, `payment_due_date`) agregadas
  ad-hoc y nunca capturadas en `schema.sql`/`schema-v2.sql`. Se confirmó con
  `pg_dump --schema-only` contra la base real y se reconcilió en
  `app/schema-v3.sql`. **Corrección a la entrada anterior**: sí existe un
  campo `payment_due_date` (fecha de pago manual, ver `setInvoicePaymentDueDate`
  en `domain.ts`) — lo que falta es el **estado** `pending_payment`/`paid`
  en el ciclo de vida y una página de consulta, no el campo en sí.
- `app/schema-v3.sql`: agrega el rol `service_uploader` al `check` constraint
  de `user_profiles.role`, y reemplaza **todas** las políticas RLS
  "authenticated read-all" por políticas reales de aislamiento
  (`portal_role()`/`portal_company_id()`/`portal_vendor_ids()`, funciones
  `SECURITY DEFINER` para evitar recursión al consultar `user_profiles`
  desde su propia política).
- Reglas aplicadas: `admin`/`superadmin` sin restricción; `approver`
  (Analista) escoped por `company_id`; `supplier`/`service_uploader`
  escoped por los `vendor_id` en `user_vendor_mapping`. Además: `invoices`
  UPDATE ahora bloquea que un `supplier`/`service_uploader` mueva su propia
  factura a un estado posterior a `pending_approval` vía REST directo — solo
  la RPC `rpc_update_invoice_status` (admin/approver) y la Edge Function
  `bc-export-invoice` (`service_role`) pueden hacerlo. Se agregó también una
  política UPDATE en `user_profiles` (no existía ninguna — `Users.tsx`
  fallaba en silencio al intentar cambiar rol/empresa de un usuario).
- **Verificado con sesiones simuladas** (`SET LOCAL ROLE authenticated` +
  `request.jwt.claims`, mismo mecanismo que usa PostgREST) antes de tocar
  producción: `admin` ve las 11 vendors/10 órdenes/5 facturas/1 empresa/2
  perfiles; `supplier` (sugopeca, vendor `22222222-...`) ve solo su propio
  vendor/empresa/perfil y 0 órdenes/facturas (correcto — ese vendor no tiene
  ninguna en el seed, confirmado aparte); un `sub` sin fila en
  `user_profiles` no ve nada en ninguna tabla.
- Aplicado a la base viva dentro de una transacción (`BEGIN`/`COMMIT`,
  atómico) — la primera corrida falló a mitad de camino por un choque de
  nombre (`current_role()` colisiona con la palabra reservada `CURRENT_ROLE`
  de SQL) y se corrigió renombrando a `portal_role()` antes de reintentar.
- Cableado en frontend: `service_uploader` agregado a `UserRole` (`types.ts`),
  a `ROLE_FEATURES` (`FeatureGuard.tsx`, mismos permisos que `supplier`), al
  selector de rol en `Users.tsx`, y a `canUpload` en `OrderDetail`
  (`Orders.tsx`) — sin esto el rol existiría en la base pero cualquier
  usuario con ese rol quedaría bloqueado de toda la UI. De paso se corrigió
  el copy de `approver` de "Aprobador" a **"Analista"** para que coincida
  con el rol prometido a Adsemble.
- `tsc --noEmit` + `vite build` corrieron limpios, imagen Docker
  reconstruida y desplegada (`portal-app-1` recreado) — `proveedores.jfmcss.com`
  responde 200 con los cambios en producción interna.

**Pendiente:** el resto de las brechas de la entrada anterior siguen
abiertas (confirmación de órdenes, validación de factura duplicada/monto/
cantidad, estado `pending_payment`/`paid` + página de pagos, SMTP real,
cron para `bc-sync-orders`). El `approver` escoped por `company_id` asume
que "empresa" alcanza para aislar a un Analista — el concepto de
`isGlobal` que existía en el frontend (`Company.isGlobal`) no tiene columna
real en `companies`, así que se ignoró esa rama al escribir las políticas;
si Adsemble necesita un Analista que vea más de una empresa, hay que
agregar esa columna antes de usarla.
