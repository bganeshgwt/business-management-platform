const express = require('express');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const receivables = require('../services/businessReceivables.service');
const wholesale = require('../services/businessWholesale.service');
const prices = require('../services/businessWholesalePricing.service');
const credit = require('../services/businessWholesaleCredit.service');
const delivery = require('../services/businessWholesaleDelivery.service');
const money = require('../services/businessWholesaleMoney.service');
const purchases = require('../services/businessWholesalePurchase.service');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');

// Trade routes, mounted inside business.routes.js (so they share its
// login check and its database-error translation):
//   shared receivables  — collections, outstanding and ageing, statements
//   wholesale           — salespeople, routes, beats, sales orders, dispatch,
//                         back-orders, wholesale reports; cheques, follow-ups,
//                         settlements, order edits, credit hold, price groups
//                         and schemes, dispatch board, pick list, delivery
//                         runs, delivery and van returns, trade details,
//                         claims, overview
// Every route loads the membership first (404 when there is none), then the
// module and permission (403); services repeat the permission check.

const router = express.Router();
const send = (res, data, status = 200) => res.status(status).json({ success: true, data });
const context = (permission) => async (req, res, next) => {
  // Opening the business lets GST rate changes whose date has come take effect first.
  req.business = await access.open(req.user, req.params.businessId);
  // A person tied to one location works there only; a branch picked in the top bar fills in the location a request leaves out.
  access.scope(req, req.business);
  if (Array.isArray(permission)) await access.requireAny(req.business, permission);
  else if (permission) await access.require(req.business, permission);
  next();
};
const b = (path) => `/:businessId${path}`;
const readDate = (value, name) => (value === undefined || value === '' ? null : core.dateText(value, name));

// Server-paged lists, the same contract as the core lists.
const LISTS = {
  collections: 'receivables.view', cheques: 'receivables.view', settlements: 'receivables.view',
  'price-groups': 'wholesale.view', 'group-prices': 'wholesale.view', schemes: 'wholesale.view',
  'delivery-runs': 'sales_orders.view', dispatches: 'sales_orders.view', claims: 'purchasing.view',
  salespeople: 'sales_orders.view', routes: 'sales_orders.view', beats: 'sales_orders.view',
  'customer-beats': 'sales_orders.view', 'sales-orders': 'sales_orders.view', 'back-orders': 'sales_orders.view',
  'purchase-orders': 'purchasing.view',
};
for (const [name, permission] of Object.entries(LISTS)) {
  router.get(b(`/${name}`), context(permission), async (req, res) => {
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = {};
    for (const key of repo.listFilters(name)) {
      const value = req.query[key];
      if (value === undefined || value === '') continue;
      // "open,part_dispatched": any of several values.
      filters[key] = String(value).includes(',') ? String(value).slice(0, 120).split(',').slice(0, 10) : String(value).slice(0, 60);
    }
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const from = readDate(req.query.from, 'From date'), to = readDate(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    send(res, await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters }));
  });
}

// --- Shared receivables ---------------------------------------------------------------
router.post(b('/collections'), context('receivables.create'), async (req, res) => send(res, await wholesale.collect(req.business, req.user, req.body), 201));
router.get(b('/collections/:id'), context('receivables.view'), async (req, res) => send(res, await receivables.collectionDetail(req.business, req.params.id)));
router.get(b('/outstanding'), context('receivables.view'), async (req, res) => {
  // A route filter needs the wholesale module; it narrows to that route's customers.
  let contactIds = null;
  if (req.query.route) {
    await access.require(req.business, 'sales_orders.view');
    contactIds = await wholesale.routeCustomers(req.business, req.query.route);
  }
  send(res, await receivables.outstanding(req.business, req.query, { contactIds }));
});
router.get(b('/receivables/customers/:id'), context('receivables.view'), async (req, res) => send(res, await receivables.customerAccount(req.business, req.params.id)));
router.get(b('/receivables/customers/:id/open-bills'), context('receivables.view'), async (req, res) => send(res, await receivables.customerOpenBills(req.business, req.params.id)));
router.get(b('/receivables/customers/:id/statement'), context('receivables.view'), async (req, res) => send(res, await receivables.statement(req.business, req.params.id, req.query)));
router.post(b('/receivables/customers/:id/apply-advance'), context('receivables.create'), async (req, res) => send(res, await receivables.applyAdvance(req.business, req.user, req.params.id, req.body), 201));

