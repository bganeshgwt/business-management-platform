const { test } = require('node:test');
const assert = require('node:assert/strict');
const money = require('../src/modules/business/shop/services/shopMoney');
const slots = require('../src/modules/business/shop/services/shopSlots');
const status = require('../src/modules/business/shop/services/shopStatus');
const rules = require('../src/modules/business/shop/services/shopRules');

// The online shop's pure rules: the money of an order, the delivery slots,
// the statuses both sides show, and the never-online rules' shape (each rule
// is also checked end to end, item by item, in
// integration/online-shop.test.js).

test('a guest sees one price with GST inside it, never above the MRP', () => {
  assert.equal(money.shelfPaise('118.00', 18, 'inclusive'), 11800);
  assert.equal(money.shelfPaise('100.00', 18, 'exclusive'), 11800);
  assert.equal(money.shelfPaise('99.99', 18, 'exclusive'), 11799);
  // A branch price above the MRP is still sold at the MRP at most.
  assert.equal(money.shelfPaise('130.00', 18, 'inclusive', '125.00'), 12500);
  assert.equal(money.shelfPaise('100.00', 5, 'exclusive', '105.00'), 10500);
});

test('a cart adds up its lines, the delivery charge and the rounding, and says what is missing', () => {
  const lines = [{ pricePaise: 5500, quantity: 2 }, { pricePaise: 4999, quantity: 1 }];
  const pickup = money.cartTotals({ lines, service: 'pickup', fee: 3000, freeAbove: 50000, minOrder: 20000, rounding: 'nearest_rupee' });
  assert.deepEqual([pickup.itemsTotal, pickup.delivery, pickup.total, pickup.roundOff, pickup.moreForFree, pickup.moreForMinimum], [15999, 0, 16000, 1, 0, 0]);
  const delivery = money.cartTotals({ lines, service: 'delivery', fee: 3000, freeAbove: 50000, minOrder: 20000, rounding: 'nearest_rupee' });
  assert.deepEqual([delivery.delivery, delivery.total, delivery.moreForFree, delivery.moreForMinimum], [3000, 19000, 34001, 4001]);
  const free = money.cartTotals({ lines: [{ pricePaise: 50000, quantity: 1 }], service: 'delivery', fee: 3000, freeAbove: 50000, rounding: 'none' });
  assert.deepEqual([free.delivery, free.total, free.moreForFree], [0, 50000, 0]);
  const never = money.cartTotals({ lines: [{ pricePaise: 90000, quantity: 1 }], service: 'delivery', fee: 3000, freeAbove: null, rounding: 'none' });
  assert.equal(never.delivery, 3000);
  // A weighed line's quantity is about so much: up to 10% more of it is agreed with the order.
  const weighed = money.cartTotals({ lines: [{ pricePaise: 6000, quantity: 0.5, weighed: true }, { pricePaise: 2000, quantity: 1 }], service: 'pickup', rounding: 'none' });
  assert.deepEqual([weighed.itemsTotal, weighed.allowance], [5000, 300]);
});

test('the delivery charge is shared over the goods\' GST rates by their value, to the paisa', () => {
  assert.deepEqual(money.splitByRate(3000, [{ rate: 5, amount: 10000 }]), [{ rate: 5, amount: 3000 }]);
  const split = money.splitByRate(3000, [{ rate: 5, amount: 20000 }, { rate: 18, amount: 10000 }, { rate: 5, amount: 10000 }]);
  // ₹300 of goods at 5% and ₹100 at 18%: three quarters and a quarter of ₹30.
  assert.deepEqual(split, [{ rate: 5, amount: 2250 }, { rate: 18, amount: 750 }]);
  const odd = money.splitByRate(1001, [{ rate: 0, amount: 1 }, { rate: 12, amount: 1 }, { rate: 18, amount: 1 }]);
  assert.equal(odd.reduce((sum, part) => sum + part.amount, 0), 1001);
  assert.deepEqual(money.splitByRate(0, [{ rate: 5, amount: 100 }]), []);
  // GST inside an amount, and an amount shared over batches by quantity.
  assert.deepEqual(money.inclusiveParts(11800, 18), { net: 10000, tax: 1800 });
  assert.deepEqual(money.inclusiveParts(1000, 0), { net: 1000, tax: 0 });
  const shares = money.shareByQuantity(10001, [1000, 2000, 1500]);
  assert.equal(shares.reduce((sum, share) => sum + share, 0), 10001);
});

