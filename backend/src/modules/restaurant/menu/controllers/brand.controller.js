const brandService = require("../services/brand.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

// Brands: one kitchen selling under several names (feature "brands").

const readBrand = (body = {}) => ({
  name: v.requiredString(body.name, "Brand name", 80),
  tagline: v.optionalString(body.tagline, "Tagline", 150) || null,
  color: body.color ? (/^#[0-9a-f]{6}$/i.test(body.color) ? body.color : (() => { throw new AppError(400, "Colour must look like #1f8a70"); })()) : null,
  sortOrder: v.optionalNumber(body.sortOrder, "Display order", { min: 0, max: 9999 }) ?? 0,
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});
const day = (value, field) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(400, `${field} must be a date (YYYY-MM-DD)`);
  }

  return value;
};

const list = async (req, res) => {
  res.json({ success: true, data: await brandService.list(req.user.restaurantId) });
};

const create = async (req, res) => {
  const brand = await brandService.save(req.user.restaurantId, null, readBrand(req.body), req.user.id);
  logAction(req, "create", "brand", { id: brand.id, label: brand.name });
  res.status(201).json({ success: true, message: `${brand.name} added`, data: brand });
};

const update = async (req, res) => {
  const brand = await brandService.save(req.user.restaurantId, v.requiredId(req.params.id, "Brand"), readBrand(req.body), req.user.id);
  logAction(req, "update", "brand", { id: brand.id, label: brand.name, details: { status: brand.status } });
  res.json({ success: true, message: `${brand.name} saved`, data: brand });
};

const report = async (req, res) => {
  const from = day(req.query.from, "From"), to = day(req.query.to, "To");

  if (to < from) {
    throw new AppError(400, "The end date is before the start date");
  }

  res.json({ success: true, data: await brandService.report(req.user.restaurantId, { from, to }) });
};

module.exports = { list, create, update, report };
