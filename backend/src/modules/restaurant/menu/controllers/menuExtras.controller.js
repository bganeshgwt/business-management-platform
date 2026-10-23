const menuExtrasService = require("../services/menuExtras.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { VARIANT_AUDIT_FIELDS, variantAuditView } = require("../services/menuCommon");

// Size and add-on prices are money like the dish price: every change is
// logged with the value before and after.
//
// forUpdate: a field an edit leaves out (undefined) keeps what the size or
// add-on has and is not written. Before, an edit that sent only a name and a
// price took the new-size defaults for the rest: the default size lost its
// default, a switched-off size came back on sale, an add-on's price dropped
// to ₹0 — the same harm the dish edit had.

const given = (value) => value !== undefined && value !== null && value !== "";

// --- Variants ---

// A size's price can be sent as what the guest pays (price) or as its
// difference from the dish price (priceDelta). The guest price is what a
// menu prints and what the sizes dialog shows; the server works out the
// difference against the dish price as it is now, not against a copy the
// screen loaded earlier.
const readVariantBody = (body = {}, forUpdate = false) => {
  const unlessLeftOut = (key, read) => (forUpdate && body[key] === undefined ? undefined : read());

  if (given(body.price) && given(body.priceDelta)) {
    throw new AppError(
      400,
      "Give the size's price (what the guest pays) or its difference from the dish price, not both"
    );
  }

  const byGuestPrice = given(body.price);
  const data = {
    name: unlessLeftOut("name", () => v.requiredString(body.name, "Variant name", 100)),
    price: byGuestPrice ? v.requiredNumber(body.price, "Price the guest pays", { min: 0, max: 9999999 }) : undefined,
    priceDelta: byGuestPrice
      ? undefined
      : unlessLeftOut(
          "priceDelta",
          () => v.optionalNumber(body.priceDelta, "Price difference", { min: -9999999, max: 9999999 }) ?? 0
        ),
    isDefault: unlessLeftOut("isDefault", () => v.requiredBoolean(body.isDefault, "Default", false)),
    sortOrder: unlessLeftOut(
      "sortOrder",
      () => v.optionalNumber(body.sortOrder, "Sort order", { min: 0, max: 9999 }) ?? 0
    ),
    status: unlessLeftOut("status", () => v.optionalEnum(body.status, "Status", ["active", "inactive"], "active")),
    // The size's name for the kitchen, in any script; empty clears it.
    kitchenName: unlessLeftOut("kitchenName", () => v.optionalString(body.kitchenName, "Kitchen name", 100)),
  };

  if (forUpdate && Object.values(data).every((value) => value === undefined)) {
    throw new AppError(400, "Nothing to change: send the size's name, price, default, order or status");
  }

  return data;
};

// "Butter Chicken · Half": the size's own name means nothing on its own in
// the activity log, and the dish's history finds deleted sizes by it.
const sizeLabel = (product, variant) => `${product.name} · ${variant.name}`;

const listVariants = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");

  res.json({
    success: true,
    data: await menuExtrasService.listVariants(req.user.restaurantId, productId),
  });
};

const createVariant = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");
  const { variant, product } = await menuExtrasService.createVariant(
    req.user.restaurantId,
    productId,
    readVariantBody(req.body),
    req.user.id
  );

  const view = variantAuditView(variant, product.price);

  logAction(req, "create", "product_variant", {
    id: variant.id,
    label: sizeLabel(product, variant),
    details: { price: view.price, difference: view.difference, default: view.default },
  });

  res.status(201).json({ success: true, message: "Variant added", data: variant });
};

const updateVariant = async (req, res) => {
  const id = v.requiredId(req.params.id, "Variant id");
  const { before, variant, product } = await menuExtrasService.updateVariant(
    req.user.restaurantId,
    id,
    readVariantBody(req.body, true),
    req.user.id
  );

  const changes = diff(
    variantAuditView(before, product.price),
    variantAuditView(variant, product.price),
    VARIANT_AUDIT_FIELDS
  );

  if (Object.keys(changes).length > 0) {
    logAction(req, "update", "product_variant", {
      id: variant.id,
      label: sizeLabel(product, variant),
      details: { changes },
    });
  }

  res.json({ success: true, message: "Variant updated", data: variant });
};

