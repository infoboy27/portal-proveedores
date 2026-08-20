-- Validacion real de factura (Dias 10-13 del compromiso con Adsemble).
-- Hasta ahora estaba explicitamente omitida (ver comentario historico en
-- Invoices.tsx: "se omite el flujo de carga con modal de factura
-- duplicada"). Se cierra en dos partes:
--
-- 1. Duplicado: indice unico (vendor_id, invoice_number), ignorando filas
--    donde el numero todavia esta vacio (uploadInvoice crea la factura con
--    invoice_number='' antes de que el proveedor lo complete en
--    InvoiceDetail — ver Orders.tsx/Invoices.tsx). Es la ultima linea de
--    defensa; la app ya valida esto antes con un mensaje explicito
--    (domain.ts:updateInvoiceData) para no depender solo del error crudo
--    de Postgres.
-- 2. Monto: no tiene equivalente en base de datos — se valida en la app
--    (domain.ts) porque requiere comparar contra la orden de compra
--    vinculada al momento de guardar, no es una propiedad estatica de la fila.

create unique index if not exists invoices_vendor_invoice_number_uq
  on invoices (vendor_id, invoice_number)
  where vendor_id is not null and invoice_number is not null and invoice_number <> '';
