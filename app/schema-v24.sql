-- Pedido de Jonatan (2026-09-02): "luego de que el suplidor confirme la
-- orden el boton de solicitar cambio deberia de ocultarse por que una vez
-- confirmada la orden no puede mandar a cambiar" -- se oculta el boton en
-- Orders.tsx, pero el RPC (unico camino de escritura real de este campo,
-- ver comentario en domain.ts:178) no validaba el estado ACTUAL de la
-- orden antes de aplicar la accion. Sin este fix, ocultar el boton es solo
-- cosmetico: cualquiera podia seguir llamando
-- /rest/v1/rpc/rpc_confirm_purchase_order directo con
-- p_action='change_requested' sobre una orden ya confirmada.
--
-- Se agrega: si la orden ya esta 'confirmed', solo se permite volver a
-- llamar con p_action='confirmed' (idempotente, sin efecto real); pedir
-- 'change_requested' sobre una orden ya confirmada ahora lanza excepcion.
create or replace function public.rpc_confirm_purchase_order(
  p_order_id uuid,
  p_user_id uuid,
  p_action text,
  p_new_expected_date date default null,
  p_reason text default null,
  p_comments text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller_role text;
  v_order_vendor_id uuid;
  v_current_status text;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'p_user_id debe coincidir con el usuario autenticado';
  end if;

  if p_action not in ('confirmed', 'change_requested') then
    raise exception 'accion invalida: %', p_action;
  end if;

  select role into v_caller_role from user_profiles where id = p_user_id;
  select vendor_id, confirmation_status into v_order_vendor_id, v_current_status
  from purchase_orders where id = p_order_id;

  if v_order_vendor_id is null then
    raise exception 'orden % no encontrada', p_order_id;
  end if;

  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from user_vendor_mapping
      where user_id = p_user_id and vendor_id = v_order_vendor_id
    ) then
      raise exception 'el usuario no esta autorizado a confirmar esta orden';
    end if;
  end if;

  if v_current_status = 'confirmed' and p_action = 'change_requested' then
    raise exception 'la orden ya esta confirmada, no se puede solicitar un cambio';
  end if;

  update purchase_orders
  set confirmation_status = p_action
  where id = p_order_id;

  insert into purchase_order_confirmations (order_id, user_id, action, new_expected_date, reason, comments)
  values (p_order_id, p_user_id, p_action, p_new_expected_date, p_reason, p_comments);
end;
$$;
