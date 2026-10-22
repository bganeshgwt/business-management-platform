# Code structure: the map, the rules, and where it is going

Updated 22 October 2026 (the web side became two apps and two shared
packages on 21 October). For anyone adding code: how to think about it,
where everything is, every address the platform answers, and the next steps.
The details (request flow, database, how-to recipes, the longer plans) are in
[ARCHITECTURE.md](ARCHITECTURE.md); this page and that one say the same
thing.

## 1. How to think about it: six rules

1. **Organise by business area first, then by technical layer.** Look for
   "orders" or "salon" first, then for the service or the page inside it.
2. **One owner per business record.** Exactly one module writes a given table
   (stock, bills, payments…). Other modules call that module's service and
   never write its tables themselves.
3. **The backend decides, the screen shows.** Prices, permissions, stock and
   payment status are checked on the server. Hiding a button is only for
   convenience.
4. **The database is the truth.** Migrations only. Guards that must never
   break (posted bills, released reports) are database triggers. Live screen
   updates come after the commit, and a screen that reconnects reloads from
   the database.
5. **Build folders when the feature arrives.** Future industries are written
   down here, not created as empty folders.
6. **A planned screen has its address already.** It opens a page that says
   what is coming and what to use until then, never "Page not found". When the
   screen is built, it takes over the route.

## 2. The layout

```
business-management-platform/
├── apps/
│   ├── business-web/     The staff app (React + Vite, :5173 in development): Business Admin for
│   │                     every type, the restaurant admin, POS, kitchen display, pickup screen,
│   │                     platform console
│   └── customer-web/     The guests' site (React + Vite, :5174): table QR ordering, online
│                         ordering, table booking. No sign-in, no staff code.
├── packages/
│   ├── ui/               @bmp/ui: the look (tokens and global styles), Icon, menu choice
│   │                     components
│   └── shared/           @bmp/shared: money, number and date formatting, API dates, menu
│                         choice rules
├── backend/              One Express API and one PostgreSQL database for both apps; its own
│                         install (migrations/, scripts/, tests/)
├── docs/
├── .github/workflows/    CI: backend tests, then lint, unit tests and both builds
├── .oxlintrc.json        One lint configuration for apps/ and packages/
└── package.json          npm workspaces (apps/*, packages/*) and every command
```

Every command runs from the root: `npm run dev:backend`, `npm run
dev:business`, `npm run dev:customer`, `npm run lint`, `npm run build`,
`npm test`, `npm run test:integration`, `npm run test:browser`.

## 3. Every address

**Staff app** (`apps/business-web`)

| Address | For | State |
| --- | --- | --- |
| `/` | Owners and managers: the restaurant dashboard; other businesses open their Business Admin | Built |
| `/orders`, `/menu/…`, `/reports`, `/tasks/…` … | The restaurant admin's screens, one per menu link | Built |
| `/login`, `/profile`, `/notifications` | Everyone: signing in, their own profile, every alert | Built |
| `/business-admin/:id/…` | Every business type's admin: sales, stock, customers, the type's own screens | Built |
| `/pos` | Cashiers and captains | Built |
| `/kitchen` | Kitchen staff: the kitchen display (KOTs print from the POS) | Built |
| `/collection` | The pickup counter's TV | Built |
| `/platform/…` | The platform team | Built; moves to its own app later |
| `/captain` | Waiters, on a phone | **Planned.** The page says what is coming; today: POS and Table requests |
| `/clinic` | Reception and doctors | **Planned.** Today: the clinic's token queue and patients in Business Admin |
| `/lab` | Lab staff | **Planned.** Today: the clinic's lab orders and tests in Business Admin |
| `/order/…`, `/online/…`, `/book/…` | Old guest links | Sent on to the guests' site, path and query kept |

**Guests' site** (`apps/customer-web`)

| Address | For | State |
| --- | --- | --- |
| `/order/:token` | A guest at a table, from its QR code | Built |
| `/online/:token` | Ordering for pickup or delivery, and the order's status | Built |
| `/book/…` | Booking a table, and the booking's status | Built |
| `/shop/…` | A shop's customers ordering online | **Planned** ("Coming soon" page) |
| `/appointments/…` | Salon and clinic clients booking | **Planned** |
| `/account` | A returning guest's orders, bookings and points | **Planned** |
| Anything else | A link with part missing, or the bare address | A page that says how to open the right link |

The planned pages are listed in `apps/business-web/src/services/plannedWorkspaces.js`
and `apps/customer-web/src/plannedPages.js`.

## 4. Two engines, one direction

The food engine (restaurant, café, bakery, cloud kitchen: `restaurants`,
`products`, `orders`, `bills`) and the shop and clinic engine (`businesses`,
`catalog_skus`, `business_documents`) have their own tables today. Both are
complete and tested.

They come together through ARCHITECTURE.md §7.3:
- **Plan D:** one identity and role system per business.
- **Plan E:** the restaurant on the shared core, with `restaurant_*` extension
  tables.

Each is its own tested step, never mixed with a folder move. Until then:
- anything new that both engines need is built once, in a module of its own
  (as `tasks/` is), in `platform/`, `access/` or `packages/`, and used by both;
- nothing new copies one engine's tables into the other.

## 5. Who owns what

| Record | Food engine owner | Shop & clinic engine owner |
|---|---|---|
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
wholesale routes) and calls `core` for stock, bills and payments. It never
keeps a stock or bill table of its own.

## 6. Inside a backend module

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
  - The shop engine has no controllers: each route calls its service, the
    service reads and checks the request, and both use the shared helpers in
    `business/core/repositories/business.repository.js` (`page`, `one`,
    `transaction`, `audit`, `event`).
  - New code follows the style of the folder it goes into. Old files are not
    renamed just to match.
