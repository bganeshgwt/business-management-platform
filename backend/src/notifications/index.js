// The notification registry: finds every provider, runs the ones this person
// may see, and hands back one clean list. See README.md for the contract a
// provider follows.
//
// Three promises it keeps, because the bell sits on every screen:
//
// 1. Adding a module's alerts never means editing a shared file. The folder is
//    read on every call, so a provider dropped into providers/ is picked up on
//    the next poll and one that is removed stops being asked.
// 2. One broken module cannot empty the bell. Each provider runs on its own,
//    in parallel, with a time limit; one that throws, hangs or returns rubbish
//    is skipped, logged, and reported back as "could not check".
// 3. Nobody sees an alert from a module they cannot open. The permission check
//    happens here, before a provider runs, so its queries are never made for
//    someone who has no business with the answer.
//
// Besides the documented context (restaurantId, businessDate, timezone, now,
// pool) every provider also receives:
//   today     the restaurant's calendar date as YYYY-MM-DD, on its own clock
//   currency  the restaurant's currency symbol, e.g. "₹"
//   money(n)  n formatted the way the screens show money: "₹2,340"
// A provider called with only the documented fields (from a test, or by code
// that has read nothing but the README) passes what it got through
// completeContext() below and gets the same extras, worked out the same way.
//
// Summary alerts. "6 more bills unpaid" stands for rows that come and go; if
// its id changed with them, every payment would bring it back unread. So a
// summary keeps one id and lists the rows behind it in `members`. The
// service remembers which members a person had seen when they read it, and
// the summary turns unread only when a row they have not seen joins it —
// not when one is paid, fixed or approved.
const fs = require("fs");
const path = require("path");
const pool = require("../config/database");
const notificationRepository = require("../modules/restaurant/notifications/repositories/notification.repository");

const PROVIDER_DIR = path.join(__dirname, "providers");

// Longer than any honest provider needs (they run a query or two on indexed
// rows), short enough that the bell never looks frozen waiting on one.
const PROVIDER_TIMEOUT_MS = 4000;

const SEVERITIES = ["critical", "warning", "info"];
const MAX_ID_LENGTH = 200;
const MAX_ALERTS_PER_PROVIDER = 100;
// A summary of more rows than this is not something anyone reads row by row;
// past it, the list is cut and the summary simply stays read or unread.
const MAX_MEMBERS = 1000;

// What the restaurant's own settings would say, for a restaurant with none.
const DEFAULT_TIMEZONE = "Asia/Kolkata";
const DEFAULT_CURRENCY = "₹";

// An alert id: the provider's key, a colon, then printable text. A NUL or any
// other control character is refused before it reaches the database, which
// would reject it with an error instead of a sentence.
const ALERT_ID_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):[^\u0000-\u001F\u007F-\u009F]+$/;

// The names people know these areas by, for the "what the bell watches" list.
// A provider can also declare its own `label`; anything unknown falls back to
// its key, spaced out.
const LABELS = {
  bills: "Bills & payments",
  stock: "Stock levels",
  crm: "Complaints & feedback",
  expenses: "Expense approvals",
  purchasing: "Purchase orders",
  businessDay: "Business day",
  kitchen: "Kitchen",
  reservations: "Reservations",
  tableRequests: "Table requests",
  deliveries: "Deliveries",
  timeclock: "Time clock",
  inventoryInsights: "Waste & reorder",
  guests: "Guests",
};

const humanise = (key) => {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};

const labelFor = (provider) =>
  (typeof provider.label === "string" && provider.label.trim()) ||
  LABELS[provider.key] ||
  humanise(provider.key);

// The same complaint about the same file is logged once, not every 30 seconds
// for as long as the file stays broken.
const complained = new Set();
const complainOnce = (message) => {
  if (!complained.has(message)) {
    complained.add(message);
    console.error(`notifications: ${message}`);
  }
};

const loaded = new Set();

