# Demo Guide — read-along script

*Written for the live demo of 2 October 2026; brought up to date 22 October 2026. Every
feature below exists in the app today. Sections 1–5 are the restaurant (FoodEx); section 6
is a demo business of every other type, FoodEx's second outlet, the café, the bakery, the
cloud kitchen and the real copies (not for demos). Logins: admin / owner / manager /
cashier / captain / kitchen @foodex.com — the passwords of the last five are in the demo
logins file that `npm run user:demo` wrote (`backend/.local/demo-logins-<random id>.json`).
Never type a password on the projector; sign in before you share the screen.*

---

## 1. Opening pitch (say this first)

"This is a complete restaurant operating system built for Indian restaurants: the till,
the kitchen, the floor, stock, suppliers, guests, staff and the accounts, in one place
where every number agrees with every other number. Where Petpooja gives you billing
with add-ons, we run the whole day: each branch opens and closes its own business day
with its own invoice series; a cashier can't void, refund or give a discount without a
manager's PIN; the dashboard is live and honest — it compares like with like and shows
the empty days; the kitchen gets a live display instead of paper; guests order from a
QR code on the table; stock is tracked by batch and expiry, with recipe costing so every
plate sold takes its ingredients off the shelf; the GST filing pack and Tally day book
are one click; a theft-control report shows every void, refund, reprint and dish taken
off after the kitchen had it; there's loyalty and a proper guest book; staff clock in
with a PIN and a photo, and payroll comes straight from attendance. And all of it works
on a phone."

---

## 2. Suggested running order — "a day in the restaurant" (22 minutes)

| Time | Login | Screen | What you show |
| --- | --- | --- | --- |
| 0:00–1:30 | — | — | The pitch above |
| 1:30–3:00 | manager | **Dashboard** | Live tiles, Needs attention, the bell, outlet switcher |
| 3:00–4:30 | manager | **Daily work → Business day** | Open the day, count the opening float. "Nothing sells until the day is open." |
| 4:30–7:00 | captain | **Operations → Tables & QR** (floor view) → **POS** | Tap a free table → POS opens on it → add dishes with size and add-ons → note for kitchen → save. Point out: captain has no Bill button |
| 7:00–8:30 | phone | **QR table ordering** | Scan a table QR on your phone, order, "Call a waiter". Then **Daily work → Orders › Table requests**: accept it |
| 8:30–10:00 | kitchen | **Daily work → Kitchen display** | Tickets with timers, tap to start / ready / served, sold-out switch |
| 10:00–12:30 | cashier | **POS / Bills & payments** | Raise bill → coupon or loyalty points → pay half cash, half UPI → print. Then try a void: PIN prompt appears, manager enters PIN |
| 12:30–13:30 | cashier | Lock screen | Lock the till, switch to another person with their PIN |
| 13:30–15:00 | manager | **Operations → Stock** (Items & stock) | The dish sold reduced its ingredients; Batches & expiry; low-stock filter |
| 15:00–16:30 | manager | **Daily work → Business day** | Close the day: blind count, over/short. Open orders block the close |
| 16:30–20:30 | owner | **Reports** | Day end · Z report → Theft control → GST filing → Profit & loss → Items & menu "Not sold" |
| 20:30–22:00 | owner | **Phone view** + **Activity log** | Same app on a phone; who did what and who approved it |
| 22:00+ | — | — | Questions (section 4) |

Tip: keep four browser windows ready — manager, captain, kitchen, cashier — so you never
sign in live. Keep your phone ready with a table QR open. A table's QR code opens the
guests' site (`npm run dev:customer`, port 5174), not the staff app. For a phone on the same
Wi-Fi: start it with `npm run dev:customer -- --host`, point `VITE_API_BASE_URL` in
`apps/customer-web/.env` at the computer's network address (`http://<address>:5010/api`), and
enter `http://<address>:5174` under *Management → Settings › Service settings › Guest
ordering web address* before you print the QR.

---

## 3. Every screen, subject by subject

**The sidebar** (since 14 October) has three groups. *Daily work*: Dashboard, POS, Orders
(with Pickup screen, Table requests and Deliveries), Pre-orders & cakes, Bills & payments,
Dues & accounts, Kitchen display, Expenses, Business day. *Operations*: Menu, Tables & QR,
Reservations, Stock, Purchases & suppliers, Customers, Staff. *Management*: Reports (with
Activity log and Log book), Tasks, Settings (with Profile, Business hours, Features, Outlets,
Service settings and Discounts & offers), Users & access. A fourth, *Platform*, is for the
platform owner. Each entry is an area: it opens its first page, and its other pages are
tabs at the top. The headings below follow the subjects; each screen says where it is.

**Before the tour, point at the frame around every page:**

- **Sidebar shows only what your role allows.** No greyed-out buttons — a cashier never sees Payroll. The server checks again on every request.
- **Jump to…** at the top of the sidebar: type "gst" or "stock" and go.
- **Quick access:** pin up to five favourite pages above the menu (Set up → pick → Save shortcuts).
- **The bell:** everything that needs a person now — unpaid bills, low stock, day left open, late deliveries, and for owners the theft alerts as they happen. Also **Notifications** page for the full list.
- **Outlet switcher** (top bar): pick a branch and the dashboard and every report show that branch only.
- **Business switcher** (top bar): every business this login belongs to; pick one and its own Business Admin opens (section 6).
- **Your name** (top bar): My profile — name, mobile, password, personal PIN, two-step sign-in.
- **Lock:** locks a shared till without logging out; next person taps their name and PIN.

### Overview

**Dashboard** — *Daily work → Dashboard*
- For: the screen a manager leaves open all day; refreshes itself every 30 seconds and says when it last looked. The business day is opened and closed right here (the day button), and **Full analysis** opens the reports.
- Show:
  - Sales today vs the same slice of last week (fair comparison, not half a day vs a full day).
  - The Sales, Bills, Orders today (dine-in / takeaway / delivery), Running orders and Tables in use tiles — click one and its details open in a panel over the dashboard.
  - **Needs attention** strip: unpaid bills, late kitchen tickets and deliveries, QR orders to accept, items out of stock or running low, complaints, expenses to approve… worst first, each chip opening its panel.
  - The live blocks (floor, kitchen, table requests, reservations, deliveries, pre-orders, guests, staff on duty, stock) and **Today's trading**: money in by method, Through the day hour by hour, Best sellers / **Slowest**, money out. The week and the month are in Full analysis.
- Talking point: "It's honest. It compares like with like, and it works in business days — a kitchen serving at 12:30 am is still on yesterday's sheet."
- Role view: sign in as **captain** or **kitchen** — same dashboard, but no money; guests, running orders and plates sold instead.

