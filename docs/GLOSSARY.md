# Glossary

For everyone who uses or builds the platform: the words on its screens and in these documents, what each one means and, for developers, where it lives in the database.

## The product and its applications

| Name | Meaning |
|---|---|
| **Business Management Platform** | The product, everywhere a user reads it ("Business Platform" only where space is tight). |
| **Business Admin** | The staff application: one place to run every business you belong to, with a switcher at the top. The technical documents call it the **staff app** (`apps/business-web`). |
| **Guests' site** | What a restaurant's guests open without signing in (`apps/customer-web`): the menu behind a table's QR code, online ordering and table booking. |
| **POS and kitchen display** | Restaurant screens inside Business Admin: the POS (`/pos`), where captains also take orders, and the kitchen display (`/kitchen`). |
| **Captain app** | The waiters' phone screen inside Business Admin (`/captain`): their own tables at a glance, orders taken at the table on the POS's own screen, guests' calls and the food at the pass, live. It is part of the staff app, with a layout of its own; nothing is installed. |
| **Clinic workspace** | The front desk's and the doctors' screen inside Business Admin (`/clinic`): the patient at the desk, tokens and each doctor's queue with waiting times, and the doctor's consultation beside their queue with the patient's history, live. Part of the staff app, with a layout of its own. |
| **Lab workspace** | The lab's screen inside Business Admin (`/lab`): samples to collect and receive, worklists by test, reports to approve and those released today, live. Part of the staff app, with a layout of its own. |
| **Platform console** | The *Platform* screens inside Business Admin: Platform › Restaurants (`/platform/restaurants`) and Platform › Businesses (`/platform/businesses`). The Super Admin creates restaurants and businesses there with their owners' logins, switches them off and on, and sets a new password for a locked-out owner. It shows no business's bills or customers. A separate platform application, with plans and subscriptions, is planned. |
| **Planned page** | The address of a screen that is not built yet. It opens a page that says what is coming and what to use meanwhile, never "Page not found". The guests' site has them for ordering from a shop (`/shop`), booking a salon or clinic appointment (`/appointments`) and a guest's own account (`/account`); Business Admin has none, and its next planned screen gets one. |

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
| **Role** | A named set of permissions inside one business. Every business starts with Owner, Manager, Cashier / sales, Stock keeper, Accountant and Viewer; a pharmacy adds Pharmacist, a clinic adds Doctor, Lab technician and Pathologist, an optical shop adds Optometrist, a garage adds Mechanic, a gym, studio or coaching centre adds Trainer, a jeweller adds Karigar / goldsmith, a fuel station adds Pump attendant (DSM), and a hotel, lodge or guest house adds Front desk and Housekeeping. An owner can add roles of the business's own, and each business has its own copies. A restaurant has its own built-in roles, such as Restaurant Admin, Captain / Waiter and Kitchen staff. | `business_roles`; restaurant: `roles` |
| **Permission** | One action on one module, written `module.action` (for example `sales.refund`): what a person may do. The actions are view, create, edit, approve, cancel, refund, export and print, and for some modules discount, assign, review, manage, or see and write clinical records. | `business_permissions`, `business_role_permissions`; restaurant: `permissions` |
| **Membership** | A person's access to one business, with their role there. One login can have many memberships. Inside a business the header shows the person's role there. | `business_memberships` |
| **Business code** | A business's short code, fixed when the business is created. Staff who sign in with a staff code type their restaurant's code too, and so does someone whose mobile number signs in to more than one restaurant. A restaurant's code is its business code. | `restaurants.code`, `businesses.code` |
| **A password someone else set** | A new login's first password, or a new one an admin or the platform sets for a person. It works for one sign-in: the person then chooses their own (*Choose your own password*) before anything else opens. A password the person changes themselves in *My profile* is their own. | `users.password_must_change`, kept by the trigger `users_password_must_change` |
| **Document** | A posted money record of the shared core: a sale or a purchase, with its returns, payments and refunds. The restaurant's equivalents are its bills, purchase orders and goods receipts. | `business_documents` (+ lines, payments, returns, refunds); restaurant: `bills`, `purchase_orders`, `goods_receipts` |
| **SKU** | One item of the shared core that is sold or kept in stock. Each variant, such as one size in one colour, is its own SKU. | `catalog_skus` under `catalog_products` |
| **Lot** | The stock of one SKU at one location, optionally of one batch (with its expiry) or one serial number. Every change to it is a movement. | `business_stock_lots`, `business_stock_movements` |
| **GST rate change** | Items, or a restaurant's dishes, moved to another GST rate from a later date, usually the 1 April a GST Council notification names. It is entered ahead under *Products & services › GST rate changes* (a restaurant: *Menu › GST rate changes*) and can be cancelled until its date. On its date, on the business's own clock, the items take the new rate by themselves, and the change is kept for good with who entered it and why. A bill uses the rate in force on its own date; a bill made before keeps its rate. | `business_tax_changes`, `business_tax_change_items` |
| **Keep the price before GST** | A GST rate change's choice for prices that include GST. Left alone, such a price keeps what the customer pays and the GST inside it is worked out again; ticked, the price keeps its part before GST and moves with the rate (₹118 at 18% becomes ₹105 at 5%). A price before GST always keeps itself. | `business_tax_changes.keeps` (`total`, `net`) |
| **GST history** | An item's or a dish's GST rate changes, past and to come, with who entered each and why, and each time its rate was changed on the item itself. Opened from the item's row on the catalogue, or from a dish's more actions on *Menu › Products*. | `business_tax_change_items`, the activity log |
| **Live updates** | A screen that shows what other devices change (the kitchen display, table requests, the POS, deliveries, the dashboard, a clinic token queue, the bell …) changes by itself within about a second of a change made on any device, instead of asking the server every few seconds. Most still read on their own once a minute, as a safety net. What reaches the screen says only that something changed; the screen then reads it as the person is allowed to see it. | `modules/live`; triggers on the tables those screens read |
| **Live / Reconnecting** | The small word on a live screen: *Live* while it hears of changes at once; *Connecting* or *Reconnecting* while its connection is made or comes back, the screen catching up as soon as it does; *Not live* where it cannot hear of them. | `components/LiveIndicator.jsx`, or the screen's own Live control |
| **Personal data** | What a business keeps about the people it serves (a shop's customers, a restaurant's guests), under the DPDP Act 2023 and the DPDP Rules 2025: a name, a number, and what each trade keeps besides. *Settings › Personal data* holds the privacy notice, the requests and the breach register. | `modules/personal-data` |
| **Data fiduciary, data processor** | The business decides why and how its customers' data is used, so it is the data fiduciary. The platform holds the data for it, as its processor, under the terms between the two ([GO_LIVE.md › Personal data](GO_LIVE.md#personal-data)). | — |
| **Privacy notice** | The business's notice to the people it serves, in plain words and item by item: what it collects and why, how to see, correct or erase it, how to complain, and whom to contact, with a short consent notice for each purpose. Published in versions, each kept as it was published. | `business_privacy_notices` |
| **Privacy contact** | The person, with a phone or an e-mail, whom customers reach about their personal data. Named in the notice; bills and receipts print a line with them (*Your personal data: …*). | `business_privacy_notices.contact_name`, `contact_phone`, `contact_email` |
| **Consent** | A person's yes to one purpose, given on the privacy notice in force: bills on WhatsApp or SMS, reminders (on WhatsApp, by SMS or a call), or offers. Recorded with when, where and how it was given, and withdrawn once; a new yes is a new record. Each business has its own: a yes at one shop is not a yes at the owner's other shop. A sale never needs one. | `business_consents` |
| **Child's mark** | A person marked as a child, with the parent or guardian who gives consent for them and how. A child is never sent offers. | `business_children` |
| **Request (personal data)** | A person asking to see, correct or erase their data, or a grievance about how it is used: logged the day it comes, on the business's own date, and answered within 90 days. | `business_privacy_requests` |
| **Erasure** | A person's data removed at their request, from the request: their record stays nameless (*Erased customer #id*, *Erased guest #id*) and their name and number go from the other records, while bills and other tax records keep what tax law needs. The answer lists what was erased and what is kept, and why. | `business_contacts.erased_at`, `customers.erased_at`, `business_privacy_requests.erasure` |
| **Breach register** | The record of each personal data breach: when it was found, what happened, its impact, the steps taken, the people affected and each notice sent to them, and when the Data Protection Board was told and sent the detailed report, due 72 hours after the breach was found. The platform files nothing itself. | `business_privacy_breaches` (+ `_people`, `_notices`) |

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
| **Captain** | A waiter who takes table orders, on the captain app or the POS. The day's captain sections give each captain a floor, a section or single tables: their *My tables*. |
| **The pass** | Where the kitchen puts plated food for the waiters to carry out. A ticket marked *ready* on the kitchen display is *at the pass* until someone marks it *served*; food waiting there longer than the kitchen's pass time (8 minutes unless the restaurant sets its own) is going cold. |
| **Course (held, fired)** | A later part of a table's meal. On the captain app a dine-in order's dishes can be held as course 2 or 3: saved on the order but not sent to the kitchen until someone presses *Fire course 2* (or 3), when they go as a round of their own. |
| **Bill** | What the guest is charged. Raised from an order, it closes the order to changes. |
| **Payment type** | A name the owner gives a way of paying, such as a meal card, PhonePe or a cheque, under one of the till's methods (Cash, Card, UPI or Other). The till offers it under its method, and the reports total it apart. Other businesses call theirs *payment methods*. |
| **Void** | The bill should never have existed. Possible only while no money is held on it and it is not settled. |
| **Cash limit** | Cash of ₹2,00,000 or more is never taken for one bill, or from one guest on one day of the restaurant's calendar (Income-tax Act 2025, section 186). The bill window says how much more cash the bill, and its guest today, can take. |
| **Buyer's PAN** | The PAN a bill over ₹2,00,000 records before it takes a payment, or the buyer's declaration that they have none (Form 97). It prints on the bill. |
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

