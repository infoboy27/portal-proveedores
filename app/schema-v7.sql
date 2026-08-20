-- Cierra el ultimo bloqueo real de BC: recepciones y pagos reales, ahora que
-- infra/business-central/ esta publicada y confirmada en Test672026
-- (2026-08-20, ver docs/BITACORA.md).

-- === Recepciones de compra (purchaseReceipts, Custom API) ================

create table if not exists purchase_order_receipts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references purchase_orders(id) on delete cascade,
  company_id uuid references companies(id),
  bc_id text,
  receipt_number text not null,
  vendor_shipment_no text,
  posting_date date
);

create unique index if not exists purchase_order_receipts_bc_id_uq
  on purchase_order_receipts (bc_id)
  where bc_id is not null;

alter table purchase_order_receipts enable row level security;

drop policy if exists "scoped read" on purchase_order_receipts;
create policy "scoped read" on purchase_order_receipts for select to authenticated
using (
  portal_role() in ('admin', 'superadmin')
  or (portal_role() = 'approver' and company_id = portal_company_id())
  or (
    portal_role() in ('supplier', 'service_uploader')
    and exists (
      select 1 from purchase_orders po
      where po.id = purchase_order_receipts.order_id
        and po.vendor_id in (select portal_vendor_ids())
    )
  )
);

-- === Pagos reales (vendorLedgerEntries, Custom API) =======================
-- payment_source distingue si paid_at/payment_due_date vienen de BC
-- (bc-sync-payments) o de la entrada manual que ya existia (schema-v6.sql).

alter table invoices add column if not exists payment_source text;
alter table invoices add column if not exists bc_ledger_entry_no text;

-- El RPC manual (schema-v6.sql) ahora marca explicitamente payment_source
-- = 'manual', para que el frontend pueda distinguir "alguien lo marco a
-- mano" de "vino sincronizado de BC" sin ambiguedad.
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
      payment_source = 'manual',
      bc_ledger_entry_no = null,
      updated_at = now()
  where id = p_invoice_id and status = 'processed';

  if not found then
    raise exception 'la factura no existe o no esta en estado "processed"';
  end if;

  insert into invoice_status_history (invoice_id, status, changed_by, reason)
  values (p_invoice_id, 'paid', p_changed_by, p_payment_reference);
end;
$$;
