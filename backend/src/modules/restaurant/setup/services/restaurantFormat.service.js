// The restaurant's format: a full-service restaurant, a café, a bakery or a
// cloud kitchen. All four run on the same POS, menu, kitchen and day close;
// the format is what the place is called, how the POS opens (which kinds of
// order it takes, which one a new order starts on, whether parcels get a
// token) and which features it starts with. Choosing a format sets these
// once; the owner can change any of them afterwards, one by one.
const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");
const serviceSettingsRepository = require("../repositories/serviceSettings.repository");
const features = require("./restaurantFeatures.service");

const FORMATS = {
  restaurant: {
    label: "Restaurant",
    summary: "Tables, captains and the kitchen; dine-in, takeaway and delivery.",
    posOrderTypes: ["dine_in", "takeaway", "delivery"],
    defaultOrderType: "dine_in",
    tokens: null,
    features: {},
  },
  cafe: {
    label: "Café",
    summary: "Order and pay at the counter, a token number to collect; a few tables.",
    posOrderTypes: ["takeaway", "dine_in", "delivery"],
    defaultOrderType: "takeaway",
    tokens: ["takeaway"],
    features: { guests: true, preorders: true, captain_sections: false, reservations: false },
  },
  bakery: {
    label: "Bakery",
    summary: "Bakes made each morning from recipes, sold by the piece or by weight; cake orders with an advance; unsold counted at close.",
    posOrderTypes: ["takeaway", "delivery"],
    defaultOrderType: "takeaway",
    tokens: null,
    features: { guests: true, advances: true, stock_recipes: true, preorders: true, captain_sections: false, reservations: false, qr_ordering: false, kitchen_display: false, tips: false },
  },
  cloud_kitchen: {
    label: "Cloud kitchen",
    summary: "Delivery only: Swiggy, Zomato and the own app or phone; channel prices and commission; no tables.",
    posOrderTypes: ["delivery", "takeaway"],
    defaultOrderType: "delivery",
    tokens: ["delivery", "online", "takeaway"],
    features: { guests: true, deliveries: true, online_ordering: true, captain_sections: false, reservations: false, qr_ordering: false, tips: false },
  },
};
const FORMAT_CODES = Object.keys(FORMATS);

const describe = (code) => ({ code, label: FORMATS[code].label, summary: FORMATS[code].summary });
const list = () => FORMAT_CODES.map(describe);

const get = async (restaurantId) => {
  const row = (await pool.query("SELECT format FROM restaurants WHERE id = $1", [restaurantId])).rows[0];

  if (!row) {
    throw new AppError(404, "Restaurant not found");
  }

  return { ...describe(row.format), formats: list() };
};

// Sets the format and its starting setup. Features a format switches are
// changed one by one through the Features rules (a feature still in use,
// such as deliveries with rider cash out, is left as it is and reported);
// dependencies first when switching on, dependents first when switching off.
const apply = async (restaurantId, code, actor) => {
  const format = FORMATS[code];

  if (!format) {
    throw new AppError(400, `Choose the format: ${list().map((f) => f.label).join(", ")}`);
  }

  await pool.query("UPDATE restaurants SET format = $2, updated_at = NOW(), updated_by = $3 WHERE id = $1", [restaurantId, code, actor.id]);
  await serviceSettingsRepository.find(restaurantId);
  await pool.query(
    `UPDATE service_settings SET pos_order_types = $2, default_order_type = $3,
       tokens_enabled = CASE WHEN $4::text[] IS NULL THEN tokens_enabled ELSE TRUE END,
       token_order_types = COALESCE($4::text[], token_order_types), updated_by = $5, updated_at = NOW()
     WHERE restaurant_id = $1`,
    [restaurantId, format.posOrderTypes, format.defaultOrderType, format.tokens, actor.id]
  );

  const order = ["guests", "advances", "stock_recipes", "deliveries", "online_ordering", "preorders"];
  const changes = Object.entries(format.features).sort(([a, on], [b, onB]) => {
    if (on !== onB) {
      return on ? -1 : 1;
    }

    return on ? order.indexOf(a) - order.indexOf(b) : order.indexOf(b) - order.indexOf(a);
  });
  const skipped = [];

  for (const [feature, enabled] of changes) {
    try {
      await features.apply({ restaurantId, actor, code: feature, enabled, via: `format:${code}` });
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      skipped.push({ feature, enabled, reason: error.message });
    }
  }

  return { ...describe(code), skipped };
};

const set = async (user, code) => {
  if (!user.permissions?.includes(features.OWNER_PERMISSION)) {
    throw new AppError(403, "Only the owner can change the restaurant's format");
  }

  const result = await apply(user.restaurantId, code, user);
  return { ...result, formats: list() };
};

module.exports = { FORMATS, FORMAT_CODES, list, get, apply, set };
