// The service desk's settings: what the owner switches on for the floor, the
// counter and the kitchen (token numbers and the pickup screen, and the other
// service features that keep their switches here).
const serviceSettingsRepository = require("../repositories/serviceSettings.repository");
const AppError = require("../../../../utils/AppError");

const TOKEN_ORDER_TYPES = ["takeaway", "delivery", "online"];
const POS_ORDER_TYPES = ["dine_in", "takeaway", "delivery"];

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toSettings = (row) => ({
  // The address every table QR code opens; null: the guests' site's own.
  guestWebAddress: row.guest_web_address || null,
  tokensEnabled: Boolean(row.tokens_enabled),
  tokenOrderTypes: row.token_order_types || ["takeaway"],
  collectionClearMinutes: Number(row.collection_clear_minutes),
  // The kinds of order the POS takes and the one it starts on (the format's).
  posOrderTypes: row.pos_order_types || POS_ORDER_TYPES,
  defaultOrderType: row.default_order_type || "dine_in",
  updatedAt: row.updated_at,
});

const get = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  return toSettings(await serviceSettingsRepository.find(restaurantId));
};

// Only the fields sent change. Each is checked here; the column names are
// this file's own.
const updateTokens = async (restaurantId, input, userId) => {
  requireRestaurantId(restaurantId);

  const columns = {};

  if (input.tokensEnabled !== undefined) {
    columns.tokens_enabled = input.tokensEnabled;
  }

  if (input.tokenOrderTypes !== undefined) {
    if (input.tokenOrderTypes.length === 0) {
      throw new AppError(400, "Choose at least one kind of order that gets a token, or turn tokens off.");
    }

    columns.token_order_types = input.tokenOrderTypes;
  }

  if (input.collectionClearMinutes !== undefined) {
    columns.collection_clear_minutes = input.collectionClearMinutes;
  }

  return toSettings(await serviceSettingsRepository.update(restaurantId, columns, userId));
};

// The guest pages' web address, as a QR code will carry it: http(s), a host,
// at most a path in front of /order/<token>, no query and no trailing slash.
// Empty clears it (the staff screens then use the guests' site's own address,
// and warn when that is one guests' phones cannot reach).
const readWebAddress = (value) => {
  const text = String(value === undefined || value === null ? "" : value).trim();

  if (!text) {
    return null;
  }

  if (text.length > 200) {
    throw new AppError(400, "The guest ordering web address can be at most 200 characters.");
  }

  let url;

  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new AppError(400, `"${text}" is not a web address. Type it like https://order.myrestaurant.in`);
  }

  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new AppError(400, "The guest ordering web address must start with https:// (or http://).");
  }

  if (url.search || url.hash || url.username || url.password) {
    throw new AppError(
      400,
      "Type only the address itself, like https://order.myrestaurant.in — without anything after a ? or #."
    );
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
};

const updateWebAddress = async (restaurantId, value, userId) => {
  requireRestaurantId(restaurantId);

  return toSettings(
    await serviceSettingsRepository.update(restaurantId, { guest_web_address: readWebAddress(value) }, userId)
  );
};

// Which kinds of order the POS takes, and which a new order starts on.
const updatePos = async (restaurantId, input, userId) => {
  requireRestaurantId(restaurantId);
  const current = await serviceSettingsRepository.find(restaurantId);
  const types = input.posOrderTypes ?? current.pos_order_types;
  const start = input.defaultOrderType ?? (types.includes(current.default_order_type) ? current.default_order_type : types[0]);

  if (!types.length) {
    throw new AppError(400, "The POS must take at least one kind of order");
  }

  if (!types.includes(start)) {
    throw new AppError(400, "A new order can only start on a kind of order the POS takes");
  }

  return toSettings(await serviceSettingsRepository.update(restaurantId, { pos_order_types: types, default_order_type: start }, userId));
};

module.exports = { TOKEN_ORDER_TYPES, POS_ORDER_TYPES, get, updateTokens, updatePos, updateWebAddress };
