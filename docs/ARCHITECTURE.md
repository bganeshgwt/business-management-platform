# Architecture

*Written 7 October 2026 against the code in this folder, and checked against it
again on 22 October 2026. **Start here.** This is the one document that
explains what the product is, where everything lives, why it is built that
way, and how to extend it. The other documents are references this page links
to.*

| If you need… | Read |
| --- | --- |
| The words (business, type, module, capability, role…) | [NAMING.md](NAMING.md) |
| Every table, column, constraint and trigger | [DATABASE.md](DATABASE.md) |
| The business platform's five layers and their rules, in depth | [BUSINESS_PLATFORM_DATA_MODEL.md](BUSINESS_PLATFORM_DATA_MODEL.md) |
| Every endpoint | [API.md](API.md) |
| What each screen does, for staff and owners | [ADMIN_GUIDE.md](ADMIN_GUIDE.md), [MULTI_BUSINESS_ADMIN.md](MULTI_BUSINESS_ADMIN.md) |
| The product in a few pages, for owners | [BUSINESS_ADMIN_OVERVIEW.md](BUSINESS_ADMIN_OVERVIEW.md) |
| The business rules chosen for each type, and the setting that changes each | [DECISIONS_ROUND2.md](DECISIONS_ROUND2.md) |
| What is left to build | [REMAINING_BACKLOG.md](REMAINING_BACKLOG.md), [REMAINING_WORK.md](REMAINING_WORK.md) |
| What has been tested, go-live checks | [VERIFICATION.md](VERIFICATION.md), [PILOT_CHECKLIST.md](PILOT_CHECKLIST.md) |

Contents

