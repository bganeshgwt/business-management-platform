// Guests worth a personal hello, today: a regular or a big spender who is at a
// table right now, and a regular whose birthday or wedding anniversary it is.
//
// None of this is a problem to fix — it is the difference between "welcome
// back, the usual?" and treating a ten-year regular like a stranger. So every
// alert here is `info`, and each names the guest, the table and the one fact
// that makes them matter.
//
// The rules (what makes a regular, a big spender, a sitting) are the Guest
// insights screen's own: the restaurant's regular and big-spender lines
// (Settings -> Alerts and timings, read through ruleSettings exactly as the
// screen reads them) and the screen's sitting length, so the bell and the
// screen can never disagree about who someone is.
const guestInsightRepository = require("../../modules/restaurant/crm/repositories/guestInsight.repository");
const guestInsightService = require("../../modules/restaurant/crm/services/guestInsight.service");
const ruleSettings = require("../../modules/restaurant/setup/services/ruleSettings.service");

const { SEATED_WITHIN_HOURS } = guestInsightService.rules;

// The top-spender line moves slowly — one bill cannot shift it much — but
// working it out reads every guest's history. So it is worked out at most
// every ten minutes per restaurant, not on every 30-second poll.
const THRESHOLD_TTL_MS = 10 * 60 * 1000;
const thresholdCache = new Map();

const NAMED_LIMIT = 5;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// "T5" reads as a table; a bare "5" needs the word.
const tableLabel = (tableNo) => (/^\d+$/.test(String(tableNo)) ? `table ${tableNo}` : String(tableNo));

// share: the restaurant's top share (0.1 for the top 10%). A changed share is
// worked out afresh rather than waiting out the cache.
const bigSpenderThreshold = async (restaurantId, share, now) => {
  const cached = thresholdCache.get(restaurantId);

  if (cached && cached.share === share && now.getTime() - cached.at < THRESHOLD_TTL_MS) {
    return cached.value;
  }

  const value = await guestInsightRepository.findBigSpenderThreshold(restaurantId, share);
  thresholdCache.set(restaurantId, { value, share, at: now.getTime() });

  return value;
};

