const availabilityService = require("../services/availability.service");
const AppError = require("../../../../utils/AppError");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");

const optionalId = (value, field) =>
  value === undefined || value === null || value === "" ? null : v.requiredId(value, field);

const list = async (req, res) => {
  res.json({ success: true, data: await availabilityService.list(req.user.restaurantId, req.outletId || null) });
};

// { productId, productVariantId?, soldOut: true | false, note? }
const setSoldOut = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};

  if (typeof body.soldOut !== "boolean") {
    throw new AppError(400, "Say whether the dish is sold out (soldOut: true) or back on sale (soldOut: false)");
  }

  const input = {
    productId: v.requiredId(body.productId, "Dish"),
    productVariantId: optionalId(body.productVariantId, "Size"),
    soldOut: body.soldOut,
    note: v.optionalString(body.note, "Note", 120),
  };

  const result = await availabilityService.setSoldOut(req.user.restaurantId, input, req.user.id, req.outletId || null);

  // Only a real change is worth a line in the activity log: the owner reads
  // it to see what ran out when, and who said so.
  if (result.changed) {
    logAction(req, input.soldOut ? "sold_out" : "back_on_sale", "product", {
      id: result.product.id,
      label: result.label,
      details: {
        size: result.variant ? result.variant.name : undefined,
        businessDate: result.businessDate,
        note: input.note || undefined,
        until: input.soldOut ? "the next business day opens" : undefined,
      },
    });
  }

  res.json({ success: true, message: result.message, data: { changed: result.changed, ...result.list } });
};

const dishes = async (req, res) => {
  res.json({ success: true, data: await availabilityService.dishes(req.user.restaurantId) });
};

module.exports = {
  dishes,
  list,
  setSoldOut,
};
