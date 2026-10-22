# Business Management Platform

**Start here:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the vision, where everything lives, why, and how to extend it. [docs/CODE_STRUCTURE.md](docs/CODE_STRUCTURE.md) is the same map on a few pages: the folders, every address, and the next steps.

One platform for independent businesses of twelve types: restaurants,
grocery / kirana, supermarkets, wholesale / FMCG, fashion, electronics,
pharmacy, books & stationery, salons & spas, clinics & labs, meat & seafood,
and other weight-based shops. Each business's data is kept apart, and one
person can belong to several businesses.

**Two web apps share one API.** The **staff app** (`apps/business-web`) is
where owners and staff work: a switcher in the header opens any business you
belong to, with a menu built from the modules that business uses and the
permissions your role there gives you; the POS, kitchen display and pickup
screen are part of it. The **guests' site** (`apps/customer-web`) is what a
restaurant's guests open from a table's QR code, the online ordering link or
the booking link; nobody signs in there.

- The **restaurant** is the most complete type: menu, tables and QR ordering,
  POS, kitchen display, captain sections, reservations and online booking,
  online ordering, deliveries and rider cash, billing with GST, cash drawers,
  inventory with batches and recipes, purchasing, guests and loyalty, staff,
  time clock, payroll and tips, and a full set of reports. It can also run as
  a café, a bakery (selling by weight, cake pre-orders, the day-end unsold
  count) or a cloud kitchen (several brands from one kitchen).
- **Retail** (grocery, supermarket, books): quick bill with barcode and scale
  labels, offers and coupons, loyalty and member prices, branch prices,
  departments, cashier shifts, udhaar, barcode labels, book details.
- **Wholesale**: sales orders, dispatch and back-orders, routes and beats,
  price groups and schemes, purchase orders, collections and cheques,
  outstanding and ageing.
- **Fashion and electronics**: size × colour matrix, exchanges, serial / IMEI
  register, warranties, repair jobs, kits, EMI and financiers.
- **Salon & spa**: calendar, deposits, packages, memberships, commissions.
- **Meat and weight-based shops**: stock by weight, cutting and yield, wastage.
- **Pharmacy**: drug master, prescription sales, the H1 and Schedule X
  registers, expiry, returns and recalls.
- **Clinics and labs**: patients and consent, visits, doctors' fees and OPD
  sessions, the token queue, lab orders and results, report versions and QC.

Every type can run several locations (a restaurant calls them outlets). The
other types share payment methods named as the counter says them, daily
expenses and the day's money with cash checks; the restaurant has its own
payment types, expenses and cash drawers. The pharmacy and clinic rules follow
standard Indian practice; the owner reviews them with a pharmacist, a doctor
and a legal adviser before going live ([backlog](docs/REMAINING_BACKLOG.md)).

## Technology

| Layer | Technology |
| --- | --- |
| Web apps | React 19 + Vite 8 (Node.js 20.19+ or 22.12+), React Router 7, TanStack Query; npm workspaces (`apps/*`, `packages/*`) |
| Backend | Node.js 20.11+ and Express 5 (REST, JSON) |
| Database | PostgreSQL 15 or newer (built on 18) |
| Auth | JWT sessions, bcrypt passwords, optional two-step sign-in (authenticator app), staff PINs |
| Migrations | node-pg-migrate, plain SQL files in `backend/migrations` |
| CI | GitHub Actions (`.github/workflows/checks.yml`) on Node.js 24 and PostgreSQL 17 |

```
business-management-platform/
├── apps/
│   ├── business-web/   The staff app (React + Vite, :5173): src/modules/<module>/ (pages,
│   │                   services, styles), shared components, services and styles
│   └── customer-web/   The guests' site (React + Vite, :5174): table QR ordering, online
│                       ordering, table booking
├── packages/
│   ├── ui/             @bmp/ui: the shared look (tokens and global styles), icons, menu
│   │                   choice components
│   └── shared/         @bmp/shared: money and number formatting, dates, menu choice rules
├── backend/            Express API: src/modules/<module>/ (routes, controllers, services,
│                       repositories), src/ shared code, migrations/, scripts/ (setup, demo
│                       data, clean copies, backup), tests/ — its own install
└── docs/               Documentation (below)
```

## Running it locally

After installing dependencies and configuring the backend and the web apps,
start each in its own terminal from the project root:

```bash
npm run dev:backend       # the API
npm run dev:business      # the staff app, http://localhost:5173
npm run dev:customer      # the guests' site, http://localhost:5174
```

The old names `npm run dev-backend` and `npm run dev-frontend` (the staff app)
still work. Database updates can also run from the root:
`npm --prefix backend run migrate:up`.

