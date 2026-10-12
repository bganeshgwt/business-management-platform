const comboService = require("../services/combo.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");

// "Dal ×1, Jeera Rice ×2": how a combo's parts read in the activity log.
const partsLine = (combo) =>
  combo.items.length === 0
    ? "not a combo"
    : combo.items
        .map((item) => `${item.productName}${item.variantName ? ` (${item.variantName})` : ""} ×${item.quantity}`)
        .join(", ");

const getForProduct = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");

  res.json({ success: true, data: await comboService.getForProduct(req.user.restaurantId, productId) });
};

// The whole list is posted at once: a combo is defined by all of its parts, so
// adding and removing them one at a time would leave it briefly wrong.
const setForProduct = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");
  const body = req.body || {};

  const items = v.requiredArray(body.items, "Items").map((item) => ({
    productId: v.requiredId(item.productId, "Dish"),
    productVariantId: v.optionalNumber(item.productVariantId, "Size", { min: 1 }),
    quantity: v.requiredNumber(item.quantity, "Quantity", { min: 0.01, max: 999 }),
  }));

  const { before, combo } = await comboService.setForProduct(
    req.user.restaurantId,
    productId,
    items,
    req.user.id
  );

  const changes = diff({ parts: partsLine(before) }, { parts: partsLine(combo) }, ["parts"]);

  if (Object.keys(changes).length > 0) {
    logAction(req, "update", "combo", { id: productId, label: combo.productName, details: { changes } });
  }

  res.json({ success: true, message: "Combo saved", data: combo });
};

// Emptying the list turns the dish back into an ordinary one.
const clearForProduct = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");

  const { before, combo } = await comboService.setForProduct(
    req.user.restaurantId,
    productId,
    [],
    req.user.id
  );

  logAction(req, "delete", "combo", {
    id: productId,
    label: combo.productName,
    details: { changes: { parts: [partsLine(before), partsLine(combo)] } },
  });

  res.json({ success: true, message: "Combo cleared", data: combo });
};

module.exports = { getForProduct, setForProduct, clearForProduct };
