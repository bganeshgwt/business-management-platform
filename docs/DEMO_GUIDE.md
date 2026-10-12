# Demo Guide — read-along script

*For the live demo, 2 October 2026. Every feature below exists in the app today.
Logins: admin / owner / manager / cashier / captain / kitchen @foodex.com — password
from the demo logins file. Never type a password on the projector; sign in before you share the screen.*

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
| 3:00–4:30 | manager | **Operations → Business day** | Open the day, count the opening float. "Nothing sells until the day is open." |
| 4:30–7:00 | captain | **Tables → Tables & QR** (floor view) → **POS** | Tap a free table → POS opens on it → add dishes with size and add-ons → note for kitchen → save. Point out: captain has no Bill button |
| 7:00–8:30 | phone | **QR table ordering** | Scan a table QR on your phone, order, "Call a waiter". Then **Service → Table requests**: accept it |
| 8:30–10:00 | kitchen | **Service → Kitchen display** | Tickets with timers, tap to start / ready / served, sold-out switch |
| 10:00–12:30 | cashier | **POS / Bills & payments** | Raise bill → coupon or loyalty points → pay half cash, half UPI → print. Then try a void: PIN prompt appears, manager enters PIN |
| 12:30–13:30 | cashier | Lock screen | Lock the till, switch to another person with their PIN |
| 13:30–15:00 | manager | **Inventory → Items & stock** | The dish sold reduced its ingredients; Batches & expiry; low-stock filter |
| 15:00–16:30 | manager | **Operations → Business day** | Close the day: blind count, over/short. Open orders block the close |
| 16:30–20:30 | owner | **Reports** | Day end · Z report → Theft control → GST filing → Profit & loss → Items & menu "Not sold" |
| 20:30–22:00 | owner | **Phone view** + **Activity log** | Same app on a phone; who did what and who approved it |
| 22:00+ | — | — | Questions (section 4) |

Tip: keep four browser windows ready — manager, captain, kitchen, cashier — so you never
sign in live. Keep your phone ready with a table QR open.

---

## 3. Every screen, as the sidebar groups it

**Before the tour, point at the frame around every page:**

- **Sidebar shows only what your role allows.** No greyed-out buttons — a cashier never sees Payroll. The server checks again on every request.
- **Jump to…** at the top of the sidebar: type "gst" or "stock" and go.
- **Quick access:** pin up to five favourite pages above the menu (Set up → pick → Save shortcuts).
- **The bell:** everything that needs a person now — unpaid bills, low stock, day left open, late deliveries, and for owners the theft alerts as they happen. Also **Notifications** page for the full list.
- **Outlet switcher** (top bar): pick a branch and the dashboard and every report show that branch only.
- **Your name** (top bar): My profile — name, mobile, password, personal PIN, two-step sign-in.
- **Lock:** locks a shared till without logging out; next person taps their name and PIN.

### Overview

**Dashboard** — *Overview → Dashboard*
- For: the screen a manager leaves open all day; refreshes itself every 30 seconds and says when it last looked.
- Show:
  - Sales today vs the same slice of last week (fair comparison, not half a day vs a full day).
  - Running orders / Tables busy tiles — click one, the list opens already filtered.
  - **Needs attention** card: unpaid bills, low stock, complaints, expenses awaiting approval — each row opens the exact list.
  - Sales last 7 days (closed days shown as zero, not hidden), Best sellers / **Slowest** tab, Where it came from (dine-in / takeaway / delivery), the cash drawer, Through the day hour by hour.
- Talking point: "It's honest. Empty days show as empty, and it works in business days — a kitchen serving at 12:30 am is still on yesterday's sheet."
- Role view: sign in as **captain** or **kitchen** — same dashboard, but no money; guests, running orders and plates sold instead.

**My work** — *Overview → My work* (only for a login linked to a staff record)
- For: a staff member's own shifts this week and next, this month's attendance, leave left, and payslips.
- Show: sign in as a staff login, open My work.
- Talking point: "Staff stop asking the manager 'what's my shift' and 'where's my payslip'."

### Service

**POS** — *Service → POS*
- For: the till — dine-in, takeaway and delivery orders.
- Show:
  - Pick a category or search; a dish with sizes/add-ons opens a picker (size, add-ons, quantity, note for the kitchen).
  - Choose table and number of guests; attach a known guest by name or mobile (loyalty moves).
  - **Course** for new dishes and "Hold this course until Fire is pressed" — starters now, mains later.
  - Happy-hour dishes show the offer price with the old price struck through; sold-out dishes can't be added.
