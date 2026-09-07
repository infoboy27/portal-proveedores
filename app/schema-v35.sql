-- 2026-09-07 -- Marca de ultima sincronizacion de proveedores POR empresa.
--
-- bc-sync-vendors procesaba todas las empresas activas dentro de una sola
-- invocacion. Con una empresa activa funcionaba; al activar las siete de
-- produccion (3,609 proveedores por empresa) el worker excedio el limite
-- DURO de CPU del runtime y el supervisor lo mato: "CPU time hard limit
-- reached". No es un limite que se pueda subir por configuracion como el de
-- tiempo de reloj.
--
-- La solucion es no hacer todo en una corrida: cada invocacion procesa UNA
-- empresa, la que lleve mas tiempo sin sincronizar. Con el cron cada 15
-- minutos, las siete quedan al dia en menos de dos horas -- de sobra para un
-- catalogo de proveedores, que cambia poco.
--
-- Nulo = nunca sincronizada, y por eso va primero en la cola.

alter table public.companies
  add column if not exists vendors_synced_at timestamptz;

comment on column public.companies.vendors_synced_at is
  'Ultima vez que bc-sync-vendors proceso esta empresa. La empresa con el valor mas viejo (o nulo) es la siguiente en la cola.';