### 1. Database

```sql
CREATE DATABASE restaurant_management_db;
```

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env      # then fill in DB_* and a random JWT_SECRET
npm run migrate:up        # build or update the database
npm run dev               # API on http://localhost:5010 (PORT in .env; auto-restart)
```

Every setting is explained in [`backend/.env.example`](backend/.env.example):
the database and its pool (`DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS`,
`DB_IDLE_TIMEOUT_MS`, `DB_POOL_GUARD`), `JWT_SECRET` (at least 32 random
characters; a live server refuses to start with a weak one), `TWO_FACTOR_KEY`,
sign-in limits, `CORS_ORIGIN`, `TRUST_PROXY` and `MULTI_BUSINESS_DEVELOPMENT`.

Create the first restaurant and its admin (it also creates its tax rates,
settings, delivery channels and main kitchen; never insert a restaurant by
hand):

```bash
npm run restaurant:create
# or all at once:
npm run restaurant:create -- --name "FoodEx Restaurant" --code ABC001 \
  --contact 9876543210 --address "Rajahmundry, Andhra Pradesh" \
  --admin-name "Ravi Kumar" --admin-email owner@foodex.in --admin-password "choose-a-strong-one"
```

More logins: `npm run user:create`. Local demo logins for each built-in role:
`npm run user:demo -- <RESTAURANT_CODE>` (development only; the passwords are
written to `backend/.local/`, never printed).

### 3. Web apps

One install at the root covers both apps and the shared packages:

```bash
npm install
cp apps/business-web/.env.example apps/business-web/.env   # VITE_API_BASE_URL, VITE_CUSTOMER_WEB_URL
cp apps/customer-web/.env.example apps/customer-web/.env   # VITE_API_BASE_URL
npm run dev:business      # staff app, http://localhost:5173
npm run dev:customer      # guests' site, http://localhost:5174
```

The backend's `CORS_ORIGIN` lists the staff app's address; the guests' site
needs no entry, because the public guest API answers any address. Guest links and table QR codes open `VITE_CUSTOMER_WEB_URL` unless a
restaurant sets its own guest web address in Service settings; old guest links
that open on the staff app are sent on to the guests' site.

### 4. Demo data

| Command (in `backend`) | What it does |
| --- | --- |
| `npm run seed:demo` | Fills the first restaurant (if its menu is empty) with a month of realistic trading through the real services: menu with recipes, ingredients, suppliers, tables, staff, guests, about 880 orders billed and paid. `-- --force` to run on a non-empty menu. |
| `npm run seed:topup` | Trades the demo restaurant forward from its last business day to today, leaving today open and part-traded. Safe to repeat; never touches a closed day. |
| `npm run seed:reset -- <restaurantId> [--yes]` | Shows (or, with `--yes`, clears) a restaurant's trading data, keeping the restaurant and its users. Refuses on a live server. |
| `npm run business:demos -- --user-id <adminUserId> [--sample-data]` | Creates eleven demo businesses (every type except the restaurant) and makes an existing admin their owner. `--sample-data` adds, once, realistic fictional catalogues, customers, suppliers, sales, purchases, offers, udhaar, wholesale orders, fashion variants, IMEI handsets, repairs, salon bookings and packages, and meat-shop cutting and wastage. Needs `MULTI_BUSINESS_DEVELOPMENT=true` and a non-live `NODE_ENV`. |
| `npm run seed:realistic -- --user-id <ownerId> [--only kirana,salon] [--days 90]` | A realistic business of every type but the restaurant (eleven), owned by that user, with staff logins (passwords in `backend/.local/`) and about ninety days of trading up to today, made through the real services. Safe to repeat: a rerun fills in every day since the last run and tops up today. Needs `MULTI_BUSINESS_DEVELOPMENT=true`. |
| `npm run demo:today -- --user-id <ownerId>` | Before a demo: brings the realistic businesses, the demo restaurant's trading days and its today up to this moment, adding nothing twice. `DEMO_OWNER_ID` in `.env` can stand in for the id. |
| `npm run demo:food-formats` | Adds a café, a bakery and a cloud kitchen, each a restaurant with its own owner login (in `backend/.local/`), a menu and a week of trading. Never twice. |
| `npm run business:real-copies -- --owner-user-id <id> [--only KIRANA,PHARMACY]` | A real twin, `LIVE-<KIND>`, of each realistic demo shop: the same set-up and none of its history ([plan](docs/DEMO_TO_REAL_PLAN.md)). A shop already copied is skipped. |

Smaller seeders for single modules exist as `npm run seed:kitchen`,
`seed:reservations`, `seed:table-requests`, `seed:notifications`,
`seed:deliveries`, `seed:timeclock`, `seed:inventory-insights`,
`seed:guest-insights` and `seed:tasks`.
`npm run demo:tidy-restaurant -- --user-id <id>` closes the demo restaurant's
old days and opens today like a restaurant in service, and
`npm run demo:restaurant-branch` gives it a second branch.

### 5. Backup

`npm run db:backup` (add `-- --verify` to restore the dump into a scratch
database and check it). It writes the database, `uploads/` and
`private_uploads/` to `backend/.local/backups/`. Set `PG_BIN` when `pg_dump`
is not on the PATH.

## Tests

From the project root:

```bash
npm test                    # the apps' and packages' Node tests, then backend unit tests
npm run test:integration    # backend integration tests (backend/tests/integration/*.test.js)
npm run lint                # oxlint over apps/ and packages/
npm run build               # production builds of both web apps
npm run test:browser        # Playwright: the staff app (needs E2E_CREDENTIALS_FILE), then the guests' site
```

The backend's own commands (`npm test`, `npm run test:integration` in
`backend/`) work as before.

The integration tests never touch `DB_NAME`: each creates its own empty
`rmp_test_…` database on the configured server, migrates it, and drops it at
the end. They need a PostgreSQL user allowed to create databases.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Guide for owners and staff: signing in, the switcher, the restaurant admin (and its café, bakery and cloud-kitchen formats), the Business Admin for each type, tasks, roles and permissions, the data grid |
| [docs/API.md](docs/API.md) | Every endpoint: method, path, permission, request, response, errors |
| [docs/DATABASE.md](docs/DATABASE.md) | Every table, its rules, constraints and triggers |
| [docs/BUSINESS_PLATFORM_DATA_MODEL.md](docs/BUSINESS_PLATFORM_DATA_MODEL.md) | The five layers of the business platform and their rules |
| [docs/MULTI_BUSINESS_ADMIN.md](docs/MULTI_BUSINESS_ADMIN.md) | Business Admin: screens per type, set-up, tests |
| [docs/BUSINESS_ADMIN_OVERVIEW.md](docs/BUSINESS_ADMIN_OVERVIEW.md), [docs/Business_Admin_Application_Overview.docx](docs/Business_Admin_Application_Overview.docx) | The application on a few pages (22 October 2026): what it does for each type, where it stands, what comes next. The .docx is the same overview in Word; its picture is in [docs/images/](docs/images) |
| [docs/DECISIONS_ROUND2.md](docs/DECISIONS_ROUND2.md) | The business rules chosen while completing the admin application: each rule, why, and the setting that changes it |
| [docs/REMAINING_BACKLOG.md](docs/REMAINING_BACKLOG.md) | What is left: integrations, hardware, platform layer, other apps |
| [docs/REMAINING_WORK.md](docs/REMAINING_WORK.md) | The status summary written for the owner; the details are in the backlog |
| [docs/DEMO_TO_REAL_PLAN.md](docs/DEMO_TO_REAL_PLAN.md) | How the 11 demo shops got real twins (`LIVE-<KIND>`, clean copies, done 21 October 2026), and what to check before a customer uses one |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **Start here.** Vision, request flow, database layers, code map, how-to recipes, current state and target structure, moving the repository |
| [docs/CODE_STRUCTURE.md](docs/CODE_STRUCTURE.md) | The code map on a few pages: apps and packages, every address (built and planned), who owns what, the next steps |
| [docs/NAMING.md](docs/NAMING.md) | The words used: business, type, location, module, role, permission, and each trade's own words |
| [docs/VERIFICATION.md](docs/VERIFICATION.md), [docs/PILOT_CHECKLIST.md](docs/PILOT_CHECKLIST.md) | What has been tested and the go-live checks |
| [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md) | Walking through the demo: the restaurant script and the realistic businesses of every type |
| [docs/AUDIT_AND_STATUS.md](docs/AUDIT_AND_STATUS.md), [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | History, kept for the record: the September 2026 audit of the restaurant admin, and the original development plan with what was delivered against it |
| [docs/reference/](docs/reference) | The original plan documents |

## Project rules

1. Never create or change tables by hand. Write a new migration; never edit one
   that has been applied.
2. Every tenant query filters by the signed-in user's restaurant or by a
   business membership checked on the server, never by an id from the request.
3. Always use `$1`, `$2` placeholders in SQL.
4. Every route except health, sign-in and the public guest pages requires
   `authenticate` and a permission check.
5. Never commit `.env`. Add new settings to `.env.example` with fake values.
