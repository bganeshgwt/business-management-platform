# Glossary

For everyone who uses or builds the platform: the words on its screens and in these documents, what each one means and, for developers, where it lives in the database.

## The product and its applications

| Name | Meaning |
|---|---|
| **Business Management Platform** | The product, everywhere a user reads it ("Business Platform" only where space is tight). |
| **Business Admin** | The staff application: one place to run every business you belong to, with a switcher at the top. The technical documents call it the **staff app** (`apps/business-web`). |
| **Guests' site** | What a restaurant's guests open without signing in (`apps/customer-web`): the menu behind a table's QR code, online ordering and table booking. |
| **POS and kitchen display** | Restaurant screens inside Business Admin: the POS (`/pos`), where captains also take orders, and the kitchen display (`/kitchen`). |
| **Platform console** | The *Platform* screens inside Business Admin: Platform › Restaurants (`/platform/restaurants`) and Platform › Businesses (`/platform/businesses`). The Super Admin creates restaurants and businesses there with their owners' logins, switches them off and on, and sets a new password for a locked-out owner. It shows no business's bills or customers. A separate platform application, with plans and subscriptions, is planned. |
| **Planned page** | The address of a screen that is not built yet. It opens a page that says what is coming and what to use meanwhile, never "Page not found". Business Admin has them for a captain app for waiters (`/captain`) and for clinic and lab workspaces (`/clinic`, `/lab`). The guests' site has them for ordering from a shop (`/shop`), booking a salon or clinic appointment (`/appointments`) and a guest's own account (`/account`). |

Inside Business Admin a restaurant is simply the restaurant business's own admin (its menu, tables, kitchen, POS and reports), not a separate product. A café, a bakery and a cloud kitchen are restaurants too, each in its own *format*.

## Platform words

| Word | Meaning | Where it lives |
|---|---|---|
| **Platform** | Everything shared by all businesses: the module catalogue, the permission catalogue, the role templates, and later plans and subscriptions. | `platform_*`, `business_permissions`, `business_role_templates` |
| **Super Admin** | The platform's own account. It belongs to no restaurant or business, and its home is the platform console. The first one is made when the platform is installed ([README.md › The first login](../README.md#3-the-first-login)). | `users` with no restaurant, role `SUPER_ADMIN` (`roles`, `user_roles`) |
| **Business** | One independent business (a tenant). Its data is separate from every other business's. | `businesses` |
| **Business type** | What kind of business it is: restaurant, grocery / kirana, supermarket, wholesale / FMCG, fashion, electronics, pharmacy, books & stationery, salon & spa, clinics & labs, meat & seafood, other weight-based shops, general store & other shops, hardware, paints & building materials, seeds, fertilisers & pesticides, optical shop, vehicle service & auto parts, jewellery & gold, fuel station, gym, studio & coaching, laundry & dry cleaning, rentals & hire, hotel, lodge & guest house. Fixed once the business exists. | `business_types`; trigger `businesses_type_is_fixed` |
| **Format** | What kind of food business a restaurant is: restaurant, café, bakery or cloud kitchen. All four run on the same restaurant screens. The format sets how the POS opens and which features it starts with, and the owner can change each afterwards. | `restaurants.format` |
| **Location / outlet** | A shop, counter or warehouse of a business, with its own stock and document numbers. Restaurants call theirs *outlets*; other businesses call them *locations*. A person can be tied to one location and then works there only. | `business_locations`, `business_memberships.location_id`; restaurant: `outlets` |
| **Module / business tool** | A part of the product a business can use: Sales, Stock, Stock transfers, Appointments… *Core* modules (Business settings, Staff & access, Reports, Activity log) are always on. The others are the business's *business tools*, switched on in Settings › Business tools. A restaurant calls its modules *features* (Settings › Features). | `platform_modules` |
| **Capability** | A module switched on for one business: what the business may use. Later decided by its plan. | `business_capabilities` |
| **Role** | A named set of permissions inside one business. Every business starts with Owner, Manager, Cashier / sales, Stock keeper, Accountant and Viewer; a pharmacy adds Pharmacist, and a clinic adds Doctor, Lab technician and Pathologist. An owner can add roles of the business's own, and each business has its own copies. A restaurant has its own built-in roles, such as Restaurant Admin, Captain / Waiter and Kitchen staff. | `business_roles`; restaurant: `roles` |
| **Permission** | One action on one module, written `module.action` (for example `sales.refund`): what a person may do. The actions are view, create, edit, approve, cancel, refund, export and print, and for some modules discount, assign, review, manage, or see and write clinical records. | `business_permissions`, `business_role_permissions`; restaurant: `permissions` |
| **Membership** | A person's access to one business, with their role there. One login can have many memberships. Inside a business the header shows the person's role there. | `business_memberships` |
| **Business code** | A business's short code, fixed when the business is created. Staff who sign in with a staff code type their restaurant's code too, and so does someone whose mobile number signs in to more than one restaurant. A restaurant's code is its business code. | `restaurants.code`, `businesses.code` |
| **Document** | A posted money record of the shared core: a sale or a purchase, with its returns, payments and refunds. The restaurant's equivalents are its bills, purchase orders and goods receipts. | `business_documents` (+ lines, payments, returns, refunds); restaurant: `bills`, `purchase_orders`, `goods_receipts` |
| **SKU** | One item of the shared core that is sold or kept in stock. Each variant, such as one size in one colour, is its own SKU. | `catalog_skus` under `catalog_products` |
| **Lot** | The stock of one SKU at one location, optionally of one batch (with its expiry) or one serial number. Every change to it is a movement. | `business_stock_lots`, `business_stock_movements` |

