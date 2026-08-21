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
// El campo NO lo agrega "Adsemble Liquid Base" sino "DSLocalization"
// (DYNASOFT SRL, app id dc9f2114-cdfc-4bde-8c06-ac259a176816, v1.1.2.64 —
// ver app.json), una dependencia transitiva de "Adsemble Liquid Base" que
// aparecio en el log de "AL: Download Symbols". AL no propaga visibilidad
// de dependencias transitivas — depender de A no da acceso a los objetos
// de lo que A depende, hay que declarar la dependencia directa. Con solo
// "Adsemble Liquid Base" declarada, el compilador seguia reportando
// AL0132 aunque el nombre del campo ya estuviera bien escrito.
//
// Segundo campo obligatorio encontrado al intentar postear ya con el NCF
// puesto: "Specify Expense Class. Code for Document Type Invoice" — la
// clasificacion de gasto que la DGII pide en los reportes 606/607/608
// (codigos de 2 digitos: "01", "02", "04", ... — confirmado con datos
// reales de ordenes de compra existentes via Pedido_compra_Excel). Mismo
// origen (DSLocalization) y mismo metodo de decodificacion: se encontro
// "DSNCod_Clasificacion_Gasto" en el metadata OData v4, que decodifica a
// "DSNCod. Clasificacion Gasto".
//
// Uso, sobre una factura ya creada por bc-export-invoice (por su id/systemId):
//   PATCH .../purchaseInvoiceFiscals({systemId})
//     { "fiscalDocumentNo": "E310000000001", "expenseClassCode": "04" }
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
                field(expenseClassCode; Rec."DSNCod. Clasificacion Gasto") { Caption = 'Expense Class Code'; }
            }
        }
    }
}
