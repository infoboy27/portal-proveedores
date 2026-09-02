// Vincula cada linea de una factura de compra sin publicar (Purchase Line,
// Document Type = Invoice) con la orden de compra de la que viene, para que
// Business Central la trate como una factura "sacada de la orden" de verdad
// -- no solo con datos parecidos.
//
// Encontrado en /qa 2026-08-29/30: bc-export-invoice crea la factura via la
// API estandar (purchaseInvoices + purchaseInvoiceLines) copiando a mano
// cantidad/costo/item de cada linea de la orden ya sincronizada. Eso deja la
// factura con los MISMOS numeros que la orden, pero sin ningun vinculo real
// -- confirmado contra el sandbox: la factura creada (CF-001931) tenia
// "orderId" y "orderNumber" vacios. Por eso la seccion "Detalles Factura" de
// la orden de compra en BC queda sin poblar: esa seccion depende de que las
// lineas de la factura tengan "Order No." + "Order Line No." apuntando a la
// orden, campos que la funcion nativa "Obtener lineas de pedido" (Get Order
// Lines / codeunit "Purch.-Get Order") completa automaticamente cuando se
// arma la factura DESDE la orden en la interfaz de BC -- y que la API v2.0
// no expone (confirmado: "orderId" es de solo lectura en la creacion de
// purchaseInvoices, y purchaseInvoiceLines no trae esos campos en absoluto).
//
// Con este vinculo puesto ANTES de postear, la rutina de posteo estandar de
// BC (codeunit 90 "Purch.-Post") es la que en el momento de postear
// actualiza "Quantity Invoiced" en la orden y la deja disponible en
// "Detalles Factura" / "Related Information" -- no hace falta reimplementar
// esa logica, solo darle los dos campos que necesita.
//
// Uso, para cada linea ya creada por bc-export-invoice (por su id/systemId,
// el mismo que devuelve purchaseInvoiceLines al crearla):
//   PATCH .../purchaseInvoiceOrderLinks({systemId})
//     { "orderNo": "CP-000212", "orderLineNo": 10000 }
//
// "orderNo" = purchase_orders.order_number (el "No." real de la orden en
// BC). "orderLineNo" = purchase_orders_lines.sequence de la linea
// correspondiente (el campo "sequence" de la API estandar de
// purchaseOrderLines ES el "Line No." interno de BC -- confirmado por el
// mismo valor que bc-sync-orders ya guarda).
//
// ANTES de publicar: confirmar "Order No." / "Order Line No." contra el
// Object Explorer del sandbox (AL: Download Symbols -> tabla "Purchase
// Line") igual que se hizo con los demas archivos de esta extension -- son
// campos estandar de la app base de Microsoft (no de un ISV de
// cumplimiento fiscal como los de PurchInvoiceFiscalAPI.al), pero no se
// verificaron todavia contra este tenant especifico.
page 58005 "Adsm Purch Inv Order Link API"
{
    PageType = API;
    APIPublisher = 'adsemble';
    APIGroup = 'vendorPortal';
    APIVersion = 'v1.0';
    EntityName = 'purchaseInvoiceOrderLink';
    EntitySetName = 'purchaseInvoiceOrderLinks';
    SourceTable = "Purchase Line";
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
                field(documentNo; Rec."Document No.") { Caption = 'Document No.'; Editable = false; }
                field(lineNo; Rec."Line No.") { Caption = 'Line No.'; Editable = false; }
                field(orderNo; Rec."Order No.") { Caption = 'Order No.'; }
                field(orderLineNo; Rec."Order Line No.") { Caption = 'Order Line No.'; }
            }
        }
    }
}
