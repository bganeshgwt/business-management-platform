# Going live

For whoever installs the platform for a real business, and for the owner who
signs it off: the server and its settings, serving the two web apps, backups,
setting up the customer's business, and the checks before real trading.

Work through it in order:

1. [Install on a server](#1-install-on-a-server)
2. [Production settings](#2-production-settings)
3. [Serve the two web apps](#3-serve-the-two-web-apps)
4. [First login and the customer's business](#4-first-login-and-the-customers-business)
5. [Backups and restore](#5-backups-and-restore)
6. [Equipment acceptance](#6-equipment-acceptance)
7. [Staff pilot and sign-off](#7-staff-pilot-and-sign-off)

Some work in the code also comes before the first real customer:
[BACKLOG › Needed in the code before go-live](BACKLOG.md#8-needed-in-the-code-before-go-live)
lists it.

## 1. Install on a server

Follow [README › Set up from an empty database](../README.md#set-up-from-an-empty-database),
with these differences.

- **The server** runs PostgreSQL and Node.js at the versions
  [README › Technology](../README.md#technology) names, with `pg_dump` and
  `pg_restore` for the backups (§5).
- **Install the locked versions.** Run `npm ci` in `backend` and at the project
  root. Each has a lockfile, so the server gets exactly the tested versions.
- **The database:** create it with the name you put in `DB_NAME`. Its
  `DB_USER` must be allowed to create tables in it, because
  `npm run migrate:up` builds every table.
- **`backend/.env`** takes the production values in §2. It holds secrets: keep
  it on the server, never in git.
- **Start the API with `npm start`** in `backend`. `npm run dev` is for
  development: it restarts on every file change. Run the API under the server's
  service manager, so it starts again after a crash or a reboot.
- **Run one API process.** The dashboard and the bell keep short-lived answers
  in the process's memory. A change the live screens hear of (an order, a
  bill, a booking …) clears them in every process, but any other write (an
  expense, a purchase, stock) only in the process that made it. With several
  processes, a screen can then show a figure from before such a change made
  through another process until that answer runs out (at most a few minutes).
  Live updates themselves work with several processes: each listens for every
  change.
- **HTTPS** sits in front of the API and both web apps, usually in the hosting
  proxy. Set `TRUST_PROXY` to match (§2), and set the proxy up for live
  updates (below).
- **Build the web apps** with their production addresses, and serve the builds
  (§3).

**Updating to a new version:**

1. Take a verified backup (§5).
2. Get the new code, then run `npm ci` in `backend` and at the root.
3. In `backend`, run `npm run migrate:up`. The API refuses to start while a
   migration is pending, and names the first one.
4. Build the web apps again (`npm run build` at the root) and put the new
   builds in place.
5. Restart the API.

### Live updates through the proxy

Every open staff screen holds one connection open to the API for its live
updates ([ARCHITECTURE › Live updates](ARCHITECTURE.md#35-live-updates)):
`GET /api/live` and `GET /api/businesses/<id>/live`, a stream of server-sent
events that lasts as long as the screen is open. The proxy (or load balancer)
in front of the API must pass it on as it comes:

- **Buffering off** for those two paths. The API already says so to nginx
  (`X-Accel-Buffering: no`) and to every proxy (`Cache-Control: no-cache,
  no-transform`); a proxy that ignores both needs it set by hand. No
  compression on them either.
- **Timeouts longer than the keep-alive.** A stream is never silent for more
  than 25 seconds (a comment line keeps it open), so an idle or read timeout
  of 60 seconds or more is enough; 120 seconds leaves room. A proxy that ends
  every request after a fixed time cuts the streams off: the screens reconnect
  by themselves and read again, but only an idle timeout is right here.
- **HTTP/2 to the browsers.** Over HTTP/1.1 a browser opens at most six
  connections to one address, and each open staff tab holds one for its
  stream; seven tabs on one computer would leave nothing for the rest. Every
  HTTPS proxy serves HTTP/2 when it is switched on; the API behind it may stay
  on HTTP/1.1.

With nginx, for example:

```
location ~ ^/api/(live|businesses/[0-9]+/live)$ {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 120s;
}
```

To check it after go-live: open the kitchen display and the POS on two
devices; the kitchen display says **Live**, and a KOT placed at the POS shows
on it within a second or two. A screen that stays on **Connecting** or
**Reconnecting** has a proxy holding its stream back; most screens still read
on their own every minute meanwhile.

**Connection counts.**

- **Browsers to the proxy and the API:** one open connection per open staff
  tab (its page and its bell share it). The proxy's connection limit (nginx's `worker_connections`)
  and the server's open-file limit must allow for every tab open at the busiest
  hour, plus the ordinary requests. Each API process holds at most
  `LIVE_STREAMS_MAX` streams (2,000 unless set) and one login at most
  `LIVE_STREAMS_PER_PERSON` in it (20 unless set: one kitchen login on several
  screens); a screen refused tries again a minute later.
- **API processes to PostgreSQL:** each process holds one connection of its
  own for live updates (`application_name` "live updates"), besides its pool
  (`DB_POOL_MAX`, 10 unless set): processes × (pool + 1), plus the tools and
  backups, must stay under PostgreSQL's `max_connections` (100 by default).
- **Several processes behind a load balancer** need no sticky sessions for live
  updates: each process listens for every change and passes it to its own
  streams. On a stop (SIGTERM) a process tells its streams it is restarting,
  and the screens reconnect within a few seconds, to whichever process the
  load balancer picks.

### A shop's CSV import through the proxy

A shop's import of products, customers or suppliers from a CSV file
([ADMIN_GUIDE › Products, customers and suppliers from a CSV
file](ADMIN_GUIDE.md#products-customers-and-suppliers-from-a-csv-file)) sends
a whole file's rows in one request, `POST /api/businesses/<id>/catalog/import`
or `…/contacts/import`: up to 5,000 rows, a few megabytes. The API takes up to
5 MB there (1 MB everywhere else), and a file of thousands of products with
their opening stock takes a minute or two to go in. The proxy in front of the
API must let both through on those two paths:

- **A body of 5 MB.** nginx takes 1 MB unless told (`client_max_body_size`);
  a larger file is then refused by the proxy before the API sees it.
- **A read timeout of a few minutes.** nginx waits 60 seconds by default
  (`proxy_read_timeout`). A request the proxy cuts off still finishes on the
  server; the screen says the import failed, and pressing *Import* again
  answers the import that went in (the same request key), so nothing is
  imported twice.

With nginx, for example:

```
location ~ ^/api/businesses/[0-9]+/(catalog|contacts)/import$ {
    proxy_pass http://127.0.0.1:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 5m;
    proxy_read_timeout 300s;
}
```

## 2. Production settings

[`backend/.env.example`](../backend/.env.example) explains every setting. These
need a production value:

| Setting | Production value |
| --- | --- |
| `NODE_ENV` | `production`. Any value other than `development`, `dev`, `test` or `local` marks a live server, and a live server refuses to start with a weak or example `JWT_SECRET`. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | The production database. The API stops at start when one is missing. |
| `JWT_SECRET` | A fresh random value of at least 32 characters, used nowhere else: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Anyone who knows it can sign in as any user. |
| `TWO_FACTOR_KEY` | A fresh random value made the same way, set once (see below). |
| `CORS_ORIGIN` | The staff app's address, such as `https://app.example.com`; separate several with commas. Left out, only `http://localhost:5173` may call the API. The guests' site needs no entry. |
| `GUEST_WEB_URL` | The guests' site's own address, the same one the staff app is built with in `VITE_CUSTOMER_WEB_URL` (§3), such as `https://order.example.com`; with one address for both apps, that address. Every link the API builds to a guest's page (a table booking's) starts there unless the restaurant has set a guest web address of its own. A live server refuses to start without it, or with one that is not https, or one guests' phones cannot reach (`localhost`, a local network). |
| `TRUST_PROXY` | How many proxies or load balancers stand in front of the API, usually `1`. The sign-in limits then count each client's own address; at `0` behind a proxy, every client shares one limit. |
| `PORT` | The port the proxy forwards to (5000 when left out). |
| `UPLOADS_DIR`, `PRIVATE_UPLOADS_DIR` | The two upload folders, on storage that survives a redeploy (a disk or volume outside the code's folder). `UPLOADS_DIR` holds the public pictures, served at `/uploads`; `PRIVATE_UPLOADS_DIR` the files only ever sent through the API. Left empty, they are `backend/uploads` and `backend/private_uploads`; a relative path is taken from `backend/`. Both are user data (§5). |
| `DB_POOL_GUARD` | Empty, the default. `warn` and `throw` are checks for development and test runs. |

The other settings are optional, and each falls back to the default
`.env.example` shows: `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS`,
`DB_IDLE_TIMEOUT_MS`, `JWT_EXPIRES_IN`, `LOGIN_ATTEMPT_LIMIT`,
`ACCOUNT_LOCK_ATTEMPTS`, `ACCOUNT_LOCK_WINDOW_MINUTES`, `ACCOUNT_LOCK_MINUTES`,
`APPROVAL_TTL_SECONDS`, `NOTIFICATIONS_CACHE`, and `LIVE_STREAMS_MAX` and
`LIVE_STREAMS_PER_PERSON` (the live screens' streams, §1). Every API process
and tool shares PostgreSQL's own connection limit, so raise `DB_POOL_MAX` with
care: each API process also holds one connection for live updates.

**Set `TWO_FACTOR_KEY` once and never change it.** It encrypts the
authenticator-app secrets of two-step sign-in. Left empty, it is derived from
`JWT_SECRET`. Changing the key, or changing `JWT_SECRET` while the key is
empty, stops every authenticator app: people then sign in with a recovery code
and set two-step sign-in up again. So:

- When you move a database that has two-step sign-in in use, take its
  `TWO_FACTOR_KEY` with it, or the `JWT_SECRET` it falls back to.
- Before you change `JWT_SECRET` on a server whose `TWO_FACTOR_KEY` is empty,
  set `TWO_FACTOR_KEY` to the current `JWT_SECRET`.

**The web apps' settings** are read when the apps are built, not when they run:
`VITE_API_BASE_URL` (both apps) and `VITE_CUSTOMER_WEB_URL` (the staff app). A
change needs a new build (§3). Everything in a web build is public, so never
put a secret in a `VITE_` setting.

## 3. Serve the two web apps

`npm run build` at the root writes `apps/business-web/dist` and
`apps/customer-web/dist`. Both are static files that any web server can serve.
Everything of the guests' site except its `index.html` sits under
`guest-assets/`, so the two builds never collide. The files under `assets/` and
`guest-assets/` have content-hashed names and can be cached for a long time;
`index.html` should not be, so that a new build reaches people.

What each build needs (the build stops with a sentence when one is missing):

- **Both apps:** `VITE_API_BASE_URL`, the API's address ending in `/api`. The
  apps find uploaded images by replacing that last `/api` with `/uploads`, so
  the API's address must answer both paths. The API serves both itself.
- **The staff app:** `VITE_CUSTOMER_WEB_URL`, the guests' site's address, or
  `same-origin`.

Outside development these must be addresses phones can reach, never
`localhost`. Both apps are single-page apps, so the web server answers any path
that is not a file with the app's `index.html`: a printed QR code opens a path
such as `/order/<token>` directly.

There are two ways to serve the apps.

**Two addresses (recommended).** For example `app.example.com` for staff and
`order.example.com` for guests.

- Build the staff app with `VITE_CUSTOMER_WEB_URL=https://order.example.com`,
  and list the staff address in the API's `CORS_ORIGIN`.
- The guests' pages then never share the browser storage that holds a staff
  login.
- On the staff address, answer `^/(order|online|book)(/|$)` with a permanent
  redirect (301) to the same path on the guests' address. QR codes and shared
  links that point at the staff address then skip the staff app.
- The staff app's own redirect (`GuestSiteRedirect`) is the fallback. It also
  clears any guest data (carts, a guest's name and phone, tracked orders and
  bookings) left in that browser under the staff address. A server redirect
  skips that clean-up; keep the app's redirect alone if that matters.

**One address.**

- Send `^/(order|online|book|shop|appointments|account)(/|$)` to the guests'
  `index.html`, and `^/guest-assets/` to its files.
- Send `/api/` and `/uploads/` to the API, and everything else to the staff
  build.
- Build the staff app with `VITE_CUSTOMER_WEB_URL=same-origin`. Both apps can
  then use `VITE_API_BASE_URL=/api`.
- Mind the slash: `/orders` is a staff screen.
- Both apps share one browser storage.
- If the server does not send the guest paths to the guests' site, the staff
  app answers them with "This guest page is not set up yet".

**Keep these redirects for good.** Printed QR codes do not change, so settle
the guests' address before any QR code is printed.

A restaurant that sets its own guest web address (Service settings) has its
QR codes and guest links point there instead. The links the API builds itself
follow the same rule, from the API's `GUEST_WEB_URL` (§2). The API answers the public guest
calls (`/api/public/…`) from any address, so such a domain needs no
`CORS_ORIGIN` change.

## 4. First login and the customer's business

1. In `backend`, run `npm run user:create` and leave the restaurant code empty.
   That makes the platform Super Admin
   ([README › The first login](../README.md#3-the-first-login)). This login runs
   the whole platform: give it a strong password and keep it to the people who
   run the platform.
2. Sign in to the staff app with it, and choose its own password when the
   sign-in asks: the one typed in the terminal works once. Create the
   customer's restaurant in **Platform › Restaurants**, or a business of
   another type in **Platform › Businesses**, each with its owner's login.
3. The owner signs in, chooses their own password, and works through
   [ADMIN_GUIDE › First steps in a new business](ADMIN_GUIDE.md#first-steps-in-a-new-business).
4. Before real trading, two reviews:
   - **The accountant** confirms the tax settings and, in a restaurant, the GST
     filing export and the day book for Tally. In the other types, Reports is
     an operational register, not a GST filing pack. For an owner with several
     businesses, the accountant also checks *GST thresholds*: each business's
     GSTIN or recorded PAN, the figures with their sources, and the reading of
     aggregate turnover they are measured on
     ([BACKLOG §10](BACKLOG.md#10-new-business-types)). Above ₹5 crore,
     e-invoices are made outside the platform.
   - **A pharmacy or a clinic:** the owner reviews its rules with a pharmacist,
     a doctor and a legal adviser. The rules follow standard Indian practice;
     [BUSINESS_RULES › Pharmacy, clinic and lab](BUSINESS_RULES.md#pharmacy-clinic-and-lab)
     gives each rule, its legal source and where it is changed.
5. Personal data, below.

### Personal data

Under the DPDP Act 2023 the business is the data fiduciary for the people it
serves, and the platform, which holds their data for it, is likely its
processor. The data fiduciary duties of the DPDP Rules 2025 apply from
13 May 2027. Before the first real customer:

- **The processor terms, as a contract.** The platform and each business agree
  in writing on what the platform does with the business's customers' personal
  data: it processes it only to run the business's screens, and keeps it safe
  (contracts with data processors must include security safeguards where
  applicable). This is a contract between the two, drafted by a legal adviser,
  not code.
- **The privacy notice and its contact.** The owner checks the starter text in
  **Settings › Personal data**, changes what does not fit the business, names
  the privacy contact and publishes it: consent is taken on it, and every bill
  and receipt prints the contact
  ([ADMIN_GUIDE › Personal data](ADMIN_GUIDE.md#personal-data)). A restaurant
  does the same in its own **Settings › Personal data**.
- **A legal adviser's review** of the notice, the list of what an erasure keeps
  and why, and the notice to the people a breach affects
  ([BACKLOG §10](BACKLOG.md#10-new-business-types)).

## 5. Backups and restore

**Back up:** in `backend`, run `npm run db:backup -- --verify`. It writes a
folder `backend/.local/backups/<time>-<id>/` that holds:

- `database.dump`, the database in pg_dump's custom format;
- a copy of the two upload folders, wherever `UPLOADS_DIR` and
  `PRIVATE_UPLOADS_DIR` put them: `uploads/` (photos of the menu's dishes)
  and `private_uploads/` (bills attached to expenses and purchase bills,
  prescription scans, task files, licences' scanned copies, a jeweller's,
  a hire's and a garage's photos and signatures);
- `manifest.json`: the database, the time, what was copied, and whether the
  restore was checked.

`--verify` restores the dump into a scratch `rmp_restore_…` database, counts
the rows of a few tables and drops it; the manifest then says
`"restoreVerified": true`. This needs a PostgreSQL user allowed to create
databases. Set `PG_BIN` to the folder that holds `pg_dump` and `pg_restore`
when they are not on the PATH; on Windows the script also looks under
`Program Files\PostgreSQL`. The script stops `pg_dump` or `pg_restore` after
five minutes and reports a failure.

**Restore** into a new, empty database (add `--host`, `--port` and
`--username` as your server needs):

```
createdb <new_db>
pg_restore --no-owner --no-privileges --exit-on-error --dbname <new_db> <folder>/database.dump
```

Then copy `<folder>/uploads` into the folder `UPLOADS_DIR` names and
`<folder>/private_uploads` into the one `PRIVATE_UPLOADS_DIR` names
(`backend/uploads` and `backend/private_uploads` when they are empty), point
`DB_NAME` at the new database, run `npm run migrate:up` (it applies only the
files newer than the backup), and restart the API.

**The upload folders are user data.** The folders `UPLOADS_DIR` and
`PRIVATE_UPLOADS_DIR` name hold what people uploaded. Keep them on storage
that survives a redeploy, and move them with the database, never with the
code: a restore without them loses every attached bill.

**Cautions:**

- A backup stays on the machine that made it, so it does not survive a lost
  disk. Copy each one off the server, and from time to time restore a copy to
  prove it works.
- The script takes one backup and stops. Schedule it with the server's task
  scheduler.
- Take a verified backup before every update that runs migrations.
- The backup does not hold `backend/.env`. Keep its `TWO_FACTOR_KEY` (or the
  `JWT_SECRET` it falls back to) safe elsewhere: a restore on a new server needs
  it for two-step sign-in to keep working (§2).
- If a `--verify` run is stopped half-way, a scratch `rmp_restore_…` database
  can be left behind. Check that a database is one of these before you drop
  it.

**Before go-live: the migration baseline.** Once no more schema changes are
expected, the migration files are folded into one baseline, so a fresh
install runs one file. An existing database records the baseline as applied,
by hand, once, after a backup.
[ARCHITECTURE §9.3, plan F](ARCHITECTURE.md#93-plans-d-e-and-f) gives the
steps and the test.

## 6. Equipment acceptance

Record the printer's make and model, its driver, the paper width, the
connection and the cash drawer's model.

The app prints through the browser's print dialog, at 58 mm, 80 mm or A4. It
has no silent ESC/POS printing and no cash-drawer pulse
([BACKLOG › Hardware](BACKLOG.md#2-hardware)), and choosing a physical printer
in the dialog proves neither. Before a printer arrives, the browser tests print
sample receipts at 58 mm, 80 mm and A4 to PDF in Playwright's test output
folder (`test-results/` at the project root); see
[TESTING › Receipt printing checks](TESTING.md#receipt-printing-checks).

| Check | Pass criterion | Result |
| --- | --- | --- |
| 58 mm / 80 mm receipt | Names, amounts and footer fit; no clipping or blank first page | |
| Long receipt | 40 lines, long names, add-ons and a bill paid in two ways are legible | |
| Tax, discounts, rounding | The printed figures match the saved bill exactly | |
| Reprint | Same invoice number, marked DUPLICATE, the right print count | |
| Cancel the print dialog | The app stays usable; no extra payment is recorded | |
| Kitchen ticket | Right station, quantity, notes and cancellation details | |
| Disconnect and reconnect | Clear recovery for the operator; no lost or double bill | |
| Cash drawer | Opened by hand: the app sends no pulse | |
| Barcode scanner (shops) | A scan in Quick bill's scan box adds the item, as typing the code would | |
| Scale label (shops selling by weight) | Scanning the label bills the weight printed on it | |

Print the driver's test page first, then the app's receipt. Keep the paper
samples with the date of the test. A print that succeeds in the browser does
not prove the paper came out: the saved print count records an attempt, not a
printer's acknowledgement.

## 7. Staff pilot and sign-off

Train first on a separate database, or a separate restaurant or business, with
named staff logins and the real menu or products, opening stock and prices. A
training run does not count as a real-service sign-off. Take a verified backup
(§5) before the pilot.

### A restaurant

1. The owner checks the outlet, the menu, the recipes, the tax settings and the
   role permissions.
2. The manager opens the day with counted cash. A captain takes dine-in,
   takeaway and delivery orders, and dine-in also on the captain app on their
   phone; the kitchen acknowledges and completes them. Every live screen (the
   kitchen display, table requests, the POS, the captain app, deliveries, the
   dashboard) says **Live**, and an order placed at one till shows on the
   kitchen display and the other tills within a second or two. Switch a
   device's Wi-Fi off and on: it says **Reconnecting**, then **Live**, and shows
   what changed meanwhile.
3. Change quantities, add a second round, pay one bill in two ways, void an
   unpaid bill and refund a paid one. Check the approvals and the activity-log
   entries with a cashier and a manager. Where the restaurant takes banquets or
   parties, bill one over ₹2,00,000: check that it asks for the buyer's PAN,
   refuses cash at ₹2,00,000 and prints the PAN.
4. Receive a purchase with batch and expiry, transfer stock, count a shelf, and
   record expired goods as wastage. Check that the batches picked from the
   shelf match the app's first-expiry-first allocation.
5. Dispatch a delivery with a rider, and check that a delivery cannot leave
   before it is packed or without a rider. Check returned food and how an
   unpaid delivery is handled.
6. Record attendance, a bonus or an advance, and a payroll payment. Check that
   a paid period cannot be paid twice or changed silently.
7. Finish the shift: settle pending bills, compare the cash counted and every
   payment method's totals, reconcile stock, check the GST, P&L and day-book
   exports, and close the day.
8. Repeat for two busy shifts, with a second till, a lost connection and a
   restart.

### A shop

1. The owner checks the business settings, locations, payment methods, tax
   rates, products and prices, and the staff's roles. Where the products,
   customers and suppliers came from the shop's old system by **Import from a
   CSV file**, check that the stock's value and what customers and suppliers
   owe add up to the old system's figures for the same day.
2. Each cashier opens a shift at **Quick bill** with the cash in the drawer.
   Bill by barcode and by name, and by weight where the shop sells loose
   goods. Pay by cash (with change), UPI, card, and udhaar with part paid in
   cash. Check that a batch item takes the
   batch that expires first, and that the receipt prints the batch.
3. Take goods back from a bill (*Return*), and check the refund, the stock that
   comes back and, with loyalty on, the points.
4. Receive a purchase with batch and expiry, send a **Transfer** to another
   location and receive it there, and enter and approve a **Stock count**.
5. A pharmacy also makes a **Prescription sale** of a Schedule H1 medicine with
   the prescription and its scan, and checks the H1 register. An optical shop
   keeps each selling location's MD-42 registration under *Settings ›
   Licences* (a contact-lens bill is refused there without it), bills a box of
   contact lenses to a customer with a contact-lens prescription, and books a
   spectacle order with an advance, through the workshop's steps and the
   quality check to delivery.
6. Close: each cashier closes their shift with a blind count. The manager opens
   **Daily money**, makes the cash check (*Count cash*), compares the cash
   counted and every payment method's totals, and prints the end-of-day slip.
7. Repeat on two busy days, with a second till, a lost connection and a
   restart.
8. Personal data: at **Quick bill**, add a customer who agrees to reminders
   in one tap, and send them a reminder from **Udhaar**; ask a customer who
   has not agreed, and record their answer. In **Settings › Personal data**,
   log a request, save the person's data as a file, and answer it.

### A clinic

1. The owner checks the clinic and lab settings, each doctor's fees and OPD
   timings, each doctor's appointment calendar on their registration (so the
   clinic workspace shows them their own queue), the tests and their reference
   ranges, and the roles: Cashier (the front desk), Doctor, Lab technician and
   Pathologist.
2. The front desk opens the **clinic workspace** (`/clinic`) on the desk's
   computer, registers a patient with their consent and gives a token.
3. The doctor opens the clinic workspace on their tablet or computer, calls
   the patient with **Next patient**, starts the consultation, orders a test,
   completes the visit and prints the prescription. The front desk bills the
   visit, and the test on *Sales*. With the display board open on the waiting
   room's screen too, a token given or called at the desk shows there within a
   second or two.
4. The lab opens the **lab workspace** (`/lab`) and records the day's
   quality-control run first (*Quality control*): while a parameter's run has
   failed, its reports cannot be approved. Then the doctor's test is collected
   (with its labels) and received, and the results are entered from the
   *Worklist*; each step shows on the other screens within a second.
5. The pathologist approves the report with their PIN from *Approval*; it
   appears on the doctor's open consultation, and the front desk prints it
   from *Released*.
6. Check that the front desk never sees clinical notes or results in either
   workspace, and that each look at clinical data is in the activity log.

### Recording problems and signing off

Record each problem with the time, the role, the screen, the record number,
and the expected and actual result. Never record passwords or tokens.

Sign-off needs the owner and the leads of the counter and of the kitchen (or of
the front desk and the lab) to approve the reconciled results. Every lost
order, duplicate payment, wrong price, and stock or permission defect is
resolved first.
