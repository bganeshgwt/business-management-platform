const { test } = require("node:test");
const assert = require("node:assert/strict");

const DATABASE = require.resolve("../src/config/database");
const money = require("../src/modules/business/rentals/services/rentalsMoney");

// A hire's price and late fee are counted in integer paise without the
// database: the cheapest mix of the item's rates that covers the hours
// charged, and every hour (or day) or part of one after the grace time.

const rates = (hour, day, week, month) => ({ hour, day, week, month });

test("the counting loads no database", () => {
  assert.equal(require.cache[DATABASE], undefined);
});

test("a hire is charged by the hour or part of one, never less than the minimum", () => {
  assert.equal(money.chargedHours(0), 1);
  assert.equal(money.chargedHours(60), 1);
  assert.equal(money.chargedHours(61), 2);
  assert.equal(money.chargedHours(150, 4), 4);
  assert.equal(money.chargedHours(51 * 60 - 30), 51);
});

test("the cheapest mix of month, week, day and hour rates covers the hours", () => {
  // 10 days: a week and 3 days (7,000 + 4,500) is less than 10 days or 2 weeks.
  assert.deepEqual(money.bestPrice(rates(30000, 150000, 700000, null), 240), { months: 0, weeks: 1, days: 3, hours: 0, price: 1150000 });
  // 6 days: a week costs less than 6 days.
  assert.deepEqual(money.bestPrice(rates(30000, 150000, 700000, null), 144), { months: 0, weeks: 1, days: 0, hours: 0, price: 700000 });
  // 40 days: a month, a week and 3 days.
  assert.deepEqual(money.bestPrice(rates(45000, 350000, 2100000, 8000000), 960), { months: 1, weeks: 1, days: 3, hours: 0, price: 11150000 });
  // 50 hours: 2 days and 2 hours (7,900) is less than 3 days (10,500).
  assert.deepEqual(money.bestPrice(rates(45000, 350000, 2100000, 8000000), 50), { months: 0, weeks: 0, days: 2, hours: 2, price: 790000 });
  // 4 hours at 300 is less than a day at 1,500; 6 hours at 300 is more.
  assert.equal(money.bestPrice(rates(30000, 150000, null, null), 4).price, 120000);
  assert.deepEqual(money.bestPrice(rates(30000, 150000, null, null), 6), { months: 0, weeks: 0, days: 1, hours: 0, price: 150000 });
  // Only a day rate: an hour still costs a day.
  assert.deepEqual(money.bestPrice(rates(null, 1200, null, null), 3), { months: 0, weeks: 0, days: 1, hours: 0, price: 1200 });
  // A tie goes to the larger block: 24 hours at 50 or a day at 1,200.
  assert.deepEqual(money.bestPrice(rates(5000, 120000, null, null), 24), { months: 0, weeks: 0, days: 1, hours: 0, price: 120000 });
  assert.throws(() => money.bestPrice(rates(null, null, null, null), 5), /at least one rate/);
});

test("the words for a period and for lateness", () => {
  assert.equal(money.periodWords({ months: 1, weeks: 1, days: 3, hours: 0 }), "1 month + 1 week + 3 days");
  assert.equal(money.periodWords({ days: 2, hours: 2 }), "2 days + 2 hours");
  assert.equal(money.periodWords({ hours: 1 }), "1 hour");
  assert.equal(money.lateWords(3, "hour"), "3 hours");
  assert.equal(money.lateWords(1, "day"), "1 day");
});

test("the late fee: nothing within the grace time, then each hour or day or part of one since it was due", () => {
  assert.deepEqual(money.lateFee({ minutes: 30, grace: 30, per: "hour", rate: "400.00", quantity: 1 }), { units: 0, fee: 0 });
  assert.deepEqual(money.lateFee({ minutes: 31, grace: 30, per: "hour", rate: "400.00", quantity: 1 }), { units: 1, fee: 40000 });
  assert.deepEqual(money.lateFee({ minutes: 150, grace: 30, per: "hour", rate: "400.00", quantity: 1 }), { units: 3, fee: 120000 });
  assert.deepEqual(money.lateFee({ minutes: 1441, grace: 60, per: "day", rate: "12.00", quantity: 50 }), { units: 2, fee: 120000 });
  assert.deepEqual(money.lateFee({ minutes: 600, grace: 0, per: "none", rate: null, quantity: 3 }), { units: 0, fee: 0 });
  assert.deepEqual(money.lateFee({ minutes: 600, grace: 0, per: "hour", rate: "100.00", quantity: 0 }), { units: 0, fee: 0 });
});

test("a bill's figures add up to the paisa, rounded as the business rounds", () => {
  const values = [{ net: 150000, tax: 27000 }, { net: 120000, tax: 21600 }, { net: 80000, tax: 14400 }];
  assert.deepEqual(money.billFigures(values, "none"), { subtotal: 350000, tax: 63000, roundOff: 0, total: 413000 });
  assert.deepEqual(money.billFigures([{ net: 1001, tax: 180 }], "nearest_rupee"), { subtotal: 1001, tax: 180, roundOff: 19, total: 1200 });
  // Fixed prices for the bill: the line's value in the business's price terms, for each one.
  const [line] = money.billLines([{ skuId: 7, quantity: 150, net: 360000, tax: 64800, label: "Hire for 2 days · 150 × Plastic chair" }], "exclusive");
  assert.deepEqual([line.input, line.fixed.price, line.fixed.net, line.fixed.tax], [{ skuId: 7, quantity: "150" }, 24, 360000, 64800]);
  const [inclusive] = money.billLines([{ skuId: 7, quantity: 1, net: 100000, tax: 18000, label: "x" }], "inclusive");
  assert.equal(inclusive.fixed.price, 1180);
});

