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

// 29 Oct 2026 is a Thursday: its night is a weekday; 30 and 31 Oct are weekend nights.
const type = { rack: 450000, weekend: 520000, extraAdult: 100000, child: 50000, extraBed: 80000 };

test("each night's rates come from the calendar, the most particular first", () => {
  const plan = { id: 7, room: 400000, weekend: null, mealSkuId: 12, mealAdult: 90000, mealChild: 40000 };
  const seasons = [{ planId: null, startsOn: "2026-10-30", endsOn: "2026-11-05", weekday: 600000, weekend: 780000, extraAdult: null, child: null, extraBed: null, minStay: 2 }];
  const days = [{ planId: null, day: "2026-10-31", room: 700000, minStay: null, closedToArrival: true, stopSell: false },
    { planId: 7, day: "2026-11-01", room: 390000, minStay: null, closedToArrival: false, stopSell: true }];
  // The room type alone: Thursday at the rack rate, Friday at the season's weekend rate, Saturday at the date's own, Sunday the season's weekday rate.
  const plain = money.resolveNights("2026-10-29", "2026-11-02", { type, seasons, days, weekendNights: [5, 6] });
  assert.deepEqual(plain.map((n) => [n.rateKind, n.roomRate]), [["rack", 450000], ["season", 780000], ["override", 700000], ["season", 600000]]);
  // With the plan: its own room rate outside the season, its own date on Sunday (and the stop-sell with it); the meals kept apart.
  const planned = money.resolveNights("2026-10-29", "2026-11-02", { type, plan, seasons, days, weekendNights: [5, 6] });
  assert.deepEqual(planned.map((n) => [n.rateKind, n.roomRate, n.mealAdult, n.stopSell]), [["rack", 400000, 90000, false], ["season", 780000, 90000, false],
    ["override", 700000, 90000, false], ["override", 390000, 90000, true]]);
  // One rate agreed for every night wins; the extra persons' rates stay the room type's.
  assert.deepEqual(money.resolveNights("2026-10-29", "2026-10-31", { type, seasons, days, weekendNights: [5, 6], agreed: 500000 }).map((n) => [n.rateKind, n.roomRate, n.extraAdult]),
    [["agreed", 500000, 100000], ["agreed", 500000, 100000]]);
  // The calendar's refusals: a stop-sell night, an arrival on a day closed to arrival, fewer nights than the minimum stay.
  assert.deepEqual(money.restriction(planned, { arrival: "2026-10-29", nights: 4 }), { reason: "stop_sell", night: "2026-11-01" });
  const fromSat = money.resolveNights("2026-10-31", "2026-11-01", { type, seasons, days, weekendNights: [5, 6] });
  assert.equal(money.restriction(fromSat, { arrival: "2026-10-31", nights: 1 }).reason, "closed_to_arrival");
  const fromFri = money.resolveNights("2026-10-30", "2026-10-31", { type, seasons, days, weekendNights: [5, 6] });
  assert.deepEqual(money.restriction(fromFri, { arrival: "2026-10-30", nights: 1 }), { reason: "min_stay", night: "2026-10-30", minStay: 2 });
  // An extension checks only stop-sell, on the nights it adds.
  assert.equal(money.restriction(planned, { arrival: "2026-10-29", nights: 4, only: ["2026-10-31"] }), null);
});

