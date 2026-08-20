# Database Schema

PostgreSQL via Prisma. This supersedes the legacy Supabase schema documented in `../extraido/01-esquema-tablas.md`; the mapping table in §9 shows how legacy tables/columns carry over.

## 1. Identity & access

**Company** — multi-company ready from day one.
`id, bcCompanyId, name, isActive, createdAt`

**Vendor**
`id, companyId→Company, bcVendorId (BC SystemId), vendorNumber, name, taxId (RNC), address, city, country, contactName, contactEmail, contactPhone, paymentTerms, currencyCode, vendorPostingGroup, paymentMethod, bankInfo (json, permission-gated field), status, portalAccessEnabled, lastSyncedAt`

**User**
`id, email (unique), passwordHash, name, role (enum: VENDOR, VENDOR_ADMIN, BUYER, FINANCE, ADMIN), isActive, mfaEnabled, failedLoginAttempts, lockedUntil, lastLoginAt, createdAt, updatedAt`

**VendorUserMapping** (replaces legacy `user_vendor_mapping`)
`userId→User, vendorId→Vendor, companyId→Company, isPrimary` — a `VENDOR`/`VENDOR_ADMIN` user must have at least one row here; **every vendor-scoped query filters by the set of `vendorId`s reachable through this table for the current user**, enforced in the domain service layer, never only in the UI.

## 2. Purchase orders

**PurchaseOrder**
`id, bcId, companyId, vendorId, poNumber, orderDate, expectedReceiptDate, buyer, currencyCode, paymentTerms, location, status (enum: OPEN, PARTIALLY_RECEIVED, RECEIVED, PARTIALLY_INVOICED, INVOICED, CLOSED, CANCELLED), amount, receivedAmount, invoicedAmount, lastSyncedAt`

**PurchaseOrderLine**
`id, purchaseOrderId, lineNo, itemOrAccountNo, description, quantity, unitOfMeasure, unitPrice, taxPercent, lineAmount, quantityReceived, quantityInvoiced` — outstanding quantity is derived (`quantity - quantityInvoiced`), not stored.

**PurchaseReceipt** / **PurchaseReceiptLine**
`PurchaseReceipt: id, bcId, purchaseOrderId, receiptNumber, receiptDate`
`PurchaseReceiptLine: id, receiptId, purchaseOrderLineId, quantity`

**PoConfirmation**
`id, purchaseOrderId, userId, action (enum: CONFIRMED, CHANGE_REQUESTED), newExpectedDate, reason, comments, ipAddress, createdAt` — a change request never writes to BC directly; it is a portal-side record that surfaces to Buyers as a pending request (per brief §8, sensitive changes require internal approval, not an automatic BC write).

## 3. Invoices

**Invoice**
`id, vendorId, purchaseOrderId (nullable), supplierInvoiceNumber, invoiceDate, dueDate, currencyCode, subtotalAmount, discountAmount, taxAmount, totalAmount, status (enum: DRAFT, SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, SENT_TO_BC, POSTED, PARTIALLY_PAID, PAID, CANCELLED), rejectionReason, rejectedByUserId, rejectedAt, bcDocumentId, bcDocumentNumber, externalDocumentNumber, syncStatus, syncDate, syncError, changedByUserId, createdAt, updatedAt`

Unique constraint: **`(vendorId, supplierInvoiceNumber)`** — the duplicate-invoice guard from brief §12.

**InvoiceLine**
`id, invoiceId, purchaseOrderLineId (nullable), description, quantity, unitPrice, taxAmount, lineAmount`

**InvoiceFiscalProfile** (extensible, one row per invoice, per-country shape)
`id, invoiceId, countryCode, rnc, ncf, eNcf, fiscalTaxDate, itbisAmount` — kept out of the core `Invoice` model so a non-DR country doesn't inherit Dominican-only fields; the core model only carries generic `taxAmount`/`totalAmount`.

**InvoiceAttachment**
`id, invoiceId, fileName, originalName, mimeType, size, storageKey, uploadedBy, hash, createdAt` — actual bytes live in `StorageProvider` (local/Blob/S3), never in Postgres.

**InvoiceStatusHistory**
`id, invoiceId, status, changedByUserId, reason, changedAt` — covers both the approval/rejection trail and the audit requirement; a separate `InvoiceApproval` table was considered and dropped as redundant with this one for a linear workflow.

