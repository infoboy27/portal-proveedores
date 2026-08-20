# Business Central Integration

## 1. Principle

All BC access goes through the **Business Central REST API** (`api.businesscentral.dynamics.com`), authenticated via OAuth 2.0 client credentials against Microsoft Entra ID. **Never** direct database access. All BC-facing code sits behind a `BusinessCentralClient` + a per-entity provider interface, so the concrete implementation (`MockBusinessCentralProvider` in dev, `MicrosoftBusinessCentralProvider` in prod) can be swapped without touching domain logic.

## 2. Auth

```
AZURE_TENANT_ID=
BC_CLIENT_ID=
BC_CLIENT_SECRET=
BC_ENVIRONMENT=        # e.g. "production" / "sandbox"
BC_COMPANY_ID=         # default company; app must not hardcode this everywhere (multi-company)
BC_BASE_URL=           # https://api.businesscentral.dynamics.com/v2.0/{tenant}/{environment}
```

These variables are read only on the server (jobs / API routes). They must never reach the client bundle.

Token flow: client-credentials grant against `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope `https://api.businesscentral.dynamics.com/.default`. `BusinessCentralClient` caches the token and refreshes ahead of expiry.

## 3. `BusinessCentralClient`

```
class BusinessCentralClient {
  get(path, params)
  post(path, body)
  patch(path, body, etag)
  delete(path, etag)
}
```

Responsibilities: token acquisition/refresh, retries with backoff on 429/5xx, timeouts, correlation-ID header propagation, structured error logging (status, BC error code/message, correlation ID — never the request secret).

## 4. Entity availability — do not assume, verify

The **standard** Business Central API v2.0 package reliably exposes: `companies`, `vendors`, `items`, `customers`, `currencies`, `paymentTerms`, `paymentMethods`, `salesOrders/Invoices`, `purchaseInvoices`, `purchaseCreditMemos`, `generalLedgerEntries`, units of measure.

It does **not**, out of the box, reliably expose: **purchase orders** (header/lines as a queryable+syncable entity the way this portal needs), **posted purchase receipts**, or **vendor ledger entries** (needed for payments/account statement). Availability varies by BC version/environment and by what custom API pages a partner may have already published.

Per rule #61 of the project brief: **do not invent endpoints**. Concretely:

| Domain entity | Status | Action |
|---|---|---|
| Vendors | Standard (`vendors`) | Build directly against standard API |
| Currencies / Payment Terms | Standard | Build directly |
| Purchase Invoices (create + post) | Standard (`purchaseInvoices`, bound `Microsoft.NAV.post` action) | Build directly — this is very likely what the legacy n8n flow already uses (its logged error "Tiempo de espera agotado en Business Central al crear la cabecera" matches a header-creation POST timeout on this entity) |
| Purchase Orders (header/lines, receipts, invoiced qty) | **Unconfirmed** for this tenant | See Phase 0 discovery below — likely needs a **Custom API page** in BC (AL extension) |
| Posted Purchase Receipts | **Unconfirmed** | Same — likely Custom API |
| Vendor Ledger Entries / Payments | **Unconfirmed** | Same — likely Custom API |

Each unconfirmed entity gets an adapter interface (e.g. `PurchaseOrderProvider`) implemented first by `MockPurchaseOrderProvider` (seeded fixtures) so the rest of the app is built against a stable contract; swapping in `MicrosoftPurchaseOrderProvider` once the real endpoint is confirmed is a one-file change.

### Phase 0 discovery task (do this before writing PO/receipt/payment sync code)

1. Call `{BC_BASE_URL}/$metadata` and enumerate entities actually published for this tenant/environment — the answer may differ from the generic table above.
2. The legacy system already syncs 798 purchase orders and ~32,957 vendors and successfully exports some invoices to BC — meaning **some** integration already works today. Get access to (or a description of) the existing n8n scenarios on `automate.smartautomation.cloud` (Flow 1: BC→Supabase sync, Flow 3: invoice export) to learn exactly which BC endpoints/custom API pages Adsemble's BC environment already exposes, instead of re-guessing them.
3. Document the confirmed entity list and any Custom API page names/routes in this file before implementing Phase 2 (Purchase Orders).

## 5. Sync strategy

| Entity | Direction | Default interval | Trigger modes |
|---|---|---|---|
| Vendors | BC → Portal | 6h | scheduled, manual, on-demand |
| Open Purchase Orders | BC → Portal | 5min | scheduled, manual, on-demand, (webhook if BC supports it) |
| Invoices (status/posting confirmation) | BC → Portal | 5min | scheduled, manual |
| Invoices (approved, portal → BC) | Portal → BC | on approval (event-driven) | manual retry on failure |
| Payments / Vendor Ledger Entries | BC → Portal | 15min | scheduled, manual |

All intervals are stored in `SystemSetting`, editable from `/admin/settings`, not hardcoded as constants.

## 6. Idempotency

Every synced entity stores the BC identifier it was created from (`bcId` = BC `SystemId` GUID where available, else natural key like document number) plus `lastSyncedAt`. Sync upserts on that key — never inserts blindly. `SyncLog` records one row per run (`entity`, `direction`, counts, `status`, `correlationId`); `SyncError` records one row per failed record so `/admin/integrations/business-central` can show and retry failures individually.

## 7. Invoice export flow (Portal → BC)

1. Invoice reaches `APPROVED` in the portal.
2. `InvoiceService` maps the local invoice + lines to a BC `purchaseInvoices` payload (DTO mapping, never raw BC JSON built ad hoc in the UI).
3. POST header, POST/PATCH lines, invoke the bound `post` action.
4. On success: store `bcDocumentId`, `bcDocumentNumber`, `externalDocumentNumber`, set `syncStatus = SYNCED`, invoice status → `SENT_TO_BC` (later `POSTED` once confirmed by the next sync pass).
5. On failure: store `syncError`, keep invoice in `APPROVED` with a visible "export failed, retry available" state — never silently drop the reference between local record and BC.

## 8. Service boundaries (per project brief §28)

`BusinessCentralClient`, `VendorService`, `PurchaseOrderService`, `ReceiptService`, `InvoiceService`, `PaymentService`, `BusinessCentralSyncService` — each owns its entity's mapping/sync/idempotency; none of them are called directly from UI components, only from Server Actions/route handlers.
