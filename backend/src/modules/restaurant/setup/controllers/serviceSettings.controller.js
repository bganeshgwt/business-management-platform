const serviceSettingsService = require("../services/serviceSettings.service");
const onlineOrderService = require("../../online/services/onlineOrder.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const get = async (req, res) => {
  res.json({ success: true, data: await serviceSettingsService.get(req.user.restaurantId) });
};

const wholeMinutes = (value) => {
  if (value === undefined) {
    return undefined;
  }

  const minutes = v.requiredNumber(value, "Minutes a ready token stays on the screen", { min: 1, max: 120 });

  if (!Number.isInteger(minutes)) {
    throw new AppError(400, "Minutes a ready token stays on the screen must be a whole number");
  }

  return minutes;
};

const updateTokens = async (req, res) => {
  const body = req.body || {};
  const input = {
    tokensEnabled: body.tokensEnabled === undefined ? undefined : v.requiredBoolean(body.tokensEnabled, "Token numbers"),
    tokenOrderTypes:
      body.tokenOrderTypes === undefined
        ? undefined
        : [
            ...new Set(
              v
                .requiredArray(body.tokenOrderTypes, "Orders that get a token")
                .map((type) => v.requiredEnum(type, "Order that gets a token", serviceSettingsService.TOKEN_ORDER_TYPES))
            ),
          ],
    collectionClearMinutes: wholeMinutes(body.collectionClearMinutes),
  };

  const settings = await serviceSettingsService.updateTokens(req.user.restaurantId, input, req.user.id);

  logAction(req, "update", "service_settings", {
    label: "Token numbers and collection screen",
    details: {
      tokensEnabled: settings.tokensEnabled,
      orderTypes: settings.tokenOrderTypes,
      clearMinutes: settings.collectionClearMinutes,
    },
  });

  res.json({ success: true, message: "Token settings saved", data: settings });
};

// The POS's kinds of order (a cloud kitchen takes no dine-in) and its start.
const updatePos = async (req, res) => {
  const body = req.body || {};
  const input = {
    posOrderTypes: body.posOrderTypes === undefined ? undefined
      : [...new Set(v.requiredArray(body.posOrderTypes, "Kinds of order").map((type) => v.requiredEnum(type, "Kind of order", serviceSettingsService.POS_ORDER_TYPES)))],
    defaultOrderType: body.defaultOrderType === undefined ? undefined : v.requiredEnum(body.defaultOrderType, "A new order starts on", serviceSettingsService.POS_ORDER_TYPES),
  };
  const settings = await serviceSettingsService.updatePos(req.user.restaurantId, input, req.user.id);

  logAction(req, "update", "service_settings", { label: "POS order types", details: { orderTypes: settings.posOrderTypes, startsOn: settings.defaultOrderType } });
  res.json({ success: true, message: "POS order types saved", data: settings });
};

// The guest pages' web address (QR codes). Who may set up tables may set it.
const updateWebAddress = async (req, res) => {
  const body = req.body || {};
  const settings = await serviceSettingsService.updateWebAddress(
    req.user.restaurantId,
    body.guestWebAddress,
    req.user.id
  );

  logAction(req, "update", "service_settings", {
    label: "Guest ordering web address",
    details: { guestWebAddress: settings.guestWebAddress || "(the guest site's own address)" },
  });

  res.json({
    success: true,
    message: settings.guestWebAddress
      ? `QR codes now open ${settings.guestWebAddress}`
      : "QR codes now open the guest site's own address",
    data: settings,
  });
};

// ---------------------------------------------------------------- online ordering links

// A link id in the address; anything that cannot be one is a link that does
// not exist.
const readLinkId = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  const number = /^\d{1,16}$/.test(text) ? Number(text) : NaN;

  if (!Number.isSafeInteger(number) || number < 1) {
    throw new AppError(404, "Ordering link not found");
  }

  return number;
};

const wholeNumber = (value, field, min, max) => {
  if (value === undefined) {
    return undefined;
  }

  const number = v.requiredNumber(value, field, { min, max });

  if (!Number.isInteger(number)) {
    throw new AppError(400, `${field} must be a whole number`);
  }

  return number;
};

const optionalText = (value, field, maxLength) => {
  if (value === undefined) {
    return undefined;
  }

  if (value !== null && typeof value !== "string") {
    throw new AppError(400, `${field} must be text`);
  }

  return v.optionalString(value, field, maxLength);
};

const optionalBoolean = (value, field) => (value === undefined ? undefined : v.requiredBoolean(value, field));

const listOnlineLinks = async (req, res) => {
  res.json({ success: true, data: await onlineOrderService.listLinks(req.user.restaurantId) });
};

const updateOnlineLink = async (req, res) => {
  const id = readLinkId(req.params.id);
  const body = req.body || {};
  const minimum = body.minDeliveryOrder === undefined
    ? undefined
    : v.requiredNumber(body.minDeliveryOrder, "Minimum order for delivery", { min: 0, max: 100000 });

  const input = {
    enabled: optionalBoolean(body.enabled, "Online ordering"),
    takeawayEnabled: optionalBoolean(body.takeawayEnabled, "Takeaway"),
    deliveryEnabled: optionalBoolean(body.deliveryEnabled, "Delivery"),
    minDeliveryOrder: minimum === undefined ? undefined : Math.round(minimum * 100) / 100,
    pickupMinutes: wholeNumber(body.pickupMinutes, "Ready to collect in (minutes)", 5, 180),
    deliveryMinutes: wholeNumber(body.deliveryMinutes, "Delivered in (minutes)", 10, 240),
    maxOpenPerMobile: wholeNumber(body.maxOpenPerMobile, "Open orders per mobile", 1, 10),
    deliveryArea: optionalText(body.deliveryArea, "Delivery area", 200),
    guestNote: optionalText(body.guestNote, "Note for guests", 200),
  };

  const result = await onlineOrderService.updateLink(req.user.restaurantId, id, input, req.user.id);
  const changed = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

  logAction(req, "update", "online_ordering_link", {
    id,
    label: `Online ordering at ${result.place}`,
    details: changed,
  });

  res.json({
    success: true,
    message:
      input.enabled === true
        ? `Online ordering is on at ${result.place}`
        : input.enabled === false
          ? `Online ordering is off at ${result.place}`
          : `Online ordering at ${result.place} saved`,
    data: result.link,
  });
};

const replaceOnlineLink = async (req, res) => {
  const id = readLinkId(req.params.id);
  const result = await onlineOrderService.replaceLinkToken(req.user.restaurantId, id, req.user.id);

  logAction(req, "update", "online_ordering_link", {
    id,
    label: `New online ordering link for ${result.place}`,
    details: { replaced: true },
  });

  res.json({
    success: true,
    message: `New link made for ${result.place}. The old link no longer works — share this one instead.`,
    data: result.link,
  });
};

module.exports = { get, updateTokens, updateWebAddress, listOnlineLinks, updateOnlineLink, replaceOnlineLink, updatePos };
