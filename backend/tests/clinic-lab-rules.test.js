const { test } = require("node:test");
const assert = require("node:assert/strict");

const DATABASE = require.resolve("../src/config/database");
const ENV = require.resolve("../src/config/env");
const rules = require("../src/modules/business/health/services/clinicDrugRules");
const billing = require("../src/modules/business/health/services/labBilling");

// A clinic's prescription checks and a lab order's billing, without the
// database: a day's dose worked out from the dose, how often and the
// strength; a patient's allergies as written against a medicine's names and
// allergy group; the same medicine or group twice; and which of an order's
// tests are billed, how the rest would be (a profile as one), and why one
// asked for cannot be billed.

const paracetamol = { id: 1, generic_name: "Paracetamol", brand_names: "Dolo, Calpol", strength: "650 mg", form: "Tablet", max_daily_amount: "4000", max_daily_unit: "mg", allergy_group: null };
const amoxicillin = { id: 2, generic_name: "Amoxicillin", brand_names: "Mox", strength: "500 mg", form: "Capsule", max_daily_amount: "3000", max_daily_unit: "mg", allergy_group: "Penicillins" };
const aspirin = { id: 3, generic_name: "Aspirin", brand_names: "Ecosprin", strength: "75 mg", form: "Tablet", max_daily_amount: null, max_daily_unit: null, allergy_group: "NSAIDs" };
const ibuprofen = { id: 4, generic_name: "Ibuprofen", brand_names: "Brufen", strength: "400 mg", form: "Tablet", max_daily_amount: "2400", max_daily_unit: "mg", allergy_group: "NSAIDs" };
const syrup = { id: 5, generic_name: "Paracetamol", strength: "125 mg/5 ml", form: "Syrup", max_daily_amount: "1000", max_daily_unit: "mg", allergy_group: null };
const inhaler = { id: 6, generic_name: "Salbutamol", strength: "100 mcg/puff", form: "Inhaler", max_daily_amount: "800", max_daily_unit: "mcg", allergy_group: null };
const cotrim = { id: 7, generic_name: "Sulfamethoxazole + Trimethoprim", strength: "800 mg", form: "Tablet", max_daily_amount: "8", max_daily_unit: "tablets", allergy_group: "Sulfonamides" };
const LIST = [paracetamol, amoxicillin, aspirin, ibuprofen, syrup, inhaler, cotrim];

test("the rules load no database and no settings", () => {
  assert.equal(require.cache[DATABASE], undefined);
  assert.equal(require.cache[ENV], undefined);
});

test("a dose, a strength and how often, as a prescription writes them", () => {
  assert.deepEqual([rules.quantity("1"), rules.quantity("½"), rules.quantity("1½"), rules.quantity("1 1/2"), rules.quantity("1/2"), rules.quantity("two")], [1, 0.5, 1.5, 1.5, 0.5, null]);
  assert.deepEqual(rules.parseDose(""), { quantity: 1, kind: "count", factor: 1 });
  assert.deepEqual(rules.parseDose("2 tabs"), { quantity: 2, kind: "count", factor: 1 });
  assert.deepEqual(rules.parseDose("1-2 tab"), { quantity: 2, kind: "count", factor: 1 });
  assert.deepEqual(rules.parseDose("500 mg"), { quantity: 500, kind: "mass", factor: 1 });
  assert.deepEqual(rules.parseDose("1 tsp"), { quantity: 1, kind: "volume", factor: 5 });
  assert.equal(rules.parseDose("as directed"), null);
  assert.deepEqual(rules.parseStrength("650mg"), { amount: 650, kind: "mass", factor: 1, base: 650, per: null });
  assert.equal(rules.parseStrength("125 mg/5 ml").per.base, 5);
  assert.equal(rules.parseStrength("0.5%"), null);
  assert.equal(rules.parseStrength("500 mg + 125 mg"), null);
  assert.deepEqual(["1-0-1", "1-1-1", "0-0-1", "1-1-1-1", "½-0-½", "1.5-0-1.5", "OD", "b.d.", "TDS", "QID", "HS", "every 6 hours", "8 hourly", "q12h", "weekly", "alternate days"].map(rules.perDay),
    [2, 3, 1, 4, 1, 3, 1, 2, 3, 4, 1, 4, 3, 2, 1 / 7, 0.5]);
  assert.deepEqual(["SOS", "as needed", "", "after food"].map(rules.perDay), [null, null, null, null]);
});

