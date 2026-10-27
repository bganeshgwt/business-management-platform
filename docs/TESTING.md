# Testing

For developers and testers: every test suite in the repository, how to run
it, what it needs and what it covers, and what to do when a run goes wrong.

The tests show that the software behaves as they expect in the cases they
try. They do not promise that every business process or accounting edge case is
covered. The receipt checks are not hardware tests, the load test does not
certify capacity, and passing tests do not certify tax filings: the
accountant's review, the equipment checks and a staff pilot in a real
business come first ([GO_LIVE.md](GO_LIVE.md)).

1. [Commands](#commands)
2. [Unit tests](#unit-tests)
3. [Backend integration tests](#backend-integration-tests)
4. [Browser tests](#browser-tests)
5. [Receipt printing checks](#receipt-printing-checks)
6. [Where an area's tests are](#where-an-areas-tests-are)
7. [Continuous integration](#continuous-integration)

## Commands

From the project root:

| Command | What it runs | What it needs |
| --- | --- | --- |
| `npm test` | The unit tests: the staff app's and `@bmp/shared`'s (`npm test --workspaces --if-present`; the guests' site and `@bmp/ui` have none), then the backend's | The installs |
| `npm run test:integration` | The backend's integration tests, `backend/tests/integration/*.test.js` | PostgreSQL, and a user there that may create databases |
| `npm run test:browser` | The browser tests of both web apps (`playwright test --config e2e/playwright.config.mjs`) | The same, three free ports and a browser |
| `npm run lint` | oxlint over `apps`, `packages`, `tools` and `e2e` (settings in `.oxlintrc.json`; the backend is not linted) | The installs |
| `npm run build` | The production builds of both web apps, which also catch a broken import | The apps' addresses, in `apps/*/.env` or the environment |

In `backend`, `npm test` runs the backend's unit tests alone, and
`npm run test:integration` the integration tests. "The installs" are
`npm install` at the root and in `backend`, as in
[README › Set up from an empty database](../README.md#set-up-from-an-empty-database).

Before merging a change, run `npm test`, `npm run test:integration`,
`npm run lint` and `npm run build`, and `npm run test:browser` when the change
touches screens. CI runs all of them but the browser tests
([Continuous integration](#continuous-integration)).

## Unit tests

`npm test` from the root. They need no database and no settings, and they
never touch a database. Where the code under test has the database behind it,
the test loads that code with whatever reaches the database stubbed, and
checks that the real `config/database` was never loaded (`brandReport.test.js`,
`businessDay.test.js`), or puts a stand-in pool in its place
(`queryAll.test.js`). A stub that missed would load the real pool, which
points at the database `backend/.env` names. A new unit test that needs a stub
works the same way.

| Folder | File | What it checks |
| --- | --- | --- |
| `backend/tests` | `businessDay.test.js` | Opening and closing a business day, at the controller: the closing cash must be a real amount (0 counts; blank, negative, text or too large is refused before anything closes), and a day opens only on a real calendar date |
| | `brandReport.test.js` | The brand report adds up exactly to the paisa, each brand's channels with the biggest seller first |
| | `migrationStatus.test.js` | The start-up check: the API refuses to start with a migration pending or none applied, names the command to run, and passes a connection failure on unchanged |
| | `queryAll.test.js` | `utils/queryAll` runs a transaction's queries one after another, and the pool's side by side |
| | `taxChangesMoney.test.js` | A GST rate change's arithmetic and dates, in whole paise: a price that includes GST keeping its part before GST at another rate (half a paisa up, as the database applies it), one unit's GST inside a price or on top of it, a price before GST never moving, and a change's first day later than the business's today and within two years (29 February two years on is the 28th) |
| | `taxChangeReaders.test.js` | Every file that reads an item's or a dish's GST rate is listed with how it gets the rate of the day: a new reader that is not listed fails it. Every Business Admin route opens the business through `context()` (which applies due changes), a posting applies them under its lock before it prices a line, an order before it prices a dish, and the menu screens and the guests' menus before they are read |
| `apps/business-web/tests` | `menu-paths.test.js` | Every menu path written in the code, in help texts, the server's messages and comments ("Settings → Business hours", "A › B"), leads to a place on the menus as they are drawn, the restaurant's and every kind of shop's; a list of retired menu names never comes back; a shop's Settings area keeps its name for everyone who may open a page in it |
| | `business-workspace.test.js` | Each business type's menu: no destination twice, at most 16 links, the related tools (units, labels, stock counts and movements, collections, roles) kept off the sidebar yet reachable from their area, no other trade's pages (a farm-input shop's *Farm inputs* area and its checks under Settings; Licences under the Settings of every type but the restaurant while the tool is on), and one Tasks entry only while tasks are on; a person with a narrow role still gets the pages they may open; the restaurant's tools stay reachable in a menu filtered by permissions |
| | `hardware-calculators.test.js` | A hardware shop's tile and paint calculators: boxes for an area with its wastage (sq ft or m², never a box too many for a hair of floating point), litres for the coats up to the next tenth, and the packs to buy (the least paint, then the fewest tins, bigger tins on a tie, from the usual 1, 4, 10 and 20 L or a paint's own sizes); figures read from the items; on only for a hardware shop with the calculators |
| | `live-client.test.js` | The staff app's live updates client (`services/liveClient.js`), on a clock of the test's own against a pretend server: reconnecting waits 1, 2, 4, 8, 16 and then 30 seconds, each give or take a quarter, and from 1 second again once a stream has stayed up for 30; the stream is read as it arrives, split anywhere, with any line ends, comments and several data lines; the token goes in the `Authorization` header, never the address; a burst of changes becomes one read, at most one a second and never two at once, and a screen hears only the areas it shows; every (re)connection and the server's resync lead to one read; a stream silent for 70 seconds is dropped and opened again; a refused or ended session stops after one last read, a refreshed token carries on; a stream ended for a change reopens at once, one for a restart after a moment, one refused for too many after a minute; screens share one stream, closed a moment after the last leaves, and signing out closes them all |
| | `captain-floor.test.js` | The captain app's floor (`workspaces/captain/captainFloor.js`): a captain's own tables come from the day's captain sections, and with none today every table shows; what waits at each table (open calls and QR orders, food at the pass, the kitchen's progress), a joined table's food shown once, at the party's own table; what each tile says, most urgent first (a call, the bill, a QR order, the food, late at the pass after the restaurant's minutes, then the kitchen and the guests); the *Calls* and *Ready* lists, the longest waiting first; only what arrives at the tables shown after the screen opened rings the phone. And a note typed on a dish just added goes to the kitchen with it, while a dish already sent keeps its own, and a held course stays a line of its own |
| | `clinic-lab-workspaces.test.js` | The clinic and lab workspaces' rules (`services/healthWorkspaces.js`, `workspaces/clinic/clinicDesk.js`, `workspaces/lab/labBench.js`): a workspace opens the only clinic, or the one chosen last, among those with its tool switched on; a clinic's and a lab's screens link inside the workspace and anything else to Business Admin; the desk puts the signed-in doctor's own queue first, counts who waits (all, and for that doctor), shows the tokens the patient at the desk holds, and reads a search as a mobile number or a name; the lab's bench lists the samples to collect (a rejected one again, with its reason) and to receive (never one sent to an outside lab), the worklist by test, the reports to approve and those released today, the latest first, and counts each |
| `packages/shared/tests` | `shared.test.js` | Every `@bmp/shared` module loads in Node by its package name, with no bundler; money and durations read as people write them |

## Backend integration tests

`npm run test:integration`, from the root or in `backend`, runs
`node --test tests/integration/*.test.js` in `backend`. Node runs the files
side by side, each in a process of its own and on a database of its own, so
they never meet.

### What they need

- **PostgreSQL**, reached with `DB_HOST`, `DB_PORT`, `DB_USER` and
  `DB_PASSWORD`. They come from `backend/.env`, or from the environment, which
  wins over the file. Only these four are needed: each test file sets its own
  database name and `JWT_SECRET`.
- **A user that may create databases** (`CREATEDB`). Each file connects to the
  server's `postgres` database to create its own database and to drop it. As
  a superuser: `ALTER ROLE <user> CREATEDB;`
- **`npm install` in `backend`.**
- **To run in `backend`.** Each file reads `.env` from the folder it runs in.
  The npm commands run there by themselves; run `node --test` there too.

### What a file does

1. It creates an empty database, `rmp_test_` and 20 random hex characters, on
   that server. The database `DB_NAME` names is never read, migrated or
   changed.
2. It runs every migration on it, the way `npm run migrate:up` does.
3. It starts the API inside the test process on a free port of 127.0.0.1,
   with `NODE_ENV=test`, and works through HTTP as the apps do. A few files
   call the services directly instead, and `server-start.test.js` starts
   `src/server.js` itself. Each test makes the data it needs. Its logins sign
   in through `helpers/signIn.js`, which chooses each one's own password at
   its first sign-in, as a person must after a password someone else set.
4. It drops its database at the end, passed or failed.

Two things work differently under `NODE_ENV=test`:

- **Uploaded files** go to a folder of the process's own in the system's temp
  folder (`rmp-test-uploads-<process id>-…`), removed when the process ends.
  An `UPLOADS_DIR` or `PRIVATE_UPLOADS_DIR` set only in `backend/.env` is
  ignored, so no test writes into `backend/uploads`, `backend/private_uploads`
  or the folders you set there. A folder left by a killed process is removed
  by the next test process.
- **The bell** keeps no answers between requests, so a test sees its own
  change at once. `NOTIFICATIONS_CACHE=on` keeps them, for the test of that
  cache.

### One file, or a few

In `backend`:

```bash
node --test tests/integration/business-retail.test.js
node --test tests/integration/business-retail.test.js tests/integration/business-wholesale.test.js
```

Each file is one test with its steps as subtests, so a failure names the file
and the step. To run fewer files at once, add `--test-concurrency=2` (or
another number) before the file names.

### Helpers for new tests

In `backend/tests/integration/helpers/`. The first two take
`request(method, route, body, expected)`, the test's own caller.

| File | What it gives |
| --- | --- |
| `businesses.js` | `createBusinesses(request, prefix, types)` makes businesses the way an owner adds one (*Add a business*, `POST /businesses`), so each starts with its roles, settings, GST slabs, units, its type's default modules, a first location and the owner's membership. It returns them as `GET /businesses` lists them, with their capabilities and the owner's role. Codes are `<PREFIX>-<TYPE>`, so each person in a test passes a prefix of their own. `ALL_TYPES` lists every type but the restaurant. |
| `tools.js` | `withTools(request, businesses, { work })` switches on each type's specialist tools (`PUT /businesses/:id/modules/:code`), as an owner does in *Settings › Business tools*: a new business starts without them. `work: true` adds tasks, issues and projects. |
| `signIn.js` | `signIn(base, identifier, password)` signs in as a login the test made and returns the session (or the two-step challenge), or `null` when the sign-in is refused. Every such login has a password someone else set, so its first sign-in chooses a password of its own, fresh and kept in the test's memory only, and goes on; signing in again with the password the test gave uses the login's own. `chooseOwnPassword(base, identifier, password, session)` does that step for a session the test finished itself (after two-step sign-in), and `passwordOf(base, identifier, password)` is the login's password now, for the routes that ask for it (a PIN, two-step set-up, a change). |
| `dates.js` | Dates on the business's clock (Asia/Kolkata unless another zone is given): `today`, `daysFrom`, `addDays`, `daysBetween`, `monthStart`, `weekdayOf`; `tradingToday`, the trading date as the server works it out, which runs to the 05:00 cut-off; `hourNow`; `momentAt`, a wall-clock time on a date as a moment; `zoneWithHour(from, to)`, a time zone whose clock reads such an hour, for a test that needs the business open, or in the small hours, whatever the time of the run. |

A date taken from the UTC clock, or from the database's own date, is a day
behind India's between midnight and 05:30 India time, and a test built on it
fails then. The tests take their dates on the business's clock, most of them
through `dates.js`, so the suite passes at any hour; a new test does the
same. The server must do the same: `restaurant-clock.test.js` runs its server
on UTC−12 against a restaurant on Kiritimati time (UTC+14), so a date the
server takes from its own clock fails that test at any hour.

### Settings for a run

| Setting | What it does |
| --- | --- |
| `DB_POOL_GUARD=warn` | Logs a `[db pool guard]` line for any code that asks the pool for a second connection while its transaction holds one, the pattern that can freeze the API. Run the whole suite with it and look for none. `floor-and-service.test.js` always runs with `warn` and fails on a line from its own code; `restaurant-money-paths.test.js` always runs with `throw`. |
| `RMP_LOAD_SECONDS` | The load test in `restaurant.test.js` ([Load test](#load-test)). |

In PowerShell, set one for a run and clear it after:

```powershell
$env:DB_POOL_GUARD = 'warn'
npm run test:integration
Remove-Item Env:DB_POOL_GUARD
```

In bash: `DB_POOL_GUARD=warn npm run test:integration`.

### Load test

`RMP_LOAD_SECONDS` (up to 300) adds a step to `restaurant.test.js`. For that
many seconds, four workers each place a takeaway order of one dish, bill it
and take cash for it, over and over; every twentieth flow also reads the
kitchen board. Then every bill number must be unique, no bill may be left
unpaid, and the day book must balance. The step prints one line,
`LOAD_RESULT {…}`, with the seconds, the flows completed, the distinct bills,
and the 95th-percentile and slowest time for one flow. More than 300 seconds
fails the run.

In `backend`:

```powershell
$env:RMP_LOAD_SECONDS = '120'
node --test tests/integration/restaurant.test.js
Remove-Item Env:RMP_LOAD_SECONDS
```

In bash: `RMP_LOAD_SECONDS=120 node --test tests/integration/restaurant.test.js`.

It measures one simple flow on one machine against a local PostgreSQL. It
says nothing about capacity in production, printing, Wi-Fi, a long shift or a
database that holds years of trading.

### When an integration run goes wrong

| What you see | What to do |
| --- | --- |
| `permission denied to create database` | Give the user `CREATEDB` ([What they need](#what-they-need)). |
| `password authentication failed`, `ECONNREFUSED`, or a setting said to be missing | Check `DB_HOST`, `DB_PORT`, `DB_USER` and `DB_PASSWORD` in `backend/.env`, and that the command runs in `backend`. |
| `sorry, too many clients already`, from many files at once | PostgreSQL's connection limit: run fewer files at once (`--test-concurrency`). |
| Every file fails while migrating | A migration does not run on an empty database; the error names it. |
| A test fails only between midnight and 05:30 India time | It takes a date from the UTC clock or from the database: take it from `dates.js`. |
| A run was stopped part-way (Ctrl+C, a closed window) | Its databases can stay behind. When no test run is going (a running file's database has the same kind of name), list them and drop each one: |

```sql
SELECT datname FROM pg_database WHERE datname ~ '^rmp_test_[0-9a-f]{20}$';
DROP DATABASE "rmp_test_<the rest of its name>" WITH (FORCE);
```

The browser tests' databases (`rmp_test_e2e_…`) are not in that list: the
next browser run drops them.

## Browser tests

Playwright drives both web apps in a real browser against a real API: the
staff app's specs in `apps/business-web/tests/browser/` (project `staff`) and
the guests' site's in `apps/customer-web/tests/browser/` (project `guests`).
One configuration at the root, `e2e/playwright.config.mjs`, runs both. Each
run makes a database of its own, starts its own API and web servers on it,
fills it with the data the specs read, and takes it all away at the end. It
never uses your database (`DB_NAME`) or your running servers.

### What a run needs

- **PostgreSQL and a user that may create databases**, as for the
  integration tests. The set-up reads `DB_HOST`, `DB_PORT`, `DB_USER` and
  `DB_PASSWORD` from the environment, else from `backend/.env`; it gives the
  test API its own database, port, allowed address and secret.
- **The installs**: at the root (Playwright and Vite) and in `backend` (the
  set-up uses its PostgreSQL client and its migration runner).
- **A browser.** On Windows, the installed Microsoft Edge. Elsewhere,
  Playwright's Chromium (`npx playwright install chromium`, once), or an
  installed browser named in `E2E_BROWSER_CHANNEL` (for example `chrome`).
- **Three free ports** on 127.0.0.1: 5110, 5183 and 5184 ([Ports](#ports)).

Not needed: your own API, web apps or `apps/*/.env` files. The run starts its
own servers and gives them their addresses. Servers you have running on 5010,
5173 and 5174 (`npm run dev`) can stay up.

### Running all or part of it

From the project root:

```bash
npm run test:browser                                     # everything
npm run test:browser -- business-counter                 # the files whose path matches
npm run test:browser -- --project=guests                 # one app's specs: staff or guests
npm run test:browser -- -g "Quick bill"                  # the tests whose title matches
npm run test:browser -- scroll-layout --repeat-each=10   # each test ten times, to find a flaky one
npm run test:browser -- --last-failed                    # only what failed in the last run
npm run test:browser -- business-counter --headed        # watch it in a browser window
npm run test:browser -- --list                           # list the tests: no set-up, nothing starts
```

Every run but `--list` does the whole set-up first, which takes about half a
minute. A full run takes about 25 minutes, and nearly half of it is
`business-workspaces.spec.js`, which opens every menu page of every business.

### What a run does

1. Playwright empties `test-results/` at the project root (git ignores it).
2. It starts both apps' Vite development servers, never reusing one that is
   already running: the staff app at `http://127.0.0.1:5183` and the guests'
   site at `http://127.0.0.1:5184`. They are development servers, not builds,
   because some specs load the apps' own `/src` modules into the page. Both
   apps' API address points at the test API, and the staff app's guests' site
   address at the test guests' site.
3. The global set-up, `e2e/global-setup.mjs`:
   1. stops at once if the API's port is taken, before anything is made;
   2. drops any `rmp_test_e2e_…` database whose run has ended on this
      machine. Each such database notes, in its comment, the machine and the
      process that made it, so a run still going keeps its own;
   3. creates `rmp_test_e2e_` and 16 random hex characters, and runs every
      migration on it, the way the integration tests do;
   4. creates the platform admin straight in the database, as
      `npm run user:create` does (`createUser` from
      `backend/scripts/create-user.js`);
   5. starts the API at `http://127.0.0.1:5110` with `NODE_ENV=test`, a random
      `JWT_SECRET`, `CORS_ORIGIN` set to the test staff app, sign-in limits
      raised so that failing specs never lock the shared logins out, and
      `DB_POOL_GUARD=warn`. Its output goes to `test-results/e2e-api.log`, and
      nothing is written until the API has said it is connected to the run's
      own database;
   6. builds the test data through the API (`e2e/build-data.mjs`);
   7. writes `test-results/e2e-fixture.json`, with the logins and this run's
      passwords and the ids, numbers and QR codes of what it made, and hands
      its path to the specs (`E2E_FIXTURE_FILE`);
   8. asks each app for its first page, so that the first spec does not wait
      for the compile.
4. The specs run one at a time (one worker).
5. The teardown stops the API and everything it started, drops the database
   and deletes the fixture file; it also runs when the set-up fails part-way.
   Playwright then stops both web servers. The API's upload folder, in the
   system's temp folder, can outlast the run; the next test process of either
   suite removes it.

Afterwards, `test-results/` holds the API's log (every request with its
status and time, and anything else the API printed), a screenshot of each
failure, and what the specs save, such as receipt PDFs and screenshots for
review, each in its test's own folder. While a run is going, the fixture file
holds the logins, for signing in by hand at `http://127.0.0.1:5183`.

### Ports

| Server | Address | Moved with |
| --- | --- | --- |
| Test API | `http://127.0.0.1:5110/api` | `E2E_API_PORT` |
| Staff app | `http://127.0.0.1:5183` | `E2E_STAFF_PORT` |
| Guests' site | `http://127.0.0.1:5184` | `E2E_GUESTS_PORT` |

A port is a whole number from 1024 to 65535. The three must differ, none may
be a development server's port (5010, 5173, 5174), and the API's must differ
from `PORT` in `backend/.env`. Every address is 127.0.0.1, never
`localhost`, which Node may take to mean the IPv6 address. The configuration
sets `E2E_BASE_URL`, `E2E_CUSTOMER_URL` and `E2E_API_URL` to these servers
itself; specs take the addresses from the fixture (`fixture().urls`).

```powershell
$env:E2E_API_PORT = '5210'; $env:E2E_STAFF_PORT = '5283'; $env:E2E_GUESTS_PORT = '5284'
npm run test:browser
Remove-Item Env:E2E_API_PORT, Env:E2E_STAFF_PORT, Env:E2E_GUESTS_PORT
```

In bash: `E2E_API_PORT=5210 E2E_STAFF_PORT=5283 E2E_GUESTS_PORT=5284 npm run test:browser`.

### One run at a time

The specs share one database and one set of logins, and some change what
they find, so they run one after another. Two runs must not overlap in one
copy of the repository either, even on other ports: the fixture file and the
API's log have fixed places under `test-results/`, and every run empties that
folder when it starts, deleting the other run's logins. Moving the ports is
for when another program holds them. `--list` is safe at any time.

### The test data

`e2e/test-data.mjs` says what the data is made of, and `e2e/build-data.mjs`
makes it through the API, as the people who would make it: the platform admin
sets up the restaurants and the businesses, their owner everything inside
them.

- **Logins**, one for each role a spec signs in as, with `.invalid` e-mail
  addresses and passwords made fresh for each run: `SUPER_ADMIN` (the
  platform admin), `RESTAURANT_ADMIN` (the restaurant's admin, who also owns
  every business below), the restaurant's `CASHIER`, `CAPTAIN` and `KITCHEN`,
  none of them tied to an outlet, and `SHOP_MANAGER`, the Manager of the books
  shop, the grocery, the pharmacy, the wholesaler and the salon, with no place
  in the restaurant. That login is made in the books shop with *New staff
  login*, then given access to the other four with *Give access*; and
  `RENTALS_MANAGER`, the Manager of the tent house only, made there the same
  way, with a PIN of their own (fresh for each run, set as *My profile ›
  Personal PIN* sets one) to approve money handed back; and
  `PUMP_ATTENDANT`, the fuel station's pump attendant, made there the same
  way with the *Pump attendant (DSM)* role; `HOUSEKEEPER`, the lodge's
  housekeeper, made there the same way with the *Housekeeping* role; and the
  clinic's `RECEPTION` (its front desk, with the *Cashier / sales* role),
  `DOCTOR`, `LAB_TECH` and `PATHOLOGIST`, made there the same way with the
  clinic's *Doctor*, *Lab technician* and *Pathologist* roles, the
  pathologist with a PIN of their own to sign reports. The restaurant has no
  manager login. Each login signs in once while the data
  is made and chooses a password of its own, also made fresh for the run, as
  everyone must after a password someone else set; the run's file keeps that
  one, so a spec meets the *Choose your own password* step only with a login
  it makes itself.
- **The restaurant, E2E Bistro** (Asia/Kolkata): two outlets; two floors,
  the Ground floor with tables 1 to 5 and the Garden with tables G1 to G3,
  none tied to an outlet, each table cleaned for five minutes after its bill
  is paid; two menu categories, four dishes at the restaurant's default GST
  rate and one add-on; for the captain app, a veg biryani in two sizes (Half
  ₹160, Full ₹240) with Raita (₹40) as its add-on; a banquet thali at ₹1,500
  and a caterer in the guest book, for a bill over ₹2,00,000; an expense
  category; three stock items in kilograms, one well stocked, one under its
  reorder level and one run out.
  Its business day is open at the main counter, with a takeaway billed and
  paid in cash and a dine-in order running on table 4; today's captain
  sections give the Garden to `CAPTAIN`. Table 5 holds a dine-in order placed
  two days earlier and never billed: an order left open from an earlier day.
- **The platform**: 49 more restaurants, *E2E Restaurant 01* onwards, each
  with its own admin, so the platform's list of restaurants has two pages of
  25.
- **The businesses**: one of every other type, all created on
  *Platform › Businesses* with the `RESTAURANT_ADMIN` as owner, each with the
  specialist tools of its trade switched on, and tasks, issues and projects
  where the trade is recommended them. Fifteen also hold records of their own:
  - the grocery: a supplier; rice sold loose by weight and in 1 kg packs,
    both received; one sale paid in cash today; two biscuits at GST 18%
    (a 250 g and a 120 g pack), for a GST rate change;
  - the meat shop: two cuts sold by weight, received from a supplier;
  - the wholesaler: a supplier; noodles counted in pieces and sold by the
    case of 96, received; a retailer who owes for one case bought on credit
    today;
  - the salon: one stylist and one service;
  - the clinic: a patient registered at the front desk with consent for
    treatment (`CLINIC`), whom `live-updates.spec.js` gives a token; a
    doctor's appointment calendar named on the `DOCTOR`'s registration (so
    the clinic workspace shows them their own queue), the `PATHOLOGIST`'s
    registration, and a haemoglobin test billed as a service, with its range
    for a woman and its critical low;
  - the hardware shop: a supplier; cement by the bag, binding wire by the
    kilo in 25 kg coils and floor tiles by the box (each covering 16 sq ft),
    all received; a contractor with a site; Fitters' commission on, with a
    painter who earns ₹2 on every bag of cement;
  - the seeds, fertilisers & pesticides shop: its fertiliser, seed and
    insecticide licences, valid from 300 days ago for 1,000 days; a supplier;
    subsidised urea by the 45 kg bag, a chlorpyrifos pesticide by the bottle
    (batch CP-11) and certified paddy seed by the kilo (lot P-2601, valid for
    120 days), all received; a farmer from Kothur, with his father's name,
    land and crops;
  - the optical shop: a supplier; a frame (its MRP ₹2,499) and a single
    vision 1.56 lens, both at 5% GST and received, and the fitting charge as
    a service at 18%; a customer with today's prescription, and one whose
    last eye test was 400 days ago (on the recall list);
  - the garage: a supplier; engine oil by the litre and an oil filter, both at
    18% GST and received, and the service labour as a service at 18% (SAC
    998714); a customer's car with its last reading (41,250 km) and its
    insurance running out in 20 days, and a scooter due for its service in 3
    days;
  - the gym: its joining fee and three plans, each its own service item at 5%
    GST (SAC 999723): a monthly plan with the joining fee, two freezes of 15
    days in all and 3 grace days; a pack of 10 yoga classes; and a three-day
    trial; a member with a paid monthly membership (checked in by the code
    on their card), and another on the trial, which ends in two days;
  - the laundry: dry cleaning (SAC 999712), wash and iron, and wash and fold
    by the kilo, each its own service item at 18% GST; shirts, sarees and
    mixed clothes on the price list; express at 50% on each garment and the
    terms printed on every receipt; a customer's order, billed when handed
    over: two shirts for wash and iron under one tag, and a saree for dry
    cleaning with a stain noted and acknowledged, promised in two days;
  - the jeweller: today's rates on its own date (22K at ₹11,780 a gram, with
    24K, 18K and silver 999); a ₹45 hallmarking charge and its location's
    district under mandatory hallmarking; its BIS registration, kept with
    the licences tool (switched on for it); a gold ring and a gold chain as
    jewellery items (wastage and making per gram), with three 22K rings
    tagged into stock as opening stock, each with its HUID, and an 8.2 g
    rope chain with none; a customer's old chain taken in on an old gold
    voucher; and an 11-month gold scheme plan with a customer enrolled in
    it, three ₹5,000 instalments paid by UPI;
  - the tent house: a hirer's photo ID at every handover and its terms; a
    15 kVA generator hired one by one (Gen A and Gen B, each with its hour
    meter; ₹400 an hour, ₹2,500 a day, a ₹5,000 deposit, a 4-hour minimum,
    an hour's turnaround and a late fee by the hour after 30 minutes), plastic
    chairs from a pool of 200 (₹10 a day, ₹5 deposit each) and a sound system
    by the day (₹2,000, a ₹5,000 deposit, ₹1,000 a day late after 30
    minutes), each its own service item at 18% GST (SAC 997329); Gen A booked
    for tomorrow from 9 am to 9 pm; a sound system handed over with its
    deposit and moved back in the database so that it is three hours past its
    due back time; and Gen B with 100 chairs, going out now for 26 hours and
    not handed over;
  - the fuel station: petrol and diesel on the GST nil slab; tank T1 of
    petrol (15,000 litres, 9,000 in it) and T2 of diesel (20,000 litres,
    12,000 in it); dispensing unit DU 1 with nozzle 1 for petrol (its
    totaliser at 1,00,000.000) and nozzle 2 for diesel (2,50,000.500); the
    5-litre measure; petrol at ₹102.12 and diesel at ₹95.20 from yesterday
    morning; yesterday's morning dips at 06:00 (9,000 and 12,000 litres); a
    diesel shift on nozzle 2 opened two hours ago and closed an hour ago
    (500 litres moved, the 5-litre test pumped back, 495 litres at ₹95.20,
    ₹47,124.00 in cash, exact); the terminal as a supplier; Sri Balaji
    Transports, with 30 days' credit up to ₹1,00,000 and its truck
    TS09UB4455 filled with diesel on credit (300 litres a fill at most);
    and a *Fleet card* payment method;
  - the lodge: the 5% and 18% slabs of a room night with the ₹7,500 limit,
    Friday and Saturday as the weekend nights, and its terms; a Deluxe room
    type (2 adults in the rate, 3 guests at most, an extra bed; ₹4,500 a
    night, ₹5,200 at the weekend, ₹1,000 an extra adult, ₹500 a child, ₹800
    an extra bed) with rooms 101 and 102, and a Suite (2 adults in the rate,
    4 at most; ₹7,000, ₹8,500 at the weekend, ₹1,500 an extra adult) with
    room 201, each its own service item counted in nights (SAC 996311); a
    family of three adults in room 201, booked by phone with a ₹5,000 advance
    in cash and checked in with each occupant's photo ID, moved back in the
    database so that they arrived yesterday and leave today; and a phone
    reservation for tonight in room 102.

### What each spec checks

Project `staff`, in `apps/business-web/tests/browser/`:

| Spec | Signs in as | What it checks | What it changes |
| --- | --- | --- | --- |
| `business-admin.spec.js` | `RESTAURANT_ADMIN`, `SHOP_MANAGER` | At 1440 px (light) and 390 px (dark). In the books shop, as its owner: a book is added with its ISBN and no GST, five copies are received from a new supplier (the posted receipt opens, owing the supplier), and one is sold at Quick bill, opened from *Sales › New bill*, on udhaar to a customer added there. The bill, opened from Sales, is collected (the amount still open is filled in), the book is taken back and the customer refunded (the whole credit is filled in); nothing scrolls sideways. A form with unsaved changes asks first: *Keep editing* keeps what was typed, *Discard changes* closes it. As `SHOP_MANAGER`, who lands in one of their shops: the header's switcher opens each of the others, and every link in its menu is that business's own (on a phone, the menu opens from the header's menu button). Saves screenshots for review. | Adds a book, a supplier and a customer named for the run, with the purchase, the sale, its collection, the return and the refund; the switcher records the business `SHOP_MANAGER` opened last |
| `business-hardware.spec.js` | `RESTAURANT_ADMIN` | A quotation for the contractor: cement by the bag and binding wire by the coil, with the server's own figures in the dialog (GST included, the round-off, the total); it saves with a QT number, prints on A4 (the print stub keeps it in the page), makes a WhatsApp link to the contractor's number, and becomes a bill at the quoted total, after which it shows *Billed*. At Quick bill, a bill for the contractor goes to their site (the *Site* card), and the site's ledger on *Sites* lists it; the bill, opened from there, names the site. A Quick bill names the painter (*Fitted by*): his statement on *Fitters* shows the bill and ₹2.00 due, sends a WhatsApp link to his number, and the bill names him with its commission; *Pay* offers a UPI app link with his UPI id and the amount, records the payout and clears what is due; *Reports › Fitters' commission* counts it. On *Today's rates*, cement and wire go on the board, cement's rate is typed and saved (the board shows the rate before and the change), the list goes to WhatsApp, and the rate is set back. The tile calculator on Quick bill works out 14 boxes for 200 sq ft with 10% wastage and puts them on the bill; the paint calculator gives 21.9 L and 1 × 20 L + 2 × 1 L for 600 sq ft, two coats at 55 sq ft a litre. Saves screenshots for review. | Adds a quotation and its bill, two Quick bills on udhaar to the contractor (one to the site, one fitted by the painter), a payout to the painter, two items on the rate board, and two rate changes that end where they began |
| `business-agri.spec.js` | `RESTAURANT_ADMIN` | At Quick bill, subsidised urea waits for its PoS receipt number (*Take* stays off and the bill says why), then bills at ₹267.00 (₹266.50 a bag, GST included, rounded to the rupee); the bill's A4 tax invoice shows the receipt and the fertiliser licence number, and so does its print. The chlorpyrifos pesticide asks for the crop it is for (it must not be used on ber, citrus and tobacco), stays off for citrus, and bills for paddy to a walk-in farmer named with a village, whom the insecticide register then lists with the batch and the manufacturer. The item form refuses a dicofol pesticide (banned, S.O. 4294(E)) as it is typed and again on *Save*, and saves an imidacloprid one with its formulation. *Licences* lists the shop's three licences as valid; *Farmers & village dues* lists the Kothur farmer, adds another and shows the dues by village; *Registers & board* shows the board, prints it with the licence numbers, and shows the seed stock return; *Molecules* lists dicofol with its source; *Farm input checks* says where a line is billed; the urea's PoS stock is typed in and the day's reconciliation lists it. Saves screenshots for review. | Adds two bills (urea with its PoS receipt; the pesticide to a walk-in farmer), an imidacloprid pesticide, a farmer and a PoS stock entry |
| `business-optical.spec.js` | `RESTAURANT_ADMIN` | *Spectacle orders* is a daily entry of the optical shop's menu. A prescription is typed per eye (SPH, CYL, AXIS and the near ADD), the left eye copied from the right and its axis changed, with the PD; the list shows the customer's latest powers in one line, the customers' area holds the recall list, and the customer's history sets the two eye tests side by side with the change of the right SPH (-0.25). A spectacle order is booked from the customer's prescription with the frame and the lens from stock, the left lens the same as the right, a lab and its promised day, and an advance: the dialog shows the server's total, ₹4,999.00, and ₹2,999.00 to pay at delivery. It goes to the lab with the lab's order number, to the quality check and passes it; the job card prints the prescription and the lab's order number with no prices; delivery posts the bill at ₹4,999.00 less the ₹2,000.00 advance. The recall list shows the customer whose last test was 400 days ago and not the one tested today; *WhatsApp* opens a `wa.me` link to their number and the row then counts one reminder. On the item form, a contact lens made as one item for each power (base curve, diameter, a code prefix, -0.50 to -6.00) makes 23 items, each labelled with its power. Saves screenshots for review. | Adds a prescription, a spectacle order delivered with its bill and the advance, a recall reminder, and a contact-lens product with 23 powers |
| `business-garage.spec.js` | `RESTAURANT_ADMIN` | *Job cards* is a daily entry of the garage's menu. A job card is opened for the car found by its plate typed with spaces and a dash (the dialog shows its owner and last reading, 41,250 km), with the reading and fuel in and two complaints. The estimate takes the service labour, 3.5 litres of oil and the filter at the customer's prices, and the dialog shows the server's total, ₹2,955.00, with a round-off of ₹0.35. The estimate is sent, the owner's approval recorded as given on WhatsApp, the work started, ticked done (3 of 3) and the vehicle made ready; the workshop copy prints the work with no prices, and the customer copy the total. *Bill and deliver* shows the bill and the next service at 46,603 km, and delivers with a bill numbered SI/…; the list by date shows the job card delivered. The vehicles list finds the car by its plate typed with spaces, and its page shows its odometer log and owner. *Service due* lists the scooter's service in 3 days and the car's insurance; *WhatsApp* opens a `wa.me` link to the owner's number and the row then counts one reminder; *Insurance* leaves only the car. *Garage settings* shows 6 months or 5,000 km, makes the claim-share item and saves it. Saves screenshots for review. | Adds a job card billed and delivered (its parts out of stock, a bill paid in cash), a service reminder, the claim-share item and the garage's settings |
| `business-memberships.spec.js` | `RESTAURANT_ADMIN` | *Check-in* and *Members* are daily entries of the gym's menu. The member's code typed in small letters and Enter, as a scanner sends it, lets them in; again the same day says they are already in, and *Today's check-ins* lists them. On *Members & plans* the member opens their page, with the refund policy of the version sold; *Freeze* for five days shows the membership frozen, *Check-in* then turns them away as frozen, and *End the freeze* the same day makes it active again. *Settings › Membership plans* adds a quarterly plan with its own item (₹4,000 at 5%); *Sell a membership* to a new member shows the server's bill, ₹4,200.00, and posts it, opening their page with a member code. *Renewals* lists the trial ending in 2 days; *WhatsApp* opens a `wa.me` link to the member's number naming the plan and notes the reminder; *Renew* shows the renewal's bill, ₹315.00, and posts it; the trial leaves the list, and its renewal, not started and ending in 5 days, takes its place. Saves screenshots for review. | Adds two check-ins and a freeze ended the same day for the member, a plan, a new member with a membership, a reminder and the trial's renewal |
| `business-laundry.spec.js` | `RESTAURANT_ADMIN` | *New order* and *Orders* are daily entries of the laundry's menu. *New order* takes in a shirt and a saree for dry cleaning, express, for the customer found by name: the server's total, ₹831.90 (₹120.00 and ₹350.00 with 50% more for express, and 18% GST), and the order opens with its garments, the receipt and the tags printed. The order made by the set-up goes into the work and to ready on rack B-7; *Ready & racks* finds it by its number on that rack; *Hand over* takes ₹507.40 for the whole order and posts its bill, numbered SI/…, and the order is delivered. *Services & items › Price list* changes the saree's dry-cleaning price to ₹375.00, which is kept, shows express at 50.00%, and puts the price back; *Unclaimed* says the garments are held until paid. Saves screenshots for review. | Adds an order taken in, and the set-up's order delivered with its bill; the price changed and put back |
| `business-jewellery.spec.js` | `RESTAURANT_ADMIN` | *Today's rates* and *Jewellery bill* are daily entries of the jeweller's menu. *Today's rates* shows the morning's sheet in use (22K at ₹11,780 a gram, ₹1,17,800.00 for 10 g, old 22K gold bought at ₹11,500); *Set today's rates* starts from the rates in use, and the new sheet with silver at ₹168.50 and ₹160 is in use at once; the *Rate board* tab shows the shop's name and the rates in use. *Pieces & tags › Tag a piece* tags a chain of 6.120 g with its HUID typed in small letters, taking the item's making and wastage and the settings' ₹45.00 hallmarking charge; its panel shows the hallmark and its price at today's rate, and its tag label prints its number, purity, weights and HUID and no price. On the *Jewellery bill* the ruby ring's tag shows its price built up (metal ₹50,065.00 at ₹11,780 a gram, wastage 8% ₹4,005.20, making ₹1,912.50, the ruby ₹1,200.00, hallmarking ₹45.00: ₹57,227.70 before GST, ₹1,716.83 GST, ₹58,945.00 after a round-off of ₹0.47); the rope chain of 8.200 g with no hallmark is refused with the screen's own message and the bill cannot be posted with it; the ring alone posts (SI/…), and its invoice prints the article's words, net weight, purity in carat and fineness, HUID, hallmarking charge and price build-up, the purity statement and the BIS registration. The old gold customer's voucher (₹33,810.00) pays first on a band found by its HUID (₹51,603.00) and UPI the ₹17,793.00 left, and the invoice shows *Paid · Old gold OG/…*; the gold scheme's passbook shows three instalments of ₹5,000 paid by UPI, *Redeem on a jewellery bill* opens the bill with the scheme chosen, its ₹15,000.00 pays first on a ring of ₹33,965.00 with no discount (it has not matured), the invoice says it redeems the scheme, and the money held for schemes comes to ₹0.00. Saves screenshots for review. | Adds a rate sheet (silver changed), a chain tagged into stock, and three bills: the ruby ring's (UPI), the band's (old gold and UPI) and the ring's that redeems the scheme (the scheme and UPI) |
| `business-rentals.spec.js` | `RENTALS_MANAGER` | *Bookings* is a daily entry of the tent house's menu. The board shows the sound system in *Overdue* with its ₹5,000.00 deposit held, and the generators in *Reserved*, the one past its out time marked not handed over. *New booking* over Gen A's booked time two hours later marks Gen A booked on its booking, and *Book it* is refused by the server too; 20 chairs instead come to ₹236.00 (a day at ₹10 each and 18% GST) and the booking opens. The generator and chairs are handed over with the last four digits of the hirer's Aadhaar, each line's condition and the hour meter (850), with the ₹5,500.00 deposit asked: the booking shows the ID, the conditions and the meter, and the handover slip prints them. The sound system is taken back a day late (₹1,000.00) with a ₹500.00 damage charge: the bill comes to ₹4,130.00 with ₹630.00 GST, paid from the deposit, with ₹870.00 to go back on the manager's PIN; the bill is posted (SI/…), the deposit shows applied ₹4,130.00 and handed back ₹870.00, the charge is billed, and the slip for the money handed back prints. *Deposits held* lists the generator booking's ₹5,500.00 while the sound system's is settled; the board has the generator out by the day it is due; *Availability* shows Gen A held by its booking; *Rental items* lists the items and units. Saves screenshots for review. | Adds a booking of 20 chairs, hands the generator booking over with its deposit, and takes the sound system back with its bill, its damage charge and the deposit's rest handed back |
| `business-fuel.spec.js` | `PUMP_ATTENDANT`, `RESTAURANT_ADMIN` | The pump attendant's menu has *Shift & readings* and no Settings; the board shows the prices in force and DU 1's nozzles with their totalisers. *Open a shift* on nozzle 1 opens from 1,00,000.000; the close (1,00,500.500 with the 5-litre test, ₹20,000 by UPI and ₹30,590 in cash) shows 495.500 L of petrol for ₹50,600.46 and *Short ₹10.46* before it is closed, and the closed shift keeps its readings and the short. As the owner: a tanker load into T1 shows *+6.5 kg/m³ · outside the tolerance* (with the manager's note asked for) and then, sampled again, *+2.0 kg/m³ · within the tolerance*, 3,960 litres in by the dips and 40 short; accepted, it is a purchase of ₹3,80,000.00. T2 is not dipped, 11,505 litres by the book; its dip of 11,000 makes yesterday's day of the register 505 litres short (−4.59%), *Loss beyond tolerance*, and the density register keeps the morning's 830.5 kg/m³. A shift on nozzle 2 closes with 150 litres into TS09UB4455 on slip 0012 (₹14,280.00 on credit) and ₹4,760 in cash, exact; the truck's fill is on Sri Balaji Transports' statement, which prints. Saves screenshots for review. | Opens and closes two shifts (one on each nozzle), accepts a tanker load into T1 and takes T2's dip of today |
| `business-lodging.spec.js` | `RESTAURANT_ADMIN`, `HOUSEKEEPER` | *Front desk* is a daily entry of the lodge's menu, with tonight's phone reservation under *Arrivals* and the family under *Departures*. *New reservation* for a walk-in (*New guest*), two nights in a Deluxe room: each night at its rate at 5% and the total, with an advance; *Reserve* opens the stay. *Check in* to room 102 shows that it is booked by the phone reservation, and the server refuses it too ("…: choose another room"); every occupant is recorded (the guest by the last four digits of their Aadhaar, a British guest with their passport, e-Tourist visa, the date they arrived in India and their next destination) and room 101 checks them in: the occupants show *Aadhaar ending 4321*, the passport and the arrival report to make, and the history the check-in. *Foreign guests (Form-III)* shows the guest's report due in 23 or 24 hours and the departure's after the check-out; *Mark reported* with the acknowledgement takes it off the list, and *The last 90 days* shows it reported. *Run the night audit* posts the family's Suite night (three adults, the third at the extra-adult rate, above ₹7,500) at 18% and the walk-in's Deluxe night at 5%; run again, it posts nothing new. The family's *Check out* shows the bill, the ₹5,000.00 advance paying first and the rest to pay now, taken by UPI; the bill (SI/…) is paid in full with the advance applied, the folio's nights billed, and room 201 is vacant dirty. As `HOUSEKEEPER`: the menu has *Rooms & housekeeping* and no *Front desk* or *Guest register*; room 201 shows who checked out and *Mark clean* makes it vacant clean, with the walk-in in room 101. The *Guest register* from yesterday lists every occupant with their ID details and prints with the Form-III acknowledgement. Saves screenshots for review. | Adds a walk-in's stay, checked in with two occupants and its Form-III arrival marked; posts the room nights up to tonight; checks the family out with their bill; marks room 201 clean |
| `business-counter.spec.js` | `RESTAURANT_ADMIN` | Quick bill opens for the grocery, fashion, electronics, books and the meat shop, each with its own scan words (scale label, barcode, IMEI, ISBN), and fashion's has *Size & colour*. F2 and F4 move between the scan and customer boxes; udhaar asks for a customer first; the loose rice waits for its weight, with the take button off until 500 g is chosen; F10 holds the bill and it comes back. The search list moves by keyboard and never says a typed name is a missing barcode; *Return* finds today's sale; on a phone the lines are compact and the pay bar stays at the foot. Daily money opens by payment method, and the sale's A4 tax invoice shows HSN/SAC, the amount in words and the place of supply. | Nothing: bills are built on screen and cleared |
| `business-salon-weight.spec.js` | `RESTAURANT_ADMIN` | The salon calendar's day and week show the stylist, and *Walk-in* opens. The salon bill adds the service from its search box, shows *Take ₹…* and *Total ₹…*, and offers another way to pay. The meat shop's *Today's rates* holds each cut's rate per kg, *Stock by weight* offers *Close the day*, and *Orders for pickup* opens. | Nothing |
| `business-staff-access.spec.js` | `RESTAURANT_ADMIN` | In the supermarket's *Staff & access*, *New staff login* and *Give access* offer only the active departments, and show no department field when there are none. *Change* and *Password* show only beside the people the staff list marks as managed, and never on your own row. The test supplies the list of departments itself, and adds to the staff list one person the caller manages and one they do not. | Nothing: the dialogs are cancelled |
| `business-wholesale.spec.js` | `RESTAURANT_ADMIN` | The wholesaler's overview shows its day. A new sales order finds the retailer and shows their last order, and takes the noodles by search as two cases and ten pieces, counted in pieces. The dispatch board and delivery runs, the cheques and salesperson settlement in *Collections*, *Promise* on the retailer's row in *Outstanding*, price groups and claims all open. | Nothing: the order is cancelled |
| `business-workspaces.spec.js` | `RESTAURANT_ADMIN` | For every business type: a short menu (at most 16 links, no set-up pages), its settings and reports; every main-menu page opens with no script error or server error, and every related page the business has switched on opens with its tab marked and no failed read from the business API. Also: tabs by keyboard and in the browser's history, tabs and *More tools* on a phone, in-page tabs, the label sheet, Quick bill's search, the meat shop's counter, stock, udhaar, expenses and Daily money, the pharmacy's prescription sale with one way to pay, and the restaurant's related areas with their view tabs. Saves screenshots for review. | Nothing |
| `captain.spec.js` | `CAPTAIN`, `CASHIER`, `KITCHEN`, `RESTAURANT_ADMIN` | The captain app on phones of 375×812 and 412×915, every screen live with its safety net set to an hour (`rmp_live_poll_ms`), so each change must come by itself within seconds. *My tables* shows the Garden alone, the captain's section today, and *All tables* every table. *Start order* on G1 opens the POS's order screen inside the app: the biryani in its Half size with Raita and a note, the dal makhani as course 2, held, two guests and a note typed on the dal; *Send* places it (source `captain`) and goes back to the tables, the tile showing the guests and the kitchen's progress. The kitchen display shows the biryani with its size, add-on and note and no dal, until *Fire course 2* sends the dal with its note. A guest's *Call waiter* from G2's QR page and *Water please* from table 1 (outside the section): *Calls* shows only G2's, with a line for the other; *On my way* and *Done* answer it, and the other is closed with every table shown. The kitchen marks G3's ticket ready: *Ready* shows it, and *Served* marks it served by the captain. The captain sees no running total and gets no *Bill*, only a line that the counter raises it; a cashier on the same app (every table, totals shown) raises it in the POS's bill window, with its payment form. The captain's tile then says *Bill printed*, and the captain prints the bill (no payment form; the print counted); the cashier takes the payment, and *Mark ready* frees the table on both phones. No sideways scroll; saves screenshots for review. | An order on G1, cancelled at the end; an order on G3, billed, paid and its table made ready; two guest calls, closed |
| `clinic-lab.spec.js` | `RECEPTION`, `DOCTOR`, `LAB_TECH`, `PATHOLOGIST` | One patient from the front desk to the doctor, the lab and back, each person on a device of their own (the desk at 1280×800, the doctor's and the lab's tablets at 1024×768), every screen live with its safety net set to an hour (`rmp_live_poll_ms`). The clinic's Business Admin menu links *Clinic workspace* and *Lab workspace* to `/clinic/<id>` and `/lab/<id>`; `/clinic?choose` lists the clinics, and the bare `/clinic` opens the one chosen. The doctor's *Your queue* is open before the patient comes. The front desk registers her with her consent (*Register a new patient*) and gives her a token for the doctor: within seconds she is on the doctor's queue, waiting. *Next patient* calls her and *Start* opens the consultation, with the queue beside it and her history (a first visit): BP, complaints, the diagnosis, a medicine, the follow-up in 14 days and a referral, *Save draft*; *More › Order tests* orders the haemoglobin test (no *Bill the tests now* for a doctor), and the order shows on the consultation; *Complete consultation*; the prescription prints with the doctor's registration and the referral, and the referral letter with its reason and the diagnosis. The lab: *To collect* shows the sample, *Labels* prints its barcode, then *Collected*, *Reject* ("Haemolysed": back to collect, with the reason), *Collect again* and *Received in lab*; the *Worklist* row opens the order, where 9.2 g/dL is flagged *Low* and saved. The pathologist approves it from *Approval* with their PIN, and *Released* prints the report with the value and the pathologist's name; the lab's tablet counts it under *Released* by itself, and the doctor's open consultation shows the result. The front desk sees, on the visit, the patient's page, *Released* and the lab order, no diagnosis, complaint, medicine, referral or value, no history and no *Print report*. At 390×844 the desk, *Today*, the lab's collection and worklist and the consultation fit with no sideways scroll; no script or server error; saves screenshots for review. | A patient with a completed visit (its token done) and a released haemoglobin report |
| `combos-and-production.spec.js` | `RESTAURANT_ADMIN` | At 1440 px (light) and 390 px (dark): a dish's serving times and combo choice are set and saved (the serving period is tried, then removed, so the dish stays on all day); on the POS the combo waits for its choice before *Add to order*, and goes on the order with the choice, at the dish's price plus the choice's extra price. A prepared item's changed recipe must be saved before *Post production*; a batch is made, then voided, which puts its ingredient back; part of a delivery's batch is written off. The stock the API reports is checked after each step. Saves screenshots for review. | Adds two dishes and two stock items named for the run, with a delivery, a production batch (voided) and a write-off. Nothing goes to the kitchen: the combo is only put on the POS's order, which is never sent |
| `dashboard-panels.spec.js` | `RESTAURANT_ADMIN` | A dashboard tile or a *Needs attention* row opens its records in a panel whose count is the figure and whose list holds that many. The address carries the panel, so Back closes it and a reload opens it again; Escape and *Close* close it; a Ctrl-click opens the full screen in a new tab; rejecting an expense in the panel updates the count; on a phone the panel is a full-screen sheet. | Adds an expense and rejects it |
| `data-grid.spec.js` | `RESTAURANT_ADMIN`, `SUPER_ADMIN` | The shared DataGrid, on a page that exists only inside the test (60 made-up rows): sorting, search, filters, paging with serial numbers running on across pages, rows per page, hidden columns and widths kept over a reload, CSV export, cards on a phone, row tones in light and dark, server paging, narrow and pinned columns, and the entry variant. Then *Outlets* (every outlet, sorted both ways, one page, the CSV headings, phone cards) and, as the platform admin, *Platform › Restaurants* (pages of 25 numbered on from 26, 50 rows per page kept over a reload, a search that narrows to the test restaurant). `GRID_SHOTS_DIR`, when set, receives screenshots. | Nothing |
| `floor-actions.spec.js` | `RESTAURANT_ADMIN`, `CAPTAIN`, `CASHIER` | The dashboard's Floor panel: *Start order* on a free table opens the POS; an eating table offers *Open order* and *Bill*, and the POS goes straight to the bill; *Take payment* opens the bill; a paid table goes to cleaning and *Mark ready* frees it. A captain gets no *Bill*, *Take payment* or *Cancel order*, even on the order left open from an earlier day; a cashier may bill that order, or cancel it from the row's menu. | Places, bills and pays an order of its own on a free table, then marks the table ready |
| `gst-rates-by-date.spec.js` | `RESTAURANT_ADMIN` | The grocery's *GST rate changes*: *New GST rate change* finds the two biscuits by name, moves them to GST 5% from the next 1 April (the date it offers), and shows what each becomes: GST 18% now, 5% then, the customer paying the same; *Keep the price before GST instead* shows ₹59 becoming ₹52.50, and back. *Schedule for 2 items* lists the change as scheduled; it opens with its items, and one is cancelled with a reason. The catalogue shows *GST 5% from* that 1 April under the other biscuit's GST, and its *GST history* shows the change with its reason; it is cancelled there too, and the list shows the change cancelled. On the restaurant's *Menu › GST rate changes*, Butter naan is scheduled to GST 18%, shown in its *GST history* (*Menu › Products*, its more actions), and cancelled there. | Adds a GST rate change at the grocery and one at the restaurant, each cancelled before the test ends: no item or dish moves |
| `guest-book.spec.js` | `RESTAURANT_ADMIN` | With Loyalty points switched off, as a new restaurant starts, the guest book's reports show guest sales only: no points tab, no error, and no request for the points report. | Nothing |
| `guest-redirect.spec.js` | — | Old guest links on the staff app's address (`/order`, `/online`, `/book`) land on the guests' site with path, query and hash kept; the guest data old pages kept in the browser is cleared, and the staff's own settings stay. | Nothing |
| `preorders.spec.js` | `RESTAURANT_ADMIN`, `KITCHEN` | At 1440 px (light) and 390 px (dark). With *Advances & deposits* off, *New pre-order* books 1 cake and 0.5 kg of cookies sold by weight: it shows no advance fields, only the line saying why, and there is no *Advances held* on the page or in the dashboard's Pre-orders block. With Advances on, a second is booked with a ₹500 advance by UPI, and the dashboard shows ₹500 held; with an outlet picked, the block says *All outlets* and still counts every outlet's. Each booking is checked against the API. The bake list for tomorrow (the main counter's) adds them up, 2 × cake and 1 kg of cookies, with each pre-order and its message. `KITCHEN` finds *Pre-orders & cakes* in its menu and gets the bake list alone, with no *New pre-order*, tabs, tiles or row actions, and none of its pre-order requests is refused. Nothing scrolls sideways; saves screenshots for review. | Switches Pre-orders on, and Advances off and on, through the API, then back as they were. Adds a cake and cookies named for the run, two guests and two pre-orders (cancelled at the end), and a UPI advance taken and handed back on the main counter's day |
| `live-updates.spec.js` | `RESTAURANT_ADMIN`, `KITCHEN`, `CAPTAIN` | Two devices each, in browser contexts of their own whose live screens' safety net is set to an hour (`rmp_live_poll_ms`), so only live updates can bring a change in; each screen says *Live*. A takeaway placed at the POS with a dish made for the run shows on the kitchen display within 8 seconds, and its cancellation at the till shows there just as quickly. A guest's *Call waiter* from table 3's QR page (the guests' site, on a phone of its own) shows on the captain's *Table requests* within 8 seconds, and *Done* takes it off. At the clinic, a token given to the patient on one *Token queue* shows on the other within 8 seconds, and cancelling it there takes it off the first. | Adds a dish, a takeaway order cancelled after its KOT, a waiter call answered, and a token cancelled |
| `password-must-change.spec.js` | `RESTAURANT_ADMIN`, then the login it makes | In the grocery's *Staff & access*, *New staff login* says the person chooses their own password when they first sign in, and makes a cashier login (`NEW_STAFF`). On a browser of its own, the cashier opens Quick bill from its address, is sent to sign in, signs in with the password they were given and meets *Choose your own password* before anything else: the password they were given is refused as their own, then a new one is saved, and they land on Quick bill, still there after a reload. Their own password then signs them in with nothing more to do, and the one they were given no longer does. | Adds a cashier login named for the run in the grocery, with a password of its own |
| `printing.spec.js` | — | [Receipt printing checks](#receipt-printing-checks). | Nothing |
| `quick-access.spec.js` | `RESTAURANT_ADMIN`, `KITCHEN` | Quick access: five shortcuts chosen, reordered and saved, kept over a reload, unchanged by *Cancel*, and still in place while the menu scrolls. Each person has their own, and a stored page the person may not open, or no page at all, is never shown. Keyboard focus in the editor, a phone, and a short landscape screen. | Nothing: shortcuts live in the browser |
| `restaurant-cash-pan.spec.js` | `CASHIER` | On the POS, a takeaway of 150 banquet thalis for the caterer from the guest book (over ₹2,00,000): the bill window shows *Buyer's PAN needed* and asks for the PAN, and how much more cash the bill and the caterer can take today (₹1,99,999.99 each). The whole bill in cash is flagged as more than the limit allows; *Take* sends nothing without the PAN, and with it the server refuses the cash in the law's words, beside the button, keeping nothing. ₹1,50,000 in cash goes through with the PAN (on the bill's badge and paper), leaving ₹49,999.99 for each; the rest by UPI settles it, and the printed bill carries *Buyer PAN*. Screenshots for the visual review go to the test's folder. | Places, bills and pays an order of its own for the caterer: ₹1,50,000 in cash and the rest by UPI |
| `screens.spec.js` | `RESTAURANT_ADMIN` | Every route in the staff app's `src/App.jsx` that takes no parameter, at 1440 px and 390 px, opens with no script error, no server error and no request to a switched-off feature; the platform's pages turn a restaurant admin away. A dish's *Prices & outlets*, *Serving times & combo choices* and *Sizes & add-ons* open, and, with Stock & recipes on, an add-on's *Ingredient recipe* and the production tab. | Nothing |
| `scroll-layout.spec.js` | `RESTAURANT_ADMIN` | At 1920×900, 1440×900, 390×844 and 740×390, the dashboard and the last 30 days' sales report scroll inside the app, never the page; the last card can be reached, the header stays put, and the *Customize quick access* dialog still covers the window after scrolling. | Nothing |
| `shared-components.spec.js` | `RESTAURANT_ADMIN` | A dialog takes focus, keeps Tab inside, closes on Escape and gives focus back; a required field shows its message under it; on a phone a dialog is a full-screen sheet with its buttons in reach; toasts appear, can be dismissed and leave by themselves; the confirm answers yes or no with Cancel focused, and over a dialog closes alone on Escape; the outlet picker works by keyboard; *Skip to content* is the first Tab stop; `durationMinutes` counts in hours when asked. | Nothing |
| `sign-in-return.spec.js` | `SUPER_ADMIN`, `RESTAURANT_ADMIN` | After signing in, the same person goes back to the page they were on; someone else signing in after a sign-out (the restaurant admin after the platform admin, on *Platform › Restaurants*) starts at their own home page, never at *Access denied*; so does a restaurant admin signing in on a platform address opened while nobody was signed in (a restored tab). A page the person may not open says so and offers *Go to home page*. | Nothing |
| `tasks.spec.js` | `RESTAURANT_ADMIN` | On a phone: a task due today shows under *Today* in *My tasks*; its checklist takes a tick, a Yes, a reading out of range (it turns red and raises an issue, then is corrected) and a choice; *Mark done* finishes it, its history says what happened, and it moves to *Done*. Every task screen fits the phone without sideways scrolling. | Adds a task, done, and the issue its reading raised |
| `ui-motion.spec.js` | `RESTAURANT_ADMIN` | The sales chart read by keyboard and by touch, showing exact amounts; with reduced motion nothing moves, and menus, dialogs and links still work; a slow dashboard read shows a skeleton, and a refresh keeps the figures on screen until the new ones arrive. | Nothing |
| `visual-density.spec.js` | `RESTAURANT_ADMIN` | Guest insights at 1440 px and 390 px: its shortcuts, figures and every guest group, search and charts. Screenshots of dense screens (activity log, waste and reorder, theft, time clock, business day, the meat shop, the wholesaler's dues, the salon's calendar) with no sideways overflow. The reorder and theft tiles pick their filter, kept over a reload, and the time clock's tabs switch. | Nothing |

Project `guests`, in `apps/customer-web/tests/browser/`:

| Spec | Signs in as | What it checks | What it changes |
| --- | --- | --- | --- |
| `guest-pages.spec.js` | — | The site's own address says how to reach a restaurant's page; a link with a part missing, an unknown link and a planned page (`/shop`, `/appointments`, `/account`) each say what to do, in the guest's words; the shared look loads in light and in dark; a table's QR code opens that table's menu with every dish, titled with the restaurant and the table. No page has a script error, and no request carries a staff login. | Nothing: no order, no booking |

### Writing a spec

A new `*.spec.js` file in `apps/business-web/tests/browser/` belongs to the
`staff` project, one in `apps/customer-web/tests/browser/` to `guests`; the
configuration picks it up with no other change. It reads the run's data
through `e2e/fixture.mjs`:

```js
import { expect, test } from "@playwright/test";

import { business, GROCERY, signIn } from "../../../../e2e/fixture.mjs";

test.beforeEach(async ({ page }) => {
  await signIn(page); // as RESTAURANT_ADMIN
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

test("the grocery's counter finds the loose rice", async ({ page }) => {
  await page.goto(`/business-admin/${business("grocery").id}/counter`);
  await page.getByLabel("Scan or type an item").fill(GROCERY.weighedItem.name);
  await expect(page.locator(".rt-matches button").filter({ hasText: GROCERY.weighedItem.name })).toBeVisible();
});
```

| From `e2e/fixture.mjs` | What it gives |
| --- | --- |
| `signIn(page, role = "RESTAURANT_ADMIN")` | Signs in through the staff app's own form and waits until it has left the sign-in page; the spec then checks where it landed (`.dash-page` for the restaurant's dashboard, `main.content-scroll` for any screen). It opens the form by its full address, so it also works in a browser context the spec makes itself, as `floor-actions.spec.js` does for its captain and cashier. The password is cleared from the form, so a failure's screenshot never shows it. |
| `account(role)` | `{ role, name, email, password }` |
| `business(type)` | `{ id, type, name, code, locationId, capabilities }`, plus what was made in it for the grocery, the meat shop, the wholesaler and the salon (`business("grocery").sale.number`) |
| `fixture()` | The whole file: `urls` (`api`, `staff`, `guests`), `accounts`, `restaurant` (ids, `tables[].qrToken`, `products`, `paidBill`, `runningOrder`, `leftOpenOrder` and more), `platform` and `businesses` |
| `localDate(days = 0)` | `YYYY-MM-DD` on the restaurant's clock, today or `days` from it: `localDate(-6)` to `localDate()` is the last week, at any hour |
| `RESTAURANT`, `PLATFORM`, `BUSINESSES`, `GROCERY`, `MEAT`, `WHOLESALE`, `SALON`, `LOGINS`, `TIMEZONE` | The names and figures of `test-data.mjs`, to check against instead of typing them again |

Rules every spec keeps:

- **Read the data inside a test or a hook**, never at the top of the file:
  listing the tests reads no data. The functions throw when a login, a
  business or the file is missing, so the test fails rather than skips.
- **Leave the shared data as you found it**, or change only what the spec
  made itself: `floor-actions.spec.js` places, bills and pays an order of its
  own and marks the table ready again; `dashboard-panels.spec.js` adds an
  expense and rejects it; `preorders.spec.js` puts back the feature switches
  it turns, cancels its pre-orders and hands its advance back, even when the
  test fails; `business-admin.spec.js`,
  `combos-and-production.spec.js` and `preorders.spec.js` make what they work
  on, named for the screen and the moment, so a retry never meets what an
  earlier attempt made.
- **Open a business by its address** (`/business-admin/<id>/…`). Never through
  the header's business switcher or the business list's *Open* cards while
  signed in as the shared owner: that records the business as the one last
  opened (`POST /businesses/:id/open`), and every later spec that signs in as
  `RESTAURANT_ADMIN` lands in that business instead of on the restaurant's
  dashboard, for the rest of the run. The switcher is tried as `SHOP_MANAGER`
  (`business-admin.spec.js`), a login no other spec uses.
- **Call the API** inside `page.evaluate`, with `fixture().urls.api` and the
  page's own token (`localStorage.getItem("rmp_token")`), as
  `dashboard-panels.spec.js` does; or through the app's own API module by its
  `/src` address, which needs no address at all (`tasks.spec.js`).
- **Wait for what the page shows.** Signing in reaches the dashboard without
  loading a page, so `waitForLoadState("networkidle")` straight after
  `signIn()` may already be past. Wait for the element itself:
  `scroll-layout.spec.js` waits for the dashboard's live blocks to replace
  their placeholders.
- **Save files with `testInfo.outputPath(name)`**, which puts them in the
  test's own folder under `test-results/`.
- **Never wait for `networkidle`.** A live screen holds its live updates
  stream open for as long as it is shown, so Playwright's network idle never
  comes on one. Call `watchNetwork(page)` (`e2e/fixture.mjs`) before the page
  loads anything, then `await networkQuiet(page)`: half a second with nothing
  but the stream in flight.

**A screen on another device.** Live screens read again as soon as a change
commits, so a spec that shows one device's change on another opens a browser
context for each and waits a few seconds, not for a refresh. To show that only
live updates brought the change, set `rmp_live_poll_ms` in the context's
storage before its first page (an init script), which lengthens its screens'
safety net, as `live-updates.spec.js` does.

### Adding data

When a spec needs data the run does not make:

1. Name it in `e2e/test-data.mjs`, with the names and figures the spec will
   check.
2. Make it in `buildTestData` (`e2e/build-data.mjs`), through the API, as the
   person who would: `platform(…)` calls as the platform admin, `owner(…)`
   calls as the `RESTAURANT_ADMIN`. Each call names the status it expects, so
   the first wrong answer stops the set-up with the API's own message:

   ```js
   const category = await owner("POST", "/expenses/categories", { name: RESTAURANT.expenseCategory }, 201);
   ```

   Inside a business, `at(type)` gives its routes, as in
   `owner("POST", at("grocery")("contacts"), { kind: "supplier", name }, 201)`,
   and a shop document carries a fresh `requestKey()`.
3. Return what the specs need to find it (ids, numbers, codes) in the object
   `buildTestData` returns. That object becomes `test-results/e2e-fixture.json`,
   which `fixture()` reads.
4. Only what no request can make goes in by SQL, through `sql(text, values)`,
   which runs on the run's own database and nowhere else. Its one use is the
   table-5 order, moved two days back, because every order is placed at the
   moment it is taken.
5. Check the specs that count rows, then run the whole suite.
   `data-grid.spec.js` expects exactly `PLATFORM.restaurants` restaurants on
   the platform (raise it with every restaurant you add) and exactly the
   restaurant's outlets on *Outlets*.

A new login goes into `LOGINS` in `e2e/test-data.mjs` and is made in
`buildTestData` as people make one; the set-up then signs it in once, so it
chooses its own password like everyone whose password someone else set, and
the run's file keeps that one.

A new business type goes into `BUSINESSES` in `e2e/test-data.mjs`, and the
run then makes one; add it also to the lists of types in
`business-workspaces.spec.js` and in the unit test
`business-workspace.test.js`, and to `NAMES` in the integration helpers
([ARCHITECTURE › Add a new business type](ARCHITECTURE.md#82-add-a-new-business-type)).

### When a browser run goes wrong

| What you see | What to do |
| --- | --- |
| `Port 5110 is already in use. Is another browser test run still going, or one's API left over?` | Another run is going (let it finish), or another program holds the port (move the API's port, `E2E_API_PORT`). |
| `http://127.0.0.1:5183 is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.` (or 5184) | A program holds the port, usually the Vite servers of a run that was killed: see [After a run is killed](#after-a-run-is-killed). Leave `reuseExistingServer` alone: the tests must use servers of their own. |
| `The PostgreSQL user … may not create databases; give it CREATEDB …` | `ALTER ROLE <user> CREATEDB;` as a superuser. |
| `Set DB_HOST, … in backend/.env or the environment …` | The set-up cannot tell where PostgreSQL is. |
| `backend/.env runs the development API on port 5110 …` | Move the test API's port (`E2E_API_PORT`). |
| `… must be a port number from 1024 to 65535`, `… is a development server's port …` or `… must be three different ports` | Fix the port settings ([Ports](#ports)). |
| `Test data: POST /… answered 400, expected 201: …` | The data build met an answer it did not expect, usually after a change to the API or to its rules. The message is the API's own, and the request is in `test-results/e2e-api.log`. Change `build-data.mjs` to match the API, or fix the API. |
| `The test API did not start within 60 seconds …` or `The test API stopped while starting …` | Read `test-results/e2e-api.log`. |
| `No test data: run the browser tests with npm run test:browser …` | A spec was run another way, by an editor's plug-in or with another configuration. Run it through `npm run test:browser`, or point the tool at `e2e/playwright.config.mjs`. |
| Playwright cannot find the browser, or its executable does not exist | On Windows, install Microsoft Edge; elsewhere run `npx playwright install chromium`, or name an installed browser in `E2E_BROWSER_CHANNEL`. |
| A test fails | Read the error, its screenshot in the test's folder under `test-results/`, and `e2e-api.log` for the API's side. Run the spec alone, with `--headed` to watch it, or with `--repeat-each=10` to tell a timing problem from a real one. |

### After a run is killed

Ctrl+C stops a run cleanly. When a run is killed outright instead (its window
closed, its process ended):

- the test API stops by itself: it ends with the run that started it
  (`e2e/stop-with-run.mjs`);
- its database stays until the next run, whose set-up drops it;
- on Windows, the two Vite servers can outlive the run and keep 5183 and
  5184, and the next run stops at "is already used".

If nothing answers on 5110, no run is going, and whatever holds 5183 or 5184
is left over. In PowerShell, see what holds them:

```powershell
Get-NetTCPConnection -LocalPort 5183,5184 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" } |
  Select-Object ProcessId, CommandLine
```

Stop only a process whose command line is this configuration's Vite server,
ending in `vite.js" --port 5183 --strictPort --host 127.0.0.1` (or 5184), with
`Stop-Process -Id <ProcessId>`. On Linux or macOS,
`lsof -nP -iTCP:5183 -iTCP:5184 -sTCP:LISTEN` names the process; check its
command line with `ps -o command= -p <pid>` before `kill <pid>`.

## Receipt printing checks

`apps/business-web/tests/browser/printing.spec.js`, part of the browser
tests; on its own, `npm run test:browser -- printing`. It needs no login and
no data: it loads the staff app's receipt module
(`src/modules/restaurant/orders/services/receipt.js`) into the page and prints
made-up bills.

- A saved bill keeps the document settings it was saved with (a Bill of
  Supply, its declaration, its logo) after the restaurant changes them.
- At 58 mm, 80 mm and A4, a 40-line bill paid two ways fits the paper (on the
  rolls, within the paper's width less 8 mm), shows the dishes' names as plain
  text even when they hold markup, is marked DUPLICATE as a reprint, opens the
  print dialog once, and is cleared away after printing.
- Each size is saved as a PDF, `receipt-58mm.pdf`, `receipt-80mm.pdf` and
  `receipt-a4.pdf`, in that test's own folder under `test-results/` at the
  project root, to look at before a printer is chosen.

A real bill printed from the POS, over ₹2,00,000 and carrying the buyer's
PAN, is checked by `restaurant-cash-pan.spec.js`.

These are browser checks: no real bill is made or marked printed, and a PDF
says nothing about a printer's paper, its driver or a cash drawer. Those are
checked on the real equipment:
[GO_LIVE › Equipment acceptance](GO_LIVE.md#6-equipment-acceptance).

## Where an area's tests are

Integration tests are in `backend/tests/integration/`, browser specs in
`apps/business-web/tests/browser/` unless marked as the guests' site's.

| Area | Integration tests | Browser specs |
| --- | --- | --- |
| Starting the API | `server-start.test.js` (a port already in use is refused with a clear message; a free one starts) | — |
| Restaurant: from the order to the day's close, end to end | `restaurant.test.js` (with `service-readiness.cjs` and the [load test](#load-test)) | `screens.spec.js`, `combos-and-production.spec.js` (serving times, combo choices, production) |
| Restaurant: floor, service, kitchen and the live screens | `floor-and-service.test.js`, `front-of-house.test.js`, `service-deliveries-captains.test.js`, `kitchen-names.test.js`, `cutoff-window.test.js` | `floor-actions.spec.js`, `dashboard-panels.spec.js` |
| Restaurant: the captain app | `captain-workspace.test.js` (the food at the pass: only tickets marked ready, the longest waiting first, and reading it changes no ticket; who may read it, and in which outlet; a ticket served by the captain, once; a paid table and a cancelled order waited on no more; captain sections named only while the part is switched on, the day's plan kept while it is off; the pass refused with the kitchen display off), and the unit test `captain-floor.test.js` | `captain.spec.js` |
| Restaurant: bills, payments, GST and branches | `billing-payments.test.js`, `billing-gst-accounts.test.js`, `restaurant-money-paths.test.js`, `branch-reports.test.js`, `restaurant-cash-limit-pan.test.js` | `printing.spec.js`, `restaurant-cash-pan.spec.js` |
| Restaurant: cash, the day's close, reports and the dashboard | `cash-drawers-and-loyalty.test.js`, `day-close-roles.test.js`, `reports-dayend.test.js`, `dashboard-panels.test.js` | `dashboard-panels.spec.js`, `ui-motion.spec.js`, `scroll-layout.spec.js` |
| Restaurant: stock, purchasing and imports | `restaurant-stock.test.js`, `stock-purchasing-imports.test.js`, `stock-cost-and-guest-privacy.test.js`, `restaurant-clock.test.js` (bills, orders, payments, a guest's birthday and the stock date on the restaurant's clock, never the server's) | `visual-density.spec.js` (reorder), `combos-and-production.spec.js` (production, batch write-off) |
| Restaurant: set-up, features and rules | `restaurant-setup.test.js`, `restaurant-features.test.js`, `restaurant-rule-settings.test.js` | `screens.spec.js`, `guest-book.spec.js` |
| Restaurant: staff, sign-in and approvals | `staff-and-sign-in.test.js`, `two-step-and-tied-approvals.test.js`, `payroll-expenses-guests.test.js` | `quick-access.spec.js`, `sign-in-return.spec.js` |
| A password someone else set, changed at the first sign-in (every business) | `password-must-change.test.js` (the database rule and its Down half, logins made before it unmarked; every way a password is set for someone marks it; the 403 on every router, however the session began, and the two routes open; the password rules, the given one refused, a wrong one counted; the mark cleared, other sessions ended and a fresh one given; a retry and two at once; two-step first; My profile never marked; the audit rows) | `password-must-change.spec.js` |
| Restaurant: guests, online ordering and booking | `online-ordering.test.js`, `online-booking.test.js`, `restaurant-pickup-advances.test.js`, `payroll-expenses-guests.test.js` (the guest book) | `guest-pages.spec.js` (the guests' site), `guest-redirect.spec.js`, `guest-book.spec.js`, `visual-density.spec.js` (guest insights) |
| Café, bakery and cloud kitchen; brands | `food-formats.test.js` (with pre-orders kept to the outlet of staff tied to one, the kitchen's read-only bake list, and an outlet with open pre-orders neither closed nor deleted), and the unit test `brandReport.test.js` | `preorders.spec.js` (booking, the bake list, the kitchen's view) |
| Business platform: set-up, roles, numbering, stock control and events | `business-foundation.test.js`, `business-foundation-edge-cases.test.js`, `business-admin.test.js`, `business-onboarding.test.js`, `business-bookings-overview.test.js` | `business-workspaces.spec.js`, `business-staff-access.spec.js`, `business-admin.spec.js` (the switcher, unsaved forms) |
| Shared core: prices, invoices, the counter, payments, money, branches and rules | `business-shared-commerce.test.js`, `business-counter-payments.test.js`, `business-payment-methods.test.js`, `business-workspace-money.test.js`, `business-multi-location.test.js`, `business-rules.test.js`, `cross-feature-money.test.js`, `business-shop-guards.test.js` (the database guards on expenses, cash checks and cashier shifts) | `business-counter.spec.js`, `business-admin.spec.js` (purchase, sale, collection, return, refund) |
| Retail: grocery, supermarket, books | `business-retail.test.js`, `business-retail-stock-books.test.js`, `business-retail-prices-departments.test.js` | `business-counter.spec.js`, `business-admin.spec.js` (the books shop) |
| Wholesale | `business-wholesale.test.js`, `business-wholesale-distribution.test.js`, `business-wholesale-purchasing.test.js` | `business-wholesale.spec.js` |
| Fashion and electronics | `business-fashion-electronics.test.js`, `business-fashion-electronics-sales-service.test.js` | `business-counter.spec.js` (their counters) |
| Salon & spa, meat and weight-based shops | `business-salon-weight.test.js`, `business-salon-weight-daily.test.js`, `business-salon-back-office.test.js` | `business-salon-weight.spec.js` |
| Pharmacy, clinic and lab | `business-health.test.js` | `business-workspaces.spec.js` (prescription sale, batches) |
| The clinic and lab workspaces | `clinic-lab-workspaces.test.js` (the Down half and Up again; a consultation's referral, written by the doctor and read only by clinical roles, a reason needing someone to refer to, kept as written once completed; the medicines the clinic has prescribed, the most used first, for doctors only; the token queue's server time; the lab's bench: open orders and today's approved at the branch in view, with their samples and tests and no result, out-of-range counts only for the lab and the doctors, nothing logged; what the front desk reads of the lab holding no out-of-range count or amendment reason; every change of a lab order, sample or result reaching the business's live stream at the order's location, and nobody else's), and the unit test `clinic-lab-workspaces.test.js` | `clinic-lab.spec.js` |
| The newer trades on the shared core (general store, hardware, seeds and fertilisers, optical, garage, jewellery, fuel station, gyms and coaching, laundry, rentals, lodging) | `business-foundation.test.js` (what each starts with: units, slabs, modules), `business-shared-commerce.test.js` (goods-shop settings, and the staff app's goods list matching the server's) | `business-workspaces.spec.js` |
| Quotations and the hardware shop | `business-hardware.test.js` (quotations priced as a sale of the same lines, to the paisa; revisions; expiry; the bill at the quoted prices, split over batches; a sales order; the database's rules on quotations; sites and their ledgers; fitters' commission to the paisa by the most specific rule, kept with the bill, taken back by returns in parts, and paid through the expense book within what is due; today's rates saved together through the catalogue, all or none, never over a newer rate; the calculators' figures on the items) and `hardware-calculators.test.js` (the calculators' arithmetic) | `business-hardware.spec.js` (a quotation made, printed, sent on WhatsApp and billed; a bill to a site; a painter's bill, statement and payout; the rate board; the tile and paint calculators) |
| Licences and the seeds, fertilisers & pesticides shop | `business-agri.test.js` (the modules, permissions and role grants per type; the molecule list, only cited entries, each with its source; licences per location, renewed or switched off and never deleted, and the bell before one runs out; items classified as farm inputs, a banned molecule refused when saved and by the database; a fertiliser, seed or pesticide billed only under a licence in force at the selling branch, and freely with the tool off; banned and crop-restricted molecules at the counter; seed lots sold only while valid, and received with their validity; subsidised urea with its PoS receipt and the day's PoS stock reconciled, retries giving the same entry; farmers by village, dues and season credit to the paisa; the board, the seed stock return and the insecticide register from the bills and stock movements; the rules the database repeats; another type, and the tool off; a quotation's bill with the PoS receipt and the crop) | `business-agri.spec.js` (the PoS receipt at Quick bill and on the invoice; a crop-restricted pesticide; a banned molecule on the item form; licences, farmers, village dues, the board, the seed return, molecules and the PoS stock) |
| The optical shop | `business-optical.test.js` (the modules, permissions and role grants per type, with the optometrist's own role and no money; the powers' steps and ranges the database keeps; prescriptions per eye and vision, the examiner, the PD, a year's validity, corrections until an order uses one, retries giving the same prescription; spectacle orders priced by the core as a sale of their lines, to the paisa, with an advance as a collection receipt; the lab, the workshop and the quality check, which only an approver passes or fails; delivery posting the bill at the booked prices with the advance paid first, retries giving the same bill and other data refused; a cancelled order's advance handed back with a manager's PIN; remakes at no cost to the customer, or at theirs; GST at the rate of the delivery day; an item out of stock stopping delivery; the overdue chips and the bell; the recall list by the shop's months, with reminders; the contact-lens power grid with Variants on; another type, and the tool off; the audit log and events) | `business-optical.spec.js` (a prescription typed per eye and the history side by side; an order booked with an advance, through the lab and the quality check, its job card, delivered with its bill; the recall list and its WhatsApp reminder; a contact lens's power grid on the item form) |
| The garage | `business-garage.test.js` (the modules, permissions and role grants per type, with the mechanic's own role and no money; the database's rules on vehicles, readings, job cards, lines, claims, versions and approvals; vehicles by their plate however typed, one per number and chassis number, owners kept, the odometer log and a manager's approval of a lower reading, with the approvers to choose from; job cards opened with the reading in, complaints, mechanics and an advance; the estimate priced as a sale of its lines, to the paisa, in versions, with a discount needing its permission and identical saves making no version; the owner's approval, revisions and parts used above it going back to the owner; a mechanic seeing only their own job cards and no money; billing one bill at the job card's prices with the advance paid first, stock out and the next service set, retries giving the same bill and other data refused; a cashless claim billed as two bills, the insurer's exactly the approved amount and the two adding up to the job to the paisa, with its refusals until the claim is complete and amounts left out kept; a reimbursement claim billed to the owner, and a claim taken off; a cancelled job card's advance handed back with a manager's PIN; the service-due list by date, by projected reading, and insurance and PUC, with reminders and the settings; a customer's statement per vehicle, without money for a role that sees none; the bell, the lists, another type and another owner; a job card with nothing on it delivered by the desk with no bill, not by its mechanic; the audit log and events) | `business-garage.spec.js` (a job card from the plate through the estimate, the owner's approval, the work and both copies to its bill; the vehicles list and a vehicle's page; the service-due list and its WhatsApp reminder; the garage's settings and the claim-share item) |
| Gyms, studios & coaching | `business-memberships.test.js` (the module, permissions and role grants per type, with the trainer's own role and no money; the database's rules on plans and their policy versions, memberships, freezes, check-ins, instalments and the bill lines that sold a membership; plans made with their own service item at 5% or with an existing one at 18%, a joining fee, freeze limits, a policy changed into a new version; a plan's item refused on any other bill; a sale to a new member with a member code and the joining fee, the terms kept as sold, retries giving the same membership and other data refused, renewals starting after the end and no overlaps; a cancellation's pro-rata credit note and refund to the paisa by days, by sessions and by the smaller for sessions within a time, with a manager's PIN, a credit lowering what is owed on a part-paid bill, and none given back without a PIN; an upgrade's credit note paying the new bill first, to the paisa, and a credit bigger than the new bill refused; freezes within the plan's limits, called off and ended early, and a transfer only of a paid bill on a plan that allows it, giving nothing back later; check-ins by code or search, one session a day off a pack, grace days, not started, over, frozen and fees overdue by more than the business's days, with the trainer seeing no money; instalments adding up to the bill, covered in order by a collection, overdue and counted at the desk; the members list, renewal calls with reminders, codes changed, the bell; other types and other owners; the audit log and events) | `business-memberships.spec.js` (a member let in by the code on their card, turned away while frozen and back; a plan with its own item and a new member sold it; the renewal calls, a WhatsApp reminder and a renewal sold from the row) |
| Laundry & dry cleaning | `business-laundry.test.js` (the module, permissions and role grants per type, the presser's stock-keeper role seeing no money; the database's rules on services, garments, orders, garments' steps, tags in the shop, handovers, history, notices, claims and the bill lines that charge a garment; services made as their own service item at 18% with the SAC or from an existing one, garments by the piece, pair or set, prices for each one or by the kilo, the order settings; taking in priced to the paisa with the express surcharge and GST, by the kilo too, the next tags or typed ones, what was noted kept, an advance as a collection receipt, retries giving the same order and other data refused; the work, a ready garment sent back only with a reason, racks; a handover billed at delivery with the advance paid first and the bill lines naming garment and tag, the whole order held until paid; cancelling before the bill and the advance handed back with a manager's PIN; billed at intake with each handover paying for its garments, held until paid, a customer's account, a cancelled garment's credit note and refund; GST at the rate of the day; damage claims within the garment's charge, money back with a PIN, a credit note, reprocessing a delivered garment, a rejection; the racks, the search by tag, phone or order, the unclaimed list on the business's date with the reminders sent, the bell, re-tagging and the promised day; a core return of a garment's line refused; other types and other owners; the audit log and events) | `business-laundry.spec.js` (an order taken in at the counter with express priced to the paisa, its receipt and tags printed; the work, a rack, the search and the handover with its bill; the price list, the order settings and the unclaimed list's hold note) |
| Jewellery & gold | `business-jewellery.test.js` (the module and serial numbers on for a jeweller, its permissions and role grants per type, the Karigar role and no other type's having it; rate sheets set by a manager for the business's date, retries giving the same sheet and other data refused, a correction as a new sheet, the latest of the day in use for each purity; the database keeping sheets and rates as set; who sees and sets the rates, the karigar seeing none; jewellery items made or joined as goods in pieces with serial numbers at 3%, any other refused; pieces tagged into stock as a stock correction at their cost or on a unit bought in with its number, weights to the milligram, the price at today's rate to the paisa, stones and HUIDs, retries giving the same piece and other data refused, tags and HUIDs one each, the words for a man-made diamond; the karigar tagging units in stock with the item's charges and seeing no money; on approval, the karigar and back, changes kept with what they were, melting into the shop's metal at its fine weight; the database's rules on items, pieces, HUIDs, stones, history and the metal; a jewellery item refused on any other bill; each location's hallmarking district as the owner says and the turnover exemption, with the bell asking; a jewellery bill priced at the day's latest rate for each purity with wastage, making, stones and hallmarking and 3% GST, rounded to the rupee, to the paisa, posted through the core sale with the PAN on a bill over ₹2,00,000 and the cash limit, retries giving the same bill and other data refused, the sale's lines in BIS's words and the invoice's BIS details and statement; the HUID check by weight, metal, the article's exemption, the turnover and the district, and the database's own check; a walk-in paying in full, pieces out, unknown or without a rate refused; a piece taken back on the bill's credit note only back to stock, and billed again; bills kept as billed; old gold valued at the day's buy rate by the fineness found less the deduction, to the paisa and rounded as the bills are, with the photo ID (four digits of an Aadhaar number), the PAN over ₹2,00,000 and the seller's declaration, retries giving the same voucher and other data refused, its metal into the shop's own, a purity with no buy rate refused; payouts in cash, by UPI and bank, cash of ₹2,00,000 or more to a seller in a day refused, the shop's own lower limit, each in the expense book and never reversed; old gold paying the seller's own jewellery bill first as a payment by old gold, the money the rest, another customer's bill refused; such a bill returned, money back only as far as money was paid and the old gold put back on its voucher, then paid out; cancelling while nothing is paid out or used, its metal back out; the database's rules on vouchers, lines, uses, payouts and cash; who sees and handles old gold, and the bell; gold scheme plans up to 11 instalments with a discount never called interest and terms kept; joining a scheme with its terms, nominee and first instalment as a collection receipt, the maturity and the day-364 close, retries, each instalment one at a time until all are paid, cash into one scheme under ₹2,00,000; a matured scheme redeemed on its member's jewellery bill, all its receipts paying it and its discount off the pieces before GST, to the paisa, a bill smaller than the scheme refused, a redeemed scheme taking nothing more; a scheme stopped with a manager's approval, with no discount, its receipts never refunded or put on another bill, and on a returned bill money going back only as far as money was paid, its credit paying the customer's next jewellery bill; the money held for schemes; receivables' apply advance leaving a scheme's receipts alone; the bell past the close day; the cash report: each customer's cash in and out in the month to today, customers sharing a PAN as one person, the flag at ₹10 lakh and the shop's own alert level, walk-ins' cash apart, one person's transactions, the monthly worksheet with its due day, the bell, the reporting entity, and who sees it; other types and other owners; the audit log and events) | `business-jewellery.spec.js` (today's rates set and the rate board; a piece tagged with its HUID and its tag label printed without a price; the jewellery bill's price build-up, a piece with no HUID refused, the bill posted and its invoice's BIS lines and statement; old gold and a gold scheme paying bills) |
| Rentals & hire | `business-rentals.test.js` (the module, permissions and role grants per type, other types refused; the database's rules on items, units, bookings, lines, receipts, returns, charges and history; rental items as their own service items or existing ones, one by one with units or from a pool, rates, rules and the settings; the best price of the rates to the paisa; bookings priced and checked against what is free, a double booking refused, three bookings of the same unit at once giving one booking and two refusals; changes and extensions priced again at the booked rates, cancelling with a charge billed and paid from an advance and the rest handed back with a PIN; the handover with the photo ID (four digits of an Aadhaar), a self-drive vehicle's driving licence (refused once run out) and the location's licence, meters and fuel, the deposit or less with a manager's say-so; the board, lists, the bell and the week on the business's clock; a return late by the hour with a damage charge billed, the advance and deposit paying it and the rest handed back, retries giving the same return; a pool returned in parts with pieces missing; the deposits held; the audit log and events) and the unit test `rentalsMoney.test.js` (hours charged, the best price, late fees, the bill's figures) | `business-rentals.spec.js` (the board, a double booking refused and a booking made; the handover with the ID, conditions, meter and deposit; a return a day late with a damage charge, the bill paid from the deposit and the rest handed back; the deposits held, what is due back, the week and the rental items) |
| Fuel stations | `business-fuel.test.js` (the module, permissions and role grants per type, the pump attendant role, other types and owners refused; the database's rules on fuels, tanks, units, nozzles, prices, shifts, closes, dips and loads; fuels on the GST nil slab and refused on other bills and purchases, tanks with their opening stock, units, nozzles, measures, prices and the tolerances, the PESO licence's standing; fleet vehicles; a shift opened from the totalisers and closed with the test, credit slips, takings and cash, posted as a walk-in fuel bill and a customer's fuel bill exact to the paisa with no round-off, a short left due; a fill over its limit allowed by a manager only; a price change while a shift was open; retries giving the same shift and close; a manager's reopening crediting the bills and handing back the takings, refused once the next shift opened; a walk-in bill above ₹2,00,000 in cash; tanker loads within and outside the density tolerance, refused, accepted by a manager, decanted and cancelled; the morning dips, a corrected dip, the stock register's variation against the tolerance and the density register; the fleet statement with the account; the bell; the audit log and events) and the unit test `fuelMoney.test.js` (litres at the price to the paisa, a nozzle's sale less the test, a shift's money and the attendant's short or excess, the stock register against the tolerance, a load's density and dips) | `business-fuel.spec.js` (a shift opened and closed by the pump attendant, short; a tanker load's density check and dips; the day's stock register flagged beyond the tolerance; a fleet customer's credit fill and their statement) |
| Hotels, lodges & guest houses | `business-lodging.test.js` (the module, permissions and role grants per type, the front desk and housekeeping roles; other types and other owners kept out; the two GST slabs set before anything is reserved or billed; room types as service items counted in nights, with their rates and rooms; a reservation priced night by night, each night at the slab its own value decides; a room never booked twice over a night nor a room type over its rooms, two reservations saved at once giving one and a refusal, and the database's exclusion constraint and capacity check; the check-in to a vacant clean room with every occupant, an Aadhaar only by its last four digits, a foreigner's passport and visa; Form-III's countdowns and marks; the night audit posting each night once, two audits at once posting nothing twice, and the database refusing a night at the wrong rate or slab; extras at their own slabs and a void by a manager; the check-out billing the folio through the core with the advance first, the room left to be made up and marked clean; a company billed with its GSTIN and the property's state as the place of supply, and a guest's own bill paid in full unless a manager agrees; a cancellation charge at the first night's slab paid from the advance, the rest handed back with a PIN, and a no-show; the guest register and who sees the IDs and the money; *apply advance* leaving a stay's receipts alone; the desk, the calendar, the bell, the audit log and events) and the unit test `lodgingMoney.test.js` (a stay's nights, weekend and agreed rates, a night's value with extra adults, children and beds, the slab at exactly ₹7,500 and above it, a stay crossing the limit at mixed slabs to the paisa, extras and the bill's figures) | `business-lodging.spec.js` (a reservation and the check-in with every occupant, the room booked for tonight refused; a foreign guest's Form-III countdown and its mark; the night audit at each night's slab and a check-out with the advance; housekeeping marking the room clean; the guest register printed) |
| The cash limit and PAN on large bills | `business-cash-limit-pan.test.js` (one bill, one customer's day across bills and collection receipts, a later payment, a row written straight to the database; PAN typed, saved with the customer, read from the GSTIN, or the declaration); `restaurant-cash-limit-pan.test.js` for a restaurant (one bill's cash with the cash tip; a guest's day across bills, cash advances and a payment from one counted once, walk-ins apart; an account's collection refused whole; a rider's cash on delivery; a pre-order booked without its refused advance; a correction to cash refused before any PIN; the day boundary on the restaurant's clock, a minute either side of its midnight; rows written straight to the database; the PAN refused, then typed with the payment, recorded on the bill, given when the bill is raised, read from the buyer's GSTIN, or the declaration, on each bill of a split, settled bills kept as paid; the printed figures; retries and the activity log) | `restaurant-cash-pan.spec.js` |
| GST rates by date (every business and the restaurant) | `gst-rates-by-date.test.js` (the Down half and Up again; the preview by slab, category, HSN and search, with what each item becomes to the paisa; scheduling, idempotent, refused for fuel, jewellery, room types, kits, a second change the same day, an item already at the rate and a price over its MRP; a slab or tax rate items move to kept on; the day before and the day of on each business's and restaurant's own clock, through the date helpers' time zones; cancelling whole or by item, refused from its date; the item's GST history and the audit; quotations and every type's fixed-price posting (laundry, optical, garage, gym, rentals, lodging, a wholesale dispatch) on the day before and the day of; a price that includes GST keeping its total or its part before GST, with member and branch prices and a kit's rate; a change the database refuses on its day; the postings refused around midnight; a restaurant's dishes, its orders and bills on its trading day, an outlet still on the day before, sizes, and a dish named in a change archived rather than deleted) | `gst-rates-by-date.spec.js` |
| Tasks, issues & projects | `tasks.test.js` | `tasks.spec.js` |
| Live updates (every business and the restaurant) | `live-updates.test.js` (the Down half and Up again; the stream opened with the `Authorization` header only, never a token in the address, for a restaurant or business the person belongs to; its headers, uncompressed; a change reaching the streams of its own restaurant within a moment and no other's; a bill paid announcing the bill, the order and the table; only committed changes, a rolled-back savepoint and a refused request announcing nothing, several changes to a row in one transaction once; a burst in commit order; an outlet or location tied login hearing only of theirs; a business's sale at its location, a repeated posting announcing nothing, a clinic token, a restaurant's own task; streams ended by signing out everywhere, a login switched off, a move to another location, a membership ended and a token run out; the limits per person and per process, and nothing kept once streams close; the keep-alive; the listening connection back after a drop with a resync; a second API process hearing the same changes and its kept dashboard answer cleared by them; every message with only where and what; stopping closes every stream and the connection) and the unit test `live-client.test.js` | `live-updates.spec.js` (POS and kitchen display; a table's QR call and table requests; two token queues at the clinic), `clinic-lab.spec.js` (the clinic's and the lab's workspaces) |
| Menus and the shared screen parts | the unit tests `menu-paths.test.js`, `business-workspace.test.js` and `shared.test.js` | `data-grid.spec.js`, `shared-components.spec.js`, `business-workspaces.spec.js` |

## Continuous integration

`.github/workflows/checks.yml` ("Project checks") runs on every push and every
pull request, on Ubuntu with Node.js 24 and a PostgreSQL 17 service. The
service's user is its superuser, so it may create databases. The job's
environment holds the database settings (`DB_HOST=localhost`, `DB_PORT=5432`,
`DB_USER`, `DB_PASSWORD`, and `DB_NAME=postgres`, which each test file
replaces with its own database) and `NODE_ENV=test`; there is no
`backend/.env`. The steps, in order:

1. `npm ci` in `backend`;
2. `npm test` in `backend`: the backend's unit tests;
3. `npm run test:integration` in `backend`;
4. `npm ci` at the root;
5. `npm run lint`;
6. `npm test --workspaces --if-present`: the staff app's and `@bmp/shared`'s
   unit tests;
7. `npm run build`, with `VITE_API_BASE_URL=/api` and
   `VITE_CUSTOMER_WEB_URL=same-origin`: both apps built as one domain serves
   them.

A failing step stops the job. CI does not run the browser tests or the load
test: run `npm run test:browser` yourself when a change touches screens.
