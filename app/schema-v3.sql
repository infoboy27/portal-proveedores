-- Migracion: aislamiento de datos real por proveedor/empresa (RLS) + rol
-- interno faltante. Ver docs/BITACORA.md (2026-08-20) para el contexto: las
-- politicas de schema.sql eran "authenticated read-all", sin aislamiento real
-- a nivel de base de datos, y faltaba el rol interno para carga de facturas
-- de proveedores recurrentes de servicios.
--
-- Tambien reconcilia columnas de `invoices` que ya existian en la base viva
-- (agregadas ad-hoc, nunca capturadas en schema.sql/schema-v2.sql) para que
-- estos archivos vuelvan a ser la fuente de verdad real.

-- === Reconciliacion de columnas ya existentes en la base viva ===========

alter table invoices add column if not exists bc_invoice_id text;
alter table invoices add column if not exists bc_invoice_number text;
alter table invoices add column if not exists export_error_reason text;
alter table invoices add column if not exists exported_at timestamptz;
-- Fecha posible de pago (informe punto 6): campo manual hoy — BC estandar no
-- expone vendor ledger entries, ver docs/BUSINESS_CENTRAL_INTEGRATION.md §7.
alter table invoices add column if not exists payment_due_date date;

-- === Rol interno faltante =================================================
-- "Rol interno para cargar las facturas de proveedores recurrentes de
-- servicios" (compromiso enviado a Adsemble). Usa el mismo mecanismo de
-- user_vendor_mapping que ya soporta multiples vendors por usuario — no
-- necesita cambio de esquema ademas de este rol.

alter table user_profiles drop constraint if exists user_profiles_role_check;
alter table user_profiles add constraint user_profiles_role_check
  check (role in ('admin', 'superadmin', 'approver', 'supplier', 'service_uploader'));

-- === Helpers de RLS ========================================================
-- SECURITY DEFINER: corren con privilegios del owner (postgres, exento de
-- RLS), evitando recursion infinita al consultar user_profiles/
-- user_vendor_mapping desde una politica sobre esas mismas tablas.

create or replace function public.portal_role() returns text
language sql stable security definer set search_path = public as $$
  select role from user_profiles where id = auth.uid();
$$;

create or replace function public.portal_company_id() returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from user_profiles where id = auth.uid();
$$;

create or replace function public.portal_vendor_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select vendor_id from user_vendor_mapping where user_id = auth.uid();
$$;

-- === Politicas: reemplazar "authenticated read-all" por aislamiento real ==
-- admin/superadmin: sin restriccion (portal completo).
-- approver ("Analista"): su propia empresa (company_id).
-- supplier / service_uploader: solo los vendors mapeados en user_vendor_mapping.

drop policy if exists "authenticated read" on companies;
create policy "scoped read" on companies for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or id = portal_company_id()
);

drop policy if exists "authenticated read" on vendors;
create policy "scoped read" on vendors for select to authenticated
using (
  portal_role() in ('admin', 'superadmin', 'approver')
  or id in (select portal_vendor_ids())
);

drop policy if exists "authenticated read" on purchase_orders;
create policy "scoped read" on purchase_orders for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or (portal_role() = 'approver' and company_id = portal_company_id())
  or (portal_role() in ('supplier', 'service_uploader') and vendor_id in (select portal_vendor_ids()))
);

drop policy if exists "authenticated read" on purchase_orders_lines;
create policy "scoped read" on purchase_orders_lines for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or (portal_role() = 'approver' and company_id = portal_company_id())
  or (
    portal_role() in ('supplier', 'service_uploader')
    and exists (
      select 1 from purchase_orders po
      where po.id = purchase_orders_lines.order_id
        and po.vendor_id in (select portal_vendor_ids())
    )
  )
);

drop policy if exists "authenticated read" on invoices;
drop policy if exists "authenticated insert invoices" on invoices;
drop policy if exists "authenticated update invoices" on invoices;

create policy "scoped read" on invoices for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or (portal_role() = 'approver' and company_id = portal_company_id())
  or (portal_role() in ('supplier', 'service_uploader') and vendor_id in (select portal_vendor_ids()))
);

create policy "scoped insert" on invoices for insert to authenticated
with check (
  portal_role() in ('admin', 'superadmin', 'approver')
  or (portal_role() in ('supplier', 'service_uploader') and vendor_id in (select portal_vendor_ids()))
);

-- Proveedores/carga interna solo pueden tocar sus propias facturas mientras
-- siguen en estados pre-aprobacion — aprobar/rechazar/exportar sigue siendo
-- exclusivo de la RPC rpc_update_invoice_status (SECURITY DEFINER) y de la
-- Edge Function bc-export-invoice (service_role), nunca de un UPDATE directo.
create policy "scoped update" on invoices for update to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or (portal_role() = 'approver' and company_id = portal_company_id())
  or (
    portal_role() in ('supplier', 'service_uploader')
    and vendor_id in (select portal_vendor_ids())
    and status in ('draft', 'uploaded', 'pending_approval')
  )
)
with check (
  portal_role() in ('admin', 'superadmin')
  or (portal_role() = 'approver' and company_id = portal_company_id())
  or (
    portal_role() in ('supplier', 'service_uploader')
    and vendor_id in (select portal_vendor_ids())
    and status in ('draft', 'uploaded', 'pending_approval')
  )
);

drop policy if exists "authenticated read" on invoice_lines;
create policy "scoped read" on invoice_lines for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or (portal_role() = 'approver' and company_id = portal_company_id())
  or (
    portal_role() in ('supplier', 'service_uploader')
    and exists (
      select 1 from invoices i
      where i.id = invoice_lines.invoice_id
        and i.vendor_id in (select portal_vendor_ids())
    )
  )
);

drop policy if exists "authenticated read" on invoice_status_history;
create policy "scoped read" on invoice_status_history for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or exists (
    select 1 from invoices i
    where i.id = invoice_status_history.invoice_id
      and (
        (portal_role() = 'approver' and i.company_id = portal_company_id())
        or (portal_role() in ('supplier', 'service_uploader') and i.vendor_id in (select portal_vendor_ids()))
      )
  )
);

-- user_profiles / user_vendor_mapping estaban en "self read" pero con USING
-- (true) — cualquier autenticado leia nombres/emails/roles de todo el
-- portal. Se restringe a: admin/superadmin ven todo, todos los demas solo
-- su propia fila.

drop policy if exists "self read" on user_profiles;
create policy "scoped read" on user_profiles for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or id = auth.uid()
);

-- No existia ninguna politica de UPDATE en user_profiles — Users.tsx llama
-- updateUser() para cambiar rol/empresa/estado, lo cual hoy falla en
-- silencio por RLS. Se habilita solo para admin/superadmin.
create policy "admin update" on user_profiles for update to authenticated
using (portal_role() in ('admin', 'superadmin'))
with check (portal_role() in ('admin', 'superadmin'));

drop policy if exists "self read" on user_vendor_mapping;
create policy "scoped read" on user_vendor_mapping for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or user_id = auth.uid()
);
