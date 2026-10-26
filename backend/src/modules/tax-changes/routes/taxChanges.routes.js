const repo = require('../../business/core/repositories/business.repository');
const v = require('../../../utils/validate');
const AppError = require('../../../utils/AppError');
const shop = require('../services/taxChangesShop');
const menu = require('../services/taxChangesMenu');

// GST rate changes: one module, two front doors (services/taxChanges.service.js).
//
//   /api/businesses/:businessId/tax-changes/…   a shop's catalogue items (catalog.view, catalog.edit),
//                                               mounted from business.routes.js
//   /api/menu/tax-changes/…                     a restaurant's dishes (menu.view, menu.manage),
//                                               mounted from the restaurant's menu.routes.js

// --- A shop ------------------------------------------------------------------------------
function businessRoutes(router, { context, send, b }) {
  // The changes, a page at a time: scheduled first, then by date.
  router.get(b('/tax-changes'), context('catalog.view'), async (req, res) => {
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters('tax-changes')) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    send(res, await repo.page(req.business.id, 'tax-changes', limit, offset, { search, timezone: req.business.timezone, filters }));
  });
  // What each item would become, before anything is saved.
  router.post(b('/tax-changes/preview'), context('catalog.edit'), async (req, res) => send(res, await shop.preview(req.business, req.user, req.body)));
  router.post(b('/tax-changes'), context('catalog.edit'), async (req, res) => send(res, await shop.schedule(req.business, req.user, req.body), 201));
  router.get(b('/tax-changes/:changeId'), context('catalog.view'), async (req, res) => send(res, await shop.detail(req.business, req.user, req.params.changeId)));
  router.post(b('/tax-changes/:changeId/cancel'), context('catalog.edit'), async (req, res) =>
    send(res, await shop.cancel(req.business, req.user, req.params.changeId, req.body)));
  router.post(b('/tax-changes/:changeId/items/:itemId/cancel'), context('catalog.edit'), async (req, res) =>
    send(res, await shop.cancelItem(req.business, req.user, req.params.changeId, req.params.itemId, req.body)));
  // An item's GST history: its changes, past and to come, and its slab changed on the item.
  router.get(b('/catalog/:id/tax-history'), context('catalog.view'), async (req, res) => send(res, await shop.history(req.business, req.user, req.params.id)));
}

// --- A restaurant ----------------------------------------------------------------------------
// Handlers for menu.routes.js, which checks menu.view or menu.manage first.
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const menuHandlers = {
  // Before any menu screen, and the POS's menu, is read: changes due on the trading day take effect.
  gate: async (req, res, next) => {
    await menu.onMenu(req.user && req.user.restaurantId);
    next();
  },
  list: async (req, res) => ok(res, await menu.list(req.user)),
  preview: async (req, res) => ok(res, await menu.preview(req.user, req.body || {})),
  schedule: async (req, res) => ok(res, await menu.schedule(req.user, req.body || {}), 201),
  detail: async (req, res) => ok(res, await menu.detail(req.user, req.params.id)),
  cancel: async (req, res) => ok(res, await menu.cancel(req.user, req.params.id, req.body || {})),
  cancelItem: async (req, res) => ok(res, await menu.cancelItem(req.user, req.params.id, req.params.itemId, req.body || {})),
  history: async (req, res) => ok(res, await menu.history(req.user, req.params.id)),
};

module.exports = { businessRoutes, menuHandlers };
