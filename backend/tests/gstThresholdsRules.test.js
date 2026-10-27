const { test } = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/modules/gst-thresholds/services/gstThresholdsRules");

// An owner's GST thresholds, pure: a business's PAN from its GSTINs or the one
// its owner recorded, the financial year on a day, the projection to 31 March,
// where a PAN's turnover stands against the platform's figures (a figure
// passed last year applies now, one passed this year so far from the next
// 1 April), and the bell's words. The figures here are the rows the migration
// seeds, passed in.

const FIGURES = [
  { id: 1, code: "e_invoicing", name: "E-invoicing", turnover: "50000000.00", comparison: "above", hsn_digits: null, report_within_days: null, applies_from: null },
  { id: 2, code: "hsn_digits", name: "6-digit HSN / SAC codes on invoices", turnover: "50000000.00", comparison: "above", hsn_digits: 6, report_within_days: null, applies_from: "2021-04-01" },
  { id: 3, code: "irp_reporting_days", name: "The 30-day limit for reporting to the IRP", turnover: "100000000.00", comparison: "at_or_above", hsn_digits: null, report_within_days: 30, applies_from: "2025-04-01" },
];
const crore = (n) => Math.round(n * 1e9);

test("a GSTIN carries its PAN in characters 3 to 12; a mistyped one carries none", () => {
  assert.equal(rules.panOfGstin("36ABCPR1234K1ZO"), "ABCPR1234K");
  assert.equal(rules.panOfGstin(" 36abcpr1234k1zo "), "ABCPR1234K", "spaces and small letters, as people type them");
  assert.equal(rules.panOfGstin("36ABCPR1234K1ZX"), null, "its check character does not match");
  assert.equal(rules.panOfGstin("GSTIN pending"), null);
  assert.equal(rules.panOfGstin(null), null);
});

test("a PAN an owner types, and one shown to someone else", () => {
  assert.equal(rules.readPan(" abcpr 1234k "), "ABCPR1234K");
  assert.equal(rules.readPan(""), null);
  assert.equal(rules.readPan(null), null);
  assert.throws(() => rules.readPan("ABCPR1234"), /PAN must look like ABCDE1234F/);
  assert.throws(() => rules.readPan("12345ABCDE"), /PAN must look like ABCDE1234F/);
  assert.equal(rules.maskPan("ABCPR1234K"), "••••••234K");
  assert.equal(rules.maskPan(null), null);
});

test("a business's PAN comes from its GSTINs, else from its owner, and is never guessed", () => {
  assert.deepEqual(rules.panSource({ gstins: ["36ABCPR1234K1ZO", "29ABCPR1234K1ZJ"], recorded: null }),
    { pan: "ABCPR1234K", source: "gstin", reason: null, pans: ["ABCPR1234K"] }, "a branch in another state, the same PAN");
  assert.equal(rules.panSource({ gstins: ["36ABCPR1234K1ZO"], recorded: "AAKFS5678M" }).pan, "ABCPR1234K", "the GSTIN wins over a recorded PAN");
  assert.deepEqual(rules.panSource({ gstins: ["36ABCPR1234K1ZO", "36AAKFS5678M1ZA"] }),
    { pan: null, source: null, reason: "gstins_differ", pans: ["AAKFS5678M", "ABCPR1234K"] }, "two PANs: not linked");
  assert.deepEqual(rules.panSource({ gstins: [], recorded: "AAKFS5678M" }), { pan: "AAKFS5678M", source: "recorded", reason: null, pans: [] });
  assert.deepEqual(rules.panSource({ gstins: ["", null], recorded: null }), { pan: null, source: null, reason: "no_gstin", pans: [] });
  assert.deepEqual(rules.panSource({ gstins: ["36ABCPR1234K1ZX"], recorded: null }), { pan: null, source: null, reason: "gstin_invalid", pans: [] });
  assert.equal(rules.panSource({ gstins: ["36ABCPR1234K1ZX"], recorded: "ABCPR1234K" }).source, "recorded", "a mistyped GSTIN is no GSTIN");
});