1. [Vision in one page](#1-vision-in-one-page)
2. [Glossary at a glance](#2-glossary-at-a-glance)
3. [System map: how a request flows](#3-system-map-how-a-request-flows)
4. [Database architecture](#4-database-architecture)
5. [Code map, folder by folder](#5-code-map-folder-by-folder)
6. [How to …](#6-how-to-)
7. [Honest current state and the target structure](#7-honest-current-state-and-the-target-structure)
8. [Moving to a new repository](#8-moving-to-a-new-repository)
9. [Roadmap](#9-roadmap)

---

## 1. Vision in one page

**What it is.** The **Business Management Platform** is one product for
independent businesses of twelve types: restaurant, grocery / kirana,
supermarket, wholesale / FMCG, fashion, electronics, pharmacy, books &
stationery, salon & spa, clinics & labs, meat & seafood, and other weight-based
shops. One PostgreSQL database holds every business; each business sees only
its own data and only the parts (modules) it has switched on. One person can
belong to several businesses with a different role in each.

**The applications.**

| Application | State today |
| --- | --- |
| **Staff app** (`apps/business-web`) | Built. A switcher in the header opens any business you belong to. For the restaurant (run as a restaurant, café, bakery or cloud kitchen) it is the full restaurant admin, including the POS screen, kitchen display and captain views. For the other types it is the Business Admin menu built from that business's modules. |
| **Guests' site** (`apps/customer-web`) | Built (its own app since 21 October 2026): QR table ordering, online ordering and online booking. The planned guest pages (`/shop`, `/appointments`, `/account`) already answer with what is coming. |
| POS app (offline-capable till) | Later. The POS *screen* exists inside the staff app (`/pos`). |
| Captain / waiter app | Later (phone-first; uses the existing order and KOT APIs). `/captain` already exists and says what waiters use today. |
| Kitchen display app | Later as a separate app; the screen exists today (`/kitchen`). |
| Clinic and lab workspaces | Later. `/clinic` and `/lab` already exist and link to the clinic's screens in Business Admin. |
| Platform admin and subscriptions | Later. Today a platform super admin has the platform console in the staff app (`/platform/restaurants`, `/platform/businesses`); no plans or subscriptions yet. |

**Guiding principles.** Each one is enforced in code or in the database, not
only written down.

| Principle | What it means in practice |
| --- | --- |
| **Shared core plus type extensions** | Everything most businesses need (catalogue, contacts, documents, payments, stock, number series, appointments, receivables) is one shared core. A business type adds only what is truly its own, in `<type>_*` tables that hang off core rows. A core table never gets a column for one type's sake. |
| **Capability vs permission** | Two separate questions on every request: *may this business use the module?* (`business_capabilities`; later decided by its plan) and *may this person do this action?* (their role's permissions in that business). Both must say yes. |
| **Every record scoped to its business** | Business tables carry `business_id NOT NULL` and composite foreign keys `(business_id, x_id)`, so the database refuses a row that points at another business's data. The restaurant tables are scoped by `restaurant_id`, taken from the signed-in user, never from the request. |
| **Money in paise** | Amounts are stored as `NUMERIC(…,2)` (never floating point) and worked out in whole paise (BigInt where quantities multiply) so that lines, taxes and splits add up to the paisa. |
| **Idempotent postings** | A business posting carries a `request_key` (UUID) unique per business plus a hash of the request. Repeating it returns the first result; the same key with different content is a 409. |
| **Audit and events** | Every business mutation writes an audit row (`business_audit`) and, for money, stock and appointments, an outbox event (`business_events`) **in the same transaction**. Restaurant actions write `audit_logs` (see §7 for the difference). |
| **Rules in the database** | Where a bug would lose money or stock, a CHECK, partial unique index or trigger refuses it too, with a sentence a person can read (SQL state 23514 → HTTP 409). |
| **Today-only live screens** | Live screens (dashboard, kitchen, deliveries, table requests, the bell) show the current *trading day* in the business's time zone. Between midnight and the day cut-off (5 am by default) last night's day is still today. Anything older that is still open is only counted or flagged, never mixed in with today's. |
| **Data grid everywhere** | Every list is the shared `DataGrid` component: S.No., paging, search, column choice, export, phone cards. |

---

## 2. Glossary at a glance

The full list, including the trade words of each type, is in
[NAMING.md](NAMING.md).

| Word | Meaning | Where it lives |
| --- | --- | --- |
| Platform | What all businesses share: module catalogue, permission catalogue, role templates; later plans and subscriptions. | `platform_*`, `business_permissions`, `business_role_templates` |
| Business | One independent business (a tenant). | `businesses` |
| Business type | What kind of business it is. Fixed once created (trigger `businesses_type_is_fixed`). | `business_types` (12 rows) |
| Format | What kind of food business a restaurant is: restaurant, café, bakery or cloud kitchen. All four are the restaurant type on the same tables; the format presets features and how the POS opens (§4.2). | `restaurants.format` |
| Location / outlet | A shop, counter or warehouse with its own stock and number series. Restaurants call them outlets. | `business_locations`; restaurant: `outlets` |
| Module / feature | A part of the product a business can use (Sales, Stock transfers, Appointments…). *Core* modules are always on. A restaurant calls its optional modules *features*. | `platform_modules` |
| Capability | A module switched on for one business. | `business_capabilities` |
| Role | A named set of permissions inside one business (each business has its own copies). | `business_roles`; restaurant: `roles` |
| Permission | One action on one module, written `module.action` (e.g. `sales.refund`). | `business_permissions`; restaurant: `permissions` |
| Membership | A person's access to one business, with their role there. | `business_memberships` |
| Document | A posted money record of the shared core: sale, purchase (and their returns, payments, refunds). Restaurant equivalents: `bills`, `purchase_orders`, `goods_receipts`. | `business_documents` (+ lines, payments, returns, refunds) |
| SKU | One sellable / stockable item of the shared core (a variant is its own SKU). | `catalog_skus` under `catalog_products` |
| Lot | Stock of one SKU at one location, optionally one batch (with expiry) or one serial. Every change to it is a movement. | `business_stock_lots`, `business_stock_movements` |

---

## 3. System map: how a request flows

```
 Browser
   │  React page (apps/business-web/src/modules/<module>/pages/…; a guest's page: apps/customer-web)
   │    └─ a service function (the module's services/*.service.js, or src/services/)
   │         └─ staff app: services/api.js  (axios: Bearer token, X-Outlet-Id, approval retry)
   │            guests' site: the module's own axios instance on /api/public, no token
   ▼
 Express 5  (backend/src/app.js: helmet → compression → cors → json → morgan
   │         → /uploads static → dashboard-cache clear on write → /api routes)
   │
   ├─ routes/index.js  picks the module's router by path (/auth, /businesses, /bills, …)
   │
   ├─ middlewares, in the route's order:
   │    authenticate          JWT → req.user (id, restaurantId, outletId, roles, permissions, features)
   │    resolveOutlet         restaurant only: X-Outlet-Id → req.outletId (pinned staff cannot change it)
   │    requireFeature(code)  restaurant only: feature switched on? (see §4.2)
   │    authorize(perm)       restaurant only: req.user.permissions has it?
   │    authorizeOrApprove    restaurant only: or a manager's one-time approval token
   │    context(perm)         business only: membership → location → capability → permission
   │                          (req.business)
   │
   ├─ controller   (restaurant: modules/…/controllers/*.controller.js — reads req, validates, answers)
   │               (business: the route handler itself calls the service; there are no controllers)
   ├─ service      business rules; opens the transaction
   ├─ repository   SQL only, always with $1, $2 placeholders
   ▼
 PostgreSQL  (constraints and triggers have the last word)
   │
   └─ in the same transaction: business_audit + business_events (business side)
      after the action: audit_logs via utils/audit.js logAction (restaurant side)
```

### The two entry paths

The code has **two request paths** today, one per data world (§7 explains why).

| | Restaurant admin | Business Admin (every other type) |
| --- | --- | --- |
| URLs (browser) | `/`, `/pos`, `/menu/…`, `/reports` … | `/business-admin/<businessId>/<section>` |
| API | `/api/bills`, `/api/orders`, `/api/menu` … (42 route files) | `/api/businesses/:businessId/…` (one router, `business.routes.js`, plus the six route files it mounts: five for the types, one for the counter) |
| Which tenant | `req.user.restaurantId` from the signed-in user. Never from the request. | `:businessId` in the URL, **checked against the caller's membership** on every request. A business you are not a member of answers 404. |
| Branch | `X-Outlet-Id` header, checked by `resolveOutlet` | `locationId` in the body or query, checked against `business_locations` of that business. A person tied to one location (`business_memberships.location_id`) works there only; for anyone else the branch picked in the header (`X-Business-Location`) fills in a location the request leaves out. |
| Permissions | `users` → `user_roles` → `roles` → `role_permissions` → `permissions` (89 codes) | `business_memberships` → `business_roles` → `business_role_permissions` → `business_permissions` |
| Module gate | Restaurant features (`requireFeature`, §4.2) | `business_capabilities` (`businessAccess.service.js`) |
| Errors | `AppError` → `errorHandler.js` | `AppError`; database codes 23505 / 23503 / 23514 mapped to 409 / 400 at the end of `business.routes.js` |

### The business switcher

```
 AppLayout
   └─ BusinessProvider (context/BusinessProvider.jsx)
        ├─ GET  /api/businesses                 → the switcher's list (memberships)
        ├─ URL /business-admin/:id/*             → which business is open
        ├─ GET  /api/businesses/:id/context      → modules, permissions, role, settings, locations
        └─ POST /api/businesses/:id/open         → remember "last opened" (server, per person)
   └─ BusinessSwitcher (components/BusinessSwitcher.jsx)
   └─ BusinessLocationSwitcher (components/BusinessLocationSwitcher.jsx) → the branch, as X-Business-Location
```

- The **active business reaches the server only through the URL**
  (`/api/businesses/<id>/…`, built by `services/business.service.js`). Nothing
  about the business is kept in a header or cookie; only the branch picked
  beside the switcher travels as `X-Business-Location` (`services/api.js`),
  and the server accepts it only for an open location of that business. The
  server re-checks the membership, module and permission on every call, so an
  edited URL gains nothing.
- Picking the **signed-in restaurant** goes to `/` and the restaurant admin
  (its business row is marked `is_signed_in_restaurant`, by
  `legacy_restaurant_id = user.restaurantId`). Picking any other business goes
  to `/business-admin/<id>`.
- The last business opened is stored in `business_memberships.last_opened_at`;
  arriving at `/` sends the person back there if it was not their restaurant.
- The menu for a business is `businessMenu()` in `services/businessNav.js`:
  each link (`businessSections()`) names a permission (`need`), optionally a
  module, and the business types it belongs to, and `services/businessWorkspace.js`
  groups the links a person may open into workspaces (Daily work, Business,
  Management). `BusinessAdminRoutes.jsx` guards each screen with the same
  rule, so a screen opened by its address says why it is not available.
- The restaurant's own menu links are `NAV_SECTIONS` in `layouts/AppLayout.jsx`
  (a link may also name the formats it is for: `formats`, `notFormats`),
  grouped into areas by `restaurantMenu()` in `services/restaurantWorkspace.js`
  and guarded in `App.jsx` by `ProtectedRoute` (`permission`, `feature`,
  `featureAny`).

### Manager approval (restaurant)

A cashier without, say, `bills.void` asks anyway. `authorizeOrApprove` answers
403 with `reason: "approval_required"` and what the action would do (`scope`).
`services/api.js` opens the PIN dialog (`components/ApprovalDialog.jsx`), a
manager approves through `POST /api/auth/approvals`, and the same request is
re-sent once with `X-Approval-Token`. The token is spent before the action
runs, is tied to the user, permission and scope (bill, amount), and is never
handed back. The activity-log row then names both people.

### Events and audit

- **Business side:** `repo.audit()` and `repo.event()` in
  `modules/business/core/repositories/business.repository.js` are always called with the
  transaction's own client. If the change rolls back, so do they.
  `business_events` is an outbox: nothing reads it yet (§6.8).
- **Restaurant side:** `utils/audit.js › logAction(req, …)` writes
  `audit_logs` from the controller, best-effort, after the action. Restaurant
  postings write no `business_events` today.
- **Notifications (the bell)** are *derived*, not stored: each file in
  `backend/src/notifications/providers/` works out its alerts from live data
  when asked (see `backend/src/notifications/README.md`); only "who has read
  what" is stored (`notification_reads`). Business Admin has its own bell
  (pro pass G-07): `GET /api/businesses/:id/notifications`
  (`modules/business/core/services/businessNotifications.service.js`), also
  derived; its read marks are kept in the browser
  (`apps/business-web/src/services/businessNotifications.js`, passed to
  `NotificationBell` as `feed`).

---

## 4. Database architecture

One database (`restaurant_management_db` by default), 133 migration files in
`backend/migrations/` and 333 tables (22 October 2026). The schema is
defined only by those files. Table-by-table reference:
[DATABASE.md](DATABASE.md). Why the business layers are shaped as they are:
[BUSINESS_PLATFORM_DATA_MODEL.md](BUSINESS_PLATFORM_DATA_MODEL.md).

### 4.1 The five layers of the business platform

```
 1 Platform           platform_modules ─┬─ platform_module_business_types ── business_types
                                        └─ platform_module_dependencies
                      business_permissions · business_role_templates (+ _permissions)
                      (later: platform_plans, platform_plan_modules, business_subscriptions)
 2 Identity & access  users ── business_memberships ── business_roles ── business_role_permissions
 3 Business (tenant)  businesses ── business_settings · business_tax_rates · business_number_series
                      business_capabilities · business_locations · business_payment_methods
                      business_departments
 4 Shared core        catalog_categories ── catalog_products ── catalog_skus ── catalog_sku_units
                      catalog_kit_components · business_sku_location_prices (a branch's own price)
                      business_units · business_contacts · business_price_rules
                      business_documents (+ lines, payments, returns, refunds) · business_supplier_payments
                      business_collections (+ cheques, refunds) · business_exchanges (+ policies, vouchers)
                      business_stock_lots · business_stock_movements · business_stock_adjustments
                      business_stock_transfers (+ lines) · business_stock_counts (+ lines)
                      business_resources · business_appointments
                      business_expenses · business_cash_checks · business_counter_shifts
 5 Type extensions    retail_* · books_* · wholesale_* · fashion_* · electronics_* · salon_* · weight_*
                      pharmacy_* · health_* · lab_*
 Tasks (§4.3)         business_task* · business_issues · business_project* · platform_task_categories
 Cross-cutting        business_audit · business_events (outbox)
```

**Rules the database enforces (not only the code):**

| Rule | How |
| --- | --- |
| A row can only point at rows of its own business | `business_id NOT NULL`, `UNIQUE (business_id, id)` on each table, and composite foreign keys `(business_id, x_id) → x(business_id, id)` |
| A module can be on only if it applies to the type and its dependencies are on | Constraint trigger `business_capabilities_enforce` |
| A new business is ready to use | `AFTER INSERT` triggers on `businesses` give it roles, settings, GST slabs, units and its type's default modules; every type but the restaurant also gets five payment methods, and an electronics shop four financiers |
| A location someone is tied to stays open; the owner is never tied to one; at least one payment method stays on | Triggers on `business_locations`, `business_memberships` and `business_payment_methods` |
| A tax slab's rate never changes | Trigger (add a new slab instead) |
| Document numbers never repeat or go back | `business_number_series`: taken with `UPDATE … RETURNING` inside the posting; trigger forbids moving `next_number` backwards |
| Every stock movement has exactly one source | `num_nonnulls(document, adjustment, transfer) = 1`; the sum of a lot's movements equals its quantity |
| Posted records are never edited | Append-only and one-way-status triggers on lines, discounts, loyalty entries, commissions, wastage, repairs, expenses, cash checks, cashier shifts, signed lab reports, QC runs… |
| Outbox rows are only ever stamped once | Trigger on `business_events` allows only setting `published_at`, once; unpublished rows cannot be deleted |
| Serial numbers are in one place at a time | Constraint trigger `electronics_serial_lot_rules` with an advisory lock |

Error mapping: a trigger raises SQL state 23514 with a readable sentence and
no constraint name; `business.routes.js` turns it into a 409 with that
sentence. A named CHECK becomes a 400, a duplicate (23505) a 409, a missing
related row (23503) a 400.

### 4.2 The restaurant module's own tables and the bridge

The restaurant was built first, on its own tables, all scoped by
`restaurant_id` (and `outlet_id` where a branch matters). Main groups (full
list in [DATABASE.md › Restaurant module](DATABASE.md#restaurant-module)):

| Area | Tables |
| --- | --- |
| Tenant and access | `restaurants`, `outlets`, `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `approvals`, `user_sign_ins`, two-step tables, `audit_logs`, `notification_reads` |
| Settings | `restaurant_settings`, `business_hours`, `floor_settings`, `service_settings`, `document_counters`, `till_discount_limits` |
| Menu | `categories`, `products`, `product_variants`, `modifiers`, `product_recipes`, `modifier_recipes`, `tax_rates`, `combo_items`, `price_windows`, `product_selling_rules`, `menu_sold_out`, `restaurant_brands` |
| Floor | `floors`, `dining_areas`, `dining_tables`, `captain_assignments` |
| Orders and kitchen | `orders`, `order_items`, `order_item_modifiers`, counters, `kots`, `kot_items`, `kot_change_slips`, `kitchen_stations`, `table_requests`, `restaurant_preorders` (+ items) |
| Reservations and online | `reservations`, `waitlist_entries`, `online_booking_settings`, `online_ordering_links`, `sales_channels`, `customer_addresses` |
| Money | `business_days`, `cash_drawers`, `cash_movements`, `bills`, `bill_items`, `bill_taxes`, `payments`, `payment_types`, `refunds`, `credit_notes`, `customer_accounts`, `customer_advances`, `rider_settlements`, `discounts` |
| Guests | `customers`, `loyalty_transactions`, `feedback`, `complaints` |
| Stock and purchasing | `suppliers`, `units`, `inventory_items`, `stock_transactions`, `stock_balances`, `inventory_batches` (+ balances, movements), `stock_counts`, `stock_transfers`, `stock_indents`, `production_batches`, `dish_waste_entries`, `purchase_orders`, `goods_receipts`, `purchase_returns`, `supplier_payments` |
| Expenses, staff, pay | `expenses`, `document_attachments`, `employees`, `shifts`, `attendance`, `timeclock_settings`, `payroll_*`, `tip_*`, `logbook_entries` |

Note the overlap with the shared core: the restaurant has its own `customers`,
`suppliers`, `units`, `tax_rates`, `products` and stock ledger. §7 plans how
they converge.

**The bridge.** A restaurant appears on the platform as one `businesses` row
of type `restaurant` with `legacy_restaurant_id` pointing at `restaurants.id`
(unique; created by `POST /api/businesses/link-restaurant`). Its owner gets an
Owner membership and the `restaurant` capability. Nothing in the restaurant
tables was renamed or moved.

**Restaurant feature switches (migration
`1791470000000_restaurant-feature-switches.sql`).**

- Optional modules in the **same** platform catalogue, applying to type
  `restaurant`, grouped by `platform_modules.feature_group`: Guests
  (`guests`, `guest_loyalty`), Service (`reservations`, `qr_ordering`,
  `online_ordering`, `deliveries`, `kitchen_display`, `captain_sections`,
  `preorders`, `brands`), Money (`tips`, `advances`, `cash_drawers`,
  `coupons`), Back office (`stock_recipes`, `staff_payroll`) and Operations
  (`tasks`, `issues`, `projects`, §4.3). Nineteen in all: this migration made
  the first fourteen, the tasks module added three, and the food formats
  (`preorders`) and kitchen brands (`brands`) one each (below). Loyalty,
  online ordering and pre-orders need guests; issues and projects need tasks.
  Core parts (POS, orders, bills, dues, menu, tables, outlets, business day,
  expenses, log book, reports, users, settings, activity log) stay always on.
- A restaurant's switch is a `business_capabilities` row of its bridged
  business (`restaurant_business_id()` links a restaurant on its first
  switch), so the existing triggers enforce dependencies and a later plan sets
  them exactly like any other module. Every restaurant that existed then got
  everything on, loyalty as the old `restaurant_settings.loyalty_enabled`
  (dropped). A new restaurant starts with every feature on except loyalty,
  pre-orders and brands; its format may switch more on (below).
- Server: `restaurant_features(restaurant_id)` is read into
  `req.user.features` with the profile; `middlewares/requireFeature.js`
  refuses a switched-off feature's routes with 403 `reason: "feature_off"`;
  controllers refuse the mixed cases (a delivery order, a tip, paying from an
  advance, a coupon, points, picking a guest); the public QR, booking and
  online pages check the restaurant's features; notification providers and
  the live dashboard's blocks name a `feature` and are skipped while it is
  off; `modules/restaurant/setup/services/restaurantFeatures.service.js` refuses switching off a
  feature that would strand money, warns about hidden data and writes the
  activity log. The Business Admin's Settings › Business tools card (called
  Restaurant features for a restaurant business) goes through the same
  service.
- Screen: Settings › Features (`modules/restaurant/setup/pages/FeaturesPage.jsx`,
  `/restaurant/features`); `useAuth().hasFeature(code)`; nav links and
  `ProtectedRoute` take `feature` / `featureAny` (a switched-off page says so
  instead of opening). See ADMIN_GUIDE › Features.

This is the first real step of the restaurant onto the shared platform: its
module gate now uses the platform's capability tables.

**Food formats and brands (migrations `1791950410000_food-formats.sql` and
`1791950411000_kitchen-brands.sql`).**

- A café, a bakery and a cloud kitchen are the restaurant type on the same
  tables, not new business types: `restaurants.format` says which
  (`restaurant`, `cafe`, `bakery`, `cloud_kitchen`).
- The owner picks it on Settings › Features
  (`modules/restaurant/setup/services/restaurantFormat.service.js`). That sets
  how the POS opens (`service_settings.pos_order_types`, `default_order_type`,
  tokens) and switches features through the same rules as above. Each can be
  changed again afterwards.
- The formats brought pre-orders (`restaurant_preorders`, module
  `restaurant/preorders`: the advance is an ordinary customer advance, and
  collection bills a takeaway order against it), selling by weight
  (`products.sold_by`) and the day-end unsold count (waste reason `unsold` in
  `stock_transactions`).
- Brands let one kitchen sell under several names: `restaurant_brands`, a
  category for one brand or for all (`categories.brand_id`), and the brand on
  each order (`orders.brand_id`), printed on its KOTs and bill and added up in
  the brand report.

### 4.3 Tasks, issues & projects: one model for both worlds

Migration `1791620000000_tasks-issues-projects.sql`, module `modules/tasks/`
(backend and frontend). The first module built for **every** business type at
once, including the restaurant, and so the first to show the target shape
(§7.2):

- **Data keyed on `business_id` only.** A restaurant reaches it through its
  business row (`restaurant_business_id()`); the other types through their
  memberships. No `restaurant_id` table was added. Only "where" and "who"
  differ — `outlet_id`, restaurant `employee_id` and `role_id` versus
  `location_id`, `resource_id` and `business_role_id` — and the trigger
  `business_task_world_check` makes the database refuse a pointer outside the
  business, as the composite keys do on the business side. When plans D and E
  move the restaurant onto memberships and locations, those columns retire;
  nothing else changes.
- **Two front doors, one service layer.** `/api/tasks` (restaurant:
  `authenticate`, the restaurant's features and permissions) and
  `/api/businesses/:id/tasks` (membership → capability → permission) build the
  same `scope` (`services/scope.js`) and call the same services. The frontend
  does the same: `TasksProvider` picks the API base and the screens are shared
  (`/tasks/*` in `App.jsx`, `tasks/*` in `BusinessAdminRoutes.jsx`).
- **Switches and permissions in both catalogues.** Modules `tasks`, `issues`,
  `projects` (restaurant feature group "Operations", on by default for a
  restaurant; the other types start with them off and switch them on in
  Settings › Business tools, where some trades see them recommended); the
  same 13 codes in `business_permissions` and the restaurant `permissions`
  table.
- **The template library is code** (`modules/tasks/library/`, about 80
  checklists by business type, six project plans), versioned with the app;
  a business's own templates are rows.
- **Recurring tasks without a daemon.** Occurrences are generated on read,
  idempotently (advisory lock per business + a unique index on schedule, day
  and slot), and a sweep marks missed what closed undone.
- **Outbox.** `task.assigned`, `issue.reported`, `issue.assigned` go to
  `business_events` in the same transaction, ready for a WhatsApp publisher.
- **The log book stays** the restaurant's shift diary; an entry needing work
  becomes an issue (`business_issues.source_logbook_entry_id`), not a copy.

### 4.4 How a sale moves money and stock

**Restaurant (dine-in):**

```
 POS / captain / QR  ──► orders + order_items (+ modifiers)       order.service / order.repository
                          │ KOT sent
                          ▼
                         kots + kot_items → kitchen display        kitchen.repository
                          │ guest asks for the bill
                          ▼
 bill.repository (one transaction):
   number from document_counters (series per prefix, yearly reset optional)
   bills + bill_items + bill_taxes (snapshot: GST per rate, service and delivery charge shares, round-off)
   loyalty points redeemed (loyalty_transactions), coupon / till discount
   if consume_stock: each line's recipe → stock_transactions 'consumption'
                     (reference_type 'bill', from the bill's outlet store, batches first-to-expire)
   COMMIT
                          │ payment(s)
                          ▼
 payments (cash/card/upi/…; tip_amount kept apart; advance payments use a customer_advance)
   bill_status unpaid → partial → paid; points earned once the money is in
   cash goes to the open business_day and, with cash drawers on, the drawer
 Afterwards: void / refund / credit note put back exactly the stock the bill took
 (bills.consume_stock remembers whether it took any).
 Activity log: logAction from bill.controller.
```

**Shared core (any other type, e.g. a kirana sale):**

```
 POST /api/businesses/:id/documents { kind: 'sale', requestKey, locationId, contactId?, lines, payment? or payments? }
   context(['sales.create','purchasing.create'])  membership + module + permission
   business.service.document → repo.transaction → postDocument:
     lock the business row (one lock order for every posting: business → document → lots)
     request_key seen?  same hash → return the first result; different → 409
     settings (tax_mode, rounding), location, contact (locked)
     a kit line becomes its components, the kit's price split over them (businessKits.service.js)
     price each line on the server: list or branch price, member price → customer / slab price
       (businessPricing.js) → offers and points (businessOffers.js)
       → salon packages / memberships (businessSalonSales.js)
     pack units converted exactly to stock units
     number from business_number_series (businessNumbering.nextNumber, per location + kind + fiscal year)
     business_documents + business_document_lines (snapshots of name, unit, price, rate)
     lots picked (oldest expiry first; serial / batch named) → business_stock_lots updated
       + business_stock_movements (one source: this document)
     optional payments (one or several, each by a payment method) → business_payments;
       customer credit-limit check
     business_audit + business_events 'sale.posted' (+ 'payment.recorded', 'loyalty.earned' …)
   COMMIT
```

Returns, refunds and exchanges go through `businessReturns.service.js`
(`postReturn` inside the caller's transaction); a wholesale dispatch, a repair
delivery and a salon bill all post a normal sale through `postDocument`, so
numbering, stock, credit limit, events and audit are always the core's.

---

## 5. Code map, folder by folder

### 5.1 Repository layout

The code is grouped **by module** on both sides (plan B, §7.3, done 7 October
2026). A module is one folder that holds everything for one area: on the
backend its `routes/`, `controllers/`, `services/` and `repositories/`; on the
frontend its `pages/`, `services/` and `styles/`. Only code that several
modules share stays outside `modules/`.

The web side is two apps and two shared packages in npm workspaces (plan G,
§7.3, done 21 October 2026): the staff app `apps/business-web`, the guests'
site `apps/customer-web`, and `packages/ui` and `packages/shared` for what
both use. The backend keeps its own install. The same map on a few pages,
with every address built and planned: [CODE_STRUCTURE.md](CODE_STRUCTURE.md).

```
<repo>/
├── README.md                 setup, commands, project rules
├── .github/workflows/checks.yml   CI: backend unit + integration tests; web apps' lint, unit tests and builds
├── package.json              npm workspaces (apps/*, packages/*) and the commands for everything
├── .oxlintrc.json            one lint configuration for apps/ and packages/
├── docs/                     this documentation; docs/reference/ = the original plan files
├── backend/
│   ├── src/
│   │   ├── app.js            Express app: global middleware, /uploads, /api, 404, error handler
│   │   ├── server.js         checks the DB and that every migration is applied, then listens
│   │   ├── routes/index.js   mounts every module's router under /api (the only file left in routes/)
│   │   ├── modules/          one folder per module, each with routes/ controllers/ services/ repositories/
│   │   │   ├── access/       sign-in, users, roles, two-step, approvals, the activity log
│   │   │   ├── platform/     the platform console
│   │   │   ├── health/       /api/health, /api/db-health
│   │   │   ├── restaurant/   setup, menu, tables, orders, kitchen, reservations, online, preorders,
│   │   │   │                 deliveries, billing, business-day, crm, inventory, purchasing, expenses, staff,
│   │   │   │                 reports, logbook, notifications, imports
│   │   │   ├── business/     core (directory, catalogue, documents, stock, appointments, payment
│   │   │   │                 methods, expenses, shifts), retail, wholesale (+ receivables),
│   │   │   │                 fashion-electronics, salon-weight, health
│   │   │   └── tasks/        tasks, issues & projects for every business (+ library/ of built-in templates)
│   │   ├── config/           env.js (reads and checks .env), database.js (pg pool + DB_POOL_GUARD)
│   │   ├── middlewares/      authenticate, authorize, authorizeOrApprove, resolveOutlet, requireFeature,
│   │   │                     reportOutlet, writeoffApproval, rateLimiters, upload, notFound, errorHandler
│   │   ├── notifications/    the bell: index.js + one provider file per module
│   │   └── utils/            AppError, validate, money, audit, docNumber, gstin, phone, totp, calendarDate …
│   ├── migrations/           node-pg-migrate SQL files (the only definition of the schema)
│   ├── scripts/              migrate, create restaurant / user, demo data, clean copies, backup
│   ├── tests/                *.test.js unit tests; integration/ (each file builds its own database)
│   ├── uploads/              public images (menu pictures) — user data, not source
│   ├── private_uploads/      attachments on expenses and purchase bills — user data, never public
│   └── .local/               backups, demo logins, logs — never copied or committed
├── apps/
│   ├── business-web/         the staff app (React + Vite, :5173)
│   │   ├── src/
│   │   │   ├── main.jsx      the shared look (@bmp/ui/styles.css); providers: QueryClient, Router, AuthProvider;
│   │   │   │                 ApprovalDialog, ConfirmHost, Toaster
│   │   │   ├── App.jsx       every restaurant route (lazy imports from modules/) + /business-admin; the planned
│   │   │   │                 workspaces (/captain, /clinic, /lab); old guest links → GuestSiteRedirect
│   │   │   ├── modules/      one folder per module, each with pages/ (+ services/, styles/ where it has its own)
│   │   │   │   ├── access/   sign-in, profile, users, roles, two-step
│   │   │   │   ├── platform/ the platform console
│   │   │   │   ├── restaurant/  the same areas as the backend (but imports/), plus dashboard/
│   │   │   │   ├── business/ core/ (Business Admin, BusinessAdminRoutes.jsx, hooks.js, ui.jsx) and one
│   │   │   │   │             folder per type: retail, wholesale, receivables, fashion, electronics, salon,
│   │   │   │   │             weight, health
│   │   │   │   └── tasks/    the task screens, shared by the restaurant (/tasks) and Business Admin (…/tasks)
│   │   │   ├── layouts/      AppLayout.jsx (header, switchers, bell, side menu), NotFoundPage, PlannedPage,
│   │   │   │                 GuestSiteRedirect
│   │   │   ├── context/      AuthProvider (user, permissions, features), BusinessProvider (open business)
│   │   │   ├── hooks/        useAuth, useBusiness, useLiveChange, useQueryFilter, motion hooks …
│   │   │   ├── routes/ProtectedRoute.jsx   login + permission + restaurant feature guard
│   │   │   ├── services/     shared: api.js, queryClient, approval, features, csv, print, customerWeb,
│   │   │   │                 plannedWorkspaces, the menus (businessNav, businessWorkspace,
│   │   │   │                 restaurantWorkspace) …, and the API services shared code uses (auth,
│   │   │   │                 outlet, notification, business)
│   │   │   ├── components/   shared UI: DataGrid/, Modal, PageHeader, SectionCard, ActionMenu, motion.js …
│   │   │   └── styles/       sheets used by more than one module (data-grid.css, reservations.css …)
│   │   ├── tests/            *.test.js (Node); browser/ (Playwright)
│   │   └── public/
│   └── customer-web/         the guests' site (React + Vite, :5174)
│       ├── src/
│       │   ├── main.jsx      the shared look, Router (no sign-in, no staff providers)
│       │   ├── App.jsx       /order/:token, /online/:token/*, /book/*; planned /shop, /appointments,
│       │   │                 /account; any other address → StartPage
│       │   ├── modules/      table-order/ (pages/, services/); online-order/, booking/ (pages/, services/, styles/)
│       │   ├── pages/        StartPage, PlannedPage
│       │   ├── plannedPages.js   what each planned guest page says
│       │   └── styles/       guest.css
│       └── tests/browser/    Playwright checks
└── packages/
    ├── ui/                   @bmp/ui: styles/ (base = tokens and elements, ui, motion, colour, components),
    │                         Icon, menu/ (ComboChoicePicker, AddonChoiceRules)
    └── shared/               @bmp/shared: format, dates, menu/ (comboChoices, addonChoices)
```

**Where a file goes.** A file that only one module uses lives in that
module. An API service (`*.service.js`) lives in the module that owns its API
area even when other modules call it (e.g. `restaurant.service.js` in
`restaurant/setup`). A helper, service or stylesheet that shared code
(components, layouts, context, hooks) or several modules use stays in
`src/services/` or `src/styles/`. Modules import from each other freely; only
shared code should not reach into a module (one exception today:
`context/AuthProvider.jsx` shows the log book's handover notice).
Code that both web apps use goes in a package, imported by name: React
components and styles in `packages/ui` (`@bmp/ui/Icon`), plain functions in
`packages/shared` (`@bmp/shared/format`). Code one app alone uses stays in
that app.

**Why two slightly different groupings for the business types.** The backend
keeps the business type route files as they were, and two of them serve two
types each, so the backend has `fashion-electronics` and `salon-weight`, with
receivables beside wholesale (they share `businessTrade.routes.js`). The
frontend's screens were already one folder per type, so it keeps
`fashion`, `electronics`, `salon`, `weight` and `receivables` apart.

### 5.2 Which files belong to which module

Backend names below drop the folder and suffix: `bill.*` in the module
`restaurant/billing` means `backend/src/modules/restaurant/billing/` +
`routes/bill.routes.js`, `controllers/bill.controller.js`,
`services/bill.service.js` and `repositories/bill.repository.js` where they
exist. Staff screens are in `apps/business-web/src/modules/<module>/pages/`;
the guests' pages in `apps/customer-web/src/modules/<area>/pages/`.

**Restaurant** (scoped by `restaurant_id`; screens under `/`):

| Module (`modules/…`) | Backend | Frontend pages | Main tables |
| --- | --- | --- | --- |
| `restaurant/setup` | `restaurant.*`, `outlet.*`, `serviceSettings.*`, `paymentType.*`, `taxRate.*`, `restaurantFeatures.*`, `restaurantFormat` (the format and what it sets), `ruleSettings` (the restaurant's own alerts and timings) | profile and set-up checklist, settings (with alerts and timings), hours, outlets, features and the format, payment types, service settings | `restaurants`, `outlets`, `restaurant_settings`, `business_hours`, `service_settings`, `payment_types` |
| `access` | `auth.*`, `user.*`, `role.*`, `twoFactor.*`, `approval.*`, `audit` (repository), `activityLog`; middlewares `authenticate`, `authorize`, `authorizeOrApprove` stay in `src/middlewares` | `LoginPage`, `ProfilePage`, users, roles, two-step | `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `approvals`, `user_sign_ins`, `audit_logs` |
| `restaurant/menu` | `menu.*`, `menuCard`, `menuCommon`, `menuExtras`, `menuImport`, `menuPriceRevision`, `menuServiceOptions`, `menuBulk`, `combo`, `addonGroups`, `priceWindow`, `sellingRules`, `recipe`, `recipeImport`, `availability`, `brand` (controller and service), `category` / `product` repositories | products, categories, modifiers, price windows, tax rates, recipes, brands | `categories`, `products`, `modifiers`, `product_recipes`, `combo_items`, `price_windows`, `tax_rates`, `restaurant_brands` |
| `restaurant/tables` | `table.*`, `captainSection.*` | floors, tables, captain plan, QR sheet | `floors`, `dining_tables`, `captain_assignments` |
| `restaurant/orders` | `order.*`, `tableRequest.*`, `public.routes`, `publicMenu`, `tradingClock` (when today's trading day began, for the live screens) | POS (with the weighing dialog), orders, bills list, bill dialog, table requests, collection display (the guests' QR page: `apps/customer-web/src/modules/table-order`) | `orders`, `order_items`, `table_requests` |
| `restaurant/preorders` | `preorder.routes`, `preorder.service` | pre-orders and cakes, the bake list | `restaurant_preorders`, `restaurant_preorder_items` |
| `restaurant/kitchen` | `kitchen.*`, `kitchenSlip` | kitchen display, sold-out | `kots`, `kot_items`, `kitchen_stations` |
| `restaurant/reservations` | `reservation.*`, `publicBooking.*` | reservations (page + parts), online booking settings (the guests' booking page: `apps/customer-web/src/modules/booking`) | `reservations`, `waitlist_entries` |
| `restaurant/online` | `onlineOrder`, `publicOnline.routes`, `guestAddress.*` | — (services only: the ordering links for Service settings; the guests' ordering page: `apps/customer-web/src/modules/online-order`) | `online_*`, `customer_addresses` |
| `restaurant/deliveries` | `delivery.*`, `riderSettlement.*`, `deliveryCharge`, `salesChannel` | deliveries (page + tabs), rider cash | `sales_channels`, `rider_settlements` |
| `restaurant/billing` | `bill.*` (split, see below), `billPricing`, `gstBreakdown`, `serviceChargeShare`, `discount.*`, `customerAccount.*`, `customerAdvance.*` | discounts and offers, loyalty programme, dues, advances | `bills`, `bill_items`, `bill_taxes`, `payments`, `refunds`, `credit_notes` |
| `restaurant/business-day` | `businessDay.*`, `cashDrawer.*`, `tillRules`, `tradingDay` | business day, cash count, drawers, past days, X report | `business_days`, `cash_drawers` |
| `restaurant/crm` | `crm.*`, `loyalty.*`, `guestInsight.*`, `guestImport` | guests, feedback, complaints, guest insights | `customers`, `loyalty_transactions`, `feedback`, `complaints` |
| `restaurant/inventory` | `inventory.*`, `advancedInventory`, `batch`, `stockTransfer`, `stockSettings`, `dishWaste`, `inventoryInsight.*`, `writeoffControl`, `stockImport`; middleware `writeoffApproval` | stock items, ledger, transfers, insights, day-end unsold, settings | `inventory_items`, `stock_transactions`, `stock_balances`, `inventory_batches` |
| `restaurant/purchasing` | `supplier.*`, `supplierImport`, `purchase.*`, `purchaseReturn.*` | suppliers, purchase orders, returns | `suppliers`, `purchase_orders`, `goods_receipts` |
| `restaurant/expenses` | `expense.*`, `attachment.*`; middleware `upload` | expenses, attachments | `expenses`, `document_attachments` |
| `restaurant/staff` | `staff.*`, `timeclock.*`, `leave`, `statutory`, `myWork`, `tip.*` | employees, time clock, attendance, shifts, payroll, tips, my work | `employees`, `shifts`, `attendance`, `payroll_*`, `tip_*` |
| `restaurant/reports` | `report.*` (split, see below), `dashboardLive.controller`; middleware `reportOutlet`, `utils/dashboardCache` | reports (page + one file per tab), audit log | reads everything |
| `restaurant/dashboard` (frontend only) | the dashboard's API is in `restaurant/reports` | `DashboardPage`, blocks, panels | — |
| `restaurant/logbook` | `logbook.*` | log book, follow-ups, handover notice | `logbook_entries` |
| `restaurant/notifications` | `notification.*` (the bell's API; providers stay in `src/notifications/providers/`) | `NotificationsPage` (the bell itself is `components/NotificationBell`) | `notification_reads` |
| `restaurant/imports` | `sheetImport.controller` (one controller for the four spreadsheet imports), `sheetImport` (the shared reader) | — | — |
| `platform` | `platform.*` (the businesses part calls `business/core`'s `businessOnboarding.service`) | `PlatformRestaurantsPage`, `PlatformBusinessesPage` | `restaurants`, `businesses`, `users` |
| `health` | `health.*` | — | — |

**The split report and bill files** (plan C). Each keeps an index file with
the same name and the same exports, so callers did not change:

- `restaurant/reports/services/report.service.js` gathers
  `services/report/`: `common.js` and `scope.js` (shared helpers: numbers and
  wording; the restaurant's clock, trading days and a report's scope),
  `sales.js`, `items.js`, `gstData.js` (the GST machinery the GST pack, day
  end and day book share), `gst.js`, `staff.js`, `stock.js`, `dayEnd.js`,
  `dashboard.js`, `periods.js` (months and cost sharing for the P&L and
  expenses), `profitLoss.js`, `expenses.js`, `dayBook.js`, `theft.js`.
- `restaurant/reports/repositories/report.repository.js` gathers
  `repositories/report/`: `sql.js` (shared SQL fragments: scope, trading day,
  live bills, bill lines, recipients, stock movements, voided bills),
  `sales.js`, `items.js`, `gst.js`, `staff.js`, `stock.js`, `drawers.js`,
  `dayEnd.js`, `dashboard.js`, `profitLoss.js`, `dayBook.js`, `theft.js`.
- `restaurant/billing/services/bill.service.js` gathers `services/bill/`:
  `shape.js` (a bill as the screens see it), `offers.js` (coupons, loyalty),
  `rules.js`, `raise.js` (list, raise, adjust, print), `payments.js`,
  `refunds.js` (credit notes, refunds, voids), `summaries.js`.
- Frontend: `ReportsPage.jsx` keeps the shell and its tabs are files
  (`SalesReport`, `ItemReport`, `ProfitabilityReport`, `OutletReport`,
  `CancellationReport`, `ConsumptionReport`, `DiscountReport`, as
  `GstReport`, `ProfitLossReport`, `ExpenseReport`, `DayBookReport`,
  `TheftReport`, `StaffReport` and `DayEndReport` are);
  `ReservationsPage.jsx` and `DeliveriesPage.jsx` keep the page and their
  panels, dialogs and helpers are files beside them (`Timeline`, `Agenda`,
  `BookingEditor`, `BookingDetail`, `reservationFormat.js` …; `BoardTab`,
  `DeliveryCard`, `ChannelsTab`, `ReportTab`, `deliveryFormat.js` …).

**Shared core** (scoped by `business_id`; screens under `/business-admin/:id/`).
Backend module `business/core`, frontend `modules/business/core/pages/`:

| Area | Backend | Frontend pages | Main tables |
| --- | --- | --- | --- |
| Directory, access, set-up | `business.routes.js`, `businessAccess.service` (membership, location, module, permission), `businessSetup.service`, `business.service` (list, link, provision, locations), `businessOnboarding.service` (a new business, staff logins), `businessNumbering`, `businessDepartments.service`, `business.repository`; `businessClone.service` (clean copies, run by `scripts/make-real-copies.js`) | `BusinessAdminPage`, `NewBusinessForm`, `SettingsPage`, `TaxRatesPage`, `NumberSeriesPage`, `LocationsPage`, `StaffAccessPage`, `RolesPage`, `ActivityPage`; `WorkspaceNav` (a workspace's tabs) | `businesses`, `business_memberships`, `business_roles`, `business_settings`, `business_tax_rates`, `business_number_series`, `business_capabilities`, `business_locations`, `business_departments`, `business_audit` |
| Catalogue, contacts, prices | `business.service` (catalog, contacts, price rules), `businessPricing`, `businessModules` (the attributes an item may carry, by module), `businessSetup.service` (categories, units, packs), `businessLocationPrices.service` (a branch's own price), `businessKits.service` (kits and bundles) | `CatalogPage`, `CategoriesPage` (with departments), `UnitsPage`, `ContactsPage`, `PricingPage`, `KitsPage` | `catalog_*`, `business_units`, `business_contacts`, `business_price_rules`, `business_sku_location_prices` |
| Sales and purchases | `business.service` (`postDocument`, payments), `businessReturns.service` | `DocumentsPage` | `business_documents` (+ lines, payments, returns, refunds) |
| Tax invoice, day close, paying suppliers (pro pass) | `businessTakings.service` (day close, today's overview figures), `businessPayables.service` (payables, supplier payments, statement) | `invoice.js` (the one A4 / 80 mm GST invoice), `DayClosePage` (Daily money), `SupplierPayments.jsx` (on `ContactsPage` for suppliers); Quick bill is `retail/pages/CounterPage` + `counterParts`, `counterState`, `counterPay`, `counterShelf`, `counterShift` for every goods type, its shared till's per-staff PIN `businessCounter.service` (routes in `businessCounter.routes.js`, with kits and EMI) | `business_supplier_payments` |
| Payment methods, expenses, cash checks, cashier shifts | `businessPaymentMethods.service`, `businessExpenses.service`, `businessCashChecks.service`, `businessShifts.service` | `PaymentMethodsPage`, `ExpensesPage`, `CashCheck` and `CashierShifts` (on `DayClosePage`) | `business_payment_methods`, `business_expenses`, `business_cash_checks`, `business_counter_shifts` |
| Stock | `businessStock.service`, `businessReturns.service` (adjustments) | `StockPage`, `MovementsPage`, `TransfersPage`, `CountsPage`, `CountSheetPage` | `business_stock_*` |
| Appointments | `business.service` (resources, appointments, `statusAllowed`) | `AppointmentsPage`, `ResourcesPage` | `business_resources`, `business_appointments` |
| Receivables (udhaar / outstanding) | backend module `business/wholesale`: `businessTrade.routes.js`, `businessReceivables.service` | `modules/business/receivables/` | `business_collections` |
| Overview and reports | `business.service.reports` + each type's reports service; `businessOverview.service` (the Overview's picture of the day), `businessBranches.service` (every location side by side), `businessDepartments.service` (sales by department) | `OverviewPage` (+ `OverviewToday`), `ReportsPage` | reads the core |

**Business type extensions:**

| Type | Backend module and files | Frontend (`modules/business/…`) | Tables |
| --- | --- | --- | --- |
| Retail (grocery, supermarket, books) | `business/retail`: `businessRetail.routes`, `businessRetail.service`, `businessRetailCustomers`, `businessRetailOffers`, `businessRetailReports`, `businessOffers` (pricing), `businessBooks`, `businessRetailPro` (near expiry, school sets, book orders) | `retail/` (Counter, Udhaar, Offers, Loyalty, Books, BookOrders, NearExpiry, Labels, RetailReports) | `retail_*`, `books_titles`, `books_sets`, `books_set_items`, `books_customer_orders` |
| Wholesale | `business/wholesale`: `businessTrade.routes`, `businessWholesale.service` (orders, edits, dispatch), `businessWholesalePricing.service` (price groups, schemes), `businessWholesaleCredit.service` (credit hold, trade details), `businessWholesaleDelivery.service` (pick list, runs, delivery, invoice extras), `businessWholesaleMoney.service` (settlement, overview, beat sheet, claims), `businessWholesalePurchase.service` (purchase orders, reorder suggestions, receiving; round 2) | `wholesale/` (SalesOrders, Dispatch, BackOrders, Routes, PriceGroups, Claims, PurchaseOrders, WholesaleReports, SettlementPanel, WholesaleToday) | `wholesale_*`, `business_collection_cheques` |
| Fashion | `business/fashion-electronics`: `businessFashionElectronics.routes`, `businessFashion.service`, `businessFashionPro.service` (barcodes, markdowns, GST by price, style reports), `businessExchanges.service`, `businessVouchers.service` | `fashion/` | `fashion_variants`, `fashion_gst_price_slabs`, `business_exchanges`, `business_exchange_policies`, `business_exchange_vouchers` |
| Electronics | same module and routes file, `businessElectronics.service`, `businessRepairs.service`, `businessElectronicsPro.service` (scan-in receipts, faulty units, warranty claims), `businessFinance.service` (EMI and financiers; its routes are in `core/routes/businessCounter.routes.js`) | `electronics/` (Serials, Warranties, Repairs, RepairJob, Finance) | `electronics_*` |
| Salon & spa | `business/salon-weight`: `businessSalonWeight.routes`, `businessSalon.service`, `businessSalonSales` (pricing, commission on sessions and plan sales), `businessSalonPro.service` (move, arrival, walk-ins, messages, client card, leave, plan extension, history), `businessSalonRound2.service` (a stylist's week and salon holidays, back-bar products, handing back advances, monthly target commission plans), `businessManagerPin` (a manager's PIN say-so; repairs use it too), `businessAdvanceRefunds` (an advance handed back; repairs too) | `salon/` (Calendar, New bill, `ClientPanel`, `salonParts` client picker, Packages, Commissions, `CommissionPlans`, Stylists & services, Service profitability, `ManagerApproval`, `SalonAppointmentsPage`; styles in `salon/styles/salon-pro.css`) | `salon_*` |
| Meat and weight shops | same module and routes file, `businessWeight.service`, `businessWeightPro.service` (rates, stock today, day close, wastage in one go, cut to order, pickup orders, today) | `weight/` (Rates, Pickup orders, Stock by weight, Cutting & yield, Wastage, Yield & wastage, `WeightToday` on the Overview, `CounterWeightTools` mounted by Quick bill) | `weight_*` |
| Pharmacy, clinics & labs (rounds 2 and 3) | `business/health`: `businessHealth.routes` (mounted from `business.routes.js`), `healthUploads.routes` (prescription scans, mounted in `routes/index.js` before `/businesses`), `healthCommon` (settings, signatories and PIN sign-off, counters, private files), `businessPharmacy.service` (drug master, prescription sale, registers, recalls, near expiry, debit notes, invoice extras), `businessClinic.service` (patients, consent, visits, billing a visit), `businessLab.service` (tests, orders, samples, results, approval, report); round 3: `businessClinicDesk.service` (doctors' fees and follow-ups, OPD sessions and leave, the token queue), `businessLabQuality.service` (signed report versions and amendments, QC) | `health/` (PharmacyCounter, DrugMaster, PharmacyRegisters, PharmacyBatches, HealthSettings, ClinicToday, TokenQueue, Doctors, Patients, Patient, Visits, Visit, LabOrders, LabOrder, LabTests, LabQc; `healthFormat.js`, `healthParts.jsx`, `healthPrint.js`) | `pharmacy_*`, `health_*`, `lab_*` |

**Modules for every business, the restaurant included:**

| Module | Backend | Frontend (`modules/tasks/pages/`) | Tables |
| --- | --- | --- | --- |
| Tasks, issues & projects (`modules/tasks`) | `routes/tasks.routes.js` (both front doors), `controllers/tasks.controller.js`, `services/` (`scope`, `common`, `people`, `templates`, `recurrence`, `tasks`, `issues`, `projects`, `files`, `reports`, `notifications`), `repositories/tasks.repository.js`, `library/`; bell provider `notifications/providers/tasks.js`; demo `scripts/seed-tasks.js` | `TasksRoutes`, `TasksScope`, `MyTasksPage`, `TaskRunPage`, `BoardPage`, `CalendarPage`, `IssuesPage`, `IssueDetailPage`, `ProjectsPage`, `ProjectDetailPage`, `TemplatesPage`, `RecurringPage`, `TaskReportsPage`, `TasksTodayCard`, `forms`, `ItemsEditor`, `ScheduleForm`, `parts`, `taskWords`, `useTasks`, `useServerGrid`; API calls `services/tasks.service.js`; styles `styles/tasks.css` | `business_task*`, `business_issues`, `business_project*`, `platform_task_categories` |

Demo data per type: `scripts/setup-business-demos.js` with `demo-retail.js`,
`demo-wholesale.js`, `demo-fashion-electronics.js`, `demo-salon-weight.js`
and `demo-common.js`; the realistic business of each type with
`scripts/seed-realistic-demos.js` and `scripts/realistic/` (the types' own
files in `realistic/types/`); the food formats with `scripts/demo-food-formats.js`.
Tests per type: `tests/integration/business-*.test.js` (the food formats:
`food-formats.test.js`).

### 5.3 Where the conventions live

| Convention | File | Rule |
| --- | --- | --- |
| Expected errors | `backend/src/utils/AppError.js` | `throw new AppError(status, "sentence for a person", details?)`. `details` goes to the client as `data` (e.g. what blocks closing a day). Anything else is a 500 with no detail. |
| Error responses | `middlewares/errorHandler.js` | `{ success: false, message, data? }`; deadlocks (40P01, 40001) become a 409 "try again"; adds a note when a manager's approval was spent. |
| Success responses | every controller / route | `{ success: true, data }` |
| Input validation | `backend/src/utils/validate.js` | Small checkers (`requiredString`, `requiredId`, …) that throw `AppError(400)` naming the field. Business services also have local `decimal`, `uuid`, `dateText` helpers in `business.service.js`. No schema library. |
| Permissions (restaurant) | `middlewares/authorize.js` | `authorize("x.y")`, `authorize.any(…)`, `authorize.noteEnforced(…)` for checks made inside a handler (the role editor shows which codes are really enforced; besides the routes it reads the source of `routes/`, `middlewares/` and every file under `modules/` for quoted codes — keep new code inside `modules/`). |
| Approvals | `middlewares/authorizeOrApprove.js`, `modules/access/services/approval.service.js`, staff app `services/approval.js`, `components/ApprovalDialog.jsx` | See §3. Bind `scope` to the facts the manager sees. |
| Permissions (business) | `modules/business/core/services/businessAccess.service.js` | `access.load` → `access.require(business, "module.action")`; `can()` for optional figures. |
| Audit | restaurant `utils/audit.js` (`logAction`); business `repo.audit(db, …)` | Business: always with the transaction's client. |
| Pool and transactions | `config/database.js`; business `repo.transaction(work)`; restaurant services and repositories open `pool.connect()` + `BEGIN/COMMIT` themselves | Inside a transaction use **only** the transaction's client. |
| `DB_POOL_GUARD` | `config/database.js` | `warn` logs, `throw` refuses, any request that asks the pool for a second connection while holding one (the hold-and-wait pattern that can freeze the API). Off by default. |
| Money | `utils/money.js` (restaurant: `round2`, `toPaise`); business services in paise / BigInt | Never add rupee floats across lines; work in paise and convert at the end. |
| Trading day | `modules/restaurant/business-day/services/tradingDay.js`, `businessDay.service.js`; reports: `modules/restaurant/reports/services/report/scope.js`; live screens: `modules/restaurant/orders/repositories/tradingClock.js` | Dates in the business's time zone (default Asia/Kolkata), with the day cut-off. |
| Startup safety | `utils/migrationStatus.js` | The API refuses to start with a pending migration. |
| HTTP client | `apps/business-web/src/services/api.js` (the guests' site uses its own client per page, with no token) | Adds the token and `X-Outlet-Id`, refreshes the token past half its life, signs out on 401, re-sends after an approval, reloads features on `feature_off`. |
| Server data cache | `apps/business-web/src/services/queryClient.js` | TanStack Query: 30 s stale time, 10 min memory; `sessionScope()` belongs in every key (user, restaurant, outlet); cleared on sign-out. Not every page uses it yet (many use `useEffect` + service calls). |
| Lists | `apps/business-web/src/components/DataGrid/` | The usage comment at the top of `DataGrid.jsx` is the manual. Business lists use `useServerList()` from `modules/business/core/pages/hooks.js` for server paging and search. |
| Motion | `components/motion.js` + `packages/ui/src/styles/motion.css` | Only transform and opacity move; nothing waits for an animation; `prefers-reduced-motion` turns it off. |
| Theme tokens | top of `packages/ui/src/styles/base.css` (`:root`, then a dark-mode block); `colour.css` beside it. Both apps load them through `@bmp/ui/styles.css` | Pages use `var(--…)` and never restate a hex value. |
| Words per type | `services/businessNav.js` (`TYPE_WORDS`, `word()`); the menu's own labels in `services/businessWorkspace.js` (`workspaceLabel()`) | A salon says Clients, a kirana says Udhaar. |

---

## 6. How to …

Every recipe ends with the same three steps: run the tests (§6.11), update the
reference docs that describe what you changed (API.md, DATABASE.md,
ADMIN_GUIDE.md), and back up before applying a migration to a database that
matters.

### 6.1 Add a feature to a business type

Example: a new salon screen.

1. **Migration** (§6.5): new `salon_*` table(s) with `business_id BIGINT NOT
   NULL`, `UNIQUE (business_id, id)`, composite foreign keys to the core rows
   it hangs off, and triggers for any rule that protects money or stock. If it
   needs its own switch, add a module (§6.3); if it needs its own action, add
   permissions (§6.4).
2. **Service:** add functions to
   `modules/business/salon-weight/services/businessSalon.service.js` (or a new
   `businessSalonX.service.js`). Pattern: `repo.transaction(async (db) => { …
   })`, re-check record-dependent permissions with `access.require`, use
   `request_key` + hash for anything that posts, call `repo.audit(db, …)` and,
   for money / stock / appointments, `repo.event(db, …)`. Money goes through
   `postDocument` — never write `business_documents` directly.
3. **Route:** in `modules/business/salon-weight/routes/businessSalonWeight.routes.js`,
   `router.post(b('/salon/…'), context('module.action'), handler)`. A new
   paged list goes through `repo.addLists` so it gets paging, search and
   period filters like the others.
4. **Frontend:** a page in `modules/business/salon/pages/`, a `<Route>` in
   `modules/business/core/pages/BusinessAdminRoutes.jsx` wrapped in `page("section", …)`,
   a link in `businessSections()` in `services/businessNav.js` with
   `need`, `module` and `types: SALON`, and its section in the right workspace
   of `services/businessWorkspace.js` (`WORKSPACES`), or the menu will not
   show it.
5. **Tests:** extend `tests/integration/business-salon-weight.test.js`
   (allowed and refused roles, a module switched off, cross-business ids,
   idempotent repeat).
6. **Demo:** if useful, add sample rows in `scripts/demo-salon-weight.js`
   (with request keys from `demo-common.js` so it stays repeatable) and in
   the realistic salon, `scripts/realistic/types/salon.js`.
7. **Clean copies:** a new set-up table (not one of records) goes into
   `TABLES` in `modules/business/core/services/businessClone.service.js`, so
   a clean copy keeps it (`tests/integration/business-clean-copy.test.js`).

### 6.2 Add a new business type

1. **Migration:** `INSERT INTO business_types (code, name)`; rows in
   `platform_module_business_types` for each module it may use and which are
   on by default. The provisioning trigger then gives each new business of
   that type its roles, settings, GST slabs, units and default modules. A role
   only this type has (as a pharmacy's Pharmacist) is a role template with the
   type in `business_role_templates.business_types`.
2. If it needs a new document kind, widen the
   `business_number_series.document_kind` CHECK **keeping the whole list**,
   and add the kind with its prefix to `SHORT` in
   `modules/business/core/services/businessNumbering.js` (`KINDS` is its
   keys).
3. **Extension tables** named `<type>_*` (§6.1). Never add a column to a core
   table for one type.
4. **Backend:** a module folder `modules/business/<type>/` with
   `services/business<Type>.service.js` and either a new
   `routes/business<Type>.routes.js` mounted at the end of
   `modules/business/core/routes/business.routes.js` (before the error mapper) like the others, or routes in
   an existing type file.
5. **Frontend:** `TYPE_WORDS` and `TYPE_ICONS` in `services/businessNav.js`,
   links with `types: [...]`, its menu in `dailyWorkspaces()` in
   `services/businessWorkspace.js`, pages in `modules/business/<type>/pages/`.
6. **Demo:** the type gets a demo from `npm run business:demos` automatically (one
   demo per non-restaurant type); add sample data in a `scripts/demo-<type>.js`
   called from `setup-business-demos.js`, and a realistic business in
   `scripts/realistic/types/` (`npm run seed:realistic`).
7. **Tests:** a `tests/integration/business-<type>.test.js`.
8. **Clean copies:** its set-up tables in `TABLES` in `businessClone.service.js`
   (§6.1 step 7).

Pharmacy and clinic / lab have their own module since round 2 (`business/health`).

### 6.3 Add a module switch

**Business platform module** (the pattern of
`1791430000000_salon-packages-memberships-commissions.sql`):

1. `INSERT INTO platform_modules (code, name, description, kind, sort_order)`
   with `kind = 'optional'`.
2. `platform_module_dependencies` for what it needs.
3. `platform_module_business_types` for the types it applies to and the
   default (new businesses start lean: specialist tools default to off), with
   `recommended` and a `recommended_note` for a trade that mostly uses it.
4. Switch it on for **existing** businesses whose type has it on by default
   (`INSERT INTO business_capabilities … SELECT … ON CONFLICT DO NOTHING`), only
   where its dependencies are on.
5. Its permissions (§6.4).
6. Write the Down half (delete capabilities, grants, permissions, module rows).
7. Frontend: links with `module: "<code>"` or a `need` whose module is the new
   code. Nothing else: Settings › Business tools reads the catalogue.

The server caches the catalogue per process (`platformCatalogue()`), so
**restart the API after the migration**.

**Restaurant feature** (as `preorders` and `brands` were added): the same rows with
`feature_group` set and applying to `restaurant`; then `requireFeature("code")`
on its routes, `feature="code"` on its `ProtectedRoute` and menu link, its name
in `FEATURE_NAMES` (`apps/business-web/src/services/features.js`), and `feature:` in its
notification provider. Add a rule in `restaurantFeatures.service.js` if
switching it off could strand money, and the feature to a format's `features`
in `restaurantFormat.service.js` if that format should start with it.

### 6.4 Add a permission

**Business permission:**

1. Migration: `INSERT INTO business_permissions (code, module_code, action, name, sort_order)`;
   `action` is one of view / create / edit / approve / cancel / refund /
   export / print / discount / assign / review / manage / view_clinical /
   edit_clinical (a CHECK; widen it with the whole list for a new one).
2. Grant it to templates (`business_role_template_permissions`) and to
   existing businesses' copies of those templates (`business_role_permissions …
   JOIN business_roles r ON r.template_code = …`, skipping `full_access` roles —
   the Owner already has everything).
3. Check it in the route (`context('module.action')`) or service
   (`access.require`). Show buttons with `biz.can('module.action')`.

**Restaurant permission:**

1. Migration: `INSERT INTO permissions (code, module, name, description)` and
   grant it to the system roles in `role_permissions` that should have it.
2. Route: `authorize("code")` (or `authorizeOrApprove("code", { scope })` when
   a manager may approve it on the spot); if checked inside a handler, call
   `authorize.noteEnforced("code")` in the routes file.
3. Frontend: `hasPermission("code")` from `useAuth()`, and the menu link /
   `ProtectedRoute permission`.

### 6.5 Add a migration

1. `cd backend && npm run migrate:create -- <short-name>` creates
   `migrations/<timestamp>_<short-name>.sql`. The timestamp must be **greater
   than the newest file already in the folder** (on 22 October 2026
   `1791950412000`); the files use round numbers (the next would be
   `1791950413000`) — rename the file if the generated one is older.
   `checkOrder: true` in `scripts/migrate.js` refuses to run a file older than
   the last one applied.
2. Write both halves, with the markers `-- Up Migration` and `-- Down
   Migration`. Down is for test databases; the real rollback of a live database
   is restoring the backup.
3. **Never edit a migration that has been applied anywhere** (your database,
   a colleague's, a server). Fix forward with a new file.
4. A CHECK that lists values (`document_kind`, payment `method`,
   `retail_sale_discounts.source`) must be rewritten **with the whole list**;
   other jobs may have widened it.
5. Back up (`npm run db:backup -- --verify`), then `npm run migrate:up`, then
   restart the API (it refuses to start while anything is pending).

### 6.6 Add a screen with a DataGrid

1. Page file in the right module's `pages/` folder
   (`modules/restaurant/<area>/pages/` or `modules/business/<…>/pages/`).
2. Data: a function in the module's `services/*.service.js` (`businessRead` for
   business screens). For a business list use `useServerList(path, { gridId,
   period })` and spread `list.gridProps` onto the grid; for a restaurant list,
   load rows and let the grid page them, or pass `server={…}` for API paging.
3. `<DataGrid id="stable-id" caption=… columns=[…] rows=… rowNoun=… empty=… />`.
   Give each column `key`, `header`, `value`, a `type` (money, date, status,
   actions) and `mobile` (title / subtitle) for phone cards. Keep S.No. on.
   `exportName` adds CSV export — only show it to people allowed to export.
4. Route: restaurant — a `<Route>` in `App.jsx` inside the right
   `ProtectedRoute`, a link in `NAV_SECTIONS` (`layouts/AppLayout.jsx`) and
   its path in an area of `services/restaurantWorkspace.js`; business — §6.1
   step 4.
5. Styles: the module's stylesheet in its `styles/` (a sheet several modules
   use stays in `src/styles/`), using tokens only.
6. Optional browser check in `apps/business-web/tests/browser/`.

### 6.7 Add a report

**Restaurant** (module `modules/restaurant/reports/`): SQL in the family's
file under `repositories/report/` (shared fragments in `report/sql.js`), the
function in the family's file under `services/report/` (dates by trading day
through `report/scope.js`, outlet from `reportOutlet`), each added to the
index file's exports (`report.repository.js`, `report.service.js`); a handler
in `controllers/report.controller.js`, a line in `routes/report.routes.js`
with `authorize("reports.view")` plus the data's own permission (e.g.
`sales.view`) and `requireFeature` if it belongs to a feature; then a
function in the staff app's `modules/restaurant/reports/services/report.service.js`
and a tab file in `modules/restaurant/reports/pages/` (wired from
`ReportsPage.jsx`), with CSV through `reportCsv.js` or the grid's export. A
new family of reports is a new file in each `report/` folder, not a longer
one.

**Business:** a function in the type's reports service (e.g.
`businessRetailReports.service.js`) or `business.service.reports`, a route with
`context('reports.view')` plus the data's permission, a page in
`modules/business/…/pages/`, a link in the Reports group of `businessNav.js`
and its section in the `reports` workspace of `businessWorkspace.js`.
Report money from posted documents, returns on their own day.

### 6.8 Add an outside integration through the events outbox

The outbox already holds every money, stock and appointment change
(`business_events`: `business_id`, `kind`, `entity_type`, `entity_id`,
`payload`, `actor_id`, `created_at`, `published_at`). To connect SMS,
WhatsApp, a webhook or accounting:

1. Write a **publisher** process (e.g. `backend/src/workers/publisher.js` with
   an npm script), separate from the API. In a loop: `BEGIN; SELECT … FROM
   business_events WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE
   SKIP LOCKED` (served by the partial index `business_events_unpublished`),
   deliver each, `UPDATE … SET published_at = now()`, `COMMIT`. The trigger
   allows only that one stamp, once.
2. Each **consumer** filters by `business_id` and by the business's
   capability / consent (e.g. `customers` marketing consent) and must be
   idempotent by event id, because a crash after delivery and before the stamp
   re-sends.
3. Add retry with back-off and a dead-letter record for events that keep
   failing; never block the queue on one event.
4. Keep provider keys in `.env` (and `.env.example` with fake values).
5. For a new kind of event, write it with `repo.event(db, …)` inside the
   posting's transaction — never after commit.
6. Restaurant postings do not write events yet; add them in their
   transactions first (§7.3 E, step 3).

### 6.9 Run and seed locally

```
PostgreSQL 15+ running
cd backend   && npm install && cp .env.example .env    # fill DB_*, JWT_SECRET (32+ random chars)
createdb restaurant_management_db                       # or CREATE DATABASE in psql
npm run migrate:up
npm run restaurant:create                               # first restaurant + its admin (prompts)
npm run seed:demo                                       # a month of restaurant trading
npm run dev                                             # API on :5010 (PORT in backend/.env)
cd ..        && npm install                             # web apps and packages (npm workspaces)
cp apps/business-web/.env.example apps/business-web/.env   # VITE_API_BASE_URL, VITE_CUSTOMER_WEB_URL
cp apps/customer-web/.env.example apps/customer-web/.env   # VITE_API_BASE_URL
npm run dev:business                                    # staff app on :5173
npm run dev:customer                                    # guests' site on :5174
```

The development servers show only their own app, `packages/` and
`node_modules` (`server.fs.allow` in each `vite.config.js`), so
`npm run dev:customer -- --host` (to try the guest pages on a phone) never
exposes `backend/.local` or uploads. For a phone, also point
`VITE_API_BASE_URL` in `apps/customer-web/.env` at this computer's network
address (`http://<its address>:5010/api`): on a phone, `localhost` is the
phone itself.

**Serving the two web apps.** `npm run build` writes `apps/business-web/dist`
and `apps/customer-web/dist`. Everything of the guests' site except its
`index.html` sits under `guest-assets/`, so the two builds never collide.

What each app needs (its dev server and build stop with a sentence when one
is missing):
- **Both apps:** `VITE_API_BASE_URL`.
- **The staff app:** `VITE_CUSTOMER_WEB_URL`, which is the guests' site's
  address, or `same-origin`.

Outside development these must be addresses phones can reach, never
`localhost`. There are two ways to serve the apps.

**Two addresses (recommended).** For example `app.example.com` for staff and
`order.example.com` for guests.
- Build the staff app with `VITE_CUSTOMER_WEB_URL=https://order.example.com`,
  and list the staff address in the API's `CORS_ORIGIN`.
- Guests' pages then never share the browser storage that holds a staff
  login.
- On the staff address, answer `^/(order|online|book)(/|$)` with a permanent
  redirect (301) to the same path on the guests' address. Old QR codes and
  shared links then skip the staff app. The app's own `GuestSiteRedirect` is
  the fallback. A server redirect skips the app's clean-up of the guest data
  the old pages left in that browser; keep the app's redirect alone if that
  matters.

**One address.**
- Send `^/(order|online|book|shop|appointments|account)(/|$)` to the guests'
  `index.html`, and `^/guest-assets/` to its files.
- Send `/api/` and `/uploads/` to the API, and everything else to the staff
  build.
- Set `VITE_CUSTOMER_WEB_URL=same-origin`.
- Mind the slash: `/orders` is a staff screen.
- Both apps then share one browser storage.

**Keep the old-link redirects for good.** Printed QR codes do not change.

A restaurant's own guest web address (Service settings) still decides where
its QR codes point. The API answers the public guest calls (`/api/public/…`)
from any address, so such a domain needs no `CORS_ORIGIN` change.

Other businesses: set `MULTI_BUSINESS_DEVELOPMENT=true` (only works on a
non-live `NODE_ENV`), restart, sign in as the restaurant admin, press *Link my
restaurant* on `/business-admin?all=1`, then
`npm run business:demos -- --user-id <id> --sample-data`. More: `seed:topup`
(trade the demo forward to today), `user:demo -- <CODE>` (one login per role,
passwords in `backend/.local/`), `seed:reset`,
`seed:realistic -- --user-id <id>` (a realistic business of every type but
the restaurant, about ninety days of history), `demo:today -- --user-id <id>`
(every demo brought up to now, before a demo), `demo:food-formats` (a café, a
bakery and a cloud kitchen) and `business:real-copies -- --owner-user-id <id>`
(clean copies of the demo shops, [DEMO_TO_REAL_PLAN.md](DEMO_TO_REAL_PLAN.md)).
Full table in the README.

### 6.10 Back up and restore

- **Back up:** `cd backend && npm run db:backup -- --verify`. Writes
  `backend/.local/backups/<time>-<id>/database.dump` (pg_dump custom format),
  a copy of `uploads/` and of `private_uploads/` (expense and purchase-bill
  attachments), and `manifest.json`; `--verify` restores into a scratch
  `rmp_restore_…` database, counts rows and drops it. Set `PG_BIN` if `pg_dump`
  is not on the PATH.
- **Restore** (to a new, empty database):
  ```
  createdb <new_db>
  pg_restore --no-owner --no-privileges --exit-on-error --dbname <new_db> <folder>/database.dump
  ```
  copy `<folder>/uploads` back to `backend/uploads` and
  `<folder>/private_uploads` to `backend/private_uploads`, point `DB_NAME` at
  the new database, run `npm run migrate:up` (applies only newer files),
  restart.
- Backups stay on this machine. Off-machine copies are a go-live item.

### 6.11 Run the tests

| Command | Where | What |
| --- | --- | --- |
| `npm test` | root | The Node tests of the apps and packages (`apps/business-web/tests`, `packages/shared/tests`), then the backend's unit tests |
| `npm test` | backend | Unit tests (`tests/*.test.js`, Node's built-in runner) |
| `npm run test:integration` | backend (or root) | The integration files. Each creates its own `rmp_test_<random>` database on the configured server, migrates it, runs, drops it; never touches `DB_NAME`. Needs a PostgreSQL user allowed to `CREATE DATABASE`. |
| `npm run lint` | root | oxlint over `apps/` and `packages/` (one configuration, `.oxlintrc.json`) |
| `npm run build` | root | production builds of both web apps (catches broken imports) |
| `npm run test:browser` | root | Playwright: the staff app at `E2E_BASE_URL` (default `http://localhost:5173`, needs `E2E_CREDENTIALS_FILE`), then the guests' site at `E2E_CUSTOMER_URL` (default `http://localhost:5174`) against the API at `E2E_API_URL` (default `http://localhost:5010/api`; its QR-menu test also needs `E2E_CREDENTIALS_FILE`); uses installed Edge on Windows |

To run one file: `node --test tests/integration/business-retail.test.js` (in
`backend`). CI (`.github/workflows/checks.yml`) runs the backend's unit and
integration tests, then lint, the apps' and packages' Node tests and both builds, on
every push and pull request.

---

## 7. Honest current state and the target structure

### 7.1 Where things stand

| Area | Today | Why it matters |
| --- | --- | --- |
| **Two data worlds** | The restaurant lives on its own `restaurant_id` tables (about 140 tables) with its own customers, suppliers, units, tax rates, products, stock ledger, bills and numbering. Every other type lives on the shared core. The bridges are `businesses.legacy_restaurant_id`, the restaurant's feature switches as `business_capabilities` (§4.2) and the tasks module, which both worlds share (§4.3). | Cross-type features (one customer across businesses, platform reports, the event outbox, plans) work for the core but not for the restaurant. |
| **Two identity / permission systems** | One `users` table, but restaurant access is `users.restaurant_id` + `user_roles` + `roles` + `permissions` (89 codes), while business access is `business_memberships` + `business_roles` + `business_permissions`. A restaurant user reaches Business Admin only through a membership. One-time manager approval tokens, outlet pinning and two-step sign-in roles exist only in the restaurant system; the business side has its own forms: a manager's PIN given with the request (`businessManagerPin.js`), the shared till's per-staff PIN, and a person tied to one location (`business_memberships.location_id`). Both use the same personal PIN. | Two role editors, two places to switch someone off, two meanings of "Manager". |
| **Two styles of backend code** | Restaurant: route → controller → service → repository, transactions opened by hand, audit after the action, almost no request keys (production batches have them). Business: route handler → service → one shared repository (`business.repository.js` with `transaction`, `audit`, `event`), request keys everywhere, audit and events inside the transaction. | A new developer must learn both. |
| **Module folders** | Done (plan B, 7 October 2026): `backend/src/modules/<module>/` and `apps/business-web/src/modules/<module>/` (then `frontend/`), see §5. `config/`, `middlewares/`, `utils/`, `notifications/` stay at the top of `src/` (no `core/` folder). | A module begins and ends at its folder. |
| **Apps and packages** | Done (plan G, 21 October 2026): npm workspaces with the staff app (`apps/business-web`), the guests' site (`apps/customer-web`), `packages/ui` and `packages/shared`. Planned screens already have their addresses, with a page that says what is coming. | The guests' site carries no staff code; what both apps use exists once. |
| **Very large files** | Split (plan C): `report.service.js` (was 4,480 lines), `report.repository.js` (2,659), `bill.service.js` (2,166), `ReservationsPage.jsx` (3,447), `DeliveriesPage.jsx` (2,761), `ReportsPage.jsx` (1,684). Still large: `order.service.js` 2,584, `order.repository.js` 2,423, `bill.repository.js` 2,288, `PosPage.jsx` 2,760 (one 2,600-line component; needs a real refactor, not a move), `TimeClockPage.jsx` 2,440, `InventoryInsightsPage.jsx` 2,408, `KitchenDisplayPage.jsx` 2,194, `index.css` 3,137 (counts of 7 October; on 22 October `order.service.js` 2,618, `order.repository.js` 2,447, `bill.repository.js` 2,290, `PosPage.jsx` 3,002, `TimeClockPage.jsx` 2,434, `InventoryInsightsPage.jsx` 2,522, `KitchenDisplayPage.jsx` 2,245, and `index.css`, now `base.css` in `packages/ui`, 3,275). | Slow to read and risky to change. |
| **Migrations** | 133 files (22 October 2026), many of them fixes of earlier ones; a fresh database replays all of them. | Fine for now; a baseline before go-live makes new installs simple. |
| **Commits** | 9 commits on `main` (22 October 2026); the apps-and-packages move (plan G), the clean copies (`make-real-copies.js`, `businessClone.service.js`), migration `1791950412000_document-list-indexes` and a brands fix are in the working tree until they are committed. | Commit each plan as its own step. |
| **Live updates** | Screens poll; the outbox is written but not read. | See §6.8. |
| **Dashboard cache** | Per API process (`utils/dashboardCache.js`). | Several API processes need a shared cache or sticky sessions. |

### 7.2 Target structure

*Reached for the folders (plan B, 7 October 2026): `modules/` on both sides,
with the restaurant areas under `modules/restaurant/` and the business core
and types under `modules/business/`. Not done: a `core/` folder (config,
middlewares and utils stay at the top of `src/`) and the split of the business
core into catalog / contacts / documents / stock modules (it is one
`business/core` module today, because `business.service.js` serves all of
them). The web apps and packages were reached on 21 October 2026 (plan G);
the workspaces folder and the platform admin app below are still to come.
The data part below is plans D–F.*

```
backend/src/
  core/                 config, db (pool, transaction helper, guard), http (AppError, errorHandler,
                        validate), auth (authenticate, access), audit, events
  modules/
    platform/           catalogue, businesses, memberships, roles      {routes,controllers,services,repositories,tests}
    catalog/  contacts/  documents/  stock/  appointments/  receivables/
    restaurant/         menu/, floor/, orders/, kitchen/, billing/, cash/, guests/, stock/, staff/, reports/
    retail/  wholesale/  fashion/  electronics/  salon/  weight/  health/
    tasks/              (already its own module, shared by both worlds)
  notifications/        unchanged (providers per module)
  app.js  server.js

apps/business-web/src/        the staff app
  core/                 api.js, queryClient, auth and business context, ProtectedRoute, layout
  components/           shared UI, DataGrid (unchanged)
  workspaces/           what each role sees, assembled from the modules: admin, pos, kitchen,
                        collection, captain, clinic, lab
  modules/
    business/           core screens (overview, settings, catalogue, documents, stock …)
    restaurant/         pos/, menu/, kitchen/, reports/, …
    retail/  wholesale/  fashion/  electronics/  salon/  weight/  health/  tasks/
  styles/               sheets several modules use; each module imports its own stylesheet
apps/customer-web/src/        the guests' site: table-order/, online-order/, booking/, later shop/,
                              appointments/, account/
apps/platform-admin/          later: the platform console, when it ships on its own
packages/ui, packages/shared  what the apps share: the look and components, formatting and rules
```

And in the data: the restaurant on the shared core with `restaurant_*`
extension tables (modifiers, recipes, tables, KOTs, kitchen stations, captain
sections…); one identity and one role system per business; a migration
baseline.

### 7.3 Migration plans (ordered, low-risk, manual)

Do the plans in this order: **A** (safety) → **B** (folders, no behaviour
change) → **C** (split files) → **D** (identity) → **E** (restaurant on the
core) → **F** (baseline, just before go-live). Each step is one commit. After
each step: `npm test`, `npm run test:integration`, `npm run lint` + `npm run build`,
`test:browser` when screens changed, and a walk through the screens you touched.
**G** (apps and packages, below F) was done on 21 October 2026, between C and
D; it changes no data. Its behaviour changes (the guest pages on their own
address, CORS for `/api/public`, the old-link redirect, the build guards, the
planned pages) are listed under G.

**A. Safety first**

1. Commit the current state as it is (several commits by area if you like).
2. `npm run db:backup -- --verify` (it copies `uploads/` and `private_uploads/` too).
3. Push to a private remote.

**B. Group code by module (no behaviour change)** — **done 7 October 2026**

What was done: every file in `routes/`, `controllers/`, `services/` and
`repositories/` moved to `backend/src/modules/<module>/<same folder>/` (only
`routes/index.js` stayed, as the mount point); every page, and every service
and stylesheet that one module uses, moved to
`frontend/src/modules/<module>/{pages,services,styles}/`; every import was
rewritten by script in the same run. `SOURCE_DIRS` in `authorize.js` now
reads `routes/`, `middlewares/` and `modules/` at any depth (checked: the
same 76 permission codes are flagged, from the same quoted codes as before).
Checked after the move: the list of 753 routes (method, path, middleware and
permission) is identical, unit and integration suites pass, lint, build and the
browser checks pass, every screen loads at 1440 and 390 px. Departures from the
steps below: no `core/` folder (shared code stays at the top of `src/`), the
business core is one module, and the integration tests stay in `tests/`.
The original steps, for reference:


1. Create `backend/src/core/` and move `config/`, `utils/`, `middlewares/`
   there with `git mv`; fix `require` paths; tests.
2. Create `backend/src/modules/<module>/` for **one small module first**
   (e.g. `logbook`): move `logbook.routes.js`, `logbook.controller.js`,
   `logbook.service.js`, `logbook.repository.js` into
   `{routes,controllers,services,repositories}/`; update `routes/index.js`;
   tests. The `authorize.isEnforced` source scan reads fixed folders
   (`routes`, `controllers`, `services`, `middlewares`, `repositories`) —
   **update `SOURCE_DIRS` in `authorize.js` to walk `modules/` too**, or the
   role editor will mark moved permissions as "not checked".
3. Repeat module by module (restaurant areas, then `business*` files into
   `platform`, `catalog`, `documents`, `stock`, then each type). Move each
   module's integration test into its folder only after all are moved, and
   change the `test:integration` glob once.
4. Frontend: the same, one area at a time — `pages/<area>` and its
   `services/*.service.js` and `styles/<area>.css` into
   `src/modules/<area>/`; update lazy imports in `App.jsx` /
   `BusinessAdminRoutes.jsx`; `npm run build` catches every broken path.
5. Last: delete the empty old folders.

**C. Split the large report files** — **done 7 October 2026**

What was done: `report.service.js`, `report.repository.js` and
`bill.service.js` became folders of family files behind index files with the
same names and the same exports (§5.2); `ReportsPage.jsx`,
`ReservationsPage.jsx` and `DeliveriesPage.jsx` keep the page and their tabs,
panels and dialogs are files beside them. Each split was done by a script that
moves whole top-level declarations and writes the imports, so no function body
changed. `PosPage.jsx` is one 2,600-line component and was left for a real
refactor. The original steps, for reference:


1. Split `report.service.js` by report family (sales, tax / GST, staff,
   stock / consumption, expenses, theft, day-end, dashboard) into
   `modules/restaurant/reports/services/<family>.js`, re-exported from one
   index so the controller does not change. One family per commit.
2. Same for `report.repository.js`, keeping shared SQL fragments (the trading
   day, outlet filters, `STOCK_USED`) in one `sql.js`.
3. Tests after each family: `reports-dayend`, `branch-reports`,
   `dashboard-panels` and the restaurant suites cover them.
4. Then the big pages: move each tab / panel of `ReservationsPage`,
   `DeliveriesPage`, `PosPage` into its own file; browser checks.

**D. One identity and one role system per business**

1. Make sure every restaurant has its `businesses` row (the feature-switch
   migration's `restaurant_business_id()` creates it when missing) and every
   active restaurant user a membership (a migration).
2. Add the restaurant's permission codes to `business_permissions` under
   restaurant modules (`orders`, `billing`, `kitchen` …, each a
   `platform_modules` row applying to `restaurant`), with a mapping table from
   the old code to the new.
3. Give each restaurant business role copies of its restaurant roles (Admin →
   Owner, Manager, Cashier, Captain, Kitchen, Collection display, and each
   custom role) with the mapped permissions; set each membership's role from
   `user_roles`. Test: for every user, old permission set = new permission set
   (write this as a test that loops over the demo data).
4. **Shadow mode:** `authenticate` computes both sets and logs any difference;
   run the full test suite and a day of demo use.
5. Switch `req.user.permissions` to the membership-based set. Approvals, PIN
   sign-in, outlet pinning and two-step roles move to membership / business
   scope (outlet pin → membership location: `business_memberships.location_id`
   exists already). Tests: `sweep-access`, `access-backoffice-fixes`,
   approvals.
6. One role editor (the business one) for everyone; the restaurant Roles page
   redirects to it.
7. A release later: drop `users.restaurant_id/outlet_id` use, then the
   `roles`, `user_roles`, `role_permissions`, `permissions` tables (new
   migration, after a backup). The platform super admin becomes a platform
   role (a small `platform_staff` table) rather than a user without a
   restaurant.

**E. The restaurant on the shared core**

Principle: **dual-write, compare, switch reads, retire** — one area at a time,
the old tables kept until reports agree.

1. Feature switches — done (§4.2): the module gate is already the platform's.
2. **Locations:** link each `outlets` row to a `business_locations` row
   (`outlets.location_id`), kept in step in the same transaction.
3. **Events:** write `business_events` (bill raised, payment, refund, credit
   note, stock consumed, purchase received) inside the restaurant's own
   transactions, using the bridged `business_id`. Purely additive. Move
   `logAction` rows into the same transactions as well.
4. **Master data:** `customers` → `business_contacts` (kind customer),
   `suppliers` → `business_contacts` (kind supplier), `units` →
   `business_units`, `tax_rates` → `business_tax_rates`. Add a link column on
   each old table, back-fill, write both on every change, then read from the
   core. Tests: guest book, loyalty, purchasing suites.
5. **Menu:** `products` / `product_variants` → `catalog_products` /
   `catalog_skus` (kind goods or service); restaurant-only parts become
   extension tables (`restaurant_menu_items` for kitchen station, course,
   availability; modifiers, recipes and combos keep their tables, re-keyed to
   the SKU).
6. **Stock:** `inventory_items` → SKUs; `stock_transactions` /
   `inventory_batches` → `business_stock_lots` / `business_stock_movements`.
   Dual-write, then compare closing stock per item per store every day of the
   demo month; switch when equal.
7. **Money:** bills → `business_documents` (kind sale) with a
   `restaurant_bill_details` extension (order, table, service charge,
   delivery charge, covers, tips); payments → `business_payments`; credit
   notes → `business_returns`; numbering → `business_number_series`. This is
   the largest step: dual-write for a full trading period, compare every
   report (day end, GST, sales, P&L) to the paisa, then switch reads report by
   report.
8. **Retire** the old tables a release after the last read moves (new
   migration, after a backup).

**F. Migration baseline before go-live**

1. When no more schema changes are expected, on a fresh database run all
   migrations, then `pg_dump --schema-only` plus the catalogue data
   (`business_types`, `platform_*`, `business_permissions`, role templates,
   restaurant `permissions` / system roles) into one
   `migrations/<new timestamp>_baseline.sql`.
2. Move the old files to `migrations/archive/` (out of the runner's folder).
3. Fresh installs run the baseline. For an **existing** database (yours),
   insert the baseline's name into `pgmigrations` by hand once, after a
   backup, so it is not run again.
4. Test: a database built from the baseline and one built from the old files
   produce the same `pg_dump --schema-only` (diff them); the integration suite
   passes on the baseline.

**G. Apps and packages (npm workspaces)** — **done 21 October 2026**

What was done:
- **Workspace root.** The root `package.json` became an npm workspace root
  (`apps/*`, `packages/*`). The backend keeps its own install and lockfile.
- **Staff app.** `frontend/` moved to `apps/business-web/` with `git mv`, so
  history is kept.
- **Guests' site.** The guest pages (QR table ordering, online ordering,
  booking) and the files only they use moved to a new app,
  `apps/customer-web/` (port 5174). The online ordering service was split
  into its guest half and its staff half.
- **Shared packages.** What both apps use moved unchanged into two packages.
  A script rewrote 340 files' imports to `@bmp/ui/…` and `@bmp/shared/…`.
  - `packages/ui`: the five global stylesheets, `Icon` and the menu choice
    components.
  - `packages/shared`: formatting, dates and the menu choice rules.
- **Versions.** The root lockfile started from the old frontend one: all 132
  package versions stayed the same, and only the workspace links were added.
- **Guest links.** Guest links and QR codes use `VITE_CUSTOMER_WEB_URL`
  (`services/customerWeb.js`) when a restaurant has no guest web address of
  its own. Old guest links on the staff app are sent on to the guests' site,
  and that redirect stays for good. When the app does the redirect, it
  clears the guest data the old pages kept in that browser. A server-side
  redirect (§6.9) skips that clean-up.
- **CORS.** The API answers the public guest calls (`/api/public`) from any
  address. `CORS_ORIGIN` lists only the staff app.
- **Development servers and builds.**
  - Each app's development server shows only its own folder, `packages/` and
    `node_modules`.
  - Each refuses to start or build without the addresses it needs. For the
    staff app that includes the guests' address, or `same-origin`.
- **Planned screens.** They got their addresses, with a page that says what
  is coming and what to use today:
  - on the staff app: `/captain`, `/clinic`, `/lab`;
  - on the guests' site: `/shop`, `/appointments`, `/account`, and a help
    page for any other address.

Checked after the move:
- Lint, and both builds, also as CI builds them.
- The Node tests of the apps and packages, and the backend's unit tests.
- A new guest browser suite, including a check that the shared look loads and
  that no guest request carries a staff login.
- The guests' pages are pixel-identical to the original code at 390 and
  1280 px, light and dark, compared at the same moment.
- The staff screens are identical but for the live clock.
- The guests' build carries no staff code (0.56 MB of files, against 4.8 MB).
- The backend's 549 integration tests.
- The staff browser suite (79 tests): one full run passed 75; the three that
  failed under load passed when run again on their own, and the platform-console
  part is skipped without a super-admin login. The new test of the old-link
  redirect (the 80th) passes.

---

## 8. Moving to a new repository

**Copy:**

```
README.md  .github/  docs/  package.json  package-lock.json  .oxlintrc.json  .gitignore
backend/   src/ migrations/ scripts/ tests/ package.json package-lock.json
           nodemon.json .env.example .gitignore
apps/      business-web/ and customer-web/: src/ tests/ index.html package.json vite.config.js
           playwright.config.js .env.example README.md (business-web also: public/ .gitignore)
packages/  ui/ shared/
```

**Do not copy:**

| Path | Why |
| --- | --- |
| `node_modules/` (root and backend) | Rebuilt by `npm install` / `npm ci` |
| `backend/.env`, `apps/*/.env` | Secrets; recreate from `.env.example` |
| `backend/.local/`, `apps/business-web/.local/` | Backups, demo passwords, logs, review screenshots |
| `backend/uploads/`, `backend/private_uploads/` | User data (menu images, bill attachments). Move them with the database, not with the code. |
| `apps/*/dist/` | Build output |
| `apps/*/test-results/`, `playwright-report/` | Test artifacts |

**Backend `.env`** (names only; values from `backend/.env.example`, never real
values in the repository):

| Required | Optional (defaults in `.env.example`) |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `JWT_SECRET` | `NODE_ENV`, `PORT`, `MULTI_BUSINESS_DEVELOPMENT`, `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`, `DB_POOL_GUARD`, `JWT_EXPIRES_IN`, `TWO_FACTOR_KEY`, `LOGIN_ATTEMPT_LIMIT`, `ACCOUNT_LOCK_ATTEMPTS`, `ACCOUNT_LOCK_WINDOW_MINUTES`, `ACCOUNT_LOCK_MINUTES`, `APPROVAL_TTL_SECONDS`, `CORS_ORIGIN`, `TRUST_PROXY`; scripts only: `PG_BIN`, `SEED_RESTAURANT_CODE`, `RESTAURANT_ID`, `DEMO_OWNER_ID`; not in `.env.example`: `NOTIFICATIONS_CACHE` (`off` keeps no bell answers; under `NODE_ENV=test` they are kept only with `on`) |

Web apps' `.env`: `VITE_API_BASE_URL` (both), `VITE_CUSTOMER_WEB_URL` (the staff app). **Keep `TWO_FACTOR_KEY` (or the
`JWT_SECRET` it falls back to) when you move a database that has two-step
sign-in in use**, or every authenticator app stops working.

**`.gitignore` check.** The root `.gitignore` and the backend's and staff
app's own together cover `node_modules`, `.env`, `uploads/`,
`private_uploads/`, `.local/`, logs, `dist`, `test-results/` and
`playwright-report/`. Before the first commit in the new repository run
`git status --ignored` and `git add -n .` and check that none of the "do not
copy" paths appear.

**The database:**

- *Fresh:* create an empty database, `npm run migrate:up`,
  `npm run restaurant:create`, then the demo scripts (§6.9).
- *Your data:* restore the latest verified backup (§6.10) into the new
  server, copy `uploads/` and `private_uploads/`, run `npm run migrate:up`.

**The folder rename.** The repository folder has been renamed from
`restaurant-management-platform` to `business-management-platform` (the
GitHub remote `origin` has the new name). Nothing in the code depends on the
folder name (paths are relative to each file; package names are `backend`,
`business-management-platform` and `@bmp/…`). On a machine with an old copy:
run `npm install` at the root and in `backend` if any tool cached the old
path, and update shortcuts or scripts outside the repository that point at
the old path. The browser keeps its session keys (`rmp_token`, `rmp_outlet`)
— leave those names alone, or everyone is signed out once.

**Renaming the database later (optional).** Back up first
(`npm run db:backup -- --verify`). Stop the API and every tool connected to
it, then as a superuser:
`ALTER DATABASE restaurant_management_db RENAME TO business_management_db;`
set `DB_NAME=business_management_db` in `backend/.env`, start the API. The
CI workflow uses its own database and does not change.

---

## 9. Roadmap

The detailed list, with what each item needs (a decision, an account, a
device, or only code), is [REMAINING_BACKLOG.md](REMAINING_BACKLOG.md). In
order:

1. **Restaurant onto the shared core** — feature switches (done, §4.2), then
   locations, events, master data, menu, stock and money (§7.3 E).
2. **One identity** — one role system per business, approvals and PINs on
   memberships (§7.3 D).
3. **Module folders, split files, apps and packages** — done: §7.3 B and C
   (7 October 2026) and G (21 October 2026). Still to come when their first
   piece is built: the staff app's `workspaces/` folder and the backend's
   `integrations/` and `jobs/` ([CODE_STRUCTURE.md](CODE_STRUCTURE.md) §9).
4. **Live updates** — the outbox publisher and server-sent events / WebSocket
   to the screens; then move the restaurant's polling screens to push.
5. **POS and the other apps** — offline-capable POS, captain app, kitchen
   display app, the guests' site's shop, appointment and account pages (their
   addresses already answer), wholesale salesperson app.
6. **Platform admin and subscriptions** — `platform_plans`,
   `platform_plan_modules`, `business_subscriptions` (shape already fixed in
   the data model); the platform admin as its own app (the console in the
   staff app already covers every type); plans write `business_capabilities`.
7. **Outside integrations** — payment gateway / UPI confirmation, Swiggy /
   Zomato, SMS / WhatsApp / email, password reset — all through the outbox.
8. **Hardware** — silent thermal printing, cash-drawer kick, weighing-scale
   and scanner bridges.
9. **Pharmacy and clinics & labs** — built with standard Indian practice
   (round 2, 8 October 2026; doctors' fees, tokens, report versions and QC in
   round 3). The owner reviews those rules with a pharmacist, a doctor and a
   legal adviser before going live.
10. **Go-live** — migration baseline (§7.3 F), hosting with HTTPS,
    production `.env`, off-machine backups, the pilot checklist.
