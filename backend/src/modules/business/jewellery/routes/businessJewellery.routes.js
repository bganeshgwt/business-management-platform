const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const { requireJewellery, requireMoney } = require('../services/jewelleryCommon');
const rates = require('../services/jewelleryRates.service');
const settings = require('../services/jewellerySettings.service');
const pieces = require('../services/jewelleryPieces.service');
const metal = require('../services/jewelleryMetal.service');
const bills = require('../services/jewelleryBills.service');
const oldGold = require('../services/jewelleryOldGold.service');
const schemes = require('../services/jewellerySchemes.service');
const cash = require('../services/jewelleryCash.service');

// Jewellery shops, added to the Business Admin router so they share its
// login, membership, module and permission checks (context) and its
// database-error translation:
//   /:businessId/jewellery/rates…        today's rates in use (with the board's), a new rate sheet, every sheet
//   /:businessId/jewellery/settings      how tags are numbered, the hallmarking charge a new piece starts with
//   /:businessId/jewellery/items…        the jewellery items (catalogue items sold as tagged pieces) and their defaults
//   /:businessId/jewellery/pieces…       pieces by tag or HUID; tagging, changing, sending out and back, melting
//   /:businessId/jewellery/metal…        the shop's own metal by purity and its movements
//   /:businessId/jewellery/bills…        the jewellery bill (a preview, then the core's sale at fixed prices), the bills, a customer's credit on returned ones
//   /:businessId/jewellery/old-gold…     old gold vouchers: valued (a preview), taken in, paid out, cancelled, put back from a returned bill
//   /:businessId/jewellery/scheme-plans… the gold scheme plans the shop offers
//   /:businessId/jewellery/schemes…      gold schemes: joining, instalments, stopping one, the schemes and the money held for them
//   /:businessId/jewellery/cash-report…  the cash with each customer, flagged at ₹10 lakh, and the monthly worksheet (nothing is filed)
// Another type of business never has the module, so `context` refuses it;
// the services repeat every check and answer 404 for another type.