// --- Wholesale ------------------------------------------------------------------------------
router.post(b('/salespeople'), context('sales_orders.edit'), async (req, res) => send(res, await wholesale.saveSalesperson(req.business, req.user, null, req.body), 201));
router.patch(b('/salespeople/:id'), context('sales_orders.edit'), async (req, res) => send(res, await wholesale.saveSalesperson(req.business, req.user, req.params.id, req.body)));
router.post(b('/routes'), context('sales_orders.edit'), async (req, res) => send(res, await wholesale.saveRoute(req.business, req.user, null, req.body), 201));
router.patch(b('/routes/:id'), context('sales_orders.edit'), async (req, res) => send(res, await wholesale.saveRoute(req.business, req.user, req.params.id, req.body)));
router.post(b('/beats'), context('sales_orders.edit'), async (req, res) => send(res, await wholesale.saveBeat(req.business, req.user, null, req.body), 201));
router.patch(b('/beats/:id'), context('sales_orders.edit'), async (req, res) => send(res, await wholesale.saveBeat(req.business, req.user, req.params.id, req.body)));
router.put(b('/customer-beats/:id'), context('sales_orders.edit'), async (req, res) => send(res, await wholesale.setCustomerBeat(req.business, req.user, req.params.id, req.body)));
router.post(b('/sales-orders'), context('sales_orders.create'), async (req, res) => send(res, await wholesale.createOrder(req.business, req.user, req.body), 201));
router.get(b('/sales-orders/:id'), context('sales_orders.view'), async (req, res) => send(res, await wholesale.orderDetail(req.business, req.params.id)));
router.post(b('/sales-orders/:id/dispatch'), context('sales_orders.approve'), async (req, res) => send(res, await wholesale.dispatch(req.business, req.user, req.params.id, req.body), 201));
router.post(b('/sales-orders/:id/close'), context('sales_orders.cancel'), async (req, res) => send(res, await wholesale.closeOrder(req.business, req.user, req.params.id, req.body)));
router.get(b('/wholesale-reports'), context('reports.view'), async (req, res) => send(res, await wholesale.reports(req.business, req.query)));

// --- Money ---------------------------------------------------------------------
router.post(b('/collections/:id/cheque'), context(['receivables.create', 'receivables.approve']), async (req, res) => send(res, await receivables.chequeAction(req.business, req.user, req.params.id, req.body)));
router.post(b('/receivables/customers/:id/follow-ups'), context('receivables.create'), async (req, res) => send(res, await receivables.addFollowUp(req.business, req.user, req.params.id, req.body), 201));
router.get(b('/settlements/preview'), context('receivables.view'), async (req, res) => send(res, await money.settlementPreview(req.business, req.query)));
router.post(b('/settlements'), context('receivables.approve'), async (req, res) => send(res, await money.settle(req.business, req.user, req.body), 201));
router.post(b('/claims'), context('purchasing.edit'), async (req, res) => send(res, await money.createClaim(req.business, req.user, req.body), 201));
router.patch(b('/claims/:id'), context('purchasing.edit'), async (req, res) => send(res, await money.updateClaim(req.business, req.user, req.params.id, req.body)));

// --- Orders, credit hold, customers ------------------------------------------------
router.patch(b('/sales-orders/:id'), context('sales_orders.create'), async (req, res) => send(res, await wholesale.editOrder(req.business, req.user, req.params.id, req.body)));
router.post(b('/sales-orders/:id/lines/:lineId/close'), context('sales_orders.cancel'), async (req, res) => send(res, await wholesale.closeLine(req.business, req.user, req.params.id, req.params.lineId, req.body)));
router.get(b('/sales-orders/customer-summary/:id'), context('sales_orders.view'), async (req, res) => send(res, await customerSummary(req.business, req.params.id)));
router.get(b('/hold-releasers'), context('sales_orders.create'), async (req, res) => send(res, await credit.releasers(req.business)));
router.get(b('/wholesale-settings'), context('sales_orders.view'), async (req, res) => send(res, await credit.settings(req.business)));
router.put(b('/wholesale-settings'), context('settings.edit'), async (req, res) => send(res, await credit.saveSettings(req.business, req.user, req.body)));
router.get(b('/wholesale-customers/:id'), context('contacts.view'), async (req, res) => send(res, await credit.profile(req.business, req.params.id)));
router.put(b('/wholesale-customers/:id'), context('contacts.edit'), async (req, res) => send(res, await credit.saveProfile(req.business, req.user, req.params.id, req.body)));
router.get(b('/salesperson-logins'), context('sales_orders.edit'), async (req, res) => send(res, await wholesale.salespersonLogins(req.business)));
router.get(b('/salespeople/:id/beat-sheet'), context('sales_orders.view'), async (req, res) => send(res, await money.beatSheet(req.business, req.params.id, req.query)));
router.get(b('/wholesale-summary'), context('sales_orders.view'), async (req, res) => send(res, await money.summary(req.business)));

