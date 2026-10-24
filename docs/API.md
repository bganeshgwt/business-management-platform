# API reference

For developers of the staff app, the guests' site and future apps, and for integrators: every endpoint of the API, and the conventions every caller follows.

The list comes from the routers themselves. Every route mounted by `backend/src/app.js` and `backend/src/routes/index.js` (including the routers each of those mounts) is listed below: the routers are loaded without starting the server and their stacks walked, and each group is described from its controller, service, validator and repository. The tasks module's routes exist under two prefixes (`/api/tasks` and `/api/businesses/:businessId/tasks`) and are listed once.

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
31. [Tasks, issues & projects](#tasks-issues--projects)

Sections 2 to 19 are the restaurant module's API, with the sign-in and platform routes every app uses. Sections 20 to 30 are the Business Admin's, under `/api/businesses`. Section 31 serves both.

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
| 403 | The role lacks the permission (`You do not have permission to perform this action`), the account or restaurant is inactive, the outlet (or a business's location) is not yours, a Business Admin module is switched off, a restaurant feature is switched off (below), or a manager's approval is needed (below). |
| 404 | Unknown route (`Route not found: METHOD /path`), or a record that does not exist **or belongs to another restaurant, outlet or business** — the API never says which. |
| 409 | A rule refused the change (a closed day, a paid bill, a duplicate code, a posted count) or `{ reason: "conflict_retry" }` when two tills changed the same rows at the same instant and PostgreSQL rolled one back: nothing was saved, try again. |
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
| `qr_ordering` | `GET /api/tables/qr-settings`; the table QR pages `/api/public/tables/:token/*`; accepting a QR request |
| `online_ordering` | `/api/orders/service-settings/online-ordering*`; the ordering page `/api/public/online/:token/*`; accepting an online order |
| `qr_ordering` or `online_ordering` | `/api/table-requests/*` (with only one on, lists and counters show that one's requests only) |
| `deliveries` | `/api/deliveries/*` except `/api/deliveries/channels*`; `POST /api/orders` with `orderType: "delivery"`; the online ordering page offers takeaway only |
| `kitchen_display` | `GET /api/kitchen/board`, `POST /api/kitchen/sync`, `POST /api/kitchen/recall`, `POST /api/kitchen/clear-old`, `GET /api/kitchen/kots/:id`, `PATCH /api/kitchen/kots/:id/status`, `PATCH /api/kitchen/kots/:id/items/:itemId`, `POST /api/kitchen/kots/:id/recall`, `GET /api/reports/live/kitchen` (stations, slips, printing and an order's tickets stay) |
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

Tokens: `token` is an HS256 JWT (`JWT_EXPIRES_IN`, default 8h) carrying a token version; changing/resetting the password or "sign out everywhere" bumps the version and older tokens get 401 `{ reason: "session_revoked" }`. Status, roles and permissions are re-read from the database on every request; an inactive user or restaurant gets 401 `{ reason: "account_inactive" | "restaurant_inactive" }`. `deviceTokens` (array of up to 20 strings, `[A-Za-z0-9_-]{20,100}`, malformed ones ignored) is the browser's remembered-device tokens, sent on sign-in and on routes that keep this device remembered. Device memory lasts 120 days.

### Auth: sign-in and two-step sign-in
Two-step flow:
1. `POST /api/auth/login` with the password. If two-step is off and not required by any of the person's roles, or the device is remembered and trusted for two-step (30 days), it returns the session. Otherwise it returns `data.twoFactor = { step: "code" | "setup", challengeToken, expiresAt, message, trustDays: 30, user: { name } }` and no session (envelope `message` = `twoFactor.message`).
2. `step: "code"`: `POST /api/auth/login/two-factor` with the ticket and the 6-digit code (or a recovery code).
   `step: "setup"` (role requires it, not yet set up): `POST /api/auth/login/two-factor/setup` (QR + key), then `POST /api/auth/login/two-factor/enable` with the first code.
The `challengeToken` is signed with a separate key (never usable as a session), lasts 10 minutes, is bound to step, user, token version and remembered device, and works once. Ticket errors: 401 `challenge_expired` (missing, expired, password changed since); 400 `challenge_mismatch` (wrong step's ticket); 409 `challenge_used` (already spent). Codes accept `123 456` / `123-456`. Code tries count in the same lockout as the password (the password's try stays counted until the code is right).

Session shape (`data`): `{ token, expiresAt, user, deviceToken? }`. `user` = `{ id, name, email, mobile, restaurantId, restaurantName, restaurantCode, restaurantFormat, outletId, outletName, employeeId, employeeCode, roles, roleNames, permissions[], features[], hasPin, twoFactorEnabled, idleLockMinutes }`. `restaurantFormat` is `restaurant`, `cafe`, `bakery` or `cloud_kitchen` (see `GET /api/restaurants/current/format`); `features` are the restaurant features switched on. `deviceToken` appears only when this browser was not yet remembered; the client stores it and sends it back in `deviceTokens`.

#### `POST /api/auth/login`
Permission: public, rate limited (`loginLimiter`)
Query/Body: `identifier` (string, required, <=150; email, 10-digit mobile in any common format, or staff/employee code; `email` accepted as an alias), `password` (string, required, <=72), `restaurantCode` (string, <=30; required with a staff code, or when one mobile signs in to two restaurants), `deviceTokens` (string[])
Returns: a session (above), or `{ twoFactor: {...} }` when the code or setup step is next. Every attempt on a real account is written to that user's sign-in history.
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
Permission: login only
Query/Body: none
Returns: `data` = the `user` profile shape above, fresh from the database.
Errors: none beyond 401.

#### `PUT /api/auth/me`
Permission: login only
Query/Body: `name` (string, required, <=150), `mobile` (string <=20, 10-digit Indian mobile; stored as 10 digits). Email and roles cannot be changed here.
Returns: the updated profile.
Errors: 400 bad mobile; 400 removing the mobile from a login with no email; 409 mobile used by another login in the restaurant.

#### `POST /api/auth/change-password`
Permission: login only, rate limited (`passwordChangeLimiter`)
Query/Body: `currentPassword` (required), `newPassword` (8-72 chars, must differ), `deviceTokens` (keeps this browser remembered)
Returns: `{ token, expiresAt }` (new token). All other sessions end, other remembered devices are forgotten, 30-day two-step trust ends everywhere.
Errors: 400 missing current; 400 `wrong_password` `{ attemptsLeft }`; 400 new = current / length; 423 `account_locked`; 429.

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
Returns: a new session for that person `{ token, expiresAt, user }` (the till carries on as them). Written to their sign-in history (method `pin`).
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
Returns: 201, the new user.
Errors: 400 no email or mobile; 400 bad mobile; 400 no role / role not assignable here (Super Admin never is); 400 outlet does not exist; 403 role grants permissions you do not hold; 409 mobile already used in this restaurant / email or mobile exists.

#### `PUT /api/users/:id`
Permission: `users.manage`
Query/Body: same as create, without `password` (password has its own endpoint)
Returns: the updated user (before/after diff goes to the activity log).
Errors: 400 deactivating yourself; 400 removing your own `users.manage`; 400 role/outlet/contact errors as create; 403 target has access you lack / role beyond yours; 404; 409 would leave no admin; 409 duplicate email/mobile.

#### `PATCH /api/users/:id/password`
Permission: `users.manage`
Query/Body: `password` (8-72, required)
Returns: no `data`; message says the person was signed out everywhere (token version bumped, 30-day two-step trust ended).
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
Returns: 201, `{ id, adminId, code, name, defaults, format }`. One transaction: GST rates, settings, delivery channels, kitchen station and the first Restaurant Admin. A café, bakery or cloud kitchen then gets its format's starting setup, as `PUT /api/restaurants/current/format` gives it.
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
Returns: `{ id, name }`. Their sessions end, lockout lifted, 30-day two-step trust ended (two-step stays on).
Errors: 403; 404 restaurant not found; 404 not an admin of that restaurant.

#### `GET /api/users/platform/businesses`
Permission: `platform.restaurants.manage`
Query/Body: `q` (<=100; name, code, city or GSTIN), `type` (a business type code), `status` (`active | inactive`)
Returns: `{ items: [{ id, name, code, business_type, type_name, status, currency, timezone, created_at, gstin, city, locations, people, owners: [{ id, name, email }] }], types: [{ code, name }] }`: every business, newest first, at most 500.
Errors: 403 restaurant user.

#### `POST /api/users/platform/businesses`
Permission: `platform.restaurants.manage`
Query/Body: `businessType` (required; any type but `restaurant`, which is set up from `POST /api/users/platform/restaurants`), `name` (required, <=150), `code` (required, 2-40 letters, digits and dashes, spaces become dashes, stored upper case), `legalName`, `gstin` (validated), `stateCode` (2 digits; defaults to the GSTIN's and must match it), `addressLine1`, `addressLine2`, `city`, `postalCode` (6 digits), `phone`, `email`, `currency` (ISO code, default `INR`), `timezone` (default `Asia/Kolkata`), `locationName` (default "Main store"), `locationCode` (default `MAIN`), `owner: { email (required), name, password (8-72), mobile? }`. An email that already has an active login makes that person the owner; otherwise `name` and `password` are required and a new login is made.
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
Returns: `{ id, name }`. Their sessions end on their next request and their sign-in lockout is lifted.
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
Query/Body: `name` (required, <=150), `contact` (<=20), `email` (valid email), `address` (<=500). The code is not editable.
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
Returns: `data` = `{ productId, canDelete, message, reason, canArchive }`; `reason` is `null`, `in_combo` (with `combos[]`) or `has_sales` (with `timesSold`).
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
Errors: 404 not found; 409 `{ reason: "in_combo", combos[] }` part of a combo; 409 `{ reason: "has_sales", timesSold, canArchive: true }` already sold (archive instead); 409 `{ reason: "in_use", canArchive: true }` referenced elsewhere.

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
Errors: 400 target rate is the same, missing or off; 400 switching off the default rate; 404 not found; 409 dishes still use the rate being switched off (send `moveProductsTo`); 409 duplicate name.

#### `DELETE /api/menu/tax-rates/:id`
Permission: `menu.manage`
Query/Body: none
Returns: no `data`.
Errors: 404 not found; 409 dishes use this rate / rate still in use.

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
A table belongs to one outlet or is shared (`outletId: null`). Lists show the caller's outlet plus shared tables; a table object is `{ id, floorId, floorName, areaId, areaName, outletId, tableNo, capacity, qrToken, tableStatus, status, live, booking, inService, outOfServiceReason, turn, readyAt, floorState }` with `floorState` one of `running`, `printed`, `paid`, `out_of_service`, `cleaning`, `reserved`, `free` (see `services/table.service.js`).

#### `GET /api/tables`
Permission: `tables.view`
Query/Body: `floorId` (int)
Returns: `data` = array of tables, with the running order/bill (`live`), due booking and cleaning turn.

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
Which captain has which floor, section (area) or table on a business date. The default date is the open business day (main counter first, then the outlet's), else today in the restaurant's timezone.

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
Errors: 400 `done` missing; 404 ticket not found / dish not on this ticket; 409 ticket cancelled or already served; 409 dish cancelled at the till.

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

Mounted at `/api/orders` (order.routes.js). Every route signs the user in and runs `resolveOutlet`. Any `:id` is checked first: it must be a whole id, and when the request works in an outlet the order must belong to it, else 404 "Order not found in this outlet". Prices always come from the menu: the client sends ids, quantities and notes only. The order shape (`toOrder` in order.service.js) is `{ id, orderNumber, orderType, source, outletId, tableId, tableNo, customerId, customerName, customerMobile, guestCount, orderStatus, kitchenStatus, subtotal, taxAmount, totalAmount, notes, joinedTables[], mergedIntoOrderId, billId, billNumber, billStatus, channelId, brandId, brandName, deliveryStatus, deliveryAddress, tokenNo, tokenCollectedAt, deliveryCharge, deliveryChargeWaived, deliveryChargeWaivedReason, items[] }`. Each item is `{ id, productId, productVariantId, itemName, variantName, quantity, unitPrice, modifierTotal, lineTotal, itemStatus, courseNo, courseName, fireStatus, kitchenQuantity, kitchenStage, cancelledQuantity, modifiers[] }`, plus more fields listed in the service. Cancel reason codes (utils/cancelReasons.js) are `guest_changed_mind`, `wrong_order`, `delay`, `quality` and `other`.

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
Returns: `data` = the order. Message: "Course N sent to the kitchen".
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
Returns: `data` = `{ guestWebAddress, tokensEnabled, tokenOrderTypes[], collectionClearMinutes, posOrderTypes[], defaultOrderType, updatedAt }`. `posOrderTypes` are the kinds of order the POS takes (`dine_in`, `takeaway`, `delivery`; all three until changed) and `defaultOrderType` the one a new order starts on.

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

#### `PUT /api/orders/service-settings/guest-web-address`
Permission: `tables.manage`
Body: `guestWebAddress` (string, at most 200 characters). Empty clears it, and the staff screens then use the guests' site's own address (the staff app's `VITE_CUSTOMER_WEB_URL`). `https://` is added when no scheme is given. It is saved as origin + path, without a trailing slash.
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
Returns: 201, `data` = the pre-order. The advance's payment type is checked before anything is saved. If the till then refuses the advance (no business day open, for instance), the pre-order is booked all the same: `data.advanceRefused` is the reason, the message says the advance was not taken, and it is taken later with `POST /api/preorders/:id/advance`.
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

Mounted at `/api/table-requests` (tableRequest.routes.js). The user must be signed in, and `resolveOutlet` runs. The inbox is scoped to the request's outlet, plus tables that belong to no outlet. A request from another outlet answers 404. The inbox also holds orders from the online ordering page (`channel: "website"`, with no table). The request shape is `{ id, type (order, call_waiter, bill, water, other), status, tableId, tableNo, channel (qr, website), serviceType, deliveryAddress, paymentMode, deliveryCharge, outletId, guestName, guestMobile, notes, itemCount, estimatedTotal, items[], orderId, orderNumber, orderAction, rejectReason, repeatCount, acknowledgedAt, resolvedAt, createdAt, fromEarlierDay, responseSeconds, tableOrder }`. `guestMobile` is masked for users without `customers.contact`. A bad `:id` answers 404 "Request not found".

#### `GET /api/table-requests`
Permission: `orders.view`
Query: `view` (`pending` default, `today`, `history`, `all`), `type` (order, service, online), `limit` (whole number, 1-500, default 200), `offset`, `from`, `to` (YYYY-MM-DD).
Returns: `data` = `{ items[] (each with `captain`), total, limit, offset, from, to, serverTime, since }`.
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
Returns: `data` = `{ outletId, placeName, token, path ("/book/<token>"), guestWebAddress, isEnabled, maxPartySize, seatSharePercent, minNoticeMinutes, daysAhead, durationMinutes, maxOpenPerMobile, blockedDates[], guestNote, updatedAt, room: { tables, seats, largest, onlineSeats }, hoursSet }`. These settings belong to the request's selling point. The row is created on first read.

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
Errors: 400 the cash counted is more than the cash bills come to; 400 the cash is short and no reason was given; 409 a bill is not waiting for this rider (paid at another till meanwhile), or the bills were settled at another till; 409 no business day is open; 404 rider not found.

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
Body: `name` (string, required, <=150), `mobile` (normalised to one format), `email`, `address` (<=500), `dateOfBirth` / `anniversaryDate` (YYYY-MM-DD, not in the future), `notes` (<=500), `status` (`active`|`inactive`, default active), `companyName` (<=150), `gstin`, `tags` (array or comma list of `vip`,`allergy`,`jain`,`vegan`,`corporate`,`family`,`blogger`), `allergies` (<=300), `marketingOptIn` (bool), `sameDigitsConfirmed` (bool)
Returns: 201, `data` = the customer.
Errors: 400 GSTIN without `companyName`; 400 tag `allergy` without `allergies`; 409 mobile already held (`data: { existingId, existingName }`); 409 same ten digits in the other form (`data.reason: "same_digits"`, resend with `sameDigitsConfirmed: true` if genuinely different).

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
Returns: `data` = `{ customer, pointsCancelled, cleared, detached }`. Personal details are removed everywhere (feedback, complaints, orders, bookings); bills stay; owed points are cancelled; open orders/bookings carry on as walk-ins. The log names the record by number only.
Errors: 400 missing reason; 404 not found; 409 already erased.

#### `PUT /api/crm/customers/:id`
Permission: `customers.manage`
Body: as for create; a field left out keeps its value, a field sent empty is cleared. A masked contact box sent back empty by a user without `customers.contact` keeps the stored contact.
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
Returns: `data` = the bill: `{ id, billNumber, orderId, orderType, brandName, outletId, businessDayId, businessDate, customerId, subtotal, couponDiscount, manualDiscount, itemDiscountAmount, discountReason, taxAmount, serviceCharge, serviceChargeWaived, deliveryCharge, roundOff, totalAmount, paidAmount, refundedAmount, creditedAmount, heldAmount, dueAmount, billStatus, isComplimentary, loyaltyPointsUsed, printCount, isSplit, items[], payments[], tipTotal, corrections[], refunds[], creditNotes[], accountCustomerId, accountName, invoice, pointsEarned, pointsTakenBack, pointsBalance }` and more (`bill.service.js` `toBill`). Mobiles are masked without `customers.contact`.
Errors: 404 not found or another outlet's bill.

#### `POST /api/bills`
Permission: `billing.manage`
Query/Body: `orderId` (required). `items` (optional `[{ orderItemId, quantity }]`): when left out, everything still unbilled is billed. A subset splits the order across bills (`isSplit`). Also `discountCode` (≤30), `loyaltyPoints` (1 to 1,000,000), `serviceCharge` (`{ waive: true, reason }` needs the reason).
Returns: status 201, `data` = the new bill. A delivery charge goes on the order's first bill only. The bill takes the outlet's GSTIN when the outlet has one.
Errors: 404 order not found or another outlet's; 409 order not open; 400 no items, "Only N of X is left to bill", nothing left to bill; 400 coupon refused (not found, inactive, dates, usage limit, minimum order, order type, weekdays or hours, once per guest, chosen dishes only); 400 points refused (switched off, no guest, too few, under the minimum, over the per-bill limit `reason: "points_limit"`); 400 no service charge to take off; 409 part of the order billed a moment ago.

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
Query/Body: `paymentMethod` (required, the six methods or `advance`), `amount` (required, 0.01 and up), `tenderedAmount` (cash given), `transactionRef` (≤100), `tipAmount` (0 to 999,999, on top of the amount), `paymentTypeId`, `advanceId` (required for `advance`).
Returns: status 201, `data` = the bill with the new payment. Change = tendered − amount − tip, given only in cash. A tip never counts toward sales, GST, discount base or points. Points are earned when the bill is paid in full.
Errors: 409 voided; 409 "This bill is already paid in full"; 409 no business day open; 400 "Only N is still due…" (extra money is a tip); 400 cash given less than payment plus tip; 400 no advance picked or a tip on an advance payment; 404 advance not found; 400 advance has only N left; 400 payment-type errors.

#### `PATCH /api/bills/:id/payments/:paymentId`
Permission: `payments.manage` and (`bills.payment_correct` or manager approval)
Query/Body: `paymentMethod` (required, the six methods; not `advance`), `paymentTypeId`, `transactionRef`, `reason` (required, ≤200)
Returns: `data` = the bill. Message: "The N payment is now recorded as UPI". Only the method, type and reference change. The amount stays the same. Each correction is kept in `payment_corrections`.
Errors: 404 payment not on this bill; 409 voided; 409 payment did not go through; 409 the payment's business day is closed (refund and take it again instead); 400 advance payments cannot change method; 400 change was given in cash, so it must stay cash; 400 nothing would change; 400 payment-type errors; 403 approval scope mismatch.

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
Returns: `data` = the bill plus `copy` (`original` | `duplicate`) and `printCount`. Message: "Print recorded" or "Duplicate copy N recorded". Every print is counted, and reprints are written to the activity log. If another till printed the first copy a moment earlier, the request is treated as a reprint.
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
Returns: status 201, `data` = `{ customerName, method, businessDayId, till, allocations[{ billId, billNumber, amount }] }`. The money goes into the open day of the till taking it.
Errors: 404 guest not found; 400 owes nothing (on those bills); 400 "owes ₹N. Collect that much at most"; 409 `{ reason: "no_day", outletId }` when the till's day is not open.

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
Returns: `data` = `{ from, to, rate, receivedCount, received, usedSamePeriod, table11A{ gross, taxable, cgst, sgst }, table11B{...} }`. These are GSTR-1 tables 11A (received and not invoiced in the period) and 11B (earlier advances used in the period), at the restaurant's default GST rate.

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
Errors: 400 both `reservationId` and `orderId`; 404 guest or order not found; 400 guest record erased; 409 the order is not a takeaway, is already billed, or is not open; 409 the order is another guest's; 409 no business day open; 400 payment-type errors.

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
Returns: `data` = `{ history[{ table, label, count }], setup[{ table, label, count }], lastBillAt, canDelete, mustDeactivate }`. `history` covers sales, stock, days and money (these must stay). `setup` covers people, tables and floors (these can be moved). Open pre-orders are not counted: `canDelete` can be true for an outlet that `DELETE` still refuses until they are handed over or cancelled.
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

All routes are mounted at `/api/businesses` (`backend/src/modules/business/core/routes/business.routes.js`, with the trade, retail, fashion and electronics, salon and weight, health, quotations, hardware, licences, agri, optical, garage and counter route files added to the same router) and follow the [Business Admin conventions](#business-admin-conventions).

### Directory

These three routes have no `:businessId`, so they skip the membership check.

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
Returns: `data = { from, to, timezone, locationId, generatedAt, seller, sales: { bills, total, tax, roundOff, returns, returnsCount, net, onCredit, walkInBills, walkInUnpaid, offers, points, counterDiscounts }, received: { cash, upi, card, bank, cheque, total, atSale, laterOnBills, collections, fromFinanciers, fromSuppliers }, finance: { booked, bills, cancelled, subvention }, refunds: { cash, upi, card, bank, cheque, total }, suppliers: { cash, upi, card, bank, cheque, total }, bounced: { cash, upi, card, bank, cheque, total }, expenses: { cash, upi, card, bank, cheque, total, visible } | { visible: false }, cashInHand, net, byMethodName: { received[], refunds[], suppliers[], bounced[], expenses[] }, byPerson[], byLocation[] }`. The day close: what was sold and what money came in and went out, by payment kind, by the person who took it and by location. Read-only.
- Money in (`received`) is payments taken on sales, collections, refunds received from suppliers (`fromSuppliers`) and financiers' payouts recorded in the dates (`fromFinanciers`).
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
Returns: `{ items[{ id, severity (critical, warning, info), category, title, detail, at, link }], counts, generatedAt }`. Worked out from live data when asked; nothing is stored. The alerts: items at or below their reorder level (`inventory.view`); batches expired or expiring within the business's Expiring soon days (30 until changed; `inventory.view`, `batches`); customers with bills past due, and promises to pay due today or broken (`receivables.view`); repairs ready or late (`repairs.view`); appointments still to come today (`appointments.view`); licences that run out within 60 days or have run out (`licences.view`; see [Licences & registrations](#licences--registrations)); and the tasks and issues described under [Tasks, issues & projects](#tasks-issues--projects). Ids are stable per alert, so the browser remembers which were read. At most 15 per kind.

### Paged lists (core)

All of these follow the paged-list contract above. `documents` lists only the kinds the caller may view. Asking for `kind=sale` or `kind=purchase` without that kind's `.view` permission gives 403.

| Endpoint | Permission | Filters | Date range on |
|---|---|---|---|
| `GET /api/businesses/:businessId/catalog` | `catalog.view` | `category` (category id), `kind` (`goods`/`service`), `active`, `kit` (`true`), `department` (department id; always the person's own when they are tied to one) | none |
| `GET /api/businesses/:businessId/categories` | `catalog.view` | `active` | none |
| `GET /api/businesses/:businessId/units` | `catalog.view` | none | none |
| `GET /api/businesses/:businessId/pack-sizes` | `catalog.view` | `sku` | none |
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
Returns: `data` = the `business_settings` row (display/legal name, GSTIN, address, `tax_mode`, `rounding`, `fiscal_year_start_month`, footers, `date_format`, the counter rules, the business rules, ...) plus the business's `currency` and `timezone`.

#### `PUT /api/businesses/:businessId/settings`
Permission: `settings.edit`
Query/Body: `displayName` (required, up to 150 chars), `legalName`, `gstin` (validated), `stateCode` (2 digits; defaults to the GSTIN prefix and must match it), `addressLine1/2`, `city`, `postalCode` (6 digits), `phone`, `email`, `logoPath`, `taxMode` (`exclusive`/`inclusive`, required), `rounding` (`none`/`nearest_rupee`, required), `fiscalYearStartMonth` (1-12, required), `invoiceFooter`, `receiptFooter`, `dateFormat` (`DD/MM/YYYY`, `DD-MM-YYYY`, `DD MMM YYYY`, `YYYY-MM-DD`, required). Optional, each kept when left out: the counter rules `maxBillDiscountPercent` (0-100, default 10), `walkInCredit` (boolean: allow unpaid walk-in bills) and `counterPinEveryBill`; the business rules (Business settings › Rules) `voucherValidDays` (1-3650; how long a credit voucher can be spent, 90 until changed), `ageingDays` (three increasing day counts, the edges of the customer-credit age groups; 30, 60, 90 until changed), `nearExpiryDays` (1-365; "expiring soon" for batches, 30 until changed), `weightButtonsGrams` (1-8 weights in grams for the quick weight buttons at Quick bill), `receiptWidthMm` (58 or 80), `dayCutoffHour` (0-12; until this hour a task due after midnight still belongs to the day before); `currency` (ISO code) and `timezone`.
Returns: the saved settings row (an upsert) with `currency` and `timezone`. The rules are audited as `settings.rules_updated`.
Errors: 400 validation (for example "The state code must match the first two digits of the GSTIN"); 409 when the fiscal-year start month changes after any number series exists; 409 when the currency changes once bills or purchases are recorded.

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
Errors: 404 not found; 409 "A tax slab's rate cannot change"; 409 when switching off a slab that active items still use.

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
Returns: 201, the membership row plus `role_name`, `name`, `email`: a login of their own for a member of staff, with no restaurant behind it (a restaurant business's staff stay with that restaurant). The role, location and department go through the checks of `POST /members`; when those refuse, the new login is removed again.
Errors: 400 validation; 409 "That email already has a login. Give that person access with "Give access" instead."; 409 the mobile number already has a login; plus the errors of `POST /members`.

#### `POST /api/businesses/:businessId/staff-accounts/:userId/password`
Permission: `access.edit`
Query/Body: `password` (8-72, required)
Returns: `{ id, name }`. The person is signed out everywhere and their sign-in lockout is lifted.
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

### Contacts

#### `POST /api/businesses/:businessId/contacts`
Permission: `contacts.create`
Query/Body: `kind` (`customer`/`supplier`), `name` (required), `phone`, `email`, `address`, `gstin`, `pan` (five letters, four digits and a letter, any case), `creditLimit` (customers only), `creditDays` (0-365), `openingBalance` (signed), `openingBalanceOn` (date, required when there is an opening balance)
Returns: 201, the contact.
Errors: 400 a credit limit on a supplier, an invalid GSTIN or an invalid PAN.

#### `PATCH /api/businesses/:businessId/contacts/:id`
Permission: `contacts.edit`
Query/Body: the same fields as create, plus `active`. Fields left out keep their current credit terms, opening balance, GSTIN and PAN. The kind cannot change.
Returns: the updated contact.
Errors: 404 not found.

### Sales and purchase documents

#### `POST /api/businesses/:businessId/documents`
Permission: `sales.create` or `purchasing.create`. The service then requires the one that matches `kind`, plus `<kind>.edit` when money is taken now, a voucher is spent or part is financed.
Query/Body:
- `kind` (`sale`/`purchase`), `requestKey`, `locationId`, `contactId` (required for a purchase; a customer for a sale), `notes`.
- `lines[1..100]` of `{ skuId, quantity, unit? (a pack or related unit), lotCode (batch/serial items), expiresOn }`. Purchase lines also take `unitPrice`; `freeQuantity?` and `discountPercent?` (free units on a scheme, "10 + 1 free", and a trade discount of up to 99.99% on the rate, in the line's own unit); and `sellingPrice?` / `mrp?` (the item's new shelf price and MRP from this bill; needs `catalog.edit`; audited as `catalog.price_changed`). A sale line whose item is a kit takes `components[]` of `{ skuId, lotCode }`, naming the serial (required) or batch (optional; the earliest expiry otherwise) of a part.
- Money taken now: `payment` `{ amount, method (cash/card/upi/bank/cheque) or methodId, reference, tendered? }`, or `payments[1..8]` of the same shape for a bill paid in several ways (sending both is a 400). An `amount` of `"full"` (on at most one part) is the rest of the bill. `tendered` (the cash handed over) is for cash only and is at least that part's amount; the answer then carries `change`.
- A purchase: `supplierBillNo` and `supplierBillDate` (the supplier's own bill; a date needs the number and is not in the future).
- A sale: `buyer: { name, phone, pan, panDeclaration }` (a walk-in who is not saved as a customer, used for a warranty; `pan` the buyer's PAN, or `panDeclaration: true` when they have none and signed Form 97, not both); `discount: { amount | percent, reason }` (a counter discount: an amount or a percent with up to 2 decimals, not both, and a reason of up to 120 characters; needs `sales.discount`; at most the business's *Most discount at the counter*, `maxBillDiscountPercent`, unless the caller is an Owner); `voucher: { code }` (an exchange credit voucher; it pays first, as a `credit_note` payment with the voucher number as reference, never more than its balance or the bill, and `"full"` is then what is left); `finance: { financierId, loanNo, doNo?, tenureMonths?, amount (a number, or "rest") }` (an EMI through a financier: needs module `finance` and `finance.create`; the financed amount becomes a payment of method `finance`); `channel: "counter"` with `counterPin` (Quick bill: when Business settings ask for the PIN on every bill, `counter_pin_every_bill`, it is the PIN of the person the session belongs to; the PIN is left out of the request hash and never stored).
- Retail sales also take `loyalty: { redeemPoints }` (needs `loyalty.create`) and `coupon` (a code typed at the counter; needs the Offers module); salon sales take the salon fields. See `businessOffers.js` and `businessSalonSales.js`.
- A hardware shop's sale also takes `siteId` (one of the customer's open sites) and `fitterId` (a fitter who is on, with module `fitter_commission` and `fitter_commission.create`; the bill's commission is worked out and kept with it): [Hardware, paints & building materials](#hardware-paints--building-materials). Any other business, or a purchase, naming a site or a fitter is refused with 400 before anything is posted.
- A seeds, fertilisers & pesticides shop's sale also takes `agri: { posReceipt?, crop?, season?, seasonYear?, dueOn?, village? }` and, on each line, `crop?` and `posReceipt?`; each farm-input line is checked for its licence, its molecules, its crop, its lot and its PoS receipt: [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides). Any other business, a purchase, or a farm-input shop with the module off, sending them is refused with 400 before anything is posted.

Returns: 201, the document row (`document_no`, `subtotal`, `tax`, `round_off`, `total`, `due_on`, ...), plus `change` when cash was handed over, `financeCase` for an EMI sale, and `warranties` when serial units are sold with the Warranties module on. The server works out sale prices (customer price, quantity slabs, pack prices, the selling branch's own price, a loyalty customer's member price, offers, the counter discount) and GST from the business tax mode and rounding. A sale's place of supply is the buyer's GSTIN state, else the selling location's own state, else the business's. Each line keeps the item's HSN code and MRP. A purchase line with free units takes in paid + free units and is charged for the paid ones, less the trade discount; it keeps `free_quantity` and `discount_percent`. Each payment part is its own `business_payments` row (`tendered` kept on the cash row).
Rules:
- A goods shop's walk-in (a sale with no customer) pays the whole bill now, counting a voucher and a financed part, unless the business allows unpaid walk-in bills (`walkInCredit`): otherwise 409 "A walk-in customer pays the whole bill now…".
- Nothing is sold, or given a new shelf price on a receipt, above its MRP; with prices before GST the GST is added before comparing.
- The parts paid, plus any voucher and financed amount, may not come to more than the total.
- A customer's credit limit counts what they would owe after this sale, less what they pay now.
- A sale over ₹2,00,000 records the buyer's PAN: `buyer.pan`, else the customer's saved PAN, else the PAN inside their GSTIN or on their wholesale details; or `buyer.panDeclaration`. Otherwise 400. The document keeps `buyer_pan` and `pan_declaration`.
- Cash of ₹2,00,000 or more is refused (409, a sentence citing section 186 of the Income-tax Act 2025) for one bill, and from one customer in one business day across their bills and collection receipts. Other methods are not limited.
- A supplier's bill number already received from that supplier is refused.
- A kit sells as its parts, each at its share of the kit's price; a serial-numbered part makes it one kit per line. Saved lines carry `kit_sku_id`, `kit_label` and `kit_group`.
- An EMI needs the customer named (a contact, or `buyer` with name and phone), and a loan number is used once per financier.

Errors: 400 both `payment` and `payments`, more than 8 parts, or two parts of `"full"`; 400 the parts come to more than the total; 400 cash handed over less than its part; 400 free quantity or a trade discount on a sale; 400 a serial-numbered kit part on a line of more than one kit; 400 an EMI amount more than what is left; 400 pharmacy purchases without a batch or expiry, and quantity or unit-precision errors; 403 `{ reason: "pin_required" }` without the counter PIN, 400 `wrong_pin`, 423 `pin_locked`, 429 too many tries; 404 location, contact or item not found; 404 no coupon with that code, or an unknown voucher; 409 not enough usable stock, credit limit exceeded, serial already received, or request key reused with different data; 409 a walk-in not paying in full; 409 a price above the MRP; 409 a supplier bill number already received ("Bill … from … was already received as …"); 409 an item kept for use in services only (`internalUse`); 409 a coupon that cannot be used now (switched off, outside its dates or hours, the bill below its minimum, used up, or already used by this customer as often as allowed); 409 a counter discount over the business's limit, or more than the bill; 409 a voucher expired or used up; 409 buying a kit; 409 an EMI without the customer named, or a loan number already used with that financier.

#### `GET /api/businesses/:businessId/documents/:id`
Permission: `sales.view` or `purchasing.view`, plus the one matching the document's kind
Query/Body: none
Returns: `{ ...document, location_name, contact_gstin/phone/address, lines[] (each with returned_quantity), payments[] (each with method_name and tendered), returns[], refunds[], seller, retail, finance[], pharmacy, wholesale }`. `contact_gstin` and `contact_address` are the buyer's as billed. `seller` is Business settings with the selling location's own address, phone, state and GSTIN where it has them, and `branch_name` when it has its own address or GSTIN. For a sale, `retail` is `{ discounts[], savings, loyalty[], heldBack }`; otherwise it is null. `finance` lists an EMI bill's case (financier, loan, DO, amounts, status), and is empty otherwise. `pharmacy` is filled for a pharmacy sale (see [Pharmacy, clinic & lab](#pharmacy-clinic--lab)), `wholesale` for an invoice raised by dispatching a sales order (see [Sales orders and dispatch](#sales-orders-and-dispatch)), `hardware: { site, fitter }` for a hardware shop's sale (see [Hardware, paints & building materials](#hardware-paints--building-materials)) and `agri: { lines, bill, farmer, licences }` for a farm-input shop's sale (see [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides)); otherwise they are null.
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
Returns: the till carries on as that member: `{ token, expiresAt, user }`, like `POST /api/auth/pin-login`.
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
Returns: `{ ...order, location_name, salesperson_name, route_name, beat_name, contact_phone, contact_gstin, credit_limit, created_by_name, lines[] (each with remaining, remaining_value, available), dispatches[] (each with document_no, total, invoiced_at, lines[]) }`
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

A warranty is registered from a sold serial line. Its start defaults to the sale date; its months and terms come from the model; the customer's name and phone come from the sale or the body. Each sold unit can have one live warranty. A warranty cannot be edited or deleted, only cancelled. The Warranties module depends on `serials` and `sales`.

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
Query/Body: `requestKey` (UUID, required); `lineId` (the sold line, required); `startsOn` (`YYYY-MM-DD`; defaults to the sale date; it cannot be before the sale or in the future); `months` (1-120; defaults to the model's months); `customerName`; `customerPhone` (required when the sale has no contact phone); `terms`.
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
Query/Body: `requestKey` (UUID, required); `locationId` (required); `problem` (required, up to 1000); `contactId` or `customerName` + `customerPhone` (both are needed in the end); `skuId` or `device` (one is required); `serial`; `accessories`; `conditionNotes`; `estimate`; `promisedOn` (`YYYY-MM-DD`); `technician`; `passcode` (the screen lock, up to 60; kept only while the job is open); `checklist` (an object of condition ticks such as `screen_cracked`, `water_damage`; at most 20); `advance` (`{ amount, method: cash|card|upi|bank, reference? }`: recorded as a customer collection, a customer record being found by phone or made, and paid onto the bill at delivery); `warrantyOwnerConfirmed` (noted in the history when someone other than the warranty's owner brings the device).
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
Permission: `appointments.create`, `sales.edit` or `repairs.view`.
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
Returns: `data` = `{ total, items[] }`. Each item is a batch plus `location_name, created_by_name, template_name, input_lot_code, yield_percent, expected_yield, cost_per_usable_kg, outputs[{ sku_id, label, unit, quantity, kg, cost_share, unit_cost, expected_percent, lot_id }]`.

#### `POST /api/businesses/:businessId/weight/processing`
Permission: `processing.create`. Module: `processing`.
Query/Body: `requestKey` (UUID, required); `inputLotId` (the stock lot being cut, required); `inputQuantity` (required, in the lot's unit, no more than the lot holds); `outputs` (1-20 of `{ skuId, quantity, packKg? }`, each a weight item, no repeats, not the input; `packKg` for an output sold by the piece, remembered per item); `templateId` (optional; must belong to the same input item); `cutBy` (who cut it); `notes` (up to 500).
In one transaction, the input weight leaves its lot and each cut enters stock at the same location. The input cost is split across the cuts by selling value, or by weight when no cut has a price. A batch-tracked cut gets a batch named after the cutting number, with the input's expiry. The supplier of the input batch is recorded with the cutting.
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
Query/Body: list: paged, filters `status`, `active`, `today`, `id` and `location`; dates on the pickup time. POST: `{ locationId, contactId? | customerName, phone?, pickupAt, notes?, lines: [{ skuId, quantity? | amount?, note? }], requestKey }`.
Returns: phone and WhatsApp orders for pickup; POST returns the new order.

#### `POST /api/businesses/:businessId/weight/pickup-orders/:orderId/status`
Permission: `sales.create`. Module: `weight`.
Query/Body: `status`: `open` (back to packing), `ready`, `cancelled` (with a `reason`) or `collected` (with its bill's `documentId`).
Returns: the order.
Errors: 404 order or bill not found; 409 the order is already collected or cancelled, or the bill is older than the order or already on another order.

**Reports**

#### `GET /api/businesses/:businessId/weight/reports/yield`
Permission: `reports.view`; the service also requires `processing.view`. Module: `processing`.
Query/Body: `from` and `to` (required, at most 367 days apart); `location`, `template`, `cutter`, `supplier` (optional).
Returns: `data` = `{ from, to, inputs[], cuts[], days[], cutters[], suppliers[], bySupplier[], shortValue, totals }`. `inputs` holds each input item's batches by item and template (`label` = the template's name): kg in, out and lost, `yield_percent`, `expected_percent`, the cost per usable or input kg, and the shortfall against the template: `short_points` (percentage points below the expected yield), `short_kg` (the usable kg not got) and `short_value` (those kg at the cost of a usable kg), which add up to `shortValue`. `cutters` names who cut. `cuts` gives the kg, cost and share of each cut. `bySupplier[]` is `{ supplier_id, supplier_name, input_sku_id, input_label, batches, input_kg, output_kg, loss_kg, yield_percent, batch_average_percent, worst_percent, best_percent, expected_percent, cost_per_usable_kg, item_average_percent, versus_average }`; a batch's supplier is the one kept when it was cut, otherwise the purchase that brought its input batch in, and the `supplier` filter uses the same. `totals` = `{ batches, inputKg, outputKg, lossKg, yieldPercent, inputValue }`.
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
| `POST /pharmacy/sales` | sales.create (+ sales.edit to pay, pharmacy.create for scheduled lines) | `{ requestKey, locationId, contactId?, lines: [{ skuId, quantity, unit?, lotCode? }], payment? \| payments? (split, up to 8, as on documents), channel?: "counter", counterPin?, prescription?: { patientName, patientPhone, patientAge, patientAddress, doctorName, doctorRegNo, doctorAddress, prescribedOn, fileId }, signoff?: { signatoryId, pin } }` → `{ document, prescription, registers }`. 409 `prescription_required`, `prescription_scan_required`, `pharmacist_signoff`; PIN errors as `wrong_pin`, `pin_locked`, `no_pin`. Batches first-to-expire, whole strips first. Same request key → the same bill |
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
| `GET /clinic/visits/:id` | patients.view | Front-desk fields; with patients.view_clinical also vitals, notes, diagnosis, prescription, approved lab results (logged) |
| `PATCH /clinic/visits/:id` | patients.edit_clinical | Vitals (`bpSystolic`, `bpDiastolic`, `pulse`, `temperatureC`, `spo2`, `respRate`, `weightKg`, `heightCm`), `complaints`, `examination`, `diagnosis`, `icd10Code`, `advice`, `followUpOn`, `resourceId`, `prescription: [{ drugName, strength, dose, frequency, duration, instructions }]`, `complete: true` |
| `POST /clinic/visits/:id/notes` | patients.edit_clinical | `{ body }`, added after completion |
| `POST /clinic/visits/:id/bill` | sales.create | `{ documentId }` links the desk's bill, or `{ requestKey, locationId?, lines?, payment?, includeConsultation? }` posts the consultation (+ lines) at the visit's location. The consultation is the doctor's fee, their follow-up fee or nothing within the follow-up days (as `GET …/fee` says), else the booked service; a free follow-up with nothing else to bill is recorded with no bill (`document: null`). Returns `{ visit, document, fee }` |
| `GET /clinic/visits/:id/fee` | sales.create or patients.view | What the visit's consultation is charged: `{ kind, skuId, label, price, follow_up_days, last_consultation }`, `kind` being `consultation` (the doctor's fee), `follow_up` (their follow-up fee) or `free_follow_up` (within the follow-up days of the patient's last paid consultation with that doctor); for a doctor with no fee set, `{ kind: booked_service, skuId, label, price }` (the appointment's service) or `{ kind: none }` |
| `GET /clinic/doctors?location` | appointments.view | Doctors (and rooms) at the branch, with `is_doctor`, `speciality`, the consultation and follow-up fees (`consultation_sku_id`, `consultation_label`, `consultation_price`, `follow_up_sku_id`, …), `follow_up_days`, `slot_minutes` (10 until set), `share_percent`, `sessions[{ id, dow, starts, ends, max_patients }]` and leave still to come |
| `PUT /clinic/doctors/:resourceId` | settings.edit | `{ speciality, consultationSkuId, followUpSkuId, followUpDays (0-90), slotMinutes (5-120), sharePercent (0-100), sessions? }`. The fees are services on the bill (a follow-up fee needs a consultation fee); `sessions` (OPD by weekday, `[{ dow (0 = Sunday), starts, ends (HH:MM), maxPatients? (1-500) }]`, up to 28, none overlapping on a day) replaces the week, and left out keeps it. An appointment on a day the doctor is on leave is refused, and once the doctor has sessions, one outside them too (409 `doctor_unavailable`). Returns the doctor as the list has it; 404 doctor or fee service not found |
| `POST /clinic/doctors/:resourceId/leave` · `POST /clinic/leave/:id/cancel` | appointments.edit | `{ fromDate, toDate? (default fromDate), reason? }` → 201 the leave with `booked` (appointments already on those days, for the desk to move) · cancels it (cancelling again changes nothing); 404 doctor or leave not found |
| `GET /clinic/slots?day&doctor` | appointments.view | A doctor's appointment slots for a day, `slot_minutes` each within that day's sessions: `{ doctor, day, sessions, leave, scheduled, slots[{ starts_at, ends_at, past, taken }] }` (no slots on leave) |
| `GET /clinic/doctor-earnings?from&to&location` | reports.view | Per doctor for the period: `visits, consultations, follow_ups, free_follow_ups, not_billed, fees, share_percent, share` (their share of the consultation fees billed); `totals { visits, fees, share }` |
| `GET /clinic/queue?day&location&doctor` | patients.view | The token queue for a day (today by default): every token, and per doctor who is being seen (`serving`), the last called, `waiting`, `done` and the next three |
| `POST /clinic/tokens` | patients.create | `{ appointmentId }` (on the appointment's day; asking again returns its token) or `{ contactId, resourceId? }`, with `priority?`, `note?`, `locationId?` → 201 the token: the next number for that doctor (or the clinic) that day. 409 `not_a_patient`, `consent_required`, the doctor on leave, `opd_full` (the day's sessions' maximum reached), or the patient already holding a token today |
| `POST /clinic/tokens/next` | patients.create or patients.edit_clinical | `{ resourceId?, locationId? }`, "Next patient": the token being seen is done, one called who did not come in is skipped, and the next waiting token (priority first) is called → `{ called }` (null with "No one is waiting") |
| `POST /clinic/tokens/:id` | patients.create or patients.edit_clinical | `{ action: call / start / done / skip / cancel }`; `start` opens the patient's consultation (from the appointment, if any) and links the visit. 409 a move the token's state does not allow |

A token moves waiting → called → in consultation → done, or is skipped or cancelled; completing its visit marks it done.

**Lab**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /lab/tests` · `GET /lab/tests/:id` | lab.view | Tests and profiles · one with parameters and ranges (ages in years) |
| `POST /lab/tests` · `PUT /lab/tests/:id` | lab.edit | `{ code, name, kind: test / profile, skuId, sampleType, container, method, turnaroundHours, active, parameters: [{ id?, name, unit, resultType, decimals, active, ranges: [{ sex, ageFrom, ageTo, low, high, criticalLow, criticalHigh, normalText }] }], testIds (profile) }` |
| `GET /lab/orders` · `GET /lab/worklist` | lab.view | Orders (period; `status`, `priority`, `patient`, `outside`, `visit`, `location`) · counts by stage |
| `POST /lab/orders` | lab.create (+ sales.create / sales.edit to bill) | `{ requestKey, locationId, contactId \| visitId, testIds, priority, referredBy, notes, documentId? \| bill: true, payment? }`; one sample (barcode) per sample type |
| `GET /lab/orders/:id` | lab.view | Order, samples, tests; results only with lab.edit, lab.approve or patients.view_clinical (logged); while it is received, in process or resulted, `qc[{ parameter_id, name, status }]`: today's QC of its parameters (`accepted`, `warning`, `rejected`, `not_run`) |
| `POST /lab/samples/:id` · `GET /lab/samples/barcode/:code` | lab.create · lab.view | `{ action: collect / receive / reject, reason }` · open a sample by its barcode |
| `PUT /lab/orders/:id/results` | lab.edit | `{ results: [{ orderTestId, parameterId, value }] }` (empty value clears); flags against the patient's range |
| `POST /lab/orders/:id/approve` | lab.approve | `{ signoff: { signatoryId, pin } }` (a pathologist). Each signing is kept as a numbered version of the report. 409 `qc_rejected` `{ parameters }` while today's QC of one of its parameters is rejected |
| `GET /lab/orders/:id/report` | lab.print | The printable report of an approved order (logged as `lab.report_printed`), with `report_version`, `report_amend_reason` and `amends` (the version it amends). `?version=N` prints an earlier signed version as it was, marked `superseded`; 404 a version never signed |
| `GET /lab/orders/:id/versions` | lab.print, lab.approve or lab.edit | Every signed version, newest first: `{ order_id, order_no, current, versions[{ id, version, amend_reason, approved_at, results[], pathologist_name, pathologist_qualification, pathologist_reg_no, superseded }] }` |
| `POST /lab/orders/:id/amend` | lab.approve | `{ reason, signoff: { signatoryId, pin } }` (a pathologist): reopens a signed report for correction (back to `resulted`). It is corrected and signed again with `POST …/approve`; the new version says it amends the earlier one, which can still be printed. 409 when the report is not signed |
| `POST /lab/orders/:id/refer` · `POST /lab/orders/:id/cancel` | lab.create | `{ outsideLab, referenceNo, outsideCharge, referralCommission? }` (409 `referral_commission_off` while the setting is off) · `{ reason }` |
| `GET /lab/qc/materials` · `POST /lab/qc/materials` · `PUT /lab/qc/materials/:id` | lab.view · lab.edit | Quality-control materials, one per numeric parameter, lot and level: list (filters `active`, `parameter`; rows add `parameter_name, unit, test_code, test_name, last_run, today_outcome, expired`) · `{ parameterId (create only), name, lotNo, level (default "Level 1"), mean, sd, expiresOn?, active }`; 404 a parameter that is not numeric or not yours, or a material not found; 409 the lot and level already set up for the parameter |
| `GET /lab/qc/runs` · `POST /lab/qc/runs` | lab.view · lab.edit | Runs (filters `material`, `parameter`, `outcome`; dates on `run_at`) · `{ materialId, value, note?, correctiveAction? }` → 201 the run with its `z` score, the Westgard `rules` it broke and its `outcome`: 1-2s warns; 1-3s, 2-2s, R-4s, 4-1s and 10x reject. 409 a control material that is switched off, or an expired lot |
| `GET /lab/qc/today` | lab.view | Today's QC by parameter: each control's latest run and the parameter's `status` (`rejected`, `not_run`, `warning`, `accepted`), with a count of each. While a parameter's latest run today is rejected, a report with that parameter cannot be signed |

## Quotations

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `quotations`, permission). The list takes `limit`, `offset`, `q`, `from`, `to` and its filters and answers `{ total, items }`. Backend module `modules/business/quotations/`. How the figures are worked out: [BUSINESS_PLATFORM_DATA_MODEL.md › Quotations](BUSINESS_PLATFORM_DATA_MODEL.md#quotations).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /quotations` | quotations.view | Quotations (period on `created_at`; search number, customer, phone, notes, bill, order, site; filters `status`, `state` (open, expired, billed, ordered, cancelled; several comma-separated), `contact`, `location`, `site`). Rows add `state`, `expired`, `location_name`, `document_no`, `order_no`, `line_count`, `site_id`, `site_name`, `created_by_name` |
| `POST /quotations/preview` | quotations.create or quotations.edit | `{ locationId, contactId?, lines: [{ skuId, quantity, unit? }], discount?: { amount \| percent, reason } }` → what a sale of these lines would come to now, nothing saved: `{ taxMode, contactId, lines[{ skuId, label, unit, quantity, unitPrice, priceKind, enteredUnit, enteredQuantity, enteredUnitPrice, unitFactor, priceRuleId, hsnCode, mrp, amount, discount, net, tax, taxRate, offers[] }], subtotal, tax, roundOff, total, savings }`. 400 a kit (quote its parts); a discount needs `sales.discount` and stays within the counter limit |
| `POST /quotations` | quotations.create | `{ requestKey, locationId, contactId? \| customerName (+ customerPhone?, 10 or more digits), validUntil (today up to 180 days ahead), lines (1-100), discount?, notes?, siteId? }` → 201 the quotation as `GET /quotations/:id` gives it, numbered `QT/…` at the location. `siteId` is a hardware shop's (400 elsewhere). Same key and body → the same quotation; same key, other body → 409 |
| `GET /quotations/:id` | quotations.view | The quotation with `state`, `lines[]` (with `sku_code` and `tracking`), `revisions[{ revision, total_before, total_after, lines_before, created_by_name, created_at }]`, what it became (`document_no`, `document_total`, `billed_at`; `order_no`, `order_status`), the saved customer's `contact_gstin`, `contact_address`, `contact_phone` and `contact_pan`, `seller` (as a bill prints it) and `site` (a hardware shop's; else null) |
| `PUT /quotations/:id` | quotations.edit | A revision: the body of `POST` without `locationId`. The lines are priced again at today's prices and replaced, and `revision` goes up; `siteId` left out keeps the site (one of another customer is taken off). 409 unless open. Same key and body → the same answer |
| `POST /quotations/:id/cancel` | quotations.cancel | `{ reason }`. Asking again returns the cancelled quotation; 409 when billed or ordered |
| `POST /quotations/:id/bill` | quotations.edit and sales.create (sales.edit to take a payment) | `{ requestKey, payment? \| payments? (as on documents), buyer?: { pan?, panDeclaration? }, lines?: [{ lineId, lots?: [{ lotCode, quantity }] \| serials?: [code] }], notes?, fitterId?, agri? (a farm-input shop's, as on documents) }` → 201 `{ quotation, document }`: a sale posted at the quoted prices (`fixed`), at the quotation's location, for its customer (a customer not saved is named in the bill's notes), with its site. Batches go oldest expiry first unless named; serial items need their numbers. 409 when it is expired (a sentence asking to revise it first), not open, an item's GST rate or pack size changed, the quoted rate is above the item's MRP now, the rounding setting changed, stock is short, a walk-in at a goods shop does not pay in full, or the credit limit or the cash limit is passed. Same key and body → the same bill |
| `POST /quotations/:id/order` | quotations.edit and sales_orders.create | `{ requestKey, expectedOn?, notes?, release?: { reason, approverId?, pin? } }` → 201 `{ quotation, order }`: a sales order at the quoted values for the saved customer, with the same credit-limit and credit-hold checks as any order (409 `credit_hold`), and the quotation's site. 409 when the customer is not saved, a line is a service, or as for the bill. Same key and body → the same order |

## Licences & registrations

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `licences`, permission). The list takes `limit`, `offset`, `q` and its filters and answers `{ total, items }`. Backend module `modules/business/licences/` (routes `businessLicences.routes.js`). Every route answers 403 while the module is off; a restaurant never has it. A person tied to one location sees and changes that location's licences only (403 for another). How they are used: [BUSINESS_PLATFORM_DATA_MODEL.md › Licences & registrations](BUSINESS_PLATFORM_DATA_MODEL.md#licences--registrations).

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /licences` | licences.view | Every licence with `location_name`, `updated_by_name`, `today` (the business's own date), `state` (`valid`, `expiring` (within 60 days), `expired`, `not_yet`, `no_expiry`, `off`) and `days_left` (to `valid_until`; null when it does not run out); search name, number, authority, location, kind, notes; filters `location`, `active`, `kind`, `state`, `id`. Switched-on ones first, then by the date they run out |
| `POST /licences` | licences.edit | `{ locationId, kind (a short code of letters, digits and _, such as fertiliser, seed, insecticide, trade, fssai, md42, bis or peso), name, licenceNo, authority?, validFrom, validUntil? (none: it does not run out), covers?: [fertiliser, seed, insecticide], notes? }` → 201 the licence with `location_name`, `state` and `days_left`. 400 a valid-until date before valid-from, or a category named twice; 404 a location not found or switched off; 409 the number is already kept for that kind of licence (any case; the sentence names the licence and its location). Audited `licence.created` |
| `PATCH /licences/:id` | licences.edit | The whole licence again without `locationId` and `kind`, which never change (sending another: 400, add that licence on its own), and `active?` (left out: unchanged; `false` when it is surrendered or cancelled). `authority`, `validUntil`, `covers` and `notes` left out are cleared. Audited, with what changed from and to, as `licence.renewed` (a later valid-until date, or none), `licence.switched_off`, `licence.switched_on` or `licence.updated`. A licence is never deleted |

`GET /notifications` (the bell) lists, for a role with `licences.view`, each switched-on licence that runs out within 60 days (warning: "… runs out in 12 days") or has run out (critical), linking to Licences. A farm-input shop's sale needs a licence in force covering each fertiliser, seed and pesticide line at the selling location: [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides).

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

**Tile & paint calculators** (module `hardware_calculators`; the service answers 404 for another type of business and 403 while the module is off)

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /hardware/calculator-items` | catalog.view | The items on sale (not kits, not kept for use in services) with a calculator figure in `attributes`: `[{ id, code, barcode, label, unit, price, mrp, product_id, product_name, attributes }]`, by product. `coverageSqftPerUnit`: the sq ft one unit of tiles covers; `coverageSqftPerLitre`: the sq ft one litre of paint covers in one coat; `litresPerUnit`: the litres in one unit (a paint's tins). The arithmetic is the staff app's (`hardware/pages/calculators.js`) |

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

A sale's `fitterId` (Quick bill, New sale, `POST /quotations/:id/bill`): each line earns by the item's rule, else the nearest category's up the tree, else the rule for every item: a percent of its value before GST (rounded to the paisa), or the amount per stock unit, never more than the line's value. The bill and its lines are written in the sale's transaction (`fitter_commission.earned` event); a return takes the commission back in proportion. `GET /documents/:id` answers `hardware.fitter: { id, name, trade, commission, taken_back, lines[{ line_id, percent, per_unit, commission }] }`, or `{ id, name, trade }` without `fitter_commission.view`.

## Seeds, fertilisers & pesticides

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `agri`, permission). The farmers list takes `limit`, `offset`, `q` and its filters and answers `{ total, items }`. Backend module `modules/business/agri/` (routes `businessAgri.routes.js`). Every route answers 403 while the module is off, and so for every other type of business, which never has it; the molecule list, which needs only membership, answers 404 for another type. Dates are the business's own (its time zone). A person tied to one location asks for that location only (403 for another). How it works: [BUSINESS_PLATFORM_DATA_MODEL.md › Seeds, fertilisers & pesticides](BUSINESS_PLATFORM_DATA_MODEL.md#seeds-fertilisers--pesticides).

**Molecules and farmers**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /agri/molecules` | any member | `{ molecules[{ code, name, status (banned, restricted_use, crop_restricted), restriction, source, crops[{ code, name }] (the crops it must not be used on) }], crops[{ code, name, aliases }] }`: the platform's molecule list, the same for every shop and changed only by migrations |
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
| `GET /agri/board` | agri.view | `?locationId&on?` (today, or a day gone by; 400 a day to come) → `{ location, on, today, closed, taxMode, rows[{ id, label, code, unit, unit_name, input_kind, subsidised, seed_class, seed_crop, seed_variety, price, mrp, opening, closing }] }`: each fertiliser, then each seed, with its opening stock that day (and its closing stock, for a day gone by) and its price (the location's own, else the item's) and MRP now |
| `GET /agri/seed-return` | agri.view | `?locationId&month=YYYY-MM` (this month or one gone by) → `{ location, month, dueOn (the 5th of the next month), closed, rows[{ id, label, code, unit, unit_name, crop, variety, seed_class, kg_per_unit, opening, purchased, sold, other, closing, opening_q, purchased_q, sold_q, other_q, closing_q }] }`: each seed's stock on the first, what was bought and sold (net of goods returned), other changes and the closing stock, in its stock unit and in quintals (4 places; null where the weight of one unit is not known: a unit of weight, or `netKg` on a counted item) |
| `GET /agri/insecticide-register` | agri.view | `?locationId? (every location)&from&to` (up to 367 days) → `{ location, from, to, rows[{ created_at, day, document_id, document_no, location_name, farmer, village, relative_name, line_id, product, batch, manufacturer, quantity, unit, expires_on, crop, molecules, returned }] }`: every pesticide line sold, oldest first. `farmer` and `village` are the customer's farmer details, or the walk-in's as the bill kept them; `manufacturer` is the item's own (`attributes.manufacturer`, with batches on), else its brand |

**On the core routes**

- `POST /catalog` and `PATCH /catalog/:id` take the item's classification in `attributes` while the module is on, sent whole with `inputKind` first (`fertiliser`, `seed`, `pesticide`, `bio_input`, `other`; empty takes the item out of the farm inputs, with no other farm-input keys): `subsidised` (`yes`; a fertiliser's), `seedClass` (`certified`, `truthfully_labelled`), `seedCrop` and `seedVariety` (a seed's), `molecules` (up to 5 names; a listed molecule takes the list's spelling) and `formulation` (a pesticide's), `netKg` (the weight of one unit, more than 0 with up to 3 decimals). 400 another key without `inputKind`, a key of another kind, a service, or a seed or pesticide not kept by batch (Batch & expiry tracking); 400 a seed's opening stock without `expiresOn` (its validity date); 409 a banned molecule (the sentence names it and its source; the database refuses it too). A change is audited `catalog.classified`, from and to.
- `POST /documents`, a sale (Quick bill, New sale and `POST /quotations/:id/bill`): `agri: { posReceipt?, crop?, season?, seasonYear?, dueOn?, village? }` and, on each line, `crop?` and `posReceipt?`. A line's own crop or receipt comes first, then the bill's. Each fertiliser, seed, pesticide and bio-input line is checked, in this order: 409 an item made of a banned molecule; 409 no licence in force covering it at the selling location today (fertiliser, seed or insecticide; while module `licences` is on), with a sentence naming the licence and what is wrong with it; 409 a seed lot past its validity, or another batch past its expiry; 400 a crop-restricted molecule with no crop given; 409 a crop it must not be used on; 400 a subsidised fertiliser without its PoS receipt number (letters, digits, - and /, 3-40). Also 400: a crop or receipt on a line that is not a farm input, a receipt on a fertiliser that is not subsidised or on a bill with none, a village on a named customer's bill or on a bill with no farm inputs. The season (`kharif`, `rabi`, `zaid`), its year (last year, this year or next) and the harvest due date (today up to 400 days ahead) go together, on a named customer's bill that leaves something on credit (400 otherwise); the due date becomes the bill's `due_on`. A walk-in's `buyer.name` and the bill's `village` are kept with the bill. The database repeats the checks where the line is kept. Audited `sale.farm_inputs`; a subsidised fertiliser sold writes event `agri.subsidised_sale` `{ documentNo, locationId, lines[{ lineId, skuId, quantity, posReceipt }] }`.
- `POST /documents`, a purchase: a seed lot needs its validity date as `expiresOn` (400).
- `GET /documents/:id` of a farm-input shop's sale: `agri: { lines[{ line_id, input_kind, subsidised, pos_receipt, crop }], bill: { season, season_year, buyer_name, village } | null, farmer: { village, relative_name, farmer_id } | null, licences[{ kind, name, licence_no, covers }] }` (the selling location's licences in force that day for what is on the bill), or null.

## Optical shops

All under `/api/businesses/:businessId/` with the Business Admin checks (membership, module `optical`, permission). The lists take `limit` (up to 100), `offset`, `q` and their filters (prescriptions and orders also `from` and `to`, on when they were made) and answer `{ total, items }`. Backend module `modules/business/optical/` (routes `businessOptical.routes.js`). Every route answers 403 while the module is off, and so for every other type of business, which never has it; the settings and the power grid, which take a settings or catalogue permission, answer 404 for another type. Dates are the business's own (its time zone). A person tied to one location sees and changes that location's spectacle orders only (403 for another). An order's money (prices, totals, the advance, the bill, the balance) is sent only to a role with `sales.view`: for anyone else it is null, and an order says `money: false`. How it works: [BUSINESS_PLATFORM_DATA_MODEL.md › Optical shops](BUSINESS_PLATFORM_DATA_MODEL.md#optical-shops).

**Prescriptions**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /optical/prescriptions` | optical.view | Prescriptions, newest test first, with `customer_name`, `customer_phone`, `rows[{ eye, zone, sph, cyl, axis, add, prism, prism_base, acuity }]` (right eye first; distance, intermediate, near), `orders` (how many spectacle orders use it), `latest` (the customer's newest) and `lapsed` (past `valid_until`); search customer, phone, examiner, registration number, notes; filters `contact`, `examiner` (staff, outside), `latest`, `lapsed` |
| `POST /optical/prescriptions` | optical.create | `{ requestKey, contactId (a customer), examinedOn? (today unless given; never a day still to come), examinerKind? (staff, the default, or outside), examinerUserId? (a member; the person recording unless given) \| examinerName (outside), registrationNo? (required for outside), rows (1-6): [{ eye (right, left), zone (distance, near, intermediate), sph? (plano for 0.00), cyl?, axis?, add?, prism?, prismBase? (in, out, up, down), acuity? }], pdBinocular? (40-85 mm) \| pdRight + pdLeft (20-45 mm each), notes?, validUntil? (a year after the test unless given; at most five years) }` → 201 the prescription as `GET` gives it. Powers go in steps of 0.25: SPH and CYL from -30 to +30, ADD from +0.25 to +4.00 on the near or intermediate row only, AXIS 1-180 with a CYL other than 0 and only then, a prism up to 20 with its base. A row left empty is skipped; each eye and vision is given once. 400 with a sentence naming the eye, the vision and the field; 404 not a customer, or an examiner who is not a member. Same key and body → the same prescription; same key, other body → 409. Audited `prescription.recorded` |
| `GET /optical/prescriptions/:id` | optical.view | The prescription with `rows`, `customer_name`, `customer_phone`, `created_by_name`, `updated_by_name`, `lapsed`, `orders[{ id, order_no, status, created_at }]` and `locked` (a spectacle order uses it) |
| `PUT /optical/prescriptions/:id` | optical.create | A correction: the body of `POST` without `requestKey` (`contactId` left out keeps the customer); the rows are replaced. 409 once a spectacle order uses it (the sentence names the order: record a new prescription instead). Audited `prescription.corrected`, with what changed from and to |
| `GET /optical/customers/:contactId` | optical.view | `{ customer, prescriptions[] (newest first, with rows, lapsed and orders), orders[{ id, order_no, status, prescription_id, promised_on, created_at, delivered_at, remake_of, total }], recall: { months, due_on, reminded_at } }`: a customer's history, for the powers side by side. 404 not a customer |
| `GET /optical/examiners` | optical.view | `{ staff[{ id, name, registration_no }], outside[{ name, registration_no }] }`: the members whose role records prescriptions (with the registration number on their latest one), and up to 50 outside prescribers named before |

**Spectacle orders**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /optical/orders` · `GET /optical/orders/open` | optical.view | Every order, newest first · the open ones, by promised day. Rows: `order_no`, `location_id`, `location_name`, `contact_id`, `customer_name`, `customer_phone`, `prescription_id`, `made_at`, `lab_name`, `lab_order_no`, `promised_on`, `status`, `stage` (open, closed), `frame`, `lenses` (their types), `remake_of`, `remake_of_no`, `remake_reason`, `remake_cost_by`, `total`, `advance`, `advance_left`, `balance` (an open order's total less the advance), `document_id`, `document_no`, `due_today`, `overdue`, `ready`, `advance_to_refund` (cancelled, with advance left), `status_since`, `checked_at`, `delivered_at`; search number, customer, phone, lab, lab order number, frame, bill number; filters `status`, `stage`, `location`, `contact`, `due_today`, `overdue`, `ready`, `made_at`, `prescription`, `advance_to_refund` |
| `GET /optical/orders/counts` | optical.view | `{ open, booked, at_lab, in_workshop, quality_check, ready, due_today, overdue }`, at the person's location when they are tied to one: the screen's chips. Due today and overdue count the orders not yet ready |
| `POST /optical/orders/preview` | optical.create | The body of `POST /optical/orders` (only `locationId`, `prescriptionId`, `frame`, `lenses`, `items`, `discount` and `remake` are read) → what the item lines come to now, nothing saved: `{ taxMode, lines[{ part, eye, skuId, label, unit, quantity, unitPrice, amount, discount, net, tax, taxRate, offers[], … }], subtotal, tax, roundOff, total, savings }`, priced as `POST /quotations/preview` prices them; all 0 for a remake the shop or the lab bears |
| `POST /optical/orders` | optical.create and sales.create (sales.edit to take an advance) | `{ requestKey, locationId, prescriptionId (its customer is the order's), frame: { skuId (goods, not a kit), description? } \| { ownFrame: true, description }, lenses (1-2): [{ eye, lensType (single_vision, bifocal, progressive), skuId? (the lens item it is billed as), index? (1.40-2.00), material? (cr39, polycarbonate, trivex, glass, other), coatings? (anti_reflective, blue_cut, uv, photochromic, scratch_resistant), tint?, brand?, description? }], items? (up to 20): [{ skuId, quantity?, unit? }], measurements: { pdRight?, pdLeft? (20-45 mm), fittingHeightRight?, fittingHeightLeft? (5-45 mm) }, madeAt (in_house, lab), labName? (required at a lab), labOrderNo?, promisedOn (today up to a year ahead), discount?: { amount \| percent, reason }, notes?, advance?: { amount, method (cash, card, upi, bank) \| methodId, reference? }, remake?: { orderId (a delivered order of the same customer), reason (power_change, non_adaptation, measurement, lab_defect, breakage, coating, other), costBy (shop, lab, customer), note? } }` → 201 the order as `GET` gives it, numbered `SPO/…` at the location. The prescription and its powers are copied onto the order. Each lens needs its eye's powers on the prescription and its fitting PD; a bifocal or progressive lens also its near power and fitting height. The item lines (frame, right lens, left lens, other items) are priced by the core as a sale of them would be now, and kept. The advance (at most the total) is a numbered collection receipt for the customer, in the same transaction. A remake the shop or the lab bears comes to 0 and takes no discount or advance. 400 nothing to price (no item on the order, other than such a remake); 404 a location, prescription, item or order to remake not found; 409 the prescription's customer switched off, or the order to remake not delivered or another customer's. Same key and body → the same order; same key, other body → 409. Audited `spectacle_order.booked` (and `collection.recorded` for the advance); events `spectacle_order.booked` and `collection.recorded` |
| `GET /optical/orders/:id` | optical.view | The order with `rx` (the prescription as booked), `lines[]` (each with `sku_code`, `tracking`, `in_stock` (usable stock at the order's location, for goods), `tax_rate_now`, `mrp_now` and `sku_active`), `events[{ from_status, to_status, note, by_name, created_at }]`, `advance` (`{ collection_no, amount, method, used, refunded, free, refunds[] }`, or null), `remakes[]`, `bill` (what an open order's bill comes to if delivered now, with each item's GST rate today: `{ subtotal, tax, round_off, total, advance, due, rate_changed }`; null when nothing is billed), `seller` (as a bill prints it), `next` (the usual next statuses), `status_since`, `overdue`, `location_name`, `document_no`, `bill_total`, `remake_of_no`, and who booked, checked, delivered or cancelled it. 403 another location's, for a person tied to one |
| `PATCH /optical/orders/:id` | optical.edit | `{ promisedOn?, notes?, measurements?, madeAt?, labName?, labOrderNo? }` on an open order; what is left out stays. The lenses are checked against the fitting again. 400 a promised day gone by (other than the one it has) or over a year ahead; 409 a delivered or cancelled order. Audited `spectacle_order.updated`, from and to, and noted in the history |
| `POST /optical/orders/:id/status` | optical.edit, or optical.approve at the quality check | `{ status (at_lab, in_workshop, quality_check, ready), note?, labName?, labOrderNo? }`: booked → at_lab or in_workshop; at_lab and in_workshop to each other or to quality_check; quality_check → ready (passed) or back to at_lab or in_workshop (failed: `note` says what failed); ready → back to at_lab or in_workshop (`note` says why). Passing or failing the quality check needs `optical.approve`; every other step needs `optical.edit`. `at_lab` takes the lab's name (the order's unless given) and its order number, and the order is then made at that lab. 409 a step not allowed from the status (the sentence names both), or a closed order. Audited and evented `spectacle_order.status_changed` (with `qualityCheck` passed or failed) |
| `POST /optical/orders/:id/deliver` | optical.edit, with sales.create when something is billed (sales.edit to take a payment) | `{ requestKey, payment? \| payments? (as on documents; `amount: "full"` is what is left after the advance), lines?: [{ lineId, lots: [{ lotCode, quantity }] }], buyer?: { pan?, panDeclaration? }, note? }`, only from ready → the delivered order. The item lines become a sale posted by the core at the booked prices (`fixed`), with GST at each item's rate today (a price including GST keeps its total; one before GST keeps its taxable value), from stock at the order's location (oldest expiry first unless lots are named). The advance pays first (a payment from its receipt); what is not paid now is left on the customer's dues. An order with no item lines is delivered without a bill. 400 more paid than is left after the advance, a payment on an order with nothing billed, or a bill over ₹2,00,000 without the buyer's PAN or declaration; 404 a line that is not an item of the order; 409 not ready, an item switched off or kept for use in services, its pack size changed, its price above its MRP now, stock short, the credit limit or the cash limit passed, or the bill not coming to the figure worked out. Same key and body → the same delivery; same key, other body → 409. Audited and evented `spectacle_order.delivered`; the core's `sale.posted` and `payment.recorded` |
| `POST /optical/orders/:id/cancel` | optical.cancel | `{ reason }` on an open order. The advance stays the customer's: handed back from the order, or used on a later bill. Asking again returns the cancelled order; 409 a delivered one. Audited and evented `spectacle_order.cancelled` |
| `POST /optical/orders/:id/advance-refund` | sales.edit, and a manager's PIN for sales.refund | `{ requestKey, amount? (all that is left), method (cash, upi, bank) \| methodId, reference?, reason, approverId?, pin? }` → 201 the refund (`refund_no` `<receipt no>-R<n>`, `left`, `order_no`, `repeated`), with `source` optical; noted in the order's history. 409 an open order (the advance comes off the bill at delivery), an order with no advance, or more than is left of it. Same key and body → the same refund; same key, other body → 409. Audited and evented `collection.refunded` |
| `POST /optical/orders/:id/messages` | optical.view | `{ channel? (whatsapp, the default, call, sms), stage? (booked, ready, delayed, reminder, update), note? }` → 201 `{ logged, note }`: a message or call to the customer, kept in the order's history; the message itself goes from the person's own WhatsApp. Audited `spectacle_order.customer_told` |

**The recall list**

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /optical/recall` | optical.view | Customers due for an eye test: each active customer whose latest test plus the recall months is today or earlier, longest due first. Rows: `contact_id`, `name`, `phone`, `prescription_id`, `examined_on`, `valid_until`, `examiner_name`, `months`, `due_on`, `days_overdue`, `prescriptions` (how many), `reminders` (how many), `reminded_at` (the last), `reminded_recently` (within 30 days), `last_order_no`; search name, phone, examiner, last order; filters `reminded` (recently), `contact` |
| `POST /optical/recall/:contactId/reminders` | optical.view | `{ channel? (whatsapp, the default, call, sms) }` → 201 the reminder given (the message goes from the person's own WhatsApp, a `wa.me` link). 404 not a customer; 409 a customer with no eye test here. Audited `recall.reminded` |
| `GET /optical/settings` | optical.view | `{ recall_months (12 until saved), updated_at, updated_by_name }` |
| `PUT /optical/settings` | settings.edit | `{ recallMonths (1-60 whole months) }` → the settings. Audited `optical_settings.updated`, from and to |

**Contact lenses** (Variants switched on; 403 otherwise)

| Method and path | Permission | What it does |
| --- | --- | --- |
| `POST /optical/power-grid` | catalog.create | `{ productId? (more powers for a lens product made this way) \| name, brand?, categoryId?, unit (a counted unit: box, the default, pack, each), tracking? (quantity, batch), price, taxRateId? \| taxRate, mrp?, hsnCode?, reorderLevel?, codePrefix?, baseCurve (7-10 mm), diameter (12-16 mm), ranges (1-4): [{ from, to (-20.00 to +20.00), step? (0.25, the default, or 0.50) }] }` → 201 `{ product, created, items[{ id, code, label, power }] }`: one item of the product for each power (at most 200 at a time and 300 a product), at one price, its code the prefix and the power (`AO6-M250`, `AO6-P125`, `AO6-000`), its label the name and the power (`Acuvue Oasys · -2.50`), and `power`, `baseCurve` and `diameter` in its `attributes`. For a product made before, the powers it has are left as they are and the new ones take its unit, GST, HSN code, MRP and price (unless a price is given). 409 the code prefix already used, every power already there, or another base curve or diameter (another product). Audited `catalog.lens_powers_created` |
| `GET /optical/power-grid/:productId` | catalog.view | `?locationId?` → `{ product, base_curve, diameter, powers[{ sku_id, code, label, power, price, active, stock }] }`, lowest power first; the stock at the location, or at every location |

**On the core routes**

- `GET /notifications` (the bell), for a role with `optical.view`: each spectacle order ready to collect (info) and each open order past its promised day (warning), linking to the order.
- `POST /catalog` takes `power`, `baseCurve` and `diameter` in `attributes` while the module is on; the power grid writes them.
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
