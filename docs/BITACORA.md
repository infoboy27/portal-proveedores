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
abiertas (validación de factura duplicada/monto/cantidad, estado
`pending_payment`/`paid` + página de pagos, SMTP real, cron para
`bc-sync-orders`). El `approver` escoped por `company_id` asume que
"empresa" alcanza para aislar a un Analista — el concepto de `isGlobal` que
existía en el frontend (`Company.isGlobal`) no tiene columna real en
`companies`, así que se ignoró esa rama al escribir las políticas; si
Adsemble necesita un Analista que vea más de una empresa, hay que agregar
esa columna antes de usarla.

---

## 2026-08-20 (continuación 2) — Confirmación de órdenes de compra

**Hecho:**
- `app/schema-v4.sql`: columna `purchase_orders.confirmation_status`
  (`pending | confirmed | change_requested`, independiente de `status` que
  refleja el ciclo de vida en BC), tabla `purchase_order_confirmations`
  (auditoría) y RPC `rpc_confirm_purchase_order` (`SECURITY DEFINER`, único
  camino de escritura — ni `purchase_orders.confirmation_status` ni la tabla
  de auditoría tienen política de INSERT/UPDATE directa).
- **Decisión de diseño explícita**: queda como registro solo-portal, nunca
  escribe a Business Central. No hay una acción de confirmación de orden
  confirmada en la API v2.0 para este tenant (`BUSINESS_CENTRAL_INTEGRATION.md §7`,
  regla del proyecto: "no inventar endpoints") — mismo patrón que ya usa
  `PoConfirmation` en el plan original para "cambios sensibles".
- La RPC valida server-side que quien confirma sea `admin`/`superadmin` o
  esté mapeado (`user_vendor_mapping`) al vendor dueño de la orden — no basta
  con que el cliente mande el rol correcto. Verificado con dos pruebas antes
  de tocar producción: (1) el proveedor de prueba intentando confirmar una
  orden ajena → rechazado con error explícito; (2) admin confirmando/
  solicitando cambio → escribe `confirmation_status` y el registro de
  auditoría correctamente (probado en una transacción con `ROLLBACK`, sin
  dejar datos de prueba).
- Frontend: nueva tarjeta en `OrderDetail` (`Orders.tsx`) con el estado de
  confirmación y, para los mismos roles que pueden cargar factura
  (`admin`/`superadmin`/`supplier`/`service_uploader`), botones "Confirmar
  orden" y "Solicitar cambio" (con fecha esperada nueva + motivo). Acción
  nueva `confirmPurchaseOrder` en `domain.ts`, tipo `PurchaseOrderConfirmationStatus`
  en `types.ts`, textos nuevos en `es.json` (no se tocó `en.json` — el
  locale activo hoy es solo español, ver `i18n/index.ts`).
- `tsc --noEmit` + `vite build` limpios, imagen reconstruida y desplegada.

**Pendiente:** no se agregó vista para que Admin/Analista vean la cola de
"cambios solicitados" pendientes de resolver — hoy solo se ve el estado en
el detalle de cada orden individual. Si Adsemble necesita gestionar eso
como cola (como Approvals.tsx para facturas), es un paso siguiente natural,
no incluido en el alcance mínimo de "confirmación de órdenes" del correo.

---

## 2026-08-20 (continuación 3) — Automatizar `bc-sync-orders`

**Hecho:**
- `infra/supabase/scripts/sync-purchase-orders.sh`: invoca la Edge Function
  vía HTTP (`POST /functions/v1/bc-sync-orders` a través de Kong), loguea
  cada corrida con timestamp UTC, sale con código de error si la respuesta
  no trae `"ok":true` (para que un futuro monitor de cron pueda detectarlo).
  Sigue el mismo patrón que `dondeta/deploy/uptime-check.sh` (script
  independiente del proceso de la app, corre por cron).
- Probado manualmente antes de programarlo: `{"ok":true,"ordersProcessed":10,"created":0,"updated":10,"linesSynced":22}` —
  correcto, es idempotente (0 creados en una base ya sincronizada).
