-- Superadmin real + auditoria de seguridad (2026-08-20). Hasta ahora
-- `admin`/`superadmin` eran el mismo rol en la practica -- ningun lugar del
-- codigo los trataba distinto (confirmado por Jonatan al preguntar "deberia
-- haber un superusuario para esos fines" -- no lo habia).
--
-- Dos fuentes de auditoria, complementarias, no una sola:
-- 1. `auth.audit_log_entries` -- YA EXISTE, la llena GoTrue solo (login,
--    logout, cambio de password, etc). Autoritativa para eventos de sesion,
--    pero el actor que ve ahi para acciones hechas via service_role (como
--    invite-user) es "service_role", no el admin humano que hizo clic en
--    la app -- por eso no alcanza sola.
-- 2. `security_audit_log` (nueva, esta migracion) -- eventos a nivel de
--    negocio: que admin invito/cambio de rol/desactivo a quien. La llenan
--    directamente las RPCs/Edge Functions que ya corren con privilegio
--    elevado (no hace falta una funcion intermedia para insertar).

create table if not exists security_audit_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null, -- 'user_invited' | 'user_role_changed' | 'user_deactivated' | 'user_reactivated' | 'user_deleted'
  actor_user_id uuid references user_profiles(id),
  target_user_id uuid,
  target_email text,
  detail jsonb,
  created_at timestamptz not null default now()
);

alter table security_audit_log enable row level security;

drop policy if exists "superadmin read" on security_audit_log;
create policy "superadmin read" on security_audit_log for select to authenticated
using (portal_role() = 'superadmin');

-- === rpc_update_user_profile ===============================================
-- Reemplaza el UPDATE directo que hacia domain.ts:updateUser (sin auditoria,
-- sin distincion de quien lo hizo). Unico camino de escritura para rol/
-- empresa/estado activo de un usuario; registra el cambio.
create or replace function public.rpc_update_user_profile(
  p_target_user_id uuid,
  p_changed_by uuid,
  p_role text,
  p_company_id uuid,
  p_active boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role text;
  v_before record;
begin
  select role into v_caller_role from user_profiles where id = p_changed_by;
  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin') then
    raise exception 'el usuario no esta autorizado a editar perfiles';
  end if;

  select role, company_id, active, email into v_before from user_profiles where id = p_target_user_id;
  if not found then
    raise exception 'usuario % no encontrado', p_target_user_id;
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

-- === rpc_recent_auth_events =================================================
-- Expone auth.audit_log_entries (GoTrue) a traves de un punto controlado --
-- esa tabla no tiene politicas RLS propias (deny-all por defecto para
-- "authenticated"), asi que sin esto nadie desde la app podria leerla.
-- Solo superadmin.
create or replace function public.rpc_recent_auth_events(p_limit int default 200)
returns table (event_at timestamptz, action text, actor_email text, ip_address text)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from user_profiles where id = auth.uid() and role = 'superadmin') then
    raise exception 'Solo un superadmin puede consultar el historial de sesiones';
  end if;

  return query
  select a.created_at, a.payload->>'action', a.payload->>'actor_username', a.ip_address::text
  from auth.audit_log_entries a
  order by a.created_at desc
  limit p_limit;
end;
$$;
