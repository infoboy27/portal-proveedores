-- Login por RNC/cedula no funcionaba (reporte de Jonatan, 2026-08-25).
-- Dos bugs distintos encontrados al probar en vivo con los 3 vendors reales
-- que tienen un usuario mapeado:
--
-- 1. resolve-login-identifier normaliza el identificador que escribe el
--    usuario (quita guiones/espacios) pero comparaba contra
--    vendors.tax_registration_number SIN normalizar -- BC guarda el RNC con
--    guiones (ej. "131-00000-1"), asi que "1310000 1" nunca calzaba con
--    "131-00000-1" salvo que el valor en BC ya viniera sin guiones (paso con
--    un solo vendor de los tres probados, por casualidad). Se agrega una
--    columna generada (siempre en sync con tax_registration_number, sin
--    depender de que bc-sync-vendors normalice nada) y se compara contra
--    esa columna en vez del texto crudo.
-- 2. El vendor de pruebas df41c0e0 (RNC 00118863612) tenia DOS filas en
--    user_vendor_mapping con is_primary=true (jonathanmaria+proveedor@ y
--    jonathanmaria+qa2026@, ambas creadas en sesiones de QA distintas). La
--    funcion usa maybeSingle(), que falla silenciosamente con mas de una
--    fila -- el login por RNC de ese vendor caia siempre a "no encontrado"
--    aunque el vendor y el mapping existieran. Se dejo una sola primaria
--    (jonathanmaria+proveedor@gmail.com, el contacto que no es de QA) y se
--    agrega un indice unico parcial para que esto no pueda volver a pasar
--    con ningun vendor.

alter table vendors
  add column if not exists tax_registration_number_digits text
  generated always as (regexp_replace(coalesce(tax_registration_number, ''), '[^0-9]', '', 'g')) stored;

create index if not exists vendors_tax_registration_number_digits_idx
  on vendors (tax_registration_number_digits)
  where tax_registration_number_digits <> '';

-- Deja una sola fila is_primary=true por vendor (bug #2) antes de poder
-- crear el indice unico de abajo.
update user_vendor_mapping
set is_primary = false
where vendor_id = 'df41c0e0-4d50-414d-8ef2-7256468338a4'
  and user_id = (select id from user_profiles where email = 'jonathanmaria+qa2026@gmail.com');

create unique index if not exists user_vendor_mapping_one_primary_per_vendor_uq
  on user_vendor_mapping (vendor_id)
  where is_primary;
