const recipeService = require("../services/recipe.service");
const { logAction } = require("../../../../utils/audit");
const auditRepository = require("../../../access/repositories/audit.repository");
const v = require("../../../../utils/validate");

// Costs and margins are for whoever prices the menu or runs the stores. The
// recipe itself (what is in the dish) is open to anyone who can see the menu.
const canSeeCosts = (req) => {
  const granted = req.user.permissions || [];

  return granted.includes("menu.manage") || granted.includes("inventory.view");
};

const getForProduct = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");

  res.json({
    success: true,
    data: await recipeService.listForProduct(req.user.restaurantId, productId, {
      showCosts: canSeeCosts(req),
    }),
  });
};

const addLine = async (req, res) => {
  const productId = v.requiredId(req.params.productId, "Product id");
  const body = req.body || {};

  // "Start this size from the dish recipe": copies every dish ingredient onto
  // the size, scaled, as its own recipe to adjust.
  if (body.copyFromDish === true) {
    const variantId = v.requiredId(body.productVariantId, "Size");
    const factor = v.requiredNumber(body.factor ?? 1, "Size factor", { min: 0.05, max: 10 });
    const recipe = await recipeService.copyDishToSize(
      req.user.restaurantId,
      productId,
      variantId,
      factor,
      req.user.id
    );

    logAction(req, "create", "recipe_line", {
      id: productId,
      label: recipe.productName,
      details: { size: variantId, copiedFromDish: true, factor },
    });

    res.status(201).json({ success: true, message: "Size recipe started from the dish", data: recipe });
    return;
  }

  const data = {
    inventoryItemId: v.requiredId(body.inventoryItemId, "Inventory item"),
    productVariantId: v.optionalNumber(body.productVariantId, "Size", { min: 1 }),
    quantity: v.requiredNumber(body.quantity, "Quantity", { min: 0.0001, max: 999999 }),
  };

  const recipe = await recipeService.addLine(req.user.restaurantId, productId, data, req.user.id);

  logAction(req, "create", "recipe_line", {
    id: productId,
    label: recipe.productName,
    details: { size: data.productVariantId || "dish" },
  });

  res.status(201).json({ success: true, message: "Ingredient added", data: recipe });
};

const updateLine = async (req, res) => {
  const id = v.requiredId(req.params.id, "Recipe line id");
  const quantity = v.requiredNumber(req.body?.quantity, "Quantity", { min: 0.0001, max: 999999 });

  const recipe = await recipeService.updateLine(req.user.restaurantId, id, quantity, req.user.id);

  logAction(req, "update", "recipe_line", { id, label: recipe.productName, details: { quantity } });

  res.json({ success: true, message: "Ingredient updated", data: recipe });
};

const removeLine = async (req, res) => {
  const id = v.requiredId(req.params.id, "Recipe line id");
  const recipe = await recipeService.removeLine(req.user.restaurantId, id);

  logAction(req, "delete", "recipe_line", { id, label: recipe.productName });

  res.json({ success: true, message: "Ingredient removed", data: recipe });
};

// PUT /inventory/recipe-sizes/:variantId { recipeFactor: 0.5 | null }
const setSizeFactor = async (req, res) => {
  const variantId = v.requiredId(req.params.variantId, "Size id");
  const factor = v.optionalNumber(req.body?.recipeFactor, "Size factor", { min: 0.05, max: 10 });

  const { variant, recipe } = await recipeService.setSizeFactor(
    req.user.restaurantId,
    variantId,
    factor,
    req.user.id
  );

  logAction(req, "update", "recipe_size", {
    id: variantId,
    label: `${recipe.productName} · ${variant.name}`,
    details: { recipeFactor: factor },
  });

  res.json({
    success: true,
    message:
      factor === null
        ? `${variant.name} now uses the full dish recipe`
        : `${variant.name} now uses ${factor} × the dish recipe`,
    data: recipe,
  });
};

// --- Audit log ---

const auditLog = async (req, res) => {
  const filters = {
    entityType: v.optionalString(req.query.entityType, "Entity", 50),
    action: v.optionalString(req.query.action, "Action", 50),
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 500 }) ?? 200,
  };

  const { rows, total } = await auditRepository.findAll(req.user.restaurantId, filters);

  res.json({
    success: true,
    data: {
      items: rows.map((row) => ({
        id: row.id,
        userName: row.user_name,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityLabel: row.entity_label,
        details: row.details,
        createdAt: row.created_at,
      })),
      total,
      limit: filters.limit,
    },
  });
};

module.exports = { getForProduct, addLine, updateLine, removeLine, setSizeFactor, auditLog };