test("the financial year runs April to March", () => {
  assert.deepEqual(rules.financialYear("2026-10-27"), { label: "2026-27", from: "2026-04-01", to: "2027-03-31" });
  assert.deepEqual(rules.financialYear("2027-03-31"), { label: "2026-27", from: "2026-04-01", to: "2027-03-31" }, "31 March is the year's last day");
  assert.deepEqual(rules.financialYear("2027-04-01"), { label: "2027-28", from: "2027-04-01", to: "2028-03-31" }, "1 April starts the next");
  assert.deepEqual(rules.financialYear("2099-12-31").label, "2099-00");
  assert.deepEqual(rules.yearBefore(rules.financialYear("2026-10-27")), { label: "2025-26", from: "2025-04-01", to: "2026-03-31" });
  assert.equal(rules.yearAfterFrom(rules.financialYear("2026-10-27")), "2027-04-01", "the next year starts on 1 April");
  assert.equal(rules.longDay("2027-04-01"), "1 April 2027");
  assert.equal(rules.longDay("2026-12-25"), "25 December 2026");
});

test("the projection to 31 March is the pace so far, from 1 April or the day the business started", () => {
  const year = rules.financialYear("2026-10-01");
  // 1 April to 30 September is 183 days; the year has 365.
  assert.equal(rules.projection(crore(1.83), { year, today: "2026-09-30" }), crore(3.65));
  assert.equal(rules.projection(crore(1), { year, today: "2027-03-31" }), crore(1), "on 31 March the year is what it is");
  // Started on 1 October: 10 days at ₹10 lakh a day, 182 days to 31 March.
  assert.equal(rules.projection(crore(1), { year, today: "2026-10-10", startedOn: "2026-10-01" }), crore(18.2));
  assert.equal(rules.projection(crore(1), { year, today: "2026-10-10", startedOn: "2020-01-01" }), Math.round(crore(1) * 365 / 193), "an older business counts from 1 April");
  assert.equal(rules.projection(0, { year, today: "2026-10-10" }), 0, "nothing sold projects nothing");
  assert.equal(rules.projection(-500, { year, today: "2026-10-10" }), -500, "returns above sales are not projected");
  assert.equal(rules.projection(1, { year, today: "2026-04-01" }), 365, "to the paisa, half up");
});

test("money from the database's decimals, and in the words people use", () => {
  assert.equal(rules.toPaise("50000000.00"), 5000000000);
  assert.equal(rules.toPaise("-118.5"), -11850);
  assert.equal(rules.toPaise("0"), 0);
  assert.equal(rules.rupees(5000000000), "50000000.00");
  assert.equal(rules.rupees(-11850), "-118.50");
  assert.equal(rules.bigMoney(crore(5)), "₹5 crore");
  assert.equal(rules.bigMoney(crore(4.25)), "₹4.25 crore");
  assert.equal(rules.bigMoney(crore(10)), "₹10 crore");
  assert.equal(rules.bigMoney(825000000), "₹82.5 lakh");
  assert.equal(rules.bigMoney(82500000), "₹8.25 lakh");
  assert.equal(rules.bigMoney(4500000), "₹45,000");
});

test("the figures in force on a day, grouped by the turnover they are measured against", () => {
  const steps = rules.stepsOn(FIGURES, "2026-10-27");
  assert.deepEqual(steps.map((s) => [s.figure, s.comparison, s.rules.map((r) => r.code)]), [
    [crore(5), "above", ["e_invoicing", "hsn_digits"]],
    [crore(10), "at_or_above", ["irp_reporting_days"]],
  ]);
  assert.deepEqual(rules.stepsOn(FIGURES, "2025-03-31").map((s) => s.rules.map((r) => r.code)), [["e_invoicing", "hsn_digits"]], "the 30 days only from 1 April 2025");
  // A later figure for the same code takes over on its date.
  const later = [...FIGURES, { ...FIGURES[0], id: 4, turnover: "20000000.00", applies_from: "2027-04-01" }];
  assert.deepEqual(rules.stepsOn(later, "2027-03-31")[0].figure, crore(5));
  assert.deepEqual(rules.stepsOn(later, "2027-04-01").map((s) => [s.figure, s.rules.map((r) => r.code)]),
    [[crore(2), ["e_invoicing"]], [crore(5), ["hsn_digits"]], [crore(10), ["irp_reporting_days"]]]);
});

