const guestInsightRepository = require("../repositories/guestInsight.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { maskMobile, mobileSearchDigits, normaliseMobile } = require("../../../../utils/phone");
const { maskEmail } = require("./crm.service");
const ruleSettings = require("../../setup/services/ruleSettings.service");

// Guest insights: who comes back, who stopped, who to thank.
//
// Nothing here is stored. Every number is worked out from the guest book, the
// orders linked to each guest and the bills on those orders, at the moment it
// is asked for — so a list can never disagree with the bills it came from.
//
// The rules below are the whole of it. They are named, not numbers scattered
// through the code, because a manager will ask "why is Priya a regular?" and
// the answer has to be one line anyone can read. The regular, new, lapsed
// and big-spender lines are the restaurant's own (Settings -> Alerts and
// timings, carried on the context as context.rules); the numbers here are
// what a restaurant starts with.

// A regular: three or more visits in the last 60 days.
const REGULAR_VISITS = ruleSettings.DEFAULTS.guestRegularVisits;
const REGULAR_WINDOW_DAYS = ruleSettings.DEFAULTS.guestRegularDays;
// Active: any visit in the same 60 days.
const ACTIVE_WINDOW_DAYS = 60;
// New: first ever visit in the last 30 days.
const NEW_WINDOW_DAYS = ruleSettings.DEFAULTS.guestNewDays;
// Lapsed: came at least twice, then nothing for 45 days. One visit and gone
// is a passer-by, not someone the restaurant has lost. (The guest book's
// "Lapsed" view uses the same number of days.)
const LAPSED_MIN_VISITS = 2;
const LAPSED_QUIET_DAYS = ruleSettings.DEFAULTS.guestLapsedDays;
// Big spenders: everyone who has spent at least as much as the guest who
// closes the top tenth. Guests level with that line are all in — leaving out
// one of two guests with the same spend would be impossible to explain — so
// the list can hold a little more than a tenth, and the words say so.
const BIG_SPENDER_SHARE = ruleSettings.DEFAULTS.guestBigSpenderPercent / 100;
// Birthdays: today and the six days after it — this week, as a host plans it.
const BIRTHDAY_WINDOW_DAYS = 7;
// Unhappy: a rating of two stars or less, or any complaint, in 90 days.
const UNHAPPY_WINDOW_DAYS = 90;
const UNHAPPY_MAX_RATING = 2;
// A guest at a table: a running dine-in order (open, or billed and not yet
// paid) no older than a sitting can last.
const SEATED_WITHIN_HOURS = 4;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 5000;
const TOP_GUESTS = 10;

// --- calendar arithmetic on YYYY-MM-DD strings -------------------------------
//
// Plain dates, done in UTC so no daylight-saving shift can move a birthday.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const toUtc = (iso) => {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

const daysBetween = (fromIso, toIso) => Math.round((toUtc(toIso) - toUtc(fromIso)) / 86400000);

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

// "Sat 26 Sep", or "Sat 26 Sep 2025" when it is not this year. Built by hand:
// en-IN spells September "Sept", unlike every other screen in the app.
const dayLabel = (iso, todayIso) => {
  const date = new Date(toUtc(iso));
  const sameYear = iso.slice(0, 4) === todayIso.slice(0, 4);

  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}${
    sameYear ? "" : ` ${date.getUTCFullYear()}`
  }`;
};

// "today", "yesterday", "12 days ago".
const agoLabel = (days) => {
  if (days <= 0) {
    return "today";
  }

  return days === 1 ? "yesterday" : `${days} days ago`;
};

// A guest's next birthday on or after today. Someone born on 29 February
// celebrates on the 28th in a year that has no 29th.
const nextBirthday = (dateOfBirth, todayIso) => {
  if (!dateOfBirth) {
    return null;
  }

  const [birthYear, month, day] = dateOfBirth.split("-").map(Number);
  const thisYear = Number(todayIso.slice(0, 4));

  const onYear = (year) => {
    const actualDay = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
    return fromUtc(Date.UTC(year, month - 1, actualDay));
  };

  let date = onYear(thisYear);

  if (date < todayIso) {
    date = onYear(thisYear + 1);
  }

  const turning = Number(date.slice(0, 4)) - birthYear;

  return {
    date,
    inDays: daysBetween(todayIso, date),
    // A year of birth typed as 1900 or left at a placeholder says nothing
    // about the guest's age, so the age is only offered when it is plausible.
    turning: birthYear >= 1900 && turning >= 1 && turning <= 110 ? turning : null,
  };
};

// A guest's next wedding anniversary on or after today, with the years it
// marks (the same calendar rule as a birthday).
const nextAnniversary = (anniversaryDate, todayIso) => {
  const next = nextBirthday(anniversaryDate, todayIso);

  if (!next) {
    return null;
  }

  const years = Number(next.date.slice(0, 4)) - Number(String(anniversaryDate).slice(0, 4));

  return { date: next.date, inDays: next.inDays, years: years >= 1 && years <= 80 ? years : null };
};

// The MM-DD values that count as "their birthday" today.
const birthdayKeysFor = (todayIso) => {
  const keys = [todayIso.slice(5)];

  // On 28 February of a year with no 29th, the leap-day guests celebrate too.
  if (todayIso.slice(5) === "02-28" && !isLeapYear(Number(todayIso.slice(0, 4)))) {
    keys.push("02-29");
  }

  return keys;
};

// --- money as a paise count, so thousands of bills add up exactly ------------

const toPaise = (value) => Math.round(Number(value || 0) * 100);
const fromPaise = (paise) => round2(paise / 100);

const moneyText = (value, currency) => {
  const number = Number(value || 0);
  const whole = Math.round(number * 100) % 100 === 0;

  return `${currency}${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(number)}`;
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// "about every 9 days" — or "almost daily" rather than "about every 1 day".
const rhythm = (days, lead) => (days <= 1 ? "almost daily" : `${lead} every ${days} days`);

// "“Cold biryani, waited forty minutes for…”"
const quote = (text, limit = 60) => {
  if (!text) {
    return null;
  }

  const flat = String(text).replace(/\s+/g, " ").trim();
  return `“${flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat}”`;
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// --- one guest ----------------------------------------------------------------

const toGuest = (row, today) => {
  const visits = Number(row.visits);
  const billedVisits = Number(row.billed_visits);
  const spendPaise = toPaise(row.spend);
  const lastVisitDate = row.last_visit_date || null;
  const firstVisitDate = row.first_visit_date || null;

  return {
    id: row.id,
    name: row.name,
    mobile: row.mobile,
    email: row.email,
    dateOfBirth: row.date_of_birth,
    anniversaryDate: row.anniversary_date ?? null,
    joinedAt: row.created_at,
    points: Number(row.loyalty_points || 0),
    visits,
    billedVisits,
    visits60: Number(row.visits_60),
    spendPaise,
    lifetimeSpend: fromPaise(spendPaise),
    averageSpend: billedVisits > 0 ? round2(spendPaise / billedVisits / 100) : 0,
    firstVisit: row.first_visit,
    lastVisit: row.last_visit,
    firstVisitDate,
    lastVisitDate,
    daysSinceLastVisit: lastVisitDate ? Number(row.days_since_last) : null,
    daysSinceFirstVisit: firstVisitDate ? Number(row.days_since_first) : null,
    // How often they used to come: the days between first and last visit,
    // shared across the gaps. Only meaningful from the second visit on, and
    // only once the visits span more than one day — three orders in one
    // evening say nothing about a rhythm.
    visitEveryDays:
      visits >= 2 && firstVisitDate && lastVisitDate && lastVisitDate > firstVisitDate
        ? Math.max(1, Math.round(daysBetween(firstVisitDate, lastVisitDate) / (visits - 1)))
        : null,
    birthday: nextBirthday(row.date_of_birth, today),
    anniversary: nextAnniversary(row.anniversary_date ?? null, today),
    unhappy: null,
  };
};

// --- the segments -------------------------------------------------------------
//
// Each one: who is in it, the order the list is worth reading in, and the
// line that says why this particular guest is on it.

const SEGMENTS = [
  {
    key: "regulars",
    label: "Regulars",
    tone: "success",
    definition: (context) =>
      `${context.rules.guestRegularVisits}+ visits in the last ${context.rules.guestRegularDays} days`,
    hint: "Know them by name. Their usual table and their usual order, remembered, is what keeps them coming.",
    // visits60: visits inside the regular window, whatever its length.
    includes: (guest, context) => guest.visits60 >= context.rules.guestRegularVisits,
    compare: (a, b) => b.visits60 - a.visits60 || b.spendPaise - a.spendPaise,
    reason: (guest, context) =>
      [
        `${plural(guest.visits60, "visit", "visits")} in ${context.rules.guestRegularDays} days`,
        guest.visitEveryDays ? rhythm(guest.visitEveryDays, "about") : null,
        // The windows overlap: a regular can already have gone quiet, and
        // that is the one thing about them worth saying first on a call list.
        guest.daysSinceLastVisit !== null && guest.daysSinceLastVisit >= context.rules.guestLapsedDays
          ? `but not seen for ${guest.daysSinceLastVisit} days`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
  },
  {
    key: "new",
    label: "New guests",
    tone: "info",
    definition: (context) => `First visit in the last ${context.rules.guestNewDays} days`,
    hint: "The second visit is the hardest one to win. Thank them while the meal is still fresh in their mind.",
    includes: (guest, context) =>
      guest.visits > 0 &&
      guest.daysSinceFirstVisit !== null &&
      guest.daysSinceFirstVisit < context.rules.guestNewDays,
    compare: (a, b) =>
      a.daysSinceFirstVisit - b.daysSinceFirstVisit || new Date(b.firstVisit) - new Date(a.firstVisit),
    reason: (guest) =>
      [
        `First came ${agoLabel(guest.daysSinceFirstVisit)}`,
        guest.visits >= 2 ? `already back ${plural(guest.visits - 1, "time", "times")}` : "not back yet",
      ].join(" · "),
  },
  {
    key: "lapsed",
    label: "At risk / lapsed",
    tone: "warning",
    definition: (context) =>
      `${LAPSED_MIN_VISITS}+ visits before, none in the last ${context.rules.guestLapsedDays} days`,
    hint: "Start with the biggest spenders: a personal call or a “we miss you” offer wins back more than a mass message.",
    includes: (guest, context) =>
      guest.visits >= LAPSED_MIN_VISITS &&
      guest.daysSinceLastVisit !== null &&
      guest.daysSinceLastVisit >= context.rules.guestLapsedDays,
    compare: (a, b) => b.spendPaise - a.spendPaise || a.daysSinceLastVisit - b.daysSinceLastVisit,
    reason: (guest) =>
      [
        `Last seen ${agoLabel(guest.daysSinceLastVisit)}`,
        guest.visitEveryDays
          ? guest.visitEveryDays <= 1
            ? "used to come almost daily"
            : `used to come every ${guest.visitEveryDays} days`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
  },
  {
    key: "big-spenders",
    label: "Big spenders",
    tone: "primary",
    // The rule is the amount; the share only says where the amount came
    // from. Leading with "Top 10%" read as a promise about the list's size
    // that ties at the line could break.
    definition: (context) =>
      context.bigSpenderFrom
        ? `Spent ${moneyText(context.bigSpenderFrom, context.currency)} or more — where your top ${
            context.rules.guestBigSpenderPercent
          }% begins`
        : `The top ${context.rules.guestBigSpenderPercent}% of guests by lifetime spend, once bills are paid`,
    // Said only when ties at the line make the list longer than a tenth, so
    // nobody has to wonder why 10% of 141 guests is 54.
    note: (context, count) => {
      if (!context.bigSpenderFrom || count <= context.bigSpenderTopCount) {
        return null;
      }

      return `Everyone level with the line is on it: ${plural(
        context.bigSpenderTied,
        "guest",
        "guests"
      )} spent exactly ${moneyText(context.bigSpenderFrom, context.currency)}, so the list holds ${count} rather than ${
        context.bigSpenderTopCount
      }.`;
    },
    hint: "Your most valuable guests. Make sure the manager says hello when they are in.",
    includes: (guest, context) =>
      context.bigSpenderFromPaise !== null && guest.spendPaise > 0 && guest.spendPaise >= context.bigSpenderFromPaise,
    compare: (a, b) => b.spendPaise - a.spendPaise,
    reason: (guest, context) =>
      [
        `#${context.spendRank.get(guest.id)} of ${context.spenders} by spend`,
        // Whole rupees, as the list's own "a visit" column shows it.
        `${moneyText(Math.round(guest.averageSpend), context.currency)} a visit`,
      ].join(" · "),
  },
  {
    key: "birthdays",
    label: "Birthdays this week",
    tone: "pink",
    definition: () => `Birthday today or in the next ${BIRTHDAY_WINDOW_DAYS - 1} days`,
    hint: "A message on the morning of the day, or a dessert on the house if they are in, is remembered for a year.",
    includes: (guest) => guest.birthday !== null && guest.birthday.inDays < BIRTHDAY_WINDOW_DAYS,
    compare: (a, b) => a.birthday.inDays - b.birthday.inDays || a.name.localeCompare(b.name),
    reason: (guest, context) => {
      const { inDays, date, turning } = guest.birthday;
      const when = inDays === 0 ? "Birthday today" : inDays === 1 ? "Birthday tomorrow" : `Birthday ${dayLabel(date, context.today)}`;

      return turning ? `${when} · turns ${turning}` : when;
    },
  },
  {
    key: "anniversaries",
    label: "Anniversaries this week",
    tone: "pink",
    definition: () => `Wedding anniversary today or in the next ${BIRTHDAY_WINDOW_DAYS - 1} days`,
    hint: "A couple's anniversary is a table for two waiting to be booked: a message that morning, or a dessert with a candle if they are in.",
    includes: (guest) => guest.anniversary !== null && guest.anniversary.inDays < BIRTHDAY_WINDOW_DAYS,
    compare: (a, b) => a.anniversary.inDays - b.anniversary.inDays || a.name.localeCompare(b.name),
    reason: (guest, context) => {
      const { inDays, date, years } = guest.anniversary;
      const when =
        inDays === 0 ? "Anniversary today" : inDays === 1 ? "Anniversary tomorrow" : `Anniversary ${dayLabel(date, context.today)}`;

      return years ? `${when} · ${years} ${years === 1 ? "year" : "years"}` : when;
    },
  },
  {
    key: "unhappy",
    label: "Unhappy guests",
    tone: "danger",
    definition: () =>
      `Rated ${UNHAPPY_MAX_RATING}★ or less, or complained, in the last ${UNHAPPY_WINDOW_DAYS} days`,
    hint: "Call them before they write a review elsewhere, and make sure every complaint is closed with a note.",
    includes: (guest) => guest.unhappy !== null,
    compare: (a, b) => new Date(b.unhappy.at) - new Date(a.unhappy.at),
    reason: (guest, context) => {
      const signal = guest.unhappy;
      const when = dayLabel(signal.date, context.today);

      if (signal.kind === "complaint") {
        const state = { open: "open", in_progress: "in progress", resolved: "resolved", closed: "closed" }[
          signal.status
        ];

        return `Complaint ${when}: ${quote(signal.text, 70)}${state ? ` · ${state}` : ""}`;
      }

      return [`${signal.rating}★ on ${when}`, quote(signal.text, 70)].filter(Boolean).join(" · ");
    },
  },
  {
    key: "points",
    label: "Points to spend",
    tone: "teal",
    definition: (context) =>
      context.loyaltyEnabled
        ? `Holding ${context.minRedeem}+ loyalty points — enough to redeem`
        : "Loyalty is switched off in Restaurant settings",
    hint: "Remind them they have a discount waiting. It is the easiest reason to come back this week.",
    includes: (guest, context) =>
      context.loyaltyEnabled && guest.points > 0 && guest.points >= context.minRedeem,
    compare: (a, b) => b.points - a.points || b.spendPaise - a.spendPaise,
    reason: (guest, context) =>
      `${plural(guest.points, "point", "points")} · worth ${moneyText(
        guest.points * context.pointValue,
        context.currency
      )} off`,
  },
];

