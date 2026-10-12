const tipRepository = require("../repositories/tip.repository");
const queryAll = require("../../../../utils/queryAll");
const { localDate, safeZone } = require("./timeclock.service");
const timeclockRepository = require("../repositories/timeclock.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// Tips: collected at payment (the billing screen's tip box), shared out to the
// staff who earned them, and paid with their salary as a separate "Tips" line.
//
// How a share-out works, in the order a manager sees it:
//   1. the period's tips that no share-out has taken yet (and, when the
//      setting says so, the service charge of its paid bills);
//   2. with routing "captain", each tip on an order a captain took goes
//      straight to that captain; the rest is the pool;
//   3. the pool is split by hours worked (attendance) or by points per
//      designation times days worked, to the paisa: each share is rounded
//      down and the paise left over go one each to the largest remainders, so
//      the shares always add up exactly to the pool;
//   4. the manager sees every share, then confirms. Shares land in the pay
//      period holding the pay date.

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toPaise = (value) => Math.round(Number(value || 0) * 100);
const fromPaise = (paise) => round2(Number(paise) / 100);

const money = (value) =>
  `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dayWords = (value) =>
  new Date(`${String(value).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const timezoneOf = async (restaurantId) => safeZone(await timeclockRepository.findTimezone(restaurantId));

const today = async (restaurantId) => localDate(new Date(), await timezoneOf(restaurantId));

// --- Settings ---------------------------------------------------------------------

const toSettings = (row) => ({
  routing: row.routing,
  includeServiceCharge: Boolean(row.include_service_charge),
  shareBasis: row.share_basis,
  designationPoints: row.designation_points || {},
  defaultPoints: Number(row.default_points),
  updatedAt: row.updated_at || null,
});

const getSettings = async (restaurantId) => {
  requireRestaurantId(restaurantId);
  return toSettings(await tipRepository.findSettings(restaurantId));
};

const saveSettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await getSettings(restaurantId);
  const after = toSettings(await tipRepository.saveSettings(restaurantId, data, userId));

  return { before, after };
};

// --- Splitting money exactly ------------------------------------------------------

// Splits `totalPaise` by whole-number weights. Each share is rounded down;
// the paise left over go one each to the largest remainders (the earlier
// person in the list on a tie), so the shares add up exactly to the total.
const splitByWeight = (totalPaise, weights) => {
  const total = BigInt(totalPaise);
  const big = weights.map((weight) => BigInt(Math.max(0, Math.round(weight))));
  const sum = big.reduce((acc, weight) => acc + weight, 0n);

  if (sum === 0n) {
    return weights.map(() => 0);
  }

  const shares = big.map((weight) => (total * weight) / sum);
  const remainders = big.map((weight, index) => ({ index, rest: (total * weight) % sum }));
  let left = total - shares.reduce((acc, share) => acc + share, 0n);

  remainders.sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index));

  for (const { index } of remainders) {
    if (left === 0n) {
      break;
    }

    if (big[index] > 0n) {
      shares[index] += 1n;
      left -= 1n;
    }
  }

  return shares.map(Number);
};

// A designation's points: the restaurant's list, matched without regard to
// case or spaces; anything not listed gets the default.
const pointsFor = (designation, settings) => {
  const wanted = String(designation || "").trim().toLowerCase();
  const match = Object.entries(settings.designationPoints || {}).find(
    ([name]) => name.trim().toLowerCase() === wanted && wanted !== ""
  );

  return match ? Number(match[1]) : Number(settings.defaultPoints);
};

// --- What was collected -------------------------------------------------------------

const METHODS = ["cash", "card", "upi"];

const methodOf = (method) => (METHODS.includes(method) ? method : "other");

