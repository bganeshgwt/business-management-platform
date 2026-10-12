# Business Management Platform

**Start here:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the vision, where everything lives, why, and how to extend it.

One platform for independent businesses of twelve types: restaurants,
grocery / kirana, supermarkets, wholesale / FMCG, fashion, electronics,
pharmacy, books & stationery, salons & spas, clinics & labs, meat & seafood,
and other weight-based shops. Each business's data is kept apart, and one
person can belong to several businesses.

**Business Admin** is the one admin application. A switcher in the header
opens any business you belong to, with a menu built from the modules that
business uses and the permissions your role there gives you.

- The **restaurant** is the most complete type: menu, tables and QR ordering,
  POS, kitchen display, captain sections, reservations and online booking,
  online ordering, deliveries and rider cash, billing with GST, cash drawers,
  inventory with batches and recipes, purchasing, guests and loyalty, staff,
  time clock, payroll and tips, and a full set of reports.
- **Retail** (grocery, supermarket, books): quick bill with barcode and scale
  labels, offers, loyalty, udhaar, barcode labels, book details.
- **Wholesale**: sales orders, dispatch and back-orders, routes and beats,
  collections, outstanding and ageing.
- **Fashion and electronics**: size × colour matrix, exchanges, serial / IMEI
  register, warranties, repair jobs.
- **Salon & spa**: calendar, deposits, packages, memberships, commissions.
- **Meat and weight-based shops**: stock by weight, cutting and yield, wastage.

Pharmacy and clinic / lab use the shared core today; their regulated
workflows wait for the owner's rules ([backlog](docs/REMAINING_BACKLOG.md)).

## Technology

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + Vite, React Router 7, TanStack Query |
| Backend | Node.js 20.11+ and Express 5 (REST, JSON) |
| Database | PostgreSQL 15 or newer (built on 18) |
| Auth | JWT sessions, bcrypt passwords, optional two-step sign-in (authenticator app), staff PINs |
| Migrations | node-pg-migrate, plain SQL files in `backend/migrations` |

```
business-management-platform/
├── backend/     Express API: src/modules/<module>/ (routes, controllers, services,
│                repositories), src/ shared code, migrations/, scripts/ (setup, demo
│                data, backup), tests/
├── frontend/    React application (Vite): src/modules/<module>/ (pages, services,
│                styles), shared components, services and styles
└── docs/        Documentation (below)
```

## Running it locally

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
npm run dev               # API on http://localhost:5000 (auto-restart)
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

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env      # VITE_API_BASE_URL=http://localhost:5000/api
npm run dev               # http://localhost:5173
```

### 4. Demo data

| Command (in `backend`) | What it does |
| --- | --- |
| `npm run seed:demo` | Fills the first restaurant (if its menu is empty) with a month of realistic trading through the real services: menu with recipes, ingredients, suppliers, tables, staff, guests, about 880 orders billed and paid. `-- --force` to run on a non-empty menu. |
| `npm run seed:topup` | Trades the demo restaurant forward from its last business day to today, leaving today open and part-traded. Safe to repeat; never touches a closed day. |
| `npm run seed:reset -- <restaurantId> [--yes]` | Shows (or, with `--yes`, clears) a restaurant's trading data, keeping the restaurant and its users. Refuses on a live server. |
| `npm run business:demos -- --user-id <adminUserId> [--sample-data]` | Creates eleven demo businesses (every type except the restaurant) and makes an existing admin their owner. `--sample-data` adds, once, realistic fictional catalogues, customers, suppliers, sales, purchases, offers, udhaar, wholesale orders, fashion variants, IMEI handsets, repairs, salon bookings and packages, and meat-shop cutting and wastage. Needs `MULTI_BUSINESS_DEVELOPMENT=true` and a non-live `NODE_ENV`. |

Smaller seeders for single modules exist as `npm run seed:kitchen`,
`seed:reservations`, `seed:table-requests`, `seed:notifications`,
`seed:deliveries`, `seed:timeclock`, `seed:inventory-insights` and
`seed:guest-insights`.

### 5. Backup

`npm run db:backup` (add `-- --verify` to restore the dump into a scratch
database and check it). Set `PG_BIN` when `pg_dump` is not on the PATH.

## Tests

```bash
cd backend
npm test                    # unit tests (tests/*.test.js)
npm run test:integration    # integration tests (tests/integration/*.test.js)

cd frontend
npm run lint                # oxlint
npm run build               # production build
npm run test:browser        # Playwright browser checks
```

The integration tests never touch `DB_NAME`: each creates its own empty
`rmp_test_…` database on the configured server, migrates it, and drops it at
the end. They need a PostgreSQL user allowed to create databases.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Guide for owners and staff: the switcher, the restaurant admin, the Business Admin for each type, roles and permissions, the data grid |
| [docs/API.md](docs/API.md) | Every endpoint: method, path, permission, request, response, errors |
| [docs/DATABASE.md](docs/DATABASE.md) | Every table, its rules, constraints and triggers |
| [docs/BUSINESS_PLATFORM_DATA_MODEL.md](docs/BUSINESS_PLATFORM_DATA_MODEL.md) | The five layers of the business platform and their rules |
| [docs/MULTI_BUSINESS_ADMIN.md](docs/MULTI_BUSINESS_ADMIN.md) | Business Admin: screens per type, set-up, tests |
| [docs/REMAINING_BACKLOG.md](docs/REMAINING_BACKLOG.md) | What is left: integrations, hardware, platform layer, other apps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **Start here.** Vision, request flow, database layers, code map, how-to recipes, current state and target structure, moving the repository |
| [docs/NAMING.md](docs/NAMING.md) | The words used: business, type, location, module, role, permission |
| [docs/VERIFICATION.md](docs/VERIFICATION.md), [docs/PILOT_CHECKLIST.md](docs/PILOT_CHECKLIST.md) | What has been tested and the go-live checks |
| [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md) | Walking through the demo |
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
