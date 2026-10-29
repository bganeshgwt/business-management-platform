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
const access = require('../../core/services/businessAccess.service');
const karigars = require('../services/jewelleryKarigars.service');
const orders = require('../services/jewelleryOrders.service');
const approvals = require('../services/jewelleryApprovals.service');
const hallmarking = require('../services/jewelleryHallmarking.service');
const tags = require('../services/jewelleryTags.service');
const files = require('../services/jewelleryFiles.service');
const fineWeight = require('../services/jewelleryFineWeight.service');
const supplierMetal = require('../services/jewellerySupplierMetal.service');
const refinery = require('../services/jewelleryRefinery.service');
const offers = require('../services/jewelleryOffers.service');
const kyc = require('../services/jewelleryKyc.service');
const str = require('../services/jewelleryStr.service');

// Jewellery shops, added to the Business Admin router so they share its
// login, membership, module and permission checks (context) and its
// database-error translation:
//   /:businessId/jewellery/rates…        today's rates in use (with the board's), a new rate sheet, every sheet
//   /:businessId/jewellery/settings      how tags are numbered, the hallmarking charge a new piece starts with, the rate sessions, the buy-back
//                                        rules, the cash alert levels, the KYC kinds, a discount on metal, the company's net worth
//   /:businessId/jewellery/items…        the jewellery items (catalogue items sold as tagged pieces) and their defaults
//   /:businessId/jewellery/pieces…       pieces by tag or HUID; tagging, changing, splitting, merging, a new tag, melting
//   /:businessId/jewellery/metal…        the shop's own metal by purity and its movements
//   /:businessId/jewellery/bills…        the jewellery bill (a preview, then the core's sale at fixed prices), the bills, a customer's credit on returned ones
//   /:businessId/jewellery/old-gold…     old gold vouchers: valued (a preview), taken in, paid out (several of a seller's at once), cancelled,
//                                        put back from a returned bill, and what happens to each line's metal next
//   /:businessId/jewellery/refinery…     the shop's metal sent to a refiner (back refined) or to a bullion dealer (sold)
//   /:businessId/jewellery/scheme-plans… the gold scheme plans the shop offers
//   /:businessId/jewellery/schemes…      gold schemes: joining, instalments, stopping one, closing one on its day 364 into safekeeping and the
//                                        customer collecting it, its money put back from a returned bill, the schemes and the money held for them
//   /:businessId/jewellery/offers…       the shop's offers on making, by dates
//   /:businessId/jewellery/cash-report…  the cash with each person (linked by PAN, phone or family group), flagged at ₹10 lakh, the monthly
//                                        worksheet (nothing is filed), and the family groups
//   /:businessId/jewellery/kyc/:contactId… a customer's KYC documents and a firm's beneficial owners
//   /:businessId/jewellery/str…          the suspicious transaction case log (its own permission; nothing is filed)
//   /:businessId/jewellery/karigars…     karigars, their rates, wastage and account; issue challans, receipts, write-offs, labour invoices, ITC-04 data
//   /:businessId/jewellery/orders…       custom orders: booked, advances (money or old gold, fixing the rate), pieces, ready, cancelled
//   /:businessId/jewellery/approvals…    approval challans out to customers and jewellers, pieces back (a sale is the jewellery bill)
//   /:businessId/jewellery/hallmarking…  consignments to a hallmarking centre and back with HUIDs; the HUID list
//   /:businessId/jewellery/fine-weight…  the fine-weight book by purity and the counts against it
//   /:businessId/jewellery/metal-account… metal with suppliers in fine weight, received and given, and fixed into money
//   /:businessId/jewellery/files/:id     a photo taken off its piece or order (photos are added and opened by jewelleryUploads.routes.js)
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
  // Who may approve: stopping a scheme, or an old gold deduction other than the buy-back rule's.
  router.get(b('/jewellery/schemes/approvers'), context(['jewellery.create', 'jewellery.cancel']), async (req, res) => send(res, await schemes.approvers(req.business)));
  router.get(b('/jewellery/schemes/:id'), context('jewellery.view'), async (req, res) => send(res, await schemes.detail(req.business, req.params.id)));
  router.post(b('/jewellery/schemes/:id/instalments'), context('jewellery.create'), async (req, res) => send(res, await schemes.payInstalment(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/schemes/:id/stop'), context('jewellery.cancel'), async (req, res) => send(res, await schemes.stop(req.business, req.user, req.params.id, req.body)));
  // Day 364: what a close comes to, the close into safekeeping, the customer collecting it; and a returned bill's scheme money put back.
  router.get(b('/jewellery/schemes/:id/close'), context('jewellery.view'), async (req, res) => send(res, await schemes.closePreview(req.business, req.params.id, req.query)));
  router.post(b('/jewellery/schemes/:id/close'), context('jewellery.approve'), async (req, res) => send(res, await schemes.close(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/schemes/:id/collect'), context('jewellery.create'), async (req, res) => send(res, await schemes.collect(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/schemes/:id/put-back'), context('jewellery.create'), async (req, res) => send(res, await schemes.putBack(req.business, req.user, req.params.id, req.body), 201));

  // The shop's offers on making, by dates.
  router.get(b('/jewellery/offers'), context('jewellery.view'), async (req, res) => send(res, await offers.list(req.business)));
  router.post(b('/jewellery/offers'), context('jewellery.approve'), async (req, res) => send(res, await offers.create(req.business, req.user, req.body), 201));
  router.put(b('/jewellery/offers/:id'), context('jewellery.approve'), async (req, res) => send(res, await offers.setActive(req.business, req.user, req.params.id, req.body)));

  // The cash report: each person's cash in and out (linked by PAN, phone or family group) with the flag at ₹10 lakh, one person's cash, the
  // monthly worksheet, and the family groups.
  router.get(b('/jewellery/cash-report'), context('jewellery.export'), async (req, res) => send(res, await cash.report(req.business, req.query)));
  router.get(b('/jewellery/cash-report/person'), context('jewellery.export'), async (req, res) => send(res, await cash.person(req.business, req.query)));
  router.get(b('/jewellery/cash-report/month'), context('jewellery.export'), async (req, res) => send(res, await cash.month(req.business, req.query)));
  router.get(b('/jewellery/cash-report/families'), context('jewellery.export'), async (req, res) => send(res, await cash.families(req.business)));
  router.post(b('/jewellery/cash-report/families'), context('jewellery.export'), async (req, res) => send(res, await cash.createFamily(req.business, req.user, req.body), 201));
  router.put(b('/jewellery/cash-report/families/:id'), context('jewellery.export'), async (req, res) => send(res, await cash.changeFamily(req.business, req.user, req.params.id, req.body)));

  // A customer's KYC: their documents (the number in full only to those who may see KYC) and a firm's beneficial owners; kept, set aside never erased.
  router.get(b('/jewellery/kyc/:contactId'), context('jewellery.view'), async (req, res) => send(res, await kyc.detail(req.business, req.params.contactId)));
  router.post(b('/jewellery/kyc/:contactId/documents'), context('jewellery.create'), async (req, res) => send(res, await kyc.addDocument(req.business, req.user, req.params.contactId, req.body), 201));
  router.post(b('/jewellery/kyc/:contactId/documents/:documentId/set-aside'), context('jewellery.manage'), async (req, res) => send(res,
    await kyc.setAsideDocument(req.business, req.user, req.params.contactId, req.params.documentId, req.body)));
  router.post(b('/jewellery/kyc/:contactId/owners'), context('jewellery.create'), async (req, res) => send(res, await kyc.addOwner(req.business, req.user, req.params.contactId, req.body), 201));
  router.post(b('/jewellery/kyc/:contactId/owners/:ownerId/set-aside'), context('jewellery.manage'), async (req, res) => send(res,
    await kyc.setAsideOwner(req.business, req.user, req.params.contactId, req.params.ownerId)));

  // The suspicious transaction case log: its own permission (the owner's alone until given), never the counter's, and nothing is filed.
  router.get(b('/jewellery/str'), context('jewellery.review'), async (req, res) => send(res, await str.list(req.business, req.query)));
  router.post(b('/jewellery/str'), context('jewellery.review'), async (req, res) => send(res, await str.open(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/str/:id'), context('jewellery.review'), async (req, res) => send(res, await str.detail(req.business, req.user, req.params.id)));
  router.post(b('/jewellery/str/:id/notes'), context('jewellery.review'), async (req, res) => send(res, await str.note(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/str/:id/decide'), context('jewellery.review'), async (req, res) => send(res, await str.decide(req.business, req.user, req.params.id, req.body)));

  // Old gold: valued as it would be (nothing saved), taken in on a voucher, paid out (one voucher, or several of one seller's at once), cancelled,
  // put back from a returned bill, what happens to a line's metal next; and the vouchers.
  router.post(b('/jewellery/old-gold/preview'), context('jewellery.create'), async (req, res) => send(res, await oldGold.preview(req.business, req.user, req.body)));
  router.post(b('/jewellery/old-gold'), context('jewellery.create'), async (req, res) => send(res, await oldGold.create(req.business, req.user, req.body), 201));
  router.post(b('/jewellery/old-gold/payouts'), context('jewellery.approve'), async (req, res) => send(res, await oldGold.payoutMany(req.business, req.user, req.body), 201));
  list('/jewellery/old-gold', 'jewellery-old-gold', 'jewellery.view', requireMoney);
  router.get(b('/jewellery/old-gold/:id'), context('jewellery.view'), async (req, res) => send(res, await oldGold.detail(req.business, req.params.id)));
  router.post(b('/jewellery/old-gold/:id/payout'), context('jewellery.approve'), async (req, res) => send(res, await oldGold.payout(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/old-gold/:id/cancel'), context('jewellery.cancel'), async (req, res) => send(res, await oldGold.cancel(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/old-gold/:id/put-back'), context('jewellery.create'), async (req, res) => send(res, await oldGold.putBack(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/old-gold/:id/next'), context('jewellery.approve'), async (req, res) => send(res, await oldGold.setNext(req.business, req.user, req.params.id, req.body)));

  // Refinery challans: the shop's metal to a refiner (back refined) or to a bullion dealer (sold on a bill).
  list('/jewellery/refinery', 'jewellery-refinery', 'jewellery.view', requireMoney);
  router.post(b('/jewellery/refinery'), context('jewellery.approve'), async (req, res) => send(res, await refinery.send(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/refinery/:id'), context('jewellery.view'), async (req, res) => send(res, await refinery.detail(req.business, req.params.id)));
  router.post(b('/jewellery/refinery/:id/back'), context('jewellery.approve'), async (req, res) => send(res, await refinery.back(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/refinery/:id/sell'), context('jewellery.approve'), async (req, res) => send(res, await refinery.sell(req.business, req.user, req.params.id, req.body)));

  // A piece split into several, several merged into one, a new tag after a repair, and a photo taken off.
  router.post(b('/jewellery/pieces/:id/split'), context('jewellery.edit'), async (req, res) => send(res, await tags.split(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/pieces/merge'), context('jewellery.edit'), async (req, res) => send(res, await tags.merge(req.business, req.user, req.body), 201));
  router.post(b('/jewellery/pieces/:id/retag'), context('jewellery.edit'), async (req, res) => send(res, await tags.retag(req.business, req.user, req.params.id, req.body), 201));
  router.delete(b('/jewellery/files/:id'), context('jewellery.view'), async (req, res) => send(res, await files.remove(req.business, req.user, req.params.id)));

  // Karigar work: the karigars and their rates, issue challans and receipts, the wastage written off, their labour invoices and the ITC-04 data.
  router.get(b('/jewellery/karigars'), context('jewellery.view'), async (req, res) => send(res, await karigars.karigars(req.business)));
  router.post(b('/jewellery/karigars'), context('jewellery.approve'), async (req, res) => send(res, await karigars.createKarigar(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/karigars/itc-04'), context('jewellery.export'), async (req, res) => send(res, await karigars.itc04(req.business, req.query)));
  list('/jewellery/karigars/issues', 'jewellery-karigar-issues', 'jewellery.view');
  router.post(b('/jewellery/karigars/issues'), context('jewellery.edit'), async (req, res) => send(res, await karigars.issue(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/karigars/issues/:id'), context('jewellery.view'), async (req, res) => send(res, await karigars.issueDetail(req.business, req.params.id)));
  list('/jewellery/karigars/receipts', 'jewellery-karigar-receipts', 'jewellery.view', null, karigars.receiptsShape);
  router.post(b('/jewellery/karigars/receipts'), context('jewellery.edit'), async (req, res) => send(res, await karigars.receive(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/karigars/receipts/:id'), context('jewellery.view'), async (req, res) => send(res, await karigars.receiptDetail(req.business, req.params.id)));
  router.post(b('/jewellery/karigars/invoices'), context('jewellery.edit'), async (req, res) => send(res, await karigars.invoice(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/karigars/:id'), context('jewellery.view'), async (req, res) => send(res, await karigars.detail(req.business, req.params.id)));
  router.put(b('/jewellery/karigars/:id'), context('jewellery.approve'), async (req, res) => send(res, await karigars.updateKarigar(req.business, req.user, req.params.id, req.body)));
  router.put(b('/jewellery/karigars/:id/rates'), context('jewellery.approve'), async (req, res) => send(res, await karigars.setRates(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/karigars/:id/write-off'), context('jewellery.approve'), async (req, res) => send(res, await karigars.writeOff(req.business, req.user, req.params.id, req.body), 201));

  // Custom orders: booked (with an advance), more advances, a piece made for it, ready, cancelled; billed on the jewellery bill.
  list('/jewellery/orders', 'jewellery-orders', 'jewellery.view', null, orders.listShape);
  router.post(b('/jewellery/orders'), context('jewellery.create'), async (req, res) => send(res, await orders.book(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/orders/:id'), context('jewellery.view'), async (req, res) => send(res, await orders.detail(req.business, req.params.id)));
  router.put(b('/jewellery/orders/:id'), context('jewellery.edit'), async (req, res) => send(res, await orders.update(req.business, req.user, req.params.id, req.body)));
  router.post(b('/jewellery/orders/:id/advances'), context('jewellery.create'), async (req, res) => send(res, await orders.addAdvance(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/orders/:id/pieces'), context('jewellery.edit'), async (req, res) => send(res, await orders.attachPiece(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/jewellery/orders/:id/ready'), context('jewellery.edit'), async (req, res) => send(res, await orders.markReady(req.business, req.user, req.params.id)));
  router.post(b('/jewellery/orders/:id/cancel'), context('jewellery.cancel'), async (req, res) => send(res, await orders.cancel(req.business, req.user, req.params.id, req.body)));

  // Approval challans: pieces out to a customer or a jeweller, and back; what they keep is sold on the jewellery bill.
  list('/jewellery/approvals', 'jewellery-approvals', 'jewellery.view', requireMoney);
  router.post(b('/jewellery/approvals'), context('jewellery.edit'), async (req, res) => send(res, await approvals.send(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/approvals/:id'), context('jewellery.view'), async (req, res) => send(res, await approvals.detail(req.business, req.params.id)));
  router.post(b('/jewellery/approvals/:id/returns'), context('jewellery.edit'), async (req, res) => send(res, await approvals.takeBack(req.business, req.user, req.params.id, req.body), 201));

  // Hallmarking: consignments to a centre and back with each piece's HUID, and the HUID list.
  list('/jewellery/hallmarking', 'jewellery-hallmarking', 'jewellery.view', null, hallmarking.listShape);
  router.post(b('/jewellery/hallmarking'), context('jewellery.edit'), async (req, res) => send(res, await hallmarking.send(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/hallmarking/huids'), context('jewellery.export'), async (req, res) => send(res, await hallmarking.huids(req.business, req.query)));
  router.get(b('/jewellery/hallmarking/:id'), context('jewellery.view'), async (req, res) => send(res, await hallmarking.detail(req.business, req.params.id)));
  router.post(b('/jewellery/hallmarking/:id/return'), context('jewellery.edit'), async (req, res) => send(res, await hallmarking.receive(req.business, req.user, req.params.id, req.body), 201));

  // The fine-weight book by purity, and a count of what is in the shop against it.
  router.get(b('/jewellery/fine-weight'), context('jewellery.view'), async (req, res) => send(res, await fineWeight.report(req.business, req.query)));
  router.post(b('/jewellery/fine-weight/counts'), context('jewellery.edit'), async (req, res) => send(res, await fineWeight.count(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/fine-weight/counts/:id'), context('jewellery.view'), async (req, res) => send(res, await fineWeight.countDetail(req.business, req.params.id)));

  // Metal with suppliers: each supplier's fine weight by purity, metal received and given, and grams fixed into money.
  router.get(b('/jewellery/metal-account'), context('jewellery.view'), async (req, res) => send(res, await supplierMetal.account(req.business)));
  list('/jewellery/metal-account/entries', 'jewellery-metal-account', 'jewellery.view', (business) => access.require(business, 'purchasing.view'));
  router.post(b('/jewellery/metal-account/entries'), context('jewellery.edit'), async (req, res) => send(res, await supplierMetal.move(req.business, req.user, req.body), 201));
  router.post(b('/jewellery/metal-account/fix'), context('jewellery.approve'), async (req, res) => send(res, await supplierMetal.fix(req.business, req.user, req.body), 201));
  router.get(b('/jewellery/metal-account/:id'), context('jewellery.view'), async (req, res) => send(res, await supplierMetal.supplierAccount(req.business, req.params.id)));
};
