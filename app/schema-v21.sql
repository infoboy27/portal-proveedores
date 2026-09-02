-- Key Players (2026-09-01), item 6: filtros server-side de Ordenes de
-- Compra. Orders.tsx dejo de cargar TODAS las ordenes al store global para
-- pintar la lista -- ahora pagina/filtra en la base. Las 4 tarjetas de
-- estadisticas (activas/borradores/pendientes/monto total) mostraban
-- totales sobre TODO el alcance del usuario (no sobre lo tecleado en el
-- buscador/status), asi que no pueden salir de la pagina actual de 20
-- filas -- este RPC calcula los 4 numeros en la base, en una sola vuelta.
--
-- security invoker (default, explicito igual) a proposito: corre como el
-- rol de quien llama, asi que "scoped read" (schema-v3.sql) sigue
-- aplicando sobre el SELECT de adentro sin que este RPC necesite repetir
-- ninguna logica de aislamiento a mano -- un proveedor solo ve el
-- agregado de SUS propias ordenes, como siempre.
create or replace function public.rpc_purchase_order_stats(
  p_company_id uuid default null,
  p_vendor_id uuid default null
)
returns table (active_count bigint, draft_count bigint, pending_count bigint, total_value numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where status != 'closed') as active_count,
    count(*) filter (where status = 'draft') as draft_count,
    count(*) filter (where status = 'in_review') as pending_count,
    coalesce(sum(amount), 0) as total_value
  from purchase_orders
  where (p_company_id is null or company_id = p_company_id)
    and (p_vendor_id is null or vendor_id = p_vendor_id);
$$;