A request is allowed only when **both** hold: the business has the module switched on, and the person's role in that business has the permission.

Table names follow fixed prefixes (`platform_`, `business_`, `catalog_` and each type's own). [BUSINESS_PLATFORM_DATA_MODEL.md › Table names](BUSINESS_PLATFORM_DATA_MODEL.md#table-names) sets them out.

## Restaurant words

Most arguments about numbers are really arguments about words. Settle these first.

| Term | Means |
| --- | --- |
| **Business day** | The trading day, opened and closed by a manager. A kitchen serving until 1 am is still on the day it opened. **Not** the calendar date. |
| **Day cut-off** | The hour (5 am by default) until which last night's business day stays the trading day. Other businesses have a day cut-off too, which applies to their tasks only. |
| **Order** | What the guest asked for. It can still be changed. |
| **KOT** | Kitchen order ticket: an order's dishes sent to a kitchen station, on the kitchen display or as a printed slip. Taking a dish off after its KOT is a cancellation and needs a reason. |
| **Captain** | A waiter who takes table orders on the POS. The day's captain sections give each captain a floor, a section or single tables. |
| **Bill** | What the guest is charged. Raised from an order, it closes the order to changes. |
| **Payment type** | A name the owner gives a way of paying, such as a meal card, PhonePe or a cheque, under one of the till's methods (Cash, Card, UPI or Other). The till offers it under its method, and the reports total it apart. Other businesses call theirs *payment methods*. |
| **Void** | The bill should never have existed. Possible only while no money is held on it and it is not settled. |
| **Refund** | Money was taken and is going back. Recorded against the bill and visible in reports. |
| **Gross sales** | Menu value of what was sold, before tax. |
| **Net sales** | What the guest actually paid: after discount, including tax. |
| **Covers** | Guests at dine-in tables whose bill falls in the period, each order counted once. Takeaway and delivery have none. |
| **Per head** | What those dine-in tables were billed, divided by their guests. The same figure on the dashboard, the sales report, the outlet comparison, the staff report and the day end. |
| **X report** | A mid-shift reading of one cashier's drawer. It changes nothing. |
| **Z report** | The day's own report, printed at close for a manager to sign and file. |
| **Reorder level** | The stock figure at which you would place an order. Not zero. |
| **Last cost** | What an ingredient cost on its most recent purchase. |
| **Variance** | Counted cash minus expected cash at close: over or short. |
| **Sold out vs archived** | Sold out (*unavailable*): not on sale until it is switched back on, with a tap. Archived (*inactive*): off the menu for good, kept for past bills. |

### Two distinctions that catch people out

**Order total is not net sales.** An order is priced when taken; a bill may then carry a discount, service charge and rounding. The bill is the truth.

**A dish with no recipe sells fine and moves no stock.** If stock figures drift, this is the first place to look.

## Trade words

### Wholesale and customer credit

| Word | Meaning |
|---|---|
| **Sales order** | What a trade customer asked for, at prices fixed when it was taken. Moves no stock. |
| **Dispatch** | Sending some or all of an order. Each dispatch is a tax invoice (a sale) and is when stock leaves. |
| **Back-order** | What was ordered and not sent yet, until it is sent or the order is closed short. |
| **Route / beat** | A route is a delivery run; a beat is the shops on a route that one salesperson visits on a set day. |
| **Collection** | A numbered receipt of money from a customer, put against their bills. |
| **Advance** | Collected money not yet put against a bill. It already lowers what the customer owes. |
| **Outstanding / Udhaar** | What customers owe. Wholesale calls it outstanding and a kirana calls it udhaar: the same records. |
| **Ageing** | Outstanding money split by how old the bill is: 0–30, 31–60, 61–90 and over 90 days by default. An owner can set the three edges in Business settings › Rules. |

### Salon & spa

| Word | Meaning |
|---|---|
| **Stylist / room** | A salon resource that can be booked. A stylist has skills (the services they do); a room is booked alongside a stylist for services that need one. |
| **Clean-up time** | Minutes after a service when the stylist is still busy. A booking blocks the service time plus this. |
| **Deposit** | Money taken when booking. It is the client's advance and comes off their next bill. |
| **Late cancellation / no-show charge** | Part of the price kept, only out of the deposit, when a booking is cancelled too late or the client does not come. |
| **Package** | Sessions of services bought together, valid for a number of days, used up on later bills. |
| **Membership** (salon) | A discount on services and products for a number of days, applied by itself. Not the same as a person's membership of a business. |
| **Commission** | A stylist's share of the bill lines they did, from the most specific rule, fixed when the bill is saved. A stylist on a monthly target plan earns by slabs of the month's net service sales instead. |

### Meat and weight-based shops

| Word | Meaning |
|---|---|
| **Today's rate** | The price per kg of an item sold by weight, for the day. Rates are changed on *Today's rates*, one at a time or a whole category by ₹ or %, and every change is kept in the rate history. |
| **Cutting batch** | Cutting or cleaning one weighed input into the cuts that are sold (numbered CP/…). |
| **Yield** | The weight of the cuts as a % of the input; **process loss** is the rest. A **yield template** says what an input normally gives. |
| **Wastage** | Weight written off (trimming, spoiled, unsold, drip loss, damaged), taken out of stock at its cost. |

### Café, bakery and cloud kitchen

| Word | Meaning |
|---|---|
| **Pre-order** | An order for a later day (a cake, a party tray) with the message, the time it is due and, while *Advances & deposits* is on, an advance. It is made ready and, on collection, billed as a takeaway order, which takes the advance first. |
| **Bake list** | Everything the open pre-orders booked at one till (an outlet, or the main counter) and due on a day need, added up, for the kitchen. |
| **Sold by weight** | A dish or bake priced per kg; the quantity on the order is the weight (0.25 = 250 g). |
| **Day-end unsold** | What is left on the shelf at closing. What will not sell tomorrow is written off at cost as "Unsold at day end"; what keeps stays in stock. |
| **Brand** | One of the names a kitchen sells under: a cloud kitchen might sell curries under one brand and wraps under another. A category belongs to one brand or to all. An order is taken under a brand, which its KOT and bill print and the brand report counts. |

### Shops and electronics

| Word | Meaning |
|---|---|
| **Quick bill** | A shop's counter screen. Items go on by barcode, scale label, ISBN, IMEI or name. Each bill takes one payment (cash, UPI or card, by the name of one of the business's payment methods) or goes on udhaar, with part paid in cash if the customer wishes. An electronics shop can also sell on EMI. |
| **Payment method** | A way a shop takes money, under the name it chose (PhonePe, Sodexo…), each of one of five fixed kinds: cash, UPI, card, bank, cheque. The accounts count the kind; the day's money shows the name. |
| **Branch price** | A location's own selling price for an item. A branch without one sells at the item's price. |
| **Department** | A part of a store (Clothing, Home, Grocery…). Top-level categories belong to one. A person tied to a department sees and changes only its products and stock, and still bills any item. |
| **Opening stock** | What is already on the shelf when an item is added. It goes into stock at once, with "Opening stock" as the reason in the stock movements. |
| **Daily money** | What the counter sold and the money that came in and went out on a day, by payment method, person and counter. |
| **Cash check** | The drawer counted against what it should hold. A difference needs a reason; the check is kept as it was saved. |
| **Cashier shift** | One cashier's float and closing count at one counter, checked against their own cash in and out. A closed shift is a permanent record. |
| **Kit** | Items sold together at one price ("mobile + cover + screen guard"). On the bill the price is split over the parts, and each part's stock goes down. |
| **Credit voucher** | Credit from an exchange or a return, printed as a numbered voucher and spent at the counter. It can be spent for the number of days set in Business settings › Rules. |
| **Markdown** | A fashion shop's % off every size and colour of one style, until an end date. It runs as an offer; the shelf price never changes, so it goes back by itself. |
| **GST by price** | Garments taxed by their value per piece: a lower rate up to a set value and a higher rate above it, worked out on each sale line after discounts. The shop sets the value and the two rates. |
| **EMI case** | An EMI sale's financed part: the customer pays a down payment, and the financier (Bajaj Finserv, HDFC Bank…) owes the rest until its payout, less its subvention, is recorded. |
| **Quotation** | An estimate at today's prices with a date it is valid until (numbered QT/…). It moves no stock and is not a tax invoice. Once the customer agrees it becomes a bill, or a sales order, at the quoted prices. |
| **Revision** (of a quotation) | The quotation priced again with changed lines, keeping its number; the lines it replaced are kept with the revision. |
| **Expired quotation** | An open quotation past its *Valid until* date. Its prices must be revised before it is billed. |
| **Licence** (Licences & registrations) | A licence or registration one location holds (a trade licence, FSSAI, a fertiliser authorisation letter…), with its number, the authority and the dates it is valid. *In force* on a day when it is on and the day falls within its dates. The bell warns 60 days before one runs out. |

