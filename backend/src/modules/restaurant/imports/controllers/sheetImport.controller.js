const stockImportService = require("../../inventory/services/stockImport.service");
const supplierImportService = require("../../purchasing/services/supplierImport.service");
const recipeImportService = require("../../menu/services/recipeImport.service");
const guestImportService = require("../../crm/services/guestImport.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");

// Spreadsheet imports for stock items, suppliers, recipes and the guest book
// (sweep SW-B-12, SW-B-13). The browser reads the file and posts plain rows
// (heading -> cell), so the API stays JSON. dryRun checks and previews; the
// real import sends the preview's fingerprint back, so what is written is
// what the person saw.

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const readRequest = (body = {}) => ({
  rows: v.requiredArray(body.rows, "Rows"),
  dryRun: v.requiredBoolean(body.dryRun, "Dry run", false),
  fileName: v.optionalString(body.fileName, "File name", 200),
  fingerprint: v.optionalString(body.fingerprint, "Preview check", 100),
});

// A check that finds problems still worked: the dry run answers 200 with
// them. A real import of a file with problems is refused, and nothing changes.
const answer = (res, result, dryRun, describe) => {
  if (!result.ok) {
    const count = plural(result.problems.length, "problem", "problems");

    return res.status(dryRun ? 200 : 400).json({
      success: dryRun,
      message: dryRun ? `${count} in the file. Fix them and check the file again.` : `${count} in the file. Nothing was imported.`,
      data: result,
    });
  }

  return res.json({ success: true, message: describe(result, dryRun), data: result });
};

const counts = (result, dryRun, noun) =>
  dryRun
    ? `Ready: ${result.created} new ${noun}, ${result.updated} to update, ${result.unchanged} unchanged`
    : `Imported: ${result.created} ${noun} added, ${result.updated} updated`;

// The activity log: one row for the import, with what it did, and one per
// record it changed, under the same names a change by hand uses.
const logImport = (req, entity, result, fileName, extra = {}) => {
  logAction(req, "import", entity, {
    label: fileName || "Spreadsheet import",
    details: { created: result.created, updated: result.updated, unchanged: result.unchanged, ...extra },
  });
};

// --- Stock items ---

const stockGuide = async (req, res) => {
  res.json({ success: true, data: stockImportService.importGuide() });
};

const importStockItems = async (req, res) => {
  const { rows, dryRun, fileName, fingerprint } = readRequest(req.body);
  const result = await stockImportService.importItems(req.user.restaurantId, rows, req.user.id, {
    dryRun,
    fingerprint,
    pinnedOutletId: req.outletPinned ? req.outletId : null,
  });

  if (result.ok && !dryRun) {
    logImport(req, "inventory_item", result, fileName, {
      openingStockItems: result.opening.items,
      openingStockValue: result.opening.value,
    });

    for (const item of result.createdItems || []) {
      logAction(req, "create", "inventory_item", { id: item.id, label: item.name, details: { via: "Stock import" } });
    }

    for (const row of result.rows.filter((entry) => entry.action === "update")) {
      logAction(req, "update", "inventory_item", {
        label: row.name,
        details: {
          via: "Stock import",
          changes: Object.fromEntries(row.changes.map((change) => [change.field, [change.from, change.to]])),
          ...(row.opening ? { openingStock: row.opening.quantity } : {}),
        },
      });
    }
  }

  return answer(res, result, dryRun, (data, check) => {
    const base = counts(data, check, "items");
    return data.opening.items > 0
      ? `${base}, opening stock for ${plural(data.opening.items, "item", "items")}${check ? "" : " posted"}`
      : base;
  });
};

// --- Suppliers ---

const supplierGuide = async (req, res) => {
  res.json({ success: true, data: supplierImportService.importGuide() });
};

const importSuppliers = async (req, res) => {
  const { rows, dryRun, fileName, fingerprint } = readRequest(req.body);
  const result = await supplierImportService.importSuppliers(req.user.restaurantId, rows, req.user.id, {
    dryRun,
    fingerprint,
  });

  if (result.ok && !dryRun) {
    logImport(req, "supplier", result, fileName);

    for (const supplier of result.createdSuppliers || []) {
      logAction(req, "create", "supplier", { id: supplier.id, label: supplier.name, details: { via: "Supplier import" } });
    }

    for (const row of result.rows.filter((entry) => entry.action === "update")) {
      logAction(req, "update", "supplier", {
        label: row.name,
        details: { via: "Supplier import", changes: Object.fromEntries(row.changes.map((change) => [change.field, [change.from, change.to]])) },
      });
    }
  }

  return answer(res, result, dryRun, (data, check) => counts(data, check, "suppliers"));
};

// --- Recipes ---

const recipeGuide = async (req, res) => {
  res.json({ success: true, data: recipeImportService.importGuide() });
};

const importRecipes = async (req, res) => {
  const { rows, dryRun, fileName, fingerprint } = readRequest(req.body);
  const result = await recipeImportService.importRecipes(req.user.restaurantId, rows, req.user.id, {
    dryRun,
    fingerprint,
  });

  if (result.ok && !dryRun) {
    logImport(req, "recipe", result, fileName, { dishes: result.dishes });
  }

  return answer(res, result, dryRun, (data, check) =>
    check
      ? `Ready: ${data.created} new recipe lines, ${data.updated} to change, ${data.unchanged} unchanged, across ${plural(data.dishes, "dish", "dishes")}`
      : `Imported: ${data.created} recipe lines added, ${data.updated} changed, across ${plural(data.dishes, "dish", "dishes")}`
  );
};

// --- Guests ---

const guestGuide = async (req, res) => {
  res.json({ success: true, data: guestImportService.importGuide() });
};

const importGuests = async (req, res) => {
  const { rows, dryRun, fileName, fingerprint } = readRequest(req.body);
  const mode = v.optionalEnum(req.body?.mode, "Guests already in the book", ["update", "skip"], "update");
  const result = await guestImportService.importGuests(req.user.restaurantId, rows, req.user.id, {
    dryRun,
    fingerprint,
    mode,
    // Staff who see guests' numbers masked see them masked in the preview too.
    reveal: (req.user.permissions || []).includes("customers.contact"),
  });

  if (result.ok && !dryRun) {
    logImport(req, "customer", result, fileName, {
      skipped: result.skipped,
      openingPoints: result.openingPoints.points,
      guestsGivenPoints: result.openingPoints.guests,
      mode,
    });

    for (const guest of result.applied.updated) {
      logAction(req, "update", "customer", {
        id: guest.id,
        label: guest.name,
        details: { via: "Guest import", changed: guest.changes },
      });
    }
  }

  return answer(res, result, dryRun, (data, check) => {
    const base = counts(data, check, "guests");
    const skipped = data.skipped ? `, ${data.skipped} already there and skipped` : "";
    const points = data.openingPoints.points
      ? `, ${data.openingPoints.points.toLocaleString("en-IN")} opening points for ${plural(data.openingPoints.guests, "guest", "guests")}`
      : "";
    return `${base}${skipped}${points}`;
  });
};

module.exports = {
  stockGuide,
  importStockItems,
  supplierGuide,
  importSuppliers,
  recipeGuide,
  importRecipes,
  guestGuide,
  importGuests,
};