**My work** — *Operations → Staff › My work* (only for a login linked to a staff record)
- For: a staff member's own shifts this week and next, this month's attendance, leave left, and payslips.
- Show: sign in as a staff login, open My work.
- Talking point: "Staff stop asking the manager 'what's my shift' and 'where's my payslip'."

### Service

**POS** — *Daily work → POS*
- For: the till — dine-in, takeaway and delivery orders.
- Show:
  - Pick a category or search; a dish with sizes/add-ons opens a picker (size, add-ons, quantity, note for the kitchen).
  - Choose table and number of guests; attach a known guest by name or mobile (loyalty moves).
  - The kinds of order on offer follow the format (a café opens on takeaway with a token); a dish sold by weight asks the weight; with brands on, the order is taken under a brand and only its menu shows.
  - Happy-hour dishes show the offer price with the old price struck through; sold-out dishes can't be added.
- Talking point: "Prices are calculated on the server, never in the browser — nobody can tamper with what's charged."

**Orders** — *Daily work → Orders*
- For: every order taken, filtered by status and type.
- Show: open an order, remove a dish — once the kitchen has it, the app asks **why**, and needs permission or a manager's PIN. Cancel needs a reason.
- Talking point: "'Dish taken off after the KOT' is the classic leakage — here it is recorded with the stage the kitchen had reached."

**Bills & payments** — *Daily work → Bills & payments*
- For: every bill — unpaid, part-paid, paid, void.
- Show:
  - Open a bill: discount code, on-the-spot discount (% or ₹, with reason), redeem loyalty points, tip.
  - **Split payment:** pay part cash, part card or UPI on the same bill, with live change for cash.
  - **On account** (regular or company pays later), **No charge** bill — both need permission or a manager's PIN.
  - Print / **Reprint** (reprints are counted); refunds create a proper **credit note**.
- Talking point: "A bill that has been paid can't be voided — only refunded, which stays visible in reports. Takings can't quietly disappear."

**Dues & accounts** — *Daily work → Dues & accounts*
- For: everything owed to the restaurant — company and regular accounts with credit limits, plus unpaid bills.
- Show: an account's ageing (0–30, 31–60, 61–90, 90+ days), statement, collect a payment (it pays the oldest bills first), Export CSV.
- Talking point: "Corporate credit customers finally have a ledger, not a notebook."

**Kitchen display** — *Daily work → Kitchen display* (best shown logged in as **kitchen**)
- For: every ticket from the tills and QR orders, by station, with the clock running.
- Show:
  - Tap a dish: start cooking → ready → served; step it back if tapped by mistake.
  - Tickets turn colour as they run long; cancelled and voided items are clearly marked.
  - **All-day** count (how many of each dish are on the board) and the **Sold out** switch right on the kitchen screen.
  - Stations setup: where each dish is cooked and how many minutes is too long.
- Talking point: "No lost paper KOTs, and the kitchen tells the floor when something runs out. If the network blips, it says so and retries."

**Table requests** — *Daily work → Orders › Table requests*
- For: the captain's inbox for guests' phones — QR orders and calls for a waiter, the bill or water.
- Show: a waiting QR order (clock turns amber then red) → Accept (or decline with a reason for the guest). Settings: guests can order / can call staff, note at the top of the guest menu, **See what guests see**.
- Talking point: "A QR order is never cooked until staff accept it — no prank orders reaching the kitchen."

**Reservations** — *Operations → Reservations*
- For: bookings, the floor timeline and the walk-in waitlist.
- Show: new booking with party size, occasion (birthday, anniversary…), source (phone, walk-in, online); Timeline vs Agenda view; Expected covers; Seat a booking — it opens the table's order.
- Talking point: "Know tonight's covers before service, and mark no-shows so you learn who they are."

