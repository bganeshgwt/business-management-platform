const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const items = require('../services/agriItems.service');
const crops = require('../services/agriCrops.service');
const farmers = require('../services/agriFarmers.service');
const buyers = require('../services/agriBuyers.service');
const overrides = require('../services/agriOverrides.service');
const subsidy = require('../services/agriSubsidy.service');
const registers = require('../services/agriRegisters.service');
const sales = require('../services/agriSales.service');
const seedLots = require('../services/agriSeedLots.service');
const holds = require('../services/agriStockHolds.service');
const seasons = require('../services/agriSeasons.service');
const schemes = require('../services/agriSchemes.service');

// Seeds, fertilisers & pesticides, added to the Business Admin router so
// they share its login, membership, module and permission checks (context)
// and its database-error translation:
//   /:businessId/agri/molecules          the molecule master and the crops the bills are matched against
//   /:businessId/agri/crops…             the crops in their groups; the shop's own crops and additions
//   /:businessId/agri/farmers…           farmers (a customer's details as a farmer)
//                                        and each farmer's bills still to collect
//   /:businessId/agri/village-dues       what is owed, overdue and on season credit, by village
//   /:businessId/agri/buyer-tags…        customers tagged as pest-control operators,
//                                        government bodies or bulk consumers
//   /:businessId/agri/overrides…         a manager's override at the counter, and who may give one
//   /:businessId/agri/season-credits…    each farmer's credit for a season: terms, interest, produce taken
//   /:businessId/agri/subsidy…           subsidised fertiliser against the PoS device:
//                                        the reconciliation, its products, the stock typed in
//   /:businessId/agri/seed-lots…         each seed lot's tag, retests and SATHI QR texts
//   /:businessId/agri/kept-apart…        stock kept apart: expired, seized or sampled
//   /:businessId/agri/schemes…           company schemes: their ledgers and claims
//   /:businessId/agri/board              the daily stock and price board
//   /:businessId/agri/seed-return        the seed stock return of a month (Form D)
//   /:businessId/agri/insecticide-register  the insecticide sale register
//   /:businessId/agri/form-xiii          insecticides sold to dealers and bulk consumers
//   /:businessId/agri/form-xiv           the monthly return of insecticides
//   /:businessId/agri/sulphur-register   sulphur's buyers
//   /:businessId/agri/returns-filed      a monthly return marked as sent
//   /:businessId/agri/licence-check      the counter's licence checks of the lines being typed
//   /:businessId/agri/counter-check      every check the bill will make, asked ahead
//   /:businessId/agri/settings           the shop's farm input checks
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

  // The molecule master and the crops: the item form, the counter and the Molecules and Crops screens read it.
  router.get(b('/agri/molecules'), context(), async (req, res) => send(res, await items.master(req.business)));
  router.get(b('/agri/crops'), context('agri.view'), async (req, res) => send(res, await crops.list(req.business)));
  router.post(b('/agri/crops'), context('agri.edit'), async (req, res) => send(res, await crops.create(req.business, req.user, req.body), 201));
  router.put(b('/agri/crops/:cropId'), context('agri.edit'), async (req, res) => send(res, await crops.save(req.business, req.user, req.params.cropId, req.body)));

  // Farmers and village dues; buyers' tags.
  list('/agri/farmers', 'agri-farmers', 'agri.view', farmers.listCheck, farmers.listShape);
  router.post(b('/agri/farmers'), context('agri.edit'), async (req, res) => send(res, await farmers.create(req.business, req.user, req.body), 201));
  router.get(b('/agri/farmers/:contactId'), context('agri.view'), async (req, res) => send(res, await farmers.detail(req.business, req.params.contactId)));
  router.put(b('/agri/farmers/:contactId'), context('agri.edit'), async (req, res) => send(res, await farmers.save(req.business, req.user, req.params.contactId, req.body)));
  router.get(b('/agri/village-dues'), context('agri.view'), async (req, res) => send(res, await farmers.villageDues(req.business)));
  list('/agri/buyer-tags', 'agri-buyer-tags', 'agri.view', buyers.listCheck);
  router.put(b('/agri/buyer-tags/:contactId'), context(['agri.edit', 'agri.approve']), async (req, res) => send(res, await buyers.save(req.business, req.user, req.params.contactId, req.body)));

  // A manager's override at the counter.
  router.get(b('/agri/overrides/approvers'), context('sales.create'), async (req, res) => send(res, await overrides.approvers(req.business)));
  router.post(b('/agri/overrides'), context('sales.create'), async (req, res) => send(res, await overrides.give(req.business, req.user, req.body), 201));

  // Season credit.
  list('/agri/season-credits', 'agri-season-credits', 'agri.view', seasons.listCheck, seasons.listShape);
  router.post(b('/agri/season-credits'), context('agri.approve'), async (req, res) => send(res, await seasons.create(req.business, req.user, req.body), 201));
  router.get(b('/agri/season-credits/:seasonId'), context('agri.view'), async (req, res) => send(res, await seasons.detail(req.business, req.params.seasonId)));
  router.put(b('/agri/season-credits/:seasonId'), context('agri.approve'), async (req, res) => send(res, await seasons.update(req.business, req.user, req.params.seasonId, req.body)));
  router.post(b('/agri/season-credits/:seasonId/interest'), context('agri.approve'), async (req, res) => send(res, await seasons.chargeInterest(req.business, req.user, req.params.seasonId, req.body), 201));
  router.post(b('/agri/season-credits/:seasonId/produce'), context('receivables.create'), async (req, res) => send(res, await seasons.takeProduce(req.business, req.user, req.params.seasonId, req.body), 201));

  // Subsidised fertiliser against the PoS device.
  router.get(b('/agri/subsidy'), context('agri.view'), async (req, res) => send(res, await subsidy.report(req.business, req.query)));
  router.get(b('/agri/subsidy/products'), context('agri.view'), async (req, res) => send(res, await subsidy.products(req.business, req.query)));
  router.post(b('/agri/subsidy/checks'), context('agri.create'), async (req, res) => send(res, await subsidy.check(req.business, req.user, req.body), 201));

  // Seed lots, and stock kept apart.
  list('/agri/seed-lots', 'agri-seed-lots', 'inventory.view', seedLots.listCheck);
  router.post(b('/agri/seed-lots'), context('inventory.edit'), async (req, res) => send(res, await seedLots.record(req.business, req.user, req.body), 201));
  router.get(b('/agri/seed-lots/:seedLotId'), context('inventory.view'), async (req, res) => send(res, await seedLots.detail(req.business, req.params.seedLotId)));
  router.put(b('/agri/seed-lots/:seedLotId'), context('inventory.edit'), async (req, res) => send(res, await seedLots.correct(req.business, req.user, req.params.seedLotId, req.body)));
  router.post(b('/agri/seed-lots/:seedLotId/retests'), context('inventory.edit'), async (req, res) => send(res, await seedLots.retest(req.business, req.user, req.params.seedLotId, req.body), 201));
  router.post(b('/agri/seed-lots/:seedLotId/qr-codes'), context('inventory.edit'), async (req, res) => send(res, await seedLots.addQr(req.business, req.user, req.params.seedLotId, req.body), 201));
  list('/agri/kept-apart', 'agri-stock-holds', 'inventory.view', holds.listCheck);
  router.post(b('/agri/kept-apart'), context('inventory.edit'), async (req, res) => send(res, await holds.keepApart(req.business, req.user, req.body), 201));
  router.post(b('/agri/kept-apart/:holdId/close'), context('inventory.edit'), async (req, res) => send(res, await holds.close(req.business, req.user, req.params.holdId, req.body)));

  // Company schemes.
  list('/agri/schemes', 'agri-schemes', 'purchasing.view', schemes.listCheck);
  router.post(b('/agri/schemes'), context('purchasing.edit'), async (req, res) => send(res, await schemes.create(req.business, req.user, req.body), 201));
  router.get(b('/agri/schemes/:schemeId'), context('purchasing.view'), async (req, res) => send(res, await schemes.detail(req.business, req.params.schemeId)));
  router.put(b('/agri/schemes/:schemeId'), context('purchasing.edit'), async (req, res) => send(res, await schemes.update(req.business, req.user, req.params.schemeId, req.body)));
  router.post(b('/agri/schemes/:schemeId/claims'), context('purchasing.edit'), async (req, res) => send(res, await schemes.addClaim(req.business, req.user, req.params.schemeId, req.body), 201));
  router.post(b('/agri/schemes/:schemeId/claims/:claimId/received'), context('purchasing.edit'),
    async (req, res) => send(res, await schemes.receiveClaim(req.business, req.user, req.params.schemeId, req.params.claimId, req.body)));

  // Registers and the board.
  router.get(b('/agri/board'), context('agri.view'), async (req, res) => send(res, await registers.board(req.business, req.query)));
  router.get(b('/agri/seed-return'), context('agri.view'), async (req, res) => send(res, await registers.seedReturn(req.business, req.query)));
  router.get(b('/agri/insecticide-register'), context('agri.view'), async (req, res) => send(res, await registers.insecticideRegister(req.business, req.query)));
  router.get(b('/agri/form-xiii'), context('agri.view'), async (req, res) => send(res, await registers.formXiii(req.business, req.query)));
  router.get(b('/agri/form-xiv'), context('agri.view'), async (req, res) => send(res, await registers.formXiv(req.business, req.query)));
  router.get(b('/agri/sulphur-register'), context('agri.view'), async (req, res) => send(res, await registers.sulphurRegister(req.business, req.query)));
  router.post(b('/agri/returns-filed'), context('agri.edit'), async (req, res) => send(res, await registers.markFiled(req.business, req.user, req.body), 201));

  // The counter's checks, asked ahead as the lines are typed; the shop's settings.
  router.post(b('/agri/licence-check'), context('sales.create'), async (req, res) => send(res, await sales.counterCheck(req.business, req.user, req.body)));
  router.post(b('/agri/counter-check'), context('sales.create'), async (req, res) => send(res, await sales.counterCheck(req.business, req.user, req.body, { all: true })));
  router.get(b('/agri/settings'), context('agri.view'), async (req, res) => send(res, await sales.settings(req.business)));
  router.put(b('/agri/settings'), context(['licences.edit', 'settings.edit']), async (req, res) => send(res, await sales.saveSettings(req.business, req.user, req.body)));
};
