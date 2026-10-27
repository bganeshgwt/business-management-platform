// The material calculators' arithmetic, with nothing else in it (tested on
// its own: tests/hardware-calculators.test.js). Each calculator takes what is
// typed and its assumptions, every one of them shown and changeable, and
// answers in what a shop sells: whole bags of cement, whole bricks, whole
// kilograms of steel, whole cubic feet of sand and aggregate (always up).
// These are estimates for the customer, not engineering.
//
//   tiles      an area and the wastage; what one unit (box) covers
//   paint      an area, the coats, what one litre covers in one coat; the packs
//   brickwork  a wall's length, height and thickness, less openings; the brick
//              size and joint, the mortar mix and its dry-volume factor
//   concrete   an area and a thickness, or a volume; the mix (cement : sand :
//              aggregate) and its dry-volume factor
//   plaster    an area and a thickness, or a volume; the mix (cement : sand)
//              and its dry-volume factor
//   steel      bars by diameter and length, how many of each; the weight of one
//              metre (diameter² ÷ 162 kg, from steel's density) and a bar's length
// A bag of cement holds the bag's kilograms at cement's density (50 kg at
// 1,440 kg/m³ is 0.0347 m³).

const SQFT_PER_SQM = 10.7639;
const M_PER_FT = 0.3048;
const MM_PER_IN = 25.4;
const CFT_PER_M3 = 35.3147;
const PAINT_PACKS = [1, 4, 10, 20];
const KINDS = ['tiles', 'paint', 'brickwork', 'concrete', 'plaster', 'steel'];
const DIAMETERS = [6, 8, 10, 12, 16, 20, 25, 32];
// A hair under a whole number is that number (0.1 + 0.2 and the like).
const EPSILON = 1e-9;
const up = (value) => Math.ceil(value - EPSILON);
// Figures shown to a thousandth.
const shown = (value) => Math.round(value * 1000) / 1000;

class CalculatorError extends Error {}
const fail = (message) => { throw new CalculatorError(message); };

// A number typed: more than `min` (or at least, with `atLeast`), at most `max`.
function number(value, name, { min = 0, max = 100000, atLeast = false, whole = false } = {}) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) fail(`${name} must be a number`);
  const n = Number(text);
  if ((atLeast ? n < min : n <= min) || n > max) fail(`${name} must be ${atLeast ? 'at least' : 'more than'} ${min} and at most ${max}`);
  if (whole && !Number.isInteger(n)) fail(`${name} must be a whole number`);
  return n;
}
const choice = (value, name, allowed, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) fail(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
};
const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';
// An assumption typed, or its usual value.
const assumed = (assumptions, key, fallback, name, limits) => (given(assumptions?.[key]) ? number(assumptions[key], name, limits) : fallback);

// "1:6" or "1:1.5:3": the parts of a mix, by volume.
function readMix(text, parts, name) {
  const pieces = String(text ?? '').split(':').map((part) => part.trim());
  if (pieces.length !== parts || pieces.some((part) => !/^\d+(\.\d+)?$/.test(part) || Number(part) <= 0 || Number(part) > 20)) {
    fail(`${name} is ${parts === 2 ? 'cement : sand, like 1:6' : 'cement : sand : aggregate, like 1:1.5:3'}`);
  }
  return pieces.map(Number);
}

const squareMetres = (area, unit) => (unit === 'sqm' ? area : area / SQFT_PER_SQM);
const metres = (length, unit) => (unit === 'm' ? length : length * M_PER_FT);

// --- Tiles and paint ------------------------------------------------------------------------------

function tiles(inputs, assumptions) {
  const areaUnit = choice(inputs.areaUnit, 'Area measured in', ['sqft', 'sqm'], 'sqft');
  const area = number(inputs.area, 'Area');
  const coverage = number(assumptions.coverage, 'What one unit covers (sq ft)');
  const wastage = assumed(assumptions, 'wastage', 10, 'Wastage %', { min: 0, max: 100, atLeast: true });
  const sqft = areaUnit === 'sqm' ? area * SQFT_PER_SQM : area;
  const needed = sqft * (1 + wastage / 100);
  const units = up(needed / coverage);
  return { inputs: { area, areaUnit }, assumptions: { coverage, wastage }, result: { sqft: shown(sqft), needed: shown(needed), units, covers: shown(units * coverage) } };
}

