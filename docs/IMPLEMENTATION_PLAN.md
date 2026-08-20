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

- [x] **Confirmación de orden** (Confirmar / Solicitar cambio) en
      `OrderDetail.tsx` — 2026-08-20. Registro solo-portal (`app/schema-v4.sql`),
      nunca escribe a BC directo — ver `BITACORA.md`.
- [x] `bc-sync-orders` automatizada por cron cada 15 min — 2026-08-20, ver
      `infra/supabase/scripts/` y `BITACORA.md` (incluye nota de rendimiento
      N+1 a revisar antes de escalar a datos reales de BC).
- [x] Mostrar recepciones en el detalle de orden — 2026-08-20, ver Días
      13-15 (se cerró junto con el resto del cableado a BC).

**Días 7-9 completos.**

## Días 10-13 — Facturas

- [x] Validación real de factura: duplicado por `(vendor_id, invoice_number)`
      (índice único + chequeo previo con mensaje) y monto contra la orden
      vinculada — 2026-08-20, ver `BITACORA.md`. Cantidad por línea queda
      fuera de alcance porque no existe formulario de líneas de factura en
      este rebuild (documentado en el código, no es un olvido).
- [x] SMTP real (Microsoft 365, `soporte@adsemble.do`) — 2026-08-20,
      confirmado con un envío real recibido y verificado visualmente. Ver
      `BITACORA.md`. **Días 10-13 completos.**
- QA del flujo completo carga → aprobación → export a BC, contra un caso
  real (no solo sandbox).

## Días 13-15 — Pagos, estado de cuenta, UAT, arranque

- [x] Estado de pago por factura (`paid_at`/`payment_reference`, derivado
      sin agregar valor nuevo a `invoices.status`) + fecha posible de pago
      (ya existía) — 2026-08-20, ver `BITACORA.md`.
- [x] Página de consulta de pagos (`/payments`) — 2026-08-20.
- [x] Sync de pagos/vendor ledger desde BC (`bc-sync-payments`, Custom API
      propia, cron cada 30 min) — 2026-08-20. Corre y empareja
      correctamente, pero **todavía sin un match confirmado con una
      factura real posteada** — ver `BITACORA.md`, pendiente de una prueba
      end-to-end completa.
- [x] Recepciones en el detalle de orden (`bc-sync-receipts`, cron cada 15
      min) — 2026-08-20, adelantado desde Días 7-9 una vez confirmado el
      endpoint.
- **No incluido, y no es un olvido**: estado de cuenta completo (saldo
  inicial, notas de crédito, saldo corriente). Lo construido es "consulta
  de pagos por factura" — un estado de cuenta real necesitaría agregación
  histórica de `vendorLedgerEntries` más allá de lo que este alcance pedía.
- UAT con un proveedor real — requiere que Adsemble facilite acceso a un
  proveedor real de prueba.
- Corte de dominio/DNS y arranque — requiere decisión de Adsemble sobre
  `portalproveedores.adsemble.do` vs `proveedores.jfmcss.com` y fecha.

## Bugs legacy conocidos (heredados del portal anterior)

[x] QA hecha — 2026-08-20, ver `BITACORA.md`. De los 8 documentados en
`extraido/02-rutas-y-modulos.md`: 2 ya estaban resueltos (líneas de orden,
NCF), 2 se reprodujeron y se corrigieron en esta pasada (tarjeta de
proveedores sin título, código de empresa mostrando el GUID interno en vez
de `bc_code`), 1 se "resolvió" quitando la funcionalidad en vez de
arreglarla (mensaje de auditoría sin número de orden — pendiente si
Adsemble lo quiere de vuelta), 1 sin reproducir pero con código vestigial
(KPI de dashboard), 1 sin verificar (overflow en Aprobaciones — necesita
navegador real, no solo lectura de código), y los acentos en español
siguen sin abordar (nunca estuvo en el alcance de los 15 días).