- Talking point: "Prices are calculated on the server, never in the browser — nobody can tamper with what's charged."

**Orders** — *Service → Orders*
- For: every order taken, filtered by status and type.
- Show: open an order, remove a dish — once the kitchen has it, the app asks **why**, and needs permission or a manager's PIN. Cancel needs a reason.
- Talking point: "'Dish taken off after the KOT' is the classic leakage — here it is recorded with the stage the kitchen had reached."

**Bills & payments** — *Service → Bills & payments*
- For: every bill — unpaid, part-paid, paid, void.
- Show:
  - Open a bill: discount code, on-the-spot discount (% or ₹, with reason), redeem loyalty points, tip.
  - **Split payment:** pay part cash, part card or UPI on the same bill, with live change for cash.
  - **On account** (regular or company pays later), **No charge** bill — both need permission or a manager's PIN.
  - Print / **Reprint** (reprints are counted); refunds create a proper **credit note**.
- Talking point: "A bill that has been paid can't be voided — only refunded, which stays visible in reports. Takings can't quietly disappear."

**Dues & accounts** — *Service → Dues & accounts*
- For: everything owed to the restaurant — company and regular accounts with credit limits, plus unpaid bills.
- Show: an account's ageing (0–30, 31–60, 61–90, 90+ days), statement, collect a payment (it pays the oldest bills first), Export CSV.
- Talking point: "Corporate credit customers finally have a ledger, not a notebook."

**Kitchen display** — *Service → Kitchen display* (best shown logged in as **kitchen**)
- For: every ticket from the tills and QR orders, by station, with the clock running.
- Show:
  - Tap a dish: start cooking → ready → served; step it back if tapped by mistake.
  - Tickets turn colour as they run long; cancelled and voided items are clearly marked.
  - **All-day** count (how many of each dish are on the board) and the **Sold out** switch right on the kitchen screen.
  - Stations setup: where each dish is cooked and how many minutes is too long.
- Talking point: "No lost paper KOTs, and the kitchen tells the floor when something runs out. If the network blips, it says so and retries."

**Table requests** — *Service → Table requests*
- For: the captain's inbox for guests' phones — QR orders and calls for a waiter, the bill or water.
- Show: a waiting QR order (clock turns amber then red) → Accept (or decline with a reason for the guest). Settings: guests can order / can call staff, note at the top of the guest menu, **See what guests see**.
- Talking point: "A QR order is never cooked until staff accept it — no prank orders reaching the kitchen."

**Reservations** — *Service → Reservations*
- For: bookings, the floor timeline and the walk-in waitlist.
- Show: new booking with party size, occasion (birthday, anniversary…), source (phone, walk-in, online); Timeline vs Agenda view; Expected covers; Seat a booking — it opens the table's order.
- Talking point: "Know tonight's covers before service, and mark no-shows so you learn who they are."

