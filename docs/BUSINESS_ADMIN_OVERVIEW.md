# Business Admin — Application Overview

13 October 2026

## Summary

Business Admin is one web application that runs any of twelve kinds of independent business — restaurants, shops, distributors, salons, pharmacies and clinics — from a single login. It is fully built for the admin side, tested end to end, and loaded with realistic sample data for a demo.

- **Who it is for:** owners, managers and staff of small and mid-sized Indian businesses, including chains with several branches.
- **What it covers:** selling, buying, stock, customer credit, staff and access, day close, reports, and daily tasks — plus the special work of each business type.
- **Where it stands:** feature-complete for the admin application; 535 automated integration tests and 30 unit tests pass; 11 realistic sample businesses and a restaurant carry 90 days of history.
- **What is not yet done:** outside connections (payment gateway, SMS and WhatsApp, food aggregators), hardware links (silent printing, scales), paid plans, separate mobile apps, and going live on a server. These wait on decisions and accounts, listed at the end.

## How the application is organised

One application serves twelve business types: restaurant, grocery / kirana, supermarket, wholesale / FMCG, fashion, electronics, pharmacy, books and stationery, salon and spa, clinics and labs, meat and seafood, and other weight-based shops. A business's type is fixed when it is created and decides which screens and rules it gets.

![How Business Admin is organised](images/business-admin-overview.png)

Read top to bottom: the platform sets up businesses; one login opens every business a person belongs to; the shared core does the common work; each business type adds only its own modules. The restaurant runs its own engine but shares the login, roles, switcher and tasks.

## Shared core modules

Every business except the restaurant runs on the same core. It is built once, so a fix or improvement reaches every business type at the same time.

| Area | Module | What it does |
| --- | --- | --- |
| Overview | Overview | Today's and this month's sales after returns, money in today, what customers owe, what is owed to suppliers, low stock, batches expiring soon, transfers on the way, today's appointments, and quick actions |
| Sell | Sales / Quick bill | Bill at the counter: scan a barcode or scale label, search by name, take cash, UPI, card or split payment, or put the bill on the customer's credit; print an A4 GST invoice or a till receipt |
| Sell | Returns and refunds | Take goods back against the original bill; each return and refund gets its own number; stock goes back automatically |
| Sell | Customers | GSTIN (checked), credit limit, credit days, opening balance, and what each customer owes now |
| Sell | Udhaar / Outstanding | Customer credit: who owes what, how old it is, reminders by WhatsApp, promised dates, numbered collection receipts |
| Buy | Purchases and suppliers | Record supplier bills; stock goes up at cost; pay suppliers against their bills; supplier statements |
| Products | Products and services | Items with GST rate, HSN code, MRP, unit, reorder level, and how they are tracked (quantity, batch and expiry, or serial number) |
| Products | Categories, units and pack sizes | Category tree up to five levels; units with conversions (g to kg); pack sizes (box of 24) |
| Stock | Stock on hand and movements | Stock by location and batch with its value; every change recorded with its reason |
| Stock | Transfers and counts | Send stock between locations (in transit until received); count stock over time, approved by a manager before stock changes |
| Time | Appointments | Book staff and rooms without double-booking; done, no-show and cancel rules |
| Money | Day close | Takings by payment method, by person and by counter, matched with cash in hand |
| Settings | Business settings | Legal name, GSTIN, address, prices with or without GST, rounding, financial year, currency, time zone, rules |
| Settings | Tax rates and number series | GST slabs; bill numbers per location and financial year with no gaps or duplicates |
| Settings | Locations and payment methods | Branches and godowns; the ways the shop takes money |
| People | Staff and access, roles | Who can open the business, their role, and which branch they work at |
| Insight | Reports and activity log | Money by day, branch comparison, and who did what |

Two rules hold everywhere: prices, tax and totals are always worked out by the server, and nothing posted is ever edited — a mistake is corrected by a return, refund or reasoned correction with its own number.

## Modules by business type

Each business type adds only what is truly its own on top of the shared core. The restaurant is the exception: it was built first and runs its own complete engine, sharing login, roles, the switcher and tasks with everyone else.

### Restaurant

