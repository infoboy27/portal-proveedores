// Expone campos fiscales sobre ordenes de compra (Purchase Header, Document
// Type = Order). Arranco de solo LECTURA (expenseClassCode, ver historia
// abajo); pedido de Key Players (2026-09-01, items 3 y 5) agrego 2 campos
// mas y ESCRITURA -- ver seccion "2026-09-01" mas abajo.
//
// === Historia original (expenseClassCode, solo lectura) ===
// "Expense Class Code" (Rec."DSNCod. Clasificacion Gasto") -- no es una
// escritura del portal -- es al reves: quien arma la orden en BC (equipo de
// Adsemble, a mano) ya elige este codigo de 2 digitos al crearla, como
// parte de la clasificacion de gasto que la DGII exige en los reportes
// 606/607/608. Confirmado en vivo (2026-08-31) consultando el web service
// legacy OData v4 "Pedido_compra_Excel" (mismo tenant, mismas credenciales
// de servicio): de 15 ordenes reales de ADSEMBLE, 12 ya tenian el campo
// poblado ("01", "02", "04"...), solo 3 en blanco (ordenes de prueba/legacy
// de continuaciones anteriores). Es decir, la "decision de negocio" que
// bc-export-invoice/index.ts documentaba como pendiente YA SE TOMA hoy, en
// BC, al armar la orden -- el portal solo tenia que ir a buscarla ahi y
// copiarla a la factura, no inventar una regla nueva.
//
// bc-sync-orders la lee UNA vez por orden (GET) y la guarda en
// purchase_orders.bc_expense_class_code. bc-export-invoice la copia a la
// factura junto con el NCF, vía PurchInvoiceFiscalAPI.al (page 58004), que
// sigue siendo el unico lugar que escribe sobre la FACTURA.
//
// === 2026-09-01 (Key Players, items 3 y 5) — 2 campos nuevos + escritura ===
// El pedido quiere que el portal, ADEMAS de crear la Factura de Compra
// separada (bc-export-invoice, sin tocar -- es lo unico que postea y
// alimenta 606/607/608), tambien deje visibles en la ORDEN de compra misma
// los mismos 3 datos (asi los ve el equipo de Adsemble sin abrir la
// factura, que es como Jonatan mostro que trabajan hoy con capturas reales
// de BC: ordendecompra1.png). Los 3 campos de esa captura:
//   - "Fecha emision documento" -> YA es el campo estandar `orderDate` de
//     la API v2.0 de purchaseOrders (confirmado en vivo: orderDate de
//     CP-000221 = 2026-09-01 = "1/9/2026" de la captura) -- NO necesita
//     nada en esta extension, se patchea directo contra /purchaseOrders.
//   - "Nº factura proveedor" -> campo estandar de BC "Vendor Invoice No."
//     (confirmado en el $metadata legacy: "Vendor_Invoice_No"), pero NO
//     esta en la API v2.0 estandar de purchaseOrders (confirmado: 46 campos,
//     ninguno es esto) -- se agrega aca.
//   - NCF -> mismo campo que ya usa PurchInvoiceFiscalAPI.al para
//     facturas (Rec."DSNNo. Comprobante Fiscal"), confirmado que tambien
//     existe sobre Document Type = Order (misma tabla Purchase Header).
//
// ModifyAllowed pasa a true -- bc-export-invoice necesita PATCHear estos 2
// campos nuevos (expenseClassCode se sigue sin tocar desde el portal, solo
// se lee).
//
// Uso, por el SystemId de la orden ya sincronizada (purchase_orders.bc_id):
//   GET .../purchaseOrderFiscals({systemId})
//     -> { "expenseClassCode": "02", "vendorInvoiceNumber": "...", "fiscalDocumentNo": "..." }
//   PATCH .../purchaseOrderFiscals({systemId})
//     { "vendorInvoiceNumber": "F-00123", "fiscalDocumentNo": "E310000000336" }
page 58006 "Adsm Purch Order Fiscal API"
{
    PageType = API;
    APIPublisher = 'adsemble';
    APIGroup = 'vendorPortal';
    APIVersion = 'v1.0';
    EntityName = 'purchaseOrderFiscal';
    EntitySetName = 'purchaseOrderFiscals';
    SourceTable = "Purchase Header";
    SourceTableView = where("Document Type" = const(Order));
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
                field(expenseClassCode; Rec."DSNCod. Clasificacion Gasto") { Caption = 'Expense Class Code'; Editable = false; }
                field(vendorInvoiceNumber; Rec."Vendor Invoice No.") { Caption = 'Vendor Invoice No.'; }
                field(fiscalDocumentNo; Rec."DSNNo. Comprobante Fiscal") { Caption = 'Fiscal Document No.'; }
            }
        }
    }
}
