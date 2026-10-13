// What has run out, what is about to at the rate the kitchen is actually
// using it, and a day when an unusual amount went in the bin.
//
// A reorder level cannot say "at 3 kg a day, the chicken you have lasts until
// tomorrow lunch" — which is the difference between ordering today and running
// out mid-service. This provider knows the rate, so it is the one voice for a
// stock-out and for "running out": the core stock alerts (stock.js) leave every
// item this provider speaks for alone, and keep only what it does not cover —
// an item at its reorder level with days to spare, or with no recent use.
// Both read the same picture of the stock, worked out once per bell poll (see
// pictureFor), so every short item is spoken for exactly once.
//
// The rate comes from the same service as the Waste & reorder screen, so the
// bell and the screen work out "how long something lasts" the same way. The
// plan behind it is at most a couple of minutes old; the stock it is measured
// against is read fresh on every poll.
const inventoryInsightService = require("../../modules/restaurant/inventory/services/inventoryInsight.service");
const inventoryInsightRepository = require("../../modules/restaurant/inventory/repositories/inventoryInsight.repository");
const { completeContext } = require("..");

const NAMED_LIMIT = 5;
// How many of the rest a summary names before it says "and more".
const SAMPLE = 4;

// The plan reads a fortnight of stock movements for every active item, and the
// bell asks every 30 seconds for every signed-in person. "Runs out by tomorrow"
// does not change from one half-minute to the next, so one plan per restaurant
// is shared for a couple of minutes. It is worked out again sooner when
// the day changes, or when this module logs or undoes waste or makes a draft
// order (the service's plan version moves on).
const PLAN_TTL_MS = 2 * 60 * 1000;
const plans = new Map();

const planFor = (restaurantId, businessDate, now) => {
  const version = inventoryInsightService.planVersion(restaurantId);
  const held = plans.get(restaurantId);

  if (
    held &&
    held.businessDate === businessDate &&
    held.version === version &&
    Date.now() - held.at < PLAN_TTL_MS
  ) {
    return held.plan;
  }

  // The promise is what is kept, so two polls arriving together share one
  // calculation instead of both starting their own.
  // The restaurant's own horizon, look-back and safety days (no horizon
  // given), so the bell's plan is the one the reorder screen opens on.
  const plan = inventoryInsightService.reorder(restaurantId, {}, now);

  plans.set(restaurantId, { plan, businessDate, version, at: Date.now() });
  // A failed calculation is not kept: the next poll tries again.
  plan.catch(() => {
    if (plans.get(restaurantId)?.plan === plan) {
      plans.delete(restaurantId);
    }
  });

  return plan;
};

// Under a day left is an order that has to go today; under two is tomorrow's.
const CRITICAL_COVER_DAYS = 1;
const WARNING_COVER_DAYS = 2;

// A day's waste is worth a mention when it is over this much AND well above
// the restaurant's own normal. A fixed floor alone would nag a busy kitchen
// every night; a ratio alone would shout about ₹40 after a quiet week.
const WASTE_FLOOR = 1000;
const WASTE_TIMES_USUAL = 2;
const USUAL_DAYS = 14;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// 2.500 kg reads as "2.5 kg"; a whole number of pieces stays whole.
const quantity = (value, unit) => {
  const number = Number(value);
  const text = Number.isInteger(number)
    ? String(number)
    : number.toLocaleString("en-IN", { maximumFractionDigits: 2 });

  return `${text} ${unit}`;
};

const addDays = (isoDate, days) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "22 Sep", built by hand: en-IN spells September "Sept".
const dateLabel = (isoDate) => {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
};

// "Paneer, Cream, Butter, Ghee" — and "and 3 more" past the sample.
const sampleNames = (lines, restCount) => {
  const names = lines.slice(0, SAMPLE).map((line) => line.name);
  return restCount > names.length ? `${names.join(", ")} and ${restCount - names.length} more` : names.join(", ");
};

// What is already being done about it, or what to do.
const nextStep = (line, businessDate) => {
  const sent = (line.orders || []).filter((order) => order.status !== "draft");
  const draft = (line.orders || []).find((order) => order.status === "draft");

  if (sent.length > 0) {
    const first = sent[0];
    const when = first.expectedDate
      ? first.expectedDate < businessDate
        ? `was due ${dateLabel(first.expectedDate)}`
        : first.expectedDate === businessDate
          ? "due today"
          : `due ${dateLabel(first.expectedDate)}`
      : "on order";

    return `${first.poNumber} ${when} (${quantity(line.onOrder, line.unit)})`;
  }

  if (draft) {
    return `${draft.poNumber} is still a draft — send it to the supplier`;
  }

  if (line.suggestedQuantity > 0) {
    return `order about ${quantity(line.suggestedQuantity, line.unit)}${
      line.supplier ? ` from ${line.supplier.name}` : ""
    }`;
  }

  return null;
};

