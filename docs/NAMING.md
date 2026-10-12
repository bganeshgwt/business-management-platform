# Naming

The words people read on screen and in these documents, and what each one means.

## The product and its applications

| Name | Meaning |
|---|---|
| **Business Management Platform** | The product, everywhere a user reads it ("Business Platform" only where space is tight). |
| **Business Admin** | This admin application: one place to run every business you belong to, with a switcher at the top. |
| POS, Captain, Kitchen display, Customer website | The other applications (POS, Captain and Kitchen display exist for restaurants today; the rest come later). |
| Platform admin | The platform owner's own application (businesses, plans, subscriptions) — later. Today the platform super admin uses the restaurant console at `/platform/restaurants`. |

Inside Business Admin a restaurant is simply the restaurant business's own
admin (its menu, tables, kitchen, POS and reports), not a separate product.

## Glossary

| Word | Meaning | Where it lives |
|---|---|---|
| **Platform** | Everything shared by all businesses: the module catalogue, permission catalogue, role templates, and later plans and subscriptions. | `platform_*`, `business_permissions`, `business_role_templates` |
| **Business** | One independent business (a tenant). Its data is separate from every other business's. | `businesses` |
| **Business type** | What kind of business it is — restaurant, grocery/kirana, supermarket, wholesale/FMCG, fashion, electronics, pharmacy, books & stationery, salon & spa, clinics & labs, meat & seafood, other weight-based shops. Fixed once the business exists. | `business_types` |
| **Location / outlet** | A shop, counter or warehouse of a business, with its own stock and document numbers. Restaurants call theirs *outlets* (restaurant `outlets` table); other businesses call them *locations*. | `business_locations`, `outlets` |
| **Module** | A part of the product a business can use: Sales, Stock, Stock transfers, Appointments… *Core* modules (settings, staff & access, reports, activity log) are always on. | `platform_modules` |
| **Capability** | A module switched on for one business — what the business may use. Later decided by its plan. | `business_capabilities` |
| **Role** | A named set of permissions inside one business (Owner, Manager, Cashier / sales, Stock keeper, Accountant, Viewer, or the business's own). | `business_roles` |
| **Permission** | One action on one module — view, create, edit, approve, cancel, refund, export or print — written `module.action`, e.g. `sales.refund`. What a person may do. | `business_permissions`, `business_role_permissions` |
| **Membership** | A person's access to one business, with their role there. One login can have many memberships. Inside a business the header shows the person's role **there**. | `business_memberships` |
| **Business code** | The code typed at sign-in with a staff code (or when one mobile number signs in to more than one business). A restaurant's code is its business code. | `restaurants.code`, `businesses.code` |

A request is allowed only when **both** hold: the business has the module's
capability, and the person's role in that business has the permission.

## What was not renamed

The repository folder, code identifiers, database tables and API paths keep
their names. In particular, **`restaurant_*` tables are the restaurant
module's own tables** (and `restaurants`, `outlets`, `orders`, `bills`,
`menu_*` …): they belong to the restaurant business type and are not
platform-wide. Platform-wide tables start with `platform_` or `business_`, and
shared catalogue tables with `catalog_`. Future type-specific tables start with
the type, e.g. `pharmacy_*`, `salon_*` (see
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
| **Ageing** | Outstanding money split by how old the bill is: 0–30, 31–60, 61–90 and over 90 days. |

## Trade words (Phase 2: salon & spa, weight-based shops)

| Word | Meaning |
|---|---|
| **Stylist / room** | A salon resource that can be booked. A stylist has skills (the services they do); a room is booked alongside a stylist for services that need one. |
| **Clean-up time** | Minutes after a service when the stylist is still busy; a booking blocks the service time plus this. |
| **Deposit** | Money taken when booking. It is the client's advance and comes off their next bill. |
| **Late cancellation / no-show charge** | Part of the price kept, only out of the deposit, when a booking is cancelled too late or the client does not come. |
| **Package** | Sessions of services bought together, valid for a number of days, used up on later bills. |
| **Membership** | A discount on services and products for a number of days, applied by itself. |
| **Commission** | A stylist's share of the bill lines they did, from the most specific rule, fixed when the bill is saved. |
| **Cutting batch** | Cutting or cleaning one weighed input into the cuts that are sold (numbered CP/…). |
| **Yield** | The weight of the cuts as a % of the input; **process loss** is the rest. A **yield template** says what an input normally gives. |
| **Wastage** | Weight written off (trimming, spoiled, unsold, drip loss, damaged), taken out of stock at its cost. |
