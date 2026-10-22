# @bmp/shared (packages/shared)

Plain JavaScript both web apps use, with no React and no browser APIs, so a
Node test can import it too. Source only.

| Import | What it is |
| --- | --- |
| `@bmp/shared/format` | Money, numbers, dates and times as people read them (`money`, `moneyExact`, `count`, `dateShort` …) |
| `@bmp/shared/dates` | Dates as the API wants them (`YYYY-MM-DD` in the local calendar, anchored to the open business day), the quick date ranges, month names |
| `@bmp/shared/menu/comboChoices` | The rules of a combo's choices (what is missing, what it adds to the price) |
| `@bmp/shared/menu/addonChoices` | The rules of a dish's add-on groups |

The server checks the same rules again; these are for the screens.

`npm test` (here, or from the root) loads every module in Node by its package
name and checks a few of the formats (`tests/shared.test.js`).

**What belongs here:** a function both apps use. Inside the package, import
siblings by relative path with the extension (`./dates.js`).