**Deliveries** — *Daily work → Orders › Deliveries*
- For: every delivery from the pass to the door — own riders, aggregators, phone and website orders.
- Show: **Live board** (Placed → Cooking → Packed → On the road → Delivered), print delivery slip, **Channels** (each channel's commission), **Channel report** comparing them.
- Talking point: "See what each aggregator really costs you after commission."

**Pre-orders & cakes** — *Daily work → Pre-orders & cakes* (when the Pre-orders feature is on; a café and a bakery start with it)
- For: cakes and party orders for a later day — the guest, what and when, the message on the cake, the advance.
- Show: a new pre-order with an advance; the **bake list** for a day (every open pre-order's items added up, with each cake's message); mark one ready; on pickup it becomes a takeaway order, billed with the advance taken first.
- Talking point: "The order, the advance and the message are in one place, and the kitchen bakes from one list."

**Pickup screen** — *Daily work → Orders › Pickup screen*
- For: a TV by the pickup counter showing the day's token numbers being made and ready to collect — numbers only, no prices, names or mobiles.
- Show: a token turning ready glows and chimes; on a tablet, tap a ready token to mark it handed over. The TV signs in with the "Collection display" role, which opens nothing else.
- Talking point: "No shouting names across a busy counter."

**Service settings** — *Management → Settings › Service settings*
- For: the kinds of order the POS takes and the one a new order starts on, token numbers and the pickup screen, the restaurant's own online ordering page, and the guest ordering web address every table QR code opens.
- Show: the POS order types (the format set them; each can be changed).
- Talking point: "A café opens the POS on takeaway with a token, a restaurant on its tables."

### Restaurant set-up

**Profile** — *Management → Settings › Profile*
- For: restaurant name, contact, email, address.
- Show: quickly — it's set up once.
- Talking point: "One-time setup, ten minutes."

**Outlets** — *Management → Settings › Outlets*
- For: branches, each with its own code, address and (if separately registered) its own GSTIN.
- Show: the outlet list; a closed outlet keeps its history (**Read its reports**); outlets are never deleted once they've traded.
- Talking point: "**Each branch has its own business day, cash drawer and invoice series.** Petpooja-style single counters don't do that."

**Business hours** — *Management → Settings › Business hours*
- For: opening and closing times per weekday, up to three service periods a day, closed days.
- Show: a split lunch/dinner day.
- Talking point: "Drives the reminders — 'today's day hasn't been opened', 'yesterday is still open'."

**Settings** — *Management → Settings*
- For: what customers are charged and what prints on the bill.
- Show the sections: GST and invoice (GSTIN, FSSAI, tax included or added, CGST+SGST split), Currency and time, Service charge, Order and bill numbers, UPI payments, Loyalty, Printing (58 mm, 80 mm, A4, copies, header/footer, logo), Alerts and timings (when a discount counts as large, a delivery or a booking as late, a guest as a regular), Discounts at the till (per-role limits), Payment types.
- Talking point: "Tax mode is one switch, and bills already raised keep the tax they were charged at."

**Features** — *Management → Settings › Features*
- For: the format (restaurant, café, bakery or cloud kitchen) and the parts of the restaurant it uses: guests and loyalty; reservations, QR and online ordering, deliveries, kitchen display, captain sections, pre-orders, brands; tips, advances, cash drawers, coupons; stock and recipes, staff and payroll; tasks, issues and projects.
- Show: switch a feature off — the app first says what it would hide, and refuses while money is at stake (an advance still held, rider cash not settled). Nothing is deleted; switching it back on brings everything back.
- Talking point: "A café needs no reservations and a cloud kitchen no tables: switch off what you don't use and the screens stay simple."

### Menu

**Brands** — *Operations → Menu › Brands* (when the Brands feature is on; a cloud kitchen starts with it)
- For: one kitchen selling under several names, each with its own menu categories (a category with no brand is on every brand's menu).
- Show: the brands and their categories; at the POS, pick the brand and only its menu shows; the brand prints on the KOT and the bill; the brand **report** shows each brand's sales by channel and what the aggregators keep.
- Talking point: "Three listings on Swiggy, one kitchen, one stock, one day close."

**Categories** — *Operations → Menu › Categories*
- For: groups and their order at the till — Starters, Biryani, Breads.
- Show: reorder categories.
- Talking point: "Arrange by what sells most; the cashier scrolls less."

**Products** — *Operations → Menu* (it opens on Products)
- For: the dishes — price, tax rate, veg/non-veg/egg, photo, availability.
- Show:
  - Tabs: On the menu / **Sold out** / Archived.
  - A dish's **sizes** (Half/Full), add-on groups, **Recipe** (what it consumes from stock), combo.
  - Sold by the piece or **by weight** (a bakery's cookies: the price is per kg and the POS asks the weight).
  - More actions: **Prices & outlets** (per outlet/channel), **Serving times & combo choices** (e.g. breakfast only), **Change history** of every change; and on the page, **Revise prices** (+8% across categories with a preview).
  - **Import / Export CSV** with a dry run first.
- Talking point: "The recipe is what makes a biryani sold reduce the rice on the shelf — that's real food costing."

**Modifiers** — *Operations → Menu › Modifiers*
- For: add-ons like Extra cheese ₹40, created once and attached to many dishes.
- Show: the list with how many dishes use each; an add-on can have its own recipe.
- Talking point: "Change the price once, it changes everywhere."

**Tax rates** — *Operations → Menu › Tax rates*
- For: GST percentages, cess, HSN/SAC codes.
- Show: the default rate; a rate in use can't be deleted.
- Talking point: "HSN codes here feed straight into the GST filing pack."

**Happy hour** — *Operations → Menu › Happy hour*
- For: time-based prices on chosen dishes, chosen days, optional season.
- Show: a 4–7 pm window; a window running past midnight.
- Talking point: "The POS applies it automatically — no cashier remembering to discount."

### Tables

(Not shown to a bakery or a cloud kitchen, which have no tables.)

**Floors & areas** — *Operations → Tables & QR › Floors & areas*
- For: describe the room — floors, and areas like A/C, Terrace, Bar.
- Show: the floor and its areas.
- Talking point: "Set up once; reports and the floor plan follow it."

**Tables & QR** — *Operations → Tables & QR*
- For: the live floor plan, and table setup with QR codes.
- Show:
  - **Floor view:** Free / Running / Bill printed / Paid / Reserved / Cleaning, with the amount and time on each table ("₹1,240 · 1h 40m").
  - Click a table — it opens straight in the POS.
  - **List view:** add tables, seats, print the QR; regenerate a QR if a printed one goes missing.
- Talking point: "'Occupied' isn't one state — the floor plan tells host, captain, cashier and busser who should act."

### Inventory

**Items & stock** — *Operations → Stock* (it opens on Items & stock)
- For: every ingredient — unit, quantity on hand, reorder level, cost.
- Show the tabs:
  - **Items** with the "running low" filter and total stock value.
  - **Stock counts** — count the shelves, see missing/extra in quantity and money; manager posts it.
  - **Batches & expiry** — stock by batch and store; expired batches are skipped automatically, and wastage can be recorded against one batch.
  - **Production** — make gravies/batters in-house from a recipe, with batch number and expiry.
- Talking point: "Batch and expiry tracking with weighted average cost — most POS products stop at a stock number."

**Stock movements** — *Operations → Stock › Stock movements*
- For: the ledger — every in, out, wastage and adjustment, who and why, with running balance.
- Show: filter one item, trace a disputed figure.
- Talking point: "Stock is never just typed in. Every unit has a record behind it."

**Waste & reorder** — *Operations → Stock › Waste & reorder*
- For: wastage with a reason, and what to reorder.
- Show: Wastage by day/reason/item; **Reorder** tab grouped by supplier → turn it into a draft purchase order in one click.
- Talking point: "Waste without a reason looks exactly like theft. This separates them."

**Day-end unsold** — *Operations → Stock › Day-end unsold* (a bakery or a café)
- For: what is left of today's bakes at closing.
- Show: each bake with what is still on the shelf; write off what will not sell tomorrow (cream cakes, sandwiches) in one go, at cost, as "Unsold at day end"; what keeps (cookies, rusks) stays in stock.
- Talking point: "The day's food cost includes what went in the bin."

**Transfers & indents** — *Operations → Stock › Transfers & indents*
- For: stock moving between your own stores on a numbered challan; outlets requesting stock (indents).
- Show: a transfer note; receiving store confirms what arrived, shortages written off with a reason.
- Talking point: "Central kitchen to branches, with proof of what actually arrived."

**Stock & purchasing settings** — *Operations → Stock › Stock & purchasing settings*
- For: approval limits on large purchases, and whether the receiving store must confirm transfers.
- Show: the two limits.
- Talking point: "The person who spends isn't the only one who approves a big amount."

### Purchasing

**Suppliers** — *Operations → Purchases & suppliers › Suppliers*
- For: who you buy from — contact, GSTIN, payment terms.
- Show: a supplier record.
- Talking point: "Supplier GSTIN feeds the purchase register for input credit."

**Purchase orders** — *Operations → Purchases & suppliers* (it opens on Purchase orders)
- For: ordering and receiving goods; tabs Purchase orders, Purchase bills, **Purchase register**.
- Show: a PO Draft → Ordered → Receive (part delivery allowed, rejected goods noted with why); the purchase register with CGST/SGST/IGST.
- Talking point: "Receiving is what puts stock on the shelf and updates cost. You can't receive more than you ordered."

**Returns & payments** — *Operations → Purchases & suppliers › Returns & payments*
- For: "what do we owe this supplier?"
- Show: four totals (received, returned, paid, owed); Who we owe → Pay / Return; **Supplier statement**.
- Talking point: "Reconcile with a supplier in one screen instead of a phone argument."

### Customers

**Customers** — *Operations → Customers*
- For: the guest book — mobile, birthday, tags (VIP, allergy, Jain…), company GSTIN for B2B bills, offer consent, loyalty points.
- Show: open a guest's history (visits, bills, points); Possible duplicates → merge; Export CSV.
- Talking point: "Guests' numbers are masked for staff who don't need them, and an 'erase my details' request is one button — DPDP-ready."

**Feedback** — *Operations → Customers › Feedback*
- For: star ratings and comments from counter, QR, website or phone.
- Show: average rating, happy vs unhappy tiles, mark reviewed.
- Talking point: "See unhappy guests before they post online."

**Complaints** — *Operations → Customers › Complaints*
- For: complaints with an owner, a status and a priority, linked to the bill.
- Show: Open → In progress → Resolved; resolving forces you to write how, and records what the guest was given.
- Talking point: "Complaints can't be silently buried, and you see what putting things right costs each month."

**Guest insights** — *Operations → Customers › Guest insights*
- For: lists that become phone calls — regulars, new faces, regulars gone quiet, birthdays, unhappy guests, guests sitting on points.
- Show: a list and its export for your WhatsApp broadcast list or SMS tool.
- Talking point: "Ten minutes before service, know who to call back."

### The day, the log book, offers and expenses

**Business day** — *Daily work → Business day*
- For: opening and closing the trading day, per outlet.
- Show:
  - Open the day with the opening float.
  - **Drawers & cash:** shift drawers, cash in/out, each cashier's takings.
  - Close: **blind count**, expected vs counted, **over / short**. Open orders block the close; unpaid bills can be carried as dues.
- Talking point: "Closing the day is its own permission; a short drawer goes to the owner's bell next morning."

**Log book** — *Management → Reports › Log book*
- For: shift handover notes — the noisy freezer, paneer running short.
- Show: an entry needing follow-up stays on top; who has read it.
- Talking point: "Replaces the WhatsApp group for shift handovers."

**Discounts & offers** — *Management → Settings › Discounts & offers*
- For: coupon codes, the loyalty programme, and what was given away at the till.
- Show: Offers (% or flat, cap, minimum order, dates, usage limit); **Loyalty points** rules; **Given at the till** — every discount and no-charge bill, who gave it, who approved, why.
- Talking point: "Discounts are enforced, not suggested — a ₹1,500 minimum is refused on ₹1,200."

**Expenses** — *Daily work → Expenses*
- For: rent, gas, electricity, repairs — everything that isn't stock.
- Show: add an expense → it waits for approval → approve.
- Talking point: "Cash expenses come out of the expected drawer, so petty cash stays honest."

### Tasks

**My tasks · Team board · Task calendar · Issues · Projects · Templates · Recurring tasks · Task reports** — *Management → Tasks* (when the Tasks feature is on)
- For: the team's daily work, on a phone — opening and closing checklists from 82 ready-made templates, recurring tasks, issues raised and fixed, projects with milestones.
- Show: My tasks on a phone (tick a checklist, add a photo); the Team board; an issue from raised to closed; Task reports (done on time, missed, by person).
- Talking point: "The opening checklist is done, with a photo, before the doors open — and you can see it from home."

### Staff

**Employees** — *Operations → Staff* (it opens on Employees)
- For: the people file — code, department, salary type, joining date; plus the **Leave** tab (leave types and balances).
- Show: an employee; leave allowance taken/left.
- Talking point: "Staff and logins are separate — a kitchen porter needs no login."

**Shifts & roster** — *Operations → Staff › Shifts & roster*
- For: shift patterns (with grace period) and the weekly roster grid.
- Show: change a cell — it saves immediately.
- Talking point: "The week's roster in one grid."

**Attendance** — *Operations → Staff › Attendance*
- For: the daily sheet and the monthly muster roll.
- Show: present / absent / late tiles; **Mark remaining** (everyone not yet recorded, as the roster says: present, week off or leave); worked, late and overtime are calculated, not typed.
- Talking point: "Hours can't be quietly adjusted, and the muster roll is ready for a labour inspection."

**Time clock** — *Operations → Staff › Time clock*
- For: the tablet at the staff entrance — tap name, type PIN, clock in / break / out.
- Show: Clock in / out tab; the board of who's in and who's late; **Day timeline**; photo with each punch (if switched on).
- Talking point: "The photo stops one person punching in for another."

**Payroll** — *Operations → Staff › Payroll*
- For: attendance rolled into pay — days, overtime, advances, bonus, PF / ESI / professional tax.
- Show: This month / Last month; a payslip; Mark paid.
- Talking point: "Payroll comes straight from attendance — no Excel in between."

**Tips** — *Operations → Staff › Tips*
- For: tips taken at payment, by day and by person; share a pool, paid with salary.
- Show: the tip pool share-out.
- Talking point: "Fair, visible tip sharing ends a common staff dispute."

### Reports

**Reports** — *Management → Reports*
- For: fourteen reports on three shelves (Sales, Accounts, Control), each with **Print** and **Export CSV**; quick picks Today / Yesterday / Last month.
- Show (in this order):
  - **Day end · Z report** — the night's closing sheet; prints on the receipt printer with sign-off lines (X report while the day is open).
  - **Theft control** — voids, refunds, big discounts, reprints, dishes off after KOT, short drawers, by staff member and approving manager.
  - **GST filing** — GSTR-1 pack: B2B, B2C, HSN, credit notes, documents; it checks itself; CSVs match the GST portal's offline tool.
  - **Profit & loss** — sales less food cost, expenses and salaries; per outlet with shared costs split by sales.
  - **Items & menu → Not sold** — dishes nobody ordered in 30 days.
  - Also: Sales summary, Dish profitability, Discounts, Staff & waiters, Outlets, Expenses, **Day book (Tally)**, Cancellations & voids, Stock consumption.
- Talking point: "Your accountant gets the GST pack and a Tally-ready day book; you get theft control with your morning tea."

**Activity log** — *Management → Reports › Activity log*
- For: who did what, when, and which manager approved it — price changes, voids, refunds, permission edits, wrong PINs.
- Show: filter by person; "money-sensitive only"; export.
- Talking point: "The screen you open when a number is disputed."

### Users & access

**Users** — *Management → Users & access* (it opens on Users)
- For: logins — roles, status (active/locked), pinned to one outlet, last sign-in.
- Show: reset a password (admin can reset, never read it).
- Talking point: "A branch cashier pinned to their outlet can't see another branch's bills."

**Roles & permissions** — *Management → Users & access › Roles & permissions*
- For: built-in roles (Admin, Manager, Cashier, Captain/Waiter, Kitchen, Accountant, Store keeper, and Collection display for the pickup screen's TV) and custom roles.
- Show: permissions grouped by module, view vs manage; the sensitive ones — void, refund, reprint, discount, no-charge, take a dish off after KOT, close the day, see takings, see salaries.
- Talking point: "Anything sensitive a role can't do, a manager can approve on the spot with their PIN — and both names are logged."

### Platform (not shown to restaurants)

**Restaurants** — *Platform → Restaurants* (platform owner login only)
- For: adding a new restaurant with its first admin and its format (restaurant, café, bakery or cloud kitchen), switching one off, resetting a locked-out owner.
- Talking point (if asked about onboarding): "A new restaurant is set up from one screen; we never see its bills or guests here."

**Businesses** — *Platform → Businesses* (platform owner login only)
- For: the same for every other business type: create one for a customer with its owner's login, switch one off and on, give a locked-out owner a new password.

This database has no platform owner login yet: `npm run user:create` (in `backend`), with the restaurant code left empty, makes one.

### Guest QR page (no login)

- Where: the guest scans the QR on the table. It opens on the guests' site, a separate website from the staff app (the tip under section 2 says how to reach it from a phone).
- Show on your phone: the menu with real prices, add to cart (survives a reload), place order, **Call a waiter / Ask for the bill / Water**, order status.
- Talking point: "Built for a phone, one-handed, in a dim room on patchy Wi-Fi — and nothing reaches the kitchen until staff accept it."

### Role-based views (switch windows to show)

| Login | What they see | Line to say |
| --- | --- | --- |
| **cashier** | POS, Orders, Bills, takings; void/refund/close day ask for a manager's PIN | "Billing yes; the sensitive actions need the manager standing beside them." |
| **captain** | Tables, POS, Reservations, Table requests; no Bill button, no money on the dashboard | "A waiter takes the order but can never take the money." |
| **kitchen** | Kitchen display, sold-out, stock reading, wastage and counts | "The kitchen sees food, not money." |
| **manager** | Everything operational, takings, activity log; not users or roles | "Runs the floor; can't hand themselves new powers." |
| **owner / admin** | Everything | "Full control, full audit." |

### Phone view

- Open the app on a phone (or shrink the browser): the sidebar becomes a menu button; tap outside to close.
- Show the Dashboard and the floor plan on the phone, then POS taking an order.
- Talking point: "The owner checks the restaurant from a phone; a captain can take orders on a phone at the table — no special hardware."

---

## 4. "If asked" — short answers

**What if the internet goes down?**
- It's a web app that talks to your server. The server can sit in the restaurant, so tills on the restaurant's own Wi-Fi keep working without the internet line.
- The kitchen display shows "cannot reach the server — retrying" and recovers on its own; the guest's QR cart survives a reload.
- Honest answer: a till completely cut off from the server does not bill offline in this version.

**GST?**
- Tax included or added per restaurant (or per dish), CGST + SGST split, cess, HSN/SAC codes, MRP items, Bill of Supply for composition dealers.
- Printed tax invoice at 58 mm, 80 mm and A4; B2B invoices when the guest has a GSTIN.
- GSTR-1 filing pack that checks itself, purchase register for input credit, credit notes for refunds, Tally day book.
- "Your accountant should confirm the rates once before go-live" — say this.

**Multi-branch?**
- Outlets with their own GSTIN, business day, cash drawer, order and invoice series.
- Staff can be pinned to one branch. Dashboard and every report filter by branch; the Outlets report compares them.
- Prices and menu per outlet; stock transfers and indents between stores; branch P&L with shared costs split by sales.

**Security?**
- Roles with view/manage permissions, checked by the server on every request.
- Manager PIN approval for voids, refunds, discounts, no-charge bills, dishes off after KOT, closing the day.
- Activity log of every sensitive action with both names; theft-control alerts in the owner's bell.
- **Two-step sign-in** with an authenticator app and recovery codes (My profile); lock screen for shared tills; guests' contact details masked for staff.

**Can I get my data out?**
- Every report: Print and Export CSV. Menu export/import (CSV), guest book export, payroll, dues, GST portal CSVs, Tally day book.
- "It's your data — you can take all of it."

**What's coming next?** (planned integrations — say "planned", not "available")
- **Swiggy / Zomato** direct order sync. Today: aggregator orders are entered and tracked on Deliveries with each channel's commission.
- **WhatsApp / SMS** sending. Today: guest lists export for your WhatsApp broadcast list or SMS tool; purchase orders are formatted to share on WhatsApp.
- **UPI payment gateway** (dynamic QR, auto-confirm). Today: UPI is recorded as a payment with its reference.
- **Direct thermal printer and cash drawer.** Today: prints through the browser on 58 mm / 80 mm / A4 paper.
- Password reset by email or SMS. Today: an admin resets it.

---

## 5. Things NOT to say or click

- Don't promise offline billing, Swiggy/Zomato sync, WhatsApp sending, a UPI gateway or direct printer control as "available" — they're planned.
- Don't try to void a paid bill expecting it to work — it correctly refuses and says "refund instead". (Use it as a feature if it happens.)
- Don't try to sell with no day open — the POS is blocked. Open the day first (or show the block on purpose).
- Sign in before you share the screen; never show a password.

---

## 6. The realistic demo businesses (every business type)

*Added 8 October 2026. Eleven businesses, one of every type but the restaurant, each with about
ninety days of trading history ending today and a live "today", all owned by your login (Owner
role). They replace the old "Demo · …" businesses, which are switched off (kept, not deleted).*

*Since then (state on 22 October 2026): seven of them run a second branch (12 Oct); the
pharmacy and the clinic carry their full rules (8 and 21 Oct); FoodEx has a second outlet, and
a café, a bakery and a cloud kitchen were added (21 Oct); and each demo business has a clean
copy for real use (`LIVE-…`, 21 Oct), which is not for demos. The demo businesses' codes are
`RD-<your user id>-<KIND>`: `RD-2-KIRANA`, `RD-2-SUPERMARKET`, `RD-2-WHOLESALE`, `RD-2-FASHION`,
`RD-2-ELECTRONICS`, `RD-2-SALON`, `RD-2-MEAT`, `RD-2-DRYFRUITS`, `RD-2-BOOKS`, `RD-2-PHARMACY` and
`RD-2-CLINIC` on this database.*

### Loading them (once, after a backup)

In `backend`, with `MULTI_BUSINESS_DEVELOPMENT=true` in `backend/.env` (development only) and
your own user id (the id of your owner login; 2 on this database):

```
npm run db:backup -- --verify
npm run demo:today -- --user-id <your user id>
```

- The first command takes a backup and checks that it restores. The second runs, in order,
  `seed:realistic` (the eleven businesses, their branches and their history: about half an
  hour the first time; it prints one line per business), `seed:topup` (FoodEx's trading days
  up to today) and `demo:tidy-restaurant` (FoodEx's today, see below). Each can also be run
  on its own.
- Run `demo:today` again at any time, for example on the morning of a demo: nothing is made
  twice. The history is made once; a rerun adds the days since the last run and today's
  trade up to the current hour.
- Staff logins are saved in `backend/.local/realistic-demo-logins.json`: managers, cashiers,
  stock keepers and accountants; the pharmacy's pharmacist; the clinic's doctors, lab
  technician and pathologist; and the staff of each second branch, tied to it. The file also
  holds the till PINs of the counters that ask for one and the pharmacist's and the
  pathologist's sign-off PINs. Passwords are never printed. A staff login sees only its own
  business, with its role's permissions.
- Everything goes through the app's own services, so stock, ledgers, dues, GST, number
  series and reports agree with each other. Shelf prices include GST (GST 2.0 slabs) and
  never exceed the printed MRP.

### What every business has

- Real-looking details: legal name, Indian address, GSTIN in the valid format, phone, receipt footer.
- Staff with logins and roles; suppliers with credit terms; regular customers with Indian
  names, some on udhaar (most pay on time, a few late, one or two far behind).
- About 90 days of bills shaped like the real calendar: busier weekends and salary week,
  Bonalu Sundays (Hyderabad), Independence Day, Varalakshmi Vratam, Raksha Bandhan,
  Janmashtami, Ganesh Chaturthi, the quiet Pitru Paksha fortnight (27 Sep–10 Oct) and the
  run-up to Navratri (starts 11 Oct), Dussehra (20 Oct) and Diwali (8 Nov).
- Deliveries from suppliers on their own days, reorders when stock runs low, supplier bills
  paid on their credit days (one supplier usually a week late), returns with refunds.
- **Today**: bills up to the current hour, money in by method, a few items low on stock (the
  supplier was short this week), udhaar promises due or broken, and the specials below.
- **Tasks**: opening and closing checklists every day for a month (done on most days, some
  late, about one in nine missed), the type's daily reading (chiller, cold room, medicine
  fridge, scale, van fuel, steriliser, IMEI tally) with **today's reading out of range,
  which raised an issue**, a weekly audit, issues in every state, and the project
  **"Diwali preparation 2026"** with tasks given to the staff: done, in progress, overdue, to do.
- **Ways to pay, opening hours and house rules**: the payment methods the counter really
  names (PhonePe, Google Pay, Paytm; a meal card at the supermarket, a payment link at the
  salon, RTGS at the distributor) on every payment of the story, each shop's opening hours,
  and the rules each kind of shop sets (receipt paper, quick weight buttons, expiring-soon
  days, voucher validity, credit age groups).
- **A second branch** (12 Oct) for seven of them, with its own address, its staff tied to it
  and (but for the depot) its own ninety days of trade: Sai Annapurna (JP Nagar branch),
  Sahyadri (Belagavi depot: stock only, no counter sales, its own Karnataka GSTIN),
  Rangoli (Commercial Street showroom, Bengaluru, its own GSTIN), Sri Venkateswara
  (Kukatpally accessories store), Al-Noor (Mehdipatnam shop), Gupta Dry Fruits (Chandni
  Chowk shop) and Sri Sai Medicals (Adyar shop: its own drug licences, medicines without a
  prescription only). Sign in as a branch's manager to show that they see, bill and report
  only there.

### Business by business: what it shows and the story to tell

**Sri Lakshmi Kirana & General Stores** (grocery · KPHB Colony, Hyderabad)
- Shows: Quick bill with loose rice, dal and sugar by the kilo and packed goods at MRP; about
  45–60 bills a day (₹20–30 thousand); the **Udhaar** book with 13 account customers, overdue
  buckets, reminders and broken promises; offers (monthly ration ₹50 off, Navratri ghee ₹25
  off); five suppliers on their own days; a low-stock list.
- Story: "Srinivas Rao runs a neighbourhood kirana. The udhaar book shows who pays on the 1st,
  who has crossed the limit, who to call today and what they promised last time. The milk
  agency is paid cash every morning, the rice trader on 15 days."
- Also: bills paid two ways (cash and UPI, or part now and the rest on udhaar); the counter
  staff's till PINs; 58 mm receipts.

**Sai Annapurna Super Bazaar** (supermarket · Jayanagar, Bengaluru)
- Shows: a busier counter (60–90 bills on weekends), card and UPI heavy; loyalty points earned
  and redeemed; offers (happy hours 4–7 pm, noodles buy 4 get 1, a Ganesh Chaturthi ghee
  offer, Navratri staples coming); dairy and bread by batch and expiry, expired packs taken off
  the shelf, a **near-expiry** list; vegetables by weight.
- Story: "Every bill earns points, offers apply themselves at the counter, and the near-expiry
  screen tells the floor what to clear before it is wasted."
- Also: the JP Nagar branch; member prices on staples and each item's shelf place; the
  `WELCOME50` coupon; a bill paid partly with points and half returned, the spent points given
  back in proportion.

**Sahyadri FMCG Distributors** (wholesale · Market Yard, Pune)
- Shows: 48 retailers on 8 beats of 4 routes and 3 salesmen; orders booked on beat days (and a
  few by phone) and sent the next morning in cases (part-sent when an item is short); trade prices before GST,
  case slabs and a "10 + 1 free" scheme; outstanding with ageing; two retailers far behind on
  **credit hold** (60 days); today's collections by the salesmen, with cheques: **one cleared,
  one post-dated, one bounced** (₹500 charge); damaged cases taken back.
- Story: "Ravi books Kothrud on Mondays and Thursdays; the godown ships next morning. The
  outstanding report shows who is past 60 days and the app stops new orders for them. Today's
  bounced cheque is back on the shop's account with the charge."
- Also: the Belagavi depot; purchase orders to the companies (one part received, one late,
  one still a draft); Diwali orders that earn the schemes (noodles 10 + 1, a case of
  detergent bars with 5 cases of soap).

**Rangoli Silks & Fashions** (garments · T. Nagar, Chennai)
- Shows: 10 styles in size × colour (shirts, chinos, kurtis, leggings, a lehenga, kids' wear),
  sarees and fabric by the metre; GST 5 % up to ₹2,500 a piece and 18 % above (the lehenga);
  the Aadi sale (17 Jul–16 Aug) and Independence Day weekend, the quiet Mahalaya fortnight;
  **exchanges** (size swaps, a dearer piece with the difference paid, a cheaper one refunded).
- Story: "Middle sizes go first: the variant screens show which styles have broken size sets.
  An exchange is one screen: the piece back, the new piece out, the difference settled."
- Also: the Commercial Street showroom in Bengaluru, with its own Karnataka GSTIN on its bills.

**Sri Venkateswara Mobiles & Electronics** (Dilsukhnagar, Hyderabad)
- Shows: handsets and TVs received one IMEI or serial number at a time (valid IMEIs), sold
  with the maker's warranty registered to the buyer, screen guards and covers sold with the
  phones; the **repair desk** with jobs in every state (received today, diagnosing, waiting
  for parts, in repair, awaiting the customer's approval, ready for pickup, delivered,
  cancelled) and some past their promised date.
- Story: "Type an IMEI and you get its whole life: received from the distributor, sold to
  whom, warranty until when, repairs. The repair board shows what is overdue before the
  customer calls."
- Also: the Kukatpally accessories store; two kits (phone + cover + guard, an accessory
  starter pack); EMI sales with Bajaj Finserv, HDFC Bank and TVS Credit (one payout received
  net of the subvention, one case waiting over 15 days); a repair taken in with an advance,
  and one returned unrepaired with its advance refunded.

**Glow & Grace Unisex Salon & Spa** (Indiranagar, Bengaluru)
- Shows: five stylists and therapists with their own skills, two spa rooms, timed services
  (5 % GST on top); regulars on packages (Hair spa × 5, Glow facial × 4, Men's grooming × 6)
  and memberships (Gold, Silver) with sessions used; commission by stylist and the monthly
  payout; tips; **today's calendar**: the morning's appointments done and billed (deposits
  set against the bill), one no-show, the afternoon and evening booked, more over the next
  three days (a bridal make-up with a ₹3,600 deposit).
- Story: "Open the calendar: who is free at 4, which room is taken, who paid a deposit. At the
  bill the package session comes off by itself and the stylist's commission is counted."
- Also: stylists' weekly schedules and a salon holiday; back-bar products used in services
  (kept for salon use, never sold); a monthly target commission plan; a client's advance
  refunded.

**Al-Noor Fresh Chicken, Mutton & Seafood** (meat · Tolichowki, Hyderabad)
- Shows: live birds, goat and whole fish bought every morning and **cut** into curry cut,
  boneless, drumsticks and keema, with yields against the template; sales by weight (some
  typed in grams); evening **wastage** (drip loss, unsold fish) with reasons; Sundays and
  Bonalu Sundays nearly double, Shravan quieter, shut on Gandhi Jayanti (dry day); three
  restaurants buying 8–18 kg on weekly credit (one far behind); **today's rate board**
  (chicken changed this morning).
- Story: "A hundred kilos of live birds became about seventy of curry cut and five of liver:
  the yield report shows the cutting, and wastage has a reason, not a mystery."
- Also: the Mehdipatnam shop; a trial lot of birds from a second farm, so yield by supplier
  compares the two farms.

**Gupta Dry Fruits & Mewa Bhandar** (weight shop · Karol Bagh, Delhi)
- Shows: dry fruits and whole spices by batch, sold by weight (often in grams); bulk almonds
  sorted twice a week into sorted and broken; gift boxes; the **Raksha Bandhan** spike and the
  Diwali run-up; a corporate Diwali order of 25 gift boxes on account and a caterer on credit;
  weekly wastage (moisture, tasting samples).
- Story: "Rakhi week sold about three times a normal week; the corporate Diwali order is on
  account under the company's GSTIN, and udhaar tells you when that money is due."
- Also: the Chandni Chowk shop.

**Vidya Book House & Stationers** (books · Deccan Gymkhana, Pune)
- Shows: books by ISBN (the ISBN is the barcode, nil GST), stationery at 0 % or 18 %; the end
  of the school season in July and the exam-guide lift in September; **school sets** (Std 10,
  Std 5) billed in one scan; two schools and a coaching class on account (one late, one far
  behind); customer orders for books not in stock (today, one with an advance); 2027 diaries
  received on 1 October.
- Story: "A parent hands over the booklist: one scan bills the whole Std 10 set. The school
  library buys on 30 days and the app shows the coaching class is months behind."

**Sri Sai Medicals** (pharmacy · Velachery, Chennai)
- Shows: medicines by strip and bottle with batch and expiry on every receipt, first expiry
  out first at the counter; elderly regulars on a monthly account; 30–45 bills a day. The
  **drug master** (salt, strength, maker, schedule: ten Schedule H medicines, three H1, one
  X); a month of **prescription sales** with the doctor and a scan, which filled the **H1
  and Schedule X registers** (about once a week a Schedule X medicine, signed off with the
  pharmacist's PIN); short-dated stock under **Expiry, returns & recalls**, two expiry
  returns to distributors (one credited, one waiting for the credit note) and a **recall**
  of a Cetirizine batch already sold out (every buyer found, the batch blocked); the Adyar
  branch with its own drug licences.
- Story: "Batch and expiry on every strip, a Schedule H1 sale goes into the register by
  itself, and when a batch is recalled you know in a minute who bought it."
- Sign in as the pharmacist (Priya Natarajan) for the Schedule X sign-off; her PIN is in the
  logins file.

**Sanjeevani Family Clinic & Diagnostics** (clinic · Madhapur, Hyderabad)
- Shows: three doctors and a sample room; appointments booked, seen and billed (consultation
  plus tests, exempt from GST), the odd no-show; closed on Sundays; **today's** remaining
  appointments and tomorrow's. **Doctors, fees & OPD**: Dr. Ravi Kumar Reddy (general
  physician, ₹500, follow-up ₹250 within 7 days), Dr. Swathi Rao (paediatrician, ₹600, free
  follow-up within 5 days) and Dr. Mohd. Faisal Khan (diabetologist, ₹700, follow-up ₹250
  within 10 days), each with Monday-to-Saturday sessions (9 am–2 pm, 2–9 pm) and a share of
  their fees in the earnings report. **Token queue**: today's patients hold a token, each
  doctor is seeing the first of theirs, and the waiting-room board shows who is next.
  **Patients** with consent (two withdrew consent for reminders), consultations with vitals,
  diagnosis and prescription, and **lab orders** in every state: reported, waiting for the
  pathologist, in the lab, the odd one cancelled, some results out of range. **Quality
  control**: three weeks of morning runs for haemoglobin and fasting glucose at two levels,
  one failed run and its re-run, and today's runs.
- Story: "The front desk gives a token, the doctor calls the next patient, the bill picks the
  right fee for a first visit or a follow-up, and a report with a test whose control failed
  this morning cannot be signed."
- Sign in as a doctor to show the clinical notes (only doctors and the owner see them), and as
  the pathologist (Dr. Anitha Varma, PIN in the logins file) to approve a report.

### FoodEx (the restaurant): `demo:today` and the Madhapur outlet

`demo:today` first trades FoodEx forward from its last business day to today (`seed:topup`),
then tidies it (`demo:tidy-restaurant`):

- Closes every business day left open from an earlier date (the main counter and each
  outlet): stale open orders are cancelled with the reason "Demo tidy-up: stale order" (they
  stay in the cancellations report), today's orders on an old day are billed, unpaid bills are
  carried as dues (listed under Bills, unpaid, with a note on the day), open drawers are
  counted, and the day is closed with the cash it should hold (no over or short).
- Opens today's business day (₹5,000 float) if none is open and tops up today's trade to
  what a restaurant has served by the hour it is run (a few covers before lunch, a third by
  3 pm, the rest at dinner, two tables still eating). Today's day is never closed. Nothing
  is deleted.

**FoodEx — Madhapur** (21 Oct, `npm run demo:restaurant-branch`, once): a second outlet that
cooks from the main kitchen's stock, with its own floor of six tables, its own business day,
its own order and invoice numbers (`MDP`) and a week of trading up to the day it was added.
The outlet switcher and the outlet reports have something real to show; `demo:today` does not
trade it forward.

### Café, bakery and cloud kitchen: `demo:food-formats`

*Added 21 October 2026, once, with `npm run demo:food-formats` (in `backend`).* Three
restaurants of the other food formats, each made the supported way (Platform › Restaurants)
with its own owner login, set up in its format, given a menu and a week of trading through
the real order, bill and business-day services. Their owners' logins and passwords are in
`backend/.local/food-demo-logins.json`. They are not on the FoodEx owner's switcher: sign
out and sign in as their owner. `demo:today` does not move them forward, so their trading
ends on the day they were added.

**Brew & Bloom Café** (café · Indiranagar, Bengaluru; Ananya Rao, `owner@brewbloom.demo.test`)
- Shows: the POS opens on takeaway with a token number for the pickup screen; dine-in at six
  tables; coffee, bakes and all-day food; pre-orders switched on for parties.
- Story: "Order and pay at the counter, collect when your number shows."

**Sweet Crust Bakery** (bakery · Banjara Hills, Hyderabad; Farhan Siddiqui, `owner@sweetcrust.demo.test`)
- Shows: takeaway and delivery, no tables; cakes, breads, savouries, and cookies and rusks
  **sold by weight** (price per kg); the morning's bakes (puffs, pastry slices, black forest
  cakes) made from recipes, taking the flour, butter and cream off the shelf; six cake and
  party **pre-orders**, most with an advance (two due on the day it was added, one ready and
  one being made); the bake list; **Day-end unsold** at closing.
- Story: "The cake order, the advance and the message are written once; the kitchen bakes
  from one list, and what is left at night is written off at cost."

**Biryani Box** (cloud kitchen · Kondapur, Hyderabad; Imran Qureshi, `owner@biryanibox.demo.test`)
- Shows: deliveries through Swiggy, Zomato and its own riders (and the odd takeaway), no
  tables; three **brands** from one kitchen (Biryani Box, Wrap Republic, Bowl Theory), each
  with its own menu and drinks shared by all; orders taken under each brand, which prints on
  the KOT and the bill; the brand report with sales by channel and the aggregators'
  commission.
- Story: "Three names on Swiggy, one kitchen, one stock and one day close."

### Real copies (`LIVE-…`): for real customers, not for demos

*Made 21 October 2026 with `npm run business:real-copies -- --owner-user-id 2`
([DEMO_TO_REAL_PLAN.md](DEMO_TO_REAL_PLAN.md)).* Each of the eleven demo businesses has a
twin, `LIVE-KIRANA` … `LIVE-CLINIC`, owned by `owner@foodex.com`: the same set-up (modules,
branches, roles, categories, products and prices, the type's own lists) and none of the
history (no bills, stock, customers, patients, staff logins; GSTINs and licence numbers
empty). They are ordinary businesses: they show on a live server too, and `demo:today` never
touches them. In the switcher a twin carries its demo's name and is listed first; type `RD-`
in the switcher's search to see only the demos.

### Things to know (say them if asked)

- **The activity log shows when the demo was loaded**, not the story's dates: the log and the
  events outbox are never back-dated. Bills, payments, stock movements, cutting batches,
  wastage, repair history and appointments carry their story dates.
- **Receipts and supplier payment vouchers cannot be changed once issued**, so the history
  settles udhaar and supplier bills as payments on each bill (shown on the bill and in the
  statements); numbered receipts, cheques and salesmen's collections exist only from the day
  the demo was loaded onwards.
- **Warranty cards and packages start on the day the demo was loaded** (the database never
  changes a registered warranty or a sold package). In a demo, open one sold today.
- **Shops have no business day to open or close** (that is the restaurant): their end of day
  is **Daily money** (takings by method, by the shop's own method names, by person and by
  counter, a cash check of the drawer, and each cashier's shift), and the weight shops have no
  past end-of-day weigh-ups: the first is the one you do.
- **Offers are judged at the moment the data was loaded**, not on the story's date: in the
  history, weekend-only or happy-hour offers apply depending on when the script ran.
- **A staff login opens its own business straight away** (round 2): staff of a shop, a salon
  or the clinic have no restaurant role, so they never see the FoodEx dashboard; their
  business switcher shows only their own business.
- **The café, the bakery and the cloud kitchen stop on the day they were added** (21 Oct):
  `demo:today` does not trade them forward; their week of trading is on their reports (pick
  the dates).
- Diwali (8 Nov) is still ahead: the history shows the run-up to it, and the Diwali project is
  the work still to do.
