# Verification and rollout status

> 6 October update: the project now includes a multi-business admin increment.
> See [its implementation, database model, tests and remaining scope](MULTI_BUSINESS_ADMIN.md).
> The development database has 71 migrations applied. The existing integration
> regression run passed 145 tests; the subsequently expanded business-specific
> suite passed 16 tests including desktop/mobile browser workflows and membership
> revocation. Unit tests (28), frontend lint and production build passed.
> The existing authenticated-screen sweep also passed at 1440px and 390px
> against the task preview (2 tests, 3.1 minutes). Its layout assertion now
> recognizes the standalone business workspace and collection display.
> The historical restaurant-only counts below have not been rewritten as claims
> about the new business modules. All twelve industries are not yet complete.

Updated 30 September 2026. This describes tested software behaviour, not a
guarantee that every restaurant process or accounting edge case is covered.
The original audit is historical; see [backlog reconciliation](REMAINING_BACKLOG.md).

## Completed local scope

- Outlet/service/channel prices and packaging charges; saved prices survive menu edits.
- Per-outlet business days, cash drawers, order/invoice series, reports and expense entry.
- Required add-on groups and configurable choice combos in POS and QR ordering.
  Choices survive staff acceptance, additions to an existing table, billing and stock consumption.
- Weekday serving schedules, including overnight periods, and outlet-specific daily sold-out lists.
- Hold/fire courses. Held dishes stay off mixed kitchen tickets; firing creates fresh kitchen work.
- Per-item inclusive/exclusive/MRP pricing, split opening hours, receipt logos and Bill of Supply.
  New bills retain their document settings for reprints; composition orders suppress GST and cess.
- Add-on recipes, prepared-item recipes, production batches and weighted costs.
  Production rejects cycles, insufficient stock, invalid expiry, duplicate batch numbers and
  conflicting retries. An unused/unmoved batch can be reversed with its original quantities and costs.
- Expiry-aware stock allocation and targeted batch wastage. Unknown expiry remains usable.
- Cooked cancellation wastage, including add-ons; new kitchen portions are excluded.
  Bill voids restore original recorded consumption after recipes have changed.
- Desktop/mobile configuration, POS selection, production and batch-wastage interfaces.
  The row-action menu remains inside the viewport and supports scrolling and keyboard focus.

## Repeatable checks

From the repository root:

```powershell
npm.cmd test --prefix backend
npm.cmd run test:integration --prefix backend
npm.cmd run lint --prefix frontend
npm.cmd run build --prefix frontend
```

Unit tests do not use a database. Integration tests read connection settings from
the backend environment, create a unique `rmp_test_*` database, install all 47
migrations and remove that database on completion. They never seed or clear the
working database. The test database account needs database-creation permission.

The acceptance checks include 28 unit checks and 37 API scenarios. The optional
browser workflow adds two scenarios, for 1440px/light and 390px/dark screens.
Node reports 38 tests for the final API run (including its parent), with the two
isolated browser scenarios verified separately. Coverage includes permissions/tenant isolation, purchasing and
reversal, payroll protections, delivery progression, stock/batch reconciliation,
loyalty, refunds/credit notes, balanced accounting and the local features above.

Frontend lint and production build passed. Syntax validation passed for all 221
backend source/script/test files. All 47 migrations are applied to development,
and the final database check found no remaining test or restore databases.

With the frontend development server running, exercise real browser writes in
the disposable integration database:

```powershell
$env:RMP_BROWSER_TESTS = '1'
npm.cmd run test:integration --prefix backend
Remove-Item Env:RMP_BROWSER_TESTS
```

Every API request from these browser scenarios is forwarded to the isolated
server. Screenshots are under `backend/.local/readiness-ui`. Windows uses installed
Edge; other platforms need Playwright Chromium. Optional `E2E_BASE_URL` defaults
to `http://localhost:5173`. This is separate from the working-database screen sweep:

```powershell
$env:E2E_CREDENTIALS_FILE = 'C:\full\path\backend\.local\demo-logins-EXAMPLE.json'
npm.cmd run test:browser --prefix frontend
```

All six screen/receipt browser tests passed. The screen sweep reads all authenticated routes at desktop/mobile widths and
opens the configuration dialogs. It does not post orders or stock movements.
The print tests check 58 mm, 80 mm and A4 layout, escaping, duplicate marking,
cleanup and saved receipt settings. These are browser tests, not hardware tests.
Failure screenshots/PDFs and local credentials are ignored by Git.

## Shared UI and motion checks

The shared UI now includes short entrance transitions, hover/pressed feedback,
navigation/menu motion, tinted metric cards and dashboard loading skeletons.
Charts reveal when they enter the viewport. Trend charts show exact values with
mouse, touch and keyboard controls; updated figures are never counted up through
invented intermediate amounts. Device reduced-motion settings disable animation
and preserve the controls and their focus/selection states.

The desktop and mobile authenticated-route sweeps passed after these changes.
Three additional browser checks cover chart inspection, reduced-motion menus and
dialogs, and a delayed dashboard response that keeps existing figures visible
during refresh. All passed (the reduced-motion check was rerun after fixing an
ambiguous test locator). Ten visual previews cover dashboard, POS, reports,
reservations and inventory at 1440px/light and 390px/dark, with no browser errors
or document overflow. Frontend lint and production build also passed.

