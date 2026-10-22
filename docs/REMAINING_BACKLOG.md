# Remaining backlog

Updated 22 October 2026. This is the list of what is **truly left** once the
current building work is finished. Everything else described in
[ADMIN_GUIDE.md](ADMIN_GUIDE.md), [API.md](API.md) and
[MULTI_BUSINESS_ADMIN.md](MULTI_BUSINESS_ADMIN.md) exists in the code today.
The 30 September reconciliation of the original audit (channel prices, batches,
courses, outlet series, packaging charges and so on) is complete and is no
longer repeated here; see [VERIFICATION.md](VERIFICATION.md) for what is tested.

Each item says what it **needs** before it can be built: a decision from the
owner, an outside account or contract, equipment to test with, or only code.

## 1. Outside integrations

The owner's decision of 1 October: all internal work first; outside connections
later.

| Item | Where it stands | What it needs |
| --- | --- | --- |
| **Payment gateway / UPI confirmation** | The till's bill screen and the printed bill can show a UPI QR / intent link for the exact amount (`apps/business-web/src/modules/restaurant/orders/services/upi.js`), but the payment is recorded by a person. The guests' online ordering page takes payment at the counter or on delivery. Nothing confirms that the money actually arrived. | A gateway account (Razorpay, PhonePe, Paytm or the bank's UPI collect API) with keys; a webhook endpoint that marks the payment as received; a decision on what happens to an online order whose payment never arrives (cancel after N minutes or keep it as "pay at counter"); reconciliation of the gateway's settlement report against `payments`. |
| **Swiggy / Zomato** | Channels exist (`sales_channels`, commission %, channel report); aggregator orders are typed in by staff, with the partner's order ID. A cloud kitchen's POS opens on delivery and sells under several brands, with a sales-by-brand report (21 October 2026). | Partner API access from each aggregator (or an integrator such as UrbanPiper), menu and price sync rules, order-accept timing, and payout reconciliation from the platforms' settlement files. |
| **SMS / WhatsApp / email** | Reminders (udhaar, waitlist "notify", booking status, repair stages, salon appointments, retail and guest insights) open a prepared `wa.me` link or are recorded by hand. The `business_events` outbox already records the moments a message would go out (repair ready, booking made, collection received). | A provider account (MSG91, Gupta, Twilio, Meta WhatsApp Business API) with DLT-registered SMS templates in India; the owner's approved wording for each message; per-business opt-out handling that respects the guest consent already stored (`customers` marketing consent). |
| **Password reset by email / SMS** | A restaurant admin resets passwords (`PATCH /api/users/:id/password`); in a business, Staff & access resets its staff logins' passwords; the platform console resets a restaurant admin's or a business owner's. Two-step sign-in and recovery codes exist. There is no self-service "forgot password". | The SMS/email provider above; a one-time-code table with expiry and attempt limits; a rule for who may reset (owners only, or every user). |

## 2. Hardware

None of this can be finished without the equipment on a desk.

| Item | Where it stands | What it needs |
| --- | --- | --- |
| **Thermal printing** | Bills, KOTs, Z reports, labels and job cards print through the browser at 58 mm, 80 mm or A4. | The restaurant's printer models; a small local print bridge (or QZ Tray) for silent ESC/POS printing and per-station kitchen printers; acceptance on real paper. |
| **Cash drawer kick** | Drawers, floats, cash in/out and counts are recorded in software (`cash_drawers`, `cash_movements`; a shop's cashier shifts and cash checks in `business_counter_shifts` and `business_cash_checks`). | A drawer wired to the receipt printer and the same print bridge to send the open pulse when a cash payment is saved. |
| **Weighing scale** | Retail and meat shops scan the scale's printed label (`retail_scale_items`) or type the weight; the quick-bill weight buttons work. The restaurant POS asks the grams of a dish or bake sold by weight (21 October 2026). | The scale model and its protocol (serial / USB / network); a bridge that reads the live weight into the counter screen. |
| **Barcode scanner** | A keyboard-wedge scanner works today on every scan box (it simply types). | Only for camera scanning on phones or for serial-port scanners: a bridge or a camera-scanning library, tested on the actual devices. |

## 3. The platform layer

| Item | Where it stands | What it needs |
| --- | --- | --- |
| **Plans and subscriptions** | The module catalogue (`platform_modules` and its dependencies) and per-business module switches exist. The plan design is written down in [the data model](BUSINESS_PLATFORM_DATA_MODEL.md#commercial-plans--decided-a-documented-plan-no-empty-tables-yet); no plan tables exist yet by decision. | The owner's price list (which modules each plan includes, limits on locations and users, trial length); billing of the subscription itself (the payment gateway in §1); what happens when a subscription lapses (read-only, or locked). |
| **Platform admin** | The platform console in Business Admin lists, creates and switches off **restaurants** (each with its format since 21 October 2026) and, since 12 October 2026, **businesses of every other type** with their owner's login, and resets the admin's or owner's password (`/api/users/platform/restaurants`, `/api/users/platform/businesses`). There is no console for plans or support access, and no platform admin app of its own. | The plan decisions above; a list of what the platform team must see and change (support sign-in as a business, usage, invoices). |

## 4. Applications beyond the admin

The staff app (`apps/business-web`) covers every screen staff use today,
including the POS, kitchen display and captain views. Since 21 October 2026
the guests' pages (QR table ordering, online ordering and table booking) are
an app of their own, the guests' site (`apps/customer-web`). Planned screens
already have their addresses, each with a page that says what is coming and
what to use today: `/captain`, `/clinic` and `/lab` on the staff app, and
`/shop`, `/appointments` and `/account` (*Coming soon*) on the guests' site.
Still to build as **separate apps**:

| App | What it needs |
| --- | --- |
| **POS app** (offline-capable till) | A decision on offline: which actions may work without the network and how they reconcile (bill numbers are issued by the server today); a device list. |
| **Captain / waiter app** (`/captain` says what is coming) | A phone-first order screen using the existing order, KOT and captain-section APIs; push or live updates (§6). |
| **Clinic and lab workspaces** (`/clinic`, `/lab` say what is coming) | One screen for the front desk and doctors, and one for sample collection and the lab, built from the clinic and lab screens Business Admin has today; the owner's go-ahead. |
| **Customer website**: shop, appointments, account | The guests' site has the restaurant's ordering and booking pages, at the restaurant's own address when it sets one (Service settings › Guest ordering web address). The rest needs branding, hosting for each business's own address, the payment gateway (§1) and guest sign-in. |
| **Salesperson app (wholesale)** | Order taking on the beat, offline, using the sales-order APIs. |

## 5. Business types waiting for the owner's rules

None left. Pharmacy and clinic / lab were built on 8 October 2026 with standard
Indian practice (see [DECISIONS_ROUND2.md › Pharmacy & clinic](DECISIONS_ROUND2.md#pharmacy--clinic));
the owner reviews those rules with a pharmacist, a doctor and a legal adviser
before going live. Round 3 (21 October 2026) added the clinic's doctors' fees,
OPD sessions and token queue, and the lab's report versions and quality
control; a café, a bakery and a cloud kitchen run as formats of the restaurant.
Still outside: messages to patients (report ready, follow-up
reminders) wait for §1 and §6; an NDPS licence holder's own narcotic forms.

## 6. Live updates through the `business_events` outbox

Every important posting writes an event in the same transaction
(`business_events`), so nothing is lost. The restaurant's own postings do not
write them yet ([ARCHITECTURE.md](ARCHITECTURE.md) §7.3 E, step 3). Nothing
reads them yet: screens poll (the dashboard, kitchen display, deliveries,
table requests).

**Needs:** a publisher process that reads unsent events in order and marks them
sent; a delivery channel (server-sent events or WebSocket to the screens, and the
messaging provider in §1 for customers); retry and dead-letter rules; then the
restaurant's own live screens moved from polling to push.

## 7. Left inside built modules (owner: later)

From the hand-off log; each is a known gap, not a defect.

| Area | Left | What it needs |
| --- | --- | --- |
| **Wholesale** | The e-way bill **API** link (the number is typed in by hand on the dispatch and printed on the invoice and challan today); the salesperson mobile app (§4). Purchase orders, the delivery challan, free-goods schemes, cheque-bounce reversal and the order edit screen were finished in round 2 (see [DECISIONS_ROUND2.md](DECISIONS_ROUND2.md#wholesale--restaurant)). | E-way bill: GSP/NIC API access. |
| **Retail** | A live scale link (§2). Done since: the Overview's sales figures (7 October 2026, with a 14-day picture of sales since 16 October) and a cash count for each cashier at their counter (cashier shifts, 16 October 2026). Spent points back on returns came in round 2; so did split payment, and on 14 October Quick bill went back to one payment method per bill. | The scale (§2). |
| **Fashion / electronics** | A message sent by itself when a repair is ready (the event is already written, and staff open a prepared WhatsApp message at each stage; needs §1 and §6). Done since: warranty claims with the brand or distributor, and the size × colour picker on the retail counter (pro pass, 7 October 2026). | §1 and §6. |
| **Salon** | Client online booking (the guests' site's `/appointments` page says *Coming soon*); SMS / WhatsApp reminders sent by themselves (§1; a prepared WhatsApp reminder opens today). | Online booking can follow the restaurant's online-booking pattern. |
| **Meat / weight shops** | A live scale (§2). | The scale and its protocol (§2). |

## 8. Before go-live (not building work)

- Confirm tax settings, GST report exports and the Tally day-book import with the
  restaurant's accountant.
- Run the pilot checklist ([PILOT_CHECKLIST.md](PILOT_CHECKLIST.md)) on the real
  printers and network.
- Set `NODE_ENV=production`, a fresh `JWT_SECRET`, `TWO_FACTOR_KEY` and
  `TRUST_PROXY` (see `backend/.env.example`), and take a verified backup
  (`npm run db:backup -- --verify`).
- Serve the two web apps as [ARCHITECTURE.md](ARCHITECTURE.md#69-run-and-seed-locally)
  §6.9 describes: each built with the addresses it needs, the staff app's
  address in `CORS_ORIGIN`, and the old guest links (`/order`, `/online`,
  `/book`) sent on to the guests' site for good.
- A shop, salon, pharmacy or clinic pilot starts from its clean copy, never a
  demo ([DEMO_TO_REAL_PLAN.md](DEMO_TO_REAL_PLAN.md#before-a-pilot-customer-uses-one)).
- The dashboard's short-lived cache is kept per API process; with several API
  processes behind a load balancer it needs a shared cache or sticky sessions.

## 9. Found in the review of 22 October (not fixed yet)

An independent review of the docs-check fixes noticed these in code those fixes
did not change. Each needs only code; the first should come before a pilot.

| Area | Problem | What it needs |
| --- | --- | --- |
| **Staff & access (shops)** | *Password* on Staff & access sets a new password with the location check of *Give access* but not its other two: a manager tied to a department can reset the password of someone in another department, and any manager that of someone whose role can do more than theirs, and then sign in as them. | The department check and "a role no wider than yours", as *Give access* has them, with a test. |
| **Pre-orders** | A pre-order's advance is taken even with the *Advances* feature off; refunding it after a cancel then needs *Dues & accounts › Advances*, which that switch hides. | The owner's choice: take pre-order advances only with *Advances* on, or keep the refund reachable from the pre-order. |
| **Pre-orders** | The bake list adds up the pre-orders of every outlet, not only the till's. | Count only the till's outlet (and say so on the list). |
