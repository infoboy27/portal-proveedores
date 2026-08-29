-- Fase 1 del plan multiempresa (2026-08-29): fundamento de esquema para que
-- vendors deje de ser una lista global y quede scoped por empresa de BC.
-- Confirmado en vivo contra el tenant de BC: las 11 empresas en alcance
-- comparten hoy los mismos vendor_number/RNC entre si (ej. PROV-000001 =
-- REVESTIDA SRL en las 11) -- sin esto, sincronizar una segunda empresa
-- mezclaria sus proveedores con los de Adsemble en una sola fila del portal.
--
-- Nota sobre `companies`: NO hace falta agregar columnas ahi todavia.
-- `bc_code` ya guarda el ID real de la empresa en BC (confirmado: la fila
-- de Adsemble tiene bc_code = '6a763343-...', el mismo GUID que usa
-- BC_COMPANY_ID) y `disabled_at` ya sirve como flag de activa/inactiva
-- (nullable = activa; domain.ts ya filtra `disabled_at is null`). Agregar
-- filas para las otras 10 empresas en alcance queda para la Fase 2, junto
-- con el loop de sincronizacion que de verdad las procese -- no tiene
-- sentido que aparezcan en el selector del frontend antes de que el
-- backend pueda sincronizarlas.

alter table vendors add column if not exists company_id uuid references companies(id);

-- Todo lo que existe hoy (3,495 filas: 3,494 sincronizadas de BC + el
-- proveedor de prueba manual "Suplidor de Prueba") pertenece a Adsemble --
-- es la unica empresa conectada hasta ahora.
update vendors set company_id = '11111111-1111-1111-1111-111111111111'
where company_id is null;

alter table vendors alter column company_id set not null;

-- Reemplaza la unicidad global (schema-v8.sql, necesaria en su momento
-- para el upsert en bloque de bc-sync-vendors) por unicidad por empresa --
-- el mismo vendor_number puede repetirse legitimamente entre empresas
-- distintas de BC, y de hecho ya se repite en el tenant real.
drop index if exists vendors_vendor_number_uq;
create unique index if not exists vendors_company_vendor_number_uq
  on vendors (company_id, vendor_number);
