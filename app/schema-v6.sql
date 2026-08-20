-- Pagos / estado de cuenta (Dias 13-15 del compromiso con Adsemble).
--
-- Business Central estandar no expone vendor ledger entries para este
-- tenant (sin confirmar todavia, ver docs/BUSINESS_CENTRAL_INTEGRATION.md §7
-- y §4) -- por la regla del proyecto de no inventar endpoints, esto NO se
-- sincroniza automaticamente desde BC. Se registra manualmente en el
-- portal, igual que ya se hace con `payment_due_date` (fecha posible de
-- pago) desde antes de esta migracion.
--
-- No se agrega un valor nuevo a `invoices.status` para "pagada" -- se
-- deriva de `paid_at`: status='processed' + paid_at is null = "Pendiente
-- de Pago"; status='processed' + paid_at is not null = "Pagada". Ver
-- PaymentStatusBadge.tsx en el frontend.

alter table invoices add column if not exists paid_at date;
alter table invoices add column if not exists payment_reference text;

-- SECURITY DEFINER: unico camino de escritura para paid_at/payment_reference,
-- mismo patron que rpc_confirm_purchase_order — revalida el rol server-side
-- en vez de confiar en que el cliente ya filtro por rol en la UI.
create or replace function public.rpc_mark_invoice_paid(
  p_invoice_id uuid,
  p_changed_by uuid,
  p_paid_at date,
  p_payment_reference text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role text;
begin
  if p_paid_at is null then
    raise exception 'la fecha de pago es obligatoria';
  end if;

  select role into v_caller_role from user_profiles where id = p_changed_by;
  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin', 'approver') then
    raise exception 'el usuario no esta autorizado a marcar facturas como pagadas';
  end if;

  update invoices
  set paid_at = p_paid_at,
      payment_reference = p_payment_reference,
      changed_by_user_id = p_changed_by,
      updated_at = now()
  where id = p_invoice_id and status = 'processed';

  if not found then
    raise exception 'la factura no existe o no esta en estado "processed"';
  end if;

  -- 'paid' aqui es solo una etiqueta de auditoria en el historial -- nunca
  -- es un valor real de invoices.status (que se queda en 'processed').
  insert into invoice_status_history (invoice_id, status, changed_by, reason)
  values (p_invoice_id, 'paid', p_changed_by, p_payment_reference);
end;
$$;
