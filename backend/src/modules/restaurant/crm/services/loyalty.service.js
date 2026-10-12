const pool = require("../../../../config/database");
const loyaltyRepository = require("../repositories/loyalty.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const AppError = require("../../../../utils/AppError");
const { toPaise } = require("../../../../utils/money");

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const zoneOf = (settings) => (settings && settings.timezone) || "Asia/Kolkata";

// The programme's rules as the screens use them.
const toRules = (settings) => ({
  enabled: Boolean(settings.loyalty_enabled),
  earnAmount: Number(settings.loyalty_earn_amount),
  pointValue: Number(settings.loyalty_point_value),
  minRedeem: Number(settings.loyalty_min_redeem),
  earnBasis: settings.loyalty_earn_basis || "total",
  maxRedeemPoints: settings.loyalty_max_redeem_points ? Number(settings.loyalty_max_redeem_points) : null,
  maxRedeemPercent: settings.loyalty_max_redeem_percent ? Number(settings.loyalty_max_redeem_percent) : null,
  expiryDays: settings.loyalty_expiry_days ? Number(settings.loyalty_expiry_days) : null,
});

// --- Redeeming ------------------------------------------------------------------

// The most points one bill may use under the rules, given what points come
// off (the food after every other discount, in rupees) — null for no limit.
// Points cannot pay for more than that food anyway (billPricing).
const redeemLimit = (settings, base) => {
  const value = Number(settings.loyalty_point_value) || 0;
  const limits = [];

  if (settings.loyalty_max_redeem_points) {
    limits.push(Number(settings.loyalty_max_redeem_points));
  }

  if (settings.loyalty_max_redeem_percent && value > 0) {
    const share = Math.floor((toPaise(base) * Number(settings.loyalty_max_redeem_percent)) / 100);
    limits.push(Math.floor(share / toPaise(value)));
  }

  return limits.length ? Math.max(0, Math.min(...limits)) : null;
};

// Refuses points beyond what one bill may use, saying the most it may: 800
// points on an 855 rupee dinner was accepted, leaving 55 rupees to pay.
// Called with the bill priced (billPricing), so the share is of this bill.
const assertRedeemAllowed = (settings, priced, requested) => {
  if (!requested || requested <= 0 || !priced) {
    return;
  }

  const base =
    Number(priced.subtotal) -
    Number(priced.itemDiscountAmount || 0) -
    Number(priced.couponDiscount || 0) -
    Number(priced.manualDiscountAmount || 0);
  const limit = redeemLimit(settings, base);

  if (limit !== null && requested > limit) {
    const why = [];

    if (settings.loyalty_max_redeem_points) {
      why.push(`${Number(settings.loyalty_max_redeem_points)} points a bill`);
    }

    if (settings.loyalty_max_redeem_percent) {
      why.push(`${Number(settings.loyalty_max_redeem_percent)}% of the bill`);
    }

    throw new AppError(
      400,
      limit > 0
        ? `At most ${limit} points can be used on this bill (the limit is ${why.join(" and ")}).`
        : `Points cannot be used on this bill (the limit is ${why.join(" and ")}).`,
      { reason: "points_limit", maxPoints: limit }
    );
  }
};

// --- Earning ----------------------------------------------------------------------

// What a bill earns under the restaurant's rules (settings as findSettings
// returns them). Kept with the repository's own rule so a payment at the till
// and the ledger write agree.
const pointsForBill = (settings, bill) =>
  loyaltyRepository.pointsForBill(
    {
      enabled: Boolean(settings.loyalty_enabled),
      earnAmount: Number(settings.loyalty_earn_amount),
      earnBasis: settings.loyalty_earn_basis || "total",
    },
    bill
  ).points;

// --- Expiry -------------------------------------------------------------------------

// One guest's expired points written off now (before the till says how many
// they may use). Never fails the caller: a guest whose expiry cannot be
// worked out keeps their points until the next try.
const expireGuest = async (restaurantId, customerId, db = null) => {
  if (!customerId) {
    return null;
  }

  try {
    return await loyaltyRepository.expireNow(restaurantId, customerId, db);
  } catch {
    return null;
  }
};

// Every guest's expired points, guest by guest (each in its own short
// transaction, so a till paying meanwhile waits for one guest at most).
// Run when a business day opens, and from the loyalty screen.
const sweepRestaurant = async (restaurantId) => {
  const settings = await restaurantRepository.findSettings(restaurantId);

  if (!settings || !settings.loyalty_expiry_days) {
    return { guests: 0, points: 0 };
  }

  const ids = await loyaltyRepository.findWithExpiredPoints(restaurantId);
  let guests = 0;
  let points = 0;

  for (const id of ids) {
    const done = await expireGuest(restaurantId, id);

    if (done && done.expired > 0) {
      guests += 1;
      points += done.expired;
    }
  }

  return { guests, points };
};

// --- The rules screen --------------------------------------------------------------

const getProgramme = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const timezone = zoneOf(settings);

  if (settings.loyalty_expiry_days) {
    await sweepRestaurant(restaurantId);
  }

  const [summary, soon] = await Promise.all([
    loyaltyRepository.programmeSummary(restaurantId, timezone, 30),
    settings.loyalty_expiry_days ? loyaltyRepository.expiringSoon(restaurantId, timezone, 30) : { points: 0, holders: 0 },
  ]);
  const value = Number(settings.loyalty_point_value) || 0;
  const held = Number(summary.points_held);

  return {
    rules: toRules(settings),
    summary: {
      pointsHeld: held,
      // What the points guests hold would take off their bills if all were
      // used today: the restaurant's promise, in rupees.
      valueHeld: Math.round(held * value * 100) / 100,
      holders: summary.holders,
      last30: {
        earned: Number(summary.earned),
        redeemed: Number(summary.redeemed),
        expired: Number(summary.expired),
      },
      expiringIn30Days: { points: soon.points, guests: soon.holders },
    },
  };
};

