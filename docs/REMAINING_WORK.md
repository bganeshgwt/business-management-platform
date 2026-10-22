# Status — Business Management Platform (Business Admin)

*As of 22 October 2026. Written for the owner. The detailed list of what is left
is [REMAINING_BACKLOG.md](REMAINING_BACKLOG.md); this page is the summary.*

---

## At a glance

| | |
|---|---|
| **Scope agreed on 6 Oct** | One **Business Admin** application for all business types, with a **business switcher**. Commercial platform (plans, subscriptions, billing) later. |
| **Built, independently checked and fixed** | Shared foundation, Restaurant, Retail (grocery/kirana, supermarket, books & stationery), Wholesale/FMCG, Fashion, Electronics, Salon & spa, Meat/seafood and other weight-based shops, plus the "pro pass" on every area and **Tasks, Issues & Projects** (82 checklist templates, 6 project plans); Pharmacy and Clinic & lab (round 2, 8 Oct) |
| **Built since, with tests** | Several locations for every type, payment methods and rules (12 Oct); daily money, expenses and cash checks (14 Oct); shop extras and cashier shifts (16 Oct); clinic & lab extras, café / bakery / cloud kitchen and kitchen brands (round 3, 21 Oct); real copies of the demo shops and the staff app / guests' site split (21 Oct). See the sections below. |
| **Your database** (`restaurant_management_db`) | Fully up to date: all 133 changes, the last (`1791950412000_document-list-indexes`) applied 21 Oct. Latest backup, taken just before the real copies: `backend/.local/backups/2026-10-21T11-33-42-007Z-b20697` (restore not verified). The latest with a verified restore: `2026-10-16T04-47-00-250Z-e71f58` (16 Oct). |
| **Your businesses** | On your owner login: FoodEx, the 11 realistic demo shops (see below) and, since 21 Oct, their 11 real copies (`LIVE-…`). The café, bakery and cloud-kitchen demos have their own owner logins (`backend/.local/food-demo-logins.json`). The 11 old "Demo · ..." businesses are marked inactive, not deleted. |
| **Tests** (21 Oct) | Integration 549/549, unit 30/30, the apps' and packages' Node tests 5/5, lint and both builds clean; the guests' browser suite 6/6 and the staff browser suite of 80 (three timing failures under load passed on rerun). Details in [VERIFICATION.md](VERIFICATION.md). |
| **Commits** | 9 commits on `main`, on GitHub as `business-management-platform`; round 3 was merged there on 21 Oct. Not committed yet: the real copies' script, the document-list indexes, a brands fix (a dish added later to a brand's order must be on that brand's menu), the staff app / guests' site split and these documents. |

---

## Realistic demo data (loaded 8 Oct)

Each business has about 90 days of history, Indian staff, suppliers and customers, GST/MRP-correct
prices, a live "today", daily checklists (mostly done, some missed), an issue raised by an
out-of-range reading, and a "Diwali preparation 2026" project. The demo story for each is in
[DEMO_GUIDE.md](DEMO_GUIDE.md) section 6. Staff logins: `backend/.local/realistic-demo-logins.json`.

| Business | City | What to show |
|---|---|---|
| Sri Lakshmi Kirana & General Stores | Hyderabad | loose goods by weight, udhaar book (on time, late, over limit) |
| Sai Annapurna Super Bazaar | Bengaluru | loyalty, offers, batch and expiry, near-expiry list |
| Sahyadri FMCG Distributors | Pune | 48 retailers on 8 beats, 3 salesmen, dispatch and back-orders, cheques (one bounced) |
| Rangoli Silks & Fashions | Chennai | size × colour, 5 % / 18 % GST slab, exchanges |
| Sri Venkateswara Mobiles & Electronics | Hyderabad | IMEIs, warranties, repairs in every state |
| Glow & Grace Unisex Salon & Spa | Bengaluru | today's calendar, packages, memberships, commissions |
| Al-Noor Fresh Chicken, Mutton & Seafood | Hyderabad | daily rates, cutting and yield, wastage, restaurants on credit |
| Gupta Dry Fruits & Mewa Bhandar | Delhi | sales in grams, corporate Diwali order |
| Vidya Book House & Stationers | Pune | ISBN, school sets, schools on account |
| Sri Sai Medicals | Chennai | basic catalogue, batch and expiry; since round 2 the drug master, prescription sales, H1 and X registers, expiry returns and a recall |
| Sanjeevani Family Clinic & Diagnostics | Hyderabad | doctors, appointments, today's queue; since round 2 patients with consent, consultations and the lab; since round 3 doctors' fees and OPD, today's tokens and lab QC |

