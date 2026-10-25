const { test } = require("node:test");
const assert = require("node:assert/strict");

const DATABASE = require.resolve("../src/config/database");
const money = require("../src/modules/business/fuel/services/fuelMoney");

// A fuel station's counting in integer millilitres and paise, without the
// database: litres sold from the totalisers less the test pumped back, the
// shift's money at the prices in force (each credit slip, and the walk-in
// litres), the attendant's short or excess, the stock register's variation
// against the MDG tolerance, and a tanker load's density check.

const SETTINGS = { variation_percent: "4.00", petrol_loss_percent: "0.75", petrol_loss_above_percent: "0.60", diesel_loss_percent: "0.25",
  diesel_loss_above_percent: "0.20", above_600_kl: false };

test("the counting loads no database", () => {
  assert.equal(require.cache[DATABASE], undefined);
});

test("decimals are read and written exactly", () => {
  assert.equal(money.milli("100000.123"), 100000123);
  assert.equal(money.milli("1.005"), 1005);
  assert.equal(money.milli("99999999999.999"), 99999999999999);
  assert.equal(money.paise("102.12"), 10212);
  assert.equal(money.paise("0.5"), 50);
  assert.equal(money.litres(-50), "-0.050");
  assert.equal(money.litres(0), "0.000");
  assert.equal(money.rupees(12345678901), "123456789.01");
  assert.equal(money.rounded(-5, 10), -1);
  assert.equal(money.rounded(-4, 10), 0);
  assert.equal(Object.is(money.rounded(-4, 10), -0), false, "never a negative zero");
});

test("litres at the price, to the paisa, halves up", () => {
  // 495.500 litres of petrol at ₹102.12 is ₹50,600.46; 0.004 litres is ₹0.41, and 0.004 at ₹1.00 nothing.
  assert.equal(money.amountOf(495500, 10212), 5060046);
  assert.equal(money.amountOf(4, 10212), 41);
  assert.equal(money.amountOf(4, 100), 0);
  // 1.005 litres at ₹1.00 is ₹1.005, which is ₹1.01 (half up).
  assert.equal(money.amountOf(1005, 100), 101);
  assert.equal(money.amountOf(200000, 9520), 1904000);
});

test("a nozzle sells what its totaliser moved, less the test pumped back", () => {
  assert.deepEqual(money.nozzleFigures({ opening: "100000.000", closing: "100500.500", test: "5.000" }), { gross: 500500, test: 5000, litres: 495500 });
  assert.deepEqual(money.nozzleFigures({ opening: "250000.500", closing: "250000.500" }), { gross: 0, test: 0, litres: 0 });
});

test("a shift's money: each credit slip and the walk-in litres at the price in force, and the attendant's short or excess", () => {
  // Petrol 495.500 litres at ₹102.12; diesel 795.000 litres at ₹95.20, of
  // which two fleet fills on credit (200.000 and 100.500 litres).
  const readings = [
    { nozzleId: 1, productId: 1, opening: "100000.000", closing: "100500.500", test: "5.000" },
    { nozzleId: 2, productId: 2, opening: "250000.000", closing: "250800.000", test: "5.000" },
  ];
  const prices = { 1: "102.12", 2: "95.20" };
  const slips = [{ productId: 2, litres: "200.000" }, { productId: 2, litres: "100.500" }];
  const payments = [{ amount: "30000" }, { amount: "20000" }, { amount: "10000" }];
  const f = money.shiftFigures({ readings, prices, slips, cash: "37670", payments });
  assert.deepEqual(f.products.map((p) => [p.productId, p.litres, p.creditLitres, p.walkInLitres, p.creditAmount, p.walkInAmount, p.amount]), [
    ["1", 495500, 0, 495500, 0, 5060046, 5060046],
    ["2", 795000, 300500, 494500, 2860760, 4707640, 7568400],
  ]);
  assert.deepEqual(f.slips.map((s) => [s.price, s.amount]), [[9520, 1904000], [9520, 956760]]);
  // Expected ₹1,26,284.46: credit ₹28,607.60 and walk-in ₹97,676.86.
  assert.deepEqual([f.expected, f.credit, f.walkIn, f.other, f.cash], [12628446, 2860760, 9767686, 6000000, 3767000]);
  assert.equal(f.expected, f.products.reduce((s, p) => s + p.amount, 0), "the shift is its fuels, to the paisa");
  // The walk-in bill is paid the ₹60,000 handed in, then ₹37,670.00 of cash; ₹6.86 short.
  assert.deepEqual([f.cashPaid, f.difference], [3767000, -686]);
  // An excess: ₹37,683.00 counted pays ₹37,676.86 on the bill and ₹6.14 is over.
  const over = money.shiftFigures({ readings, prices, slips, cash: "37683", payments });
  assert.deepEqual([over.cashPaid, over.difference], [3767686, 614]);
  // Credit slips over what the meters sold leave walk-in litres below zero, for the service to refuse.
  const tooMuch = money.shiftFigures({ readings, prices, slips: [{ productId: 1, litres: "600" }] });
  assert.equal(tooMuch.products[0].walkInLitres, -104500);
  assert.equal(tooMuch.products[0].walkInAmount, 0);
});

