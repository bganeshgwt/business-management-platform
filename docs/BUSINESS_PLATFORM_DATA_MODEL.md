# Business Management Platform — data model

Updated 22 October 2026 (first written for Phase 1, 6 October 2026; each later
phase and round has its own dated section below, through migration
`1791950412000`). This is the database the Business Admin and every later
application (POS, Captain, Kitchen display, Customer website, Platform admin)
stand on. Read [NAMING.md](NAMING.md) for the words used here,
[MULTI_BUSINESS_ADMIN.md (Business Admin)](MULTI_BUSINESS_ADMIN.md) for what the admin does with it,
and [DATABASE.md](DATABASE.md) for every table's columns.

## The five layers

```
 1 Platform          platform_modules ─┬─ platform_module_business_types ── business_types
                                       └─ platform_module_dependencies
                     business_permissions · business_role_templates (+ _permissions)
                     (later: platform_plans, platform_plan_modules, business_subscriptions)
 2 Identity & access users ── business_memberships ── business_roles ── business_role_permissions
 3 Business (tenant) businesses ── business_settings · business_tax_rates · business_number_series
                     business_capabilities · business_locations · business_payment_methods
                     business_departments
 4 Shared core       catalog_categories ── catalog_products ── catalog_skus ── catalog_sku_units
                     catalog_kit_components · business_sku_location_prices
                     business_units · business_contacts · business_price_rules
                     business_documents (+ lines, payments, returns, refunds)
                     business_supplier_payments
                     business_collections (+ cheques, refunds)
                     business_exchanges (+ policies, vouchers, voucher uses)
                     business_stock_lots · business_stock_movements · business_stock_adjustments
                     business_stock_transfers (+ lines) · business_stock_counts (+ lines)
                     business_resources · business_appointments
                     business_expenses · business_cash_checks · business_counter_shifts
 5 Type extensions   retail_* · books_* · wholesale_* · fashion_* · electronics_* · salon_* · weight_*
                     pharmacy_* · health_* · lab_*
 Tasks               business_task* · business_issues · business_project* · platform_task_categories
 Cross-cutting       business_audit (who did what) · business_events (outbox)
```

