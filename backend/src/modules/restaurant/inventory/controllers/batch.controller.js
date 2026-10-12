const inventory = require('../repositories/inventory.repository');
const batches = require('../repositories/batch.repository');
const v = require('../../../../utils/validate');
const { pinnedStore } = require('../services/inventory.service');

// The Batches & expiry view. ?show= narrows it the way the bell's alerts link
// to it (soon, expired, used_after_expiry …), ?store= to one store (main or an
// outlet id). Someone tied to one outlet always sees their own store's.
// Items on an open blind count stay hidden from the people counting them.
exports.list = async (req, res) => {
  const restaurantId = req.user.restaurantId;
  const hidden = req.user.permissions.includes('inventory.manage') ? [] : [...await inventory.findBlindItemIds(restaurantId)];
  const show = v.optionalEnum(req.query.show, 'Show', Object.keys(batches.SHOWS), 'all');
  const within = v.optionalNumber(req.query.within, 'Days', { min: 0, max: 60 });
  let store = null;

  const mine = await pinnedStore(restaurantId, req.outletPinned ? req.outletId : null);

  if (mine) {
    store = { storeId: mine.storeId };
  } else if (req.query.store === 'main') {
    store = { storeId: null };
  } else if (req.query.store !== undefined && req.query.store !== '' && req.query.store !== 'all') {
    const outletId = v.requiredId(req.query.store, 'Store');
    store = { storeId: await inventory.storeFor(inventory.pool, restaurantId, outletId) };
  } else if (req.outletId && req.query.store === undefined) {
    // The outlet picked in the switcher: its own shelf, or the main store it
    // sells from.
    store = { storeId: await inventory.storeFor(inventory.pool, restaurantId, req.outletId) };
  }

  const rows = await batches.findBatches(restaurantId, {
    storeOnly: Boolean(store),
    storeId: store ? store.storeId : null,
    show,
    within: within === null || within === undefined ? 7 : Math.round(within),
    hiddenItemIds: hidden,
  });

  res.json({
    success: true,
    data: rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      unit_cost: row.unit_cost === null ? null : Number(row.unit_cost),
      days_left: row.days_left === null ? null : Number(row.days_left),
      used_after_expiry: Number(row.used_after_expiry),
      used_on_bills: row.used_on_bills || [],
    })),
  });
};