// --- Price groups and schemes ------------------------------------------------------
router.post(b('/price-groups'), context('wholesale.edit'), async (req, res) => send(res, await prices.saveGroup(req.business, req.user, null, req.body), 201));
router.patch(b('/price-groups/:id'), context('wholesale.edit'), async (req, res) => send(res, await prices.saveGroup(req.business, req.user, req.params.id, req.body)));
router.post(b('/group-prices'), context('wholesale.edit'), async (req, res) => send(res, await prices.setGroupPrice(req.business, req.user, req.body), 201));
router.post(b('/group-prices/revise'), context('wholesale.edit'), async (req, res) => send(res, await prices.reviseGroupPrices(req.business, req.user, req.body)));
router.post(b('/group-prices/:id/end'), context('wholesale.edit'), async (req, res) => send(res, await prices.endGroupPrice(req.business, req.user, req.params.id, req.body)));
router.post(b('/schemes'), context('wholesale.edit'), async (req, res) => send(res, await prices.saveScheme(req.business, req.user, null, req.body), 201));
router.patch(b('/schemes/:id'), context('wholesale.edit'), async (req, res) => send(res, await prices.saveScheme(req.business, req.user, req.params.id, req.body)));

// --- Dispatch and delivery -----------------------------------------------------------
router.get(b('/dispatch-board'), context('sales_orders.view'), async (req, res) => send(res, await delivery.dispatchBoard(req.business, req.query)));
router.get(b('/pick-list'), context('sales_orders.view'), async (req, res) => send(res, await delivery.pickList(req.business, req.query)));
router.post(b('/delivery-runs'), context('sales_orders.approve'), async (req, res) => send(res, await delivery.createRun(req.business, req.user, req.body), 201));
router.get(b('/delivery-runs/:id'), context('sales_orders.view'), async (req, res) => send(res, await delivery.runDetail(req.business, req.params.id)));
router.patch(b('/dispatches/:id/transport'), context('sales_orders.approve'), async (req, res) => send(res, await delivery.setTransport(req.business, req.user, req.params.id, req.body)));
router.post(b('/dispatches/:id/delivery'), context('sales_orders.approve'), async (req, res) => send(res, await delivery.recordDelivery(req.business, req.user, req.params.id, req.body)));

// --- Purchase orders, delivery challan, scheme report -------------------------------
router.get(b('/purchase-orders/suggestions'), context('purchasing.view'), async (req, res) => send(res, await purchases.suggestions(req.business, req.query)));
router.post(b('/purchase-orders'), context('purchasing.create'), async (req, res) => send(res, await purchases.create(req.business, req.user, req.body), 201));
router.get(b('/purchase-orders/:id'), context('purchasing.view'), async (req, res) => send(res, await purchases.detail(req.business, req.params.id)));
router.patch(b('/purchase-orders/:id'), context('purchasing.create'), async (req, res) => send(res, await purchases.update(req.business, req.user, req.params.id, req.body)));
router.post(b('/purchase-orders/:id/send'), context('purchasing.create'), async (req, res) => send(res, await purchases.markSent(req.business, req.user, req.params.id, req.body)));
router.post(b('/purchase-orders/:id/receive'), context('purchasing.create'), async (req, res) => send(res, await purchases.receive(req.business, req.user, req.params.id, req.body), 201));
router.post(b('/purchase-orders/:id/close'), context('purchasing.create'), async (req, res) => send(res, await purchases.close(req.business, req.user, req.params.id, req.body)));
router.post(b('/dispatches/:id/challan'), context('sales_orders.view'), async (req, res) => send(res, await delivery.challan(req.business, req.user, req.params.id)));
router.get(b('/wholesale-scheme-report'), context('reports.view'), async (req, res) => send(res, await prices.schemeReport(req.business, req.query)));

// Everything the order screen shows about a customer while ordering: hold,
// last order (to repeat it) and, with receivables.view, what they owe and
// how late.
async function customerSummary(business, contactId) {
  const cid = v.requiredId(contactId, 'Customer');
  const contact = await repo.one(repo.pool, "SELECT id,name,phone,gstin,credit_limit,credit_days FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, cid]);
  if (!contact) throw new AppError(404, 'Customer not found');
  const last = await repo.one(repo.pool, `SELECT o.id,o.order_no,o.created_at,o.total,o.status,
    COALESCE((SELECT json_agg(json_build_object('sku_id',x.sku_id,'label',x.label,'unit',x.unit,'quantity',x.quantity,'entered_unit',x.entered_unit,
      'entered_quantity',x.entered_quantity,'discount_percent',x.discount_percent) ORDER BY x.id)
      FROM wholesale_order_lines x WHERE x.business_id=o.business_id AND x.order_id=o.id AND x.free_of_line_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM wholesale_order_edits e WHERE e.business_id=x.business_id AND e.order_id=x.order_id AND x.id=ANY(e.removed_line_ids))),'[]') AS lines
    FROM wholesale_orders o WHERE o.business_id=$1 AND o.contact_id=$2 AND o.status<>'cancelled' ORDER BY o.id DESC LIMIT 1`, [business.id, cid]);
  const hold = await credit.holdOf(repo.pool, business, cid);
  const account = access.can(business, 'receivables.view') ? await repo.one(repo.pool, receivables.ageingSql, [business.id, cid]) : null;
  return { contact, last_order: last || null, hold, account };
}

module.exports = router;