// Local midnight of the restaurant's today, as an instant: when a birthday
// "became true".
const startOfDay = (todayIso, timezone) => {
  const utcMidnight = Date.parse(`${todayIso}T00:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(utcMidnight))
      .map((part) => [part.type, part.value])
  );
  const shownAs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);

  return new Date(utcMidnight - (shownAs - utcMidnight)).toISOString();
};

module.exports = {
  key: "guests",
  label: "Guests",
  permission: "customers.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "guests",

  // Never throws: a failed query costs this module its alerts for one poll,
  // not everyone's bell.
  collect: async (context) => {
    try {
      return await collectAlerts(context);
    } catch (error) {
      console.error("guests notifications:", error.message);
      return [];
    }
  },

  // For tests: forget the cached top-spender line.
  resetCache: () => thresholdCache.clear(),
};

async function collectAlerts({ restaurantId, timezone, now, today, money, pool }) {
  const clock = now instanceof Date ? now : new Date();
  const zone = timezone || "Asia/Kolkata";
  const localToday = today || new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(clock);
  const format = typeof money === "function" ? money : (value) => `₹${Math.round(Number(value || 0))}`;

  // Both read a handful of rows: running orders (idx_orders_status) and the
  // guest book filtered to one calendar day.
  const dayKeys = guestInsightService.birthdayKeysFor(localToday);
  const [seated, birthdays, anniversaries, rules] = await Promise.all([
    guestInsightRepository.findSeatedGuests(restaurantId, SEATED_WITHIN_HOURS, clock),
    guestInsightRepository.findBirthdayGuests(restaurantId, dayKeys),
    guestInsightRepository.findAnniversaryGuests(restaurantId, dayKeys),
    ruleSettings.load(restaurantId, pool),
  ]);

  if (seated.length === 0 && birthdays.length === 0 && anniversaries.length === 0) {
    return [];
  }

  const ids = [
    ...new Set([
      ...seated.map((row) => row.customer_id),
      ...birthdays.map((row) => row.id),
      ...anniversaries.map((row) => row.id),
    ]),
  ];

  const [stats, threshold, favourites] = await Promise.all([
    guestInsightRepository.findStatsForGuests(restaurantId, ids, zone, clock, rules.guestRegularDays),
    seated.length ? bigSpenderThreshold(restaurantId, rules.guestBigSpenderPercent / 100, clock) : null,
    guestInsightRepository.findFavouriteDishes(
      restaurantId,
      [...new Set(seated.map((row) => row.customer_id))]
    ),
  ]);

  const statOf = new Map(stats.map((row) => [row.id, row]));
  const favouriteOf = new Map(favourites.map((row) => [row.customer_id, row.item_name]));
  const birthdayToday = new Set(birthdays.map((row) => row.id));
  const anniversaryToday = new Map(anniversaries.map((row) => [row.id, row.anniversary_date]));

  const isRegular = (stat) => Number(stat.visits_60) >= rules.guestRegularVisits;
  const isBigSpender = (stat) => threshold !== null && Number(stat.spend) > 0 && Number(stat.spend) >= threshold;

  const alerts = [];
  const announced = new Set();

  // A guest with two running orders (a second table for the kids) is one guest.
  for (const row of seated) {
    const stat = statOf.get(row.customer_id);

    if (!stat || announced.has(row.customer_id)) {
      continue;
    }

    const regular = isRegular(stat);
    const big = isBigSpender(stat);
    const birthday = birthdayToday.has(row.customer_id);

    if (!regular && !big) {
      continue;
    }

    announced.add(row.customer_id);

    const where = tableLabel(row.table_no);
    const title = birthday
      ? `It's ${stat.name}'s birthday — they're at ${where}`
      : anniversaryToday.has(row.customer_id)
        ? `It's ${stat.name}'s wedding anniversary — they're at ${where}`
        : regular
        ? `Your regular ${stat.name} is at ${where}`
        : `Big spender ${stat.name} is at ${where}`;

    const favourite = favouriteOf.get(row.customer_id);

    alerts.push({
      // The order, not the guest: the same regular back tomorrow is a new
      // sitting and worth a new hello.
      id: `guests:seated:${row.order_id}`,
      severity: "info",
      title,
      detail: [
        regular
          ? `${plural(Number(stat.visits_60), "visit", "visits")} in ${rules.guestRegularDays} days`
          : null,
        big ? `top ${rules.guestBigSpenderPercent}% by spend` : null,
        `${format(stat.spend)} lifetime`,
        favourite ? `usually has ${favourite}` : null,
        // Still seated, but not for long: the moment for a goodbye.
        row.order_status === "billed" ? "bill on the table" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      link: `/crm/insights?segment=${regular ? "regulars" : "big-spenders"}&guest=${row.customer_id}`,
      category: "Guests",
      at: new Date(row.placed_at).toISOString(),
    });
  }

  // Birthdays today among regulars, except those already greeted above.
  const celebrating = birthdays
    .map((row) => statOf.get(row.id))
    .filter((stat) => stat && isRegular(stat) && !announced.has(stat.id))
    .sort((a, b) => Number(b.visits_60) - Number(a.visits_60) || a.name.localeCompare(b.name));

  const since = startOfDay(localToday, zone);

  for (const stat of celebrating.slice(0, NAMED_LIMIT)) {
    alerts.push({
      // The date in the id: next year's birthday is a new alert, not one
      // already marked read a year ago.
      id: `guests:birthday:${stat.id}:${localToday}`,
      severity: "info",
      title: `${stat.name}'s birthday today`,
      detail: [
        `Regular · ${plural(Number(stat.visits_60), "visit", "visits")} in ${rules.guestRegularDays} days`,
        stat.mobile,
        "send a wish, or a dessert on the house if they come in",
      ]
        .filter(Boolean)
        .join(" · "),
      link: `/crm/insights?segment=birthdays&guest=${stat.id}`,
      category: "Guests",
      at: since,
    });
  }

  if (celebrating.length > NAMED_LIMIT) {
    const rest = celebrating.length - NAMED_LIMIT;

    alerts.push({
      // One id for the day, with the guests behind it as members: a regular
      // greeted at their table leaves it read, one more birthday makes it news.
      id: `guests:birthday-more:${localToday}`,
      members: celebrating.slice(NAMED_LIMIT).map((stat) => `customer:${stat.id}`),
      severity: "info",
      title: `${plural(rest, "more regular has", "more regulars have")} a birthday today`,
      detail: "See this week's birthdays in Guest insights",
      link: "/crm/insights?segment=birthdays",
      category: "Guests",
      at: since,
    });
  }

  // Wedding anniversaries today among regulars, the same way.
  const married = anniversaries
    .map((row) => statOf.get(row.id))
    .filter((stat) => stat && isRegular(stat) && !announced.has(stat.id))
    .sort((a, b) => Number(b.visits_60) - Number(a.visits_60) || a.name.localeCompare(b.name));

  for (const stat of married.slice(0, NAMED_LIMIT)) {
    const years = guestInsightService.nextAnniversary(anniversaryToday.get(stat.id), localToday);

    alerts.push({
      id: `guests:anniversary:${stat.id}:${localToday}`,
      severity: "info",
      title: `${stat.name}'s wedding anniversary today${years && years.years ? ` (${years.years} years)` : ""}`,
      detail: [
        `Regular · ${plural(Number(stat.visits_60), "visit", "visits")} in ${rules.guestRegularDays} days`,
        stat.mobile,
        "send a wish, or offer them a table for two tonight",
      ]
        .filter(Boolean)
        .join(" · "),
      link: `/crm/insights?segment=anniversaries&guest=${stat.id}`,
      category: "Guests",
      at: since,
    });
  }

  if (married.length > NAMED_LIMIT) {
    const rest = married.length - NAMED_LIMIT;

    alerts.push({
      id: `guests:anniversary-more:${localToday}`,
      members: married.slice(NAMED_LIMIT).map((stat) => `customer:${stat.id}`),
      severity: "info",
      title: `${plural(rest, "more regular has", "more regulars have")} a wedding anniversary today`,
      detail: "See this week's anniversaries in Guest insights",
      link: "/crm/insights?segment=anniversaries",
      category: "Guests",
      at: since,
    });
  }

  return alerts;
}
