-- 2026-09-08 -- Quien exporto cada factura, y que el analista pueda ver nombres.
--
-- Pedido de Jonatan sobre Monitoreo de exportaciones (exportar.jpg): que la
-- fila diga tambien QUE USUARIO exporto. Al implementarlo salieron dos cosas.
--
-- 1) El dato existia solo en invoice_status_history, y el frontend trae esa
--    tabla con limit 100, asi que para facturas viejas no habria nombre. Se
--    guarda ahora en la propia factura, que ademas es el lugar correcto: es
--    un hecho del documento, no un evento mas de la lista.
--
-- 2) Mas importante: la RLS de user_profiles solo dejaba al analista ver SU
--    PROPIO perfil. Sin esto no habria forma de mostrar ningun nombre --
--    y explica algo que ya estaba roto y nadie habia reportado: en el
--    Historial de auditoria, una analista veia un identificador truncado
--    ("4382fe7b") en lugar del nombre de quien hizo cada cosa. Comprobado en
--    produccion: Leidy veia 1 perfil de 10.

alter table public.invoices
  add column if not exists exported_by uuid references auth.users(id);

comment on column public.invoices.exported_by is
  'Usuario que exporto la factura a Business Central. Se conserva aunque despues se anule.';

-- Relleno para las facturas ya exportadas: el dato esta en el historial.
update public.invoices i
set exported_by = h.changed_by
from (
  select distinct on (invoice_id) invoice_id, changed_by
  from public.invoice_status_history
  where status = 'exported' and changed_by is not null
  order by invoice_id, changed_at desc
) h
where h.invoice_id = i.id and i.exported_by is null;

-- El analista pasa a ver los perfiles de su alcance, igual que un
-- administrador ve los de sus empresas asignadas. Es lo que hace legible
-- cualquier pantalla de "quien hizo que": sin esto el portal registra la
-- trazabilidad pero no la puede mostrar a quien la necesita.
drop policy if exists "scoped read" on public.user_profiles;
create policy "scoped read" on public.user_profiles for select using (
  (portal_role() = 'superadmin')
  or (id = auth.uid())
  or (
    portal_role() = 'admin'
    and (
      company_id in (select portal_admin_company_ids())
      or exists (
        select 1 from public.user_vendor_mapping uvm
        where uvm.user_id = user_profiles.id and uvm.company_id in (select portal_admin_company_ids())
      )
    )
  )
  or (
    portal_role() = 'approver'
    and (
      company_id in (select portal_company_ids())
      or exists (
        select 1 from public.user_vendor_mapping uvm
        where uvm.user_id = user_profiles.id and uvm.company_id in (select portal_company_ids())
      )
    )
  )
);
