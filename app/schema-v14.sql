-- Baja el piso de los intervalos de sync de 5 a 1 minuto (pedido de
-- Jonatan en vivo, 2026-08-25, para ordenes de compra). El piso de 5
-- tambien vivia en el tick del crontab del servidor -- este cambio de SQL
-- por si solo no alcanza, hace falta ademas bajar el tick del crontab de
-- */5 a */1 (hecho a mano en el servidor, no versionado, igual que el
-- cambio de crontab de schema-v10.sql).

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

  if p_minutes < 1 or p_minutes > 1440 then
    raise exception 'El intervalo debe estar entre 1 y 1440 minutos';
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