// The packs to buy for `litres` (sizes in litres, to a tenth): the least
// paint that covers the need, then the fewest packs, then bigger packs.
function packPlan(litres, sizes) {
  const need = Math.round(litres * 10);
  const steps = [...new Set(sizes.map((size) => Math.round(Number(size) * 10)).filter((size) => size > 0))].sort((a, b) => b - a);
  if (!(need > 0) || !steps.length) return null;
  const limit = need + steps[0];
  const cost = new Array(limit + 1).fill(Infinity);
  const last = new Array(limit + 1).fill(0);
  cost[0] = 0;
  for (let total = 1; total <= limit; total += 1) {
    steps.forEach((step, rank) => {
      if (step <= total && cost[total - step] + 1000000 + rank < cost[total]) {
        cost[total] = cost[total - step] + 1000000 + rank;
        last[total] = step;
      }
    });
  }
  let total = need;
  while (total <= limit && cost[total] === Infinity) total += 1;
  if (total > limit) return null;
  const counts = new Map();
  for (let left = total; left > 0; left -= last[left]) counts.set(last[left], (counts.get(last[left]) || 0) + 1);
  return { litres: total / 10, packs: steps.filter((step) => counts.has(step)).map((step) => ({ size: step / 10, count: counts.get(step) })) };
}

function paint(inputs, assumptions) {
  const areaUnit = choice(inputs.areaUnit, 'Area measured in', ['sqft', 'sqm'], 'sqft');
  const area = number(inputs.area, 'Area');
  const coats = number(inputs.coats ?? 2, 'Coats', { min: 1, max: 10, atLeast: true, whole: true });
  const coverage = number(assumptions.coverage, 'What one litre covers, one coat (sq ft)');
  const packs = Array.isArray(assumptions.packs) && assumptions.packs.length
    ? assumptions.packs.slice(0, 8).map((size) => number(size, 'Pack size (litres)', { max: 200 })) : PAINT_PACKS;
  const sqft = areaUnit === 'sqm' ? area * SQFT_PER_SQM : area;
  const litres = up((sqft * coats * 10) / coverage) / 10;
  return { inputs: { area, areaUnit, coats }, assumptions: { coverage, packs }, result: { sqft: shown(sqft), litres, plan: packPlan(litres, packs) } };
}

// --- Cement, sand and aggregate ---------------------------------------------------------------------

// What a dry mix takes: cement in bags, sand and aggregate in cubic feet.
function fromDry(dryM3, mix, { bagKg, cementDensity, wastage }) {
  const parts = mix.reduce((sum, part) => sum + part, 0);
  const extra = 1 + wastage / 100;
  const cementM3 = (dryM3 * mix[0]) / parts * extra;
  const sandM3 = (dryM3 * mix[1]) / parts * extra;
  const aggregateM3 = mix.length === 3 ? (dryM3 * mix[2]) / parts * extra : 0;
  return {
    cementBags: up((cementM3 * cementDensity) / bagKg), sandCft: up(sandM3 * CFT_PER_M3),
    ...(mix.length === 3 ? { aggregateCft: up(aggregateM3 * CFT_PER_M3) } : {}),
    cementM3: shown(cementM3), sandM3: shown(sandM3), ...(mix.length === 3 ? { aggregateM3: shown(aggregateM3) } : {}),
  };
}
const cementAssumptions = (assumptions) => ({
  bagKg: assumed(assumptions, 'bagKg', 50, 'Cement in one bag (kg)', { max: 100 }),
  cementDensity: assumed(assumptions, 'cementDensity', 1440, 'Cement density (kg/m³)', { min: 500, max: 3000 }),
});

