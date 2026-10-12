const stockSettingsService = require("../services/stockSettings.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

// Read by the screens that need to know the limits (Purchase orders, Waste &
// reorder, Items & stock), so anyone who can open one of them may read it.
const get = async (req, res) => {
  res.json({ success: true, data: await stockSettingsService.get(req.user.restaurantId) });
};

// A limit is a sum of money, or blank for no limit. Zero would make every
// purchase order and every gram of waste wait for a manager, which is never
// what anyone means: it is refused with the way to say "no limit".
const readLimit = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const limit = v.requiredNumber(value, field, { min: 0, max: 99999999 });

  if (limit <= 0) {
    throw new AppError(400, `${field} must be more than ₹0. Leave it blank for no limit.`);
  }

  return Math.round(limit * 100) / 100;
};

const save = async (req, res) => {
  const body = req.body || {};
  const data = {
    poApprovalLimit: readLimit(body.poApprovalLimit, "The purchase order limit"),
    writeoffApprovalLimit: readLimit(body.writeoffApprovalLimit, "The wastage and stock out limit"),
    transferReceiptRequired: v.requiredBoolean(body.transferReceiptRequired, "Receiving store confirms transfers", false),
  };

  const { before, after } = await stockSettingsService.save(req.user.restaurantId, data, req.user.id);

  logAction(req, "update", "stock_settings", {
    label: "Stock & purchasing settings",
    details: { changes: diff(before, after, ["poApprovalLimit", "writeoffApprovalLimit", "transferReceiptRequired"]) },
  });

  res.json({ success: true, message: "Stock & purchasing settings saved", data: after });
};

module.exports = { get, save };
