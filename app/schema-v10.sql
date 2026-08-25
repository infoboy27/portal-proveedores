-- Intervalos de sync parametrizables (2026-08-24, pedido de Jonatan para la
-- demo con Adsemble). Hasta ahora los intervalos (ordenes/recepciones cada
-- 15 min, pagos cada 30, proveedores cada 6h) estaban fijos como entradas de
-- crontab en el servidor -- cambiarlos requeria que alguien editara el
-- crontab a mano. Esto los mueve a una tabla que el superadmin puede editar
-- desde el panel; el crontab pasa a correr un "tick" fino (cada 5 min) y
-- cada Edge Function de sync decide sola si le toca correr o no, comparando
-- el intervalo configurado contra la ultima corrida (last_run_at). Con esto
-- el piso real de granularidad es el tick del crontab (5 min) -- bajar de
-- ahi si necesita otro cambio de infra, no solo de este panel.
--
-- No reemplaza permisos por RLS normal porque las Edge Functions de sync
-- corren con service_role (bypass RLS) -- la tabla se lee/escribe por SQL
-- directo desde ahi. RLS aqui es solo para que el panel (cliente anon)
-- pueda LEER el estado actual; escribir pasa siempre por la RPC.

create table if not exists system_settings (
  key text primary key,
  value_minutes integer not null,
  last_run_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references user_profiles(id)
);

insert into system_settings (key, value_minutes) values
  ('sync_orders_interval_minutes', 15),
  ('sync_receipts_interval_minutes', 15),
  ('sync_payments_interval_minutes', 30),
  ('sync_vendors_interval_minutes', 360)
on conflict (key) do nothing;

alter table system_settings enable row level security;

drop policy if exists "authenticated read" on system_settings;
create policy "authenticated read" on system_settings for select to authenticated
using (true);

-- === rpc_update_sync_interval ===============================================
-- Unico camino de escritura para el intervalo de un job de sync. Exclusivo
-- de superadmin -- afecta carga contra la API de BC para todos los
-- proveedores, no es un dato de un solo usuario/empresa como updateUser.
-- A diferencia de rpc_update_user_profile (que recibe p_changed_by del
-- cliente), usa auth.uid() directo: no hay razon para confiar en un actor
-- que mande el cliente cuando la sesion ya lo identifica.
create or replace function public.rpc_update_sync_interval(p_key text, p_minutes integer)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role text;
  v_before integer;
begin
  select role into v_caller_role from user_profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role <> 'superadmin' then
    raise exception 'Solo un superadmin puede cambiar los intervalos de sincronizacion';
  end if;

  if p_minutes < 5 or p_minutes > 1440 then
    raise exception 'El intervalo debe estar entre 5 y 1440 minutos';
  end if;

  select value_minutes into v_before from system_settings where key = p_key;
  if not found then
    raise exception 'Parametro desconocido: %', p_key;
  end if;

  update system_settings
  set value_minutes = p_minutes, updated_at = now(), updated_by = auth.uid()
  where key = p_key;

  insert into security_audit_log (event_type, actor_user_id, detail)
  values ('sync_interval_changed', auth.uid(), jsonb_build_object('key', p_key, 'before', v_before, 'after', p_minutes));
end;
$$;
