# Business Management Platform — product overview

For owners, management and prospective customers: what the product does for each type of business, what it does not do yet, and what management must decide.

## Summary

Business Admin, the staff application of the Business Management Platform, runs many kinds of independent business from a single login: restaurants and three food formats (café, bakery and cloud kitchen), shops and distributors, salons, and pharmacies, clinics and diagnostic labs.

- **Who it is for:** owners, managers and staff of small and mid-sized Indian businesses, including chains with several branches and kitchens that sell under several brands.
- **What it covers:** selling, buying, stock, customer credit, staff and access, daily money, reports and daily tasks, plus the special work of each business type.
- **Where it stands:** the admin side and the guests' site are built and tested end to end. They have not yet run in a live business.
- **Not built yet:**
  - outside connections: payment gateway, SMS and WhatsApp, live Swiggy and Zomato links;
  - hardware links: silent printing, scales;
  - paid plans, separate mobile apps, and going live on a server.

  These wait on decisions and outside accounts. [What comes next](#what-comes-next) sums them up, and [BACKLOG.md](BACKLOG.md) lists them in full.

## How it is organised

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
3. The shared core does the common work. Its *Day close* box is the Daily money screen.
4. Each business type adds only its own modules.

The restaurant and its formats run their own engine, with roles of their own, but share the login, the switcher and tasks. Guests never sign in: table QR ordering, online ordering and table booking open on the separate guests' site.

## The shared core

Every business except the restaurant runs on the same core. It is built once, so a fix or improvement reaches every business type at the same time.

| Area | Module | What it does |
| --- | --- | --- |
| Overview | Overview | Today's sales against the same day last week, a 14-day trend, sales by hour, best sellers, money in, what customers and suppliers are owed, low stock, expiring batches, the next appointments and the jobs needing attention; every action opens in a panel |
| Sell | Sales / Quick bill | Barcode or scale-label billing, branch and member prices, coupons, cashier shifts; cash, UPI, card or udhaar; A4 GST invoice or till receipt |
| Sell | Returns and refunds | Goods back against the original bill, each return and refund numbered, stock back automatically |
| Sell | Customers and udhaar | GSTIN, credit limit and days, what each owes, ageing, reminders, numbered collection receipts |
| Buy | Purchases and suppliers | Supplier bills with free quantity and discount, purchase orders, reorder suggestions, supplier payments and statements |
| Products | Products, categories, units | GST rate, HSN, MRP, shelf location, member price, departments, batch / expiry / serial tracking, pack sizes, opening stock when an item is added |
| Stock | Stock, transfers, counts | Stock by branch and batch with its value; transfers in transit; counts approved before stock changes |
| Time | Appointments | Staff and rooms without double booking; done, no-show and cancel rules |
| Money | Daily money and expenses | Takings by method, person and counter matched with cash, with a cash check and each cashier's shift; expenses paid out, corrected only by a reversal with a reason |
| Settings | Business settings | Legal name, GSTIN, address, tax mode, rounding, financial year, opening hours, rules, number series, payment methods |
| People | Staff and access | Role, branch and department for each person |
| Insight | Reports and activity log | Money by day, branch comparison, department sales, and who did what |

Two rules hold everywhere:
- Prices, tax and totals are always worked out by the server.
- Nothing posted is ever edited. A mistake is corrected by a return, refund or reasoned correction with its own number.

## What each business type gets

Each business type adds only what is truly its own on top of the shared core. The restaurant is the exception: it runs its own complete engine, shared by its formats.

**Getting products in.** A restaurant imports its menu, recipes, stock items, suppliers and guests from CSV files. The other business types have no file import: their products, customers and suppliers are entered on screen. A new item can take the stock already on the shelf as opening stock; further stock comes in through purchases.

### Restaurant, café, bakery and cloud kitchen

- **POS:**
  - dine-in, takeaway and delivery orders;
  - one bill paid in several ways;
  - a UPI QR for the exact amount;
  - the kinds of order offered depend on the format.
- **Kitchen display and KOT:** orders reach the right kitchen station; dishes can be marked sold out.
- **Tables and QR ordering:** floors and tables, guest QR ordering, captain sections.
- **Reservations and online booking:** bookings, the waitlist, and the restaurant's own booking page.
- **Online ordering and delivery:**
  - the restaurant's own ordering page and pickup tokens;
  - riders and rider cash;
  - Swiggy and Zomato channels with channel prices and commission (their orders are typed in).
- **Menu:** dishes, modifiers, combos, happy-hour prices, and recipes that drive stock use.
- **Back office:**
  - the business day, opened before service and closed after;
  - cash drawers, X and Z reports;
  - stock and purchasing, expenses;
  - staff attendance, payroll and tips;
  - guest loyalty;
  - sales, accounts and control reports, including GST filing, profit and loss and the Tally day book.

| Format | How it is set up |
| --- | --- |
| Restaurant | Tables, captains and the kitchen; dine-in, takeaway and delivery |
| Café | Order and pay at the counter with a token number to collect; a few tables; pre-orders for parties |
| Bakery | Takeaway and delivery; bakes made each morning from recipes; cookies and sweets sold by weight (price per kg); cake pre-orders with the message, an advance, a bake list and hand-over billing; the day-end unsold count written off at cost |
| Cloud kitchen | Delivery first, takeaway too, with no tables. Several brands from one kitchen: each brand has its own menu, prints on its KOT and bill, and has its own sales by channel net of commission |

### Grocery / kirana and supermarket

- **Quick bill:** barcodes, weighing-scale labels, quick weight buttons, coupons, member and branch prices, cashier shifts.
- **Offers and loyalty:** % or ₹ off an item or the whole bill, % off a category, and buy X get Y; the offer worth most to the customer applies by itself. Points are earned and redeemed.
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

Pharmacy and clinic rules follow standard Indian practice. A pharmacist, a doctor and a legal adviser should review them before real use; [BUSINESS_RULES.md › Pharmacy, clinic and lab](BUSINESS_RULES.md#pharmacy-clinic-and-lab) sets them out.

## Several locations

A business can run several shops, counters, godowns, clinics or outlets. Each is kept separately, and the owner sees all of them together.

- **Each location has its own:**
  - stock;
  - bill numbers;
  - daily money and cash check;
  - branch prices;
  - opening hours;
  - address, phone, GSTIN and state, printed on its bills.
- **Staff tied to one branch:** they see, open and change only that branch's records. This covers bills, transfers, appointments, visits, lab orders, repairs, pre-orders and every list and report. Anything belonging to another branch is refused by the server.
- **The top-bar location picker:** an owner can look at one branch or all of them, and every list follows the choice.
- **Stock transfers:** sent by one branch and confirmed by the receiving one.
- **Locations compared report:** the branches side by side.
- **Pharmacy branches:** each holds its own drug licence numbers.
- **The restaurant:** has the same under the name "outlets". Each outlet opens and closes its own business day.

## People, roles and security

Every action needs two keys: the business must have that module switched on, and the person's role must allow the action. The server checks both on every request.

- **One login, many businesses**, each with its own role.
- **Ready-made roles:** Owner, Manager, Cashier / sales, Stock keeper, Accountant and Viewer in every business; a pharmacy adds a Pharmacist, and a clinic adds a Doctor, a Lab technician and a Pathologist. A restaurant has its own set: Restaurant Admin, Manager, Cashier, Captain / Waiter, Kitchen staff, Accountant, Store keeper and a Collection display for the pickup screen. An owner can add roles of their own, and a manager can never give more than they hold.
- **Staff logins with a branch and a department.**
- **Sign-in protection:** passwords never stored in readable form, two-step sign-in, lockout after repeated wrong attempts, PINs for shared tills, PIN sign-off for pathologists and pharmacists.
- **Data kept apart:** each business sees only its own data. The server checks it on every request, and the database refuses any record that points at another business's data.
- **Activity log:** a record of who did what; posted bills are never edited.
- **Clinical privacy:** only doctors (and the owner) see clinical notes, and every view is logged.

## What the owner decides

Business rules are settings the owner changes, not values fixed in the program. Each starts at a sensible value. The starting values of the everyday rules are in [ADMIN_GUIDE.md › Business settings › Rules](ADMIN_GUIDE.md#business-settings--rules).

| Setting | Where it is set |
| --- | --- |
| Payment methods: add, rename, reorder or switch off | Settings › Payment methods |
| How sales are worked out: prices with or without GST, rounding, the most discount at the counter, udhaar for walk-in customers, a PIN for every bill at a shared till | Settings › Business settings |
| Business tools: which parts of Business Admin the business uses | Settings › Business tools |
| Which batches count as expiring soon | Settings › Business settings › Rules; a pharmacy uses Pharmacy settings |
| How long a credit voucher can be spent | Settings › Business settings › Rules |
| Customer credit age groups: the columns of the outstanding and udhaar reports | Settings › Business settings › Rules |
| Quick weight buttons for loose goods | Settings › Business settings › Rules |
| Till receipt paper: 80 mm or 58 mm | Settings › Business settings › Rules |
| Day cut-off: when late-night work still belongs to the day before | A restaurant: the Business day screen (Cash rules). Other businesses: Settings › Business settings › Rules, where it applies to tasks |
| Currency and time zone | Settings › Business settings (the currency only until the first bill or purchase); a restaurant sets them in its own Settings |
| Doctor fees and OPD: each doctor's fee, follow-up rule, slot length, share, timings and leave | Doctors, fees & OPD (clinic) |
| Restaurant format, which sets the POS order types, token numbers and starting features | Chosen in Platform › Restaurants; changed later in the restaurant's Settings › Features |
| Restaurant features: pre-orders, brands, deliveries, reservations, QR ordering, loyalty, stock, payroll and more | The restaurant's Settings › Features |
| Restaurant alert lines: when the bell warns | The restaurant's Settings › Alerts and timings |

A few rules are fixed on purpose, such as the GST rules, the permission list and the PIN lockout; [BUSINESS_RULES.md › Fixed on purpose](BUSINESS_RULES.md#fixed-on-purpose) lists them with the reasons.

## Tasks, issues and projects

Every business, restaurant included, gets the same tools for the team's daily work, designed for the phone.

- **My tasks and checklists:** ready-made templates (opening, closing, cleaning and more), recurring tasks, a team board, a calendar and compliance reports.
- **Issues:** raised, assigned, fixed and closed. An out-of-range reading on a checklist can raise one by itself.
- **Projects:** with milestones and task lists, from a blank page or a ready-made plan.

A restaurant starts with these tools on. Any other business switches them on in Settings › Business tools when it wants them. Tasks is marked as recommended for clinics, pharmacies and supermarkets, and Issues for pharmacies and supermarkets.

## Reports

Every list can be searched, paged and exported, and lists of records can be filtered by date. Reports respect each person's role and branch.

- **Every business on the shared core:** Overview, money by day, Daily money, locations compared, outstanding and ageing, department sales, activity log.
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
  - sales, accounts and control reports, including GST filing, profit and loss, the Tally day book and the Z report;
  - for the cloud kitchen, sales by brand and channel after aggregator commission.

## Setting up a new customer

The platform's own Super Admin creates a new customer's business in the Platform screens; its login is made when the platform is installed. Creating a business takes a few minutes. Filling it in is the owner's work.

- **Platform › Restaurants:** adds a restaurant with its owner's login (a Restaurant Admin). The platform team chooses the format: restaurant, café, bakery or cloud kitchen. The restaurant starts set up for that format, with its GST rates, settings, delivery channels and a kitchen station. The owner adds the menu, tables, staff, GSTIN and FSSAI number after signing in.
- **Platform › Businesses:** adds a business of any other type, with its legal details, first location and owner's login (a new login, or an existing one by its email). The owner signs in and finds it ready: roles, GST slabs, units, payment methods and the type's everyday business tools are set up.
- **Add a business:** an owner, or a restaurant's admin, can start another business of their own and becomes its owner.
- **Modules on demand:** each business switches modules on or off within what its type allows, in Settings › Business tools. This is ready to be tied to paid plans later.

The owner then enters products, prices, customers, suppliers and staff logins. Shops type these in; a restaurant can import its lists from CSV files. Handing a business over to a new owner is not built yet.

How the Platform screens work: [ADMIN_GUIDE.md › The first platform login and the platform screens](ADMIN_GUIDE.md#the-first-platform-login-and-the-platform-screens). What a new business fills in first: [ADMIN_GUIDE.md › First steps in a new business](ADMIN_GUIDE.md#first-steps-in-a-new-business).

## Safeguards

Automated tests cover the admin side and the guests' site; the integration tests and the browser tests each build a fresh database on every run. Real staff have not yet used the platform in a live business; a pilot comes first ([GO_LIVE.md](GO_LIVE.md)).

Where a mistake would lose money, stock or medical records, the database refuses it as well as the program. For example:
- a duplicate bill number;
- stock below zero in a shop (a restaurant bill never waits for stock: its stock may go below zero, and the stock screens then ask for a count);
- editing a posted bill or a signed lab report;
- changing a QC run;
- a record that points at another business's data.

## What comes next

Most of the work left lies outside the admin application: going live on a server, outside services, hardware links, paid plans and separate apps. Each item waits on a decision or an account from management, such as a server budget, provider contracts, the printer and scale models, plan prices, or a pharmacist, a doctor and an accountant to review the rules. [BACKLOG.md › At a glance](BACKLOG.md#at-a-glance) lists every item with what it needs.

Recommended order:
1. Run a pilot first, with one restaurant (or café) and one shop ([GO_LIVE.md](GO_LIVE.md)).
2. Add the payment gateway and WhatsApp.
3. Add plans and pricing.
