# Notifications

For backend developers who add alerts to the restaurant's bell: how the bell
works out its alerts, and the contract a module's provider follows.

The bell in the top bar shows what needs a person at this moment, across every
module of the restaurant. It is **derived**, not stored: each alert is worked
out from live data when the bell asks, so it can never say "3 unpaid bills"
after they were paid.

What *is* stored is who has seen what, so a read alert stays read until the
thing it describes changes.

The Business Admin bell of the other business types is also derived from live
data, by a service of its own that does not use these providers:
`src/modules/business/core/services/businessNotifications.service.js`.

## How a module adds alerts

Drop one file into `providers/`. The notification service reads that folder on
every call, so no shared file has to be edited to add a module's alerts, and a
file that is removed stops being asked.

```js
// backend/src/notifications/providers/<module>.js
module.exports = {
  // Unique. Also the prefix of every alert id this provider makes.
  key: "reservations",

  // The user must hold this permission to see any of these alerts (or every
  // one of a list of codes). null = anyone signed in to the restaurant.
  permission: "reservations.view",

  // Optional: the restaurant feature these alerts belong to (a code, or a
  // list of which any one will do). While it is switched off in Settings ->
  // Features the provider is not asked at all.
  feature: "reservations",

  // Optional: the area's name in the bell's list of what it watches. Left
  // out, a built-in name for the key, or the key spaced out.
  label: "Reservations",

  // Optional: seconds this provider's answer may be shared by everyone in
  // the same restaurant, outlet and day (max 300). For slow back-office
  // checks only (stock, supplier bills, theft); leave it out for anything
  // about the live service. Without it, only callers asking at the same
  // moment share one run. require("..").invalidate(restaurantId) drops the
  // kept answers; marking alerts read always asks afresh.
  cacheSeconds: 30,

  // Everything needing attention for ONE restaurant, at this moment.
  // Must filter by restaurantId on every query — never trust anything else.
  collect: async ({ restaurantId, businessDate, timezone, now, pool }) => [
    {
      // Stable fingerprint: the same condition must produce the same id on
      // every call, and a NEW condition a new id. Read-state is keyed on it,
      // so include whatever makes the situation distinct (e.g. the row id,
      // plus the status or count that would make it worth re-reading). The
      // registry puts the provider's key in front when it is missing; at most
      // 200 characters.
      id: "reservations:arriving:123",

      severity: "critical" | "warning" | "info",
      title: "Table for 4 arriving at 7:30pm",   // short, specific
      detail: "Priya · T5 · booked by phone",    // optional second line
      link: "/reservations?date=2026-09-24",     // where the fix happens: a path in the app
      category: "Reservations",                  // groups the dropdown
      at: "2026-09-24T13:45:00.000Z",            // when it became true (ISO)
    },
  ],
};
```

An alert without a valid id, severity or title is dropped and logged. A `link`
that is not a path inside the app (it must start with a single `/`) is left off
the alert.

Arguments:

| | |
|---|---|
| `restaurantId` | the caller's restaurant, from the token |
| `businessDate` | the open business day as `YYYY-MM-DD`, or today if none is open |
| `timezone` | the restaurant's IANA timezone, e.g. `Asia/Kolkata` |
| `now` | a `Date`, so every provider in one call agrees on the time |
| `pool` | the shared `pg` pool (`require("../../config/database")`) |
| `today` | the restaurant's own calendar date as `YYYY-MM-DD` (differs from `businessDate` after midnight while a day is still open) |
| `currency` | the restaurant's currency symbol, e.g. `₹` |
| `money(n)` | `n` formatted the way the screens show money, e.g. `₹2,340` |
| `outletId` | the outlet the person is tied to, or `null` for someone who sees every outlet. Providers whose alerts belong to one outlet or store (stock expiry, supplier bills, transfers, purchase approvals, booking requests) show such a person only their own. |

A provider that is called with only some of these (from a test, say) can pass
what it got through `require("..").completeContext(context)` to get the rest,
worked out exactly as the registry does. The context is frozen: one provider
cannot change what the next one sees.

The registry adds `source` (the provider's `key`) to every alert it returns, so
the bell can group and filter by module. Providers don't set it.

### Summary alerts and `members`

A summary such as "6 more bills unpaid" stands for rows that come and go. If its
`id` changed with the count, every payment would bring it back unread. So a
summary keeps one stable id and lists the rows behind it:

```js
{
  id: "bills:unpaid:summary",
  severity: "warning",
  title: "6 more bills unpaid",
  members: ["bill:1042", "bill:1051", /* … */],   // ids of the rows behind it
  // …
}
```

The service remembers which members a person had seen when they read it, and the
summary turns unread again only when a member they have not seen joins it — not
when one is paid, fixed or approved. Put counts in `title`, never in `id`.

### One voice per situation

Two providers must not raise the same situation. Where two modules can see it,
one owns it:

| Situation | Owned by | The other one |
|---|---|---|
| An item is out of stock, or will run out within 2 days at current usage | `inventoryInsights` (it knows days of cover) | `stock` stays silent on these items |
| An item is at or below its reorder level but not about to run out | `stock` | — |

Rules:

- **Return `[]` when there is nothing to say.** An empty bell is the goal.
- **Be specific.** "2 items at or below reorder level" beats "Inventory alert".
- **Severity means something.** `critical` = money or a guest is waiting now;
  `warning` = will become a problem today; `info` = worth knowing.
- **Cheap queries only.** The bell polls; a provider must not scan history.
- **Keep the list short.** The bell takes a provider's first 100 alerts; past
  a handful, use a summary alert.
- **Never throw.** A provider that fails, or takes longer than four seconds,
  is skipped and logged, and the notifications page says it could not check
  that area rather than showing it as all clear. One broken module cannot empty
  everyone's bell — but do not rely on that.