const SEGMENT_KEYS = SEGMENTS.map((segment) => segment.key);

// --- building the picture -----------------------------------------------------

const monthStart = (todayIso) => `${todayIso.slice(0, 8)}01`;

// Every guest who has spent anything, ranked once for the whole screen: the
// Top 10 card, the Big spenders line and its "#3 of 141" all read this, so a
// guest cannot be #4 in one place and #3 in the other.
//
// Guests level on spend share a rank, as on any leaderboard (1, 2, 3, 3, 5):
// the rank is one more than the number of guests who spent strictly more.
// The big-spender line is the spend of the guest who closes the top tenth
// (a tenth of spenders — or the restaurant's own share — rounded up, never
// fewer than one).
const rankBySpend = (guests, share = BIG_SPENDER_SHARE) => {
  const spenders = guests
    .filter((guest) => guest.spendPaise > 0)
    .sort((a, b) => b.spendPaise - a.spendPaise || a.id - b.id);
  const topCount = spenders.length ? Math.max(1, Math.ceil(spenders.length * share)) : 0;
  const spendRank = new Map();

  spenders.forEach((guest, index) => {
    const previous = spenders[index - 1];
    spendRank.set(
      guest.id,
      previous && previous.spendPaise === guest.spendPaise ? spendRank.get(previous.id) : index + 1
    );
  });

  return {
    spenders,
    topCount,
    linePaise: topCount ? spenders[topCount - 1].spendPaise : null,
    spendRank,
  };
};

