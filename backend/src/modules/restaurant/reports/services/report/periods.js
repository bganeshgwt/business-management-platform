// Month ranges and the cost-sharing rules shared by the P&L and the expense report.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const outletRepository = require("../../../setup/repositories/outlet.repository");
const { round2 } = require("../../../../../utils/money");
const gst = require("../../../billing/services/gstBreakdown");

// ---------------------------------------------------------------------------
// Profit & loss, expenses
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// The calendar months a range touches, each clipped to the range: 10 Jul to
// 20 Sep is 10–31 Jul, Aug, and 1–20 Sep.
const monthsIn = (from, to) => {
  const months = [];
  let [year, month] = from.split("-").map(Number);
  const [endYear, endMonth] = to.split("-").map(Number);

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const start = `${key}-01`;
    const end = `${key}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`;

    months.push({
      key,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      from: start < from ? from : start,
      to: end > to ? to : end,
      partial: start < from || end > to,
    });

    month += 1;

    if (month === 13) {
      month = 1;
      year += 1;
    }
  }

  return months;
};

// A P&L line: a total and one figure per month, in paise until the end.
const plLine = (months, key, label, extra = {}) => ({
  key,
  label,
  byMonth: new Map(months.map((month) => [month.key, 0])),
  ...extra,
});

const addTo = (line, monthKey, paise) => {
  if (line.byMonth.has(monthKey)) {
    line.byMonth.set(monthKey, line.byMonth.get(monthKey) + paise);
  }
};

const combine = (months, key, label, parts, extra = {}) => {
  const line = plLine(months, key, label, extra);

  for (const month of months) {
    line.byMonth.set(
      month.key,
      parts.reduce((sum, [part, sign]) => sum + sign * part.byMonth.get(month.key), 0)
    );
  }

  return line;
};

const lineOut = (months, line) => {
  const byMonth = months.map((month) => gst.rupees(line.byMonth.get(month.key)));

  return {
    key: line.key,
    label: line.label,
    kind: line.kind || "item",
    section: line.section,
    hint: line.hint || null,
    amount: round2(byMonth.reduce((sum, value) => sum + value, 0)),
    byMonth,
  };
};

// Net revenue by month, in paise, the way the P&L reads it: sales before GST,
// less discounts, plus service charge and round off, less refunds before GST.
// One revenueByMonth row's sales before GST: dishes less discounts, plus
// service charge, delivery charges and round off.
const netOfRow = (row) =>
  gst.toPaise(row.gross_sales) -
  gst.toPaise(row.discounts) +
  gst.toPaise(row.service_charge) +
  gst.toPaise(row.delivery_charges) +
  gst.toPaise(row.round_off);

const netRevenueByMonth = (months, revenue, refunds) => {
  const byMonth = new Map(months.map((month) => [month.key, 0]));
  const add = (key, paise) => {
    if (byMonth.has(key)) {
      byMonth.set(key, byMonth.get(key) + paise);
    }
  };

  for (const row of revenue) {
    add(
      row.month,
      netOfRow(row)
    );
  }

  for (const row of refunds) {
    add(row.month, -(gst.toPaise(row.amount) - gst.toPaise(row.tax_part)));
  }

  return byMonth;
};

// Sales taken with no outlet picked belong to no outlet. When costs are
// shared they are a bucket of their own, so no outlet carries their part.
const NO_OUTLET = "none";

const bucketOf = (outletId) => (outletId === null || outletId === undefined ? NO_OUTLET : String(outletId));

const monthLabel = (key) => {
  const [year, month] = key.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
};

// Net revenue in paise by month and bucket (an outlet, or NO_OUTLET), each
// bucket rounded exactly as its own outlet P&L rounds it.
const netRevenueByBucket = (revenue, refunds) => {
  const table = new Map();
  const add = (month, outletId, paise) => {
    if (!table.has(month)) {
      table.set(month, new Map());
    }

    const row = table.get(month);
    const bucket = bucketOf(outletId);
    row.set(bucket, (row.get(bucket) || 0) + paise);
  };

  for (const row of revenue) {
    add(
      row.month,
      row.outlet_id,
      netOfRow(row)
    );
  }

  for (const row of refunds) {
    add(row.month, row.outlet_id, -(gst.toPaise(row.amount) - gst.toPaise(row.tax_part)));
  }

  return table;
};

