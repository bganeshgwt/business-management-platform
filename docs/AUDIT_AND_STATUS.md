> **Historical document** (September 2026), kept for the record and no longer updated; it names the old folders `restaurant-management-platform` and `frontend` (now `business-management-platform` and `apps/business-web`). Current state: [ARCHITECTURE.md](ARCHITECTURE.md).

> Historical status: see [current verification and remaining scope](VERIFICATION.md) for checks performed since 29 September 2026, and [REMAINING_BACKLOG.md](REMAINING_BACKLOG.md) for what is left. Counts and pending labels below may be outdated.

# Restaurant Admin — Audit and Completion Status

*As of 25 September 2026, 3:30 pm. This page is regenerated as each piece of work is finished and re-checked.*

An honest, area-by-area picture of the admin application: what works today, what is
broken, what is missing compared with a Petpooja-class system, and what is being done
about each item.

---

## Contents

1. [The short answer](#the-short-answer)
2. [Paused for the holiday — where to pick up on Monday](#paused-for-the-holiday--where-to-pick-up-on-monday)
3. [How this was checked](#how-this-was-checked)
3. [Scores by area](#scores-by-area)
4. [What is being done, in what order](#what-is-being-done-in-what-order)
5. [The road to complete — including the new look](#the-road-to-complete--including-the-new-look)
6. [The eight new modules](#the-eight-new-modules)
7. [Done last: features that need an outside service](#done-last-features-that-need-an-outside-service)
8. [Order to kitchen — POS, tables, KOT, QR ordering, reservations](#order-to-kitchen--pos-tables-kot-qr-ordering-reservations)
9. [Bill, payment and day close — the cash desk](#bill-payment-and-day-close--the-cash-desk)
10. [Menu and pricing](#menu-and-pricing)
11. [Stock, recipes and purchasing — back of house](#stock-recipes-and-purchasing--back-of-house)
12. [Guests, loyalty and feedback](#guests-loyalty-and-feedback)
13. [Staff, roles and security](#staff-roles-and-security)
14. [Owner view — dashboard, reports, settings, outlets](#owner-view--dashboard-reports-settings-outlets)
15. [Status key](#status-key)

---

## The short answer

**The application is not complete yet.** Every area works for a quiet service, and several
parts are genuinely strong: the kitchen display, QR table ordering, reservations, and a
day-end sheet that matches sales to the paisa. But no area is ready for a busy Friday
night yet.

- **100 problems found**, 84 of them independently re-checked and confirmed.
  The rest are on the owner-view side, which is being re-checked as it is fixed.
- **84 missing features** compared with what a serious Indian restaurant expects,
  19 of them must-haves.
- Area scores run from **4.5 to 6 out of 10** for readiness in a real, busy restaurant.
- **Fixed and independently re-checked so far: 72 of 100 problems.** The count
  rises as each repair step passes its verifier.

**All of this is being worked on now.** Every problem has an owner, and every fix is re-tested
by someone who did not make it. The 9 features that depend on an outside company
(Swiggy/Zomato, SMS/WhatsApp, UPI confirmation and similar) are **deliberately left until
last**, as agreed.

---

## Paused for the holiday — where to pick up on Monday

Work stopped cleanly on 25 September at 3:30 pm. At that moment the whole
application loaded and built without errors, and all **4,591 automated checks
passed**.

**Done and independently verified:** staff access and manager PIN, stock and
purchasing, menu, order editing, POS floor features, guests, owner reports, and
the eight new modules. The new look is in place for the sign-in page, the top
bar, colours and dark mode, and the menu and stock screens.

**Stopped part-way:**

- **Billing.** The fixes are made (tax invoice, discounts at the till, service
  charge rules, complimentary bills, credit notes, reprint tracking) but have not
  yet been through their independent check.
- **Guests and staff screens.** Part-way through getting the new look. They work,
  but may look mixed until finished.

**Still to do, in order:** verify billing, then repair cash and loyalty; finish
the new look (guests, staff, floor and service, owner reports, then the till,
bills and cash screens); the live dashboard; a full re-check of every area; the
next-round features; handover (update the original demo database, guides and
tests); outside services last.

**Opening the preview after restarting the computer** — two PowerShell windows:

```powershell
# Window 1 — the server
cd C:\Users\Admin\Desktop\restaurant-management-platform\backend
$env:PORT="5070"; $env:DB_NAME="restaurant_management_preview"; $env:CORS_ORIGIN="http://localhost:5173"; npm start
```

```powershell
# Window 2 — the website
cd C:\Users\Admin\Desktop\restaurant-management-platform\frontend
$env:VITE_API_BASE_URL="http://localhost:5070/api"; npm run dev
```

Then open http://localhost:5173 and sign in as `owner@foodex.com` / `Foodex@123`
(also `manager@`, `cashier@`, `captain@`, `kitchen@foodex.com`, same password;
manager PIN 2468).

---

## How this was checked

Seven reviewers each took one area of the restaurant and used the application the way staff
would on a real shift: taking orders on several tills at once, editing running tables,
billing with discounts, paying by cash and UPI together, voiding, refunding, receiving
stock, closing the day. They worked on a separate test database, never on the demo data.

Every problem they reported was then handed to a second, independent reviewer whose only
job was to **disprove** it: reproduce it, or throw it out. Nothing on this page is a guess.
Each problem has a reference such as `OTK-01`, which the team uses to track it.

A few problems were found from more than one side. For example `OTK-01`, `BTC-12` and
`KNOWN-1` are the same fault, seen once from the till, once from billing and once from the
menu. They are listed wherever a reviewer found them. One fix closes all of them.

Each area below opens with its reviewer's verdict, in the reviewer's own words.

---

## Scores by area

| Area | Score | Verdict | Problems | Missing features |
|---|---|---|---|---|
| [Order to kitchen — POS, tables, KOT, QR ordering, reservations](#order-to-kitchen--pos-tables-kot-qr-ordering-reservations) | **5/10** | Partial | 13 | 8 |
| [Bill, payment and day close — the cash desk](#bill-payment-and-day-close--the-cash-desk) | **5/10** | Mostly complete | 16 | 14 |
| [Menu and pricing](#menu-and-pricing) | **5/10** | Mostly complete | 14 | 11 |
| [Stock, recipes and purchasing — back of house](#stock-recipes-and-purchasing--back-of-house) | **5/10** | Partial | 12 | 15 |
| [Guests, loyalty and feedback](#guests-loyalty-and-feedback) | **4.5/10** | Partial | 12 | 11 |
| [Staff, roles and security](#staff-roles-and-security) | **5/10** | Partial | 17 | 12 |
| [Owner view — dashboard, reports, settings, outlets](#owner-view--dashboard-reports-settings-outlets) | **6/10** | Mostly complete | 16 | 13 |

---

## What is being done, in what order

The fixes are grouped by the part of the system they touch. Some must go one after
another because they change the same screens; the rest run at the same time.

**One after another (the till and the cash desk):**

1. **Access and manager approval** — the foundation. A manager PIN to approve voids,
   refunds, discounts and cancellations; finer permissions (for example "see sales
   figures" and "see salaries" separately); quick staff switching on a shared till
   with auto-lock; security fixes.
2. **Running orders** — editing a table saves only what changed: no lost happy-hour
   prices, no cancelled dishes coming back, no "internal server error" when several
   tills work at once. Removing a dish the kitchen already has needs a reason and,
   for staff, a manager; it is reported by staff member.
3. **Floor features** — move a table, join tables, move dishes between tables; a
   captain ordering screen made for phones; a two-tap "sold out" switch; guest lookup
   by mobile at the till; delivery details and printing KOTs from the POS.
4. **Bills and tax invoice** — a proper GST tax invoice that adds up on paper;
   on-the-spot discounts with limits; service charge rules; complimentary bills;
   credit notes; every reprint counted.
5. **Cash and loyalty** — loyalty that actually earns and redeems at the till;
   customer credit accounts and dues; a close-day cash count with over/short; a cash
   drawer per shift.

**At the same time:**

- **Stock and purchasing** — physical stock count with variance, purchase entry
  without a purchase order, supplier statements, per-size recipes, correct costs.
- **Menu** — a safe import that previews every change and never corrupts dishes.
- **Guests** — duplicate clean-up and merge, privacy, loyalty and guest reports.
- **Owner view** — GST filing pack, profit and loss, accountant (Tally) export,
  theft-control report, correct figures by outlet.

**Then** the stages in the next section, through to a finished product.

---

## The road to complete — including the new look

"Complete" means every item on this page is **Fixed** or **Built** and re-checked, and
the whole application looks and feels like one finished product on a desktop, a tablet
and a phone. Stages run in this order. Each one only starts on a screen once the
people fixing that screen have finished, so no work is overwritten.

| Stage | What it covers | Status |
|---|---|---|
| 1. Repairs | Every problem on this page, and the must-have and should-have features marked *Being built now* | Paused — 8 of 9 areas repaired and verified; billing fixed but not yet verified; cash and loyalty not started |
| 2. New modules reviewed | Independent review and fixes for all eight new modules | Done — all eight built, independently reviewed and fixed; follow-ups fixed and verified |
| 3. Full re-check | All seven areas re-tested the way the first audit did it; anything not truly fixed goes back for another round | After stage 1 |
| 4. Next-round features | The 19 features marked *Next round*, for example holding and firing courses, packaging charges, prices per channel, menus per outlet, sub-recipes, weighted-average costing, expiry tracking, and a thermal printer that also opens the cash drawer | After stage 3 |
| 5. The new look | The redesign described below, on every screen | Paused — design system, sign-in, top bar, menu and stock screens done; guests and staff screens part-done; floor, owner and till screens to do |
| 6. Live dashboard | The owner's dashboard showing everything happening now, described below | With stage 5 |
| 7. Ready to hand over | The new modules loaded into the demo database with realistic demo data for every module, the Admin Guide rewritten for every screen, all automated tests moved into the project, and a final audit of the whole application | After stage 6 |
| 8. Outside services | Swiggy/Zomato, SMS/WhatsApp, UPI confirmation, password reset by email or SMS. Done last, as agreed | Last |

**The new look (stage 5)**

- **One consistent style everywhere.** Warm, calm colours around the brand orange,
  soft layered cards, the same spacing, type sizes and icons on every screen, and a
  proper dark mode.
- **Sign-in page.** Branded, with the restaurant's mark and a short line on what the
  system does. Sign in by email, mobile or employee code.
- **Top bar.** Brand mark, restaurant and outlet, the notification bell, and a small
  profile menu (Profile, Switch user, Sign out) in place of the large Logout button.
  It fits a phone screen.
- **Every screen.** A clear title and one line on what it is for, the main action easy to
  find, filters in one tidy row, figures shown as tiles with icons, tables that line up
  with the same row actions, and empty screens that say what to do next. Settings is
  split into sections, not one long form. Input boxes no longer look greyed out.
- **The till and the floor.** A POS built for speed at rush hour, a captain screen made
  for phones, and a kitchen screen readable from across the kitchen on a TV.
- **Checked on real sizes.** Every screen photographed and checked at desktop and phone
  width, with no errors.

**The live dashboard (stage 6)**

Everything the owner or manager needs to see during service, each linked to its screen
and refreshing on its own: sales so far and against the same day last week, running
tables and how long they have sat, the kitchen queue and late tickets, today's
reservations and who is late, QR orders and waiter calls waiting, deliveries out and
running late, staff on duty and late arrivals, stock about to run out, waste today,
regulars at a table, and the alerts from the bell. Sales figures show only to people
allowed to see them. The items you asked to remove stay removed: the food-cost card,
the monthly average-bill tile, and the split-bill button.

---

## The eight new modules

Built alongside the audit. Each is finished and tested by its builder, then reviewed
and fixed by an independent reviewer before it counts as done.

| Module | Screen | Builder's tests | Status |
|---|---|---|---|
| Kitchen display (KDS) and KOTs | `/kitchen` | 200 passed | Built · reviewed · review findings fixed |
| Reservations and walk-in waitlist | `/reservations` | 219 passed | Built · reviewed · review findings fixed |
| QR table ordering and waiter calls | `/table-requests` | 263 passed | Built · reviewed · review findings fixed |
| Notification bell and alerts page | `/notifications` | 202 passed | Built · reviewed · review findings fixed |
| Deliveries board, channels and riders | `/deliveries` | 190 passed | Built · reviewed · review findings fixed |
| Staff time clock (PIN kiosk) | `/staff/timeclock` | 223 passed | Built · reviewed · review findings fixed |
| Waste log and smart reorder | `/inventory/insights` | 233 passed | Built · reviewed · review findings fixed |
| Guest insights and segments | `/crm/insights` | 121 passed | Built · reviewed (passed) · minor follow-ups fixed |

The new modules are on the test database. They reach the demo database once they
have passed review.

---

## Done last: features that need an outside service

As agreed, these wait until everything else is complete. Each needs an account or an
agreement with another company before it can work.

- **Swiggy and Zomato** — orders arriving straight into the POS and kitchen screen,
  menu and sold-out sync, and settlement and commission reconciliation. Needs partner
  API access from each aggregator.
- **SMS and WhatsApp** — bill links, points earned, birthday and win-back offers,
  owner alerts for large voids. Needs a paid messaging provider.
- **UPI** — a UPI QR on the bill with automatic payment confirmation, and guests
  paying from the QR table page. Needs a payment gateway account.
- **Password reset by email or SMS code** — needs an email or SMS provider.

---

## Order to kitchen — POS, tables, KOT, QR ordering, reservations

**Score 5/10 · Partial**

> **Reviewer's verdict:** The kitchen screen, QR table ordering, waiter calls and reservations are well built and would hold up in a real service. The weak point is the POS once a table already has an order. Adding food to a table that ordered anything with an add-on fails. Dishes a manager cancelled come back onto the order and the bill. Pressing + or − and then Bill & pay ignores the change. A happy-hour price jumps back to full price when anything is added, and a dish that runs out locks the whole table's order. Staff can also quietly remove dishes the kitchen has already sent out, with no reason, no manager and no record, which is a classic way for staff to steal. You cannot move guests to another table or join tables, and on a captain's phone the order sits below the entire menu. When several tills take orders at the same moment, some fail with 'Internal server error', and the same table can end up with two open orders. All of this can be fixed, but I would not run a Friday night on it until the POS editing bugs are fixed.

**What works well**

- Kitchen display is genuinely strong. It sends each dish to the right station (a dish can override its category). Each new round of dishes is a separate ticket, and edits send only the extra quantity, so nothing is cooked twice. Removed dishes are shown struck through, cancelled orders get a VOID ticket, and it has recall, a reprint counter, timers and late counts.
- QR table ordering is well thought through. Nothing is cooked until staff accept, and a double-tapped order is saved once. Each table is rate-limited, and guests see clear status and rejection reasons. It refuses to add to a table that is already billed and tells staff exactly how to proceed.
- The waiter-call inbox shows live counts, how long each table has waited, repeat asks, sound and average response time.
- Reservations and waitlist are good. Availability shows which tables fit or clash, and seating opens the table's order with the booking note (birthday, cake at 9). Seating over another booking is blocked unless the host chooses 'seat anyway'. It alerts on late parties and long waits, and reasons are required for cancelling.
- The floor plan shows the running amount, time seated, covers and held tables, and a tap opens the right order or booking.
- Prices always come from the menu on the server, never from the device. Cancelling a whole order requires a reason, is audited and appears in the Cancellations report. Orders cannot be taken without an open business day.

**Problems found (13)**

| Ref | Severity | What goes wrong | Status |
|---|---|---|---|
| OTK-01 | Critical | Can't add food to a table once any dish on it has an add-on (POS sends wrong add-on ids) | Fixed |
| OTK-02 | High | Reopening a table brings cancelled dishes back to life, back to the kitchen and onto the bill | Fixed |
| OTK-03 | High | Any order-taker can delete dishes already sent to the kitchen, with no reason, approval or record | Fixed |
| OTK-04 | High | Adding anything to a table re-prices dishes it already ordered (happy hour lost) | Fixed |
| OTK-05 | High | A dish that runs out locks every table that already ordered it | Fixed |
| OTK-06 | High | Bill & pay ignores + / − changes made to dishes already on the order | Fixed |
| OTK-07 | Medium | Two tills saving orders at the same moment get 'Internal server error' | Fixed |
| OTK-09 | Medium | POS appears to let you move a running order to another table but silently doesn't | Fixed |
| OTK-08 | Low | The same table can be opened twice at once; settling one then frees a table that is still eating | Fixed |
| OTK-10 | Low | Saving an edit briefly shows every dish as 'pending' again | Fixed |
| OTK-11 | Low | Floor plan 'Paid' and 'Cleaning' states can never show | Being fixed now |
| OTK-12 | Low | POS table list doesn't warn that a table is held for a booking | Fixed |
| OTK-13 | Low | 'Still running' strip silently shows only the 50 newest open orders | Fixed |

**Missing features (8)**

| Priority | Feature | Why it matters | Status |
|---|---|---|---|
| Must have | Move a running order to another table, join two tables into one order, and move dishes between tables (with KOTs following) | Guests move tables all the time: AC to non-AC, a group grows, two tables are pushed together. Petpooja-class systems do this in two taps, and today staff would have to cancel and re-ring the order. | Being built now |
| Must have | Theft controls on cancelling dishes: required reason, manager approval (PIN) once the kitchen has the dish, partial-quantity cancel through the controlled path, and a 'dishes cancelled after KOT' report by staff member | Deleting dishes after they are cooked is the most common way staff steal. An owner expects a daily 'cancelled after KOT' list with who, what and why. | Being built now |
| Must have | A captain ordering screen made for phones (table first, category tabs, a sticky 'view order / send' bar) | Captains take orders at the table on phones. The current POS puts the table picker and cart below the whole menu at phone width, which is unusable at rush. | Being built now |
| Must have | Save only what changed when an order is edited (keep existing lines, prices and statuses; add, remove or change only what the waiter touched) | This one change fixes the happy-hour re-pricing, the sold-out lockout, the status resets and the brought-back cancelled dishes together. | Being built now |
| Should have | Swiggy/Zomato orders arriving straight into the POS and kitchen screen with accept/reject and food-ready | Most Indian restaurants take a large share of orders through the aggregators. Re-typing them from a tablet is slow and causes mistakes. | Last — needs an outside service |
| Nice to have | Hold and fire courses (send starters now, hold mains until the captain fires them) | Full-service restaurants pace courses. Today everything saved goes to the kitchen at once. | Next round |
| Nice to have | Guests pay the bill from the QR page (UPI) | Saves the wait for the bill folder at peak turnover. Needs a payment gateway. | Last — needs an outside service |
| Nice to have | Captain or waiter name on the KOT, and orders from the POS tagged with who took them | The kitchen and the pass need to know whose table a ticket belongs to, and the owner wants per-captain sales. | Being built now |

---

## Bill, payment and day close — the cash desk

**Score 5/10 · Mostly complete**

> **Reviewer's verdict:** Every step of the cash desk exists and works for a quiet night. Bills add up correctly, one bill can be paid by UPI, card and cash with change worked out, voids and refunds need a reason and are logged, and the day-end sheet matched my test sales to the paisa. It is not ready for a busy Friday. When two tills raised bills at the same moment, 4 out of 6 failed with an error. And once a bill is voided, the order can no longer be edited, which is the normal way to add a dessert or fix a mistake. Dues collected or refunds given today on an older bill are recorded against the old, already-closed day, so the drawer will not match. The printed bill also does not add up on paper: the dish amounts include tax but the subtotal does not, and CGST plus SGST can be a paisa off. Service charge is added to takeaway bills, carries no GST, and cannot be taken off for a guest. Theft controls are thin: a cashier can void, refund and cancel with no manager, reprints from the POS are not tracked, and there is no on-the-spot discount, complimentary bill, credit note or cash drawer per shift.

**What works well**

- All money is worked out on the server from the menu. Bill arithmetic (discount, tax scaled down after the discount, service charge, round-off) matched a hand calculation to the paisa.
- Several tenders on one bill work cleanly (UPI 500 + card 200 + cash 353 with Rs 147 change). Overpaying, paying a paid bill and over-refunding are all refused.
- Void and refund both need a reason. Both are in the activity log with amounts, and a paid bill cannot be voided.
- Voiding puts ingredients back in stock and returns redeemed loyalty points.
- The day-close guard is well thought out: open orders block the close with links to each, and unpaid bills need an explicit 'carry as dues' tick that is written onto the day.
- For same-day activity, the day-end sheet reconciled exactly: +Rs 1,749 cash, +Rs 957 card, +Rs 500 UPI. A UPI refund made through the API was correctly kept out of the drawer.

**Problems found (16)**

| Ref | Severity | What goes wrong | Status |
|---|---|---|---|
| BTC-02 | High | After voiding a bill, the order cannot be edited (500 error) | Fixed |
| BTC-03 | High | Dues collected and refunds given today are booked to the old bill's (closed) day | Being fixed now |
| BTC-04 | High | Refunding part of a part-paid bill makes the guest owe less, and the bill can never be voided | Being fixed now |
| BTC-06 | High | Happy-hour price is lost when anything is added to the order later | Fixed |
| BTC-12 | High | Add-ons come back from the server with the wrong ids | Fixed |
| BTC-01 | Medium | Two tills billing at the same moment get 'Internal server error' | Being fixed now |
| BTC-05 | Medium | Printing from the POS is never counted, so duplicate bills leave no trace | Being fixed now |
| BTC-07 | Medium | Printed bill does not add up on paper | Being fixed now |
| BTC-08 | Medium | Service charge added to takeaway bills, carries no GST, and cannot be removed | Being fixed now |
| BTC-09 | Medium | POS coupon and points re-bill uses up coupon limits and hides real voids | Being fixed now |
| BTC-10 | Medium | Refunds from the Bills screen are always recorded as cash | Being fixed now |
| BTC-11 | Medium | Expenses go to the calendar date, not the business day; expense edits and deletes are not logged | Being fixed now |
| BTC-13 | Low | Bills screen 'Sales today' shows lifetime totals when no day is open | Being fixed now |
| BTC-14 | Low | Any date can be opened as a business day; a blank closing count closes as Rs 0 | Being fixed now |
| BTC-15 | Low | Waiters can see the day's takings and reprint bills | Being fixed now |
| BTC-16 | Low | Cess can be entered on a tax rate but is never charged | Being fixed now |

**Missing features (14)**

| Priority | Feature | Why it matters | Status |
|---|---|---|---|
| Must have | Manager approval (PIN) and separate permissions for void, refund, reprint, discount and day close | Right now a cashier alone refunded cash, voided and cancelled the order, and can see the expected cash before counting. There is no permission that allows taking payment without also allowing refunds. | Being built now |
| Must have | On-the-spot discount at the till (% or amount, bill or item) with a reason and role limits | Indian restaurants give discounts at the table every night (regulars, delays, complaints). Today a manager has to create a coupon code in the back office first. | Being built now |
| Should have | Close-day screen with expected cash, over/short, a count by note, an optional blind count, and a card/UPI total check | The close dialog asks only for counted cash. The over/short appears later in Reports, and the cashier can see the expected figure beforehand. | Being built now |
| Should have | Cash drawer per shift or cashier (X-report), with cash in/out for float, petty cash and cash drop | With two shifts or two counters there is no way to know whose drawer is short. Expenses are the only way cash leaves the drawer. | Being built now |
| Should have | Complimentary / no-charge bills with reason and approval | Staff meals and the owner's guests are daily. Without this they get voided or discounted to zero, which hides them. | Being built now |
| Should have | Credit notes and item returns for refunds (reduce GST, optionally reverse points) | Refunds are money-only. The tax report still shows GST on refunded sales, and earned points are not taken back. | Being built now |
| Should have | Customer credit (on-account) ledger: dues per customer, collect later, statement | Dues exist only as unpaid bills. There is no view of who owes what, and no way to settle several bills together. | Being built now |
| Should have | Full GST tax-invoice layout: 'Tax Invoice' title, CGST/SGST rates, SAC 996331 or HSN, address, customer GSTIN for B2B, payment modes, cashier | The printed bill lacks the tax rates and SAC/HSN codes that a tax invoice is expected to show, and business customers cannot get a bill with their GSTIN. | Being built now |
| Should have | Separate business day and invoice numbering per outlet | All outlets share one day, one drawer and one invoice series. Outlets with their own GSTIN need their own series and their own cash-up. | Next round |
| Should have | Direct thermal printing and cash-drawer kick | Bills go through the browser print dialog. A counter printer that prints silently and pops the drawer is standard. | Next round |
| Should have | Accountant export (Tally sales vouchers, daily GST summary) | Only CSV exports exist. Accountants reconcile in Tally. This may overlap the Reports area. | Being built now |
| Nice to have | Aggregator settlement reconciliation (Swiggy/Zomato payouts and commission) | Online-order money arrives net of commission days later and needs matching against bills. | Last — needs an outside service |
| Nice to have | UPI QR on the bill with payment confirmation | Stops fake 'payment done' screenshots and saves typing references. | Last — needs an outside service |
| Nice to have | Bills search (number, mobile, date) and a date column | The list shows only a time, and 500 bills at most. Finding last week's bill for a reprint or a due means scrolling. | Being built now |

---

## Menu and pricing

**Score 5/10 · Mostly complete**

> **Reviewer's verdict:** Almost every menu feature exists and works: categories, dishes with photos, veg/non-veg/egg dots, sizes, add-ons, combos, GST rates with HSN codes, happy hours, CSV import and export, kitchen station routing and recipe costing. I built a real dish on the test system, sold it, marked it sold out and imported a CSV. The server enforces sold-out and always sets the price itself, which is the right base. But several faults would cost money or break the law in a real week. A CSV that only updates prices quietly turns non-veg dishes into veg, removes their GST and brings sold-out dishes back. A happy-hour price is applied to every size, so a ₹150 Half plate was charged ₹250. Cess is never added to the bill. Dish price changes are not recorded anywhere. Only a manager can mark a dish sold out, and only from the Menu page, so the kitchen and captains cannot do it during service. Fix those first; after that this area is close to Petpooja level for a single outlet. What is still missing: separate prices for Swiggy/Zomato/takeaway, packaging charges, add-on rules (pick 1, up to 3), per-outlet menus, and tax-inclusive pricing for MRP items like bottled water.

**What works well**

- The server works out every price from the menu. The browser only says which dish, size, add-ons and quantity, so a till cannot be used to invent a price.
- Tax rates carry the HSN/SAC code, which is copied onto each order line. Changing a rate updates every dish that uses it without touching old bills.
- Sold-out is enforced by the server with a clear message. POS cards grey out, and the QR menu shows the dish as sold out rather than hiding it.
- The import checks the whole file before saving anything, lists problems by row number, and saves either everything or nothing.
- Combos show the saving against buying the parts separately, and selling a combo takes its parts' ingredients out of stock.
- Kitchen routing is well thought out: each category goes to a station, single dishes can be sent elsewhere, and a catch-all station means nothing gets lost.

**Problems found (14)**

| Ref | Severity | What goes wrong | Status |
|---|---|---|---|
| B1 | Critical | A price-only CSV import quietly turns non-veg dishes veg, removes their GST, wipes codes and brings sold-out dishes back | Fixed |
| B2 | High | A happy-hour price applies to every size: the Half plate costs more during happy hour, and the POS shows a different price from the bill | Fixed |
| B9 | High | Dish price changes and sold-out switches leave no trace in the activity log | Fixed |
| KNOWN-1 | High | Reopening an order that has an add-on and adding a dish fails | Fixed |
| KNOWN-2 | High | Changing a running order re-prices happy-hour dishes and is refused if an earlier dish has since sold out | Fixed |
| B3 | Medium | You cannot change a size's price on screen, and a size that has been sold cannot be removed | Fixed |
| B6 | Medium | Staff orders accept add-ons and sizes that are switched off or not offered, and dishes from switched-off categories | Fixed |
| B7 | Medium | Cutting a dish's base price can leave a size with a negative price, and ringing it up then fails with 'Internal server error' | Fixed |
| B8 | Medium | A combo still sells when a dish inside it is sold out, and combos can end up inside other combos | Fixed |
| B11 | Medium | Dish short codes do nothing at the POS | Fixed |
| B4 | Low | Deleting a dish, size or add-on with sales history shows 'Internal server error' | Fixed |
| B5 | Low | The Cess % on a tax rate is saved and shown but never charged | Being fixed now |
| B10 | Low | Switching off a tax rate stops you editing the dishes that use it, but they keep selling at that rate | Being fixed now |
| B12 | Low | An 'outlet-only' happy hour applies at every outlet | Fixed |

**Missing features (11)**

| Priority | Feature | Why it matters | Status |
|---|---|---|---|
| Must have | Quick sold-out switch for kitchen, captains and cashiers, on the POS and kitchen screen, with its own permission, and dishes back on sale automatically when the next day opens | On a Friday night the kitchen knows first that paneer is finished. Today only a manager can switch a dish off, from Menu > Products, and the switch also allows price editing. Dishes also stay sold out into the next day until someone remembers. | Being built now |
| Should have | Different prices for dine-in, takeaway, Swiggy, Zomato and own delivery | Nearly every Indian restaurant charges 10-25% more on aggregators to cover commission. Here each dish has one price for everything. | Next round |
| Should have | Packaging charge per item for takeaway and delivery | Standard on Indian bills and required on Swiggy/Zomato listings. Right now it has to be hidden inside the dish price. | Next round |
| Should have | Add-on groups with rules (choose 1 spice level, up to 3 toppings, a required choice) and combos with a choice ('any 1 starter + any 1 main') | Pizzas, thalis with a choice of curries and meal deals need these. Today add-ons are one flat list with no limits, and combos are fixed. | Next round |
| Should have | Tax-inclusive price per item (MRP items such as bottled water and cold drinks) | The tax setting covers the whole restaurant. A restaurant that adds GST on top of food cannot sell an MRP item at MRP, and charging above MRP is illegal. | Next round |
| Should have | Menu and prices per outlet (dish available here but not there, city-specific price) | Outlets exist, but every outlet sells the identical menu at identical prices. A second branch in another city nearly always differs. | Next round |
| Should have | Safer, fuller menu import: only change the columns in the file, create missing categories, accept 'Non-Veg' and '1,200', import sizes and add-ons, offer a sample file | Import is how a new restaurant loads a 300-dish menu and how prices are revised each year. Right now it can only load dishes, needs every category typed in first, and is dangerous for updates (B1). | Being built now |
| Should have | Menu and sold-out sync to Swiggy/Zomato | A dish marked sold out in the restaurant should disappear from the apps too. This needs partner access from Swiggy and Zomato. | Last — needs an outside service |
| Nice to have | Menu available only at set times (breakfast till 11, late-night menu), and sold-out per size (Half biryani gone, Full still on) | Common in Petpooja setups. Happy hours change prices but cannot hide dishes outside their serving hours. | Next round |
| Nice to have | Add-ons that take ingredients out of stock (Extra cheese uses 30 g cheese) | Cheese and butter add-ons are a big source of unexplained stock loss when they are not tracked. | Next round |
| Nice to have | Bulk price revision (for example +8% on a category) with a preview | Menu price rises happen once or twice a year. Today the only bulk route is the CSV import, which currently corrupts data (B1). | Being built now |

---

## Stock, recipes and purchasing — back of house

**Score 5/10 · Partial**

> **Reviewer's verdict:** No, the back-of-house side is not finished. I ran the whole chain on the test system: raise a purchase order, receive a short delivery, return damaged paneer, pay the supplier part, sell dishes, then count stock. Five of the six steps work. When 3 plates were billed, paneer dropped by exactly 0.45 kg and oil by exactly 0.09 L, and stock records balance for every item in the test restaurant. What's missing is the weekly store work. There is no stock-count screen and no variance report. You can't record a daily vegetable or meat purchase without first raising a purchase order. A short delivery can never be closed off, and the bill number or the price actually charged can't be recorded when goods arrive. I also found one serious bug: deleting an older draft purchase order stops anyone from creating new ones. Other bugs quietly give wrong numbers: half plates take full-plate ingredients, one wrongly priced return changes the cost of every dish that uses that item, and the "Still owed" total nets off advances. For a single-outlet restaurant with a careful manager it's usable today. A busy or multi-outlet Petpooja-style operation should not rely on it for food-cost control yet.

**What works well**

- Every stock change goes through one locked, all-or-nothing record. A SQL check across every item in the test restaurant found zero cases where the movement history, live stock and per-location totals disagree.
- Automatic deduction when dishes are billed is exact: 3 plates took exactly 0.45 kg paneer and 0.09 L oil. Combos expand into their parts, and voiding a bill puts the ingredients back.
- A guest's bill is never blocked by a stock shortfall (stock may go negative, and an alert asks for a count), while manual stock-outs are refused below zero.
- Partial receiving is well guarded: nothing can be received on a draft or beyond what's outstanding, and what's owed is based on goods actually received, not what was ordered.
- History is protected: items with movements, suppliers with POs and units in use can't be deleted.
- Low-stock alerts name the open purchase order and its due date, and the dashboard link opens the list already filtered to low items.

**Problems found (12)**

| Ref | Severity | What goes wrong | Status |
|---|---|---|---|
| BOH-1 | High | Deleting an older draft purchase order blocks every new purchase order | Fixed |
| BOH-2 | Medium | A part-received purchase order can never be closed | Fixed |
| BOH-3 | Medium | A purchase return's price overwrites the item's cost for all recipes and stock value | Fixed |
| BOH-4 | Medium | Half-plate (and any size) sales take the full-plate recipe | Fixed |
| BOH-5 | Medium | Stock consumption report counts voided bills as used | Fixed |
| BOH-6 | Medium | Sales at an outlet take stock from the main store, not that outlet | Fixed |
| BOH-8 | Medium | Supplier payments can't be corrected, and some bad inputs crash with 'Internal server error' | Fixed |
| BOH-7 | Low | 'Still owed' total nets one supplier's advance against another's dues | Fixed |
| BOH-9 | Low | Stock movements screen: returns unlabelled and unfilterable, and POs shown by an internal number | Fixed |
| BOH-10 | Low | An item's unit can be changed while it holds stock | Fixed |
| BOH-11 | Low | Floor staff (Captain) can read ingredient cost prices and dish margins | Fixed |
| BOH-12 | Low | 'Receive now' boxes look pre-filled but are empty | Fixed |

**Missing features (15)**

| Priority | Feature | Why it matters | Status |
|---|---|---|---|
| Must have | Physical stock count (closing stock entry) with a variance report, counted vs system, in quantity and money | The weekly or daily count is how a kitchen finds theft, over-portioning and waste. Today each item's difference has to be worked out by hand and entered as a stock-out, and no report shows the shortage. | Being built now |
| Must have | Direct purchase entry (purchase bill without a PO): supplier, bill number and date, price as billed, cash or credit | Most daily vegetable, meat and dairy buying in Indian restaurants happens without a PO. Today it can only go in as '+ In', which never reaches what's owed to the supplier or any purchase report. | Being built now |
| Should have | Goods receipt that records the supplier's bill number, the actual price, and quantity rejected at the door | Prices change daily and deliveries arrive short or damaged. Without this, food cost and supplier dues drift from the real bills and nothing ties them to a bill for matching. | Being built now |
| Should have | Supplier statement: running balance per supplier, due dates from credit terms, ageing, and edit/void of payments and returns | Owners pay suppliers by statement and due date. Today there's a single outstanding figure per supplier, and payment mistakes can't be fixed. | Being built now |
| Should have | Cash paid to suppliers from the till counted in day-end cash | Paying the vegetable vendor from the drawer is routine. Day-end only subtracts expenses, so the drawer looks short, or the payment gets entered twice as an expense. | Being built now |
| Should have | Accountant reports: purchase register (GSTIN, bill number, taxable value, GST), stock valuation / closing stock on a date, Tally export | The accountant needs purchase books and closing stock for month end and GST. Only a consumption report exists, and it can't be reconciled from opening to closing. | Being built now |
| Should have | Unit conversion between purchase and usage units (tin to ml, tray to eggs, crate to kg) | Suppliers sell in packs and recipes use grams, ml or pieces. Without conversion, staff do the arithmetic at every receipt and count, and errors creep in. | Being built now |
| Should have | Semi-finished items / sub-recipes (base gravies, marinated chicken, biryani rice batch) with a production entry | Indian kitchens cook bases in bulk. Without this, recipes can't express 'uses 120 ml makhani gravy', and bulk prep shows up as variance. | Next round |
| Should have | Recipes for add-ons / modifiers (extra paneer, extra cheese) | Add-ons are sold at a price but take nothing out of stock (product_recipes has no modifier link), so they always show as shortage. | Next round |
| Should have | Stock handling for food cooked and then cancelled after the KOT | Stock only leaves at billing, so cancelled-after-cooking items never leave stock and appear as unexplained variance. They should go out as wastage with a reason. | Next round |
| Should have | Separation of duties and approvals: separate rights to receive goods and to pay suppliers, approval for large POs and large stock-outs/wastage, and letting kitchen staff record wastage for approval | Today one Manager can raise, receive, return and pay with no second check, which is a classic purchase-fraud gap. The Kitchen role can't log wastage at all. | Being built now |
| Should have | Edit a draft PO; print, PDF or share a PO with the supplier | Orders are phoned or sent by message to suppliers. Today a draft has to be deleted and re-typed to change a line, and there's nothing to send. | Being built now |
| Should have | Date range filter and export on Stock movements | You can't look at last month's movements for an audit; the screen stops at the latest 500. | Being built now |
| Nice to have | Weighted-average costing (instead of last purchase price) and reports valued at the cost at the time | With last-price costing, food cost % and past reports jump with every purchase or return price. | Next round |
| Nice to have | Expiry / batch tracking for dairy, meat and packaged goods | Helps issue older stock first and explains spoilage. Petpooja-class users expect at least expiry on receipt. | Next round |

---

## Guests, loyalty and feedback

**Score 4.5/10 · Partial**

> **Reviewer's verdict:** The basics are in place and mostly work: a guest book, signing up a new guest at the till, points earned when a bill is paid, a full points history, feedback (including from the table QR), and complaints that need a written resolution before they can be closed, with alerts for bad ratings and old complaints. On a real Friday night, though, loyalty breaks in the most common case. If a captain takes the order and the cashier finds the regular at payment time, the guest shows on screen but is never saved on the order. So they earn nothing, and "Use points" quietly takes nothing off. Other problems: a bill paid fully with points can never be closed, a refund lets the guest keep the points they earned, and any cashier can give anyone up to 100,000 points and spend them straight away. Credit customers and dues, points expiry, birthday or marketing messages, and a proper duplicate check on mobile numbers do not exist yet. Guest insights is still being built.

**What works well**

- Every points movement is a ledger line with the balance after it, and the customer row is locked while points move, so two tills cannot spend the same points.
- Points are earned only once the bill is fully paid, only once per bill (enforced by the database), and voiding a bill gives redeemed points back.
- A new guest can be signed up at the till without losing the cart, and a search that finds nobody says so and offers 'Add as a new guest'.
- A complaint cannot be closed without writing how it was resolved; the resolved time is stamped and cleared on reopen.
- Poor ratings (1-2 stars) and old, unassigned or high-priority complaints appear in the notification bell the same day.
- Table QR feedback works without a login and is rate-limited per table.

**Problems found (12)**

| Ref | Severity | What goes wrong | Status |
|---|---|---|---|
| CRM-1 | High | Guest attached at billing is never saved on the order, so no points are earned and 'Use points' does nothing | Being fixed now |
| CRM-2 | High | A bill fully paid with points can never be settled | Being fixed now |
| CRM-3 | High | Any cashier can create points from nothing and spend them straight away | Being fixed now |
| CRM-4 | Medium | Refunding a bill leaves the earned points with the guest | Being fixed now |
| CRM-5 | Medium | 'Use points' voids the bill first; a mistake leaves a dead bill on screen, and a coupon afterwards drops the points | Being fixed now |
| CRM-6 | Medium | Deleting a guest with any history crashes with 'Internal server error' | Fixed |
| CRM-7 | Medium | Mobile numbers are not normalised, so the same guest gets duplicate records | Fixed |
| CRM-8 | Medium | POS 'Mobile' field does not look up the guest | Fixed |
| CRM-9 | Low | Points redemptions are reported as 'Manual' discounts | Being fixed now |
| CRM-10 | Low | A split bill shows twice in guest history (React duplicate-key error) | Fixed |
| CRM-11 | Low | Complaints can be assigned to another restaurant's staff; an unknown user id crashes | Fixed |
| CRM-12 | Low | Guest book, Feedback and Complaints only ever see the first 500 guests | Fixed |

**Missing features (11)**

| Priority | Feature | Why it matters | Status |
|---|---|---|---|
| Must have | Credit customers and dues ledger (bill on account, settle later, statement per guest or company) | Regulars, offices and caterers running a tab is everyday practice in India; today dues are only a note on the closed day, not tied to anyone. | Being built now |
| Must have | Loyalty controls: approval or limit for manual points, maximum redemption per bill, points expiry, choice to earn on amount before tax | Without these, points are an open cheque for staff and a liability that grows forever on the owner's books. | Being built now |
| Must have | Automatic guest lookup and creation from the mobile number typed at the POS (and a mobile field for captains and dine-in) | Guest capture has to be one step at order time or it will not happen during a rush. | Being built now |
| Should have | Mobile number cleanup and duplicate merge (+91/0/spaces, 10-digit check, merge two records) | One guest, one record is the base of loyalty, visit history and messaging. | Being built now |
| Should have | SMS/WhatsApp messages: bill link, points earned, birthday/anniversary offers, win-back campaigns | This is how Indian restaurants bring guests back; it needs DLT-registered SMS or a WhatsApp Business provider. | Last — needs an outside service |
| Should have | Marketing consent and privacy controls (opt-in flag, masked mobiles for floor staff, owner-only export, proper 'delete my data') | The DPDP Act 2023 requires consent for marketing, and staff should not be able to read every guest's number. | Being built now |
| Should have | Guest GSTIN and company name for B2B tax invoices | Corporate guests ask for a GST bill in their company's name to claim input credit; the customer record has no field for it. | Being built now |
| Should have | Loyalty and guest reports: points owed, redemptions by day, customer-wise sales, CSV export | The accountant needs the points liability, and the owner needs to see who the top guests are. | Being built now |
| Should have | Complaints linked to a bill or order, a mobile field for walk-ins, and a record of compensation given | A billing complaint cannot be checked without the bill, and a guest who is not in the book cannot be called back. | Being built now |
| Nice to have | Receipt shows guest name, points earned and new balance | Guests only value points they can see; Petpooja prints this. | Being built now |
| Nice to have | Guest list columns: visits, last visit, total spend, tags (VIP, allergy), sorting and paging | Managers use the guest list to recognise regulars and plan calls; today it only shows contact details and points. | Being built now |

---

## Staff, roles and security

**Score 5/10 · Partial**

> **Reviewer's verdict:** The basics work and hold up. Every action is locked to the right roles on the server, the Captain and Cashier I created were refused everything they shouldn't do, and one restaurant can never see or change another's staff, roles or records. What isn't ready for a busy Friday night is theft control. A cashier can void a printed bill, cancel the order and refund cash alone, with no manager approval. A captain can quietly remove a dish already sent to the kitchen, and nothing records it. Anyone you give "manage users" can make themselves owner or take over the owner's login. On the staff side, day shifts work, but a shift that runs past midnight can't be saved. The payroll estimate doesn't pay weekly offs, and cashiers can see everyone's salary. One thing must change before a real restaurant uses this: the server still uses the example login secret, so anyone who knows it can sign in as any user, including the platform owner.

**What works well**

- The server checks permission on every action: 17 of 17 sensitive calls by a Captain were refused, and the menu hides what each role can't open ('Access denied' if typed in).
- Restaurants are properly walled off: every attempt to read or change another restaurant's users, roles or employees was refused. The platform-owner role and its permission can't be handed out inside a restaurant, and built-in roles can't be tampered with.
- Roles and account status are re-read on every click, so deactivating a staff member cuts them off immediately.
- Reasons are required for bill void, order cancel, refund and loyalty point changes. Bills with money on them can't be voided (refund is forced), and reprints are counted and logged with who did them.
- Passwords are stored safely (bcrypt), login doesn't reveal which emails exist, and changing your own password needs the current one.
- The staff module is broad: employees, shift patterns, weekly roster with week-off and leave, attendance with automatic late and overtime maths, and a payroll estimate with CSV export.

**Problems found (17)**

| Ref | Severity | What goes wrong | Status |
|---|---|---|---|
| SEC-1 | High | Anyone allowed to 'manage users' can make themselves owner or take over an admin's login | Fixed |
| SEC-3 | High | A captain can remove a dish already sent to the kitchen, with no cancel permission, reason or record | Fixed |
| SEC-2 | Medium | Login tokens can be forged: the server runs with the example secret | Fixed |
| SEC-4 | Medium | Item cancellations take no reason, log only an internal id, and never appear in the cancellation report | Fixed |
| SEC-5 | Medium | Staff pinned to one outlet can see, void and cancel other outlets' bills, and can work in an inactive outlet | Partly fixed — finishing |
| SEC-6 | Medium | Cashiers can see every employee's salary | Fixed |
| SEC-7 | Medium | Captains and kitchen staff see the day's total sales and cash on the dashboard | Partly fixed — finishing |
| SEC-8 | Medium | Shifts that run past midnight cannot be recorded on the Attendance page | Fixed |
| SEC-9 | Medium | 'Mark remaining present' marks people on their week off as present, and shows success even when it stops early | Fixed |
| SEC-10 | Medium | Payroll estimate does not pay weekly offs or paid leave | Fixed |
| SEC-12 | Medium | Login limit is shared by everyone on one internet connection and counts successful logins | Fixed |
| SEC-14 | Medium | Several sensitive changes leave no trace in the activity log | Fixed |
| SEC-11 | Low | Roles page shows wrong permission and user counts | Fixed |
| SEC-13 | Low | Staff are logged out 8 hours after signing in, mid-service, and lose the unsaved POS cart | Fixed |
| SEC-15 | Low | Changing or resetting a password leaves existing sessions signed in | Fixed |
| SEC-16 | Low | Lateness would read zero if the server runs on UTC time (typical cloud) | Fixed |
| SEC-17 | Low | An admin can remove their own admin role, and nothing protects the last admin | Fixed |

**Missing features (12)**

| Priority | Feature | Why it matters | Status |
|---|---|---|---|
| Must have | Manager approval (PIN or OTP) for void, cancel after KOT, refund, reprint and large discounts, with configurable limits | Today one cashier can print a bill, void it, cancel the order and refund cash alone. Petpooja-class systems make a manager confirm these. | Being built now |
| Must have | Finer permissions: separate 'void bill', 'refund', 'cancel item after KOT', 'close day', 'see sales figures', 'see salaries', plus editable or copyable built-in roles | Billing and voiding are one permission, as are payments and refunds. Built-in roles can't be trimmed, so an owner can't have a cashier who bills but can't void. | Being built now |
| Must have | Item cancellation (KOT void) report with dish, quantity, value, who, when and a required reason from a list | Item cancellations are the main leak in Indian restaurants. Today they appear nowhere except as an internal id in the activity log. | Being built now |
| Must have | Quick staff switch on a shared POS or tablet (personal PIN) with auto-lock when idle | Busy counters share one terminal. Without a fast switch everyone uses one login, and the activity log can't say who voided what. | Being built now |
| Should have | Activity log an owner can use: date range, staff filter, 'money-sensitive only' view, readable details, export, and Manager access without 'manage roles' | The 500-row window fills with routine payments. There is no way to answer 'show me all voids and refunds by Ravi last week'. | Being built now |
| Should have | Per-account lockout after repeated wrong passwords, plus a sign-in history | Password guessing is only slowed per internet address. The owner can't see who signed in, when, or failed attempts. | Being built now |
| Should have | Sign out everywhere, and end old sessions when a password is changed or reset | A leaked password stays usable for up to 8 hours after it is reset. | Being built now |
| Should have | Staff sign-in by mobile number or employee code instead of only email | Most captains, cooks and helpers have no email address, so owners invent fake ones. | Being built now |
| Should have | Self-service 'forgot password' by email or SMS code | Today only an admin can reset a password. If the owner forgets theirs, nobody can reset it. | Last — needs an outside service |
| Should have | Payroll completeness: paid week-offs and leave policy, leave balances, advances and deductions, PF/ESI/professional tax, payslips, and 'mark as paid' linked to expenses | The current screen is an estimate only. Indian restaurants pay advances mid-month and must handle PF/ESI for larger teams. | Being built now |
| Nice to have | Owner alerts (WhatsApp or SMS) when a void, refund or cancellation above a set amount happens | Owners who aren't on the floor rely on instant alerts to deter theft. | Last — needs an outside service |
| Nice to have | Two-step sign-in for owner and admin accounts | Admin accounts can change prices, users and money records, so one stolen password is costly. | Next round |

---

## Owner view — dashboard, reports, settings, outlets

**Score 6/10 · Mostly complete**

> **Reviewer's verdict:** The owner's side works day to day. When I rang up real sales, the dashboard, the sales report, the day-end sheet and the cashier's summary all moved by exactly the same ₹1,537, and the expected cash in the drawer was right to the rupee. It isn't ready for your accountant yet: the GST report leaves out service charge, which is also added to takeaway and delivery bills with no GST on it and can't be removed. There is also no profit & loss, no Tally export and no bill-by-bill register. It isn't ready for several branches either, because picking an outlet at the top doesn't change what the dashboard or reports show, and 99.85% of today's test sales are filed under no outlet. Before a real Friday night, fix three things: every staff login, kitchen and waiters included, can see the day's takings and the cash that should be in the drawer; a captain can quietly take a dish off an order after the kitchen has it, and nothing records it; and one typo in the Timezone setting stops the till from taking orders.

**What works well**

- Figures agree across screens to the paisa for normal bills: my ₹1,537 of sales, ₹75.43 of tax, ₹200 UPI and ₹40 refund moved the dashboard, sales report, GST report, day-end sheet and cashier summary identically
- Reports and dashboard follow the business day, not the calendar, and say so plainly after midnight ('Showing the business day that is still open — Wednesday, 23 September')
- The day-end sheet does the drawer arithmetic correctly (opening + cash sales − cash refunds − cash expenses) and shows over/short at close
- Dashboard compares honestly: 'same time last week' rather than a full day, and refuses a month-on-month percentage when last month barely traded; Needs attention links straight to filtered lists
- Menu performance lists dishes that never sold, with 'last sold' ageing, which most tills can't show
- Notifications are worked out live, filtered by role, keep each person's read marks, and one broken module can't empty the bell

**Problems found (16)**

| Ref | Severity | What goes wrong | Status |
|---|---|---|---|
| MV-1 | High | Service charge is added to takeaway and delivery bills, can't be taken off, carries no GST, and is missing from the GST report *(being re-checked)* | Being fixed now |
| MV-2 | High | Kitchen staff and waiters can see the day's takings, the month's sales and the cash that should be in the drawer *(being re-checked)* | Fixed |
| MV-3 | High | One typo in Settings → Timezone stops the till taking orders; 'UTC+05:30' silently shifts the clock by 11 hours *(being re-checked)* | Being fixed now |
| MV-4 | High | A captain can remove a dish the kitchen already has by editing the order, and no report or log records it *(being re-checked)* | Fixed |
| MV-5 | Medium | Cancellations & voids report uses the calendar date, so voids after midnight vanish from that night's report *(being re-checked)* | Fixed |
| MV-6 | Medium | Outlet switcher doesn't change what the dashboard and reports show, and its default files sales under no outlet *(being re-checked)* | Partly fixed — finishing |
| MV-7 | Medium | 'Per head' spend is wrong, and the dashboard and reports give different figures for the same day *(being re-checked)* | Fixed |
| MV-8 | Medium | Item-wise sales list is silently cut at 100 dishes (screen and CSV) *(being re-checked)* | Fixed |
| MV-9 | Medium | Receipt lacks the restaurant's address and phone and the tax rate, and says 'Subtotal/Tax' rather than 'Tax Invoice' *(being re-checked)* | Being fixed now |
| MV-10 | Low | CGST and SGST don't add up to the tax, on the GST report and on the receipt *(being re-checked)* | Fixed |
| MV-11 | Low | Split bills make the GST, item, category and dashboard figures double-count (latent: the API still accepts splits) *(being re-checked)* | Fixed |
| MV-12 | Low | Deleting an outlet that has sales shows 'Internal server error' *(being re-checked)* | Fixed |
| MV-13 | Low | Reports' 'Busiest hours' ignores the restaurant's timezone setting *(being re-checked)* | Fixed |
| MV-14 | Low | Sales trend skips days with no sales and draws a straight line across them *(being re-checked)* | Fixed |
| MV-15 | Low | Printed reports carry no dates; impossible dates give a server error *(being re-checked)* | Fixed |
| MV-16 | Low | Admin guide is out of date for the owner screens *(being re-checked)* | Fixed |

**Missing features (13)**

| Priority | Feature | Why it matters | Status |
|---|---|---|---|
| Must have | GST filing pack: bill-by-bill sales register export, GSTR-1 style summary (B2B with guest GSTIN, B2C by rate, nil/exempt, HSN summary), credit notes for refunds, invoice number range with cancelled count | The accountant files monthly from this. Today they get one rate-wise table and must rebuild the rest from bills by hand, and refunds never reduce the GST shown. | Being built now |
| Must have | Profit & loss report (sales less food cost/purchases, expenses and payroll) and expense-by-category report | The first question an owner asks each month is 'did we make money'; the data exists across modules but no screen puts it together. | Being built now |
| Must have | Service charge rules: dine-in only by default, waivable per bill with a reason, GST applied to it | Needed both for customer fairness (Indian consumer guidelines say it must be voluntary) and for correct GST. | Being built now |
| Should have | Tally / accounting export (day-book: sales, receipts by mode, expenses, purchases) | Most Indian restaurants' CAs work in Tally; without an export someone re-keys every day. | Being built now |
| Should have | Proper multi-outlet: filter every report and the dashboard by outlet, per-outlet business day and cash drawer, per-outlet GSTIN and address, per-outlet hours | A second branch, or one in another state with its own GSTIN, can't be run or filed separately today. | Next round |
| Should have | Theft-control alerts and report: bell alerts for voids, refunds, large discounts, reprints and cash short at close; a 'dishes removed after KOT' report with reason and who | Petpooja owners rely on these to catch fiddles the same day; today they must go and read the activity log. | Being built now |
| Should have | Printable day-end (Z report) on the thermal printer, and a Print button on Reports that shows the date range | Managers sign and file a paper day-end each night. | Being built now |
| Should have | Captain / waiter-wise sales report | The staff tab credits whoever raised the bill (the cashier), so waiter incentives and performance can't be measured. | Being built now |
| Should have | Activity log date and user filters, plus export | It shows only the latest 500 of 5,214 entries with no way to look at 'last Tuesday' or 'this cashier'. | Being built now |
| Should have | Aggregator (Swiggy/Zomato) settlement and commission reconciliation report | Owners need to check payouts against orders; needs partner data access. | Last — needs an outside service |
| Nice to have | Split business hours (lunch and dinner sessions) per day | Most Indian restaurants close between 3 and 7pm; one open–close pair can't express that. | Next round |
| Nice to have | 'Yesterday' and 'Last month' quick picks on Reports | 'Read last night' and 'file last month's GST' are the two most common report ranges. | Being built now |
| Nice to have | Logo on receipt, and a composition-scheme / bill-of-supply mode | Branding on bills; small restaurants under the composition scheme must not show GST and must print a specific line. | Next round |

---

## Status key

| Status | Meaning |
|---|---|
| **Being fixed now** | Assigned and in progress. It moves to *Fixed* only after an independent re-check. |
| **Being built now** | A missing feature that is in progress, built end to end: screen, permissions, records and tests. |
| **Next round** | Planned straight after the current round, because it touches screens being changed right now. |
| **Last — needs an outside service** | Waits until everything else is complete, as agreed. Needs an account with another company. |
| **Fixed** | Done, and re-checked by someone who did not make the fix. |

Severity: **Critical** — stops service or corrupts data. **High** — wrong money, a theft
risk, or a blocked everyday task. **Medium** — a real problem with a workaround.
**Low** — cosmetic or rare.