function brickwork(inputs, assumptions) {
  const lengthUnit = choice(inputs.lengthUnit, 'Lengths measured in', ['ft', 'm'], 'ft');
  const length = number(inputs.length, 'Wall length', { max: 1000 });
  const height = number(inputs.height, 'Wall height', { max: 100 });
  const thickness = number(inputs.thickness, 'Wall thickness (mm)', { min: 50, max: 1000, atLeast: true });
  const openingsUnit = lengthUnit === 'm' ? 'sqm' : 'sqft';
  const openings = given(inputs.openings) ? number(inputs.openings, `Openings (${openingsUnit === 'sqm' ? 'm²' : 'sq ft'})`, { min: 0, max: 100000, atLeast: true }) : 0;
  const a = {
    brickLength: assumed(assumptions, 'brickLength', 190, 'Brick length (mm)', { min: 50, max: 500 }),
    brickWidth: assumed(assumptions, 'brickWidth', 90, 'Brick width (mm)', { min: 30, max: 300 }),
    brickHeight: assumed(assumptions, 'brickHeight', 90, 'Brick height (mm)', { min: 30, max: 300 }),
    joint: assumed(assumptions, 'joint', 10, 'Mortar joint (mm)', { min: 0, max: 40, atLeast: true }),
    mix: assumptions?.mix ? String(assumptions.mix).trim() : '1:6',
    dryFactor: assumed(assumptions, 'dryFactor', 1.33, 'Dry-volume factor', { min: 1, max: 2, atLeast: true }),
    wastage: assumed(assumptions, 'wastage', 5, 'Wastage %', { min: 0, max: 100, atLeast: true }),
    ...cementAssumptions(assumptions),
  };
  const mix = readMix(a.mix, 2, 'The mortar mix');
  const face = metres(length, lengthUnit) * metres(height, lengthUnit) - squareMetres(openings, openingsUnit);
  if (face <= 0) fail('The openings are as large as the wall');
  const wallM3 = face * (thickness / 1000);
  const nominal = ((a.brickLength + a.joint) * (a.brickWidth + a.joint) * (a.brickHeight + a.joint)) / 1e9;
  const exact = wallM3 / nominal;
  const mortarWetM3 = wallM3 - exact * ((a.brickLength * a.brickWidth * a.brickHeight) / 1e9);
  const mortarDryM3 = mortarWetM3 * a.dryFactor;
  return {
    inputs: { length, height, lengthUnit, thickness, openings },
    assumptions: a,
    result: { wallM3: shown(wallM3), bricks: up(exact * (1 + a.wastage / 100)), mortarWetM3: shown(mortarWetM3), mortarDryM3: shown(mortarDryM3), ...fromDry(mortarDryM3, mix, a) },
  };
}

// Concrete and plaster: an area and a thickness, or a volume, and a mix.
function mixed(kind, inputs, assumptions) {
  const concrete = kind === 'concrete';
  const by = choice(inputs.by, 'Worked out by', ['area', 'volume'], 'area');
  let wetM3, typed;
  if (by === 'volume') {
    const volumeUnit = choice(inputs.volumeUnit, 'Volume measured in', ['m3', 'cft'], 'cft');
    const volume = number(inputs.volume, 'Volume', { max: 100000 });
    wetM3 = volumeUnit === 'm3' ? volume : volume / CFT_PER_M3;
    typed = { by, volume, volumeUnit };
  } else {
    const areaUnit = choice(inputs.areaUnit, 'Area measured in', ['sqft', 'sqm'], 'sqft');
    const thicknessUnit = choice(inputs.thicknessUnit, 'Thickness measured in', ['mm', 'in'], concrete ? 'in' : 'mm');
    const area = number(inputs.area, 'Area', { max: 1000000 });
    const thickness = number(inputs.thickness, 'Thickness', { max: thicknessUnit === 'mm' ? 2000 : 80 });
    wetM3 = squareMetres(area, areaUnit) * ((thicknessUnit === 'mm' ? thickness : thickness * MM_PER_IN) / 1000);
    typed = { by, area, areaUnit, thickness, thicknessUnit };
  }
  const a = {
    mix: assumptions?.mix ? String(assumptions.mix).trim() : concrete ? '1:1.5:3' : '1:4',
    dryFactor: assumed(assumptions, 'dryFactor', concrete ? 1.54 : 1.27, 'Dry-volume factor', { min: 1, max: 2, atLeast: true }),
    wastage: assumed(assumptions, 'wastage', concrete ? 3 : 5, 'Wastage %', { min: 0, max: 100, atLeast: true }),
    ...cementAssumptions(assumptions),
  };
  const mix = readMix(a.mix, concrete ? 3 : 2, concrete ? 'The concrete mix' : 'The plaster mix');
  const dryM3 = wetM3 * a.dryFactor;
  return { inputs: typed, assumptions: a, result: { wetM3: shown(wetM3), dryM3: shown(dryM3), ...fromDry(dryM3, mix, a) } };
}

// --- Steel ----------------------------------------------------------------------------------------

// The weight of one metre of a bar: diameter² ÷ 162 kg (steel at 7,850 kg/m³).
const kgPerMetre = (diameter) => (diameter * diameter) / 162;

