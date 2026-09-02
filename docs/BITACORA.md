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

---

## 2026-08-20 (continuación 5) — SMTP real (Microsoft 365)

**Hecho:**
- Adsemble usa Microsoft 365 como correo corporativo. Jonatan proporcionó
  buzón (`soporte@adsemble.do`) y contraseña de aplicación (SMTP AUTH
  habilitado del lado de Adsemble para ese buzón).
- `supabase/.env` (solo en el servidor, nunca en git — ya estaba en
  `.gitignore`) actualizado: `SMTP_HOST=smtp.office365.com`,
  `SMTP_PORT=587`, `SMTP_USER`/`SMTP_ADMIN_EMAIL=soporte@adsemble.do`,
  `SMTP_SENDER_NAME=Portal de Proveedores Adsemble`. Contenedor
  `supabase-auth` recreado con `sh run.sh recreate auth` para tomar las
  variables nuevas.
- **Probado con dos envíos reales**: (1) `POST /auth/v1/recover` para
  `c.cuevas@adsemble.do` — 200, sin errores, ~3.6s de duración (consistente
  con un round-trip SMTP real, no el mailer fake que respondía en
  milisegundos); (2) `POST /auth/v1/invite` (Admin API, service_role) a
  `jmservicedo@gmail.com` — **confirmado visualmente por Jonatan: el
  correo de invitación llegó**. Usuario de prueba creado por el invite
  borrado después de confirmar (`DELETE /auth/v1/admin/users/{id}`), no
  queda cruft en `auth.users`.

**Con esto, Días 10-13 del compromiso quedan completos — confirmado
end-to-end, no solo por ausencia de errores en el log.**

---

## 2026-08-20 (continuación 6) — Pagos y consulta (Días 13-15, parte 1)

**Decisión de diseño explícita**: igual que con confirmación de órdenes,
esto **no sincroniza con Business Central**. Los vendor ledger entries (los
movimientos de cuentas por pagar) no están confirmados como disponibles
para este tenant (`docs/BUSINESS_CENTRAL_INTEGRATION.md §7`) — por la regla
del proyecto de no inventar endpoints, el estado de pago es un registro
manual del portal, construido sobre el campo `payment_due_date` que ya
existía.

