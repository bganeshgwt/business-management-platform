const authorizeOrApprove = require("./authorizeOrApprove");
const stockSettingsService = require("../modules/restaurant/inventory/services/stockSettings.service");
const { round2 } = require("../utils/money");

// Large write-offs need a second person (sweep SW-B-10).
//
// Stock → Stock & purchasing settings can set a value above which wastage or a
// stock out needs "Approve large write-offs" — or a manager standing there,
// who types their PIN. Under the limit, or with no limit set, nothing changes:
// the kitchen logs its waste straight in.
//
//   router.post("/wastage", canLogWaste, writeoffApproval(prepare), controller.logWastage)
//
// `prepare(req)` makes every check the action itself will make (the item, the
// quantity, the stock on that shelf, the reason) and returns
//   { quantity, value, productId?, inventoryItemId?, stockCountId? }
// (an item may also come back as data.inventoryItemId, as the stock-out and
// wastage checks return it).
// It throws the same refusal the action would, so a manager is never asked
// for a PIN for an entry that is then refused (an approval is spent the
// moment it is used and never handed back). What it found is kept on
// req.prepared for the controller.
//
// The approval is tied to what the manager was shown: the quantity and the
// value (no more than approved), and what is written off — the stock item,
// the dish, or the count sheet — whichever route it came by. Binding the item
// only through a route's address left the routes that carry the item in the
// body open: a PIN given for 2 kg paneer then wrote off ghee.
const gate = authorizeOrApprove("inventory.approve_writeoff", {
  scope: (req) =>
    req.writeoff
      ? {
          quantity: req.writeoff.quantity,
          amount: req.writeoff.value,
          ...(req.writeoff.productId ? { productId: req.writeoff.productId } : {}),
          ...(req.writeoff.inventoryItemId ? { inventoryItemId: req.writeoff.inventoryItemId } : {}),
          ...(req.writeoff.stockCountId ? { stockCountId: req.writeoff.stockCountId } : {}),
        }
      : null,
});

const writeoffApproval = (prepare) => async (req, res, next) => {
  const prepared = await prepare(req);
  req.prepared = prepared;

  const settings = await stockSettingsService.get(req.user.restaurantId);
  const value = round2(prepared.value || 0);

  if (!stockSettingsService.overLimit(settings.writeoffApprovalLimit, value)) {
    next();
    return;
  }

  req.writeoff = {
    quantity: prepared.quantity,
    value,
    productId: prepared.productId || null,
    inventoryItemId: prepared.inventoryItemId || (prepared.data && prepared.data.inventoryItemId) || null,
    stockCountId: prepared.stockCountId || null,
    limit: settings.writeoffApprovalLimit,
  };

  await gate(req, res, next);
};

module.exports = writeoffApproval;
