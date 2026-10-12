const { pinLimiter } = require('../../../../middlewares/rateLimiters');
const counter = require('../services/businessCounter.service');
const kits = require('../services/businessKits.service');
const finance = require('../../fashion-electronics/services/businessFinance.service');

// Round 2 (R2-CORE): the shared counter's per-staff PIN, kits / bundles, and
// EMI & finance (electronics). Mounted by business.routes.js with its
// context() (membership → module → permission) and send().
module.exports = (router, { context, send, b }) => {
  // Shared till: who can bill here, and switching the till to one of them by PIN.
  router.get(b('/counter/staff'), context('sales.create'), async (req, res) => send(res, await counter.staff(req.business, req.user)));
  router.post(b('/counter/switch'), pinLimiter, context('sales.create'), async (req, res) =>
    send(res, await counter.switchTo(req.business, req.user, req.body, { ip: req.ip, userAgent: req.get('user-agent') })));

  // Kits and bundles.
  router.get(b('/kits'), context('catalog.view'), async (req, res) => send(res, await kits.list(req.business, req.query)));
  router.post(b('/kits'), context('catalog.create'), async (req, res) => send(res, await kits.create(req.business, req.user, req.body), 201));
  router.patch(b('/kits/:id'), context('catalog.edit'), async (req, res) => send(res, await kits.update(req.business, req.user, req.params.id, req.body)));

  // EMI & finance: financiers, cases, what each financier owes, payouts, cancelling.
  router.get(b('/finance/financiers'), context(['finance.view', 'finance.create']), async (req, res) => send(res, await finance.financiers(req.business)));
  router.post(b('/finance/financiers'), context('finance.edit'), async (req, res) => send(res, await finance.createFinancier(req.business, req.user, req.body), 201));
  router.patch(b('/finance/financiers/:id'), context('finance.edit'), async (req, res) => send(res, await finance.updateFinancier(req.business, req.user, req.params.id, req.body)));
  router.get(b('/finance/cases'), context('finance.view'), async (req, res) => send(res, await finance.cases(req.business, req.query)));
  router.get(b('/finance/outstanding'), context('finance.view'), async (req, res) => send(res, await finance.outstanding(req.business)));
  router.post(b('/finance/settlements'), context('finance.edit'), async (req, res) => send(res, await finance.settle(req.business, req.user, req.body), 201));
  router.post(b('/finance/cases/:id/cancel'), context('finance.edit'), async (req, res) => send(res, await finance.cancel(req.business, req.user, req.params.id, req.body)));
};
