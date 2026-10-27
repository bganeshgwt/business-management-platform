const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const sites = require('../services/hardwareSites.service');
const fitters = require('../services/hardwareFitters.service');
const rates = require('../services/hardwareRates.service');
const calculators = require('../services/hardwareCalculators.service');
const calculations = require('../services/hardwareCalculations.service');
const tinting = require('../services/hardwareTinting.service');
const pins = require('../../salon-weight/services/businessManagerPin');

// Hardware, paints & building materials, added to the Business Admin router
// so they share its login, membership, module and permission checks
// (context) and its database-error translation:
//   /:businessId/hardware/sites…          contractors' and builders' sites, each
//                                         site's ledger, and the site of a bill
//                                         or a sales order
//   /:businessId/hardware/fitters…        the fitter register, each fitter's
//                                         statement and payouts
//   /:businessId/hardware/fitter-rules…   commission rules
//   /:businessId/hardware/fitter-payouts  every payout
//   /:businessId/hardware/fitter-report   earned, taken back, paid and due by fitter
//   /:businessId/hardware/bills/:id/fitter a fitter named on a bill afterwards, or changed until paid
//   /:businessId/hardware/orders/:id/fitter a sales order's fitter, carried by its invoices
//   /:businessId/hardware/rates…          today's rates: the board, its items, saving them, an item's history
//   /:businessId/hardware/calculator-items the items with a coverage, for the tile and paint calculators
//   /:businessId/hardware/calculate       a calculator worked out by the server, in the units items are sold in
//   /:businessId/hardware/shades…         the shade master: typed, changed, imported from a spreadsheet
//   /:businessId/hardware/tinting…        the tinting charge, the board, and each job tinted, handed over or taken back
// Another type of business never has these modules, so `context` refuses it
// (today's rates and the calculators: the service, after `context` checks the
// catalogue permission); the services repeat every check and answer 404 for
// another type.