test("a discount comes off the room's value, and the value after it decides the slab; the meals are their own", () => {
  const row = { night: "2026-10-30", rateKind: "weekend", roomRate: 850000, extraAdult: 150000, child: null, extraBed: null, mealSkuId: 12, mealAdult: 90000, mealChild: 40000 };
  const full = money.priceRow(row, { adults: 2, children: 1, extraBeds: 0, baseOccupancy: 2 }, settings, null, 5);
  assert.deepEqual([full.value, full.discount, full.amount, full.slab.rate, full.tax, full.meal, full.mealTax], [850000, 0, 850000, 18, 153000, 220000, 11000]);
  const less = money.priceRow(row, { adults: 2, children: 1, extraBeds: 0, baseOccupancy: 2 }, settings, 15, 5);
  assert.deepEqual([less.discount, less.amount, less.slab.rate, less.tax], [127500, 722500, 5, 36125]);
  // A day use is its block's price, at the slab its value would take for a night.
  const day = money.priceRow({ night: "2026-10-30", rateKind: "day_use", roomRate: 150000, extraAdult: null, child: null, extraBed: null, mealSkuId: null },
    { adults: 3, children: 0, extraBeds: 0, baseOccupancy: 2 }, settings);
  assert.deepEqual([day.extraAdults, day.amount, day.slab.rate, day.tax], [0, 150000, 5, 7500]);
  const stay = money.estimateRows([row, { ...row, night: "2026-10-31" }], { adults: 2, children: 0, extraBeds: 0, baseOccupancy: 2 }, settings, 10, 5);
  assert.deepEqual([stay.roomSubtotal, stay.subtotal, stay.tax], [1530000, 1530000 + 360000, 2 * 137700 + 2 * 9000], "7,650 a night after 10% off: still above 7,500, 18%");
});

test("a policy's charges are worked out from the room nights' values", () => {
  const values = [400000, 520000, 520000];
  const policy = { refundable: true, cancelFreeHours: 48, cancelKind: "nights", cancelValue: 1, noShowKind: "first_night", earlyKind: "percent", earlyValue: 50,
    lateKind: "flat", lateValue: 1000, depositKind: "percent", depositValue: 30 };
  assert.deepEqual(money.cancelCharge(policy, values, 72), { amount: 0, rule: "free" });
  assert.deepEqual(money.cancelCharge(policy, values, 12), { amount: 400000, rule: "nights" });
  assert.deepEqual(money.cancelCharge({ ...policy, cancelKind: "percent", cancelValue: 25 }, values, 12), { amount: 360000, rule: "percent" });
  assert.deepEqual(money.cancelCharge({ ...policy, refundable: false }, values, 500), { amount: 1440000, rule: "not_refundable" });
  assert.deepEqual(money.noShowCharge(policy, values), { amount: 400000, rule: "first_night" });
  assert.deepEqual(money.noShowCharge({ ...policy, noShowKind: "full_stay" }, values), { amount: 1440000, rule: "full_stay" });
  assert.deepEqual(money.noShowCharge(null, values), { amount: 0, rule: null });
  assert.equal(money.timeCharge("percent", 50, 400000), 200000);
  assert.equal(money.timeCharge("flat", 1000, 400000), 100000);
  assert.equal(money.timeCharge("night", null, 400000), 400000);
  assert.equal(money.depositDue(policy, { total: 1512000, firstNight: 420000 }), 453600);
  assert.equal(money.depositDue({ depositKind: "first_night" }, { total: 1512000, firstNight: 420000 }), 420000);
});

test("the house's figures: occupancy over the rooms available, ADR over the nights sold, RevPAR over the rooms available", () => {
  // Six rooms available (one out of order is not), three nights sold for 11,500 before GST.
  assert.deepEqual(money.ratios({ sold: 3, available: 6, revenue: 1150000 }), { occupancy: 50, adr: 383333, revpar: 191667 });
  assert.deepEqual(money.ratios({ sold: 1, available: 3, revenue: 400000 }), { occupancy: 33.3, adr: 400000, revpar: 133333 });
  assert.deepEqual(money.ratios({ sold: 2, available: 3, revenue: 750000 }), { occupancy: 66.7, adr: 375000, revpar: 250000 });
  // Nothing sold, or nothing available: no rate to divide by.
  assert.deepEqual(money.ratios({ sold: 0, available: 1, revenue: 0 }), { occupancy: 0, adr: null, revpar: 0 });
  assert.deepEqual(money.ratios({ sold: 0, available: 0, revenue: 0 }), { occupancy: null, adr: null, revpar: null });
});
