# Restaurant pilot and equipment acceptance

Prepared 30 September 2026. No printer or cash drawer is currently available.
No real restaurant pilot has been conducted. External integrations remain deferred.

## Local software evidence

The isolated API suite creates its own random database, installs all migrations,
and deletes it after the run. It does not load-test the working restaurant.
The two-minute run on this development PC used four concurrent workers:

| Measure | Observed result |
| --- | --- |
| Complete order, bill and cash payment flows | 1,983 |
| Distinct bill numbers | 1,983 |
| Elapsed load time | 120.289 seconds |
| End-to-end flow 95th percentile | 417 ms |
| Slowest flow | 1,272 ms |
| Unsettled bills / unbalanced vouchers | 0 / 0 |

These results cover a simple takeaway dish, local HTTP and a local PostgreSQL
server. They do not establish production capacity, thermal output, Wi-Fi
resilience, long-shift stability, or performance with years of data.

To repeat from `backend` (development PostgreSQL account with CREATE DATABASE):

```powershell
$env:RMP_LOAD_SECONDS = '120'
npm.cmd run test:integration
Remove-Item Env:RMP_LOAD_SECONDS
```

The harness caps the duration at five minutes. Four workers create, bill and pay
orders, periodically read the kitchen board, and verify numbering, settlement,
batch reconciliation and the day book. Failed assertions fail the run.

Browser-only receipt checks passed for 58 mm, 80 mm and A4: printable-width fit,
40 item lines, escaped names, duplicate label, one print invocation and cleanup.
They found and fixed a stylesheet rule overriding the receipt width. PDFs are
saved in `backend/.local/print-previews/`. These are synthetic fixture receipts;
no real invoice was created or marked printed by this test.

## Equipment acceptance: pending hardware

Record printer make/model, driver, paper width, connection and drawer model.
The app currently uses the browser print dialog. It does not implement a silent
ESC/POS bridge or cash-drawer pulse. Selecting a physical printer is insufficient
to prove either capability.

| Check | Pass criterion | Result |
| --- | --- | --- |
| 58 mm / 80 mm receipt | Names, amounts and footer fit; no clipping or blank first page | Pending |
| Long receipt | 40 lines, long names, add-ons and split payments are legible | Pending |
| Tax / discounts / rounding | Printed figures match the saved bill exactly | Pending |
| Reprint | Same invoice number, duplicate marking, correct print count | Pending |
| Cancel dialog | App remains usable; no unintended additional payment | Pending |
| Kitchen ticket | Correct station, quantity, notes and cancellation details | Pending |
| Disconnect / reconnect | Clear operator recovery; no lost or double bill | Pending |
| Drawer | Supported bridge, permissions and pulse verified with real hardware | Not implemented |

Use the printer driver's test page first, then the app receipt. Keep the paper
samples with the test date. Browser print success does not confirm paper output;
the saved print count records an attempt, not a printer acknowledgement.

## Staff pilot: pending real service

Use a separate restaurant/database for training, with named staff accounts and
the restaurant's real menu, opening stock and expected prices. A demo run does
not count as a real-service sign-off. Take a verified backup before the pilot.

1. Owner verifies outlet, menu, recipe, tax settings and role permissions.
2. Manager opens the day with counted cash. Captain takes dine-in, takeaway and
   delivery orders; kitchen acknowledges and completes them.
3. Change quantities, add a round, split payments, void an unpaid bill and refund
   a paid bill. Confirm approvals and activity-log entries with both staff roles.
4. Receive a purchase with batch/expiry, transfer stock, count a shelf, and record
   actual expired goods as wastage. Match physical batch picking to FEFO allocation.
5. Dispatch a delivery with a rider; test rejection before packing and without a
   rider. Check returned food and outstanding payment handling.
6. Record attendance, bonus/advance and a payroll payment. Check the paid period
   cannot be paid twice or edited silently.
7. Finish the shift: settle pending bills, compare physical cash and all payment
   totals, reconcile stock, inspect GST/P&L/day-book exports, close the day.
8. Repeat for two busy shifts. Include a second till, connection loss and restart.

Record each problem with timestamp, role, screen, record number, expected and
actual result. Do not include passwords or tokens. Sign-off requires the owner,
cashier and kitchen lead to approve the reconciled results and resolve any lost
orders, duplicate payments, incorrect prices, stock or permission defects.
