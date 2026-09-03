-- Pedido de Jonatan (2026-09-03, item 4 del spec de Key Players):
-- "Administrador" limitado a sus empresas asignadas, con gestion de
-- analistas dentro de ese ambito -- separado de "Super Admin", que
-- sigue con acceso global. Hasta hoy `admin` y `superadmin` eran
-- exactamente el mismo rol en RLS (confirmado: 17 policies + 5 RPCs con
-- `portal_role() = ANY(ARRAY['admin','superadmin'])` sin ninguna
-- distincion de empresa).
--
-- HALLAZGO GRAVE encontrado auditando esto antes de escribir el fix:
-- rpc_update_user_profile e invite-user permitian que un admin real
-- (no superadmin) se auto-promoviera a superadmin, o invitara a otro
-- usuario como superadmin -- confirmado en vivo con una cuenta admin
-- real (c.cuevas@adsemble.do), revertido con rollback. Se corrige en
-- este mismo archivo.

-- === 1. Empresas asignadas a un admin (many-to-many) =======================
create table if not exists public.admin_company_assignments (
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  assigned_by uuid references public.user_profiles(id),
  created_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

alter table public.admin_company_assignments enable row level security;

-- Solo superadmin asigna/quita empresas a un admin -- coincide con item
-- 14 ("Super Admin: administrar administradores").
drop policy if exists "superadmin manage" on public.admin_company_assignments;
create policy "superadmin manage" on public.admin_company_assignments
  for all to authenticated
  using (portal_role() = 'superadmin')
  with check (portal_role() = 'superadmin');

-- Un admin puede leer sus propias asignaciones.
drop policy if exists "self read" on public.admin_company_assignments;
create policy "self read" on public.admin_company_assignments
  for select to authenticated
  using (user_id = auth.uid());

create or replace function public.portal_admin_company_ids()
returns setof uuid
language sql
stable
as $$
  select company_id from admin_company_assignments where user_id = auth.uid();
$$;

-- Backfill: los admins que YA existen no deben perder acceso a lo que
-- ya tenian sin una decision explicita -- se les asigna a todas las
-- empresas activas de hoy (preserva el comportamiento actual; ajustar
-- despues a mano desde Usuarios si Adsemble quiere acotarlo mas).
insert into public.admin_company_assignments (user_id, company_id)
select up.id, c.id
from public.user_profiles up
cross join public.companies c
where up.role = 'admin' and c.disabled_at is null
on conflict do nothing;

-- === 2. rpc_update_user_profile -- fix critico + scoping por empresa =======
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

  -- Un admin (no superadmin) SOLO puede administrar analistas
  -- (role='approver') dentro de sus empresas asignadas -- nunca puede
  -- crear/promover a admin o superadmin (ni a si mismo), ni tocar una
  -- cuenta que no sea analista, ni moverla a una empresa que el mismo
  -- no administra.
  if v_caller_role = 'admin' then
    if p_role <> 'approver' or v_before.role <> 'approver' then
      raise exception 'un administrador solo puede gestionar analistas';
    end if;
    if p_company_id is null or p_company_id not in (select portal_admin_company_ids()) then
      raise exception 'no tenes autorizacion sobre esa empresa';
    end if;
    if v_before.company_id is not null and v_before.company_id not in (select portal_admin_company_ids()) then
      raise exception 'no tenes autorizacion sobre este usuario';
    end if;
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

-- === 3. rpc_update_invoice_status -- admin scoped a sus empresas ===========
create or replace function public.rpc_update_invoice_status(
  p_invoice_id uuid,
  p_changed_by uuid,
  p_status text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
begin
  if p_changed_by is distinct from auth.uid() then
    raise exception 'p_changed_by debe coincidir con el usuario autenticado';
  end if;

  select company_id into v_company_id from invoices where id = p_invoice_id;
  if v_company_id is null then
    raise exception 'Factura no encontrada';
  end if;

  if not (
    portal_role() = 'superadmin'
    or (portal_role() = 'admin' and v_company_id in (select portal_admin_company_ids()))
    or (portal_role() = 'approver' and v_company_id = portal_company_id())
  ) then
    raise exception 'Solo un administrador o aprobador puede aprobar/rechazar esta factura';
  end if;

  update invoices
  set status = p_status,
      changed_by_user_id = p_changed_by,
      rejection_reason = case when p_status = 'rejected' then p_reason else rejection_reason end,
      updated_at = now()
  where id = p_invoice_id;

  insert into invoice_status_history (invoice_id, status, changed_by, reason)
  values (p_invoice_id, p_status, p_changed_by, p_reason);
end;
$$;

-- === 4. rpc_mark_invoice_paid -- no tenia NINGUN scoping por empresa =======
-- (ni siquiera para approver -- cualquier aprobador podia marcar como
-- pagada una factura de una empresa que no es la suya).
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
  v_company_id uuid;
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

  select company_id into v_company_id from invoices where id = p_invoice_id;
  if v_company_id is null then
    raise exception 'la factura no existe';
  end if;

  if not (
    v_caller_role = 'superadmin'
    or (v_caller_role = 'admin' and v_company_id in (select portal_admin_company_ids()))
    or (v_caller_role = 'approver' and v_company_id = portal_company_id())
  ) then
    raise exception 'no tenes autorizacion sobre esta factura';
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

-- === 5. rpc_confirm_purchase_order -- admin scoped a sus empresas ==========
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
  v_order_company_id uuid;
  v_current_status text;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'p_user_id debe coincidir con el usuario autenticado';
  end if;

  if p_action not in ('confirmed', 'change_requested') then
    raise exception 'accion invalida: %', p_action;
  end if;

  select role into v_caller_role from user_profiles where id = p_user_id;
  select vendor_id, company_id, confirmation_status into v_order_vendor_id, v_order_company_id, v_current_status
  from purchase_orders where id = p_order_id;

  if v_order_vendor_id is null then
    raise exception 'orden % no encontrada', p_order_id;
  end if;

  if v_caller_role = 'superadmin' then
    null; -- sin restriccion
  elsif v_caller_role = 'admin' then
    if v_order_company_id not in (select portal_admin_company_ids()) then
      raise exception 'no tenes autorizacion sobre esta orden';
    end if;
  else
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

-- === 6. rpc_confirm_invoice_for_approval -- admin scoped a sus empresas ====
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

  if v_caller_role = 'superadmin' then
    null;
  elsif v_caller_role = 'admin' then
    if v_invoice.company_id not in (select portal_admin_company_ids()) then
      raise exception 'no tenes autorizacion sobre esta factura';
    end if;
  else
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

-- === 7. RLS: scoped por empresa para admin, sin cambios para superadmin ====

drop policy if exists "scoped read" on public.companies;
create policy "scoped read" on public.companies for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and id in (select portal_admin_company_ids()))
    or (id in (select portal_company_ids()))
  );

