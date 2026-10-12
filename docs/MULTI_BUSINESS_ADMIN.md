# Business Admin

Updated 6 October 2026 (Phase 1 of the Business Management Platform). Business
Admin is the one admin application for every business a person belongs to.
Words used here are defined in [NAMING.md](NAMING.md); the database is
explained in [BUSINESS_PLATFORM_DATA_MODEL.md](BUSINESS_PLATFORM_DATA_MODEL.md).
Plans, subscriptions and the platform admin are later phases; the database is
already shaped for them.

## Opening a business: the switcher

- The header of every screen has a **business switcher** (name and type icon,
  with search). It lists the businesses the signed-in person is a member of.
- Picking the **signed-in restaurant** shows the restaurant admin exactly as
  before (`/`, `/pos`, `/menu/…`). Picking **any other business** opens its
  Business Admin at `/business-admin/<business id>/…`, with a menu built from
  that business's modules and the person's permissions: a salon without stock
  transfers never sees Transfers; a Viewer never sees "New sale".
- The choice is **remembered per person on the server**
  (`business_memberships.last_opened_at`), so the next sign-in lands in the
  same business. The URL carries the business, so links and reloads open the
  same business. The server re-checks the membership, the module and the
  permission on every request; an ID in the URL grants nothing.
- `/business-admin` goes to the last business opened; `/business-admin?all=1`
  lists them all (with *Link my restaurant* and, in development, *Set up demo
  businesses*). The old `?business=<id>` links still work.
- Switching with an unsaved form open asks first.
- A screen opened by its address follows the same rules as the menu: without
  the module or permission it says why, and a screen of another business type
  (a salon's `/counter`, a kirana's `/salon-bill`) says *Not available for this
  business type*.
- Inside a business the header shows the person's role in that business.

## The menu of a business

| Group | Screens (each needs its module and a permission) |
|---|---|
| Overview | Today's and this month's sales **after returns** (each return on its own day, as Reports count them), **customers owe (net)** — every customer's balance as Udhaar / Outstanding show it: opening balances and bills, less payments and advances, with "owed − advances" and any unpaid walk-in bills underneath — to pay, low stock, expiring batches, transfers in transit, today's appointments, quick actions, the modules in use, and what this type has and what is still to come for it (from [REMAINING_BACKLOG.md](REMAINING_BACKLOG.md)) |
| Sales | Sales (Bills for salons and clinics), Customers (Clients / Patients), Appointments, Staff & rooms (Stylists & rooms / Doctors & rooms), Wholesale prices |
| Purchases | Purchases, Suppliers |
| Products | Products & services (named per type), Categories, Units & pack sizes |
| Stock | Stock on hand, Stock movements, Transfers, Stock counts |
| Reports | Reports, Activity log |
| Settings | Business settings (with Modules), Tax rates, Number series, Locations |
| Staff & access | Staff & access, Roles & permissions |

Every list is the shared DataGrid with S.No., server paging and search; lists
that grow (sales, purchases, movements, transfers, counts, appointments,
activity) open on the current month with a date range. Export and print
buttons appear only with the matching permission.

## What each screen does (Phase 1)

- **Sales / purchases** — post with server-side prices (tax-exclusive or
  -inclusive per the business setting, optional rounding to the rupee), lines
  in the stock unit or a pack size, batch/serial picking, optional payment
  taken with the sale, customer credit-limit check, due date from credit days,
  document numbers from the location's series. Each document shows its
  payments, returns (credit/debit-note numbered) and refunds, and prints as a
  plain invoice with the business's GSTIN and footer.
- **Customers / suppliers** — GSTIN (check-character validated), credit
  limit, credit days, opening balance, and what each owes now.
- **Products** — category, GST slab, unit, tracking (quantity, batch & expiry,
  serial), reorder level, type attributes (variants, ISBN, model…).
- **Categories** — a tree up to five levels. **Units & pack sizes** — units
  with conversions (g ↔ kg) and per-item packs (strip of 10, box of 24).
- **Stock** — on hand by location and batch with average cost and value;
  corrections need a reason. **Movements** — the ledger with its reason for
  every change. **Transfers** — dispatch, in transit, confirm arrival or
  cancel. **Counts** — a sheet per location, counted over time, approved by
  someone with `stock_counts.approve`; differences against the stock at
  approval become reasoned corrections.
- **Appointments** — booking without double-booking, done / no-show / cancel. A
  booking can be marked **no-show only once its start time has passed**, and
  **done (or billed) only on its own day or later**; a booking still to come is
  cancelled or moved instead (the same rule on the salon calendar and the
  generic `PATCH /appointments/:id`).
- **Business settings** — legal name, GSTIN, address, prices including or
  excluding GST, rounding, financial-year start, date format, footers, and the
  **Modules** switches (within what the business type allows; dependencies
  are enforced). **Tax rates** — named GST slabs (nil, 5 %, 18 %, 40 % seeded),
  rate fixed once created. **Number series** — prefix, digits and next number
  per location, document and financial year (≤ 16 characters).
  **Locations** — a location with stock or transfers in transit cannot close.
- **Staff & access** — give a person from your staff list a role here,
  change it or switch it off. **Roles & permissions** — the six standard roles
  (each business has its own copies) and your own roles, edited on a module ×
  action matrix. You cannot give what you do not have; the Owner role cannot
  be handed out or changed.

## Roles

| Role | May do |
|---|---|
| Owner | Everything, including staff access (full access, also to future permissions) |
| Manager | Everything except staff access |
| Cashier / sales | Sales, collections, printing; add customers; book and complete appointments; see products, stock and price lists |
| Stock keeper | Products, receiving purchases, stock corrections, counts (not approving them), transfers (send and receive) |
| Accountant | See everything, record payments and collections, export and print; no stock changes |
| Viewer | See and export everything; change nothing |

Existing memberships were mapped owner → Owner, manager → Manager, viewer →
Viewer; nobody gained or lost access.

## API (all under `/api/businesses`, login required)

