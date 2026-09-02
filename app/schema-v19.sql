-- Expense Class Code (2026-08-31): copia de solo lectura del codigo de
-- clasificacion de gasto que Business Central ya tiene en cada orden de
-- compra (Purchase Header, Document Type = Order -- campo
-- "DSNCod. Clasificacion Gasto"). No es un dato que el portal calcule: lo
-- pone quien arma la orden en BC, y bc-sync-orders lo trae via el nuevo
-- Custom API PurchOrderFiscalAPI.al (page 58006). bc-export-invoice lo
-- copia a la factura junto con el NCF -- ver docs/BITACORA.md 2026-08-31.

alter table purchase_orders
  add column if not exists bc_expense_class_code text;

comment on column purchase_orders.bc_expense_class_code is
  'Copia de solo lectura de "DSNCod. Clasificacion Gasto" (Purchase Header en BC), traida por bc-sync-orders. Puede venir vacia en ordenes viejas/de prueba que no lo tenian cargado en BC.';
