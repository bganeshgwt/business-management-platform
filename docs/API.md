# API reference

Base URL (development): `http://localhost:5000/api`

All requests and responses are JSON. Every response has the same shape:

```json
{ "success": true,  "message": "...", "data": { } }
{ "success": false, "message": "Invalid email or password" }
```

## Authentication

Protected endpoints require the token returned by login:

```
Authorization: Bearer <token>
```

The token is valid for `JWT_EXPIRES_IN` (default 8 hours). The user is reloaded
from the database on every request, so deactivating a user takes effect at once.

## Status codes

| Code | Meaning |
| --- | --- |
| 200 | Success |
| 400 | Bad request (missing field, invalid JSON, no restaurant linked) |
| 401 | Not logged in, wrong credentials, or invalid/expired token |
| 403 | Logged in but not allowed (missing permission, inactive account or restaurant) |
| 404 | Route or record not found |
| 429 | Too many login attempts (10 per IP per 15 minutes) |
| 500 | Unexpected server error |

---

## Health

### `GET /api/health`
Checks that the API is running. No authentication.

```json
{ "success": true, "message": "Restaurant Management API is running" }
```

### `GET /api/db-health`
Checks the PostgreSQL connection. No authentication.

```json
{
  "success": true,
  "message": "PostgreSQL connection successful",
  "time": "2026-09-17T09:18:51.538Z"
}
```

Returns 500 with `"Database connection failed"` if the database is unreachable.

---

## Auth

### `POST /api/auth/login`
No authentication. Rate limited to 10 attempts per IP per 15 minutes.

Request:

```json
{ "email": "admin@foodex.com", "password": "YourPassword123" }
```

Response 200:

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "name": "FoodEx Admin",
      "email": "admin@foodex.com",
      "mobile": null,
      "restaurantId": 1,
      "restaurantName": "FoodEx Restaurant",
      "outletId": null,
      "roles": ["RESTAURANT_ADMIN"],
      "permissions": ["menu.view", "menu.manage", "orders.create", "..."]
    }
  }
}
```

Errors:

| Code | Message | Cause |
| --- | --- | --- |
| 400 | `Email and password are required` | Missing or non-text field |
| 401 | `Invalid email or password` | Unknown email **or** wrong password (deliberately the same message) |
| 403 | `Your account is not active` | User status is `inactive` or `locked` |
| 403 | `Your restaurant is not active` | Restaurant is `inactive` or `suspended` |
| 429 | `Too many login attempts. Please try again after 15 minutes.` | Rate limit |

Email matching ignores case. Passwords longer than 72 characters are rejected,
because bcrypt only uses the first 72 bytes.

### `GET /api/auth/me`
Requires a token. Returns the current user, with fresh roles and permissions.

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "FoodEx Admin",
    "email": "admin@foodex.com",
    "restaurantId": 1,
    "restaurantName": "FoodEx Restaurant",
    "roles": ["RESTAURANT_ADMIN"],
    "permissions": ["menu.view", "..."]
  }
}
```

Errors: 401 `Authentication required` (no token), 401 `Invalid or expired token`,
403 if the account or restaurant is not active.

---

## Restaurants

### `GET /api/restaurants/current`
Requires a token **and** the `restaurant.settings.view` permission.

Returns the logged-in user's own restaurant. The id comes from the token, so one
restaurant can never read another's data.

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "FoodEx Restaurant",
    "code": "ABC001",
    "contact": "9876543210",
    "email": null,
    "address": "Rajahmundry, Andhra Pradesh",
    "status": "active",
    "created_at": "2026-09-17T09:18:18.851Z",
    "updated_at": "2026-09-17T09:18:18.851Z"
  }
}
```

Errors:

| Code | Message | Cause |
| --- | --- | --- |
| 400 | `This account is not linked to a restaurant` | A platform user (Super Admin) called it |
| 403 | `You do not have permission to perform this action` | Role lacks `restaurant.settings.view` |
| 404 | `Restaurant not found` | The restaurant row was deleted |

---

## Permission codes

Used with `authorize("code")` on routes. See `docs/DATABASE.md` for which roles
have which codes.

| Module | Codes |
| --- | --- |
| platform | `platform.restaurants.manage` |
| restaurant | `restaurant.settings.view`, `restaurant.settings.manage`, `outlets.view`, `outlets.manage` |
| users | `users.view`, `users.manage`, `roles.view`, `roles.manage` |
| menu | `menu.view`, `menu.manage` |
| tables | `tables.view`, `tables.manage` |
| orders | `orders.view`, `orders.create`, `orders.manage` |
| billing | `billing.manage` |
| payments | `payments.manage` |
| kitchen | `kot.manage`, `kds.view` |
| reports | `reports.view` |

---

## Testing with curl

```bash
# Login and keep the token
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@foodex.com","password":"YourPassword123"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).data.token")

# Use it
curl -s http://localhost:5000/api/auth/me -H "Authorization: Bearer $TOKEN"
curl -s http://localhost:5000/api/restaurants/current -H "Authorization: Bearer $TOKEN"
```

In PowerShell:

```powershell
$body = '{"email":"admin@foodex.com","password":"YourPassword123"}'
$login = Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/auth/login -ContentType application/json -Body $body
Invoke-RestMethod -Uri http://localhost:5000/api/auth/me -Headers @{ Authorization = "Bearer $($login.data.token)" }
```

---

## Planned endpoints

Added as each module is built. The pattern stays the same: `authenticate`, then
`authorize(...)`, then the controller, with `restaurant_id` from the token.

| Module | Endpoints |
| --- | --- |
| Users | `GET/POST/PUT /api/users`, `GET /api/roles` |
| Menu | `GET/POST/PUT/DELETE /api/categories`, `/api/products` |
| Tables | `/api/floors`, `/api/tables` |
| Orders | `POST /api/orders`, `GET /api/orders`, `PATCH /api/orders/:id/status` |
| Billing | `POST /api/bills`, `POST /api/payments` |
| Kitchen | `GET /api/kots`, `PATCH /api/kots/:id/status` |
