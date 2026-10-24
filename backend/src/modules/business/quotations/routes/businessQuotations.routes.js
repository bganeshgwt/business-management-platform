const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const quotations = require('../services/businessQuotations.service');

// Quotations (every type but a restaurant), added to the Business Admin
// router so they share its login, membership, module and permission checks
// (context) and its database-error translation:
//   /:businessId/quotations…   the list, figures while typing, making,
//                              revising, cancelling, and the bill or sales
//                              order a quotation becomes
// Services repeat every permission check.

module.exports = function quotationRoutes(router, { context, send, b }) {
  const list = (path, name, permission) => router.get(b(path), context(permission), async (req, res) => {
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) {
      const value = req.query[key];
      if (value === undefined || value === '') continue;
      // "billed,ordered": any of several values.
      filters[key] = String(value).includes(',') ? String(value).slice(0, 120).split(',').slice(0, 10) : String(value).slice(0, 60);
    }
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    send(res, await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters }));
  });

  list('/quotations', 'quotations', 'quotations.view');
  router.post(b('/quotations/preview'), context(['quotations.create', 'quotations.edit']), async (req, res) => send(res, await quotations.preview(req.business, req.user, req.body)));
  router.get(b('/quotations/:id'), context('quotations.view'), async (req, res) => send(res, await quotations.detail(req.business, req.params.id)));
  router.post(b('/quotations'), context('quotations.create'), async (req, res) => send(res, await quotations.create(req.business, req.user, req.body), 201));
  router.put(b('/quotations/:id'), context('quotations.edit'), async (req, res) => send(res, await quotations.revise(req.business, req.user, req.params.id, req.body)));
  router.post(b('/quotations/:id/cancel'), context('quotations.cancel'), async (req, res) => send(res, await quotations.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/quotations/:id/bill'), context('quotations.edit'), async (req, res) => send(res, await quotations.bill(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/quotations/:id/order'), context('quotations.edit'), async (req, res) => send(res, await quotations.order(req.business, req.user, req.params.id, req.body), 201));
};
