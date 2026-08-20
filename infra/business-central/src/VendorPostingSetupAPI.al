// Expone los grupos de contabilizacion del proveedor (Gen. Bus. Posting
// Group, Vendor Posting Group) — campos obligatorios en BC antes de poder
// crear ordenes de compra o facturas contra un vendor, pero que la API
// estandar de vendors NO expone (confirmado 2026-08-20 al intentar crear
// una orden de prueba: "Gen. Bus. Posting Group must have a value").
//
// Solo lectura/escritura de estos dos campos puntuales — no es un editor
// general del vendor (InsertAllowed/DeleteAllowed = false, y el resto de
// los campos del vendor quedan fuera de este page a proposito).
//
// Uso: leer los valores de un vendor real ya configurado para saber que
// codigo usar, y aplicarlo a un vendor nuevo via PATCH:
//   GET   .../vendorPostingSetups?$filter=number eq 'PROV-000001'
//   PATCH .../vendorPostingSetups({systemId})  { "genBusPostingGroup": "..." }
page 58003 "Adsm Vendor Posting Setup API"
{
    PageType = API;
    APIPublisher = 'adsemble';
    APIGroup = 'vendorPortal';
    APIVersion = 'v1.0';
    EntityName = 'vendorPostingSetup';
    EntitySetName = 'vendorPostingSetups';
    SourceTable = Vendor;
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
                field(genBusPostingGroup; Rec."Gen. Bus. Posting Group") { Caption = 'Gen. Bus. Posting Group'; }
                field(vendorPostingGroup; Rec."Vendor Posting Group") { Caption = 'Vendor Posting Group'; }
            }
        }
    }
}
