-- Pedido de Jonatan (2026-09-02): "El portal solo debe alimentar la
-- seccion General de la orden de compra pero NO debe crear una factura en
-- el modulo de compras" -- bc-export-invoice ya no crea ninguna Factura de
-- Compra en BC, asi que las facturas del portal llegan a "exported" en vez
-- de "processed" (ver bc-export-invoice/index.ts). rpc_mark_invoice_paid
-- exigia `status = 'processed'` a mano en el WHERE -- sin este fix, NINGUNA
-- factura nueva podria marcarse como pagada nunca mas (siempre "processed").
--
-- Se acepta 'exported' O 'processed' -- las 8 facturas reales que ya
-- llegaron a "processed" con el flujo viejo (creaba la Factura de Compra)
-- se siguen pudiendo marcar como pagadas igual que antes.
--
-- De paso: mismo hallazgo de la ronda de pruebas que llevo a arreglar
-- rpc_update_invoice_status (2026-09-01) -- esta funcion tampoco verificaba
-- que p_changed_by fuera realmente auth.uid() (solo validaba que ESE id
-- tuviera rol admin/superadmin/approver, sin confirmar que fuera quien
-- esta llamando de verdad) -- se podia atribuir el pago a otro usuario en
-- la auditoria. Se agrega la misma proteccion.
create or replace function public.rpc_mark_invoice_paid(
  p_invoice_id uuid,
  p_changed_by uuid,
  p_paid_at date,
  p_payment_reference text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller_role text;
begin
  if p_paid_at is null then
    raise exception 'la fecha de pago es obligatoria';
  end if;

  if p_changed_by is distinct from auth.uid() then
    raise exception 'p_changed_by debe coincidir con el usuario autenticado';
  end if;

  select role into v_caller_role from user_profiles where id = p_changed_by;
  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin', 'approver') then
    raise exception 'el usuario no esta autorizado a marcar facturas como pagadas';
  end if;

  update invoices
  set paid_at = p_paid_at,
      payment_reference = p_payment_reference,
      payment_source = 'manual',
      bc_ledger_entry_no = null,
      updated_at = now()
  where id = p_invoice_id and status in ('exported', 'processed');

  if not found then
    raise exception 'la factura no existe o no esta en estado "exported"/"processed"';
  end if;

  insert into invoice_status_history (invoice_id, status, changed_by, reason)
  values (p_invoice_id, 'paid', p_changed_by, p_payment_reference);
end;
$$;

-- === Hallazgo mas grave, mismo patron, encontrado revisando el resto de
-- las funciones SECURITY DEFINER despues del fix de rpc_update_invoice_status
-- (2026-09-01): CASI TODAS validan el rol de un user_id que manda el
-- propio cliente en el body (p_user_id/p_changed_by), nunca auth.uid().
-- Eso significa que cualquiera logueado -- hasta un proveedor -- podia
-- pasar el id de un admin CONOCIDO (no hace falta su password, alcanza con
-- saber o adivinar el UUID) como ese parametro para que la funcion crea
-- que quien llama tiene ese rol, mientras la accion se ejecuta de verdad
-- sobre datos de quien la esta llamando en la sesion real.
--
-- El caso mas grave: rpc_update_user_profile con esta falla permitia
-- ESCALACION DE PRIVILEGIOS COMPLETA -- p_target_user_id = uno mismo,
-- p_changed_by = el id de cualquier admin conocido, p_role = 'superadmin'.
-- Arreglado en las 3 funciones de abajo, mismo criterio que ya se aplico a
-- rpc_update_invoice_status/rpc_mark_invoice_paid: exigir que el parametro
-- de "quien lo pide" sea siempre auth.uid().

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
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'p_user_id debe coincidir con el usuario autenticado';
  end if;

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

create or replace function public.rpc_update_user_profile(
  p_target_user_id uuid,
  p_changed_by uuid,
  p_role text,
  p_company_id uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller_role text;
  v_before record;
begin
  if p_changed_by is distinct from auth.uid() then
    raise exception 'p_changed_by debe coincidir con el usuario autenticado';
  end if;

  select role into v_caller_role from user_profiles where id = p_changed_by;
  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin') then
    raise exception 'el usuario no esta autorizado a editar perfiles';
  end if;

  select role, company_id, active, email into v_before from user_profiles where id = p_target_user_id;
  if not found then
    raise exception 'usuario % no encontrado', p_target_user_id;
  end if;

  update user_profiles
  set role = p_role, company_id = p_company_id, active = p_active
  where id = p_target_user_id;

  insert into security_audit_log (event_type, actor_user_id, target_user_id, target_email, detail)
  values (
    case
      when v_before.role is distinct from p_role then 'user_role_changed'
      when v_before.active = true and p_active = false then 'user_deactivated'
      when v_before.active = false and p_active = true then 'user_reactivated'
      else 'user_profile_updated'
    end,
    p_changed_by,
    p_target_user_id,
    v_before.email,
    jsonb_build_object(
      'before', jsonb_build_object('role', v_before.role, 'companyId', v_before.company_id, 'active', v_before.active),
      'after', jsonb_build_object('role', p_role, 'companyId', p_company_id, 'active', p_active)
    )
  );
end;
$$;

create or replace function public.rpc_confirm_invoice_for_approval(p_invoice_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_caller_role text;
  v_invoice invoices%rowtype;
  v_vendor_posting_group text;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'p_user_id debe coincidir con el usuario autenticado';
  end if;

  select role into v_caller_role from user_profiles where id = p_user_id;

  select * into v_invoice from invoices where id = p_invoice_id;
  if v_invoice.id is null then
    raise exception 'factura % no encontrada', p_invoice_id;
  end if;

  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from user_vendor_mapping
      where user_id = p_user_id and vendor_id = v_invoice.vendor_id
    ) then
      raise exception 'el usuario no esta autorizado a confirmar esta factura';
    end if;
  end if;

  if v_invoice.status <> 'uploaded' then
    raise exception 'la factura esta en estado "%", no se puede confirmar', v_invoice.status;
  end if;

  if v_invoice.invoice_number is null or btrim(v_invoice.invoice_number) = '' then
    raise exception 'el numero de factura es obligatorio';
  end if;

  if v_invoice.invoice_date is null then
    raise exception 'la fecha de factura es obligatoria';
  end if;

  if extract(day from v_invoice.invoice_date) > 25 then
    raise exception 'El corte de recepcion de facturas es el dia 25 de cada mes. Debes subir esta factura con fecha del mes siguiente.';
  end if;

  if v_invoice.total_amount is null or v_invoice.total_amount <= 0 then
    raise exception 'el total de la factura debe ser mayor a cero';
  end if;

  select vendor_posting_group into v_vendor_posting_group from vendors where id = v_invoice.vendor_id;

  -- Por defecto (grupo vacio/desconocido) se exige NCF -- solo se afloja
  -- para las categorias confirmadas explicitamente como informal/extranjero.
  if coalesce(v_vendor_posting_group, 'CPPROV') not in ('PROVINFORM', 'INT') then
    if v_invoice.invoice_tax_number is null or btrim(v_invoice.invoice_tax_number) = '' then
      raise exception 'el Comprobante Fiscal (NCF) es obligatorio para este proveedor';
    end if;
  end if;

  update invoices
  set status = 'pending_approval',
      changed_by_user_id = p_user_id,
      updated_at = now()
  where id = p_invoice_id;

  insert into invoice_status_history (invoice_id, status, changed_by, reason)
  values (p_invoice_id, 'pending_approval', p_user_id, 'confirmed_by_provider');
end;
$$;

-- update_invoice_data: huerfana -- ni el frontend ni ninguna Edge Function
-- la llaman (grep completo del repo, sin resultados). SECURITY DEFINER,
-- sin NINGUNA validacion de rol/dueño, con upsert libre sobre invoices --
-- cualquier usuario autenticado podia invocarla directo via PostgREST
-- (/rest/v1/rpc/update_invoice_data) y crear o sobreescribir CUALQUIER
-- factura con cualquier dato, incluido el status. Como nada la usa, se
-- elimina en vez de arreglarla -- menos superficie de ataque que mantener
-- una funcion sin dueño real.
drop function if exists public.update_invoice_data(uuid, jsonb);