- **POS:** dine-in, takeaway and delivery orders; split bills; UPI QR for the exact amount.
- **Kitchen display and KOT:** orders reach the right kitchen station; dishes marked sold out.
- **Tables and QR ordering:** floors and tables; guests scan a QR to order or call staff; captain sections.
- **Reservations and online booking:** bookings, waitlist, the restaurant's own booking page.
- **Online ordering and delivery:** own ordering page, pickup tokens, riders and rider cash settlement, Swiggy and Zomato channels (typed in today).
- **Menu:** dishes, modifiers, combos, happy-hour prices, recipes that drive stock use.
- **Back office:** business day with cash drawers per shift, X and Z reports, stock and purchasing, expenses, staff attendance, leave, payroll and tips, guest loyalty and feedback, fourteen reports including GST filing and profit and loss.

### Grocery / kirana and supermarket

- **Quick bill:** scan barcodes or weighing-scale labels; quick weight buttons for loose goods.
- **Offers:** six kinds (buy 4 get 1 free, percentage off and so on); the best offer applies itself.
- **Loyalty points:** earn and redeem; settled fairly on returns.
- **Udhaar book:** who owes what, reminders, promised dates, statements.
- **Labels and near expiry:** barcode label sheets; batches about to expire.

### Books and stationery

- **ISBN billing:** the ISBN is the barcode; a wrong check digit is caught.
- **School sets:** a class's whole book list sold as one set.
- **Book orders:** order a title for a customer and track it until it arrives.

### Wholesale / FMCG distribution

- **Sales orders:** taken by the salesperson at the shop's own price; credit checked.
- **Dispatch and back-orders:** send all or part; pick list, van load sheet, delivery challan.
- **Routes and beats:** which salesperson visits which shops on which day.
- **Cheques and credit hold:** cheque tracking; a bounce adds a charge and can hold credit.
- **Price groups and schemes:** retailer or HoReCa prices; buy N get M free.
- **Purchase orders:** reorder suggestions, receiving in parts, claims on suppliers.

### Fashion

- **Size × colour grid:** one style in every size and colour, each with its own barcode and stock.
- **Exchanges and credit vouchers:** swap goods, settle the difference, or issue a voucher.
- **Markdowns:** percentage off until a date, then the price returns by itself.
- **GST by price:** 5% up to ₹2,500 a piece, 18% above, applied automatically.
- **Tags and style reports:** garment tags with MRP; size curves and broken sizes.

### Electronics and mobiles

- **IMEI / serial register:** where every unit is and its full history.
- **Warranties:** registered from the sale; claims with brands.
- **Repairs:** job card, parts and labour, advance, bill on delivery.
- **EMI and financiers:** down payment now; the financier's payout tracked to the rupee.
- **Kits and bundles:** phone, cover and screen guard at one price.

### Salon and spa

- **Calendar:** a column per stylist and room; no double booking.
- **Deposits and no-shows:** fair late-cancellation charges.
- **Packages and memberships:** prepaid sessions and member discounts.
- **Commissions:** per stylist, service or product; monthly target slabs.
- **Schedules and service profitability:** working hours, leave and holidays; products used per service.

### Meat, seafood and weight-based shops

- **Sell by weight:** kg or grams, scale labels, quick weight buttons.
- **Daily rates:** today's price per kg.
- **Cutting and yield:** whole bird or fish into cuts; true cost per usable kg.
- **Wastage and yield by supplier:** what was lost and which supplier yields best.

### Pharmacy

- **Drug master:** salt, strength, schedule, strips and loose tablets.
- **Prescription sale:** first-to-expire batch; cheaper substitutes by the same salt.
- **Schedule rules and registers:** H, H1 and X need a prescription and a pharmacist; H1 and X registers ready for inspection.
- **Expiry returns and recalls:** debit notes to distributors; block a recalled batch and list every buyer.

### Clinics and diagnostic labs

- **Today's patients:** waiting, with the doctor, billed, report ready.
- **Patients and consent:** registration with recorded consent.
- **Consultations:** vitals, diagnosis, prescription, follow-up date; doctors only.
- **Lab:** orders, sample barcodes, results, pathologist approval, printed reports.

Pharmacy and clinic rules follow standard Indian practice and should be reviewed by a pharmacist, a doctor and a legal adviser before real use.

