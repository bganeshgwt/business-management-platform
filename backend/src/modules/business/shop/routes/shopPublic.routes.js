const express = require('express');
const { guestLimiter, MINUTE } = require('../../guests');
const { normaliseMobile } = require('../../../../utils/phone');
const orders = require('../services/shopOrders.service');
const packing = require('../services/shopPacking.service');
const complaints = require('../services/shopComplaints.service');

// A shop's online shop for its guests (API.md, public guest pages: the online
// shop), under /api/public/shop. No login: the shop by its link's token, an
// order by its own guest token. Every answer is no-store; a status answer
// carries `live` beside `data` while anything can still happen to the order.
//
// Limits (per API process; the rules that must hold, such as open orders per
// mobile, are kept in the database too):
//   - per client address: reads, cart checks and orders;
//   - per link: orders, against a flood at one shop;
//   - per mobile: orders, against one person's repeats;
//   - per order: its status reads and the guest's own actions.
const router = express.Router();

const linkKey = (req) => `shop:${String(req.params.token || '').slice(0, 64)}`;
const orderKey = (req) => `shop-order:${String(req.params.guestToken || '').slice(0, 64)}`;
const mobileKey = (req) => {
  const mobile = normaliseMobile(typeof req.body?.mobile === 'string' ? req.body.mobile : '');
  return mobile ? `shop-mobile:${mobile}` : null;
};

const reads = guestLimiter({ windowMs: MINUTE, max: 600 });
const carts = guestLimiter({ windowMs: MINUTE, max: 120 });
const ordersPerAddress = guestLimiter({ windowMs: 10 * MINUTE, max: 20, message: 'Too many orders from this network in a short time. Please wait a few minutes, or call the shop.' });
const ordersPerLink = guestLimiter({ windowMs: 10 * MINUTE, max: 200, key: linkKey, message: 'This shop is receiving a lot of orders just now. Please wait a few minutes, or call the shop.' });
const perMobile = guestLimiter({ windowMs: 30 * MINUTE, max: 6, key: mobileKey, message: 'This mobile number has sent several orders in a short time. Please wait a little, or call the shop.' });
// A body with no readable mobile is refused by the order itself; it is not counted as a mobile's.
const ordersPerMobile = (req, res, next) => (mobileKey(req) ? perMobile(req, res, next) : next());
const statusReads = guestLimiter({ windowMs: MINUTE, max: 60, key: orderKey, message: 'Please wait a moment before checking again.' });
const actions = guestLimiter({ windowMs: 10 * MINUTE, max: 30, key: orderKey, message: 'Please wait a moment and try again.' });

const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
const ok = (res, data) => res.json({ success: true, data });
// A status answer: the order, the shop's card, and the live key beside them.
const followed = (res, { live, cart, ...data }) => res.json({ success: true, data: cart ? { ...data, cart } : data, live });

router.use(noStore);

router.get('/status/:guestToken', reads, statusReads, async (req, res) => followed(res, await orders.guestOrder(req.params.guestToken)));
router.post('/status/:guestToken/cancel', reads, actions, async (req, res) => followed(res, await orders.cancelByGuest(req.params.guestToken)));
router.post('/status/:guestToken/change', reads, actions, async (req, res) => followed(res, await orders.changeByGuest(req.params.guestToken)));
router.post('/status/:guestToken/changes/:changeId', reads, actions, async (req, res) =>
  followed(res, await packing.answerByGuest(req.params.guestToken, req.params.changeId, req.body || {})));
router.post('/status/:guestToken/complaints', reads, actions, async (req, res) => followed(res, await complaints.open(req.params.guestToken, req.body || {})));

router.get('/:token', reads, async (req, res) => ok(res, await orders.shopPage(req.params.token)));
router.get('/:token/items', reads, async (req, res) => ok(res, await orders.shopItems(req.params.token, req.query)));
router.get('/:token/items/:productId', reads, async (req, res) => ok(res, await orders.shopItem(req.params.token, req.params.productId)));
router.post('/:token/cart', carts, async (req, res) => ok(res, await orders.checkCart(req.params.token, req.body || {})));
router.post('/:token/orders', ordersPerAddress, ordersPerLink, ordersPerMobile, async (req, res) => {
  const answer = await orders.place(req.params.token, req.body || {});
  res.status(answer.duplicate ? 200 : 201);
  followed(res, answer);
});

module.exports = router;
