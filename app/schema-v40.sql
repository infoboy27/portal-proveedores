-- 2026-09-08 -- La orden queda "consumida" en BC al anular.
--
-- Dato que aporto el equipo y que invalidaba mi diseño anterior: Business
-- Central NO libera la orden de compra cuando se anula la factura con una
-- nota de credito. Si la factura ya se habia registrado en BC, la orden
-- quedo consumida alla para siempre.
--
-- Consecuencia: la factura corregida ya no puede entrar contra la orden --
-- tiene que entrar como Factura de Compra, igual que las de los 30
-- proveedores que facturan sin orden.
--
-- El portal no puede saber si la factura llego a registrarse en BC (solo
-- sabe que la exporto), asi que se pregunta al anular en vez de adivinar.
-- Viene marcado por defecto porque si emitieron nota de credito es que la
-- habian registrado.

alter table public.purchase_orders
  add column if not exists bc_consumed_at timestamptz;

comment on column public.purchase_orders.bc_consumed_at is
  'La orden ya fue consumida en Business Central (se registro una factura contra ella). Desde ese momento las facturas del portal contra esta orden se exportan como Factura de Compra, no actualizando la seccion General.';

-- Se REEMPLAZA la firma anterior, no se agrega una sobrecarga. Un
-- "create or replace" con un parametro nuevo habria dejado DOS funciones
-- rpc_annul_invoice, y PostgREST responde "function is not unique" -- que es
-- exactamente lo que bloqueo las aprobaciones el 2026-09-03 (schema-v32).
drop function if exists public.rpc_annul_invoice(uuid, uuid, text, text);

create or replace function public.rpc_annul_invoice(
  p_invoice_id uuid,
  p_changed_by uuid,
  p_reason text,
  p_credit_note text default null::text,
  p_order_consumed boolean default true
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company_id uuid;
  v_status text;
  v_order_id uuid;
begin
  if p_changed_by is distinct from auth.uid() then
    raise exception 'p_changed_by debe coincidir con el usuario autenticado';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'El motivo de la anulacion es obligatorio';
  end if;

  select company_id, status, purchase_order_id
    into v_company_id, v_status, v_order_id
  from invoices where id = p_invoice_id;
  if v_company_id is null then
    raise exception 'Factura no encontrada';
  end if;

  if v_status not in ('exported', 'processed') then
    raise exception 'Solo se puede anular una factura ya exportada. Esta esta en "%"', v_status;
  end if;

  if not (
    portal_role() = 'superadmin'
    or (portal_role() = 'admin' and v_company_id in (select portal_admin_company_ids()))
    or (portal_role() = 'approver' and v_company_id in (select portal_company_ids()))
  ) then
    raise exception 'Solo un administrador o aprobador puede anular esta factura';
  end if;

  update invoices
  set status = 'annulled',
      annulled_at = now(),
      annulment_reason = btrim(p_reason),
      credit_note_number = nullif(btrim(coalesce(p_credit_note, '')), ''),
      changed_by_user_id = p_changed_by,
      updated_at = now()
  where id = p_invoice_id;

  -- La marca va en la ORDEN, no en la factura: aplica a todo lo que venga
  -- despues contra esa orden, no solo a la factura corregida.
  if p_order_consumed and v_order_id is not null then
    update purchase_orders set bc_consumed_at = coalesce(bc_consumed_at, now()) where id = v_order_id;
  end if;

  insert into invoice_status_history (invoice_id, status, changed_by, reason)
  values (
    p_invoice_id,
    'annulled',
    p_changed_by,
    btrim(p_reason)
      || case when nullif(btrim(coalesce(p_credit_note, '')), '') is not null
              then ' (nota de credito ' || btrim(p_credit_note) || ')' else '' end
      || case when p_order_consumed and v_order_id is not null
              then ' -- la orden queda consumida en BC' else '' end
  );
end;
$function$;