### Optical shops

| Word | Meaning |
|---|---|
| **Prescription (Rx)** | The powers from an eye test, per eye (R right, L left) and vision (distance, near, intermediate), with who examined, the PD and the day it is valid until. |
| **SPH** | The sphere: the eye's main power in dioptres, minus for short sight, plus for long sight, in steps of 0.25. |
| **Plano** | A power of 0.00. |
| **CYL and AXIS** | The cylinder (the extra power for astigmatism) and the direction it lies in, in degrees from 1 to 180 (a horizontal axis is 180). A CYL other than 0 always has its AXIS. |
| **ADD** | The addition: the extra power for reading (and for intermediate vision), added to the distance power, from +0.25 to +4.00. |
| **Prism and base** | A power that shifts the image, in prism dioptres, and the way its base points: in, out, up or down. |
| **Transpose** | Rewriting a cylinder in the other form (plus or minus cylinder): the same prescription, written another way. |
| **Visual acuity** | How clearly the eye sees, as written on the test (6/6, 6/9, N6). |
| **PD** | The pupillary distance in mm: between the pupils (both eyes), or from each pupil to the middle of the nose (each eye, monocular PD). |
| **Fitting height** | How high the centre of the pupil sits above the bottom of the lens in the chosen frame, in mm; a bifocal or progressive lens is placed by it. |
| **Single vision, bifocal, progressive** | A lens with one power; with a reading segment below; with powers that change smoothly from distance at the top to reading at the bottom. |
| **Lens index** | How strongly the lens material bends light (1.50, 1.56, 1.60, 1.67, 1.74): a higher index makes a thinner lens. |
| **Spectacle order (job card)** | An order to make spectacles from a prescription: the frame, the right and left lens, the fitting, the lab or the workshop, the promised day and the advance (SPO/2627/0001). |
| **Lab order number** | The number the outside lab gives the order it makes the lenses for. |
| **Quality check** | Checking finished spectacles against the prescription (on the lensometer) before they are ready to collect: passed, or sent back with what was wrong. |
| **Remake** | A spectacle order made again for a delivered one, with the reason and who bears the cost: the lab, the shop or the customer. |
| **Recall list** | The customers due for an eye test: their last test was the set months ago or more. |
| **Power grid** | Making a contact lens's powers as its items in one go: one item for each power of the ranges given. |
| **Base curve and diameter** | A contact lens's curve and width in mm; one lens product has one of each. |
| **MD-42** | The registration certificate for selling medical devices such as contact lenses, kept as a licence. |
| **Optometrist** | The professional who tests eyes and writes prescriptions; in an optical shop, the role that records prescriptions and passes the quality check, and takes no money. |

