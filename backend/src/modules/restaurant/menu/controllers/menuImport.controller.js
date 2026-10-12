const menuImportService = require("../services/menuImport.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");

const exportProducts = async (req, res) => {
  const data = await menuImportService.exportProducts(req.user.restaurantId);

  res.json({ success: true, data });
};

// The columns explained, and a sample sheet in this restaurant's own words.
const importGuide = async (req, res) => {
  res.json({ success: true, data: await menuImportService.importGuide(req.user.restaurantId) });
};

// The activity log gets one row per dish the import added or changed, with
// the old and new value of every field, plus one row for the import itself.
// "Who changed the price of Paneer Tikka?" has the same answer whether it was
// changed by hand or by a spreadsheet.
const logImport = (req, result, fileName) => {
  const via = `Menu import${fileName ? ` (${fileName})` : ""}`;

  for (const row of result.rows) {
    if (row.action === "create") {
      logAction(req, "create", "product", {
        id: row.productId,
        label: row.name,
        details: { via, ...row.details },
      });
    } else if (row.action === "update") {
      const changes = {};

      // Written under the same names a change made by hand uses, so the dish's
      // history reads the same either way.
      for (const entry of row.changes) {
        if (entry.field === "size") {
          changes[`${entry.size} price`] = [entry.from, entry.to];
        } else if (entry.field === "isAvailable") {
          changes.available = [true, false];
        } else if (entry.field === "sortOrder") {
          changes.displayOrder = [entry.from, entry.to];
        } else {
          changes[entry.field] = [entry.from, entry.to];
        }
      }

      logAction(req, "update", "product", { id: row.productId, label: row.name, details: { via, changes } });
    }
  }

  for (const change of result.addOnPriceChanges) {
    logAction(req, "update", "modifier", {
      id: change.id,
      label: change.name,
      details: { via, changes: { price: [change.from, change.to] } },
    });
  }

  logAction(req, "import", "product", {
    id: null,
    label: fileName || "Menu import",
    details: {
      created: result.created,
      updated: result.updated,
      addOnPricesChanged: result.addOnPriceChanges.length,
      newCategories: result.newCategories.map((row) => row.name),
      newAddOns: result.newAddOns.map((row) => row.name),
    },
  });
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// What the import did (or would do), every kind of change counted. An add-on
// repriced by the file changes the bill on every dish that offers it, so a
// file that only does that must not read "0 added, 0 updated".
const describe = (result, dryRun) => {
  const parts = dryRun
    ? [`${result.created} new`, `${result.updated} to update`, `${result.unchanged} unchanged`]
    : [`${result.created} added`, `${result.updated} updated`];

  if (result.addOnPriceChanges.length > 0) {
    parts.push(
      `${plural(result.addOnPriceChanges.length, "add-on price", "add-on prices")} ${dryRun ? "to change" : "changed"}`
    );
  }

  if (result.newAddOns.length > 0) {
    parts.push(plural(result.newAddOns.length, "new add-on", "new add-ons"));
  }

  if (result.newCategories.length > 0) {
    parts.push(plural(result.newCategories.length, "new category", "new categories"));
  }

  return `${dryRun ? "Ready" : "Imported"}: ${parts.join(", ")}`;
};

// The browser parses the spreadsheet and posts plain rows (heading -> cell),
// so the API stays JSON-only and no upload handling is needed. dryRun checks
// and previews; the real import sends the preview's fingerprint back, so what
// is applied is what the manager saw, and confirmFlagged: true once the
// manager has ticked that the dishes marked for a second look were checked.
const importProducts = async (req, res) => {
  const body = req.body || {};
  const rows = v.requiredArray(body.rows, "Rows");
  const dryRun = v.requiredBoolean(body.dryRun, "Dry run", false);
  const fileName = v.optionalString(body.fileName, "File name", 200);
  const fingerprint = v.optionalString(body.fingerprint, "Preview check", 100);
  const confirmFlagged = v.requiredBoolean(body.confirmFlagged, "Checked the flagged dishes", false);

  const result = await menuImportService.importProducts(req.user.restaurantId, rows, req.user.id, {
    dryRun,
    fingerprint,
    confirmFlagged,
  });

  // A check that finds problems is still a check that worked, so the dry run
  // answers 200 with them. A real import of a file with problems is refused.
  if (!result.ok) {
    const count = `${result.problems.length} problem${result.problems.length === 1 ? "" : "s"} in the file`;

    return res.status(dryRun ? 200 : 400).json({
      success: dryRun,
      message: dryRun ? `${count}. Fix them and check the file again.` : `${count}. Nothing was imported.`,
      data: result,
    });
  }

  if (!dryRun) {
    logImport(req, result, fileName);
  }

  res.json({
    success: true,
    message: describe(result, dryRun),
    data: result,
  });
};

module.exports = { exportProducts, importGuide, importProducts };