### Hardware, paints & building materials

| Word | Meaning |
|---|---|
| **Site** | A contractor's or builder's place of work, under one customer: its bills, quotations and sales orders go to it, and it is closed (never deleted) when the work is done. |
| **Site ledger** | A site's bills, goods back, payments and refunds in date order with the running balance: what the site owes. |
| **Coverage** | What one unit of an item covers: the sq ft a box of tiles lays, or the sq ft a litre of paint covers in one coat. Kept on the item for the calculators. |
| **Today's rates** | A hardware shop's board of the items whose price changes every day: today's prices typed and saved together, shared on WhatsApp. |
| **Fitter** | A painter, plumber, electrician, mason or carpenter who brings customers to the shop and earns commission on their bills. |
| **Fitted by** | The fitter named on a bill when it is posted; the bill's commission goes to them. |
| **Commission rule** | What a bill line earns its fitter: a percent of its value before GST for every item, a category or one item, or an amount per unit of one item. The most specific rule wins. |
| **Taken back** | Commission a return undoes: a returned line's commission in proportion to the quantity back. |
| **Payout** | Money paid to a fitter, recorded as a paid expense of the shop; reversing the expense takes it back. |

### Seeds, fertilisers & pesticides

| Word | Meaning |
|---|---|
| **Krishi kendra** | A shop selling seeds, fertilisers and pesticides to farmers (an agri-input dealer). |
| **Farm input** | What an item is for a krishi kendra: fertiliser, seed, pesticide, bio-input or another item. It decides which licence a bill needs and what the counter asks for. |
| **Fertiliser authorisation letter** | A fertiliser dealer's licence under the Fertiliser (Control) Order 1985: the acknowledgement (Form A2) of the dealer's intimation (Form A1), for one place of business. |
| **Seed dealer licence** | A seed dealer's licence (Form B) under the Seeds (Control) Order 1983, for one place of business. |
| **Insecticide sale licence** | The licence (Form VIII) to sell, stock or distribute insecticides under the Insecticides Rules 1971, for one place of business. |
| **Subsidised fertiliser** | A fertiliser (urea, DAP and the like) sold at the government's subsidised price, through the PoS device as well as on the bill. |
| **PoS device** | The Department of Fertilizers' point-of-sale machine at the shop. Each subsidised sale is made on it after the farmer's thumb (Aadhaar) check, and it prints a receipt; the bill keeps that receipt's number, never the Aadhaar number. |
| **iFMS** | The government's integrated fertiliser management system, which records every PoS sale and the stock the PoS shows for the shop. |
| **Farmer ID** | A farmer's number in the Agri Stack farmer registry, kept with their details. |
| **Kharif, rabi, zaid** | The three cropping seasons: kharif (monsoon), rabi (winter) and zaid (summer). A season credit bill names one, with its year. |
| **Season credit** | A farmer's bill left on udhaar for a season's crop, due at the harvest date given on it. |
| **Village dues** | What the farmers of each village owe, with what is overdue and what is on season credit. |
| **Molecule** | The active ingredient of a pesticide (chlorpyrifos, mancozeb…), as its label names it. |
| **Banned molecule** | A molecule India bans for use: an item made of it is never sold. |
| **Crop-restricted molecule** | A molecule that must not be used on some named crops (chlorpyrifos on ber, citrus and tobacco): sold only for another crop, which the bill names. |
| **Restricted use** | A molecule allowed only to some users or in one formulation (aluminium phosphide by approved pest-control experts; carbofuran only as 3% CG). |
| **Formulation** | How a pesticide is made up for use, as its label says: 20% EC, 75% WP, 3% CG and so on. |
| **Certified seed / truthfully labelled seed** | The two classes of seed a dealer sells: certified by the state's seed certification agency, or labelled by its producer as true to the label. |
| **Seed lot validity** | The date up to which a seed lot may be sold: 9 months from its test date, 6 months more after a passing retest. It is the lot's expiry. |
| **Stock and price board** | The daily display of the opening stock and price of each fertiliser and seed, printed for the shop. |
| **Seed stock return** | The monthly return of each seed's opening stock, purchases, sales and closing stock in quintals, due by the 5th of the next month (Form D). |
| **Insecticide sale register** | The record of every pesticide sold: date, bill, farmer, product, batch, manufacturer, quantity and expiry. |

### Clinic and lab

| Word | Meaning |
|---|---|
| **Token** | A clinic patient's number in the day's queue for one doctor, given on arrival and called in turn, priority first. |
| **OPD session** | A doctor's consulting hours on a weekday (a morning or an evening). Appointments on a doctor's leave are refused; once a doctor has sessions, so are appointments outside them. |
| **Follow-up** | A visit within a set number of days of a paid one, at the doctor's reduced or free follow-up fee. |
| **Report version** | A signed lab report, kept as it was signed. A correction reopens it with a reason and the pathologist's PIN; the new version says it amends the earlier one, which prints as superseded. |
| **QC run** | A measurement of a control material, judged by the Westgard rules. While a parameter's latest run today is rejected, patient reports with that parameter cannot be signed. |