### Vehicle service & auto parts

| Word | Meaning |
|---|---|
| **Registration number** | The number on a vehicle's plate (TS09EA4521), kept in capital letters and digits only; a business has one vehicle per number. |
| **Chassis and engine numbers** | The numbers on a vehicle's frame and engine; a chassis number belongs to one vehicle. |
| **Odometer log** | Every reading of a vehicle's meter, in kilometres: in and out of each job card, or typed on the vehicle. A reading lower than the last needs a manager's approval and the reason. |
| **Kilometres a day** | How far a vehicle runs in a day on average, from its readings; it gives the reading the vehicle has probably reached. |
| **Job card** | A vehicle's visit to the workshop, from its arrival to its delivery: the reading and fuel in, what the customer says, the estimate, the mechanics, the work done and the bills (JC/2627/0001). |
| **Complaint** | What the customer says is wrong, or the service they asked for; one a line on the job card. |
| **Estimate** | The parts, labour and outside work a job card needs, with their prices; each change saved is a new version. |
| **Approval** | The owner's agreement to the estimate: who, how (in person, by phone or on WhatsApp), when and the amount. A version that comes to more goes back to them. |
| **Labour** | Work done in the workshop, billed as a service item (SAC 998714, maintenance and repair services of transport machinery and equipment). |
| **Outside work (sublet)** | Work another workshop does for the job (denting, painting, machining), on the job card with its charge, the workshop's name and its bill number. |
| **Bay** | The place in the workshop where the vehicle is worked on. |
| **Promised time** | When the customer was told the vehicle would be ready; a job card past it shows late. |
| **Workshop copy, customer copy** | The job card printed for the mechanics (the work to do, never the prices) and for the customer (the estimate with its prices, to sign). |
| **Cashless claim** | An insurance claim where the insurer pays the garage the amount it approved: the insurer is billed for that, and the customer for the rest. |
| **Reimbursement claim** | An insurance claim where the owner pays the garage and claims the approved amount back from the insurer. |
| **Surveyor** | The surveyor or loss assessor who assesses the repair for the insurer and approves its cost. |
| **Approved amount** | The repair cost the insurer agreed to pay (the approved claim cost). |
| **Deductible** | The compulsory deductible: the part of a claim the policy leaves to the owner. |
| **Depreciation** | What the insurer takes off the price of the parts it replaces, for their age; the owner pays it. |
| **Owner's share** | The insurer's lines less the approved amount: the deductible, the depreciation and what was not allowed, billed to the owner as one line of the claim-share item. |
| **Claim-share item** | The service item that bills the owner's share of a cashless claim (*Insurance claim: owner's share*), set in *Settings › Garage settings*. |
| **PUC** | A vehicle's Pollution Under Control certificate, kept with the day it runs out. |
| **Service due** | The vehicles whose next service falls within a week, by date or by the reading they will probably reach, and those whose insurance or PUC runs out within 30 days. |
| **Statement** | A customer's vehicles with the job cards on each, and what was billed, paid and is still due. |
| **Mechanic** | Someone who works on vehicles; in a garage, the role that sees the job cards assigned to it, records the work done and the parts used, and sees no money. |

