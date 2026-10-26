const { test } = require("node:test");
const assert = require("node:assert/strict");
const money = require("../src/modules/tax-changes/services/taxChangesMoney");

// The arithmetic of a GST rate change, in whole paise: what a preview shows is
// what the database applies on the change's date (business_tax_change_price).

test("a price that includes GST, keeping its part before GST at a new rate", () => {
  assert.equal(money.keepNet(11800, 18, 5), 10500, "₹118 at 18% is ₹105 at 5%");
  assert.equal(money.keepNet(10500, 5, 18), 11800, "and back");
  assert.equal(money.keepNet(23600, 18, 5), 21000);
  assert.equal(money.keepNet(22420, 18, 5), 19950, "₹224.20 has ₹190 before GST");
  assert.equal(money.keepNet(24000, 18, 5), 21356, "₹213.5593… is ₹213.56, half a paisa up");
  assert.equal(money.keepNet(10000, 5, 5), 10000, "the same rate keeps the price");
  assert.equal(money.keepNet(1, 100, 0), 1, "never down to nothing: half a paisa goes up");
  assert.equal(money.keepNet(10000, 0.25, 3), 10274, "rates in hundredths of a per cent (₹102.7431…)");
});

test("one unit's part before GST, its GST and what the customer pays", () => {
  assert.deepEqual(money.unitFigures(11800, 5, true), { net: 11238, tax: 562, total: 11800 }, "GST inside a price that includes it");
  assert.deepEqual(money.unitFigures(11800, 18, true), { net: 10000, tax: 1800, total: 11800 });
  assert.deepEqual(money.unitFigures(14000, 18, false), { net: 14000, tax: 2520, total: 16520 }, "GST added to a price before it");
  assert.deepEqual(money.unitFigures(5, 18, false), { net: 5, tax: 1, total: 6 }, "0.9 paisa is 1");
  assert.deepEqual(money.unitFigures(10000, 0, true), { net: 10000, tax: 0, total: 10000 });
});

test("a change moves a price only when it keeps the part before GST of a price that includes GST", () => {
  assert.equal(money.priceAfter(11800, 18, 5, { inclusive: true, keeps: "total" }), 11800);
  assert.equal(money.priceAfter(11800, 18, 5, { inclusive: true, keeps: "net" }), 10500);
  assert.equal(money.priceAfter(14000, 18, 5, { inclusive: false, keeps: "net" }), 14000, "a price before GST never moves");
  assert.equal(money.priceAfter(11800, "18.00", 18, { inclusive: true, keeps: "net" }), 11800, "nor one already at the rate");
});

test("a change starts later than the business's own today, within two years", () => {
  assert.match(money.startProblem("2027-04-01", "2027-04-01", "Change it on the item."), /starts on a later day than today \(1 Apr 2027\)\. Change it on the item\./);
  assert.match(money.startProblem("2027-03-31", "2027-04-01"), /later day than today/);
  assert.equal(money.startProblem("2027-04-02", "2027-04-01"), null, "tomorrow is the earliest");
  assert.equal(money.startProblem("2029-04-01", "2027-04-01"), null, "the same day two years on is the latest");
  assert.match(money.startProblem("2029-04-02", "2027-04-01"), /within two years of today, by 1 Apr 2029/);
  assert.match(money.startProblem("2207-04-01", "2027-03-31"), /by 31 Mar 2029/, "a slip of the year");
  assert.equal(money.twoYearsOn("2028-02-29"), "2030-02-28");
});

test("dates in words and on the calendar", () => {
  assert.equal(money.dateWords("2027-04-01"), "1 Apr 2027");
  assert.equal(money.dateWords("2026-09-22T00:00:00.000Z"), "22 Sep 2026");
  assert.equal(money.addDays("2027-03-31", 1), "2027-04-01");
  assert.equal(money.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(money.addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(money.rateWords("18.00"), "18%");
  assert.equal(money.rateWords("0.25"), "0.25%");
  assert.equal(money.rupees(21356), "213.56");
});
