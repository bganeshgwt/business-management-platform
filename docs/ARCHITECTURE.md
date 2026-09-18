# Architecture

## Overall shape

```
React + Vite  ──HTTP/JSON──►  Node.js + Express REST API  ──SQL──►  PostgreSQL
(browser)                     (port 5000)                           (port 5432)
```

One PostgreSQL database holds every restaurant's data. Rows are separated by
`restaurant_id` (and `outlet_id` where outlet-level control is needed).

## Multi-tenancy: the most important rule

A "tenant" is one restaurant. Every business table carries `restaurant_id`.

- The JWT token holds the user's `restaurant_id`.
- `authenticate` middleware puts it on `req.user.restaurantId`.
- Every query filters by that value.

```js
// Correct: the id comes from the token
const restaurant = await service.getCurrentRestaurant(req.user.restaurantId);

// WRONG: the user could change the number in the URL and read another restaurant
const restaurant = await service.getById(req.params.id);
```

Platform users (Super Admin) have `restaurant_id = NULL`, meaning they are not
tied to one restaurant.

## Backend layers

```
routes → middlewares → controllers → services → repositories → PostgreSQL
```

| Layer | Folder | Responsibility | Must NOT contain |
| --- | --- | --- | --- |
| Routes | `src/routes` | Map a URL to middlewares and a controller | Logic |
| Middlewares | `src/middlewares` | Checks before the controller: auth, permission, rate limit | Business rules |
| Controllers | `src/controllers` | Validate the request shape, send the response | SQL, business rules |
| Services | `src/services` | Business rules and decisions | SQL, `req`/`res` |
| Repositories | `src/repositories` | SQL queries only | Business rules |

Why: when the menu module arrives, its SQL, rules and HTTP handling each have an
obvious home, and one can change without breaking the others.

## Request flow (login)

```
POST /api/auth/login  { email, password }
  │
  ├─ app.js          helmet → cors → express.json → morgan
  ├─ routes/index.js          "/auth" → auth.routes.js
  ├─ auth.routes.js           loginLimiter → authController.login
  ├─ auth.controller.js       email and password present and text?
  ├─ auth.service.js          bcrypt.compare → status checks → jwt.sign
  ├─ user.repository.js       SELECT ... FROM users WHERE LOWER(email) = LOWER($1)
  ▼
{ success: true, data: { token, user } }
```

Any thrown error skips the rest and goes to `middlewares/errorHandler.js`.

## Authentication

1. `POST /api/auth/login` checks the password with bcrypt and returns a JWT.
2. The browser stores the token and sends it as `Authorization: Bearer <token>`.
3. `authenticate` verifies the token, then **loads the user from the database on
   every request**, so a deactivated user or suspended restaurant is blocked
   immediately instead of when the token expires.
4. `authorize("permission.code")` checks the user's permissions.

Token contents (readable by anyone, but not changeable without `JWT_SECRET`):

```json
{ "sub": "1", "restaurantId": 1, "iat": 1789636734, "exp": 1789665534 }
```

Passwords are never stored, only bcrypt hashes (cost 12). `password_hash` never
leaves the repository layer; `toProfile()` in `auth.service.js` strips it.

### Status codes

| Code | Meaning |
| --- | --- |
| 400 | The request itself is wrong (missing field, invalid JSON) |
| 401 | Not logged in, or wrong credentials, or an invalid/expired token |
| 403 | Logged in, but not allowed (missing permission, inactive account) |
| 404 | Route or record not found |
| 429 | Too many login attempts |
| 500 | Unexpected server error (details are logged, never sent) |

## Response format

Every endpoint answers in the same shape, so the frontend can handle all of them
the same way:

```json
{ "success": true,  "message": "...", "data": { } }
{ "success": false, "message": "Invalid email or password" }
```

## Security measures in place

| Measure | Where |
| --- | --- |
| Security headers | `helmet()` in `app.js` |
| Only the frontend origin may call the API | `cors({ origin: config.corsOrigin })` |
| Password hashing (bcrypt, cost 12) | `auth.service.js`, `scripts/create-user.js` |
| Same message for wrong email and wrong password | `auth.service.js` |
| Constant-time login (dummy hash for unknown emails) | `auth.service.js` |
| 10 login attempts per IP per 15 minutes | `middlewares/rateLimiters.js` |
| SQL injection prevention (`$1` placeholders) | All repositories |
| Internal errors never exposed | `middlewares/errorHandler.js` |
| Request body size limit (1 MB) | `express.json({ limit: "1mb" })` |
| Fresh permission check on every request | `middlewares/authenticate.js` |

## Frontend structure

```
src/
├── main.jsx            BrowserRouter → AuthProvider → App
├── App.jsx             Route definitions
├── context/            AuthProvider + the shared auth context
├── hooks/useAuth.js    Read the logged-in user anywhere
├── routes/             ProtectedRoute (login and permission guard)
├── layouts/            AppLayout (top bar shared by logged-in pages)
├── pages/              One file per screen
├── services/           api.js (axios + token) and API calls per module
└── index.css           App-wide styles
```

- `api.js` attaches the token to every request automatically.
- A 401 response clears the token and fires `auth:logout`, which returns the user
  to the login page.
- `ProtectedRoute` redirects anonymous users to `/login` and remembers where they
  were going.

## Adding a new module (the recipe)

Example: menu categories.

1. `backend/migrations/xxxx_create-categories.sql` — tables, with `restaurant_id`
   and the common columns.
2. `backend/src/repositories/category.repository.js` — SQL only, always filtered
   by `restaurant_id`.
3. `backend/src/services/category.service.js` — rules (for example, a category in
   use cannot be deleted).
4. `backend/src/controllers/category.controller.js` — request checks, response.
5. `backend/src/routes/category.routes.js` — URLs with `authenticate` and
   `authorize("menu.view" / "menu.manage")`.
6. `backend/src/routes/index.js` — one line: `router.use("/categories", ...)`.
7. Add any new permission codes in a migration, and grant them to roles.
8. Frontend: `services/category.service.js`, a page, and a route in `App.jsx`.

## Decisions and trade-offs

| Decision | Reason | Revisit when |
| --- | --- | --- |
| One database, `restaurant_id` column | Simplest to build and operate | Very large tenants need isolation |
| User loaded from DB on every request | Instant lockout, always-current permissions | Traffic grows; add caching |
| Token in `localStorage` | Simple for an SPA; survives refresh | Before production, consider httpOnly cookies |
| No refresh token (8 hour expiry) | Matches a work shift | POS staff need longer sessions |
| Plain SQL migrations | You already know SQL; no hidden behaviour | — |
| Layered folders (not per-module folders) | Matches the folder layout already in the repo | The project grows past ~15 modules |