### Gyms, studios & coaching

| Word | Meaning |
|---|---|
| **Member** | A customer who holds a membership; the screens call customers members. Each has a member code. |
| **Member code** | The code on a member's card (M0001, or the number of a card they already hold), typed or scanned from its QR at the desk. |
| **Plan** | What the gym, studio or coaching centre sells: by days or months, a pack of sessions, or sessions within a time, sold as a service item of its own with its GST and SAC. |
| **Membership** | A plan sold to a member, with its terms kept as sold, from its first day to its last (MS/2627/0001). A coaching student's enrolment in a course is one too. |
| **Session pack** | A plan of so many visits or classes (Yoga 10 classes), with or without a time to use them in; a check-in uses one session a day. |
| **Joining fee** | A one-time fee billed with a member's first membership, as a service item of its own. |
| **Terms as sold** | What a membership keeps from the day it is sold: the price as billed, the refund policy's version, its freezes, grace days and whether it can be passed on. |
| **Refund policy** | A plan's words on what comes back when a member cancels; every version is kept, and a membership keeps the one it was sold with. |
| **Freeze** | A pause of a membership for some days (travel, illness), within what its plan allows; its last day moves on by the days frozen. |
| **Grace days** | Days after a membership's last day on which the member is still let in. |
| **Check-in** | A member arriving at the desk: let in on a membership that runs that day, or turned away with the reason; every one is kept. |
| **Renewal** | A new membership for the same member, starting the day after the one renewed ends. |
| **Upgrade** | A membership moved to another plan from today: the part not used comes back as a credit note that pays the new bill first. |
| **Transfer (passing on)** | What is left of a membership given to another member, on the first member's bill, when its plan allows it. |
| **Pro-rata refund** | What comes back when a membership is cancelled: the part of its price not used, by the days or sessions left, to the paisa. |
| **Instalments** | A fee split into parts with their due days, adding up to the bill; payments on the bill cover them in order. |
| **Fees due** | The instalments falling due or overdue, with what is left of each to pay. |
| **Trainer** | Someone who trains members; in a gym, studio or coaching centre, the role that sees members, their plans and check-ins, checks members in and sees no money. |
| **5% without input tax credit** | The GST on the services of a gym, health club, fitness centre or yoga centre from 22 September 2025: 5%, with no credit for what was bought for them, and no choice of 18% with credit. |

### Laundry & dry cleaning

