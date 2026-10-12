const restaurantFeatures = require("../services/restaurantFeatures.service");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

// Settings -> Features: which parts of the restaurant are switched on.

const list = async (req, res) => {
  res.json({ success: true, data: await restaurantFeatures.list(req.user) });
};

const readCode = (req) => v.requiredString(req.params.code, "Feature", 40);
const readEnabled = (body = {}) => {
  const enabled = v.requiredBoolean(body.enabled, "On or off");

  if (enabled === undefined) {
    throw new AppError(400, "Say whether the feature should be on or off");
  }

  return enabled;
};

// What switching it would do: what stands in the way, and what it will hide.
const preview = async (req, res) => {
  res.json({ success: true, data: await restaurantFeatures.preview(req.user, readCode(req), readEnabled(req.body)) });
};

const set = async (req, res) => {
  const result = await restaurantFeatures.set(req.user, readCode(req), readEnabled(req.body));
  const name = result.features.find((feature) => feature.code === result.code)?.name || result.code;

  res.json({
    success: true,
    message: result.changed ? `${name} is switched ${result.enabled ? "on" : "off"}` : `${name} was already ${result.enabled ? "on" : "off"}`,
    data: result,
  });
};

module.exports = { list, preview, set };
