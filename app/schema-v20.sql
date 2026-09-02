-- Pedido de Key Players (2026-09-01), items 1 y 2: "1 Orden de Compra = 1
-- Factura" + "Eliminar facturas cargadas por error".
--
-- Decision confirmada con Jonatan: la regla de 1:1 aplica SOLO HACIA
-- ADELANTE. Hoy hay 6 ordenes de compra en produccion con mas de una
-- factura activa (una con 4) -- no se tocan ni se fuerza a resolverlas. Por
-- eso esto es un TRIGGER (solo valida INSERTs nuevos) y no un indice unico
-- (que fallaria al crearse contra los datos ya existentes, y ademas
-- validaria retroactivamente filas viejas que no deben tocarse).

-- === 1. Una Orden de Compra solo puede tener una factura activa ==========
--
-- "Activa" = status != 'rejected' (mismo criterio que ya usa domain.ts para
-- excluir rechazadas del total facturado/acumulado -- una factura
-- rechazada no reserva el cupo de la orden). No se valida en UPDATE: el
-- unico UPDATE de purchase_order_id hoy es inexistente (uploadInvoice lo
-- fija una sola vez al crear la fila) y no hay forma de "reactivar" una
-- rechazada desde la UI -- si eso cambia en el futuro, revisar este
-- trigger tambien.
create or replace function public.check_one_active_invoice_per_po()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.purchase_order_id is not null and new.status is distinct from 'rejected' then
    if exists (
      select 1 from invoices
      where purchase_order_id = new.purchase_order_id
        and status is distinct from 'rejected'
        and id is distinct from new.id
    ) then
      raise exception 'Esta orden de compra ya tiene una factura activa asociada. Elimina o espera a que se resuelva la existente antes de cargar otra.'
        using errcode = '23505'; -- unique_violation, para que el frontend lo distinga de un error generico
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_one_active_invoice_per_po on invoices;
create trigger trg_one_active_invoice_per_po
  before insert on invoices
  for each row execute function public.check_one_active_invoice_per_po();

-- === 2. Eliminar factura (solo antes de "enviada") ========================
--
-- "Enviada" = ya paso por rpc_confirm_invoice_for_approval (status deja de
-- ser 'draft'/'uploaded'). A partir de ahi el proveedor ya no puede
-- borrarla libremente -- coincide con el limite que "scoped update" (v3)
-- ya usa para permitir edicion de campos (draft/uploaded/pending_approval,
-- aca mas estricto: sin pending_approval).
--
-- admin/superadmin sin restriccion de estado -- correccion de errores real
-- de operacion, mismo criterio que el resto de las policies de este rol.
drop policy if exists "scoped delete" on invoices;
create policy "scoped delete" on invoices for delete to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or (
    portal_role() in ('supplier', 'service_uploader')
    and vendor_id in (select portal_vendor_ids())
    and status in ('draft', 'uploaded')
  )
);

-- security_audit_log hoy solo se escribe desde Edge Functions con
-- service_role (que se saltan RLS) -- deleteInvoice registra el borrado
-- directo desde el cliente (domain.ts), asi que necesita su propia policy
-- de INSERT. Acotada a un solo event_type y a que actor_user_id sea
-- realmente quien esta logueado (auth.uid()), para que nadie pueda
-- fabricar un registro atribuido a otra persona.
drop policy if exists "self insert invoice_deleted" on security_audit_log;
create policy "self insert invoice_deleted" on security_audit_log for insert to authenticated
with check (
  event_type = 'invoice_deleted'
  and actor_user_id = auth.uid()
);

-- Mismo alcance sobre el archivo en Storage -- hasta ahora storage.objects
-- no tenia ninguna policy de DELETE (a proposito, ver schema-v11.sql: "el
-- frontend nunca los usa"). Ahora si.
drop policy if exists "scoped delete invoices bucket" on storage.objects;
create policy "scoped delete invoices bucket" on storage.objects for delete to authenticated
using (
  bucket_id = 'invoices'
  and exists (
    select 1 from public.invoices i
    where i.file_path = storage.objects.name
      and (
        public.portal_role() in ('admin', 'superadmin')
        or (
          public.portal_role() in ('supplier', 'service_uploader')
          and i.vendor_id in (select public.portal_vendor_ids())
          and i.status in ('draft', 'uploaded')
        )
      )
  )
);
