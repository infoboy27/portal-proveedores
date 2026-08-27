-- Fase 1/3/4 del plan de observaciones de usuarios finales (2026-08-26):
-- 1) Clasificacion de proveedor sincronizada desde BC (vendorPostingGroup),
--    para saber cuando el NCF NO es obligatorio (proveedores informales /
--    extranjeros). Confirmado en vivo contra el sandbox: PROVINFORM (1,174
--    proveedores) e INT (144) ya existen como codigos reales en
--    vendorPostingSetups -- no hace falta inventar un consecutivo nuevo.
-- 2) rpc_confirm_invoice_for_approval: hasta ahora "confirmar" llamaba al
--    RPC generico rpc_update_invoice_status, que NO valida nada -- toda la
--    obligatoriedad de fecha/NCF/total vivia solo en el formulario
--    (Invoices.tsx:handleConfirm). Cualquiera que llamara el RPC generico
--    directo se saltaba el control. Este RPC nuevo re-valida el estado
--    ACTUAL de la fila (ya escrito por updateInvoiceData) antes de permitir
--    el paso a pending_approval, mismo patron de auth que
--    rpc_confirm_purchase_order (schema-v4.sql) y rpc_mark_invoice_paid
--    (schema-v6.sql): revalida rol/dueño server-side, no confia en el
--    cliente.
-- 3) Corte de facturacion dia 25: confirmado con Jonatan que ES un bloqueo
--    (no una reclasificacion automatica) -- factura con fecha posterior al
--    25 se rechaza pidiendo reenviar con fecha del mes siguiente.

alter table vendors add column if not exists vendor_posting_group text;

create or replace function public.rpc_confirm_invoice_for_approval(
  p_invoice_id uuid,
  p_user_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role text;
  v_invoice invoices%rowtype;
  v_vendor_posting_group text;
begin
  select role into v_caller_role from user_profiles where id = p_user_id;

  select * into v_invoice from invoices where id = p_invoice_id;
  if v_invoice.id is null then
    raise exception 'factura % no encontrada', p_invoice_id;
  end if;

  if v_caller_role is null or v_caller_role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from user_vendor_mapping
      where user_id = p_user_id and vendor_id = v_invoice.vendor_id
    ) then
      raise exception 'el usuario no esta autorizado a confirmar esta factura';
    end if;
  end if;

  if v_invoice.status <> 'uploaded' then
    raise exception 'la factura esta en estado "%", no se puede confirmar', v_invoice.status;
  end if;

  if v_invoice.invoice_number is null or btrim(v_invoice.invoice_number) = '' then
    raise exception 'el numero de factura es obligatorio';
  end if;

  if v_invoice.invoice_date is null then
    raise exception 'la fecha de factura es obligatoria';
  end if;

  if extract(day from v_invoice.invoice_date) > 25 then
    raise exception 'El corte de recepcion de facturas es el dia 25 de cada mes. Debes subir esta factura con fecha del mes siguiente.';
  end if;

  if v_invoice.total_amount is null or v_invoice.total_amount <= 0 then
    raise exception 'el total de la factura debe ser mayor a cero';
  end if;

  select vendor_posting_group into v_vendor_posting_group from vendors where id = v_invoice.vendor_id;

  -- Por defecto (grupo vacio/desconocido) se exige NCF -- solo se afloja
  -- para las categorias confirmadas explicitamente como informal/extranjero.
  if coalesce(v_vendor_posting_group, 'CPPROV') not in ('PROVINFORM', 'INT') then
    if v_invoice.invoice_tax_number is null or btrim(v_invoice.invoice_tax_number) = '' then
      raise exception 'el Comprobante Fiscal (NCF) es obligatorio para este proveedor';
    end if;
  end if;

  update invoices
  set status = 'pending_approval',
      changed_by_user_id = p_user_id,
      updated_at = now()
  where id = p_invoice_id;

  insert into invoice_status_history (invoice_id, status, changed_by, reason)
  values (p_invoice_id, 'pending_approval', p_user_id, 'confirmed_by_provider');
end;
$$;