const removeVariant = async (req, res) => {
  const id = v.requiredId(req.params.id, "Variant id");

  const { variant, product } = await menuExtrasService.removeVariant(req.user.restaurantId, id);

  logAction(req, "delete", "product_variant", {
    id,
    label: sizeLabel(product, variant),
    details: { price: variantAuditView(variant, product.price).price },
  });

  res.json({ success: true, message: "Variant deleted" });
};

// --- Modifiers ---

const readModifierBody = (body = {}, forUpdate = false) => {
  const unlessLeftOut = (key, read) => (forUpdate && body[key] === undefined ? undefined : read());
  const data = {
    name: unlessLeftOut("name", () => v.requiredString(body.name, "Modifier name", 100)),
    price: unlessLeftOut("price", () => v.optionalNumber(body.price, "Price", { min: 0, max: 9999999 }) ?? 0),
    status: unlessLeftOut("status", () => v.optionalEnum(body.status, "Status", ["active", "inactive"], "active")),
    kitchenName: unlessLeftOut("kitchenName", () => v.optionalString(body.kitchenName, "Kitchen name", 100)),
  };

  if (forUpdate && Object.values(data).every((value) => value === undefined)) {
    throw new AppError(400, "Nothing to change: send the add-on's name, price or status");
  }

  return data;
};

const modifierAuditView = (modifier) => ({
  name: modifier.name,
  price: Number(modifier.price),
  status: modifier.status === "active" ? "Offered" : "Switched off",
  kitchenName: modifier.kitchenName || null,
});

const listModifiers = async (req, res) => {
  res.json({ success: true, data: await menuExtrasService.listModifiers(req.user.restaurantId) });
};

const createModifier = async (req, res) => {
  const modifier = await menuExtrasService.createModifier(
    req.user.restaurantId,
    readModifierBody(req.body),
    req.user.id
  );

  logAction(req, "create", "modifier", {
    id: modifier.id,
    label: modifier.name,
    details: { price: modifier.price },
  });

  res.status(201).json({ success: true, message: "Modifier created", data: modifier });
};

const updateModifier = async (req, res) => {
  const id = v.requiredId(req.params.id, "Modifier id");
  const { before, modifier } = await menuExtrasService.updateModifier(
    req.user.restaurantId,
    id,
    readModifierBody(req.body, true),
    req.user.id
  );

  const changes = diff(modifierAuditView(before), modifierAuditView(modifier), [
    "name",
    "price",
    "status",
    "kitchenName",
  ]);

  if (Object.keys(changes).length > 0) {
    logAction(req, "update", "modifier", { id: modifier.id, label: modifier.name, details: { changes } });
  }

  res.json({ success: true, message: "Modifier updated", data: modifier });
};

const removeModifier = async (req, res) => {
  const id = v.requiredId(req.params.id, "Modifier id");

  const modifier = await menuExtrasService.removeModifier(req.user.restaurantId, id);

  logAction(req, "delete", "modifier", { id, label: modifier.name, details: { price: modifier.price } });

  res.json({ success: true, message: "Modifier deleted" });
};

// --- Which modifiers a product offers ---

const listProductModifiers = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");

  res.json({
    success: true,
    data: await menuExtrasService.listProductModifiers(req.user.restaurantId, productId),
  });
};

const setProductModifiers = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");
  const modifierIds = v
    .requiredArray(req.body?.modifierIds, "Modifiers")
    .map((id) => v.requiredId(id, "Modifier id"));

  const { ids, product, before, after } = await menuExtrasService.setProductModifiers(
    req.user.restaurantId,
    productId,
    modifierIds,
    req.user.id
  );

  const changes = diff({ addOns: before }, { addOns: after }, ["addOns"]);

  if (Object.keys(changes).length > 0) {
    logAction(req, "update", "product_modifiers", { id: productId, label: product.name, details: { changes } });
  }

  res.json({ success: true, message: "Modifiers updated", data: ids });
};

module.exports = {
  listVariants,
  createVariant,
  updateVariant,
  removeVariant,
  listModifiers,
  createModifier,
  updateModifier,
  removeModifier,
  listProductModifiers,
  setProductModifiers,
};
