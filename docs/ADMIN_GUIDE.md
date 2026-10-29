# Admin guide

*For owners, managers, staff and support: how to use every screen, from the
first platform login to closing the day, and what each screen allows or
refuses.*

Words are defined in [GLOSSARY.md](GLOSSARY.md), the reason behind each rule
is in [BUSINESS_RULES.md](BUSINESS_RULES.md), and what is still to come is in
[BACKLOG.md](BACKLOG.md).

One application, **Business Admin**, runs every business you belong to. A
restaurant gets the full restaurant admin (menu, tables, POS, kitchen,
billing, stock, staff, reports); a café, a bakery and a cloud kitchen run on
it too. Every other business type — grocery, supermarket, wholesale, fashion,
electronics, pharmacy, books, salon, clinic, meat and weight-based shops,
general store, hardware, seeds and fertilisers, optical, garage, jewellery,
fuel station, gym and coaching, laundry, rentals, and hotel and lodge —
gets the Business Admin screens its business tools switch on. Guests never
sign in: they order and book on the **guests' site**, the pages a
restaurant's QR codes and links open.

**Two rules hold everywhere.** You only see what your role allows: a screen
you may not use is not greyed out, it is absent, and the server checks the
same permission again on every action, so hiding a button is presentation,
not security. And money and stock are never edited after the fact: a mistake
is undone by a void, a refund, a return or a reasoned correction, each kept
on record.

---

## Contents

**[Part 1 — Getting started](#part-1--getting-started)**

- [Signing in and staying safe](#signing-in-and-staying-safe)
- [The first platform login and the platform screens](#the-first-platform-login-and-the-platform-screens)
  - [Platform › Restaurants](#platform--restaurants)
  - [Platform › Businesses](#platform--businesses)
- [Starting a business](#starting-a-business)
  - [Business settings › Rules](#business-settings--rules)
- [First steps in a new business](#first-steps-in-a-new-business)
  - [A shop, wholesaler, salon, pharmacy or clinic](#a-shop-wholesaler-salon-pharmacy-or-clinic)
  - [A restaurant](#a-restaurant)
- [The business switcher](#the-business-switcher)
  - [GST thresholds across your businesses](#gst-thresholds-across-your-businesses)
- [Getting around the restaurant admin](#getting-around-the-restaurant-admin)
- [Lists: the data grid](#lists-the-data-grid)

**[Part 2 — The restaurant](#part-2--the-restaurant)**

- [Dashboard](#dashboard)
- [Service — POS, orders, kitchen, captains, requests](#service--pos-orders-kitchen-captains-requests)
- [Billing, payments, dues and advances](#billing-payments-dues-and-advances)
- [Reservations and online booking](#reservations-and-online-booking)
- [Online ordering, tokens and the pickup screen](#online-ordering-tokens-and-the-pickup-screen)
- [Deliveries, delivery charge and rider cash](#deliveries-delivery-charge-and-rider-cash)
- [Restaurant — profile, outlets, hours, settings, payment types](#restaurant--profile-outlets-hours-settings-payment-types)
- [Features — switching parts of the restaurant on or off](#features--switching-parts-of-the-restaurant-on-or-off)
- [Menu — Categories, Products, Modifiers, Tax rates, Happy hour](#menu--categories-products-modifiers-tax-rates-happy-hour)
- [Tables — Floors & areas, Tables & QR](#tables--floors--areas-tables--qr)
- [Inventory](#inventory)
- [Purchasing](#purchasing)
- [Customers — Customers, Feedback, Complaints](#customers--customers-feedback-complaints)
- [Operations — business day, cash drawers, log book, discounts, expenses](#operations--business-day-cash-drawers-log-book-discounts-expenses)
- [Staff — employees, leave, attendance, time clock, payroll, tips](#staff--employees-leave-attendance-time-clock-payroll-tips)
- [Reports and the activity log](#reports-and-the-activity-log)
- [Café, bakery and cloud kitchen](#café-bakery-and-cloud-kitchen)

**[Part 3 — Business Admin for the other business types](#part-3--business-admin-for-the-other-business-types)**

- [The screens every type shares](#the-screens-every-type-shares)
  - [Several locations (branches)](#several-locations-branches)
  - [Products, prices and opening stock](#products-prices-and-opening-stock)
  - [Products, customers and suppliers from a CSV file](#products-customers-and-suppliers-from-a-csv-file)
  - [GST rate changes](#gst-rate-changes)
  - [Daily money, expenses and cashier shifts](#daily-money-expenses-and-cashier-shifts)
  - [Payment methods](#payment-methods)
  - [Purchases: receiving, free goods, discounts, purchase orders, paying suppliers](#purchases-receiving-free-goods-discounts-purchase-orders-paying-suppliers)
  - [Shop extras: shelf, branch and member prices, coupons, departments](#shop-extras-shelf-branch-and-member-prices-coupons-departments)
  - [Quotations](#quotations)
  - [Licences](#licences)
  - [Personal data](#personal-data)
- [Retail counter (grocery / kirana, supermarket, books & stationery)](#retail-counter-grocery--kirana-supermarket-books--stationery)
  - [Quick bill](#quick-bill)
- [Wholesale / FMCG](#wholesale--fmcg)
- [Fashion](#fashion)
- [Electronics](#electronics)
  - [EMI & financiers](#emi--financiers)
  - [Repair advances](#repair-advances)
- [Salon & spa](#salon--spa)
- [Meat, fish and weight-based shops](#meat-fish-and-weight-based-shops)
- [Pharmacy](#pharmacy)
- [Clinic & lab](#clinic--lab)
  - [Clinic workspace](#clinic-workspace)
  - [Lab workspace](#lab-workspace)
- [Newer trades on the shared core](#newer-trades-on-the-shared-core)
- [Hardware, paints & building materials](#hardware-paints--building-materials)
- [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides)
- [Optical shops](#optical-shops)
- [Vehicle service & auto parts](#vehicle-service--auto-parts)
- [Gyms, studios & coaching](#gyms-studios--coaching)
- [Laundry & dry cleaning](#laundry--dry-cleaning)
- [Jewellery & gold](#jewellery--gold)
- [Rentals & hire](#rentals--hire)
- [Fuel stations](#fuel-stations)
- [Hotels, lodges & guest houses](#hotels-lodges--guest-houses)

**[Part 4 — Tasks, issues & projects](#part-4--tasks-issues--projects)**

- [What each person sees](#what-each-person-sees)
- [My tasks (phone first)](#my-tasks-phone-first)
- [Doing a task](#doing-a-task)
- [Team board, calendar](#team-board-calendar)
- [Templates](#templates)
- [Recurring tasks](#recurring-tasks)
- [Issues](#issues)
- [Projects](#projects)
- [Reports](#reports)
- [The bell](#the-bell)

**[Part 5 — Roles and permissions](#part-5--roles-and-permissions)**

- [Restaurant roles](#restaurant-roles)
- [Business Admin roles](#business-admin-roles)

**[Part 6 — A day in the life, and what is not built yet](#part-6--a-day-in-the-life-and-what-is-not-built-yet)**

- [A day in the life](#a-day-in-the-life)
- [Not built yet: what to do meanwhile](#not-built-yet-what-to-do-meanwhile)

---

# Part 1 — Getting started

## Signing in and staying safe

**Signing in.** Type your email, mobile or staff code and your password. A
staff code (the employee code from Staff → Employees) also needs the
**Business code** (a restaurant's code); that box also appears when one mobile
number has logins at more than one business. A sign-in lasts 8 hours without
use and is renewed while you work, so a long shift is never cut off.
Passwords are 8 to 72 characters.

**A password someone else set.** The first password of a new login, and a
new one an admin or the platform sets for you, works for one sign-in only.
After it (and after the two-step code, if you use one) the sign-in shows
**Choose your own password**: type the password you were given, then your new
one twice, and **Save and continue**. Nothing else opens until you do, and
the new password cannot be the one you were given. Then you carry on to the
page you were opening, and every other device signed in as you is signed out.
**Not you? Sign out** goes back to the sign-in form. The login made with
`npm run user:create` does the same at its first sign-in
([BUSINESS_RULES.md › A password someone else set is changed at the first sign-in](BUSINESS_RULES.md#a-password-someone-else-set-is-changed-at-the-first-sign-in)).

**Two-step sign-in.** After a correct password, people who use it type the
6-digit code from an authenticator app (Google or Microsoft Authenticator);
they have 10 minutes to do so. Turn it on yourself from your name (top right)
→ **My profile, password & PIN** → **Two-step sign-in**. Turning it on gives
you **10 one-time recovery codes** — print or save them; *Phone lost or flat?
Use a recovery code* gets you in without the phone. **Trust this device for
30 days** skips the code on that browser — leave it off on a shared till.

- **Which roles must use it:** none by default. The owner ticks roles under
  **Users → Till lock & sign-in → Who must use two-step sign-in** (Restaurant
  Admin is marked *Recommended*). A person in a ticked role is taken straight
  to set-up after their password and cannot get in without finishing it.
- **Lost phone and no recovery codes:** an admin uses **Users → ⋯ → Reset
  two-step sign-in**, which also signs that person out everywhere.

**Lockouts.** Five wrong passwords (or wrong codes) in 15 minutes lock that
account for 15 minutes; a browser that has signed in successfully before is
counted separately, so a stranger cannot lock the owner out of their own
phone. An admin can unlock early (**Users → ⋯ → Unlock sign-in**). Thirty
failed sign-ins from one network in 15 minutes pause sign-in from that
network. Every attempt is in the person's **Sign-in history**.

**The shared till: lock and PIN.** The lock icon in the top bar (or **Lock
till / switch user**) locks the screen; the till can also lock itself after
2–60 minutes without a touch (**Users → Till lock & sign-in → Lock after**).
The same person unlocks with their PIN and carries on exactly where they
were; **Someone else?** lets another person tap their name and type their
own PIN, so the activity log shows who did what. A PIN is 4–6 digits; easy
runs (1234, 1111) and the end of your own mobile are refused; five wrong
PINs lock that PIN for 15 minutes. A PIN only works on a till already signed
in to the restaurant — it never lets anyone in from outside.

**Your profile** (from your name): change your name and mobile, your PIN
(password needed), your password (which signs you out everywhere else), turn
two-step on or off, see your last 20 sign-ins and **Sign out all other
devices**.

**Manager approval.** Some actions — a void, a refund, closing the day, a
large write-off — need a permission many staff do not have. Instead of a
refusal they get a **Manager approval** panel: a manager standing nearby taps
their name and types their PIN. The approval covers only what is shown
(this bill, this amount, this item) once, and lapses after about two
minutes. If the action then fails for another reason, the approval is used
up and the manager must approve again. The activity log names both people.

## The first platform login and the platform screens

A new installation is empty: no restaurant, business, product or staff login
exists until someone makes it. Whoever installs the platform makes the first
login once, on the server: `npm run user:create` in `backend`, with the
restaurant code left empty, makes the platform's **Super Admin**
([README › The first login](../README.md#3-the-first-login)). Its first
sign-in asks for a password of its own, as every new login's does. Everything
else is made on the screens.

The Super Admin belongs to no restaurant. It opens on **Platform ›
Restaurants**, and only the platform's own logins see the **Platform** group
of the menu (Restaurants, Businesses). The platform screens add restaurants
and businesses, switch them off and on, and set new passwords for locked-out
owners; they never show a restaurant's or a business's bills, guests or
sales.

### Platform › Restaurants

Every restaurant on the platform, cafés, bakeries and cloud kitchens
included, most recently active first: its code, format and phone, its status,
its outlets, how many of its logins are active, and its last activity. Tiles
count the restaurants, the active ones and those switched off. Search by name
or code, show all, active or switched-off restaurants, and *Export CSV*.

- **Add restaurant** asks for:
  - the **format**: restaurant, café, bakery or cloud kitchen. It sets how the
    POS opens and the features the restaurant starts with; the owner can
    change them later;
  - the **name** and the **code** (letters and digits, fixed once created;
    staff type it with their staff code at sign-in);
  - the phone, email and address;
  - the **bill number prefix** (INV unless changed) and the **order number
    prefix** (ORD);
  - **the owner's login**: full name, email, mobile (optional) and a first
    password of 8 to 72 characters. The owner becomes the restaurant's
    **Restaurant Admin** and chooses their own password at the first sign-in.
- **What a new restaurant starts with:** four GST rates (Exempt; GST 5 % for
  restaurant service, SAC 996331, the default for new dishes; GST 18 %; GST
  40 %), its settings (time zone Asia/Kolkata and the two prefixes), five
  sales channels (Own delivery, Swiggy, Zomato, Phone and Website), the
  kitchen display's *Main kitchen* station, and its first admin. It has no
  menu, no tables and no staff: the owner adds them ([First steps in a new
  business](#first-steps-in-a-new-business)). A café, bakery or cloud kitchen
  also starts with its format's set-up ([Café, bakery and cloud
  kitchen](#café-bakery-and-cloud-kitchen)). The owner fills in the GSTIN and
  FSSAI number under Settings → GST and invoice.
- **Switch off** (*More* on the row) signs out everyone who works there and
  tells them their restaurant is not active, until it is switched on again.
  Nothing is deleted. **Switch on** lets its staff sign in again at once.
- **Admins** lists the people who manage the restaurant's users and roles,
  with their last sign-in and whether they are locked out. **New password**
  gives one of them a new password: they are signed out everywhere and any
  lockout is lifted. Tell them the password; they choose their own at their
  next sign-in.

### Platform › Businesses

Every business on the platform except restaurants: its code, type, owner,
city, locations and people, when it was created and its status (GSTIN,
currency and time zone are columns you can show). Search by name, code, city
or GSTIN, and filter by type and status.

- **Add a business** asks for the **type** (fixed once created: it decides
  the screens and rules), the **business name**, the **business code** (short
  and unique; letters, digits and dashes; fixed once created), the legal
  name, GSTIN and GST state code, the address, phone and email, the
  **currency**, the **time zone**, the **first location** and its code (used
  in bill numbers; *Main store* and MAIN when left empty), and **the owner's
  login**. The owner is an existing login, found by its email (the business
  is added to it and appears in its switcher), or a new login with a name, a
  mobile (optional) and a password of 8 to 72 characters; the owner chooses
  their own password at the first sign-in.
- The owner signs in and finds the business ready: its roles, GST slabs,
  units, payment methods and its type's everyday business tools are set up.
  It has no products, customers, suppliers, staff or stock yet ([First steps
  in a new business](#first-steps-in-a-new-business)).
- **Switch off** takes a business out of its people's switchers and closes it
  to them until it is switched on again. Nothing is deleted. **Switch on**
  opens it again.
- **Owner password** sets a new password for an owner locked out of their
  own business; their open sessions end, and they choose their own password
  at their next sign-in.

## Starting a business

A restaurant is created only in **Platform › Restaurants**, and so is a café,
a bakery or a cloud kitchen, which run on the restaurant. A business of any
other type (shops, wholesale, fashion, electronics, salon, meat and weight
shops, pharmacy, clinic, and the trades in [Newer trades](#newer-trades-on-the-shared-core))
is created in one of two ways:

- **Platform › Businesses** (the platform's Super Admin), with the owner's
  login, as above.
- **Your businesses › Add a business** (the owner of a business, or a
  restaurant's admin): the same details without an owner's login; whoever
  adds it becomes its owner.

The type and the code are fixed once the business is created. The rest can
change later: the business's name and details in Business settings, and its
locations in Settings › Locations. In Business settings, **Business name** is
the name the business switcher, the header and every screen show; the owner,
or anyone whose role may change the settings, renames the business there (up
to 150 characters; the same name as another of your businesses is allowed),
and the switcher and the header show the new name at once, other devices at
their next read. Each rename is kept in the activity log with the old and the
new name. A restaurant is renamed on its own Profile, and its business in the
switcher takes the same name. **Name shown in the app** is the name printed
on till receipts, slips and cards; the A4 invoice prints the legal name, with
this name under it when the two differ.

**Business tools** (*Settings › Business tools*, at the foot of Business
settings) are the parts of Business Admin a business uses, in two groups:
*Everyday work* (products, customers and suppliers, sales, purchases, stock,
daily expenses, and the type's own, such as appointments, patient records or
pharmacy rules) and *Optional workflows*. A new business starts lean: what its
type uses every day is on, and stock transfers, offers, loyalty points,
repairs, EMI & finance, packages, commissions, the laboratory, cutting & yield,
quotations (except at a hardware shop), fitters' commission, licences (except
at a seeds, fertilisers & pesticides shop), tasks, issues and
projects stay off until the owner or a manager switches them on. A tool most businesses of the type use is marked *Recommended*, with the
reason, and listed first. Switching a tool off hides its screens and keeps its
history.

**Staff logins.** In Staff & access, *New staff login* creates a login for
someone who has none (name, email, first password, role, where they work and,
in a business with departments, which department; a manager tied to a
department makes logins in that department only); *Give access* adds someone
who already has a login (your restaurant's staff, or people working in
another business you own). *Password* sets a new password for a member of
staff whose login is used only in this business; their open sessions end.
After a new login's first password, or a new password set here, the person
chooses their own at their next sign-in. You
can change someone (*Change*, the same form as *Give access*), or set their
password, only when you manage them: if you are tied to a location or a
department, they are tied to that same one (not to every location or every
department), and their role can do nothing yours cannot. *Change* and
*Password* show only beside the people you manage, never beside the owner or
yourself
([BUSINESS_RULES.md › Who a manager can change in Staff & access](BUSINESS_RULES.md#who-a-manager-can-change-in-staff--access)).

**Currency and time zone** are in Business settings. The currency can change
until the first bill or purchase is recorded; the time zone decides what
"today" is for bills, the day close and reports.

### Business settings › Rules

Each rule starts at the usual value; change only what you need. Why each rule
is as it is, and which rules stay fixed, is in
[BUSINESS_RULES.md](BUSINESS_RULES.md).

| Rule | Default | What it changes |
|---|---|---|
| Expiring soon means within | 30 days | Batches on the Overview, the bell, the near-expiry list and the stock list's "Expiring" filter (a pharmacy keeps its own in Pharmacy settings) |
| Credit vouchers valid for | 90 days | How long a voucher from an exchange or return can be spent |
| Customer credit age groups | 30, 60, 90 days | The columns of Outstanding, Udhaar and the wholesale reports ("0–30 days" … "Over 90 days" follow the numbers) |
| Quick weight buttons | 250 g, 500 g, 1 kg, 2 kg | The buttons on a loose item at Quick bill (up to 8) |
| Till receipt paper | 80 mm | 58 mm for a small receipt printer |
| Day cut-off | 5 am | A task due after midnight, before this hour, belongs to the day before |

## First steps in a new business

A new business starts with its basics set up and nothing else: no products,
customers, suppliers, staff logins or stock. These steps take it to its first
real bill. The owner can do them all; a manager can do the ones their role
allows.

### A shop, wholesaler, salon, pharmacy or clinic

1. **Business settings.** Under *Business details*: the *Business name* (the
   switcher's), *Name shown in the app*
   (printed on receipts), the legal name (printed on the A4 invoice), GSTIN,
   address, phone and logo. Under *Prices, totals and numbering*: whether
   selling prices include GST (a goods shop starts with prices including GST,
   rounded to the rupee), the financial year (fixed once the first document
   is numbered), *Most discount at the counter*, the *Walk-in customers* rule
   and the *Shared till* PIN rule. Then the [Rules](#business-settings--rules).
2. **Settings › Locations.** Each location's address and phone, and its GSTIN
   if it is registered on its own. Add the other branches and godowns, and
   untick *Sells at the counter* on a godown so Quick bill does not offer it.
3. **Settings › Payment methods.** A new business starts with Cash, UPI, Card,
   Bank transfer and Cheque. Rename them the way the counter says them
   (PhonePe, Paytm, the bank account), add your own and switch off the ones
   you do not take.
4. **Settings › Tax rates.** A new business starts with GST nil / exempt,
   5 %, 18 % (the slab a new item gets unless you choose another) and 40 %.
   *Add slab* for any other rate your goods need.
5. **Settings › Business tools.** Switch on what the business needs; the
   *Recommended* ones are marked, with the reason.
6. **Staff & access.** *New staff login* for each person, with their role
   and, when they work at one branch, *Works at* that branch (and their
   department, in a store with departments). Someone who already has a login
   gets *Give access*.
7. **The people who sign.** A pharmacy (*Pharmacy settings*): its drug
   licence numbers, *Licences by branch* for a branch with its own, and the
   **registered pharmacists**, chosen from the staff logins. A clinic
   (*Clinic & lab settings*): the lab's name and registration, and the
   **doctors** and the **pathologist** with their registration numbers; a
   doctor's appointment calendar makes its tokens their own queue in the
   clinic workspace.
8. **Products.** Add each item with its price, GST slab, HSN code and MRP
   ([Products, prices and opening stock](#products-prices-and-opening-stock)),
   or import the catalogue from a CSV file
   ([Products, customers and suppliers from a CSV file](#products-customers-and-suppliers-from-a-csv-file)).
   Then the type's own set-up, described with each type in Part 3: a
   wholesaler's routes, beats, salespeople and price groups; a garment shop's
   sizes and colours; an electronics shop's models and warranty terms; a
   salon's stylists, services and booking rules; a weight shop's cutting
   templates; a pharmacy's drug master; a clinic's doctors' fees and OPD
   timings, tests and panels.
9. **Customers and suppliers.** Typed in on their screens, added on the
   spot (*+ New customer* at Quick bill, *+ New supplier* on a purchase), or
   imported from a CSV file with what each owed when you started.
10. **Stock.** It comes in with the item (*Opening stock* on *Add item*, or
    the *Opening stock* column of an import) or through a purchase
    (*Purchases › Receive a purchase*). A stock count
    corrects stock already on record; it cannot bring in an item that has
    never been stocked at that location. Serial-numbered items such as phones
    come in through a purchase, one number at a time.
11. **Check the prices.** Each item's price, GST slab and MRP, before the
    first bill.


### A restaurant

**Settings → Profile** has a **Set-up checklist** of what a first bill needs:
the restaurant's name, GSTIN, FSSAI number, logo, business hours, payment
types and a default tax rate, each linked to where it is filled in. Then:

1. **Settings.** The tax mode (prices including or excluding GST), the CGST +
   SGST split, service charge, order and bill numbers, the UPI ID and
   printing ([Restaurant — profile, outlets, hours, settings, payment
   types](#restaurant--profile-outlets-hours-settings-payment-types)).
   **Business hours**, and an **outlet** for each branch.
2. **Settings → Features.** Switch off the parts the restaurant does not use,
   and switch on the ones it wants that start off (Loyalty points, Pre-orders
   & cakes, Brands).
3. **Menu.** Categories, then dishes with their sizes, add-ons and recipes. A
   new restaurant starts with four GST rates (Menu → Tax rates).
4. **Tables & QR.** Floors, areas and tables (not in a bakery or a cloud
   kitchen).
5. **Users & access.** A login for each person who signs in, with their role
   and, at a branch, their outlet. **Staff → Employees** holds everyone on
   the payroll, with or without a login.
6. **Stock and suppliers**, when the restaurant keeps stock: stock items with
   their opening stock, and the suppliers.

All of this can be typed in, or the restaurant can **import** its menu,
recipes, stock items, suppliers and guests from CSV files, each checked before
anything is saved ([Menu › Import and export](#import-and-export)).

Then decide:

- **Each outlet opens and closes its own business day and cash drawers.** Pick
  the branch in the top bar (or tie staff to it in Users) before opening its
  day or billing. Sales taken with *All outlets* picked belong to no outlet,
  and an outlet's P&L says how much sits there.
- **Record branch spending with that outlet selected.** Expenses entered with
  *All outlets* are shared costs, shared out by sales in branch reports.
- **Set the approval limits** (Stock & purchasing settings) and decide who gets
  `purchasing.approve`; both limits start blank, so nothing needs approval
  until you set them.
- **Decide who must use two-step sign-in** (Users → Till lock & sign-in) —
  at least the Restaurant Admin.
- **Set the guest web address** before printing QR codes or sharing booking
  and ordering links.
- **Check the alert lines** (Settings → Alerts and timings): each starts at
  the number this guide gives, and a busy counter and a fine-dining room
  rarely want the same ones.

## The business switcher

The button in the top bar shows the business you are in, with its type (a
café, bakery or cloud kitchen shows its format). Click it to search (*Find a
business*, by name, type or code) and pick from **Restaurants & food** and
**Other businesses**; each line shows your role there.

- Picking **your signed-in restaurant** shows the restaurant admin.
- Picking **any other business** opens its Business Admin at
  `/business-admin/<id>`, with its own menu in three groups (*Daily work*,
  *Business*, *Management*; see Part 3), named for its type — a salon says
  *Clients* and *Services & products*, a grocery says *Udhaar*. Inside
  another business the outlet picker gives way to that business's
  **location picker**, and the bell and Quick access are its own: the bell
  warns about low stock, expiring batches, overdue udhaar (outstanding) and
  promises to pay, repairs, appointments, licences running out, tasks
  and issues, and, for whoever may see the business's money, its PAN's
  turnover nearing or past a GST threshold
  ([GST thresholds across your businesses](#gst-thresholds-across-your-businesses)).
- **Another restaurant** is greyed out ("This restaurant opens when you sign
  in to it"): sign in to that restaurant to manage it.
- The last business you opened is **remembered on the server**, so your next
  sign-in, on any device, returns you there: the loading screen shows until
  your businesses are known, then that business opens with its own header
  (never the restaurant's first). Opening another business from the switcher
  shows its header and its loading screen at once.
- **All businesses** opens the *Your businesses* page
  (`/business-admin?all=1`): every business you belong to as a card with its
  type and your role and, for what your role may see, today's sales, what
  customers owe (*Udhaar* in a kirana, a meat or weight-based shop, a general
  store, a hardware shop or a seeds and fertiliser shop, *Owed* elsewhere) and how many things need a look (low stock, expiring batches,
  broken promises, repairs ready, orders to dispatch). With more than six
  businesses a *Find a business* box narrows the cards.
  - The owner of a business, or a restaurant's admin, starts another business
    here with **Add a business**.
  - A Restaurant Admin whose restaurant is not on the list yet sees **Link my
    restaurant**, which adds it, with them as its owner.
  - Someone who belongs to no business yet is told so, and asks a business's
    owner for access.
  - The owner of a business sees a **GST thresholds** card: each PAN's
    turnover this financial year so far and the most serious figure it nears
    or has passed (what applies there applying now, or from the next
    1 April), with *Open GST thresholds*.
- **GST thresholds**, under *All businesses* in the switcher (for the owner
  of a business), opens the owner's view of their businesses' turnover by PAN
  (below).
- Leaving a form you have not saved asks first.

### GST thresholds across your businesses

What applies to a taxpayer's invoices in a financial year (April to March)
follows its aggregate turnover in the year before: e-invoicing and 6-digit
HSN / SAC codes on invoices above ₹5 crore, and at ₹10 crore or more no
invoice or credit note reported to the IRP more than 30 days after its date.
Several businesses of one owner trade under one PAN, and their turnover adds
up.
**GST thresholds** (`/business-admin/gst-thresholds`, from the switcher or the
*GST thresholds* card on *Your businesses*) is the owner's own: anyone else is
told it is for a business's owner.

- **One card for each PAN**, with the businesses you own under it: each
  business's PAN comes from its GSTIN (its own or a location's; a restaurant's
  GST number or an outlet's), a branch registered in another state included.
  The card shows the turnover **this year so far**, **last year**, and **at
  this pace** by 31 March (each business's pace since 1 April, or since the
  day it came onto the platform), and, for each figure, where the PAN stands:
  *Below*, *Nearing* (from your warning level), *Applies from* the next
  1 April (passed this year so far) or *Applies now* (passed last year), with
  a bar to the figure and a mark at your warning level, what applies there,
  and *at this pace it passes by 31 March* when the pace says so. Each
  business's row gives its PAN's source, its turnover and *Open*.
- **Turnover** is each business's sales less what came back, before GST, on
  its own dates and clock: a shop's bills and returns on their days, a
  restaurant's bills (not voided) and credit notes on their business days.
  Nil-rated and exempt sales count, and so do a fuel station's fuel bills,
  outside GST: that is how the platform's research reads aggregate turnover,
  and an accountant has still to check it. Purchases, advances and deposits
  are not sales. Only what is billed on the platform counts: a business's
  sales from before it came onto the platform, and those of a GSTIN under the
  PAN that is not on the platform, are yours to add.
- **Not linked to a PAN** lists a business with no GSTIN and no PAN
  recorded, one whose GST number is not a valid GSTIN, and one whose GSTINs
  carry different PANs, each with why and what it sold this year. **Record
  PAN** gives a business with no GSTIN the PAN it trades under (*Change PAN*
  later, or clear it); it then counts with your other businesses under that
  PAN. A business with a GSTIN takes its PAN from it: correct the GSTIN in its
  settings instead. Nothing is guessed.
- **When to warn**: the share of each figure (80% to start with, a whole
  percent from 50 to 99) from which this page and the bell of each of your
  businesses under the PAN say the turnover is *nearing* it.
- **HSN / SAC to fix**, once 6-digit codes apply, now or from the next
  1 April: how many items of each business print a shorter code, or none,
  with a link to them (a restaurant's tax rates), to fix before they are
  needed.
- **The figures, and how turnover is counted**: each figure with what
  applies, the turnover it is measured against, the date it applies from and
  its source. The platform keeps them; an accountant checks them.

**The bell.** Each business under the PAN warns on its bell (a restaurant on
its own), one line for each figure: nearing it as a warning; passed as
critical, saying whether what applies there applies now (passed last year)
or from the next 1 April (passed this year so far: the time to prepare).
Only people who may see the business's money (its reports) get it. The PAN
shows in full to the business's owners and as its last four characters
(••••••234K) to everyone else; the sums show only to someone who may see the
money of every business they add up. The line opens *GST thresholds* for an
owner, and the catalogue's codes to fix for anyone else once 6-digit codes
apply or are coming (a restaurant: *Menu › Tax rates*). A bell's figures may
be up to five minutes behind the sales; a PAN recorded or a warning level
saved shows at once.

A business's turnover adds up with the other businesses the same owner login
owns under its PAN: a business someone else owns, even under the same PAN,
is in their view, not yours. Nothing here files a return or makes an
e-invoice: e-invoices are made through the IRP outside the platform.

## Getting around the restaurant admin

**The top bar**, left to right: the restaurant's name (back to the
Dashboard; under it the outlet you are tied to and, for a café, bakery or
cloud kitchen, the format), the business switcher, the **Outlet** picker, the
**bell**, the **lock**, and your account menu.

**The sidebar** has three groups. Each entry opens an area, and the area's
other pages are **tabs** across the top of its page: the first four show (and
the one you are on), the rest are under **More tools**; the POS, the kitchen
display and the pickup screen keep the whole screen. You see only the
entries and tabs your role can open and whose feature is on (Settings →
Features); an entry with none disappears, and an entry opens the first of its
pages you may use. In this guide an arrow goes one level down the menu:
**Daily work → Kitchen display** is the *Kitchen display* entry of the
*Daily work* group, and **Orders → Table requests** is the *Orders* entry's
*Table requests* tab.

| Group | Entries (and the tabs inside them) |
| --- | --- |
| Daily work | Dashboard · POS · **Orders** (Orders, Pickup screen, Table requests, Deliveries) · Pre-orders & cakes · Bills & payments · Dues & accounts · Kitchen display · Expenses · Business day |
| Operations | **Menu** (Products, Categories, Brands, Modifiers, Happy hour, Tax rates) · **Tables & QR** (Tables & QR, Floors & areas; not in a bakery or cloud kitchen) · Reservations · **Stock** (Items & stock, Stock movements, Waste & reorder, Day-end unsold for a bakery or café, Transfers & indents, Stock & purchasing settings) · **Purchases & suppliers** (Purchase orders, Suppliers, Returns & payments) · **Customers** (Customers, Feedback, Complaints, Guest insights) · **Staff** (Employees, Shifts & roster, Attendance, Time clock, Payroll, Tips, and My work for a login linked to a staff record) |
| Management | **Reports** (Reports, Activity log, Log book) · **Tasks** (its own strip of task screens) · **Settings** (Settings, Profile, Business hours, Features, Outlets, Service settings, Discounts & offers) · **Users & access** (Users, Roles & permissions) |
| Platform | Restaurants · Businesses (the platform's own logins only) |

- Only the group you are in is open; click another group's title to pin it
  open (remembered in this browser). **Jump to…** at the top finds any page
  by name, tabs included.
- **Quick access** keeps up to five favourite pages above the menu (**Set
  up**, pick, arrange with the arrows, **Save shortcuts**). It belongs to your
  login on this browser, so everyone on a shared till has their own; each
  business you open in Business Admin keeps its own set too.
- **The outlet picker** appears when the restaurant has an active outlet and
  you may see outlets and are not tied to one. Changing it reloads the page.
  From then on every order, bill, stock movement, report and dashboard figure
  is for that outlet; *All outlets* is the whole restaurant. Staff tied to one
  outlet in **Users** always work there. A closed outlet leaves the picker; a
  device still set to it is put back on *All outlets* with a notice.
- **The bell** gathers what needs a person now — unpaid bills, stock running
  out, a day left open, late deliveries, purchase orders waiting for approval,
  log-book follow-ups and, for owners and managers, **theft control** (voids,
  refunds, big discounts, reprints, dishes taken off after the KOT, a drawer
  closed short). It checks again as soon as something changes in the
  restaurant (at most every 20 seconds) and at least every minute while the
  tab is visible; you see only alerts from screens you can open, and an alert
  disappears once its cause is fixed. **See all notifications** opens the full list with filters.
  Where the bell draws its lines (a large discount, a late delivery or
  booking, a long break) is set in Settings → Alerts and timings.
- **On a phone** the sidebar becomes a menu button in the top bar; tap
  outside the menu to close it.
- **Live screens.** The kitchen display, the POS, table requests, the pickup
  screen, deliveries, the dashboard, reservations, *Tables & QR*, the time
  clock, *My tasks* and the bell change by themselves within a second or two
  of a change made on any device: a KOT sent from a till, a guest's call, an
  online order, a paid bill freeing its table. A small **Live** beside the
  title (or on the screen's own Live button) says so. **Reconnecting** means
  the device lost its connection to the server for a moment: it comes back by
  itself and catches up, and most screens still read again every minute
  meanwhile. If a screen stays on *Reconnecting* or *Not live*, check the
  device's Wi-Fi, then ask whoever runs the server.

## Lists: the data grid

Almost every list in the application is the same grid, so it works the same
everywhere:

- **S.No.** is the first column, numbered in the order shown and continuing
  across pages (page 2 at 25 a page starts at 26).
- **Paging:** 25, 50 or 100 rows a page (*Rows per page*), with first,
  previous, next and last. Big lists — orders, bills, expenses, stock
  movements, activity log, guests, feedback, complaints, log book, table
  requests, past business days, rider cash, transfers, advances — are paged
  by the server and show the true total; their money totals may say *This
  page*. Lists that grow open on today or the current month, with a date
  range for older records.
- **Sorting:** click a heading for ascending, descending, then the list's own
  order. Numbers, money and dates sort by value; "Table 9" comes before
  "Table 10". On a phone use *Sort by*.
- **Search and filters:** the search box looks through the text columns
  ("120" also finds "₹120"). **Filters** adds a filter under the columns that
  have one.
- **Columns:** *Show columns* hides or shows columns (the name and actions
  columns stay); drag a column edge to resize it, double-click to fit;
  *Comfortable* or *Compact* rows; *Reset layout*. Columns cannot be moved.
  Widths, hidden columns, row height and rows per page are remembered **per
  person, per list, in this browser**.
- **Export:** **Export CSV** downloads S.No. and the visible columns of every
  row that passes your filters, money as plain numbers and dates as
  YYYY-MM-DD. There is no Excel or PDF export; the browser's print (Ctrl+P)
  prints the filtered rows as a plain table.
- **Who may export:** in the restaurant, anyone who can open a list may
  export it, **except guest data** (Customers, Feedback, Complaints, Guest
  insights), which needs *Export guest lists* (`customers.export`) and is
  written to the activity log. In other businesses every export needs that
  area's export permission (for example `catalog.export`, `reports.export`).
- On a phone a list becomes cards.

---

# Part 2 — The restaurant

## Dashboard

The screen a manager leaves open all day. Its figures update by themselves as
the day's business happens (within about ten seconds of a bill, an order or a
booking on any device, **Live** beside **Updated … ago**), and at least every
minute while the tab is visible; click **Updated … ago** to refresh now. It
works in **business days**, not calendar days — a kitchen still serving at
00:30 is on yesterday's sheet, and the header says so.

**Takings are only for people allowed to see them.** Sales, the cash drawer
and money owed appear only for roles with *See takings and sales figures*
(`sales.view`). A captain or the kitchen sees guests, running orders,
tables and dishes counted in plates instead. The server leaves the figures out
of its answer; it is not just the screen hiding them.

**Header buttons:** *Full analysis* (Reports), *Open day* / *Close day* (the
dialog opens on the dashboard), *New order* (while the day is open). Banners
warn when orders are blocked because no day is open, when a counter's day was
left open from an earlier date (in red, with *Close day* for each counter),
when one outlet is selected, and when this device is set to an outlet that
has closed.

**Tiles:** *Sales today* (against the same weekday a week earlier, up to the
same time), *Bills* (with dine-in guests served), *Orders today* (split into
dine-in, takeaway and delivery, each with what it billed) — or *Guests served
& seated* without `sales.view` — then *Running orders* and *Tables in use*
(not in a bakery or cloud kitchen). A plain click on a tile or a row opens its
detail in a panel over the dashboard, with **Open full page**; Ctrl-click
(Cmd-click on a Mac) opens the full screen in a new tab.

**Needs attention** lists what is waiting on a person, worst first, each row
opening exactly what it counted: orders left open from earlier days, unpaid
bills, bills on account, kitchen tickets running late, late deliveries, items
out of stock, QR orders to accept, unanswered table calls, late bookings,
staff late for a shift, items running low, open complaints, missing
clock-outs, expenses to approve and purchase deliveries due. You see a row
only if you can act on it. **Log book follow-ups** that are still open sit
beside it.

**Live service** has one card per area — Pre-orders (when that feature is
on), Floor, Kitchen, Reservations today, Table requests, Deliveries, Staff on
duty, Stock, Guests (with birthdays) — each shown only to roles that can open
that screen. Floor, kitchen, reservations, requests and deliveries follow the
selected outlet; staff, stock and guests always cover the whole restaurant,
and so do pre-orders, except for staff tied to an outlet, who see that
outlet's. Pre-orders are read when the page opens; the other cards arrive in
one request, and a card that fails keeps its last figures while the others
load.

**Today's trading** (with `sales.view`) covers this business day only; the
week and the month are in *Full analysis*. **Money in** by payment method
(with earlier days' dues collected today) and what the drawer should hold
(opening cash, cash sales, refunds, expenses — for *All outlets*); **Through
the day**, hour by hour with the busiest hour; **Items**, best sellers and
slowest; **Money out**: discounts, refunds, bills voided and expenses.
Without `sales.view` it shows the items sold, in plates, and the orders taken
by type. By design there is no food-cost card; dish costs are in Reports →
Dish profitability.

## Service — POS, orders, kitchen, captains, requests

In the menu: **POS**, **Captain app**, **Orders** (with Table requests) and
**Kitchen display** under Daily work; captain sections on **Tables & QR**.

```
Seat or take order  →  POS: build the cart  →  Save & print KOT
                                                   │
                            add more ←─────────────┤
                                                   ↓
                       Raise bill  →  Take payment  →  Print receipt
```

### POS

The till. Pick a category or search, tap a dish, and it goes into the cart. A
dish with sizes, add-on groups or combo choices opens a picker first; required
choices ("Choose one main", "Choose two sides") must be made. Set the **order
type** — dine-in (table and guests), takeaway or delivery, as many of them as
the restaurant takes (Service settings → Orders the POS takes) — and attach a
known guest by name or mobile, which is what makes loyalty, dues and saved
delivery addresses work.

- **Prices are never worked out in the browser.** The cart is an estimate; the
  server prices the order from the menu, the outlet, the service and the
  channel (happy hour, packaging charges and serving times included).
- **Save & print KOT** saves and prints only the new kitchen tickets that save
  created — one slip per station; on a saved order the button reads **Print new
  KOTs**. The till never reprints a ticket the kitchen already has, so nothing
  is cooked twice.
- **Courses:** on the captain app a dine-in table's dishes can be held as a
  later course (see Captain app below); held dishes stay off the kitchen
  tickets until **Fire course 2** (or 3) is pressed on the saved order, here or
  on the captain app. The till itself sends every dish when the order is sent.
- **Captains** see *My tables* first when picking a table (see Captain
  sections below); they can still switch to *All tables*.
- **Moving and joining:** an order can move to another table, be joined with
  another table, or have some dishes moved; the kitchen gets a *TABLE CHANGED*
  slip for tickets already printed.
- **Nothing can be sold until the business day is open.** The buttons are
  disabled and a banner says to open the day first (Daily work → Business
  day).

### Orders

The list of everything taken, opening on today (older days through the date
filter or *All days*), paged by the server. An open order can lose a line or
be cancelled with a mandatory reason.

**Once the kitchen has a dish** (its KOT has gone), taking it off — here, or by
lowering the quantity in the POS — asks why (guest changed their mind, wrong
order, took too long, quality complaint, other). It needs *Reduce or remove
dishes the kitchen already has* (`orders.cancel_after_kot`); anyone without it
asks a manager for their PIN. If the dish was already cooking, ready or served,
its ingredients are recorded as wastage. Every such removal is on **Reports →
Theft control**, and the kitchen gets a **CANCEL** slip.

### Kitchen display

**Daily work → Kitchen display** shows every ticket by station with a running
clock. A ticket appears within a second or two of a till or a captain sending
it, and a change or cancellation just as quickly; **Live** on the toolbar says
so (tap it to read the board now). Cooks move tickets on — **Start cooking →
Mark ready → Served** (and back if tapped by mistake) — with `kot.manage`; a
screen with only `kds.view` watches without buttons. A ticket marked ready
also shows on the **Captain app**'s *Ready* tab, where the waiter who carries
it out marks it served. The toolbar has
**All-day** (how many of each dish are still to cook), **Recall** (the last
served ticket, up to 3 hours back), **Change slips**, **Sold out** (mark a dish
sold out for today), a chime, and **Focus** (full screen for a wall TV).
**Clear old tickets** (older than 1, 2 or 4 hours) needs both `kot.manage` and
`orders.manage`. A kitchen at one outlet sees only that outlet's tickets.

**Stations & routing** (for `menu.manage`): the **Stations** (tandoor, wok,
bar…; one is the default and cannot be switched off until another is),
which station cooks each **category**, **dish exceptions**, the **kitchen
timers** (amber after the warning minutes, red after the late minutes, and
food left at the pass flagged after 8 minutes unless you change it) and
**Names on KOTs**.

**Kitchen names.** A kitchen name is a second name for a dish, a size or an
add-on, written in the cooks' own language or script. Type it in Menu →
Products (*Kitchen name*), in the product's sizes, or in Menu → Modifiers.
Kitchen tickets, the board and change slips use it; bills, receipts and the
guest menu always keep the menu name. **Names on KOTs** chooses *Both* (the
default: kitchen name large, menu name small), *Kitchen name* or *Menu name*.
A ticket keeps the names it was printed with.

**Change slips.** When a dish on a **printed** ticket is taken off or reduced,
the order is cancelled, or the party moves or joins another table, the till
prints a slip for each station affected — **CANCEL**, **ORDER CANCELLED** or
**TABLE CHANGED** — with the reason, who did it and the approving manager.
Each slip prints once; a second print says REPRINT; a slip that could not print
waits in the board's **Change slips** list. Tickets never printed or already
served get no slip.

### Captain sections

**Tables & QR → Captain sections** is the day's plan of which captain
looks after which **floor**, **section** (a dining area) or single **table**.
The most specific line wins (a table given to Priya inside Ramesh's floor is
Priya's). Each place has one captain a day; **Save plan** replaces the whole
day; **Copy yesterday's plan** starts a new day (refused if today already has
a plan). Plans do not carry over by themselves.

What it changes: captains see *My tables* first in the POS and in the
**Captain app**, whose calls and food at the pass follow the same tables;
**Table requests** are tagged *Your table* or *Priya's table* with a captain's
own first; the tables list gets a *Captain today* column; and Reports → Staff
& waiters has *By captain section*. Sections never block anyone from serving
any table. With **Captain sections** switched off (Settings → Features) no
table is anyone's and every captain sees every table; the plans are kept for
when it is switched on again. Viewing needs `tables.view`, changing needs
`tables.manage`. Anyone whose role can take orders is offered as a captain, so
cashiers and managers appear too.

### Table requests

**Orders → Table requests** is the captain's inbox for guests' phones: orders
and calls (waiter, bill, water) from the QR code on each table, and orders
from the restaurant's own **online ordering page**. **Nothing is cooked until
someone accepts it.** Waiting requests come first, oldest first, with a clock
that turns amber and then red. A guest's order or call appears within a second
or two (**Live** in the header), with a chime when the sound is on.

Its **QR ordering** window (the settings button) switches *Guests can order
from the table* and *Guests can call staff* on or off, sets a note shown at
the top of the guest menu, and opens *See what guests see* for any table
(*Open guest menu* opens it where the table's QR code does: at the
restaurant's own [guest web address](#guest-web-address) when it has one);
changing it needs `orders.manage`. With ordering paused, guests can still
read the menu and call staff.

### Captain app

**Daily work → Captain app** (the address `/captain`) is the waiters' own
screen, made for a phone held in one hand at the table. It is part of the
staff app, not something to install: a captain signs in on their phone, opens
it, and adds it to the phone's home screen; the address keeps working as a
bookmark, and signing in from it comes back to it. It has a header of its own
(the restaurant, who is signed in, **Live**, the alerts bell, the lock and a
**⋯** menu) and three tabs at the thumb:

- **Tables** — the tables of the captain's section today (*My tables*, from
  **Tables & QR → Captain sections**), or every table with *All tables*;
  someone with no section today sees every table. Each table says at a glance
  what is happening there (free, eating, bill printed, paid, being cleaned,
  held for a booking, out of service) and what is waiting: a guest calling
  (*Wants a waiter*, *Asked for water*, *Needs something*), *Wants the bill*, a
  *QR order waiting*, *Food ready* (red once it has waited at the pass longer
  than the kitchen's pass time), the order *Sent* or *Cooking* in the kitchen,
  and how many guests are seated and for how long. The running total shows
  only to someone who may see takings (`sales.view`). A tap opens the table:
  its order, guests and how long they have sat, what the kitchen is doing,
  the calls, QR orders and food waiting there (each answered on the spot), and
  what your role may do with the table — **Start order**, **Open order**,
  **Bill**, **Take payment** or **Open bill**, **Reprint**, **Mark ready**,
  **Seat booking**, **Seat walk-in** or **No-show**: the same actions, by the
  same permissions, as the dashboard's Floor panel.
- **Calls** — guests' calls from the QR codes at those tables, the longest
  waiting first: **On my way** (the guest's phone shows someone is coming) and
  **Done**; and their QR orders: **Accept** (to the kitchen and the bill) or
  **Reject** with a reason the guest reads. Orders from the online ordering
  page have no table: the counter takes them under Orders → Table requests.
  The tab shows while QR ordering is on.
- **Ready** — the food the kitchen has marked ready for those tables, the
  oldest at the pass first, with how long it has waited. **Served** takes the
  ticket off the pass in the captain's name, as the kitchen display's *Served*
  does, and its dishes are served on the order. The tab shows while the
  kitchen display is on, to roles that handle KOTs (`kot.manage`).

**Taking an order** opens the POS itself in its phone layout, on the table
tapped: dishes by category or search, sizes, add-ons and combo choices in the
picker with a note for the kitchen, the guest's mobile, *Guests*, and
**Send**. Everything the POS checks is checked here: what is on sale and sold
out, serving times, the price of the hour, a table held for a booking, a dish
the kitchen already has, the business day. Two things are the captain app's
own:

- **Send to the kitchen** — *Now*, *Course 2 later* or *Course 3 later*, for
  a dine-in table. Dishes added under a later course wait on the order, marked
  *Course 2 · held*, until **Fire course 2** is pressed on it; they then reach
  the kitchen as a round of their own, in the name of whoever fired them.
- **Add a note** on a dish just added gives it a note for the kitchen ("less
  spicy") without opening the dish again. A dish the kitchen already has keeps
  the note it was sent with.

Moving guests, joining and unjoining tables are in the order's *Move or join
tables* menu, as on the POS. **Send** saves the order (its KOTs reach the
kitchen display at once) and goes back to the tables; **Tables** goes back
without saving.

**The bill** follows the POS's rule. Someone who may raise bills
(`billing.manage`) presses **Bill** on the table: the order's bill opens in
the same bill window as the POS, where it prints and, only for someone who
may take payments (`payments.manage`), takes the payment. A captain without
the billing permission is told *The counter raises the bill when the guests
ask for it*; once the counter has raised it, the table shows *Bill printed*
and **Open bill** shows the bill as the guest sees it, to print at the table
(the first copy; a second needs `bills.reprint` or a manager's PIN). Taking
the money stays at the counter.

**Alerts.** Everything arrives by itself within a second or two (**Live** in
the header), and a message names the table. The bell in the header switches
alerts on for this phone: from then on a call, a QR order or food at the pass
at the tables shown also buzzes the phone (where the browser can) and chimes.
The choice is kept on the phone; the first tap after opening the app lets it
chime again.

**Lock and PIN** work as on the POS: the lock button, or the idle time set
under Users (*Till lock & sign-in*), locks the phone; the captain carries on
with their PIN, or someone else takes over with theirs and the app starts
fresh for them. The **⋯** menu has *My profile, password & PIN*, *The full
staff app*, *Lock / switch user* and *Sign out*.

**Giving a waiter the captain app:**

1. Under **Users**, make their login with the **Captain / Waiter** role (take
   orders, KOTs, the tables and reservations; no billing and no takings), or
   any role that can take orders (`orders.create`).
2. Set their PIN under Users (⋯ › *Set PIN*), or let them choose one under
   *My profile › Personal PIN*: it unlocks the phone and lets another waiter
   take over a shared phone.
3. Each day, give them their tables under **Tables & QR → Captain
   sections** (*Copy yesterday's plan* makes it quick).
4. On their phone they sign in, open **Daily work → Captain app** and add it
   to the home screen.

For the bill at the table as well, give their role *Create bills and apply
discounts* (`billing.manage`); to take the money there too, *Take payments*
(`payments.manage`).

## Billing, payments, dues and advances

### Raising a bill

In the POS press **Bill & pay** (or **Save & bill** with unsaved changes;
needs `billing.manage`). The order is saved and one bill is raised for
everything not yet billed; an order already billed opens its existing bill —
a second bill is never raised. Prices, GST, service charge (only on the order
types ticked in Settings) and the delivery charge (on the order's first bill)
are the server's. The bill carries the outlet's own GSTIN and FSSAI number if
it has them, otherwise the restaurant's, **frozen when the bill is raised**.
There is no split-bill button; use **Move dishes** in the POS to put dishes on
another order and bill each.

### Changing an unpaid bill

The chips on the bill window, each checked by the server first (if a manager
is needed, the PIN prompt opens before anything is sent):

- **Coupon** — the code is checked against its dates, usage limit, minimum
  order (on the subtotal before tax), order type, weekdays and hours,
  *once per guest*, chosen dishes or categories, and buy-X-get-Y quantities;
  the refusal says why in words.
- **Points** — when loyalty is on and an attached guest has points, within the
  fewest points to use, the most points on one bill, and the most of a bill
  points may pay. Expired points are removed first.
- **Discount** (a till discount) — whole bill or some dishes, % or ₹, with a
  **reason** from the list (Other needs a note). Needs *Give an on-the-spot
  discount* (`bills.discount`) and stays within the role's cap (Settings →
  Discounts at the till). Someone **with** the permission who goes over their
  cap is refused and told who can give that much; someone **without** it gets
  the PIN prompt, and the approving manager must be allowed that much too.
- **Service charge** — voluntary; take it off with a reason (its GST goes
  too). **Delivery charge** — waive with a reason and
  `orders.waive_delivery_charge` or a PIN, on its own.
- **No charge** (complimentary) — every dish at 100 % off with a reason (staff
  meal, owner's guest, complaint, tasting, promotion, other). Needs
  `bills.complimentary` or a PIN, no money may be paid yet, and the bill can
  never change again. Ingredients still leave stock.
- **Company GSTIN** — puts a registered buyer on the invoice (B2B).
- **Lowering a bill that has already been printed**, by any change, needs
  `bills.discount` or a PIN — the "print, take cash, discount, pocket the
  difference" guard. A change can never bring the total below what has been
  paid.

### Taking payment

**Take payment** (`payments.manage`; an open business day is needed): **Cash,
Card, UPI, Other**, and **Advance** when the guest has money held. If the
owner has named **payment types** under a method (Pluxee under Card, PhonePe
under UPI, Cheque under Other), pick the type; some require a reference.

- **Cash given** shows the change. A bill can be paid in parts and by several
  methods; it shows *Part paid* until settled. You cannot overpay — anything on
  top is a tip.
- **Tip** — "On top of the bill, for the staff". Never sales, GST, discount
  base or points; not allowed on an advance; a cash tip comes out of the cash
  handed over.
- **UPI QR** — with a UPI ID set (Settings, or the outlet's own), a QR for
  exactly the amount appears; when the guest's app shows paid, type the UTR and
  take the payment. **The system does not confirm UPI by itself.** The printed
  bill also carries a QR for the amount still due.
- **On account** — for a regular or a company that settles later: pick the
  account and put the amount on it. Needs `customers.credit` or a PIN; refused
  for a guest with no account, an account on hold, or one that would go over
  its limit. The table is freed.
- **A bill over ₹2,00,000** (a banquet, a party, a caterer's order) shows
  *Buyer's PAN needed* and asks for the buyer's PAN in the payment form, or a
  tick that they have no PAN and signed a declaration (Form 97). No payment
  goes through without one: the PAN goes on the bill with the payment, or
  press *Record on the bill* to record it alone, for a bill to be collected
  later on an account. A company's GSTIN on the bill carries its PAN, and
  that PAN goes on the bill with its first payment. *Change* replaces a PAN
  until the bill is settled; the bill prints it.
- **The cash limit** — no bill takes ₹2,00,000 or more in cash, and no guest
  pays that much in cash in a day (Income-tax Act 2025, section 186). On a
  bill over ₹2,00,000, or one owing more than cash may still pay, the payment
  form says *In cash, at most ₹… more*: for this bill, and from its guest
  today (their cash on other bills and their cash advances count). A cash tip
  counts with its payment. Typing more cash shows *More cash than the limit
  allows* with a button to take the most allowed; a cash payment that would
  reach the limit is refused, and the reason shows above *Take*. Take the
  rest by UPI, card, bank transfer or cheque. A walk-in bill with no guest
  chosen is limited bill by bill.
- When the bill is fully paid the guest earns points, and it can print by
  itself (Settings → Printing).

### Printing

**Print bill**; every print is counted. Later copies print **DUPLICATE** and
need `bills.reprint` (cashiers have it) or a PIN; reprints are on theft control.
The heading is *Tax Invoice* with a GSTIN, otherwise *Bill*, or *Bill of
Supply* for a composition restaurant (*Document type* in Settings → Printing).
A bill carrying the buyer's PAN prints it (*Buyer PAN*), or that their Form 97
declaration is held.

### Corrections, refunds and voids

| | When | Needs |
| --- | --- | --- |
| **Correct** a payment | Keyed as cash, really UPI — only while that payment's business day is open. Only the method, type and reference change; the bill, GST and sales do not. A cash payment that gave change stays cash; advance payments cannot be switched. A correction to cash that would reach the cash limit (₹2,00,000 for the bill, or from its guest that day) is refused before anyone is asked for a PIN | `bills.payment_correct` or a PIN tied to that payment, amount and the two methods, plus a reason |
| **Refund** (Bills & payments only) | Money was taken and is going back. On a settled bill it is a **credit note** — an amount, or dishes returned — that takes the value and its GST off the sale (and, if ticked, the points earned). On an unsettled bill it hands a payment back and the guest owes it again | `bills.refund` or a PIN for that bill and amount, a reason, an open day |
| **Void** (Bills & payments only) | The bill should never have existed: only an unsettled bill with **no money held** and not on an account. The order opens again; the coupon use and points go back | `bills.void` or a PIN, **every time**, plus a reason |

A settled bill can never be voided — refund it instead. That is deliberate:
it is what stops takings quietly disappearing. After the day has closed, a
wrongly keyed payment is fixed by refunding and taking it again.

### Bills & payments screen

**Daily work → Bills & payments**: tiles for sales today, collected today, still
to collect, discounts given and refunded today, then tabs **Bills** (opens on
today; search, a status or an order link searches every day), **Credit notes**
(`sales.view`) and **Payment corrections** (`sales.view` and `audit.view`).
Opening a bill shows the same bill window as the POS, plus refund and void.

### Dues & accounts

**Daily work → Dues & accounts** (`sales.view`) is money owed by regulars and
companies. **Open an account** (`customers.credit`) for a guest from the guest
book with a **credit limit**, **days to pay** (default 30) and a status
(Active, or On hold — no new bills). Tabs:

- **Accounts** — owing, overdue or all, aged 0–30 / 31–60 / 61–90 / 90+ days,
  with **Statement** (debit, credit, running balance; print or download) and
  **Collect** (`payments.manage`): money goes onto the oldest bills first, into
  the open business day of the till taking it; you cannot collect more than is
  owed. Cash collected is the account holder's cash for the day: a collection
  that would take it to ₹2,00,000, or a bill to ₹2,00,000 in cash, is refused
  whole. A bill over ₹2,00,000 is collected only once the buyer's PAN (or
  their declaration) is on it: open the bill and *Record on the bill* first.
- **Unpaid, no account** — bills guests left owing and bills carried over at a
  day close.
- **Advances** — below.

### Advances and deposits

Money taken ahead for a party, a bulk order or a booking: **not a sale yet**;
it becomes one on the bill it pays. **Take an advance** (`payments.manage`, an
open day): guest or company, amount, how it was paid, what it is for; each gets
a receipt number (ADV-0001). An advance in cash counts toward the guest's cash
limit on the day it is taken (₹2,00,000 from one guest in a day), and toward
the cash of the bill it pays; it is not counted again when used. Use it by
choosing **Advance** when taking payment. **Hand back** needs
`advances.refund` or a PIN for that advance and amount, a reason and an open
day. The *For the GST return* card gives GSTR-1 tables 11A (received, not yet
billed) and 11B (billed this period, received earlier) for the accountant.

**Pickup orders paid ahead**: on *Orders*, an open takeaway not yet
billed has *More › Take advance…*. The guest on the order (or the guest you
choose, who is then put on the order) pays now; the receipt says "Pickup order
ORD-…". Opening the order shows *Paid ahead*. When the bill is made at pickup,
*Advance* is already chosen with that advance and the amount due; take the rest
as usual. If the order is cancelled, the advance stays held and is handed back
from Dues & accounts › Advances like any other.

## Reservations and online booking

**Operations → Reservations** holds bookings, the walk-in waitlist and online
booking requests. View it as a **Timeline** (one row per table) or an
**Agenda** (filters: All, Online requests, To arrive, Seated, Completed,
No-show / cancelled). A booking made, a guest seated or a table freed on another
device shows by itself.

A booking moves *Booked → Confirmed → Seated → Completed*, or ends as
No-show, Cancelled or (for an online request) Declined.

- Bookings must fall within **Business hours**, the last one 30 minutes before
  closing by default (*Last seating before closing*, Settings → Alerts and
  timings); a time up to 15 minutes in the past is accepted, so a host typing
  a booking in late is not refused. Up to a year ahead, 1–50 guests, 30–360
  minutes at the table (90 by default).
- **No double booking:** a table booked, confirmed or seated for an
  overlapping time cannot be booked again. A party bigger than the table needs
  *over capacity* ticked with a note.
- **Several tables:** pick the main table, then **Join more tables** (up to 9
  in all); each is checked for clashes. Seating at the main table joins the
  others to its order; seating elsewhere releases them.
- **Seating** opens the table's order, so it also needs `orders.create`; only
  today's bookings, with the day open, at a table with no open order. A
  seated booking **completes by itself** when its bill is settled.
- **No-show** only after the booking time; a no-show who turns up can still be
  seated.
- Guests' mobiles are masked for staff without `customers.contact`.

**Walk-in waitlist:** **Add walk-in** (name, optional mobile, party, quoted
wait). **Seat** opens the order; **Table ready** only records that the guest
was told (no SMS is sent); **Left without a table** and **Remove (added by
mistake)**. The bell warns when a guest has waited longer than quoted.

### Online booking

**Online booking** (in the Reservations header) sets up the public booking
link for the main counter and for each outlet. Guests open
`<guest web address>/book/<link>`, choose party size, day and time (every 30
minutes within Business hours, or the step set under Settings → Alerts and
timings), give a name and mobile and send a **request**. They never see
tables. Their status page shows *Request received*, then *Your table is
confirmed* or your polite reason for declining. No SMS is sent.

| Setting | Default | Limits |
| --- | --- | --- |
| Take bookings online | Off | needs Business hours and at least one table in use |
| Largest party online | 8 | 1–50; bigger groups are asked to call |
| Seats online guests may fill | 70 % | 10–100 % of the seats, waiting requests included |
| Notice needed | 60 min | 0–1440 |
| Book up to | 30 days | 1–180 |
| Table time planned | 90 min | 30–360 |
| Open bookings per mobile | 2 | 1–10 |
| Days closed to online bookings, Note for guests | — | 60 dates, 300 characters |

- Requests appear in **Online requests** at the top of Reservations.
  **Accept** with a table (checked like any booking, up to 9 tables) or
  without one (confirmed, table given later). **Decline** needs a reason — the
  guest reads it. A request nobody answered by its time is declined for you;
  one whose time has passed cannot be accepted.
- A guest can cancel from the status page until the booking time.
- **Make a new link** kills every copy of the old one at once (printed cards,
  Google, Instagram); guests already booked keep their status pages. *Copy*,
  *Open* and *Download QR* are in the same window.
- Permissions: seeing it `reservations.view`; settings and new links
  `reservations.online` (owners and managers); accepting and declining
  `reservations.manage`.
- Spam limits: 5 requests per mobile an hour, 30 per network and 40 per link
  every 10 minutes.
- New online requests do **not** ring the bell; watch the *Online requests*
  card. Booking times follow the restaurant's Business hours even on an
  outlet's link.

## Online ordering, tokens and the pickup screen

### Your own online ordering page

**Settings → Service settings → Online ordering page** has one card for the
main counter and one for each open outlet, each with its own link
(`<guest web address>/online/<link>`), **Switch on/off**, **Copy link**,
**Open** and **New link**. Guests order takeaway or delivery with no
commission to anyone.

- Settings per link: which of Takeaway / Delivery guests can order, ready in
  (5–180 min, default 20), delivered in (10–240, default 45), minimum for
  delivery, open orders per mobile (default 2), where you deliver, a note.
  New links start switched off.
- A link can only be switched on while the **Website** sales channel is on
  (Deliveries → Channels) and its outlet is open. The page refuses orders while
  you are closed (that outlet's hours), while no business day is open, or while
  the link is off.
- Prices are always the server's — the Website channel's prices, packing
  charges and offers. Payment is **pay at collection** or **cash on
  delivery**; online payment says *Coming soon* until a payment gateway is
  connected.
- Limits per order: 30 dish lines, 20 of one dish, 60 items; delivery needs an
  address and meets the minimum. 5 orders per mobile per 30 minutes.
- **Orders arrive in Table requests** and nothing reaches the kitchen until
  someone presses **Accept** (`orders.create`). Accepting makes a normal
  takeaway or delivery order on the Website channel at that outlet, adds the
  guest to the guest book, fills in the address and promised time, and applies
  the Website channel's delivery charge.
- The guest follows the order on a status page (*Sent, Accepted, Ready, Out
  for delivery, Delivered* or *Ready for pickup, Collected*) and can cancel
  only until the restaurant has picked it up.
- **New link** works as for booking: the old link stops at once.
- Service settings opens for roles with `orders.manage` (owners, managers and
  cashiers), and they are the ones who see, copy and change the links.

### The guests' site

Everything guests open on their phones is the **guests' site**: pages of
their own, apart from the screens staff sign in to. Nobody signs in there,
and a guest never reaches a staff screen.

| The guest opens | Address | What they can do |
| --- | --- | --- |
| A table's QR code | `<guest web address>/order/<table code>` | Read the menu, send an order (it waits in **Orders → Table requests** until accepted), *Call waiter*, *Request bill*, *Water please*, and leave feedback |
| The online ordering link | `<guest web address>/online/<link>` | Order takeaway or delivery and follow the order on its status page |
| The booking link | `<guest web address>/book/<link>` | Ask for a table and follow the request on its status page |

- The site's own address, or a link with part of it missing, never says "Page
  not found": it asks the guest to scan the table's QR code or open the
  restaurant's link again (*Order or book from your link*, *This link isn't
  complete*).
- The guest pages still to come (`/shop`, `/appointments`, `/account`)
  answer with *Coming soon* and what to do until then ([Part
  6](#not-built-yet-what-to-do-meanwhile)).
- A table's QR code or a link that opens on the staff application's address
  is passed on to the guests' site, with the rest of the link kept.
- Once the restaurant's privacy notice is published (*Settings › Personal
  data*), each page that takes a guest's name and number says what they are
  for and whom to ask, with the whole notice a tap away. An online order
  asks for a mobile for its updates, and lets the guest tick *my bill on
  WhatsApp* and *offers*; what they tick is recorded as their consent, given
  online, when the order is accepted. The pages say the guest's details are
  kept on their phone for the next order, with *Forget them on this phone*.

### Guest web address

**Settings → Service settings → Guest ordering web address** is the internet
address guests' phones open (for example `https://order.myrestaurant.in`).
Table QR codes, online ordering links and online booking links are all built
from it. Left empty, they use the platform's own guests' site; on a computer
running the platform at a local address that is somewhere phones cannot reach
(a red warning says so), so set it before printing anything. An address set
here that is itself a local one gets an amber note: only phones on the
restaurant's own Wi-Fi can open it. Type the address alone (`https://…`, up to
200 characters, nothing after a `?` or `#`); *A table's code will open* shows
what a QR code will carry, and **Print QR codes** opens the printable sheets.
The card shows while QR table ordering or the online ordering page is on.
Changing it needs `tables.manage`.

### Token numbers and the pickup screen

**Service settings → Token numbers and the pickup screen**: **Give parcels a
token number** gives each takeaway, delivery or online order a short number,
restarting at 1 every business day and per outlet, printed large on the KOT.
**Orders → Pickup screen** shows two columns, *Preparing* and *Ready for
pickup* (token numbers only — no names or prices); a token turns up within a
second or two of the kitchen marking it ready, with an optional chime. Staff tap a ready token → **Yes, collected**
to clear it, or it leaves by itself after the minutes set. For a TV by the
counter, create a user with the **Collection display** role: it opens straight
on the pickup screen and can open nothing else. Website orders come in as
takeaway or delivery, so the *Takeaway / counter* and *Delivery* boxes decide
whether they get a token.

## Deliveries, delivery charge and rider cash

**Orders → Deliveries** follows every delivery from the pass to the door —
your own riders, Swiggy / Zomato and website orders — on a **Live board** in
three columns, *To dispatch*, *Out for delivery* and *Delivered today*, which
change by themselves as orders arrive and move on any device; each delivery
moves *Placed, Cooking, Packed, On the road, Delivered* (or
Cancelled, with a reason). Moving orders, assigning riders (active employees
in the delivery department, up to 12 orders a run; for an aggregator pickup
type the partner's rider name) and editing addresses need `orders.manage`.
The bell warns about packed food waiting more than 10 minutes, a rider out
more than 45 minutes and a delivery with no address (the minutes, and the
door-to-door promise of 45 minutes, are set in Settings → Alerts and
timings). Other tabs: **Channels**, **Rider cash** (for `payments.manage`)
and **Channel report** (for `reports.view` with `sales.view`).

**Delivery charge.** Each channel (Deliveries → Channels, changed with
`restaurant.settings.manage`) has a **Delivery charge** and an optional
**Free above**. The server adds it to delivery orders only, free once the food
total reaches *Free above*, with GST at the rate of the order's largest food
line. A delivery with no channel uses your first active own channel. A billed
order keeps the charge it was billed with. In the POS, **Waive delivery
charge** needs a reason and *Waive a delivery charge*
(`orders.waive_delivery_charge`, owners and managers) or a manager's PIN;
**Charge it again** needs only `orders.create`. Both are logged.

**Saved delivery addresses.** A known guest's delivery shows *<name>'s
addresses*; a new address can be kept as Home, Office or Other — up to 5 per
guest (a sixth replaces the one used longest ago). Only `customers.contact`
sees full addresses; others see the label and area but can still pick one.
Edit or remove them from the guest's history in Customers.

**Rider cash.** A rider's card on the Live board shows **Settle cash** when
they have delivered bills still unpaid. The window lists those bills, oldest
first; mark each **Cash** or **UPI**, type **Cash handed in** and **Settle N
bills**. Every bill is paid in one step into the open business day and the
cashier's drawer.

- Settling needs `orders.manage` and `payments.manage`, an open day, at most
  200 bills.
- The cash may be **less** than expected, never more (count again, or check
  which bills were paid by UPI).
- Cash on delivery counts toward the cash limit like any other cash: cash
  that would take a bill, or a named guest's cash that day, to ₹2,00,000 is
  refused and nothing is settled. Mark that bill **UPI** if the guest paid
  that way, or take it another way.
- A shortfall needs a reason and a choice: **He owes it** (stays on *Still owed
  by riders* until a cashier clicks **Handed over**) or **Write it off
  (manager)** (*Write off a rider's cash shortfall*,
  `deliveries.write_off_shortfall`, or a manager's PIN for that exact amount).
- The bills are marked fully paid even when the rider is short; the shortfall
  lives on the settlement, and the drawer expects that much less cash. Money
  handed over later counts in the drawer of the cashier who records it.
- **Rider cash** tab: *Rider settlements* for a business day and *Still owed by
  riders*.

## Restaurant — profile, outlets, hours, settings, payment types

Set up once, changed rarely. In the menu these are tabs of **Settings**
(Management).

**Profile** holds the restaurant's name, contact number, email and address.
A new name shows in the top bar and the business switcher at once (the
restaurant's business takes the same name, kept in its activity log). The
restaurant code is fixed once created. Its **Set-up checklist** ticks off
what a first bill needs — name, GSTIN, FSSAI number, logo, business hours,
payment types and a default tax rate — each linked to where it is filled in.

**Outlets** are branches. Pick one in the top bar and every report and the
dashboard show that outlet alone. Each outlet has:

- a name and a unique **code**, contact, address and status (Active, or
  Inactive = closed);
- its own **GSTIN** only if it is a separately registered branch (usually in
  another state) — empty means it files under the restaurant's;
- its own **FSSAI licence number** (14 digits; empty prints the restaurant's,
  with a warning that each premises should have its own);
- its own **order prefix** and **invoice prefix** (empty means a series worked
  out from its code), and its own **UPI ID** when it banks separately.

Each outlet has its own business day, cash drawers and number series. Whether
an outlet keeps its own stock is set under Stock → Items & stock → Stores.
An outlet that has recorded **anything** — sales, stock, money, business days
— is **never deleted**: *Remove…* offers to **close** it instead. A closed
outlet stops taking orders, bills and stock and leaves the top-bar list, but
its history stays in every report (*Read a closed outlet* beside the dates in
Reports, or *Read its reports* on the Outlets page). One with only users,
staff or tables attached can be deleted once they are moved; one with nothing
recorded is deleted outright. Staff tied to a closed outlet cannot record
anything until they are moved.

An outlet with **open pre-orders** (booked, in production or ready) is neither
closed nor deleted until they are handed over or cancelled in *Pre-orders &
cakes* ([BUSINESS_RULES.md › Pre-orders](BUSINESS_RULES.md#pre-orders)), and
the message names them. *Remove…* still offers to close or delete such an
outlet, and the refusal then shows at the top of the Outlets page; setting
*Status* to *Inactive (closed)* in *Edit* shows it in the dialog.

**Business hours** are the opening and closing times per weekday, up to three
service periods a day, including closed days. They drive the bell's "the day
has not been opened" alerts, online booking times and reservation limits.

**Settings** is the one to get right before going live, because it changes
what customers are charged. One **Save settings** bar saves the page, except
the two cards saved on their own.

| Setting | Why it matters |
| --- | --- |
| **Tax mode** | Whether menu prices **include** GST or have it **added** — the single most important switch. Changing it later does not re-price history |
| GSTIN, FSSAI, CGST + SGST split | Printed on bills; the GSTIN makes the bill a Tax Invoice and heads the GST pack |
| Currency, **time zone** | Which hour and day a sale belongs to on every report; use a place name such as Asia/Kolkata |
| **Service charge** % and *Charged on* | Charged on the dishes after discount, taxed at the food's rate, removable on request |
| **Order and bill numbers** | Prefixes, and *one series that never restarts* or **start again each financial year** (INV/26-27/0001 from 1 April; prefixes then at most 4 characters, the GST 16-character limit). Bills already printed keep their numbers |
| Auto-consume stock | Take recipe ingredients out of stock when a bill is made |
| **UPI payments** | The UPI ID and name for the QR on the till and the bill |
| Loyalty | Spend per point, point value and the fewest points to redeem (on or off is under Features); the full rules (caps, earn basis, expiry) are on Discounts & offers → Loyalty points |
| **Printing** | Paper (58 mm, 80 mm, A4), copies, header and footer, receipt logo (a web address), **document type** (Automatic, Tax Invoice or Bill of Supply with its composition declaration), print by itself when paid, table QR on dine-in bills |
| **Alerts and timings** | Where the bell, the boards and the lists draw their lines, each starting at the number this guide gives: a large discount (20 % of the bill or ₹1,000), reprints, a day closed short; the delivery promise and its warnings; a late booking, the last seating and the online booking step; the time clock (late, long break, overtime, how early it opens); regular, lapsed and new guests and big spenders; the reorder plan; and the notes listed in a cash count |
| **Discounts at the till** (saved on its own) | A % cap per role that holds `bills.discount`; empty means no cap; with several roles the highest cap applies |
| **Payment types** (saved on its own) | See below |

**Payment types** name the ways guests pay under each method — meal cards
under Card, PhonePe under UPI, cheques under Other — so their settlements are
totalled separately in the day summary. The method is fixed once created; a
type can require a reference; a type that has been used can only be switched
off, not deleted. Changes need `restaurant.settings.manage`.

The **delivery charge** is not in Settings: it is set per channel under
Deliveries → Channels.

**Personal data** (a tab of Settings, for the owner and managers) holds the
restaurant's privacy notice and contact, printed on every bill, credit note
and advance receipt and shown on the guests' site where it takes a name and
number; the guests' requests to see, correct or erase their data; and the
breach register. It works as a shop's does:
[Personal data](#personal-data).

## Features — switching parts of the restaurant on or off

**Settings → Features** (`/restaurant/features`). Not every restaurant wants
everything: one keeps a guest book and loyalty points, another never takes
bookings, a third has no deliveries. Each part below can be switched on or off
for the whole restaurant. Everyone can see the list who can see Settings;
**only the owner** can switch (permission *Manage restaurant settings*). The
**Format** card at the top (restaurant, café, bakery or cloud kitchen) sets
several of these at once; see Café, bakery and cloud kitchen.

| Group | Feature | What it covers | A new restaurant |
|---|---|---|---|
| Guests | **Guests & CRM** | The guest book, the guest box at the till, feedback, complaints, guest insights | On |
| Guests | **Loyalty points** (needs Guests) | Earning and paying with points; the earn and redeem rules stay in Settings → Loyalty | Off |
| Service | **Reservations** | Bookings, the waitlist, the online booking link | On |
| Service | **QR table ordering** | Table QR codes, guests ordering and calling from the table, Table requests | On |
| Service | **Online ordering page** (needs Guests) | Your own ordering web page | On |
| Service | **Deliveries & rider cash** | The Delivery order type, the Deliveries board, riders and their cash | On |
| Service | **Kitchen display (KDS)** | The kitchen screen. With it off, KOTs still print and orders work the same way | On |
| Service | **Captain sections** | Giving each captain a set of tables | On |
| Service | **Pre-orders & cakes** (needs Guests) | Cake and party orders taken ahead (with an advance while Advances & deposits is on), the bake list | Off |
| Service | **Brands (one kitchen, several names)** | Selling under several brand names, brand on orders, KOTs and bills, sales by brand | Off |
| Money | **Tips** | The tip box when taking payment; tips in the day's cash | On |
| Money | **Advances & deposits** | Money taken ahead, *From advance* when paying | On |
| Money | **Cash drawers per shift** | One drawer per cashier with its own count and X report. With it off the day uses one till | On |
| Money | **Coupons & offers** | Coupon codes and ready-made offers at billing | On |
| Back office | **Stock & recipes** | Stock items, recipes, purchasing, suppliers, transfers, waste | On |
| Back office | **Staff & payroll** | Staff records, shifts, attendance, the time clock, leave, payroll, sharing out tips, *My work* | On |
| Operations | **Tasks & checklists** | Tasks, checklists, templates and recurring tasks | On |
| Operations | **Issues** (needs Tasks) | Reporting and fixing issues | On |
| Operations | **Projects** (needs Tasks) | Projects with milestones and task lists | On |

**Always on** (not on the list): POS and orders, bills and payments, dues and
accounts, menu, tables, outlets, business day (and its cash in and out),
expenses, log book, reports, users and roles, settings and the activity log.
Outlets stay always on: a restaurant with no outlets already sees no outlet
switcher, and the Outlets page is where it adds its first branch.

**What switching one off does.** For everyone in the restaurant, at once:

- its menu entries go, and with them any quick-access pin to its pages (the pin
  comes back when the feature does);
- its pages say *"… is switched off. An owner can switch it on in Settings →
  Features"* instead of opening;
- its buttons go: with Guests off the POS has no guest box (a delivery still
  asks for a name and mobile, kept on that order only), with Deliveries off
  there is no Delivery order type, with Tips off no tip box, with Advances off
  no *From advance* and no advance on a pre-order, with Coupons off no Coupon
  on the bill, with Loyalty off no
  Points, with Captain sections off no *Captain sections* on Tables, with QR
  ordering off no QR codes, with Stock off no Recipe on dishes and add-ons;
- its dashboard cards and alerts, its report tabs (Dish profitability and Stock
  consumption are Stock; the Tips and Rider cash cards on the day-end report
  follow Tips and Deliveries) and its notification-bell alerts go;
- the server refuses its requests (a 403 that names the feature), so an old
  browser tab or a script cannot use it either; public pages say so to guests
  (a table's QR code: *"Ordering from the table is not available here"*; the
  booking link and the ordering page likewise).

**Nothing is deleted.** Guests, bookings, stock, staff records, advances and
their history stay exactly as they are; switch the feature back on and
everything is back. Stock keeps being taken off for what is sold while Stock is
off, so the numbers are right when it comes back.

**Needs.** Loyalty points, the Online ordering page and Pre-orders & cakes
need Guests; Issues and Projects need Tasks & checklists. A feature
that needs another shows *Needs …*; its switch stays off until that one is on.
A feature another one needs shows *… needs this* and cannot be switched off
until that one is.

**Before switching off**, the screen says what will be hidden (open complaints,
bookings still to come, guests holding points, purchase orders still open, tips
not yet shared out…) and asks you to confirm. It **refuses** when switching
off would leave money stranded, and says what to do first:

- **Advances & deposits** — an advance still holds money: use it on a bill or
  hand it back (Dues & accounts → Advances).
- **Deliveries & rider cash** — a delivery is out with a rider, a rider has not
  settled the cash for delivered bills, or a rider still owes a shortfall.
- **Cash drawers per shift** — a cashier's drawer is still open: count and end
  it (Business day → Drawers & cash).
- **Stock & recipes** — money is still owed to suppliers on their bills (pay or
  settle them under Purchases & suppliers → Returns & payments).

Every switch is written to the **activity log** (*Switched a feature on/off*,
with the feature's name and who did it). The same switches appear in
Business Admin under the restaurant's **Business settings → Restaurant
features**; they are the same records, and the same rules apply there.

**Loyalty in Settings.** Settings → Loyalty keeps the rules (spend per point,
point value, fewest points to redeem) and says whether Loyalty points is on,
with a link here; the switch itself is on this screen. Discounts & offers shows
the Loyalty points tab only while the feature is on, and the Offers tab only
while Coupons & offers is on (*Given at the till* is always there).

## Menu — Categories, Products, Modifiers, Tax rates, Happy hour

The menu drives the POS, the recipes and half the reporting. Build it in this order.

**Categories** group the menu and set the order dishes appear in at the till —
Starters, Mains, Breads, Desserts. Sort order here is what a cashier scrolls past a
hundred times a day, so it is worth arranging by how often things are ordered. A
category with dishes in it cannot be deleted.

**Products** are the dishes. Each has a name, short code, price, tax rate, food type
(veg, non-veg, egg), a photo, and an availability switch. The list opens on **On the
menu**; **Sold out** and **Archived** are a tap away (the tiles above the list double
as these filters), with **No recipe** (dishes on the menu with nothing in their
recipe, when Stock & recipes is on) and **All**.

Three things hang off a product and are worth understanding:

- **Variants** — sizes, priced as a difference from the base price. Half at −₹80, Full
  at the menu price. One is the default.
- **Modifiers** — add-ons and choices, priced or free. Extra cheese, spice level,
  no onion.
- **Recipe** — what the dish consumes from stock. This is what makes selling a paneer
  tikka take the paneer off the shelf. Without it a dish sells fine but the stock
  never moves.

A **combo** is a dish made of other dishes, and it costs what its parts cost.

**Sold out versus archived.** The *On sale / Sold out* switch takes a dish off the
till for today — the eighty-six list — and it sits right on the list, to flip mid
service. **Archive** (a dish's *More actions*) retires a dish: it leaves the menu and
is kept for past bills; *Bring back to the menu* returns it. Use *Sold out* for "we've
run out", not for menu changes.

**Prices & outlets** (a dish's *More actions*) gives a dish its own base price, or
hides it, at one outlet, on one sales channel or for one kind of order (dine-in,
takeaway, delivery, QR, online), with a packaging charge per item on takeaway,
delivery and online orders. The most specific rule wins: outlet first, then channel,
then kind of order. A blank price uses the menu price, sizes keep their price
differences, an active happy-hour price overrides these prices, and order lines
already saved keep their prices.

**Revise prices** is the yearly price rise in one step — "+8% on Starters and Mains,
rounded to the nearest ₹5" — with sizes moving by the same rule. Nothing is saved until
the preview has been seen, and if someone edits a price in the meantime the revision
stops rather than overwrite it. **Change history** (a dish's *More actions*, for those
who read the activity log) shows every edit, price change, sold-out switch and size
change, newest first, with the value before and after.

**Modifiers** are the add-ons themselves — each is a name and an extra charge, such as
Extra cheese at ₹40. They are created once here and attached to dishes from the product
screen, so changing the charge changes it everywhere. The list shows how many dishes use
each one, and deleting warns you first.

**Tax rates** hold the percentages, cess and HSN/SAC codes used for GST reporting, with
one marked as the default for new dishes. A new restaurant starts with four: *Exempt*
(0 %), *GST 5% (restaurant)* with SAC 996331, which is the default, *GST 18%* and
*GST 40%*; rename them, switch them off or add others here. Changing a rate reprices
every dish that uses it — but **bills already raised keep the rate they were charged
at**, so history stays correct. A rate in use cannot be deleted. A dish prints its
rate's code: once 6-digit HSN / SAC codes apply to the restaurant's invoices (its
PAN's turnover has passed ₹5 crore, [GST thresholds across your
businesses](#gst-thresholds-across-your-businesses)), now or from the next 1 April, a note
at the top says which and names each rate with a shorter code, or none, that a dish on
the menu is charged at, to edit.

**GST rate changes** (Menu) enters the yearly GST change ahead of its day, as a shop
does ([GST rate changes](#gst-rate-changes)): **New GST rate change**, pick the dishes
(by their tax rate now, category, HSN / SAC code or a name), the tax rate they move to
and the first day (the next 1 April to start with), **Preview** each dish's price and
GST then, give the reason and **Schedule**. A price that includes GST keeps its total
unless *Keep the price before GST instead* is ticked, which moves the dish's price and
its sizes with the rate (add-ons, happy-hour prices and the prices set for an outlet
or a channel stay). It takes effect on the
restaurant's own trading day: a night past midnight stays on the old rate until its
business day closes, and an outlet still on yesterday's day sells at yesterday's rates.
Each order line takes its business day's rate and the bill keeps it. Before the day a
change can be cancelled, whole or dish by dish, with a reason. A dish's **GST history**
(*More actions*) shows its changes; *Change history* shows them too, as edits made by
the person who entered them.

**Happy hour** sets price windows: a different price for selected dishes between certain
times on certain days, optionally only within a season. The POS applies the window
automatically when the order is taken.

- An end time earlier than the start means the window runs **past midnight**.
- Where two windows overlap, **higher priority wins**.
- Deleting a window returns those dishes to their normal price.

**Serving times & combo choices** (Menu → Products → More actions) controls the
days and times a dish can be ordered. With no periods it is available all day.
An overnight period belongs to its starting day. For example, Monday 22:00–02:00
includes early Tuesday morning. POS and QR orders enforce these times.

In the same dialog, add groups such as “Choose one main” or “Choose two sides”.
Choose the permitted dishes and sizes, portions and extra price. Fixed components
from the Combo editor are included too. The POS and guest QR menu require the
configured number of choices; each order saves the chosen components for billing
and ingredient consumption. Nested combos are not supported.

**Kitchen name** on a dish, size or add-on is the name the cooks read (see
Kitchen display above).

**Print menu** prints an A4 menu card for an outlet (or restaurant prices) and
a service (dine-in, takeaway, delivery), at the till's own prices for that
outlet and service — happy-hour prices are left out — with optional
descriptions, add-on prices and short codes. Dishes archived, in an inactive
category or not sold there are left out; the header carries the logo,
address and FSSAI number, and the footer says whether prices include GST.

### Import and export

*Import CSV* loads the menu from a spreadsheet and
*Export for import* downloads every dish in the same layout; *Import recipes*
loads recipe lines (dish, size, ingredient, quantity per plate, unit — grams
and ml are converted). Every import is CSV, up to 2,000 rows, and runs a
**check first**: each row is shown as New, Updated or Unchanged with old and
new values, plus every problem by row and column. Nothing is saved until you
press Import, and if any row has a problem nothing is imported. Empty cells
keep what is on file, so running the same file twice changes nothing. A new
dish without a GST rate gets the default rate, never 0 %; an import never puts
a sold-out dish back on sale; risky changes (veg marking, GST, a price moving
by more than half) are flagged. Imports need `menu.manage` and are written to
the activity log under the file's name. The same check-first import exists for
stock items, suppliers and guests.

## Tables — Floors & areas, Tables & QR

**Floors & areas** describe the room. A floor is a level or a building; an area is a
zone within it — A/C, Non-A/C, Terrace, Bar. Every table belongs to a floor, optionally
to an area.

**Tables & QR** has two views, and the toggle sits above the list.

### Floor view

The room drawn as the room, grouped by floor and then by area, with a legend that
carries live counts. This is the screen a floor manager watches.

| State | Means | Who acts |
| --- | --- | --- |
| **Free** | Ready to seat | Host |
| **Running** | Ordering or eating, no bill yet | Captain |
| **Bill printed** | Waiting to pay | Cashier |
| **Paid** | Settled, needs clearing | Busser |
| **Reserved** | Held for a booking | Host |
| **Cleaning** | Not ready yet | Busser |
| **Out of service** | Switched off, or its floor or area is closed | Manager |

The important point: *occupied* is not one state. A table that has just sat down, one
waiting for its bill, and one that has paid all need a different person to do a
different thing. The floor view works this out from the live order and its bill rather
than from a single status field.

Each busy table shows **what is on it and how long they have been sitting** —
`₹1,240 · 1h 40m`. Colour is never the only signal; every card carries the words too.

**Clicking a table opens it in the POS.** A busy table opens its existing order; a free
one starts a new order already set to dine-in on that table.

### List view

The admin view: add, edit and delete tables, set seats, and print QR codes. Each table
has a QR code that a guest scans to reach the ordering page. Regenerating the code
invalidates the old one, which is what you do if a printed code goes missing.


**Captain sections** — the day's plan of which captain looks after which floor, section or table — open from the top of Tables & QR (see Service above).

## Inventory

In the menu this area is **Stock** (Operations).

**Items & stock** is the shelf: every ingredient with its unit, quantity on
hand, reorder level and cost (the weighted average of what was paid). Filter to
**only what is running low**; the dashboard links straight there. Set the
**reorder level** to the quantity at which you would order, not zero.

### How stock moves

```
Purchase bill received ───┐
Stock in / opening stock ─┼──→  Stock on hand  ──┬──→  Dish sold (via recipe)
Production (prepared) ────┘                      ├──→  Wastage / dish waste
                                                 ├──→  Transfer to another store
                                                 └──→  Stock count correction
```

Selling a dish takes its recipe out of stock — **only if the dish has a
recipe**; a dish without one sells fine and moves nothing, the most common
reason a stock figure drifts. Stock is never typed in once an item exists: it
changes through stock in, stock out, wastage, transfers, production and posted
counts, so every unit has a line in **Stock movements**, with who did it and
the running balance.

**A bill never waits for stock.** If the recipes on a bill need more than the
shelf holds, the bill still goes through and the stock goes below zero: a guest
is never refused because a delivery was not entered. A figure below zero is a
signal to count: the bell's out-of-stock alert says *count it*, **Closing
stock** marks the item *Below zero* and leaves it out of the value, and
**Reorder** offers *Below zero — count it*, which starts a count of that item. A hand-entered stock out never takes a store below zero,
and wastage of an ingredient that shows no stock is refused until it is
counted. Why the rule is so is in
[BUSINESS_RULES.md › A bill never waits for stock](BUSINESS_RULES.md#a-bill-never-waits-for-stock).

**Stores.** The main store, and any outlet set to *keeps its own stock*
(Items & stock → Stores). An outlet that does not keep stock sells from the
main store. Staff tied to an outlet work with that outlet's store only.

**Batches & expiry** shows stock by batch and store. Sales, production and
transfers use the earliest-expiring batch first and skip expired ones; a
movement that would need expired stock is refused. **Production** turns
ingredients into a prepared item (one recipe per output unit), at the current
average cost; **Void batch** undoes one whose output is still untouched.

**Stock counts** (tab on Items & stock). *Start a count* for a store: all
items (or some categories and storage areas), one storage area, the 20 items
worth most on the shelf, or those at or below their reorder level, optionally
**blind** (counters do not see the expected figures). Counters fill in the sheet (`inventory.count`, the kitchen
has it); a manager **Posts** it (`inventory.manage`) — every difference needs a
reason (not explained, spoiled, staff meals, over-portioning, suspected theft,
delivery not entered, earlier count wrong, other). Posting corrects stock and
cannot be undone. If the value found **short** is over the write-off limit,
posting needs *Approve wastage or stock out over the approval limit* or a
manager's PIN for that count and value. **Closing stock** gives what was on
the shelves at the end of a chosen day and its value — the accountant's
month-end figure.

**Import** loads stock items (with packs and one-time opening stock) from a
CSV, checked first like the menu import (`inventory.manage`).

### Transfers & indents

**Stock → Transfers & indents.** A **transfer note** (TRF-0001…) moves
stock between two stores, valued at cost, earliest expiry first, with an
optional vehicle or driver; print it as an A4 challan or on 80 mm. With
**The receiving store confirms what arrived** switched on (Stock & purchasing
settings) the stock shows *In transit* until the receiver enters what came;
short lines need a reason (short, damaged, spoiled) and are written off at the
receiving store. **Call it back** returns a note still in transit. Sending and
receiving need `inventory.manage`.

An **indent** (IND-0001…) is an outlet asking the main store for stock: **Ask
for stock** with items and an optional date needed. Raising or withdrawing one
needs *Ask the main store for stock* (`inventory.indent`, the kitchen has it)
or `inventory.manage`; the store answers with **Send stock** (in one or several
transfer notes) and can **Close the rest**. An indent can be withdrawn only
before anything has been sent.

### Waste & reorder

- **Wastage** — *Log wastage* for **An ingredient** (spoiled, expired,
  overcooked, dropped, returned by guest, over-prepped, other with a note) or
  **A finished dish** (which dish, size, plates, reason: dropped at the pass,
  remade, spoiled / left over, quality complaint; its whole recipe comes out
  at cost — a dish with no recipe is refused). Logging needs *Log kitchen
  wastage* (`inventory.waste`) or `inventory.manage`; undoing needs
  `inventory.manage` and works for 7 days. **Dishes wasted** lists the dish
  write-offs.
- **Reorder** — what will run short over 3, 7 or 14 days (plus 2 safety days,
  at the last 14 days' usage, rounded up to a pack), grouped by supplier; the
  days it opens on, the safety days and the usage period are set in Settings →
  Alerts and timings → *Reorder plan*. **Create draft PO** makes a draft
  purchase order per supplier at the price last paid (also needs
  `purchasing.manage`).
- **Who wrote off what** (for `audit.view`) — each person's waste at cost,
  write-offs over the limit with who approved them, and large purchase orders.

### Stock & purchasing settings and approval limits

**Stock → Stock & purchasing settings** holds two **approval limits**,
both blank (no approval) until the owner sets them:

- **Purchase orders over (before GST)** — see Purchasing.
- **Wastage or stock out over (at cost)** — wastage of an ingredient or a dish,
  stock out, and the shortage on a posted count above this value need *Approve
  wastage or stock out over the approval limit*
  (`inventory.approve_writeoff`, owners and managers) or a manager's PIN tied to
  that item, quantity and value. Shortfalls written off when a transfer
  arrives do not go through this limit.

Saving the settings needs `restaurant.settings.manage`.

## Purchasing

In the menu this area is **Purchases & suppliers** (Operations).

**Suppliers** holds who you buy from — name, code, contact, mobile, GSTIN
(checked character by character), payment terms and **credit days** (which set
each bill's due date). *Import* loads them from a CSV, checked first.

**Purchase orders** (page *Purchase orders & bills*) has three tabs:
*Purchase orders*, *Purchase bills* (every delivery that came with a
supplier's bill, against an order or without one) and the *Purchase register*
the accountant asks for at month end (each supplier bill with GSTIN, taxable
value and CGST/SGST or IGST, then the debit notes).

```
Draft ──→ (Waiting for approval) ──→ Ordered ──┬──→ Part received ──→ Received
   │                                           └──→ Closed short
   └──→ Cancelled
```

**Approval over a limit.** When *Purchase orders over (before GST)* is set, a
draft above it is **sent for approval** instead of ordered. Someone with
*Approve purchase orders over the approval limit* (`purchasing.approve` — by
default only the Restaurant Admin) opens it and presses **Approve and send**
(with an optional note printed on the order) or **Send back** with a reason.
A buyer without the permission can also get it approved on the spot by a
manager's PIN for that order and amount. Someone holding `purchasing.approve`
who orders their own over-limit draft approves it as they order (the log says
so). Approvers get a bell alert for each waiting order; nothing can be received
against a waiting order.

**Receiving is what puts stock on the shelf.** Record what actually arrived —
in parts if needed — with the supplier's bill number and date, the price
charged and its GST, and what was turned away at the back door and why. You
cannot receive more than was ordered or cancel an order once goods have
arrived (close it short instead). Each purchase bill can carry up to five
**paper bill** photos or PDFs (5 MB each); removed files are kept for theft
checks. Duties are split: raising orders `purchasing.manage`, receiving and
entering bills `purchasing.receive`, paying suppliers `purchasing.pay`.

**Returns & payments** (page *Supplier accounts*) answers "what do we owe?":
*Who we owe*, *Supplier statement* (balance brought forward, every bill, return
and payment with the running balance, open bills with how late they are),
*Returns* and *Payments*.

- **Return goods** sends stock back with a reason; stock leaves at once. You
  cannot return more than was bought or is in the store, or credit more than
  was paid; GST is credited at the rate paid. Each return prints as a **debit
  note** (A4 or 80 mm) with both GSTINs, the original bill and GST split as
  CGST/SGST or IGST; a voided return prints CANCELLED. Returns need
  `purchasing.returns`.
- **Payments** record what was paid, by which method and reference.

## Customers — Customers, Feedback, Complaints

**Customers** is the guest book. Name, mobile, email, birthday, address, notes, tags
(VIP, allergy, Jain, vegan, corporate, family, blogger), allergies, a company name and
**GSTIN** for a B2B tax invoice, **what they agree to be sent** (bills on WhatsApp,
reminders, offers: each a consent of its own on the restaurant's privacy notice, tapped
as they say yes; see [Personal data](#personal-data)), and a loyalty points balance. Only
the name is needed: a mobile is never a condition. Searchable by name or mobile. A mobile
is stored one way (10 digits for an Indian number), so the same guest typed three ways is
one guest.

Attaching a customer to an order at the POS is what makes this useful. Clicking a name
opens their **history** — visits (what they ordered, when, and the bill) and points.

Three tabs:

- **Guest book** — the list, with *Export CSV* for those allowed (`customers.export`;
  every export is on the activity log).
- **Possible duplicates** — two records that turned out to hold the same number. A
  manager decides, one pair at a time, whether they are one guest (**merge**: visits and
  points move onto one record, `customers.merge`) or a family sharing a phone.
- **Points & guest sales** — points earned, redeemed and adjusted day by day (for those
  who read reports, while **Loyalty points** is switched on in Settings → Features), and
  what known guests spent (for those who may see takings). With loyalty off, the tab is
  **Guest sales** alone; for someone who reads reports but may not see takings, it is
  **Points** alone.

**Guests' contact details are protected.** Only roles with *See every guest's full
mobile, email and address* (`customers.contact` — owners and managers) see them in full.
Everyone else sees the last digits ("XXXXXX3210"), still finds a guest by typing their
whole number, and can open one guest's number on purpose — which is logged.

**Erase personal details** (`customers.erase`) is the answer to a guest who asks to be
forgotten: the name, number, email, address and notes are removed everywhere, but the
record stays so the bills on it (kept for GST) and the visit counts still add up. It
waits for money still between them and the restaurant (dues on account, an advance left,
a pre-order to collect), and is kept in *Settings › Personal data › Requests* as an
erasure request received and done that day.

**Loyalty points are a ledger, not a number.** Points earned and redeemed are recorded
as entries, and the balance is their sum. That means a disputed balance can be explained
line by line rather than argued about. Points can also be adjusted by hand with a
reason.

Deleting a customer keeps their feedback and complaints on record.

**Import** loads guests from a CSV (checked first, like the menu import): every row needs a mobile or an email, and you choose whether a guest already in the book is updated or left alone. Opening points are given once. Importing needs both `customers.manage` and `customers.export`. A guest's **delivery addresses** (up to 5) are kept on their history; only `customers.contact` sees them in full. A guest's **dues** (bills on account) are under Daily work → Dues & accounts.

**Feedback** collects star ratings and comments from the counter, a QR code, the website
or the phone. Tiles show the average rating, how many were happy (4–5), how many unhappy
(1–2), and how many nobody has looked at yet. Each can be marked reviewed or archived.

**Complaints** is the one with teeth, because a complaint has a state and somebody owns
it:

| Status | Means |
| --- | --- |
| Open | Logged, nobody has started |
| In progress | Someone is on it |
| Resolved | Dealt with, outcome recorded |
| Closed | Finished |

Each has a category (food, service, delivery, billing, hygiene), a priority, and an
assigned person, and is logged **against the bill it is about** (type the bill or order
number; the guest and amount are one click away). **Marking one resolved or closed
requires writing how it was resolved** — the field is mandatory, which is what stops
complaints being silently buried — and what the guest was given is recorded: an
apology, a dish remade or taken off, a discount, something on the house, a refund, a
voucher or points, with its value. The month's cost of putting things right is a tile at
the top.

**Guest insights** is for the manager with ten minutes before service: the headline
numbers, who you know is in the room right now, and lists that turn into phone calls —
regulars (3 or more visits in 60 days), new faces worth a second visit, regulars who have
gone quiet (nothing in 45 days), birthdays, the unhappy, and guests sitting on points.
Each list says in one line how it is decided; the numbers are set in Settings → Alerts
and timings → *Guests*. A call from these lists invites the guest back, so a guest's
number dials straight away only once they have agreed to offers; otherwise it asks for
their consent first. A call to an unhappy guest about their complaint needs none.

Open and in-progress complaints appear on the Dashboard under Needs attention. The link
opens the list already filtered to exactly those.

This is the module most often left empty, and the one that most rewards being used — a
guest who complains and is answered usually comes back.

## Operations — business day, cash drawers, log book, discounts, expenses

In the menu, **Business day** and **Expenses** are under Daily work, the
**Log book** is a tab of Reports and **Discounts & offers** a tab of Settings.

### Business day

The backbone. Everything belongs to a business day, and a business day is
**not** a calendar day — a kitchen serving until 1 am is still on the day it
opened. **Each outlet, and the main counter, has its own day**; the screen
works on the outlet picked in the top bar. Tabs: **Today**, **Past days**,
**Drawers & cash**, **Cash rules**.

```
Open day (count the float)  →  Drawers: start shift → cash in/out → X report → end shift (count)
                            →  Close day (count, tick card & UPI)  →  Z report
```

**Open day** (`business_day.manage`): the business date (today, or last
night's until the cut-off hour, 5 am by default), the **opening cash** counted
into the drawer, and a note for the shift. Refused if a day is already open or
that date has already been closed. **The POS takes no orders, and no payments,
refunds, advances or collections are taken, until a day is open.**

**Cash drawers** (Drawers & cash). Each cashier **starts their shift** with the
float counted into their drawer (suggested from the opening cash, then the last
shift's count) — one open drawer per person per day; only a manager
(`business_day.close`) opens or closes one for someone else. **End shift**
counts the drawer (a total, or notes and coins); a difference over the allowed
amount needs a reason. The **X report** is a printed reading of one drawer or
one person mid-shift; it changes nothing.

**Cash in and out:** **Cash drop** (surplus to the safe), **Petty cash** (paid
out for ice, an auto, a repair — also written as an approved cash expense) and
**Float top-up** (change from the safe), each with an amount, the drawer and
what it was for. Needs *Take cash in or out of the drawer* (`cash.movements`)
or a manager's PIN for that day and amount. Cash cannot come out if the drawer
does not hold it. Mistakes are **cancelled with a reason, never deleted**, and
are locked once the drawer is counted or the day closed.

**Close day.** The dialog lists what blocks closing:

- **Open orders** — a hard stop; bill or cancel them.
- **Cash expenses waiting for approval** and **drawers still open**.
- **Unpaid bills** — unless you tick *Close anyway and carry the unpaid bills
  as dues*, which is written on the day; they then appear in Dues & accounts.

Then count the cash. *What the drawer should hold* shows the arithmetic:

```
expected = opening cash + cash sales − cash refunds − rider shortfalls
           ± cash advances in and out − drops + top-ups − petty cash
```

(hidden from the cashier in **blind count** mode, which keeps the first figure
counted on the day, so a recount made to match stays visible). An over or
short beyond the threshold (₹100 by default) needs a reason. **Tick card and
UPI** against the machine or bank app, or type their figure with a note. Add a
closing note. Closing needs *Close the business day* (`business_day.close`) or
a manager's PIN tied to this day, this count and the carry-over choice.

**Reopen** ("Closed by mistake? Reopen", also on Past days) needs
`business_day.close` and a reason, and works only for the till's **latest**
day, while its date can still be opened, and when no other day is open. The
count is cleared and done again at the next close; the reopening is written on
the day and in the activity log.

**Past days** lists every day with its opening cash, the count, what the
drawer should have held and the difference. **Cash rules**
(`restaurant.settings.manage`): the cut-off hour for last night's day, the
over/short amount needing a reason, and blind count. A drawer counted short
shows on the day-end sheet, in Reports → Theft control and in the owners' bell.
The **Z report** is in Reports → Day end · Z report.

### Discounts & offers

**Settings → Discounts & offers** has the tabs **Offers**, **Loyalty points**
and **Given at the till** (the last two need `sales.view`).

**Offers** are coupon codes (`discounts.manage` to add): a code and name,
**money or % off** or **buy X, get Y** (the cheapest qualifying dishes are
discounted), on chosen categories or dishes or everything, on chosen weekdays
and hours (a window may run past midnight), **once per guest**, a maximum
discount for percentage offers, a minimum order (on the subtotal before tax),
valid-from and valid-to dates, a **usage limit** across all guests, and which
order types it applies to. The code is **locked after creation**; an offer that
has been used cannot be deleted — set it inactive.

**Loyalty points** (`restaurant.settings.manage` to change): spend for one
point, earned on the bill total or on food before tax, the value of a point,
fewest points to use, most points on one bill, most of a bill points may pay
(%), and expiry in days (oldest points are used first). Changes apply from the
next bill. Points are earned when a bill is fully paid and taken back with a
refund. **Points are a ledger, not a number**, so a disputed balance can be
explained line by line; hand adjustments need `loyalty.adjust` or a PIN.

**Given at the till** shows till discounts and no-charge bills for a period —
why (by reason), who gave them (with how many a manager approved) and bill by
bill.

### Log book

**Reports → Log book** is what one shift tells the next: repairs, guests,
stock and staff. **New entry**: kind (Maintenance, Guest, Stock, Staff,
Other), what happened, the outlet or whole restaurant, the table if it is about
one, and **Needs follow-up**. Each entry is stamped with your name, the
business day and your shift. Entries cannot be edited or deleted — write a new
one to correct. Follow-ups stay at the top, on the dashboard and in the bell
(a warning after 24 hours) until someone **closes** them with what was done.
After signing in you see *N new since you were last here*; each entry shows
who has read it. Reading needs `logbook.view`, writing and closing
`logbook.write` (managers and cashiers have both). Staff tied to an outlet see
their outlet's entries and whole-restaurant entries only.

### Expenses

Everything spent that is not stock: rent, gas, electricity, repairs. Each
expense has a category, amount, payment mode, date, payee, reference and
notes, and can carry up to five **paper bill** photos or PDFs (5 MB each).
Expenses go through an **approval step**: pending until approved or rejected,
and only pending ones can be edited; approving one with a paper bill opens the
bill first. Only approved expenses count against the day. Cash expenses reduce
the expected drawer. An expense entered with one outlet selected is that
outlet's; with *All outlets* it is a shared cost. The list is paged by the
server (25, 50 or 100 a page).

## Staff — employees, leave, attendance, time clock, payroll, tips

**Employees** is the people file: name, employee code, department,
designation, contact, employment type, salary and how it is paid (monthly,
daily, hourly), joining date, and whether they have a login. Staff and users
are separate — a kitchen porter is an employee with no login. Salary fields
are hidden from anyone without *See salaries and payroll money*
(`staff.salaries`). An employee with attendance is set inactive, not deleted.
The row menu also sets, resets, unlocks or removes their **time-clock PIN**.

**Leave** (tab on Employees). *Add leave type*: paid up to an allowance (days
per month or per calendar year, optionally carried forward) or unpaid; one
type is the default. A yearly allowance is pro-rated in the first year (12 days
a year for someone joining in July gives 6). Leave is used in date order; days
beyond the allowance are loss of pay, and marking leave someone has run out
of asks **Save anyway — unpaid**. Paid leave adds pay only for monthly-salaried
staff. *Leave record* shows and prints each person's balance.

**Shifts & roster.** Shift patterns (start, end, break, a grace period before
someone counts as late; an end before the start runs past midnight) and a
seven-day roster grid where each cell — a shift, week off or leave — saves as
soon as it changes.

**Attendance** is the daily sheet: present, absent, half day, leave, week off,
in and out times. Worked hours, lateness and overtime are **calculated on the
server** and cannot be typed. **Mark remaining present** fills everyone not yet
marked from their rostered shift.

**Time clock** (**Staff → Time clock**, `staff.clock` — cashiers have it, so the
entrance tablet can run on a cashier's login). Staff tap their name (or type
their code), enter their PIN and **Clock in**, **Start break**, **End break**,
**Clock out**; *Full screen for the tablet* hides everything else. A punch on
another tablet, or one a manager adds, shows on the board by itself.

- The clock opens 60 minutes before the rostered start; overtime counts only
  when someone stays 15 minutes or more past the shift end (both set in
  Settings → Alerts and timings → *Time clock*); a clock-in open
  more than 16 hours is a forgotten clock-out a manager must fix; a night shift
  stays on the day it started; overlapping punches are refused.
- PINs are 4–6 digits, typed twice; weak PINs and the end of the person's own
  mobile are refused; five wrong PINs lock that PIN for 15 minutes. Set them
  on **Manage PINs** (`staff.manage`).
- **Photos** (off by default): *Take a photo at each punch* takes a small photo
  with every punch and deletes it after the days set (60 by default). No camera
  means the punch still goes through, marked *No photo*. Anyone with
  `staff.view` can see photos on the **Day timeline** — that includes the
  built-in Cashier; take `staff.view` off a copied role if that is not wanted.
- **Day timeline** (managers): who came, who was late, hours and overtime.
  **Add a missed punch** needs a reason; only punches a manager added can be
  removed. Neither is allowed inside a pay period already marked paid.

**Payroll** (`staff.manage` and `staff.salaries`) rolls attendance into pay for
any period: days present, half days, absences, paid leave and loss of pay,
hours, overtime, bonuses, advances, deductions, **tips**, and the statutory
deductions below. Mark a period **paid** to freeze it; a paid period keeps the
figures it was paid with. Payslips print and export.

**PF, ESI and professional tax** (button *PF, ESI & professional tax* on
Payroll) are each off until switched on:

- **PF** 12 % + 12 % on basic wages up to ₹15,000 a month; **ESI** 0.75 % +
  3.25 % when gross pay is up to ₹21,000 (rounded up as ESIC does);
  **Professional tax** by state slab table (pre-filled for Maharashtra,
  Karnataka, Telangana, Andhra Pradesh, West Bengal, Gujarat and Odisha from the
  GSTIN's state; enter Tamil Nadu and Kerala figures yourself).
- Per person, on the employee record: PF (off), ESI (off), Professional tax
  (on), UAN, ESI number, and the basic-wages share (50–100 %). Set Gender for
  the Maharashtra women's slab.
- Tips, advances and arrears are not wages for any of the three. Employer PF
  and ESI are shown as owed to the offices, not taken from pay. A
  *PF, ESI and professional tax* card gives the month's amounts to pay over.
- Note: if gross pay goes over ₹21,000 in a month, ESI stops for that month;
  the ESIC rule that keeps someone covered for the rest of the contribution
  period is not applied — check with your consultant.

**Tips** (**Staff → Tips**, `staff.salaries`). A tip is typed on the payment
screen on top of the bill, so a ₹1,000 card swipe on a ₹900 bill is 900 paid
plus 100 tip. Tips are never sales, GST or loyalty, and belong to the business
day they were taken on.

- **How tips are shared:** to *the day's pool* (default) or to *the captain who
  took the order* (the rest goes to the pool); optionally add the service
  charge collected to the pool; share the pool by **hours worked** (from
  attendance) or **points × days** (points per designation, e.g. Captain 3,
  Steward 2, Helper 1).
- **Share out tips:** choose the days and the pay date, untick anyone to leave
  out, check the preview (every share exact to the paisa, adding up to the
  pool), then **Confirm and share**. Only people present or on half day share.
  If tips changed after the preview, or someone is already paid for that pay
  period, confirming is refused.
- Shares appear on **Payroll** as a *Tips* line and add to net pay. **Undo
  share-out** works until anyone in it has been marked paid.

**My work** (a tab of Staff, for a login linked to a staff record; someone who
cannot open the other staff screens finds it as their **Staff** entry) shows a
person their own shifts this week and next, this month's attendance and hours,
the leave they have left, and their payslips (tips included).

## Reports and the activity log

One date range at the top, the reports beneath it on three shelves — **Sales**,
**Accounts** and **Control** — and **Print** and **Export CSV** on every one.

- The range defaults to the open business day, so after midnight the reports still
  show the night you are actually working. Quick picks: *Today*, **Yesterday**, *Last 7
  days*, *Last 30 days*, *This month* and **Last month** — the morning read and the GST
  month are one click each. Dates can also be typed; a start typed after the end moves
  the end with it, rather than showing an error.
- Every report files a bill under its **business day**, not its calendar date, and reads
  hours and times on the restaurant's own clock (Settings → Currency and time) —
  the busiest hours, the times on theft control and cancellations, and the times printed
  on the Z report — whatever clock the computer reading them is set to.
- The **outlet switcher** narrows every report to one outlet (the outlet comparison
  excepted), and the screen says so. A **closed** outlet is picked from **Read a
  closed outlet** beside the dates (shown only when there is one): its history only, with a
  link back to the outlet in the top bar.
- A printed report carries the restaurant, the report, the period in words, the outlet,
  and who printed it; every CSV starts with the same lines.
- A report opens only for those allowed: takings need *See takings and sales figures*
  (`sales.view`) as well as *View reports*, expenses need `expenses.view`, theft control
  needs `audit.view`. **Profit & loss and the day book need `expenses.view` as well as
  `sales.view`** — they show what was spent, not only what was taken — so the built-in
  Cashier does not see them. Stock consumption needs *View reports* alone, and "today"
  on these screens comes from the reports themselves, so a role with only stock reports
  still starts on the open business day.

| Shelf | Report | Answers |
| --- | --- | --- |
| Sales | **Sales summary** | What did we take? Net sales, bills, average bill, **dine-in per head**, discounts, best day, every day of the range (days with no sales shown as zero), order-type and payment splits, busiest hours, and a breakdown from gross to collected |
| Sales | **Items & menu** | What sold? Every dish and size — the full list with its totals, which tie to the sales summary — plus **Menu performance** (below) |
| Sales | **Dish profitability** | What does each dish leave after food cost? Needs `inventory.view` too — see below |
| Sales | **Discounts** | What did the offers cost? Each code, times used, discount given, sales on those bills |
| Sales | **Staff & waiters** | Who took the orders (captains and waiters: orders, covers, per head, plates, sales, dishes taken off after the KOT) and who billed them (cashiers). A dish that only closed out an already-voided bill is shown as *with a void*, not counted again — as in theft control — and someone whose orders were all cancelled after the KOT is still listed |
| Sales | **Outlets** | Which branch is carrying the others? Share of sales, bills, covers, per head, tax, discounts — always every outlet |
| Accounts | **GST filing** | The GSTR-1 filing pack — see below |
| Accounts | **Profit & loss** | Did we make money? — see below |
| Accounts | **Expenses** | Where the money went: approved expenses by category and month, by payment mode, with pending and rejected apart. With one outlet picked: its own expenses, and beside them the expenses recorded for the whole restaurant with that outlet's share |
| Accounts | **Day book (Tally)** | Every sale, receipt, refund, expense, supplier bill and payment as vouchers a Tally operator can import — see below |
| Control | **Theft control** | Voids, refunds, large discounts, reprints, dishes taken off after the KOT and days closed short, by staff member — see below |
| Control | **Cancellations & voids** | What was undone, on which business day, by whom, who approved it, and why |
| Control | **Stock consumption** | What did we buy, use and waste, and what is left — "used" is net of voided bills |
| Control | **Day end · Z report** | One day's closing sheet — see below |

### GST filing

Everything an accountant needs to file GSTR-1 for the period, bill by bill and to the
paisa, headed with the GSTIN (the outlet's own, when an outlet registered separately is
picked) and the place of supply. A restaurant supplies where the food is served, so every
sale is CGST + SGST, never IGST.

| Section | What it holds |
| --- | --- |
| Summary | B2B, B2C and nil-rated totals, the invoices in the period, less credit notes, and the net |
| Sales register | Every invoice number: date, buyer's GSTIN, taxable value, CGST, SGST, cess, total. A voided bill stays in the list as **cancelled** at nil value, so the number series has no holes |
| B2B | Invoices to registered buyers, by GSTIN and invoice by invoice |
| B2C | Sales to consumers by rate (also given net of the refunds made to consumers, as B2CS is filed), and nil-rated/exempt sales |
| HSN / SAC | The HSN summary, split B2B and B2C as the return asks. Services (codes starting 99) carry no quantity |
| Credit notes | Every refund, set against its own invoice in that invoice's share of taxable value and tax |
| Documents | The invoice number range, total issued, cancelled and net |

**A bill becomes B2B** when the guest's record carries a GSTIN, or when the buyer's GSTIN
and registered name are written on it here (Sales register → *Add buyer's GSTIN*;
people who can bill may do it). The GSTIN is checked character by character, so a typo
is caught before the buyer's accountant finds it.

**Service charge** is part of the taxable value. Where a bill charged no GST on its
service charge, the pack shows it on a line of its own with a warning, because GST law
treats it as part of the restaurant's supply.

The pack **checks itself** and shows the result: its tax equals the tax on the bills,
its invoice values equal the sales, the B2B + B2C + nil tables equal the register, and
CGST + SGST equal the tax on every invoice and in every total. Each section downloads as
a CSV; the B2B, B2CS, HSN and documents files use the column headings of the GST
portal's offline tool.

Cess, when configured, is captured on order lines and included in billing. Bill of
Supply orders carry no GST or cess. Confirm the configured rates and report exports
with the restaurant's accountant before live use.

### Profit & loss

Sales before GST (GST collected is the government's money), after discounts and refunds;
less the **cost of food**; less running **expenses** by category; less **staff
salaries** — for any range, month by month with a total.

- Cost of food comes either from **stock used** (what sales and kitchen issues took out
  of stock, net of voided bills, plus wastage, each at the item's latest cost) or from
  **supplier bills** (what was bought, less returns — for a kitchen that keeps little
  stock). A toggle switches between them.
- Salaries are the pay earned from attendance plus bonuses (Staff → Payroll). Only
  someone allowed to see salaries (`staff.salaries`) sees them; for anyone else the
  bottom line reads **profit before salaries** and says why.
- Expenses waiting for approval are noted, not counted.
- **With one outlet picked**, the P&L shows that outlet's own sales, its own food cost —
  what its bills took from stock, even when it draws on the main store — its own
  expenses and the salaries of staff assigned to it, giving **profit before shared
  costs**. Then come its **share of restaurant-wide costs**: rent, power and every
  other expense recorded for the whole restaurant, salaries of staff tied to no outlet,
  and the main store's kitchen issues and wastage, **shared out by sales** — an outlet
  that made 60% of the restaurant's net revenue in a month carries 60% of that month's
  shared costs. Every paisa is shared: the odd paise of the rounding go to the largest
  remainders, so three equal outlets carry ₹33.34, ₹33.33 and ₹33.33 of ₹100 of rent,
  never ₹33.33 each. The heading gives the share of those costs the outlet actually
  carries; the notes give its share of sales.
- **A month with no sales** — pre-opening rent and deposits, a month closed for works —
  is shared the way the nearest month that traded was (the same month's other days
  first, then the next month with sales, then the last one before it), and the notes say
  so. A restaurant that has never traded shares them equally between its open outlets.
- **Sales taken with *All outlets* picked** belong to no outlet. They carry their own
  share of the shared costs, and the outlet P&L says above the statement how much —
  so the outlets add up to the restaurant exactly once every sale is taken at an outlet.

### Day book (Tally)

The accountant's day book as double-entry vouchers: one **sales** voucher a day for
walk-in guests (and one per invoice for company guests with a GSTIN), **receipts** by
payment method, each refund as a **credit note** and the money paid back, approved
**expenses**, **supplier bills** with input GST, **goods returned**, **supplier
payments**, and salaries paid (for those who may see salaries). Every voucher balances,
and the screen says so before the file is downloaded. Supplier bills, returns and
payments are included only for someone who may see purchasing (`purchasing.view`), and
salaries only for someone who may see salaries; when either is left out, the screen says
so, so a partial book is never posted as the whole one. With one outlet picked it holds
that outlet's own vouchers only — post the *All outlets* book to Tally.

Every voucher has a number of its own, because an Excel-to-Tally mapper groups the rows
by it: receipts are numbered by day and method, the walk-in guests' first and each
company guest's after it (`R-YYYYMMDD-CARD`, `R-YYYYMMDD-CARD-2`), and a supplier bill
is numbered by its goods-received number, with the supplier's own bill number in the
*Reference No* column (Tally's *Supplier Invoice No.*). A voucher's amount is what its
party was charged or paid — a ₹271.00 invoice is a ₹271.00 voucher, its round off posted
inside it.

The CSV has one line per ledger entry with both *Amount + Dr/Cr* and separate *Debit* and
*Credit* columns, so it fits either kind of Excel-to-Tally import. *Ledger list* gives
every ledger name with the Tally group to create it under, so the operator sets the
masters up once.

### Theft control

The same-day check owners rely on: every **void**, **refund**, **large discount** (a
fifth of the bill or ₹1,000 by default — the line can be moved), **reprint**, **dish
taken off after the kitchen had it** (with the stage it had reached — "served, then
taken off" is the one to read first) and **day closed short**, with who did it and which
manager approved it. The staff table puts the person with the most money at stake at
the top. It is for the people who read the activity log (`audit.view`), never for the
cashier being checked.

A dish taken off only because its order was cancelled after the bill had been
**voided** is listed, marked *part of void*, but its money is counted once — under
voids — not a second time against whoever cancelled the order.

The same events ring the **bell** for owners and managers as they happen, and last
night's stay there the next morning.

### Dish profitability

Each dish and size sold in the range: sold, sales before GST, cost a plate, food cost, **food cost %** (red above 40 %), what it leaves a plate and in all, sorted by what each dish leaves. Food cost is the stock the bills actually took out, at that day's cost, so it agrees with Stock consumption and the Profit & loss. Dishes with no recipe are flagged and show ₹0 food cost, and a note gives the stock taken by them with a link to add the recipes. Needs `reports.view`, `sales.view` and `inventory.view`.

### Menu performance (inside Items & menu)

The part worth showing your leads. Three tabs: *Top selling*, *Low selling*, and
**Not sold**.

A normal item report counts what was sold, so a dish that sold nothing has no row and is
invisible. This one starts from the menu and joins the sales on, so the dishes that sold
**nothing at all** finally appear — each marked `Never sold` or `12 days ago`, with
anything over 30 days in red.

### Day end · Z report

One day — the **To** date — and it says so on screen. Set it to yesterday to read last
night's closing. It gives the invoice range, gross sales, discounts, service charge,
CGST and SGST, net sales, sales by order type, covers and per head, payments by method,
voids, cancelled orders and refunds, and the cash drawer: opening cash, cash sales,
refunds, expenses, **expected**, counted, and over or short. CGST and SGST are split
bill by bill and line by line exactly as the GST filing pack splits them, so the signed
Z report and the return filed for that day agree to the paisa.

**Print Z report** prints it on the receipt printer at the paper width in Settings →
Printing, with lines for the cashier and manager to sign. While the day is still open
it prints as an **X report** (the figures so far).

### Activity log

Who did what, when, and which manager approved it — price changes, voids, refunds,
reprints, cancellations, permission edits, wrong PINs. Filter by person, area and date,
switch on *money-sensitive only*, search, and export. It needs *Read the activity log*
(`audit.view`), which owners and managers have. This is the screen you open when a
number is disputed.

## Café, bakery and cloud kitchen

A café, a bakery and a cloud kitchen run on the restaurant: the same POS, menu, KOT, kitchen screen, bills and day close.

**Choosing the format.**
- *Platform › Restaurants › Add restaurant* has a **Format** choice.
- An existing restaurant changes it in *Settings → Features → Format*. This sets how the POS opens, the token numbers and the features it starts with. Any of these can be changed again afterwards, and nothing is deleted.
- The header and the business switcher show the format.

| Format | POS takes | Starts on | Tokens | Features it switches |
|---|---|---|---|---|
| Restaurant | dine-in, takeaway, delivery | dine-in | as set | none |
| Café | takeaway, dine-in, delivery | takeaway | takeaway | Guests and pre-orders on; reservations and captain sections off |
| Bakery | takeaway, delivery | takeaway | as set | Guests, pre-orders, advances, stock & recipes on; reservations, QR, captains, KDS and tips off; no tables |
| Cloud kitchen | delivery, takeaway | delivery | delivery, online, takeaway | Guests, deliveries, online ordering and brands on; reservations, QR, captains and tips off; no tables |

*Service settings → Orders the POS takes* changes the kinds of order and the starting one. The server refuses a kind of order the POS does not take.

**Selling by weight** (bakery cookies, sweets). Set the menu item to *Sold: by weight* and the price is per kg. On the POS it asks for the grams on the scale (or offers 100 g to 1 kg). The line shows the kg, and ± changes it 50 g at a time.

**Pre-orders & cakes** (*Daily work → Pre-orders & cakes*, feature *Pre-orders & cakes*).
- **Booking:** *New pre-order* takes the guest (their name, and their mobile if they want to be told it is ready; a mobile typed finds a guest already in the book however it is written), when it is due, pickup or delivery, the items with each cake's message or flavour, and an advance. An item is counted in whole pieces, or in kg in steps of 50 g when it is sold by weight. The advance is an ordinary advance (*Dues & accounts → Advances*), in the day's cash. If the till cannot take it (no business day open, or cash that would take the guest to the ₹2,00,000 cash limit for the day), the pre-order is still booked and a warning says so: take it later with *Take advance* on the pre-order.
- **Advances:** taking one needs *Advances & deposits* (*Settings → Features*; on for a new restaurant, and choosing the Bakery format switches it on). While it is off, *New pre-order* has no advance: whoever takes payments sees a line saying so instead, with a link to *Settings → Features* for those who can open Settings. Pre-orders have no *Take advance*, and *Advances held* is hidden, on the page and in the dashboard's Pre-orders block. If it is switched off while the dialog is open, booking with an advance is refused, the advance field goes, and booking again goes through without it.
- **Outlets:** a pre-order is booked at the outlet picked in the top bar (yours, when you are tied to one), or at the main counter under *All outlets*, and its row names the outlet after its number (*PRE-0004 · Kondapur*). Staff tied to an outlet see only that outlet's pre-orders, in the lists, the tiles and the dashboard's Pre-orders block, and cannot open, move along, hand over, cancel or take an advance on another outlet's or the main counter's. Everyone else sees every outlet's, whichever outlet is picked; with an outlet picked, the dashboard's Pre-orders block says *All outlets*. An outlet with open pre-orders can be neither closed nor deleted ([Outlets](#restaurant--profile-outlets-hours-settings-payment-types)).
- **Baking:** the **Bake list** adds up what is due on a day by item, with every message, and can be printed for the kitchen. Each outlet, and the main counter, has its own list of the pre-orders booked there: the screen shows the list of the outlet picked in the top bar (yours, when you are tied to one), or the main counter's under *All outlets*, with its name beside the date and on the print. A restaurant without outlets has one list. It opens on tomorrow; pick any day. *Start baking*, then *Ready*.
- **Kitchen:** the kitchen's login (the built-in *Kitchen Staff* role, or any role with `kds.view` but not `orders.view`) finds *Pre-orders & cakes* under *Daily work* while the feature is on, and gets the bake list alone: pick the day, *Print*. It has no tiles, no *Open*, *Collected* or *Cancelled*, no *New pre-order*, no *Start baking*, *Ready*, *Hand over & bill* or *Cancel*, and no Pre-orders block on the dashboard. *Kitchen display* need not be on. A baker tied to an outlet gets that outlet's list, and one tied to none the main counter's, as the *Kitchen Staff* role has no outlet picker: tie each outlet's baker to it in *Users*.
- **Hand-over:** *Hand over & bill* makes a takeaway order on today's business day and opens its bill with the advance taken first.
- **Cancelling:** a cancelled pre-order keeps its advance held, to hand back from *Dues & accounts → Advances*; the cancel dialog says so when an advance is held.
- **Dashboard:** a Pre-orders block shows how many are due today and tomorrow, the first four due today with their times, and, while *Advances & deposits* is on, the advances held.

**Day-end unsold** (*Stock → Day-end unsold*, bakery and café). Bakes are prepared stock items made from a recipe (*Stock → Items & stock → Production*). At closing, type what is left and will not sell tomorrow, then *Write off as unsold*. This is recorded as waste with the reason *Unsold at day end*, at cost. What keeps stays in stock.

**Cloud kitchen.**
- The POS opens on Delivery. *Came in on* picks Swiggy, Zomato or own delivery, and the partner's order ID is kept.
- Channel prices are set per dish in *Menu → Products* (*Prices & outlets*).
- Commission per channel is set in *Deliveries → Channels*, and the *Channel report* takes it off the bill totals.
- Tables are hidden from the menu and the dashboard (in a bakery too).

**Brands: one kitchen, several names** (*Menu → Brands*, feature *Brands*, on for a cloud kitchen).
- **Setting up:** *Add a brand* for each name the kitchen sells under (as listed on Swiggy and Zomato), with a colour for the POS. In *Menu → Categories*, give each category its brand. A category with no brand (drinks, desserts) is on every brand's menu.
- **Taking orders:** the POS shows the brands above the menu. Pick one, and the menu shows its categories and the shared ones. The order is taken under that brand, and a dish from another brand's menu is refused.
- **Printing:** the KOT and the bill print the brand's name. The registered business that supplies it follows on the bill, with its GSTIN.
- **Report:** *Sales by brand* shows each brand's bills, sales, aggregator commission (at each order's own rate) and net, by channel.
- **Switching off:** with *Brands* off, no new order or category can be taken under a brand. Orders and categories that already have a brand keep it, and dishes can still be added to those orders.
- **Pausing:** a brand can be paused, which takes no new orders and keeps its history.

---

# Part 3 — Business Admin for the other business types

Every business other than the signed-in restaurant opens in **Business Admin**.
The screens are shared between the types and renamed to suit each one (a salon
says *Clients* and *Bills*, a clinic says *Patients*). A screen appears only
when the business uses that **business tool** (Settings › Business tools) **and**
your role there allows it. The server checks both again on every action, so a
hidden screen is never just hidden.

**The menu** has three groups: **Daily work**, **Business** and **Management**.
As in the restaurant, each entry opens an area whose other pages are tabs
across the top (the fifth and later under **More tools**; the billing screens
show none), and an entry opens the first of its pages you may use, so an entry
is named after that page. A path such as *Stock › Expiring soon* in this part
means the entry, then the tab. On the Overview, its lines and quick actions open their screen in a wide
panel over it.

## The screens every type shares

| Menu | Entry, and the tabs inside it | What they are for |
| --- | --- | --- |
| Daily work | **Overview** | Up to four headline figures — sales today (against the same weekday last week by this time), money in today, what customers owe (less advances, the same figure as Udhaar / Outstanding) and what is owed to suppliers — then *Needs doing today* (low stock, batches expiring soon, transfers on the way, counts open, broken promises, repairs ready, orders to dispatch…), *Start here* (the things done most often in this type), sales over the last 14 days, hour by hour and the best sellers, the day's bookings for a salon or clinic, and *What this business uses*. You see only the figures your role may see. |
| Daily work | The type's own counter and day: a shop's **Quick bill**, a pharmacy's **Prescription sale**, a salon's **New bill** and **Appointments** (the calendar), a clinic's **Today's patients**, a wholesaler's **Sales orders**, a garage's **Job cards**, a gym's **Check-in**, a laundry's **New order** and **Orders** (with Ready & racks and Unclaimed), a jeweller's **Jewellery bill** (with Quick bill) and **Today's rates** (with the Rate board), a rental business's **Bookings** (with Availability and Deposits held), a fuel station's **Shift & readings** and **Tanks & dips** (with Tanker receipts and the Stock register), a hotel's **Front desk** (with Rooms & housekeeping, Reservations and Stays) and **Foreign guests (Form-III)** (with the Guest register) | Described with each type below. |
| Daily work | **Sales history** (*Bill history* in a salon or clinic), with Quotations, Exchanges, Warranties and Orders for pickup where the type has them; **Customers** (*Clients*; a clinic's *Patients*), with Loyalty points (and a garage's Vehicles and Service due; a gym's **Members**, with Renewals and Member contacts; a fuel station's Fleet statements) | Post a sale at the server's prices, take payment with it or leave it on credit, return goods, refund. Customers carry a GSTIN, a credit limit and credit days; a customer over the limit cannot be given more credit. |
| Daily work | **Udhaar** (*Customer dues* outside a kirana, a meat or weight-based shop, a general store, a hardware shop or a seeds and fertiliser shop), with *Payments received*; **Daily money**, with Expenses (and EMI & financiers) | What customers owe and what they paid; the day's money and paid expenses (below). |
| Business | **Products & services** (named for the type: *Medicines & products*, *Books & stationery*…), with Categories, Barcode labels, Kits & bundles, Offers & discounts, price lists and the type's own (Drug master, Book details, Size × colour, Today's rates, Stylists & services, a laundry's Price list; a rental business's area opens on its Rental items) | Items with GST slab, unit, how they are tracked (quantity, batch and expiry, or serial number), reorder level. Categories nest up to five levels. |
| Business | **Purchases**, with Suppliers, Purchase orders (every business that keeps stock) and, for a wholesaler, Claims on suppliers | Record what was bought; stock goes up at once at its cost. |
| Business | **Stock** (*Stock on hand*), with Stock movements, Stock counts, Expiring soon, Transfers and the type's own (Serial / IMEI register, Stock by weight, Cutting & processing, Wastage, Expiry, returns & recalls) | Stock by location and batch with its value; every change has a line in the movements ledger with its reason. A transfer is sent, is *on the way*, then is received (or cancelled). A count is entered over time and **approved** by someone allowed to; only then does stock change, and the differences become reasoned corrections. |
| Business | The type's own records: **Registers & prescriptions** (pharmacy), **Booklists & orders** (books), **Repairs** (electronics), **Packages** (salon), **Lab orders** (clinic), **Farm inputs** (seeds, fertilisers & pesticides) | Described with each type below. |
| Management | **Reports**, with the type's own reports, Staff commissions and Activity log | Money by day, locations compared, departments; who did what. |
| Management | **Tasks** | See [Part 4](#part-4--tasks-issues--projects). |
| Management | **Settings**: Business settings (with Business tools), Tax rates, Payment methods, Number series, Locations, Units & pack sizes, Staff & rooms (*Doctors & rooms* in a clinic), Licences (with Licences & registrations on), and Pharmacy settings, Clinic & lab settings, Farm input checks, Garage settings, Membership plans, Pumps & nozzles or Room types & rates | Legal name, GSTIN, prices with or without GST, rounding, financial year, the most a manager may take off a bill at the counter (with a reason; the owner is not limited), whether a walk-in may leave a bill unpaid, and the shared till's PIN rule. Number series give each location its own bill numbers per financial year, with no gaps and no duplicates. A pack size turns "3 boxes" into 72 pieces exactly. A location holding stock cannot be closed. |
| Management | **Staff & access**, with Roles & permissions | Give a person from your staff list a role in this business, change it or switch it off. |

**Two rules people notice:** prices, tax and totals are always worked out by the
server (the screen only shows the server's quote), and nothing posted is ever
edited — a mistake is corrected by a return, a refund, a reversal or a reasoned
stock correction, each with its own number.

### Several locations (branches)

A business with more than one shop, counter or godown works like the
restaurant's outlets.

- **Settings › Locations**: each location can have its own **address, phone,
  GSTIN and state**. They print on the bills, receipts and delivery challans it
  raises; an empty field prints the one in Business settings. A branch
  registered on its own GSTIN (often in another state) supplies from that state,
  so its walk-in bills carry the right place of supply. A location that holds
  stock, or that has staff tied to it, cannot be closed until they are moved.
  A location that only holds stock (a warehouse or godown) has *Sells at the
  counter* unticked, so Quick bill does not offer it as a till.
- **Staff & access › Works at**: a person can work at **every location** or at
  **one**. Tied to one, they bill, move stock, count stock, take returns and see
  reports, the Overview and Daily money for that location only; another
  location's bill, stock or report is refused, and so is a record of another
  location opened by its link. A manager tied to a location gives access, and
  sets new passwords, at that location only: for the people tied to it, not
  for those who work at every location. The owner always works everywhere.
- **The location picker** (top bar, beside the business switcher) appears when a
  business has two or more open locations. Pick a branch and every list, report,
  the Overview, Quick bill and Daily money open on it; *All locations* shows the
  whole business. Someone tied to a location sees their location's name there
  instead of a picker. Changing it reloads the page.
- **Transfers** are sent from the locations you work with to any other open
  location; the receiving location confirms them and the sending one cancels.
- **Reports › Locations compared**: bills, sales, returns, net sales and each
  location's share, the average bill, money collected, purchases and the stock
  each holds now, for the report dates. It always shows every location (someone
  tied to one sees theirs).
- **Settings › Pharmacy settings › Licences by branch**: each premises holds its
  own drug licences; a branch's numbers print on its bills, and a branch with
  none prints the business-wide numbers.
- **A clinic's visits** belong to the branch where they happen (the doctor's
  branch, else the one the front desk works at), so branch staff see their own
  branch's visits and each branch's patients can be counted.

What customers owe (udhaar / outstanding) stays business-wide: a customer
belongs to the business, not to one branch.

### Products, prices and opening stock

**Products & services › Add item** (named for the type: *Medicines &
products*, *Books & stationery*…) takes the item's name, SKU code, barcode,
kind (goods kept in stock, or a service), stock unit, how its stock is
tracked (quantity only, batch and expiry, or serial / IMEI number), the
selling price, MRP, GST slab, HSN code (SAC for a service), category and
reorder level.

- **Prices include GST** in a new goods shop (grocery, supermarket, books,
  pharmacy, fashion, electronics, meat and weight shops), and sale totals are
  rounded to the rupee. Both are set in Business settings › *Prices, totals
  and numbering*; bills already posted keep their own tax mode.
- **MRP** is the price printed on the pack, GST included. An item is never
  priced, given a new selling price on a receipt, or billed above its MRP;
  with prices before GST, the GST is added before comparing. The HSN code and
  MRP are copied onto each bill line, and the HSN code prints on the tax
  invoice.
- **Opening stock.** *Add item* also takes what is already on the shelf: the
  quantity, its cost (which values the stock), the location and, for a batch
  item, the batch number and expiry. It goes into stock at once, as a
  correction with the reason *Opening stock* in the stock movements. A
  serial-numbered item comes in through a purchase instead, one number at a
  time.
- **Barcodes.** Two items never share one. *Edit* changes an item's barcode
  to the one printed on the pack, or clears it; **Barcode labels** gives an
  in-store barcode to items that have none.
- **HSN / SAC codes to fix.** Once 6-digit codes apply to the business's
  invoices (its PAN's turnover has passed ₹5 crore,
  [GST thresholds across your businesses](#gst-thresholds-across-your-businesses)),
  now or from the next 1 April, a card above the items says which and lists
  every item that prints a shorter code, or none (not a kit, nor an item used
  in services only), with *Edit* to give it its full code. It shows no
  turnover, and goes once every item has one.

### Products, customers and suppliers from a CSV file

A shop that comes to the platform with its catalogue, customers or suppliers
in another system (Tally, Vyapar, Marg), a spreadsheet or an udhaar book
brings them in at once. **Import from a CSV file** is on **Products &
services**, **Customers** and **Suppliers**, beside *Add item*, *Add customer*
and *Add supplier*, for whoever may add those by hand.

1. **Download sample file** gives the template: its headings are exactly the
   columns the import reads, and *What each column means* explains each,
   with this business's own units, GST slabs and locations. Headings are
   matched whatever their case, spaces or punctuation, and the usual ones of
   other systems are understood (*Item name*, *SKU*, *GST %*, *Party name*,
   *Mobile No.*); a heading it does not know is listed as ignored.
2. **Choose a CSV file** (in Excel: File → Save As → CSV UTF-8), up to 5,000
   rows. It is checked first, and nothing is saved: each row is shown as
   **New**, **Changes** (each value old and new), **Already here** (left as it
   is), **No change**, or **Refused** with the reason in words and the column
   it is about. A problem with the whole file (no *Code* column for products)
   stops it; a problem in a row refuses that row only.
3. **Items / Customers / Suppliers already here**: *Leave them as they are*
   (the default) or *Update them*, for someone who may change them. Updating
   changes only what the file gives: a column left out, or an empty cell,
   keeps what is there.
4. **Import N products** (or customers, suppliers) brings in the rows not
   refused, all together: if anything stops the import, none of it is saved.
   The same import sent twice (an answer lost, a second press) is done once.
   A file of thousands of rows takes a minute or two: keep the window open
   until it says it is done.

How a row finds a record already here:

- **Products**: by code (SKU), then by barcode. A new item needs its name,
  code, unit and sale price; it is a service when its unit is hours or a
  service, unless the *Kind* column says. An item's kind, unit and stock
  tracking never change from a file.
- **Customers and suppliers**: by GSTIN, then by phone, written any way
  (+91, a leading 0, spaces), and a row with neither by its name. A phone is
  never needed. One person on two rows of a file is refused the second time.

What goes in, by the same rules as the screens:

- **GST slabs and units** are only the business's own (add one in *Settings ›
  Tax rates* or *Settings › Units & pack sizes* first). An HSN or SAC code has
  4, 6 or 8 digits, and nothing is priced above its MRP. A GSTIN is checked
  character by character; the state follows from it, a *State* column must
  agree with it and a *PAN* column with the PAN inside it. Without a GSTIN,
  the state ends the address.
- **Categories** the file names are made when they do not exist yet; a path
  such as *Staples › Rice* makes each level.
- **Opening stock**: the quantity at its location (the first one, unless the
  *Location* column names another), valued at the *Purchase price*, with its
  batch and expiry for an item kept by batch. It goes in once, as *Opening
  stock* in the stock movements, for a new item or one with no stock on
  record yet; an item that has stock keeps it (a stock count corrects it).
  Serial-numbered stock comes in through a purchase.
- **Opening balance**: what a customer owed you when you started, or what you
  owed a supplier, on the day given (today when empty); *Dr* and *Cr* as Tally
  writes them are read the right way round. It is the contact's own opening
  balance, as on their form, so Udhaar, Outstanding and the supplier's
  account count it. It is set once: a contact who already has one keeps it
  (change it on their form).
- **A type's own items** are not made from a file: a fuel (*Settings › Pumps &
  nozzles*), a jewellery piece with its purity (*Pieces & tags*), a rental
  item (*Rental items*), a laundry's priced services (*Price list*), a room
  type (*Settings › Room types & rates*) and a membership plan (*Settings ›
  Membership plans*). Such a row is refused with the screen to use, and such
  an item already here is not changed from a file. A pharmacy's medicines
  come in as items kept by batch, and their drug details are added in the
  *Drug master*; a farm-input shop says what kind of input each item is on
  its item form.

**Who may import.** Products need *Add products, services, categories and
units* (`catalog.create`), updating them `catalog.edit` and opening stock
`inventory.edit`; customers and suppliers need `contacts.create`, and
updating them `contacts.edit`. Someone tied to one location brings opening
stock into that location only, and someone tied to a department imports
that department's items. Each import is one line of the **Activity log**
(*Products imported from a CSV file*, with the file's name and what it did),
and each item or contact it makes or changes has its own line, as when made
by hand.

### GST rate changes

The GST Council now changes GST rates once a year, announced ahead and in
force from 1 April. **Products & services › GST rate changes** enters a change
before its day; on that day it takes effect by itself, on your own date, and
bills made before keep their rates. Entering and cancelling a change needs
*Change prices, tax, categories, units and pack sizes* (`catalog.edit`);
everyone who sees the catalogue sees the changes.

The yearly change, step by step:

1. **New GST rate change**.
2. **Which items**: pick them by the slab they are at now (*Now at*), a
   category (its sub-categories come with it), the first digits of their HSN
   or SAC code, or a name or code; tick *Switched-off items too* to include
   those.
3. **The change**: the slab they move to (*Moves to*; add it first under
   *Settings › Tax rates* if it is new) and the first day of the new rate
   (*From*, which starts on the next 1 April; any day from tomorrow, within
   two years). If your prices include GST, they keep their total and the GST
   inside them is worked out again; tick *Keep the price before GST instead*
   for the price to move with the rate (its member and branch prices too).
   Prices before GST always stay as they are.
4. **Preview**: each item with its slab, price and GST now and from the day,
   and what the customer pays. An item already at that slab then is not ticked;
   one that cannot move says why (above its MRP, already moving that day, a
   fuel, a jewellery item or a room type, which keep their own rates).
   Untick any item that should stay.
5. **Reason** (the notification, for example "GST Council notification of 15
   March 2027"), then **Schedule for N items**. Sent twice, it is still one
   change.

The list shows the changes still to come first, then those in force and those
cancelled. **Open** shows a change's items and what happened to each; before
its day, **Cancel the change**, or **Cancel** on one item, with the reason.
From its day it is kept for good. On *Products & services*, an item's GST
column shows a change still to come under its slab, and **GST history** (on
its row) lists every change that moved it or is to move it, with who entered
it and why, and each time its slab was changed on the item itself.

- **From the day**, every sale, Quick bill, quotation and price uses the new
  slab. An order priced before it (a garment order, a spectacle order, a job
  card, a hire, a sales order) is billed at the rate of the bill's day: a price
  that includes GST keeps its total, one before GST its value before GST. A
  quotation made before is revised (its prices again at the day's slab), then
  billed.
- **A change for today** is made on the item itself (*Edit*, its GST slab).
- A kit's own rate follows its parts by itself.

### Daily money, expenses and cashier shifts

**Daily money** (Daily work) is every type's day close. For a day or dates,
and one location or all: sales and bills, the *Net cash movement* (cash in,
less refunds, supplier payments and expenses), money in, and what was given
on udhaar; then the takings by payment method (and by the names your counter
uses), by person and by location, and *What went into these figures*. It also
takes off an advance handed back to a customer (under *Refunds*) and a cheque
that bounced (on the day it bounced, under *Cheques bounced*), so the money
figures match what is really in hand. **Print end-of-day slip** prints it on
the till printer, with lines for the cash counted and a signature.

- **Cash check** (one day, one location): **Count cash** takes the opening
  cash and the cash counted; the server works out what the drawer should hold
  and the difference, which needs a reason. It saves a snapshot and trading
  carries on; a later count is listed under it. Needs *Record a daily cash
  check* (`reports.edit`).
- **Cashier shifts**: at Quick bill each cashier presses **Open shift** with
  the cash in their drawer, and **Close shift** to count it. The count is
  blind: the cashier types what they counted, and only then hears whether the
  drawer is short or over and says why. Daily money lists every shift of the
  day with what it should hold, what was counted and the difference; a closed
  shift cannot be changed.
- **Expenses** (a tab of Daily money; the page says *Daily expenses*): money
  already paid for running the business — rent, electricity & water, wages,
  transport, shop supplies, cleaning, maintenance, other — with how and when
  it was paid and at which location, dated up to 30 days back and never
  ahead. Supplier bills and stock stay in Purchases. **Record expense** needs
  `expenses.create`; a mistake is **Reversed** with a reason
  (`expenses.approve`) and the record stays. Paid expenses count in Daily
  money.

### Payment methods

**Settings › Payment methods** names the ways the business takes money as the
counter says them: PhonePe, Paytm, Sodexo, the
bank account. Each is one of five kinds — Cash, UPI, Card, Bank transfer or
Cheque — which decides how it is counted (cash in the drawer, cheques to the
cheque register); the kind is fixed once made. **Add method**, **Edit** (with
an *Order*: lower comes first at the counter) and **Switch off**: a method
switched off stays on past bills but is not offered again, and the last one
switched on stays on. A new business starts with Cash, UPI, Card, Bank
transfer and Cheque. Every screen that takes or pays money offers the names,
and Daily money adds takings up by kind and by name.

### Purchases: receiving, free goods, discounts, purchase orders, paying suppliers

- **Receive a purchase** (Purchases) records what came in; stock goes up at
  once, at its cost. It takes the supplier's bill number and date: the same
  bill from the same supplier cannot be entered twice, and the purchases list
  searches by it. Scan a barcode to add a line; the item's pack size is the
  default unit. *Update selling price / MRP from this bill* (with
  `catalog.edit`) takes the bill's prices onto the items, and after saving,
  *Print N labels* opens Barcode labels with what arrived (the MRP struck
  through when the item sells below it).
- On a purchase, each line takes **Free** (scheme goods, "10 + 1 free": they
  come into stock at no cost, so every unit costs the line's net divided by
  the whole quantity) and **Disc %** (the supplier's trade discount on the
  rate). The supplier box searches as you type, and **+ New supplier** adds
  one without leaving the purchase.
- **Purchases › Purchase orders** is there for every business that keeps
  stock. **Reorder suggestions** for one branch lists what to order — up to
  each item's reorder level, less what is in stock and already on order, in
  whole cases, from the supplier it was last bought from, at its last cost.
  Tick lines, change quantities and *Raise draft orders* (one per supplier).
  **New purchase order** raises one by hand (cost per case or per piece,
  before GST; left empty, the last cost). A draft can be changed; *Mark sent*
  records how it went (WhatsApp, email, printed, phoned) and *Print* gives the
  A4 order. *Receive goods* posts an ordinary purchase with the supplier's
  bill (batch and expiry for batch items; a line at 0 if it did not come), in
  parts until everything is in. *Close short* when the rest will not come;
  *Cancel order* when nothing came. An order past its expected date and not
  all in is marked *Late*.
- **What you owe suppliers** (Suppliers): what is overdue by each supplier's
  credit days, and the oldest unpaid receipt. **Pay** settles the oldest
  receipts first, or the receipts you choose, or records an advance (a cheque
  needs its number), with a printable voucher. **Statement** shows what was
  billed and paid with the running balance, and prints.

### Shop extras: shelf, branch and member prices, coupons, departments

For shops that sell goods, each where its tool is on:

- **Shelf location** on an item ("Aisle 3 · Shelf B", "Backroom"), shown in
  the products list.
- **Branch prices** (a product's row, with two or more branches): a branch can
  sell an item at its own price; without one it sells at the item's price.
  Offers, member prices and customer prices still apply.
- **Member price** (with Loyalty points on): what a loyalty customer pays when
  the bill names them, below the selling price. Quick bill marks the line
  *member price* or *this branch's price*.
- **Coupon codes** on an offer (Offers & discounts): with a code the offer
  applies only when the cashier enters it under *Coupon* at Quick bill, with
  an optional limit on uses in all and per customer.
- **Opening hours** for each location (Settings › Locations), shown in the
  list.
- **Departments** (Products & services › Categories, for a store with departments such as
  Clothing, Home, Grocery): a top-level category belongs to one. In Staff &
  access a person can be tied to one department and then sees and changes its
  products and stock only (billing stays open to every item); a manager tied
  to a department gives access, and sets new passwords, only for the people
  of that department. Reports shows each department's sales, returns and
  margin.

### Quotations

A quotation is an estimate at today's prices with a date it holds until. Every
type but a restaurant can switch on **Quotations** (Settings › Business
tools); a hardware shop starts with it, and it is recommended for a garage, a
general store, an optical shop, a jeweller and a wholesaler. It is under
*Sales history › Quotations*.

- **New quotation** — choose a saved customer, or type the name and phone of
  someone who is not one yet; set *Valid until* (a week ahead to start with,
  at most 180 days); add lines as on a new sale (search or scan the item,
  pick its unit or pack — *Coil of 25* — and the quantity). Every figure is
  the server's: the same calculation that prices a sale of these lines now,
  with customer and slab prices, branch prices, running offers, GST and
  round-off. A manager may give a discount with a reason, up to the
  business's counter limit. Saving gives it a number (*QT/2627/0001*, in
  Settings › Number series). Nothing leaves stock.
- **Print (A4)** and **Share on WhatsApp** — the quotation under the
  business's own header, laid out like its bills, with HSN, GST and the date
  it is valid until; or the same as a message to the customer's phone.
- **Revise** — while it is open: the lines are priced again at today's
  prices, the number stays and the revision goes up. Each revision is listed
  on the quotation with the totals before and after.
- **Expired** — an open quotation past its date. Its prices may be out of
  date, so it cannot be billed until it is revised.
- **Make the bill** — the customer agreed: the bill is posted at the quoted
  prices, its stock leaves this location, and the quotation shows *Billed*
  with the bill's number. A customer who is not saved pays the whole bill
  now; a saved customer may pay part or none, and the rest goes on their
  dues. Items kept by batch go out oldest expiry first (a line can go over
  two batches and still adds up to the quotation); serial-numbered items need
  their numbers chosen. The bill is refused, with the reason, when the item's
  GST rate, its pack size or the business's rounding changed since, or when
  the quoted rate is now above the item's MRP: revise the quotation first.
- **Make a sales order** — with Sales orders on: an order at the quoted
  prices for a saved customer, sent later in parts, each dispatch with its own
  bill and delivery challan. A quotation with a service on it is billed
  instead.
- **Cancel** — with a reason. A billed, ordered or cancelled quotation never
  changes.

Who does what: a cashier makes, revises, prints and bills quotations; a
manager also cancels them; an accountant and a viewer see them (the
accountant prints them too).

### Licences

The licences and registrations a business must hold, kept for each location
with the dates they are valid. Every type but a restaurant can switch on
**Licences & registrations** (Settings › Business tools); a seeds,
fertilisers & pesticides shop starts with it, and it is recommended for an
optical shop (the MD-42 registration for contact lenses), a jeweller (the BIS
registration), a fuel station (the PESO licence) and a pharmacy (its trade
licence, FSSAI and other registrations; drug licences stay in Pharmacy
settings). It is under *Settings › Licences*.

- **Add a licence** — the location that holds it, its kind (the trade's own
  first: a fertiliser authorisation letter, a seed dealer licence or an
  insecticide sale licence at a farm-input shop; then a trade licence, a
  shops & establishments registration, FSSAI, or another licence), its name
  as issued, its number, the issuing authority, *Valid from* and *Valid
  until*, or *It does not run out*. At a farm-input shop, *What it lets this
  location sell* ticks fertilisers, seeds or insecticides: bills of those at
  that location need the licence in force. Such a licence says who it
  *Sells to*: *Retail*, *Wholesale* or *Both*, as the licence says (a new
  fertiliser authorisation starts as retail, a seed or insecticide licence as
  both). A sale to a buyer with a GSTIN (a B2B invoice) is a wholesale sale
  and needs a licence for wholesale sales. *Qualified person (optional)*
  keeps the person the licence names, with their qualification (and its
  certificate's number) or why they are exempt, as written on it. One number
  is kept once for a kind of licence.
- **The list** shows each licence's number, location, dates, the days it has
  left, its scanned copies and where it stands: *Valid*, *No expiry*, *Runs
  out soon* (60 days or fewer), *In force: renewal pending*, *Run out*, *Not
  yet valid* or *Switched off*. The location filter narrows it; *Show
  switched-off licences* brings back those switched off. A licence's name, or
  *Open*, opens it.
- **A licence, opened** — its *Summary* (with *Edit*), *Renewal applied
  for*, *Scanned copies* and, by what it covers, an insecticide licence's
  *Endorsements* and *Principal certificates*, and a fertiliser
  authorisation's *Certificates of source (Form O)*. A record that no longer
  stands is switched off (a principal certificate is withdrawn); none is
  deleted.
- **Scanned copies** — *Add a copy*: a PDF or a photo (JPG, PNG or WebP) of
  the licence, up to 5 MB. Each copy is kept with the dates the licence had
  when it was added, so each renewal's copy stays beside the earlier ones.
  *Open* shows it; only someone who may see the licences of that location
  can open one, and a copy is never changed or deleted.
- **Renewal applied for** — once the renewal is applied for, *Record the
  renewal applied for* with the date and the application's reference. What
  it does once the licence is past its date is the kind's rule, which the
  window says: an insecticide sale licence stays in force while the renewal
  is pending; a fertiliser authorisation only when the renewal was applied
  for within one month of its date; any other licence, a seed licence too,
  runs out on its date. Bills under a licence kept in force this way carry a
  warning at the counter, and the bell warns until the renewed licence comes.
  *Take the mark off* if it was recorded by mistake.
- **Renew** — *Edit* the licence and give its new *Valid until*; the activity
  log keeps the dates before and after, and a renewal applied for ends. Then
  add the renewed copy. A licence keeps its location and kind: a licence for
  another location is added on its own.
- **Endorsements** (an insecticide licence) — each item, every pack of it, or
  each brand endorsed on the licence: *Add the endorsement*. Selling an
  insecticide that is not endorsed warns or stops the bill, as *Settings ›
  Farm input checks* says.
- **Principal certificates** (an insecticide licence) — *Add a certificate*
  for each manufacturer: its name, spelt as the items name their
  manufacturer, the registration and manufacturing licence numbers, the
  formulations it authorises and its dates. *Record the withdrawal* when the
  manufacturer withdraws it: from that day its insecticides are not covered,
  and a new certificate is added on its own.
- **Certificates of source (Form O)** (a fertiliser authorisation) — *Add a
  certificate* for each source: the supplier whose deliveries it covers (or
  the source as the certificate names it), its number and date. Fertiliser
  received from a supplier with none comes in with a warning.
- **Switch off** — untick *In use* once a licence is surrendered or
  cancelled. It is never deleted, and stays in the list with the filter.
- **The bell** warns 60 days before an active licence runs out, and again,
  in red, once it has; a licence past its date and in force only while its
  renewal is pending is warned about, with the renewal's date and reference,
  until its new date is typed.

Who does what: a manager adds and changes licences; an accountant and a
viewer see them.

### Personal data

The DPDP Act 2023 and Rules 2025 make the business answerable for the
personal data of the people it serves: its customers, members, hirers,
lodgers and patients, and a restaurant's guests. Every business has the same
screen, under *Settings › Personal data* (a restaurant's under its own
*Settings*), and the same habits at the counter. The rules behind it are in
[BUSINESS_RULES › Personal data](BUSINESS_RULES.md#personal-data).

**First, publish the privacy notice.** *Settings › Personal data › Notice &
contact* offers a starter text, item by item: what the business collects and
why, what it sends only with a yes, how to see, correct or erase it, how to
complain, and whom to contact. Change what does not fit, name the privacy
contact (a name, and a phone or an e-mail), check the three short consent
notices (bills on WhatsApp or SMS, reminders, offers) and *Publish*. From then
on every bill and receipt prints one line with the contact, and the guests'
site shows the notice where it takes a guest's name and number. A change is
published as a new version; the earlier ones are kept, and each consent keeps
the version it was given on. Until it is published, no consent can be taken
and the bell says so.

**Consent at the counter, in one tap.** Wherever a customer is taken (the
customer's form, *+ New customer* at Quick bill, a member, hirer, lodger,
owner, farmer or client added on a type's own screen, a restaurant's guest
form), three chips ask what they agree to be sent: *Bills on WhatsApp*,
*Reminders*, *Offers*. Read them the line of the notice for each and tap what
they say yes to; none is needed for a sale, and a phone number never is. On a
customer chosen at Quick bill or the restaurant's till, a tap records it at
once. To withdraw one, let its chip go on the customer's form and save.

**A message asks first.** A WhatsApp bill, a quotation on WhatsApp, a dues,
renewal, recall, service-due, appointment, package, gold-scheme or site-dues
reminder, and a reminder call go only to someone who agreed to that purpose;
at a restaurant, so do a call from Guest insights' lists and the mobiles copied
there for a broadcast (offers: the copy leaves out whoever has not agreed, and
a call to an unhappy guest about their complaint needs none). Without it the
button opens *Ask … first*: read the line shown, and if they
say yes, *They agree: send it* records it and sends. A walk-in with no record
is saved as a customer (a guest) first: the consent is kept on their record.
Messages about what they asked for (ready for collection, a booking confirmed)
go as before.

**A child.** On a saved customer's form, *Mark as a child* records the parent
or guardian who gives consent for them, how, and how you saw they are the
guardian; offers stop and are never taken for them. A gym, a coaching centre,
a clinic or a laundry meets children most.

**Requests.** When someone asks to see, correct or erase their data, or
complains, *Log a request* the day it comes: what they ask, who (find them, or
type the name and link them later), how it came in and where to reply. It is
due 90 days later on the business's own clock, and the bell warns from 15 days
before. Open it to answer:

- **See their data:** *Save their data as a file* saves everything held about
  them, from every screen, to send them; then *Record the answer*.
- **Correct their data:** change it on their record, then *Record the
  answer*.
- **Erase their data:** *Erase their data* removes their personal details
  wherever no law keeps them, closed records included, and answers the
  request. Bills and other tax records keep what tax law needs; the request
  lists what was erased and what is kept, and why, for the accountant. It
  waits for anything still open with them (money they owe or hold, an order,
  a booking, a running membership), and says what. A clinic's registered
  patient stays with the medical records.
- **Refuse, with the reason,** when it cannot be done.

**A breach.** If personal data is lost, stolen or seen by someone who should
not see it, *Record a breach* at once: when it was found, what happened, the
impact, the steps taken, and who is affected (chosen by name, or every
customer). The breach shows the hours left for the Data Protection Board's
detailed report, 72 from when it was found, and the bell keeps warning until
it is recorded. The notice to the people affected is filled from the record
with the privacy contact; send it to each from the business's own WhatsApp,
SMS, e-mail or by hand (*Send the notice*), and record each one. Record when
the Board was told and when the detailed report went, with its reference,
then *Close the breach*. Nothing is filed from here: the business tells the
Board and the people itself.

Who does what: the owner and a manager keep the registers and publish the
notice (`privacy.view`, `privacy.manage`) and alone see or export a person's
whole data (`privacy.export`), each view and export logged; whoever takes
customers (a cashier included) records what they agree to.

## Retail counter (grocery / kirana, supermarket, books & stationery)

- **Quick bill** is the counter ([below](#quick-bill)).
- **Offers & discounts** — six kinds (percentage off, amount off, buy X get Y,
  and so on), each described in words ("Buy 4 Instant noodles, get 1 free"),
  with dates, weekdays and hours. The best offer applies by itself (one with a
  coupon code only when the cashier enters the code). *What offers gave away*
  shows the cost for a period. Switching an offer off never changes old bills.
- **Loyalty points** — rules in words (points per ₹, value of a point, the
  minimum to redeem, the most of a bill points may pay). Points never go below
  zero. A return takes back the points its bill earned; if they were already
  spent, their value is held back from that bill's refund. Corrections need a
  reason. Points **spent** on a bill come back, in proportion to the goods
  returned (switch off with *Give back spent points on returns* in the
  rules).
- **Udhaar** (customer credit; the menu says *Customer dues* in a supermarket
  or bookshop) — who owes, how much is overdue, the oldest unpaid bill, credit
  limit used, the last reminder and the promised date (broken promises in
  red). *Collect* settles the oldest bills first and keeps
  the rest as an advance. *Remind* opens WhatsApp with the message, or records
  an SMS, call or visit. *Statement* prints or shares a running balance.
  Collections are numbered receipts and are never edited.
- **Barcode labels** — give barcodes to items that have none, then print A4
  label sheets (24, 40 or 65 a sheet, starting part-way on a used sheet).
  Shops selling by weight also set each loose item's **weighing-scale code**.
- **Book details** — title, author, publisher, edition and ISBN; the ISBN
  becomes the barcode and a wrong check digit is caught.
- **Booklists & orders** (bookshops) — *School sets*: a school's list for a
  class under one code; scanning or typing the code at Quick bill puts the
  whole set on the bill, and its lines can still be changed. *Customer orders*:
  a book asked for and not on the shelf — title, the customer and their phone,
  and an advance kept on their account with a numbered receipt — then
  **Arrived** (tell them on WhatsApp) and **Collected**.
- **Expiring soon** (Stock) — batches with stock that run out of date within
  the days set in Business settings › Rules, expired ones first. **Mark down**
  sells every batch of the item at a lower price until the last day (the shelf
  price stays); **Write off** takes the batch out of stock.
- **Retail reports** — top sellers, slow movers, margin by category, stock
  value at cost and at selling price.

### Quick bill

**Quick bill** (Daily work) is the counter of every goods shop: grocery,
supermarket, books, fashion, electronics, meat and other weight shops, and a
pharmacy for the medicines it sells without a prescription. Every figure on it
is the server's quote, worked out exactly as the bill will be posted, so
offers, points, the counter discount, GST and round-off are never guessed in
the browser.

**Adding items.**
- Scan a barcode, a weighing-scale label (it bills the weight printed on the
  label), a book's ISBN or a phone's IMEI or serial number (that very unit is
  billed; a unit already sold or at another location says so), or type part
  of a name: ↓ and ↑ move through the matches and Enter adds the highlighted
  one (the first by default). The shelf below shows every item as a button
  with its price and what is in stock at the selling location, narrowed by
  typing and by category; sold-out items stay on it, greyed.
- A garment shop has **Size & colour**: find the style, then tap the size
  under its colour.
- Loose items have weigh buttons (250 g / 500 g / 1 kg / 2 kg unless changed
  in Business settings › Rules); a weighed item starts empty and waits for its
  weight, or for an amount in ₹. Counted items have − and +.
- Batch items take the batch that expires first (you can change it).
- A bookshop's school set: scanning or typing the set's code puts the whole
  booklist on the bill, and its lines can still be changed.
- **Kits & bundles** (Products & services › Kits & bundles): "phone + cover + screen
  guard" at one kit price. Scan the kit's barcode or code at the counter: its
  parts are listed under it, a phone in it gets its IMEI (change it from the
  list), stock comes off each part, and the invoice shows each part with its
  own HSN and GST, the kit's price shared out by the parts' own prices. *Can be
  made* shows how many kits the stock allows.

**The customer.** Pick the customer by name or phone for udhaar, points or a
warranty, or add a new one on the spot; otherwise the bill is a walk-in's. The
customer card shows what they owe, how much is overdue, the credit limit left
and their last promise to pay (red when broken), with *Collect udhaar*.
Choosing udhaar warns when they are overdue, have broken a promise or would go
over their limit. **A walk-in pays the whole bill**, unless *Walk-in
customers* is set to *May leave a bill unpaid* in Business settings; the
Sales list's *Walk-in bills not fully paid* filter finds the bills that were
left unpaid.

**Discounts, coupons and vouchers.**
- **Discount on this bill** (₹ or %) with a reason, for roles holding
  `sales.discount` (Manager by default), up to *Most discount at the counter*
  in Business settings (10 % unless changed; the owner is not limited).
- **Coupon**: an offer with a coupon code applies only when the cashier types
  the code here ([Shop extras](#shop-extras-shelf-branch-and-member-prices-coupons-departments)).
- **Credit voucher** (where exchanges are on): scan or type CV… and the voucher
  pays first; *Left to pay* is what is left for cash, UPI or card.

**Paying.**
- **One payment method per bill**: cash (F6), UPI (F7) or card (F8), by the
  business's own payment methods, or **Udhaar** (F9) with an optional part
  paid in cash. Only an EMI sale's down payment can be split
  ([EMI & financiers](#emi--financiers)).
- Type the cash handed over, or tap a quick cash button (the exact amount and
  the next round sums above it), and Quick bill shows the change. Change is
  only ever given from cash. *Cash received* left empty means the exact
  amount, and Enter in it takes the payment.
- The pay card heads the right-hand column and stays in view, so *To pay* and
  the take-payment button never leave the screen. On a phone each line is one
  compact row, and a bar at the foot shows *To pay* with *Take payment*.

**Large bills.**
- **Cash limit:** no bill takes ₹2,00,000 or more in cash, and no customer
  pays that much in cash in one day across their bills and udhaar
  collections (Income-tax Act 2025, section 186). The payment that would
  reach it is refused with what to do: take the rest by UPI, card, bank
  transfer or cheque.
- **Buyer's PAN:** a bill over ₹2,00,000 needs the buyer's PAN. A customer
  with their PAN or GSTIN saved needs nothing more; otherwise a *Buyer's PAN*
  card asks for it, or for a tick that the buyer has no PAN and signed a
  declaration (Form 97). The invoice prints it under the buyer. Save a
  regular customer's PAN in *Customers* (Edit › PAN) to skip the card.

**Keys.** F2 find an item · F4 customer · F6 cash · F7 UPI · F8 card · F9
udhaar · F10 hold the bill · F12 or Ctrl+Enter take the payment. Each has an
Alt twin for laptops and browsers that keep the F-keys: Alt+S, Alt+C, Alt+1 to
Alt+4 and Alt+H. After a bill, Enter or F2 starts the next and P prints the
receipt.

**Holding and looking back.**
- **Hold** (F10) parks the bill so the next customer can be served; up to five
  bills can be held in the browser tab, and each is recalled with a tap.
- **Last bill** reopens the last one: reprint, the A4 invoice, returns.
- **More › Return** finds a bill by its number, the customer or their phone
  (today's latest first) and opens *Take back items* on it.

**Who is billing.** The button with your name at the top of Quick bill
switches the till to another cashier: pick the name, type that person's PIN;
the bill being built stays and every bill records who billed it. In Business
settings › *Shared till* you can ask the biller's PIN for **every** bill.
Then the PIN typed to switch the till counts for the next bill, so the
cashier who has just switched to themselves is not asked again: for that one
bill, within 2 minutes of the switch, on that screen. After it, or a page
reload, the PIN is asked as usual.
PINs are each person's own (My profile, or set by an admin under Users); five
wrong tries lock a PIN.

**The till.** Only locations that sell at the counter are offered as the till
(Settings › Locations › *Sells at the counter*). The till is remembered on the
device, and changing it with a bill on screen asks first. **Open shift** and
**Close shift** are the cashier's own drawer count ([Daily money, expenses and
cashier shifts](#daily-money-expenses-and-cashier-shifts)).

**The receipt and the invoice.** The till receipt (80 mm, or 58 mm under
Business settings › Rules) shows what each line saved, GST by rate and the
payment; a bill on udhaar prints *Earlier udhaar · This bill on udhaar · Total
udhaar now*. **Tax invoice (A4)** carries the seller's legal name, GSTIN,
address and state; the buyer's name, address and GSTIN as billed; the place of
supply (the buyer's GSTIN state, else the shop's); per line the HSN, quantity,
rate, discount, taxable value, GST rate and CGST + SGST or IGST; then an HSN
summary, the round-off and the total in words. Rows of ₹0 tax are not printed;
exempt and nil-rated items show *Exempt* in the GST column and the HSN
summary. A business with no GSTIN gets a warning on the A4 copy that it is not
a GST tax invoice.

**The Sales list** (*Sales history*) opens on today, with *Billed by* and
*Paid by* (cash, UPI, card, bank, mixed or not paid) columns, and filters by
payment, by who billed it (for roles that see staff) and by location.

## Wholesale / FMCG

The wholesaler's **Sales orders** entry (Daily work) holds Sales orders,
Back-orders, Dispatch, Price groups & schemes, Price lists and Routes &
salespeople. Its money screens are **Outstanding** and **Collections**,
named *Customer dues* and *Payments received* in the menu.

**Set up once.** **Routes & salespeople**: routes (the godown the van loads
from), beats (route, weekday, salesperson), which customer is on which beat,
and the salespeople. Each customer's **trade details**: beat, price group,
state and PIN code, contact person, PAN, FSSAI number, and whether it is a
trade or a walk-in customer.

1. **Taking an order.** A sales order is the order a shop gives your
   salesperson: customer, godown, salesperson (taken from the customer's
   beat), and lines in pieces or cases. Search the shop by name, phone or beat
   (today's beat first; walk-in customers are left out). The card shows what
   they owe, what is overdue and how late, the credit left and their last
   order; *Repeat last order* copies it. Add items by name, code or barcode
   (Enter adds); type cases and pieces on one line, with a discount % and free
   goods per line for those allowed to give discounts. The server prices the
   order (the customer's own price, then the quantity slab, per case when
   ordered in cases), applies schemes and price groups, and checks the credit
   limit against what the customer owes **plus** orders not yet sent. Taking
   an order moves no stock.
2. **Changing an order.** *Change order* on an open order changes quantities
   and removes or adds lines. The dialog lists what was already sent (it
   cannot be changed) above the lines still to send. A reason is required,
   and is kept with the order and in the activity log. *Drop rest* closes the
   odd remainder of one line (also on Back-orders).
3. **Dispatch and the delivery challan.** Send all or part. The Dispatch board
   shows the orders waiting by route, beat day and wanted-by date: tick
   orders, print the *Pick list*, then *Send on one van* (vehicle, driver,
   helper). Stock leaves oldest expiry first, and each order gets its own tax
   invoice at the order's prices, even if the list price has changed. Print
   the *Load sheet* (goods, shops, amount to collect, a signature column) and
   *All invoices*. *On the way*: *Delivered*, or *Came back* (goods back to
   stock, the invoice credited). The e-way bill and the transporter can be
   filled in later; they print on the invoice. Every dispatch also gets a
   **delivery challan** number from its own series per location and financial
   year (DC/2627/0001; Settings › Number series). *Challan* on Dispatch › On
   the way, or on the order's dispatch: check the transporter, vehicle, LR /
   docket and e-way bill number (typed in from the GST portal), then *Save and
   print challan* (A4, with consignor, consignee, batches, values and three
   signature boxes).
4. **Back-orders.** What was not sent stays a back-order. Back-orders lists
   every line still to send, oldest first, with the stock at the godown (shaded
   when short). *Close the back-order* or *Cancel order* needs a reason.
5. **Purchase orders.** As in every shop that keeps stock
   ([Purchases](#purchases-receiving-free-goods-discounts-purchase-orders-paying-suppliers)).
   A wholesaler's *Reorder suggestions* also count the customers' back-orders
   the stock cannot cover.
6. **Price groups and schemes, with free goods.** Price groups (retailer,
   wholesaler, HoReCa…) hold dated prices per case or piece, and *Revise
   prices* raises them by a percentage from a date. *Add a scheme*: buy N
   (cases or pieces) of an item, get M free of the same item or of **another
   item** (with its pack), and/or a discount %; tick *Don't combine with slab
   prices* when the scheme must not stack on a case slab. Free goods go on the
   invoice at ₹0 as "Free · scheme name" and leave stock.
7. **Credit hold.** Outstanding › More › *Credit hold rules*: hold new orders when a
   bill is more than N days overdue. A held order needs a reason and a
   manager's PIN (or a manager taking it). A customer can be marked *never put
   on credit hold* on their details.
8. **Cheques and bounces.** Collections › Cheques: to deposit, post-dated,
   deposited, bounced and cleared; *Deposit*, *Cleared*, *Bounced*. *Bounced* pre-fills
   the bank charge from the business setting (₹500 unless changed; change it
   for this cheque or put 0). Exactly the bills that cheque settled open
   again, and the charge goes on the retailer's account. A retailer reaching
   the bounce limit (2 in 90 days unless changed) is put on credit hold for
   new orders until a manager lets one through. Outstanding › More › *Credit
   hold rules* sets the overdue days, the bank charge, and the bounce limit
   and window.
9. **Outstanding and collections.** Balances in 0–30 / 31–60 / 61–90 / 90+
   day buckets (or the age groups set in Business settings › Rules);
   statements that start from the oldest unpaid bill; numbered collection
   receipts by cash, UPI, bank, cheque (number required) or card, settled
   oldest first or against the bills you choose, or kept as an advance. Follow
   up with a *WhatsApp* reminder, a *Promise* (date and amount) or a call from
   the phone number, and *Print statements for overdue customers*.
10. **Salesperson settlement.** Collections › Salesperson settlement: pick the
    salesperson and day; cash, UPI and cheques collected; type the cash handed
    over; a shortage or excess needs a note. *Enter receipts* takes several at
    once.
11. **Claims on suppliers.** Scheme money, damaged or expired goods, rate
    differences: open → sent → settled with the credit note.
12. **Reports.** *Wholesale reports*: by salesperson, route or customer;
    collections by day, method, salesperson and route; outstanding by route or
    salesperson; and *Schemes by retailer* (the orders that earned each
    scheme, what was bought and sent, the free goods sent and their value, and
    the discount given).

## Fashion

- **Size × colour** — *New product with sizes* creates the whole grid at once:
  one item per size and colour, each with its own code, in-store barcode,
  price and stock. Opening a product shows stock by size and colour (red =
  none left, amber = at reorder level); the price shows once per size, and a
  cell shows its own price only when it differs. The grid stays a grid on a
  phone (colours pinned, sizes scroll). Tap a size to change its price,
  barcode or reorder level, print its tags, receive stock or see *How it
  sells*. *Tags for stock* prints a garment tag for every piece in stock.
  *More* adds sizes or colours, sets prices by size or colour, and *Type the
  maker's barcodes* gives one box per size and colour (a scanner moves on with
  Enter), so the maker's barcode bills the piece instead of the in-store one.
- **Receiving and tags** — *Receive stock*: a cost per size (or one for all
  sizes), the supplier's bill number and date, *Add another style* for the
  rest of the same bill, then *Print N tags* for what arrived (garment tag:
  style, size, colour, MRP including GST).
- **Exchanges** — find the sale by scanning the item coming back (one match
  opens at once, with that piece ticked), by the customer's phone or by the
  bill number; a manager can exchange a gift with no bill (*No bill (gift)*,
  set against the latest sale of that item within the policy). Choose what
  comes back (and whether it goes back to stock), scan what goes out (*Swap
  size / colour* opens the style's grid), *Work out the difference*, then
  collect it, refund it (needs the refund permission too) or keep it on the
  customer's account. The exchange policy (how many days after the sale) is
  shown and set here. Credit kept on account can be used on that customer's
  unpaid bills.
- **Credit vouchers** — an exchange that leaves the customer owed money can
  print a voucher (valid 90 days unless changed in Business settings › Rules;
  walk-ins too); at Quick bill, *Credit voucher* takes it first. *Open credit
  vouchers* are listed on the Exchanges page.
- **Markdowns** — tick styles on Size × colour (or mark down from a style or
  from the reports), then *Mark down*: % off until a date. A markdown is an
  offer of the Offers module, so the shelf price never changes: the price goes
  back by itself after the end date, and *End now* stops it early. The list
  shows the markdown and its last day beside the price, and the bill shows the
  discount.
- **GST on clothing by price** (Size × colour › More): 5 % up to ₹2,500 a
  piece, 18 % above, decided on each bill line after discounts.
- **Variant reports** — pieces sold, returns, net sales, stock and
  sell-through, by variant and added up by size and by colour; **By style**
  with the size curve (each size's share of sales, red when the size is sold
  out) and stock age; **Broken sizes** (a middle size sold out while others of
  the colour are left), each with *Reorder* and *Mark down*.

## Electronics

- **Serial / IMEI register** — every serial-numbered unit and where it is: in
  stock where, on the way, sold to whom, back to the supplier, written off,
  with how long it has been in stock. Open a unit for its full history and to
  record a second IMEI. A unit can be in one place only, a number belongs to
  one item only, and an IMEI must pass its check digit when it is first
  received. **Scan phones in** receives a delivery: the model and cost once,
  then IMEI 1 / IMEI 2 per box (or pasted from a sheet), every number checked,
  with a running count against the bill. The **Models & warranty terms** tab
  sets IMEI checking, warranty months, terms and the brand's helpline per
  model. **Faulty & back to supplier** holds dead-on-arrival and faulty units
  for the supplier: send them back on a purchase return with an RMA number,
  mark them found fine, or write them off.
- **Exchanges** — a returned unit can be marked *Dead on arrival* or *Faulty*:
  it comes back into stock but cannot be sold, the replacement is linked to
  it, and the warranty moves to the replacement.
- **Warranties** — selling a serial unit registers its warranty with the bill
  (the customer on file, or the walk-in's name, and their phone if they give
  it, typed under *Warranty for*). Look one up by IMEI, serial or phone; register one from a
  sold unit (start date, months and terms filled in from the sale and model);
  print the warranty card (in any state, marked expired or cancelled); cancel
  one registered by mistake, with a reason. *Claims with brands* lists parts
  fitted free under warranty and claimed back from the brand or distributor
  (raised from the repair job; then sent, approved, rejected or credited), with
  what is due from each brand.
- **Repairs** — *Take in a device*: scan the IMEI first (the sale, the warranty
  and earlier repairs come up; a person other than the warranty's owner must
  be confirmed), the customer by name or phone (a walk-in's phone only if they
  want the ready message), the device, the problem,
  accessories, a damage checklist, the screen lock (kept only until the job
  closes), the estimate, the promised date and an advance. The job moves
  through its status steps, each with an optional note, and the next step is
  the main button. Add parts (taken from stock at the job's location) and
  labour. Charges above the estimate move the job to *Awaiting approval* (ask
  on WhatsApp, then *Customer approved* or *Customer declined*). *Tell the
  customer* opens WhatsApp with the message for the stage, noted in the job's
  history. **Deliver and bill** posts the bill and the payment (refused if a
  part is short); **Return unrepaired** closes the job. A closed job is
  frozen. The job card prints the checklist, the advance, the terms, a
  signature line and the job barcode. The Repairs list counts the jobs in each
  status, *Late* and *Not collected* included.

### EMI & financiers

- **Selling on EMI.** At Quick bill choose *EMI*: the financier, the loan /
  agreement number (and DO number, months if you have them) and the down
  payment the customer makes now (cash, UPI, card — several allowed). The rest
  is financed: the customer owes nothing for it; the financier does. The
  customer must be picked, or the buyer's name typed (a phone is optional).
- **EMI & financiers** (a tab of Daily money; the tool *EMI & finance*):
  *Owed by financier* — cases waiting for their payout, expected subvention
  and payout, the oldest case, those waiting over 15 days; *EMI cases* — every EMI bill by date and status; *Financiers*
  — the list, with each one's dealer subvention % (a new electronics business
  starts with Bajaj Finserv, HDFC Bank, ICICI Bank and Home Credit; add
  others).
- **Recording a payout.** *Record payout* on a financier: tick the loans the
  payout covers, check the subvention kept on each (from the payout advice),
  the date, how it came (NEFT, UPI, cheque) and the UTR. The amount must match
  financed less subvention exactly, so a short payout is never written off by
  accident. Daily money shows payouts as money in and the financed part of the
  day's bills apart (not in the drawer).
- **Loan cancelled.** If the goods come back before the payout, take the goods
  back on the bill first, then *Cancel loan* on the case. The customer is
  refunded only what they paid themselves.

### Repair advances

An advance taken at intake prints on the job card and comes off the bill at
delivery. If the device goes back unrepaired, *Return unrepaired* then offers
**Refund the advance** (cash, UPI or bank, a reason and a manager's PIN); a
receipt prints. What is left after a delivery that came to less can be refunded
the same way from the job's *Advance* card. *All jobs* shows the advance and
what is still to refund.

## Salon & spa

- **Calendar** (the *Appointments* entry, beside *Appointment history*) — the
  **Day** view has one column per stylist and per room, each booking drawn at
  its time and length (service plus clean-up) and coloured by service
  category, with a red line at now; the day opens on now. A booking made,
  moved or finished on another device shows by itself, and so does the walk-in
  list. A ₹ mark shows a
  deposit and ★ a member; *Late — not here yet* shows in amber and *Here since
  …* in green, and a stylist's leave, weekly day off and hours outside their
  shift are hatched. The **Week** view shows each stylist's bookings and busy
  hours per day, with a day off or leave named; click a day to open it.
  - Click a free time to book: the client by name or phone (or a new client
    added on the spot), the service, only the stylists who do it (the list
    says who is on leave or off), a room when the service needs one, and a
    deposit. A booking cannot overlap another booking of the same stylist or
    room. After booking, *Send confirmation* opens WhatsApp with the message.
  - On a booking: *Arrived*, *Move* (date, time, stylist, room), a WhatsApp
    confirmation or reminder, the client card, *Book next visit*; the phone is
    a call link. **Drag a booking** to another time or stylist (in 15-minute
    steps, asked first) to move it. Moving never charges the late-cancellation
    fee.
  - **Walk-in** puts a client on the waiting strip, with the time waited and
    the stylist asked for; *Seat* books them from now.
  - More › **Tomorrow's reminders**: tomorrow's bookings, each with *Send* on
    WhatsApp, marked once sent.
- **Deposits, no-shows and cancellations** — a deposit is the client's advance
  and comes off their next bill; a deposit for a future booking stays with that
  booking. Cancelling in good time costs nothing; a late cancellation or a
  no-show keeps part of the deposit (never more than the deposit) as a numbered
  charge. The screen says the amount in words before it applies. **No-show**
  appears only once the booking's time has passed, and **Done** / **Bill now**
  on the booking's day (a booking still to come is cancelled or moved).
- **The client card** — a side panel from the calendar, the bill and the
  history: allergies in red, membership, advance, no-shows, visits and spend,
  usual stylist and birthday; tabs *Visits*, *Notes & formula* (dated and
  kept), *Packages*, *Advance* and *Profile*; call, WhatsApp or book a visit.
- **Clients** (the customers list, as a salon shows it) — **Book** on a client
  opens the calendar's booking with them chosen and their usual stylist, as
  *Book a visit* on their card does; it shows to someone who may book
  appointments.
- **New bill** — services and products on one bill, each line with its stylist
  (for commission). Type a service or product (name, code or barcode) or tap a
  quick chip; the line takes the client's usual stylist, and their package if
  it holds the service. The client's membership discount comes off by itself;
  a package pays for its own sessions until they run out or it expires. Sell
  packages and memberships here too; selling one the client already holds asks
  first. Pay by up to three ways (UPI and the rest in cash, say: one bill, not
  a split bill); add a **tip for the stylist** (not part of the bill; it shows
  on the commission report); give a **discount** with a reason, if your role
  holds `sales.discount`, within the business's cap. Saving posts the bill,
  uses the advance, takes payment and marks the booking done; then *Print*
  (80 mm), *WhatsApp bill*, *Book next visit* or *Next bill* (Enter). A booking
  goes on the bill once: after it is added (or opened from the calendar) it is
  not offered again under the client's bookings, and a booking on a later day
  says *Bill on the day*.
- **Appointment history** — every booking with its deposit, bill or charge,
  walk-ins and moves included; filters by stylist, client and status; a
  client's name opens the card.
- **Packages & memberships** — *Plans for sale* (packages: services ×
  sessions; memberships: % off services and products; validity) and *What
  clients hold* (sessions left, savings, valid till). Tiles show the active
  plans, the sessions not used yet (services still owed) and the plans
  expiring in 30 days. On a plan a client holds: **Book a session**, **Remind
  on WhatsApp**, **Extend validity** (a later date and a reason, kept in the
  activity log), **Usage** (the bills that used it) and **Cancel** (an unused
  plan only).
- **Stylists & services** — four tabs. *Stylists & rooms*: each stylist's
  weekly schedule and leave (*Add leave*), rename, and *Switch off*, refused
  while they have bookings to come. *Service times*: each service's duration,
  clean-up time and whether it needs a room, the stylists who do it, and the
  products it uses. *Holidays*. *Booking rules*: the suggested deposit %,
  free-cancellation hours, late-cancel % and no-show %, calendar hours, and
  whether a package session earns commission on the package's price per
  session or on the service's list price.
- **Weekly schedule, leave and holidays** — *Stylists & services › Stylists &
  rooms › ⋯ › Weekly schedule*: for each weekday *Usual*, *Other hours* or
  *Day off* (Priya 11–6 on Sundays, Neha off on Tuesdays). *Holidays* tab:
  festival days the salon (or one branch) is closed. The calendar greys out
  the hours a stylist is not working and names the leave, day off or holiday.
  Booking or moving outside them is refused; the form then shows **Let it
  through**: a reason and a manager's PIN (a manager booking it themselves
  gives only the reason). It is kept with the booking and in the activity log.
- **Products used in a service** (back-bar) — *Service times › Products used*:
  e.g. Global colour uses 60 ml colour and 90 ml developer. Keep those products
  in ml or g. Billing the service takes them out of stock at once; if the books
  have less, the bill still goes through and the shortfall shows in *Service
  profitability › Products used*. Product cost is the latest purchase price.
  Tick *For use in services only, not sold* on such a product (Services &
  products) and the bill screens leave it out; a clinic does the same for its
  gloves and other supplies.
- **Staff commissions** — rules for everyone, one stylist, services, products
  or one item (the most specific rule wins), each a percent of the value or a
  **flat amount per item** (₹50 a haircut). A package or membership sold is a
  kind of its own (*Package / membership sale*, with its own rule), and a
  session used from a package earns on its value, as the booking rules say.
  Commission is fixed when the bill is saved and reduced by returns. *By
  stylist* shows what each earned, their tips, what was paid and what is due,
  with **Pay out** (amount, method, note) and **Print slip**; *Bill lines*
  shows every line; *Paid out* lists the payouts.
- **Monthly target commission** — *Staff commissions › Target plans*: a plan
  such as 10% up to ₹60,000 and 12% above, paid on the month's net service
  sales (after discounts and returns, before GST). *Each slab at its own rate*
  (default) or *the whole month at the slab reached*. Choose per stylist from a
  month on (*Change plan*); everyone else stays on the flat rules. Products,
  packages sold and package sessions stay on the rules. *Statement* shows the
  month's slabs, the rest, tips, paid and due, and prints.
- **Service profitability** (Reports) — per service: done, sales (after
  discounts and returns, before GST), products used, commission, and what is
  left.
- **A client's advance or deposit** — client card › *Advance*: each receipt
  with money left. *Refund* hands it back in cash, UPI or bank; *Refund /
  wallet* on a deposit held for a booking still to come can instead move it to
  the client's wallet (usable on any bill; the booking then keeps no deposit,
  so a no-show charges nothing). Either needs a reason and a manager's PIN; a
  refund prints a receipt to sign.

## Meat, fish and weight-based shops

- **Overview** — *Today at the counter*: the kg sold, the kg cut (with the
  yield against the templates), the kg wasted (and its cost) and the kg to use
  by tomorrow, then today's next orders for pickup. *Set today's rates* opens
  Today's rates (or says how many rates changed today).
- **Quick bill** works by weight: weigh buttons, scale labels, and a kg / g
  switch to type grams.
- **Today's rates** (Products) — every item sold by weight on one screen,
  built for the phone: the day's opening rate, today's rate, the change, the
  cost per kg of the stock and the margin. Change one, or a whole category by
  ₹ or %, and save them together; Quick bill uses the new rates at once, every
  change is kept in the *Rate history*, and the list can be shared on WhatsApp
  or printed for the counter. A rate above the item's MRP is refused. A hotel
  or caterer on its own rate per kg: switch on *Wholesale price lists* in
  Settings › Business tools, then set *Customer rates*.
- **Orders for pickup** (Sales history) — phone and WhatsApp orders ("2 kg
  boneless for 6 pm"): the customer (saved, or a name and phone), the pickup
  time, and the items by weight or by ₹ worth, each with a note ("curry cut,
  no skin"), listed in pickup order. **Ready** prints a packing slip and
  offers *Tell them* on WhatsApp; **Bill** opens Quick bill with the order's
  items to weigh (an amount in ₹ becomes a weight at today's rate) and its
  customer, and the bill closes the order. An order is cancelled with a
  reason.
  - **An advance.** A saved customer's order takes an advance when it is
    taken (*Advance*, with how it was paid) or later (⋯ › *Take an advance*),
    up to what the order comes to at today's rates. It is a numbered receipt
    in the customer's name, shown in the list's *Advance* column and printed
    on the packing slip. At Quick bill the order's chip names the advance,
    and the bill takes it off first (*Advance … −₹*) and asks only for the
    rest; the bill must be in the customer's name. *Apply advance* on the
    customer's dues leaves it alone while the order is open.
  - **Handing it back.** A cancelled order keeps its advance as the
    customer's money (it can go on their other bills); **Hand back the
    advance** returns what is left of it by cash, UPI or bank, with the
    reason and a manager's PIN (*sales.refund*). An order billed for less
    than its advance shows the rest to hand back the same way.
- **Stock by weight** — every item kept in kg or g per location. It opens on
  **Today**: what each item opened with, what was received, cut in and cut
  out, sold and wasted, and what should be on the counter now, with the
  stock to use by tomorrow marked. **Close the day**: weigh what is left of
  each item; what is short is written off (drip loss unless another reason is
  chosen) and what is over is put back. *Last 7 days* keeps the week: value,
  cost and selling price per kg, margin, and the earliest use-by date.
- **Cutting & processing** (*Sorting & repacking* in a dry-fruit or other
  weight shop) — *Cut / clean* a whole item into its cuts: input item and
  batch, weight in, a **yield template** (a *saved cutting setup*) that lays
  out the expected cuts, then the cuts as weighed. The weights start empty
  (the template's figures are hints, such as "expected 8.5"), only the
  template's cuts are offered (*Add other* for the rest), and *Cut by* records
  who cut it. The screen shows the loss and the yield live. Cutting moves
  stock the moment it is saved, and the cuts carry the whole cost of the
  input, so the cost per usable kg is honest. A cut priced below what the
  whole item cost a kilo (bones, skin, fish heads) is marked **Offcut** on its
  batch. A dry-fruit shop can also
  **repack into pouches** sold by the piece (packs × the pack weight, which is
  remembered).
- **Wastage** — record trimming, spoiled, unsold, drip / moisture loss,
  damaged or other (with a note), from a chosen batch; the cost is shown
  before saving and the stock leaves at once. **End of day** records every
  item with stock in one go, a weight and a reason per row, taken from the
  oldest batches first.
- **Cutting & wastage** report (*Repacking & wastage* in a weight shop) —
  yield by output, by supplier and by day; wastage by item (against what
  sold), by reason and by day; filtered by who cut it and by supplier. *By
  supplier* gives each whole item's average yield from each supplier it was
  bought from in the dates (total usable ÷ total whole weight), its worst and
  best batch, and how far it is from that item's average over all suppliers.
  **Recovered from offcuts** is what the offcuts sold cheap brought in, worked
  out from the bills (before GST, less what came back): in the tile, in *By
  day*, and by item in *Offcuts* with what was cut as offcuts in the dates. A
  bill counts for an item whose latest cut at its location, before the bill,
  was an offcut; the cutter and supplier filters do not apply to bills.
- **Cut to order** (Quick bill) — weigh the whole bird or fish, choose the
  cuts (curry cut, boneless, fillet), weigh each; the screen shows the yield
  and the loss. Saving takes the whole weight out of stock and puts the cuts
  on the bill at their own rates.

## Pharmacy

For a business of type Pharmacy, with the business tool **Pharmacy rules** on (Settings › Business tools, on by default). The rules are standard Indian practice; see [BUSINESS_RULES.md › Pharmacy, clinic and lab](BUSINESS_RULES.md#pharmacy-clinic-and-lab) and check them with your pharmacist and drugs inspector before going live.

**Set up once** (*Settings › Pharmacy settings*): the drug licence numbers you hold (Form 20 / 21 retail, 20B / 21B wholesale, 20F for Schedule X) — they print on every bill; how long the registers and prescriptions are kept (H1 3 years, X and prescriptions 2); whether a scan of the prescription is required (yes); what "expiring soon" means (90 days). Under **Registered pharmacists** add the pharmacist from your staff with their council registration; they sign with their own PIN (*My profile › Personal PIN*). The **Pharmacist** role exists for them.

**Drug master** (*Medicines & products › Drug master*). For each medicine: salt / composition, strength, form, maker, schedule (OTC, G, H, H1, X, narcotic), tablets per strip and strips per box, whether a strip may be cut and sold loose, cold chain and storage. Filter by schedule, or "No details yet" to finish the list. Items with the same salt and strength are substitutes.

**Prescription sale** (Daily work; Quick bill opens from the Overview or *Jump to…*). Find a medicine by name, salt or maker. Each line sells by the strip (or loose tablets when allowed); the batch shown is the first to expire, and the server takes batches first-to-expire, never an expired or recalled one. *Substitutes* opens the same salt and strength, cheapest in stock first, with *Use this*. When a line is Schedule H, H1 or X the **Prescription** box appears: patient, phone (for recalls), age, address, doctor, registration number, clinic, date and a photo or scan (*Take photo / choose file*). For Schedule X the registered pharmacist chooses their name and types their PIN. *Save bill*; print 80 mm or A4. Quick bill still sells OTC medicines; a prescription medicine there is refused with a message pointing here. One payment method pays the whole bill. *Switch* (top right) hands the till to another person by their PIN, as on Quick bill, and with *Ask the biller's PIN for every bill* on, Save bill asks that PIN (except on the first bill within 2 minutes of the switch, as on Quick bill); Schedule X still needs the pharmacist's own PIN. The H1 and X registers show a *Returned* column when goods on an entry came back (the entry itself never changes).

**Registers & prescriptions** (its own entry, under Business): the **H1 register**, the **Schedule X register**, the **prescription log** (click a row to see it and *Open the scan*) and the **expiry returns** with their credit status. Each opens on this month with the dates visible; *Print* gives the register as an inspector expects; *Export CSV*.

**Expiry, returns & recalls** (*Stock › Expiry, returns & recalls*).
- *Expiring by distributor*: batches expiring within 30 / 60 / 90 / 180 days, one card per distributor. *Return on a debit note* → choose the reason and quantities → the stock leaves as a supplier return on that distributor's purchase (what you owe them goes down). A batch with no purchase on record is written off.
- *Debit notes*: each note, claimed and credited; open one to *Print* it or *Record credit note* (their number, date and the amount, which may be less).
- *Recalls*: *Recall a batch* (medicine, batch, alert reference, reason, block now) lists every bill with that batch and the buyer's phone; while blocked, nobody can sell or transfer it. *Close the recall* with how it was handled.

## Clinic & lab

For a business of type Clinics & diagnostic labs, with the business tools **Patient records** (on by default) and **Laboratory** (a new clinic switches it on in Settings › Business tools, where it is marked *Recommended*). In the menu, **Clinic workspace** and **Lab workspace** (Daily work) open the clinic's two screens of their own, for the front desk and the doctors and for the lab ([Clinic workspace](#clinic-workspace), [Lab workspace](#lab-workspace)); **Today's patients** (Daily work) holds the clinic's day in Business Admin — its tabs are Token queue, Visits & follow-ups, Appointments and Doctors, fees & OPD — **Patients** sits beside it, and **Lab orders** (Business) holds Tests & panels and Quality control.

**Who sees what.** The **Doctor** role reads and writes clinical notes (vitals, diagnoses, prescriptions, referrals, results). The front desk (**Cashier**) registers patients, records consent, books and starts visits, bills and orders tests, and sees whether a report is ready — never the notes, nor how many of a report's values are out of range or why a signed report is being amended. The **Lab technician** collects and receives samples and enters results; the **Pathologist** approves reports with their PIN. Every look at clinical data is in the activity log (`patient.clinical_viewed`).

**Set up once** (*Settings › Clinic & lab settings*): the lab's name and registration for reports, the report footer, the consent notice (changing it makes a new version), how long clinical records are kept (3 years), the referral commission switch (off: an ethical and legal question). Under **Doctors and pathologists** add each doctor (registration number, council, their appointment calendar) and the pathologist.

**Today's patients**: the day's appointments by time, whether each is registered (with consent), waiting, in consultation or seen, billed, and whether the lab report is ready. *Register* (front desk), *Start visit*, *Open visit*. Pick another day or one doctor at the top.

**Patients**: *Register patient* — name, mobile, sex, date of birth or age, guardian, emergency phone, then the consent notice: treatment and records (required), reports on WhatsApp / e-mail and reminders (optional), how it was given and by whom; tick that it was shown. A patient's page shows details, the **clinical card** (doctors only: blood group, allergies, conditions, medicines), consents (*Withdraw* records the reason; no new visit or test starts without treatment consent, the record is kept), visits and lab orders.

**A visit** (*Today's patients › Visits & follow-ups*, or from Today's patients): the doctor fills vitals (BMI is worked out), complaints, examination, diagnosis and an optional ICD-10 code, advice, the prescription by generic name, the follow-up date and a referral: **Referred to** (a specialist or a hospital) and the **Reason for the referral**. As a medicine is typed, the medicines this clinic's doctors have prescribed before are offered; choosing one fills its usual strength, dose, timing and duration on an empty line. *Save draft*, then *Complete consultation* (the appointment is marked done; the record is then fixed — *Add a note* to correct it). *More › Print prescription* (A5 with the doctor's registration number, and whom the patient is referred to), *Print referral letter* (A5: to whom and why, what was found, the diagnosis, the medicines, allergies and conditions, and approved results, signed by the doctor), *Bill this visit*, *Order tests* (billed as they are ordered only by someone who bills: a doctor's order is billed at the desk, on *Sales*). The visit changes by itself when its lab report is approved. *Follow-ups due* lists who should come back, with their phone.

**Doctors, fees & OPD** (*Today's patients › Doctors, fees & OPD*). For each doctor:
- **Consultation fee**: a service on the bill.
- **Follow-up rule**: within N days of a paid consultation, the patient pays the follow-up fee, or nothing if no follow-up fee is set.
- **Appointment slot**: its length.
- **Doctor's share** of the fees.
- **OPD timings**: by weekday, with morning and evening sessions and an optional cap on patients per session.

*Add leave* blocks appointments and tokens on those days and says how many patients are already booked. A doctor with timings can only be booked inside them. *Book appointment* then shows the free slots, and the doctor's fee is filled in. *Bill this visit* shows whether it is a consultation, a paid follow-up or a free follow-up. A free follow-up is recorded without a bill. The **Earnings** tab shows each doctor's patients, fees and share for a period.

**Token queue** (*Today's patients › Token queue*). *Give a token* when a patient arrives: each doctor counts from 1 each day, and *Priority* is for the elderly or unwell. On *Today's patients*, *Arrived: token* does the same for a booked patient. The queue, and its *Display board* for the waiting room, change by themselves within a second or two of a token given or called on any screen. Each doctor has a card:
- **Next patient** marks the previous patient done, skips a called patient who did not come in, and calls the next (priority first).
- **Start** opens the consultation.
- Completing the visit finishes the token.
- *Call back* brings back a skipped patient; *Cancel* frees the place.

*Display board* is the full-screen waiting-room view: each doctor's current number and who is next.

**Lab** (*Lab orders*): the worklist (to collect, to receive, in process, awaiting approval), today's orders with the dates visible, a *Sample barcode* box that opens the order when scanned, and *New order* (patient, tests, bill now). The list and an open order change by themselves within a second when a sample is collected, a result typed or a report approved on another screen (an order being typed into waits until it is saved); *Out of range* shows only to the lab and the doctors. On an order: *More › Print sample labels*; *Collected*, *Received in lab* or *Reject* (with the reason, then *Collect again*); type results (out-of-range values are flagged as you type); *Save results*. When all are in, the pathologist presses *Approve report* and types their PIN; the visit shows **Report ready** and *Print report* gives the A4 report with the lab's details, ranges, flags, the pathologist's name and registration and the approval time. *Send to an outside lab* records the lab, reference and charge (the results are typed in when they come). *Tests & panels* keeps the catalogue: parameters, units, reference ranges by sex and age, critical limits, and profiles.

**Amended reports** (*Lab order › More*). Every signed report is kept as signed. To correct one, the pathologist uses *Amend the report*, gives the reason and types their PIN. The order reopens; correct the results and approve it again. The new report prints as **AMENDED REPORT (version 2)**, saying which version it replaces and why. *Report versions* lists each version; an older one prints marked **SUPERSEDED**.

**Quality control** (*Lab orders › Quality control*). Set up each control: the parameter, lot, level, target mean and SD, and lot expiry. *Record QC run* every morning. Each run is judged by the Westgard rules:
- 1-2s gives a warning.
- 1-3s, 2-2s, R-4s, 4-1s and 10x reject the run.

While a parameter's latest QC today is failed, its patient reports cannot be approved. The order page shows the QC state, and approval says which rule failed. Note the corrective action and run QC again. *Chart* shows the Levey-Jennings chart (±1/2/3 SD) of the last runs.

### Clinic workspace

**Daily work → Clinic workspace** (the address `/clinic`) is one screen for the front desk and the doctors: the clinic's own screens gathered for their day, with no Business Admin menu around them. It is part of the staff app, not something to install: open it on the desk's computer, a doctor's tablet or a phone, and a bookmark or a tablet set up on `/clinic` keeps working. `/clinic` opens your clinic, or, if you work in several, the one you chose last; *⋯ › Another clinic* lists them to choose another. Its bar shows the clinic and its branch, **Live**, the branch picker (for a clinic with several branches), the lock and a **⋯** menu (the lab workspace, Business Admin, your profile, lock or switch user, sign out). Its tabs:

- **Queue** — the front desk's **Patient at the desk**: find them by name, mobile or patient ID, or *Register a new patient* (or *Register "…"* when the search finds no one) with their consent; their consent and any token they hold today show beside them, with *Give a token* (for their doctor, or the clinic's queue), *Order tests* and *Patient's page*. Beside it, the day's figures and each doctor's queue: who is with the doctor or was called, then everyone waiting with how long they have waited (priority first), *Call*, *Call back* for a skipped patient, *Cancel*, **Next patient** (finishes the patient being seen, skips one who was called and did not come in, and calls the next) and *Not here*. *Display board* is the waiting room's screen. A token given or called on any screen shows on every other within a second.
- **Your queue** — a doctor whose registration names their appointment calendar (*Settings › Clinic & lab settings*) sees their own queue first, the width of the screen: **Next patient**, then **Start** opens the consultation. Giving a token is under *More*.
- **The consultation** (from *Start* or *Open visit*): the clinic's own visit screen ([A visit](#clinic--lab) above: vitals, notes, the diagnosis, the prescription, the follow-up date and the referral, *Print prescription* and *Print referral letter*), with the doctor's queue beside it, so the next patient is called and started without leaving it, and the patient's **History**: the clinical card (allergies, current medicines, long-term conditions, blood group; *Edit card*) and each earlier visit, opened in place to read what was found, the diagnosis, the medicines, the advice, the referral and the approved results. *Order tests* stays on the consultation, and the order reaches the lab at once. When the lab approves the report, its results appear on the open consultation by themselves. On a phone the queue comes first, then the consultation, then the history.
- **Today** — *Today's patients*: the day's appointments, *Arrived: token*, *Start visit*, changing by themselves.
- **Patients** — *Patients* and each patient's page.
- **Visits** — *Visits & follow-ups*.

**Who opens it.** Anyone whose role in the clinic sees patients (`patients.view`): the front desk (Cashier / sales), doctors, the lab, the manager and the owner; the menu link shows only to them, and anyone else who opens the address is told their role does not include it. Each does there what their role allows in Business Admin. The front desk never sees clinical data: a consultation shows them who, when, the bill and whether the report is ready, and no history.

### Lab workspace

**Daily work → Lab workspace** (the address `/lab`) is one screen for sample collection and the lab, opened as the clinic workspace is, with the same bar and a **Scan a sample** box that opens the order of a barcode scanned or typed. The first four tabs count what waits in each:

- **Collection** — **To collect**: each sample awaited, or rejected and to be taken again (with the reason), urgent orders first, then the oldest; *Labels* prints the order's sample labels (the sample's barcode, the patient and the tests) and *Collected* marks it collected. **Collected, to receive in the lab**: *Received in lab*, or *Reject* with the reason, which puts it back to collect. *New order* orders tests for a registered patient.
- **Worklist** — each test whose sample is in the lab (or that went to an outside lab) and whose results are not all typed, with how many are typed; choose one test, or all. A tap opens the order: type each value against the patient's range (flagged low, high or critical as you type) and *Save results*.
- **Approval** — the reports with every result typed, and signed reports reopened for an amendment; for the lab and the doctors, how many values are out of range and how many are critical. A tap opens the order for the pathologist's *Approve report* with their PIN; a report waits while today's quality control of one of its parameters has failed.
- **Released** — the reports approved today, the latest first: on the doctor's visit at once (*Report ready*, and the results on an open consultation) and printed for the patient with *Print report*, as signed (an amended one as amended). Every earlier version stays on the order (*More › Report versions*).
- **All orders**, **Quality control** and **Tests & panels** — the lab's screens of Business Admin.

Every list changes by itself within a second when a sample is collected, a result typed or a report approved on another screen. **Who opens it.** Anyone whose role sees lab orders (`lab.view`): the lab technician, the pathologist, doctors, the front desk and the manager. Results show only to the lab and the doctors; the front desk follows where each sample and report is.

## Newer trades on the shared core

Eleven more types run on the shared screens from the day they are created: *Quick bill* (a goods shop) or *Sales* (a service business), products, customers, udhaar or customer dues, purchases, stock, expenses, *Daily money* and reports. Each starts with its trade's units, GST slabs and tools, and its own checklists in the tasks library (*Tasks › Templates*). Every one but the general store also has screens of its own, described in its section below; what each still lacks is in [BACKLOG.md › New business types](BACKLOG.md#10-new-business-types).

| Type | Starts with | Tools to switch on (recommended in bold) |
| --- | --- | --- |
| General store & other shops | Quick bill and retail reports; prices including GST; packs, dozens, pairs, rolls and sets | **Variants** (sizes and colours), **Offers**, batches, loyalty, exchanges, serials and warranties, repairs, weight, wastage, price lists |
| Hardware, paints & building materials | Its own screens: see [Hardware, paints & building materials](#hardware-paints--building-materials) below | See the same section |
| Seeds, fertilisers & pesticides | Its own screens: see [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides) below | See the same section |
| Optical shops | Its own screens: see [Optical shops](#optical-shops) below | See the same section |
| Vehicle service & auto parts | Its own screens: see [Vehicle service & auto parts](#vehicle-service--auto-parts) below | See the same section |
| Jewellery & gold | Its own screens: see [Jewellery & gold](#jewellery--gold) below | See the same section |
| Fuel stations | Its own screens: see [Fuel stations](#fuel-stations) below | See the same section |
| Gyms, studios & coaching | Its own screens: see [Gyms, studios & coaching](#gyms-studios--coaching) below | See the same section |
| Laundry & dry cleaning | Its own screens: see [Laundry & dry cleaning](#laundry--dry-cleaning) below | See the same section |
| Rentals & hire | Its own screens: see [Rentals & hire](#rentals--hire) below | See the same section |
| Hotels, lodges & guest houses | Its own screens: see [Hotels, lodges & guest houses](#hotels-lodges--guest-houses) below | See the same section |

**GST slabs to check.** The starting slabs follow the rates in force from 22 September 2025, but several items in these trades have a rate of their own:

- cement 18%;
- spectacles, frames and lenses 5% (sunglasses 18%);
- fertilisers 5% and chemical pesticides 18%;
- a gym's, yoga studio's or salon's services 5%, without input tax credit;
- laundry, dry cleaning, pressing and dyeing 18%, with input tax credit (not the 5% of a gym's or salon's services);
- renting goods without an operator at the rate of a sale of the like goods (40% for goods that attract 40%), and a passenger vehicle hired with a driver 5% (input tax credit only of input services in the same line of business) or 18% with full credit;
- petrol, diesel and CNG outside GST (on the nil slab, the price including the state's VAT), and lubricants and the shop's items at their own slab;
- coaching 18%;
- a hotel room 5% (without input tax credit) at ₹7,500 a night or less, 18% (with credit) above, night by night on the room night's own value.

Set each item's slab when adding it, and have an accountant confirm them before trading.

## Hardware, paints & building materials

A hardware, paint and building-material shop bills at **Quick bill** with
prices including GST rounded to the rupee, keeps udhaar for named customers,
and sells in bags, coils, rolls, sheets, sets, feet, quintals and tonnes as
well as pieces, kilos and metres. A new shop starts with **Quotations**,
**Sites**, **Today's rates** and the **Material calculators** on.
Recommended in Settings › Business tools: **Fitters' commission**,
**Paint tinting**,
**Wholesale price lists** (contractor and dealer rates), **Sales orders**
(site orders delivered in parts, each load with a delivery challan) and
**Stock transfers** (between the shop and the godown); batches, variants,
weight, offers and exchanges can be switched on too.

- **Quotations** — the estimate for a site, valid until a date, billed or
  made into a sales order at its prices ([Quotations](#quotations)). A
  quotation for a saved customer can go to one of their sites. Its paint
  lines can be tinted to a shade, and the calculators' workings are kept
  with it and printed on it.
- **Sites** (*Customers & contractors › Sites*) — each contractor's or
  builder's sites: the site's name, address, the person at the site and their
  phone. A site belongs to one customer and stays with them; close it when
  the work is done (its bills stay). *Ledger* on a site's row shows every bill
  that went there, goods that came back, payments and refunds in date order
  with the running balance, and its quotations and sales orders; *Send the
  dues on WhatsApp* sends the customer the site's billed, paid and due
  figures with each unpaid bill, and *New quotation for this site* starts one.
- **A bill goes to a site** — on Quick bill, once the customer is picked,
  *Site* offers their open sites; New sale and a quotation offer the same.
  On a posted bill, *Set the site* (or *Change the site*) moves it, and the
  bill's A4 invoice and till receipt print the site. *Sales history* filters
  by site and shows each bill's site.
- **Site orders** — with Sales orders on, an order made from a quotation
  takes the quotation's site, and *Set the site* on an order sends it there:
  every invoice its dispatches raise goes to that site, and invoices already
  raised without a site move there too. *Routes & salespeople*, a
  wholesaler's beat screen, is not part of a hardware shop's Sales orders.
- **Today's rates** (*Products & services › Today's rates*) — the items
  whose price changes every day (cement, steel, pipes, cable) on one board.
  *Put items on the board* adds them; type today's rates and *Save* them
  together. Each is the item's own price change: a rate above the item's MRP
  is refused (and nothing in that save changes), the activity log keeps it,
  and Quick bill, New sale and new quotations use it at once. A quotation
  already made keeps its prices until it is revised. The board shows each
  item's rate before the last change, the change, and when it changed,
  whichever screen changed it. If someone else saved a rate after you opened
  the board, saving yours is refused: open it again. *Share today's rates*
  sends the list on WhatsApp, and *More › Print the rate list (A5)* prints it
  for the counter. *Take off the board* leaves the item and its price as
  they are. *History* on an item's row lists every earlier change of its
  rate, newest first: when, the rate before and after, who changed it, and
  the purchase that set it.
- **Material calculators** (*Calculators* on Quick bill, and in a
  quotation next to the scan box) — *Tiles*: pick the tiles, type the area
  (sq ft or m²) and the wastage (10% to start); the calculator gives the
  boxes to sell and *Add … to the bill* (or the quotation) puts them on.
  *Paint*: pick the paint, type the area, the coats and (if the paint has
  none) what one litre covers; it gives the litres and the packs to buy: the
  least paint, in the fewest tins, from the paint's own tins or the usual 1,
  4, 10 and 20 L. *Bricks*: a wall's length, height and thickness (half a
  brick or one brick to choose), less its doors and windows, gives the
  bricks and the cement and sand of the mortar. *Concrete & plaster*: an
  area and a thickness, or a volume, gives the bags of cement and the cubic
  feet of sand (and aggregate, for concrete). *Steel*: each bar size's
  diameter, length and how many gives the kilograms and the bars. For these
  three, choose the shop's item for each material: the server works out
  what goes on in the unit each item is sold in (bags, quintals, pieces,
  kilograms), and says which item cannot take it (sand sold by the tonne,
  say: add it by hand). *Assumptions* shows every figure used (the brick
  size and joint, the mix and its dry-volume factor, the wastage, a bag's
  kilograms, one metre of each bar's weight) once the job is typed; change
  any for this job, or *Use the usual figures*. What was typed, the
  assumptions and the result are kept with the bill or the quotation (with
  its revision), and a quotation shows and prints them. These are estimates
  for the customer, not engineering. The tile and paint figures live on the
  items: with the calculators on, the item form (*Products & services*, add
  or edit) has *Tiles: one unit covers (sq ft)*, *Paint: one litre covers,
  one coat (sq ft)* and *Paint: litres in one unit*. Give each paint tin its
  litres (and the paint's coverage) and the calculator can add the tins to
  the bill.

**Paint tinting** (switched on in Settings › Business tools) bills paint
tinted to a shade on the paint maker's machine; the maker's own software
runs the machine.

- **Shades** (*Sales history › Paint tinting*, the *Shades* tab) — each
  maker's shades: the code, the name, the card, the base it needs and, if
  kept, its formula (each colourant's millilitres for one litre of base,
  typed like XR 1.25; YE 0.4). *Add a shade*, or *Import shades* from a
  spreadsheet: a check first shows what would be added and changed, then the
  import, all or nothing; the same file twice changes nothing. A maker's
  code is kept once; a shade no longer used is switched off, never deleted.
- **The bases and the charge** — give each base item its *Tinting: the base
  it is* (Pastel, Deep and the like, by its maker's names) on the item form:
  only those items offer a shade, and only the shades that need their base.
  On the *Shades* tab, choose the *Tinting charge*: a service item priced for
  one tin, at its own GST slab.
- **A tinted line** — on Quick bill, a base's line offers *Shade for …*:
  choosing one puts the tinting charge on the bill too, one for each tin. A
  quotation's lines offer the same in their *Shade* column, and its bill is
  tinted the same way. The base must be free at the location: what is in
  stock, less what waits on the board.
- **The tinting board** (the *Tinting board* tab) — each tinted line of a
  bill, those waiting first: *Tinted* when the machine has made it (the base
  leaves stock then), then *Handed over*. It changes by itself as others move
  the jobs.
- **Taking a tinted tin back** — a tinted line does not come back with *Take
  back items* on the bill. On the board, *Take back* asks why, and the PIN of
  a manager who may take goods back. The whole line comes back as a return,
  nothing goes back into stock, and the money goes back with *Refund
  customer* on the bill.

**Fitters' commission** (switched on in Settings › Business tools) pays the
painters, plumbers, electricians, masons and carpenters who bring customers.

- **Fitters** (*Customers & contractors › Fitters*) — each fitter's name,
  trade, phone, UPI id and area; one fitter per phone number. A fitter
  switched off is named on no new bill, and keeps what they earned and are
  owed.
- **Commission rules** (the *Commission rules* tab) — a percent of a line's
  value before GST, after discounts, for every item, for a category and the
  categories under it, or for one item; or an amount for each unit of one
  item (₹2 a bag of cement). A line earns by its item's rule, else by the
  nearest category's up the tree, else by the rule for every item; each has
  one rule on at a time. A changed rule applies to bills from then on.
- **Fitted by** — Quick bill (the *Fitted by* card), New sale and *Make the
  bill* on a quotation offer the fitters who are on, for a walk-in too. The
  commission is worked out with the bill, to the paisa, never above a line's
  value, and kept with the bill; the bill shows who fitted it and what it
  earned. Goods taken back on the bill take back the commission in
  proportion, exactly all of it once everything has come back.
- **Naming the fitter afterwards** — on a posted bill, *Name the fitter*
  (for someone who may change commission rules): its lines earn by the
  rules in force now, less what has come back. *Change the fitter* moves the
  commission to another fitter until it is paid; payouts settle each
  fitter's oldest commission first. On a sales order still to send, *Name
  the fitter* names one for every invoice its dispatches raise.
- **Paying a fitter** — *Pay* on a fitter's row or statement records a
  payout of no more than is due: the amount, how it was paid and a reference.
  The payout is a paid expense of the shop (category *Other*, "Fitter's
  commission: name (trade)") at the location that paid, so *Daily money*
  counts it. With the fitter's UPI id, *Pay … in a UPI app* opens a UPI app
  with the amount filled in. Paying needs both *Pay fitters their
  commission* and *Record a paid expense*. To take a payout back, reverse its
  expense under *Daily money › Expenses*; the *Payouts* tab shows every
  payout and whether it was reversed.
- **A fitter's statement** — *Statement* shows the bills they earned on,
  goods back, payouts and reversed payouts in date order with the running
  balance. *Send the statement on WhatsApp* sends the totals and the latest
  bills to the fitter's phone; *Print the statement* prints it with a line
  for their signature.
- **Report** (*Reports › Fitters' commission*) — for the dates chosen, each
  fitter's bills and their value before GST, commission earned, taken back
  and paid, and what each is due now.

## Seeds, fertilisers & pesticides

A krishi kendra bills at **Quick bill** with prices including GST rounded to
the rupee, keeps udhaar for named farmers, and sells in bags, packets,
bottles, quintals and tonnes as well as pieces, kilos and litres. Every sale
names its batch (lot and expiry). A new shop starts with **Seeds,
fertilisers & pesticides** (the farm-input tools) and **Licences &
registrations** on; **Wholesale price lists** (dealer rates) is recommended,
and weight, offers and quotations can be switched on too. Its own screens
are under **Farm inputs**, its seed lots and stock kept apart under
**Stock**, its company schemes under **Purchases**, and its checks under
*Settings › Farm input checks*.

**Before the first bill:**

1. **Licences** (*Settings › Licences*) — add the location's fertiliser
   authorisation letter, seed dealer licence and insecticide sale licence,
   each with its number and dates, what it lets the location sell and
   whether for retail or wholesale sales ([Licences](#licences)); then, on
   the insecticide licence, its endorsements and each manufacturer's
   principal certificate, and on the fertiliser authorisation each source's
   certificate (Form O). While Licences & registrations is on, a bill of a
   fertiliser, seed or pesticide is refused at a location without one in
   force for the kind of sale; *Settings › Farm input checks* shows what each
   location holds, and whether an insecticide not endorsed (or without its
   principal certificate) warns or stops the bill: *Warn and bill it* to
   start with, or *Stop the bill*.
2. **Items** (*Seeds, fertilisers & pesticides*, add or edit an item) — with
   the farm-input tools on, the item form asks *Kind of farm input*:
   - *Fertiliser*, and *Subsidised* when it is sold through the government's
     PoS device (its bills then need the PoS receipt number);
   - *Seed*, with its class (certified or truthfully labelled), crop and
     variety. A seed is kept by batch: each lot's expiry is its validity date,
     the test date on its tag plus 9 months;
   - *Pesticide*, with its active molecules as on the label (type each and
     *Add*; the molecule list's names are offered) and its formulation. A
     pesticide is kept by batch too. A banned molecule is refused, a
     molecule barred on some crops is marked, and carbofuran is kept only as
     its 3% CG. Optional: the crops or groups on its label (*Add the crop to
     the label*; a crop not on it is billed with a warning), *A registered
     household insecticide*, and its dose per acre, safety interval in days
     and protective gear, for the advice line on the bill;
   - *Bio-input* or *Other item* (sprayers, tools).
   *Weight of one unit in kg* (50 for a 50 kg bag, 0.45 for a 450 g packet)
   lets the registers show quintals. The kind can be changed later; the
   activity log keeps what it was.
3. **Receiving seed** — a seed lot comes in with its validity date as its
   expiry; a purchase line of a seed without one is refused. Then keep its
   tag under *Stock › Seed lots* (below). Fertiliser received from a supplier
   with no certificate of source (Form O) on the location's authorisation
   comes in with a warning, and an insecticide received at a location marked
   as keeping food or feed comes in with a warning too.
4. **The checks** (*Settings › Farm input checks*, a role that changes the
   settings) — whether a restricted-use pesticide for a buyer not tagged is
   stopped outright or allowed by a manager's override; the subsidised bags
   a farmer may take in a month in each state the shop's locations are in
   (50 to start with) and whether more are stopped or allowed by an
   override; the service item interest on season credit is billed as (make
   one under Products first: its GST slab is the item's); *Advice on the
   bill*; and the locations that also keep food or feed.

**At Quick bill**, the *Farm inputs* card asks for what the bill needs, and
the bill is not taken until it is given:

- **A subsidised fertiliser** — the *PoS receipt number* the PoS device
  printed after the farmer's thumb check (one for the bill; never the Aadhaar
  number, which is not asked for or kept).
- **A pesticide barred on some crops** — *Crop it is for*; the card says
  which crops it must not be used on, and a barred crop stops the bill (jowar
  counts as sorghum; tomato stops one barred on vegetables). For any other
  farm input the crop is optional and is kept with the line; a crop not on a
  pesticide's label shows a warning, and the bill goes through.
- **A restricted-use pesticide** (aluminium phosphide and the like) — the
  customer must be tagged a pest-control operator or a government body
  (*Tagged buyers*, below). Anyone else is stopped; where the shop allows
  it, *Ask a manager to allow it*: the manager chooses themselves (or gives
  their PIN at the cashier's till) and says why, for this one bill.
- **Sulphur** — the buyer's name and village (a walk-in), or a customer with
  an address or a village, for the register of sulphur buyers.
- **Subsidised bags for a named farmer** — the card counts the farmer's bags
  this month against the limit: a warning near it, and a stop over it (or a
  manager's override, where the shop allows one).
- **A walk-in buying farm inputs** — the farmer's name and village, optional,
  for the insecticide register.
- **On udhaar, for a farmer** — *Season credit*: one of the farmer's open
  seasons, or a new one (kharif, rabi or zaid of a year, and the harvest date
  it falls due). The season's date becomes the bill's due date, so Udhaar,
  the bell and the dues by village count it from then. A bill that would
  take the season over its limit, or one on a season closed or past its
  date, is stopped.
- **What the licences say** — as the lines are typed, the card shows what
  the location's licences say of them: a line the bill would be refused for
  (no licence in force for the kind of sale: a customer with a GSTIN buys
  wholesale), a licence in force only while its renewal is pending, and an
  insecticide not endorsed on the licence or without its manufacturer's
  principal certificate in force, which is billed with the warning or
  stopped, as *Settings › Farm input checks* says.

A quotation's *Make the bill* asks for the PoS receipt, the crop and, for a
bill left on credit, the season too; stopped for a restricted-use pesticide
or bags over the limit, it asks for a manager's override and is made again.
Whichever screen bills them, the same checks apply, and the server refuses
with the reason: a molecule banned in India, no licence in force at the location for the kind of sale, a
seed lot past its validity or a pesticide batch past its expiry (keep it
apart, marked not for sale), a barred crop, a missing PoS receipt. The bill's
A4 invoice and till receipt print each line's PoS receipt and crop, the
licences the location sold under, the farmer's village, father's or
husband's name and Farmer ID, and the season of a credit bill.

**Farm inputs:**

- **Farmers & village dues** — *Add a farmer*: a new customer (name and
  phone) or one already saved, with their village, father's or husband's
  name, land in acres, crops and Farmer ID from the Agri Stack farmer
  registry. The list filters by village and by those owing; *Dues* on a row
  shows the farmer's bills still to collect, each with its season and due
  date. The *Village dues* tab shows, for each village, its farmers, how many
  owe and what (as Udhaar counts it), what is overdue, what is on season
  credit and the next harvest date one falls due, with customers without
  farmer details who owe on one row; a village opens its farmers. Payments
  are taken on Udhaar. What farmers owe (the amounts, *Owing only* and
  *Village dues*) shows only to a role that also sees sales or udhaar. The
  *Tagged buyers* tab: *Tag a buyer* tags a customer a pest-control operator
  (with their licence number) or a government body (with the order it buys
  under), a manager's to give, who may then buy restricted-use pesticides;
  or a bulk consumer, whose insecticide purchases go in Form XIII. A tag may
  have a date it lapses; *Switch off* ends it.
- **Season credit** — each farmer's credit for a season. *Give season credit*
  (a manager): the farmer, the season and year, the harvest date it falls
  due, a limit (or none), the interest on overdue (none, a % a month after
  the due date, or a % a month from each bill's date), a guarantor and the
  crop pledged. *Show* open, overdue, closed or all. A season opens on its
  bills (each with what is left and its interest to date), the interest
  worked out to today bill by bill (*How the interest is worked out*), and
  the produce taken. *Bill the interest of ₹…* (a manager) makes a bill of the
  interest item on the season, due at once: interest is never charged until
  then. *Take produce against it*: the crop, quantity, unit and rate; its
  value pays the season's bills, oldest due first, as a payment named
  *Produce*; no money moves, and the day's money does not count it. *Change
  the terms* (the due date and interest stay once a bill is on it); *Close
  it* stops new bills on it.
- **Crops** — the crops the counter matches a farmer's word against, in
  their groups. *Add a crop*: a crop the shop's farmers grow, with its
  groups and the other names they use; *Add names or groups* on one of the
  platform's crops. A molecule barred on a group is barred on each crop in
  it. The shop's own crops are switched off, never deleted.
- **Subsidy PoS reconciliation** — for a location and dates, day by day and
  fertiliser: the bags billed, the bills and PoS receipts, what came back,
  and the PoS device's stock typed in against the shop's own stock then.
  *Type the PoS stock* lists each subsidised fertiliser with the shop's stock
  now: read the PoS device and type what it shows; the difference shows at
  once and in the list (the last entry of a day counts). Entries are never
  changed.
- **Registers & board** —
  - *Stock & price board*: each fertiliser's and seed's opening stock on a
    day (and its closing stock for a day gone by), its price at that location
    and its MRP: today's now, a day gone by's as they were that day (a price
    changed during the day shows its price at the start too). *Print the
    board* prints it large for display, with the location's licence numbers.
  - *Seed stock return*: for a month, each seed's crop, variety and class,
    the stock on the first, what was bought and sold (net of goods returned),
    other changes (corrections, counts, transfers) and the closing stock, in
    quintals where the item's weight is known. Due to the licensing authority
    by the 5th of the next month; *Print the return*, then *Mark it sent*
    (with the date and acknowledgement) once it has gone; the bell reminds
    until then.
  - *Insecticide sale register*: every pesticide sold in the dates, with the
    bill, the farmer and village, the product and its molecules, the batch,
    the manufacturer, the quantity, what came back, the expiry and the crop
    (marked when it is not on the pesticide's label). *Print the register*.
  - *Form XIV return*: for a month, each insecticide's stock on the first,
    what was received and sold (and of it, to dealers and bulk consumers),
    other changes and the closing stock. Due by the 15th of the next month;
    *Print the return* and *Mark it sent*, as for the seed return.
  - *Form XIII*: insecticides sold to dealers (a bill to a GSTIN) and to
    customers tagged bulk consumers, insecticide by insecticide, with each
    buyer's GSTIN or reference and address.
  - *Sulphur buyers*: every sale of sulphur, with the buyer's name and
    address.
  Each is worked out from the bills, purchases and stock movements, and
  exports to CSV for someone who exports reports.
- **Molecules** — the list the bills are checked against: each banned,
  restricted or crop-restricted molecule, the crops or groups it must not be
  used on, its rule (who may buy it, the one formulation it is kept in) and
  the order it comes from. The platform keeps it; it cannot be changed here.

**Stock and purchases:**

- **Seed lots** (*Stock › Seed lots*) — each seed lot received, with its tag.
  *Keep the tag*: the date of test, germination, physical purity, the tag
  number and its SATHI QR (scanned into the box); the lot is then valid until
  9 months after its test, at every location that holds it. A lot opens on
  its tag, where it is held, its retests and QR texts: *Record a retest*
  (passed, valid 6 months longer; failed, kept and nothing changes), *Scan a
  QR*, and *Correct the tag* until it is retested. *Show* lapsed lots, those
  running out within 30 days, or those whose tag is not kept yet.
- **Kept apart** (*Stock › Kept apart*) — *Keep stock apart*: an expired
  batch (the register of expired stock, until it is disposed of), stock
  seized by an inspector (with their name and seizure receipt) or a sample
  drawn (with the sample slip): find the batch, give the quantity, and it
  comes out of stock at once, so it cannot be sold. *Dispose of it*,
  *Close the seizure* or *Close the sample* records the date and what was
  done; *Release it* puts seized stock back into its batch. *Print the
  register* prints the expired stock.
- **Company schemes** (*Purchases › Company schemes*) — *Add a scheme*: the
  company (supplier), the season, its dates, the items it counts (in one
  unit) and its tiers (a rebate on every unit from a quantity, a target
  rebate, free goods, a gift). Its ledger shows what was bought (from the
  purchases, less what went back), what that earns at the tier reached,
  what is still to buy for the next tier, and the claims: *Record a claim*,
  then *Mark received* with what came back. Enter the company's credit note
  or free goods as any other purchase: the ledger only keeps the account.

Who does what: a cashier adds farmers, bills with the checks, takes produce
against a season and types the PoS stock; a stock keeper types the PoS stock,
keeps seed tags and stock kept apart, and sees the farm-input screens without
customers' dues; a manager does all of it, keeps the licences, gives season
credit and its interest bills, tags pest-control operators and government
bodies, and allows overrides (`agri.approve`);
an accountant and a viewer see the screens and the dues.

## Optical shops

An optical shop bills frames, sunglasses, contact lenses and solutions at
**Quick bill** with prices including GST rounded to the rupee, keeps customer
dues for named customers, and sells in pairs, packs, boxes and bottles as well
as pieces. A new shop starts with **Prescriptions & spectacle orders** on.
Recommended in Settings › Business tools: **Batches** (contact-lens expiry),
**Variants** (frame colours and sizes, and contact-lens powers),
**Appointments** (eye tests with the optometrist), **Quotations** and
**Licences & registrations**; offers, loyalty and exchanges can be switched on
too. Spectacle orders have a daily entry of their own, *Spectacle orders*; the
prescriptions and the recall list are under *Customers*.

**Before trading:**

1. **GST slabs** — spectacles, frames, spectacle lenses and contact lenses are
   at 5%, and sunglasses (and goggles not for correcting vision) at 18%, as
   from 22 September 2025. Give each item its slab when adding it: the slab
   decides the GST at the counter and on every spectacle order. Have an
   accountant confirm them.
2. **The MD-42 registration** — selling contact lenses needs the medical
   device sale registration (MD-42). Keep it under *Settings › Licences*
   (kind *Medical device sale registration (MD-42)*) with its number and the
   date it was issued, and note when its retention fee falls due
   ([Licences](#licences)).
3. **Items** — frames as goods kept by quantity; lenses as items too, either
   stock lenses kept by quantity or a lens made to order by the lab (a
   service item, or goods received with the lab's bill); the fitting charge as
   a service.

**The screens:**

- **Prescriptions** (*Customers › Prescriptions*) — *Record a prescription*:
  the customer (found by name or phone, or added there), the day of the eye
  test, who examined (a member of the shop, or an outside doctor or
  optometrist, whose registration number is then required; a member's is
  optional and comes back on their next one), and the powers. Each eye has a
  distance row, a near row and, ticked, an intermediate row: SPH and CYL in
  steps of 0.25 from -30 to +30 (plano is 0.00), AXIS 1 to 180 (with a CYL,
  and only then), ADD +0.25 to +4.00 on the near or intermediate row, a prism
  with its base (in, out, up or down) and the visual acuity as written. *Left
  eye same as right* copies the right eye; *Transpose the cylinder* turns
  plus-cylinder powers into minus-cylinder ones, or back. The PD is both eyes
  together or each eye. *Valid until* is a year after the test unless you
  change it. The server checks every power and says which one is wrong. The
  list shows each customer's latest prescription (untick *Latest of each
  customer only* to see all), with the powers in one line and lapsed ones
  greyed; *Print* prints it (A5) with the examiner's registration number.
- **Correcting a prescription** — *Correct* is offered while no spectacle
  order uses it: anything can be put right, its customer too, and the
  activity log keeps what was and what is. Once an order uses it, it never
  changes: record a new prescription instead.
- **A customer's prescriptions** (a customer's name in the list) — the eye
  tests side by side, newest first: each eye's SPH, CYL, AXIS, ADD and acuity,
  with how each power changed since the test before; the PD; when the next
  eye test is due (with *Remind on WhatsApp* once it is); each prescription in
  full with the orders made on it; *Book a spectacle order* on the latest.
- **Spectacle orders** (*Spectacle orders*) — the open orders, with chips for
  *Due today*, *Ready to collect*, *Overdue* and each step (*Booked*, *At the
  lab*, *In the workshop*, *Quality check*), each row with *WhatsApp*; *All
  orders by date* shows every order of the dates chosen. An order opens its
  job card on screen.
- **Booking an order** — *Book an order* on *Spectacle orders* or on a
  prescription (on a customer's prescriptions, *Book a spectacle order* takes
  the latest): the customer and their prescription (the latest to start
  with), copied onto the order as it is; the frame, from stock or the
  customer's own (say what it is); the right and the left lens (untick one to
  make only the other), each with its type (single vision, bifocal or
  progressive), *Billed as* a lens item or left empty when the lens is billed
  on another line, its index, material, coatings, tint and brand; *Same as the
  right lens*. A lens item sold by the pair goes on the right lens only. *Add
  an item* puts a case, the fitting charge or the lab's lens charge on the
  order. Each eye's fitting PD comes from the prescription (half of the PD of
  both eyes) and can be changed; a bifocal or progressive lens needs that
  eye's fitting height, and its near power (ADD) on the prescription. *Made*:
  at a lab (its name, and its order number when known) or in our workshop.
  *Promised for*. A manager's discount with its reason. The advance (cash,
  UPI, card or bank): a numbered receipt in the customer's name, never more
  than the total. Every figure is the server's, priced as a sale of the items
  would be now (customer and slab prices, offers, the discount, GST and
  round-off), and the order keeps those prices. Nothing leaves stock at
  booking. Orders are numbered *SPO/2627/0001* (Settings › Number series).
- **The work** — the next step is the main button on the order: *Send to the
  lab* (with the lab's order number), *Into the workshop* (lenses back for
  fitting), *Ready for the quality check*. At the quality check, someone who
  may pass it (the owner, a manager or the optometrist) checks the spectacles
  against the prescription: *Passed the quality check*, stamped with who and
  when, or *Failed: back to the workshop* (or *the lab*) with what was wrong.
  Spectacles found wrong once ready go back the same way, with the reason.
  Steps are never skipped, and each is kept in the history with who did it.
  *Change details* changes the promised day, the fitting, the lab and the
  notes while the order is open; the frame, the lenses and the prices stay
  as booked.
- **Job card and customer slip** — *Job card* prints, on A5 or A4, what the
  lab or the workshop needs: the prescription as booked, each eye's fitting
  PD and height, the frame, both lenses, the lab and its order number, and
  lines for who made the spectacles and who passed the quality check; never
  the prices. *Customer slip* prints the order, the day it is ready by, the
  items and their prices, the advance and what is left to pay; it says it is
  not a tax invoice, as the bill is made at delivery.
- **Tell the customer** — WhatsApp opens with the message for the stage
  (booked, ready to collect with the amount to pay, running late, a collect
  reminder), or *Call*; each is noted in the history.
- **Delivery** — *Deliver and bill*, once the spectacles passed the quality
  check: the bill is posted at the booked prices, with GST at each item's
  rate on the day (a price that includes GST keeps its total when a rate
  changes; *The bill at delivery* on an open order shows the figures as they
  would be posted today). The frame and other goods leave stock now: an item
  not in usable stock at the order's location stops the delivery until it is
  received, and the order shows it. The advance pays first; the rest is
  collected now (cash, UPI, card or bank) or goes on the customer's dues. A
  bill over ₹2,00,000 asks for the buyer's PAN or their declaration, as every
  bill does.
- **Cancelling** — *Cancel the order*, with a reason. Nothing is billed and
  nothing leaves stock. The advance stays the customer's: *Hand back the
  advance* (cash, UPI or bank, a reason and a manager's PIN; a receipt
  prints), or it stays on their account for a later bill (*Customer dues*).
- **Remakes** — on a delivered order, *Book a remake*: a new order linked to
  it, with the reason (power changed, could not get used to them, measurement
  or fitting error, lab defect, breakage, coating peeled, other) and who bears
  the cost (the lab, the shop or the customer). When the lab or the shop bears
  it the customer pays nothing: no discount and no advance, and its bill (when
  it takes a frame or lenses from stock) comes to ₹0.
- **Recall list** (*Customers › Recall list*) — every customer whose last eye
  test was 12 months ago or more (an owner sets the months, 1 to 60, on the
  list), longest due first, with their phone, when they were last reminded
  and their last order. *WhatsApp* opens the reminder ready to send and *Call*
  dials; each reminder is kept. *Not reminded in the last 30 days* narrows the
  list.
- **Contact lenses** (*Frames, lenses & products*, *Add item*, with Variants
  on) — tick *Contact lenses: one item for each power*. The lens's name, unit
  (a box), price, MRP, GST slab and stock tracking (batch and expiry with
  Batches on) go for every power; give the base curve and the diameter, and
  the powers from and to in steps of 0.25 or 0.50 (up to four ranges, from
  -20.00 to +20.00). Each power becomes an item (*Acuvue Oasys · -2.50*, code
  *AO6-M250*) that keeps its power, base curve and diameter. Choosing the lens
  under *Variant of* adds the powers it does not have yet. Each power is
  received and sold like any other item.
- **The bell** — spectacles ready to collect, and orders past their promised
  day.

Who does what: a cashier records prescriptions (from a doctor's slip, say),
books and delivers orders, takes advances and moves the work along; the
**Optometrist**, an optical shop's own role, records and corrects
prescriptions, sees customers, appointments and spectacle orders (without
their money) and passes or fails the quality check, and takes no money; a
stock keeper moves the work along (the lab, the workshop) and sees no money;
a manager does all of it, cancels orders and gives discounts; an accountant
and a viewer see the screens.

## Vehicle service & auto parts

A garage bills parts at **Quick bill** (the parts counter) with prices
including GST rounded to the rupee, keeps customer dues for named customers,
and sells in pairs and sets as well as pieces and litres. A new garage starts
with **Vehicles & job cards** on. Recommended in Settings › Business tools:
**Appointments** (service bookings by day, bay and mechanic, under *Service
bookings*), **Wholesale price lists** (mechanic and retailer rates on the parts
counter) and **Quotations**; batches, serials, warranties and offers can be
switched on too. Job cards have a daily entry of their own, *Job cards*; the
vehicles and the service-due list are under *Customers*, and the garage's
settings under *Settings › Garage settings*.

**Before trading:**

1. **GST slabs** — from 22 September 2025, parts and accessories of motor
   vehicles and motorcycles are at 18%, and so is repair and maintenance
   labour (SAC 998714); the tractor parts the GST Council listed, and rear
   tractor tyres and tubes, are at 5%. Give each item its slab when adding it
   (a new garage has nil, 5%, 18% and 40%): the slab decides the GST at the
   parts counter and on every job card. Have an accountant confirm them.
2. **Items** — parts as goods kept by quantity (or by serial number, with
   Serials on, for batteries and tyres whose warranty goes by it); labour as
   service items with SAC 998714 (*General service labour*, *Wheel
   alignment*); work done at another workshop (denting, painting, machining)
   as a service item too, charged on each job card as agreed.
3. **Insurance companies** — each one a customer with its GSTIN (and PAN), so
   the bills to it carry them; and, for cashless claims, the item that bills
   the owner's share (*Settings › Garage settings*, *Make the item*).
4. **Mechanics** — a staff login for each with the **Mechanic** role (*Staff &
   access*), so they can be put on job cards and see the ones assigned to
   them.

**The screens:**

- **Job cards** (*Job cards*) — the board: a column for each open status
  (*Received*, *Estimate sent*, *Approved*, *In progress*, *Waiting for
  parts*, *Ready*), each card with the plate, the vehicle, the customer and
  the job card's number, the promised time (marked late once it has passed),
  how long it has been at that step, the mechanics, how much of the work is
  done, the insurer on a claim and the total. *All job cards by date* lists
  every job card of the dates chosen, with its status, reading in, mechanics,
  claim, total and bills. A mechanic sees *My job cards*: only the ones
  assigned to them.
- **Opening a job card** — *Open a job card* (on *Job cards*, or on a
  vehicle's page): type the registration number as it is on the plate
  (spaces and dashes are left out) and the vehicle comes up with its owner
  and last reading; a number not seen before is added there (*Add the
  vehicle*). The owner pays, unless *Another customer pays* (a company or a
  fleet) names who does. Then the odometer in (a reading lower than the last
  needs a manager: see *The odometer log*), the fuel level, what the customer
  says (one complaint a line, up to 20), inspection notes (dents and
  scratches, what was left in the vehicle), the bay, the promised time
  (within a year), the mechanics, and an advance (cash, UPI, card or bank: a
  numbered receipt in the customer's name, taken off their bill). When the
  vehicle already has a job card open, the form says so and links to it. Job
  cards are numbered *JC/2627/0001* (Settings › Number series).
- **The estimate** — *Write the estimate* on the job card: parts (items kept
  in stock, at the customer's price unless a rate is typed: a lower rate is a
  discount, for those who may give one, and no part is charged above its
  MRP), labour (a service item, at its price or as agreed) and outside work
  (a service item with its charge, the workshop that did it and its bill
  number), each with its quantity and, on a job card with a claim, who pays
  it. Every figure is the server's, with GST at each item's slab and the
  round-off. Each change saved is a new version, kept as it was (*Versions
  and approvals*). Parts leave stock when the job is billed, not before: the job
  card shows a part not in usable stock at its location, and billing waits
  until it is received.
- **The owner's approval** — *Send the estimate* (with a note, say *Sent on
  WhatsApp*) puts the job card at *Estimate sent*; *Record the owner's
  approval* keeps who approved, how (in person, on the phone or on WhatsApp),
  when, and the amount: the estimate's total as it stands. A version that
  comes to more than the owner last approved (a revision, or parts a mechanic
  adds) sends the job card back to *Estimate sent* until they approve again;
  one that comes to less keeps the approval. A quick job may start without an
  estimate (*Start work* on a received job card).
- **The work** — *Start work*, *Waiting for parts* and *Work done: ready*,
  each with a note kept in the history (sending a ready vehicle back to work
  needs the reason). *Record the work done* ticks each line as done; *Add
  parts used* puts the parts a mechanic fitted on the estimate at the
  customer's price, as a new version. *Mechanics* names who works on it;
  *Change details* changes the complaints, inspection notes, bay, promised
  time, fuel level and notes while the job card is open.
- **Insurance claim** — *Insurance claim* on the job card: the insurer (one of
  the customers, never the job card's own), cashless (the insurer pays the
  garage) or reimbursement (the owner pays the garage and claims from the
  insurer), the policy number, the claim number, the surveyor and their phone
  and, once the surveyor has passed it, the amount the insurer approved (in
  whole rupees), the deductible and the depreciation. Mark on the estimate the
  lines the insurer pays. The approved amount, and the approved amount with
  the deductible and the depreciation added, are never more than the
  insurer's lines.
  *Take the claim off* makes every line the customer's, in a new version.
- **Customer copy and workshop copy** — *Customer copy* prints, on A5 or A4,
  the vehicle, the reading and fuel in, what the customer says, the estimate
  with its prices, the advance and the claim, with a place for the customer
  to sign; it says it is not a tax invoice, as the bill is made at delivery.
  *Workshop copy* prints the work to do with a box to tick for each line and
  the mechanics; never the prices.
- **Tell the customer** — WhatsApp opens with the message for the stage
  (vehicle received, the estimate for approval, ready to collect with the
  amount to pay, running late, a collect reminder), or *Call*; each is noted
  in the history.
- **Billing and delivery** — *Bill and deliver*, once the job card is
  *Ready*. The bills are posted at the job card's prices, with GST at each
  item's rate on the day (a price that includes GST keeps its total when a
  rate changes; *The bill at delivery* shows the figures as they would be
  posted today). A job with no claim, or with a reimbursement claim, makes one
  bill to the customer for the whole job (a reimbursement claim's bill names
  the claim and the insurer). A cashless claim makes two bills, as CBIC
  Circular 217/11/2024-GST describes: one to the insurer for exactly the
  amount it approved, spread over its lines, which waits on the insurer's
  dues; and one to the customer for their own lines and the owner's share of
  the claim (the deductible, the depreciation and what the surveyor did not
  allow), billed as one line of the claim-share item. The two bills come to
  the job's total to the paisa. The parts leave stock now (serial-numbered
  parts by the numbers typed, batches by the oldest expiry first). The advance pays the customer's bill first; the rest is
  collected now (cash, UPI, card or bank) or goes on the customer's dues. The
  odometer at delivery (optional) goes into the vehicle's log, and the next
  service is set on the vehicle: 6 months and 5,000 km after this job to
  start with (*Settings › Garage settings*), or the day and reading typed. A
  job card with nothing on it is delivered with no bill and leaves the
  vehicle's next service as it was. A bill over ₹2,00,000 asks for the
  buyer's PAN or their declaration, as every bill does.
- **Cancelling** — *Cancel the job card*, with a reason. Nothing is billed and
  nothing leaves stock. The advance stays the customer's: *Hand back the
  advance* (cash, UPI or bank, a reason and a manager's PIN; a receipt
  prints), or it stays on their account for a later bill (*Customer dues*).
- **Vehicles** (*Customers › Vehicles*) — every vehicle with its owner, last
  reading, next service, insurance and PUC dates (in red once due) and a job
  card open in the workshop; the search finds a plate however it is typed, a
  make or model, an owner, a phone or a chassis number. *Add a vehicle*: the
  registration number, make, model, variant, fuel, year, chassis and engine
  numbers (a chassis number belongs to one vehicle), the owner (a customer,
  or a new one by name and phone), the odometer, the insurance and PUC dates
  and the next service. A vehicle's page has its readings, job cards, owners
  and the reminders given; *Change owner* keeps every owner it has had; a
  vehicle sold or scrapped is switched off (*Change*, untick *In use*) once no
  job card of it is open, and is never deleted.
- **The odometer log** — every reading: in and out of each job card, or typed
  on the vehicle (*Odometer reading*). A reading lower than the last is
  refused unless a manager approves it with the reason (a meter replaced or
  reset): a manager gives only the reason; anyone else chooses the manager,
  who types their PIN. The kilometres a day since the meter was last changed
  give the reading the vehicle has probably reached.
- **Service due** (*Customers › Service due*) — every vehicle whose next
  service falls within a week, by its date or by the reading it will
  probably reach, and every one whose insurance or PUC runs out within 30
  days or has run out; the soonest first, with the owner's phone, when they
  were last reminded and how often. *WhatsApp* opens the reminder ready to
  send and *Call* dials; each reminder is kept. *Service*, *Insurance* and
  *PUC* narrow the list, and *Not reminded in the last 30 days* leaves out
  those reminded lately.
- **A customer's statement** (*The owner's statement* on a vehicle's page) —
  each of the customer's vehicles (a fleet's too) with its job cards: the
  date, the reading, the work, the bills, and what was billed, paid and is
  still due; for every date or the dates chosen, and printed with *Print the
  statement*.
- **Garage settings** (*Settings › Garage settings*) — the months and
  kilometres to the next service after a job (6 and 5,000 to start with), and
  the claim-share item: the service item that bills the owner's share of a
  cashless claim. *Make the item* makes one (*Insurance claim: owner's
  share*, SAC 998714, at 18%). The owner's share is billed at that item's
  slab whatever the slabs of the lines it comes from: have an accountant
  confirm it for claims on tractor parts (5%).
- **The bell** — vehicles ready to deliver, and job cards past their promised
  time.

Who does what: a cashier adds vehicles, opens job cards, writes and sends
estimates, records approvals and claims, takes advances and bills the job;
the **Mechanic**, a garage's own role, sees the job cards assigned to them,
records the work done and the parts used, moves the job along and prints its
copies, and sees no prices and takes no money; a stock keeper, an accountant
and a viewer see the job cards, vehicles and the service-due list; a manager
does all of it, approves a lower odometer reading, cancels job cards and
gives discounts.

## Gyms, studios & coaching

A gym, a yoga, dance or fitness studio, or a coaching centre sells its plans
and fees as services, with prices before GST, and keeps members' dues for named
members. A new one starts with **Plans & memberships** on. Recommended in
Settings › Business tools: **Appointments** (personal-training sessions and
trial classes, under *Sessions & trials*); offers, loyalty and stock for a shop
counter can be switched on too. The front desk's **Check-in** is a daily entry
of its own; **Members** holds the members with their memberships, the renewal
calls (*Renewals*) and the contacts behind them (*Member contacts*); the plans
are under *Settings › Membership plans*.

**Before trading:**

1. **GST slabs and SAC codes** — from 22 September 2025, the services of a gym,
   health club, fitness centre or yoga centre, personal training included (SAC
   group 99972, 999723), are at 5% without input tax credit, and charging 18%
   with credit instead is not allowed; coaching and tuition (999293) and dance,
   music and art classes (999291) stay at 18%. Each plan is sold as a service
   item with its own slab and SAC, so a studio that sells yoga and dance gives
   each plan its own. Credit on what is bought only for the 5% services is not
   taken. Have an accountant confirm the slabs before trading.
2. **The joining fee** — a service item (*Joining fee*, with its price and
   slab) in *Products & services*, named on the plans that charge it.
3. **The plans** — *Settings › Membership plans*, *Add a plan*: see the
   screens below. Each plan says, in plain words, what comes back when a
   member cancels (its refund policy): it prints on the membership slip, and
   every membership keeps the version it was sold with. A district consumer
   commission has held a membership's "no refund under any circumstances"
   term unfair, noting that the terms were never given to the member: state the
   policy and give it to them.
4. **The check-in rule** — a member whose fees are overdue by more than 7 days
   is turned away at the desk; change the days, or switch it off, on the same
   screen.
5. **Trainers** — a staff login for each with the **Trainer** role (*Staff &
   access*): they check members in and see personal-training sessions, and
   see no money.
6. **A coaching centre** — the Ministry of Education's Guidelines for
   Registration and Regulation of Coaching Centre 2024 (advisory: each state
   puts them in force) ask, as reported, for a receipt for every fee paid, a
   course fee that is not raised while the course runs, and a pro-rata refund
   within 10 days for a student who leaves midway. Sell each course as a plan
   by months, with its fee in instalments if paid in parts (each payment is a
   numbered receipt); its price is kept as sold for the whole course; and
   cancel a student's membership on the day they leave, with its refund. A
   state's own law can add more (Rajasthan's Assembly passed a coaching
   centres bill in September 2025, and Assam's cabinet approved one in March
   2025): check with an adviser where the centre works.

**The screens:**

- **Check-in** (*Check-in*) — one big box: type or scan the member's code (the
  QR on their membership slip; a scanner types it and presses Enter), or find
  them by name or phone. The answer comes in large type: *is in*, with the
  plan, its last day or the sessions left, and grace days or a second visit
  today said; or turned away, with the reason: no membership, not started
  yet, membership over (its grace days past too), frozen, no sessions left, or
  fees overdue. A pack loses one session a day: coming back the same day uses
  none. A member who also holds a pack can use a session of it instead (*Use
  …*). Every check-in is kept, let in or not: *Today's check-ins* below.
- **Members** (*Members*) — every member with their current membership (a
  plan by time before a pack, the one ending first), its status today
  (*Active*, *Frozen*, *Not started yet*, *In grace days*, *Over*, *Used up*,
  *Cancelled*, *Transferred*, *Upgraded*), its last day or the sessions left,
  what they owe and their last check-in, with the day's figures above.
  *Sell a membership*: a member already saved, or *A new member* (name and
  phone); the plan; the day it starts (today or later, within 180 days); the
  joining fee, ticked for a member's first membership; a discount, for those
  who may give one; what is paid now, the rest staying on the member's dues;
  and *The fee in instalments*. The bill is worked out by the server as it
  will be posted (the plan's price, the member's own prices, offers, GST) and
  shown as it changes. A member gets a code (*M0001*) with their first
  membership; *Member code*, on their page, changes it to the number on a card
  they already hold. Memberships are numbered *MS/2627/0001* (Settings ›
  Number series). A plan's item goes on a bill only from here: a bill made
  elsewhere with it is refused, so every plan sold has its membership.
- **A member's page** — each membership as a card: its plan and number, when
  it runs and what is left, its terms as sold (the price as billed, the
  joining fee, grace days, the freezes left, whether it can be passed on), its
  bill and what is still to pay, where it came from (a renewal, an upgrade or
  a transfer) and what followed it, its refund policy (the version sold), its
  instalments and its history. The steps, each shown to those who may take it:
  - *Renew* — a new membership, of the same plan or another, from the day
    after this one ends (while it runs or within its grace days; once they
    are past, from today).
  - *Upgrade* — to another plan from today: the part of this membership not
    used comes back as a credit note on its bill, and what the member paid
    beyond what is now due on it pays the new bill first; the figures show
    before anything is posted. A credit bigger than the new plan's bill is
    refused: that is a cancellation with its refund, then a new sale.
  - *Freeze* — from today or a day within 60 days, for some days, within the
    freezes and the days in all its plan allows; its last day moves on by
    them. *End the freeze* when the member comes back early gives the days
    back, and a freeze still to come can be called off (it does not count). A
    membership followed by its renewal is not frozen.
  - *Pass on* — when its plan allows it, it is not frozen and its bill is
    paid: what is left (to its last day, its sessions and its freezes) goes to
    another member from today, on the same bill; this membership closes as
    transferred.
  - *Cancel* — with a reason. What comes back is worked out on the screen: the
    days used (from its first day to today, less the days frozen) or the
    sessions used, and the part of the price as billed that was not used (for
    sessions within a time, the smaller of the two parts left), or less if the
    policy keeps a part; the joining fee too if chosen. It comes back as a
    credit note on its bill, and what the member paid beyond what is then due
    is refunded (cash, UPI, card or bank); what they had not paid yet is
    simply owed less. A manager approves it with their PIN. A membership
    passed on by another member gives nothing back: its bill is theirs.
  - *Membership slip* prints the member's code as a QR, the plan and its terms
    and the refund policy of the version sold, for the member to sign;
    *The bill* prints its invoice; *WhatsApp* opens a renewal message.
- **Renewals** (*Members › Renewals*) — the calls to make: memberships ending
  in the next 7 or 15 days, and those that ended in the last 30, not yet
  renewed and with nothing else running after them (a renewal not started yet
  is listed too when it ends within those days). WhatsApp opens with the
  message ready (or a call), and each reminder is kept with how many were
  given; *Renew* sells the renewal from the row. *Fees due* lists each
  instalment falling due or overdue with what is left of it to pay; *Collect*
  takes it as a numbered receipt set against its bill (the shared
  collections).
- **Fees in instalments** — on a sale, *The fee in instalments* splits the bill
  into 2 to 36 parts, one a month from a day, each part's day and amount
  editable; they must add up to the bill exactly, and the bill falls due on
  the last of them. Payments on the bill (at the sale, by *Collect*, or under
  *Payments received*) cover the instalments in order; an instalment past its
  day not fully covered is overdue, and counts for the check-in rule.
- **Membership plans** (*Settings › Membership plans*) — *Add a plan*: its name;
  by days or months, a pack of sessions, or sessions within a time; its price
  before GST with its GST slab and SAC (the plan is made as a service item of
  its own, named as the plan), or an existing service item; the joining fee
  item; how many freezes and how many days in all (none for a pack with no end
  date); grace days after the last day; whether it can be passed on; and its
  refund policy. A change applies to memberships sold from then on; a changed
  policy becomes its next version. A plan is switched off (*Sold* unticked),
  never deleted. *Fees overdue at check-in*: the days (7 to start with), or
  *Never turn a member away for fees*.
- **The bell** — memberships ending in the next three days or in their grace
  days, and instalments overdue.

Who does what: a cashier at the front desk checks members in, sells and
renews memberships, freezes, passes on and upgrades them; the **Trainer**, a
gym's, studio's or coaching centre's own role, sees members, their plans and
check-ins, checks members in, and sees personal-training sessions and marks
them done or missed, with no prices and no money; a manager does all of it,
cancels memberships and approves with their PIN what a cancellation gives
back; an accountant and a viewer see the screens and export them.

## Laundry & dry cleaning

A laundry or dry cleaner takes garments in on a garment order, with a tag on
every garment, and bills its services with prices before GST. A new one starts
with **Garment orders** on; offers, loyalty and stock for what it sells over
the counter can be switched on in Settings › Business tools. **New order** (the
intake screen) and **Orders** are daily entries of their own; *Orders* holds
*Ready & racks* and *Unclaimed*; the price list and the order settings are
under *Services & items › Price list*.

**Before trading:**

1. **The services and their GST** — *Services & items › Price list*, *Add a
   service*: each service the shop offers (wash and fold, wash and iron, dry
   cleaning, steam press, stain removal…) is billed as a service item, an
   existing one or one made with the service (its name, GST slab and SAC).
   Its name on the bill, its GST slab and its SAC come from the item.
   Laundry, dry cleaning, pressing and dyeing (SAC group 99971; dry cleaning
   999712) are at 18% with input tax credit: the cut to 5% from 22 September
   2025 is for group 99972 (beauty and physical well-being), not for
   laundry. The price list warns about a service at another slab. Have an
   accountant confirm each code before trading.
2. **The garments** — *Add a garment*: its name and how one is counted: a
   piece, a pair (two pieces: socks, shoes) or a set of pieces (a two-piece
   suit). Each piece gets its own tag label.
3. **The prices** — in the grid, each garment's price for each service, for
   each one (piece, pair or set) or by the kilo (a bundle weighed at the
   counter). An empty box: that garment does not take that service. *Save*
   keeps the prices changed; the activity log keeps every change, and an
   order keeps the prices it was taken in at. A garment or a service is
   switched off, never deleted.
4. **Order settings** (the same screen, for those who may change settings):
   - *Billed*: at delivery (to start with: the bill is made when the garments
     are handed over, and an advance may be taken at intake), or at intake
     (the bill is made when the order is taken in, paid then or later);
   - *Part of an order handed over*: the whole order paid before any garment
     leaves (to start with), or each handover paying for its own garments;
   - *Express surcharge (%)*: added to each garment's price on an express
     order (none until set);
   - the days to the promised day (3), and for express (1);
   - *Unclaimed after (days ready)* (30);
   - *Terms printed on every receipt*: the shop's terms in its own words.

   Orders keep the rules they were taken in under.
5. **What the receipt says** — a printed "no responsibility" disclaimer does
   not protect a laundry from its own negligence: a district consumer
   commission has held so over a silk saree returned with stains. Claims turn
   on proof: consumer commissions accept a shop's own WhatsApp messages as
   evidence, and a customer who collects and pays without protest weakens a
   later claim. Note each garment's defects and the risk explained to the
   customer at intake, and have them acknowledge it (below).
6. **The tag labels** — a label roll of 50 × 25 mm, or an A4 sheet of 40
   labels: chosen on an order's page (*Roll* or *A4*).

**The screens:**

- **New order** (*New order*) — the counter's intake screen. The customer,
  found by name or phone, or *New customer* (name and phone). A button for
  each garment on the price list: each tap adds a line with its service (the
  one last used for that garment, or its first). On each line: the service
  with its price; how many (pairs or sets) under one tag, or for a bundle by
  the kilo its weight and the pieces counted in it; colour and brand.
  *Noted* opens what was seen at intake: the defects (stain, tear, hole,
  missing button, colour bleed, fading, shrinkage, burn mark, worn, loose
  threads) with a note, the customer's instructions, what the customer was
  told about the risk to it, *The customer saw and acknowledged this*, a value
  they declared, and a tag typed by hand (empty: the next number). The risk
  note records what was said and acknowledged; it never limits a claim.
  *Another* adds one more of the same with its own tag. *Express* adds the
  surcharge to every garment. The promised day is suggested from the days
  set, today to 90 days ahead. Billed at delivery, an *Advance taken* (cash,
  UPI, card or bank) is a numbered receipt that comes off the bill at the
  handover; billed at intake, *Paid now* goes on the bill and the rest stays
  on the customer's dues. The figures are the server's, as the order will be
  kept (before GST, GST, total). *Take in the order* numbers it
  (*LO/2627/0001*, Settings › Number series) and opens it with *Print the
  receipt*, *Print the tags*, *WhatsApp the order* and *Next order*.
- **Orders** (*Orders*) — the open orders, with a chip and its count for each:
  all open, due today, overdue, ready to collect, received, in process, partly
  ready, partly delivered, express and claims waiting. Each row has its
  garments, status, promised day, racks, what is to pay and *WhatsApp*. *All
  orders by date* lists every order, delivered and cancelled ones too. Search
  by order, customer, phone, tag or rack.
- **An order's page** — the customer, when and where it was taken in, its
  status worked out from its garments (received, in process, partly ready,
  ready to collect, partly delivered, delivered, or cancelled when every
  garment is), the promised day (late once it has passed with garments not
  ready), the total and what is to pay. The steps, each shown to those who
  may take it:
  - *Into the work* — received garments, all or those chosen;
  - *Ready on a rack* — garments received or in the work, onto a rack and
    slot (*B-7*) where they hang;
  - *Back into the work* — a ready garment, saying why;
  - *Hand over* and *Cancel garments* — below;
  - *Promised day* — a new day, and the order's notes.

  *Tell the customer* opens WhatsApp with the message ready (taken in, ready
  to collect, running late, a reminder to collect) or calls them, and notes it
  in the history. The garments show each tag, garment and service, colour and
  brand, what was noted at intake, the status and rack, and the charge with
  its bill; *Re-tag* gives a garment in the shop another tag (no two garments
  in the shop hold the same tag), *Tag or rack* moves a ready one, and *Tag*
  prints its label again. *Bills and money* shows each bill with what was
  credited, paid and is still due (its number prints the tax invoice), what
  the garments not billed yet come to today, and the advance with what is
  left of it. *Handovers*, *Damage claims* and the *History* of every step
  follow. *Receipt* prints the order receipt for the customer: every garment
  with its tag, what was noted and acknowledged, the prices (for those who
  see money), the shop's terms and the hold until paid, with a line to sign.
  *Tags* prints a label for every piece of the garments in the shop, with its
  tag number as a barcode.
- **Handing over** (*Hand over*) — the ready garments, all or those chosen.
  Billed at delivery, the bill is posted now: one line a garment, at the price
  it was taken in at, with GST at its service's rate of the day (every garment
  of the order still in the shop when the whole order is paid first; only the
  garments handed over when each handover pays for its own); the advance pays
  it first. Billed at intake, what is paid now goes on the order's bill.
  *Collected now* is what is left to pay, by cash, UPI, card or bank; a bill
  over ₹2,00,000 asks for the buyer's PAN unless it is saved with the
  customer. The garments are held until paid as the order's rule says: a
  bailee who has done work on goods may keep them until paid (Indian Contract
  Act, section 170), unless agreed otherwise. A customer with an account with
  the shop (credit days or a credit limit on their customer record) may take
  them with money still owed, *On the customer's account*. *Collected by*
  names someone else who collected them.
- **Cancelling** (*Cancel garments*) — garments still in the shop, all or
  those chosen, with a reason. Not billed yet: they are cancelled, and an
  advance stays the customer's: *Hand back the advance* (with a manager's
  PIN) once nothing is left on the order to bill, or keep it on their
  account. Billed: each garment's bill line is credited in full, on one
  credit note for each bill; what the customer paid beyond what is then due
  goes back when *Give the money back now* is ticked, by cash, UPI, card or
  bank, with a manager's PIN; otherwise it stays to their credit on the bill.
  A garment with a damage claim waiting is decided first.
- **Ready & racks** (*Orders › Ready & racks*) — one box finds a garment by its
  tag (a scanner types it and presses Enter), the customer's phone or the
  order number, those in the shop first, with its status and rack. *Ready*
  puts a finished garment on the rack typed; *Move* moves a ready one. Below:
  every garment ready on the racks, rack by rack, with how long it has waited.
- **Unclaimed** (*Orders › Unclaimed*) — orders whose garments are all ready
  and not collected for the shop's days or more (30 to start with), the
  longest waiting first, with the garments and racks, what is to pay and the
  reminders sent. *WhatsApp* opens a reminder with the amount to pay, *Call*
  calls; each is kept, with how many were sent. The garments stay held until
  paid; nothing here disposes of a garment, and no Indian rule was found that
  lets a shop dispose of garments not collected.
- **Damage claims** (*Damage claim* on an order's page) — the garment, what is
  wrong (damage, stain, shrinkage, colour run, lost, missing part, other),
  what the customer says and an amount they ask for. One claim at a time
  waits on a garment, and a manager decides it once:
  - *Money back* — part or all of the garment's charge comes back as a credit
    note on its bill line, and what the customer paid beyond what is then due
    is refunded (cash, UPI, card or bank), with the manager's PIN;
  - *Credit note* — a credit note only: it lowers what the customer owes, or
    stays to their credit on the bill;
  - *Reprocess* — the work is done again at no charge: a ready garment goes
    back into the work, and a delivered one is taken back in under its tag
    or a new one;
  - *Rejected* — with a note why.

  A credit note or a refund is at most the garment's charge on the bill, and
  only once it is billed; compensation beyond it (the garment's value) is paid
  outside the bill. What was noted and acknowledged at intake stays on the
  garment, and each claim keeps when it was reported.
- **The bell** — orders past their promised day with garments not ready, and
  the orders ready and not collected for the shop's days.

Who does what: a cashier at the counter takes orders in, moves garments
through the work and onto the racks, hands them over with their bills and
money, records damage claims and prints receipts and tags; a stock keeper
(the presser, say) moves garments through the work and onto the racks and
sees the orders without their money; a manager does all of it, cancels
garments and decides damage claims, approving money back with their PIN; an
accountant sees and prints, and a viewer sees.

## Jewellery & gold

A jeweller prices gold, silver and platinum by the gram at the day's rate for
its purity, bills with prices before GST and rounds to the rupee. A new one
starts with **Gold rates & jewellery** on, and with serial numbers on (each
tagged piece is a serial-numbered unit of its catalogue item, its tag the
number); exchanges, stock transfers, offers and loyalty can be switched on in
Settings › Business tools. Its counter is the **Jewellery bill** (with *Quick
bill* beside it for loose stones, coins at a fixed price, imitation jewellery,
repairs and everything else); **Today's rates** is a daily entry of its own,
with the *Rate board* beside it, and so are **Old gold** and **Gold schemes**;
the stock area opens on **Pieces & tags** (with Stock, Movements, Counts and
Transfers beside it, and **Karigar work**, **Hallmarking** and **Fine
weight**); *Sales history* has **Custom orders** and **Approvals** beside it,
and *Purchases* the **Metal account**; *Reports* has the **Cash report**; and
*Settings › Jewellery settings* and *Settings › Gold scheme plans* hold the
jeweller's own settings.

A jeweller starts with these GST slabs: 3% (the default: gold, silver and
platinum, jewellery and articles of them, coins and imitation jewellery), 0.25%
(rough diamonds and loose precious and semi-precious stones), 1.5% (cut and
polished diamonds sold loose, natural or laboratory-grown), 5% (job work on
another registered person's jewellery or metal; job work on diamonds is 1.5%),
18% (repairs and other services) and nil. Have an accountant confirm each
item's slab and HSN before trading.

**Before trading:**

1. **Today's rates** — every morning, and whenever the rates move, a manager
   sets a rate sheet under *Today's rates*, *Set today's rates*: for each
   purity the shop deals in (gold 24K 999, 22K 916, 18K 750 and 14K 585;
   silver 999 and 925; platinum 950), the selling rate per gram and the rate
   per gram the shop pays for old metal of that purity; morning or evening;
   and where the rates come from (the shop's own, the local association's,
   or the IBJA rate typed in). The form starts from the rates in use (or the
   last ones set). A purity left empty keeps its rate in use. The rates are
   per gram before making charges and GST. IBJA publishes gold, silver and
   platinum rates twice a day, opening and closing, excluding GST and making
   charges, and asks anyone using them for valuation, pricing or transactions
   to subscribe through its official API: here they are typed in by hand.
2. **Jewellery settings** — *Settings › Jewellery settings*: the letters a new
   tag starts with (T to start with, so T00001, T00002 …; up to 6 letters, or
   none) and the hallmarking charge a new hallmarked piece starts with (each
   piece keeps its own, and the bill prints it for each article); under *Old
   gold*, the deduction a new line of old gold starts with, and any lower
   limit of the shop's own on cash paid out for old gold to one seller in a
   day; under *Cash report*, the shop's own alert level for cash with one
   customer in a month, and whether the shop is a reporting entity under the
   PMLA.
3. **Jewellery items** — *Pieces & tags*, *A jewellery item*: each catalogue
   item the shop sells as tagged pieces priced by weight (a gold necklace, a
   pair of silver anklets, an 18K diamond ring), made here (its name, HSN —
   7113 for jewellery of precious metal, 7114 for silverware — and an item
   code, JWL-001 … when left empty) or one already in the catalogue. Such an
   item is goods counted in pieces with serial numbers, at the 3% slab: the
   screen refuses any other. With it, what a new piece of it starts with: the
   metal and purity, the making charge (per gram of net weight, a percentage
   of the metal's value, or flat for the piece) and the wastage (a percentage
   of the net weight, priced at the day's rate). Loose stones, coins sold at a
   fixed price, imitation jewellery, repairs and job work stay ordinary
   catalogue items with their own slabs, billed at *Quick bill*.
4. **The pieces** — *Pieces & tags*, *Tag a piece*, one piece at a time (see
   below): the pieces in the shop when it starts (*Into stock now, with its
   tag*, as opening stock at their cost), and from then on what the shop's
   karigar makes. A piece bought from a manufacturer or wholesaler comes in on
   the purchase (*Purchases*) with its number as the serial number of the
   unit, and is then tagged with that number. Print the tags (below).
5. **Hallmarking** — *Settings › Jewellery settings*, *Mandatory hallmarking*:
   for each location, whether its district is under mandatory hallmarking
   (Yes or No, with the district's name). Until you say, a location is taken
   as under it. Gold jewellery of 2 g or more must carry a BIS hallmark with
   its HUID when sold in those districts (380 from 2 March 2026; later
   amendments may add more: check BIS's list). Tick *The business's annual
   turnover is up to ₹40 lakh* only when it is: such a jeweller is left out of
   mandatory hallmarking. The bell asks about any location not said yet.
6. **The BIS registration** — *Settings › Licences*, kind *BIS registration
   (hallmarking)*, for each location that sells hallmarked jewellery: its
   number prints on the jewellery bill's invoice while it is in force.
7. **Gold scheme plans** — *Settings › Gold scheme plans*, *A new plan*, for
   each scheme the shop offers: its name, how many monthly instalments (2 to
   11), the smallest monthly amount (whole rupees; each customer chooses theirs
   from it), the discount given on the jewellery bill when every instalment is
   paid (a percentage of one instalment: 100 is one month free), and the terms
   printed on the passbook (say *discount*, never *interest*: the screen
   refuses that word). The screen shows the discount as a yearly figure on the
   money held; the jewellery trade federation's guidance for companies'
   schemes (GJF, 2014) keeps it within 12% a year. A plan's terms never change:
   make a new plan for other terms, and switch the old one off (its schemes run
   on).

**The screens:**

- **Jewellery bill** (*Jewellery bill*) — the counter's screen for tagged
  pieces. The customer, found by name or phone, or *New customer* (name and
  phone), or none (a walk-in, who pays the whole bill). Scan or type each
  piece's tag or HUID and press Enter. The server prices every piece as the
  bill would be posted now, at the latest rate of the day for its purity:
  - the metal: net weight × the rate per gram;
  - the wastage: its percentage of the net weight, in grams and at the rate;
  - the making charge, the stones' value and the hallmarking charge;
  - then GST at 3% on the whole (jewellery of gold, silver or platinum, with
    its making and stones, is one supply at 3%), and the bill rounds to the
    rupee.

  Each piece shows how its price was made, and the HUID check: a gold piece of
  2 g or more is billed only with its HUID unless the article is left out of
  the hallmarking order, the business is exempt by its turnover, or the
  location's district is not under mandatory hallmarking (each says which). A
  piece that cannot be billed says why: on approval or at the karigar, at
  another location, sold, no rate today for its purity, no HUID, an item not
  at 3%. A gold scheme the bill redeems, the credit on the customer's returned
  bills and their old gold pay first (below). *Paid by* takes one or several
  payments for the rest (an empty amount on one is the rest of the bill; less
  leaves the rest on the customer's dues). Cash of ₹2,00,000 or more is
  refused for one bill, and from one customer in a day, as on every bill. A
  bill over ₹2,00,000 records the buyer's PAN (filled in from the customer's
  record when it has one), or that they have none and signed a declaration
  (Form 97). *Post the bill* posts an ordinary sale (SI/…, *Sales history*),
  one line a piece in the words BIS asks for (its description, purity and
  tag), and then offers *Print the invoice*, *Till receipt*, *Open the bill*
  (the sale with its payments and returns) and *Next bill*.
- **The invoice** — for each article: its description, net weight (with the
  gross weight and the stones'), purity in carat and fineness (22K916: 22
  carat, 916 fineness), the HUID (or why none was needed), the hallmarking
  charge, and how its price was made (the metal at the rate, wastage, making,
  stones with their certificates); and the statement that the buyer may get
  the purity of the hallmarked jewellery checked at any BIS-recognised
  assaying and hallmarking centre, with the location's BIS registration
  number. BIS asks every invoice for hallmarked jewellery, retail or to
  another jeweller, to show each article's description, net weight of precious
  metal, purity in carat and fineness and hallmarking charges, and that
  statement; printing the HUID is the jeweller's choice.
- **Taking a piece back** — open the bill in *Sales history* and *Return* the
  piece's line, with it going back to stock: the credit note is the core's,
  and the piece comes back into stock with its history saying so (a return
  without going back to stock is refused; melt it afterwards if it cannot be
  sold again). It can then be billed again at the day's rate.
- **Old gold** (*Old gold*) — gold, silver and platinum a customer sells to the
  shop or gives in exchange, each on a numbered voucher (OG/2627/0001), with a
  chip for those with value left, settled, cancelled and all. *Take in old
  gold*:
  - the seller (a customer, found by name or phone, or *New customer*), the
    photo ID seen and its number (of an Aadhaar card, only its last four
    digits are kept), and where it is taken in;
  - each article: what it is and how many, the purity it is valued as, how it
    was tested (karatmeter (XRF), touchstone, acid test or fire assay) and the
    fineness found (parts in a thousand; the purity's own until one is typed),
    the gross weight, the stones and dirt taken off, and the deduction
    (melting loss or the shop's own rule; *Settings › Jewellery settings* gives
    the one a new line starts with);
  - the server values each line as it is typed, at the latest buy rate of the
    day for its purity: the net weight (gross less stones and dirt) × the buy
    rate × the fineness found ÷ the purity's fineness, less the deduction, to
    the paisa; its fine weight is the net weight × the fineness found ÷ 1,000.
    The voucher's value is rounded as the bills are;
  - a voucher worth more than ₹2,00,000 records the seller's PAN (a new
    customer keeps it), or that they have none and signed a declaration
    (Form 97);
  - the seller's declaration that the metal is their own to sell, ticked here
    and signed on the printed voucher.

  Its metal joins the shop's own metal at once. A voucher opens in a panel
  with each article as valued and what became of its value; from there: *Pay
  out* (a manager: by UPI or bank transfer, or in cash — a seller does not
  receive ₹2,00,000 or more in cash for old gold in a day or for one voucher
  (Income-tax Act 2025, section 186), and the shop may keep a lower limit of
  its own in *Settings › Jewellery settings*; each payout is written in the
  expense book, category Other, so *Daily money* shows it, and it is never
  reversed there), *Print the voucher* (for the seller to sign and keep), *Put
  back from …* (below), and *Cancel* (a manager, with the reason, while nothing
  was paid out or used on it: its metal goes back out). The bell tells
  whoever pays out about vouchers taken in before today with value left.
- **Old gold on the jewellery bill** — under *Old gold* on the bill, tick the
  customer's vouchers with value left, or *Take in old gold* there (its seller
  becomes the bill's customer). The old gold pays first, as a payment by *Old
  gold* (a credit note: no money moves), up to what is left on each voucher and
  the bill's total; *Paid by* takes the rest, and what is left on a voucher
  stays on it, to pay out or use on another bill. The sale keeps its full
  value, GST on the new jewellery as billed, and the invoice shows the old
  gold's part with its voucher's number.
- **Gold schemes** (*Gold schemes*) — every customer's scheme, numbered
  (GS/2627/0001), with what was paid in, the next instalment's day, when it
  matures and the day it closes by, and where it stands: paying, an
  instalment due, matured, stopped, past its close day, redeemed (a chip for
  each, and *Open* for all not yet redeemed). *Enrol a customer*: the plan,
  the customer (found, or *New customer*), their monthly amount, a nominee
  (with the relation), the plan's terms for them to read and accept (ticked
  here, signed on the passbook), and the first instalment, taken now. The
  scheme matures the plan's instalments in months after the first one, and
  closes by its day 364: its money is turned into jewellery within the year.
  A scheme opens in a panel with its passbook (each instalment's due day, when
  it was paid, by what and its receipt), its terms as accepted, and what it
  gives; from there: *Take the instalment* (the next one, until all are paid,
  before it matures), *Redeem on a jewellery bill* (opens the bill with the
  customer and the scheme on it), *Remind on WhatsApp*, *Print the passbook*,
  and *Stop* (with the reason, and a manager's approval: their PIN when someone
  else asks). Each instalment is a receipt of the customer's money (it shows
  under *Payments received* and in the day's money), not a sale: the GST is on
  the jewellery bill that redeems the scheme. Cash into one scheme stays under
  ₹2,00,000: its instalments pay one bill, and one bill takes less than that in
  cash (Income-tax Act 2025, section 186). *Money held for the schemes* below
  the list adds up what customers paid into schemes not yet redeemed (owed to
  them as jewellery), the discounts due now and when complete, by plan, with
  *Export* for the accountant. The bell warns of schemes within 30 days of
  their close day, and of any past it.
- **A gold scheme on the jewellery bill** — under *Gold scheme* on the bill,
  choose the customer's scheme. All that was paid into it pays the bill (each
  instalment's receipt as it was paid), so the pieces must come to at least
  that; when every instalment was paid and the scheme has matured, the plan's
  discount comes off the pieces before GST (spread over them by value) and the
  invoice says so. A stopped scheme is redeemed the same way, without the
  discount. The rest is paid as usual; the scheme is then redeemed.
- **Credit from returned bills** — when a customer's jewellery bill was
  returned and not all of it went back as money (what a gold scheme paid never
  does), the credit left shows under *Credit from returned bills* on their next
  jewellery bill: tick it and it pays first, as a payment by credit note with
  the returned bill's number.
- **A bill old gold paid, taken back** — return the piece as above; then
  *Refund* gives back in money at most what was paid on the bill in money, and
  the old gold's part goes back on its voucher: on the voucher's panel, *Put
  back from SI/…* (with the permission to refund). From there it is paid out or
  used again.
- **Today's rates** (*Today's rates*) — the rates in use now, one line a
  purity: what the shop sells at per gram (and for 10 g of gold), what it
  pays for old metal, and when, in which session, from where and by whom it
  was set; the purities not rated today. A sheet is never changed: a
  correction is a new sheet, and for each purity the latest sheet of the day
  that rates it is the one in use, so a bill always takes the latest rate of
  its own day. *Share today's rates* opens WhatsApp with the day's rates
  ready to send. *Every rate sheet* lists the sheets by date, with the ones a
  later sheet of the same day replaced.
- **Rate board** (*Today's rates › Rate board*) — the rates in use in large
  type for a screen in the showroom; a new sheet of rates shows on it as soon
  as it is saved; *Full screen*
  fills the screen with the board alone. Sign the screen in with a login that
  only views (the Viewer role).
- **Pieces & tags** (*Pieces & tags*) — every tagged piece: its tag, its words
  and item, purity, gross and net weight, stones and HUIDs, and its status,
  with a chip for each: in the shop, in stock, on approval, at a karigar, at
  the centre, not hallmarked, to re-hallmark, not in the books (a unit a stock
  count wrote off), sold, melted, all. The search finds a piece by its tag, a
  HUID, its item, its words, its design code, the challan it is out on or its
  custom order. *Tag a piece*:
  - the item, and how it comes in: *Into stock now, with its tag* (where, why
    — opening stock, made by our karigar, other — and its cost; the tag is the
    next number unless one is typed) or *A unit already in stock* (the serial
    number it was received under on a purchase, which becomes its tag);
  - its words on the bill (the item's name when empty), metal and purity, the
    gross weight and the weight of its stones, beads and thread, to the
    milligram (the net weight is gross less stones);
  - the making charge and wastage (from the item, changed for the piece);
  - its design code (the shop's own, like NK-2041), when it has one;
  - *Hallmarked by BIS*, with its HUIDs (the 6 letters and digits of each
    hallmark; a set may carry several, and a HUID belongs to one article) and
    its hallmarking charge; or *The old hallmark, without a HUID* for stock
    hallmarked before HUIDs, which waits to be re-hallmarked (below);
  - for gold, whether the hallmarking order leaves the article out: Kundan,
    Polki or Jadau jewellery; a gold watch or fountain pen; gold thread;
    bullion (a bar, plate, sheet, foil, rod, wire, strip, tube or coin); a
    medical, dental, veterinary, scientific or industrial article; a
    semi-finished article for further manufacture; for export to the buyer's
    specification;
  - its stones, one line a stone or a lot of them: the kind (a diamond is a
    natural one; a man-made one is a *laboratory-grown diamond*: never "lab
    grown", "lab created", "lab diamond" or "LGD", which the screen refuses
    anywhere in a piece's words), how many, carats, colour, clarity and cut,
    the certificate (lab and number), any treatment, and its value on the bill.

  A piece opens in a panel with its weights, stones, hallmark, design code,
  photo, where it is (and the challan it is out on), its custom order, the
  pieces it was made from or into, its price at today's rate (metal, wastage,
  making, stones, hallmarking, before and with GST) and its history. From
  there: *Change* (while it is in the shop: its item and tag stay; out on a
  challan, its weight and purity change only when it comes back on it), *Add
  a photo* (JPG, PNG or WebP up to 5 MB; a new one takes the old one's place),
  *On approval*, *To a karigar* and *For hallmarking* (each opens its screen's
  challan with the piece on it), *Receive it back* or *Open its challan* for a
  piece out, *Split* and *A new tag* (below), *Print the tag* (a label roll of
  50 × 25 mm or an A4 sheet of 40; the tag carries its number as a barcode,
  the purity, gross and net weight, the stones' weight and the HUIDs, and
  never a price), and, for a manager, *Melt* (with the reason): its unit
  leaves stock for good and its metal joins the shop's metal. *Print these
  tags* prints the tags of the pieces in the shop on the page.
- **Splitting, merging and new tags** (on *Pieces & tags*, for someone who
  may tag pieces and correct stock) — *Split* a set into its articles (2 to
  10): each with its gross and stone weight (together they come to the
  piece's own), the HUIDs it carries (each of the piece's HUIDs goes with one
  article) and the stone lines set in it, a tag of its own (the next numbers
  unless typed) and its words; the piece's cost and a flat making charge are
  shared by net weight. *Merge pieces* makes one piece of 2 to 10 pieces of
  one metal and purity at one location: their weights, HUIDs, stones and cost
  added up (a piece waiting to be re-hallmarked is not merged with pieces that
  carry HUIDs; pieces charged differently need the merged piece's making
  charge). *A new tag* gives a piece, after a repair or with its tag worn out,
  a new tag with everything it had (HUIDs, stones, cost, photo, custom
  order). Each goes through the stock: each unit taken out with its reason,
  each new one in at the cost; the old pieces keep their history (*Split*,
  *Merged*, *Given a new tag*) and the fine-weight book is as it was.
- **The shop's own metal** (under the jewellery items on *Pieces & tags*) —
  by purity at each location, in grams of metal and of fine metal (net weight
  × fineness ÷ 1,000): melted pieces, old gold taken in (at the fineness
  found), scrap and metal back from karigars and metal received from
  suppliers, less what went to karigars and to suppliers. It is never billed.
- **Karigar work** (*Pieces & tags › Karigar work*) — the goldsmiths the shop
  gives job work to. *A karigar* (a manager): one of the suppliers, or a new
  one with their phone, GSTIN (empty: not registered for GST) and PAN, and the
  wastage allowed on the pieces they make (a percentage, 0 to 25). *Labour
  rates* (for those who see purchases): for each jewellery item, per gram of
  net weight or per piece. *Issue to a karigar* makes an issue challan
  (KI/2627/0001): the karigar, where from, a custom order it is for (or the
  shop's own work), the day it is due back, and its lines: metal (its purity
  and weight; its fineness is the purity's own unless typed) out of the
  shop's metal, which never goes below nothing; a piece to repair (by its
  tag, with the work to do), which goes to the karigar and is not sold until
  it is back; and stones. *Receive from a karigar* makes a receipt
  (KR/2627/0001), against a challan or their running account: a piece made
  (its item, tag, weights, design code, hallmark and the work, jewellery or
  diamond) is tagged into stock at its labour's cost, with the karigar's
  wastage allowed on it; a piece repaired is weighed again (its weight as it
  was sent and as it is now are kept); scrap and metal come back into the
  shop's metal; stones come back. The labour on a line is the karigar's rate
  for the item unless someone who sees costs types another; a repair's labour
  is typed. A karigar opens in a panel with their metal in fine weight by
  purity: issued, back in pieces, scrap and metal, repairs, the wastage
  allowed, written off, held now, and the actual wastage (what the pieces,
  scrap and repairs do not account for); the pieces with them; their labour
  rates; and their labour and money. *Write off* (a manager, with the reason)
  takes all they still hold of a purity off the book. *Labour invoice* posts
  all their labour not invoiced yet as a purchase from them (a service: no
  stock): 5% GST on jewellery work and 1.5% on diamond work from a karigar
  registered for GST, none from one who is not, with their bill's number and
  date. *ITC-04 data* (for whoever may export) lists, for a period, the goods
  sent to job workers (table 4) and received back (table 5A, with the wastage
  allowed), from the challans and receipts, to download: how often ITC-04 is
  filed was not checked, and nothing is filed from here. The bell tells
  whoever sees the pieces about challans with pieces still out past their day.
- **Custom orders** (*Sales history › Custom orders*) — pieces made to a
  customer's order (CO/2627/0001), with chips for open, past the day
  promised, ready, delivered, cancelled and all. *Book an order*: the
  customer (or *New customer*), what to make, the jewellery item, the design
  (a catalogue reference or design code; a photo of it is added on the
  order), the metal and purity, the weight it should come to, the size, the
  stones, the day promised, and an advance (for those who may take money): a
  receipt (RC/…) by cash, UPI, card or bank transfer, and whether it fixes the
  rate (bhav cut): the latest selling rate of the day for the purity, for the
  grams the advance buys (to the milligram, rounded down), kept on the order.
  More advances: money, or the customer's old gold (a voucher with value
  left: all of it), and either may fix the rate if it is not fixed yet. An
  order's advances are held for its own bill: no other bill takes them, *Apply
  advance* leaves them out, and they are not handed back while it is open. Its
  path: issued to a karigar (*To a karigar* opens the issue challan for it),
  received (the karigar's piece made for it, or *A piece in stock* made its
  own: while the order is open its pieces go on no other bill), at the
  hallmarking centre and hallmarked (*For hallmarking*), *It is ready*, and
  delivered: *Bill it* opens the jewellery bill with the order's
  pieces and customer; the grams fixed are priced at the order's rate and the
  rest at the day's, and its advances pay first (its receipts, then its old
  gold). *Cancel* (a manager, not while it is at the centre): its advances
  are the customer's again. *Print the slip* gives the customer what was
  ordered, the advances and the rate. The bell tells whoever sees its money
  about orders past the day promised.
- **Approvals** (*Sales history › Approvals*) — pieces lent on an approval
  (jangad) challan (AP/2627/0001) to a customer to choose at home, or to
  another jeweller for its counter, with the day they are due back. *Send on
  approval*: who takes them, from where, the day due and the pieces' tags.
  Out on approval a piece stays the shop's stock and is never billed to
  anyone else, sent elsewhere or written off in a stock count. The challan
  shows the days out; *Take back* brings some or all back into stock; *Bill
  what they keep* opens the jewellery bill with the pieces still out, billed
  to the challan's customer (take off those they return). *Remind* opens a
  WhatsApp message, with the customer's consent to reminders. A challan past
  its day is listed under *Past their day*, and the bell tells whoever sees
  the money. The GST time limit for goods sent on approval was not checked:
  the days out are shown, and no limit is enforced.
- **Hallmarking** (*Pieces & tags › Hallmarking*) — *Send for hallmarking*:
  gold and silver pieces in stock go to an assaying and hallmarking centre
  (one of the suppliers, or a new one) on a consignment (HM/2627/0001), with
  the centre's request number; *Print the list* to fill its request form
  (HM/JWLR/F 1.3). At the centre a piece is not sold, sent elsewhere or
  written off; a custom order with a piece there is at the centre. *Back from
  the centre* (someone who may post purchases), once for the whole consignment: each piece hallmarked, with its
  HUIDs typed or scanned (a set may carry several), or rejected; each piece's
  charge (the shop's hallmarking charge unless typed), posted as a purchase
  from the centre at the GST on its bill (18%, or none) with its number. A
  hallmarked piece then carries its HUIDs and its charge, recovered on its
  jewellery bill, and is no longer waiting to be re-hallmarked. *Waiting to
  be re-hallmarked* lists the pieces with the old hallmark: where a HUID is
  needed they are not billed until they come back with one (*Send these*).
  *HUID list* (for whoever may export): every HUID with its piece and status
  (in stock, sold to a consumer, sold to a jeweller, returned by the
  customer, melted) and since when, to download for Manak Online's HUID
  Transfer module; its file format was not checked, so it is a plain list.
- **Fine weight** (*Pieces & tags › Fine weight*) — each purity's metal, in
  grams and fine grams, wherever it is: pieces in stock, on approval, at
  karigars and at the centre, the shop's own metal, and metal with karigars.
  For the days chosen (the month to today to start with): what it held at the
  start, each movement that changed it (pieces tagged in, sold, taken back on
  credit notes, old gold, metal received from and given to suppliers, the
  karigars' wastage allowed and written off, weights corrected), what it holds
  at the end, and where it is; the moves inside the shop (metal to karigars
  and back, pieces made, repairs, pieces moved, melted, split, merged or given
  a new tag) are listed apart: they leave the total as it was. *Count against
  the book*: at a location, purity by purity, scan the tags of the pieces
  found and weigh its metal; the count shows the pieces the book has that
  were not found, those found that the book has elsewhere (sold, out, another
  location), and the difference in fine weight of the pieces and of the
  metal. A count changes nothing: correct stock in the usual way.
- **Metal account** (*Purchases › Metal account*, for those who see
  purchases) — metal from bullion dealers and wholesalers on a metal balance.
  *Metal received or given* makes a metal voucher (MV/2627/0001): metal
  received comes into the shop's metal and the shop owes it in grams; metal
  given (old gold or scrap against what is owed) goes out of it. Each
  supplier's balance shows by purity, in grams and fine grams, beside the
  money owed to them. *Fix the rate* (a manager): grams owed turned into
  money owed, all or part of them, at the rate typed or today's selling rate,
  as a purchase from the supplier at 3% GST (the metal is kept in grams in
  these books, so the purchase takes no stock).
- **Jewellery settings** (*Settings › Jewellery settings*) — the tags and the
  hallmarking charge, the hallmarking rules, old gold's deduction and cash
  limit (above), and the cash report's own alert level and whether the shop is
  a reporting entity (below).
- **Gold scheme plans** (*Settings › Gold scheme plans*) — the plans (above),
  each with its schemes open and in all, and *Switch off* / *Switch on*.
- **Cash report** (*Reports › Cash report*) — the cash the shop took from and
  paid to each customer: cash paid on their bills, their cash receipts (dues,
  advances, gold scheme instalments), cash refunded to them, advances handed
  back in cash, and cash paid out for their old gold, in the month to today
  (or the days chosen), with customers who share a PAN taken as one person,
  largest first. A customer whose cash in and out comes to ₹10 lakh or more
  is flagged: a jeweller that carries out cash transactions of ₹10 lakh or
  more with a customer, at once or in several that appear linked (paying cash
  for old jewellery is one), is a reporting entity under the PMLA, and from
  then on reports each month's cash transactions above ₹10 lakh (and the
  linked ones adding up to more within a month) to FIU-IND by the 15th of the
  next month. The shop may keep a lower alert level of its own
  (*Settings › Jewellery settings*, *Cash report*). A customer's name opens
  their cash transactions; walk-ins' cash with no customer or PAN on the bill
  is shown apart. The *Monthly cash transactions worksheet* lists, for a
  month, each customer whose cash was above ₹10 lakh with every cash
  transaction, and when the report is due; *Export* gives either as a
  spreadsheet. Nothing is filed from here: the shop's officer files with
  FIU-IND. Tick *The shop is a reporting entity* in the settings once it is:
  the bell then reminds the shop of the month's report until the 15th. The
  bell also flags a customer at ₹10 lakh, and those past the shop's level.

A jewellery item's pieces are sold only on the jewellery bill: *Quick bill*,
*New sale* and a quotation's bill refuse its item, and the items the
jeweller's own purchases are booked under (karigar labour, hallmarking
charges, metal fixed on the metal account) are never sold. A piece on
approval, at a karigar or at the hallmarking centre is the shop's stock and is
not sold, sent elsewhere or written off while it is out. With *Stock
transfers* switched on, a transfer moves a piece between locations by its
tag (not while it is out).

Who does what: a manager sets the day's rates, melts pieces, pays out, puts
back and cancels old gold, sets up gold scheme plans and stops schemes (or
approves a stop with their PIN), makes karigars and sets their labour rates,
writes off what is left with a karigar, cancels custom orders and fixes the
rate on a supplier's metal balance; a cashier makes jewellery bills and takes
their money, sees the rates at the counter, takes in old gold and uses it on
the customer's bill, enrols customers in gold schemes and takes their
instalments, books custom orders and takes their advances, sends pieces on
approval and takes them back, tags pieces, sends them to karigars and takes
them back, and sends them for hallmarking; a stock keeper tags and weighs pieces, sees
them without prices, works the karigars' challans and the hallmarking
consignments, and splits, merges and re-tags pieces; an accountant and a
viewer see the rates, their sheets, the pieces, the old gold, the schemes with
the money held for them, the orders and the challans; the owner, a manager and
an accountant see the cash report, export it, the money held for schemes, the
ITC-04 data and the HUID list. Labour and the metal account are for those who
see purchases. The **Karigar / goldsmith**, a jeweller's own role, sees the
pieces and their weights, with no prices and no money: they tag units already
in stock (not new stock), record weights, stones and HUIDs, make issue
challans and receipts of repairs and metal (not of new pieces, which come into
stock), send pieces for hallmarking, and count against the fine-weight book; a new piece they tag takes its item's making charge and
wastage. The rates, old gold, gold schemes, approvals and the metal account
are not on their menu.

## Rentals & hire

A tent house, an equipment or vehicle hire business books what it hires out
for a time, hands it over and takes it back, and bills the hire when it comes
back, with prices before GST. A new one starts with **Hire items & bookings**
on; *Licences & registrations* is recommended to it (self-drive cars and
motorcycles need the State Transport Authority's licence), and quotations and
stock for what it sells can be switched on in Settings › Business tools.
**Bookings** is the daily entry, with *Availability* and *Deposits held*
beside it; the products area opens on **Rental items**. Every time on these
screens (out, due back, overdue, today) is on the business's own clock, in its
time zone, whatever the computer's clock says.

**Before trading:**

1. **The rental items** — *Rental items*, *Add a rental item*: each thing
   hired out is billed as a service item, an existing one or one made with
   it (its name on the bill, its GST slab and its SAC). Renting goods without
   an operator is taxed at the rate of a sale of the like goods, so choose the
   slab of what is hired out: 40% for goods that attract 40% (a large car, a
   motorcycle above 350 cc) from 22 September 2025, 18% for a small car,
   5% for an electric vehicle or a bicycle. A passenger vehicle hired with a
   driver is 5% (input tax credit only of input services in the same line of
   business) or 18% with full credit. Without an operator the SAC is in
   heading 9973 (997329 for other goods); with a driver, 9966. Have an
   accountant confirm each slab and code before trading. Then:
   - *Hired out*: one by one (a generator, a car: each unit with its own name
     and its registration or serial number) or from a pool (200 chairs: how
     many the shop has);
   - *Vehicle*: a car, a motorcycle or scooter, or another vehicle, hired
     self-drive or with the shop's driver; a vehicle's meter is its odometer,
     and another unit may have an hour meter;
   - *Rates* for one: an hour, a day (24 hours), a week and a month (30
     days), any of them. A booking is charged the cheapest mix that covers its
     hours (each hour or part of one counts as an hour): ten days are a week
     and three days when that is cheaper than ten days;
   - *Deposit for each one*, refundable;
   - *Minimum hire* (hours), *Turnaround time* (minutes kept free after each
     hire for cleaning and checks) and the *Late fee*: by the hour, by the day
     or none, at its own rate (empty: the hour or day rate), after a *Grace
     time*.

   A booking keeps the rates and rules it was made at; the activity log keeps
   every change. An item is switched off (not booked again), never deleted; a
   pool is not set below what bookings hold at their busiest.
2. **The units** — on *Rental items*, *Add a unit* (or the units typed with a
   new item): its name, its registration or serial number (a vehicle's
   registration is kept as letters and digits, however typed) and its meter.
   A unit sent for maintenance (*Send for maintenance*) is not handed over
   until it is *Back in service*; a retired one (*Retire*) is not booked, and
   a unit booked or out is not retired.
3. **Handover settings** (the same screen, for those who may change
   settings): *Record the hirer's photo ID at every handover* (on to start
   with), and the *Terms printed on the booking and handover slips*.
4. **Self-drive vehicles** — a self-drive car or motorcycle goes out only
   while the location holds the State Transport Authority's rent-a-cab or
   rent-a-motorcycle licence in force: switch on *Licences & registrations*
   and add it under Settings › Licences, with its dates.
5. **The booking numbers** — bookings are numbered *RN/2627/0001* (Settings ›
   Number series, *Rental bookings*); the bill made at the return is the GST
   document, numbered as the business's sales are.

**The screens:**

- **Bookings** (*Bookings*) — the board: a column for each stage, in the
  order the counter works them: *Overdue* (out past its due back time),
  *Due back today*, *Out*, *Reserved*, *Quotes* and *Back, to settle* (back or
  cancelled with something still to pay or money still held). Each card has
  the hirer, what is hired, when it goes out or is due back, the deposit
  held, what is to pay, and a WhatsApp button with the message ready (the
  booking, a due back reminder, a late reminder). A reserved booking past its
  out time and not handed over says so. *All bookings by date* lists every
  booking by when it goes out, closed and cancelled ones too, searched by
  booking, hirer, phone, item or bill. The bell names bookings past their due
  back time, and those past their out time and not handed over.
- **A new booking** (*New booking*) — the hirer, found by name or phone, or
  *New hirer*; *Out from* and *Due back by*, typed on the shop's clock to the
  minute (today or later, at most 90 days), with *4 hours*, *1 day*, *3 days*,
  *1 week* and *Out now*; a button for each rental item: a unit is chosen by
  its number, each marked free or booked over that time (by which booking),
  and a pool takes how many, with how many are free. Each line shows the
  server's price for the hours booked and its deposit; the total shows the
  hire before GST, the GST, the total and the deposit asked. *Save as a
  quote* holds nothing; *Book it* reserves it, and the server refuses a unit
  or pieces that are not free (the database checks every booking it saves, so
  two counters booking the same unit at the same moment cannot both have it).
  An *Advance taken* is a numbered receipt on account for the hire, at most
  the hire.
- **A booking's page** — where it stands, when it is due back, the hire and
  the deposit held; the next steps, each shown to those who may take it:
  - *Reserve it* — a quote, once what it books is free;
  - *Hand over* — below; a booking whose out time is later is first moved to
    now (*Hand over now (start now)*);
  - *Take back* — below;
  - *Extend* — a new due back time while it is out, the hire priced again at
    the rates it was booked at; what is booked after it must be free;
  - *Change* — a quote's or a reserved booking's times and lines (lines kept
    keep their booked rates);
  - *Take the deposit* and *Take an advance* — a receipt by cash, UPI, card or
    bank;
  - *Cancel* — below; *Hand back* — money still held on a booking back or
    cancelled.

  While it is out the page shows what the bill would come to if everything
  came back now, the late fee so far included. Below: each line with its unit
  or how many, the time charged, the hire with its GST and the deposit, what
  was noted at the handover and what came back; the handover (who handed it
  over, the photo ID, the driving licence, less deposit agreed); the money
  (the bill with what was paid and is due, its number printing the tax
  invoice; each advance and deposit with what paid the bill, what went back
  and what is held, and each refund with its receipt); the returns, the
  charges and the history. *Quote* or *Booking slip*, and *Handover slip*
  once handed over, print for the hirer to sign; a deposit's *Receipt* prints
  with no GST.
- **Handing over** (*Hand over*) — once its out time has come, and before its
  due back time. The hirer's photo ID (its kind and number; of an Aadhaar
  card only the last four digits are typed, and kept); for a self-drive
  vehicle the hirer's driving licence number and the date it is valid until
  (refused once it has run out) and the location's licence in force; for
  each line what is noted about its condition, its meter (never lower than
  its last reading) and a vehicle's fuel. The deposit asked is taken now (or
  was before); less is handed over only with *Hand it over with less deposit
  than asked*, a reason and a manager's say-so (their PIN, unless the person
  handing over is that manager). A unit in maintenance is not handed over.
- **Taking back** (*Take back*) — all of it or a part: a unit back (or *Not
  coming back*, which retires it), how many of a pool back and how many will
  not come back (the pool is lowered by them); the meter and fuel back, the
  condition noted, and *Send it for maintenance*. *Add a charge* for damage,
  missing pieces, cleaning, fuel or anything else, each on the line it is
  for. The late fee is worked out by the server: nothing within the grace
  time; after it, each hour or day late (or part of one) since the due back
  time, at the booked late rate, for each one still out. When the last of it
  is back the bill is posted through the core: each line's hire, the late
  fees and the charges, each at the GST slab of its item on that day. The
  advance pays it first, then the deposit; *Paid now* takes the rest (what is
  not paid stays on the hirer's dues). What is left of the deposit goes back
  now (*Hand back what is left of the deposit now*, by cash, UPI or bank,
  with a manager's PIN) or later from the booking's page. A bill over
  ₹2,00,000 asks for the hirer's PAN unless it is saved with them.
- **Cancelling** (*Cancel*) — a quote or a reserved booking, with a reason.
  A *Cancellation charge* for any line is billed with its GST at that line's
  slab, and the money held pays it first; what is left goes back now (with
  a manager's PIN) or later.
- **Availability** (*Bookings › Availability*) — a week (or two) of days on
  the shop's clock: each unit a row with the bookings holding it on each day
  (*Booked*, *Out*, or *Back, turnaround*), each pool a row with how many are
  free on each day at its busiest. A hold opens its booking.
- **Deposits held** (*Bookings › Deposits held*, for those who see sales) —
  booking by booking, the deposit asked, collected, applied to the bill,
  handed back and held, with the receipts and the bill; those holding money
  first, those back or cancelled (*To hand back*) before those still out; and
  in all: held now, to hand back, applied to bills and handed back. *Export*
  gives it as a spreadsheet.

A rental item's hire is billed only from its booking: *New sale* and a
quotation's bill refuse its service item. A refundable deposit is not a
payment for the hire: it is held apart from sales until it is applied. What
the shop keeps of it (damage, missing pieces, a late fee, a cancellation
charge) is billed as a charge with its GST, and the deposit then pays that
bill; it is never simply kept.

Who does what: a cashier at the counter makes bookings and quotes, hands
things over and takes them back with the bill and the money, and takes
advances and deposits; a stock keeper (the yard) hands things over and takes
them back, sees the bookings without their money, and sends units for
maintenance; the bill made with the last of a booking is made by someone who
bills. A manager does all of it, cancels bookings, agrees to less deposit
and approves money handed back with their PIN; an accountant sees and prints,
and a viewer sees.

## Fuel stations

A petrol pump's back office: the shifts its pump attendants (DSMs) run on the
nozzles, each settled against what the meters sold; the tanks with the
morning dips, the tanker loads and the daily stock register the oil
companies' Marketing Discipline Guidelines ask for; and its fleet customers'
credit. A new fuel station starts with **Tanks, nozzles & shifts** on;
*Licences & registrations* is recommended to it (the PESO licence, Form XIV).
**Shift & readings** and **Tanks & dips** (with *Tanker receipts* and the
*Stock register*) are its daily entries, after *Quick bill*, which bills
lubricants and the shop's items with their own GST; *Fleet statements* sit
with its customers (*Customers & fleets*), and the set-up is *Settings › Pumps
& nozzles*. Every reading is typed in from the totalisers, the dip rod and the
hydrometer: the software never controls or talks to a dispenser, a forecourt
controller or a tank gauge (at an automated outlet those are the oil
company's). Every time on these screens (a shift's readings, a dip's day,
today) is on the business's own clock.

**Before trading** (*Settings › Pumps & nozzles*):

1. **The fuels** — *Add a fuel*: petrol, diesel, a premium grade, CNG. Each is
   a goods item of the catalogue counted in litres (CNG in kilos), kept in
   stock by quantity and on the GST nil slab: petrol, diesel and CNG are
   outside GST, their price including the state's VAT, and each fuel bill
   line says *price includes state VAT*. A fuel's item keeps the nil slab; it
   is sold only by a shift's close (*Quick bill* and *New sale* refuse it) and
   bought only by a tanker receipt (CNG, which comes by pipeline, is bought on
   a purchase). Lubricants and the shop's items are ordinary products at
   their own GST slab, billed at *Quick bill*; have an accountant confirm
   each slab.
2. **The prices** — *Set the prices*: a litre of each fuel (CNG a kg) at the
   outlet, including VAT, as the oil company revises it, from now or from a
   time typed. A shift keeps the prices it opened at; a shift open when a
   price changes closes at the change (below). A price never takes effect
   back into a shift that has closed.
3. **The tanks** — *Add a tank*: its number, the fuel it holds, its capacity,
   and the stock in it now by this morning's dip (with the cost of a litre),
   brought into stock as an opening correction. CNG has no tank.
4. **The dispensing units and nozzles** — *Add a dispensing unit*: its number,
   make and serial number, when the Legal Metrology department stamped it and
   when the stamping falls due; its nozzles, each with its number (one number
   an outlet), the tank it draws from (a CNG nozzle: its fuel) and its
   totaliser now. A unit is *Suspended* (its seals broken, under repair) or
   *Retired*, with the reason; its nozzles are not used while it is. A
   nozzle's totaliser moves only with a shift's close; a meter replaced or
   reset is recorded by a manager (*Meter change*, with the reason).
5. **The measures** — *Add a measure*: the stamped 5-litre measure of the
   daily nozzle test, with its stamping dates. The bell warns of a unit's or a
   measure's stamping 30 days before it falls due (changed under
   *Tolerances*), and once it has.
6. **The tolerances** — what the stock register checks against, the
   guidelines' figures until changed: a tanker's density within 3.0 kg/m³ of
   its invoice's either way; a day's variation within 4% of the dip, and a
   loss also within the evaporation and handling allowance on what was sold
   (petrol 0.75%, diesel 0.25%; 0.60% and 0.20% when the station sells more
   than 600 KL a year on average); the test measure (5 litres).
7. **The PESO licence** — each outlet's licence (Form XIV) with its dates,
   under *Settings › Licences* (with *Licences & registrations* on); *Pumps &
   nozzles* shows where it stands.
8. **The people and the money** — a login for each pump attendant with the
   role *Pump attendant (DSM)* (*Staff & access*); a payment method for each
   oil company's fleet card (*Settings › Payment methods*, of the kind
   *Card*); the fleet customers with their credit days and credit limit, and
   their vehicles (below). Shifts are numbered *FS/2627/0001* (*Settings ›
   Number series*, *Fuel shifts*); the fuel bills a close posts are numbered
   as the business's sales are.

**The screens:**

- **Shift & readings** — the day's board at an outlet: the prices in force
  (and the next one set), each dispensing unit with its stamping and its
  nozzles, each with its totaliser and the shift it is on; the shifts open;
  and those closed today with what they sold, the money expected and the
  attendant's short or excess. *Every shift* lists them all by date. An
  attendant sees their own shifts only.
- **Opening a shift** (*Open a shift*) — the attendant (an attendant opens
  their own; a cashier or a manager opens one for any attendant), the nozzles
  they run (each on one open shift at a time), each from its totaliser as its
  last shift closed it: check it against the meter, since another reading is
  refused (a manager records a meter change first). *Readings taken at* is
  typed when they were taken earlier. An attendant has one open shift at an
  outlet at a time; a nozzle is added to an open shift, or taken off one it
  went on by mistake.
- **Closing a shift** (the shift's page) — each nozzle's closing reading and
  the test pumped back (*5 L test* fills it in); the credit slips: for each
  fill of a fleet vehicle on credit, the customer, the vehicle, the quantity
  and the number of the slip the driver signed; the UPI, card and fleet-card
  takings from the machines' settlement slips, each by its payment method
  with its reference; the cash counted; and a note. As it is typed, the
  server works out what each nozzle sold (the closing reading less the
  opening less the test), each fuel's litres at the price in force (on
  credit and to walk-in buyers), the money expected, and the attendant's
  short or excess: the takings and the cash against the walk-in sales, to the
  paisa. A fill over its vehicle's fill limit, or credit taking a customer
  over their credit limit, needs a manager (*I allow the credit over the
  limit*); a credit fill over ₹2,00,000 needs the customer's PAN; the meters
  never sell more than the stock holds. *Close the shift* posts the sales
  through the core: one walk-in fuel bill (a line for each fuel, paid by the
  takings and then the cash, a short left due on it) and a fuel bill to each
  fleet customer (a line for each slip, with its vehicle and slip number),
  exact to the paisa with no round-off. An excess stays with the shift. When
  a price changed while the shift was open, it is closed with the readings
  taken at the change (*Readings taken at*), and the next shift opens at the
  new price.
- **A closed shift** — the settlement: expected, credit, walk-in, takings,
  cash and the attendant's short or excess; the readings; the sales at the
  price; the credit slips and the fuel bills (each opens for those who see
  sales). *Print the settlement* prints it for the attendant and the manager
  to sign. A closed shift never changes: a manager reopens it (*Reopen the
  shift*), with the reason, before another shift opens on its nozzles. Its bills are
  credited (the litres back in stock), the walk-in bill's takings handed back
  and its nozzles read again from its opening; it is closed again with the
  right readings. The page keeps every close that was reopened.
- **Tanks & dips** — each tank with the day's dip: the litres by the dip
  chart (with the dip read, the water dip, the morning density at 15 °C of a
  nozzle sample and its temperature), who took it and when, the dip before,
  and today its stock by the book: the last dip, plus the loads received
  since, less the meters' sales since. *Take the dip*: one a tank a day,
  before the first shift, typed within the week (an earlier day's with the
  time it was taken); a manager corrects one (*Correct*) with the reason. From
  10 am the bell says when today's dips are not all taken.
- **Tanker receipts** (*Tanks & dips › Tanker receipts*) — every load with
  its invoice, lorry, tanks, short receipt and density check. *Record a
  tanker load*: the supplier, the invoice number and date, the tank lorry, the
  seals, and for each tank it goes into the invoice's litres, value and
  density at 15 °C, the lorry's density at 15 °C, the dips before and after
  decanting, and the density after decanting and 50 litres dispensed. The
  density check shows as it is typed: within 3.0 kg/m³ either way, or outside,
  when the load is refused (*Refused: sent back undecanted*, with the reason)
  or a manager accepts it saying why (the bell shows it for a week). An
  accepted load is a purchase of the fuel at the invoice's value through the
  core, made by someone who makes purchases; what came in by the dips, and how
  short of the invoice, stays with it. The density after decanting is written
  once. A manager cancels a load entered wrongly (*Cancel the load*): its
  purchase is credited and its litres go out of stock.
- **Stock register** (*Tanks & dips › Stock register*) — each tank day by day,
  from one morning's dip to the next, as the guidelines' Annexure 9 works it
  out: the opening dip, the loads received, the meters' sales with the test
  pumped back, the book stock, the next morning's dip, and the variation in
  litres and as a share of the dip, against what is allowed: *Within
  tolerance*, *Loss beyond tolerance* or *Gain beyond tolerance* (a day whose
  next dip is to come waits for it). The bell names a tank whose latest day is
  beyond the tolerance, a gain before a loss (the guidelines stop sales on a
  gain beyond the limits until a sample passes). *Density register*: each
  tank's month, the morning densities and each load's by invoice, at receipt
  and after decanting (the guidelines' Annexure 1). *Export* gives either as
  a spreadsheet.
- **Fleet statements** (*Customers & fleets › Fleet statements*, for those
  who see sales) — each fleet customer with their vehicles, the month's fills
  and quantity, what was filled, what they owe and their credit limit (over it
  in red). *Add a vehicle*: the customer, its registration, the fuel it takes
  on credit and the most it takes in one fill; a vehicle keeps its customer
  and registration, and is switched off, never deleted. A customer's
  statement for a month lists each vehicle's fills (the day, the slip, the
  fuel, the quantity, the price, the amount and the bill), the month's totals
  by fuel, and the account: owed at the start, billed, paid or credited, owed
  at the end. *Print the statement* prints it. An oil company's fleet or
  loyalty card is not the station's credit: it is a payment method, taken
  with the shift's takings and settled by the oil company.

Who does what: a pump attendant opens and closes their own shift with its
readings and takings and takes the morning dips, and sees their own shifts
and money only, with no settings; a cashier opens and closes any attendant's
shift and keeps the fleet's vehicles; a stock keeper takes the dips and
records the tanker loads; a manager does all of it, reopens shifts, allows
credit over a limit, accepts a load outside the density tolerance, corrects
dips, records meter changes and cancels loads; an accountant sees, exports and
prints, and a viewer sees. The fuels and their prices are set by those who
keep the catalogue; the tanks, units, nozzles, measures and tolerances by
those who keep the settings.

## Hotels, lodges & guest houses

A hotel's, lodge's or guest house's front office: its rooms and their
housekeeping status, reservations from walk-ins, the phone and the online
travel sites (OTAs), the check-in with every occupant recorded, the foreign
guests' Form-III reports, the room nights posted night by night at their own
GST slab, and the folio billed at check-out to the guest or to a company. A
new one starts with **Rooms & stays** on; *Tasks* is recommended to it
(housekeeping rounds, maintenance and safety checks). **Front desk** (with
*Rooms & housekeeping*, *Reservations* and *Stays*) and **Foreign guests
(Form-III)** (with the *Guest register*) are its daily entries, and the set-up
is *Settings › Room types & rates*. Nothing here talks to an online travel
site, a channel manager, a door lock or the FRRO portal: an OTA's booking is
typed in with its booking id, and a Form-III report is made on the portal and
marked here. Every date and time on these screens is on the business's own
clock: a night belongs to the date it starts on, the arrival date is the first
night, and the departure date is the morning the guest leaves.

**Before taking guests** (*Settings › Room types & rates*):

1. **The GST slabs of a room night** — the slab of a room night at or below
   the limit and the slab of one above it, chosen from the business's tax
   rates, and the limit a room a night before GST. From 22 September 2025 a
   room night valued at ₹7,500 or less is taxed at 5% without input tax
   credit, and one above ₹7,500 at 18% with credit (Notification
   15/2025-Central Tax (Rate)): choose the 5% and the 18% slab and keep the
   limit at ₹7,500. Each night is billed at the slab its own value decides, so
   a weekend night above the limit is billed at 18% and the weekday nights
   round it at 5%. Nothing is reserved or billed until the two slabs are saved;
   have an accountant confirm them before trading.
2. **The weekend nights** — the nights the weekend rate is for: Friday and
   Saturday to start with (a night is the date it starts on).
3. **The terms** — the property's own (the check-out time, the house rules),
   printed on every registration card.
4. **The room types** — *Add a room type*: its name (Deluxe, Suite, Standard
   non-AC) and its SAC; the adults its rate is for, the most guests the room
   takes and its extra beds; and its rates, each a night before GST: the rack
   rate, a weekend rate, each extra adult beyond those in the rate (none set:
   the room takes no more adults), each child (none set: children stay free)
   and each extra bed. A room type's nights are billed as a service item
   counted in nights, made with it, and only from a stay's folio: any other
   bill refuses it. A change of rates applies to stays booked after
   it; a stay keeps the rates it was booked at. A room type is switched off
   (it takes no new reservations), never deleted, and not while stays of it
   are reserved or in the house.
5. **The rooms** — *Add rooms*: room numbers of one type (101, 102, G-02),
   separated by commas or one on each line, with their floor, at a property
   (one of the business's locations). A room is taken out of use, never
   deleted; it keeps its type and stays in use while a stay is reserved for it
   or in it, or while its type's reservations would not fit in the rooms left.
6. **The people and the money** — a login for each receptionist with the role
   *Front desk*, and for each housekeeper with *Housekeeping* (*Staff &
   access*); the payment methods advances and bills are taken by (*Settings ›
   Payment methods*); a company that pays for its staff's stays is a customer
   with its GSTIN. Stays are numbered *ST/2627/0001* (*Settings › Number
   series*, *Stays*); the bills are numbered as the business's sales are.

**The screens:**

- **Front desk** — the day at the property: how many arrive, are in the
  house and leave today, and the rooms to make up; *Arrivals* (reserved for
  tonight, and those past their arrival day not checked in yet, each with
  *Check in*), *In the house* (each with the nights still to post) and
  *Departures* (leaving today, and those past their departure day: extend the
  stay or *Check out*). *New reservation* starts one, and *Run the night
  audit* posts the room nights (below).
- **A reservation** (*New reservation*) — the guest (found among *Guests &
  companies*, or *New guest* with a name and phone), *Booked by* (a walk-in,
  the phone, or an OTA with its name and booking id) and a company billed
  instead (optional: a customer with its GSTIN);
  the arrival and departure (or a number of nights), the room type and the
  room (now, or at check-in); the adults, children and extra beds, within what
  the room type takes; and, for an OTA's price or a company's rate, an *Agreed
  rate a night* in place of the rack and weekend rates. As it is typed, the
  server prices each night at its own rate (rack, weekend or agreed) with the
  GST slab its value decides, and says whether the room and the room type are
  free. A room is never booked twice over the same night, and a room type
  never holds more reservations on a night than it has rooms in use: both are
  refused with who holds it ("Room 102 is booked by ST/2627/0007 (Kiran Desai)
  for the night of 26 Oct: choose another room"), even for two reservations
  saved at the same moment. *Advance taken* takes money on account with it, at
  most the room nights booked: a numbered receipt in the guest's name, held for
  the stay's bill. *Change* changes a reservation's dates, room type, room,
  guests, beds, rate and company (priced again); *Take an advance* takes more.
- **Check-in** (*Check in*, from the arrival day to the night before the
  departure) — the room (one of the stay's type that is vacant and clean and
  free over its nights), and every occupant, adults and children, not only the
  one who booked: the full name, gender and age, phone and address, the
  nationality, and the photo ID seen with its number (an Aadhaar card, a
  driving licence, a voter ID, a passport, a PAN card or another; of an
  Aadhaar card only the last four digits are typed and kept); a foreign
  national (an OCI cardholder too) with their passport as the photo ID, their
  visa's type and number (or *OCI card* and the card's number), the date they
  arrived in India and their next destination. The occupants match the stay's
  adults and children (change the stay first when more or fewer came).
  *Coming from*, *Going to* and *Purpose of the visit* go on the register; a
  refundable deposit may be taken with it (*Deposit taken now*). The room
  becomes occupied, and each foreign guest's Form-III countdown starts.
  *Registration card* prints the card for the guest to sign: the stay, the
  rate, every occupant with their ID, and the terms.
- **A stay in the house** (the stay's page) — the occupants with their IDs
  and Form-III reports, the folio (every night at its rate and slab, posted or
  still to post, and the extras), the money held and the history. *Add a
  charge*: laundry, food, a pickup or another service from *Rooms, services &
  extras*, at its item's GST slab (goods kept in stock are sold on a bill of
  their own). *Extend or move*: a new departure (the nights to come priced at
  the stay's rates), a move to another room that is vacant and clean (the room
  left is marked dirty), extra beds, the company billed and (a manager) an
  agreed rate for the nights to come. *Take an advance* and *Take a deposit*
  take more money for the stay. A manager voids a charge posted by mistake (*Void*, with the reason)
  before it is billed; a room night is posted again at the stay's rates. An
  occupant's details are corrected while they are in the house.
- **Night audit** (*Front desk › Run the night audit*) — posts every room
  night of the guests in the house up to tonight that is not posted yet, each
  at its rate and slab, and lists what it posted. Run it at the end of each
  day; run again, it posts nothing twice. The bell warns of nights before
  today still to post.
- **Check-out** (*Check out*, on the departure day or earlier) — the bill as
  the server works it out: every night up to last night (one at least) and the
  extras, with the nights posted ahead and not stayed voided when the guest
  leaves early; the advances and then the deposits pay it first, and the rest
  is paid now (*Paid now*, *Paid by*). A guest past the departure day is
  extended to today first. *Check out and post the bill* posts one tax invoice
  through the core: to the guest, or to the company billed with its GSTIN on
  it, the place of supply the property's state. A company's bill may stay on
  its dues; a guest's own bill is paid in full unless a manager checks them
  out with it left on their dues. What is left of the advance and deposit goes
  back now or later (*Hand back*), by cash, UPI or bank, with a manager's PIN;
  a slip prints for the guest to sign. The room is left vacant dirty for
  housekeeping, and each foreign guest's Form-III departure countdown starts.
- **Cancel** (a reservation) — with the reason; once its arrival day has come
  it may be marked a no-show instead. A cancellation or no-show charge, before
  GST, is billed as the room type's nights at the slab of the first night
  booked and paid first from the advance; what is left goes back with a
  manager's PIN.
- **Rooms & housekeeping** — every room by its status: vacant dirty (to make
  up, first), vacant clean (ready for a guest), occupied (with the guest and
  when they leave) and out of order (with why). *Mark clean* once made up,
  *Mark dirty* again, *Out of order* with the reason, and *Back in order* (to
  be made up). A room is occupied only while a guest is checked in, and only a
  vacant clean room is given to a guest. Every change is kept with who made it
  and when.
- **Reservations** — a calendar of a week or two weeks (*Today*, earlier and
  later): for each room type, its rooms night by night with the stay in each,
  the reservations with no room yet, and the rooms left each night.
- **Stays** — every reservation and stay by its arrival date with where it
  stands (reserved, arriving today, not arrived, in the house, leaving today,
  past departure, to settle, checked out, cancelled or a no-show), its room
  nights, what is held and what is due; a row opens the stay.
- **Foreign guests (Form-III)** — each foreign national who stayed, with the
  report due next and its countdown: within 24 hours of arrival, and again
  within 24 hours of departure (Immigration and Foreigners Act 2025, in force
  from 1 September 2025; Form-III replaced Form C, and OCI cardholders are
  reported too). Make the report on the portal (indianfrro.gov.in) or its app,
  then *Mark reported* with the acknowledgement number: nothing is sent from
  here. *To report* shows the reports still to make, overdue first; *The last
  90 days* every foreign guest. The bell lists each report still to make, and
  marks it overdue once its 24 hours have passed.
- **Guest register** (*Foreign guests (Form-III) › Guest register*) — every
  occupant of the rooms between two dates (up to 92 days), with when they
  arrived and left, their address and phone, nationality and photo ID (of an
  Aadhaar, the last four digits), the room, where they came from and go next,
  and a foreign guest's Form-III acknowledgements. *Print the register* prints
  it for the local police.

Who does what: the front desk takes reservations and advances, checks guests
in and out with every occupant, posts charges, runs the night audit, marks
the Form-III reports, prints registration cards and the register, marks rooms
and cancels reservations; housekeeping sees the rooms and marks them clean or
dirty, out of order and back, and sees no money and no guest's ID; a cashier
does the front desk's work but cancelling; a manager does all of it, changes
the rate of a guest in the house, voids charges, checks a guest out with the
bill left to pay and hands money back with their PIN; an accountant sees and
prints, and a stock keeper and a viewer see. Only those who check guests in or
print the register see the guests' ID details, and only those who see sales
see the money. The room types, their rates and the rooms are set by those who
keep the catalogue; the slabs, the weekend nights and the terms by those who
keep the settings.

---

# Part 4 — Tasks, issues & projects

The same screens serve the restaurant (menu entry **Tasks** under Management,
`/tasks`) and every other business (menu entry **Tasks** under Management,
`/business-admin/<id>/tasks`). The entry opens the
first task screen you may use, and a strip at the top of each task screen
moves between them: My tasks · Team board · Calendar · Issues · Projects ·
Templates · Recurring · Reports. Owners switch the three parts on or off in
Settings › Features (restaurant, group *Operations*) or Settings › Business
tools: **Tasks & checklists**, **Issues** and **Projects** (the last two need
Tasks). A restaurant starts with all three on; another business starts with
them off (Tasks is marked *Recommended* for a supermarket, a pharmacy and a
clinic).

## What each person sees

| Person | Sees and does |
| --- | --- |
| Everyone (the module is on) | **My tasks**: what is assigned to them, their role, or "whoever is on shift" when they are on shift. They do the checklist, add photos and comments. |
| `tasks.create` | Creates tasks for themselves, from a template or blank. |
| `tasks.assign` | Assigns anyone (one person, several people, a role, whoever is on shift), changes others' tasks, sets up recurring tasks. |
| `tasks.view` | The team board, the team calendar, recurring tasks and task reports. |
| `tasks.review` | Approves finished tasks that need a review, or sends them back with a note. |
| `tasks.manage` | Keeps the business's own templates; cancels, reopens and deletes tasks. |
| `issues.create` / `issues.assign` / `issues.review` / `issues.manage` | Reports an issue / assigns and fixes issues / closes and reopens them / deletes them. `issues.view` sees all issues; others see the ones they reported or own. |
| `projects.create` / `projects.view` / `projects.manage` | Starts a project / sees every project / changes any project. Members see their own projects. |

Defaults: Owner, Restaurant Admin and Manager have everything; Cashier,
Captain, Kitchen, Store keeper and Stock keeper can report issues; Accountant
and Viewer can see tasks, issues and projects. Staff tied to one outlet see
that outlet's tasks and issues (and whole-business ones) only.

**Who "works here".** In a restaurant: its users and its staff records (an
employee without a login can be named; their manager ticks the task for them).
In other businesses: its members and its stylists, doctors or rooms (resources).
"Whoever is on shift" in a restaurant means rostered that day or clocked in at
that outlet; on a day with no roster it is everyone. In other businesses it is
everyone working there. The first person to start a shared task does it.

In a restaurant, task actions (added, assigned, done, reopened,
cancelled, deleted; issues, projects, recurring tasks and templates too) also
appear in *Activity log* with the task's title. Every "assign to" box searches
people as you type (logins and staff without a login), a page at a time.

## My tasks (phone first)

Tabs **Today** (open now or due today), **Overdue**, **Upcoming** (next 7 days)
and **Done** (today), with a count each; the page opens on Overdue when
something is late. The bar at the top says how many of today's tasks are done,
and a reviewer sees how many wait for them. Tap a card to open the checklist.
A task given to you, or done on another phone, shows by itself.

## Doing a task

Each item is one big row: a tick box, **Yes / No** buttons, a reading with a
number pad (it shows the allowed range, e.g. "OK: 0 to 5 °C"), text, a choice,
**Take photo** (opens the camera), or **Sign** (draw with a finger). A reading
outside its range, the wrong yes/no or a choice marked as failing turns the row
red and **raises an issue at once** (for example "Walk-in chiller: 9 °C (allowed
0 to 5 °C)"), linked from the row. A **critical** item that fails marks the
whole checklist failed whatever its score. Correcting the answer clears the red
but keeps the issue as evidence. **Mark done** stays greyed and says how many
checks are left until every required item (and every photo asked for) is in.
Tasks that need a review show "Waiting for a manager's review"; the reviewer
sees **Approve** and **Send back** on the same screen. Below: comments, photos
and the history trail (who did what, when).

A recurring day that is not done by the end of its window (the end of the
trading day, 5 am; or when the next time of the same day is due) is **missed**
and cannot be filled in afterwards; a manager can **Reopen** it with a reason.

## Team board, calendar

**Team board**: a list (S.No., paging, CSV) or a **Board** of columns To do / In
progress / Done / Missed. Filter by person or role, category, outlet/location,
priority, one-off or recurring; status chips All / Open / Overdue / To review /
Done / Missed / Cancelled. Dragging a card to In progress starts it; to Done
finishes it (if its checklist is complete). **Calendar**: a month with each
day's tasks; tap a day for its list. Managers switch between Team and Mine.

## Templates

**Library**: ready checklists, the ones for this kind of business
first (restaurant: FSSAI hygiene self-inspection, fridge & freezer temperature
log, hot holding, frying oil, opening and closing; kirana: month-end stock
check, expiry check, scale check, udhaar follow-up; pharmacy: monthly expiry
check, medicine fridge 2–8 °C, Schedule H1 register; salon: station
sanitisation, tool sterilisation; meat: cold-room log, fish freshness; wholesale:
van check, loading check, godown audit; and fire safety, first aid, pest
control, deep clean, hiring and induction for everyone). For each: **Preview**,
**Use now** (a task from it), **Make it recurring**, **Copy and edit**.
**Ours**: the business's own templates, built with the checklist builder (tick,
yes/no with the passing answer, reading with lowest/highest OK and unit, text,
photo, signature, choice with the answers that fail, sections; each item can be
required, need a photo, be critical, and raise an issue of a chosen severity).
Archive a template to hide it; tasks already made keep their own copy.

## Recurring tasks

Every day, working days (Mon–Sat), chosen weekdays, a date each month (31 =
last day), every few days, or every shift (restaurant shifts; elsewhere the
shift-change times you give). One or more times a day (a temperature log at
10:30 and 17:00); optionally "opens N minutes before"; start and stop dates;
who; where. The list shows each one's last 30 days ("28/30 done · 93%");
**Day by day** shows the strip and every day's task. **Pause** cancels the days
ahead that were not started. Tasks are made when someone opens a task screen —
no background job — and never twice.

## Issues

**Report issue**: what is wrong, how serious (low: when there is time; medium:
this week; high: today; critical: stop and fix now), category, outlet, the
equipment ("Walk-in freezer", "Scale 2", "Van KA-01-AB-1234"), fix-by date, who,
and photos. Numbered ISS-0001… The life of an issue: **Open → Being fixed →
Fixed** (say what was done) **→ Closed** (a manager checks); **Reopen** if it
comes back. **Make a task** gives the fix to someone as a task that points back
to the issue. In a restaurant, a log-book follow-up has a **Raise issue**
button: the entry stays the shift's note, the issue tracks the fix (one issue
per entry).

## Projects

Blank, or from a plan: **New outlet opening**, **Festival sale set-up**,
**Annual stock audit**, **Shop renovation**, **Staff hiring drive**, **New menu /
product range launch** — each with milestones (dated from the start), task
lists and tasks. A project has an owner, members, start and end dates, a status
(planning, active, on hold, completed, cancelled) and progress (done tasks of
all tasks not cancelled). Tick milestones as they are reached; add tasks to a
list; comments and history at the bottom.

## Reports

For a period (last 30 days by default) and an outlet: **completion rate** (done
÷ due), **done on time**, **missed**, average checklist score, open issues and
the review backlog; **recurring compliance** per recurring task with its day
strip; tasks **by person** and **by category** (due, done, completion, on time,
missed); **open issues by age** (0–1, 2–3, 4–7, 8+ days) and **by category**
(open, serious, reported, fixed, average hours to fix). Every table exports to
CSV.

## The bell

Managers see overdue tasks, tasks waiting for review, serious open issues and
fixed issues waiting to be closed. In Business Admin everyone also sees their
own overdue tasks and the issues assigned to them.

---

# Part 5 — Roles and permissions

There are two permission lists, because the restaurant module and Business
Admin each keep their own:

| | Restaurant admin | Business Admin (other types) |
| --- | --- | --- |
| Permission codes | In the `permissions` table: every code a restaurant role can hold, plus `platform.restaurants.manage`, which only the platform's own login holds | In `business_permissions`, each code belonging to one module |
| Where roles are edited | Users & access → Roles & permissions | Staff & access → Roles & permissions, inside each business |
| Shape of a code | `<area>.<action>` such as `orders.create`, `bills.void` | `<module>.<action>`; the action is view, create, edit, approve, cancel, refund, export or print, and for a few modules discount, assign, review, manage, view_clinical or edit_clinical |
| Every code, listed | [DATABASE.md › Restaurant permission codes](DATABASE.md#restaurant-permission-codes) | [DATABASE.md › Business permission codes](DATABASE.md#business-permission-codes) |

## Restaurant roles

Most areas split into `*.view` (opens the screen read-only) and `*.manage`
(the buttons that change things), so a supervisor can be given
`inventory.view` and see stock without changing it. The actions a restaurant
most wants to control are permissions of their own, so billing can be given
without them: void, refund, reprint, on-the-spot discount, complimentary bill,
correct a payment method, take a dish off after the KOT, close the day, cash in
and out of the drawer, waive a delivery charge, write off a rider's shortfall,
hand back an advance, put a bill on a guest's account, adjust loyalty points,
see takings (`sales.view`), see salaries, approve large write-offs and large
purchase orders, and read the activity log. Someone without one of these can
still do it once with a **manager's PIN**.

### The built-in roles

Shared by every restaurant and fixed; use **Copy role** to make your own
version and change that.

| Role | In short |
| --- | --- |
| **Restaurant Admin** | Everything in the restaurant |
| **Manager** | Everything except changing settings, outlets, users and roles, and approving purchase orders over the limit. Can close the day, void, refund, comp, correct payments, approve large write-offs, waive delivery charges, write off rider shortfalls, see salaries, and run tasks, issues and projects |
| **Cashier** | POS, orders, billing and payments, KOTs, opening the day (not closing it), reprints, reports and takings, guests and feedback, reservations, log book, time clock, staff view, reporting issues. Voids, refunds, discounts, comps, payment corrections, cash in/out, dues and closing the day need a manager's PIN |
| **Accountant** | The books: reports and takings, the business day (to read), expenses, supplier bills and payments, staff and salaries, the activity log; sees tasks, issues and projects. No till and no menu |
| **Store keeper** | The store: stock, counts, wastage, indents, purchase orders, receiving goods and returns, the supplier list and the menu (to read), reporting issues. No payments, reports or salaries |
| **Captain / Waiter** | Menu, tables, take orders, KOTs, the captain app, mark a dish sold out, reservations, pickup screen, reporting issues — no billing and no takings |
| **Kitchen Staff** | Kitchen display and KOTs, sold out, read stock, log wastage, count stock, raise indents, pickup screen, reporting issues, the bake list (*Pre-orders & cakes*, when on) |
| **Collection display** | The pickup-screen TV (`orders.collection`) and nothing else |
| Super Admin | The platform's own login ([The first platform login](#the-first-platform-login-and-the-platform-screens)); never shown or assignable in a restaurant |

Worth knowing: only the Restaurant Admin can approve purchase orders over the
limit until you give `purchasing.approve` to a copied role; cashiers can open
but not close the day; captains and the kitchen can mark dishes sold out; the
built-in Cashier has `staff.view`, so it sees time-clock punch photos.

### Custom roles

**New role** or **Copy role** (optionally moving this restaurant's people onto
the copy). Permissions are grouped by area with *Toggle all*; sensitive ones
(those where money can leak) are flagged, and permissions no screen checks yet
are marked *not checked yet*. Rules: a role needs at least one permission;
nobody can give a permission they do not hold themselves; the restaurant must
always keep at least one active person who can manage both users and roles; a
role in use cannot be deleted.

**Users** are the logins: name, email, mobile, password, status (active,
inactive or locked), one or more roles, and optionally the outlet they are
tied to. An admin can reset a password but never read one, set or remove a
PIN, unlock sign-in, sign someone out everywhere and reset their two-step
sign-in. A new user's first password, and a password an admin resets, works
for one sign-in: the person then chooses their own. The tab
**Till lock & sign-in** sets the automatic till lock and the roles that must
use two-step sign-in.

## Business Admin roles

Each business has its own copies of the standard roles — Owner, Manager,
Cashier / sales, Stock keeper, Accountant and Viewer; a pharmacy also gets
**Pharmacist**, a clinic **Doctor**, **Lab technician** and **Pathologist**,
an optical shop **Optometrist**, a garage **Mechanic**, a gym, studio or coaching centre **Trainer**, a jeweller **Karigar / goldsmith**, a fuel station **Pump attendant (DSM)**, and a hotel, lodge or guest house **Front desk** and **Housekeeping** — plus any roles
its owner makes, edited on a module × action grid. You cannot give what you
do not have, nor change, or set a new password for, someone whose role can
do more than yours; the Owner role cannot be handed out or changed.

| Role | May do |
| --- | --- |
| Owner | Everything, including staff access (and every future permission) |
| Manager | Everything except staff access and, in a clinic, the clinical notes and printed prescriptions and the lab's results, approval and printed reports (those belong to the doctors, the lab technicians and the pathologist); the personal data registers and a person's whole data included |
| Cashier / sales | Sales, collections, printing; add customers; book and complete appointments; see products, stock and price lists |
| Stock keeper | Products, receiving purchases, stock corrections, counts (not approving them), transfers |
| Accountant | See everything but the personal data registers, record payments and collections, export and print; no stock changes |
| Viewer | See and export everything but the personal data registers; change nothing |
| Pharmacist (pharmacy only) | Sell and refund at the counter, prescriptions and the H1 / Schedule X registers, the sign-off for Schedule X, recalls and expiry returns, the drug master; see stock and purchases |
| Doctor (clinic only) | Patients with their clinical records (see and write), appointments, lab orders; see bills; their own queue and the consultation in the clinic workspace |
| Lab technician (clinic only) | Samples and results, in the lab workspace or Business Admin; see patients |
| Pathologist (clinic only) | As the lab technician, plus approving reports and exporting |
| Optometrist (optical shops only) | Record and correct prescriptions; pass or fail spectacles at the quality check; book and complete eye tests; see customers, products and spectacle orders without their money; no money |
| Mechanic (garages only) | See the job cards assigned to them; record the work done and the parts used, and move the job along; print its copies; see products, stock and service bookings; no prices and no money |
| Trainer (gyms, studios & coaching only) | See members, their plans and check-ins; check members in; see personal-training sessions and mark them done or missed; no prices and no money |
| Karigar / goldsmith (jewellery shops only) | See the pieces with their weights, stones and HUIDs; tag pieces already in stock, record their weights, stones and HUIDs, and send them on approval or to the karigar and take them back; see products and stock; no prices and no money |
| Pump attendant (DSM) (fuel stations only) | Open and close their own shift: the nozzle readings, the 5-litre test, the credit slips, the UPI, card and fleet-card takings and the cash; take the morning dips; see the tanks, the tanker loads and the registers, and only their own shifts and money; no settings |
| Front desk (hotels, lodges & guest houses only) | Take reservations and advances; check guests in with every occupant and their photo ID, and out with the bill; post charges on the folio; run the night audit; mark the Form-III reports; print registration cards and the guest register; mark rooms; cancel reservations and mark no-shows; add customers and take their payments; no settings, and no money handed back |
| Housekeeping (hotels, lodges & guest houses only) | See the rooms and mark them clean or dirty, out of order and back in order; see the reservations and stays without money or the guests' IDs |

A permission also needs its **module** switched on for the business
(Settings › Business tools; for example `repairs.create` needs *Repairs &
service*). Every code, by module, is listed in [DATABASE.md › Business
permission codes](DATABASE.md#business-permission-codes).

---

# Part 6 — A day in the life, and what is not built yet

## A day in the life

| When | Who | Screen | What happens |
| --- | --- | --- | --- |
| Before service | Manager | **Business day** | Open the day (each outlet its own) and count the opening float into the drawer. Nothing can be sold until this is done |
| Before service | Manager | **Tables & QR → Captain sections** | *Copy yesterday's plan*, adjust, save |
| Before service | Manager | **Kitchen display → Sold out** | Mark anything not available today |
| Before service | Anyone | **Log book** | Read what the last shift left; close follow-ups dealt with |
| Service | Host | **Reservations**, **Tables** | Answer online requests, seat bookings and walk-ins |
| Service | Captain | **Captain app** | Take orders at *My tables*, answer guests' calls, serve food from the pass |
| Service | Cashier | **POS**, **Bills & payments** | Raise bills, apply offers, take payment (and tips), print |
| Service | Counter | **Table requests** | Accept QR and online orders — nothing is cooked until accepted |
| Service | Manager | **Dashboard** | Watch takings, live service and *Needs attention* |
| Deliveries | Stores | **Purchase orders** | Receive goods and the supplier's bill — this is what puts stock on the shelf |
| After deliveries | Cashier | **Deliveries → Settle cash** | Settle each rider's cash |
| Any time | Manager | **Expenses**, **Waste & reorder** | Record and approve spending; log wastage |
| After service | Manager | **Business day** | Close each drawer (count it), then close the day; note the variance |
| After service | Manager | **Reports → Day end** | Print the Z report, sign it, file it |
| Next morning | Owner | **Reports → Theft control** | *Yesterday*: voids, refunds, discounts, dishes taken off, drawers short |
| Weekly | Owner | **Reports → Items & menu**, **Dish profitability** | What is not selling, what leaves too little |
| Weekly | Manager | **Waste & reorder → Reorder** | Draft purchase orders for what will run short |
| Monthly | Accounts | **Reports → GST filing**, **Day book (Tally)** | *Last month*: check the self-checks, download the files |
| Monthly | Owner | **Reports → Profit & loss** | Did we make money, and where did it go |
| Monthly | Manager | **Staff → Tips**, **Payroll** | Share out tips, then roll attendance into pay and mark it paid |

**The one rule to drill into staff:** open the day before service and close it
after. The business day is what every figure hangs from — leave it open and
last night's takings land on today's sheet.

## Not built yet: what to do meanwhile

**Guest pages still to come.** Three pages of the guests' site answer with
*Coming soon* and what to do until then: `/shop` (ordering from a shop: call
or message the shop), `/appointments` (salon and clinic bookings: call to
book) and `/account` (a guest's orders, bookings and points in one place: open
the link you were sent).

**Other things not built yet, and what to do meanwhile:**

- **Payments are recorded by people.** A UPI QR can be shown for the exact
  amount, but nothing confirms the money arrived until a payment gateway is
  connected. Online orders are pay-at-collection or cash on delivery.
- **The system sends no SMS, WhatsApp or email by itself** (booking status,
  waitlist, reminders); guests follow their own status pages. A *WhatsApp*
  button opens WhatsApp on the device with the message ready, and a person
  sends it.
- **Swiggy and Zomato** orders are typed in, and their payouts are not
  reconciled here.
- **There is no map.** A delivery address is typed in, with a landmark, and
  riders find it with a maps app of their own; the delivery charge is set per
  channel, not by distance.
- **Printing goes through the browser** (58 mm, 80 mm or A4); silent thermal
  printing, the cash-drawer kick and scales need hardware and a print bridge.
- **The day book is a CSV for an Excel-to-Tally import**, not a live link.
- **Tax settings need your accountant's review** before go-live. Bills keep
  the tax, document type and logo they were issued with.
- **No e-invoices are made here.** *GST thresholds* warns as a PAN's
  turnover nears ₹5 crore, where e-invoicing applies, and ₹10 crore, where the
  IRP's 30 days apply, and once it passes them (what applies there applying
  from the next 1 April, or now when last year passed them); the e-invoices
  themselves are made on the IRP, directly or through your GST software,
  outside the platform.
- **There is no self-service password reset.** An admin sets a new password:
  Users in a restaurant, Staff & access › *Password* in a business, and the
  platform screens for a restaurant's admin or a business's owner. The person
  signs in with it once and then chooses their own.
- **A PIN an admin sets is not changed by itself.** A PIN set for someone in
  Users (⋯ › *Set PIN*) stays until they change it under My profile › Personal
  PIN: ask them to straight away.
- **A CSV import makes plain items and contacts.** A style's sizes and
  colours, pack sizes, kits, price lists, shelf places, member prices and a
  type's own details of an item (a book's, a medicine's drug details, a farm
  input's kind) are added on their screens after the import, and customers'
  consents on each customer's form ([Products, customers and suppliers from
  a CSV file](#products-customers-and-suppliers-from-a-csv-file)).
- **A business cannot be handed over.**

  The Owner role is given only when a business is created and cannot be
  handed out: give the person who runs it a role in Staff & access (Manager,
  or a role made under Roles & permissions).
- **A GST rate change moves items and dishes only.** On the change's date,
  change by hand the rates kept in settings: a fashion shop's *GST by price*,
  a lodge's two room-night slabs, and a restaurant's default GST rate (its
  advances' GST). A new rate for jewellery or fuel needs a change to the
  platform.
- **A clinic prescribes from no drug list.** The doctor types each medicine
  by its generic name (the clinic's earlier medicines are offered), and
  nothing checks it against the patient's allergies, other medicines or the
  dose: the doctor does. Tests a doctor orders reach the lab unbilled: the
  front desk bills them on *Sales*, and the order still says *Not billed*.
- **Without the internet.** Business Admin and the guests' site are web pages
  that talk to the platform's server. When the server sits in the restaurant,
  tills on its own Wi-Fi keep working without an internet line. The kitchen display
  says *Cannot reach the server — retrying* and recovers by itself, every live
  screen says *Reconnecting* and catches up once the server answers, and a
  guest's cart on the QR menu survives a reload. A till cut off from the
  server cannot bill: there is no offline billing.

Everything still to come, in order, is in [BACKLOG.md](BACKLOG.md).

---

*Before going live: [GO_LIVE.md](GO_LIVE.md).*
