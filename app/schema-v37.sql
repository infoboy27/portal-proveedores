-- 2026-09-07 -- El alcance multiempresa del analista, tambien en las RPC.
--
-- Tercera y ultima mitad de lo mismo. schema-v34.sql amplio
-- portal_company_ids(); schema-v36.sql arreglo las 9 policies de RLS; pero
-- las funciones RPC hacen su PROPIA validacion de autorizacion, y las dos
-- que existen seguian preguntando por portal_company_id() (SINGULAR).
--
-- Sintoma real, reportado por Leidy probando el piloto: no podia aprobar ni
-- rechazar. Veia las facturas (eso ya lo arreglaba v36) pero al decidir le
-- saltaba "Solo un administrador o aprobador puede aprobar/rechazar esta
-- factura", porque la factura era de una empresa distinta a la de su perfil.
--
-- Leccion para quien venga despues: buscar portal_company_id() SOLO en
-- pg_policies deja fuera las funciones. La consulta completa es:
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.prosrc like '%portal_company_id()%';
--
-- Se cambia unicamente la rama del analista. Todo lo demas de cada funcion
-- queda igual: superadmin exento, admin por admin_company_assignments, y las
-- validaciones de estado y de identidad del llamador intactas.

-- 1. Aprobar / rechazar
create or replace function public.rpc_update_invoice_status(
  p_invoice_id uuid,
  p_changed_by uuid,
  p_status text,
  p_reason text default null::text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    or (portal_role() = 'approver' and v_company_id in (select portal_company_ids()))
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
$function$;

-- 2. Marcar como pagada
create or replace function public.rpc_mark_invoice_paid(
  p_invoice_id uuid,
  p_changed_by uuid,
  p_paid_at date,
  p_payment_reference text default null::text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    or (v_caller_role = 'approver' and v_company_id in (select portal_company_ids()))
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
$function$;