// What a month's costs are shared by: each bucket's net revenue. A bucket
// that took nothing, or refunded more than it sold, weighs nothing.
const salesWeights = (row) => {
  const weights = new Map();

  for (const [bucket, paise] of row || []) {
    if (paise > 0) {
      weights.set(bucket, paise);
    }
  }

  return weights;
};

const weightTotal = (weights) => [...(weights || new Map()).values()].reduce((sum, value) => sum + value, 0);

// Paise shared between buckets in proportion to their weights — exactly.
// Every paisa goes somewhere: each bucket gets its whole paise, and the few
// left over by the rounding go to the largest remainders (ties by outlet, so
// the same figures always come out). Rounding each outlet's share on its own
// lost or invented paise: three equal outlets each carried ₹33.33 of ₹100.00
// of rent, and their profits added up to a paisa more than the restaurant's.
// BigInt, because paise times a month's sales in paise passes 2^53.
const allocate = (paise, weights) => {
  const result = new Map();
  const entries = [...(weights || new Map()).entries()].filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + BigInt(weight), 0n);

  if (paise === 0 || total === 0n) {
    return result;
  }

  const sign = paise < 0 ? -1n : 1n;
  const amount = BigInt(Math.abs(paise));
  let given = 0n;

  const parts = entries.map(([bucket, weight]) => {
    const exact = amount * BigInt(weight);
    const whole = exact / total;
    given += whole;
    return { bucket, whole, rest: exact % total };
  });

  parts.sort((a, b) =>
    a.rest === b.rest ? a.bucket.localeCompare(b.bucket, "en", { numeric: true }) : a.rest > b.rest ? -1 : 1
  );

  let left = amount - given;

  for (const part of parts) {
    if (left === 0n) {
      break;
    }

    part.whole += 1n;
    left -= 1n;
  }

  for (const part of parts) {
    result.set(part.bucket, Number(part.whole * sign));
  }

  return result;
};

