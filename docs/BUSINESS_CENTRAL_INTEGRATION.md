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
| `purchaseOrders` + `purchaseOrderLines` | ✅ Confirmado, en uso (API estándar) | `bc-sync-orders` — sync BC → Supabase |
| `purchaseInvoices` (crear cabecera + líneas + adjunto) | ✅ Confirmado, en uso (API estándar) | `bc-export-invoice` — sync Supabase → BC |
| `vendors` | Sin sync dedicado hoy | los vendors se crean al vuelo desde `bc-sync-orders`, no hay un `bc-sync-vendors` propio todavía |
| `purchaseReceipts` (recepciones) | ✅ Confirmado, en uso — **Custom API propia** (`infra/business-central/`, publicada en `Test672026` el 2026-08-20, no existe en la API estándar para este tenant) | `bc-sync-receipts` — sync BC → Supabase, mostrado en `OrderDetail` |
| `vendorLedgerEntries` (pagos) | ✅ Confirmado, en uso — **Custom API propia**, misma extensión | `bc-sync-payments` — sync BC → Supabase, reemplaza el estado de pago manual cuando hay match |

Las dos Custom API pages viven bajo un prefijo distinto al de la API
estándar: `/api/adsemble/vendorPortal/v1.0/` en vez de `/api/v2.0/`.
`_shared/bc-client.ts` soporta ambos (parámetro `api: "standard" | "custom"`
en `bcGet`/`bcGetAll`).

**Hallazgo importante al conectar `bc-sync-payments` con datos reales**: el
número de documento que `bc-export-invoice` recibe al crear la factura
borrador (`purchaseInvoices.number`, guardado en `invoices.bc_invoice_number`)
es de una serie **distinta** a la del asiento contable una vez posteado
(`vendorLedgerEntries.documentNo`) — confirmado en vivo: `CF-001918`
(borrador) vs. `CFR-000001` (posteado). Emparejar por esos campos nunca
hubiera funcionado. El campo que sí sobrevive el posteo es
`externalDocumentNo` (= "Vendor Invoice No." que se manda al crear la
factura) — `bc-sync-payments` empareja por ahí primero, usando
`bc_invoice_number`/`documentNo` solo como respaldo.

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

Automatizada por cron cada 15 min desde 2026-08-20.

## 7. Lo que falta para cerrar el alcance comprometido

- ~~Confirmación de órdenes de compra~~ — resuelto como registro solo-portal
  (nunca escribe a BC directo), no había acción bound identificada para esto.
- ~~Pagos / estado de cuenta~~ — resuelto: `vendorLedgerEntries` vía Custom
  API propia (`infra/business-central/`), publicada y confirmada en
  `Test672026` el 2026-08-20.
- **Sync de perfil de vendor** (dirección, contacto, términos de pago): no
  confirmado qué campos expone `vendors` para este tenant más allá de lo ya
  usado (`vendorNumber`).