drop policy if exists "scoped read" on public.vendors;
create policy "scoped read" on public.vendors for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or (portal_role() = 'approver')
    or (id in (select portal_vendor_ids()))
  );

drop policy if exists "scoped read" on public.payment_terms;
create policy "scoped read" on public.payment_terms for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or (portal_role() = 'approver')
    or (company_id in (select portal_company_ids()))
  );

drop policy if exists "scoped read" on public.purchase_orders;
create policy "scoped read" on public.purchase_orders for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or ((portal_role() = 'approver') and (company_id = portal_company_id()))
    or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (vendor_id in (select portal_vendor_ids())))
  );

drop policy if exists "scoped read" on public.purchase_orders_lines;
create policy "scoped read" on public.purchase_orders_lines for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or ((portal_role() = 'approver') and (company_id = portal_company_id()))
    or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (exists (
         select 1 from purchase_orders po where po.id = purchase_orders_lines.order_id and po.vendor_id in (select portal_vendor_ids())
       )))
  );

drop policy if exists "scoped read" on public.purchase_order_receipts;
create policy "scoped read" on public.purchase_order_receipts for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or ((portal_role() = 'approver') and (company_id = portal_company_id()))
    or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (exists (
         select 1 from purchase_orders po where po.id = purchase_order_receipts.order_id and po.vendor_id in (select portal_vendor_ids())
       )))
  );

