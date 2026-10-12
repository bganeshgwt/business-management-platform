const loyaltyService = require("../services/loyalty.service");
const restaurantFeatures = require("../../setup/services/restaurantFeatures.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");

// The loyalty programme: the points guests hold and the rules they earn and
// spend them by. Shown on Discounts & offers → Loyalty points.
const getProgramme = async (req, res) => {
  res.json({ success: true, data: await loyaltyService.getProgramme(req.user.restaurantId) });
};

// Every rule of the programme in one save, so the screen and the till never
// see half a change. Blank limits mean "no limit"; blank expiry, "never".
const readRules = (body = {}) => ({
  // On or off is the Loyalty points feature (Settings -> Features). Left out,
  // the switch stays as it is; sent, it switches the feature under the same
  // rules (Guests on, owner only, logged).
  enabled: body.enabled === undefined || body.enabled === null ? null : v.requiredBoolean(body.enabled, "Loyalty", false),
  earnAmount: v.requiredNumber(body.earnAmount, "Spend for one point", { min: 1, max: 999999 }),
  pointValue: v.requiredNumber(body.pointValue, "Value of one point", { min: 0.01, max: 9999 }),
  minRedeem: Math.round(v.requiredNumber(body.minRedeem, "Fewest points to redeem", { min: 0, max: 100000 })),
  earnBasis: v.requiredEnum(body.earnBasis, "Points are earned on", ["total", "pre_tax"]),
  maxRedeemPoints: (() => {
    const value = v.optionalNumber(body.maxRedeemPoints, "Most points on one bill", { min: 1, max: 1000000 });
    return value === null ? null : Math.round(value);
  })(),
  maxRedeemPercent: v.optionalNumber(body.maxRedeemPercent, "Most of a bill points may pay (%)", { min: 1, max: 100 }),
  expiryDays: (() => {
    const value = v.optionalNumber(body.expiryDays, "Points expire after (days)", { min: 1, max: 3650 });
    return value === null ? null : Math.round(value);
  })(),
});

const updateRules = async (req, res) => {
  const data = readRules(req.body);

  if (data.enabled !== null && data.enabled !== restaurantFeatures.has(req.user, "guest_loyalty")) {
    await restaurantFeatures.set(req.user, "guest_loyalty", data.enabled);
  }

  const { before, after } = await loyaltyService.updateRules(req.user.restaurantId, data, req.user.id);
  const changes = diff(before, after, [
    "enabled",
    "earnAmount",
    "pointValue",
    "minRedeem",
    "earnBasis",
    "maxRedeemPoints",
    "maxRedeemPercent",
    "expiryDays",
  ]);

  logAction(req, "update", "loyalty_rules", { label: "Loyalty points rules", details: { changes } });

  res.json({ success: true, message: "Loyalty rules saved", data: await loyaltyService.getProgramme(req.user.restaurantId) });
};

module.exports = {
  getProgramme,
  updateRules,
};
