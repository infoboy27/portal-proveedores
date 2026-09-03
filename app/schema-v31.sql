-- Corte a producción, Fase 3 (2026-09-03): siguiente hallazgo del mismo
-- replay que descubrió schema-v30.sql (`purchase_orders.bc_id`) -- otras
-- 4 columnas de `purchase_orders_lines` que bc-sync-orders SÍ escribe
-- (bc_line_type, bc_line_object_number, bc_unit_cost, bc_tax_code) tampoco
-- estaban en ningún schema-v*.sql, mismo patrón: agregadas alguna vez con
-- un ALTER directo contra sandbox que nunca se versionó.
alter table purchase_orders_lines add column if not exists bc_line_type text;
alter table purchase_orders_lines add column if not exists bc_line_object_number text;
alter table purchase_orders_lines add column if not exists bc_unit_cost numeric;
alter table purchase_orders_lines add column if not exists bc_tax_code text;
