# Guests' site (apps/customer-web)

React 19 + Vite. What a restaurant's guests open, without signing in: the
menu behind a table's QR code (`/order/:token`), the online ordering page
(`/online/:token`) and the table booking page (`/book/...`). It calls only
the API's public endpoints (`/api/public/...`) and never carries a staff
login.

Planned pages already have their address and say what is coming:
`/shop` (order from a shop), `/appointments` (salon and clinic bookings) and
`/account` (a guest's orders, bookings and points); see `src/plannedPages.js`.
Any other address shows how to reach the right link, never "Page not found".

## Setup

Install once from the project root (`npm install`). Copy `.env.example` to
`.env`:

```
VITE_API_BASE_URL=http://localhost:5010/api
```

The dev server and the build refuse to start without it. The backend needs no
setting for this site: its public guest API (`/api/public`) answers any
address, so a restaurant's own domain works too.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5174 (`npm run dev:customer` from the root) |
| `npm run build` | Production build into `dist/` (files under `dist/guest-assets/`) |
| `npm run preview` | Serve the production build at http://localhost:4174 |
| `npm run test:browser` | Playwright checks against the running site (`E2E_CUSTOMER_URL`, default http://localhost:5174) and API (`E2E_API_URL`, default http://localhost:5010/api), in `tests/browser/`; the table QR test needs `E2E_CREDENTIALS_FILE` and is skipped without it |

## Structure

```
src/
├── main.jsx        The shared look (@bmp/ui/styles.css), BrowserRouter
├── App.jsx         The routes: three built pages, three planned, everything else → StartPage
├── plannedPages.js What each planned page says
├── pages/          StartPage (the bare address or an incomplete link), PlannedPage
├── modules/
│   ├── table-order/   QR ordering at the table: pages/QrLandingPage, services/tableOrder.service
│   ├── online-order/  Online ordering and order status: pages/, services/, styles/
│   └── booking/       Table booking and a booking's status: pages/, services/, styles/
└── styles/guest.css   The guest pages' own look (on top of the shared tokens)
```
