# Implementation Plan

Stack: Next.js + TypeScript + Prisma/PostgreSQL + Auth.js + Zod + React Hook Form + TanStack Table + BullMQ/Redis + Docker Compose. See `VENDOR_PORTAL_ARCHITECTURE.md` for the layering and `BUSINESS_CENTRAL_INTEGRATION.md` for the BC client design.

Order of work: **Phase 0 → Phase 1 (parity foundation) → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 (expansion beyond parity)**.

## Known production bugs to fix (carried into the relevant phase below)

| # | Bug (from `extraido/02-rutas-y-modulos.md`) | Fixed in |
|---|---|---|
| 1 | Dashboard "Usuarios gestionados" KPI (2420) doesn't match actual `/users` count | Phase 6 |
| 2 | Audit message "Factura vinculada a la orden ." — missing PO number in template | Phase 3 |
| 3 | Vendors page — 4th stat card has no title | Phase 6 |
| 4 | Invoice detail — NCF (`invoice_tax_number`) extracted equal to invoice number (wrong) | Phase 3 / OCR (Phase 7) |
| 5 | Invoice detail — "Order lines: NO DATA" (PO lines never synced) | Phase 2 |
| 6 | Approvals — empty-state text overflows right edge | Phase 3 |
| 7 | Companies page — shows raw BC GUID as "Código" instead of a readable code | Phase 6 |
| 8 | Missing Spanish accents across the entire UI | Phase 1 (i18n text pass, reuse corrected `textos-es.json`) |

## Phase 0 — Discovery (before any BC-facing code)

- Confirm actual BC API surface for this tenant: call `$metadata`, enumerate available entities (see `BUSINESS_CENTRAL_INTEGRATION.md` §4).
- Recover/inspect the existing n8n scenarios (Flow 1: BC→Supabase sync, Flow 3: invoice export) if accessible, to learn the exact endpoints already proven to work for vendors/POs/invoices in Adsemble's BC environment.
- Confirm Entra ID app registration scopes match what's needed (`API.ReadWrite.All` or the narrower BC-specific scope already granted).
- Output: fill in the "confirmed" column of the entity table in `BUSINESS_CENTRAL_INTEGRATION.md` §4 before writing Phase 2 sync code.

## Phase 1 — Foundation & parity base