drop policy if exists "scoped read" on public.purchase_order_confirmations;
create policy "scoped read" on public.purchase_order_confirmations for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (exists (
      select 1 from purchase_orders po where po.id = purchase_order_confirmations.order_id and (
        (portal_role() = 'admin' and po.company_id in (select portal_admin_company_ids()))
        or ((portal_role() = 'approver') and (po.company_id = portal_company_id()))
        or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (po.vendor_id in (select portal_vendor_ids())))
      )
    ))
  );

drop policy if exists "scoped read" on public.invoices;
create policy "scoped read" on public.invoices for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or ((portal_role() = 'approver') and (company_id = portal_company_id()))
    or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (vendor_id in (select portal_vendor_ids())))
  );

drop policy if exists "scoped insert" on public.invoices;
create policy "scoped insert" on public.invoices for insert to authenticated
  with check (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or (portal_role() = 'approver')
    or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (vendor_id in (select portal_vendor_ids())))
  );

drop policy if exists "scoped update" on public.invoices;
create policy "scoped update" on public.invoices for update to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or ((portal_role() = 'approver') and (company_id = portal_company_id()))
    or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (vendor_id in (select portal_vendor_ids())) and (status = ANY (ARRAY['draft','uploaded','pending_approval'])))
  )
  with check (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or ((portal_role() = 'approver') and (company_id = portal_company_id()))
    or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (vendor_id in (select portal_vendor_ids())) and (status = ANY (ARRAY['draft','uploaded','pending_approval'])))
  );

drop policy if exists "scoped delete" on public.invoices;
create policy "scoped delete" on public.invoices for delete to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (vendor_id in (select portal_vendor_ids())) and (status = ANY (ARRAY['draft','uploaded'])))
  );

drop policy if exists "scoped read" on public.invoice_lines;
create policy "scoped read" on public.invoice_lines for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (exists (
      select 1 from invoices i where i.id = invoice_lines.invoice_id and (
        (portal_role() = 'admin' and i.company_id in (select portal_admin_company_ids()))
        or ((portal_role() = 'approver') and (i.company_id = portal_company_id()))
        or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (i.vendor_id in (select portal_vendor_ids())))
      )
    ))
  );

drop policy if exists "scoped read" on public.invoice_status_history;
create policy "scoped read" on public.invoice_status_history for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (exists (
      select 1 from invoices i where i.id = invoice_status_history.invoice_id and (
        (portal_role() = 'admin' and i.company_id in (select portal_admin_company_ids()))
        or ((portal_role() = 'approver') and (i.company_id = portal_company_id()))
        or ((portal_role() = ANY (ARRAY['supplier','service_uploader'])) and (i.vendor_id in (select portal_vendor_ids())))
      )
    ))
  );

-- user_profiles: un admin ve/administra los usuarios de sus empresas --
-- via company_id directo (aprobadores/admins) o via user_vendor_mapping
-- (proveedores, cuyo company_id "principal" vive ahi, no en
-- user_profiles.company_id).
drop policy if exists "scoped read" on public.user_profiles;
create policy "scoped read" on public.user_profiles for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (id = auth.uid())
    or (portal_role() = 'admin' and (
      company_id in (select portal_admin_company_ids())
      or exists (
        select 1 from user_vendor_mapping uvm
        where uvm.user_id = user_profiles.id and uvm.company_id in (select portal_admin_company_ids())
      )
    ))
  );

-- El admin solo puede tocar via REST directo filas que YA son analistas
-- de sus empresas (using), y el resultado tiene que seguir siendo un
-- analista de una de sus empresas (with_check) -- mismo criterio exacto
-- que rpc_update_user_profile, para que un PATCH directo a la tabla no
-- pueda lograr lo que el RPC ya bloquea (crear/promover un admin o
-- superadmin).
drop policy if exists "admin update" on public.user_profiles;
create policy "admin update" on public.user_profiles for update to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and role = 'approver' and company_id in (select portal_admin_company_ids()))
  )
  with check (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and role = 'approver' and company_id in (select portal_admin_company_ids()))
  );

drop policy if exists "scoped read" on public.user_vendor_mapping;
create policy "scoped read" on public.user_vendor_mapping for select to authenticated
  using (
    (portal_role() = 'superadmin')
    or (portal_role() = 'admin' and company_id in (select portal_admin_company_ids()))
    or (user_id = auth.uid())
  );
