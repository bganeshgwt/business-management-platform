# API reference

For developers of the staff app, the guests' site and future apps, and for integrators: every endpoint of the API, and the conventions every caller follows.

The list comes from the routers themselves. Every route mounted by `backend/src/app.js` and `backend/src/routes/index.js` (including the routers each of those mounts) is listed below: the routers are loaded without starting the server and their stacks walked, and each group is described from its controller, service, validator and repository. The tasks module's routes exist under two prefixes (`/api/tasks` and `/api/businesses/:businessId/tasks`) and are listed once; so do live updates' (`/api/live` and `/api/businesses/:businessId/live`).

Base URL (development): `http://localhost:5010/api` (the `PORT` in `backend/.env`). Uploaded pictures (menu and product photos, in the folder `UPLOADS_DIR` names, `backend/uploads` when it is not set) are served read-only at `http://localhost:5010/uploads/...`.

The tables behind these endpoints are in [DATABASE.md](DATABASE.md), and how a request flows through the code is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Contents

1. [Conventions](#conventions)
2. [Platform, access and settings](#platform-access-and-settings)
3. [Menu](#menu)
4. [Tables](#tables)
5. [Kitchen](#kitchen)
6. [Front of house: orders, table requests, reservations, deliveries and guest pages](#front-of-house-orders-table-requests-reservations-deliveries-and-guest-pages)
7. [Back-office rules: stock, purchasing and expenses](#back-office-rules-stock-purchasing-and-expenses)
8. [Suppliers](#suppliers)
9. [Inventory](#inventory)
10. [Inventory insights (waste and reorder)](#inventory-insights-waste-and-reorder)
11. [Purchase orders and purchase bills](#purchase-orders-and-purchase-bills)
12. [Purchase returns and supplier payments](#purchase-returns-and-supplier-payments)
13. [Expenses](#expenses)
14. [Guests (CRM)](#guests-crm)
15. [Guest insights](#guest-insights)
16. [Staff](#staff)
17. [Time clock](#time-clock)
18. [Reports](#reports)
19. [Bills, payments and money](#bills-payments-and-money)
20. [Business Admin (multi-business platform)](#business-admin-multi-business-platform)
21. [Shared receivables and Wholesale](#shared-receivables-and-wholesale)
22. [Retail (counter, udhaar, offers, loyalty, books)](#retail-counter-udhaar-offers-loyalty-books)
23. [Fashion, electronics, salon and weight-based shops](#fashion-electronics-salon-and-weight-based-shops)
24. [Pharmacy, clinic & lab](#pharmacy-clinic--lab)
25. [Quotations](#quotations)
26. [Licences & registrations](#licences--registrations)
27. [Hardware, paints & building materials](#hardware-paints--building-materials)
28. [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides)
29. [Optical shops](#optical-shops)
30. [Vehicle service & auto parts](#vehicle-service--auto-parts)
31. [Gyms, studios & coaching](#gyms-studios--coaching)
32. [Laundry & dry cleaning](#laundry--dry-cleaning)
33. [Jewellery & gold](#jewellery--gold)
34. [Rentals & hire](#rentals--hire)
35. [Fuel stations](#fuel-stations)
36. [Hotels, lodges & guest houses](#hotels-lodges--guest-houses)
37. [Tasks, issues & projects](#tasks-issues--projects)
38. [Live updates](#live-updates)
39. [Personal data](#personal-data)
40. [Owner's GST thresholds](#owners-gst-thresholds)

Sections 2 to 19 are the restaurant module's API, with the sign-in and platform routes every app uses. Sections 20 to 36 are the Business Admin's, under `/api/businesses`. Sections 37 to 40 serve both.

## Conventions

### Envelope

Every JSON response has the same shape:

```json
{ "success": true,  "message": "optional", "data": { } }
{ "success": false, "message": "A sentence meant for people", "data": { "reason": "machine_code", "...": "..." } }
```

`data` on an error is present only when the server has something a screen
can act on (most often a `reason` code). The two health checks are the only
endpoints that answer outside `data`.

### Authentication

Every endpoint except the health checks, `POST /api/auth/login` (and its
two-step steps) and the `/api/public/...` guest pages needs

```
Authorization: Bearer <token>
```

The token lasts `JWT_EXPIRES_IN` (default 8 h) without use and is renewed by
`POST /api/auth/refresh`. The user, their roles and permissions are reloaded
on every request, so switching someone off, signing them out or changing a
role takes effect at once.

**A password someone else set.** A new login's first password, and a new one
an admin or the platform sets for someone, works for one sign-in. That
session's `user.passwordChangeRequired` is `true` (after the two-step code,
where the person uses one), and until they choose their own with
`POST /api/auth/change-password`, every endpoint answers **403**
`{ reason: "password_change_required" }` except that one and
`GET /api/auth/me`. Signing out needs no request: the client forgets its
token. The check is in `middlewares/authenticate.js`, so every route has it;
the two that the change needs use `authenticate.duringPasswordChange`.

### Request headers the API reads

| Header | Meaning |
| --- | --- |
| `Authorization: Bearer <token>` | The session. |
| `X-Outlet-Id: <id>` | The outlet a restaurant request works in (the top-bar switcher). Staff pinned to an outlet always work there; asking for another answers 403. An inactive outlet answers 403 `{ reason: "outlet_inactive" }`. Without the header an unpinned user works with *All outlets*. Reports and the dashboard read the outlet from `?outletId=` instead and may read a closed outlet. |
| `X-Approval-Token: <token>` | A manager's one-time approval for one action, from `POST /api/auth/approvals` (see below). |
| `X-Business-Location: <id>` | Business Admin only: the branch picked in the top bar. It fills in the location a request leaves out (`location` / `locationId` in the query), so lists, reports and the counter open on that branch. It must be an active location of the business; anything else is ignored. A person whose access is tied to one location always works there, and the header is ignored for them. |

### Status codes every caller must handle

| Code | When |
| --- | --- |
| 400 | Missing or invalid field (the message names it), invalid JSON (`Invalid JSON in request body`), invalid paging, a date range ending before it starts, an upload that is too large (images: 2 MB). |
| 401 | No token, a bad or expired token, wrong credentials, a session signed out elsewhere. |
| 403 | The role lacks the permission (`You do not have permission to perform this action`), the account or restaurant is inactive, the outlet (or a business's location) is not yours, a Business Admin module is switched off, a restaurant feature is switched off (below), a manager's approval is needed (below), or the person must first choose their own password (`password_change_required`, see [Authentication](#authentication)). |
| 404 | Unknown route (`Route not found: METHOD /path`), or a record that does not exist **or belongs to another restaurant, outlet or business** — the API never says which. |
| 409 | A rule refused the change (a closed day, a paid bill, a duplicate code, a posted count, the cash limit), or `{ reason: "conflict_retry" }` when two tills changed the same rows at the same instant and PostgreSQL rolled one back: nothing was saved, try again. A rule a database trigger keeps (SQL state 23514 naming no constraint, such as a restaurant's cash limit or a missing buyer's PAN) answers 409 with the trigger's own sentence on every route. |
| 413 | A request body over what its route takes: 1 MB, and 5 MB for a shop's CSV import (`…/catalog/import`, `…/contacts/import`). Nothing was read; send it in smaller parts. |
| 423 | An account, device or PIN is locked after too many wrong tries (`account_locked`, `device_locked`, `pin_locked`, with `lockedUntil`). |
| 429 | Too many failed sign-ins / PIN tries from one address in 15 minutes (`LOGIN_ATTEMPT_LIMIT`, default 30; the PIN limiter allows at least 30), or a public guest page called too often. |
| 500 | `Internal server error` — logged on the server. |

### Restaurant features (switched off = 403)

A restaurant can switch parts of itself off (Settings → Features; see
[Restaurant features](#restaurant-features) below). Every endpoint of a
switched-off feature answers **403** with
`{ success: false, message: "<Feature> is switched off for this restaurant. An owner can switch it on in Settings → Features.", data: { reason: "feature_off", feature: "<code>" } }`.
The check is `middlewares/requireFeature.js` (`requireFeature("code")`, or
`requireFeature.any(...)`), applied route by route after `authenticate`; it
reads `req.user.features`, which the profile loads on every request from
`restaurant_features(restaurant_id)`. The public pages (table QR, booking link,
online ordering) answer 403 with a sentence for the guest and the same `data`.

| Feature code | Endpoints refused while it is off |
|---|---|
| `guests` | `/api/crm/*`, `/api/guest-insights/*`, `/api/crm/customers/:id/addresses/*`, `GET /api/orders/guest`; an order naming a `customerId`; putting a bill on a guest's account; QR feedback |
| `guest_loyalty` | `GET /api/discounts/loyalty`, `GET /api/crm/reports/loyalty`; `loyaltyPoints` on `POST /api/bills` and `PATCH /api/bills/:id/adjust` |
| `reservations` | `/api/reservations/*`; the public booking link `/api/public/booking/:token*` |
| `qr_ordering` | `GET /api/tables/qr-settings`; the table QR pages `/api/public/tables/:token/*`; accepting a QR request; `POST /api/table-requests/bill-asks` |
| `online_ordering` | `/api/orders/service-settings/online-ordering*`; the ordering page `/api/public/online/:token/*`; accepting an online order |
| `qr_ordering` or `online_ordering` | `/api/table-requests/*` (with only one on, lists and counters show that one's requests only) |
| `deliveries` | `/api/deliveries/*` except `/api/deliveries/channels*`; `POST /api/orders` with `orderType: "delivery"`; the online ordering page offers takeaway only |
| `kitchen_display` | `GET /api/kitchen/board`, `GET /api/kitchen/pass`, `POST /api/kitchen/sync`, `POST /api/kitchen/recall`, `POST /api/kitchen/clear-old`, `GET /api/kitchen/kots/:id`, `PATCH /api/kitchen/kots/:id/status`, `PATCH /api/kitchen/kots/:id/items/:itemId`, `POST /api/kitchen/kots/:id/items/:itemId/serve`, `POST /api/kitchen/kots/:id/recall`, `GET /api/kitchen/day`, `GET /api/reports/live/kitchen`, `GET /api/reports/kitchen-stations` (stations, slips, printing and an order's tickets stay) |
| `captain_sections` | `/api/tables/sections*` |
| `preorders` | `/api/preorders/*` |
| `brands` | `GET/POST /api/menu/brands`, `PUT /api/menu/brands/:id`, `GET /api/menu/brands/report` |
| `tips` | `/api/staff/tips/*` (needs `staff_payroll` too); a payment with `tipAmount` > 0 |
| `advances` | `/api/bills/advances/*`; a payment with `paymentMethod: "advance"` or an `advanceId`; a pre-order's advance (`advance.amount` above 0 on `POST /api/preorders`, and `POST /api/preorders/:id/advance`) |
| `cash_drawers` | `POST /api/business-day/drawers`, `POST /api/business-day/drawers/:id/close`; a cash movement or X report naming a `drawerId` / `cashierId`. `GET /api/business-day/drawers` stays (the day's cash in and out) and returns `drawers: []`, `drawersOff: true` |
| `coupons` | `GET/POST /api/discounts`, `PUT/DELETE /api/discounts/:id`; `discountCode` on a bill (`GET /api/discounts/given` stays) |
| `stock_recipes` | `/api/inventory/*`, `/api/inventory-insights/*`, `/api/suppliers/*`, `/api/purchase-orders/*`, `/api/purchase-returns/*`, the recipe routes under `/api/menu` (`products/:id/recipe`, `recipe/:id`, `recipes/import*`, `modifiers/:id/recipe`), `GET /api/reports/profitability`, `GET /api/reports/consumption` |
| `staff_payroll` | `/api/staff/*` (except `/api/staff/logbook/*`), `/api/timeclock/*`, `GET /api/auth/me/work` |
| `tasks`, `issues`, `projects` | `/api/tasks/*`: the issue routes need `issues`, the project routes `projects`, the rest `tasks` (see [Tasks, issues & projects](#tasks-issues--projects)) |

The notification bell does not ask a switched-off feature's providers
(`feature` on a provider; see [backend/src/notifications/README.md](../backend/src/notifications/README.md)).

### Permissions and manager approval

Each endpoint below names its **permission** (a code such as `orders.create`).
"`a` + `b`" means both are needed, "`a` or `b`" means either. The codes are
listed in [DATABASE.md › Restaurant permission codes](DATABASE.md#restaurant-permission-codes)
and [DATABASE.md › Business permission codes](DATABASE.md#business-permission-codes).

Endpoints marked "**or manager approval**" let a person without the
permission go ahead once, when a manager approves at their side:

1. The call without the permission answers **403** with
   `data: { reason: "approval_required", permission, action, scope }`.
   `scope` lists the facts the approval will be tied to (for example
   `{ billId, amount }`).
2. The screen asks the manager for their PIN or password and calls
   `POST /api/auth/approvals` with the permission and those facts; the answer
   carries a token valid for `APPROVAL_TTL_SECONDS` (default 120).
3. The original call is repeated with `X-Approval-Token`. The token is spent
   before the action runs and is never handed back: if the action then fails
   (a missing reason, an already paid bill), the message adds that the
   approval was used and `data.approvalUsed` is `true`. A token approved for
   ₹50 does not cover ₹2,400; a mismatch re-opens the prompt.

The activity log records both the person and the approving manager.

### Lists, paging and dates (restaurant)

Restaurant lists that can grow are paged by the server, mostly with `page`
(from 1) and `pageSize` (25, 50 or 100), answering `{ items, total, page,
pageSize, ... }`; each endpoint below states its own paging and shape. Dates
are `YYYY-MM-DD` in the restaurant's own time zone, and money lists use the
**business day** a record belongs to, not its calendar date. Report ranges
are at most 731 days; with no dates a report reads the current trading day.

### Business Admin conventions

All Business Admin routes live under `/api/businesses/:businessId/...`; only the three directory routes sit under `/api/businesses` itself. These rules hold for every one of them:

- **Membership.** Every `/:businessId/...` route first loads the caller's active membership of an active business. No membership, or an unknown ID, answers **404** "Business not found": a business you are not a member of looks exactly like one that does not exist.
- **Module and permission.** A permission `x.y` needs the module `x` switched on for that business and held by the caller's role. The core modules `settings`, `access`, `reports` and `audit` are always on. A module that is off answers **403** "<Module> is not switched on for this business..."; a role without the permission answers **403** "Your role (<role>) does not allow this: ...". For example `receivables.*` needs Collections & outstanding (`receivables`), `sales_orders.*` needs Sales orders & dispatch, `wholesale.*` needs Wholesale price lists, `offers.*` and `loyalty.*` need Offers and Loyalty, and `repairs.*` needs Repairs & service. The module codes are listed in [DATABASE.md › Platform module codes](DATABASE.md#platform-module-codes). "Any member" below means membership alone. "`a` or `b`" means either permission passes the route; the service then checks the exact one the record needs (for example `sales.*` for a sale and `purchasing.*` for a purchase). Services repeat every check, so a rule holds whichever way a service is called.
- **JSON body on writes.** Every `POST`, `PATCH` and `PUT` sends a JSON object body, even one that reads nothing (send `{}`); otherwise it answers 400 "A JSON object is required".
- **Paged lists** take `limit` (1-100, default 25), `offset` (0-10,000,000), `q` (search, up to 100 characters), `from` / `to` (`YYYY-MM-DD`, read in the business's time zone and applied only to lists with a date column) and the list's own filters (each an exact match on the column's text value). They answer `data: { total, items }`. Paging values out of range answer 400 "Invalid pagination", and a `to` before `from` answers 400 "The end date is before the start date".
- **Request keys.** Postings that create money or stock take a `requestKey`: a UUID (versions 1-5) chosen by the screen; anything else answers 400 "A valid request key is required". Sending the same key with the same body returns the first result instead of posting twice. The same key with a different body answers **409** "This request key was already used for ...".
- **Database rules** come back as answers: a duplicate (23505) answers **409** "This code, name, number or request already exists in this business"; a reference to another business's record (23503) answers **400** "A related record is not available in this business"; a rule raised by a trigger (23514 without a constraint name) answers **409** with the trigger's own sentence; any other failed CHECK answers **400**.
- **Locations.** A person's access can be tied to one location (`workLocationId` on `POST …/members`; an owner never is). They then work there only: a location they name in the query (`location`, `locationId`) or the body (`locationId`, `fromLocationId`) must be theirs, a request that names none is answered for theirs (a write with no `locationId` gets theirs), and another location's records answer 403 "You work at <location> only. Ask a manager who works across every location." Anyone else may pick a branch in the top bar (`X-Business-Location`), which only fills in the location a request leaves out. The overview, reports and lists follow the location in effect, and so do the summary's sales, stock, appointment and today figures. The branch comparison (`reports/locations`) is narrowed only for a person tied to a location. Customers' and suppliers' balances stay business-wide.
- **Departments.** A person can also be tied to one department (`workDepartmentId` on `POST …/members`). They then see and change that department's products and stock only (an item is in its category's department); billing stays open to every item.
- **Payment methods.** Where a body says how money moved with `method` (`cash`, `upi`, `card`, `bank`, `cheque`), it may name one of the business's own payment methods with `methodId` instead (`GET …/payment-methods`). A financier's payout (`POST …/finance/settlements`), a stylist's tip on a salon bill and a commission payout (`POST …/salon/commission-payouts`) take `method` only. The method's kind counts the money (day close, drawer, cheque register) and its name is recorded with the payment (`method_name`). With both, `method` must be the method's kind (400). A switched-off method answers 409, an unknown one 404, and a kind the step does not take 400 (a refund never goes out by cheque).
- **GST rates by date.** A GST rate change entered ahead ([GST rate changes](#gst-rate-changes)) takes effect when the first request on or after its date opens the business (its own time zone), before anything is read, and again inside each posting under the business's lock. So every route reads an item's GST slab as it is on the business's date. A posting that a change overtakes around midnight (its fixed prices were worked out at the day before's rate, or it began before another request applied the change) answers **409** `{ reason: "gst_rates_changed" }`; sending it again, with the same request key, posts it at the rates in force.

---

## Platform, access and settings

### Health
Mounted at `/api` (routes/health.routes.js). Public, no rate limit. These two answer outside the usual envelope (no `data`).

#### `GET /api/health`
Permission: public
Query/Body: none
Returns: `{ success: true, message: "Business Management Platform API is running" }` (no `data`).
Errors: none.

#### `GET /api/db-health`
Permission: public
Query/Body: none
Returns: `{ success: true, message, time }` where `time` is the database `NOW()` (top level, no `data`).
Errors: 500 `{ success: false, message: "Database connection failed" }`.

### Auth: rate limits and lockouts
Mounted at `/api/auth` (routes/auth.routes.js). Three IP limiters (middlewares/rateLimiters.js) count per real client address (utils/clientIp.js; behind a proxy the address `TRUST_PROXY` says to read; IPv6 grouped by network), over a 15-minute window, and count **only failed requests** (any status >= 400; `skipSuccessfulRequests`). They run before `authenticate`, so a 401 also counts. Over the limit they answer 429 `{ success: false, message }` with no `data`, plus draft-8 `RateLimit`/`RateLimit-Policy` headers.
- `loginLimiter`: `LOGIN_ATTEMPT_LIMIT` (default 30) per 15 min. "Too many failed sign-ins from this network. Please try again after 15 minutes." On `/login` and the three `/login/two-factor*` routes.
- `passwordChangeLimiter`: same limit. "Too many attempts. Please try again after 15 minutes." On `/change-password`, `/two-factor/setup|enable|disable|recovery-codes`, `PUT|DELETE /me/pin`.
- `pinLimiter`: `max(30, LOGIN_ATTEMPT_LIMIT)` per 15 min. "Too many wrong PINs from this till. Please wait 15 minutes." On `/pin-login`, `/unlock`, `/approvals`.

Per-account lockout (modules/access/services/auth.service.js, config `accountLock`): `ACCOUNT_LOCK_ATTEMPTS` (default 5) wrong tries inside `ACCOUNT_LOCK_WINDOW_MINUTES` (default 15) lock for `ACCOUNT_LOCK_MINUTES` (default 15). The try is reserved before the compare, so parallel guesses get at most 5 checks. One count is shared by wrong passwords at sign-in, wrong two-step codes at sign-in, and the signed-in person's own password/code checks (change password, set/clear PIN, unlock by password, 2FA setup/disable/new codes). A browser that sends a remembered `deviceTokens` entry for that account counts on its own device counter instead (so a stranger's guesses do not lock out the owner's phone). Each personal PIN has its own separate 5-try counter. Lock answers:
- 423 `{ reason: "account_locked" | "device_locked", lockedUntil }` (message gives the time in the restaurant's timezone); PIN: 423 `{ reason: "pin_locked", lockedUntil }`.
- 429 `{ reason: "too_many_attempts" }` when every try in the window is already taken by attempts in flight.
- Wrong but not yet locked: 400 `{ reason: "wrong_password" | "wrong_code" | "wrong_pin", attemptsLeft }` (sign-in password: 401 with no count).
A user manager can lift all three counters early with `POST /api/users/:id/unlock`.

Tokens: `token` is an HS256 JWT (`JWT_EXPIRES_IN`, default 8h) carrying a token version and a random id of its own (two sign-ins in the same second are still two sessions); changing/resetting the password or "sign out everywhere" bumps the version and older tokens get 401 `{ reason: "session_revoked" }`. Status, roles and permissions are re-read from the database on every request; an inactive user or restaurant gets 401 `{ reason: "account_inactive" | "restaurant_inactive" }`. `deviceTokens` (array of up to 20 strings, `[A-Za-z0-9_-]{20,100}`, malformed ones ignored) is the browser's remembered-device tokens, sent on sign-in and on routes that keep this device remembered. Device memory lasts 120 days.

### Auth: sign-in and two-step sign-in
Two-step flow:
1. `POST /api/auth/login` with the password. If two-step is off and not required by any of the person's roles, or the device is remembered and trusted for two-step (30 days), it returns the session. Otherwise it returns `data.twoFactor = { step: "code" | "setup", challengeToken, expiresAt, message, trustDays: 30, user: { name } }` and no session (envelope `message` = `twoFactor.message`).
2. `step: "code"`: `POST /api/auth/login/two-factor` with the ticket and the 6-digit code (or a recovery code).
   `step: "setup"` (role requires it, not yet set up): `POST /api/auth/login/two-factor/setup` (QR + key), then `POST /api/auth/login/two-factor/enable` with the first code.
The `challengeToken` is signed with a separate key (never usable as a session), lasts 10 minutes, is bound to step, user, token version and remembered device, and works once. Ticket errors: 401 `challenge_expired` (missing, expired, password changed since); 400 `challenge_mismatch` (wrong step's ticket); 409 `challenge_used` (already spent). Codes accept `123 456` / `123-456`. Code tries count in the same lockout as the password (the password's try stays counted until the code is right).

Session shape (`data`): `{ token, expiresAt, user, deviceToken? }`. `user` = `{ id, name, email, mobile, restaurantId, restaurantName, restaurantCode, restaurantFormat, outletId, outletName, employeeId, employeeCode, roles, roleNames, permissions[], features[], hasPin, twoFactorEnabled, passwordChangeRequired, idleLockMinutes }`. `restaurantFormat` is `restaurant`, `cafe`, `bakery` or `cloud_kitchen` (see `GET /api/restaurants/current/format`); `features` are the restaurant features switched on. `passwordChangeRequired` is `true` when someone else set the password the person signed in with: the session then reaches only `GET /api/auth/me` and `POST /api/auth/change-password`, which gives a fresh session (see [Authentication](#authentication)). `deviceToken` appears only when this browser was not yet remembered; the client stores it and sends it back in `deviceTokens`.

#### `POST /api/auth/login`
Permission: public, rate limited (`loginLimiter`)
Query/Body: `identifier` (string, required, <=150; email, 10-digit mobile in any common format, or staff/employee code; `email` accepted as an alias), `password` (string, required, <=72), `restaurantCode` (string, <=30; required with a staff code, or when one mobile signs in to two restaurants), `deviceTokens` (string[])
Returns: a session (above), or `{ twoFactor: {...} }` when the code or setup step is next. With `user.passwordChangeRequired: true` the person chooses their own password next (`POST /api/auth/change-password`). Every attempt on a real account is written to that user's sign-in history.
Errors: 400 missing fields; 400 `restaurant_code_required`; 401 wrong sign-in (same message whether the login exists or not, same timing); 403 `account_inactive` / `restaurant_inactive` (only after a right password); 423 `account_locked` / `device_locked`; 429 `too_many_attempts` or IP limiter.

#### `POST /api/auth/login/two-factor`
Permission: public, rate limited (`loginLimiter`); needs a `step: "code"` ticket
Query/Body: `challengeToken` (string, required), `code` (6 digits; required unless `recoveryCode`), `recoveryCode` (string <=20, e.g. `ABCDE-FGHJK`, single use), `trustDevice` (boolean; skip the code on this browser for 30 days)
Returns: the session; plus `recoveryCodesLeft` when a recovery code was used (also logged to the activity log).
Errors: ticket errors above; 400 `wrong_code` `{ attemptsLeft }` (also: code reused in the same 30 s step, or server cannot read the key); 423 `account_locked` / `device_locked`; 429.

#### `POST /api/auth/login/two-factor/setup`
Permission: public, rate limited (`loginLimiter`); needs a `step: "setup"` ticket
Query/Body: `challengeToken` (string, required)
Returns: `{ otpauthUrl, secret, account, issuer }` (QR content and the key to type; a new pending secret each call).
Errors: ticket errors above; 409 `challenge_used` if two-step is already on for the account.

#### `POST /api/auth/login/two-factor/enable`
Permission: public, rate limited (`loginLimiter`); needs a `step: "setup"` ticket
Query/Body: `challengeToken` (required), `code` (6 digits, required), `trustDevice` (boolean)
Returns: the session plus `recoveryCodes` (10 codes, shown once). Two-step is on from now.
Errors: ticket errors; 400 `wrong_code` `{ attemptsLeft }`; 409 `no_setup` (call setup first) / `challenge_used`; 423; 429.

### Auth: own account and sessions
All need a session (`Authorization: Bearer`). Only the caller's own record is touched; no permission needed.

#### `GET /api/auth/me`
Permission: login only, also while the password must change
Query/Body: none
Returns: `data` = the `user` profile shape above, fresh from the database.
Errors: none beyond 401.

#### `PUT /api/auth/me`
Permission: login only
Query/Body: `name` (string, required, <=150), `mobile` (string <=20, 10-digit Indian mobile; stored as 10 digits). Email and roles cannot be changed here.
Returns: the updated profile.
Errors: 400 bad mobile; 400 removing the mobile from a login with no email; 409 mobile used by another login in the restaurant.

#### `POST /api/auth/change-password`
Permission: login only, also while the password must change; rate limited (`passwordChangeLimiter`)
Query/Body: `currentPassword` (required; after a password someone else set, the one given), `newPassword` (8-72 chars, must differ), `deviceTokens` (keeps this browser remembered)
Returns: a fresh session `{ token, expiresAt, user }`. All other sessions end, this device's old token included, other remembered devices are forgotten, 30-day two-step trust ends everywhere. It is the person's own password from now on: `user.passwordChangeRequired` is `false`. The password is replaced only if it is still the one just checked.
Errors: 400 missing current; 400 `wrong_password` `{ attemptsLeft }` ("The password you were given is not right" after a password someone else set); 400 new = current, compared with the stored password too ("Choose a password of your own, not the one you were given" after a password someone else set); 400 length; 409 `password_changed` (another request changed it meanwhile; nothing saved); 423 `account_locked`; 429.

#### `POST /api/auth/refresh`
Permission: login only
Query/Body: none
Returns: `{ token, expiresAt }` (sliding session; same token version).
Errors: 401 when the current token is expired or revoked (cannot be refreshed).

#### `POST /api/auth/sign-out-others`
Permission: login only
Query/Body: `deviceTokens` (string[]; this browser stays remembered)
Returns: `{ token, expiresAt }`. Bumps the token version (every other session ends on its next request), forgets other remembered devices, ends 30-day two-step trust on all devices including this one.
Errors: none specific.

#### `GET /api/auth/me/sign-ins`
Permission: login only
Query/Body: none
Returns: last 20 sign-in attempts: `[{ id, method, outcome, identifier, ipAddress, userAgent, trustedDevice, twoFactor, createdAt }]`. `method` is `password | two_factor | recovery_code | pin | unlock`; `outcome` e.g. `success | wrong_password | wrong_code | wrong_pin | locked | inactive | code_needed | setup_needed | two_factor_device`.
Errors: none specific.

#### `GET /api/auth/me/work`
Permission: login only (through the login's link to a staff record; no staff permission needed)
Query/Body: none
Returns: `{ employee: { id, name, employeeCode, designation, department, outletName }, today, weeks[2] (this/next week roster, 7 days each: { date, today, status, shiftName, startTime, endTime, leaveType, notes }), month: { from, to, present, halfDays, absent, leave, weekOffs, lateDays, lateMinutes, workedHours, overtimeHours, days[] }, leave (balances or null), payslips[] }`. See services/myWork.service.js.
Errors: 404 `not_linked` (login not linked to a staff record).

#### `GET /api/auth/me/payslips/:id`
Permission: login only (own payslips only)
Query/Body: `:id` payslip (salary payment) id
Returns: `{ employee: { name, employeeCode, designation }, id, periodFrom, periodTo, payableDays, paidLeaveDays, unpaidLeaveDays, earned, bonus, tips, advances, deductions, pfEmployee, esiEmployee, professionalTax, pfEmployer, esiEmployer, netPay, amountPaid, paymentMethod, paidOn, reference }`.
Errors: 404 `not_linked`; 404 payslip not found / not yours.

### Auth: own two-step sign-in (My profile)

#### `GET /api/auth/two-factor`
Permission: login only
Query/Body: none
Returns: `{ enabled, enabledAt, required, recoveryCodesLeft, trustedDevices, trustDays: 30 }` (`required` = one of the person's roles must use it).
Errors: none specific.

#### `POST /api/auth/two-factor/setup`
Permission: login only, rate limited (`passwordChangeLimiter`)
Query/Body: `password` (required)
Returns: `{ otpauthUrl, secret, account, issuer }` (new pending secret).
Errors: 400 `wrong_password` `{ attemptsLeft }`; 409 `already_enabled`; 423; 429.

#### `POST /api/auth/two-factor/enable`
Permission: login only, rate limited (`passwordChangeLimiter`)
Query/Body: `code` (6 digits, required), `deviceTokens` (this device is marked as having passed two-step, so the PIN switch works here)
Returns: `{ recoveryCodes }` (10, shown once).
Errors: 400 `wrong_code` (not counted in the lockout); 409 `already_enabled`; 409 `no_setup`.

#### `POST /api/auth/two-factor/disable`
Permission: login only, rate limited (`passwordChangeLimiter`)
Query/Body: `password` (required), `code` (6 digits) or `recoveryCode`
Returns: the status shape of `GET /api/auth/two-factor`.
Errors: 400 `wrong_password` / `wrong_code` `{ attemptsLeft }`; 409 already off; 423 `account_locked`; 429.

#### `POST /api/auth/two-factor/recovery-codes`
Permission: login only, rate limited (`passwordChangeLimiter`)
Query/Body: `password` (required)
Returns: `{ recoveryCodes }` (10 new; old ones stop working).
Errors: 400 `wrong_password`; 409 two-step not on; 423; 429.

### Auth: personal PIN and the shared till
A PIN is 4-6 digits sent as a string (leading zeros kept). Weak PINs (runs like 1234, repeats like 1111) and the last digits of the person's mobile are refused. A PIN only ever works from a till that is already signed in to the same restaurant.

#### `PUT /api/auth/me/pin`
Permission: login only, rate limited (`passwordChangeLimiter`)
Query/Body: `pin` (string, required, 4-6 digits), `confirmPin` (must match when sent), `password` (required; own password)
Returns: the updated profile (`hasPin: true`).
Errors: 400 PIN format / weak / mobile ending / mismatch; 400 `wrong_password` `{ attemptsLeft }`; 423; 429.

#### `DELETE /api/auth/me/pin`
Permission: login only, rate limited (`passwordChangeLimiter`)
Query/Body: `password` (required, in the body)
Returns: the updated profile (`hasPin: false`).
Errors: 400 missing / `wrong_password`; 423; 429.

#### `GET /api/auth/till-users`
Permission: login only
Query/Body: none
Returns: active people of the caller's restaurant who have a PIN: `[{ id, name, roleNames, outletId, locked }]` (`locked` = PIN locked now). Empty for a login with no restaurant.
Errors: none specific.

#### `POST /api/auth/pin-login`
Permission: login only, rate limited (`pinLimiter`)
Query/Body: `userId` (id, required), `pin` (string, required), `deviceTokens` (string[])
Returns: a new session for that person `{ token, expiresAt, user }` (the till carries on as them). Written to their sign-in history (method `pin`). When someone else set their password, `user.passwordChangeRequired` is `true` and the session reaches no more than a sign-in's would until they choose their own.
Errors: 400 caller not linked to a restaurant; 400 `wrong_pin` `{ attemptsLeft }`; 403 `account_inactive` / `restaurant_inactive`; 403 `two_factor_device` (person uses or needs two-step and has not passed it on this device); 404 person not in this restaurant; 409 `no_pin`; 423 `pin_locked`, or `account_locked` (password lockout, unless this device is remembered for them); 429.

#### `POST /api/auth/unlock`
Permission: login only, rate limited (`pinLimiter`)
Query/Body: `pin` (own PIN), or `password` (string <=72) when no PIN is sent
Returns: `{ unlocked: true }` (the session is unchanged; the screen just reopens).
Errors: 400 `wrong_pin` / `wrong_password` `{ attemptsLeft }`; 409 `no_pin`; 423 `pin_locked` / `account_locked`; 429.

### Auth: manager approvals
How a person without a permission gets one action approved at the till by a manager's PIN. The returned `approvalToken` is sent as `X-Approval-Token` on the protected request (see the intro). Never approvable: `platform.restaurants.manage`, `users.manage`, `roles.manage`. `scope` ties the approval to facts (allowed keys: `billId, orderId, orderItemId, businessDayId, customerId, productId, inventoryItemId, purchaseOrderId, stockCountId, paymentId, advanceId, amount, quantity, points, pointsOff, percent, closingCash, carryUnpaid, fromMethod, toMethod, cashMove` (a cash entry's direction, so a PIN given for money in cannot take money out); see services/approval.service.js). For `bills.discount`, managers whose role discount cap is below `scope.percent` are not offered.

#### `GET /api/auth/approvers`
Permission: login only
Query/Body: `permission` (string, required, <=100), `scope` (JSON text, <=500 chars)
Returns: `{ permission, action, scope, summary, facts[], approvers: [{ id, name, lockedUntil }], notAllowed: [{ id, name, limit }] }` (caller excluded; `summary`/`facts` are the server's words for the scope, e.g. "Refund ₹50.00 on bill INV-0042").
Errors: 400 not linked to a restaurant; 400 unknown or never-approvable permission; 400 unreadable scope / bad scope field; 404 scoped record not found.

#### `POST /api/auth/approvals`
Permission: login only, rate limited (`pinLimiter`)
Query/Body: `permission` (required), `pin` (manager's PIN, required), `approverId` (id; the screen always sends it, otherwise the PIN is tried against every approver), `scope` (object), `method` + `url` (the one request it is for), `label` (<=200), `note` (<=200)
Returns: 201, `{ approvalToken, approver: { id, name }, permission, scope, approvedFor, expiresInSeconds, expiresAt }`. Lifetime `APPROVAL_TTL_SECONDS` (default 120, 15-900). Single use. Logged as `approval_granted`.
Errors: 400 caller already holds the permission; 400 unknown / never-approvable permission; 400 `not_an_approver`; 400 `wrong_pin` `{ attemptsLeft }`; 403 `discount_limit` `{ limit, percent }`; 409 `no_approvers` (nobody able has a PIN); 423 `pin_locked`; 429 `too_many_attempts` (5 wrong PINs from this requester in 15 min, or same PIN racing) / `approval_busy` (another approval being checked for this requester).

### Users
Mounted at `/api/users` (modules/access/routes/user.routes.js), all need a session. Scoped to the caller's restaurant (400 "not linked to a restaurant" otherwise; another restaurant's user is 404). Anti-escalation rules (services/user.service.js): you may only give roles whose permissions you hold, and only change, reset, PIN, sign out, unlock or reset two-step for someone whose permissions are a subset of yours (403 otherwise); the restaurant always keeps at least one active user holding both `users.manage` and `roles.manage` (409).

User shape: `{ id, name, email, mobile, status, outletId, outletName, roleIds, roles, roleNames, roleList, employeeId, employeeName, employeeCode, hasPin, pinSetAt, pinLockedUntil, loginLockedUntil, twoFactorEnabled, twoFactorRequired, lastLoginAt, createdAt }` (lock fields only when in the future).

#### `GET /api/users`
Permission: `users.view`
Query/Body: none
Returns: all users of the restaurant (user shape).
Errors: none specific.

#### `GET /api/users/:id`
Permission: `users.view`
Query/Body: none
Returns: one user.
Errors: 404 user not found.

#### `GET /api/users/:id/sign-ins`
Permission: `users.view`
Query/Body: none
Returns: `{ user: { id, name }, items[] }`, last 100 sign-in attempts, same item shape as `GET /api/auth/me/sign-ins`.
Errors: 404 user not found.

#### `POST /api/users`
Permission: `users.manage`
Query/Body: `name` (required, <=150), `email` (valid email) and/or `mobile` (10-digit; at least one required), `password` (8-72, required), `roleIds` (id[], required, >=1), `outletId` (id), `status` (`active | inactive | locked`, default `active`)
Returns: 201, the new user. The password works for their first sign-in, when they choose their own.
Errors: 400 no email or mobile; 400 bad mobile; 400 no role / role not assignable here (Super Admin never is); 400 outlet does not exist; 403 role grants permissions you do not hold; 409 mobile already used in this restaurant / email or mobile exists.

#### `PUT /api/users/:id`
Permission: `users.manage`
Query/Body: same as create, without `password` (password has its own endpoint)
Returns: the updated user (before/after diff goes to the activity log).
Errors: 400 deactivating yourself; 400 removing your own `users.manage`; 400 role/outlet/contact errors as create; 403 target has access you lack / role beyond yours; 404; 409 would leave no admin; 409 duplicate email/mobile.

#### `PATCH /api/users/:id/password`
Permission: `users.manage`
Query/Body: `password` (8-72, required)
Returns: no `data`; message says the person was signed out everywhere (token version bumped, 30-day two-step trust ended) and chooses their own password at the next sign-in.
Errors: 400 length; 403 target stronger than you; 404.

#### `PUT /api/users/:id/pin`
Permission: `users.manage`
Query/Body: `pin` (string, 4-6 digits, required), `confirmPin` (must match when sent)
Returns: the updated user.
Errors: 400 format / weak / mobile ending / mismatch; 403; 404; 409 login not active.

#### `DELETE /api/users/:id/pin`
Permission: `users.manage`
Query/Body: none
Returns: the updated user.
Errors: 403; 404.

#### `POST /api/users/:id/sign-out`
Permission: `users.manage`
Query/Body: none
Returns: the user. Every session of theirs ends on its next request; 30-day two-step trust ends.
Errors: 403; 404.

#### `POST /api/users/:id/unlock`
Permission: `users.manage`
Query/Body: none
Returns: the updated user. Clears the account, remembered-device and PIN lockout counters.
Errors: 403; 404.

#### `POST /api/users/:id/two-factor/reset`
Permission: `users.manage`
Query/Body: none
Returns: the updated user. Two-step is switched off and they are signed out everywhere; if a role requires it they set it up at next sign-in.
Errors: 400 resetting your own (use My profile); 403; 404; 409 they do not use two-step.

### Users: access settings and activity log

#### `GET /api/users/access-settings`
Permission: `users.view`
Query/Body: none
Returns: `{ idleLockMinutes, updatedAt, twoFactorRoles: [{ id, name, code }] }`.
Errors: none specific.

#### `PUT /api/users/access-settings`
Permission: `users.manage`
Query/Body: `idleLockMinutes` (number, required, 0-240; 0 = never lock the shared till)
Returns: `{ idleLockMinutes, updatedAt, twoFactorRoles }`.
Errors: 400 out of range.

#### `PUT /api/users/two-factor-roles`
Permission: `users.manage`
Query/Body: `roleIds` (id[], required; may be empty = no role requires it)
Returns: the roles that now require two-step: `[{ id, name, code }]`. Holders must use it from their next sign-in.
Errors: 400 a role not assignable in this restaurant.

#### `GET /api/users/activity-log`
Permission: `audit.view`
Query/Body: `from`, `to` (`YYYY-MM-DD`, restaurant's calendar days in its timezone), `userId` (id), `entityType` (<=50), `action` (<=50), `sensitive` (`1`/`true`), `search` (<=100), `limit` (1-5000, default 100), `offset`
Returns: `{ items: [{ id, userId, userName, action, entityType, entityId, entityLabel, details, approvedById, approverName, sensitive, createdAt }], total, summary: { voids, refunds, cancellations, reprints, approvals, denied, ... }, limit, offset, timezone }`. Salary amounts are redacted unless the caller holds `staff.salaries`.
Errors: 400 bad date / `to` before `from`; 400 bad `userId`.

#### `GET /api/users/activity-log/facets`
Permission: `audit.view`
Query/Body: none
Returns: filter choices: `{ people: [{ id, name }], areas: [entityType], actions: [action] }`.
Errors: none specific.

#### `GET /api/users/activity-log/people`
Permission: `audit.view`
Query/Body: `q` (<=100, part of a name; `%` and `_` are plain text), `limit` (1-50, default 20)
Returns: the "Staff member" picker's choices: people who have done something in this restaurant's log, A to Z: `[{ id, name, entries, last_at }]`. With no `q`, the first `limit` of everyone.
Errors: 400 `limit` out of range.

#### `GET /api/users/activity-log/export`
Permission: `audit.view`
Query/Body: the same filters as the log (no limit/offset), `cursor` (id from the previous page's `nextCursor`)
Returns: `{ items[], total (first page only, else null), nextCursor (null on the last page), pageSize: 2000, maxRows: 200000, timezone }`. Newest first; the client pages until `nextCursor` is null and builds the CSV.
Errors: 400 `too_many_rows` `{ total, max }` (more than 200,000 matches, first page); 400 unreadable cursor; 400 date errors.

### Users: platform console
Mounted at `/api/users/platform` (modules/platform/routes/platform.routes.js, after `authenticate`). Permission `platform.restaurants.manage` (Super Admin only; no restaurant can grant it), and the caller must not belong to a restaurant (403 "The platform console is for the platform's own accounts"). Restaurant actions are written to the target restaurant's activity log under "<name> (platform)"; business actions go to that business's audit (`business_audit`). The first Super Admin login is made on the server with `npm --prefix backend run user:create`, leaving the restaurant code empty (see [README.md](../README.md)).

#### `GET /api/users/platform/restaurants`
Permission: `platform.restaurants.manage`
Query/Body: `status` (`active | inactive`), `search` (<=100, name or code), `limit` (1-200, default 50), `offset`
Returns: `{ items: [{ id, name, code, status, statusLabel, contact, email, outlets, users, activeUsers, lastActivity, createdAt }], total, limit, offset, counts }`.
Errors: 403 restaurant user.

#### `POST /api/users/platform/restaurants`
Permission: `platform.restaurants.manage`
Query/Body: `name` (required, <=150), `code` (required, 2-30 letters/digits/`_-`, stored upper case), `contact`, `email`, `address`, `timezone` (default `Asia/Kolkata`), `invoicePrefix` (default `INV`, `A-Z0-9/-`, <=10), `orderPrefix` (default `ORD`), `format` (`restaurant` default, `cafe`, `bakery`, `cloud_kitchen`), `admin: { name, email, mobile?, password (8-72) }` (required)
Returns: 201, `{ id, adminId, code, name, defaults, format }`. One transaction: GST rates, settings, delivery channels, kitchen station and the first Restaurant Admin, who chooses their own password at the first sign-in. A café, bakery or cloud kitchen then gets its format's starting setup, as `PUT /api/restaurants/current/format` gives it.
Errors: 400 validation (code, prefixes, timezone); 403 restaurant user; 409 code taken; 409 admin email taken.

#### `PUT /api/users/platform/restaurants/:id/status`
Permission: `platform.restaurants.manage`
Query/Body: `status` (`active | inactive`, required)
Returns: the restaurant after the change. Switched off, all its logins are refused (`restaurant_inactive`), open sessions on their next request.
Errors: 403; 404 restaurant not found; 409 already in that status.

#### `GET /api/users/platform/restaurants/:id/admins`
Permission: `platform.restaurants.manage`
Query/Body: none
Returns: `{ restaurant, admins: [{ id, name, email, mobile, status, lastLoginAt, locked }] }` (admins = users holding both `users.manage` and `roles.manage`).
Errors: 403; 404 restaurant not found.

#### `POST /api/users/platform/restaurants/:id/admin-password`
Permission: `platform.restaurants.manage`
Query/Body: `userId` (id, required; one of that restaurant's admins), `password` (8-72, required)
Returns: `{ id, name }`. Their sessions end, lockout lifted, 30-day two-step trust ended (two-step stays on); they choose their own password at their next sign-in.
Errors: 403; 404 restaurant not found; 404 not an admin of that restaurant.

#### `GET /api/users/platform/businesses`
Permission: `platform.restaurants.manage`
Query/Body: `q` (<=100; name, code, city or GSTIN), `type` (a business type code), `status` (`active | inactive`)
Returns: `{ items: [{ id, name, code, business_type, type_name, status, currency, timezone, created_at, gstin, city, locations, people, owners: [{ id, name, email }] }], types: [{ code, name }] }`: every business, newest first, at most 500.
Errors: 403 restaurant user.

#### `POST /api/users/platform/businesses`
Permission: `platform.restaurants.manage`
Query/Body: `businessType` (required; any type but `restaurant`, which is set up from `POST /api/users/platform/restaurants`), `name` (required, <=150), `code` (required, 2-40 letters, digits and dashes, spaces become dashes, stored upper case), `legalName`, `gstin` (validated), `stateCode` (2 digits; defaults to the GSTIN's and must match it), `addressLine1`, `addressLine2`, `city`, `postalCode` (6 digits), `phone`, `email`, `currency` (ISO code, default `INR`), `timezone` (default `Asia/Kolkata`), `locationName` (default "Main store"), `locationCode` (default `MAIN`), `owner: { email (required), name, password (8-72), mobile? }`. An email that already has an active login makes that person the owner; otherwise `name` and `password` are required and a new login is made, which chooses its own password at its first sign-in.
Returns: 201, `{ business, owner: { id, name, created } }`. One transaction: the business with its roles, settings, GST slabs, units, default modules and payment methods, its first location, and the owner's membership.
Errors: 400 validation (unknown type, a restaurant, code, GSTIN, state code, PIN code, currency, time zone); 403 restaurant user; 409 the business code is taken; 409 the owner's login is not active; 409 the mobile already has a login.

#### `PUT /api/users/platform/businesses/:id/status`
Permission: `platform.restaurants.manage`
Query/Body: `status` (`active | inactive`, required)
Returns: `{ id, name, status }`. A switched-off business drops out of its members' business lists, and its routes answer 404.
Errors: 403; 404 business not found.

#### `POST /api/users/platform/businesses/:id/owner-password`
Permission: `platform.restaurants.manage`
Query/Body: `userId` (id, required; one of that business's owners), `password` (8-72, required)
Returns: `{ id, name }`. Their sessions end on their next request, their sign-in lockout is lifted, and they choose their own password at their next sign-in.
Errors: 403; 404 "That person is not an owner of this business".

### Roles and permissions
Mounted at `/api/roles` (routes/role.routes.js), all need a session. Lists show the restaurant's own roles plus shared built-in (system) roles. Built-in roles cannot be edited or deleted; copy them. You can only add permissions you hold yourself, and only remove permissions from (or switch off, or delete) a role whose permissions and holders are no stronger than you. The restaurant must keep an active user with `users.manage` + `roles.manage` (409). Role shape: `{ id, code, name, description, isSystem, status, permissions[], userCount }`.

#### `GET /api/roles/permissions`
Permission: `roles.view`
Query/Body: none
Returns: `[{ id, code, module, name, enforced }]`; `enforced` = some route actually checks it. `platform.*` permissions are hidden from restaurant users.
Errors: none specific.

#### `GET /api/roles`
Permission: `roles.view`
Query/Body: none
Returns: role list (role shape).
Errors: none specific.

#### `GET /api/roles/:id`
Permission: `roles.view`
Query/Body: none
Returns: one role.
Errors: 404 role not found.

#### `POST /api/roles`
Permission: `roles.manage`
Query/Body: `code` (required, <=50; upper-cased, spaces to `_`; fixed after creation), `name` (required, <=100), `description` (<=500), `permissions` (string[], required, >=1, known codes)
Returns: 201, the role.
Errors: 400 no / unknown permission; 400 `platform.restaurants.manage`; 403 permission you do not hold; 409 code exists.

#### `POST /api/roles/:id/copy`
Permission: `roles.manage` (`moveUsers` also needs `users.manage`)
Query/Body: `name` (default "<source> (copy)"), `code` (default derived from the name, numbered if taken), `description`, `moveUsers` (boolean; moves this restaurant's holders of the source onto the copy)
Returns: 201, the new role plus `movedUsers` (count).
Errors: 400 copying `SUPER_ADMIN`; 403 permissions you do not hold; 403 `moveUsers` without `users.manage`; 404 source not found; 409 code exists (when given) / no free code.

#### `PUT /api/roles/:id`
Permission: `roles.manage`
Query/Body: `name` (required), `description`, `status` (`active | inactive`, default `active`), `permissions` (string[], required, >=1). Code is not changeable.
Returns: the updated role (added/removed permissions go to the activity log).
Errors: 400 no / unknown / platform permission; 403 built-in role; 403 adding a permission you lack; 403 removing from a role or holders stronger than you; 404; 409 would leave no admin.

#### `DELETE /api/roles/:id`
Permission: `roles.manage`
Query/Body: none
Returns: no `data` ("Role deleted").
Errors: 403 system role; 403 role or holders stronger than you; 404; 409 role still assigned to users.

### Restaurant settings
Mounted at `/api/restaurants` (routes/restaurant.routes.js), all need a session. The restaurant is always the caller's (`req.user.restaurantId`), never from the URL; a login with no restaurant gets 400 "This account is not linked to a restaurant". (Payment-type routes on the same router are documented with billing.)

#### `GET /api/restaurants/current`
Permission: `restaurant.settings.view`
Query/Body: none
Returns: `{ id, name, code, contact, email, address, status, created_at, updated_at }` (raw column names).
Errors: 404 restaurant not found.

#### `PUT /api/restaurants/current`
Permission: `restaurant.settings.manage`
Query/Body: `name` (required, <=150), `contact` (<=20), `email` (valid email), `address` (<=500). The code is not editable. A new name renames the restaurant's business too (when it is linked), in the same statement (database trigger `restaurants_business_name`), logged `business.renamed` (`from`, `to`) in the business's activity log.
Returns: the updated restaurant row.
Errors: 400 validation; 404.

#### `GET /api/restaurants/current/settings`
Permission: login only (any signed-in user; tills, bills and reports need it)
Query/Body: none
Returns: `{ currencyCode, currencySymbol, timezone, taxMode, defaultTaxPercentage, serviceChargePercentage, serviceChargeOrderTypes, orderPrefix, invoicePrefix, gstNumber, fssaiNumber, gstSplit, billFooter, autoConsumeStock, loyaltyEnabled, loyaltyEarnAmount, loyaltyPointValue, loyaltyMinRedeem, printPaperWidth, printCopies, autoPrintBill, billHeader, printShowQr, receiptLogoPath, documentType, compositionPercentage, compositionNote, upiVpa, upiPayeeName, invoiceNumbering, rules }`. `loyaltyEnabled` is the Loyalty points feature (read-only here; see [Restaurant features](#restaurant-features)). `rules` are the restaurant's alerts and timings (Settings → Alerts and timings), each its default until changed: theft control `alertLargeDiscountPercent` (20), `alertLargeDiscountAmount` (1000), `alertHugeDiscountPercent` (50), `alertReprintCount` (3), `alertCashShortCritical` (1000); deliveries `deliverySlaMinutes` (45), `deliveryWarnMinutes` (30), `deliveryReadyWaitMinutes` (10), `deliveryOutWarnMinutes` (45), `deliveryOutCriticalMinutes` (60); reservations `reservationLateMinutes` (15), `reservationLastSeatingMinutes` (30), `reservationSlotMinutes` (30, the step between the online booking link's times); time clock `timeclockLateMinutes` (15), `timeclockLongBreakMinutes` (45), `timeclockOvertimeMinutes` (15), `timeclockEarlyMinutes` (60); guests `guestRegularVisits` (3), `guestRegularDays` (60), `guestLapsedDays` (45), `guestNewDays` (30), `guestBigSpenderPercent` (10); reorder plan `reorderLookbackDays` (14), `reorderSafetyDays` (2), `reorderHorizonDays` (7); and `cashDenominations` (the notes a cash count lists, largest first; default 500, 200, 100, 50, 20, 10; coins are always counted besides). The bell, the reports and the screens read them from one place (`ruleSettings.service.js`, which also holds each rule's range).
Errors: none specific.

#### `PUT /api/restaurants/current/settings`
Permission: `restaurant.settings.manage`
Query/Body: required: `currencyCode` (<=3), `currencySymbol` (<=5), `timezone` (IANA place name the DB knows), `taxMode` (`inclusive | exclusive`), `defaultTaxPercentage` (0-100), `serviceChargePercentage` (0-100), `orderPrefix` (<=10), `invoicePrefix` (<=10, `A-Z0-9` then `A-Z0-9/-`). Optional: `serviceChargeOrderTypes` (subset of `dine_in, takeaway, delivery, qr, online`; omitted keeps current), `gstNumber`, `fssaiNumber`, `gstSplit`, `billFooter`, `autoConsumeStock`, loyalty rules (`loyaltyEarnAmount`, `loyaltyPointValue`, `loyaltyMinRedeem`; `loyaltyEnabled`, when sent and different, switches the Loyalty points feature under its rules: owner only, Guests on, logged; the Settings screen does not send it), `printPaperWidth` (`58mm | 80mm | a4`), `printCopies` (1-5), `autoPrintBill`, `billHeader`, `printShowQr`, `receiptLogoPath`, `documentType` (`auto | tax_invoice | bill_of_supply`), `compositionPercentage`, `compositionNote`, `upiVpa` (`name@bank`), `upiPayeeName`, `invoiceNumbering` (`continuous | financial_year`); the last three keep their value when omitted. `rules` (object, optional): only the rules sent change, each checked against its range (whole numbers for minutes, days and counts; `reservationSlotMinutes` one of 10, 15, 20, 30, 45, 60; `cashDenominations` 1-15 notes of whole rupees up to 100000); names it does not know are ignored. See controllers/restaurant.controller.js.
Returns: the settings, same shape as GET.
Errors: 400 validation; 400 invalid invoice prefix; 400 bad UPI ID; 400 timezone is an offset (`UTC+05:30`), an `Etc/` zone, or unknown (with "Did you mean ...?"); 400 `financial_year` numbering with a main or outlet prefix longer than 4 characters; 400 a rule out of its range; 400 rules that do not fit together (the warning discount below the large-discount line, the delivery amber mark not before the promise, an out-for-delivery critical mark not after its warning). The rules are checked, with the saved ones filling in what was not sent, before anything is written.

### Restaurant features

Settings → Features: the parts of the restaurant switched on or off. The
switches are `business_capabilities` rows of the restaurant's business (see
DATABASE.md, *Restaurant features*); the Business Admin's
`PUT /api/businesses/:id/modules/:code` for a restaurant business goes through
the same rules.

#### `GET /api/restaurants/current/features`
Permission: `restaurant.settings.view`
Query/Body: none
Returns: `{ canChange, features: [{ code, name, description, group, enabledByDefault, requires[], requiredBy[], enabled }] }` in screen order; `canChange` is true for a holder of `restaurant.settings.manage` (the owner). The signed-in profile (`GET /api/auth/me`) carries `features`: the codes switched on.
Errors: 400 no restaurant.

#### `POST /api/restaurants/current/features/:code/preview`
Permission: `restaurant.settings.manage`
Query/Body: `enabled` (boolean, required)
Returns: `{ code, enabled, changed, hides[], blockers[], warnings[] }`: sentences (when nothing would change, `{ code, enabled, changed: false, blockers: [], warnings: [] }`). `hides` names the screens and reports that go with a feature being switched off; `blockers` is what refuses the switch (a dependency; money that would be stranded); `warnings` is what it will hide or stop (the records are kept). Nothing changes.
Errors: 400 `enabled` missing; 404 unknown feature.

#### `PUT /api/restaurants/current/features/:code`
Permission: `restaurant.settings.manage` (checked again by the service)
Query/Body: `enabled` (boolean, required)
Returns: `{ code, enabled, changed, warnings[], features[] }` (`features` as GET). The change and an activity-log row (`feature.enabled` / `feature.disabled`, entity `restaurant_feature`, label = the feature's name, `details.via` = `settings`, `business_admin` or `format:<code>` when a format change switched it) and a `business_audit` row (`module.enabled` / `module.disabled`) are written in one transaction holding the restaurant's business row. The first switch of a restaurant with no business yet links it (`restaurant_business_id`); nobody becomes a member.
Errors: 400 `enabled` missing; 403 not the owner; 404 unknown feature; 409 `{ reason: "feature_blocked", feature, blockers[], warnings[] }`: a dependency (`Loyalty points needs Guests & CRM. Switch that on first.`, or a feature that needs this one is on), or money that would be stranded (an advance still holding money; a delivery out with a rider, rider cash not settled or a rider shortfall owed; an open cash drawer; money owed to suppliers).

#### `GET /api/restaurants/current/format`
Permission: `restaurant.settings.view`
Query/Body: none
Returns: `{ code, label, summary, formats: [{ code, label, summary }] }`: the restaurant's format (`restaurant`, `cafe`, `bakery` or `cloud_kitchen`) and the four to choose from. All four run on the same POS, menu, kitchen and day close; the format is what the place is called, how the POS opens and which features it starts with.
Errors: 404 restaurant not found (also a login with no restaurant).

#### `PUT /api/restaurants/current/format`
Permission: `restaurant.settings.manage` (the owner; checked again by the service)
Query/Body: `format` (required: `restaurant`, `cafe`, `bakery` or `cloud_kitchen`)
Returns: `{ code, label, summary, skipped: [{ feature, enabled, reason }], formats[] }`. The format sets, once, the POS's kinds of order and the one a new order starts on (restaurant: all three, dine-in first; café: all three, takeaway first; bakery: takeaway and delivery, takeaway first; cloud kitchen: delivery and takeaway, delivery first), token numbers (switched on for a café's takeaways and for a cloud kitchen's deliveries, online orders and takeaways; otherwise left as they are), and the format's features, each switched under the Features rules (café: Guests and Pre-orders on, Captain sections and Reservations off; bakery: also Advances and Stock & recipes on, QR ordering, Kitchen display and Tips off; cloud kitchen: Guests, Deliveries, Online ordering and Brands on, Captain sections, Reservations, QR ordering and Tips off). A feature its rules refuse (one still holding money, say) is left as it is and listed in `skipped`; the message counts them. The owner can change any of these afterwards, one by one.
Errors: 400 unknown format; 403 "Only the owner can change the restaurant's format".

#### `GET /api/restaurants/current/invoice-series`
Permission: `restaurant.settings.view`
Query/Body: none
Returns: one row for the main counter then one per outlet: `[{ outletId, name, code, status, ownPrefix, series, hasOwnGstin, numbering, financialYear, derived, example, fits, lastNumber, sharedWith[] }]` (`fits`/`lastNumber` against GST's 16-character limit; `sharedWith` = active series printing the same numbers).
Errors: none specific.

#### `GET /api/restaurants/current/timezones`
Permission: `restaurant.settings.view`
Query/Body: none
Returns: `[{ name, offset, label }]`, `UTC` first, e.g. `{ name: "Asia/Kolkata", offset: "+05:30", label: "(UTC+05:30) Asia/Kolkata" }`.
Errors: none specific.

#### `GET /api/restaurants/current/discount-limits`
Permission: `restaurant.settings.view`
Query/Body: none
Returns: `{ roles: [{ id, code, name, custom, maxPercent, people }] }`: every active role holding `bills.discount`; `maxPercent` null = no cap; `people` = active holders.
Errors: none specific.

#### `PUT /api/restaurants/current/discount-limits`
Permission: `restaurant.settings.manage`
Query/Body: `limits` (array, required) of `{ roleId (id, required), maxPercent (0-100, or null / "" to remove the cap) }`
Returns: `{ roles[] }` as GET. Caps also limit which managers may approve a discount.
Errors: 400 a role that does not hold `bills.discount`; 400 out-of-range percent.

#### `GET /api/restaurants/current/business-hours`
Permission: `restaurant.settings.view`
Query/Body: none
Returns: always seven days: `[{ dayOfWeek (0-6), isOpen, openTime, closeTime, periods: [{ openTime, closeTime }] }]`; days never saved default to open 10:00-23:00.
Errors: none specific.

#### `PUT /api/restaurants/current/business-hours`
Permission: `restaurant.settings.manage`
Query/Body: `days` (array of exactly 7): `{ dayOfWeek (0-6), isOpen (boolean), periods: [{ openTime, closeTime }] (1-3, `HH:MM` 24-hour) }`; `openTime`/`closeTime` on the day are accepted instead of `periods`.
Returns: the saved seven days.
Errors: 400 not seven days; 400 more than three periods; 400 time format.

### Notifications
Mounted at `/api/notifications` (routes/notification.routes.js), session only, no permission: each alert provider is filtered by the permission of the module it comes from, and read marks are per person. Alert ids look like `stock:out:12`. A login with no restaurant gets an empty bell on GET and 400 on the writes.

#### `GET /api/notifications`
Permission: login only
Query/Body: none
Returns: `{ items: [{ id, source, severity (critical | warning | info), title, detail, link, category, at, read }], unreadCount, counts, unreadCounts, sources: [{ key, label, status (ok | failed | timeout | invalid), count }], generatedAt }`; sorted worst first, then newest.
Errors: none specific.

#### `POST /api/notifications/read`
Permission: login only
Query/Body: `ids` (string[], required, 1-500)
Returns: `{ ids (marked), skipped (alerts that have cleared), read: true }`.
Errors: 400 empty / too many / malformed id; 400 none of the ids are in your notifications.

#### `POST /api/notifications/unread`
Permission: login only
Query/Body: `ids` (string[], required, 1-500)
Returns: `{ ids, read: false }`.
Errors: 400 empty / too many / malformed id.

#### `POST /api/notifications/read-all`
Permission: login only
Query/Body: `ids` (string[], optional, up to 2000; the alerts the screen showed, so newer ones stay unread). Omitted marks everything live now.
Returns: the full list as `GET` plus `marked` (count).
Errors: 400 malformed ids.

### Availability (sold out)
Mounted at `/api/availability` (routes/availability.routes.js): session, then outlet resolution (`X-Outlet-Id`). A mark lasts for the open business day of that outlet only and ends by itself when the next day opens. Separate from menu editing, so captains and cooks can use it.

#### `GET /api/availability`
Permission: any of `orders.view`, `kds.view`, `menu.view`, `menu.availability`
Query/Body: none (outlet from `X-Outlet-Id`)
Returns: `{ businessDay: { id, businessDate } | null, items: [{ id, productId, productVariantId, productName, productCode, variantName, label, categoryName, note, soldOutAt, markedByName }], switchedOff: [{ productId, productName, productCode, categoryName }] (off on the menu itself), backOnToday: [{ id, productId, productVariantId, label, soldOutAt, backOnAt, markedByName, backOnByName }] (up to 20) }`.
Errors: 403 none of the four permissions.

#### `GET /api/availability/dishes`
Permission: `menu.availability`
Query/Body: none
Returns: dishes to mark: `[{ id, name, code, foodType, isAvailable, categoryName, variants: [{ id, name, status }] }]`.
Errors: none specific.

#### `PATCH /api/availability`
Permission: `menu.availability`
Query/Body: `productId` (id, required), `productVariantId` (id; one size only), `soldOut` (boolean, required), `note` (<=120)
Returns: `{ changed, businessDay, items, switchedOff, backOnToday }` (the refreshed list); the message says whether anything changed. Only real changes are logged.
Errors: 400 `soldOut` not boolean; 400 size not of that dish; 404 dish not on this restaurant's menu; 409 no business day open.

---

## Menu

### Categories
Mounted at `/api/menu`; every route needs login, and data is scoped to the caller's restaurant (400 "This account is not linked to a restaurant" when the user has none). Edits are written to the activity log with before/after values.

#### `GET /api/menu/categories`
Permission: `menu.view`
Query/Body: none
Returns: `data` = array of `{ id, name, description, sortOrder, status, productCount, brandId, brandName }`. `brandId` null: every brand's category.

#### `POST /api/menu/categories`
Permission: `menu.manage`
Query/Body: `name` (string, required, <=100), `description` (string, <=500), `sortOrder` (0-9999, default 0), `status` (`active` | `inactive`, default `active`), `brandId` (the brand whose menu it is; null, 0 or empty = every brand's)
Returns: `data` = the category; status 201.
Errors: 403 `feature_off` a brand while the brands feature is off; 404 brand not found; 409 a category with that name already exists.

#### `PUT /api/menu/categories/:id`
Permission: `menu.manage`
Query/Body: same fields as create, all optional; a field left out keeps its value.
Returns: `data` = the updated category.
Errors: 400 nothing to change (no field sent); 403 `feature_off` giving the category a different brand while the brands feature is off (sending the brand it already has is fine); 404 category or brand not found; 409 duplicate name.

#### `DELETE /api/menu/categories/:id`
Permission: `menu.manage`
Query/Body: none
Returns: no `data` (message "Category deleted").
Errors: 404 not found; 409 the category still has products (move/delete them or set it inactive).

### Brands
One kitchen selling under several names (the `brands` feature, checked before the permission: off answers 403 `feature_off`). A brand has its own menu categories (`brandId` on a category; a category with no brand is every brand's, such as drinks), an order is taken under a brand (`brandId` on `POST /api/orders`), and the brand prints on the order's KOTs and bill (`brandName`). The kitchen, stock, staff, GST and business day stay one. Switched off, a new order or category under a brand is refused (403 `feature_off`); an order taken under a brand before keeps it, and dishes can still be added to it without the menu rule. A brand is `{ id, name, tagline, color, sortOrder, status, categoryCount, productCount }` (the counts on the list only).

#### `GET /api/menu/brands`
Permission: `orders.view`
Query/Body: none
Returns: `data` = array of brands, switched-on ones first, then by display order and name, each with its number of categories and active dishes.

#### `POST /api/menu/brands`
Permission: `menu.manage`
Query/Body: `name` (required, <=80), `tagline` (<=150), `color` (`#rrggbb`), `sortOrder` (0-9999, default 0), `status` (`active` | `inactive`, default `active`)
Returns: `data` = the brand; status 201.
Errors: 400 a colour not like `#1f8a70`; 409 a brand with that name already exists.

#### `PUT /api/menu/brands/:id`
Permission: `menu.manage`
Query/Body: same as create (full body). A switched-off brand takes no new orders; dishes can still be added to its orders already open.
Returns: `data` = the brand.
Errors: as create; 404 brand not found.

#### `GET /api/menu/brands/report`
Permission: `reports.view`
Query/Body: `from`, `to` (required, `YYYY-MM-DD`, business dates)
Returns: `data` = `{ from, to, brands[{ brandId, name, color, bills, sales, commission, net, averageBill, channels[{ channel, bills, sales, commission, net }] }], totals{ bills, sales, commission, net } }`: each brand's bills (voids left out) by sales channel, with the aggregator's commission at each order's own rate and what is left. Orders under no brand make one row, "No brand (kitchen name)", with `brandId: null`. Highest sales first; not narrowed by outlet.
Errors: 400 a date missing or not `YYYY-MM-DD`; 400 the end date before the start date.

### Products
Dishes of the restaurant. Fixed paths (`export`, `import-guide`, `import`, `price-revision`) are matched before `/products/:id`. A product object (`toProduct` in `modules/restaurant/menu/services/menu.service.js`) is `{ id, categoryId, categoryName, name, kitchenName, soldBy, code, description, price, taxPercentage, taxRateId, taxRateName, taxMode, mrp, hsnCode, isCombo, addonGroups[], availabilitySchedule[], comboChoiceGroups[], imagePath, offerPrice, offerName, foodType, isAvailable, sortOrder, status }` (lists also carry `unavailableParts[]` and `soldOutParts[]` for combos).

#### `GET /api/menu/products`
Permission: `menu.view`
Query/Body: `categoryId` (int), `search` (<=100), `status` (`active` | `inactive`), `withOffers` (`true` fills `offerPrice`/`offerName` with the happy-hour price running now)
Returns: `data` = array of products.

#### `GET /api/menu/products/:id`
Permission: `menu.view`
Query/Body: none
Returns: `data` = one product.
Errors: 404 product not found.

#### `POST /api/menu/products`
Permission: `menu.manage`
Query/Body: `categoryId` (required), `name` (required, <=150), `price` (required, 0-9999999), `code` (<=30), `description` (<=500), `taxRateId` (int or `null` = No tax), `taxPercentage` (0-100; a bare rate, used only when no `taxRateId` is sent), `taxMode` (`default` | `inclusive` | `exclusive`), `mrp`, `foodType` (`veg` | `non_veg` | `egg`, default `veg`), `isAvailable` (default true), `sortOrder`, `status`, `kitchenName` (<=150), `soldBy` (`unit` default | `weight`: the price is per kg and an order line's quantity is its weight in kg, 0.25 = 250 g)
Returns: `data` = the product; status 201. With no tax field sent the restaurant's default tax rate is applied.
Errors: 400 category does not exist; 400 tax rate missing or switched off; 400 no tax given and no default rate set; 409 name or code already exists.

#### `PUT /api/menu/products/:id`
Permission: `menu.manage`
Query/Body: same as create; `categoryId`, `name` and `price` are still required, other fields left out keep their value (`null` clears code/description or means No tax).
Returns: `data` = the updated product.
Errors: 400 as create; 400 the new price would make an active size cost below zero; 404 not found; 409 duplicate name/code.

#### `PATCH /api/menu/products/:id`
Permission: `menu.manage`
Query/Body: `changes` (object, required: only the fields edited, from `categoryId, name, code, description, price, taxRateId, taxMode, mrp, foodType, isAvailable, sortOrder, status, kitchenName, soldBy`), `original` (object: what each changed field said when the form opened)
Returns: `data` = the updated product.
Errors: 400 `changes` missing/empty or names an unknown field; 400 size would go below zero; 404 not found; 409 `{ reason: "changed_meanwhile", fields[], current }` when someone else changed the same field since the form opened.

#### `PATCH /api/menu/products/:id/availability`
Permission: `menu.availability`
Query/Body: `isAvailable` (boolean, default true)
Returns: `data` = the product plus `combos[]` (`{ id, name, isAvailable, status }`) that contain it. Message "Back on sale" / "Marked sold out".
Errors: 404 product not found.

#### `PATCH /api/menu/products/:id/status`
Permission: `menu.manage`
Query/Body: `status` (`active` | `inactive`, required). `inactive` archives the dish (off POS and QR menu, history kept).
Returns: `data` = the product.
Errors: 404 product not found.

#### `GET /api/menu/products/:id/usage`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ productId, canDelete, message, reason, canArchive }`; `reason` is `null`, `in_combo` (with `combos[]`), `has_sales` (with `timesSold`) or `in_tax_change` (a GST rate change names it: its GST history keeps it).
Errors: 404 product not found.

#### `GET /api/menu/products/:id/history`
Permission: `audit.view`
Query/Body: none
Returns: `data` = `{ productId, productName, items[] }`, each item `{ id, action, entityType, entityLabel, userName, approverName, details, createdAt }`, newest first (dish and its sizes).
Errors: 404 product not found.

#### `DELETE /api/menu/products/:id`
Permission: `menu.manage`
Query/Body: none
Returns: no `data` (message "Product deleted").
Errors: 404 not found; 409 `{ reason: "in_combo", combos[] }` part of a combo; 409 `{ reason: "has_sales", timesSold, canArchive: true }` already sold (archive instead); 409 `{ reason: "in_tax_change", canArchive: true }` named in a GST rate change (archive instead); 409 `{ reason: "in_use", canArchive: true }` referenced elsewhere.

### Product images
Multipart upload held in memory, bytes sniffed before saving under `products/` in the public upload folder (`UPLOADS_DIR`, `backend/uploads` when it is not set); one image per dish (the old file is deleted).

#### `POST /api/menu/products/:id/image`
Permission: `menu.manage`
Query/Body: multipart field `image` (one file, JPG/PNG/WEBP, <=2 MB)
Returns: `data` = the product with the new `imagePath`.
Errors: 400 no file; 400 wrong type or bytes not a real JPG/PNG/WEBP; 400 "That image is larger than 2 MB" / other multer refusal; 404 product not found.

#### `DELETE /api/menu/products/:id/image`
Permission: `menu.manage`
Query/Body: none
Returns: `data` = the product with `imagePath: null`.
Errors: 404 product not found.

### Menu import, export and price revision
The browser parses the spreadsheet and posts JSON rows; the server previews with `dryRun: true` and returns a `fingerprint` that the real import/apply sends back.

#### `GET /api/menu/products/export`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ columns, rows[] }`, one row per dish (`category, name, code, description, price, taxRate, foodType, isAvailable, sortOrder, status, sizes, addOns, kitchenName, sizeKitchenNames, addOnKitchenNames`); importing it back changes nothing.

#### `GET /api/menu/products/import-guide`
Permission: `menu.manage`
Query/Body: none
Returns: `data` = `{ columns[] ({ key, label, need, help, example }), sample: { columns, rows }, maxRows: 2000 }`.

#### `POST /api/menu/products/import`
Permission: `menu.manage`
Query/Body: `rows` (array of heading->cell objects, required, 1-2000), `dryRun` (boolean), `fingerprint` (string from the preview), `confirmFlagged` (boolean, required true when the preview flagged risky rows), `fileName` (<=200)
Returns: `data` = `{ ok, created, updated, unchanged, flagged, columns, newCategories[], newAddOns[], addOnPriceChanges[], problems[], rows[], fingerprint, dryRun }`. A dry run with problems answers 200 with `success: false`.
Errors: 400 no rows / more than 2000; 400 file has problems (real import, `data` = the summary); 400 `{ reason: "confirm_flagged", flagged[] }`; 409 `{ reason: "stale_preview" }` menu changed since the preview; 409 dish clashes with an existing name/code. See `services/menuImport.service.js`.

#### `POST /api/menu/products/price-revision`
Permission: `menu.manage`
Query/Body: `mode` (`percent` | `amount`, required), `value` (required, non-zero; percent -90..300, amount -100000..100000), `categoryIds` (int[], empty = all), `roundTo` (0, 1, 5, 10), `direction` (`nearest` | `up` | `down`), `includeSizes` (default true), `dryRun` (boolean), `fingerprint` (from the preview)
Returns: `data` = `{ ok, dryRun, rule, changed, unchanged, dishes[] ({ productId, name, categoryName, from, to, sizes[], skippedSizes }), problems[], fingerprint }`. A dry run with problems answers 200 with `success: false`.
Errors: 400 value 0; 400 a chosen category does not exist / no dishes in them; 400 problems (price below zero) on apply; 400 nothing would change; 409 `{ reason: "stale_preview" }`.

### Variants (sizes)
A size is stored as a difference from the dish price.

#### `GET /api/menu/products/:productId/variants`
Permission: `menu.view`
Query/Body: none
Returns: `data` = array of `{ id, productId, name, priceDelta, isDefault, sortOrder, status, kitchenName, timesSold, combos }`.
Errors: 404 product not found.

#### `POST /api/menu/products/:productId/variants`
Permission: `menu.manage`
Query/Body: `name` (required, <=100), either `price` (what the guest pays) or `priceDelta` (difference, default 0) but not both, `isDefault`, `sortOrder`, `status`, `kitchenName` (<=100)
Returns: `data` = the variant; status 201.
Errors: 400 both price and priceDelta sent; 400 resulting price below zero; 404 product not found; 409 product already has a size with that name.

#### `PUT /api/menu/variants/:id`
Permission: `menu.manage`
Query/Body: same fields as create, all optional (left out = unchanged).
Returns: `data` = the updated variant.
Errors: 400 nothing to change / price below zero; 404 variant not found; 409 duplicate name.

#### `DELETE /api/menu/variants/:id`
Permission: `menu.manage`
Query/Body: none
Returns: no `data` (message "Variant deleted").
Errors: 404 not found; 409 used in a combo; 409 already sold (switch it off instead); 409 `{ reason: "in_use", canArchive: true }`.

### Modifiers (add-ons) and add-on recipes

#### `GET /api/menu/modifiers`
Permission: `menu.view`
Query/Body: none
Returns: `data` = array of `{ id, name, price, status, kitchenName, productCount, timesSold }`.

#### `POST /api/menu/modifiers`
Permission: `menu.manage`
Query/Body: `name` (required, <=100), `price` (0-9999999, default 0), `status`, `kitchenName` (<=100)
Returns: `data` = the modifier; status 201.
Errors: 409 a modifier with that name already exists.

#### `PUT /api/menu/modifiers/:id`
Permission: `menu.manage`
Query/Body: same fields, all optional.
Returns: `data` = the updated modifier.
Errors: 400 nothing to change; 404 not found; 409 duplicate name.

#### `DELETE /api/menu/modifiers/:id`
Permission: `menu.manage`
Query/Body: none
Returns: no `data` (message "Modifier deleted").
Errors: 404 not found; 409 already sold (switch it off); 409 `{ reason: "in_use", canArchive: true }`.

#### `GET /api/menu/modifiers/:id/recipe`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ modifier: { id, name }, lines[] ({ id, inventoryItemId, itemName, quantity, unitShortName, lineCost }) }`.
Errors: 404 add-on not found.

#### `PUT /api/menu/modifiers/:id/recipe`
Permission: `menu.manage`
Query/Body: `lines` (array, required, <=100, each `{ inventoryItemId, quantity }` with quantity 0.0001-9999999, each item once). Replaces the whole recipe.
Returns: `data` = the recipe as GET.
Errors: 400 duplicate ingredient / ingredient not this restaurant's; 404 add-on not found.

#### `GET /api/menu/products/:productId/modifiers`
Permission: `menu.view`
Query/Body: none
Returns: `data` = array of modifier ids linked to the dish.
Errors: 404 product not found.

#### `PUT /api/menu/products/:productId/modifiers`
Permission: `menu.manage`
Query/Body: `modifierIds` (int[], required; replaces the full list)
Returns: `data` = the ids now linked.
Errors: 400 a modifier does not exist; 404 product not found.

### Add-on groups
Min/max choice rules over the add-ons linked to a dish, stored on the product as `addon_groups`.

#### `GET /api/menu/products/:productId/addon-groups`
Permission: `menu.view`
Query/Body: none
Returns: `data` = array of `{ name, min, max, modifierIds[] }`.
Errors: 404 product not found.

#### `PUT /api/menu/products/:productId/addon-groups`
Permission: `menu.manage`
Query/Body: `groups` (array, required, <=20; each `{ name (<=80, unique), min (0-100), max (1-100), modifierIds[] (<=100) }`, whole numbers with min <= max <= choices; an add-on in one group only)
Returns: `data` = the saved groups.
Errors: 400 any rule above broken; 400 a choice is not an active add-on linked to this dish; 404 product not found.

### Service options (serving times and combo choices)

#### `GET /api/menu/products/:productId/service-options`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ schedule[] ({ days[], opensAt, closesAt }), groups[] (combo choice groups) }`.
Errors: 404 product not found.

#### `PUT /api/menu/products/:productId/service-options`
Permission: `menu.manage`
Query/Body: `schedule` (array, <=21; each `{ days[] (0-6, at least one), opensAt, closesAt }` as `HH:MM`, different; overnight allowed; empty = always), `groups` (array, <=10; each `{ name (<=60, unique), choose (1-10), options[] (<=30, each { productId, productVariantId?, quantity (0.01-100, default 1), extraPrice (0-99999, default 0) }) }`). Non-empty groups mark the dish a combo.
Returns: `data` = `{ schedule, groups }` (each group gets a generated `id`).
Errors: 400 bad time/weekday; 400 option is the dish itself, repeated, inactive, another combo or a size not of that dish; 400 this dish is already part of another combo; 404 product not found.

### Combos (fixed parts)

#### `GET /api/menu/products/:productId/combo`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ productId, productName, price, isCombo, isAvailable, items[], partsTotal, saving, unavailableParts[] }`.
Errors: 404 product not found.

#### `PUT /api/menu/products/:productId/combo`
Permission: `menu.manage`
Query/Body: `items` (array, required; each `{ productId, productVariantId?, quantity (0.01-999) }`; replaces all parts, empty clears)
Returns: `data` = the combo as GET.
Errors: 400 combo contains itself; 400 dish missing, itself a combo, listed twice, or size not of that dish; 400 this dish is a part of another combo; 404 product not found.

#### `DELETE /api/menu/products/:productId/combo`
Permission: `menu.manage`
Query/Body: none (same as PUT with no items; the dish becomes ordinary)
Returns: `data` = the combo (now empty).
Errors: 404 product not found.

### Price windows (happy hour)
Timed prices per dish or size; optionally limited to one outlet.

#### `GET /api/menu/price-windows`
Permission: `menu.view`
Query/Body: `status` (`active` | `inactive`)
Returns: `data` = array of `{ id, outletId, outletName, name, daysOfWeek[], startTime, endTime, validFrom, validTo, priority, status, itemCount }`.

#### `POST /api/menu/price-windows`
Permission: `menu.manage`
Query/Body: `name` (required, <=80), `daysOfWeek` (int[] 0-6, at least one), `startTime`, `endTime` (`HH:MM`, required, different), `validFrom`, `validTo` (`YYYY-MM-DD`), `priority` (0-999), `status`, `outletId`
Returns: `data` = the window; status 201.
Errors: 400 bad time/date or start = end; 400 outlet does not exist; 409 name already exists.

#### `GET /api/menu/price-windows/:id`
Permission: `menu.view`
Query/Body: none
Returns: `data` = the window with `items[]` (`{ id, productId, productName, productVariantId, variantName, price, normalPrice, basePrice }`).
Errors: 404 price window not found.

#### `PUT /api/menu/price-windows/:id`
Permission: `menu.manage`
Query/Body: same as create (full body).
Returns: `data` = the window.
Errors: as create; 404 not found.

#### `PUT /api/menu/price-windows/:id/items`
Permission: `menu.manage`
Query/Body: `items` (array, required; each `{ productId, productVariantId?, price (0-9999999) }`; replaces the list)
Returns: `data` = the window with its items.
Errors: 400 dish missing, size not of that dish, or dish listed twice; 404 window not found.

#### `DELETE /api/menu/price-windows/:id`
Permission: `menu.manage`
Query/Body: none
Returns: no `data`.
Errors: 404 not found; 409 orders were priced by this window (switch it off instead).

### Tax rates
Named GST rates carrying the HSN/SAC code.

#### `GET /api/menu/tax-rates`
Permission: `menu.view`
Query/Body: `status` (`active` | `inactive`)
Returns: `data` = array of `{ id, name, percentage, hsnCode, cessPercentage, isDefault, status, productCount }`.

#### `POST /api/menu/tax-rates`
Permission: `menu.manage`
Query/Body: `name` (required, <=80), `percentage` (0-100, required), `hsnCode` (<=10), `cessPercentage` (0-100), `isDefault` (boolean), `status`
Returns: `data` = the rate; status 201.
Errors: 400 default rate switched off; 409 name already exists.

#### `PUT /api/menu/tax-rates/:id`
Permission: `menu.manage`
Query/Body: same as create (full body) plus `moveProductsTo` (rate id: move every dish on this rate there first, used when switching it off). A changed percentage reprices its dishes.
Returns: `data` = the rate plus `movedProducts`, `repricedProducts`.
Errors: 400 target rate is the same, missing or off; 400 switching off the default rate; 404 not found; 409 dishes still use the rate being switched off (send `moveProductsTo`); 409 a scheduled GST rate change moves dishes to the rate being switched off (keep it on, or cancel that change first); 409 duplicate name.

#### `DELETE /api/menu/tax-rates/:id`
Permission: `menu.manage`
Query/Body: none
Returns: no `data`.
Errors: 404 not found; 409 dishes use this rate / rate still in use.

### GST rate changes on the menu
A GST rate change moves chosen dishes to another of the restaurant's tax rates from a later date on the restaurant's own clock: its trading date, the main counter's open business day, else today less the morning cut-off. A bill keeps the rate it was made at. How it works: [BUSINESS_RULES.md › GST rates by date at a restaurant](BUSINESS_RULES.md#gst-rates-by-date-at-a-restaurant). The module, `modules/tax-changes/`, also serves Business Admin's [GST rate changes](#gst-rate-changes); a restaurant's changes are kept against its own business row.

Every `/api/menu` request first applies the changes due on the trading date, so the menu screens and the POS read each dish at the rate of the day; the guests' menus (a table's QR menu and online ordering) and a new pre-order's prices do the same. An order prices its dishes at the rates of its own business day (see [Orders](#orders)). A dish moved by a change gets an activity log row like an edit, in the name of whoever entered the change, with `details.via` "GST rate change of 1 Apr 2027: <reason>".

#### `GET /api/menu/tax-changes`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ today (the trading date), changes[{ id, starts_on, rate, rate_name, keeps, reason, created_at, created_by_name, items, scheduled, applied, cancelled, refused, state }] }`. `state` is `scheduled` (a dish still to move), `in_force`, `refused` or `cancelled`. Changes still to come are listed first, then by date, the latest first.

#### `POST /api/menu/tax-changes/preview`
Permission: `menu.manage`
Query/Body: `startsOn` (YYYY-MM-DD), `taxRateId` (an active tax rate), `keeps` (`total` by default: a price that includes GST keeps what the guest pays; `net`: it keeps its part before GST, and its price and each size's move), and either `items` (1-2,000 dish ids) or `filters: { taxRateId?, categoryId?, hsn? (the first 2-8 digits of the rate's HSN/SAC code), q? (name, code or kitchen name), inactive? (inactive dishes too) }`.
Returns: `data` = what each dish would become, as Business Admin's preview gives it (`POST …/tax-changes/preview`). A dish's price includes GST or not by its own price mode, else the restaurant's. Nothing is saved.
Errors: 400 a bad date, rate or filter; 404 tax rate not found or switched off.

#### `POST /api/menu/tax-changes`
Permission: `menu.manage`
Query/Body: `requestKey` (a UUID), `startsOn` (later than the trading date, and no later than the same day two years on), `taxRateId`, `keeps`, `items` (1-2,000 dish ids), `reason` (required, up to 300 characters)
Returns: `data` = the change as `GET /api/menu/tax-changes/:id` gives it; status 201. The activity log records it (`tax_change`, `scheduled`). The same key and body return the same change.
Errors: 400 a date that is not later than the trading date, or more than two years on; 404 a dish or rate not found; 409 `{ reason: "items_refused", items[{ id, label, problem }] }` (another change already moves a dish that day, or it would sell above its MRP); 409 `{ reason: "already_at_rate", items[] }`; 409 the same key with another body.

#### `GET /api/menu/tax-changes/:id`
Permission: `menu.view`
Query/Body: none
Returns: `data` = the change as the list gives it, with `items[{ id, product_id, label, code, status (scheduled, applied, cancelled, refused), from_name, from_rate, to_rate, price_before, price_after, sizes, settled_at, note, cancelled_at, cancel_reason, cancelled_by_name }]`. Once applied, `sizes` lists each size whose price moved, as `{ id, name, before, after }` (the size's difference from the dish's price).
Errors: 404 not found.

#### `POST /api/menu/tax-changes/:id/cancel` and `POST /api/menu/tax-changes/:id/items/:itemId/cancel`
Permission: `menu.manage`
Query/Body: `reason` (required, up to 300 characters)
Returns: `data` = the change. Every dish still to move stays where it is (or, by the second path, the one dish). The activity log records it (`cancelled`, `item_cancelled`). Asking again returns the same change.
Errors: 404 the change or dish not found; 409 the change's date has come: it is in force and kept for good.

#### `POST /api/menu/tax-changes/import/preview` and `POST /api/menu/tax-changes/import`
Permission: `menu.manage`
Query/Body and Returns: as a shop's ([GST rate changes](#gst-rate-changes)); a dish is found by its tax rate's HSN / SAC code, each line's rate must be one of the restaurant's active tax rates (a line's `problem` names *Menu › Tax rates*), and `documents` is always empty. The activity log records the list (`tax_change`, `imported`).

#### `GET /api/menu/tax-changes/settings`
Permission: `menu.view`
Query/Body: none
Returns: `data = { setting: "restaurant_default", name, where, today (the trading date), current: { rate } | null, currentWords, changes[] }`: the restaurant's default GST rate (`restaurant_settings.default_tax_percentage`, which its advances' GST is worked out at) and its changes by date, shaped as a shop's.

#### `POST /api/menu/tax-changes/settings` and `POST /api/menu/tax-changes/settings/:id/cancel`
Permission: `restaurant.settings.manage`
Query/Body: `requestKey`, `startsOn` (later than the trading date, within two years), `reason`, `values: { rate (0-100) }`; to cancel, `reason`
Returns: as a shop's. The change takes effect on its trading day, with the dishes' changes (`business_tax_change_apply_menu`), before the menu and the settings are read; the activity log records it as an edit of the settings with `details.via` "GST rate change of 1 Apr 2027: <reason>". [GET /api/bills/advances/gst](#get-apibillsadvancesgst) splits each advance at the default rate of the day it was received.
Errors: as a shop's (403 without `restaurant.settings.manage`).

**The bell** (`GET /api/notifications`, provider `taxChanges`, for `menu.manage`): each change of dishes or of the default rate still to come within 7 days, as a shop's (`taxChanges:<id>:7` and `:1`, `taxChanges:setting:<id>:7` and `:1`), linking to `/menu/tax-changes`.

#### `GET /api/menu/products/:id/tax-history`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ item: { id, label, code, tax_rate, tax_rate_id, slab_name, price, active }, changes[], edits[{ id, created_at, details, actor_name }] }`. `changes` holds each change for the dish, past and to come, with its reason, who entered it and its own state; `edits` holds each time the dish's rate was changed on the dish itself or by an import.
Errors: 404 product not found.

### Recipes and recipe import
Which inventory items one plate (or one size) uses. Costs and margins are shown only to callers holding `menu.manage` or `inventory.view`.

#### `GET /api/menu/products/:productId/recipe`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ productId, productName, price, lines[], sizes[] ({ id, name, price, isDefault, status, recipeFactor, source: own | factor | dish, lineCount, cost fields }), dishLineCount, costsVisible, cost/margin fields }`.
Errors: 404 product not found.

#### `POST /api/menu/products/:productId/recipe`
Permission: `menu.manage`
Query/Body: `inventoryItemId` (required), `quantity` (0.0001-999999, required), `productVariantId` (size, optional); or `copyFromDish: true` with `productVariantId` (required) and `factor` (0.05-10, default 1) to copy the dish recipe onto a size.
Returns: `data` = the full recipe; status 201.
Errors: 400 item does not exist; 400 size not of this product; 400 dish has no recipe to copy; 404 product not found; 409 item already in this recipe.

#### `PUT /api/menu/recipe/:id`
Permission: `menu.manage`
Query/Body: `quantity` (0.0001-999999, required)
Returns: `data` = the full recipe.
Errors: 404 recipe line not found.

#### `DELETE /api/menu/recipe/:id`
Permission: `menu.manage`
Query/Body: none
Returns: `data` = the full recipe.
Errors: 404 recipe line not found.

#### `GET /api/menu/recipes/import-guide`
Permission: `menu.manage`
Query/Body: none
Returns: `data` = `{ maxRows: 2000, columns[] ({ key, label, need, help, example }), ... }` (one row per ingredient).

#### `POST /api/menu/recipes/import`
Permission: `menu.manage`
Query/Body: `rows` (array, required, 1-2000), `dryRun`, `fingerprint`, `fileName`
Returns: `data` = `{ ok, problems[], rows[], created, updated, unchanged, dishes, columns, fingerprint }`. A dry run with problems answers 200 with `success: false`.
Errors: 400 no rows / too many / a row is not an object; 400 file has problems (real import); 409 `{ reason: "stale_preview" }`.

### Selling rules (contextual prices)
Per-dish price, availability and packaging charge for an outlet, sales channel and/or service type; the most specific match wins (outlet, then channel, then service type).

#### `GET /api/menu/selling-options`
Permission: `menu.view`
Query/Body: none
Returns: `data` = `{ outlets[] ({ id, name }), channels[] ({ id, name }) }` (active only).

#### `GET /api/menu/products/:productId/selling-rules`
Permission: `menu.view`
Query/Body: none
Returns: `data` = array of raw rule rows (snake_case: `id, product_id, outlet_id, channel_id, order_type, price, is_available, packaging_charge, ...`).

#### `PUT /api/menu/products/:productId/selling-rules`
Permission: `menu.manage`
Query/Body: at least one of `outletId`, `channelId`, `orderType` (`dine_in` | `takeaway` | `delivery` | `qr` | `online`); `price` (0-99999999 or null = menu price), `isAvailable` (default true), `packagingCharge` (0-99999). Upserts the rule for that context.
Returns: `data` = the saved rule row.
Errors: 400 no context chosen; 400 outlet/channel not this restaurant's or channel inactive; 400 price makes a size cost below zero; 404 product not found.

#### `DELETE /api/menu/selling-rules/:id`
Permission: `menu.manage`
Query/Body: none
Returns: `{ success: true }` only.
Errors: 404 rule not found.

### Menu card

#### `GET /api/menu/menu-card`
Permission: `menu.view`
Query/Body: `outletId` (int), `orderType` (`dine_in` | `takeaway` | `delivery`, default `dine_in`)
Returns: `data` = `{ restaurant: { name, address, contact, gstin, fssai, logo, currency }, outlet, orderType, orderTypeLabel, taxNote, markInclusive, summary: { categories, items, leftOut }, categories[] }`, each item with prices for that context, `sizes[]`, `addOns[]`.
Errors: 404 outlet not found.

## Tables

### Floors and areas
Mounted at `/api/tables`; login required. Writes run `resolveOutlet`: a user working in one outlet may only change a floor or area whose tables are all that outlet's (403 `{ reason: "room_shared" }` otherwise).

#### `GET /api/tables/floors`
Permission: `tables.view`
Query/Body: none
Returns: `data` = array of `{ id, name, sortOrder, status, areaCount, tableCount }`.

#### `POST /api/tables/floors`
Permission: `tables.manage`
Query/Body: `name` (required, <=100), `sortOrder` (whole 0-9999), `status` (`active` | `inactive`)
Returns: `data` = the floor; status 201.
Errors: 409 floor name already exists.

#### `PUT /api/tables/floors/:id`
Permission: `tables.manage`
Query/Body: same as create (full body).
Returns: `data` = the floor.
Errors: 403 `room_shared`; 404 floor not found; 409 duplicate name.

#### `DELETE /api/tables/floors/:id`
Permission: `tables.manage`
Query/Body: none
Returns: no `data`.
Errors: 403 `room_shared`; 404 not found; 409 floor still has areas or tables.

#### `GET /api/tables/areas`
Permission: `tables.view`
Query/Body: none
Returns: `data` = array of `{ id, floorId, floorName, name, sortOrder, status, tableCount }`.

#### `POST /api/tables/areas`
Permission: `tables.manage`
Query/Body: `floorId` (required), `name` (required, <=100), `sortOrder`, `status`
Returns: `data` = the area; status 201.
Errors: 400 floor does not exist; 409 floor already has an area with that name.

#### `PUT /api/tables/areas/:id`
Permission: `tables.manage`
Query/Body: same as create (full body).
Returns: `data` = the area.
Errors: 400 floor does not exist; 403 `room_shared`; 404 area not found; 409 duplicate name.

#### `DELETE /api/tables/areas/:id`
Permission: `tables.manage`
Query/Body: none
Returns: no `data`.
Errors: 403 `room_shared`; 404 not found; 409 area still has tables.

### Tables
A table belongs to one outlet or is shared (`outletId: null`). Lists show the caller's outlet plus shared tables; a table object is `{ id, floorId, floorName, areaId, areaName, outletId, tableNo, capacity, qrToken, tableStatus, status, live, booking, inService, outOfServiceReason, turn, readyAt, floorState, captain }` with `floorState` one of `running`, `printed`, `paid`, `out_of_service`, `cleaning`, `reserved`, `free` (see `services/table.service.js`), and `captain` the table's captain of the day (`{ userId, userName }`: its own line of the captain plan, else its section's, else its floor's; [Captain sections](#captain-sections)), or null.

#### `GET /api/tables`
Permission: `tables.view`
Query/Body: `floorId` (int)
Returns: `data` = array of tables, with the running order/bill (`live`), due booking, cleaning turn and the day's `captain`.

#### `POST /api/tables`
Permission: `tables.manage`
Query/Body: `floorId` (required), `areaId`, `outletId` (null = shared), `tableNo` (required, <=20), `capacity` (whole 1-100, default 4), `status`
Returns: `data` = the table (new random `qrToken`); status 201.
Errors: 400 floor/area/outlet does not exist or area on another floor; 403 `{ reason: "table_other_outlet" }` another outlet's table; 409 table number already exists.

#### `PUT /api/tables/:id`
Permission: `tables.manage`
Query/Body: same as create; `outletId` left out keeps the table's outlet.
Returns: `data` = the table.
Errors: as create; 403 `{ reason: "table_shared" }` shared table edited from inside one outlet; 404 not found / not in this outlet.

#### `PATCH /api/tables/:id/qr`
Permission: `tables.manage`
Query/Body: none
Returns: `data` = the table with a new `qrToken` (old printed codes stop working).
Errors: 403 `table_shared`; 404 not found / not in this outlet.

#### `PATCH /api/tables/:id/ready`
Permission: `tables.view` and one of `tables.manage` or `orders.create`
Query/Body: none. Ends the cleaning turn so the table is free (or reserved) at once; shared tables allowed.
Returns: `data` = the table.
Errors: 404 not found / not in this outlet; 409 table out of service; 409 an order is still running on it.

#### `DELETE /api/tables/:id`
Permission: `tables.manage`
Query/Body: none
Returns: no `data`.
Errors: 403 `table_shared`; 404 not found; 409 occupied now; 409 has past orders (set it inactive instead).

### Floor settings and QR

#### `GET /api/tables/settings`
Permission: `tables.view`
Query/Body: none
Returns: `data` = `{ cleaningMinutes, updatedAt }`.

#### `PUT /api/tables/settings`
Permission: `tables.manage`
Query/Body: `cleaningMinutes` (whole number 0-120, required)
Returns: `data` = `{ cleaningMinutes, updatedAt }`.
Errors: 403 `{ reason: "room_shared" }` when the caller is working in one outlet (restaurant-wide setting).

#### `GET /api/tables/qr-settings`
Permission: `tables.view`
Query/Body: none
Returns: `data` = `{ guestWebAddress, restaurantName, logoPath }` for printing table QR cards.

### Captain sections
Which captain has which floor, section (area) or table on a business date. The default date is the open business day (main counter first, then the outlet's), else today in the restaurant's timezone. These routes need the `captain_sections` feature. While it is switched off, the plans are kept but name nobody: `GET /api/tables` and `GET /api/table-requests` give every table and every request `captain: null`, so every captain sees every table.

#### `GET /api/tables/sections`
Permission: `tables.view`
Query/Body: `date` (`YYYY-MM-DD`)
Returns: `data` = `{ date, assignments[] ({ id, userId, userName, kind: floor | area | table, floorId, areaId, tableId, label }), captains[] ({ id, name, outletId }) }`.
Errors: 400 bad date.

#### `PUT /api/tables/sections`
Permission: `tables.manage`
Query/Body: `date` (optional), `assignments` (array, required, <=500; each `{ userId, and exactly one of floorId | areaId | tableId }`). Replaces the plan for that date.
Returns: `data` = the plan as GET.
Errors: 400 not exactly one target per line; 400 captain/floor/section/table does not exist; 400 a target listed twice.

#### `POST /api/tables/sections/copy`
Permission: `tables.manage`
Query/Body: `from` (date, required), `to` (date, default current business date)
Returns: `data` = the copied plan.
Errors: 400 `from` missing or same as `to`; 404 no plan on `from`; 409 `to` already has a plan.

## Kitchen

### Board and tickets (KOTs)
Mounted at `/api/kitchen`; login required and `resolveOutlet` runs on every route, so a caller working in one outlet sees that outlet's tickets (others answer 404 "... not found in this outlet"). Tickets are cut from orders by a sync that runs on board reads. A ticket object is `{ id, kotNumber, kotNo, status, stationId, stationName, stationColor, orderId, orderNumber, orderType, source, tableNo, guestCount, customerName, brandName, tokenNo, round, createdAt, startedAt, readyAt, servedAt, recallCount, printCount, takenByLabel, sentByLabel, nameMode, items[], siblings[] }` and more (see `services/kitchen.service.js`).

#### `GET /api/kitchen/board`
Permission: `kds.view`
Query/Body: `stationId` or `station` (int, optional; empty = whole kitchen)
Returns: `data` = `{ serverTime, businessDay, settings, stationId, stations[], tickets[], recentServed[], newTicketIds[], stats, print: { restaurantName, paperWidth }, changeSlips[] }`.

#### `GET /api/kitchen/pass`
The food at the pass, for the waiters who carry it out (the captain app's *Ready* list and its tables). Read only: unlike the board it cuts and clears no ticket.
Permission: `kds.view` or `kot.manage`; feature `kitchen_display`
Query/Body: none. The outlet the caller works in (`resolveOutlet`), or the whole restaurant.
Returns: `data` = `{ serverTime, passMinutes, tickets[] }`: the tickets marked ready and not yet served, and the tickets still cooking with a dish the kitchen has ticked done and nobody has served, the oldest at the pass first (`passSince`: the ticket's `readyAt`, else its first dish waiting), each a ticket object with its order, table and dishes (each dish with `isDone`, `servedAt`, `servedByName` and `courseName`). Only tickets still in the kitchen by the board's own rules are listed: an open business day's, and not those of a cancelled order, a table that has paid or an order served from the orders screen. `passMinutes` is how long plated food may wait (the kitchen timers, 8 by default). A ticket is served with `PATCH /api/kitchen/kots/:id/status` `{ status: "served" }`, one dish with `POST /api/kitchen/kots/:id/items/:itemId/serve`.
Errors: 401 not signed in; 403 neither permission; 403 `{ reason: "feature_off", feature: "kitchen_display" }`.

#### `POST /api/kitchen/sync`
Permission: `kds.view` or `kot.manage`
Query/Body: none
Returns: `data` = `{ created[] (with kotNo), cleared, ordersChecked }`.

#### `GET /api/kitchen/orders/:orderId/kots`
Permission: `kds.view` or `kot.manage`
Query/Body: none (syncs that order first)
Returns: `data` = array of the order's tickets.
Errors: 404 order not found (in this outlet).

#### `GET /api/kitchen/kots/:id`
Permission: `kds.view`
Query/Body: none
Returns: `data` = the ticket.
Errors: 404 ticket not found (in this outlet).

#### `PATCH /api/kitchen/kots/:id/status`
Permission: `kot.manage`
Query/Body: `status` (`new` | `cooking` | `ready` | `served`, required)
Returns: `data` = the ticket (message says if it was already in that state).
Errors: 404 not found; 409 move not allowed (cancelled, already served, ready back to new); 409 everything on it was cancelled.

#### `PATCH /api/kitchen/kots/:id/items/:itemId`
Permission: `kot.manage`
Query/Body: `done` (boolean, required)
Returns: `data` = the ticket.
Errors: 400 `done` missing; 404 ticket not found / dish not on this ticket; 409 ticket cancelled or already served; 409 dish cancelled at the till; 409 the dish was served from the floor (`done: false`).

#### `POST /api/kitchen/kots/:id/items/:itemId/serve`
One dish served from the floor on its own (the captain app's *Ready* list): a dish the kitchen has ticked done, while the rest of its ticket cooks. Serving the last dish still waiting serves the ticket, in the same person's name, as `PATCH …/status` `{ status: "served" }` does. A dish served stays done; a recall of the ticket brings every dish back to the pass. The order's line is *served* once every ticket line covering it is.
Permission: `kot.manage`; feature `kitchen_display`
Query/Body: none.
Returns: `data` = the ticket (its dish with `servedAt`, `servedByName`); the message says whether the whole ticket went with it, or that the dish was already served (nothing changes).
Errors: 403 without `kot.manage`; 404 ticket not found (in this outlet), dish not on this ticket; 409 ticket cancelled or already served; 409 the dish was cancelled at the till; 409 the kitchen has not marked the dish done.

#### `GET /api/kitchen/day`
An earlier day's tickets, read only (the dashboard's kitchen panel, *Earlier day*). Nothing is cut or cleared.
Permission: `kds.view`; feature `kitchen_display`
Query: `date` (YYYY-MM-DD on the restaurant's calendar, required). The outlet the caller works in (`resolveOutlet`), or the whole restaurant.
Returns: `data` = `{ date, settings, stats, more, tickets[] }`: every ticket cut on the business days dated `date`, oldest first, each a ticket object (with `createdAt`, `readyAt`, `servedAt`, `cancelledAt`, `clearedReason`, `courseName`); `stats` = `{ avgReadySeconds, timedCount, lateCount, servedCount, clearedCount, totalCount }` as the board counts them, or null with no business day that date; at most 2,000 tickets (`more` true when there were more).
Errors: 400 `date` missing or not a real date; 400 a day after today; 403 without `kds.view`.

#### `POST /api/kitchen/kots/:id/recall`
Permission: `kot.manage`
Query/Body: none. Brings a served ticket back to the pass.
Returns: `data` = the ticket.
Errors: 404 not found; 409 ticket still on the board.

#### `POST /api/kitchen/recall`
Permission: `kot.manage`
Query/Body: `stationId` or `station` (optional). Recalls the most recently served ticket.
Returns: `data` = the ticket.
Errors: 404 nothing served in the last three hours.

#### `POST /api/kitchen/clear-old`
Permission: `kot.manage` and `orders.manage`
Query/Body: `olderThanMinutes` (whole 60-1440, default 120), `stationId` / `station` (optional)
Returns: `data` = `{ cleared, orders, olderThanMinutes }`.
Errors: 400 station does not exist.

#### `POST /api/kitchen/kots/:id/print`
Permission: `kds.view` or `kot.manage`
Query/Body: none. Counts a print of the ticket.
Returns: `data` = the ticket with updated `printCount`, `lastPrintedAt`.
Errors: 404 ticket not found.

### Change slips
CANCEL and TABLE CHANGED slips that follow a paper KOT. All three routes accept any one of `kds.view`, `kot.manage` or `orders.create`. A slip is `{ id, kind, orderId, orderNumber, orderType, tableNo, fromTableNo, toTableNo, stationId, stationName, stationColor, kotNumbers[], kotNos[], lines[], reason, changedByName, approvedByName, printCount, ... }`.

#### `POST /api/kitchen/slips/claim`
Permission: `kds.view`, `kot.manage` or `orders.create`
Query/Body: `orderIds` (int[], 1-10, required). Syncs those orders, then hands over and marks printed their unprinted slips.
Returns: `data` = array of slips to print now.
Errors: 400 not between one and ten orders.

#### `GET /api/kitchen/slips`
Permission: `kds.view`, `kot.manage` or `orders.create`
Query/Body: `orderId` (int, optional)
Returns: `data` = array of slips for open business days (or one order), newest first.

#### `POST /api/kitchen/slips/:id/print`
Permission: `kds.view`, `kot.manage` or `orders.create`
Query/Body: none. A second print is a reprint (logged).
Returns: `data` = the slip with updated `printCount`.
Errors: 404 change slip not found (in this outlet).

### Stations and routing
Dishes go to their own station, else their category's, else the default station.

#### `GET /api/kitchen/stations`
Permission: `kds.view` or `menu.manage`
Query/Body: none
Returns: `data` = `{ stations[] ({ id, name, color, sortOrder, isDefault, status, openCount, lateCount, categoryCount, productCount }), categories[] ({ id, name, status, productCount, stationId }), exceptions[] (dishes with their own station), settings }`.

#### `POST /api/kitchen/stations`
Permission: `menu.manage`
Query/Body: `name` (required, <=60), `color` (`orange`, `red`, `amber`, `green`, `teal`, `blue`, `violet`, `pink`, `slate`; default `orange`), `sortOrder` (whole 0-999), `status`
Returns: `data` = the station; status 201.
Errors: 409 station name already exists.

#### `PUT /api/kitchen/stations/:id`
Permission: `menu.manage`
Query/Body: same as create (full body).
Returns: `data` = the station.
Errors: 404 station not found; 409 switching off the default station; 409 duplicate name.

#### `POST /api/kitchen/stations/:id/default`
Permission: `menu.manage`
Query/Body: none
Returns: `data` = the station, now the catch-all.
Errors: 400 station is switched off; 404 not found.

#### `PUT /api/kitchen/category-stations/:categoryId`
Permission: `menu.manage`
Query/Body: `stationId` (int, or null to fall back to the default)
Returns: no `data` (message "Routing saved").
Errors: 400 station does not exist or is switched off; 404 category not found.

#### `PUT /api/kitchen/product-stations/:productId`
Permission: `menu.manage`
Query/Body: `stationId` (int, or null to follow the category)
Returns: no `data`.
Errors: 400 station does not exist or is switched off; 404 dish not found.

#### `GET /api/kitchen/products`
Permission: `menu.manage`
Query/Body: `search` (<=100)
Returns: `data` = array of `{ id, name, foodType, categoryName, exceptionStationId, categoryStationId }`.

### Kitchen settings

#### `GET /api/kitchen/settings`
Permission: `kds.view` or `menu.manage`
Query/Body: none
Returns: `data` = `{ warnMinutes, lateMinutes, passMinutes, liveSince, kitchenNameMode }`.

#### `PUT /api/kitchen/settings`
Permission: `menu.manage`
Query/Body: timers `warnMinutes` (whole 1-120) and `lateMinutes` (whole 2-180) sent together, and/or `passMinutes` (whole 1-60: how long plated food may wait at the pass before the bell says so; 8 until changed), and/or `kitchenNameMode` (`menu` | `kitchen` | `both`)
Returns: `data` = the settings.
Errors: 400 nothing sent; 400 non-whole minutes; 400 late mark not after the warning mark.

---

## Front of house: orders, table requests, reservations, deliveries and guest pages

### Orders

Mounted at `/api/orders` (order.routes.js). Every route signs the user in and runs `resolveOutlet`. Any `:id` is checked first: it must be a whole id, and when the request works in an outlet the order must belong to it, else 404 "Order not found in this outlet". Prices always come from the menu: the client sends ids, quantities and notes only. A dish's price and GST rate are those in force on the order's business day: before an order is priced, the GST rate changes due on that day take effect, and a dish whose change took effect for a later day (an outlet still on last night's day) is priced as it was before it ([GST rate changes on the menu](#gst-rate-changes-on-the-menu)). The order shape (`toOrder` in order.service.js) is `{ id, orderNumber, orderType, source, outletId, tableId, tableNo, customerId, customerName, customerMobile, guestCount, orderStatus, kitchenStatus, subtotal, taxAmount, totalAmount, notes, joinedTables[], mergedIntoOrderId, billId, billNumber, billStatus, channelId, brandId, brandName, deliveryStatus, deliveryAddress, tokenNo, tokenCollectedAt, deliveryCharge, deliveryChargeWaived, deliveryChargeWaivedReason, items[] }`. Each item is `{ id, productId, productVariantId, itemName, variantName, quantity, unitPrice, modifierTotal, lineTotal, itemStatus, courseNo, courseName, fireStatus, kitchenQuantity, kitchenStage, cancelledQuantity, modifiers[] }`, plus more fields listed in the service. Cancel reason codes (utils/cancelReasons.js) are `guest_changed_mind`, `wrong_order`, `delay`, `quality` and `other`.

Taking off food the kitchen already has (through `PUT /:id/items`, `PATCH /:id/items/:itemId/cancel` or `PATCH /:id/cancel`) needs `orders.cancel_after_kot` or a manager's approval. The service checks this inside, only when such food is involved, and answers like a "permission or approval" route: 403 `approval_required` (the scope names the order, dish, quantity and amount). It can also answer 403 `approval_per_dish`, which means take the dishes off one at a time, or 403 `approval_invalid`, which means the token does not cover this change. When no reason was given it answers 400 `cancel_reason_required` (`data.dishes`, `data.reasons`). Reason `other` with no note gives 400 `cancel_note_required`.

#### `GET /api/orders`
Permission: `orders.view`
Query: `status` (open, billed, completed, cancelled), `orderType` (dine_in, takeaway, delivery, qr, online), `businessDayId`, `limit` (whole number, 1-500, default 100), `offset` (whole number, default 0), `sort` (`newest` default, or `tables_first`). The list follows the request's outlet.
Returns: `data` = `{ items[] (orders), total, limit, offset, summary: { onTables, other, amount } }`. Users without `customers.contact` see `customerMobile` masked to the last four digits.
Errors: 400 a filter is not allowed, or limit/offset is not a whole number.

#### `GET /api/orders/offers`
Permission: `orders.view`
Query: `orderType` (default dine_in), `channelId`, `orderId` (price at that order's outlet), `tableId` (price at the table's outlet when the till is on "All outlets").
Returns: `data` = `[{ productId, productVariantId, price, windowId?, windowName, endsAt?, packagingCharge?, isAvailable?, unavailableReason? }]`. These are happy-hour and selling-rule prices that apply right now.
Errors: 404 `orderId` not found.

#### `GET /api/orders/day`
Permission: `orders.view`
Query: none (uses the request's outlet).
Returns: `data` = `{ current: { id, businessDate, openedAt } | null }`.

#### `GET /api/orders/outlets`
Permission: `orders.create`
Query: none.
Returns: `data` = `[{ id, name }]` for active outlets only. The till uses it to ask which outlet a sale is for.

#### `GET /api/orders/cancellations`
Permission: `audit.view`
Query: `from`, `to` (YYYY-MM-DD; both default to the open business date), `userId`, `reason` (cancel reason code), `limit` (1-1000, default 500), `offset`. The report follows the request's outlet.
Returns: `data` = `{ from, to, items[] (orderNumber, itemName, quantity, amount, kitchenStage, reasonCode, reason, note, cancelledByName, approvedByName, businessDate, and more), total, limit, offset, summary, byStaff[], byReason[], staff[], reasons[] }`. These are dishes taken off after the kitchen had them.
Errors: 400 a date is badly formed, or the start date is after the end date.

#### `GET /api/orders/guest`
Permission: `orders.create`
Query: `mobile` (required, at most 30 characters).
Returns: `data` = `{ mobile, valid, problem, guest: null | { id, name, mobile, loyaltyPoints, visits, lastVisitAt, tags, allergies, companyName, status, dateOfBirth, anniversaryDate, addresses[], recentOrders[] }, sameDigits? }`. `dateOfBirth` and `anniversaryDate` are sent as `2000-MM-DD`. Addresses are masked for users without `customers.contact`. An invalid number returns `valid: false` with a `problem` sentence. It is not an error.
Errors: 400 no mobile was given.

#### `GET /api/orders/joined-tables`
Permission: `orders.view`
Query: none.
Returns: `data` = `[{ tableId, tableNo, orderId, orderNumber, orderStatus, mainTableNo }]`. These are tables joined to a party whose order is still open, or billed and not yet paid.

#### `GET /api/orders/collection`
Permission: `orders.collection` (the Collection display role has only this permission)
Query: none (uses the request's outlet and its open business day).
Returns: `data` = `{ serverTime, restaurantName, outletName, tokensEnabled, clearMinutes, businessDate, preparing: [{ token, since, orderId? }], ready: [{ token, readyAt, orderId? }] }`. `orderId` is included only when the user also has `orders.create`. Ready tokens leave the board `clearMinutes` after they became ready. With no open day the lists are empty.

#### `GET /api/orders/:id`
Permission: `orders.view`
Returns: `data` = the order. The full mobile is included.
Errors: 404 order not found, or it belongs to another outlet.

#### `GET /api/orders/:id/moves`
Permission: `orders.view`
Returns: `data` = `[{ id, type (table, join, dishes, unjoin), label, fromOrderNumber, toOrderNumber, fromTableNo, toTableNo, items[], amount, movedAt, movedByName }]`.
Errors: 404 order not found.

#### `POST /api/orders`
Permission: `orders.create`
Body: `items[]` (required; each `{ productId, productVariantId?, modifierIds?[], comboSelections?, quantity (0.01-9999), notes? (200), courseNo? (1-20, default 1), courseName? (60), holdCourse? }`), `orderType` (dine_in default, takeaway, delivery, qr, online), `tableId` (required for dine_in), `channelId`, `brandId` (the brand the order is taken under; left out, the kitchen's own name), `source` (pos default, captain, qr, website, phone, partner), `customerId`, `customerName` (150), `customerMobile` (20), `guestCount` (whole number, 1-999), `notes` (500), `overrideHold` (true to seat on a table held for a booking). The outlet comes from `resolveOutlet`, never from the body. A typed mobile with no `customerId` finds the guest, or adds a new guest to the guest book. A dine-in, takeaway or delivery order the counter takes (any source but `qr` and `website`) must be a kind the POS takes (`PUT /api/orders/service-settings/pos`).
Returns: 201, `data` = the order plus `guestAdded` (`{ id, name }` or null) and `guestNotice`. The order gets a token number when tokens are on for its order type.
Errors: 400 `order_type_off` (the POS does not take that kind of order); 400 dish not on the menu, outside serving times, size or add-on invalid, or price above MRP; 400 `brand_menu` (a dish on another brand's menu); 403 `feature_off` a brand while the brands feature is off; 404 brand not found; 409 the brand is switched off; 400 `sold_out` (`data.items`); 400 table missing, not in use, or on a closed floor or section; 400 `table_other_outlet` or `table_main_counter`; 409 `table_held` (`data.booking`, resend with `overrideHold`); 409 `table_busy` (`data.orderId`); 409 no business day is open; 409 `outlet_required` (pick an outlet for a takeaway or delivery, or for a till on "All outlets").

#### `POST /api/orders/:id/move-table`
Permission: `orders.create`
Body: `tableId` (required), `overrideHold` (boolean).
Returns: `data` = `{ order, from, fromTableNo, toTableNo, releasedTables[], ... }`. Kitchen tickets are synced after the move.
Errors: 400 the order is already on that table; 404 the table does not exist; 409 the order is not open or billed, or is not on a table; 409 the table is not in use or is closed; 409 `table_held`, `table_busy`, `already_joined`, `other_outlet` or `table_changed`.

#### `POST /api/orders/:id/join-table`
Permission: `orders.create`
Body: `tableId` (required), `overrideHold`.
Returns: `data` = `{ order, tableNo, joinedTableNo, merged: null | { id, orderNumber, moved[] } }`. An order already running on the joined table is merged into this one.
Errors: same as move-table, plus 409 `already_joined`, and 409 `table_busy` when that table is joined to another party.

#### `POST /api/orders/:id/unjoin-table`
Permission: `orders.create`
Body: `tableId` (required).
Returns: `data` = `{ orderNumber, tableNo, freed, order }`. `freed` is false when another order is still running on the table.
Errors: 404 the table is not joined to this order; 409 `order_closed`.

#### `POST /api/orders/:id/move-dishes`
Permission: `orders.create`
Body: `tableId` (required), `items[]` (required; each `{ id (order line), quantity (0.01-9999), seenQuantity? }`), `guests` (whole number, 1-999), `overrideHold`.
Returns: `data` = `{ mode (dishes, table, merged), order, from, moved[], created, fromTableNo, toTableNo, releasedTables[] }`. A line moved in part is split at its own price.
Errors: 400 a line is listed twice, more is moved than the line holds, or no dish was chosen; 409 a line was cancelled or changed elsewhere (`order_changed`); 409 the order is not on a table; plus the table errors from move-table.

#### `PUT /api/orders/:id/items`
Permission: `orders.create` (plus `orders.cancel_after_kot` or approval when food the kitchen has is taken off; see above)
Body: `items[]` (required). An existing line is `{ id, quantity (0-9999; 0 takes it off), seenQuantity }`. A new dish uses the same fields as in create. Also: `changesOnly` (true: only the lines named change), `notes`, `guestCount`, `customerId`, `customerName`, `customerMobile` (change the order's header), `seen` (what the screen showed: `{ notes?, guestCount?, customerId?, customerName?, customerMobile? }`), `cancelReason` (reason code), `cancelNote` (200), `tableId` (must be the order's own table).
Returns: `data` = the order plus `changes.cancelled[]`, `guestAdded` and `guestNotice`.
Errors: 409 `outdated_screen` (a browser sent a whole cart, or changed the header without `seen`); 409 `use_move_table` (`tableId` is a different table); 409 `order_changed` or `stale_order` (another device changed the order); 409 the order is billed or closed; 400 a line is listed twice; 400 `brand_menu` (a dish added to a brand's order is not on that brand's menu; a brand switched off after an order opened still takes additions to that order); plus the pricing errors from create and the cancellation errors above.

#### `POST /api/orders/:id/courses/:courseNo/fire`
Permission: `orders.create`
Body: none. `courseNo` is a whole number from 1 to 20.
Returns: `data` = the order. Message: "Mains sent to the kitchen" when the course's dishes were sent under a name (the captain app), else "Course N sent to the kitchen". Logged (`fire` `order`, with `courseNo` and `courseName`). Any course, the first included, can be held (`holdCourse: true` on `POST /api/orders`); its tickets carry the course's name on each dish (`courseName`) and on the ticket when every dish shares it.
Errors: 404 order not found; 409 the order is not open; 409 that course is not being held.

#### `PATCH /api/orders/:id/items/:itemId/cancel`
Permission: `orders.manage` (plus `orders.cancel_after_kot` or approval when the kitchen has the dish)
Body: `quantity` (optional, 0.01-9999; default the whole line), `reason` (reason code; required when the kitchen has the dish), `note` (200).
Returns: `data` = the order with `changes.cancelled[]`.
Errors: 404 the item is not on this order; 409 the item is already cancelled; 400 more is taken off than the line holds; plus the cancellation errors above.

#### `PATCH /api/orders/:id/kitchen-status`
Permission: `kot.manage`
Body: `status` (required: pending, preparing, ready or served).
Returns: `data` = the order.
Errors: 404 order not found.

#### `PATCH /api/orders/:id/cancel`
Permission: `orders.manage` (plus `orders.cancel_after_kot` or approval when the kitchen had any of the food)
Body: `reason` (required, 200), `reasonCode` (reason code; defaults to `other`).
Returns: `data` = the cancelled order with `changes.cancelled[]`.
Errors: 409 "This order has a bill. Void the bill first.", or the order is not open; 404 order not found; plus the cancellation errors above.

#### `POST /api/orders/:id/delivery-charge/waive`
Permission: `orders.create`, and `orders.waive_delivery_charge` or manager approval (the scope is `{ orderId, amount }`, with the amount read from the order)
Body: `reason` (required, 200). It is checked before any approval is asked for.
Returns: `data` = the order with `deliveryChargeWaived: true`.
Errors: 400 the order is not a delivery; 409 the order is already billed or closed (change the charge on its bill instead); 409 the charge is already waived; 404 order not found.

#### `POST /api/orders/:id/delivery-charge/restore`
Permission: `orders.create`
Body: none.
Returns: `data` = the order with the delivery charge applied again.
Errors: 400 the order is not a delivery; 409 the order is not open; 404 order not found.

#### `POST /api/orders/:id/collected`
Permission: `orders.create`
Body: none.
Returns: `data` = `{ id, orderNumber, tokenNo }`. The token leaves the collection screen.
Errors: 409 the token was already collected, or the order has no token; 404 order not found.

### Service settings

Mounted inside the orders router at `/api/orders/service-settings` (serviceSettings.routes.js), so the user is signed in and `resolveOutlet` has run. The settings are per restaurant. Each part is changed with the permission of the work it belongs to.

#### `GET /api/orders/service-settings`
Permission: `orders.view`
Returns: `data` = `{ guestWebAddress, tokensEnabled, tokenOrderTypes[], collectionClearMinutes, posOrderTypes[], defaultOrderType, courseNames[], updatedAt }`. `courseNames` are the courses' names, course 1 first (Starters, Mains, Desserts until changed). `posOrderTypes` are the kinds of order the POS takes (`dine_in`, `takeaway`, `delivery`; all three until changed) and `defaultOrderType` the one a new order starts on.

#### `PUT /api/orders/service-settings/tokens`
Permission: `orders.manage`
Body (only the fields sent change): `tokensEnabled` (boolean), `tokenOrderTypes[]` (takeaway, delivery, online; not empty), `collectionClearMinutes` (whole number, 1-120).
Returns: `data` = the settings.
Errors: 400 the token order types list is empty, or the minutes are not a whole number.

#### `PUT /api/orders/service-settings/pos`
Permission: `orders.manage`
Body (only the fields sent change): `posOrderTypes[]` (`dine_in`, `takeaway`, `delivery`; at least one), `defaultOrderType` (one of them). When the start is not sent, it stays if the POS still takes it, else it becomes the first kind in the list. A cloud kitchen, for instance, takes no dine-in.
Returns: `data` = the settings. From then on, `POST /api/orders` refuses an order of a kind the POS does not take (400 `order_type_off`); QR and website orders keep their own switches.
Errors: 400 an unknown kind of order; 400 no kind of order; 400 the start is not a kind the POS takes.

#### `PUT /api/orders/service-settings/courses`
Permission: `orders.manage`
Body: `courseNames[]` (strings, course 1 first). Each is tidied of extra spaces; one to six, none empty, at most 30 characters, no two the same (case aside). The captain app sends a dine-in table's dishes under these names (`courseNo` and `courseName` on each item of `POST /api/orders`); the KOT prints the name. Renaming changes only what is sent after.
Returns: `data` = the settings. Logged (`update` `service_settings`, *Courses*).
Errors: 400 not a list, or a name not text; 400 none or more than six; 400 an empty name; 400 a name too long; 400 a name twice; 403 without `orders.manage`.

#### `PUT /api/orders/service-settings/guest-web-address`
Permission: `tables.manage`
Body: `guestWebAddress` (string, at most 200 characters). Empty clears it, and links then use the guests' site's own address: the staff app's `VITE_CUSTOMER_WEB_URL` for the links its screens build, the server's `GUEST_WEB_URL` for those the server builds (`url` on `GET /api/reservations/online-settings`). `https://` is added when no scheme is given. It is saved as origin + path, without a trailing slash (read as `GUEST_WEB_URL` is read, `backend/src/utils/webAddress.js`).
Returns: `data` = the settings.
Errors: 400 not a web address, not http(s), or it has a query, fragment or credentials.

#### `GET /api/orders/service-settings/online-ordering`
Permission: `orders.view`
Returns: `data` = `{ links: [{ id, outletId, outletName (null = main counter), outletActive, token, enabled, live, takeawayEnabled, deliveryEnabled, minDeliveryOrder, pickupMinutes, deliveryMinutes, maxOpenPerMobile, deliveryArea, guestNote, waiting, lastDay, acceptedLastDay, updatedAt }], websiteChannel: { id, name, charge, freeAbove } | null, onlinePaymentNote }`. There is one link per selling point, created when first needed. `live` is false when the Website channel is off.

#### `PUT /api/orders/service-settings/online-ordering/:id`
Permission: `orders.manage`
Body (only the fields sent change): `enabled`, `takeawayEnabled`, `deliveryEnabled` (booleans), `minDeliveryOrder` (0-100000), `pickupMinutes` (whole number, 5-180), `deliveryMinutes` (whole number, 10-240), `maxOpenPerMobile` (whole number, 1-10), `deliveryArea` (200), `guestNote` (200).
Returns: `data` = the updated link.
Errors: 404 link not found (or the id is not valid); 400 both takeaway and delivery are off; 409 switching on the link of a closed outlet; 409 switching on while the Website sales channel is off.

#### `POST /api/orders/service-settings/online-ordering/:id/new-link`
Permission: `orders.manage`
Body: none.
Returns: `data` = the link with a new `token`. The old link stops working. Orders already placed keep their guest status links.
Errors: 404 link not found.

### Guest delivery addresses

Mounted at `/api/crm/customers/:customerId/addresses` (guestAddress.routes.js). The user must be signed in. No outlet scoping applies. A guest keeps at most 5 saved addresses (`MAX_ADDRESSES`). Addresses are added from the POS when a delivery is saved (`PATCH /api/deliveries/:orderId` with `address` and `addressLabel`), not here. Users without `customers.contact` see each address masked: the last part only, as `"…, Area"`, with no landmark and `masked: true`.

#### `GET /api/crm/customers/:customerId/addresses`
Permission: `customers.view`
Returns: `data` = `{ max, addresses: [{ id, label, address, landmark, masked, lastUsedAt, useCount }] }`.
Errors: 404 guest not found or erased.

#### `PUT /api/crm/customers/:customerId/addresses/:id`
Permission: `customers.manage` and `customers.contact`
Body: `address` (required, 500), `label` (30, default "Home"), `landmark` (200).
Returns: `data` = the address, unmasked.
Errors: 404 guest or address not found; 409 the guest already has this address saved.

#### `DELETE /api/crm/customers/:customerId/addresses/:id`
Permission: `customers.manage`
Returns: no `data`. The response carries a message only.
Errors: 404 guest or address not found.

### Pre-orders

Mounted at `/api/preorders` (preorder.routes.js): the user must be signed in, `resolveOutlet` runs, and the `preorders` feature must be on (403 `feature_off`). A pre-order is a cake or party order for a later day: its items with the message for each, an advance, and when it is due. It moves booked → in_production → ready → collected, or is cancelled. The advance is an ordinary guest advance (`/api/bills/advances`), so it also needs the `advances` feature: it goes into the open business day and takes the next receipt number. On collection the pre-order becomes a takeaway order on today's business day, and the advance is put on that order, so its bill takes the advance first. Staff tied to an outlet see and act on that outlet's pre-orders only: `GET /api/preorders` lists no other, whatever the status asked for, and `GET /:id`, `POST /:id/status`, `/advance`, `/collect` and `/cancel` answer 404 "Pre-order not found" for another outlet's pre-order or one booked at the main counter, and change nothing. Everyone else sees and acts on every outlet's, whichever outlet is picked: `X-Outlet-Id` only chooses the till, that is, whose bake list is read, where a new pre-order is booked and where a collected one is billed. Each till has its own bake list, which the kitchen reads too: `kds.view` reads the bake list and nothing else here, so the built-in Kitchen Staff role (`kds.view` without `orders.view`) gets 403 on the list, a single pre-order, booking, a status, hand-over, cancelling and an advance. The pre-order shape is `{ id, number (PRE-0001), status, customerId, customerName, customerMobile, dueAt, fulfilment (pickup, delivery), deliveryAddress, notes, outletId, outletName, estimatedTotal, advanceId, advanceReceipt, advanceAmount, advanceHeld, balanceDue, orderId, orderNumber, cancelReason, items[{ id, productId, productVariantId, name, quantity, unitPrice, notes, soldBy }], createdAt, createdByName, collectedAt }`. Ids must be whole numbers, else 400.

#### `GET /api/preorders`
Permission: `orders.view`
Query: `status` (`open` default: booked, in production or ready; `all`; or one of booked, in_production, ready, collected, cancelled), `from`, `to` (due dates, YYYY-MM-DD, in the restaurant's time zone), `search` (100: number, guest name or mobile, notes).
Returns: `data` = array of pre-orders (for staff tied to an outlet, that outlet's only), soonest due first, at most 300.
Errors: 400 a status or date that is not valid.

#### `GET /api/preorders/bake-list`
Permission: `orders.view` or `kds.view` (the kitchen display's permission, which reads the list whether or not the Kitchen display feature is on; a bakery starts with it off)
Query: `day` (YYYY-MM-DD; default the day this till trades on: the open business day of the request's outlet, else the main counter's; with no day open, today on the restaurant's clock, or last night's day before the cut-off hour).
Returns: `data` = `{ day, counter, items[{ productId, name, soldBy, quantity, orders[{ number, dueAt, quantity, notes, customer }] }] }`. This is what the till asking makes that day: the items of the open pre-orders booked at its outlet and due that day, added up by item, each with its messages. The till is the request's outlet (the user's own when they are tied to one, else `X-Outlet-Id`); with none, it is the main counter, whose list holds the pre-orders booked with no outlet. `counter` names the till: `{ outletId, name }` for an outlet; `{ outletId: null, name: "Main counter" }` for the main counter of a restaurant with active outlets; `null` for a restaurant with no active outlet, whose single list is the main counter's.
Errors: 400 the day is not valid.

#### `GET /api/preorders/:id`
Permission: `orders.view`
Returns: `data` = the pre-order.
Errors: 404 pre-order not found, or (for staff tied to an outlet) another outlet's or the main counter's.

#### `POST /api/preorders`
Permission: `orders.create` (an advance also needs `payments.manage`)
Body: `customerId`, or `customerMobile` (20) with `customerName` (150), which finds the guest or adds them to the guest book; `dueAt` (required, date and time, later today or a later day); `fulfilment` (`pickup` default, `delivery`); `deliveryAddress` (300; required for delivery); `notes` (500); `items[]` (required, 1-30; each `{ productId, productVariantId?, quantity (0.01-9999; kg for a dish sold by weight), notes? (300, the message on the cake) }`); `advance` (optional: `{ amount (1-10,000,000), paymentMethod (cash, card, upi, online, wallet, other), paymentTypeId?, transactionRef? (100) }`). Items are priced from the menu (a size adds its difference). The outlet is the request's.
Returns: 201, `data` = the pre-order. The advance's payment type is checked before anything is saved. If the till then refuses the advance (no business day open, or cash that would take the guest to ₹2,00,000 that day), the pre-order is booked all the same: `data.advanceRefused` is the reason, the message says the advance was not taken, and it is taken later with `POST /api/preorders/:id/advance`.
Errors: 400 no due time, or a time already past; 400 not 1-30 items; 400 no guest and no mobile; 400 the advance is more than the order; 400 the advance's payment type is not found, is for another method, is switched off or needs its reference (nothing is saved); 403 an advance without `payments.manage`; 403 `feature_off` (`feature: "advances"`) an advance while Advances & deposits is switched off (nothing is saved: no pre-order, no new guest, no number used; without an advance, or with an amount of 0, the pre-order is booked); 404 guest not found; 404 a dish or size not on the menu. The till's other refusals of the advance come back in `advanceRefused`, not as an error.

#### `POST /api/preorders/:id/advance`
Permission: `payments.manage`
Body: `amount` (required, 1-10,000,000), `paymentMethod` (required: cash, card, upi, online, wallet, other), `paymentTypeId`, `transactionRef` (100).
Returns: 201, `data` = the pre-order with its `advanceReceipt`. The advance's purpose is "Pre-order PRE-…".
Errors: 400 no amount; 403 `feature_off` (`feature: "advances"`) while Advances & deposits is switched off, for any pre-order, another outlet's included, as it is checked before the pre-order is looked up (nothing is taken); 404 pre-order not found, or (for staff tied to an outlet) another outlet's or the main counter's; 409 the pre-order is collected or cancelled; 409 it already has its advance; plus the errors of `POST /api/bills/advances` (no business day open, payment-type errors).

#### `POST /api/preorders/:id/status`
Permission: `orders.create`
Body: `status` (required: `in_production` or `ready`). A booked pre-order may go to either; one in production goes to ready. The same status again changes nothing.
Returns: `data` = the pre-order.
Errors: 404 pre-order not found, or (for staff tied to an outlet) another outlet's or the main counter's; 409 the move is not allowed.

#### `POST /api/preorders/:id/cancel`
Permission: `orders.manage`
Body: `reason` (required, 300).
Returns: `data` = the pre-order (cancelled). The advance is not handed back here: the message names its receipt, to refund from Dues & accounts › Advances (`POST /api/bills/advances/:id/refunds`).
Errors: 400 no reason; 404 pre-order not found, or (for staff tied to an outlet) another outlet's or the main counter's; 409 already collected or cancelled.

#### `POST /api/preorders/:id/collect`
Permission: `orders.create`
Body: none.
Returns: 201, `data` = `{ preorder, orderId, orderNumber }`. A takeaway order (source `pos`) opens on today's business day at the request's outlet (else the pre-order's), with the pre-order's items and messages and the note "Pre-order PRE-…"; the advance is tied to it. The order is then billed as usual. Collecting again returns the pre-order and its order id.
Errors: 404 pre-order not found, or (for staff tied to an outlet) another outlet's or the main counter's; 409 cancelled; plus the errors of `POST /api/orders` (no business day open, a dish taken off the menu or sold out, takeaway not taken by the POS).

### Table requests (QR orders, calls and online orders, staff side)

Mounted at `/api/table-requests` (tableRequest.routes.js). The user must be signed in, and `resolveOutlet` runs. The inbox is scoped to the request's outlet, plus tables that belong to no outlet. A request from another outlet answers 404. The inbox also holds orders from the online ordering page (`channel: "website"`, with no table). The request shape is `{ id, type (order, call_waiter, bill, water, other), status, tableId, tableNo, channel (qr, website), serviceType, deliveryAddress, paymentMode, deliveryCharge, outletId, guestName, guestMobile, notes, itemCount, estimatedTotal, items[], orderId, orderNumber, orderAction, rejectReason, repeatCount, acknowledgedAt, resolvedAt, askedBy, askedByName, createdAt, fromEarlierDay, responseSeconds, tableOrder }`. `askedBy` and `askedByName` name the waiter who asked for a table's bill from the captain app (null for a guest's own request). `guestMobile` is masked for users without `customers.contact`. A bad `:id` answers 404 "Request not found".

#### `GET /api/table-requests`
Permission: `orders.view`
Query: `view` (`pending` default, `today`, `history`, `all`), `type` (order, service, online), `limit` (whole number, 1-500, default 200), `offset`, `from`, `to` (YYYY-MM-DD).
Returns: `data` = `{ items[] (each with `captain`: its table's captain of the day, `{ userId, userName }`, or null, as `GET /api/tables` gives it), total, limit, offset, from, to, serverTime, since }`.
Errors: 400 a bad filter, or `from` is after `to`.

#### `GET /api/table-requests/summary`
Permission: `orders.view`
Returns: `data` = `{ pendingOrders, oldestOrderAt, openCalls, unansweredCalls, oldestCallAt, openCallsByType, ordersToday, acceptedToday, acceptedValueToday, rejectedToday, callsToday, callsDoneToday, avgResponseSeconds, serverTime, since }`. `acceptedValueToday` is left out for users without `sales.view`.

#### `GET /api/table-requests/settings`
Permission: `orders.view`
Returns: `data` = `{ orderingEnabled, callsEnabled, guestNote, updatedAt }`.

#### `PUT /api/table-requests/settings`
Permission: `orders.manage`
Body: `orderingEnabled`, `callsEnabled` (booleans, default true), `guestNote` (200).
Returns: `data` = the settings.

#### `POST /api/table-requests/close-earlier`
Permission: `orders.manage`
Body: `reason` (200; the guest sees it; default "Not taken: sent on an earlier day").
Returns: `data` = `{ rejected, done, skipped }`. Every order still pending from an earlier day is rejected with the reason, and every call still open from an earlier day is marked done: in the request's outlet (plus tables of no outlet), for the channels switched on, at most 2,000 at a time. One that cannot be closed (another device answered it meanwhile) is counted in `skipped`. The message says what was closed.
Errors: 400 `reason` is not text or is too long.

#### `POST /api/table-requests/bill-asks`
A waiter asks the counter for a table's bill (the captain app): the table's bill request, as a guest's *Request bill* makes it from the QR code, marked as asked by the caller (`created_by`). While the table's bill request is still open (pending or on the way), a second ask is counted on it (`repeatCount`, `lastAskedAt`) rather than made again; the same `clientKey` gives back the same request.
Permission: `orders.create`; feature `qr_ordering` (the inbox shows a table's requests only while QR ordering is on)
Body: `tableId` (required), `clientKey` (required; 8 to 64 letters, digits or hyphens, this tap's own).
Returns: 201 and `data` = the request for a new one; 200 for the same key again or a second ask. Logged (`ask_bill` `table_request`), except a repeat of the same key.
Errors: 400 `tableId` or `clientKey` missing or malformed; 403 without `orders.create`; 403 `{ reason: "feature_off", feature: "qr_ordering" }`; 404 table not found (in this outlet); 409 no order running on the table; 409 the table's bill is already raised; 409 the key was used for another kind of request.

#### `GET /api/table-requests/:id`
Permission: `orders.view`
Returns: `data` = the request.
Errors: 404 request not found.

#### `POST /api/table-requests/:id/accept`
Permission: `orders.create`
Body: none.
Returns: `data` = `{ request, order: { id, orderNumber, totalAmount, itemCount }, action (created, added) }`. A QR order opens the table's order, or is added to the order already running there. A website order creates a takeaway or delivery on the Website channel at the link's selling point.
Errors: 400 the request is a call, not an order; 409 already handled (says who and how); 409 `earlier_day`; 409 the request has no dishes, a dish was removed from the menu, or the table is not in use; 409 the Website channel is off; 409 an order number clash (press Accept again); plus the order-creation errors (table busy, no business day, and so on). The claim is released on any failure.

#### `POST /api/table-requests/:id/reject`
Permission: `orders.create`
Body: `reason` (required, 200). The guest sees it.
Returns: `data` = the request.
Errors: 400 the request is a call; 409 already handled; 404 request not found.

#### `POST /api/table-requests/:id/acknowledge`
Permission: `orders.view`
Body: none. Calls only.
Returns: `data` = the request.
Errors: 400 the request is an order; 409 already handled; 404 request not found.

#### `POST /api/table-requests/:id/done`
Permission: `orders.view`
Body: none. Calls only.
Returns: `data` = the request.
Errors: 400 the request is an order; 409 already handled; 404 request not found.

### Reservations and waitlist

Mounted at `/api/reservations` (reservation.routes.js). The user must be signed in, and `resolveOutlet` runs. A booking's outlet comes from the user or the outlet switcher, never from the body. The booking shape (`toBooking`) is `{ id, reference, customerId, customerName, customerPoints, guestName, guestMobile, partySize, date, startTime, endTime, durationMinutes, tableId, tableNo, tables[], extraTables[], tableOutOfService, capacityOverride, occasion, specialRequests, source, internalNotes, status, cancelReason, outletId, orderId, orderNumber, orderStatus, confirmedAt, seatedAt, ... }`. Statuses are requested, booked, confirmed, seated, completed, cancelled, no_show and declined. `customerPoints` is null for users without `customers.view`. `guestMobile` is masked on lists and the board for users without `customers.contact`. One booking (GET, create, update, accept) also shows the full mobile to `reservations.manage`. A masked mobile sent back on an update means "unchanged". Ids must be whole numbers, else 400.

#### `GET /api/reservations/day`
Permission: `reservations.view`
Query: `date` (YYYY-MM-DD, default today in the restaurant's time zone).
Returns: `data` = `{ date, today, isToday, timezone, now, nowMinutes, lateAfterMinutes, hours, week[], outlook[7], bookings[], requests[], tables[], summary, waitlist: { waiting[], recent[], unclosed[], ... } }`.
Errors: 400 the date is not valid.

#### `GET /api/reservations/availability`
Permission: `reservations.view`
Query: `now=true`, or `date` and `time` (HH:MM) (both required otherwise); `duration` (30-360, default 90), `partySize` (1-50), `excludeId`.
Returns: `data` = `{ date, startTime, endTime, durationMinutes, partySize, suggestedTableId, tables: [{ ...table, fit (free, clash, small, closed, occupied, cleaning), inUse, clash }] }`.
Errors: 400 the date or time is not valid.

#### `GET /api/reservations/guest`
Permission: `reservations.view`
Query: `mobile` (required, the whole number), `excludeId`.
Returns: `data` = `{ mobile, customer: null | { id, name } (plus mobile, loyaltyPoints, visits and lastVisit with `customers.view`), record: { bookings, completed, noShows, cancelled, lastVisit } }`.
Errors: 400 no readable mobile.

#### `GET /api/reservations/requests`
Permission: `reservations.view`
Returns: `data` = `{ items[] (bookings with status requested), total }`. Requests whose time has passed are expired first.

#### `GET /api/reservations/online-settings`
Permission: `reservations.view`
Returns: `data` = `{ outletId, placeName, token, path ("/book/<token>"), guestWebAddress, url, isEnabled, maxPartySize, seatSharePercent, minNoticeMinutes, daysAhead, durationMinutes, maxOpenPerMobile, blockedDates[], guestNote, updatedAt, room: { tables, seats, largest, onlineSeats }, hoursSet }`. `url` is the whole booking link: `path` at the restaurant's `guestWebAddress`, else at the guests' site's own address (`GUEST_WEB_URL`), else null (a developer's machine without one; the staff app then builds it from its own setting). These settings belong to the request's selling point. The row is created on first read.

#### `PUT /api/reservations/online-settings`
Permission: `reservations.online`
Body (all required except as noted): `isEnabled` (boolean, default false), `maxPartySize` (1-50), `seatSharePercent` (10-100), `minNoticeMinutes` (0-1440), `daysAhead` (1-180), `durationMinutes` (30-360), `maxOpenPerMobile` (1-10), `blockedDates[]` (YYYY-MM-DD, at most 60), `guestNote` (300). All numbers are whole numbers.
Returns: `data` = the online settings.
Errors: 400 switching on with no opening hours set, or with no tables in use at this place; 400 a field is out of range.

#### `POST /api/reservations/online-settings/new-link`
Permission: `reservations.online`
Body: none.
Returns: `data` = the settings with a new `token` (128 bits, hex). The old link stops working. Guests' status links keep working.

#### `POST /api/reservations/waitlist`
Permission: `reservations.manage`
Body: `guestName` (required, 150), `partySize` (required, 1-50), `guestMobile`, `customerId`, `quotedMinutes` (0-240, default 15), `notes` (300).
Returns: 201, `data` = `{ id, guestName, guestMobile, partySize, quotedMinutes, notes, status, joinedAt, notifiedAt, tableNo, orderNumber, ... }`.
Errors: 400 a masked mobile was sent; 400 the linked guest is not in the guest book; 409 the same mobile is already waiting.

#### `PUT /api/reservations/waitlist/:id`
Permission: `reservations.manage`
Body: same as add.
Returns: `data` = the entry.
Errors: 404 entry not found; 409 the guest has just left the waitlist.

#### `PATCH /api/reservations/waitlist/:id/notify`
Permission: `reservations.manage`
Body: none. Records that the guest was told their table is ready.
Returns: `data` = the entry.
Errors: 404 entry not found; 409 the guest is not waiting (already seated, left or removed).

#### `PATCH /api/reservations/waitlist/:id/left` and `PATCH /api/reservations/waitlist/:id/remove`
Permission: `reservations.manage`
Body: none. Sets the status to `left` or `removed`.
Returns: `data` = the entry.
Errors: 404 entry not found; 409 the guest is not waiting.

#### `POST /api/reservations/waitlist/:id/seat`
Permission: `reservations.manage` and `orders.create`
Body: `tableId` (required), `overrideCapacity`, `overrideClash` (booleans).
Returns: `data` = `{ entry, order }`. An empty dine-in order is opened on the table.
Errors: 400 no table, the table does not exist, or it is not in use or closed; 409 the guest is not waiting; 409 the table is occupied, being cleaned or booked soon (send `overrideClash`); 409 no business day is open; 400 the party is over capacity (send `overrideCapacity`).

#### `GET /api/reservations`
Permission: `reservations.view`
Query: `search` (100), `from`, `to` (YYYY-MM-DD), `status` (comma-separated statuses), `limit` (1-200, default 50).
Returns: `data` = `{ items[], total, limit }`. Settled bookings are completed first.

#### `POST /api/reservations`
Permission: `reservations.manage`
Body: `guestName` (required, 150), `partySize` (required, 1-50), `date` (required, YYYY-MM-DD, years 2000-2100), `startTime` (required, HH:MM), `durationMinutes` (30-360, default 90), `guestMobile`, `customerId`, `tableId`, `extraTableIds[]` (at most 8, needs `tableId`), `overrideCapacity`, `capacityOverrideReason` (200), `occasion` (birthday, anniversary, business, date_night, other), `specialRequests` (500), `source` (phone default, walk_in, online, app, other), `internalNotes` (500).
Returns: 201, `data` = the booking.
Errors: 400 the time has passed, or is more than a year ahead; 400 outside opening hours, or the restaurant is closed that day; 400 the table does not exist, is not in use, is closed, or is too small (`capacity` or `capacity_reason_required` for several tables); 400 extra tables sent without a main table; 409 the table is already booked for that slot.

#### `GET /api/reservations/:id`
Permission: `reservations.view`
Returns: `data` = the booking plus `history[]` (`{ action, userName, details, at }`) and `guestRecord` (`{ bookings, completed, noShows, cancelled, lastVisit }` or null).
Errors: 404 booking not found (or it belongs to another outlet).

#### `PUT /api/reservations/:id`
Permission: `reservations.manage`
Body: the same fields as create, sent as a whole booking. Leaving out `extraTableIds` keeps the current ones.
Returns: `data` = the booking.
Errors: 409 the booking is not requested, booked or confirmed; 400 a table was sent on an unanswered online request (accept it instead); plus the checks from create (date and hours are checked only when the date or time moved).

#### `PATCH /api/reservations/:id/confirm`
Permission: `reservations.manage`
Body: none. Moves the booking from booked to confirmed.
Returns: `data` = the booking.
Errors: 409 the booking is not booked, or someone else changed it; 404 booking not found.

#### `PATCH /api/reservations/:id/accept`
Permission: `reservations.manage`
Body: `tableId`, `extraTableIds[]` (at most 8, needs `tableId`), `overrideCapacity`, `capacityOverrideReason` (200). Accepts an online request. With no table, the booking is confirmed without a table.
Returns: `data` = the booking (confirmed). The guest sees it on their status link.
Errors: 409 the booking is not requested; 409 the requested time has passed (decline it instead); 409 someone else answered first; plus the table and capacity checks from create.

#### `PATCH /api/reservations/:id/decline`
Permission: `reservations.manage`
Body: `reason` (required, 200). The guest reads it.
Returns: `data` = the booking (declined).
Errors: 409 the booking is not requested, or someone else answered first.

#### `PATCH /api/reservations/:id/cancel`
Permission: `reservations.manage`
Body: `reason` (required, 200).
Returns: `data` = the booking (cancelled).
Errors: 409 the booking is not booked or confirmed, or someone else changed it.

#### `PATCH /api/reservations/:id/no-show`
Permission: `reservations.manage`
Body: none.
Returns: `data` = the booking (no_show).
Errors: 409 the booking is not booked or confirmed; 409 its time has not come yet; 409 someone else changed it.

#### `PATCH /api/reservations/:id/complete`
Permission: `reservations.manage`
Body: none. This is for a seated party that left without a bill. A paid bill completes the booking by itself.
Returns: `data` = the booking (completed).
Errors: 409 the booking is not seated; 409 its order is still open or billed.

#### `POST /api/reservations/:id/seat`
Permission: `reservations.manage` and `orders.create`
Body: `tableId` (defaults to the booked table), `overrideCapacity`, `overrideClash`.
Returns: `data` = `{ booking, order, joinedTables[], notJoined: [{ tableNo, message }] }`. The order opens on the main table, and the booking's extra tables are joined to it.
Errors: 409 the booking is not booked, confirmed or no_show; 409 the booking is not for today; 400 no table, or the table is not valid; 409 the table is occupied, taken a moment ago, being cleaned, or booked soon (`overrideClash`); 409 `held_table_busy`; 409 no business day is open; 400 over capacity.

### Deliveries, riders and channels

Mounted at `/api/deliveries` (delivery.routes.js). The user must be signed in, and `resolveOutlet` runs. An `:orderId` that is a number and belongs to another outlet answers 404 "Order not found in this outlet". The delivery shape (`toDelivery`) is `{ id, orderNumber, orderStatus, kitchenStatus, kitchenOpenTickets, status (preparing, ready, out_for_delivery, delivered, cancelled), customerName, customerMobile, address, landmark, channel, commissionPercent, rider: { id, name, mobile } | null, partnerRiderName, externalRef, etaMinutes, promisedBy, placedAt, readyAt, dispatchedAt, deliveredAt, cancelReason, items[], amount, billed, billNumbers, paidAmount, dueAmount, paymentState, ... }`. Money figures need `sales.view`. Full mobiles on the board need `customers.contact`.

#### `GET /api/deliveries/board`
Permission: `orders.view`
Query: `date` (YYYY-MM-DD, an earlier business date; default the open days).
Returns: `data` = `{ businessDate, dayOpen, todayDate, viewingDate, timezone, currency, serverTime, slaMinutes, warnMinutes, readyWaitMinutes, outWarnMinutes, outCriticalMinutes, showsMoney, orders[], totalOrders, shownOrders, truncated, riders[], channels[], untaggedCount, stats }`. Finished orders are summarised. Mobiles are masked for users without `customers.contact`.
Errors: 400 the date is not valid.

#### `GET /api/deliveries/summary`
Permission: `orders.view`
Returns: `data` = `{ businessDate, dayOpen, currency, slaMinutes, stats, ridersFree, ridersOnRun, channels: [{ id, name, color, orders }] }`. Money appears in `stats` only with `sales.view`.

#### `POST /api/deliveries/dispatch`
Permission: `orders.manage`
Body: `orderIds[]` (required, 1-12 orders), and either `riderId` (an employee in the delivery department) or `partnerRiderName` (100), not both.
Returns: `data` = `{ orders[] (deliveries), riderName }`. Kitchen tickets still open for the orders are bumped.
Errors: 400 no orders, more than 12, or both a rider and a partner name; 400 the rider is not on staff, not in the delivery team, or inactive; 400 an order has no rider or no address; 404 an order was not found; 409 an order is not a delivery, not packed yet, or not in a state that can move on.

#### `GET /api/deliveries/report`
Permission: `reports.view` and `sales.view`
Query: `from`, `to` (YYYY-MM-DD). `to` defaults to the open business date and `from` to six days before it. The range is at most a year. The report follows the request's outlet.
Returns: `data` = rows per channel, each with `{ orders, bills, gross, commission, net, averageOrderValue, effectiveRate, delivery: { orders, delivered, cancelled, avgDoorMinutes, avgRideMinutes, onTime, onTimeRate } }`, with totals reconciled to the sales report. The full shape is `report` in delivery.service.js.
Errors: 400 a date is not valid, the start is after the end, or the range is longer than a year.

#### `GET /api/deliveries/riders/:riderId/settlement`
Permission: `orders.manage` and `payments.manage`
Returns: `data` = `{ rider: { id, name, mobile }, bills: [{ billId, billNumber, orderId, orderNumber, customerName, deliveredAt, businessDate, total, paid, due }], cashExpected, unbilled: [{ orderId, orderNumber, amount, deliveredAt }] }`. These are delivered orders whose bills are unpaid or partly paid, in the request's outlet.
Errors: 404 rider not found.

#### `POST /api/deliveries/riders/:riderId/settle`
Permission: `orders.manage` and `payments.manage`
Body: `bills[]` (required, 1-200, each `{ billId, method (cash, upi), upiRef? (60) }`, each bill once), `cashHanded` (required, 0-10000000), `shortfallReason` (200; required when the cash is short).
Returns: 201, `data` = `{ id, outletId, businessDate, riderId, riderName, billCount, cashExpected, cashHanded, upiAmount, shortfall, shortfallAction (none, owed), shortfallReason, settledAt, settledByName, bills[] }`. Every bill is paid in one transaction, into the cashier's drawer for the open day. A shortfall is recorded as owed by the rider.
Errors: 400 the cash counted is more than the cash bills come to; 400 the cash is short and no reason was given; 409 a bill is not waiting for this rider (paid at another till meanwhile), or the bills were settled at another till; 409 no business day is open; 409 cash that would reach the cash limit for a bill or for the named guest's day, or a bill over ₹2,00,000 with no buyer's PAN (nothing is settled); 404 rider not found.

#### `POST /api/deliveries/riders/:riderId/settle-write-off`
Permission: `orders.manage` and `payments.manage`, and `deliveries.write_off_shortfall` or manager approval (the scope is `{ amount }`, the shortfall worked out from the bills before any PIN is asked for)
Body: same as settle. A shortfall and `shortfallReason` are required.
Returns: 201, `data` = the settlement with `shortfallAction: "written_off"` and `approvedByName`.
Errors: same as settle, plus 400 nothing is short, so there is nothing to write off.

#### `GET /api/deliveries/rider-settlements`
Permission: `payments.manage`
Query: `date` (YYYY-MM-DD, default the open business date), `page` (from 1), `pageSize` (25, 50 or 100; default 25).
Returns: `data` = `{ date, page, pageSize, total, totals: { settlements, bills, cashExpected, cashHanded, upiAmount, shortfall }, items[] (settlements), owed[] (every shortfall riders still owe) }`.
Errors: 400 a bad date, page or page size.

#### `POST /api/deliveries/rider-settlements/:id/repaid`
Permission: `payments.manage`
Body: none.
Returns: `data` = the settlement with `repaidAt` and `repaidByName` set.
Errors: 404 settlement not found (or it belongs to another outlet); 409 already marked as handed over, or nothing is owed.

#### `GET /api/deliveries/channels`
Permission: `orders.view`
Returns: `data` = `[{ id, name, type (own, aggregator, phone, website), commissionPercent, deliveryCharge, deliveryFreeAbove, color, sortOrder, status, ordersTotal, ordersToday, orders30d, gross30d }]`.

#### `POST /api/deliveries/channels`
Permission: `restaurant.settings.manage`
Body: `name` (required, 60), `type` or `channelType` (required: own, aggregator, phone, website), `commissionPercent` (0-50), `color` (orange, red, amber, green, teal, blue, violet, pink, slate; the default depends on the type), `sortOrder` (whole number, 0-9999), `status` (active, inactive), `deliveryCharge` (0-10000), `deliveryFreeAbove` (greater than 0, or null to always charge).
Returns: 201, `data` = the channel.
Errors: 409 a channel with that name already exists.

#### `PUT /api/deliveries/channels/:id`
Permission: `restaurant.settings.manage`
Body: same as create. A delivery charge field that is left out stays as it is.
Returns: `data` = the channel.
Errors: 404 channel not found; 409 duplicate name.

#### `DELETE /api/deliveries/channels/:id`
Permission: `restaurant.settings.manage`
Returns: no `data`. The response carries a message only.
Errors: 404 channel not found; 409 the channel is on orders (switch it off instead); 409 it is the last channel.

#### `GET /api/deliveries/:orderId`
Permission: `orders.view`
Returns: `data` = the delivery, with the full mobile.
Errors: 400 the id is not a whole number; 404 order not found; 409 the order is not a delivery.

#### `PATCH /api/deliveries/:orderId`
Permission: `orders.manage`
Body (only the keys present change; null clears a field): `address` (500), `savedAddressId` (one of the guest's saved addresses; the server copies its full text), `addressLabel` (30; saves a new address on the guest under this label), `landmark` (200), `channelId`, `riderId`, `partnerRiderName` (100), `externalRef` (60), `etaMinutes` (whole number, 5-240), `customerName` (150), `customerMobile` (20, phone characters).
Returns: `data` = the delivery.
Errors: 400 nothing to change, or both a rider and a partner name; 400 the saved address is not this guest's; 400 the rider or channel is not valid, or the channel is switched off; 409 the delivery is cancelled; 409 clearing the rider or address of an order that is out or delivered; 404 order not found; 409 the order is not a delivery.

#### `PATCH /api/deliveries/:orderId/status`
Permission: `orders.manage`
Body: `status` (required: preparing, ready, out_for_delivery, delivered, cancelled), `riderId` or `partnerRiderName`, `reason` (200; required for cancelled), `confirmPacked` (boolean). Sending `out_for_delivery` for a delivered order undoes the delivered mark.
Returns: `data` = the delivery plus `billStillLive` (true after a cancellation that leaves a live bill).
Errors: 400 cancelled with no reason; 409 the move is not allowed (already in that state, cancelled, delivered, or not dispatched yet); 409 `needsConfirmation: "confirmPacked"` (`data.openTickets`) when marking ready while the kitchen display still shows open tickets; 409 an undo with no rider or no dispatch time on record; plus the rider checks from dispatch.

### Public guest pages (no login)

Mounted at `/api/public` (public.routes.js, publicBooking.routes.js, publicOnline.routes.js). These routes take no `Authorization` header and no `X-Outlet-Id`. The API answers them from any web address (CORS allows every origin under `/api/public`; they need no login and carry no cookies), so a restaurant can point its own domain at the guests' site; every other route answers only the addresses in `CORS_ORIGIN`, the staff app. Each request is scoped only by the token in its path. Every response sets `Cache-Control: no-store`. A token that is malformed, unknown, or replaced, or that belongs to a table, floor, section, outlet or restaurant that is not active, gets the same 404 sentence, so callers learn nothing about which case it was. Any price sent by a phone is ignored, and orders are priced from the menu.

Rate limits use express-rate-limit with its in-memory store, counted per API process, so several processes are only more lenient. These routes do not use backend/src/middlewares/rateLimiters.js (login, password and PIN only). Address limits are keyed on `req.ip`, which honours `TRUST_PROXY` through `app.set("trust proxy")`. A limited request gets 429 `{ success: false, message }` with draft-8 `RateLimit` and `RateLimit-Policy` headers. The database rules hold however the counters are set: at most 3 orders waiting per table, the online link's "open orders per mobile", and the booking link's "open bookings per mobile".

| Route | Limits (window: count) | Key |
|---|---|---|
| `GET tables/:token/menu` | address 1 min: 3000; table 1 min: 40 | IP; `table:<token>` |
| `GET tables/:token/requests`, `GET tables/:token/requests/:id` | address 1 min: 3000; table 1 min: 150 | IP; token |
| `POST tables/:token/orders` | address 10 min: 600 (shared by all table writes); table 10 min: 8 | IP; token |
| `POST tables/:token/requests/:id/cancel` | address 10 min: 600; table 10 min: 10 | IP; token |
| `POST tables/:token/calls` | address 10 min: 600; table 10 min: 15 | IP; token |
| `POST tables/:token/feedback` | address 10 min: 600; table 60 min: 5 | IP; token |
| `GET booking/:token`, `GET booking/:token/times`, `GET booking/status/:guestToken` | address 1 min: 600 | IP |
| `POST booking/:token/requests` | address 10 min: 30; link 10 min: 40; mobile 60 min: 5 | IP; `link:<token>`; last 10 digits of `guestMobile` |
| `POST booking/status/:guestToken/cancel` | address 10 min: 30 | IP |
| `GET online/:token/menu` | address 1 min: 3000 | IP |
| `POST online/:token/orders` | address 10 min: 30; mobile 30 min: 5 | IP; normalised `guestMobile` (or the link when the number cannot be read) |
| `GET online/:token/orders/:guestToken` | address 1 min: 3000; order 1 min: 60 | IP; `online-order:<guestToken>` |
| `POST online/:token/orders/:guestToken/cancel` | address 10 min: 200; order 10 min: 10 | IP; guestToken |

The address limits are not shared between groups. The two `GET tables/...` limits of 3000 are one counter, but the booking and online limits are separate instances, each counted on its own.

Token rules:
- Table QR token: `[A-Za-z0-9_-]{16,64}` (128 random bits), resolved to the table.
- Booking link token: `[A-Za-z0-9_-]{16,64}` (issued as 32 hex characters, 128 bits).
- Booking guest token: `[A-Za-z0-9_-]{24,64}` (issued as 24 random bytes in base64url, 192 bits).
- Online ordering link token: `[a-f0-9]{32,64}`.
- Online order guest token: exactly 48 hex characters (192 bits).

On the guest-token routes, the `:token` in the path is not checked, so a replaced link does not lose a guest their order.

#### `GET /api/public/tables/:token/menu`
Permission: public, rate limited
Query: none.
Returns: `data` = `{ restaurant: { name, currencySymbol, taxMode, serviceChargePercentage }, table: { tableNo, floorName, areaName }, ordering: { enabled, reason, callsEnabled, note, maxLines: 30, maxQuantity: 20 }, offers, categories[] }`. The menu is dine-in, priced by the selling rules of the table's outlet. Ordering is disabled when QR ordering is off or no business day is open.
Errors: 404 the table was not found (the QR code may be out of date).

#### `POST /api/public/tables/:token/orders`
Permission: public, rate limited
Body: `clientKey` (required, `[A-Za-z0-9-]{8,64}`, idempotency key), `items[]` (1-30 lines; each `{ productId, variantId?, modifierIds?[] (at most 10), quantity (whole number, 1-20), comboSelections?, notes? (200) }`), `notes` (200), `guestName` (80), `guestMobile` (10-13 digits, optional).
Returns: 201, `data` = `{ id, type, status, stage, label, detail, final, orderNumber, notes, itemCount, itemsTotal, items[], repeatCount, createdAt, canCancel }`. This is a request waiting for staff. It does not reach the kitchen until a staff member accepts it. The same `clientKey` again returns 200 with the same request.
Errors: 400 bad input, a dish not on the menu or sold out, a size or add-on not valid, more than 20 of one dish, or more than 100 plates in total; 409 ordering is paused or no business day is open; 409 the table already has 3 orders waiting; 409 the `clientKey` was already used for something else.

#### `GET /api/public/tables/:token/requests`
Permission: public, rate limited
Query: `ids` (comma-separated request ids, at most 20). With no `ids`, the result is an empty list.
Returns: `data` = `[guest request]`. Only requests belonging to the table behind the token are returned.
Errors: 400 the ids cannot be read, or there are more than 20.

#### `GET /api/public/tables/:token/requests/:id`
Permission: public, rate limited
Returns: `data` = the guest request.
Errors: 404 no such request for this table (a bad id answers the same way).

#### `POST /api/public/tables/:token/requests/:id/cancel`
Permission: public, rate limited
Body: none. An order can be cancelled only while it is pending. A call can be cancelled while it is pending or acknowledged.
Returns: `data` = the guest request (cancelled).
Errors: 404 no such request for this table; 409 staff have already picked it up.

#### `POST /api/public/tables/:token/calls`
Permission: public, rate limited
Body: `type` (required: call_waiter, bill, water, other), `message` (120; required for `other`), `clientKey` (optional, same format as for orders).
Returns: 201 for a new call. 200 when an open call of the same type was repeated (a reminder) or the `clientKey` was resent. `data` = the guest request plus `repeated`.
Errors: 400 the type is unknown, or `message` is missing for `other`; 409 calls are switched off; 409 the `clientKey` is in use.

#### `POST /api/public/tables/:token/feedback`
Permission: public, rate limited
Body: `rating` (required, whole number, 1-5), `comment` (500), `name` (80), `mobile` (10-13 digits).
Returns: 201, `data` = `{ id }`. The feedback is stored in the restaurant's feedback book with source `qr` and the table number in the comment. An identical recent entry returns 200 with its id.
Errors: 400 a bad rating or field.

#### `GET /api/public/booking/status/:guestToken`
Permission: public, rate limited
Returns: `data` = `{ reference, status, statusLabel, tone, guestName, guestMobile (masked), partySize, date, dateLabel, startTime, timeLabel, occasion, notes, reason, requestedAt, answeredAt, canCancel, bookAgain (link token or null), place: { name, outletName, contact, address }, guestToken }`. A request whose time passed before anyone answered it is expired first.
Errors: 404 booking not found.

#### `POST /api/public/booking/status/:guestToken/cancel`
Permission: public, rate limited
Body: none.
Returns: `data` = the status view (cancelled).
Errors: 404 booking not found; 409 already cancelled, declined or finished; 409 the booking time has started; 409 the booking changed a moment ago.

#### `GET /api/public/booking/:token`
Permission: public, rate limited
Returns: `data` = `{ place, enabled, message, guestNote, maxPartySize, minNoticeMinutes, daysAhead, durationMinutes, today, days: [{ date, open, reason }] }`.
Errors: 404 the link is not in use.

#### `GET /api/public/booking/:token/times`
Permission: public, rate limited
Query: `date` (required, YYYY-MM-DD), `party` (required, 1-50).
Returns: `data` = `{ date, partySize, open, reason, slots: [{ time, label, meal, available, state (free, full) }] }`. Times already past, or inside the notice period, are left out.
Errors: 400 the date or party is not valid; 400 `party_too_big`; 409 `booking_off`; 404 the link is not in use.

#### `POST /api/public/booking/:token/requests`
Permission: public, rate limited
Body: `date` (required), `time` (required, HH:MM, one of the offered slots), `partySize` (required, 1-50), `guestName` (required, 2-80, must contain a letter), `guestMobile` (required, normalised), `occasion` (birthday, anniversary, business, date_night, other), `notes` (300), `website` (honeypot: must be empty).
Returns: 201, `data` = the status view plus `guestToken`. The booking is saved as a `requested` reservation, which staff accept or decline.
Errors: 400 bad input or the honeypot is filled; 400 `party_too_big`, `day_closed` or `not_a_time`; 409 `booking_off`, `too_soon`, `full` or `mobile_limit`; 409 several bookings arrived at the same moment (send again); 404 the link is not in use.

#### `GET /api/public/online/:token/menu`
Permission: public, rate limited
Query: `service` (takeaway or delivery; defaults to the first one the link offers).
Returns: `data` = `{ restaurant: { name, currencySymbol, taxMode }, place: { name, address, phone }, ordering: { enabled, reason, services[], service, note, pickupMinutes, deliveryMinutes, minDeliveryOrder, deliveryArea, maxOpenPerMobile, maxLines: 30, maxQuantity: 20, paymentModes[], onlinePayment: { available: false, note } }, delivery: { charge, freeAbove }, hours: { known, today[], openNow, nextOpensAt }, offers, categories[] }`. The menu is priced on the Website channel for the chosen service. Ordering is disabled when the link or the Website channel is off, outside serving hours, or when no business day is open.
Errors: 404 the ordering page was not found.

#### `POST /api/public/online/:token/orders`
Permission: public, rate limited
Body: `clientKey` (required, idempotency key), `service` (required: takeaway or delivery), `paymentMode` (required: `pay_at_pickup` for takeaway, `cash_on_delivery` for delivery; `online` is refused), `items[]` (1-30 lines, the same shape as a table order; at most 60 plates), `guestName` (required, 2-80), `guestMobile` (required, a 10-digit Indian mobile), `address` (10-500; required for delivery), `landmark` (200), `notes` (200).
Returns: 201 (200 for a resent `clientKey`), `data` = `{ guestToken, order: { restaurant, status, stage, label, detail, final, serviceType, steps[], paymentMode, orderNumber, tokenNo, guestName, address, landmark, notes, items[], itemCount, itemsTotal, deliveryCharge, total, createdAt, canCancel } }`. This is a request in the staff inbox until staff accept it.
Errors: 400 bad input, the service is not offered, the payment mode does not match, the address is missing, the delivery minimum is not met, or a dish is not available; 409 not taking orders now (the reason is given); 409 this mobile already has the maximum number of open orders.

#### `GET /api/public/online/:token/orders/:guestToken`
Permission: public, rate limited
Returns: `data` = the guest order view (as above). `stage` is one of sent, accepted, ready, out, delivered, collected, rejected or cancelled.
Errors: 404 order not found.

#### `POST /api/public/online/:token/orders/:guestToken/cancel`
Permission: public, rate limited
Body: none. The order can be cancelled only while it is pending.
Returns: `data` = the guest order view (cancelled).
Errors: 404 order not found; 409 already cancelled, or the restaurant has already picked it up.

---

## Back-office rules: stock, purchasing and expenses

### Approvals in this section (what a manager's token is tied to)

Three back-office steps use the shared manager-approval flow (`X-Approval-Token`, see the intro). For each, the 403 `approval_required` body carries a `scope`, and the token must have been issued for those same facts (`approval.service.js` `SCOPE_FIELDS` / `normaliseScope`). An `id` fact must match exactly. An `upTo` fact (`amount`, `quantity`) may come in lower than approved but never higher. A token is spent when it is used. It is not handed back if the action then fails.

| Step | Routes | Permission that skips the prompt | When it is asked for | `scope` sent and checked |
|---|---|---|---|---|
| Large write-off: stock item | `POST /api/inventory/movements/out`, `POST /api/inventory/items/:id/stock-out`, `POST /api/inventory-insights/wastage`, `POST /api/inventory-insights/items/:itemId/wastage` | `inventory.approve_writeoff` | value at cost > `writeoffApprovalLimit` (Stock & purchasing settings); no limit set = never | `{ inventoryItemId, quantity, amount }`. The **stock item** is bound whichever route carries it (path or body) |
| Large write-off: dish | `POST /api/inventory-insights/dish-waste` | `inventory.approve_writeoff` | recipe value > `writeoffApprovalLimit` | `{ productId, quantity (plates), amount }` |
| Large write-off: stock count | `POST /api/inventory/counts/:id/post` | `inventory.approve_writeoff` | the count's **shortage** value at cost > `writeoffApprovalLimit`. Surpluses on other lines do not offset it | `{ stockCountId, amount }` (no quantity) |
| Purchase order over the limit | `POST /api/purchase-orders/:id/approve`, `POST /api/purchase-orders/:id/reject` | `purchasing.approve` | the order is `pending_approval` | `{ purchaseOrderId, amount }`, where `amount` is the order's `totalAmount` |
| Void a paid purchase bill | `POST /api/purchase-orders/receipts/:receiptId/void` | `purchasing.pay` | the bill has a posted payment. No approval is needed for an unpaid bill | no scope; the token is tied to the user, the permission and the request |

`writeoffApproval` (`backend/src/middlewares/writeoffApproval.js`) first runs the action's own checks (item, quantity, stock on the shelf, reason). Any refusal therefore comes back before a PIN is asked for. It then compares the value with the limit and only then calls the approval gate. The prompt's `action` text is "make a large write-off" / "approve a large purchase order" (registered in `stockSettings.service.js`).

**Outlet pinning.** Inventory, purchase orders, purchase returns, insights and expenses run `resolveOutlet`. A user tied to one outlet (`req.outletPinned`) only sees and changes their own outlet's store. That is the outlet's own store, or the main store if the outlet sells from it. If they name another store they get 403 "You are set up to work at one outlet only…", and another store's sheet, note or entry answers 404. Suppliers do not run `resolveOutlet`.

**Blind counts.** Callers without `inventory.manage` cannot see stock figures for items on an open blind count. In items, movements, balances, stores and valuation those figures come back as `null` with `stockHidden: true`, or `expectedHidden: true` on a count sheet.

---

## Suppliers

### Suppliers
Mounted at `/api/suppliers`. Scoped to the user's restaurant. A supplier is unique by name or code.

#### `GET /api/suppliers/import-guide`
Permission: `suppliers.manage`
Query/Body: none
Returns: `data` = `{ maxRows: 2000, columns[{ key, label, need, help, example }], sample{ columns[], rows[][] } }`.

#### `POST /api/suppliers/import`
Permission: `suppliers.manage`
Query/Body: `rows` (array of `{ heading: cell }`, required, 1 to 2000), `dryRun` (boolean, default false), `fileName` (string ≤200), `fingerprint` (string ≤100, from the dry run's answer)
Returns: `data` = `{ ok, problems[], rows[], created, updated, unchanged, columns, fingerprint, createdSuppliers? }`. A dry run answers 200 even when there are problems (`ok: false`). Rows are matched to existing suppliers and either created or updated.
Errors: 400 no rows, over 2000 rows, or a row is not an object; 400 `success:false` with `data` on a real import whose file has problems (nothing written); 409 `data.reason: "stale_preview"` when `fingerprint` does not match (the data changed after the dry run).

#### `GET /api/suppliers`
Permission: any of `suppliers.view`, `purchasing.view`, `purchasing.manage`, `purchasing.receive`
Query/Body: none
Returns: `data` = array of `{ id, name, code, contactPerson, mobile, email, address, gstNumber, paymentTerms, creditDays, status, orderCount, billCount, lastBillDate }`. Without `suppliers.view` each row is the short form the order and bill forms pick from, `{ id, name, code, gstNumber, creditDays, status, lite: true }`: no contacts, terms or bill history.

#### `POST /api/suppliers`
Permission: `suppliers.manage`
Query/Body: `name` (string ≤150, required), `code` (≤30, upper-cased), `contactPerson`, `mobile` (≤20), `email`, `address` (≤500), `gstNumber` (15-character GSTIN, e.g. `37ABCDE1234F1Z5`), `paymentTerms` (≤100), `creditDays` (0 to 365; drives due dates), `status` (`active`|`inactive`)
Returns: `data` = the supplier; 201.
Errors: 400 bad GSTIN; 409 name or code already exists.

#### `PUT /api/suppliers/:id`
Permission: `suppliers.manage`
Query/Body: same body as create (full replace)
Returns: `data` = the supplier.
Errors: 404 not found; 409 duplicate name or code.

#### `DELETE /api/suppliers/:id`
Permission: `suppliers.manage`
Query/Body: none
Returns: message only.
Errors: 404; 409 when the supplier has orders, bills, returns, payments or expenses on record (set it inactive instead).

---

## Inventory

All under `/api/inventory`, with `resolveOutlet`. Quantities are in the item's base unit. A store is named by its outlet id, and `null` / `"main"` means the main store.

### Settings (Stock & purchasing)

#### `GET /api/inventory/settings`
Permission: any of `inventory.view`, `purchasing.view`, `restaurant.settings.view`
Query/Body: none
Returns: `data` = `{ poApprovalLimit, writeoffApprovalLimit, transferReceiptRequired, updatedAt, updatedByName }`. A `null` limit means no limit.

#### `PUT /api/inventory/settings`
Permission: `restaurant.settings.manage`
Query/Body: `poApprovalLimit` (number > 0 and ≤ 99,999,999, or blank/null for no limit; compared against the order total before GST), `writeoffApprovalLimit` (same rules; compared against write-off value at cost), `transferReceiptRequired` (boolean, default false: when true, transfer notes stay `in_transit` until the receiving store confirms them). All three fields are saved every time.
Returns: `data` = the saved settings.
Errors: 400 a limit of 0 ("Leave it blank for no limit").

### Units

#### `GET /api/inventory/units`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = array of `{ id, name, shortName, status, itemCount }`.

#### `POST /api/inventory/units`
Permission: `inventory.manage`
Query/Body: `name` (≤50, required), `shortName` (≤10, required), `status` (`active`|`inactive`)
Returns: `data` = the unit; 201.
Errors: 409 a unit with that name already exists.

#### `PUT /api/inventory/units/:id`
Permission: `inventory.manage`
Query/Body: same as create
Returns: `data` = the unit.
Errors: 404; 409 duplicate name.

#### `DELETE /api/inventory/units/:id`
Permission: `inventory.manage`
Query/Body: none
Returns: message only.
Errors: 404; 409 when items use the unit.

### Stock items, packs and prepared-item recipes
Items are raw or prepared. A prepared item has its own recipe and is made by production. Packs (for example Tin = 15 L) are buying units that convert to the base unit. Every stock change is written as a movement in the ledger.

#### `GET /api/inventory/items/import-guide`
Permission: `inventory.manage`
Query/Body: none
Returns: `data` = `{ maxRows: 2000, columns[], sample }`. Columns cover name, code, unit, category, storage area, reorder level, packs (`Tin=15`), opening stock, cost, batch and expiry.

#### `POST /api/inventory/items/import`
Permission: `inventory.manage`
Query/Body: `rows`, `dryRun`, `fileName`, `fingerprint` (same contract as the supplier import)
Returns: `data` = `{ ok, problems[], rows[], created, updated, unchanged, columns, fingerprint, opening{ items, value }, createdItems? }`. For a pinned user, opening stock goes into their own store.
Errors: same as the supplier import (400 rows; 400 file with problems; 409 `stale_preview`).

#### `GET /api/inventory/items`
Permission: `inventory.view`
Query/Body: `search` (≤100), `lowOnly` (`true`), `category`, `storageArea`
Returns: `data` = array of `{ id, name, code, unitId, unitName, unitShortName, category, storageArea, itemType, currentStock, reorderLevel, lastCost, averageCost, isLow, status, preferredSupplierId, preferredSupplierName, packs[{ id, name, size }], keptHere? }`. For a pinned user the stock is their own store's.

#### `POST /api/inventory/items`
Permission: `inventory.manage`
Query/Body: `name` (≤150, required), `unitId` (required), `code` (≤30), `category` (≤50), `storageArea` (≤50), `itemType` (`raw`|`prepared`), `reorderLevel`, `status`, `packs[{ name ≤40, size > 0 }]`, `openingStock` (≥0), `openingCost`, `preferredSupplierId` (the supplier it is normally ordered from; the reorder plan groups it there)
Returns: `data` = the item; 201. Opening stock is written as an `opening` movement.
Errors: 400 unknown unit; 400 the same pack listed twice; 400 opening stock value over the item ceiling; 400 a supplier of another restaurant, or one switched off; 409 duplicate name or code.

#### `PUT /api/inventory/items/:id`
Permission: `inventory.manage`
Query/Body: same fields as create, without opening stock. `packs`, when sent, replaces the item's packs; `preferredSupplierId` left out keeps it, and null clears it. A body with only `preferredSupplierId` (no `name` or `unitId`) changes just that (Reorder's "Choose supplier").
Returns: `data` = the item.
Errors: 404; 409 when `unitId` changes on an item that already has movements, recipe lines or PO lines; 409 duplicate name or code.

#### `PUT /api/inventory/items/:id/packs`
Permission: `inventory.manage`
Query/Body: `packs[{ id?, name, size }]` (the full list; an empty list removes all packs)
Returns: `data` = the item.
Errors: 404; 400 a pack id that is not this item's; 400/409 duplicate pack name.

#### `POST /api/inventory/items/:id/stock-out`
Permission: `inventory.manage`, plus `inventory.approve_writeoff` or manager approval when over the write-off limit
Query/Body: same body as `POST /api/inventory/movements/out`. The item comes from the path, and a different `inventoryItemId` in the body is refused.
Returns: `data` = the updated item; 201.
Errors: 400 item mismatch with the path; others as for movements/out. Approval scope is `{ inventoryItemId, quantity, amount }`.

#### `GET /api/inventory/items/:id/recipe`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = `{ item{ id, name, itemType, unitShortName }, lines[{ id, inventoryItemId, itemName, itemType, quantity, unitShortName, lineCost }] }`. This is the prepared item's sub-recipe.
Errors: 404 item not found.

#### `PUT /api/inventory/items/:id/recipe`
Permission: `inventory.manage`
Query/Body: `lines[{ inventoryItemId, quantity > 0 }]` (required, ≤100 lines, each ingredient once). The list replaces the whole recipe.
Returns: `data` = the recipe, as returned by GET.
Errors: 404; 400 the item is not `prepared`; 400 the item contains itself or the recipe would be circular; 400 an ingredient from another restaurant.

#### `GET /api/inventory/items/:id/balances`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = array of `{ outletId, outletName, ownStore, quantity }`, one per store. A pinned user gets only their own store.
Errors: 404 item not found.

#### `DELETE /api/inventory/items/:id`
Permission: `inventory.manage`
Query/Body: none
Returns: message only.
Errors: 404; 409 when the item has movements, recipe lines or PO lines (set it inactive instead).

#### `PUT /api/inventory/recipe-sizes/:variantId`
Permission: `menu.manage`
Query/Body: `recipeFactor` (0.05 to 10, or null to use the full dish recipe), e.g. Half = 0.5
Returns: `data` = the dish recipe (as in `/api/menu`'s recipe screen).
Errors: 404 size not found.

### Stores

#### `GET /api/inventory/stores`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = array of `{ outletId (null = main), name, code, ownStore, status, itemsHeld, stockValue }`, with the main store first. A pinned user gets only their own store. During a blind count each entry also has `stockHidden` and `hiddenCount`.

#### `PUT /api/inventory/stores/:outletId`
Permission: `inventory.manage`
Query/Body: `ownStore` (boolean, required)
Returns: `data` = `{ outletId, name, ownStore }`.
Errors: 403 pinned to another outlet; 404 outlet; 400 the outlet is inactive (when switching on); 409 the outlet still holds stock (when switching off; transfer it back first).

### Movements (the stock ledger)

#### `GET /api/inventory/movements`
Permission: `inventory.view`
Query/Body: `itemId`, `type` (`purchase`|`adjustment`|`wastage`|`consumption`|`transfer`|`opening`|`return`), `from`, `to` (YYYY-MM-DD), `dateBasis` (`arrived` default | `entered`), `store` (`main`|`all`|outlet id), `search` (≤60), `limit` (1 to 5000, default 100), `offset`
Returns: `data` = `{ items[{ id, inventoryItemId, itemName, transactionType, quantity, unitCost, balanceAfter, balanceScope, reason, referenceType, referenceId, referenceLabel, storeName, effectiveAt, createdAt, createdByName, … }], total, limit, offset, summary{ in, out, waste, inQuantity, outQuantity } }`. The quantity totals are only filled when one item is filtered.
Errors: 400 `from` after `to`; 400 bad `store`; 403 pinned user naming another store; 404 unknown outlet.

#### `POST /api/inventory/movements/in`
Permission: `inventory.manage`
Query/Body: `inventoryItemId` (required), `quantity` (0.001 to 9,999,999, required), `unitCost`, `batchNumber` (≤100), `expiryDate`, `reason` (≤150, default "Stock added"), `notes`, `outletId` (store; defaults to the request's outlet)
Returns: `data` = the updated item; 201. Recorded as an `adjustment`. A supplier delivery should be entered as a purchase bill instead.
Errors: 400 unknown item or outlet; 400 the destination outlet is inactive; 400 the stock value would pass the item ceiling; 403 pinned user naming another store.

#### `POST /api/inventory/movements/out`
Permission: `inventory.manage`, plus `inventory.approve_writeoff` or manager approval when over the write-off limit
Query/Body: `inventoryItemId` (required), `quantity` (0.001 to 9,999,999, required), `transactionType` (`adjustment` default | `wastage` | `consumption` | `transfer`), `wasteReason` (only with `wastage`: `spoiled`, `expired`, `overcooked`, `dropped`, `returned`, `over_prepped`, `remade`, `quality`, `unsold`, `other`), `batchId` (only with `wastage`), `reason` (≤150), `notes` (≤500), `outletId`
Returns: `data` = the updated item; 201. The movement is stored with a negative quantity. It is valued at the item's average cost, or its last cost if there is no average.
Errors: 400 more than the store holds ("Only X kg … is in stock at …"); 400 `wasteReason` without `wastage`, or `other` with no text; 400 `batchId` on a type other than wastage; 409 the batch does not have enough stock left; 403 approval_required with scope `{ inventoryItemId, quantity, amount }`.

#### `POST /api/inventory/movements/transfer`
Permission: `inventory.manage`
Query/Body: `inventoryItemId` (required), `fromOutletId`, `toOutletId` (null = main store), `quantity` (required), `reason`, `notes`
Returns: `data` = the updated item; 201. This is a single-item move that lands at once. For multi-line notes, use transfer notes.
Errors: 400 same store at both ends; 400 the source outlet has no own store; 400 the destination is inactive; 400 not enough held at the source; 403 a pinned user sending from another store.

### Transfer notes and indents
A transfer note (`TRF-0001`) carries up to 200 lines from one store to another and is valued at cost. Batches travel first-to-expire. With `transferReceiptRequired` on, stock leaves the sender at dispatch and stays `in_transit` until the receiver confirms it. With it off, the note lands at once as `received`. An indent is an outlet asking a store for stock. It moves through `requested`, `part_sent`, `sent`, and ends `closed` or `cancelled`.

#### `GET /api/inventory/transfers`
Permission: `inventory.view`
Query/Body: `status` (comma list of `in_transit`, `received`, `cancelled`), `direction` (`in`|`out`), `from`, `to`, `limit` (1 to 500, default 100), `offset`
Returns: `data` = `{ items[{ id, transferNumber, fromOutletId, toOutletId, fromName, toName, indentId, indentNumber, transferDate, status, twoStep, sentValue, receivedValue, shortfallValue, lineCount, … }], total, limit, offset, inTransit{ count, value } }`.
Errors: 400 `from` after `to`.

#### `POST /api/inventory/transfers`
Permission: `inventory.manage`
Query/Body: `fromOutletId`, `toOutletId` (null/`"main"` = main store), `lines[{ inventoryItemId, quantity }]` (required, 1 to 200, each item once), `vehicle` (≤60), `notes`
Returns: `data` = the note with `lines[{ id, inventoryItemId, itemName, unit, quantity, unitCost, value, receivedQuantity, shortfallQuantity, shortfallReason, … }]`; 201.
Errors: 400 same store; 400 the source has no own store; 400 the destination is inactive; 400 not enough stock ("Only X … is held at …"); 400 duplicate item or no positive quantity; 403 a pinned user sending from another store.

#### `GET /api/inventory/transfers/:id`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = the full note, including addresses and lines.
Errors: 404 not found or not the pinned user's store.

#### `POST /api/inventory/transfers/:id/receive`
Permission: `inventory.manage`
Query/Body: `lines[{ lineId, receivedQuantity (≥0, ≤ quantity sent), shortfallReason (`short`|`damaged`|`spoiled`, required when short), shortfallNote }]` (every line must be answered), `note` (≤500)
Returns: `data` = the note, now `received`. A shortfall is written off at the receiving store.
Errors: 400 a missing line answer, a quantity over what was sent, or a shortfall without a reason; 403 not the receiving store; 404; 409 not `in_transit`.

#### `POST /api/inventory/transfers/:id/cancel`
Permission: `inventory.manage`
Query/Body: `reason` (≤200, required)
Returns: `data` = the note, now `cancelled`. Its stock goes back to the sender.
Errors: 400 missing reason; 403 not the sending store; 404; 409 already received or cancelled.

#### `GET /api/inventory/indents`
Permission: `inventory.view`
Query/Body: `status` (comma list of `requested`, `part_sent`, `sent`, `closed`, `cancelled`), `from`, `to`, `limit` (≤500, default 100), `offset`
Returns: `data` = `{ items[{ id, indentNumber, outletId, outletName, supplyOutletId, supplyName, neededBy, status, lineCount, openLines, … }], total, limit, offset, open }`.

#### `POST /api/inventory/indents`
Permission: `inventory.view` and (`inventory.indent` or `inventory.manage`)
Query/Body: `outletId` (the asking outlet; defaults to the request's outlet and is forced for a pinned user), `supplyOutletId` (null = main store), `neededBy` (date), `notes`, `lines[{ inventoryItemId, quantity, note ≤200 }]` (required)
Returns: `data` = the indent with `lines[{ quantity, sentQuantity, receivedQuantity, stillToSend, supplyStock, … }]` and `transfers[]`; 201.
Errors: 400 no outlet; 400 the outlet is inactive or sells from the main store; 400 the supplying store has no own stock; 400 an outlet asking itself; 400 an inactive item; 403 a pinned user asking for another outlet.

#### `GET /api/inventory/indents/:id`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = the indent with lines and the notes sent against it.
Errors: 404 not found or not involving the pinned user's store.

#### `POST /api/inventory/indents/:id/fulfil`
Permission: `inventory.manage`
Query/Body: `lines[{ inventoryItemId, quantity }]`, `vehicle`, `notes`
Returns: `data` = the transfer note sent from the supplying store to the asking outlet; 201.
Errors: 409 the indent is not `requested`/`part_sent`; 403 not the supplying store; 400 an item not on the indent or more than is still asked for; plus the dispatch errors above.

#### `POST /api/inventory/indents/:id/close`
Permission: `inventory.manage`
Query/Body: `reason` (≤200, required: why the rest is not coming)
Returns: `data` = the indent, now `closed`.
Errors: 400 missing reason; 403 a pinned user who is not the supplying store; 404; 409 already sent, closed or cancelled, or changed concurrently.

#### `POST /api/inventory/indents/:id/cancel`
Permission: `inventory.view` and (`inventory.indent` or `inventory.manage`)
Query/Body: `reason` (≤200, optional)
Returns: `data` = the indent, now `cancelled`.
Errors: 409 stock already sent against it (ask the supplying store to close it instead); 409 not open; 403 a pinned user withdrawing another outlet's indent; 404.

### Batches and production

#### `GET /api/inventory/batches`
Permission: `inventory.view`
Query/Body: `show` (`all` default | `expiring` | `soon` | `expired` | `unknown` | `used_after_expiry`), `within` (days 0 to 60, default 7, used by `expiring`), `store` (`main`|`all`|outlet id; defaults to the request's outlet's store)
Returns: `data` = array of batch rows in snake_case: `{ id, inventory_item_id, name, unit, batch_number, expiry_date, days_left, outlet_id, store, quantity, unit_cost, received_on, used_after_expiry, used_on_bills[], … }`. Items on a blind count are left out for callers without `inventory.manage`.

#### `GET /api/inventory/production`
Permission: `inventory.view`
Query/Body: none. The list is filtered to the request's outlet when one is set.
Returns: `data` = up to 200 of `{ id, batchNumber, status, voidReason, itemName, quantity, unitShortName, totalCost, unitCost, producedAt, expiryDate, notes, outletName }`.

#### `POST /api/inventory/production`
Permission: `inventory.manage`
Query/Body: `outputItemId` (an active prepared item, required), `quantity` (required), `batchNumber` (≤60, required), `expiryDate` (not in the past), `notes`, `requestKey` (UUID, for idempotency)
Returns: `data` = `{ id, batchNumber, itemName, quantity, totalCost, unitCost }`; 201. The ingredients are consumed and the output is added as a batch at their cost. Replaying the same `requestKey` returns `replayed: true`.
Errors: 400 not a prepared item, no recipe, or ingredients with no cost; 400 an expired batch or value too large; 409 not enough ingredient stock; 409 the batch number was already posted for this item; 409 `requestKey` reused with different data.

#### `POST /api/inventory/production/:id/void`
Permission: `inventory.manage`
Query/Body: `reason` (≤300, required)
Returns: message only. Every movement of the batch is reversed and the ingredients are restored.
Errors: 404 (also when the batch is at another outlet); 409 already void; 409 the output has already been used or moved.

### Closing stock

#### `GET /api/inventory/valuation`
Permission: `inventory.view`
Query/Body: `date` (default today), `store` (`main`|`all`|outlet id)
Returns: `data` = `{ date, store, items[{ id, name, category, unitShortName, quantity, unitCost, value, costEstimated, negative }], byCategory[], inTransit[], totals{ value, inTransitValue, valueWithTransit, itemCount, negativeCount, estimatedCount, hiddenCount } }`. Negative stock is listed but left out of the closing value.
Errors: 400 bad store; 403/404 as for movements.

### Stock counts
A count sheet (`SC-0001`) covers the active items of one store, which can be narrowed by category and storage area. Anyone with `inventory.count` can fill it in. Posting corrects stock and needs `inventory.manage`. When the shortage value is over the write-off limit it also needs `inventory.approve_writeoff` or a manager token tied to this sheet (scope `{ stockCountId, amount }`). On a blind count, people who cannot post do not see expected figures. Variance reasons are `unexplained`, `wastage_not_logged`, `staff_meals`, `over_portioning`, `theft`, `delivery_not_entered`, `count_error` and `other`.

#### `GET /api/inventory/counts`
Permission: `inventory.view`
Query/Body: `status` (`draft`|`posted`|`cancelled`), `limit` (1 to 200, default 100)
Returns: `data` = `{ items[{ id, countNumber, outletId, storeName, countedAt, businessDate, scope, blind, status, lineCount, countedCount, varianceCount, shortageValue, excessValue, netValue, postedAt, postedByName, createdByName }], total, limit }`.

#### `POST /api/inventory/counts`
Permission: `inventory.count`
Query/Body: `outletId` (store; defaults to the request's outlet; an outlet without its own store counts the main store), `categories[]`, `storageAreas[]` (each ≤50), `countedAt` (not in the future), `blind` (boolean), `notes`
Returns: `data` = the sheet (as in GET `/counts/:id`) plus `skipped` and `madeBlind`; 201. Items already on another open sheet for the store are skipped. A non-manager's sheet becomes blind if it overlaps items already counted blind.
Errors: 400 no matching active items; 400 unknown outlet; 403 a pinned user naming another store; 409 every matching item is already on an open sheet.

#### `GET /api/inventory/counts/variance`
Permission: `inventory.view`
Query/Body: `from` (default = `to`), `to` (default today), `store`
Returns: `data` = `{ from, to, store, countCount, items[{ inventoryItemId, itemName, timesCounted, shortageQuantity, shortageValue, excessQuantity, excessValue, netQuantity, netValue }], byReason[{ reason, label, lines, value }], totals{ shortageValue, excessValue, netValue, linesCounted, linesWithVariance } }`. Built from posted counts, with the worst losses first.
Errors: 400 `from` after `to`; 403/404 store.

#### `GET /api/inventory/counts/:id`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = the summary plus `expectedHidden`, `lines[{ id, inventoryItemId, itemName, packs, countedQuantity, systemQuantity, varianceQuantity, unitCost, varianceValue, reason, reasonLabel, note, … }]`, `totals{ shortageValue, excessValue, netValue, needReason }` (null when hidden) and `reasons[]`.
Errors: 404 not found or another store's sheet for a pinned user.

#### `PUT /api/inventory/counts/:id/lines`
Permission: `inventory.count`
Query/Body: `lines[{ id (line id), countedQuantity (≥0 or null), reason (variance code), note ≤200 }]` (required), `countedAt`, `notes`
Returns: `data` = the sheet.
Errors: 400 a line that is not on this sheet; 404; 409 the sheet is not `draft`.

#### `POST /api/inventory/counts/:id/post`
Permission: `inventory.manage`, plus `inventory.approve_writeoff` or manager approval when the shortage value is over the write-off limit
Query/Body: none
Returns: `data` = the posted sheet. Stock is corrected to the counted figures.
Errors: 409 not `draft`; 400 nothing counted; 400 a difference without a reason (lists up to 5 items); 400 a difference too large to be real; 404; 403 approval_required with scope `{ stockCountId, amount: shortageValue }`. All of these checks run before any PIN is requested.

#### `POST /api/inventory/counts/:id/cancel`
Permission: `inventory.manage`
Query/Body: none
Returns: `data` = the sheet, now `cancelled`.
Errors: 404; 409 already posted or cancelled.

---

## Inventory insights (waste and reorder)

Mounted at `/api/inventory-insights`, with `resolveOutlet`. Figures are for the store of the request's outlet: its own store, or the main store it sells from. With no outlet, they cover every store.

**canLogWaste.** The logging routes accept a caller holding `inventory.waste` **or** `inventory.manage`, and answer 403 otherwise. `inventory.waste` lets the kitchen log waste without being able to change stock any other way. Undoing an entry needs `inventory.manage`. Logging is subject to the write-off approval described at the top.

#### `GET /api/inventory-insights/summary`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = `{ businessDate, store, currency, wasteToday{ value, entries }, wasteLast7Days{ value, entries, previousValue }, stock{ out, critical, low, toOrder, toOrderValue } }`.

#### `GET /api/inventory-insights/wastage`
Permission: `inventory.view`
Query/Body: `from`, `to` (YYYY-MM-DD; default is the last 7 business days; range ≤ 1 year), `reason` (a waste reason key or `unspecified`), `itemId`, `limit` (1 to 500, default 100)
Returns: `data` = `{ from, to, days, store, businessDate, currency, reasons[], reverseWindowDays: 7, summary{ value, entries, items, perDay, previous, change, topReason, topItem }, byReason[], daily[], topItems[], entries{ items[], total, reversed, limit } }`.
Errors: 400 bad date, `from` after `to`, or a range over a year; 400 a non-integer `itemId`.

#### `GET /api/inventory-insights/wastage/entries`
Permission: `inventory.view`
Query/Body: same filters as `/wastage`, plus `offset`
Returns: `data` = `{ from, to, items[], total, reversed, limit, offset }`, one page of the log with the newest first.

#### `POST /api/inventory-insights/wastage`
Permission: `inventory.waste` or `inventory.manage` (canLogWaste), plus `inventory.approve_writeoff` or manager approval when over the write-off limit
Query/Body: `inventoryItemId` (required), `quantity` (>0, ≤99,999, rounded to 0.001), `reason` (required: `spoiled`, `expired`, `overcooked`, `dropped`, `returned`, `over_prepped`, `remade`, `quality`, `unsold` (a bakery's breads and cakes left at closing and not kept for tomorrow), `other`), `note` (≤300; required for `other`)
Returns: `data` = `{ entry{ id, … value, store }, item{ id, name, unit, currentStock } }`; 201. The entry is valued at the item's last cost and taken off the request's outlet store.
Errors: 400 no item, quantity or reason; 400 no stock, or more than the store holds; 403 approval_required with scope `{ inventoryItemId, quantity, amount }`.

#### `POST /api/inventory-insights/items/:itemId/wastage`
Permission: same as `POST /wastage` (canLogWaste + write-off approval)
Query/Body: same as `POST /wastage`. The item comes from the path, and a different body `inventoryItemId` is refused.
Returns: same as `POST /wastage`; 201.
Errors: 404 bad item id in the path; 400 item mismatch; others as above.

#### `POST /api/inventory-insights/wastage/:id/reverse`
Permission: `inventory.manage`
Query/Body: `note` (≤300)
Returns: `data` = the entry, now reversed, plus the item. The stock is put back.
Errors: 404 not a wastage entry of this restaurant (or of the pinned store); 409 already reversed; 409 older than 7 days; 409 part of a dish write-off (undo it under Dish waste).

#### `GET /api/inventory-insights/dish-waste/options`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = `{ reasons[{ key, label }], dishes[{ id, name, code, category, foodType, isCombo, sizes[{ id, name }], hasRecipe }], addOns[{ id, name }] }`.

#### `GET /api/inventory-insights/dish-waste`
Permission: `inventory.view`
Query/Body: `from`, `to` (default last 7 days), `limit` (≤500, default 100)
Returns: `data` = `{ from, to, reasons, reverseWindowDays, summary{ entries, plates, value }, items[{ id, date, productId, variantId, itemName, quantity, reason, value, store, reversed, reversible, … }], total }`.
Errors: 400 bad dates.

#### `POST /api/inventory-insights/dish-waste`
Permission: `inventory.waste` or `inventory.manage` (canLogWaste), plus `inventory.approve_writeoff` or manager approval when over the write-off limit
Query/Body: `productId` (required), `variantId`, `quantity` (whole plates, 1 to 500), `reason` (`dropped`|`remade`|`spoiled`|`quality`), `note` (≤300), `modifierIds[]` (≤20)
Returns: `data` = the write-off with `ingredients[{ inventoryItemId, name, unit, quantity, value }]`; 201. The dish's recipe, including combos, add-ons and sub-recipes, is taken out of stock as wastage rows.
Errors: 400 unknown dish, size or add-on; 400 bad plates or reason; 400 the dish has no recipe; 403 approval_required with scope `{ productId, quantity, amount }`.

#### `GET /api/inventory-insights/dish-waste/:id`
Permission: `inventory.view`
Query/Body: none
Returns: `data` = the write-off with its ingredients.
Errors: 404.

#### `POST /api/inventory-insights/dish-waste/:id/reverse`
Permission: `inventory.manage`
Query/Body: `note` (≤300)
Returns: `data` = the write-off, now reversed. All of its ingredients are put back.
Errors: 404 (also another store's entry for a pinned user); 409 already undone; 409 older than 7 days.

#### `GET /api/inventory-insights/control`
Permission: `audit.view`
Query/Body: `from`, `to` (YYYY-MM-DD; default last 7 days)
Returns: `data` = `{ from, to, store, summary{ wastage{ entries, value }, dishes{ entries, value }, largeWriteoffs{ count, value }, purchaseApprovals{ asked, approved, sentBack } }, byPerson[], largeWriteoffs[{ kind, what, quantity, value, limit, loggedBy, approvedBy, at }], purchaseApprovals[{ orderId, poNumber, outcome, total, limit, by, approvedBy, at }] }`. This is the stock side of theft control.
Errors: 400 dates not in the form `YYYY-MM-DD`, or the start after the end.

#### `GET /api/inventory-insights/reorder`
Permission: `inventory.view`
Query/Body: `horizon` (whole days of cover, 1 to 30; default the restaurant's own, `rules.reorderHorizonDays`, 7 until changed)
Returns: `data` = `{ businessDate, store, horizon, defaultHorizon, safetyDays, usageDays, criticalDays, summary{ items, out, critical, low, ok, toOrder, toOrderValue, suppliers, unassigned, onOrderItems, draftItems }, groups[{ supplierId, supplierName, lines[], value, urgent, unpriced }], items[] }`. Suggestions are grouped by the item's preferred supplier (chosen by hand, `preferredSupplierId` on the item, while that supplier is active), else by the supplier it was last bought from. `usageDays` (how far back usage is read) and `safetyDays` are the restaurant's rules too (Settings → Alerts and timings; 14 and 2 until changed).
Errors: 400 bad horizon.

#### `POST /api/inventory-insights/reorder/draft-orders`
Permission: `inventory.view` **and** `purchasing.manage`
Query/Body: `supplierId` (an active supplier, required), `lines[{ inventoryItemId, quantity ≥0 }]` (required, ≤200; zero lines are dropped), `horizon`. No prices are accepted: the server prices each line from this supplier's last price, then the item's last cost.
Returns: `data` = `{ order (a draft purchase order), unpriced[] (item names with no price) }`; 201. The draft goes to the request's outlet store. Drafts never need approval.
Errors: 400 no supplier, or an inactive supplier; 400 no line above zero, a duplicate, or an unknown or inactive item; 409 the next PO number is already taken.

---

## Purchase orders and purchase bills

Mounted at `/api/purchase-orders`, with `resolveOutlet`. PO statuses are `draft` → `ordered` (or `pending_approval` → `ordered`) → `partial` → `received`, plus `closed` (closed short) and `cancelled`. Purchase bills (goods receipts, `GRN-…`) are every delivery, with or without an order. Attachments allow at most 5 files per bill. Each file is a JPG, PNG or PDF of up to 5 MB, uploaded as multipart field `file`.

**PO approval step.** When an order's total (before GST) is over `poApprovalLimit`, marking it `ordered` (via create with `poStatus: "ordered"` or via `PATCH /:id/status`) behaves as follows:
- **Caller holds `purchasing.approve`:** the order goes straight to `ordered`, and the response has `approvalStep: "self"`.
- **Otherwise:** the order moves to `pending_approval`, and the response has `approvalStep: "requested"` and `approvalLimit`.

A waiting order is approved or sent back with the two routes below. The order's `approval` block records who asked, who approved and the amount approved, or who sent it back and why.

### Purchase bills

#### `GET /api/purchase-orders/receipts`
Permission: `purchasing.view`
Query/Body: `from`, `to`, `supplierId`, `kind` (`direct`|`po`), `status` (`posted`|`void`), `search` (≤60), `limit` (1 to 1000, default 200)
Returns: `data` = `{ items[ bill ], total, limit }`. Each bill has `{ id, receiptNumber, supplierId, supplierName, supplierGstin, purchaseOrderId, poNumber, kind, outletId, storeName, billNumber, billDate, receivedDate, dueDate, paymentMode, taxableAmount, taxAmount, roundOff, totalAmount, status, attachmentCount, … }`.

#### `POST /api/purchase-orders/receipts`
Permission: `purchasing.receive` (plus `purchasing.pay` when `paymentMode` is `paid`)
Query/Body: `supplierId` (an active supplier, required), `lines[{ inventoryItemId, packId?, quantity, rejectedQuantity?, rejectionReason? (required when rejected), batchNumber?, expiryDate?, unitPrice (required), taxRate (0, 0.25, 3, 5, 12, 18 or 28) }]`, `billNumber`, `billDate`, `receivedDate` (not in the future, not before the bill date), `pricesIncludeTax`, `billTotal` (printed total; up to ₹1 is booked as round-off), `notes`, `paymentMode` (`credit` default | `paid`), `paymentMethod` (`cash`, `card`, `upi`, `bank`, `cheque`, `other`), `paidFromTill` (cash only; needs an open business day), `paymentReference`, `outletId` (store)
Returns: `data` = the bill with `lines[]`, `payments[]` and `returns[]`; 201. Stock is added at cost including GST. On credit, the due date is the bill date plus the supplier's credit days.
Errors: 400 inactive supplier, duplicate line, unknown item or pack, bad GST rate, or line total vs `billTotal` off by more than ₹1; 400 future date; 400 till cash without an open day; 400 inactive outlet; 403 `paid` without `purchasing.pay`; 403 pinned user and another store; 409 the same bill number from this supplier was already entered.

#### `GET /api/purchase-orders/receipts/:receiptId`
Permission: `purchasing.view`
Query/Body: none
Returns: `data` = the full bill. Each line has `{ billQuantity, rejectedQuantity, quantity, returnedQuantity, unitPrice, taxRate, taxableAmount, taxAmount, amount, unitCost, netUnitPrice, … }`, and the bill has `payments[]` and `returns[]`.
Errors: 404.

#### `GET /api/purchase-orders/receipts/:receiptId/attachments`
Permission: `purchasing.view`
Query/Body: none
Returns: `data` = array of `{ id, fileName, mimeType, sizeBytes, isImage, createdAt, createdByName }`.
Errors: 404 bill not found (or another outlet's bill for a pinned user).

#### `POST /api/purchase-orders/receipts/:receiptId/attachments`
Permission: `purchasing.receive`
Query/Body: multipart `file` (one JPG, PNG or PDF, ≤5 MB; the content is sniffed)
Returns: `data` = the attachment; 201. A voided bill keeps its files.
Errors: 400 wrong type, too big, more than one file, or the bill already has 5 files; 404 bill.

#### `GET /api/purchase-orders/receipts/:receiptId/attachments/:attachmentId`
Permission: `purchasing.view`
Query/Body: none
Returns: the file itself (not JSON), served inline with `Cache-Control: private, no-store`.
Errors: 404 bill, file, or a file missing on disk.

#### `DELETE /api/purchase-orders/receipts/:receiptId/attachments/:attachmentId`
Permission: `purchasing.receive`
Query/Body: none
Returns: `data` = the removed attachment. The file is soft-removed and kept on disk.
Errors: 404.

#### `POST /api/purchase-orders/receipts/:receiptId/void`
Permission: `purchasing.receive`, plus `purchasing.pay` or manager approval when the bill has a posted payment (an unpaid bill is waived)
Query/Body: `reason` (≤200, required)
Returns: `data` = the bill, now `void`. Its stock is taken back out, and a payment made on delivery is voided with it.
Errors: 400 missing reason; 403 a pinned user voiding another store's bill (checked before any PIN); 403 approval_required (no scope; the token is tied to the request); 404; 409 already voided; 409 goods from this bill were returned (void the return first); 400 `data.reason: "stock_value_limit"` when restoring the earlier price would break the stock-value ceiling.

#### `GET /api/purchase-orders/register`
Permission: `purchasing.view`
Query/Body: `from` (default the 1st of `to`'s month), `to` (default today), `supplierId`
Returns: `data` = `{ from, to, restaurantGstin, taxSplitAssumed, rows[{ receiptNumber, billNumber, billDate, supplierName, supplierGstin, taxable, cgst, sgst, igst, tax, roundOff, total, rates[] }], returns[] (debit notes), byRate[], totals, returnTotals, net }`. The split between CGST/SGST and IGST is decided by comparing the state codes of the two GSTINs.
Errors: 400 `from` after `to`.

### Purchase orders

#### `GET /api/purchase-orders`
Permission: `purchasing.view`
Query/Body: `status` (comma list of `draft`, `pending_approval`, `ordered`, `partial`, `received`, `closed`, `cancelled`), `supplierId`, `search` (≤60), `from`, `to` (order dates)
Returns: `data` = array of orders. Each order has `{ id, poNumber, supplierId, supplierName, outletId, storeName, outletClosed, orderDate, expectedDate, totalAmount, billedAmount, receiptCount, poStatus, closedReason, approval{ requestedAt, requestedByName, approvedAt, approvedByName, approvedAmount, note, rejectedAt, rejectedByName, rejectionNote }, itemCount, … }`. Reading is restaurant-wide, including for pinned users.
Errors: 400 `from` after `to`.

#### `GET /api/purchase-orders/:id`
Permission: `purchasing.view`
Query/Body: none
Returns: `data` = the order with `items[{ id, inventoryItemId, itemName, quantity, receivedQuantity, outstandingQuantity, unitPrice, amount, packId, packName, packSize, packQuantity, packPrice }]` and `receipts[]`.
Errors: 404.

#### `POST /api/purchase-orders`
Permission: `purchasing.manage`
Query/Body: `supplierId` (required), `orderDate` (default today), `expectedDate` (not before the order date), `notes`, `items[{ inventoryItemId, packId?, quantity, unitPrice }]` (required; in packs, the quantity is a number of packs and the price is per pack), `poStatus` (`draft` default | `ordered`)
Returns: `data` = the order plus `approvalStep` (`requested`|`self`|null) and `approvalLimit` when requested; 201. The goods go to the store of the request's outlet.
Errors: 400 unknown supplier, item or pack, or a duplicate item; 400 expected date before the order date.

#### `PUT /api/purchase-orders/:id`
Permission: `purchasing.manage`
Query/Body: same as create, without `poStatus`
Returns: `data` = the order.
Errors: 403 a pinned user editing another store's order; 404; 409 not a draft.

#### `PATCH /api/purchase-orders/:id/status`
Permission: `purchasing.manage`
Query/Body: `status` (`ordered`|`cancelled`|`closed`|`draft`), `reason` (≤200; for `closed`). Allowed moves are draft → ordered/cancelled, pending_approval → draft/cancelled, ordered → cancelled, and partial → closed.
Returns: `data` = the order, with `approvalStep` when it was marked ordered.
Errors: 403 a pinned user and another store's order; 404; 409 a move that is not allowed (including `ordered` while waiting for approval, or cancelling a part-received order); 409 changed concurrently.

#### `POST /api/purchase-orders/:id/approve`
Permission: `purchasing.manage` or `purchasing.approve` to reach the step, then `purchasing.approve` or manager approval
Query/Body: `note` (≤300, optional)
Returns: `data` = the order, now `ordered`. `approval.approvedByName` is the approver: the caller, or the manager whose PIN was used.
Errors: 403 neither permission; 403 a pinned user and another store's order; 404; 409 not `pending_approval`; 403 approval_required with scope `{ purchaseOrderId, amount: totalAmount }`. The order checks run before the PIN is requested.

#### `POST /api/purchase-orders/:id/reject`
Permission: `purchasing.manage` or `purchasing.approve` to reach the step, then `purchasing.approve` or manager approval
Query/Body: `note` (≤300, **required**: why it is being sent back)
Returns: `data` = the order, back to `draft` with `approval.rejectionNote`.
Errors: 400 missing note; others as for approve (same scope `{ purchaseOrderId, amount }`).

#### `POST /api/purchase-orders/:id/receive`
Permission: `purchasing.receive` (plus `purchasing.pay` when `paymentMode` is `paid`)
Query/Body: `lines[{ itemId (order line id), quantity, rejectedQuantity?, rejectionReason?, batchNumber?, expiryDate?, unitPrice? (the billed price; defaults to the order's price), taxRate? }]`, plus the bill header and settlement fields used by `POST /receipts`
Returns: `data` = the order plus `receiptId`, `receivedInto` and `storeNote` (set when the order's outlet has closed and the goods went to the main store). Partial deliveries are allowed.
Errors: 400 nothing received; 400 more than is outstanding, or more rejected than was due; 400 rejected without a reason; 400 bill total mismatch; 403 a pinned user and another store; 404; 409 the order is a draft, waiting for approval, or closed; 409 duplicate bill number.

#### `DELETE /api/purchase-orders/:id`
Permission: `purchasing.manage`
Query/Body: none
Returns: message only.
Errors: 403 a pinned user and another store's order; 404; 409 not a draft (cancel it instead).

---

## Purchase returns and supplier payments

Mounted at `/api/purchase-returns`, with `resolveOutlet`. A return (debit note) takes stock out and credits the supplier. A credit is never higher than what was paid: the bill's price, the order's highest billed price, the supplier's highest ever price, or the item's cost when the return is tied to nothing. It is also credited at the GST rate the goods were bought at. Paying suppliers is its own right, `purchasing.pay`.

Lists here have two modes. With none of `from`, `to`, `limit` or `offset`, they return a plain array (up to 200). With any of them, they return `{ items, total, limit (≤500, default 25), offset }`.

The money pages (`payments`, `outstanding`, `statement`) are for whoever pays suppliers or reads the reports: they need `purchasing.view` and either `purchasing.pay` or `reports.view`, so a store keeper who orders and receives does not see them.

#### `GET /api/purchase-returns/payments`
Permission: `purchasing.view` and (`purchasing.pay` or `reports.view`)
Query/Body: `supplierId`, `status` (`posted`|`void`), and optionally `from`, `to`, `limit`, `offset`
Returns: `data` = payments, or a page of them. Each payment has `{ id, supplierId, supplierName, purchaseOrderId, poNumber, goodsReceiptId, receiptNumber, billNumber, paymentDate, amount, paymentMethod, referenceNo, notes, status, paidFromTill, businessDate, tillOutletId, tillName, … }`.

#### `POST /api/purchase-returns/payments`
Permission: `purchasing.pay`
Query/Body: `supplierId` (required), `amount` (0.01 to 99,999,999, required), `paymentDate` (default today, not in the future), `paymentMethod` (`cash` default, `card`, `upi`, `bank`, `cheque`, `other`), `purchaseOrderId` / `goodsReceiptId` (must be this supplier's), `referenceNo`, `notes`, `paidFromTill` (cash only, from the open business day of the request's till)
Returns: `data` = the supplier's payment list, and the top-level `paymentId` names the new payment; 201.
Errors: 400 unknown supplier, order or bill; a mismatched supplier; a cancelled order; a voided bill; 400 till cash that is not cash, or no open day.

#### `PUT /api/purchase-returns/payments/:paymentId`
Permission: `purchasing.pay`
Query/Body: `changeReason` (≤200, required), plus any of `amount`, `paymentDate`, `paymentMethod`, `referenceNo`, `notes`, `paidFromTill`
Returns: `data` = the corrected payment.
Errors: 400 missing reason; 400 till cash that is not cash, or no open day; 404 payment; 409 voided.

#### `POST /api/purchase-returns/payments/:paymentId/void`
Permission: `purchasing.pay`
Query/Body: `reason` (≤200, required)
Returns: `data` = the payment, now `void`.
Errors: 400 missing reason; 404; 409 already voided.

#### `GET /api/purchase-returns/outstanding`
Permission: `purchasing.view` and (`purchasing.pay` or `reports.view`)
Query/Body: none
Returns: `data` = `{ today, tillToday, buckets[{ key, label }], suppliers[{ supplierId, supplierName, creditDays, purchased, returned, paid, outstanding, owed, advance, overdue, openBills, nextDueDate, mostDaysLate, ageing{ notDue, days1to30, days31to60, days61to90, days90plus } }], totals{ purchased, returned, paid, outstanding, advance, net, overdue, ageing } }`. A supplier's advance is never netted against another supplier's balance.

#### `GET /api/purchase-returns/statement`
Permission: `purchasing.view` and (`purchasing.pay` or `reports.view`)
Query/Body: `supplierId` (required), `from` (default the 1st of `to`'s month), `to` (default today)
Returns: `data` = `{ supplier{ id, name, gstNumber, … }, from, to, today, openingBalance, entries[{ date, type (bill|return|payment), number, reference, dueDate, amount, status, balance, … }], totals{ billed, settled }, closingBalance, openBills[], ageing, advance, buckets }`.
Errors: 400 `from` after `to`; 404 supplier.

#### `GET /api/purchase-returns/credit-limit`
Permission: `purchasing.returns`
Query/Body: `supplierId`, `itemId` (both required)
Returns: `data` = `{ supplierId, inventoryItemId, maxUnitPrice (before GST, or null), rates[] (or null for any rate), basis (supplier|cost|null), supplied, returned, maxQuantity }`. These are the limits for a return that is not tied to a bill.
Errors: 404 supplier or item.

#### `GET /api/purchase-returns`
Permission: `purchasing.view`
Query/Body: `supplierId`, `status` (`posted`|`void`), and optionally `from`, `to`, `limit`, `offset`
Returns: `data` = returns, or a page of them. Each return has `{ id, returnNumber, returnDate, supplierId, supplierName, purchaseOrderId, poNumber, goodsReceiptId, receiptNumber, billNumber, taxableAmount, taxAmount, totalAmount, reason, status, itemCount, … }`.

#### `GET /api/purchase-returns/:id`
Permission: `purchasing.view`
Query/Body: none
Returns: `data` = the return with `items[{ …, maxUnitPrice, maxBasis }]` and `goodsArrivedOn` (the earliest date the return may be dated).
Errors: 404.

#### `POST /api/purchase-returns`
Permission: `purchasing.returns`
Query/Body: `supplierId` (required), `goodsReceiptId` or `purchaseOrderId` (optional; must be this supplier's), `returnDate` (default today, not future, not before arrival), `reason` (≤200, required), `notes`, `items[{ inventoryItemId, quantity, unitPrice (credit before GST, ≥0), taxRate? }]` (required)
Returns: `data` = the return; 201. A return tied to nothing leaves from the request's outlet store.
Errors: 400 a bill or order that is unknown, belongs to another supplier, or is voided; 400 an item not on the bill or order, a duplicate, or more than can go back; 400 a credit over the price paid, or a GST rate not charged; 400 not enough stock in the store; 403 a pinned user returning from another store's bill or order.

#### `PUT /api/purchase-returns/:id`
Permission: `purchasing.returns`
Query/Body: `changeReason` (≤200, required), `returnDate`, `reason`, `notes`, `lines[{ id, unitPrice }]`. Quantities cannot be changed: void the return and enter it again.
Returns: `data` = the corrected return.
Errors: 400 missing `changeReason`, a line not on the return, or a price over the limit; 403 a pinned user and another store's return; 404; 409 voided.

#### `POST /api/purchase-returns/:id/void`
Permission: `purchasing.returns`
Query/Body: `reason` (≤200, required)
Returns: `data` = the return, now `void`. The goods are put back in stock.
Errors: 400 missing reason; 403 a pinned user and another store's return; 404; 409 already voided.

---

## Expenses

Mounted at `/api/expenses`, with `resolveOutlet`. When an outlet is set for the request, the list covers that outlet only. Any `/:id` route answers 404 "Expense not found in this outlet" for an expense of another outlet; categories are not affected. Statuses are `pending`, `approved` (counted in the accounts) and `rejected`. Only pending expenses can be edited or deleted. Petty cash paid from a drawer (`fromDrawer`) is managed under Business day → Drawers. Cash expenses follow business-day rules: they cannot be dated after today, cannot be dated after the open business day, and cannot be put into a drawer that is already closed.

### Categories

#### `GET /api/expenses/categories`
Permission: `expenses.view`
Query/Body: none
Returns: `data` = array of `{ id, name, description, status, expenseCount }`.

#### `POST /api/expenses/categories`
Permission: `expenses.manage`
Query/Body: `name` (≤100, required), `description` (≤500), `status` (`active`|`inactive`)
Returns: `data` = the category; 201.
Errors: 409 duplicate name.

#### `PUT /api/expenses/categories/:id`
Permission: `expenses.manage`
Query/Body: same as create
Returns: `data` = the category.
Errors: 404; 409 duplicate name.

#### `DELETE /api/expenses/categories/:id`
Permission: `expenses.manage`
Query/Body: none
Returns: message only.
Errors: 404; 409 the category has expenses (set it inactive instead).

### Expenses

#### `GET /api/expenses`
Permission: `expenses.view`
Query/Body: `status` (`pending`|`approved`|`rejected`), `categoryId`, `from`, `to`, `page` (≥1), `pageSize` (`25`|`50`|`100`; defaults to 25 when `page` is given). With neither paging parameter, the 300 most recent expenses are returned.
Returns: `data` = `{ summary{ approvedTotal, pendingTotal, pendingCount, waitingCount, waitingTotal }, items[{ id, outletId, outletName, expenseCategoryId, categoryName, supplierId, supplierName, expenseDate, amount, paymentMode, referenceNo, notes, expenseStatus, approvedByName, approvedAt, createdByName, businessDayId, drawerClosed, fromDrawer, attachmentCount }], total, page, pageSize }`.
Errors: 400 `to` before `from`; 400 bad page size.

#### `GET /api/expenses/defaults`
Permission: `expenses.view`
Query/Body: none
Returns: `data` = `{ expenseDate (the open business day of this till, else today), today, businessDay{ id, businessDate, outletId, pastMidnight } | null }`.

#### `POST /api/expenses`
Permission: `expenses.manage`
Query/Body: `expenseCategoryId` (required), `amount` (0.01 to 99,999,999, required), `expenseDate` (default per `/defaults`), `paymentMode` (`cash` default, `card`, `upi`, `bank`, `other`), `supplierId`, `referenceNo` (≤50), `notes` (≤500)
Returns: `data` = the expense (`pending`, for the request's outlet); 201.
Errors: 400 unknown category or supplier; 400 dated after today; 400 `data.reason: "after_open_day"` (cash dated after the open business day); 400 `data.reason: "drawer_closed"` (cash into a closed drawer).

#### `POST /api/expenses/approve`
Permission: `expenses.manage`
Query/Body: `ids` (expense ids, required, 1-200), `expectedTotal` (the total the list showed)
Returns: `data` = `{ count, total, expenses[] }`. "Approve selected": every chosen expense is approved in one transaction, all or none, and each is written to the activity log as if approved on its own. With an outlet set for the request, only that outlet's expenses can be chosen.
Errors: 400 none chosen, or more than 200; 404 `{ reason: "not_found", ids }` (not found here, or another outlet's); 409 `{ reason: "not_pending", ids }` (someone else decided on them); 409 `{ reason: "drawer_petty_cash", ids }` (petty cash from a drawer is approved under Business day → Drawers & cash); 409 `{ reason: "drawer_closed", ids }`; 409 `{ reason: "total_changed", total }` (the amounts changed since the list was opened).

#### `PUT /api/expenses/:id`
Permission: `expenses.manage`
Query/Body: same as create. The outlet is kept, and an omitted date keeps the current date.
Returns: `data` = the updated expense.
Errors: 404 (also another outlet's expense); 409 not pending; 409 changed while editing; 400 the dating rules above.

#### `PATCH /api/expenses/:id/status`
Permission: `expenses.manage`
Query/Body: `status` (`pending`|`approved`|`rejected`, required)
Returns: `data` = the expense. Approving records who approved it and when.
Errors: 404; 409 already in that status; 409 petty cash from a drawer; 409 `data.reason: "drawer_closed"` (a cash expense whose drawer is closed cannot be approved or un-approved).

#### `DELETE /api/expenses/:id`
Permission: `expenses.manage`
Query/Body: none
Returns: message only.
Errors: 404; 409 not pending.

#### `GET /api/expenses/:id/attachments`
Permission: `expenses.view`
Query/Body: none
Returns: `data` = array of `{ id, fileName, mimeType, sizeBytes, isImage, createdAt, createdByName }`.
Errors: 404 expense.

#### `POST /api/expenses/:id/attachments`
Permission: `expenses.manage`
Query/Body: multipart `file` (one JPG, PNG or PDF, ≤5 MB; at most 5 per expense)
Returns: `data` = the attachment; 201.
Errors: 400 wrong type, too big, more than one file, or already 5 files; 404 expense.

#### `GET /api/expenses/:id/attachments/:attachmentId`
Permission: `expenses.view`
Query/Body: none
Returns: the file itself, served inline with `Cache-Control: private, no-store`.
Errors: 404 expense or file.

#### `DELETE /api/expenses/:id/attachments/:attachmentId`
Permission: `expenses.manage`
Query/Body: none
Returns: `data` = the removed attachment (soft-removed).
Errors: 404.

---

## Guests (CRM)

### Contact masking (applies to every CRM and guest-insight read)
Full mobiles, emails and addresses are returned only to holders of `customers.contact`. Everyone else gets them masked (`XXXXXX3210`, `p•••a@gmail.com`) on every read and on the answer to every write; a holder of `customers.manage` who typed a guest's whole number in a search gets that one number back. Searches by people without `customers.contact` find a mobile only by the whole number or its last 4 digits; answers carry `searchLimited: true` when a partial number was typed. Erased guests keep their bills but have no personal details.

### Customers
Mounted at `/api/crm`, restaurant from the token (no outlet scoping). Logged to the activity log: consent changes, GSTIN/company changes, deletes, erases, merges, points adjustments, exports.

#### `GET /api/crm/customers`
Permission: `customers.view`
Query: `search` (string, <=100), `limit` (1-500, default 500)
Returns: `data` = plain array of guests (erased guests left out). Headers `X-Total-Count`, `X-Limit`, `X-Search-Limited` ("1"/"0"), exposed via `Access-Control-Expose-Headers`. The till's quick search.
Errors: 400 bad limit.

#### `POST /api/crm/customers`
Permission: `customers.manage`
Body: `name` (string, required, <=150), `mobile` (normalised to one format), `email`, `address` (<=500), `dateOfBirth` / `anniversaryDate` (YYYY-MM-DD, not in the future), `notes` (<=500), `status` (`active`|`inactive`, default active), `companyName` (<=150), `gstin`, `tags` (array or comma list of `vip`,`allergy`,`jain`,`vegan`,`corporate`,`family`,`blogger`), `allergies` (<=300), `pan` (the guest's PAN: five letters, four digits and a letter, any case, kept in capitals) or `panDeclaration` (bool: they declared they have none, Form 97; not both), `consents` (`{ bills_digital?, reminders?, offers? }`, each yes or no: recorded, or withdrawn, as the guest's consents on the restaurant's privacy notice; see [Personal data](#personal-data)), `marketingOptIn` (bool: the consent to offers, when `consents` leaves it out), `sameDigitsConfirmed` (bool)
Returns: 201, `data` = the customer. A customer carries `pan` (in full only for `customers.contact`, else null), `panMasked` (`••••••234F`) and `panDeclaration`. A PAN or declaration given is logged (`pan` `customer`, the PAN masked).
Errors: 400 PAN not in its shape, or both a PAN and the declaration; 400 GSTIN without `companyName`; 400 tag `allergy` without `allergies`; 409 mobile already held (`data: { existingId, existingName }`); 409 same ten digits in the other form (`data.reason: "same_digits"`, resend with `sameDigitsConfirmed: true` if genuinely different); 409 `data.reason: "no_privacy_notice"` for a consent before the restaurant publishes its notice, and 409 for offers to a guest marked as a child (nothing is saved).

#### `GET /api/crm/guest-book`
Permission: `customers.view`
Query: `search`, `status` (`active` default | `inactive` | `erased` | `all`), `tag`, `optedIn` (`true`/`1`), `business` (`true`/`1`, company guests), `sort` (`name` default, `visits`, `lastVisit`, `spend`, `points`, `created`), `dir` (`asc`|`desc`; names default A-Z, numbers biggest first), `limit` (1-100, default 25), `offset`
Returns: `data` = `{ items[] (guest + visits, lastVisit, spend), total, limit, offset, counts, searchLimited }`.
Errors: 400 bad enum / paging.

#### `GET /api/crm/guest-book/export`
Permission: `customers.view` and `customers.export`
Query: same filters as the guest book (no paging)
Returns: `data` = `{ items[], total, cap: 20000, truncated }`. Contacts masked unless `customers.contact`. Logged as an export.

#### `GET /api/crm/guest-book/import-guide`
Permission: `customers.manage` and `customers.export`
Query/Body: none
Returns: `data` = `{ maxRows: 2000, columns[] { key, label, need, help, example }, sample }`.

#### `POST /api/crm/guest-book/import`
Permission: `customers.manage` and `customers.export`
Body: `rows` (array of `{ heading: cell }`, required, 1-2000), `dryRun` (bool), `fileName`, `fingerprint` (from the dry run), `mode` (`update` default | `skip` for guests already in the book)
Returns: `data` = `{ ok, problems[], rows[], created, updated, unchanged, columns, fingerprint, skipped, openingPoints { guests, points } }` (+ `applied` on a real import). A dry run with problems answers 200 with `success: false`.
Errors: 400 no rows / more than 2000 rows / problems on a real import (nothing written); 409 `stale_preview` when data changed since the dry run's fingerprint.

#### `GET /api/crm/duplicates`
Permission: `customers.view`
Query: none
Returns: `data` = array of `{ duplicate {...}, keep {...} }` pairs (id, name, masked/full mobile, email, points, visits, lastVisit, spend, status, gstin, companyName).

#### `GET /api/crm/customers/:id/history`
Permission: `customers.view`
Query: `visitsOffset` (number, default 0; 50 visits per page)
Returns: `data` = `{ customer, summary { visits, cancelled, billedVisits, totalSpent, averageSpend, lastVisit, firstVisit }, ordersTotal, ordersOffset, orders[], favourites[], loyalty[], merges[] }`.
Errors: 404 customer not found.

#### `POST /api/crm/customers/:id/contact`
Permission: `customers.manage`
Body: none
Returns: `data` = `{ id, name, mobile, mobileDisplay, email, address, limit: 20, logged }`. For users without `customers.contact` each opening is written to the activity log and counted (20 different guests per rolling 24 h); holders of `customers.contact` are neither counted nor logged.
Errors: 404 not found; 409 guest erased; 429 daily limit reached (`data: { reason: "contact_limit", limit }`).

#### `POST /api/crm/customers/:id/points`
Permission: `customers.manage`, then `loyalty.adjust` or manager approval (approval scope `{ customerId, points }` for additions or `{ customerId, pointsOff }` for deductions; an approval for adding never covers taking away)
Body: `points` (integer, -100000..100000, not 0), `notes` (reason, required, <=200)
Returns: `data` = `{ customerId, balance }`.
Errors: 400 zero points / missing reason / not enough points; 404 not found; 409 guest erased.

#### `POST /api/crm/customers/:id/merge`
Permission: `customers.merge`
Body: `mergeId` (id, required): the record folded into `:id`, which stays
Returns: `data` = `{ customer, merged { id, name, mobile, mobileMasked }, pointsMoved, recordsMoved, pointsBefore, invoices { ordinaryBills, gstinSetAside } }`. All references move in one transaction; the GSTIN may be set aside when ordinary bills exist (stated in `message`).
Errors: 400 same id twice / an erased guest; 404 either guest not found; 409 both hold a unique value (nothing changed).

#### `POST /api/crm/customers/:id/not-duplicate`
Permission: `customers.merge`
Body: none
Returns: message only ("Marked as a different guest").
Errors: 404 guest is not marked as a possible duplicate.

#### `POST /api/crm/customers/:id/erase`
Permission: `customers.erase`
Body: `reason` (string, required, <=200)
Returns: `data` = `{ customer, pointsCancelled, cleared, detached }`. Personal details are removed everywhere (feedback, complaints, orders, bookings, an online order's delivery address); bills stay; owed points are cancelled; the guest's consents are withdrawn and kept; open orders/bookings carry on as walk-ins. The log names the record by number only. The erasure is kept in the requests register ([Personal data](#personal-data)) as an erasure request received and done today, with the reason as what was asked.
Errors: 400 missing reason; 404 not found; 409 already erased; 409 `data: { reason: "erasure_blocked", open[] }` while money is still between the guest and the restaurant (dues on account, an advance left, a pre-order to collect).

#### `PUT /api/crm/customers/:id`
Permission: `customers.manage`
Body: as for create; a field left out keeps its value, a field sent empty is cleared. A masked contact box sent back empty by a user without `customers.contact` keeps the stored contact; so does an empty `pan` with `panDeclaration` false from such a user. Every change to the PAN or the declaration is logged (`pan` `customer`, `details.changes` with the PAN masked).
Returns: `data` = the updated customer.
Errors: 400 validation as for create; 404 not found; 409 erased guest / mobile taken / `same_digits`.

#### `DELETE /api/crm/customers/:id`
Permission: `customers.manage`
Returns: message only. Only a record with no history can be deleted.
Errors: 404 not found; 409 has orders, feedback, complaints or points entries (`data: { reason: "has_history", history }`); use erase instead.

### CRM reports
Range `from`/`to` (YYYY-MM-DD) default to the last 30 days of the restaurant's calendar; at most 400 days. `all=1` returns every row (up to 20000) for a CSV: it needs `customers.export` (403 otherwise) and is logged.

#### `GET /api/crm/reports/loyalty`
Permission: `customers.view` and `reports.view`
Query: `from`, `to`, `limit` (<=100, default 25), `offset`, `all`
Returns: `data` = `{ from, to, currency, loyaltyEnabled, pointValue, earnAmount, owed { points, value, guests }, period { earned, redeemed, redeemedValue, returned, manual, opening, expired, net, ... }, byDay[], holders { items[], total, limit, offset } }`.
Errors: 400 bad dates / from after to / range over 400 days; 403 `all` without `customers.export`; 403 `feature_off` while Loyalty points (`guest_loyalty`) is switched off.

#### `GET /api/crm/reports/customer-sales`
Permission: `customers.view` and `sales.view`
Query: `from`, `to`, `limit`, `offset`, `all`, `sort` (`spend` default, `visits`, `bills`, `average`, `lastVisit`, `name`), `dir`, `search`
Returns: `data` = `{ from, to, currency, totals { bills, sales, guestBills, guestSales, guests, walkInBills, walkInSales, guestShare }, items[] { id, name, erased, mobileDisplay, tags, companyName, gstin, visits, bills, spend, average, discounts, pointsValue, lastVisit }, total, limit, offset, searchLimited }`.
Errors: as for the loyalty report.

### Feedback

#### `GET /api/crm/feedback`
Permission: `feedback.view`
Query: `status` (`new`|`reviewed`|`archived`), `rating` (`happy`|`neutral`|`unhappy`), `search`, `limit` (<=200, default 200), `offset`
Returns: `data` = `{ summary { total, average, happy, unhappy, unread }, items[], total, limit, offset, searchLimited }`.

#### `POST /api/crm/feedback`
Permission: `feedback.manage`
Body: `rating` (integer 1-5, required), `customerId`, `customerName` (<=150), `customerMobile`, `comments` (<=1000), `source` (`in_store` default, `qr`, `website`, `phone`, `other`)
Returns: 201, `data` = the first feedback page (as the list) plus `created` (the saved row). A known mobile links the guest automatically.
Errors: 400 rating not a whole 1-5 / selected customer does not exist; 409 picked guest was erased (`data.reason: "erased"`).

#### `PATCH /api/crm/feedback/:id/status`
Permission: `feedback.manage`
Body: `status` (`new`|`reviewed`|`archived`, required)
Returns: message only.
Errors: 404 feedback not found.

### Complaints

#### `GET /api/crm/complaints`
Permission: `feedback.view`
Query: `status` (comma list of `open`,`in_progress`,`resolved`,`closed`), `search`, `outletId` (one outlet's complaints only; the dashboard's panel with an outlet chosen), `limit` (<=200, default 200), `offset`
Returns: `data` = `{ summary { ...counts, compensationMonth, compensationTotal, compensated, linked, hoursToResolve }, items[], total, limit, offset, searchLimited }`. Each item carries `outletId`. The summary stays restaurant-wide.

#### `GET /api/crm/complaints/assignees`
Permission: `feedback.manage`
Returns: `data` = array of `{ id, name, roles }` (staff a complaint can go to).

#### `GET /api/crm/complaints/lookup`
Permission: `feedback.manage`
Query: `reference` (bill or order number, required, <=40); bill numbers are tried first
Returns: `data` = `{ billId, billNumber, orderId, orderNumber, orderType, orderStatus, billStatus, total, at, customerId, guestName, guestMobile }`.
Errors: 400 no match; 400 more than one match (`data.matches[]`).

#### `POST /api/crm/complaints`
Permission: `feedback.manage`
Body: `subject` (required, <=200), `description` (<=1000), `category` (`food`,`service`,`delivery`,`billing`,`hygiene`,`other` default), `priority` (`low`,`medium` default,`high`), `assignedTo` (user id), `reference` or `billId` / `orderId`, `compensationType` (`apology`,`replaced`,`removed`,`discount`,`complimentary`,`refund`,`voucher`,`points`), `compensationValue` (0-1000000), `compensationNotes` (<=300), `customerId`, `customerName`, `customerMobile`
Returns: 201, `data` = the complaint (status `open`). A linked bill's guest is attached when none is picked.
Errors: 400 assignee not your staff / inactive; 400 value without a type, or an apology with a value; 400 bill/order not in this restaurant or reference not found; 400 selected customer does not exist; 409 picked guest erased.

#### `PUT /api/crm/complaints/:id`
Permission: `feedback.manage`
Body: fields as for create, plus `complaintStatus` (required: `open`,`in_progress`,`resolved`,`closed`) and `resolution` (<=1000). Link and compensation fields left out are unchanged.
Returns: `data` = the updated complaint. A change in compensation is logged.
Errors: 400 `resolved`/`closed` without `resolution`; 400 as for create; 404 complaint not found.

## Guest insights

### Guest segments
Mounted at `/api/guest-insights`; read-only views over the guest book and its orders and bills for the token's restaurant. Segment keys: `regulars`, `new`, `lapsed`, `big-spenders`, `birthdays`, `anniversaries`, `unhappy`, `points`. Contact masking as in CRM.

#### `GET /api/guest-insights`
Permission: `customers.view`
Query/Body: none
Returns: `data` = `{ asOf, today, timezone, currency, history, kpis { guestsOnFile, activeGuests, activeShare, repeatRate, averageVisits, averageSpendPerVisit, newThisMonth, monthStart }, totals, segments[], distribution[], topGuests[], inHouse, loyalty, rules }`.
Errors: 404 restaurant not found.

#### `GET /api/guest-insights/guests`
Permission: `customers.view`
Query: `id` (positive whole number, required)
Returns: `data` = `{ items: [ { id, name, mobile/mobileMasked, status } ], total }`; an empty list (never 404) when the guest is not in this restaurant's book.
Errors: 400 id not a positive whole number.

#### `GET /api/guest-insights/segments/:key`
Permission: `customers.view`
Query: `search` (<=100), `limit` (1-5000, default 50)
Returns: `data` = `{ segment, currency, today, items[], total, limit }`.
Errors: 404 unknown segment key.

#### `POST /api/guest-insights/segments/:key/export`
Permission: `customers.view` and `customers.export`
Body: `format` (`csv` default | `mobiles`), `search` (<=100)
Returns: `data` = `{ segment, search, currency, today, items[], total, withMobile, contactHidden, format }`. Logged before it is returned.
Errors: 400 more than 5000 matching guests (narrow with `search`); 403 `format: "mobiles"` without `customers.contact`; 404 unknown key.

## Staff

### Employees
Mounted at `/api/staff` (login required on every route). Salary fields (`salaryType`, `salaryAmount`, planned salaries, PF/ESI/PT data) are left out of answers for users without `staff.salaries`. "Today" defaults use the restaurant's timezone.

#### `GET /api/staff`
Permission: `staff.view`
Query: `department` (`kitchen`,`service`,`management`,`delivery`,`housekeeping`,`other`), `status` (`active`|`inactive`), `search` (<=100)
Returns: `data` = array of employees (salary in force today and `plannedSalaries` when allowed).

#### `GET /api/staff/:id/salary-history`
Permission: `staff.view` and `staff.salaries`
Returns: `data` = `{ employeeId, name, salaryType, salaryAmount, paidThrough, earliestNewSalary, firstSalaryFrom, items[] { id, from, salaryType, salaryAmount, setBy, setAt } }`.
Errors: 404 employee not found.

#### `POST /api/staff`
Permission: `staff.manage`
Body: `name` (required, <=150), `employeeCode` (<=30, upper-cased), `mobile`, `email`, `designation`, `department` (default `service`), `employmentType` (`full_time` default,`part_time`,`contract`), `salaryType` (`monthly` default,`daily`,`hourly`), `salaryAmount`, `salaryEffectiveFrom`, `dateOfJoining`, `dateOfLeaving`, `outletId`, `userId` (login to link), `status`, `pfApplicable`, `esiApplicable`, `ptApplicable`, `uan` (12 digits), `esiNumber` (10-17 digits), `basicPercent` (50-100), `gender` (`female`,`male`,`other`), and more; see staff.controller.js
Returns: 201, `data` = the employee.
Errors: 400 leaving before joining / bad digits / outlet or login not in this restaurant; 409 login already linked to another employee; 409 employee code already used.

#### `PUT /api/staff/:id`
Permission: `staff.manage`
Body: as for create; salary and statutory fields left out stay as they are (a changed salary starts on `salaryEffectiveFrom`, default today).
Returns: `data` = the employee as the caller may see it.
Errors: 400 as for create; 404 not found; 409 new salary would start inside a period already marked paid; 409 code or login taken.

#### `DELETE /api/staff/:id`
Permission: `staff.manage`
Returns: message only.
Errors: 404 not found; 409 has attendance, rider deliveries, time-clock punches, pay records or other references (set inactive instead).

### Shifts

#### `GET /api/staff/shifts`
Permission: `staff.view`
Returns: `data` = array of shifts `{ id, name, startTime, endTime, breakMinutes, graceMinutes, status }`.

#### `POST /api/staff/shifts`
Permission: `staff.manage`
Body: `name` (required, <=100), `startTime` / `endTime` (`HH:MM`, required), `breakMinutes` (0-599, default 0), `graceMinutes` (0-119, default 10), `status`
Returns: 201, `data` = the shift.
Errors: 400 bad time; 409 a shift with that name exists.

#### `PUT /api/staff/shifts/:id`
Permission: `staff.manage`
Body: as for create.
Returns: `data` = the shift.
Errors: 404 not found; 409 duplicate name.

#### `DELETE /api/staff/shifts/:id`
Permission: `staff.manage`
Returns: message only.
Errors: 404 not found; 409 shift is on the roster.

### Roster

#### `GET /api/staff/roster`
Permission: `staff.view`
Query: `from` (default today), `to` (default `from`)
Returns: `data` = array of `{ id, employeeId, employeeName, shiftId, shiftName, startTime, endTime, workDate, assignmentStatus, leaveTypeId, leaveTypeName, notes }`.

#### `POST /api/staff/roster`
Permission: `staff.manage`
Body: `employeeId` (required), `shiftId` (required when scheduled), `workDate` (default today), `assignmentStatus` (`scheduled` default, `week_off`, `leave`), `leaveTypeId`, `acceptOverAllowance` (bool), `notes` (<=200). Upserts one person-day.
Returns: 201, `data` = that day's roster rows.
Errors: 400 employee/shift does not exist / no shift on a scheduled day / unknown leave type; 409 day already paid (`reason: "paid_period"`); 409 leave over allowance (`reason: "leave_over_allowance"`, resend with `acceptOverAllowance: true`).

#### `POST /api/staff/roster/copy-week`
Permission: `staff.manage`
Body: `weekStart` (date, required), `replace` (bool; overwrite filled days)
Returns: `data` = `{ copied, replaced, skipped[] { employeeId, name, date, reason }, from, to, sourceFrom, sourceTo }`. All or nothing; skip reasons `inactive`, `left`, `shift_not_used`, `paid`, `already_filled`.
Errors: 400 missing `weekStart`; 400 nothing on the previous week's roster (`reason: "empty_source"`).

#### `DELETE /api/staff/roster/:id`
Permission: `staff.manage`
Returns: message only.
Errors: 404 roster entry not found; 409 day already paid.

### Attendance

#### `GET /api/staff/attendance`
Permission: `staff.view`
Query: `date` (default today)
Returns: `data` = `{ date, rows[] }` (one row per employee with status, times, worked, late and overtime minutes).

#### `GET /api/staff/attendance/month`
Permission: `staff.view`
Query: `month` (`YYYY-MM`, default this month), `outletId`, `department`
Returns: `data` = muster roll `{ month, from, to, today, days[], rows[] (cells P/A/½/L/WO with late mark, per-person totals), totals { people, present, halfDays, absent, leave, weekOffs, lateDays, overtimeHours, unmarked } }`.
Errors: 400 bad month.

#### `POST /api/staff/attendance`
Permission: `staff.manage`
Body: `employeeId` (required), `attendanceDate` (default today), `shiftId`, `attendanceStatus` (`present` default,`absent`,`half_day`,`leave`,`week_off`), `checkInTime` / `checkOutTime` (`HH:MM` on the restaurant's clock) or `checkIn` / `checkOut` (timestamps), `leaveTypeId`, `acceptOverAllowance`, `notes`. Hours, lateness and overtime are computed by the server.
Returns: 201, `data` = the day's attendance rows.
Errors: 400 employee/shift does not exist / bad times / check-out before check-in / over 20 hours; 409 day recorded by the time clock (`reason: "clocked_day"`); 409 day already paid; 409 leave over allowance.

#### `POST /api/staff/attendance/mark-remaining`
Permission: `staff.manage`
Body: `date` (default today)
Returns: `data` = `{ present, weekOff, leave, skipped[] { name, reason } }`; marks unmarked people from the roster (shift times), skipping paid, clocked and unrostered people.
Errors: 400 date in the future.

### Leave

#### `GET /api/staff/leave/types`
Permission: `staff.view`
Returns: `data` = array of leave types.

#### `POST /api/staff/leave/types`
Permission: `staff.manage`
Body: `name` (required, <=40), `paid` (bool, default true), `allowanceDays` (0-366, required when paid), `allowancePeriod` (`month` default | `year`), `carryForward`, `countsFrom` (default start of this month/year), `isDefault`, `status`, `sortOrder` (0-999)
Returns: 201, `data` = the leave type.
Errors: 400 paid without allowance; 409 name exists.

#### `PUT /api/staff/leave/types/:id`
Permission: `staff.manage`
Body: as for create.
Returns: 200, `data` = the leave type.
Errors: 404 not found; 409 name exists.

#### `DELETE /api/staff/leave/types/:id`
Permission: `staff.manage`
Returns: message only.
Errors: 404 not found; 409 type already used on leave days (set inactive).

#### `GET /api/staff/leave/balances`
Permission: `staff.view`
Query: `employeeId` (required), `date` (default today)
Returns: `data` = `{ employeeId, name, date, types[] { typeId, name, paid, period, periodLabel, allowance, carriedIn, available, taken, left, unpaid } }`.
Errors: 404 employee not found.

#### `GET /api/staff/leave/register`
Permission: `staff.view`
Query: `date` (default today), `includeInactive` (`1`)
Returns: `data` = `{ date, types[], people[] { employeeId, name, employeeCode, designation, department, outletId, types[] } }`.

### Payroll
Every payroll route needs `staff.manage` and then `staff.salaries`. Ranges `from` (default today) / `to` (default `from`); `to` before `from` is 400. Net pay = earned + bonus + tips - advances - deductions - PF/ESI/PT employee share.

#### `GET /api/staff/payroll`
Permission: `staff.manage` and `staff.salaries`
Query: `from`, `to`
Returns: `data` = `{ from, to, settings, statutory { pfEnabled, esiEnabled, ptEnabled }, employees[] (days, hours, estimatedPay, bonus, tips, advances, deductions, PF/ESI/PT, netPay, payments, paid, changedSincePaid, partlyPaid), adjustments[], totals }`.

#### `GET /api/staff/payroll/settings`
Permission: `staff.manage` and `staff.salaries`
Returns: `data` = `{ weekOffsPaid, leavePaid, updatedAt }`.

#### `PUT /api/staff/payroll/settings`
Permission: `staff.manage` and `staff.salaries`
Body: `weekOffsPaid` (bool, default true), `leavePaid` (bool, default true)
Returns: `data` = the saved settings.

#### `GET /api/staff/payroll/statutory/settings`
Permission: `staff.manage` and `staff.salaries`
Returns: `data` = PF/ESI/PT settings plus `presets` (state professional-tax slabs).

#### `PUT /api/staff/payroll/statutory/settings`
Permission: `staff.manage` and `staff.salaries`
Body: `pfEnabled`, `pfEmployeeRate` / `pfEmployerRate` (0-100, default 12), `pfWageCeiling` (default 15000), `esiEnabled`, `esiEmployeeRate` (default 0.75), `esiEmployerRate` (default 3.25), `esiWageLimit` (default 21000), `ptEnabled`, `ptState`, `ptSlabs` (up to 20 `{ over, amount (0-2500), februaryAmount?, for?: "women" }`)
Returns: `data` = the saved settings.
Errors: 400 more than 20 slabs / two slabs starting at the same amount.

#### `GET /api/staff/payroll/statutory`
Permission: `staff.manage` and `staff.salaries`
Query: `month` (`YYYY-MM`, default this month)
Returns: `data` = `{ month, from, to, settings, people[] { employeeId, name, uan, esiNumber, grossPay, pfWages, pfEmployee, pfEmployer, esiWages, esiEmployee, esiEmployer, professionalTax, paid }, totals { pf, esi, professionalTax, payable, ... } }`.
Errors: 400 bad month.

#### `GET /api/staff/payroll/adjustments`
Permission: `staff.manage` and `staff.salaries`
Query: `from`, `to`
Returns: `data` = array of `{ id, employeeId, employeeName, date, kind, amount, note, ... }`.

#### `POST /api/staff/payroll/adjustments`
Permission: `staff.manage` and `staff.salaries`
Body: `employeeId` (required), `date` (default today), `kind` (`advance`|`deduction`|`bonus`, required), `amount` (0.01-9999999, required), `note` (reason, required, <=200)
Returns: 201, `data` = the adjustment.
Errors: 400 employee does not exist; 409 the date's pay period is already marked paid.

#### `DELETE /api/staff/payroll/adjustments/:id`
Permission: `staff.manage` and `staff.salaries`
Returns: message only.
Errors: 404 entry not found; 409 its period is already paid.

#### `GET /api/staff/payroll/payments`
Permission: `staff.manage` and `staff.salaries`
Query: `from`, `to`
Returns: `data` = array of payments `{ id, employeeId, employeeName, periodFrom, periodTo, earned, bonus, advances, deductions, netPay, amountPaid, paymentMethod, paidOn, carried[], ... }`.

#### `POST /api/staff/payroll/payments`
Permission: `staff.manage` and `staff.salaries`
Body: `employeeId` (required), `from`, `to`, `amountPaid` (default the net pay; less carries the rest forward), `paymentMethod` (`cash` default,`bank`,`upi`,`cheque`), `paidOn` (default today), `reference` (<=60), `note` (<=200). Figures are computed by the server and frozen on the payment.
Returns: 201, `data` = the payment.
Errors: 400 employee does not exist / period ends after today (`reason: "period_not_over"`) / nothing to pay / amount above net pay; 409 overlaps a period already paid.

#### `POST /api/staff/payroll/payments/bulk`
Permission: `staff.manage` and `staff.salaries`
Body: `employeeIds` (required, 1-500), `from`, `to`, `paymentMethod` (`bank` default, `cash`, `upi`, `cheque`), `paidOn` (default today), `reference` (<=60), `note` (<=200), `expectedTotal` (the total the pay sheet showed). "Mark all paid": each person is paid their full net pay for the period, in one transaction (all or none).
Returns: 201, `data` = `{ payments[], count, total }`. Each payment is written to the activity log on its own, as if paid one by one.
Errors: 400 nobody chosen, or more than 500; 400 period ends after today (`reason: "period_not_over"`); 400 `not_in_period` (someone has nothing to pay for the period); 409 `total_changed` `{ total }` (the pay changed by a rupee or more since the sheet was opened); 409 `already_paid` `{ employeeIds }` (someone is already paid for some of these days).

#### `DELETE /api/staff/payroll/payments/:id`
Permission: `staff.manage` and `staff.salaries`
Returns: message only ("Payment undone").
Errors: 404 payment not found; 409 the balance it carried forward was settled by a later payment (undo that first).

### Tips
Mounted at `/api/staff/tips`. Every route needs `staff.salaries`. Range `from` (default first of `to`'s month) / `to` (default today).

#### `GET /api/staff/tips`
Permission: `staff.salaries`
Query: `from`, `to`
Returns: `data` = `{ from, to, settings, days[], totals { count, tips, cash, card, upi, other, serviceCharge, shared, unshared }, people[], shareouts[] }`.

#### `GET /api/staff/tips/settings`
Permission: `staff.salaries`
Returns: `data` = `{ routing, includeServiceCharge, shareBasis, designationPoints, defaultPoints, ... }`.

#### `PUT /api/staff/tips/settings`
Permission: `staff.salaries`
Body: `routing` (`pool`|`captain`, required), `includeServiceCharge` (bool), `shareBasis` (`hours`|`points`, required), `designationPoints` (object `{ designation: 0-100 }`, up to 40), `defaultPoints` (0-100, default 1)
Returns: `data` = the saved settings.
Errors: 400 bad points object.

#### `POST /api/staff/tips/preview`
Permission: `staff.salaries`
Body: `from`, `to`, `payDate` (default `to`), `basis` (`hours`|`points`, default from settings), `excludeEmployeeIds` (array), `expectedTotal`, `note`
Returns: `data` = `{ from, to, payDate, basis, routing, includeServiceCharge, tipsTotal, tipCount, serviceChargeTotal, billCount, directTotal, poolTotal, poolShared, direct[], pool[], excluded[], warnings[] }`. Nothing is written.
Errors: 400 `to` after today (`reason: "future_period"`) / end before start.

#### `POST /api/staff/tips/shareouts`
Permission: `staff.salaries`
Body: as for preview; send `expectedTotal` (the total seen in the preview).
Returns: 201, `data` = the share-out `{ id, from, to, payDate, basis, routing, tipsTotal, serviceChargeTotal, directTotal, poolTotal, total, shares[] }`. Shares appear on payroll as a Tips line.
Errors: 400 future period / pay date before the period / nobody to share with; 409 `nothing_to_share`, `changed_since_preview` (`data.total`), `paid_period`, `already_shared`.

#### `DELETE /api/staff/tips/shareouts/:id`
Permission: `staff.salaries`
Returns: `data` = the removed share-out; its tips can be shared again.
Errors: 404 share-out not found; 409 a payroll payment already includes these tips (`reason: "paid_period"`).

### Log book
Mounted at `/api/staff/logbook`. Users pinned to an outlet see entries for their outlet and restaurant-wide ones. Categories: `maintenance`, `guest`, `stock`, `staff`, `other`.

#### `GET /api/staff/logbook`
Permission: `logbook.view`
Query: `from`, `to`, `outletId`, `category`, `search` (<=100), `open` (`1`/`true`: open follow-ups only), `limit` (1-200, default 50), `offset`
Returns: `data` = `{ items[] { id, body, category, outletId, outletName, tableId, tableLabel, shiftLabel, businessDate, needsFollowUp, open, closedAt, closedByName, closeNote, createdAt, createdByName, mine, readByMe, readBy[] }, total, limit, offset }`.
Errors: 400 end before start.

#### `GET /api/staff/logbook/handover`
Permission: `logbook.view`
Returns: `data` = `{ today, unread[], openFollowUps[], openCount }`.

#### `POST /api/staff/logbook/read`
Permission: `logbook.view`
Body: `ids` (array of entry ids, required, up to 200)
Returns: `data` = `{ marked }`.
Errors: 400 more than 200 ids.

#### `GET /api/staff/logbook/:id`
Permission: `logbook.view`
Returns: `data` = the entry.
Errors: 404 not found (or not visible to the caller's outlet).

#### `POST /api/staff/logbook`
Permission: `logbook.write` (outlet from `X-Outlet-Id` via resolveOutlet)
Body: `body` (required, <=1000), `category` (required), `tableId`, `outletId`, `needsFollowUp` (bool). A pinned user always writes for their own outlet.
Returns: 201, `data` = the entry (stamped with the business day and shift).
Errors: 400 outlet or table not in this restaurant / table at another outlet; 403 pinned user naming another outlet.

#### `POST /api/staff/logbook/:id/close`
Permission: `logbook.write`
Body: `note` (what was done, <=300)
Returns: `data` = the closed entry.
Errors: 404 not found; 409 entry did not need a follow-up / already closed.

## Time clock

### PIN time clock
Mounted at `/api/timeclock`. `staff.clock` is the entrance tablet (board, verify, punch); `staff.view` reads punches; `staff.manage` corrects punches and manages PINs. Actions: `clock_in`, `break_start`, `break_end`, `clock_out`. PINs are 4-6 digits sent as strings; 5 wrong PINs lock the PIN for 15 minutes.

#### `GET /api/timeclock/board`
Permission: `staff.clock`
Returns: `data` = `{ now, timezone, date, punchPhotos, counts { onDuty, onBreak, late, expected, left, absent, off, rostered, pastEnd, missedOut, noPin, nextStart }, staff[] }`.

#### `POST /api/timeclock/verify`
Permission: `staff.clock`
Body: `employeeId` or `employeeCode` (one required), `pin` (required)
Returns: valid: `data` = `{ valid: true, employee, state, ... , punches[] }`. A wrong, locked or missing PIN still answers 200 with `data` = `{ valid: false, reason: "wrong_pin"|"locked"|"no_pin", message, attemptsLeft, lockedUntil, employee, locked }`.
Errors: 400 no employee / PIN not 4-6 digits; 404 employee not found; 409 employee inactive.

#### `POST /api/timeclock/punch`
Permission: `staff.clock`
Body: `employeeId` or `employeeCode`, `pin`, `action` (required), `photo` (optional `data:image/jpeg|png|webp;base64,...` up to 150 KB; anything else is ignored)
Returns: 201, `data` = `{ punch { id, action, punchedAt, workDate, photoStatus }, employee, state, attendance { workDate, checkIn, checkOut, workedMinutes, breakMinutes, lateMinutes, overtimeMinutes }, confirmation }`.
Errors: 400 wrong PIN (`reason: "wrong_pin"`, `attemptsLeft`); 409 no PIN (`no_pin`); 423 PIN locked (`reason: "locked"`, `lockedUntil`); 409 action not allowed in the current state (`data.state`), missed clock-out (`reason: "missed_clock_out"`), clock not yet open for the shift (it opens `rules.timeclockEarlyMinutes` before a rostered shift, 60 until changed), overlap with another shift, day already paid; 404 employee not found.

#### `GET /api/timeclock/day`
Permission: `staff.view`
Query: `date` (2000-2099, default today on the restaurant clock)
Returns: `data` = `{ date, today, timezone, now, overtimeFromMinutes, rows[], totals { rostered, present, late, lateMinutes, absent, off, workedMinutes, breakMinutes, overtimeMinutes, missingClockOut } }`. `overtimeFromMinutes` is where overtime starts past a shift's end, the restaurant's rule (`rules.timeclockOvertimeMinutes`, 15 until changed).

#### `GET /api/timeclock/punches`
Permission: `staff.view`
Query: `from` (default today), `to` (default `from`), `employeeId`, `source` (`kiosk`|`manager`), `limit` (1-500, default 200)
Returns: `data` = `{ items[] { id, employeeId, employeeName, employeeCode, workDate, action, at, source, note, recordedBy }, total, limit }`.
Errors: 400 end before start / bad whole numbers.

#### `POST /api/timeclock/punches`
Permission: `staff.manage`
Body: `employeeId`, `workDate` (the day the shift started), `action`, `at` (ISO date-time), `note` (reason, required, <=200); all required
Returns: 201, `data` = `{ punch { id, action, at, workDate, source: "manager", note }, employee, attendance }`; the day is recalculated.
Errors: 400 time in the future / outside the work date (up to noon next day); 404 employee not found; 409 day already paid / punches out of order / overlap.

#### `DELETE /api/timeclock/punches/:punchId`
Permission: `staff.manage`
Body: `reason` (required, <=200)
Returns: `data` = `{ punch, employee, attendance, dayCleared, label }`.
Errors: 404 punch not found; 409 kiosk punch (only manager punches can be removed; `reason: "kiosk_punch"`); 409 day already paid.

#### `GET /api/timeclock/settings`
Permission: any of `staff.clock`, `staff.view`, `staff.manage`
Returns: `data` = `{ punchPhotos, photoKeepDays, ... }`.

#### `PUT /api/timeclock/settings`
Permission: `staff.manage`
Body: `punchPhotos` (bool), `photoKeepDays` (1-365, default 60). A shorter keep time purges older photos at once.
Returns: `data` = the saved settings.

#### `GET /api/timeclock/punches/:punchId/photo`
Permission: any of `staff.view`, `staff.manage`
Returns: the image bytes (not the JSON envelope), `Content-Type` image/jpeg|png|webp, `Cache-Control: private, no-store`.
Errors: 404 no photo for this punch.

#### `GET /api/timeclock/pins`
Permission: `staff.manage`
Returns: `data` = `{ timezone, items[] { ...employee, hasPin, pinSetAt, lockedUntil, recentFailures } }`.

#### `PUT /api/timeclock/pins/:employeeId`
Permission: `staff.manage`
Body: `pin` and `confirmPin` (4-6 digit strings, must match)
Returns: `data` = `{ employeeId }` (message says set or reset).
Errors: 400 PINs differ / too easy to guess (runs, repeats) / end of the employee's mobile; 404 employee not found; 409 employee inactive.

#### `DELETE /api/timeclock/pins/:employeeId`
Permission: `staff.manage`
Returns: `data` = `{ employeeId, hadPin }`.
Errors: 404 employee not found.

#### `POST /api/timeclock/pins/:employeeId/unlock`
Permission: `staff.manage`
Returns: `data` = `{ employeeId }`; clears the failure count and lock.
Errors: 404 employee not found.

## Reports

### Outlet selection, dates and caching
Mounted at `/api/reports`; every route runs `reportOutlet` (backend/src/middlewares/reportOutlet.js). The outlet is `?outletId=` or the `X-Outlet-Id` header (the query wins when both are sent); none means the whole restaurant. Unlike `resolveOutlet`, a closed outlet can be read. A user pinned to an outlet always reads that outlet. Outlet errors: 400 "That outlet id is not valid" (not 1-16 digits); 403 pinned user asking for another outlet; 403 the pinned outlet does not exist; 403 outlet not in your restaurant.
Range reports take `from` / `to` (real calendar dates); both left out means the current trading (business) day; `to` before `from` is 400; more than 731 days is 400. Range answers start with `{ from, to, outletId, outletName, outletClosed, timezone }` followed by the report's own fields.
The dashboard and dashboard/live answers are cached in process memory for 15 seconds (utils/dashboardCache.js). Any successful POST/PUT/PATCH/DELETE for the restaurant clears its cache at once.

#### `GET /api/reports/trading-day`
Permission: `reports.view`
Returns: `data` = `{ businessDate, businessDayId, dayOpen, openDays[], outletId, outletName, sharesMainDay, calendarDate, timezone }`.

#### `GET /api/reports/dashboard`
Permission: login only (contents depend on `sales.view`)
Returns: `data` = `{ businessDate, dayOpen, openDays, sharesMainDay, timezone, outletId, outletName, outletClosed, outletPinned, salesHidden, openOrders, tablesTotal, tablesOccupied, lowStockCount, openComplaints, unpaid, onAccount, expensesAwaitingApproval, poAwaitingDelivery, topItems[], lowItems[], soldLines, unsoldToday, covers }`; with `sales.view` also `billCount, netSales, averageBill, discounts, openOrderValue, trend, compare, byMethod, duesCollected, cash, refunds, voids, expensesToday, month, byHour` and money on items and unpaid counts. Cached 15 s per restaurant, outlet, sales visibility and pinning.

#### `GET /api/reports/dashboard/live`
Permission: login only; each block runs its own route's permission and outlet rules
Query: `blocks` (comma list; default all: `alerts`, `tables` (`tables.view`), `kitchen` (`kds.view`), `reservations` (`reservations.view`), `requests` / `deliveries` (`orders.view`), `staff` (`staff.clock`), `stock` (`inventory.view`), `guests` / `birthdays` (`customers.view`), `logbook` (`logbook.view`)). Unknown names are ignored; blocks the user may not read are left out. Blocks read the outlet from `X-Outlet-Id` (the `outletId` query is not passed to blocks).
Returns: `data` = `{ serverTime, blocks: { <key>: { data } | { error, status } } }`; one failed block does not fail the rest. Cached 15 s per user, outlet and block set.

#### `GET /api/reports/live/kitchen`
Permission: `kds.view`
Returns: `data` = `{ serverTime, businessDate, dayOpen, warnMinutes, lateMinutes, newCount, cookingCount, readyCount, openCount, lateNow, oldestWaitingAt, avgReadySeconds, timedToday, lateToday, servedToday }`.

#### `GET /api/reports/sales`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`
Returns: `data` = range header + `{ summary, byDay[], daysTraded, byHour[], byOrderType[], byPaymentMode[] }`.

#### `GET /api/reports/items`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`
Returns: `data` = range header + `{ items[], itemTotals, categories[], addons[], menu }`.

#### `GET /api/reports/profitability`
Permission: `reports.view`, `sales.view` and `inventory.view`
Query: `from`, `to`
Returns: `data` = range header + `{ dishes[] (sales, food cost and contribution per dish and size), totals }`.

#### `GET /api/reports/tax`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`
Returns: `data` = range header + `{ gstNumber, gstSplit, lines[], totals, untaxedServiceCharge }`.

#### `GET /api/reports/gst`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`, `gstin` (<=20; a registration, or `none` for bills issued without a GSTIN; default the outlet's or restaurant's own)
Returns: `data` = range header + `{ gstNumber, state, placeOfSupply, gstSplit, registrations[], register[], registerTotals, b2b, b2c, nilExempt, hsn, creditNotes, net, documents, untaxedServiceCharge, checks, warnings }` (the GSTR-1 style pack for one registration).

#### `PUT /api/reports/gst/bills/:id/recipient`
Permission: `billing.manage`, `reports.view` and `sales.view`
Body: `gstin` (valid GSTIN, required), `legalName` (required, <=150), `address` (<=300)
Returns: `data` = `{ billId, billNumber, recipientGstin, recipientName, recipientSource }`; the bill becomes a B2B invoice. A pinned user may only change their outlet's bills.
Errors: 400 missing/invalid GSTIN; 404 bill not found (or another outlet's for a pinned user); 409 bill is void.

#### `DELETE /api/reports/gst/bills/:id/recipient`
Permission: `billing.manage`, `reports.view` and `sales.view`
Returns: `data` = as for PUT, with the recipient cleared; the bill is an ordinary B2C sale again.
Errors: 404 bill not found / has no GSTIN written on it.

#### `GET /api/reports/discounts`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`
Returns: `data` = range header + `{ rows[], totals }`.

#### `GET /api/reports/staff`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`
Returns: `data` = range header + `{ rows[] }` (sales by staff member).

#### `GET /api/reports/waiters`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`
Returns: `data` = range header + `{ rows[], totals, sections[] }`.

#### `GET /api/reports/outlets`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`
Returns: `data` = range header + `{ comparesAllOutlets, total, outlets[] }`.

#### `GET /api/reports/cancellations`
Permission: `reports.view` and `sales.view`
Query: `from`, `to`
Returns: `data` = range header + `{ cancelledTotals, voidedTotals, cancelledOrders[], voidedBills[] }`.

#### `GET /api/reports/day-end`
Permission: `reports.view` and `sales.view`
Query: `businessDayId` (id) or `businessDate` (date); neither means the day being traded (else the latest day)
Returns: `data` = the Z report `{ businessDayId(s), businessDate(s), dayStatus, openedAt, closedAt, outletId, outletName, billCount, grossSales, netSales, discounts, tax, cgst, sgst, cess, serviceCharge, roundOff, byMethod, byOrderType, voids, cancellations, covers, drawers[], openingCash, cashSales, expectedCash, closingCash, variance, refunds, tips, rider cash, notes, logbook }` (`logbook` only with `logbook.view`), and more; see report.service.js `dayEnd`.
Errors: 404 business day not found (or another outlet's); 404 no business day opened yet / on that date.

#### `GET /api/reports/profit-loss`
Permission: `reports.view`, `sales.view` and `expenses.view`
Query: `from`, `to`, `basis` (`consumption` default | `purchases`, the food-cost basis)
Returns: `data` = range header + `{ basis, payrollShown, months[], lines[], ratios, shared, notes[], warnings[] }`. Salaries are included only for `staff.salaries`; otherwise the statement stops at profit before salaries.

#### `GET /api/reports/day-book`
Permission: `reports.view`, `sales.view` and `expenses.view`
Query: `from`, `to`
Returns: `data` = range header + `{ vouchers[], totals, ledgers[], salariesIncluded, purchasesIncluded, notes[] }`. Salaries need `staff.salaries`; supplier bills, returns and payments need `purchasing.view`.

#### `GET /api/reports/consumption`
Permission: `reports.view`
Query: `from`, `to`
Returns: `data` = range header + `{ rows[] }` (stock used, in money terms).

#### `GET /api/reports/kitchen-stations`
Permission: `reports.view`; feature `kitchen_display`
Query: `from`, `to` (the business days dated in the range; the trading day when left out). The outlet chosen in the top bar narrows it.
Returns: `data` = range header + `{ warnMinutes, lateMinutes, cancelledLeftOut, total, stations[], hours[] }`. Each station (and `total`, the whole kitchen, null with no ticket) = `{ stationId, stationName, stationColor, tickets, dishes, timedReady, avgReadySeconds, p90ReadySeconds, timedServe, avgServeSeconds, p90ServeSeconds, late, cleared, busiestHours[{ hour, tickets }] }`: tickets and dishes (live quantities), sent to ready and ready to served in whole seconds (average and 90th percentile; ready to served for the tickets marked ready before they were served), the tickets past the late mark (`lateMinutes`, the kitchen timers), those cleared without being served, and the three hours with the most tickets sent (restaurant's clock). `hours` is the whole kitchen's tickets by hour sent. Cancelled tickets are left out and counted in `cancelledLeftOut`.
Errors: 400 a date not real, the end before the start, or more than two years; 403 without `reports.view`; 403 `feature_off`.

#### `GET /api/reports/expenses`
Permission: `reports.view` and `expenses.view`
Query: `from`, `to`
Returns: `data` = range header + `{ months[], categories[], byMonth[], byMode[], total, approvedCount, pending, rejected, shared }`.

#### `GET /api/reports/theft`
Permission: `audit.view` and `reports.view`
Query: `from`, `to`, `discountPercent` (1-100), `discountAmount` (>=1) for what counts as a large discount; left out, the restaurant's own line (`rules.alertLargeDiscountPercent` and `alertLargeDiscountAmount`, the line the bell rings at; 20 and 1000 until changed)
Returns: `data` = range header + `{ thresholds, cashShortNote, summary, staff[], voids[], refunds[], discounts[], reprints[], removed[], cashShort[], limit: 500 }`.

#### `GET /api/reports/audit-log`
Permission: `audit.view`
Query: `entityType` (<=50), `action` (<=50), `limit` (1-500, default 200). Not narrowed by outlet.
Returns: `data` = `{ items[] { id, userName, action, entityType, entityId, entityLabel, details, createdAt }, total, limit }`, newest first; salary money in payroll rows is redacted.

---

## Bills, payments and money

### Approvals and money rules in this section

Several money steps use the shared manager-approval flow (`X-Approval-Token`, see the intro). The 403 `approval_required` body carries a `scope`, and the token must have been issued for those same facts (`approval.service.js` `SCOPE_FIELDS` / `normaliseScope`). An `id` or `text` fact must match exactly. An `upTo` fact (`amount`, `percent`) may come in lower than approved but never higher. A `money` fact (`closingCash`) must match to the paisa, and a `flag` (`carryUnpaid`) must be the same. A token is spent when it is used and is not handed back if the action then fails. Every approval route first runs its own checks (bill found in scope, reason given, state allows it), so a refusal comes back before a PIN is asked for.

| Step | Route | Permission that skips the prompt | When asked | `scope` sent and checked | Prompt `action` |
|---|---|---|---|---|---|
| Till discount (bill or dishes) | `PATCH /api/bills/:id/adjust` | `bills.discount` (and the role's cap) | the till discount changes and is above 0 | `{ billId, percent, amount }` (percent and amount of the till discount) | give a discount |
| Lowering a printed bill | `PATCH /api/bills/:id/adjust` | `bills.discount` | the bill was printed and the change lowers its total (coupon, points, service charge declined) | `{ billId, amount }` (how much lower) | give a discount |
| No-charge bill | `PATCH /api/bills/:id/adjust` | `bills.complimentary` | the bill becomes complimentary | `{ billId, amount }` (the subtotal) | make a bill complimentary |
| Delivery charge off | `PATCH /api/bills/:id/adjust` | `orders.waive_delivery_charge` | the delivery charge is taken off | `{ billId, amount }` (the full charge) | take off the delivery charge |
| Reprint | `POST /api/bills/:id/print` | `bills.reprint` | any print after the first | `{ billId }` | reprint a bill |
| Payment method correction | `PATCH /api/bills/:id/payments/:paymentId` | `bills.payment_correct` | always | `{ billId, paymentId, amount, fromMethod, toMethod }` | correct how a payment was taken |
| Put on account | `PATCH /api/bills/:id/account` | `customers.credit` | always (also for taking it off) | `{ billId, customerId, amount }` (amount = what is due on the bill; `customerId` absent when taking it off) | put a bill on a guest's account |
| Bill refund | `POST /api/bills/:id/refunds` | `bills.refund` | always | `{ billId, amount }` | give a refund |
| Void | `PATCH /api/bills/:id/void` | `bills.void` | always, printed or not | `{ billId }` | void a bill |
| Advance refund | `POST /api/bills/advances/:id/refunds` | `advances.refund` | always | `{ advanceId, amount }` | hand back an advance |
| Close the day | `POST /api/business-day/close` | `business_day.close` | always | `{ businessDayId, closingCash, carryUnpaid }` | close the business day |
| Cash in / out | `POST /api/business-day/movements` | `cash.movements` | always | `{ businessDayId, amount }` | (no label; "do this") |
| Cancel a cash entry | `POST /api/business-day/movements/:id/cancel` | `cash.movements` | always | `{ businessDayId, amount }` of the entry | (no label; "do this") |

**Discount caps.** A role can carry a cap on how many percent off a bill its holders may give. A user with `bills.discount` who is capped below the till discount gets 403 `{ reason: "discount_limit", limit, percent, permission }` naming who can give it. A manager approving for someone else must be allowed that percentage too. Otherwise 403 "<name> can approve up to N% off…". `GET /api/bills/till-options` returns the caller's own cap.

**Business day.** Money always goes into an open business day. A payment goes into the bill's outlet's open day, or the day the bill was raised in if that is still open. Refunds and advances go the same way. Collections on an account and new advances go into the open day of the till taking them (the outlet in `X-Outlet-Id`, or the main counter). With no open day these answer 409 "Open the business day first…". Payment-method corrections and cash-entry cancellations are refused (409) once the payment's or entry's day is closed.

**Outlet scoping.** `/api/bills` and `/api/business-day` run `resolveOutlet`. A user pinned to one outlet sees and acts on that outlet's bills, advances and accounts only. Another outlet's bill answers 404 "Bill not found" (checked by `billInScope` before any approval). Business days, drawers and cash entries belong to one till: an outlet's own day, or the main counter's (no outlet). `/api/discounts/given` uses `reportOutlet`.

**Payment methods.** `cash`, `card`, `upi`, `online`, `wallet`, `other`. Bills also accept `advance` (paid from a guest's advance). A named payment type (`paymentTypeId`) must belong to the same method and be active. If the type needs a reference, `transactionRef` is required. Otherwise 400 "That payment type was not found…", "<type> is a Card type, not UPI", "<type> is switched off…" or "Write the <type> reference…".

**The cash limit and the buyer's PAN** (Income-tax Act 2025, section 186, and the rules on quoting PAN; migration 1791972000000). The database refuses, whichever route writes the row:

- cash of ₹2,00,000 or more for one bill: its cash payments with their tips, and what it took from an advance paid in cash. 409 "Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): <bill> would reach ₹N. Take the rest by UPI, card, bank transfer or cheque.";
- cash of ₹2,00,000 or more from one guest on one day of the restaurant's calendar: cash on the bills that name them (the guest or company whose account a bill is on, else the order's guest), with the tips, and their advances in cash. A payment from an advance is not counted again, and a walk-in bill (no guest) is limited per bill only. 409 "Cash of ₹2,00,000 or more cannot be taken from one guest in a day (Income-tax Act 2025, section 186): today's cash from <guest> would reach ₹N. Take the rest by UPI, card, bank transfer or cheque.";
- any payment on a bill over ₹2,00,000 without `buyerPan` or `panDeclaration` on it. 409 "A bill over ₹2,00,000 needs the buyer's PAN before it takes a payment: <bill> has none…". The PAN inside the bill's buyer GSTIN is written on the bill with its first payment instead.

The paths are a payment, a correction to cash, a collection on an account, a rider's settlement, an advance (a pre-order's included) and a payment from an advance. Nothing of the refused request is kept.

---

### Bills

Mounted at `/api/bills` (`authenticate`, `resolveOutlet`). Amounts are always worked out on the server from the order (`billPricing.js`), never taken from the request. Named paths come before `/:id`.

#### `GET /api/bills`
Permission: `orders.view`
Query/Body: `status` (comma list of `unpaid`, `partial`, `paid`, `void`), `businessDayId`, `orderId`, `search` (≤60: bill or order number, guest name, or 4+ digits of a mobile), `complimentary=true`, `from`, `to` (dates), `limit` (1 to 500, default 100). Optional paging: `page`, `pageSize` (25/50/100).
For the dashboard's panels: `businessDays` (comma list of business day ids, at most 200 — the bills of every open day, as Sales today counts them), `account` (`none`: bills not on a guest's or company's account, as Unpaid bills counts them; `only`: just those, as Bills on account counts them), `outletId` (one outlet's bills, for someone who may see every outlet's; staff tied to an outlet always get their own, whatever is asked).
Returns: `data` = `{ items[], total, limit, page, pageSize }`. `pageSize` is null when not paged. Each item is the full bill shape, as in the detail.
Errors: 400 end date before start date; 400 bad page size; 400 `businessDays` not a list of ids; 400 `account` not `none`/`only`.

#### `GET /api/bills/:id`
Permission: `orders.view`
Query/Body: none
Returns: `data` = the bill: `{ id, billNumber, orderId, orderType, brandName, outletId, businessDayId, businessDate, customerId, subtotal, couponDiscount, manualDiscount, itemDiscountAmount, discountReason, taxAmount, serviceCharge, serviceChargeWaived, deliveryCharge, roundOff, totalAmount, paidAmount, refundedAmount, creditedAmount, heldAmount, dueAmount, billStatus, isComplimentary, loyaltyPointsUsed, printCount, isSplit, items[], payments[], tipTotal, corrections[], refunds[], creditNotes[], accountCustomerId, accountName, invoice, pointsEarned, pointsTakenBack, pointsBalance, buyerPan, panDeclaration, panNeeded, panInGstin, panInGuestBook, guestDeclaredNoPan, cashLimit }` and more (`bill.service.js` `toBill`). Mobiles are masked without `customers.contact`.
The buyer's PAN: `buyerPan` (the PAN on the bill, or null), `panDeclaration` (the buyer's Form 97 declaration that they have none), `panNeeded` (the bill is over ₹2,00,000, so a payment needs one of the two), `panInGstin` (with no PAN on the bill, the PAN inside the buyer's GSTIN, which the first payment writes on it), `panInGuestBook` (failing those, `{ pan, masked }`: the PAN the guest book keeps for the guest the bill names, which the first payment writes on it; `pan` is null without `customers.contact`), `guestDeclaredNoPan` (the guest book says the guest declared none: a reminder only, the declaration is taken on each bill). The list (`GET /api/bills`) carries these too, without `panInGstin` and `panInGuestBook`.
The cash limit (this read only): `cashLimit` = `{ limit: 200000, bill: { taken, left }, guest: { customerId, name, taken, left } | null, pan?: { panEnding, taken, left }, left }`: the cash taken for the bill (cash payments with their tips, and payments from advances paid in cash), the cash taken today on the restaurant's clock from the guest it names (with the walk-in bills carrying the PAN their guest book holds; null for a walk-in), for a walk-in bill carrying the buyer's PAN the cash under that PAN today (`pan`: every walk-in bill carrying it and the guests whose guest book holds it), what more each can take in cash (₹1,99,999.99 less what was taken, at least 0), and `left`, the smaller. Someone who sees bills as the guest does (`orders.view` without `sales.view` or `payments.manage`) gets `cashLimit: null`.
Errors: 404 not found or another outlet's bill.

#### `POST /api/bills`
Permission: `billing.manage`
Query/Body: `orderId` (required). `items` (optional `[{ orderItemId, quantity }]`): when left out, everything still unbilled is billed. A subset splits the order across bills (`isSplit`); each bill is checked on its own total for the buyer's PAN and on its own cash for the cash limit. Also `discountCode` (≤30), `loyaltyPoints` (1 to 1,000,000), `serviceCharge` (`{ waive: true, reason }` needs the reason), `buyer` (`{ pan }`, any case, or `{ panDeclaration: true }`: the buyer's PAN, or their Form 97 declaration, given before the bill is raised; it is recorded on the bill and in the activity log as `buyer_pan`).
Returns: status 201, `data` = the new bill. A delivery charge goes on the order's first bill only. The bill takes the outlet's GSTIN when the outlet has one. A bill over ₹2,00,000 is raised without a PAN too; it takes no payment until one is on it.
Errors: 404 order not found or another outlet's; 409 order not open; 400 no items, "Only N of X is left to bill", nothing left to bill; 400 "Buyer PAN must look like ABCDE1234F: five letters, four digits and a letter", or both a PAN and the declaration; 400 coupon refused (not found, inactive, dates, usage limit, minimum order, order type, weekdays or hours, once per guest, chosen dishes only); 400 points refused (switched off, no guest, too few, under the minimum, over the per-bill limit `reason: "points_limit"`); 400 no service charge to take off; 409 part of the order billed a moment ago.

#### `GET /api/bills/billable/:orderId`
Permission: `billing.manage`
Query/Body: none
Returns: `data` = `{ orderId, orderNumber, orderStatus, items[{ orderItemId, itemName, variantName, quantity, billedQuantity, remainingQuantity, unitPrice, lineTotal }] }`. Use it to choose lines for a split bill.
Errors: 404 order not found or another outlet's.

#### `PATCH /api/bills/:id/adjust`
Permission: `billing.manage`, then decided by the change: `bills.discount` (with the role cap), `bills.complimentary` or `orders.waive_delivery_charge`, or manager approval (see the table above)
Query/Body (each optional, at least one): `discountCode` (null removes), `loyaltyPoints` (0 or null removes), `manualDiscount` (`{ type: "percentage"|"amount", value }` or null), `itemDiscounts` (the whole set `[{ orderItemId, type, value }]`, one per dish), `discountReason` (`regular`, `delay`, `complaint`, `birthday`, `bulk`, `promotion`, `staff`, `other`) + `discountNote` (≤200), `serviceCharge` (`{ waive, reason }`), `deliveryCharge` (`{ waive, reason }`, must be sent on its own), `complimentary` (`{ reason, note }`, reasons `staff_meal`, `owner_guest`, `complaint`, `tasting`, `promotion`, `other`).
Returns: `data` = the updated bill. The bill keeps its number.
Errors: 400 nothing to change; 409 bill voided; 409 bill settled ("Give money back with a refund instead"); 400 reason missing or not in the list, or `other` without a note; 409 money already paid makes no-charge or a lower total impossible ("Give it back first"); 400/409 delivery-charge rules; 400 coupon or points refused (as in create); 400 `credit_limit` when a bill on an account would owe more than the limit; 403 `discount_limit`; 409 changed at another till.

#### `POST /api/bills/:id/adjust/check`
Permission: `billing.manage`
Query/Body: the same body as adjust
Returns: `data` = `{ approval: null | { permission, action, scope }, refused: null, totalAmount, tillAmount }`. If the change would be refused, the answer is still 200: `{ approval: null, refused: { message, status, reason?, ... } }` (covers 400, 403 and 409 refusals, including `discount_limit`). Nothing is written.
Errors: 400 nothing to change or bad input; 404 bill not in scope.

#### `POST /api/bills/:id/payments`
Permission: `payments.manage`
Query/Body: `paymentMethod` (required, the six methods or `advance`), `amount` (required, 0.01 and up), `tenderedAmount` (cash given), `transactionRef` (≤100), `tipAmount` (0 to 999,999, on top of the amount), `paymentTypeId`, `advanceId` (required for `advance`), `buyer` (`{ pan }` or `{ panDeclaration: true }`: typed on the payment screen, written on the bill with the payment, and logged as `buyer_pan` when it changes what the bill carried).
Returns: status 201, `data` = the bill with the new payment. Change = tendered − amount − tip, given only in cash. A tip never counts toward sales, GST, discount base or points. Points are earned when the bill is paid in full.
Errors: 409 voided; 409 "This bill is already paid in full"; 409 no business day open; 400 "Only N is still due…" (extra money is a tip); 400 cash given less than payment plus tip; 400 no advance picked or a tip on an advance payment; 404 advance not found; 400 advance has only N left; 400 payment-type errors; 400 the buyer's PAN not like ABCDE1234F, or both a PAN and the declaration; 409 the cash limit for the bill or for its guest's day, or a bill over ₹2,00,000 with no buyer's PAN (see [the cash limit and the buyer's PAN](#approvals-and-money-rules-in-this-section)); nothing of the refused payment, or of the PAN sent with it, is kept.

#### `PUT /api/bills/:id/pan`
Permission: `billing.manage` or `payments.manage`
Query/Body: `pan` (any case, like ABCDE1234F), or `panDeclaration: true` (the buyer has no PAN and signed Form 97); one of the two.
Returns: `data` = the bill with `buyerPan` and `panDeclaration`. Message: "<bill> records the buyer's PAN …" or "…their declaration that they have no PAN (Form 97)". For a bill over ₹2,00,000 before it is paid, as on the payment screen, or before it is collected on an account. It replaces what the bill carried while the bill is not settled; the activity log keeps the change (`buyer_pan`, `{ changes: { pan: [before, after] } }`). The same again changes nothing.
Errors: 400 neither given ("Type the buyer's PAN, or record their declaration…"), a PAN not like ABCDE1234F, or both; 403 neither permission; 404 not found or another outlet's bill; 409 voided; 409 settled ("…it keeps the buyer's PAN it was paid with").

#### `PATCH /api/bills/:id/payments/:paymentId`
Permission: `payments.manage` and (`bills.payment_correct` or manager approval)
Query/Body: `paymentMethod` (required, the six methods; not `advance`), `paymentTypeId`, `transactionRef`, `reason` (required, ≤200)
Returns: `data` = the bill. Message: "The N payment is now recorded as UPI". Only the method, type and reference change. The amount stays the same. Each correction is kept in `payment_corrections`.
Errors: 404 payment not on this bill; 409 voided; 409 payment did not go through; 409 the payment's business day is closed (refund and take it again instead); 400 advance payments cannot change method; 400 change was given in cash, so it must stay cash; 400 nothing would change; 400 payment-type errors; 409 as cash it would reach the cash limit for the bill or for its guest's day (the database's own answer, asked before any approval, so none is spent); 403 approval scope mismatch.

#### `PATCH /api/bills/:id/account`
Permission: `billing.manage` and (`customers.credit` or manager approval)
Query/Body: `customerId` (required; `null` takes the bill off the account), `note` (≤200)
Returns: `data` = the bill. Message: "<bill> is on <name>'s account · ₹N due". The bill's order is closed and the table freed.
Errors: 409 voided; 409 bill settled; 400 not on anyone's account (when taking off); 404 guest not found; 400 guest has no account; 400 account on hold; 409 already on this account; 400 `{ reason: "credit_limit", outstanding, limit, due }` over the limit (also when another bill went on a moment ago).

#### `POST /api/bills/:id/refunds`
Permission: `payments.manage` and (`bills.refund` or manager approval)
Query/Body: `amount` (required), `reason` (required, ≤200), `refundMethod` (optional when the bill was paid one way; `advance` puts it back on the advance it was paid from), `paymentTypeId` (needs `refundMethod`), `reversePoints` (default true), `items` (`[{ orderItemId, quantity }]` for dishes returned; the amount must equal their value)
Returns: status 201, `data` = the bill. On a settled bill a GST credit note is issued (`kind: "credit_note"`; message "Refund recorded · credit note CN-…") and the bill stays paid. On an unsettled bill the payment is handed back (`payment_reversal`) and the amount is owed again.
Errors: 409 voided; 409 nothing paid that could be given back; 400 "Only N can be refunded"; 400 more than one method used, so name one; 400 dish returns only on a settled bill, dish not on the bill, too many returned, amount differs from the dishes' value, a bill line with no taxable value stored (refund an amount instead); 400 nothing paid from an advance or more than the advance part; 400 `credit_limit` (handing back on an account bill); 409 no business day open; 409 changed at another till.

#### `PATCH /api/bills/:id/void`
Permission: `billing.manage` and (`bills.void` or manager approval, always)
Query/Body: `reason` (required, ≤200)
Returns: `data` = the voided bill. Message: "Bill voided and the order reopened".
Errors: 400 no reason; 409 already void; 409 still holds money paid (refund first); 409 settled bill (refund instead); 409 bill went on an account.

#### `POST /api/bills/:id/print`
Permission: `orders.view`. The first print is free. Any later print needs `bills.reprint` or manager approval `{ billId }`
Query/Body: none
Returns: `data` = the bill plus `copy` (`original` | `duplicate`) and `printCount`. Message: "Print recorded" or "Duplicate copy N recorded". Every print is counted, and reprints are written to the activity log. If another till printed the first copy a moment earlier, the request is treated as a reprint. The paper prints `buyerPan` (*Buyer PAN*), or that the buyer's Form 97 declaration is held.
Errors: 403 `approval_required` for a reprint; 404 not found.

#### `GET /api/bills/day-summary`
Permission: `sales.view`
Query/Body: `businessDayId` (optional), `scope` (`restaurant` default | `counter`)
Returns: `data` = `{ businessDayId, businessDate, dayOpen, days[{ businessDayId, businessDate, outletId, outletName }], billCount, salesTotal, collected, duesCollected, refunded, cashRefunded, discounts, serviceCharge, tax, complimentaryCount, voidCount, dueNow, onAccount, tips, advancesTaken, cashAdvances, advancesReturned, cashAdvancesReturned, byMethod[{ paymentMethod, amount, tips }], byType[{ paymentMethod, paymentTypeId, paymentTypeName, amount, count }] }`. With All outlets and `restaurant` scope it adds up every open day. With an outlet chosen, or `counter`, it covers that till's open day. With no open day it returns zeros and `dayOpen: false`.
Errors: 404 business day not found or another outlet's.

#### `GET /api/bills/till-options`
Permission: `orders.view`
Query/Body: none
Returns: `data` = `{ discountReasons[{ value, label }], complimentaryReasons[{ value, label }], myDiscountLimit (null = no cap, 0 = every discount needs a manager), canDiscount, canComplimentary, canReprint }`.

#### `GET /api/bills/credit-notes`
Permission: `orders.view` and `sales.view`
Query/Body: `from`, `to` (dates), `limit` (1 to 500, default 200). Optional paging: `page`, `pageSize` (25/50/100).
Returns: `data` = `{ items[{ id, number, kind, reason, billId, billNumber, refundMethod, taxableValue, serviceChargeValue, taxAmount, cessAmount, roundOff, totalAmount, pointsReversed, issuedAt, businessDate, createdByName }], total, limit, page, pageSize }`.

#### `GET /api/bills/payment-corrections`
Permission: `sales.view` and `audit.view`
Query/Body: `from`, `to` (no dates = the current business day), `page`, `pageSize` (25/50/100, default 25)
Returns: `data` = `{ from, to, page, pageSize, total, totalAmount, items[{ id, billId, billNumber, businessDate, amount, oldMethod, newMethod, oldTypeName, newTypeName, oldReference, newReference, reason, correctedAt, correctedBy, approvedBy, outletName }] }`. Filtered to the outlet in the header, if one is chosen.
Errors: 400 end date before start date.

---

### Guest and company accounts

Mounted at `/api/bills/accounts` (inside the bills router: `authenticate`, `resolveOutlet`). A guest's account has a credit limit, days to pay and a status (`active` / `on_hold`). Bills go on it with `PATCH /api/bills/:id/account`.

#### `GET /api/bills/accounts/dues`
Permission: `sales.view`
Query/Body: none
Returns: `data` = `{ asOf, accounts[{ customerId, name, companyName, gstin, mobile, hasAccount, status, creditLimit, creditDays, outstanding, available, openBills, ageing{ current, days31to60, days61to90, over90 }, oldestDue, lastBillAt, lastPaidAt, advanceHeld }], totals{ accounts, owing, outstanding, current, days31to60, days61to90, over90, overdueAccounts, advanceHeld }, loose{ count, due, bills[] } }`. `loose` lists unpaid bills that are on nobody's account.

#### `GET /api/bills/accounts/:customerId/statement`
Permission: `sales.view`
Query/Body: `from`, `to` (dates, optional)
Returns: `data` = `{ customerId, name, gstin, hasAccount, creditLimit, creditDays, status, from, to, openingBalance, entries[] (kind `bill`/`payment`/`refund`/`credit_note`, each with running `balance`), totals{ debit, credit }, closingBalance, advances{ held, items[] } }`.
Errors: 404 guest not found; 400 end date before start date.

#### `GET /api/bills/accounts/:customerId/open-bills`
Permission: `sales.view`
Query/Body: none
Returns: `data` = `[{ billId, billNumber, totalAmount, due, businessDate, outletName }]`, used to pick what a collection settles.
Errors: 404 guest not found.

#### `PUT /api/bills/accounts/:customerId`
Permission: `customers.credit`
Query/Body: `creditLimit` (required, 0 to 99,999,999), `creditDays` (whole number 0 to 365), `status` (`active` | `on_hold`), `notes` (≤300)
Returns: `data` = the account (shape as in dues). Opens the account if there is none. Message: "Account opened for X · limit ₹N" or "X's account updated…".
Errors: 404 guest not found; 400 guest not active; 400 days not a whole number.

#### `POST /api/bills/accounts/:customerId/collect`
Permission: `payments.manage`
Query/Body: `amount` (required), `paymentMethod` (required, the six methods), `transactionRef`, `billIds` (optional; otherwise oldest bills first)
Returns: status 201, `data` = `{ customerName, method, businessDayId, till, allocations[{ billId, billNumber, amount }] }`. The money goes into the open day of the till taking it. Cash collected is the account holder's: it counts toward their cash today and toward each bill it pays.
Errors: 404 guest not found; 400 owes nothing (on those bills); 400 "owes ₹N. Collect that much at most"; 409 `{ reason: "no_day", outletId }` when the till's day is not open; 409 the cash limit for a bill or for the account holder's day, or a bill over ₹2,00,000 with no buyer's PAN (record it with `PUT /api/bills/:id/pan` first): nothing of the collection is kept.

---

### Advances and deposits

Mounted at `/api/bills/advances` (feature `advances`). An advance is money held for a guest, not a sale. It becomes a sale on the bill it is used on (payment method `advance`). Status is `held`, `part_used` or `closed`. An advance can be taken for a booking (`reservationId`) or for an open pickup order (`orderId`).

#### `GET /api/bills/advances`
Permission: `sales.view`
Query/Body: `status` (`held` | `all`; default `held`, or `all` when dates are given), `customerId`, `search` (≤60), `from`, `to`, `page`, `pageSize` (25/50/100, default 25)
Returns: `data` = `{ items[advance], total, page, pageSize, totals{ amount, used, refunded, held } }`. An advance is `{ id, receiptNumber, customerId, customerName, customerMobile, amount, usedAmount, refundedAmount, heldAmount, status, paymentMethod, paymentTypeName, transactionRef, purpose, reservationId, orderId, orderNumber, outletName, businessDate, receivedAt, createdByName }`.
Errors: 400 end date before start date.

#### `GET /api/bills/advances/gst`
Permission: `sales.view`
Query/Body: `from`, `to` (business dates; default this month to date)
Returns: `data` = `{ from, to, rate, rates[], receivedCount, received, usedSamePeriod, table11A{ gross, taxable, cgst, sgst }, table11B{...}, byRate[{ rate, table11A, table11B }] }`. These are GSTR-1 tables 11A (received and not invoiced in the period) and 11B (earlier advances used in the period). Each advance is split at the restaurant's default GST rate of the day it was received (the rate before the first change of it applied after that day, else the rate now: [GST rate changes on the menu](#gst-rate-changes-on-the-menu)); `byRate` gives each rate's part and the tables add them up. `rate` is the default rate now, `rates` the rates the figures use. Changes of the default rate due on the trading date take effect first.

#### `GET /api/bills/advances/held/:customerId`
Permission: `payments.manage`
Query/Body: `orderId` (optional: that order's advance is listed first)
Returns: `data` = the guest's advances that still hold money (array of advances), used for "Pay from advance".

#### `GET /api/bills/advances/order/:orderId`
Permission: `payments.manage`
Query/Body: none
Returns: `data` = the advances taken on that order (array of advances), shown on the order screen.

#### `GET /api/bills/advances/:id`
Permission: `payments.manage`
Query/Body: none
Returns: `data` = the advance plus `usedOn[{ paymentId, billId, billNumber, amount, putBack, paidAt }]`, `refunds[{ id, amount, refundMethod, reason, refundedAt, createdByName, approvedByName }]`, `seller{ name, address, phone, gstin }` for the receipt.
Errors: 404 not found or another outlet's.

#### `POST /api/bills/advances`
Permission: `payments.manage`
Query/Body: `customerId` (required), `amount` (required, 1 to 9,999,999), `paymentMethod` (required, the six methods), `paymentTypeId`, `transactionRef`, `purpose` (≤200), and one of `reservationId` or `orderId`. `orderId` names an open takeaway of this restaurant that has no bill yet; the advance's guest must be the order's, and an order without a guest takes this one. Its purpose defaults to "Pickup order <number>".
Returns: status 201, `data` = the advance with its receipt number. It goes into the open day of the till taking it.
Errors: 400 both `reservationId` and `orderId`; 404 guest or order not found; 400 guest record erased; 409 the order is not a takeaway, is already billed, or is not open; 409 the order is another guest's; 409 no business day open; 400 payment-type errors; 409 an advance in cash that would take the guest's cash today to ₹2,00,000 (the cash limit).

#### `POST /api/bills/advances/:id/refunds`
Permission: `payments.manage` and (`advances.refund` or manager approval `{ advanceId, amount }`)
Query/Body: `amount` (required), `refundMethod` (required, the six methods), `paymentTypeId`, `transactionRef`, `reason` (required, ≤200)
Returns: status 201, `data` = the advance after the refund.
Errors: 404 not found; 409 nothing left to hand back; 400 "holds only N"; 409 no business day open; 400 payment-type errors.

---

### Discounts and coupons

Mounted at `/api/discounts` (`authenticate`). An offer is a coupon code with rules. The code is fixed once created and is stored in upper case with no spaces.

#### `GET /api/discounts`
Permission: `discounts.view`
Query/Body: none
Returns: `data` = array of offers `{ id, code, name, description, discountType, value, maxDiscountAmount, minOrderAmount, validFrom, validTo, usageLimit, usedCount, appliesTo, status, offerType, productIds, categoryIds, weekdays, timeFrom, timeTo, oncePerGuest, buyQuantity, getQuantity, getDiscountPercent }`.

#### `GET /api/discounts/given`
Permission: `discounts.view` and `sales.view` (`reportOutlet`)
Query/Body: `from`, `to` (no dates = the business day the till is on: the open day, else today), `page`, `pageSize` (25/50/100). The list is not paged unless one of these is sent; a page alone means 25.
Returns: `data` = `{ from, to, total, approvedCount, page, pageSize, totals{ discountBills, discountAmount, complimentaryBills, complimentaryAmount }, byReason[], byStaff[], items[{ billId, billNumber, kind (discount|complimentary), amount, percent, subtotal, totalAmount, manualDiscount, itemDiscountAmount, reason, reasonLabel, note, givenBy, approvedBy, ... }] }`. `total`, the totals and the groupings cover the whole period.
Errors: 400 end date before start date; 403 another outlet for a pinned user.

#### `POST /api/discounts`
Permission: `discounts.manage`
Query/Body: `code` (required, ≤30), `name` (required), `offerType` (`discount` | `buy_get`), `discountType` (`percentage`|`amount`) + `value` (for `discount`), `buyQuantity`, `getQuantity` (whole numbers 1 to 50) + `getDiscountPercent` (default 100) for `buy_get`, `maxDiscountAmount` (percentage only), `minOrderAmount`, `validFrom`, `validTo`, `usageLimit`, `appliesTo` (`all`, `dine_in`, `takeaway`, `delivery`, `online`), `status`, `productIds`, `categoryIds`, `weekdays` (0 to 6, Sun = 0), `timeFrom`/`timeTo` (HH:MM, both or neither), `oncePerGuest`
Returns: status 201, `data` = the offer.
Errors: 409 code already exists; 400 percentage over 100; 400 maximum on an amount discount; 400 dates reversed; 400 hours given half or equal; 400 buy-and-get without dishes or categories; 400 unknown dish or category.

#### `PUT /api/discounts/:id`
Permission: `discounts.manage`
Query/Body: the same fields as create, except `code` (it cannot change)
Returns: `data` = the offer. Changes are logged field by field.
Errors: 404 not found; the same 400s as create.

#### `DELETE /api/discounts/:id`
Permission: `discounts.manage`
Query/Body: none
Returns: `data` none; message "Offer deleted".
Errors: 404 not found; 409 the offer has been used (set it inactive instead).

#### `GET /api/discounts/loyalty`
Permission: `discounts.view` and `sales.view`; feature `guest_loyalty`
Query/Body: none
Returns: `data` = `{ rules{ enabled, earnAmount, pointValue, minRedeem, earnBasis, maxRedeemPoints, maxRedeemPercent, expiryDays }, summary{ pointsHeld, valueHeld, holders, last30{ earned, redeemed, expired }, expiringIn30Days{ points, guests } } }`. When expiry is on, expired points are written off first.

#### `PUT /api/discounts/loyalty`
Permission: `restaurant.settings.manage`
Query/Body: `enabled` (boolean, optional: when sent and different it switches the Loyalty points feature, under that feature's rules), `earnAmount` (spend for one point, 1 and up), `pointValue` (0.01 and up), `minRedeem`, `earnBasis` (`total` | `pre_tax`), `maxRedeemPoints` (blank = no limit), `maxRedeemPercent` (1 to 100, blank = no limit), `expiryDays` (1 to 3650, blank = never). All are sent in one save.
Returns: `data` = the programme, as in GET. Turning expiry on stamps an expiry on the points guests already hold. Turning it off clears it.

---

### Business day and cash

Mounted at `/api/business-day` (`authenticate`, `resolveOutlet`). Each till has its own day: an outlet's own, or the main counter's (no outlet). Only one day per till may be open. With blind counting on, anyone without `business_day.close` sees no expected cash (`expectedCash: null`, `blind: true`).

#### `GET /api/business-day`
Permission: `business_day.view`
Query/Body: none
Returns: `data` = `{ current (day or null), history[] (last 30), rules{ cutoffHour, varianceThreshold, blindCount, denominations[] }, opening{ today, dates, cutoffHour, taken[], suggested }, blind }`. A day is `{ id, businessDate, openedAt, closedAt, openingCash, closingCash, countedCash, countMethod, denominations, blindCount, firstCount, expectedCash, cashDropped, cashPaidIn, variance, varianceReason, methodChecks, reopenedCount, notes, openingNotes, closingNotes, dayStatus, openedByName, closedByName, outletId }`.

#### `GET /api/business-day/days`
Permission: `business_day.view`
Query/Body: `from`, `to` (real dates), `page`, `pageSize` (25/50/100, default 25)
Returns: `data` = `{ items[day], total, page, pageSize }` for this till.
Errors: 400 bad date or end before start.

#### `POST /api/business-day/open`
Permission: `business_day.manage`
Query/Body: `businessDate` (optional; default is today on the restaurant's clock, or last night's before the cut-off hour), `openingCash` (default 0), `notes` (≤500, stored as opening notes)
Returns: status 201, `data` = the day.
Errors: 400 `{ reason: "date_not_allowed", today, dates, cutoffHour }` (a future date, or a past one other than last night before the cut-off); 409 "Business day D is still open. Close it first."; 409 `{ reason: "date_closed", businessDayId }` (that date was already closed; reopen it instead).

#### `GET /api/business-day/rules`
Permission: `business_day.view`
Query/Body: none
Returns: `data` = `{ cutoffHour, varianceThreshold, blindCount, denominations[] }` (defaults 5, 100, false, and the notes 500, 200, 100, 50, 20, 10). `denominations` are the notes a cash count lists, largest first, set with the restaurant's rules (`rules.cashDenominations` on `PUT /api/restaurants/current/settings`); coins are always counted besides.

#### `PUT /api/business-day/rules`
Permission: `restaurant.settings.manage`
Query/Body: `cutoffHour` (required, 0 to 12), `varianceThreshold` (required, 0 to 100,000; over or short beyond this needs a reason), `blindCount` (required boolean)
Returns: `data` = the rules.

#### `GET /api/business-day/close-preview`
Permission: `business_day.manage`
Query/Body: none
Returns: `data` = `{ day, rules, blind, figures, blockers{ openOrders (count), unpaidBills[], pendingExpenses[], openDrawers[] } }`. `figures` = `{ openingCash, cashSales, duesCollectedCash, cashRefunds, cashExpenses, pettyCash, supplierCash, cashTips, riderShortfall, riderRepaid, cashAdvances, cashAdvancesReturned, paidIn, dropped, dayExpected, inDrawer, methods[{ method, taken, payments, refunded, net, duesCollected }] }`. A blind counter gets only the non-cash methods, `paidIn` and `dropped`.
Errors: 409 no business day open.

#### `POST /api/business-day/close/check`
Permission: `business_day.manage`
Query/Body: the close body (below)
Returns: `data` = `{ refused: null, businessDayId, variance, expectedCash (null when blind), threshold, approval: null | { permission: "business_day.close", scope{ businessDayId, closingCash, carryUnpaid } } }`. A refusal comes back as 200 `{ refused: { message, status, reason, ... } }`. Only the first count of a blind or over-threshold count is written.

#### `POST /api/business-day/close`
Permission: `business_day.manage` and (`business_day.close` or manager approval)
Query/Body: `closingCash` (required: the cash counted in the drawer), `countMethod` (`total` | `notes`), `denominations` (`{ "<note>": count, ..., coins: amount }` for the restaurant's notes, `"500"`, `"200"`, `"100"`, `"50"`, `"20"`, `"10"` until changed; must add up to `closingCash`; a note not on the list is refused with 400), `varianceReason` (≤300), `methodChecks` (`[{ method, matched: true }` or `{ method, reported, note }]` for each non-cash method), `carryUnpaid` (true carries unpaid bills over as dues), `notes` (≤500, stored as closing notes)
Returns: `data` = the closed day with `expectedCash`, `variance`, `cashDropped`, `cashPaidIn`. `closingCash` on the day = counted + dropped − paid in. Over or short beyond the threshold is also logged as `cash_short`/`cash_over`.
Errors: 400 no cash count; 409 no day open; 409 `open_orders` (no override); 409 `unpaid_bills` without `carryUnpaid`; 409 `pending_expenses`; 409 `open_drawers`; 400 `count_mismatch`; 400 `variance_reason_required { variance, threshold, expectedCash? }`; 400 `method_check_required` / `method_note_required`; 409 `drawer_changed` (cash moved while counting); 403 approval scope mismatch (a different count or carry choice needs a new approval).

#### `POST /api/business-day/:id/reopen`
Permission: `business_day.close` (no approval path)
Query/Body: `reason` (required, ≤300)
Returns: `data` = the reopened day. A note recording when, by whom, what was counted and the reason is added to the day.
Errors: 400 no reason; 404 not found or another till's day; 409 already open; 409 "Only the latest business day can be reopened"; 409 the date is past (only today's day, or last night's before the cut-off); 409 another day is open now.

#### `GET /api/business-day/drawers`
Permission: `business_day.view`
Query/Body: none
Returns: `data` = `{ day, rules, blind, drawers[{ id, cashierId, cashierName, label, status, openingFloat, openedAt, closedAt, countedCash, blindCount, firstCount, expectedAtClose, variance, varianceReason, figures }], myDrawerId, movements[], totals{ paidIn, dropped, pettyCash }, byCashier[] (needs sales.view), suggestedFloat }` for this till's open day. With no day open: `day: null` and empty lists.

#### `POST /api/business-day/drawers`
Permission: `business_day.manage`. Opening a drawer for someone else needs `business_day.close`
Query/Body: `openingFloat` (required), `cashierId` (default: the caller), `label` (≤60), `notes`
Returns: status 201, `data` = the drawer.
Errors: 409 `no_day`; 403 not a manager opening for someone else; 404 person not found; 400 login not active; 400 works at another outlet; 409 already has a drawer open on this day.

#### `POST /api/business-day/drawers/:id/close`
Permission: `business_day.manage`. Only the drawer's cashier or a holder of `business_day.close` may close it
Query/Body: `closingCash` (required), `countMethod`, `denominations` (the restaurant's notes, as for the day close), `varianceReason`, `notes`
Returns: `data` = the closed drawer (`countedCash`, `expectedAtClose`, `variance`). Over or short beyond the threshold is also logged.
Errors: 400 no count; 404 not found or another till's; 403 not the cashier or a manager; 409 already closed; 400 `count_mismatch`; 400 `variance_reason_required`.

#### `GET /api/business-day/x-report`
Permission: `business_day.view` and `sales.view`
Query/Body: `drawerId` (one drawer) or `cashierId` (one cashier's day; default the caller)
Returns: `data` = for a drawer, `{ kind: "drawer", printedAt, timezone, currency, blind, drawer, movements[] }`; for a cashier, `{ kind: "cashier", printedAt, blind, day, cashier, methods[{ method, taken, payments, refunded, net }], tips[], bills{ count, sales, discounts, voids } }`. Reading it changes nothing. Cash is left out when blind.
Errors: 404 drawer or person not found; 409 `no_day` (cashier form).

#### `POST /api/business-day/movements`
Permission: `business_day.manage` and (`cash.movements` or manager approval `{ businessDayId, amount }`)
Query/Body: `type` (required: `paid_in` cash in, `petty_cash` paid out, `drop` to the safe), `amount` (required), `reason` (required, ≤300), `drawerId` (default: the caller's open drawer, else the only open drawer, else the day's drawer), `expenseCategoryId` (petty cash)
Returns: status 201, `data` = `{ id, businessDayId, drawerId, drawerCashierName, type, typeLabel, amount, reason, expenseId, categoryName, status, createdAt, createdByName, approvedByName }`. Petty cash also creates an approved expense.
Errors: 409 `no_day`; 404 drawer not found; 409 drawer closed; 400 `more_than_drawer` (cash out greater than the drawer holds); 400 unknown expense category; 409 day closed a moment ago.

#### `POST /api/business-day/movements/:id/cancel`
Permission: `business_day.manage` and (`cash.movements` or manager approval `{ businessDayId, amount }` of the entry)
Query/Body: `reason` (required, ≤300)
Returns: `data` = the cancelled entry (`cancelledAt`, `cancelledByName`, `cancelReason`). A petty-cash entry's expense is rejected.
Errors: 404 not found or another till's; 409 already cancelled; 409 day closed; 409 `drawer_counted` (the drawer was closed after the entry); 400 `more_than_drawer` (taking back a cash-in the drawer does not hold).

---

### Outlets

Mounted at `/api/outlets` (`authenticate`). Each outlet has its own business day, bill series (its `invoicePrefix`), and optionally its own GSTIN, FSSAI licence and UPI ID. When these are blank, the restaurant's are used. The data comes back as database rows (snake_case: `id, name, code, contact, address, gst_number, order_prefix, invoice_prefix, status, own_store, fssai_number, upi_vpa, upi_payee_name, created_at, updated_at`).

#### `GET /api/outlets`
Permission: `outlets.view`
Query/Body: none
Returns: `data` = array of outlets, ordered by name.

#### `GET /api/outlets/:id`
Permission: `outlets.view`
Query/Body: none
Returns: `data` = the outlet.
Errors: 404 not found.

#### `GET /api/outlets/:id/usage`
Permission: `outlets.manage`
Query/Body: none
Returns: `data` = `{ history[{ table, label, count }], setup[{ table, label, count }], lastBillAt, openPreorders[], canClose, canDelete, mustDeactivate }`. `history` covers sales, stock, days and money (these must stay). `setup` covers people, tables and floors (these can be moved). `openPreorders` are the numbers of the pre-orders still to be baked and handed over there (booked, in production or ready), soonest due first: while there are any, `canClose` and `canDelete` are false, and closing (`PUT` with `status: "inactive"`) or deleting the outlet is refused. Closing and deleting hold the outlet's row while they check, as booking a pre-order there does, so the two never both pass.
Errors: 404 not found.

#### `POST /api/outlets`
Permission: `outlets.manage`
Query/Body: `name` (required, ≤150), `code` (required, ≤30, upper-cased), `contact`, `address`, `gstNumber` (the outlet's own GSTIN, format, state and check character verified; blank = the restaurant's), `fssaiNumber` (14 digits), `upiVpa` (name@bank) + `upiPayeeName`, `orderPrefix`, `invoicePrefix` (≤10; shorter when bills are numbered by financial year), `status`
Returns: status 201, `data` = the outlet.
Errors: 409 code already exists; 400 bad GSTIN, FSSAI or UPI ID; 400 prefix too long.

#### `PUT /api/outlets/:id`
Permission: `outlets.manage`
Query/Body: the same fields as create. If `gstNumber`, `fssaiNumber` or `upiVpa` is left out, the value on file is kept. Sending null or "" clears it.
Returns: `data` = the outlet. Bills raised after the change carry the outlet's new GSTIN.
Errors: 404 not found; 409 code already exists; the same 400s as create; 409 `{ reason: "outlet_has_open_preorders", preorders }` when an active outlet is set inactive while it still has open pre-orders (booked, in production or ready). `preorders` lists every number, soonest due first. The message names them (over four: the first three and how many more), as in ""Kondapur" still has 2 open pre-orders to bake and hand over (PRE-0004 and PRE-0006), so it cannot be closed yet. Hand them over or cancel them first, in Pre-orders & cakes." (for one: "1 open pre-order … Hand it over or cancel it first"). Any other change to an open outlet, and saving one already inactive, is not checked.

#### `DELETE /api/outlets/:id`
Permission: `outlets.manage`
Query/Body: none
Returns: `data` none; message "Outlet "X" deleted".
Errors, in the order they are checked: 404 not found or already deleted; 409 `{ reason: "outlet_has_open_preorders", preorders }` while it has open pre-orders, as for `PUT` ("… so it cannot be deleted yet. …"; before the two below, which suggest setting the outlet inactive, as that waits for the pre-orders too); 409 `{ reason: "outlet_has_history", history }` (set it inactive instead); 409 `{ reason: "outlet_in_use", setup }` (move people, tables and floors first).

---

### Payment types

Mounted under `/api/restaurants/current/payment-types`. These are owner-named types under a payment method (a meal card under `card`, a cheque under `other`). The method decides where the money is. The type says exactly what it was, and is totalled apart in the day summary.

#### `GET /api/restaurants/current/payment-types`
Permission: `orders.view`
Query/Body: none
Returns: `data` = `[{ id, paymentMethod, methodLabel, name, needsReference, status, sortOrder, usedCount, createdAt, updatedAt }]`.

#### `POST /api/restaurants/current/payment-types`
Permission: `restaurant.settings.manage`
Query/Body: `paymentMethod` (required, the six methods; fixed after creation), `name` (required, ≤60), `needsReference` (boolean), `status` (`active` | `inactive`), `sortOrder` (0 to 999)
Returns: status 201, `data` = the type.
Errors: 409 name already exists under that method.

#### `PUT /api/restaurants/current/payment-types/:id`
Permission: `restaurant.settings.manage`
Query/Body: `name` (required), `needsReference`, `status`, `sortOrder` (the method cannot change)
Returns: `data` = the type. Setting it inactive keeps its history.
Errors: 404 not found; 409 name already exists under that method.

#### `DELETE /api/restaurants/current/payment-types/:id`
Permission: `restaurant.settings.manage`
Query/Body: none
Returns: `data` none; message "X deleted".
Errors: 404 not found; 409 the type has been used N times (switch it off instead).

---

## Business Admin (multi-business platform)

All routes are mounted at `/api/businesses` (`backend/src/modules/business/core/routes/business.routes.js`, with the trade, retail, fashion and electronics, salon and weight, health, quotations, hardware, licences, agri, optical, garage, memberships, laundry, jewellery, rentals, fuel, lodging and counter route files added to the same router) and follow the [Business Admin conventions](#business-admin-conventions).

### Directory

These three routes have no `:businessId`, so they skip the membership check. Nor do an owner's GST thresholds, `GET /api/businesses/gst-thresholds` and `PUT /api/businesses/gst-thresholds/warning-level`: each answers for the signed-in person's own businesses ([Owner's GST thresholds](#owners-gst-thresholds)).

#### `GET /api/businesses`
Permission: login only
Query/Body: none
Returns: `data = { types: { code: { name } }, modules[{ code, name, kind }], businesses[] }`. Each business is `{ id, name, code, business_type, type_name, restaurant_format, legacy_restaurant_id, status, currency, timezone, role_id, role_name, full_access, last_opened_at, capabilities[], is_signed_in_restaurant }`, by name; a restaurant's `type_name` is its format's name (Café, Bakery, Cloud kitchen) when it is not a full-service restaurant. Only active memberships of active businesses are listed.

#### `POST /api/businesses`
Permission: login, as the owner of an active business (or a restaurant's `RESTAURANT_ADMIN`, or the platform's own account)
Query/Body: the business fields of `POST /api/users/platform/businesses` (`businessType`, `name`, `code`, `legalName`, `gstin`, `stateCode`, address, `phone`, `email`, `currency`, `timezone`, `locationName`, `locationCode`), without `owner`
Returns: 201, the new business row. The caller becomes its owner. A restaurant is set up from the platform console instead.
Errors: 400 validation (as the platform route); 403 "Only the owner of a business can add another business"; 409 the business code is taken.

#### `POST /api/businesses/link-restaurant`
Permission: login with the `RESTAURANT_ADMIN` role and a restaurant on the token
Query/Body: `{}`
Returns: Creates or renames the `restaurant`-type business linked to the caller's restaurant, gives the caller the Owner role and switches on the `restaurant` capability. Returns the same shape as the directory list above.
Errors: 403 "A restaurant administrator is required"; 404 restaurant not found or inactive.

### Business context, overview and reports

#### `GET /api/businesses/:businessId/context`
Permission: any member
Query/Body: none
Returns: `data = { business: { id, name, code, business_type, type_name, legacy_restaurant_id, currency, timezone }, role: { id, name, full_access }, member: { location_id, location_name, department_id, department_name }, currentLocationId, permissions[], capabilities[], modules[], moduleCatalogue[], settings: { display_name, legal_name, gstin, state_code, tax_mode, rounding, fiscal_year_start_month, date_format, logo_path, max_bill_discount_percent, walk_in_credit, counter_pin_every_bill, voucher_valid_days, ageing_days, near_expiry_days, weight_buttons_grams, receipt_width_mm, day_cutoff_hour }, locations[{ id, name, code, active, sells_at_counter, address_line1, address_line2, city, postal_code, state_code, gstin, phone, opening_hours }], allLocations[] }`. Here `modules` is the core modules plus the enabled capabilities. `member` is where the caller's access is tied (nulls: every location, every department) and `currentLocationId` the location in effect (tied, or picked with `X-Business-Location`). `locations`, which every location picker is built from, holds only that location when one is in effect; `allLocations` always lists them all (for what names another location, such as a transfer's destination).

#### `POST /api/businesses/:businessId/open`
Permission: any member
Query/Body: `{}`
Returns: `data = { opened: businessId }`. Records `last_opened_at` on the caller's membership so the switcher can return them to this business.

#### `GET /api/businesses/:businessId/summary`
Permission: any member. Each figure is included only when the caller may see it (the module is on and the role holds the permission):
`skus` (`catalog.view`), `contacts` (`contacts.view`), `locations` (always), `sales_today`, `sales_month`, `sales`, `receivables`, `receivables_owed`, `receivables_advances`, `receivables_walk_in`, `bills_today`, `taken_today`, `credit_given_today` (`sales.view`), `payables`, `payables_overdue` (`purchasing.view`), `low_stock`, `expiring_soon`, `broken_sizes` (`inventory.view`), `transfers_in_transit` (`stock_transfers.view`), `counts_open` (`stock_counts.view`), `appointments_today`, `appointments_upcoming`, `appointments_left_today` (`appointments.view`), `promises_due_today`, `promises_broken` (`receivables.view`), `exchanges_today` (`exchanges.view`), `repairs_ready`, `repairs_overdue` (`repairs.view`), `warranties_missing` (`warranties.view`), `orders_to_dispatch` (`sales_orders.view`).
Query/Body: none
Returns: `data` = an object holding only the allowed keys. Counts are integers and money values are decimal strings, except `taken_today`: today's money taken on sales by payment kind, plus `collections`, as an object of numbers (`{ cash: 1200.5, upi: 450, collections: 300 }`), or null when nothing was taken; EMI money (method `finance`) is left out of it. `sales` is all sales less sale returns. `receivables` is every customer's balance, `receivables_owed` and `receivables_advances` its owing and advance parts, `receivables_walk_in` the unpaid bills of walk-ins; `payables` is the sum of positive outstanding amounts on purchases. `expiring_soon` counts lots with stock that expire within the business's Expiring soon days (`near_expiry_days`, 30 unless changed). A location in effect (tied, or picked with `X-Business-Location`) narrows `sales_today`, `sales_month`, `sales`, `bills_today`, `taken_today`, `credit_given_today`, `low_stock`, `expiring_soon`, `transfers_in_transit`, `counts_open`, `appointments_today` and `appointments_upcoming`; the balances (`receivables`, `receivables_owed`, `receivables_advances`, `receivables_walk_in`, `payables`, `payables_overdue`) and the other figures stay business-wide.

#### `GET /api/businesses/:businessId/overview`
Permission: any member. Each part is included only when the caller may see it: `sales` with `sales.view` or `reports.view`; `appointments` with the Appointments module and `appointments.view` (each person's `commission` also needs Commissions and `commissions.view`, else null).
Query/Body: none
Returns: `data = { generated_at, sales?: { days[{ day, sales, bills }], today, bills_today, average_bill, last_week_by_now, last_week_day, weekday, hours[{ hour, bills, sales }], top_today[], top_week[] }, appointments?: { next[], people[] } }`. `days` is the last fourteen days of net sales (bills less what came back that day); `last_week_by_now` is the same weekday a week ago up to the same time of day; `top_today` and `top_week` (the last seven days) are the six best sellers by value, `{ sku_id, label, quantity, unit, value }`. `next` is up to six bookings still to come today, `{ id, starts_at, ends_at, client, service, staff, in_progress }`; `people` is up to twelve staff, `{ id, name, role_label, booked, done, busy, next_at, sales, commission }` (`sales` null without the sales permission). A location in effect narrows every part.

#### `GET /api/businesses/:businessId/reports`
Permission: `reports.view`
Query/Body: `from`, `to` (required dates, range up to 367 days), `location` (one location; the one in effect when left out)
Returns: `data = { from, to, timezone, location, rows[{ day, kind, entries, total, net, tax }] }`. `kind` is one of `sale`, `purchase`, `sale_return`, `purchase_return`, `sale_payment`, `purchase_payment`, `sale_refund`, `purchase_refund`, `collection_bounced`, `finance_payout`, `expense`, `expense_reversal`. Payments count once: a customer collection is a `sale_payment` and a supplier payment voucher a `purchase_payment` (the bills they settle are not counted again); EMI money (`finance`) is left out of payments and refunds, and the financier's payout is its own kind. Each event counts on its own posting date in the business time zone. Only the document kinds the caller may view (`sales.view` / `purchasing.view`) are included, and expenses only with `expenses.view`.
Errors: 400 invalid date or "Choose a date range of up to 367 days".

#### `GET /api/businesses/:businessId/reports/locations`
Permission: `reports.view` and `sales.view` (the service asks for both)
Query/Body: `from`, `to` (dates; `to` defaults to today, `from` to the first of `to`'s month)
Returns: `data = { from, to, locations[{ id, name, code, active, bills, sales, returns, purchases, collected, stock_value, net_sales, average_bill, share_percent }], totals: { bills, sales, returns, net_sales, purchases, collected, stock_value } }`: the branch comparison, every location side by side for the period with its share of net sales. A branch picked in the top bar does not narrow it; a person tied to one location sees only theirs. A closed location is left out when it had no bills, purchases or returns in the period and holds no stock.
Errors: 400 invalid date, or the end date before the start date.

#### `GET /api/businesses/:businessId/reports/takings`
Permission: `reports.view` or `sales.view`
Query/Body: `from` (default today), `to` (default `from`; up to 31 days), `locationId` (one location)
Returns: `data = { from, to, timezone, locationId, generatedAt, seller, sales: { bills, total, tax, roundOff, returns, returnsCount, net, onCredit, walkInBills, walkInUnpaid, offers, points, counterDiscounts }, received: { cash, upi, card, bank, cheque, total, atSale, laterOnBills, collections, fromFinanciers, fromSuppliers, fromAttendants, otherIncome }, finance: { booked, bills, cancelled, subvention }, refunds: { cash, upi, card, bank, cheque, total }, suppliers: { cash, upi, card, bank, cheque, total }, bounced: { cash, upi, card, bank, cheque, total }, expenses: { cash, upi, card, bank, cheque, total, visible } | { visible: false }, cashInHand, net, byMethodName: { received[], refunds[], suppliers[], bounced[], expenses[] }, byPerson[], byLocation[] }`. The day close: what was sold and what money came in and went out, by payment kind, by the person who took it and by location. Read-only.
- Money in (`received`) is payments taken on sales, collections, refunds received from suppliers (`fromSuppliers`) and financiers' payouts recorded in the dates (`fromFinanciers`); at a fuel station also what attendants paid back of their shorts (`fromAttendants`) and an attendant's excess taken to other income (`otherIncome`).
- Money out is refunds on bills and advances handed back (`refunds`), payments to suppliers (`suppliers`), cheque receipts that bounced, taken off on the day they bounced (`bounced`), and paid expenses (a reversed expense comes back on the day it was reversed).
- `net` is money in less money out, and `cashInHand` is cash in less cash out.
- `finance` is the EMI side: `booked` is the amount financed on the period's bills (owed by financiers, not in the drawer), `bills` how many, `cancelled` the loans cancelled, and `subvention` what financiers kept from their payouts. Payments and refunds of method `finance` are left out of the money-in and drawer figures.
- `byMethodName` splits each kind by the business's own payment method names, `[{ method, name, amount }]`.
- Expenses lower the cash for everyone, but their breakdown is shown only with `expenses.view`.

Errors: 400 invalid date; 400 "The end date is before the start date"; 400 "Choose up to 31 days for a day close".

#### `GET /api/businesses/:businessId/cash-checks`
Permission: `reports.view` or `sales.view`; with the Expenses module on, also `expenses.view`
Query/Body: `date` (required), `locationId` or `location` (one location; the one in effect when left out)
Returns: `data` = up to 20 cash checks of that location and day, newest first: `[{ id, location_id, checked_on, opening_cash, counted_cash, movement_cash, expected_cash, difference, reason, created_by, created_by_name, created_at, ... }]`.
Errors: 400 invalid date or no location; 404 location not available.

#### `POST /api/businesses/:businessId/cash-checks`
Permission: `reports.edit` and (`sales.view` or `reports.view`); with the Expenses module on, also `expenses.view` (a drawer cannot be reconciled with its outgoings hidden)
Query/Body: `requestKey` (UUID, required), `date` (required; not in the future), `locationId` (the one in effect when left out), `openingCash` and `countedCash` (required, 0 and up), `reason` (up to 300; required when the count differs)
Returns: 201, the cash check. The expected cash is the opening cash plus that day's `cashInHand` from the day close (`reports/takings` for that location and day); `difference` = counted less expected. A cash check is a permanent snapshot: record a new one to correct it. Repeating the key with the same body returns the first check.
Errors: 400 a future date; 400 "Give a reason for the cash difference"; 404 location not available; 409 the request key was already used for a different check, or the same check is being saved at once.

### Notifications (the bell)

#### `GET /api/businesses/:businessId/notifications`
Permission: any member (each alert also needs its own view permission)
Query/Body: none
Returns: `{ items[{ id, severity (critical, warning, info), category, title, detail, at, link }], counts, generatedAt }`. Worked out from live data when asked; nothing is stored. The alerts: items at or below their reorder level (`inventory.view`); batches expired or expiring within the business's Expiring soon days (30 until changed; `inventory.view`, `batches`); customers with bills past due, and promises to pay due today or broken (`receivables.view`); repairs ready or late (`repairs.view`); appointments still to come today (`appointments.view`); licences that run out within 60 days or have run out (`licences.view`; see [Licences & registrations](#licences--registrations)); and the tasks and issues described under [Tasks, issues & projects](#tasks-issues--projects); and, for `reports.view`, the business's PAN nearing or past a GST threshold (category `GST`, id `gst-threshold:<financial year>:<figure in rupees>:<near|crossed:this_year|crossed:last_year>`; see [Owner's GST thresholds](#owners-gst-thresholds)). Ids are stable per alert, so the browser remembers which were read. At most 15 per kind.

### Paged lists (core)

All of these follow the paged-list contract above. `documents` lists only the kinds the caller may view. Asking for `kind=sale` or `kind=purchase` without that kind's `.view` permission gives 403.

| Endpoint | Permission | Filters | Date range on |
|---|---|---|---|
| `GET /api/businesses/:businessId/catalog` | `catalog.view` | `category` (category id), `kind` (`goods`/`service`), `active`, `kit` (`true`), `department` (department id; always the person's own when they are tied to one) | none |
| `GET /api/businesses/:businessId/categories` | `catalog.view` | `active` | none |
| `GET /api/businesses/:businessId/units` | `catalog.view` | none | none |
| `GET /api/businesses/:businessId/pack-sizes` | `catalog.view` | `sku` | none |
| `GET /api/businesses/:businessId/tax-changes` | `catalog.view` | `state` (`scheduled`, `in_force`, `refused`, `cancelled`) | none |
| `GET /api/businesses/:businessId/contacts` | `contacts.view` | `kind` (`customer`/`supplier`), `active` | none |
| `GET /api/businesses/:businessId/pricing` | `wholesale.view` | none | none |
| `GET /api/businesses/:businessId/locations` | any member | `active` | none |
| `GET /api/businesses/:businessId/tax-rates` | any member | `active` | none |
| `GET /api/businesses/:businessId/number-series` | `settings.view` | `kind` (document kind), `location` | none |
| `GET /api/businesses/:businessId/resources` | `appointments.view` | `location` | none |
| `GET /api/businesses/:businessId/stock` | `inventory.view` | `location`, `sku`, `in_stock`, `expiring`, `department` (always the person's own when they are tied to one) | none |
| `GET /api/businesses/:businessId/movements` | `inventory.view` | `location`, `source` (`sale`/`purchase`/`return`/`transfer`/`count`/`correction`) | `created_at` |
| `GET /api/businesses/:businessId/documents` | `sales.view` or `purchasing.view` | `kind` (`sale`/`purchase`), `location`, `contact`, `walk_in_due` and `unpaid` (`true`/`false`), and `salesperson`, `route`, `delivery`, `source`, `created_by`, `paid_by`, `site` (described below the table) | `created_at` |
| `GET /api/businesses/:businessId/appointments` | `appointments.view` | `status`, `location` | `starts_at` |
| `GET /api/businesses/:businessId/audit` | `audit.view` | none | `created_at` |
| `GET /api/businesses/:businessId/members` | `access.view` | `role` (role id), `location` (only when asked for, or when the person is tied to one: the list shows everyone otherwise) | none |
| `GET /api/businesses/:businessId/roles` | `access.view` | `active` | none |
| `GET /api/businesses/:businessId/transfers` | `stock_transfers.view` | `status` (`in_transit`/`received`/`cancelled`), `location` (sent from or to it) | `created_at` |
| `GET /api/businesses/:businessId/counts` | `stock_counts.view` | `status` (`open`/`posted`/`cancelled`), `location` | `created_at` |
| `GET /api/businesses/:businessId/supplier-payments` | `purchasing.view` | `contact`, `method`, `location` | `created_at` |

A location in effect (tied, or picked with `X-Business-Location`) fills in the `location` filter of each list that has one; on `members` only a tied location does.

Rows carry extra columns:
- `catalog` adds `product_name, category, category_id, department_id, brand, kind, tax_rate_name, unit_name, unit_decimals, stock, pack_sizes[]`, and its search also covers `shelf_location`.
- `categories` adds `path, depth, product_count, parent_name`. `contacts` adds `balance`.
- `stock` (one row per lot) adds `label, code, unit, reorder_level, tracking, shelf_location, department_id, location_name, expired, in_stock`, `expiring` (within the business's Expiring soon days, `nearExpiryDays` in Business settings › Rules; 30 until changed) and the item's largest pack, `pack_unit, pack_factor`.
- `movements` adds `source, source_no, reason, location_name`, newest first in time order (`created_at`, then id).
- `documents` adds `location_name, paid, returned, refunded, walk_in_due, unpaid, lot_codes, created_by_name` and `paid_by` (`cash`, `upi`, `card`, `bank`, or `mixed` for a bill paid several ways). An invoice raised by dispatching a sales order also carries `order_no, salesperson_name, route_name, delivery_status`, and `source` is `order` (else `counter`). A hardware shop's bill carries `site_id` and `site_name` (filter `site`). The search covers the document number, the customer or supplier name, notes, the supplier's bill number, serial and batch numbers, the order number, the biller's name and the site's name.
- `appointments` adds `resource_name, location_id, contact_name, service_name`. `members` adds `location_id, location_name, department_id, department_name` and `manages`: true when the caller manages this person, so may change them (`POST …/members`) and set their password, that is, the caller holds `access.edit`, the person is neither the owner nor the caller, and the rules under [Staff access and roles](#staff-access-and-roles) allow it (a login also used elsewhere still has its password changed there). `roles` adds `member_count, permission_count, permissions[]`.
- `transfers` and `counts` add line counts and value or progress. `supplier-payments` adds `location_name, created_by_name, allocated, unallocated`.

See `backend/src/modules/business/core/repositories/business.repository.js` (`lists`).

### Settings, modules, tax rates, number series, locations

#### `GET /api/businesses/:businessId/settings`
Permission: `settings.view`
Query/Body: none
Returns: `data` = the `business_settings` row (display/legal name, GSTIN, address, `tax_mode`, `rounding`, `fiscal_year_start_month`, footers, `date_format`, the counter rules, the business rules, ...) plus the business's own `name` (the switcher's), `currency` and `timezone`.

#### `PUT /api/businesses/:businessId/settings`
Permission: `settings.edit`
Query/Body: `displayName` (required, up to 150 chars), `legalName`, `gstin` (validated), `stateCode` (2 digits; defaults to the GSTIN prefix and must match it), `addressLine1/2`, `city`, `postalCode` (6 digits), `phone`, `email`, `logoPath`, `taxMode` (`exclusive`/`inclusive`, required), `rounding` (`none`/`nearest_rupee`, required), `fiscalYearStartMonth` (1-12, required), `invoiceFooter`, `receiptFooter`, `dateFormat` (`DD/MM/YYYY`, `DD-MM-YYYY`, `DD MMM YYYY`, `YYYY-MM-DD`, required). Optional, each kept when left out: the counter rules `maxBillDiscountPercent` (0-100, default 10), `walkInCredit` (boolean: allow unpaid walk-in bills) and `counterPinEveryBill`; the business rules (Business settings › Rules) `voucherValidDays` (1-3650; how long a credit voucher can be spent, 90 until changed), `ageingDays` (three increasing day counts, the edges of the customer-credit age groups; 30, 60, 90 until changed), `nearExpiryDays` (1-365; "expiring soon" for batches, 30 until changed), `weightButtonsGrams` (1-8 weights in grams for the quick weight buttons at Quick bill), `receiptWidthMm` (58 or 80), `dayCutoffHour` (0-12; until this hour a task due after midnight still belongs to the day before), `quotationTerms` (up to 2,000 characters; empty for none: the terms and conditions printed on quotations, each quotation keeping those it was made with); `currency` (ISO code) and `timezone`; `name`, the business's own name (trimmed, 1-150 characters, as `POST /api/businesses` takes it; another business of the same owner may have the same name), audited `business.renamed` (`from`, `to`) when it changes.
Returns: the saved settings row (an upsert) with `name`, `currency` and `timezone`. The rules are audited as `settings.rules_updated`.
Errors: 400 validation (for example "The state code must match the first two digits of the GSTIN", or "Business name is required"); 409 when the fiscal-year start month changes after any number series exists; 409 when the currency changes once bills or purchases are recorded; 409 when a restaurant's business is given a name of its own (it takes its restaurant's, `PUT /api/restaurants/current`).

#### `GET /api/businesses/:businessId/modules`
Permission: any member
Query/Body: none
Returns: `data` = the core modules plus the modules this business type can use: `[{ code, name, description, kind, sort_order, feature_group, enabled, enabled_by_default, requires[], recommended, recommended_note }]`. `recommended` marks the tools most businesses of this trade use, with why, for an owner choosing them; a new business starts with a lean set switched on. For a restaurant business these are the restaurant's features (`feature_group` Guests / Service / Money / Back office / Operations) plus `restaurant`.

#### `PUT /api/businesses/:businessId/modules/:code`
Permission: `settings.edit`
Query/Body: `enabled` (boolean, required)
Returns: `data = { code, enabled }` (for a restaurant feature also `warnings[]`). The change is audited.
Errors: 404 unknown module; 409 when the module is core ("... is always on") or `restaurant`; 409 switching off Daily expenses (`expenses`) once an expense is recorded. For a restaurant business a feature is switched through `PUT /api/restaurants/current/features/:code`'s rules (dependencies, money that would be stranded: 409 with the first blocker in the message; the restaurant's activity log records it with `via: "business_admin"`). The database refuses a module the type cannot have, a missing dependency, or switching off a module another one needs; these come back as 409 (trigger sentence) or 400.

#### `POST /api/businesses/:businessId/tax-rates`
Permission: `settings.edit`
Query/Body: `name` (required, up to 60 chars), `rate` (0-100, 2 decimal places, required), `isDefault` (boolean, default false; when true, any other default is cleared)
Returns: 201, the tax rate row.

#### `PATCH /api/businesses/:businessId/tax-rates/:id`
Permission: `settings.edit`
Query/Body: `name` (required), `active` (default true), `isDefault`. A `rate` that differs from the current rate is refused.
Returns: the updated row.
Errors: 404 not found; 409 "A tax slab's rate cannot change"; 409 when switching off a slab that active items still use, or that a scheduled GST rate change moves items to (keep it on, or cancel that change first).

#### `POST /api/businesses/:businessId/number-series`
Permission: `settings.edit`
Query/Body: `locationId` (required), `documentKind` (one of `sale`, `purchase`, `sales_return`, `purchase_return`, `stock_transfer`, `stock_count`, `sales_order`, `collection`, `repair_job`, `processing`, `supplier_payment`, `purchase_order`, `delivery_challan`), `fiscalYear` (2000-2200), `prefix` (up to 12 chars of letters, digits, `/` and `-`, not ending in a digit; stored upper-case), `padding` (1-8, default 4), `nextNumber` (default 1; raised above the highest number already used with this prefix)
Returns: 201, the series row.
Errors: 400 when prefix + digits exceed 16 characters (the GST limit); 404 location not found.

#### `PATCH /api/businesses/:businessId/number-series/:id`
Permission: `settings.edit`
Query/Body: `prefix`, `padding`, `nextNumber` (all required)
Returns: the updated row.
Errors: 404 not found; 409 when `nextNumber` is not above the highest number already used with the prefix. The database also refuses going backwards or changing a series already in use (409 trigger sentence).

#### `GET /api/businesses/:businessId/payment-methods`
Permission: any member (`all=true` also needs `settings.view`)
Query/Body: `all` (`true` adds the switched-off methods)
Returns: `data` = `[{ id, name, kind, active, sort_order, created_at, updated_at }]` in their order: the business's own payment methods ("PhonePe", "Sodexo"), each of one fixed kind (`cash`, `upi`, `card`, `bank`, `cheque`). Without `all`, only those switched on, which the counter offers. Every business starts with Cash, UPI, Card, Bank transfer and Cheque; a restaurant keeps its own payment types.

#### `POST /api/businesses/:businessId/payment-methods`
Permission: `settings.edit`
Query/Body: `name` (required, up to 60), `kind` (required: `cash`, `upi`, `card`, `bank`, `cheque`), `active` (default true), `sortOrder` (whole 0-10000; default after the last)
Returns: 201, the method. It is audited as `payment_method.created`.
Errors: 409 "There is already a payment method called …".

#### `PATCH /api/businesses/:businessId/payment-methods/:methodId`
Permission: `settings.edit`
Query/Body: any of `name`, `active`, `sortOrder` (left out: kept). The kind never changes: it decides how past payments are counted.
Returns: the updated method.
Errors: 404 payment method not found; 409 a different `kind` ("Add a new method with the right kind and switch this one off"); 409 duplicate name; 409 switching off the last method switched on.

#### `POST /api/businesses/:businessId/locations`
Permission: `settings.edit`
Query/Body: `name` (required, up to 150 chars), `code` (required, up to 30 chars, stored upper-case), `sellsAtCounter` (default true), the location's own `addressLine1`, `addressLine2`, `city`, `postalCode` (6 digits), `stateCode` (2 digits; defaults to the GSTIN's and must match it), `gstin` (validated; a separately registered branch) and `phone`, and `openingHours` (`{ mon: { open: "09:00", close: "21:00" }, … }`; a day left out or null is closed; a close before the open runs past midnight)
Returns: 201, the location row. A bill raised at a location prints its own address, phone, state and GSTIN where it has them (empty fields fall back to Business settings), and a sale to a buyer with no GSTIN takes the location's state as the place of supply.
Errors: 400 a bad PIN code, state code or GSTIN, or opening hours that are not times like 09:00; 409 duplicate code.

#### `PATCH /api/businesses/:businessId/locations/:id`
Permission: `settings.edit`
Query/Body: `name` (required), `active` (default true), and `sellsAtCounter`, the address fields and `openingHours` as for create (each group kept when left out)
Returns: the updated location.
Errors: 404 not found; 409 when closing a location that still holds stock, has transfers in transit, or has staff tied to it ("Move them to another location (Staff & access) before closing it").

#### `GET /api/businesses/:businessId/departments`
Permission: `catalog.view`
Query/Body: none
Returns: `data` = the departments of a store (Clothing, Home, Grocery…), switched-on first, by name: `[{ id, name, active, category_count, staff_count, ... }]`. A top-level category belongs to one department and its sub-categories follow it (`departmentId` on `POST /categories`).

#### `POST /api/businesses/:businessId/departments`
Permission: `settings.edit`
Query/Body: `name` (required, up to 80)
Returns: 201, the department.
Errors: 409 "There is already a department called …".

#### `PATCH /api/businesses/:businessId/departments/:id`
Permission: `settings.edit`
Query/Body: `name` (required, up to 80), `active` (default true)
Returns: the updated department. A department switched off keeps its categories, for history and reports.
Errors: 404 department not found; 409 duplicate name; 409 switching off a department people still work in (move them first in Staff & access).

#### `GET /api/businesses/:businessId/reports/departments`
Permission: `reports.view`
Query/Body: `from` (default today), `to` (default `from`; up to 367 days), `location`
Returns: `data = { from, to, rows[{ department_id, department, bills, net_sales, tax, returns, cost, net_after_returns, margin, margin_percent }] }`: sales, returns, cost and margin per department (and a row "No department"), highest sales first. Margin is sales less the stock cost each sold line recorded, both net of returns.
Errors: 400 invalid dates or "Choose a date range of up to 367 days"; 403 another location for a person tied to one.

### Staff access and roles

A caller can only grant permissions they hold. They also cannot edit a role, or change a member or set a new password for one, whose permissions go beyond their own. A caller tied to a location (or a department) changes, and sets new passwords for, only the people tied to that same location (or department), not those who work at every one. An Owner (`full_access`) is exempt from these rules.

#### `GET /api/businesses/:businessId/permissions`
Permission: `access.view`
Query/Body: none
Returns: `data = { modules[], permissions[{ code, module_code, action, name, sort_order }], templates[{ code, name, description, full_access }] }`. Only core modules and modules this business type can use are included.

#### `POST /api/businesses/:businessId/roles`
Permission: `access.edit`
Query/Body: `name` (required, up to 80 chars), `description` (up to 300 chars), `permissions` (array of permission codes, required, may be empty)
Returns: 201, `{ ...role, permissions[] }`.
Errors: 400 unknown permission; 403 when granting a permission the caller does not hold; 409 duplicate name.

#### `PATCH /api/businesses/:businessId/roles/:id`
Permission: `access.edit`
Query/Body: `name`, `description`, `active` (default true), `permissions[]` (replaces the full set)
Returns: `{ ...role, permissions[] }`.
Errors: 404 not found; 409 for the Owner role; 403 when the role can do things the caller cannot; 409 when switching off a role that people still hold.

#### `GET /api/businesses/:businessId/member-candidates`
Permission: `access.edit`
Query/Body: none
Returns: `data = [{ id, name, email }]`: the active staff accounts of the caller's own restaurant, and the people with a Business Admin login of their own who work in another business the caller owns; never another restaurant's people. People already on this business's staff list are left out.

#### `POST /api/businesses/:businessId/members`
Permission: `access.edit`
Query/Body: `userId` (required), `roleId` (or instead `role`, a role template: `manager`, `viewer`, `cashier`, `stock_keeper` or `accountant`), `active` (default true), `workLocationId` (the one location they work at; null or empty = every location; left out: kept), `workDepartmentId` (the one department whose products and stock they handle; null or empty = all; left out: kept)
Returns: 201, the membership row (an upsert, with `location_id` and `department_id`) plus `role_name`.
Errors: 404 staff member or role not found; 404 location not found or closed; 404 department not found or switched off; 403 when changing your own access, or when the target or role goes beyond your permissions; 403 a manager tied to a location (or department) giving access elsewhere, or changing someone who is not tied to that same location (or department), such as someone who works at every one; 409 when the target is the owner, or when the role is the Owner role.

#### `POST /api/businesses/:businessId/staff-accounts`
Permission: `access.edit`
Query/Body: `name` (required, up to 150), `email` (required), `password` (8-72, required), `mobile` (optional), `roleId` (required), `workLocationId` (optional), `workDepartmentId` (optional; a giver tied to a department must name their own)
Returns: 201, the membership row plus `role_name`, `name`, `email`: a login of their own for a member of staff, with no restaurant behind it (a restaurant business's staff stay with that restaurant). The password works for their first sign-in, when they choose their own. The role, location and department go through the checks of `POST /members`; when those refuse, the new login is removed again.
Errors: 400 validation; 409 "That email already has a login. Give that person access with "Give access" instead."; 409 the mobile number already has a login; plus the errors of `POST /members`.

#### `POST /api/businesses/:businessId/staff-accounts/:userId/password`
Permission: `access.edit`
Query/Body: `password` (8-72, required)
Returns: `{ id, name }`. The person is signed out everywhere, their sign-in lockout is lifted, and they choose their own password at their next sign-in.
Errors, in the order they are checked: 400 validation; 404 "That person has no access to this business"; 403 an owner's password (changed by the owner or the platform); 400 your own password (change it from My profile); 403 "This person does not work at your location" (you are tied to a location, and they are tied to another or work at every location); 403 "This person does not work in your department" (you are tied to a department, and they are in another or in every department); 403 "This person's role can do things yours cannot (…), so you cannot change their access or password" (their role holds a permission yours lacks, up to three named; never for an Owner); 409 the login is also used in another business or a restaurant (its password is changed there).

### Catalogue, categories, units, pack sizes, pricing rules

#### `POST /api/businesses/:businessId/catalog`
Permission: `catalog.create`; opening stock also needs `inventory.edit`
Query/Body: `kind` (`goods`/`service`), `name` (product name; or `productId` to add a variant, which needs the `variants` module), `label`, `code` (SKU code, upper-cased), `barcode` (letters, digits, `.`, `/` and `-`, up to 80), `unit` (one of the business's unit codes), `tracking` (`quantity`/`batch`/`serial` for goods; batch and serial need their modules), `price`, `taxRateId` (or a bare `taxRate`), `categoryId` (or a free-text `category`), `brand`, `reorderLevel`, `hsnCode` (HSN or SAC code: 4, 6 or 8 digits), `mrp` (GST included), `attributes` (an object; only keys allowed by the enabled modules; a figure, such as a hardware shop's `coverageSqftPerUnit`, `coverageSqftPerLitre` and `litresPerUnit` with the calculators on, is a number above 0 with up to 2 decimals; a farm-input shop's classification, `inputKind` first, is checked as in [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides)), `shelfLocation` (up to 40, "Aisle 3 · Shelf B"), `memberPrice` (what a loyalty customer pays when the Loyalty module is on; more than zero and below the price), `internalUse` (goods only: kept for use in services, such as a salon's back-bar products, and never sold), `openingStock` (goods that are not serial-numbered: `{ locationId, quantity, unitCost?, lotCode? (required for batch items), expiresOn? }`)
Returns: 201, the SKU row. Opening stock goes in as a lot at the cost given, through a stock adjustment with the reason "Opening stock". Two items never share a barcode.
Errors: 400 goods without the inventory capability, or a unit kind that does not fit (goods need a stock unit, services need an hour or service unit); 400 a bad HSN code, a member price not below the price, or opening stock on a service or a serial-numbered item; 403 a category outside the caller's department; 404 tax rate, category, product or location not found; 409 duplicate code; 409 the barcode is already on another item (the message names it); 409 the price is above the MRP (with prices before GST, the GST is added before comparing).

#### `PATCH /api/businesses/:businessId/catalog/:id`
Permission: `catalog.edit`
Query/Body: `label` (required), `price` (required), `taxRateId`/`taxRate`, `active`, `reorderLevel`, `categoryId` (moves the product), `hsnCode`, `mrp`, `barcode` (empty clears it), `shelfLocation`, `memberPrice` (empty clears it), `internalUse`, `attributes` (figures only, those the enabled modules allow: the calculators' coverage; an empty one is removed, the others are kept; a farm-input shop's classification is sent whole and replaces the old one, audited as `catalog.classified`: [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides)). Left out, the HSN code, MRP, barcode, shelf, member price, internal-use mark and attributes are kept; a member price that is not below a lowered price is cleared.
Returns: the updated SKU. A change of price, MRP or member price is audited as `catalog.price_changed`, a new barcode as `catalog.barcode_changed`.
Errors: 400 a member price not below the price; 403 an item or category outside the caller's department; 404 item, tax rate or category not found; 409 the barcode is already on another item; 409 the price is above the MRP.

#### `POST /api/businesses/:businessId/categories`
Permission: `catalog.create`
Query/Body: `name` (required, up to 100 chars), `parentId`, `sortOrder`, `departmentId` (top-level categories only; a sub-category takes its parent's department)
Returns: 201, the category.
Errors: 403 a department other than the caller's own; 404 parent, or department, not found (or switched off).

#### `PATCH /api/businesses/:businessId/categories/:id`
Permission: `catalog.edit`
Query/Body: `name`, `parentId`, `sortOrder`, `active`, `departmentId` (as for create; left out: kept). A changed department passes to every category below it.
Returns: the updated category.
Errors: 403 a category or department outside the caller's own; 404 not found; 409 when switching off a category that has active child categories.

#### `GET /api/businesses/:businessId/catalog/:id/branch-prices`
Permission: `catalog.view`
Query/Body: none
Returns: `data = { sku_id, price, branches[{ location_id, location_name, price, updated_at }] }`: every open location with its own selling price for the item (`price` null: the item's own price). The counter, quotes and posting use a branch's price in place of the item's own. A customer or quantity price rule (wholesale price lists) that applies is used instead of either; a loyalty customer's member price is used when it is lower; an offer still comes off on top.
Errors: 404 item not found.

#### `PUT /api/businesses/:businessId/catalog/:id/branch-prices`
Permission: `catalog.edit`
Query/Body: `prices` (1-200 of `{ locationId, price }`; a price sets the branch's own, an empty price goes back to the item's price; branches not named keep theirs)
Returns: `{ changed, sku_id, price, branches[] }`. Changes are audited as `catalog.branch_price_changed`.
Errors: 400 not 1-200 prices, or a branch named twice; 400 a price of zero or less; 403 a manager tied to another branch; 404 item, or branch, not found (or closed); 409 a price above the item's MRP.

#### `GET /api/businesses/:businessId/branch-prices`
Permission: `sales.create` or `catalog.view`
Query/Body: `location` (required; filled in by the location in effect)
Returns: `data = [{ sku_id, price }]`: one branch's own prices, for its counter.
Errors: 400 no location; 403 another location for a person tied to one.

#### `POST /api/businesses/:businessId/units`
Permission: `catalog.create`
Query/Body: `code` (lower-case letters, digits and `_`, starting with a letter, up to 20 chars), `name`, `kind` (`count`/`weight`/`volume`/`length`/`time`/`service`), `decimals` (0-3; always 0 for `count`), `baseUnitCode` + `factorToBase` (optional; the base must be the same kind and not itself convert to another unit)
Returns: 201, the unit.
Errors: 404 base unit not found; 409 duplicate code.

#### `PATCH /api/businesses/:businessId/units/:id`
Permission: `catalog.edit`
Query/Body: `name`, `active`. The code, kind and conversion cannot be changed.
Returns: the updated unit.
Errors: 404 not found; 409 when switching off a unit that active items are stocked in.

#### `POST /api/businesses/:businessId/pack-sizes`
Permission: `catalog.edit`
Query/Body: `skuId`, `unitCode`, `quantityInBase` (0.001-1,000,000; must be a whole number when the item is stocked in whole units)
Returns: 201, the pack-size row. This is an upsert on (item, unit), and it reactivates a pack size that was switched off.
Errors: 404 item or unit not found; 400 when the pack unit is the same as the item's stock unit.

#### `PATCH /api/businesses/:businessId/pack-sizes/:id`
Permission: `catalog.edit`
Query/Body: `active` (boolean, required)
Returns: the updated row.
Errors: 404 not found.

#### `POST /api/businesses/:businessId/pricing`
Permission: `wholesale.edit`
Query/Body: `skuId`, `contactId` (optional customer; without it the rule applies to everyone), `minimumQuantity` (0.001-100,000), `unitPrice`, `unitCode` (optional pack size; the slab then counts whole packs)
Returns: 201, the price rule.
Errors: 404 item, customer or pack size not found; 400 when a pack slab's minimum is not a whole number.

#### `DELETE /api/businesses/:businessId/pricing/:id`
Permission: `wholesale.edit`
Query/Body: none
Returns: the rule with `active=false` (a soft disable).
Errors: 404 "Active price rule not found".

#### `GET /api/businesses/:businessId/catalog/import-guide`
Permission: `catalog.create`
Query/Body: none
Returns: `data = { maxRows: 5000, columns[{ key, label, need, help, example }], sample{ columns[], rows[][] }, notes[] }`. The columns are Name, Code, Barcode, Category, Kind, Unit, Stock tracking, HSN / SAC, GST rate, MRP, Sale price, Purchase price, Reorder level, Opening stock, Location, Batch and Expiry (a jeweller's also Purity, whose rows are refused); the help of Unit, GST rate and Location lists the business's own. `sample` is a template whose headings are exactly the column labels; `notes` says where the type's own items are made (fuels, jewellery pieces, rental items, a laundry's services, room types, membership plans) and, for a pharmacy or a farm-input shop, what is added after the import.

#### `POST /api/businesses/:businessId/catalog/import`
Permission: `catalog.create`; `mode: "update"` also needs `catalog.edit`, and a file with opening stock `inventory.edit`
Query/Body: `rows` (array of `{ heading: cell }`, 1 to 5,000; this route takes a body of up to 5 MB), `dryRun` (boolean, default false), `fileName` (≤200), `fingerprint` (≤100, from the check's answer), `mode` (`skip`, the default: items already here are left as they are; `update`: what the file gives changes them), `requestKey` (UUID, required when `dryRun` is false). Headings are matched ignoring case, spaces and punctuation, with the usual names of other systems (Item name, SKU, GST %, HSN/SAC, Opening qty); a heading not known is listed in `columns.ignored`.
Returns: `message` (the counts in a sentence) and `data = { ok, problems[{ line, column, message }], rows[], created, updated, unchanged, skipped, refused, columns{ used, ignored, headings }, fingerprint, newCategories[], opening{ items, value, valueWords }, maxRows }`. Each row is `{ line, key, name, code, action, changes[{ field, label, from, to }], notes[], details?, reasons?[{ column, message }] }`, `action` one of `create`, `update`, `unchanged`, `skipped` (found and would change, but `mode` is `skip`) and `refused` (with its `reasons`; the row is left out). An item is found by its code, then its barcode. `problems` are the whole file's (no Code or Barcode column): with any, `ok` is false and nothing can be imported. A check (`dryRun: true`) writes nothing and answers 200 even with problems. The import plans the rows again under the business's import lock, then makes or changes each row not refused through the item form's own paths (`createCatalog`, `updateCatalog`), new categories first, in one transaction: opening stock goes in as a lot at the purchase price through an adjustment with the reason "Opening stock" (event `stock.adjusted`), only for an item with no stock on record. It records a `business_imports` row, audits `catalog.imported` (`{ fileName, rows, created, updated, unchanged, skipped, refused, mode, openingStock, newCategories }`, besides each item's own `catalog.created`, `catalog.updated`, `catalog.price_changed`, `category.created`, `stock.adjusted` rows) and answers `data.importId`. The same `requestKey` with the same rows (and mode) answers that import again, `repeated: true`, and writes nothing.
Errors: 400 no rows ("The file has no rows"), more than 5,000 ("That is more than 5,000 rows. Split the file and import it in parts."), rows not a list, a `mode` other than `skip` or `update`, an import without a valid `requestKey`; 400 `success: false` with `data` when the file has problems (nothing written); 403 without `catalog.create`, `catalog.edit` for `update`, or `inventory.edit` for opening stock ("Your role may not bring stock in: …"); 404 a business the caller is not a member of; 409 the request key with other rows; 409 `data.reason: "stale_preview"` when the items moved since the check, or another record took one of the file's codes or barcodes meanwhile (nothing written; check the file again); 413 a body over 5 MB.
A row is refused for: a new item without its name, code, unit or sale price; a code over 60 characters; a unit, GST slab or location the business does not have; an HSN or SAC code not of 4, 6 or 8 digits; a price above the MRP; a barcode on another item or another row; the same item on two rows; a change of an item's kind, unit or stock tracking; batch or serial tracking without its module (a pharmacy's goods always by batch); opening stock on a service, a kit or a serial-numbered item, in more decimals than its unit takes, for a batch item without its batch number, or at a location someone tied to another may not use; a category switched off, named twice without its path, or outside the department of someone tied to one; and a type's own item, new or already here (a fuel, a jewellery piece or a row with a Purity, a rental item or a hire counted in days, a laundry service, a room type or a room night, a membership plan), with the screen where it is made.

### Contacts

#### `POST /api/businesses/:businessId/contacts`
Permission: `contacts.create`
Query/Body: `kind` (`customer`/`supplier`), `name` (required), `phone` (optional; one of only spaces counts as none), `email`, `address`, `gstin`, `pan` (five letters, four digits and a letter, any case), `creditLimit` (customers only), `creditDays` (0-365), `openingBalance` (signed), `openingBalanceOn` (date, required when there is an opening balance), `consents` (a customer's: `{ bills_digital?, reminders?, offers? }`, each `true` to record that consent on the privacy notice in force or `false` to withdraw it, a purpose left out staying as it is; 409 `no_privacy_notice` before the business publishes one, 409 for offers to a child; see [Personal data](#personal-data)). `PATCH` refuses an erased customer (409)
Returns: 201, the contact.
Errors: 400 a credit limit on a supplier, an invalid GSTIN or an invalid PAN.

#### `PATCH /api/businesses/:businessId/contacts/:id`
Permission: `contacts.edit`
Query/Body: the same fields as create, plus `active`. Fields left out keep their current credit terms, opening balance, GSTIN and PAN. The kind cannot change.
Returns: the updated contact.
Errors: 404 not found.

#### `GET /api/businesses/:businessId/contacts/import-guide`
Permission: `contacts.create`
Query/Body: `kind` (`customer`/`supplier`, required)
Returns: as the catalogue's import guide. A customer's columns are Name, Phone, Email, GSTIN, State, Address, PAN, Credit limit, Credit days, Opening balance and Opening balance as of; a supplier's the same without Credit limit.
Errors: 400 a kind other than `customer` or `supplier`.

#### `POST /api/businesses/:businessId/contacts/import`
Permission: `contacts.create`; `mode: "update"` also needs `contacts.edit`
Query/Body: `kind` (`customer`/`supplier`, required), with the catalogue import's `rows`, `dryRun`, `fileName`, `fingerprint`, `mode` and `requestKey`
Returns: as the catalogue import's, each row with a `hint` (its GSTIN or phone) in place of a code, and `data.balances{ count, total, totalWords }`: the opening balances set and their sum (signed: owed to the business by a customer, owed by it to a supplier). A contact is found by its GSTIN, then its phone (a mobile in any of the ways it is written; one that several contacts share finds the one of the row's name), and a row with neither by its name; a phone is never needed. Each contact is made or changed through the contact form's own paths (`createContact`, `updateContact`): a State must be the GSTIN's (without a GSTIN it ends the address); an opening balance (1,200 Dr or 500 Cr as Tally writes them, a customer's Dr and a supplier's Cr owed) is the contact's own, dated as given or today, and is set only on a contact that has none. Audited `customers.imported` or `suppliers.imported` (`{ fileName, rows, created, updated, unchanged, skipped, refused, mode, openingBalances }`), besides each contact's own `contact.created` or `contact.updated`.
Errors: as the catalogue import's (403 without `contacts.create`, or `contacts.edit` for `update`); 400 a bad kind.
A row is refused for: a new contact without a name; a GSTIN that fails the check, or that another row gives to someone else; a State not the GSTIN's; a PAN not the one inside the GSTIN; a phone or an email that is not one; several contacts with the phone (none of the row's name) or, for a row with no phone or GSTIN, with the name; the same contact on two rows; a balance both negative and Dr or Cr; a balance dated after today.

### GST rate changes

A GST rate change moves chosen items to another of the business's GST slabs from a later date on the business's own clock. A bill uses the slab in force on its own date, and a posted bill never changes. How it works: [BUSINESS_RULES.md › GST rates by date](BUSINESS_RULES.md#gst-rates-by-date). Backend module `modules/tax-changes/` (routes `taxChanges.routes.js`), which also serves a restaurant's dishes: [GST rate changes on the menu](#gst-rate-changes-on-the-menu).

A change takes effect when the first request on or after its date opens the business, before anything is read, and again inside each posting under the business's lock; nothing runs on a timer. Each item then takes the new slab and, when the change keeps the price before GST, a new price (its member price and branch prices move with it). The audit log records `catalog.tax_changed` in the name of whoever entered the change. An item the database refuses on the day (a jewellery item off 3%) is kept as `refused`, with why.

#### `GET /api/businesses/:businessId/tax-changes`
Permission: `catalog.view`
Query/Body: the paged-list values; search reason, slab and who entered it; filter `state` (`scheduled` (an item still to move), `in_force`, `refused`, `cancelled`)
Returns: `data = { total, items[{ id, starts_on, rate, rate_name, keeps, reason, created_at, created_by, created_by_name, tax_rate_id, items, scheduled, applied, cancelled, refused, state }] }`. Changes still to come are listed first, then by date, the latest first.

#### `POST /api/businesses/:businessId/tax-changes/preview`
Permission: `catalog.edit`
Query/Body: `startsOn` (YYYY-MM-DD), `taxRateId` (a switched-on slab), `keeps` (`total` by default: a price that includes GST keeps what the customer pays; `net`: it keeps its part before GST and the price moves; a price before GST never moves), and either `items` (1-2,000 item ids) or `filters: { taxRateId?, categoryId? (with the categories below it), hsn? (the first 2-8 digits), q? (name, code, barcode or brand), inactive? (switched-off items too) }`. A person tied to a department sees that department's items only.
Returns: `data = { startsOn, today (the business's own date), keeps, target: { id, name, rate }, dateProblem, items[], more, moving, documents[] }`. Nothing is saved. Each item is `{ id, code, label, category, hsn, unit, active, pricesIncludeGst, from: { rate, name }, to: { rate, name }, price: { before, after }, gst: { before, after }, total: { before, after }, mrp, same, problem }`, worked out for one unit to the paisa as a bill would. `from` is the item on the day before, after any change it has on an earlier date. `same` means the item is at that rate on the day already. `problem` says why it cannot move: another change moves it that day, it would sell above its MRP, a fuel stays on the nil slab, jewellery is at 3%, or a room type's slab is set by its tariff. A kit is never listed: its GST follows its parts. `dateProblem` says why the date cannot be used. `more` is true when more than 2,000 items fit the filters. `moving` counts the items that can move. `documents` lists the open quotations and sales orders holding an item that moves (a kit's part too; a quotation's line not yet billed, an order's line not yet sent), each `documents[{ kind (`quotation`, `sales_order`), id, number, customer, valid_until | expected_on, items[] }]` (the labels of its items that move); each of them shows a notice until the date (`tax_notices` on [GET /quotations/:id](#quotations) and on the sales order).
Errors: 400 a bad date, slab or filter; 404 slab not found or switched off.

#### `POST /api/businesses/:businessId/tax-changes`
Permission: `catalog.edit`
Query/Body: `requestKey`, `startsOn` (later than the business's today, and no later than the same day two years on), `taxRateId`, `keeps`, `items` (1-2,000 item ids), `reason` (required, up to 300 characters, such as the notification)
Returns: 201, the change as `GET …/tax-changes/:changeId` gives it. Audited `tax_change.scheduled`. The same key and body return the same change.
Errors: 400 a date that is not later than today (the sentence says to change the slab on the item to change it from today), or more than two years on; 403 an item outside the caller's department; 404 an item (a kit) or slab not found; 409 `{ reason: "items_refused", items[{ id, label, problem }] }` (the preview's problems: leave those items out); 409 `{ reason: "already_at_rate", items[] }`; 409 the same key with another body.

#### `GET /api/businesses/:businessId/tax-changes/:changeId`
Permission: `catalog.view`
Query/Body: none
Returns: the change as the list gives it, with `items[{ id, sku_id, label, code, status (scheduled, applied, cancelled, refused), from_name, from_rate, to_rate, price_before, price_after, settled_at, note, cancelled_at, cancel_reason, cancelled_by_name }]` and, while items are still to move, `documents[]` as the preview gives them. `note` says why an item was refused, or what to put right after it moved (a price before GST that now sells above its MRP).
Errors: 404 not found.

#### `POST /api/businesses/:businessId/tax-changes/:changeId/cancel` and `POST /api/businesses/:businessId/tax-changes/:changeId/items/:itemId/cancel`
Permission: `catalog.edit`
Query/Body: `reason` (required, up to 300 characters)
Returns: the change. Every item still to move stays where it is (or, by the second path, the one item). Audited `tax_change.cancelled` or `tax_change.item_cancelled`. Asking again returns the same change.
Errors: 404 the change or item not found; 409 the change's date has come: it is in force and kept for good (enter another change to move the items again).

#### `POST /api/businesses/:businessId/tax-changes/import/preview`
Permission: `catalog.edit`
Query/Body: `startsOn`, `keeps` (as for a change), `lines[{ code, rate }]` (1-5,000: an HSN or SAC code of 4, 6 or 8 digits, written with or without spaces and dots; a rate of 0-100 with up to two decimals, with or without its `%`). A code of 4 or 6 digits finds every item whose code starts with it; switched-off items are found too.
Returns: `data = { startsOn, today, keeps, dateProblem, lines[{ code, rate, target: { id, name, rate } | null, problem, found, items[{ id, label, code, hsn }] (the first 100), more }], unmatched[] (the codes that find nothing), conflicts[{ id, label, code, hsn, lines[{ code, rate }] }] (items two lines give different rates), leftOut[{ id, label, hsn, problem }] (items that stay where they are, and why; the first 200), leftOutCount, moving, changes[{ target, items }] (the changes it becomes: one per rate, of up to 2,000 items each), documents[] }`. A line's `problem` says the business has no slab at its rate. Nothing is saved.
Errors: 400 a bad date, a line that is not a code and a rate, a code given twice at different rates, more than 5,000 lines, or a list that finds more than 20,000 items.

#### `POST /api/businesses/:businessId/tax-changes/import`
Permission: `catalog.edit`
Query/Body: `requestKey`, `startsOn`, `keeps`, `reason` (required, up to 300 characters, such as the notification), `lines[]` as for the preview
Returns: 201, `data = { id, codes, items, created_at, changes[{ id, starts_on, rate_name, rate, items, state }] }`: the list kept as given (`business_tax_change_imports`) and the changes it became, each named by it (`import_id`) and listed, opened and cancelled like any other. Audited `tax_change.imported` with what it moved. The same key and body return the same list.
Errors: 400 as for the preview, or a date that is not later than today; 409 `{ reason: "no_rate", code }` a line finds items and the business has no slab at its rate; 409 `{ reason: "import_conflicts", items[] }` items two lines give different rates (put the list right first); 409 `{ reason: "nothing_moves" }`; 409 the same key with another body.

#### `GET /api/businesses/:businessId/tax-changes/settings`
Permission: `catalog.view`
Query/Body: none
Returns: `data = { setting, name, where, today, current, currentWords, changes[] }` for the rate the business keeps in its settings: a fashion shop's `fashion_price` (*GST by price*; `current = { threshold, rateLow, rateHigh, active }`), a lodging business's `lodging_slabs` (with module `lodging`; `current = { lowTaxRateId, highTaxRateId, slabLimit, lowName, lowRate, highName, highRate }`); `current` is null while it is not set up. Any other business answers `{ setting: null, changes: [] }`. Each change is `{ id, setting, name, startsOn, status (scheduled, applied, cancelled, refused), state (scheduled, in_force, cancelled, refused), values, words, before, beforeWords, reason, note, settledAt, createdAt, createdByName, cancelledAt, cancelledByName, cancelReason }`, those to come first; `before` is what the setting was when the change took effect. Changes due on the business's date take effect first.

#### `POST /api/businesses/:businessId/tax-changes/settings`
Permission: `settings.edit`
Query/Body: `requestKey`, `startsOn` (as for a change), `reason` (required, up to 300 characters), `values`: `{ threshold (1-10,000,000), rateLow, rateHigh (0-100, the higher at least the lower) }` for GST by price; `{ lowTaxRateId, highTaxRateId (two different slabs in use, the lower's rate below the higher's), slabLimit (1-10,000,000) }` for room nights
Returns: 201, the change as the list gives it. Audited `tax_change.setting_scheduled`. On its date, on the business's clock, the database applies it with the items' changes (`tax_change.setting_applied`, in the name of whoever entered it); one it refuses (a slab switched off) is kept as `refused`, with why. The same key and body return the same change.
Errors: 400 bad values or date; 403 without `settings.edit`; 404 the business keeps no such rate, or a slab not found or switched off; 409 `{ reason: "not_set_up" }` the rate was never set up; 409 another change of it starts that day (cancel that one first); 409 `{ reason: "already_set" }` it is that already on the day; 409 the same key with another body.

#### `POST /api/businesses/:businessId/tax-changes/settings/:changeId/cancel`
Permission: `settings.edit`
Query/Body: `reason` (required, up to 300 characters)
Returns: the change, cancelled. Audited `tax_change.setting_cancelled`. Asking again returns the same change.
Errors: 404 not found; 409 its date has come: it is in force (or was refused) and kept for good.

**The bell** (`GET /api/businesses/:businessId/notifications`), for those who may change the catalogue (`catalog.edit`): each change still to come within 7 days, category `GST rates`, `id` `tax_change:<change id>:7` from the seventh day before its date and `tax_change:<change id>:1` on the day before (so it is new again), `title` how many items move and to which slab (`3 items move to GST 5% in 7 days`, `… tomorrow`), `detail` the date, the slabs they are at now and the reason, linking to `…/tax-changes`. A change of a rate kept in settings is `tax_change:setting:<id>:7` or `:1`, `title` "GST by price changes tomorrow".

#### `GET /api/businesses/:businessId/catalog/:id/tax-history`
Permission: `catalog.view`
Query/Body: none
Returns: `data = { item: { id, label, code, tax_rate, tax_rate_id, slab_name, price, active }, changes[], edits[{ id, created_at, details: { label, from, to, fromRate, toRate }, actor_name }] }`. `changes` holds each change for the item, past and to come, as the change's items with its `reason`, `keeps`, `rate`, `to_name`, `created_at` and `created_by_name`. `edits` holds each time the slab was changed on the item itself (audited `catalog.slab_changed`).
Errors: 404 item not found.

### Sales and purchase documents

#### `POST /api/businesses/:businessId/documents`
Permission: `sales.create` or `purchasing.create`. The service then requires the one that matches `kind`, plus `<kind>.edit` when money is taken now, a voucher is spent or part is financed.
Query/Body:
- `kind` (`sale`/`purchase`), `requestKey`, `locationId`, `contactId` (required for a purchase; a customer for a sale), `notes`.
- `lines[1..100]` of `{ skuId, quantity, unit? (a pack or related unit), lotCode (batch/serial items), expiresOn }`. Purchase lines also take `unitPrice`; `freeQuantity?` and `discountPercent?` (free units on a scheme, "10 + 1 free", and a trade discount of up to 99.99% on the rate, in the line's own unit); and `sellingPrice?` / `mrp?` (the item's new shelf price and MRP from this bill; needs `catalog.edit`; audited as `catalog.price_changed`). A sale line whose item is a kit takes `components[]` of `{ skuId, lotCode }`, naming the serial (required) or batch (optional; the earliest expiry otherwise) of a part.
- Money taken now: `payment` `{ amount, method (cash/card/upi/bank/cheque) or methodId, reference, tendered? }`, or `payments[1..8]` of the same shape for a bill paid in several ways (sending both is a 400). An `amount` of `"full"` (on at most one part) is the rest of the bill. `tendered` (the cash handed over) is for cash only and is at least that part's amount; the answer then carries `change`.
- A purchase: `supplierBillNo` and `supplierBillDate` (the supplier's own bill; a date needs the number and is not in the future).
- A sale: `buyer: { name, phone, pan, panDeclaration }` (a walk-in who is not saved as a customer, used for a warranty; `pan` the buyer's PAN, or `panDeclaration: true` when they have none and signed Form 97, not both); `discount: { amount | percent, reason }` (a counter discount: an amount or a percent with up to 2 decimals, not both, and a reason of up to 120 characters; needs `sales.discount`; at most the business's *Most discount at the counter*, `maxBillDiscountPercent`, unless the caller is an Owner); `voucher: { code }` (an exchange credit voucher; it pays first, as a `credit_note` payment with the voucher number as reference, never more than its balance or the bill, and `"full"` is then what is left); `finance: { financierId, loanNo, doNo?, tenureMonths?, amount (a number, or "rest") }` (an EMI through a financier: needs module `finance` and `finance.create`; the financed amount becomes a payment of method `finance`); `channel: "counter"` with `counterPin` (Quick bill: when Business settings ask for the PIN on every bill, `counter_pin_every_bill`, it is the PIN of the person the session belongs to; the PIN is left out of the request hash and never stored) or, in its place, `counterProof`: the `billProof` that `POST …/counter/switch` gave the till, good for one bill within 2 minutes, from the session it gave (the same bearer token) and for the person the till was switched to; it is spent inside the bill's own posting (a bill refused for another reason leaves it, and the same bill sent again with its request key is answered), and is left out of the request hash too; `pickupOrderId` (a meat or weight shop's open order for pickup that this bill closes: its advance, when it has one, pays after a voucher and before the money taken now, as a payment from its receipt, `collection_id`, method and reference the receipt's; the bill must then be in the order's customer's name; the bill and the order's closing are one posting, and the same bill sent again finds the order closed with it).
- Retail sales also take `loyalty: { redeemPoints }` (needs `loyalty.create`) and `coupon` (a code typed at the counter; needs the Offers module); salon sales take the salon fields. See `businessOffers.js` and `businessSalonSales.js`.
- A hardware shop's sale also takes `siteId` (one of the customer's open sites), `fitterId` (a fitter who is on, with module `fitter_commission` and `fitter_commission.create`; the bill's commission is worked out and kept with it), `calculations` (the material calculators' workings, kept with the bill) and, on a line, `tint: { shadeId }` (paint tinted to a shade, with module `hardware_tinting` and `hardware_tinting.create`): [Hardware, paints & building materials](#hardware-paints--building-materials). Any other business, or a purchase, naming a site, a fitter or workings, or tinting a line, is refused with 400 before anything is posted.
- A seeds, fertilisers & pesticides shop's sale also takes `agri: { posReceipt?, crop?, season?, seasonYear?, dueOn?, village? }` and, on each line, `crop?` and `posReceipt?`; each farm-input line is checked for its licence, its molecules, its crop, its lot and its PoS receipt: [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides). Any other business, a purchase, or a farm-input shop with the module off, sending them is refused with 400 before anything is posted.

Returns: 201, the document row (`document_no`, `subtotal`, `tax`, `round_off`, `total`, `due_on`, ...), plus `change` when cash was handed over, `financeCase` for an EMI sale, `warranties` when serial units are sold with the Warranties module on, and `warnings` (sentences) when it was posted with a warning: a farm-input shop's licence notes, or fertiliser bought from a source without a certificate of source. The warnings are kept with `sale.posted` or `purchase.posted` in the activity log. The server works out sale prices (customer price, quantity slabs, pack prices, the selling branch's own price, a loyalty customer's member price, offers, the counter discount) and GST from the business tax mode and rounding. A sale's place of supply is the buyer's GSTIN state, else the selling location's own state, else the business's. Each line keeps the item's HSN code and MRP. A purchase line with free units takes in paid + free units and is charged for the paid ones, less the trade discount; it keeps `free_quantity` and `discount_percent`. Each payment part is its own `business_payments` row (`tendered` kept on the cash row).
Rules:
- A goods shop's walk-in (a sale with no customer) pays the whole bill now, counting a voucher and a financed part, unless the business allows unpaid walk-in bills (`walkInCredit`): otherwise 409 "A walk-in customer pays the whole bill now…".
- Nothing is sold, or given a new shelf price on a receipt, above its MRP; with prices before GST the GST is added before comparing.
- The parts paid, plus any voucher and financed amount, may not come to more than the total.
- A customer's credit limit counts what they would owe after this sale, less what they pay now.
- A sale over ₹2,00,000 records the buyer's PAN: `buyer.pan`, else the customer's saved PAN, else the PAN inside their GSTIN or on their wholesale details; or `buyer.panDeclaration`. Otherwise 400. The document keeps `buyer_pan` and `pan_declaration`.
- Cash of ₹2,00,000 or more is refused (409, a sentence citing section 186 of the Income-tax Act 2025) for one bill, and from one customer in one business day across their bills and collection receipts. Other methods are not limited.
- A supplier's bill number already received from that supplier is refused.
- A kit sells as its parts, each at its share of the kit's price; a serial-numbered part makes it one kit per line. Saved lines carry `kit_sku_id`, `kit_label` and `kit_group`.
- An EMI needs the customer named (a contact, or `buyer` with a name; a phone is optional), and a loan number is used once per financier.
- Each line takes its item's GST slab in force on the bill's own date, on the business's clock: changes whose date has come take effect inside the posting first ([GST rate changes](#gst-rate-changes)). A posting a change overtakes around midnight answers 409 `{ reason: "gst_rates_changed" }`: send it again.

Errors: 400 both `payment` and `payments`, more than 8 parts, or two parts of `"full"`; 400 the parts come to more than the total; 400 cash handed over less than its part; 400 free quantity or a trade discount on a sale; 400 a serial-numbered kit part on a line of more than one kit; 400 an EMI amount more than what is left; 400 pharmacy purchases without a batch or expiry, and quantity or unit-precision errors; 403 `{ reason: "pin_required" }` without the counter PIN, or with a `counterProof` already used (on another bill), run out, from another session, another person or another business; 400 `wrong_pin`, 423 `pin_locked`, 429 too many tries; 400 `pickupOrderId` on a purchase ("An order for pickup is closed by a sale"); 404 the order for pickup not found; 409 the order already collected or cancelled, or (with an advance) the bill not in its customer's name; 404 location, contact or item not found; 404 no coupon with that code, or an unknown voucher; 409 not enough usable stock, credit limit exceeded, serial already received, or request key reused with different data; 409 a walk-in not paying in full; 409 a price above the MRP; 409 a supplier bill number already received ("Bill … from … was already received as …"); 409 an item kept for use in services only (`internalUse`); 409 a coupon that cannot be used now (switched off, outside its dates or hours, the bill below its minimum, used up, or already used by this customer as often as allowed); 409 a counter discount over the business's limit, or more than the bill; 409 a voucher expired or used up; 409 buying a kit; 409 an EMI without the customer named, or a loan number already used with that financier.

#### `GET /api/businesses/:businessId/documents/:id`
Permission: `sales.view` or `purchasing.view`, plus the one matching the document's kind
Query/Body: none
Returns: `{ ...document, location_name, contact_gstin/phone/address, lines[] (each with returned_quantity), payments[] (each with method_name and tendered), returns[], refunds[], seller, retail, finance[], pharmacy, wholesale }`. `contact_gstin` and `contact_address` are the buyer's as billed. `seller` is Business settings with the selling location's own address, phone, state and GSTIN where it has them, and `branch_name` when it has its own address or GSTIN. For a sale, `retail` is `{ discounts[], savings, loyalty[], heldBack }`; otherwise it is null. `finance` lists an EMI bill's case (financier, loan, DO, amounts, status), and is empty otherwise. `pharmacy` is filled for a pharmacy sale (see [Pharmacy, clinic & lab](#pharmacy-clinic--lab)), `wholesale` for an invoice raised by dispatching a sales order (see [Sales orders and dispatch](#sales-orders-and-dispatch)), `hardware: { site, fitter, tints, calculations }` for a hardware shop's sale (see [Hardware, paints & building materials](#hardware-paints--building-materials)) and `agri: { lines, bill, farmer, licences }` for a farm-input shop's sale (see [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides)); otherwise they are null.
Errors: 403 another location's document for a person tied to one; 404 not found.

#### `POST /api/businesses/:businessId/documents/:id/payments`
Permission: `sales.edit` or `purchasing.edit` (the one matching the document's kind)
Query/Body: `amount` (at least 0.01), `method` (`cash`/`card`/`upi`/`bank`/`cheque`) or `methodId`, `requestKey`, `reference`
Returns: 201, the payment row (with `method_name` when a named method was used).
Errors: 404 document not found; 409 "Payment exceeds the outstanding amount", the key was reused with different data, or the cash limit (₹2,00,000 on one bill or from one customer in a day) would be reached.

#### `POST /api/businesses/:businessId/documents/:id/returns`
Permission: `sales.refund` or `purchasing.refund` (the one matching the document's kind)
Query/Body: `reason` (required), `requestKey`, `lines[1..100]` of `{ lineId, quantity, restock (sales only, default true) }`
Returns: 201, the return row (`return_no`, `total`, `round_off`). Stock goes back in, or out for a purchase return, at the line's recorded cost. A proportional share of the round-off is returned. The loyalty points the sale earned are reversed, and, while the loyalty rule `returnSpentPoints` is on (it is until changed), the points spent on the bill are given back in proportion (`retail_loyalty_entries` kind `restore`).
Errors: 404 document or line not found; 409 return quantity exceeds what remains, not enough stock for a supplier return, serial already in stock, or no recorded stock cost.

#### `POST /api/businesses/:businessId/documents/:id/refunds`
Permission: `sales.refund` or `purchasing.refund` (the one matching the document's kind)
Query/Body: `amount` (at least 0.01), `method` (`cash`/`card`/`upi`/`bank`) or `methodId` (never a cheque), `reason`, `requestKey`
Returns: 201, the refund row. On an EMI bill a refund is never more than the customer paid themselves; the financed part is reversed by cancelling the loan (`POST …/finance/cases/:id/cancel`).
Errors: 409 the refund exceeds the credit available after returns, exceeds what was paid less earlier refunds, or eats into the value held back for spent loyalty points; 409 on an EMI bill, more than the customer paid; 404 not found.

### Counter: staff switch and cashier shifts

#### `GET /api/businesses/:businessId/counter/staff`
Permission: `sales.create`
Query/Body: none
Returns: `{ current, people[] }`: `current` is the signed-in person's id, and `people` the members whose role may create sales, each `{ id, name, roleName, hasPin, locked }`.

#### `POST /api/businesses/:businessId/counter/switch`
Permission: `sales.create`; the PIN rate limit
Query/Body: `userId`, `pin`, `deviceTokens?`
Returns: the till carries on as that member: `{ token, expiresAt, user }`, like `POST /api/auth/pin-login`. When the business asks for the PIN on every bill, also `billProof` and `billProofExpiresAt`: the PIN just typed counts for that person's next counter bill, sent as `counterProof` with the new `token` within 2 minutes (`POST …/documents`, `POST …/pharmacy/sales`). Only the proof's SHA-256 is kept (`business_counter_bill_proofs`), with the new session's; proofs a day past their time are deleted on the next switch. Audited `counter.switched` (`from`, `to`, `billProof`: whether one was given).
Errors: 404 the person does not bill at this business; the PIN, account-lock and two-step device rules of `POST /api/auth/pin-login` apply.

#### `GET /api/businesses/:businessId/shifts`
Permission: `sales.create`
Query/Body: `date` (default today), `location` (the one in effect when left out)
Returns: `data = { date, items[] }`: the cashier shifts opened that day, newest first. Someone with `reports.view` or `sales.view` sees every cashier's; a cashier sees their own. Each shift is `{ id, location_id, location_name, user_id, cashier_name, opening_cash, opened_at, closed_at, closed_by_name, movement_cash, expected_cash, counted_cash, difference, reason, ... }`; an open one adds `movement_so_far` and `expected_so_far`.
Errors: 400 invalid date; 403 another location for a person tied to one.

#### `GET /api/businesses/:businessId/shifts/current`
Permission: `sales.create`
Query/Body: `location` or `locationId` (required; filled in by the location in effect)
Returns: `data` = the caller's open shift at that counter location, with the cash it should hold so far, or null.
Errors: 400 no location; 403 another location for a person tied to one.

#### `POST /api/businesses/:businessId/shifts`
Permission: `sales.create`
Query/Body: `locationId` (required), `openingCash` (required, an amount like 1500 or 1500.50)
Returns: 201, the shift with `movement_so_far` and `expected_so_far`. A cashier's shift at one counter: in a supermarket many cashiers bill at once, and each count is checked only against what they took and paid out.
Errors: 400 a bad amount; 404 counter location not found or closed; 409 "Your shift at this counter is already open. Close it before opening another."

#### `POST /api/businesses/:businessId/shifts/:id/close`
Permission: `sales.create`; closing someone else's shift also needs `reports.edit`
Query/Body: `countedCash` (required), `reason` (up to 300; required when the count differs)
Returns: the closed shift: `expected_cash` is the opening cash plus this cashier's own cash movements at that location since it opened (cash taken on sales and collections, refunds received from suppliers; less cash refunds, payments to suppliers and expenses they paid, with an expense reversed in the meantime coming back), and `difference` = counted less expected. A closed shift is a permanent record.
Errors: 400 `{ reason: "difference_reason_required", expected, counted, difference }` ("The drawer is 50.00 short. Say why."); 403 another cashier's shift without `reports.edit`, or another location's; 404 shift not found; 409 already closed.

### Kits

A kit (a bundle) is a goods SKU (`is_kit`) made of other items; on a bill it expands to its parts (see [POST …/documents](#post-apibusinessesbusinessiddocuments)). `GET …/catalog` rows carry `is_kit`; a kit's `stock` is the kits its parts allow; filter `kit=true`. `GET …/retail/scan` of a kit returns `kit: { components[] (with lots for serial / batch parts) }`.

#### `GET /api/businesses/:businessId/kits`
Permission: `catalog.view`
Query/Body: `limit` (up to 100, default 25), `offset`, `q` (label, code or barcode)
Returns: `data = { items[], total, limit, offset }`. Each kit is `{ id, code, barcode, label, price, mrp, tax_rate, active, created_at, components[{ skuId, label, code, quantity, price, taxRate, hsnCode, tracking, stock }], parts_value, available }`; `available` is how many kits the parts in stock allow. Switched-on kits first.

#### `POST /api/businesses/:businessId/kits`
Permission: `catalog.create`
Query/Body: `name` (required, up to 150), `code` (required, upper-cased), `barcode?`, `brand?`, `price` (required), `mrp?`, `components[1..20]` of `{ skuId, quantity (0.001-1000, default 1) }`. Parts must be active goods that are not kits, each item once (raise its quantity instead), a serial-numbered part once per kit, whole numbers for items counted in whole units; at least two pieces in all.
Returns: 201, the kit's SKU row. It is stocked in the business's count unit (each, pcs), and its GST rate for the MRP check is the highest of its parts'.
Errors: 400 no goods inventory, no count unit, or a component rule above; 404 a component not found; 409 the barcode is on another item, the price is above the MRP, or the code is taken.

#### `PATCH /api/businesses/:businessId/kits/:id`
Permission: `catalog.edit`
Query/Body: any of `name`, `price`, `mrp`, `active`, `components` (replaces the parts; the rules of create). Fields left out keep their value.
Returns: the updated SKU row.
Errors: 404 kit not found; the component errors of create; 409 the price is above the MRP.

### EMI & finance

Module `finance` (electronics): a sale paid partly by a financier's loan (`finance` on [POST …/documents](#post-apibusinessesbusinessiddocuments)), the cases the financiers still owe, their payouts, and cancelling a loan.

#### `GET /api/businesses/:businessId/finance/financiers`
Permission: `finance.view` or `finance.create`
Query/Body: none
Returns: `data = { items[] }`, switched-on financiers first: each `{ id, name, subvention_percent, active, ..., outstanding, pending_cases }`.

#### `POST /api/businesses/:businessId/finance/financiers`
Permission: `finance.edit`
Query/Body: `name` (required, up to 100), `subventionPercent` (0-30, default 0: the dealer subvention the financier keeps), `active` (default true)
Returns: 201, the financier.
Errors: 409 "<name> is already in the list".

#### `PATCH /api/businesses/:businessId/finance/financiers/:id`
Permission: `finance.edit`
Query/Body: any of `name`, `subventionPercent`, `active` (left out: kept)
Returns: the updated financier.
Errors: 404 financier not found; 409 duplicate name.

#### `GET /api/businesses/:businessId/finance/cases`
Permission: `finance.view`
Query/Body: `limit` (up to 100, default 25), `offset`, `status` (`pending`/`settled`/`cancelled`), `financierId`, `q` (loan, DO, bill number or customer), `from`/`to` (the case's date)
Returns: `data = { items[], total, financed, limit, offset }`, pending first, newest first. Each row is the case plus `financier_name, subvention_percent, document_no, bill_total, contact_id, location_id, customer_name, age_days, received_on, settlement_reference, settlement_method`; `financed` is the sum of the matching cases.
Errors: 400 an unknown status or a bad date.

#### `GET /api/businesses/:businessId/finance/outstanding`
Permission: `finance.view`
Query/Body: none
Returns: `data = { items[{ id, name, subvention_percent, active, cases, financed, expected_subvention, oldest_at, oldest_days, over_15_days }], total, expectedSubvention, expectedPayout }`: what each financier owes now (pending cases), largest first.

#### `POST /api/businesses/:businessId/finance/settlements`
Permission: `finance.edit`
Query/Body: `requestKey` (UUID, required), `financierId`, `locationId`, `receivedOn` (required dates and ids), `method` (`bank`/`cheque`/`upi`), `reference?` (UTR or cheque number), `notes?`, `amountReceived`, `cases[1..200]` of `{ caseId, subvention? }` (default subvention: the financier's % of the financed amount)
Returns: 201, the payout with `financier_name` and `cases` (the count). Each case becomes `settled`. The payout is money in on the day it is recorded (`reports/takings`, `received.fromFinanciers`). Repeating the key returns the first payout.
Errors: 404 financier, location or a case not found; 409 a case is not pending or is with another financier; 409 the amount is not exactly the cases' financed amounts less their subvention; 400 a subvention above a case's financed amount, or a case listed twice.

#### `POST /api/businesses/:businessId/finance/cases/:id/cancel`
Permission: `finance.edit`
Query/Body: `reason` (required, up to 300), `requestKey` (UUID, required)
Returns: the case, `cancelled`. The financier cancelled the loan before paying it out (the goods came back): a refund of method `finance` reverses the financed part on the bill.
Errors: 404 EMI case not found; 409 the case is not pending; 409 the returns on the bill do not yet cover the financed amount ("Take the goods back on … first").

### Paying suppliers

What the business owes its suppliers: the payables list, one supplier's account and statement, and paying a supplier against several receipts at once. A payment is one voucher (`payment_no` from the `supplier_payment` series); the part that settles a receipt is an ordinary payment on that purchase, so every balance stays right. Advances and credit left on receipts are applied to the oldest items first.

#### `GET /api/businesses/:businessId/payables`
Permission: `purchasing.view`
Query/Body: `limit` (up to 100, default 25), `offset`, `q` (name, phone or GSTIN), `show` (`owing` default, `overdue`, `advance`, `all`), `sort` (`outstanding` default, `overdue`, `name`, `oldest`)
Returns: `data = { total, totals: { balance, outstanding, overdue }, items[{ contact_id, name, phone, gstin, credit_days, balance, outstanding, overdue, open_bills, oldest_bill, next_due, last_paid_at }] }`. Overdue is by each supplier's credit days.
Errors: 400 invalid pagination, show or sort.

#### `GET /api/businesses/:businessId/suppliers/:contactId/account`
Permission: `purchasing.view`
Query/Body: none
Returns: `data = { contact, summary, items[{ contact_id, document_id, reference, supplier_bill_no, bill_date, due_on, amount, open_amount, age_days, overdue }], advances[{ id, payment_no, created_at, amount, unallocated }] }`: the supplier's balance, the receipts still to pay (oldest first) and advances not yet applied.
Errors: 404 supplier not found.

#### `GET /api/businesses/:businessId/suppliers/:contactId/statement`
Permission: `purchasing.view`
Query/Body: `from`, `to` (required dates)
Returns: `data = { contact, from, to, opening, billed, paid, closing, entries[{ day, at, kind (opening/purchase/return/payment/voucher/refund), reference, billed, paid, document_id, balance }], seller }`: every money event with the supplier in date order, with the balance brought forward and a running balance of what the business owes.
Errors: 400 invalid dates, the end before the start, or more than 5,000 entries; 404 supplier not found.

#### `POST /api/businesses/:businessId/suppliers/:contactId/payments`
Permission: `purchasing.edit`
Query/Body: `requestKey` (UUID, required), `locationId`, `amount` (at least 0.01), `method` (`cash`/`upi`/`bank`/`cheque`/`card`) or `methodId`, `reference` (the cheque number for a cheque), `notes`, `allocations?` (up to 200 `{ documentId, amount }`; leave it out to settle the oldest due receipts first, or send `[]` to keep the whole amount as an advance)
Returns: 201, `{ ...voucher, allocated, unallocated, settled[{ documentId, amount }] }`. With automatic allocation, any opening balance not yet covered is kept against first. Repeating the key with the same body returns the voucher.
Errors: 400 a cheque without its number; 400 the receipts chosen add up to more than the amount, or a receipt named twice; 404 location or supplier not found; 404 "That receipt is not one of this supplier's purchases"; 409 the key was used for different data; 409 "Payment exceeds the outstanding amount".

#### `GET /api/businesses/:businessId/supplier-payments/:id`
Permission: `purchasing.view`
Query/Body: none
Returns: `data` = the voucher with `location_name, created_by_name, contact_phone, contact_gstin, contact_address, allocations[{ id, amount, document_id, document_no, supplier_bill_no, total, bill_at }], allocated, unallocated, seller` (for the print). The list is `GET …/supplier-payments` (paged lists above).
Errors: 404 supplier payment not found.

### Purchase orders to suppliers

Purchase orders for any business that buys goods (the Purchasing module). The routes are registered from `businessTrade.routes.js`. Reading needs `purchasing.view`; raising, changing, sending, receiving and closing need `purchasing.create`. Each step is audited (`purchase_order.raised`, `changed`, `sent`, `received`, `closed`, `cancelled`) and written as a `purchase_order.*` event.

#### `GET /api/businesses/:businessId/purchase-orders`
Permission: `purchasing.view`
Query/Body: the paged-list contract; filters `status` (`draft`/`sent`/`part_received`/`received`/`closed`/`cancelled`, several comma-separated), `contact`, `location`, `late` (`true`); dates on `created_at`
Returns: `{ total, items[] }`; rows add `location_name, line_count, pending_value, receipt_count, received_value, late`.

#### `GET /api/businesses/:businessId/purchase-orders/suggestions`
Permission: `purchasing.view`
Query/Body: `location`, `supplier`
Returns: `{ location, items[{ sku_id, label, code, unit, tax_rate, reorder_level, stock, back_orders, on_order, supplier_id, supplier_name, last_cost, last_bought_at, pack_unit, pack_factor, need, reason (reorder/back_order), suggested_quantity, suggested_unit, suggested_base }] }`. `need` = back-orders + reorder level − usable stock − on order (open purchase orders), suggested in whole cases (the stock unit when the item has no pack). Back-orders count only with the Sales orders module.

#### `POST /api/businesses/:businessId/purchase-orders`
Permission: `purchasing.create`
Query/Body: `requestKey`, `contactId` (a supplier), `locationId`, `expectedOn?`, `notes?`, `lines[1..200]` of `{ skuId, quantity, unit?, unitCost? (per the unit typed, before GST; default the last purchase cost), source? (manual/reorder/back_order) }`
Returns: 201, the order (`po_no` from the `purchase_order` series, status `draft`).
Errors: 400 an item never bought and sent without a cost; 400 the same item twice; 400 a service.

#### `GET /api/businesses/:businessId/purchase-orders/:id`
Permission: `purchasing.view`
Query/Body: none
Returns: the order with the supplier's contact details, `lines[]` (with `remaining`, `stock`, `hsn_code`, `tracking`), `receipts[]` (the purchase document, total, supplier bill, lines) and `seller` (for the print).
Errors: 404 purchase order not found.

#### `PATCH /api/businesses/:businessId/purchase-orders/:id`
Permission: `purchasing.create`
Query/Body: `contactId?`, `expectedOn?`, `notes?`, `lines?` (as for create)
Returns: the order.
Errors: 409 the order is not a draft (once sent, close it and raise another).

#### `POST /api/businesses/:businessId/purchase-orders/:id/send`
Permission: `purchasing.create`
Query/Body: `via` (`whatsapp`, `email`, `printed`, `phone`, `other`)
Returns: the order, now `sent`.
Errors: 409 the order is not a draft.

#### `POST /api/businesses/:businessId/purchase-orders/:id/receive`
Permission: `purchasing.create`
Query/Body: `requestKey`, `supplierBillNo?`, `supplierBillDate?`, `notes?`, `lines[1..200]` of `{ poLineId, quantity, unit? (the order's pack or the stock unit), unitCost? (the bill's cost per the unit typed; default the order's), lotCode?, expiresOn? }`
Returns: 201, the order detail. One core purchase is posted (`documents` kind `purchase`, notes "Against PO…"), counting at most what was still to come on each line; the status becomes `part_received` or `received`. A repeat with the same key returns the same receipt.
Errors: 404 a line not on this order; 409 the order is received, closed or cancelled; the core's checks (batch required, duplicate supplier bill) apply.

#### `POST /api/businesses/:businessId/purchase-orders/:id/close`
Permission: `purchasing.create`
Query/Body: `reason`
Returns: the order: `cancelled` when nothing was received, `closed` when part was (the rest will not come).
Errors: 409 the order is not open.

### Daily expenses

Module `expenses` (Daily expenses; on by default for every type but the restaurant, which has its own `/api/expenses`): rent, wages, transport and other money paid out of the business. An expense is never edited or deleted: a mistake is reversed once, with a reason. Paid expenses lower the day close's cash (`reports/takings`) and appear in `GET …/reports` as `expense` and `expense_reversal`.

#### `GET /api/businesses/:businessId/expenses`
Permission: `expenses.view`
Query/Body: `from` (default today), `to` (default `from`; up to 367 days), `locationId` or `location` (one location; the one in effect when left out, else every location), `q` (description, reference or category), `limit` (up to 100, default 25), `offset`
Returns: `data = { items[], total, limit, offset, totals: { paid, reversed } }`, newest first. Each item is the expense (`id, location_id, spent_on, category, description, amount, method, method_name, method_id, reference, created_by, created_at, voided_at, voided_by, void_reason`) plus `location_name, created_by_name`. An expense counts in the period it was paid and, once reversed, in the period it was reversed.
Errors: 400 invalid dates or "Choose up to 367 days"; 400 invalid pagination; 403 another location for a person tied to one.

#### `POST /api/businesses/:businessId/expenses`
Permission: `expenses.create`
Query/Body: `requestKey` (UUID, required), `spentOn` (required; not in the future, at most 30 days back), `amount` (0.01 and up, required), `description` (required, up to 200: what was paid for), `category` (required: `rent`, `utilities`, `wages`, `transport`, `supplies`, `cleaning`, `maintenance`, `other`), `method` (`cash`/`upi`/`card`/`bank`) or `methodId`, `reference` (up to 100), `locationId` (required unless a location is in effect)
Returns: 201, the expense. Repeating the key with the same body returns it.
Errors: 400 a future date or one more than 30 days back; 400 no location; 404 location not available; 409 "Expenses are switched off for this business"; 409 the cash at this location was already counted on or after that day (a cash check; date it today); 409 the key was used for a different expense.

#### `POST /api/businesses/:businessId/expenses/:expenseId/reverse`
Permission: `expenses.approve`
Query/Body: `reason` (required, up to 300)
Returns: the expense with `voided_at`, `voided_by` and `void_reason`. Reversing again returns it unchanged; the database refuses any other change.
Errors: 400 no reason; 403 another location's expense for a person tied to one; 404 expense not found.

### Stock: adjustments, transfers, counts, near expiry

#### `POST /api/businesses/:businessId/stock/:id/adjustments`
Permission: `inventory.edit` (`:id` is a stock lot)
Query/Body: `quantity` (signed, for example `"-0.200"`; between 0.001 and 100,000 either way), `reason` (required), `requestKey`
Returns: 201, the adjustment row. A matching movement is also written.
Errors: 404 lot not found; 409 the adjustment would make stock negative, or the key was reused; 400 a positive adjustment on a serial item, or a fraction for a whole-unit item.

#### `POST /api/businesses/:businessId/transfers`
Permission: `stock_transfers.create`
Query/Body: `requestKey`, `fromLocationId` (a person tied to a location sends from theirs), `toLocationId` (must differ), `lines[1..200]` of `{ lotId, quantity }` (each lot once; a serial moves 1 unit), `notes`
Returns: 201, the transfer (`transfer_no`, `status='in_transit'`). Stock leaves the sending lots straight away.
Errors: 404 location not found, or the lot is not at the sending location; 409 the quantity is more than the lot holds.

#### `GET /api/businesses/:businessId/transfers/:id`
Permission: `stock_transfers.view`
Query/Body: none
Returns: the transfer with `from_location_name`, `to_location_name`, `created_by_name`, `closed_by_name` and `lines[]` (each with `label, code, unit`).
Errors: 403 a person tied to a location that is neither end; 404 not found.

#### `POST /api/businesses/:businessId/transfers/:id/receive`
Permission: `stock_transfers.approve`
Query/Body: `{}`
Returns: the transfer with `status='received'`. Stock is added to lots at the receiving location at weighted-average cost.
Errors: 403 a person tied to another location than the receiving one; 404 not found; 409 already received or cancelled, the receiving location is closed, a batch is already held there with a different expiry, or a serial is already in stock there.

#### `POST /api/businesses/:businessId/transfers/:id/cancel`
Permission: `stock_transfers.cancel`
Query/Body: `reason` (required)
Returns: the transfer with `status='cancelled'`. The goods go back into the lots they came from.
Errors: 403 a person tied to another location than the sending one; 404 not found; 409 not in transit.

#### `POST /api/businesses/:businessId/counts`
Permission: `stock_counts.create`
Query/Body: `requestKey`, `locationId`, `categoryId` (optional; counts one category), `notes`
Returns: 201, the count (`count_no`, `status='open'`). The sheet holds the lots on hand plus empty quantity-tracked lots, up to 5,000 lines.
Errors: 404 location or category not found; 409 another count is already open at the location, or there is no stock to count; 400 more than 5,000 lines.

#### `GET /api/businesses/:businessId/counts/:id`
Permission: `stock_counts.view`
Query/Body: none
Returns: the count with `location_name`, `created_by_name`, `closed_by_name` and `lines[]`. Each line has `expected_quantity, counted_quantity, reason, current_quantity, lot_code, expires_on, sku_id, label, code, unit, tracking, unit_decimals, adjustment_id`.
Errors: 404 not found.

#### `PATCH /api/businesses/:businessId/counts/:id/lines`
Permission: `stock_counts.create`
Query/Body: `lines[1..5000]` of `{ lineId, countedQuantity (null or blank clears it), reason }`
Returns: the full count detail, the same shape as `GET /counts/:id`.
Errors: 404 count or line not found; 409 the count is not open.

#### `POST /api/businesses/:businessId/counts/:id/post`
Permission: `stock_counts.approve`
Query/Body: `reason` (optional default reason for lines that have none)
Returns: `{ ...count, status: 'posted', counted, corrections }`. Each difference from the stock at the moment of posting becomes a stock adjustment.
Errors: 400 no counted lines, or a difference with no reason; 409 not open, or stock would go negative.

#### `POST /api/businesses/:businessId/counts/:id/cancel`
Permission: `stock_counts.cancel`
Query/Body: `reason` (required)
Returns: the count with `status='cancelled'`.
Errors: 404 not found; 409 not open.

#### `GET /api/businesses/:businessId/retail/near-expiry`
Permission: `inventory.view`
Query/Body: `days` (1-365; default the business's Expiring soon days, `nearExpiryDays`, 30 until changed), `location`
Returns: `{ days, rows[{ id (lot), location_id, location_name, sku_id, label, code, unit, price, lot_code, expires_on, quantity, unit_cost, days_left, cost_value, shelf_value, markdown }], totals{ batches, expired, within7, costValue, expiredCost } }`. Batches with stock expiring within `days` (expired ones too), soonest first, at most 500. `markdown` is the item's running item-% offer (`{ id, name, value, ends_on }`) or null. A markdown is an ordinary `POST …/offers` (`item_percent`), and a write-off an ordinary `POST …/stock/:id/adjustments`.
Errors: 400 days out of range.

### Appointments

For `salon` businesses, booking and status changes are delegated to `businessSalon.service.js`. That service applies service time plus clean-up, opening hours, stylist skills, rooms and deposits, and charges no-show and late-cancellation fees (see [Salon & spa](#salon--spa)).

#### `POST /api/businesses/:businessId/resources`
Permission: `appointments.create`
Query/Body: `locationId`, `name` (required), `roleLabel`
Returns: 201, the staff or resource row.
Errors: 404 location not found.

#### `POST /api/businesses/:businessId/appointments`
Permission: `appointments.create`
Query/Body: `resourceId`, `contactId` (customer), `skuId` (a service), `startsAt`, `endsAt` (ISO date-times, at most 24 hours apart). Salons ignore `endsAt` and accept `requestKey` and the salon fields. At a clinic, a doctor on leave that day is never booked, and a doctor with OPD sessions set is booked only within them (`PUT …/clinic/doctors/:resourceId`).
Returns: 201, the appointment (`status='booked'`).
Errors: 400 invalid times; 403 a resource at another location for a person tied to one; 404 resource, customer or service not found; 409 `{ reason: "doctor_unavailable" }` (the doctor is on leave that day, or sees patients at other times); 409 the staff member already has an appointment at that time.

#### `PATCH /api/businesses/:businessId/appointments/:id`
Permission: `appointments.edit` or `appointments.cancel`. `cancelled` needs `appointments.cancel`; the other statuses need `appointments.edit`.
Query/Body: `status` (`completed`/`cancelled`/`no_show`), `requestKey` (salon)
Returns: the updated appointment. For a salon, the result also has `fee`.
Errors: 403 an appointment at another location for a person tied to one; 409 the appointment is not booked or does not exist; 409 a no-show before its start time, or done on a day before its own (cancel or move it instead).

## Shared receivables and Wholesale

These routes are mounted inside the Business Admin router (`businessTrade.routes.js`), with the same membership, module, permission and DB-error rules. Receivables routes need the Collections & outstanding module (`receivables`). Wholesale routes need Sales orders & dispatch (`sales_orders`). Trade lists also accept several values in one filter, comma-separated (for example `status=open,part_dispatched`, up to 10 values). The purchase orders registered from the same file are under [Purchase orders to suppliers](#purchase-orders-to-suppliers).

### Paged lists (trade)

| Endpoint | Permission | Filters | Date range on |
|---|---|---|---|
| `GET /api/businesses/:businessId/collections` | `receivables.view` | `contact`, `method`, `location`, `salesperson`, `route`, `cheque` (cheque status), `settled` (`true`/`false`) | `created_at` |
| `GET /api/businesses/:businessId/cheques` | `receivables.view` | `status` (`received`/`deposited`/`cleared`/`bounced`), `contact`, `due` (`true` = in hand and dated today or earlier), `post_dated` (`true`) | `created_at` |
| `GET /api/businesses/:businessId/settlements` | `receivables.view` | `salesperson` | `created_at` |
| `GET /api/businesses/:businessId/price-groups` | `wholesale.view` | `active` | none |
| `GET /api/businesses/:businessId/group-prices` | `wholesale.view` | `group`, `sku`, `state` (`current`/`upcoming`/`ended`) | none |
| `GET /api/businesses/:businessId/schemes` | `wholesale.view` | `state` (`current`/`upcoming`/`ended`/`off`), `sku`, `group` | none |
| `GET /api/businesses/:businessId/delivery-runs` | `sales_orders.view` | `route`, `location` | `created_at` |
| `GET /api/businesses/:businessId/dispatches` | `sales_orders.view` | `delivery` (`out_for_delivery`/`delivered`/`part_returned`/`refused`), `run`, `route`, `contact` | `created_at` |
| `GET /api/businesses/:businessId/claims` | `purchasing.view` | `status` (`open`/`submitted`/`settled`/`rejected`), `supplier`, `kind` | `created_at` |
| `GET /api/businesses/:businessId/salespeople` | `sales_orders.view` | `active`, `user` | none |
| `GET /api/businesses/:businessId/routes` | `sales_orders.view` | `active` | none |
| `GET /api/businesses/:businessId/beats` | `sales_orders.view` | `route`, `salesperson`, `active` | none |
| `GET /api/businesses/:businessId/customer-beats` | `sales_orders.view` | `beat`, `route`, `salesperson`, `trade` (`trade`/`walk_in`), `group`, `today` (`true` = on today's beat) | none |
| `GET /api/businesses/:businessId/sales-orders` | `sales_orders.view` | `status` (`open`/`part_dispatched`/`dispatched`/`closed`/`cancelled`), `contact`, `salesperson`, `route`, `location`, `beat` | `created_at` |
| `GET /api/businesses/:businessId/back-orders` | `sales_orders.view` | `route`, `salesperson`, `contact`, `sku`, `order`, `ready` (`true` = stock covers the line) | none |

Collections rows add `allocated` (to bills), `opening_applied` (against the customer's opening balance), `unallocated` (the true advance; 0 for a bounced cheque), `cheque_date, bank, cheque_status, bounce_charge, salesperson_id, salesperson_name, route_id, route_name, settlement_id, settled, location_name, created_by_name`. Salespeople add `user_name, user_email, customer_count, invoiced_this_month, collected_this_month`; customer-beats add `trade_type, price_group_id, price_group_name, state_code, contact_person, hold_exempt, beat_today, balance` (walk-ins sort last); sales orders add `hold_released, edited, out_for_delivery`; back-orders add `can_go_now, pack_unit, pack_factor, sku_code, free_of_line_id`. Sales orders add `line_count, pending_value, dispatch_count, invoiced`. Back-orders are open order lines with `remaining, remaining_value, available` (usable stock at the order's location). Customer-beats lists every active customer with their beat, route and salesperson, or nulls when they have none.

### Collections and receivables

#### `POST /api/businesses/:businessId/collections`
Permission: `receivables.create`
Query/Body: `requestKey`, `locationId`, `contactId` (customer), `amount` (at least 0.01), `method` (`cash`/`upi`/`bank`/`cheque`/`card`; `cheque` needs a `reference`), `reference`, `notes`, `allocations?` (an array of up to 200 `{ documentId, amount }` entries; leave it out to settle the oldest due bills first, or send `[]` to keep the whole amount as an advance), `salespersonId?`, `routeId?` (both need the `sales_orders` module)
A cheque also takes `chequeDate` (its date: up to 180 days ahead for a post-dated cheque, no more than 90 days old; default today) and `bank`; both go with `method: 'cheque'` only.
Returns: 201, `{ ...collection (collection_no, amount, method, ...), allocated, opening_applied, unallocated, cheque_date?, bank?, cheque_status? }`. With automatic allocation, any opening balance not yet covered is reserved before bills are settled; that part is `opening_applied`, and `unallocated` is only the true advance.
Errors: 404 location, customer, bill, salesperson or route not found; 400 when the allocations add up to more than the amount; 403 salesperson or route sent without Sales orders; 409 "Payment exceeds the outstanding amount", the key was reused, or a cash receipt would take the customer's cash that day, or a bill's cash, to ₹2,00,000 (Income-tax Act 2025, section 186).

#### `GET /api/businesses/:businessId/collections/:id`
Permission: `receivables.view`
Query/Body: none
Returns: `{ ...collection, location_name, created_by_name, contact_phone, contact_gstin, contact_address, salesperson_name, route_name, settlement_id, allocations[{ id, amount, document_id, document_no, total, bill_at }], allocated, opening_applied, unallocated, cheque (null or the cheque row with who deposited / cleared / bounced it and the reversed settlements), seller }`
Errors: 404 not found.

#### `POST /api/businesses/:businessId/collections/:id/cheque`
Permission: `receivables.create` for `deposit` and `clear`; `receivables.approve` for `bounce`
Query/Body: `action` (`deposit`/`clear`/`bounce`), `depositedInto?` (deposit), `reason` (bounce, required), `charge?` (bounce: the bank's charge put on the customer's account; left out, the business's bounce charge, `bounceCharge` in the [wholesale settings](#get-apibusinessesbusinessidwholesale-settings-and-put-apibusinessesbusinessidwholesale-settings), 500.00 until changed; `0` for none)
Returns: the cheque row with `collection_no`, `amount`. A bounce takes back the bill settlements the receipt made (kept in `reversed_allocations`, the activity log and a `collection.reversed` event), the receipt stops counting in every balance, and the charge becomes an open item. When the customer reaches the bounced-cheque limit (`bounceHoldCount` within `bounceHoldDays`), the answer adds `credit_hold { bounces, days, limit }`, and `customer.credit_hold_bounces` (audit) and `customer.credit_hold` (event) are written.
Errors: 404 not a cheque on file; 409 already cleared or bounced, a post-dated cheque before its date, or deposited twice.

#### `GET /api/businesses/:businessId/outstanding`
Permission: `receivables.view`. The `route` filter also needs `sales_orders.view`.
Query/Body: `limit`, `offset`, `q` (name, phone or GSTIN), `show` (`owing` default, `overdue`, `advance`, `all`), `sort` (`outstanding` default, `overdue`, `name`), `route` (route id)
Returns: `data = { total, totals: { balance, outstanding, days_0_30, days_31_60, days_61_90, days_over_90, overdue, uncleared_cheques, post_dated_cheques }, items[] }`. Each item is `{ contact_id, name, phone, gstin, credit_limit, credit_days, balance, outstanding, the four age buckets, overdue, most_days_overdue, open_bills, oldest_bill, last_collection_at, uncleared_cheques, post_dated_cheques, bounced_cheques, last_reminder_at, promised_on }`. Customer credit is applied to the oldest items first; a bounced cheque does not count, and its bank charge is an open item. `sort` also takes `promised`. The four age buckets keep their names, but their edges are the business's credit age groups (`ageingDays` in Business settings › Rules; 30, 60 and 90 days until changed).

#### `GET /api/businesses/:businessId/receivables/customers/:id`
Permission: `receivables.view`
Query/Body: none
Returns: `{ contact, summary (one ageing row), items[] (open items: document_id, reference, bill_date, due_on, amount, open_amount, age_days, overdue, days_overdue), advances[] (live collections with an unallocated part), cheques[] (in hand, deposited, or bounced in the last 180 days), reminders[] (the last 10 follow-ups) }`
Errors: 404 customer not found.

#### `GET /api/businesses/:businessId/receivables/customers/:id/open-bills`
Permission: `receivables.view`
Query/Body: none
Returns: `data = [{ id, document_no, created_at, due_on, total, outstanding }]`: this customer's sales that still have something to collect, oldest due first.

#### `GET /api/businesses/:businessId/receivables/customers/:id/statement`
Permission: `receivables.view`
Query/Body: `from`, `to` (required dates)
Returns: `{ contact, from, to, opening, debit, credit, closing, entries[{ day, at, kind (opening/sale/return/payment/collection/refund/bounce/bounce_charge), reference, debit, credit, document_id, balance }], seller }`. A payment that came from a collection is shown once, as the collection; a bounced cheque shows the receipt, then on the day it bounced the cheque returned (and any bank charge) as debits.
Errors: 400 invalid dates, or more than 5,000 entries; 404 customer not found.

#### `POST /api/businesses/:businessId/receivables/customers/:id/follow-ups`
Permission: `receivables.create`
Query/Body: `channel` (`call`/`whatsapp`/`sms`/`visit`/`other`), `promisedOn?` (today or later), `promisedAmount?`, `note?`
Returns: 201, the reminder (the same book as Udhaar: `retail_credit_reminders`).

#### `POST /api/businesses/:businessId/receivables/customers/:id/apply-advance`
Permission: `receivables.create`
Query/Body: `requestKey`
Returns: 201, `{ applied, payments }`. The customer's unallocated collections, oldest first, settle their open bills, oldest due first. The part that covers the opening balance is kept. Repeating the key returns `{ applied: '0.00', repeated: true }`.
Errors: 404 customer not found; 409 "There is no advance to apply, or no open bill to apply it to".

#### `GET /api/businesses/:businessId/settlements/preview`
Permission: `receivables.view`
Query/Body: `salesperson` (required), `day` (default today)
Returns: `{ salesperson, day, receipts[] (theirs that day, not settled, not bounced), earlier[] (settlements already made that day), totals { receipts, cash, upi, cheques, cheque_count, other } }`

#### `POST /api/businesses/:businessId/settlements`
Permission: `receivables.approve`
Query/Body: `requestKey`, `salespersonId`, `day`, `cashHanded`, `notes` (required when the cash does not tally)
Returns: 201, the settlement (`difference` = handed less cash collected; below zero is short). Every receipt of theirs that day not settled yet is settled; a receipt is settled once. Settlements are never changed.
Errors: 400 a shortage or excess without a note, or a future day; 409 nothing to settle, or the key was reused.

### Salespeople, routes, beats

#### `POST /api/businesses/:businessId/salespeople`
Permission: `sales_orders.edit`
Query/Body: `name` (required), `phone`, `userId` (a member of the business), `monthlyTarget`
Returns: 201, the salesperson.

#### `PATCH /api/businesses/:businessId/salespeople/:id`
Permission: `sales_orders.edit`
Query/Body: `name`, `phone`, `userId`, `monthlyTarget`, `active` (default true)
Returns: the updated salesperson.
Errors: 404 not found.

#### `GET /api/businesses/:businessId/salesperson-logins`
Permission: `sales_orders.edit`
Query/Body: none
Returns: the members who can be linked to a salesperson.

#### `GET /api/businesses/:businessId/salespeople/:id/beat-sheet`
Permission: `sales_orders.view` (the money columns need `receivables.view`)
Query/Body: `day` (1-7, Monday = 1)
Returns: `{ salesperson, weekday, shops[{ contact_id, name, phone, address, beat_name, route_name, balance?, overdue?, most_days_overdue?, oldest_bill?, promised_on?, last_order_at, last_order_total, open_orders }] }`.

#### `POST /api/businesses/:businessId/routes`
Permission: `sales_orders.edit`
Query/Body: `name` (required), `locationId` (optional, must be an active location)
Returns: 201, the route.
Errors: 404 location not found.

#### `PATCH /api/businesses/:businessId/routes/:id`
Permission: `sales_orders.edit`
Query/Body: `name`, `locationId`, `active`
Returns: the updated route.
Errors: 404 route or location not found.

#### `POST /api/businesses/:businessId/beats`
Permission: `sales_orders.edit`
Query/Body: `routeId` (active route, required), `name` (required), `visitDay` (1-7, Monday = 1), `salespersonId`
Returns: 201, the beat.
Errors: 404 route or salesperson not found.

#### `PATCH /api/businesses/:businessId/beats/:id`
Permission: `sales_orders.edit`
Query/Body: `routeId`, `name`, `visitDay`, `salespersonId`, `active`
Returns: the updated beat.
Errors: 404 beat, route or salesperson not found.

#### `PUT /api/businesses/:businessId/customer-beats/:id`
Permission: `sales_orders.edit` (`:id` is the customer contact)
Query/Body: `beatId` (an active beat; null or blank takes the customer off their beat)
Returns: the customer-beat row, or `{ contact_id, beat_id: null }`.
Errors: 404 customer or beat not found.

### Sales orders and dispatch

#### `POST /api/businesses/:businessId/sales-orders`
Permission: `sales_orders.create`
Query/Body: `requestKey`, `locationId`, `contactId` (customer), `lines[1..100]` of `{ skuId (goods only), quantity, unit?, discountPercent?, freeQuantity? }`, `expectedOn`, `notes`, `beatId`/`routeId`/`salespersonId` (default to the customer's beat), `release?` (see [Credit hold](#credit-hold))
Returns: 201, the order (`order_no`, `status='open'`, `subtotal`, `tax`, `total`). Prices are fixed when the order is placed, in the order given under [Price groups and schemes](#price-groups-and-schemes).
Errors: 404 location, customer, item, beat, route or salesperson not found; 400 the beat is on another route, or a line is a service; 409 credit limit exceeded (owed + ordered and not yet sent + this order); 409 `credit_hold`; 409 the key was reused.

#### Credit hold
`POST …/sales-orders` and `PATCH …/sales-orders/:id` refuse an order for a customer on hold who is not marked never-hold (`holdExempt`): 409 with `data = { reason: "credit_hold", holdReason, overdue, days, limitDays, oldestDue, bounces, bounceDays }`. `holdReason` is `overdue` (the wholesale settings hold orders after `holdOverdueDays` and the customer has an open bill more than that many days past its due date) or `bounced_cheques` (`bounceHoldCount` cheques bounced within `bounceHoldDays`; the hold lifts by itself once the oldest of them is out of that window). Send the order again with `release: { reason }` if you hold `receivables.approve`, or `release: { reason, approverId, pin }` with the PIN of a member who does (their own PIN from My profile; five wrong tries lock it). The release is kept in `wholesale_hold_releases` and the activity log under the approver. Release errors (in `data.reason`): 400 `not_an_approver` (not a member) and `wrong_pin`, 403 `not_an_approver` (cannot release), 409 `no_pin`, 423 `pin_locked`.

#### `GET /api/businesses/:businessId/hold-releasers`
Permission: `sales_orders.create`
Query/Body: none
Returns: the members who may release a hold, `[{ id, name, has_pin }]`.

#### `PATCH /api/businesses/:businessId/sales-orders/:id`
Permission: `sales_orders.create`
Query/Body: `requestKey`, `reason` (required), `lines[]` of `{ orderLineId, quantity (still to send), unit?, discountPercent?, freeQuantity? }` for lines kept or changed and `{ skuId, quantity, unit?, discountPercent?, freeQuantity? }` for new lines, `expectedOn?`, `notes?`, `release?`
Returns: the order, re-valued. A line left out has its unsent part taken off; a changed one is taken off and added again at today's price (scheme, credit limit and credit hold checked again); what was sent never changes. Recorded in `wholesale_order_edits`.
Errors: 409 the order is not open, nothing changed, or nothing would be left (cancel or close it instead); 409 credit limit or `credit_hold`.

#### `GET /api/businesses/:businessId/sales-orders/:id`
Permission: `sales_orders.view`
Query/Body: none
Returns: `{ ...order, location_name, salesperson_name, route_name, beat_name, contact_phone, contact_gstin, credit_limit, created_by_name, lines[] (each with remaining, remaining_value, available), dispatches[] (each with document_no, total, invoiced_at, lines[]), tax_notices[] }`. While the order is still to send, `tax_notices[{ startsOn, from, to, toName, items[] }]` names the GST rate changes still to come that move an item it has left to send (each item from the rate it has the day before): it is invoiced at the rate of each invoice's day.
Errors: 404 not found.

#### `GET /api/businesses/:businessId/sales-orders/customer-summary/:id`
Permission: `sales_orders.view` (the account part needs `receivables.view`)
Query/Body: none
Returns: `{ contact, last_order (with its lines, to repeat it), hold { held, reason (overdue/bounced_cheques), exempt, days, overdue, limitDays, oldestDue, bounces, bounceLimit, bounceDays }, account (one ageing row or null) }`

#### `POST /api/businesses/:businessId/sales-orders/:id/dispatch`
Permission: `sales_orders.approve`
Query/Body: `requestKey`, `lines[1..100]` of `{ orderLineId, quantity, unit? (the line's ordered pack or stock unit), lots?: [{ lotId, quantity }] }`, `vehicleNo`, `notes`, and the transport: `driverName`, `helperName`, `transporterName`, `transporterId` (15 characters), `lrNo`, `ewayBillNo` (12 digits), `ewayBillDate`, `distanceKm`
Returns: 201, `{ dispatch, document, status }`. Each dispatch posts a tax invoice (a core sale) at the order's prices, and takes a `challan_no` from the dispatching location's `delivery_challan` series (per financial year). Batches are picked oldest expiry first unless `lots` names them. The order status becomes `part_dispatched` or `dispatched`.
Errors: 404 order or line not found; 409 the order is already dispatched, closed or cancelled, the quantity is more than is left on the order, there is not enough usable stock (dispatch less and leave a back-order), a chosen batch is not usable, or the credit limit would be exceeded; 400 the chosen batches do not add up to the quantity.

#### `POST /api/businesses/:businessId/sales-orders/:id/lines/:lineId/close`
Permission: `sales_orders.cancel`
Query/Body: `reason`
Returns: the order (closed or cancelled when nothing is left). Drops what is left of one line and its free goods.

#### `POST /api/businesses/:businessId/sales-orders/:id/close`
Permission: `sales_orders.cancel`
Query/Body: `reason` (required)
Returns: the order with `status='cancelled'` (nothing was sent) or `'closed'` (part was sent and the back-order is dropped).
Errors: 404 not found; 409 not open or part dispatched.

#### Dispatch board, delivery runs and delivery
- `GET /dispatch-board` (`sales_orders.view`): orders still to dispatch with `lines, lines_ready, lines_none, pending_value`; filters `route`, `day` (beat weekday 1–7), `wantedBy`, `location`.
- `GET /pick-list?orders=1,2,3` (`sales_orders.view`): `{ location, orders, items[{ sku_id, code, label, unit, wanted, available, short, pack_unit, pack_factor, take[{ lot_code, expires_on, quantity }], order_nos }] }` (batches earliest expiry first). 409 when the orders are not waiting or go out from different godowns.
- `POST /delivery-runs` (`sales_orders.approve`) `{ requestKey, orderIds[1..60], vehicleNo?, driverName?, driverPhone?, helperName?, routeId?, transporterName?, transporterId?, lrNo?, notes? }`: each order sends what is in stock now (whole packs for lines ordered in packs) on its own invoice; an order with nothing in stock, or refused by the core (credit limit), is skipped. Returns 201 the run with `invoices[]`, `items[]`, `sent[]`, `skipped[{ orderNo, reason }]`.
- `GET /delivery-runs/:id` (`sales_orders.view`): the load sheet (`items` loaded, `invoices` with `to_collect`).
- `PATCH /dispatches/:id/transport` (`sales_orders.approve`): the transport and e-way bill fields of the dispatch, later. The e-way bill number is typed in by hand.
- `POST /dispatches/:id/delivery` (`sales_orders.approve`; returns also need `sales.refund`) `{ status: delivered | part_returned | refused, receivedBy?, note (required for returns), requestKey (returns), returns?: [{ documentLineId, quantity }] }`: goods that came back are a sales return with restock; the order does not reopen. 409 when already marked.
- `POST /dispatches/:id/challan` (`sales_orders.view`): what the A4 delivery challan prints, issuing the dispatch's challan number first when it has none (audit `dispatch.challan_issued`): the dispatch with its transport (`transporter_name, transporter_id, vehicle_no, lr_no, eway_bill_no, eway_bill_date, driver_name`), `order_no, document_no, location_name`, the consignee (`contact_*`, `contact_state`, `contact_pin`), `lines[{ label, unit, quantity, entered_unit, entered_quantity, unit_factor, lot_code, expires_on, hsn_code, net, tax, free, scheme_name }]` and `seller`.
- The `dispatches` list rows carry `challan_no`, and its search covers challan and LR numbers.
- `GET …/documents/:id` of a dispatched sale adds `wholesale { order_no, salesperson_name, route_name, vehicle_no, driver_name, transporter_*, lr_no, eway_bill_no, eway_bill_date, distance_km, delivery_status, lines[{ document_line_id, discount_percent, list_unit_price, free, scheme_name }] }`, which the shared tax invoice prints.

#### `GET /api/businesses/:businessId/wholesale-summary`
Permission: `sales_orders.view` (money figures need `receivables.view`)
Query/Body: none
Returns: `{ orders_to_dispatch { count, value, due_today }, back_orders { lines, value }, out_for_delivery { count, value }, beats_today[], collected_today[{ name, receipts, amount, cash }], cheques { to_deposit, to_deposit_value, post_dated, post_dated_value, in_clearing, bounced_30_days }, overdue { amount, customers, over_90 }, unsettled_today[], hold_overdue_days }`

#### `GET /api/businesses/:businessId/wholesale-settings` and `PUT /api/businesses/:businessId/wholesale-settings`
Permission: `sales_orders.view` (GET) / `settings.edit` (PUT)
Query/Body (PUT): `holdOverdueDays` (1–365, or null for no hold), `bounceCharge` (the bank charge put on a customer for a bounced cheque), `bounceHoldCount` (null = never hold for bounces) and `bounceHoldDays` (7–365). A field left out keeps what is saved.
Returns: the saved row, or the defaults (`hold_overdue_days: null`, `bounce_charge: "500.00"`, `bounce_hold_count: 2`, `bounce_hold_days: 90`) when nothing is saved yet.

#### `GET /api/businesses/:businessId/wholesale-customers/:id` and `PUT /api/businesses/:businessId/wholesale-customers/:id`
Permission: `contacts.view` / `contacts.edit` (`beatId` needs `sales_orders.edit`; `holdExempt`, on or off, needs `receivables.approve`)
Query/Body (PUT): `priceGroupId?`, `contactPerson?`, `stateCode?` (two-digit GST state code), `pinCode?`, `pan?`, `fssai?`, `tradeType` (`trade`/`walk_in`), `holdExempt`, `beatId?` (null takes them off their beat)
Returns: the trade details `{ contact_id, price_group_id, price_group_name, contact_person, state_code, pin_code, pan, fssai, trade_type, hold_exempt, ..., beat }` (defaults when nothing is saved yet; `beat` is `{ beat_id, beat_name, route_id, route_name, salesperson_id, salesperson_name, visit_day }` or null). A dispatch to a customer without a GSTIN takes their state as the place of supply.
Errors: 404 customer not found.

### Price groups and schemes

Changing them needs `wholesale.edit`; the lists (`price-groups`, `group-prices`, `schemes`) are under [Paged lists (trade)](#paged-lists-trade).

- `POST /price-groups` `{ name, notes? }`; `PATCH /price-groups/:id` `{ name, notes?, active }`.
- `POST /group-prices` `{ groupId, skuId, unitCode?, minimumQuantity?, unitPrice, validFrom? (today or later), validTo? }`: a price running for the same line ends the day before; one starting on or after that date is refused (409).
- `POST /group-prices/:id/end` `{ validTo? }`: ends it (an upcoming price is withdrawn: `withdrawn: true`).
- `POST /group-prices/revise` `{ groupId?, skuIds?, percent (-90..500), validFrom? }`: every price running on that date moves by the percentage from it. Returns `{ revised, from, percent }`.
- `POST /schemes` `{ name, skuId, unitCode?, buyQuantity, freeQuantity?, discountPercent?, freeSkuId?, freeUnitCode?, noSlab?, groupId?, validFrom?, validTo? }`: `freeSkuId` gives another item free ("buy 5 cases of A, get 1 of B"), in its pack `freeUnitCode`; `noSlab` (boolean) keeps the scheme from combining with slab prices. `PATCH /schemes/:id` `{ active?, validTo? }` (the terms of a used scheme never change). The schemes list adds `free_label` and `free_stock_unit`, and the filter `free_sku`.

Pricing of an order line: the customer's own price, then their group's price (dated), then a slab for everyone, then the list price. The scheme is found first: with `noSlab`, a slab for all customers gives way to the list price, and only a group's base price (minimum 1) is used. The scheme's discount plus a line `discountPercent` (needs `sales.discount` or `wholesale.edit`) then come off. Free goods (the scheme's, plus `freeQuantity`) become a separate line at no charge (`free_of_line_id`); free goods of another item carry `scheme_id`, `net = 0` and `list_unit_price` = that item's list price.

### Claims on suppliers

`POST /claims` (`purchasing.edit`) `{ supplierId, kind (scheme/damage/expiry/rate_difference/shortage/other), amount, documentId? (a purchase from that supplier), periodFrom?, periodTo?, notes? }`; `PATCH /claims/:id` (`purchasing.edit`) `{ status: submitted | settled | rejected, settledAmount + creditNoteNo (settled), notes? }`. A claim moves open → submitted → settled or rejected. The list is `GET …/claims` under [Paged lists (trade)](#paged-lists-trade).

### Wholesale reports

#### `GET /api/businesses/:businessId/wholesale-reports`
Permission: `reports.view`. Also `sales.view` for `customer`, `salesperson` and `route`; `receivables.view` for `collections` and `outstanding`; and `sales_orders.view` for `salesperson`, `route` and `outstanding`.
Query/Body: `group` (`customer`/`salesperson`/`route`/`collections`/`outstanding`, required), `from` and `to` (required except for `outstanding`; up to 367 days), `by` (`route` default, or `salesperson`; `outstanding` only)
Returns: `customer`/`salesperson`/`route`: `{ group, from, to, rows[{ id, name, invoices, invoiced, returned, net_sales, orders, ordered }] }`. `collections`: `{ group, from, to, rows[{ day, method, salesperson, route, receipts, amount, applied }], paidOnBills: { payments, amount } }`. `outstanding`: `{ group, by, rows[{ id, name, customers, balance, the age buckets, overdue }] }`.
Errors: 400 missing or invalid group or dates.

#### `GET /api/businesses/:businessId/wholesale-scheme-report`
Permission: `reports.view` and `sales_orders.view`
Query/Body: `from`, `to` (up to 367 days), `contact?`, `scheme?`
Returns: `{ from, to, rows[{ contact_id, contact_name, scheme_id, scheme_name, item, unit, free_item, free_unit, pack, free_pack, orders, ordered, bought, free_ordered, free_sent, free_value, discount_value }], totals { orders, free_value, discount_value, retailers } }` for orders taken in the period (not cancelled).

## Retail (counter, udhaar, offers, loyalty, books)

These routes are added to the Business Admin router by `businessRetail.routes.js`, with the same checks. Retail paged lists use the core list contract. A list's extra module check (`weight` for scale items, `books` for books) returns 403 when that module is off.

### Counter, barcodes and scale codes

#### `POST /api/businesses/:businessId/retail/quote`
Permission: `sales.create`
Query/Body: the same body as a sale on [POST …/documents](#post-apibusinessesbusinessiddocuments) (`locationId`, `contactId`, `lines[1..100]`, `loyalty.redeemPoints`, `coupon`, `discount`, ...). `kind` is forced to `sale`, and payment and `requestKey` are ignored.
Returns: `data = { taxMode, contactId, lines[{ skuId, label, unit, quantity, unitPrice, priceKind, enteredUnit, enteredQuantity, amount, discount, net, tax, taxRate, lotCode, offers[] }], subtotal, tax, roundOff, total, savings, loyalty, coupon }`. `priceKind` says which price the line sold at: `list`, `branch` (the location's own), `member` or `rule` (a customer or slab price). `loyalty` is `{ balance, earns, redeemed, redeemedValue, pointValue, minRedeem, maxRedeem }` or null. `coupon` is `{ code, name, applied }` when a coupon was given (`applied` false when another offer was better), else null. The bill is worked out exactly as posting would work it out, and nothing is saved.
Errors: the same validation as posting (404 item, location or contact; 409 points or redeem limits; the coupon and counter-discount errors). The stock check is skipped.

#### `GET /api/businesses/:businessId/retail/scan`
Permission: `sales.create` or `catalog.view`
Query/Body: `code` (required, up to 80 chars; spaces removed), `locationId`
Returns: `data = { sku, quantity, source, lots[], serial }`. The code is matched, in this order, against:
- an item's barcode or SKU code (`source: "barcode"`);
- a book's ISBN (`isbn`; `books` module);
- a weighing-scale label `21PPPPPWWWWWC` (`scale`; `weight` module): `quantity` is the weight in the item's unit;
- a serial number, or either IMEI of a phone, of a unit in stock (`serial`; `serials` module): that very unit is billed, so `serial` names it and `lots` holds only it;
- an active school set's code (`set`; `books` module): the answer is then `{ source: "set", set: { id, name, code, items[{ skuId, quantity, label, barcode, code }] }, sku: null }`, and the counter adds the whole booklist.

`lots` lists the usable batches, earliest expiry first, for batch or serial items only. A kit answers `kit: { components[] (with lots for serial / batch parts) }`.
Errors: 404 no item has the code ("No item has this barcode, code, ISBN or serial number"), or no item has the scale code; 400 a scale label with a bad check digit or no weight; 409 the unit is in stock at another location (transfer it first), or was already sold (the bill, customer and date are named); 409 a set with an item switched off.

#### `POST /api/businesses/:businessId/retail/barcodes`
Permission: `catalog.edit`
Query/Body: `skuIds` (1-500 item ids)
Returns: `data = { assigned[{ id, label, barcode }], alreadyHad }`. Items without a barcode get an in-store EAN-13 (`200` + the item id padded to 9 digits + a check digit).
Errors: 404 an item was not found; 409 the item id is too long for an in-store barcode.

#### `GET /api/businesses/:businessId/retail/scale-items`
Permission: `catalog.view`, plus the `weight` module (403 when it is off)
Query/Body: the paged-list contract; no filters; `q` searches label, code and PLU
Returns: `{ total, items[{ id (= sku_id), sku_id, plu_code, created_at, label, code, unit, price, active }] }`, ordered by PLU.

#### `PUT /api/businesses/:businessId/retail/scale-items/:skuId`
Permission: `catalog.edit`, plus the `weight` module
Query/Body: `pluCode` (1-99999; stored zero-padded to 5 digits)
Returns: the scale-item row (an upsert per item).
Errors: 403 weight module off; 400 invalid code; 404 item not found; 409 the PLU is already used by another item.

#### `DELETE /api/businesses/:businessId/retail/scale-items/:skuId`
Permission: `catalog.edit`, plus the `weight` module
Query/Body: none
Returns: the removed row.
Errors: 404 "This item has no scale code".

### Retail reports

All four take an optional `location` (location id). Sales are net of returns and before GST. Cost comes from the stock cost recorded on each sold line.

#### `GET /api/businesses/:businessId/retail/reports/top-sellers`
Permission: `reports.view` and `sales.view`
Query/Body: `from`, `to` (required, up to a year), `location`
Returns: `{ from, to, rows[{ sku_id, label, code, unit, category, quantity, net, cost, margin, bills, cost_missing }] }`. At most 500 rows, highest net sales first.

#### `GET /api/businesses/:businessId/retail/reports/slow-movers`
Permission: `reports.view` and `inventory.view`
Query/Body: `days` (7-365, default 30), `location`
Returns: `{ days, rows[{ sku_id, label, code, unit, category, on_hand, value, sold, last_sold_at, days_since_sale, cover_days }] }`. At most 500 items with stock, slowest first.
Errors: 400 days out of range.

#### `GET /api/businesses/:businessId/retail/reports/category-margin`
Permission: `reports.view` and `sales.view`
Query/Body: `from`, `to` (required, up to a year), `location`
Returns: `{ from, to, rows[{ key, category (full path), items, net, cost, margin, margin_percent, cost_missing }] }`

#### `GET /api/businesses/:businessId/retail/reports/stock-value`
Permission: `reports.view` and `inventory.view`
Query/Body: `location`
Returns: `{ taxMode, rows[{ sku_id, label, code, unit, category, quantity, cost_value, average_cost, price, sale_value (before GST), batches }] }`. At most 1,000 rows, highest cost value first.

### Udhaar (customer credit)

Udhaar is the shared receivables module (`receivables`) seen in shopkeeper terms. Retail adds a reminder book on top of it.

#### `GET /api/businesses/:businessId/udhaar`
Permission: `receivables.view`
Query/Body: the same as `GET /outstanding` (`limit`, `offset`, `q`, `show`, `sort`)
Returns: the outstanding page `{ total, totals, items[] }`. Each item also has `reminded_at, reminded_by, promised_on, reminder_note, reminders, promise_broken, promise_pending`.

#### `GET /api/businesses/:businessId/udhaar/reminders`
Permission: `receivables.view`
Query/Body: `limit`, `offset`, `q`. `show` is forced to `overdue` and `sort` to `overdue`.
Returns: the same shape as `GET /udhaar`, for the customers to remind today.

#### `GET /api/businesses/:businessId/udhaar/reminder-log`
Permission: `receivables.view`
Query/Body: the paged-list contract; filters `contact`, `channel`; date range on `created_at`
Returns: `{ total, items[] }` of reminder rows, each with `contact_name, contact_phone, created_by_name`, newest first.

#### `GET /api/businesses/:businessId/udhaar/:contactId`
Permission: `receivables.view`
Query/Body: none
Returns: the customer account (`contact, summary, items[], advances[]`) plus `reminders[]` (the latest 50).
Errors: 404 customer not found.

#### `GET /api/businesses/:businessId/udhaar/:contactId/statement`
Permission: `receivables.view`
Query/Body: `from`, `to` (required)
Returns: the same statement as `GET /receivables/customers/:id/statement`.
Errors: 400 invalid dates; 404 customer not found.

#### `POST /api/businesses/:businessId/udhaar/:contactId/collections`
Permission: `receivables.create`
Query/Body: the same as `POST /collections` without `contactId` (taken from the path): `requestKey`, `locationId`, `amount`, `method`, `reference`, `notes`, `allocations?`
Returns: 201, `{ ...collection, allocated, unallocated }`.
Errors: the same as `POST /collections`.

#### `POST /api/businesses/:businessId/udhaar/:contactId/reminders`
Permission: `receivables.create`
Query/Body: `channel` (`whatsapp`/`sms`/`call`/`visit`/`other`, required), `note`, `promisedOn` (date, today or later)
Returns: 201, the reminder row. It records the balance at the time of the reminder.
Errors: 404 customer not found; 409 the customer owes nothing; 400 the promised date is in the past.

### Offers

#### `GET /api/businesses/:businessId/offers`
Permission: `offers.view`
Query/Body: the paged-list contract; filters `status` (`running`/`waiting`/`scheduled`/`off`/`ended`), `kind`; `q` also searches the coupon code
Returns: `{ total, items[] }` of offers, each with `sku_label, category_name, status, given, bills`; a fashion markdown (kind `product_percent`) also carries `product_id` and `product_name`. Running offers come first.

#### `GET /api/businesses/:businessId/offers/given`
Permission: `offers.view` and `sales.view`
Query/Body: `from`, `to` (required)
Returns: `{ from, to, rows[{ key, offer_id, label, source (offer/points), bills, given, sold_after }], totals: { bills, sales, bills_with_offers } }`
Errors: 400 invalid dates.

#### `POST /api/businesses/:businessId/offers`
Permission: `offers.create`
Query/Body: `name`, `kind` (`item_percent`, `item_amount`, `category_percent`, `bill_percent`, `bill_amount`, `buy_x_get_y`, or `product_percent`: every size and colour of one fashion style, see [fashion markdowns](#post-apibusinessesbusinessidfashionmarkdowns)), `value` (a percentage up to 100, or an amount), `skuId` (item kinds and buy-X-get-Y), `productId` (product_percent), `categoryId` (category_percent), `buyQuantity`/`getQuantity` (buy-X-get-Y), `minBillAmount`, `maxDiscount`, `startsOn` (required), `endsOn`, `daysOfWeek` (array of 1-7), `startsTime`/`endsTime` (`HH:MM`, both or neither), `active`, `couponCode` (3-20 letters, digits or dashes, stored upper-case: the offer then applies only to a bill that gives the code, `coupon` on the sale), `usageLimit` and `perCustomerLimit` (coupons only: bills in all, and bills per customer)
Returns: 201, the offer.
Errors: 400 validation (a use limit without a coupon code); 404 item or category not found; 409 the coupon code is used by another offer.

#### `PATCH /api/businesses/:businessId/offers/:offerId`
Permission: `offers.edit`
Query/Body: either `{ active }` alone, which switches the offer on or off and keeps everything else, or the full create body
Returns: the updated offer. Bills already posted keep their own discount lines.
Errors: 404 not found; 400 validation.

### Loyalty

#### `GET /api/businesses/:businessId/loyalty/rules`
Permission: `loyalty.view`
Query/Body: none
Returns: the saved rules `{ earn_per_amount, earn_points, point_value, min_redeem_points, max_redeem_percent, active, return_spent_points, ..., saved: true }`. When nothing is saved yet, the defaults (100.00 per 1 point, point value 1.00, minimum redeem 100, at most 50% of a bill, inactive, spent points given back on returns) with `saved: false`.

#### `PUT /api/businesses/:businessId/loyalty/rules`
Permission: `loyalty.edit`
Query/Body: `earnPerAmount` (1-1,000,000), `earnPoints` (whole number, 1-1000), `pointValue` (0.01-1000), `minRedeemPoints` (whole number, 1-1,000,000), `maxRedeemPercent` (1-100), `active` (boolean, required), `returnSpentPoints` (boolean: give back, in proportion, the points spent on a bill when goods on it come back; kept when left out)
Returns: the saved rules with `saved: true`.

#### `GET /api/businesses/:businessId/loyalty/members`
Permission: `loyalty.view`
Query/Body: the paged-list contract; no filters; `q` searches name and phone
Returns: `{ total, items[{ id, name, phone, balance, earned, redeemed, adjusted, last_at, bills }] }`: customers with at least one points entry, highest balance first.

#### `GET /api/businesses/:businessId/loyalty/entries`
Permission: `loyalty.view`
Query/Body: the paged-list contract; filters `contact`, `kind` (`earn`/`redeem`/`adjust`/`reverse`/`restore`); date range on `created_at`
Returns: `{ total, items[] }` of points entries, each with `contact_name, contact_phone, document_no, created_by_name`.

#### `GET /api/businesses/:businessId/loyalty/:contactId`
Permission: `loyalty.view`
Query/Body: none
Returns: `{ contact: { id, name, phone }, balance }`
Errors: 404 customer not found.

#### `POST /api/businesses/:businessId/loyalty/:contactId/adjustments`
Permission: `loyalty.edit`
Query/Body: `points` (a non-zero whole number up to ±1,000,000; negative takes points away), `reason` (required), `requestKey`
Returns: 201, `{ ...entry (kind 'adjust'), balance }`.
Errors: 404 customer not found; 409 the adjustment would take the balance below zero, or the key was reused.

### Book details

These routes need the `books` module. The list returns 403 when it is off, and the write routes return 403 from the service.

#### `GET /api/businesses/:businessId/books`
Permission: `catalog.view`, plus the `books` module
Query/Body: the paged-list contract; filters `details` (`true`/`false`), `category`, `active`; `q` searches label, code, barcode, ISBN, author, publisher and category
Returns: `{ total, items[{ id, code, barcode, label, price, tax_rate, active, unit, product_name, brand, category, category_id, isbn, author, publisher, edition, language, published_year, has_details, stock }] }`. Items are goods SKUs; those with book details come first.

#### `POST /api/businesses/:businessId/books`
Permission: `catalog.create`, plus the `books` module
Query/Body: the catalogue fields (`name`, `label`, `code`, `price`, `taxRateId`, `categoryId`, `unit` (default `each`), `tracking` (default `quantity`), `barcode` (defaults to the ISBN), `brand` (defaults to the publisher), `reorderLevel`), plus `isbn` (ISBN-10 or ISBN-13, stored as ISBN-13), `author`, `publisher`, `edition`, `language`, `publishedYear` (1450-2200)
Returns: 201, the new SKU. The book details are saved in the same transaction.
Errors: 400 invalid ISBN or year; 409 the ISBN is already on another item, or the code is a duplicate.

#### `PUT /api/businesses/:businessId/books/:skuId`
Permission: `catalog.edit`, plus the `books` module
Query/Body: `isbn`, `author`, `publisher`, `edition`, `language`, `publishedYear`
Returns: the `books_titles` row (an upsert). The item's attributes are synced with the ISBN, author and publisher, and the ISBN becomes the item's barcode when it has none or only an in-store `200…` code (the same holds for an item created with an ISBN attribute).
Errors: 404 the item is not found or is not goods; 409 the ISBN is already on another item.

#### `GET /api/businesses/:businessId/books/sets`, `POST /books/sets`, `GET /books/sets/:setId`, `PUT /books/sets/:setId`
Permission: `catalog.view` (list, read), `catalog.create` (POST), `catalog.edit` (PUT); the `books` module (403 when off)
Query/Body: list: the paged-list contract, filter `active`, `q` searches name, code, school and class. POST / PUT: `{ name, code, school?, className?, notes?, active?, items[1..60]{ skuId, quantity } }`. The code is letters, digits and dashes (spaces become dashes, upper-cased).
Returns: the set with `items[{ sku_id, quantity, label, code, barcode, price, unit, active, stock }]` and `total`. The list: `{ total, items[{ …set, item_count, total }] }`. A set's code scanned at the counter adds the whole booklist (`GET …/retail/scan`).
Errors: 400 no items, an item twice, a bad code; 404 an item not of this shop; 409 the code is an item's code or barcode, or another set's code.

#### `GET /api/businesses/:businessId/books/orders`, `POST /books/orders`, `POST /books/orders/:orderId/status`
Permission: `sales.view` (list), `sales.create` (POST; an advance also `receivables.create`), status: `sales.create` (arrived, collected) or `sales.edit` (cancelled); the `books` module
Query/Body: list: paged, `status` (ordered, arrived, collected, cancelled), `from`/`to` on the date taken, `q` searches number, customer, phone, title, author and ISBN. POST: `{ locationId, requestKey, title, author?, isbn?, quantity?, promisedOn?, notes?, phone?, contactId? | customerName, advance?, method? }`. Status: `{ status }`.
Returns: the order row (`order_no` BO-0001…). An advance is posted as a numbered collection kept as the customer's advance (`allocations: []`) in the same transaction, so it comes off their next bill; the list adds `collection_no`, `location_name`, `created_by_name`, `stock`.
Errors: 400 an advance without a customer on file, a bad ISBN; 409 collected before arrived, or a closed order moved. Repeating a request key returns the first order (and no second advance).

## Fashion, electronics, salon and weight-based shops

These routes are part of the Business Admin router (`/api/businesses/:businessId/...`), registered from `backend/src/modules/business/fashion-electronics/routes/businessFashionElectronics.routes.js` and `backend/src/modules/business/salon-weight/routes/businessSalonWeight.routes.js`, and follow the [Business Admin conventions](#business-admin-conventions). The part of a permission code before the dot is the module that must be on: `exchanges.*` needs the Exchanges module, `warranties.*` Warranties, `repairs.*` Repairs & service, and `appointments.*`, `packages.*`, `commissions.*`, `processing.*` and `wastage.*` their own modules. Some routes also need another module, given as "Module:" below; without it they answer 403 with the same "not switched on" sentence. Where a permission is shown as a list, any one of them is enough.

Lists marked "paged list" follow the paged-list contract, with their own filters named below. Money is sent and returned as decimal strings in rupees, and quantities as decimals to 3 places.

### Fashion: size x colour matrix

A fashion product is one `catalog_products` row with one SKU per size x colour (x fabric) variant. Each variant is an ordinary SKU with its own code (`PREFIX-COL-SIZE[-FAB]`), barcode, price and stock. If no barcode is given, the server assigns an in-store EAN-13 starting with "200". Every route needs Module: `variants` ("Variants are not switched on ...", 403). A product can have at most 300 variants.

#### `GET /api/businesses/:businessId/fashion/products`
Permission: `catalog.view`. Module: `variants`.
Query/Body: paged list; `q` searches name, brand and category; filters `category` (category id) and `active`. No date filter.
Returns: `data` = `{ total, items[] }`. Each item is `{ id, name, brand, active, category_id, category, variant_count, sizes[], colors[], min_price, max_price, stock }`.

#### `POST /api/businesses/:businessId/fashion/products`
Permission: `catalog.create`. Module: `variants`; the business also needs the `inventory` capability.
Query/Body: `name` (string, required, up to 120); `sizes` (string[], required, 1-30, each up to 20); `colors` (string[], required, 1-30, each up to 40); `fabrics` (string[], optional, up to 10); `price` (required); `sizePrices` (`{ size: price }`); `barcodes` (`{ "colour|size|fabric": code }`, 4-80 letters, digits or hyphens); `colorCodes` (`{ colour: code }`); `codePrefix` (up to 20); `tracking` (`quantity` | `batch` | `serial`); `unit` (default `each`; must be a goods unit); `taxRateId` or `taxRate`; `categoryId`; `brand`; `reorderLevel`.
Returns: `data` = `{ product, created }`, where `created` is the number of variants made; status 201.
Errors: 400 no sizes or colours, a service or time unit, or batch/serial tracking not enabled; 404 GST slab or category not found; 409 code prefix already used, barcode already on another item, or the same barcode typed twice.

#### `GET /api/businesses/:businessId/fashion/products/:productId`
Permission: `catalog.view`. Module: `variants`.
Query/Body: `locationId` (optional; stock at that location only).
Returns: `data` = `{ product, sizes[], colors[], fabrics[], variants[] }`. Each variant is `{ sku_id, size, color, fabric, code, barcode, label, price, active, unit, tracking, stock, stock_by_location }`.
Errors: 404 product not found.

#### `POST /api/businesses/:businessId/fashion/products/:productId/variants`
Permission: `catalog.create`. Module: `variants`.
Query/Body: `sizes`, `colors`, `fabrics` (at least one non-empty); `price`, which is needed for a new size that has no existing price; `sizePrices`; `barcodes`; `colorCodes`; `codePrefix`. The server creates every missing combination of (old + new sizes) x (old + new colours) x fabrics. A new variant takes the price of its size.
Returns: `data` = `{ product, created }`; status 201.
Errors: 400 nothing to add, no price for a new size, or fabrics added to a product without a fabric axis; 404 product not found; 409 the product has no variants yet, every combination already exists, or a code or barcode clashes.

#### `PUT /api/businesses/:businessId/fashion/products/:productId/prices`
Permission: `catalog.edit`. Module: `variants`.
Query/Body: `price` (required); `sizes` (string[], optional); `colors` (string[], optional). Empty arrays mean all sizes or all colours.
Returns: `data` = `{ updated }`, the number of variants repriced.
Errors: 404 no variants match.

#### `GET /api/businesses/:businessId/fashion/reports/variants`
Permission: `reports.view`. Module: `variants`.
Query/Body: `from` and `to` (required, at most 367 days apart); `productId` and `locationId` (optional).
Returns: `data` = `{ from, to, truncated, items[], bySize[], byColor[] }`. Each item has the sold, returned and net quantity and sales (before GST), `stock_qty`, `stock_value` and `sell_through` (%). The response holds at most 5,000 variants; `truncated` is true when there were more.
Errors: 400 invalid dates or a range over 367 days.

#### `PUT /api/businesses/:businessId/fashion/products/:productId/barcodes`
Permission: `catalog.edit`. Module: `variants`.
Query/Body: `barcodes` (object of variant SKU id to barcode, 4–80 letters, digits or hyphens; at most 300).
Returns: `data` = `{ updated }`. The maker's codes replace the in-store ones; codes can be swapped between variants of the style in one call.
Errors: 400 the same code twice, bad characters; 404 a SKU that is not a variant of this style; 409 the code is on another item.

#### `GET /api/businesses/:businessId/fashion/reports/styles`
Permission: `reports.view`. Module: `variants`.
Query/Body: `from`, `to` (required), `productId`, `locationId`.
Returns: `data` = `{ from, to, styles[], broken[], buckets, ageing[] }`. `styles[]`: per style net pieces, net sales, stock, stock value, sell-through, `sizes[]` (`size, net_qty, stock_qty, share` = % of the style's net pieces), `ages` (`d0_30, d31_60, d61_90, d91_plus` pieces on the shelf by days since they came in, newest receipts first), `oldest_days`, `broken_colors`. `broken[]`: per style and colour, the core sizes (all but the smallest and largest of a run of four or more; the middle of three) at nothing while other sizes of that colour are in stock: `missing[], missing_sku_ids[], in_stock[], stock_qty`. `ageing[]`: per variant SKU.

#### `GET /api/businesses/:businessId/fashion/markdowns`
Permission: `offers.view`. Modules: `variants`, `offers`.
Query/Body: `productId` (optional).
Returns: `data` = markdowns (`retail_offers` of kind `product_percent`) newest first: `id, name, product_id, product_name, value, starts_on, ends_on, active, status (running|scheduled|ended|off), given`.

#### `POST /api/businesses/:businessId/fashion/markdowns`
Permission: `offers.create`. Modules: `variants`, `offers`.
Query/Body: `productIds` (1–100 styles), `percent` (1–90), `endsOn` (required, not past), `startsOn` (default today), `name` (default "End of season").
Returns: `data` = `{ created, offers[] }`, status 201. Every size and colour of each style sells at `percent` off until `endsOn` (inclusive). The shelf price never changes, so the price goes back by itself when the markdown ends. The bill shows the discount like any offer, and GST follows the discounted value.
Errors: 400 bad dates or percent; 404 a style not found; 409 the style already has a markdown over those dates.

#### `POST /api/businesses/:businessId/fashion/markdowns/:offerId/end`
Permission: `offers.edit`.
Query/Body: `{}`
Returns: the offer row; the markdown ends now (the offer is switched off).
Errors: 404 not a markdown of this business.

#### `GET /api/businesses/:businessId/fashion/gst-rule` and `PUT /api/businesses/:businessId/fashion/gst-rule`
Permission: `catalog.view` (GET), `settings.edit` (PUT).
Query/Body (PUT): `active` (boolean), `threshold` (per piece before GST, default 2500), `rateLow` (default 5), `rateHigh` (default 18), `categoryIds` (optional extra categories).
Returns: `data` = the rule (`fashion_gst_price_slabs` row; defaults when none is saved, `active: false`).
Effect: for a garment business, every sale and quote (counter, New sale, exchanges) decides each line's GST rate from the value of one piece after offers and discounts: at or below `threshold` the lower rate, above it the higher rate. With prices including GST the piece is tested at the lower rate (₹2,625 incl. 5 % = ₹2,500 → 5 %). It applies to size × colour variants and the chosen categories, counted in whole pieces.

### Exchanges

An exchange takes goods back and sells replacements in one transaction. It writes a credit note (return) on the original sale and a new sale bill (SI) for the replacements, priced like any sale. The original sale's credit moves to the new bill as a `credit_note` payment. The customer then pays the difference, gets it refunded, keeps it on account, or takes a credit voucher. If any step fails, nothing is saved. By default, exchanges are allowed within 30 days of the sale.

#### `GET /api/businesses/:businessId/exchanges`
Permission: `exchanges.view`.
Query/Body: paged list; `q` searches original_no, new_no, return_no, customer_name and reason; `from`/`to` filter on created_at; filters `location` and `contact`.
Returns: `data` = `{ total, items[] }`. Each item is an exchange row plus `original_no, new_no, return_no, customer_name, location_name, created_by_name, difference, voucher_no`.

#### `GET /api/businesses/:businessId/exchanges/policy`
Permission: `exchanges.view` or `exchanges.create`.
Query/Body: none.
Returns: `data` = `{ daysAllowed, updatedAt }`. `daysAllowed` is 30 when no policy has been saved; `null` means no limit.

#### `PUT /api/businesses/:businessId/exchanges/policy`
Permission: `settings.edit`. When the Exchanges module is off, `exchanges.view` is also checked, so the call fails with 403 "not switched on".
Query/Body: `daysAllowed` (integer 1-365, or `null`/`""` for no limit).
Returns: `data` = `{ daysAllowed, updatedAt }`.

#### `GET /api/businesses/:businessId/exchanges/credits`
Permission: `exchanges.view` or `exchanges.create`.
Query/Body: none.
Returns: `data` = an array of the customers who hold unused exchange credit: `{ contact_id, name, phone, credit, notes[{ collectionNo, reference, free }], owed }`.

#### `POST /api/businesses/:businessId/exchanges/credits/:contactId/use`
Permission: `exchanges.create`; `sales.edit` is also required.
Query/Body: `requestKey` (UUID, required); `documentId` (optional; one named bill instead of all unpaid bills, oldest first).
Returns: `data` = `{ applied, payments }`, or `{ repeated: true }` when the key was already used; status 201. Each use is recorded as a `credit_note` payment linked to the credit's collection.
Errors: 404 customer not found, or the bill is not this customer's sale; 409 no unpaid bill, or no credit left.

#### `GET /api/businesses/:businessId/exchanges/find`
Permission: `exchanges.create`.
Query/Body: `code` (barcode, SKU code or serial / IMEI of the item coming back) or `phone` (6+ digits of the customer's phone).
Returns: `data` = `{ sku, daysAllowed, items[] }`: sales inside the exchange policy (newest first, at most 20) with the matching lines that can still come back (`lineId, skuId, label, lotCode, quantity, returned`).
Errors: 400 nothing to search by.

#### `POST /api/businesses/:businessId/exchanges/quote`
Permission: `exchanges.create`.
Query/Body: the same as create, but `reason` is optional and `settlement` is ignored. The server works out the whole exchange in a transaction and rolls it back.
Returns: `data` = `{ originalNo, returnNo, newNo, returnedValue, newValue, newSubtotal, newTax, newRoundOff, difference, creditAvailable, creditApplied, due, excess, walkIn, daysAllowed, saleAgeDays, newLines[] }`. A positive `difference` means the customer pays.
Errors: the same as create.

#### `POST /api/businesses/:businessId/exchanges`
Permission: `exchanges.create`. Collecting a difference also needs `sales.edit`; refunding money needs `sales.refund`, and so does an exchange with no bill.
Query/Body: `requestKey` (UUID, required); `documentId` (the original sale) and `returnLines` (1-100 of `{ lineId, quantity, restock, faulty? }`), or `noBill: true` with `returnSku: { skuId, quantity, restock }`; `newLines` (1-100 of `{ skuId, quantity, unit?, lotCode? }`, required); `reason` (required, up to 280); `locationId` (optional; defaults to the sale's location); `settlement` (`{ method: cash|card|upi|bank|on_account|voucher, amount?, reference?, name?, phone? }`).
- `noBill` is a gift with no bill: the return goes on the most recent sale of that item, within the policy, that can still take it back. Any credit is then a voucher.
- `faulty: "doa" | "faulty"` on a return line (electronics; Module `serials`): the unit must come back into stock. It is then held for the supplier (see [faulty units](#get-apibusinessesbusinessidelectronicsfaulty)), linked to the replacement unit that went out, and its warranty is cancelled and registered again on the replacement for the same customer.
- `settlement.method: "voucher"` (when the customer is owed money; walk-ins included; no refund permission needed) issues a credit voucher, with `settlement.name` / `settlement.phone` printed on it.

Returns: `data` = the exchange detail (as `GET /exchanges/:exchangeId`) with `no_bill` and `voucher` (`{ id, voucher_no, amount, used, expires_on }` or null); status 201.
Errors: 400 missing reason or lines; amount over what is due; a walk-in paying less than the whole difference; no payment or refund method; `on_account` for a walk-in; cash on an exchange with no bill. 404 sale not found. 409 sale older than the policy allows; no sale of that item within the policy can take it back (no bill); the request key reused with a different body. Return and sale errors from the core posting (quantity over sold, stock) pass through.

#### `GET /api/businesses/:businessId/exchanges/:exchangeId`
Permission: `exchanges.view`.
Query/Body: none.
Returns: `data` = the exchange row plus `original_no, original_at, new_no, return_no, customer_name, customer_phone, location_name, created_by_name, returnedLines[], newLines[]`.
Errors: 404 exchange not found.

#### `GET /api/businesses/:businessId/vouchers`
Permission: `exchanges.view`.
Query/Body: paged list; filter `state` (`open`, `used`, `expired`); `q` searches the voucher number, name, phone and source bill.
Returns: `data` = `{ total, items[] }` of credit vouchers.

#### `GET /api/businesses/:businessId/vouchers/by-number/:code` and `GET /api/businesses/:businessId/vouchers/:voucherId`
Permission: `sales.create` or `exchanges.view` (by number, for the counter); `exchanges.view` (by id, with the shop's details for printing as `seller`).
Query/Body: none.
Returns: the voucher with `balance`, `state` and (by number) its `uses[]`. A voucher can be spent for the business's `voucherValidDays` (Business settings › Rules; 90 until changed); it is spent with `voucher` on [POST …/documents](#post-apibusinessesbusinessiddocuments).
Errors: 404 unknown number ("No credit voucher has that number") or id ("Voucher not found").

### Electronics: models and the serial / IMEI register

A unit's state (in stock, in transit, sold, returned to supplier, written off) is read from the stock ledger, never stored twice. The serial lock rules are enforced by a database trigger, which takes an advisory lock per (business, serial). It refuses a serial lot holding more than one unit; a serial in stock at two locations; an invalid IMEI (15 digits with a Luhn check digit) on first receipt for an IMEI model; and one number under two items. These errors come back as 409 with the trigger's sentence, for example "Serial / IMEI X is already in stock at another location", on stock-moving calls (purchases, transfers, sales, returns). The model, register and history routes below need Module: `serials` ("Serial / IMEI numbers ... is not switched on", 403).

#### `GET /api/businesses/:businessId/electronics/models`
Permission: `catalog.view`. Module: `serials`.
Query/Body: paged list of serial-tracked SKUs; `q` searches label, code, brand and model_number; filter `active`. No date filter.
Returns: `data` = `{ total, items[] }`. Each item is `{ id, sku_id, label, code, active, brand, model_number, serial_kind, warranty_months, warranty_terms, helpline, in_stock }`.

#### `PUT /api/businesses/:businessId/electronics/models/:skuId`
Permission: `catalog.edit`. Module: `serials`.
Query/Body: `serialKind` (`imei` | `serial`, default `serial`); `warrantyMonths` (integer 0-120); `modelNumber` (up to 60); `warrantyTerms` (up to 1000); `helpline` (the brand's helpline, printed on the warranty card; kept when left out).
Returns: `data` = the `electronics_models` row (it is created or replaced).
Errors: 400 the item is not serial-tracked; 404 item not found.

#### `GET /api/businesses/:businessId/serials`
Permission: `inventory.view`. Module: `serials`.
Query/Body: paged list, with one row per unit ever received; `q` searches serial, imei2, label, code, model_number, customer_name, sold_no, received_no and location_name; filters `status` (`in_stock` | `in_transit` | `sold` | `returned_to_supplier` | `written_off` | `out_of_stock`), `sku`, `location`, `age` (`0_30` | `31_60` | `60_plus`) and `faulty`. No date filter.
Returns: `data` = `{ total, items[] }`. Each item is `{ sku_id, serial, imei2, label, code, brand, model_number, serial_kind, status, location_id, location_name, received_at, received_no, supplier_name, sold_no, sold_at, customer_name, customer_id, warranty_id, warranty_ends_on, last_moved_at, unit_cost, days_in_stock, age_bucket, faulty, ... }`. `days_in_stock` counts from the day the unit first came in, and `age_bucket` groups it.

#### `GET /api/businesses/:businessId/serials/history`
Permission: `inventory.view`. Module: `serials`.
Query/Body: `serial` (required; this may also be the second IMEI); `skuId` (optional).
Returns: `data` = `{ unit, others[], movements[], warranties[], repairs[] }`. `movements` covers receipts, transfers, sales, returns, counts and corrections, oldest first. `warranties` is filled only when the Warranties module is on and the role holds `warranties.view`; `repairs` only when the Repairs module is on and the role holds `repairs.view`. `others` lists further units with the same number under other items.
Errors: 404 no unit with this serial / IMEI has been received.

#### `PUT /api/businesses/:businessId/serials/details`
Permission: `inventory.edit`. Module: `serials`.
Query/Body: `skuId` (required); `serial` (required); `imei2` (optional; 15 digits with a valid Luhn check digit, and different from `serial`); `note` (up to 300).
Returns: `data` = the `electronics_serial_details` row (it is created or replaced).
Errors: 400 invalid second IMEI, or the same as the first; 404 unit not received; 409 the second IMEI is already recorded on another unit.

#### `POST /api/businesses/:businessId/electronics/receipts`
Permission: `purchasing.create`. Module: `serials`.
Query/Body: `contactId`, `locationId`, `requestKey` (UUID), `supplierBillNo`, `supplierBillDate` (optional), `notes`, `lines[]` (1–20 models) of `{ skuId, unitPrice, units: [{ serial, imei2? }] }` (at most 200 units).
Returns: `data` = `{ document, units }`, status 201 (a repeat with the same key: `repeated: true`). One purchase receipt, one line per unit; the second IMEI is saved on each unit.
Errors: 400 an invalid IMEI (IMEI models) or second IMEI, or a number scanned twice; 409 a number already received.

#### `GET /api/businesses/:businessId/electronics/faulty`
Permission: `inventory.view`. Module: `serials`.
Query/Body: paged list; filter `status` (`awaiting_supplier`, `sent`, `restocked`, `written_off`).
Returns: `data` = `{ total, items[] }`. Rows carry the model, reason, replacement serial, supplier, purchase and return numbers, claim number and where the unit is.

#### `POST /api/businesses/:businessId/electronics/faulty`
Permission: `inventory.edit`. Module: `serials`.
Query/Body: `skuId`, `serial`, `kind` (`faulty` default | `doa`), `reason`.
Returns: 201, the faulty-unit row (`awaiting_supplier`).
Errors: 409 the unit is not in stock, or is already waiting for the supplier.

#### `POST /api/businesses/:businessId/electronics/faulty/:faultyId/send`
Permission: `purchasing.refund` and `inventory.edit`. Module: `serials`.
Query/Body: `requestKey`, `claimNo`, `note`.
Returns: the row with `status: "sent"` and `return_no`. A purchase return of the unit is posted on the receipt it first came in on (the unit must be at that receipt's location).
Errors: 404 faulty unit not found; 409 the unit is not waiting, not in stock, at another location (move it first), or has no purchase receipt here (write it off instead).

#### `POST /api/businesses/:businessId/electronics/faulty/:faultyId/close`
Permission: `inventory.edit`. Module: `serials`.
Query/Body: `status` (`restocked` | `written_off`), `note` (required), `requestKey`.
Returns: the closed row. Written off takes the unit out of stock as a correction.
Errors: 404 faulty unit not found; 409 the unit is not waiting for the supplier.

While a unit is `awaiting_supplier`, the database refuses a sale line for it (409 "… is marked faulty and waits for the supplier").

### Warranties

A warranty is registered from a sold serial line. Its start defaults to the sale date; its months and terms come from the model; the customer's name, and phone when given (it is optional), come from the sale or the body. Each sold unit can have one live warranty. A warranty cannot be edited or deleted, only cancelled. The Warranties module depends on `serials` and `sales`.

#### `GET /api/businesses/:businessId/warranties`
Permission: `warranties.view`.
Query/Body: paged list; `q` searches serial, imei2, customer_name, customer_phone, item_label and document_no; `from`/`to` filter on created_at; filters `state` (`active` | `expiring` (30 days or fewer left) | `expired` | `not_started` | `returned` | `cancelled`) and `sku`.
Returns: `data` = `{ total, items[] }`. Each item is a warranty row plus `state, document_no, sold_at, sku_code, model_number, imei2, created_by_name, days_left, helpline, line_value`.

#### `GET /api/businesses/:businessId/warranties/lookup`
Permission: `warranties.view`.
Query/Body: `q` (required, 4-100 chars). It matches the IMEI or serial (the second IMEI too), or a phone number (6 or more digits, compared on the last 10).
Returns: `data` = `{ query, warranties[], unregistered[], repairs[] }`. There are at most 50 warranties. `unregistered` (sold units without a warranty, at most 20) is filled only with `warranties.create`; `repairs` (at most 20) only with the Repairs module and `repairs.view`.
Errors: 400 fewer than 4 characters.

#### `GET /api/businesses/:businessId/warranties/eligible`
Permission: `warranties.create`.
Query/Body: `q` (optional; searches bill no, serial, label, customer and phone).
Returns: `data` = up to 50 sold serial lines with no live warranty that are not fully returned: `{ line_id, document_id, sku_id, label, serial, document_no, sold_at, sold_on, contact_id, contact_name, contact_phone, warranty_months, warranty_terms, model_number }`.

#### `POST /api/businesses/:businessId/warranties`
Permission: `warranties.create`.
Query/Body: `requestKey` (UUID, required); `lineId` (the sold line, required); `startsOn` (`YYYY-MM-DD`; defaults to the sale date; it cannot be before the sale or in the future); `months` (1-120; defaults to the model's months); `customerName` (required when the sale has no contact); `customerPhone` (optional: a phone is never a condition; when given, the warranty is found by it); `terms`.
Returns: `data` = the warranty row, with `ends_on` = start + months - 1 day; status 201.
Errors: 400 the line has no serial, the months are not set, a start date is out of range, or the name or phone is missing; 404 sold item not found; 409 the unit was returned, or a warranty is already registered for it.

#### `GET /api/businesses/:businessId/warranties/:warrantyId`
Permission: `warranties.view`.
Query/Body: none.
Returns: `data` = the warranty, shaped like a list item, plus `seller`, the business details for printing the card (display_name, legal_name, gstin, address, phone, email, receipt_footer).
Errors: 404 warranty not found.

#### `POST /api/businesses/:businessId/warranties/:warrantyId/cancel`
Permission: `warranties.cancel`.
Query/Body: `reason` (string, required, up to 300).
Returns: `data` = the cancelled warranty row.
Errors: 400 missing reason; 404 active warranty not found (or already cancelled).

### Repairs

A repair job card is numbered like RJ/2627/0001, from the `repair_job` series at the job's location. Its status moves received -> diagnosing -> waiting_parts -> in_repair -> ready (and back while open). A job whose charges go above the estimate, or one the technician sends for it, waits for the customer's approval (`awaiting_approval`). Delivery then turns the job's lines into a sale bill, and only at that point do parts leave stock. Cancelling closes the job without a bill. A delivered or cancelled job is closed: the job and its lines cannot change (409). If an active warranty covers the job's serial today, the job is marked `under_warranty`, and new lines default to price 0. Every route needs Module: `repairs` (403 when off). The Repairs module depends on `sales` and `inventory`.

#### `GET /api/businesses/:businessId/repairs`
Permission: `repairs.view`.
Query/Body: paged list; `q` searches job_no, customer_name, customer_phone, device, serial, problem and document_no; `from`/`to` filter on created_at; filters `status`, `stage` (`open` | `closed`), `location`, `overdue`, `not_collected` and `advance_to_refund` (`true`).
Returns: `data` = `{ total, items[] }`. Each item is `{ id, job_no, status, status_since, customer_name, customer_phone, device, serial, under_warranty, problem, estimate, promised_on, technician, location_name, document_no, bill_total, line_count, overdue, not_collected, stage, advance, advance_left, advance_to_refund, ... }`. `not_collected` is a job ready for 3 days or more.

#### `GET /api/businesses/:businessId/repairs/counts`
Permission: `repairs.view`.
Query/Body: none.
Returns: `{ open, received, diagnosing, waiting_parts, in_repair, awaiting_approval, ready, overdue, not_collected }`.

#### `POST /api/businesses/:businessId/repairs`
Permission: `repairs.create`; an advance also needs `sales.edit`.
Query/Body: `requestKey` (UUID, required); `locationId` (required); `problem` (required, up to 1000); `contactId` or `customerName`, with `customerPhone` optional (for the ready message; the job card's number finds the job); `skuId` or `device` (one is required); `serial`; `accessories`; `conditionNotes`; `estimate`; `promisedOn` (`YYYY-MM-DD`); `technician`; `passcode` (the screen lock, up to 60; kept only while the job is open); `checklist` (an object of condition ticks such as `screen_cracked`, `water_damage`; at most 20); `advance` (`{ amount, method: cash|card|upi|bank, reference? }`: recorded as a customer collection, a customer record being found by phone or made, and paid onto the bill at delivery); `warrantyOwnerConfirmed` (noted in the history when someone other than the warranty's owner brings the device).
Returns: `data` = the new job row (status `received`); status 201.
Errors: 400 missing problem, name, phone (at least 6 digits) or device; 404 location, customer or model not found; 409 request key reused.

#### `GET /api/businesses/:businessId/repairs/:jobId`
Permission: `repairs.view`.
Query/Body: none.
Returns: `data` = the job plus `location_name, created_by_name, document_no, bill_total, warranty_ends_on, warranty_document_id, status_since, lines[]` (each with `in_stock` at the job's location), `events[]` (status history), `seller`, `lines_total`, `advance` (`collection_no, amount, method, used, refunded, refunds[], free`; `free` is what is left after use and refunds), `claims[]` and `next[]` (the statuses allowed from here, the usual next step first; empty when closed). `passcode` is shown in full only to roles with `repairs.edit`, masked otherwise.
Errors: 404 repair job not found.

#### `PATCH /api/businesses/:businessId/repairs/:jobId`
Permission: `repairs.edit`.
Query/Body: any of `problem`, `accessories`, `conditionNotes`, `estimate` (`null` clears it), `promisedOn` (`null` clears it), `technician`. Fields left out keep their value.
Returns: `data` = the updated job row.
Errors: 404 not found; 409 job closed.

#### `POST /api/businesses/:businessId/repairs/:jobId/status`
Permission: `repairs.edit`.
Query/Body: `status` (required: `received`, `diagnosing`, `waiting_parts`, `in_repair`, `awaiting_approval` or `ready`); `note` (up to 500). The allowed moves, the usual next step first: received -> diagnosing, waiting_parts, in_repair, awaiting_approval or ready; diagnosing -> in_repair, waiting_parts, awaiting_approval or ready; waiting_parts -> in_repair, diagnosing, awaiting_approval or ready; in_repair -> ready, waiting_parts or awaiting_approval; ready -> in_repair. A job awaiting approval moves on only through `…/approval`.
Returns: `data` = the updated job row; the change is added to the history.
Errors: 404 not found; 409 job closed, or the move is not allowed.

#### `POST /api/businesses/:businessId/repairs/:jobId/approval`
Permission: `repairs.edit` (declining also needs `repairs.cancel`).
Query/Body: `decision` (`approved` | `declined`), `note`, `estimate` (approved: the agreed amount; default the charges so far).
Returns: the job. Approved: it goes back to the step it was at (in repair by default). Declined: the job is cancelled ("Customer declined the charges") and nothing is billed.
Errors: 409 the job is not awaiting approval.

#### `POST /api/businesses/:businessId/repairs/:jobId/lines`
Permission: `repairs.edit`.
Query/Body: `kind` (`part` | `labour`, required); `skuId` (required; a part must be a goods item and labour a service item); `quantity` (0.001-1000, default 1; whole for count units; exactly 1 for a serial part); `lotCode` (required for a batch or serial part, and it must have been received); `unitPrice` (defaults to the item price, or 0 under warranty); `label`.
Returns: `data` = the new line row; status 201. A line that takes the charges above the estimate moves an open job to `awaiting_approval`, and the answer has `awaitingApproval: true`.
Errors: 400 wrong item kind, or a fractional quantity; 404 item not found, or the lot was not received; 409 job closed.

#### `DELETE /api/businesses/:businessId/repairs/:jobId/lines/:lineId`
Permission: `repairs.edit`.
Query/Body: none.
Returns: `data` = `{ removed }` (the line id).
Errors: 404 job or line not found; 409 job closed.

#### `POST /api/businesses/:businessId/repairs/:jobId/messages`
Permission: `repairs.view`.
Query/Body: `channel` (`whatsapp` | `call` | `sms`), `stage` (`received`, `parts`, `approval`, `ready`, `delayed`, `reminder`, `update`), `note`.
Returns: status 201. Logs "WhatsApp sent: ready to collect" and the like on the job's history; the message itself is sent from the person's own WhatsApp.

#### `POST /api/businesses/:businessId/repairs/:jobId/deliver`
Permission: `repairs.approve`. When the job has lines, `sales.create` is also needed, plus `sales.edit` when a payment is taken.
Query/Body: `requestKey` (UUID, required; it also becomes the bill's key); `payment` (`{ amount, method: cash|card|upi|bank, reference? }`, optional; at most what is left after the advance); `note`.
Returns: `data` = the job row, now `delivered`, with `document_id` set to the sale bill (null when there was nothing to bill). What is left of the advance is applied to the bill first. Repeating the same key returns the delivered job.
Errors: 400 a payment when nothing was charged; 404 not found; 409 the job is not `ready`, or is closed. A stock error from the bill posting (a part not in stock at the job's location) also stops delivery.

#### `POST /api/businesses/:businessId/repairs/:jobId/cancel`
Permission: `repairs.cancel`.
Query/Body: `reason` (string, required, up to 300).
Returns: `data` = the job row, now `cancelled`; nothing is billed.
Errors: 400 missing reason; 404 not found; 409 already closed.

#### `POST /api/businesses/:businessId/repairs/:jobId/advance-refund`
Permission: `sales.edit`, and a manager's approval from someone with `sales.refund`, always with their PIN (see the approval body under [Salon & spa](#salon--spa)).
Query/Body: `amount?` (default all that is left), `method` (`cash`, `upi` or `bank`, or a `methodId`; default cash; UPI and bank need a `reference`), `reference?`, `reason`, `approverId?`, `pin?`, `requestKey`.
Returns: 201, the refund with `job_no`, numbered after the receipt it comes out of (`<receipt>-R<n>`); noted in the job's history. Only a cancelled or delivered job's advance is handed back. Repeating the key returns the first refund (`repeated: true`).
Errors: 409 the job has no advance, is still open, or has nothing left to hand back; plus the approval errors.

#### `POST /api/businesses/:businessId/repairs/:jobId/claims`, `GET /api/businesses/:businessId/warranty-claims`, `GET /api/businesses/:businessId/warranty-claims/summary` and `PATCH /api/businesses/:businessId/warranty-claims/:claimId`
Permission: `repairs.edit` (raise, update), `repairs.view` (lists). Module: `repairs`.
Raise (a job under warranty only): `brand` (default the model's brand), `supplierId`, `claimNo`, `partCost` (default the stock cost of the parts fitted), `notes`; noted on the job's history; 201.
List: paged; `q` searches brand, claim number, job number, device, serial and customer; filters `status`, `location`; dates on `created_at`. Rows add `job_no, device, serial, customer_name, job_status, location_id, supplier_name, created_by_name`.
Update: `status` (`raised`, `submitted`, `approved`, `rejected`, `credited`), `claimNo`, `notes`, `creditedAmount` (when credited; default the part cost). Credited and rejected claims are closed (409); 404 "Claim not found".
Summary: the open claims (raised, submitted, approved) per brand with the part cost pending, `[{ brand, claims, pending }]`.

### Salon & spa

All `/salon/...` routes check that the business type is `salon`. For any other type they answer 404 "This screen belongs to salon & spa businesses". Bookings use `business_resources` as stylists (kind `staff`) or rooms (kind `room`). A deposit is a receivables collection kept as the client's advance. While its booking is still to come, that deposit is held for the booking and not used on other bills, unless it is moved to the client's wallet (`POST …/salon/clients/:contactId/advance-refund`, mode `wallet`).

A *manager's approval* in a body is `{ reason, approverId?, pin? }`: the approver must hold the named permission in this business and type their own PIN (My profile › Personal PIN; five wrong tries lock it). A person who holds the permission and approves their own booking needs only the reason; money handed back always needs the PIN. Refusals carry `data.reason`: 400 `wrong_pin` or `approval_needed`, 403 `not_an_approver`, 409 `no_pin`, 423 `pin_locked`.

#### `GET /api/businesses/:businessId/service-approvers`
Permission: `appointments.create`, `sales.edit` or `repairs.view`. A salon, a business with Repairs, or one with Sold by weight (`weight`, whose orders for pickup hand an advance back); 404 for others.
Query/Body: `permission` (`appointments.approve` or `sales.refund`).
Returns: the members who may approve, with `has_pin`.

#### `GET /api/businesses/:businessId/salon/settings`
Permission: `appointments.view` or `settings.view`.
Query/Body: none.
Returns: `data` = `{ deposit_percent, free_cancel_hours, late_cancel_fee_percent, no_show_fee_percent, opens_at, closes_at, fee_sku_id, session_commission_basis, ... }`. When nothing is saved yet, the defaults are 0%, 4 h, 50%, 100%, 09:00 and 21:00.

#### `PUT /api/businesses/:businessId/salon/settings`
Permission: `settings.edit`.
Query/Body: `depositPercent` (0-100); `freeCancelHours` (0-168); `lateCancelFeePercent` and `noShowFeePercent` (0-100; both default to 0 when left out); `opensAt` and `closesAt` (`HH:MM`); `sessionCommissionBasis` (`package_price` | `list_price`, default `package_price`: what a session paid from a package earns commission on).
Returns: `data` = the saved `salon_settings` row.
Errors: 400 a bad time, or closing not after opening.

**Services and their back-bar products**

#### `GET /api/businesses/:businessId/salon/services`
Permission: `catalog.view`. Salon only.
Query/Body: paged list of service SKUs, excluding plan and fee items; `q` searches label, code and category; filter `active`. No date filter.
Returns: `data` = `{ total, items[] }`. Each item is `{ id, code, label, price, tax_rate, active, product_name, category, duration_minutes, buffer_minutes, needs_room, timed, stylist_count, backbar_products }`.

#### `PUT /api/businesses/:businessId/salon/services/:skuId`
Permission: `catalog.edit`.
Query/Body: `durationMinutes` (5-600, required); `bufferMinutes` (0-120); `needsRoom` (boolean).
Returns: `data` = the `salon_services` row (it is created or replaced).
Errors: 404 service not found (the item must be a service).

#### `GET /api/businesses/:businessId/salon/services/:skuId/products` and `PUT /api/businesses/:businessId/salon/services/:skuId/products`
Permission: `catalog.view` (GET), `catalog.edit` (PUT).
Query/Body (PUT): `products` (up to 20 of `{ skuId, quantity }`, each product once), in each product's stock unit. Goods only, not serial-numbered, and whole units for count items.
Returns: the service's back-bar recipe, with `cost` per service at the products' latest purchase prices. Every service line on a salon bill takes its recipe × quantity out of stock at the bill's location (oldest use-by first; what the books do not have is recorded as short and never stops the bill), costed at the product's latest purchase price; each use is kept in `salon_backbar_usage` and written as a `backbar.used` event.

**Stylists, rooms, the working week, leave and holidays**

#### `GET /api/businesses/:businessId/salon/staff`
Permission: `appointments.view`. Salon only.
Query/Body: paged list of resources; `q` searches name, role_label, location_name and kind; filters `kind` (`staff` | `room`) and `active`. No date filter.
Returns: `data` = `{ total, items[] }`. Each item is a resource row plus `location_name, kind, skills[{ sku_id, label }], booked_today, week[]`.

#### `PUT /api/businesses/:businessId/salon/staff/:resourceId`
Permission: `appointments.create`.
Query/Body: `kind` (`staff` | `room`, default `staff`); `skuIds` (service ids the stylist does; empty means every service; must be empty for a room; left out keeps the skills); `name`; `roleLabel`; `active`; `weeklyOff` (0 = Sunday … 6); `worksFrom` and `worksTo` (the usual hours).
Returns: `data` = the resource plus `{ kind, skuIds }`.
Errors: 400 skills given for a room; 404 not found; 409 making a stylist into a room, or switching them off, while they have bookings to come.

#### `PUT /api/businesses/:businessId/salon/staff/:resourceId/week`
Permission: `appointments.create`.
Query/Body: `days` (`[{ dow, off, worksFrom?, worksTo? }]`): the weekdays that differ from the stylist's usual hours (the list is replaced). At least one working day.
Returns: `{ resourceId, days, clashes[] }`: `clashes` are the bookings to come that now fall outside the week (they are not moved).

#### `POST /api/businesses/:businessId/salon/staff/:resourceId/leave` and `POST /api/businesses/:businessId/salon/staff/:resourceId/leave/:leaveId/cancel`
Permission: `appointments.create`.
Query/Body: `fromDate`, `toDate` (default `fromDate`), `reason?` (cancel: `{}`).
Returns: the leave (201 when added). Refused (409) while the stylist has bookings on those days (move them to another stylist first), or when it overlaps other leave.
Errors: 404 leave not found (cancel).

#### `GET /api/businesses/:businessId/salon/holidays`, `POST /api/businesses/:businessId/salon/holidays` and `POST /api/businesses/:businessId/salon/holidays/:holidayId/cancel`
Permission: `appointments.view` (list), `settings.edit` (add, cancel).
Query/Body: list: paged, filter `location`; dates on the day. POST: `{ day, name, locationId? }` (one location, or every location when left out).
Returns: the salon holiday.
Errors: 400 a day that has passed; 404 location or holiday not found; 409 bookings exist that day (move them first), or the day is already a holiday.

**The calendar and bookings**

#### `GET /api/businesses/:businessId/salon/calendar`
Permission: `appointments.view`.
Query/Body: `date` (`YYYY-MM-DD`, required); `days` (1–7, default 1); `location` (optional location id).
Returns: `data` = `{ date, days, timezone, settings, resources[], appointments[], services[], holidays[], canOverride, totals }`. Each appointment carries its `day`, room, `price_at_booking`, the deposit (`deposit_no`, `deposit_amount`, `deposit_unused`), the fee bill and the service bill, and `arrived_at`, `late`, `confirmation_sent_at`, `reminder_sent_at`, `walk_in`, `moved_count`, `client_no_shows`, `member`, `first_visit`, `category`. Each resource adds `weekly_off`, `works_from`, `works_to`, `leave[]` and `week[]` (`{ dow, off, works_from, works_to }`). `holidays[]` is `{ id, location_id, day, name }`, and `canOverride` says whether the caller may let a booking through the rules. `totals` counts the appointments by status, with `arrived`.
Errors: 400 invalid date.

#### `POST /api/businesses/:businessId/salon/appointments`
Permission: `appointments.create`. A deposit also needs `sales.edit`.
Query/Body: `requestKey` (UUID, required); `contactId` (a customer, required); `skuId` (a service, required); `resourceId` (a stylist, required); `startsAt` (ISO timestamp string, required); `roomId` (required when the service needs a room); `notes` (up to 300); `deposit` (`{ amount, method: cash|card|upi|bank|cheque, reference? }`; a cheque needs a reference); `override` (a manager's approval, the approver holding `appointments.approve`). The booking blocks the stylist, and the room, for the service's duration plus its clean-up time.
The booking follows the salon's calendar hours, salon holidays, and the stylist's leave, weekly day off, usual hours and weekly schedule (a weekday row overrides the usual hours). Outside the calendar hours it is refused with 400 `{ reason: "outside_hours", rule }`; on a holiday, on leave, on a day off or outside the stylist's hours with 409 `{ reason: "outside_hours", rule }`. With `override` it goes through and is kept in `salon_booking_overrides` (audit `appointment.override`).
Returns: `data` = the appointment row plus `room_id, deposit_collection_id, deposit_no`; status 201.
Errors: 400 a time more than a day past, a service that would not end the same day, a room needed, or the room at another location; 400 / 409 `outside_hours`; 404 stylist, room, client or service not found; 409 the stylist lacks the skill, the stylist or room is already booked, or the request key was reused.

#### `PATCH /api/businesses/:businessId/salon/appointments/:appointmentId`
Permission: `appointments.edit`.
Query/Body: `startsAt`, `resourceId?`, `roomId?`, `override?`.
Returns: the moved appointment with `room_id`, `resource_name` and `room_name`. The same checks as booking (hours, skills, the stylist's leave, day off, hours and week, no clash for the stylist or room, a room where needed). It keeps its length, deposit and price, never charges a fee, and resets the confirmation and reminder sent. Audit and event `appointment.moved` `{ from, to }`.
Errors: 409 the booking is billed or not booked; the booking errors above.

#### `POST /api/businesses/:businessId/salon/appointments/:appointmentId/arrived`
Permission: `appointments.edit`.
Query/Body: `{}`
Returns: the appointment with `arrived_at`; event `appointment.arrived`.
Errors: 404 appointment not found; 409 not a booking still to come, not today's, or made outside the salon calendar.

#### `POST /api/businesses/:businessId/salon/appointments/:appointmentId/messages`
Permission: `appointments.create` or `appointments.edit`.
Query/Body: `kind` (`confirmation` | `reminder`).
Returns: `{ appointmentId, kind, sentAt }`: a WhatsApp message sent from the person's own phone (wa.me) is recorded.
Errors: 404 appointment not found; 409 not a booking still to come.

#### `GET /api/businesses/:businessId/salon/appointments`
Permission: `appointments.view`. Salon only.
Query/Body: paged list; `q` searches the client's name and phone, the service, the stylist and the bill number; filters `status`, `staff`, `contact`, `location`; dates on `starts_at`.
Returns: `data` = `{ total, items[] }`: the booking history with the room, price at booking, deposit, bill, charge, `walk_in` and `moved_count`.

#### `GET /api/businesses/:businessId/salon/appointments/:appointmentId/fee`
Permission: `appointments.view`.
Query/Body: `status` (`completed` | `cancelled` | `no_show`, required).
Returns: `data` = `{ percent, fee, depositUnused, freeCancelHours }`. This previews the fee that the status change would charge; nothing is saved.
Errors: 400 bad status; 404 appointment not found.

#### `POST /api/businesses/:businessId/salon/appointments/:appointmentId/status`
Permission: `appointments.edit` or `appointments.cancel` at the route. The service then needs `appointments.cancel` for `cancelled` and `appointments.edit` for the others. Charging a fee also needs `sales.create`.
Query/Body: `status` (`completed` | `cancelled` | `no_show`, required); `requestKey` (UUID, required).
Fee rule: a no-show costs `no_show_fee_percent` of the booked price. A cancellation less than `free_cancel_hours` before the start costs `late_cancel_fee_percent`; one made earlier is free. The fee is only ever taken from the unused deposit still held for the booking (capped at it, in whole rupees); a deposit moved to the wallet is not touched. It is posted as a numbered sale bill on the "Cancellation / no-show charge" item, which is created on first use, and paid from the deposit. Whatever is left of the deposit stays the client's advance.
Returns: `data` = `{ appointment, fee }`, where `fee` = `{ documentId, documentNo, total, percent }` or `null`. Repeating the same status returns `{ appointment, fee: null, repeated: true }`.
Errors: 404 appointment not found; 409 the appointment is not booked any more.

#### `GET /api/businesses/:businessId/salon/walk-ins`, `POST /api/businesses/:businessId/salon/walk-ins`, `POST /api/businesses/:businessId/salon/walk-ins/:walkInId/seat` and `POST /api/businesses/:businessId/salon/walk-ins/:walkInId/left`
Permission: `appointments.view` (list), `appointments.create` (the rest).
Query/Body: list: paged, filters `status` and `location`. POST: `{ contactId, skuId, resourceId?, note?, locationId? }`; the location is the one given (a person tied to a location gets theirs), else the stylist's, else the business's first open location. Seat: `{ resourceId, roomId?, requestKey }`. Left: `{}`.
Returns: the waiting list; the new entry (with `contact_name`, `service_name`); seat books the walk-in from now, marked arrived and `walk_in`, and returns `{ walkIn, appointment }` (`repeated: true` for the same key again); left takes them off the list and returns the entry.
Errors: 404 client, service or walk-in not found; 409 the client is already waiting (one waiting entry per client), or the walk-in is not waiting any more.

**Clients**

#### `GET /api/businesses/:businessId/salon/clients/:contactId`
Permission: `sales.create` or `appointments.view`.
Query/Body: none.
Returns: `data` = `{ contact, profile, notes[] (the latest 30), visits[] (bill lines with the stylist), stats { visits, spent, last_visit, no_shows, usual_stylist }, memberships[], packages[], otherPlans[], advance, held, deposits[], refunds[] (the latest 20), upcoming[], bills[] }`. `advance` can be used now; `held` is kept for bookings still to come. Each deposit carries `appointment_id`, `notes` and `released` (moved to the wallet), and its unused amount is less refunds. Plans are listed only when the Packages module is on.
Errors: 404 client not found.

#### `PUT /api/businesses/:businessId/salon/clients/:contactId/profile`
Permission: `contacts.edit`.
Query/Body: `birthday`, `anniversary`, `gender`, `preferredResourceId`, `allergies`.
Returns: the client card's profile.

#### `POST /api/businesses/:businessId/salon/clients/:contactId/notes`
Permission: `contacts.edit`.
Query/Body: `kind` (`note` | `formula`), `body`.
Returns: 201, the dated note or colour formula, kept as written.

#### `POST /api/businesses/:businessId/salon/clients/:contactId/advance-refund`
Permission: `sales.edit`, and a manager's approval from someone with `sales.refund` (always with their PIN).
Query/Body: `collectionId`, `mode` (`cash` | `wallet`), `amount?`, `method?` (`cash`, `upi` or `bank`; UPI and bank need a `reference`), `reference?`, `reason`, `approverId?`, `pin?`, `requestKey`.
Returns: 201. `cash` hands back what is left of that receipt (or `amount`), numbered `<receipt>-R<n>` (audit and event `collection.refunded`); a repeat with the same key returns the first refund. `wallet` makes a deposit held for a booking still to come the client's advance, usable on any bill (`salon_deposit_releases`, audit `deposit.moved_to_wallet`).
Errors: 404 not this client's deposit or advance; 409 a cheque that bounced, nothing left, or a deposit that is already the client's advance; plus the approval errors.

#### `GET /api/businesses/:businessId/salon/advance-refunds`
Permission: `sales.view`. Salon only.
Query/Body: paged list; filter `contact`; dates on `created_at`.
Returns: `data` = `{ total, items[] }` of salon advance refunds.

**Bills**

#### `POST /api/businesses/:businessId/salon/quote`
Permission: `sales.create`.
Query/Body: the same as the salon bill (lines, `contactId`, `appointmentIds`, `useAdvance`, `discount`). The core posting runs in quote mode and nothing is saved.
Returns: `data` = the bill as posting would make it (lines, membership and package discounts, GST, round-off, total) plus `advance, advanceUsable, toPay`.
Errors: 400 lines not between 1 and 100. Line and plan errors are the same as the bill.

#### `POST /api/businesses/:businessId/salon/bills`
Permission: `sales.create`. A payment or `useAdvance` also needs `sales.edit`; tips need `sales.edit`; a discount needs `sales.discount`.
Query/Body: `requestKey` (UUID, required); `locationId`; `contactId` (required with `useAdvance` or `appointmentIds`); `lines` (1-100 of `{ skuId, quantity, staffId?, clientPlanId?, appointmentId?, lotCode? }`); `appointmentIds` (up to 10); `useAdvance` (boolean); `payment` (`{ amount, method: cash|card|upi|bank|cheque, reference? }`), or `payments` (up to 3 of the same shape, for a bill paid in several ways); `tips` (`[{ staffId, amount, method }]`: not part of the bill, kept in `salon_tips`); `discount` (`{ amount | percent, reason }`, within the business's counter-discount limit); `notes`.
How lines are priced: a plan item sells one package or membership per line, to the client. `clientPlanId` pays a service line from a package session. An active membership discounts the other lines. `staffId` records the stylist, and the commission rule is applied to that line when Commissions is on. Each service line takes its back-bar products out of stock (see the back-bar recipe above).
Returns: `data` = `{ document, advanceApplied }`, or `{ document, advanceApplied, repeated: true }` for a repeated key; status 201. The advance is applied oldest first. Billed booked appointments become `completed`.
Errors: 400 no client; 403 package used while the module is off; 404 the appointment or package is not this client's; 409 the amount paid is over what is left, an appointment was cancelled, a no-show, or already billed, a package is used up, expired or cancelled, a plan is not sold any more, or a plan is sold while Packages is off.

**Packages and memberships**

#### `GET /api/businesses/:businessId/salon/plans`
Permission: `packages.view`. Salon only; Module: `packages`.
Query/Body: paged list; `q` searches name, description and sku_code; filters `kind` (`package` | `membership`) and `active`. No date filter.
Returns: `data` = `{ total, items[] }`. Each item is a plan plus `sku_code, price, tax_rate, services[{ sku_id, label, sessions, price }], sold, holders`.

#### `POST /api/businesses/:businessId/salon/plans`
Permission: `packages.create`. Module: `packages`.
Query/Body: `kind` (`package` | `membership`, required); `name` (required, up to 150); `price` (required); `validityDays` (1-3650, required); `description`; `taxRateId` (optional; the default is the 18% slab). A membership needs `serviceDiscountPercent` and/or `productDiscountPercent` (0-100, at least one above 0). A package needs `services` (1-20 of `{ skuId, sessions 1-100 }`, no repeats).
Returns: `data` = the plan plus `sku_code` (PKG-001 / MEM-001) and `price`; status 201. A service item is created for selling the plan.
Errors: 400 a membership with no discount, or a bad services list; 404 tax rate or service not found.

#### `PATCH /api/businesses/:businessId/salon/plans/:planId`
Permission: `packages.edit`. Module: `packages`.
Query/Body: either `{ active }` alone, or the full plan fields as for create, without `kind`. Changes apply to future sales only.
Returns: `data` = the updated plan row.
Errors: 404 plan not found; 400 validation as for create.

#### `GET /api/businesses/:businessId/salon/client-plans`
Permission: `packages.view`. Salon only; Module: `packages`.
Query/Body: paged list; `q` searches contact_name, contact_phone, name and document_no; `from`/`to` filter on created_at; filters `kind`, `state` (`active` | `upcoming` | `expired` | `used_up` | `cancelled`), `contact` and `plan`.
Returns: `data` = `{ total, items[] }`. Each item is a client plan plus `contact_name, contact_phone, document_no, state, days_left, services[{ sku_id, label, sessions, used }], sessions_total, sessions_used, saved`.

#### `PATCH /api/businesses/:businessId/salon/client-plans/:clientPlanId`
Permission: `packages.edit`.
Query/Body: `endsOn` (a later date only), `reason`.
Returns: the client plan, extended; audited as `package.extended` or `membership.extended`.

#### `POST /api/businesses/:businessId/salon/client-plans/:clientPlanId/cancel`
Permission: `packages.edit`. Module: `packages`.
Query/Body: `reason` (string, required, up to 300).
Returns: `data` = the cancelled client plan row. The bill line that sold it can then be returned through the core returns.
Errors: 404 not found; 409 already cancelled, or already used on a bill line.

#### `GET /api/businesses/:businessId/salon/client-plans-summary`
Permission: `packages.view`.
Query/Body: none.
Returns: `{ active, sessions_left, sessions_left_value, expiring_30 }`.

#### `GET /api/businesses/:businessId/salon/plan-usage`
Permission: `packages.view`. Module: `packages`.
Query/Body: paged list; filter `plan` (a client plan).
Returns: `data` = `{ total, items[] }`: the bill lines that used a plan's sessions or discount.

**Commissions**

#### `GET /api/businesses/:businessId/salon/commission-rules`
Permission: `commissions.view`. Salon only.
Query/Body: paged list; `q` searches resource_name, sku_label and applies_to; filters `active` and `staff` (resource id). No date filter.
Returns: `data` = `{ total, items[] }`. Each item is a rule plus `resource_name, sku_label`.

#### `POST /api/businesses/:businessId/salon/commission-rules`
Permission: `commissions.edit`.
Query/Body: `appliesTo` (`service` | `goods` | `plan`, required; `plan` is selling a package or membership); `percent` (0-100), or `flatAmount` (a flat amount per item instead); `resourceId` (a stylist; optional, and none means every stylist); `skuId` (optional, and none means every item). On a bill line, the most specific active rule wins: a named stylist beats all stylists, then a named item beats all items.
Returns: `data` = the new rule; status 201.
Errors: 404 stylist not found; 409 an active rule for exactly this already exists.

#### `PATCH /api/businesses/:businessId/salon/commission-rules/:ruleId`
Permission: `commissions.edit`.
Query/Body: `percent` (0-100) or `flatAmount`; `active` (boolean).
Returns: `data` = the updated rule.
Errors: 404 rule not found.

Bill lines with a stylist are recorded as `service`, `goods`, `plan` or `session` (a service paid from a package, whose commission is worked on the session's value: see `sessionCommissionBasis` in the salon settings).

#### `GET /api/businesses/:businessId/salon/commissions`
Permission: `commissions.view`.
Query/Body: `from` and `to` (required, at most 367 days apart, by bill date).
Returns: `data` = `{ from, to, rows[] }`, one row per stylist: `{ resource_id, name, role_label, service_lines, services_done, sessions_done, session_value, service_sales, product_sales, plan_sales, bills, commission, tips, paid, paid_to, due, scheme, slab_commission, slab_months[] }`. All figures are net of returns. For a stylist on a monthly target plan, the service commission is the plan's slab on each month's net service sales, shared over the dates by their part of that month's sales (a whole month gives exactly the slab); payouts are checked against it.
Errors: 400 invalid dates or range.

#### `GET /api/businesses/:businessId/salon/commission-lines`
Permission: `commissions.view`. Salon only.
Query/Body: paged list; `q` searches document_no, label, resource_name and contact_name; `from`/`to` filter on the bill's created_at; filters `staff` (resource id), `kind` (`service`, `goods`, `plan` or `session`) and `location`.
Returns: `data` = `{ total, items[] }`. Each item is `{ line_id, document_id, document_no, created_at, contact_name, label, quantity, net, resource_name, appointment_id, rule_id, item_kind, commission_percent, commission_base, commission_amount, returned_quantity, commission_after_returns }`.

#### `GET /api/businesses/:businessId/salon/commission-payouts` and `POST /api/businesses/:businessId/salon/commission-payouts`
Permission: `commissions.view` (list), `commissions.edit` (POST).
Query/Body: list: paged, filters `staff` and `location`. POST: `{ resourceId, from, to, amount, method, reference?, note?, requestKey }`; `method` is `cash`, `upi`, `bank` or `cheque` (a cheque needs its number as `reference`).
Returns: the payout of commission and tips for a period, kept with what was earned then (the slip).
Errors: 409 more than is due.

#### `GET /api/businesses/:businessId/salon/commission-plans`, `POST /api/businesses/:businessId/salon/commission-plans` and `PATCH /api/businesses/:businessId/salon/commission-plans/:planId`
Permission: `commissions.view` (list), `commissions.edit` (POST, PATCH).
Query/Body: list: paged, filter `active`. POST: `{ name, mode: stepped | whole, slabs: [{ fromAmount, percent }] }` (up to 10 slabs; the first starts at 0). PATCH: `{ name?, active? }`.
Returns: the monthly target plan.
Errors: 409 changing the slabs or mode once saved.

#### `GET /api/businesses/:businessId/salon/commission-schemes` and `PUT /api/businesses/:businessId/salon/staff/:resourceId/commission-scheme`
Permission: `commissions.view` (GET), `commissions.edit` (PUT).
Query/Body (PUT): `planId` (or null for the flat rules), `fromMonth` (`YYYY-MM`; this month or later).
Returns: which way each stylist earns on services from a month on.

#### `GET /api/businesses/:businessId/salon/commission-statement`
Permission: `commissions.view`.
Query/Body: `month` (`YYYY-MM`), `staff`.
Returns: the month's payout statement: the plan, `serviceSales`, `bands[]` (`{ from, to, percent, base, amount }`), `serviceCommission`, `others[]` (products, packages sold, sessions), `commission`, `tips`, `paid`, `due`.

**Reports**

#### `GET /api/businesses/:businessId/salon/backbar-usage`
Permission: `reports.view`. Salon only.
Query/Body: paged list; filters `product`, `service` and `location`; dates on `created_at`.
Returns: `data` = `{ total, items[] }`: every product taken by a service, with the bill, quantity, `short` and cost.

#### `GET /api/businesses/:businessId/salon/reports/service-profitability`
Permission: `reports.view`.
Query/Body: `from`, `to`.
Returns: per service: `done`, `sales` (after discounts and returns, before GST), `product_cost`, `commission` (flat-rule amounts), `margin`, `margin_percent`; `totals`; and the `short` uses.

### Weight-based shops

These routes cover cutting and processing with yield, yield templates, daily wastage, stock by weight, the day's rate board, the end-of-day weigh-up, pickup orders, and the yield and wastage reports. Cutting and wastage move stock as reasoned stock corrections, never as sales, so stock cannot go below zero. Quantities are thousandths of the stock unit, and kg figures are converted through the unit's factor. Templates and cutting need Module: `processing` (Cutting & yield). Wastage needs Module: `wastage` (Daily wastage). The stock list, the rate board and pickup orders need Module: `weight` (Sold by weight).

**Stock and the day**

#### `GET /api/businesses/:businessId/weight/stock`
Permission: `inventory.view`. Module: `weight`.
Query/Body: paged list, one row per active weight item per active location; `q` searches label, code, category and location_name; filters `location` and `low` (`true`/`false`). No date filter.
Returns: `data` = `{ total, items[] }`. Each item is `{ id ("sku-location"), sku_id, location_id, location_name, code, label, unit, price, category, kg_factor, on_hand, on_hand_kg, value, average_cost, next_expiry, sold_7d, wasted_7d, cut_7d, cut_used_7d, low, ... }`.

#### `GET /api/businesses/:businessId/weight/stock-today`
Permission: `inventory.view`. Module: `weight`.
Query/Body: `location`.
Returns: per item and location: `opening`, `received`, `cut_in`, `cut_out`, `sold` (net of returns), `wasted`, `corrected`, `on_hand`, `use_soon`.

#### `GET /api/businesses/:businessId/weight/today`
Permission: `inventory.view`. Module: `weight`.
Query/Body: none.
Returns: the overview card: kg sold, cut and wasted, what must be used by today or tomorrow, rates changed today, and pickups due today.

#### `POST /api/businesses/:businessId/weight/day-close`
Permission: `inventory.edit`. Module: `weight`.
Query/Body: `locationId`, `lines` (`[{ skuId, counted, reason? }]`), `requestKey`.
Returns: 201, the end-of-day weigh-up, kept in `weight_day_closes`. Short is wastage (oldest batches first, `drip_loss` by default); over is a correction on the newest batch.
Errors: 404 location not found, or an item not sold by weight; 409 the request key reused with different data.

#### `GET /api/businesses/:businessId/weight/day-closes`
Permission: `inventory.view`. Module: `weight`.
Query/Body: paged list; filter `location`; dates on `created_at`.
Returns: `data` = `{ total, items[] }` of the day closes.

**The rate board**

#### `GET /api/businesses/:businessId/weight/rates` and `PUT /api/businesses/:businessId/weight/rates`
Permission: `catalog.view` (GET), `catalog.edit` (PUT). Module: `weight`.
Query/Body (PUT): `rates` (`[{ skuId, price }]`).
Returns: the day's rate board: each item's rate now, `opening_price`, cost per unit and how many customer rates it has. Saving changes only the items whose rate changed, writes `weight_rate_history` and audits `catalog.price_changed` (`source: rate_board`).
Errors: 409 a rate above the item's MRP.

#### `GET /api/businesses/:businessId/weight/rate-history`
Permission: `catalog.view`. Module: `weight`.
Query/Body: paged list; filter `sku`; dates on the change.
Returns: `data` = `{ total, items[] }`: every rate change.

**Yield templates and cutting**

#### `GET /api/businesses/:businessId/weight/yield-templates`
Permission: `processing.view`.
Query/Body: paged list; `q` searches name and input_label; filters `active` and `input` (input SKU id). No date filter.
Returns: `data` = `{ total, items[] }`. Each item is a template plus `input_label, input_unit, outputs[{ sku_id, label, unit, expected_percent }], expected_yield, batches`.

#### `POST /api/businesses/:businessId/weight/yield-templates`
Permission: `processing.edit`. Module: `processing`.
Query/Body: `name` (required, up to 150); `inputSkuId` (a goods item stocked by weight and not serial-tracked, required); `outputs` (1-20 of `{ skuId, expectedPercent 0.01-100 }`, no repeats, not the input, total at most 100%); `active` (default true).
Returns: `data` = the template row; status 201.
Errors: 400 the input is not stocked by weight, or the outputs are invalid or add up to more than 100%.

#### `PATCH /api/businesses/:businessId/weight/yield-templates/:templateId`
Permission: `processing.edit`. Module: `processing`.
Query/Body: either `{ active }` alone, or the full fields as for create, which replace the outputs.
Returns: `data` = the updated template row.
Errors: 404 template not found; 400 validation as for create.

#### `GET /api/businesses/:businessId/weight/processing`
Permission: `processing.view`.
Query/Body: paged list of cutting batches; `q` searches batch_no, input_label, notes and location_name; `from`/`to` filter on created_at; filters `location`, `input`, `id`, `template`, `supplier` and `cutter`.
Returns: `data` = `{ total, items[] }`. Each item is a batch plus `location_name, created_by_name, template_name, input_lot_code, yield_percent, expected_yield, cost_per_usable_kg, outputs[{ sku_id, label, unit, quantity, kg, cost_share, unit_cost, expected_percent, lot_id, offcut }]`. `offcut`: the cut was priced, before GST, below what its whole item cost a kilo when it was cut.

#### `POST /api/businesses/:businessId/weight/processing`
Permission: `processing.create`. Module: `processing`.
Query/Body: `requestKey` (UUID, required); `inputLotId` (the stock lot being cut, required); `inputQuantity` (required, in the lot's unit, no more than the lot holds); `outputs` (1-20 of `{ skuId, quantity, packKg? }`, each a weight item, no repeats, not the input; `packKg` for an output sold by the piece, remembered per item); `templateId` (optional; must belong to the same input item); `cutBy` (who cut it); `notes` (up to 500).
In one transaction, the input weight leaves its lot and each cut enters stock at the same location. The input cost is split across the cuts by selling value, or by weight when no cut has a price. A batch-tracked cut gets a batch named after the cutting number, with the input's expiry. The supplier of the input batch is recorded with the cutting. Each cut is marked an offcut (`weight_processing_outputs.offcut`) when its price for a kilo, before GST, is below the input's cost for a kilo.
Returns: `data` = the batch row (`batch_no, input_kg, output_kg, loss_kg, input_value, ...`) with `outputs[]` (`{ skuId, code, label, unit, quantity, lotCode }`); status 201.
Errors: 400 the input or a cut is not stocked by weight, or the cuts weigh more than the input; 404 input stock, cut or template not found; 409 the input batch has expired (record it as wastage instead), the input quantity is over the lot, or the request key was reused.

#### `POST /api/businesses/:businessId/weight/cut-to-order`
Permission: `processing.create` and `sales.create`. Module: `processing`.
Query/Body: as `POST …/weight/processing`.
Returns: 201, the cutting batch, marked `cut_to_order`: cutting at the counter, whose cut the counter then bills from its batch.

#### `GET /api/businesses/:businessId/weight/processing/:batchId`
Permission: `processing.view`. Module: `processing`.
Query/Body: none.
Returns: `data` = one batch, shaped like a list item.
Errors: 404 cutting batch not found.

**Wastage**

#### `GET /api/businesses/:businessId/weight/wastage`
Permission: `wastage.view`.
Query/Body: paged list; `q` searches label, note, reason, location_name and lot_code; `from`/`to` filter on created_at; filters `location`, `reason` and `sku`.
Returns: `data` = `{ total, items[] }`. Each item is a wastage entry (`label, unit, quantity, kg, reason, note, unit_cost, value, ...`) plus `location_name, created_by_name, lot_code`.

#### `GET /api/businesses/:businessId/weight/wastage-today`
Permission: `wastage.view`. Module: `wastage`.
Query/Body: none.
Returns: `data` = `{ entries, kg, value, month_value, month_kg }` for today and for the current month, in the business timezone; `entries` counts today's entries.

#### `POST /api/businesses/:businessId/weight/wastage`
Permission: `wastage.create`. Module: `wastage`.
Query/Body: `requestKey` (UUID, required); `lotId` (required); `quantity` (required, no more than the lot holds); `reason` (`trimming` | `spoiled` | `unsold` | `drip_loss` | `damaged` | `other`, required); `note` (required when the reason is `other`, up to 300). This works for any loose goods item, not only weight items, but serial-tracked items are refused.
Returns: `data` = the wastage entry, valued at the lot's cost; status 201.
Errors: 400 a bad reason, a missing note, or a serial-tracked item; 404 stock not found; 409 the quantity is over the lot, or the request key was reused.

#### `POST /api/businesses/:businessId/weight/wastage/batch`
Permission: `wastage.create`. Module: `wastage`.
Query/Body: `locationId`, `entries` (`[{ skuId, quantity, reason, note? }]`), `requestKey`.
Returns: 201, `{ entries[], value, kg }`: many items in one go, each taken from its oldest batches first.
Errors: 404 location or item not found.

**Pickup orders**

#### `GET /api/businesses/:businessId/weight/pickup-orders` and `POST /api/businesses/:businessId/weight/pickup-orders`
Permission: `sales.view` (list), `sales.create` (POST). Module: `weight`.
Query/Body: list: paged, filters `status`, `active`, `today`, `id` and `location`; dates on the pickup time. POST: `{ locationId, contactId? | customerName, phone?, pickupAt, notes?, lines: [{ skuId, quantity? | amount?, note? }], advance?: { amount, method (cash/card/upi/bank) | methodId, reference? }, requestKey }`. An `advance` needs `sales.edit` and a saved customer (`contactId`), and is at most what the order comes to at today's rates (each weight at its item's shelf price with GST, each `amount` as it is); it is a numbered collection receipt in the customer's name (`business_collections`, notes "Advance on order for pickup #…"), audited `collection.recorded` with the order's id.
Returns: phone and WhatsApp orders for pickup, each with `advance_no` (the receipt's number), `advance` (its amount), `advance_left` (less the bills it paid and what was handed back) and `advance_to_hand_back` (the order is closed and some of its advance is left); POST returns the new order (`advance_collection_id`).
Errors (POST): 400 an advance above the order's value or not a number; 409 an advance on an order with no saved customer.

#### `POST /api/businesses/:businessId/weight/pickup-orders/:orderId/advance`
Permission: `sales.create` and `sales.edit`. Module: `weight`.
Query/Body: `{ amount, method | methodId, reference?, requestKey }`: the advance on an open order taken without one.
Returns: 201, the order with its `advance_collection_id`. The same request key gives the same answer.
Errors: 400 no amount, or more than the order comes to at today's rates; 404 order not found; 409 the order is collected or cancelled, already has its advance, or has no saved customer; 409 the request key used for other data.

#### `POST /api/businesses/:businessId/weight/pickup-orders/:orderId/advance-refund`
Permission: `sales.view` and `sales.edit`, with the PIN of a member who holds `sales.refund` (`approverId` and `pin`; the caller's own PIN when `approverId` is left out). Module: `weight`.
Query/Body: `{ amount? (all that is left when left out), method | methodId (cash, UPI or bank), reference?, reason, approverId?, pin?, requestKey }`.
Returns: 201, the refund of the order's receipt (`business_collection_refunds`, source `pickup`, numbered), plus `order_id` and `repeated`.
Errors: 404 order not found; 409 the order has no advance, or is still open or ready (cancel it first, or bill it); 409 more than is left of the advance; PIN errors as for the other refunds.

#### `POST /api/businesses/:businessId/weight/pickup-orders/:orderId/status`
Permission: `sales.create`. Module: `weight`.
Query/Body: `status`: `open` (back to packing), `ready`, `cancelled` (with a `reason`) or `collected` (with its bill's `documentId`). An order with an advance is not marked `collected` here: its bill is made with the order on it (`POST …/documents` with `pickupOrderId`), which closes it.
Returns: the order.
Errors: 404 order or bill not found; 409 the order is already collected or cancelled, the bill is older than the order or already on another order, or the order has an advance and is marked `collected`.

**Reports**

#### `GET /api/businesses/:businessId/weight/reports/yield`
Permission: `reports.view`; the service also requires `processing.view`. Module: `processing`.
Query/Body: `from` and `to` (required, at most 367 days apart); `location`, `template`, `cutter`, `supplier` (optional).
Returns: `data` = `{ from, to, inputs[], cuts[], days[], cutters[], suppliers[], bySupplier[], shortValue, totals }`. `inputs` holds each input item's batches by item and template (`label` = the template's name): kg in, out and lost, `yield_percent`, `expected_percent`, the cost per usable or input kg, and the shortfall against the template: `short_points` (percentage points below the expected yield), `short_kg` (the usable kg not got) and `short_value` (those kg at the cost of a usable kg), which add up to `shortValue`. `cutters` names who cut. `cuts` gives the kg, cost and share of each cut. `bySupplier[]` is `{ supplier_id, supplier_name, input_sku_id, input_label, batches, input_kg, output_kg, loss_kg, yield_percent, batch_average_percent, worst_percent, best_percent, expected_percent, cost_per_usable_kg, item_average_percent, versus_average }`; a batch's supplier is the one kept when it was cut, otherwise the purchase that brought its input batch in, and the `supplier` filter uses the same. `offcuts` = `{ recovered, items[], days[] }`: what offcuts brought in, from the bills in the dates (the business's clock) at the `location` when one is given: each sale line of an item whose latest cut at the bill's location, before the bill, was an offcut, at its value before GST less what was returned of it. `items[]` is `{ sku_id, label, unit, cut_quantity, cut_kg (cut as offcuts in the dates), bills, quantity, recovered }`, most recovered first; `days[]` is `{ day, bills, recovered }`, newest first. `totals` = `{ batches, inputKg, outputKg, lossKg, yieldPercent, inputValue }`.
Errors: 400 invalid dates or range.

#### `GET /api/businesses/:businessId/weight/reports/wastage`
Permission: `reports.view`; the service also requires `wastage.view`. Module: `wastage`.
Query/Body: `from` and `to` (required, at most 367 days apart); `location` (optional).
Returns: `data` = `{ from, to, items[], reasons[], days[], totals }`. `items` holds each item's entries, quantity, kg, value, sold_quantity and wastage_percent. `reasons` gives the totals per reason with a label. `totals` = `{ entries, kg, value }`.
Errors: 400 invalid dates or range.

## Pharmacy, clinic & lab

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module, permission). Lists take `limit`, `offset`, `q`, `from`, `to` and their filters and answer `{ total, items }`. Backend module `modules/business/health/`. Pharmacy routes answer 404 for other business types; clinic and lab routes likewise.

**Settings and signatories**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /health/settings` | any of pharmacy.view, patients.view, lab.view, settings.view | Settings (defaults until saved), signatories, the seller's address and `locationLicences` (each location's own drug licences; a person tied to a location sees theirs) |
| `PUT /health/location-licences/:locationId` | pharmacy.edit or settings.edit | `{ drugLicence20, drugLicence21, drugLicence20b, drugLicence21b, drugLicence20f }` (each up to 60): a pharmacy branch's own drug licences, since each premises is licensed on its own. All five empty removes them, and the branch uses the business-wide numbers. Returns `{ location_id, location_name, drug_licence_20, … }`; 404 location not found |
| `PUT /health/settings` | pharmacy.edit or settings.edit | `drugLicence20/21/20b/21b/20f`, `h1RetentionYears`, `xRetentionYears`, `prescriptionRetentionYears`, `rxScanRequired`, `nearExpiryDays`, `labName`, `labRegistration`, `reportFooter`, `clinicalRetentionYears`, `consentNotice` (a change makes a new version), `referralCommissionEnabled` (settings.edit), `referralCommissionPercent` |
| `GET /health/signatories?kind=` | as GET settings | Pharmacists / doctors / pathologists with `has_pin` |
| `POST /health/signatories` | pharmacy.edit (pharmacist) or settings.edit | `{ kind, userId, name, qualification, registrationNo, council, resourceId (doctor), active }`, upsert per kind and user |

**Pharmacy**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /pharmacy/drugs` | pharmacy.view or sales.create | Goods with drug details and stock; filters `schedule` (`unset` = no details), `cold_chain`, `has_master`, `active` |
| `GET /pharmacy/drugs/:skuId` | pharmacy.view or sales.create | One drug with pack sizes, usable batches (first to expire, not recalled) and `substitutes` |
| `PUT /pharmacy/drugs/:skuId` | pharmacy.edit | `{ composition, strength, form, manufacturer, schedule, unitsPerStrip, stripsPerBox, looseSale, coldChain, storage }`; adds the strip / box pack sizes |
| `GET /pharmacy/drugs/:skuId/substitutes` | pharmacy.view or sales.create | Same salt and strength, cheapest in stock first |
| `POST /pharmacy/prescription-files` (multipart `file`) | pharmacy.create | Upload a scan (JPG, PNG, WebP, PDF ≤ 5 MB) → `{ id }`. Mounted before the JSON-only router |
| `GET /pharmacy/prescription-files/:fileId` | pharmacy.view | The file itself (private, `no-store`); logged as `pharmacy.prescription_file_viewed` |
| `POST /pharmacy/sales` | sales.create (+ sales.edit to pay, pharmacy.create for scheduled lines) | `{ requestKey, locationId, contactId?, lines: [{ skuId, quantity, unit?, lotCode? }], payment? \| payments? (split, up to 8, as on documents), channel?: "counter", counterPin? \| counterProof? (the till switch's proof, as on documents), prescription?: { patientName, patientPhone, patientAge, patientAddress, doctorName, doctorRegNo, doctorAddress, prescribedOn, fileId }, signoff?: { signatoryId, pin } }` → `{ document, prescription, registers }`. 409 `prescription_required`, `prescription_scan_required`, `pharmacist_signoff`; PIN errors as `wrong_pin`, `pin_locked`, `no_pin`. Batches first-to-expire, whole strips first. Same request key → the same bill |
| `GET /pharmacy/prescriptions` · `GET /pharmacy/prescriptions/:id` | pharmacy.view | Prescription log (period; `location`) · one with its lines |
| `GET /pharmacy/registers/h1` · `GET /pharmacy/registers/x` | pharmacy.view | The H1 register · the Schedule X and narcotic register (period; `location`) |
| `GET /pharmacy/summary?from&to` | pharmacy.view | Counts for the period: prescriptions, H1 and X entries, doctors, without scan, returns awaiting credit, open recalls |
| `GET /pharmacy/recalls` · `POST /pharmacy/recalls` | pharmacy.view · pharmacy.approve | List · `{ skuId, lotCode, reason, reference, block }` → the recall with every `sales` row (bill, customer, phone, quantity) |
| `GET /pharmacy/recalls/:id` · `POST /pharmacy/recalls/:id` | pharmacy.view · pharmacy.approve | Detail with sales and stock · `{ action: block / unblock / close, note }` |
| `GET /pharmacy/near-expiry?days&location` | inventory.view | Batches expiring within N days (default the setting) grouped by distributor |
| `GET /pharmacy/debit-notes` · `POST /pharmacy/debit-notes` | pharmacy.view · pharmacy.approve + purchasing.refund | List (period; `status`, `supplier`, `reason`, `location`) · `{ requestKey, contactId, reason, notes, lines: [{ lotId, quantity }] }`: supplier returns on the distributor's purchases of each batch, the rest written off (inventory.edit) |
| `GET /pharmacy/debit-notes/:id` · `POST /pharmacy/debit-notes/:id/credit` | pharmacy.view · pharmacy.approve | Detail · `{ creditNoteNo, creditNoteDate, amount }` (≤ claimed) |

`GET /documents/:id` of a pharmacy sale also returns `pharmacy: { licences, pharmacist, prescription, lines: [{ line_id, schedule, expires_on }] }`, printed on the invoice. `licences` are the selling branch's own when it has them, else the business-wide numbers.

**Clinic**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /clinic/patients` | patients.view | Patients with age, visits, last visit, `consent_active`; filters `sex`, `consent` |
| `POST /clinic/patients` | patients.create | `{ name, phone, email, address \| contactId, sex, dateOfBirth \| ageYears, guardianName, emergencyPhone, consent: { purposes: ['treatment', …], method, givenBy } }`; 409 `consent_required` without treatment consent |
| `GET /clinic/patients/:contactId` | patients.view | Details, consents, visits, appointments, lab orders; `clinical` only with patients.view_clinical (logged) |
| `PATCH /clinic/patients/:contactId` | patients.edit | Details |
| `PUT /clinic/patients/:contactId/clinical` | patients.edit_clinical | `{ bloodGroup, allergies, conditions, currentMedicines }` |
| `POST /clinic/patients/:contactId/consents` · `POST /clinic/consents/:id/withdraw` | patients.create · patients.edit | `{ purpose, method, givenBy }` · `{ reason }` (once) |
| `GET /clinic/today?day&doctor&location` | patients.view | The day's appointments with visit, consent, bill, lab and token status (`token_id`, `token_no`, `token_status`); walk-in visits |
| `GET /clinic/visits` · `GET /clinic/follow-ups` | patients.view | Visits (period; `status`, `doctor`, `patient`, `lab`, `location`) · follow-ups by due date (`came_back`, `location`) |
| `POST /clinic/visits` | patients.edit_clinical or patients.create | `{ appointmentId }` or `{ contactId, resourceId, locationId? }`; one visit per appointment. The visit's location is the doctor's, else the one given or in effect, else the clinic's first; the appointment's token moves to in consultation. 409 `consent_required`, `not_a_patient` |
| `GET /clinic/visits/:id` | patients.view | Front-desk fields; with patients.view_clinical also vitals, notes, diagnosis, prescription, the referral (`referred_to`, `referral_reason`), approved lab results (logged) |
| `PATCH /clinic/visits/:id` | patients.edit_clinical | Vitals (`bpSystolic`, `bpDiastolic`, `pulse`, `temperatureC`, `spo2`, `respRate`, `weightKg`, `heightCm`), `complaints`, `examination`, `diagnosis`, `icd10Code`, `advice`, `followUpOn`, `resourceId`, `referredTo` (the specialist or hospital the patient is referred to, up to 200 characters; empty clears it), `referralReason` (up to 1,000), `prescription: [{ drugName, strength, dose, frequency, duration, instructions }]`, `complete: true`. 400 "Say whom the patient is referred to" for a reason with no one referred to |
| `GET /clinic/medicines?q` | patients.edit_clinical | The medicines the clinic's doctors have prescribed, the most prescribed first (up to 200; `q` searches the name): `[{ drug_name, strength, dose, frequency, duration, instructions, times }]`, each with the way it is written most often and `times` its prescription lines. A visit offers them as the doctor writes the prescription |
| `POST /clinic/visits/:id/notes` | patients.edit_clinical | `{ body }`, added after completion |
| `POST /clinic/visits/:id/bill` | sales.create | `{ documentId }` links the desk's bill, or `{ requestKey, locationId?, lines?, payment?, includeConsultation? }` posts the consultation (+ lines) at the visit's location. The consultation is the doctor's fee, their follow-up fee or nothing within the follow-up days (as `GET …/fee` says), else the booked service; a free follow-up with nothing else to bill is recorded with no bill (`document: null`). Returns `{ visit, document, fee }` |
| `GET /clinic/visits/:id/fee` | sales.create or patients.view | What the visit's consultation is charged: `{ kind, skuId, label, price, follow_up_days, last_consultation }`, `kind` being `consultation` (the doctor's fee), `follow_up` (their follow-up fee) or `free_follow_up` (within the follow-up days of the patient's last paid consultation with that doctor); for a doctor with no fee set, `{ kind: booked_service, skuId, label, price }` (the appointment's service) or `{ kind: none }` |
| `GET /clinic/doctors?location` | appointments.view | Doctors (and rooms) at the branch, with `is_doctor`, `speciality`, the consultation and follow-up fees (`consultation_sku_id`, `consultation_label`, `consultation_price`, `follow_up_sku_id`, …), `follow_up_days`, `slot_minutes` (10 until set), `share_percent`, `sessions[{ id, dow, starts, ends, max_patients }]` and leave still to come |
| `PUT /clinic/doctors/:resourceId` | settings.edit | `{ speciality, consultationSkuId, followUpSkuId, followUpDays (0-90), slotMinutes (5-120), sharePercent (0-100), sessions? }`. The fees are services on the bill (a follow-up fee needs a consultation fee); `sessions` (OPD by weekday, `[{ dow (0 = Sunday), starts, ends (HH:MM), maxPatients? (1-500) }]`, up to 28, none overlapping on a day) replaces the week, and left out keeps it. An appointment on a day the doctor is on leave is refused, and once the doctor has sessions, one outside them too (409 `doctor_unavailable`). Returns the doctor as the list has it; 404 doctor or fee service not found |
| `POST /clinic/doctors/:resourceId/leave` · `POST /clinic/leave/:id/cancel` | appointments.edit | `{ fromDate, toDate? (default fromDate), reason? }` → 201 the leave with `booked` (appointments already on those days, for the desk to move) · cancels it (cancelling again changes nothing); 404 doctor or leave not found |
| `GET /clinic/slots?day&doctor` | appointments.view | A doctor's appointment slots for a day, `slot_minutes` each within that day's sessions: `{ doctor, day, sessions, leave, scheduled, slots[{ starts_at, ends_at, past, taken }] }` (no slots on leave) |
| `GET /clinic/doctor-earnings?from&to&location` | reports.view | Per doctor for the period: `visits, consultations, follow_ups, free_follow_ups, not_billed, fees, share_percent, share` (their share of the consultation fees billed); `totals { visits, fees, share }` |
| `GET /clinic/queue?day&location&doctor` | patients.view | The token queue for a day (today by default): `day`, `server_time` (the server's clock, which the screens count waiting minutes on), every token, and per doctor who is being seen (`serving`), the last called, `waiting`, `done` and the next three |
| `POST /clinic/tokens` | patients.create | `{ appointmentId }` (on the appointment's day; asking again returns its token) or `{ contactId, resourceId? }`, with `priority?`, `note?`, `locationId?` → 201 the token: the next number for that doctor (or the clinic) that day. 409 `not_a_patient`, `consent_required`, the doctor on leave, `opd_full` (the day's sessions' maximum reached), or the patient already holding a token today |
| `POST /clinic/tokens/next` | patients.create or patients.edit_clinical | `{ resourceId?, locationId? }`, "Next patient": the token being seen is done, one called who did not come in is skipped, and the next waiting token (priority first) is called → `{ called }` (null with "No one is waiting") |
| `POST /clinic/tokens/:id` | patients.create or patients.edit_clinical | `{ action: call / start / done / skip / cancel }`; `start` opens the patient's consultation (from the appointment, if any) and links the visit. 409 a move the token's state does not allow |

A token moves waiting → called → in consultation → done, or is skipped or cancelled; completing its visit marks it done.

**Lab**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /lab/tests` · `GET /lab/tests/:id` | lab.view | Tests and profiles · one with parameters and ranges (ages in years) |
| `POST /lab/tests` · `PUT /lab/tests/:id` | lab.edit | `{ code, name, kind: test / profile, skuId, sampleType, container, method, turnaroundHours, active, parameters: [{ id?, name, unit, resultType, decimals, active, ranges: [{ sex, ageFrom, ageTo, low, high, criticalLow, criticalHigh, normalText }] }], testIds (profile) }` |
| `GET /lab/orders` · `GET /lab/worklist` | lab.view | Orders (period; `status`, `priority`, `patient`, `outside`, `visit`, `location`), with `flagged` (results out of range) only for lab.edit, lab.approve or patients.view_clinical, else null · counts by stage |
| `GET /lab/bench?location` | lab.view | The lab's day at a glance, for its workspace: every open order and those approved today (last), urgent first, then the oldest, up to 300 (`more` when there are others): `{ day, server_time, results_visible, orders[{ id, order_no, location_id, contact_id, visit_id, status, priority, referred_by, created_at, approved_at, version, outside_lab, amending, patient_name, patient_no, sex, visit_no, document_no, samples[{ id, barcode, sample_type, container, status, reject_reason, collected_at, collected_by_name, received_at, received_by_name }], tests[{ id, test_id, code, name, sample_id, profile_name, parameters, entered }], flagged?, critical? }], more }`. `flagged` and `critical` (results out of range, and critical ones) only for lab.edit, lab.approve or patients.view_clinical (`results_visible`); no result is read, so nothing is logged. A person tied to a location sees theirs |
| `POST /lab/orders` | lab.create (+ sales.create / sales.edit to bill) | `{ requestKey, locationId, contactId \| visitId, testIds, priority, referredBy, notes, documentId? \| bill: true, payment? }`; one sample (barcode) per sample type |
| `GET /lab/orders/:id` | lab.view | Order, samples, tests; results and an amendment's reason (`amend_reason`) only with lab.edit, lab.approve or patients.view_clinical (logged); while it is received, in process or resulted, `qc[{ parameter_id, name, status }]`: today's QC of its parameters (`accepted`, `warning`, `rejected`, `not_run`) |
| `POST /lab/samples/:id` · `GET /lab/samples/barcode/:code` | lab.create · lab.view | `{ action: collect / receive / reject, reason }` · open a sample by its barcode |
| `PUT /lab/orders/:id/results` | lab.edit | `{ results: [{ orderTestId, parameterId, value }] }` (empty value clears); flags against the patient's range |
| `POST /lab/orders/:id/approve` | lab.approve | `{ signoff: { signatoryId, pin } }` (a pathologist). Each signing is kept as a numbered version of the report. 409 `qc_rejected` `{ parameters }` while today's QC of one of its parameters is rejected |
| `GET /lab/orders/:id/report` | lab.print | The printable report of an approved order (logged as `lab.report_printed`), with `report_version`, `report_amend_reason` and `amends` (the version it amends). `?version=N` prints an earlier signed version as it was, marked `superseded`; 404 a version never signed |
| `GET /lab/orders/:id/versions` | lab.print, lab.approve or lab.edit | Every signed version, newest first: `{ order_id, order_no, current, versions[{ id, version, amend_reason, approved_at, results[], pathologist_name, pathologist_qualification, pathologist_reg_no, superseded }] }` |
| `POST /lab/orders/:id/amend` | lab.approve | `{ reason, signoff: { signatoryId, pin } }` (a pathologist): reopens a signed report for correction (back to `resulted`). It is corrected and signed again with `POST …/approve`; the new version says it amends the earlier one, which can still be printed. 409 when the report is not signed |
| `POST /lab/orders/:id/refer` · `POST /lab/orders/:id/cancel` | lab.create | `{ outsideLab, referenceNo, outsideCharge, referralCommission? }` (409 `referral_commission_off` while the setting is off) → the order (`amend_reason` as `GET` gives it) · `{ reason }` |
| `GET /lab/qc/materials` · `POST /lab/qc/materials` · `PUT /lab/qc/materials/:id` | lab.view · lab.edit | Quality-control materials, one per numeric parameter, lot and level: list (filters `active`, `parameter`; rows add `parameter_name, unit, test_code, test_name, last_run, today_outcome, expired`) · `{ parameterId (create only), name, lotNo, level (default "Level 1"), mean, sd, expiresOn?, active }`; 404 a parameter that is not numeric or not yours, or a material not found; 409 the lot and level already set up for the parameter |
| `GET /lab/qc/runs` · `POST /lab/qc/runs` | lab.view · lab.edit | Runs (filters `material`, `parameter`, `outcome`; dates on `run_at`) · `{ materialId, value, note?, correctiveAction? }` → 201 the run with its `z` score, the Westgard `rules` it broke and its `outcome`: 1-2s warns; 1-3s, 2-2s, R-4s, 4-1s and 10x reject. 409 a control material that is switched off, or an expired lot |
| `GET /lab/qc/today` | lab.view | Today's QC by parameter: each control's latest run and the parameter's `status` (`rejected`, `not_run`, `warning`, `accepted`), with a count of each. While a parameter's latest run today is rejected, a report with that parameter cannot be signed |

## Quotations

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `quotations`, permission). The list takes `limit`, `offset`, `q`, `from`, `to` and its filters and answers `{ total, items }`. Backend module `modules/business/quotations/`. How the figures are worked out: [BUSINESS_PLATFORM_DATA_MODEL.md › Quotations](BUSINESS_PLATFORM_DATA_MODEL.md#quotations).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /quotations` | quotations.view | Quotations (period on `created_at`; search number, customer, phone, notes, bill, order, site; filters `status`, `state` (open, part_billed (open, some of it billed), expired, billed, ordered, cancelled; several comma-separated), `contact`, `location`, `site`). Rows add `state`, `expired`, `location_name`, `document_no` (the bill that closed it), `order_no`, `line_count`, `bill_count`, `site_id`, `site_name`, `created_by_name` |
| `POST /quotations/preview` | quotations.create or quotations.edit | `{ locationId, contactId?, lines: [{ skuId, quantity, unit? }], discount?: { amount \| percent, reason } }` → what a sale of these lines would come to now, nothing saved: `{ taxMode, contactId, lines[{ skuId, label, unit, quantity, unitPrice, priceKind, enteredUnit, enteredQuantity, enteredUnitPrice, unitFactor, priceRuleId, hsnCode, mrp, amount, discount, net, tax, taxRate, offers[], kitParts? }], subtotal, tax, roundOff, total, savings }`, one line for each line asked for. A kit is one line priced as on a bill (its price split over its parts by their list prices, each part at its own GST): its `kitParts[{ skuId, label, unit, quantity (a kit's), hsnCode, taxRate, amount, discount, net, tax }]`, `taxRate` the kit's own (the highest of its parts'); a kit with a serial-numbered part is quoted one kit to a line (400 otherwise). A discount needs `sales.discount` and stays within the counter limit |
| `POST /quotations` | quotations.create | `{ requestKey, locationId, contactId? \| customerName (+ customerPhone?, 10 or more digits), validUntil (today up to 180 days ahead), lines (1-100), discount?, notes?, siteId? }` → 201 the quotation as `GET /quotations/:id` gives it, numbered `QT/…` at the location, with the business's `quotation_terms` as they are now (`terms`, kept for good). `siteId` is a hardware shop's (400 elsewhere), as are a line's `tint: { shadeId }` (module `hardware_tinting` and `hardware_tinting.create`; a base kept in stock, a shade that is on and needs that base) and `calculations` (the material calculators' workings, kept with the revision they were added in). Same key and body → the same quotation; same key, other body → 409 |
| `GET /quotations/:id` | quotations.view | The quotation with `state` (`part_billed` while open with a bill), `terms`, `lines[]` (with `sku_code`, `tracking`, `kit_parts` (a kit's parts as quoted, each with its `tracking`; else null), `billed_quantity`, `left_quantity` (in the line's stock unit; a kit's in kits), `billed_net`, `billed_tax`), `bills[{ id, document_no, total, created_at, created_by_name, lines[{ line_id, quantity }] }]`, `tax_notices[{ startsOn, from, to, toName, items[] }]` (while open: GST rate changes still to come that move an item of a line not yet billed, a kit's part too), `revisions[{ revision, total_before, total_after, lines_before, created_by_name, created_at }]`, what it became (`document_no`, `document_total`, `billed_at`; `order_no`, `order_status`), the saved customer's `contact_gstin`, `contact_address`, `contact_phone` and `contact_pan`, `seller` (as a bill prints it), `site` (a hardware shop's; else null), and a hardware shop's `tints[{ line_id, shade_id, maker, code, name, card, base, active }]` and `calculations[{ id, kind, revision, working: { inputs, assumptions, result, materials, added }, created_at, created_by_name }]` (empty elsewhere) |
| `PUT /quotations/:id` | quotations.edit | A revision: the body of `POST` without `locationId`. The lines are priced again at today's prices and replaced, and `revision` goes up; `siteId` left out keeps the site (one of another customer is taken off); the terms stay. 409 unless open, and once part of it is billed (bill, order or cancel what is left). Same key and body → the same answer |
| `POST /quotations/:id/cancel` | quotations.cancel | `{ reason }`: the quotation, or what is left of one part billed (its bills stay). Asking again returns the cancelled quotation; 409 when billed or ordered |
| `POST /quotations/:id/bill` | quotations.edit and sales.create (sales.edit to take a payment) | `{ requestKey, parts?: [{ lineId, quantity }], payment? \| payments? (as on documents), buyer?: { pan?, panDeclaration? }, lines?: [{ lineId, lots?: [{ lotCode, quantity }] \| serials?: [code] \| components?: [{ skuId, lotCode }] }], notes?, fitterId?, agri? (a farm-input shop's, as on documents) }` → 201 `{ quotation, document }`: a sale posted at the quoted prices (`fixed`), at the quotation's location, for its customer (a customer not saved is named in the bill's notes), with its site. `parts` bills only those lines, each `quantity` (in the unit the line was quoted in: its pack, a kit in whole kits) up to what is left of it; left out, every line that is left. Each bill takes each line's cumulative share of its quoted value and GST (kept in `business_quotation_billed`), so the bills add up to the line to the paisa; the quotation is `billed` (its `document_id` the last bill) when nothing is left. The quotation is locked first: two bills at once are counted one after the other, never past what a line holds. A kit goes on as its parts at their quoted shares (`kit_sku_id`, `kit_label` on each bill line), from their own stock (a batch part takes the batch that expires first, a serial-numbered part the number given in `components`). Batches go oldest expiry first unless named; serial items need their numbers. 409 when it is expired (a sentence asking to revise it first), not open, a line has less left than asked (the sentence says how much is left) or nothing is left, an item's (or a kit part's) GST rate or pack size changed, a kit's parts changed, the quoted rate is above the MRP now, the rounding setting changed (a bill of the whole quotation must equal its total), stock is short, a walk-in at a goods shop does not pay in full, or the credit limit or the cash limit is passed; 400 a kit's quantity that is not whole kits. A tinted line goes on the bill tinted, a job on the tinting board, from one batch (400 when its tins would come from two: name the batch). Audited `quotation.billed`, or `quotation.part_billed` with the lines while something is left (events likewise). Same key and body → the same bill |
| `POST /quotations/:id/order` | quotations.edit and sales_orders.create | `{ requestKey, expectedOn?, notes?, release?: { reason, approverId?, pin? } }` → 201 `{ quotation, order }`: a sales order at the quoted values of what is left (all of it when nothing is billed) for the saved customer, a kit as its parts at what is left of their shares, with the same credit-limit and credit-hold checks as any order (409 `credit_hold`, let through by `release` as on [Sales orders](#post-apibusinessesbusinessidsales-orders): the reason from someone with `receivables.approve`, or a manager's `approverId` and `pin`, kept in `wholesale_hold_releases` and audited `sales_order.hold_released` under the manager), and the quotation's site. 409 when the customer is not saved, a line left is tinted (made to order and billed instead), a line is a service, or as for the bill. Same key and body → the same order |

## Licences & registrations

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `licences`, permission). The list takes `limit`, `offset`, `q` and its filters and answers `{ total, items }`. Backend module `modules/business/licences/` (routes `businessLicences.routes.js`). Every route answers 403 while the module is off; a restaurant never has it. A person tied to one location sees and changes that location's licences only (403 for another). How they are used: [BUSINESS_PLATFORM_DATA_MODEL.md › Licences & registrations](BUSINESS_PLATFORM_DATA_MODEL.md#licences--registrations).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /licences` | licences.view | Every licence with `location_name`, `updated_by_name`, `today` (the business's own date), `state` (`valid`, `expiring` (within 60 days), `renewal_pending` (past `valid_until`, in force while its renewal is pending), `expired`, `not_yet`, `no_expiry`, `off`), `days_left` (to `valid_until`; null when it does not run out), `in_force` (today), its kind's `kind_name`, `renewal_rule` and `renewal_source`, and `file_count` (its scanned copies); search name, number, authority, location, kind, notes, qualified person; filters `location`, `active`, `kind`, `state`, `id`. Switched-on ones first, then by the date they run out |
| `POST /licences` | licences.edit | `{ locationId, kind (a short code of letters, digits and _, such as fertiliser, seed, insecticide, trade, fssai, md42, bis or peso), name, licenceNo, authority?, validFrom, validUntil? (none: it does not run out), covers?: [fertiliser, seed, insecticide], sellsTo? (retail, wholesale or both; left out: the kind's usual mark, else both), qualifiedPerson?, qualification?, qualificationCertificate?, qualificationExemption?, notes? }` → 201 the licence with `location_name`, `state`, `days_left`, `in_force` and its kind's rule. 400 a valid-until date before valid-from, a category named twice, or a qualified person without their qualification or why they are exempt (or those without a name); 404 a location not found or switched off; 409 the number is already kept for that kind of licence (any case; the sentence names the licence and its location). Audited `licence.created` |
| `PATCH /licences/:id` | licences.edit | The whole licence again without `locationId` and `kind`, which never change (sending another: 400, add that licence on its own), and `active?` (left out: unchanged; `false` when it is surrendered or cancelled). `authority`, `validUntil`, `covers`, the qualified person's fields and `notes` left out are cleared; `sellsTo` left out is kept. A later valid-until date (or none) ends a renewal applied for. Audited, with what changed from and to, as `licence.renewed` (a later valid-until date, or none), `licence.switched_off`, `licence.switched_on` or `licence.updated`. A licence is never deleted |
| `GET /licences/kinds` | licences.view or licences.edit | `[{ code, name, covers, sells_to, renewal_rule (lapses, while_pending, applied_within), renewal_source, offered, own_trade }]`: the kinds of licence (platform data, `platform_licence_kinds`, changed only by migrations), the business's own trade's first |
| `GET /licences/:id` | licences.view | The licence as the list gives it, with `renewal_deadline` (the last day a renewal applied for keeps a fertiliser authorisation in force), `files[{ id, file_name, mime_type, size_bytes, valid_from, valid_until, created_at, uploaded_by_name }]` (newest first), `keeps_endorsements`, `keeps_sources`, and an insecticide licence's `endorsements[{ id, product_id, product_name, product_brand, brand, endorsed_on, active }]` and `principals[{ id, manufacturer, registration_no, manufacturing_licence_no, formulations, valid_from, valid_until, withdrawn_on, withdrawn_note, state (valid, not_yet, expired, withdrawn) }]`, and a fertiliser authorisation's `sources[{ id, name, contact_id, contact_name, certificate_no, certificate_date, active }]` (empty otherwise). 404 not found |
| `PUT /licences/:id/renewal` | licences.edit | `{ appliedOn, reference }`: a renewal applied for (on or after valid-from, not ahead of today), until a later `validUntil` is typed; `{ appliedOn: null }` takes the mark off. Returns the licence as the list gives it. Whether it keeps the licence in force past its date is its kind's `renewal_rule`. 400 a licence that does not run out, or a date ahead of today; 409 a licence switched off. The same again changes nothing. Audited `licence.renewal_applied` (with `keepsInForce`) or `licence.renewal_cleared` |
| `POST /licences/:id/endorsements` · `PATCH /licences/:id/endorsements/:recordId` | licences.edit | An insecticide licence's endorsements: `{ productId \| brand, endorsedOn? }` (one item, every pack of it, or a brand) → 201 · `{ active?, endorsedOn? }`. 400 a licence that does not cover insecticides, or both or neither of item and brand; 404 item not found; 409 the item or brand is kept on it already. Audited `licence.endorsement_added`, `licence.endorsement_changed`, `licence.endorsement_switched_off` or `licence.endorsement_switched_on` |
| `POST /licences/:id/principals` · `PATCH /licences/:id/principals/:recordId` | licences.edit | An insecticide licence's principal certificates: `{ manufacturer, registrationNo, manufacturingLicenceNo, formulations[1..20], validFrom, validUntil? }` → 201 · the same without `manufacturer`, or `{ withdrawnOn, withdrawnNote? }` when the principal withdraws it (on or after valid-from, not ahead of today). 400 a licence that does not cover insecticides; 409 the manufacturer has a certificate on it for those dates already, or the certificate was withdrawn (a withdrawal stands). Audited `licence.principal_added`, `licence.principal_changed` or `licence.principal_withdrawn` |
| `POST /licences/:id/sources` · `PATCH /licences/:id/sources/:recordId` | licences.edit | A fertiliser authorisation's certificates of source (Form O): `{ contactId? (the supplier it covers purchases from), name? (as on the certificate; the supplier's name when left out), certificateNo, certificateDate (today or earlier) }` → 201 · the same and `active?`. 400 a licence that does not cover fertilisers; 404 not a supplier; 409 the certificate number is kept on it already. Audited `licence.source_added`, `licence.source_changed`, `licence.source_switched_off` or `licence.source_switched_on` |
| `POST /licences/:id/files` | licences.edit | Multipart, one `file`: a scanned copy of the licence (PDF, JPG, PNG or WebP, up to 5 MB; the bytes are checked), kept with the licence's dates now → 201 `{ id, file_name, mime_type, size_bytes, valid_from, valid_until, created_at }`. 400 another kind of file, or a larger one; 409 the licence keeps 40 copies already. Never changed or deleted. Audited `licence.copy_added`. Mounted before the Business Admin router (`licenceUploads.routes.js`) |
| `GET /licences/:id/files/:fileId` | licences.view | The copy itself (`Cache-Control: private, no-store`), at the licence's own location. 404 not found |

The records' routes answer the licence as `GET /licences/:id` gives it, with `saved: { id }`. Endorsements, principal certificates and sources are switched off (or withdrawn), never deleted (the database refuses).

`GET /notifications` (the bell) lists, for a role with `licences.view`, each switched-on licence that runs out within 60 days (warning: "… runs out in 12 days"), has run out (critical) or is past its date but in force while its renewal is pending (warning: "… is in force only while its renewal is pending", with the date and reference applied), linking to Licences. A farm-input shop's sale needs a licence in force covering each fertiliser, seed and pesticide line at the selling location, for retail or wholesale sales as the bill is: [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides).

## Hardware, paints & building materials

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module, permission). Lists take `limit`, `offset`, `q` and their filters and answer `{ total, items }`. Backend module `modules/business/hardware/` (routes `businessHardware.routes.js`). Every route answers 403 while its module is off, and so for every other type of business, which never has these modules.

**Sites** (module `hardware_sites`)

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /hardware/sites` | hardware_sites.view | Sites with `customer_name`, `customer_phone`, `bill_count`, `last_bill_at`, `billed`, `due` and `has_due`; filters `contact`, `active`, `id`, `has_due`; search name, address, person, phone, customer |
| `POST /hardware/sites` | hardware_sites.edit | `{ contactId (a customer), name, address?, contactPerson?, phone? (10 or more digits) }` → 201 the site. 409 the customer already has a site of that name (any case); 404 not a customer |
| `PATCH /hardware/sites/:id` | hardware_sites.edit | `{ name, address?, contactPerson?, phone?, active? }`; the customer never changes. Closing (`active: false`) keeps its bills; a closed site takes nothing new |
| `GET /hardware/sites/:id` | hardware_sites.view | `{ site, money, bills[{ id, document_no, created_at, due_on, total, location_name, balance }], statement[{ at, kind (bill, return, payment, refund), reference, document_no, document_id, amount (+ or −), balance (running) }], quotations[], orders[], totals: { billed, returned, paid, balance } }`. Bills, the statement and totals need `sales.view` (`money: false`, empty and null otherwise); quotations need `quotations.view`, orders `sales_orders.view` |
| `PUT /hardware/bills/:id/site` | hardware_sites.edit | `{ siteId }` puts a posted sale on one of its customer's open sites (or moves it); `{ siteId: null }` takes it off. Returns `{ site }`. 400 a purchase, or a walk-in's bill; 409 another customer's site or a closed one |
| `GET /hardware/orders/:id/site` · `PUT /hardware/orders/:id/site` | hardware_sites.view · hardware_sites.edit | A sales order's site · `{ siteId \| null }`: the order's invoices from now on go to that site, and those already raised without a site go there too. 409 a closed or cancelled order |

**Today's rates** (module `hardware_rates`; the service answers 404 for another type of business and 403 while the module is off)

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /hardware/rates` | catalog.view | `{ items[{ id, code, label, unit, unit_name, price, mrp, tax_rate, active, category_name, previous_price, price_changed_at, added_at }], taxMode, most }`: the board, by category and name |
| `PUT /hardware/rates` | catalog.edit | `{ rates[1..300]: [{ skuId, price, was? }] }` → `{ changed[{ skuId, label, from, to }] }`. Each changed price goes through the item's own update (`PATCH /catalog/:id` rules: MRP, member price, audit) in one transaction: all or none. A price equal to today's changes nothing. 404 an item not on the board; 409 above the MRP, or `was` is not the price now (changed by someone else since). Event `rates.changed` |
| `POST /hardware/rates/items` | catalog.edit | `{ skuIds[1..100] }` → 201 `{ added }`: items already on the board are left as they are. 409 a switched-off item, or more than 300 on the board |
| `DELETE /hardware/rates/items/:skuId` | catalog.edit | Takes the item off the board; the item and its price stay. 404 not on the board |
| `GET /hardware/rates/items/:skuId/history` | catalog.view | `?limit` (50; up to 200) → `{ item: { id, label, unit, price, mrp, on_board }, changes[{ id, changed_at, changed_by_name, from_price, to_price, document_no }] }`: the item's rate changes, newest first, from the activity log (`catalog.price_changed`, whichever screen made them; `document_no`: the purchase that set it). A change of the MRP alone is left out. 404 item not found |

**Material calculators** (module `hardware_calculators`; the service answers 404 for another type of business and 403 while the module is off)

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /hardware/calculator-items` | catalog.view | The items on sale (not kits, not kept for use in services) with a calculator figure in `attributes`: `[{ id, code, barcode, label, unit, price, mrp, product_id, product_name, attributes }]`, by product. `coverageSqftPerUnit`: the sq ft one unit of tiles covers; `coverageSqftPerLitre`: the sq ft one litre of paint covers in one coat; `litresPerUnit`: the litres in one unit (a paint's tins) |
| `POST /hardware/calculate` | catalog.view | `{ kind (tiles, paint, brickwork, concrete, plaster, steel), inputs, assumptions?, items?: { <material>: skuId } }` → `{ kind, inputs, assumptions, result, materials[{ material, measure, amount }], lines[{ material, skuId, label, unit, unitName, quantity }], unfit[{ material, skuId, label, unit }] }`. Worked out on the server (`hardwareCalculatorMaths.js`), every assumption answered with the value used. `inputs`: tiles and paint `{ area, areaUnit (sqft, sqm), coats? }`; brickwork `{ length, height, lengthUnit (ft, m), thickness (mm), openings? }`; concrete and plaster `{ by: area, area, areaUnit, thickness, thicknessUnit (mm, in) }` or `{ by: volume, volume, volumeUnit (m3, cft) }`; steel `{ lengthUnit, bars[1..20]: [{ diameter (6–32 mm), length, count }] }`. `assumptions`: tiles and paint `coverage` (and `wastage`, paint's `packs`); brickwork `brickLength`, `brickWidth`, `brickHeight`, `joint` (mm), `mix` (1:6), `dryFactor` (1.33), `wastage` (5), `bagKg` (50), `cementDensity` (1440 kg/m³); concrete `mix` (1:1.5:3), `dryFactor` (1.54), `wastage` (3); plaster `mix` (1:4), `dryFactor` (1.27), `wastage` (5); steel `kgPerMetre: { <diameter>: kg }` (diameter² ÷ 162), `barLength` (12 m), `wastage` (3). Materials are `cement` (bags), `sand` and `aggregate` (cft), `bricks`, `tiles`, `paint` and `steel_<diameter>` (kg); each item chosen answers its quantity in its own unit, rounded up (a bag, kg or quintal of cement; a cft, litre-based unit or count of sand; kg, quintal or bars of steel), or comes back in `unfit` when its unit cannot hold it. 400 a figure out of range, with a sentence; 404 an item not on sale |

A sale (`POST /documents`) or a quotation (`POST /quotations`, `PUT /quotations/:id`) takes `calculations[0..10]: [{ kind, inputs, assumptions?, added?: [{ skuId, quantity }] }]`: each working is worked out again and kept (`hardware_calculations`), with the revision of a quotation; `GET /documents/:id` (`hardware.calculations`) and `GET /quotations/:id` (`calculations`) answer them. The figures are estimates for the customer, not engineering.

**Fitters' commission** (module `fitter_commission`)

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /hardware/fitters` | fitter_commission.view | Fitters with `bill_count`, `last_bill_at`, `earned`, `taken_back`, `paid`, `due` and `has_due`; filters `active`, `trade`, `id`, `has_due`; search name, phone, UPI id, area, trade |
| `POST /hardware/fitters` | fitter_commission.create | `{ name, trade (painter, plumber, electrician, mason, carpenter, other), phone? (10 or more digits), upiId? (name@bank), area? }` → 201 the fitter. 409 another fitter has the phone |
| `PATCH /hardware/fitters/:id` | fitter_commission.edit | The same fields and `active?` (left out: unchanged). A fitter switched off is named on no new bill |
| `GET /hardware/fitters/:id` | fitter_commission.view | `{ fitter (with earned, taken_back, paid), statement[{ at, kind (earned, taken_back, paid, payout_reversed), reference, document_id, document_no, customer, bill_value, amount (+ or −), balance (running) }], totals: { earned, takenBack, paid, due } }` |
| `POST /hardware/fitters/:id/payouts` | fitter_commission.approve and expenses.create | `{ requestKey, amount, method (cash, upi, card, bank) or methodId, reference?, notes?, locationId (the person's own location when tied to one) }` → 201 the payout as the payouts list shows it. Writes a paid expense dated today (category `other`, "Fitter's commission: name (trade)") in the same transaction. 409 more than is due (a sentence with the due amount); same key and body → the same payout; same key, other body (or a key an expense already used) → 409 |
| `GET /hardware/fitter-payouts` | fitter_commission.view | Payouts with `fitter_name`, `trade`, `upi_id`, `method`, `method_name`, `reference`, `location_id`, `location_name`, `reversed`, `voided_at`, `void_reason`, `created_by_name`; filters `fitter`, `location`, `reversed`, `from`/`to` (the payout's date). Reverse a payout by reversing its expense (`POST /expenses/:id/reverse`) |
| `GET /hardware/fitter-rules` | fitter_commission.view | Rules with `scope` (item, category, all), `category_name`, `sku_label`, `sku_code`, `sku_unit`; filters `active`, `scope` |
| `POST /hardware/fitter-rules` | fitter_commission.edit | `{ categoryId? \| skuId?, percent (0.01–50) \| perUnit (one item only) }`; neither id: every item → 201 the rule. 409 a rule for that scope is already on |
| `PATCH /hardware/fitter-rules/:id` | fitter_commission.edit | `{ percent? \| perUnit?, active? }`. A bill already posted keeps what it earned. 409 switching one on while another for the scope is on |
| `GET /hardware/fitter-report` | fitter_commission.view | `?from&to` (default this month; up to 367 days) → `{ from, to, rows[{ id, name, trade, phone, upi_id, active, bills, sales (their bills before GST), earned, taken_back, paid (less payouts reversed in the dates), due (now) }], totals }`. Fitters switched off with nothing in the dates and nothing due are left out |
| `PUT /hardware/bills/:id/fitter` | fitter_commission.edit | `{ fitterId }`: names a fitter who is on on a posted sale made without one (its lines earn by the rules in force now; goods already back take back their share), or changes its fitter while the commission on it is not paid (payouts settle a fitter's oldest commission first). Returns the bill's `hardware.fitter`. 400 a purchase; 409 a fitter switched off, or a bill whose commission is paid (the database's sentence). Audited `fitter_commission.named_later`, or `fitter_commission.fitter_changed` with event `fitter_commission.moved` |
| `GET /hardware/orders/:id/fitter` · `PUT /hardware/orders/:id/fitter` | fitter_commission.view · fitter_commission.create | A sales order's fitter · `{ fitterId \| null }` → `{ fitter }`: every invoice its dispatches raise from now on earns the fitter their commission, and, for someone with `fitter_commission.edit`, those already raised without a fitter are named now. 409 an order dispatched in full, closed or cancelled, or a fitter switched off. Audited `sales_order.fitter_set` or `sales_order.fitter_cleared` |

A sale's `fitterId` (Quick bill, New sale, `POST /quotations/:id/bill`): each line earns by the item's rule, else the nearest category's up the tree, else the rule for every item: a percent of its value before GST (rounded to the paisa), or the amount per stock unit, never more than the line's value. The bill and its lines are written in the sale's transaction (`fitter_commission.earned` event); a return takes the commission back in proportion. `GET /documents/:id` answers `hardware.fitter: { id, name, trade, commission, taken_back, lines[{ line_id, percent, per_unit, commission }] }`, or `{ id, name, trade }` without `fitter_commission.view`.

**Paint tinting** (module `hardware_tinting`; 404 for another type of business, 403 while the module is off)

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /hardware/shades` | hardware_tinting.view | Shades with `maker`, `code`, `name`, `card`, `base`, `formula[{ colourant, ml }]` (for one litre of base), `active` and `job_count`; search maker, code, name, card, base; filters `active`, `maker`, `base`, `id`. On ones first, by maker and code |
| `POST /hardware/shades` | hardware_tinting.edit | `{ maker, code, name, card?, base, formula? ([{ colourant, ml }], or "XR 1.25; YE 0.4"; up to 12 colourants) }` → 201 the shade. 409 the maker's code is kept already (any case). Audited `shade.created` |
| `PATCH /hardware/shades/:id` | hardware_tinting.edit | The same and `active?`: a shade switched off is put on no new line; its jobs keep it. Never deleted. Audited `shade.updated`, `shade.switched_off` or `shade.switched_on` |
| `GET /hardware/shades/import-guide` · `POST /hardware/shades/import` | hardware_tinting.edit | The spreadsheet's columns (Maker, Shade code, Shade name, Card, Base, Formula (ml per litre), In use) and an example · `{ rows, dryRun?, fileName?, fingerprint? }`, as the other imports: a check first (`dryRun: true` answers 200 with `ok`, `problems`, each row's plan and `fingerprint`), then the import of the same file, all or nothing (400 with the problems; 409 `stale_preview` when the shades changed since the check). A maker's code is matched in any case; only what the file gives changes, and the same file twice changes nothing. Audited `shade.imported` |
| `GET /hardware/tinting/settings` · `PUT /hardware/tinting/settings` | hardware_tinting.view · hardware_tinting.edit | `{ chargeSkuId, charge: { id, label, code, barcode, price, taxRate, unit, active } \| null }` · `{ chargeSkuId \| null }`: the tinting charge, a service item that is on, priced for one tin at its own GST slab (400 otherwise). Audited `tinting.settings_changed` |
| `GET /hardware/tinting` | hardware_tinting.view | The tinting board: jobs with `status` (queued, tinted, handed_over, taken_back), `document_no`, `billed_at`, `customer`, `label`, `quantity`, `unit`, `lot_code`, `litres_per_unit`, the shade's `maker`, `shade_code`, `shade_name`, `card`, `base` and `formula`, `location_name`, and who tinted, handed over or approved taking it back, when; queued first, then tinted; filters `status`, `location`, `document`, `from`/`to` (billed) |
| `POST /hardware/tinting/:id/tinted` | hardware_tinting.create | The job is tinted: its base leaves stock now (the line's own batch, through the core), and its stock cost goes on the line. Asking again is the same. 409 a job taken back, or the base not in stock (receive it first). Audited and event `tinting.tinted` |
| `POST /hardware/tinting/:id/handed-over` | hardware_tinting.create | Handed over to the customer, once tinted. Asking again is the same. 409 a job not yet tinted, or taken back. Audited and event `tinting.handed_over` |
| `GET /hardware/tinting/approvers` | hardware_tinting.create | Those who may approve taking a tinted line back (with `sales.refund` and a manager PIN): `[{ id, name }]` |
| `POST /hardware/tinting/:id/take-back` | hardware_tinting.create | `{ requestKey, reason, approval: { approverId?, pin } }` → 201 the job, with `return: { id, return_no, total }`: the whole line (less what came back) taken back on the PIN of someone with `sales.refund`, as a return that puts nothing back in stock; the money goes back by a refund on the bill. 400 no reason, no PIN or a wrong one; 403 an approver who may not take goods back; 409 an approver with no PIN set, a job taken back already (the same key answers the same), or nothing left on the line; 423 the PIN locked after too many wrong tries. Audited `tinting.taken_back` (with who approved it); event `tinting.taken_back` |

A sale line `tint: { shadeId }` (Quick bill, New sale, a quotation billed): the line's item is goods kept by quantity or batch (400 otherwise), not part of a kit; the shade is on (409) and needs the base the item's `paintBase` names, when it names one (409, with both bases); the base free at the location (in stock, less queued jobs) covers it (409, with what is free and waiting). The base stays in stock until the job is tinted. A return of a tinted line is refused by the database (409: "… a tinted tin is not taken back. A manager may take it back with their PIN on the tinting board."). `GET /documents/:id` answers `hardware.tints[{ id, line_id, status, quantity, maker, code, name, card, base }]`. An item's `attributes.paintBase` (up to 40 characters) is kept with module `hardware_tinting` on. Audited and event `tinting.queued` with the bill.

## Seeds, fertilisers & pesticides

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `agri`, permission). The lists (farmers, tagged buyers, season credit, seed lots, stock kept apart, company schemes) take `limit`, `offset`, `q` and their filters and answer `{ total, items }`. Backend module `modules/business/agri/` (routes `businessAgri.routes.js`). Every route answers 403 while the module is off, and so for every other type of business, which never has it; the molecule list, which needs only membership, answers 404 for another type. Dates are the business's own (its time zone). A person tied to one location asks for that location only (403 for another). How it works: [BUSINESS_PLATFORM_DATA_MODEL.md › Seeds, fertilisers & pesticides](BUSINESS_PLATFORM_DATA_MODEL.md#seeds-fertilisers--pesticides).

**Molecules and farmers**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /agri/molecules` | any member | `{ molecules[{ code, name, status (banned, restricted_use, crop_restricted), restriction, source, users_only (sold only to a tagged pest-control operator or government body), users_formulation (the formulation that rule is for, or null: every one), only_formulation (kept for sale only in this formulation, or null), crops[{ code, name }] (the crops or groups it must not be used on) }], crops[{ key, code (the platform's) \| null, shopCropId, name, aliases, groups, isGroup }] }`: the platform's molecule list, the same for every shop and changed only by migrations, and the crops a farmer's word is matched against: the platform's crops and groups with what the shop added to them, and the shop's own |
| `GET /agri/farmers` | agri.view | Farmers (customers with farmer details) with `id` and `contact_id` (the customer's), `name`, `phone`, `address`, `active`, `village`, `village_key` (lower case), `relative_name`, `land_acres`, `crops`, `farmer_id`, `notes`, and, for a role with `sales.view` or `receivables.view`, `balance` (what they owe now, as Udhaar shows it) and `has_due`; search name, phone, village, father's or husband's name, Farmer ID, crops; filters `village` (its `village_key`), `active`, `id` and `has_due` (403 for a role that does not see dues). By village, then name |
| `POST /agri/farmers` | agri.edit | `{ contactId (a customer) \| name, phone?, address? (a new customer, which also needs contacts.create), village, relativeName?, landAcres? (up to 2 decimals), crops?, farmerId? (the Agri Stack Farmer ID: letters, digits, - and /, 4-30), notes? }` → 201 the farmer. 404 not a customer; 409 the customer already has farmer details, or the Farmer ID is another farmer's (any case). No Aadhaar number is asked for or kept. Audited `farmer.added` |
| `GET /agri/farmers/:contactId` | agri.view | `{ farmer, money, balance, bills[{ id, document_no, created_at, due_on, total, season, season_year, balance, overdue }] }`: every bill still to collect, oldest due first. Without `sales.view` or `receivables.view`: `money: false`, `balance: null`, no bills. 404 not a farmer |
| `PUT /agri/farmers/:contactId` | agri.edit | The farmer's details as on `POST` (without `contactId`); a customer without any gets them. 404 not a customer; 409 the Farmer ID is another farmer's. Audited `farmer.updated` (with the village before, when it changed) or `farmer.added` |
| `GET /agri/village-dues` | agri.view, and sales.view or receivables.view (403 otherwise) | `{ rows[{ village, village_key, farmers, owing, owed, overdue, season_due, next_harvest_due }], totals: { owed, overdue, seasonDue, owing } }`: for each village, its farmers, how many owe and what (their balances), what is past its due date, what is on season credit and the next harvest date one falls due. Customers without farmer details who owe come last, as one row with no village. Payments are taken on Udhaar |

**Subsidised fertiliser against the PoS device**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /agri/subsidy` | agri.view | `?locationId&from&to` (up to 92 days) → `{ location, from, to, rows[{ day, sku_id, label, unit, sold, bills, receipts, returned, pos_stock, app_stock, difference, checked_at }], totals: { sold, returned, bills, receipts, differences } }`: for each day and subsidised fertiliser at the location, what the bills sold (in the item's stock unit), how many bills and PoS receipts, what came back, and the last PoS stock typed in that day against the shop's own stock then (`difference` = shop − PoS). Newest day first |
| `GET /agri/subsidy/products` | agri.view | `?locationId` → `{ location, today, items[{ id, label, code, unit, unit_name, unit_decimals, stock, today: { pos_stock, app_stock, checked_at } \| null }] }`: the subsidised fertilisers, with the location's stock now and the last PoS stock typed in today |
| `POST /agri/subsidy/checks` | agri.create | `{ requestKey, locationId, lines[1..100]: [{ skuId, posStock }], notes? }`: the PoS device's stock of each subsidised fertiliser now, in the item's stock unit (no more decimals than the unit takes) → 201 the entry `{ id, location_id, location_name, checked_on, notes, created_by_name, created_at, lines[{ sku_id, label, unit, pos_stock, app_stock, difference }] }`, kept with the shop's own stock at that moment. 404 an item that is not a subsidised fertiliser. Same key and body → the same entry; same key, other body → 409. Never changed or deleted. Audited `pos_stock.checked`; event `agri.pos_stock_checked` |

**Registers and the board**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /agri/board` | agri.view | `?locationId&on?` (today, or a day gone by; 400 a day to come) → `{ location, on, today, closed, taxMode, rows[{ id, label, code, unit, unit_name, input_kind, subsidised, seed_class, seed_crop, seed_variety, price, mrp, opening_price, price_changed, opening, closing }] }`: each fertiliser, then each seed, with its opening stock that day (and its closing stock, for a day gone by) and its price (the location's own, else the item's) and MRP: now for today; for a day gone by, as they stood at its end, from the price history (`business_price_history`), with `opening_price` at its start |
| `GET /agri/seed-return` | agri.view | `?locationId&month=YYYY-MM` (this month or one gone by) → `{ location, month, dueOn (the 5th of the next month), closed, filed (as on Form XIV), rows[{ id, label, code, unit, unit_name, crop, variety, seed_class, kg_per_unit, opening, purchased, sold, other, closing, opening_q, purchased_q, sold_q, other_q, closing_q }] }`: each seed's stock on the first, what was bought and sold (net of goods returned), other changes and the closing stock, in its stock unit and in quintals (4 places; null where the weight of one unit is not known: a unit of weight, or `netKg` on a counted item) |
| `GET /agri/insecticide-register` | agri.view | `?locationId? (every location)&from&to` (up to 367 days) → `{ location, from, to, rows[{ created_at, day, document_id, document_no, location_name, farmer, village, relative_name, line_id, product, batch, manufacturer, quantity, unit, expires_on, crop, molecules, off_label (a crop not on its label), restricted_by (the buyer's tag it was sold under), returned }] }`: every pesticide line sold, oldest first. `farmer` and `village` are the customer's farmer details, or the walk-in's as the bill kept them; `manufacturer` is the item's own (`attributes.manufacturer`, with batches on), else its brand |
| `GET /agri/form-xiv` | agri.view | `?locationId&month=YYYY-MM` (this month or one gone by) → `{ location, month, dueOn (the 15th of the next month), closed, filed, rows[{ id, label, code, unit, molecules, formulation, opening, purchased, sold, to_trade, other, closing }] }`: the monthly return of insecticides (Form XIV) of the location: each pesticide's stock on the first, what was received and sold (net of goods returned; `to_trade` of it to dealers and bulk consumers, as in Form XIII), other changes (corrections, counts, stock kept apart, transfers) and the closing stock. `filed`: `{ filed_on, reference, notes, created_by_name }` once marked sent, else null |
| `GET /agri/form-xiii` | agri.view | `?locationId? (every location)&from&to` (up to 367 days) → `{ location, from, to, rows[{ day, document_id, document_no, location_name, buyer, buyer_gstin, address, buyer_kind (dealer, bulk_consumer), reference, line_id, sku_id, insecticide, molecules, batch, manufacturer, quantity, unit, returned }] }`: insecticides sold to dealers (a bill to a GSTIN) and to customers tagged bulk consumers when billed, insecticide by insecticide |
| `GET /agri/sulphur-register` | agri.view | `?locationId?&from&to` → `{ location, from, to, rows[{ day, document_id, document_no, location_name, buyer, address, line_id, product, quantity, unit, returned }] }`: every sale of an item made of sulphur, with its buyer's name and address (rule 10B) |
| `POST /agri/returns-filed` | agri.edit | `{ form (form_xiv, form_d), locationId, month, filedOn (after the month, today or earlier), reference?, notes? }` → 201 `{ form, location, month, filed }`: a month's return marked as sent to the licensing authority, once (409 again); the bell stops reminding. 400 a month not over. Audited `agri.return_filed` |

**The counter's checks, and the settings**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /agri/licence-check` | sales.create | `{ locationId, contactId?, lines[1..100]: [{ skuId }] }` → `{ trade (retail; wholesale for a customer with a GSTIN), notes[{ skuId, label, level (stop, warn), message }] }`: the licence checks a bill of these items would make (a licence in force for the kind of sale, one in force only while its renewal is pending, an insecticide's endorsement and its principal certificate), asked by Quick bill as the lines are typed. Items that are not fertilisers, seeds or pesticides are left out; with module `licences` off, nothing is checked |
| `POST /agri/counter-check` | sales.create | `{ locationId, contactId?, crop?, lines[1..100]: [{ skuId, quantity? (stock units), crop? }] }` → `{ trade, tags (the customer's tags in force), bags? ({ before, after, limit }: a named customer's subsidised bags this month), notes[{ skuId?, label?, kind (licence, formulation, restricted, label, bags), level (stop, warn), message, override? (restricted_use, bag_limit: a manager may allow it) }] }`: every check the bill will make of these lines, asked by Quick bill as they are typed |
| `GET /agri/settings` | agri.view | `{ endorsementCheck (warn), restrictedUse (block, override; block), bagLimitMode (block, override; block), advisoryOn (false), interestSkuId, interestItem: { id, label, tax_rate } \| null, bagLimits[{ stateCode, bagsPerMonth, own }] (each state the shop's locations are in, and any set), defaultBagLimit (50), bagWarnPercent (80), foodLocations[] }` |
| `PUT /agri/settings` | licences.edit for `endorsementCheck`, settings.edit for the rest (403) | Any of `{ endorsementCheck, restrictedUse, bagLimitMode, bagLimits[{ stateCode (the GST state code), bagsPerMonth (1-10000) }] (replaces the list), interestSkuId (an active service item, or null), advisoryOn, foodLocations[] (the locations that also keep food or feed) }`; what is left out stays → the settings and `{ changed, warnings }` (a location just marked that holds insecticides). 400 nothing to change, goods as the interest item, a state twice; 404 item or location. Audited `agri.settings_changed` |

**Crops, tagged buyers and a manager's override**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /agri/crops` | agri.view | `{ crops[{ key, code (the platform's) \| null, shop_crop_id, name, is_group, aliases, groups, shop_aliases, shop_groups, own, active }] }`: the platform's crops and groups (vegetables, fruits, pulses, cereals and millets, oilseeds, fruits and vegetables eaten raw) with what the shop added to each, then the shop's own crops |
| `POST /agri/crops` | agri.edit | `{ cropCode (one of the platform's crops) \| name (a crop of the shop's own, up to 80), aliases? (other names, up to 10), groups? (group codes, up to 10) }` → 201 `{ id, crops }` (the list as on `GET`). 400 a group not on the list, a name given twice, both or neither of `cropCode` and `name`, a group as `cropCode`; 404 crop not found; 409 a name or other name that already names a crop, additions to that crop kept already. Audited `crop.added` |
| `PUT /agri/crops/:cropId` | agri.edit | `:cropId` the shop's row (`shop_crop_id`); `{ aliases, groups, active? }` → `{ id, crops }`; a crop keeps its name (400). Audited `crop.changed`, `crop.switched_on` or `crop.switched_off` |
| `GET /agri/buyer-tags` | agri.view | Tags with `id` (`<contact>-<tag>`), `contact_id`, `tag` (`pest_control_operator`, `government`, `bulk_consumer`), `reference`, `valid_until`, `notes`, `active`, `in_force` (on and not past its date, on the business's today), `name`, `phone`, `address`, `gstin`, `updated_by_name`; search name, phone, reference, notes; filters `tag`, `active`, `contact` |
| `PUT /agri/buyer-tags/:contactId` | agri.approve for a pest-control operator or a government body, agri.edit for a bulk consumer (403) | `{ tag, reference? (the licence number, or the order or authority a government body buys under: required for those two, up to 80), validUntil?, notes?, active? (true) }`: the customer's tag given, changed or switched off (never deleted). 404 not a customer; 404 switching off a tag never given. Audited `buyer.tagged`, `buyer.tag_changed`, `buyer.tag_switched_on` or `buyer.tag_switched_off` |
| `GET /agri/overrides/approvers` | sales.create | `[{ id, name, has_pin }]`: the members whose role holds `agri.approve` |
| `POST /agri/overrides` | sales.create | `{ requestKey, kind (restricted_use, bag_limit), locationId, contactId? (required for bag_limit), skuIds[1..100] (restricted_use: each a restricted-use pesticide), approval: { approverId?, pin?, reason } }` → 201 the override `{ id, kind, location_id, contact_id, sku_ids, given_on, reason, approved_by_name, contact_name, document_id }`: a manager's leave, with their PIN (none for a manager allowing their own bill; never kept or hashed into the request) and the reason, for one bill at this till today. 400 no PIN, a wrong one, no reason, an item that is not restricted; 403 the approver's role does not hold `agri.approve`; 404 location, customer or item not found; 409 the shop's *Farm input checks* stop it outright, a key reused with other data. A retry with the same key returns the same override. Audited `agri.override_given` |

**Season credit**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /agri/season-credits` | agri.view | Each customer's credit for a season: `contact_id`, `name`, `phone`, `village`, `season`, `season_year`, `due_on`, `interest` (`none`, `after_due`, `from_bill`), `interest_rate` (% a month), `guarantor_name`, `crop_pledged`, `closed_at`, `closed`, `bills`, `today`, and for a role with `sales.view` or `receivables.view`, `credit_limit`, `owed` (left to collect on its bills), `overdue`, `owing`, `interest_billed`; search name, phone, village, guarantor, crop pledged; filters `contact`, `season`, `season_year`, `closed`, `overdue` and `owing` (those two 403 for a role that does not see dues), `id`. Open first, then by due date |
| `POST /agri/season-credits` | agri.approve | `{ contactId (a customer), season (kharif, rabi, zaid), seasonYear (last year, this year or next), dueOn (today up to 400 days ahead), creditLimit?, interest? (none), interestRate? (0.01-10, with interest), guarantorName?, guarantorPhone?, guarantorAddress?, cropPledged?, notes? }` → 201 the detail (below). 400 a guarantor's phone or address without the name; 404 customer not found; 409 the customer has credit for that season already. Audited `season_credit.opened` |
| `GET /agri/season-credits/:id` | agri.view | `{ season, money }`, and for a role that sees dues: `owed`, `left` (of the limit; null with none), `bills[{ id, document_no, day, total, balance, interest_bill, interest }]`, `interest: { upTo (today), worked, billed, due, bills[{ documentId, documentNo, from, days, owedDays, interest, periods[{ from, to, days, owed }] }] }`, `charges[{ document_id, document_no, worked_to, amount }]`, `produce[{ receipt_no, crop, quantity, unit, rate, value, notes, created_at, created_by_name, location_name }]` |
| `PUT /agri/season-credits/:id` | agri.approve | The terms as on `POST` without the customer and season, and `closed?` (true closes it to new bills; false opens it again). The due date and interest stay as they were once a bill is on it (409). Audited `season_credit.changed`, `season_credit.closed` or `season_credit.reopened` |
| `POST /agri/season-credits/:id/interest` | agri.approve and sales.create | `{ requestKey, locationId, amount (the interest due, as seen) }` → 201 `{ documentId, …detail }`: the interest due today billed through the core as a bill of the shop's interest item (*Settings › Farm input checks*) on the season, due at once, at the item's GST slab and the shop's price terms and rounding; it is never held to a credit limit, and never earns interest. 409 no interest on the season, none due, no interest item chosen (or it is switched off), the interest moved since it was seen (a payment came in), a key reused with other data. A retry returns the same bill. Audited `season_credit.interest_billed`; event `agri.interest_billed` |
| `POST /agri/season-credits/:id/produce` | receivables.create | `{ requestKey, locationId, crop, quantity (up to 3 decimals), unit (quintal, kg, bag, tonne), rate, notes? }` → 201 `{ receipt: { receipt_no, value (quantity × rate, half up to the paisa), payments[] }, …detail }`: produce taken from the farmer, numbered PR-1, PR-2… for the business, paying the season's bills oldest due first as core payments named *Produce* (method `credit_note`): no money moves, so the drawer and the day's takings do not count it. 409 worth more than is owed on the season, a key reused with other data. Audited `season_credit.produce_taken`; event `agri.produce_taken` |

**Seed lots and stock kept apart**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /agri/seed-lots` | inventory.view | Every lot of a seed item at each location: `id` (the stock lot), `location_id`, `location_name`, `sku_id`, `label`, `code`, `unit`, `lot_code`, `expires_on`, `quantity`, `in_stock`, `crop`, `variety`, `seed_class`, `seed_lot_id`, `tested_on`, `germination`, `purity`, `tag_no`, `valid_until`, `no_tag`, `retests`, `qr_codes`, `state` (`lapsed`, `expiring` within 30 days, `valid`, `no_date`); search item, code, lot, tag number, crop, variety; filters `location`, `sku`, `state`, `no_tag`, `in_stock` |
| `POST /agri/seed-lots` | inventory.edit | `{ skuId (a seed), lotCode, testedOn (today or earlier), germination, purity (% 0-100, 2 decimals), tagNo?, qrText? }` → 201 the lot's tag (below): valid until 9 months after its test, and the lot's expiry at every location (and on transfers in transit) set to it. 400 not a seed; 404 the lot has not been received; 409 its tag is kept already. Audited `seed_lot.tagged` and `stock.expiry_changed` |
| `GET /agri/seed-lots/:id` | inventory.view | The tag with `label`, `unit`, `crop`, `variety`, `seed_class`, `today`, `retests[{ tested_on, germination, purity, passed, report_no, valid_before, valid_after, notes, created_by_name }]`, `qr_codes[{ qr_text, created_by_name, created_at }]`, `held[{ location_name, quantity, expires_on }]` |
| `PUT /agri/seed-lots/:id` | inventory.edit | `{ testedOn?, germination?, purity?, tagNo? }`: the tag corrected; a new test date moves the validity. 409 the test changed after a retest. Audited `seed_lot.corrected` |
| `POST /agri/seed-lots/:id/retests` | inventory.edit | `{ requestKey, testedOn (after the last test, today or earlier), germination, purity, passed, reportNo?, notes? }` → 201 the tag: kept as entered; passed, valid 6 months longer from the date it was valid until, at every location. A retry returns the same. Audited `seed_lot.retested`; event `agri.seed_lot_retested` |
| `POST /agri/seed-lots/:id/qr-codes` | inventory.edit | `{ qrText }` → 201 the tag: a SATHI QR scanned for the lot or a pack. 409 the text is kept for a lot already. Audited `seed_lot.qr_scanned` |
| `GET /agri/kept-apart` | inventory.view | Stock kept apart: `kind` (`expired`, `seized`, `sampled`), `location_name`, `label`, `unit`, `lot_code`, `expires_on`, `quantity`, `held_on`, `officer`, `officer_reference`, `notes`, `status` (`held`, `closed`, `released`), `closed_on`, `closed_how`, `closed_reference`, `created_by_name`, `closed_by_name`; search item, lot, inspector, references, notes; filters `kind`, `status`, `location`, `sku`. Newest first |
| `POST /agri/kept-apart` | inventory.edit | `{ requestKey, kind, lotId (a stock lot), quantity, officer?, officerReference? (the inspector and their seizure receipt or sample slip: required when seized or sampled), notes? }` → 201 the entry: the quantity taken out of stock by a core stock adjustment, so none of it is sold. 400 an expired entry for a lot not past its expiry; 404 the lot; 409 more than is in stock. A retry returns the same. Audited `stock.adjusted` and `stock.kept_apart`; event `stock.adjusted` |
| `POST /agri/kept-apart/:id/close` | inventory.edit | `{ requestKey, how (closed, released), on (from the day kept apart to today), details (how it was disposed of, what came of it, or the release order), reference? }`: closed once; seized stock released goes back into its lot by a stock adjustment (400 releasing anything else). 409 closed already (the same close again answers as before). Audited `stock.hold_closed` or `stock.released` |

**Company schemes**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /agri/schemes` | purchasing.view | Schemes with `contact_id`, `supplier_name`, `name`, `season`, `season_year`, `starts_on`, `ends_on`, `active`, `notes`, `items`, `claims`, `awaited`; search name, supplier, notes; filters `supplier`, `season`, `season_year`, `active` |
| `POST /agri/schemes` | purchasing.edit | `{ contactId (a supplier), name, season, seasonYear, startsOn, endsOn (at most 400 days on), notes?, skuIds[1..100] (in one stock unit), benefits[1..30]: [{ kind (per_unit, target, free_goods, gift), minQuantity, rate (per_unit) \| amount (target) \| freeSkuId + freeQuantity (free_goods) \| gift }] }` → 201 the ledger (below). 400 items in different units, a kind twice at one quantity; 404 supplier or item not found. Audited `scheme.created` |
| `GET /agri/schemes/:id` | purchasing.view | The ledger: `scheme`, `items`, `benefits`, `unit`, `purchases[{ document_id, document_no, supplier_bill_no, day, label, quantity, paid (less free units), returned, counted, earns }]` (each receipt of its items from its supplier in its dates, on the business's clock), `bought`, `earned: { rebate, target, money, rate, freeGoods, gift }`, `next[{ kind, minQuantity, short }]`, `claims[]`, `due: { money: { earned, claimed, received, awaited, due, unclaimed }, freeGoods: { earned, claimed, received, due }, gift: { earned, claimed, received } }` |
| `PUT /agri/schemes/:id` | purchasing.edit | The terms as on `POST` and `active?`; the supplier stays (400). Audited `scheme.changed`, `scheme.switched_on` or `scheme.switched_off` |
| `POST /agri/schemes/:id/claims` | purchasing.edit | `{ kind (money, free_goods, gift), claimedOn (from the scheme's start to today), reference?, amount (money) \| quantity (free goods), description? (the gift: required) }` → 201 the ledger. Audited `scheme.claimed` |
| `POST /agri/schemes/:id/claims/:claimId/received` | purchasing.edit | `{ receivedOn, receivedAmount (money) \| receivedQuantity (free goods), receivedReference?, receivedNote? }` → the ledger: what came back, once (409 after). It keeps account only; the credit note or free goods are entered as any other |

**On the core routes**

- `POST /catalog` and `PATCH /catalog/:id` take the item's classification in `attributes` while the module is on, sent whole with `inputKind` first (`fertiliser`, `seed`, `pesticide`, `bio_input`, `other`; empty takes the item out of the farm inputs, with no other farm-input keys): `subsidised` (`yes`; a fertiliser's), `seedClass` (`certified`, `truthfully_labelled`), `seedCrop` and `seedVariety` (a seed's), `molecules` (up to 5 names; a listed molecule takes the list's spelling), `formulation`, `approvedCrops` (the crops or groups on its label, up to 30, matched to the crops' names), `household` (`yes`: a registered household insecticide), `dosePerAcre`, `safetyDays` (the waiting days before harvest, 0-365) and `ppe` (the protection to wear) (a pesticide's), `netKg` (the weight of one unit, more than 0 with up to 3 decimals). 400 another key without `inputKind`, a key of another kind, a service, or a seed or pesticide not kept by batch (Batch & expiry tracking); 400 a seed's opening stock without `expiresOn` (its validity date); 409 a banned molecule (the sentence names it and its source; the database refuses it too); 409 a molecule kept for sale only in one formulation (carbofuran: 3% CG) with another or no formulation. A change is audited `catalog.classified`, from and to.
- `POST /documents`, a sale (Quick bill, New sale and `POST /quotations/:id/bill`): `agri: { posReceipt?, crop?, seasonCreditId? | season?, seasonYear?, dueOn?, village?, overrideIds? }` and, on each line, `crop?` and `posReceipt?`. A line's own crop or receipt comes first, then the bill's. Each fertiliser, seed, pesticide and bio-input line is checked, in this order: 409 an item made of a banned molecule; 409 no licence in force covering it at the selling location today for the kind of sale (fertiliser, seed or insecticide; while module `licences` is on; a buyer with a GSTIN makes it a wholesale sale, any other a retail one), with a sentence naming the licence and what is wrong with it; 409 a pesticide not endorsed on that licence, or whose manufacturer has no principal certificate on it in force, when the shop's setting stops the bill (it warns otherwise); 409 a molecule kept for sale only in another formulation; 409 a seed lot past its validity, or another batch past its expiry; 400 a crop-restricted molecule with no crop given; 409 a crop it must not be used on, or a crop in a group it must not be used on (the crop is matched by name, other name or the shop's own crops; a crop not on the pesticide's label is billed with a warning and kept as `off_label`); 409 a restricted-use molecule for a buyer not tagged a pest-control operator or government body in force, with `data: { reason: "restricted_use", override, skuIds }` (`override` true when the shop lets a manager allow it, with an override given at `POST /agri/overrides`); 400 a subsidised fertiliser without its PoS receipt number (letters, digits, - and /, 3-40). 400 sulphur without its buyer's name and address (a walk-in's `buyer.name` and `village`, or the customer's address or village: rule 10B). A named customer's subsidised bags this month (on the business's clock, less returns) over the limit of the location's state: 409 with `data: { reason: "bag_limit", override }`, a warning from 80% of it. An override named in `overrideIds` must be of this till, today, this customer (when it names one), unused and needed (404, 409 otherwise); the bill uses it up. Also 400: a crop or receipt on a line that is not a farm input, a receipt on a fertiliser that is not subsidised or on a bill with none, a village on a named customer's bill or on a bill with no farm inputs. The season (`kharif`, `rabi`, `zaid`), its year (last year, this year or next) and the harvest due date (today up to 400 days ahead) go together, on a named customer's bill that leaves something on credit (400 otherwise): they name the customer's credit for that season, opened with that date (no limit, no interest) when there is none, and the due date must be its own (409). `seasonCreditId` names it instead (404 another customer's). 409 a credit closed or past its due date, or over its limit with this bill's unpaid part. The season's due date becomes the bill's `due_on`. A walk-in's `buyer.name` and the bill's `village` are kept with the bill. The database repeats the checks where the line is kept, but for the endorsements and principal certificates. A licence in force only while its renewal is pending, and an endorsement or certificate the shop warns about, come back in the answer's `warnings`. With the shop's advice line on, each pesticide line keeps its advice (dose, waiting days, protection) to print. The customer's tags in force are kept with the bill (`buyer_tags`). Audited `sale.farm_inputs` (with the overrides used); a subsidised fertiliser sold writes event `agri.subsidised_sale` `{ documentNo, locationId, lines[{ lineId, skuId, quantity, posReceipt }] }`.
- `POST /documents`, a purchase: a seed lot needs its validity date as `expiresOn` (400); a lot whose tag is kept (`POST /agri/seed-lots`) takes the tag's, and another date is refused (400). An insecticide other than a registered household one received at a location marked as keeping food or feed comes in with a warning (rule 10C). Fertiliser from a supplier with no certificate of source (Form O) that is on and names them, on the location's fertiliser authorisation in force (or with no authorisation in force), is received with a warning in `warnings` (while module `licences` is on).
- `GET /documents/:id` of a farm-input shop's sale: `agri: { lines[{ line_id, input_kind, subsidised, pos_receipt, crop, off_label, restricted_by, advisory }], bill: { season, season_year, buyer_name, village, season_credit_id, buyer_tags, season_due_on, bag_override (the override's reason) } | null, interest: { worked_to, amount } | null (a bill of season interest), farmer: { village, relative_name, farmer_id } | null, licences[{ kind, name, licence_no, covers }] }` (the selling location's licences in force that day, for the bill's kind of sale, for what is on the bill), or null.
- `GET /notifications` (the bell), for a role with `agri.view`: last month's Form XIV and Form D of each location that keeps such stock, until marked sent (a warning until the 15th or the 5th, then critical), and a location marked as keeping food or feed that holds insecticides (rule 10C).
- `business_price_history` (core): every price an item and a branch price had, from when, written by triggers on `catalog_skus` and `business_sku_location_prices`; the board reads a day gone by from it.

## Optical shops

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `optical`, permission). The lists take `limit` (up to 100), `offset`, `q` and their filters (prescriptions, orders and trials also `from` and `to`, on when they were made) and answer `{ total, items }`. Backend module `modules/business/optical/` (routes `businessOptical.routes.js`). Every route answers 403 while the module is off, and so for every other type of business, which never has it; the settings, the power grid and the contact-lens stock, which take a settings, catalogue or inventory permission, answer 404 for another type. Dates are the business's own (its time zone). A person tied to one location sees and changes that location's spectacle orders only (403 for another). An order's money (prices, totals, the advances, the bill, the balance) is sent only to a role with `sales.view`: for anyone else it is null, and an order says `money: false`. How it works: [BUSINESS_PLATFORM_DATA_MODEL.md › Optical shops](BUSINESS_PLATFORM_DATA_MODEL.md#optical-shops).

**Prescriptions**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /optical/prescriptions` | optical.view | Prescriptions, newest test first, with `kind` (spectacles, contact_lens), `customer_name`, `customer_phone`, `rows[{ eye, zone, sph, cyl, axis, add, prism, prism_base, prism_vertical, prism_vertical_base, acuity }]` (spectacles: right eye first; distance, intermediate, near), `lenses[{ eye, base_curve, diameter, power, cyl, axis, add, colour, brand, modality, wearing_schedule }]` (contact lenses), `registration_council`, `registration_valid_until`, `registration_lapsed` (it ran out before the test), `vertex_distance`, `age_years`, `referred_by`, `appointment_id`, `orders` (how many spectacle orders use it), `latest` (the customer's newest of its kind) and `lapsed` (past `valid_until`); search customer, phone, examiner, registration number, referring doctor, notes; filters `contact`, `examiner` (staff, outside), `latest`, `lapsed`, `kind`, `registration_lapsed` |
| `POST /optical/prescriptions` | optical.create | `{ requestKey, kind? (spectacles, the default, or contact_lens), contactId (a customer), examinedOn? (today unless given; never a day still to come), examinerKind? (staff, the default, or outside), examinerUserId? (a member; the person recording unless given) \| examinerName (outside), registrationNo? (required for outside), registrationCouncil?, registrationValidUntil? (both only with a number), ageYears? (0-120), referredBy?, appointmentId? (an eye-test booking marked done, of this customer), notes?, validUntil? (a year after the test unless given; at most five years) }` and, for spectacles, `rows (1-6): [{ eye (right, left), zone (distance, near, intermediate), sph? (plano for 0.00), cyl?, axis?, add?, prism?, prismBase? (in, out), prismVertical?, prismVerticalBase? (up, down), acuity? }], pdBinocular? (40-85 mm) \| pdRight + pdLeft (20-45 mm each), vertexDistance? (5-25 mm)`; for contact lenses, `lenses (1-2): [{ eye, baseCurve (6-10 mm), diameter (8-25 mm), power (plano for 0.00), cyl? (not 0) with axis?, add?, colour?, brand?, modality? (daily, fortnightly, monthly, quarterly, half_yearly, yearly), wearingSchedule? }]` and no PD or vertex distance → 201 the prescription as `GET` gives it, with `warnings` (a sentence) when the examiner's registration ran out before the test. Powers go in steps of 0.25: SPH, CYL and a lens's power from -30 to +30, ADD from +0.25 to +4.00 (on the near or intermediate row only, for spectacles), AXIS 1-180 with a CYL other than 0 and only then, each prism up to 20 with its base. A row or lens left empty is skipped; each eye and vision (or eye) is given once. 400 with a sentence naming the eye, the vision or lens and the field; 404 not a customer, an examiner who is not a member, or a booking not found; 409 a booking not done yet, another customer's, or with its prescription of this kind already. Same key and body → the same prescription; same key, other body → 409. Audited `prescription.recorded` (with the kind, the council, the referring doctor and the booking) |
| `GET /optical/prescriptions/:id` | optical.view | The prescription with `rows` or `lenses`, `customer_name`, `customer_phone`, `created_by_name`, `updated_by_name`, `lapsed`, `registration_lapsed`, `orders[{ id, order_no, status, created_at }]` and `locked` (a spectacle order uses it) |
| `PUT /optical/prescriptions/:id` | optical.create | A correction: the body of `POST` without `requestKey` (`contactId` left out keeps the customer; `kind` and `appointmentId` stay as they are); its rows or lenses are replaced. 400 another kind, or another customer for one from a booking; 409 once a spectacle order uses it (the sentence names the order: record a new prescription instead). Audited `prescription.corrected`, with what changed from and to; `warnings` as on `POST` |
| `GET /optical/customers/:contactId` | optical.view | `{ customer, prescriptions[] (newest first, both kinds, with rows, lenses, lapsed and orders), orders[{ id, order_no, status, prescription_id, promised_on, created_at, delivered_at, remake_of, total }], recall: { months, due_on, groups (child, contact-lens wearer, progressive wearer), reminded_at } }`: a customer's history, for the powers side by side. 404 not a customer |
| `GET /optical/examiners` | optical.view | `{ staff[{ id, name, registration_no, registration_council, registration_valid_until }], outside[{ name, registration_no, registration_council, registration_valid_until }], referrers[name] }`: the members whose role records prescriptions (with the registration on their latest prescription that names one), up to 50 outside prescribers named before, and up to 50 referring doctors named before |

**Spectacle orders**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /optical/orders` · `GET /optical/orders/open` | optical.view | Every order, newest first · the open ones, by promised day. Rows: `order_no`, `location_id`, `location_name`, `contact_id`, `customer_name`, `customer_phone`, `prescription_id`, `made_at`, `lab_name`, `lab_order_no`, `promised_on`, `status`, `stage` (open, closed), `frame`, `lenses` (their types), `remake_of`, `remake_of_no`, `remake_reason`, `remake_cost_by`, `remake_under_warranty`, `referred_by`, `quotation_id`, `total`, `advance` (the advances' amounts together), `advance_left`, `advances_taken` (how many), `balance` (an open order's total less the advances), `document_id`, `document_no`, `due_today`, `overdue`, `ready`, `advance_to_refund` (cancelled, with advance left), `frame_held`, `status_since`, `checked_at`, `delivered_at`; search number, customer, phone, lab, lab order number, frame, bill number, referring doctor; filters `status`, `stage`, `location`, `contact`, `due_today`, `overdue`, `ready`, `made_at`, `prescription`, `advance_to_refund`, `frame_held`, `quotation` |
| `GET /optical/orders/counts` | optical.view | `{ open, booked, at_lab, in_workshop, quality_check, ready, due_today, overdue }`, at the person's location when they are tied to one: the screen's chips. Due today and overdue count the orders not yet ready |
| `POST /optical/orders/preview` | optical.create (quotations.view with a quotation) | The body of `POST /optical/orders` (only `locationId`, `prescriptionId`, `frame`, `lenses`, `items`, `discount`, `remake` and `quotationId` are read) → what the item lines come to now, nothing saved: `{ taxMode, lines[{ part, eye, skuId, label, unit, quantity, unitPrice, amount, discount, net, tax, taxRate, offers[], … }], subtotal, tax, roundOff, total, savings }`, priced as `POST /quotations/preview` prices them (a quotation's lines at its prices); all 0 for a remake the shop or the lab bears |
| `POST /optical/orders` | optical.create and sales.create (sales.edit to take an advance; quotations.edit from a quotation) | `{ requestKey, locationId, prescriptionId (a spectacle prescription; its customer is the order's), frame: { skuId (goods, not a kit), description? } \| { ownFrame: true, description } \| { quotationLineId }, lenses (1-2): [{ eye, lensType? (single_vision, bifocal, progressive), skuId? (the lens item it is billed as) \| quotationLineId?, index? (1.40-2.00), material? (cr39, polycarbonate, trivex, glass, other), coatings? (anti_reflective, blue_cut, uv, photochromic, scratch_resistant), tint?, brand?, description? }], items? (up to 20): [{ skuId, quantity?, unit? }], measurements: { pdRight?, pdLeft? (20-45 mm), fittingHeightRight?, fittingHeightLeft? (5-45 mm), frameA? (20-80 mm), frameB? (10-70 mm), frameDbl? (10-30 mm) }, madeAt (in_house, lab), labName? (required at a lab), labOrderNo?, promisedOn (today up to a year ahead), referredBy? (the prescription's unless given), discount?: { amount \| percent, reason }, notes?, advance?: { amount, method (cash, card, upi, bank) \| methodId, reference? }, remake?: { orderId (a delivered order of the same customer), reason (power_change, non_adaptation, measurement, lab_defect, breakage, coating, other), costBy (shop, lab, customer), note? }, quotationId?, holdFrame? (hold the frame from stock for the order), frameLot? (its batch or serial) }` → 201 the order as `GET` gives it, numbered `SPO/…` at the location. The prescription and its powers are copied onto the order. A lens billed as an item that keeps its details (design, index, material, coatings, tint) takes them; one given that differs is refused, and a lens with no item needs its type. Each lens needs its eye's powers on the prescription and its fitting PD; a bifocal or progressive lens also its near power and fitting height. The item lines (frame, right lens, left lens, other items) are priced by the core as a sale of them would be now, and kept; from a quotation (open, valid, of this location and this customer; no other items, discount or remake), the frame and lenses are its lines of one unit each, every other line goes on the order, its prices and discount are kept and the quotation closes as booked. A remake for a lab defect or breakage within the original's lens warranty, or a peeled coating within its coating warranty, is under warranty; when the shop's rule makes such remakes free, `costBy` customer is refused. The advance (at most the total) is a numbered collection receipt for the customer, in the same transaction. A remake the shop or the lab bears comes to 0 and takes no discount or advance. 400 nothing to price (no item on the order, other than such a remake), a lens detail differing from its item's, a quotation's line of more than one unit as the frame or a lens, or a line used twice; 404 a location, prescription, item, quotation or order to remake not found; 409 the prescription a contact-lens one or its customer switched off, the order to remake not delivered or another customer's, a free remake under warranty charged to the customer, a quotation not open, expired, another location's or another customer's, or no frame free in stock to hold. Same key and body → the same order; same key, other body → 409. Audited `spectacle_order.booked` (and `collection.recorded` for the advance, `quotation.booked`); events `spectacle_order.booked`, `collection.recorded` and `quotation.booked` |
| `GET /optical/orders/:id` | optical.view | The order with `rx` (the prescription as booked, with its vertex distance), `lines[]` (each with `sku_code`, `tracking`, `in_stock` (usable stock at the order's location less what other orders hold, for goods), `tax_rate_now`, `mrp_now`, `sku_active`, and a lens's `warranty_until` and `coating_warranty_until`), `events[{ from_status, to_status, note, step, by_name, created_at }]`, `advances[{ id, collection_no, amount, method, method_name, reference, created_at, free, used, refunded, refunds[] }]` and `advance` (the advances together: `amount`, `free`, `used`, `refunded`, `collection_no` (their numbers), `refunds[]` with each refund's `collection_no`; null with none), `hold` (the frame's hold: `status` held, released or delivered, `lot_code`, `held_at`, `held_by_name`, `closed_at`, `close_reason`; null if never held), `workshop` (in the workshop: this visit's `steps[{ step, note, by_name, created_at }]`, the `next` step and `fitted`), `remakes[]`, `bill` (what an open order's bill comes to if delivered now, with each item's GST rate today: `{ subtotal, tax, round_off, total, advance, due, rate_changed }`; null when nothing is billed), `seller` (as a bill prints it), `next` (the usual next statuses), `status_since`, `overdue`, `location_name`, `document_no`, `bill_total`, `remake_of_no`, `quotation_no`, the frame's size, `referred_by`, and who booked, checked, delivered or cancelled it. 403 another location's, for a person tied to one |
| `PATCH /optical/orders/:id` | optical.edit | `{ promisedOn?, notes?, measurements? (as on booking, the frame's size included), madeAt?, labName?, labOrderNo?, referredBy? }` on an open order; what is left out stays. The lenses are checked against the fitting again. 400 a promised day gone by (other than the one it has) or over a year ahead; 409 a delivered or cancelled order. Audited `spectacle_order.updated`, from and to, and noted in the history |
| `POST /optical/orders/:id/change` | optical.manage (and sales.create) | `{ frame, lenses, items?, discount?, measurements?, reason? }` as on booking (from the catalogue; measurements left out stay) on a booked order: the lines are written again, priced by the core as at booking (0 for a remake the shop or the lab bears), the order's totals and discount replaced; a frame held for the order is released when the frame changes. Asking again with the same change changes nothing. 400 a quotation's line, or a lens detail differing from its item's; 409 an order no longer booked (gone to the lab or the workshop, or closed), or advances taken above the new total. Audited `spectacle_order.changed` (the lines and total from and to, with the reason) and evented the same; noted in the history without amounts |
| `POST /optical/orders/:id/frame-hold` | optical.edit | `{ hold: true, lotCode? }` holds one of the order's frame in a usable lot at its location with one free (the oldest expiry first unless named); `{ hold: false, reason? }` releases the hold. Asking for what is so already answers the order as it is. 400 the customer's own frame; 409 a closed order, or no frame free here to hold. Audited `spectacle_order.frame_held` / `spectacle_order.frame_released`; noted in the history |
| `POST /optical/orders/:id/advances` | optical.edit and sales.edit | `{ requestKey, amount, method (cash, card, upi, bank) \| methodId, reference? }` on an open order → 201 the order: another advance, a numbered collection receipt for the customer. 400 the advances together above the total (the sentence says how much more), or a remake the shop or the lab bears; 409 a closed order. Same key and body → the same advance; same key, other body → 409. Audited `spectacle_order.advance_taken` and `collection.recorded`; event `collection.recorded` |
| `POST /optical/orders/:id/workshop` | optical.edit | `{ step (cutting, edging, fitting), note? }` on an order in the workshop → the order: the step kept in its history (`step`) with who did it and when. A step done already on this visit is not kept again. 409 an order not in the workshop, or a step after a later one done on this visit. Audited and evented `spectacle_order.workshop_step` |
| `POST /optical/orders/:id/status` | optical.edit, or optical.approve at the quality check | `{ status (at_lab, in_workshop, quality_check, ready), note?, labName?, labOrderNo? }`: booked → at_lab or in_workshop; at_lab and in_workshop to each other or to quality_check (from the workshop, only once the fitting is done on this visit); quality_check → ready (passed) or back to at_lab or in_workshop (failed: `note` says what failed); ready → back to at_lab or in_workshop (`note` says why). Passing or failing the quality check needs `optical.approve`; every other step needs `optical.edit`. `at_lab` takes the lab's name (the order's unless given) and its order number, and the order is then made at that lab. 409 a step not allowed from the status (the sentence names both), the workshop's fitting not done, or a closed order. Audited and evented `spectacle_order.status_changed` (with `qualityCheck` passed or failed) |
| `POST /optical/orders/:id/deliver` | optical.edit, with sales.create when something is billed (sales.edit to take a payment) | `{ requestKey, payment? \| payments? (as on documents; `amount: "full"` is what is left after the advances), lines?: [{ lineId, lots: [{ lotCode, quantity }] }], buyer?: { pan?, panDeclaration? }, note? }`, only from ready → the delivered order. The item lines become a sale posted by the core at the booked prices (`fixed`), with GST at each item's rate today (a price including GST keeps its total; one before GST keeps its taxable value), from stock at the order's location (oldest expiry first unless lots are named; a held frame from its hold, which closes as delivered). The advances pay first, oldest first (a payment from each receipt); what is not paid now is left on the customer's dues. Each lens's warranty (and its coatings') is dated from today by the shop's months. An order with no item lines is delivered without a bill. 400 more paid than is left after the advances, a payment on an order with nothing billed, or a bill over ₹2,00,000 without the buyer's PAN or declaration; 404 a line that is not an item of the order; 409 not ready, an item switched off or kept for use in services, its pack size changed, its price above its MRP now, stock short, the credit limit or the cash limit passed, contact lenses without the MD-42 registration, or the bill not coming to the figure worked out. Same key and body → the same delivery; same key, other body → 409. Audited and evented `spectacle_order.delivered`; the core's `sale.posted` and `payment.recorded` |
| `POST /optical/orders/:id/cancel` | optical.cancel | `{ reason }` on an open order. A held frame goes back to stock; the advances stay the customer's: handed back from the order, or used on a later bill. Asking again returns the cancelled order; 409 a delivered one. Audited and evented `spectacle_order.cancelled` |
| `POST /optical/orders/:id/advance-refund` | sales.edit, and a manager's PIN for sales.refund | `{ requestKey, collectionId? (one of the order's advances; the oldest with money left unless given), amount? (all that is left of it), method (cash, upi, bank) \| methodId, reference?, reason, approverId?, pin? }` → 201 the refund (`refund_no` `<receipt no>-R<n>`, `left`, `order_no`, `repeated`), with `source` optical; noted in the order's history. 404 a receipt that is not an advance of the order; 409 an open order (the advances come off the bill at delivery), an order with no advance, or more than is left of it. Same key and body → the same refund; same key, other body → 409. Audited and evented `collection.refunded` |
| `POST /optical/orders/:id/messages` | optical.view | `{ channel? (whatsapp, the default, call, sms), stage? (booked, ready, delayed, reminder, update), note? }` → 201 `{ logged, note }`: a message or call to the customer, kept in the order's history; the message itself goes from the person's own WhatsApp. Audited `spectacle_order.customer_told` |

**The recall list and the shop's settings**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /optical/recall` | optical.view | Customers due for an eye test: each active customer whose latest test plus their months is today or earlier, longest due first. Rows: `contact_id`, `name`, `phone`, `prescription_id`, `kind`, `examined_on`, `valid_until`, `examiner_name`, `months` (the shop's, or the shortest of their groups'), `child`, `lens_wearer`, `progressive`, `due_on`, `days_overdue`, `prescriptions` (how many), `reminders` (how many), `reminded_at` (the last), `reminded_recently` (within 30 days), `last_order_no`; search name, phone, examiner, last order; filters `reminded` (recently), `contact`, `child`, `lens_wearer`, `progressive` |
| `POST /optical/recall/:contactId/reminders` | optical.view | `{ channel? (whatsapp, the default, call, sms) }` → 201 the reminder given (the message goes from the person's own WhatsApp, a `wa.me` link). 404 not a customer; 409 a customer with no eye test here, or without their consent to reminders. Audited `recall.reminded` |
| `GET /optical/settings` | optical.view | `{ recall_months (12 until saved), recall_months_child, recall_months_contact_lens, recall_months_progressive, lens_warranty_months, coating_warranty_months (null: none), warranty_remakes (free, charged), updated_at, updated_by_name }` |
| `PUT /optical/settings` | settings.edit | `{ recallMonths?, recallMonthsChild?, recallMonthsContactLens?, recallMonthsProgressive?, lensWarrantyMonths?, coatingWarrantyMonths? (1-60 whole months; empty is none, but for recallMonths), warrantyRemakes? (free, charged) }`; what is left out stays → the settings. 400 none given, or months outside 1-60. Audited `optical_settings.updated`, what changed from and to |

**Contact lenses**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /optical/power-grid` | catalog.create (Variants switched on; 403 otherwise) | `{ productId? (more powers for a lens product made this way) \| name, brand?, categoryId?, unit (a counted unit: box, the default, pack, each), tracking? (quantity, batch), price, taxRateId? \| taxRate, mrp?, hsnCode?, reorderLevel?, codePrefix?, modality? (daily, fortnightly, monthly, quarterly, half_yearly, yearly), lensesPerPack? (1-1000), baseCurve (7-10 mm), diameter (12-16 mm), ranges (1-4): [{ from, to (-20.00 to +20.00), step? (0.25, the default, or 0.50) }], cylinders? (up to 12, -10 to +10, not 0) with axes? (up to 36), adds? (up to 8, +0.25 to +4.00), colours? (up to 12) }` → 201 `{ product, created, items[{ id, code, label, power, cyl, axis, add, colour }] }`: one item of the product for each power with each cylinder and axis, ADD and colour given (at most 600 at a time and 2,400 a product), at one price, its code the prefix, the power and its variant (`AO6-M250`, `AO6-P125`, `AO6-000`, `AOT-M200-C075X090`, `BMF-M150-A100`, `FLC-000-GRE`), its label the name, the power and its variant (`Acuvue Oasys · -2.50`, `Air Optix for Astigmatism · -2.00 / -0.75 × 90`), and `power`, `baseCurve`, `diameter`, `cyl`, `axis`, `add`, `colour`, `modality` and `lensesPerPack` in its `attributes`. For a product made before, the powers it has are left as they are and the new ones take its unit, GST, HSN code, MRP, modality, lenses a unit and price (unless a price is given). 400 cylinders without axes (or the other way), more than 600 items; 409 the code prefix already used, every power already there, another base curve or diameter, or another kind of lens (toric, multifocal, coloured) than the product's. Audited `catalog.lens_powers_created` |
| `GET /optical/power-grid/:productId` | catalog.view (Variants on) | `?locationId?` → `{ product, base_curve, diameter, modality, lenses_per_pack, toric, multifocal, coloured, powers[{ sku_id, code, label, power, cyl, axis, add, colour, price, active, stock }] }`, lowest power first; the stock at the location, or at every location |
| `GET /optical/lens-stock` | inventory.view | `?locationId?` (the person's location when they are tied to one) → each contact-lens product made by its powers: `{ id, name, brand, active, items, base_curve, diameter, modality, toric, multifocal, coloured, stock, powers_in_stock }` |
| `GET /optical/lens-stock/:productId` | inventory.view | `?locationId?` → the product's powers as `GET /optical/power-grid/:productId` gives them, with `location_id`: the stock view. 404 a product not made by its powers |
| `GET /optical/contact-lenses/due` | optical.view | Each customer's latest bill with contact lenses that say how often they are replaced, soonest to run out first: `contact_id`, `name`, `phone`, `document_id`, `document_no`, `sold_on` (the business's day), `items`, `lenses` (kept, less those returned, × the lenses a unit holds), `days` (one lens lasts; the shortest on the bill), `due_on` (`sold_on` + lenses × days ÷ 2, whole days), `days_left`, `due` (within 14 days, or run out), `run_out`, `reminded_at` (since the bill), `reminded_recently` (within 30 days); search name, phone, bill, lens; filters `due`, `run_out`, `reminded`, `contact` |
| `POST /optical/contact-lenses/:contactId/reminders` | optical.view | `{ channel? (whatsapp, call, sms) }` → 201 the reminder that their lenses are running out (kept with the recall reminders as kind contact_lens). 404 not a customer; 409 a customer who bought no contact lenses here, or without their consent to reminders. Audited `contact_lens.reminded` |
| `GET /optical/contact-lenses/trials` | optical.view | Free trials, newest first: `contact_id`, `customer_name`, `customer_phone`, `location_name`, `sku_id`, `label`, `unit`, `lot_code`, `quantity`, `given_on`, `ends_on`, `status` (given, converted, lapsed), `document_no` (the bill it converted on), `notes`, `close_note`, `given_by_name`, `closed_by_name`, `overdue` (given and past its end); search customer, phone, lens, batch, bill, notes; filters `status`, `overdue`, `contact`, `location` |
| `POST /optical/contact-lenses/trials` | optical.create | `{ requestKey, contactId, locationId, skuId (a contact lens), lotCode?, quantity? (1 unless given), days? (1-60; 7 unless given), notes? }` → 201 the trial: the lenses taken out of stock by an adjustment (`Free trial for <name>`) from a usable lot (the batch named, or the oldest expiry first), under the location's MD-42 registration. 400 not a contact lens, days outside 1-60; 404 a customer, location or item not found; 409 no MD-42 registration in force there, or not enough usable stock. Same key and body → the same trial; same key, other body → 409. Audited `contact_lens_trial.given` and `stock.adjusted`; event `stock.adjusted`. A sale to the customer of lenses of the same product converts their open trials (audited `contact_lens_trial.converted`) |
| `POST /optical/contact-lenses/trials/:id/close` | optical.create | `{ outcome (lapsed, converted), documentId? (a sale of the customer's with contact lenses, for converted), note? }` → the trial. Asking again for the same outcome answers it as it is. 404 not found; 409 closed with another outcome, or a bill that is not the customer's with contact lenses. Audited `contact_lens_trial.lapsed` or `.converted` |

**The referral report**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /optical/referrals` | optical.view | `?from&to` (this month so far unless given; up to 367 days) → `{ from, to, money, timezone, totals: { doctors, prescriptions, contact_lens_prescriptions, orders, delivered, booked_value, billed }, rows[{ doctor, prescriptions, contact_lens_prescriptions, customers, orders, delivered, booked_value, billed }] }`: each doctor written as `referred_by` on prescriptions (by the day of the test) and spectacle orders (by the day booked, on the business's clock), the same name in any case or spacing counting once; orders not cancelled; the money (`booked_value`, `billed`) only for a role with `sales.view`, else null. 400 an end before the start, or too many days |

**On the core routes**

- `GET /notifications` (the bell), for a role with `optical.view`: each spectacle order ready to collect (info) and each open order past its promised day (warning), linking to the order.
- `POST /catalog` and `PATCH /catalog/:id` take, while the module is on, a spectacle lens's `lensDesign` (single_vision, bifocal, progressive), `lensIndex` (1.40-2.00), `lensMaterial`, `coatings` (a list) and `tint`, or a contact lens's `power`, `baseCurve` and `diameter` (together), `cyl` and `axis` (together), `add`, `colour`, `modality` and `lensesPerPack`, in `attributes`; an item is one or the other. On `PATCH` an empty one removes it, and the change is audited `catalog.lens_details_changed` (from and to). 400 a value out of range, or both kinds on one item.
- `POST /documents` (and every bill the core posts: Quick bill, quotations, a spectacle order's delivery): a sale with contact lenses (items that keep a base curve) is refused (409) without the location's MD-42 registration in force on the business's day (the sentence says why, as Licences words it); with it, each lens is checked against the named customer's contact-lens prescription in force, and a lens matching no eye of it, a customer with none, or no customer named, comes back in the bill's `warnings` (kept in its `sale.posted` audit). The customer's open trials of the products sold are converted.
- `GET /quotations` and `GET /quotations/:id`: a quotation booked as a spectacle order has `status` booked, `spectacle_order_id` and `spectacle_order_no` (the list's `order_no` is the order's number); it is never billed, ordered or cancelled after. `POST /quotations/:id/cancel` on it answers 409 (cancel the spectacle order instead).
- Number series: spectacle orders are numbered in the kind `spectacle_order` (prefix `SPO`), set per location like any other series.

## Vehicle service & auto parts

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `garage`, permission). The lists take `limit` (up to 100), `offset`, `q` and their filters (job cards also `from` and `to`, on when they were opened) and answer `{ total, items }`; a `q` typed like a plate with spaces or dashes (`ts 09 ea 4521`) is searched as the plate. Backend module `modules/business/garage/` (routes `businessGarage.routes.js`). Every route answers 403 while the module is off, and so for every other type of business, which never has it; the board and a job card, which take any member, answer 404 for another type, as do the routes that take a settings or sales permission. Dates are the business's own (its time zone). A person tied to one location sees and changes that location's job cards only (403 for another). A job card's money (prices, totals, versions' and approvals' amounts, the claim's amounts, the advance, the bills) is sent only to a role with `sales.view`: for anyone else it is null, and a job card says `money: false`. A mechanic (`garage.edit` without `garage.view`) reads only the job cards they are on: any other answers 404. How it works: [BUSINESS_PLATFORM_DATA_MODEL.md › Vehicle service & auto parts](BUSINESS_PLATFORM_DATA_MODEL.md#vehicle-service--auto-parts).

**Vehicles**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /garage/vehicles` | garage.view | Vehicles, the newest first, with `vehicle_name`, the owner (`contact_id`, `owner_name`, `owner_phone`), `odometer_km`, `next_service_on`, `next_service_km`, `insurance_expires_on`, `puc_expires_on`, `active`, `jobs`, `last_job_at` and the job card open (`open_job_no`, `open_job_status`); search plate, make and model, owner, phone, chassis and engine numbers; filters `active`, `owner`, `fuel` |
| `GET /garage/vehicles/find` | garage.view or garage.create | `?registration` (as typed; at least 4 letters and digits) → `{ registration_no, vehicle }`: the vehicle with that number (its owner, latest reading, next service, insurance and PUC, `active` and `open_job`), or `vehicle: null` |
| `POST /garage/vehicles` | garage.create (contacts.create for a new owner) | `{ registrationNo, make, model, variant?, fuel? (petrol, diesel, cng, petrol_cng, lpg, electric, hybrid), year?, chassisNo?, engineNo?, owner: { contactId } \| { name, phone? } (a new customer), odometerKm?, insuranceExpiresOn?, pucExpiresOn?, nextServiceOn?, nextServiceKm?, notes? }` → 201 the vehicle (as `GET`). 400 a number that is not a plate's; 409 a number or chassis number already on a vehicle (`data.vehicleId` names it). Audited `vehicle.added` |
| `GET /garage/vehicles/:id` | garage.view | The vehicle with `owners[]` (the newest first, with `since` and who recorded it), `readings[]` (the last 50: `reading_km`, `source`, `job_no`, `lower_reason`, `approved_by_name`), `jobs[]` (its job cards, with their bills), `reminders[]`, `open_job`, `average_km_day` and `projected_km` (the reading it has probably reached), and `money` |
| `PATCH /garage/vehicles/:id` | garage.view and garage.edit | Any of `POST`'s fields but the owner and the reading, and `active`; what is left out stays. 409 switching off a vehicle with a job card open. Audited `vehicle.updated`, from and to |
| `POST /garage/vehicles/:id/owner` | garage.view and garage.edit (contacts.create for a new owner) | `{ owner: { contactId } \| { name, phone? }, note? }` → the vehicle; the database keeps every owner. 409 the owner it already has. Audited `vehicle.owner_changed` |
| `POST /garage/vehicles/:id/odometer` | garage.view and garage.edit | `{ km, approval?: { reason, approverId?, pin? } }` → 201 the vehicle. A reading lower than the last answers 409 with `data: { reason: 'odometer_lower', lastKm, lastAt }` unless the approval is given: a role with `garage.approve` gives only the reason; anyone else names the approver and their PIN (400 a wrong PIN). Audited `odometer.recorded` (a lower reading under the approver's name) |
| `POST /garage/vehicles/:id/reminders` | garage.view | `{ kind (service, insurance, puc), channel? (whatsapp, the default, call, sms) }` → 201 the reminder given (the message goes from the person's own WhatsApp, a `wa.me` link). 400 another kind or channel. Audited `service_reminder.sent` |
| `GET /garage/customers/:contactId/statement` | garage.view | `?from&to` → `{ customer, from, to, vehicles[{ registration_no, vehicle_name, owned_now, jobs[{ job_no, created_at, odometer_in, complaints, document_no, insurer_document_no, billed, due, … }], billed }], jobs, billed, paid, due, seller, money }`: the customer's vehicles (those they own and any other they had serviced) with their job cards. 404 not a customer |
| `GET /garage/approvers` | garage.create, garage.edit or sales.edit | `?permission` (`garage.approve`, the default, or `sales.refund`) → `[{ id, name, has_pin }]`: the members who may approve a lower reading, or an advance handed back. 400 another permission |
| `GET /garage/mechanics` | garage.view | `[{ id, name, role_name, template_code }]`: the active members whose role works on job cards (mechanics first) |

**Job cards**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /garage/job-cards` | garage.view | Every job card, the newest first: `job_no`, `location_name`, `vehicle_id`, `registration_no`, `vehicle_name`, `contact_id`, `customer_name`, `customer_phone`, `status`, `stage` (open, closed), `promised_at`, `overdue`, `status_since`, `bay`, `odometer_in`, `complaints`, `mechanics`, `estimate_version`, `approved_version`, `total`, the claim (`claim_mode`, `claim_no`, `insurer_name`), the bills (`document_no`, `bill_total`, `insurer_document_no`, `insurer_bill_total`), `advance`, `advance_left`, `advance_to_refund`; search number, plate, vehicle, customer, phone, bills, claim number, insurer and mechanics; filters `status`, `stage`, `location`, `vehicle`, `contact`, `overdue`, `claim`, `advance_to_refund` |
| `GET /garage/job-cards/board` | garage.view or garage.edit | `{ items[] (the open job cards as in the list, with work: { lines, done }), counts: { received, estimate_sent, approved, in_progress, waiting_parts, ready, open, overdue }, mine }`, by promised time, at the person's location when they work at one; a mechanic's own job cards only (`mine: true`) |
| `POST /garage/job-cards` | garage.create (garage.edit to name mechanics, sales.edit to take an advance, garage.approve or a manager's PIN for a lower reading) | `{ requestKey, locationId, vehicleId, contactId? (who pays; the owner unless given), odometerKm?, odometerApproval?: { reason, approverId?, pin? }, fuelLevel? (empty, quarter, half, three_quarters, full), complaints (1-20, up to 200 characters each), inspectionNotes?, bay?, promisedAt? (within a year), mechanicIds? (up to 10, members whose role works on job cards), notes?, advance?: { amount, method (cash, upi, card, bank) \| methodId, reference? } }` → 201 the job card, received, numbered in the series kind `job_card` (`JC/2627/0001`); the advance is a collection receipt in the customer's name; the reading in goes into the vehicle's log. A retry with the same key returns it. 409 a vehicle switched off. Audited and evented `job_card.opened` |
| `GET /garage/job-cards/:id` | garage.view or garage.edit | The job card with `vehicle`, `lines[]` (each with `kind`, `payer`, the item's figures, `description`, `vendor_name`, `vendor_bill_no`, `done`, `done_by_name`, `in_stock` (usable stock at its location, for parts), `tracking`, `tax_rate_now`, `mrp_now`), `mechanics[]`, `versions[]` (every version with its lines), `approvals[]`, `approval` (the latest), `claim`, `events[]` (the history), `advance` (`{ collection_no, amount, used, refunded, free, refunds[] }` or null), `bill` (what billing would post today: the job's `subtotal`, `tax`, `round_off`, `total`, `insurer` and `customer` figures, `advance`, `due`, `claim` (`insurer_lines`, `approved_amount`, `owner_share`, `deductible`, `depreciation`, `not_allowed`), `problem` (why it cannot be billed yet) and `rate_changed`), `work: { lines, done }`, `next` (the steps this person may take), `status_since`, `seller` and `money` |
| `PATCH /garage/job-cards/:id` | garage.view and garage.edit | `{ complaints?, inspectionNotes?, bay?, promisedAt?, fuelLevel?, notes? }` on an open job card; what is left out stays. Audited `job_card.updated`, from and to |
| `PUT /garage/job-cards/:id/mechanics` | garage.view and garage.edit | `{ userIds: [..] }` (none is allowed): the mechanics working on it now. Audited `job_card.mechanics_changed` |
| `POST /garage/job-cards/:id/estimate/preview` | garage.view, garage.edit and sales.create | `{ lines }` as `PUT …/estimate` → what they come to, nothing saved: `{ taxMode, subtotal, tax, round_off, total, insurer_lines, lines[{ lineId, kind, skuId, label, unit, quantity, unitPrice, amount, net, tax, taxRate, payer }] }` |
| `PUT /garage/job-cards/:id/estimate` | garage.view, garage.edit and sales.create | `{ requestKey, lines (1-100): [{ lineId? (a line kept), kind (part, labour, sublet), skuId, quantity, unitPrice? (the customer's price for the item unless given; required for sublet), payer? (customer, or insurer on a job card with a claim), description?, vendorName? (required for sublet), vendorBillNo? }], note? }`: the estimate as it is to be (a line left out is taken off) → the job card. A change is a new version; a version above what the owner last approved puts the job card back at `estimate_sent`. 403 a part below its price without `sales.discount`; 409 a part above its MRP, an item switched off, or prices since moved between GST included and not. Audited and evented `job_card.estimate_revised` |
| `POST /garage/job-cards/:id/parts` | garage.edit | `{ requestKey, parts (1-20): [{ skuId (goods), quantity, description? }], note? }` → 201 the job card: the parts a mechanic used, added at the customer's price as a new version (back to the owner when above their approval). 409 while the estimate waits for the owner. Audited and evented `job_card.estimate_revised` |
| `POST /garage/job-cards/:id/work` | garage.edit | `{ lines: [{ lineId, done }], note? }` → the job card: each line ticked done or not, with who and when. Audited `job_card.work_recorded` |
| `POST /garage/job-cards/:id/status` | garage.edit (garage.view too for estimate_sent) | `{ status (estimate_sent, in_progress, waiting_parts, ready), note? (required from ready) }` → the job card, as `next` allows: received → estimate_sent (with an estimate), in_progress, waiting_parts or ready; approved → in_progress, waiting_parts or ready; in_progress and waiting_parts → each other or ready; ready → back to in_progress or waiting_parts. 409 another move (an estimate sent waits for the owner's approval). Audited and evented `job_card.status_changed` |
| `POST /garage/job-cards/:id/approvals` | garage.view and garage.edit | `{ requestKey, approvedBy, channel (in_person, phone, whatsapp), approvedAt? (now unless given; never in the future), note? }` → 201 the job card: the owner's approval of the estimate as it stands, for its total; a received job card or an estimate sent becomes approved. A retry with the same key returns it. 409 no estimate yet, or this version approved already; 400 a time before the estimate was saved. Audited and evented `job_card.estimate_approved` |
| `PUT /garage/job-cards/:id/claim` | garage.view and garage.edit | `{ insurerId (a customer, not the job card's own), mode (cashless, reimbursement), policyNo, claimNo?, surveyorName?, surveyorPhone?, approvedAmount? (more than 0; whole rupees where the business rounds to the rupee), deductible?, depreciation? }` → the job card. An amount left out keeps what it was. 400 an approved amount (or with the deductible and depreciation) above the insurer's lines. Audited `job_card.claim_recorded` or `job_card.claim_changed` (with what it was) |
| `DELETE /garage/job-cards/:id/claim` | garage.view and garage.edit | → the job card: the insurer's lines become the customer's (a new version, `source` claim) and the claim is taken off. 404 no claim. Audited `job_card.claim_removed` |
| `POST /garage/job-cards/:id/advance` | garage.view, garage.edit and sales.edit | `{ requestKey, amount (at most the job's total once there is an estimate), method (cash, upi, card, bank) \| methodId, reference? }` → 201 the job card with its advance, a collection receipt. 409 one already taken. Audited and evented `collection.recorded` |
| `POST /garage/job-cards/:id/bill` | garage.view and garage.edit, with sales.create when there are lines (sales.edit to take a payment) | `{ requestKey, payment? \| payments? (as on documents; `amount: "full"` is what is left after the advance), lines?: [{ lineId, lots: [{ lotCode, quantity }] } \| { lineId, serials: [..] }], buyer?: { pan?, panDeclaration? }, odometerOutKm?, odometerApproval?, nextServiceOn? (empty for none), nextServiceKm? (empty for none), note? }`, only from ready → the delivered job card. The lines are posted through the core at the job card's prices with GST at each item's rate of the day: one sale to the customer; or, for a cashless claim, a sale to the insurer for exactly the approved amount and a sale to the customer for the rest (their lines and the owner's share as one line of the claim-share item), adding up to the job's total to the paisa. Parts leave stock now (409 one not in usable stock at the job card's location). The advance pays the customer's sale first. The reading out goes into the log, and the next service (the garage's months and kilometres after this job unless given) is set on the vehicle; a job card with nothing on it is delivered with no bill and leaves the vehicle's next service as it was, unless one is given. A retry with the same key returns the same bills; the same key with other data is 409. 409 a claim not ready to bill (the `problem` says why). Audited and evented `job_card.billed` |
| `POST /garage/job-cards/:id/cancel` | garage.cancel | `{ reason }` on an open job card. Nothing is billed and nothing leaves stock; the advance stays the customer's. Asking again returns the cancelled job card; 409 a delivered one. Audited and evented `job_card.cancelled` |
| `POST /garage/job-cards/:id/advance-refund` | garage.view and sales.edit, and a manager's PIN for sales.refund | `{ requestKey, amount? (all that is left), method (cash, upi, bank) \| methodId, reference?, reason, approverId?, pin? }` → 201 the refund (`refund_no` `<receipt no>-R<n>`), with `source` garage; noted in the job card's history. 409 an open job card (the advance comes off the bill). Audited `collection.refunded` |
| `POST /garage/job-cards/:id/messages` | garage.view | `{ channel? (whatsapp, the default, call, sms), stage? (received, estimate, ready, delayed, reminder, update), note? }` → 201 `{ logged, note }`: a message or call to the customer, kept in the history; the message itself goes from the person's own WhatsApp. Audited `job_card.customer_told` |

**Service due and settings**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /garage/service-due` | garage.view | One row per vehicle and reason, the soonest first: `kind` (service, insurance, puc), `vehicle_id`, `registration_no`, `vehicle_name`, the owner (`contact_id`, `owner_name`, `owner_phone`), `odometer_km`, `average_km_day`, `projected_km`, `next_service_on`, `next_service_km`, `due_by`, `days_left`, `reminded_at`, `reminders`, `reminded_recently` (in the last 30 days), `last_job_no`, `in_workshop`. A service is due within 7 days by its date or by the day the vehicle's kilometres a day take it to the reading due; insurance and PUC within 30 days or past. Filters `kind`, `reminded`, `owner`, `in_workshop` |
| `GET /garage/settings` | garage.view | `{ service_months, service_km (6 and 5,000 until saved), claim_share_sku_id, claim_share (the item: label, code, unit, tax_rate, hsn_code, active, kind, internal_use), updated_at, updated_by_name }` |
| `PUT /garage/settings` | settings.edit | `{ serviceMonths (1-36), serviceKm (500-100,000), claimShareSkuId? (a service item in use; empty for none) }` → the settings. Audited `garage_settings.updated`, from and to |

**On the core routes**

- `GET /notifications` (the bell), for a role with `garage.view`: each job card ready to deliver (info) and each open job card past its promised time (warning), linking to the job card.
- Number series: job cards are numbered in the kind `job_card` (prefix `JC`), set per location like any other series.

## Gyms, studios & coaching

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `member_plans`, permission). The lists take `limit` (up to 100), `offset`, `q` and their filters (memberships and check-ins also `from` and `to`, on when they were made) and answer `{ total, items }`. Backend module `modules/business/memberships/` (routes `businessMemberships.routes.js`). Every route answers 403 while the module is off, and so for every other type of business, which never has it; the settings' `PUT` (a settings permission) answers 404 for another type. Dates are the business's own (its time zone): a membership's status, the days left, the day of a check-in. Money (prices, bills, dues, credits, refunds, instalment amounts) is sent only to a role with `sales.view`: for anyone else it is null, and a membership or a member's page says `money: false`. Each posting takes a `requestKey`; a retry with the same key and body returns the first answer, and the same key with another body answers 409. How it works: [BUSINESS_PLATFORM_DATA_MODEL.md › Gyms, studios & coaching](BUSINESS_PLATFORM_DATA_MODEL.md#gyms-studios--coaching).

**Plans and the check-in rule**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /member-plans/plans` | member_plans.view | Plans, those sold first, by name: the plan's fields with its item (`item_label`, `item_code`, `price`, `tax_rate`, `tax_rate_id`, `hsn_code`, `item_active`), the joining fee (`joining_label`, `joining_code`, `joining_price`, `joining_tax_rate`), `policy` (the current version's text) and `running` (memberships not closed and not over); search name, item and joining fee; filters `active`, `kind` |
| `POST /member-plans/plans` | member_plans.edit (catalog.create for a new item) | `{ name, kind (duration, sessions, both), durationUnit (days, months) and duration (not for sessions), sessions (not for duration), item: { price, taxRateId, hsnCode? } (a new service item named as the plan, code PLAN-001…) \| { skuId } (an existing service), joiningSkuId?, maxFreezes?, maxFreezeDays? (both or neither; none on a pack of sessions), graceDays? (0-90), transferable?, policy (the refund policy, up to 4,000 characters) }` → 201 the plan (as `GET /:id`). 409 an item already a plan's or a joining fee's; 400 a goods item or a kit. Audited `member_plan.created` |
| `GET /member-plans/plans/:id` | member_plans.view | The plan, with `term` ("1 month", "8 sessions in 60 days") and `policies[]` (every version, the newest first, with who wrote it) |
| `PUT /member-plans/plans/:id` | member_plans.edit (catalog.edit to change the item) | `POST`'s terms again, `joiningSkuId` (null: none), `active`, and `price`, `taxRateId`, `hsnCode` to change the plan's item; `{ active }` alone switches it on or off. A changed policy is written as the next version. Memberships sold keep their terms. Audited `member_plan.updated` (from and to, and the policy version) |
| `GET /member-plans/settings` | member_plans.view | `{ duesBlockDays (null: never), updatedAt }`; 7 until saved |
| `PUT /member-plans/settings` | settings.edit | `{ duesBlockDays: 0-365 \| null }` → the settings. Audited `member_settings.updated` |
| `GET /member-plans/approvers` | member_plans.cancel or member_plans.approve | `[{ id, name, has_pin }]`: the members who may approve what a cancellation gives back |
| `GET /member-plans/counts` | member_plans.view | `{ active, frozen, upcoming, in_grace, ending_7, ending_15, ended_30, checkins_today, refused_today, instalments_overdue, fees_overdue }` (fees only with `sales.view`) |

**Members and memberships**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /member-plans/members` | member_plans.view | Members (customers with a member code) with their current membership (running first, a plan by time before a pack, the one ending first; then the one that ended last): `contact_id`, `name`, `phone`, `member_code`, `member_since`, `membership_id`, `membership_no`, `plan_name`, `kind`, `status`, `in_grace`, `start_on`, `end_on`, `grace_until`, `days_left`, `sessions_left`, `sessions_total`, `running`, `dues`, `last_checkin_at`; search name, phone, code, membership number and plan; filters `status`, `plan`, `active` |
| `GET /member-plans/members/:contactId` | member_plans.view | `{ member (with member_code, member_since, dues), memberships[] (each as GET /memberships/:id, the current ones first), checkins[] (the last 30), money }`. 404 not a customer |
| `PUT /member-plans/members/:contactId/code` | member_plans.edit | `{ code }` (2-20 letters, digits and dashes, any case) → the member's code. 409 another member's code; 404 no code yet (one comes with the first membership). Audited `member.code_changed` |
| `GET /member-plans/memberships` | member_plans.view | Every membership, the newest first: `membership_no`, `location_name`, the member (`contact_id`, `member_name`, `member_phone`, `member_code`), the plan and terms (`plan_id`, `plan_name`, `kind`, `duration_unit`, `duration`, `sessions_total`, `sessions_used`, `sessions_left`, `price`, `joining_fee`, `tax_rate`, `grace_days`), `start_on`, `base_end_on`, `frozen_days`, `end_on`, `grace_until`, `days_left`, `status` (upcoming, active, frozen, expired, used_up, cancelled, transferred, upgraded), `in_grace`, `stage` (running, ended), `closed`, `closed_on`, `renewal_of`, `upgraded_from`, `transferred_from`, `document_id`, `document_no`, `bill_due`, `credit`, `refunded`, `renewed_by_no`, `last_checkin_at`; search number, member, phone, code, plan and bill; filters `status`, `stage`, `plan`, `contact`, `location`, `kind` |
| `POST /member-plans/memberships/preview` | member_plans.create | `POST`'s body without the payments → the bill as it would be posted (`lines`, `subtotal`, `tax`, `roundOff`, `total`, …), `startOn`, `endOn`, `sessions`, `joiningFee` (whether it would be billed), `term`, `renewalOf` and `today`; nothing is saved |
| `POST /member-plans/memberships` | member_plans.create and sales.create (sales.edit to take payment, contacts.create for a new member, sales.discount for a discount) | `{ requestKey, locationId, planId, contactId \| member: { name, phone?, email? }, startOn? (today or later, within 180 days; a renewal's is its own), renewalOf? (the membership renewed: it starts the day after that one ends, or today once its grace days are past), joiningFee? (with a member's first membership unless false), discount?: { amount \| percent, reason }, payment? \| payments?, instalments?: [{ dueOn, amount }] (2-36, each after the one before, adding up to the bill), notes?, buyer?: { pan?, panDeclaration? } }` → 201 the membership, numbered in the series kind `membership` (`MS/2627/0001`), its bill posted by the core (the bill falls due on the last instalment); a member's first membership gives them a code (M0001). 409 an overlap with a membership of the same plan (`data: { reason: 'overlap', membershipNo }`), a membership already renewed, instalments not adding up (`data: { reason: 'instalments_total', billTotal }`), a plan or its item switched off. Audited and evented `membership.sold` or `membership.renewed` |
| `GET /member-plans/memberships/:id` | member_plans.view | The membership (as in the list) with `price_net`, `price_tax`, `policy_version` and `policy` (its text), `max_freezes`, `max_freeze_days`, `freeze_left: { freezes, days }`, `transferable`, `term`, `close_reason`, `closed_by_name`, `closed_at`, `return_no`, `approved_by_name`, `source_no` (what it renews, upgrades or carries on), `followed_by[]` (its renewal, upgrade or transfer), `freezes[]` (with `current` and `ahead`), `events[]`, `instalments[]` (`seq`, `due_on`, `amount`, `covered`, `status`: paid, part_paid, due, overdue; `days_overdue`), `bill` (`document_no`, `total`, `due_on`, `due`; none for a transfer), `reminders[]`, `today` and `money` |
| `POST /member-plans/memberships/:id/freeze` | member_plans.edit | `{ requestKey, startsOn? (today, the default, or within 60 days), days, reason? }` → 201 the membership, its last day moved on. 409 a membership not running, a pack with no end date, a plan with no freezes, the freezes or days used up, one followed by its renewal; the database refuses an overlap or a start outside its days. Audited and evented `membership.frozen` |
| `POST /member-plans/memberships/:id/unfreeze` | member_plans.edit | `{ freezeId? (the freeze now, or the next) }` → the membership: the freeze ends today, counting the days up to today, or is called off when still to come; asking again is the same. Audited and evented `membership.unfrozen` |
| `POST /member-plans/memberships/:id/transfer` | member_plans.edit (contacts.create for a new member) | `{ requestKey, toContactId \| toMember: { name, phone?, email? }, reason? }` → 201 the other member's membership (from today, to the same last day, with the sessions and freezes left, on the same bill). 409 a plan that is not passed on, a membership frozen, with a freeze to come, not running, or with something left to pay on its bill; the same member; an overlap with their own of the plan. Audited and evented `membership.transferred` |
| `POST /member-plans/memberships/:id/upgrade/preview` | member_plans.edit | `{ planId, locationId?, discount? }` → `{ lastDay, used, left, whole, by (days, sessions), price, credit, creditNote, paidBefore, dueBefore, creditApplied, plan, startOn, endOn, sessions, newSubtotal, newTax, newRoundOff, newTotal, due, newLines }`, worked out by the upgrade itself and rolled back |
| `POST /member-plans/memberships/:id/upgrade` | member_plans.edit and sales.create (sales.edit to take payment) | `{ requestKey, planId, locationId? (the membership's), discount?, payment? \| payments? (for what is due after the credit), instalments?, notes?, buyer? }` → 201 the new membership, from today. The old one is closed as upgraded (its last day yesterday); the part not used is a credit note on its bill, and what was paid beyond what is now due pays the new bill first (by credit note, both ways). 409 a credit bigger than the new plan's bill (`data: { reason: 'credit_exceeds_plan', credit, newTotal }`), a membership passed on by another member, the same plan, one not running. Audited and evented `membership.upgraded` |
| `POST /member-plans/memberships/:id/cancel/preview` | member_plans.cancel | `{ credit?, joiningFee? }` → `{ lastDay, used, left, whole, by, price, most (the part not used), planCredit, joiningFee, creditNote, paid, dueBefore, refund (what goes back), stillDue, transferred }`, worked out by the cancellation itself and rolled back |
| `POST /member-plans/memberships/:id/cancel` | member_plans.cancel (member_plans.refund when anything comes back) | `{ requestKey, reason, credit? (the plan's part given back, at most the part not used, which is the default), joiningFee? (give it back in full), refund?: { method (cash, card, upi, bank) \| methodId }, approval?: { approverId?, pin } }` → the membership, cancelled. Anything given back is a credit note on its bill and needs a manager's approval (a role with `member_plans.approve`, and their PIN; 400 `data.reason: 'approval_needed'` without it, 400 a wrong PIN); what was paid beyond what is then due is refunded by the core (400 `data.reason: 'refund_method'` without the method). 400 more than the part not used; 409 a membership not running. Audited `membership.cancelled` under the approver, evented |
| `POST /member-plans/memberships/:id/reminders` | member_plans.view | `{ kind (renewal, the default, or fees), channel? (whatsapp, the default, call, sms) }` → 201 the reminder given (the message goes from the person's own WhatsApp, a `wa.me` link). Audited `member.reminded` |

**The desk, renewals and fees**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /member-plans/check-ins` | member_plans.create | `{ requestKey, locationId, contactId \| code (any case), membershipId? }` → 201 `{ id, day, allowed, reason (no_membership, not_started, expired, frozen, no_sessions, dues), note, words (why not, in a sentence), session_used, sessions_left, member_name, member_code, membership_no, plan_name, start_on, end_on, again_today, first_today_at, fees_overdue (with sales.view), others[] (the member's other memberships that would let them in) }`. 404 an unknown code (`data.reason: 'unknown_code'`) or another member's membership. Audited `member.checked_in` or `member.checkin_refused`; a session used is evented `membership.session_used` |
| `GET /member-plans/check-ins` | member_plans.view | Check-ins, the newest first (`from` = `to` = today for the day's): `day`, `created_at`, `location_name`, the member (`contact_id`, `member_name`, `member_phone`, `member_code`), `membership_no`, `plan_name`, `allowed`, `reason`, `note`, `session_used`, `sessions_left`, `found_by`, `by_name`; search member, phone, code, number and plan; filters `allowed`, `reason`, `location`, `contact`, `membership`, `day` |
| `GET /member-plans/renewals` | member_plans.view | Memberships not closed, not renewed and with nothing else running after them, ending in the next 15 days or ended in the last 30 (as in the memberships list), with `soon_7`, `soon_15`, `ended_30`, `last_reminded_at` and `reminders`; ending soonest first, then those ended; filters `soon7`, `soon15`, `ended`, `plan`, `location` |
| `GET /member-plans/instalments` | member_plans.view and sales.view | Each instalment of a membership not cancelled or upgraded: `membership_id`, `seq`, `instalments` (how many), `due_on`, `amount`, `covered`, `left_to_pay`, `status` (paid, part_paid, due, overdue), `overdue`, `due_soon` (within 7 days), `open`, `days_overdue`, the member, `membership_no`, `plan_name`, `document_id`, `document_no`, `location_id`, `last_reminded_at`; by due day; filters `status`, `overdue`, `due_soon`, `open`, `contact`, `membership`, `location` |

An instalment is collected with the shared receivables' `POST /collections` (`allocations` naming the membership's bill), or as a payment on the bill.

- `GET /notifications` (the bell), for a role with `member_plans.view`: each membership ending in the next three days (info) or in its grace days (warning), linking to Renewals; and, for a role with `sales.view`, each instalment overdue (warning; critical after 30 days).
- `POST /documents` refuses a plan's item on any other sale (409 "… is a membership plan: sell it from the Members screen …"), and `POST /documents/:id/returns` a line that sold a membership (409: it is credited only when the membership is cancelled or upgraded).

## Laundry & dry cleaning

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `laundry`, permission). The lists take `limit` (up to 100), `offset`, `q` and their filters (`from` and `to` on when the order was taken in, the garment taken in or the claim reported) and answer `{ total, items }`. Backend module `modules/business/laundry/` (routes `businessLaundry.routes.js`). A route that needs a `laundry.*` permission answers 403 while the module is off, and so for every other type of business, which never has it; the price list's services, garments and prices (a catalogue permission), the settings' `PUT` (a settings permission) and the approvers answer 404 for another type. Dates are the business's own (its time zone): today, the promised day, late, due today and the days ready. Money (prices, totals, bills, dues, the advance, credits and refunds) is sent only to a role with `sales.view`: for anyone else it is null, and an order says `money: false`. Each posting takes a `requestKey`; a retry with the same key and body returns the first answer, and the same key with another body answers 409. How it works: [BUSINESS_PLATFORM_DATA_MODEL.md › Laundry & dry cleaning](BUSINESS_PLATFORM_DATA_MODEL.md#laundry--dry-cleaning).

**The price list and the settings**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /laundry/price-list` | laundry.view | `{ services[], garments[], prices[], settings }`: each service with its item (`sku_id`, `name`, `item_code`, `tax_rate`, `tax_rate_id`, `hsn_code`, `unit`, `item_active`), `sort_order`, `active` and how many `prices`; each garment (`name`, `counted_as`, `pieces`, `sort_order`, `active`, `prices`); each price (`garment_type_id`, `service_id`, `per`, `price`, `updated_at`, `updated_by_name`); the settings as `GET /laundry/settings`. Those in use first |
| `POST /laundry/services` | catalog.edit | `{ skuId }` (an existing service item) or `{ item: { name, taxRateId? (the business's default slab), hsnCode? } }` (a new service item named as the service, code `LND-01`…, unit service, its own price nil), `sortOrder?` → 201 the price list. 404 an item not found; 400 goods or a kit; 409 an item already a service. Audited `laundry_service.created` |
| `PUT /laundry/services/:id` | catalog.edit | `{ active?, sortOrder? }` → the price list. Audited `laundry_service.updated` (from and to) |
| `POST /laundry/garments` | catalog.edit | `{ name, countedAs (piece, pair, set), pieces (2-20, a set's), sortOrder? }` → 201 the price list. 409 a name already on the list (any case). Audited `laundry_garment.created` |
| `PUT /laundry/garments/:id` | catalog.edit | `{ name?, countedAs?, pieces?, sortOrder?, active? }` → the price list; orders keep the garment as it was taken in. Audited `laundry_garment.updated` (from and to) |
| `PUT /laundry/prices` | catalog.edit | `{ prices: [{ garmentTypeId, serviceId, per (item, kg), price }] }` (1 to 500, each garment and service once; a `price` of null or `""` takes it off the list) → the price list. Orders keep the prices they were taken in at. Audited `laundry_price.changed` (from and to) for each change |
| `GET /laundry/settings` | laundry.view | `{ billAt (delivery, intake), partDelivery (whole_order, garments), expressPercent, readyDays, expressDays, unclaimedDays, receiptTerms, updatedAt }`; delivery, whole_order, 0, 3, 1 and 30 until saved |
| `PUT /laundry/settings` | settings.edit | Any of `GET`'s fields (`expressPercent` 0-200, the days 0-60, `unclaimedDays` 1-365, `receiptTerms` up to 2,000 characters); what is left out stays → the settings. 400 express days more than the days to the promised day. Orders keep the rules they were taken in under. Audited `laundry_settings.updated` (from and to) |

**Garment orders**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /laundry/orders` | laundry.view | Every order, the newest first: `order_no`, `location_id`, `location_name`, the customer (`contact_id`, `customer_name`, `customer_phone`), `promised_on`, `express`, `bill_at`, `part_delivery`, `total`, `created_at`, `status` (received, in_process, part_ready, ready, part_delivered, delivered, cancelled), `stage` (open, closed), `overdue`, `due_today`, `unclaimed`, the counts (`items`, `pieces`, `open_items`, `process_items`, `ready_items`, `delivered_items`, `cancelled_items`, `ready_pieces`), `ready_since`, `days_ready`, `racks`, `tags`, `garments`, `billed`, `due`, `unbilled`, `advance`, `advance_left`, `balance` (what is still to pay), `reminders`, `last_notice_at`, `claim_open`; search order, customer, phone, tags, garments and racks; filters `status`, `stage`, `location`, `contact`, `overdue`, `due_today`, `unclaimed`, `express`, `claim_open`, `bill_at` |
| `GET /laundry/orders/open` | laundry.view | The orders with a garment in the shop, as above, by promised day |
| `GET /laundry/orders/counts` | laundry.view | `{ open, received, in_process, part_ready, ready, part_delivered, due_today, overdue, unclaimed, express, claim_open, ready_pieces }` (the person's own location when they are tied to one) |
| `POST /laundry/orders/preview` | laundry.create | `{ locationId, express?, items }` (as `POST`) → `{ taxMode, billAt, partDelivery, expressPercent, promisedOn (suggested from the days set), today, items[] (garmentName, serviceName, countedAs, per, rate, quantity, pieces, taxRate, base, surcharge, amount, net, tax), subtotal, tax, round_off, total, pieces }`; nothing is saved. Errors as `POST` |
| `POST /laundry/orders` | laundry.create; sales.create when billed at intake; sales.edit for an advance or a payment; contacts.create for a new customer | `{ requestKey, locationId, contactId \| customer: { name, phone? }, promisedOn (today to 90 days ahead), express?, notes?, items: [{ garmentTypeId, serviceId, quantity? (how many, 1 by default; the kilos, to three places, by the kilo), pieces? (required by the kilo), tagNo?, colour?, brand?, defects? (stain, tear, hole, missing_button, colour_bleed, fading, shrinkage, burn, worn, loose_thread), defectNote?, instructions?, riskNote?, acknowledged?, declaredValue? }] (1 to 200), advance?: { amount, method (cash, card, upi, bank) \| methodId, reference? } (billed at delivery), payment? \| payments? (billed at intake, as on documents), buyer?: { pan?, panDeclaration? } }` → 201 the order (as `GET /:id`), numbered in the series kind `laundry_order` (`LO/2627/0001`). Each garment takes the next tag unless one is typed. Billed at intake, its bill is posted by the core (one line a garment). 400 no garments, a promised day passed or too far, both or neither customer, a payment on an order billed at delivery or an advance on one billed at intake, an advance above the order's total, a tag on two garments, acknowledged with nothing noted, a bundle by the kilo without its weight or pieces; 404 a garment, service or customer not found; 409 a tag on a garment of an order still in the shop, a garment or service switched off, an item switched off or kept for use in services, no price for a garment and service, the bill not coming to the order's total. Audited and evented `laundry_order.taken_in` (with `collection.recorded` for an advance, and the core's `sale.posted`) |
| `GET /laundry/orders/:id` | laundry.view | The order: its fields (`terms`, `notes`, `tax_mode`, `subtotal`, `tax`, `round_off`, `total`, `express_percent`, `advance_collection_id`, `document_id`, `created_by_name`), `status`, `items[]` (each garment's fields with `tax_rate_now`, `document_no`, `credited`, `claims`, `claim_open`, `ready_by_name`, `delivered_by_name`, `cancelled_by_name`), `events[]`, `deliveries[]` (`document_no`, `total`, `on_account`, `collected_by`, `note`, `tags`, `by_name`), `claims[]`, `notices[]` (the last 20), `bills[]` (`document_no`, `total`, `due_on`, `returned`, `paid`, `refunded`, `due`), `advance` (`collection_no`, `amount`, `method`, `used`, `refunded`, `free`, `refunds[]`), `bill` (what the garments not billed yet would come to today: `subtotal`, `tax`, `round_off`, `total`, `advance`, `due`, `rate_changed`), `paid`, `due`, `counts`, `has_account`, `credit_days`, `credit_limit`, `today`, `unclaimed_days`, `seller` and `money`. 404 another business's or another location's order |
| `PATCH /laundry/orders/:id` | laundry.edit | `{ promisedOn?, notes? }` → the order. 400 a day passed or more than 90 days ahead; 409 nothing left in the shop. Audited `laundry_order.updated` (from and to) |
| `POST /laundry/orders/:id/status` | laundry.edit | `{ status (in_process, ready), itemIds?, rack?, note? }` → the order. Into the work: the received garments, or those named (a ready one with the `note` why); ready: the received and in-process ones, or those named, on the `rack` given. 400 a rack when not going to ready, a ready garment sent back without a note; 409 no garment can take the step, a garment named that cannot. Audited and evented `laundry_order.garments_moved` |
| `PATCH /laundry/orders/:id/items/:itemId` | laundry.edit | `{ tagNo?, rack? }`: a garment in the shop re-tagged, or a ready one moved to another rack (an empty rack takes it off) → the order. 409 a tag on another garment in the shop, a garment no longer in the shop, a rack for a garment not ready. Audited `laundry_order.garment_updated` |
| `POST /laundry/orders/:id/deliver` | laundry.edit; sales.create when it bills; sales.edit to take a payment | `{ requestKey, itemIds? (every ready garment), payment? \| payments? (as on documents; `amount: "full"` is all that is left after the advance), onAccount?, collectedBy?, note?, buyer?: { pan?, panDeclaration? } }` → the order. Billed at delivery, the bill of the garments it bills (the order's still in the shop and not billed when the whole order is paid first; those handed over otherwise) is posted by the core at the prices taken in, with GST at each item's rate today, the advance paying first. Billed at intake, a payment goes on the order's bills still owed. 409 `data: { reason: 'unpaid', owed, account }` while money is owed as the order's rule says and `onAccount` is not set, `data: { reason: 'no_account', owed }` with `onAccount` for a customer with no credit days or credit limit; 409 no garment ready, a garment named not ready, an item switched off or kept for use in services, the bill not coming to the figure worked out; 400 more paid than is left, a payment with nothing owed, a bill over ₹2,00,000 without the buyer's PAN or declaration. Audited and evented `laundry_order.delivered`; the core's `sale.posted` and `payment.recorded` |
| `POST /laundry/orders/:id/cancel` | laundry.cancel (laundry.refund with a refund) | `{ requestKey, reason, itemIds? (every garment in the shop), refund?: { method (cash, card, upi, bank) \| methodId, reference? }, approval?: { approverId?, pin } }` → the order. A billed garment's line is credited in full, one credit note a bill; with `refund`, what was paid beyond what is then due goes back through the core, with a manager's approval (a role with `laundry.refund`, and their PIN). 409 nothing left in the shop, a garment named not in the shop, a damage claim waiting, a garment already credited on a claim. Audited `laundry_order.cancelled` (under the approver when money goes back), evented; the core's `sale.returned` and `sale.refunded` |
| `POST /laundry/orders/:id/advance-refund` | laundry.view and sales.edit | `{ requestKey, amount? (all that is left), method (cash, upi, bank) \| methodId, reference?, reason, approverId?, pin }` → 201 the refund (`refund_no`, `amount`, `method`, …, `order_no`, `repeated`), with a manager's approval (a role with `sales.refund`, and their PIN). 409 no advance, garments still to bill. Audited and evented `collection.refunded` |
| `POST /laundry/orders/:id/notices` | laundry.view | `{ kind (received, ready, delayed, reminder), channel? (whatsapp, the default, call, sms) }` → 201 `{ logged, kind, channel, reminders }` (the message goes from the person's own WhatsApp, a `wa.me` link). Audited `laundry_order.customer_told` |
| `POST /laundry/orders/:id/claims` | laundry.edit | `{ requestKey, itemId, issue (damage, stain, shrinkage, colour_run, lost, missing_part, other), description, askedAmount? }` → 201 the order. 409 a cancelled garment, a claim already waiting on it. Audited and evented `laundry_claim.recorded` |

**Garments, racks, orders not collected and damage claims**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /laundry/items` | laundry.view | Garments, those in the shop first, then the newest: `order_id`, `order_no`, `seq`, `tag_no`, `garment_name`, `service_name`, `counted_as`, `colour`, `brand`, `per`, `quantity`, `pieces`, `status`, `rack`, `ready_at`, `delivered_at`, `defects`, `risk_note`, `acknowledged`, the customer, `location_id`, `promised_on`, `express`, `created_at`, `days_ready`, `in_shop`; no money. Search tag, order, customer, phone, rack and garment; filters `status`, `rack`, `order`, `contact`, `location`, `in_shop`, `express` |
| `GET /laundry/racks` | laundry.view | The ready garments, as above, by rack, then the longest waiting; filters `rack`, `location`, `express` |
| `GET /laundry/unclaimed` | laundry.view | The orders whose garments in the shop are all ready, the last of them for the business's days or more (as in the orders list, with `unclaimed_days`), the longest waiting first |
| `GET /laundry/claims` | laundry.view | Damage claims, those waiting first, then the newest: `order_id`, `order_no`, `item_id`, `tag_no`, `garment_name`, `service_name`, `item_status`, `issue`, `description`, `asked_amount`, `reported_at`, `reported_by_name`, `decision`, `amount`, `decision_note`, `decided_at`, `decided_by_name`, `refunded`, `return_no`, the customer, `location_id`, `delivered_at`, `open`, `days_after_delivery`; search order, tag, customer, phone, description and garment; filters `open`, `decision`, `issue`, `order`, `location` |
| `POST /laundry/claims/:id/decide` | laundry.refund | `{ requestKey, decision (refund, credit, reprocess, rejected), amount? (refund and credit), note? (required to reject), refund?: { method (cash, card, upi, bank) \| methodId, reference? } (refund), approval?: { approverId?, pin } (refund), tagNo? (reprocess: a delivered garment taken back in under a new tag) }` → the order. Money back and a credit note are a credit note on the garment's bill line for the amount; money back also refunds what was paid beyond what is then due, with a manager's approval (their PIN). Reprocessing sends a ready garment back into the work and takes a delivered one back in. 400 `data: { reason: 'over_charge', charge }` an amount above the garment's charge on the bill, `data: { reason: 'refund_method', refund }` money to go back without a method, a rejection without a note, an amount or a tag with the wrong decision; 409 decided already, a garment not billed yet (money back or a credit note), its charge credited already, `data: { reason: 'tag_taken' }` a tag on another garment in the shop. Audited `laundry_claim.decided` (under the approver for money back), evented; the core's `sale.returned` and `sale.refunded` |
| `GET /laundry/approvers` | laundry.cancel, laundry.refund or sales.edit | `?permission=` `laundry.refund` (the default) or `sales.refund` → `[{ id, name, has_pin }]`: the members who may approve that |

- `GET /notifications` (the bell), for a role with `laundry.view`: each order past its promised day with garments not ready (warning), linking to the order, and the orders ready and not collected for the business's days (info), linking to Unclaimed.
- `POST /documents/:id/returns` refuses a line that charges a garment (409: it is credited from its order, by cancelling the garment or settling a damage claim).
- Number series: garment orders are numbered in the kind `laundry_order` (prefix `LO`), set per location like any other series.

## Jewellery & gold

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `jewellery`, permission). The lists take `limit` (up to 100), `offset`, `q` and their filters (`from` and `to` on when the record was made) and answer `{ total, items }`. Backend module `modules/business/jewellery/` (routes `businessJewellery.routes.js`). A route that needs a `jewellery.*` permission answers 403 while the module is off, and so for every other type of business, which never has it. Dates are the business's own (its time zone): a rate sheet is for the business's date when it is set. Rates are prices: they are sent only to a role that also holds `sales.view` (403 otherwise). Each posting takes a `requestKey`; a retry with the same key and body returns the first answer, and the same key with another body answers 409. How it works: [BUSINESS_PLATFORM_DATA_MODEL.md › Jewellery & gold](BUSINESS_PLATFORM_DATA_MODEL.md#jewellery--gold).

**Today's rates**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/rates/today` | jewellery.view (with sales.view) | `{ day, rates[], previous[], sheets, lastSetAt, seller, notRated[], purities[], sessions[], sources[] }`: for each purity rated today (gold 24K, 22K, 18K, 14K; silver 999, 925; platinum 950, in that order) the latest sheet's `sell_rate` and `buy_rate` per gram with `fineness`, `mark` (22K916), `label` (Gold 22K916), `sheet_id`, `session` (morning, evening, own), `session_name` (the shop's own session), `session_words`, `source`, `note`, `set_at` and `set_by_name`; `previous`, the rates last set on an earlier day (to start a sheet from); how many sheets were set today; the shop's name; the purities not rated today; the lists the sheet form offers (`sessions[]`: morning, evening and the shop's own) |
| `POST /jewellery/rates` | jewellery.approve | `{ requestKey, session (morning, evening, or one the shop names in Jewellery settings, any case), source? (shop, association, ibja; the shop's own when left out), note?, rates: [{ metal, purity, sellRate, buyRate? }] }` (1 to 7, each purity once, rates per gram to the paisa) → 201 `GET /jewellery/rates/today`. A new sheet for the business's date; a correction is a new sheet. 400 a session the shop has not named, a purity the metal has not, a rate with more than two decimals, a purity twice. Audited and evented `jewellery_rates.set` |
| `GET /jewellery/rates` | jewellery.view (with sales.view) | Every sheet, newest first: `rate_date`, `session`, `session_name`, `source`, `note`, `created_at`, `set_by_name`, `rates[]` (`metal`, `purity`, `sell_rate`, `buy_rate`) and `replaced` (a later sheet of the same day was set). Filters `session`, `source`, `day` |

**Settings, jewellery items and pieces**

Pieces, items and the metal are sent without money (making charge, wastage, hallmarking charge, stone values, cost, price: null; `money: false`) to a role without `sales.view`; a piece such a role tags takes its item's making charge and wastage and the shop's hallmarking charge, and a stone such a role changes keeps its value.

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/settings` | jewellery.view | `{ tagPrefix, nextTag, hallmarkCharge (null without sales.view), updatedAt, rateSessions[], kycKinds[], kycAadhaar, discountOnMetal, companyNetWorth, netWorthOn (both null without sales.view), exemptions[], stoneKinds[], comesIn[], purities[] }`; T and 0.00 until saved |
| `PUT /jewellery/settings` | settings.edit | `{ tagPrefix? (0 to 6 letters), hallmarkCharge? (0-10,000; with sales.view), rateSessions?: [names] (up to 8, up to 40 letters, none twice, not morning or evening), kycKinds?: [names] (up to 20, up to 60 letters), discountOnMetal? (with sales.view), companyNetWorth? (empty for none) with netWorthOn (a day that has passed; with sales.view) }`; what is left out stays → the settings. Audited `jewellery_settings.updated` (from and to) |
| `GET /jewellery/items` | jewellery.view | `{ total, items[] }`: each jewellery item with its catalogue item (`sku_id`, `label`, `code`, `hsn_code`, `tax_rate`, `active`), `metal`, `purity`, `wastage_percent`, `making_mode`, `making_value` and how many `pieces` are in the shop |
| `POST /jewellery/items` | jewellery.edit | `{ skuId }` (an existing item, with catalog.edit) or `{ item: { name, hsnCode?, code? (JWL-001… when left out), categoryId? } }` (a new catalogue item: goods, serial-numbered, unit each, price nil, the 3% slab; with catalog.create), and `metal, purity, wastagePercent?, makingMode? (per_gram, percent, flat), makingValue?` → 201 the items. 409 an item not goods in pieces with serial numbers, not at 3%, or a jewellery item already; 409 no 3% slab; 400 a name with "lab grown", "lab created", "lab diamond" or "LGD". Audited `jewellery_item.created` |
| `PUT /jewellery/items/:skuId` | jewellery.edit | The defaults (`metal`, `purity`, `wastagePercent`, `makingMode`, `makingValue`) → the items. Audited `jewellery_item.updated` (from and to) |
| `GET /jewellery/pieces` | jewellery.view | Pieces, newest first: `tag_no`, `sku_id`, `item_label`, `item_code`, `hsn_code`, `tax_rate`, `description`, `design_code`, `metal`, `purity`, `gross_weight`, `stone_weight`, `net_weight`, `wastage_percent`, `making_mode`, `making_value`, `hallmarked`, `old_hallmark`, `hallmark_charge`, `exemption`, `status` (in_stock, on_approval, at_karigar, at_centre, sold, melted, split, merged, retagged), `with_whom`, `stage` (in, out), `huids`, `stone_value`, `stone_carat`, `stone_lines`, `location_id`, `location_name`, `in_books` (its unit is in stock), `cost`, the challan it is out on (`out_kind`: approval, karigar or centre; `out_id`, `out_no`, `out_with`, `out_due`), `order_id`, `order_no`, `order_status` (the order it was made for) and `photo_id`. Filters `status`, `stage`, `metal`, `purity`, `item`, `location`, `hallmarked`, `old_hallmark`, `in_books`, `order`; search on the tag, HUIDs, item, words, design code, the challan and its party, and the order |
| `GET /jewellery/pieces/find` | jewellery.view | `?code=` a tag or a HUID → the piece as `GET /jewellery/pieces/:id`. 404 none |
| `GET /jewellery/pieces/:id` | jewellery.view | The piece with `mark` (22K916), `purity_words`, `exemption_words`, `huid_list`, `stones[]` (with `kind_words`), `events[]`, `made_from[]` and `made_into[]` (`kind`: split, merge, retag; `pieceId`, `tag`) and `price` (in the shop, with sales.view, when its purity has a rate today: `rate`, `netWeight`, `wastageWeight`, `metal`, `wastage`, `making`, `stones`, `hallmark`, `value` before GST, `taxRate`, `tax`, `total`, `sheetId`) |
| `POST /jewellery/pieces` | jewellery.edit | `{ requestKey, skuId, comesIn: 'new' (with inventory.edit: locationId, reason (opening, made, other), cost?) \| 'stock' (a unit received with that number), tagNo? (required for stock; the next number for new), description?, metal?, purity?, grossWeight, stoneWeight?, wastagePercent?, makingMode?, makingValue?, hallmarked?, hallmarkCharge?, huids?: [..], exemption?, stones?: [{ kind, description?, pieces?, carat?, grade?, certificate?, treatment?, value? }], notes? }` → 201 the piece. New: a stock correction of +1 with its reason, at its cost. 400 a weight with more than three decimals, stones not below the gross weight, a HUID not 6 letters and digits, a HUID on a piece not hallmarked, the disallowed words for a man-made diamond, a diamond called fake or artificial, an exemption for silver or platinum; 404 not a jewellery item; 409 a tag on another piece, a HUID on another piece, no unit of the item in stock with that number, a number the item has had in stock before. Audited and evented `jewellery_piece.tagged`; the core's `stock.adjusted` |
| `PUT /jewellery/pieces/:id` | jewellery.edit | Any of the figures (with `designCode` and `oldHallmark`: hallmarked before HUIDs, waiting to be re-hallmarked, with no HUID), `huids` (all of them) and `stones` (all of them), while the piece is in the shop → the piece. 409 a piece that has left the shop; 409 a piece out on a challan whose weight or purity would change (it is weighed again as it comes back on it). Audited `jewellery_piece.changed` (what changed, from and to), in its history |
| `POST /jewellery/pieces/:id/melt` | jewellery.approve | `{ requestKey, reason }` → the piece, melted: its unit leaves stock (a −1 correction) and its metal joins the shop's metal at its location. 409 a piece not in stock, or not in stock in the books. Audited and evented `jewellery_piece.melted`; the core's `stock.adjusted` |
| `GET /jewellery/metal` | jewellery.view | The shop's own metal: for each location and purity, `net_weight`, `fine_weight`, `net_in`, `net_out`, `movements`, `mark`, `label` |
| `GET /jewellery/metal/movements` | jewellery.view | Each movement, newest first: `location_name`, `metal`, `purity`, `net_weight`, `fine_weight`, `source`, `piece_tag`, `note`, `created_at`, `by_name`. Filters `metal`, `purity`, `location`, `source` |

- `POST /documents` (a sale) refuses a jewellery item's line (409: its pieces are billed on the jewellery bill).

**The jewellery bill**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /jewellery/bills/preview` | jewellery.create (with sales.view) | `{ locationId, tags: [..] (up to 50; may be left out with an order or items), items?: [{ skuId, quantity? (1), lotCode? }] (loose stones and coins, up to 20), discount?: { amount (₹, before GST), reason } (with sales.discount), contactId?, scheme?: scheme id, order?: a custom order that is ready (its pieces join the tags), approval?: an approval challan (the tags out on it are sold from it), credits?: [returned bill ids] (up to 3), oldGold?: [voucher ids] (up to 5) }` → the bill as it would be posted now, nothing saved: `{ day, rules: { mandatory, confirmed, district, turnoverExempt }, lines[], problems[], subtotal, tax, roundOff, total, panNeeded (over ₹2,00,000), statement, offerDiscount, counterDiscount, discountOnMetal, items[] (each `skuId`, `label`, `quantity`, `taxRate`, `unitPrice`, `value`, `discount`, `taxable`, `tax`, `total`, or `problem`: a tagged item, an item the jeweller's purchases are booked under, a service, no price, not in stock, no batch or serial), contactId (whose scheme, credit or old gold it is when no customer is chosen), scheme (`schemeNo`, `paid`, `discount`, `pays`, …) \| null, schemeDiscount, schemePaid, credits[] (`documentId`, `documentNo`, `credit`, `amount` it pays), oldGold[] (`id`, `voucherNo`, `sellerName`, `balance`, `amount` it pays), oldGoldPaid, paidBefore, toPay }`; each line `tag`, `pieceId`, `description`, `mark`, `purityLong`, the weights, `huids`, `stones[]`, `basis` and `basisWords` (why the HUID check lets it through), `rate`, `metalValue`, `wastagePercent`, `wastageWeight`, `wastage`, `makingMode`, `makingValue`, `making`, `stoneValue`, `hallmarkCharge`, `value`, `offer` (`id`, `name`, `makingPercent`) \| null, `offerDiscount`, `counterDiscount`, `schemeDiscount`, `discount` (all three), `taxable`, `taxRate`, `tax`, `total`, or `problem` (no such tag, out on approval or at the karigar, sold or melted, not in the books, at another location, an item not at 3%, no rate today for its purity, no HUID where one is needed, in its buyer's safekeeping). 403 a discount without sales.discount; 409 a discount beyond the pieces' making and wastage (and metal, where the settings allow it) or beyond the business's most on a bill (the owner may give more), a scheme's discount more than the bill |
| `POST /jewellery/bills` | jewellery.create and sales.create | `{ requestKey, locationId, tags: [..], items?, discount? (with sales.discount), contactId? \| customer?: { name, phone?, pan? } (with contacts.create), scheme?, order? (with sales.edit), approval?, credits?, oldGold?: [voucher ids] (each with sales.edit), payment? \| payments? (with sales.edit; `amount: 'full'` is the rest), buyer?: { pan?, panDeclaration?, name?, phone? }, notes? }` → 201 the bill: `{ id, document_id, document_no, total, subtotal, tax, round_off, contact_name, rate_date, hallmark_mandatory, turnover_exempt, lines[] (each piece's figures as billed), old_gold[] (`voucher_no`, `amount`), change? }`. Posts the core sale at the pieces' prices (one line a piece, its words `<description> · <purity mark> · tag <tag>`, then a line for each loose stone or coin at its price and slab), the units leave stock, the pieces are sold. Each piece takes the best offer on making running on the day for its metal; the counter's discount comes off the pieces' making and wastage (and metal, where the settings allow it), spread by what each has of them, with why. Before any money, in this order: the gold scheme (all it holds: each instalment's receipt as it was paid, and what was put back onto it from a returned bill as a credit-note payment, `method_name` *Gold scheme*, the scheme's number as the reference; the bill coming to at least that; with every instalment paid and the scheme matured, the plan's discount spread over the pieces before GST); the credit on the customer's returned jewellery bills (each a credit-note payment, `method_name` *Credit note*, the returned bill's number as the reference, and a credit-note refund on the returned bill); the old gold (each voucher, in the order given, up to what is left on it and what the bill still needs, as a credit-note payment, `method_name` *Old gold*, its voucher's number as the reference); the payments are the rest. 409 a piece that cannot be billed (the preview's problems), a walk-in not paying in full, a scheme, credit or old gold of another customer (the bill's customer is theirs when none is chosen), a scheme redeemed already or worth more than the bill, a returned bill with no credit left, old gold cancelled or with nothing left, a credit or voucher not needed for the bill; 400 payments over what is left to pay, a bill over ₹2,00,000 without the buyer's PAN or a declaration, old gold with a new customer; 409 cash of ₹2,00,000 or more (Income-tax Act 2025, section 186). Audited and evented `jewellery_bill.posted` and `jewellery_old_gold.used`; the core's `sale.posted`, `payment.recorded` |
| `GET /jewellery/bills` | jewellery.view (with sales.view) | The bills, newest first: `document_no`, `total`, `contact_name`, `location_name`, `rate_date`, `created_at`, `created_by_name`, `pieces`, `items`, `tags`, `net_weight`, `offer_discount`, `counter_discount`, `scheme_discount`, `returned`. Filters `location`, `contact` |
| `GET /jewellery/bills/credits` | jewellery.view (with sales.view) | `?contact=` a customer → `{ items[] }`: their returned jewellery bills with credit left (`documentId`, `documentNo`, `credit`, `createdAt`) |
| `GET /jewellery/bills/:id` | jewellery.view (with sales.view) | The bill with its lines as billed (each `discount` all of its discounts, `offer_id`, `offer_name`, `offer_percent`, `offer_discount`, `counter_discount`; `fixed_weight`, `fixed_rate` and `fixed_sheet_id` on a custom order's piece), `scheme` (`scheme_no`, `plan_name`, `discount`) \| null, `order` (`order_no`, `fixed_rate`, `fixed_weight`) \| null, `items[]` (the loose stones and coins as billed), `offer_discount`, `counter_discount`, `discount_reason`, `discount_on_metal` and `old_gold[]` (each voucher that paid it: `old_gold_id`, `voucher_no`, `amount`, less what went back on it) |

- `GET /documents/:id` of a jewellery bill adds `jewellery: { billId, rateDate, statement, bis: { name, licenceNo } \| null, scheme: { schemeNo, discount } \| null, order: { orderNo, fixedRate, fixedWeight } \| null, discounts: { offer, counter, reason, onMetal }, safekeeping: { tag } \| null (a scheme closed on its day 364), lines[] }`: each line's BIS details, its discounts (`offer_name`, `offer_percent`, `offer_discount`, `counter_discount`, `scheme_discount`) (`description`, `net_weight`, `mark`, `purity_long`, `hallmark_charge`, `huids`, `basis_words`) and price build-up, the purity statement, and the location's BIS registration in force (Licences, kind `bis`).
- `POST /documents/:id/returns` takes a jewellery bill's line back only to stock (409 otherwise); the piece comes back into stock.
- `POST /documents/:id/refunds` on a jewellery bill gives back in money at most what was paid on it in money at the counter (409: what old gold paid goes back on its voucher, `POST /jewellery/old-gold/:id/put-back`; what a gold scheme paid goes back onto the scheme within its tenure, `POST /jewellery/schemes/:id/put-back`, and after it stays as the customer's credit, for their next jewellery bill).
- `PUT /jewellery/settings` also takes `turnoverExempt` (the owner says the turnover is up to ₹40 lakh) and `locations: [{ locationId, mandatory, district? }]` (each location's district under mandatory hallmarking or not); `GET` returns them with who said and when (`locations[]`: `confirmed`, `mandatory` — yes until said —, `district`, `confirmedAt`, `confirmedByName`).

**Old gold**

Old gold vouchers carry money: every route needs `sales.view` too (403 otherwise).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /jewellery/old-gold/preview` | jewellery.create | `{ lines: [{ description, pieces?, metal, purity (valued as), testMethod (xrf, touchstone, acid, fire_assay), testedFineness? (the purity's own when left out), grossWeight, lessWeight?, deductionPercent? (the buy-back rule's when left out), huid?, tag? (the shop's own piece) }] }` (1 to 30) → nothing saved: `{ day, lines[] (`netWeight`, `fineWeight`, `buyRate`, `deductionPercent`, `rule` (own_piece, purity, general), `rulePercent`, `ruleWords`, `override` (another deduction than the rule's), `ownTag`, `value`, or `problem`: no buy rate for its purity today), problems[], netWeight, fineWeight, roundOff, value, panNeeded (over ₹2,00,000), needsApproval }`. 404 a tag of no piece; 409 a tag or HUID of a piece the shop has not sold, of another metal, or a HUID not on the tagged piece |
| `POST /jewellery/old-gold` | jewellery.create | `{ requestKey, locationId, contactId? \| customer?: { name, phone? } (with contacts.create), idKind (aadhaar, voter_id, driving_licence, passport, pan_card, other), idRef (of an Aadhaar card, its last four digits), pan?, panDeclaration?, ownerDeclared: true, lines: [..] (as the preview), approval?: { reason, approverId?, pin? } (a deduction other than the rule's: a role with `jewellery.approve`, their PIN when someone else asks; a manager's own with the reason alone), notes? }` → 201 the voucher (as `GET /jewellery/old-gold/:id`), numbered OG/…: each line valued at the latest buy rate of the day for its purity, the value rounded as the business rounds its bills, and its metal into the shop's metal. 400 an Aadhaar number of more than four digits, no declaration, over ₹2,00,000 without the seller's PAN or a Form 97 declaration, weights with more than three decimals or stones and dirt not below the gross weight, the disallowed words for a man-made diamond; 409 no buy rate for a purity today. A new customer keeps the PAN given; 400 another deduction without why or the manager's PIN (403 one who may not approve). Audited and evented `jewellery_old_gold.taken`; each deduction other than the rule's audited `jewellery_old_gold.deduction_changed` under the approver |
| `GET /jewellery/old-gold` | jewellery.view | The vouchers, newest first: `voucher_no`, `created_at`, `location_name`, `contact_id`, `seller_name`, `seller_phone`, `purities` (`metal:purity` words), `lines`, `net_weight`, `fine_weight`, `value`, `used` (on bills, less what was put back), `paid` (paid out), `balance` (left), `state` (open, settled, cancelled), `photos`, `by_name`. Filters `state`, `location`, `contact`; search on the number, seller and phone |
| `GET /jewellery/old-gold/:id` | jewellery.view | The voucher with `lines[]` (each as tested and valued, with `mark`, `test_words`, `own_tag` (the shop's own piece it is), `deduction_rule`, `rule_percent`, `rule_words`, `override_by_name`, `override_reason`, and where its metal went: `next` (melt, resell, refinery, karigar), `next_words`, `refinery_no`, `karigar_issue_no`), `photos[]`, `uses[]` (each bill it paid, a positive `amount`, or the part put back from it, negative), `payouts[]` (`amount`, `method`, `method_words`, `reference`, `expense_id`), `putBack[]` (each returned bill with what can go back on the voucher from it: `documentId`, `documentNo`, `amount`), `id_words`, `declaration` (the seller's words for the printed voucher) and `cancellable` |
| `POST /jewellery/old-gold/:id/payout` | jewellery.approve | `{ requestKey, amount? (all that is left when left out), method (cash, upi, bank) \| methodId, reference? }` → 201 the voucher. Written in the expense book (category Other, at the voucher's location and the business's date). 409 cancelled, nothing left, more than is left; 409 cash of ₹2,00,000 or more to the seller in a day or on the voucher (Income-tax Act 2025, section 186), or over the shop's own limit. Audited and evented `jewellery_old_gold.paid`; the core's `expense.recorded` |
| `POST /jewellery/old-gold/:id/put-back` | jewellery.create and sales.refund | `{ requestKey, documentId, amount? (all that can go back when left out) }` → 201 the voucher: a credit-note refund on the returned bill ("Old gold … put back on its voucher") and the voucher's value back. 409 nothing to put back from that bill (return the piece first), more than old gold paid on it or the bill's credit after the return. Audited and evented `jewellery_old_gold.put_back`; the core's `sale.refunded` |
| `POST /jewellery/old-gold/payouts` | jewellery.approve | `{ requestKey, contactId (the seller), vouchers: [{ id, amount? (all that is left when left out) }] (1 to 10, each once, all the seller's), method (cash, upi, bank) \| methodId, reference? }` → 201 `{ seller, vouchers[] (each as `GET /jewellery/old-gold/:id`), paid }`: each voucher paid on its own (its payout and expense), checked against the cash limits as it is paid, in the order given; all or none. 409 a voucher of another seller, cancelled or with nothing left, more than is left, cash past the limits (the message names the voucher). Audited (with `together`) and evented `jewellery_old_gold.paid` for each |
| `POST /jewellery/old-gold/:id/next` | jewellery.approve | `{ seq, next (melt, resell), note? }` → the voucher: the line's metal kept to resell as it is, or back with the metal to melt (a mark: the metal stays counted where it was). 404 no such line; 409 cancelled, the metal went to a refiner, dealer or karigar. Audited `jewellery_old_gold.next_set` |
| `POST /jewellery/old-gold/:id/cancel` | jewellery.cancel | `{ reason }` → the voucher, cancelled, its metal back out of the shop's metal; cancelling again changes nothing. 409 paid out or used on a bill, its metal went on to a refiner, dealer or karigar. Audited and evented `jewellery_old_gold.cancelled` |

- `PUT /jewellery/settings` also takes the buy-back rules, `oldGoldDeduction` (0-99.99: the general deduction), `ownPieceDeduction` (0-99.99, or empty for none: the shop's own pieces bought back) and `purityDeductions: [{ metal, purity, deductionPercent }]` (all the purities' own: the rest take the general one), and `oldGoldCashLimit` (1-1,99,999.99, or empty for none: the shop's own limit on cash paid out for old gold to one seller in a day), with sales.view; `GET` returns them (`purityDeductions[]` for every purity, null where it takes the general one; the limit null without sales.view) with `testMethods[]`, `idKinds[]`, `ruleWords` and `declaration`.

**Refinery challans**

The shop's metal to a refiner or a bullion dealer. Every route needs `sales.view` too.

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /jewellery/refinery` | jewellery.approve | `{ requestKey, locationId, party (refiner, dealer), contactId (a supplier for a refiner, a customer for a dealer) \| contact: { name, phone?, gstin?, pan? } (with contacts.create), lines: [{ metal, purity, netWeight, fineness? (the purity's own when left out) }] (1 to 30, one metal), oldGold?: [{ voucherId, seq }] (the lines of old gold it carries), notes? }` → 201 the challan (as `GET /jewellery/refinery/:id`), numbered RF/…, its metal out of the location's. 400 two metals; 404 a refiner not a supplier, a dealer not a customer; 409 more than the location holds, old gold of another location or a purity not sent, cancelled or gone on already. Audited and evented `jewellery_refinery.sent` |
| `GET /jewellery/refinery` | jewellery.view | The challans, newest first: `challan_no`, `party`, `party_name`, `metal`, `net_weight`, `fine_weight`, `outcome` (out, back, sold), `back_fine_weight`, `document_no`, `sale_total`. Filters `outcome`, `party`, `location`; search on the number, the party and the sale bill |
| `GET /jewellery/refinery/:id` | jewellery.view | The challan with `lines[]`, `old_gold[]` (each line it carries), `party_words`, `outcome_words`, `back_mark` and `loss_fine` (the fine metal sent less the fine metal back) |
| `POST /jewellery/refinery/:id/back` | jewellery.approve | `{ requestKey, purity, netWeight, fineness? }` → the challan, back: the refined metal into the shop's metal. 409 a dealer's challan, closed already, another metal, more fine metal back than went. Audited and evented `jewellery_refinery.back` |
| `POST /jewellery/refinery/:id/sell` | jewellery.approve and sales.create | `{ requestKey, rate (per gram of the fine metal sent), payment? \| payments? (with sales.edit), buyer?: { pan?, panDeclaration? }, notes? }` → the challan, sold: a sale bill to the dealer of the fine metal at the rate, at 3% GST, booked under the metal's own item without stock. 409 a refiner's challan, closed already. Audited and evented `jewellery_refinery.sold`; the core's `sale.posted` |

- The number series kind `refinery_challan` (prefix RF) numbers the challans.
- `POST /jewellery/karigars/issues` also takes `oldGold: [{ voucherId, seq }]` (with a metal line of its purity): those lines of old gold go to the karigar on the challan; `GET /jewellery/karigars/issues/:id` returns them as `old_gold[]`.
- The number series kind `old_gold` (prefix OG) numbers the vouchers (`GET /number-series`).

**Gold schemes**

Schemes and their plans carry money: every route needs `sales.view` too (403 otherwise).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/scheme-plans` | jewellery.view | `{ items[] }`: each plan (`name`, `instalments`, `min_instalment`, `discount_percent`, `terms`, `active`, `open_schemes`, `schemes`, `yearly_rate`: the discount as a yearly figure on the money held, `discount`: on the smallest instalment) |
| `POST /jewellery/scheme-plans` | jewellery.approve | `{ requestKey, name, instalments (2-11), minInstalment (whole rupees, 100 or more), discountPercent (0-100, of one instalment), terms }` → 201 the plans. 400 "interest" in the name or terms, more than 11 instalments; 409 a name in use. Audited and evented `jewellery_scheme_plan.created` |
| `PUT /jewellery/scheme-plans/:id` | jewellery.approve | `{ active }` → the plans (a plan switched off takes no one new; its schemes run on). Audited `jewellery_scheme_plan.updated` |
| `POST /jewellery/schemes` | jewellery.create and sales.edit | `{ requestKey, locationId, planId, contactId? \| customer?: { name, phone? } (with contacts.create), instalment (whole rupees, at least the plan's smallest), nomineeName?, nomineeRelation?, termsAccepted: true, payment: { method (cash, upi, card, bank) \| methodId, reference? }, notes? }` → 201 the scheme (as `GET /jewellery/schemes/:id`), numbered GS/…, with its first instalment taken as a collection receipt. 400 the terms not accepted, an amount below the plan's or not whole rupees; 409 a plan switched off, cash of ₹2,00,000 or more into the scheme. Audited and evented `jewellery_scheme.joined`; the core's `collection.recorded` |
| `GET /jewellery/schemes` | jewellery.view | The schemes, newest first: `scheme_no`, `member_name`, `member_phone`, `contact_id`, `plan_name`, `instalments`, `instalment`, `paid_count`, `paid`, `cash_paid`, `next_due_on`, `started_on`, `maturity_on`, `close_by`, `days_left`, `status`, `stage` (paying, due, matured, stopped, closing (on its day 364 today), past_close, safekeeping (closed and not yet collected), redeemed), `open` (not yet redeemed), `redeemed_document_no`, `discount`, `location_name`. Filters `status`, `stage`, `open`, `plan`, `contact`, `location`; search on the number, member, phone and plan |
| `GET /jewellery/schemes/liability` | jewellery.view | `?location=` → `{ asOf, items[], byPlan[], netWorth, totals: { schemes, paid, discountNow, discountWhenComplete, pastClose, closingToday, closingIn30 } }`: every scheme not yet redeemed with what it holds (owed to the customer as jewellery) and the discount it gives now and when complete; `netWorth` (a company's: `netWorth`, `on`, `sharePercent` 25, `limit`, `held` at every location, `usedPercent`, `headroom`, `over`) \| null when none is given |
| `GET /jewellery/schemes/approvers` | jewellery.create or jewellery.cancel | Who may approve stopping a scheme, or a deduction on old gold other than the rule's: members with `jewellery.approve` (`id`, `name`, `has_pin`) |
| `GET /jewellery/schemes/:id` | jewellery.view | The scheme with `schedule[]` (each instalment's `due_on`, and `paid`: its receipt, method and day, or `late`), `instalments_paid[]`, `stage_words`, `discount_now`, `discount_when_complete`, `yearly_rate`, `can_pay`, `held`, `moves[]` (money put back from a returned bill and used again: `kind` back or used, `amount`, `document_no`), `put_back` (`documentId`, `documentNo`, `amount`, `withinTenure`) \| null, `can_close`, `can_collect`, and its close: `close_id`, `closed_at`, `close_tag`, `close_weight`, `collected_at`, `collected_by_name` |
| `POST /jewellery/schemes/:id/instalments` | jewellery.create and sales.edit | `{ requestKey, method \| methodId, reference?, locationId? (where it is paid; the scheme's own when left out) }` → 201 the scheme, with the next instalment taken as a collection receipt. 409 stopped or redeemed, all instalments paid, matured, cash of ₹2,00,000 or more into the scheme (Income-tax Act 2025, section 186). Audited and evented `jewellery_scheme.instalment_paid`; the core's `collection.recorded` |
| `POST /jewellery/schemes/:id/stop` | jewellery.cancel | `{ reason, approval?: { approverId?, pin? } }` (a role with `jewellery.approve`: their PIN; a manager's own step with the reason alone) → the scheme, stopped: no more instalments and no discount; what was paid is still redeemed on a jewellery bill. Stopping again changes nothing; 409 redeemed. Audited (under the approver) and evented `jewellery_scheme.stopped` |
| `GET /jewellery/schemes/:id/close` | jewellery.view | `?metal&purity&locationId?` → what a close would come to now, nothing saved: `{ schemeNo, held, discount, metal, purity, label, rate, netWeight (the fewest milligrams whose bill comes to the money), total, due (on collection), shopHolds, enough, closeBy, today }`. 409 redeemed, no rate today for the purity |
| `POST /jewellery/schemes/:id/close` | jewellery.approve and sales.create | `{ requestKey, metal, purity, locationId? (the scheme's when left out), buyer?: { pan?, panDeclaration? } }` → 201 the scheme, closed on or after its day 364: a jewellery bill redeeming it, of one piece of that metal set aside from the shop's metal and tagged now, held in the customer's safekeeping. 409 before its day 364, redeemed, holding no money, no rate today, the location not holding the metal. Audited and evented `jewellery_scheme.closed`; the core's `sale.posted` |
| `POST /jewellery/schemes/:id/collect` | jewellery.create (sales.edit to take what is due) | `{ requestKey, note?, payment?: { method \| methodId, reference? } }` → the scheme: the customer collects the piece (sold), paying what is still due on its bill. 404 not closed; 409 something due and no payment, the piece taken back. Audited and evented `jewellery_scheme.collected` |
| `POST /jewellery/schemes/:id/put-back` | jewellery.create and sales.refund | `{ requestKey, amount? (all that can go back when left out) }` → 201 the scheme, open again as it was (active or stopped): a credit-note refund on the bill that redeemed it, its money back onto the scheme to pay its next bill. 409 not redeemed, closed into safekeeping, past its day 364 (it stays as the customer's credit), nothing to put back (return the pieces first), more than it paid on the bill or the bill's credit. Audited and evented `jewellery_scheme.put_back`; the core's `sale.refunded` |

- The number series kind `gold_scheme` (prefix GS) numbers the schemes.
- `POST /receivables/customers/:id/apply-advance` leaves out a customer's receipts held for their gold schemes; no other bill takes them, and a collection refund never pays them back (409, from the database).

**The cash report**

Nothing here files anything. Each route needs `sales.view` too.

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/cash-report` | jewellery.export | `?from&to` (the rolling month to today when left out: from the day after the same date last month; up to a year) → `{ today, from, to, reportingLevel (10,00,000.00), alertLevels[], reportingEntity, reportingEntityAt, people[], unlinked: { count, cashIn, cashOut }, totals: { people, reporting, alert, cashIn, cashOut } }`; each person (customers sharing a PAN, a phone number's last ten digits or a family group are one; `key`: `p:<the lowest customer id>`, or `pan:<PAN>` for a walk-in's PAN alone) with `contacts[]`, `name`, `phone`, `pan`, `families[]`, `links[]` (`link`: pan, phone, family; `words`), `count`, `cashIn`, `cashOut`, `total` (in and out), `largest`, `lastDay`, `level` (reporting at ₹10 lakh or more, alert at one of the shop's levels), `alertLevel` (the highest reached) and `kyc` (a document on file), largest first |
| `GET /jewellery/cash-report/person` | jewellery.export | `?key&from&to` → `{ from, to, key, transactions[] }`: each cash transaction (`at`, `day`, `kind`: bill, receipt, scheme, refund, advance_back, old_gold; `kindWords`, `ref`, `name`, `cashIn`, `cashOut`). 400 a key not in the report's form |
| `GET /jewellery/cash-report/families` | jewellery.export | `{ items[] }`: each family group (`name`, `by_name`, `members[]`: `id`, `name`, `phone`) |
| `POST /jewellery/cash-report/families` | jewellery.export | `{ name, contactIds?: [customers] (up to 30) }` → 201 the groups (a customer in another group moves here). 409 a name in use; 404 not a customer. Audited `jewellery_cash.family_created`, `jewellery_cash.family_joined` |
| `PUT /jewellery/cash-report/families/:id` | jewellery.export | `{ add?: [customers], remove?: [customers] }` → the groups. 404 no such group; 400 more than 30. Audited `jewellery_cash.family_joined`, `jewellery_cash.family_left` |
| `GET /jewellery/cash-report/month` | jewellery.export | `?month=YYYY-MM` (last month when left out) → `{ month, from, to, dueBy (the 15th of the next month), reportingEntity, people[] }`: each person whose cash that month was above ₹10 lakh, in one transaction or several, with their `transactions[]`. 400 a month not written like 2026-09, a month not begun |

- `PUT /jewellery/settings` also takes `cashAlertLevels: [amounts]` (up to 5, 1-9,99,999.99 each, none twice) and `reportingEntity` (the owner says the shop is a reporting entity), with sales.view; `GET` returns them (lowest first), with `reportingEntityAt`.

**Customers' KYC**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/kyc/:contactId` | jewellery.view and contacts.view | `{ customer, full, lastTransaction, keepUntil (five years after it), keepYears, aadhaarRule, documents[], owners[], kinds[] }`: each document (`kind`, `number`, `name_on_document`, `seen_on`, `notes`, `copy_id`, `has_copy`, who and when, `removed_at`, `remove_reason`) and owner (`name`, `role`, `share_percent`, `pan`); numbers, PANs and the copy in full only with `jewellery.manage` (`full`), otherwise the last four characters. 404 not a customer |
| `POST /jewellery/kyc/:contactId/documents` | jewellery.create and contacts.view | `{ requestKey, kind (one the shop accepts), number (of an Aadhaar card, its last four digits), nameOnDocument?, seenOn (today or earlier), notes? }` → 201 the customer's KYC. 400 an Aadhaar number of more than four digits, a number not 2 to 40 letters and digits, a day to come; 409 a type the shop does not accept, an erased customer. Audited `jewellery_kyc.recorded` (the number masked) |
| `POST /jewellery/kyc/:contactId/documents/:documentId/set-aside` | jewellery.manage | `{ reason }` → the KYC: the document set aside (kept). Audited `jewellery_kyc.set_aside` |
| `POST /jewellery/kyc/:contactId/owners` | jewellery.create and contacts.view | `{ name, role, sharePercent?, pan? }` → 201 the KYC with the firm's beneficial owner. Audited `jewellery_kyc.owner_added` |
| `POST /jewellery/kyc/:contactId/owners/:ownerId/set-aside` | jewellery.manage | → the KYC: the owner set aside (kept). Audited `jewellery_kyc.owner_set_aside` |

- A document's copy (a photo or PDF) goes through `POST /jewellery/files` with `kycId`, and opens with `jewellery.manage`.

**The suspicious transaction log**

Seen only by a role holding `jewellery.review` (the owner's until given): never in the bell, the activity log or a customer's copy of their data. Each case keeps its own history instead.

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/str` | jewellery.review | `?status=` (open, reported, not_reported) → `{ items[] }`: each case (`case_no`, `customer_name`, `subject`, `status`, `status_words`, `notes`, `reported_on`, who and when), newest first |
| `POST /jewellery/str` | jewellery.review | `{ requestKey, contactId? \| subject (a name as known), grounds (what was seen), transactions? }` → 201 the case, numbered 1, 2 … 400 no one named; 404 not a customer |
| `GET /jewellery/str/:id` | jewellery.review | The case with `entries[]` (opened, note, viewed, decided: who and when); reading it is written in its history |
| `POST /jewellery/str/:id/notes` | jewellery.review | `{ note }` → 201 the case |
| `POST /jewellery/str/:id/decide` | jewellery.review | `{ decision (reported, not_reported), note (what was reported, or why not), reportedOn? (a reported case: today or earlier), reportRef? }` → the case, decided once. 409 decided already |

**Offers on making**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/offers` | jewellery.view (with sales.view) | `{ today, items[] }`: each offer (`name`, `making_percent`, `metal` (null: every metal), `metal_words`, `starts_on`, `ends_on`, `active`, `running` today, `pieces` given it, `given`) |
| `POST /jewellery/offers` | jewellery.approve | `{ requestKey, name, makingPercent (0.01-100), metal?, startsOn, endsOn (on or after it, today or later, within a year) }` → 201 the offers. Audited and evented `jewellery_offer.created` |
| `PUT /jewellery/offers/:id` | jewellery.approve | `{ active }` → the offers (switched off, an offer gives no more; its terms never change). Audited `jewellery_offer.updated` |
- `GET /notifications` (the bell), for a role with `jewellery.view`: today's rates not set (to `jewellery.approve`), each location whose district has not been said (to `settings.edit`), old gold taken in before today with value left (to `jewellery.approve` with `sales.view`), gold schemes within 30 days of their close day, on their day 364 today or past it, metal in safekeeping waiting to be collected and a company's scheme money past 25% of its net worth (to `sales.view`), and the cash report's flags (to `jewellery.export` with `sales.view`): a person at ₹10 lakh in cash in the rolling month to today, those past the shop's own levels, and, for a reporting entity, last month's report until the 15th; custom orders past the day promised and approval challans past the day due back (to `sales.view`), and issue challans with pieces still at a karigar past their day.

**Karigar work**

Labour, rates and money are sent only to a role with `purchasing.view` (null otherwise).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/karigars` | jewellery.view | `{ items[], costs }`: each karigar (`contact_id`, `name`, `phone`, `gstin`, `registered`, `wastage_percent`, `active`, `notes`, `pieces_held`, `gold_fine`, `silver_fine`, `platinum_fine`, `unbilled`) |
| `POST /jewellery/karigars` | jewellery.approve | `{ contactId (a supplier) \| supplier: { name, phone?, gstin?, pan? } (with contacts.create), wastagePercent? (0-25), notes? }` → 201 the karigar as `GET /jewellery/karigars/:id`. 404 not a supplier; 409 a karigar already. Audited `jewellery_karigar.created` |
| `GET /jewellery/karigars/:id` | jewellery.view | The karigar with `rates[]`, `account[]` (by purity: `held`, `heldFine`, `issuedFine`, `madeFine`, `returnedFine`, `repairsFine`, `allowedFine`, `writtenOffFine`, `actualWastageFine`), `entries[]` (the fine-weight book's rows), `held[]` (pieces with them), `issues[]`, `receipts[]` and `money` (`labour`, `invoiced`, `toInvoice`, `paid`, `owed`, `invoices[]`) |
| `PUT /jewellery/karigars/:id` | jewellery.approve | `{ wastagePercent?, active?, notes? }` → the karigar. Audited `jewellery_karigar.updated` |
| `PUT /jewellery/karigars/:id/rates` | jewellery.approve and purchasing.view | `{ rates: [{ skuId (a jewellery item), basis (per_gram, per_piece), rate }] }` (all of them: an item left out has no rate) → the karigar. 400 an item twice; 404 not a jewellery item. Audited `jewellery_karigar.rates_set` |
| `POST /jewellery/karigars/issues` | jewellery.edit | `{ requestKey, contactId, locationId, orderId?, dueOn?, notes?, lines: [{ kind: 'metal', metal, purity, netWeight, fineness?, description? } \| { kind: 'piece', pieceId \| tag, description? } \| { kind: 'stone', description, pieces?, carat?, value? }] }` (1-50) → 201 the challan (KI/…; number series kind karigar_issue) with `lines[]`, `metal_net`, `metal_fine`, `pieces_out`. The metal leaves the shop's metal; a piece goes to the karigar; an order goes to issued. 400 a day due before today; 404 a karigar or piece not found; 409 a karigar switched off, a piece not in stock at the location, more metal than the location holds, an order delivered or cancelled. Audited and evented `jewellery_karigar.issued` |
| `GET /jewellery/karigars/issues` | jewellery.view | The challans, newest first: `issue_no`, `karigar_name`, `order_no`, `due_on`, `lines`, `pieces`, `pieces_out`, `metal_net`, `metal_fine`, `overdue`. Filters `karigar`, `order`, `location`, `overdue` |
| `GET /jewellery/karigars/issues/:id` | jewellery.view | The challan with `lines[]` (each piece's `piece_status`), `receipts[]` and the karigar's GSTIN, phone and address |
| `POST /jewellery/karigars/receipts` | jewellery.edit | `{ requestKey, contactId, locationId, issueId?, karigarRef?, notes?, lines: [{ kind: 'made', skuId, orderId?, tagNo?, description?, designCode?, grossWeight, stoneWeight?, hallmarked?, oldHallmark?, huids?, stones?, work? (jewellery, diamond), labourBasis?, labourRate? } \| { kind: 'repaired', pieceId \| tag, grossWeight, stoneWeight?, work?, labourBasis?, labourRate?, description? } \| { kind: 'metal', metal, purity, netWeight, fineness?, description? } \| { kind: 'stone', description, pieces?, carat? }] }` (a made piece with inventory.edit; labour typed only with purchasing.view) → 201 the receipt (KR/…) with `lines[]` (`labour`, `wastage_weight`, `wastage_fine`, `tag_no`, `order_no`), `made`, `repaired`, `labour`, `unbilled`. A piece made is tagged into stock at its labour's cost (`jewellery_piece.tagged`; the core's `stock.adjusted`); a repair comes back weighed; metal goes into the shop's metal; an order's piece (the line's `orderId`, else the challan's order while it is open and of the piece's purity; otherwise the piece is the shop's own) moves it to received. 400 a HUID on a piece not hallmarked; 404; 409 another karigar's challan, a piece not with this karigar, a tag in use, a line's order delivered, cancelled or of another purity. Audited and evented `jewellery_karigar.received` |
| `GET /jewellery/karigars/receipts` | jewellery.view | The receipts, newest first: `receipt_no`, `karigar_name`, `issue_no`, `karigar_ref`, `made`, `repaired`, `labour`, `unbilled`, `to_bill`. Filters `karigar`, `location`, `to_bill` |
| `GET /jewellery/karigars/receipts/:id` | jewellery.view | The receipt with `lines[]` (`kind_words`, `work_words`, `invoice_document_id`) |
| `POST /jewellery/karigars/:id/write-off` | jewellery.approve | `{ requestKey, metal, purity, reason }` → 201 the karigar: all they hold of the purity written off. 409 nothing held. Audited and evented `jewellery_karigar.written_off` |
| `POST /jewellery/karigars/invoices` | jewellery.edit and purchasing.create | `{ requestKey, contactId, locationId?, lines?: [{ receiptId, seq }] (all labour not invoiced yet when left out), supplierBillNo?, supplierBillDate?, notes? }` → 201 the invoice: a core purchase (PR/…) of the labour item (a service: no stock), each line at 5% (jewellery work) or 1.5% (diamond work) from a karigar with a GSTIN, 0% from one without (`registered`, `document_no`, `subtotal`, `tax`, `total`, `lines[]`). 409 no labour to invoice, labour of another karigar or invoiced already; 409 no slab for the labour item. Audited and evented `jewellery_karigar.invoiced`; the core's `purchase.posted` |
| `GET /jewellery/karigars/itc-04` | jewellery.export | `?from&to` (the month to today; up to a year) → `{ from, to, rows[], note }`: each line sent (`part` sent, `table` 4) and received back (received, 5A; and the wastage allowed), with `day`, `challanNo` (their own number when given), `originalNo`, `originalDay`, `karigar`, `gstin`, `goods`, `uqc` (GMS, NOS), `quantity`, `fineWeight`, `value`. Nothing is filed |

- The number series kinds `karigar_issue` (KI) and `karigar_receipt` (KR) number the challans and receipts.

**Custom orders**

Advances and the rate fixed are money: sent only to a role with `sales.view` (null otherwise).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /jewellery/orders` | jewellery.create (with sales.view) | `{ requestKey, locationId, contactId \| customer: { name, phone?, consents? } (with contacts.create), skuId?, description, designRef?, metal, purity, weightFrom?, weightTo?, size?, stones?, promisedOn?, notes?, advance?: { amount, method (cash, upi, card, bank) \| methodId, reference?, fixRate? } (with sales.edit) }` → 201 the order (CO/…; number series kind custom_order). The advance is a collection receipt (RC/…) held for the order; `fixRate` fixes the day's latest selling rate for the purity on the grams it buys. 400 a day promised before today; 409 no rate today to fix. Audited and evented `jewellery_order.booked`, `jewellery_order.advance`; the core's `collection.recorded` |
| `GET /jewellery/orders` | jewellery.view | The orders, newest first: `order_no`, `customer_name`, `customer_phone`, `item_label`, `description`, `design_ref`, `metal`, `purity`, `promised_on`, `status`, `fixed_rate`, `fixed_weight`, `advances`, `pieces`, `open`, `late`, `document_no`, `design_photo_id`. Filters `status`, `open`, `late`, `contact`, `location` |
| `GET /jewellery/orders/:id` | jewellery.view | The order with `status_words`, `purity_words`, `advance_list[]` (`kind`: money or old_gold, `amount`, `fixes_rate`, the receipt or voucher), `made[]` (its pieces), `issues[]` and `receipts[]` |
| `PUT /jewellery/orders/:id` | jewellery.edit | `{ promisedOn?, notes? }` → the order. 400 a new day promised before today (one already past may stay); 409 delivered or cancelled. Audited `jewellery_order.updated` |
| `POST /jewellery/orders/:id/advances` | jewellery.create and sales.edit | `{ requestKey, amount, method \| methodId, reference?, fixRate? }` (money) or `{ requestKey, oldGoldId, fixRate? }` (the customer's old gold, all its value) → 201 the order. 409 delivered or cancelled, the rate fixed already, another customer's or a cancelled voucher, nothing left on it, a voucher held for another open order. Audited and evented `jewellery_order.advance` |
| `POST /jewellery/orders/:id/pieces` | jewellery.edit | `{ pieceId \| tag }`: a piece in stock of the order's purity made its own → 201 the order (received). 409 a piece of another order, not in stock, of another purity; an order at the centre, delivered or cancelled |
| `POST /jewellery/orders/:id/ready` | jewellery.edit | → the order, ready. 409 not received or hallmarked, a piece of it still out. Audited and evented `jewellery_order.ready` |
| `POST /jewellery/orders/:id/cancel` | jewellery.cancel | `{ reason }` → the order, cancelled (its advances the customer's again); cancelling again changes nothing. 409 delivered, at the centre. Audited and evented `jewellery_order.cancelled` |

- A jewellery bill with `order` delivers it (409 an order not ready, another customer's): its pieces join the bill; the grams fixed are priced at the order's rate and the rest at the day's (each line's `fixedWeight`, `fixedRate`); its receipts pay first as far as the bill needs them, then its old gold. The preview adds `order` (`orderNo`, `fixedRate`, `fixedWeight`, `tags`, `receipts[]`, `pays`) and `orderPaid`; the bill, `order`. Audited and evented `jewellery_order.delivered`.
- `POST /receivables/customers/:id/apply-advance` leaves out an open order's receipts; another bill, a collection refund, an old gold payout or another bill's use of a voucher held for an open order is refused (409, from the database).

**Approval challans**

Every route needs `sales.view` too (403 otherwise).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /jewellery/approvals` | jewellery.edit | `{ requestKey, locationId, contactId \| customer: { name, phone?, gstin?, consents? } (with contacts.create), party (customer, jeweller), dueOn, tags: [..] (1-50), notes? }` → 201 the challan (AP/…; number series kind approval): its pieces on approval. 400 a day due before today, a tag twice; 404 a tag; 409 a piece not in stock at the location. Audited and evented `jewellery_approval.sent` |
| `GET /jewellery/approvals` | jewellery.view | The challans, newest first: `approval_no`, `party_name`, `party_phone`, `party`, `due_on`, `days_out`, `state` (out, overdue, closed), `pieces`, `pieces_out`, `pieces_sold`, `net_out`, `tags`. Filters `state`, `party`, `contact`, `location` |
| `GET /jewellery/approvals/:id` | jewellery.view | The challan with `lines[]` (each piece's `outcome`: out, returned, sold, with its sale's `document_no`), `party_words` and `gst_note` |
| `POST /jewellery/approvals/:id/returns` | jewellery.edit | `{ requestKey, tags: [..], note? }` → 201 the challan: those pieces back in stock. 409 a piece not on the challan, back or sold already. Audited and evented `jewellery_approval.returned` |

- A jewellery bill with `approval` sells the pieces on it that are out on the challan, to its customer (409 another customer, a piece back or sold already, none of the pieces out on it). Audited and evented `jewellery_approval.sold`.

**Hallmarking**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /jewellery/hallmarking` | jewellery.edit | `{ requestKey, locationId, contactId (the centre, a supplier) \| centre: { name, gstin?, phone? } (with contacts.create), requestRef?, notes?, tags: [..] (1-200) }` → 201 the consignment (HM/…; number series kind hallmark_consignment; `form` HM/JWLR/F 1.3): its pieces at the centre, an order with a piece there at the centre. 404 a tag, a centre not a supplier; 409 a piece not in stock at the location, not gold or silver. Audited and evented `jewellery_hallmarking.sent` |
| `GET /jewellery/hallmarking` | jewellery.view | The consignments, newest first: `consignment_no`, `centre_name`, `request_ref`, `state` (at_centre, returned), `pieces`, `hallmarked`, `rejected`, `net_weight`, `charges_total` (with purchasing.view), `tags`. Filters `state`, `centre`, `location` |
| `GET /jewellery/hallmarking/:id` | jewellery.view | The consignment with `lines[]` (`result`: out, hallmarked, rejected; `huids`, `charge` with purchasing.view) |
| `POST /jewellery/hallmarking/:id/return` | jewellery.edit (purchasing.create to post charges) | `{ requestKey, centreBillNo?, centreBillDate?, gstRate? (18, 0), lines: [{ tag \| pieceId, result (hallmarked, rejected), huids: [..] (hallmarked), charge? (with purchasing.view; the shop's hallmarking charge when left out) }] (every piece sent) }` → 201 the consignment: the pieces back in stock, hallmarked ones with their HUIDs and charge (no longer waiting to be re-hallmarked); the charges a purchase from the centre (no stock). 400 a piece not said, a HUID twice, a rejected piece with a HUID; 409 back already, a HUID on another piece. Audited and evented `jewellery_hallmarking.returned` |
| `GET /jewellery/hallmarking/huids` | jewellery.export | `?status=` (in_stock, sold_consumer, sold_jeweller, returned, melted) → `{ items[], statuses[], note }`: each HUID with `tag`, `piece`, `purity`, `status`, `statusWords`, `day` and the sale's `documentNo`. Manak Online's file format was not checked: the list is plain |

- A jewellery bill refuses a gold piece with the old hallmark where a HUID is needed (409 "… carries the old hallmark without a HUID: it is re-hallmarked before it is sold here").

**Splitting, merging, new tags and photos**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /jewellery/pieces/:id/split` | jewellery.edit and inventory.edit | `{ requestKey, parts: [{ tagNo?, description?, grossWeight, stoneWeight?, huids?: [..] (the piece's own), stones?: [seq, ..] (its stone lines) }] (2-10) }` → 201 `{ pieces[] }`: the new pieces, the old one split. 400 the weights not the piece's, a HUID or stone line not placed once; 409 a piece not in stock, a tag in use. Audited and evented `jewellery_piece.split`; the core's `stock.adjusted` |
| `POST /jewellery/pieces/merge` | jewellery.edit and inventory.edit | `{ requestKey, tags: [..] (2-10), tagNo?, description?, designCode?, skuId?, makingMode?, makingValue?, wastagePercent? (with sales.view) }` → 201 the merged piece. 400 pieces of more than one purity or location, charged differently with no making charge given; 409 a piece not in stock, one waiting to be re-hallmarked with pieces that carry HUIDs. Audited and evented `jewellery_piece.merged` |
| `POST /jewellery/pieces/:id/retag` | jewellery.edit and inventory.edit | `{ requestKey, tagNo? }` → 201 the piece under its new tag, with its HUIDs, stones, cost, photo and order. 409 a piece not in stock, a tag in use. Audited and evented `jewellery_piece.retagged` |
| `POST /jewellery/files` | jewellery.edit (a piece) or jewellery.create (an order, old gold with sales.view, a KYC document) | Multipart: `pieceId`, `orderId`, `oldGoldId` or `kycId`, and `file` (JPG, PNG or WebP, its bytes checked, up to 5 MB; a KYC copy may be a PDF) → 201 `{ id, kind (photo, design, old_gold, kyc), piece_id, order_id, old_gold_id, kyc_id, file_name, mime_type, size_bytes }`; a new one takes the old one's place (old gold keeps up to ten). 400 not a photo (or PDF), too large; 409 a piece that has left the shop, an order delivered or cancelled, old gold cancelled or with ten photos, a KYC document set aside. Mounted before the JSON-only router. Audited `jewellery_piece.photo_added` / `jewellery_order.design_added` / `jewellery_old_gold.photo_added` / `jewellery_kyc.copy_added` |
| `GET /jewellery/files/:id` | jewellery.view (old gold with sales.view; a KYC copy jewellery.manage) | The file itself (`Cache-Control: private, no-store`) |
| `DELETE /jewellery/files/:id` | jewellery.edit / jewellery.create (a KYC copy jewellery.manage) | → `{ id, removed }`: taken off (kept). Audited `jewellery_piece.photo_removed` / `jewellery_order.design_removed` / `jewellery_old_gold.photo_removed` / `jewellery_kyc.copy_removed` |

**The fine-weight book**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/fine-weight` | jewellery.view | `?from&to` (the month to today) → `{ today, from, to, purities[], counts[], holders }`: each purity's `opening`, `movements[]` (each `kind` that changed the total, `net`, `fine`), `within[]` (each move inside the shop: `moved` and `moves[]` by holder), `closing` and `holders[]` (stock, approval, karigar, centre, metal, karigar_metal); and the latest count of each location |
| `POST /jewellery/fine-weight/counts` | jewellery.edit | `{ requestKey, locationId, notes?, purities: [{ metal, purity, tags: [..], metalWeight?, metalFineness? }] }` → 201 the count with `lines[]` (`book_pieces`, `counted_pieces`, `missing_tags`, `extra_tags`, `pieces_difference`, `book_metal_fine`, `counted_metal_fine`, `metal_difference`). 400 a purity twice. Audited and evented `jewellery_fine.counted` |
| `GET /jewellery/fine-weight/counts/:id` | jewellery.view | The count |

**The metal account with suppliers**

Every route needs `purchasing.view` too (403 otherwise).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /jewellery/metal-account` | jewellery.view | `{ items[] }`: each supplier with `balances[]` (by purity: `owed`, `owed_fine`, `received`, `given`, `fixed`, `fixed_amount`) and `owedMoney` |
| `GET /jewellery/metal-account/entries` | jewellery.view | The vouchers and fixes, newest first: `voucher_no`, `supplier_name`, `kind` (received, given, fixed), `metal`, `purity`, `net_weight`, `fine_weight`, `rate`, `amount`, `document_no`. Filters `supplier`, `kind`, `metal`, `purity`, `location` |
| `GET /jewellery/metal-account/:id` | jewellery.view | One supplier's balances, entries and money owed |
| `POST /jewellery/metal-account/entries` | jewellery.edit and purchasing.create | `{ requestKey, kind (received, given), contactId (a supplier), locationId, metal, purity, netWeight, description?, notes? }` → 201 the supplier's account; a metal voucher (MV/…; number series kind metal_voucher), the metal into or out of the shop's metal. 409 more given than the location holds. Audited and evented `jewellery_metal.received` / `jewellery_metal.given` |
| `POST /jewellery/metal-account/fix` | jewellery.approve and purchasing.create | `{ requestKey, contactId, locationId, metal, purity, netWeight? (all that is owed when left out), rate? (today's selling rate when left out), supplierBillNo?, supplierBillDate?, notes? }` → 201 the supplier's account: the grams fixed as a purchase from them at 3% (no stock). 409 nothing owed, more than is owed, no rate today. Audited and evented `jewellery_metal.fixed`; the core's `purchase.posted` |

## Rentals & hire

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `rentals`, permission). The lists take `limit` (up to 100), `offset`, `q` and their filters (`from` and `to` on the business's dates: when the booking goes out, or when its first deposit was taken) and answer `{ total, items }`. Backend module `modules/business/rentals/` (routes `businessRentals.routes.js`; the photos and signatures `rentalsUploads.routes.js`). A route that needs a `rentals.*` permission answers 403 while the module is off, and so for every other type of business, which never has it; the rental items and settings (a catalogue or settings permission) answer 404 for another type. Times are instants: they are typed as a wall-clock time on the business's clock (`2026-10-26T10:00`) or with an offset (`2026-10-26T04:30:00Z`), kept to the minute, and every "today", "now" and "overdue" is on the business's clock. Money answers are sent only to a role with `sales.view`: for anyone else the rates, hire, deposits, charges, receipts and bills are `null` or empty (`money: false`).

**Rental items and settings**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /rentals/items` | rentals.view | `{ items[], classes[], warnings[], settings }`: each item (`sku_id`, `name`, `item_code`, `tax_rate`, `tax_rate_id`, `hsn_code`, `item_active`, `kind` (unit, pool, kit), `pool_quantity` (the total), `counts[]` (`location_id`, `location_name`, `quantity`: a pool at each location), `parts[]` (a kit's `item_id`, `name`, `quantity` in one kit), `kit_billing` (kit, parts), `class_id`, `class_name`, `vehicle`, `with_driver`, `meter`, `description`, `deposit`, `rate_hour`, `rate_day`, `rate_week`, `rate_month`, `min_hours`, `buffer_minutes`, `grace_minutes`, `late_per` (none, hour, day, slabs), `late_rate`, `late_slabs`, `late_cap`, `km_allowance`, `km_per`, `extra_km_rate`, `fuel_per`, `fuel_rate`, `tank_litres`, `sort_order`, `active`, `units[]` (`id`, `label`, `serial_no`, `meter_reading`, `status`, `status_note`, `location_id`, `location_name`, `vehicle_class`, `engine_cc`, `length_mm`, `fuel_type`, the papers' dates `rc_valid_until`, `permit_valid_until`, `insurance_valid_until`, `puc_valid_until`, `fitness_valid_until`, `service_per`, `service_every`, `serviced_at`, `serviced_meter`, and for a self-drive vehicle `slab` (the like goods' rate its facts make, or null), `slab_matches`, `slab_warning`), `units_in_service`, `out_now`), those in use first; each class (`name`, `checklist`, `late_slabs`, `late_cap`, `active`, `items`); `warnings` (each unit in service whose slab does not match its item's); the settings as `GET /rentals/settings` |
| `POST /rentals/items` | catalog.edit | `{ skuId }` (an existing service item counted in services) or `{ item: { name, taxRateId? (the business's default slab), hsnCode?, code? (RNT-01…) } }` (a new service item named as the item, unit service, its own price nil), `kind` (unit, pool, kit), `poolQuantity` and `locationId?` (a pool, 1-1,000,000, kept at the business's first location unless named), `kitBilling` (kit: its own rates; parts: its parts' rates) and `parts: [{ itemId (an item from a pool), quantity (in one kit) }]` (a kit, 1-30 parts, each once), `vehicle?` (car, motorcycle, other; a unit item), `withDriver?`, `meter?` (km, hours; a vehicle's is km), `classId?`, `description?`, `deposit?` (each one), `rates: { hour?, day?, week?, month? }` (at least one; none for a kit billed by its parts), `minHours?` (0-2,160), `bufferMinutes?` (0-10,080), `graceMinutes?` (0-1,440), `latePer?` (none, hour, day, slabs; by the hour while there is an hour rate, else by the day; a kit's is none: its parts'), `lateRate?` (by slabs: the hour rate their multiples apply to; empty, the hour rate), `lateSlabs?: [{ from (hours late; the first 0, rising), flat, times (the hour rate) }]` (up to 10; empty: the class's), `lateCap?` (the most for each one), `km?: { allowance (0-100,000), per (day, booking), rate }` (an odometer), `fuel?: { per (eighth, litre), rate, tankLitres? (by the litre) }` (a vehicle), `sortOrder?`, `units?: [{ label, serialNo?, meterReading?, locationId? }]` (up to 200) → 201 `{ items, classes, warnings, settings }`. 404 an item, class, part or location not found; 400 goods or a kit of the catalogue, no rate, a late fee with no rate to charge, slabs with no class or rate, a kit's part hired one by one or a kit, a fuel charge on what is not a vehicle, a litre charge without the tank's size, kilometres without an odometer; 409 an item already a rental item, a number on another unit, a class or part switched off. Audited `rental_item.created`, `rental_unit.created` |
| `PATCH /rentals/items/:id` | catalog.edit | Any of `POST`'s rules (`rates` as a whole set; `km`, `fuel` and `lateSlabs` null to take them off), `poolQuantity?` with `locationId?` (a pool: that location's count; the location is needed when the business has more than one), `kitBilling?` and `parts?` (a kit; bookings keep the parts they were made with), `classId?`, `withDriver?` (a vehicle), `meter?`, `active?`; what is left out stays → as `GET`. Bookings keep what they were made at. 400 a change of kind or vehicle, a count without its location; 409 a location's count set below what its bookings reserved or out hold at their busiest over the next 100 days. Audited `rental_item.updated` (from and to, and the parts) |
| `POST /rentals/items/:id/units` | catalog.edit | `{ label, serialNo? (a vehicle's registration, required), meterReading?, locationId? (kept at; the first location) }` → 201 as `GET`. 400 a pool's or a kit's item; 409 a name already on the item, a number on another unit. Audited `rental_unit.created` |
| `PATCH /rentals/units/:id` | catalog.edit (name, number, vehicle, papers, schedule) or rentals.edit (state) | `{ label?, serialNo?, status? (available, maintenance, retired), statusNote? (required unless available), vehicleClass? (MC50CC, MCWOG, MCWG, LMV-NT, LMV, TRANS), engineCc?, lengthMm?, fuelType? (petrol, diesel, cng, lpg, electric), rcValidUntil?, permitValidUntil?, insuranceValidUntil?, pucValidUntil?, fitnessValidUntil?, servicePer? (hours, km, days; hours and km by the unit's meter), serviceEvery? }` (null takes one off) → as `GET`; a schedule set counts from now, at the meter's reading. 400 vehicle facts or papers of what is not a vehicle, a schedule by a meter the unit lacks; 409 retiring a unit booked or out (the booking named). Audited `rental_unit.updated` (from and to) |
| `POST /rentals/classes`, `PATCH /rentals/classes/:id` | catalog.edit | `{ name, checklist?: [point] (up to 30, each 1-80 characters, each once), lateSlabs?: [{ from, flat, times }], lateCap?, active? (change) }` → 201 or 200 as `GET`. 409 a name already used, switching off a class whose slabs an item uses. Audited `rental_class.created`, `rental_class.updated` |
| `GET /rentals/settings` | rentals.view | `{ idRequired, terms, papersWarnDays, papersUrgentDays, papersLapsed, cancelSlabs, noShowPercent, updatedAt }`; until saved `idRequired` true, 30 and 7 days, `refuse`, no slabs |
| `PUT /rentals/settings` | settings.edit | `{ idRequired?, terms? (up to 2,000 characters), papersWarnDays? (1-365), papersUrgentDays? (0-365, fewer than the first), papersLapsed? (warn, refuse), cancelSlabs?: [{ hours (before the out time, 0-2,160, each different), percent }] (up to 10; null for none), noShowPercent? }`; what is left out stays → the settings. Audited `rental_settings.updated` (from and to) |

**Bookings**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /rentals/bookings` | rentals.view | Every booking by when it goes out, the latest first: `booking_no`, `location_id`, `location_name`, the hirer (`contact_id`, `customer_name`, `customer_phone`), `status`, `out_at`, `due_at`, `checked_out_at`, `returned_at`, `cancelled_at`, `total`, `deposit_due`, `document_id`, `document_no`, `notes`, `lines`, `pieces`, `items` (what is hired, in words), `deposit_collected`, `deposit_held`, `advance`, `advance_left`, `bill_due`, `stage` (quote, reserved, out, due_today, overdue, to_settle, closed, cancelled), `overdue`, `due_today`, `pickup_today`, `late_pickup`, `out_now`, `open`. Search booking, hirer, phone, items, bill and notes; filters `stage`, `status`, `location`, `contact`, `overdue`, `due_today`, `pickup_today`, `late_pickup`, `out_now`, `open` |
| `GET /rentals/bookings/open` | rentals.view | The open bookings (quote, reserved or out, or with a bill due or money held), as above, in the board's order |
| `GET /rentals/bookings/board` | rentals.view | `{ counts: { quote, reserved, out, due_today, overdue, to_settle, pickup_today, late_pickup, out_now, deposits_held }, items[] }`: the open bookings by stage (the person's own location when they are tied to one), up to 300 |
| `POST /rentals/bookings/preview` | rentals.view | `{ locationId, outAt, dueAt, lines, discount?: { percent, reason }, bookingId? (a booking being changed: its own holds left out) }` → `{ taxMode, outAt, dueAt, minutes, lines[] (`itemId`, `itemName`, `kind`, `unitId`, `unitLabel`, `serialNo`, `quantity`, `hours` charged, `period` (the mix in words), `price` of one, `amount`, `discount`, `taxRate`, `net`, `tax`, `deposit`, `billed`, `kitBilling`, `parts[]` (a kit's, as a line, with `each`, `free`, `words`), `kept` (booked rates kept), `latePer`, `lateRate`, `graceMinutes`, `bufferMinutes`, `free`, `left` (a pool), `words` (why not free, at the booking's location)), subtotal, tax, round_off, total, discount, discountPercent, deposit, free }`; nothing is saved |
| `POST /rentals/bookings` | rentals.create; sales.edit for an advance; contacts.create for a new hirer; sales.discount for a discount | `{ requestKey, locationId, status? (reserved, the default, or quote), contactId \| customer: { name, phone? }, outAt (today or later), dueAt (after it, at most 90 days), notes?, lines: [{ itemId, unitId? (an item hired one by one) \| quantity? (a pool, or how many kits) }] (1-50, a kit's parts counted; a unit once, a pool item once besides kits' parts), discount?: { percent (within the business's most bill discount; the owner, any), reason }, advance?: { amount (at most the hire), method (cash, card, upi, bank) \| methodId, reference? } }` → 201 the booking (as `GET /rentals/bookings/:id`). A kit's parts become lines of their own, as many as it has of each. A reserved booking is checked against what is free at its location (units kept there, the location's pools; maintenance booked holds a unit), and the database checks it again when saved. 404 an item or unit not found; 409 an item switched off, a retired unit, more than the pool has, a unit kept at another location, a unit or pieces not free (the sentence names the booking, or the maintenance, and times), a discount above the most, an advance on a quote; 403 a discount without `sales.discount`; the same `requestKey` with other data 409. Audited and evented `rental_booking.created` (and `collection.recorded`) |
| `GET /rentals/bookings/:id` | rentals.view | The booking: its fields, `period` (in words), `overdue`, `late_minutes`, `today`, `location_name`, `created_by_name`, `checked_out_by_name`, `deposit_waived_by_name`, `cancelled_by_name`, `document_no`; `lines[]` (each with its rates and rules as booked, the mix, `price`, `amount`, `tax_rate`, `net`, `tax`, `deposit_each`, what was noted at the handover, `kind`, `vehicle`, `with_driver`, `meter`, `unit_status`, `unit_meter`, `tax_rate_now`, `back`, `missing`, `left`, `period`, and while out `late_fee_now` and `late_units_now`); `returns[]` (`final`, `note`, `created_at`, `by_name`, `lines[]` with what came back, the meter and fuel, the late minutes, units and fee, `maintenance`); `charges[]`; `receipts[]` (`purpose`, `collection_no`, `amount`, `method`, `method_name`, `reference`, `created_at`, `free`, `used`, `refunded`, `refunds[]`); `deposit` (`collected`, `applied`, `refunded`, `held`, `due`); `advance_summary` (`taken`, `applied`, `refunded`, `left`); `bill` (`document_no`, `total`, `returned`, `paid`, `refunded`, `due`); `events[]`; `pending` (while out: the bill if everything came back now, the late fee so far, what is held, `to_pay`, `back`); `terms`, `id_required`, `papers_lapsed`, `seller`, `timezone`, `money`; the discount (`discount_percent`, `discount_reason`, `discount_by_name`); each line also `kit_line_id`, `part_quantity`, `billed`, `discount`, its rules as booked (`late_slabs`, `late_cap`, `km_allowance`, `km_per`, `extra_km_rate`, `fuel_per`, `fuel_rate`, `tank_litres`), its class's `checklist` and a vehicle's `papers` (each `until`, `lapsed`); each return line its `extra_km`, `km_fee`, `fuel_short`, `fuel_fee`; `hirer` (the hirer register written at the handover, with `original_held`, `original_returned_at`, `original_returned_by_name`), `conditions[]` (`line_id`, `stage`, `checks`, `by_name`), `files[]` (`id`, `line_id`, `stage`, `kind`, `signer`), `cancellation` |
| `PATCH /rentals/bookings/:id` | rentals.edit; sales.discount for a discount | `{ outAt?, dueAt?, lines?, discount? ({ percent, reason }, or null to take it off), notes? }`: a quote or a reserved booking changes its times, lines, discount and notes (lines kept keep their booked rates; a kit kept keeps its parts); one out only its due back time (still to come), discount and notes (an extension, priced again at the booked rates); what is left out stays → the booking. 409 returned or cancelled, an out booking's out time or lines, not free, a hire below the advance taken, a discount above the most. Audited and evented `rental_booking.changed` |
| `POST /rentals/bookings/:id/confirm` | rentals.create | A quote reserved (checked against what is free) → the booking; a reserved one answers as it is. 409 not a quote, its out day passed, not free. Audited and evented `rental_booking.reserved` |
| `POST /rentals/bookings/:id/receipts` | rentals.edit and sales.edit | `{ requestKey, purpose (advance, deposit), amount, method (cash, card, upi, bank) \| methodId, reference? }` → 201 the booking: a collection receipt in the hirer's name held for the booking. 400 advances above the hire; 409 a booking not reserved or out. Audited and evented `collection.recorded` |
| `POST /rentals/bookings/:id/checkout` | rentals.edit; sales.edit with a deposit; rentals.approve (or a manager's PIN) for less deposit | `{ requestKey, idKind? (aadhaar, voter_id, driving_licence, passport, pan_card, other), idRef? (of an Aadhaar the last four digits only), licenceNo?, licenceValidUntil?, register?: { address, licenceAuthority, licenceClasses (MC50CC, MCWOG, MCWG, LMV-NT, LMV, TRANS), licenceIssuedOn, foreigner?, passportNo, passportAuthority, passportNation, passportIssuedOn, passportValidUntil, birthDate (a foreign national), permitNo?, permitIssuedOn?, permitClasses?, visaNo?, visaValidUntil? }` (a self-drive vehicle: the hirer register), `originalHeld?` (the original document held; never a copy), `lines?: [{ lineId, note?, meter?, fuel? (empty, one_eighth, quarter, three_eighths, half, five_eighths, three_quarters, seven_eighths, full), checks?: [{ point, ok, note? (when not ok) }] (each point of the item's class) }]`, `scanned?: [code]` (barcodes or serials scanned; each one of the booking's units), `deposit?: { amount, method \| methodId, reference? }, waiver?: { reason, approverId?, pin? }, note? }` → the booking, out, with `warnings[]` (papers run out, when the shop warns). 400 the ID asked by the settings, a meter to read, a vehicle's fuel, a checklist not checked (or a point not ok without why), a self-drive vehicle's licence or register, a foreign national's passport or date of birth; 409 a quote, not reserved, before its out time or past its due back time, a unit in maintenance or retired, a meter below its last reading, a code not on the booking, a vehicle's paper run out (unless the shop only warns), a licence, passport or visa run out, a licence class that does not cover a self-drive vehicle's class (also the database), the location's rent-a-cab or rent-a-motorcycle licence not in force (or *Licences & registrations* off), the deposit short with no one agreeing; a second handover with another key 409. Audited and evented `rental_booking.checked_out` |
| `POST /rentals/bookings/:id/returns/preview` | rentals.edit | `{ lines, charges? }` (as below; the checklist is asked for with the return itself) → `{ final, lateMinutes, lateFee, kmFee, fuelFee, lines[] (lineId, itemName, unitLabel, quantity, missing, lateUnits, latePer, lateFee, extraKm, kmFee, fuelShort (eighths), fuelFee), bookingNo }` and, when the last of it comes back, `subtotal`, `tax`, `round_off`, `total`, `advance`, `deposit`, `due`, `depositBack`, `advanceBack`, `bill[] (label, quantity, net, tax)`; nothing is saved or locked |
| `POST /rentals/bookings/:id/returns` | rentals.edit; sales.create for the bill; sales.edit for a payment; rentals.refund for a refund | `{ requestKey, lines: [{ lineId (a kit comes back by its parts' lines), quantity? (all that is still out of it), missing?, note?, meter?, fuel?, maintenance?, checks? (the class's checklist, of what comes back) }], charges?: [{ lineId, kind (damage, missing, cleaning, fuel, other), amount, note? (required for damage and other) }], scanned?: [code] (each a unit still out on the booking), originalReturned? (the original document held goes back), note?, payment? \| payments?, refund?: { method (cash, upi, bank) \| methodId, reference? }, approval?: { approverId?, pin, reason? }, buyer?: { pan?, panDeclaration? } }` → 201 the booking. Each line back pays its late fee (by the hour, the day or slabs, never more than the cap), its kilometres beyond the booked allowance and its fuel short, at the booked rates (the database works each out again). With the last of it back the bill is posted by the core (each billed line's hire less the discount, every late fee, kilometre and fuel charge and charge, each at its item's GST rate of the day), paid by the advance, then the deposit, then the payment; with `refund` what is left of the receipts goes back, deposits first, with a manager's approval (a role with `rentals.refund`, and their PIN). 400 a kit's own line, a payment or refund before the last of it is back, a checklist not checked; 409 a booking not out, more back than is out, a meter below the handover's, a code not out on the booking, no original held; the same `requestKey` answers the same return. Audited and evented `rental_booking.returned` (and `sale.posted`, `payment.recorded`, `collection.refunded`) |
| `GET /rentals/bookings/:id/cancel/preview` | rentals.cancel | What cancelling now would charge: `{ slabs, worked }`, and when worked out `hoursBefore` (less than 0: past the out time), `percent`, `noShow`, `lines[] (lineId, itemName, unitLabel, amount)`, `charge`, `subtotal`, `tax`, `round_off`, `total`, `held`, `toPay`, `back` (money for those who see sales) |
| `POST /rentals/bookings/:id/cancel` | rentals.cancel; sales.create for a charge; rentals.refund for a refund; rentals.approve (or a manager's PIN) to waive | `{ requestKey, reason, charges?: [{ lineId, amount, note? }] (typed only while the shop has no cancellation slabs), waive?: { reason, approverId?, pin? }, payment? \| payments?, refund?: { method \| methodId, reference? }, approval?: { approverId?, pin }, buyer? }` → the booking, cancelled. With the shop's slabs a reserved booking's charge is worked out from the hours left before its out time (the slab with the most hours they reach; past the out time, the no-show percent), that share of each billed line's hire less its discount, kept as `cancellation` (`hours_before`, `percent`, `worked_out`, `charged`, `waiver`, `waived_by_name`); a waiver charges nothing. A charge is billed (each at its line's slab) and paid from what is held first; with `refund` what is left goes back with a manager's PIN. 409 a booking out (it comes back first), returned or cancelled, a typed charge with slabs set, a waiver with nothing worked out. Audited and evented `rental_booking.cancelled`; a waiver also audited `rental_booking.cancellation_waived` (by the manager) |
| `POST /rentals/bookings/:id/scan` | rentals.edit | `{ code (a unit's barcode or serial, or its name; letters and digits compared), stage? (out, the default; in: a unit still out) }` → `{ code, lineId, itemName, unitLabel, serialNo }`. 409 not on the booking ("… is not on booking RN/…: put it aside"), back already |
| `POST /rentals/bookings/:id/original-back` | rentals.edit | The original document held at the handover handed back now (once) → the booking. 409 none held. Audited `rental_booking.original_returned` |
| `POST /rentals/bookings/:id/refund` | rentals.refund | `{ requestKey, amount? (all that is held), method (cash, upi, bank) \| methodId, reference?, reason, approverId?, pin }` → 201 `{ refunds[] (refund_no, amount, method, purpose, collection_no, approved_by_name, …, repeated), repeated, booking }`: a numbered refund of each receipt, deposits first. 409 a booking not back or cancelled, nothing held, more than is held. Audited and evented `collection.refunded` |
| `GET /rentals/approvers` | rentals.edit, rentals.cancel or rentals.refund | `?permission=` `rentals.refund` (the default) or `rentals.approve` → `[{ id, name, has_pin }]`: the members who may approve that |

**What is free and the deposits held**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /rentals/availability` | rentals.view | `?from` (YYYY-MM-DD, today), `days` (1-31, 7), `item?`, `location?` (the person's own, or the first) → `{ from, to, days[], timezone, locationId, locationName, items[] }`: each item in use at the location (a kit is shown by its parts); a unit item with `units[]` kept there (`unitId`, `label`, `serialNo`, `status`, `statusNote`, `days[]` with the `holds` on each day), a pool with `poolQuantity` (the location's) and `days[]` (`held` at its busiest, `free`, `holds`). Each hold: `bookingId`, `bookingNo`, `customerName` (maintenance: its reason), `status`, `part` (booked, out, back, downtime), `quantity`, `startsAt`, `endsAt`, `dueAt` |
| `GET /rentals/free` | rentals.view | `?outAt&dueAt&booking?&location?` (a booking being changed: its own holds left out) → `{ outAt, dueAt, locationId, items[] }`: each unit with `free`, `elsewhere` (kept at another location) and the `clash`, each pool with `held` and `free` at the location, each kit with how many are `free` (its scarcest part) and its `parts[]`, over that time and the item's turnaround time |
| `GET /rentals/deposits` | rentals.view and sales.view | Each booking that took a deposit, those holding money first (back or cancelled before those still out): `booking_no`, the hirer, `status`, `out_at`, `due_at`, `returned_at`, `cancelled_at`, `deposit_due`, `document_no`, `first_taken_at`, `receipts`, `collected`, `applied`, `refunded`, `held`, `holding`, `state` (held, to_hand_back, settled). Search booking, hirer, phone, receipts and bill; filters `state`, `holding`, `location`, `contact`, `status` |
| `GET /rentals/deposits/totals` | rentals.view and sales.view | `{ held, bookings, to_hand_back, to_hand_back_amount, collected, applied, refunded }` (the person's own location when they are tied to one) |

**Yard & fleet, the register and the reports**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /rentals/yard` | rentals.view | `{ units[], downtime[], pools[], transfers[], locations[], papersWarnDays, papersUrgentDays, papersLapsed }`: each unit in service of an item in use (with `item_name`, `location_name`, `papers` (each date with `until`, `daysLeft`, `state`: lapsed, urgent, soon, ok), `service` (`per`, `every`, and `dueAt` and `reading`, or `dueOn`; `due`), `last_service_at`); maintenance booked from now on; each pool's `counts[]` by location; the latest 100 transfers |
| `POST /rentals/transfers` | rentals.edit | `{ requestKey, itemId, unitId? (a unit) \| quantity and fromLocationId (pieces of a pool), toLocationId, note? }` → 201 the yard: moved now, with its date. 404 an item, unit or location not found; 400 a kit, the same location; 409 a unit booked or out from now on, more pieces than the location keeps, fewer left than its bookings hold at their busiest from now on; the same `requestKey` with other data 409. Audited and evented `rental_transfer.made` |
| `POST /rentals/units/:id/downtime` | rentals.edit | `{ requestKey, startsAt, endsAt (after it, at most 90 days, still to come), reason }` → 201 the yard: maintenance booked ahead, holding the unit. 409 a booking holds it over part of that time, maintenance already booked then (the database checks it); the same `requestKey` with other data 409. Audited and evented `rental_downtime.booked` |
| `POST /rentals/downtime/:id/cancel` | rentals.edit | Maintenance booked, cancelled (the unit is free again then) → the yard. Audited and evented `rental_downtime.cancelled` |
| `POST /rentals/units/:id/services` | rentals.edit | `{ meter? (not below its reading), note? }` → 201 the yard: a service done now; the schedule counts again from it. Audited `rental_unit.serviced` |
| `GET /rentals/register` | rentals.print | `?from&to` (this month so far) `&unit?` → `{ from, to, timezone, vehicles[] }`: each vehicle (`unitId`, `label`, `registration`, `itemName`, `vehicle`, `withDriver`, `vehicleClass`, `scheme`, `form` (Form 5 for a car, Form 3 for a motorcycle), `foreignForm` (Form 6, Form 4), `rows[]`, `foreignRows[]`); each hire handed over in the dates: `bookingNo`, `name`, `address`, `telephone`, `licence` (`number`, `authority`, `classes`, `issuedOn`, `validUntil`), `hiredAt`, `returnedAt`, `totalKm`, `signed` (the hirer's signature at the handover), `remarks`, `originalHeld`, and for a foreign national `passport` (`number`, `authority`, `nation`, `issuedOn`, `validUntil`), `birthDate`, `permit` (`number`, `issuedOn`, `classes`), `visa` |
| `GET /rentals/reports` | rentals.view | `?from&to` (this month so far; at most a year) → `{ from, to, money, units[], items[], totals: { hire, fees } }`: each unit (`unitId`, `label`, `serialNo`, `itemId`, `itemName`, `status`, `hires`, `daysOut`, `daysAvailable` (less maintenance booked), `use` (percent), `hire`, `fees` (late, kilometres, fuel, charges), the money on bills dated in the dates, before GST); each item (`kind`, its units added up; a pool by piece-days with `pool`; a kit by its own line's hire). Money is null for a role without `sales.view` |
| `POST /businesses/:businessId/rentals/files` | rentals.edit | Multipart (mounted before the `/businesses` router): `bookingId`, `stage` (out: while the booking is reserved or out; in: out or back), `kind` (photo, signature), `signer` (hirer, shop; a signature), `lineId?` (a photo of a line), `file` (JPG, PNG or WebP, up to 5 MB; the bytes are checked) → 201 `{ id, booking_id, line_id, stage, kind, signer, file_name, mime_type, size_bytes, created_at }`. 400 not a picture, too large; 409 a booking not at that stage, 20 photos of a stage already. Never changed or deleted. Audited `rental_booking.photo_added`, `rental_booking.signed` |
| `GET /businesses/:businessId/rentals/files/:fileId` | rentals.view | The picture itself (`no-store`, `nosniff`), to someone who sees the booking; 404 another business's or type's |

- `GET /notifications` (the bell), for a role with `rentals.view`: each booking past its due back time (warning), linking to it; the bookings past their out time and not handed over (info), linking to Bookings; under *Fleet*, each vehicle's paper running out (info from the warning days, warning from the urgent days) or run out (critical), and each unit whose service is due (warning), linking to Yard & fleet.
- `POST /documents` (a sale) and a quotation's bill refuse a rental item's service item (409: it is billed from its booking); the customer's *apply advance* leaves a booking's receipts alone.
- Number series: bookings are numbered in the kind `rental` (prefix `RN`), set per location like any other series.

## Fuel stations

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `fuel`, permission). The lists take `limit` (up to 100), `offset`, `q` and their filters (`from` and `to` on the business's dates) and answer `{ total, items }`. Backend module `modules/business/fuel/` (routes `businessFuel.routes.js`). A route that needs a `fuel.*` permission answers 403 while the module is off, and so for every other type of business, which never has it; the set-up routes (a catalogue or settings permission) answer 404 for another type. Readings, dips and densities are typed in: nothing here talks to a dispenser, a forecourt controller or a tank gauge. Litres (kilos for CNG) are sent and answered as text with three places, money with two, densities with one. Times are instants: typed as a wall-clock time on the business's clock (`2026-10-26T06:00`) or with an offset (`2026-10-26T00:30:00Z`), kept to the minute; every "today" and "this month" is on the business's clock. A board or register without `locationId` shows the person's own outlet, or the business's first. Posting routes take a `requestKey` (UUID): the same key with the same body gives the same answer, with another body 409.

**Set-up and prices**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /fuel/setup` | fuel.view | `{ products[], tanks[], dispensers[], measures[], settings, prices[], peso, today }`: each fuel (`sku_id`, `name`, `item_code`, `unit`, `tax_rate`, `hsn_code`, `family`, `sort_order`, `active`, `item_active`); each tank (`location_id`, `tank_no`, `capacity`, `product_name`, `family`, `active`, `last_dip`); each dispensing unit (`unit_no`, `make`, `serial_no`, `stamped_on`, `stamping_due`, `days_to_due`, `status`, `status_note`, `nozzles[]` with `nozzle_no`, `product_name`, `tank_no`, `reading`, `active`, `open_shift_no`, `open_attendant`); each measure (`name`, `litres`, `stamped_on`, `stamping_due`, `days_to_due`, `active`); the settings (below); the prices in force at each outlet (`price`, `effective_from`, `next_price`, `next_from`); `peso` (null while *Licences & registrations* is off; else each outlet's licence of kind `peso` in force or nearest, with `in_force`) |
| `POST /fuel/products` | catalog.edit | `{ skuId }` (an existing goods item: kept by quantity, in litres or kg, on the nil slab) or `{ item: { name, code? (FUEL-01…), hsnCode? } }` (a new goods item in litres, kilos for CNG, on the business's nil slab, its own price nil), `family` (petrol, diesel, cng), `sortOrder?` → 201 the set-up. 409 already a fuel, no nil slab switched on, an item that does not fit. Audited `fuel_product.created` |
| `PATCH /fuel/products/:id` | catalog.edit | `{ active?, sortOrder? }` → the set-up. 409 switching off a fuel a nozzle in use sells. Audited `fuel_product.updated` |
| `POST /fuel/tanks` | settings.edit; inventory.edit for the stock | `{ locationId, productId (not CNG), tankNo, capacity, sortOrder?, stockNow?: { litres (at most the capacity), unitCost? } }` → 201 the set-up; the stock comes in as an opening correction ("Opening stock in tank T1"). 409 a tank number used at the outlet. Audited `fuel_tank.created` (and `stock.adjusted`) |
| `PATCH /fuel/tanks/:id` | settings.edit | `{ tankNo?, capacity?, active?, sortOrder? }` → the set-up. 400 another fuel; 409 a capacity below its latest dip, switching off a tank a nozzle in use draws from. Audited `fuel_tank.updated` (from and to) |
| `POST /fuel/dispensers` | settings.edit | `{ locationId, unitNo, make?, serialNo?, stampedOn?, stampingDue, sortOrder?, nozzles?: [{ nozzleNo, tankId | productId (CNG), reading }] }` → 201 the set-up. 409 a unit or nozzle number used at the outlet. Audited `fuel_dispenser.created`, `fuel_nozzle.created` |
| `PATCH /fuel/dispensers/:id` | settings.edit | `{ unitNo?, make?, serialNo?, stampedOn?, stampingDue?, sortOrder?, status? (in_use, suspended, retired), statusNote? (required unless in use) }` → the set-up. 409 taking it out of use while a shift is open on a nozzle. Audited `fuel_dispenser.updated`, `.stamped`, `.suspended`, `.retired` or `.back_in_use` |
| `POST /fuel/dispensers/:id/nozzles` | settings.edit | `{ nozzleNo, tankId | productId (CNG), reading }` → 201 the set-up. Audited `fuel_nozzle.created` |
| `PATCH /fuel/nozzles/:id` | settings.edit | `{ nozzleNo?, active?, sortOrder? }` → the set-up. 400 a `reading` (it moves only with a close or a meter change); 409 while a shift is open on it. Audited `fuel_nozzle.updated` |
| `POST /fuel/nozzles/:id/meter` | fuel.approve | `{ reading, reason }`: the totaliser replaced or reset → 201 the set-up. 409 the same reading, a shift open on it. Audited `fuel_meter.changed` |
| `POST /fuel/measures`, `PATCH /fuel/measures/:id` | settings.edit | `{ locationId (new), name, litres, serialNo?, stampedOn?, stampingDue, active? (change) }` → the set-up. Audited `fuel_measure.created`, `.updated` or `.stamped` |
| `GET /fuel/prices` | fuel.view | `?locationId` → `{ location, current[], history[] }`: the prices in force and the next, and the last 60 set (`price`, `effective_from`, `note`, `created_by_name`) |
| `POST /fuel/prices` | catalog.edit | `{ requestKey, locationId, effectiveFrom? (now), note?, prices: [{ productId, price (a litre or a kilo, VAT included) }] }` (1-20 fuels) → 201 as `GET`. 409 more than a week back or a month ahead, before a closed shift that sold the fuel ("Shift FS/… sold Petrol at its price until …: a new price takes effect from then or later"). Audited `fuel_price.set` |
| `GET /fuel/settings` | fuel.view | `{ densityTolerance, variationPercent, petrolLossPercent, petrolLossAbovePercent, dieselLossPercent, dieselLossAbovePercent, above600Kl, testLitres, stampingWarnDays, denominations, interestSkuId, updatedAt }` (the guidelines' figures until saved; the notes and coins ₹500 down to ₹1) |
| `PUT /fuel/settings` | settings.edit | Any of those (`denominations`: 1-20 whole rupees up to 2,000, each once; `interestSkuId`: a service item, or null); what is left out stays → the settings. 400 a goods item for the interest; 404 an item not found. Audited `fuel_settings.updated` (from and to) |
| `GET /fuel/tanks/:id/chart` | fuel.view | `{ tank, rows: [{ cm, litres }] }`: the tank's dip chart, rising |
| `PUT /fuel/tanks/:id/chart` | settings.edit | `{ rows: [{ cm, litres }] }` or `{ text }` ("cm, litres" a line, as pasted; a heading line is skipped) → `{ tank, rows }`: the chart in place of the one before. 400 fewer than 2 or more than 3,000 rows, a dip given twice, litres not rising with the dip. Audited `fuel_tank.chart_set` |

**Shifts**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /fuel/attendants` | fuel.view | Who a shift may be opened for: oneself, or with `fuel.edit` every active member (`id`, `name`, `role_name`, `location_id`) |
| `GET /fuel/shifts/day` | fuel.view | `?locationId&date` (today) → `{ date, today, location, prices[], nozzles[] (each with its unit, `unit_status`, `stamping_due`, `days_to_due`, its tank, `reading`, `price` now, `open_shift_id`, `open_shift_no`, `open_attendant`), settings: { testLitres, stampingWarnDays }, open[] (with `nozzles[]` and their openings), closed[] }`: the outlet's board; someone without `sales.view` sees their own shifts only |
| `GET /fuel/shifts` | fuel.view | Every shift, the latest first: `shift_no`, the outlet, `attendant_id`, `attendant_name`, `status`, `opened_at`, `day`, the close in force (`closed_at`, `expected`, `credit`, `walk_in`, `cash`, `other`, `difference`, `document_no`), `nozzle_list`, `sold` (in words), `reopened` (how many times). Search shift, attendant, nozzle, sold and bill; filters `status`, `location`, `attendant`, `day`; one's own only without `sales.view` |
| `POST /fuel/shifts` | fuel.create; fuel.edit for another attendant | `{ requestKey, locationId, attendantId? (oneself), openedAt? (now; within the last 24 hours), nozzles: [nozzleId | { nozzleId, opening? }] (1-24), notes? }` → 201 the shift. 404 an attendant not on the staff; 409 the attendant's shift still open at the outlet, a nozzle on another open shift or switched off or its unit not in use, a fuel with no price, an opening other than the nozzle's reading. Audited and evented `fuel_shift.opened` |
| `GET /fuel/shifts/:id` | fuel.view | The shift: its fields, `location_name`, `opened_by_name`, `nozzles[]` (`nozzle_no`, `product_name`, `unit`, `tank_no`, `unit_no`, `opening`, `reading_now`, `price` at its opening), `close` (the close in force: its figures, `readings[]`, `products[]`, `slips[]`, `takings[]`, `bills[]` with `paid`, `from_account`, `returned`, `due` and `part` (walk_in, credit, big_fill, goods), `big_fills[]` (the buyer's PAN masked), `counts[]`, `account[]` (the short or excess), `cash_paid`, `cash_goods`, `dropped`, `big`, `big_cash`, `goods_walk_in`, `goods_other`, `goods_credit`, `closed_by_name`, `approved_by_name`), `history[]` (closes reopened, with `reopen_reason` and `reopened_by_name`), `money`, `reopenable`, `next_shift`, `test_litres`, `denominations`, `drops[]` (with `received_by_name`, a cancellation's reason), `dropped`, and while open `receivers[]` (who a drop may go to) and `goods_items[]` (the items that may be sold besides fuel). Another attendant's shift is 404 without `sales.view`; its money is for its attendant and those who see sales |
| `PATCH /fuel/shifts/:id` | fuel.create (one's own; fuel.edit another's) | `{ notes }` of an open shift → the shift. 409 closed |
| `POST /fuel/shifts/:id/nozzles` | fuel.create (as above) | `{ nozzleId, opening? }`: another nozzle onto an open shift, at the prices of its opening → 201 the shift. Audited `fuel_shift.nozzle_added` |
| `DELETE /fuel/shifts/:id/nozzles/:nozzleId` | fuel.create (as above) | A nozzle taken off an open shift (one stays) → the shift. Audited `fuel_shift.nozzle_removed` |
| `POST /fuel/shifts/:id/close/preview` | fuel.create (as above) | The close as below, nothing saved → `{ shiftNo, closedAt, nozzles[] (opening, closing, test, gross, litres), products[] (name, unit, price, litres, creditLitres, walkInLitres, creditAmount, walkInAmount, amount), slips[] (customer, registration, name, litres, price, amount, slipNo, overLimit), takings[], expected, credit, walkIn, other, cash, cashPaid, difference, short, excess, limits[] (kind fill or credit, with the vehicle or customer and the limit), approvalNeeded, stock[] (a fuel the meters sold beyond the stock), note }`, with `bigLitres` and `bigAmount` on each fuel, `held` and `bookNo` on each slip, `onFuel` and `onGoods` on each taking, `bigFills[]`, `goods[]` (each buyer's lines, total and GST), `big`, `bigCash`, `goodsWalkIn`, `goodsCredit`, `goodsOther`, `cashGoods`, `dropped` |
| `POST /fuel/shifts/:id/close` | fuel.create (as above); fuel.approve with `approve` | `{ requestKey, closedAt? (now; after the opening), readings: [{ nozzleId, closing, test? }] (every nozzle), cash, payments?: [{ methodId (a method of kind upi, card or bank), amount, reference? }], slips?: [{ contactId, vehicleId, productId? (the vehicle's), litres, slipNo? (the serial, for a customer with slip books) }], count?: [{ denomination, pieces }] (the cash, in place of `cash`), goods?: [{ skuId, quantity, unit?, lotCode?, contactId? }] (the other sales, up to 50), bigFills?: [{ productId, litres, registration?, buyerName?, pan | panDeclaration, payments: [{ method: 'cash' | methodId, amount, reference? }] }] (up to 10), note?, approve? }` → the shift, closed: the walk-in fuel bill (a line for each fuel, `Petrol · price includes state VAT`, no GST, no round-off, paid by the takings, then the cash counted and dropped, then the attendant's account as a credit note named *Attendant account*), the other sales' GST invoices (to walk-in buyers, paid what is left of the takings, the cash and the attendant's account; and one to each customer named, on account), a bill for each big fill (with the buyer's PAN or declaration, paid as typed) and a fuel bill to each fleet customer billed per shift (a line for each slip, `Diesel · TS09UB4455 · slip 0012 · price includes state VAT`, due by the customer's credit days; a monthly customer's fills are held, with no bill); the short or excess on the attendant's account. 400 a big fill without the buyer's PAN or declaration, or not paid its amount; a note or coin not on the station's list; a count unlike the cash typed. 409 a fuel among the other sales; a big fill under ₹2,00,000; ₹2,00,000 or more of a big fill in cash, or from the same PAN today; less cash than the big fills took; a slip outside the customer's books in use or used before. 400 a reading missing, below the opening, a test more than the nozzle moved; 404 a vehicle not the customer's; 409 slips over what a fuel sold, takings over the walk-in sales, a slip number entered already, a vehicle that takes another fuel, a price changed while the shift was open (close at the change: `closedAt`), more than the stock, a credit fill over ₹2,00,000 without the customer's PAN, and `reason: approval_needed` (with `limits`) for credit over a fill or credit limit without a manager's `approve`. Audited and evented `fuel_shift.closed` |
| `POST /fuel/shifts/:id/reopen` | fuel.approve | `{ requestKey, reason }` → the shift, open again: each bill credited for what is left of it (the litres and other sales back in stock), what was paid on its walk-in bills and big fills refunded the way it came (the attendant's account as a credit note), the attendant's short or excess reversed, the nozzles back to the openings. 409 open, another shift opened on a nozzle since, its fleet fills on a month's invoice, its excess taken to income since. Audited and evented `fuel_shift.reopened` |
| `POST /fuel/shifts/:id/drops` | fuel.create (one's own; fuel.edit another's) | `{ requestKey, amount, receivedBy (a member of the staff), droppedAt? (now; since the opening), note? }`: cash handed over during an open shift → 201 the shift (`drops[]`, `dropped`). 404 not on the staff; 409 closed, handed to its own attendant, the same key with other data. Audited and evented `fuel_drop.made` |
| `POST /fuel/shifts/:id/drops/:dropId/cancel` | fuel.approve | `{ reason }`: a drop typed wrongly, while the shift is open → the shift. 404 not found; 409 cancelled already, the shift closed. Audited `fuel_drop.cancelled` |
| `GET /fuel/attendant-accounts` | fuel.view and sales.view | `?from&to` (this month so far; up to 367 days) `&locationId` → `{ from, to, items[], totals }`: each attendant (`attendantId`, `name`) with `opening` (`due`, `held` before the period), `period` (`short`, `excess`, `paid`, `deducted`, `toIncome`, `shortReversed`, `excessReversed`, `due`, `held`), `closing` (`due`, `held`) and `shifts`; `totals` (`due`, `held`, `short`, `excess`, `paid`, `deducted`, `toIncome`) |
| `GET /fuel/attendant-accounts/:userId` | fuel.view and sales.view | `?from&to` → `{ attendant, from, to, opening, period, entries[] (kind: short, excess, short_reversed, excess_reversed, paid, deducted, to_income; amount, shift_no, method, note, wages, created_by_name), now: { due, held } }`. 404 not an attendant here |
| `POST /fuel/attendant-accounts/:userId/pay` | fuel.edit and sales.view | `{ requestKey, locationId, amount, methodId | method (cash, upi, card, bank), note? }`: the attendant pays back → 201 the account; money in on the day's money (`received.fromAttendants`). 409 more than they owe, the same key with other data. Audited and evented `fuel_attendant.paid` |
| `POST /fuel/attendant-accounts/:userId/deduct` | fuel.approve and sales.view; expenses.create with `wages` | `{ requestKey, locationId, amount, note, wages?, wagesPaidBy?: { methodId | method } }`: kept back from the wages; the wages paid out now go in the expense book as wages → 201 the account. 400 no note; 409 more than they owe, expenses switched off. Audited and evented `fuel_attendant.deducted` |
| `POST /fuel/attendant-accounts/:userId/to-income` | fuel.approve and sales.view | `{ requestKey, locationId, amount, note }`: an excess taken to other income (cash) → 201 the account; money in on the day's money (`received.otherIncome`). 400 no note; 409 more than is held. Audited and evented `fuel_attendant.excess_to_income` |

**Tanks, loads and the registers**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /fuel/dips` | fuel.view | `?locationId&date` (today) → `{ date, today, location, tanks[] }`: each tank with `dip` (that day's: `stock`, `dip_cm`, `water_cm`, `density`, `temperature`, `taken_at`, `created_by_name`, a correction's `corrected_by_name` and `correction_reason`), `previous` (the dip before) and, today, `book` (`from`, `dip`, `receipts`, `sales`, `book`, `openShifts`: the last dip plus the loads since less the meters' sales since) |
| `POST /fuel/dips` | fuel.create | `{ requestKey, tankId, dipOn? (today), takenAt? (now; required for an earlier day), stock (not needed with `dipCm` on a tank with a chart: the chart's litres are used, `from_chart`), dipCm?, waterCm?, density?, temperature?, note? }` (400 a dip outside the tank's chart) → 201 the dip. 400 more than the tank holds, a day to come, an earlier day without its time; 409 the tank's dip of that day taken already, a day more than a week back. Audited and evented `fuel_dip.taken` |
| `PATCH /fuel/dips/:id` | fuel.approve | `{ reason, stock?, dipCm?, waterCm?, density?, temperature?, takenAt?, note? }` → the dip, corrected. Audited `fuel_dip.corrected` (from and to) |
| `GET /fuel/receipts` | fuel.view | Every load, the latest first: `invoice_no`, `invoice_date`, `supplier_name`, `lorry_no`, `received_at`, `seals_ok`, `status`, `refuse_reason`, `density_note`, `document_no`, `amount` (with `purchasing.view`), `loads` (the tanks in words), `invoice_litres`, `short_litres`, `density_outside`. Search invoice, lorry, supplier, tanks and purchase; filters `status`, `location`, `density_outside`, `contact` |
| `POST /fuel/receipts` | fuel.create; purchasing.create to accept; fuel.approve with `densityNote` | `{ requestKey, locationId, contactId (a supplier), invoiceNo, invoiceDate, lorryNo, receivedAt? (now; within a week), sealsOk?, status (accepted, refused), refuseReason? (refused), densityNote?, notes?, lines: [{ tankId, invoiceLitres, invoiceAmount, invoiceDensity, receiptDensity, dipBefore?, dipAfter? (both; required to accept), decantDensity? }] (1-12 tanks) }` → 201 the load: an accepted one a purchase from the supplier at the invoice's litres and value, without GST. 400 more than a tank holds, an accepted load without its dips; 409 `reason: density_outside` (with each tank's difference) for a density outside the tolerance without a manager's note, the same invoice already bought from the supplier. Audited and evented `fuel_receipt.accepted` or `fuel_receipt.refused` |
| `GET /fuel/receipts/:id` | fuel.view | The load with `lines[]` (each tank's figures, `density_difference`, `density_within`, `received_litres`, `short_litres`, `decant_density`, `shrinkage_per_kl` and `tva_per_kl` (with `purchasing.view`), `shrinkage_litres`, `shrinkage_percent`, `tva_litres`, `tva_percent`, `allowance_litres`), `compartments[]`, `samples[]`, `created_by_name`, `density_approved_by_name`, `cancelled_by_name`. A receipt also takes `lines[].shrinkagePerKl` and `tvaPerKl` (₹ a KL, TVA either way), `compartments: [{ compartmentNo, tankId, dipCm?, density?, temperature?, waterFound, waterCm?, checkLitres?, checkDensity?, checkTemperature?, shortLitres?, madeUpLitres? }]` (up to 12; 400 water measured with none found, more made up than short) and, accepted, `samples: [{ tankId, sampleNo, sealNo, note? }]` |
| `POST /fuel/receipts/:id/samples` | fuel.create | `{ tankId, samples: [{ sampleNo, sealNo, note? }] }` (1-10) of an accepted load → 201 the load. 409 refused or cancelled, a sample number kept already. Audited `fuel_sample.kept` |
| `GET /fuel/samples` | fuel.view | `?locationId&all` → `{ location, items[] }`: the retention samples kept (with `all`, those disposed of too): `sample_no`, `seal_no`, `product_name`, `tank_no`, `invoice_no`, `lorry_no`, `received_at`, `later_loads`, `due` (two later loads of its fuel in) |
| `POST /fuel/samples/:id/dispose` | fuel.create | `{ note? }` → the sample, disposed of. 409 disposed of already, of one of the last two loads of its fuel. Audited `fuel_sample.disposed` |
| `POST /fuel/receipts/:id/decant` | fuel.create | `{ lines: [{ tankId, density }] }`: the density after decanting and 50 litres dispensed, once each → the load. Audited `fuel_receipt.decanted` |
| `POST /fuel/receipts/:id/cancel` | fuel.approve | `{ requestKey, reason }`: a load entered wrongly → the load, cancelled; its purchase credited (a debit note), its litres out of stock. 409 refused, the stock no longer holding its litres. Audited and evented `fuel_receipt.cancelled` |
| `GET /fuel/register` | fuel.view | `?locationId&tankId&from&to` (this month so far; up to 92 days) → `{ location, from, to, today, settings, tanks[] }`: each tank with `allowance` and `rows[]`, a row for each morning dip: `day`, `takenAt`, `opening`, `waterCm`, `density`, `receipts` and `loads`, `meter`, `test`, `sales`, `book`, `closingDay` and `closing` (the next dip), `variation`, `percent`, `allowedGain`, `allowedLoss`, `flag` (within, loss, gain, open), `openShifts` |
| `POST /fuel/register/corrections` | fuel.approve and inventory.edit | `{ requestKey, tankId, day, reason }`: a day of the register posted to the stock as a correction → 201 `{ litres, variation, allowance, adjustment_id, … }` (litres = the variation less the allowances taken in the book). 404 no dip that day; 409 the day still open, a shift open on the tank, nothing to post, posted already. Audited `fuel_register.posted` and `stock.adjusted`; evented `stock.adjusted` |
| `GET /fuel/density` | fuel.view | `?locationId&month` (this month) → each tank's `rows[]` by day: `dip` (the morning density and temperature) and `loads[]` (`invoice_density`, `receipt_density`, `difference`, `within`, `decant_density`, `status`) |

**Fleet**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /fuel/vehicles` | fuel.view | `?all` (with those switched off) → each vehicle: `contact_id`, `customer_name`, `customer_phone`, `registration`, `description`, `product_id`, `product_name`, `fill_limit`, `active`, `last_fill_at` |
| `POST /fuel/vehicles` | fuel.edit | `{ contactId (a customer), registration, description?, productId?, fillLimit? }` → 201 the vehicle. 409 a registration in use with a customer. Audited `fuel_vehicle.created` |
| `PATCH /fuel/vehicles/:id` | fuel.edit | `{ description?, productId?, fillLimit?, active? }` → the vehicle. 400 a change of customer or registration. Audited `fuel_vehicle.updated` (from and to) |
| `GET /fuel/fleet` | fuel.view and sales.view | `?month` (this month) → `{ month, from, to, items[] }`: each fleet customer with `vehicles`, `fills`, `amount` and `litres` (by fuel) of the month, `balance`, `credit_limit`, `credit_days`, `over_limit` |
| `GET /fuel/fleet/:contactId/statement` | fuel.view and sales.view | `?month` → `{ month, from, to, customer, terms, vehicles[] (registration, fills[] with day, slip_no, serial, product_name, litres, price, amount, shift_no, held, billed, document_no (the shift's bill or the month's invoice; none while held); totals, amount), totals[], amount, fills, unbilled (`fills`, `amount`, `outlets`), invoices[] (the month's), ledger, seller }`; `ledger` (`opening`, `debit`, `credit`, `closing`, `entries`) with *Customer dues* on and `receivables.view` |

| `PUT /fuel/fleet/:contactId/terms` | fuel.edit and sales.view | `{ billing (shift, month), interestRate? (% a month, up to 10; empty: none), interestAfterDays? (0-365) }` → `{ customer, terms }`. 404 not a customer. Audited `fuel_fleet.terms_changed` (from and to) |
| `POST /fuel/fleet/:contactId/invoice` | fuel.edit and sales.create | `{ requestKey, month (YYYY-MM), locationId }`: the customer's fills held for that month at the outlet, on one invoice with a line for each fill (fuel, vehicle, day, slip, *price includes state VAT*), no round-off, due by their credit days; the stock leaves now → 201 `{ id, month, document_id, document_no, total, due_on, fills }`. 400 a month to come; 409 no fills left to bill, the same key with other data, the stock short. Audited and evented `fuel_month_invoice.billed` |
| `GET /fuel/fleet/:contactId/interest` | fuel.view and sales.view | `{ customer, terms, upTo, worked, billed, due, bills[] (documentNo, from, days, owedDays, interest, periods[]), charges[] }`: interest on their fuel bills overdue, worked out to today |
| `POST /fuel/fleet/:contactId/interest` | fuel.approve and sales.create | `{ requestKey, locationId, amount }` (the due amount as seen) → 201 as `GET`, with a bill of the interest item (no round-off, due today, outside the credit limit). 409 no interest item chosen, no rate in the terms, nothing due, the amount moved since. Audited `fuel_fleet.interest_billed`; evented `fuel_fleet.interest_billed` |
| `GET /fuel/indent-books` | fuel.view | `?contactId` → each slip book: `book_no`, `first_serial`, `last_serial`, `issued_on`, `active`, `slips`, `used`, `unused` |
| `POST /fuel/indent-books` | fuel.edit | `{ contactId (a customer), bookNo, firstSerial, lastSerial (up to 10,000 slips), issuedOn? (today), note? }` → 201 the book. 409 a book number or serials of the customer's already. Audited `fuel_indent_book.issued` |
| `GET /fuel/indent-books/:id` | fuel.view | The book with `usedSlips[]` (serial, registration, litres, product_name, shift_no, held) and `unusedRanges[]` |
| `PATCH /fuel/indent-books/:id` | fuel.edit | `{ active?, note? }`: withdrawn or back in use → the book. Audited `fuel_indent_book.withdrawn` or `.restored` |

**Records and outlets**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /fuel/sales-register` | fuel.view | `?date` (today) `&locationId` → `{ date, location, money, formatsNote, shifts[] (shiftNo, attendant, closedAt, nozzles[] with opening, closing, test, litres; expected and difference with `sales.view`), fuels[] (litres, credit, big, walkIn; prices and amount with `sales.view`), total }` |
| `GET /fuel/inspections` | fuel.view | `?locationId&from&to` → the inspections, newest first (`inspected_on`, `inspected_by`, `authority`, `findings`, `actions`, `location_name`, `created_by_name`) |
| `POST /fuel/inspections` | fuel.edit | `{ locationId, inspectedOn (not to come), inspectedBy, authority?, findings, actions? }` → 201 the inspection, kept for good. Audited `fuel_inspection.recorded` |
| `GET /fuel/outlets` | fuel.view | `{ today, money, outlets[], totals }`: each outlet the person works at with `shifts` (`open`, `closed` today), `litres` by fuel, `sales`, `short`, `excess` (money with `sales.view`), `stock[]` (each tank's latest closed register day: `flag`, `variation`, `percent`), `beyond`, `dues` (`customers`, `unbilled`, `attendants`; with `sales.view`), `alerts` (`critical`, `warning`, `info`, the first five) |

- `GET /notifications` (the bell), for a role with `fuel.view`: a unit's or a measure's stamping falling due or past due, a tank's latest register day beyond the tolerance (a gain critical, a loss a warning), a load accepted outside the density tolerance in the last week, a shift open more than 16 hours, from 10 am the tanks not dipped today, a fuel with no price at an outlet, and with `sales.view` the fleet customers over their credit limit.
- `POST /documents` refuses a fuel on a sale (409: a shift's close bills it) and petrol or diesel on a purchase (409: a tanker receipt brings it in); a return of a fuel bill's line or a load's purchase line is refused (409) except by a reopening or a cancellation.
- Number series: shifts are numbered in the kind `fuel_shift` (prefix `FS`), set per location like any other series.

## Hotels, lodges & guest houses

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `lodging`, permission). Backend module `modules/business/lodging/` (routes `businessLodging.routes.js`). A route that needs a `lodging.*` permission answers 403 while the module is off, and so for every other type of business, which never has it; the set-up routes (a catalogue or settings permission) answer 404 for another type. Dates are calendar days on the business's clock (`2026-10-26`): a night belongs to the date it starts on, `arrival` is the first night and `departure` the morning the guest leaves. Rates are a night before GST; money is sent and answered as text with two places. The list takes `limit` (up to 100), `offset`, `q`, `from` and `to` (on the arrival date) and its filters, and answers `{ total, items }`. Posting routes take a `requestKey` (UUID): the same key with the same body gives the same answer, with another body 409. Someone without `sales.view` gets stays without money (rates, estimates, the charges' figures, receipts and the bill `null`, `money: false`); someone with neither `lodging.create` nor `lodging.print` gets the occupants without their ID details (`ids: false`). Two stays taking a room at the same moment: the second answers 409 ("That room is taken by another stay over some of these nights. Choose another room, or other dates.").

**Set-up, rooms and housekeeping**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /lodging/setup` | lodging.view | `{ settings, slabs[], roomTypes[], rooms[], timezone }`: the settings (`lowTaxRateId`, `highTaxRateId`, `lowName`, `highName`, `lowRate`, `highRate`, `slabLimit`, `weekendNights`, `terms`, `updatedAt`, `ready`: both slabs set); the tax rates in use to choose from; each room type (`sku_id`, `name`, `item_code`, `hsn_code`, `item_active`, `base_occupancy`, `max_occupancy`, `max_extra_beds`, `rack_rate`, `weekend_rate`, `extra_adult_rate`, `child_rate`, `extra_bed_rate`, `description`, `sort_order`, `active`, `rooms_in_use`, `rooms[]`); each room (`location_id`, `location_name`, `room_type_id`, `room_type`, `room_no`, `floor`, `status`, `status_note`, `status_at`, `status_by_name`, `sort_order`, `active`) |
| `PUT /lodging/settings` | settings.edit | `{ lowTaxRateId?, highTaxRateId? (both the first time), slabLimit?, weekendNights?: [1-7] (1 Monday … 7 Sunday), terms? }`; what is left out stays → the settings. 400 the same slab twice; 409 a slab switched off, the lower slab's rate not below the higher's. Audited `lodging_settings.updated` (from and to) |
| `POST /lodging/room-types` | catalog.edit | `{ skuId }` (an existing service item counted in nights) or `{ item: { name, hsnCode?, code? (ROOM-01…) } }` (a new service item in nights, its own price nil), `baseOccupancy`, `maxOccupancy?`, `maxExtraBeds?` (0-5), `rates: { rack, weekend?, extraAdult?, child?, extraBed? (required with extra beds) }`, `description?`, `sortOrder?` → 201 the set-up. 409 an item or a name already a room type, the slabs not set for a new item. Audited `lodging_room_type.created` |
| `PATCH /lodging/room-types/:id` | catalog.edit | Any of those but the item, and `active` → the set-up; stays booked keep their rates. 409 switching off a type with stays reserved or in the house. Audited `lodging_room_type.updated` (from and to) |
| `POST /lodging/rooms` | catalog.edit | `{ locationId, roomTypeId, rooms: [{ roomNo, floor? }] (1-200) }` → 201 the set-up. 409 a room number used at the location, a type switched off. Audited `lodging_room.created` |
| `PATCH /lodging/rooms/:id` | catalog.edit | `{ roomNo?, floor?, roomTypeId?, sortOrder?, active? }` → the set-up. 409 a number used; another type, or out of use, while a stay is reserved for it or in it, or when its type's reservations would no longer fit. Audited `lodging_room.updated` |
| `GET /lodging/rooms/board` | lodging.view | `{ rooms[], counts, today }`: each room in use with its status, note, who set it and when, and `guest` (the stay in it: `stay_no`, `guest_name`, `departure`, `adults`, `children`) or `arriving` (a reservation for it due today or before) |
| `POST /lodging/rooms/:id/status` | lodging.edit | `{ status (vacant_clean, vacant_dirty, out_of_order), note? (why it is out of order: required) }` → `{ room, repeated }`. 409 a room with a guest in it, out of use. Audited and evented `lodging_room.status_changed` |
| `GET /lodging/rooms/:id/history` | lodging.view | `{ room, log[] }`: its statuses, the newest first (`from_status`, `to_status`, `note`, `created_at`, `by_name`) |

**The desk, the calendar and the night audit**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /lodging/desk` | lodging.view | `{ today, arrivals[], inHouse[], departures[], rooms, audit, counts }`: reservations arriving today or before and not checked in, the stays in the house (each with `nights_to_post`), those leaving today or past their departure; the rooms by status (`vacant_clean`, `vacant_dirty`, `occupied`, `out_of_order`, `rooms`); `audit` (`nights` and `stays` still to post up to tonight, `ready`: the slabs set); `counts` (`arrivals`, `late`, `inHouse`, `departures`, `overstays`). Each stay as in the list |
| `GET /lodging/calendar` | lodging.view | `?from (today)&days (14; 1-31)&roomType` → `{ from, to, days[], today, types[] }`: each room type in use with its `rooms[]` (each with `nights[]`: the day and the stay holding it), `unassigned[]` (reservations with no room yet, and the nights they hold) and `left[]` (the rooms left each night) |
| `GET /lodging/free` | lodging.view | `?arrival&departure&roomType&stay (a stay's own nights left out)` → `{ arrival, departure, rooms[] }`: each room with `free` and `clash` (the stay holding it, with its `words`) |
| `POST /lodging/night-audit` | lodging.create | `{}` → `{ today, posted[], nights, stays }`: for each stay in the house, the room nights posted up to tonight (`night`, `rateKind`, `amount`, `taxRate`, `tax`; the night and rate kind only for those who do not see sales). Run again, it posts nothing twice. 409 the slabs not set. Audited `lodging.night_audit`; evented `lodging_stay.nights_posted` for each stay |

**Reservations and stays**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /lodging/stays` | lodging.view | Every stay by arrival, the latest first: `stay_no`, the location, the guest (`contact_id`, `guest_name`, `guest_phone`), `bill_to_name` and `bill_to_gstin`, `source`, `ota_name`, `ota_booking_id`, `status`, `stage` (reserved, arriving, late_arrival, in_house, due_out, overstay, to_settle, checked_out, cancelled, no_show), `arrival`, `departure`, `nights`, `room_type`, `room_no`, `adults`, `children`, `extra_beds`, `estimate_total`, `advance`, `held`, `deposit_held`, `bill_due`, `document_no`, `foreigners`, and when it was checked in, checked out or cancelled. Search stay, guest, phone, room, room type, company, OTA booking id, bill and notes; filters `stage`, `status`, `location`, `contact`, `room_type`, `open`, `in_house` |
| `POST /lodging/stays/preview` | lodging.view | `{ locationId, arrival, departure, roomTypeId, roomId?, adults, children?, extraBeds?, agreedRate?, stayId? (a stay being changed) }` → `{ arrival, departure, count, nights[] (night, weekend, rateKind, roomRate, extraAdults, children, extraBeds, amount, taxRate, slab, tax, total), subtotal, tax, total, roomFree, roomWords, typeFree, typeWords }`, nothing saved. 409 the slabs not set |
| `POST /lodging/stays` | lodging.create; contacts.create for a new guest; sales.edit with an advance | `{ requestKey, locationId, contactId | guest: { name, phone? }, billToContactId?, source? (walk_in, phone, ota), otaName?, otaBookingId? (both for an OTA), arrival, departure, roomTypeId, roomId?, adults, children?, extraBeds?, agreedRate?, notes?, advance?: { amount (at most the room nights), method | methodId (cash, card, UPI or bank), reference? } }` → 201 the stay, reserved and numbered. 400 a day passed, more than 180 nights, more guests or beds than the type takes; 409 the room held by another stay ("Room 102 is booked by ST/2627/0007 (Kiran Desai) for the night of 26 Oct: choose another room"), every room of the type taken on a night, a type switched off, the slabs not set. Audited and evented `lodging_stay.reserved` |
| `GET /lodging/stays/:id` | lodging.view | The stay: its fields, `location_name`, `room_type`, `max_occupancy`, `max_extra_beds`, `room_no`, `floor`, `room_status`, `bill_to_name`, `bill_to_gstin`, who did each step, `today`, `nights_count`; `guests[]` (each occupant with their ID details and Form-III marks), `charges[]` (the folio, voided charges too), `nights[]` (each night posted or still to post, with its rate kind, value, slab and tax, `billed`, `due`), `folio` (`posted`, `to_post`, `unbilled`, `held`), `receipts[]` (each advance and deposit with what is `free`, `used` and `refunded`, and its `refunds[]`), `deposit` and `advance_summary`, `bill` (number, total, paid, returned, refunded, `due`, `buyer_gstin`, `place_of_supply`), `events[]`, `terms`, `slabs_ready`, `seller`, `money`, `ids` |
| `PATCH /lodging/stays/:id` | lodging.create; lodging.approve for a guest in the house's rate | A reservation: `{ arrival?, departure?, roomTypeId?, roomId? (null: none yet), adults?, children?, extraBeds?, agreedRate? (null: the type's rates), billToContactId? (null: the guest), source?, otaName?, otaBookingId?, notes? }`; a stay in the house: `{ departure?, roomId? (a move, with roomTypeId for another type, at the rates booked), extraBeds?, agreedRate?, billToContactId?, notes?, arrivedFrom?, goingTo?, purpose? }` → the stay, priced again. 400 a departure before today; 409 an ended stay, a guest in the house's arrival or guests, a departure before a night posted, a move to a room not vacant and clean, a room or type taken. Audited and evented `lodging_stay.changed`, or `lodging_stay.moved` |
| `POST /lodging/stays/:id/receipts` | lodging.create and sales.edit | `{ requestKey, purpose (advance, deposit), amount, method | methodId (cash, card, UPI or bank), reference? }` → 201 the stay: a numbered collection receipt in the guest's name. 400 an advance over the room nights and extras; 409 a stay that has ended. Audited and evented `collection.recorded` |
| `POST /lodging/stays/:id/check-in` | lodging.create; sales.edit with money | `{ requestKey, roomId? (the stay's), guests: [{ fullName, child?, gender?, age?, phone?, address?, nationality? (Indian unless a foreigner), foreigner?, idKind? (aadhaar, voter_id, driving_licence, passport, pan_card, other; required for an adult), idRef? (an Aadhaar's last four digits only), visaType?, visaNo?, arrivedIndiaOn?, nextDestination? (a foreigner's: the passport and all four required) }] (1-60), arrivedFrom?, goingTo?, purpose?, advance?, deposit? }` → the stay, in the house; the room occupied. 400 an occupant's details missing, a full Aadhaar number, the occupants not the stay's adults and children; 409 before the arrival day or from the departure day, a room not vacant and clean or held. Audited and evented `lodging_stay.checked_in` |
| `PATCH /lodging/stays/:id/guests/:guestId` | lodging.create | An occupant's details as at check-in (not adult or child) → the stay. 409 a stay that has left. Audited `lodging_guest.corrected` (from and to) |
| `POST /lodging/stays/:id/charges` | lodging.create | `{ requestKey, skuId (a service item), quantity? (1), price? (the item's), note? }` → 201 the stay, the extra on the folio at its item's slab. 409 not in the house, goods, a room type's item. Audited and evented `lodging_charge.posted` |
| `POST /lodging/stays/:id/charges/:chargeId/void` | lodging.approve | `{ reason }` → the stay; a room night is posted again at the stay's rates. 409 billed, not in the house. Audited and evented `lodging_charge.voided` |
| `POST /lodging/stays/:id/check-out/preview` | lodging.create | → `{ stayNo, today, departure, early, nightsToPost[], nightsNotStayed[], billTo (guest, company) }` and, for those who see sales, `subtotal`, `tax`, `round_off`, `total`, `advance`, `deposit`, `due`, `depositBack`, `advanceBack`, `bill[]` (`label`, `quantity`, `net`, `tax`, `taxRate`); nothing saved. 409 not in the house, past the departure day ("extend it to today first") |
| `POST /lodging/stays/:id/check-out` | lodging.create and sales.create; sales.edit with payments; lodging.refund with `refund` | `{ requestKey, billToContactId? (null: the guest; left out: as the stay has it), payment? | payments? (as on `POST /documents`; `amount: "full"` the rest), refund?: { method | methodId (cash, upi, bank), reference? }, approval?: { approverId?, pin?, reason? }, buyer?: { pan?, panDeclaration? } }` → the stay, checked out: one sale through the core to the company billed (its GSTIN on it) or the guest, the place of supply the property's state, a line for each room night and extra not billed, paid by what is paid now, then the advances, then the deposits; nights posted ahead and not stayed voided; the room vacant dirty; the occupants gone; what is left held handed back with the manager's PIN when asked. 400 more paid than is due; 409 not in the house, past the departure day, and `reason: bill_due` (with `due`) when a guest's own bill would be left due without `lodging.approve`. Audited and evented `lodging_stay.checked_out` |
| `POST /lodging/stays/:id/cancel` | lodging.cancel; sales.create with a charge; sales.edit with payments; lodging.refund with `refund` | `{ requestKey, reason, noShow? (once the arrival day has come), charge? (before GST), payment? | payments? (the rest of the charge's bill), refund?: { method | methodId, reference? }, approval?: { approverId?, pin? }, buyer? }` → the stay, cancelled or a no-show; the charge billed on a sale to the guest as the room type's item at the first night's slab, paid first by what is held; what is left handed back with the manager's PIN when asked. 400 a payment with no charge; 409 not reserved (a guest in the house checks out), a no-show before the arrival day. Audited (under the approving manager's name when money went back) and evented `lodging_stay.cancelled` or `lodging_stay.no_show` |
| `POST /lodging/stays/:id/refund` | lodging.refund | `{ requestKey, amount? (all that is left), method | methodId (cash, upi, bank), reference? (UPI and bank), reason, approverId?, pin? }` → 201 `{ refunds[], repeated, stay }`: what is left of the advances and deposits of a stay that has ended, deposits first, each a numbered refund of its receipt. 409 a stay not ended, nothing held, more than is held. Audited and evented `collection.refunded` (under the approving manager's name) |

**Foreign guests and the register**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /lodging/form-iii` | lodging.create | `?view (open: the reports still to make, the default; all: the last 90 days)` → `{ now, view, items[], counts: { overdue, open } }`: each foreign occupant (`stay_no`, `room_no`, `full_name`, `nationality`, the passport and visa, `arrived_india_on`, `next_destination`, `arrived_at`, `departed_at`, `arrival_due_at` and `departure_due_at` (24 hours after each), the marks with who made them, `overdue`) with `next` (`event`, `dueAt`, `minutesLeft`, below nothing once overdue), overdue first |
| `POST /lodging/guests/:id/form-iii` | lodging.create | `{ event (arrival, departure), acknowledgement (3-40 letters, digits, `/` and `-`) }` → `{ guest, repeated }`: the report made on the portal, marked once. 409 not a foreigner, marked already with another number, a departure report before the guest left. Audited and evented `lodging_guest.form_iii_reported` |
| `GET /lodging/register` | lodging.print | `?from (today)&to (from)` (at most 92 days) → `{ from, to, timezone, seller, items[] }`: every occupant in the house between those dates on the business's clock, with their ID details, `arrived_at`, `departed_at` and Form-III acknowledgements, their stay (`stay_no`, `guest_name`, `adults`, `children`, `arrived_from`, `going_to`, `purpose`, `status`), `room_no`, `room_type` and `location_name` |
| `GET /lodging/approvers` | lodging.create, lodging.cancel, lodging.refund or lodging.approve | `?permission (lodging.refund, the default; lodging.approve)` → the members whose role holds it (`id`, `name`, `has_pin`) |

- `GET /notifications` (the bell), for a role with `lodging.view`: reservations past their arrival day not checked in, guests past their departure day, and with `lodging.create` the Form-III reports still to make (a warning, critical once overdue) and room nights from before today not posted.
- `POST /documents` (a sale) refuses a room type's service item (409: its nights are billed on the stay's folio at check-out); the customer's *apply advance* leaves a stay's receipts alone.
- Number series: stays are numbered in the kind `stay` (prefix `ST`), set per location like any other series.

## Tasks, issues & projects

One API with two front doors. Every route below exists under both:

| Front door | Prefix | Who and what is checked |
| --- | --- | --- |
| Restaurant (the signed-in restaurant) | `/api/tasks` | `authenticate`; the restaurant's feature switch (`tasks`, `issues` or `projects`, from `req.user.features`; off answers 403 `reason: "feature_off"`); the restaurant permission (`req.user.permissions`). The business is the restaurant's own (`restaurant_business_id()`), never taken from the request. A login tied to one outlet sees that outlet's records and whole-restaurant ones. |
| Any business | `/api/businesses/:businessId/tasks` | Membership (404 when none), the business capability (403 "<Module> is not switched on for this business…"), then the permission. |

Both are mounted by `modules/tasks/routes/tasks.routes.js`, before the `/businesses` router so photo uploads reach multer. Task, issue, project, recurring-task and template actions taken through `/api/tasks` are also written to the restaurant's `audit_logs` (action = the verb, `entity_type` = task / issue / project / task_schedule / task_template, `entity_label` = the title; a task update that sets assignees is `assigned`). Permissions are checked in the services, against the record:

| Permission | Allows |
| --- | --- |
| *(none: the module is on)* | My tasks; doing a task assigned to you (as a person, your staff record, your role or whoever is on shift); commenting on what you can see |
| `tasks.view` | Every task (within your outlet), the board, the team calendar, the recurring list, reports |
| `tasks.create` | Creating tasks and using templates (only for yourself without `tasks.assign`) |
| `tasks.assign` | Assigning anyone, changing others' tasks, recurring tasks, doing any open task |
| `tasks.review` | Approving or sending back finished tasks that need a review (not your own, unless you also have `tasks.manage`) |
| `tasks.manage` | Own templates; cancelling, reopening and deleting tasks |
| `issues.view` / `issues.create` / `issues.assign` / `issues.review` / `issues.manage` | All issues / report / assign and work / close and reopen / delete. Without `issues.view` a person sees the issues they reported or own. |
| `projects.view` / `projects.create` / `projects.manage` | All projects / start one / change any. Without `projects.view` a person sees the projects they are a member of; a project's owner may change it. |

Responses are `{ success: true, data }`. Dates are `YYYY-MM-DD` in the business's time zone; moments are ISO timestamps. Paged lists take `limit` (1–200, default 25), `offset` and `q`, and return `{ rows, total, limit, offset }`. Database rules answer 409 with their sentence (an outlet of another restaurant, a person who does not work here).

### Context, people and reports

| Method and path | Returns |
| --- | --- |
| `GET /context` | `{ world, businessId, businessType, businessName, timezone, userId, userName, outletScope, categories[{code,name,icon}], CATEGORIES[], modules{tasks,issues,projects}, permissions[], directory{ peopleCount, roles[{kind,id,name}], places[{id,name}], shifts[], placeWord } }`. `CATEGORIES` is the list of category codes. People are not listed here: the pickers search them with `GET /people`. Roles: `role` (restaurant) or `business_role`. |
| `GET /people?q&kind&limit&offset` | The people pickers' search, by name: `{ total, rows[{ kind, id, name, detail, placeId, login }] }`. Kinds: restaurant `user` and `employee` (staff with no login); business `user` and `resource`. `kind=user` lists logins only; `limit` 1–50 (default 20). |
| `GET /reports?from&to&place` | `tasks.view`. `{ totals{due,done,onTime,missed,completionRate,onTimeRate,overdue,upcoming,withFailures,averageScore}, byCategory[], byPerson[], compliance[{scheduleId,title,due,done,onTime,missed,completionRate,onTimeRate,withFailures,days[]}], issuesByAge[{bucket,open,serious}], issuesByCategory[], reviewBacklog{count,oldest}, daily[] }`. *Due* counts the tasks due in the period that are done, missed or past their due time; completion rate = done ÷ due; on time = done by the due time ÷ done. Default period: the last 30 days; at most a year. |

### Tasks

| Method and path | Body / query | Notes |
| --- | --- | --- |
| `GET /my` | — | Your tasks: open ones due up to 7 days ahead (or with no due time), and those done or missed today. Each has `bucket` = `today` / `overdue` / `upcoming` / `done`. Also `reviewCount` for reviewers. Runs the recurring generation first. |
| `GET /` | `status` (comma list of `todo, in_progress, done, missed, cancelled, open, overdue, review`), `assignee` (`me`, `on_shift`, `unassigned`, `user:<id>`, `employee:<id>`, `resource:<id>`, `role:<id>`, `business_role:<id>`), `category`, `priority`, `place`, `project`, `schedule`, `kind` (`one_off` / `recurring`), `from`, `to`, `ahead=all`, `sort` (`due`, `-due`, `priority`, `title`, `status`, `created`), paging | The team board. Recurring days after tomorrow are left out unless `to` or `ahead=all` is given. |
| `GET /calendar?from&to&mine&category&place` | — | Up to 62 days; `mine=1` (always so without `tasks.view`). Each task has `day`. |
| `GET /:taskId` | — | The task with `items[]` (each with `value`, `answered`, `failed`, `issueId`), `assignees[]`, `files[]`, `comments[]`, `history[]` and `can{work,edit,review,cancel,reopen}`. 404 when not visible. |
| `POST /` | `title` (or from a template), `description`, `category`, `priority`, `dueAt`, `placeId`, `assignMode` (`people` / `role` / `on_shift` / `unassigned`), `assignees[{kind,id}]`, `templateId` or `libraryCode`, `items[]` (a blank task's own checklist), `requiresReview`, `projectId`, `projectListId`, `milestoneId` | 201. Nobody named: yourself. Naming anyone else needs `tasks.assign` (403). Writes a `task.assigned` outbox event. |
| `PATCH /:taskId` | any of the above except the template | `tasks.assign`, or the creator of a task only they are on. |
| `POST /:taskId/start` | `{}` | To do → in progress (a role or on-shift task becomes yours). |
| `PUT /:taskId/items/:itemId` | `value`, `note` | Checkbox `true`/`false`; yes/no `"yes"`/`"no"`; a number; text; a choice's label. Photo and signature items are answered by uploading. A failing answer (the other yes/no, a reading outside its range, a choice marked "fails") on an item with `raise_issue` opens one issue in the same transaction (when Issues is on). Returns `{ task, raisedIssue: {id, number} or null }`. 403 when the task is missed, cancelled, done or not yours; 409 before it opens. |
| `POST /:taskId/complete` | `note` | 409 "Still to do: …" with `data.missing[]` while a required item is unanswered or an item's photo is missing. Sets the review to pending when the task needs one. |
| `POST /:taskId/review` | `decision` (`approve` / `changes`), `note` (required to send back) | `tasks.review`. Sending back returns it to in progress with the note. |
| `POST /:taskId/cancel` | `reason` | `tasks.manage`, or its creator. |
| `POST /:taskId/reopen` | `reason` | `tasks.manage`; a missed task gets another day. |
| `DELETE /:taskId` | — | `tasks.manage`; only a one-off task with no answers (cancel it otherwise). |
| `POST /:taskId/comments` | `body` | Returns the comments. |
| `POST /:taskId/files` | multipart: `file`, `kind` (`photo` / `signature` / `file`), `itemId` | JPG, PNG, WebP or PDF up to 5 MB; the bytes are checked. Stored in `tasks/<business>/` under the private upload folder (`PRIVATE_UPLOADS_DIR`, `backend/private_uploads` when it is not set). A photo or signature item counts as answered. |
| `GET /files/:fileId` | — | The file, to someone who can see its task or issue. |
| `DELETE /files/:fileId` | — | The uploader (or `tasks.manage` / `issues.manage`). The file is kept and the record marked removed. |

### Templates and the library

| Method and path | Notes |
| --- | --- |
| `GET /library?q&category` | Built-in templates for this business type (its own first, then those for every business). Each `{ code, name, description, category, priority, requiresReview, estimatedMinutes, common, suggested{frequency,times,weekdays,monthDay,everyN,windowMinutes}, itemCount }`. |
| `GET /library/:code` | With `items[]`. 404 for another type's template. |
| `GET /templates?q&all=1`, `GET /templates/:id` | The business's own templates (`all=1` includes archived ones). |
| `POST /templates`, `PUT /templates/:id` | `tasks.manage`. `name`, `description`, `category`, `priority`, `requiresReview`, `estimatedMinutes`, `items[]` of `{ kind (section, checkbox, yes_no, number, text, photo, signature, choice), label, help, required, unit, minValue, maxValue, options[{label,fail}], expected (yes / no), photoRequired, critical, raiseIssue, failSeverity }`. Replacing the items never changes tasks already made. |
| `PATCH /templates/:id/active` | `{ active }`: archive or restore. |
| `POST /templates/copy` | `{ libraryCode }` or `{ templateId }`, optional `name`: copy and edit. |

### Recurring tasks

| Method and path | Notes |
| --- | --- |
| `GET /schedules?all=1` | `tasks.view`. Each with `compliance{due,done,onTime,missed}` for the last 30 days. |
| `POST /schedules`, `PUT /schedules/:id` | `tasks.assign`. `title`, `templateId` or `libraryCode`, `category`, `priority`, `placeId`, `assignMode`, `assignees[]`, `frequency` (`daily`, `weekdays`, `weekly`, `monthly`, `every_n_days`, `per_shift`), `weekdays[]` (0 = Sunday), `monthDay` (31 = the last day), `everyN`, `dueTimes[]` (1–12 `HH:MM`; a time before the day's cut-off hour belongs to the night before: the restaurant's business-day `cutoffHour`, or a business's `dayCutoffHour`; 05:00 until changed), `shiftId` (per shift, restaurant), `windowMinutes` (opens that long before; empty = all day), `startsOn`, `endsOn`, `requiresReview`, `active`. Editing deletes the days ahead that were not started and makes them again. |
| `PATCH /schedules/:id/active` | Pause (cancels the days ahead not started) or resume. |
| `GET /schedules/:id/compliance?from&to` | `{ from, to, days[{day,slot,status,due_at,completed_at,failed_count,critical_failed,id}] }`. |

Generation is lazy and idempotent: the task list (`GET /`), My tasks, the calendar and the reports first make the occurrences from the day after `generated_through` (at most 31 days back) to 7 days ahead, under a per-business advisory lock and a unique index on (schedule, day, slot), then mark missed every open task whose window has closed. No background job.

### Issues

| Method and path | Notes |
| --- | --- |
| `GET /issues` | Paged. `status` (`active` = open and in progress, `open`, `in_progress`, `resolved`, `closed`), `severity`, `category`, `place`, `assignee` (`me`, `none`, a user id), `reported=me`, `from`, `to`, `q` (title, equipment, `ISS-0001`), `sort` (`oldest`, `severity`). |
| `GET /issues/:id` | With `files`, `comments`, `history`, `logbook` (restaurant), the `tasks[]` made from it and `can{edit,assign,work,resolve,close,reopen,convert,remove}`. |
| `POST /issues` | `issues.create`. `title`, `description`, `category`, `severity` (`low` / `medium` / `high` / `critical`), `placeId`, `assetLabel`, `dueAt`, `assigneeId` (someone else needs `issues.assign`). Numbered `ISS-0001` per business. Writes `issue.reported`. |
| `PATCH /issues/:id` | The reporter or `issues.assign`; `assigneeId` needs `issues.assign`. |
| `POST /issues/:id/status` | `{ status, note }`: `in_progress` (the assignee or `issues.assign`), `resolved` (note required: what was done), `closed` (`issues.review`, only once resolved), `open` (reopen). |
| `POST /issues/:id/convert` | A task to fix it (the task fields of `POST /`); the issue moves to in progress. |
| `POST /issues/:id/comments`, `POST /issues/:id/files` | As for tasks. |
| `DELETE /issues/:id` | `issues.manage`; refused when a task was made from it. |
| `POST /issues/from-logbook/:entryId` | Restaurant only. One issue per log-book entry (asking again returns that issue). |

### Projects

| Method and path | Notes |
| --- | --- |
| `GET /projects?status&q` | `status` may be `live` (planning, active, on hold). Each with `taskCount`, `doneCount`, `overdueCount`, `progressPercent` (done ÷ not cancelled), `milestones{total,done,next}`, `late`. |
| `GET /project-templates` | New outlet opening, Festival sale set-up, Annual stock audit, Shop renovation, Staff hiring drive, New menu / product range launch. |
| `POST /projects` | `projects.create`. `name`, `description`, `startOn`, `endOn`, `placeId`, `ownerId` (another owner needs `projects.manage`), `memberIds[]`, `templateCode` (makes its milestones, task lists and tasks; the end date follows the plan's length). |
| `GET /projects/:id` | With `members`, `milestoneList`, `lists`, `tasks`, `comments`, `history`, `can{edit,addTask}`. |
| `PATCH /projects/:id` | The owner or `projects.manage`: the fields, `status`, `ownerId`. |
| `PUT /projects/:id/members` | `{ memberIds[] }`. |
| `POST /projects/:id/milestones`, `PATCH /projects/:id/milestones/:milestoneId`, `DELETE /projects/:id/milestones/:milestoneId` | `{ name, dueOn }`; any member may set `{ done }` alone. The owner or `projects.manage` changes the rest (403 otherwise); 404 milestone not found. Each answers the project as `GET /projects/:id`. |
| `POST /projects/:id/lists`, `DELETE /projects/:id/lists/:listId` | Task lists: add one, `{ name }` (up to 80), placed after the others (201), or delete one, which keeps its tasks in the project outside any list (404 task list not found). The owner or `projects.manage` (403 otherwise). Each answers the project as `GET /projects/:id`. A list keeps the name it was added with. |
| `POST /projects/:id/comments` | As for tasks. |

### Notifications

The restaurant bell has a `tasks` provider (`backend/src/notifications/providers/tasks.js`, permission `tasks.view`, feature `tasks`): overdue tasks, tasks waiting for review, serious open issues, fixed issues to close. The Business Admin bell (`GET /api/businesses/:id/notifications`) adds your own overdue tasks and the issues assigned to you, and the team's when you may see them.

## Live updates

A screen's stream of what changes in its restaurant or business, so it reads again as soon as something it shows changes, instead of asking every few seconds ([ARCHITECTURE.md › Live updates](ARCHITECTURE.md#35-live-updates)). The database announces every committed change; a message says only where and what changed, and the screen reads the change itself through the routes above, which check what the person may see. Both front doors are mounted by `modules/live/routes/live.routes.js`, before the `/businesses` router.

| Method and path | What is checked | What it carries |
| --- | --- | --- |
| `GET /api/live` | `authenticate` (a login with a restaurant); `resolveOutlet` (the outlet picked, as `X-Outlet-Id`) | The signed-in person's restaurant. Someone tied to an outlet, or with one picked, hears that outlet's changes and those that belong to no outlet. |
| `GET /api/businesses/:businessId/live` | `authenticate`; the membership, opened as every business route opens a business | The business. Someone tied to a location hears that location's changes and those that belong to none. |

**Request.** `Accept: text/event-stream` and `Authorization: Bearer <token>`, as for any request; a token in the address is never read. Browsers read the stream with `fetch`, since `EventSource` cannot send the header. No permission is needed beyond belonging to the restaurant or business.

**Response.** `200` with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform` (never compressed) and `X-Accel-Buffering: no`, then server-sent events:

| Event | Data | Meaning |
| --- | --- | --- |
| `ready` | `{ scope: "restaurant" \| "business", keepAliveSeconds: 25, outlet? \| location? }` | Listening. Read the screen once: what changed before this moment was not heard. |
| `change` | `{ area, id?, outlet? \| location? }` | A committed change. Read the screen again if it shows that area. Each carries an `id:` line, a number rising within the API process, in commit order. |
| `resync` | `{}` | The API process lost its connection to the database for a moment and has it again: read the screen once. |
| `end` | `{ reason, message }` | The stream ends. `session_ended`: signed out everywhere, a new password, the token run out, the login or its restaurant switched off. `access_ended`: no longer a member, the business or role switched off, or the person must choose a password of their own. `changed`: the outlet or location they work at changed; open a new stream. `restarting`: the API process is stopping; reconnect in a moment. |
| comment `: keep-alive` | | Whenever the stream has been quiet for 20 seconds. |

A stream is checked again every minute, and at once when the database announces a change to its login, restaurant, business, membership or role. One whose client stops reading (64 KB waiting) is cut off.

**Restaurant areas** (the id is the row's own, or the one in brackets):

| Area | Changes to |
| --- | --- |
| `order` | orders, their dishes and the tables joined to them (the order's) |
| `kot` | kitchen tickets and their lines (the ticket's) |
| `kot_slip` | change slips for a station |
| `table_request` | guests' QR and online orders and calls |
| `table` | dining tables: seated, billed, cleaning, ready |
| `bill` | bills, their payments and refunds (the bill's) |
| `reservation` | reservations and the tables they hold (the reservation's) |
| `waitlist` | the walk-in waitlist |
| `sold_out` | dishes marked sold out or put back |
| `timeclock` | time-clock punches and attendance |
| `preorder` | pre-orders |
| `business_day` | business days opened or closed |
| `task`, `issue` | the restaurant's tasks (with their lines and assignees) and issues |

**Business areas:**

| Area | Changes to |
| --- | --- |
| an event's kind up to its dot: `sale`, `purchase`, `payment`, `collection`, `appointment`, `repair`, `stock`, `visit`, `jewellery_rates`, … | every event the shared core writes in a posting's transaction (`business_events`), with its entity's id and, when its payload names one, its location |
| `token` | a clinic's token queue |
| `lab` | a lab's orders, their samples and results (the order's id, at the order's location) |
| `appointment` | appointments |
| `walk_in` | a salon's walk-in list |
| `task`, `issue` | tasks (with their lines and assignees) and issues |
| `jewellery_rates` | a jeweller's rate sheets |

**Errors** (JSON, before the stream starts):

| Status | When |
| --- | --- |
| 400 | An outlet id or a business id that is not one |
| 401 | No token (a token in the address alone is no token), or a session that has ended |
| 403 | The person must choose a password of their own (`reason: "password_change_required"`); tied to an outlet and asking for another; an outlet of another restaurant |
| 404 | A login with no restaurant (`/api/live`); not a member of the business |
| 429 | `reason: "live_limit"`: the login already holds `LIVE_STREAMS_PER_PERSON` streams in this API process (20 unless set); `reason: "live_full"`: the process holds `LIVE_STREAMS_MAX` (2,000 unless set). The staff app tries again a minute later. |
| 503 | `reason: "restarting"`: the API process is stopping |

## Personal data

The DPDP Act 2023 and Rules 2025, for both engines, through one module (`backend/src/modules/personal-data`): the privacy notice and its contact, consent per purpose and per business, a child's mark, requests from a person, and the breach register. The same paths under two front doors:

- `/api/businesses/:businessId/privacy/…` — a business on the shared core; a person is a customer contact (`business_contacts`, kind customer). Mounted from `business.routes.js`; the membership and permission are checked as on every business route.
- `/api/privacy/…` — the signed-in restaurant; a person is a guest of its guest book (`customers`). `authenticate`, then the permission named; a `POST` or `PATCH` without a JSON object body answers 400. The restaurant's rows are kept against its own business row, made when first needed.

`:personId` is a contact id at a business and a guest id at a restaurant; another business's or restaurant's person is 404. How the rules work: [BUSINESS_RULES.md › Personal data](BUSINESS_RULES.md#personal-data).

**Permissions.** `privacy.view` reads the registers, `privacy.manage` keeps them, publishes the notice and erases, `privacy.export` sees or exports a person's whole data. Recording or withdrawing a consent and marking a child need the right to take customers: `contacts.create` or `contacts.edit` (a clinic patient's: `patients.create` or `patients.edit`) at a business, `customers.manage` at a restaurant. Reading one person's consents needs `contacts.view`, `patients.view` or `privacy.view` (a restaurant's `customers.view` or `privacy.view`). The notice in force and the consent lookup are read by any member.

**Request keys.** Publishing a notice, logging a request, erasing, recording a breach and recording a notice sent take `requestKey` (a UUID): the same key with the same body gives the same answer; with another body, 409.

| Method and path | Permission | Body | Returns |
| --- | --- | --- | --- |
| `GET …/notice` | any member | — | `{ current, starter }`: the notice in force (`{ id, version, label, notice, bills_text, reminders_text, offers_text, contact_name, contact_phone, contact_email, published_at, published_by_name, print_line }`) or null, and while none is published the starter text `{ notice, billsText, remindersText, offersText }` for the business's type |
| `GET …/notices` | privacy.view | — | every version, newest first |
| `POST …/notices` | privacy.manage | `requestKey`, `notice` (200-8000), `billsText`, `remindersText`, `offersText` (20-600 each), `contactName` (150), `contactPhone` (30) and/or `contactEmail` (one is required) | 201 the new version, numbered on from the last; audited `privacy_notice.published` |
| `GET …/consents?people=1,2,3` | any member | at most 200 ids | `{ notice: { id, version, bills_text, reminders_text, offers_text } \| null, people: { id: { purposes[], child, erased } } }`: what each person has agreed to now |
| `GET …/people/:personId` | contacts.view, patients.view or privacy.view (customers.view at a restaurant) | — | `{ person, consents[] (newest first, withdrawn ones included, with who recorded and withdrew each), child (the mark in force) \| null, active[] }` |
| `POST …/people/:personId/consents` | contacts.create or contacts.edit (patients.create or patients.edit; customers.manage at a restaurant) | `purposes[]` (`bills_digital`, `reminders`, `offers`), `channel` (`counter` default, `guests_site`, `phone`), `method` (`verbal` default, `signed_form`, `digital`), `givenBy`, `note` | 201 `{ consents[], active[] }`; a purpose already given is the same record. Audited `consent.given` |
| `POST …/consents/:consentId/withdraw` | as above | `reason` (300; "Asked to stop" when left out), `channel` | `{ consent, active[] }`; audited `consent.withdrawn` |
| `POST …/people/:personId/child` | as above | `guardianName` (required), `guardianRelation`, `consentMethod`, `verifiedHow` (300), `purposes[]` the guardian agrees to (`bills_digital`, `reminders`) | 201 `{ child, active[] }`; any consent to offers is withdrawn first. Audited `person.marked_child` |
| `POST …/children/:childId/end` | as above | `reason` (required) | the mark, ended; audited `person.child_mark_ended` |
| `GET …/people?q=` | privacy.view | — | up to 20 people by name, phone or e-mail (not erased) |
| `GET …/everyone?limit=&offset=` | privacy.view | — | `{ total, items }`: every customer (or guest), for a breach that touches them all |
| `GET …/people/:personId/data?requestId=` | privacy.export | — | `{ filename, data }` as below; audited `personal_data.viewed` |
| `GET …/people/:personId/export?requestId=` | privacy.export | — | `{ filename: "personal-data-<customer\|guest>-<id>-<day>.json", data: { business, exportedOn, exportedBy, request, person, consents, child, requests, sections: [{ heading, rows }] } }`: the person's record and every row of theirs, table by table, request keys left out; audited `personal_data.exported` |
| `GET …/requests` | privacy.view | the paged-list contract; `status` (`open`, `done`, `refused`), `kind`; `q` searches the name, details, reply-to and number | `{ total, items }`, open ones first by due date, each with `received_on`, `due_on`, `days_left` (on the business's clock) and `person_now` |
| `POST …/requests` | privacy.manage | `requestKey`, `kind` (`access`, `correction`, `erasure`, `grievance`), `personId` or `personName`, `channel` (`counter`, `phone`, `email`, `letter`), `details` (2000), `replyTo` (150), `receivedOn` (YYYY-MM-DD; today on the business's clock when left out; never a day to come) | 201 the request, numbered, due 90 days after it was received; audited `privacy_request.logged` |
| `GET …/requests/:requestId` | privacy.view | — | the request with `person`, `consents` and, for an erasure still to do, `open[]`: what holds it back |
| `POST …/requests/:requestId/person` | privacy.manage | `personId` | the request linked to the person (an open one); audited `privacy_request.linked` |
| `POST …/requests/:requestId/close` | privacy.manage | `status` (`done`, `refused`), `reply` (2000) | the request, closed for good; audited `privacy_request.closed` |
| `POST …/requests/:requestId/erase` | privacy.manage | `requestKey`, `reply` (optional; when left out, a reply saying the details were erased and tax records keep what tax law needs) | the request, done, with `erasure: { erased[{ heading, rows }], kept[] }`. A shop's contact becomes *Erased customer #id*, its copies on other records are blanked (closed records included), points left cancelled, consents withdrawn; a restaurant's goes through the guest book's own erasure (*Erased guest #id*). Audited `personal_data.erased` |
| `GET …/breaches` | privacy.view | the paged-list contract; `status` | `{ total, items }` with `board_due_at` (72 hours from `found_at`), `people`, `notices` |
| `POST …/breaches` | privacy.manage | `requestKey`, `foundAt` (a moment, not in the future), `whatHappened` (10-4000), `impact`, `stepsTaken` (3-4000), `affected` (`all`, `chosen`), `people[]` (when chosen) | 201 the breach, numbered; audited `breach.recorded` |
| `GET …/breaches/:breachId` | privacy.view | — | the breach with `people[]` (each `notified`), `notices[]`, `affected_count`, `hours_left` and `people_notice_text` (the notice to the people, filled from the record with the privacy contact unless edited) |
| `PATCH …/breaches/:breachId` | privacy.manage | any of `whatHappened`, `impact`, `stepsTaken`, `affected`, `peopleNotice` (50-4000, or empty for the filled one), `boardInformedAt`, `boardReportAt` (not before `foundAt`, not in the future), `boardReference` | the breach; audited `breach.updated` |
| `POST …/breaches/:breachId/people` | privacy.manage | `personIds[]` | `{ added }`; only for a breach of chosen people; audited `breach.people_added` |
| `DELETE …/breaches/:breachId/people/:personId` | privacy.manage | — | `{ removed: true }`; not once a notice went to them, nor on a closed breach; audited `breach.person_removed` |
| `POST …/breaches/:breachId/notices` | privacy.manage | `requestKey`, `personId`, `channel` (`whatsapp`, `sms`, `email`, `letter`, `in_person`, `phone`), `text` (50-4000; the breach's notice when left out) | 201 the notice sent, kept with its words; audited `breach.notice_sent` |
| `POST …/breaches/:breachId/close` | privacy.manage | — | the breach, closed for good; audited `breach.closed` |

A restaurant's audit rows go to its activity log (`audit_logs`): a guest's consents, child's mark, view, export and erasure against the guest (`entity_type` `customer`, labelled by number only: *Guest #id*), the rest by the action's own kind (`privacy_notice`, `privacy_request`, `breach`).

**Errors**

| Status | When |
| --- | --- |
| 400 | A field missing or wrong; a purpose that is not one; offers among a guardian's purposes; a request received on a day still to come; a breach found in the future, or reported to the Board before it was found; more than 200 people in a lookup |
| 403 | The permission is missing |
| 404 | The person, request, breach, consent or mark is not this business's or restaurant's |
| 409 | A request key used for another body; `reason: "no_privacy_notice"` (no notice published yet: a consent cannot be recorded); `reason: "child"` (offers for a child); a consent withdrawn or a mark ended twice; a person already marked; an erased person (no consent, no change); `reason: "erasure_blocked"` with `open[]` (something still open with the person); `reason: "no_person"` (an erasure request not linked to anyone); `reason: "not_erased"` (an erasure request answered done before the erasure); a request or breach already closed; `reason: "board_report"` (a breach closed before the report to the Board is recorded); a notice to someone not on the breach; a person a notice went to taken off |

**Elsewhere in the API**

- Reminders on WhatsApp, by SMS or by a call need the person's consent to reminders, or answer 409 `{ reason: "consent_required", purpose: "reminders" }` saying who has not agreed: `POST …/udhaar/:contactId/reminders`, `POST …/receivables/customers/:id/follow-ups`, `POST …/optical/recall/:contactId/reminders`, `POST …/garage/vehicles/:id/reminders`, `POST …/member-plans/memberships/:id/reminders` and a salon's `POST …/salon/appointments/:id/messages` with `kind: "reminder"`. A visit, and a confirmation of a booking, need none.
- `consents` (`{ bills_digital?, reminders?, offers? }`, each yes or no) is taken with a new or edited customer: `POST` and `PATCH …/contacts` (a business), `POST /api/crm/customers` and `PUT /api/crm/customers/:id` (a restaurant; the older `marketingOptIn` is the offers consent), and with the new customer of a type's own intake (`member`, `toMember`, `customer`, `guest`, `owner`, a farmer's body). `customers.marketing_opt_in` is a copy the database keeps from the offers consent; writing it directly is refused.
- `GET …/context` carries `privacy: { version, line } | null`, and `GET /api/restaurants/current/settings` carries `privacyLine`: the line bills and receipts print. An advance (`GET /api/bills/advances/:id`) carries `seller.privacyLine` for its receipt.
- The guests' pages carry `privacy: { id, version, notice, billsText, offersText, contact } | null`: the online ordering and table QR menus, and the booking page. `POST /api/public/online/:token/orders` takes `consents` (`bills_digital`, `offers`) with `privacyNoticeId` (the notice the page showed; 400 when it is not this restaurant's); they are recorded, given online, when the order is accepted.
- `POST /api/guest-insights/segments/:key/export` with `format: "mobiles"` gives only the guests who agreed to offers and are not marked as a child, with `leftOut` counting the rest.
- A phone number is never required: a repair intake, a warranty, an EMI walk-in buyer and a restaurant pre-order (`POST /api/preorders`, its mobile matched the one way the guest book keeps it) need a name only.

## Owner's GST thresholds

An owner's turnover across their businesses under one PAN, for both engines, through one module (`backend/src/modules/gst-thresholds`), against the figures the platform keeps (`platform_gst_thresholds`: e-invoicing and 6-digit HSN / SAC codes above ₹5 crore, the IRP's 30 days at ₹10 crore or more, each with its source and the date it applies from). Three doors:

- `/api/businesses/gst-thresholds…` — the owner's view: no `:businessId`, each answer the signed-in person's own businesses. Mounted from `business.routes.js` before its `/:businessId` routes.
- `/api/businesses/:businessId/…` — one business: the PAN its owner records, its HSN / SAC codes to fix. The Business Admin checks as on every business route.
- `/api/gst-thresholds/…` — the signed-in restaurant's HSN / SAC codes to fix. `authenticate`, then the permission named.

How the rules work: [BUSINESS_RULES.md › An owner's GST thresholds](BUSINESS_RULES.md#an-owners-gst-thresholds).

**A PAN group** is the businesses one owner login owns (the Owner role, in an active business; a linked restaurant while it is active) under one PAN. A business's PAN is the one its GSTINs carry (its own and its active locations'; a restaurant's GST number and its active outlets'), else the one its owner recorded (`business_gst_pans`); one whose GSTINs carry different PANs, or that has neither, is not linked. **Turnover** is a business's sales less returns before GST, on its own dates and clock: a shop's sale documents' `subtotal` less its sale returns' line values, by posting date in `businesses.timezone`; a restaurant's bills (not void) at `taxable_amount` less its credit notes' `taxable_value`, by business day (else the date on its clock), as the GST pack counts them. The financial year is April to March, from the latest of the group's dates (`business_tax_change_today`: a restaurant's trading date). A figure applies for a year when the year before passed it (`above`, or `at_or_above`): a step is `crossed` `by: last_year` when the whole of last year passed it (its rules apply now), `crossed` `by: this_year` when this year so far has (they apply from the next 1 April, `appliesFrom`), `near` when this year so far reached the owner's warning level of it, else `below`. Money is a decimal string of rupees.

| Method and path | Permission | Body | Returns |
| --- | --- | --- | --- |
| `GET /api/businesses/gst-thresholds` | login | — | `{ owner, warnPercent, today, year: { label, from, to }, lastYear, thresholds[], groups[], notLinked[] }`. `owner` false (and no groups) for someone who owns no business. `thresholds[]`: `{ code, name, applies, turnover, comparison, hsnDigits, reportWithinDays, appliesFrom (null: its first date not recorded), source, inForce }`. `groups[]`, most turnover first: `{ pan, thisYear, lastYear, projected, steps[], hsn: { applies, from, digits }, businesses[] }` (`hsn.applies` once 6-digit codes apply now or from the next 1 April, `from` that day while it is to come, else null); a step is `{ turnover, comparison, state (below, near, crossed), by (last_year, this_year, null), appliesFrom (the next 1 April when crossed by this year, else null), share (this year so far as a % of the figure, one decimal), warnAt, onPace, words, rules[] }`. A business is `{ id, name, code, businessType, typeName, restaurant, source (gstin, recorded), gstins[], recordedPan, recordedAt, today, startedOn, thisYear, lastYear, projected, hsnToFix (a count once 6-digit codes apply or are coming, else null) }`; a business not linked adds `reason` (`no_gstin`, `gstin_invalid`, `gstins_differ`) and `pans[]` |
| `PUT /api/businesses/gst-thresholds/warning-level` | login, as the owner of a business | `warnPercent` (a whole percent from 50 to 99) | `{ warnPercent }`; the same again changes nothing |
| `PUT /api/businesses/:businessId/gst-pan` | any member; the service lets only the business's owners through | `pan` (`ABCDE1234F`; spaces and small letters are tidied; empty clears it) | `{ businessId, pan, recordedAt, changed }`; the same PAN again is `changed: false`. A change is audited with the PAN masked: `gst_pan.recorded` or `gst_pan.cleared` in `business_audit`, or for a restaurant `gst_pan_recorded` or `gst_pan_cleared` in its activity log (`entity_type` `restaurant`) |
| `GET /api/businesses/:businessId/gst-thresholds/hsn` | catalog.view | — | `{ applies, from, digits, count, rule }`: whether the HSN rule applies to the business's PAN, now (`from` null) or from the next 1 April (`from` that day), its digits, how many items print a shorter code or none (active items billed under their own code: not a kit, nor one kept for use in services), and the rule. No sums |
| `GET /api/businesses/:businessId/gst-thresholds/hsn-items` | catalog.view | the paged-list contract (`limit` up to 100, `offset`, `q` on the name, code and HSN) | `{ total, items }`: those items, each a catalogue row (`label`, `code`, `hsn_code`, `hsn_length`, `kind`, `tax_rate_id`, `category_id`, `pack_sizes`…) by name |
| `GET /api/gst-thresholds/hsn` | menu.view (the restaurant) | — | `{ applies, from, digits, rule, rates[] }`: once the rule applies to the restaurant's PAN, now (`from` null) or from the next 1 April (`from`), its tax rates with a shorter code (or none) that a dish on the menu is charged at, `{ id, name, percentage, hsn_code, dishes }` |

**The bells.** A business's bell (`GET /api/businesses/:businessId/notifications`, for `reports.view`) and a restaurant's (`GET /api/notifications`, provider `gstThresholds`, for `reports.view`) carry one line for each figure the PAN is near (`warning`) or past (`critical`, whether its rules apply now or from the next 1 April): the most serious of the business's owners' groups, `id` `gst-threshold:` (a restaurant's `gstThresholds:`) then the year, the figure in rupees and the standing (`near`, `crossed:this_year`, `crossed:last_year`), `title` the step's words, `detail` the PAN (in full for the business's owners, else its last four characters, and always masked on a restaurant's bell) with the sums only when the person may see the money of every business they add up (the Owner role or `reports.view` in each), category `GST`. The link opens the owner's view for an owner; for anyone else, once 6-digit codes apply or are coming, the catalogue (`…/products`), or a restaurant's tax rates (`/menu/tax-rates`). The standing behind them is kept five minutes for everyone in the API process (`standingCache.js`, the bell's `NOTIFICATIONS_CACHE` switch) and thrown away when a PAN is recorded or cleared or a warning level saved; the PAN, the sums and the link are worked out for each person on every call.

**Errors**

| Status | When |
| --- | --- |
| 400 | A warning level that is not a whole percent from 50 to 99; a PAN not in its shape; a page larger than 100 |
| 403 | The warning level set by someone who owns no business; a PAN recorded by someone who is not the business's owner; the permission is missing |
| 404 | A business the person is not a member of |
| 409 | A PAN recorded for a business that takes its PAN from its GSTIN, or whose GSTINs carry different PANs; the codes to fix asked for a business whose PAN the HSN rule does not apply to, now or from the next 1 April |