The restaurant module keeps its own tables (`restaurants`, `restaurant_*`,
`orders`, `bills`, `menu_*`, …) untouched. A restaurant appears in the
platform as one row of `businesses` with `legacy_restaurant_id` pointing at it;
nothing in the restaurant tables was renamed or moved. Through that row a
restaurant's feature switches are `business_capabilities` rows
([Restaurant features](#restaurant-features)) and its tasks, issues and
projects live in the shared tables ([Tasks, issues & projects](#tasks-issues--projects-migration-1791620000000-7-oct-2026)).

## Rules every table follows

- **Every row belongs to one business.** Business-owned tables carry
  `business_id NOT NULL`, and every link between two business rows is a
  **composite foreign key** `(business_id, x_id) → x(business_id, id)`. A sale
  can therefore never point at another business's customer, lot, location,
  role or tax slab — the database refuses it, whatever the code does. Each such
  table has `UNIQUE (business_id, id)` for the composite keys to reference.
- **Money** is `NUMERIC(…,2)` and is worked out in integer paise (BigInt where
  quantities multiply). **Quantities** are `NUMERIC(16,3)`. Costs per stock
  unit are `NUMERIC(14,4)`.
- **Requests are idempotent.** Postings carry a `request_key UUID` unique per
  business, plus a hash of the request; the same key with different content
  is a conflict.
- **Posted lines are snapshots.** Name, unit, price, tax rate, round-off and
  tax mode are copied onto the document; changing a product never rewrites a bill.
- **Audit and events are written inside the mutation's own transaction.**
- **Rules that hold across rows are triggers**, raised with SQL state 23514
  and a sentence a person can read (the API turns them into a 409).

## 1. Platform

| Table | What it holds |
|---|---|
| `platform_modules` | The module catalogue: `code` (the capability string), name, description, `kind` = `core` (always on: settings, access, reports, audit) or `optional`. |
| `platform_module_business_types` | Which modules a business type *may* enable, and which it gets by default (`enabled_by_default`). Applicability is wider than the defaults: a salon may switch on stock transfers, but does not start with them. Since round 3 a module can also be `recommended` for a type, with a note saying why (Settings › Business tools). |
| `platform_module_dependencies` | A module that needs another (purchasing needs inventory and contacts). |
| `business_permissions` | The permission catalogue: `<module>.<action>`, action ∈ view / create / edit / approve / cancel / refund / export / print, and later also discount (pro pass), assign, review and manage (tasks), view_clinical and edit_clinical (round 2). Only meaningful pairs exist: 46 in Phase 1, 93 after the Phase 2 migrations, 135 on 22 October 2026. |
| `business_role_templates` (+ `_permissions`) | The standard roles: Owner (full access), Manager, Cashier / sales, Stock keeper, Accountant, Viewer. Since round 2 a template may belong to some business types (`business_types`, NULL = every type): Pharmacist (pharmacy), Doctor, Lab technician and Pathologist (clinic). |

`business_capabilities.capability` is now a foreign key to `platform_modules`
(the old hard-coded CHECK list is gone). A constraint trigger
(`business_capabilities_enforce`) refuses: a core module stored per business,
a module that does not apply to the business type, a module whose dependency
is off, and switching off a module another enabled module needs. A business's
type cannot be changed after creation (`businesses_type_is_fixed`), because
it decides what its records mean.

### Commercial plans — decided: a documented plan, no empty tables yet

Nothing commercial is built in Phase 1. Instead of empty tables whose columns
would be guesses, the shape is fixed here so adding it later is purely additive:

```
platform_plans            (code PK, name, billing_period, price_paise, active)
platform_plan_modules     (plan_code → platform_plans, module_code → platform_modules, limits JSONB)
business_subscriptions    (id, business_id → businesses, plan_code, starts_on, ends_on, status, …)
business_capabilities     + source TEXT ('plan' | 'owner' | 'type_default'), + subscription_id (nullable FK)
```

A subscription will only *write* `business_capabilities` rows (and read
limits); every check in the server already reads `business_capabilities`, so
no query, screen or test changes when plans arrive. Until then the owner
switches modules on and off within what the type allows (Settings › Business
tools, permission `settings.edit`; for a restaurant, its own Features screen —
see [Restaurant features](#restaurant-features)).

### Restaurant features

A restaurant is one business of type `restaurant` (`legacy_restaurant_id`),
and until 1791470000000 it was one module, `restaurant`, with everything inside
always on. The parts a restaurant may not want are now **optional modules in
this same catalogue**, grouped by `platform_modules.feature_group`: fourteen
from 1791470000000 and two from 21 October (pre-orders and brands), which
apply only to type `restaurant` and each need `restaurant`, and the three
tasks modules, which every type has:

| Group | Codes | Default |
|---|---|---|
| Guests | `guests`; `guest_loyalty` (needs `guests`) | on; loyalty **off** |
| Service | `reservations`, `qr_ordering`, `online_ordering` (needs `guests`), `deliveries`, `kitchen_display`, `captain_sections` | on |
| Service | `preorders` (needs `guests`; `1791950410000`), `brands` (`1791950411000`) | **off** (the café and bakery formats switch on pre-orders, the cloud kitchen brands) |
| Money | `tips`, `advances`, `cash_drawers`, `coupons` | on |
| Back office | `stock_recipes`, `staff_payroll` | on |
| Operations | `tasks`; `issues`, `projects` (need `tasks`; `1791620000000`) | on for a restaurant (`1791950402000`); off for every other type |

A restaurant's **format** is `restaurants.format` (restaurant, café, bakery or
cloud kitchen; `1791950410000_food-formats.sql`). Choosing one sets the POS's
order types and the one a new order starts on
(`service_settings.pos_order_types`, `default_order_type`), the token numbers
and these switches; the owner can change each afterwards. The same migration
adds `products.sold_by` (by the piece, or by weight with the price per kg),
the day-end "unsold" waste reason, and the pre-orders
(`restaurant_preorders` + `_items`: the guest, what and when, the message,
the advance in `customer_advances`, and the takeaway order it becomes on
collection). Brands are `restaurant_brands`, with `categories.brand_id`
(NULL = every brand's) and `orders.brand_id` (`1791950411000_kitchen-brands.sql`).

Core, never switched: POS and orders, bills and payments, dues, menu, tables,
outlets, business day, expenses, log book, reports, users and roles, settings,
activity log.

- **One source of truth.** A restaurant's switch is its business's
  `business_capabilities` row, read through `restaurant_features(restaurant_id)`
  (a restaurant not yet linked to a business has the type defaults;
  `restaurant_business_id()` links it on its first switch). The restaurant's
  Features screen (Settings › Features) and the Business Admin's module
  switches for the restaurant business (`PUT /api/businesses/:id/modules/:code`)
  read and write the same rows, through the same service
  (`restaurantFeatures.service.js`: dependencies, refusing a switch that would
  strand money, the activity log).
- **Every existing restaurant got everything on**, loyalty as its old
  `restaurant_settings.loyalty_enabled` (dropped: the switch replaces it; the
  earn and redeem rules stay in `restaurant_settings`).
- **Enforced on the server.** `req.user.features` comes with the signed-in
  profile; `requireFeature(code)` refuses a switched-off feature's endpoints
  with 403 `{ reason: "feature_off", feature }`; the public QR, booking and
  online pages check the restaurant's features themselves; notification
  providers name their `feature` and are not asked while it is off.
- **Plans.** A later subscription plan sets these switches exactly as it sets
  any other module: `platform_plan_modules` lists restaurant feature codes like
  any module code, and a subscription writes (or removes) the restaurant
  business's `business_capabilities` rows with `source = 'plan'`. Nothing in
  the restaurant reads anything but `restaurant_features()`, so no screen,
  query or test changes when plans arrive. A plan dropping a feature must go
  through the same money checks (an advance still held, rider cash not
  settled) before it removes the row.

## 2. Identity & access

- **One login per person.** `users` is unchanged; a person's access to a
  business is a row in `business_memberships (business_id, user_id)`. The same
  login can be a member of a restaurant and of a pharmacy.
- **Per-business roles.** `business_roles` holds each business's own copy of
  the six templates (`template_code`; a pharmacy and a clinic also of their
  type's own) plus roles the business makes itself
  (`template_code` NULL). Copies, not shared rows: one business editing its
  "Manager" never changes another's. Exactly one role per business has
  `full_access` (the Owner); it holds no permission rows and always has every
  permission, including ones added by later migrations.
- `business_memberships.role_id` → `business_roles(business_id, id)`
  (composite: a membership can only hold its own business's role). The old
  `role` text column was dropped after mapping owner → Owner, manager →
  Manager, viewer → Viewer. The templates were written so nobody gained or lost
  anything: Manager = everything except staff access; Viewer = every view and
  export. `last_opened_at` remembers the business a person last opened;
  `location_id` (12 Oct) ties a person to one location and `department_id`
  (16 Oct) to one department (both NULL = all; see round 3 below).
- **Two checks, both on the server, on every request:** the permission's
  module must be enabled for the business (`business_capabilities`), and the
  person's role must hold the permission. Anti-escalation rules in the service:
  nobody can hand out the Owner role, change the owner's membership or their
  own; a person with `access.edit` can only give roles and permissions they
  hold themselves.

## 3. Business (tenant)

| Table | Notes |
|---|---|
| `business_settings` | One row per business: legal and display name, GSTIN (pattern-checked in SQL, check-character validated by the API), address, GST state code (must match the GSTIN's first two digits), PIN, phone, email, logo path, `tax_mode` (exclusive / inclusive), `rounding` (none / nearest rupee), `fiscal_year_start_month` (April), invoice and receipt footers, date format. Later columns: the [pro pass](#shared-commerce-pro-pass-migration-1791540000000-7-oct-2026), [round 2](#round-2-8-oct-2026) and [round 3](#round-3-1221-oct-2026). |
| `business_tax_rates` | Named GST slabs, seeded with nil, 5 %, 18 % (default) and 40 % (the slabs since 22 Sep 2025). A slab's `rate` can never change (trigger): add a new slab instead, so old invoices keep meaning. One default per business. SKUs point at a slab (`catalog_skus.tax_rate_id`) and keep `tax_rate` as the rate charged. |
| `business_number_series` | Per business + location + document kind + fiscal year: `prefix`, `next_number`, `padding`. Prefixes are unique in a business and must not end in a digit, so a number can only come from one series; prefix + digits ≤ 16 characters (the GST limit). A number is taken with `UPDATE … SET next_number = next_number + 1 … RETURNING` inside the posting transaction: concurrent postings queue on the row, a failed posting gives its number back, and a trigger forbids moving `next_number` backwards or changing a series once used. Kinds in Phase 1: sale (SI), purchase (PR), sales_return (CN), purchase_return (DN), stock_transfer (ST), stock_count (SC); Phase 2 adds sales_order (SO), collection (RC), repair_job (RJ) and processing (CP) (ten in all); the pro pass supplier_payment (SP) and round 2 purchase_order (PO) and delivery_challan (DC): thirteen today. A series is created automatically on first use (`SI/2627/0001`), or set up in advance by the owner. |

`business_documents` gained `series_id`, `tax_mode`, `round_off` (the total
now satisfies `total = subtotal + tax + round_off`) and `due_on` (from the
contact's credit days). `business_returns` gained `return_no`, `series_id`
and `round_off`: each return carries its share of the sale's round-off, in
proportion to the value returned so far (cumulative, so the shares add up to
the whole round-off when everything is back). Returns can therefore never add
up to more than the rounded total, and a refund is capped both by the credit
left and by what was actually paid less earlier refunds.

**Fixed after documents exist:** the financial-year start month cannot change
once the business has a number series (documents would land in the wrong
year's series). A newly created series starts after the highest number already
used with its prefix.

**Provisioning.** An `AFTER INSERT` trigger on `businesses` gives every new
business its roles, settings row, GST slabs, units and its type's default
modules, whichever code path created it (demo set-up, linking a restaurant, a
script, the platform console). Existing businesses were back-filled by the
same functions (`business_seed_roles/settings/tax_rates/units`). Later
triggers on the same insert add the five payment methods to every type but
the restaurant (`businesses_default_payment_methods`, 12 Oct) and four
financiers to an electronics shop (`businesses_default_financiers`, round 2);
`business_seed_roles` gives a pharmacy and a clinic their own role templates
too (round 2).

## 4. Shared core

- **Categories** — `catalog_categories` is a tree per business (composite
  self-reference, at most five levels, no loops — trigger; sibling names unique,
  case-insensitive). `catalog_products.category_id` points at it. The old
  free-text `category` column stays readable; each distinct text was turned
  into a top-level category and linked.
- **Units** — `business_units` per business: `kind` (count, weight, volume,
  length, time, service), `decimals` (count units are whole), optional
  conversion to a base unit of the same kind (`g` → `kg` × 0.001). The SKU's
  `unit` is now a foreign key to its business's units (the fixed list became
  data; every old value was seeded). **Pack sizes** — `catalog_sku_units`
  says how many stock units one pack holds for one SKU (1 strip = 10 tablets,
  1 box = 24). A document line entered in a pack keeps what was typed
  (`entered_unit`, `entered_quantity`, `entered_unit_price`, `unit_factor` —
  all or none) next to the stock-unit quantity it became; the conversion must
  be exact or the line is refused.
- **Contacts** gained `gstin` (unique per business and kind), `credit_limit`
  (NULL = no limit), `credit_days`, `opening_balance` (+ the date it was true).
  A customer's balance = opening balance + Σ (total − returns − payments +
  refunds). A sale that would take a customer over their limit is refused
  unless enough is collected with it (a sale can now carry a payment).
- **Stock transfers** — `business_stock_transfers` (+ lines). Dispatch takes
  the stock off the sending lot (movement −), the goods are *in transit*, and
  receiving adds them to the same batch at the destination (movement +,
  weighted cost, same expiry; a serial cannot be in stock twice). Cancelling
  puts them back into the very lots they left. Status, who closed it and why
  are constrained together.
- **Stock counts** — `business_stock_counts` (+ lines). A sheet lists the lots
  at one location (one open count per location — partial unique index);
  counted quantities are entered over time; approval compares each count with
  the stock *at that moment* (so sales made during the count are not counted
  twice) and posts every difference as a reasoned `business_stock_adjustments`
  row linked to the count (`count_id`).
- **The ledger** — `business_stock_movements` now has exactly one source:
  document, adjustment or transfer (`num_nonnulls(…) = 1`; a return is a
  document movement that also names the return). For every lot, the sum of its
  movements equals its quantity; the tests check this after transfers and counts.

## 5. Type extensions (Phase 2+ convention)

Industry-specific data goes in tables named `<type>_*` (for example
`pharmacy_prescriptions`, `salon_plans`, `electronics_warranties`; a
clinic's are `health_*` and `lab_*`, built in round 2 with consent and
clinical access rules). Each one:

- carries `business_id BIGINT NOT NULL` and composite foreign keys to the
  core rows it hangs off (`(business_id, sku_id) → catalog_skus`,
  `(business_id, document_id) → business_documents`, …);
- is enabled by a `platform_modules` row of kind `optional` that applies to
  that type, so capability checks and plans work unchanged;
- never adds columns to core tables for one type's sake (descriptive
  attributes may use `catalog_skus.attributes`, but money, quantities,
  relationships and anything filtered on are typed columns).

## Cross-cutting: the event outbox

`business_events (business_id, kind, entity_type, entity_id, payload,
actor_id, created_at, published_at)` gets one row for every committed change to
money, stock or appointments, **in the same transaction** as the change:
`sale.posted`, `purchase.posted`, `payment.recorded`, `sale.returned`,
`purchase.returned`, `sale.refunded`, `purchase.refunded`, `stock.adjusted`,
`stock_transfer.dispatched` / `received` / `cancelled`, `stock_count.posted`,
`appointment.booked` / `completed` / `cancelled` / `no_show`. If the change
rolls back, so does its event; if the event cannot be written, the change
fails. Nothing consumes the outbox yet: a later worker will read unpublished
rows in id order (partial index `business_events_unpublished`), deliver them
(live screens, webhooks, accounting exports) and stamp `published_at`. A
trigger allows only that one stamp, once; unpublished events cannot be
deleted. Every consumer must filter by `business_id`.

## Migrations (Phase 1)

| File | Layer |
|---|---|
| `1791300000000_platform-module-catalogue.sql` | Platform modules, applicability, dependencies; capability FK and trigger; business type fixed |
| `1791300000001_business-roles-and-permissions.sql` | Permission catalogue, role templates, business roles, memberships → roles |
| `1791300000002_business-settings-tax-rates-number-series.sql` | Settings, GST slabs, number series, round-off and return numbers |
| `1791300000003_catalog-categories-units-and-credit-terms.sql` | Category tree, units, pack sizes, entered-unit lines, contact credit terms |
| `1791300000004_stock-transfers-and-counts.sql` | Transfers, counts, the ledger's single-source rule |
| `1791300000005_business-events-and-provisioning.sql` | Event outbox, provisioning trigger |

The Down sections were run (down then up, inside a transaction that was
rolled back) on the test database, but they only work on a database whose new
tables hold no real data: they drop tables and columns, and some refuse when
rows exist (for example a SKU stocked in a unit outside the old fixed list).
They are not a rollback for a live database. **The real rollback is restoring
the verified backup taken before the migrations were applied.**

Later fixes go in new files (from `1791350000000`); the six files above are
applied to the owner's database and are never edited.

| File | Purpose |
|---|---|
| `1791350000000_stock-count-request-hash.sql` | Stores a hash of a count's request, so a reused request key with different content is refused (409) like documents |

## Shared receivables — customer credit, collections, outstanding (Phase 2, T1 + T2)

Retail udhaar (T1) and wholesale outstanding (T2) are **one model**, built in
T2's first migration (`1791410000000_shared-receivables.sql`) so both jobs use
the same rows. Nothing here is type-specific; type extras hang off it.

| Table / column | What it holds |
|---|---|
| `platform_modules` `receivables` | "Collections & outstanding" (optional; applies to every type that sells goods; default on for wholesale and grocery). Needs `sales` and `contacts`. Permissions `receivables.view / create / export / print`. |
| `business_collections` | One receipt of money from a customer: `collection_no` (series kind `collection`, prefix `RC`), location, customer (`contact_id`, must be a customer — trigger), `amount`, `method` (cash/card/upi/bank/cheque), `reference`, `notes`, request key + hash, who and when. Immutable once posted. |
| `business_payments.collection_id` | The money from a collection that settles a particular sale is an ordinary `business_payments` row pointing back at its collection, so every existing balance, refund and report rule keeps working. A trigger keeps Σ payments of a collection ≤ its amount. |
| Unallocated part | `amount − Σ allocated payments` is the customer's **advance / on-account credit**. It lowers the customer's balance (`contactBalanceSql`) and can later be applied to bills (FIFO, oldest first). |

Rules:
- **Customer balance** = opening balance + Σ per sale (total − returns −
  payments + refunds) − Σ unallocated collection money. The credit-limit check
  at a sale (and at a wholesale order) uses this figure.
- **Allocation** of a collection: either named bills with amounts, or
  automatic — oldest due first; never more than a bill's outstanding amount;
  the rest stays on account.
- **Ageing** (`0–30 / 31–60 / 61–90 / 90+` days since the bill date): every
  open item (opening balance on its date, each sale's outstanding amount on
  its date) minus the customer's unallocated credit applied to the oldest
  items first. *Overdue* = past the bill's `due_on` (from credit days).
- **Statement**: opening balance before the period, then sales (debit),
  returns/credit notes, payments and collections (credit), refunds (debit),
  with a running balance.
- Events: `collection.recorded`, `collection.applied`; audit rows in the same
  transaction.

T1 (udhaar) uses these tables, endpoints and screens (wording "Udhaar" for
grocery-type businesses via `businessNav.js` words); it should not add a second
ledger. T2 adds wholesale extras in `wholesale_*` tables (salesperson and route
on a collection: `wholesale_collection_details`).

Number-series kinds: T2 widens `business_number_series.document_kind` to add
`sales_order` (SO) and `collection` (RC). **Any later migration that changes
this CHECK must keep the full list**, including these two.

## Wholesale / FMCG (Phase 2, T2)

Module `sales_orders` ("Sales orders & dispatch", optional, wholesale only,
on by default; needs `sales`, `contacts`, `inventory`). Permissions
`sales_orders.view / create / edit / approve / cancel / export / print`:
*create* takes orders, *edit* sets up routes, beats and salespeople,
*approve* dispatches (raises the invoice and moves stock), *cancel* cancels an
order or closes its back-order. Template grants: Manager all; Cashier / sales
view, create, print; Stock keeper view, approve (dispatch), print;
Accountant view, export, print; Viewer view, export. Existing businesses'
role copies received the same grants.

| Table | What it holds |
|---|---|
| `wholesale_salespeople` | Field staff who take orders and collect money (name unique per business, case-insensitive). |
| `wholesale_routes` | A delivery run, optionally the godown (`location_id`) its van loads from. |
| `wholesale_beats` | Shops on a route visited on one ISO weekday (`visit_day`, NULL = any) by one salesperson. |
| `wholesale_customer_beats` | Each customer's one beat (PK business + contact; customer-only trigger). Orders and collections default to its route and salesperson. |
| `wholesale_orders` | A sales order: `order_no` (series kind `sales_order`, prefix `SO`), dispatching location, customer (+ name snapshot), salesperson / route / beat, `status` open → part_dispatched → dispatched, or closed (short) / cancelled with who, when and why; `tax_mode`, subtotal, tax, total at the order's prices; request key + hash. |
| `wholesale_order_lines` | Snapshot of each line: item label, stock unit, quantity in stock units, price per stock unit (4 places), tax rate, net, tax, price rule used, and what was typed in a pack (`entered_unit / _quantity / _unit_price`, `unit_factor` — all or none). Only `dispatched_quantity` and `closed_quantity` ever change (trigger), only upwards, and `dispatched + closed ≤ quantity`. Never deleted. |
| `wholesale_dispatches` | One dispatch = one tax invoice: `document_id` → the sale in `business_documents` (unique), vehicle number, notes, request key + hash. |
| `wholesale_dispatch_lines` | Which order line each invoice line came from (`document_line_id` unique) and the stock-unit quantity. One invoice line per batch picked. |
| `wholesale_collection_details` | Salesperson and route on a shared `business_collections` receipt. |
| `business_price_rules.unit_code` | Slab prices **per pack**: when set, the minimum and the price count that pack (composite FK to the item's `catalog_sku_units`, so the pack must exist for that item). The uniqueness of an active slab now includes the pack. |

Rules:
- **Pricing** (server, `businessPricing.js`, used by sales and orders): the
  customer's own rule beats a general one; a rule for the pack the line is
  entered in beats a per-unit rule; the highest slab reached prices every
  unit. A pack price is exact per pack; the per-unit price is derived (4
  places on the order line, 2 on the invoice line, which also keeps the exact
  pack price in `entered_unit_price`).
- **When stock moves: at dispatch, never at order.** A dispatch posts an
  ordinary sale through the core posting (`postDocument`), so number series,
  stock ledger, credit-limit check, `sale.posted` event and audit are the
  core's. Lines are picked **oldest expiry first** (expired batches never),
  or from the batches named; a line split over batches becomes one invoice
  line per batch; whole packs stay in packs on the invoice.
- **Invoice amounts** are the order's, allocated by quantity cumulatively
  (each dispatch takes `round(order amount × sent so far ÷ ordered) −
  already invoiced`). Each invoice line is complete in itself: its GST is
  worked out on its own value to the paisa, and its rate is its value per
  stock unit, to four places when two would not match
  (`business_document_lines.unit_price` is now `NUMERIC` without a fixed
  scale, checked to at most four places: every rate written with two places
  — all ordinary sales and purchases — still reads back with two, e.g.
  `120.00`; only such a dispatch line carries four, e.g. 50 × ₹7.3334 =
  ₹366.67). With prices before GST the
  shared amount is the taxable value, so the lines add up exactly to the
  order's net. GST rounded per line can then differ from the order's estimate
  by at most 1 paisa per extra invoice line the order was split into. With
  prices including GST the shared amount is the gross, so what the customer
  pays adds up exactly to the order. Document rounding to the rupee applies per invoice as
  usual. (T1's server-applied offers must not touch a dispatch: the core
  receives the prices in `fixed` and must use them as given.)
- **Credit limits** are checked twice: when the order is taken (balance +
  value of orders not yet sent + this order) and when each dispatch is
  invoiced (the core rule: balance + this invoice).
- **Back-order** = ordered − dispatched − closed, for orders still open or
  part-dispatched. Closing an order sets `closed_quantity` to what was left
  (status `closed` if something was sent, `cancelled` if nothing was).
- Locks: business row, then order, then order lines, then stock lots — the
  same order as every other posting. Repeating a request key returns the
  first result; the same key with different content is a 409.
- Events: `sales_order.placed`, `sales_order.dispatched` (with the invoice),
  `sales_order.closed`, `sales_order.cancelled`, plus the core
  `sale.posted` / `payment.recorded`, and `collection.recorded` /
  `collection.applied` from receivables.

| File | Purpose |
|---|---|
| `1791410000000_shared-receivables.sql` | `receivables` module and permissions, `business_collections`, `business_payments.collection_id` (+ rules trigger), cheque as a payment method, number-series kinds `sales_order` and `collection` |
| `1791410000001_wholesale-orders-dispatch-routes.sql` | `sales_orders` module and permissions, pack slabs on price rules, salespeople, routes, beats, customer beats, orders, order lines, dispatches, dispatch lines, collection details |
| `1791410000002_document-line-rate-precision.sql` | Invoice line rate may carry four places (unscaled NUMERIC, ≤ 4 places checked); two-place rates read back unchanged |

## Retail: grocery / kirana, supermarket, books & stationery (Phase 2, T1)

Retail uses the shared core for everything it can (catalogue, units, sales
documents, payments, stock, number series, shared receivables) and adds only
what a shop counter needs. Tables shared by the three retail types are named
`retail_*`; the books type alone has `books_*`.

**Modules** (`platform_modules`, both optional; both need `sales`, plus
`catalog` for offers and `contacts` for loyalty):

| Module | Applies to (default on) | Permissions |
|---|---|---|
| `offers` "Offers & discounts" | grocery, supermarket (on), books | `offers.view / create / edit` |
| `loyalty` "Loyalty points" | grocery, supermarket (on), books | `loyalty.view / create` (redeem on a bill) `/ edit` (rules, corrections) `/ export` |

Udhaar is the shared `receivables` module (T2's migration, on by default for
grocery); scale codes belong to the existing `weight` module and book details
to the existing `books` module. Template grants: Manager everything; Cashier
`offers.view`, `loyalty.view`, `loyalty.create`; Accountant and Viewer view
(+ export). Existing businesses' template roles received the same grants.

| Table | What it holds |
|---|---|
| `retail_offers` | One offer: `kind` (`item_percent`, `item_amount` — ₹ off each unit, `category_percent` — the category and its sub-categories, `bill_percent`, `bill_amount`, `buy_x_get_y` — buy X of an item, get Y more at `value` % off, 100 = free), the item or category it is for (composite FKs), `value`, `buy_quantity` / `get_quantity`, `min_bill_amount` (bill before any discount), `max_discount` (most per bill), `starts_on` / `ends_on`, `days_of_week` (ISO 1–7, NULL = every day), `starts_time` / `ends_time` (business time zone, may run past midnight), `active`. CHECKs tie each kind to the fields it needs. |
| `retail_sale_discounts` | Per sale line, what it was given and why: `source` (`offer` with `offer_id`, or `points`), `label` (the offer's name at the time — snapshot), `amount` in the document's price terms. **Append-only** (trigger). |
| `retail_loyalty_settings` | One row per business: spend `earn_per_amount` → earn `earn_points`; `point_value` (₹ a point is worth); `min_redeem_points`; `max_redeem_percent` of a bill; `active`. |
| `retail_loyalty_entries` | `earn` (whole points for a sale), `redeem` (negative, with the ₹ `value` it took off the bill), `adjust` (a reasoned correction with a request key), `reverse` (points a return took back, linked to the return, with `shortfall_points` / `shortfall_value` for points already spent). One earn and one redeem per sale, one reverse per return (partial unique indexes). A customer's points are the plain sum of their entries; a constraint trigger refuses any entry that would leave the sum below zero. **Append-only** (only `created_at` may be corrected, for demo set-up). |
| `retail_credit_reminders` | Udhaar reminders: customer, `channel` (WhatsApp, SMS, call, visit, other), the `balance` owed at the time (snapshot), `promised_on`, note, who and when. |
| `retail_scale_items` | A loose item's 5-digit code on the shop's label scale (`plu_code`, unique per business). A trigger allows it only on an item sold in a weight unit. |
| `books_titles` | Typed, searchable book details per SKU: `isbn` (always ISBN-13; CHECK with a real check-digit function `books_isbn_valid`, unique per business), `author`, `publisher`, `edition`, `language`, `published_year`. The migration copied the old free `isbn/author/publisher` attributes (an ISBN with a wrong check digit was left out; the free attribute stays). Saving details also mirrors ISBN/author/publisher back into `catalog_skus.attributes`. |

**How a sale is priced** (`modules/business/retail/services/businessOffers.js`, called from the core
posting — `business.service.js › postDocument` — so the Sales screen, the
Quick bill and any later POS get the same result):

1. Each line is priced by the core (list price, customer and slab prices,
   pack prices). Lines with fixed prices (a dispatched wholesale order) take
   no offers or points.
2. Offers running now (active, in their dates, today's weekday, inside their
   time window) whose minimum the bill reaches before any discount.
3. Each item gets **one** item offer — the one worth most to the customer.
   Lines of the same item are taken together (buy 2 get 1 works across scans).
   An offer's "most per bill" cap holds across every item it applies to.
4. Then **one** bill offer, the one worth most, on what is left.
5. Then loyalty points the customer redeems: at least the minimum, at most
   their balance and `max_redeem_percent` of what they pay; points are worth
   `point_value` off the **bill total** (converted to before-GST shares when
   prices exclude GST).
6. Discounts are spread over lines in proportion to their value with the
   rounding carried forward, so the shares add up to the paisa. They reduce
   the taxable value (a discount given at the time of sale), then GST is
   worked out on what is left, then the business's round-off.

The line's `net` and `tax` are the discounted figures; `unit_price ×
quantity − Σ retail_sale_discounts = taxable value` holds for every line
(exclusive prices; with inclusive prices the same holds for the gross). A
**quote** (`POST /retail/quote`) runs the very same posting code and returns
before anything is written. Offer amounts are in the same terms as the
selling prices (including GST when prices include it).

**Points.** A sale with a customer earns `floor(total ÷ earn_per_amount) ×
earn_points`. Redemption needs `loyalty.create`. **Points never go below
zero:** a return takes back, in its own transaction, the points its sale
earned in proportion to the value returned so far (cumulative, so a sale
returned in parts gives back exactly what it earned). They come off the
points the customer holds first. If the customer has already spent them, the
spent part is the *shortfall*: its value (points × point value) is recorded
on the `reverse` entry and **kept back from any refund on that sale**; where
no refund is paid out (an udhaar bill, an exchange that moves the credit to a
new bill) the shortfall is written off and stays visible in the points
history. Points spent on a bill are not given back when that bill is returned
— its refund is the discounted price. Sales, returns and corrections lock the
customer's row (sales and returns after the business row), so a return and a
redemption at the same moment queue; the database trigger is the backstop.
Before this rule (migration `1791400000001`) earned points were shrunk "on
read", which could show a negative balance; that migration recorded the
reversals for earlier returns the same way.

**Udhaar** is the shared receivables (balances, ageing, collections settling
the oldest bills first, advances, statements). Retail adds the reminder book;
a promised date already past while the customer still owes is shown as a
broken promise.

**Barcodes.** Items without a barcode can be given an in-store EAN-13
`200` + item number + check digit. A scale label is EAN-13 `21 PPPPP WWWWW C`
(scale code, grams, check digit): scanning it bills that item at that weight
(converted to the item's weight unit). Books scan by their ISBN-13.

Events (same transaction as the sale or correction): `loyalty.earned`,
`loyalty.redeemed`, `loyalty.adjusted`; audit: `offer.created / updated`,
`loyalty.rules_updated`, `loyalty.adjusted`, `udhaar.reminded`,
`catalog.barcodes_assigned`, `catalog.scale_code_set / removed`,
`book.updated`.

| File | Purpose |
|---|---|
| `1791400000000_retail-credit-offers-loyalty-books.sql` | `offers` and `loyalty` modules, permissions and grants; `retail_offers`, `retail_sale_discounts`, `retail_loyalty_settings`, `retail_loyalty_entries`, `retail_credit_reminders`, `retail_scale_items`, `books_titles` (+ ISBN functions, append-only and weighed-item triggers) |
| `1791400000001_loyalty-points-reversed-on-returns.sql` | `reverse` loyalty entries (return, shortfall points and value), the never-below-zero constraint trigger, reversals recorded for earlier returns |

## Fashion and electronics (Phase 2, T3)

Built on the core catalogue, documents, returns, payments, stock ledger,
number series, events and audit. Three new optional modules:

| Module | Applies to (default on) | Needs | Permissions |
|---|---|---|---|
| `exchanges` — Exchanges | fashion (on), electronics, supermarket, books, grocery | sales, inventory | `exchanges.view / create / export` |
| `warranties` — Warranties | electronics (on), supermarket | serials, sales | `warranties.view / create / cancel / export / print` |
| `repairs` — Repairs & service | electronics (on) | sales, inventory | `repairs.view / create / edit / approve / cancel / export / print` |

The size × colour matrix uses the existing `variants` module (fashion,
supermarket, electronics, books, salon); the serial register uses `serials`.
Template grants: Manager everything; Cashier exchanges view/create, warranties
view/create/print, repairs view/create/approve (deliver)/print; Stock keeper
warranties view, repairs view/edit (fits parts, moves status); Accountant view,
export, print; Viewer view, export. Existing role copies received the same.

| Table | What it holds |
|---|---|
| `fashion_variants` | One row per variant SKU: `(business_id, sku_id)` → `catalog_skus`, `product_id` → `catalog_products`, `size`, `color`, `fabric` ('' when none), `size_rank`. Unique per product on lower(size, colour, fabric); a trigger keeps the row on its own SKU's product and works out `size_rank` (`fashion_size_rank`: XS…5XL, then numbers 28/30/32 and "2-3Y", other words, free size last). Existing SKUs with size and colour in their attributes were back-filled. The SKU itself (code `PREFIX-COL-SIZE`, barcode — typed, or an in-store EAN-13 `200` + SKU number, price, tax, stock) is an ordinary core row, so the counter, purchases, transfers, counts and returns all work per variant. |
| `business_exchanges` | Shared name (several types use it). One exchange: `original_document_id` (a sale), `return_id` (its credit note, which must be on that sale — trigger), `new_document_id` (the replacement sale), snapshots `returned_value`, `new_value`, `credit_applied`, `collected`, `refunded`, `method` (cash/card/upi/bank, `on_account`, or NULL when even), reason, request key + hash. Never edited or deleted (trigger). |
| `business_exchange_policies` | Per business: `days_allowed` (1–365, NULL = no limit; 30 when there is no row). Changed with `settings.edit`. |
| `electronics_models` | Per serial-tracked SKU: `model_number`, `serial_kind` (`imei` = checked, `serial` = any text), `warranty_months` (0–120), `warranty_terms`. Back-filled from the old `model` / `warrantyMonths` attributes as `serial`. |
| `electronics_serial_details` | A unit's second IMEI (Luhn-checked, unique in the business) and a note. |
| `electronics_warranties` | Registered from a sold serial line: document, line, SKU, `serial` and item snapshots, customer name / phone and `phone_digits` (last 10 digits, for lookup), `starts_on`, `months`, `ends_on` (= start + months − 1 day, CHECK), terms, `status` active / cancelled (+ reason, who, when). One active warranty per line (partial unique index). A trigger insists the line is that sale's line for that SKU and serial, and allows only the one-way cancellation afterwards. |
| `electronics_repair_jobs` | Job card: `job_no` (number series kind `repair_job`, prefix `RJ`), location, customer (contact optional; name, phone, `phone_digits`), device (catalogue SKU optional, description always), serial, `warranty_id` + `under_warranty`, problem, accessories, condition, estimate, promised date, technician, `status` (received, diagnosing, waiting_parts, in_repair, ready, delivered, cancelled), `document_id` (the delivery bill), `delivered_at`, `delivery_key`, `closed_reason`, request key + hash. Delivered or cancelled jobs never change (trigger). |
| `electronics_repair_lines` | Parts (goods, with batch/serial when tracked) and labour (service items) at the price the customer pays. Change only while the job is open (trigger). |
| `electronics_repair_events` | Status history (from, to, note, who, when). Append-only. |

Database guards on `business_stock_lots` (constraint trigger
`electronics_serial_lot_rules`, serial-tracked SKUs of every business): a
serial lot holds at most one unit; the same serial is in stock at no more than
one location at a time (sum over its lots ≤ 1); when a number is first received
for an `imei` model it must be a valid IMEI (`electronics_valid_imei`: 15
digits, Luhn); one number cannot be recorded under two items.

Rules:
- **The serial lifecycle is read, not stored.** In stock (where), on the way
  (transfer dispatched, to where), sold (bill, customer), returned by the
  customer (back in stock), back to the supplier, written off: all come from
  the unit's lots and its latest movement, so they always agree with stock.
- **Exchange** = one transaction: a core return (credit note, restocked or
  not) on the original sale + a core sale for the replacements (priced by the
  server, offers included) + moving the credit the return created on the
  original sale onto the new bill (a refund on the original and a payment on
  the new bill, both with method **`credit_note`** — no cash moves) + the
  difference: collected (needs `sales.edit`; a walk-in pays it all), or the
  surplus refunded (needs `sales.refund`) or, for a known customer, kept on
  account. Allowed within the policy days. Its parts take request keys derived
  from the exchange's own, so a retry cannot post twice; a refusal anywhere
  leaves nothing. A quote runs the same transaction and rolls it back.
- **Warranty**: only for a sold serial line not fully returned; start between
  the sale date and today; months default from the model. Its state is worked
  out when read: in warranty, ending within 30 days, expired, not started,
  unit returned, cancelled.
- **Repair**: a serial with a live, unreturned warranty marks the job under
  warranty (lines then default to price 0). Status moves only along the
  allowed steps. **Stock moves only at delivery**: the job must be ready; its
  lines become a sale bill (`postDocument` with the job's own prices, GST the
  business's way) with the payment taken; a part not in stock at the job's
  location refuses the delivery and nothing changes. Nothing on the job:
  delivered without a bill. Cancel = returned unrepaired, nothing billed.
- Events, in the same transaction: `exchange.posted`, `sale.refunded` /
  `payment.recorded` (credit-note moves), `warranty.registered`,
  `warranty.cancelled`, `repair.received`, `repair.status_changed`,
  `repair.delivered`, `repair.cancelled`.

**CHECK lists widened** (any later migration that changes them must keep the
whole list): `business_number_series.document_kind` adds `repair_job`;
`business_payments.method` adds `credit_note` (keeps `cheque`);
`business_refunds.method` adds `credit_note`. `businessReturns.service.js`
now exposes `postReturn` (a return inside the caller's transaction).

| File | Purpose |
|---|---|
| `1791420000000_fashion-variants-and-exchanges.sql` | `exchanges` module, permissions and grants; `credit_note` method; `fashion_size_rank`, `fashion_variants` (+ back-fill), `business_exchange_policies`, `business_exchanges` |
| `1791420000001_electronics-serials-warranties-repairs.sql` | `warranties` and `repairs` modules, permissions and grants; `repair_job` number series; `electronics_valid_imei`, `electronics_models` (+ back-fill), `electronics_serial_details`, the serial lot rules, `electronics_warranties`, `electronics_repair_jobs`, `_lines`, `_events` |
| `1791420000002_serial-lock-and-exchange-credit.sql` | Fixes after verification: the serial lot trigger takes an advisory lock on (business, number), so the one-place rule holds under concurrent direct inserts; `business_collections.method` adds `credit_note` (keep the whole list in any later change); `business_exchanges.credit_collection_id` |

**Exchange credit kept on account** is written as a refund by credit note on the original sale plus a collection (method `credit_note`, reference = the credit note, number from the `collection` series) left unallocated: the customer's advance. A later bill can use it through receivables "apply advance", or — also where the receivables module is off, as in fashion by default — from Exchanges › Exchange credit kept on account (`POST exchanges/credits/:contactId/use`, needs `exchanges.create` and `sales.edit`), each use a credit-note payment pointing at that collection. **Variant codes**: each colour (and fabric) of a product has one code part, kept from its existing variants, typed (`colorCodes`), or the shortest free run of its letters (Blue BLU, Blush BLUS); a new product still needs its own prefix; `addVariants` also takes `codePrefix`.

## Salon & spa, and weight-based shops (Phase 2, T4)

Both hang off the shared core. A salon's services are catalogue SKUs of kind
`service`; stylists and rooms are `business_resources`; bookings are
`business_appointments`; bills are ordinary sales (`business_documents`,
posted by the core `postDocument`); deposits are shared receivables
collections (`business_collections`) kept as the client's advance. A weight
shop sells through the core too (SKUs stocked in kg or g, three-decimal
quantities, g ↔ kg on the line, the Quick bill's weigh buttons and scale
labels); cutting and wastage move stock as reasoned corrections
(`business_stock_adjustments`), so the stock ledger keeps exactly one source
per movement and "sum of movements = lot quantity" keeps holding. Tables are
`salon_*` (salon only) and `weight_*` (meat and other weight-based shops share
them).

**Modules** (`platform_modules`, all optional):

| Module | Applies to (default on) | Needs | Permissions |
|---|---|---|---|
| `packages` "Packages & memberships" | salon (on) | sales, contacts | `view / create` (plans) `/ edit` (change plans, cancel a client's unused plan) `/ export` |
| `commissions` "Staff commissions" | salon (on) | sales, appointments | `view / edit` (rules) `/ export` |
| `processing` "Cutting & yield" | meat, weight_retail (on) | inventory, weight | `view / create` (batches) `/ edit` (yield templates) `/ export` |
| `wastage` "Daily wastage" | meat, weight_retail (on); grocery, supermarket (off) | inventory | `view / create / export` |

Template grants: Manager everything; Cashier `packages.view`, `wastage.view`,
`wastage.create`; Stock keeper `processing.view / create / export`,
`wastage.view / create / export`; Accountant and Viewer view + export.
Existing businesses' role copies received the same grants, and existing
salons and weight shops their default modules. Booking rules are edited with
`settings.edit`, service times with `catalog.edit`, stylist skills with
`appointments.create`; taking a deposit or putting an advance on a bill needs
`sales.edit` (it is money on a sale).

| Table | What it holds |
|---|---|
| `salon_settings` | One row per salon: suggested `deposit_percent`, `free_cancel_hours`, `late_cancel_fee_percent`, `no_show_fee_percent`, calendar `opens_at` / `closes_at`, and the service SKU fee bills are raised on (`fee_sku_id`, created on first use). |
| `salon_services` | Per service SKU (trigger: must be a service): `duration_minutes`, `buffer_minutes` (clean-up; the stylist is busy for it too), `needs_room`. Without a row a service takes 60 minutes. |
| `salon_resource_profiles` | Whether a resource is a stylist (`staff`) or a `room`; no row = stylist. |
| `salon_staff_skills` | The services a stylist does (none = every service). A room cannot hold skills (trigger). |
| `salon_appointment_details` | Per booking: `room_id`, `price_at_booking` (the snapshot a fee is worked from), `deposit_collection_id`, `fee_document_id`, `bill_document_id`, notes, request key + hash. Room, price and deposit are fixed; the fee and the bill are set once (trigger). |
| `salon_plans` (+ `salon_plan_services`) | A package (sessions of services) or a membership (`service_discount_percent`, `product_discount_percent`), `validity_days`, sold through its own service SKU (`sku_id`, so it goes on a bill with GST). CHECKs tie each kind to its fields. |
| `salon_client_plans` (+ `_services`) | What a client bought: a snapshot of the plan (name, price paid, discounts, sessions per service) with the bill and bill line that sold it, `starts_on`, `ends_on` (= sale day + validity − 1), status active / cancelled (+ who, when, why). Only the one-way cancellation may change afterwards (trigger); the session snapshot is append-only. |
| `salon_package_redemptions` | A session used: client plan, service, quantity, the bill line it paid for (unique). Append-only. A constraint trigger keeps sessions used (net of returned lines) ≤ sessions bought. |
| `salon_membership_uses` | The membership discount given on a bill line (%, amount). Append-only. |
| `salon_commission_rules` | `resource_id` (NULL = everyone), `applies_to` service / goods, `sku_id` (NULL = all of that kind), `percent`, active. One active rule per exact scope (partial unique index); the item must match the kind (trigger). |
| `salon_line_staff` | Who did each bill line (PK the line), the booking it came from, the rule used, `commission_percent`, `commission_base` (the line's taxable value after discounts) and `commission_amount` — a snapshot, append-only. |
| `weight_yield_templates` (+ `_outputs`) | What a whole input normally gives: input SKU, each cut and its `expected_percent`. Every item must be stocked in a weight unit (trigger); the cuts add up to at most 100 % (deferred constraint trigger). |
| `weight_processing_batches` | One cutting: `batch_no` (series kind `processing`, prefix `CP`), location, template, input SKU and lot, snapshots of the input (label, unit, quantity, unit cost, value) and `input_kg`, `output_kg`, `loss_kg` (CHECK output + loss = input), the input's correction, notes, request key + hash. Append-only. |
| `weight_processing_outputs` | Each cut: SKU, the lot it went into, quantity, `kg`, `cost_share`, `unit_cost`, the expected % from the template, its correction. Append-only. |
| `weight_wastage_entries` | One write-off: location, SKU, lot, quantity, `kg` (NULL for counted items), `reason` (trimming, spoiled, unsold, drip_loss, damaged, other; other needs a note), `unit_cost` and `value` snapshots, its correction (unique), request key + hash. Append-only. |
| `retail_sale_discounts.source` | Widened to `offer`, `points`, `membership`, `package` (T1's shared per-line discount snapshot). Any later change must keep the whole list. |
| `business_number_series.document_kind` | Adds `processing`. The migration reads the current list and appends to it, so kinds other jobs added are kept. |

**How a salon bill is priced** (`modules/business/salon-weight/services/businessSalonSales.js`, called by the
core posting right after retail offers, so the Bills screen, New bill, a quote
and any later POS agree):

1. A line selling a package or membership plan needs the client, one per
   line; the client's plan is created when the bill posts (it starts that day).
2. A service line marked to use a package (`clientPlanId`) is paid by
   sessions: the whole line comes off as a `package` discount (no GST on it;
   GST was charged when the package was sold). The package must be the
   client's, active, inside its dates, hold that service, and have the
   sessions left (lines of the same bill count together).
3. Every other line of a client with an active membership gets the
   membership's % (services and products separately; the best active
   membership) on what is left after any offer.
4. Discounts go into `retail_sale_discounts` and reduce the taxable value;
   then GST and rounding follow. `unit_price × quantity − discounts = taxable
   value` holds as for retail.
5. A line may name the stylist (`staffId`) and the booking (`appointmentId`).
   With commissions on, the rule is chosen most specific first: this stylist +
   this item, this stylist + services/products, everyone + this item,
   everyone + services/products. Commission = % of the line's taxable value,
   kept as a snapshot. Returned quantities take commission back in proportion
   in the reports.

**Bookings.** A booking blocks the stylist (and its room) for the service time
plus clean-up; no overlap for the stylist or the room (rows locked in the
order business, stylist, room), only inside the calendar's hours, only with a
stylist who has the skill, with a room when the service needs one, and the
room at the stylist's location. A deposit is a numbered collection (`RC/…`)
with nothing put against bills: the client's advance.

For a salon the generic `POST /appointments` and `PATCH /appointments/:id`
run these same rules (the time sent as the end is ignored; the service time
plus clean-up is used), so no screen or client can skip them.

**The no-show / late-cancellation rule.** Cancelling at least
`free_cancel_hours` before the start is free. A later cancellation keeps
`late_cancel_fee_percent`, a no-show `no_show_fee_percent`, of the price when
booked, **only ever out of the deposit** and never more than what is left of
it, in whole rupees. The charge is a numbered sale on the fee item (GST worked
out of the charge) paid from the deposit collection; the rest of the deposit
stays the client's advance. No deposit, no charge.

**When a booking may change.** A no-show is allowed only once the booking's
start time has passed; done (and billing, which marks it done) only on the
booking's own day or later, in the business's time zone. Cancelling is always
allowed. The rule is one function (`statusAllowed` in `business.service.js`)
used by the salon status, the salon bill and the generic appointment status.

**The salon bill** (`POST /salon/bills`) posts the sale through the core, then
in the same transaction puts the client's advances (oldest first) against it
when asked, takes the payment for the rest, and marks the named bookings done
and billed (a booking is billed once and goes on one line of the bill — a
second line with the same booking is refused, so a package session is never
used twice for one visit; cancelled and no-show bookings cannot be
billed). Cancelling a client's plan is refused once a session or a membership
discount was used; the bill line that sold a plan can be returned (credit
note, refund) only after the plan is cancelled (trigger on
`business_return_lines`). With the `packages` module switched off a
plan's item cannot be sold at all (it would otherwise be a plain service and
the client would get nothing). **Held deposits:** a deposit whose booking is
still to come (booked, start in the future) is kept for that booking: *Use
deposit / advance* skips it unless that booking is on the bill, so a later
no-show can still be charged from it. (The shared receivables *apply advance*
of `/receivables` does not know bookings; salons start without that module.)
Repeating a bill request returns the first bill and the advance it applied.

**Cutting** (`POST /weight/processing`): the input batch must be stocked by
weight, not expired, and hold the weight; every cut must be stocked by weight,
and the cuts may not weigh more than the input (compared in kg; g items
convert). In one transaction: a `CP` number, the input taken out of its lot
(correction), each cut put into stock (correction): a batch-tracked cut into a
new batch named after the cutting number with the input's use-by date, an
untracked cut into its loose stock at weighted average cost. **Cost:** the
input's cost (quantity × lot cost) is shared by the cuts in proportion to
their selling value (weight × list price; by weight when no prices), with the
rounding carried so the shares add up to the paisa. Loss carries no cost, so
the cost per usable kg rises with the loss. A cut priced ₹0 (bones, trimmings) carries no
cost next to priced cuts; the priced cuts carry it all. **Wastage** (`POST
/weight/wastage`) takes the weight out of one batch at once, valued at that
batch's cost.

**Reports.** Yield by input item (batches, kg in / cuts / loss, yield %,
expected % weighted by input, cost per kg in and per usable kg), by cut
(share of the input against expected, cost carried, cost per kg) and by day.
Wastage by item (with what sold in the same period, and wastage as % of sold +
wasted), by reason and by day. Commission by stylist (bills, services done,
service and product sales after discounts and returns, commission after
returns) and per bill line.

Events (same transaction): `appointment.booked / completed / cancelled /
no_show` (with room, deposit, fee), `collection.recorded` (deposit),
`collection.applied`, `package.sold`, `membership.sold`, `package.redeemed`,
`package.cancelled`, `membership.cancelled`, `commission.earned`,
`processing.posted`, `wastage.recorded`, plus the core `sale.posted` and
`payment.recorded`. Audit: `salon.rules_updated`, `salon.service_timed`,
`salon.staff_updated`, `package_plan.created / updated`,
`membership_plan.created / updated`, `commission_rule.created / updated`,
`yield_template.created / updated`, and the same actions as the events.

| File | Purpose |
|---|---|
| `1791430000000_salon-packages-memberships-commissions.sql` | `packages` and `commissions` modules, permissions and grants; salon settings, service times, stylist / room profiles, skills, booking details, plans, client plans, redemptions, membership uses, commission rules and line commissions (+ append-only, service-only, sessions-left and plan-line-return triggers); `retail_sale_discounts.source` widened |
| `1791430000001_weight-processing-yield-wastage.sql` | `processing` and `wastage` modules, permissions and grants; number-series kind `processing`; yield templates, cutting batches and outputs, wastage entries (+ weighed-item, template-total and append-only triggers) |
| `1791470000000_restaurant-feature-switches.sql` | The fourteen restaurant feature modules (`platform_modules.feature_group`), their applicability and dependencies; `restaurant_business_id()`, `restaurant_features()`, `restaurant_feature_set()`; every restaurant business back-filled with every feature (loyalty as before); `restaurant_settings.loyalty_enabled` dropped |

## Shared commerce, pro pass (migration 1791540000000, 7 Oct 2026)

- **`catalog_skus.hsn_code`** (4, 6 or 8 digits) and **`catalog_skus.mrp`**
  (GST included), with `CHECK (mrp IS NULL OR price <= mrp)`. The API also
  refuses a price whose GST-inclusive value passes the MRP when prices are
  before GST: on the catalogue, on a receipt's new shelf price and on every
  sale line (a wholesale dispatch keeps its order's prices).
- **`business_document_lines.hsn_code`, `.mrp`**: snapshots on each line.
- **`business_documents.place_of_supply`** (GST state code: the buyer's GSTIN
  state, else the seller's state), **`.buyer_gstin`**, **`.buyer_address`**
  (the buyer as billed; older documents fall back to the contact as it is now)
  and, on purchases only, **`.supplier_bill_no`** / **`.supplier_bill_date`**
  (unique per supplier, case-insensitive).
- **`business_settings.max_bill_discount_percent`** (default 10) and
  **`.walk_in_credit`** (default false). `business_seed_settings()` gives goods
  types (grocery, supermarket, books, pharmacy, fashion, electronics, meat,
  weight_retail) `tax_mode='inclusive'` and `rounding='nearest_rupee'`; the
  demo businesses of those types were moved; posted documents keep theirs.
- **Walk-in rule**: a goods shop's sale posted through `POST /documents` with
  no customer is paid in full at posting unless `walk_in_credit`.
- **Counter discount**: `retail_sale_discounts.source` may be `manual`
  (permission `sales.discount`; the permission action list gained
  `discount`). Applied after offers and before points, spread over the lines
  like a bill offer, so GST is on what is left.
- **`business_supplier_payments`** (`SP/2627/0001`, number kind
  `supplier_payment`): one payment to a supplier; the part that settles a
  receipt is a `business_payments` row with `supplier_payment_id`, the rest an
  advance. A constraint trigger allows only that supplier's purchases and never
  more than was paid; a voucher is never edited or deleted; a payment row comes
  from a collection or a supplier payment, not both. `contactBalanceSql` takes
  unapplied supplier payments off what is owed, as it does customer advances.
- **Warranty at the sale**: a sale of a serial unit whose model has warranty
  months registers `electronics_warranties` in the same transaction when a
  customer with a phone (or the walk-in `buyer`) is known.
- Collections & outstanding (`receivables`) is on by default for every goods
  type and was switched on for the demo shops.

## Pro passes (7 Oct 2026)

Each pass adds tables and columns beside its type's own and beside the shared
exchanges and collections (the fashion and electronics pass also changes
module defaults: offers on for a garment shop, exchanges on for electronics,
no "sold by weight" for a new garment shop).

| Table / column | What it holds |
|---|---|
| `business_collection_cheques` | A cheque taken on a collection: number, its own date (post-dated allowed), bank, received → deposited → cleared, or bounced (from received or deposited) with the reason and the bank charge owed; the bill settlements a bounce took back are kept on the row. It only moves forward and is never deleted (trigger). Permission `receivables.approve` (credit control). |
| `wholesale_settlements` (+ `_receipts`) | A salesperson's evening settlement for a day: what each method brought, the cash handed over and the difference (a note when it is not zero); each receipt settles once; fixed once saved. |
| `wholesale_delivery_runs`; transport and delivery columns on `wholesale_dispatches` | One van, many orders, one load sheet; on each dispatch the transporter, LR and e-way bill (12 digits, with its date) and the stage: out for delivery → delivered, part returned (a sales return) or refused. |
| `wholesale_order_lines` + `discount_percent`, `list_unit_price`, `free_of_line_id`, `scheme_id`; `wholesale_order_edits`; `wholesale_hold_releases` | Line discounts and free goods (a free line is ₹0); an order changed before dispatch (the lines taken off and added, the totals before and after, the reason); a credit hold let through by a manager, with the reason. |
| `wholesale_price_groups`, `wholesale_group_prices`, `wholesale_schemes` | Price groups with dated prices, per pack or per unit (a new price ends the old one the day before); schemes: buy N get M free and / or a discount % for a period, for everyone or one group. |
| `wholesale_customer_profiles`, `wholesale_settings` | A trade customer's price group, contact person, state and PIN for the place of supply, trade or walk-in, and whether holds pass them by; the business's credit-hold rule (`hold_overdue_days`). |
| `wholesale_salespeople` + `user_id`, `monthly_target`; `wholesale_claims` | A salesperson's login and monthly target; claims on suppliers (scheme, damage, expiry, rate difference, shortage, other): open → submitted → settled or rejected. |
| `fashion_gst_price_slabs` | GST on clothing by price: 5 % up to ₹2,500 a piece and 18 % above, worked out on each sale line after discounts. |
| `business_exchange_vouchers` (+ `_uses`) | Exchange credit as a numbered voucher (walk-ins too), spent at the counter; a voucher is only ever spent and never deleted, and a use never changes. `business_exchanges.no_bill` marks an exchange made without the bill (a gift). |
| `electronics_faulty_units`, `electronics_warranty_claims` | A dead-on-arrival or faulty unit held for the supplier (a trigger refuses selling it), linked to its replacement, the exchange and the purchase return; what a warranty repair is claimed back from the brand. Repair jobs gained the `awaiting_approval` status, a passcode cleared when the job closes, a damage checklist and an advance; models a brand helpline. |
| `retail_offers.product_id` (kind `product_percent`) | A markdown: a % off every size and colour of one style until a date; the shelf price is never rewritten, so it reverts by itself. |
| `salon_walk_ins`, `salon_client_profiles`, `salon_client_notes`, `salon_staff_leave`, `salon_commission_payouts`, `salon_tips` | The waiting strip; the client card (profile, and notes and colour formulas, append-only); a stylist's leave; commission paid out and tips (both append-only). Bookings gained arrival, confirmation and reminder times, moves and the walk-in mark; stylists their hours and weekly day off; commission rules a flat amount. |
| `weight_rate_history`, `weight_pack_sizes`, `weight_pickup_orders` (+ `_lines`), `weight_day_closes` | Every rate change (append-only); pouches repacked from loose stock and sold by the piece; phone and WhatsApp orders for pickup; the end-of-day weigh-up (append-only). Cutting batches gained who cut, the supplier and "cut to order". |
| `business_locations.sells_at_counter`; `books_sets` (+ `_items`); `books_customer_orders` | A warehouse is not a till; a school booklist billed in one scan; a customer's order for a book not in stock, with an advance kept as a numbered collection, moving only forward and never deleted. |

| File | Purpose |
|---|---|
| `1791580000000_wholesale-pro-cheques-dispatch-schemes.sql` | Cheques, settlements, delivery runs, order discounts and edits, credit holds, price groups, schemes, customer profiles, claims; `receivables.approve` |
| `1791595000000_fashion-electronics-pro.sql` | Offers for garment shops and exchanges for electronics (defaults), markdowns, GST by price, credit vouchers, faulty units, warranty claims, repair approval and advances |
| `1791600000000_salon-weight-pro.sql` | Salon walk-ins, client card, leave, payouts, tips, flat and package commission; weight shops' rates, pack sizes, pickup orders, weigh-ups |
| `1791610000000_retail-pro.sql` | Counter flag on locations, school sets, books customer orders |

## Tasks, issues & projects (migration 1791620000000, 7 Oct 2026)

One model for every business type and the restaurant, keyed on `business_id`
([ARCHITECTURE.md › 4.3](ARCHITECTURE.md#43-tasks-issues--projects-one-model-for-both-worlds)):

| Table | What it holds |
|---|---|
| `platform_task_categories` | The shared categories (opening and closing, cleaning, food safety, maintenance, stock check, audit, hiring…) |
| `business_task_templates` (+ `_items`) | A business's own templates; the built-in library of 82 checklists and six project plans is code (`modules/tasks/library`) |
| `business_tasks` (+ `_assignees`, `_items`, `_comments`, `_files`, `_history`) | A task with who it is for, its checklist answers (section, checkbox, yes / no, number, text, photo, signature, choice), comments, photos and files, and its history (append-only) |
| `business_task_schedules` | Recurring tasks; each day's task is made once however often it is asked for |
| `business_issues` | Issues raised by hand, by a failed answer or from a restaurant's log book entry |
| `business_projects` (+ `_members`, `_milestones`, `_lists`) | Projects, who sees them, their milestones and lists |

Where and who differ by world: a restaurant's outlet, employee or role; a
business's location, resource or business role. A trigger
(`business_task_world_check`) refuses a pointer outside the business. Modules
`tasks`, `issues` and `projects` ([Restaurant features](#restaurant-features));
13 permissions (`tasks.*`, `issues.*`, `projects.*`, with the actions assign,
review and manage). Events: `task.assigned`, `issue.reported`,
`issue.assigned`.

## Round 2 (8 Oct 2026)

Additive, one migration per builder. The rules, and the setting that changes
each, are in [DECISIONS_ROUND2.md](DECISIONS_ROUND2.md).

| Table / column | What it holds |
|---|---|
| `business_payments.tendered` | What the customer handed over for a cash payment (the change is `tendered − amount`); a bill takes up to eight payments in one posting. |
| `business_settings.counter_pin_every_bill` | The biller's PIN asked for every bill at a shared till. |
| `retail_loyalty_settings.return_spent_points`; loyalty entry kind `restore` | Points spent on a bill come back in proportion when its goods are returned (on by default). |
| `catalog_skus.is_kit`, `catalog_kit_components`; `business_document_lines.kit_sku_id`, `kit_label`, `kit_group` | A kit and its parts; a kit sold is posted as its parts, each line remembering the kit. |
| Module `finance`; `electronics_financiers`, `electronics_finance_cases`, `electronics_finance_settlements`; payment and refund method `finance` | EMI: the financed part of a bill is owed by the financier (a payment of method `finance` settles the customer's part); the financier's payouts, net of the dealer subvention; a case cancelled after a return (a refund of method `finance`). A case only moves one way and is never deleted; a payout is kept as recorded. An electronics shop starts with four financiers. |
| `wholesale_purchase_orders` (+ `_lines`), `wholesale_purchase_receipts` (+ `_lines`) | A purchase order to a supplier and what came in against it; each receipt is an ordinary core purchase, and a receipt row never changes. |
| `wholesale_dispatches.challan_no`, `challan_series_id`; series kinds `purchase_order` (PO), `delivery_challan` (DC) | The delivery challan's own number, from its own series. |
| `wholesale_schemes.free_sku_id`, `free_unit_code`, `no_slab` | Free goods of another item; a scheme that does not stack on a slab price. |
| `wholesale_settings.bounce_charge`, `bounce_hold_count`, `bounce_hold_days` | The bank charge on a bounce (₹500 by default) and the credit hold after N bounces in a window (2 in 90 days). |
| `customer_advances.order_id` (restaurant) | The pickup order an advance was taken for. |
| `salon_staff_week`, `salon_holidays`, `salon_booking_overrides` | A stylist's hours on a weekday where they differ from usual; the salon's closed days; a manager's approval to book outside them, with the reason (append-only; permission `appointments.approve`). |
| `salon_service_products`, `salon_backbar_usage` | The products a service uses, and what each billed service took from stock at the latest purchase price (append-only). |
| `business_collection_refunds`, `salon_deposit_releases` | Money of a collection handed back, only to the customer who paid it and never more than is left (append-only; a repair's advance is refunded the same way); a held deposit moved to the client's wallet (append-only). |
| `salon_commission_plans`, `salon_commission_slabs`, `salon_commission_schemes` | Monthly target (slab) commission plans on the month's net service sales, and the plan each stylist is on from a month. |

**CHECK lists widened** (keep the whole list in any later change):
`business_payments.method` and `business_refunds.method` add `finance`;
`retail_loyalty_entries.kind` adds `restore`;
`business_number_series.document_kind` adds `purchase_order` and
`delivery_challan`; `business_permissions.action` adds `view_clinical` and
`edit_clinical` (below).

### Pharmacy, clinic and lab (migration 1791620004000)

Standard Indian practice, to be reviewed by a pharmacist, a doctor and a legal
adviser before going live
([DECISIONS_ROUND2.md › Pharmacy & clinic](DECISIONS_ROUND2.md#pharmacy--clinic)).
Modules `pharmacy` (pharmacy; needs `sales`, `batches`, `contacts`),
`patients` and `lab` (clinic); permissions `pharmacy.*`, `patients.*` with
`patients.view_clinical` and `patients.edit_clinical`, and `lab.*`; role
templates Pharmacist, Doctor, Lab technician and Pathologist. Every look at
clinical data is written to `business_audit` by the service.

| Table | What it holds |
|---|---|
| `health_settings`, `health_signatories`, `health_counters`, `health_files` | One row per pharmacy or clinic (drug licences, retention, the near-expiry window, the lab's details, the consent notice, the referral commission); the people who sign (registered pharmacists, doctors and pathologists with their registration numbers; they sign by PIN); the patient, visit, lab order, sample and debit-note numbers; prescription scans (JPEG, PNG, WebP or PDF, kept in `private_uploads`). |
| `pharmacy_drugs` | The drug master on a catalogue SKU: salt, strength, form, maker, schedule (none, G, H, H1, X, narcotic), pack, loose sale, cold chain. |
| `pharmacy_prescriptions`, `pharmacy_register_entries` | The prescription behind a Schedule H, H1 or X sale (doctor, registration number, date, the scan) and the H1 and Schedule X register lines it writes; both append-only. A trigger refuses a prescription medicine on an ordinary sale. |
| `pharmacy_recalls` | A recalled batch (its buyers are found from the sales that took it); the batch is blocked, and a trigger refuses selling or moving it. |
| `pharmacy_debit_notes` (+ `_lines`) | Expiry and breakage returns to the distributor and the credit that settles them; lines append-only. |
| `health_patients`, `health_consents`, `health_patient_clinical` | A patient on a contact; the consent the DPDP Act asks for (kept as given, only its withdrawal recorded, once; never deleted); the clinical card. |
| `health_visits`, `health_visit_notes`, `health_prescription_items` | A consultation (vitals, diagnosis, follow-up), its notes (append-only) and its prescription (open only until the visit is completed); a completed visit is kept as written. |
| `lab_tests`, `lab_parameters`, `lab_reference_ranges`, `lab_profile_tests` | Tests with their parameters, ranges by sex and age band (critical limits too), and profiles of tests sold together. |
| `lab_orders`, `lab_order_tests`, `lab_samples`, `lab_results` | An order's tests, its samples with barcodes and its results, which cannot change once the order is approved or cancelled. |

| File | Purpose |
|---|---|
| `1791620001000_salon-weight-repairs-round2.sql` | Stylist weeks, holidays, overrides, back-bar products, advance refunds and wallet moves, slab commission |
| `1791620002000_core-retail-electronics-round2.sql` | Split payment (`tendered`), PIN for every bill, points back on returns, kits, EMI and financiers |
| `1791620003000_wholesale-purchase-orders-challan-schemes-bounces.sql` | Purchase orders and receipts, the delivery challan series, cross-item schemes, bounce rules; the restaurant's pickup advance |
| `1791620004000_pharmacy-clinic-lab.sql` | Pharmacy, patients and lab modules, permissions and type roles, and the tables above |

## Round 3 (12–21 Oct 2026)

| Table / column | What it holds |
|---|---|
| `business_locations` + address, city, PIN, `state_code`, `gstin`, `phone` (12 Oct), `opening_hours` (16 Oct) | A location's own details, printed on the bills it raises (the place of supply follows its state), and its opening hours. A location with staff tied to it cannot close (trigger). |
| `business_memberships.location_id` (12 Oct), `department_id` (16 Oct) | A person tied to one location or one department (NULL = all). Nobody is tied to a closed location, and the owner never to one (trigger). |
| `pharmacy_location_licences` | A pharmacy branch's own drug licences, printed on its bills. |
| `business_payment_methods`; `method_name` on `business_payments`, `business_refunds`, `business_collections`, `business_supplier_payments` and `business_collection_refunds` | The business's own names for the ways it takes money, each of five fixed kinds (cash, UPI, card, bank, cheque); every type but the restaurant starts with Cash, UPI, Card, Bank transfer and Cheque; the last one switched on stays on (trigger). The accounts count the kind; each money row also keeps the name. |
| `business_settings` + `voucher_valid_days`, `ageing_days`, `near_expiry_days`, `weight_buttons_grams`, `receipt_width_mm`, `day_cutoff_hour` | The owner's rules, each defaulting to what the code used to fix (90 days; 30 / 60 / 90; 30 days; 250, 500, 1,000 and 2,000 g; 80 mm; 5 am). |
| Module `expenses`; `business_expenses` | Money already paid for running costs at one location (category, amount, payment method, request key); never edited or deleted, reversed once with a reason. |
| `business_cash_checks` | A drawer counted against what it should hold, for one day and location; a difference needs a reason; a permanent snapshot. |
| `platform_module_business_types.recommended`, `recommended_note` | A tool marked recommended for a trade, with the reason (Settings › Business tools). Since `1791950400000` a new business starts lean: its specialist modules are off until switched on; existing businesses kept theirs. |
| `catalog_skus.shelf_location`, `member_price`, `internal_use` | Where an item sits, the price a loyalty member pays when it is lower, and an item used up inside services and never sold. |
| `business_sku_location_prices` | A location's own price for an item. |
| `retail_offers.coupon_code`, `usage_limit`, `per_customer_limit` | An offer that applies only with its code, and how often it may be used. |
| `business_counter_shifts` | A cashier's shift at one counter: the float, the closing count and the difference; only the closing count is ever recorded on it, and a closed shift never changes. |
| `business_departments`; `catalog_categories.department_id` | A store's departments; top-level categories belong to one. |
| `business_document_lines.free_quantity`, `discount_percent` | A supplier's bill line as printed: free units and a trade discount; the stock cost of each unit received is the line's net over the whole quantity. |
| `health_visits.location_id` | The branch a clinic visit happens at. |
| `health_doctor_profiles`, `health_doctor_sessions`, `health_doctor_leave`; `health_visits.fee_kind`, `fee_sku_id` | A doctor's consultation and follow-up services, follow-up days, slot length and share of the fees; OPD sessions by weekday (with the most patients per session); leave; the fee a visit was billed (first visit or follow-up). |
| `health_tokens` | The day's queue: a token per patient and doctor (waiting, called, in consultation, done, or skipped or cancelled), priority first, numbered per location, doctor and day; one live token per patient and doctor a day. |
| `lab_orders.version`, `amend_reason` (…); `lab_report_versions` | Every signed report as it was signed (results, ranges, flags, who signed), numbered 1, 2, …; from version 2 each carries the reason for the amendment; never changed or deleted. |
| `lab_qc_materials`, `lab_qc_runs` | Control materials per parameter (lot, level, target mean and SD) and each run with its z-score, the Westgard rules it broke and its outcome; a run is never changed. |

| File | Purpose |
|---|---|
| `1791630000000_business-multi-location.sql` | Location details, staff tied to a location, branch drug licences |
| `1791640000000_business-payment-methods.sql` | Payment methods and the method name on every money row |
| `1791640001000_restaurant-rule-settings.sql` | The restaurant's own alerts and timings (its own tables) |
| `1791640002000_business-rule-settings.sql` | The owner's rules in `business_settings` |
| `1791950400000_business-workspaces-and-expenses.sql` | Lean starting set-ups, the `expenses` module, expenses and cash checks |
| `1791950401000_expense-and-cash-reason-guards.sql` | A reversal or a cash difference needs a reason that is really there |
| `1791950402000_restaurant-keeps-task-defaults.sql` | A restaurant still starts with tasks, issues and projects on |
| `1791950403000_recommended-business-tools.sql` | Recommended tools per trade |
| `1791950404000_retail-completion.sql` | Shelf location, member price, branch prices, opening hours, coupons, cashier shifts, departments |
| `1791950405000_purchase-free-quantity-discount.sql` | Free quantity and discount on a supplier's bill line |
| `1791950406000_catalog-internal-use.sql` | Items used in services only |
| `1791950407000_visit-location.sql` | A clinic visit's branch |
| `1791950408000_clinic-doctors-tokens.sql` | Doctors' fees, OPD sessions and leave; the token queue |
| `1791950409000_lab-report-versions-qc.sql` | Report versions and quality control |
| `1791950410000_food-formats.sql` | Restaurant formats, selling by weight, pre-orders ([Restaurant features](#restaurant-features)) |
| `1791950411000_kitchen-brands.sql` | Brands ([Restaurant features](#restaurant-features)) |
| `1791950412000_document-list-indexes.sql` | Indexes for the bills lists (each bill's lines, refunds and returned lines) |

**Clean copies** (21 Oct) add no table: `businessClone.service.js` copies a
demo business's set-up into a new real business through the ordinary tables
([DEMO_TO_REAL_PLAN.md](DEMO_TO_REAL_PLAN.md)).
