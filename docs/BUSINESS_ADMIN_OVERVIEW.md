# Business Admin — Application Overview

22 October 2026

## Summary

Business Admin is one web application that runs many kinds of independent business from a single login:

- restaurants and three food formats (café, bakery and cloud kitchen);
- shops and distributors;
- salons;
- pharmacies, clinics and diagnostic labs.

It is fully built for the admin side, tested end to end, and loaded with realistic sample data for a demo.

- **Who it is for:** owners, managers and staff of small and mid-sized Indian businesses, including chains with several branches and kitchens that sell under several brands.
- **What it covers:** selling, buying, stock, customer credit, staff and access, day close, reports and daily tasks, plus the special work of each business type.
- **Where it stands:**
  - feature-complete for the admin application;
  - 549 automated integration tests and 30 unit tests pass;
  - 11 sample shops and clinics, a restaurant with a second branch, a café, a bakery and a cloud kitchen carry realistic history.
- **What is not yet done:**
  - outside connections: payment gateway, SMS and WhatsApp, live Swiggy and Zomato links;
  - hardware links: silent printing, scales;
  - paid plans, separate mobile apps, and going live on a server.

  These wait on decisions and accounts, listed at the end.

### New since the last overview (13 October)

- **Food formats:** a café, a bakery and a cloud kitchen run on the restaurant engine, each set up for how it works. The bakery gets selling by weight, cake pre-orders with an advance, a bake list and the day-end unsold count. The cloud kitchen gets several brands from one kitchen.
- **Clinic and lab:**
  - doctor fees and follow-up rules, OPD timings and free-slot booking;
  - a daily token queue with a waiting-room display;
  - amended lab reports that keep every signed version;
  - lab quality control (QC).
- **Retail:**
  - branch and member prices, coupons, cashier shifts and departments;
  - shelf locations and opening hours;
  - purchase orders and reorder suggestions for every shop;
  - free quantity and discount on supplier bills.