| Word | Meaning |
|---|---|
| **Garment order** | Garments taken in from a customer at the counter, each with its tag and service, from intake to the handover (LO/2627/0001). Not a GST document: its bill is. |
| **Tag** | The number on a garment (or on several of a kind under one tag, or on a bundle by the kilo) from intake until it leaves; printed as a label for every piece, with its barcode. No two garments in the shop hold the same tag. |
| **Price list** | Each garment's price for each service: for each piece, pair or set, or by the kilo. |
| **Per piece, per pair, per set** | How a garment is counted and priced: a shirt is a piece, socks a pair, a two-piece suit a set of two pieces. |
| **By the kilo** | A bundle (wash and fold, say) weighed at the counter and priced by its weight, with its pieces counted too. |
| **Express** | An order done sooner, at a surcharge: the shop's percentage added to every garment's price. |
| **Promised day** | The day the customer is told the garments will be ready; an order is late once it has passed with garments not ready. |
| **Defects noted at intake** | What was seen on a garment when it came in (a stain, a tear, a missing button, colour bleed…), kept on the order and printed on the receipt. |
| **Owner's risk** | What the customer was told about the risk to a delicate garment (old silk, loose colour) and acknowledged at intake: a record of what was said, never a limit on a claim. |
| **Declared value** | What the customer says a garment is worth, noted at intake. |
| **In process** | A garment in the work: washing, cleaning or pressing. |
| **Rack** | Where a finished garment hangs to be collected, with its slot (B-7). |
| **Ready to collect** | Every garment of an order still in the shop is ready; *partly ready* when some are. |
| **Handover** | Garments given to the customer (or someone they send), with their bill when billed at delivery; *partly delivered* when some are still in the shop. |
| **Billed at intake / at delivery** | When a laundry's orders are billed: when taken in, or when the garments are handed over (an advance may be taken first). |
| **Lien (held until paid)** | A laundry's right to keep garments it has worked on until it is paid (Indian Contract Act, section 170), unless agreed otherwise, as with a customer given credit. |
| **Unclaimed** | An order ready and not collected for the shop's days (30 to start with); the reminders sent are kept, and nothing is disposed of. |
| **Damage claim** | A customer's complaint that a garment came back damaged, stained, shrunk, with its colour run, lost or missing a part; a manager decides it: money back, a credit note, reprocessing or rejected. |
| **Reprocess** | The work done again at no charge, the garment taken back in under a damage claim. |
| **SAC 99971** | The GST group of laundry, dry cleaning, pressing and dyeing (dry cleaning 999712): 18% with input tax credit. |

### Jewellery & gold

| Word | Meaning |
|---|---|
| **Purity** | How much pure metal a piece holds: gold in carats with its fineness (24K 999, 22K 916, 18K 750, 14K 585), silver and platinum by their fineness (999, 925; 950). |
| **Fineness** | The parts of pure metal in a thousand: 916 is 91.6% gold. |
| **22K916** | A purity as a hallmark writes it: 22 carat, 916 fineness. |
| **Rate sheet** | The day's rates a manager sets: for each purity, the selling rate per gram and the rate paid for old metal, morning or evening. Never changed: a correction is a new sheet. |
| **Today's rate** | For a purity, the rate of the latest sheet of the day that rates it; a bill takes it. |
| **Old metal rate** | What the shop pays per gram for old gold or silver of a purity. |
| **IBJA rate** | The India Bullion and Jewellers Association's benchmark rates for gold, silver and platinum, published twice a day, before GST and making charges. |
| **Rate board** | The day's rates in large type on a screen in the showroom. |
| **Karigar** | A goldsmith: makes, repairs and finishes pieces; the Karigar role sees pieces and weights, never prices. |
| **Jewellery item** | A catalogue item sold as tagged pieces priced by weight (a gold necklace, silver anklets): goods counted in pieces, serial-numbered, at 3% GST. |
| **Piece** | One tagged article of a jewellery item: a serial-numbered unit in stock with its own weights, stones, charges and hallmark. |
| **Tag** | A piece's number (T00012), printed on its tag label with a barcode; the serial number of its unit in stock. |
| **Gross, stone and net weight** | The whole piece; its stones, beads and thread; and its metal, gross less stones. In grams to the milligram. |
| **Fine weight** | The pure metal in a weight: net weight × fineness ÷ 1,000. |
| **Wastage (VA)** | Value addition: a percentage of a piece's net weight added at the day's rate. |
| **Making charge** | The charge for making a piece: per gram of net weight, a percentage of the metal's value, or flat. |
| **Hallmark** | BIS's marks on an article of gold or silver: the BIS standard mark, the purity in carat and fineness, and a HUID. |
| **HUID** | Hallmark Unique ID: the 6 letters and digits of an article's hallmark; one article each, several on a set. |
| **Laboratory-grown diamond** | A man-made diamond, also laboratory-created; never "lab grown" or "LGD". A "diamond" alone is natural. |
| **On approval (jangad)** | A piece a customer takes to show at home before buying; still the shop's stock. |
| **Melted** | A piece taken out of stock for good, its metal kept as the shop's own for melting and refining. |
| **Jewellery bill** | The counter's bill of tagged pieces, each priced at the day's rate for its purity with its wastage, making, stones and hallmarking, then 3% GST; an ordinary sale. |
| **Mandatory hallmarking district** | A district notified under the Hallmarking Order, where gold jewellery of 2 g or more is sold only with its BIS hallmark and HUID. |
| **HUID check** | The jewellery bill's refusal of a gold piece of 2 g or more without its HUID, unless the article, the turnover or the district leaves it out. |
| **BIS-recognised assaying and hallmarking centre** | A centre where a buyer may have the purity of hallmarked jewellery checked; every jewellery invoice says so. |
| **Old gold** | Gold, silver or platinum a customer sells to the shop or gives in exchange for new jewellery. |
| **Old gold voucher** | The record of old gold taken in (OG/2627/0001): the seller, the photo ID seen, each article as tested and valued, and the seller's declaration; its value is paid out, used on their bill, or both. |
| **Exchange** (old gold) | Old gold set off against a new jewellery bill: it pays first, as a payment by old gold, and the customer pays the rest. |
| **Karatmeter (XRF)** | A machine that reads a piece's purity without harming it, by X-ray fluorescence. |
| **Touchstone** | The traditional test: the piece is rubbed on a dark stone and its streak is compared with streaks of known purity. |
| **Fineness found** | The purity a test shows, in parts of pure metal in a thousand (912.5); old gold is valued by it. |
| **Deduction** (old gold) | The percentage taken off old gold's value for melting loss or by the shop's own rule. |
| **Payment by old gold** | The part of a bill old gold pays: a credit note on the sale with the voucher's number; no money moves. |
| **Put back** (old gold) | What old gold paid on a bill that was returned, going back on its voucher to be paid out or used again. |
| **Form 97** | The declaration a person without a PAN signs where a PAN is asked for (it replaced Form 60). |
| **Gold scheme** (gold savings scheme) | A customer's plan of fixed monthly instalments (at most 11), turned into jewellery on one jewellery bill within the year; never paid back in money. |
| **Scheme plan** | A scheme the shop offers: so many instalments, the smallest monthly amount, the discount and the terms. Its terms never change. |
| **Maturity** (scheme) | The day a scheme gives its discount from: the plan's instalments in months after the first one. |
| **Close day** (scheme) | A scheme's day 364 after the first instalment, by which it is billed. |
| **Scheme discount** | The plan's percentage of one instalment, taken off the pieces before GST on the bill that redeems a scheme with every instalment paid, from its maturity; never called interest. |
| **Redeem** (scheme) | Use all that was paid into a scheme on a jewellery bill of its customer. |
| **Stopped** (scheme) | A scheme cancelled with a manager's approval: no more instalments and no discount; what was paid is still used on a jewellery bill. |
| **Passbook** | A scheme's printed record: the member, the terms, the nominee, and each instalment due and paid. |
| **Nominee** | The person a scheme's member names to receive its jewellery if they cannot. |
| **Credit from a returned bill** | What is left of a returned jewellery bill after any money went back: it pays the customer's next jewellery bill. |
| **PMLA** | The Prevention of Money-laundering Act: a jeweller with cash transactions of ₹10 lakh or more with a customer is a reporting entity under it. |
| **Reporting entity** | A dealer who reports to FIU-IND under the PMLA: the monthly cash transactions report, and suspicious transactions. |
| **FIU-IND** | The Financial Intelligence Unit – India, to whom a reporting entity reports. |
| **Cash transactions worksheet** | The cash report's list, for a month, of each customer whose cash was above ₹10 lakh, with every cash transaction: what the monthly report is made from. |
| **Linked transactions** | Several cash transactions with one customer that appear connected; together they count towards ₹10 lakh. |

