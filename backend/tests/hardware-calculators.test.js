const { test } = require('node:test');
const assert = require('node:assert/strict');
const maths = require('../src/modules/business/hardware/services/hardwareCalculatorMaths');

// The material calculators on fixed inputs: what each gives, in what a shop
// sells (whole bags, bricks, kilograms and cubic feet, always up), with every
// assumption shown and changeable. Worked by hand beside each case.

test('tiles: the area with its wastage, in whole boxes', () => {
  // 200 sq ft and 10% is 220 sq ft: 13.75 boxes of 16 sq ft, so 14.
  assert.deepEqual(maths.calculate('tiles', { area: '200' }, { coverage: '16' }).result, { sqft: 200, needed: 220, units: 14, covers: 224 });
  // 20 m² is 215.278 sq ft; with no wastage 13.45 boxes, so 14.
  const metric = maths.calculate('tiles', { area: '20', areaUnit: 'sqm' }, { coverage: '16', wastage: '0' });
  assert.deepEqual([metric.result.sqft, metric.result.units, metric.assumptions.wastage], [215.278, 14, 0]);
});

test('paint: litres to the next tenth, then the least paint in the fewest tins', () => {
  // 600 sq ft, two coats, 55 sq ft a litre: 21.82 L, so 21.9 L; 1 × 20 L + 2 × 1 L = 22 L.
  const worked = maths.calculate('paint', { area: '600', coats: '2' }, { coverage: '55' });
  assert.deepEqual(worked.result, { sqft: 600, litres: 21.9, plan: { litres: 22, packs: [{ size: 20, count: 1 }, { size: 1, count: 2 }] } });
  // The paint's own tins of 4 and 10 L: the least paint over 21.9 L is 1 × 10 + 3 × 4 = 22 L.
  assert.deepEqual(maths.calculate('paint', { area: '600', coats: '2' }, { coverage: '55', packs: ['4', '10'] }).result.plan,
    { litres: 22, packs: [{ size: 10, count: 1 }, { size: 4, count: 3 }] });
});

test('brickwork: bricks, then the mortar between them as cement and sand', () => {
  // A 10 ft × 10 ft wall, 230 mm thick: 2.137 m³. A 190 × 90 × 90 mm brick
  // with a 10 mm joint takes 0.002 m³: 1,068.4 bricks, 1,121.8 with 5%, so
  // 1,122. The mortar is what the bricks leave: 0.493 m³ wet, 0.655 m³ dry
  // (× 1.33); at 1:6 that is 0.0983 m³ of cement with 5% (2.83 bags of 50 kg
  // at 1,440 kg/m³, so 3) and 0.590 m³ of sand (20.8 cft, so 21).
  const worked = maths.calculate('brickwork', { length: '10', height: '10', thickness: '230' }, {});
  assert.deepEqual([worked.result.wallM3, worked.result.bricks, worked.result.mortarWetM3, worked.result.mortarDryM3, worked.result.cementBags, worked.result.sandCft],
    [2.137, 1122, 0.493, 0.655, 3, 21]);
  assert.deepEqual(worked.assumptions, { brickLength: 190, brickWidth: 90, brickHeight: 90, joint: 10, mix: '1:6', dryFactor: 1.33, wastage: 5, bagKg: 50, cementDensity: 1440 });
  // A 3 m × 3 m half-brick wall less a 1.5 m² window, of 230 × 110 × 75 mm
  // bricks at 1:4: 0.8625 m³, 352.3 bricks (370 with 5%), 2 bags and 8 cft.
  const metric = maths.calculate('brickwork', { length: '3', height: '3', lengthUnit: 'm', thickness: '115', openings: '1.5' },
    { brickLength: '230', brickWidth: '110', brickHeight: '75', mix: '1:4' });
  assert.deepEqual([metric.result.wallM3, metric.result.bricks, metric.result.cementBags, metric.result.sandCft], [0.863, 370, 2, 8]);
  assert.throws(() => maths.calculate('brickwork', { length: '3', height: '3', lengthUnit: 'm', thickness: '115', openings: '9' }, {}), /openings are as large as the wall/);
  assert.throws(() => maths.calculate('brickwork', { length: '10', height: '10', thickness: '230' }, { mix: '1:2:4' }), /mortar mix is cement : sand/);
});

