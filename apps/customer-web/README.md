# Guests' site (apps/customer-web)

For developers of the guests' site: what it serves, its setting and commands,
how to try it on a phone, and how its code is laid out.

React 19 + Vite. What a restaurant's guests open, without signing in: the
menu behind a table's QR code (`/order/:token`), the online ordering page
(`/online/:token`) and the table booking page (`/book/...`). It calls only
the API's public endpoints (`/api/public/...`) and never carries a staff
login.

Planned pages have their address and say what is coming: `/shop` (order from
a shop), `/appointments` (salon and clinic bookings) and `/account` (a guest's
orders, bookings and points); see `src/plannedPages.js`. Any other address
shows how to reach the right link, never "Page not found".

## Setup

Install once from the project root (`npm install`). Copy `.env.example` to
`.env`:

```
VITE_API_BASE_URL=http://localhost:5010/api
```

The dev server and the build refuse to start without it. The backend needs no
setting for this site: its public guest API (`/api/public`) answers any
address, so a restaurant's own domain works too. The production value and how
to serve the build are in
[GO_LIVE › Serve the two web apps](../../docs/GO_LIVE.md#3-serve-the-two-web-apps).

## Commands

In this folder:

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5174 |
| `npm run build` | Production build into `dist/`, with its files under `dist/guest-assets/` so one domain can serve both apps |
| `npm run preview` | Serve the production build at http://localhost:4174 |

From the project root, `npm run dev` starts the API, the staff app and this
site together, and `npm run dev:customer` starts this site alone.

## Tests

The browser tests in `tests/browser/` run from the project root with
`npm run test:browser`, which starts its own servers on a throwaway database
and fills it with the data the tests need. See
[../../docs/TESTING.md](../../docs/TESTING.md).

## Trying it on a phone

1. Start the site for the network: `npm run dev:customer -- --host` from the
   root. The dev servers show only their own app, `packages/` and
   `node_modules` (`server.fs.allow` in each `vite.config.js`), so this never
   exposes `backend/.local` or uploads.
2. In `apps/customer-web/.env`, point `VITE_API_BASE_URL` at this computer's
   network address (`http://<its address>:5010/api`), then restart the site:
   on a phone, `localhost` is the phone itself.
3. Open a guest link on the phone with that address in place of `localhost`.
   QR codes on the staff app's screens point at its `VITE_CUSTOMER_WEB_URL`;
   for the phone to scan them, set that to the network address too and restart
   the staff app.

## Structure

```
src/
├── main.jsx        The shared look (@bmp/ui/styles.css), BrowserRouter
├── App.jsx         The routes: three built pages, three planned, everything else → StartPage
├── plannedPages.js What each planned page says
├── pages/          StartPage (the bare address or an incomplete link), PlannedPage, pages.css
├── modules/
│   ├── table-order/   QR ordering at the table: pages/QrLandingPage, services/tableOrder.service
│   ├── online-order/  Online ordering and order status: pages/, services/, styles/
│   └── booking/       Table booking and a booking's status: pages/, services/, styles/
└── styles/guest.css   The guest pages' own look (on top of the shared tokens)
```
