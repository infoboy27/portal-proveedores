# Esquema de base de datos

> Reemplaza una versión anterior escrita para un esquema Prisma nunca
> implementado. Esto documenta el esquema **real** en `app/schema.sql`
> (Postgres, dentro del Supabase self-hosted).

## Tablas

### `companies`
`id, company_name, bc_code, disabled_at`

### `vendors`
`id, vendor_number, tax_registration_number, company_name, status, valid_invoice_tax_number`

Se crea al vuelo desde `bc-sync-orders` cuando llega una orden de un proveedor
nuevo. **No tiene perfil completo** (dirección, contacto, teléfono, términos
de pago) — pendiente si Business Central expone esos campos para este tenant.

### `purchase_orders`
`id, company_id→companies, vendor_id→vendors, order_number, order_date, amount, status, sequence`

`status`: `draft | open | in_review | partially_invoiced | closed`.

### `purchase_orders_lines`
`id, order_id→purchase_orders, company_id, description, quantity, price, amount, sequence`,
más columnas agregadas para la exportación a BC: `bc_line_type`,
`bc_line_object_number`, `bc_unit_cost`, `bc_tax_code`. Se sincronizan desde
BC vía `bc-sync-orders` (se borran y reinsertan en cada corrida — no hay
merge incremental de líneas).

### `invoices`
`id, company_id, purchase_order_id, vendor_id, vendor_name, vendor_tax_id, invoice_number, invoice_tax_number (NCF), invoice_tax_security_number, invoice_date, invoice_duedate, fiscal_duedate, subtotal_amount, discount_amount, total_tax_amount, total_amount, status, file_path, filename, valid_tax_number, valid_invoice_tax_number, rejection_reason, erp_id, bc_invoice_id, bc_invoice_number, export_error_reason, exported_at, payment_due_date, changed_by_user_id, created_at, updated_at`

`status`: `draft → uploaded → pending_approval → approved → ready_for_export → exported/processed`,
con ramas a `rejected` y `export_error`.

`payment_due_date` existe como campo manual (`setInvoicePaymentDueDate` en
`domain.ts`) — un admin lo llena a mano porque la API estándar de BC no
expone vendor ledger entries. **Lo que falta** es el estado
`pending_payment`/`paid` en el enum de `status` y una página de consulta de
pagos/estado de cuenta — brecha real frente al compromiso (ver `BITACORA.md`).

**No hay constraint de duplicado** sobre `(vendor_id, invoice_number)` — la
validación de factura duplicada, monto y cantidad contra la orden está
pendiente (el código tiene un comentario explícito: "se omite el flujo de
factura duplicada").

Nota de higiene: estas cinco columnas (`bc_invoice_id`, `bc_invoice_number`,
`export_error_reason`, `exported_at`, `payment_due_date`) existían en la
base viva pero nunca se habían capturado en un archivo de migración hasta
`app/schema-v3.sql` (2026-08-20) — deriva de esquema real, confirmada con
`pg_dump --schema-only` contra la base de producción interna.

### `invoice_lines`
`id, invoice_id→invoices, company_id, description, quantity, price, amount, sequence`

### `invoice_status_history`
`id, invoice_id→invoices, status, changed_by, reason, changed_at` — auditoría
del ciclo de vida de la factura, poblada por la RPC `rpc_update_invoice_status`.

### `user_profiles`
`id (=auth.users.id), username, email, role, company_id→companies, active, last_login`

`role` — `check` constraint: `admin | superadmin | approver | supplier | service_uploader`.
`service_uploader` es el rol interno para carga de facturas de proveedores
recurrentes de servicios (agregado en `app/schema-v3.sql`).

### `user_vendor_mapping`
`user_id→user_profiles, vendor_id→vendors, company_id, is_primary` — vínculo
usuario-proveedor (un `supplier` puede estar mapeado a uno o más vendors).

## Funciones RPC

### `rpc_update_invoice_status(p_invoice_id, p_status, p_changed_by, p_reason)`
Cambia el estado de una factura y registra el historial. Usada por
`approveInvoice`/`rejectInvoice` en `store/domain.ts`.

### `update_invoice_data(p_user_id, p_invoice jsonb)`
Upsert de una factura completa (usada al cargar/editar datos de factura).

## Row Level Security — estado real

Cerrado en `app/schema-v3.sql` (2026-08-20, ver `BITACORA.md`). Todas las
tablas tienen RLS habilitado con políticas escopadas por rol/empresa/vendor
(no más `authenticated read-all`), usando tres funciones `SECURITY DEFINER`:

```
portal_role()        -- role del usuario autenticado
portal_company_id()  -- company_id del usuario autenticado
portal_vendor_ids()  -- vendor_id(s) mapeados via user_vendor_mapping
```

Reglas: `admin`/`superadmin` sin restricción; `approver` filtrado por
`company_id`; `supplier`/`service_uploader` filtrado por `portal_vendor_ids()`.
`invoices` UPDATE además bloquea que un proveedor mueva su propia factura
más allá de `pending_approval` por REST directo (solo la RPC y la Edge
Function con `service_role` pueden hacerlo). `user_profiles` ganó su primera
política UPDATE (antes no existía ninguna, así que `Users.tsx` no podía
guardar cambios de rol).

## Mapeo con el esquema legacy (Supabase del proveedor original)

| Legacy | Actual | Nota |
|---|---|---|
| `user_profiles.role` | igual, mismo nombre de tabla | se reconstruyó 1:1 |
| `user_vendor_mapping` | igual | se reconstruyó 1:1 |
| `vendors` / `companies` | igual | se reconstruyó 1:1 |
| `purchase_orders` / `purchase_orders_lines` | igual | bug legacy de líneas "SIN DATOS" corregido — `bc-sync-orders` sí trae líneas |
| `invoices` / `invoice_lines` / `invoice_status_history` | igual | esquema y ciclo de estados reconstruidos; falta el tramo de pagos |
