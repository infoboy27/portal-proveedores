-- Migracion incremental: columnas que faltaban tras auditar Orders/Suppliers.
alter table purchase_orders add column if not exists description text;
alter table purchase_orders alter column status set default 'open';
alter table vendors add column if not exists email text;
