const { test } = require("node:test");
const assert = require("node:assert/strict");

const DATABASE = require.resolve("../src/config/database");
const money = require("../src/modules/business/lodging/services/lodgingMoney");

// A stay's room nights are counted in integer paise without the database:
// each night at its own rate (agreed, weekend or rack) with the extra adults,
// children and extra beds, and each night's GST slab decided by that night's
// value (₹7,500 or less a room a night: the lower slab; above it the higher).

const slabs = { limit: 750000, low: { id: 1, rate: 5, name: "GST 5%" }, high: { id: 2, rate: 18, name: "GST 18%" } };
const settings = { weekendNights: [5, 6], slabs };
const rates = (extra = {}) => ({ rack: 450000, weekend: 520000, extraAdult: 100000, child: 50000, extraBed: 80000, agreed: null, baseOccupancy: 2, ...extra });
const party = (adults = 2, children = 0, extraBeds = 0) => ({ adults, children, extraBeds });

test("the counting loads no database", () => {
  assert.equal(require.cache[DATABASE], undefined);
});

test("a stay's nights run from the arrival to the night before the departure", () => {
  assert.deepEqual(money.nightsOf("2026-10-29", "2026-11-01"), ["2026-10-29", "2026-10-30", "2026-10-31"]);
  assert.equal(money.nightCount("2026-10-29", "2026-11-01"), 3);
  // Across the end of a month and a year.
  assert.deepEqual(money.nightsOf("2026-12-31", "2027-01-02"), ["2026-12-31", "2027-01-01"]);
  // 26 Oct 2026 is a Monday, 1 Nov a Sunday.
  assert.equal(money.isoDay("2026-10-26"), 1);
  assert.equal(money.isoDay("2026-11-01"), 7);
});

test("a night is at the weekend rate on the property's weekend nights, and an agreed rate replaces both", () => {
  // Thursday at the rack rate, Friday and Saturday nights at the weekend rate.
  assert.deepEqual(["2026-10-29", "2026-10-30", "2026-10-31"].map((n) => money.nightValue(n, rates(), party(), [5, 6]).rateKind), ["rack", "weekend", "weekend"]);
  assert.equal(money.nightValue("2026-10-30", rates(), party(), [5, 6]).amount, 520000);
  // A property whose weekend is Saturday and Sunday nights.
  assert.equal(money.nightValue("2026-10-30", rates(), party(), [6, 7]).rateKind, "rack");
  assert.equal(money.nightValue("2026-11-01", rates(), party(), [6, 7]).rateKind, "weekend");
  // No weekend rate: the rack rate every night.
  assert.equal(money.nightValue("2026-10-30", rates({ weekend: null }), party(), [5, 6]).rateKind, "rack");
  // An agreed rate (an OTA's price, a company's rate) is every night's.
  const agreed = money.nightValue("2026-10-31", rates({ agreed: 399900 }), party(), [5, 6]);
  assert.deepEqual([agreed.rateKind, agreed.roomRate, agreed.amount], ["agreed", 399900, 399900]);
});

test("a night's value adds each adult beyond the base, each child and each extra bed", () => {
  // 3 adults (1 extra), 2 children and an extra bed on a Thursday: 4,500 + 1,000 + 2 × 500 + 800 = 7,300.00.
  const night = money.nightValue("2026-10-29", rates(), party(3, 2, 1), [5, 6]);
  assert.deepEqual([night.extraAdults, night.children, night.extraBeds, night.amount], [1, 2, 1, 730000]);
  // Children free when the plan has no child rate.
  assert.equal(money.nightValue("2026-10-29", rates({ child: null }), party(2, 2), [5, 6]).amount, 450000);
});

