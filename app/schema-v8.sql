-- Incidente 2026-08-20 (ver docs/BITACORA.md): la primera corrida de
-- bc-sync-vendors se colgo por timeout (patron N+1: un select + un
-- insert/update por cada uno de los ~3,492 vendors del sandbox, secuencial)
-- y, antes de colgarse, ya habia invitado automaticamente a 26 proveedores
-- reales por correo real -- sin aprobacion de Adsemble, sin forma de
-- deshacer el envio. Las 26 cuentas se borraron a mano.
--
-- Esta migracion es la mitad de base de datos de la correccion:
-- 1. Indice unico en vendor_number -- permite upsert en bloque (una sola
--    llamada) en vez de select-then-insert secuencial por fila.
-- La otra mitad (limite duro de invitaciones por corrida, apagado por
-- default) vive en el codigo de bc-sync-vendors, no en el esquema.

-- Nota: se probo primero como indice PARCIAL ("where vendor_number is not
-- null") pero Postgres no lo usa para inferir el target de un ON CONFLICT
-- (error 42P10: "no unique or exclusion constraint matching the ON
-- CONFLICT specification") -- un indice unico normal si sirve, y los NULL
-- siguen siendo validos en un indice unico de Postgres (cada NULL se trata
-- como distinto de los demas), asi que no hace falta la clausula WHERE.
create unique index if not exists vendors_vendor_number_uq
  on vendors (vendor_number);