// ---------------------------------------------------------------- the picture
//
// Each item the plan knows, with its stock as it is right now and its days of
// cover worked out again from that — plus any item that has hit zero since the
// plan was made (a new item, say). Out of stock is a fact of this moment, so
// the bell never says "has run out" about something delivered a minute ago,
// nor misses something that ran out a minute ago.

const round1 = (value) => Math.round(value * 10) / 10;

// The same figure the reorder screen shows: stock over daily use, to a tenth.
const coverOf = (stock, dailyUsage) => (dailyUsage > 0 ? round1(Math.max(0, stock) / dailyUsage) : null);

const isOut = (line) => line.currentStock <= 0;

const isRunningOut = (line) =>
  !isOut(line) && line.dailyUsage > 0 && line.daysOfCover !== null && line.daysOfCover < WARNING_COVER_DAYS;

const buildPicture = async ({ restaurantId, businessDate, now, pool }) => {
  const plan = await planFor(restaurantId, businessDate, now);

  // Read live: every item the kitchen is using (its cover depends on the
  // stock now), every item the plan had at zero (it may have been restocked),
  // and every active item at zero now.
  const watched = plan.items
    .filter((line) => line.dailyUsage > 0 || line.currentStock <= 0)
    .map((line) => line.id);

  const live = await pool.query(
    `SELECT i.id, i.name, i.status, i.current_stock, i.reorder_level, i.updated_at,
            u.short_name AS unit
     FROM inventory_items i
     JOIN units u ON u.id = i.unit_id
     WHERE i.restaurant_id = $1
       AND ((i.status = 'active' AND i.current_stock <= 0) OR i.id = ANY($2::bigint[]))`,
    [restaurantId, watched]
  );

  const liveById = new Map(live.rows.map((row) => [Number(row.id), row]));
  const lines = [];

  for (const line of plan.items) {
    const row = liveById.get(Number(line.id));
    liveById.delete(Number(line.id));

    if (!row) {
      // Not in use and not at zero, then or now: nothing here can change.
      lines.push(line);
      continue;
    }

    // Switched off since the plan was made: not the bell's business.
    if (row.status !== "active") {
      continue;
    }

    const stock = Number(row.current_stock);
    lines.push({
      ...line,
      currentStock: stock,
      daysOfCover: coverOf(stock, line.dailyUsage),
      updatedAt: row.updated_at,
    });
  }

  // At zero now, and new since the plan: nothing is known about its use yet.
  for (const row of liveById.values()) {
    if (row.status !== "active") {
      continue;
    }

    lines.push({
      id: Number(row.id),
      name: row.name,
      unit: row.unit,
      currentStock: Number(row.current_stock),
      reorderLevel: Number(row.reorder_level),
      dailyUsage: 0,
      daysOfCover: null,
      orders: [],
      onOrder: 0,
      suggestedQuantity: 0,
      supplier: null,
      updatedAt: row.updated_at,
    });
  }

  const byName = (a, b) => a.name.localeCompare(b.name) || Number(a.id) - Number(b.id);

  // Out: the ones in use first (a dish needs them tonight), then the rest.
  const out = lines
    .filter(isOut)
    .sort((a, b) => Number(b.dailyUsage > 0) - Number(a.dailyUsage > 0) || byName(a, b));

  // Running out: soonest first.
  const runningOut = lines
    .filter(isRunningOut)
    .sort((a, b) => a.daysOfCover - b.daysOfCover || byName(a, b));

  return {
    out,
    runningOut,
    // How far back the plan read usage, for "not used in the last … days".
    usageDays: plan.usageDays,
    // What the core stock alerts must leave alone.
    coveredIds: new Set([...out, ...runningOut].map((line) => Number(line.id))),
  };
};

