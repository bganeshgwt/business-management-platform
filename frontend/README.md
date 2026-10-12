# Frontend — Restaurant Management Platform

React 19 + Vite web application. It talks to the Express API in `../backend`.

See [../README.md](../README.md) for full project setup and
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how the code is organised.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env`:

```
VITE_API_BASE_URL=http://localhost:5000/api
```

Only variables starting with `VITE_` are visible to the app. Never put secrets in
them: everything in a frontend build is public.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5173 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | Run oxlint |

## Structure

```
src/
├── main.jsx            BrowserRouter → AuthProvider → App
├── App.jsx             Routes
├── context/
│   ├── auth-context.js The shared context object
│   └── AuthProvider.jsx Holds the logged-in user, login() and logout()
├── hooks/useAuth.js    Read the auth state in any component
├── routes/ProtectedRoute.jsx  Requires login, optionally a permission
├── layouts/AppLayout.jsx      Top bar shared by logged-in pages
├── modules/            One folder per module: pages/ (one file per screen),
│                       services/ and styles/ the module alone uses
├── components/         Shared UI (DataGrid, Modal, PageHeader …)
├── services/           Shared services
│   ├── api.js          axios instance, token handling, error messages
│   └── auth.service.js Login and current-user calls
├── styles/             Shared stylesheets and tokens
└── index.css           App-wide styles
```

## How login works

1. `LoginPage` calls `login(email, password)` from `useAuth()`.
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
3. Add a link in `layouts/AppLayout.jsx`.
4. Put API calls in the module's `services/<area>.service.js`, never directly in the page.

Use `hasPermission("menu.manage")` from `useAuth()` to show or hide buttons.
The backend still checks permissions, so hiding is only for convenience.
