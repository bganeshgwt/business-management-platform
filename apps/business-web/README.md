# Staff app (apps/business-web)

For developers of the staff app: what it covers, its settings and commands,
how its code is laid out, how sign-in works, and how to add a page.

React 19 + Vite. Where owners, managers, cashiers, captains and kitchen staff
work, for every business type: Business Admin, the restaurant admin, the POS,
the kitchen display, the pickup screen and the platform console. It talks to
the Express API in `../../backend`. The guests' pages (table QR ordering,
online ordering, booking) are their own app, `../customer-web`.

The project setup is in [../../README.md](../../README.md).
[../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) lists every address
([§2](../../docs/ARCHITECTURE.md#2-applications-and-addresses)) and maps the
code ([§6](../../docs/ARCHITECTURE.md#6-code-map)).

## Setup

Install once from the project root (`npm install`: both apps and the shared
packages). Copy `.env.example` to `.env`:

```
VITE_API_BASE_URL=http://localhost:5010/api
VITE_CUSTOMER_WEB_URL=http://localhost:5174
```

`VITE_CUSTOMER_WEB_URL` is the guests' site (or `same-origin` when one domain
serves both apps): guest links and table QR codes open it unless a restaurant
sets its own guest web address (Service settings). The dev server and the build
refuse to start without either address. Only variables starting with `VITE_`
are visible to the app, and they are written into the build: never put secrets
in them, because everything in a web build is public. The production values
and how to serve the build are in
[GO_LIVE › Serve the two web apps](../../docs/GO_LIVE.md#3-serve-the-two-web-apps).

## Commands

In this folder:

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5173, always this port: the API's `CORS_ORIGIN` allows it |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build at http://localhost:4173. The API answers it only when `CORS_ORIGIN` lists that address. |
| `npm test` | Node unit tests (`tests/*.test.js`) |

From the project root, `npm run dev` starts the API, this app and the guests'
site together, and `npm run dev:business` starts this app alone. `npm run lint`
and `npm run build` there cover both apps.

## Tests

`npm test` runs the Node tests in `tests/`. The browser tests in
`tests/browser/` run from the project root with `npm run test:browser`, which
starts its own servers on a throwaway database and fills it with the data the
tests need. See [../../docs/TESTING.md](../../docs/TESTING.md).

## Structure

```
src/
├── main.jsx            The shared look (@bmp/ui/styles.css) → QueryClientProvider → BrowserRouter →
│                       AuthProvider → App (+ ApprovalDialog, ConfirmHost, Toaster)
├── App.jsx             Routes, including the planned workspaces (/captain, /clinic, /lab) and
│                       guest links opened on this app (/order, /online, /book), which go on to
│                       the guests' site
├── context/            AuthProvider (user, permissions, features), BusinessProvider (open business)
├── hooks/              useAuth, useBusiness, motion hooks …
├── routes/ProtectedRoute.jsx  Requires login, optionally a permission or a feature
├── layouts/            AppLayout (header, switchers, side menu), NotFoundPage,
│                       PlannedPage (a planned workspace), GuestSiteRedirect
├── modules/            access (sign-in, profile, users, roles), platform (the platform console),
│                       restaurant/<area>, business/<core, a type or a shared area>, tasks.
│                       Each holds pages/ (one file per screen), and the services/ and
│                       styles/ it alone uses
├── components/         Shared UI (DataGrid, Modal, PageHeader …)
├── services/           Shared services: api.js (axios, token, outlet, approvals),
│                       customerWeb.js (where the guests' site is), businessNav …
└── styles/             Stylesheets more than one module uses
```

Code both apps use is not here: icons and the global styles are in `@bmp/ui`
(`packages/ui`), formatting and dates in `@bmp/shared` (`packages/shared`).
Import them by name: `import Icon from "@bmp/ui/Icon"`,
`import { money } from "@bmp/shared/format"`.

## How login works

1. `LoginPage` calls `login(identifier, password, restaurantCode?)` from
   `useAuth()` (an e-mail or a mobile; with two-step sign-in on, the answer asks
   for the code first).
2. `AuthProvider` stores the returned token in `localStorage` and keeps the
   user in state. When someone else set the password (`user.passwordChangeRequired`),
   `LoginPage` shows `ChoosePassword` instead of moving on, and
   `ProtectedRoute` sends every page back to it, until the person has chosen
   their own (`POST /auth/change-password`, which returns a fresh session);
   then the page they were opening loads. The API refuses everything else
   until then.
3. `api.js` attaches `Authorization: Bearer <token>` to every request, with the
   chosen outlet (`X-Outlet-Id`) and, in a business, the chosen location
   (`X-Business-Location`).
4. While someone works, `api.js` swaps the token for a fresh one once it is
   past half its life (`POST /auth/refresh`), so a long shift is never cut off.
5. When the page is reloaded, `AuthProvider` calls `/auth/me` to restore the
   user, and drops a token the API refuses.
6. If the API answers 401 to a request that carried a token, the token is
   cleared and the app returns to `/login`.

## Adding a page

1. Create `src/modules/<module>/pages/MyPage.jsx` (the folder rules are in
   [ARCHITECTURE §6.3, Inside a web app](../../docs/ARCHITECTURE.md#63-inside-a-web-app)).
2. Add a route in `App.jsx`, inside `<ProtectedRoute>` if it needs a login:
   ```jsx
   <Route path="my-page" element={<MyPage />} />
   ```
   Add `permission="menu.view"` on a `ProtectedRoute` to require a permission,
   or `permissionAny={["orders.view", "kds.view"]}` when any one of several
   will do (the menu link names the same).
   A Business Admin screen is an entry in `screens()` in
   `modules/business/core/pages/BusinessAdminRoutes.jsx`
   (`"section": <MyPage />`): that gives it its route, guarded by
   `page("section", …)`, and lets the Overview open it in a panel. A screen
   with an id in its address gets its own `<Route>` there, wrapped in
   `page()`.
3. Add a link to the menu. A restaurant screen: a link in `NAV_SECTIONS`
   (`layouts/AppLayout.jsx`) and its path in an area of
   `services/restaurantWorkspace.js`. A Business Admin screen: a link in
   `businessSections()` (`services/businessNav.js`) and its section in a
   workspace of `services/businessWorkspace.js`.
4. Put API calls in the module's `services/<area>.service.js`, never directly
   in the page.

A workspace that is planned but not built gets its route at once, with a
`PlannedPage` entry in `services/plannedWorkspaces.js`, never a "Page not
found". Use `hasPermission("menu.manage")` from `useAuth()` (in Business Admin,
`can("sales.refund")` from `useBusiness()`) to show or hide buttons. The
backend checks permissions as well, so hiding is only for convenience.
