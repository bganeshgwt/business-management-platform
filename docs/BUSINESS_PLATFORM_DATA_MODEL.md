# Business Management Platform — data model

For backend developers: how the business platform's data is designed, and the rules each table carries.

The business platform is the set of tables every business type stands on, each row keyed by `business_id`. The restaurant keeps its own tables and joins the platform through one row ([The five layers](#the-five-layers)). The schema is defined only by the migrations in `backend/migrations/`, applied to the database that `DB_NAME` names (`business_platform_db` in `backend/.env.example`). This document explains the design those migrations build and the rules behind it.

Read it with:

- [GLOSSARY.md](GLOSSARY.md) for the words used here.
- [ADMIN_GUIDE.md, Part 3](ADMIN_GUIDE.md#part-3--business-admin-for-the-other-business-types) for what the screens do with this data.
- [DATABASE.md](DATABASE.md) for every table's columns and constraints, and the migration that added it.
- [BUSINESS_RULES.md](BUSINESS_RULES.md) for why each business rule is so, and the setting that changes it.

## The five layers

```
 1 Platform          platform_modules ─┬─ platform_module_business_types ── business_types
                                       └─ platform_module_dependencies
                     business_permissions · business_role_templates (+ _permissions)
                     (planned: platform_plans, platform_plan_modules, business_subscriptions)
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

The restaurant module keeps its own tables (`restaurants`, `restaurant_*`, `outlets`, `orders`, `bills`, `menu_*`, …). A restaurant appears in the platform as one row of `businesses` with `legacy_restaurant_id` pointing at it; nothing in the restaurant tables is renamed or moved. Through that row, a restaurant's feature switches are `business_capabilities` rows ([Restaurant features](#restaurant-features)), and its tasks, issues and projects live in the shared tables ([Tasks, issues & projects](#tasks-issues--projects)).

## Rules every table follows

- **Every row belongs to one business.** Business-owned tables carry `business_id NOT NULL`, and every link between two business rows is a **composite foreign key** `(business_id, x_id) → x(business_id, id)`. A sale can therefore never point at another business's customer, lot, location, role or tax slab: the database refuses it, whatever the code does. Each such table has `UNIQUE (business_id, id)` for the composite keys to reference.
- **Money** is `NUMERIC(…,2)` and is worked out in integer paise (BigInt where quantities multiply). **Quantities** are `NUMERIC(16,3)` on documents, stock and orders (kit and book-set components use `NUMERIC(12,3)`; pharmacy register and debit-note lines and a salon's back-bar products `NUMERIC(14,3)`). Costs per stock unit are `NUMERIC(14,4)`.
- **Requests are idempotent.** A posting carries a `request_key UUID`, unique per business, and a hash of the request (`request_hash`). Repeating a key returns the first result; the same key with different content is a conflict (409). These tables have the key but no hash column: `business_payments`, `business_refunds`, `business_stock_adjustments`, `business_exchange_vouchers`, `books_customer_orders`, `electronics_finance_settlements`, `business_expenses` and `business_cash_checks`. `retail_loyalty_entries.request_key` is set only on a correction (`adjust`) and has no hash. `business_stock_counts.request_hash` may be NULL.
- **One lock order.** Every posting locks the business row first, then the document or order, then the stock lots, so concurrent postings queue instead of deadlocking.
- **Posted lines are snapshots.** Name, unit, price, tax rate, round-off and tax mode are copied onto the document; changing a product never rewrites a bill.
- **Audit and events are written inside the mutation's own transaction** ([the event outbox](#cross-cutting-the-event-outbox)).
- **Rules that hold across rows are triggers.** They raise SQL state 23514 with a sentence a person can read, and the API turns them into a 409. [API.md](API.md) gives the full mapping of database errors.
- **CHECK lists are kept whole.** Several columns take their values from a CHECK list that later migrations widened: `business_number_series.document_kind`, `business_permissions.action`, the `method` of `business_payments`, `business_refunds`, `business_collections` and `business_exchanges`, `retail_sale_discounts.source`, `retail_loyalty_entries.kind`, `retail_offers.kind` and `electronics_repair_jobs.status`. A migration that changes one must keep the whole list, or read the current list and append to it, as the number-series migrations do.

### What the database enforces

| Rule | How |
| --- | --- |
| A row can only point at rows of its own business | `business_id NOT NULL`, `UNIQUE (business_id, id)` on each table, and composite foreign keys |
| A module can be on only if it applies to the type and its dependencies are on | Constraint trigger `business_capabilities_enforce` ([§1](#1-platform)) |
| A new business is ready to use | `AFTER INSERT` triggers on `businesses` ([Provisioning](#3-business-tenant)) |
| A location someone is tied to stays open; the owner is never tied to one; at least one payment method stays on | Triggers on `business_locations`, `business_memberships` and `business_payment_methods` |
| A tax slab's rate never changes | Trigger (add a new slab instead) |
| Document numbers never repeat or go back | `business_number_series`: a number is taken with `UPDATE … RETURNING` inside the posting, and a trigger forbids moving `next_number` backwards |
| Every stock movement has exactly one source, and stock never goes below zero | `num_nonnulls(document, adjustment, transfer) = 1`; each movement's `balance_after >= 0`; `business_stock_lots.quantity >= 0` |
| Posted records are never edited | Append-only and one-way-status triggers on lines, discounts, loyalty entries, commissions, wastage, repairs, expenses, cash checks, cashier shifts, signed lab reports, QC runs and more. Several of them let `created_at` alone be corrected. |
| Outbox rows are only ever stamped once | A trigger on `business_events` allows only setting `published_at`, once; unpublished rows cannot be deleted |
| A serial number is in one place at a time | Constraint trigger `electronics_serial_lot_rules`, with an advisory lock ([Electronics](#electronics)) |

### What only the code checks

The services enforce these rules; the database does not, or not fully:

- **Exactly one Owner role.** The database allows at most one full-access role per business ([§2](#2-identity--access)). Provisioning makes the one.
- **A client plan's end date.** The server sets `salon_client_plans.ends_on` to the sale day + validity − 1 when the plan is sold. The database checks only that `ends_on >= starts_on` and that a change moves it later; the plan's validity is not stored on the client plan.
- **Warranty phone digits.** `electronics_warranties.phone_digits` keeps the last 10 digits of the phone; its CHECK accepts 6 to 10 digits.
- **Appointment overlap.** The service refuses a second booking of the same stylist, staff member or room at the same time, with the resource's row locked. There is no exclusion constraint, only a partial index on booked appointments.
- **A lot's quantity is the sum of its movements.** Each posting changes the lot and writes the movement, with the balance after it, in the same transaction; no trigger compares the two.

### Table names

Platform-wide tables start with `platform_` or `business_`, and the shared catalogue's with `catalog_`. A type's own tables start with the type or its trade: `retail_*` (the shop types), `books_*`, `wholesale_*`, `fashion_*`, `electronics_*`, `salon_*`, `weight_*` (meat and other weight-based shops), `pharmacy_*`, and a clinic's `health_*` and `lab_*`. The restaurant module's tables (`restaurants`, `restaurant_*`, `outlets`, `orders`, `bills`, `menu_*`, …) belong to the restaurant type and are not platform-wide; `business_days` and `business_hours` are restaurant tables despite their names. One `wholesale_*` group serves every type: the purchase orders ([Purchase orders and receipts](#purchase-orders-and-receipts)).

## 1. Platform

| Table | What it holds |
|---|---|
| `platform_modules` | The module catalogue: `code` (the capability string), name, description, `kind` = `core` (always on: settings, access, reports, audit) or `optional`. `feature_group` is the heading a restaurant feature is listed under ([Restaurant features](#restaurant-features)). |
| `platform_module_business_types` | Which modules a business type *may* enable, which it gets by default (`enabled_by_default`), and which are `recommended` for it, with a `recommended_note` saying why (Settings › Business tools). Applicability is wider than the defaults: a salon may switch on stock transfers, but does not start with them. |
| `platform_module_dependencies` | A module that needs another (purchasing needs inventory and contacts). |
| `business_permissions` | The permission catalogue: `<module>.<action>`. The actions are view, create, edit, approve, cancel, refund, export, print, discount, assign, review, manage, view_clinical and edit_clinical. Only meaningful pairs exist; [DATABASE.md](DATABASE.md#business-permission-codes) lists them. |
| `business_role_templates` (+ `_permissions`) | The standard roles: Owner (full access), Manager, Cashier / sales, Stock keeper, Accountant, Viewer. A template may belong to some business types (`business_types`, NULL = every type): Pharmacist (pharmacy); Doctor, Lab technician and Pathologist (clinic, type `healthcare`). |

**A new business starts lean.** Its type's everyday modules are on. Specialist tools start off: stock transfers, offers, loyalty, repairs, EMI, packages, commissions, cutting, the lab, and tasks, issues and projects (which a restaurant starts with). The owner switches them on in Settings › Business tools, which marks the recommended ones with the reason. Each type section below gives its modules and which start on.

`business_capabilities.capability` is a foreign key to `platform_modules`. A constraint trigger (`business_capabilities_enforce`) refuses a core module stored per business, a module that does not apply to the business type, a module whose dependency is off, and switching off a module that another enabled module needs. A capability row is switched on or off, never re-pointed. A business's type cannot change after creation (`businesses_type_is_fixed`), because it decides what its records mean.

### Commercial plans

There are no plan tables. Instead of empty tables whose columns would be guesses, the shape is fixed here, so adding plans later is purely additive:

```
platform_plans            (code PK, name, billing_period, price_paise, active)
platform_plan_modules     (plan_code → platform_plans, module_code → platform_modules, limits JSONB)
business_subscriptions    (id, business_id → businesses, plan_code, starts_on, ends_on, status, …)
business_capabilities     + source TEXT ('plan' | 'owner' | 'type_default'), + subscription_id (nullable FK)
```

A subscription will only *write* `business_capabilities` rows (and read limits). Every check in the server reads `business_capabilities`, so no query, screen or test changes when plans arrive. Without plans, the owner switches modules on and off within what the type allows: Settings › Business tools (permission `settings.edit`), or a restaurant's own Features screen ([Restaurant features](#restaurant-features)).

### Restaurant features

A restaurant is one business of type `restaurant` (`legacy_restaurant_id`). The parts a restaurant may not want are **optional modules in the same catalogue**, grouped by `platform_modules.feature_group`. They apply only to type `restaurant` and each needs the `restaurant` module; the three tasks modules apply to every type.

| Group | Codes | A new restaurant starts with it |
|---|---|---|
| Guests | `guests`; `guest_loyalty` (needs `guests`) | on; loyalty **off** |
| Service | `reservations`, `qr_ordering`, `online_ordering` (needs `guests`), `deliveries`, `kitchen_display`, `captain_sections` | on |
| Service | `preorders` (needs `guests`), `brands` | **off** (the café and bakery formats switch on pre-orders, the cloud kitchen brands) |
| Money | `tips`, `advances`, `cash_drawers`, `coupons` | on |
| Back office | `stock_recipes`, `staff_payroll` | on |
| Operations | `tasks`; `issues`, `projects` (need `tasks`) | on for a restaurant; off for every other type |

Core, never switched: POS and orders, bills and payments, dues, menu, tables, outlets, business day, expenses, log book, reports, users and roles, settings, activity log.

A restaurant's **format** is `restaurants.format`: `restaurant`, `cafe`, `bakery` or `cloud_kitchen`. Choosing one (`restaurantFormat.service.js`) sets the POS's order types and the one a new order starts on (`service_settings.pos_order_types`, `default_order_type`), the token numbers and these switches; the owner can change each afterwards. The formats use these parts of the restaurant's own tables:

- `products.sold_by`: a dish sold by the piece, or by weight with the price per kg.
- The waste reason `unsold`, for what is left at the end of the day.
- Pre-orders: `restaurant_preorders` (+ `_items`) hold the guest, what and when, the message, the advance (an ordinary `customer_advances` row) and the takeaway order it becomes on collection.
- Brands: `restaurant_brands`, with `categories.brand_id` (NULL = every brand's) and `orders.brand_id`.

An advance taken for any pickup order names that order (`customer_advances.order_id`), so its bill offers the advance first.

How the switches work:

- **One source of truth.** A restaurant's switch is its business's `business_capabilities` row, read through `restaurant_features(restaurant_id)`. A restaurant not yet linked to a business has the type defaults; `restaurant_business_id()` links it on its first switch. The restaurant's Features screen (Settings › Features) and the Business Admin's module switches for the restaurant business (`PUT /api/businesses/:id/modules/:code`) read and write the same rows, through the same service (`restaurantFeatures.service.js`: dependencies, refusing a switch that would strand money, the activity log).
- **Loyalty.** The switch is `guest_loyalty`; the earn and redeem rules stay in `restaurant_settings`.
- **Enforced on the server.** `req.user.features` comes with the signed-in profile. `requireFeature(code)` refuses a switched-off feature's endpoints with 403 `{ reason: "feature_off", feature }`. The public QR, booking and online pages check the restaurant's features themselves, and notification providers name their `feature` and are not asked while it is off.
- **Plans.** A subscription plan will set these switches exactly as it sets any other module: `platform_plan_modules` lists restaurant feature codes like any module code, and a subscription writes (or removes) the restaurant business's `business_capabilities` rows with `source = 'plan'`. Nothing in the restaurant reads anything but `restaurant_features()`, so no screen, query or test changes when plans arrive. A plan dropping a feature must pass the same money checks (an advance still held, rider cash not settled) before it removes the row.

## 2. Identity & access

- **One login per person.** `users` holds every login. A person's access to a business is a row in `business_memberships (business_id, user_id)`, so the same login can be a member of a restaurant and of a pharmacy.
- **Per-business roles.** `business_roles` holds each business's own copies of the shared templates (`template_code`), its type's own templates (a pharmacy's Pharmacist; a clinic's Doctor, Lab technician and Pathologist), and roles the business makes itself (`template_code` NULL). Copies, not shared rows: one business editing its "Manager" never changes another's. Each module adds its permissions to the templates that should hold them; the type sections below list these grants.
- **The Owner.** The database allows at most one `full_access` role per business (unique index `business_roles_one_full`), and only the active copy of the `owner` template may have it (CHECK). Provisioning gives every business exactly one. The Owner holds no permission rows (a trigger refuses them) and always has every permission, including ones later migrations add.
- **Memberships.** `business_memberships.role_id` → `business_roles(business_id, id)` (composite: a membership can only hold its own business's role). `last_opened_at` remembers the business a person last opened. `location_id` ties a person to one location and `department_id` to one department (NULL = all). Nobody is tied to a closed location, and the owner is never tied to one (trigger).
- **Two checks on every request, both on the server:** the permission's module must be on for the business (`business_capabilities`), and the person's role must hold the permission. A person tied to a location works there only; one tied to a department sees and changes only its products and stock.
- **No escalation** (`businessAccess.service.js`). Nobody can hand out the Owner role, change the owner's access or change their own. A person with `access.edit` can give only roles and permissions they hold themselves, and only at their own location or department when they are tied to one.

## 3. Business (tenant)

| Table | Notes |
|---|---|
| `businesses` | The tenant root: name, a unique code, `business_type` (fixed once created), `legacy_restaurant_id` (a restaurant only), status (active or inactive), currency (INR by default) and time zone (Asia/Kolkata by default). "Today" for a business is a date in its time zone. |
| `business_settings` | One row per business: legal and display name, GSTIN (pattern-checked in SQL, check character validated by the API), address, GST state code (must match the GSTIN's first two digits), PIN, phone, email, logo path, `tax_mode` (prices `exclusive` or `inclusive` of GST), `rounding` (`none` or `nearest_rupee`), `fiscal_year_start_month` (April), invoice and receipt footers, date format. The counter's settings: `max_bill_discount_percent` (10), `walk_in_credit` (false) and `counter_pin_every_bill` (false) ([Documents](#documents)). The owner's rules, with their defaults: `voucher_valid_days` (90), `ageing_days` (30, 60, 90), `near_expiry_days` (30), `weight_buttons_grams` (250, 500, 1,000 and 2,000), `receipt_width_mm` (80, or 58) and `day_cutoff_hour` (5 am). The cut-off is used by tasks only: until that hour, a task due after midnight still belongs to the day before. |
| `business_tax_rates` | Named GST slabs. A new business starts with nil, 5 %, 18 % (the default) and 40 %. A slab's `rate` never changes (trigger): add a new slab instead, so old invoices keep their meaning. One default per business. Items point at a slab (`catalog_skus.tax_rate_id`) and keep `tax_rate` as the rate charged. |
| `business_number_series` | Per business, location, document kind and fiscal year: `prefix`, `next_number`, `padding`. Prefixes are unique in a business and must not end in a digit, so a number can only come from one series; prefix + digits ≤ 16 characters (the GST limit). A number is taken with `UPDATE … SET next_number = next_number + 1 … RETURNING` inside the posting transaction: concurrent postings queue on the row, a failed posting gives its number back, and a trigger forbids moving `next_number` backwards, or changing the prefix or padding once a number has been used. A series is created on first use (`SI/2627/0001` for the first location to post; other locations get a prefix that names them) or set up in advance by the owner. The kinds and their prefixes: sale (SI), purchase (PR), sales_return (CN), purchase_return (DN), stock_transfer (ST), stock_count (SC), sales_order (SO), collection (RC), repair_job (RJ), processing (CP), supplier_payment (SP), purchase_order (PO) and delivery_challan (DC). |
| `business_locations` | A business's shops, godowns and branches: name, code, active. A location has its own address, city, PIN, `state_code`, `gstin` and `phone`, printed on the bills it raises (the place of supply follows its state), and its `opening_hours`. A location with staff tied to it cannot close (trigger). |
| `business_departments` | A store's departments. A top-level category belongs to one (`catalog_categories.department_id`) and its sub-categories take the same one; a person may be tied to one (`business_memberships.department_id`). |
| `business_payment_methods` | The business's own names for the ways it takes money, each of five fixed kinds: cash, UPI, card, bank, cheque. Every type but the restaurant starts with Cash, UPI, Card, Bank transfer and Cheque; the restaurant keeps its own payment types. The last method switched on stays on (trigger). Money rows count the kind and keep the name ([Money](#money)). |
| `business_capabilities` | The optional modules switched on ([§1](#1-platform)). |

**Fixed once documents exist.** The financial-year start month cannot change once the business has a number series (documents would land in the wrong year's series). A newly created series starts after the highest number already used with its prefix.

**Provisioning.** An `AFTER INSERT` trigger on `businesses` (`businesses_provision_defaults`) sets up every new business, whichever path created it: Platform › Businesses, an owner's *Add a business*, or linking a restaurant. It gives the business:

- its roles (`business_seed_roles`: copies of the shared templates and of its type's own);
- its settings row (`business_seed_settings`). Goods shops (grocery, supermarket, books, pharmacy, fashion, electronics, meat and other weight-based shops) start with prices including GST, rounded to the rupee; every other type starts with prices before GST and no rounding;
- its GST slabs (`business_seed_tax_rates`) and units (`business_seed_units`);
- its type's default modules.

Two more insert triggers add the five payment methods to every type but the restaurant (`businesses_default_payment_methods`) and four financiers to an electronics shop (`businesses_default_financiers`). A restaurant gets no GST slabs and no units: `business_seed_tax_rates` skips it, and `business_seed_units` skips a restaurant with no catalogue items, as every new one is. The restaurant module keeps its own tax rates and units. Doing all this in the database means no code path can forget a piece.

## 4. Shared core

The tables every type shares. A type adds its own tables beside them ([§5](#5-type-extensions)) and never forks them.

### Catalogue and units

- **Categories.** `catalog_categories` is a tree per business: a composite self-reference, at most five levels and no loops (trigger), sibling names unique ignoring case. `catalog_products.category_id` points at it; a product without one shows its free-text `category`.
- **Products and items.** `catalog_products` holds a product (goods or a service). `catalog_skus` holds each sellable item of it (a variant, a size), with a code and a barcode (each unique in the business), a price, a GST slab, a unit, a reorder level, `tracking` (none, quantity, batch or serial) and free `attributes` (JSON). An item also carries:
  - `hsn_code` (4, 6 or 8 digits) and `mrp` (the printed maximum retail price, GST included), with `CHECK (mrp IS NULL OR price <= mrp)`. When prices are before GST, the API also refuses a price whose GST-inclusive value passes the MRP: on the catalogue, on a receipt's new shelf price and on every sale line. A wholesale dispatch keeps its order's prices.
  - `shelf_location` (where it sits), `member_price` (what a loyalty member pays when it is lower than the price) and `internal_use` (kept in stock to be used up inside services and never sold; the bill screens leave it out).
- **Branch prices.** `business_sku_location_prices` gives a location its own price for an item. With no row, the item's price applies.
- **Kits.** `catalog_skus.is_kit` and `catalog_kit_components`: a kit sells at its own price but is posted as its components, so the stock, GST and HSN lines are theirs. Each line remembers the kit (`business_document_lines.kit_sku_id`, `kit_label`, `kit_group`). A kit itself is not stock-tracked (CHECK).
- **Units.** `business_units` per business: `kind` (count, weight, volume, length, time, service), `decimals` (count units are whole) and an optional conversion to a base unit of the same kind (`g` → `kg` × 0.001). An item's `unit` is a foreign key to its business's units. A new business starts with each, kg, g, litre, ml, metre, hour and service, plus its trade's packs: pack and box for every type but the clinic and the restaurant, case for wholesale and supermarkets, dozen for grocery, wholesale and books, strip, tablet and bottle for a pharmacy, and pair for fashion.
- **Pack sizes.** `catalog_sku_units` says how many stock units one pack holds for one item (1 strip = 10 tablets, 1 box = 24). A document line entered in a pack keeps what was typed (`entered_unit`, `entered_quantity`, `entered_unit_price`, `unit_factor`: all or none) next to the stock-unit quantity it became. The conversion must be exact, or the line is refused.

### Contacts and balances

- **Contacts.** `business_contacts` are customers and suppliers (`kind`), with `gstin` (unique per business and kind), `credit_limit` (NULL = no limit), `credit_days` (which set each bill's `due_on`) and `opening_balance` with the date it was true (`opening_balance_on`, required when the balance is not zero).
- **A contact's balance** (`contactBalanceSql` in `business.repository.js`) is:
  - the opening balance,
  - plus, for each document, its total − returns − payments + refunds,
  - less the part of the contact's collections not yet applied to a bill (a customer's advance),
  - less the part of their supplier payments not yet applied to a receipt (an advance with the supplier),
  - plus the bank charge on each bounced cheque,
  - plus advances handed back ([`business_collection_refunds`](#shared-receivables)).

  A collection whose cheque bounced does not count.
- **Credit limit.** A sale that would take a customer over their limit is refused unless enough is paid with it (a sale can carry payments). A wholesale order is checked as well ([Wholesale / FMCG](#wholesale--fmcg)).

### Documents

- **The document.** `business_documents` is a sale or a purchase, with lines (`business_document_lines`), payments (`business_payments`), returns (`business_returns` + `_lines`) and refunds (`business_refunds`). Its number comes from the number series (`series_id`). It keeps its `tax_mode`, its `round_off` (so `total = subtotal + tax + round_off`) and `due_on` (from the contact's credit days).
- **Returns.** A return has its own number (`return_no`: CN for a sale, DN for a purchase) and carries its share of the sale's round-off, in proportion to the value returned so far. The share is cumulative, so the shares add up to the whole round-off when everything is back. Returns can therefore never add up to more than the rounded total. A refund is capped both by the credit left and by what was actually paid, less earlier refunds.
- **GST as billed.** Each line keeps the item's `hsn_code` and `mrp`. A sale keeps the buyer as billed (`buyer_gstin`, `buyer_address`) and its `place_of_supply`: the buyer's GSTIN state, else the selling location's state, else the business's. A wholesale buyer without a GSTIN takes the state in their trade profile ([Wholesale / FMCG](#wholesale--fmcg)).
- **The supplier's bill.** A purchase keeps `supplier_bill_no` and `supplier_bill_date`; the same bill number from the same supplier cannot be received twice (ignoring case). A purchase line keeps the bill as printed: `free_quantity` (free units on a scheme, included in the quantity and always fewer than it) and `discount_percent` (a trade discount). The line's net is what was charged, so the stock cost of each unit received is the net over the whole quantity.
- **Payments.** A bill takes up to eight payments in one posting. A payment's `method` is a kind (cash, card, upi, bank, cheque, credit_note, finance), and `method_name` keeps the business's own name for it. `tendered` is what the customer handed over for a cash payment; the change is `tendered − amount`. A payment comes from a collection (`collection_id`), from a supplier payment (`supplier_payment_id`) or from neither, never both.
- **Walk-ins.** A goods shop's sale with no customer is paid in full when it is posted, unless `business_settings.walk_in_credit` allows credit.
- **Counter discount.** A discount given at the counter is a `retail_sale_discounts` row with source `manual` (permission `sales.discount`). It is applied after offers and before points, and spread over the lines like a bill offer, so GST is on what is left. It may not pass `max_bill_discount_percent` of the bill unless the person has full access.
- **Counter PIN.** `business_settings.counter_pin_every_bill` asks for the biller's PIN on every Quick bill at a shared till.
- **Warranty at the sale.** Selling a serial unit can register its warranty in the same transaction ([Electronics](#electronics)).

### Supplier payments

`business_supplier_payments` (number kind `supplier_payment`, `SP/2627/0001`) is one payment to a supplier, by cash, card, UPI, bank or cheque. The part that settles a receipt is a `business_payments` row with `supplier_payment_id`; the rest is an advance with the supplier. A constraint trigger allows only that supplier's purchases and never more than was paid. A payment voucher is never edited or deleted. The contact balance takes unapplied supplier payments off what is owed, as it does customer advances.

### Exchanges and vouchers

Exchanges are shared `business_*` tables: fashion and electronics use them, and a supermarket, a bookshop or a grocer may.

| Module | Applies to (starts on) | Needs | Permissions |
|---|---|---|---|
| `exchanges` "Exchanges" | fashion and electronics (on); supermarket, books, grocery (off) | sales, inventory | `exchanges.view / create / export` |

Template grants: Manager everything; Cashier view and create; Accountant and Viewer view and export.

| Table | What it holds |
|---|---|
| `business_exchanges` | One exchange: `original_document_id` (a sale), `return_id` (its credit note, which must be on that sale: trigger), `new_document_id` (the replacement sale), snapshots `returned_value`, `new_value`, `credit_applied`, `collected`, `refunded`, and `method` (cash, card, upi, bank, `on_account`, `voucher`, or NULL when even), reason, request key + hash. `no_bill` marks an exchange made without the bill (a gift): the return still goes on a real sale of that item, the most recent one within the policy. `credit_collection_id` points at the collection that keeps credit on account. Never edited or deleted (trigger). |
| `business_exchange_policies` | Per business: `days_allowed` (1–365, NULL = no limit; 30 when there is no row). Changed with `settings.edit`. |
| `business_exchange_vouchers` (+ `_uses`) | Exchange credit as a numbered voucher (`CV` and 6–10 digits), walk-ins included, spent at the counter until `expires_on` (set from `voucher_valid_days`); what is left after that lapses. A voucher is never deleted, its amount never changes and `used` only grows. A use never changes. |

Rules:

- **An exchange is one transaction.** It posts a core return (credit note, restocked or not) on the original sale and a core sale for the replacements (priced by the server, offers included). It moves the credit the return created on the original sale onto the new bill, as a refund on the original and a payment on the new bill, both with method **`credit_note`**: no cash moves. Then the difference is collected (needs `sales.edit`; a walk-in pays it all), or the surplus is refunded (needs `sales.refund`), kept on account for a known customer, or given as a voucher. An exchange is allowed within the policy days. Its parts take request keys derived from the exchange's own, so a retry cannot post twice, and a refusal anywhere leaves nothing. A quote runs the same transaction and rolls it back. `businessReturns.service.js › postReturn` posts the return inside the caller's transaction.
- **Credit kept on account** is written as a refund by credit note on the original sale, plus a collection (method `credit_note`, reference = the credit note, number from the `collection` series) left unallocated: the customer's advance. A later bill can use it through receivables' *apply advance*, or, also where the receivables module is off, from Exchanges › Exchange credit kept on account (`POST exchanges/credits/:contactId/use`, needs `exchanges.create` and `sales.edit`). Each use is a credit-note payment pointing at that collection.
- **A voucher** takes the credit off the original sale as a credit-note refund, and is spent later as a credit-note payment on a new bill, recorded as a voucher use.

### Purchase orders and receipts

Purchase orders serve every business with Purchases (permissions `purchasing.*`), though their tables are named `wholesale_purchase_*`.

| Table | What it holds |
|---|---|
| `wholesale_purchase_orders` (+ `_lines`) | An order to a supplier: number from the `purchase_order` series (PO), the godown the goods are to come into, the supplier, the expected date, the estimated value, and a status: draft → sent → part_received → received, or closed (the rest will not come) or cancelled, with who, when and why. A line holds the stock-unit quantity and the pack it was asked in, the cost asked (the last purchase price by default), its GST, what has been received and what was closed (`received + closed ≤ quantity`), and why it is on the order (typed in, a reorder suggestion, or customers' back-orders). |
| `wholesale_purchase_receipts` (+ `_lines`) | What came in against an order. Each receipt is an ordinary core purchase (`business_documents`, kind `purchase`), so stock, payables, GST and the supplier's ledger work as for any purchase. A receipt row never changes. |

Events: `purchase_order.raised`, `sent`, `received`, `closed` and `cancelled`.

### Stock

- **Lots.** `business_stock_lots` holds stock per location, item and lot (`lot_code`: a batch, a serial number, or empty for loose stock), with `expires_on`, `quantity` (never below zero) and `unit_cost` (weighted).
- **The ledger.** `business_stock_movements` has exactly one source: a document, an adjustment or a transfer (`num_nonnulls(…) = 1`; a return is a document movement that also names the return). For every lot, the sum of its movements equals its quantity; the tests check this after transfers and counts.
- **Corrections.** `business_stock_adjustments` are reasoned corrections of a lot. Opening stock typed with a new item is one, with the reason "Opening stock".
- **Transfers.** `business_stock_transfers` (+ lines). Dispatch takes the stock off the sending lot (movement −) and the goods are *in transit*. Receiving adds them to the same batch at the destination (movement +, weighted cost, same expiry; a serial cannot be in stock twice). Cancelling puts them back into the very lots they left. Status, who closed it and why are constrained together.
- **Counts.** `business_stock_counts` (+ lines). A sheet lists the lots at one location, with one open count per location (partial unique index). Counted quantities are entered over time. Approval compares each count with the stock *at that moment*, so sales made during the count are not counted twice, and posts every difference as a reasoned `business_stock_adjustments` row linked to the count (`count_id`).

### Money

- **Payment methods.** Every money row (`business_payments`, `business_refunds`, `business_collections`, `business_supplier_payments`, `business_collection_refunds`) keeps the kind in `method` and the business's own name in `method_name` ([`business_payment_methods`](#3-business-tenant)). The accounts count the kind.
- **Expenses.** Module `expenses` "Daily expenses" (every type but the restaurant, on; permissions `expenses.view / create / approve`). `business_expenses` is money already paid for running costs at one location: date, category (rent, utilities, wages, transport, supplies, cleaning, maintenance, other), description, amount, payment method, request key. An expense is never edited or deleted; it is reversed once, with a reason that is really there (`expenses.approve`).
- **Cash checks.** `business_cash_checks` is a drawer counted for one day and location: the opening cash, the cash movement, the expected cash (opening + movement) and the counted cash. The difference (counted − expected) needs a reason when it is not zero. A check is a permanent snapshot; a new check corrects it. Recording one needs `reports.edit`.
- **Cashier shifts.** `business_counter_shifts` is a cashier's shift at one counter location: the float, then at close the cash movement, the expected and counted cash, and the difference (a reason when it is not zero). There is one open shift per person and location. Only the closing count is ever recorded on a shift, and a closed shift never changes.

What Daily money adds up, and the rules of the cash check and the cashier shift, are in [BUSINESS_RULES.md](BUSINESS_RULES.md).

## 5. Type extensions

Industry-specific data goes in tables named `<type>_*`, for example `pharmacy_prescriptions`, `salon_plans` and `electronics_warranties`; a clinic's are `health_*` and `lab_*`. Each one:

- carries `business_id BIGINT NOT NULL` and composite foreign keys to the core rows it hangs off (`(business_id, sku_id) → catalog_skus`, `(business_id, document_id) → business_documents`, …);
- is enabled by a `platform_modules` row of kind `optional` that applies to that type, so capability checks and plans work unchanged;
- never adds columns to core tables for one type's sake. Descriptive attributes may use `catalog_skus.attributes`, but money, quantities, relationships and anything filtered on are typed columns.

## Cross-cutting: the event outbox

`business_events (business_id, kind, entity_type, entity_id, payload, actor_id, created_at, published_at)` gets one row for every committed change to money, stock or appointments, and for the other events each section lists, **in the same transaction** as the change. A kind reads `<entity>.<what happened>`. The core kinds are `sale.posted`, `purchase.posted`, `payment.recorded`, `sale.returned`, `purchase.returned`, `sale.refunded`, `purchase.refunded`, `supplier_payment.recorded`, `stock.adjusted`, `stock_transfer.dispatched` / `received` / `cancelled`, `stock_count.posted` and `appointment.booked` / `completed` / `cancelled` / `no_show`. If the change rolls back, so does its event; if the event cannot be written, the change fails.

Nothing consumes the outbox. The planned consumer ([BACKLOG.md](BACKLOG.md), "Live updates through the outbox") reads unpublished rows in id order (partial index `business_events_unpublished`), delivers them (live screens, webhooks, accounting exports) and stamps `published_at`. A trigger allows only that one stamp, once, and unpublished events cannot be deleted. Every consumer must filter by `business_id`.

`business_audit` records who did what, in the same transaction as the change.

## Shared receivables

Customer credit, collections and outstanding. Retail udhaar and wholesale outstanding are **one model**: the same rows serve both. Nothing here is type-specific; a type's extras hang off it.

| Table / column | What it holds |
|---|---|
| Module `receivables` | "Collections & outstanding". It applies to every type but the restaurant, and starts on for wholesale and every goods shop (grocery, supermarket, books, pharmacy, fashion, electronics, meat and other weight-based shops); a salon and a clinic start without it. Needs `sales` and `contacts`. Permissions `receivables.view / create / approve / export / print`; `approve` is credit control (bounce a cheque, settle a salesperson's cash, let an order through a credit hold). |
| `business_collections` | One receipt of money from a customer: `collection_no` (series kind `collection`, prefix `RC`), location, customer (`contact_id`, which must be a customer: trigger), `amount`, `method` (cash, card, upi, bank, cheque, credit_note) and `method_name`, `reference`, `notes`, request key + hash, who and when. Immutable once posted. |
| `business_payments.collection_id` | The money from a collection that settles a particular sale is an ordinary `business_payments` row pointing back at its collection, so every balance, refund and report rule works unchanged. A trigger keeps Σ payments of a collection ≤ its amount. |
| Unallocated part | `amount − Σ allocated payments` is the customer's **advance / on-account credit**. It lowers the customer's balance and can later be applied to bills, oldest first. |
| `business_collection_cheques` | A cheque taken on a collection: number, its own date (post-dated allowed; it cannot be deposited before that date), bank, and status received → deposited → cleared, or bounced (from received or deposited) with the reason and the bank charge owed. It only moves forward and is never deleted (trigger). |
| `business_collection_refunds` | Money of a collection handed back: only to the customer who paid it, by cash, UPI or bank, approved by a manager with their PIN and a reason, numbered from the receipt it comes out of (`RC/2627/0012-R1`). With what was put against bills, it never passes what was collected (also a database rule). Append-only. A salon client's advance and a repair job's advance are refunded this way. |

Wholesale adds the salesperson and route on a collection (`wholesale_collection_details`).

Rules:

- **The balance** is the contact balance ([Contacts and balances](#contacts-and-balances)). The credit-limit check at a sale, and at a wholesale order, uses it.
- **Allocation** of a collection: either named bills with amounts, or automatic, oldest due first. Never more than a bill's outstanding amount; the rest stays on account.
- **Ageing** groups each customer's debt by the age of each bill in days; the group edges are the business's `ageing_days` (30, 60 and 90 by default). It takes every open item (the opening balance on its date, each sale's outstanding amount on its date) and applies the customer's unallocated credit to the oldest items first. *Overdue* = past the bill's `due_on` (from credit days).
- **Statement**: the opening balance before the period, then sales (debit), returns and credit notes, payments and collections (credit), and refunds (debit), with a running balance.
- **A bounced cheque** takes its receipt out of the customer's account. The bill settlements it made are removed from `business_payments` and kept on the cheque row (`reversed_allocations`), so those bills open again, and the bank charge is added to what the customer owes. The charge (₹500 by default, editable on each bounce) and the credit hold after repeated bounces (2 in 90 days by default) come from `wholesale_settings`, with those defaults when a business has no row ([Wholesale / FMCG](#wholesale--fmcg)).
- **Udhaar.** Retail uses these tables, endpoints and screens; there is no second ledger. Shops see the word *Udhaar* (the menu words in `apps/business-web/src/services/businessNav.js`).
- Events: `collection.recorded`, `collection.applied`, `collection.refunded`, `collection.reversed` (a bounce) and `customer.credit_hold`, with audit rows in the same transaction.

## Retail: grocery / kirana, supermarket, books & stationery

Retail uses the shared core for everything it can (catalogue, units, sales documents, payments, stock, number series, shared receivables) and adds only what a shop counter needs. Tables shared by the shop types are named `retail_*`; the books type alone has `books_*`. Offers and loyalty serve garment and electronics shops too.

**Modules** (`platform_modules`, both optional):

| Module | Applies to (starts) | Needs | Permissions |
|---|---|---|---|
| `offers` "Offers & discounts" | grocery, supermarket, books, fashion, electronics (off; recommended for a supermarket and a garment shop) | sales, catalog | `offers.view / create / edit` |
| `loyalty` "Loyalty points" | grocery, supermarket, books, fashion (off; recommended for a supermarket and a garment shop) | sales, contacts | `loyalty.view / create` (redeem on a bill) `/ edit` (rules, corrections) `/ export` |

Udhaar is the shared `receivables` module ([Shared receivables](#shared-receivables)), on from the start for every goods shop. Scale codes belong to the core `weight` module and book details to the core `books` module. Template grants: Manager everything; Cashier `offers.view`, `loyalty.view` and `loyalty.create`; Accountant and Viewer view and export.

| Table | What it holds |
|---|---|
| `retail_offers` | One offer: `kind` (`item_percent`; `item_amount`, ₹ off each unit; `category_percent`, the category and its sub-categories; `bill_percent`; `bill_amount`; `buy_x_get_y`, buy X of an item and get Y more at `value` % off, 100 = free; `product_percent`, a markdown on one style, see [Fashion](#fashion)), the item, category or product it is for (composite FKs), `value`, `buy_quantity` / `get_quantity`, `min_bill_amount` (the bill before any discount), `max_discount` (most per bill), `starts_on` / `ends_on`, `days_of_week` (ISO 1–7, NULL = every day), `starts_time` / `ends_time` (business time zone, may run past midnight), `active`. CHECKs tie each kind to the fields it needs. A **coupon** is an offer with a `coupon_code` (unique in the business): it applies only when the code is given, and `usage_limit` and `per_customer_limit` cap its uses. |
| `retail_sale_discounts` | Per sale line, what it was given and why: `source` (`offer` with `offer_id`, `points`, `manual` for the counter discount, and `membership` and `package` for a salon), `label` (the offer's name at the time: a snapshot) and `amount` in the document's price terms. **Append-only** (trigger). |
| `retail_loyalty_settings` | One row per business: spend `earn_per_amount` → earn `earn_points`; `point_value` (₹ a point is worth); `min_redeem_points`; `max_redeem_percent` of a bill; `return_spent_points` (points spent on a bill come back when its goods are returned; on by default); `active`. |
| `retail_loyalty_entries` | `earn` (whole points for a sale), `redeem` (negative, with the ₹ `value` it took off the bill), `adjust` (a reasoned correction with a request key), `reverse` (points a return took back, linked to the return, with `shortfall_points` / `shortfall_value` for points already spent) and `restore` (spent points given back on a return, with their value). One earn and one redeem per sale, and at most one of each kind per return (partial unique indexes). A customer's points are the plain sum of their entries; a constraint trigger refuses any entry that would leave the sum below zero. **Append-only.** |
| `retail_credit_reminders` | Udhaar reminders: customer, `channel` (WhatsApp, SMS, call, visit, other), the `balance` owed at the time (a snapshot), `promised_on`, note, who and when. |
| `retail_scale_items` | A loose item's 5-digit code on the shop's label scale (`plu_code`, unique per business). A trigger allows it only on an item sold in a weight unit. |
| `business_locations.sells_at_counter` | Whether a location is a till. A warehouse is not, so Quick bill does not offer it. |
| `books_titles` | Typed, searchable book details per item: `isbn` (always ISBN-13; a CHECK with a real check-digit function, `books_isbn_valid`; unique per business), `author`, `publisher`, `edition`, `language`, `published_year`. Saving details also mirrors ISBN, author and publisher into `catalog_skus.attributes`. |
| `books_sets` (+ `_items`) | A school booklist: a named set of items added to a bill in one scan. |
| `books_customer_orders` | A customer's order for a book not in stock, with any advance kept as a numbered collection (the customer's advance). An order only moves forward and is never deleted. |

**How a sale is priced** (`modules/business/retail/services/businessOffers.js`, called from the core posting, `business.service.js › postDocument`, so the Sales screen, Quick bill and any later POS get the same result):

1. The core prices each line (`businessPricing.js`): a price rule when the core `wholesale` module is on ([Wholesale / FMCG](#wholesale--fmcg)), else the location's own price or the item's price. A loyalty customer pays the member price when it is lower. Packs are priced as packs. Lines with fixed prices (a dispatched wholesale order) take no offers, counter discount or points.
2. Offers running at the time of the sale (active, in their dates, today's weekday, inside their time window) whose minimum the bill reaches before any discount. A coupon's offer counts only on the bill its code was given for.
3. Each item gets **one** item offer: the one worth most to the customer. Lines of the same item are taken together (buy 2 get 1 works across scans). An offer's "most per bill" cap holds across every item it applies to. A kit's components take no item offer of their own.
4. Then **one** bill offer, the one worth most, on what is left.
5. Then the counter discount, when one is given ([Documents](#documents)).
6. Then the loyalty points the customer redeems: at least the minimum, at most their balance and `max_redeem_percent` of what they pay. Points are worth `point_value` off the **bill total** (converted to before-GST shares when prices exclude GST).
7. Discounts are spread over lines in proportion to their value, with the rounding carried forward, so the shares add up to the paisa. They reduce the taxable value (a discount given at the time of sale). Then GST is worked out on what is left, then the business's round-off.

A salon adds its package and membership discounts after these ([Salon & spa](#salon--spa)), and a garment shop sets each line's GST rate by its price ([Fashion](#fashion)), before GST is worked out.

The line's `net` and `tax` are the discounted figures, and `unit_price × quantity − Σ retail_sale_discounts = taxable value` holds for every line (with prices before GST; with prices including GST the same holds for the gross). A **quote** (`POST /retail/quote`) runs the very same posting code and returns before anything is written. Offer amounts are in the same terms as the selling prices (including GST when prices include it).

**Points.** A sale with a customer earns `floor(total ÷ earn_per_amount) × earn_points`. Redemption needs `loyalty.create`. **Points never go below zero.**

- A return takes back, in its own transaction, the points its sale earned, in proportion to the value returned so far. This is cumulative, so a sale returned in parts gives back exactly what it earned.
- They come off the points the customer holds first. If the customer has already spent them, the spent part is the *shortfall*: its value (points × point value) is recorded on the `reverse` entry and **kept back from any refund on that sale**. Where no refund is paid out (an udhaar bill, an exchange that moves the credit to a new bill), the shortfall is written off and stays visible in the points history.
- Points *spent* on a bill come back on a return the same way, in proportion to the value returned so far (a `restore` entry), while `return_spent_points` is on. The refund for the goods is what the customer paid after the points, so nothing is paid twice. With the setting off, spent points stay spent.
- Sales, returns and corrections lock the customer's row (sales and returns after the business row), so a return and a redemption at the same moment queue. The database trigger is the backstop.

**Udhaar** is the shared receivables: balances, ageing, collections settling the oldest bills first, advances and statements. Retail adds the reminder book. A promised date already past while the customer still owes is shown as a broken promise.

**Barcodes.** An item without a barcode can be given an in-store EAN-13: `200` + item number + check digit. A scale label is EAN-13 `21 PPPPP WWWWW C` (scale code, grams, check digit); scanning it bills that item at that weight, converted to the item's weight unit. Books scan by their ISBN-13.

Events, in the same transaction as the sale or correction: `loyalty.earned`, `loyalty.redeemed`, `loyalty.reversed`, `loyalty.restored` and `loyalty.adjusted`. Audit: `offer.created / updated`, `loyalty.rules_updated`, `loyalty.adjusted`, `udhaar.reminded`, `catalog.barcodes_assigned`, `catalog.scale_code_set / removed` and `book.updated`.

## Wholesale / FMCG

Orders from trade customers, dispatched in part or in full with an invoice each time; back-orders, routes, beats and salespeople.

| Module | Applies to (starts) | Needs | Permissions |
|---|---|---|---|
| `sales_orders` "Sales orders & dispatch" | wholesale (on) | sales, contacts, inventory | `sales_orders.view / create / edit / approve / cancel / export / print` |
| `wholesale` "Wholesale price lists" (core) | wholesale (on); grocery, supermarket, pharmacy, meat and other weight-based shops (off) | sales, contacts | `wholesale.view / edit` (price rules) |

For `sales_orders`: *create* takes and changes orders, *edit* sets up routes, beats and salespeople, *approve* dispatches (raises the invoice and moves stock), and *cancel* cancels an order, closes a line or closes an order's back-order. Template grants: Manager all; Cashier / sales view, create and print; Stock keeper view, approve (dispatch) and print; Accountant view, export and print; Viewer view and export. Credit control is `receivables.approve` ([Shared receivables](#shared-receivables)); claims need `purchasing.edit`.

| Table | What it holds |
|---|---|
| `wholesale_salespeople` | Field staff who take orders and collect money (name unique per business, ignoring case), with their login (`user_id`) and `monthly_target`. |
| `wholesale_routes` | A delivery run, optionally with the godown (`location_id`) its van loads from. |
| `wholesale_beats` | Shops on a route visited on one ISO weekday (`visit_day`, NULL = any) by one salesperson. |
| `wholesale_customer_beats` | Each customer's one beat (PK business + contact; customer-only trigger). Orders and collections default to its route and salesperson. |
| `wholesale_customer_profiles` | A trade customer's price group, contact person, state and PIN (the place of supply when they have no GSTIN), PAN, FSSAI, trade or walk-in (walk-ins stay out of order and collection lists), and `hold_exempt` (never put on credit hold). |
| `wholesale_settings` | The business's credit rules: `hold_overdue_days` (hold new orders once a bill is that many days past due; NULL = no hold), `bounce_charge` (₹500), and `bounce_hold_count` / `bounce_hold_days` (2 bounces in 90 days put the customer on hold). With no row, these defaults apply. |
| `wholesale_orders` | A sales order: `order_no` (series kind `sales_order`, prefix `SO`), dispatching location, customer (+ name snapshot), salesperson, route and beat, `status` open → part_dispatched → dispatched, or closed (short) / cancelled with who, when and why; `tax_mode`, subtotal, tax and total at the order's prices; request key + hash. |
| `wholesale_order_lines` | A snapshot of each line: item label, stock unit, quantity in stock units, price per stock unit (4 places), `list_unit_price`, `discount_percent`, tax rate, net, tax, the price rule or scheme used (`scheme_id`), and what was typed in a pack (`entered_unit / _quantity / _unit_price`, `unit_factor`: all or none). A free line is ₹0 and names the line that earned it (`free_of_line_id`). Only `dispatched_quantity` and `closed_quantity` ever change (trigger), only upwards, and `dispatched + closed ≤ quantity`. Never deleted. |
| `wholesale_order_edits` | An order changed before dispatch: the lines taken off and added, the totals before and after, and the reason. |
| `wholesale_hold_releases` | A credit hold let through by someone with credit control, with the reason. |
| `wholesale_dispatches` | One dispatch = one tax invoice: `document_id` → the sale in `business_documents` (unique), vehicle number, notes, request key + hash. It also holds the delivery challan's own number (`challan_no`, `challan_series_id`, from the location's `delivery_challan` series, DC), the transporter, LR and e-way bill (12 digits, with its date), and the delivery stage: out for delivery → delivered, part returned (a sales return) or refused. |
| `wholesale_dispatch_lines` | Which order line each invoice line came from (`document_line_id` unique) and the stock-unit quantity. One invoice line per batch picked. |
| `wholesale_delivery_runs` | One van, many orders, one load sheet. |
| `wholesale_collection_details` | Salesperson and route on a shared `business_collections` receipt. |
| `wholesale_settlements` (+ `_receipts`) | A salesperson's evening settlement for a day: what each method brought, the cash handed over and the difference (a note when it is not zero). Each receipt is settled once; a settlement is fixed once saved. |
| `business_price_rules.unit_code` | Slab prices **per pack**: when set, the minimum and the price count that pack (composite FK to the item's `catalog_sku_units`, so the pack must exist for that item). An active slab is unique per item, customer, pack and minimum. |
| `wholesale_price_groups`, `wholesale_group_prices` | Price groups (retailer, wholesaler, modern trade, HoReCa…) with dated prices, per pack or per unit. A trade customer belongs to at most one group. A new price ends the old one the day before it starts, so every price keeps its history. |
| `wholesale_schemes` | Buy N (cases or pieces) get M free, and/or a discount %, for a period, for everyone or one group. The free goods may be another item (`free_sku_id`, counted in `free_unit_code`), and `no_slab` stops a scheme stacking on a slab price. |
| `wholesale_claims` | Claims on suppliers (scheme, damage, expiry, rate difference, shortage, other): open → submitted → settled or rejected. |

Rules:

- **Pricing** (server). A sale line is priced by `businessPricing.js`; an order line also looks at price groups (`businessWholesalePricing.service.js`). The order of choice: the customer's own price first, then their group's price for the day, then a slab for all customers, then the list price. A rule for the pack the line is entered in beats a per-unit rule, and the highest slab reached prices every unit. A pack price is exact per pack; the per-unit price is derived (4 places on the order line, 2 on the invoice line, which also keeps the exact pack price in `entered_unit_price`).
- **Schemes** are applied by the server when an order is taken, and shown on the invoice.
- **When stock moves: at dispatch, never at order.** A dispatch posts an ordinary sale through the core posting (`postDocument`), so the number series, stock ledger, credit-limit check, `sale.posted` event and audit are the core's. Lines are picked **oldest expiry first** (expired batches never), or from the batches named. A line split over batches becomes one invoice line per batch; whole packs stay in packs on the invoice.
- **Invoice amounts** are the order's, allocated by quantity cumulatively: each dispatch takes `round(order amount × sent so far ÷ ordered) − already invoiced`. Each invoice line is complete in itself. Its GST is worked out on its own value to the paisa, and its rate is its value per stock unit, to four places when two would not match. `business_document_lines.unit_price` is a `NUMERIC` without a fixed scale, checked to at most four places: every rate written with two places (all ordinary sales and purchases) reads back with two, such as `120.00`, and only a dispatch line carries four (50 × ₹7.3334 = ₹366.67). With prices before GST, the shared amount is the taxable value, so the lines add up exactly to the order's net; GST rounded per line can then differ from the order's estimate by at most 1 paisa per extra invoice line the order was split into. With prices including GST, the shared amount is the gross, so what the customer pays adds up exactly to the order. Rounding to the rupee applies per invoice as usual. Retail offers never touch a dispatch: the core receives the prices in `fixed` and uses them as given.
- **Credit limits** are checked twice: when the order is taken (balance + value of orders not yet sent + this order) and when each dispatch is invoiced (the core rule: balance + this invoice).
- **Credit hold.** A customer is on hold for new orders when a bill is past due by `hold_overdue_days` (when set), or when they reach the bounce limit. Their order is refused (409, reason `credit_hold`) unless someone with `receivables.approve` lets it through with a reason: the person taking the order if they hold the permission, else a manager who types their own PIN. Each release is kept with the order (`wholesale_hold_releases`) and in the activity log. A customer marked `hold_exempt` is never held.
- **Changing an order** before it goes: an unchanged line keeps its price; a changed line has its unsent part closed and a new line added at today's price (schemes and credit are checked again); a line left out is closed. What was already sent never changes.
- **Back-order** = ordered − dispatched − closed, for orders still open or part-dispatched. Closing an order sets `closed_quantity` to what was left (status `closed` if something was sent, `cancelled` if nothing was).
- **Locks:** business row, then order, then order lines, then stock lots, the same order as every other posting. Repeating a request key returns the first result; the same key with different content is a 409.
- Events: `sales_order.placed`, `sales_order.edited`, `sales_order.line_closed`, `sales_order.dispatched` (with the invoice), `sales_order.closed`, `sales_order.cancelled`, `dispatch.<stage>` and `salesperson.settled`, plus the core `sale.posted` and `payment.recorded`, and `collection.recorded` / `collection.applied` from receivables.

## Fashion

A garment shop sells through the core. Each size and colour is an ordinary item (`catalog_skus`), so the counter, purchases, transfers, counts and returns all work per variant.

The shop's modules: `variants` (the size × colour matrix; on), `exchanges` (on; [Exchanges and vouchers](#exchanges-and-vouchers)), `offers` (off, recommended: markdowns run on it) and `loyalty` (off, recommended), both in [Retail](#retail-grocery--kirana-supermarket-books--stationery). The core `weight` module applies but starts off; fabric sold by the metre can switch it on. `variants` also applies to supermarkets, electronics, books and salons.

| Table | What it holds |
|---|---|
| `fashion_variants` | One row per variant item: `(business_id, sku_id)` → `catalog_skus`, `product_id` → `catalog_products`, `size`, `color`, `fabric` ('' when none), `size_rank`. Unique per product on lower(size, colour, fabric). A trigger keeps the row on its own item's product and works out `size_rank` (`fashion_size_rank`: XS…5XL, then numbers such as 28/30/32 and "2-3Y", then other words, free size last). The item itself (code `PREFIX-COL-SIZE`; a typed barcode or an in-store EAN-13 `200` + item number; price, tax, stock) is an ordinary core row. |
| `fashion_gst_price_slabs` | GST on clothing by price: one row per business with a per-piece `threshold` (₹2,500), `rate_low` (5 %) and `rate_high` (18 %). It covers every size × colour variant and any categories chosen (`category_ids`, with their sub-categories). The rate is worked out on each sale line from the piece's value before GST, after discounts. Changed with `settings.edit`. |
| `retail_offers`, kind `product_percent` | A markdown: a % off every size and colour of one style (`product_id`) until a date. The shelf price is never rewritten, so the price reverts by itself when the offer ends. Markdowns use `offers.create` and `offers.edit`. |

**Variant codes.** Each colour (and fabric) of a product has one code part: kept from its existing variants, typed (`colorCodes`), or the shortest free run of its letters (Blue BLU, Blush BLUS). A new product needs its own prefix; `addVariants` also takes `codePrefix`.

Events: `exchange.posted` and `voucher.issued`, with `sale.refunded` / `payment.recorded` for the credit-note moves.

## Electronics

An electronics shop sells serial-numbered units through the core: the serial register is the core `serials` module (on), exchanges are on ([Exchanges and vouchers](#exchanges-and-vouchers)), and offers apply but start off.

| Module | Applies to (starts) | Needs | Permissions |
|---|---|---|---|
| `warranties` "Warranties" | electronics (on), supermarket (off) | serials, sales | `warranties.view / create / cancel / export / print` |
| `repairs` "Repairs & service" | electronics (off; recommended) | sales, inventory | `repairs.view / create / edit / approve / cancel / export / print` |
| `finance` "EMI & finance" | electronics (off; recommended) | sales | `finance.view / create / edit` |

Template grants: Manager everything; Cashier warranties view, create and print, repairs view, create, approve (deliver) and print, and finance view and create (sell on EMI); Stock keeper warranties view and repairs view and edit (fits parts, moves status); Accountant view, export and print, and finance edit (payouts); Viewer view and export. Faulty units use `inventory.view` / `inventory.edit`; warranty claims use `repairs.view` / `repairs.edit`.

| Table | What it holds |
|---|---|
| `electronics_models` | Per serial-tracked item: `model_number`, `serial_kind` (`imei` = checked, `serial` = any text), `warranty_months` (0–120), `warranty_terms` and the brand's `helpline`. |
| `electronics_serial_details` | A unit's second IMEI (Luhn-checked, unique in the business) and a note. |
| `electronics_warranties` | Registered from a sold serial line: document, line, item, `serial` and item snapshots, customer name and phone, `phone_digits` (the last 10 digits, for lookup), `starts_on`, `months`, `ends_on` (= start + months − 1 day, CHECK), terms, and `status` active / cancelled (+ reason, who, when). One active warranty per line (partial unique index). A trigger insists the line is that sale's line for that item and serial, and allows only the one-way cancellation afterwards. |
| `electronics_repair_jobs` | The job card: `job_no` (series kind `repair_job`, prefix `RJ`), location, customer (contact optional; name, phone, `phone_digits`), device (catalogue item optional, description always), serial, `warranty_id` + `under_warranty`, problem, accessories, condition, a damage `checklist`, the device's `passcode` (cleared when the job closes: CHECK), estimate, promised date, technician, `status` (received, diagnosing, waiting_parts, in_repair, awaiting_approval, ready, delivered, cancelled), `advance_collection_id`, `document_id` (the delivery bill), `delivered_at`, `delivery_key`, `closed_reason`, request key + hash. Delivered or cancelled jobs never change (trigger). |
| `electronics_repair_lines` | Parts (goods, with batch or serial when tracked) and labour (service items) at the price the customer pays. They change only while the job is open (trigger). |
| `electronics_repair_events` | Status history (from, to, note, who, when). Append-only. |
| `electronics_faulty_units` | A dead-on-arrival or faulty unit held for the supplier: status awaiting_supplier → sent (on a purchase return), restocked or written off. A trigger refuses selling it while it waits. It links the replacement unit, the exchange and the purchase return. |
| `electronics_warranty_claims` | What a warranty repair is claimed back from the brand: raised → submitted → approved or rejected → credited (with the amount). |
| `electronics_financiers` | The financiers an EMI sale goes through, each with its dealer `subvention_percent` (0–30). An electronics shop starts with Bajaj Finserv, HDFC Bank, ICICI Bank and Home Credit. |
| `electronics_finance_cases` | The financed part of one bill: financier, loan number, tenure, down payment, financed amount, and status pending → settled or cancelled. A case moves only one way and is never deleted. |
| `electronics_finance_settlements` | A financier's payout for one or more cases, net of the dealer subvention. Kept as recorded. |

Database guards on `business_stock_lots` (constraint trigger `electronics_serial_lot_rules`, for serial-tracked items of every business): a serial lot holds at most one unit; the same serial is in stock at no more than one location at a time (the sum over its lots ≤ 1), under an advisory lock on (business, number) so concurrent inserts cannot break this; when a number is first received for an `imei` model it must be a valid IMEI (`electronics_valid_imei`: 15 digits, Luhn); and one number cannot be recorded under two items.

Rules:

- **The serial lifecycle is read, not stored.** In stock (where), on the way (transfer dispatched, to where), sold (bill, customer), returned by the customer (back in stock), back to the supplier, written off: all come from the unit's lots and its latest movement, so they always agree with stock.
- **Warranty.** Only for a sold serial line not fully returned; it starts between the sale date and today, and its months default from the model. A sale of a serial unit whose model has warranty months registers the warranty in the same transaction when a customer with a phone (or the walk-in `buyer`) is known. Its state is worked out when read: in warranty, ending within 30 days, expired, not started, unit returned, cancelled.
- **Repair.** A serial with a live, unreturned warranty marks the job under warranty (lines then default to price 0). Status moves only along the allowed steps. **Stock moves only at delivery**: the job must be ready, and its lines become a sale bill (`postDocument` with the job's own prices, GST the business's way) with the payment taken. A part not in stock at the job's location refuses the delivery, and nothing changes. A job with nothing on it is delivered without a bill. Cancel = returned unrepaired, nothing billed.
- **Repair advance.** An advance is a customer collection (`advance_collection_id`), credited on the final bill. What is left when a job is cancelled, or after delivery, is handed back through `business_collection_refunds` ([Shared receivables](#shared-receivables)).
- **EMI.** The financed part of a bill is a payment of method `finance` on it: the customer's bill is settled, and the financier owes that amount (`electronics_finance_cases`). A payout settles cases net of the subvention. When the financier cancels after a return, a refund of method `finance` reverses the financed payment.
- Events, in the same transaction: `exchange.posted`, `warranty.registered`, `warranty.cancelled`, `repair.received`, `repair.status_changed`, `repair.delivered`, `repair.cancelled`, `electronics.unit_faulty`, `finance.case_opened`, `finance.case_cancelled` and `finance.payout_received`.

## Salon & spa

A salon hangs off the shared core. Its services are catalogue items of kind `service`; stylists and rooms are `business_resources`; bookings are `business_appointments`; bills are ordinary sales (`business_documents`, posted by the core `postDocument`); deposits are shared receivables collections (`business_collections`), kept as the client's advance. Its own tables are `salon_*`.

| Module | Applies to (starts) | Needs | Permissions |
|---|---|---|---|
| `packages` "Packages & memberships" | salon (off; recommended) | sales, contacts | `packages.view / create` (plans) `/ edit` (change plans, cancel a client's unused plan) `/ export` |
| `commissions` "Staff commissions" | salon (off; recommended) | sales, appointments | `commissions.view / edit` (rules) `/ export` |

The core `appointments` module (on for a salon) holds the calendar. Template grants: Manager everything; Cashier `packages.view`; Accountant and Viewer view and export. Booking rules are edited with `settings.edit`, service times with `catalog.edit` and stylist skills with `appointments.create`. Letting a booking through outside the hours needs `appointments.approve` (Manager). Taking a deposit or putting an advance on a bill needs `sales.edit`, because it is money on a sale.

| Table | What it holds |
|---|---|
| `salon_settings` | One row per salon: suggested `deposit_percent`, `free_cancel_hours`, `late_cancel_fee_percent`, `no_show_fee_percent`, calendar `opens_at` / `closes_at`, the service item fee bills are raised on (`fee_sku_id`, created on first use), and `session_commission_basis` (a package session earns commission on the package's price per session, or on the service's list price). |
| `salon_services` | Per service item (trigger: must be a service): `duration_minutes`, `buffer_minutes` (clean-up; the stylist is busy for it too) and `needs_room`. Without a row a service takes 60 minutes. |
| `salon_resource_profiles` | Whether a resource is a stylist (`staff`) or a `room` (no row = stylist), and a stylist's usual hours (`works_from`, `works_to`) and weekly days off (`weekly_off`). |
| `salon_staff_week` | A stylist's hours on a weekday where they differ from usual: other hours, or a day off. |
| `salon_staff_leave`, `salon_holidays` | A stylist's leave; the days the salon is closed (one location or all). |
| `salon_booking_overrides` | A manager's approval to book outside the hours, on leave or on a holiday: the rule broken and the reason. Append-only. |
| `salon_staff_skills` | The services a stylist does (none = every service). A room cannot hold skills (trigger). |
| `salon_appointment_details` | Per booking: `room_id`, `price_at_booking` (the snapshot a fee is worked from), `deposit_collection_id`, `fee_document_id`, `bill_document_id`, notes, request key + hash, and arrival, confirmation and reminder times, how often it was moved, and the walk-in mark. Price and deposit are fixed; a rescheduled booking may move to another room; the fee and the bill are set once (trigger). |
| `salon_walk_ins` | The waiting strip: clients who walked in. |
| `salon_client_profiles`, `salon_client_notes` | The client card: the profile, and notes and colour formulas (append-only). |
| `salon_plans` (+ `salon_plan_services`) | A package (sessions of services) or a membership (`service_discount_percent`, `product_discount_percent`), `validity_days`, sold through its own service item (`sku_id`, so it goes on a bill with GST). CHECKs tie each kind to its fields. |
| `salon_client_plans` (+ `_services`) | What a client bought: a snapshot of the plan (name, price paid, discounts, sessions per service) with the bill and bill line that sold it, `starts_on`, `ends_on` (set by the server to the sale day + validity − 1), and status active / cancelled (+ who, when, why). Afterwards only the one-way cancellation and a later end date may change (trigger); extending a plan needs `packages.edit` and a reason. The session snapshot is append-only. |
| `salon_package_redemptions` | A session used: client plan, service, quantity, and the bill line it paid for (unique). Append-only. A constraint trigger keeps sessions used (net of returned lines) ≤ sessions bought. |
| `salon_membership_uses` | The membership discount given on a bill line (%, amount). Append-only. |
| `salon_commission_rules` | `resource_id` (NULL = everyone), `applies_to` (service, goods, or `plan`: a package or membership sold), `sku_id` (NULL = all of that kind), a `percent` or a `flat_amount` per item, active. One active rule per exact scope (partial unique index); the item must match the kind (trigger). |
| `salon_line_staff` | Who did each bill line (PK the line), the booking it came from, the rule used, the line's kind (service, goods, plan, or `session`: a service paid from a package), `commission_percent`, `commission_base` and `commission_amount`: a snapshot, append-only. |
| `salon_commission_plans`, `salon_commission_slabs`, `salon_commission_schemes` | Monthly target (slab) commission plans on the month's net service sales, and the plan each stylist is on from a month. |
| `salon_commission_payouts`, `salon_tips` | Commission paid out (printed as a slip) and tips. Both append-only. |
| `salon_service_products`, `salon_backbar_usage` | The products a service uses, and what each billed service took from stock at the latest purchase price (append-only). |
| `salon_deposit_releases` | A held deposit moved to the client's wallet with a manager's approval (append-only). |

**How a salon bill is priced** (`modules/business/salon-weight/services/businessSalonSales.js`, called by the core posting right after retail offers, so the Bills screen, New bill, a quote and any later POS agree):

1. A line selling a package or membership plan needs the client, one per line. The client's plan is created when the bill posts, and starts that day.
2. A service line marked to use a package (`clientPlanId`) is paid by sessions: the whole line comes off as a `package` discount, with no GST on it (GST was charged when the package was sold). The package must be the client's, active, inside its dates, hold that service and have the sessions left (lines of the same bill count together).
3. Every other line of a client with an active membership gets the membership's % (services and products separately; the best active membership) on what is left after any offer.
4. Discounts go into `retail_sale_discounts` and reduce the taxable value; then GST and rounding follow. `unit_price × quantity − discounts = taxable value` holds as for retail.
5. A line may name the stylist (`staffId`) and the booking (`appointmentId`). With commissions on, the rule is chosen most specific first: this stylist + this item, this stylist + the kind, everyone + this item, everyone + the kind. A plan sold is its own kind (`plan`); a session paid from a package uses the service rules and earns on the session's value (`session_commission_basis`). Commission = the rule's % of the line's taxable value, or its flat amount per item, kept as a snapshot. Returned quantities take commission back in proportion in the reports.

**Bookings.** A booking blocks the stylist (and its room) for the service time plus clean-up. It is refused when:

- the stylist or the room is already booked then (checked by the service, with rows locked in the order business, stylist, room);
- the stylist lacks the skill, the service needs a room and none is given, or the room is at another location than the stylist;
- it falls outside the calendar's hours or the stylist's hours, on the stylist's day off or leave, or on a salon holiday, unless a manager lets it through (`salon_booking_overrides`).

A deposit is a numbered collection (`RC/…`) with nothing put against bills: the client's advance. For a salon, the generic `POST /appointments` and `PATCH /appointments/:id` run these same rules (the end time sent is ignored; the service time plus clean-up is used), so no screen or client can skip them.

**The no-show / late-cancellation rule.** Cancelling at least `free_cancel_hours` before the start is free. A later cancellation keeps `late_cancel_fee_percent`, and a no-show `no_show_fee_percent`, of the price when booked, **only ever out of the deposit**, never more than what is left of it, in whole rupees. The charge is a numbered sale on the fee item (GST worked out of the charge) paid from the deposit collection; the rest of the deposit stays the client's advance. No deposit, no charge.

**When a booking may change.** A no-show is allowed only once the booking's start time has passed; done (and billing, which marks it done) only on the booking's own day or later, in the business's time zone. Cancelling is always allowed. The rule is one function (`statusAllowed` in `business.service.js`), used by the salon status, the salon bill and the generic appointment status.

**The salon bill** (`POST /salon/bills`) posts the sale through the core. In the same transaction it puts the client's advances (oldest first) against it when asked, takes the payment for the rest (up to three ways to pay, and tips, one per stylist), and marks the named bookings done and billed. A booking is billed once and goes on one line of the bill: a second line with the same booking is refused, so a package session is never used twice for one visit. Cancelled and no-show bookings cannot be billed. Cancelling a client's plan is refused once a session or a membership discount was used. The bill line that sold a plan can be returned (credit note, refund) only after the plan is cancelled (trigger on `business_return_lines`). With the `packages` module off, a plan's item cannot be sold at all; it would otherwise be a plain service and the client would get nothing. Repeating a bill request returns the first bill and the advance it applied.

**Held deposits.** A deposit whose booking is still to come (booked, start in the future) is kept for that booking: *Use deposit / advance* skips it unless that booking is on the bill, so a later no-show can still be charged from it. A manager can release it to the client's wallet early (`salon_deposit_releases`), and a client's advance is refunded through `business_collection_refunds`. The shared receivables *apply advance* (`/receivables`) does not know bookings; a salon starts without that module.

**Reports.** Commission by stylist (bills, services done, package sessions, service and product sales after discounts and returns, plan sales, commission after returns) and per bill line.

Events, in the same transaction: `appointment.booked / completed / cancelled / no_show` (with room, deposit and fee), `appointment.arrived`, `appointment.moved`, `walk_in.added`, `collection.recorded` (deposit), `collection.applied`, `package.sold`, `membership.sold`, `package.redeemed`, `package.extended`, `membership.extended`, `package.cancelled`, `membership.cancelled`, `commission.earned`, `commission.paid`, `tip.recorded`, `backbar.used` and `deposit.moved_to_wallet`, plus the core `sale.posted` and `payment.recorded`. Audit: `salon.rules_updated`, `salon.service_timed`, `salon.staff_updated`, `package_plan.created / updated`, `membership_plan.created / updated`, `commission_rule.created / updated`, and the same actions as the events.

## Weight-based shops

A meat, fish or other weight-based shop sells through the core: items stocked in kg or g, three-decimal quantities, g ↔ kg on the line, the Quick bill's weigh buttons (`business_settings.weight_buttons_grams`) and scale labels ([Retail](#retail-grocery--kirana-supermarket-books--stationery)). Cutting and wastage move stock as reasoned corrections (`business_stock_adjustments`), so the stock ledger keeps exactly one source per movement and "sum of movements = lot quantity" keeps holding. Tables are `weight_*`, shared by meat shops (`meat`) and other weight-based shops (`weight_retail`).

| Module | Applies to (starts) | Needs | Permissions |
|---|---|---|---|
| `processing` "Cutting & yield" | meat, other weight-based shops (off; recommended) | inventory, weight | `processing.view / create` (batches) `/ edit` (yield templates) `/ export` |
| `wastage` "Daily wastage" | meat, other weight-based shops (on); grocery, supermarket (off; recommended for a supermarket) | inventory | `wastage.view / create / export` |

The core `weight` and `batches` modules are on for both types. A meat or weight shop may switch on the core `wholesale` module for customer rates per kg (a hotel's own rate), through the shared price lists. Template grants: Manager everything; Cashier `wastage.view` and `wastage.create`; Stock keeper `processing.view / create / export` and `wastage.view / create / export`; Accountant and Viewer view and export.

| Table | What it holds |
|---|---|
| `weight_yield_templates` (+ `_outputs`) | What a whole input normally gives: the input item, each cut and its `expected_percent`. Every item must be stocked in a weight unit (trigger); the cuts add up to at most 100 % (deferred constraint trigger). |
| `weight_processing_batches` | One cutting: `batch_no` (series kind `processing`, prefix `CP`), location, template, input item and lot, snapshots of the input (label, unit, quantity, unit cost, value), `input_kg`, `output_kg`, `loss_kg` (CHECK output + loss = input), the input's correction, who cut it (`cut_by`), the input's supplier, whether it was cut to order at the counter, notes, request key + hash. Append-only. |
| `weight_processing_outputs` | Each cut: item, the lot it went into, quantity, `kg`, `cost_share`, `unit_cost`, the expected % from the template, and its correction. Append-only. |
| `weight_wastage_entries` | One write-off: location, item, lot, quantity, `kg` (NULL for counted items), `reason` (trimming, spoiled, unsold, drip_loss, damaged, other; other needs a note), `unit_cost` and `value` snapshots, its correction (unique), request key + hash. Append-only. |
| `weight_rate_history` | Every change of a weighed item's selling price (the daily rate board). Append-only. |
| `weight_pack_sizes` | The weight of one pouch, when loose stock is repacked and sold by the piece. |
| `weight_pickup_orders` (+ `_lines`) | Phone and WhatsApp orders for pickup at a time. |
| `weight_day_closes` | The end-of-day weigh-up. Append-only. |

**Cutting** (`POST /weight/processing`). The input batch must be stocked by weight, not expired, and hold the weight. Every cut must be stocked by weight, and the cuts may not weigh more than the input (compared in kg; g items convert). In one transaction: a `CP` number, the input taken out of its lot (a correction), and each cut put into stock (a correction). A batch-tracked cut goes into a new batch named after the cutting number with the input's use-by date; an untracked cut goes into its loose stock at weighted average cost.

**Cost.** The input's cost (quantity × lot cost) is shared by the cuts in proportion to their selling value (weight × list price; by weight when there are no prices), with the rounding carried so the shares add up to the paisa. Loss carries no cost, so the cost per usable kg rises with the loss. A cut priced ₹0 (bones, trimmings) carries no cost next to priced cuts; the priced cuts carry it all.

**Wastage** (`POST /weight/wastage`) takes the weight out of one batch at once, valued at that batch's cost.

**Reports.** Yield by input item (batches, kg in, cuts, loss, yield %, expected % weighted by input, cost per kg in and per usable kg), by cut (share of the input against expected, cost carried, cost per kg) and by day. Wastage by item (with what sold in the same period, and wastage as % of sold + wasted), by reason and by day.

Events, in the same transaction: `processing.posted`, `wastage.recorded`, `rates.changed`, `pickup_order.created` and its status changes, and `weight.day_closed`. Audit: `yield_template.created / updated` and the same actions as the events.

## Pharmacy, clinic and lab

The rules follow standard Indian practice and are to be reviewed by a pharmacist, a doctor and a legal adviser before going live ([BUSINESS_RULES.md › Pharmacy, clinic and lab](BUSINESS_RULES.md#pharmacy-clinic-and-lab)). Every look at clinical data is written to `business_audit` by the service.

| Module | Applies to (starts) | Needs | Permissions |
|---|---|---|---|
| `pharmacy` | pharmacy (on) | sales, batches, contacts | `pharmacy.*` |
| `patients` | clinic, type `healthcare` (on) | contacts, appointments | `patients.*`, including `patients.view_clinical` and `patients.edit_clinical` |
| `lab` | clinic (off; recommended) | patients, sales | `lab.*` |

Type roles: Pharmacist (pharmacy); Doctor, Lab technician and Pathologist (clinic). The Doctor is the only template that reads clinical notes, and the Pathologist approves lab reports with their PIN. A Manager runs the pharmacy and registers patients, but does not read clinical notes or approve reports.

Shared by both types:

| Table | What it holds |
|---|---|
| `health_settings` | One row per pharmacy or clinic: drug licences, retention, the near-expiry window (a pharmacy's own, in place of `business_settings.near_expiry_days`), the lab's details, the consent notice, the referral commission. |
| `health_signatories` | The people who sign: registered pharmacists, doctors and pathologists with their registration numbers. They sign by PIN. |
| `health_counters` | The patient, visit, lab order, sample and debit-note numbers. |
| `health_files` | Prescription scans (JPEG, PNG, WebP or PDF), kept in the private upload folder (`PRIVATE_UPLOADS_DIR`). |

### Pharmacy

| Table | What it holds |
|---|---|
| `pharmacy_drugs` | The drug master on a catalogue item: salt, strength, form, maker, schedule (none, G, H, H1, X, narcotic), pack, loose sale, cold chain. |
| `pharmacy_prescriptions`, `pharmacy_register_entries` | The prescription behind a Schedule H, H1 or X sale (doctor, registration number, date, the scan) and the H1 and Schedule X register lines it writes. Both append-only. A trigger refuses a prescription medicine on an ordinary sale. |
| `pharmacy_recalls` | A recalled batch. Its buyers are found from the sales that took it; the batch is blocked, and a trigger refuses selling or moving it. |
| `pharmacy_debit_notes` (+ `_lines`) | Expiry and breakage returns to the distributor and the credit that settles them. Lines are append-only. |
| `pharmacy_location_licences` | A branch's own drug licences, printed on its bills. A location with no row uses the business-wide numbers in `health_settings`. |

Events: `pharmacy.dispensed`, `pharmacy.recall_opened` and `pharmacy.debit_note_sent`.

### Clinic and lab

| Table | What it holds |
|---|---|
| `health_patients`, `health_consents`, `health_patient_clinical` | A patient on a contact; the consent the DPDP Act asks for (kept as given; only its withdrawal is recorded, once; never deleted); the clinical card. |
| `health_visits`, `health_visit_notes`, `health_prescription_items` | A consultation (vitals, diagnosis, follow-up), its notes (append-only) and its prescription (open only until the visit is completed). A completed visit is kept as written. A visit belongs to one branch (`location_id`): the doctor's, else the one the front desk works at. It records the fee it was billed (`fee_kind`: consultation, follow-up or free follow-up, and `fee_sku_id`). |
| `health_doctor_profiles` | A doctor's consultation and follow-up services, follow-up days, slot length and share of the fees. |
| `health_doctor_sessions`, `health_doctor_leave` | OPD sessions by weekday, with the most patients per session; a doctor's leave. A doctor is booked within their sessions and not on leave. |
| `health_tokens` | The day's queue: a token per patient and doctor (waiting, called, in consultation, done, or skipped or cancelled), priority first, numbered per location, doctor and day. A patient holds one live token (waiting, called or in consultation) per doctor a day. |
| `lab_tests`, `lab_parameters`, `lab_reference_ranges`, `lab_profile_tests` | Tests with their parameters, ranges by sex and age band (critical limits too), and profiles of tests sold together. |
| `lab_orders`, `lab_order_tests`, `lab_samples`, `lab_results` | An order's tests, its samples with barcodes, and its results, which cannot change once the order is approved or cancelled. An approved report is reissued by amendment: `lab_orders.version` and `amend_reason`. |
| `lab_report_versions` | Every signed report as it was signed (results, ranges, flags, who signed), numbered 1, 2, …; from version 2 each carries the reason for the amendment. Never changed or deleted. |
| `lab_qc_materials`, `lab_qc_runs` | Control materials per parameter (lot, level, target mean and SD), and each run with its z-score, the Westgard rules it broke and its outcome. A run is never changed. While a parameter's latest run today is rejected, patient reports with that parameter cannot be signed. |

Events: `visit.opened`, `visit.completed`, `lab.order_created` and `lab.report_ready`.

## Tasks, issues & projects

One model for every business type and the restaurant, keyed on `business_id` ([ARCHITECTURE.md › 4.3](ARCHITECTURE.md#43-tasks-issues--projects-one-model-for-both-worlds)):

| Table | What it holds |
|---|---|
| `platform_task_categories` | The shared categories (opening and closing, cleaning, food safety, maintenance, stock check, audit, hiring…). |
| `business_task_templates` (+ `_items`) | A business's own templates. The built-in library of checklists and project plans is code (`modules/tasks/library`). |
| `business_tasks` (+ `_assignees`, `_items`, `_comments`, `_files`, `_history`) | A task with who it is for, its checklist answers (section, checkbox, yes / no, number, text, photo, signature, choice), comments, photos and files, and its history (append-only). |
| `business_task_schedules` | Recurring tasks. Each day's task is made once, however often it is asked for. |
| `business_issues` | Issues raised by hand, by a failed answer, or from a restaurant's log book entry. |
| `business_projects` (+ `_members`, `_milestones`, `_lists`) | Projects, who sees them, their milestones and lists. |

Where and who differ by world: a restaurant's outlet, employee or role; a business's location, resource or business role. A trigger (`business_task_world_check`) refuses a pointer outside the business. The modules are `tasks`, `issues` and `projects`: on from the start for a restaurant ([Restaurant features](#restaurant-features)) and off for every other type. Tasks is recommended for a supermarket, a pharmacy and a clinic, and issues for a supermarket and a pharmacy. Permissions are `tasks.*`, `issues.*` and `projects.*`, with the actions assign, review and manage. A day's tasks follow the day cut-off: the restaurant's own, or `business_settings.day_cutoff_hour`. Events: `task.assigned`, `issue.reported` and `issue.assigned`.