## Multiple locations (branches)

A business can run several shops, counters or godowns, each kept separately while the owner sees all of them together.

- **Each location has its own** stock, bill numbers per financial year, day close, and — when entered — its own address, phone, GSTIN and state, printed on the bills it raises. A branch registered in another state bills from that state.
- **Staff can be tied to one branch.** They then bill, move stock, take returns and see reports for that branch only; anything for another branch is refused. A branch manager can give access only at their own branch.
- **A location picker in the top bar** lets an owner or area manager look at one branch or all of them; every list, report and the Overview follow the choice.
- **Stock transfers** are sent by one branch and confirmed by the receiving branch, with goods shown as "on the way" in between.
- **Locations compared report:** bills, sales, returns, net sales, each branch's share, average bill, money collected, purchases and stock held, side by side.
- **Pharmacy branches** hold their own drug licence numbers, as the law requires per premises.

Customer credit (udhaar) stays business-wide, because a customer belongs to the business, not to one branch. The restaurant has the same branch features under the name "outlets".

## People, roles and security

Every action needs two keys: the business must have that module switched on, and the person's role in that business must allow the action. Both are checked by the server on every request, not only hidden on screen.

- **One login, many businesses.** A person can belong to several businesses with a different role in each, and switches between them from the top bar.
- **Roles:** six ready roles in every business — Owner, Manager, Cashier, Stock keeper, Accountant, Viewer — plus any the owner creates. Each role is a set of permissions such as "give refunds" or "export reports".
- **No privilege climbing:** a manager can never give a role or permission they do not hold themselves, and the owner's access cannot be changed by anyone else.
- **Staff logins:** the owner creates logins for staff, sets their role and branch, and can reset a staff member's password.
- **Sign-in protection:** passwords stored encrypted, two-step sign-in, locking after repeated wrong attempts, and personal PINs for shared tills.
- **Data kept apart:** each business sees only its own data; the database itself refuses any record that points at another business.
- **Activity log:** every change records who did what and when; posted bills are never edited.
- **Clinical privacy:** only doctors see clinical notes, and every view of them is logged.

## Owner-controlled settings

Business rules are settings the owner changes, not values fixed in the program. Each starts at a sensible default, so nothing changes until the owner edits it.

| Setting | Default | What the owner controls |
| --- | --- | --- |
| Payment methods | Cash, UPI, Card, Bank transfer, Cheque | Add, rename, reorder or switch off methods (PhonePe, Paytm, a meal card); bills and the day close show the name |
| Expiring soon | 30 days | Which batches the Overview, alerts and stock list flag |
| Credit voucher validity | 90 days | How long an exchange or return voucher can be spent |
| Customer credit age groups | 30 / 60 / 90 days | The columns of outstanding and udhaar reports |
| Quick weight buttons | 250 g, 500 g, 1 kg, 2 kg | The buttons for loose goods at the counter |
| Receipt paper | 80 mm | 58 mm for small printers |
| Day cut-off | 5 am | When a late-night task still belongs to the day before |
| Currency and time zone | INR, Asia/Kolkata | Per business; currency locked once bills exist |
| Restaurant alerts and timings | Old fixed values | 25 limits: theft alerts, kitchen pass time, delivery and reservation timings, time-clock limits, guest segments, reorder planning, cash-count notes |

Kept fixed on purpose: GST and GSTIN rules (law), the permission list (security design), and the PIN lockout (protection against guessing).

## Tasks, issues and projects

Every business, restaurant included, gets the same tools for the team's daily work, designed for the phone.

- **My tasks:** today's work, ticked off step by step.
- **Checklists:** 82 ready-made templates (opening, closing, cleaning and more) to start from.
- **Recurring tasks:** daily, weekly or monthly work that creates itself.
- **Issues:** a problem raised, given to someone, fixed and closed; an out-of-range reading can raise one by itself.
- **Projects:** six ready plans, such as festival preparation, with milestones and owners.
- **Board, calendar and reports:** who is doing what, what is late, what was missed, compliance by person.

## Reports and insights

Every list can be searched, paged, filtered by date and exported; reports respect each person's role and branch.

