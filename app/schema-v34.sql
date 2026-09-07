-- 2026-09-07 -- Un analista puede cubrir varias empresas.
--
-- Pedido de Jonatan al armar el piloto de produccion: las cuatro analistas
-- (Lorenny, Veronica, Yesica y Leidy) tienen que ver las siete empresas del
-- grupo. El modelo no lo permitia: portal_company_ids() resolvia el alcance
-- de un aprobador unicamente desde user_profiles.company_id, que es UNA
-- sola empresa. Un aprobador con company_id nulo no veia nada en absoluto,
-- y con company_id puesto veia exactamente una.
--
-- Los administradores si tenian alcance multiempresa, via
-- admin_company_assignments (schema-v29.sql). Este cambio hace que esa misma
-- tabla sirva para cualquier rol interno, en vez de duplicar el mecanismo.
--
-- El nombre de la tabla queda como esta a proposito: renombrarla obligaria a
-- tocar todas las policies de RLS, invite-user y el frontend, a cambio de
-- nada funcional. Se lee como "asignaciones de empresa" y punto.
--
-- Efecto por rol:
--   superadmin        -- sin cambios, RLS lo exime por completo.
--   admin             -- sin cambios, ya usaba estas filas.
--   approver          -- gana el alcance multiempresa (el objetivo).
--   supplier /
--   service_uploader  -- sin cambios: nunca tienen filas en esta tabla, su
--                        alcance sigue saliendo de user_vendor_mapping.

create or replace function public.portal_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- Proveedores: las empresas de los proveedores que tienen asignados.
  select company_id from user_vendor_mapping
  where user_id = auth.uid() and company_id is not null
  union
  -- Todos los roles: su empresa "principal" del perfil.
  select company_id from user_profiles
  where id = auth.uid() and company_id is not null
  union
  -- Roles internos con alcance sobre varias empresas (administradores desde
  -- schema-v29.sql, analistas desde este cambio).
  select company_id from admin_company_assignments
  where user_id = auth.uid();
$function$;
