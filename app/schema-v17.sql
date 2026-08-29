-- Fase 2 del plan multiempresa (2026-08-29): agrega las 10 empresas
-- restantes en alcance a `companies`, con sus GUID reales de BC
-- (confirmados en vivo contra el tenant Test672026). Se insertan
-- DESHABILITADAS a proposito (disabled_at = now()) -- el loop
-- multiempresa de bc-sync-vendors/orders/receipts/payments ya esta listo
-- para procesarlas (ver _shared/companies.ts), pero activarlas empieza a
-- sincronizar miles de proveedores/ordenes reales por empresa, asi que
-- se prende una por una, no todas de golpe.
--
-- Para activar una empresa mas adelante:
--   update companies set disabled_at = null where company_name = '...';

insert into companies (company_name, bc_code, disabled_at) values
  ('DUCKTAPE MEDIA GROUP', '672dde88-a838-f011-be59-00224835c118', now()),
  ('JUAN FABIAN', '74c8f2e2-d438-f011-be59-00224835c118', now()),
  ('Liquid Digital Agency', '9523ac6e-0c3e-ee11-bdf5-002248362c6a', now()),
  ('MCSD Advertising', '6cacd8a2-0c3e-ee11-bdf5-002248362c6a', now()),
  ('Mindertown Estates', '933f9f6e-d438-f011-be59-00224835c118', now()),
  ('MOM', 'bbf573ba-0c3e-ee11-bdf5-002248362c6a', now()),
  ('NINJA, SRL', '77537ed3-0c3e-ee11-bdf5-002248362c6a', now()),
  ('OR Advertising (Outstanding)', '0a5d5aed-0c3e-ee11-bdf5-002248362c6a', now()),
  ('Splash Media, SRL', '4e75c839-0d3e-ee11-bdf5-002248362c6a', now()),
  ('Symbiosis', '14e400ff-4ede-ef11-9344-002248371572', now())
on conflict do nothing;