**Hecho:**
- `app/schema-v6.sql`: columnas `invoices.paid_at`/`payment_reference` +
  RPC `rpc_mark_invoice_paid` (`SECURITY DEFINER`, único camino de
  escritura, revalida que el rol sea `admin`/`superadmin`/`approver`).
  **No se agregó un valor nuevo a `invoices.status`** para "pagada" — se
  deriva de `paid_at` (`status='processed'` + `paid_at` nulo = "Pendiente
  de pago"; con `paid_at` = "Pagada"). Evita sumar un estado más al enum
  cuando la combinación existente ya distingue los dos casos.
- Verificado antes de tocar producción (transacciones revertidas): llamada
  no autorizada (proveedor de prueba) → rechazada con error explícito;
  llamada de admin → escribe `paid_at`/`payment_reference` y el historial
  de auditoría correctamente.
- `PaymentStatusBadge.tsx` (nuevo componente, mismo patrón que
  `ExportStatusBadge.tsx`): deriva "Pendiente de pago"/"Pagada" sin tocar
  `StatusBadge`.
- `InvoiceDetail` (`Invoices.tsx`): la tarjeta que antes solo dejaba
  guardar la fecha posible de pago ahora también permite **marcar la
  factura como pagada** (fecha + referencia opcional) cuando aún no lo
  está, y muestra el registro de pago cuando ya lo está.
- **Página nueva `/payments`** ("Pagos"): lista de facturas procesadas con
  su estado de pago, filtro pendiente/pagada, búsqueda, y estadísticas
  (procesadas, pendientes, pagadas, monto pendiente). Ruta + feature
  `payments.read` agregada a todos los roles que ya ven facturas
  (`admin`/`superadmin`/`approver`/`supplier`/`service_uploader`), ítem de
  navegación agregado a `AppShell.tsx`.
- **Explícitamente fuera de alcance, documentado en el código de la
  página**: un estado de cuenta completo (saldo inicial, notas de crédito,
  saldo corriente) — eso necesita los vendor ledger entries de BC que
  siguen sin confirmar. Lo que se construyó es el subconjunto real que sí
  se puede construir hoy: consulta de estado de pago por factura.
- `tsc --noEmit` + `vite build` limpios en el primer intento, desplegado.

**Pendiente de Días 13-15:** UAT con un proveedor real y arranque/corte de
dominio — ambos requieren coordinación directa con Adsemble (acceso a un
proveedor real de prueba, decisión de fecha de corte), no son tareas que
se puedan cerrar solo en el código.

---

## 2026-08-20 (continuación 7) — QA de paridad contra los 8 bugs conocidos

Revisión de los 8 bugs documentados en `extraido/02-rutas-y-modulos.md`
(observados en el portal legacy) contra el código real del rewrite, uno
por uno. No es una prueba visual en navegador — es lectura de código con
verificación de datos reales donde aplicó.

| # | Bug legacy | Estado en el rewrite |
|---|---|---|
| 1 | KPI "Usuarios gestionados" no coincide con `/users` | **No se reproduce** — `Dashboard.tsx` y `Users.tsx` usan la misma regla de alcance (`isAdmin ? todos : por empresa`), así que siempre coinciden para la misma sesión. Sí hay un `isAdmin \|\|` muerto en el filtro de `Dashboard.tsx` (ese bloque solo se renderiza cuando `isAdmin` ya es `true`, así que la condición es vestigial) — cosmético en el código, no un bug visible para el usuario |
| 2 | Auditoría: "Factura vinculada a la orden ." (número faltante) | **No se reproduce, pero tampoco se corrigió igual** — el mensaje original completo ("...vinculada a la orden X") se eliminó del rewrite; `Audit.tsx` solo muestra "Factura {número}", nunca menciona la orden. La clave de texto `invoiceUploadedAuditLinked` sigue en `es.json` pero **no se usa en ningún componente** (confirmado por grep). Es simplificación, no reparación — se perdió información que el original sí daba |
| 3 | Proveedores: 4ª tarjeta de estadística sin título | **Confirmado y corregido ahora**: `Suppliers.tsx` referenciaba `t("suppliersWithEmail")`, clave que no existía en `es.json` ni `en.json` — el fallback de `useTranslation` devuelve la clave cruda, así que la tarjeta mostraba literalmente el texto `suppliersWithEmail`. Agregada la traducción ("Con correo registrado") |
| 4 | NCF extraído igual al número de factura | **Corregido de verdad** — `ocr-service/app.py` tiene regex específico para NCF (`[A-Z]\d{10,12}`, con patrón preferente cerca de la etiqueta "NCF"/"Comprobante Fiscal"), no reutiliza el número de factura. Además nunca pisa un valor ya cargado a mano |
| 5 | Líneas de orden "SIN DATOS" | **Corregido** (ya confirmado en la auditoría inicial) — `bc-sync-orders` sí trae las líneas reales desde BC |
| 6 | Aprobaciones: texto de estado vacío se corta a la derecha | **No verificable sin navegador** — el markup actual (`Approvals.tsx`) usa una celda de tabla centrada con `overflow-x-auto` en el contenedor padre, estructuralmente no debería reproducir un overflow, pero esto es una hipótesis de lectura de código, no una prueba visual real |
| 7 | Empresas: muestra el GUID crudo de BC como "Código" | **Confirmado y corregido ahora**: `CompanyDetail` (`Companies.tsx`) mostraba `row.company.id.slice(0, 8)` — el UUID interno de Postgres (la PK de nuestra tabla `companies`), no el campo `bc_code` que existe justo para esto. Cambiado a `row.company.bcCode`. **Matiz**: el `bc_code` real de la empresa sembrada también es un GUID (`6a763343-...`, el `SystemId` de BC) — BC no siempre expone un código corto legible por empresa, así que esto puede seguir viéndose "como un GUID" aunque ahora sea el campo correcto en vez de uno accidental |
| 8 | Sin acentos ortográficos en toda la UI | **No corregido, sigue igual** — `es.json` sigue mayormente sin tildes ("Ordenes", "aprobacion", etc.). Nunca estuvo en el alcance de los 15 días comprometidos; es trabajo de pulido pendiente, no bloqueante |

**Resumen:** de los 8, 2 estaban genuinamente resueltos ya (#4, #5), 2 se
reprodujeron y se corrigieron en esta sesión (#3, #7), 1 se "resolvió"
quitando la funcionalidad en vez de arreglarla (#2, información perdida),
1 no se reproduce pero tiene código vestigial (#1), 1 no es verificable
sin navegador real (#6), y 1 nunca se abordó porque no era parte del
alcance comprometido (#8).

**Pendiente:** #6 necesita una pasada real en navegador (no solo lectura
de código) para confirmar. #2 y #8 son mejoras de calidad que Adsemble
puede priorizar o no — no son bloqueantes para el arranque.

---

## 2026-08-20 (continuación 8) — Código AL para los endpoints de BC que faltan

Jonatan compartió una captura del **Business Central Admin Center**
(logueado como `w.deschamps@adsemble.do`, entornos `Production`,
`Test_ModuloProyectos`, `Test672026`) preguntando si puede crear él mismo
los endpoints de BC que faltan.

**Respuesta:** el Admin Center administra entornos (actualizaciones,
capacidad, apps de Entra ID) pero **no alcanza** para publicar Custom API
pages — eso requiere VS Code + extensión "AL Language" + un usuario con
permisos de desarrollo en el entorno (distinto del acceso al Admin
Center). Es alcanzable, no es una integración compleja.

**Hecho:** escrito el código AL completo de las dos Custom API pages que
cierran los bloqueos reales de integración (`infra/business-central/`):

- `purchaseReceipts`/`purchaseReceiptLines` (recepciones de compra) —
  necesario para mostrar recepciones en el detalle de orden.
- `vendorLedgerEntries` (movimientos de cuentas por pagar) — bloqueante
  real para "consulta de pagos y estado de cuenta" comprometido a
  Adsemble; hoy `/payments` solo puede mostrar el estado de pago manual.

Ambas de solo lectura. `README.md` en la misma carpeta documenta paso a
paso cómo publicar (requisitos, comandos de VS Code, cómo crear el
permission set, y la advertencia de verificar los nombres de campo contra
el sandbox real antes de confiar en esto — no se verificaron contra el
tenant de Adsemble, solo son los nombres estándar de la app base de BC).

**No se tocó `bc-client.ts` todavía** — las Custom API pages usan un
prefijo de URL distinto (`/api/adsemble/vendorPortal/v1.0/...`) al que usa
hoy el resto de la integración (`/api/v2.0/...`). Cablear el cliente es el
siguiente paso, pero no tiene sentido hacerlo antes de que la extensión
esté publicada y confirmada en el sandbox — documentado en el README de la
extensión para no perderlo.

**Pendiente:** que alguien con AL Language + permisos de desarrollo en
`Test672026` publique la extensión, verifique los nombres de campo contra
el sandbox real, y confirme que responde — recién ahí se cablea
`bc-client.ts` para consumirla.

---

## 2026-08-20 (continuación 9) — Instalación local de las herramientas AL

Jonatan preguntó qué es AL y si podía ayudarlo a instalar/publicar. Se
hizo todo lo automatizable desde su máquina:

- VS Code ya estaba instalado; se instaló la extensión **AL Language**
  (`ms-dynamics-smb.al`) vía `code --install-extension`.
- `.vscode/launch.json` creado en `infra/business-central/`, ya apuntando
  al sandbox `Test672026` con el `tenant` real (mismo `BC_TENANT_ID` de
  `supabase/.env`) — listo para `F5` sin configuración manual.
- **Bug encontrado y corregido antes de que causara un fallo real**: el
  `id` puesto en `app.json` al escribir la extensión no era un GUID válido
  (`...-adsemble0001`, con caracteres no-hexadecimales) — habría fallado
  al compilar. Reemplazado por un GUID generado de verdad.
- Carpeta abierta en VS Code, lista para que Jonatan haga `AL: Download
  Symbols` y `F5` — el único paso que no se puede automatizar es el login
  interactivo con la cuenta de Microsoft (MFA), porque es su identidad, no
  algo que se pueda hacer por él.

**Pendiente:** confirmar que `w.deschamps@adsemble.do` tiene permiso de
desarrollo (`D365 EXTENSION MGT` o `SUPER` en sandbox) en `Test672026` —
si no lo tiene, alguien con rol de administrador en BC se lo asigna antes
de intentar publicar.

---

## 2026-08-20 (continuación 14) — Onboarding real, correos con marca Adsemble, login por RNC

Jonatan pidió construir el onboarding real que faltaba (ver conversación:
"cómo será el onboard de la primera vez para todos los actores"), con
marca de Adsemble en los correos, y que los proveedores puedan loguearse
por RNC/cédula además de correo.

**Construido:**
- `infra/supabase/auth-templates/invite.html` y `recovery.html` — plantillas
  HTML con los colores del logo de Adsemble (azul/rojo/amarillo/navy),
  montadas en el contenedor de `auth` vía `docker-compose.override.yml`
  (`GOTRUE_MAILER_TEMPLATES_INVITE`/`_RECOVERY`, volumen
  `./volumes/auth-templates:/etc/auth/templates:ro`). El override quedó
  mal estructurado en el primer intento (bloque `auth:` pegado después de
  `networks:` en vez de dentro de `services:`) — corregido y validado con
  `run.sh compose-config` antes de reiniciar nada.
- `_shared/provision-user.ts` — helper compartido (invita por Admin API +
  crea `user_profiles` + `user_vendor_mapping`) usado tanto por
  `invite-user` (disparado por un admin desde `Users.tsx`) como por
  `bc-sync-vendors` (disparado por la sync de BC) — separados porque
  `bc-sync-vendors` no tiene un usuario humano cuyo JWT validar.
- `invite-user` (Edge Function): revalida server-side que quien llama sea
  `admin`/`superadmin` contra su JWT real, nunca confía en el rol que
  mande el cliente. `Users.tsx` ganó su primer botón "Crear usuario" real
  (antes no existía — solo se podía editar un perfil ya creado a mano).
- `resolve-login-identifier` (Edge Function) + `Login.tsx`: permite entrar
  con RNC/cédula ademas de correo — resuelve el identificador al correo
  real antes de llamar `signInWithPassword` (Supabase Auth solo soporta
  login por correo). Responde siempre con un mensaje generico si no hay
  match, para no facilitar enumeracion de RNCs.
- `SetPassword.tsx` (`/set-password`, ruta pública): landing del enlace de
  invitación/recuperación — Supabase ya establece la sesión desde el hash
  de la URL, esta pantalla solo pide la contraseña nueva. Así se completa
  el "primer login" sin que el usuario tenga que hacer nada raro: el botón
  del correo lo autentica solo.

**Incidente real durante las pruebas — 26 proveedores reales invitados por
error:**
La primera versión de `bc-sync-vendors` hacía un `select` + `insert`/`update`
**secuencial** por cada uno de los ~3,492 vendors del sandbox. Se colgó por
timeout (`WorkerRequestCancelled`) — pero antes de colgarse, ya había
invitado por correo real a **26 proveedores reales** (Google LLC, Grupo
Diario Libre, Editora Listín Diario, y 23 personas/empresas más), sin
aprobación de Adsemble y sin forma de deshacer el envío. Se identificaron
los 26 (tabla completa entregada a Jonatan en el chat) y se borraron las
26 cuentas (sin contraseña todavía — nadie había podido entrar) para que
el enlace del correo dejara de funcionar.

**Corrección — dos salvaguardas independientes, a propósito redundantes:**
1. `app/schema-v8.sql`: índice único en `vendors.vendor_number` (se probó
   primero como índice parcial, Postgres no lo usa para inferir el target
   de un `ON CONFLICT` — error `42P10` — corregido a índice normal, los
   `NULL` siguen siendo válidos). Permite upsert en bloque (una sola
   llamada a Supabase) en vez de una consulta por vendor.
2. `bc-sync-vendors` reescrito: `inviteNewVendors` en el body, **default
   `false`** — nunca invita a nadie salvo que se pida explícitamente. Aun
   pidiéndolo, un límite duro (`MAX_INVITES_PER_RUN = 10`) evita que una
   corrida mande cientos/miles de correos de una sola vez incluso si se
   activó a propósito — fuerza un rollout por lotes controlados, nunca un
   blast. El cron (`scripts/sync-vendors.sh`, cada 6h) solo sincroniza
   datos de proveedor (email, estado), **nunca** invita — eso sigue siendo
   una acción deliberada desde `Users.tsx` o una decisión explícita futura
   de Adsemble para invitar en lotes.
3. Reprobado en modo seguro: `3,494 vendors` procesados en `1.7s` (antes:
   timeout), `0` invitaciones — confirmado en base de datos (solo las 2
   cuentas de prueba propias, ninguna de las 26 borradas volvió a
   aparecer).

**Probado end-to-end (navegador, con Jonatan como testigo antes de dar
por buena la marca):**
- Invitación real a `jmservicedo@gmail.com` (proveedor de prueba "JFMC
  Smart Services", creado a propósito en el sandbox) vía `invite-user` —
  Jonatan confirmó que el correo llegó con la marca de Adsemble.
- Se generó un enlace de acceso directo (`/admin/generate_link`, sin
  mandar otro correo) para probar el flujo completo yo mismo: clic en el
  enlace → sesión establecida sola → `/set-password` → contraseña creada →
  Dashboard como `supplier`, con la navegación correctamente escopada
  (Órdenes/Facturas/Pagos, sin secciones de admin). Un primer intento con
  el body anidado mal (`options.redirect_to` en vez de `redirect_to` a
  nivel raíz) generó un enlace que caía en `/` en vez de `/set-password` —
  detectado y corregido antes de probarlo.
- Login por RNC (`130999888`, el de JFMC) confirmado funcionando — resuelve
  al correo real y entra igual que con el correo directo.
- `bc-sync-vendors` en modo seguro sincronizó `PROV-000283` (JFMC) sin
  invitar (como se esperaba, ya que se probó la invitación aparte y a
  propósito).

**Pendiente:** decidir con Adsemble si/cuándo activar `inviteNewVendors`
para los proveedores reales que ya existen en BC — dado el incidente, esto
no debe activarse sin una decisión explícita y probablemente por lotes
pequeños, no de una vez.

---

## 2026-08-20 (continuación 15) — Superadmin real + panel de seguridad/incidencias

Jonatan preguntó cómo se manejan los roles/incidencias y si debería haber
un superusuario para eso. Se verificó contra el código (no de memoria):
**`admin` y `superadmin` eran exactamente el mismo rol** — en los 9+
lugares donde el código pregunta "¿es administrador?", siempre los trata
igual. `superadmin` era solo un nombre en la base de datos sin ninguna
capacidad extra. Tampoco existía ningún registro de seguridad — el único
"audit" (`Audit.tsx`) es el historial de estados de factura, no rastrea
logins, cambios de rol, ni cuentas creadas/borradas. El incidente de los
26 proveedores (continuación anterior) lo resolví yo por fuera de la app,
con la clave de servicio, porque no había ninguna herramienta para eso
adentro.

**Hallazgo antes de construir nada**: Supabase Auth (GoTrue) **ya registra
solo** cada login/logout/cambio de contraseña en `auth.audit_log_entries`
— no hizo falta reconstruir eso. Lo que sí faltaba era (1) un registro de
qué **admin** hizo qué acción de negocio (invitar, cambiar rol, desactivar,
eliminar) — GoTrue ve el actor de esas acciones como `service_role`, no
como el admin humano que hizo clic en la app — y (2) una forma de
exponer ambos registros solo a `superadmin`.

**Construido** (`app/schema-v9.sql`):
- `security_audit_log` — tabla nueva, eventos de negocio
  (`user_invited`/`user_role_changed`/`user_deactivated`/`user_reactivated`/`user_deleted`),
  quién lo hizo, sobre quién, antes/después. RLS: solo `superadmin` puede leer.
- `rpc_update_user_profile` — reemplaza el `UPDATE` directo que hacía
  `domain.ts:updateUser` (sin auditoría, sin saber quién lo hizo). Ahora
  registra el evento con el admin real que lo pidió.
- `rpc_recent_auth_events` — expone `auth.audit_log_entries` (que no tiene
  políticas RLS propias — deny-all para `authenticated`) de forma
  controlada, exclusivo de `superadmin`.
- `delete-user` (Edge Function nueva) — baja definitiva de cuenta, **exclusiva
  de `superadmin`** (no de `admin`) — es la primera capacidad real que
  distingue a los dos roles. Registra el evento antes de borrar (para que
  quede el registro aunque el usuario objetivo desaparezca).
- `_shared/provision-user.ts` ahora recibe `actorUserId` opcional y registra
  `user_invited` — `invite-user` pasa el admin real que invitó;
  `bc-sync-vendors` pasa `null` (queda marcado como automático, no un dato
  faltante).
- `security.manage` agregado a `ROLE_FEATURES` **solo para `superadmin`**
  en `FeatureGuard.tsx` — la primera vez que el arreglo de permisos de
  `admin` y `superadmin` se separan.
- `Security.tsx` (`/security`, nav "Seguridad", solo visible para
  `superadmin`): dos tablas — "Acciones administrativas" (nuestro log de
  negocio) y "Sesiones" (login/logout real de GoTrue). No pasa por el
  domain store (`fetchAll`) a propósito — es sensible y de un solo rol,
  no tiene sentido pre-cargarlo para todas las sesiones.
- `Users.tsx`: botón "Eliminar" (con modal de confirmación, no
  `window.confirm`) visible solo para `superadmin`, y nunca sobre la
  propia cuenta.

**Probado antes de desplegar** (transacciones simuladas, revertidas):
`rpc_recent_auth_events` rechaza a un `admin` (c.cuevas) con error
explícito, funciona para `superadmin` (jonatan) y devuelve datos reales de
login. `rpc_update_user_profile` escribe correctamente y clasifica el
evento (`user_deactivated` al pasar de activo a inactivo).

**Probado en navegador después de desplegar**: login como superadmin →
"Seguridad" aparece en el menú → se editó el estado de `sugopeca` (Editar
→ desactivar → Guardar) → apareció de inmediato en "Acciones
administrativas" con fecha/hora real. Un efecto secundario notado: la
lista de `Users.tsx` no tiene un orden estable entre cargas (no hay
`ORDER BY` en la query) — un clic en la fila equivocada por reordenamiento
casi desactiva la cuenta incorrecta (no pasó nada malo, se verificó y
corrigió), pero vale la pena agregar un `order by username` a la query
como mejora de calidad, no urgente.

**Con esto: `admin` y `superadmin` ya son roles genuinamente distintos, y
hay una forma real de investigar/responder incidencias desde adentro de
la aplicación — no solo por mí con acceso directo al servidor.**

---

## 2026-08-20 (continuación 10) — Primer intento de publicación: colisión de IDs

Jonatan corrió `AL: Download Symbols` (exitoso, confirmó versión real del
entorno: `27.5.0.0` — se corrigió `app.json` que tenía `24.0.0.0` como
placeholder) y luego `F5` para publicar.

**Falló, y el error fue informativo:** `Test672026` ya tiene instalada
otra extensión — **"Adsemble Liquid Base" de DYNASOFT SRL, versión
1.0.0.91** — que ya ocupa parte del rango `50100-50149` (el mismo que se
le había puesto a esta extensión por default). Colisión en la página
`50101`.

**Hallazgo relevante para el proyecto:** DYNASOFT SRL parece ser el socio
de integración de BC del proveedor original (o de un proyecto BC anterior
de Adsemble) — hay una extensión propia ya viviendo en el tenant, con
nombre "Adsemble Liquid Base". Vale la pena que Adsemble confirme qué es
esa extensión y si sigue en uso, antes de asumir que el tenant está
"limpio" para futuras integraciones.

**Corregido:** rango de IDs movido de `50100-50149` a `58000-58049` (y las
tres páginas: `58000`, `58001`, `58002`) — mucho menos probable que
choque con algo ya registrado. Pendiente de que Jonatan reintente `F5`.

---

## 2026-08-20 (continuación 12) — Cablear recepciones y pagos reales de BC

Con los dos endpoints confirmados funcionando (continuación 11), se
construyó el resto de la cadena: BC → Supabase → frontend.

**Hecho:**
- `_shared/bc-client.ts`: `bcGet`/`bcGetAll` ahora aceptan un parámetro
  `api: "standard" | "custom"` para elegir entre `/api/v2.0/` (BC) y
  `/api/adsemble/vendorPortal/v1.0/` (la extensión propia). `bcPost`/
  `bcAttachFile` sin cambios de comportamiento (siempre `"standard"`).
- `bc-sync-receipts` (nueva Edge Function): trae `purchaseReceipts`,
  empareja por `order_number` (el campo legible, no el `bc_id`) contra
  `purchase_orders`, upsert idempotente en la tabla nueva
  `purchase_order_receipts`. Probada: `148` recepciones procesadas, `2`
  emparejadas contra las `10` órdenes de prueba (el resto no tiene orden
  correspondiente en el dataset de dev — esperado).
- `bc-sync-payments` (nueva Edge Function): trae `vendorLedgerEntries`
  filtradas server-side (`$filter=documentType eq 'Invoice'`) y actualiza
  `paid_at`/`payment_due_date`/`payment_source='bc'` en `invoices`.
  **Primera versión tuvo timeout** (`WorkerRequestCancelled`) por un
  patrón N+1 (una consulta a Supabase por cada uno de miles de asientos)
  — corregido a una sola consulta + `Map` en memoria, bajó a 2.2s.
- **Hallazgo real al probar con datos reales**: el número de factura que
  guarda `bc-export-invoice` al crear el documento (`bc_invoice_number`,
  ej. `CF-001918`) es de una serie distinta a la del asiento ya posteado
  (`documentNo`, ej. `CFR-000001`) — confirmado comparando contra
  `vendorLedgerEntries` reales. Emparejar por ese campo nunca hubiera
  funcionado después de que BC postea la factura. Corregido: el match
  ahora es primero por `externalDocumentNo` (= el NCF/número que se manda
  como "Vendor Invoice No." al crear, sobrevive el posteo), con
  `documentNo`/`bc_invoice_number` como respaldo.
- **No se confirmó un match real todavía**: las 2 facturas de prueba
  `processed` en la base (`CF-001918`, `CF-001919`) no aparecen ni en
  `purchaseInvoices` (borradores) ni en `vendorLedgerEntries` — probablemente
  nunca se postearon en BC, o son de una prueba anterior que ya no existe
  en el sandbox. El código de sync está probado en rendimiento y lógica,
  pero falta una prueba end-to-end con una factura real: subir, aprobar,
  exportar, que alguien la postee en BC, correr el sync, confirmar el match.
- Migración `app/schema-v7.sql`: tabla `purchase_order_receipts` (+ RLS
  escopada, mismo patrón que `purchase_orders_lines`), columnas
  `invoices.payment_source`/`bc_ledger_entry_no`. El RPC manual
  `rpc_mark_invoice_paid` (schema-v6) se actualizó para marcar
  `payment_source='manual'` explícitamente, así el frontend distingue con
  certeza "alguien lo marcó a mano" de "vino sincronizado de BC".
- Frontend: nueva tarjeta "Recepciones" en `OrderDetail`, indicador de
  origen del pago ("Sincronizado desde Business Central" / "Registrado
  manualmente") en `InvoiceDetail` y columna "Origen" en `/payments`.
  `tsc --noEmit` + `vite build` limpios, desplegado.
- Automatizado por cron: recepciones cada 15 min, pagos cada 30 min
  (dataset mucho más grande, cambia con menos frecuencia) — mismo patrón
  que `bc-sync-orders`, agregado al crontab sin tocar las entradas
  existentes.

**Con esto, los tres bloqueos reales que quedaban del compromiso de 15
días (confirmación de BC, publicación de los endpoints, cableado a la
app) están cerrados.** Lo que queda es exactamente lo que no depende de
código: UAT con un proveedor real, decisión de dominio, y confirmar el
match de pagos con una factura realmente posteada en BC.

---

## 2026-08-20 (continuación 13) — Acceso, proveedor de prueba real, y setup de UAT

Jonatan pidió: (1) un usuario para entrar al portal ya construido, (2)
confirmar si su proveedor personal (Jonatan Francisco Maria Castro /
JFMC Smart Services) existe para poder probar, (3) explicación de n8n.

**Accesos creados** (Admin API, password directo, sin flujo de invitación):
- `jonathanmaria@gmail.com` — rol `superadmin`.
- `jonathanmaria+proveedor@gmail.com` — rol `supplier`, mapeado al
  proveedor de prueba (ver abajo).

**Búsqueda del proveedor — hallazgo real**: ni "Jonatan Francisco Maria
Castro" ni "JFMC Smart Services" existen en el sandbox `Test672026` (se
probó por nombre y por RNC `00118863612`). **El sandbox solo tiene 3,492
proveedores**, muy por debajo de los ~32,957 que menciona el informe
original de Adsemble — esa cifra es de Producción, no del sandbox.
Confirmado con las mismas credenciales de servicio (sí tienen acceso a
Production, mismo tenant): el proveedor real existe ahí —
**`PROV-003735`, RNC `00118863612`, no bloqueado** — pero Production y el
sandbox no están sincronizados uno a uno (Production tiene 3,588
proveedores, ligeramente distinto también).

**Decisión de Jonatan**: crear el proveedor en el sandbox en vez de
esperar una resincronización o apuntar la integración a Production.
Creado `PROV-000278` (mismo nombre/RNC que el real, ID interno distinto,
válido solo para pruebas) vía API estándar de `vendors`, más su fila
correspondiente en `vendors`/`user_vendor_mapping` de Supabase.

**Bloqueo real encontrado al intentar crear una orden de compra para
probar el flujo completo**: BC exige `Gen. Bus. Posting Group` en el
vendor antes de aceptar una orden, y **ese campo no está expuesto en la
API estándar de `vendors`**. Jonatan pidió resolverlo con AL en vez de
configurarlo a mano — se agregó `src/VendorPostingSetupAPI.al` (Custom
API page, `vendorPostingSetups`, solo estos dos campos, editable) a la
misma extensión ya publicada. Publicada con un segundo `F5` sin
fricción. Se leyeron los valores reales de un vendor existente
(`NACGRDO`/`CPPROV`) y se aplicaron al de prueba vía `PATCH`.

**Segundo bloqueo real, en la línea de la orden**: los ítems del catálogo
de BC (`AR-001`, `AR-002`, `AR-003`) tienen una unidad de medida ("UD")
que no está registrada como `Item Unit of Measure` válida — error de
datos maestros de BC, no de nuestra integración. Evitado usando una línea
tipo `Account` (cuenta contable) en vez de `Item`, que no depende de esa
relación. Documentado aquí para no repetir la búsqueda si vuelve a pasar.

**Resultado final**: orden `CP-000211` (RD$5,000, línea "Servicio de
prueba UAT") creada en BC, sincronizada al portal (`bc-sync-orders`
corrido manualmente, `created: 1`), visible y correctamente vinculada al
proveedor de prueba (`PROV-000278`) en Supabase. **El UAT ya se puede
correr de punta a punta**: login como proveedor → confirmar orden →
cargar factura → login como admin → aprobar → exportar a BC.

---

## 2026-08-20 (continuación 11) — Publicación exitosa y endpoints confirmados

`F5` publicó sin errores: `"Success: The package ... has been published
to the server."` Extensión instalada en `Test672026`.

**Probado end-to-end inmediatamente** con las credenciales de servicio
que ya usa el resto de la integración (`BC_CLIENT_ID`/`BC_CLIENT_SECRET`
de `supabase/.env`, mismo flujo OAuth2 client-credentials de
`_shared/bc-client.ts`):

```
GET /api/adsemble/vendorPortal/v1.0/companies({id})/purchaseReceipts     -> HTTP 200, datos reales (CR-000001, CR-000002, ...)
GET /api/adsemble/vendorPortal/v1.0/companies({id})/vendorLedgerEntries -> HTTP 200, datos reales
```

**No hizo falta crear un permission set aparte** — las credenciales de
servicio ya tenían acceso suficiente. Los dos bloqueos reales de
integración con BC que quedaban (recepciones + estado de cuenta) están
**cerrados del lado de BC**.

**Pendiente:** cablear `_shared/bc-client.ts` para que use el prefijo
`/api/adsemble/vendorPortal/v1.0/` (hoy solo conoce `/api/v2.0/`), y
construir sobre eso: mostrar recepciones en el detalle de orden, y
reemplazar el estado de pago manual de `/payments` por datos reales de
`vendorLedgerEntries` — el trabajo de aplicación que quedaba condicionado
a esta confirmación.

---

## 2026-08-20 (continuación 16) — QA del ciclo completo: 3 bugs reales encontrados y corregidos

Jonatan pidió correr el ciclo completo real (invitación → correo →
confirmación de orden → carga de factura → posteo en BC) para saber el
estatus real del proyecto. Se ejecutó en vivo contra `proveedores.jfmcss.com`
(nunca contra Producción de BC), usando un usuario nuevo real creado para
la prueba (`jonathanmaria+qa2026@gmail.com`, rol `supplier`, mapeado a
`PROV-000278`).

**Ciclo probado de punta a punta:**
1. Superadmin invita al usuario desde `Users.tsx` → correo real enviado
   (confirmado por `POST /invite` → 200 en logs de GoTrue, no solo por la UI)
   → registrado en `security_audit_log` con el admin real como actor.
2. Onboarding: enlace de invitación → `/set-password` → contraseña creada →
   dashboard de `supplier` correctamente escopado.
3. Confirmación de la orden `CP-000211` (ya existía, confirmada).
4. Carga de factura (PDF de prueba) → formulario manual de datos (NCF,
   fecha, monto) → `pending_approval`.
5. Aprobación por admin → `approved`.
6. Exportación a Business Central → factura real creada en BC.

**3 bugs reales encontrados y corregidos (commits `788f454`, `fa3c221`,
`0a80e01`, ya en `origin/main`):**

- **QA-001 — fechas un día antes en toda la app.** `new Date("YYYY-MM-DD")`
  se parsea como medianoche UTC; al formatear con `toLocaleDateString("es-DO")`
  en huso horario negativo (UTC-4, el de RD) el resultado retrocede un día.
  Afectaba `Orders.tsx`, `Invoices.tsx` y `Payments.tsx` — la factura de
  prueba se guardó con fecha `2026-08-20` pero se mostraba como `19/8/2026`.
  Corregido parseando los componentes año/mes/día como fecha local.

- **QA-002 — export a BC se marcaba "processed" sin copiar ninguna línea.**
  `bc-export-invoice` omite silenciosamente cualquier línea de la orden sin
  `bc_line_object_number` y aun así marcaba la factura como exportada con
  éxito. Al exportar la factura de prueba real se creó `CF-001920` en BC
  con **0 líneas y RD$0.00**, sin ninguna señal de error en el portal — solo
  se detectó consultando la factura directo en BC. Corregido: si la orden
  tiene líneas pero ninguna se pudo copiar, ahora falla con `export_error`
  explicando la causa exacta.

- **QA-003 — proveedores en blanco por truncamiento de PostgREST.** `fetchAll()`
  traía la tabla `vendors` completa con un solo `select("*")`, pero
  PostgREST limita cada respuesta a `PGRST_DB_MAX_ROWS=1000`. El sandbox
  tiene **3,495 vendors** (Producción: ~32,957) — cualquier vendor fuera de
  esa primera página quedaba invisible en el frontend, mostrando "-" como
  nombre de proveedor en Órdenes/Facturas/Pagos aunque el JOIN en la base de
  datos resolviera el nombre bien. **8 de las 11 órdenes de prueba** tenían
  el proveedor en blanco antes de este fix. Corregido con `fetchAllRows()`,
  que pagina con `.range()` hasta traer la tabla completa.

**Root-cause del dato roto detrás de QA-002 (no es bug de código, es dato
de prueba):** la línea de la orden `CP-000211` se había creado en
continuación 13 como tipo `Account` sin una cuenta contable real asignada
(el workaround de esa sesión evitaba el problema de unidad de medida, pero
dejaba `lineObjectNumber` vacío tanto en BC como en la copia local).
Corregido en BC (PATCH a la línea real, cuenta `6107 - Servicios`) y en la
tabla `purchase_orders_lines` para que coincida.

**Bloqueo real nuevo, del lado de BC, no corregible desde el portal:**
al reintentar el export corregido se creó `CF-001921` (RD$5,000, con línea
real, vinculada correctamente al vendor `PROV-000278`) — pero
**`Microsoft.NAV.post` lo rechaza**: primero por fecha de posteo fuera del
rango permitido (corregido cambiando la fecha), y después por
**"Fiscal Document No. must have a value"** — un campo de cumplimiento
fiscal específico de República Dominicana (NCF) que **no está expuesto en
la API estándar v2.0** de Business Central en ningún campo del payload de
`purchaseInvoices`. Igual que con `Gen. Bus. Posting Group` (continuación
13), esto necesitaría una extensión AL propia (Custom API) para poder
setearlo por API — no se intentó en esta sesión por ser una decisión de
alcance, no un bug a corregir sobre la marcha. **`CF-001921` queda como
borrador válido en el sandbox**, con línea y monto correctos, listo para
posteo manual o para retomar cuando se decida construir esa extensión.

**No se pudo cerrar en esta sesión:** confirmar un match real de
`bc-sync-payments` contra una factura efectivamente posteada — sigue
bloqueado por el punto anterior (posteo automático via API).

**Otros hallazgos, no bugs:** el intento de loguearse como `c.cuevas` (la
admin real de Adsemble) para probar el flujo desde su cuenta fue bloqueado
por el propio entorno de automatización por tratarse de una cuenta de un
tercero real — correcto, no se insistió; en su lugar se usó el superadmin
propio, que tiene los mismos permisos de aprobación/creación. También se
confirmó que la sesión de Supabase Auth es compartida vía `localStorage`
entre pestañas del mismo navegador — abrir una sesión distinta en una
pestaña nueva reemplaza silenciosamente la sesión de las demás pestañas
abiertas al mismo dominio. Es comportamiento estándar de Supabase Auth, no
un bug, pero vale la pena tenerlo presente si se prueba con varios roles a
la vez.

---

## 2026-08-20 (continuación 17) — NCF automático y segundo bloqueo de posteo cerrado

Jonatan pidió resolver el NCF de una vez ("eso es mandatorio y el portal
debe leer ese campo de las facturas automaticamente") — dos pedidos en
uno: (1) que el posteo en BC deje de fallar por falta de NCF, y (2) que
el portal lo lea solo del archivo subido, no que el proveedor lo escriba
a mano. El punto (2) **ya estaba resuelto** desde antes de esta sesión —
ver más abajo. El punto (1) sí era un bloqueo real y llevó varias vueltas.

**Descubrimiento que no esperaba: el OCR de NCF/fecha ya existe y
funciona.** `extract-invoice-data` (Edge Function) + `ocr-service`
(contenedor `adsemble-ocr-service`, Flask + pdf2image + Tesseract en
español, corriendo hace 2 semanas) ya está cableado a `uploadInvoice` en
`domain.ts` — 100% self-hosted, sin OpenAI/Anthropic ni ningún servicio de
pago. Mi primera prueba de `/qa` (con un PDF sintético sin las palabras
"NCF"/"Fecha") no encontró nada y por eso reporté mal que estaba roto.
Reprobado con un PDF realista ("NCF: E310000000001" / "Fecha: 20/08/2026")
subido por la UI real: **el formulario de la factura se pre-llenó solo**,
sin escribir nada a mano. No hizo falta construir nada nuevo aquí.

**El bloqueo real — posteo en BC — necesitó tres vueltas, cada una con un
`F5` de Jonatan:**

1. **NCF ("No. Comprobante Fiscal")**: no expuesto en ningún campo de la
   API v2.0 estándar (confirmado antes, ver continuación 16). Primer
   intento de extensión AL usó el caption visible en pantalla
   (`"No. Comprobante Fiscal"`, encontrado por Jonatan con Ctrl+Alt+F1) —
   falló al compilar (`AL0132`, el campo no existe con ese nombre).
   Encontré el nombre real **sin necesitar VS Code**: BC expone sin querer
   un endpoint OData v4 legacy (`/ODataV4/$metadata`, alcanzable con las
   mismas credenciales de servicio) que lista docenas de "web services"
   tipo Excel/Power BI ya publicados por DYNASOFT SRL, incluyendo varios
   basados en Purchase Header. Ahí aparece `DSNNo_Comprobante_Fiscal` —
   decodificando la conversión de nombres de BC a OData (calibrada contra
   un campo conocido: `"Buy-from Vendor No."` → `"Buy_from_Vendor_No"`) da
   el nombre AL real: **`"DSNNo. Comprobante Fiscal"`**.
2. **Segundo intento, mismo error `AL0132` pese al nombre correcto**: el
   campo lo agrega una extensión instalada (`DSLocalization`, DYNASOFT
   SRL) que es una dependencia *transitiva* de `Adsemble Liquid Base`
   (la única declarada en `app.json`) — AL no propaga visibilidad de
   dependencias transitivas, hay que declarar la dependencia directa.
   Encontrado en el propio log de `AL: Download Symbols` que Jonatan
   pegó (lista "propagated dependencies"). Agregada `DSLocalization`
   (`dc9f2114-cdfc-4bde-8c06-ac259a176816`, v1.1.2.64) a `app.json` — F5
   compiló limpio.
3. **Verificación real, no solo compilación**: probé escribiendo el NCF
   vía la API nueva (`PATCH .../purchaseInvoiceFiscals`) sobre la factura
   de prueba `CF-001921` y reintentando `Microsoft.NAV.post` — el error de
   NCF desapareció, pero salió **un segundo campo obligatorio distinto**:
   `"Specify Expense Class. Code for Document Type Invoice"` (clasificación
   de gasto para los reportes 606/607/608 de la DGII). Mismo método:
   encontrado `DSNCod_Clasificacion_Gasto` en el mismo metadata OData v4,
   decodifica a `"DSNCod. Clasificacion Gasto"` — confirmado con datos
   reales de órdenes de compra existentes (`Pedido_compra_Excel`, ya
   tienen valores como `"01"`, `"02"`, `"04"`). Agregado a la misma
   `page 58004` junto al NCF. Jonatan corrió `F5` una vez más, confirmado
   vía API (no solo por el log de VS Code, que no distingue compilar de
   publicar) que el campo nuevo ya respondía en el sandbox.

**Con el NCF y el Expense Class Code resueltos, apareció un tercer
bloqueo — pero este es de datos, no de código:** `"VAT Prod. Posting Group
must have value in Purchase Line... G/L Account 6107"`. La cuenta contable
`6107` (usada solo en la línea de prueba de `CP-000211`, un workaround de
la continuación 13) nunca tuvo configurado un grupo de IVA en el catálogo
de cuentas real. No es un campo faltante en la API — es una cuenta de
prueba mal configurada. No se persiguió más porque no bloquea facturas
reales contra cuentas ya configuradas correctamente, solo esta específica
de prueba.

**Cableado a la aplicación:** `bc-export-invoice` ahora escribe el NCF
automáticamente (`invoice_tax_number` → `fiscalDocumentNo`) en cada
exportación — probado en vivo por la UI real (botón "Exportar ahora", sin
ningún curl manual): `CF-001922` salió con `fiscalDocumentNo` correcto.
**El Expense Class Code NO se autocompleta a propósito** — es una
clasificación contable que depende de qué tipo de gasto es cada línea,
una decisión de Adsemble, no algo que el portal pueda inferir sin
arriesgarse a reportar mal a la DGII. Queda documentado en el código
(`bc-export-invoice/index.ts`) como pendiente de una regla antes de
automatizarlo.

**Efecto secundario bueno:** `app.json` nunca había subido de versión
(`1.0.0.0` desde el primer publish) — no había forma de distinguir en
Extension Management si un build nuevo realmente había llegado al
sandbox. Subida a `1.1.0.0` en este cambio; buena práctica mantenerla
subiendo en cada publish futuro.

**Con esto: el NCF ya no bloquea el posteo, automatizado de punta a
punta. El Expense Class Code también tiene el camino de API resuelto,
pendiente solo de una regla de negocio. El único bloqueo real que queda
para posteo 100% automático es de datos maestros (VAT Posting Group en
cuentas), no de código ni de integración.**

---

## 2026-08-20 (continuación 18) — Ciclo completo cerrado: primer posteo real y primer match de pago confirmado

Jonatan pidió "arregla todo, prueba todo end-to-end" — cerrar el bloqueo
de datos maestros que quedó pendiente (VAT Posting Group) y probar el
posteo real, no solo hasta donde llegó la continuación 17.

**Cuenta `6107 Servicios` corregida en el catálogo de cuentas real** (no
solo la de prueba — cualquier factura real contra esa cuenta tenía el
mismo problema): tenía **todos** los grupos de contabilización en blanco
(`Gen. Bus./Prod. Posting Group`, `VAT Bus./Prod. Posting Group`). Se
encontraron los valores correctos comparando contra otras cuentas de
servicio ya configuradas (`Alquiler`, `Legales`, `Reparación...`, todas
usan `NACGRDO` / `SERVGR18` / `GRDO 18` / `SERVGRAV18` — servicios
gravados al 18%) via el mismo endpoint OData v4 legacy que ya venía
usándose. Aplicado sobre `6107` — la línea de la factura, al recrearse,
calculó el ITBIS solo (RD$5,000 + 18% = RD$5,900).

**Segundo dato roto encontrado en el mismo intento:** el vendor de prueba
(`PROV-000278`) tampoco tenía **`Payment Method Code`** configurado —
mismo patrón que el `Gen. Bus. Posting Group` de la continuación 13
(vendor creado a las carreras, le faltaban campos que BC exige recién al
momento de postear, no de crear). Corregido asignándole `CREDITO` como
método de pago por defecto, igual que cualquier vendor real tendría.

**Con los 5 requisitos resueltos (NCF, Expense Class, VAT Posting Group,
Payment Method, fecha de posteo dentro del rango permitido), se reexportó
la factura de prueba por el botón real "Exportar ahora" del portal
(`CF-001923`) y se posteó con `Microsoft.NAV.post` — `HTTP 204`,
**primera factura real posteada de punta a punta desde este proyecto**.
BC renombró el documento a `CFR-001992` (confirma lo ya documentado en
continuación 12 sobre la renumeración draft→posteado) y generó un asiento
real en `vendorLedgerEntries` (`entryNo 39234`, `externalDocumentNo
E310000000001`, `amount -5900`).

**Corrido `bc-sync-payments` manualmente right after**: `matched: 1` —
la factura de prueba en Supabase quedó con `payment_source='bc'`,
`bc_ledger_entry_no=39234`, visible en `/payments` con "Origen: Business
Central". **Esto cierra el gap que quedó abierto desde la continuación
12** ("no se confirmó un match real todavía") — ya hay un match end-to-end
confirmado con una factura genuinamente posteada, no solo probado en
lógica/rendimiento.

**Cron de sincronización BC → Supabase, confirmado desde `crontab -l`:**
órdenes de compra cada 15 min, recepciones cada 15 min, pagos (vendor
ledger entries) cada 30 min, perfil de proveedores cada 6h (nunca invita
sola).

**Con esto, el ciclo completo (crear PO en BC → sync al portal →
confirmar como proveedor → subir factura con OCR → aprobar como admin →
exportar a BC con NCF/clasificación reales → postear en BC → sync de
pago de vuelta al portal) está probado de punta a punta, con datos
reales, sin ningún paso simulado.**

## 2026-08-24 (continuación 19) — Reset de password real y sync parametrizable, para la demo con Adsemble

Jonatan presenta avances en vivo al equipo de Adsemble mañana
(2026-08-25) y pidió confirmar tres cosas antes: que el superadmin pueda
crear usuarios/asignar roles/resetear passwords desde el panel (no a
mano), que los correos salgan bien, y que los intervalos de sync sean
parametrizables. Revisando el código encontré dos gaps reales: no había
botón de reset de password en `Users.tsx` (se hizo manual por script la
semana pasada, ver continuación 18 implícita del incidente de login), y
los intervalos de sync estaban fijos como entradas de `crontab`, sin
ningún camino de configuración. Aprovechamos también para aclarar que
todo lo probado hasta ahora es contra el sandbox `Test672026`, no
producción real de BC — decisión explícita de Jonatan mantenerlo así
para la demo.

**Reset de password real (`reset-user-password` Edge Function, nueva)**:
sigue el mismo patrón que `invite-user`/`delete-user` — valida
server-side que quien llama es `admin`/`superadmin` (nunca confía en el
cliente), busca el email real del usuario objetivo por `userId`, y llama
`auth.resetPasswordForEmail()` (no `admin.generateLink`, que solo
devuelve el link sin mandar el correo) — dispara el correo real vía SMTP
con la plantilla `recovery.html` ya de marca Adsemble, la misma que se
usó para el reset manual de Jonatan. Registra `password_reset_requested`
en `security_audit_log`. Botón nuevo "Resetear password" en
`Users.tsx`, junto a Editar — gateado a `admin`/`superadmin` igual que
Editar, con modal de confirmación que muestra a qué correo se mandó.

**Intervalos de sync parametrizables (`schema-v10.sql`)**: tabla nueva
`system_settings` (key, value_minutes, last_run_at) con los 4 valores
actuales como default (15/15/30/360 — ningún cambio de comportamiento al
desplegar). RPC `rpc_update_sync_interval(p_key, p_minutes)`,
`security definer`, exclusivo de superadmin — a diferencia de
`rpc_update_user_profile` (que confía en un `p_changed_by` mandado por
el cliente), usa `auth.uid()` directo, más seguro. Límite 5–1440
minutos. Registra `sync_interval_changed` en `security_audit_log`.

El piso real de granularidad sigue siendo el tick del sistema operativo,
no la tabla — así que el crontab del servidor se ajustó de
`*/15`/`*/15`/`*/30`/`0 */6` (uno por job) a un tick uniforme `*/5` en
los 4 jobs del portal (backup de Medisoft y uptime-check de DóndeTa en
el mismo crontab, sin tocar). Cada Edge Function de sync
(`bc-sync-orders`, `bc-sync-receipts`, `bc-sync-payments`,
`bc-sync-vendors`) ahora llama `shouldRun()`/`markRan()`
(`_shared/sync-throttle.ts`) al entrar/salir — si no le toca según
`system_settings`, responde `{ok:true, skipped:true}` sin tocar BC.
Verificado en vivo contra producción: primera llamada a `bc-sync-orders`
corrió y actualizó `last_run_at`; la segunda, inmediatamente después,
respondió `skipped:true` — confirma el throttle funcionando de punta a
punta antes de la demo. Nuevo panel "Intervalos de sincronización con
Business Central" en `Security.tsx` (superadmin), con la última corrida
de cada job y un campo editable en minutos.

**Desplegado a producción**: migración aplicada (`docker exec
supabase-db psql`), `rest` y `functions` reiniciados, frontend
reconstruido (`docker compose build app` + `up -d`), crontab
reinstalado con backup automático (`~/.cache/crontab/crontab.bak`).
`npm run build` (tsc + vite) limpio antes de desplegar.

**Pendiente de que Jonatan confirme en vivo mañana**: el flujo de reset
de password nunca se probó de punta a punta por la UI real (solo se
verificó que la función responde y rechaza tokens inválidos) — falta
clickearlo una vez con un usuario de prueba antes de mostrarlo al
equipo de Adsemble.

## 2026-08-25 — OCR: número de factura y total (además de fecha/NCF)

**Contexto:** Jonatan preguntó si el OCR podía leer también número de
factura y total, no solo fecha/NCF como hasta ahora. La infraestructura
ya estaba lista del lado de la tabla (`invoices.invoice_number` y
`invoices.total_amount` existen desde `schema.sql` original, y
`InvoiceDetail` ya los deja editar a mano) — faltaba solo la
extracción.

**`ocr-service/app.py`**: dos funciones nuevas, mismo patrón que
`extract_date`/`extract_ncf` (regex sobre el texto de Tesseract, nunca
un servicio de pago):
- `extract_invoice_number()` — a diferencia del NCF, el número de
  factura no tiene un formato fijo entre proveedores, así que **solo**
  se acepta si viene etiquetado explícitamente ("Factura No.", "No. de
  Factura", etc.) — sin fallback "a ciegas", para no capturar basura.
- `extract_total()` — recorre el texto línea por línea, de abajo hacia
  arriba (el total casi siempre va después del detalle), buscando
  líneas con "total" que excluyan "subtotal"/"ITBIS"/"impuesto"/
  "descuento"/"retención" (para no confundir el total a pagar con el
  total de impuestos o el subtotal). Prioriza etiquetas fuertes ("Total
  a Pagar", "Total General"). `_normalize_amount()` maneja ambos
  formatos de miles/decimales (RD suele mezclar "1.500,00" y
  "1,500.00" según el software que generó el PDF).

**`extract-invoice-data/index.ts`**: mismo patch condicional que ya
existía para fecha/NCF — solo escribe `invoice_number`/`total_amount`
si el campo sigue vacío (`""`/`0`, los defaults de `uploadInvoice` en
`domain.ts`), nunca pisa lo que el proveedor ya cargó a mano.

**Fuera de alcance a propósito**: las líneas de detalle
(`invoice_lines`). Con Tesseract puro (texto plano, sin posición/
bounding boxes por palabra) el parseo de tablas no es confiable entre
formatos de proveedor distintos — se prefirió no entregar algo poco
confiable en vez de fingir que funciona. Layout de detección: reader
de documentos con bounding boxes si se necesita esto más adelante.

**Verificado en vivo contra producción** (no solo revisión de código):
4 casos sintéticos corridos dentro del contenedor `ocr-service`
confirmaron los regex antes de desplegar (números con guion, coma
decimal, "Sub-Total" correctamente excluido del total). Después del
build+deploy, se corrió `extract-invoice-data` contra una factura real
de pruebas (`80aba901-...`, `qa-factura-realista.pdf`): extrajo y
escribió `total_amount = 5000.00` en la base real; no encontró número
de factura en ese PDF en particular (no trae la etiqueta) — se
confirmó que no inventó nada, se quedó `null` como se espera.

**Desplegado**: `docker compose build ocr-service && up -d` +
`docker compose restart functions`, ambos en
`/home/ubuntu/adsemble/supabase/`.

## 2026-08-25 (continuación) — Botón de descarga de factura + hallazgo de RLS en Storage

**Contexto:** Jonatan pidió un botón para descargar el PDF ya subido.
Se agregó `downloadInvoiceFile()` al store (URL firmada de 60s vía
`supabase.storage...createSignedUrl`, el bucket "invoices" es privado)
y un botón "Descargar PDF" en el header de `InvoiceDetail` —
justo donde ya se navega después de subir (`window.location.href =
/invoices/:id` en `handleFile`).

**Hallazgo al construirlo, no introducido por este cambio**: la única
política de `storage.objects` para el bucket `invoices` era
`"authenticated all invoices bucket"` (ALL, sin condición más allá de
`bucket_id = 'invoices'`) — cualquier usuario autenticado podía
leer/escribir el PDF de **cualquier** factura de **cualquier**
proveedor, a diferencia de la tabla `invoices` que sí estaba bien
acotada (`scoped read`/`scoped update`, por rol + vendor_id/company_id).
Se le preguntó a Jonatan si corregirlo ahora o después de la demo —
eligió ahora.

**`schema-v11.sql`**: reemplaza esa única política ALL por dos, en el
mismo espíritu que ya usa la tabla `invoices`:
- `insert own company invoices bucket` (INSERT) — el archivo se sube
  ANTES de que exista la fila en `invoices` (`uploadInvoice` en
  `domain.ts`: primero storage, después el insert), así que no se
  puede validar contra la fila todavía. Se valida en cambio contra el
  prefijo de carpeta del path (`${companyId}/...`, que `uploadInvoice`
  ya arma así) comparado con `portal_company_id()`.
- `scoped read invoices bucket` (SELECT) — hace `exists` contra
  `invoices.file_path = storage.objects.name` y aplica el mismo
  criterio de `portal_role()`/`portal_vendor_ids()`/`portal_company_id()`
  que ya usa la tabla. Rige también sobre `createSignedUrl` (la API de
  Storage evalúa esta misma política antes de firmar).
- UPDATE/DELETE se dejaron **sin política a propósito** — el frontend
  nunca los usa en este bucket, así que quedan denegados por default
  en vez de heredar alcance sin necesidad real.

**Riesgo detectado antes de aplicar, corregido en la misma migración**:
dos cuentas en `user_profiles` tenían `company_id` NULL — la cuenta QA
(`jonathanmaria+qa2026@gmail.com`) y, más grave, **un admin real de
Adsemble** (`c.cuevas@adsemble.do`). Con la política de INSERT nueva,
esa cuenta no habría podido subir facturas nunca más (el prefijo de
carpeta nunca iguala a `portal_company_id()` si este es NULL). Como
hoy solo existe una empresa en el sistema (`companies` tiene una sola
fila, Adsemble), se hizo backfill de `company_id` para ambas cuentas
antes de crear las políticas nuevas — sin ambigüedad posible sobre a
cuál empresa asignarlas.

**Verificado en vivo contra producción, simulando RLS real** (no solo
revisión de código): usando `set local role authenticated; set local
"request.jwt.claim.sub" = '<uuid>'` dentro de una transacción con
rollback, se confirmaron los 4 casos límite contra `storage.objects`
real:
1. El proveedor dueño de una factura SÍ ve su propio archivo.
2. Un proveedor distinto (otro `vendor_id`) NO lo ve — el hueco quedó
   cerrado.
3. Superadmin SÍ ve cualquier archivo (acceso global preservado).
4. `c.cuevas@adsemble.do` ya resuelve `portal_company_id()` a la
   empresa Adsemble después del backfill — su flujo de subida sigue
   funcionando.

**Desplegado**: migración aplicada con `docker exec supabase-db psql`;
no requiere reiniciar `rest` ni `functions` (la API de Storage evalúa
RLS por consulta, no cachea políticas). Frontend reconstruido
(`docker compose build app && up -d`) para el botón de descarga.

## 2026-08-25 (continuación 2) — Mensaje de éxito/error al subir + no duplicar factura por NCF

**Mensaje de éxito/error al subir** (`Invoices.tsx`): antes `handleFile`
no tenía `catch` — si `uploadInvoice` fallaba, la excepción quedaba sin
capturar (sin mensaje visible) y si funcionaba, la única señal era la
redirección silenciosa a `/invoices/:id`. Ahora: mensaje rojo junto al
botón "Subir factura" si falla, y un banner verde "Factura subida
correctamente" en el detalle vía `?uploaded=1` (se limpia de la URL al
leerlo, para que un refresh no lo repita).

**No duplicar factura por NCF** (pedido de Jonatan): el NCF (Número de
Comprobante Fiscal) es el identificador fiscal real ante la DGII —
único por proveedor, a diferencia de `invoice_number` que cada
proveedor arma como quiera. Mismo patrón de dos capas que
`schema-v5.sql` ya usó para `invoice_number`:
- `schema-v12.sql`: índice único `invoices_vendor_ncf_uq` en
  `(vendor_id, invoice_tax_number)`, ignorando filas con NCF vacío
  (sigue habiendo muchas mientras la factura es borrador y el OCR/el
  proveedor todavía no lo completó).
- `domain.ts:updateInvoiceData`: mismo chequeo explícito que ya existía
  para `invoice_number` (bloquea con mensaje claro antes de intentar
  guardar), ahora también por `invoice_tax_number`. Se dispara al
  confirmar la factura (`handleConfirm` en `Invoices.tsx`), que es
  donde ya se validaba el duplicado por número — no al momento de subir
  el PDF, porque el NCF todavía no se conoce en ese instante (lo llena
  el OCR después, o el proveedor a mano).

**Bloqueante encontrado al aplicar el índice**: ya existían 5 facturas
duplicadas en producción — 3 subidas ese mismo día por Jonatan
probando el botón de descarga con el mismo PDF
(`Factura_Adsemble_RD1180_NCF.pdf`, NCF `B0100000001`, las 3 en estado
`uploaded` sin confirmar) y 2 fixtures viejos de QA (NCF
`E310000000001`, uno `processed` y otro `uploaded`). Se le preguntó a
Jonatan si limpiar los sobrantes — confirmó que sí. Se borraron las 2
copias repetidas de hoy y el borrador QA sin confirmar, dejando un solo
registro por NCF (ninguno de los borrados estaba aprobado ni
exportado; `invoice_lines`/`invoice_status_history` tienen `on delete
cascade`, no quedaron huérfanos).

**Verificado en vivo contra producción** (no solo revisión de código):
tras crear el índice, un `INSERT` directo con el mismo `(vendor_id,
invoice_tax_number)` fue rechazado por Postgres
(`duplicate key value violates unique constraint
"invoices_vendor_ncf_uq"`); dos `INSERT` con NCF vacío para el mismo
proveedor sí se permitieron (confirma que los borradores sin NCF
siguen funcionando igual que antes). El mensaje amigable en la app
(`updateInvoiceData`) no se probó por la UI real — es exactamente el
mismo patrón ya usado y probado para `invoice_number`, solo con el
nombre de campo y el mensaje cambiados, pero falta el click real antes
de darlo por completamente confirmado.

**Desplegado**: `schema-v12.sql` aplicado con `docker exec supabase-db
psql`; frontend reconstruido (`docker compose build app && up -d`).

## 2026-08-25 (continuación 3) — Sin feedback visible al subir CP-000213

**Reporte de Jonatan**: subió la factura de la orden CP-000213 y no
vio ningún mensaje de éxito/error ni indicador de que estaba
subiendo. Se verificó en la base que la factura sí se creó bien
(`1d471c50-...`, NCF `B0100000002`, total `2360.00` extraído
correctamente por OCR) — el problema era puramente de UI, no de datos.

**Dos causas encontradas**:
1. `nginx.conf` no tenía `Cache-Control` explícito en `index.html` —
   el navegador podía quedarse sirviendo una versión vieja del bundle
   (sin el manejo de error/éxito agregado hoy) después de un redeploy,
   sin que el usuario lo notara. Se agrega `Cache-Control: no-cache`
   solo para `index.html` (los assets con hash siguen cacheando 30d
   normal, eso no cambia) para que cada carga revalide con el
   servidor.
2. El indicador de "subiendo" era solo el texto del botón cambiando a
   "Subiendo..." — fácil de no percibir, sobre todo con una subida
   rápida. Se reemplaza por un spinner + texto "Subiendo factura..."
   visible junto al botón, activo durante toda la duración real
   (subida a Storage + insert + llamada a OCR).

**Desplegado**: `docker compose build app && up -d`. Se le pidió a
Jonatan hacer un refresh forzado (Ctrl+Shift+R) una vez para
descartar que su navegador ya tuviera cacheada la versión vieja de
antes de este fix.

## 2026-08-25 (continuación 4) — Correo de reset sin cuerpo + login por RNC roto

**Correo de reset/invitación sin cuerpo**: Jonatan mandó captura — el
asunto ya salía bien en español, pero el cuerpo llegaba vacío, solo la
firma corporativa de Adsemble (logo, dirección, redes sociales). Se
revisó el archivo real dentro del contenedor `supabase-auth`
(`/etc/auth/templates/recovery.html`) — está perfecto, y los logs de
GoTrue muestran el envío completándose sin ningún error (`status:200`,
~2s). Conclusión: no es un bug de nuestro lado — el HTML completo sale
bien del servidor. Todo apunta a una regla de flujo de correo (Mail
Flow Rule / disclaimer) en el tenant de Office 365 de `adsemble.do`
para `soporte@adsemble.do` que **reemplaza** el cuerpo en vez de
agregarle la firma. Necesita revisión de quien administra el Exchange
Admin Center de Adsemble — fuera de lo que se puede tocar desde este
servidor. De paso se corrigió algo que sí estaba mal de este lado: el
asunto salía en inglés (`GOTRUE_MAILER_SUBJECTS_RECOVERY`/`_INVITE` no
estaban configurados) — ya quedó en español.

**Login por RNC/cédula no funcionaba**: reporte de Jonatan. Se
encontraron dos bugs reales probando en vivo contra los 3 vendors que
tienen usuario mapeado:
1. `resolve-login-identifier` comparaba el RNC ya normalizado (sin
   guiones) contra `vendors.tax_registration_number` **crudo** — BC
   casi siempre lo guarda con guiones (`131-00000-1`), así que la
   comparación casi nunca calzaba (de los 3 vendors probados, solo uno
   funcionaba, por casualidad, porque BC no le puso guiones a ese
   RNC). Se agrega `vendors.tax_registration_number_digits`, columna
   **generada** (siempre en sync, sin depender de que nadie normalice
   nada al escribir) y se compara contra esa en vez del texto crudo.
2. El vendor de pruebas `df41c0e0` (RNC `00118863612`, el de Jonatan)
   tenía **dos** filas `is_primary=true` en `user_vendor_mapping`
   (`jonathanmaria+proveedor@` y `jonathanmaria+qa2026@`, de sesiones
   de QA distintas). La función usa `.maybeSingle()`, que falla
   silenciosamente con más de una fila — ese login caía siempre a "no
   encontrado" aunque el vendor y el mapping existieran. Se dejó una
   sola primaria (`jonathanmaria+proveedor@gmail.com`) y se agrega un
   índice único parcial (`user_vendor_mapping_one_primary_per_vendor_uq`)
   para que esto no pueda repetirse con ningún vendor.

**Verificado en vivo contra producción** (no solo revisión de código):
los 3 RNCs reales, con y sin guiones, resuelven al correo correcto
después del fix — antes, 2 de los 3 fallaban.

**Desplegado**: `schema-v13.sql` aplicado con `docker exec
supabase-db psql`; `resolve-login-identifier` redesplegado
(`docker compose restart functions`).

## 2026-08-25 (continuación 5) — Primeros usuarios `approver` + bug de companyId nulo

**Primeros usuarios con rol `approver` del sistema**: Jonatan pidió
crear a los 4 de "Usuarios Revisión y Aprobación" (imagen que mandó) —
Lorenny Frías, Yessica Medina, Leidy Aquino, Verónica Tejeda, las 4
`@adsemble.do`. Hasta ahora solo existían `admin` (`c.cuevas@`) y
`superadmin` (Jonatan) — nunca se había probado un `approver` real.
Creadas vía `auth/v1/invite` (Admin API, mismo mecanismo que
`invite-user`) + `user_profiles` (`role='approver'`,
`company_id`=Adsemble) + `security_audit_log`, replicando exactamente
lo que hace `provisionInvitedUser` — no se pasó por la Edge Function
porque hacerlo desde la app hubiera requerido el JWT de sesión de
Jonatan, no disponible desde aquí. Como el correo de invitación tiene
el mismo problema de Office 365 (ver arriba), se generaron enlaces
directos (`admin/generate_link`, `type=invite`,
`redirect_to=/set-password`) para que cada una pusiera su contraseña
sin depender del correo.

**Bug real encontrado al probar la primera aprobadora**: Lorenny
entró bien, pero "Aprobaciones pendientes" no mostraba nada pese a
haber una factura en `pending_approval` para Adsemble
(`1d471c50-...`). Se descartó RLS/datos simulando su sesión real
contra Postgres (`set local "request.jwt.claim.sub"`) — la fila SÍ es
visible a nivel de base para su rol/empresa. El bug estaba en
`App.tsx`: `session.companyId` se poblaba **solo** desde
`user_vendor_mapping` (tabla que únicamente tiene filas para
`supplier`/`service_uploader`), nunca desde
`user_profiles.company_id` directamente — cualquier `approver` sin
mapping de proveedor (todos los casos reales) terminaba con
`companyId = null`. `Approvals.tsx` filtra estrictamente por
`inv.companyId === session.companyId`, sin un "si es null, mostrar
todo" como sí tiene la rama de admin en otras pantallas — por eso la
lista salía vacía en vez de fallar más ruidosamente. Corregido:
`companyId` ahora sale de `user_profiles.company_id` primero, con el
mapping de proveedor solo como respaldo.

**Alcance del bug**: no era exclusivo de Lorenny — afectaba a
cualquier `approver` (y, por la misma lógica, a `admin`/`superadmin`
en cualquier pantalla que dependiera de `session.companyId` sin la
rama especial "admin ve todo"). Nunca se había notado porque hasta
hoy no existía ningún usuario `approver` real para probarlo.

**Desplegado**: `docker compose build app && up -d`.

## 2026-08-25 (continuación 6) — Piso de sync a 1 minuto + usuarios approver/superadmin adicionales

**Piso de sync bajado de 5 a 1 minuto**: pedido en vivo de Jonatan
tras ver que una orden de compra recién creada en BC no aparecía de
inmediato. Dos partes: `schema-v14.sql` baja la validación de la RPC
(`rpc_update_sync_interval`) de "5-1440" a "1-1440"; el tick del
crontab del servidor se bajó a mano de `*/5` a `* * * * *` en las 4
líneas del portal (no versionado, mismo patrón que el cambio de
schema-v10.sql). Aplicado: órdenes y recepciones a 1 minuto, pagos a
15, proveedores a 3 horas. Verificado en vivo esperando dos corridas
reales del crontab (`last_run_at` avanzó de 19:28 a 19:30).

**Usuarios adicionales creados** (mismo mecanismo que los 4
approvers): `w.deschamps@adsemble.do` como segundo `superadmin`
(agregado, no reemplaza a Jonatan — confirmado explícitamente).

**Aprobadores ahora pueden exportar a BC** (`FeatureGuard.tsx`):
`exports.read` era exclusivo de admin/superadmin; se agrega a
`approver` — puede aprobar y exportar lo que aprobó, sin depender de
un admin para el segundo paso.

**Bug real de OCR encontrado y corregido**: Jonatan reportó "no está
cargando o leyendo la factura correctamente". Se depuró con una
Edge Function temporal (`debug-ocr`, creada y borrada en la misma
sesión) que baja el PDF real de Storage y llama al `ocr-service`
directo, para ver el texto crudo sin pasar por `extract-invoice-data`.
Dos bugs reales en el texto de una factura real
(`Factura_Servicios_RD10620.pdf`):
1. El patrón de número de factura saltaba desde el título "FACTURA"
   hasta el "No." de la etiqueta real ("NO. DE FACTURA", en otra
   línea) y capturaba la palabra "DE" en vez del número. Corregido con
   un lookahead que exige al menos un dígito en el valor capturado.
2. Fechas escritas en letras ("25 de agosto de 2026") no se leían —
   solo se soportaba formato numérico. Se agrega un patrón para fechas
   en español (`SPANISH_DATE_PATTERN`).

Verificado antes/después del fix contra el texto real y contra los
casos previos (sin regresión). La factura afectada que ya tenía el
número mal guardado (`4710b117-...`, "DE") no se pudo corregir a mano
porque el número correcto ya lo tenía otra copia de la misma factura
ya confirmada (`10357815-...`, la versión "_corregida" con NCF) — son
la misma factura subida dos veces; la original queda como borrador
obsoleto, se puede ignorar o borrar.

**Desplegado**: `docker exec supabase-db psql` (schema-v14.sql),
`docker compose build app && up -d` (Security.tsx, FeatureGuard.tsx),
`docker compose build ocr-service && up -d` (fix de OCR).

---

## 2026-08-26 — Plan de observaciones de usuarios finales + Fase 1/3/4

**Contexto:** Jonatan trajo 11 observaciones de los consumidores finales del
portal (proveedores y equipo interno) tras la demo en vivo. Antes de tocar
código se armó un plan de desarrollo (artefacto HTML) contrastando cada
punto contra el código real, no contra suposiciones. Dos de los puntos
necesitaban que Jonatan definiera la regla de negocio antes de programar:

1. **Corte de facturación día 25**: confirmado que ES un bloqueo, no una
   reclasificación automática — fecha de factura con día > 25 se rechaza
   pidiendo reenviar con fecha del mes siguiente.
2. **Proveedores informales/extranjeros, NCF opcional**: Jonatan aclaró que
   la categoría ya existe en el módulo de proveedores de BC. Se confirmó en
   vivo contra el sandbox (vía `vendorPostingSetups`, la misma API custom
   que ya se usaba para el NCF fiscal): el campo `vendorPostingGroup` ya
   tiene exactamente los códigos que Jonatan mencionó, configurados en los
   3,494 proveedores reales — `CPPROV` (2,070, formal), `PROVINFORM` (1,174,
   informal), `INT` (144, extranjero), `CXPRELAC` (9, relacionadas, fuera de
   alcance por ahora). No hizo falta inventar ningún numerador nuevo.

**Implementado (Fase 1 + 3 + 4 del plan):**

1. **Validación server-side real al confirmar factura** — hasta ahora
   "Confirmar datos" (sección "Acciones", `Invoices.tsx`) llamaba al RPC
   genérico `rpc_update_invoice_status`, que no valida nada; toda la
   obligatoriedad de fecha/NCF/número/total vivía solo en el formulario y
   era saltable llamando el RPC directo. Nuevo RPC
   `rpc_confirm_invoice_for_approval` (`schema-v15.sql`) re-valida el
   estado ACTUAL de la fila antes de permitir el paso a
   `pending_approval`: número de factura obligatorio (antes no se exigía),
   fecha obligatoria y con día ≤ 25, total > 0, y NCF obligatorio *excepto*
   cuando el proveedor es `PROVINFORM` o `INT`. Mismo patrón de
   autorización que `rpc_confirm_purchase_order`/`rpc_mark_invoice_paid`
   (rol admin/superadmin o dueño vía `user_vendor_mapping`). Probado en
   vivo con `begin;...rollback;` contra datos reales: 5 casos (informal sin
   NCF → pasa; fecha 27 → rechaza; número vacío → rechaza; formal sin NCF →
   rechaza; usuario de otro proveedor → rechaza), los 5 con el resultado
   esperado.
2. **`vendors.vendor_posting_group`** — columna nueva, sincronizada en
   `bc-sync-vendors` desde `vendorPostingSetups` (antes solo se traía
   `number/displayName/taxRegistrationNumber/email/blocked` de la API
   estándar de `/vendors`). Sync corrido en vivo: 3,494 proveedores, conteos
   por grupo verificados que coinciden exactamente con BC.
3. **`bc-export-invoice`** — el bloqueo de NCF obligatorio ahora es
   condicional al `vendor_posting_group`; si es `PROVINFORM`/`INT` se
   omite también el PATCH a `purchaseInvoiceFiscals` (antes se hacía
   incondicional, habría fallado con NCF vacío).
4. **Formato de subida ampliado a PDF + foto** — `accept` del input en
   `Invoices.tsx` y validación de tipo en `uploadInvoice` (domain.ts) ahora
   permiten `application/pdf`, `image/jpeg`, `image/png` (antes solo PDF).
   `ocr-service/app.py` ahora rama por `Content-Type`: imagen se lee
   directo con Tesseract, PDF sigue rasterizándose con `pdf2image` como
   antes. `extract-invoice-data` decide el `Content-Type` a mandar según la
   extensión real del archivo. Probado en vivo: imagen sintética (texto
   borroso a propósito) extrae fecha correctamente sin error — confirma que
   la rama de imagen corre bien end-to-end; PDF real re-testeado sin
   regresión (mismo resultado exacto que el fix de ayer).
5. **Popup de resultado en Monitor de Exportaciones** (`Exports.tsx`) — antes
   "Exportar ahora" no daba ningún feedback inmediato (había que refrescar y
   leer el estado). Ahora `exportInvoice` devuelve `{bcInvoiceNumber,
   attached}` y se muestra un modal de éxito/error al instante.
6. **NCF opcional en el formulario del proveedor** — la sección "Acciones"
   ahora sabe si el proveedor de la factura es informal/extranjero
   (`supplier.vendorPostingGroup`) y marca el campo NCF como opcional en la
   UI, coherente con la validación del servidor.

**Desplegado**: `psql` (schema-v15.sql) + restart `rest`; `docker compose
restart functions` (bc-sync-vendors, bc-export-invoice,
extract-invoice-data); `docker compose build ocr-service && up -d`;
`docker compose build app && up -d` (tsc limpio). Verificado que el bundle
en producción sí trae las cadenas nuevas.

**Pendiente al cierre de esta entrada:** selector de orden de compra al
subir factura, visualización embebida de la factura, y la UI del
acumulado facturado — resuelto en la Fase 2, ver abajo. Sigue abierto el
tratamiento de `CXPRELAC` (9 proveedores) y el "Expense Class Code" de BC
(ver sesión anterior).

---

## 2026-08-26 (continuación) — Fase 2: vincular factura ↔ orden de compra

**Hallazgo antes de programar:** `OrderDetail.tsx` (vista de una orden
específica, `/orders/:id`) YA tenía un flujo de subida que sí manda
`purchaseOrderId: order.id` (línea `handleFile`) y YA mostraba la lista de
facturas vinculadas a esa orden sin restricción de una sola — el soporte
para varias facturas por orden ya existía ahí, no hubo que construirlo
desde cero. Lo único roto en ese flujo era el mismo bug de formato que se
arregló ayer en la lista general (`accept="application/pdf,.pdf"` sin
fotos) — corregido.

El hueco real estaba en el botón "Subir factura" de la lista general de
facturas (`Invoices.tsx`, el más visible/usado): mandaba `purchaseOrderId:
null` siempre, sin preguntar, así que cualquier factura subida desde ahí
quedaba "Sin vincular" sin que el proveedor lo decidiera.

**Implementado:**

1. **Selector de orden obligatorio cuando aplica** — en la lista general de
   facturas, si el proveedor tiene órdenes propias en estado `open` o
   `partially_invoiced`, aparece un selector antes de poder elegir el
   archivo (incluye la opción explícita "Sin orden de compra" — nunca se
   asume en silencio). Si no tiene ninguna orden abierta, el flujo queda
   igual que antes (sin selector, sin orden).
2. **Corrección de un bug real de cálculo con varias facturas por orden**
   — la validación de "el total no puede superar el monto de la orden"
   (`domain.ts:updateInvoiceData`) comparaba solo la factura actual contra
   el monto completo de la orden. Con varias facturas sobre la misma
   orden, eso dejaba pasar un total combinado mayor al de la orden. Ahora
   suma las demás facturas de esa orden (excluyendo las rechazadas) antes
   de comparar.
3. **Visibilidad del acumulado** — tanto en la ficha de la factura
   ("Acciones") como en la ficha de la orden (lista de facturas
   vinculadas) se muestra "Facturado: X de Y · Disponible: Z" cuando hay
   más de una factura sobre la misma orden.

**No incluido en esta fase** (fuera del alcance original del punto #3 del
plan): visor embebido de la factura dentro del portal — sigue existiendo
solo la descarga (botón "Descargar PDF"). Se puede agregar en una próxima
vuelta si Jonatan lo pide.

**Desplegado**: `docker compose build app && up -d` (tsc limpio, sin
errores). Verificado que el bundle trae las cadenas nuevas ("Selecciona la
orden de compra", "Ya facturado", "Sin orden de compra"). Confirmado en
producción que hay 15 órdenes reales en estado `open` — el selector tiene
datos reales que mostrar, no es solo teórico.

---

## 2026-08-29 — QA exhaustivo de Fase 1-4 + bug real encontrado y corregido

**Contexto:** a pedido de Jonatan ("has todas las pruebas desde cero para ir
mirandolas"), se corrió `/qa` de forma exhaustiva sobre las Fases 1-4 —
17 casos de prueba individuales contra producción real (no simulados), cada
uno con captura de pantalla, subiendo PDFs y una foto JPG reales.

**Bug encontrado (severidad alta):** el popup de "Exportar ahora"
(`Exports.tsx`, construido en la Fase 1 de esta misma sesión) mostraba el
mensaje genérico "Edge Function returned a non-2xx status code" en vez del
motivo real del error ("Sin orden de compra vinculada", etc.). Causa raíz:
`supabase-js` (`functions.invoke()`) nunca parsea el cuerpo JSON de una
respuesta HTTP no-2xx — lo envuelve en un `FunctionsHttpError` genérico; el
mensaje real vive en `error.context` (el `Response` crudo) y hay que leerlo
a mano con `.json()`. Como `bc-export-invoice` reporta **todos** sus errores
de negocio (orden sin vincular, sin `bc_id`, sin NCF, fallo de BC, etc.) con
status no-2xx, el popup nunca mostró el motivo real para ningún fallo —
solo parecía funcionar en los QA anteriores porque esos solo probaron el
camino exitoso.

**Autocorrección durante el fix:** el primer intento de arreglo tenía su
propio bug — el `throw new Error(body.error)` quedó dentro del mismo `try`
cuyo `catch` lo silenciaba, así que seguía sin mostrar el mensaje real tras
el primer redeploy. Se diagnosticó inyectando un hook de `window.fetch` en
la página real para confirmar que la respuesta HTTP cruda ya traía el
mensaje correcto (`422`, `{"ok":false,"error":"Sin orden de compra
vinculada"}`), lo que aisló el bug al código cliente y no a la Edge
Function. Corregido separando el parseo (dentro de `try/catch`) del `throw`
(fuera de el).

**Verificado tras el fix (regresión):** se re-probó el camino de
exportación exitosa completo (proveedor sin NCF, con orden real, PDF
adjunto) para confirmar que el fix no rompió nada — creó
`CF-001929` en Business Central correctamente.

**Los otros 16 casos de prueba pasaron sin hallazgos**, incluyendo un caso
de borde nuevo no cubierto en QA anteriores: una orden ya facturada al
100% de su presupuesto, donde el guardia de acumulado de la Fase 2 sigue
bloqueando correctamente cualquier monto adicional.

**Desplegado**: `docker compose build app && up -d` (dos veces — el primer
intento de fix, luego la corrección real). Reporte completo en
`.gstack/qa-reports/qa-report-proveedores-jfmcss-com-2026-08-29.md`.

---

## 2026-08-29 (continuación) — Multiempresa: Fase 1 (fundamento de esquema)

**Contexto:** Jonatan preguntó si el portal puede manejar las demás empresas
que Adsemble tiene en Business Central. Se consultó el tenant real de BC
(`Test672026`) en vivo, no documentación: 15 empresas en el entorno, cada
una con su propia tabla de proveedores completamente aislada (BC no
comparte maestro de proveedores entre empresas). 11 de esas 15 empresas
comparten hoy el mismo listado de proveedores que Adsemble (mismo
`PROV-000001` = "REVESTIDA SRL" en las 11) — evidencia de que el sandbox se
armó copiando la data de Adsemble varias veces. Jonatan confirmó el alcance:
**las 11 empresas con listado compartido**, excluyendo LIQUID INC (proveedores
propios y distintos), Empresa Modelo (plantilla demo de Microsoft) y
Evolutier/Evolutier SRL (sin datos). Se armó un plan de 6 fases (artefacto
publicado) y se aprobó arrancar por la Fase 1.

**Diagnóstico que definió el trabajo:** `vendors` no tenía NINGUNA columna
de empresa — lista global plana. Sin esto, el mismo `vendor_number` en dos
empresas distintas se habría mezclado en un solo registro del portal en
cuanto se conectara la segunda empresa — y con 11 empresas compartiendo
numeración hoy, era garantía de que iba a pasar, no un riesgo hipotético.

**Implementado (`schema-v16.sql`):**
1. `vendors.company_id` (NOT NULL, FK a `companies`) — backfill a Adsemble
   para las 3,495 filas existentes (3,494 sincronizadas de BC + el
   proveedor de prueba manual "Suplidor de Prueba"), única empresa
   conectada hasta ahora.
2. Reemplazado el índice único global `vendors_vendor_number_uq`
   (schema-v8.sql, del incidente de invitaciones masivas) por
   `vendors_company_vendor_number_uq` en `(company_id, vendor_number)` —
   el mismo número ya es legítimamente distinto entre empresas.
3. **`companies` no necesitó ningún cambio de esquema**: `bc_code` ya
   guarda el GUID real de la empresa en BC (confirmado: la fila de Adsemble
   tiene `bc_code` = el mismo valor que `BC_COMPANY_ID`), y `disabled_at`
   ya sirve como flag activa/inactiva. Las filas de las otras 10 empresas
   en alcance se agregan en la Fase 2, junto con el loop de sincronización
   real — no tenía sentido que aparecieran en el portal antes de que el
   backend pudiera procesarlas.

**Código corregido (los únicos 2 lugares que escriben en `vendors`):**
- `bc-sync-orders/resolveVendorId`: matcheaba/creaba proveedores solo por
  `vendor_number`. Ahora matchea por `(vendor_number, company_id)` y
  guarda `company_id` al crear uno nuevo.
- `bc-sync-vendors`: el upsert en bloque ahora incluye `company_id` en
  cada fila y usa `onConflict: "company_id,vendor_number"` (antes
  `"vendor_number"` solo). El chequeo de "cuáles ya existían" (para no
  invitar de nuevo a proveedores ya conocidos) ahora también filtra por
  `company_id` — antes habría marcado como "ya existente" a un proveedor
  de otra empresa con el mismo número.

**Verificado en vivo tras desplegar:** corridas reales de ambas funciones
contra Adsemble — `bc-sync-vendors` procesó 3,494 proveedores sin error de
conflicto (confirma que el nuevo índice funciona con el upsert),
`bc-sync-orders` procesó 15 órdenes / 27 líneas sin error. Después de
ambas corridas: 3,495 filas en `vendors` (sin cambio, cero duplicados
creados), 0 filas con `company_id` nulo, sin `vendor_number` repetidos.

**Alcance de esta fase, a propósito:** no se tocó `bc-client.ts` (sigue
leyendo una sola empresa por variable de entorno), no se agregaron las
otras 10 empresas a `companies`, no se tocó login/RLS/frontend. Eso es
Fase 2 en adelante — la Fase 1 solo garantiza que el esquema y los 2
escritores existentes ya no rompan cuando se conecte la segunda empresa.

**Desplegado**: `psql` (schema-v16.sql) + restart `rest`; `docker compose
restart functions` (bc-sync-orders, bc-sync-vendors).

---

## 2026-08-29 (continuación) — Multiempresa: Fase 2 (cliente de BC + sincronización multiempresa)

**Implementado:**

1. **`bc-client.ts`** — `BC_COMPANY_ID` dejo de ser variable de entorno.
   Las 5 funciones exportadas (`bcGet`, `bcGetAll`, `bcPost`, `bcPatch`,
   `bcAttachFile`) ahora reciben el GUID de la empresa como primer
   argumento. El tenant/credenciales de Azure AD siguen siendo
   compartidos (confirmado en vivo: un solo token sirve las 15 empresas).
2. **`_shared/companies.ts`** (nuevo) — `getActiveCompanies(db)`, unico
   punto que decide que empresas procesa cada sync (`disabled_at is
   null`, mismo campo que ya existia, sin columna nueva).
3. **Las 4 funciones de sync** (`bc-sync-vendors`, `bc-sync-orders`,
   `bc-sync-receipts`, `bc-sync-payments`) ahora iteran sobre las
   empresas activas en vez de resolver una sola. Un solo throttle por
   corrida (no uno por empresa) — como el loop procesa todas las
   empresas activas dentro de la misma invocacion, no hay una marca de
   tiempo compartida que puedan pisarse entre si; se descarto la idea
   original del plan de throttles por empresa por innecesaria.
4. **`bc-sync-payments`** — hallazgo nuevo durante esta fase: el matching
   de facturas por NCF/numero no filtraba por `company_id` en absoluto
   (la funcion nunca habia resuelto una empresa). Con empresas que
   comparten NCFs (como ya pasa hoy), esto podia marcar como pagada la
   factura de la empresa equivocada. Corregido junto con el loop.
5. **`bc-export-invoice`** — no es un sync programado, es por-factura.
   Resuelve el GUID de BC a partir de `purchase_orders.company_id` ->
   `companies.bc_code`, no de una variable de entorno.
6. **`schema-v17.sql`** — se agregaron las 10 empresas restantes en
   alcance a `companies`, con sus GUID reales confirmados contra BC.
   Insertadas **deshabilitadas** (`disabled_at = now()`) a proposito: el
   loop ya esta listo para procesarlas, pero activar las 10 de golpe
   sincroniza decenas de miles de filas de una vez sin que nadie lo haya
   pedido todavia.

**Verificado en vivo:**
- Las 4 funciones de sync corridas contra Adsemble (unica empresa activa)
  dieron resultados identicos a las corridas pre-Fase 2 — sin regresion.
- `bc-export-invoice` re-exportado sobre una factura real
  (FAC-2026-0825-001) para probar la resolucion de empresa vía
  `order.company_id` -> `companies.bc_code` — creo `CF-001930` en BC
  correctamente, PDF adjunto.
- **Prueba supervisada de 2 empresas reales:** se activo DUCKTAPE
  temporalmente, se corrio `bc-sync-vendors` (`companiesProcessed: 2`,
  3,494 + 3,474 proveedores procesados por separado), se confirmo que
  `PROV-000001` ahora existe como 2 filas distintas (una por empresa,
  ambas "REVESTIDA SRL") sin colision -- exactamente el escenario que la
  Fase 1 estaba diseñada para resolver. **DUCKTAPE se volvio a
  deshabilitar despues de la prueba** (sigue con sus 3,474 proveedores ya
  sincronizados en la base -- no se borraron, solo la empresa vuelve a
  estar oculta del selector hasta que se pida activarla de verdad).

**Pendiente, a proposito:** activar las demas empresas una por una (o
todas) queda a decision de Jonatan -- el mecanismo ya esta probado.
Login/RLS/frontend (Fases 3-6 del plan) siguen sin tocar.

**Desplegado**: `psql` (schema-v17.sql); `docker compose restart
functions` (bc-client.ts, companies.ts, las 4 funciones de sync,
bc-export-invoice).

---

## 2026-08-29 (continuación) — Multiempresa: Fase 3 (login/identidad multiempresa)

**Decision de Jonatan:** una sola cuenta de portal por proveedor real,
aunque le facture a varias empresas -- el vinculo entre empresas se
agrega **automatico, sin aprobacion manual** cuando se detecta el mismo
RNC en otra empresa (mas rapido para el proveedor; el riesgo es menor que
el incidente del 20 de agosto porque esto nunca manda correo ni crea
usuario nuevo, solo agrega una fila de acceso a una cuenta que ya existe
y ya fue verificada al invitarla la primera vez).

**Implementado:**

1. **`bc-sync-vendors` — auto-vinculo por RNC.** Cuando un proveedor
   recien creado en una empresa comparte RNC con un proveedor de OTRA
   empresa que ya tiene cuenta de portal, se agrega una fila en
   `user_vendor_mapping` (mismo usuario, nueva empresa/vendor_id) --
   nunca se manda correo ni se crea usuario. Si el RNC coincide con
   **mas de una** cuenta distinta (dato inconsistente real, ej. dos
   personas con el mismo RNC por error de captura), no se adivina: se
   deja sin vincular y se loguea para revision manual.
2. **`resolve-login-identifier`** dejo de asumir "un RNC = un vendor" en
   todo el sistema. Ahora busca TODAS las filas de `vendors` con ese RNC
   (una por empresa), junta los usuarios primarios mapeados a cualquiera
   de ellas, y solo entra si hay exactamente UN usuario distinto. Si hay
   mas de uno, rechaza con el mismo mensaje generico de siempre (no
   revela la ambiguedad al cliente) mientras loguea el conflicto
   server-side para que un admin lo revise.

**Bug real encontrado y corregido en el camino:** `.in(col, [...])` de
supabase-js codifica la lista como query string en la URL -- con una
empresa grande (~3,400 vendor_number nuevos de una vez, el caso normal al
activar una empresa por primera vez) la URL supera el limite del proxy y
responde "414 URI too long" en vez del error real. El mismo patron sin
batch ya existia en el bloque de invitaciones (`vendorIdRows`), pero
nunca habia corrido con una empresa grande antes de esta fase. Corregido
con batches de 200 en los 4 `.in()` de la funcion.

**Verificado en vivo, los 3 escenarios reales:**
- Activando JUAN FABIAN (nunca sincronizada, ~3,472 proveedores nuevos)
  sin ningun RNC compartido con cuenta existente: `autoLinked: 0`, sin
  error -- confirma que el fix del URI-too-long realmente resolvio el
  bug (antes de corregirlo, esta misma corrida fallaba).
- Caso montado a proposito: se le dio a Adsemble/PROV-000001 una cuenta
  de prueba, se borro su fila equivalente en JUAN FABIAN (para que
  volviera a verse "nueva"), se re-corrio el sync -> `autoLinked: 1`,
  confirmado en la base que la fila nueva de JUAN FABIAN quedo mapeada a
  la MISMA cuenta. `resolve-login-identifier` con ese RNC devolvio el
  correo correcto.
- Caso ambiguo montado a proposito: se agrego una SEGUNDA cuenta distinta
  al mismo RNC (en DUCKTAPE) -- `resolve-login-identifier` rechazo con el
  mensaje generico de siempre (no version distinta que revele el
  conflicto) y quedo el log server-side: "RNC ...: 2 cuentas de portal
  distintas mapeadas -- login ambiguo, revisar user_vendor_mapping".
- Toda la data de estas pruebas montadas se borro despues; JUAN FABIAN
  volvio a quedar deshabilitada. Solo Adsemble sigue activa en
  produccion, igual que antes de esta fase.

**Pendiente, a proposito:** Fases 4-6 del plan (RLS multiempresa real,
selector de empresa en el frontend, columna "Empresa" en las vistas de
admin) siguen sin tocar -- hoy con una sola empresa activa no hacen
falta todavia.

**Desplegado**: `docker compose restart functions` (bc-sync-vendors,
resolve-login-identifier).

---

## 2026-08-29 (continuación) — Multiempresa: Fase 4 (RLS) + Fase 5 (selector de empresa)

**Hallazgo antes de programar Fase 4:** la mayoría de las tablas de datos
(`invoices`, `purchase_orders`, `purchase_orders_lines`, etc.) YA estaban
bien para multiempresa del lado del proveedor — su RLS usa
`portal_vendor_ids()` (schema-v3.sql), que ya es un `SETOF` desde
`user_vendor_mapping` y por lo tanto ya cubre todas las empresas a las
que un proveedor está vinculado. Lo único atado a una sola empresa
(`portal_company_id()`, un escalar) era: (1) `companies` — qué empresas
puede *listar* el usuario, necesario para el selector; y (2) el INSERT
de Storage al subir una factura — validaba el prefijo de carpeta contra
`portal_company_id()` únicamente, así que un proveedor subiendo a su
segunda empresa habría sido rechazado ahí aunque todo lo demás ya lo
permitiera.

**Implementado (`schema-v18.sql`):**
- `portal_company_ids()` — nueva función, unión de las empresas del
  usuario vía `user_vendor_mapping` + su `user_profiles.company_id`
  (cubre tanto proveedores como staff interno).
- Política `companies` reescrita para usar el conjunto, no el escalar.
- Política de INSERT del bucket `invoices` reescrita igual.
- Las políticas de `approver` (scoped por `portal_company_id()` en
  invoices/purchase_orders/lectura de Storage) se dejaron **tal cual** a
  propósito — no hay pedido de que un aprobador interno revise varias
  empresas a la vez.

**Implementado (Fase 5, frontend):**
- `SessionState` ahora guarda `vendorMappings` (todas las filas de
  `user_vendor_mapping` del usuario, no solo la primera).
- `useSessionStore` gana `setActiveCompany()`: al cambiar de empresa,
  recalcula `supplierId` a partir del `vendor_id` que le corresponde a
  esa empresa (BC no comparte proveedores entre empresas, así que un
  mismo proveedor real tiene un `vendor_id` distinto por cada una). No
  hace falta volver a pedir datos — `invoices`/`purchase_orders` ya
  llegaron con todas las empresas del usuario, las páginas ya filtran
  por `session.supplierId`/`companyId` en un `useMemo`.
- `App.tsx` puebla `availableCompanies` de verdad (antes vacío). Para
  admin/superadmin se agrega una opción sintética "Todas las empresas" al
  principio, y arrancan ahí por defecto — preserva el comportamiento que
  ya tenían.
- Selector de empresa nuevo en `AppShell.tsx` (solo visible si hay más de
  una opción — la mayoría de los usuarios hoy no lo ven, nada cambia para
  ellos).

**Bug real encontrado en vivo (no en teoría):** la consulta de empresas
de `App.tsx` heredó el `.is("disabled_at", null)` del fetch general de
`domain.ts`, pensado para "no listar empresas sin activar". Pero
`disabled_at` controla si `bc-sync-*` procesa esa empresa, **no** si un
usuario que ya tiene un vínculo real a ella puede seguir viéndola en su
propio selector — con una empresa vinculada pero pausada, el usuario
simplemente no la veía en su selector aunque RLS sí lo dejara. Corregido
quitando ese filtro específicamente en `App.tsx` (el de `domain.ts` se
deja igual, es para el listado general de admin).

**Verificado en vivo, extremo a extremo (no simulado):**
- RLS: un proveedor con 1 sola empresa ve 1; con 2 empresas reales
  (montadas a propósito) ve exactamente esas 2; admin ve las 11.
- Storage INSERT: simulado el predicado exacto contra las 2 empresas del
  proveedor (ambas `true`) y una empresa random (`false`).
- **Con el navegador real**: logueado como el proveedor de prueba con 2
  empresas, el selector apareció, se cambió a DUCKTAPE (sin recargar la
  página — cambio 100% client-side), y se subió un PDF real — quedó en
  la base con `company_id` de DUCKTAPE y el `file_path` en la carpeta
  correcta. Confirma que el fix de Storage funciona con el flujo real de
  la app, no solo en la simulación SQL.
- Logueado como admin: dashboard mostró "Company: Todas las empresas" y
  la factura recién subida en DUCKTAPE apareció junto a las de Adsemble
  — confirma el default de admin.
- Toda la data de prueba (factura, PDF, mappings temporales) se limpió
  después. Solo Adsemble sigue activa en producción.

**Pendiente, a propósito:** Fase 6 (columna "Empresa" en las vistas de
admin, para distinguir filas cuando haya de verdad más de una empresa
con data real) sigue sin tocar — con una sola empresa activa hoy no hace
falta todavía, y ya se ve venir la necesidad exacta con la prueba de
DUCKTAPE (el dashboard de admin ya mezcla ambas sin ninguna etiqueta que
diga cuál es cuál).

**Desplegado**: `psql` (schema-v18.sql) + restart `rest`; `docker
compose build app && up -d` (dos veces — el primer intento no filtraba
bien `disabled_at`, la corrección real fue el segundo build).

---

## 2026-08-29 (continuación) — Multiempresa: Fase 6 (columna "Empresa" en vistas de admin)

Última fase del plan multiempresa. Se agregó una columna "Empresa" a las
4 tablas donde el admin/superadmin puede ver data mezclada de varias
empresas a la vez (`Orders.tsx`, `Invoices.tsx`, `Payments.tsx`,
`Approvals.tsx`) — visible **solo** cuando la vista está en "Todas las
empresas" (`scopeCompanyId` nulo), para no ensuciar la tabla cuando ya
está acotada a una sola. `Approvals.tsx` reusa su variable existente
`allCompanies` en vez de recalcular la misma condición dos veces.

Verificado visualmente con el navegador real (admin, `/orders`): la
columna aparece y muestra "Adsemble" en las 15 órdenes reales — queda
lista para distinguir filas apenas haya una segunda empresa con data real
activa.

**Con esto quedan completas las 6 fases del plan multiempresa** (ver
artefacto publicado). Resumen del estado final: esquema y sincronización
ya soportan las 11 empresas en alcance, login resuelve a una sola cuenta
por proveedor real sin importar cuántas empresas, RLS y Storage ya no
dependen de una empresa escalar, y el frontend tiene selector + columna
de distinción. Activar cada una de las 10 empresas restantes (fuera de
Adsemble) queda como decisión de negocio de Jonatan, no como trabajo
técnico pendiente.

**Desplegado**: `docker compose build app && up -d`.

---

## 2026-08-29 (continuación) — QA completa multiempresa (Fase 1-6), ciclo end-to-end en ambos ambientes

A pedido de Jonatan ("corre una sesion /qa completa en sandbox y deja el
registro para yo ver como se ve en ambos ambientes portal proveedores y
BC"), se corrió una sesión de QA completa sobre las 6 fases del plan
multiempresa, con un ciclo real: subir factura → confirmar → aprobar →
exportar a Business Central, verificando el resultado **directamente en
BC vía API** (no solo la respuesta del portal).

**Reporte completo**: `.gstack/qa-reports/qa-report-multiempresa-2026-08-29.md`
(12 casos, evidencia visual en `.gstack/qa-reports/screenshots/04` a `08`).

Puntos destacados:

- **Ciclo end-to-end real**: factura `FAC-QA-2026-001` sobre la orden
  real `CP-000212` (Adsemble, PROV-000278) → aprobada como superadmin →
  exportada exitosamente → creada en BC sandbox `Test672026` como
  `CF-001931`. Se confirmó contra la API de BC (mismo flujo OAuth
  client-credentials que usa `bc-export-invoice`) que el registro existe
  con los datos correctos (NCF `E310000000123`, vendor `PROV-000278`,
  total `RD$1,180.00`).
- **Investigación de una alarma que resultó ser falsa**: durante la
  prueba, la factura quedó con `company_id` = Adsemble mientras el
  selector del sidebar mostraba "DUCKTAPE MEDIA GROUP" en una captura
  posterior. Se verificó por SQL que la orden CP-000212 y su vendor son
  consistentemente de Adsemble, y que el vendor de prueba de DUCKTAPE
  (PROV-000001) simplemente no tiene ninguna orden real sincronizada
  todavía — el scoping por empresa (`openOrdersForSupplier` en
  `Invoices.tsx`, filtrado por `session.supplierId`) funciona
  correctamente.
- **Hallazgo menor no bloqueante**: el switcher de empresa vive solo en
  el store de Zustand (memoria) — un full page reload lo resetea a la
  primera empresa en `vendorMappings` en vez de recordar la selección
  anterior. Dentro de la SPA (navegación normal) funciona perfectamente
  y sin impacto en RLS/aislamiento de datos. Queda como mejora de UX
  opcional, no como bug.
- Se confirmó en vivo la regla de negocio del corte de recepción de
  facturas (día 25 del mes) bloqueando y luego aceptando la fecha
  correcta.
- Se verificó la columna "Empresa" (Fase 6) en Aprobaciones y Órdenes de
  compra con la vista "Todas las empresas" activa.

**Limpieza**: factura y PDF de prueba eliminados (el PDF vía la Storage
API — `storage.objects` tiene un trigger `protect_delete` que impide
borrado directo en la tabla); DUCKTAPE re-deshabilitada (`disabled_at`)
para sync automático, restaurando el estado pre-prueba. La factura real
creada en BC (`CF-001931`, estado `Draft`) se deja intacta como
evidencia, mismo criterio que la QA anterior (`CF-001929`).

**Health score: 100/100.** 0 bugs reales encontrados en esta corrida.

---

## 2026-08-30 — Vínculo real orden↔factura en BC ("Detalles Factura" sin poblar)

Jonatan reportó, tras revisar el resultado del ciclo de QA del día
anterior directamente en Business Central: la factura exportada aparece
bien en Compras → Facturas de compra, pero la sección **"Detalles
Factura"** de la orden de compra de origen (`CP-000212`) queda vacía.

**Causa confirmada por código + evidencia de BC**: `bc-export-invoice`
crea la factura con la API estándar copiando a mano cantidad/costo/item
de cada línea de la orden ya sincronizada — mismos números, pero **sin
ningún vínculo real**. La consulta directa a BC de la QA del día anterior
ya lo había dejado ver sin que se interpretara entonces: la factura
`CF-001931` tenía `"orderId": "00000000-...", "orderNumber": ""`. La API
v2.0 marca `orderId` de solo lectura en la creación de `purchaseInvoices`
(ya documentado en el código desde antes) y no expone en absoluto los
campos que sí hacen el vínculo real: `"Order No."` / `"Order Line No."`
en cada línea de la factura — los que la función nativa de BC "Obtener
líneas de pedido" completa, y que la rutina de posteo (codeunit 90
"Purch.-Post") lee al momento de postear para actualizar "Quantity
Invoiced" en la orden y poblar esa sección.

**Fix**: nuevo Custom API AL, `infra/business-central/src/PurchInvoiceOrderLinkAPI.al`
(page 58005, `Adsm Purch Inv Order Link API`), bound a `Purchase Line`
(Document Type = Invoice) — mismo patrón que `PurchInvoiceFiscalAPI.al`.
Expone `orderNo`/`orderLineNo` editables por `SystemId`. `bc-export-invoice`
ahora hace un PATCH por línea contra este endpoint justo después de
crearla, con `order.order_number` (el "No." real de la orden) y
`line.sequence` (que ya es el "Line No." interno de BC — así lo guarda
`bc-sync-orders` desde siempre, no hizo falta agregar ninguna columna).
No es fatal si el PATCH falla — la factura ya quedó creada y usable en
BC, solo sin el vínculo nativo — pero se cuenta (`orderLinked` en la
respuesta) y se loguea.

**Pendiente de tu lado** (mismo proceso ya usado para los otros 4
archivos de la extensión, ver `infra/business-central/README.md`):
1. Confirmar `"Order No."`/`"Order Line No."` contra el Object Explorer
   real del sandbox (`AL: Download Symbols` → tabla `Purchase Line`) —
   son campos estándar de la app base, pero no verificados todavía contra
   este tenant específico.
2. `F5` para publicar la extensión actualizada en `Test672026` (login
   interactivo de Microsoft, igual que las veces anteriores).
3. Ampliar el permission set del `BC_CLIENT_ID` con lectura+modificación
   sobre `Adsm Purch Inv Order Link API`.
4. Repetir el ciclo de exportación de una factura de prueba y confirmar
   en la orden de origen que "Detalles Factura" ya se pobló.

No requiere ningún cambio adicional en Supabase ni en el frontend — el
Edge Function ya está actualizado y listo para cuando la extensión esté
publicada.

---

## 2026-08-30 (continuación) — Vínculo orden↔factura verificado en vivo, y un deploy que faltaba

Jonatan publicó `Adsm Purch Inv Order Link API` en el sandbox (`F5` desde
VS Code, log de publicación exitosa a las 10:40:44). Se corrió una
verificación completa:

1. **GET directo al nuevo endpoint** (`purchaseInvoiceOrderLinks`) →
   HTTP 200, sin problema de permisos — el permission set del
   `BC_CLIENT_ID` ya cubre el objeto nuevo.
2. **Ciclo end-to-end real** (subir factura `FAC-QA-LINK-001` sobre
   `CP-000212`, aprobar, exportar) → creada en BC como `CF-001932`, pero
   **`orderNo`/`orderLineNo` seguían vacíos** — la línea no quedó
   vinculada.
3. **Causa encontrada**: el cambio en `bc-export-invoice/index.ts` de
   esta mañana solo se había editado en el repo local — nunca se copió a
   `/home/ubuntu/adsemble/supabase/volumes/functions/bc-export-invoice/`
   ni se corrió `docker compose restart functions`. El Edge Function
   real seguía corriendo el código de ayer (sin el PATCH nuevo), por eso
   la factura se exportó bien pero sin vínculo, y sin ningún error en
   logs (nunca se llegó a intentar).
4. **Deploy real**: `scp` del archivo actualizado al volumen +
   `docker compose restart functions`.
5. **Verificación aislada del lado de BC**: PATCH manual contra
   `purchaseInvoiceOrderLinks(...)` de la línea de `CF-001932` con
   `{"orderNo":"CP-000212","orderLineNo":10000}` → HTTP 200, y un GET
   posterior confirma que quedó guardado. Esto prueba que la extensión AL
   funciona correctamente de forma aislada — el problema era 100% el
   deploy pendiente del lado de Supabase, no el código AL ni los nombres
   de campo (compilaron a la primera, sin necesidad de ajustar nada del
   `PurchInvoiceOrderLinkAPI.al` original).

**Confirmado, no queda pendiente**: con el Edge Function ya desplegado,
la próxima factura que se exporte por el flujo normal (botón "Exportar
ahora") va a hacer el PATCH automáticamente — no hace falta repetir este
parche manual. La orden `CP-000212` en sí seguía en estado `Open` /
`fullyReceived: false` después del vínculo (esperado: `"Quantity
Invoiced"` y la sección "Detalles Factura" solo se actualizan cuando la
factura se **postea** en BC — sigue pendiente el "Expense Class Code"
manual, ver nota en `bc-export-invoice/index.ts`, así que esta factura de
prueba quedó sin postear a propósito).

**Limpieza**: factura de prueba y PDF eliminados del portal (mismo
método de ayer — Storage API, no borrado directo). La factura real en BC
(`CF-001932`, con el vínculo ya puesto) se deja intacta como evidencia
para que Jonatan la revise en "Detalles Factura" de `CP-000212` una vez
alguien la postee.

**Desplegado**: extensión AL publicada por Jonatan vía VS Code (`F5`,
sandbox `Test672026`); `scp` + `docker compose restart functions` para
`bc-export-invoice`.

---

## 2026-08-31 — "Expense Class Code" resuelto: no era una regla nueva, ya existe en cada orden

Jonatan preguntó qué decisión faltaba para poder postear ("que necesitamos
para postearla? cual es la decision que falta?") y después pidió
implementarlo ("implementemos eso que falta de expense class").

**La premisa de continuación 17 (2026-08-20) estaba incompleta.** Se había
documentado que el Expense Class Code (`DSNCod. Clasificacion Gasto`, 2
dígitos para los reportes 606/607/608 de la DGII) era "una decisión
contable de Adsemble" pendiente de definir, sin dato para inferirla. Antes
de pedirle a Jonatan que inventara una regla nueva, se verificó en vivo si
ese dato ya existía en algún lado de BC.

**Sí existe — a nivel de orden de compra, no de factura.** Usando el mismo
endpoint OData v4 legacy (`/ODataV4`, con `?company=ADSEMBLE`) que ya se
había usado para decodificar nombres de campo en continuaciones
anteriores, se consultó el web service `Pedido_compra_Excel` (cabecera de
orden de compra) sobre 15 órdenes reales de ADSEMBLE: **12 ya tenían
`DSNCod_Clasificacion_Gasto` poblado** (`"01"`, `"02"`, `"04"`), solo 3 en
blanco (órdenes de prueba/legacy de continuaciones anteriores, ej.
`CP-000211`). Es decir: quien arma la orden en BC (equipo de Adsemble) ya
elige este código al crearla — el portal no tenía que inventar nada, solo
ir a buscarlo ahí y copiarlo a la factura.

**Implementado:**
1. **`PurchOrderFiscalAPI.al`** (nuevo, page 58006) — Custom API de solo
   LECTURA sobre `Purchase Header` (Document Type = Order), expone
   `expenseClassCode`. Mismo campo que ya usa `PurchInvoiceFiscalAPI.al`
   (page 58004) para facturas, solo que filtrado a órdenes — riesgo de
   compilación bajo porque el nombre del campo ya está verificado.
2. **`schema-v19.sql`** — columna `purchase_orders.bc_expense_class_code`.
3. **`bc-sync-orders/index.ts`** — por cada orden sincronizada, GET
   `/purchaseOrderFiscals({bc_id})` (no rompe el sync si falla — solo
   queda sin ese dato, igual que antes).
4. **`bc-export-invoice/index.ts`** — al exportar, si la orden tiene
   `bc_expense_class_code`, se manda en el mismo PATCH que ya escribe el
   NCF (`purchaseInvoiceFiscals`), en vez de un PATCH separado.

**Pendiente (manual, mismo patrón que las extensiones anteriores):**
Jonatan tiene que publicar la extensión (`F5` en VS Code, sube a `1.2.0.0`
por el nuevo archivo), y luego correr `bc-sync-orders` una vez para que las
órdenes ya sincronizadas antes de este cambio traigan el dato con
retroactividad — no llega solo con el publish. También falta ampliar el
permission set del `BC_CLIENT_ID` con lectura sobre
`Adsm Purch Order Fiscal API` (ver `infra/business-central/README.md`).

**Con esto, de los 5 requisitos para postear identificados en continuación
17/18 (NCF, Expense Class Code, VAT Posting Group, Payment Method, fecha de
posteo), los primeros dos quedan 100% automatizados por `bc-export-invoice`
sin intervención manual — el copiado NCF ya lo estaba desde continuación
17, el Expense Class Code se suma con este cambio. Los 3 restantes siguen
siendo datos maestros de BC (catálogo de cuentas / vendor / fecha), fuera
del alcance del portal.**

**Verificación en vivo (mismo día, después de que Jonatan publicó la
extensión vía `F5`, subida a `1.2.0.0`):**
1. `GET .../purchaseOrderFiscals` sobre la empresa ADSEMBLE ya responde con
   los mismos valores reales vistos por OData v4 legacy (`CP-000172` →
   `"04"`, `CP-000185` → `"02"`, `CP-000190` → `"01"`, ...).
2. Se corrió `bc-sync-orders` manualmente (el throttle normal es de 1
   minuto) — `bc_expense_class_code` quedó poblado en las 15 órdenes de
   Supabase con los mismos valores exactos.
3. Prueba de escritura aislada (mismo patrón que la verificación del
   vínculo orden↔factura): sobre `CF-001930` (factura ya exportada antes de
   este cambio, de la orden `CP-000215`, código `"02"`), se leyó
   `expenseClassCode` en BC (vacío, como se esperaba de una exportación
   vieja), se hizo el mismo `PATCH` que ahora hace `bc-export-invoice`
   automáticamente, y se confirmó por un `GET` posterior que quedó en
   `"02"` — mismo valor que su orden de origen. Prueba el camino de
   lectura (orden) y escritura (factura) de punta a punta contra BC real,
   sin necesidad de generar una factura nueva.

**Con esto: implementado, desplegado y verificado en vivo tanto del lado
de Supabase (sync + export) como del lado de BC (extensión publicada,
datos reales confirmados). Ninguna factura nueva se exportó para esta
verificación — se reutilizó una ya existente de pruebas anteriores.**

---

## 2026-08-31 (continuación) — Auditoría de datos maestros + ciclo E2E completo con ambos fixes

Jonatan preguntó si el proyecto está listo para pase a producción. Antes de
contestar que sí, se corrieron 3 verificaciones concretas contra datos
reales (no solo de prueba):

**1. Vendors fuera de los 4 grupos de portal (`GASMENOR`, `RETEMPL`,
`CPEMPL`, `CPACC`, `OTRASCXP`, 283 en total) — ¿se cuelan al portal?** No:
0 facturas, y de los 2 con `user_vendor_mapping`, ambos son vendors de
prueba conocidos (`V-0001`, `PROV-000283`) sin `vendor_posting_group`
sincronizado. Sin hallazgos.

**2. Completitud de datos maestros en las cuentas/vendors REALES en uso
(no solo el caso de prueba ya corregido en continuación 18):**
- **VAT/Gen Posting Group en cuentas**: de las 6 cuentas contables usadas
  en órdenes reales (`2060`, `6016`, `6020`, `6102`, `6106`, `6107`), **solo
  `6107` (la que ya se corrigió en su momento) tiene los 4 grupos
  configurados. Las otras 5 están en blanco** — afectan 7 órdenes reales
  entre las 15 sincronizadas (`6102`×4, `6106`×2, más una cada una de
  `2060`/`6016`/`6020`). Cualquier factura contra esas cuentas va a fallar
  al postear con el mismo error `"VAT Prod. Posting Group must have
  value..."` que ya se vio antes.
- **Payment Method Code en vendors reales**: de los 11 vendors con órdenes
  reales en el portal, **10 lo tienen, 1 no: `PROV-003514` (GMACRO
  DOMINICANA SRL)**.

Ambos son huecos de datos maestros en BC, no del portal — se los pasé a
Jonatan para que Adsemble los complete antes de que una factura real
contra esas cuentas/ese vendor intente postear.

**3. Ciclo 100% en vivo combinando los dos fixes de hoy (order-link +
Expense Class Code), sobre una factura NUEVA por el flujo real del
portal** (no una reutilizada): orden `CP-000212` (cuenta `6107`, ya
configurada; vendor `PROV-000278`, con Payment Method configurado;
`bc_expense_class_code = "02"`).

- Subida por el proveedor (`jonathanmaria+proveedor@gmail.com`) con un PDF
  sintético — el OCR extrajo bien fecha/número/total, pero **leyó mal el
  NCF** (`B0200000099` → `O0200000099`, confundió B/O). Corregido a mano
  antes de confirmar, como haría cualquier proveedor. Ver nota de OCR
  abajo.
- Aprobada por `l.frias@adsemble.do` (approver).
- Exportada por `jonathanmaria@gmail.com` (superadmin) → creada en BC como
  `CF-001933`.
- **Verificado en BC, los 3 datos en la factura nueva sin ningún paso
  manual**: `fiscalDocumentNo: "B0200000099"`, `expenseClassCode: "02"`,
  y `purchaseInvoiceOrderLinks` con `orderNo: "CP-000212"` /
  `orderLineNo: 10000`. Los dos fixes de esta sesión funcionan juntos, de
  punta a punta, en una factura real del flujo real.
- **Intento de posteo real** (`Microsoft.NAV.post`): rechazado —
  `"Posting Date is not within your range of allowed posting dates"`.
  Esto es exactamente el 3er requisito pendiente ya documentado (rango de
  fechas de posteo abierto en BC), confirmado empíricamente esta vez, no
  solo en teoría. **Nota operativa nueva**: el corte de recepción de
  facturas (día 25, factura con fecha del mes siguiente) hace que esto se
  repita cada fin de mes hasta que Adsemble abra el período contable del
  mes siguiente en BC — no es un bug del portal, pero sí algo que el
  equipo de contabilidad va a tener que mantener al día todos los meses
  para que el posteo no se atore.

**Nota de OCR (hallazgo del punto anterior):** `ocr-service/app.py` acepta
cualquier letra A-Z como prefijo de NCF (`[A-Z]\d{10,12}`), pero los
únicos prefijos reales en uso son `A`/`B` (NCF físico) y `E` (e-CF)
—confirmado en el propio comentario del código. Acotar el regex a
`[ABE]\d{10,12}` haría que un NCF mal leído (como el `O0200000099` de esta
prueba) se rechace y quede en blanco para completar a mano, en vez de
mostrarse como si estuviera bien. Cambio pendiente de confirmación de
Jonatan (bajo riesgo, sin downside conocido).

**Estado de "listos para producción" después de esto:** el ciclo
funcional está probado de punta a punta con los fixes de hoy. Quedan 3
huecos concretos antes de decir que sí, ninguno de código:
1. Completar VAT/Gen Posting Group en las cuentas `2060`, `6016`, `6020`,
   `6102`, `6106` (BC, catálogo de cuentas).
2. Completar Payment Method Code en el vendor `PROV-003514` (BC, ficha de
   vendor).
3. Mantener abierto el período de posteo del mes siguiente en BC antes de
   que empiecen a llegar facturas reales con esa fecha (proceso mensual
   de contabilidad, no un dato puntual a corregir una vez).

**OCR (mismo día):** acotado `NCF_PATTERN`/`NCF_LABEL_PATTERN` en
`ocr-service/app.py` de `[A-Z]` a `[ABE]` (únicos prefijos reales de NCF
dominicano) — un NCF mal leído con un prefijo inválido ahora queda vacío
en vez de mostrarse como si estuviera bien. Desplegado (`docker compose
build ocr-service` + `up -d`, imagen reconstruida porque el Dockerfile
usa `COPY app.py .`, no es un mount en vivo) y verificado in-process
(`extract_ncf` acepta `B02.../E31...`, rechaza `O02...`).

---

## 2026-08-31 (continuación) — Bug real de correo: Exchange/M365 reemplaza el cuerpo del template

Prueba en vivo pedida por Jonatan: disparar el flujo real de "olvidaste tu
contraseña" (`POST /recover`, el mismo público que usa Login.tsx) contra
`jonathanmaria@gmail.com` antes de invitar a las 6 personas reales.

**El envío en sí funcionó**: `POST /recover` → `200`, sin errores en
`docker logs supabase-auth`, duración ~4.3s consistente con un round-trip
SMTP real contra `smtp.office365.com` con la cuenta `soporte@adsemble.do`.
Asunto y remitente correctos.

**Pero el correo que llegó a Gmail (`link.png`, compartido por Jonatan) no
es ninguno de los dos templates reales** (`recovery.html` / `invite.html`,
ambos leídos completos del servidor para comparar) — ninguno de los dos
tiene logo en imagen rasterizada, dirección en verde, campo "Tel:", ni
iconos de Instagram/LinkedIn. Lo que llegó es una tarjeta de firma/contacto
tipo "Soporte Adsemble" — **sin ningún rastro del título, párrafo o botón
"Restablecer contraseña"** que sí están en el archivo real.

**Diagnóstico (no confirmado, sin acceso para verificarlo):** todo apunta
a una regla de firma corporativa de Exchange Online/Microsoft 365 en la
cuenta `soporte@adsemble.do` que se aplica a TODO saliente (incluido SMTP
autenticado desde una aplicación, no solo Outlook/OWA) — y en vez de
agregarse debajo del cuerpo, parece estar **reemplazándolo por completo**.
No se pudo confirmar desde este stack: el admin center de Microsoft 365
del tenant de Adsemble está fuera de nuestro alcance.

**Pendiente, bloqueando la fase de invitación real a las 6 personas:**
1. Confirmar via "Mostrar original" en Gmail si el HTML real del template
   está en el mensaje crudo (oculto) o si Exchange lo reemplazó del todo.
2. Si es una regla de Exchange: alguien con acceso al M365 admin center de
   Adsemble tiene que excluir `soporte@adsemble.do` de esa regla, o hacer
   una excepción para correo enviado por SMTP autenticado desde
   aplicaciones (vs. compuesto a mano en Outlook/OWA).

No se invita a nadie real hasta resolver esto — no tiene sentido mandar un
correo de invitación que tampoco va a mostrar el enlace para crear
contraseña.

**Actualización — causa real encontrada (mismo día, más tarde):** se probó
cambiar de buzón (`soporte@adsemble.do` → `portalproveedores@adsemble.do`,
nuevo, con su propia odisea de Conditional Access/Authenticated SMTP en
M365 para poder autenticar) y el correo **seguía llegando sin cuerpo** —
eso descartó que fuera algo específico del buzón viejo. Se probó mandar un
correo armado a mano por SMTP crudo (sin pasar por GoTrue): llegó
perfecto, con la firma de Exchange agregada DEBAJO del contenido real, sin
comerse nada — descartando a Exchange como causante.

Con eso acotado a GoTrue, se intentó interceptar el SMTP saliente con un
catcher propio (necesitó implementar STARTTLS + certificado con SAN
porque GoTrue rechaza conexiones sin cifrar o con certificados no
confiables — confirma que el cliente SMTP de GoTrue es serio, no hace
nada raro ahí) pero no se pudo completar sin una CA confiable de verdad;
se revirtió esa parte sin dejar nada instalado. La prueba definitiva fue
pedirle a Jonatan el código fuente crudo del correo real desde Gmail
("Mostrar original"):

**El `<body>` del correo NO era `recovery.html` — era el `index.html` del
propio SPA del portal** (`<div id="root">`, los `<script>`/`<link>` del
build de Vite, `<title>Portal Proveedores Adsemble</title>` en vez de
"Recuperar contraseña..."). La firma de Exchange (marcador
`[SIG-ADS-2026]`) se agregaba bien después, como siempre.

**Causa real:** `GOTRUE_MAILER_TEMPLATES_RECOVERY`/`_INVITE` no leen la
ruta de archivo montada directo del disco pese a estar ahí —  GoTrue las
trata como una URL para hacer `fetch` al momento de mandar el correo. Con
un valor tipo `/etc/auth/templates/recovery.html`, terminaba pidiendo algo
como `https://proveedores.jfmcss.com/etc/auth/templates/recovery.html` —
ruta que no existe en el SPA, así que el router de React devolvía su
`index.html` de fallback, y eso es lo que se mandaba por correo. Estaba
mal desde que se configuró (continuación del 2026-08-20) — nunca se había
verificado el cuerpo real de un correo, solo que "llegaba".

**Arreglado:** nuevo servicio `mail-templates` (`nginx:alpine`, sin
puertos publicados, monta la misma carpeta `./volumes/auth-templates`) que
sirve los dos HTML por HTTP dentro de la red interna del compose.
`GOTRUE_MAILER_TEMPLATES_INVITE`/`_RECOVERY` ahora apuntan a
`http://mail-templates/invite.html` / `http://mail-templates/recovery.html`
en vez de la ruta de archivo. Verificado: nginx sirve el HTML real
(confirmado el `<title>` correcto), `POST /recover` respondió `200` sin
errores, **y Jonatan confirmó visualmente** (`resultado2.png`) que el
correo llega completo: logo, título "Restablece tu contraseña", párrafo,
botón azul "Restablecer contraseña", enlace de respaldo, y la firma de
Exchange como pie normal debajo — sin pisar nada. Cerrado.

## 2026-08-31 (continuación) — Cierre de sesión por inactividad, con aviso previo

Jonatan preguntó si había expiración de sesión — no había ninguna: ni
`GOTRUE_SESSIONS_TIMEBOX`/`_INACTIVITY_TIMEOUT` en el `.env` (solo
`JWT_EXPIRY=3600`, el access token, que se renueva solo via
`autoRefreshToken` del cliente Supabase con sus defaults), ni ningún
mecanismo propio del frontend. En la práctica, quien hacía login una vez
quedaba adentro indefinidamente.

Pidió cierre por inactividad **con aviso en popup antes de cerrar** — eso
solo se puede hacer del lado del cliente (GoTrue no tiene forma de avisar,
solo de invalidar de golpe), así que se implementó ahí:

**`IdleSessionGuard.tsx`** (nuevo, montado dentro de `AppShell` — solo
corre en rutas autenticadas): 30 minutos sin actividad (mousemove,
mousedown, keydown, scroll, touchstart) dispara un modal de aviso
("¿Seguís ahí?") con cuenta regresiva de 60 segundos; si no se hace click
en "Seguir conectado" (o se cierra el modal) en ese minuto, se llama
`supabase.auth.signOut()` y `FeatureGuard` redirige solo a `/login` (ya
redirige en cuanto `session.role` queda null, no hizo falta agregar
navegación manual). A propósito, mientras el aviso está en pantalla, la
actividad ambiental (mover el mouse) NO lo cancela sola -- exige el click
explícito, para que un mouse jiggler o scroll automático no lo anulen sin
que haya alguien real ahí.

**Desplegado**: `tsc --noEmit && vite build` limpio, `docker compose
build app && up -d` en `/home/ubuntu/adsemble/portal/` (no es checkout de
git en el servidor, se sincronizaron los 3 archivos tocados a mano vía
`scp`). Confirmado que el sitio en vivo sirve el bundle nuevo.

## 2026-08-31 (continuación) — OCR: lineas de detalle (best-effort)

Pedido de Jonatan: robustecer el OCR para que tambien capture las lineas
de la factura (descripcion/cantidad/precio/importe), no solo
fecha/NCF/numero/total.

`invoice_lines` existe desde antes y `InvoiceDetail.tsx` ya la muestra en
"Facturas vinculadas a esta orden" -- pero nunca se insertaba nada ahi
(la nota de 2026-08-25 en `extract-invoice-data` lo dejo afuera a
proposito: con `image_to_string()` -- solo texto plano, sin posicion -- no
hay forma de saber que palabras estaban en la misma fila/columna de una
tabla).

**Implementado con `pytesseract.image_to_data()`** (trae posicion left/top
y numero de linea por palabra, no solo texto): agrupa palabras por fila,
descarta encabezados de tabla y filas de subtotal/ITBIS/total, y toma como
linea de factura toda fila que termine en 1-3 tokens con forma de monto
(cantidad/precio/importe), usando el resto como descripcion. Si no
encuentra ninguna fila que cumpla, o encuentra mas de 25 (mas probable que
sea ruido que una tabla real), devuelve una lista vacia -- mismo criterio
de "fallar cerrado" que el NCF. `extract-invoice-data` inserta estas
lineas SOLO si la factura no tiene ninguna todavia (nunca pisa lineas
cargadas a mano).

**Sigue siendo heuristico, no resuelve el problema de fondo** (formatos de
factura muy distintos entre proveedores van a fallar) -- probado con un
PDF sintetico de 2 lineas: capturo bien descripcion + cantidad en ambas,
pero en una de las dos no reconocio la columna "Importe" (unitPrice/amount
quedaron incompletos), confirmando el limite ya esperado. Sirve como
prellenado de partida para que un admin/aprobador revise, no como dato
confiable sin revisar.

**Desplegado**: `ocr-service` reconstruido (`docker compose build` + `up
-d`, mismo motivo que el fix de NCF -- imagen con `COPY app.py .`, no
mount en vivo) y `extract-invoice-data` copiado + `functions` reiniciado.
Verificado con un PDF de prueba tabular contra el servicio ya desplegado
(no se insertó nada en producción -- se probó pegándole directo a
`ocr-service:8080/extract`, sin pasar por una factura real).

## 2026-09-01 — Faltaba Carolina Pérez en el lote de invitaciones

Jonatan avisó que `c.perez@adsemble.do` (Carolina Pérez) se quedó afuera del
lote de invitaciones de prueba. Verificado contra `user_profiles`: no
existía ninguna cuenta con ese correo (los otros 6 sí, todos activos), así
que no era un simple reset de password -- había que invitarla de cero.
Preguntado el rol: **approver**, igual que l.aquino/l.frias/v.tejeda/y.medina
(las 4 cuentas `@adsemble.do` con ese rol hoy), mismo `company_id` de
Adsemble.

Invitada vía `provisionInvitedUser` (el mismo helper que usa `invite-user`
desde `Users.tsx`) -- desplegado como función temporal de un solo uso en el
contenedor de `functions`, invocada una vez vía Kong con la service role key
tomada del entorno de otro contenedor (nunca escrita a mano ni impresa), y
borrada del servidor apenas terminó. Confirmado en `user_profiles`: fila
creada con `role='approver'`, `active=true`, `company_id` de Adsemble.
Dispara el mismo correo real de invitación (plantilla `invite.html` de
marca Adsemble, ya con el fix del cuerpo aplicado) para que fije su
contraseña.

## 2026-09-01 (continuación) — Bug real: faltaba `SITE_URL` en el contenedor `functions`

Al armar logins de prueba para 3 proveedores reales (Adobe, Clickable SRL,
Asoc. Dominicana de Empresas de Comunicación) se encontró que
`invite-user`/`reset-user-password` arman `redirectTo` como
`${Deno.env.get("SITE_URL")}/set-password`, pero **el contenedor
`supabase-edge-functions` nunca tenía `SITE_URL` en su `environment:`** en
`docker-compose.yml` (sí existe en `.env`, pero no estaba mapeado a ese
servicio -- solo al de `auth`, como `GOTRUE_SITE_URL`). Con la variable
vacía, `redirectTo` quedaba `undefined` y GoTrue caía al `SITE_URL` propio
(la raíz del sitio, sin `/set-password`) -- el enlace abría sesión directo
en el dashboard sin pasar nunca por la pantalla de fijar contraseña, así
que quien lo usaba quedaba con la cuenta activa pero **sin ninguna
contraseña real seteada** para volver a entrar después.

**Esto afecta a los 6 correos de invitación/reset + el de Carolina Pérez
mandados esta semana** -- todos generados con el mismo código. Pendiente
que Jonatan decida si les reenvía el reset ahora que está arreglado.

**Arreglado**: agregada `SITE_URL: ${SITE_URL}` al bloque `environment:` de
`functions` en `docker-compose.yml`, `docker compose up -d functions`.
Verificado: un link de invitación generado después del fix trae
`redirect_to=https://proveedores.jfmcss.com/set-password` (antes, la misma
llamada devolvía `redirect_to=https://proveedores.jfmcss.com` a secas).

**4 logins de prueba (sandbox) creados a pedido de Jonatan**, sin mandar
ningún correo real (pidió explícitamente no invitar por correo a
proveedores reales en sandbox) -- se generaron los links de
invitación/recuperación directo vía `auth.admin.generateLink` (crea el
token pero no dispara ningún envío) desde una función temporal desplegada
y borrada en el momento, igual patrón que el alta de Carolina:
- `sugopeca@gmail.com` (proveedor de prueba ya existente, V-0001) -- link de recuperación.
- `jonathanmaria+adobe@gmail.com` → PROV-001705 (ADOBE, RNC 770019522, empresa Adsemble) -- alta nueva, rol supplier.
- `admin@clickablestudio.com` → PROV-002350 (CLICKABLE SRL) -- alta nueva, rol supplier.
- `claudiam@adecc.com.do` → PROV-000519 (ASOC. DOMINICANA DE EMPRESAS DE COMUNICACIÓN) -- alta nueva, rol supplier.

Los links se le pasaron a Jonatan directo en el chat para que él se los
reenvíe manualmente a quien vaya a probar cada rol -- no se generó ni se
tocó ninguna contraseña en texto plano en ningún momento.

**Nota**: las 3 fichas de proveedor real (Adobe, Clickable, Asoc.
Dominicana) figuran con `status='blocked'` en la tabla `vendors` bajo las
3 empresas (Adsemble, Ducktape Media Group, Juan Fabian) -- no se investigó
si eso afecta algo funcional del portal (solo se usó como identificador
para el login de prueba), queda para revisar si hace falta.

## 2026-09-01 — Pedido "Key Players": items 1 y 2 (1 OC = 1 Factura, eliminar factura)

Pedido formal de cambios de Key Players sobre el Vendor Portal (10 items).
Antes de tocar código se hizo el análisis completo del repo (los 10 puntos
que pidieron) y se resolvieron 3 bloqueos reales con Jonatan antes de
escribir nada:

1. **Hay 6 órdenes de compra en producción con más de una factura activa**
   (una con 4) -- la regla nueva de 1:1 **aplica solo hacia adelante**, esas
   6 quedan como excepción histórica sin tocar.
2. **"Fecha de Emisión" vs "Fecha de Factura"**: Jonatan mandó capturas
   reales de BC (`ordendecompra1.png`, `datosadjuntos.png`) -- son campos
   que viven **en la Orden de Compra misma** en BC (`Fecha emisión
   documento`, `Nº factura proveedor`, `No. Comprobante Fiscal`), no en un
   documento de Factura separado. Esto reveló que el flujo actual
   (`bc-export-invoice`) nunca toca esos campos -- crea una **Factura de
   Compra separada** en BC (necesaria para postear/reportes 606-607-608).
3. Confirmado con Jonatan: **NO se reemplaza `bc-export-invoice`** (seguiría
   sin asiento contable/reportes fiscales si se sacara) -- se hace un paso
   NUEVO además, que también patchea esos campos + adjunta el PDF en la
   Orden. **Pendiente de implementar** (item 3 y 5 del pedido), dejando esta
   nota para cuando Adsemble decida si en el futuro quiere eliminar el flujo
   actual de Factura separada.

**Implementado y verificado en vivo (items 1 y 2):**

- `schema-v20.sql`: trigger `check_one_active_invoice_per_po` (BEFORE
  INSERT en `invoices`) -- bloquea una segunda factura activa (`status !=
  'rejected'`) sobre la misma orden. Es un TRIGGER y no un índice único a
  propósito: un índice único fallaría al crearse contra las 6 órdenes ya
  duplicadas; el trigger solo valida INSERTs nuevos, nunca toca datos
  viejos.
- Policy `scoped delete` en `invoices` (admin/superadmin sin restricción,
  proveedor solo lo suyo y solo en `draft`/`uploaded` -- una vez "enviada"
  a aprobación ya no es libre) + `scoped delete invoices bucket` en
  `storage.objects` (mismo alcance) -- antes NINGUNA de las dos tenía
  policy de DELETE, quedaba denegado por RLS por defecto.
- Policy nueva de INSERT en `security_audit_log` (antes solo se escribía
  desde Edge Functions con `service_role`) para que `deleteInvoice` pueda
  registrar `invoice_deleted` desde el cliente -- acotada a ese
  `event_type` y a `actor_user_id = auth.uid()` (nadie puede fabricar un
  registro atribuido a otro usuario). No se usa `invoice_status_history`
  para esto: esa tabla tiene `on delete cascade` con `invoices`, un evento
  ahí desaparecería junto con la fila que se borra.
- `domain.ts`: `deleteInvoice(invoiceId, changedBy)` -- borra el archivo de
  Storage ANTES que la fila (si se borrara la fila primero, la policy de
  Storage ya no tendría contra qué validar el `file_path` y el archivo
  quedaría huérfano). `uploadInvoice` valida de entrada si la orden ya
  tiene una factura activa (mensaje claro antes de subir el archivo -- el
  trigger es la garantía real, esto es solo UX).
- `Invoices.tsx` (`InvoiceDetail`): botón "Eliminar factura" (solo si
  `draft`/`uploaded`, o admin/superadmin siempre) con modal de confirmación
  con el texto exacto pedido. `InvoicesList`: el selector de "orden para
  cargar factura" ya no ofrece órdenes que ya tienen una factura activa.
- `Orders.tsx` (`OrderDetail`): botón de carga deshabilitado + mensaje
  claro cuando la orden ya tiene factura asociada.

**Verificado end-to-end en vivo, no solo por SQL directo**: se firmó un JWT
real (HS256, mismo secreto que usa GoTrue) para un usuario proveedor real
(`jonathanmaria+adobe@gmail.com`, cuenta de sandbox propia) y se ejecutaron
las mismas llamadas que hace el frontend contra Kong/PostgREST/Storage --
subir archivo → insertar factura → intentar una segunda sobre la misma
orden (rechazada, HTTP 409) → borrar archivo → borrar fila → insertar de
nuevo sobre la misma orden (ahora sí, libre otra vez). Los 7 pasos
pasaron. Sin residuos: conteo de `invoices` antes/después igual (20).

**Desplegado**: `tsc --noEmit && vite build` limpio, `docker compose build
app && up -d` en `/home/ubuntu/adsemble/portal/`, migración aplicada
directo a la base de producción (`schema-v20.sql`, idempotente).

**Pendiente** (orden sugerido por Key Players): item 3 (patchear
Fecha/NCF/Nº factura en la Orden de BC + item 5, adjuntar el PDF ahí
también -- mismo API estándar `/purchaseOrders({id})` que ya usa
`bc-sync-orders`, falta confirmar en vivo si `/attachments` está
disponible en este tenant o hace falta AL nuevo), item 6 (filtros
server-side) e item 7 (performance -- causa raíz ya identificada:
`domain.ts:fetchAll()` carga TODAS las tablas completas y se re-ejecuta
después de cada mutación, sin paginar `purchase_orders` -- mismo riesgo de
truncado a 1000 filas que ya se encontró y arregló para `vendors`).

## 2026-09-01 (continuación) — Pedido "Key Players": items 3 y 5 (BC: fecha/NCF/Nº factura en la Orden + adjuntos)

Antes de escribir nada se confirmó todo contra el tenant real de BC (misma
disciplina que ya usó este proyecto para NCF/Expense Class Code -- nunca
adivinar), vía una función temporal de un solo uso desplegada y borrada en
el momento:

- **"Fecha emisión documento"** = el campo **estándar** `orderDate` de la
  API v2.0 de `purchaseOrders` -- confirmado cruzando `orderDate` de
  CP-000221 contra la captura real de Jonatan (`ordendecompra1.png`):
  `2026-09-01` = `1/9/2026`. No necesita ninguna extensión AL.
- **"Nº factura proveedor"** = campo estándar de BC `Vendor Invoice No.`
  (`Vendor_Invoice_No` en el `$metadata` legacy), pero NO expuesto por la
  API v2.0 estándar -- necesita AL.
- **NCF** = `DSNNo. Comprobante Fiscal`, el mismo campo que ya usa
  `PurchInvoiceFiscalAPI.al` para facturas -- confirmado que también existe
  sobre `Document Type = Order` (misma tabla `Purchase Header`).
- **Adjuntos**: `/purchaseOrders({id})/attachments` **ya funciona** en la
  API estándar (probado en vivo con un GET real, devolvió `{value: []}`) --
  no hace falta AL para leerlos ni para escribirlos (mismo mecanismo que
  `bcAttachFile` ya usa con éxito para facturas).

**Implementado:**

- `infra/business-central/src/PurchOrderFiscalAPI.al` (page 58006):
  extendida -- ya no es de solo lectura, agrega `vendorInvoiceNumber` y
  `fiscalDocumentNo`, `ModifyAllowed = true`. `app.json` a `1.3.0.0`.
  **Pendiente de que Jonatan la publique en el sandbox vía VS Code** (F5) --
  sin esto, el paso nuevo de `bc-export-invoice` falla silenciosamente (no
  fatal, ver abajo) hasta que se publique. `README.md` actualizado con el
  permission set nuevo necesario (Modify sobre esta página, antes solo
  Read).
- `_shared/bc-client.ts`: `bcListAttachments`/`bcGetAttachmentContent`
  (lectura de `/attachments`, sub-recurso estándar, sirve para cualquier
  documento que los soporte).
- `bc-export-invoice`: nuevo paso 3.5, **además** del flujo existente (no
  lo reemplaza -- confirmado con Jonatan, la Factura de Compra separada
  sigue siendo lo único que postea/alimenta 606-607-608, con nota dejada
  en el código por si en el futuro se decide eliminarla). Patchea
  `orderDate` (estándar) + `vendorInvoiceNumber`/`fiscalDocumentNo`
  (`purchaseOrderFiscals`, custom) + adjunta el mismo PDF en la Orden. A
  propósito **no fatal**: si falla (ej. la extensión AL todavía no está
  publicada), la factura real igual queda creada en BC sin marcarse
  `export_error` -- se reporta `orderSynced: false` en la respuesta.
  `Exports.tsx` muestra el resultado.
- `bc-order-attachments` (función nueva): lista y descarga/muestra los
  adjuntos de una orden. Mismo patrón de autorización que
  `invite-user`/`delete-user` (revalida rol/alcance a mano contra la base
  con `service_role`, igual que "scoped read" de `purchase_orders`) --
  NUNCA confía en lo que mande el cliente.
- `Orders.tsx` (`OrderDetail`): sección nueva "Datos adjuntos" (nombre,
  tipo, tamaño, Ver/Descargar) -- no se persiste en Supabase, se consulta
  a BC en vivo cada vez que se abre el detalle de una orden.

**Verificado en vivo (no solo en teoría)**, con un JWT real para dos
proveedores de sandbox reales:
- `admin@clickablestudio.com` (dueño real de CP-000221) → lista sus
  propios adjuntos: `200 {"ok":true,"attachments":[]}` (vacío, coincide con
  la captura de Jonatan `datosadjuntos.png` que también mostraba 0
  adjuntos para esa misma orden).
- `jonathanmaria+adobe@gmail.com` (otro proveedor) contra la MISMA orden
  de Clickable → `403 {"error":"No tenes acceso a esta orden de compra"}`
  -- aislamiento entre proveedores confirmado, no solo asumido.
- `bc-export-invoice` invocado con un `invoiceId` inexistente -- confirma
  que el archivo carga y corre sin error de sintaxis Deno (falla limpio en
  "Factura no encontrada", como se espera, sin tocar BC).

**Desplegado**: `tsc --noEmit && vite build` limpio, `docker compose build
app && up -d` (frontend); `_shared/bc-client.ts`, `bc-export-invoice`,
`bc-order-attachments` copiados a `/home/ubuntu/adsemble/supabase/volumes/
functions/` + `docker compose restart functions`.

**Publicado y verificado en vivo (2026-09-01, mismo día)**: Jonatan publicó
`1.3.0.0` en el sandbox vía VS Code (log de publish exitoso). Se confirmó
en vivo, contra CP-000221 real:
- GET `/purchaseOrderFiscals` ya trae `vendorInvoiceNumber`/
  `fiscalDocumentNo` (vacíos, coincide con la orden real).
- PATCH con un valor de prueba (`"TEST-VERIFY-AL"`) escribió correctamente
  -- el permission set ya tenía Modify sin necesitar ajuste manual extra.
- Revertido de inmediato al valor original (`""`) -- la orden real quedó
  sin ningún rastro de la prueba.

Con esto, el paso 3.5 de `bc-export-invoice` ya tiene efecto real la
próxima vez que se exporte una factura de verdad -- no hizo falta ninguna
prueba de exportación real (eso sí crea un documento real en BC, se dejó
para cuando Jonatan lo pida explícitamente).

**Pendiente**: items 6 (filtros server-side) y 7 (performance, causa raíz
ya identificada) del pedido de Key Players.

## 2026-09-01 (continuación) — Pedido "Key Players": items 6 y 7 (filtros server-side + performance)

**Medido antes de tocar nada** (pedido explícito de Key Players: métricas
antes/después): conteo real de filas por tabla —
`invoices`=20, `purchase_orders`=21, `vendors`=**10.441**, resto <40. Se
replicó `fetchAll()` exacto (mismas queries, mismo usuario real) contra el
servidor: **2.339ms**, con `vendors` solo (11 requests paginados de 1000
filas c/u) explicando casi todo ese tiempo. `fetchAll()` corre no solo al
entrar sino **después de cada mutación de toda la app** (aprobar, subir,
confirmar, exportar, eliminar, etc.) -- esta es la causa raíz real de "el
portal está lento", no algo puntual de una pantalla.

**Arreglado (item 7):**

- `domain.ts:fetchAll()` -- `vendors` ya NO se trae completa. Se calculan
  los `vendor_id` realmente referenciados por las invoices/órdenes recién
  cargadas y se pide `vendors` con `.in("id", [...])` -- normalmente unas
  pocas decenas, nunca la tabla entera. La única pantalla que de verdad
  necesita navegar TODOS los proveedores (`Suppliers.tsx`) ahora tiene su
  propio fetch independiente (`fetchAllSuppliers`, mismo helper de
  paginación de siempre), pedido una sola vez al entrar a esa pantalla, no
  en cada mutación del resto de la app.
- `purchase_orders` (antes `.select("*")` sin paginar) pasa a usar el mismo
  `fetchAllRows` que ya protegía a `vendors` -- salvaguarda contra el mismo
  truncado silencioso a 1000 filas que ya se encontró antes (hoy 21 filas,
  sin impacto real todavía, es prevención).
- **Medido después**: réplica exacta de la nueva lógica (mismo usuario) --
  **178ms** (antes 2.339ms) -- **13x más rápido**, medido servidor-a-servidor
  (un navegador real ganaría más todavía, al sacarse de encima 10 idas y
  vueltas de latencia de internet que ya no existen).
- No se tocó el patrón de "fetchAll() después de cada mutación" en sí
  (refetchear todo tras aprobar/subir/etc.) -- ese es un cambio mucho más
  grande que toca ~15 funciones de `domain.ts` y las páginas que dependen
  de ellas; se identifica acá como el próximo paso de performance más
  grande disponible, pero se deja fuera de este pase por alcance
  (`cambios mínimos` pedido explícitamente).

**Implementado (item 6 -- filtros server-side de Órdenes de Compra):**

- `rpc_purchase_order_stats` (`schema-v21.sql`, `security invoker`): las 4
  tarjetas de arriba (activas/borradores/pendientes/monto total) ya no se
  calculan sumando sobre filas ya traídas al frontend (no tendría sentido
  con paginación server-side) -- se calculan en la base, respetando RLS
  automáticamente (un proveedor solo ve el agregado de lo suyo).
- `domain.ts:fetchPurchaseOrdersPage` -- pagina (20 por página) y filtra en
  la base: número de orden (`ilike`), estado, rango de fechas, empresa, y
  proveedor (`vendor_id`, solo para admin/superadmin/approver -- el
  selector ni siquiera aparece para un proveedor). El aislamiento de
  proveedor sigue siendo 100% RLS ("scoped read", sin cambios) -- nunca se
  arma un filtro de `vendor_id` a mano para `supplier`/`service_uploader`.
- `Orders.tsx` (`OrdersList`): reescrita para usar lo de arriba en vez del
  store global + filtro en memoria. Buscador con debounce de 350ms (no
  dispara una consulta por tecla). Agrega paginación (Anterior/Siguiente) y
  los filtros de fecha/proveedor que pedía el punto 6.

**Verificado en vivo con 5 casos reales** (JWT real para 3 cuentas
distintas: superadmin, Clickable, Adobe):
1. Admin filtrando por `order_number=ilike.*CP-000221*` → solo esa orden.
2. Stats de admin sin filtro → 21 activas, RD$673.834,13 (coincide con el
   total real de todas las órdenes).
3. Clickable pidiendo TODAS las órdenes sin ningún filtro → RLS le
   devuelve solo sus 2 propias (CP-000216, CP-000221).
4. Stats de Clickable → refleja solo sus 2 órdenes (RD$47.861,98), no el
   total global -- confirma que el RPC `security invoker` respeta RLS de
   verdad, no solo en la lista.
5. **Adobe intentando filtrar explícitamente por el `vendor_id` de
   Clickable** (`?vendor_id=eq...`) → devuelve vacío -- RLS bloquea el
   intento aunque el cliente lo pida directo, no hace falta que el
   frontend "se porte bien" (item 8 del pedido: nunca confiar en lo que
   mande el cliente).

**Desplegado**: `tsc --noEmit && vite build` limpio, `docker compose build
app && up -d`; `rpc_purchase_order_stats` aplicado directo a producción +
`NOTIFY pgrst, 'reload schema'` (PostgREST necesita el aviso para exponer
una función RPC nueva sin reiniciar el contenedor).

**Con esto, los 7 puntos de Prioridad 1 y 2 del pedido de Key Players
quedan implementados y verificados en vivo.** Queda pendiente Prioridad 3
(QA/regression del flujo completo) si Jonatan quiere una pasada dedicada, y
el hallazgo más grande de performance que se deja documentado pero sin
tocar: sacar el patrón de "`fetchAll()` completo después de cada mutación"
del resto de la app (Dashboard, Approvals, Payments, Invoices, Companies) --
mismo tipo de fix que se le acaba de hacer a Orders, pero mucho más
alcance para hacerlo bien en un solo pase.

## 2026-09-01 (continuación) — Ronda de QA (Prioridad 3, pedido Key Players)

Prioridad 3 del pedido: pruebas de flujo completo, permisos entre
proveedores, eliminación/reemplazo, 1 factura por orden, adjuntos,
filtros, y regresión. Se corrió en vivo (no simulado) contra el sandbox
real, con JWT reales para 3 cuentas distintas (Adobe/proveedor,
Clickable/otro proveedor, superadmin), reproduciendo exactamente las
llamadas que hace el frontend (Storage + PostgREST + Edge Functions),
sobre CP-000218 (Adobe, la única orden de los proveedores de prueba sin
ninguna factura activa todavía).

**Hallazgo real antes de empezar** (revisando `bc-export-invoice` para
poder probar el flujo completo): a diferencia de
`invite-user`/`delete-user`/`reset-user-password`/`bc-order-attachments`,
esta función **nunca validaba quién la llama** -- cualquiera con la clave
`anon` (sin sesión de aprobador) podía invocarla directo y crear una
factura real en BC. **Arreglado** antes de seguir: mismo patrón que el
resto (exige Bearer token, valida rol admin/superadmin/approver).

**Secuencia probada (18 de 19 pasos, ver el que faltó abajo):**

1. Subir factura equivocada → detectar el error → eliminarla (archivo +
   fila) → la orden queda libre de nuevo → subir la correcta. Con la
   equivocada todavía activa, un segundo intento de carga fue rechazado
   con `409` por el trigger de 1 OC = 1 Factura.
2. Completar número/fecha/total → confirmar para aprobación (Adobe, dueño
   real). Superadmin aprueba.
3. **Exportar sin token → `401`. Exportar como Clickable (proveedor
   ajeno) → `403`** (confirma el fix de arriba). Exportar como
   superadmin → **funcionó de punta a punta**: factura real creada en BC
   (`CF-001936`), 2 líneas copiadas y vinculadas a la orden,
   `orderSynced: true` -- confirmado que el paso nuevo (item 3) también
   escribió los datos en la Orden de Compra misma, no solo en la factura
   separada.
4. Adjuntos de la orden: `bc-order-attachments` ya lista el PDF recién
   adjuntado (`correcta.pdf`) -- prueba real de round-trip del item 5, no
   solo lectura de una lista vacía como las pruebas anteriores.
5. Aislamiento: Clickable no puede ver los adjuntos de la orden de Adobe
   (`403`), no puede borrar la factura de Adobe (0 filas afectadas por
   RLS), y ni siquiera Adobe puede borrar su propia factura una vez
   aprobada (0 filas -- `scoped delete` solo permite draft/uploaded).
6. Filtros: búsqueda por número de orden sigue funcionando después de
   todos los cambios de hoy.

**El paso que falló, y el hallazgo más importante de la ronda**: en el
paso 2 (regresión de roles), **Adobe -- un proveedor -- pudo llamar
`rpc_update_invoice_status` con `p_status='approved'` sobre su propia
factura, y la aprobación se aplicó de verdad**. Investigado: la función es
`SECURITY DEFINER` (necesario para que un aprobador pueda tocar facturas
de otros proveedores) y por eso corre **sin la RLS de `invoices` de por
medio** -- nunca reimplementaba esa validación de rol por su cuenta.
Además confiaba en `p_changed_by` sin verificar que fuera realmente quien
llama (se podía atribuir el cambio a otro usuario en la auditoría).

**Arreglado** (`schema-v22.sql`): el RPC ahora exige `p_changed_by =
auth.uid()` (nunca otro usuario) y que quien llama sea admin/superadmin, o
approver de la misma empresa de la factura -- mismo criterio que ya usa
`scoped update` para approver. **Reverificado en vivo**: Adobe bloqueado
con el mensaje de rol, intento de suplantación (`p_changed_by` de otro
usuario) bloqueado con su propio mensaje, y el camino legítimo
(superadmin) sigue funcionando sin cambios.

**Nota**: este hallazgo es sobre código **preexistente**, no algo
introducido esta sesión -- es exactamente el tipo de cosa que la ronda de
pruebas de Prioridad 3 estaba pensada para encontrar.

**Queda como evidencia real en el sandbox** (a propósito, no se limpió):
la factura de prueba `QA-E2E-001` (`invoices.id=78bc2afe-8ce9-4a3b-a4be-
11147a1c6a05`) sobre CP-000218, ya `processed`, con su factura real
vinculada en BC (`CF-001936`) y el adjunto `correcta.pdf` en la orden --
es la prueba tangible de que todo el flujo de items 1, 2, 3, 5 y 8
funciona de punta a punta. CP-000218 ya no está "limpia" (tiene 1 factura
activa) para futuras pruebas ad-hoc con la cuenta de Adobe.

**Desplegado**: `bc-export-invoice` (fix de autorización) y
`rpc_update_invoice_status` (`schema-v22.sql`, fix de rol +
suplantación) -- ambos aplicados y verificados en vivo contra producción.

## 2026-09-02 — "El portal solo debe alimentar la Orden, NO debe crear factura en Compras"

Pedido explícito de Jonatan: revertir la decisión del 2026-09-01
("además del flujo actual") -- `bc-export-invoice` deja de crear la
Factura de Compra separada en BC **por completo**. Ya se le había
explicado la implicación real (sin esa factura no hay asiento contable,
ni dato para 606/607/608, ni registro de pago hasta que alguien en
Adsemble arme y postee la factura a mano en BC) antes de tomar la
decisión, así que no se volvió a preguntar -- se implementó directo.

**Reescrito `bc-export-invoice`**: ya no crea `purchaseInvoices`, no
copia líneas, no usa `PurchInvoiceOrderLinkAPI.al`/`PurchInvoiceFiscalAPI.al`
(esos archivos AL quedan sin caller, no se borraron del repo/BC por si
hace falta reactivarlos -- la lógica vieja sigue en el historial de git).
Ahora solo: `orderDate` (estándar) + `vendorInvoiceNumber`/`fiscalDocumentNo`
(`purchaseOrderFiscals`, custom) + adjuntar el PDF, **todo sobre la Orden
de Compra**, nada sobre un documento nuevo. La factura del portal pasa a
`status='exported'` en vez de `'processed'` (`exported` ya estaba en el
enum y la UI ya lo trataba igual que `processed` en todos lados --
badges, stats, Dashboard -- no hizo falta tocar pantallas para eso).

**Regresión encontrada y arreglada de encimada**: `Invoices.tsx` (card de
Pagos), `Payments.tsx` (listado) y `PaymentStatusBadge.tsx` exigían
`status === "processed"` a mano -- con el cambio, ninguna factura nueva
iba a volver a mostrar el tracking de pago nunca más. Se acepta
`"exported" || "processed"` en los 3 lugares (las 8 facturas reales que
ya llegaron a `processed` con el flujo viejo se siguen viendo bien).
Mismo problema en `rpc_mark_invoice_paid` (exigía `status = 'processed'`
en el `WHERE` de la base) -- arreglado en `schema-v23.sql`.

**Hallazgo de seguridad grave, encontrado revisando el resto de RPCs
`SECURITY DEFINER` por el mismo patrón del fix de ayer**
(`rpc_update_invoice_status`): la MAYORÍA de las funciones de escritura
validaban el rol de un `p_user_id`/`p_changed_by` que manda el propio
cliente en el body, nunca `auth.uid()`. Cualquiera logueado -- hasta un
proveedor -- podía pasar el id de un admin conocido (no hace falta su
password) como ese parámetro para que la función creyera que quien
llama tiene ese rol. **El caso más grave: `rpc_update_user_profile`
permitía escalación de privilegios completa** -- pasar el id de un admin
conocido como `p_changed_by` y `p_target_user_id` = uno mismo alcanzaba
para auto-promoverse a superadmin. Arreglado en `rpc_confirm_purchase_order`,
`rpc_update_user_profile` y `rpc_confirm_invoice_for_approval` (mismo
criterio: exigir que el parámetro de "quien lo pide" sea siempre
`auth.uid()`), todo en `schema-v23.sql`.

**Bonus del mismo repaso**: `update_invoice_data` (RPC vieja, `SECURITY
DEFINER`, upsert libre sobre `invoices` sin NINGUNA validación de rol)
resultó estar **huérfana** -- grep completo del repo sin un solo caller,
ni frontend ni Edge Function. Como nadie la usa, se eliminó en vez de
arreglarla (`drop function`, `schema-v23.sql`) -- menos superficie de
ataque que mantener viva una función sin dueño.

**Verificado en vivo, 8/8 casos**: los 3 intentos de suplantación
bloqueados (incluida la escalación a superadmin), `update_invoice_data`
confirmada inexistente, y el flujo completo nuevo probado de punta a
punta sobre una orden limpia (CP-000219, UNPREDATOR LLC) -- exportar
devuelve `{ok:true, orderNumber, attached}` sin ningún campo de factura
BC, la factura del portal queda `exported` con `bc_invoice_id` null, los
campos de la orden en BC se actualizan de verdad (confirmado por
lectura directa), y **no se creó ninguna `purchaseInvoice` para ese
proveedor** (verificado filtrando por `vendorNumber` en BC, lista
vacía). Datos de prueba revertidos por completo despues (orden vuelta a
su fecha original, campos fiscales vueltos a vacío, factura de prueba
borrada) -- CP-000219 sigue "limpia" para uso real.

**Desplegado**: `bc-export-invoice` reescrito, `domain.ts`/`Exports.tsx`
(nuevo shape de respuesta: `orderNumber` en vez de `bcInvoiceNumber`,
sin `orderSynced`), `Invoices.tsx`/`Payments.tsx`/`PaymentStatusBadge.tsx`
(aceptan `exported`), `schema-v23.sql` (4 fixes de seguridad + el fix de
`processed`→`exported`) -- todo aplicado y verificado en vivo.

---

## 2026-09-02 — Requerimiento adicional: ocultar "Solicitar cambio" tras confirmar la orden

**Pedido de Jonatan**: "luego de que el suplidor confirme la orden el boton
de solicitar cambio deberia de ocultarse por que una vez confirmada la
orden no puede mandar a cambiar".

**Frontend** (`Orders.tsx`, `OrderDetail`): el botón "Solicitar cambio" y
su formulario ahora solo se renderizan cuando
`order.confirmationStatus !== "confirmed"`. El botón "Confirmar" se deja
visible sin cambios (no fue parte del pedido).

**Backend** (`schema-v24.sql`): ocultar el botón en el frontend es solo
cosmético -- `rpc_confirm_purchase_order` es el único camino de escritura
real de este campo y no validaba el estado *actual* de la orden antes de
aplicar la acción, así que cualquiera podía seguir llamando la RPC
directo (`/rest/v1/rpc/rpc_confirm_purchase_order`) con
`p_action='change_requested'` sobre una orden ya confirmada. Se agregó la
validación: si `confirmation_status = 'confirmed'` y se pide
`change_requested`, la función lanza excepción.

**Verificado en vivo**: simulando el RPC como usuario `authenticated`
(dentro de una transacción con `rollback`, sin tocar datos reales) contra
una orden real ya confirmada -- bloqueado con
`ERROR: la orden ya esta confirmada, no se puede solicitar un cambio`.

**Desplegado**: `schema-v24.sql` aplicado + `NOTIFY pgrst, 'reload
schema'`; `Orders.tsx` reconstruido y desplegado (`docker compose build
app && up -d`), bundle nuevo confirmado en `proveedores.jfmcss.com`
(`index-CoaFEjcs.js`).

---

## 2026-09-02 — Requerimiento adicional: deshabilitar "Confirmar orden" tras confirmar

**Pedido de Jonatan**: "cuando la orden ya este confirmada el boton de
Confirmar orden se deshabilite por que ahora me permite darle una y otra
vez, sin necesidad".

**Frontend** (`Orders.tsx`): el botón "Confirmar orden" ahora se
deshabilita (`disabled`) cuando `order.confirmationStatus === "confirmed"`
-- sigue visible (a diferencia de "Solicitar cambio", que se oculta) pero
ya no se puede volver a hacer click.

**Backend** (`schema-v25.sql`): mismo criterio de defensa en profundidad
que `schema-v24.sql` -- se generaliza el check para que
`rpc_confirm_purchase_order` rechace CUALQUIER acción (no solo
`change_requested`) una vez la orden ya está `confirmed`. Sin esto, cada
click de más -- o una llamada directa al RPC -- insertaba otra fila en
`purchase_order_confirmations`, ensuciando el historial sin necesidad.

**Verificado en vivo**: simulando el RPC como usuario `authenticated`
(transacción con `rollback`) contra una orden real ya confirmada,
pidiendo `p_action='confirmed'` de nuevo -- bloqueado con `ERROR: la
orden ya esta confirmada, no se puede modificar la confirmacion`.

**Desplegado**: `schema-v25.sql` aplicado + `NOTIFY pgrst, 'reload
schema'`; `Orders.tsx` reconstruido y desplegado, bundle nuevo confirmado
en `proveedores.jfmcss.com` (`index-DjwM9Q83.js`).

---

## 2026-09-02 (continuación) — Órdenes pendientes de aprobación en BC se colaban al portal, ya trabajables

**Reporte de Jonatan**: "las ordenes de compra pendientes de aprobacion en
BC me aparecen en el Portal y hasta me permite trabajarlas cosa que no
deberia ser, las ordenes de compra que deben aparecer y permitirme
trabajar desde el portal deben ser las aprobadas".

**Causa raíz confirmada en vivo**: `bc-sync-orders` ya excluía las órdenes
en `Draft` desde el 21/08, pero el mapeo de "Pendiente de aprobación"
tenía un bug de encoding -- BC devuelve ese estado como el string crudo
`In_x0020_Review` (OData escapa el espacio del nombre del enum así), pero
`STATUS_MAP` tenía la clave `"In Review"` con espacio literal. Nunca
hacía match, así que `STATUS_MAP[order.status] ?? "open"` caía siempre al
fallback `"open"` -- una orden pendiente de aprobar en BC quedaba
sincronizada y **totalmente trabajable** (confirmar, subir factura) desde
el portal, indistinguible de una ya aprobada.

**Evidencia real, no solo del código**: 2 órdenes de prueba de Jonatan
(`CP-000222`, `CP-000223`, vendor `PROV-000278`) con
`status="In_x0020_Review"` en BC estaban guardadas como `status="open"`
en el portal. `CP-000223` ya se había usado de punta a punta: confirmada,
factura `FAC-2026-0902-001` subida y **exportada** -- como la exportación
ya no crea factura en BC (solo actualiza la orden), esto ya había escrito
`vendorInvoiceNumber`/`fiscalDocumentNo`/PDF adjunto en la orden real de
BC, todavía pendiente de aprobar internamente.

**Arreglado**: `bc-sync-orders/index.ts` -- se corrigió la constante al
valor crudo real (`STATUS_PENDING_APPROVAL = "In_x0020_Review"`) y se
extendió la misma exclusión que ya aplicaba a `Draft` (decisión de
Jonatan del 21/08) para que también cubra pendiente de aprobación --
ninguna de las dos llega al portal hasta que BC la apruebe. Campo de
respuesta renombrado `skippedDrafts` → `skippedNotApproved` (ahora cubre
ambos casos). Verificado en vivo: `"skippedNotApproved":2` en la corrida
real tras desplegar.

**Limpieza de los 2 casos ya contaminados** (confirmada con Jonatan vía
pregunta explícita -- "Borrar todo"):
- `CP-000222` (sin factura ni confirmación): fila borrada del portal.
- `CP-000223`: borrados del portal la factura, su historial de estados,
  las 2 confirmaciones y la orden; borrado el PDF huérfano de Storage; **y
  revertido en BC** -- `vendorInvoiceNumber`/`fiscalDocumentNo` vueltos a
  vacío vía `PATCH` a `purchaseOrderFiscals`, adjunto eliminado (`DELETE
  .../attachments(...)`, confirmado `204`). Verificado que ambas órdenes
  ya no existen en `purchase_orders` del portal.

**Desplegado**: `bc-sync-orders` (solo backend, sin cambios de frontend)
copiado al servidor y `docker compose restart functions`.

---

## 2026-09-02 (continuación) — Ronda de QA en el portal real (superadmin, navegador)

Jonatan pidió `/qa`. Login sin password (magic link admin), recorridas las
11 secciones del nav como superadmin real contra `proveedores.jfmcss.com`.
4 bugs reales encontrados y corregidos, cada uno desplegado y
re-verificado en vivo (capturas antes/despues en
`.gstack/qa-reports/screenshots/`, reporte completo en
`.gstack/qa-reports/qa-report-proveedores-jfmcss-com-2026-09-02.md`):

1. **14 claves de `es.json` en ingles pese a existir traduccion Spanish**
   (nav "Invoices"/"Users"/"Suppliers", tarjetas del Dashboard
   "Recent invoices"/"Company context"/etc.) -- confirmado que otras ~80
   claves en ingles del mismo archivo son huerfanas (Login.tsx/
   SetPassword.tsx no usan i18n, ya estan hardcodeadas en español), asi
   que no se tocaron.
2. **`StatusBadge` mostraba el enum crudo** ("approved"/"processed"/
   "uploaded"...) en vez de traducido -- afecta Dashboard, Approvals,
   Exports e Invoices (mismo componente compartido).
3. **`/suppliers` inflado con empresas deshabilitadas**: "10,441
   proveedores, 10,440 bloqueados" -- parecia que casi todo el padron
   estaba bloqueado. Causa real: `fetchAllSuppliers()` traia `vendors`
   sin filtrar por empresa; 6,946 filas eran de `DUCKTAPE MEDIA GROUP` y
   `JUAN FABIAN`, deshabilitadas el 2026-08-29. Con el fix: 3,495 (el
   numero real, ya confirmado antes en esta bitacora). Aprendizaje
   registrado: RLS da acceso irrestricto a admin/superadmin/approver
   sobre TODAS las companies sin importar `disabled_at` -- cualquier
   fetch nuevo tiene que filtrar por empresa activa a mano.
4. **`/audit` mostraba "Estado: pending_approval/paid/export_error"
   crudo** -- faltaban esos 3 en `STATUS_MESSAGE_KEY`, completado con
   mensajes en español (uno nuevo reusa `invoiceConfirmedForApprovalAudit`
   ya existente, 2 mensajes nuevos agregados a `es.json`/`en.json`).
5. **Deferido y luego tambien corregido** (Jonatan confirmo "si"):
   `/exports` mostraba filas sin numero de factura visible para facturas
   recien cargadas -- mismo fallback al id corto que ya usa `Invoices.tsx`.

**Fuera de esta ronda** (ya corregido antes de correr `/qa`, misma
sesión): los 4 cron de sync corrian cada minuto en vez de 15/30/360 min.

**Commits**: `ddb589e` (i18n + StatusBadge), `457fd5f`
(fetchAllSuppliers), `d1ebf22` (Audit.tsx), `c4ece86` (Exports.tsx) --
pusheados a `origin/main`.