test("a figure passed last year applies now, one passed this year so far from the next 1 April; near from the warning level", () => {
  const steps = rules.stepsOn(FIGURES, "2026-10-27");
  const year = rules.financialYear("2026-10-27");
  const at = (thisYear, lastYear = 0, warnPercent = 80, projected = thisYear) => rules.standing(steps, { thisYear, lastYear, projected, warnPercent, year });
  assert.deepEqual(at(crore(3.99)).map((s) => s.state), ["below", "below"]);
  const near = at(crore(4));
  assert.deepEqual(near.map((s) => [s.state, s.by, s.appliesFrom]), [["near", null, null], ["below", null, null]], "80% of ₹5 crore is ₹4 crore");
  assert.equal(near[0].warnAt, crore(4));
  assert.equal(near[0].share, 80);
  assert.deepEqual(at(crore(4), 0, 90).map((s) => s.state), ["below", "below"], "the owner's own level");
  assert.deepEqual(at(crore(5)).map((s) => s.state), ["near", "below"], "₹5 crore is not above ₹5 crore");
  // Passed this year so far: its rules apply from 1 April 2027.
  const passed = at(crore(5) + 1);
  assert.deepEqual(passed.map((s) => [s.state, s.by, s.appliesFrom]), [["crossed", "this_year", "2027-04-01"], ["below", null, null]]);
  assert.deepEqual(at(crore(8)).map((s) => s.state), ["crossed", "near"]);
  assert.deepEqual(at(crore(10)).map((s) => [s.state, s.by]), [["crossed", "this_year"], ["crossed", "this_year"]], "₹10 crore or more");
  // Passed last year: its rules apply now, this year so far whatever it is.
  const before = at(crore(1), crore(6));
  assert.deepEqual(before.map((s) => [s.state, s.by, s.appliesFrom]), [["crossed", "last_year", null], ["below", null, null]]);
  assert.deepEqual(at(crore(6), crore(6)).map((s) => [s.by, s.appliesFrom]), [["last_year", null], [null, null]], "passed both years: it applies now");
  assert.equal(at(crore(2), 0, 80, crore(5.5))[0].onPace, true, "on pace to pass it by 31 March");
  assert.equal(at(crore(2), 0, 80, crore(4))[0].onPace, false);
  assert.equal(before[0].onPace, false, "past it already");
  // Applying now is more serious than from 1 April, which is more than nearing.
  assert.deepEqual([near[0], passed[0], before[0], at(0)[0]].map(rules.level), [1, 2, 3, 0]);
  assert.equal(rules.moreSerious(near[0], passed[0]), passed[0]);
  assert.equal(rules.moreSerious(passed[0], near[0]), passed[0]);
  assert.equal(rules.moreSerious(passed[0], before[0]), before[0]);
  // The rule of a code: now, or from the day it comes.
  const hsnNext = rules.applying(passed, "hsn_digits");
  assert.deepEqual([hsnNext.rule.hsn_digits, hsnNext.now, hsnNext.from], [6, false, "2027-04-01"]);
  const hsnNow = rules.applying(before, "hsn_digits");
  assert.deepEqual([hsnNow.rule.code, hsnNow.now, hsnNow.from], ["hsn_digits", true, null]);
  assert.equal(rules.applying(near, "hsn_digits"), null);
  assert.equal(rules.applying(passed, "irp_reporting_days"), null);
});

