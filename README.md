# Business Management Platform

For anyone opening the repository, developers first: what the product is, how
to set it up from an empty database and run it, the commands, the project
rules, and where every other document is.

**Start here:** developers at [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
which explains how it is built, where everything lives and how to extend it;
owners and management at [docs/PRODUCT_OVERVIEW.md](docs/PRODUCT_OVERVIEW.md),
the product on a few pages.

One platform for independent businesses of twenty-three types: restaurants,
grocery / kirana, supermarkets, wholesale / FMCG, fashion, electronics,
pharmacy, books & stationery, salons & spas, clinics & labs, meat & seafood,
other weight-based shops, general stores, hardware and building materials,
seeds and fertilisers, optical shops, garages and auto parts, jewellers, fuel
stations, gyms and coaching, laundries, rentals, and hotels and lodges. Each business's data is kept apart, and one
person can belong to several businesses. What each type gets, from the
restaurant (which also runs as a café, a bakery or a cloud kitchen) to the
pharmacy's registers and the clinic's lab, and what is not built yet, is in
[docs/PRODUCT_OVERVIEW.md](docs/PRODUCT_OVERVIEW.md).

**Two web apps share one API.** The **staff app** (`apps/business-web`) is
where owners and staff work: a switcher in the header opens any business you
belong to, with a menu built from the modules that business uses and the
permissions your role there gives you; the POS, kitchen display and pickup
screen are part of it, and so is the platform console. The **guests' site**
(`apps/customer-web`) is what a restaurant's guests open from a table's QR
code, the online ordering link or the booking link; nobody signs in there.

## Technology

| Layer | Technology |
| --- | --- |
| Web apps | React 19 + Vite 8, React Router 7, TanStack Query (the staff app); npm workspaces (`apps/*`, `packages/*`) |
| Backend | Express 5 (REST, JSON), with its own npm install in `backend` |
| Node.js | 22.12 or newer (CI runs 24) |
| Database | PostgreSQL 15 or newer (developed on 18; CI runs 17) |
| Auth | JWT sessions, bcrypt passwords, optional two-step sign-in (authenticator app), staff PINs |
| Migrations | node-pg-migrate, plain SQL files in `backend/migrations` |
| Tests and lint | Node's test runner (`node --test`), Playwright for the browser tests, oxlint |
| CI | GitHub Actions (`.github/workflows/checks.yml`) on every push and pull request: the backend's unit and integration tests, lint, the workspaces' unit tests and both builds. The browser tests are not part of CI. |

## Repository layout

```
business-management-platform/
├── apps/
│   ├── business-web/   The staff app (React + Vite, :5173): src/modules/<module>/ (pages,
│   │                   services, styles), shared components, services and styles;
│   │                   tests/ (Node tests, and browser/ for the Playwright specs)
│   └── customer-web/   The guests' site (React + Vite, :5174): table QR ordering, online
│                       ordering, table booking; tests/browser/
├── packages/
│   ├── ui/             @bmp/ui: the shared look (tokens and global styles), icons, menu
│   │                   choice components
│   └── shared/         @bmp/shared: money and number formatting, dates, menu choice rules
├── backend/            Express API: src/modules/<module>/ (routes, controllers, services,
│                       repositories), src/ shared code, migrations/, scripts/ (migrate,
│                       first login, backup), tests/ (unit, and integration/); its own install
├── e2e/                The browser tests' harness: one Playwright config for both apps (it
│                       starts their web servers), and the set-up that gives each run its own
│                       database, API and data
├── tools/              dev.mjs, behind npm run dev
└── docs/               Documentation (below)
```

## Set up from an empty database

You need Node.js and PostgreSQL at the versions under
[Technology](#technology). The shell commands below run from the project root.

### 1. Database

```sql
CREATE DATABASE business_platform_db;
```

One database holds every business. The name matches `DB_NAME` in
`backend/.env.example`; another name works when `DB_NAME` says so.

The migrations build every table as `DB_USER`, the user the API signs in as.
On PostgreSQL 15 and newer only the database's owner or a superuser (such as
the `postgres` that `.env.example` names) may create tables in a new
database, so create it as that user, or name the user as its owner:
`CREATE DATABASE business_platform_db OWNER <db_user>;`.

### 2. Settings, installs and tables

Copy the three example settings files:

```bash
cp backend/.env.example backend/.env
cp apps/business-web/.env.example apps/business-web/.env
cp apps/customer-web/.env.example apps/customer-web/.env
```

In `backend/.env`, set:

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`: the database
  from step 1. The API stops at start when one is missing.
- `JWT_SECRET`: at least 32 random characters (the file shows a command that
  makes one). Anyone who knows it can sign in as any user. A live server
  refuses to start with the example value or a weak one; on a developer's
  machine (`NODE_ENV=development`) the API only warns.

Every other setting has a working default, and the file explains each one.
Read its note on `TWO_FACTOR_KEY` before anyone turns on two-step sign-in: the
key is set once and never changed.

The two apps' files work as copied when everything runs on one machine with
the API on `PORT=5010`, as `backend/.env.example` sets it:

- `apps/business-web/.env`: `VITE_API_BASE_URL` (the API, ending in `/api`)
  and `VITE_CUSTOMER_WEB_URL` (the guests' site, or `same-origin` when one
  address serves both apps). Guest links and table QR codes open that
  address, unless a restaurant sets its own guest web address in Service
  settings.
- `apps/customer-web/.env`: `VITE_API_BASE_URL`.

Each app's dev server and build refuse to start without them. The backend's
`CORS_ORIGIN` lists the staff app's address; the guests' site needs no entry,
because the public guest API answers any address. The backend's
`GUEST_WEB_URL` is the guests' site's own address, where the links the API
builds to a guest's page start; a developer's machine may leave it out, a live
server needs it. The production values are in
[GO_LIVE › Production settings](docs/GO_LIVE.md#2-production-settings).

Then install, and build the tables:

```bash
npm install                            # both web apps and the shared packages
npm --prefix backend install           # the API, which has its own install
npm --prefix backend run migrate:up    # builds every table in the empty database
```

The migrations create only what every business shares: the business types,
the module and permission catalogues, the role templates and system roles, and
the task categories. No restaurant, business or login exists yet.

### 3. The first login

The first login is the platform's **Super Admin**, made in the terminal by
`backend/scripts/create-user.js`. The public site's sign-up (`/signup`) makes
owners and their businesses, never the platform's own login.

1. Run `npm --prefix backend run user:create` and leave the restaurant code
   empty. Then give a name, an email, a mobile (optional) and a password of 8
   to 72 characters; the password shows as you type it, and it works for the
   first sign-in only.
2. Start the apps ([Run](#run)) and sign in to the staff app,
   http://localhost:5173, with that login. The sign-in then asks for a
   password of your own: this login runs the whole platform, so make it a
   strong one. The Super Admin opens on **Platform › Restaurants**.
3. Create each restaurant in **Platform › Restaurants** (*Add restaurant*: a
   restaurant, café, bakery or cloud kitchen, with its admin's login), and each
   business of another type in **Platform › Businesses** (*Add a business*,
   with its owner's login). Each one is created with everything it needs to
   start; never insert one into the database by hand. The owners then sign in
   and follow
   [ADMIN_GUIDE › First steps in a new business](docs/ADMIN_GUIDE.md#first-steps-in-a-new-business).
4. More logins come from the staff screens (a restaurant's **Users & access ›
   Users**, a business's **Staff & access**), or from `user:create` with a
   restaurant's code and one of the built-in restaurant roles:
   `RESTAURANT_ADMIN`, `MANAGER`, `CASHIER`, `CAPTAIN`, `KITCHEN`,
   `ACCOUNTANT`, `STORE_KEEPER` or `DISPLAY` (a TV at the pickup counter; the
   prompt's list leaves it out, but takes it).

What the platform screens offer is in
[ADMIN_GUIDE › The first platform login and the platform screens](docs/ADMIN_GUIDE.md#the-first-platform-login-and-the-platform-screens).

## Run

```bash
npm run dev
```

This starts the API, the staff app and the guests' site together, each line
of output marked with its app. It checks the three ports first: when one is
busy (usually because that app is already running in another terminal), it
says which and starts nothing. Ctrl+C stops all three, and so does any one of
them stopping.

To start them one at a time instead, each in its own terminal:

```bash
npm run dev:backend    # the API; it restarts when a file in backend/src changes
npm run dev:business   # the staff app
npm run dev:customer   # the guests' site
```

| App | Address |
| --- | --- |
| API | http://localhost:5010/api (the `PORT` in `backend/.env`); http://localhost:5010/api/health answers when it is up |
| Staff app | http://localhost:5173 |
| Guests' site | http://localhost:5174, opened from a table's QR code, a restaurant's online ordering link or its booking link. The bare address says how to find the right link. |

The API refuses to start while a migration is pending, and says so;
`npm --prefix backend run migrate:up` applies it. It also stops with a clear
message when its port is taken. The web apps' ports are fixed, so a
second copy stops instead of moving to another port. A guest link opened on
the staff app's address is sent on to the guests' site. More on what these
commands do:
[ARCHITECTURE › Running them locally](docs/ARCHITECTURE.md#23-running-them-locally).

## Commands

At the project root:

| Command | What it does |
| --- | --- |
| `npm run dev` | The API, the staff app and the guests' site together ([Run](#run)) |
| `npm run dev:backend` | The API alone, restarting when a file in `backend/src` changes |
| `npm run dev:business` | The staff app alone, http://localhost:5173 |
| `npm run dev:customer` | The guests' site alone, http://localhost:5174 |
| `npm run build` | Production builds of both web apps, each into its own `dist/` ([GO_LIVE › Serve the two web apps](docs/GO_LIVE.md#3-serve-the-two-web-apps)) |
| `npm run lint` | oxlint over `apps/`, `packages/`, `tools/` and `e2e/` |
| `npm test` | The unit tests: those of each workspace that has them, then the backend's ([TESTING](docs/TESTING.md)) |
| `npm run test:integration` | The backend's integration tests, each file on a database of its own ([TESTING](docs/TESTING.md)) |
| `npm run test:browser` | The browser tests of both web apps, on servers and a database of their own ([TESTING](docs/TESTING.md)) |

In `backend`. From the root, put `--prefix backend` after `npm`, as in
`npm --prefix backend run migrate:up`.

| Command | What it does |
| --- | --- |
| `npm run dev` | The API under nodemon, restarting when a file in `src/` changes |
| `npm start` | The API without restarts, as a server runs it ([GO_LIVE › Install on a server](docs/GO_LIVE.md#1-install-on-a-server)) |
| `npm run migrate:up` | Applies every migration not yet applied, oldest first |
| `npm run migrate:down` | Rolls back the newest applied migration. For development and test databases: a live database goes back by restoring a backup. |
| `npm run migrate:create -- <name>` | A new, empty SQL migration in `migrations/` ([ARCHITECTURE › Add a migration](docs/ARCHITECTURE.md#85-add-a-migration)) |
| `npm run user:create` | A login made in the terminal: the platform Super Admin (restaurant code left empty) or a restaurant's user with a built-in role ([The first login](#3-the-first-login)) |
| `npm run db:backup` | Backs up the database and both upload folders (`UPLOADS_DIR` and `PRIVATE_UPLOADS_DIR`) into `backend/.local/backups/`. Add `-- --verify` to restore the copy into a scratch database and check it. `PG_BIN` in `backend/.env` names the folder of `pg_dump` and `pg_restore` when they are not on the PATH. ([GO_LIVE › Backups and restore](docs/GO_LIVE.md#5-backups-and-restore)) |
| `npm test` | The backend's unit tests (the root's `npm test` runs them after the web apps' and packages' tests) |
| `npm run test:integration` | The backend's integration tests, the same as the root's command |

## Tests

`npm test` needs neither a database nor a running server.

The integration and browser tests need PostgreSQL, through the `DB_*` settings
in `backend/.env` (or the environment), and a PostgreSQL user allowed to
create databases. Each integration test file, and each browser run, creates its
own empty `rmp_test_…` database, migrates it and drops it at the end; none of
them touches `DB_NAME`.

The browser tests also start their own API and both web apps, on ports 5110,
5183 and 5184, and make the data they need, so the servers from `npm run dev`
can keep running. They use the installed Edge on Windows; elsewhere, install
Playwright's Chromium (`npx playwright install chromium`). Start one run at a
time; a full run takes about 25 minutes.

What each suite covers, what it needs and how to run part of one:
[docs/TESTING.md](docs/TESTING.md).

## Documentation

| Document | For | What it covers |
| --- | --- | --- |
| [docs/PRODUCT_OVERVIEW.md](docs/PRODUCT_OVERVIEW.md) | Owners, management, prospective customers | The product on a few pages: what it does for each business type, what it does not do yet, and what management decides |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Owners, managers, staff, support | How to use every screen, from the first platform login to closing the day, and what each screen allows or refuses |
| [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md) | Owners, accountants, the pharmacist, doctor and legal adviser who review the health rules, support, developers who change a rule | Each rule someone may question: why it is so, and where to change it or why it is fixed, with the legal sources |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Everyone | The words: the product and its apps, the platform's terms, the restaurant's terms and each trade's own words |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Developers | How it is built and why: the applications and their addresses, how a request flows, the code map, conventions, how-to recipes and where the structure is going |
| [docs/BUSINESS_PLATFORM_DATA_MODEL.md](docs/BUSINESS_PLATFORM_DATA_MODEL.md) | Backend developers | The business platform's data design, layer by layer and type by type, and the rules each table carries |
| [docs/DATABASE.md](docs/DATABASE.md) | Developers, database administrators | Every table, column, constraint and trigger, and the catalogues of business types, modules and permission codes |
| [docs/API.md](docs/API.md) | Developers, integrators | Every endpoint, and the conventions every caller follows |
| [docs/TESTING.md](docs/TESTING.md) | Developers, testers | Running every test, what each suite needs and covers, load and browser runs, and CI |
| [docs/GO_LIVE.md](docs/GO_LIVE.md) | Whoever installs it for a real business, and the owner who signs it off | Production settings, serving the two web apps, backups and restore, setting up the customer's business, equipment acceptance, the staff pilot and sign-off |
| [docs/BACKLOG.md](docs/BACKLOG.md) | The owner, developers | What is left to build, in order, what each item needs, and the known problems |
| [apps/business-web/README.md](apps/business-web/README.md) | Developers of the staff app | Its settings and commands, how its code is laid out, how sign-in works, and adding a page |
| [apps/customer-web/README.md](apps/customer-web/README.md) | Developers of the guests' site | Its setting and commands, trying it on a phone, and how its code is laid out |
| [packages/ui/README.md](packages/ui/README.md) | Developers of both web apps | `@bmp/ui`: the shared look (the stylesheets and their design tokens), the icons and the menu choice components |
| [packages/shared/README.md](packages/shared/README.md) | Developers of both web apps | `@bmp/shared`: the formats, dates and menu choice rules both apps share |
| [backend/src/notifications/README.md](backend/src/notifications/README.md) | Backend developers | The restaurant's bell: how it works out its alerts, and how a module adds its own |

## Project rules

1. Never create or change tables by hand. Write a new migration; never edit one
   that has been applied
   ([ARCHITECTURE › Add a migration](docs/ARCHITECTURE.md#85-add-a-migration)).
2. Every tenant query filters by the signed-in user's restaurant or by a
   business membership checked on the server, never by an id from the request.
3. Always use `$1`, `$2` placeholders in SQL.
4. Every route except health, sign-in and the public guest pages requires
   `authenticate`, and a permission check unless it acts only on the
   signed-in person's own account or tasks.
5. Never commit `.env`. Add new settings to `.env.example` with fake values.