**Deliveries** — *Service → Deliveries*
- For: every delivery from the pass to the door — own riders, aggregators, phone and website orders.
- Show: **Live board** (Placed → Cooking → Packed → On the road → Delivered), print delivery slip, **Channels** (each channel's commission), **Channel report** comparing them.
- Talking point: "See what each aggregator really costs you after commission."

### Restaurant

**Profile** — *Restaurant → Profile*
- For: restaurant name, contact, email, address.
- Show: quickly — it's set up once.
- Talking point: "One-time setup, ten minutes."

**Outlets** — *Restaurant → Outlets*
- For: branches, each with its own code, address and (if separately registered) its own GSTIN.
- Show: the outlet list; a closed outlet keeps its history (**Read its reports**); outlets are never deleted once they've traded.
- Talking point: "**Each branch has its own business day, cash drawer and invoice series.** Petpooja-style single counters don't do that."

**Business hours** — *Restaurant → Business hours*
- For: opening and closing times per weekday, up to three service periods a day, closed days.
- Show: a split lunch/dinner day.
- Talking point: "Drives the reminders — 'today's day hasn't been opened', 'yesterday is still open'."

**Settings** — *Restaurant → Settings*
- For: what customers are charged and what prints on the bill.
- Show the sections: GST and invoice (GSTIN, FSSAI, tax included or added, CGST+SGST split), Currency and time, Service charge, Order and bill numbers, Loyalty, Printing (58 mm, 80 mm, A4, copies, header/footer, logo), Discounts at the till (per-role limits).
- Talking point: "Tax mode is one switch, and bills already raised keep the tax they were charged at."

### Menu

**Categories** — *Menu → Categories*
- For: groups and their order at the till — Starters, Biryani, Breads.
- Show: reorder categories.
- Talking point: "Arrange by what sells most; the cashier scrolls less."

**Products** — *Menu → Products*
- For: the dishes — price, tax rate, veg/non-veg/egg, photo, availability.
- Show:
  - Tabs: On the menu / **Sold out** / Archived.
  - A dish's **sizes** (Half/Full), add-on groups, **Recipe** (what it consumes from stock), combo.
  - More actions: prices per outlet/channel, serving times (e.g. breakfast only), **Price revision** (+8% across categories with preview), **History** of every change.
  - **Import / Export CSV** with a dry run first.
- Talking point: "The recipe is what makes a biryani sold reduce the rice on the shelf — that's real food costing."

**Modifiers** — *Menu → Modifiers*
- For: add-ons like Extra cheese ₹40, created once and attached to many dishes.
- Show: the list with how many dishes use each; an add-on can have its own recipe.
- Talking point: "Change the price once, it changes everywhere."

**Tax rates** — *Menu → Tax rates*
- For: GST percentages, cess, HSN/SAC codes.
- Show: the default rate; a rate in use can't be deleted.
- Talking point: "HSN codes here feed straight into the GST filing pack."

**Happy hour** — *Menu → Happy hour*
- For: time-based prices on chosen dishes, chosen days, optional season.
- Show: a 4–7 pm window; a window running past midnight.
- Talking point: "The POS applies it automatically — no cashier remembering to discount."

### Tables

**Floors & areas** — *Tables → Floors & areas*
- For: describe the room — floors, and areas like A/C, Terrace, Bar.
- Show: the floor and its areas.
- Talking point: "Set up once; reports and the floor plan follow it."

**Tables & QR** — *Tables → Tables & QR*
- For: the live floor plan, and table setup with QR codes.
- Show:
  - **Floor view:** Free / Running / Bill printed / Paid / Reserved / Cleaning, with the amount and time on each table ("₹1,240 · 1h 40m").
  - Click a table — it opens straight in the POS.
  - **List view:** add tables, seats, print the QR; regenerate a QR if a printed one goes missing.
- Talking point: "'Occupied' isn't one state — the floor plan tells host, captain, cashier and busser who should act."

### Inventory

**Items & stock** — *Inventory → Items & stock*
- For: every ingredient — unit, quantity on hand, reorder level, cost.
- Show the tabs:
  - **Items** with the "running low" filter and total stock value.
  - **Stock counts** — count the shelves, see missing/extra in quantity and money; manager posts it.
  - **Batches & expiry** — stock by batch and store; expired batches are skipped automatically, and wastage can be recorded against one batch.
  - **Production** — make gravies/batters in-house from a recipe, with batch number and expiry.
- Talking point: "Batch and expiry tracking with weighted average cost — most POS products stop at a stock number."

**Stock movements** — *Inventory → Stock movements*
- For: the ledger — every in, out, wastage and adjustment, who and why, with running balance.
- Show: filter one item, trace a disputed figure.
- Talking point: "Stock is never just typed in. Every unit has a record behind it."

**Waste & reorder** — *Inventory → Waste & reorder*
- For: wastage with a reason, and what to reorder.
- Show: Wastage by day/reason/item; **Reorder** tab grouped by supplier → turn it into a draft purchase order in one click.
- Talking point: "Waste without a reason looks exactly like theft. This separates them."

**Transfers & indents** — *Inventory → Transfers & indents*
- For: stock moving between your own stores on a numbered challan; outlets requesting stock (indents).
- Show: a transfer note; receiving store confirms what arrived, shortages written off with a reason.
- Talking point: "Central kitchen to branches, with proof of what actually arrived."

**Stock & purchasing settings** — *Inventory → Stock & purchasing settings*
- For: approval limits on large purchases, and whether the receiving store must confirm transfers.
- Show: the two limits.
- Talking point: "The person who spends isn't the only one who approves a big amount."

### Purchasing

**Suppliers** — *Purchasing → Suppliers*
- For: who you buy from — contact, GSTIN, payment terms.
- Show: a supplier record.
- Talking point: "Supplier GSTIN feeds the purchase register for input credit."

**Purchase orders** — *Purchasing → Purchase orders*
- For: ordering and receiving goods; tabs Purchase orders, Purchase bills, **Purchase register**.
- Show: a PO Draft → Ordered → Receive (part delivery allowed, rejected goods noted with why); the purchase register with CGST/SGST/IGST.
- Talking point: "Receiving is what puts stock on the shelf and updates cost. You can't receive more than you ordered."

**Returns & payments** — *Purchasing → Returns & payments*
- For: "what do we owe this supplier?"
- Show: four totals (received, returned, paid, owed); Who we owe → Pay / Return; **Supplier statement**.
- Talking point: "Reconcile with a supplier in one screen instead of a phone argument."

### Customers

**Customers** — *Customers → Customers*
- For: the guest book — mobile, birthday, tags (VIP, allergy, Jain…), company GSTIN for B2B bills, offer consent, loyalty points.
- Show: open a guest's history (visits, bills, points); Possible duplicates → merge; Export CSV.
- Talking point: "Guests' numbers are masked for staff who don't need them, and an 'erase my details' request is one button — DPDP-ready."

**Feedback** — *Customers → Feedback*
- For: star ratings and comments from counter, QR, website or phone.
- Show: average rating, happy vs unhappy tiles, mark reviewed.
- Talking point: "See unhappy guests before they post online."

**Complaints** — *Customers → Complaints*
- For: complaints with an owner, a status and a priority, linked to the bill.
- Show: Open → In progress → Resolved; resolving forces you to write how, and records what the guest was given.
- Talking point: "Complaints can't be silently buried, and you see what putting things right costs each month."

**Guest insights** — *Customers → Guest insights*
- For: lists that become phone calls — regulars, new faces, regulars gone quiet, birthdays, unhappy guests, guests sitting on points.
- Show: a list and its export for your WhatsApp broadcast list or SMS tool.
- Talking point: "Ten minutes before service, know who to call back."

### Operations

**Business day** — *Operations → Business day*
- For: opening and closing the trading day, per outlet.
- Show:
  - Open the day with the opening float.
  - **Drawers & cash:** shift drawers, cash in/out, each cashier's takings.
  - Close: **blind count**, expected vs counted, **over / short**. Open orders block the close; unpaid bills can be carried as dues.
- Talking point: "Closing the day is its own permission; a short drawer goes to the owner's bell next morning."

**Log book** — *Operations → Log book*
- For: shift handover notes — the noisy freezer, paneer running short.
- Show: an entry needing follow-up stays on top; who has read it.
- Talking point: "Replaces the WhatsApp group for shift handovers."

**Discounts & offers** — *Operations → Discounts & offers*
- For: coupon codes, the loyalty programme, and what was given away at the till.
- Show: Offers (% or flat, cap, minimum order, dates, usage limit); **Loyalty points** rules; **Given at the till** — every discount and no-charge bill, who gave it, who approved, why.
- Talking point: "Discounts are enforced, not suggested — a ₹1,500 minimum is refused on ₹1,200."

**Expenses** — *Operations → Expenses*
- For: rent, gas, electricity, repairs — everything that isn't stock.
- Show: add an expense → it waits for approval → approve.
- Talking point: "Cash expenses come out of the expected drawer, so petty cash stays honest."

### Staff

**Employees** — *Staff → Employees*
- For: the people file — code, department, salary type, joining date; plus the **Leave** tab (leave types and balances).
- Show: an employee; leave allowance taken/left.
- Talking point: "Staff and logins are separate — a kitchen porter needs no login."

**Shifts & roster** — *Staff → Shifts & roster*
- For: shift patterns (with grace period) and the weekly roster grid.
- Show: change a cell — it saves immediately.
- Talking point: "The week's roster in one grid."

**Attendance** — *Staff → Attendance*
- For: the daily sheet and the monthly muster roll.
- Show: present / absent / late tiles; **Mark remaining present**; worked, late and overtime are calculated, not typed.
- Talking point: "Hours can't be quietly adjusted, and the muster roll is ready for a labour inspection."

**Time clock** — *Staff → Time clock*
- For: the tablet at the staff entrance — tap name, type PIN, clock in / break / out.
- Show: Clock in / out tab; the board of who's in and who's late; **Day timeline**; photo with each punch (if switched on).
- Talking point: "The photo stops one person punching in for another."

**Payroll** — *Staff → Payroll*
- For: attendance rolled into pay — days, overtime, advances, bonus, PF / ESI / professional tax.
- Show: This month / Last month; a payslip; Mark paid.
- Talking point: "Payroll comes straight from attendance — no Excel in between."

**Tips** — *Staff → Tips*
- For: tips taken at payment, by day and by person; share a pool, paid with salary.
- Show: the tip pool share-out.
- Talking point: "Fair, visible tip sharing ends a common staff dispute."

### Reports

**Reports** — *Reports → Reports*
- For: thirteen reports on three shelves, each with **Print** and **Export CSV**; quick picks Today / Yesterday / Last month.
- Show (in this order):
  - **Day end · Z report** — the night's closing sheet; prints on the receipt printer with sign-off lines (X report while the day is open).
  - **Theft control** — voids, refunds, big discounts, reprints, dishes off after KOT, short drawers, by staff member and approving manager.
  - **GST filing** — GSTR-1 pack: B2B, B2C, HSN, credit notes, documents; it checks itself; CSVs match the GST portal's offline tool.
  - **Profit & loss** — sales less food cost, expenses and salaries; per outlet with shared costs split by sales.
  - **Items & menu → Not sold** — dishes nobody ordered in 30 days.
  - Also: Sales summary, Discounts, Staff & waiters, Outlets, Expenses, **Day book (Tally)**, Cancellations & voids, Stock consumption.
- Talking point: "Your accountant gets the GST pack and a Tally-ready day book; you get theft control with your morning tea."

**Activity log** — *Reports → Activity log*
- For: who did what, when, and which manager approved it — price changes, voids, refunds, permission edits, wrong PINs.
- Show: filter by person; "money-sensitive only"; export.
- Talking point: "The screen you open when a number is disputed."

### Users & access

**Users** — *Users & access → Users*
- For: logins — roles, status (active/locked), pinned to one outlet, last sign-in.
- Show: reset a password (admin can reset, never read it).
- Talking point: "A branch cashier pinned to their outlet can't see another branch's bills."

**Roles & permissions** — *Users & access → Roles & permissions*
- For: built-in roles (Admin, Manager, Cashier, Captain/Waiter, Kitchen) and custom roles.
- Show: permissions grouped by module, view vs manage; the sensitive ones — void, refund, reprint, discount, no-charge, take a dish off after KOT, close the day, see takings, see salaries.
- Talking point: "Anything sensitive a role can't do, a manager can approve on the spot with their PIN — and both names are logged."

### Platform (not shown to restaurants)

**Restaurants** — *Platform → Restaurants* (platform owner login only)
- For: adding a new restaurant with its first admin, switching one off, resetting a locked-out owner.
- Talking point (if asked about onboarding): "A new restaurant is set up from one screen; we never see its bills or guests here."

### Guest QR page (no login)

- Where: the guest scans the QR on the table.
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

*Added 8 October 2026. Eleven businesses, one or more of every type, each with about ninety
days of trading history ending today and a live "today", all owned by your login (Owner
role). They replace the old "Demo · …" businesses, which are switched off (kept, not deleted).*

### Loading them (once, after a backup)

In `backend`, with your own user id (the id of your owner login):

```
npm run db:backup
npm run seed:realistic -- --user-id <your user id>
npm run demo:tidy-restaurant -- --user-id <your user id>
```

- The first command takes a backup. The second makes the businesses and their history
  (about half an hour the first time; it prints one line per business). The third tidies
  FoodEx (see below).
- Run either again at any time, for example on the morning of a demo: nothing is made twice.
  The history is made once; a rerun only tops up today's trade up to the current hour.
- Staff logins (manager, cashier, stock keeper, accountant of each business) are saved in
  `backend/.local/realistic-demo-logins.json`. Passwords are never printed. A staff login
  sees only its own business, with its role's permissions.
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

### Business by business: what it shows and the story to tell

**Sri Lakshmi Kirana & General Stores** (grocery · KPHB Colony, Hyderabad)
- Shows: Quick bill with loose rice, dal and sugar by the kilo and packed goods at MRP; about
  45–60 bills a day (₹20–30 thousand); the **Udhaar** book with 16 account customers, overdue
  buckets, reminders and broken promises; offers (monthly ration ₹50 off, Navratri ghee ₹25
  off); five suppliers on their own days; a low-stock list.
- Story: "Srinivas Rao runs a neighbourhood kirana. The udhaar book shows who pays on the 1st,
  who has crossed the limit, who to call today and what they promised last time. The milk
  agency is paid cash every morning, the rice trader on 15 days."

**Sai Annapurna Super Bazaar** (supermarket · Jayanagar, Bengaluru)
- Shows: a busier counter (60–90 bills on weekends), card and UPI heavy; loyalty points earned
  and redeemed; offers (happy hours 4–7 pm, noodles buy 4 get 1, a Ganesh Chaturthi ghee
  offer, Navratri staples coming); dairy and bread by batch and expiry, expired packs taken off
  the shelf, a **near-expiry** list; vegetables by weight.
- Story: "Every bill earns points, offers apply themselves at the counter, and the near-expiry
  screen tells the floor what to clear before it is wasted."

**Sahyadri FMCG Distributors** (wholesale · Market Yard, Pune)
- Shows: 48 retailers on 8 beats of 4 routes and 3 salesmen; orders booked on beat days (and a
  few by phone) and sent the next morning in cases (part-sent when an item is short); trade prices before GST,
  case slabs and a "10 + 1 free" scheme; outstanding with ageing; two retailers far behind on
  **credit hold** (60 days); today's collections by the salesmen, with cheques: **one cleared,
  one post-dated, one bounced** (₹500 charge); damaged cases taken back.
- Story: "Ravi books Kothrud on Mondays and Thursdays; the godown ships next morning. The
  outstanding report shows who is past 60 days and the app stops new orders for them. Today's
  bounced cheque is back on the shop's account with the charge."

**Rangoli Silks & Fashions** (garments · T. Nagar, Chennai)
- Shows: 10 styles in size × colour (shirts, chinos, kurtis, leggings, a lehenga, kids' wear),
  sarees and fabric by the metre; GST 5 % up to ₹2,500 a piece and 18 % above (the lehenga);
  the Aadi sale (17 Jul–16 Aug) and Independence Day weekend, the quiet Mahalaya fortnight;
  **exchanges** (size swaps, a dearer piece with the difference paid, a cheaper one refunded).
- Story: "Middle sizes go first: the variant screens show which styles have broken size sets.
  An exchange is one screen: the piece back, the new piece out, the difference settled."

**Sri Venkateswara Mobiles & Electronics** (Dilsukhnagar, Hyderabad)
- Shows: handsets and TVs received one IMEI or serial number at a time (valid IMEIs), sold
  with the maker's warranty registered to the buyer, screen guards and covers sold with the
  phones; the **repair desk** with jobs in every state (received today, diagnosing, waiting
  for parts, in repair, awaiting the customer's approval, ready for pickup, delivered,
  cancelled) and some past their promised date.
- Story: "Type an IMEI and you get its whole life: received from the distributor, sold to
  whom, warranty until when, repairs. The repair board shows what is overdue before the
  customer calls."

**Glow & Grace Unisex Salon & Spa** (Indiranagar, Bengaluru)
- Shows: five stylists and therapists with their own skills, two spa rooms, timed services
  (5 % GST on top); regulars on packages (Hair spa × 5, Glow facial × 4, Men's grooming × 6)
  and memberships (Gold, Silver) with sessions used; commission by stylist and the monthly
  payout; tips; **today's calendar**: the morning's appointments done and billed (deposits
  set against the bill), one no-show, the afternoon and evening booked, more over the next
  three days (a bridal make-up with a ₹3,600 deposit).
- Story: "Open the calendar: who is free at 4, which room is taken, who paid a deposit. At the
  bill the package session comes off by itself and the stylist's commission is counted."

**Al-Noor Fresh Chicken, Mutton & Seafood** (meat · Tolichowki, Hyderabad)
- Shows: live birds, goat and whole fish bought every morning and **cut** into curry cut,
  boneless, drumsticks and keema, with yields against the template; sales by weight (some
  typed in grams); evening **wastage** (drip loss, unsold fish) with reasons; Sundays and
  Bonalu Sundays nearly double, Shravan quieter, shut on Gandhi Jayanti (dry day); three
  restaurants buying 8–18 kg on weekly credit (one far behind); **today's rate board**
  (chicken changed this morning).
- Story: "A hundred kilos of live birds became about seventy of curry cut and five of liver:
  the yield report shows the cutting, and wastage has a reason, not a mystery."

**Gupta Dry Fruits & Mewa Bhandar** (weight shop · Karol Bagh, Delhi)
- Shows: dry fruits and whole spices by batch, sold by weight (often in grams); bulk almonds
  sorted twice a week into sorted and broken; gift boxes; the **Raksha Bandhan** spike and the
  Diwali run-up; a corporate Diwali order of 25 gift boxes on account and a caterer on credit;
  weekly wastage (moisture, tasting samples).
- Story: "Rakhi week sold about three times a normal week; the corporate Diwali order is on
  account under the company's GSTIN, and udhaar tells you when that money is due."

**Vidya Book House & Stationers** (books · Deccan Gymkhana, Pune)
- Shows: books by ISBN (the ISBN is the barcode, nil GST), stationery at 0 % or 18 %; the end
  of the school season in July and the exam-guide lift in September; **school sets** (Std 10,
  Std 5) billed in one scan; two schools and a coaching class on account (one late, one far
  behind); customer orders for books not in stock (today, one with an advance); 2027 diaries
  received on 1 October.
- Story: "A parent hands over the booklist: one scan bills the whole Std 10 set. The school
  library buys on 30 days and the app shows the coaching class is months behind."

**Sri Sai Medicals** (pharmacy · Velachery, Chennai) — basic catalogue only
- Shows: medicines by strip and bottle with batch and expiry on every receipt, first expiry
  out first at the counter; scheme stock with a short expiry on the **near-expiry** screen;
  elderly regulars on a monthly account; 30–45 bills a day.
- Story: "Batch and expiry on every strip, and the near-expiry list before it becomes a loss."

**Sanjeevani Family Clinic & Diagnostics** (clinic · Madhapur, Hyderabad) — basic catalogue only
- Shows: three doctors and a sample room; appointments booked, seen and billed (consultation
  plus tests, exempt from GST), the odd no-show; closed on Sundays; **today's** remaining
  appointments and tomorrow's.
- Story: "The front desk sees who is next for each doctor; the bill is the consultation plus
  the tests the doctor asked for."

### FoodEx (the restaurant): `demo:tidy-restaurant`

- Closes every business day left open from an earlier date (the 2 October day on your
  database): stale open orders are cancelled with the reason "Demo tidy-up: stale order" (they
  stay in the cancellations report), today's orders on an old day are billed, unpaid bills are
  carried as dues (listed under Bills, unpaid, with a note on the day), open drawers are
  counted, and the day is closed with the cash it should hold (no over or short).
- Opens today's business day (₹5,000 float) if none is open and tops up today's trade to
  what a restaurant has served by the hour it is run (a few covers before lunch, a third by
  3 pm, the rest at dinner, two tables still eating). Today's day is never closed. Nothing
  is deleted.

### Things to know (say them if asked)

- **The activity log shows when the demo was loaded**, not the story's dates: the log and the
  events outbox are never back-dated. Bills, payments, stock movements, cutting batches,
  wastage, repair history and appointments carry their story dates.
- **Receipts and supplier payment vouchers cannot be changed once issued**, so the history
  settles udhaar and supplier bills as payments on each bill (shown on the bill and in the
  statements); numbered receipts, cheques and salesmen's collections are from today.
- **Warranty cards and packages start on the day the demo was loaded** (the database never
  changes a registered warranty or a sold package). In a demo, open one sold today.
- **Shops have no business day to close** (that is the restaurant): their day close is the
  read-only **Day close** report (takings by method, person and counter), and the weight
  shops' end-of-day weigh-up starts from today.
- **Offers are judged at the moment the data was loaded**, not on the story's date: in the
  history, weekend-only or happy-hour offers apply depending on when the script ran.
- **A staff login first opens the FoodEx dashboard** (its non-money view), because staff
  accounts belong to your organisation; the business switcher then shows only their own
  business. Sign staff in and switch before you share the screen.
- Navratri, Dussehra and Diwali are still ahead (11 Oct, 20 Oct, 8 Nov): the history shows the
  run-up, and the Diwali project is the work still to do.