// data: { enabled, earnAmount, pointValue, minRedeem, earnBasis,
//         maxRedeemPoints, maxRedeemPercent, expiryDays } (checked by the controller)
const updateRules = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await restaurantRepository.findSettings(restaurantId);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE restaurant_settings
       SET loyalty_earn_amount = $2, loyalty_point_value = $3, loyalty_min_redeem = $4,
           loyalty_earn_basis = $5, loyalty_max_redeem_points = $6, loyalty_max_redeem_percent = $7,
           loyalty_expiry_days = $8, updated_by = $9
       WHERE restaurant_id = $1`,
      [
        restaurantId,
        data.earnAmount,
        data.pointValue,
        data.minRedeem,
        data.earnBasis,
        data.maxRedeemPoints,
        data.maxRedeemPercent,
        data.expiryDays,
        userId,
      ]
    );

    const wasOn = Boolean(before.loyalty_expiry_days);
    const isOn = Boolean(data.expiryDays);

    if (!wasOn && isOn) {
      const rules = await loyaltyRepository.readRules(client, restaurantId);
      await loyaltyRepository.setExpiryOfHeldPoints(client, restaurantId, loyaltyRepository.addDays(rules.today, data.expiryDays));
    } else if (wasOn && !isOn) {
      await loyaltyRepository.setExpiryOfHeldPoints(client, restaurantId, null);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { before: toRules(before), after: toRules(await restaurantRepository.findSettings(restaurantId)) };
};

// --- The receipt ----------------------------------------------------------------------

// Points a bill earned and the balance the guest had right after it, for the
// bill screen and the printed receipt.
const billPoints = async (restaurantId, billId) => {
  const row = await loyaltyRepository.findBillPoints(restaurantId, billId);

  return {
    pointsEarned: Number(row.earned) || 0,
    pointsTakenBack: Number(row.taken_back) || 0,
    pointsBalance: row.balance_after === null || row.balance_after === undefined ? null : Number(row.balance_after),
  };
};

module.exports = {
  toRules,
  redeemLimit,
  assertRedeemAllowed,
  pointsForBill,
  expireGuest,
  sweepRestaurant,
  getProgramme,
  updateRules,
  billPoints,
};
