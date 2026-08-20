// Expone los movimientos de cuentas por pagar (Vendor Ledger Entries) via
// API REST. Bloqueante confirmado para "Consulta de pagos y estado de
// cuenta" (compromiso enviado a Adsemble) — sin esto, /payments en el
// portal solo puede mostrar el estado de pago manual que ya existe
// (docs/BITACORA.md, 2026-08-20), nunca los pagos/saldo reales de BC.
//
// Solo lectura — el portal nunca escribe pagos en BC, solo los consulta.
//
// URL una vez publicado:
//   {BC_BASE_URL}/api/adsemble/vendorPortal/v1.0/companies({id})/vendorLedgerEntries
page 58002 "Adsm Vendor Ledger Entr. API"
{
    PageType = API;
    APIPublisher = 'adsemble';
    APIGroup = 'vendorPortal';
    APIVersion = 'v1.0';
    EntityName = 'vendorLedgerEntry';
    EntitySetName = 'vendorLedgerEntries';
    SourceTable = "Vendor Ledger Entry";
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
                field(entryNo; Rec."Entry No.") { Caption = 'Entry No.'; }
                field(vendorNo; Rec."Vendor No.") { Caption = 'Vendor No.'; }
                field(documentType; Rec."Document Type") { Caption = 'Document Type'; }
                field(documentNo; Rec."Document No.") { Caption = 'Document No.'; }
                field(externalDocumentNo; Rec."External Document No.") { Caption = 'External Document No.'; }
                field(description; Rec.Description) { Caption = 'Description'; }
                field(postingDate; Rec."Posting Date") { Caption = 'Posting Date'; }
                field(dueDate; Rec."Due Date") { Caption = 'Due Date'; }
                field(amount; Rec.Amount) { Caption = 'Amount'; }
                field(remainingAmount; Rec."Remaining Amount") { Caption = 'Remaining Amount'; }
                field(open; Rec.Open) { Caption = 'Open'; }
                field(closedByEntryNo; Rec."Closed by Entry No.") { Caption = 'Closed by Entry No.'; }
                field(closedAtDate; Rec."Closed at Date") { Caption = 'Closed at Date'; }
                field(currencyCode; Rec."Currency Code") { Caption = 'Currency Code'; }
            }
        }
    }
}
