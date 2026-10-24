const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const items = require('../services/agriItems.service');
const farmers = require('../services/agriFarmers.service');
const subsidy = require('../services/agriSubsidy.service');
const registers = require('../services/agriRegisters.service');

// Seeds, fertilisers & pesticides, added to the Business Admin router so
// they share its login, membership, module and permission checks (context)
// and its database-error translation:
//   /:businessId/agri/molecules          the molecule master and the crops it names
//   /:businessId/agri/farmers…           farmers (a customer's details as a farmer)
//                                        and each farmer's bills still to collect
//   /:businessId/agri/village-dues       what is owed, overdue and on season credit, by village
//   /:businessId/agri/subsidy…           subsidised fertiliser against the PoS device:
//                                        the reconciliation, its products, the stock typed in
//   /:businessId/agri/board              the daily stock and price board
//   /:businessId/agri/seed-return        the seed stock return of a month
//   /:businessId/agri/insecticide-register  the insecticide sale register
// Another type of business never has the module, so `context` refuses it
// (the molecule list: the service, after `context` checks the membership);
// the services repeat every check and answer 404 for another type.

module.exports = function agriRoutes(router, { context, send, b }) {
  // check: refuses before the query; shape: what the caller's role sees of the page.
  const list = (path, name, permission, check, shape) => router.get(b(path), context(permission), async (req, res) => {
    if (check) check(req.business, req.query);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const page = await repo.page(req.business.id, name, limit, offset, { search, timezone: req.business.timezone, filters });
    send(res, shape ? shape(req.business, page) : page);
  });

  // The molecule master: the item form, the counter and the Molecules screen read it.
  router.get(b('/agri/molecules'), context(), async (req, res) => send(res, await items.master(req.business)));

  // Farmers and village dues.
  list('/agri/farmers', 'agri-farmers', 'agri.view', farmers.listCheck, farmers.listShape);
  router.post(b('/agri/farmers'), context('agri.edit'), async (req, res) => send(res, await farmers.create(req.business, req.user, req.body), 201));
  router.get(b('/agri/farmers/:contactId'), context('agri.view'), async (req, res) => send(res, await farmers.detail(req.business, req.params.contactId)));
  router.put(b('/agri/farmers/:contactId'), context('agri.edit'), async (req, res) => send(res, await farmers.save(req.business, req.user, req.params.contactId, req.body)));
  router.get(b('/agri/village-dues'), context('agri.view'), async (req, res) => send(res, await farmers.villageDues(req.business)));

  // Subsidised fertiliser against the PoS device.
  router.get(b('/agri/subsidy'), context('agri.view'), async (req, res) => send(res, await subsidy.report(req.business, req.query)));
  router.get(b('/agri/subsidy/products'), context('agri.view'), async (req, res) => send(res, await subsidy.products(req.business, req.query)));
  router.post(b('/agri/subsidy/checks'), context('agri.create'), async (req, res) => send(res, await subsidy.check(req.business, req.user, req.body), 201));

  // Registers and the board.
  router.get(b('/agri/board'), context('agri.view'), async (req, res) => send(res, await registers.board(req.business, req.query)));
  router.get(b('/agri/seed-return'), context('agri.view'), async (req, res) => send(res, await registers.seedReturn(req.business, req.query)));
  router.get(b('/agri/insecticide-register'), context('agri.view'), async (req, res) => send(res, await registers.insecticideRegister(req.business, req.query)));
};
