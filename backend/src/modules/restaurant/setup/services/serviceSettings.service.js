// The service desk's settings: what the owner switches on for the floor, the
// counter and the kitchen (token numbers and the pickup screen, and the other
// service features that keep their switches here).
const serviceSettingsRepository = require("../repositories/serviceSettings.repository");
const AppError = require("../../../../utils/AppError");
const webAddress = require("../../../../utils/webAddress");

const TOKEN_ORDER_TYPES = ["takeaway", "delivery", "online"];
const POS_ORDER_TYPES = ["dine_in", "takeaway", "delivery"];
// A restaurant's courses start as these three; it keeps one to six.
const COURSE_NAMES = ["Starters", "Mains", "Desserts"];
const MAX_COURSES = 6;
const COURSE_NAME_LENGTH = 30;

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
  // The courses' names, course 1 first: the captain app sends dishes under
  // them and the KOT prints the name.
  courseNames: row.course_names || COURSE_NAMES,
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
// at most a path in front of /order/<token>, no query and no trailing slash
// (utils/webAddress.js, which reads GUEST_WEB_URL the same way). Empty clears
// it (the guests' site's own address is used then, and the staff screens
// warn when that is one guests' phones cannot reach).
const WEB_ADDRESS_PROBLEMS = {
  too_long: () => `The guest ordering web address can be at most ${webAddress.MAX_LENGTH} characters.`,
  not_an_address: (text) => `"${text}" is not a web address. Type it like https://order.myrestaurant.in`,
  not_http: () => "The guest ordering web address must start with https:// (or http://).",
  extra: () => "Type only the address itself, like https://order.myrestaurant.in — without anything after a ? or #.",
};

const readWebAddress = (value) => {
  const { address, problem } = webAddress.readWebAddress(value);

  if (problem) {
    throw new AppError(400, WEB_ADDRESS_PROBLEMS[problem](String(value).trim()));
  }

  return address;
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

// The courses' names, in the order they are served: the first is course 1.
// Each is tidied of extra spaces; one to six, none empty or the same as
// another, each at most 30 characters. A dish keeps the name it was sent
// under; a renamed course changes only what is sent after.
const updateCourses = async (restaurantId, names, userId) => {
  requireRestaurantId(restaurantId);

  const tidy = names.map((name) => String(name ?? "").replace(/\s+/g, " ").trim());

  if (tidy.length === 0 || tidy.length > MAX_COURSES) {
    throw new AppError(400, `Keep between one and ${MAX_COURSES} courses.`);
  }

  if (tidy.some((name) => name === "")) {
    throw new AppError(400, "Give every course a name, or take it off the list.");
  }

  const tooLong = tidy.find((name) => name.length > COURSE_NAME_LENGTH);

  if (tooLong) {
    throw new AppError(400, `"${tooLong.slice(0, 40)}" is too long for a course: use at most ${COURSE_NAME_LENGTH} characters.`);
  }

  const seen = new Set();

  for (const name of tidy) {
    if (seen.has(name.toLowerCase())) {
      throw new AppError(400, `"${name}" is on the list twice. Each course needs a name of its own.`);
    }

    seen.add(name.toLowerCase());
  }

  return toSettings(await serviceSettingsRepository.update(restaurantId, { course_names: tidy }, userId));
};

module.exports = { TOKEN_ORDER_TYPES, POS_ORDER_TYPES, COURSE_NAMES, get, updateTokens, updatePos, updateWebAddress, updateCourses };
