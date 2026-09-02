-- Hallazgo real de la ronda de pruebas de Key Players (2026-09-01, items 8
-- y 18 -- "nunca confiar en el rol que mande el frontend" + regresion):
-- probado en vivo que un PROVEEDOR podia llamar rpc_update_invoice_status
-- con p_status='approved' sobre SU PROPIA factura y la aprobacion se
-- aplicaba de verdad -- la funcion es SECURITY DEFINER (necesario para que
-- un aprobador pueda tocar facturas de proveedores que no son el suyo) y
-- por eso corre SIN la RLS de "invoices" de por medio (que si hubiera
-- bloqueado un UPDATE directo -- "scoped update", schema-v3.sql, exige que
-- el NUEVO status siga en draft/uploaded/pending_approval para un
-- supplier). La funcion nunca reimplementaba esa validacion por su cuenta
-- -- quedaba abierta a cualquiera con sesion, sin importar el rol, y
-- ademas confiaba en p_changed_by sin verificar que fuera realmente quien
-- llama (se podia atribuir el cambio a otro usuario en la auditoria).
--
-- Arreglado: exige que p_changed_by sea auth.uid() (nunca otro usuario), y
-- que quien llama sea admin/superadmin, o approver de la MISMA empresa de
-- la factura -- mismo criterio que ya usa "scoped update" para approver,
-- ahora tambien adentro del RPC.
create or replace function public.rpc_update_invoice_status(
  p_invoice_id uuid,
  p_status text,
  p_changed_by uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_company_id uuid;
begin
  if p_changed_by is distinct from auth.uid() then
    raise exception 'p_changed_by debe coincidir con el usuario autenticado';
  end if;

  select company_id into v_company_id from invoices where id = p_invoice_id;
  if v_company_id is null then
    raise exception 'Factura no encontrada';
  end if;

  if not (
    portal_role() in ('admin', 'superadmin')
    or (portal_role() = 'approver' and v_company_id = portal_company_id())
  ) then
    raise exception 'Solo un administrador o aprobador puede aprobar/rechazar esta factura';
  end if;

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