// Both providers of one poll must see the same picture, or an item could
// slip between them (neither speaks) or be claimed by both. The registry
// hands every provider of a poll the same `now`, so the picture is kept per
// restaurant, business day and `now` for the length of a poll — and dropped
// at once if the plan behind it changes (waste logged, a draft order made).
//
// It resolves to { picture }, or to { error } when the picture cannot be had
// within PICTURE_WAIT_MS (a failed or slow calculation). Then this provider
// reports that it could not check, and the stock alerts fall back to naming
// every short item themselves — still once each, because this provider has
// said nothing. The deadline sits well inside the bell's own time limit, so
// both providers always reach the same verdict before it.
const PICTURE_WAIT_MS = 2500;
const PICTURE_KEEP_MS = 60 * 1000;
const pictures = new Map();

const pictureFor = (context) => {
  const key = [
    context.restaurantId,
    context.businessDate,
    context.now.getTime(),
    inventoryInsightService.planVersion(context.restaurantId),
  ].join("|");
  const held = pictures.get(key);

  if (held) {
    return held.promise;
  }

  for (const [oldKey, old] of pictures) {
    if (Date.now() - old.at > PICTURE_KEEP_MS) {
      pictures.delete(oldKey);
    }
  }

  let timer;
  const promise = Promise.race([
    buildPicture(context).then(
      (picture) => ({ picture }),
      (error) => ({ error })
    ),
    new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ error: new Error(`the stock picture took over ${PICTURE_WAIT_MS} ms`) }),
        PICTURE_WAIT_MS
      );
    }),
  ]).finally(() => clearTimeout(timer));

  pictures.set(key, { promise, at: Date.now() });
  return promise;
};

// For stock.js: the ids of the items this provider speaks for in this poll,
// or null when it has nothing to say about stock (and so the stock alerts
// must say everything).
const coveredItemIds = async (context) => {
  const { picture } = await pictureFor(completeContext(context));
  return picture ? picture.coveredIds : null;
};

// ---------------------------------------------------------------- alerts

const outAlert = (line, businessDate, now, usageDays = inventoryInsightService.USAGE_DAYS) => {
  const inUse = line.dailyUsage > 0;

  return {
    id: `inventoryInsights:out:${line.id}`,
    severity: "critical",
    title: inUse ? `${line.name} has run out` : `${line.name} is out of stock`,
    detail: [
      // Billing may take stock below zero rather than refuse a guest's
      // order, so a negative figure means the count is wrong, not just low.
      line.currentStock < 0
        ? `Stock shows ${quantity(line.currentStock, line.unit)} — more was used than recorded, count it`
        : null,
      inUse
        ? `uses about ${quantity(line.dailyUsage, line.unit)} a day`
        : `not used in the last ${usageDays} days`,
      nextStep(line, businessDate) || "not on order — raise a purchase order",
    ]
      .filter(Boolean)
      .join(" · "),
    link: "/inventory/insights?tab=reorder",
    category: "Stock",
    at: new Date(line.updatedAt || now).toISOString(),
  };
};

const runningOutAlert = (line, businessDate, now) => {
  const severity = line.daysOfCover < CRITICAL_COVER_DAYS ? "critical" : "warning";

  return {
    // Severity in the id: crossing from "tomorrow" to "today" is a new
    // situation and should come back unread. Running right out is a new
    // alert of its own (above).
    id: `inventoryInsights:runout:${line.id}:${severity}`,
    severity,
    title:
      severity === "critical"
        ? `${line.name} will run out today at this rate`
        : `${line.name} will run out by tomorrow at this rate`,
    detail: [
      `${quantity(line.currentStock, line.unit)} left`,
      `uses about ${quantity(line.dailyUsage, line.unit)} a day`,
      nextStep(line, businessDate),
    ]
      .filter(Boolean)
      .join(" · "),
    link: "/inventory/insights?tab=reorder",
    category: "Stock",
    at: now.toISOString(),
  };
};