test('concrete: by area and thickness or by volume, with a three-part mix', () => {
  // 100 sq ft, 4 in thick: 0.944 m³ wet, 1.454 m³ dry (× 1.54); at 1:1.5:3
  // with 3%: 7.84 bags (8), 14.4 cft of sand (15), 28.8 cft of aggregate (29).
  const slab = maths.calculate('concrete', { area: '100', thickness: '4' }, {});
  assert.deepEqual([slab.result.wetM3, slab.result.dryM3, slab.result.cementBags, slab.result.sandCft, slab.result.aggregateCft], [0.944, 1.454, 8, 15, 29]);
  assert.deepEqual([slab.inputs.thicknessUnit, slab.assumptions.mix, slab.assumptions.dryFactor, slab.assumptions.wastage], ['in', '1:1.5:3', 1.54, 3]);
  // 1 m³: 8.31 bags (9), 15.3 cft of sand (16), 30.6 cft of aggregate (31).
  const cube = maths.calculate('concrete', { by: 'volume', volume: '1', volumeUnit: 'm3' }, {});
  assert.deepEqual([cube.result.cementBags, cube.result.sandCft, cube.result.aggregateCft], [9, 16, 31]);
  assert.throws(() => maths.calculate('concrete', { area: '100', thickness: '4' }, { mix: '1:4' }), /concrete mix is cement : sand : aggregate/);
});

test('plaster: an area and its thickness with a two-part mix', () => {
  // 100 sq ft, 12 mm: 0.111 m³ wet, 0.142 m³ dry (× 1.27); at 1:4 with 5%:
  // 0.86 bags (1) and 4.2 cft of sand (5).
  const worked = maths.calculate('plaster', { area: '100', thickness: '12' }, {});
  assert.deepEqual([worked.result.wetM3, worked.result.dryM3, worked.result.cementBags, worked.result.sandCft, worked.result.aggregateCft], [0.111, 0.142, 1, 5, undefined]);
  assert.deepEqual([worked.inputs.thicknessUnit, worked.assumptions.mix, worked.assumptions.dryFactor], ['mm', '1:4', 1.27]);
});

test('steel: each diameter by its weight per metre, diameter² ÷ 162', () => {
  assert.equal(maths.kgPerMetre(12).toFixed(4), '0.8889');
  // 10 bars of 12 mm × 12 m and 20 of 8 mm × 6 m, 3% for wastage: 123.6 m of
  // each; 109.9 kg (110) of 12 mm at 0.889 kg/m, 48.8 kg (49) of 8 mm at 0.395.
  const worked = maths.calculate('steel', { bars: [{ diameter: 12, length: '12', count: '10' }, { diameter: 8, length: '6', count: '20' }] }, {});
  assert.deepEqual(worked.result, { rows: [{ diameter: 8, metres: 120, kgPerMetre: 0.395, kg: 49, bars: 11 }, { diameter: 12, metres: 120, kgPerMetre: 0.889, kg: 110, bars: 11 }], kg: 159 });
  // A weight per metre typed for 12 mm, in feet.
  const typed = maths.calculate('steel', { lengthUnit: 'ft', bars: [{ diameter: 12, length: '40', count: '5' }] }, { kgPerMetre: { 12: '0.888' }, wastage: '0' });
  assert.deepEqual(typed.result.rows, [{ diameter: 12, metres: 60.96, kgPerMetre: 0.888, kg: 55, bars: 6 }]);
  assert.throws(() => maths.calculate('steel', { bars: [{ diameter: 9, length: '12', count: '1' }] }, {}), /diameter is one of/);
});

test('what each result comes to by material', () => {
  const worked = maths.calculate('concrete', { area: '100', thickness: '4' }, {});
  assert.deepEqual(maths.materials(worked), [{ material: 'cement', measure: 'bags', amount: 8, bagKg: 50 }, { material: 'sand', measure: 'cft', amount: 15 },
    { material: 'aggregate', measure: 'cft', amount: 29 }]);
  assert.throws(() => maths.calculate('roofing', {}, {}), /The calculator is one of/);
});
