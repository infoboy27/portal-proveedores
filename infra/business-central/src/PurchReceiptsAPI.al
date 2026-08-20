// Expone las recepciones de compra publicadas (Posted Purchase Receipts) via
// API REST. La API v2.0 estandar de BC no las expone de forma consultable
// para este tenant (ver docs/BUSINESS_CENTRAL_INTEGRATION.md §4) — el portal
// las necesita para mostrar "recepciones" en el detalle de una orden de
// compra (informe de Adsemble, seccion "Ordenes de Compra").
//
// Solo lectura (Editable = false, sin acciones de escritura) — el portal
// nunca debe crear/modificar recepciones, solo consultarlas.
//
// URL una vez publicado:
//   {BC_BASE_URL}/api/adsemble/vendorPortal/v1.0/companies({id})/purchaseReceipts
// (distinto del prefijo /api/v2.0 que usa el resto de la integracion —
// _shared/bc-client.ts necesita un baseUrl alternativo para esto, ver
// infra/business-central/README.md).
page 50100 "Adsm Purch Receipts API"
{
    PageType = API;
    APIPublisher = 'adsemble';
    APIGroup = 'vendorPortal';
    APIVersion = 'v1.0';
    EntityName = 'purchaseReceipt';
    EntitySetName = 'purchaseReceipts';
    SourceTable = "Purch. Rcpt. Header";
    DelayedInsert = true;
    ODataKeyFields = SystemId;
    Editable = false;

    layout
    {
        area(content)
        {
            repeater(General)
            {
                field(id; Rec.SystemId) { Caption = 'Id'; }
                field(number; Rec."No.") { Caption = 'Number'; }
                field(orderNo; Rec."Order No.") { Caption = 'Order No.'; }
                field(vendorNo; Rec."Buy-from Vendor No.") { Caption = 'Vendor No.'; }
                field(postingDate; Rec."Posting Date") { Caption = 'Posting Date'; }
                field(vendorShipmentNo; Rec."Vendor Shipment No.") { Caption = 'Vendor Shipment No.'; }

                part(purchaseReceiptLines; "Adsm Purch Receipt Lines API")
                {
                    Caption = 'Purchase Receipt Lines';
                    EntityName = 'purchaseReceiptLine';
                    EntitySetName = 'purchaseReceiptLines';
                    SubPageLink = "Document No." = field("No.");
                }
            }
        }
    }
}

page 50101 "Adsm Purch Receipt Lines API"
{
    PageType = API;
    APIPublisher = 'adsemble';
    APIGroup = 'vendorPortal';
    APIVersion = 'v1.0';
    EntityName = 'purchaseReceiptLine';
    EntitySetName = 'purchaseReceiptLines';
    SourceTable = "Purch. Rcpt. Line";
    DelayedInsert = true;
    ODataKeyFields = SystemId;
    Editable = false;

    layout
    {
        area(content)
        {
            repeater(General)
            {
                field(id; Rec.SystemId) { Caption = 'Id'; }
                field(documentNo; Rec."Document No.") { Caption = 'Document No.'; }
                field(lineNo; Rec."Line No.") { Caption = 'Line No.'; }
                field(orderNo; Rec."Order No.") { Caption = 'Order No.'; }
                field(orderLineNo; Rec."Order Line No.") { Caption = 'Order Line No.'; }
                field(itemNo; Rec."No.") { Caption = 'No.'; }
                field(description; Rec.Description) { Caption = 'Description'; }
                field(quantity; Rec.Quantity) { Caption = 'Quantity'; }
            }
        }
    }
}