test("a step in one sentence, with its years, and the bell's lines with or without the sums", () => {
  const steps = rules.stepsOn(FIGURES, "2026-10-27");
  const year = rules.financialYear("2026-10-27");
  const lastYear = rules.yearBefore(year);
  const years = { year, lastYear };
  const stand = rules.standing(steps, { thisYear: crore(8.2), lastYear: crore(3), projected: crore(14), warnPercent: 80, year });
  assert.equal(rules.stepWords(stand[0], years),
    "Turnover has passed ₹5 crore in 2026-27 so far: from 1 April 2027, e-invoicing and 6-digit HSN / SAC codes on invoices apply");
  assert.equal(rules.stepWords(stand[1], years),
    "Turnover is nearing ₹10 crore in 2026-27: at ₹10 crore, the 30-day limit for reporting to the IRP applies from 1 April 2027");
  const before = rules.standing(steps, { thisYear: crore(4.5), lastYear: crore(10), projected: crore(9), warnPercent: 80, year });
  assert.deepEqual(before.map((s) => rules.stepWords(s, years)), [
    "Turnover passed ₹5 crore in 2025-26: e-invoicing and 6-digit HSN / SAC codes on invoices apply",
    "Turnover reached ₹10 crore in 2025-26: the 30-day limit for reporting to the IRP applies",
  ]);
  const nearing = rules.standing(steps, { thisYear: crore(4.5), lastYear: 0, projected: crore(9), warnPercent: 80, year });
  assert.equal(rules.stepWords(nearing[0], years),
    "Turnover is nearing ₹5 crore in 2026-27: above ₹5 crore, e-invoicing and 6-digit HSN / SAC codes on invoices apply from 1 April 2027");
  assert.equal(rules.stepWords(nearing[1], years), "Turnover is below ₹10 crore");
  assert.equal(rules.stepWords(rules.standing(steps, { thisYear: crore(10), lastYear: 0, projected: crore(10), warnPercent: 80, year })[1], years),
    "Turnover has reached ₹10 crore in 2026-27 so far: from 1 April 2027, the 30-day limit for reporting to the IRP applies");

  const lines = rules.alerts({ steps: stand, year, lastYear, pan: "ABCPR1234K", figures: { thisYear: crore(8.2), lastYear: crore(3), businesses: 3 },
    link: (step) => (step.figure === crore(5) ? "/catalogue" : "/owner"), prefix: "gst-threshold", today: "2026-10-27" });
  assert.deepEqual(lines.map((l) => [l.id, l.severity, l.link]), [
    ["gst-threshold:2026-27:50000000:crossed:this_year", "critical", "/catalogue"],
    ["gst-threshold:2026-27:100000000:near", "warning", "/owner"],
  ], "passed this year so far is critical too: the moment to prepare");
  assert.equal(lines[0].title, rules.stepWords(stand[0], years));
  assert.equal(lines[0].detail, "PAN ABCPR1234K · ₹8.2 crore in 2026-27 so far, 164% of ₹5 crore, across 3 businesses");
  assert.equal(lines[1].at, "2026-10-27T00:00:00.000Z");
  const masked = rules.alerts({ steps: stand, year, lastYear, pan: rules.maskPan("ABCPR1234K"), figures: null, link: "/x", prefix: "gstThresholds", today: "2026-10-27" });
  assert.equal(masked[0].detail, "PAN ••••••234K · the businesses under this PAN together, in 2026-27 so far");
  assert.ok(masked.every((l) => !/crore across|%/.test(l.detail)), "no sums without the right to see them");
  const lastYearOnly = rules.alerts({ steps: rules.standing(steps, { thisYear: 0, lastYear: crore(6), projected: 0, warnPercent: 80, year }), year, lastYear,
    pan: "ABCPR1234K", figures: { thisYear: 0, lastYear: crore(6), businesses: 1 }, link: "/x", prefix: "p", today: "2026-10-27" });
  assert.deepEqual(lastYearOnly.map((l) => [l.id, l.severity, l.title, l.detail]), [["p:2026-27:50000000:crossed:last_year", "critical",
    "Turnover passed ₹5 crore in 2025-26: e-invoicing and 6-digit HSN / SAC codes on invoices apply", "PAN ABCPR1234K · ₹6 crore in 2025-26, across 1 business"]]);
});
