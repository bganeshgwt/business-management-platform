const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const licences = require('../services/businessLicences.service');
const records = require('../services/licenceRecords.service');

// Licences & registrations (every type but a restaurant), added to the
// Business Admin router so they share its login, membership, module and
// permission checks (context) and its database-error translation:
//   /:businessId/licences                    the licences each location holds, where each
//                                            stands today and the days it has left
//   /:businessId/licences/kinds              the kinds of licence a screen offers, with their rules
//   /:businessId/licences/:id                one licence with its copies and records: change it,
//                                            renew it, switch it off
//   /:businessId/licences/:id/renewal        a renewal applied for, or the mark taken off
//   /:businessId/licences/:id/endorsements…  an insecticide licence's endorsed items and brands
//   /:businessId/licences/:id/principals…    its principal certificates, and their withdrawal
//   /:businessId/licences/:id/sources…       a fertiliser authorisation's certificates of source (Form O)
// The scanned copies are multipart, mounted before this router (routes/licenceUploads.routes.js).
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
  router.get(b('/licences/kinds'), context(['licences.view', 'licences.edit']), async (req, res) => send(res, await licences.kinds(req.business)));
  router.post(b('/licences'), context('licences.edit'), async (req, res) => send(res, await licences.create(req.business, req.user, req.body), 201));
  router.get(b('/licences/:id'), context('licences.view'), async (req, res) => {
    licences.requireLicences(req.business);
    const licence = await licences.load(repo.pool, req.business, req.params.id);
    send(res, await licences.detail(repo.pool, req.business, licence.id, { full: true }));
  });
  router.patch(b('/licences/:id'), context('licences.edit'), async (req, res) => send(res, await licences.update(req.business, req.user, req.params.id, req.body)));
  router.put(b('/licences/:id/renewal'), context('licences.edit'), async (req, res) => send(res, await licences.markRenewal(req.business, req.user, req.params.id, req.body)));
  router.post(b('/licences/:id/endorsements'), context('licences.edit'), async (req, res) => send(res, await records.addEndorsement(req.business, req.user, req.params.id, req.body), 201));
  router.patch(b('/licences/:id/endorsements/:recordId'), context('licences.edit'), async (req, res) =>
    send(res, await records.updateEndorsement(req.business, req.user, req.params.id, req.params.recordId, req.body)));
  router.post(b('/licences/:id/principals'), context('licences.edit'), async (req, res) => send(res, await records.addPrincipal(req.business, req.user, req.params.id, req.body), 201));
  router.patch(b('/licences/:id/principals/:recordId'), context('licences.edit'), async (req, res) =>
    send(res, await records.updatePrincipal(req.business, req.user, req.params.id, req.params.recordId, req.body)));
  router.post(b('/licences/:id/sources'), context('licences.edit'), async (req, res) => send(res, await records.addSource(req.business, req.user, req.params.id, req.body), 201));
  router.patch(b('/licences/:id/sources/:recordId'), context('licences.edit'), async (req, res) =>
    send(res, await records.updateSource(req.business, req.user, req.params.id, req.params.recordId, req.body)));
};
