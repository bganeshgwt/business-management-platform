import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figureOf, packPlan, paintLitres, squareFeet, tileBoxes, unitWords, usesCalculators } from '../src/modules/business/hardware/pages/calculators.js';

// The hardware shop's tile and paint calculators: plain arithmetic on the
// coverage kept on the items.
test('tiles: the area with wastage, in whole boxes', () => {
  // 200 sq ft with 10% wastage is 220 sq ft: 14 boxes of 16 sq ft (224 sq ft).
  assert.deepEqual(tileBoxes({ area: '200', unit: 'sqft', wastage: '10', coverage: '16' }), { sqft: 200, needed: 220, boxes: 14, covers: 224 });
  // Exactly full boxes are not rounded up by a hair of floating point: 100 sq ft, no wastage, 10 sq ft a box.
  assert.equal(tileBoxes({ area: '100', wastage: '0', coverage: '10' }).boxes, 10);
  assert.equal(tileBoxes({ area: '0.3', wastage: '0', coverage: '0.1' }).boxes, 3);
  // Square metres: 20 m² is 215.278 sq ft; with 5% wastage, 15 boxes of 15.5 sq ft.
  const metric = tileBoxes({ area: '20', unit: 'sqm', wastage: '5', coverage: '15.5' });
  assert.equal(metric.sqft, 215.278);
  assert.equal(metric.boxes, 15);
  assert.equal(squareFeet('1', 'sqm'), 10.7639);
  // Nothing until the area and the coverage are known.
  for (const input of [{ area: '', coverage: '16' }, { area: '100', coverage: '' }, { area: '-5', coverage: '16' }, { area: '100', coverage: '16', wastage: '-1' }]) {
    assert.equal(tileBoxes(input), null);
  }
});

test('paint: litres for the coats, then the packs to buy', () => {
  // 600 sq ft, two coats, 55 sq ft a litre: 21.818… L, up to 21.9 L.
  assert.deepEqual(paintLitres({ area: '600', coats: '2', coverage: '55' }), { sqft: 600, litres: 21.9 });
  assert.equal(paintLitres({ area: '400', coats: '2', coverage: '80' }).litres, 10);
  assert.equal(paintLitres({ area: '400', coats: '1.5', coverage: '80' }), null);
  assert.equal(paintLitres({ area: '400', coats: '0', coverage: '80' }), null);
  // The least paint first, then the fewest packs: 37.3 L is 38 L as 20 + 10 + 4 + 4.
  assert.deepEqual(packPlan(37.3), { litres: 38, packs: [{ size: 20, count: 1 }, { size: 10, count: 1 }, { size: 4, count: 2 }] });
  // A tie in packs goes to the bigger packs: 12 L is three 4 L tins, not 10 + 1 + 1.
  assert.deepEqual(packPlan(12), { litres: 12, packs: [{ size: 4, count: 3 }] });
  assert.deepEqual(packPlan(21.9), { litres: 22, packs: [{ size: 20, count: 1 }, { size: 1, count: 2 }] });
  assert.deepEqual(packPlan(0.4), { litres: 1, packs: [{ size: 1, count: 1 }] });
  // A paint's own tins: 0.9, 3.6 and 18 L. 10 L needs 10.8 L, as three 3.6 L tins.
  assert.deepEqual(packPlan(10, [0.9, 3.6, 18]), { litres: 10.8, packs: [{ size: 3.6, count: 3 }] });
  // One size only: whole tins.
  assert.deepEqual(packPlan(9.5, [4]), { litres: 12, packs: [{ size: 4, count: 3 }] });
  assert.equal(packPlan(0), null);
  assert.equal(packPlan(5, []), null);
});

test('figures come from the items, and the calculators from the module', () => {
  assert.equal(figureOf({ attributes: { coverageSqftPerUnit: '16' } }, 'coverageSqftPerUnit'), 16);
  assert.equal(figureOf({ attributes: { coverageSqftPerUnit: '' } }, 'coverageSqftPerUnit'), null);
  assert.equal(figureOf({ attributes: {} }, 'litresPerUnit'), null);
  assert.equal(figureOf(null, 'litresPerUnit'), null);
  assert.deepEqual([unitWords(1, 'box'), unitWords(14, 'box'), unitWords(3, 'bag'), unitWords(6, 'each'), unitWords(1, 'each')], ['box', 'boxes', 'bags', 'pieces', 'piece']);
  const biz = (type, modules) => ({ type, has: (code) => modules.includes(code) });
  assert.equal(usesCalculators(biz('hardware', ['hardware_calculators'])), true);
  assert.equal(usesCalculators(biz('hardware', [])), false);
  assert.equal(usesCalculators(biz('grocery', ['hardware_calculators'])), false);
});