### Rentals & hire

| Word | Meaning |
|---|---|
| **Hirer** | The customer who hires something; a rental business's customers are its hirers. |
| **Rental item** | Something hired out (a generator, a chair, a car), billed as a service item of its own with its rates, deposit and late fee. |
| **Unit** | One of an item hired one by one, with its own name and registration or serial number (*Gen A*, *TS09AB1234*). |
| **Pool** | An item hired by how many, from the number the shop has (200 chairs). |
| **Booking** | Items hired for a time, from the out time to the due back time (RN/2627/0001). Not a GST document: its bill is. |
| **Quote** | A booking priced and not reserved: it holds nothing until it is reserved. |
| **Reserved** | A booking that holds what it books from its out time to its due back time and the turnaround time. |
| **Out / handover** | Items handed to the hirer, with their condition, meter and fuel noted and the hirer's ID; the booking is then out. |
| **Due back** | The time a booking is to come back, on the shop's clock; *overdue* once it has passed with something still out. |
| **Return (take back)** | Items coming back, all at once or in parts; the bill is made when the last of them is back. |
| **Turnaround time** | The time kept free after each hire of an item, for cleaning and checks, before it can go out again. |
| **Best price** | The cheapest mix of an item's month, week, day and hour rates that covers the hours booked. |
| **Minimum hire** | The fewest hours a booking of an item is charged for. |
| **Grace time** | The minutes after the due back time with no late fee. |
| **Late fee** | What a booking late past its grace time pays: each hour or day late, or part of one, at the booked rate, for each one still out. |
| **Refundable deposit (security deposit)** | Money held for a booking, with no GST, apart from sales: it pays only what the shop keeps (billed as a charge) when the booking is back, and the rest goes back. |
| **Applied** | Of a deposit or an advance: the part that paid the booking's bill. |
| **Damage charge** | A charge for damage, missing pieces, cleaning or fuel, billed with GST at the slab of the item it is for. |
| **Cancellation charge** | What the shop keeps when a booking is cancelled, billed as a charge with its GST. |
| **Self-drive** | A car or motorcycle hired without the shop's driver: it goes out on the hirer's driving licence, and needs the location's rent-a-cab or rent-a-motorcycle licence. |
| **Rent-a-cab / rent-a-motorcycle licence** | The State Transport Authority's licence to hire out self-drive cars or motorcycles. |
| **Like goods' rate** | The GST on renting goods without an operator: the rate of a sale of the goods hired out (40% for goods that attract 40%). |
| **SAC 9973** | The GST heading of leasing or rental services without an operator (997329 for other goods); a passenger vehicle with a driver is in 9966. |

