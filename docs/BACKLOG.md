# Backlog

For the owner and developers: what is left to build, in order, and what each item needs before it can start.

What [ADMIN_GUIDE.md](ADMIN_GUIDE.md) and [API.md](API.md) describe is built. This page lists what is not. Each item says what it **needs** before it can be built: a decision from the owner, an outside account or contract, equipment to test with, or only code. What staff do meanwhile is in [ADMIN_GUIDE.md › Not built yet: what to do meanwhile](ADMIN_GUIDE.md#not-built-yet-what-to-do-meanwhile). Going live with a real business is in [GO_LIVE.md](GO_LIVE.md).

## At a glance

| Area | What is left | Needs from management |
| --- | --- | --- |
| Go-live | Server hosting, a web address with HTTPS, off-site backups, a 2–4 week pilot with real staff ([GO_LIVE.md](GO_LIVE.md)) | A server budget, a pilot business and a date |
| Outside services | Online payment confirmation, live Swiggy / Zomato orders and menus per brand, SMS and WhatsApp messages, maps ([§1](#1-outside-integrations)) | Provider accounts and contracts; the go-ahead for maps |
| Hardware | Silent receipt and kitchen printing, the cash drawer, a live weighing scale ([§2](#2-hardware)) | The printer and scale models in use |
| Plans and subscriptions | Paid plans that decide which modules a business gets ([§3](#3-the-platform-layer)) | Plan names and prices |
| Separate apps | Offline POS, captain (waiter) app, clinic and lab workspaces, guests' pages for shops, appointments and their own account, salesperson app ([§4](#4-applications-beyond-the-admin)) | Priority and go-ahead |
| Expert review | The pharmacy, clinic and lab rules ([BUSINESS_RULES.md](BUSINESS_RULES.md#pharmacy-clinic-and-lab)); the GST reports and the Tally export | A pharmacist, a doctor, a legal adviser and an accountant |

**Recommended order:** run the pilot first, with one restaurant (or café) and one shop; then add the payment gateway and WhatsApp; then plans and pricing. Before the pilot come the items in [§8](#8-needed-in-the-code-before-go-live) and the steps in [GO_LIVE.md](GO_LIVE.md).

**Technical order** ([ARCHITECTURE.md › Where the structure is going](ARCHITECTURE.md#9-where-the-structure-is-going)): the restaurant onto the shared core (plan E), one identity and role system per business (plan D), live updates through the outbox, the other apps, plans and subscriptions, outside integrations, hardware, and the migration baseline (plan F) just before go-live.

## 1. Outside integrations

The owner's rule: internal work first, outside connections later.

| Item | Where it stands | What it needs |
| --- | --- | --- |
| **Payment gateway / UPI confirmation** | The till's bill screen and the printed bill can show a UPI QR or intent link for the exact amount (`apps/business-web/src/modules/restaurant/orders/services/upi.js`), but a person records the payment. The guests' online ordering page takes payment at the counter or on delivery. Nothing confirms that the money arrived. | A gateway account (Razorpay, PhonePe, Paytm or the bank's UPI collect API) with keys; a webhook endpoint that marks the payment as received; a decision on what happens to an online order whose payment never arrives (cancel it after N minutes, or keep it as "pay at counter"); reconciling the gateway's settlement report against `payments`. |
| **Swiggy / Zomato** | Channels exist (`sales_channels`, commission %, the channel report). Staff type aggregator orders in, with the partner's order ID. A cloud kitchen's POS opens on delivery and sells under several brands, with a sales-by-brand report. | Partner API access from each aggregator (or an integrator such as UrbanPiper), rules for syncing menus and prices, order-accept timing, and payout reconciliation from the platforms' settlement files. |
| **SMS / WhatsApp / email** | Reminders (udhaar, the waitlist's "notify", booking status, repair stages, salon appointments, retail and guest insights) open a prepared `wa.me` link or are recorded by hand. The `business_events` outbox records the moments a message would go out (repair ready, booking made, collection received). | A provider account (MSG91, Gupshup, Twilio, the Meta WhatsApp Business API), with DLT-registered SMS templates in India; the owner's approved wording for each message; per-business opt-out that respects the consent already stored (the customers' marketing consent). |
| **Messages to patients** | A clinic records each patient's consent for reports on WhatsApp or e-mail and for reminders, and *Follow-ups due* lists who should come back, with their phone. Nothing is sent by itself. | The messaging provider (above) and the outbox publisher (§5). |
| **Password reset by email / SMS** | A restaurant admin resets passwords (`PATCH /api/users/:id/password`). In a business, Staff & access resets its staff logins' passwords. The Platform screens reset a restaurant admin's or a business owner's. Two-step sign-in and recovery codes exist. There is no self-service "forgot password". | The SMS / email provider above; a one-time-code table with expiry and attempt limits; a rule for who may reset (owners only, or every user). |
| **Maps** | None built. A delivery address is typed in, with a landmark, and saved with the guest for next time; the delivery charge is set per channel, not by distance; no screen or guest page shows a map. | A maps provider account (Google Maps Platform, MapmyIndia or Mapbox) with keys and a spending limit; the owner's go-ahead, with which use comes first: a pin on each delivery address, a delivery charge or area by distance, riders' routes, or the restaurant's place on the guests' site. |

## 2. Hardware

None of this can be finished without the equipment on a desk.

| Item | Where it stands | What it needs |
| --- | --- | --- |
| **Thermal printing** | Bills, KOTs, Z reports, labels and job cards print through the browser at 58 mm, 80 mm or A4. | The printer models in use; a small local print bridge (or QZ Tray) for silent ESC/POS printing and a printer per kitchen station; acceptance on real paper. |
| **Cash-drawer kick** | Drawers, floats, cash in and out, and counts are recorded in software: the restaurant's `cash_drawers` and `cash_movements`, and a shop's cashier shifts and cash checks (`business_counter_shifts`, `business_cash_checks`). | A drawer wired to the receipt printer, and the same print bridge to send the open pulse when a cash payment is saved. |
| **Weighing scale** | Retail and meat shops scan the scale's printed label (`retail_scale_items`) or type the weight, and the quick-bill weight buttons work. The restaurant POS asks for the grams of a dish or bake sold by weight. | The scale model and its protocol (serial, USB or network); a bridge that reads the live weight into the counter screen. |
| **Barcode scanner** | A keyboard-wedge scanner works on every scan box: it types. | Only for camera scanning on phones or for serial-port scanners: a bridge or a camera-scanning library, tested on the actual devices. |

## 3. The platform layer

| Item | Where it stands | What it needs |
| --- | --- | --- |
| **Plans and subscriptions** | The module catalogue (`platform_modules` and its dependencies) and each business's module switches exist. The plan design is written down in [the data model](BUSINESS_PLATFORM_DATA_MODEL.md#commercial-plans); by decision, there are no plan tables. | The owner's price list (which modules each plan includes, limits on locations and users, trial length); billing for the subscription itself (the payment gateway in §1); what happens when a subscription lapses (read-only, or locked). |
| **Platform admin** | The Platform screens in the staff app list, create and switch off restaurants (each with its format) and businesses of every other type, each with its admin's or owner's login, and give a locked-out admin or owner a new password (`/api/users/platform/restaurants`, `/api/users/platform/businesses`). There is no screen for plans or support access, and no platform admin app of its own. | The plan decisions above; a list of what the platform team must see and change (signing in as a business for support, usage, invoices). |
| **Sign-up** | There is no self-service sign-up. The first login, a platform Super Admin, comes from `npm --prefix backend run user:create` with an empty restaurant code ([README.md › The first login](../README.md#3-the-first-login)). The Super Admin then creates each restaurant and business with its owner's login. | The owner's decision on whether businesses may sign themselves up. |

## 4. Applications beyond the admin

The staff app (`apps/business-web`) covers every screen staff use, including the POS, the kitchen display and the captain views. The guests' pages (QR table ordering, online ordering and table booking) are an app of their own, the guests' site (`apps/customer-web`). Planned screens have their addresses, each with a page that says what is coming and what to use meanwhile: `/captain`, `/clinic` and `/lab` on the staff app, and `/shop`, `/appointments` and `/account` (*Coming soon*) on the guests' site.

Still to build as separate apps:

| App | What it needs |
| --- | --- |
| **POS app** (an offline-capable till) | A decision on offline: which actions may work without the network and how they reconcile (the server issues bill numbers); a device list. |
| **Captain / waiter app** (`/captain` says what is coming) | A phone-first order screen using the existing order, KOT and captain-section APIs; push or live updates (§5). |
| **Clinic and lab workspaces** (`/clinic` and `/lab` say what is coming) | One screen for the front desk and the doctors, and one for sample collection and the lab, built from the clinic and lab screens of Business Admin; the owner's go-ahead. |
| **Customer website**: shop, appointments, account | The guests' site has the restaurant's ordering and booking pages, at the restaurant's own address when it sets one (*Service settings › Guest ordering web address*). The rest needs branding, hosting for each business's own address, the payment gateway (§1) and guest sign-in. |
| **Salesperson app (wholesale)** | Order taking on the beat, offline, using the sales-order APIs. |

## 5. Live updates through the outbox

Every important posting of a business writes an event (`business_events`) in the same transaction, so nothing is lost. The restaurant's own postings write no events ([ARCHITECTURE.md §9.3](ARCHITECTURE.md#93-plans-d-e-and-f), plan E, step 3). Nothing reads the events: screens poll (the dashboard, the kitchen display, deliveries, table requests).

**Needs:** a publisher process that reads unsent events in order and marks them sent; a delivery channel (server-sent events or WebSocket to the screens, and the messaging provider in §1 for customers); rules for retries and a dead-letter record; then the restaurant's live screens moved from polling to push. How to connect a consumer is in [ARCHITECTURE.md › Add an outside integration through the events outbox](ARCHITECTURE.md#88-add-an-outside-integration-through-the-events-outbox).

## 6. Structure work

The larger changes to the code's structure. Each is described step by step in [ARCHITECTURE.md › Where the structure is going](ARCHITECTURE.md#9-where-the-structure-is-going).

- **Plan D, one identity:** one role system per business, with approvals, PIN sign-in, outlet pinning and two-step roles on memberships ([§9.3](ARCHITECTURE.md#93-plans-d-e-and-f)).
- **Plan E, the restaurant on the shared core:** the restaurant's locations, events, master data, menu, stock and money move onto the shared tables, one area at a time: write both, compare, switch the reads, retire the old tables ([§9.3](ARCHITECTURE.md#93-plans-d-e-and-f)).
- **Plan F, a migration baseline before go-live:** new installs run one baseline file instead of every migration ([§9.3](ARCHITECTURE.md#93-plans-d-e-and-f)).
- **Folders that wait for their first piece:** the staff app's `workspaces/` (with the first planned workspace), the backend's `integrations/` and `jobs/` (with the first integration), and `apps/platform-admin` (when the platform team releases on its own) ([§9.4](ARCHITECTURE.md#94-folders-that-wait-for-their-first-piece)).

## 7. Left inside built modules

Known gaps, not defects. The owner decides when each is built.

| Area | Left | What it needs |
| --- | --- | --- |
| **Every business type** | A business keeps the name it was created with: the business switcher shows it, and it cannot be changed. (A shop's *Name shown in the app*, which prints on bills, can.) | Code only. |
| **Every business type** | Ownership cannot be handed over. The Owner role is given only when a business is created, and *Staff & access* cannot give it to another login. | The owner's rule for who may hand a business over; then code. |
| **Shops** | No CSV import of products, customers or suppliers: they are typed in. Stock comes in with the item (opening stock) or through a purchase; a stock count corrects stock already on record. Only the restaurant imports CSV files (menu, recipes, stock items, suppliers and guests). | Code only. |
| **Restaurant** | A kitchen-station report. The kitchen display and the dashboard show only today's ticket times. | Code only. |
| **Restaurant** | Pre-orders: the outlet *Remove* dialog does not count open pre-orders (the server refuses to close such an outlet, but the dialog learns it only on the button); switching *Pre-orders & cakes* off gives no warning about open pre-orders; the dashboard's Pre-orders card does not refresh with the other cards; closing an outlet and booking a pre-order there at the same moment can both pass. | Code only: count open pre-orders in `GET /api/outlets/:id/usage`, a live-data check like Reservations', a refresh with the other cards, a row lock. |
| **Restaurant** | Kitchen staff read the bake list but cannot mark a pre-order *In production* or *Ready*, which needs `orders.create`. A kitchen login not tied to an outlet always reads the main counter's list. | The owner's rule for who moves pre-orders along; then code. |
| **Every business type** | *Staff & access* lists everyone to a manager tied to a department (with no buttons on people outside it), and shows *Password* for a person whose login is also used elsewhere, which the server then refuses. | The owner's rule for what a department manager sees; then code. |
| **Restaurant** | *Table requests › Open guest menu* opens the platform's guests' site, even when the restaurant has its own guest web address. Both serve the same page. | Code only. |
| **Wholesale** | The e-way bill API link: the number is typed in by hand on the dispatch and printed on the invoice and the challan. The salesperson app is in [§4](#4-applications-beyond-the-admin). | GSP / NIC API access. |
| **Wholesale** | A return of scheme goods does not take back the free goods that came with them. | The owner's rule for free goods on a return; then code. |
| **Retail** | A live scale link (§2). | The scale (§2). |
| **Fashion / electronics** | A message sent by itself when a repair is ready. The event is written, and staff open a prepared WhatsApp message at each stage. | §1 and §5. |
| **Salon** | Client online booking (the guests' site's `/appointments` page says *Coming soon*). Reminders sent by themselves by SMS or WhatsApp; staff open a prepared WhatsApp reminder. A *Book* button on the general Clients list; the client card, with *Book a visit*, opens from the calendar, the bill and the history. | Online booking can follow the restaurant's online booking; reminders need §1; the *Book* button is code only. |
| **Meat / weight shops** | A live scale (§2). Pickup orders take no advance; note it on the order. Offcuts sold cheap have no "recovered ₹" figure. | The scale and its protocol (§2); the rest is code only. |
| **Pharmacy** | An NDPS licence holder's own narcotic forms. Narcotic sales go into the Schedule X register. | The NDPS licence details. |
| **Guests' site** | It loads the whole shared stylesheet, staff-only rules included. Trimming them out of `@bmp/ui` is a change of its own, checked screen by screen. | Code only. |
| **Guests' site** | The backend has no default guest address (a `GUEST_WEB_URL` setting): only the staff app knows the guests' site's address. One is needed before the first SMS, WhatsApp or e-mail link is sent. | Code only. |
| **Staff app** | The restaurant's header shows for a moment while a shop opens. | Code only. |
| **Staff app** | With *Shared till* set to ask the biller's PIN for every bill, a cashier who has just switched the till to themselves types their PIN again for the bill. | Code only. |

## 8. Needed in the code before go-live

The production settings, backups, serving the two web apps and the expert reviews are in [GO_LIVE.md](GO_LIVE.md). These need code:

- **The session token.** The staff app keeps it in the browser's `localStorage` (`rmp_token`). Decide before production whether it stays there.
- **A password someone else set.** A password that someone else sets for a person (a new login's first password, or a new one, in the restaurant's *Users*, in *Staff & access* or on the Platform screens) never has to be changed at the next sign-in, so whoever set it can sign in as that person until they change it in *My profile*. It needs a must-change flag set on every such password, and a sign-in step that makes the person choose their own before anything else.
- **The dashboard cache.** It is kept per API process (`backend/src/utils/dashboardCache.js`). With several API processes behind a load balancer, it needs a shared cache or sticky sessions.
- **Plan F, the migration baseline** ([§6](#6-structure-work)). When no more schema changes are expected, new installs run one baseline file instead of every migration.

## 9. Known problems

None is open. A problem found in the code is listed here, with what it needs, until it is fixed.