test("each night's slab is decided by that night's own value: 7,500 or less the lower slab, above it the higher", () => {
  // Exactly 7,500.00 a night is the lower slab; 7,500.01 the higher.
  const at = money.priceNight("2026-10-29", rates({ rack: 750000 }), party(), settings);
  assert.deepEqual([at.slab.rate, at.net, at.tax], [5, 750000, 37500]);
  const over = money.priceNight("2026-10-29", rates({ rack: 750001 }), party(), settings);
  assert.deepEqual([over.slab.rate, over.net, over.tax], [18, 750001, 135000]);
  // An extra adult takes a 7,000 night over the limit: 8,000 at 18%.
  const extra = money.priceNight("2026-10-29", rates({ rack: 700000 }), party(3), settings);
  assert.deepEqual([extra.amount, extra.slab.rate, extra.tax], [800000, 18, 144000]);
});

test("a stay crossing the limit at the weekend is billed night by night at mixed slabs, to the paisa", () => {
  // Thursday 7,000 (5%), Friday and Saturday 8,000.50 (18%), Sunday 7,000 (5%).
  const est = money.estimate("2026-10-29", "2026-11-02", rates({ rack: 700000, weekend: 800050 }), party(), settings);
  assert.deepEqual(est.nights.map((n) => [n.night, n.rateKind, n.slab.rate, n.net, n.tax]), [
    ["2026-10-29", "rack", 5, 700000, 35000],
    ["2026-10-30", "weekend", 18, 800050, 144009],
    ["2026-10-31", "weekend", 18, 800050, 144009],
    ["2026-11-01", "rack", 5, 700000, 35000],
  ]);
  assert.deepEqual([est.subtotal, est.tax, est.total], [3000100, 358018, 3358118]);
  // GST halves go up: 18% of 333.35 is 60.003 → 60.00; 5% of 1,234.50 is 61.725 → 61.73.
  assert.equal(money.taxOn(33335, 18), 6000);
  assert.equal(money.taxOn(123450, 5), 6173);
});

test("an extra is priced in the business's terms, with GST put on or taken out", () => {
  // Laundry: 3 shirts at 40.00, 18% on top: 120.00 + 21.60.
  assert.deepEqual(money.extraFigures({ price: 4000, quantity: "3", taxRate: 18, taxMode: "exclusive" }), { amount: 12000, net: 12000, tax: 2160 });
  // 236.00 including 18%: 200.00 and 36.00.
  assert.deepEqual(money.extraFigures({ price: 23600, quantity: "1", taxRate: 18, taxMode: "inclusive" }), { amount: 23600, net: 20000, tax: 3600 });
  // 1.5 hours at 333.33: 499.995 → 500.00 (halves up), 5% → 25.00.
  assert.deepEqual(money.extraFigures({ price: 33333, quantity: "1.5", taxRate: 5, taxMode: "exclusive" }), { amount: 50000, net: 50000, tax: 2500 });
});

test("the bill adds its lines up, rounds as the business rounds, and gives each line its own rate", () => {
  const values = [
    { skuId: 7, quantity: 1, net: 800050, tax: 144009, taxRate: 18, label: "Deluxe · room 101 · night of 30 Oct 2026" },
    { skuId: 7, quantity: 1, net: 700000, tax: 35000, taxRate: 5, label: "Deluxe · room 101 · night of 1 Nov 2026" },
    { skuId: 9, quantity: 3, net: 12000, tax: 2160, taxRate: 18, label: "Laundry" },
  ];
  assert.deepEqual(money.billFigures(values, "none"), { subtotal: 1512050, tax: 181169, roundOff: 0, total: 1693219 });
  assert.deepEqual(money.billFigures(values, "nearest_rupee"), { subtotal: 1512050, tax: 181169, roundOff: -19, total: 1693200 });
  const lines = money.billLines(values, "exclusive");
  assert.deepEqual(lines.map((l) => [l.fixed.price, l.fixed.net, l.fixed.tax, l.fixed.taxRate]), [[8000.5, 800050, 144009, "18.00"], [7000, 700000, 35000, "5.00"], [40, 12000, 2160, "18.00"]]);
  assert.deepEqual(lines[2].input, { skuId: 9, quantity: "3" });
  // Prices including GST: a line's price is its value with the GST in it.
  assert.equal(money.billLines([values[1]], "inclusive")[0].fixed.price, 7350);
});