- Repo scaffold: Next.js App Router + TypeScript, Tailwind + shadcn/ui, Docker Compose (`app`, `postgres`, `redis`), `.env.example`.
- Prisma schema per `DATABASE_SCHEMA.md` §1 (Company, Vendor, User, VendorUserMapping) + migrations + seed data (`DYNASOFT S R L` / `PROV-000273` per brief §53, plus legacy-shaped fixtures from `extraido/01-esquema-tablas.md`).
- Auth.js: email+password, session, password reset, account lockout after N failed attempts, Entra ID provider wired but optional (toggle via env), MFA hook point.
- Role model: `VENDOR`, `VENDOR_ADMIN`, `FINANCE`, `ADMIN` active (`BUYER` modeled but unused until Phase 7). Legacy `admin`/`approver`/`supplier` seed data mapped per `DATABASE_SCHEMA.md` §9.
- **Vendor isolation enforcement layer** (repository helpers that scope every query by the session's allowed `vendorId`s) — this is the first thing to build and the first thing to test (see Testing below).
- `BusinessCentralClient` skeleton (token handling, retries, logging) + `MockBusinessCentralProvider`/`MicrosoftBusinessCentralProvider` interface split.
- Vendor sync (`VendorService` + `BusinessCentralSyncService`), scheduled every 6h + manual trigger, idempotent on `bcVendorId`.
- Base layout/navigation (Dashboard, Purchase Orders, Invoices, Payments, Account Statement, Documents, Messages, Notifications, Company Profile, Support) — empty/placeholder content where later phases fill it in.
- Corrected Spanish copy pass reusing `extraido/textos-es.json` (bug #8) plus `textos-en.json` for the English locale.
- Audit log wired to all auth events (`USER_LOGIN`, lockouts) from day one.

**Acceptance:** a seeded vendor user logs in, sees only its own vendor's profile (synced from Mock or real BC), and cannot reach another vendor's data by manipulating IDs (covered by tests, not just UI hiding).

## Phase 2 — Purchase Orders

- Resolve Phase 0 findings: implement `PurchaseOrderProvider`/`ReceiptProvider` against whatever was confirmed (standard, custom API, or still-mocked pending client access).
- `PurchaseOrder`/`PurchaseOrderLine` sync, 5-minute interval, idempotent on `bcId`.
- **Fix bug #5**: ensure PO lines actually populate (`quantity`, `quantityReceived`, `quantityInvoiced`) — this was the single biggest gap in the legacy system.
- `/purchase-orders` list (search/filter by number, date, status, currency, amount range; TanStack Table with pagination/sorting/export).
- `/purchase-orders/[id]` detail: header + lines + outstanding-quantity derivation + status badges (human-readable, not internal codes — brief §41).
- Receipts sync + display within PO detail.
- PO confirmation flow (`PoConfirmation`): Confirm / Request Change, storing user/IP/timestamp; change requests create an internal request, never a direct BC write (brief §8).

## Phase 3 — Invoices

- `/invoices` list + `/invoices/new` (PO-first selection → line selection → form) + `/invoices/[id]`.
- Validation service: PO exists & belongs to vendor & is open, amount/currency/tax coherence, quantity-to-invoice ≤ available, **duplicate guard on `(vendorId, supplierInvoiceNumber)`**.
- File upload (PDF/JPG/PNG) via `StorageProvider`, size/MIME validated server-side.
- `InvoiceFiscalProfile` fields (RNC/NCF/e-NCF/ITBIS) as an extensible per-country block, not core-hardcoded.
- Status workflow `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED/REJECTED → SENT_TO_BC → POSTED`, backed by `InvoiceStatusHistory`.
- **Fix bug #2**: audit/message templates always interpolate the PO number.
- **Fix bug #6**: empty-state component fixed at the design-system level (shared component, not per-page).
- Approval actions for `FINANCE` role (approve/reject with reason), visible rejection reason to the vendor.
- BC export on approval per `BUSINESS_CENTRAL_INTEGRATION.md` §7, with retry UI for `syncError` cases.
- **Note on bug #4 (NCF)**: this portal's Phase 3 always lets the vendor enter/correct NCF manually; the *automatic extraction* fix belongs to OCR (Phase 7) — until then there is no auto-extraction to be wrong, only manual entry, which structurally avoids the legacy bug.

## Phase 4 — Payments

- `Payment` / `VendorLedgerEntry` sync (15-minute interval; resolves Phase 0 findings same as Phase 2).
- `/payments` list with search by invoice/PO/payment number/date.
- `/account-statement`: opening balance, invoices, credit notes, payments, running balance; date-range filter; PDF/Excel export.

## Phase 5 — Documents

- `DocumentType` catalog (seeded: Tax Certificate, Commercial Registration, Bank Certification, Insurance, Contract, NDA, Compliance, Other).
- `/documents`: upload, review status (`PENDING_REVIEW/APPROVED/REJECTED/EXPIRED`), approver comments.
- Expiration alerts at 30/15/7/1 days, surfaced on dashboard and via notifications.

## Phase 6 — Administration

- `/admin` dashboard (vendors, open POs, pending/rejected invoices, payments this month, documents expiring, BC sync errors) — **fix bug #1** by computing the "managed users" KPI from an actual query instead of a stale/wrong count.
- `/admin/vendors` — activate/disable portal access, invite user, force sync, view sync errors. **Fix bug #7**: display `vendorNumber`/a human code, never the raw BC GUID.
- `/admin/users` — create/invite/disable/reset/assign role/associate vendor; enforce a `VENDOR`/`VENDOR_ADMIN` user must have ≥1 `VendorUserMapping` row.
- `/admin/invoices`, `/admin/documents` management views.
- `/admin/integrations/business-central` — connection status, last sync per entity, failed records, Test Connection / Sync Now / Retry Failed.
- `/admin/audit` — full `AuditLog` browser.
- `/admin/settings` — company branding, currency/timezone defaults, invoice tolerances, document-expiration windows, BC sync intervals, feature flags.
- **Fix bug #3**: vendors stat-card component always renders a title (design-system-level fix, same pattern as bug #6).
- Vendor Admin capabilities (manage/invite/disable users of own vendor company, view org activity) activated here since it depends on the admin/user-management plumbing built in this phase.

## Phase 7 — Expansion beyond parity

- `BUYER` role activated: vendor/PO read access, vendor communication, observations.
- Separate `FINANCE` responsibilities fully from `BUYER` where the legacy system conflated "approver" with both.
- Three-way matching (PO vs Receipt vs Invoice) with configurable price/amount tolerances, discrepancy surfacing (`Quantity/Price/Tax Variance`, `Receipt Missing`, `Duplicate Invoice`).
- OCR service (`OcrProvider` interface, Azure Document Intelligence first implementation) for invoice field pre-fill, always vendor-correctable, never sole source of truth — this is also where bug #4's root cause (bad automatic NCF extraction) gets a real fix via a proper OCR + validation pass instead of the legacy naive extraction.
- Messaging (`MessageThread`/`Message`) contextualized to PO/Invoice.
- Notification center expansion: Teams/WhatsApp/SMS/webhook adapters (in-app + email already live since Phase 1/3).
- `/support` ticketing.
- Global search across PO/Invoice/Payment/Document numbers.
- Multi-company UI surfacing (`Company` switcher) if/when a second BC company is onboarded.

## Testing (cross-cutting, built alongside each phase, not deferred)

- Vendor isolation: automated tests proving a `VENDOR` session for Vendor A cannot read/write Vendor B's PO/Invoice/Payment/Document records even with a manipulated ID (Phase 1, gating criterion before Phase 2 starts).
- Invoice duplicate detection & validation rules (Phase 3).
- PO ownership checks (Phase 2/3).
- Three-way matching calculations (Phase 7).
- Permission matrix per role (Phase 1 baseline, extended each phase a new role gains capability).
- BC DTO mapping correctness (Phase 0/2/3/4, one test per entity mapper).
- Sync idempotency (Phase 1 vendor sync as the template test, replicated per entity).

## MVP definition of done

The end-to-end flow in brief §58 (admin syncs vendors → vendor logs in → syncs its POs → creates and submits an invoice against a PO → Finance approves → invoice exports to BC → BC posts payment → payment syncs back → vendor sees it paid) is complete at the end of **Phase 4**. Phases 5–7 are enterprise-hardening and scope expansion on top of a working MVP, not prerequisites to it.
