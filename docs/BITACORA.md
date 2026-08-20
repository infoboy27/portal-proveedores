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
