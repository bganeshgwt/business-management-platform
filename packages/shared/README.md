# @bmp/shared (packages/shared)

For developers of both web apps: the plain JavaScript they share (formats,
dates, menu choice rules), how it is tested, and what belongs in it.

Plain JavaScript both web apps use, with no React and no browser APIs, so a
Node test can import it too. Source only.

| Import | What it is |
| --- | --- |
| `@bmp/shared/format` | Money, numbers, dates and times as people read them (`money`, `moneyExact`, `count`, `dateShort` …; see below) |
| `@bmp/shared/dates` | Dates as the API wants them (`YYYY-MM-DD` in the local calendar, anchored to the open business day), the quick date ranges, month names, how long a table has sat (`elapsed`) |
| `@bmp/shared/menu/comboChoices` | The rules of a combo's choices (what is missing, what it adds to the price) |
| `@bmp/shared/menu/addonChoices` | The rules of a dish's add-on groups |
| `@bmp/shared/pageLoad` | A page whose code fails to load: `isFailedPageLoad(error)` (the browsers' and Vite's words for it) and `afterFailedLoad(storage, address)`, which says "reload" the first time for an address (remembering it in the tab's `sessionStorage`) and "message" when it already reloaded there in the last five minutes, or the tab cannot remember. `PageLoadBoundary` (`@bmp/ui`) uses them |

The server checks the same rules again; these are for the screens.

## The formats

The API sends plain numbers and ISO dates. `@bmp/shared/format` is the one
place that decides how they look on screen, so a figure or a date reads the
same everywhere.

| Function | Gives | For |
| --- | --- | --- |
| `money(n)` | ₹9,556, or ₹1,234.50 when there are paise | A headline figure |
| `moneyExact(n)` | ₹9,556.00: always two decimals | Bill lines, payments, tax: anything that ties out to the paisa |
| `moneyWhole(n)` | ₹14,27,790: whole rupees; a negative reads −₹1,906 | A row of tiles |
| `moneyShort(n)` | ₹1.18 Cr, ₹14.3 L; under a lakh, whole rupees | Tiles on a phone, with the exact figure in the tile's title |
| `count(n)` | 1,240 | Plain counts |
| `balanceText(n)` | Owes ₹2,000.00, Advance ₹1,905.55, Settled | A customer's or supplier's balance, never a bare minus |
| `amountInWords(n)` | Rupees One Lakh Twenty Three Thousand … and Fifty Paise Only | Tax invoices |
| `timeOnly`, `dateShort`, `dateLong`, `dateTime` | 8:29 pm; 6 Oct (the year only when it is not this year); Fri, 2 Oct 2026; 6 Oct, 8:29 pm | Times and dates |
| `durationMinutes(minutes)`, `duration(since)` | 40m, 1h 40m, 3 days; 1 h 40 min with `{ long: true }`; 26h 10m with `{ hours: true }` | How long something has taken |
| `relative(when)` | just now, 12 min ago, yesterday, then 6 Sep | When something happened |

The money functions take the currency symbol as a second argument (₹ when
left out). Every date helper takes a `Date`, a timestamp, an ISO moment or a
plain `YYYY-MM-DD` (read as that calendar day, not as midnight UTC), and gives
an empty string for anything empty or unreadable.

## Tests

`npm test` (here, or from the root) loads every module in Node by its package
name and checks a few of the formats (`tests/shared.test.js`), and the rule
for a page whose code fails to load (`tests/pageLoad.test.js`).

## What belongs here

A function both apps use. Inside the package, import siblings by relative path
with the extension (`./dates.js`).
