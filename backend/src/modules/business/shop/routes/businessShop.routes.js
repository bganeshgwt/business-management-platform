const settings = require('../services/shopSettings.service');
const catalog = require('../services/shopCatalog.service');
const orders = require('../services/shopOrders.service');
const packing = require('../services/shopPacking.service');
const complaints = require('../services/shopComplaints.service');
const reports = require('../services/shopReports.service');
const photos = require('../services/shopPhotos.service');

// The online shop for staff (API.md › Online shop), under
// /api/businesses/:businessId/online-shop, with the Business Admin checks: a
// member of the business (404), the online_shop module on and the role's
// permission (403). Each service checks again what an action needs besides
// (billing: sales.create; a payment: sales.edit; refused at the door:
// sales.refund; a lower price: sales.discount). The photo upload (multipart)
// is shopUploads.routes.js, mounted before this router.
module.exports = function shopRoutes(router, { context, send, b }) {
  const at = (path) => b(`/online-shop${path}`);

  // Settings › Online shop: each location's link and settings, what shows online, blocked mobiles.
  router.get(at('/settings'), context('online_shop.view'), async (req, res) => send(res, await settings.list(req.business)));
  router.put(at('/settings/:locationId'), context('online_shop.manage'), async (req, res) => send(res, await settings.update(req.business, req.user, req.params.locationId, req.body)));
  router.post(at('/settings/:locationId/new-link'), context('online_shop.manage'), async (req, res) => send(res, await settings.newLink(req.business, req.user, req.params.locationId)));
  router.get(at('/items'), context(['online_shop.view', 'catalog.view']), async (req, res) => send(res, await catalog.staffItems(req.business, req.query)));
  router.get(at('/items/:productId'), context(['online_shop.view', 'catalog.view']), async (req, res) => send(res, await catalog.itemDetails(req.business, req.params.productId)));
  router.put(at('/items/:productId'), context(['catalog.edit', 'online_shop.manage']), async (req, res) => send(res, await catalog.saveItem(req.business, req.user, req.params.productId, req.body)));
  router.delete(at('/items/:productId/photo'), context(['catalog.edit', 'online_shop.manage']), async (req, res) => send(res, await photos.remove(req.business, req.user, req.params.productId)));
  router.get(at('/categories'), context(['online_shop.view', 'catalog.view']), async (req, res) => send(res, await catalog.categoryFlags(req.business)));
  router.put(at('/categories/:categoryId'), context(['catalog.edit', 'online_shop.manage']), async (req, res) => send(res, await catalog.setCategory(req.business, req.user, req.params.categoryId, req.body)));
  router.get(at('/blocked'), context('online_shop.view'), async (req, res) => send(res, await complaints.blocked(req.business)));
  router.post(at('/blocked'), context('online_shop.manage'), async (req, res) => send(res, await complaints.block(req.business, req.user, req.body), 201));
  router.post(at('/blocked/:blockId/lift'), context('online_shop.manage'), async (req, res) => send(res, await complaints.lift(req.business, req.user, req.params.blockId)));

  // Online orders: the board, one order, and each step from new to done.
  router.get(at('/orders'), context('online_shop.view'), async (req, res) => send(res, await orders.board(req.business, req.query)));
  router.get(at('/orders/:orderId'), context('online_shop.view'), async (req, res) => send(res, await orders.detail(req.business, req.params.orderId)));
  router.post(at('/orders/:orderId/accept'), context('online_shop.approve'), async (req, res) => send(res, await orders.accept(req.business, req.user, req.params.orderId, req.body)));
  router.post(at('/orders/:orderId/decline'), context('online_shop.approve'), async (req, res) => send(res, await orders.decline(req.business, req.user, req.params.orderId, req.body)));
  router.post(at('/orders/:orderId/cancel'), context('online_shop.cancel'), async (req, res) => send(res, await orders.cancel(req.business, req.user, req.params.orderId, req.body)));
  router.patch(at('/orders/:orderId/lines/:lineId'), context('online_shop.edit'), async (req, res) =>
    send(res, await packing.editLine(req.business, req.user, req.params.orderId, req.params.lineId, req.body)));
  router.post(at('/orders/:orderId/lines/:lineId/replace'), context('online_shop.edit'), async (req, res) =>
    send(res, await packing.replace(req.business, req.user, req.params.orderId, req.params.lineId, req.body)));
  router.post(at('/orders/:orderId/lines/:lineId/remove'), context('online_shop.edit'), async (req, res) =>
    send(res, await packing.removeLine(req.business, req.user, req.params.orderId, req.params.lineId, req.body)));
  router.post(at('/orders/:orderId/lines'), context('online_shop.edit'), async (req, res) => send(res, await packing.add(req.business, req.user, req.params.orderId, req.body), 201));
  router.post(at('/orders/:orderId/ask'), context('online_shop.edit'), async (req, res) => send(res, await packing.ask(req.business, req.user, req.params.orderId, req.body)));
  router.post(at('/orders/:orderId/changes/:changeId/answer'), context('online_shop.edit'), async (req, res) =>
    send(res, await packing.answerByPhone(req.business, req.user, req.params.orderId, req.params.changeId, req.body)));
  router.post(at('/orders/:orderId/bill'), context('online_shop.edit'), async (req, res) => send(res, await packing.bill(req.business, req.user, req.params.orderId, req.body)));
  router.post(at('/orders/:orderId/ready'), context('online_shop.edit'), async (req, res) => send(res, await packing.ready(req.business, req.user, req.params.orderId)));
  router.post(at('/orders/:orderId/out'), context('online_shop.edit'), async (req, res) => send(res, await packing.out(req.business, req.user, req.params.orderId, req.body)));
  router.post(at('/orders/:orderId/complete'), context('online_shop.edit'), async (req, res) => send(res, await packing.complete(req.business, req.user, req.params.orderId, req.body)));
  router.post(at('/orders/:orderId/refused'), context('online_shop.cancel'), async (req, res) => send(res, await packing.refused(req.business, req.user, req.params.orderId, req.body)));

  // Complaints and the report.
  router.get(at('/complaints'), context('online_shop.view'), async (req, res) => send(res, await complaints.list(req.business, req.query)));
  router.post(at('/complaints/:complaintId/acknowledge'), context('online_shop.review'), async (req, res) =>
    send(res, await complaints.acknowledge(req.business, req.user, req.params.complaintId, req.body)));
  router.post(at('/complaints/:complaintId/resolve'), context('online_shop.review'), async (req, res) =>
    send(res, await complaints.resolve(req.business, req.user, req.params.complaintId, req.body)));
  router.get(at('/report'), context('online_shop.view'), async (req, res) => send(res, await reports.report(req.business, req.query)));
};