**FoodEx tidy-up:** the old open business day was closed (6 stale orders cancelled with the reason
"Demo tidy-up: stale order"; 3 unpaid bills worth ₹1,922 carried as dues), and today's day is open
with live orders.

To refresh "today" before a demo, run in `backend`: `npm run demo:today -- --user-id 2`
(all realistic businesses and their branches, then the restaurant; about a minute; nothing is posted twice).

**Things to know about the demo data**
- The activity log, warranty start dates and sold packages show the load date (8 Oct). The
  database's append-only protection rightly refuses back-dating them. Receipts, cheques and supplier
  payment vouchers exist for today only; in the history, payments are on each bill.
- Navratri and Diwali are still ahead in the real calendar, so the history shows the run-up to them.
- Staff logins of the new businesses first land on FoodEx (staff accounts belong to the owner's
  restaurant) and then switch business. This is worth fixing (see below). *Fixed in round 2
  (8 Oct): they now land straight on their own business.*

---

## Round 2 (8 Oct): groups 1 and 2 completed

Built by four builders, then checked by an independent checker who fixed 5 bugs. Database changes
`1791620001000` to `1791620004000` are on your database (verified backup before each). Every rule
decided for you is in [DECISIONS_ROUND2.md](DECISIONS_ROUND2.md), each with the setting that changes it.

- **Shops & electronics:** staff land on their own business; split payment (up to 8 parts);
  0% GST rows hidden / "Exempt"; per-staff till PIN and "PIN for every bill"; spent loyalty points
  given back on returns; EMI / finance sales with a financier screen; kits and bundles.
- **Wholesale:** purchase orders with receiving; delivery challan series and print (e-way bill no.
  typed by hand); order edit; cross-item free goods; bounced-cheque charge and credit hold.
- **Restaurant:** advances on pickup orders; task actions in the activity log; faster people picker.
- **Salon, meat shop, repairs:** stylist schedules and holidays; products used in services and service
  profitability; advance refunds; monthly target commission; yield by supplier; repair advance refunds.
- **Pharmacy:** drug master, Schedule H/H1/X rules, prescriptions, H1 and X registers, licence numbers
  on bills, expiry returns, batch recall.
- **Clinic & lab:** patients with consent, consultations, clinical data for doctors only (every view
  logged), lab tests, samples, results, pathologist approval, printed reports.
- **Pharmacy and clinic rules are standard Indian practice:** review them with your pharmacist,
  doctor or legal advisor before real use.

The checker's fixes: day close now handles refunded advances and bounced cheques; the pharmacy
counter takes split payment and the "PIN every bill" rule; the H1/X registers show returns; Quick bill
allows all 8 payment parts; the demo loader no longer reuses a PIN from the other database.

**Small things still open:** returned scheme goods do not take back the free goods (needs your rule);
a brief restaurant header while a shop opens; two PIN entries when switching and "PIN every bill"
are both on; some wide tables scroll inside their grid on desktop (by design).

---

## Multi-location for every business type (12 Oct)

Shops, pharmacies, salons and every other business type now work with several
locations the way the restaurant's outlets do: each location's own address,
phone and GSTIN on its bills (and its own state as the place of supply), staff
tied to one location (they bill, stock and report there only), a location picker
in the top bar, transfers received by the destination, a **Locations compared**
report, and a pharmacy branch's own drug licences. Database change
`1791630000000_business-multi-location` is on your database (verified backup
taken just before: `backend/.local/backups/2026-10-12T10-41-01-118Z-0ee8f1`).
Customers' balances stay business-wide by design.

## No more hard-coded business rules (12 Oct)

