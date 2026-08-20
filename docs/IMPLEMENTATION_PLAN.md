# Plan de implementación

> Reemplaza un plan anterior (Next.js + Prisma, fases 0-7 genéricas) escrito
> antes de que existiera código real. Esto mapea el trabajo que falta contra
> el **compromiso enviado a Adsemble por correo**: 15 días hábiles, alcance y
> cronograma específicos. El avance real fecha por fecha vive en
> `BITACORA.md` — este documento es el plan, no el registro.

Stack real: ver `VENDOR_PORTAL_ARCHITECTURE.md`. El reloj de los 15 días
hábiles **no ha arrancado** al momento de escribir esto — se usa el margen
para cerrar brechas de seguridad/alcance sin presión, de modo que cuando
arranque, el proyecto ya vaya adelantado en vez de empatado.

## Pre-trabajo (no cuenta contra los 15 días)

- [x] Código real puesto en git y en GitHub (este repo, carpetas `app/` e `infra/`).
- [x] Documentación reescrita para reflejar la arquitectura real.
- [x] Rol interno `service_uploader` agregado (`app/schema-v3.sql` + `types.ts`
      + `FeatureGuard.tsx` + `Users.tsx` + `Orders.tsx`) — 2026-08-20.
- [x] RLS real por `company_id`/`vendor_id` reemplazando "authenticated
      read-all", verificado con sesiones simuladas y desplegado — 2026-08-20,
      ver `BITACORA.md`.

## Días 1-2 — Confirmación técnica con BC + arranque

**Ya cumplido de sobra:** cliente OAuth2 validado en vivo contra el sandbox
`Test672026` (`_shared/bc-client.ts`), `purchaseOrders` y `purchaseInvoices`
confirmados y en uso real.

Falta cerrar en este bloque:
- Confirmar con Adsemble/BC si existen `purchaseReceipts` y
  `vendorLedgerEntries` para este tenant (necesarios para confirmación de
  órdenes y para pagos/estado de cuenta — ver `BUSINESS_CENTRAL_INTEGRATION.md §7`).
- Kickoff formal: acceso a un proveedor real de prueba, decisión de dominio
  final (`portalproveedores.adsemble.do` vs `proveedores.jfmcss.com`).

## Días 3-6 — Auth, roles, aislamiento, sync de proveedores

- ~~Rol interno para facturas de proveedores recurrentes~~ y ~~RLS real por
  proveedor~~ — cerrados en pre-trabajo (2026-08-20).
- Perfil de proveedor sincronizado completo (dirección, contacto, términos
  de pago) — condicionado a qué campos exponga BC (Días 1-2).
- Sync de proveedores con su propio schedule (hoy nace implícito dentro de
  `bc-sync-orders`).

## Días 7-9 — Órdenes de compra

- Botón de **confirmación de orden** (Confirmar / Solicitar cambio) en
  `OrderDetail.tsx` — hoy no existe ninguna acción, solo lectura + carga de
  factura. Si BC no expone una acción de confirmación real, queda como
  registro solo-portal (nunca escribe a BC directo sin validación).
- Automatizar `bc-sync-orders` con cron/schedule (hoy manual).
- Mostrar recepciones en el detalle de orden, si BC las expone para este
  tenant (Días 1-2 lo determina).

## Días 10-13 — Facturas

- Validación real de factura: duplicado por `(vendor_id, invoice_number)`,
  monto/cantidad coherente contra la orden vinculada — hoy está
  explícitamente omitida en el código.
- SMTP real (hoy: mailer fake de desarrollo `supabase-mail`) para que
  aprobación/rechazo y credenciales de acceso lleguen de verdad.
- QA del flujo completo carga → aprobación → export a BC, contra un caso
  real (no solo sandbox).

## Días 13-15 — Pagos, estado de cuenta, UAT, arranque

- Nuevo estado `pending_payment`/`paid` en `invoices.status` + campo de
  fecha posible de pago.
- Sync de pagos/vendor ledger desde BC (condicionado a la confirmación de
  Días 1-2).
- Página de consulta de pagos + estado de cuenta.
- UAT con un proveedor real.
- Corte de dominio/DNS y arranque.

## Bugs legacy conocidos (heredados del portal anterior)

Documentados en `extraido/02-rutas-y-modulos.md`. El rewrite ya corrige el
más grave (líneas de orden "SIN DATOS"). Falta una pasada de QA explícita
que confirme uno por uno los demás (KPI de usuarios gestionados, tarjeta de
proveedores sin título, overflow en estado vacío de aprobaciones, código de
empresa mostrando el GUID crudo de BC, acentos en español) contra la UI
actual — no se ha hecho esa verificación todavía.