test("the stock register: book stock, the variation and its percentage, against the operational variation and the evaporation allowance", () => {
  // Petrol: 9,000 litres at the morning dip, 500 sold, 8,100 by the next dip:
  // book 8,500, 400 short (-4.94%); allowed 324 (4% of 8,100) and 3.75 on the sales.
  assert.deepEqual(money.registerFigures({ opening: 9000000, receipts: 0, sales: 500000, closing: 8100000, family: "petrol", settings: SETTINGS }),
    { book: 8500000, variation: -400000, percent: -494, allowedGain: 324000, allowedLoss: 327750, flag: "loss" });
  // Diesel with a load of 4,000 litres: 50 litres short of 15,200 is within.
  const within = money.registerFigures({ opening: 12000000, receipts: 4000000, sales: 800000, closing: 15150000, family: "diesel", settings: SETTINGS });
  assert.deepEqual([within.book, within.variation, within.percent, within.flag], [15200000, -50000, -33, "within"]);
  // More in the tank than the book says, beyond 4% of it: a gain.
  assert.equal(money.registerFigures({ opening: 1000000, receipts: 0, sales: 0, closing: 1100000, family: "diesel", settings: SETTINGS }).flag, "gain");
  // The allowance beyond an annual average of 600 KL is lower.
  assert.equal(money.lossAllowance("petrol", { ...SETTINGS, above_600_kl: true }), 60);
  assert.equal(money.lossAllowance("diesel", SETTINGS), 25);
  assert.equal(money.lossAllowance("cng", SETTINGS), 0);
  // A loss just inside: 324 + 3.75 = 327.75 litres allowed.
  assert.equal(money.registerFigures({ opening: 9000000, receipts: 0, sales: 500000, closing: 8172250, family: "petrol", settings: SETTINGS }).flag, "within");
  // The day still open: book stock so far, no variation yet.
  assert.deepEqual(money.registerFigures({ opening: 9000000, receipts: 1000, sales: 2000, closing: null, family: "petrol", settings: SETTINGS }),
    { book: 8999000, variation: null, percent: null, allowedGain: null, allowedLoss: null, flag: "open" });
  // An empty tank by dip has no percentage.
  assert.equal(money.registerFigures({ opening: 100000, receipts: 0, sales: 100000, closing: 0, family: "petrol", settings: SETTINGS }).percent, null);
});

test("a tanker load: density within 3.0 kg/m³ of its invoice either way, and what came in by dip", () => {
  assert.deepEqual(money.densityCheck({ invoice: "745.0", receipt: "747.5", tolerance: "3.0" }), { difference: 25, within: true });
  assert.deepEqual(money.densityCheck({ invoice: "745.0", receipt: "742.0", tolerance: "3.0" }), { difference: -30, within: true });
  assert.deepEqual(money.densityCheck({ invoice: "745.0", receipt: "751.5", tolerance: "3.0" }), { difference: 65, within: false });
  assert.deepEqual(money.receiptFigures({ invoiceLitres: "12000", dipBefore: "3200.000", dipAfter: "15150.000" }), { received: 11950000, short: 50000 });
  assert.deepEqual(money.receiptFigures({ invoiceLitres: "12000", dipBefore: null, dipAfter: null }), { received: null, short: null });
});