Run `frontend/tests/browser/ui-motion.spec.js` with the same local credentials
and browser setup above. Preview images and run logs are under
`backend/.local/ui-motion-preview` and `backend/.local/ui-motion-checks.log`;
the reduced-motion rerun is in `backend/.local/ui-reduced-motion-check.log`.

Sidebar Quick access was checked separately in `quick-access.spec.js`: five-page
limit, reorder/remove/clear, Cancel, saved order after reload, separate owner and
kitchen preferences, permission filtering of stored paths, keyboard focus, and
mobile/short-screen navigation. All three scenarios passed. Preferences are local
to the restaurant/user in this browser and do not sync between devices. The main
menu remains available below the shortcuts. The run log is
`backend/.local/quick-access-checks.log`.

The extra blank area below the dashboard was reproduced as a second document
scrollbar: a 900px viewport had 1,789px of document height because hidden chart
instructions were positioned outside the content scroller. Positioning that
scroller keeps its descendants inside it without hiding the document or clipping
the last cards. `scroll-layout.spec.js` passed at 1920×900, 1440×900, 390×844 and
740×390 for dashboard and reports, including bottom-card reachability, a stationary
header and the shortcut dialog after scrolling. Lint and build passed. The run log
is `backend/.local/scroll-layout-checks.log`.

## UI refresh — 1 October 2026

The shared UI uses teal actions and a coordinated module palette: blue sales,
warm kitchen/menu accents, green inventory, violet staff/reservations, rose
customers and indigo reports/settings. Page headers, navigation, saved shortcuts
and section headings share the route's accent. The sidebar uses a neutral navy
surface; metrics and category bars carry their own labelled colours. Dashboard
sales lead the other metrics, alerts form balanced rows,
and users with `orders.create` get a New order link while the day is open. The
POS, reports, lists, forms, sign-in and guest menu share the new palette. Named
orange kitchen/channel colours and the waste-reason chart retain their separate
colour token; warning and error meanings are preserved.

All 16 browser checks passed, including every authenticated route at 1440px and
390px, shortcut permissions and persistence, four viewport scrolling checks,
keyboard/touch charts, reduced motion, loading states and receipt layouts.
Lint and the production build passed. Local evidence is in
`backend/.local/colour-ui-checks.log` and `backend/.local/colour-ui-build.log`.
Desktop/mobile and light/dark previews were visually inspected. The primary,
secondary text and placeholder colours were checked against their shared surfaces.
The nine module accent/text pairs have sampled minimum contrast ratios of 4.69:1
in light mode and 5.74:1 in dark mode. POS action footers remain within the screen
at 1440px, 768px and 640px widths. This is not a full accessibility audit. The
existing deferred integration and physical-device scope remains below.

The follow-up readability pass increases sidebar and secondary label sizes,
widens the desktop content area, and replaces strong decorative outlines and
gradients with quieter module tints. The dashboard greeting is more compact.
Its trading figures explicitly use the open business date, including the year;
an older open day is no longer labelled as today's sales. Live service remains
separate from the dated trading summary. Attention categories and restaurant
alert totals have separate labels, with an explanation that the bell counts
unread alerts.

All 16 browser checks passed again (3.4 minutes), and lint and the production
build passed. Desktop, mobile and dark dashboard previews were inspected, as
were wide-screen POS and reports. The dashboard, reports and POS had no outer
document overflow at 1920px. Two additional browser scenarios verified an older
business date and a restaurant date ahead of the device date around midnight;
sales amounts stayed unchanged, and total/read alert counts remained distinct.
Evidence is in `backend/.local/polish-ui-checks.log`,
`backend/.local/polish-ui-build.log`, and
`backend/.local/polish-date-alert-checks.json`. The date/alert scenarios used
intercepted read responses and did not change restaurant records.

## Load and recovery evidence

A two-minute run with four concurrent workers completed 1,983 order/bill/payment
flows with 1,983 unique bill numbers. Complete-flow p95 was 417 ms; maximum was
1,272 ms. It ended with no unsettled bills and a balanced day book. This measures
a simple synthetic workload on this development PC; it is not production capacity
certification. Reproduce with `RMP_LOAD_SECONDS=120` on the integration command.

A database/upload backup was created and its database archive restored into a
separate temporary database before the service-readiness migration. Use:

```powershell
npm.cmd run db:backup --prefix backend -- --verify
```

Backups and their manifests live under `backend/.local/backups`. A local copy
does not protect against disk loss. Production backup consistency and external
backup storage remain rollout responsibilities. If a test is forcibly interrupted,
inspect any temporary database before deleting it.

## Deferred scope

Payment gateways, messaging providers, aggregator connections and hosting are
deferred. Existing development login remains; additional authentication work is
deferred. Direct thermal-printer/cash-drawer integration and physical testing need
the actual equipment. No real restaurant pilot has been conducted.

Unknown expiry dates and legacy cost history cannot be reconstructed from missing
records. Staff must reconcile physical stock and batches. The existing purchase
cost/backdating rules and accountant review still apply; these checks are not a
tax-filing certification. See [pilot checklist](PILOT_CHECKLIST.md) and
[admin guide](ADMIN_GUIDE.md) for operational use.