// The search box: part of a name, or part of a mobile number as typed.
//
// For staff who see numbers masked (reveal false) a number finds a guest only
// by what they can already read — the last 4 digits — or by the whole number
// (the guest is in front of them): the guest book's rule. Anything in between
// would let someone rebuild a hidden number a digit at a time by watching who
// stays on the list.
const LAST_DIGITS_SHOWN = 4;

const matchesSearch = (guest, search, reveal = true) => {
  if (!search) {
    return true;
  }

  const needle = search.toLowerCase();

  if (guest.name.toLowerCase().includes(needle)) {
    return true;
  }

  if (!guest.mobile) {
    return false;
  }

  if (reveal) {
    return guest.mobile.toLowerCase().includes(needle);
  }

  const whole = normaliseMobile(search);

  if (whole) {
    return guest.mobile === whole;
  }

  const digits = mobileSearchDigits(search);

  return Boolean(digits) && digits.length <= LAST_DIGITS_SHOWN && guest.mobile.endsWith(digits);
};

// Contact details on these lists follow the guest book's rule (crm.service
// toCustomer): staff without customers.contact — a cashier, a floor role —
// see "XXXXXX3210" and a masked email, enough to recognise the regular at
// table 5, never a number to copy. The real mobile and email are then null.
// Exports follow the same rule as the guest book's export: the right to
// export a list (customers.export) does not carry the right to see contact
// details, so a role with the first and not the second exports the list with
// the numbers masked.
const withContact = (row, reveal) => ({
  ...row,
  mobile: reveal ? row.mobile : null,
  mobileMasked: row.mobile ? maskMobile(row.mobile) : null,
  email: reveal ? row.email : null,
  emailMasked: row.email ? maskEmail(row.email) : null,
  contactHidden: !reveal,
});