### Fuel stations

| Word | Meaning |
|---|---|
| **Retail outlet (RO), petrol pump** | A fuel station; each of its outlets is a location of the business. |
| **Dealer** | Whoever runs the outlet for an oil company; the platform is the dealer's back office, never the forecourt's automation. |
| **MS, HSD** | Motor spirit (petrol) and high-speed diesel; with CNG (sold by the kg), the fuels on the meters. |
| **State VAT** | The state's value added tax (or sales tax) on petrol and diesel, which are outside GST; the fuel's price includes it, and each fuel bill line says so. |
| **Dispensing unit (DU, MPD)** | A pump with its nozzles, stamped by the Legal Metrology department. |
| **Nozzle** | Where a fuel is dispensed, with its own number at the outlet and its totaliser; it draws from one tank. |
| **Totaliser** | A nozzle's meter of everything it has ever dispensed; a shift's sale is its closing reading less its opening. |
| **Stamping (W&M)** | The Weights & Measures (Legal Metrology) verification of a dispensing unit or a measure, with the date the next one falls due. |
| **5-litre test** | Fuel drawn from each nozzle into the stamped 5-litre measure to check it, and poured back into the tank: not a sale. |
| **Meter change** | A totaliser replaced or reset, recorded by a manager with its new reading and the reason. |
| **DSM, pump attendant** | The person who runs nozzles on a shift and hands in the money; the *Pump attendant (DSM)* role. |
| **Shift** | One attendant's turn on their nozzles, from the opening readings to the closing ones (FS/2627/0001); not a GST document: the fuel bills its close posts are. |
| **Settlement** | What an attendant hands in at a shift's close (cash, UPI, cards, fleet cards and credit slips) against what the meters sold. |
| **Short, excess** | An attendant's money less (short) or more (excess) than the walk-in sales; a short is left due on the walk-in fuel bill. |
| **Walk-in fuel bill** | The bill of a shift's sales to buyers not named, a line for each fuel. |
| **Credit slip (indent)** | The slip a fleet customer's driver signs for a fill on credit, with its number, the vehicle and the quantity. |
| **Fleet customer** | A transporter, school or contractor whose vehicles fill on credit, billed on a fuel bill of each shift. |
| **Fill limit** | The most a vehicle takes in one fill on credit; a fill over it needs a manager. |
| **Fleet card, loyalty card** | An oil company's card a fleet pays with (IndianOil's XTRAPOWER, say): a payment method taken with the shift's takings and settled by the oil company, not the station's credit. |
| **Dip, dip chart** | The fuel's depth in a tank read on the dip rod each morning, turned into litres by the tank's dip chart. |
| **Water dip** | Water found at the bottom of a tank with water-finding paste. |
| **Tank lorry (TL), tanker** | The lorry that brings a load from the oil company's depot or terminal, with its invoice and seals. |
| **Decanting** | Emptying a tank lorry's load into the outlet's tanks. |
| **Density at 15 °C** | A fuel's density corrected to 15 °C (from the hydrometer, the thermometer and the table); a load's must be within ±3.0 kg/m³ of its invoice's. |
| **Short receipt** | A load that came in, by the dips before and after decanting, at less than its invoice's litres. |
| **MDG** | The public-sector oil companies' Marketing Discipline Guidelines (2024): the dealer's registers, checks and tolerances. |
| **Stock register** | Each tank's day: the opening dip, the loads, the meters' sales, the book stock and the next morning's dip. |
| **Book stock** | What a tank should hold: the opening dip plus the loads received less the meters' sales. |
| **Variation** | The next dip less the book stock, in litres and as a share of the dip. |
| **Tolerance** | The variation allowed: 4% of the dip either way, and on a loss also the evaporation and handling allowance (petrol 0.75%, diesel 0.25% of what was sold; 0.60% and 0.20% beyond 600 KL a year). |
| **Density register** | Each tank's month of densities: the morning's, and each load's by invoice, at receipt and after decanting. |
| **PESO licence (Form XIV)** | The Petroleum and Explosives Safety Organisation's licence to store petroleum at a retail outlet, kept with the business's licences. |