| Path | Methods |
|---|---|
| `/` | GET the person's businesses (directory), POST `/development-demos`, POST `/link-restaurant` |
| `/:id/context` | GET business, role, permissions, modules, settings, locations (what the menu is built from) |
| `/:id/open` | POST remember this business as last opened |
| `/:id/summary`, `/:id/reports?from&to` | Overview figures; money events by posting day |
| `/:id/<list>` | GET lists with `limit`, `offset`, `q` (search), `from`/`to` (period) and list filters: `catalog`, `categories`, `units`, `pack-sizes`, `contacts`, `pricing`, `locations`, `tax-rates`, `number-series`, `resources`, `stock`, `movements`, `documents` (`kind`), `transfers`, `counts`, `appointments`, `audit`, `members`, `roles` |
| `/:id/settings` | GET, PUT |
| `/:id/modules`, `/:id/modules/:code` | GET, PUT `{ enabled }` |
| `/:id/tax-rates`, `/:id/number-series`, `/:id/locations` | POST; PATCH `/:rowId` |
| `/:id/categories`, `/:id/units`, `/:id/pack-sizes`, `/:id/catalog`, `/:id/contacts` | POST; PATCH `/:rowId` |
| `/:id/pricing` | POST; DELETE `/:ruleId` switches a price off |
| `/:id/documents` | POST (sale or purchase, optional `payment`); GET `/:docId`; POST `/:docId/payments`, `/returns`, `/refunds` |
| `/:id/stock/:lotId/adjustments` | POST a reasoned correction |
| `/:id/transfers` | POST; GET `/:transferId`; POST `/:transferId/receive`, `/cancel` |
| `/:id/counts` | POST; GET `/:countId`; PATCH `/:countId/lines`; POST `/:countId/post`, `/cancel` |
| `/:id/resources`, `/:id/appointments` | POST; PATCH `/appointments/:apptId` status |
| `/:id/permissions`, `/:id/roles`, `/:id/members`, `/:id/member-candidates` | Access management (member candidates leave out people already on this business's staff list) |

A business the person is not a member of answers 404. A module that is off,
or a permission the role lacks, answers 403 with a sentence naming it.
Database rules (a duplicate, a cross-business reference, a trigger refusal)
answer 409/400 with a readable message.

## Setting up locally

1. Back up the database and verify the restore (`npm run db:backup -- --verify` in `backend`).
2. Apply the migrations (`npm run migrate:up`).
3. Set `MULTI_BUSINESS_DEVELOPMENT=true` in the backend `.env` and restart the API.
4. Run `npm run business:demos -- --user-id <admin id> --sample-data` for
   eleven demo businesses with realistic (fictional) catalogues, customers,
   suppliers, purchases, sales, a return, a transfer in transit, an open count
   and appointments, plus each type's extras (below). The **Set up demo
   businesses** button only creates the empty demos; the sample data comes from
   this command.

   Demo businesses are named after their owner ("Demo · Grocery & kirana —
   Asha Rao"), so two people's demo sets are told apart; an older demo with
   the plain name is renamed, a name the tester chose is kept.

   The command is **safe to run again, on a demo in any state**: empty,
   holding the one-item placeholder (`DEMO-001`) an earlier version made,
   half-written by a run that stopped, or complete. Every step finds what is
   already there by its natural key — categories, contacts, staff, plans,
   routes and offers by name; items by code (books also by ISBN) — and posts
   each purchase, sale, payment, return, collection, order, booking, cutting
   batch and wastage entry with a request key made from the business and the
   step (`scripts/demo-common.js`), so a posting that exists is skipped. A
   group of postings already made without those keys (by an earlier version,
   or by the tester) is left as it is. Only the person's own demos are
   touched, and the sample never changes or uses a tester's own records
   (only sample customers and suppliers, by their fictional names). Sample
   batch codes carry the whole item code (`B2610-CH-CUR`).

## Tests

```powershell
npm.cmd test --prefix backend
npm.cmd run test:integration --prefix backend   # includes business-admin and business-foundation
npm.cmd run lint --prefix frontend
npm.cmd run build --prefix frontend
```

`tests/integration/business-foundation.test.js` covers the Phase 1 rules:
provisioning, the module catalogue in the database, each template role's
allowed and refused actions, no escalation through roles, settings isolation
and tax-inclusive pricing with rounding, number series under 12 concurrent
postings (no duplicates, no gaps, a failed posting gives its number back),
events written and rolled back with their transaction, transfers and counts
reconciling with the ledger, category trees, exact pack conversions, credit
limits and list search/period filters. `business-admin.test.js` keeps covering
the earlier increment (isolation, weighted stock, serials, expiry, returns,
refunds, wholesale prices, appointments).

## Still to do

Phase 2 built retail, wholesale, fashion, electronics, salon and weight-based
shops (sections below). What is left — integrations, hardware, plans and the
platform admin, pharmacy and clinic rules, the event publisher, and the gaps
left inside each built module — is kept in one place:
[REMAINING_BACKLOG.md](REMAINING_BACKLOG.md). The full endpoint reference is
[API.md](API.md); the tables are in [DATABASE.md](DATABASE.md).

No regulated clinical or dispensing workflow is claimed. Demo records are fictional.

## Wholesale / FMCG and collections (Phase 2, T2)

Menu (each needs its module and permission; a grocery calls the two
receivables screens **Udhaar** and **Udhaar collections**):

| Screen | Where | What it does |
|---|---|---|
| Sales orders | Sales | Orders from shops for the current month (date range, tabs *To dispatch / Dispatched / Closed / All*). New order: customer, godown, salesperson (defaults from the customer's beat), lines in units or packs ("3 case = 216 each", with stock on hand); the server prices them (customer price, then slab, per pack when ordered in packs) and checks the credit limit against what they owe plus orders not yet sent. The order shows what was sent, what is still to send and the invoices raised. **Dispatch**: send all or part; stock leaves oldest expiry first and a tax invoice is raised at the order's prices; the rest stays a back-order. **Cancel order / Close the back-order** with a reason. Print order slip. |
| Back-orders | Sales | Every order line still to send, oldest first, with stock now at the dispatching godown (shaded when short), filter by route. |
| Outstanding (Udhaar) | Sales | Each customer's balance with 0–30 / 31–60 / 61–90 / 90+ day buckets and the overdue amount, totals over every row, *Owing / Overdue / Advances / All*, sort, route filter (wholesale). **Account**: open bills with their age and due date, advances, *Record collection*, *Put advance against bills*, **Statement** (date range, running balance, print, export). |
| Collections (Udhaar collections) | Sales | Numbered receipts (`RC/2627/0001`) for the period with the amount put against bills and any advance left; filter by method. New collection: customer, amount, cash / UPI / bank / cheque (number required) / card, salesperson and route (wholesale), and *oldest bills first*, *bills I choose* or *keep as advance*. Receipt detail and print. Receipts are never edited. |
| Routes & salespeople | Sales | Tabs: beats (route, weekday, salesperson, customers), customers on beats (put a customer on a beat), routes (godown the van loads from), salespeople. |
| Wholesale reports | Reports | By salesperson, route or customer (orders taken, invoices, invoiced, returns, net sales) for a period; collections by day, method, salesperson and route; outstanding now by route or salesperson. |
| Price lists | Sales | A slab can now be **per pack** ("5 cases or more: ₹2,050 a case"). |

Rules a person will notice: taking an order moves no stock; a dispatch is the
tax invoice; an invoice raised from an order uses the order's prices even if
the list price changed since; a customer over their credit limit cannot be
given a new order or a new invoice until they pay; money collected settles
the oldest bills first (an old opening balance first of all), and what is not
needed for bills is shown as an advance and already lowers what they owe.

API (under `/api/businesses/:id`):

| Path | Methods |
|---|---|
| `/sales-orders`, `/back-orders`, `/salespeople`, `/routes`, `/beats`, `/customer-beats`, `/collections` | GET lists (`limit`, `offset`, `q`, `from`/`to` where dated, filters: orders `status` (comma-separated), `contact`, `salesperson`, `route`; back-orders `route`, `salesperson`, `contact`, `sku`; collections `contact`, `method`) |
| `/sales-orders` | POST `{ locationId, contactId, salespersonId?, beatId?, expectedOn?, notes?, requestKey, lines: [{ skuId, quantity, unit? }] }`; GET `/:orderId`; POST `/:orderId/dispatch` `{ requestKey, vehicleNo?, notes?, lines: [{ orderLineId, quantity, unit?, lots?: [{ lotId, quantity }] }] }`; POST `/:orderId/close` `{ reason }` |
| `/salespeople`, `/routes`, `/beats` | POST; PATCH `/:rowId`; PUT `/customer-beats/:contactId` `{ beatId \| null }` |
| `/collections` | POST `{ locationId, contactId, amount, method, reference?, notes?, requestKey, allocations?: [{ documentId, amount }], salespersonId?, routeId? }` (no `allocations` = oldest first, `[]` = advance); GET `/:collectionId` |
| `/outstanding` | GET (`show` = owing / overdue / advance / all, `sort`, `q`, `route`, paging; returns `totals`) |
| `/receivables/customers/:contactId` | GET account; GET `/open-bills`; GET `/statement?from&to`; POST `/apply-advance` `{ requestKey }` |
| `/wholesale-reports` | GET `group` = customer / salesperson / route / collections (`from`, `to`) or outstanding (`by` = route / salesperson) |

Sample data: `npm run business:demos -- --user-id <id> --sample-data` adds,
once, to the demo wholesale business three salespeople, two routes with four
beats, five retailers (two with old opening balances), three batch-tracked
FMCG items sold by the case with per-case slabs and two batches each, nine
orders (sent in full, in part, closed short, cancelled, waiting), invoices
aged 12–110 days, and four collections (cash, cheque, UPI, an advance).

Tests: `tests/integration/business-wholesale.test.js`.

### Wholesale pro pass (7 Oct 2026, builder D)

Migration `1791580000000_wholesale-pro-cheques-dispatch-schemes.sql`; tests
`backend/tests/integration/business-wholesale-pro.test.js`.

- **Receipts** say what went against bills, against the opening balance and
  what is a true advance (the figure that used to read "advance left").
- **Cheques**: date (post-dated allowed), bank, in hand → deposited → cleared,
  or bounced: the receipt stops counting, its bill settlements are taken back
  (kept on the cheque and in the log) and the bank charge is owed. Collections
  has a *Cheques* tab; Outstanding shows cheques in hand.
- **Salesperson settlement** per day (cash handed over, short / excess with a
  note), and *Enter receipts* several at a time.
- **Orders**: searchable customer and item pickers, cases + pieces, line
  discount and free goods (`sales.discount` or `wholesale.edit`), repeat last
  order, the customer's dues on the form, **credit hold** with a manager's
  PIN, **change order** before dispatch, drop one line's remainder.
- **Price groups** with dated prices and *revise by %*; **schemes**.
- **Dispatch** screen: board, pick list, delivery runs with a load sheet and
  every invoice printed at once; transport and **e-way bill** on the invoice;
  delivered / part returned / refused (van returns post a sales return).
- **Customer trade details** on the customer form; walk-ins kept out of
  orders and collections; place of supply from the customer's state.
- **Salespeople**: login, monthly target, invoiced and collected this month,
  today's beat sheet.
- **Overview**: orders to dispatch, back-orders, collected today by
  salesperson, overdue, cheques, vans on the way, today's beats.
- **Sales list**: order, salesperson, route, delivery columns and filters;
  *View* instead of *Open*. *Record collection* on a sale opens the shared
  collection form with that bill.
- **Products / Stock**: pack price and stock in packs; empty batches hidden by
  default, *Expiring in 90 days*, expiry as "3 Jun 2027".
- **Claims on suppliers** register.
- Demo (`--sample-data`): seller details and rupee rounding where none were
  set, a Retailers price group, a noodles scheme, trade details and a 60-day
  credit hold.


## Retail: grocery / kirana, supermarket, books & stationery (Phase 2, T1)

Menu additions (each needs its module and permission; *Quick bill*, *Udhaar*
and *Retail reports* show for grocery, supermarket and books businesses):

| Screen | Where | What it does |
|---|---|---|
| Quick bill | Sales | The counter. Scan a barcode, a weighing-scale label (bills the weighed quantity) or a book's ISBN, or search by name. Loose items have 250 g / 500 g / 1 kg / 2 kg buttons; batch items take the earliest-expiry batch (changeable). Every figure is the server's quote: offers on each line (chips), *Customer saves*, GST, round-off. Pick or add the customer (phone search) for udhaar and points; redeem points within the rules. Pay by cash (change worked out), UPI, card, or **Udhaar** (with an optional part payment). After posting: bill number, change to give back, savings, points earned, *Print receipt* (72 mm till receipt with what each line saved and GST by rate). |
| Udhaar | Sales | Tiles: udhaar to collect, overdue, over 90 days, 0–30 days. **Who owes** (Owing / Overdue / Paid ahead / All): balance, overdue, oldest unpaid bill, credit limit used, last reminder and promise (broken promises in red); *Collect* (settles the oldest bills first, the rest kept as an advance), *Remind* (WhatsApp with the message typed in, SMS, call or visit, with the date they promised), *Statement* (date range, running balance, print, WhatsApp). **Remind today**: overdue customers, most overdue first. **Reminders sent**: the log for a period. A button opens the numbered **Collections** (the shared receivables screen). For these shops Udhaar replaces the generic *Outstanding* menu entry, which shows the same balances. |
| Offers & discounts | Sales | Running / starts later / ended / off, each offer in words ("Buy 4 Instant noodles, get 1 free"), when it runs (dates, weekdays, hours), bills and money given away. New / edit with a picker for the six kinds. *What offers gave away* for a period, with points redeemed as their own line. Switching an offer off never changes old bills. |
| Loyalty points | Sales | The rules in words (points per ₹, value of a point, minimum, most of a bill), customers and their points (worth, earned, redeemed, corrections), the points history for a period; *Change rules*; *Correct* with a reason (never below zero). A return takes back the points its bill earned; any already spent are kept back, at their value, from that bill's refund (shown in the history and in the refund dialog). |
| Book details | Products | Books and stationery with title, author, publisher, edition, ISBN, category, price and stock; search by any of them. *Add a book* (the ISBN becomes the barcode; ISBN-10 is stored as ISBN-13; a wrong check digit is caught) and *Edit details*. |
| Barcode labels | Products | Pick items (tick several), set labels per item, choose an A4 sheet (24, 40 or 65 labels), start part-way on a used sheet, price and shop name on or off, preview, print (EAN-13 for 13-digit codes, Code 128 otherwise). *Give barcodes* to items that have none. **Weighing-scale codes** (shops with *Sold by weight*): the code each loose item has on the label scale. |
| Retail reports | Reports | **Top sellers** (sold, sales after returns, cost, margin, %; best 8 as bars), **Slow movers** (items with stock, slowest first: sold in the last 7–180 days, days since last sale, days the stock lasts), **Margin by category** (with category path and share), **Stock value** (at cost and at selling price before GST). Location filter where there are several. Export with `reports.export`. |
| Sales › a sale | Sales | Shows the offers each line got and the total saved; *Till receipt* for retail shops. |

API (under `/api/businesses/:id`):

| Path | Methods |
|---|---|
| `/retail/quote` | POST `{ locationId, contactId?, lines: [{ skuId, quantity, unit?, lotCode? }], loyalty?: { redeemPoints } }` — the bill exactly as posting would make it, nothing saved (`sales.create`) |
| `/documents` | POST a sale also takes `loyalty: { redeemPoints }`; offers apply by themselves; GET `/:docId` returns `retail: { discounts, savings, loyalty }` |
| `/retail/scan?code&locationId` | GET item by barcode, SKU code, ISBN or scale label (+ weighed quantity, usable batches) |
| `/retail/barcodes` | POST `{ skuIds }` in-store barcodes for items without one (`catalog.edit`) |
| `/retail/scale-items` | GET list; PUT `/:skuId` `{ pluCode }`; DELETE `/:skuId` (`catalog.edit`, *Sold by weight* on) |
| `/retail/reports/top-sellers`, `/category-margin` | GET `from`, `to`, `location?` (`reports.view` + `sales.view`) |
| `/retail/reports/slow-movers`, `/stock-value` | GET `days` (7–365) / `location?` (`reports.view` + `inventory.view`) |
| `/udhaar` | GET the book (`show`, `sort`, `q`, paging, `totals`); `/udhaar/reminders` GET who to remind; `/udhaar/reminder-log` GET (`from`, `to`, `contact`, `channel`) |
| `/udhaar/:contactId` | GET account + reminders; GET `/statement?from&to`; POST `/collections` `{ locationId, amount, method, reference?, notes?, requestKey }`; POST `/reminders` `{ channel, promisedOn?, note? }` (`receivables.*`) |
| `/offers` | GET list (`status`, `kind`, `q`); POST; PATCH `/:offerId` (full, or `{ active }` alone); GET `/offers/given?from&to` |
| `/loyalty/rules` | GET, PUT `{ earnPerAmount, earnPoints, pointValue, minRedeemPoints, maxRedeemPercent, active }` |
| `/loyalty/members`, `/loyalty/entries` | GET lists; GET `/loyalty/:contactId` balance; POST `/loyalty/:contactId/adjustments` `{ points, reason, requestKey }` |
| `/books` | GET list (`q`, `details` = true/false, `category`); POST a new book; PUT `/:skuId` details |

Sample data: `npm run business:demos -- --user-id <id> --sample-data` adds
once, to the demo grocery, supermarket and bookshop: offers of every kind
(running, out of hours, weekend-only, starting later, ended), loyalty rules
and welcome points, regular customers (kirana regulars on udhaar with credit
limits and old opening balances), scale codes for loose rice and dal (and
loose onions and dal at the supermarket), in-store barcodes for every item,
full book details with valid ISBNs and four new titles, a restock, 24 bills
over ten weeks (paid, on udhaar, with points redeemed), collections and
reminders (one promise already broken).

Tests: `tests/integration/business-retail.test.js` (15 checks; one covers points never going below zero — earn, spend, return, refund held back, partial returns, the database guard and a return racing a redemption; the others: modules and
grants, offer validation, best-offer rules with caps and windows, quote =
posting, discount snapshots append-only, inclusive GST, loyalty earn / redeem /
returns / corrections and permission refusals, rollback leaves nothing,
udhaar book / reminders / promises / collections / statement, barcode, ISBN
and scale-label scanning, book details, report reconciliation, and every
cross-business attempt).

## Fashion and electronics (Phase 2, T3)

| Menu | Screen | Needs |
|---|---|---|
| Products › Size × colour (fashion; "Variants" elsewhere) | Products that come in sizes and colours. **New product with sizes** creates the whole matrix at once (sizes, colours, optional fabrics, a different price for some sizes, code prefix): one SKU per variant with its own code, in-store EAN-13 barcode (printable under Barcode labels), price and stock. Opening a product shows **stock by size and colour** (colours down, sizes across; red = none left, amber = at reorder level; per location), every variant, and: add sizes or colours (missing combinations only), set prices by size or colour, **receive stock** typed into the matrix (an ordinary purchase receipt). | `variants` module; `catalog.view` / `create` / `edit`, `purchasing.create` |
| Sales › Exchanges | Exchanges by date. **New exchange**: find the bill, choose what comes back (and whether it goes back to stock), scan or pick what goes out, *Work out the difference* (the server's exact figures), then collect the difference, refund it, or keep it on a known customer's account. The policy (days after the sale) is shown and changed here. Credit a customer kept on account is listed above the exchanges and can be used on their unpaid bills in one click. | `exchanges.view` / `create`; refunding money also `sales.refund`; the policy `settings.edit` |
| Reports › Variant reports | Pieces sold (net of returns), returns, net sales before GST, stock now, stock value and sell-through per variant, and added up by size and by colour, for a period, product and location. | `reports.view`, `variants` module |
| Stock › Serial / IMEI register | Every serial-numbered unit and where it is now (in stock where, on the way, sold to whom, back to supplier, written off); filter by status and location; open a unit for its full history (receipt, transfers, sale, returns, warranty, repairs) and to record a second IMEI. A **Models** tab sets IMEI checking, warranty months and terms per model. | `inventory.view` (+ `inventory.edit`, `catalog.edit`), `serials` module |
| Sales › Warranties | **Look up** by IMEI, serial, second IMEI or phone (warranties, sold units not yet registered, repair history); registered warranties by date and status; **register** from a sold unit (start, months and terms filled from the sale and model); print a warranty card; cancel with a reason. | `warranties.*` |
| Sales › Repairs | Open jobs (whatever their date) or all jobs by date; **Take in a device** (customer, device, IMEI, problem, accessories, condition, estimate, promised date). A job page shows the status steps, parts and labour (with stock at the job's location), **Deliver and bill** (posts the bill and the payment), **Return unrepaired**, the history and a printable job card. | `repairs.*` (delivering also `sales.create`) |

API (under `/api/businesses/:id`): `fashion/products` (GET list, POST),
`fashion/products/:productId` (GET matrix), `…/variants` (POST), `…/prices`
(PUT), `fashion/reports/variants`; `exchanges` (GET list, POST),
`exchanges/quote`, `exchanges/policy` (GET, PUT), `exchanges/:exchangeId`;
`electronics/models` (GET), `electronics/models/:skuId` (PUT); `serials` (GET),
`serials/history`, `serials/details` (PUT); `warranties` (GET, POST),
`warranties/lookup`, `warranties/eligible`, `warranties/:warrantyId` (GET),
`…/cancel`; `repairs` (GET, POST), `repairs/:jobId` (GET, PATCH), `…/status`,
`…/lines` (POST), `…/lines/:lineId` (DELETE), `…/deliver`, `…/cancel`.

Demo data: `npm run business:demos -- --user-id <id> --sample-data` also adds
(once) three fashion styles with 51 variants, purchases, sales and exchanges;
and for electronics IMEI handsets, TVs and spares, a transfer in transit, sales
with registered warranties and five repair jobs at different stages
(`scripts/demo-fashion-electronics.js`).

Tests: `tests/integration/business-fashion-electronics.test.js` — module
defaults and dependencies; the matrix (codes, barcodes, size order, per-size
prices, duplicates and clashes refused, permissions, isolation); variant-level
stock and the report; exchanges even / dearer / cheaper / on account / policy
days / over-return / idempotency, and a refused exchange leaves nothing; IMEI
checking and the one-place rule in the database; the lifecycle across
locations and its history; second IMEI; warranty registration, lookup by IMEI
and phone, cancellation and loss on return; repair intake under warranty,
status steps, parts and labour, delivery refused when a part is short, billing
with GST and payment, closed jobs frozen, events; cross-business attempts.

Since the pro pass (below): warranty claims against the maker, repair
advances, WhatsApp messages per stage, the size × colour picker at the
counter, markdowns, credit vouchers and faulty / DOA units.

## Salon & spa, and weight-based shops (Phase 2, T4)

Menu additions (each needs its module and permission):

| Screen | Where | What it does |
|---|---|---|
| New bill (salon) | Sales | Services and products on one bill. Pick the client (or walk-in): their membership, packages with sessions left, deposit / advance and bookings still to bill are shown; *Add to bill* puts a booking on it. Each line has its stylist (for commission) and, where the client's package holds the service, *Pay from package* (chosen by itself; "No — charge it" to pay). Packages and memberships are sold here too. Every figure is the server's quote: membership and package discounts, GST, round-off, *Use deposit / advance*, *To pay*. Saving posts a numbered bill, puts the advance against it, takes the payment and marks the booking done. Opened from the calendar with *Bill now*. |
| Calendar | Sales | One column per stylist and per room for a day (prev / today / next, date, location), each booking drawn at its time and length (service + clean-up), a red line at now; tiles for booked, done, no-shows and cancelled, deposits held. Click a free time to book there; click a booking for its details, *Bill now*, *Done*, *No-show*, *Cancel booking* — the deposit rule is worked out by the server and said in words before it applies ("keeps ₹300 of the deposit…"). Booking: client, service (time shown), only the stylists who do it, room (required when the service needs one), date, time ("busy until 11:00"), deposit (suggested %, method). Below: the day's bookings as a list. |
| Packages & memberships | Sales | *What clients hold* (sold in the period; In use / All used / Expired / Cancelled; sessions left with a bar, membership savings, valid till; *Cancel* while unused). *Plans for sale*: packages (services × sessions, price, validity) and memberships (% off services, % off products, validity); edit (future sales only), stop selling. |
| Service times & skills | Products | *Service times* (duration, clean-up, needs a room); *Stylists & rooms* (add, stylist or room, the services each stylist does); *Booking rules* (suggested deposit %, free-cancellation hours, late-cancel % and no-show %, calendar hours, with a worked example). |
| Staff commissions | Reports | *By stylist* for a period (bills, services done, service and product sales after discounts and returns, commission after returns; totals), *Bill lines* (per line, filter by stylist, returned lines shaded), *Rules* (everyone / one stylist × services / products / one item; most specific wins; change %, switch off). |
| Quick bill (meat, weight shops) | Sales | T1's counter, now also for meat and weight-based shops: weigh buttons (250 g, 500 g, 1 kg, 2 kg — put into the item's own unit, so 0.25 on a kg item and 250 on a g item), scale labels, a kg / g switch on kg lines to type grams, price per kg; the earliest-expiry batch (a cut's batch) is picked. |
| Appointment history (salon) | Sales | The generic Appointments list, renamed for salons: every booking of the period with *Open in calendar*; booking, done, no-show and cancel happen in the Calendar (the server applies the salon rules on the generic endpoints too). |
| Stock by weight | Stock | Every item stocked in kg / g per location: on hand, value at cost, cost per unit, selling price per kg and margin, sold / cut / wasted in the last 7 days, the earliest use-by; *Low only*. |
| Cutting & yield | Stock | *Cutting batches* for the period (CP number, input and batch, kg in, cuts, loss, yield against the template, cost in, cost per usable kg; tiles). *Cut / clean*: input item and batch, weight in, a yield template that fills the expected cuts, the cuts as weighed, live loss and yield. A batch shows each cut with its share, expected %, cost carried and cost per unit. *Yield templates*: whole item → cuts with expected %. |
| Wastage | Stock | Today's and this month's wastage (kg, cost), the entries for the period (filter by reason), *Record wastage*: item, batch (oldest first, expired shown), quantity, reason (trimming, spoiled, unsold, drip / moisture loss, damaged, other with a note), the cost shown before saving. |
| Yield & wastage | Reports | Yield by item, by cut and cutting by day; wastage by item (with what sold and wastage %), by reason and by day; tiles for yield, process loss, kg wasted and its cost; location filter; export with `reports.export`. |

Rules a person will notice: a deposit for a booking still to come is kept for that booking and is not used on another bill; a booking blocks the stylist for the service and
its clean-up and cannot overlap another booking of that stylist or room; a
deposit is the client's advance and comes off their next bill; cancelling in
good time costs nothing, a late cancellation or a no-show keeps part of the
deposit (never more than the deposit) as a numbered charge; a package pays for
its own sessions until they run out or it expires; a membership discount
comes off by itself; a used package or membership cannot be cancelled;
commission is fixed when the bill is saved. Cutting moves stock the moment it
is saved; the cuts carry the whole cost of the input; wastage leaves stock at
once at the batch's cost.

API (under `/api/businesses/:id`):

| Path | Methods |
|---|---|
| `/salon/settings` | GET (`appointments.view` or `settings.view`), PUT `{ depositPercent, freeCancelHours, lateCancelFeePercent, noShowFeePercent, opensAt, closesAt }` (`settings.edit`) |
| `/salon/services`, `/salon/staff` | GET lists; PUT `/salon/services/:skuId` `{ durationMinutes, bufferMinutes, needsRoom }` (`catalog.edit`); PUT `/salon/staff/:resourceId` `{ kind, skuIds }` (`appointments.create`) |
| `/salon/calendar?date&location` | GET the day: rules, stylists and rooms, bookings with room / deposit / fee / bill, services with times |
| `/salon/appointments` | POST `{ contactId, skuId, resourceId, roomId?, startsAt, notes?, requestKey, deposit?: { amount, method, reference? } }`; GET `/:id/fee?status` (what the rule would keep); POST `/:id/status` `{ status: completed / cancelled / no_show, requestKey }` |
| `/salon/clients/:contactId` | GET memberships, packages, advance, deposits, bookings to bill, recent bills |
| `/salon/quote`, `/salon/bills` | POST `{ locationId, contactId?, lines: [{ skuId, quantity, staffId?, clientPlanId?, appointmentId? }], useAdvance?, appointmentIds?, payment?: { amount, method, reference? }, notes?, requestKey }` (quote saves nothing) |
| `/salon/plans`, `/salon/client-plans` | GET lists (`kind`, `active`; client plans `state`, `contact`, `from`/`to`); POST plans `{ kind, name, price, validityDays, taxRateId?, services? \| serviceDiscountPercent + productDiscountPercent }`; PATCH `/salon/plans/:id` (full, or `{ active }`); POST `/salon/client-plans/:id/cancel` `{ reason }` |
| `/salon/commission-rules`, `/salon/commission-lines`, `/salon/commissions?from&to` | Rules: GET, POST `{ resourceId?, appliesTo, skuId?, percent }`, PATCH `{ percent?, active? }`; lines: GET (`staff`, `kind`, `from`/`to`); report: GET |
| `/weight/stock` | GET (`location`, `low`) |
| `/weight/yield-templates` | GET, POST `{ name, inputSkuId, outputs: [{ skuId, expectedPercent }] }`, PATCH `/:id` (full, or `{ active }`) |
| `/weight/processing` | GET list (`from`/`to`, `location`, `input`); POST `{ inputLotId, inputQuantity, templateId?, outputs: [{ skuId, quantity }], notes?, requestKey }`; GET `/:id` |
| `/weight/wastage`, `/weight/wastage-today` | GET list (`from`/`to`, `reason`, `location`, `sku`), GET today and month; POST `{ lotId, quantity, reason, note?, requestKey }` |
| `/weight/reports/yield`, `/weight/reports/wastage` | GET `from`, `to`, `location?` (`reports.view` + `processing.view` / `wastage.view`) |

Sample data: `npm run business:demos -- --user-id <id> --sample-data` adds,
once (each step checks whether it ran), to the demo salon: booking rules
(20 % deposit, 4 hours free, 50 % late, 100 % no-show), seven timed services
(the facial needs a room), three stylists with skills and two rooms,
commission rules (everyone 10 % / 5 %, Priya 15 %, Neha 12 % on facials),
seven clients, sixteen bills over three weeks with stylists, two packages and
two memberships for sale, a package, a bridal package and a Gold membership
sold today and used, eleven bookings today and the next days (deposits, a
no-show charged from its deposit, a late cancellation, a haircut billed with
its deposit). To the demo meat shop: dressed chicken and whole rohu with their
cuts, three yield templates, five cutting batches over the week, weighed
counter sales (some typed in grams) and five wastage entries; to the demo
dry-fruit shop: bulk almonds sorted into almonds and broken pieces, sales and
wastage.

Tests: `tests/integration/business-salon-weight.test.js` (12 checks: modules,
grants and the widened number-series list; service times, skills, rooms,
hours and double-booking for stylist and room; deposits as advances, the
no-show and late-cancel charges out of the deposit, idempotent requests;
packages and memberships sold and used, sessions-left and expiry, the discount
snapshot and GST, quote = posting; cancelling only unused plans and returning
the plan line only afterwards; advances on the bill, bookings billed once,
commission rule precedence and returns; role refusals and every
cross-business attempt; yield templates; cutting with cost sharing, batch
naming, use-by and the ledger; selling in grams; wastage, the reports and
append-only rows; weight shops kept apart).

`tests/integration/final-business-fixes.test.js` (7 checks): demo names carry
their owner; the demo setup run twice from the placeholder / half-written
state adds nothing the second time, gives every type sales (grocery offers,
points and collections), duplicates no contact, category, offer or ISBN, and
leaves the tester's own customer and another person's demos untouched; no-show
and done refused for bookings still to come (salon and generic); one booking
per bill line, once; overview sales net of returns and customers owe = owed −
advances = Outstanding; member candidates without existing members; the page
guard's business-type rule.


### Salon & weight shops, pro pass (7 Oct 2026)

**Salon**

| Screen | What changed |
|---|---|
| Calendar | A one-line summary (to come · late · here now · done · no-show / cancelled · deposits held) instead of four tiles; **Day / Week** toggle (the week shows each stylist's bookings and busy hours per day, a day off or leave named; click a day to open it); the day opens on "now"; blocks coloured by service category, a ₹ mark for a deposit, ★ for a member, *Late — not here yet* in amber, *Here since …* in green; a stylist's leave, weekly off and hours outside their shift are hatched. **Drag a booking** to another time or stylist (15-minute steps, asks first) — moving never charges the late-cancellation fee. **Walk-in** puts a client on the waiting strip (time waited, stylist asked for); *Seat* books them from now. More › **Tomorrow's reminders**: tomorrow's bookings with *Send* (WhatsApp, marked as sent). |
| Booking dialog | Client by name or phone, with *Add a new client* on the spot; the stylist list says who is on leave or off; after booking, *Send confirmation*. On a booking: *Arrived*, *Move* (date, time, stylist, room), *WhatsApp confirmation / reminder*, *Client card*, *Book next visit*; the phone is a call link. |
| Client card | A side panel from the calendar, the bill and the history: allergies in red, membership, advance, no-shows, visits and spend, usual stylist, birthday; tabs Visits (date, service, stylist, value), Notes & formula (dated, kept), Packages, Profile (birthday, anniversary, gender, usual stylist, allergies). Call / WhatsApp / Book a visit. |
| New bill | Type a service or product (name, code, barcode) or tap a quick chip; the line takes the client's usual stylist and their package if it holds the service. Selling a membership or package the client already holds asks first. Client chips show allergies, the last colour formula, visits. **Pay by up to three ways** (UPI and the rest in cash — one bill, not a split bill); **Tip for the stylist** (not part of the bill; on the commission report); **Discount** with a reason (role with *sales.discount*, within the business's cap). The button says *Take ₹(to pay)* with the total under it. After saving: Print (80 mm), WhatsApp bill, Book next visit, Next bill (Enter). |
| Appointment history | Every booking with its deposit, bill or charge, walk-in and moved; filters stylist, client, status; client names open the card. |
| Packages & memberships | Tiles: active plans, sessions not used yet (₹ still owed in services), expiring in 30 days. Rows: **Book** a session, Remind on WhatsApp, **Extend validity** (later date + reason, audited), Usage (the bills that used it), Cancel (unused only). Per-service sessions left show in the row. |
| Staff commissions | A package or membership sold is its own kind (*Package / membership sale*, its own rule, e.g. 3%); a session used from a package earns on its value (the package's price per session, or the service's list price — Booking rules). A rule can be a **flat amount per item** (₹50 a haircut). By stylist: Earned · Tips · Paid · Due, **Pay out** (amount, method, note) and **Print slip**; a *Paid out* tab lists payouts. |
| Stylists & services | (was Service times & skills; the generic Staff & rooms screen now opens here for a salon.) Stylists & rooms first, with working hours, weekly day off, leave coming (×  cancels), *Add leave*, *Switch off* (refused while bookings are to come), rename. |

**Meat and other weight shops**

| Screen | What changed |
|---|---|
| Overview | *Today at the counter*: kg sold, kg cut (yield against the templates), kg wasted (₹ at cost), kg to use by tomorrow; *Set today's rates* (or how many changed today); the next pickups. Start here: Quick bill, Today's rates, Cut / clean, Orders for pickup, Record wastage. The 30-day expiry line is not shown for these shops. |
| Today's rates (new) | Every weighed item: the rate the day opened at, today's rate (type it), the change, cost per kg and margin, customer rates. *Change every item / a category by ±₹ or %* then *Save N rates*; every change is kept (Rate history tab). *Share on WhatsApp* (the rate list as text), *Print the rate list (A5)*. A rate above MRP is refused. Hotel / caterer rates per kg: switch on *Wholesale price lists* (now offered to meat and weight shops) and use Customer rates. |
| Quick bill | **Cut to order**: weigh the whole bird / fish, cut, weigh the cut — the cutting batch posts at once and the cut lands on the bill from that batch. **Pickup orders** opens the list; *Bill* on an order fills the bill (weights, or "₹300 worth" turned into a weight at today's rate) and closes the order when the bill is taken. A bill of nil-rated items shows *GST: Not applicable* instead of rows of zeros. |
| Orders for pickup (new) | Phone / WhatsApp orders: customer (saved or name + phone), pickup time, items by weight or ₹ worth with a note ("curry cut, no skin"). *To do* in pickup order (late in amber): **Ready** (prints an 80 mm packing slip, *Tell them* on WhatsApp), **Bill**, cancel with a reason. |
| Stock by weight | Opens on **Today**: opened with, received, cut in, cut out, sold, wasted, should be here; status *Use … by tomorrow*; row actions Cut / clean, Record wastage, Change the rate, Stock movements; fits at 1440 (value, margin, use-by date in the column menu). *Last 7 days* keeps the week (Made by cutting / Used for cutting are separate now). **Close the day**: weigh what is left per item; short is written off (drip loss unless another reason), over is put back; past weigh-ups are listed. |
| Cutting & yield | The weights start empty (the template's figures are hints, "expected 8.5"); only the template's cuts are offered (*Add other* for the rest); *Cut by* (who cut it); the batch records the input's supplier. Opens pre-filled from Stock (`?new=<item>`). Dry fruits read **Sorting & repacking / Sort / repack**, and can **repack into pouches** sold by the piece (packs × pack weight, remembered). |
| Wastage | **End of day**: every item with stock, weight and reason per row, saved in one go (oldest batches first). The weight shows once (kg in the column menu). The *Wasted today* tile no longer says "1 entry" on an empty day. |
| Yield & wastage | *Yield by template* (curry cut and boneless no longer pooled), with *Short by* (points) and *Shortfall* (₹); filters template, cut by, supplier; a *Short of the template* tile. |
| Labels | The demo's weighed items have scale codes (PLU 101…) so a scale label scans at Quick bill. |

Not done in this pass: a monthly slab commission, advance payments on pickup orders (note them on the order), a "recovered ₹" for offcuts sold cheap, the A4 / 80 mm invoice still prints GST rows for nil-rated bills, a salon "Book" button on the generic Clients list (the card opens from the calendar, bill and history).

## Shared commerce, pro pass (7 Oct 2026)

What every goods shop (grocery, supermarket, books, pharmacy, fashion,
electronics, meat and other weight shops) now shares. Migration
`1791540000000_business-core-gst-mrp-supplier-payments.sql`.

**Prices.** New goods shops start with *prices including GST* and totals
rounded to the rupee (the demo shops were moved too; bills already posted keep
their own tax mode). Each item can carry an **MRP** (GST included) and an
**HSN / SAC code** (Products › Edit). An item is never priced, given a new
shelf price on a receipt, or billed above its MRP — with prices before GST the
GST is added before comparing. HSN and MRP are copied onto each bill line.

**Quick bill** (`/counter`) serves every goods type:
- scan a barcode, a scale label, a book's ISBN or a phone's IMEI / serial
  (that very unit is billed; a unit already sold or at another location says
  so); fashion has **Size & colour** (find the style, tap the size under the
  colour);
- the pay card heads the right-hand column, which stays in view, so *To pay*
  and the take-payment button never leave the screen; keys: F2 scan, F4
  customer, F6 cash, F7 UPI, F8 card, F9 udhaar, F10 hold, F12 or Ctrl+Enter
  take payment, Enter in *Cash received* takes it; after a bill Enter starts
  the next and P prints;
- quick cash buttons (exact and the next round sums), − / + on counted items;
  a weighed item starts empty and waits for its weight (or "₹ worth");
- **Hold** parks up to five bills in the browser tab; **Last bill** reopens the
  last one (reprint, A4 invoice, returns);
- a small **discount on this bill** (₹ or %) with a reason, for roles holding
  `sales.discount` (Manager by default), up to *Most discount at the counter*
  in Business settings (10 % by default; the owner is not limited);
- the customer card shows what they owe, how much is overdue, the limit left
  and their last promise (red when broken), with *Collect udhaar*; choosing
  Udhaar warns when they are overdue, broke a promise or go over the limit;
  the receipt prints *Earlier udhaar · This bill on udhaar · Total udhaar now*;
- **a walk-in pays the whole bill** (server and screen); udhaar needs a named
  customer unless the owner sets *Walk-in customers: may leave a bill unpaid*.
  Sales has a *Walk-in bills not fully paid* filter for older ones;
- electronics: selling a serial unit registers its warranty with the bill (the
  customer on file, or the walk-in's name and phone typed under *Warranty for*).

**Day close** (`/day-close`, needs `sales.view`): sales, returns, money in by
method, refunds, payments to suppliers, the cash that should be in the drawer,
udhaar given and collected, by person and by location, for a day or up to 31
days, with a 72 mm end-of-day slip. Read-only.

**Tax invoice.** One shared document (`modules/business/core/pages/invoice.js`)
prints every sale: A4 (*Print invoice*) and 80 mm (*Till receipt*, Quick bill).
Seller legal name, GSTIN, address and state; buyer name, address and GSTIN as
billed; place of supply (the buyer's GSTIN state, else the shop's state); HSN,
quantity, rate, discount, taxable value, GST rate, CGST + SGST or IGST per line
and an HSN summary; round-off; the total in words; the business's date format.
A business with no GSTIN gets a warning on the A4 copy.

**Receiving** (Purchases › Receive a purchase): the supplier's bill number and
date (the same bill from the same supplier cannot be entered twice; the
purchases list searches it), scan a barcode to add a line, the item's pack
size as the default unit, *Update selling price / MRP from this bill* (needs
`catalog.edit`), and after saving a *Print N labels* button that opens Barcode
labels with what arrived (MRP struck through when selling below it).

**Paying suppliers** (Suppliers › *What you owe suppliers*): overdue by each
supplier's credit days and the oldest unpaid receipt, *Pay* (oldest receipts
first, receipts chosen, or an advance; a cheque needs its number) with a
printable voucher, and *Statement* (billed, paid, running balance; print).

**Overview**: four headline figures (sales today with bills, money in today by
method, customers owe with udhaar given today, to pay with what is overdue), a
*Needs doing today* list by type (broken or due udhaar promises, orders to
dispatch, repairs ready or late, sold units without a warranty, exchanges,
styles with sizes sold out, low stock, expiring batches, transfers, counts,
appointments still to come today) and *Start here* with the type's first
action (Quick bill for a shop, New bill for a salon, a sales order for a
wholesaler). The **Activity log** reads in plain words. Udhaar, Collections and
Day close are in the menu of every goods shop.

API (all additive, under `/api/businesses/:businessId`):

| Method and path | Permission | What |
| --- | --- | --- |
| `GET /reports/takings?from&to&locationId` | `reports.view` or `sales.view` | Day close figures |
| `GET /payables?show=owing,overdue,advance,all&sort&q` | `purchasing.view` | What is owed to each supplier |
| `GET /suppliers/:contactId/account` | `purchasing.view` | Open receipts and advances |
| `POST /suppliers/:contactId/payments` | `purchasing.edit` | Pay `{ locationId, amount, method, reference?, notes?, requestKey, allocations? }` |
| `GET /suppliers/:contactId/statement?from&to` | `purchasing.view` | Supplier statement |
| `GET /supplier-payments`, `GET /supplier-payments/:id` | `purchasing.view` | Payment vouchers |

Changed (additive): `POST /documents` takes `supplierBillNo`,
`supplierBillDate` and per-line `sellingPrice` / `mrp` (purchases),
`discount: { amount or percent, reason }` and `buyer: { name, phone }` (sales),
and `payment.amount: "full"`; `POST /retail/quote` takes `discount`;
`/catalog` takes `hsnCode` and `mrp`; `PUT /settings` takes
`maxBillDiscountPercent` and `walkInCredit`; `GET /retail/scan` finds a serial
or IMEI; `GET /documents` searches serial numbers and supplier bill numbers and
filters `walk_in_due=true`; `GET /summary` adds today's figures
(`bills_today`, `taken_today`, `credit_given_today`, `promises_due_today`,
`promises_broken`, `appointments_left_today`, `exchanges_today`,
`broken_sizes`, `repairs_ready`, `repairs_overdue`, `warranties_missing`,
`orders_to_dispatch`, `payables_overdue`), each only to those allowed to see
it. Tests: `backend/tests/integration/business-core-pro.test.js`,
`frontend/tests/browser/business-counter.spec.js`.

## Retail, pro pass (7 Oct 2026, builder C)

Migration `1791610000000_retail-pro.sql` (`business_locations.sells_at_counter`,
`books_sets` / `books_set_items`, `books_customer_orders`). Code:
`backend/src/modules/business/retail/services/businessRetailPro.service.js`,
`core/services/businessNotifications.service.js`; screens in
`frontend/src/modules/business/retail/pages/` (`NearExpiryPage`,
`BookOrdersPage`, Quick bill) and small additive edits to core screens.
Tests: `backend/tests/integration/business-retail-pro.test.js` (7 checks),
`frontend/tests/browser/business-counter.spec.js` (keyboard search, Return,
phone pay bar).

**Quick bill**
- *Return* in the header: find the bill (number, customer or phone; today's
  latest first) and *Take back items* opens on it.
- The search list: ↓ / ↑ move, Enter adds the highlighted item (the first by
  default). A typed name never shows "No item has this barcode" while there
  are matches; a scanned code is looked up as before.
- Phone: one compact row per line (item, quantity, amount, ×) and a bar at the
  foot with *To pay* and *Take payment* (it scrolls to the pay card).
- Only locations that sell at the counter are offered as the till (a
  warehouse is not: Locations › *Sells at the counter*); the till is
  remembered on the device, and changing it with a bill on screen asks first.
- Bookshops: scanning or typing a school set's code puts the whole booklist
  on the bill.
- Hold / recall and *Last bill* are as before (F10, up to five held bills).

**Sales list** (shops): opens on today (Quick pick still has the month);
columns *Billed by* and *Paid by* (cash, UPI, card, bank, mixed or not paid);
filters by payment, by who billed it (for roles that see staff) and by
location.

**Expiring soon** (Stock, needs *Batches & expiry*): batches with stock that
expire within 7, 30 or 60 days, expired ones first, with tiles (expired still
on the shelf and their cost, within 7 days, value at cost). *Mark down* starts
an item % offer that ends on the batch's date (the shelf price is not
changed); *Write off* posts a correction with the reason. The overview card
and the bell link here; Stock on hand shows batch and expiry on phone cards
with a "7 days left" badge. The demo supermarket now has dated paneer, curd,
bread, butter and yoghurt batches (one curd batch already past its date).

**Products**: *Add item* takes the opening stock (quantity, cost, location,
batch and expiry for batch items) — it goes in as a correction with the
reason "Opening stock"; *Edit* can change or clear the barcode (two items
never share one).

**Books**: the ISBN is the barcode (an in-store `200…` code is replaced; a
maker's barcode is kept, and Book details points out a sticker that differs).
*Booklists & orders* (Sales): **School sets** (name, code to scan, school,
class, items with quantities, set price) and **Customer orders** (title,
author, ISBN, copies, customer and phone, expected by, an advance kept on the
customer's account as a numbered receipt), *Arrived* → *WhatsApp* the customer
→ *Collected*, or *Cancel* (the advance stays as their credit).

**Smaller**: demo GST slabs as revised in Sep 2025 (biscuits, noodles, corn
flakes, toothpaste, soap 5 %; notebooks nil); *Remind* is a button on the
udhaar book with the oldest bill's age; *Udhaar collections* sits right under
Udhaar for every shop; an offer limited to some days or hours says when it
runs ("Runs Sundays only", "Runs 4–7 pm"); on Staff & access your own row
says *Using it now* instead of "Not yet" (last opened is still set only by
the switcher, which decides where "/" lands); stock movements in time order;
dates as "27 Sep".

**The bell in Business Admin**: the header bell shows the open business's
alerts (low stock, expiring batches, overdue udhaar / outstanding, promises
due or broken, repairs ready or late, appointments left today), each to those
allowed to see it; read marks are kept in the browser per person and
business. The restaurant's bell is unchanged.

**Business chooser** (`/business-admin?all=1`): its own page (no restaurant
menu, outlet switcher or bell), a search box, each card with today's sales,
udhaar / amount owed and things to look at; the part of a demo's name that
tells it apart leads, the owner's name is a quiet second line; no command-line
instructions.

## Fashion and electronics, pro pass (7 Oct 2026, builder E)

Migration `1791595000000_fashion-electronics-pro.sql`; code in
`backend/src/modules/business/fashion-electronics/` (new
`businessFashionPro`, `businessVouchers`, `businessElectronicsPro` services)
and `frontend/src/modules/business/{fashion,electronics}/`. Small additive
edits: retail offers (`product_percent`), Quick bill (credit voucher),
Barcode labels (garment tag), the size × colour picker (`initialProduct`),
`business.service.js` (voucher and GST-by-price hooks in posting),
`setup-business-demos.js` / `demo-fashion-electronics.js` (valid IMEIs).
Tests: `backend/tests/integration/business-fe-pro.test.js` (12 tests).

**Garment shop**
- *Size × colour* page: the grid stays a grid on a phone (colours pinned,
  sizes scroll). The price shows once per size; a cell shows its own price
  only when it differs. Tap a cell: price, reorder level and the maker's
  barcode, *Print tags*, *Receive*, *How it sells*. *Tags for stock* prints
  a garment tag per piece in stock. More: add sizes or colours, set prices,
  *Type the maker's barcodes* (one box per size and colour; a scanner moves on
  with Enter), *Mark down this style*.
- *Receive stock*: a cost per size (or one for all sizes), the supplier's bill
  number and date, *Add another style* for the rest of the same bill, then
  *Print N tags* for what arrived.
- *Markdowns* (end of season): tick styles on the Size × colour list (or from a
  style, or from the reports) → % off and the last day. It is an offer of the
  Offers module (now on for garment shops): the shelf price is never changed,
  so the price goes back by itself after the end date; *End now* ends it. The
  list shows "30% off till 31 Oct" beside the price; the bill shows the discount.
- *GST on clothing by price* (Size × colour › More, `settings.edit`): 5 % up to
  ₹2,500 a piece, 18 % above, decided on each bill line after discounts.
- *Exchanges*: find the sale by scanning the item coming back (one match
  opens at once with that piece ticked), by the customer's phone, or by bill
  number; *No bill (gift)* for a manager (goes on the latest sale of that item
  within the policy). *Swap size / colour* opens the style's grid. Credit owed
  can be a **credit voucher** (printed, valid 90 days, walk-ins too), money (refund
  permission) or kept on account. The new bill (and the voucher) print on save;
  the detail reprints them. *Open credit vouchers* are listed on the page.
- *Quick bill*: *Credit voucher* under the discount — scan or type CV… and
  the voucher pays first; *Left to pay* is what the cash, UPI or card buttons take.
- *Variant reports*: *By style* with the size curve (share of sales per size,
  red when the size is sold out), stock age (0–30, 31–60, 61–90, over 90
  days), *Broken sizes* (a middle size sold out while others of the colour
  are left), each with *Reorder* (opens Receive for the style) and *Mark down*.
- *Barcode labels*: *Garment tag* layout (brand, style, the size large, colour,
  MRP / price including GST, barcode); the default for garment shops.

**Mobile and electronics shop**
- *Serial / IMEI register*: *Scan phones in* (model and cost once, then
  IMEI 1 / IMEI 2 per box or pasted from a sheet, every number checked, a
  running count against the bill); *Days in stock* with 0–30 / 31–60 / 60+
  filters; cost shown to purchasing roles; *Faulty & back to supplier* tab
  (send back on a purchase return with an RMA number, found fine, or written
  off); a unit's history has *Faulty: hold for the supplier*. Phone models not
  set to IMEI checking are flagged on the Models tab; models carry the brand helpline.
- *Exchanges* (now on for electronics): a returned unit can be marked *Dead on
  arrival* or *Faulty*: it comes back into stock but cannot be sold, the
  replacement is linked to it, and the warranty moves to the replacement.
- *Repairs*: chips with counts per status (and *Late*, *Not collected*), each
  open job with *WhatsApp* and its next step. *Take in a device*: scan the
  IMEI first (the sale, warranty and earlier repairs come up; a different
  person from the warranty owner must be confirmed), the customer found by
  name or phone, a damage checklist, the screen lock (kept only until the job
  closes), and an advance credited on the final bill.
- *Repair job*: the status is the headline with how long it has been there;
  the next step is the main button and each step takes an optional note.
  Charges above the estimate move the job to *Awaiting approval* (ask on
  WhatsApp, then *Customer approved* / *Customer declined*). *Tell the
  customer*: a WhatsApp message per stage or a call, noted in the history.
  *Warranty claim* (jobs under warranty): raise with the brand or distributor,
  then sent / approved / rejected / credited. The job card prints the
  checklist, advance, terms, a signature line and the job barcode.
- *Warranties*: *Claims with brands* tab with what is due from each brand;
  the card reprints in any state (marked expired or cancelled), with the bill
  value, brand helpline, the IMEI as a barcode and a stamp and signature box.

Not done (flagged): finance / EMI sales (E-22) and accessory kits (E-28).
