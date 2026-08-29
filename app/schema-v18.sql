-- Fase 4 del plan multiempresa (2026-08-29): RLS multiempresa.
--
-- Hallazgo antes de escribir esto: la mayoria de las tablas de datos
-- (invoices, purchase_orders, purchase_orders_lines, invoice_lines,
-- invoice_status_history) YA estan bien para multiempresa del lado del
-- proveedor -- su RLS usa portal_vendor_ids() (schema-v3.sql), que ya es
-- un SETOF desde user_vendor_mapping y por lo tanto ya cubre TODAS las
-- empresas a las que un proveedor esta vinculado, no solo una. No hizo
-- falta tocar esas policies.
--
-- Lo que si quedaba atado a una sola empresa (portal_company_id(), un
-- escalar de user_profiles.company_id) y necesitaba arreglo real:
-- 1. `companies` (que empresas puede LISTAR el usuario -- necesario para
--    que el selector de la Fase 5 muestre todas las suyas, no solo una).
-- 2. El INSERT de Storage al subir una factura -- valida el prefijo de
--    carpeta contra portal_company_id() unicamente; un proveedor subiendo
--    una factura para su SEGUNDA empresa habria sido rechazado aqui aunque
--    todo lo demas (RLS de invoices, el propio uploadInvoice) ya lo
--    permitiera.
--
-- Las policies de `approver` (scoped por portal_company_id() en
-- invoices/purchase_orders/etc, y la de lectura de Storage) se dejan TAL
-- CUAL a proposito -- no hay pedido de que un aprobador interno de
-- Adsemble revise varias empresas a la vez, y portal_company_id() sigue
-- siendo la fuente correcta para ese rol.

-- Conjunto de empresas a las que el usuario tiene acceso: union de sus
-- vinculos de proveedor (user_vendor_mapping, ya multi-fila desde
-- schema-v13.sql) y su empresa primaria de staff (user_profiles.company_id,
-- para admin/superadmin/approver que no tienen fila en user_vendor_mapping).
create or replace function public.portal_company_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select company_id from user_vendor_mapping
  where user_id = auth.uid() and company_id is not null
  union
  select company_id from user_profiles
  where id = auth.uid() and company_id is not null;
$$;

drop policy if exists "scoped read" on companies;
create policy "scoped read" on companies for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or id in (select portal_company_ids())
);

drop policy if exists "insert own company invoices bucket" on storage.objects;
create policy "insert own company invoices bucket" on storage.objects for insert to authenticated
with check (
  bucket_id = 'invoices'
  and ((storage.foldername(name))[1])::uuid in (select portal_company_ids())
);
