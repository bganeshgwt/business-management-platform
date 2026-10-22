# Staff app (apps/business-web)

React 19 + Vite. Where owners, managers, cashiers, captains and kitchen staff
work, for every business type: Business Admin, the restaurant admin, the POS,
the kitchen display, the pickup screen and the platform console. It talks to
the Express API in `../../backend`. The guests' pages (table QR ordering,
online ordering, booking) are their own app, `../customer-web`.

See [../../README.md](../../README.md) for the full project setup,
[../../docs/CODE_STRUCTURE.md](../../docs/CODE_STRUCTURE.md) for the map and
[../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the details.

## Setup

Install once from the project root (`npm install`: both apps and the shared
packages). Copy `.env.example` to `.env`:

```
VITE_API_BASE_URL=http://localhost:5010/api
VITE_CUSTOMER_WEB_URL=http://localhost:5174
```

`VITE_CUSTOMER_WEB_URL` is the guests' site (or `same-origin` when one
domain serves both apps): guest links and table QR codes open it unless a
restaurant sets its own guest web address (Service settings). The dev server
and the build refuse to start without either address (an old `frontend/.env`
has no `VITE_CUSTOMER_WEB_URL`: copy the line from `.env.example`). Only variables starting with `VITE_` are visible to the app. Never
put secrets in them: everything in a web build is public.

## Commands

From the project root (`npm run dev:business`, `npm run lint`, `npm run build`),
or in this folder:

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5173 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Node unit tests (`tests/*.test.js`) |
| `npm run test:browser` | Playwright checks (`tests/browser/`, needs `E2E_CREDENTIALS_FILE`) |

## Structure

```
src/
├── main.jsx            The shared look (@bmp/ui/styles.css) → QueryClientProvider → BrowserRouter →
│                       AuthProvider → App (+ ApprovalDialog, ConfirmHost, Toaster)
├── App.jsx             Routes, including the planned workspaces (/captain, /clinic, /lab)
├── context/            AuthProvider (user, permissions, features), BusinessProvider (open business)
├── hooks/              useAuth, useBusiness, motion hooks …
├── routes/ProtectedRoute.jsx  Requires login, optionally a permission or a feature
├── layouts/            AppLayout (header, switchers, side menu), NotFoundPage,
│                       PlannedPage (a workspace not built yet), GuestSiteRedirect
├── modules/            One folder per module: pages/ (one file per screen),
│                       services/ and styles/ the module alone uses
├── components/         Shared UI (DataGrid, Modal, PageHeader …)
├── services/           Shared services: api.js (axios, token, outlet, approvals),
│                       customerWeb.js (where the guests' site is), businessNav …
└── styles/             Stylesheets more than one module uses
```

Code both apps use is not here: icons and the global styles are in
`@bmp/ui` (`packages/ui`), formatting and dates in `@bmp/shared`
(`packages/shared`). Import them by name: `import Icon from "@bmp/ui/Icon"`,
`import { money } from "@bmp/shared/format"`.

## How login works

1. `LoginPage` calls `login(identifier, password, restaurantCode?)` from `useAuth()`
   (an e-mail or a mobile; with two-step sign-in on, the answer asks for the code first).
2. `AuthProvider` stores the returned token in `localStorage` and keeps the user
   in state.
3. `api.js` attaches `Authorization: Bearer <token>` to every request.
4. On refresh, `AuthProvider` calls `/auth/me` to restore the user.
5. If the API answers 401, the token is cleared and the app returns to `/login`.

## Adding a page

1. Create `src/modules/<module>/pages/MyPage.jsx` (see docs/ARCHITECTURE.md §5).
2. Add a route in `App.jsx`, inside `<ProtectedRoute>` if it needs a login:
   ```jsx
   <Route path="my-page" element={<MyPage />} />
   ```
   Add `permission="menu.view"` on a `ProtectedRoute` to require a permission.
   A Business Admin screen's route goes in
   `modules/business/core/pages/BusinessAdminRoutes.jsx`, wrapped in
   `page("section", …)`.
3. Add a link to the menu. A restaurant screen: a link in `NAV_SECTIONS`
   (`layouts/AppLayout.jsx`) and its path in an area of
   `services/restaurantWorkspace.js`. A Business Admin screen: a link in
   `businessSections()` (`services/businessNav.js`) and its section in a
   workspace of `services/businessWorkspace.js`.
4. Put API calls in the module's `services/<area>.service.js`, never directly in the page.

A workspace that is planned but not built yet gets its route now, with a
`PlannedPage` entry in `services/plannedWorkspaces.js`, never a "Page not
found". Use `hasPermission("menu.manage")` from `useAuth()` (in Business
Admin, `can("sales.refund")` from `useBusiness()`) to show or hide buttons.
The backend still checks permissions, so hiding is only for convenience.
