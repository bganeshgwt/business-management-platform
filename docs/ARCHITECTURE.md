# Architecture

For developers: how the platform is built and why, where each piece of code
lives, and how to extend it.

**Related references.** The full index of documents is in the
[README](../README.md#documentation).

- [GLOSSARY.md](GLOSSARY.md): the words (business, type, module, capability,
  role, document, SKU, lot…).
- [BUSINESS_PLATFORM_DATA_MODEL.md](BUSINESS_PLATFORM_DATA_MODEL.md): the
  business platform's data design and the rules each table carries.
- [DATABASE.md](DATABASE.md): every table, column, constraint and trigger,
  and the catalogues of business types, modules and permissions.
- [API.md](API.md): every endpoint and the calling conventions.
- [TESTING.md](TESTING.md): running the tests, and what each suite needs.
- [GO_LIVE.md](GO_LIVE.md): production settings, serving the two web apps,
  backups and restore.

## Contents

1. [What it is and the principles](#1-what-it-is-and-the-principles)
2. [Applications and addresses](#2-applications-and-addresses)
   - [2.1 The applications](#21-the-applications) ·
     [2.2 Every address](#22-every-address) ·
     [2.3 Running them locally](#23-running-them-locally)
3. [How a request flows](#3-how-a-request-flows)
   - [3.1 The two entry paths](#31-the-two-entry-paths) ·
     [3.2 The business switcher](#32-the-business-switcher) ·
     [3.3 Manager approval](#33-manager-approval) ·
     [3.4 Events, audit and the bell](#34-events-audit-and-the-bell) ·
     [3.5 Live updates](#35-live-updates)
4. [The database](#4-the-database)
   - [4.1 The business platform in five layers](#41-the-business-platform-in-five-layers) ·
     [4.2 The restaurant module's own tables and the bridge](#42-the-restaurant-modules-own-tables-and-the-bridge) ·
     [4.3 Tasks, issues & projects](#43-tasks-issues--projects-one-model-for-both-worlds) ·
     [4.4 How a sale moves money and stock](#44-how-a-sale-moves-money-and-stock) ·
     [4.5 GST rates by date](#45-gst-rates-by-date-a-change-that-takes-effect-with-no-job-runner) ·
     [4.6 Personal data](#46-personal-data-one-model-for-both-engines) ·
     [4.7 An owner's GST thresholds](#47-an-owners-gst-thresholds-one-pan-across-both-engines)
5. [Two engines, one direction](#5-two-engines-one-direction)
   - [5.1 Where they differ](#51-where-they-differ) ·
     [5.2 Who owns what](#52-who-owns-what) ·
     [5.3 Until they converge](#53-until-they-converge)
6. [Code map](#6-code-map)
   - [6.1 Repository layout](#61-repository-layout) ·
     [6.2 Inside a backend module](#62-inside-a-backend-module) ·
     [6.3 Inside a web app](#63-inside-a-web-app) ·
     [6.4 Which files belong to which module](#64-which-files-belong-to-which-module)
7. [Conventions](#7-conventions)
   - [What not to do](#what-not-to-do)
8. [How to …](#8-how-to-)
   - [8.1 Add a feature to a business type](#81-add-a-feature-to-a-business-type) ·
     [8.2 Add a new business type](#82-add-a-new-business-type) ·
     [8.3 Add a module switch](#83-add-a-module-switch) ·
     [8.4 Add a permission](#84-add-a-permission) ·
     [8.5 Add a migration](#85-add-a-migration) ·
     [8.6 Add a screen with a DataGrid](#86-add-a-screen-with-a-datagrid) ·
     [8.7 Add a report](#87-add-a-report) ·
     [8.8 Add an outside integration](#88-add-an-outside-integration-through-the-events-outbox) ·
     [8.9 Turn a planned screen into a real one](#89-turn-a-planned-screen-into-a-real-one)
9. [Where the structure is going](#9-where-the-structure-is-going)
   - [9.1 Known weak spots](#91-known-weak-spots) ·
     [9.2 Target structure](#92-target-structure) ·
     [9.3 Plans D, E and F](#93-plans-d-e-and-f) ·
     [9.4 Folders that wait for their first piece](#94-folders-that-wait-for-their-first-piece)

---

## 1. What it is and the principles

**What it is.** The **Business Management Platform** is one product for
independent businesses: restaurants (run as a restaurant, café, bakery or
cloud kitchen), grocery / kirana shops, supermarkets, wholesale / FMCG
distributors, fashion, electronics, pharmacies, books & stationery, salons &
spas, clinics & labs, meat & seafood shops, other weight-based shops, general
stores, hardware and building materials, seeds and fertilisers, optical shops,
garages and auto parts, jewellers, fuel stations, gyms and coaching, laundries,
rentals, and hotels and lodges. One
PostgreSQL database holds every business. Each business sees only its own
data and only the parts (modules) it has switched on. One person can belong
to several businesses, with a different role in each.

There is no sign-up page, and the database holds no businesses until someone
creates them. The first login is a platform Super Admin, made with
`npm --prefix backend run user:create`
([README › The first login](../README.md#3-the-first-login)). It creates
restaurants and businesses in the platform console, and their owners add
everything else. On an empty database the migrations create only what every
business shares: the business types, the module and permission catalogues,
the role templates and system roles, and the task categories.

**Principles.** Each one is enforced in code or in the database, not only
written down.

| Principle | What it means in practice |
| --- | --- |
| **Shared core plus type extensions** | Everything most businesses need (catalogue, contacts, documents, payments, stock, number series, appointments, receivables) is one shared core. A business type adds only what is truly its own, in `<type>_*` tables that hang off core rows. A core table never gets a column for one type's sake. |
| **Capability vs permission** | Every request asks two separate questions: *may this business use the module?* (`business_capabilities`; later set by its plan) and *may this person do this action?* (their role's permissions in that business). Both must say yes, and the server asks both. Hiding a button on the screen is only a convenience. |
| **Every record scoped to its business** | Business tables carry `business_id NOT NULL` and composite foreign keys `(business_id, x_id)`, so the database refuses a row that points at another business's data. The restaurant tables are scoped by `restaurant_id`, taken from the signed-in user, never from the request. |
| **Money in paise** | Amounts are stored as `NUMERIC(…,2)`, never as floating point. They are worked out in whole paise (BigInt where quantities multiply), so lines, taxes and splits add up to the paisa. |
| **Idempotent postings** | A business posting carries a `request_key` (UUID), unique per business, plus a hash of the request. Repeating it returns the first result; the same key with different content is a 409. |
| **Audit and events** | Every business change writes an audit row (`business_audit`) and, for money, stock and appointments, an outbox event (`business_events`), **in the same transaction**. Restaurant actions write `audit_logs` (§5.1 explains the difference). |
| **Rules in the database** | Where a bug would lose money or stock, a CHECK, a partial unique index or a trigger refuses it too, with a sentence a person can read (SQL state 23514, answered as HTTP 409). |
| **Today-only live screens** | Live screens (dashboard, kitchen, deliveries, table requests, the bell) show the current *trading day* in the business's time zone. Between midnight and the day cut-off (5 am by default) last night's day is still today. Anything older that is still open is only counted or flagged, never mixed in with today's. |
| **Live screens hear of every change** | A change committed on one screen reaches every other open screen that shows it within about a second (§3.5). The database announces it: a trigger on each table those screens read calls `pg_notify`, so no code path can forget, and only a committed change is ever announced. A notification says where and what changed, never the data; the screen reads again through its normal API call, which checks the person's permissions. A screen's own timer stays only as a slow safety net (a minute or more). |
| **Dates on the business's clock** | "Today", a bill's date and "not in the future" are the restaurant's or business's date in its own time zone, never the server's: a server on UTC is still on yesterday until 05:30 in India. Restaurant code takes the date from `restaurantToday()` and `todayOf()` in `modules/restaurant/business-day/services/tradingDay.js`; the business core from `now() AT TIME ZONE businesses.timezone`. A GST rate change takes effect on that date too, and a bill uses the rate in force on its own (§4.5). |
| **Data grid everywhere** | Every list is the shared `DataGrid` component: S.No., paging, search, column choice, export and cards on a phone. |

**How the code is organised.**

1. **By business area first, then by technical layer.** Look for "orders"
   or "salon" first, then for the service or the page inside it.
2. **One owner per business record.** Exactly one module writes a given
   table (stock, bills, payments…). Other modules call that module's service
   and never write its tables themselves (§5.2).
3. **Folders arrive with their feature.** Future industries and folders are
   written down (§9.4), not created empty.
4. **A planned screen has its address already.** It opens a page that says
   what is coming and what to use until then, never "Page not found". When
   the screen is built, it takes over the route (§8.9).

---

## 2. Applications and addresses

### 2.1 The applications

| Application | State |
| --- | --- |
| **Staff app** (`apps/business-web`, port 5173 in development) | Built. A switcher in the header opens any business you belong to. For a restaurant (run as a restaurant, café, bakery or cloud kitchen) it is the full restaurant admin, with the POS screen, the kitchen display and the captain app. For the other types it is Business Admin, whose menu is built from that business's modules. It also holds the platform console. |
| **Guests' site** (`apps/customer-web`, port 5174) | Built: QR table ordering, online ordering and table booking, with no sign-in. Its planned pages answer already, with what is coming. |
| **API** (`backend`, port 5010 as `.env.example` sets it) | Built: one Express API and one PostgreSQL database for both apps. |
| POS app (an offline-capable till) | Planned. The POS *screen* is in the staff app (`/pos`). |
| Captain / waiter app | Built, as part of the staff app (`/captain`): a route group with a layout of its own (`src/workspaces/captain`), phone first, on the POS's own order screen and the order, KOT, table-request and captain-section APIs, with live updates. |
| Kitchen display app | Planned as a separate app. The screen is in the staff app (`/kitchen`). |
| Clinic and lab workspaces | Built, as part of the staff app (`/clinic`, `/lab`): route groups with layouts of their own (`src/workspaces/clinic`, `src/workspaces/lab`, both in `src/layouts/BusinessWorkspace.jsx`), for the front desk's computer, a doctor's tablet and the lab bench, on the health module's own pages and APIs, with live updates. |
| Platform admin and subscriptions | Planned. A platform Super Admin runs the platform console in the staff app (`/platform/restaurants`, `/platform/businesses`). There are no plans or subscriptions; their shape is set in [DATA_MODEL › Commercial plans](BUSINESS_PLATFORM_DATA_MODEL.md#commercial-plans). |

### 2.2 Every address

**Staff app** (`apps/business-web`)

| Address | For | State |
| --- | --- | --- |
| `/` | Home. A restaurant's staff get the restaurant dashboard. Staff of other businesses land on the business they used last, or on their first one. The platform Super Admin lands on `/platform/restaurants`. A pickup-counter TV signed in with the Collection display role lands on `/collection`. | Built |
| `/orders`, `/menu/…`, `/reports`, `/tasks/…` … | The restaurant admin's screens, one per menu link | Built |
| `/login`, `/profile`, `/notifications` | Everyone: signing in, their own profile, every alert | Built |
| `/business-admin` | The person's businesses: with `?all` the list itself, otherwise the one opened last | Built |
| `/business-admin/gst-thresholds` | An owner: their businesses' turnover by PAN against the GST thresholds (from the switcher and *Your businesses*) | Built |
| `/business-admin/:id/…` | Every business type's admin: sales, stock, customers and the type's own screens | Built |
| `/pos` | Cashiers and captains | Built |
| `/kitchen` | Kitchen staff: the kitchen display | Built |
| `/collection` | The pickup counter's TV | Built |
| `/platform/restaurants`, `/platform/businesses` | The platform Super Admin | Built; moves to its own app later |
| `/captain`, `/captain/calls`, `/captain/ready`, `/captain/order` | Waiters, on a phone: the captain app (their tables, guests' calls, food at the pass, taking an order) | Built |
| `/clinic`, `/clinic/:id/…` | Reception and doctors: the clinic workspace (the desk with the queue by doctor, the consultation, today, patients, visits). `/clinic` opens the clinic chosen last, or asks which | Built |
| `/lab`, `/lab/:id/…` | Lab staff and pathologists: the lab workspace (collection, worklist, approval, released reports, every order, quality control, tests). `/lab` opens the clinic chosen last, or asks which | Built |
| `/order/…`, `/online/…`, `/book/…` | Old guest links and printed QR codes | Sent on to the guests' site, path and query kept |

**Guests' site** (`apps/customer-web`)

| Address | For | State |
| --- | --- | --- |
| `/order/:token` | A guest at a table, from its QR code | Built |
| `/online/:token` | Ordering for pickup or delivery, and the order's status | Built |
| `/book/…` | Booking a table, and the booking's status | Built |
| `/shop/…` | A shop's customers ordering online | **Planned** |
| `/appointments/…` | Salon and clinic clients booking | **Planned** |
| `/account` | A returning guest's orders, bookings and points | **Planned** |
| Anything else | A link with part missing, or the bare address | A page that says how to open the right link |

On the guests' site, a planned address opens a page marked *Coming soon* that
says what is coming and what to do until then. A bookmark or a tablet set up
on it keeps working when the screen arrives. The guests' planned pages are
listed in `apps/customer-web/src/plannedPages.js`. Every staff app address is
built; a planned one is listed in
`apps/business-web/src/services/plannedWorkspaces.js` and opens the staff
app's planned page (`layouts/PlannedPage.jsx`, marked *Planned · not built
yet*: what it will do, then what to use until then, with buttons to go there)
(§8.9).

### 2.3 Running them locally

Before the first run, set up the database, the `.env` files and the first
login: [README › Set up from an empty database](../README.md#set-up-from-an-empty-database).
The commands are in [README › Run](../README.md#run); this is what they do.

- `npm run dev` at the root (`tools/dev.mjs`) starts the API, the staff app
  and the guests' site together. Each output line is marked with its app.
  - It checks the three ports first: the API's `PORT` from `backend/.env`,
    5173 and 5174. If one is busy, it says which app is probably running
    already and starts nothing.
  - Ctrl+C stops all three. If one of them stops, the other two stop too.
- `npm run dev:backend`, `npm run dev:business` and `npm run dev:customer`
  start one app at a time: the API under nodemon (it restarts when a file in
  `backend/src` changes), or one web app's Vite server.
- The web apps' ports are fixed (`strictPort`), so a second copy stops
  instead of moving to another port. The API listens on `PORT` from
  `backend/.env`: 5000 when it is not set, 5010 in `.env.example`, which is
  the address both apps' `.env.example` files use.
- Each Vite server shows only its own app, `packages/` and `node_modules`
  (`server.fs.allow` in its `vite.config.js`). Starting one with `-- --host`
  therefore exposes nothing else of the repository. To try the guest pages on
  a phone, see
  [apps/customer-web/README.md › Trying it on a phone](../apps/customer-web/README.md#trying-it-on-a-phone).

`npm run build` writes both apps' `dist/` folders. The guests' site puts its
files under `guest-assets/`, so one address can serve both builds. How to
serve them: [GO_LIVE › Serve the two web apps](GO_LIVE.md#3-serve-the-two-web-apps).

---

## 3. How a request flows

```
 Browser
   │  React page (apps/business-web/src/modules/<module>/pages/…; a guest's page: apps/customer-web)
   │    └─ a service function (the module's services/*.service.js, or src/services/)
   │         └─ staff app: services/api.js  (axios: Bearer token, X-Outlet-Id, approval retry)
   │            guests' site: the module's own axios instance on /api/public, no token
   ▼
 Express 5  (backend/src/app.js: helmet → compression → cors → json → morgan
   │         → /uploads static → dashboard-cache clear on write → /api routes)
   │
   ├─ routes/index.js  picks the module's router by path (/auth, /businesses, /bills, …)
   │
   ├─ middlewares, in the route's order:
   │    authenticate          JWT → req.user (id, restaurantId, outletId, roles, permissions, features);
   │                          a password someone else set: 403 password_change_required, but for
   │                          /auth/me and /auth/change-password (authenticate.duringPasswordChange)
   │    resolveOutlet         restaurant only: X-Outlet-Id → req.outletId (pinned staff cannot change it)
   │    requireFeature(code)  restaurant only: feature switched on? (§4.2)
   │    authorize(perm)       restaurant only: req.user.permissions has it?
   │    authorizeOrApprove    restaurant only: or a manager's one-time approval token
   │    context(perm)         business only: membership → location → capability → permission
   │                          (req.business)
   │
   ├─ controller   (restaurant: modules/…/controllers/*.controller.js — reads req, validates, answers)
   │               (business: the route handler itself calls the service; there are no controllers)
   ├─ service      business rules; opens the transaction
   ├─ repository   SQL only, always with $1, $2 placeholders
   ▼
 PostgreSQL  (constraints and triggers have the last word)
   │
   └─ in the same transaction: business_audit + business_events (business side)
      after the action: audit_logs via utils/audit.js logAction (restaurant side)
```

### 3.1 The two entry paths

The code has two request paths, one per data world (§5 explains why).

| | Restaurant admin | Business Admin (every other type) |
| --- | --- | --- |
| URLs (browser) | `/`, `/pos`, `/menu/…`, `/reports` … | `/business-admin/<businessId>/<section>` |
| API | `/api/bills`, `/api/orders`, `/api/menu` …: one route file per area | `/api/businesses/:businessId/…`: one router, `business.routes.js`, plus the route files it mounts (one per type module, and `businessCounter.routes.js` for the counter) |
| Which tenant | `req.user.restaurantId`, from the signed-in user. Never from the request. | `:businessId` in the URL, **checked against the caller's membership** on every request. A business you are not a member of answers 404. |
| Branch | The `X-Outlet-Id` header, checked by `resolveOutlet` | `locationId` in the body or query, checked against that business's `business_locations`. A person tied to one location (`business_memberships.location_id`) works there only. For anyone else, the branch picked in the top bar (sent as `X-Business-Location`) fills in a location the request leaves out. |
| Permissions | `users` → `user_roles` → `roles` → `role_permissions` → `permissions` ([the codes](DATABASE.md#restaurant-permission-codes)) | `business_memberships` → `business_roles` → `business_role_permissions` → `business_permissions` ([the codes](DATABASE.md#business-permission-codes)) |
| Module gate | Restaurant features (`requireFeature`, §4.2) | `business_capabilities` (`businessAccess.service.js`) |
| Errors | `AppError` → `errorHandler.js`; a trigger's refusal (23514 naming no constraint, such as the cash limit) becomes a 409 with its sentence there | `AppError`; database codes 23505 / 23503 / 23514 become 409 / 400 at the end of `business.routes.js` ([API › Conventions](API.md#conventions)) |

### 3.2 The business switcher

```
 AppLayout
   └─ BusinessProvider (context/BusinessProvider.jsx)
        ├─ GET  /api/businesses                 → the switcher's list (memberships)
        ├─ URL /business-admin/:id/*             → which business is open
        ├─ GET  /api/businesses/:id/context      → modules, permissions, role, settings, locations
        └─ POST /api/businesses/:id/open         → remember "last opened" (server, per person)
   └─ BusinessSwitcher (components/BusinessSwitcher.jsx)
   └─ BusinessLocationSwitcher (components/BusinessLocationSwitcher.jsx) → the branch, as X-Business-Location
```

- The **active business reaches the server only through the URL**
  (`/api/businesses/<id>/…`, built by `services/business.service.js`).
  Nothing about the business is kept in a header or a cookie. Only the
  branch picked beside the switcher travels, as `X-Business-Location`
  (`services/api.js`), and the server accepts it only for an open location of
  that business. The server checks the membership, module and permission
  again on every call, so an edited URL gains nothing.
- Picking the **signed-in restaurant** goes to `/` and the restaurant admin.
  Its business row is marked `is_signed_in_restaurant` (its
  `legacy_restaurant_id` is the user's `restaurantId`). Picking any other
  business goes to `/business-admin/<id>`.
- The last business opened is stored in `business_memberships.last_opened_at`.
  Arriving at `/` sends a restaurant's staff to that business when it was not
  their restaurant. Someone with no restaurant role always lands on the
  business they used last, or on their first one.
- The menu for a business is `businessMenu()` in `services/businessNav.js`.
  Each link (`businessSections()`) names a permission (`need`), optionally a
  module, and the business types it belongs to. `services/businessWorkspace.js`
  groups the links a person may open into workspaces (Daily work, Business,
  Management). `BusinessAdminRoutes.jsx` guards each screen with the same
  rule, so a screen opened by its address says why it is not available.
- The restaurant's own menu links are `NAV_SECTIONS` in `layouts/AppLayout.jsx`
  (a link names its `permission`, or with `permissionAny` several of which one
  is enough, and may also name the formats it is for: `formats`,
  `notFormats`). `restaurantMenu()` in `services/restaurantWorkspace.js`
  groups them into areas, and `App.jsx` guards each route with
  `ProtectedRoute` (`permission`, `permissionAny`, `feature`, `featureAny`).

### 3.3 Manager approval

On the restaurant side, a cashier without, say, `bills.void` asks anyway.
`authorizeOrApprove` answers 403 with `reason: "approval_required"` and what
the action would do (`scope`). `services/api.js` opens the PIN dialog
(`components/ApprovalDialog.jsx`). A manager approves through
`POST /api/auth/approvals`, and the same request is sent again once, with
`X-Approval-Token`. The token is spent before the action runs. It is tied to
the user, the permission and the scope (bill, amount), and it is never handed
back. The activity log row then names both people.

The business side asks for a manager's PIN in its own ways (§5.1).

### 3.4 Events, audit and the bell

- **Business side:** `repo.audit()` and `repo.event()` in
  `modules/business/core/repositories/business.repository.js` are always
  called with the transaction's own client. If the change rolls back, so do
  they. `business_events` is an outbox: live updates hear of each event as
  it commits (§3.5), and nothing publishes it outside yet; §8.8 shows how to
  add the publisher.
- **Restaurant side:** `utils/audit.js › logAction(req, …)` writes
  `audit_logs` from the controller, best-effort, after the action. Restaurant
  postings write no `business_events` (§9.3, plan E, step 3 adds them);
  their live screens hear of changes from triggers on their tables (§3.5).
- **Notifications (the bell)** are *derived*, not stored. Each file in
  `backend/src/notifications/providers/` works out its alerts from live data
  when asked ([its README](../backend/src/notifications/README.md)). Only
  "who has read what" is stored (`notification_reads`). Business Admin has its
  own bell, `GET /api/businesses/:id/notifications`
  (`modules/business/core/services/businessNotifications.service.js`), also
  derived. Its read marks are kept in the browser
  (`apps/business-web/src/services/businessNotifications.js`, passed to
  `NotificationBell` as `feed`).

### 3.5 Live updates

A screen that shows what other devices change keeps itself current without
asking the server every few seconds. A KOT sent from the POS reaches the
kitchen display, a guest's QR call reaches table requests and the captain
app, food marked ready reaches the captain's phone, an online order reaches
the deliveries board, a paid bill frees the table on the floor and at the POS,
a token called at a clinic moves its token queue, a sample received or a
result approved moves the lab's worklists and reaches the doctor's
consultation: each within about a second.

```
 POS (any device)              PostgreSQL                         each API process (modules/live)   other screens
 POST /api/orders ─► service   INSERT orders, order_items, kots
                               trigger: pg_notify('live_change',
                                 {"restaurant":12,"outlet":3,
                                  "area":"order","id":456})
                               COMMIT ─► every LISTEN connection ─► liveListener ─► liveHub
                                                                    clears restaurant 12's kept
                                                                    dashboard and bell answers
                                                                    event: change ─► its streams ─► GET /api/live (fetch)
                                                                                                    liveClient gathers a burst
                                                                                                    └─ the screen's own API call
```

- **The database announces every change.** Migration 1791974000000 puts a
  trigger on every table a live screen reads: the restaurant's orders and
  their dishes, KOTs and their lines, change slips, table requests, tables,
  bills with their payments and refunds, reservations and the tables they
  hold, the waitlist, sold-out marks, time-clock punches and attendance,
  pre-orders and business days; the shared core's outbox (`business_events`);
  and the business tables live screens read that write no event of their own
  (tokens, appointments, salon walk-ins, tasks and issues, jewellery rate
  sheets). Migration 1791976000000 adds the lab's orders, samples and results,
  a sample or a result announced as its order, at the order's location. Each
  calls `pg_notify`, which PostgreSQL delivers only when the transaction
  commits, in commit order. A change that rolls back (or a
  savepoint rolled back) is never announced, an update that changes nothing is
  skipped, and identical notifications of one transaction (ten dishes on one
  order) reach the listeners once.
- **A notification says where and what, never the data**: the restaurant
  (and outlet) or the business (and location), the area, and the row's id. A
  dish is announced as its order, a payment as its bill, a KOT's line as its
  KOT; a business that is a restaurant's own (its tasks) as that restaurant.
  The screen reads again through its normal API call, which checks what the
  person may see. A second channel, `live_session`, announces what may end a
  stream: a login's token version, status, restaurant, outlet or must-change
  mark, a restaurant's or business's status, a membership or role switched off.
- **Each API process listens on one connection of its own**
  (`services/liveListener.js`, shown as "live updates" in
  `pg_stat_activity`), never a pool client: LISTEN belongs to its session. It
  reconnects after a drop (after 1, 2, 5, 10 and then every 30 seconds), finds
  a drop the socket missed by asking `SELECT 1` every 30 seconds, and on every
  connection has the open screens read again once, since what was announced
  meanwhile is lost. Several processes behind a load balancer work: each
  listens, and each passes every change on to its own streams.
- **The streams** (`services/liveHub.js`, `routes/live.routes.js`):
  `GET /api/live` for the signed-in person's restaurant and
  `GET /api/businesses/:id/live` for a business they are a member of
  ([API › Live updates](API.md#live-updates)). Server-sent events, which the
  staff app reads with `fetch`, so the token travels in the `Authorization`
  header as on every request and never in an address. Someone tied to an
  outlet or location hears only of theirs, and of what belongs to none. A
  comment goes out whenever a stream has been quiet for 20 seconds. Each stream
  is checked again every minute, and at once on a `live_session` signal, with
  the checks it opened with: it ends, saying why, when the session ends
  (signed out everywhere, a new password, the token run out, the login or its
  restaurant switched off) or the access does (the membership, role or
  business switched off). Limits: `LIVE_STREAMS_MAX` per process and
  `LIVE_STREAMS_PER_PERSON` per login in a process
  ([GO_LIVE §2](GO_LIVE.md#2-production-settings)). A stream whose client stops
  reading (64 KB waiting) is cut off, and one that closes is forgotten at once.
  On SIGTERM or Ctrl+C the process tells every stream it is restarting and
  closes it, then its listening connection and the pool (`server.js`).
- **Every restaurant change also clears that restaurant's kept dashboard and
  bell answers in every process** (`utils/dashboardCache.js`,
  `notifications/index.js`), so a screen reading again never gets an answer
  from before the change, whichever process made it.
- **The staff app** keeps one stream per restaurant or business in a tab,
  shared by the bell and the page (`services/liveClient.js`, wired in
  `services/live.js`). It reconnects after 1, 2, 4, 8, 16 and then 30 seconds
  (±25%), has every screen read once after each (re)connection, treats a stream
  silent for 70 seconds as dropped, and gathers a burst: a screen reads once
  for the changes of 250 ms, at most once a second (the dashboard every ten
  seconds, the bell every twenty), never twice at once, and nothing while its
  tab is hidden. A screen uses `hooks/useLiveRefresh.js` with the areas it
  shows; its old timer stays as a safety net of a minute (the POS's every two),
  never the main path, and a screen that had none (the salon's calendar, the
  dashboard's pre-orders card) has none now, nor does a screen whose every
  read is logged as a look at clinical data (a visit, a lab order).
  `components/LiveIndicator.jsx` (or the screen's own Live control) says Live,
  Connecting, Reconnecting or Not live. Signing out, or another person taking
  over the till, closes the streams at once.

**Why triggers, not a restaurant outbox.** The restaurant's postings write no
events (§9.3, plan E, step 3), and the paths that change what its live screens
show are many: orders, KOTs, table moves, bills, payments, refunds, the QR and
online pages, the kitchen's own taps. Writing an event in each of their
transactions would have touched every one of them, and a path that forgot
would leave a screen stale. A trigger on each table a screen reads announces
every committed change whichever code wrote it, needs no worker, and costs one
`pg_notify` per row changed. The shared core already writes an event in every
posting's transaction, so a trigger on `business_events` announces those. The
events stay what §8.8 says, the outbox for outside messages (WhatsApp, SMS,
webhooks), which need provider accounts and come later through a publisher.

**The guests' site keeps asking** (a table's QR page every 6 or 20 seconds, an
online order's status every 8 or 20, a booking request every 20): a guest has
no session to scope a stream by. A table's QR code is printed on the table and
shared by everyone at it, and an order's or booking's link is its only key; a
stream held open for every guest's phone, with no login to count it against,
is a change of its own ([BACKLOG §5](BACKLOG.md#5-live-updates-and-the-outbox)).

---

## 4. The database

One PostgreSQL database holds both engines. `DB_NAME` in `backend/.env`
names it (`business_platform_db` in `.env.example`). The SQL files in
`backend/migrations/` are the only definition of its schema (§8.5). Every
table, column, constraint and trigger: [DATABASE.md](DATABASE.md). Why the
business layers are shaped as they are:
[BUSINESS_PLATFORM_DATA_MODEL.md](BUSINESS_PLATFORM_DATA_MODEL.md).

### 4.1 The business platform in five layers

The business platform, which every type but the restaurant runs on, stacks
five layers of tables. The **platform** holds what all businesses share: the
module and permission catalogues and the role templates (later the plans and
subscriptions). **Identity and access** links users to businesses through
memberships and business roles. The **business** (tenant) layer holds each
business with its settings, tax rates, number series, switched-on modules
(capabilities), locations, payment methods and departments. The **shared
core** holds the catalogue, contacts, price rules, documents and payments,
receivables, stock, appointments, expenses, cash checks and cashier shifts.
**Type extensions** are `<type>_*` tables (`retail_*`, `wholesale_*`,
`salon_*`, `pharmacy_*` …) that hang off core rows. Tasks, issues and
projects sit beside the layers (§4.3), and `business_audit` and the
`business_events` outbox cut across all of them. The diagram is in
[DATA_MODEL › The five layers](BUSINESS_PLATFORM_DATA_MODEL.md#the-five-layers),
and the rules the database enforces on these tables are in
[DATA_MODEL › Rules every table follows](BUSINESS_PLATFORM_DATA_MODEL.md#rules-every-table-follows).

### 4.2 The restaurant module's own tables and the bridge

The restaurant runs on its own tables, all scoped by `restaurant_id` (and
`outlet_id` where a branch matters). The main groups are below; the full list
is in [DATABASE › Restaurant module](DATABASE.md#restaurant-module).

| Area | Tables |
| --- | --- |
| Tenant and access | `restaurants`, `outlets`, `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `approvals`, `user_sign_ins`, two-step tables, `audit_logs`, `notification_reads` |
| Settings | `restaurant_settings`, `business_hours`, `floor_settings`, `service_settings`, `document_counters`, `till_discount_limits` |
| Menu | `categories`, `products`, `product_variants`, `modifiers`, `product_recipes`, `modifier_recipes`, `tax_rates`, `combo_items`, `price_windows`, `product_selling_rules`, `menu_sold_out`, `restaurant_brands` |
| Floor | `floors`, `dining_areas`, `dining_tables`, `captain_assignments` |
| Orders and kitchen | `orders`, `order_items`, `order_item_modifiers`, counters, `kots`, `kot_items`, `kot_change_slips`, `kitchen_stations`, `table_requests`, `restaurant_preorders` (+ items) |
| Reservations and online | `reservations`, `waitlist_entries`, `online_booking_settings`, `online_ordering_links`, `sales_channels`, `customer_addresses` |
| Money | `business_days`, `cash_drawers`, `cash_movements`, `bills`, `bill_items`, `bill_taxes`, `payments`, `payment_types`, `refunds`, `credit_notes`, `customer_accounts`, `customer_advances`, `rider_settlements`, `discounts` |
| Guests | `customers`, `loyalty_transactions`, `feedback`, `complaints` |
| Stock and purchasing | `suppliers`, `units`, `inventory_items`, `stock_transactions`, `stock_balances`, `inventory_batches` (+ balances, movements), `stock_counts`, `stock_transfers`, `stock_indents`, `production_batches`, `dish_waste_entries`, `purchase_orders`, `goods_receipts`, `purchase_returns`, `supplier_payments` |
| Expenses, staff, pay | `expenses`, `document_attachments`, `employees`, `shifts`, `attendance`, `timeclock_settings`, `payroll_*`, `tip_*`, `logbook_entries` |

These overlap with the shared core: the restaurant has its own `customers`,
`suppliers`, `units`, `tax_rates`, `products` and stock ledger. §5 and plan E
(§9.3) describe how they converge.

**The bridge.** A restaurant appears on the platform as one `businesses` row
of type `restaurant`, whose `legacy_restaurant_id` points at `restaurants.id`
(unique). *Link my restaurant* (`POST /api/businesses/link-restaurant`, for a
restaurant admin) creates that row, gives the admin who presses it an Owner
membership and switches on the `restaurant` capability. `restaurant_business_id()` creates the row,
without a membership, the first time a feature switch or a task needs it. The
restaurant tables keep their own names and keys.

**Restaurant feature switches.** A restaurant's optional parts (reservations,
deliveries, loyalty, tips…) are modules of the same platform catalogue. Each
switch is a `business_capabilities` row of the restaurant's business, so the
platform's triggers enforce dependencies, and a later plan can set the
switches like any other module. Which switches exist, their groups and their
defaults: [DATA_MODEL › Restaurant features](BUSINESS_PLATFORM_DATA_MODEL.md#restaurant-features).
In the code:

- **Server.** `restaurant_features(restaurant_id)` is read into
  `req.user.features` with the profile. `middlewares/requireFeature.js`
  refuses a switched-off feature's routes with 403 `reason: "feature_off"`.
  Controllers refuse the mixed cases (a delivery order, a tip, paying from an
  advance, a coupon, points, picking a guest); the pre-order service refuses
  a pre-order's advance while `advances` is off. The public QR, booking and
  online pages check the restaurant's features. Notification providers and
  the live dashboard's blocks name a `feature` and are skipped while it is
  off. `modules/restaurant/setup/services/restaurantFeatures.service.js`
  refuses to switch off a feature that would strand money, warns about
  hidden data and writes the activity log. Business Admin's Settings ›
  Business tools card (called Restaurant features for a restaurant business)
  goes through the same service.
- **Screens.** Settings › Features
  (`modules/restaurant/setup/pages/FeaturesPage.jsx`, `/restaurant/features`);
  `useAuth().hasFeature(code)`; nav links and `ProtectedRoute` take `feature`
  / `featureAny`, and a switched-off page says so instead of opening.

**Food formats and brands.**

- A café, a bakery and a cloud kitchen are the restaurant type on the same
  tables, not new business types. `restaurants.format` says which
  (`restaurant`, `cafe`, `bakery`, `cloud_kitchen`).
- The format is chosen when the restaurant is created (Platform ›
  Restaurants) and changed on Settings › Features
  (`modules/restaurant/setup/services/restaurantFormat.service.js`). It sets
  how the POS opens (`service_settings.pos_order_types`,
  `default_order_type`, tokens) and switches features through the same rules
  as above. The owner can change each of these afterwards.
- Pre-orders are `restaurant_preorders` (+ items), module
  `restaurant/preorders`. The advance is an ordinary customer advance, and
  collection bills a takeaway order against it. Selling by weight is
  `products.sold_by`. The day-end unsold count is the waste reason `unsold`
  in `stock_transactions`.
- Brands let one kitchen sell under several names: `restaurant_brands`, a
  category for one brand or for all (`categories.brand_id`), and the brand on
  each order (`orders.brand_id`), printed on its KOTs and bill and added up in
  the brand report.

### 4.3 Tasks, issues & projects: one model for both worlds

Module `modules/tasks/`, on the backend and in the staff app. It serves every
business type, the restaurant included, so it already has the shape the rest
of the code is moving towards (§9.2):

- **Data keyed on `business_id` only.** A restaurant reaches it through its
  business row (`restaurant_business_id()`); the other types through their
  memberships. It has no table keyed on `restaurant_id`. Only "where" and
  "who" differ: `outlet_id`, the restaurant's `employee_id` and `role_id`,
  against `location_id`, `resource_id` and `business_role_id`. The trigger
  `business_task_world_check` makes the database refuse a pointer outside the
  business, as the composite keys do on the business side. When plans D and E
  move the restaurant onto memberships and locations, those columns retire
  and nothing else changes.
- **Two front doors, one service layer.** `/api/tasks` (restaurant:
  `authenticate`, the restaurant's features and permissions) and
  `/api/businesses/:id/tasks` (membership → capability → permission) build the
  same `scope` (`services/scope.js`) and call the same services. The staff app
  does the same: `TasksProvider` picks the API base, and the screens are
  shared (`/tasks/*` in `App.jsx`, `tasks/*` in `BusinessAdminRoutes.jsx`).
- **Switches and permissions in both catalogues.** Modules `tasks`, `issues`
  and `projects`: the restaurant's feature group "Operations", on by default
  for a restaurant. The other types start with them off and switch them on in
  Settings › Business tools, where some trades see them recommended. The same
  permission codes (`tasks.*`, `issues.*`, `projects.*`) are in
  `business_permissions` and in the restaurant's `permissions` table.
- **The template library is code** (`modules/tasks/library/`: checklists for
  each business type, and project plans), versioned with the app. A
  business's own templates are rows.
- **Recurring tasks without a daemon.** Occurrences are made when read,
  idempotently (an advisory lock per business, and a unique index on
  schedule, day and slot). A sweep marks as missed what closed undone.
- **Outbox.** `task.assigned`, `issue.reported` and `issue.assigned` go to
  `business_events` in the same transaction, ready for a WhatsApp publisher.
- **The log book stays** the restaurant's shift diary. An entry that needs
  work becomes an issue (`business_issues.source_logbook_entry_id`), not a
  copy.

### 4.4 How a sale moves money and stock

**Restaurant (dine-in):**

```
 POS / captain / QR  ──► orders + order_items (+ modifiers)       order.service / order.repository
                          │ KOT sent
                          ▼
                         kots + kot_items → kitchen display        kitchen.repository
                          │ guest asks for the bill
                          ▼
 bill.repository (one transaction):
   number from document_counters (series per prefix, yearly reset optional)
   bills + bill_items + bill_taxes (snapshot: GST per rate, service and delivery charge shares, round-off)
   loyalty points redeemed (loyalty_transactions), coupon / till discount
   if consume_stock: each line's recipe → stock_transactions 'consumption'
                     (reference_type 'bill', from the bill's outlet store, batches first-to-expire)
   COMMIT
                          │ payment(s)
                          ▼
 payments (cash/card/upi/…; tip_amount kept apart; advance payments use a customer_advance)
   bill_status unpaid → partial → paid; points earned once the money is in
   cash goes to the open business_day and, with cash drawers on, the drawer
 Afterwards: void / refund / credit note put back exactly the stock the bill took
 (bills.consume_stock remembers whether it took any).
 Activity log: logAction from bill.controller.
```

**Shared core (any other type, for example a kirana sale):**

```
 POST /api/businesses/:id/documents { kind: 'sale', requestKey, locationId, contactId?, lines, payment? or payments? }
   context(['sales.create','purchasing.create'])  membership + module + permission
   business.service.document → repo.transaction → postDocument:
     lock the business row (one lock order for every posting: business → document → lots)
     request_key seen?  same hash → return the first result; different → 409
     settings (tax_mode, rounding), location, contact (locked)
     a kit line becomes its components, the kit's price split over them (businessKits.service.js)
     price each line on the server: list or branch price, member price → customer / slab price
       (businessPricing.js) → offers and points (businessOffers.js)
       → salon packages / memberships (businessSalonSales.js)
     pack units converted exactly to stock units
     number from business_number_series (businessNumbering.nextNumber, per location + kind + fiscal year)
     business_documents + business_document_lines (snapshots of name, unit, price, rate)
     lots picked (oldest expiry first; serial / batch named) → business_stock_lots updated
       + business_stock_movements (one source: this document)
     optional payments (one or several, each by a payment method) → business_payments;
       customer credit-limit check
     business_audit + business_events 'sale.posted' (+ 'payment.recorded', 'loyalty.earned' …)
   COMMIT
```

Returns, refunds and exchanges go through `businessReturns.service.js`
(`postReturn`, inside the caller's transaction). A wholesale dispatch, a
repair delivery and a salon bill all post a normal sale through
`postDocument`, so numbering, stock, the credit limit, events and audit are
always the core's.

### 4.5 GST rates by date: a change that takes effect with no job runner

Module `modules/tax-changes/`, on the backend and in the staff app. GST
rates change once a year, announced ahead and in force from 1 April, so a
change is entered ahead and must take effect on the business's own date,
while every bill dated before keeps its rate. It serves both engines the way
tasks do (§4.3):

- **Data keyed on `business_id` only.** `business_tax_changes` and
  `business_tax_change_items`; a restaurant reaches them through its business
  row (`restaurant_business_id()`). Only what moves differs: a catalogue item
  (`sku_id`, to one of the business's `business_tax_rates`) or a dish
  (`product_id`, to one of the restaurant's `tax_rates`). The trigger
  `business_tax_change_world` refuses a pointer outside the business.
- **Two front doors, one service layer.** `/api/businesses/:id/tax-changes`
  (membership → `catalog.view` / `catalog.edit`) and `/api/menu/tax-changes`
  (`menu.view` / `menu.manage`) call `services/taxChanges.service.js` with a
  small adapter each (`taxChangesShop.js`, `taxChangesMenu.js`), which says
  what an item is, which rates it may take, its business's date and lock, and
  where its audit goes. The arithmetic and the dates are pure
  (`taxChangesMoney.js`). The staff app shares its screens the same way
  (`modules/tax-changes/pages/`, under *Products & services* and *Menu*).

**How a change takes effect.** Every reader keeps reading the rate from the
item (`catalog_skus.tax_rate`, `products.tax_percentage`), as it always has.
Due changes are written onto the items, lazily, by the database, before
anything reads them:

- `business_tax_change_apply(business)` applies, in date order, every
  scheduled item whose date has come on the business's clock, under the
  business row's lock (the lock every posting takes first, so a bill sees
  all of a change or none of it). The server calls it as a request opens a
  business (`businessAccess.open` from each router's `context()`; the
  statement that loads the membership also says whether anything is due, so
  a request with nothing due costs one `EXISTS`), and again inside
  `postDocument`, under that lock.
- `business_tax_change_apply_menu(restaurant, day)` does the same for dishes,
  for the restaurant's trading date (`restaurant_trading_date()`: the main
  counter's open business day, else its date less the morning cut-off),
  under the menu's advisory lock. The menu router calls it before every menu
  screen (the POS reads its menu there), the guests' menus (a table's QR
  menu and online ordering, both `menuFor`) and a pre-order's prices call it
  before they read a dish, and `priceLines` calls it for the
  order's own business day before it prices dishes, the one place a dish's
  rate becomes an order line's (bills price from order lines).

An item moves in a savepoint of its own: it takes the new rate (and, when the
change keeps the price before GST, the price that keeps it, to the paisa as
the preview works it out), its item row keeps what it was and became, and the
activity log gets a row in the name of whoever entered the change. One the
database refuses is kept as refused, with the sentence; the others move.

**Midnight.** A request can meet a change halfway only at the moment its
date comes. A shop's posting whose fixed prices a type's service worked out
at the day before's rate, or that began before another request applied a
change for the day after its own date, is refused (409 `gst_rates_changed`)
and sent again, rather than billed at the other day's rate. A restaurant
outlet still on last night's business day while another has opened today's
prices its dishes as they were before the change (`forOrderDay` lays the
item rows' `from_*` values over the dish).

**Why this way.** Resolving the rate by date in every query would have
changed every reader in every business type, the restaurant's billing
included, and kept a second source of the rate beside the item. Writing the
change onto the item keeps one place to read, needs no job runner, and
leaves posted documents as they are: their lines already keep the rate they
were posted at. `backend/tests/taxChangeReaders.test.js` lists every file
that reads an item's rate with how it gets the rate of the day, and fails
when a new one is not listed.

### 4.6 Personal data: one model for both engines

Module `modules/personal-data/`, on the backend and in the staff app, with
the guests' site's notice (`apps/customer-web/src/modules/privacy/`). Under
the DPDP Act 2023 and the DPDP Rules 2025 a shop is the data fiduciary for
the people it serves, and the platform, which holds their data for it, is
likely its processor ([GO_LIVE.md › Personal data](GO_LIVE.md#personal-data)).
It serves both engines the way tasks and GST rate changes do (§4.3, §4.5):

- **Data keyed on `business_id` only.** `business_privacy_notices`,
  `business_consents` (the clinic's consents, renamed and widened),
  `business_children`, `business_privacy_requests` and the breach register;
  a restaurant reaches them through its business row
  (`restaurant_business_id()`, made when first needed). A person is a
  shop's customer contact (`contact_id`) or a restaurant's guest
  (`customer_id`), never both, and the database refuses another business's
  person (`business_privacy_person`).
- **Two front doors, one service layer.** `/api/businesses/:id/privacy/…`
  and `/api/privacy/…` call `services/personalData.service.js` (the notice,
  consents, a child's mark) and `services/privacyRegister.service.js`
  (requests, the access export, erasure, breaches) with a world each
  (`personalDataShop.js`, `personalDataRestaurant.js`): who a person is, how
  one is found, exported and erased, the business's lock and date, the
  permission checks, and where audit rows go (`business_audit`, or the
  restaurant's `audit_logs`). The staff app shares its screens the same way
  (`modules/personal-data/pages/`, *Settings › Personal data* in both).

**Consent where a customer is taken, checked where a message goes.**
`services/consents.js` is what every module uses inside its own transaction:
`apply` records or withdraws the consents ticked with a new or edited
customer (the contacts, the guest book and each type's own intake), and
`requireReminder` refuses a reminder on WhatsApp, by SMS or a call to
someone who has not agreed to reminders (409 `consent_required`). In the
staff app every message button goes through `useConsentGate`: with the
person's consent it sends; without it, it asks them and records their yes in
one tap, on the notice's own line for that purpose. What everyone on a
screen has agreed to is read once (`consentStore.js`, one request for a whole
list). A message about what the person asked for (their order is ready,
their booking is confirmed) is not gated. The guest book's
`customers.marketing_opt_in` is a copy the database keeps of a guest's
consent to offers, so its lists and counts read it as before; a trigger
refuses any other write.

**Erasure that keeps the books.** `personalDataRegistry.js` places every
table that points at a customer contact: what the access export shows, what
an erasure blanks, and what it keeps and why (bills and other tax records,
the activity log, the consents and the request). The integration test reads
the database's own list of foreign keys and fails on a table the registry
does not name, so a module added later is placed on purpose. Records whose
guards keep them as they were once closed (a job card, a booking, a stay)
let through exactly the erasure's change (`business_privacy_erasing`, whose
columns match the registry's). A restaurant's guest is erased by the guest
book's own erasure, which the requests register records.

**Dates on the business's clock.** A request is received on the business's
own day (`business_privacy_today`: a restaurant's time zone, or the
business's) and due 90 days later; a breach's 72 hours run from the moment it
was found. The bell (`businessNotifications.service.js` and
`notifications/providers/privacy.js`) shows requests nearing their day, a
Board report still to record, and a notice not yet published. Nothing is
filed from here: the business tells the Board and records when.

### 4.7 An owner's GST thresholds: one PAN across both engines

Module `modules/gst-thresholds/`, on the backend and in the staff app. What
applies to a taxpayer's invoices follows its aggregate turnover, which the
researchers read as counting every GSTIN under one PAN: several businesses
of one owner, on both engines, can cross a figure together. The module adds
them up; it stores no turnover.

- **Read from each business's own records, on its own clock.** A shop's sale
  documents less its sale returns, before GST, by posting date in its time
  zone (as Reports count them); a restaurant's bills less its credit notes,
  by business day (as the GST pack counts them), reached through its business
  row. A business's own date is `business_tax_change_today`. Each engine's
  readers stay where they are: `services/gstTurnover.js` only reads their
  tables, as a report does.
- **A PAN group is one owner login's businesses under one PAN.** A
  business's PAN is read from its GSTINs (its own and its locations', a
  restaurant's and its outlets'), else the one its owner recorded
  (`business_gst_pans`); a PAN is never guessed. Groups are per owner, never
  across the platform: a GSTIN is typed, not checked with the GST portal, so
  adding up every business under a PAN would show one owner's turnover to
  anyone who typed their GSTIN. A business's bell takes the most serious of
  its owners' groups.
- **The figures are data.** `platform_gst_thresholds` holds each figure, how
  it is measured, the date it applies from and its source; `stepsOn` in the
  pure `services/gstThresholdsRules.js` takes the ones in force on the day
  and groups them by turnover, and `standing` says below, near (the owner's
  warning level, `owner_gst_settings`) or crossed: by the whole of last year
  (its rules apply now) or by this year so far (they apply from the next
  1 April), since a figure applies for a year when the year before passed
  it. The platform changes a figure by migration; no code holds one.
- **Three doors, two bells.** The owner's view (`/api/businesses/gst-thresholds`,
  no business in the address, each answer the person's own), one business
  (its recorded PAN, its HSN / SAC codes to fix) and the restaurant's codes
  to fix (`/api/gst-thresholds`). The business bell
  (`businessNotifications.service.js`) and the restaurant's
  (`notifications/providers/gstThresholds.js`) take their lines from the same
  service: for whoever may see the business's money, the PAN masked for all
  but its owners, the sums only for someone who may see every business's
  money in the group. Nothing files or makes an e-invoice.
- **The bells' standing is kept five minutes.** A business's standing (its
  owners' groups, their sums and steps) is the same for whoever asks, and
  each reading sums two financial years of every business under the PAN,
  while the bells ask every 20 to 60 seconds on every screen; so
  `services/standingCache.js` keeps it per business in the API process for
  five minutes, two asking at once sharing one reading, and the service
  shapes it for each person (the PAN, the sums, the link) on every call.
  Recording or clearing a PAN and saving a warning level throw it all away
  (in the process that made the change); a sale shows within the five
  minutes. It follows the bell's switch (`utils/keptAnswers.js`,
  `NOTIFICATIONS_CACHE`; off in tests unless asked for). The owner's view
  is not kept: it adds up afresh.

---

## 5. Two engines, one direction

The food engine (restaurant, café, bakery, cloud kitchen) and the shop and
clinic engine (every other type) keep their own tables and their own code
style. This section says where they differ, who owns what, and the rules
until they meet.

### 5.1 Where they differ

| Area | How | Why it matters |
| --- | --- | --- |
| **Two data worlds** | The restaurant lives on its own `restaurant_id` tables, with its own customers, suppliers, units, tax rates, products, stock ledger, bills and numbering. Every other type lives on the shared core. The bridges are `businesses.legacy_restaurant_id`, the restaurant's feature switches as `business_capabilities` (§4.2), and the tasks module, which both worlds share (§4.3). | Cross-type features (one customer across businesses, platform reports, the event outbox, plans) work for the core but not for the restaurant. |
| **Two identity and permission systems** | One `users` table. Restaurant access is `users.restaurant_id` + `user_roles` + `roles` + `permissions`; business access is `business_memberships` + `business_roles` + `business_permissions`. A restaurant user reaches Business Admin only through a membership. One-time manager approval tokens, outlet pinning and two-step sign-in roles exist only in the restaurant system. The business side has its own forms: a manager's PIN given with the request (`businessManagerPin.js`), the shared till's per-staff PIN, and a person tied to one location (`business_memberships.location_id`). Both use the same personal PIN. | Two role editors, two places to switch someone off, two meanings of "Manager". |
| **Two styles of backend code** | Restaurant: route → controller → service → repository; transactions opened by hand; audit after the action; few request keys (production batches have them). Business: route handler → service → one shared repository (`business.repository.js`, with `transaction`, `audit` and `event`); request keys everywhere; audit and events inside the transaction. | A new developer must learn both. |

### 5.2 Who owns what

One module writes each kind of record. The others call its service.

| Record | Food engine owner | Shop and clinic engine owner |
| --- | --- | --- |
| Menu / catalogue | `restaurant/menu` (categories, products, brands) | `business/core` catalogue (products, SKUs, units) |
| Orders and kitchen tickets | `restaurant/orders`, `restaurant/kitchen`, `restaurant/preorders` | n/a |
| Bills and payments | `restaurant/billing` | `business/core` counter and documents |
| Stock | `restaurant/inventory` | `business/core` stock (lots and batches) |
| Purchases and suppliers | `restaurant/purchasing` | `business/core` purchases and payables |
| Customers | `restaurant/crm` | `business/core` contacts |
| Patients, visits, lab | n/a | `business/health` |
| Logins, PINs, two-step sign-in | `access` (both) | `access` (both) |
| Roles and permissions | `access` (restaurant roles) | `business/core` (`businessAccess.service`: memberships and roles) |
| Businesses and their switched-on modules | `platform` console; `restaurant/setup` (features) | `platform` console and `business/core` (`businessOnboarding`, `businessSetup`); both write `business_capabilities` |

An industry folder adds its own rules (salon commissions, pharmacy batches,
wholesale routes) and calls the core for stock, bills and payments. It never
keeps a stock or bill table of its own.

### 5.3 Until they converge

The two engines come together through two plans (§9.3):

- **Plan D:** one identity and role system per business.
- **Plan E:** the restaurant on the shared core, with `restaurant_*`
  extension tables.

Each is its own tested step, never mixed with a folder move. Until then:

- anything new that both engines need is built once, in a module of its own
  (as `tasks/` is), in `platform/`, `access/` or `packages/`, and used by
  both;
- nothing new copies one engine's tables into the other.

---

## 6. Code map

### 6.1 Repository layout

The code is grouped **by module** on both sides. A module is one folder that
holds everything for one area: on the backend its `routes/`, `controllers/`,
`services/` and `repositories/`; in the staff app its `pages/`, `services/`
and `styles/`. Only code that several modules share stays outside
`modules/`. The web side is two apps and two shared packages in npm
workspaces; the backend has its own install.

```
<repo>/
├── README.md                 what it is, set-up, commands, project rules, the index of the docs
├── .github/workflows/checks.yml   CI: backend unit + integration tests; lint, the apps' and packages' Node tests, both builds
├── package.json              npm workspaces (apps/*, packages/*) and the commands for everything
├── .oxlintrc.json            one lint configuration for apps/, packages/, tools/ and e2e/
├── tools/dev.mjs             npm run dev: the API, the staff app and the guests' site together
├── e2e/                      the browser tests' harness: playwright.config.mjs (both apps' specs, and
│                             their web servers on the test ports of servers.mjs), global-setup.mjs
│                             (a database and an API per run), build-data.mjs and test-data.mjs (the
│                             run's data), fixture.mjs (what the specs import)
├── docs/                     the documentation
├── backend/
│   ├── src/
│   │   ├── app.js            Express app: global middleware, /uploads, /api, 404, error handler
│   │   ├── server.js         checks the database and that every migration is applied, then listens;
│   │   │                     a port already in use stops it with a clear message
│   │   ├── routes/index.js   mounts every module's router under /api (the only file in routes/)
│   │   ├── modules/          one folder per module, each with routes/ controllers/ services/ repositories/
│   │   │   ├── access/       sign-in, users, roles, two-step, approvals, the activity log
│   │   │   ├── platform/     the platform console (mounted at /api/users/platform)
│   │   │   ├── health/       /api/health, /api/db-health
│   │   │   ├── restaurant/   setup, menu, tables, orders, kitchen, reservations, online, preorders,
│   │   │   │                 deliveries, billing, business-day, crm, inventory, purchasing, expenses, staff,
│   │   │   │                 reports, logbook, notifications, imports
│   │   │   ├── business/     core (directory, catalogue, documents, stock, appointments, payment
│   │   │   │                 methods, expenses, shifts, the counter), retail, wholesale (+ receivables),
│   │   │   │                 fashion-electronics, salon-weight, health, quotations and licences (every
│   │   │   │                 type but the restaurant), hardware, agri, optical, garage, memberships,
│   │   │   │                 laundry, jewellery, rentals, fuel, lodging
│   │   │   ├── tax-changes/  GST rates by date for every business: a shop's items and a restaurant's dishes
│   │   │   ├── live/         live updates for every business: the LISTEN connection and the screens' streams
│   │   │   ├── personal-data/  personal data for every business: the privacy notice, consents, requests, breaches
│   │   │   ├── gst-thresholds/  an owner's GST thresholds: turnover under one PAN across their businesses, the warnings
│   │   │   └── tasks/        tasks, issues & projects for every business (+ library/ of built-in templates)
│   │   ├── config/           env.js (reads and checks .env), database.js (pg pool + DB_POOL_GUARD)
│   │   ├── middlewares/      authenticate, authorize, authorizeOrApprove, resolveOutlet, requireFeature,
│   │   │                     reportOutlet, writeoffApproval, rateLimiters, upload, notFound, errorHandler
│   │   ├── notifications/    the bell: index.js + one provider file per module
│   │   └── utils/            AppError, validate, money, audit, docNumber, gstin, phone, totp, calendarDate …
│   ├── migrations/           node-pg-migrate SQL files (the only definition of the schema)
│   ├── scripts/              migrate, first login, backup
│   ├── tests/                *.test.js unit tests; integration/ (each file builds its own database)
│   ├── uploads/              public images (menu and product photos), unless UPLOADS_DIR names
│   │                         another folder: user data, not source
│   ├── private_uploads/      bills attached to expenses and purchases, prescription scans, task
│   │                         files, unless PRIVATE_UPLOADS_DIR names another folder: user data,
│   │                         never public
│   └── .local/               backups and other machine-local files: never copied or committed
├── apps/
│   ├── business-web/         the staff app (React + Vite, :5173)
│   │   ├── src/
│   │   │   ├── main.jsx      the shared look (@bmp/ui/styles.css); providers: QueryClient, Router, AuthProvider;
│   │   │   │                 ApprovalDialog, ConfirmHost, Toaster
│   │   │   ├── App.jsx       every restaurant route (lazy imports from modules/) + /business-admin; the clinic
│   │   │   │                 and lab workspaces (/clinic/*, /lab/*); the captain app (/captain/*); old guest
│   │   │   │                 links → GuestSiteRedirect
│   │   │   ├── modules/      one folder per module, each with pages/ (+ services/, styles/ where it has its own)
│   │   │   │   ├── access/   sign-in, profile, users, roles, two-step
│   │   │   │   ├── platform/ the platform console
│   │   │   │   ├── restaurant/  the same areas as the backend (except imports/), plus dashboard/
│   │   │   │   ├── business/ core/ (Business Admin, BusinessAdminRoutes.jsx, hooks.js, ui.jsx) and one
│   │   │   │   │             folder per type: retail, wholesale, receivables, fashion, electronics, salon,
│   │   │   │   │             weight, health, hardware, agri, optical, garage, memberships, laundry,
│   │   │   │   │             jewellery, rentals, fuel, lodging; and
│   │   │   │   │             quotations and licences (every type but the restaurant)
│   │   │   │   ├── tax-changes/  the GST rate change screens, shared by the restaurant (/menu/tax-changes)
│   │   │   │   │             and Business Admin (…/tax-changes)
│   │   │   │   ├── personal-data/  the personal data screens, shared by the restaurant (/privacy) and Business
│   │   │   │   │             Admin (…/privacy); the consent choices, the ask before a message, the line bills print
│   │   │   │   ├── gst-thresholds/  the owner's GST thresholds (/business-admin/gst-thresholds), its card on Your
│   │   │   │   │             businesses, the codes to fix on a catalogue and on the restaurant's Tax rates
│   │   │   │   └── tasks/    the task screens, shared by the restaurant (/tasks) and Business Admin (…/tasks)
│   │   │   ├── workspaces/   what one role works in, a layout and screens gathered from the modules:
│   │   │   │                 captain/ (the captain app: its layout, tables, calls, food at the pass, the POS's
│   │   │   │                 order screen in its phone layout; its floor rules in captainFloor.js);
│   │   │   │                 clinic/ (the clinic workspace: its layout, the desk, the consultation with the
│   │   │   │                 patient's history; its desk rules in clinicDesk.js); lab/ (the lab workspace:
│   │   │   │                 its layout, collection, worklist, approval, released reports; its bench rules
│   │   │   │                 in labBench.js)
│   │   │   ├── layouts/      AppLayout.jsx (header, switchers, bell, side menu), BusinessWorkspace and
│   │   │   │                 WorkspaceStart (a clinic's workspace: its frame, and the clinic it opens),
│   │   │   │                 NotFoundPage, PlannedPage, GuestSiteRedirect
│   │   │   ├── context/      AuthProvider (user, permissions, features), BusinessProvider (open business)
│   │   │   ├── hooks/        useAuth, useBusiness, useLiveRefresh (live updates), useLiveChange (a figure's
│   │   │   │                 motion), useServerNow (the server's clock), useQueryFilter, motion hooks …
│   │   │   ├── routes/ProtectedRoute.jsx   login + permission + restaurant feature guard; someone whose
│   │   │   │                 password someone else set goes to the sign-in's Choose your own password step
│   │   │   ├── services/     shared: api.js, queryClient, live and liveClient (live updates), approval, features,
│   │   │   │                 csv, print, customerWeb, healthWorkspaces (the clinic a workspace opens),
│   │   │   │                 plannedWorkspaces, the menus (businessNav, businessWorkspace,
│   │   │   │                 restaurantWorkspace) …, and the API services shared code uses (auth,
│   │   │   │                 outlet, notification, business)
│   │   │   ├── components/   shared UI: DataGrid/, Modal, PageHeader, SectionCard, ActionMenu, motion.js …
│   │   │   └── styles/       sheets used by more than one module (data-grid.css, reservations.css …)
│   │   ├── tests/            *.test.js (Node); browser/ (Playwright)
│   │   └── public/
│   └── customer-web/         the guests' site (React + Vite, :5174)
│       ├── src/
│       │   ├── main.jsx      the shared look, Router (no sign-in, no staff providers)
│       │   ├── App.jsx       /order/:token, /online/:token/*, /book/*; planned /shop, /appointments,
│       │   │                 /account; any other address → StartPage
│       │   ├── modules/      table-order/ (pages/, services/); online-order/, booking/ (pages/, services/, styles/);
│       │   │                 privacy/ (the privacy notice and the consent ticks the guests' pages show)
│       │   ├── pages/        StartPage, PlannedPage
│       │   ├── plannedPages.js   what each planned guest page says
│       │   └── styles/       guest.css
│       └── tests/browser/    Playwright checks
└── packages/
    ├── ui/                   @bmp/ui: styles/ (base = tokens and elements, ui, motion, colour, components),
    │                         Icon, menu/ (ComboChoicePicker, AddonChoiceRules)
    └── shared/               @bmp/shared: format, dates, menu/ (comboChoices, addonChoices)
```

**Why the business types are grouped differently on the two sides.** On the
backend, two route files each serve two types, so the modules are
`fashion-electronics` and `salon-weight`, and receivables sit with wholesale
because they share `businessTrade.routes.js`. The staff app keeps one folder
per type: `fashion`, `electronics`, `salon`, `weight` and `receivables`.

### 6.2 Inside a backend module

```
restaurant/orders/
├── routes/        order.routes.js         URL + checks (authenticate, authorize, requireFeature)
├── controllers/   order.controller.js     read and validate the request, call the service, send JSON
├── services/      order.service.js        business rules, one transaction per change
└── repositories/  order.repository.js     SQL only, no decisions
```

- Each layer calls only the layer below it.
- **The two engines use different styles, and both are fine.**
  - The food engine uses all four layers.
  - The shop engine has no controllers. Each route calls its service, the
    service reads and checks the request, and both use the shared helpers in
    `business/core/repositories/business.repository.js` (`page`, `one`,
    `transaction`, `audit`, `event`).
  - New code follows the style of the folder it goes into. Existing files are
    not renamed just to match.
- Errors: `throw new AppError(409, "A clear sentence for the user")`.
- Every change a person makes to money or stock writes an audit row.

### 6.3 Inside a web app

**Where a file goes (staff app).** A file that only one module uses lives in
that module. An API service (`*.service.js`) lives in the module that owns its
API area, even when other modules call it (for example `restaurant.service.js`
in `restaurant/setup`). A helper, service or stylesheet that shared code
(components, layouts, context, hooks) or several modules use stays in
`src/services/` or `src/styles/`. Modules import from each other freely.
Shared code does not reach into a module, with two exceptions:
`context/AuthProvider.jsx` shows the log book's handover notice, and the
shared tab components (`components/ContentTabs.jsx`,
`components/WorkspaceTabs.jsx`) load Business Admin's
`modules/business/core/styles/workspace.css`.

**Code both apps use** goes in a package and is imported by name
(`import Icon from "@bmp/ui/Icon"`, `import { money } from "@bmp/shared/format"`):

- React components and styles go in `packages/ui`
  ([its README](../packages/ui/README.md)).
- Plain functions go in `packages/shared`
  ([its README](../packages/shared/README.md)).
- Code one app alone uses stays in that app. An app never imports another
  app's files.

**Two rules for the guests' site:**

- It never sends a staff token. Its pages use their own API clients, with no
  login.
- Its browser tests check this on every run.

**What a person sees.** The pages a business offers come from its
switched-on modules (a restaurant's features, read by `services/features.js`;
any other business's modules, read by `services/businessNav.js`) and from the
person's permissions. The backend checks both again. The captain app
(`workspaces/captain`) is built from `modules/restaurant/orders` with no copy:
its order screen is the POS page itself in its phone layout (`PosPage`'s
`captain` mode), its tables the POS's `TableGrid`, its calls Table requests'
own cards, its bill the POS's `BillModal`, and its table actions the
dashboard floor's `useFloorActions`. The planned offline POS app will reuse
them the same way. The clinic and lab workspaces (`workspaces/clinic`,
`workspaces/lab`) are built from `modules/business/health` alike: their other
screens are the health module's own pages, opened for the clinic in the
address (`BusinessProvider`'s `businessId`, with the workspace's addresses in
its `paths`); the desk is the Token queue's cards and dialogs on its
`useQueue`; the consultation is `VisitPage` itself beside the doctor's queue
and the patient's history; collection takes a sample's steps through the lab
order's `sampleStep`.

Adding a page, step by step:
[apps/business-web/README.md › Adding a page](../apps/business-web/README.md#adding-a-page).

### 6.4 Which files belong to which module

Backend names below drop the folder and the suffix: `bill.*` in the module
`restaurant/billing` means `backend/src/modules/restaurant/billing/` +
`routes/bill.routes.js`, `controllers/bill.controller.js`,
`services/bill.service.js` and `repositories/bill.repository.js`, where they
exist. Staff screens are in `apps/business-web/src/modules/<module>/pages/`;
the guests' pages are in `apps/customer-web/src/modules/<area>/pages/`.

**Restaurant** (scoped by `restaurant_id`; screens under `/`):

| Module (`modules/…`) | Backend | Frontend pages | Main tables |
| --- | --- | --- | --- |
| `restaurant/setup` | `restaurant.*`, `outlet.*`, `serviceSettings.*`, `paymentType.*`, `taxRate.*`, `restaurantFeatures.*`, `restaurantFormat` (the format and what it sets), `ruleSettings` (the restaurant's own alerts and timings) | profile and set-up checklist, settings (with alerts and timings), hours, outlets, features and the format, payment types, service settings | `restaurants`, `outlets`, `restaurant_settings`, `business_hours`, `service_settings`, `payment_types` |
| `access` | `auth.*`, `user.*`, `role.*`, `twoFactor.*`, `approval.*`, `audit` (repository), `activityLog`; its middlewares (`authenticate`, `authorize`, `authorizeOrApprove`) are in `src/middlewares` | `LoginPage` (with `ChoosePassword`, the step after a password someone else set), `ProfilePage`, users, roles, two-step | `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `approvals`, `user_sign_ins`, `audit_logs` |
| `restaurant/menu` | `menu.*`, `menuCard`, `menuCommon`, `menuExtras`, `menuImport`, `menuPriceRevision`, `menuServiceOptions`, `menuBulk`, `combo`, `addonGroups`, `priceWindow`, `sellingRules`, `recipe`, `recipeImport`, `availability`, `brand` (controller and service), `category` / `product` repositories | products, categories, modifiers, price windows, tax rates, recipes, brands | `categories`, `products`, `modifiers`, `product_recipes`, `combo_items`, `price_windows`, `tax_rates`, `restaurant_brands` |
| `restaurant/tables` | `table.*`, `captainSection.*` | floors, tables, captain plan, QR sheet | `floors`, `dining_tables`, `captain_assignments` |
| `restaurant/orders` | `order.*`, `tableRequest.*`, `public.routes`, `publicMenu`, `tradingClock` (when today's trading day began, for the live screens) | POS (with the weighing dialog), orders, bills list, bill dialog, table requests, collection display (the guests' QR page: `apps/customer-web/src/modules/table-order`) | `orders`, `order_items`, `table_requests` |
| `restaurant/preorders` | `preorder.routes`, `preorder.service` | pre-orders and cakes, the bake list | `restaurant_preorders`, `restaurant_preorder_items` |
| `restaurant/kitchen` | `kitchen.*` (with the food at the pass the captain app reads), `kitchenSlip` | kitchen display, sold-out | `kots`, `kot_items`, `kitchen_stations` |
| `workspaces/captain` (the captain app; staff app only) | none of its own: the order, KOT, table, table-request and captain-section routes, and `GET /api/kitchen/pass` | `CaptainLayout`, `CaptainTablesPage` with `TableSheet`, `CaptainCallsPage`, `CaptainReadyPage` with `ReadyTicket`, `CaptainOrderPage` (the POS in its `captain` mode); the floor in `useCaptainFloor` and `captainFloor.js`, the alerts in `captainAlerts.js`; styles `styles/captain.css` | reads `dining_tables`, `captain_assignments`, `orders`, `kots`, `table_requests` |
| `restaurant/reservations` | `reservation.*`, `publicBooking.*` | reservations (page + parts), online booking settings (the guests' booking page: `apps/customer-web/src/modules/booking`) | `reservations`, `waitlist_entries` |
| `restaurant/online` | `onlineOrder`, `publicOnline.routes`, `guestAddress.*` | none (services only: the ordering links for Service settings; the guests' ordering page: `apps/customer-web/src/modules/online-order`) | `online_*`, `customer_addresses` |
| `restaurant/deliveries` | `delivery.*`, `riderSettlement.*`, `deliveryCharge`, `salesChannel` | deliveries (page + tabs), rider cash | `sales_channels`, `rider_settlements` |
| `restaurant/billing` | `bill.*` (split, see below), `billPricing`, `gstBreakdown`, `serviceChargeShare`, `cashAndPan` (the cash limit's figures and the buyer's PAN, kept by the database's triggers), `discount.*`, `customerAccount.*`, `customerAdvance.*` | discounts and offers, loyalty programme, dues, advances | `bills`, `bill_items`, `bill_taxes`, `payments`, `refunds`, `credit_notes` |
| `restaurant/business-day` | `businessDay.*`, `cashDrawer.*`, `tillRules`, `tradingDay` | business day, cash count, drawers, past days, X report | `business_days`, `cash_drawers` |
| `restaurant/crm` | `crm.*`, `loyalty.*`, `guestInsight.*`, `guestImport` | guests, feedback, complaints, guest insights | `customers`, `loyalty_transactions`, `feedback`, `complaints` |
| `restaurant/inventory` | `inventory.*`, `advancedInventory`, `batch`, `stockTransfer`, `stockSettings`, `dishWaste`, `inventoryInsight.*`, `writeoffControl`, `stockImport`; middleware `writeoffApproval` | stock items, ledger, transfers, insights, day-end unsold, settings | `inventory_items`, `stock_transactions`, `stock_balances`, `inventory_batches` |
| `restaurant/purchasing` | `supplier.*`, `supplierImport`, `purchase.*`, `purchaseReturn.*` | suppliers, purchase orders, returns | `suppliers`, `purchase_orders`, `goods_receipts` |
| `restaurant/expenses` | `expense.*`, `attachment.*`; middleware `upload` | expenses, attachments | `expenses`, `document_attachments` |
| `restaurant/staff` | `staff.*`, `timeclock.*`, `leave`, `statutory`, `myWork`, `tip.*` | employees, time clock, attendance, shifts, payroll, tips, my work | `employees`, `shifts`, `attendance`, `payroll_*`, `tip_*` |
| `restaurant/reports` | `report.*` (split, see below), `dashboardLive.controller`; middleware `reportOutlet`, `utils/dashboardCache` | reports (page + one file per tab), audit log | reads everything |
| `restaurant/dashboard` (frontend only) | the dashboard's API is in `restaurant/reports` | `DashboardPage`, blocks, panels | none |
| `restaurant/logbook` | `logbook.*` | log book, follow-ups, handover notice | `logbook_entries` |
| `restaurant/notifications` | `notification.*` (the bell's API; the providers are in `src/notifications/providers/`) | `NotificationsPage` (the bell itself is `components/NotificationBell`) | `notification_reads` |
| `restaurant/imports` | `sheetImport.controller` (one controller for the spreadsheet imports of stock items, suppliers, recipes and guests; the menu has its own, `menuImport`), `sheetImport` (the shared reader) | none | none |
| `platform` | `platform.*` (the businesses part calls `business/core`'s `businessOnboarding.service`) | `PlatformRestaurantsPage`, `PlatformBusinessesPage` | `restaurants`, `businesses`, `users` |
| `health` | `health.*` | none | none |

**The split report and bill files.** Each family of functions is its own
file behind an index file with the module's name, which callers import:

- `restaurant/reports/services/report.service.js` gathers
  `services/report/`: `common.js` and `scope.js` (shared helpers: numbers and
  wording; the restaurant's clock, trading days and a report's scope),
  `sales.js`, `items.js`, `gstData.js` (the GST machinery that the GST pack,
  the day end and the day book share), `gst.js`, `staff.js`, `stock.js`,
  `dayEnd.js`, `dashboard.js`, `periods.js` (months and cost sharing for the
  P&L and expenses), `profitLoss.js`, `expenses.js`, `dayBook.js`, `theft.js`.
- `restaurant/reports/repositories/report.repository.js` gathers
  `repositories/report/`: `sql.js` (shared SQL fragments: scope, trading day,
  live bills, bill lines, recipients, stock movements, voided bills),
  `sales.js`, `items.js`, `gst.js`, `staff.js`, `stock.js`, `drawers.js`,
  `dayEnd.js`, `dashboard.js`, `profitLoss.js`, `dayBook.js`, `theft.js`.
- `restaurant/billing/services/bill.service.js` gathers `services/bill/`:
  `shape.js` (a bill as the screens see it), `offers.js` (coupons, loyalty),
  `rules.js`, `raise.js` (list, raise, adjust, print), `payments.js`
  (payments, corrections, the buyer's PAN), `refunds.js` (credit notes,
  refunds, voids), `summaries.js`.
- Staff app: `ReportsPage.jsx` is the shell, and each tab is its own file
  (`SalesReport`, `ItemReport`, `ProfitabilityReport`, `OutletReport`,
  `CancellationReport`, `ConsumptionReport`, `DiscountReport`, `GstReport`,
  `ProfitLossReport`, `ExpenseReport`, `DayBookReport`, `TheftReport`,
  `StaffReport`, `DayEndReport`). `ReservationsPage.jsx` and
  `DeliveriesPage.jsx` keep the page; their panels, dialogs and helpers are
  files beside them (`Timeline`, `Agenda`, `BookingEditor`, `BookingDetail`,
  `reservationFormat.js` …; `BoardTab`, `DeliveryCard`, `ChannelsTab`,
  `ReportTab`, `deliveryFormat.js` …).

**Shared core** (scoped by `business_id`; screens under
`/business-admin/:id/`). Backend module `business/core`, staff app
`modules/business/core/pages/`:

| Area | Backend | Frontend pages | Main tables |
| --- | --- | --- | --- |
| Directory, access, set-up | `business.routes.js`, `businessAccess.service` (membership, location, module, permission), `businessSetup.service`, `business.service` (list, link, locations), `businessOnboarding.service` (a new business, staff logins), `businessNumbering`, `businessDepartments.service`, `business.repository` | `BusinessAdminPage`, `NewBusinessForm`, `SettingsPage`, `TaxRatesPage`, `NumberSeriesPage`, `LocationsPage`, `StaffAccessPage`, `RolesPage`, `ActivityPage`; `WorkspaceNav` (a workspace's tabs) | `businesses`, `business_memberships`, `business_roles`, `business_settings`, `business_tax_rates`, `business_number_series`, `business_capabilities`, `business_locations`, `business_departments`, `business_audit` |
| Catalogue, contacts, prices | `business.service` (catalog, contacts, price rules), `businessPricing`, `businessModules` (the attributes an item may carry, by module), `businessSetup.service` (categories, units, packs), `businessLocationPrices.service` (a branch's own price), `businessKits.service` (kits and bundles) | `CatalogPage`, `CategoriesPage` (with departments), `UnitsPage`, `ContactsPage`, `PricingPage`, `KitsPage` | `catalog_*`, `business_units`, `business_contacts`, `business_price_rules`, `business_sku_location_prices` |
| Sales and purchases | `business.service` (`postDocument`, payments), `businessReturns.service` | `DocumentsPage` | `business_documents` (+ lines, payments, returns, refunds) |
| The counter, the tax invoice, Daily money, paying suppliers | `businessTakings.service` (the day's close, today's overview figures), `businessPayables.service` (payables, supplier payments, statement), `businessCounter.service` (the shared till's per-staff PIN; routes in `businessCounter.routes.js`, with kits and EMI) | Quick bill is `retail/pages/CounterPage` with `counterParts`, `counterState`, `counterPay`, `counterPayState`, `counterShelf` and `counterShift`, for every goods type; `invoice.js` (the one A4 / 80 mm GST invoice); `DayClosePage` (Daily money); `SupplierPayments.jsx` (on `ContactsPage` for suppliers) | `business_supplier_payments` |
| Payment methods, expenses, cash checks, cashier shifts | `businessPaymentMethods.service`, `businessExpenses.service`, `businessCashChecks.service`, `businessShifts.service` | `PaymentMethodsPage`, `ExpensesPage`, `CashCheck` and `CashierShifts` (on `DayClosePage`) | `business_payment_methods`, `business_expenses`, `business_cash_checks`, `business_counter_shifts` |
| Stock | `businessStock.service`, `businessReturns.service` (adjustments) | `StockPage`, `MovementsPage`, `TransfersPage`, `CountsPage`, `CountSheetPage` | `business_stock_*` |
| Appointments | `business.service` (resources, appointments, `statusAllowed`) | `AppointmentsPage`, `ResourcesPage` | `business_resources`, `business_appointments` |
| Receivables (udhaar / outstanding) | backend module `business/wholesale`: `businessTrade.routes.js`, `businessReceivables.service` | `modules/business/receivables/` | `business_collections` |
| Overview and reports | `business.service.reports` + each type's reports service; `businessOverview.service` (the Overview's picture of the day), `businessBranches.service` (every location side by side), `businessDepartments.service` (sales by department) | `OverviewPage` (+ `OverviewToday`), `ReportsPage` | reads the core |

**Business type extensions:**

| Type | Backend module and files | Frontend (`modules/business/…`) | Tables |
| --- | --- | --- | --- |
| Retail (grocery, supermarket, books) | `business/retail`: `businessRetail.routes`, `businessRetail.service`, `businessRetailCustomers`, `businessRetailOffers`, `businessRetailReports`, `businessOffers` (pricing), `businessBooks`, `businessRetailBooks.service` (near expiry, school sets, book orders) | `retail/` (Counter, Udhaar, Offers, Loyalty, Books, BookOrders, NearExpiry, Labels, RetailReports) | `retail_*`, `books_titles`, `books_sets`, `books_set_items`, `books_customer_orders` |
| Wholesale | `business/wholesale`: `businessTrade.routes`, `businessWholesale.service` (orders, edits, dispatch), `businessWholesalePricing.service` (price groups, schemes), `businessWholesaleCredit.service` (credit hold, trade details), `businessWholesaleDelivery.service` (pick list, runs, delivery, invoice extras), `businessWholesaleMoney.service` (settlement, overview, beat sheet, claims), `businessWholesalePurchase.service` (purchase orders for every business with stock, reorder suggestions, receiving) | `wholesale/` (SalesOrders, Dispatch, BackOrders, Routes, PriceGroups, Claims, PurchaseOrders, WholesaleReports, SettlementPanel, WholesaleToday) | `wholesale_*`, `business_collection_cheques` |
| Fashion | `business/fashion-electronics`: `businessFashionElectronics.routes`, `businessFashion.service`, `businessFashionMerchandising.service` (barcodes, markdowns, GST by price, style reports), `businessExchanges.service`, `businessVouchers.service` | `fashion/` | `fashion_variants`, `fashion_gst_price_slabs`, `business_exchanges`, `business_exchange_policies`, `business_exchange_vouchers` |
| Electronics | the same module and routes file: `businessElectronics.service`, `businessRepairs.service`, `businessElectronicsSuppliers.service` (scan-in receipts, faulty units, warranty claims), `businessFinance.service` (EMI and financiers; its routes are in `core/routes/businessCounter.routes.js`) | `electronics/` (Serials, Warranties, Repairs, RepairJob, Finance) | `electronics_*` |
| Salon & spa | `business/salon-weight`: `businessSalonWeight.routes`, `businessSalon.service`, `businessSalonSales` (pricing, commission on sessions and plan sales), `businessSalonDesk.service` (the front desk: move, arrival, walk-ins, messages, client card, leave, plan extension, history), `businessSalonBackOffice.service` (a stylist's week and salon holidays, back-bar products, handing back advances, monthly target commission plans), `businessManagerPin` (a manager's PIN say-so; repairs use it too), `businessAdvanceRefunds` (an advance handed back; repairs too) | `salon/` (Calendar, New bill, `ClientPanel`, the `salonParts` client picker, Packages, Commissions, `CommissionPlans`, Stylists & services, Service profitability, `ManagerApproval`, `SalonAppointmentsPage`; the back office's parts (a stylist's week, holidays, back-bar, advances) in `salonBackOfficeParts.jsx`, with helpers in `salonBackOffice.js`; styles in `salon/styles/salon.css`) | `salon_*` |
| Meat and weight shops | the same module and routes file: `businessWeight.service`, `businessWeightDaily.service` (rates, stock today, day close, wastage in one go, cut to order, pickup orders, today) | `weight/` (Rates, Pickup orders, Stock by weight, Cutting & yield, Wastage, Yield & wastage, `WeightToday` on the Overview, `CounterWeightTools` mounted by Quick bill) | `weight_*` |
| Pharmacy, clinics & labs | `business/health`: `businessHealth.routes` (mounted from `business.routes.js`), `healthUploads.routes` (prescription scans, mounted in `routes/index.js` before `/businesses`), `healthCommon` (settings, signatories and PIN sign-off, counters, private files), `businessPharmacy.service` (drug master, prescription sale, registers, recalls, near expiry, debit notes, invoice extras), `businessClinic.service` (patients, consent, visits with their referral, billing a visit, the medicines the clinic prescribes), `businessClinicDesk.service` (doctors' fees and follow-ups, OPD sessions and leave, the token queue), `businessLab.service` (tests, orders, samples, results, approval, report, the lab's bench), `businessLabQuality.service` (signed report versions and amendments, QC) | `health/` (PharmacyCounter, DrugMaster, PharmacyRegisters, PharmacyBatches, HealthSettings, ClinicToday, TokenQueue, Doctors, Patients, Patient, Visits, Visit, LabOrders, LabOrder, LabTests, LabQc; `healthFormat.js`, `healthParts.jsx`, `healthPrint.js`, the queue's reading and actions in `tokenQueue.js`, a sample's steps in `labSamples.js`) | `pharmacy_*`, `health_*`, `lab_*` |
| Clinic workspace (`workspaces/clinic`; staff app only) | none of its own: the health module's queue, token, patient, visit, medicines and lab order routes | `ClinicLayout` (in `layouts/BusinessWorkspace.jsx`), `ClinicDeskPage` with `PatientAtDesk`, `ClinicVisitPage` (the health module's `VisitPage` beside the queue) with `PatientHistory`; the health module's Today, Patients, Patient and Visits; the desk in `useClinicDesk` and `clinicDesk.js`; styles `styles/clinic.css` | reads `health_*`, `business_resources`, `lab_orders` |
| Lab workspace (`workspaces/lab`; staff app only) | none of its own: the health module's lab routes, the bench (`GET …/lab/bench`) first | `LabLayout` (in `layouts/BusinessWorkspace.jsx`), `LabCollectionPage`, `LabWorklistPage`, `LabApprovalPage`, `LabReleasedPage`; the health module's Lab orders, Lab order, Quality control and Tests; the bench in `useLabBench` and `labBench.js`; styles `styles/lab.css` | reads `lab_*` |
| Quotations (every type but the restaurant) | `business/quotations`: `businessQuotations.routes` (mounted from `business.routes.js`), `businessQuotations.service` (priced by `postDocument`'s estimate mode; the bill at `fixed` prices; a sales order through `placeOrder`) | `quotations/` (Quotations, `QuotationDialog`, `quotation.js`, `quotationPrint.js`) | `business_quotations` (+ lines, revisions) |
| Licences & registrations (every type but the restaurant) | `business/licences`: `businessLicences.routes` (mounted from `business.routes.js`), `businessLicences.service` (licences per location; `standing` and `holds`, which other modules ask whether a location holds a licence in force; `expiring`, which the bell reads) | `licences/` (Licences) | `business_licences` |
| Hardware, paints & building materials | `business/hardware`: `businessHardware.routes` (mounted from `business.routes.js`), `hardwareSites.service` (sites, a site's ledger, the site of a bill, quotation or order), `hardwareSales.service` (the sale hook: site and fitter; invoice extras), `hardwareFitters.service` (fitters, rules, commission on a bill, payouts through the expense book, statement, report), `hardwareRates.service` (today's rates through the core catalogue update), `hardwareCalculators.service` (the items with a coverage) | `hardware/` (Sites, `SiteField`, Fitters, `FitterField`, Fitters' commission report, Today's rates, `CalculatorDialog`; helpers in `hardware.js` and `calculators.js`) | `hardware_*` |
| Seeds, fertilisers & pesticides | `business/agri`: `businessAgri.routes` (mounted from `business.routes.js`), `agriCommon` (the type and module guard, an item's classification, the molecule list read once per process), `agriItems.service` (classification inside the catalogue's own transaction; the molecule list), `agriSales.service` (the sale hooks: the checks before saving, season credit, the lines after; a purchase's seed lots; invoice extras), `agriFarmers.service` (farmers, a farmer's bills, village dues), `agriSubsidy.service` (the PoS reconciliation and the PoS stock typed in), `agriRegisters.service` (the board, the seed stock return, the insecticide register) | `agri/` (Farmers & village dues, Subsidy PoS reconciliation, Registers & board, Molecules, Farm input checks; `AgriItemFields` on the item form, `AgriBillFields` on Quick bill, `AgriBillFacts` on a bill; helpers in `agri.js` and `agriPrint.js`) | `agri_*` |
| Optical shops | `business/optical`: `businessOptical.routes` (mounted from `business.routes.js`), `opticalCommon` (the type and module guard, reading powers and dates), `opticalPrescriptions.service` (prescriptions, corrections until an order uses one, a customer's history, the examiners), `opticalOrders.service` (spectacle orders priced by the quotations' `priceIn`, the advance as a collection receipt, the lab, workshop and quality check, delivery through `postDocument` at `fixed` prices with the advance paid first, cancelling and the advance handed back through `businessAdvanceRefunds`, the chips and the bell), `opticalRecall.service` (the recall list, its months and the reminders), `opticalLenses.service` (a contact lens's power grid as items of one product) | `optical/` (Prescriptions, `PrescriptionDialog`, `PrescriptionHistoryPage`, `RxGrid`, Spectacle orders, `SpectacleOrderDialog`, `SpectacleOrderPage`, Recall list, `PowerGridFields` on the item form; helpers in `optical.js` and `opticalPrint.js`) | `optical_*` |
| Vehicle service & auto parts | `business/garage`: `businessGarage.routes` (mounted from `business.routes.js`), `garageCommon` (the type and module guard, the desk and money checks, reading plates, kilometres and dates, the kilometres-a-day projection), `garageVehicles.service` (vehicles, owners, the odometer log and a manager's approval of a lower reading, a customer's statement, the approvers), `garageJobCards.service` (opening, the board and lists, details, mechanics, the steps, the owner's approval, the advance as a collection receipt and its refund through `businessAdvanceRefunds`, cancelling, the bell), `garageEstimates.service` (the estimate priced as a sale of its lines, its versions, parts used, work done, the claim), `garageMoney` (the job's figures and the bills: the insurer's approved amount spread over its lines and the owner's share, to the paisa), `garageBilling.service` (billing through `postDocument` at `fixed` prices, with the quotations' `stockPieces` and `pricePieces`; the next service), `garageReminders.service` (the service-due list, reminders, the settings) | `garage/` (Job cards board and list, `JobCardDialog`, `JobCardPage`, `EstimateDialog`, `ClaimDialog`, `BillDialog`, `GarageApproval`, Vehicles, `VehicleDialog`, `VehiclePage`, the customer's statement, Service due, Garage settings; helpers in `garage.js` and `garagePrint.js`) | `garage_*` |
| Gyms, studios & coaching | `business/memberships`: `businessMemberships.routes` (mounted from `business.routes.js`), `memberCommon` (the type and module guard, reading money and dates, the business's date, a plan's last day, the status on a day, the part not used by days or sessions to the paisa, and the check that sells a plan's item only as a membership), `memberPlans.service` (plans with an item of their own or an existing one, the refund policy's versions, the settings, the approvers), `memberships.service` (the members and memberships lists, a member's page, member codes, selling and renewing through `postDocument` with the instalments and the bill's due day, the bill priced by the quotations' `priceIn`, the events), `memberChanges.service` (freezes, transfers, the upgrade with its credit note paying the new bill, the cancellation's pro-rata credit note and refund through `businessReturns`' value credit and `postRefund`, with a manager's PIN through `businessManagerPin`), `memberCheckins.service` (check-in by code or search, the reason when turned away, fees overdue from the receivables' open items and the instalments, today's check-ins), `memberRenewals.service` (the renewal calls and fees due, reminders, the counts and the bell) | `memberships/` (Members & plans, `MemberPage`, `MembershipDialog` to sell, renew and upgrade, `ChangeDialogs` to freeze, transfer and cancel, `MemberApproval`, Check-in, Renewals with its collection dialog, Membership plans in Settings; helpers in `memberships.js` and `membershipPrint.js`) | `member_*` |
| Laundry & dry cleaning | `business/laundry`: `businessLaundry.routes` (mounted from `business.routes.js`), `laundryCommon` (the type and module guard, reading tags, racks and dates, the business's date, request keys), `laundryMoney` (a garment's price, express surcharge and GST to the paisa, the bill's figures, GST at the rate of the day, the bill lines with their words), `laundryPrices.service` (services as service items, garments, prices for each one or by the kilo, the settings), `laundryOrders.service` (taking in with a preview, tags, the advance as a collection receipt or the bill at intake through `postDocument` at `fixed` prices; the lists, an order's page, the work, re-tagging and racks, the promised day, messages to the customer, the counts, the bell, the approvers), `laundryDelivery.service` (handovers: the bill through `postDocument` with the advance paid first, payments on the bills owed, held until paid unless on the customer's account), `laundryCancel.service` (cancelling with credit notes through `businessReturns`' value credit and `postRefund` with a manager's PIN; the advance handed back through `businessAdvanceRefunds`), `laundryClaims.service` (damage claims and a manager's decision: a credit note and a refund within the garment's charge, reprocessing, a rejection) | `laundry/` (New order, Garment orders board and list, `GarmentOrderPage`, `LaundryDialogs` for the work, handover, cancelling, claims and the advance, `LaundryApproval`, Ready & racks, Unclaimed, Price list with the order settings; helpers in `laundry.js` and `laundryPrint.js`) | `laundry_*` |
| Jewellery & gold | `business/jewellery`: `businessJewellery.routes` (mounted from `business.routes.js`), `jewelleryCommon` (the type and module guard, the purities with their fineness and hallmark marks, reading weights to the milligram and rates to the paisa, dates on the business's clock, request keys), `jewelleryMoney` (a piece's price in paise from milligrams: metal, wastage, making, stones, hallmarking; old gold's value by the fineness found; splitting a whole to the paisa), `jewelleryRates.service` (rate sheets, today's rate of each purity, the rates last set), `jewellerySettings.service` (tags, the hallmarking charge and rules, old gold's deduction and cash limit), `jewelleryPieces.service` (jewellery items made through `createCatalog` or joined; pieces tagged into stock through the core's `receiveSerial` or on a unit bought in, changed, sent out and back, melted through `applyAdjustment`; the loose-sale check the core's `postDocument` calls), `jewelleryMetal.service` (the shop's own metal by purity), `jewelleryBills.service` (the jewellery bill: pricing at the day's rates, the HUID check, the preview, posting through `postDocument` at `fixed` prices with `jewellery: true` and the old gold as `tenders`; the invoice extras the core's `detail()` adds), `jewelleryOldGold.service` (old gold vouchers numbered by the core's numbering, valued at the day's buy rates; payouts through the core's `insertExpense`; uses on bills; put back from a returned bill by a credit-note refund after the core's `lockDocument`), `jewellerySchemes.service` (scheme plans; schemes numbered by the core's numbering, each instalment a core collection receipt; redeemed on the jewellery bill through the core's `recordPayment` from each receipt; stopped with the core's manager PIN; the money held; the receipts the core's receivables leave out when applying a customer's advances), `jewelleryCash.service` (the cash report and the monthly worksheet from the core's cash rows; it writes nothing), `jewelleryBell.service` (its lines in the bell) | `jewellery/` (Jewellery bill (with the core's `DocumentDetail` and `printTaxInvoice` for the posted bill, and the customer's old gold), Today's rates with the sheet form and every sheet, the Rate board, Pieces & tags with `PieceDialogs` for items, tagging and changing pieces and the piece's panel, Old gold with `OldGoldDialogs` for taking it in, the voucher's panel, paying out, putting back and cancelling, Gold schemes with `SchemeDialogs` for enrolling, the passbook panel, instalments and stopping (with `JewelleryApproval` for a manager's PIN), Gold scheme plans, the Cash report with each customer's transactions and the monthly worksheet, Jewellery settings with the hallmarking rules, old gold's and the cash report's; helpers in `jewellery.js`, tag labels, the old gold voucher and the scheme passbook in `jewelleryPrint.js`; the core's `invoice.js` prints each article's BIS details, the purity statement and a payment by old gold with its voucher) | `jewellery_*` |
| Rentals & hire | `business/rentals`: `businessRentals.routes` (mounted from `business.routes.js`), `rentalsCommon` (the type and module guard, reading instants on the business's clock, plates and serial numbers, the hirer's ID and driving licence, the settings, request keys, the receipts' free money), `rentalsMoney` (the hours charged, the cheapest mix of the rates, the late fee, GST and the bill's figures to the paisa, the bill lines with their words), `rentalsItems.service` (rental items as service items, units, the settings, and the check that bills an item's hire only from its booking), `rentalsBookings.service` (quotes and bookings priced and checked against what is free, changes and extensions, advances and deposits as collection receipts, cancelling with its charges billed, the money held handed back through `businessAdvanceRefunds`, a booking's page, the board, lists and bell, the approvers), `rentalsHandover.service` (the handover with the ID, licences, meters and the deposit; returns with late fees and charges, the bill through `postDocument` at `fixed` prices, the advance and deposit paying it), `rentalsAvailability.service` (the week by unit and pool, what is free for a booking), `rentalsDeposits.service` (the deposits ledger and its totals) | `rentals/` (Bookings board and list, `BookingFormPage`, `BookingPage`, `RentalDialogs` for the handover, return, receipts, extension, cancelling and money handed back, `RentalApproval`, Availability, Deposits held, Rental items with the handover settings; helpers in `rentals.js` and `rentalsPrint.js`) | `rental_*` |
| Fuel stations | `business/fuel`: `businessFuel.routes` (mounted from `business.routes.js`), `fuelCommon` (the type and module guard, reading litres, readings, money, densities, plates and nozzle numbers, instants and days on the business's clock, the settings, the outlet a board shows, request keys), `fuelMoney` (thousandths of a litre and paise: a nozzle's sale, a shift's money and the attendant's difference, the stock register's variation against the tolerance, a load's density and dips), `fuelSetup.service` (fuels as goods items on the nil slab, tanks with their opening stock, units, nozzles, meter changes, measures, prices, the tolerances, the PESO standing, and the checks that keep a fuel off other bills and petrol and diesel off other purchases), `fuelShifts.service` (opening a shift, its nozzles, the close with its preview posting the fuel bills through `postDocument` at `fixed` prices, a manager's reopening crediting them, the board and lists), `fuelTanks.service` (the dips, tanker loads posted as purchases and cancelled, the stock register and the density register), `fuelFleet.service` (vehicles, the month's fills, a customer's statement), `fuelBell.service` | `fuel/` (Shift & readings with `ShiftPage` for the close and the settlement, Tanks & dips, Tanker receipts, the stock and density registers, Fleet statements with `FleetStatementPage`, Pumps & nozzles; helpers in `fuel.js`, `FuelParts.jsx` and `fuelPrint.js`) | `fuel_*` |
| Hotels, lodges & guest houses | `business/lodging`: `businessLodging.routes` (mounted from `business.routes.js`), `lodgingCommon` (the type and module guard, reading dates, rates and photo IDs (an Aadhaar's last four digits only), the business's date, the settings and the two slabs, request keys, the receipts' free money and a bill's due, the database's room-taken sentence), `lodgingMoney` (paise: a night's value and its slab, GST to the paisa, a stay's nights, the extras and the bill's figures and lines), `lodgingSetup.service` (the settings, room types as service items counted in nights, rooms, the housekeeping board and status, and the check that bills a room type's nights only from a stay), `lodgingStays.service` (reservations priced night by night with a preview and checked against the rooms and the room type, changes and room moves, advances and deposits as collection receipts, cancelling and no-shows with a charge billed through `postDocument`, the money held handed back through `businessAdvanceRefunds`, a stay's page and the list, the approvers), `lodgingFolio.service` (the check-in with every occupant, the night audit, extras and voids, the check-out with its preview posting the folio through `postDocument` at `fixed` prices with `lodging: true`), `lodgingDesk.service` (the desk, the calendar, the rooms free), `lodgingGuests.service` (Form-III, an occupant corrected, the guest register, the bell) | `lodging/` (Front desk, Rooms & housekeeping, Reservations (the calendar), Stays with `StayFormPage` and `StayPage`, `LodgingDialogs` for the check-in, charges, voids, receipts, check-out, changes, cancelling, money handed back, out of order and Form-III, `LodgingApproval`, Foreign guests (Form-III), Guest register, Room types & rates; helpers in `lodging.js` and `lodgingPrint.js`) | `lodging_*` |

**Modules for every business, the restaurant included:**

| Module | Backend | Frontend (`modules/<module>/pages/`) | Tables |
| --- | --- | --- | --- |
| Tasks, issues & projects (`modules/tasks`) | `routes/tasks.routes.js` (both front doors), `controllers/tasks.controller.js`, `services/` (`scope`, `common`, `people`, `templates`, `recurrence`, `tasks`, `issues`, `projects`, `files`, `reports`, `notifications`), `repositories/tasks.repository.js`, `library/`; bell provider `notifications/providers/tasks.js` | `TasksRoutes`, `TasksScope`, `MyTasksPage`, `TaskRunPage`, `BoardPage`, `CalendarPage`, `IssuesPage`, `IssueDetailPage`, `ProjectsPage`, `ProjectDetailPage`, `TemplatesPage`, `RecurringPage`, `TaskReportsPage`, `forms`, `ItemsEditor`, `ScheduleForm`, `parts`, `taskWords`, `useTasks`, `useServerGrid`; API calls `services/tasks.service.js`; styles `styles/tasks.css` | `business_task*`, `business_issues`, `business_project*`, `platform_task_categories` |
| Live updates (`modules/live`) | `routes/live.routes.js` (both front doors, mounted in `routes/index.js` before `/businesses`), `services/liveListener.js` (the process's one LISTEN connection), `services/liveHub.js` (the streams, their checks and limits, clearing the kept dashboard and bell answers); started and stopped by `server.js` | `services/liveClient.js` (the stream, reconnecting, gathering bursts), `services/live.js` (the app's client), `hooks/useLiveRefresh.js`, `components/LiveIndicator.jsx`; used by the live screens and the bell | none: triggers on the tables the live screens read (migrations 1791974000000, and 1791976000000 for the lab) |
| GST rates by date (`modules/tax-changes`) | `routes/taxChanges.routes.js` (both front doors: `businessRoutes`, mounted from `business.routes.js`, and `menuHandlers`, mounted from the restaurant's `menu.routes.js`), `services/` (`taxChanges.service` the shared flows, `taxChangesShop` and `taxChangesMenu` the two worlds with their gates, `taxChangesMoney` the arithmetic and dates); the gates are called from `businessAccess.open`, `postDocument`, the menu router, `tableRequest.service`, `preorder.service` and `order.service`'s `priceLines` | `BusinessTaxChangesPage`, `MenuTaxChangesPage`, `TaxChangesView`, `TaxChangeTool` (the new change with its preview), `TaxChangeDialog`, `TaxHistoryDialog` (an item's GST history, from the catalogue and the menu's products); words in `taxChanges.js`; API calls `services/taxChanges.service.js`; styles `styles/tax-changes.css` | `business_tax_changes`, `business_tax_change_items` |
| Personal data (`modules/personal-data`) | `routes/personalData.routes.js` (both front doors: `businessRoutes`, mounted from `business.routes.js`, and `restaurantRouter`, at `/api/privacy` in `routes/index.js`), `services/` (`personalData.service` the notice, consents and a child's mark; `privacyRegister.service` requests, the access export, erasure and breaches; `personalDataShop` and `personalDataRestaurant` the two worlds; `personalDataRegistry` where a customer's data lives, table by table; `consents` what every module uses to record and check a consent; `privacyNotice` the starter notice); bell provider `notifications/providers/privacy.js`, and a business's bell in `businessNotifications.service.js` | `BusinessPrivacyPage`, `RestaurantPrivacyPage`, `PrivacyView` (the three tabs), `RequestsTab`, `BreachesTab`, `NoticeTab`, `usePagedList`; components `ConsentChoices` (+ `NewCustomerConsents`), `ConsentLink`, `AskConsentDialog`, `ChildMark`; `useConsentGate`, `usePrivacy`, `consentStore.js`, `printLine.js`; words in `personalData.js`; API calls `services/privacy.service.js`; styles `styles/personal-data.css`; the guests' site's `modules/privacy/GuestPrivacy.jsx` | `business_privacy_notices`, `business_consents`, `business_children`, `business_privacy_requests`, `business_privacy_breaches`, `business_privacy_breach_people`, `business_privacy_breach_notices` |
| An owner's GST thresholds (`modules/gst-thresholds`) | `routes/gstThresholds.routes.js` (three doors: `ownerRoutes` and `businessRoutes`, mounted from `business.routes.js`, and `restaurantRouter`, at `/api/gst-thresholds` in `routes/index.js`), `services/` (`gstThresholds.service` the owner's view, the warning level, the recorded PAN, the codes to fix and the bells' lines; `gstTurnover` what each business's records say: its owners, PAN sources, date, sales less returns, HSN / SAC codes; `gstThresholdsRules` the pure part: a PAN from a GSTIN, the financial year, the projection, the figures in force and where a PAN stands, the words; `standingCache` a business's standing kept five minutes for the bells); bell provider `notifications/providers/gstThresholds.js`, and a business's bell in `businessNotifications.service.js` | `GstThresholdsPage` (`/business-admin/gst-thresholds`), `OwnerThresholdsCard` (on Your businesses), `HsnToFix` (on a catalogue), `MenuHsnNotice` (on the restaurant's Tax rates); words in `gstThresholds.js`; API calls `services/gstThresholds.service.js`; styles `styles/gst-thresholds.css` | `platform_gst_thresholds`, `business_gst_pans`, `owner_gst_settings`; reads the core's documents and returns, and the restaurant's bills and credit notes |

Where each area's tests are: [TESTING.md](TESTING.md).

---

## 7. Conventions

| Convention | Where | Rule |
| --- | --- | --- |
| Expected errors | `backend/src/utils/AppError.js` | `throw new AppError(status, "sentence for a person", details?)`. `details` goes to the client as `data` (for example, what blocks closing a day). Anything else is a 500 with no detail. |
| Error responses | `middlewares/errorHandler.js` | `{ success: false, message, data? }`. Deadlocks and serialization failures (40P01, 40001) become a 409 "try again". A rule a database trigger keeps (23514 naming no constraint) becomes a 409 with the trigger's own sentence. A note is added when a manager's approval was spent. What each status means to a caller: [API › Conventions](API.md#conventions). |
| Success responses | every controller and route | `{ success: true, data }` |
| Input validation | `backend/src/utils/validate.js` | Small checkers (`requiredString`, `requiredId`, …) that throw `AppError(400)` naming the field. Business services also have local `decimal`, `uuid` and `dateText` helpers in `business.service.js`. No schema library. |
| Permissions (restaurant) | `middlewares/authorize.js` | `authorize("x.y")`, `authorize.any(…)`, and `authorize.noteEnforced(…)` for checks made inside a handler. The role editor shows which codes are really enforced: besides the routes, it reads the source of `routes/`, `middlewares/` and every file under `modules/` for quoted codes, so keep new code inside `modules/`. |
| Permissions (business) | `modules/business/core/services/businessAccess.service.js` | `access.load` → `access.require(business, "module.action")`; `can()` for optional figures. |
| Approvals | `middlewares/authorizeOrApprove.js`, `modules/access/services/approval.service.js`, the staff app's `services/approval.js` and `components/ApprovalDialog.jsx` | See §3.3. Bind `scope` to the facts the manager sees. |
| Audit | restaurant: `utils/audit.js` (`logAction`); business: `repo.audit(db, …)` | Business: always with the transaction's client. |
| Pool and transactions | `config/database.js`; business: `repo.transaction(work)`; restaurant services and repositories open `pool.connect()` + `BEGIN` / `COMMIT` themselves | Inside a transaction use **only** the transaction's client. |
| `DB_POOL_GUARD` | `config/database.js` | `warn` logs, and `throw` refuses, any request that asks the pool for a second connection while holding one (the hold-and-wait pattern that can freeze the API). Off by default. |
| Money | `utils/money.js` (restaurant: `round2`, `toPaise`); business services in paise / BigInt | Never add rupee floats across lines; work in paise and convert at the end. |
| Trading day | `modules/restaurant/business-day/services/tradingDay.js`, `businessDay.service.js`; reports: `modules/restaurant/reports/services/report/scope.js`; live screens: `modules/restaurant/orders/repositories/tradingClock.js` | Dates in the business's time zone (Asia/Kolkata by default), with the day cut-off. |
| Start-up check | `utils/migrationStatus.js` | The API refuses to start with a pending migration. |
| HTTP client | `apps/business-web/src/services/api.js` (the guests' site uses its own client per page, with no token) | Adds the token, `X-Outlet-Id` and `X-Business-Location`; refreshes the token past half its life; signs out on 401; sends the request again after an approval; reloads the features on `feature_off`. |
| Browser storage | `apps/business-web/src/services/api.js` | The session token is `rmp_token`, the outlet picked on this device `rmp_outlet`, and a business's picked branch `bz_location_<businessId>`. `rmp_live_poll_ms` lengthens (never shortens) a device's live-screen safety net; the browser tests set it. Leave these names alone: renaming `rmp_token` signs everyone out once. Every read and write is guarded, so blocked storage only means the session ends when the tab closes. |
| Live screens | `hooks/useLiveRefresh.js`, `components/LiveIndicator.jsx` (§3.5) | A screen that shows what other devices change subscribes to the areas it shows and reads again on a change; its own timer, if it keeps one, is a safety net of a minute at least (`safetyNetMs`), never the main path; it shows `LiveIndicator` (or its own Live control). A new table such a screen reads gets a live trigger in its migration. |
| Server data cache | `apps/business-web/src/services/queryClient.js` | TanStack Query: 30 s stale time, 10 minutes in memory. `sessionScope()` (user, restaurant, outlet) belongs in every key. Cleared on sign-out. The restaurant dashboard and its panels use it; other pages load with `useEffect` and service calls. |
| Lists | `apps/business-web/src/components/DataGrid/` | The usage comment at the top of `DataGrid.jsx` is the manual. Business lists use `useServerList()` from `modules/business/core/pages/hooks.js` for server paging and search. |
| Overview panels | `modules/business/core/pages/BusinessAdminRoutes.jsx` (`screens()`, `OverviewSheet`), `overviewLink.js` | An action on a business's Overview opens the real screen in a wide panel over it (`?open=<section>`, with *Open full page*). The panel and the route use the same `screens()` map, so they cannot drift apart. |
| Motion | `components/motion.js` + `packages/ui/src/styles/motion.css` | Only transform and opacity move; nothing waits for an animation; `prefers-reduced-motion` turns it off. |
| Theme tokens | the top of `packages/ui/src/styles/base.css` (`:root`, then a dark-mode block), with `colour.css` beside it. Both apps load them through `@bmp/ui/styles.css` | Pages use `var(--…)` and never restate a hex value. |
| Words per type | `services/businessNav.js` (`TYPE_WORDS`, `word()`); the menu's own labels in `services/businessWorkspace.js` (`workspaceLabel()`) | A salon says Clients, a kirana says Udhaar. |

### What not to do

- **Don't rename or renumber applied migrations.** `pgmigrations` records
  each file name. Plan F (a baseline before go-live, §9.3) is the way to tidy
  them.
- **Don't move everything at once.** One step, one check.
- **Don't create empty folders for industries.** A planned *screen* gets a
  route and a placeholder page instead (§8.9).
- **Don't add a second stock, bill or payment table** inside an industry
  folder.
- **Don't trust the screen.** Every rule a screen applies is checked again on
  the server.
- **Don't import one app's files from another app.** Share through a
  package.
- **Don't mix payment kinds.** Subscription payments (a business pays for the
  platform) and sale payments (a customer pays a business) stay separate.

---

## 8. How to …

Every recipe ends with the same three steps:

- run the tests ([TESTING.md](TESTING.md));
- update the docs that describe what you changed: [API.md](API.md),
  [DATABASE.md](DATABASE.md) and [ADMIN_GUIDE.md](ADMIN_GUIDE.md), plus
  [BUSINESS_RULES.md](BUSINESS_RULES.md) when a rule is added or changed and
  [GLOSSARY.md](GLOSSARY.md) when a word is added;
- back up before applying a migration to a database that matters
  ([GO_LIVE › Backups and restore](GO_LIVE.md#5-backups-and-restore)).

### 8.1 Add a feature to a business type

Example: a new salon screen.

1. **Migration** (§8.5): new `salon_*` table(s) with
   `business_id BIGINT NOT NULL`, `UNIQUE (business_id, id)`, composite
   foreign keys to the core rows they hang off, and triggers for any rule that
   protects money or stock. If the feature needs its own switch, add a module
   (§8.3); if it needs its own action, add permissions (§8.4). A table that
   keeps a customer's details (a foreign key to `business_contacts`) gets its
   entry in `modules/personal-data/services/personalDataRegistry.js`: what the
   access export shows, what an erasure blanks, or why it is kept; a guard
   that keeps closed rows as they were lets the erasure's change through
   (`business_privacy_erasing`). `personal-data.test.js` fails on a table the
   registry does not name (§4.6).
2. **Service:** add functions to
   `modules/business/salon-weight/services/businessSalon.service.js` (or a new
   `businessSalonX.service.js`). The pattern:
   `repo.transaction(async (db) => { … })`; re-check record-dependent
   permissions with `access.require`; use
   `request_key` + hash for anything that posts; call `repo.audit(db, …)`
   and, for money, stock or appointments, `repo.event(db, …)`. Money goes
   through `postDocument`: never write `business_documents` directly. A
   reminder to a customer checks their consent first
   (`consents.requireReminder`), and a new customer's consents are taken
   with them (`consents.apply`, through `createContact`).
3. **Route:** in
   `modules/business/salon-weight/routes/businessSalonWeight.routes.js`,
   `router.post(b('/salon/…'), context('module.action'), handler)`. A new
   paged list goes through `repo.addLists`, so it gets paging, search and
   period filters like the others.
4. **Screen:** a page in `modules/business/salon/pages/`; its entry in
   `screens()` in `modules/business/core/pages/BusinessAdminRoutes.jsx`
   (`"section": <MyPage />`), which gives it its route, guarded by
   `page("section", …)`, and lets the Overview open it in a panel (a screen
   with an id in its address gets a `<Route>` of its own there, wrapped in
   `page()`); a link in `businessSections()` in
   `services/businessNav.js` with `need`, `module` and `types: SALON`; and its
   section in the right workspace of `services/businessWorkspace.js`
   (`WORKSPACES`), or the menu will not show it. The steps in full:
   [apps/business-web/README.md › Adding a page](../apps/business-web/README.md#adding-a-page).
   A button that messages a customer goes through `useConsentGate` or
   `ConsentLink` (`modules/personal-data/`), and a print adds the business's
   privacy line (`printLine.js`).
5. **Tests:** extend `tests/integration/business-salon-weight.test.js`:
   allowed and refused roles, the module switched off, ids from another
   business, an idempotent repeat.

A restaurant feature takes the same steps on the restaurant side: a
controller between the route and the service, a `<Route>` in `App.jsx`
inside the right `ProtectedRoute`, a link in `NAV_SECTIONS`
(`layouts/AppLayout.jsx`) and its path in an area of
`services/restaurantWorkspace.js`.

### 8.2 Add a new business type

1. **Migration:** `INSERT INTO business_types (code, name)`, and rows in
   `platform_module_business_types` for each module it may use and which are
   on by default, listed explicitly: a module that an older migration gave to
   "every type" reached only the types that existed then (catalog, contacts,
   sales, inventory, purchasing, stock counts and transfers, receivables,
   expenses, tasks, issues and projects). A goods shop also goes into
   `business_seed_settings()`, and a trade's own pack words and measures
   into `business_seed_units()` (pattern: 1791960000000 more-business-types). The `AFTER INSERT` triggers on `businesses` then give each
   new business of that type its roles, settings, GST slabs, units, payment
   methods and default modules. A role only this type has (as a pharmacy's
   Pharmacist) is a role template with the type in
   `business_role_templates.business_types`.
2. If it needs a new document kind, widen the
   `business_number_series.document_kind` CHECK **keeping the whole list**,
   and add the kind with its prefix to `SHORT` in
   `modules/business/core/services/businessNumbering.js` (`KINDS` is its
   keys).
3. **Extension tables** named `<type>_*` (§8.1). Never add a column to a core
   table for one type.
4. **Backend:** a module folder `modules/business/<type>/` with
   `services/business<Type>.service.js`, and either a new
   `routes/business<Type>.routes.js` mounted at the end of
   `modules/business/core/routes/business.routes.js` (before the error
   mapper) like the others, or routes in an existing type's file.
5. **Staff app:** the type's groups in `services/businessTypes.js` (goods
   shop, retail reports, service, udhaar; the server's goods list in
   `modules/business/core/services/businessTypes.js` must match, and
   `business-shared-commerce.test.js` checks it), `TYPE_WORDS` and
   `TYPE_ICONS` in `services/businessNav.js`, links with `types: [...]`, its menu in `dailyWorkspaces()` in
   `services/businessWorkspace.js`, and pages in
   `modules/business/<type>/pages/`. When the type keeps more about a
   customer than a name and a number, its line in `KEPT` in
   `modules/personal-data/services/privacyNotice.js` (the starter privacy
   notice).
6. **Tests:** add the type to `NAMES` in
   `tests/integration/helpers/businesses.js`, so tests can create one, its
   specialist tools to `SPECIALIST` in `helpers/tools.js`, the type count in
   `tasks.test.js`, and to `ALL_TYPES` in `modules/tasks/library/index.js`
   (or it gets no common checklists); then write
   `tests/integration/business-<type>.test.js`. For the browser tests,
   add it to `BUSINESSES` in `e2e/test-data.mjs` and to the type lists of
   `business-workspaces.spec.js` and `business-workspace.test.js`
   ([TESTING › Adding data](TESTING.md#adding-data)).

Pharmacy and clinic / lab have their own module (`business/health`).

### 8.3 Add a module switch

**Business platform module** (the pattern of
`1791430000000_salon-packages-memberships-commissions.sql`):

1. `INSERT INTO platform_modules (code, name, description, kind, sort_order)`
   with `kind = 'optional'`.
2. `platform_module_dependencies` for what it needs.
3. `platform_module_business_types` for the types it applies to and the
   default (new businesses start lean: specialist tools default to off), with
   `recommended` and a `recommended_note` for a trade that mostly uses it.
4. Switch it on for **existing** businesses whose type has it on by default
   (`INSERT INTO business_capabilities … SELECT … ON CONFLICT DO NOTHING`),
   only where its dependencies are on.
5. Its permissions (§8.4).
6. Write the Down half (delete the capabilities, grants, permissions and
   module rows).
7. Staff app: links with `module: "<code>"`, or a `need` whose module is the
   new code. Nothing else: Settings › Business tools reads the catalogue.

The server caches the catalogue per process (`platformCatalogue()`), so
**restart the API after the migration**.

**Restaurant feature:** the same rows, with `feature_group` set and applying
to `restaurant`. Then `requireFeature("code")` on its routes, `feature="code"`
on its `ProtectedRoute` and menu link, its name in `FEATURE_NAMES`
(`apps/business-web/src/services/features.js`), and `feature:` in its
notification provider. Add a rule in `restaurantFeatures.service.js` if
switching it off could strand money, and add the feature to a format's
`features` in `restaurantFormat.service.js` if that format should start with
it.

### 8.4 Add a permission

**Business permission:**

1. Migration: `INSERT INTO business_permissions (code, module_code, action, name, sort_order)`.
   `action` is one of view / create / edit / approve / cancel / refund /
   export / print / discount / assign / review / manage / view_clinical /
   edit_clinical (a CHECK; widen it with the whole list for a new one).
2. Grant it to templates (`business_role_template_permissions`) and to
   existing businesses' copies of those templates
   (`business_role_permissions … JOIN business_roles r ON r.template_code = …`),
   skipping `full_access` roles: the Owner already has everything.
3. Check it in the route (`context('module.action')`) or the service
   (`access.require`). Show buttons with `biz.can('module.action')`.

**Restaurant permission:**

1. Migration: `INSERT INTO permissions (code, module, name, description)`,
   and grant it to the system roles in `role_permissions` that should have
   it.
2. Route: `authorize("code")`, or `authorizeOrApprove("code", { scope })`
   when a manager may approve it on the spot. If it is checked inside a
   handler, call `authorize.noteEnforced("code")` in the routes file.
3. Staff app: `hasPermission("code")` from `useAuth()`, and the menu link /
   `ProtectedRoute permission`.

The full code lists: [DATABASE › Business permission codes](DATABASE.md#business-permission-codes)
and [DATABASE › Restaurant permission codes](DATABASE.md#restaurant-permission-codes).

### 8.5 Add a migration

1. `cd backend && npm run migrate:create -- <short-name>` creates
   `migrations/<timestamp>_<short-name>.sql`. The timestamp must be **greater
   than the newest file in the folder**; rename the file if it is not.
   `checkOrder: true` in `scripts/migrate.js` refuses to run a file older
   than the last one applied.
2. Write both halves, with the markers `-- Up Migration` and
   `-- Down Migration`. Down is for test databases; the real rollback of a
   live database is restoring the backup.
3. **Never edit a migration that has been applied anywhere** (your database,
   a colleague's, a server). Fix forward with a new file.
4. A CHECK that lists values (`document_kind`, payment `method`,
   `retail_sale_discounts.source`) must be rewritten **with the whole list**:
   other work may have widened it.
5. Back up (`npm run db:backup -- --verify`), then run `npm run migrate:up`,
   then restart the API.

Applied migrations are recorded in `pgmigrations`; never edit that table by
hand. On start-up the API checks that every migration file has been applied.
If one has not, it refuses to start and prints the `npm run migrate:up`
command (`src/utils/migrationStatus.js`). The integration tests build a fresh
database from these files on every run.

### 8.6 Add a screen with a DataGrid

1. A page file in the right module's `pages/` folder
   (`modules/restaurant/<area>/pages/` or `modules/business/<…>/pages/`).
2. Data: a function in the module's `services/*.service.js` (`businessRead`
   for business screens). For a business list, use
   `useServerList(path, { gridId, period })` and spread `list.gridProps` onto
   the grid. For a restaurant list, load the rows and let the grid page them,
   or pass `server={…}` for API paging.
3. `<DataGrid id="stable-id" caption=… columns=[…] rows=… rowNoun=… empty=… />`.
   Give each column `key`, `header`, `value`, a `type` (money, date, status,
   actions) and `mobile` (title / subtitle) for phone cards. Keep S.No. on.
   `exportName` adds CSV export: show it only to people allowed to export.
4. Route and menu: for the restaurant, a `<Route>` in `App.jsx` inside the
   right `ProtectedRoute`, a link in `NAV_SECTIONS` (`layouts/AppLayout.jsx`)
   and its path in an area of `services/restaurantWorkspace.js`; for a
   business, §8.1 step 4.
5. Styles: the module's stylesheet in its `styles/` (a sheet several modules
   use stays in `src/styles/`), using tokens only.
6. Optional: a browser check in `apps/business-web/tests/browser/`
   ([TESTING › Browser tests](TESTING.md#browser-tests)).

### 8.7 Add a report

**Restaurant** (module `modules/restaurant/reports/`):

1. The SQL in the family's file under `repositories/report/` (shared
   fragments in `report/sql.js`).
2. The function in the family's file under `services/report/` (dates by
   trading day through `report/scope.js`, the outlet from `reportOutlet`).
   Add each to the index file's exports (`report.repository.js`,
   `report.service.js`).
3. A handler in `controllers/report.controller.js`, and a line in
   `routes/report.routes.js` with `authorize("reports.view")` plus the data's
   own permission (for example `sales.view`), and `requireFeature` if it
   belongs to a feature.
4. In the staff app, a function in
   `modules/restaurant/reports/services/report.service.js` and a tab file in
   `modules/restaurant/reports/pages/` (wired from `ReportsPage.jsx`), with
   CSV through `reportCsv.js` or the grid's export.

A new family of reports is a new file in each `report/` folder, not a longer
one.

**Business:** a function in the type's reports service (for example
`businessRetailReports.service.js`) or in `business.service.reports`; a route
with `context('reports.view')` plus the data's permission; a page in
`modules/business/…/pages/`; a link in the Reports group of `businessNav.js`
and its section in the `reports` workspace of `businessWorkspace.js`. Report
money from posted documents, with each return on its own day.

### 8.8 Add an outside integration through the events outbox

The outbox holds every money, stock and appointment change
(`business_events`: `business_id`, `kind`, `entity_type`, `entity_id`,
`payload`, `actor_id`, `created_at`, `published_at`). Live screens already
hear of each event as it commits (a trigger announces it, §3.5) but read
nothing back and stamp nothing: that is for staff screens only. To connect SMS,
WhatsApp, a webhook or accounting:

1. Write a **publisher** process (for example `backend/src/workers/publisher.js`
   with an npm script), separate from the API. In a loop: `BEGIN; SELECT …
   FROM business_events WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR
   UPDATE SKIP LOCKED` (served by the partial index
   `business_events_unpublished`), deliver each, `UPDATE … SET published_at =
   now()`, `COMMIT`. The trigger allows only that one stamp, once.
2. Each **consumer** filters by `business_id` and by the business's
   capability and the person's consent to the message's purpose
   (`business_consents`, read through `personal-data/services/consents.js`),
   and must be idempotent by event id: a crash after delivery and before the
   stamp sends the event again.
3. Add retries with back-off, and a dead-letter record for events that keep
   failing. Never block the queue on one event.
4. Keep provider keys in `.env` (and fake values in `.env.example`).
5. Write a new kind of event with `repo.event(db, …)` inside the posting's
   transaction, never after the commit.
6. Restaurant postings write no events. Add them inside their transactions
   first (§9.3, plan E, step 3); the restaurant's live screens do not need
   them (they hear of changes from triggers on its tables, §3.5).

### 8.9 Turn a planned screen into a real one

- Build it in its module.
- Point its route at the real page, and delete its entry in
  `plannedWorkspaces.js` or `plannedPages.js`.
- A role screen is a route group and a layout in the staff app, in
  `src/workspaces/<role>/`, reusing the area modules. It is not a new app.
  The captain app is the first: `App.jsx` mounts `/captain` with its layout
  (`workspaces/captain/CaptainLayout.jsx`: its own header, the lock screen,
  tabs at the thumb, the floor read once and shared by its screens through a
  context) and its screens as child routes, behind the same `ProtectedRoute`
  as the POS. A screen it shares with an area (the POS's order screen) takes
  a prop for the role's layout rather than being copied.
- A business's role screen works the same way for the business in its
  address. The clinic and lab workspaces: `/clinic` and `/lab` open the
  clinic chosen last or ask which (`layouts/WorkspaceStart.jsx`), and
  `/clinic/:businessId/…` and `/lab/:businessId/…` have their layouts
  (`layouts/BusinessWorkspace.jsx`: the bar, the tabs, the lock screen, and
  the business opened through `BusinessProvider`'s `businessId`, with the
  workspace's addresses in its `paths`, so a Business Admin page it shows
  links within the workspace). Business Admin's menu links to them through a
  link's `href` in `businessNav.js`, shown only to those who may open them.

**Something new and planned:** add the route and an entry in the planned
list first, so the address works from day one.

---

## 9. Where the structure is going

What is left to build, in order, is in
[BACKLOG.md › At a glance](BACKLOG.md#at-a-glance). This section covers the
shape of the code and the data.

### 9.1 Known weak spots

| Weak spot | What it is | Why it matters |
| --- | --- | --- |
| **Very large files** | `PosPage.jsx` (about 3,000 lines, nearly all one component: it needs a real refactor, not a move), `order.service.js` (about 2,600), `InventoryInsightsPage.jsx` (about 2,500), `order.repository.js` and `TimeClockPage.jsx` (about 2,400 each), `bill.repository.js` (about 2,300), `KitchenDisplayPage.jsx` (about 2,200), and `base.css` in `packages/ui` (about 3,200). | Slow to read and risky to change. |
| **Migrations** | Many files fix earlier ones, and a fresh database replays them all. | A baseline before go-live (plan F) makes new installs simple. |
| **Outside messages** | Staff screens are live (§3.5), but nothing publishes the outbox outside: no WhatsApp, SMS or webhook. The guests' pages still ask every few seconds. | §8.8 describes the publisher; plan E, step 3 adds the restaurant's events. |
| **Kept answers** | The dashboard's and the bell's answers are kept per API process (`utils/dashboardCache.js`, `notifications/index.js`), and so is the standing behind an owner's GST thresholds (`gst-thresholds/services/standingCache.js`, five minutes). A change the database announces clears the first two in every process (§3.5); any other write (an expense, a purchase, stock) only in the one that made it, and a PAN recorded or a warning level saved clears the GST standing only there. | Several API processes need a shared cache, or sticky sessions, for those. |

### 9.2 Target structure

The tree below is where the folders are heading: today the backend has no
`core/` folder (config, middlewares and utils sit at the top of `src/`), and
the business core is one module, `business/core`, because
`business.service.js` serves all its areas.

```
backend/src/
  core/                 config, db (pool, transaction helper, guard), http (AppError, errorHandler,
                        validate), auth (authenticate, access), audit, events
  modules/
    platform/           catalogue, businesses, memberships, roles      {routes,controllers,services,repositories,tests}
    catalog/  contacts/  documents/  stock/  appointments/  receivables/
    restaurant/         menu/, floor/, orders/, kitchen/, billing/, cash/, guests/, stock/, staff/, reports/
    retail/  wholesale/  fashion/  electronics/  salon/  weight/  health/
    tasks/              (already its own module, shared by both worlds)
  notifications/        unchanged (providers per module)
  app.js  server.js

apps/business-web/src/        the staff app
  core/                 api.js, queryClient, auth and business context, ProtectedRoute, layout
  components/           shared UI, DataGrid (unchanged)
  workspaces/           what each role sees, assembled from the modules: admin, pos, kitchen,
                        collection, captain, clinic, lab
  modules/
    business/           core screens (overview, settings, catalogue, documents, stock …)
    restaurant/         pos/, menu/, kitchen/, reports/, …
    retail/  wholesale/  fashion/  electronics/  salon/  weight/  health/  tasks/
  styles/               sheets several modules use; each module imports its own stylesheet
apps/customer-web/src/        the guests' site: table-order/, online-order/, booking/, later shop/,
                              appointments/, account/
apps/platform-admin/          later: the platform console, when it ships on its own
packages/ui, packages/shared  what the apps share: the look and components, formatting and rules
```

In the data: the restaurant on the shared core, with `restaurant_*`
extension tables (modifiers, recipes, tables, KOTs, kitchen stations, captain
sections…); one identity and one role system per business; a migration
baseline.

### 9.3 Plans D, E and F

Do them in this order: **D** (identity), **E** (the restaurant on the core),
**F** (a baseline, just before go-live). Each step is one commit. After each
step run `npm test`, `npm run test:integration`, `npm run lint` and
`npm run build`, `npm run test:browser` when screens changed, and walk through
the screens it touched ([TESTING.md](TESTING.md)).

**D. One identity and one role system per business**

1. Make sure every restaurant has its `businesses` row
   (`restaurant_business_id()` creates it when missing) and every active
   restaurant user a membership (a migration).
2. Add the restaurant's permission codes to `business_permissions` under
   restaurant modules (`orders`, `billing`, `kitchen` …, each a
   `platform_modules` row applying to `restaurant`), with a mapping table from
   the old code to the new.
3. Give each restaurant's business copies of its restaurant roles (Admin →
   Owner, Manager, Cashier, Captain, Kitchen, Collection display, and each
   custom role) with the mapped permissions, and set each membership's role
   from `user_roles`. Test: for every user, the old permission set equals the
   new one (a test that loops over a restored copy of a real database).
4. **Shadow mode:** `authenticate` computes both sets and logs any
   difference. Run the full test suite and a day of real use on a test
   server.
5. Switch `req.user.permissions` to the membership-based set. Approvals, PIN
   sign-in, outlet pinning and two-step roles move to the membership and
   business scope (an outlet pin becomes the membership's location:
   `business_memberships.location_id` exists). Tests: the access suites
   (`staff-and-sign-in`, `two-step-and-tied-approvals`) and the suites that
   ask for a manager's approval.
6. One role editor (the business one) for everyone; the restaurant's Roles
   page sends people to it.
7. A release later: stop using `users.restaurant_id` and `outlet_id`, then
   drop the `roles`, `user_roles`, `role_permissions` and `permissions` tables
   (a new migration, after a backup). The platform Super Admin becomes a
   platform role (a small `platform_staff` table) rather than a user without
   a restaurant.

**E. The restaurant on the shared core**

Principle: **dual-write, compare, switch reads, retire**, one area at a time,
keeping the old tables until the reports agree.

1. **Feature switches:** in place (§4.2). The restaurant's module gate is the
   platform's capability table.
2. **Locations:** link each `outlets` row to a `business_locations` row
   (`outlets.location_id`), kept in step in the same transaction.
3. **Events:** write `business_events` (bill raised, payment, refund, credit
   note, stock consumed, purchase received) inside the restaurant's own
   transactions, using the bridged `business_id`. Purely additive. Move the
   `logAction` rows into the same transactions as well.
4. **Master data:** `customers` → `business_contacts` (kind customer),
   `suppliers` → `business_contacts` (kind supplier), `units` →
   `business_units`, `tax_rates` → `business_tax_rates`. Add a link column on
   each old table, back-fill it, write both on every change, then read from
   the core. Tests: the guest book, loyalty and purchasing suites.
5. **Menu:** `products` / `product_variants` → `catalog_products` /
   `catalog_skus` (kind goods or service). Restaurant-only parts become
   extension tables (`restaurant_menu_items` for the kitchen station, course
   and availability; modifiers, recipes and combos keep their tables,
   re-keyed to the SKU).
6. **Stock:** `inventory_items` → SKUs; `stock_transactions` /
   `inventory_batches` → `business_stock_lots` / `business_stock_movements`.
   Dual-write, then compare the closing stock per item per store on every day
   of a full trading period; switch when they are equal.
7. **Money:** bills → `business_documents` (kind sale) with a
   `restaurant_bill_details` extension (order, table, service charge,
   delivery charge, covers, tips); payments → `business_payments`; credit
   notes → `business_returns`; numbering → `business_number_series`. This is
   the largest step: dual-write for a full trading period, compare every
   report (day end, GST, sales, P&L) to the paisa, then switch the reads
   report by report.
8. **Retire** the old tables a release after the last read moves (a new
   migration, after a backup).

**F. Migration baseline before go-live**

1. When no more schema changes are expected, run all migrations on a fresh
   database, then write `pg_dump --schema-only` plus the catalogue data
   (`business_types`, `platform_*`, `business_permissions`, the role
   templates, the restaurant's `permissions` and system roles) into one
   `migrations/<new timestamp>_baseline.sql`.
2. Move the old files to `migrations/archive/`, out of the runner's folder.
3. Fresh installs run the baseline. For an existing database, insert the
   baseline's name into `pgmigrations` by hand once, after a backup, so it is
   not run again.
4. Test: a database built from the baseline and one built from the old files
   give the same `pg_dump --schema-only` (diff them), and the integration
   suite passes on the baseline.

### 9.4 Folders that wait for their first piece

| Folder | What goes in it | Made when |
| --- | --- | --- |
| `backend/src/integrations/` and `backend/src/jobs/` | The payment gateway and SMS / WhatsApp; expiry and low-stock alerts | The first integration is built |
| `apps/platform-admin/` | The platform console as its own app | The platform team releases on its own |