const loadProviders = async () => {
  let files;

  try {
    files = (await fs.promises.readdir(PROVIDER_DIR)).filter((file) => file.endsWith(".js")).sort();
  } catch (error) {
    complainOnce(`cannot read the providers folder: ${error.message}`);
    return [];
  }

  const present = new Set(files.map((file) => path.join(PROVIDER_DIR, file)));

  // A file that has gone must not live on in require's cache — or come back
  // stale if a file of the same name reappears later.
  for (const full of loaded) {
    if (!present.has(full)) {
      // Keyed by the absolute path, which is what `full` already is —
      // require.resolve would throw now that the file is gone.
      delete require.cache[full];
      loaded.delete(full);
    }
  }

  const providers = [];
  const keys = new Set();

  for (const file of files) {
    const full = path.join(PROVIDER_DIR, file);
    let provider;

    try {
      // A file with a syntax error — or one another module is halfway through
      // writing — throws here and is left out of cache, so it is simply tried
      // again on the next poll.
      provider = require(full);
      loaded.add(full);
    } catch (error) {
      complainOnce(`${file} could not be loaded: ${error.message}`);
      continue;
    }

    const validPermission =
      provider &&
      (provider.permission === null ||
        provider.permission === undefined ||
        typeof provider.permission === "string" ||
        (Array.isArray(provider.permission) &&
          provider.permission.every((code) => typeof code === "string")));

    if (
      !provider ||
      typeof provider.key !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(provider.key) ||
      typeof provider.collect !== "function" ||
      !validPermission
    ) {
      complainOnce(`${file} is not a provider (it needs a key, a permission and collect())`);
      continue;
    }

    if (keys.has(provider.key)) {
      complainOnce(`${file} reuses the key "${provider.key}" and was skipped`);
      continue;
    }

    keys.add(provider.key);
    providers.push({ ...provider, file });
  }

  return providers;
};

const allowed = (provider, permissions) => {
  if (provider.permission === null || provider.permission === undefined) {
    return true;
  }

  const required = Array.isArray(provider.permission) ? provider.permission : [provider.permission];
  return required.every((code) => permissions.includes(code));
};

// A provider may name the restaurant feature its alerts belong to (`feature`:
// a code, or a list of which any one will do). With that feature switched off
// (Settings -> Features) the provider is not asked at all, so a switched-off
// feature's alerts leave the bell and its queries are not run. `features`
// undefined (a test calling collect() directly) filters nothing.
const featureOn = (provider, features) => {
  if (!Array.isArray(features) || !provider.feature) {
    return true;
  }

  const wanted = Array.isArray(provider.feature) ? provider.feature : [provider.feature];
  return wanted.some((code) => features.includes(code));
};

// --- The answer cache -------------------------------------------------------
//
// The bell polls every 30 seconds on every screen of every signed-in person,
// and some providers read a month of stock or a week of bills (100-350 ms
// each on a busy restaurant). Their answer depends only on the restaurant,
// the outlet and the day (context), never on who asks (permissions are
// checked before a provider runs), so it is shared:
//
//   - every provider: two people asking at the same moment share one run
//     (no second set of queries while the first is still out);
//   - a provider that declares `cacheSeconds` (the slow back-office ones:
//     stock, supplier bills, waste, theft checks) keeps its answer that long
//     for everyone in the same restaurant, outlet and day. Alerts about the
//     live service (kitchen, table requests, bookings) declare none and are
//     always asked afresh.
//
// The key carries the business day and the calendar date, so opening or
// closing a day starts afresh; invalidate(restaurantId) drops a restaurant's
// answers at once (a screen that just approved an expense calls it), and
// marking alerts read always asks the providers afresh. Only "ok" answers
// are kept. NOTIFICATIONS_CACHE=off switches the kept answers off; under
// NODE_ENV=test they are off unless NOTIFICATIONS_CACHE=on, so a test that
// changes data and asks again sees the change at once.
const cache = new Map();
const MAX_CACHED = 5000;

const cacheOn = () => {
  const setting = String(process.env.NOTIFICATIONS_CACHE || "").trim().toLowerCase();

  if (setting === "off") {
    return false;
  }

  return setting === "on" || String(process.env.NODE_ENV || "").trim().toLowerCase() !== "test";
};

const cacheKey = (provider, context) =>
  [provider.key, context.restaurantId, context.outletId || "", context.businessDate || "", context.today, context.timezone, context.currency].join("|");

const keepSeconds = (provider) => {
  const seconds = Number(provider.cacheSeconds);
  return cacheOn() && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 0;
};

const sweepCache = (nowMs) => {
  if (cache.size <= MAX_CACHED) {
    return;
  }

  for (const [key, entry] of cache) {
    if (entry.settled && entry.expires <= nowMs) {
      cache.delete(key);
    }
  }

  // Still too many (a flood of distinct outlets): drop the oldest.
  while (cache.size > MAX_CACHED) {
    cache.delete(cache.keys().next().value);
  }
};

