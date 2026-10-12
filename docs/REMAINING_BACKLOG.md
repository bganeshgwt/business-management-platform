# Remaining backlog

Updated 6 October 2026. This is the list of what is **truly left** once the
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
| **Payment gateway / UPI confirmation** | The till and the online ordering page can show a UPI QR / intent link for the exact amount (`frontend/src/modules/restaurant/orders/services/upi.js`), but the payment is recorded by a person. Nothing confirms that the money actually arrived. | A gateway account (Razorpay, PhonePe, Paytm or the bank's UPI collect API) with keys; a webhook endpoint that marks the payment as received; a decision on what happens to an online order whose payment never arrives (cancel after N minutes or keep it as "pay at counter"); reconciliation of the gateway's settlement report against `payments`. |
| **Swiggy / Zomato** | Channels exist (`sales_channels`, commission %, channel report); aggregator orders are typed in by staff. | Partner API access from each aggregator (or an integrator such as UrbanPiper), menu and price sync rules, order-accept timing, and payout reconciliation from the platforms' settlement files. |
| **SMS / WhatsApp / email** | Reminders (udhaar, waitlist "notify", booking status, retail and guest insights) open a prepared `wa.me` link or are recorded by hand. The `business_events` outbox already records the moments a message would go out (repair ready, booking made, collection received). | A provider account (MSG91, Gupta, Twilio, Meta WhatsApp Business API) with DLT-registered SMS templates in India; the owner's approved wording for each message; per-business opt-out handling that respects the guest consent already stored (`customers` marketing consent). |
| **Password reset by email / SMS** | An admin resets passwords (`PATCH /api/users/:id/password`); two-step sign-in and recovery codes exist. There is no self-service "forgot password". | The SMS/email provider above; a one-time-code table with expiry and attempt limits; a rule for who may reset (owners only, or every user). |

## 2. Hardware

None of this can be finished without the equipment on a desk.

| Item | Where it stands | What it needs |
| --- | --- | --- |
| **Thermal printing** | Bills, KOTs, Z reports, labels and job cards print through the browser at 58 mm, 80 mm or A4. | The restaurant's printer models; a small local print bridge (or QZ Tray) for silent ESC/POS printing and per-station kitchen printers; acceptance on real paper. |
| **Cash drawer kick** | Drawers, floats, cash in/out and counts are recorded in software (`cash_drawers`, `cash_movements`). | A drawer wired to the receipt printer and the same print bridge to send the open pulse when a cash payment is saved. |
| **Weighing scale** | Retail and meat shops scan the scale's printed label (`retail_scale_items`) or type the weight; the quick-bill weight buttons work. | The scale model and its protocol (serial / USB / network); a bridge that reads the live weight into the counter screen. |
| **Barcode scanner** | A keyboard-wedge scanner works today on every scan box (it simply types). | Only for camera scanning on phones or for serial-port scanners: a bridge or a camera-scanning library, tested on the actual devices. |

## 3. The platform layer

| Item | Where it stands | What it needs |
| --- | --- | --- |
| **Plans and subscriptions** | The module catalogue (`platform_modules` and its dependencies) and per-business module switches exist. The plan design is written down in [the data model](BUSINESS_PLATFORM_DATA_MODEL.md#commercial-plans--decided-a-documented-plan-no-empty-tables-yet); no plan tables exist yet by decision. | The owner's price list (which modules each plan includes, limits on locations and users, trial length); billing of the subscription itself (the payment gateway in §1); what happens when a subscription lapses (read-only, or locked). |
| **Platform admin** | The platform owner can list, create, suspend and reset the admin of **restaurants** (`/api/users/platform/restaurants`). There is no console for the other business types, plans or support access. | The plan decisions above; a list of what the platform team must see and change (support sign-in as a business, usage, invoices). |

## 4. Applications beyond the admin

The admin application covers every screen staff use today, including the POS,
kitchen display, captain views, QR table ordering, online booking and online
ordering pages. Still to build as **separate apps**:

| App | What it needs |
| --- | --- |
| **POS app** (offline-capable till) | A decision on offline: which actions may work without the network and how they reconcile (bill numbers are issued by the server today); a device list. |
| **Captain / waiter app** | A phone-first order screen using the existing order, KOT and captain-section APIs; push or live updates (§6). |
| **Customer app / website** | Branding, a domain per restaurant, the payment gateway (§1) and guest sign-in. |
| **Salesperson app (wholesale)** | Order taking on the beat, offline, using the sales-order APIs. |

## 5. Business types waiting for the owner's rules

None left. Pharmacy and clinic / lab were built on 8 October 2026 with standard
Indian practice (see [DECISIONS_ROUND2.md › Pharmacy & clinic](DECISIONS_ROUND2.md#pharmacy--clinic));
the owner reviews those rules with a pharmacist, a doctor and a legal adviser
before going live. Still outside: messages to patients (report ready, follow-up
reminders) wait for §1 and §6; an NDPS licence holder's own narcotic forms.

## 6. Live updates through the `business_events` outbox

Every important posting writes an event in the same transaction
(`business_events`), so nothing is lost. Nothing reads them yet: screens poll
(the dashboard, kitchen display, deliveries, table requests).

**Needs:** a publisher process that reads unsent events in order and marks them
sent; a delivery channel (server-sent events or WebSocket to the screens, and the
messaging provider in §1 for customers); retry and dead-letter rules; then the
restaurant's own live screens moved from polling to push.

## 7. Left inside built modules (owner: later)

From the hand-off log; each is a known gap, not a defect.

| Area | Left | What it needs |
| --- | --- | --- |
| **Wholesale** | The e-way bill **API** link (the number is typed in by hand on the dispatch and printed on the invoice and challan today); the salesperson mobile app (§4). Purchase orders, the delivery challan, free-goods schemes, cheque-bounce reversal and the order edit screen were finished in round 2 (see [DECISIONS_ROUND2.md](DECISIONS_ROUND2.md#wholesale--restaurant)). | E-way bill: GSP/NIC API access. |
| **Retail** | Quick bill: a cash drawer per till; a live scale link (§2); retail figures on the Overview. (Split payment and spent points back on returns: done in round 2.) | — |
| **Fashion / electronics** | Warranty claims to the manufacturer; a message to the customer when a repair is ready (the event is already written; needs §1 and §6); a size × colour picker on the retail counter (scanning the variant barcode works today). | Claims: the brands' claim process. |
| **Salon** | Client online booking; SMS / WhatsApp reminders (§1). | Online booking can follow the restaurant's online-booking pattern. |
| **Meat / weight shops** | A live scale (§2). | The scale and its protocol (§2). |

## 8. Before go-live (not building work)

- Confirm tax settings, GST report exports and the Tally day-book import with the
  restaurant's accountant.
- Run the pilot checklist ([PILOT_CHECKLIST.md](PILOT_CHECKLIST.md)) on the real
  printers and network.
- Set `NODE_ENV=production`, a fresh `JWT_SECRET`, `TWO_FACTOR_KEY` and
  `TRUST_PROXY` (see `backend/.env.example`), and take a verified backup
  (`npm run db:backup -- --verify`).
- The dashboard's short-lived cache is kept per API process; with several API
  processes behind a load balancer it needs a shared cache or sticky sessions.