module.exports = function hardwareRoutes(router, { context, send, b }) {
  const list = (path, name, permission, check) => router.get(b(path), context(permission), async (req, res) => {
    if (check) check(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '') filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    send(res, await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters }));
  });

  // Sites.
  list('/hardware/sites', 'hardware-sites', 'hardware_sites.view', sites.requireSites);
  router.post(b('/hardware/sites'), context('hardware_sites.edit'), async (req, res) => send(res, await sites.create(req.business, req.user, req.body), 201));
  router.get(b('/hardware/sites/:id'), context('hardware_sites.view'), async (req, res) => send(res, await sites.ledger(req.business, req.params.id)));
  router.patch(b('/hardware/sites/:id'), context('hardware_sites.edit'), async (req, res) => send(res, await sites.update(req.business, req.user, req.params.id, req.body)));
  router.put(b('/hardware/bills/:id/site'), context('hardware_sites.edit'), async (req, res) => send(res, await sites.setDocumentSite(req.business, req.user, req.params.id, req.body)));
  router.get(b('/hardware/orders/:id/site'), context('hardware_sites.view'), async (req, res) => send(res, await sites.orderSite(req.business, req.params.id)));
  router.put(b('/hardware/orders/:id/site'), context('hardware_sites.edit'), async (req, res) => send(res, await sites.setOrderSite(req.business, req.user, req.params.id, req.body)));

  // Fitters' commission.
  list('/hardware/fitters', 'hardware-fitters', 'fitter_commission.view', fitters.requireFitters);
  router.post(b('/hardware/fitters'), context('fitter_commission.create'), async (req, res) => send(res, await fitters.create(req.business, req.user, req.body), 201));
  router.get(b('/hardware/fitters/:id'), context('fitter_commission.view'), async (req, res) => send(res, await fitters.statement(req.business, req.params.id)));
  router.patch(b('/hardware/fitters/:id'), context('fitter_commission.edit'), async (req, res) => send(res, await fitters.update(req.business, req.user, req.params.id, req.body)));
  router.post(b('/hardware/fitters/:id/payouts'), context('fitter_commission.approve'), async (req, res) => send(res, await fitters.payout(req.business, req.user, req.params.id, req.body), 201));
  list('/hardware/fitter-rules', 'hardware-fitter-rules', 'fitter_commission.view', fitters.requireFitters);
  router.post(b('/hardware/fitter-rules'), context('fitter_commission.edit'), async (req, res) => send(res, await fitters.createRule(req.business, req.user, req.body), 201));
  router.patch(b('/hardware/fitter-rules/:id'), context('fitter_commission.edit'), async (req, res) => send(res, await fitters.updateRule(req.business, req.user, req.params.id, req.body)));
  list('/hardware/fitter-payouts', 'hardware-fitter-payouts', 'fitter_commission.view', fitters.requireFitters);
  router.get(b('/hardware/fitter-report'), context('fitter_commission.view'), async (req, res) => send(res, await fitters.report(req.business, req.query)));
  router.put(b('/hardware/bills/:id/fitter'), context('fitter_commission.edit'), async (req, res) => send(res, await fitters.setBillFitter(req.business, req.user, req.params.id, req.body)));
  router.get(b('/hardware/orders/:id/fitter'), context('fitter_commission.view'), async (req, res) => send(res, await fitters.orderFitter(req.business, req.params.id)));
  router.put(b('/hardware/orders/:id/fitter'), context('fitter_commission.create'), async (req, res) => send(res, await fitters.setOrderFitter(req.business, req.user, req.params.id, req.body)));

  // Today's rates (the module is checked by the service).
  router.get(b('/hardware/rates'), context('catalog.view'), async (req, res) => send(res, await rates.board(req.business)));
  router.put(b('/hardware/rates'), context('catalog.edit'), async (req, res) => send(res, await rates.save(req.business, req.user, req.body)));
  router.post(b('/hardware/rates/items'), context('catalog.edit'), async (req, res) => send(res, await rates.add(req.business, req.user, req.body), 201));
  router.delete(b('/hardware/rates/items/:skuId'), context('catalog.edit'), async (req, res) => send(res, await rates.remove(req.business, req.user, req.params.skuId)));
  router.get(b('/hardware/rates/items/:skuId/history'), context('catalog.view'), async (req, res) => send(res, await rates.history(req.business, req.params.skuId, req.query)));

  // Material calculators (the module is checked by the service).
  router.get(b('/hardware/calculator-items'), context('catalog.view'), async (req, res) => send(res, await calculators.items(req.business)));
  router.post(b('/hardware/calculate'), context('catalog.view'), async (req, res) => send(res, await calculations.calculate(req.business, req.body)));

  // Paint tinting: shades, the charge, the board.
  list('/hardware/shades', 'hardware-shades', 'hardware_tinting.view', tinting.requireTinting);
  router.post(b('/hardware/shades'), context('hardware_tinting.edit'), async (req, res) => send(res, await tinting.createShade(req.business, req.user, req.body), 201));
  router.get(b('/hardware/shades/import-guide'), context('hardware_tinting.edit'), async (req, res) => { tinting.requireTinting(req.business); send(res, tinting.importGuide()); });
  // A check that finds problems still worked: the dry run answers 200 with them; a real import of such a file is refused.
  router.post(b('/hardware/shades/import'), context('hardware_tinting.edit'), async (req, res) => {
    const result = await tinting.importShades(req.business, req.user, req.body);
    const dryRun = req.body.dryRun === true;
    const many = (n, one, more) => `${n} ${n === 1 ? one : more}`;
    if (!result.ok) {
      return res.status(dryRun ? 200 : 400).json({ success: dryRun, data: result,
        message: `${many(result.problems.length, 'problem', 'problems')} in the file. ${dryRun ? 'Fix them and check the file again.' : 'Nothing was imported.'}` });
    }
    return res.json({ success: true, data: result, message: dryRun ? `Ready: ${result.created} new shades, ${result.updated} to update, ${result.unchanged} unchanged`
      : `Imported: ${many(result.created, 'shade', 'shades')} added, ${result.updated} updated` });
  });
  router.patch(b('/hardware/shades/:id'), context('hardware_tinting.edit'), async (req, res) => send(res, await tinting.updateShade(req.business, req.user, req.params.id, req.body)));
  router.get(b('/hardware/tinting/settings'), context('hardware_tinting.view'), async (req, res) => send(res, await tinting.settings(req.business)));
  router.put(b('/hardware/tinting/settings'), context('hardware_tinting.edit'), async (req, res) => send(res, await tinting.saveSettings(req.business, req.user, req.body)));
  list('/hardware/tinting', 'hardware-tint-jobs', 'hardware_tinting.view', tinting.requireTinting);
  router.get(b('/hardware/tinting/approvers'), context('hardware_tinting.create'), async (req, res) => { tinting.requireTinting(req.business); send(res, await pins.approvers(req.business, 'sales.refund')); });
  router.post(b('/hardware/tinting/:id/tinted'), context('hardware_tinting.create'), async (req, res) => send(res, await tinting.tinted(req.business, req.user, req.params.id)));
  router.post(b('/hardware/tinting/:id/handed-over'), context('hardware_tinting.create'), async (req, res) => send(res, await tinting.handedOver(req.business, req.user, req.params.id)));
  router.post(b('/hardware/tinting/:id/take-back'), context('hardware_tinting.create'), async (req, res) => send(res, await tinting.takeBack(req.business, req.user, req.params.id, req.body), 201));
};