// One provider's answer: a run already out (or, within its cacheSeconds, a
// recent one) is shared; `fresh` always asks again.
const cachedRun = (provider, context, fresh) => {
  const key = cacheKey(provider, context);
  const nowMs = Date.now();
  const entry = cache.get(key);

  if (!fresh && entry && (!entry.settled || entry.expires > nowMs)) {
    return entry.promise;
  }

  const seconds = keepSeconds(provider);
  const run = { settled: false, expires: 0, restaurantId: context.restaurantId };
  run.promise = runProvider(provider, context).then((result) => {
    run.settled = true;

    if (result.status === "ok" && seconds > 0 && cache.get(key) === run) {
      run.expires = Date.now() + seconds * 1000;
    } else if (cache.get(key) === run) {
      cache.delete(key);
    }

    return result;
  });

  cache.set(key, run);
  sweepCache(nowMs);
  return run.promise;
};

// Drops every kept answer for this restaurant (all outlets), e.g. right after
// a change that clears or raises an alert.
const invalidate = (restaurantId) => {
  for (const [key, entry] of cache) {
    // No restaurant named (a platform-level write): every restaurant's.
    if ((restaurantId === undefined || Number(entry.restaurantId) === Number(restaurantId)) && entry.settled) {
      cache.delete(key);
    }
  }
};

// Resolves, never rejects: every outcome becomes a status the caller can show.
const runProvider = (provider, context) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "timeout" }), PROVIDER_TIMEOUT_MS);

    // Promise.resolve().then(...) so a provider that throws before returning a
    // promise is caught the same way as one whose promise rejects.
    Promise.resolve()
      .then(() => provider.collect(context))
      .then(
        (alerts) => {
          clearTimeout(timer);
          resolve(Array.isArray(alerts) ? { status: "ok", alerts } : { status: "invalid" });
        },
        (error) => {
          clearTimeout(timer);
          resolve({ status: "failed", error });
        }
      );
  });

// Makes one alert safe to send to the browser, or returns null to drop it.
const normalise = (provider, alert, now) => {
  if (!alert || typeof alert !== "object") {
    return null;
  }

  if (typeof alert.id !== "string" || !alert.id.trim()) {
    return null;
  }

  if (!SEVERITIES.includes(alert.severity) || typeof alert.title !== "string" || !alert.title.trim()) {
    return null;
  }

  // Every id carries its provider's key in front. Read marks are forgotten by
  // that prefix, and it keeps two providers from ever sharing an id.
  const prefix = `${provider.key}:`;
  const id = alert.id.startsWith(prefix) ? alert.id : `${prefix}${alert.id}`;

  if (id.length > MAX_ID_LENGTH) {
    return null;
  }

  if (!ALERT_ID_PATTERN.test(id)) {
    return null;
  }

  const at = alert.at ? new Date(alert.at) : now;

  // Member ids as text, once each, so "12" from one query and 12 from
  // another are the same row.
  const members = Array.isArray(alert.members)
    ? [
        ...new Set(
          alert.members
            .filter((member) => typeof member === "string" || Number.isFinite(member))
            .map(String)
        ),
      ].slice(0, MAX_MEMBERS)
    : null;

  return {
    id,
    // Which provider said it, so a screen can list alerts by the area that
    // raised them even when a provider files them under several categories.
    source: provider.key,
    severity: alert.severity,
    title: alert.title.trim(),
    detail: typeof alert.detail === "string" && alert.detail.trim() ? alert.detail.trim() : null,
    // Only a path inside the app. A provider has no reason to send anyone
    // off-site, and a "javascript:" link in the bell would be a hole.
    link: typeof alert.link === "string" && /^\/(?!\/)/.test(alert.link) ? alert.link : null,
    category:
      typeof alert.category === "string" && alert.category.trim()
        ? alert.category.trim()
        : labelFor(provider),
    at: Number.isNaN(at.getTime()) ? now.toISOString() : at.toISOString(),
    // Only a summary has members. The service reads them for the read state
    // and does not send them to the browser.
    ...(members ? { members } : {}),
  };
};

// The restaurant's calendar date on its own clock. The server may well run
// in UTC, where half past midnight in Kolkata is still yesterday afternoon.
const localDate = (now, timezone) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

const moneyFormatter = (currency) => {
  const whole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  const exact = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (value) => {
    const number = Number(value || 0);
    return `${currency}${Math.round(number * 100) % 100 === 0 ? whole.format(number) : exact.format(number)}`;
  };
};

