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
