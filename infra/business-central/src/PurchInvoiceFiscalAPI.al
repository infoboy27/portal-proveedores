// Expone "No. Comprobante Fiscal" (NCF, campo obligatorio de cumplimiento
// fiscal de Republica Dominicana) sobre facturas de compra sin publicar
// (Purchase Header, Document Type = Invoice). La API estandar v2.0 de BC
// no expone este campo en ningun lugar — confirmado inspeccionando el
// $metadata completo de la entidad purchaseInvoices (46 campos, ninguno
// fiscal/NCF). Sin este valor, la accion de posteo estandar
// (Microsoft.NAV.post) rechaza el documento con "Fiscal Document No. must
// have a value". bc-export-invoice ya captura este dato
// (invoices.invoice_tax_number, el mismo NCF que hoy se manda como
// vendorInvoiceNumber al crear la factura) — falta escribirlo aqui antes
// de intentar postear.
//
// Nombre real del campo: "DSNNo. Comprobante Fiscal" (no "No. Comprobante
// Fiscal" — primer intento fallo con AL0132, "does not contain a
// definition"). El prefijo "DSN" es de DYNASOFT SRL, el mismo publisher
// de "Adsemble Liquid Base" ya instalado en este tenant (ver docs/BITACORA.md
// continuacion 10). Confirmado sin VS Code: se descargo el $metadata
// completo de los web services OData v4 legacy (`/ODataV4/$metadata`,
// alcanzable con las mismas credenciales de servicio) y se encontro
// "DSNNo_Comprobante_Fiscal" ahi -- la codificacion de nombres OData de BC
// convierte "-"/" " en "_" y elimina "." (calibrado contra un campo
// conocido: "Buy-from Vendor No." -> "Buy_from_Vendor_No"), lo que decodifica
// a "DSNNo. Comprobante Fiscal".
//
// El campo lo agrega la extension "Adsemble Liquid Base" (DYNASOFT SRL,
// app id 865b688c-1073-4e6e-bfb6-27c28e3b8a4e, version 1.0.0.91 — ver
// app.json) via una table extension sobre Purchase Header. AL solo deja
// referenciar campos de extensiones declaradas como dependencia — sin esa
// dependencia en app.json, el compilador reporta el mismo AL0132 aunque el
// nombre este bien escrito, que es lo que paso en el primer intento con
// esta correccion de nombre.
//
// Uso, sobre una factura ya creada por bc-export-invoice (por su id/systemId):
//   PATCH .../purchaseInvoiceFiscals({systemId})  { "fiscalDocumentNo": "E310000000001" }
page 58004 "Adsm Purch Inv Fiscal API"
{
    PageType = API;
    APIPublisher = 'adsemble';
    APIGroup = 'vendorPortal';
    APIVersion = 'v1.0';
    EntityName = 'purchaseInvoiceFiscal';
    EntitySetName = 'purchaseInvoiceFiscals';
    SourceTable = "Purchase Header";
    SourceTableView = where("Document Type" = const(Invoice));
    DelayedInsert = true;
    ODataKeyFields = SystemId;
    InsertAllowed = false;
    ModifyAllowed = true;
    DeleteAllowed = false;

    layout
    {
        area(content)
        {
            repeater(General)
            {
                field(id; Rec.SystemId) { Caption = 'Id'; Editable = false; }
                field(number; Rec."No.") { Caption = 'Number'; Editable = false; }
                field(fiscalDocumentNo; Rec."DSNNo. Comprobante Fiscal") { Caption = 'Fiscal Document No.'; }
            }
        }
    }
}