// How the costs recorded for the whole restaurant are shared between its
// outlets, month by month.
//
// Rent, power, the manager's salary and the main store's kitchen issues are
// recorded for the whole restaurant, not for one outlet. An outlet's P&L that
// left them out showed its whole revenue as profit and told the owner there
// were no expenses. They are shared out by sales instead — the usual way an
// Indian restaurant group charges head-office costs to its branches — month
// by month, so a branch that opened mid-quarter carries nothing before it
// traded.
//
// A month with no sales at all — the rent and deposits before opening, a
// month closed for renovation — still has costs. It is shared the way the
// nearest month that did trade was: the same month over its full length
// first, then the next month that traded (pre-opening money follows the
// sales it was spent for), then the last one before it. A restaurant that
// has never traded shares them equally between its open outlets. Before
// this, such a month was shared by nobody and its costs fell out of every
// outlet's P&L.
//
// Sales taken with no outlet picked carry their own share, so the outlets'
// P&Ls plus that share always add up to the restaurant's, to the paisa.
const shareBasis = async (context, months) => {
  const { scope } = context;
  const whole = { ...scope, outletId: null };
  const [revenue, refunds, revenueByOutlet, refundsByOutlet] = await Promise.all([
    reportRepository.revenueByMonth(whole),
    reportRepository.refundsByMonth(whole),
    reportRepository.revenueByMonth(whole, { byOutlet: true }),
    reportRepository.refundsByMonth(whole, { byOutlet: true }),
  ]);
  const wholeNet = netRevenueByMonth(months, revenue, refunds);
  const buckets = netRevenueByBucket(revenueByOutlet, refundsByOutlet);
  const own = bucketOf(scope.outletId);

  // Every month the restaurant ever traded, read only when a month in the
  // range had no sales.
  let traded = null;
  const tradedMonths = async () => {
    if (!traded) {
      const ever = { ...whole, from: "0001-01-01", to: "9999-12-31" };
      const [everRevenue, everRefunds] = await Promise.all([
        reportRepository.revenueByMonth(ever, { byOutlet: true }),
        reportRepository.refundsByMonth(ever, { byOutlet: true }),
      ]);

      traded = [...netRevenueByBucket(everRevenue, everRefunds).entries()]
        .map(([key, row]) => ({ key, weights: salesWeights(row) }))
        .filter((month) => weightTotal(month.weights) > 0)
        .sort((a, b) => a.key.localeCompare(b.key));
    }

    return traded;
  };

  let openOutlets = null;
  const weights = new Map();
  const basis = new Map();

  for (const month of months) {
    const inMonth = salesWeights(buckets.get(month.key));

    if (weightTotal(inMonth) > 0) {
      weights.set(month.key, inMonth);
      basis.set(month.key, { kind: "sales" });
      continue;
    }

    const history = await tradedMonths();
    const nearest =
      history.find((row) => row.key === month.key) ||
      history.find((row) => row.key > month.key) ||
      [...history].reverse().find((row) => row.key < month.key);

    if (nearest) {
      weights.set(month.key, nearest.weights);
      basis.set(month.key, { kind: nearest.key === month.key ? "sameMonth" : "nearest", month: nearest.key });
      continue;
    }

    if (!openOutlets) {
      const outlets = await outletRepository.findAll(scope.restaurantId);
      const active = outlets.filter((outlet) => outlet.status === "active");
      openOutlets = active.length > 0 ? active : outlets;
    }

    weights.set(month.key, new Map(openOutlets.map((outlet) => [bucketOf(outlet.id), 1])));
    basis.set(month.key, { kind: "equal", outlets: openOutlets.length });
  }

  // The range's revenue: the whole restaurant's, the outlet's own, and what
  // was taken with no outlet (the whole less every outlet's, so the three
  // always reconcile to the P&L lines).
  let wholeTotal = 0;
  let ownTotal = 0;
  let taggedTotal = 0;

  for (const month of months) {
    wholeTotal += wholeNet.get(month.key);

    for (const [bucket, paise] of buckets.get(month.key) || []) {
      if (bucket === NO_OUTLET) {
        continue;
      }

      taggedTotal += paise;

      if (bucket === own) {
        ownTotal += paise;
      }
    }
  }

  const untagged = wholeTotal - taggedTotal;
  const percentOf = (part) => (wholeTotal > 0 ? round2(Math.min(100, Math.max(0, (part / wholeTotal) * 100))) : 0);

  return {
    own,
    weights,
    basis,
    // Over the whole range, for the sentence on screen.
    percent: percentOf(ownTotal),
    // The share actually applied each month.
    byMonth: months.map((month) => {
      const monthWeights = weights.get(month.key);
      const total = weightTotal(monthWeights);
      return total > 0 ? round2(((monthWeights.get(own) || 0) / total) * 100) : 0;
    }),
    wholeRevenue: gst.rupees(wholeTotal),
    untaggedRevenue: untagged,
    untaggedPercent: wholeTotal > 0 ? round2((untagged / wholeTotal) * 100) : 0,
  };
};

// A pool of whole-restaurant money (paise by month): one bucket's part of it
// (the outlet's own, unless another is asked for).
const shareOfPool = (months, pool, shares, bucket = shares.own) =>
  new Map(
    months.map((month) => [
      month.key,
      allocate(pool.get(month.key) || 0, shares.weights.get(month.key)).get(bucket) || 0,
    ])
  );

const sumOf = (byMonth) => [...byMonth.values()].reduce((sum, value) => sum + value, 0);

// The sentences that say how a month with no sales was shared — only for the
// months that actually had shared costs.
const fallbackNotes = (months, shares, hadCosts) =>
  months
    .filter((month) => shares.basis.get(month.key).kind !== "sales" && hadCosts(month.key))
    .map((month) => {
      const how = shares.basis.get(month.key);
      const span = month.partial ? `${month.label} (${month.from} to ${month.to})` : month.label;

      if (how.kind === "sameMonth") {
        return `${span} had no sales in the days read, so its restaurant-wide costs are shared the way the whole of ${month.label} traded.`;
      }

      if (how.kind === "nearest") {
        return `${span} had no sales, so its restaurant-wide costs are shared the way ${monthLabel(how.month)} traded — the nearest month with sales.`;
      }

      return `${span} had no sales and the restaurant has never traded, so its restaurant-wide costs are shared equally between the ${how.outlets} open ${how.outlets === 1 ? "outlet" : "outlets"}.`;
    });

module.exports = {
  monthsIn,
  plLine,
  addTo,
  combine,
  lineOut,
  NO_OUTLET,
  shareBasis,
  shareOfPool,
  sumOf,
  fallbackNotes,
};
