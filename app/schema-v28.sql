-- Pedido de Jonatan (2026-09-02, "Cambios solicitados por Key Players",
-- item 7): fecha estimada/posible de pago = fecha de la factura + la
-- condicion de pago (Payment Terms) de la orden de compra en Business
-- Central -- NUNCA una interpretacion local inventada. BC expone
-- `paymentTerms.dueDateCalculation` como un DateFormula (verificado en
-- vivo contra Test672026: today son todas "ND"/"0D", pero el campo es
-- generico y puede tener formulas mas complejas -- "CM", "CM+ND", etc.).
--
-- Cache local de Payment Terms (cambian poco, se resincroniza junto con
-- las ordenes en bc-sync-orders).
create table if not exists public.payment_terms (
  id uuid primary key,
  company_id uuid not null references companies(id) on delete cascade,
  code text not null,
  display_name text,
  due_date_calculation text,
  updated_at timestamptz not null default now()
);

alter table public.payment_terms enable row level security;
drop policy if exists "scoped read" on public.payment_terms;
create policy "scoped read" on public.payment_terms for select to authenticated
  using (
    (portal_role() = any (array['admin', 'superadmin', 'approver']))
    or (company_id in (select portal_company_ids()))
  );

alter table public.purchase_orders add column if not exists payment_terms_id uuid;

-- Interprete minimo de DateFormula de BC. Solo reconoce los patrones que
-- ya se confirmaron en vivo (ND) mas los mas comunes documentados por
-- Microsoft (semanas/meses/anios, fin de mes) -- ante cualquier formula
-- que no reconoce, devuelve NULL en vez de adivinar una fecha
-- incorrecta (se prefiere "sin estimado" a un estimado mal calculado).
create or replace function public.estimate_payment_date(p_base_date date, p_formula text)
returns date
language plpgsql
immutable
as $$
declare
  v_formula text;
  v_result date;
  v_num int;
  v_unit text;
begin
  if p_base_date is null or p_formula is null or btrim(p_formula) = '' then
    return null;
  end if;
  v_formula := upper(btrim(p_formula));

  if v_formula = 'CM' then
    return (date_trunc('month', p_base_date) + interval '1 month - 1 day')::date;
  elsif v_formula ~ '^CM\+[0-9]+[DWMY]$' then
    v_num := (substring(v_formula from 'CM\+([0-9]+)'))::int;
    v_unit := substring(v_formula from '[0-9]+([DWMY])$');
    v_result := (date_trunc('month', p_base_date) + interval '1 month - 1 day')::date;
  elsif v_formula ~ '^[0-9]+[DWMY]$' then
    v_num := (substring(v_formula from '^([0-9]+)'))::int;
    v_unit := substring(v_formula from '[0-9]+([DWMY])$');
    v_result := p_base_date;
  else
    return null;
  end if;

  v_result := case v_unit
    when 'D' then v_result + (v_num || ' days')::interval
    when 'W' then v_result + (v_num || ' weeks')::interval
    when 'M' then v_result + (v_num || ' months')::interval
    when 'Y' then v_result + (v_num || ' years')::interval
    else v_result
  end;

  return v_result;
end;
$$;

-- Se calcula al confirmar/actualizar la fecha de factura, nunca pisa un
-- valor real de BC (`payment_source = 'bc'`, viene de bc-sync-payments,
-- el vendorLedgerEntries.dueDate real una vez posteada) ni uno puesto a
-- mano (`'manual'`, ver setInvoicePaymentDueDate en domain.ts) -- el
-- orden de prioridad es: BC real > manual > estimado > nada.
create or replace function public.set_estimated_payment_date()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_formula text;
  v_estimate date;
begin
  if new.payment_source in ('bc', 'manual') then
    return new;
  end if;
  if new.invoice_date is null or new.purchase_order_id is null then
    return new;
  end if;

  select pt.due_date_calculation into v_formula
  from purchase_orders po
  join payment_terms pt on pt.id = po.payment_terms_id
  where po.id = new.purchase_order_id;

  if v_formula is null then
    return new;
  end if;

  v_estimate := estimate_payment_date(new.invoice_date, v_formula);
  if v_estimate is not null then
    new.payment_due_date := v_estimate;
    new.payment_source := 'estimated';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_estimated_payment_date on public.invoices;
create trigger trg_set_estimated_payment_date
  before insert or update of invoice_date, purchase_order_id on public.invoices
  for each row execute function public.set_estimated_payment_date();