test("a day's dose against the most a day, through the strength", () => {
  // 1 tablet of 650 mg three times: 1,950 mg; 2 tablets four times: 5,200 mg, over 4,000.
  assert.deepEqual(rules.dailyDose({ dose: "1 tab", frequency: "1-1-1" }, paracetamol), { amount: 1950, unit: "mg", max: 4000, over: false });
  assert.equal(rules.dailyDose({ dose: "2 tab", frequency: "1-1-1-1" }, paracetamol).over, true);
  // No dose written: one of the form each time.
  assert.equal(rules.dailyDose({ dose: "", frequency: "1-0-1" }, paracetamol).amount, 1300);
  // A dose in mg, a most in g.
  assert.deepEqual(rules.dailyDose({ dose: "1000 mg", frequency: "QID" }, { ...paracetamol, max_daily_amount: "4", max_daily_unit: "g" }), { amount: 4, unit: "g", max: 4, over: false });
  // A syrup by the spoon: 10 ml of 125 mg/5 ml four times is 1,000 mg.
  assert.deepEqual(rules.dailyDose({ dose: "2 tsp", frequency: "QID" }, syrup), { amount: 1000, unit: "mg", max: 1000, over: false });
  assert.equal(rules.dailyDose({ dose: "10 ml", frequency: "every 4 hours" }, syrup).over, true);
  // Puffs of 100 mcg, and a most counted in tablets.
  assert.equal(rules.dailyDose({ dose: "2 puffs", frequency: "QID" }, inhaler).amount, 800);
  assert.deepEqual(rules.dailyDose({ dose: "2 tab", frequency: "BD" }, cotrim), { amount: 4, unit: "tablets", max: 8, over: false });
  // The line's own strength counts first.
  assert.equal(rules.dailyDose({ dose: "1 tab", frequency: "TDS", strength: "1000 mg" }, paracetamol).amount, 3000);
  // Nothing to work out: as needed, no most a day, a dose with no figure.
  assert.equal(rules.dailyDose({ dose: "1 tab", frequency: "SOS" }, paracetamol), null);
  assert.equal(rules.dailyDose({ dose: "1 tab", frequency: "OD" }, aspirin), null);
  assert.equal(rules.dailyDose({ dose: "a little", frequency: "OD" }, paracetamol), null);
});

test("a patient's allergies as written against a medicine's names and its group", () => {
  const terms = rules.allergyTerms("Penicillin (rash); allergic to sulfa drugs, and aspirin");
  assert.deepEqual(terms.map((t) => t.words), [["penicillin"], ["sulfonamide"], ["aspirin"]]);
  assert.deepEqual(rules.allergyTerms("No known drug allergies / NKDA / nil"), []);
  const related = rules.relatedGroups(terms, LIST);
  assert.deepEqual(related.map((r) => [r.term.text, r.group]), [["aspirin", "NSAIDs"]]);
  assert.deepEqual(rules.allergyMatch(terms, related, amoxicillin), { kind: "group", term: "Penicillin (rash)", group: "Penicillins" });
  assert.deepEqual(rules.allergyMatch(terms, related, cotrim), { kind: "group", term: "allergic to sulfa drugs", group: "Sulfonamides" });
  assert.deepEqual(rules.allergyMatch(terms, related, aspirin), { kind: "generic", term: "aspirin" });
  // Allergic to aspirin, an NSAID on the list: ibuprofen is an NSAID too.
  assert.deepEqual(rules.allergyMatch(terms, related, ibuprofen), { kind: "related", term: "aspirin", group: "NSAIDs" });
  assert.equal(rules.allergyMatch(terms, related, paracetamol), null);
  // A brand name, and a generic inside a combination; a salt alone says nothing.
  assert.equal(rules.allergyMatch(rules.allergyTerms("Brufen"), [], ibuprofen).kind, "generic");
  assert.equal(rules.allergyMatch(rules.allergyTerms("amoxicillin"), [], { generic_name: "Amoxicillin + Clavulanic acid" }).kind, "generic");
  assert.equal(rules.allergyMatch(rules.allergyTerms("sodium"), [], { generic_name: "Diclofenac sodium" }), null);
  assert.equal(rules.allergyMatch(rules.allergyTerms("Sulpha"), [], cotrim).kind, "group");
});

