-- Pedido de Jonatan (2026-09-02, "Cambios solicitados por Key Players",
-- item 6): no se puede cargar una factura contra una orden de compra que
-- todavia no fue confirmada por el proveedor, ni mientras tenga una
-- solicitud de cambio pendiente sin resolver. El frontend ya deshabilita
-- el boton (Orders.tsx), pero eso es solo cosmetico -- si alguien llama
-- el INSERT directo via la API, este trigger es la garantia real.
--
-- admin/superadmin quedan exentos -- correccion de errores real de
-- operacion, mismo criterio que ya usa "scoped delete" (schema-v20.sql)
-- y el resto de las reglas de negocio de este archivo.
create or replace function public.check_po_confirmed_for_invoice()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_confirmation_status text;
  v_caller_role text;
begin
  if new.purchase_order_id is null then
    return new;
  end if;

  v_caller_role := portal_role();
  if v_caller_role in ('admin', 'superadmin') then
    return new;
  end if;

  select confirmation_status into v_confirmation_status
  from purchase_orders where id = new.purchase_order_id;

  if v_confirmation_status is distinct from 'confirmed' then
    if v_confirmation_status = 'change_requested' then
      raise exception 'No puede cargar una factura mientras exista una solicitud de cambio pendiente para esta orden.'
        using errcode = '23514';
    else
      raise exception 'No puede cargar una factura porque esta orden de compra todavia no ha sido confirmada.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_po_confirmed_for_invoice on invoices;
create trigger trg_po_confirmed_for_invoice
  before insert on invoices
  for each row execute function public.check_po_confirmed_for_invoice();
