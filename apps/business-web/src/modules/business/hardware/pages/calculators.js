// Tile & paint calculators (module "hardware_calculators"): plain arithmetic
// on the figures kept on the items (backend core/services/businessModules.js
// › figures), with no screen in it, so it is tested on its own
// (tests/hardware-calculators.test.js).

export const SQFT_PER_SQM = 10.7639;
// The paint packs a shop usually stocks, in litres.
export const PAINT_PACKS = [1, 4, 10, 20];
// A hair under a whole number is that number (0.1 + 0.2 and the like).
const EPSILON = 1e-9;
// Figures shown to a thousandth.
const shown = (value) => Math.round(value * 1000) / 1000;

// On Quick bill and on a quotation, in a hardware shop with the calculators on.
export const usesCalculators = (biz) => biz.type === "hardware" && biz.has("hardware_calculators");

// A count of an item's units in words: 1 box, 14 boxes, 3 bags, 6 pieces.
export function unitWords(count, unit) {
  if (unit === "each") return count === 1 ? "piece" : "pieces";
  if (count === 1) return unit;
  return /(x|s|ch|sh)$/.test(unit) ? `${unit}es` : `${unit}s`;
}

// An item's figure (coverageSqftPerUnit, coverageSqftPerLitre, litresPerUnit), or null.
export function figureOf(sku, key) {
  const value = Number(sku?.attributes?.[key]);
  return value > 0 ? value : null;
}

// An area in square feet, from square feet or square metres.
export function squareFeet(area, unit = "sqft") {
  const value = Number(area);
  if (!(value > 0)) return 0;
  return unit === "sqm" ? value * SQFT_PER_SQM : value;
}

// Tiles: the area with the wastage added, and the units (boxes) that cover
// it. null until the area and the coverage are known.
export function tileBoxes({ area, unit = "sqft", wastage = 10, coverage }) {
  const sqft = squareFeet(area, unit);
  const per = Number(coverage);
  const extra = Number(wastage);
  if (!(sqft > 0) || !(per > 0) || !(extra >= 0) || extra > 100) return null;
  const needed = sqft * (1 + extra / 100);
  const boxes = Math.ceil(needed / per - EPSILON);
  return { sqft: shown(sqft), needed: shown(needed), boxes, covers: shown(boxes * per) };
}

// Paint: the litres for the area and the coats, up to the next tenth of a
// litre. null until the area, the coats (whole) and the coverage are known.
export function paintLitres({ area, unit = "sqft", coats = 2, coverage }) {
  const sqft = squareFeet(area, unit);
  const per = Number(coverage);
  const times = Number(coats);
  if (!(sqft > 0) || !(per > 0) || !Number.isInteger(times) || times < 1) return null;
  return { sqft: shown(sqft), litres: Math.ceil((sqft * times * 10) / per - EPSILON) / 10 };
}

// The packs to buy for `litres` (sizes in litres, to a tenth): the least
// paint that covers the need, then the fewest packs, then bigger packs over
// smaller ones (they cost less a litre). { litres, packs: [{ size, count }] }
// with the largest pack first, or null.
export function packPlan(litres, sizes = PAINT_PACKS) {
  const need = Math.round(Number(litres) * 10);
  const steps = [...new Set(sizes.map((size) => Math.round(Number(size) * 10)).filter((size) => size > 0))].sort((a, b) => b - a);
  if (!(need > 0) || !steps.length) return null;
  const limit = need + steps[0];
  // Each pack counts a million; a smaller pack adds a little more, so the
  // count always wins and bigger packs break a tie.
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
