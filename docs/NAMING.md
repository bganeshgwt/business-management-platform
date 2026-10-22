# Naming

The words people read on screen and in these documents, and what each one means.

## The product and its applications

| Name | Meaning |
|---|---|
| **Business Management Platform** | The product, everywhere a user reads it ("Business Platform" only where space is tight). |
| **Business Admin** | This admin application: one place to run every business you belong to, with a switcher at the top. The technical documents call it the **staff app** (`apps/business-web`). |
| **Guests' site** | What a restaurant's guests open without signing in (`apps/customer-web`): the menu behind a table's QR code, online ordering and table booking. Shop, appointment and account pages come later; their addresses already say so. |
| POS, Captain, Kitchen display | Screens of Business Admin for restaurants today: the POS (`/pos`, where captains take orders too) and the kitchen display (`/kitchen`); `/captain` says what is coming. As applications of their own, they come later. |
| Platform admin | The platform owner's own application (businesses, plans, subscriptions) — later. Today the platform super admin uses the platform console in Business Admin (`/platform/restaurants`, `/platform/businesses`). |

Inside Business Admin a restaurant is simply the restaurant business's own
admin (its menu, tables, kitchen, POS and reports), not a separate product. A
café, a bakery and a cloud kitchen are restaurants too, each in its own
*format*.

## Glossary

| Word | Meaning | Where it lives |
|---|---|---|
| **Platform** | Everything shared by all businesses: the module catalogue, permission catalogue, role templates, and later plans and subscriptions. | `platform_*`, `business_permissions`, `business_role_templates` |
| **Business** | One independent business (a tenant). Its data is separate from every other business's. | `businesses` |
| **Business type** | What kind of business it is — restaurant, grocery/kirana, supermarket, wholesale/FMCG, fashion, electronics, pharmacy, books & stationery, salon & spa, clinics & labs, meat & seafood, other weight-based shops. Fixed once the business exists. | `business_types` |
| **Format** | What kind of food business a restaurant is: restaurant, café, bakery or cloud kitchen. All four run on the same restaurant screens; the format sets how the POS opens and which features it starts with, and the owner can change each afterwards. | `restaurants.format` |
| **Location / outlet** | A shop, counter or warehouse of a business, with its own stock and document numbers. Restaurants call theirs *outlets* (restaurant `outlets` table); other businesses call them *locations*. A person can be tied to one location and then works there only. | `business_locations`, `outlets`, `business_memberships.location_id` |
| **Module** | A part of the product a business can use: Sales, Stock, Stock transfers, Appointments… *Core* modules (settings, staff & access, reports, activity log) are always on; an owner switches the others on in Settings › Business tools. A restaurant calls its modules *features* (Settings › Features). | `platform_modules` |
| **Capability** | A module switched on for one business — what the business may use. Later decided by its plan. | `business_capabilities` |
| **Role** | A named set of permissions inside one business (Owner, Manager, Cashier / sales, Stock keeper, Accountant, Viewer; a pharmacy also Pharmacist, a clinic Doctor, Lab technician and Pathologist; or the business's own). | `business_roles` |
| **Permission** | One action on one module — view, create, edit, approve, cancel, refund, export or print, and for some modules discount, assign, review, manage, or see and write clinical records — written `module.action`, e.g. `sales.refund`. What a person may do. | `business_permissions`, `business_role_permissions` |
| **Membership** | A person's access to one business, with their role there. One login can have many memberships. Inside a business the header shows the person's role **there**. | `business_memberships` |
| **Business code** | The code typed at sign-in with a staff code (or when one mobile number signs in to more than one business). A restaurant's code is its business code. | `restaurants.code`, `businesses.code` |

A request is allowed only when **both** hold: the business has the module's
capability, and the person's role in that business has the permission.

## What was not renamed

Code identifiers, database tables, the database itself
(`restaurant_management_db`) and API paths keep their names; only the
repository folder became `business-management-platform`. In particular,
**`restaurant_*` tables are the restaurant module's own tables** (and
`restaurants`, `outlets`, `orders`, `bills`, `menu_*` …): they belong to the
restaurant business type and are not platform-wide. Platform-wide tables start
with `platform_` or `business_` (except the restaurant's own `business_days`
and `business_hours`), and shared catalogue tables with `catalog_`.
Type-specific tables start with the type or its trade, e.g. `salon_*`,
`pharmacy_*`, and a clinic's `health_*` and `lab_*` (see
[BUSINESS_PLATFORM_DATA_MODEL.md](BUSINESS_PLATFORM_DATA_MODEL.md)).

## Trade words (Phase 2: wholesale and customer credit)

