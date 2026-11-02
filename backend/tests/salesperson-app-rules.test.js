const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/modules/business/wholesale/services/salespersonAppRules');

// The salesperson app's rules that need no database
// (wholesale/services/salespersonAppRules.js): distances between places, a
// place as the phone sends it, a UPI reference and a cheque number, the day
// of the week, a map link and the day's figures.

test('the distance between two places, in whole metres', () => {
  const shop = { latitude: 18.508934, longitude: 73.926041 };
  assert.equal(rules.distanceMetres(shop, shop), 0);
  // About 111.2 km to a degree of latitude: 0.0009 degrees north is 100 m.
  assert.equal(rules.distanceMetres(shop, { latitude: 18.509833, longitude: 73.926041 }), 100);
  // Pune to Mumbai's CST, about 120 km as the crow flies.
  const km = rules.distanceMetres({ latitude: 18.5204, longitude: 73.8567 }, { latitude: 18.9398, longitude: 72.8355 }) / 1000;
  assert.ok(km > 115 && km < 125, String(km));
  // Symmetric.
  assert.equal(rules.distanceMetres(shop, { latitude: 18.6, longitude: 73.8 }), rules.distanceMetres({ latitude: 18.6, longitude: 73.8 }, shop));
});

test('a place as the phone sends it: on Earth, with its accuracy in metres', () => {
  assert.equal(rules.readPlace(undefined), null);
  assert.equal(rules.readPlace(null), null);
  assert.deepEqual(rules.readPlace({ latitude: '18.50893412', longitude: 73.9260411, accuracy: 12.6 }), { latitude: 18.508934, longitude: 73.926041, accuracy: 13 });
  assert.deepEqual(rules.readPlace({ latitude: 18.5, longitude: 73.9 }), { latitude: 18.5, longitude: 73.9, accuracy: null });
  for (const bad of [{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: 'x', longitude: 1 }, [1, 2], 'here', { latitude: 1, longitude: 1, accuracy: -5 }]) {
    assert.throws(() => rules.readPlace(bad), { statusCode: 400 }, JSON.stringify(bad));
  }
});

test('a UPI reference is 12 digits; a cheque number six', () => {
  assert.equal(rules.readUtr('4123 4567 8901'), '412345678901');
  for (const bad of ['41234567890', '4123456789012', 'UTR412345678', '', null]) assert.throws(() => rules.readUtr(bad), { statusCode: 400 }, String(bad));
  assert.equal(rules.readChequeNo(' 004512 '), '004512');
  for (const bad of ['4512', '1234567', 'abcdef', undefined]) assert.throws(() => rules.readChequeNo(bad), { statusCode: 400 }, String(bad));
});

test('the day of the week, a map link, and the no-order reasons', () => {
  assert.equal(rules.isoWeekday('2026-11-02'), 1, 'a Monday');
  assert.equal(rules.isoWeekday('2026-11-08'), 7, 'a Sunday');
  assert.equal(rules.mapsLink(18.5, 73.9), 'https://www.google.com/maps?q=18.500000,73.900000');
  assert.deepEqual(Object.keys(rules.NO_ORDER_REASONS), ['shop_closed', 'owner_away', 'enough_stock', 'dues_or_hold', 'price_or_scheme', 'other_brand', 'order_later', 'other']);
  assert.equal(rules.CASH_LIMIT_PAISE, 20000000);
});

test("the day's figures: strike rate, beat adherence and lines per call, and nothing to divide by", () => {
  assert.deepEqual(rules.dayFigures({ planned: 30, visitedPlanned: 27, calls: 32, productive: 21, lines: 103 }), { strike_rate: 66, adherence: 90, lines_per_call: 4.9 });
  assert.deepEqual(rules.dayFigures({}), { strike_rate: null, adherence: null, lines_per_call: null });
  assert.deepEqual(rules.dayFigures({ planned: 0, calls: 3, productive: 0 }), { strike_rate: 0, adherence: null, lines_per_call: null });
});
