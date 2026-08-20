# Esquema de tablas y funciones RPC

Reconstruido por ingeniería inversa del bundle. Las columnas marcadas ✅ están **confirmadas**
(aparecen en llamadas reales a Supabase); las marcadas ~ son **inferidas** por el uso en la UI.

## Tablas

### `invoices` — facturas
Columnas confirmadas por el payload de `update_invoice_data`:

| Columna | Notas |
|---------|-------|
| `id` / `invoice_id` ✅ | PK |
| `company_id` ✅ | FK → companies |
| `purchase_order_id` ✅ | FK → purchase_orders |
| `vendor_name` ✅ | nombre del proveedor |
| `vendor_tax_id` ✅ | RNC del proveedor |
| `invoice_number` ✅ | número de factura |
| `invoice_tax_number` ✅ | **NCF** (hoy mal extraído: sale igual al número) |
| `invoice_tax_security_number` ✅ | código de seguridad fiscal |
| `invoice_date` ✅ | fecha de factura |
| `invoice_duedate` ✅ | vencimiento |
| `fiscal_duedate` ✅ | vencimiento fiscal |
| `subtotal_amount` ✅ | |
| `discount_amount` ✅ | |
| `total_tax_amount` ✅ | impuestos |
| `total_amount` ✅ | total |
| `status` ✅ | ver ciclo de estados abajo |
| `file_path` ✅ | ruta del PDF en Storage |
| `filename` ✅ | nombre del PDF |
| `valid_tax_number` ✅ | validación NCF |
| `valid_invoice_tax_number` ✅ | validación NCF factura |
| `rejection_reason` ✅ | motivo de rechazo |
| `changed_by_user_id` ✅ | último usuario que modificó |
| `created_at` ~ / `updated_at` ~ | timestamps |

### `invoice_lines` — líneas de la factura
`id`, `invoice_id` ✅, descripción, cantidad, precio, monto ~

### `invoice_status_history` — auditoría / trazabilidad
`invoice_id` ✅, `status` ✅, `changed_by` ✅, `reason` ✅, `changed_at` ✅ (se ordena por este campo)

### `purchase_orders` — órdenes de compra (desde BC)
`id` ✅, `company_id` ✅, `vendor_id` ✅, número de OC, `order_date` ~, monto ~, `status` ~, `sequence` ✅ (orden)

### `purchase_orders_lines` — líneas de la orden
`order_id` ~, descripción, cantidad, precio, monto ~ · *(hoy no se sincronizan → "SIN DATOS" en la UI)*

### `vendors` — proveedores
`id` ✅, `vendor_number` ✅, `tax_registration_number` ✅ (RNC), `company_name` ✅ (orden), `status` ✅, `valid_invoice_tax_number` ✅

### `companies` — empresas
`id` ✅, `company_name` ✅ (orden), código/GUID de BC ~

### `user_profiles` — usuarios del portal
`id` ✅, `username` ✅, `email` ✅, `role` ✅ (admin / approver / supplier), activo ~, último acceso ~

### `user_vendor_mapping` — vínculo usuario ↔ proveedor
`user_id` ✅, `vendor_id` ✅, `company_id` ✅, `is_primary` ✅

## Ciclo de estados de la factura (`status`)

```
draft → uploaded → pending_approval → approved → ready_for_export → exported
                                    ↘ rejected            ↘ export_error
```

Colores en la UI: draft=gris, uploaded=azul, pending_approval=ámbar, rejected=rojo,
approved=verde, ready_for_export=violeta, exported=teal, export_error=rojo.

## Funciones RPC (Postgres)

### `rpc_update_invoice_status`
Cambia el estado de una factura y registra la auditoría.
```
rpc_update_invoice_status(
  p_invoice_id,   -- uuid
  p_status,       -- enum de estado
  p_changed_by,   -- usuario
  p_reason        -- motivo (null si no aplica)
)
```

### `update_invoice_data`
Guarda/actualiza los datos de una factura (tras la extracción/edición).
```
update_invoice_data(
  p_user_id,      -- uuid
  p_invoice { ... }  -- objeto con todas las columnas de invoices listadas arriba
)
```
