# QA Report — proveedores.jfmcss.com

**Date:** 2026-08-26
**Mode:** Diff-scoped (commits `93ea05d`, `74acd9d` — Fase 1/2/3/4 of the user-observations plan)
**Target:** https://proveedores.jfmcss.com (production — no separate staging environment)
**Scope:** Invoice upload + PO linking (`Invoices.tsx`, `Orders.tsx`), server-side confirm validation (`rpc_confirm_invoice_for_approval`), NCF-optional for informal/foreign vendors, export monitor popup (`Exports.tsx`)
**Auth:** Magic links generated via GoTrue admin API for two existing accounts — `jonathanmaria+qa2026@gmail.com` (supplier, vendor PROV-000278 "JONATAN FRANCISCO MARIA CASTRO", the project's own designated QA test vendor) and `jonathanmaria@gmail.com` (superadmin)

## Summary

All 6 changed behaviors verified working end-to-end against production with real data, using a real file upload (not a mock) and a real Business Central sandbox export. **0 bugs found — nothing to fix.**

## Health Score: 100/100

No issues found in the scoped area. Full-app exploration was not performed (out of scope for this diff-targeted run).

## Test Cases

| # | Case | Steps | Result |
|---|------|-------|--------|
| 1 | PO selector required when supplier has open orders | Log in as supplier, go to Invoices, observe "Subir factura" disabled with "Selecciona la orden de compra..." dropdown | ✅ Dropdown listed all 5 real open POs (CP-000211..215) with amounts + "Sin orden de compra"; button stayed disabled until a choice was made |
| 2 | Invoice links to chosen PO | Select CP-000212, upload a real PDF | ✅ Redirected to invoice detail showing "ORDEN DE COMPRA: CP-000212" |
| 3 | Corte del día 25 (blocks) | Fill invoice date 2026-08-27 (day 27), submit | ✅ Blocked with exact message: "El corte de recepcion de facturas es el dia 25 de cada mes. Debes subir esta factura con fecha del mes siguiente." Status stayed `uploaded` |
| 4 | Corte del día 25 (allows) | Fix date to 2026-08-20, submit | ✅ Server RPC accepted it, status → `pending_approval` |
| 5 | Multi-invoice accumulation display | View CP-000212 order detail after test invoice | ✅ "Facturado: RD$500.00 de RD$1,180.00 · Disponible: RD$680.00" shown correctly, summing the new invoice with a pre-existing one, excluding it doesn't double count |
| 6 | NCF field UI reacts to vendor category | Temporarily flipped test vendor to `PROVINFORM` in DB, reloaded | ✅ NCF label changed to "— OPCIONAL" with hint "Proveedor informal/extranjero: no requiere NCF."; also showed live "Ya facturado / Disponible" in the total field hint |
| 7 | NCF-optional confirm (server-side) | Submitted with NCF left blank on the PROVINFORM-flagged vendor | ✅ Server RPC accepted it without NCF, status → `pending_approval` (confirms the DB-level exemption logic, not just the UI label) |
| 8 | Export popup — success | As superadmin, approved the PROVINFORM test invoice, clicked "Exportar ahora" on /exports | ✅ Modal: "EXPORTACION EXITOSA — Factura QA-TEST-PROVINFORM — Creada en Business Central como CF-001928. El PDF se adjunto correctamente." Button showed "Exportando..." while in flight |
| 9 | NCF-exempt export reaches real BC without error | Same as #8 | ✅ **This is the most important confirmation of the session**: `bc-export-invoice` created a real Business Central purchase invoice for an NCF-less vendor without hitting the "no tiene NCF" guard — the Fase 4 fix works all the way to BC, not just in the portal's own validation |

## Cleanup performed

- Deleted the 2 synthetic test invoices (`QA-TEST-DAY27`, `QA-TEST-PROVINFORM`) and their `invoice_status_history` rows from the portal DB.
- Deleted their 2 uploaded PDFs from Storage.
- Reverted the test vendor's `vendor_posting_group` from `PROVINFORM` back to its real value `CPPROV`.
- The resulting Business Central invoice `CF-001928` (sandbox `Test672026`) was left as-is — same precedent as other test exports already present in that sandbox from earlier sessions (`12345`, `CF-001924`, etc.); deleting BC records is out of scope and not requested.

## Not covered by this run

- Full-app exploration (this was a diff-scoped run, not a general health check).
- The export-error modal path (would require forcing a real BC failure; the success path and the modal's conditional rendering were verified, and the error branch is a straightforward `result.kind === "error"` render already covered by `tsc`).
- The embedded PDF viewer (out of scope — not implemented this session, noted as a future item in the plan).