const stockAlerts = ({ out, runningOut, usageDays }, businessDate, now) => {
  const alerts = out.slice(0, NAMED_LIMIT).map((line) => outAlert(line, businessDate, now, usageDays));

  if (out.length > NAMED_LIMIT) {
    const rest = out.slice(NAMED_LIMIT);
    const newest = Math.max(...rest.map((line) => new Date(line.updatedAt || now).getTime()));

    alerts.push({
      // One id, with the items behind it as members: restocking one leaves
      // this read, another item running out makes it news.
      id: "inventoryInsights:out-more",
      members: rest.map((line) => `item:${line.id}`),
      severity: "critical",
      title: `${plural(rest.length, "more item", "more items")} out of stock`,
      detail: sampleNames(rest, rest.length),
      link: "/inventory/insights?tab=reorder",
      category: "Stock",
      at: new Date(newest).toISOString(),
    });
  }

  alerts.push(...runningOut.slice(0, NAMED_LIMIT).map((line) => runningOutAlert(line, businessDate, now)));

  if (runningOut.length > NAMED_LIMIT) {
    const rest = runningOut.slice(NAMED_LIMIT);
    // Soonest first, so the first of the rest decides the worst of them.
    const worst = rest[0].daysOfCover < CRITICAL_COVER_DAYS ? "critical" : "warning";

    alerts.push({
      // One id per severity, with the items behind it as members.
      id: `inventoryInsights:runout-more:${worst}`,
      members: rest.map((line) => `item:${line.id}`),
      severity: worst,
      title: `${plural(rest.length, "more item runs", "more items run")} out within 2 days at this rate`,
      detail: sampleNames(rest, rest.length),
      link: "/inventory/insights?tab=reorder",
      category: "Stock",
      at: now.toISOString(),
    });
  }

  return alerts;
};

// An unusually wasteful day, or null.
const wasteAlert = async ({ restaurantId, businessDate, now, money }) => {
  const [today, usual, reasons] = await Promise.all([
    inventoryInsightRepository.wastageTotals(
      restaurantId,
      { from: businessDate, to: businessDate },
      { from: businessDate, to: businessDate }
    ),
    inventoryInsightRepository.wastageTotals(
      restaurantId,
      { from: addDays(businessDate, -USUAL_DAYS), to: addDays(businessDate, -1) },
      { from: addDays(businessDate, -USUAL_DAYS), to: addDays(businessDate, -1) }
    ),
    inventoryInsightRepository.wastageByReason(restaurantId, businessDate, businessDate),
  ]);

  const value = Number(today.value);
  const usualPerDay = Number(usual.value) / USUAL_DAYS;
  const threshold = Math.max(WASTE_FLOOR, usualPerDay * WASTE_TIMES_USUAL);

  if (value <= threshold) {
    return null;
  }

  const top = reasons[0];
  const known = top && inventoryInsightService.REASONS.find((reason) => reason.key === top.reason);
  // Waste written off through Stock out carries no reason; say so plainly.
  const mostly = !top
    ? null
    : known
      ? `mostly ${known.label.toLowerCase()}`
      : "mostly with no reason given";

  return {
    // Comes back unread each time the day crosses another multiple of the
    // threshold — a second bin of spoiled cream is news; one more tomato is not.
    id: `inventoryInsights:waste-today:${businessDate}:${Math.floor(value / threshold)}`,
    severity: "info",
    title: `${money(value)} of stock thrown away today`,
    detail: [
      plural(Number(today.entries), "entry", "entries"),
      usualPerDay > 0
        ? `about ${Math.round((value / usualPerDay) * 10) / 10}× the usual ${money(Math.round(usualPerDay))} a day`
        : null,
      mostly,
    ]
      .filter(Boolean)
      .join(" · "),
    link: `/inventory/insights?tab=wastage&from=${businessDate}&to=${businessDate}`,
    category: "Stock",
    at: now.toISOString(),
  };
};

async function collectAlerts(context) {
  const { businessDate, now } = context;

  const [{ picture, error }, waste] = await Promise.all([
    pictureFor(context),
    // The waste figures failing must not take the stock-outs down with them:
    // the stock alerts have left those to this provider.
    wasteAlert(context).catch((failure) => {
      console.error("inventoryInsights notifications (waste):", failure.message);
      return null;
    }),
  ]);

  if (!picture) {
    // Rejected, so the bell says "could not check" rather than "all clear" —
    // and the stock alerts, seeing no picture either, name every short item.
    throw error;
  }

  return [...stockAlerts(picture, businessDate, now), ...(waste ? [waste] : [])];
}

module.exports = {
  key: "inventoryInsights",
  // Slow back-office checks: the answer is shared for this long (see the
  // cache in ../index.js). Live-service alerts declare none.
  cacheSeconds: 30,
  permission: "inventory.view",
  // Not asked while this restaurant feature is switched off (Settings -> Features).
  feature: "stock_recipes",

  collect: (context) => collectAlerts(completeContext(context)),

  // Shared with stock.js, which must say nothing about these items.
  coveredItemIds,
};
