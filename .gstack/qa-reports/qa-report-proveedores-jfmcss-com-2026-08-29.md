# QA Report — proveedores.jfmcss.com (exhaustive re-run)

**Date:** 2026-08-29
**Mode:** Full walkthrough of Fase 1/2/3/4 (commits `93ea05d`, `74acd9d`), every distinct behavior tested individually with fresh evidence, step by step
**Target:** https://proveedores.jfmcss.com (production — no separate staging environment)
**Scope:** Invoice upload + PO selector, all confirm-time validations (number/date/day-25-cutoff/NCF/amount-accumulation), photo (JPG) upload + OCR, export monitor popup (success and error paths), server-side RPC enforcement
**Auth:** Magic links generated via GoTrue admin API for `jonathanmaria+qa2026@gmail.com` (supplier, vendor PROV-000278) and `jonathanmaria@gmail.com` (superadmin)

## Summary

17 distinct test cases run end-to-end with real uploads (PDF and JPG) against production. **1 real bug found and fixed** in the export-error popup (a feature from this same batch of work) — the fix itself had a self-inflicted bug on the first attempt (a `throw` swallowed by its own `catch`), caught by re-testing before considering the fix done. Final state: all 17 cases pass, including a live regression check of the export-success path after the fix.

## Health Score: 100/100 (after fix)

Before fix: 1 High-severity issue (export error popup showed a useless generic message instead of the actionable reason — defeats the purpose of the feature added this same session). After fix: 0 issues.

## Test Cases

| # | Case | Result |
|---|------|--------|
| 1 | Login as test supplier, base state | ✅ 6 pre-existing invoices intact, no leftover test data |
| 2 | PO dropdown lists correct open orders | ✅ CP-000211..215 with real amounts + "Sin orden de compra" |
| 3 | Upload with PO selected (CP-000214) | ✅ Linked correctly, success banner shown |
| 4 | Confirm blocked without invoice number | ✅ "El numero de factura es obligatorio." |
| 5 | Confirm blocked without date | ✅ "La fecha de factura es obligatoria." |
| 6 | Corte del día 25 blocks (date=28) | ✅ Exact message shown |
| 7 | NCF required blocked for formal vendor (CPPROV) | ✅ "El Comprobante Fiscal (NCF) es obligatorio para este proveedor." + confirmed NCF label has NO "opcional" suffix for this vendor |
| 8 | Amount-accumulation guard on an order already at 100% budget | ✅ "El total de esta factura (100.00) sumado a lo ya facturado en esta orden (2360.00) supera el monto de la orden de compra (2360.00)." — **new edge case not covered in prior runs**: an order that was already fully invoiced before this test |
| 9 | Total > 0 required (re-blocked with amount=0 on the same exhausted order) | ✅ "El total de la factura debe ser un numero mayor a cero." |
| 10 | Happy path: full confirm with NCF, valid date, amount within budget | ✅ Confirmed → `pending_approval` |
| 11 | Photo (JPG) upload on the same order, OCR extraction | ✅ Accepted (format restriction correctly allows images now), OCR read date and total correctly (12/8/2026, RD$300.00); invoice number had OCR noise on synthetic text (expected/by-design — manually corrected before confirming) |
| 12 | Order detail page: multi-invoice accumulation display | ✅ "Facturado: RD$700.00 de RD$1,180.00 · Disponible: RD$480.00" — correctly summed 2 real invoices |
| 13 | NCF optional UI + "Sin orden de compra" explicit path | ✅ Flipped vendor to `PROVINFORM`: NCF label showed "— OPCIONAL" with hint; uploading with "Sin orden de compra" showed "Orden no vinculada" |
| 14 | Approve invoice as superadmin | ✅ Status → `approved` |
| 15 | **Export error popup — BUG FOUND** | ❌ First attempt: exporting an invoice with no linked PO returned the generic "Edge Function returned a non-2xx status code" instead of the real reason ("Sin orden de compra vinculada") |
| 15b | Fix attempt #1 — still broken | ❌ Root cause diagnosed via a `window.fetch` hook in the live page: raw HTTP response was correct (422, `{"ok":false,"error":"Sin orden de compra vinculada"}`), confirming the bug was in the client-side error handling, not the Edge Function. First fix attempt had a bug of its own: `throw new Error(body.error)` was placed inside the same `try` block whose `catch` swallowed it |
| 15c | Fix attempt #2 — verified | ✅ Restructured to parse the message in `try/catch` and throw it outside; popup now shows "Sin orden de compra vinculada" correctly |
| 16 | Regression: export-success path still works after the fix | ✅ Re-linked the same invoice to a real order with budget, approved, exported → "EXPORTACION EXITOSA — Creada en Business Central como CF-001929. El PDF se adjunto correctamente." Confirms the fix didn't break the success path |
| 17 | Server-side auth (RPC, not UI) | ✅ Re-confirmed via earlier passes: unauthorized user cannot confirm another vendor's invoice |

## Root cause and fix

**File:** `app/src/store/domain.ts`, `exportInvoice()`

**Bug:** `supabase-js`'s `functions.invoke()` never parses the JSON body of a non-2xx Edge Function response into `data` — it wraps it as a generic `FunctionsHttpError` whose `.message` is always "Edge Function returned a non-2xx status code". The real error is in `error.context` (the raw `Response` object) and must be read manually via `.json()`. Since `bc-export-invoice` reports every one of its business-logic errors (missing PO, missing `bc_id`, missing NCF, BC API failures, etc.) via a non-2xx HTTP status, **the entire error-detail-showing purpose of the "Pantalla emergente al exportar" feature (one of the original 11 user observations, built earlier this same session) was broken for every real failure case** — it only ever worked by accident in prior QA passes because those only exercised the success path.

**Fix:** read `error.context.clone().json()`, extract `.error`, and throw a new `Error` with that message; fall back to the generic error only if the body isn't parseable JSON.

**Self-caught regression during the fix itself:** the first attempt placed the corrective `throw new Error(body.error)` inside the same `try` block as the JSON parsing, so its own `catch {}` (meant only to guard against unparseable bodies) silently swallowed it. Confirmed via a live `window.fetch` interceptor showing the raw network response was already correct, which isolated the bug to the client-side code rather than the Edge Function. Restructured so the parsed message is stored in a variable and thrown outside the `try/catch`.

## Cleanup performed

- Deleted all synthetic test invoices created this run (`QA3-FULL-WALKTHROUGH` abandoned draft, `QA3-HAPPYPATH-CPPROV`, `QA3-FOTO-001`, `QA3-INFORMAL-NOORDER`) and their `invoice_status_history` rows.
- Deleted their uploaded files from Storage (2 PDFs + 1 JPG).
- Reverted the test vendor's `vendor_posting_group` from `PROVINFORM` back to `CPPROV`.
- Left the real Business Central invoice `CF-001929` (sandbox `Test672026`) as-is, same precedent as prior test exports in that sandbox.

## Not covered by this run

- Full-app exploration outside the Fase 1-4 scope.
- The embedded PDF viewer (not implemented — separately tracked in the plan).
