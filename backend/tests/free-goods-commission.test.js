const { test } = require('node:test');
const assert = require('node:assert/strict');
const maths = require('../src/modules/business/wholesale/services/freeGoodsMaths');
const { reversalOf } = require('../src/modules/business/garage/services/garageReversal');

// The arithmetic of free goods kept on a return of a wholesale invoice and of
// a mechanic's commission taken back on a credit, without a database.

test('the free goods that belong to the paid goods returned, to the thousandth of their unit', () => {
  // 96 free with 480 paid: a quarter returned brings 24 of them.
  assert.equal(maths.belongs(96000, 120000, 480000), 24000);
  // 1 free with 10 paid: 3 returned bring 0.3 of it, a third of 1 with 3 paid 0.333, half a thousandth up.
  assert.equal(maths.belongs(1000, 3000, 10000), 300);
  assert.equal(maths.belongs(1000, 1000, 3000), 333);
  assert.equal(maths.belongs(1000, 2000, 3000), 667);
  // Rounded to another number of places when asked: whole units.
  assert.equal(maths.belongs(1000, 5000, 10000, 0), 1000);
  assert.equal(maths.belongs(1000, 4000, 10000, 0), 0);
  // Never more than all of them, and nothing before anything paid comes back.
  assert.equal(maths.belongs(96000, 900000, 480000), 96000);
  assert.equal(maths.belongs(96000, 0, 480000), 0);
  assert.equal(maths.belongs(0, 120000, 480000), 0);
});

test('what is kept: what belongs and did not come back, never below nothing', () => {
  assert.equal(maths.keptOf(48000, 24000), 24000);
  assert.equal(maths.keptOf(48000, 72000), 0);
});

test('the value of free goods kept, to the paisa, with GST at the paid line\'s rate', () => {
  // The paid lines' own value per unit: ₹4,704.00 for 480 is ₹9.80 a unit.
  const price = { net: 470400, milli: 480000 };
  assert.equal(maths.valueOf(24000, price), 23520);
  assert.equal(maths.taxOf(23520, 1800), 4234);
  assert.equal(maths.unitValue(price), 9.8);
  // A price of another item on the order, before GST, or with GST taken out at its rate.
  assert.deepEqual(maths.listPrice('12.5'), { net: 125000, milli: 100000 });
  assert.equal(maths.valueOf(2000, maths.listPrice('12.5')), 2500);
  assert.equal(maths.valueOf(1000, maths.listPrice('118', true, 1800)), 10000);
});

test('a return\'s change in what is kept nets to nothing when the goods come back', () => {
  const price = { net: 470400, milli: 480000 };
  const kept = maths.change({ quantity: 0, net: 0, tax: 0 }, 24000, price, 1800);
  assert.deepEqual(kept, { quantity: 24000, net: 23520, tax: 4234 });
  const back = maths.change(kept, 0, price, 1800);
  assert.deepEqual(back, { quantity: -24000, net: -23520, tax: -4234 });
  // Kept in two steps, the value is worked out on the whole kept so far.
  const one = maths.change({ quantity: 0, net: 0, tax: 0 }, 1000, { net: 1000, milli: 3000 }, 1800);
  const two = maths.change(one, 2000, { net: 1000, milli: 3000 }, 1800);
  assert.equal(one.net + two.net, maths.valueOf(2000, { net: 1000, milli: 3000 }));
  assert.equal(one.tax + two.tax, maths.taxOf(maths.valueOf(2000, { net: 1000, milli: 3000 }), 1800));
});

test('commission taken back in proportion to the labour credited, adding up to what was earned', () => {
  const earned = { amount: 2542, base: 25424, lineNet: 25424 };
  const first = reversalOf(earned, 8475);
  assert.deepEqual(first, { amount: 847, base: 8475 });
  const second = reversalOf(earned, 25424, first);
  assert.deepEqual(second, { amount: 1695, base: 16949 });
  assert.equal(first.amount + second.amount, earned.amount);
  const both = { amount: first.amount + second.amount, base: first.base + second.base };
  // A labour line partly on an insurer's bill: what its bill line carries of the labour only.
  assert.deepEqual(reversalOf({ amount: 15000, base: 150000, lineNet: 150000 }, 42373), { amount: 4237, base: 42373 });
  // Never more than was earned, never below nothing, nothing for a line with no value.
  assert.deepEqual(reversalOf(earned, 99999, both), { amount: 0, base: 0 });
  assert.deepEqual(reversalOf({ amount: 100, base: 1000, lineNet: 0 }, 500), { amount: 0, base: 0 });
});