test('a lower price stays within the business\'s bill discount limit', () => {
  assert.equal(money.discountRoom({ goodsAmount: 100000, takenOff: 0, limitPercent: 10 }), 10000);
  assert.equal(money.discountRoom({ goodsAmount: 100000, takenOff: 9000, limitPercent: '10.00' }), 1000);
  assert.equal(money.discountRoom({ goodsAmount: 100000, takenOff: 12000, limitPercent: 10 }), 0);
  assert.equal(money.discountRoom({ goodsAmount: 100000, takenOff: 0, limitPercent: null }), 0);
});

test('a pack\'s net quantity gives its unit sale price', () => {
  assert.deepEqual(money.readNetQuantity('Tata Salt 1 kg'), { base: 'g', amount: 1000 });
  assert.deepEqual(money.readNetQuantity('500 g'), { base: 'g', amount: 500 });
  assert.deepEqual(money.readNetQuantity('1.5 L'), { base: 'ml', amount: 1500 });
  assert.deepEqual(money.readNetQuantity('200ml'), { base: 'ml', amount: 200 });
  assert.deepEqual(money.readNetQuantity('12 pcs'), { base: 'piece', amount: 12 });
  assert.equal(money.readNetQuantity('Parle-G biscuits'), null);
  assert.deepEqual(money.unitSalePrice(2800, { base: 'g', amount: 1000 }), { amount: 2800, per: 'kg' });
  assert.deepEqual(money.unitSalePrice(5000, { base: 'g', amount: 500 }), { amount: 10, per: 'g' });
  assert.deepEqual(money.unitSalePrice(18000, { base: 'ml', amount: 1500 }), { amount: 12000, per: 'litre' });
  assert.deepEqual(money.unitSalePrice(6000, { base: 'piece', amount: 12 }), { amount: 500, per: 'piece' });
  assert.equal(money.unitSalePrice(6000, null), null);
});

test('delivery slots: checked, offered for today and tomorrow, closed after the cut-off and when full', () => {
  assert.throws(() => slots.readSlots([{ from: '10:00', to: '10:10', cap: 5 }]), /between 30 minutes and 6 hours/);
  assert.throws(() => slots.readSlots([{ from: '10:00', to: '12:00', cap: 0 }]), /between 1 and 500/);
  assert.throws(() => slots.readSlots([{ from: '10:00', to: '12:00', cap: 5 }, { from: '11:00', to: '13:00', cap: 5 }]), /overlap/);
  const list = slots.readSlots([{ from: '16:00', to: '18:00', cap: 2 }, { from: '10:00', to: '12:00', cap: 5 }]);
  assert.deepEqual(list.map((slot) => slot.from), ['10:00', '16:00']);
  const offered = slots.offered({ slots: list, cutoffMinutes: 60, today: '2026-11-02', nowMinutes: 14 * 60 + 30, weekday: 'mon',
    hours: { mon: { open: '09:00', close: '21:00' }, tue: { open: '09:00', close: '21:00' } }, taken: new Map([['2026-11-02 16:00', 1], ['2026-11-03 16:00', 2]]) });
  assert.deepEqual(offered.map((slot) => [slot.date, slot.from, slot.open, slot.left]), [
    ['2026-11-02', '10:00', false, 5], ['2026-11-02', '16:00', true, 1], ['2026-11-03', '10:00', true, 5], ['2026-11-03', '16:00', false, 0]]);
  // A day the location is closed offers no slot; at 15:01 the 16:00 slot is past its cut-off.
  const sunday = slots.offered({ slots: list, cutoffMinutes: 60, today: '2026-11-07', nowMinutes: 15 * 60 + 1, weekday: 'sat',
    hours: { sat: { open: '09:00', close: '21:00' } }, taken: new Map() });
  assert.deepEqual(sunday.map((slot) => [slot.date, slot.from, slot.open]), [['2026-11-07', '10:00', false], ['2026-11-07', '16:00', false]]);
  assert.equal(slots.addDays('2026-12-31', 1), '2027-01-01');
});

