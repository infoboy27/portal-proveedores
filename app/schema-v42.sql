-- 2026-09-08 -- Lista de proveedores internos fijos.
--
-- Son los proveedores cuyas facturas registra Adsemble y no el proveedor:
-- servicios recurrentes que llegan todos los meses (telefonia, energia,
-- agua, seguros). El equipo los carga desde el portal con su usuario de
-- analista (schema-v41.sql), y esta lista es para que no tengan que buscar
-- entre 3,609 proveedores cada vez.
--
-- Se identifican por NUMERO de proveedor, no por la fila de `vendors`: cada
-- proveedor tiene una fila distinta por empresa (PROV-000806 existe 7 veces,
-- una por agencia), asi que la lista es de numeros y sirve para las siete
-- por igual. Ademas sobrevive a las sincronizaciones desde BC, que reescriben
-- `vendors` pero no tocan esta tabla.
--
-- default_account: cuenta contable fija, opcional. El portal normalmente la
-- deduce del historial del proveedor en BC, pero hay casos donde el historial
-- no es concluyente y por eso no la pone -- EDESUR alterna entre 5000 y 6104.
-- Cargando la cuenta aca se resuelve ese caso sin adivinar.

create table if not exists public.internal_vendors (
  vendor_number text primary key,
  display_name text not null,
  default_account text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

comment on table public.internal_vendors is
  'Proveedores internos fijos: sus facturas las registra Adsemble desde el portal, no el proveedor. Clave por numero de proveedor para que aplique a las 7 empresas.';

alter table public.internal_vendors enable row level security;

-- Lectura: cualquier rol interno. El proveedor no necesita esta lista.
drop policy if exists "internal read" on public.internal_vendors;
create policy "internal read" on public.internal_vendors for select using (
  portal_role() = any (array['superadmin', 'admin', 'approver', 'service_uploader'])
);

-- Escritura: solo quien administra.
drop policy if exists "admin write" on public.internal_vendors;
create policy "admin write" on public.internal_vendors for all using (
  portal_role() = any (array['superadmin', 'admin'])
) with check (
  portal_role() = any (array['superadmin', 'admin'])
);

-- Los ocho que indico el equipo el 2026-09-08. Verificados uno por uno
-- contra produccion: los ocho existen en las siete empresas.
insert into public.internal_vendors (vendor_number, display_name) values
  ('PROV-000003', 'Compañía Dominicana de Teléfonos'),
  ('PROV-000006', 'Mapfre Salud ARS'),
  ('PROV-002674', 'Corporación del Acueducto y Alcantarillado de Santo Domingo'),
  ('PROV-003005', 'Amerident Grupo Odontológico'),
  ('PROV-000269', 'Seguros Universal'),
  ('PROV-003002', 'Humano Seguros'),
  ('PROV-000806', 'Edesur Dominicana'),
  ('PROV-001913', 'Ixiene Flex')
on conflict (vendor_number) do nothing;