const load = async (restaurantId, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const [settings, rules] = await Promise.all([
    guestInsightRepository.findContext(restaurantId, now),
    ruleSettings.load(restaurantId),
  ]);

  if (!settings) {
    throw new AppError(404, "Restaurant not found");
  }

  const timezone = settings.timezone;
  const today = settings.today;

  const [rows, signals] = await Promise.all([
    guestInsightRepository.findGuestFacts(restaurantId, timezone, now, rules.guestRegularDays),
    guestInsightRepository.findUnhappySignals(restaurantId, UNHAPPY_WINDOW_DAYS, UNHAPPY_MAX_RATING, now),
  ]);

  const guests = rows.map((row) => toGuest(row, today));
  const byId = new Map(guests.map((guest) => [guest.id, guest]));

  // Newest first from the database, so the first signal kept is the latest.
  for (const signal of signals) {
    const guest = byId.get(signal.customer_id);

    if (guest && !guest.unhappy) {
      guest.unhappy = {
        kind: signal.kind,
        id: signal.id,
        rating: signal.rating === null ? null : Number(signal.rating),
        text: signal.text,
        status: signal.status,
        at: signal.created_at,
        date: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(signal.created_at)),
      };
    }
  }

  const { spenders, topCount, linePaise: bigSpenderFromPaise, spendRank } = rankBySpend(
    guests,
    rules.guestBigSpenderPercent / 100
  );

  const context = {
    rules,
    today,
    timezone,
    currency: settings.currency_symbol,
    loyaltyEnabled: Boolean(settings.loyalty_enabled),
    minRedeem: Number(settings.loyalty_min_redeem),
    pointValue: Number(settings.loyalty_point_value),
    historyStarts: settings.history_starts,
    inactiveGuests: Number(settings.inactive_guests || 0),
    bigSpenderFromPaise,
    bigSpenderFrom: bigSpenderFromPaise === null ? null : fromPaise(bigSpenderFromPaise),
    bigSpenderTopCount: topCount,
    bigSpenderTied: spenders.filter((guest) => guest.spendPaise === bigSpenderFromPaise).length,
    spenders: spenders.length,
    spendRank,
  };

  // Every guest carries the list of segments they are in, so a row in one list
  // can say "also a regular, birthday Saturday" without a second request.
  for (const guest of guests) {
    guest.tags = SEGMENTS.filter((segment) => segment.includes(guest, context)).map(
      (segment) => segment.key
    );
  }

  return { guests, context };
};

