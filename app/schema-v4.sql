-- Confirmacion de ordenes de compra (Dias 7-9 del compromiso enviado a
-- Adsemble). Nunca escribe a Business Central directo: no hay accion de
-- confirmacion confirmada en la API v2.0 para este tenant (ver
-- docs/BUSINESS_CENTRAL_INTEGRATION.md §7) — queda como registro solo-portal,
-- que es exactamente el patron ya usado para "cambios sensibles" en el resto
-- del sistema (aprobar/rechazar factura via RPC, nunca UPDATE directo).

alter table purchase_orders add column if not exists confirmation_status text not null default 'pending';

alter table purchase_orders drop constraint if exists purchase_orders_confirmation_status_check;
alter table purchase_orders add constraint purchase_orders_confirmation_status_check
  check (confirmation_status in ('pending', 'confirmed', 'change_requested'));

create table if not exists purchase_order_confirmations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purchase_orders(id) on delete cascade,
  user_id uuid references user_profiles(id),
  action text not null check (action in ('confirmed', 'change_requested')),
  new_expected_date date,
  reason text,
  comments text,
  created_at timestamptz not null default now()
);

-- SECURITY DEFINER: unico camino de escritura para confirmation_status y
-- para el historial. Valida que quien confirma sea admin/superadmin o un
-- usuario mapeado (user_vendor_mapping) al vendor dueno de la orden — no
-- basta con que el cliente pase el rol correcto, se revalida server-side.
create or replace function public.rpc_confirm_purchase_order(
  p_order_id uuid,
  p_user_id uuid,
  p_action text,
  p_new_expected_date date default null,
  p_reason text default null,
  p_comments text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role text;
  v_order_vendor_id uuid;
begin
  if p_action not in ('confirmed', 'change_requested') then
    raise exception 'accion invalida: %', p_action;
  end if;

  select role into v_caller_role from user_profiles where id = p_user_id;
  select vendor_id into v_order_vendor_id from purchase_orders where id = p_order_id;

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

  update purchase_orders
  set confirmation_status = p_action
  where id = p_order_id;

  insert into purchase_order_confirmations (order_id, user_id, action, new_expected_date, reason, comments)
  values (p_order_id, p_user_id, p_action, p_new_expected_date, p_reason, p_comments);
end;
$$;

alter table purchase_order_confirmations enable row level security;

drop policy if exists "scoped read" on purchase_order_confirmations;
create policy "scoped read" on purchase_order_confirmations for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or exists (
    select 1 from purchase_orders po
    where po.id = purchase_order_confirmations.order_id
      and (
        (portal_role() = 'approver' and po.company_id = portal_company_id())
        or (portal_role() in ('supplier', 'service_uploader') and po.vendor_id in (select portal_vendor_ids()))
      )
  )
);

-- purchase_orders ya tiene "scoped read" (schema-v3.sql), que cubre la
-- nueva columna confirmation_status sin cambios adicionales.