test("late fee slabs: the slab the hours late fall in prices all of them, a flat amount and a multiple of the hourly rate, never more than the cap", () => {
  const slabs = [{ from: 0, flat: 100, times: 2 }, { from: 3, flat: 0, times: 5 }];
  const late = (minutes, extra = {}) => money.lateFee({ minutes, grace: 30, per: "slabs", rate: "60.00", quantity: 1, slabs, ...extra });
  assert.deepEqual(late(30), { units: 0, fee: 0 });
  // 31 minutes: an hour, the first slab: 100 + 2 × 60.
  assert.deepEqual(late(31), { units: 1, fee: 22000 });
  // 3 hours: still the first slab (the second starts beyond 3 hours).
  assert.deepEqual(late(180), { units: 3, fee: 46000 });
  // 3 hours and a minute: 4 hours, the second slab: 5 × 60 × 4 = 1,200.
  assert.deepEqual(late(181), { units: 4, fee: 120000 });
  assert.deepEqual(late(181, { cap: "1000.00" }), { units: 4, fee: 100000 });
  assert.deepEqual(late(181, { cap: "1000.00", quantity: 3 }), { units: 4, fee: 300000 });
  // A multiple of two places, to the paisa: 1.25 × 33.33 × 1 = 41.6625 → 41.66.
  assert.deepEqual(money.lateFee({ minutes: 50, grace: 0, per: "slabs", rate: "33.33", quantity: 1, slabs: [{ from: 0, flat: 0, times: 1.25 }] }), { units: 1, fee: 4166 });
  // A cap holds the hour and day fees too.
  assert.deepEqual(money.lateFee({ minutes: 600, grace: 0, per: "hour", rate: "100.00", quantity: 2, cap: "500.00" }), { units: 10, fee: 100000 });
});

test("kilometres beyond the allowance and fuel short, to the paisa", () => {
  // 180.5 km in a day against 100 free: 81 km (each one or part of one) at 12.
  assert.deepEqual(money.kmFee({ out: "25000.0", back: "25180.5", allowance: 100, per: "day", chargedHours: 24, rate: "12.00" }), { extra: 81, fee: 97200 });
  // Two days and an hour of hire: 3 days' allowance.
  assert.deepEqual(money.kmFee({ out: "0", back: "300", allowance: 100, per: "day", chargedHours: 49, rate: "10.00" }), { extra: 0, fee: 0 });
  assert.deepEqual(money.kmFee({ out: "1000.0", back: "1062.3", allowance: 50, per: "booking", chargedHours: 6, rate: "4.00" }), { extra: 13, fee: 5200 });
  assert.deepEqual(money.kmFee({ out: null, back: "10", allowance: 0, per: "day", chargedHours: 6, rate: "4.00" }), { extra: 0, fee: 0 });
  // Full out, five eighths back: 3 eighths at 300; by the litre of a 5.5-litre tank at 101.25, 5 eighths short is 348.046875 → 348.05.
  assert.deepEqual(money.fuelFee({ out: "full", back: "five_eighths", per: "eighth", rate: "300.00" }), { short: 3, fee: 90000 });
  assert.deepEqual(money.fuelFee({ out: "full", back: "three_eighths", per: "litre", rate: "101.25", tank: "5.5" }), { short: 5, fee: 34805 });
  assert.deepEqual(money.fuelFee({ out: "half", back: "full", per: "eighth", rate: "300.00" }), { short: 0, fee: 0 });
});

test("a percent of a value to the paisa, and the like goods' slab of a vehicle", () => {
  assert.equal(money.percentOf(120000, 25), 30000);
  assert.equal(money.percentOf(33333, 10), 3333);
  assert.equal(money.percentOf(33335, 10), 3334);
  assert.equal(money.vehicleSlab({ vehicle: "car", fuel: "petrol", cc: 1197, length: 3995 }), 18);
  assert.equal(money.vehicleSlab({ vehicle: "car", fuel: "petrol", cc: 1199, length: 4001 }), 40);
  assert.equal(money.vehicleSlab({ vehicle: "car", fuel: "diesel", cc: 1498, length: 3995 }), 18);
  assert.equal(money.vehicleSlab({ vehicle: "car", fuel: "cng", cc: 1300, length: 3900 }), 40);
  assert.equal(money.vehicleSlab({ vehicle: "motorcycle", fuel: "petrol", cc: 350 }), 18);
  assert.equal(money.vehicleSlab({ vehicle: "motorcycle", fuel: "petrol", cc: 411 }), 40);
  assert.equal(money.vehicleSlab({ vehicle: "car", fuel: "electric" }), 5);
  assert.equal(money.vehicleSlab({ vehicle: "car", fuel: "petrol", cc: 1197 }), null, "without its length the slab is not worked out");
});
