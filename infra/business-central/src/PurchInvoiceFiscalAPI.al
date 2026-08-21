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
// Nombre del campo tomado del caption visible en BC ("No. Comprobante
// Fiscal", ubicado por Jonatan con Ctrl+Alt+F1 sobre el campo real en una
// factura de compra). Si el nombre interno AL no coincide exactamente con
// el caption, la publicacion (F5) va a fallar con un error de compilacion
// mostrando el nombre correcto — en ese caso, avisar para corregir.
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
                field(fiscalDocumentNo; Rec."No. Comprobante Fiscal") { Caption = 'Fiscal Document No.'; }
            }
        }
    }
}
