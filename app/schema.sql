-- Portal de Proveedores Adsemble — esquema reconstruido
-- Fuente: Portal-proveedores/extraido/01-esquema-tablas.md (ingenieria inversa del bundle)

create extension if not exists "pgcrypto";

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  bc_code text,
  disabled_at timestamptz
);

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  vendor_number text,
  tax_registration_number text,
  company_name text not null,
  status text default 'active',
  valid_invoice_tax_number boolean
);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  vendor_id uuid references vendors(id),
  order_number text not null,
  order_date date,
  amount numeric(14,2),
  status text default 'active',
  sequence int
);

create table if not exists purchase_orders_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references purchase_orders(id) on delete cascade,
  company_id uuid references companies(id),
  description text,
  quantity numeric(14,2),
  price numeric(14,2),
  amount numeric(14,2),
  sequence int
);

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  purchase_order_id uuid references purchase_orders(id),
  vendor_id uuid references vendors(id),
  vendor_name text,
  vendor_tax_id text,
  invoice_number text not null,
  invoice_tax_number text,
  invoice_tax_security_number text,
  invoice_date date,
  invoice_duedate date,
  fiscal_duedate date,
  subtotal_amount numeric(14,2) default 0,
  discount_amount numeric(14,2) default 0,
  total_tax_amount numeric(14,2) default 0,
  total_amount numeric(14,2) default 0,
  status text not null default 'draft',
  file_path text,
  filename text,
  valid_tax_number boolean,
  valid_invoice_tax_number boolean,
  rejection_reason text,
  erp_id text,
  changed_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  company_id uuid references companies(id),
  description text,
  quantity numeric(14,2),
  price numeric(14,2),
  amount numeric(14,2),
  sequence int
);

create table if not exists invoice_status_history (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  status text not null,
  changed_by uuid,
  reason text,
  changed_at timestamptz not null default now()
);

create table if not exists user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text,
  email text,
  role text not null check (role in ('admin','superadmin','approver','supplier')),
  company_id uuid references companies(id),
  active boolean not null default true,
  last_login timestamptz
);

create table if not exists user_vendor_mapping (
  user_id uuid references user_profiles(id) on delete cascade,
  vendor_id uuid references vendors(id) on delete cascade,
  company_id uuid references companies(id),
  is_primary boolean default true,
  primary key (user_id, vendor_id)
);

-- RPCs usados por el frontend (ver extraido/01-esquema-tablas.md)

create or replace function rpc_update_invoice_status(
  p_invoice_id uuid,
  p_status text,
  p_changed_by uuid,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
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

create or replace function update_invoice_data(
  p_user_id uuid,
  p_invoice jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  v_id := coalesce((p_invoice->>'id')::uuid, gen_random_uuid());

  insert into invoices (
    id, company_id, purchase_order_id, vendor_name, vendor_tax_id,
    invoice_number, invoice_tax_number, invoice_tax_security_number,
    invoice_date, invoice_duedate, fiscal_duedate,
    subtotal_amount, discount_amount, total_tax_amount, total_amount,
    status, file_path, filename, valid_tax_number, valid_invoice_tax_number,
    changed_by_user_id, updated_at
  ) values (
    v_id,
    (p_invoice->>'company_id')::uuid,
    (p_invoice->>'purchase_order_id')::uuid,
    p_invoice->>'vendor_name',
    p_invoice->>'vendor_tax_id',
    p_invoice->>'invoice_number',
    p_invoice->>'invoice_tax_number',
    p_invoice->>'invoice_tax_security_number',
    (p_invoice->>'invoice_date')::date,
    (p_invoice->>'invoice_duedate')::date,
    (p_invoice->>'fiscal_duedate')::date,
    coalesce((p_invoice->>'subtotal_amount')::numeric, 0),
    coalesce((p_invoice->>'discount_amount')::numeric, 0),
    coalesce((p_invoice->>'total_tax_amount')::numeric, 0),
    coalesce((p_invoice->>'total_amount')::numeric, 0),
    coalesce(p_invoice->>'status', 'uploaded'),
    p_invoice->>'file_path',
    p_invoice->>'filename',
    (p_invoice->>'valid_tax_number')::boolean,
    (p_invoice->>'valid_invoice_tax_number')::boolean,
    p_user_id,
    now()
  )
  on conflict (id) do update set
    vendor_name = excluded.vendor_name,
    vendor_tax_id = excluded.vendor_tax_id,
    invoice_number = excluded.invoice_number,
    invoice_tax_number = excluded.invoice_tax_number,
    invoice_tax_security_number = excluded.invoice_tax_security_number,
    invoice_date = excluded.invoice_date,
    invoice_duedate = excluded.invoice_duedate,
    fiscal_duedate = excluded.fiscal_duedate,
    subtotal_amount = excluded.subtotal_amount,
    discount_amount = excluded.discount_amount,
    total_tax_amount = excluded.total_tax_amount,
    total_amount = excluded.total_amount,
    status = excluded.status,
    file_path = excluded.file_path,
    filename = excluded.filename,
    valid_tax_number = excluded.valid_tax_number,
    valid_invoice_tax_number = excluded.valid_invoice_tax_number,
    changed_by_user_id = excluded.changed_by_user_id,
    updated_at = now();

  return v_id;
end;
$$;

-- RLS: dev environment — lectura abierta a usuarios autenticados (la app
-- filtra por rol/empresa en cliente, replicando el original), escritura solo
-- vía las RPC de arriba (security definer) o service_role.
-- TODO produccion: reemplazar "authenticated read-all" por policies que
-- respeten company_id/vendor_id por fila, antes de manejar datos reales.

alter table companies enable row level security;
alter table vendors enable row level security;
alter table purchase_orders enable row level security;
alter table purchase_orders_lines enable row level security;
alter table invoices enable row level security;
alter table invoice_lines enable row level security;
alter table invoice_status_history enable row level security;
alter table user_profiles enable row level security;
alter table user_vendor_mapping enable row level security;

create policy "authenticated read" on companies for select to authenticated using (true);
create policy "authenticated read" on vendors for select to authenticated using (true);
create policy "authenticated read" on purchase_orders for select to authenticated using (true);
create policy "authenticated read" on purchase_orders_lines for select to authenticated using (true);
create policy "authenticated read" on invoices for select to authenticated using (true);
create policy "authenticated read" on invoice_lines for select to authenticated using (true);
create policy "authenticated read" on invoice_status_history for select to authenticated using (true);
create policy "self read" on user_profiles for select to authenticated using (true);
create policy "self read" on user_vendor_mapping for select to authenticated using (true);

create policy "authenticated insert invoices" on invoices for insert to authenticated with check (true);
create policy "authenticated update invoices" on invoices for update to authenticated using (true);