module.exports = function jewelleryRoutes(router, { context, send, b }) {
  // check: refuses before the query; shape: what the caller's role sees of the page.
  const list = (path, name, permission, check, shape) => router.get(b(path), context(permission), async (req, res) => {
    requireJewellery(req.business);
    if (check) await check(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    const page = await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters });
    send(res, shape ? shape(req.business, page) : page);
  });

  // Today's rates: the rates in use (for the counter and the board), a new sheet, and every sheet.
  router.get(b('/jewellery/rates/today'), context('jewellery.view'), async (req, res) => send(res, await rates.today(req.business)));
  router.post(b('/jewellery/rates'), context('jewellery.approve'), async (req, res) => send(res, await rates.setRates(req.business, req.user, req.body), 201));
  list('/jewellery/rates', 'jewellery-rate-sheets', 'jewellery.view', requireMoney);

  // Settings, items and pieces.
  router.get(b('/jewellery/settings'), context('jewellery.view'), async (req, res) => send(res, await settings.settings(req.business)));
  router.put(b('/jewellery/settings'), context('settings.edit'), async (req, res) => send(res, await settings.saveSettings(req.business, req.user, req.body)));
  router.get(b('/jewellery/items'), context('jewellery.view'), async (req, res) => send(res, await pieces.items(req.business)));
  router.post(b('/jewellery/items'), context('jewellery.edit'), async (req, res) => send(res, await pieces.createItem(req.business, req.user, req.body), 201));
  router.put(b('/jewellery/items/:skuId'), context('jewellery.edit'), async (req, res) => send(res, await pieces.updateItem(req.business, req.user, req.params.skuId, req.body)));
  list('/jewellery/pieces', 'jewellery-pieces', 'jewellery.view', null, pieces.listShape);
  router.get(b('/jewellery/pieces/find'), context('jewellery.view'), async (req, res) => send(res, await pieces.find(req.business, req.query)));
  router.get(b('/jewellery/pieces/:id'), context('jewellery.view'), async (req, res) => send(res, await pieces.detail(req.business, req.params.id)));
  router.post(b('/jewellery/pieces'), context('jewellery.edit'), async (req, res) => send(res, await pieces.create(req.business, req.user, req.body), 201));
  router.put(b('/jewellery/pieces/:id'), context('jewellery.edit'), async (req, res) => send(res, await pieces.update(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/pieces/:id/status'), context('jewellery.edit'), async (req, res) => send(res, await pieces.setStatus(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/pieces/:id/melt'), context('jewellery.approve'), async (req, res) => send(res, await pieces.melt(req.business, req.user, req.params.id, req.body)));
  router.get(b('/jewellery/metal'), context('jewellery.view'), async (req, res) => send(res, await metal.stock(req.business)));
  list('/jewellery/metal/movements', 'jewellery-metal-movements', 'jewellery.view');

  // The jewellery bill: priced as it would be posted (nothing saved), posted through the core's sale, and the bills.
  router.post(b('/jewellery/bills/preview'), context('jewellery.create'), async (req, res) => send(res, await bills.preview(req.business, req.user, req.body)));
  router.post(b('/jewellery/bills'), context('jewellery.create'), async (req, res) => send(res, await bills.post(req.business, req.user, req.body), 201));
  list('/jewellery/bills', 'jewellery-bills', 'jewellery.view', requireMoney);
  router.get(b('/jewellery/bills/credits'), context('jewellery.view'), async (req, res) => send(res, await bills.credits(req.business, req.query)));
  router.get(b('/jewellery/bills/:id'), context('jewellery.view'), async (req, res) => send(res, await bills.detail(req.business, req.params.id)));

  // Gold schemes: the plans, joining one, its instalments, stopping it with a manager's approval, the schemes, and the money held for them.
  router.get(b('/jewellery/scheme-plans'), context('jewellery.view'), async (req, res) => send(res, await schemes.plans(req.business)));
  router.post(b('/jewellery/scheme-plans'), context('jewellery.approve'), async (req, res) => send(res, await schemes.createPlan(req.business, req.user, req.body), 201));
  router.put(b('/jewellery/scheme-plans/:id'), context('jewellery.approve'), async (req, res) => send(res, await schemes.setPlanActive(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/schemes'), context('jewellery.create'), async (req, res) => send(res, await schemes.enrol(req.business, req.user, req.body), 201));
  list('/jewellery/schemes', 'jewellery-schemes', 'jewellery.view', requireMoney);
  router.get(b('/jewellery/schemes/liability'), context('jewellery.view'), async (req, res) => send(res, await schemes.liability(req.business, req.query)));
  router.get(b('/jewellery/schemes/approvers'), context('jewellery.cancel'), async (req, res) => send(res, await schemes.approvers(req.business)));
  router.get(b('/jewellery/schemes/:id'), context('jewellery.view'), async (req, res) => send(res, await schemes.detail(req.business, req.params.id)));
  router.post(b('/jewellery/schemes/:id/instalments'), context('jewellery.create'), async (req, res) => send(res, await schemes.payInstalment(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/schemes/:id/stop'), context('jewellery.cancel'), async (req, res) => send(res, await schemes.stop(req.business, req.user, req.params.id, req.body)));

  // The cash report: each customer's cash in and out over a period with the flag at ₹10 lakh, one customer's cash, and the monthly worksheet.
  router.get(b('/jewellery/cash-report'), context('jewellery.export'), async (req, res) => send(res, await cash.report(req.business, req.query)));
  router.get(b('/jewellery/cash-report/person'), context('jewellery.export'), async (req, res) => send(res, await cash.person(req.business, req.query)));
  router.get(b('/jewellery/cash-report/month'), context('jewellery.export'), async (req, res) => send(res, await cash.month(req.business, req.query)));

  // Old gold: valued as it would be (nothing saved), taken in on a voucher, paid out, cancelled, put back from a returned bill; and the vouchers.
  router.post(b('/jewellery/old-gold/preview'), context('jewellery.create'), async (req, res) => send(res, await oldGold.preview(req.business, req.user, req.body)));
  router.post(b('/jewellery/old-gold'), context('jewellery.create'), async (req, res) => send(res, await oldGold.create(req.business, req.user, req.body), 201));
  list('/jewellery/old-gold', 'jewellery-old-gold', 'jewellery.view', requireMoney);
  router.get(b('/jewellery/old-gold/:id'), context('jewellery.view'), async (req, res) => send(res, await oldGold.detail(req.business, req.params.id)));
  router.post(b('/jewellery/old-gold/:id/payout'), context('jewellery.approve'), async (req, res) => send(res, await oldGold.payout(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/old-gold/:id/cancel'), context('jewellery.cancel'), async (req, res) => send(res, await oldGold.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/old-gold/:id/put-back'), context('jewellery.create'), async (req, res) => send(res, await oldGold.putBack(req.business, req.user, req.params.id, req.body), 201));
};