const findSegment = (key) => {
  const segment = SEGMENTS.find((candidate) => candidate.key === key);

  if (!segment) {
    throw new AppError(
      404,
      `There is no guest list called "${key}". Choose one of: ${SEGMENT_KEYS.join(", ")}`
    );
  }

  return segment;
};

const describeSegment = (segment, context, count) => ({
  key: segment.key,
  label: segment.label,
  tone: segment.tone,
  definition: segment.definition(context),
  // A second line for the open list, when the rule needs one to be read right.
  note: segment.note ? segment.note(context, count) : null,
  hint: segment.hint,
  count,
});

// A guest as a list row: what a host needs to recognise them and act.
const toRow = (guest, segment, context) => ({
  id: guest.id,
  name: guest.name,
  mobile: guest.mobile,
  email: guest.email,
  visits: guest.visits,
  visits60: guest.visits60,
  billedVisits: guest.billedVisits,
  firstVisitDate: guest.firstVisitDate,
  lastVisit: guest.lastVisit,
  lastVisitDate: guest.lastVisitDate,
  daysSinceLastVisit: guest.daysSinceLastVisit,
  lifetimeSpend: guest.lifetimeSpend,
  averageSpend: guest.averageSpend,
  // Their place by lifetime spend, shared with anyone level with them; null
  // until they have a paid bill.
  spendRank: context.spendRank.get(guest.id) ?? null,
  points: guest.points,
  dateOfBirth: guest.dateOfBirth,
  birthday: guest.birthday,
  anniversaryDate: guest.anniversaryDate,
  anniversary: guest.anniversary,
  tags: guest.tags,
  reason: segment ? segment.reason(guest, context) : null,
});

