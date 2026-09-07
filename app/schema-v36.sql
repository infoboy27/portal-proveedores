-- 2026-09-07 -- El alcance multiempresa del analista, tambien en las RLS.
--
-- schema-v34.sql amplio portal_company_ids() (plural) para que un analista
-- pudiera cubrir varias empresas. Faltaba la mitad del trabajo: las policies
-- de datos NO usan esa funcion para el rol approver -- usan
-- portal_company_id() (SINGULAR), que devuelve una sola empresa desde
-- user_profiles.company_id.
--
-- Sintoma real: una analista con las siete empresas asignadas y "Todas las
-- empresas" elegido en el portal veia 7 ordenes de 189, todas de una sola
-- empresa. El selector le ofrecia las siete, pero la base le devolvia una.
--
-- Este cambio reemplaza, en las 9 policies afectadas, la rama del analista:
--     (portal_role() = 'approver' AND X.company_id = portal_company_id())
-- por:
--     (portal_role() = 'approver' AND X.company_id IN (SELECT portal_company_ids()))
--
-- Todo lo demas de cada policy queda EXACTAMENTE igual: superadmin sigue
-- exento, admin sigue acotado por admin_company_assignments, y proveedor /
-- carga interna siguen acotados por portal_vendor_ids(). Un analista sin
-- asignaciones sigue viendo unicamente la empresa de su perfil, porque
-- portal_company_ids() incluye user_profiles.company_id.
--
-- portal_company_id() (singular) queda en la base: lo usan otras cosas y no
-- hay motivo para romperlas.

-- 1. purchase_orders
drop policy if exists "scoped read" on public.purchase_orders;
create policy "scoped read" on public.purchase_orders for select using (
  (portal_role() = 'superadmin')
  or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
  or (portal_role() = 'approver' and company_id in (select portal_company_ids()))
  or (portal_role() = any (array['supplier', 'service_uploader']) and vendor_id in (select portal_vendor_ids()))
);

-- 2. purchase_orders_lines
drop policy if exists "scoped read" on public.purchase_orders_lines;
create policy "scoped read" on public.purchase_orders_lines for select using (
  (portal_role() = 'superadmin')
  or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
  or (portal_role() = 'approver' and company_id in (select portal_company_ids()))
  or (
    portal_role() = any (array['supplier', 'service_uploader'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_orders_lines.order_id and po.vendor_id in (select portal_vendor_ids())
    )
  )
);

-- 3. purchase_order_receipts
drop policy if exists "scoped read" on public.purchase_order_receipts;
create policy "scoped read" on public.purchase_order_receipts for select using (
  (portal_role() = 'superadmin')
  or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
  or (portal_role() = 'approver' and company_id in (select portal_company_ids()))
  or (
    portal_role() = any (array['supplier', 'service_uploader'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_receipts.order_id and po.vendor_id in (select portal_vendor_ids())
    )
  )
);

-- 4. purchase_order_confirmations
drop policy if exists "scoped read" on public.purchase_order_confirmations;
create policy "scoped read" on public.purchase_order_confirmations for select using (
  (portal_role() = 'superadmin')
  or exists (
    select 1 from public.purchase_orders po
    where po.id = purchase_order_confirmations.order_id
      and (
        (portal_role() = 'admin' and po.company_id in (select portal_admin_company_ids()))
        or (portal_role() = 'approver' and po.company_id in (select portal_company_ids()))
        or (portal_role() = any (array['supplier', 'service_uploader']) and po.vendor_id in (select portal_vendor_ids()))
      )
  )
);

-- 5. invoices (lectura)
drop policy if exists "scoped read" on public.invoices;
create policy "scoped read" on public.invoices for select using (
  (portal_role() = 'superadmin')
  or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
  or (portal_role() = 'approver' and company_id in (select portal_company_ids()))
  or (portal_role() = any (array['supplier', 'service_uploader']) and vendor_id in (select portal_vendor_ids()))
);

-- 6. invoices (escritura) -- el proveedor sigue limitado a los estados en que
-- la factura todavia es suya (draft/uploaded/pending_approval).
drop policy if exists "scoped update" on public.invoices;
create policy "scoped update" on public.invoices for update using (
  (portal_role() = 'superadmin')
  or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
  or (portal_role() = 'approver' and company_id in (select portal_company_ids()))
  or (
    portal_role() = any (array['supplier', 'service_uploader'])
    and vendor_id in (select portal_vendor_ids())
    and status = any (array['draft', 'uploaded', 'pending_approval'])
  )
) with check (
  (portal_role() = 'superadmin')
  or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
  or (portal_role() = 'approver' and company_id in (select portal_company_ids()))
  or (
    portal_role() = any (array['supplier', 'service_uploader'])
    and vendor_id in (select portal_vendor_ids())
    and status = any (array['draft', 'uploaded', 'pending_approval'])
  )
);

-- 7. invoice_lines
drop policy if exists "scoped read" on public.invoice_lines;
create policy "scoped read" on public.invoice_lines for select using (
  (portal_role() = 'superadmin')
  or exists (
    select 1 from public.invoices i
    where i.id = invoice_lines.invoice_id
      and (
        (portal_role() = 'admin' and i.company_id in (select portal_admin_company_ids()))
        or (portal_role() = 'approver' and i.company_id in (select portal_company_ids()))
        or (portal_role() = any (array['supplier', 'service_uploader']) and i.vendor_id in (select portal_vendor_ids()))
      )
  )
);

-- 8. invoice_status_history
drop policy if exists "scoped read" on public.invoice_status_history;
create policy "scoped read" on public.invoice_status_history for select using (
  (portal_role() = 'superadmin')
  or exists (
    select 1 from public.invoices i
    where i.id = invoice_status_history.invoice_id
      and (
        (portal_role() = 'admin' and i.company_id in (select portal_admin_company_ids()))
        or (portal_role() = 'approver' and i.company_id in (select portal_company_ids()))
        or (portal_role() = any (array['supplier', 'service_uploader']) and i.vendor_id in (select portal_vendor_ids()))
      )
  )
);

-- 9. storage.objects -- los PDF del bucket "invoices". Un analista tiene que
-- poder abrir el PDF de cualquier factura que pueda ver.
drop policy if exists "scoped read invoices bucket" on storage.objects;
create policy "scoped read invoices bucket" on storage.objects for select using (
  bucket_id = 'invoices'
  and exists (
    select 1 from public.invoices i
    where i.file_path = objects.name
      and (
        (portal_role() = any (array['admin', 'superadmin']))
        or (portal_role() = 'approver' and i.company_id in (select portal_company_ids()))
        or (portal_role() = any (array['supplier', 'service_uploader']) and i.vendor_id in (select portal_vendor_ids()))
      )
  )
);