- Errors: `throw new AppError(409, "A clear sentence for the user")`.
- Every change a person makes to money or stock writes an audit row.

The request flow:

```
Screen → area API file → api.js → route → authenticate → outlet / business scope
  → module switched on? → permission → validation → controller → service
  → repository → PostgreSQL → JSON → screen
```

## 7. Inside a web app

```
apps/business-web/src/
├── main.jsx · App.jsx    the shared look first, providers, every route
├── modules/              areas named as on the backend (restaurant/orders/ …), one folder per
│                         business type (business/salon/ …); each with pages/, services/ (API
│                         calls), styles/
├── layouts/              AppLayout, NotFoundPage, PlannedPage, GuestSiteRedirect
├── routes/               ProtectedRoute
├── components/ · services/ · styles/ · hooks/ · context/   what several modules share

apps/customer-web/src/
├── main.jsx · App.jsx    the shared look, the guest routes
├── modules/              table-order/ (pages/, services/); online-order/, booking/ (pages/, services/, styles/)
└── pages/                StartPage, PlannedPage
```

**Where shared code goes:**
- Used by two apps: a package, imported by name (`import Icon from
  "@bmp/ui/Icon"`, `import { money } from "@bmp/shared/format"`).
  - React components and styles go in `packages/ui`.
  - Plain functions go in `packages/shared`.
- Used by one app only: stays in that app.
- An app never imports another app's files.

**Two rules for the guests' site:**
- It must never send a staff token. Its pages use their own API clients with
  no login.
- It is checked on every run of its browser tests.

POS and Captain will both use `modules/restaurant/orders`, with no copy.
Which pages a business sees comes from its switched-on modules (a
restaurant's features, `features.js`; any other business's modules, read by
`businessNav.js`) and the user's permissions. The backend checks both again.

## 8. Adding something

**A feature** (as brands, pre-orders and clean copies were done):
1. Migration, plus a `platform_modules` row if the business can switch it on or off.
2. Backend: route, controller (the shop engine has none: its service checks
   the request), service, repository, in the owning area.
3. Web: page in the area's `pages/`, its route (`App.jsx` /
   `BusinessAdminRoutes.jsx`), plus a menu entry: a restaurant's in
   `NAV_SECTIONS` (`layouts/AppLayout.jsx`) and an area of
   `restaurantWorkspace.js`; any other business's in `businessNav.js` and a
   workspace of `businessWorkspace.js`.
4. Integration test against a fresh database.
5. Demo data; `API.md`, `DATABASE.md`, `ADMIN_GUIDE.md` and the overview.

**An industry** (say, textiles):
- `backend/src/modules/business/textiles/` and
  `apps/business-web/src/modules/business/textiles/`, built on `core`.
- Add its set-up tables (not its records) to `TABLES` in
  `businessClone.service.js`, so clean copies keep its set-up.

**A planned screen becomes real:**
- Build it in its module.
- Point its route at the real page, and delete its entry in
  `plannedWorkspaces.js` or `plannedPages.js`.
- A role screen such as `/captain` or `/lab` is a route group and a layout in
  the staff app, reusing the area modules. It is not a new app.

**Something new and planned:** add the route and an entry in the planned list
first, so the address works from day one.

## 9. Steps: done and next

Each step is separate, ships alone, and ends with every check green.

| Step | What | State |
|---|---|---|
| 1 | npm workspaces at the root; `frontend/` → `apps/business-web/` (history kept) | **Done** 21 Oct 2026 |
| 2 | `apps/customer-web` split out (guest pages, 0.56 MB of files, no staff code); `packages/ui` and `packages/shared` | **Done** 21 Oct 2026 |
| — | Planned addresses: `/captain`, `/clinic`, `/lab`, `/shop`, `/appointments`, `/account` | **Done** 21 Oct 2026 |
| 3 | `workspaces/` in the staff app: POS, kitchen, collection, captain, clinic and lab layouts gathered by role | When the first planned workspace is built |
| 4 | `integrations/` and `jobs/` in the backend: payment gateway, SMS/WhatsApp, expiry and low-stock alerts | With the first integration |
| 5 | `apps/platform-admin` | When the platform team releases on its own |
| D–F | ARCHITECTURE.md §7.3: one identity per business, the restaurant on the core, a migration baseline before go-live | Planned |

**Known follow-ups:**
- **Trim the guests' stylesheet.** The guests' site loads the whole shared
  stylesheet. That is exactly what the guest pages had before, so they look
  the same. Trimming the staff-only rules out of `@bmp/ui` is a later change
  of its own, checked screen by screen.
- **A backend default guest address.** Give the backend its own default guest
  address (a `GUEST_WEB_URL` setting) before the first SMS, WhatsApp or e-mail
  link is sent. Today only the staff app knows the guests' site's address.
- **Table requests' "Open guest menu" link.** It opens the platform's guests'
  site, even when a restaurant has its own guest web address. Both serve the
  same page.

## 10. What not to do

- **Don't rename or renumber applied migrations.** `pgmigrations` records each
  file name. Plan F (a baseline before go-live) is the way to tidy them.
- **Don't move everything at once.** One step, one check.
- **Don't create empty folders for industries.** A planned *screen* gets a
  route and a placeholder page instead.
- **Don't add a second stock, bill or payment table** inside an industry folder.
- **Don't trust the screen.** Every rule a screen applies is checked again on
  the server.
- **Don't import one app's files from another app.** Share through a package.
- **Don't mix payment kinds.**
  - SaaS subscription payments: the business pays us.
  - Sale payments: a customer pays the business.

  They stay separate.