test('both sides tell the same story: stages, steps, lanes and what the guest may still do', () => {
  const clock = (at) => `at ${at}`;
  const placed = { status: 'placed', service: 'delivery', auto_decline_at: 'T30', placed_at: 'T0' };
  assert.match(status.stageOf(placed, clock).detail, /at T30/);
  assert.equal(status.canCancel(placed), true);
  assert.equal(status.canChange(placed), true);
  assert.equal(status.canCancel({ status: 'accepted', packing_at: null }), true);
  assert.equal(status.canCancel({ status: 'accepted', packing_at: 'T5' }), false);
  assert.equal(status.canChange({ status: 'accepted', packing_at: null }), false);
  assert.equal(status.stageOf({ status: 'declined', declined_auto: true }).label, 'The shop did not respond');
  assert.equal(status.stageOf({ status: 'cancelled', cancelled_by: 'shop', cancel_reason: 'Refused at the door' }).detail, 'Refused at the door');
  assert.deepEqual(status.stepsOf({ service: 'pickup', placed_at: 'T0', accepted_at: 'T1' }, clock).map((step) => [step.key, step.at]),
    [['placed', 'at T0'], ['accepted', 'at T1'], ['packed', null], ['ready', null], ['completed', null]]);
  assert.equal(status.currentStep({ status: 'cancelled', packed_at: 'T3', out_at: 'T4' }), 'out_for_delivery');
  assert.deepEqual(['placed', 'accepted', 'ready', 'completed'].map(status.laneOf), ['new', 'packing', 'out', 'done']);
});

test('the never-online rules: one SQL expression, every rule in it, with its words', () => {
  const sql = rules.neverOnlineSql({ sku: 'x', product: 'y', words: 'w.path' });
  for (const code of Object.keys(rules.NEVER_ONLINE)) assert.match(sql, new RegExp(`THEN '${code}'`), `${code} is a rule`);
  assert.match(sql, /x\.internal_use/);
  assert.match(sql, /y\.kind <> 'goods'/);
  assert.match(sql, /w\.path/);
  assert.match(sql, /schedule IN \('H','H1','X','narcotic'\)/);
  // HSN codes: tobacco and e-cigarettes, alcohol.
  const tobacco = new RegExp(rules.TOBACCO_HSN);
  const alcohol = new RegExp(rules.ALCOHOL_HSN);
  for (const hsn of ['2401', '24021010', '240311', '240412', '85434000']) assert.ok(tobacco.test(hsn), hsn);
  for (const hsn of ['2404', '24049100', '2106', '8543']) assert.ok(!tobacco.test(hsn), hsn);
  for (const hsn of ['2203', '22042100', '2208']) assert.ok(alcohol.test(hsn), hsn);
  for (const hsn of ['2201', '2202', '2209']) assert.ok(!alcohol.test(hsn), hsn);
  // Words, only for an item with no HSN code.
  assert.equal(rules.keywordRule('Gold Flake Kings cigarettes 20s'), 'tobacco');
  assert.equal(rules.keywordRule('Ganesh Beedi bundle'), 'tobacco');
  assert.equal(rules.keywordRule('Kingfisher Beer 650 ml'), 'alcohol');
  assert.equal(rules.keywordRule('Old Monk Rum'), 'alcohol');
  assert.equal(rules.keywordRule('Rumali roti'), null);
  assert.equal(rules.keywordRule('Ginger garlic paste'), null);
  assert.equal(rules.keywordRule('Tata Salt 1 kg'), null);
});