const membersOf = (segment, guests, context) =>
  guests
    .filter((guest) => guest.tags.includes(segment.key))
    .sort((a, b) => segment.compare(a, b, context) || a.name.localeCompare(b.name));

const VISIT_BUCKETS = [
  { key: "1", label: "1 visit", min: 1, max: 1 },
  { key: "2-3", label: "2–3 visits", min: 2, max: 3 },
  { key: "4-6", label: "4–6 visits", min: 4, max: 6 },
  { key: "7+", label: "7+ visits", min: 7, max: Infinity },
];

// --- what the screen asks for -------------------------------------------------

// The whole picture: headline numbers, every segment's size, how often guests
// return, the best guests, and who is at a table right now.
const summary = async (restaurantId, now = new Date(), { reveal = true } = {}) => {
  const { guests, context } = await load(restaurantId, now);

  const visitors = guests.filter((guest) => guest.visits > 0);
  const repeaters = visitors.filter((guest) => guest.visits >= 2);
  const totalVisits = visitors.reduce((sum, guest) => sum + guest.visits, 0);
  const billedVisits = visitors.reduce((sum, guest) => sum + guest.billedVisits, 0);
  const spendPaise = visitors.reduce((sum, guest) => sum + guest.spendPaise, 0);
  const active = visitors.filter((guest) => guest.daysSinceLastVisit < ACTIVE_WINDOW_DAYS).length;
  const firstOfMonth = monthStart(context.today);
  const newThisMonth = visitors.filter((guest) => guest.firstVisitDate >= firstOfMonth).length;

  const segments = SEGMENTS.map((segment) =>
    describeSegment(segment, context, guests.filter((guest) => guest.tags.includes(segment.key)).length)
  );

  const distribution = VISIT_BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    count: visitors.filter((guest) => guest.visits >= bucket.min && guest.visits <= bucket.max).length,
  }));

  const topGuests = guests
    .filter((guest) => guest.spendPaise > 0)
    .sort((a, b) => b.spendPaise - a.spendPaise || a.name.localeCompare(b.name))
    .slice(0, TOP_GUESTS)
    .map((guest) => withContact(toRow(guest, null, context), reveal));

  const inHouse = await seatedNow(restaurantId, guests, context, now, reveal);

  return {
    asOf: now.toISOString(),
    today: context.today,
    timezone: context.timezone,
    currency: context.currency,
    history: {
      startsOn: context.historyStarts,
      days: context.historyStarts ? daysBetween(context.historyStarts, context.today) + 1 : 0,
    },
    kpis: {
      guestsOnFile: guests.length,
      activeGuests: active,
      activeShare: guests.length ? round2((active / guests.length) * 100) : 0,
      repeatRate: visitors.length ? round2((repeaters.length / visitors.length) * 100) : 0,
      averageVisits: visitors.length ? round2(totalVisits / visitors.length) : 0,
      averageSpendPerVisit: billedVisits ? round2(spendPaise / billedVisits / 100) : 0,
      newThisMonth,
      monthStart: firstOfMonth,
    },
    // The raw counts behind the ratios, so any of them can be checked by hand.
    totals: {
      visitors: visitors.length,
      repeaters: repeaters.length,
      neverVisited: guests.length - visitors.length,
      // Guests who cannot be on the birthday list however long it runs.
      withoutBirthday: guests.filter((guest) => !guest.dateOfBirth).length,
      withoutMobile: guests.filter((guest) => !guest.mobile).length,
      withoutEmail: guests.filter((guest) => !guest.email).length,
      inactiveGuests: context.inactiveGuests,
      visits: totalVisits,
      billedVisits,
      spend: fromPaise(spendPaise),
    },
    segments,
    distribution,
    topGuests,
    inHouse,
    loyalty: {
      enabled: context.loyaltyEnabled,
      minRedeem: context.minRedeem,
      pointValue: context.pointValue,
    },
    rules: {
      regularVisits: context.rules.guestRegularVisits,
      regularWindowDays: context.rules.guestRegularDays,
      activeWindowDays: ACTIVE_WINDOW_DAYS,
      newWindowDays: context.rules.guestNewDays,
      lapsedMinVisits: LAPSED_MIN_VISITS,
      lapsedQuietDays: context.rules.guestLapsedDays,
      bigSpenderSharePercent: context.rules.guestBigSpenderPercent,
      bigSpenderFrom: context.bigSpenderFrom,
      birthdayWindowDays: BIRTHDAY_WINDOW_DAYS,
      unhappyWindowDays: UNHAPPY_WINDOW_DAYS,
      unhappyMaxRating: UNHAPPY_MAX_RATING,
      seatedWithinHours: SEATED_WITHIN_HOURS,
    },
  };
};

