-- Acota el bucket de Storage "invoices" al mismo alcance que ya tiene la
-- tabla invoices (2026-08-25, hallazgo al agregar el boton de descarga de
-- Invoices.tsx). Hasta ahora storage.objects tenia una sola politica
-- "authenticated all invoices bucket" (ALL, sin condicion mas alla de
-- bucket_id = 'invoices') -- CUALQUIER usuario logueado podia leer/escribir
-- el PDF de CUALQUIER factura, de cualquier proveedor. La tabla invoices en
-- si siempre estuvo bien acotada por RLS ("scoped read"/"scoped update");
-- esta migracion lleva el mismo criterio a los archivos.
--
-- Dos politicas, no una ALL, porque el momento de la subida (INSERT) es
-- distinto al de la lectura (SELECT): al subir un PDF nuevo (uploadInvoice en
-- domain.ts) todavia no existe la fila en invoices -- se sube el archivo
-- primero, se inserta la fila despues -- asi que INSERT no puede validarse
-- contra invoices.file_path como SELECT. Se valida en cambio contra el
-- prefijo de carpeta (company_id), que uploadInvoice ya arma como
-- `${companyId}/...` y que coincide con portal_company_id() del usuario que
-- sube (todo user_profiles, incluido supplier, tiene company_id asignado).
--
-- UPDATE/DELETE de storage.objects no tienen politica a proposito -- el
-- frontend nunca los usa (solo upload + createSignedUrl), asi que quedan
-- denegados por RLS por defecto en vez de heredar el alcance de SELECT sin
-- necesidad real.

-- Backfill necesario para que la politica de INSERT no rompa subidas: dos
-- cuentas (un admin real de Adsemble y la cuenta de pruebas QA) tenian
-- user_profiles.company_id NULL -- probablemente porque el invite de admin
-- no pide companyId. Hoy solo existe una empresa en el sistema (Adsemble,
-- 11111111-1111-1111-1111-111111111111 -- ver tabla companies), asi que no
-- hay ambiguedad en a cual asignarlos.
update user_profiles set company_id = '11111111-1111-1111-1111-111111111111'
where company_id is null;

drop policy if exists "authenticated all invoices bucket" on storage.objects;

drop policy if exists "insert own company invoices bucket" on storage.objects;
create policy "insert own company invoices bucket" on storage.objects for insert to authenticated
with check (
  bucket_id = 'invoices'
  and (storage.foldername(name))[1] = public.portal_company_id()::text
);

drop policy if exists "scoped read invoices bucket" on storage.objects;
create policy "scoped read invoices bucket" on storage.objects for select to authenticated
using (
  bucket_id = 'invoices'
  and exists (
    select 1 from public.invoices i
    where i.file_path = storage.objects.name
      and (
        public.portal_role() in ('admin', 'superadmin')
        or (public.portal_role() = 'approver' and i.company_id = public.portal_company_id())
        or (public.portal_role() in ('supplier', 'service_uploader') and i.vendor_id in (select public.portal_vendor_ids()))
      )
  )
);
