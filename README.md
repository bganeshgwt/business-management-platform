# Restaurant Management Platform

A subscription-based, multi-restaurant (SaaS) platform for restaurant operations:
menu, tables, orders, POS billing, kitchen, inventory, customers and reports.

One platform → many restaurants → each restaurant subscribes to the applications
and modules it needs → users only see what their roles allow.

The source planning documents are in [`docs/reference/`](docs/reference).

## Applications (planned)

| Application | Users | Purpose |
| --- | --- | --- |
| Admin Web | Restaurant Admin / Manager | Restaurant setup, menu, users, reports, enabled modules |
| POS | Cashier / Staff | Orders, billing, payments, tables |
| Captain / Waiter | Captain / Waiter | Take table orders, send KOT |
| KOT | Service / Kitchen | Kitchen Order Ticket management |
| KDS | Kitchen Staff | Kitchen queue and preparation status |
| Customer Website | Customers | Menu, QR/online ordering, payment, tracking, booking |

## Technology stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + Vite |
| Backend | Node.js + Express 5 (REST APIs) |
| Database | PostgreSQL 18 |
| Auth | JWT tokens + bcrypt password hashes |
| Migrations | node-pg-migrate (plain SQL files) |

## Project structure

```
restaurant-management-platform/
├── backend/          Node.js + Express REST API
│   ├── migrations/   SQL files that build the database
│   ├── scripts/      Terminal tools (migrations, create user)
│   └── src/          Application code
├── frontend/         React + Vite web application
└── docs/             Documentation (see below)
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the code is organised, request flow, auth, rules for new modules |
| [docs/DATABASE.md](docs/DATABASE.md) | Tables, columns, relationships, migration rules |
| [docs/API.md](docs/API.md) | Every endpoint with request and response examples |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | Sprint plan, module list and current status |
| [docs/reference/](docs/reference) | The original plan documents (.docx and .pdf) |

## Setup

### Requirements

- Node.js 20.11 or newer
- PostgreSQL 15 or newer (built on 18)

### 1. Create the database

In pgAdmin or psql:

```sql
CREATE DATABASE restaurant_management_db;
```

### 2. Backend

```bash
cd backend
npm install
```

Copy `.env.example` to `.env` and fill in your own values:

```
NODE_ENV=development
PORT=5000

DB_HOST=localhost
DB_PORT=5432
DB_NAME=restaurant_management_db
DB_USER=postgres
DB_PASSWORD=your_password_here

JWT_SECRET=a_long_random_string
JWT_EXPIRES_IN=8h

CORS_ORIGIN=http://localhost:5173
```

Generate a strong `JWT_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Create the tables:

```bash
npm run migrate:up
```

### 3. Create the first restaurant and user

A restaurant must exist before its users. In pgAdmin:

```sql
INSERT INTO restaurants (name, code, contact, address)
VALUES ('FoodEx Restaurant', 'ABC001', '9876543210', 'Rajahmundry, Andhra Pradesh');
```

Then create a login user:

```bash
npm run user:create
```

Answer the prompts (restaurant code `ABC001`, role `RESTAURANT_ADMIN`).

### 4. Frontend

```bash
cd frontend
npm install
```

Copy `.env.example` to `.env`:

```
VITE_API_BASE_URL=http://localhost:5000/api
```

### 5. Run both

```bash
cd backend && npm run dev      # http://localhost:5000
cd frontend && npm run dev     # http://localhost:5173
```

Open http://localhost:5173 and sign in.

## Commands

### Backend

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the API with auto-restart on file changes |
| `npm start` | Start the API (production) |
| `npm run migrate:create -- <name>` | Create an empty migration file |
| `npm run migrate:up` | Run all pending migrations |
| `npm run migrate:down` | Undo the last migration |
| `npm run user:create` | Create a login user from the terminal |

### Frontend

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Build for production into `dist/` |
| `npm run preview` | Preview the production build |
| `npm run lint` | Run oxlint |

## Project rules

1. Never create or change tables by hand in pgAdmin. Always write a migration.
2. Never edit a migration that has been pushed. Create a new one.
3. Every tenant-scoped query filters by `restaurant_id` taken from the logged-in
   user (`req.user.restaurantId`), never from the URL or request body.
4. Always use `$1`, `$2` placeholders in SQL. Never build SQL by joining strings.
5. Every route except health checks and login requires `authenticate`, and a
   permission check with `authorize(...)`.
6. Never commit `.env`. Add new settings to `.env.example` with fake values.

## Status

Sprint 1 (Foundation) is complete: migrations, users/roles/permissions,
JWT login, protected routes and a React login page.
See [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) for what comes next.
