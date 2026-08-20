# Vendor Portal — Architecture

## 1. Context

Adsemble already runs a Vendor Portal in production (`https://portalproveedores.adsemble.do`), built by a third-party vendor on **Supabase** (Postgres + Auth + Storage) with **n8n** automations (`automate.smartautomation.cloud`) syncing to/from **Microsoft Dynamics 365 Business Central**. Only the compiled frontend bundle is available; there is no access to the original source. `../extraido/*.md` documents what was recovered by reverse-engineering that bundle: the table schema, frontend routes, invoice status lifecycle, and the webhook calls the frontend makes.

This project **replaces** that system with a self-owned stack, in two stages:

1. **Parity phase** — rebuild the current functionality (roles `admin` / `approver` / `supplier`, invoice lifecycle, BC sync, exports) on the new stack, fixing the bugs already observed in production (see `IMPLEMENTATION_PLAN.md`).
2. **Expansion phase** — grow into the full scope described in the vendor-portal specification: `Vendor` / `Vendor Admin` / `Buyer` / `Finance` / `Administrator` roles, three-way matching, decoupled OCR, document center, messaging, notifications, support desk, multi-company/multi-currency.

Business Central remains the system of record for vendors, purchase orders, receipts, invoices and payments. The portal is the collaboration and workflow layer on top of it, with its own database for caching, workflow state, documents, audit and reporting.

## 2. Layers

```
┌─────────────────────────────────────────────────────────────┐
│ UI (Next.js App Router, React Server Components + client    │
│ islands, Tailwind + shadcn/ui)                               │
├─────────────────────────────────────────────────────────────┤
│ Application Layer (Server Actions / Route Handlers)          │
│  - input validation (Zod), auth/session, authorization guard │
├─────────────────────────────────────────────────────────────┤
│ Domain / Business Logic (framework-agnostic services)        │
│  - VendorService, PurchaseOrderService, InvoiceService,      │
│    ThreeWayMatchService, PaymentService, DocumentService,    │
│    NotificationService, AuditService                         │
├───────────────────────┬───────────────────┬──────────────────┤
│ Database (Prisma/PG)  │ BC Integration     │ Storage          │
│  - cache + workflow   │  - BusinessCentral │  - StorageProvider│
│    state + audit      │    Client + sync   │    (local/blob/S3)│
├───────────────────────┴───────────────────┴──────────────────┤
│ Jobs / Sync Workers (BullMQ + Redis)                          │
│  - scheduled + manual + on-demand BC sync, notification fanout│
├─────────────────────────────────────────────────────────────┤
│ Notifications (in-app + email; Teams/WhatsApp/SMS adapters)  │
└─────────────────────────────────────────────────────────────┘
```

Rule: **no business logic inside React components.** Server Actions/route handlers call domain services; domain services never import Next.js or React; BC-specific JSON never crosses into the UI — everything is mapped through DTOs.

## 3. Tech stack

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router), TypeScript |
| Styling/UI kit | Tailwind CSS + shadcn/ui |
| ORM / DB | Prisma + PostgreSQL |
| Auth | Auth.js (email+password now, Entra ID provider ready for production) |
| Validation | Zod (shared schemas client/server) |
| Forms | React Hook Form |
| Tables | TanStack Table (search/filter/sort/pagination/export) |
| Jobs/Sync | BullMQ + Redis |
| File storage | `StorageProvider` abstraction — `LocalStorageProvider` (dev), `AzureBlobStorageProvider` / `S3StorageProvider` (prod) |
| Containerization | Docker + Docker Compose (`app`, `postgres`, `redis`) |
| OCR (Phase 7) | Decoupled `OcrProvider` interface — Azure Document Intelligence as first implementation |

This replaces the current Supabase + n8n stack. Nothing in the new codebase depends on Supabase; the `extraido/` material is reference-only, used to replicate schema/behavior/text, not a dependency.

## 4. Roles

| New role | Legacy equivalent | Summary |
|---|---|---|
| `VENDOR` | `supplier` | Vendor-company user, scoped to its own `vendorId`(s) |
| `VENDOR_ADMIN` | *(new)* | Vendor user who also manages other users of the same vendor company |
| `BUYER` | *(new, Phase 7)* | Internal purchasing user — read POs/vendors, message vendors |
| `FINANCE` | `approver` | Internal AP user — review/approve/reject invoices, view payments |
| `ADMIN` | `admin` | Full portal administration |

Vendor isolation is enforced **server-side on every query and mutation**, never only in the UI: a session resolves to one or more `vendorId`s (via `VendorUserMapping`, replacing legacy `user_vendor_mapping`), and every domain service scopes its queries by that set. See `DATABASE_SCHEMA.md` §"Vendor isolation".

## 5. Non-functional requirements

- **Security:** RBAC + server-side authorization on every endpoint, CSRF protection, rate limiting, secure/HttpOnly cookies, file MIME/size validation, audit log on sensitive actions, no secrets in frontend bundles.
- **Multi-currency:** every monetary field carries its BC `currencyCode`; never assume DOP.
- **Multi-company:** `Company` is a first-class entity from day one, even though only one BC company exists today.
- **Fiscal extensibility:** RNC/NCF/e-NCF/ITBIS are Dominican-specific fields modeled as a pluggable `FiscalProfile` per country, not hardcoded into core invoice logic.
- **Timezone:** stored in UTC; presentation timezone configurable per tenant (defaults to `America/Santo_Domingo`, not hardcoded elsewhere).
- **Idempotent sync:** BC → portal sync never creates duplicates when re-run (keyed on BC `SystemId`/document number).
- **Observability:** structured logs (no secrets/PII), correlation IDs across sync jobs, future Sentry/Prometheus/Grafana hook points.

## 6. Reference documents

- `BUSINESS_CENTRAL_INTEGRATION.md` — BC API surface, auth, client design, entity gaps, sync strategy.
- `DATABASE_SCHEMA.md` — Prisma schema, entities, relationships, legacy-table mapping.
- `IMPLEMENTATION_PLAN.md` — phased delivery plan, including the parity bug-fix backlog.
