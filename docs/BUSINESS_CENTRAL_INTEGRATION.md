# Integración con Business Central

> Reemplaza una versión anterior escrita antes de tener acceso confirmado al
> tenant de BC. Esto documenta lo que está **verificado en código real**
> (`infra/supabase/functions/`), no un plan especulativo.

## 1. Principio

Todo el acceso a BC pasa por la **API REST de Business Central v2.0**
(`api.businesscentral.dynamics.com`), autenticado por OAuth2 client-credentials
contra Microsoft Entra ID. Nunca acceso directo a base de datos. Todo el
código que habla con BC vive en Edge Functions (`infra/supabase/functions/`),
nunca se llama a BC desde el frontend.

## 2. Auth — confirmado y funcionando

```
BC_TENANT_ID=
BC_CLIENT_ID=
BC_CLIENT_SECRET=
BC_ENVIRONMENT=        # validado contra sandbox "Test672026"
BC_COMPANY_ID=
```

Configuradas en `supabase/.env` en el servidor (nunca versionadas). El cliente
compartido `_shared/bc-client.ts` cachea el token y lo refresca antes de que
expire (`getAccessToken`).

## 3. Cliente (`_shared/bc-client.ts`)

Funciones: `bcGet`, `bcGetAll` (sigue `@odata.nextLink` para paginar),
`bcPost`, `bcAttachFile` (adjuntos vía `attachmentContent`, confirmado en
sandbox — la API v2.0 no usa `/content` como otras APIs OData de BC).

## 4. Entidades — estado confirmado

| Entidad | Estado | Uso actual |
|---|---|---|
| `purchaseOrders` + `purchaseOrderLines` | ✅ Confirmado, en uso | `bc-sync-orders` — sync BC → Supabase |
| `purchaseInvoices` (crear cabecera + líneas + adjunto) | ✅ Confirmado, en uso | `bc-export-invoice` — sync Supabase → BC |
| `vendors` | Sin sync dedicado hoy | los vendors se crean al vuelo desde `bc-sync-orders`, no hay un `bc-sync-vendors` propio todavía |
| Recepciones (`purchaseReceipts`) | **No confirmado para este tenant** | pendiente — necesario para "confirmación de órdenes" y three-way matching |
| Vendor Ledger Entries / pagos | **No confirmado para este tenant** | pendiente — bloqueante para "consulta de pagos y estado de cuenta" |

Nota importante confirmada en sandbox: el campo `orderId` de `purchaseInvoices`
es de solo lectura en la API v2.0 ("Control 'orderId' is read-only") — no se
puede vincular la factura a la orden seteando ese campo al crearla. La
"plantilla de la orden de compra" que pide el negocio se logra copiando
`vendor` + líneas de la PO ya sincronizada hacia la factura (ver
`bc-export-invoice/index.ts`), no vinculando por `orderId` en BC.

## 5. Flujo de exportación de factura (Portal → BC) — implementado

1. Factura llega a `approved` (o `ready_for_export`) en el portal.
2. Se valida que tenga `purchase_order_id` y que esa orden ya tenga `bc_id`
   (sincronizada por `bc-sync-orders`) — si no, la factura pasa a
   `export_error` con motivo explicado.
3. `POST /purchaseInvoices` (cabecera: vendor, fecha, NCF).
4. Por cada línea de la PO sincronizada: `POST .../purchaseInvoiceLines`.
5. Si hay PDF en Storage: se descarga y se adjunta vía `bcAttachFile`.
6. Éxito: se guarda `bc_invoice_id`/`bc_invoice_number`/`erp_id`, estado →
   `processed`. Falla: estado → `export_error` con el motivo, reintentable
   desde `/exports`.

## 6. Sincronización de órdenes (BC → Portal) — implementado

`bc-sync-orders`: trae todas las `purchaseOrders` + líneas, upsert idempotente
por `bc_id` en `purchase_orders`, y **reemplaza** las líneas en cada corrida
(`delete` + `insert`) en `purchase_orders_lines`. Resuelve/crea el `vendor_id`
por `vendor_number` si no existe.

**Pendiente:** no hay cron/schedule — es invocación manual hoy. Ver
`IMPLEMENTATION_PLAN.md`.

## 7. Lo que falta para cerrar el alcance comprometido

- **Confirmación de órdenes de compra**: no hay endpoint de BC identificado
  para esto todavía — evaluar si existe una acción bound (`Microsoft.NAV.*`)
  o si queda como registro solo-portal (nunca escribe a BC directo, como
  hacía el plan original).
- **Pagos / estado de cuenta**: requiere confirmar si el tenant expone
  `vendorLedgerEntries` o si hace falta una Custom API page (extensión AL) —
  este es el mismo tipo de brecha que ya se resolvió para `purchaseOrders`,
  pero aún no se ha hecho el descubrimiento para pagos.
- **Sync de perfil de vendor** (dirección, contacto, términos de pago): no
  confirmado qué campos expone `vendors` para este tenant más allá de lo ya
  usado (`vendorNumber`).