// Guests we know who are at a table now, with what makes each worth a hello.
const seatedNow = async (restaurantId, guests, context, now, reveal = true) => {
  const seated = await guestInsightRepository.findSeatedGuests(restaurantId, SEATED_WITHIN_HOURS, now);
  const byId = new Map(guests.map((guest) => [guest.id, guest]));
  const present = seated.filter((row) => byId.has(row.customer_id));

  const favourites = await guestInsightRepository.findFavouriteDishes(
    restaurantId,
    [...new Set(present.map((row) => row.customer_id))]
  );
  const favouriteOf = new Map(favourites.map((row) => [row.customer_id, row.item_name]));

  return present.map((row) => {
    const guest = byId.get(row.customer_id);

    return {
      orderId: row.order_id,
      orderNumber: row.order_number,
      // "billed": the bill is on the table — the moment for a goodbye.
      stage: row.order_status === "billed" ? "billed" : "eating",
      tableNo: row.table_no,
      guestCount: row.guest_count,
      seatedAt: row.placed_at,
      favourite: favouriteOf.get(row.customer_id) || null,
      guest: withContact(toRow(guest, null, context), reveal),
    };
  });
};

// One segment's guests, in the order worth reading them.
const segmentList = async (
  restaurantId,
  key,
  { search = null, limit = DEFAULT_LIMIT, reveal = true } = {},
  now = new Date()
) => {
  const segment = findSegment(key);
  const { guests, context } = await load(restaurantId, now);

  const members = membersOf(segment, guests, context);
  const matching = members.filter((guest) => matchesSearch(guest, search, reveal));

  return {
    segment: describeSegment(segment, context, members.length),
    currency: context.currency,
    today: context.today,
    items: matching.slice(0, limit).map((guest) => withContact(toRow(guest, segment, context), reveal)),
    total: matching.length,
    limit,
  };
};