- **Real onboarding.** Platform › Businesses creates a business of any type
  (except restaurant) with its owner's login; an owner can add another business
  of their own; Staff & access makes staff logins and resets their passwords.
  Currency and time zone are editable in Business settings. No demo data needed.
- **Payment methods** are the owner's (Settings › Payment methods): rename, add
  (PhonePe, Paytm, Sodexo…), switch off; each is cash, UPI, card, bank or cheque
  underneath, and bills and the day close show the name.
- **Business settings › Rules**: expiring-soon days, voucher validity, customer
  credit age groups, quick weight buttons, receipt paper, day cut-off.
- **Restaurant settings › Alerts and timings**: theft alert levels, kitchen pass
  time, delivery and reservation timings, time-clock limits, guest segments,
  reorder planning and the cash-count notes.
- **No demo names** in import templates or the public booking page; the
  restaurant starts with today's GST slabs (0, 5, 18, 40 %).
- Database changes `1791640000000`–`1791640002000` are on your database
  (verified backup just before: `backend/.local/backups/2026-10-12T11-36-25-316Z-1e9450`).

Still fixed on purpose: GST, GSTIN and state-code rules, the permission list,
PIN lockout (security), split payment up to 8 parts (taken off the counter screens on
14 October 2026), label-sheet sizes, reason
lists that drive reports (wastage, claims, debit notes, cancellations), and the
stock-age groups of fashion and electronics reports.

## Daily money and shop extras (14–16 Oct)

- **Menus by workspace:** every business has three menu groups, Daily work,
  Business and Management; an entry opens an area whose related pages are
  tabs. Tasks shows only where it is switched on, and **Business tools** marks
  the tools a trade usually uses as *Recommended*.
- **Daily money** (every type's day close), **daily expenses** (money already
  paid; a mistake is reversed with a reason, never edited) and the **cash
  check** (the drawer counted against what it should hold).
- Your change of 14 Oct: Quick bill and the pharmacy counter take one payment
  method per bill.