function steel(inputs, assumptions) {
  const lengthUnit = choice(inputs.lengthUnit, 'Lengths measured in', ['m', 'ft'], 'm');
  const bars = Array.isArray(inputs.bars) ? inputs.bars : fail('List the bars: their diameter, length and how many');
  if (!bars.length || bars.length > 20) fail('List between 1 and 20 kinds of bar');
  const weights = assumptions?.kgPerMetre && typeof assumptions.kgPerMetre === 'object' ? assumptions.kgPerMetre : {};
  const a = {
    wastage: assumed(assumptions, 'wastage', 3, 'Wastage %', { min: 0, max: 100, atLeast: true }),
    barLength: assumed(assumptions, 'barLength', 12, 'Length of one bar (m)', { max: 30 }),
    kgPerMetre: {},
  };
  const typed = bars.map((bar, index) => {
    const diameter = Number(bar?.diameter);
    if (!DIAMETERS.includes(diameter)) fail(`Bar ${index + 1}: the diameter is one of ${DIAMETERS.join(', ')} mm`);
    return { diameter, length: number(bar?.length, `Bar ${index + 1}: length`, { max: 1000 }), count: number(bar?.count, `Bar ${index + 1}: how many`, { max: 100000, whole: true }) };
  });
  const byDiameter = new Map();
  for (const bar of typed) byDiameter.set(bar.diameter, (byDiameter.get(bar.diameter) || 0) + metres(bar.length, lengthUnit) * bar.count);
  const rows = [...byDiameter.entries()].sort((x, y) => x[0] - y[0]).map(([diameter, totalMetres]) => {
    const perMetre = given(weights[diameter]) ? number(weights[diameter], `Weight of one metre of ${diameter} mm (kg)`, { max: 20 }) : shown(kgPerMetre(diameter));
    a.kgPerMetre[diameter] = perMetre;
    const withWastage = totalMetres * (1 + a.wastage / 100);
    return { diameter, metres: shown(totalMetres), kgPerMetre: perMetre, kg: up(withWastage * perMetre), bars: up(withWastage / a.barLength) };
  });
  return { inputs: { lengthUnit, bars: typed }, assumptions: a, result: { rows, kg: rows.reduce((sum, row) => sum + row.kg, 0) } };
}

// Works one calculator out. kind: one of KINDS; inputs and assumptions: as typed.
function calculate(kind, inputs = {}, assumptions = {}) {
  if (!KINDS.includes(kind)) fail(`The calculator is one of: ${KINDS.join(', ')}`);
  const i = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : fail('What is typed must be an object');
  const a = assumptions && typeof assumptions === 'object' && !Array.isArray(assumptions) ? assumptions : fail('The assumptions must be an object');
  const done = kind === 'tiles' ? tiles(i, a) : kind === 'paint' ? paint(i, a) : kind === 'brickwork' ? brickwork(i, a)
    : kind === 'steel' ? steel(i, a) : mixed(kind, i, a);
  return { kind, ...done };
}

// What a result comes to in each material the shop sells: bags of cement,
// bricks, cubic feet of sand and aggregate, kilograms (and bars) of steel by
// diameter, units of tiles, litres of paint.
function materials(worked) {
  const r = worked.result;
  if (worked.kind === 'tiles') return [{ material: 'tiles', measure: 'units', amount: r.units }];
  if (worked.kind === 'paint') return [{ material: 'paint', measure: 'litres', amount: r.litres }];
  if (worked.kind === 'steel') return r.rows.map((row) => ({ material: `steel_${row.diameter}`, measure: 'kg', amount: row.kg, bars: row.bars, barLength: worked.assumptions.barLength }));
  return [
    ...(worked.kind === 'brickwork' ? [{ material: 'bricks', measure: 'bricks', amount: r.bricks }] : []),
    { material: 'cement', measure: 'bags', amount: r.cementBags, bagKg: worked.assumptions.bagKg },
    { material: 'sand', measure: 'cft', amount: r.sandCft },
    ...(r.aggregateCft !== undefined ? [{ material: 'aggregate', measure: 'cft', amount: r.aggregateCft }] : []),
  ];
}

module.exports = { calculate, materials, kgPerMetre, packPlan, CalculatorError, KINDS, DIAMETERS, SQFT_PER_SQM, CFT_PER_M3 };
