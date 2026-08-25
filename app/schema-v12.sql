-- No permitir subir la misma factura mas de una vez, usando el NCF
-- (Numero de Comprobante Fiscal) como criterio -- es unico por proveedor
-- ante la DGII, a diferencia de invoice_number que cada proveedor arma como
-- quiera. Mismo patron que schema-v5.sql ya uso para invoice_number: indice
-- unico (vendor_id, invoice_tax_number) como ultima linea de defensa, mas un
-- chequeo en la app (domain.ts:updateInvoiceData) con mensaje explicito para
-- no depender solo del error crudo de Postgres.
--
-- Se ignoran filas donde el NCF todavia esta vacio -- uploadInvoice crea la
-- factura sin NCF (lo completa el OCR o el proveedor a mano en
-- InvoiceDetail antes de confirmar), asi que muchas filas coexisten con
-- invoice_tax_number null mientras estan en borrador.

create unique index if not exists invoices_vendor_ncf_uq
  on invoices (vendor_id, invoice_tax_number)
  where vendor_id is not null and invoice_tax_number is not null and invoice_tax_number <> '';