- **All businesses:** Overview, money by day (sales, returns, collections, refunds, purchases), day close, locations compared, outstanding and ageing, activity log.
- **Retail:** top sellers, slow movers, margin by category, stock value, what offers gave away.
- **Wholesale:** by salesperson, route or customer; collections; schemes by retailer.
- **Fashion and electronics:** sales by size and colour, style and size curves, stock age, warranties and repairs.
- **Salon:** service profitability, stylist commissions and statements.
- **Meat and weight shops:** yield by item, cut and supplier; wastage by reason.
- **Pharmacy and clinic:** H1 and X registers, prescription log, expiry by distributor, lab worklists.
- **Restaurant:** fourteen reports, including GST filing, profit and loss, Tally day book, dish profitability, theft control and day end (Z report).

## Platform administration and onboarding

A new customer can be set up in minutes, without technical help or sample data.

- **Platform › Businesses** (the platform team): create a business of any type with its name, code, GSTIN, address, currency, time zone, first location and the owner's login. The owner signs in and finds it ready: roles, GST slabs, units, payment methods and the type's modules are in place. The same screen switches a business off and on and resets an owner's password.
- **Platform › Restaurants:** the same for restaurants, which also get their menu, tables and kitchen set-up.
- **Add a business** (an owner): start another business of their own and become its owner.
- **Modules on demand:** each business switches optional modules on or off within what its type allows; this is ready to be tied to paid plans later.
- **Sample businesses** are marked as demos and disappear automatically when the system runs in live mode.

## Quality and readiness

The admin application is complete and verified by automated tests; it has not yet been used by real staff in a live shop.

- **Automated tests:** 535 integration tests and 30 unit tests pass, run against a fresh database each time; the screens pass a lint check and a production build.
- **Rules in the database:** where a mistake would lose money or stock (duplicate bill numbers, negative stock, editing a posted bill, another business's data), the database refuses it as well as the program.
- **Realistic demo data:** 11 sample businesses with 90 days of history and today's live trade, 7 of them with a second branch, plus the FoodEx restaurant.

| Sample business | City | Shows |
| --- | --- | --- |
| Sri Lakshmi Kirana | Hyderabad | Loose goods by weight, udhaar |
| Sai Annapurna Super Bazaar | Bengaluru | Two branches, loyalty, offers, expiry |
| Sahyadri FMCG Distributors | Pune | Beats, dispatch, cheques, Karnataka depot |
| Rangoli Silks & Fashions | Chennai | Size × colour, exchanges, Bengaluru branch with own GSTIN |
| Sri Venkateswara Mobiles | Hyderabad | IMEI, warranties, repairs, EMI |
| Glow & Grace Salon & Spa | Bengaluru | Calendar, packages, commissions |
| Al-Noor Meat & Seafood | Hyderabad | Daily rates, cutting and yield, two shops |
| Gupta Dry Fruits | New Delhi | Sales by weight, corporate orders, two shops |
| Vidya Book House | Pune | ISBN, school sets |
| Sri Sai Medicals | Chennai | Schedules, registers, a recall, branch licences |
| Sanjeevani Clinic & Diagnostics | Hyderabad | Appointments, consultations, lab reports |

Before a demo, one command brings every sample business up to the current moment: `npm run demo:today -- --user-id 2`.

## What comes next

The remaining work lies outside the admin application, and each item waits on a decision or an outside account.

| Area | What | Needs from management |
| --- | --- | --- |
| Go-live | Server hosting, web address with HTTPS, off-site backups, a 2–4 week pilot with real staff | A server budget and a pilot business and date |
| Outside services | Online payment confirmation, Swiggy / Zomato, SMS and WhatsApp messages, password reset by message | Provider accounts and contracts |
| Hardware | Silent receipt and kitchen printing, cash drawer, live weighing scale | The printer and scale models in use |
| Plans and subscriptions | Paid plans that decide which modules a business gets | Plan names and prices |
| Separate apps | Offline POS, captain (waiter) app, customer app, salesperson app | Priority and go-ahead |
| Expert review | Pharmacy and clinic rules, GST reports and Tally export | A pharmacist, a doctor, an accountant |

Recommended order: run the pilot first with one restaurant and one shop, then add the payment gateway and WhatsApp, then plans and pricing.