// The whole context from whatever part of it was given. Anything missing is
// worked out exactly as the registry would, so a provider behaves the same
// called from here, from a test, or with only the fields the README lists.
// Frozen, so one provider cannot change what the next one sees.
const completeContext = (given = {}) => {
  const now = given.now instanceof Date && !Number.isNaN(given.now.getTime()) ? given.now : new Date();
  const timezone = given.timezone || DEFAULT_TIMEZONE;
  const today = given.today || localDate(now, timezone);
  const currency = given.currency || DEFAULT_CURRENCY;

  return Object.freeze({
    ...given,
    now,
    timezone,
    today,
    businessDate: given.businessDate || today,
    currency,
    money: typeof given.money === "function" ? given.money : moneyFormatter(currency),
    pool: given.pool || pool,
  });
};

// The keys of the providers this person may see, e.g. to check that an id
// they want marked read could ever have been shown to them.
const permittedKeys = async (permissions = [], features = undefined) =>
  (await loadProviders())
    .filter((provider) => allowed(provider, permissions) && featureOn(provider, features))
    .map((provider) => provider.key);

// Splits an alert id into its provider key, or null when it is not one.
const keyOf = (id) => {
  const match = typeof id === "string" && id.length <= MAX_ID_LENGTH ? ALERT_ID_PATTERN.exec(id) : null;
  return match ? match[1] : null;
};

// Everything needing attention in one restaurant, for one person.
//
// Returns { alerts, sources }: the alerts, and one entry per provider this
// person may see saying whether it answered — so a screen can say "could not
// check the kitchen just now" rather than implying the kitchen is fine.
//
// `only` limits the run to those provider keys — marking one alert read asks
// its own provider whether it is still live, not the whole bell.
//
// `outletId` is the outlet the person is tied to (null for someone who sees
// every outlet). Providers that keep per-store alerts (stock expiry, supplier
// bills, transfers, purchase approvals) show such a person only their own
// store's; it was never passed before, so a branch manager saw the main
// store's alerts too.
const collect = async ({
  restaurantId,
  permissions = [],
  now = new Date(),
  only = null,
  outletId = null,
  features = undefined,
  // true: ask every provider afresh (marking read checks what is live now).
  fresh = false,
}) => {
  if (!restaurantId) {
    return { alerts: [], sources: [] };
  }

  const [providers, settings] = await Promise.all([
    loadProviders(),
    notificationRepository.findContext(restaurantId),
  ]);

  if (!settings) {
    return { alerts: [], sources: [] };
  }

  const context = completeContext({
    restaurantId,
    businessDate: settings.open_business_date || null,
    timezone: settings.timezone || DEFAULT_TIMEZONE,
    now,
    pool,
    currency: settings.currency_symbol || DEFAULT_CURRENCY,
    outletId: outletId || null,
  });

  const permitted = providers.filter(
    (provider) => allowed(provider, permissions) && featureOn(provider, features) && (!only || only.includes(provider.key))
  );
  const results = await Promise.all(permitted.map((provider) => cachedRun(provider, context, fresh)));

  const alerts = [];
  const seen = new Set();
  const sources = [];

  permitted.forEach((provider, index) => {
    const result = results[index];
    const source = { key: provider.key, label: labelFor(provider), status: result.status, count: 0 };

    if (result.status === "ok") {
      for (const raw of result.alerts.slice(0, MAX_ALERTS_PER_PROVIDER)) {
        const alert = normalise(provider, raw, now);

        if (!alert) {
          complainOnce(`${provider.file} returned an alert without a valid id, severity or title`);
          continue;
        }

        if (!seen.has(alert.id)) {
          seen.add(alert.id);
          alerts.push(alert);
          source.count += 1;
        }
      }
    } else if (result.status === "failed") {
      console.error(`notifications: ${provider.file} failed: ${result.error && result.error.message}`);
    } else if (result.status === "timeout") {
      console.error(`notifications: ${provider.file} took over ${PROVIDER_TIMEOUT_MS} ms and was skipped`);
    } else {
      complainOnce(`${provider.file} returned something other than a list`);
    }

    sources.push(source);
  });

  sources.sort((a, b) => a.label.localeCompare(b.label));

  return { alerts, sources };
};

module.exports = {
  collect,
  invalidate,
  completeContext,
  permittedKeys,
  keyOf,
  SEVERITIES,
  PROVIDER_TIMEOUT_MS,
  MAX_ID_LENGTH,
  // Exposed for tests.
  loadProviders,
  normalise,
};