- Instalado en el crontab real del servidor cada 15 minutos, **agregado al
  crontab existente sin tocar las entradas de otros proyectos** (Medisoft,
  DóndeTa) — se hizo backup automático del crontab anterior
  (`~/.cache/crontab/crontab.bak`, mecanismo ya provisto por el propio
  `crontab -`).
- `scripts/sync-purchase-orders.crontab` queda en el repo solo como
  **referencia** (plantilla sin la key real) — el crontab real vive
  únicamente en el servidor porque la línea lleva la anon key inline, igual
  que ya hace el webhook de Discord de DóndeTa en su propia entrada.

**Nota de rendimiento, no resuelta:** `bc-sync-orders` trae todas las
órdenes en cada corrida y hace una llamada a BC por orden para sus líneas
(N+1). Con el volumen de dev (10 órdenes) no es problema; si el tenant real
llega a las ~798 órdenes que tenía el portal legacy, hay que revisar el
intervalo o el patrón N+1 antes del corte a producción — documentado en
`sync-purchase-orders.crontab` para que no se pierda.

**Pendiente:** Días 7-9 completos salvo "mostrar recepciones en el detalle
de orden", que sigue condicionado a si BC expone `purchaseReceipts` para
este tenant (Días 1-2, sin confirmar todavía).

---

## 2026-08-20 (continuación 4) — Validación real de factura (duplicado + monto)

**Hallazgo antes de empezar:** no existía ningún campo para capturar el
monto de la factura — `total_amount` se quedaba siempre en 0 porque
ninguna pantalla lo escribía (el KPI de Dashboard, el umbral de "alto
valor" en Approvals, y el total mostrado en Invoices/InvoiceDetail
funcionaban todos sobre datos que nunca se llenaban). "Validar montos" no
era posible sin esto, así que se agregó como parte de esta tarea, no fue
scope creep — sin un campo de monto no había nada que validar.

**Hecho:**
- `app/schema-v5.sql`: índice único parcial `(vendor_id, invoice_number)`
  ignorando facturas con número todavía vacío (se crean así al subir el
  PDF, antes de que el proveedor lo complete). Probado antes de aplicar:
  0 duplicados existentes en la base viva; después de aplicar, un intento
  de insertar dos facturas con mismo vendor+número fue rechazado
  correctamente (probado en transacción revertida).
- `domain.ts:updateInvoiceData` ahora valida **antes** de guardar (mensaje
  explícito, no el error crudo de Postgres): (1) duplicado por
  vendor+número, (2) si la factura está vinculada a una orden, que el
  total no supere el monto de esa orden. Firma extendida con `totalAmount`.
- `InvoiceDetail` (`Invoices.tsx`): nuevo campo "Total de la factura" en el
  formulario de confirmación (junto a número/fecha/NCF), con el monto de la
  orden vinculada como referencia visible. `handleConfirm` ahora valida el
  monto localmente y **quedó envuelto en try/catch** (antes no lo estaba —
  un error de `updateInvoiceData`/`confirmInvoiceForApproval` se perdía
  como promesa rechazada sin mostrarse al usuario).
- **Validación de cantidad explícitamente fuera de alcance, documentado en
  el código**: este rebuild no tiene formulario para cargar líneas de
  factura (el bundle original sí lo tenía, se omitió al simplificar — ver
  comentario histórico en `Invoices.tsx`). No hay contra qué comparar
  cantidad todavía; agregarlo requeriría construir ese formulario primero,
  que es un cambio de alcance mayor, no una validación puntual.
- `tsc --noEmit` falló dos veces antes de compilar limpio: un fragmento de
  comentario mal editado quedó pegado a una firma de tipo, y un typo
  (`current.vendorId` en vez de `current.supplierId`, que es como se llama
  el campo en el tipo `Invoice` del frontend aunque la columna real en la
  base es `vendor_id`). Ambos corregidos antes de desplegar.

**Pendiente de Días 10-13:** SMTP real — sigue en el mailer fake de
desarrollo, necesita credenciales de un proveedor real que solo Jonatan
puede definir (no hay nada que inventar aquí).
