const taxRateService = require("../services/taxRate.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");

const readBody = (body = {}) => ({
  name: v.requiredString(body.name, "Name", 80),
  percentage: v.requiredNumber(body.percentage, "Percentage", { min: 0, max: 100 }),
  // Optional: an exempt rate has no code.
  hsnCode: v.optionalString(body.hsnCode, "HSN/SAC code", 10),
  cessPercentage: v.optionalNumber(body.cessPercentage, "Cess", { min: 0, max: 100 }) ?? 0,
  isDefault: v.requiredBoolean(body.isDefault, "Default", false),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
  // Every dish on this rate moves to that one first (switching a rate off).
  moveProductsTo:
    body.moveProductsTo === undefined || body.moveProductsTo === null || body.moveProductsTo === ""
      ? null
      : v.requiredId(body.moveProductsTo, "Rate to move the dishes to"),
});

const list = async (req, res) => {
  const filters = {
    status: req.query.status
      ? v.requiredEnum(req.query.status, "Status", ["active", "inactive"])
      : null,
  };

  res.json({ success: true, data: await taxRateService.list(req.user.restaurantId, filters) });
};

const create = async (req, res) => {
  const rate = await taxRateService.create(req.user.restaurantId, readBody(req.body), req.user.id);

  logAction(req, "create", "tax_rate", rate);

  res.status(201).json({ success: true, message: "Tax rate added", data: rate });
};

const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Tax rate id");
  const rate = await taxRateService.update(
    req.user.restaurantId,
    id,
    readBody(req.body),
    req.user.id
  );

  logAction(req, "update", "tax_rate", rate);

  const notes = [
    rate.movedProducts ? `${rate.movedProducts} product${rate.movedProducts === 1 ? "" : "s"} moved to another rate` : null,
    rate.repricedProducts ? `${rate.repricedProducts} product${rate.repricedProducts === 1 ? "" : "s"} repriced` : null,
  ].filter(Boolean);

  res.json({
    success: true,
    message: notes.length ? `Tax rate saved · ${notes.join(" · ")}` : "Tax rate saved",
    data: rate,
  });
};

const remove = async (req, res) => {
  const id = v.requiredId(req.params.id, "Tax rate id");

  await taxRateService.remove(req.user.restaurantId, id);

  logAction(req, "delete", "tax_rate", { id });

  res.json({ success: true, message: "Tax rate deleted" });
};

module.exports = { list, create, update, remove };