| Word | Meaning |
|---|---|
| **Sales order** | What a trade customer asked for, at prices fixed when it was taken. Moves no stock. |
| **Dispatch** | Sending some or all of an order. Each dispatch is a tax invoice (a sale) and is when stock leaves. |
| **Back-order** | What was ordered and not sent yet, until it is sent or the order is closed short. |
| **Route / beat** | A route is a delivery run; a beat is the shops on a route that one salesperson visits on a set day. |
| **Collection** | A numbered receipt of money from a customer, put against their bills. |
| **Advance** | Collected money not yet put against a bill; it already lowers what the customer owes. |
| **Outstanding / Udhaar** | What customers owe. Wholesale calls it outstanding, a kirana calls it udhaar — the same records. |
| **Ageing** | Outstanding money split by how old the bill is: 0–30, 31–60, 61–90 and over 90 days by default (an owner can set the three edges in Business settings). |

## Trade words (Phase 2: salon & spa, weight-based shops)

| Word | Meaning |
|---|---|
| **Stylist / room** | A salon resource that can be booked. A stylist has skills (the services they do); a room is booked alongside a stylist for services that need one. |
| **Clean-up time** | Minutes after a service when the stylist is still busy; a booking blocks the service time plus this. |
| **Deposit** | Money taken when booking. It is the client's advance and comes off their next bill. |
| **Late cancellation / no-show charge** | Part of the price kept, only out of the deposit, when a booking is cancelled too late or the client does not come. |
| **Package** | Sessions of services bought together, valid for a number of days, used up on later bills. |
| **Membership** | A discount on services and products for a number of days, applied by itself. |
| **Commission** | A stylist's share of the bill lines they did, from the most specific rule, fixed when the bill is saved. A stylist on a monthly target plan earns by slabs of the month's net service sales instead. |
| **Cutting batch** | Cutting or cleaning one weighed input into the cuts that are sold (numbered CP/…). |
| **Yield** | The weight of the cuts as a % of the input; **process loss** is the rest. A **yield template** says what an input normally gives. |
| **Wastage** | Weight written off (trimming, spoiled, unsold, drip loss, damaged), taken out of stock at its cost. |

## Trade words (food formats)

| Word | Meaning |
|---|---|
| **Pre-order** | An order for a later day (a cake, a party tray) with the message, an advance and the time it is due. It is made ready and, on collection, billed as a takeaway order against the advance. |
| **Bake list** | Everything the open pre-orders due on a day need, added up, for the kitchen. |
| **Sold by weight** | A dish or bake priced per kg; the quantity on the order is the weight (0.25 = 250 g). |
| **Day-end unsold** | What is left on the shelf at closing. What will not sell tomorrow is written off at cost as "Unsold at day end"; what keeps stays in stock. |
| **Brand** | One of the names a kitchen sells under (a cloud kitchen's "Biryani Box" and "Wrap Republic"). A category belongs to one brand or to all; an order is taken under a brand, which its KOT and bill print and the brand report counts. |

## Trade words (rounds 2 and 3: shops, clinics and labs)

| Word | Meaning |
|---|---|
| **Payment method** | A way a shop takes money, under the name it chose (PhonePe, Sodexo…), each of one of five fixed kinds: cash, UPI, card, bank, cheque. The accounts count the kind; the day's money shows the name. |
| **Branch price** | A location's own selling price for an item; a branch without one sells at the item's price. |
| **Department** | A part of a store (Clothing, Home, Grocery…). Top-level categories belong to one. A person tied to a department sees and changes only its products and stock, and still bills any item. |
| **Daily money** | What the counter sold and the money that came in and went out on a day, by payment method, person and counter. |
| **Cash check** | The drawer counted against what it should hold. A difference needs a reason; the check is kept as it was saved. |
| **Cashier shift** | One cashier's float and closing count at one counter, checked against their own cash in and out. A closed shift is a permanent record. |
| **Kit** | Items sold together at one price ("mobile + cover + screen guard"). On the bill the price is split over the parts, and each part's stock goes down. |
| **EMI case** | An EMI sale's financed part: the customer pays a down payment and the financier (Bajaj Finserv, HDFC Bank…) owes the rest until its payout, less its subvention, is recorded. |
| **Token** | A clinic patient's number in the day's queue for one doctor, given on arrival and called in turn, priority first. |
| **OPD session** | A doctor's consulting hours on a weekday (a morning or an evening). Appointments on a doctor's leave are refused; once a doctor has sessions, so are appointments outside them. |
| **Follow-up** | A visit within a set number of days of a paid one, at the doctor's reduced or free follow-up fee. |
| **Report version** | A signed lab report, kept as it was signed. A correction reopens it with a reason and the pathologist's PIN; the new version says it amends the earlier one, which prints as superseded. |
| **QC run** | A measurement of a control material, judged by the Westgard rules. While a parameter's latest run today is rejected, patient reports with that parameter cannot be signed. |
