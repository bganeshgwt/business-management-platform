const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const licences = require('../services/businessLicences.service');

// Licences & registrations (every type but a restaurant), added to the
// Business Admin router so they share its login, membership, module and
// permission checks (context) and its database-error translation:
//   /:businessId/licences       the licences each location holds, where each
//                               stands today and the days it has left
//   /:businessId/licences/:id   one licence: change it, renew it, switch it off
// A business without the module is refused by `context` (403).

module.exports = function licencesRoutes(router, { context, send, b }) {
  const list = (path, name, permission, check) => router.get(b(path), context(permission), async (req, res) => {
    if (check) check(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    send(res, await repo.page(req.business.id, name, limit, offset, { search, timezone: req.business.timezone, filters }));
  });

  list('/licences', 'licences', 'licences.view', licences.requireLicences);
  router.post(b('/licences'), context('licences.edit'), async (req, res) => send(res, await licences.create(req.business, req.user, req.body), 201));
  router.patch(b('/licences/:id'), context('licences.edit'), async (req, res) => send(res, await licences.update(req.business, req.user, req.params.id, req.body)));
};