### Hotels, lodges & guest houses

| Word | Meaning |
|---|---|
| **Property** | A hotel, lodge or guest house; each of its properties is a location of the business. |
| **Room type** | A kind of room (Deluxe, Suite, Standard non-AC) with its occupancy, extra beds and rates; its nights are billed as a service item counted in nights. |
| **Room night** | One room for one night: what a stay is charged by, and what its GST slab is decided on. A night belongs to the date it starts on. |
| **Rack rate** | A room type's published rate a night, before GST. |
| **Weekend rate** | A room type's rate on the weekend nights (Friday and Saturday unless changed). |
| **Agreed rate** | One rate a night agreed for a stay (an OTA's price, a company's rate), in place of the rack and weekend rates. |
| **Base occupancy, extra adult** | The adults a room type's rate is for; each adult beyond them pays the extra-adult rate. |
| **Extra bed** | A bed added to a room for a stay, at the room type's extra-bed rate a night. |
| **Reservation** | A stay booked ahead, with its nights, room type and (now or at check-in) its room. |
| **Stay** | A reservation and what it becomes: reserved, in the house, checked out, or cancelled or a no-show (ST/2627/0001). Not a GST document: its bill is. |
| **Walk-in** | A guest who comes to the desk without a booking; with the phone and OTAs, where a booking came from. |
| **OTA** | An online travel agent or site (MakeMyTrip, Booking.com…); its bookings are typed in with its booking id. |
| **Channel manager** | Software that keeps a property's rooms and rates in step on the OTAs and pulls their bookings; the platform has none. |
| **Arrival, departure** | The date of a stay's first night, and the morning the guest leaves (the night before it is the last). |
| **In the house** | A stay checked in and not yet checked out; its guest is *in house*. |
| **Occupant** | Each person staying in a room, adult or child, recorded at check-in with their photo ID. |
| **Registration card** | The card a guest signs at check-in: the stay, the rate, every occupant with their ID, and the property's terms. |
| **Guest register** | Every occupant of the rooms between two dates with their ID details, printed for the local police. |
| **Form-III** | The report of a foreign guest (OCI cardholders too) on the FRRO portal within 24 hours of arrival and again of departure, under the Immigration and Foreigners Act 2025; it replaced Form C. |
| **FRRO portal, acknowledgement** | The portal where Form-III is filed (indianfrro.gov.in, or its app), and the number it gives a report, marked on the guest here. |
| **OCI cardholder** | An Overseas Citizen of India: reported on Form-III like any foreign guest, with the OCI card in place of a visa. |
| **Folio** | A stay's account while the guest is in the house: its room nights and extras, billed at check-out. |
| **Extra (folio charge)** | A service charged to a stay (laundry, food, a pickup) at its item's GST slab. |
| **Night audit** | The day's closing step at the desk: every night of the guests in the house up to tonight posted to their folios, each at its rate and slab. |
| **Advance** | Money taken on account for a stay, held for its bill. |
| **Deposit (security deposit)** | Refundable money held for a stay: it pays the bill only if needed, and the rest goes back. |
| **Bill to (company billing)** | A stay billed to a company instead of its guest, with the company's GSTIN on the invoice. |
| **No-show** | A reservation whose guest did not come on the arrival day, marked so with an optional charge. |
| **Vacant clean, vacant dirty** | A room ready for a guest, and one left by a guest and not yet made up. |
| **Occupied** | A room a guest is checked in to. |
| **Out of order** | A room not given to guests (under repair, say), with the reason. |
| **Make up (a room)** | Clean and prepare a room for the next guest; housekeeping then marks it clean. |
| **Room move** | A guest in the house moved to another room, which must be vacant and clean; the room left is marked dirty. |
| **Overstay** | A guest still in the house after the departure day: the stay is extended before the check-out. |

### Clinic and lab

| Word | Meaning |
|---|---|
| **Token** | A clinic patient's number in the day's queue for one doctor, given on arrival and called in turn, priority first. |
| **OPD session** | A doctor's consulting hours on a weekday (a morning or an evening). Appointments on a doctor's leave are refused; once a doctor has sessions, so are appointments outside them. |
| **Follow-up** | A visit within a set number of days of a paid one, at the doctor's reduced or free follow-up fee. |
| **Referral** | A doctor sending a patient on to a specialist or a hospital, written on the consultation (to whom and why) and printed as a referral letter. Not the outside-lab referral, which sends a lab test to another lab. |
| **Worklist** | The tests whose samples are in the lab and whose results are still to be typed, one test or all. |
| **Report version** | A signed lab report, kept as it was signed. A correction reopens it with a reason and the pathologist's PIN; the new version says it amends the earlier one, which prints as superseded. |
| **QC run** | A measurement of a control material, judged by the Westgard rules. While a parameter's latest run today is rejected, patient reports with that parameter cannot be signed. |