// A segment's guests for a CSV or a broadcast list: exactly the ones the
// screen is showing — the whole list, or only those matching the search box
// when something is typed in it. Every page of it, not just the rows drawn so
// far. The caller logs it. With reveal false the contacts are masked and the
// search finds numbers only as the list itself does (last 4 digits or the
// whole number), so an export cannot be used to probe a hidden number either.
const segmentExport = async (restaurantId, key, { search = null, reveal = true } = {}, now = new Date()) => {
  const segment = findSegment(key);
  const { guests, context } = await load(restaurantId, now);
  const members = membersOf(segment, guests, context);
  const matching = members.filter((guest) => matchesSearch(guest, search, reveal));

  if (matching.length > MAX_LIMIT) {
    const size = new Intl.NumberFormat("en-IN").format(matching.length);
    const cap = new Intl.NumberFormat("en-IN").format(MAX_LIMIT);

    throw new AppError(
      400,
      search
        ? `${size} guests on this list match “${search}”, and one export holds up to ${cap}. Type more of the name or mobile number to narrow it.`
        : `This list has ${size} guests, and one export holds up to ${cap}. Type part of a name or mobile number in the search box to export them a part at a time.`
    );
  }

  const rows = matching.map((guest) => withContact(toRow(guest, segment, context), reveal));

  return {
    segment: describeSegment(segment, context, members.length),
    search: search || null,
    currency: context.currency,
    today: context.today,
    items: rows,
    total: rows.length,
    // Guests with a mobile on file, whether or not this person may read it.
    withMobile: rows.filter((row) => row.mobile || row.mobileMasked).length,
    contactHidden: !reveal,
  };
};

// One guest by id, for a link into this screen (the bell's "your regular is
// at T5"): enough to title their history panel, or an empty list when the
// guest is not in this restaurant's book — deleted since the link was made,
// or never theirs. Both read the same, so a link cannot confirm that an id
// exists elsewhere. A list rather than a 404 because "nobody by that id" is
// an answer here, not a fault.
const findGuest = async (restaurantId, customerId, { reveal = true } = {}) => {
  requireRestaurantId(restaurantId);

  const row = await guestInsightRepository.findGuestById(restaurantId, customerId);
  const items = row
    ? [withContact({ id: row.id, name: row.name, mobile: row.mobile, status: row.status }, reveal)]
    : [];

  return { items, total: items.length };
};

module.exports = {
  summary,
  segmentList,
  segmentExport,
  findGuest,
  rankBySpend,
  SEGMENT_KEYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  // The rules a restaurant starts with. The bell reads each restaurant's own
  // through ruleSettings, as this screen does, so the two never disagree.
  rules: {
    REGULAR_VISITS,
    REGULAR_WINDOW_DAYS,
    NEW_WINDOW_DAYS,
    LAPSED_QUIET_DAYS,
    BIG_SPENDER_SHARE,
    SEATED_WITHIN_HOURS,
  },
  birthdayKeysFor,
  nextBirthday,
  nextAnniversary,
  daysBetween,
};
