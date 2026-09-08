-- 2026-09-08 -- Anular una factura ya exportada.
--
-- Pedido de Jonatan: cuando una factura ya salio a Business Central y
-- resulta estar mal, en BC le hacen una nota de credito correctiva, pero en
-- el portal la factura se quedaba como "Exportada" para siempre, sin forma
-- de marcarla ni de dejar constancia de lo ocurrido.
--
-- No se reutiliza "rejected" a proposito. Rechazada significa que la factura
-- NUNCA salio; anulada significa que salio y despues se corrigio. Marcar
-- como rechazada una factura que si se exporto haria que el historial de
-- auditoria -- que es lo que le da valor al portal -- dijera algo falso.
--
-- El portal NO toca Business Central: la nota de credito la emite Adsemble
-- alla, como ya lo hace. Aca solo queda el reflejo, y el numero de la nota
-- para poder ir de un sistema al otro.

alter table public.invoices
  add column if not exists annulled_at timestamptz,
  add column if not exists annulment_reason text,
  add column if not exists credit_note_number text;

comment on column public.invoices.annulment_reason is
  'Por que se anulo una factura ya exportada. Obligatorio al anular; lo ve el proveedor para saber que debe reemitir.';
comment on column public.invoices.credit_note_number is
  'Nota de credito correctiva emitida en Business Central. Opcional, para trazar el documento entre los dos sistemas.';

-- Anular. Misma autorizacion que aprobar/rechazar (schema-v37): analista con
-- alcance multiempresa, administrador por sus empresas asignadas, superadmin
-- sin restriccion. El proveedor NO puede anular: es una decision contable de
-- Adsemble (decidido con Jonatan, 2026-09-08).
create or replace function public.rpc_annul_invoice(
  p_invoice_id uuid,
  p_changed_by uuid,
  p_reason text,
  p_credit_note text default null::text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company_id uuid;
  v_status text;
begin
  if p_changed_by is distinct from auth.uid() then
    raise exception 'p_changed_by debe coincidir con el usuario autenticado';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'El motivo de la anulacion es obligatorio';
  end if;

  select company_id, status into v_company_id, v_status from invoices where id = p_invoice_id;
  if v_company_id is null then
    raise exception 'Factura no encontrada';
  end if;

  -- Solo tiene sentido anular lo que efectivamente salio a BC. Lo que aun no
  -- salio se rechaza, que es el camino que ya existia.
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

  -- El evento de exportacion sigue en el historial: esto se suma, no lo pisa.
  insert into invoice_status_history (invoice_id, status, changed_by, reason)
  values (
    p_invoice_id,
    'annulled',
    p_changed_by,
    btrim(p_reason) || case
      when nullif(btrim(coalesce(p_credit_note, '')), '') is not null
      then ' (nota de credito ' || btrim(p_credit_note) || ')'
      else '' end
  );
end;
$function$;

-- El saldo de la orden ya no cuenta las anuladas.
--
-- Sin esto la funcion no sirve: la orden seguiria viendose como totalmente
-- facturada y el proveedor no podria cargar la factura corregida, que es
-- justo el objetivo de anular.
create or replace function public.check_one_active_invoice_per_po()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order_amount numeric;
  v_invoiced_total numeric;
begin
  if new.purchase_order_id is not null and new.status not in ('rejected', 'annulled') then
    select amount into v_order_amount from purchase_orders where id = new.purchase_order_id;
    if v_order_amount is not null and v_order_amount > 0 then
      select coalesce(sum(total_amount), 0) into v_invoiced_total
      from invoices
      where purchase_order_id = new.purchase_order_id
        and status not in ('rejected', 'annulled')
        and id is distinct from new.id;
      if v_invoiced_total >= v_order_amount then
        raise exception 'Esta orden de compra ya tiene facturado el total de su monto (%). Elimina o espera a que se resuelva una factura existente antes de cargar otra.', v_order_amount
          using errcode = '23505';
      end if;
    end if;
  end if;
  return new;
end;
$function$;