## 4. Payments & ledger

**Payment**
`id, bcId, vendorId, invoiceId (nullable, resolved by document matching), paymentNumber, paymentDate, amount, currencyCode, paymentMethod, reference, status, lastSyncedAt`

**VendorLedgerEntry**
`id, vendorId, bcEntryNo, documentType, documentNo, postingDate, amount, remainingAmount, description` — backs `/account-statement` (opening balance, invoices, credit notes, payments, running balance).

## 5. Documents

**DocumentType** — `id, code, name, requiresExpiration, countryCode (nullable)`
**VendorDocument** — `id, vendorId, documentTypeId, fileName, originalName, mimeType, size, storageKey, uploadDate, expirationDate, status (enum: PENDING_REVIEW, APPROVED, REJECTED, EXPIRED), approvedByUserId, comments`

## 6. Messaging & notifications

**MessageThread** — `id, contextType (enum: PURCHASE_ORDER, INVOICE, GENERAL), contextId (nullable), vendorId, createdAt`
**Message** — `id, threadId, authorUserId, body, createdAt`
**Notification** — `id, userId, type (enum matching brief §22), title, body, isRead, relatedEntityType, relatedEntityId, createdAt`

## 7. Support

**SupportTicket** — `id, vendorId, userId, subject, category, relatedPurchaseOrderId (nullable), relatedInvoiceId (nullable), priority, description, status (enum: OPEN, IN_PROGRESS, WAITING_VENDOR, RESOLVED, CLOSED), createdAt`
**SupportTicketAttachment** — same shape as `InvoiceAttachment`, scoped to a ticket.

## 8. Platform / integration

**AuditLog** — `id, actorUserId, action, entity, entityId, before (json), after (json), ipAddress, createdAt`
**SyncLog** — `id, entity, direction, startedAt, finishedAt, recordsProcessed, recordsCreated, recordsUpdated, recordsFailed, status, error, correlationId`
**SyncError** — `id, syncLogId, entity, bcId, errorMessage, payload (json), resolved`
**SystemSetting** — key/value(json) rows: notification settings, invoice tolerances, document-expiration alert windows, BC sync intervals, feature flags, default currency/timezone.

No generic polymorphic `BusinessCentralReference` table: each synced entity carries its own `bcId`/`lastSyncedAt` columns directly, which is simpler and keeps idempotency keys local to the entity that needs them.

## 9. Legacy → new schema mapping

| Legacy (Supabase) | New | Notes |
|---|---|---|
| `user_profiles.role` (`admin`/`approver`/`supplier`) | `User.role` (`ADMIN`/`FINANCE`/`VENDOR`) | `VENDOR_ADMIN`/`BUYER` are new, no legacy source |
| `user_vendor_mapping` | `VendorUserMapping` | same shape, `isPrimary` preserved |
| `vendors` | `Vendor` | `tax_registration_number`→`taxId`, `company_name`→`name` |
| `companies` | `Company` | |
| `purchase_orders` / `purchase_orders_lines` | `PurchaseOrder` / `PurchaseOrderLine` | legacy lines were **not syncing** ("SIN DATOS" bug) — fixed in Phase 2, see `IMPLEMENTATION_PLAN.md` |
| `invoices` | `Invoice` + `InvoiceFiscalProfile` | fiscal fields (`invoice_tax_number`/NCF, `invoice_tax_security_number`) split out; legacy NCF-extraction bug tracked for fix |
| `invoice_lines` | `InvoiceLine` | |
| `invoice_status_history` | `InvoiceStatusHistory` | same purpose |
| *(none — file served via signed URL directly)* | `InvoiceAttachment` + `StorageProvider` | replaces direct Supabase Storage signed-URL calls from the frontend |

## 10. Vendor isolation (enforcement point)

Every Prisma query that touches `Vendor`, `PurchaseOrder`, `Invoice`, `Payment`, `VendorLedgerEntry`, `VendorDocument` for a `VENDOR`/`VENDOR_ADMIN` session **must** go through a repository helper that injects `WHERE vendorId IN (:allowedVendorIds)` derived server-side from `VendorUserMapping` — never from a client-supplied `vendorId`. This is the single most important invariant in the system (brief §38) and gets a dedicated test suite (see `IMPLEMENTATION_PLAN.md` Phase 1).