test("a prescription's warnings: an allergy, the same medicine or group twice, a day's dose over the most", () => {
  const line = (drug, extra = {}) => ({ drugName: drug.generic_name, strength: drug.strength, dose: "1 tab", frequency: "1-1-1", drug, ...extra });
  const warnings = rules.checkPrescription([
    line(paracetamol),
    line(amoxicillin, { dose: "1 cap" }),
    line(ibuprofen),
    line(aspirin, { frequency: "OD" }),
    line(paracetamol, { dose: "2 tab", frequency: "1-1-1-1" }),
    { drugName: "Dolo", strength: "650 mg", dose: "1", frequency: "SOS", drug: null },
  ], { allergies: "Penicillin", list: LIST });
  assert.deepEqual(warnings.map((w) => [w.line, w.kind]), [[1, "allergy"], [3, "same_group"], [4, "same_medicine"], [4, "dose_over_max"]]);
  assert.equal(warnings[0].message, 'Allergy: the patient\'s allergies say "Penicillin", and Amoxicillin is in Penicillins.');
  assert.equal(warnings[1].message, "Aspirin and Ibuprofen (line 3) are both NSAIDs.");
  assert.equal(warnings[2].message, "Paracetamol is on line 1 already.");
  assert.equal(warnings[3].message, "Paracetamol: 2 tab 1-1-1-1 is 5,200 mg a day, more than the most of 4,000 mg a day.");
  // A line written by hand is checked by its name: an allergy and the same medicine, never a dose.
  const byHand = rules.checkPrescription([{ drugName: "Amoxycillin", drug: null }, { drugName: "Amoxicillin", dose: "10 tab", frequency: "QID", drug: null }],
    { allergies: "amoxicillin", list: LIST });
  assert.deepEqual(byHand.map((w) => [w.line, w.kind]), [[1, "allergy"]]);
  assert.deepEqual(rules.checkPrescription([], { allergies: "Penicillin" }), []);
});

test("an order's billing: what is billed, how the rest would be, and why a test cannot be billed", () => {
  const row = (id, extra = {}) => ({ id, order_id: 9, test_id: id * 10, code: `T${id}`, name: `Test ${id}`, sku_id: id * 100, price: "100.00", profile_id: null,
    profile_code: null, profile_name: null, profile_sku_id: null, profile_price: null, document_line_id: null, cancelled: false, ...extra });
  const profile = { profile_id: 50, profile_code: "LFT", profile_name: "Liver function", profile_sku_id: 500, profile_price: "600.00" };
  const rows = [row(1), row(2, profile), row(3, profile), row(4, { sku_id: null }), row(5, { cancelled: true })];
  assert.equal(billing.billingState(rows), "none");
  const { units, noService } = billing.billingUnits(rows);
  // The profile's two tests as one line at the profile's price.
  assert.deepEqual(units.map((u) => [u.kind, u.code, u.sku_id, u.order_test_ids]), [["test", "T1", 100, [1]], ["profile", "LFT", 500, [2, 3]]]);
  assert.deepEqual(noService, [4]);
  // Part billed: the rest stays to bill; once a profile's test is billed, the others go one by one.
  const part = [row(1, { document_line_id: 7 }), row(2, { ...profile, document_line_id: 8 }), row(3, profile)];
  assert.equal(billing.billingState(part), "part");
  assert.deepEqual(billing.billingUnits(part).units.map((u) => [u.kind, u.code, u.order_test_ids]), [["test", "T3", [3]]]);
  // Every live test billed (a cancelled one is never billed): billed.
  assert.equal(billing.billingState([row(1, { document_line_id: 7 }), row(2, { cancelled: true })]), "billed");
  assert.equal(billing.billingState([row(1, { cancelled: true })]), "none");
  // Asking for a profile's test brings its profile; each refusal says why.
  const asked = billing.unitsFor(rows, [3, 4, 5, 6]);
  assert.deepEqual(asked.units.map((u) => u.code), ["LFT"]);
  assert.deepEqual(asked.refused.map((r) => [r.id, r.why]), [["4", "no_service"], ["5", "cancelled"], ["6", "missing"]]);
  assert.deepEqual(billing.unitsFor(part, [1]).refused.map((r) => r.why), ["billed"]);
  // Rows of two orders: a profile is one order's.
  const two = [row(2, profile), row(3, { ...profile, order_id: 10 })];
  assert.deepEqual(billing.billingUnits(two).units.map((u) => [u.order_id, u.order_test_ids]), [[9, [2]], [10, [3]]]);
});