// Tips (and service charge) by day, with how much of each day is shared.
const collected = async (restaurantId, from, to) => {
  requireRestaurantId(restaurantId);

  const timezone = await timezoneOf(restaurantId);
  const settings = await getSettings(restaurantId);
  const [tips, charges] = await Promise.all([
    tipRepository.findTips(tipRepository.pool, restaurantId, from, to, timezone),
    settings.includeServiceCharge
      ? tipRepository.findServiceCharges(tipRepository.pool, restaurantId, from, to, timezone)
      : Promise.resolve([]),
  ]);

  const days = new Map();
  const dayOf = (date) => {
    if (!days.has(date)) {
      days.set(date, {
        date,
        count: 0,
        byMethod: { cash: 0, card: 0, upi: 0, other: 0 },
        tips: 0,
        serviceCharge: 0,
        shared: 0,
        unshared: 0,
      });
    }

    return days.get(date);
  };

  for (const tip of tips) {
    const day = dayOf(tip.day);
    const paise = toPaise(tip.tip_amount);
    day.count += 1;
    day.byMethod[methodOf(tip.payment_method)] += paise;
    day.tips += paise;
    day[tip.shareout_id ? "shared" : "unshared"] += paise;
  }

  for (const charge of charges) {
    const day = dayOf(charge.day);
    const paise = toPaise(charge.service_charge);
    day.serviceCharge += paise;
    day[charge.shareout_id ? "shared" : "unshared"] += paise;
  }

  const rows = [...days.values()]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((day) => ({
      ...day,
      byMethod: Object.fromEntries(Object.entries(day.byMethod).map(([key, paise]) => [key, fromPaise(paise)])),
      tips: fromPaise(day.tips),
      serviceCharge: fromPaise(day.serviceCharge),
      shared: fromPaise(day.shared),
      unshared: fromPaise(day.unshared),
    }));

  const sum = (pick) => round2(rows.reduce((total, row) => total + pick(row), 0));

  return {
    settings,
    days: rows,
    totals: {
      count: rows.reduce((total, row) => total + row.count, 0),
      tips: sum((row) => row.tips),
      cash: sum((row) => row.byMethod.cash),
      card: sum((row) => row.byMethod.card),
      upi: sum((row) => row.byMethod.upi),
      other: sum((row) => row.byMethod.other),
      serviceCharge: sum((row) => row.serviceCharge),
      shared: sum((row) => row.shared),
      unshared: sum((row) => row.unshared),
    },
  };
};

// --- Working out a share-out -------------------------------------------------------------

