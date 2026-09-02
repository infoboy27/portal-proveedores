-- Pedido de Jonatan (2026-09-02, ver solicitarcambio.png): mientras una
-- orden tiene un cambio solicitado sin resolver ("Cambio solicitado"),
-- ambos botones (Confirmar orden / Solicitar cambio) deben quedar
-- bloqueados -- el proveedor ya actuo, no puede volver a hacer nada hasta
-- que el estado cambie. Mismo criterio que ya se aplico a "confirmed" en
-- schema-v24.sql/v25.sql, generalizado ahora a cualquier estado que no
-- sea 'pending' (hoy son solo 'confirmed' y 'change_requested', pero
-- "not pending" es mas a prueba de futuros estados que enumerar cada uno).
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

  if v_current_status is distinct from 'pending' then
    raise exception 'la orden ya tiene una confirmacion o un cambio solicitado registrado, no se puede modificar';
  end if;

  update purchase_orders
  set confirmation_status = p_action
  where id = p_order_id;

  insert into purchase_order_confirmations (order_id, user_id, action, new_expected_date, reason, comments)
  values (p_order_id, p_user_id, p_action, p_new_expected_date, p_reason, p_comments);
end;
$$;