- **Overview screen:** today against last week, a 14-day trend, sales by hour, best sellers and the next appointments. Every action opens in a panel without leaving the screen.
- **Branches:** every list, record and report now follows the branch a person works at.
- **Clean copies for real use:** each of the 11 sample shops and clinics has a twin with the same set-up (products, prices, branches, roles and the trade's own lists) and empty books: no sample sales, customers or GSTINs. A twin is filled in with a real customer's details (the name printed on bills, GSTIN, branches and staff); the samples stay for demos and training.
- **A separate guests' site:** the pages guests open without signing in (ordering from a table's QR code, online ordering and table booking) now run as their own website, apart from the staff application. Old QR codes and links still work. Pages planned for later (ordering from a shop, booking a salon or clinic appointment, a guest's own account, and the waiter, clinic and lab workspaces) already have their addresses, each saying what is coming.

## How the application is organised

One application serves twelve business types:

| Group | Business types |
| --- | --- |
| Food | Restaurant |
| Shops | Grocery / kirana, supermarket, books and stationery |
| Trade | Wholesale / FMCG |
| Speciality retail | Fashion, electronics |
| Services | Salon and spa |
| Health | Pharmacy, clinics and labs |
| Weight-based | Meat and seafood, other weight-based shops |

A restaurant also chooses its format: **restaurant, café, bakery or cloud kitchen**. A business's type is fixed when it is created and decides which screens and rules it gets.

![How Business Admin is organised](images/business-admin-overview.png)

Read the diagram top to bottom:
1. The platform sets up businesses.
2. One login opens every business a person belongs to.
3. The shared core does the common work.
4. Each business type adds only its own modules.

The restaurant and its formats run their own engine but share the login, roles, switcher and tasks. Guests never sign in: table QR ordering, online ordering and table booking open on the separate guests' site.

## Shared core modules

Every business except the restaurant runs on the same core. It is built once, so a fix or improvement reaches every business type at the same time.

| Area | Module | What it does |
| --- | --- | --- |
| Overview | Overview | Today's sales against the same day last week, a 14-day trend, sales by hour, best sellers, money in, what customers and suppliers are owed, low stock, expiring batches, the next appointments and the jobs needing attention; every action opens in a panel |
| Sell | Sales / Quick bill | Barcode or scale-label billing, branch and member prices, coupons, cashier shifts; cash, UPI, card or credit; A4 GST invoice or till receipt |
| Sell | Returns and refunds | Goods back against the original bill, each return and refund numbered, stock back automatically |
| Sell | Customers and udhaar | GSTIN, credit limit and days, what each owes, ageing, reminders, numbered collection receipts |
| Buy | Purchases and suppliers | Supplier bills with free quantity and discount, purchase orders, reorder suggestions, supplier payments and statements |
| Products | Products, categories, units | GST rate, HSN, MRP, shelf location, member price, departments, batch / expiry / serial tracking, pack sizes |
| Stock | Stock, transfers, counts | Stock by branch and batch with its value; transfers in transit; counts approved before stock changes |
| Time | Appointments | Staff and rooms without double booking; done, no-show and cancel rules |
| Money | Daily money and expenses | Takings by method, person and counter matched with cash, with a cash check and each cashier's shift; expenses paid out, corrected only by a reversal with a reason |
| Settings | Business settings | Legal name, GSTIN, address, tax mode, rounding, financial year, opening hours, rules, number series, payment methods |
| People | Staff and access | Role, branch and department for each person |
| Insight | Reports and activity log | Money by day, branch comparison, department sales, and who did what |

Two rules hold everywhere:
- Prices, tax and totals are always worked out by the server.
- Nothing posted is ever edited. A mistake is corrected by a return, refund or reasoned correction with its own number.

## Modules by business type

Each business type adds only what is truly its own on top of the shared core. The restaurant is the exception: it runs its own complete engine, shared by its formats.

### Restaurant, café, bakery and cloud kitchen

- **POS:**
  - dine-in, takeaway and delivery orders;
  - split bills;
  - a UPI QR for the exact amount;
  - the kinds of order offered depend on the format.
- **Kitchen display and KOT:** orders reach the right kitchen station; dishes can be marked sold out.
- **Tables and QR ordering:** floors and tables, guest QR ordering, captain sections.
- **Reservations and online booking:** bookings, the waitlist, and the restaurant's own booking page.
- **Online ordering and delivery:**
  - the restaurant's own ordering page and pickup tokens;
  - riders and rider cash;
  - Swiggy and Zomato channels with channel prices and commission (orders are typed in today).
- **Menu:** dishes, modifiers, combos, happy-hour prices, and recipes that drive stock use.
- **Back office:**
  - the business day, opened and closed from the dashboard;
  - cash drawers, X and Z reports;
  - stock and purchasing, expenses;
  - staff attendance, payroll and tips;
  - guest loyalty;
  - fourteen reports including GST filing and profit and loss.

| Format | How it is set up |
| --- | --- |
| Restaurant | Tables, captains and the kitchen; dine-in, takeaway and delivery |
| Café | Order and pay at the counter with a token number to collect; a few tables; pre-orders for parties |
| Bakery | Takeaway and delivery; bakes made each morning from recipes; cookies and sweets sold by weight (price per kg); cake pre-orders with the message, an advance, a bake list and hand-over billing; the day-end unsold count written off at cost |
| Cloud kitchen | Delivery only, with no tables. Several brands from one kitchen: each brand has its own menu, prints on its KOT and bill, and has its own sales by channel net of commission |

### Grocery / kirana and supermarket

- **Quick bill:** barcodes, weighing-scale labels, quick weight buttons, coupons, member and branch prices, cashier shifts.
- **Offers and loyalty:** six kinds of offer, the best one applied automatically; points earned and redeemed.
- **Departments:** staff tied to a department, and a department sales report.
- **Udhaar book, labels and near expiry:** who owes what, label sheets, batches about to expire.

### Books and stationery

- **ISBN billing:** a wrong check digit is caught.
- **School sets and book orders.**

### Wholesale / FMCG distribution

- **Sales orders, dispatch and back-orders:** pick list, van load sheet, delivery challan.
- **Routes and beats, cheques and credit hold.**
- **Price groups, schemes and purchase orders.**

### Fashion

- **Size × colour grid:** each size and colour has its own barcode and stock.
- **Exchanges and credit vouchers, markdowns.**
- **GST by price:** applied automatically.
- **Garment tags and size curves.**

### Electronics and mobiles

- **IMEI / serial register.**
- **Warranties, repairs, EMI and financiers.**
- **Kits and bundles.**

### Salon and spa

- **Calendar:** a column per stylist and room, with deposits and fair no-show charges.
- **Bill:** services and products in separate tabs by category; products kept for salon use cannot be sold.
- **Packages, memberships, commissions and schedules.**

### Meat, seafood and weight-based shops

- **Selling by weight and daily rates.**
- **Cutting and yield:** true cost per usable kg.
- **Wastage and yield by supplier.**

### Pharmacy

- **Drug master and prescription sale:** first-to-expire batch, substitutes by salt.
- **Schedule rules and registers:** H, H1 and X, ready for inspection.
- **Expiry returns and recalls.**

### Clinics and diagnostic labs

- **Today's patients and the token queue:**
  - each patient gets a token on arrival, and priority patients are called first;
  - the doctor calls the next patient and starts the consultation from the token;
  - a full-screen board shows the waiting room who is being seen.
- **Doctors:**
  - consultation fee, plus a reduced or free follow-up within a set number of days;
  - OPD timings by weekday, with morning and evening sessions and leave;
  - appointments are booked only into a doctor's free slots;
  - the bill picks the right fee;
  - an earnings report shows each doctor's patients, fees and share.
- **Patients and consent, consultations:** registration with recorded consent; vitals, diagnosis, prescription and follow-up (doctors only).
- **Lab:**
  - orders, sample barcodes, results and pathologist approval;
  - amended reports keep every signed version and print as "amended", with the reason; older versions print as "superseded";
  - quality control: each morning's control runs are judged by the standard Westgard rules, a failed control holds that test's reports until QC passes again, and a chart shows the control's trend.

Pharmacy and clinic rules follow standard Indian practice. A pharmacist, a doctor and a legal adviser should review them before real use.

## Multiple locations (branches)

A business can run several shops, counters, godowns, clinics or outlets. Each is kept separately, and the owner sees all of them together.

- **Each location has its own:**
  - stock;
  - bill numbers;
  - day close;
  - branch prices;
  - opening hours;
  - its own address, phone, GSTIN and state, printed on its bills.
- **Staff tied to one branch:** they see, open and change only that branch's records. This covers bills, transfers, appointments, visits, lab orders, repairs, pre-orders and every list and report. Anything belonging to another branch is refused by the server.
- **The top-bar location picker:** an owner can look at one branch or all of them, and every list follows the choice.
- **Stock transfers:** sent by one branch and confirmed by the receiving one.
- **Locations compared report:** the branches side by side.
- **Pharmacy branches:** each holds its own drug licence numbers.
- **The restaurant:** has the same under the name "outlets". The demo restaurant runs a second outlet.

## People, roles and security

Every action needs two keys: the business must have that module switched on, and the person's role must allow the action. Both are checked by the server on every request.

- **One login, many businesses**, each with its own role.
- **Six ready roles** in every business, plus a Pharmacist in a pharmacy, a Doctor, a Lab technician and a Pathologist in a clinic, and any the owner creates. A manager can never give more than they hold.
- **Staff logins with a branch and a department.**
- **Sign-in protection:** passwords never stored in readable form, two-step sign-in, lockout after repeated wrong attempts, PINs for shared tills, PIN sign-off for pathologists and pharmacists.
- **Data kept apart:** each business sees only its own data, enforced by the database too.
- **Activity log:** a record of who did what; posted bills are never edited.
- **Clinical privacy:** only doctors (and the owner) see clinical notes, and every view is logged.

## Owner-controlled settings

Business rules are settings the owner changes, not values fixed in the program. Each starts at a sensible default.

| Setting | Default | What the owner controls |
| --- | --- | --- |
| Payment methods | Cash, UPI, Card, Bank transfer, Cheque | Add, rename, reorder or switch off methods |
| Restaurant format | Restaurant | Café, bakery or cloud kitchen: the POS order types, tokens and starting features (each can still be changed) |
| Features | By type and format | Switch on or off pre-orders, brands, deliveries, reservations, QR ordering, loyalty, stock, payroll and more |
| Doctor fees and OPD | None | Per doctor: fee, follow-up rule, slot length, share, timings, leave |
| Expiring soon | 30 days | Which batches are flagged |
| Credit voucher validity | 90 days | How long an exchange voucher can be spent |
| Customer credit age groups | 30 / 60 / 90 days | Columns of outstanding and udhaar reports |
| Quick weight buttons | 250 g, 500 g, 1 kg, 2 kg | Buttons for loose goods |
| Receipt paper | 80 mm | 58 mm for small printers |
| Day cut-off | 5 am | When late-night work still belongs to the day before |
| Currency and time zone | INR, Asia/Kolkata | Per business |

Kept fixed on purpose: GST and GSTIN rules (law), the permission list (security design), and the PIN lockout (protection against guessing).

## Tasks, issues and projects

Every business, restaurant included, gets the same tools for the team's daily work, designed for the phone.

- **My tasks and checklists:** 82 ready-made templates (opening, closing, cleaning and more); recurring tasks.
- **Issues:** raised, assigned, fixed and closed. An out-of-range reading can raise one automatically.
- **Projects:** with milestones; a board, a calendar and compliance reports.

A restaurant starts with these tools on. Any other business switches them on when it wants them; Tasks is marked as recommended for the trades that usually need it (clinics, pharmacies and supermarkets), and Issues for pharmacies and supermarkets.

## Reports and insights

Every list can be searched, paged, filtered by date and exported. Reports respect each person's role and branch.

- **All businesses:** Overview, money by day, day close, locations compared, outstanding and ageing, department sales, activity log.
- **Retail and wholesale:**
  - top sellers, slow movers, margin, stock value, offers given away;
  - by salesperson, route or customer.
- **Fashion, electronics and salon:** sizes and styles, warranties and repairs, service profitability, commissions.
- **Meat and weight shops:** yield and wastage.
- **Pharmacy, clinic and lab:**
  - H1 and X registers;
  - doctor earnings;
  - lab worklists, report versions and the QC history.
- **Restaurant and food formats:**
  - fourteen reports including GST filing, profit and loss, Tally day book and Z report;
  - for the cloud kitchen, sales by brand and channel after aggregator commission.

## Platform administration and onboarding

A new customer can be set up in minutes, without technical help or sample data.

- **Platform › Businesses:** create a business of any type but the restaurant, with its owner's login. It is ready to use on first sign-in.
- **Platform › Restaurants:** the same for restaurants. The platform team chooses the format (restaurant, café, bakery or cloud kitchen), and it starts set up for that format.
- **Add a business:** an owner can start another business of their own.
- **Modules on demand:** each business switches modules on or off within what its type allows. This is ready to be tied to paid plans later.
- **Sample shops and clinics** are marked as demos and disappear in live mode. Their clean copies are ordinary businesses, set up and ready to be filled in for real customers (handing over ownership is not in the app yet).

## Quality and readiness

The admin application is complete and verified by automated tests. It has not yet been used by real staff in a live shop.

- **Automated tests:** 549 integration tests and 30 unit tests pass, each run against a fresh database. The screens pass a lint check and a production build, and every new screen was checked in a browser.
- **Rules in the database:** where a mistake would lose money, stock or medical records, the database refuses it as well as the program. Examples:
  - duplicate bill numbers;
  - negative stock;
  - editing a posted bill or a signed report;
  - changing a QC run;
  - another business's data.
- **Realistic demo data:**
  - 11 sample shops and clinics with 90 days of history, 7 of them with a second branch;
  - the FoodEx restaurant with a second outlet;
  - a café, a bakery and a cloud kitchen with a week of trading.

| Sample business | City | Shows |
| --- | --- | --- |
| Sri Lakshmi Kirana | Hyderabad | Loose goods by weight, udhaar |
| Sai Annapurna Super Bazaar | Bengaluru | Two branches, loyalty, offers, coupons, expiry |
| Sahyadri FMCG Distributors | Pune | Beats, dispatch, cheques, Karnataka depot |
| Rangoli Silks & Fashions | Chennai | Size × colour, exchanges, branch with own GSTIN |
| Sri Venkateswara Mobiles | Hyderabad | IMEI, warranties, repairs, EMI |
| Glow & Grace Salon & Spa | Bengaluru | Calendar, packages, commissions, products by category |
| Al-Noor Meat & Seafood | Hyderabad | Daily rates, cutting and yield, two shops |
| Gupta Dry Fruits | New Delhi | Sales by weight, two shops |
| Vidya Book House | Pune | ISBN, school sets |
| Sri Sai Medicals | Chennai | Schedules, registers, a recall, branch licences |
| Sanjeevani Clinic & Diagnostics | Hyderabad | Doctor fees and OPD, token queue, lab reports, QC |
| FoodEx Restaurant (+ Madhapur outlet) | Hyderabad | Tables, KOT, deliveries, two outlets |
| Brew & Bloom Café | Bengaluru | Counter orders with tokens |
| Sweet Crust Bakery | Hyderabad | Sold by weight, cake pre-orders, day-end unsold |
| Biryani Box (cloud kitchen) | Hyderabad | Three brands, Swiggy and Zomato, sales by brand |

Before a demo, one command brings the sample shops, the clinic and FoodEx up to the current moment: `npm run demo:today -- --user-id 2`. The food businesses are added once with `npm run demo:food-formats`.

## What comes next

The remaining work lies outside the admin application, and each item waits on a decision or an outside account.

| Area | What | Needs from management |
| --- | --- | --- |
| Go-live | Server hosting, web address with HTTPS, off-site backups, a 2–4 week pilot with real staff | A server budget and a pilot business and date |
| Outside services | Online payment confirmation, live Swiggy / Zomato orders and menus per brand, SMS and WhatsApp messages | Provider accounts and contracts |
| Hardware | Silent receipt and kitchen printing, cash drawer, live weighing scale | The printer and scale models in use |
| Plans and subscriptions | Paid plans that decide which modules a business gets | Plan names and prices |
| Separate apps | Offline POS, captain (waiter) app, clinic and lab workspaces, guests' pages for shops, appointments and their own account, salesperson app | Priority and go-ahead |
| Expert review | Pharmacy, clinic and lab rules, GST reports and Tally export | A pharmacist, a doctor, an accountant |

Recommended order:
1. Run the pilot first with one restaurant (or café) and one shop.
2. Add the payment gateway and WhatsApp.
3. Add plans and pricing.
