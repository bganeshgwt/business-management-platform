const { test } = require("node:test");
const assert = require("node:assert/strict");

const DATABASE = require.resolve("../src/config/database");
const { isOffcut } = require("../src/modules/business/salon-weight/services/weightOffcuts");

// A cut sold for less a kilo than its whole item cost a kilo is an offcut:
// decided in integers, from the cut's price before GST and the whole item's
// cost, without the database.

// 10 kg of whole chicken that cost ₹1,800: ₹180 a kilo.
const whole = { inputValuePaise: 180000, inputKgMilli: 10000 };
const kilos = (kg) => ({ quantityMilli: kg * 1000, kgMilli: kg * 1000 });

test("the rule loads no database", () => {
  assert.equal(require.cache[DATABASE], undefined);
});

test("a cut priced below the whole item's cost a kilo is an offcut", () => {
  // Bones at ₹40 a kilo, skin at ₹30: offcuts.
  assert.equal(isOffcut({ pricePaise: 4000, ...kilos(1), ...whole }), true);
  assert.equal(isOffcut({ pricePaise: 3000, ...kilos(0.5), ...whole }), true);
  // Curry cut at ₹240 and liver at ₹200: cuts.
  assert.equal(isOffcut({ pricePaise: 24000, ...kilos(5), ...whole }), false);
  assert.equal(isOffcut({ pricePaise: 20000, ...kilos(0.5), ...whole }), false);
  // At exactly ₹180 a kilo it is not cheaper than the whole item.
  assert.equal(isOffcut({ pricePaise: 18000, ...kilos(1), ...whole }), false);
  assert.equal(isOffcut({ pricePaise: 17999, ...kilos(1), ...whole }), true);
});

test("a cut priced ₹0 is an offcut, and nothing is an offcut of a whole item that cost nothing", () => {
  assert.equal(isOffcut({ pricePaise: 0, ...kilos(1), ...whole }), true);
  assert.equal(isOffcut({ pricePaise: 0, ...kilos(1), inputValuePaise: 0, inputKgMilli: 10000 }), false);
  assert.equal(isOffcut({ pricePaise: 4000, quantityMilli: 1000, kgMilli: 0, ...whole }), false);
});

test("the price is compared before GST, and per kilo whatever the unit", () => {
  // ₹189 a kilo including 5% GST is ₹180 before it: not cheaper; ₹188 is.
  assert.equal(isOffcut({ pricePaise: 18900, taxRate: 5, inclusive: true, ...kilos(1), ...whole }), false);
  assert.equal(isOffcut({ pricePaise: 18800, taxRate: 5, inclusive: true, ...kilos(1), ...whole }), true);
  // The same price before GST (prices exclusive of GST) is not an offcut.
  assert.equal(isOffcut({ pricePaise: 18800, taxRate: 5, inclusive: false, ...kilos(1), ...whole }), false);
  // Sold by the gram: 300 g at ₹0.15 a gram is ₹150 a kilo.
  assert.equal(isOffcut({ pricePaise: 15, quantityMilli: 300000, kgMilli: 300, ...whole }), true);
  // Repacked in 250 g packs at ₹40 a pack: ₹160 a kilo.
  assert.equal(isOffcut({ pricePaise: 4000, quantityMilli: 4000, kgMilli: 1000, ...whole }), true);
  // ... at ₹50 a pack: ₹200 a kilo.
  assert.equal(isOffcut({ pricePaise: 5000, quantityMilli: 4000, kgMilli: 1000, ...whole }), false);
});
