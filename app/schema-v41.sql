-- 2026-09-08 -- El analista puede confirmar los datos de una factura.
--
-- Pedido del equipo: registrar desde el portal las facturas de los
-- proveedores internos fijos (Claro, EDESUR, el acueducto, los seguros),
-- desde el usuario de analista que ya usan a diario, en vez de un login
-- generico compartido.
--
-- La carga ya funcionaba (la policy "scoped insert" de invoices incluye
-- approver), pero confirmar fallaba: esta funcion resuelve la autorizacion
-- por su cuenta y el rol approver caia en el `else`, que exige un vinculo en
-- user_vendor_mapping -- algo que un analista no tiene ni debe tener. El
-- mensaje era "el usuario no esta autorizado a confirmar esta factura".
--
-- Se agrega la rama del analista con el mismo criterio que ya usan
-- rpc_update_invoice_status y rpc_annul_invoice (schema-v37/v40): acotado a
-- las empresas de su alcance.
--
-- SEGUNDO ARREGLO, encontrado leyendo esta funcion: la exencion de NCF aqui
-- seguia siendo solo ('PROVINFORM','INT') -- le faltaba GASMENOR, igual que
-- le faltaba a bc-export-invoice y al frontend el 2026-09-04. O sea que un
-- proveedor de gasto menor podia cargar su factura pero no confirmarla: se
-- le exigia un NCF que por definicion no emite. Se me escapo al corregir los
-- otros dos lugares.
--
-- La firma se mantiene identica a proposito: asi "create or replace"
-- reemplaza y no crea una segunda sobrecarga.

create or replace function public.rpc_confirm_invoice_for_approval(p_invoice_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_role text;
  v_invoice invoices%rowtype;
  v_vendor_posting_group text;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'p_user_id debe coincidir con el usuario autenticado';
  end if;

  select role into v_caller_role from user_profiles where id = p_user_id;

  select * into v_invoice from invoices where id = p_invoice_id;
  if v_invoice.id is null then
    raise exception 'factura % no encontrada', p_invoice_id;
  end if;

  if v_caller_role = 'superadmin' then
    null;
  elsif v_caller_role = 'admin' then
    if v_invoice.company_id not in (select portal_admin_company_ids()) then
      raise exception 'no tenes autorizacion sobre esta factura';
    end if;
  elsif v_caller_role = 'approver' then
    if v_invoice.company_id not in (select portal_company_ids()) then
      raise exception 'no tenes autorizacion sobre esta factura';
    end if;
  else
    -- proveedor / carga interna: solo sobre sus propios proveedores.
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

  -- GASMENOR incluido (2026-09-08): el gasto menor tampoco emite NCF, lo
  -- emite Adsemble. Ver el listado del equipo: "Clasificaciones incluidas:
  -- PROVINFORM, GASMENOR e INT".
  if coalesce(v_vendor_posting_group, 'CPPROV') not in ('PROVINFORM', 'INT', 'GASMENOR') then
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
$function$;
