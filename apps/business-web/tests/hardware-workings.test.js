import { test } from "node:test";
import assert from "node:assert/strict";
import { assumptionWords, inputWords, resultWords, workingLine } from "../src/modules/business/hardware/pages/workings.js";

// A calculator's working kept with a quotation or a bill, read back in words
// on the detail and the print. The figures are the server's.

test("brickwork reads as the wall, its assumptions and what it needs", () => {
  const working = {
    inputs: { length: 10, height: 10, lengthUnit: "ft", thickness: 230, openings: 0 },
    assumptions: { brickLength: 190, brickWidth: 90, brickHeight: 90, joint: 10, mix: "1:6", dryFactor: 1.33, wastage: 5, bagKg: 50, cementDensity: 1440 },
    result: { wallM3: 2.137, bricks: 1122, cementBags: 3, sandCft: 21 },
  };
  assert.equal(workingLine("brickwork", working), "Brickwork: a wall 10 ft long and 10 ft high, 230 mm thick; bricks of 190 × 90 × 90 mm with a 10 mm joint, "
    + "mortar 1:6, dry-volume factor 1.33, 5% for wastage, cement in 50 kg bags at 1,440 kg/m³ → 1,122 bricks, 3 bags of cement, 21 cft of sand");
});

test("concrete by area or volume, plaster, steel, tiles and paint", () => {
  assert.equal(inputWords("concrete", { by: "area", area: 100, areaUnit: "sqft", thickness: 4, thicknessUnit: "in" }), "100 sq ft, 4 in thick");
  assert.equal(inputWords("concrete", { by: "volume", volume: 1, volumeUnit: "m3" }), "1 m³");
  assert.equal(resultWords("concrete", { cementBags: 8, sandCft: 15, aggregateCft: 29 }), "8 bags of cement, 15 cft of sand, 29 cft of aggregate");
  assert.equal(resultWords("plaster", { cementBags: 1, sandCft: 5 }), "1 bag of cement, 5 cft of sand");
  assert.equal(inputWords("steel", { lengthUnit: "m", bars: [{ diameter: 12, length: 12, count: 10 }] }), "10 bars of 12 mm × 12 m");
  assert.equal(assumptionWords("steel", { wastage: 3, barLength: 12, kgPerMetre: { 12: 0.889 } }), "weights of one metre: 12 mm 0.889 kg/m (diameter² ÷ 162), bars of 12 m, 3% for wastage");
  assert.equal(resultWords("steel", { rows: [{ diameter: 12, metres: 120, kg: 110, bars: 11 }], kg: 110 }), "12 mm: 120 m, 110 kg (11 bars); 110 kg in all");
  assert.equal(resultWords("tiles", { units: 14, needed: 220, covers: 224 }), "14 units for 220 sq ft, covering 224 sq ft");
  assert.equal(resultWords("paint", { litres: 21.9, plan: { litres: 22, packs: [{ size: 20, count: 1 }, { size: 1, count: 2 }] } }), "21.9 L; buy 1 × 20 L + 2 × 1 L = 22 L");
});