- **Shop extras:** a branch's own prices, member prices, shelf locations,
  opening hours, coupon codes, departments with staff tied to one, and
  **cashier shifts** (each cashier's float and blind count). Purchases take
  free goods and a trade discount. Items kept only for use in services are
  never sold.
- **Overview** for every type: today against last week, 14 days of sales, the
  day by hour, best sellers and who is next.
- Database changes `1791950400000`–`1791950406000` are on your database.

## Round 3: clinic & lab, food formats, brands (21 Oct)

- **Clinic & lab:** each doctor's consultation and follow-up fees, OPD
  sessions with a patient cap, and leave; the day's token queue with a
  display board; every signed lab report kept as a version (an amendment
  needs a reason and the pathologist's PIN); quality control by the Westgard
  rules: while a test's latest control run today has failed, reports with it
  cannot be signed. A visit belongs to its branch.
- **Café, bakery and cloud kitchen** run on the restaurant as its *format*,
  which sets how the POS opens and the features it starts with. Pre-orders
  and cakes with an advance and a bake list, leftover bakes written off as
  "Unsold at day end", and dishes sold by weight. Demo:
  `npm run demo:food-formats` (Brew & Bloom Café, Sweet Crust Bakery, Biryani Box).
- **Brands:** one kitchen selling under several names; each brand has its
  menu categories, prints on the KOT and the bill, and has a sales report.
- Database changes `1791950407000`–`1791950412000` are on your database.
  Round 3 is merged into `main` on GitHub.

## Real copies of the demo shops (21 Oct)

Each of the 11 demo shops has a real twin, `LIVE-<KIND>`, with the same
set-up and empty books, for a pilot customer. The demos stay for training.
What to fill in before a customer uses one: [DEMO_TO_REAL_PLAN.md](DEMO_TO_REAL_PLAN.md).

## Staff app and guests' site (21 Oct)

- The **staff app** (`apps/business-web`, was `frontend/`) is everything people
  sign in to. The **guests' site** (`apps/customer-web`) is what guests open:
  QR table ordering, online ordering and table booking, with no sign-in. Old
  QR codes and links keep working: the staff app sends them on.
- Planned screens already have their addresses and say what is coming: the
  captain, clinic and lab workspaces on the staff app; shop, appointments and
  account pages on the guests' site.
- Start everything from the project folder, one terminal each:
  `npm run dev:backend` (the API, port 5010), `npm run dev:business` (staff
  app, 5173) and `npm run dev:customer` (guests' site, 5174).

## What you need to do

1. **Look through the businesses** with the switcher in the top bar, using the stories in DEMO_GUIDE.md.
2. **Review and commit** what is not committed yet (see *Commits* above), then push it.
3. **Moving to the new repo** is done (12–13 Oct): the code is on GitHub as
   `business-management-platform` (the git remote `origin`; the old repository is `old-origin`).
4. **For a pilot,** give the customer a real copy, never a demo, and fill it in
   first ([DEMO_TO_REAL_PLAN.md](DEMO_TO_REAL_PLAN.md#before-a-pilot-customer-uses-one)).

---

## What was built (summary)

**Shared foundation (for every business type and the future platform):** per-business roles and
permissions (Owner, Manager, Cashier, Stock keeper, Accountant, Viewer + custom), business
settings, GST slabs, invoice number series per location and financial year, categories, units and
pack sizes, customer credit, stock transfers and counts, a module catalogue ready for
subscriptions, and an events outbox ready for live updates and outside services.

**Restaurant:** branches with their own days, cash drawers per shift, tips, advances and deposits,
payment corrections, delivery charge, rider cash settlement, UPI QR for the exact amount, FSSAI per
outlet, coupon rules, owner-named payment types, yearly invoice numbers, kitchen names in any
script, captain sections, large parties across tables, saved addresses and repeat orders, online
booking and online ordering pages, attachments on expenses and purchase bills, dish profitability,
a much faster dashboard (2 requests instead of 13; instant when you come back), and the
two-step sign-in security fix.

**Business types:** retail counter (barcode, ISBN and scale labels), offers, loyalty, udhaar with
reminders, barcode labels; wholesale orders, part dispatch, credit limits, collections, ageing,
routes; fashion size × colour and exchanges; electronics IMEI, warranties and repairs; salon
calendar, deposits, packages, memberships and commissions; meat/weight cutting, yield and wastage.

**Everywhere:** every list is a data grid with S.No., paging, search, column choice and export;
live screens show today; clear card borders; Business Management Platform naming.

---

## Late-night trading (fixed 7 Oct, 12:50 am)

Between midnight and the day cut-off (5 am by default) last night's business day stays the
trading day everywhere: write-off control, the dashboard, day book, reports' default dates,
stock screens, deliveries, advances, the log book and captain sections. A branch that closes at
1 am no longer shows ₹0 on its dashboard. Tests for this run at any hour (311/311).

---

## What is left (details in [REMAINING_BACKLOG.md](REMAINING_BACKLOG.md))

| Area | What | Needs |
|---|---|---|
| Outside services | Payment gateway / UPI confirmation, Swiggy/Zomato, SMS/WhatsApp/email, password reset by email/SMS | Provider accounts |
| Hardware | Silent thermal printing, cash-drawer kick, weighing scale and barcode scanner bridges | The devices |
| Platform layer | Plans and subscriptions; the platform admin as an app of its own (the console in Business Admin already covers every business type) | Your plan names and prices |
| Other apps | Standalone POS, captain app, clinic and lab workspaces, the guests' site's shop, appointment and account pages, salesperson mobile app (the guests' site itself exists since 21 Oct; the planned pages already say what is coming) | Your go-ahead |
| Pharmacy & clinic extras | NDPS narcotic forms; messages to patients (report ready, follow-up) | NDPS licence details; messaging provider |
| Live updates | Push changes to screens through the events outbox | Build after admin sign-off |
| Smaller "later" items | Listed per module in the backlog (e.g. salon online booking, e-way bill API, a message by itself when a repair is ready); warranty claims to the maker were done on 7 Oct | Your priority |
| Go-live | Hosting for the API, the staff app and the guests' site, domains with HTTPS, off-machine backups, pilot with real staff ([PILOT_CHECKLIST.md](PILOT_CHECKLIST.md)) | A server and a pilot date |