const assertPeriod = async (restaurantId, from, to) => {
  if (to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  const now = await today(restaurantId);

  if (to > now) {
    throw new AppError(
      400,
      `Tips can be shared up to today (${dayWords(now)}). The days after it have not been worked yet.`,
      { reason: "future_period" }
    );
  }
};

// The whole share-out as it would be confirmed: nothing is written.
// `db` lets confirm() work it out again inside its own transaction; the
// settings and time zone are read before it takes its connection.
const workOut = async (db, restaurantId, input, { settings, timezone }) => {
  const basis = input.basis || settings.shareBasis;
  const routing = settings.routing;
  const excluded = new Set((input.excludeEmployeeIds || []).map(Number));

  const [tips, charges, workers] = await queryAll(db, [
    () => tipRepository.findTips(db, restaurantId, input.from, input.to, timezone, { onlyUnshared: true }),
    () => settings.includeServiceCharge
      ? tipRepository.findServiceCharges(db, restaurantId, input.from, input.to, timezone, { onlyUnshared: true })
      : Promise.resolve([]),
    () => tipRepository.findWorkers(db, restaurantId, input.from, input.to),
  ]);

  // Straight to the captain, or into the pool.
  const directBy = new Map();
  let poolPaise = 0;
  let tipsPaise = 0;
  const payments = [];

  for (const tip of tips) {
    const paise = toPaise(tip.tip_amount);
    tipsPaise += paise;

    const captain =
      routing === "captain" && tip.captain_employee_id && !excluded.has(Number(tip.captain_employee_id))
        ? Number(tip.captain_employee_id)
        : null;

    payments.push({ id: tip.id, amount: fromPaise(paise), employeeId: captain });

    if (captain) {
      const row = directBy.get(captain) || { employeeId: captain, name: tip.captain_name, paise: 0, count: 0 };
      row.paise += paise;
      row.count += 1;
      directBy.set(captain, row);
    } else {
      poolPaise += paise;
    }
  }

  const chargePaise = charges.reduce((total, charge) => total + toPaise(charge.service_charge), 0);
  poolPaise += chargePaise;

  // The pool, by hours or by points x days.
  const eligible = workers
    .filter((row) => !excluded.has(Number(row.id)))
    .map((row) => {
      const days = Number(row.days_worked);
      const points = pointsFor(row.designation, settings);

      return {
        employeeId: Number(row.id),
        name: row.name,
        employeeCode: row.employee_code,
        designation: row.designation,
        department: row.department,
        workedMinutes: Number(row.worked_minutes),
        daysWorked: days,
        points,
        // Whole numbers for an exact split: minutes, or points in hundredths
        // times half-days.
        weight: basis === "hours" ? Number(row.worked_minutes) : Math.round(points * 100) * Math.round(days * 2),
      };
    })
    .filter((row) => row.weight > 0);

  const split = splitByWeight(poolPaise, eligible.map((row) => row.weight));
  const weightSum = eligible.reduce((total, row) => total + row.weight, 0);

  const pool = eligible.map((row, index) => ({
    ...row,
    sharePercent: weightSum ? round2((row.weight / weightSum) * 100) : 0,
    amount: fromPaise(split[index]),
  }));

  const direct = [...directBy.values()]
    .map((row) => ({ employeeId: row.employeeId, name: row.name, tips: row.count, amount: fromPaise(row.paise) }))
    .sort((a, b) => b.amount - a.amount);

  const directPaise = direct.reduce((total, row) => total + toPaise(row.amount), 0);
  const sharedPoolPaise = split.reduce((total, paise) => total + paise, 0);

  const warnings = [];

  if (poolPaise > 0 && eligible.length === 0) {
    warnings.push(
      basis === "hours"
        ? "Nobody has hours on the attendance sheet for these days, so the pool has no one to go to. Mark attendance first, or share by points."
        : "Nobody with points worked these days, so the pool has no one to go to. Check attendance and the points per designation."
    );
  }

  return {
    from: input.from,
    to: input.to,
    payDate: input.payDate || input.to,
    basis,
    routing,
    includeServiceCharge: settings.includeServiceCharge,
    tipsTotal: fromPaise(tipsPaise),
    tipCount: tips.length,
    serviceChargeTotal: fromPaise(chargePaise),
    billCount: charges.length,
    directTotal: fromPaise(directPaise),
    poolTotal: fromPaise(poolPaise),
    // Equal to poolTotal whenever anyone is eligible: checked on confirm.
    poolShared: fromPaise(sharedPoolPaise),
    direct,
    pool,
    excluded: [...excluded],
    warnings,
    // For confirm(): exactly what is being taken.
    payments,
    bills: charges.map((charge) => ({ id: charge.id, amount: round2(Number(charge.service_charge)) })),
  };
};

const preview = async (restaurantId, input) => {
  requireRestaurantId(restaurantId);
  await assertPeriod(restaurantId, input.from, input.to);

  const result = await workOut(tipRepository.pool, restaurantId, input, {
    settings: await getSettings(restaurantId),
    timezone: await timezoneOf(restaurantId),
  });
  const { payments, bills, ...visible } = result;

  return visible;
};

// Confirms a share-out. It is worked out again inside one transaction, and
// must match what the manager saw (the total they confirmed): tips taken at
// the till meanwhile, or a share-out someone else confirmed, mean the
// manager looks again rather than confirming figures they never saw.
const confirm = async (restaurantId, input, userId) => {
  requireRestaurantId(restaurantId);
  await assertPeriod(restaurantId, input.from, input.to);

  const payDate = input.payDate || input.to;

  if (payDate < input.from) {
    throw new AppError(400, "Pay the tips on a day inside or after the period they were earned in");
  }

  const context = { settings: await getSettings(restaurantId), timezone: await timezoneOf(restaurantId) };
  const client = await tipRepository.pool.connect();
  let shareoutId = null;
  let result = null;

  try {
    await client.query("BEGIN");
    // One share-out at a time per restaurant: the second waits, then finds
    // the tips already taken.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tip_shareout'), $1::int)", [Number(restaurantId) % 2147483647]);

    result = await workOut(client, restaurantId, { ...input, payDate }, context);
    const total = round2(result.tipsTotal + result.serviceChargeTotal);

    if (total <= 0) {
      throw new AppError(409, "There are no tips left to share for these days. They may have been shared already.", {
        reason: "nothing_to_share",
      });
    }

    if (input.expectedTotal !== undefined && input.expectedTotal !== null && Math.abs(Number(input.expectedTotal) - total) >= 0.005) {
      throw new AppError(
        409,
        `The tips for these days changed since you looked (now ${money(total)}, you saw ${money(input.expectedTotal)}). Check the shares again before confirming.`,
        { reason: "changed_since_preview", total }
      );
    }

    if (toPaise(result.poolTotal) > 0 && result.pool.length === 0) {
      throw new AppError(400, result.warnings[0], { reason: "nobody_to_share_with" });
    }

    // The shares must add up to the money, to the paisa.
    if (toPaise(result.poolShared) !== toPaise(result.poolTotal)) {
      throw new AppError(500, "The shares did not add up to the pool. Nothing was saved.");
    }

    const shares = [
      ...result.direct.map((row) => ({ employeeId: row.employeeId, kind: "direct", amount: row.amount })),
      ...result.pool
        .filter((row) => toPaise(row.amount) > 0)
        .map((row) => ({
          employeeId: row.employeeId,
          kind: "pool",
          amount: row.amount,
          workedMinutes: row.workedMinutes,
          daysWorked: row.daysWorked,
          points: row.points,
        })),
    ];

    // Each share lands in the pay period holding the pay date, which must
    // still be open for everyone in it.
    const people = [...new Set(shares.map((row) => row.employeeId))];
    const paid = await tipRepository.findPaidOn(client, restaurantId, people, payDate);

    if (paid.length > 0) {
      const first = paid[0];
      throw new AppError(
        409,
        `${first.name}'s pay for ${dayWords(first.period_from)} to ${dayWords(first.period_to)} is already marked paid, so tips cannot be added on ${dayWords(payDate)}. Choose a later pay date.`,
        { reason: "paid_period", employees: paid.map((row) => row.name) }
      );
    }

    shareoutId = await tipRepository.insertShareout(
      client,
      restaurantId,
      {
        from: input.from,
        to: input.to,
        payDate,
        basis: result.basis,
        routing: result.routing,
        tipsTotal: result.tipsTotal,
        serviceChargeTotal: result.serviceChargeTotal,
        directTotal: result.directTotal,
        poolTotal: result.poolTotal,
        note: input.note || null,
        payments: result.payments,
        bills: result.bills,
        shares,
      },
      userId
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");

    // Someone else's share-out took the same tips between our read and our
    // write (the lock makes this rare): look again.
    if (error.code === "23505") {
      throw new AppError(409, "Some of these tips were shared by someone else just now. Look at the period again.", {
        reason: "already_shared",
      });
    }

    throw error;
  } finally {
    client.release();
  }

  return { shareout: await getShareout(restaurantId, shareoutId), result };
};

const toShareout = (row, shares) => ({
  id: row.id,
  from: row.period_from,
  to: row.period_to,
  payDate: row.pay_date,
  basis: row.basis,
  routing: row.routing,
  tipsTotal: Number(row.tips_total),
  serviceChargeTotal: Number(row.service_charge_total),
  directTotal: Number(row.direct_total),
  poolTotal: Number(row.pool_total),
  total: round2(Number(row.tips_total) + Number(row.service_charge_total)),
  tipCount: row.tip_count,
  billCount: row.bill_count,
  note: row.note,
  createdAt: row.created_at,
  createdByName: row.created_by_name,
  shares: shares
    .filter((share) => Number(share.shareout_id) === Number(row.id))
    .map((share) => ({
      employeeId: share.employee_id,
      name: share.employee_name,
      designation: share.designation,
      kind: share.kind,
      workedMinutes: Number(share.worked_minutes),
      daysWorked: Number(share.days_worked),
      points: Number(share.points),
      amount: Number(share.amount),
    })),
});

const getShareout = async (restaurantId, id) => {
  const row = await tipRepository.findShareoutById(tipRepository.pool, restaurantId, id);

  if (!row) {
    throw new AppError(404, "Share-out not found");
  }

  return toShareout(row, await tipRepository.findShares(tipRepository.pool, restaurantId, [row.id]));
};

const listShareouts = async (restaurantId, from, to) => {
  requireRestaurantId(restaurantId);

  const rows = await tipRepository.findShareouts(restaurantId, from, to);
  const shares = await tipRepository.findShares(tipRepository.pool, restaurantId, rows.map((row) => row.id));

  return rows.map((row) => toShareout(row, shares));
};

// Each person's tips landing in the period, and whether that pay is paid.
const byPerson = async (restaurantId, from, to) => {
  requireRestaurantId(restaurantId);

  const rows = await tipRepository.findPersonTotals(restaurantId, from, to);

  return rows.map((row) => ({
    employeeId: row.employee_id,
    name: row.name,
    designation: row.designation,
    direct: Number(row.direct),
    pool: Number(row.pool),
    total: Number(row.total),
    shareouts: row.shareouts,
  }));
};

// Undoing a share-out frees its tips to be shared again. Not once anyone in
// it has been paid for the day the shares landed on: the money has gone.
const undo = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const client = await tipRepository.pool.connect();

  try {
    await client.query("BEGIN");

    const row = await tipRepository.findShareoutById(client, restaurantId, id);

    if (!row) {
      throw new AppError(404, "Share-out not found");
    }

    const shares = await tipRepository.findShares(client, restaurantId, [row.id]);
    const paid = await tipRepository.findPaidShares(client, restaurantId, id);

    if (paid.length > 0) {
      throw new AppError(
        409,
        `${paid[0].name}'s pay for ${dayWords(paid[0].period_from)} to ${dayWords(paid[0].period_to)} is already marked paid with these tips in it, so this share-out cannot be undone. Undo that payment on Payroll first.`,
        { reason: "paid_period" }
      );
    }

    await tipRepository.deleteShareout(client, restaurantId, id);
    await client.query("COMMIT");

    return toShareout(row, shares);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// One person's tips for a pay period, for payroll.
const tipsForPayroll = async (restaurantId, from, to, employeeId = null, db = undefined) => {
  const rows = await tipRepository.findPersonTotals(restaurantId, from, to, employeeId, db);
  return new Map(rows.map((row) => [Number(row.employee_id), round2(Number(row.total))]));
};

module.exports = {
  getSettings,
  saveSettings,
  collected,
  preview,
  confirm,
  listShareouts,
  getShareout,
  byPerson,
  undo,
  tipsForPayroll,
  splitByWeight,
  today,
};
