-- Pedido real de Jonatan (2026-09-03): hay ordenes de compra con varias
-- lineas que reciben varias facturas -- una por linea, o repartidas en
-- el tiempo (contratos). La regla "1 Orden de Compra = 1 Factura" (Key
-- Players, 2026-09-01, item 1 -- check_one_active_invoice_per_po,
-- schema-v20.sql) bloqueaba esto de raiz: en cuanto una orden tenia
-- CUALQUIER factura no rechazada, dejaba de admitir otra, sin importar
-- cuanto quedara sin facturar del monto total.
--
-- Confirmado con Jonatan antes de este cambio: la orden en BC no se
-- cierra ni cambia de estructura mientras reciba facturas -- solo sirve
-- de "vehiculo" de registro hasta que llega la ultima. Del lado de BC
-- (bc-export-invoice/index.ts) los 3 campos de la Seccion General
-- (fecha, Nº factura, NCF) siguen pisandose con los datos de la ULTIMA
-- factura exportada -- confirmado que esta bien asi (Jonatan: "seria
-- con los datos de ultima factura"), las anteriores quedan disponibles
-- por su PDF adjunto (eso si se acumula, nunca se pisa). No hizo falta
-- ningun cambio del lado de BC/AL.
--
-- Nueva regla: una orden admite una factura nueva mientras quede saldo
-- sin facturar (suma de facturas no rechazadas < order.amount). Si
-- order.amount es null/0 (dato incompleto de BC), no se bloquea --
-- mismo criterio conservador que el resto del portal ante datos
-- incompletos. Facturas con total_amount todavia null (OCR pendiente,
-- ver domain.ts:uploadInvoice) cuentan como 0 en la suma -- no pueden
-- bloquear una carga nueva por un monto que todavia no se conoce.
create or replace function public.check_one_active_invoice_per_po()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order_amount numeric;
  v_invoiced_total numeric;
begin
  if new.purchase_order_id is not null and new.status is distinct from 'rejected' then
    select amount into v_order_amount from purchase_orders where id = new.purchase_order_id;

    if v_order_amount is not null and v_order_amount > 0 then
      select coalesce(sum(total_amount), 0) into v_invoiced_total
      from invoices
      where purchase_order_id = new.purchase_order_id
        and status is distinct from 'rejected'
        and id is distinct from new.id;

      if v_invoiced_total >= v_order_amount then
        raise exception 'Esta orden de compra ya tiene facturado el total de su monto (%). Elimina o espera a que se resuelva una factura existente antes de cargar otra.', v_order_amount
          using errcode = '23505'; -- unique_violation, para que el frontend lo distinga de un error generico
      end if;
    end if;
  end if;
  return new;
end;
$function$;
