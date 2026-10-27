// A calculator's working kept with a quotation or a bill, in words: what was
// typed, the assumptions and what came out, as the server worked them out
// (backend hardwareCalculatorMaths.js). Plain functions with no screen in
// them, so the detail, the print and the tests share them
// (tests/hardware-workings.test.js). Estimates for the customer, not engineering.

export const ESTIMATE_NOTE = "These are estimates for the customer, not engineering.";
export const KIND_WORDS = { tiles: "Tiles", paint: "Paint", brickwork: "Brickwork", concrete: "Concrete", plaster: "Plaster", steel: "Steel" };

const n = (value, places = 3) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: places });
const plural = (count, one, many) => `${n(count, 0)} ${Number(count) === 1 ? one : many}`;
const areaWords = (area, unit) => `${n(area, 2)} ${unit === "sqm" ? "m²" : "sq ft"}`;
const lengthUnit = (unit) => (unit === "m" ? "m" : "ft");

// What was typed, in words.
export function inputWords(kind, inputs = {}) {
  if (kind === "tiles") return areaWords(inputs.area, inputs.areaUnit);
  if (kind === "paint") return `${areaWords(inputs.area, inputs.areaUnit)}, ${plural(inputs.coats, "coat", "coats")}`;
  if (kind === "brickwork") {
    const u = lengthUnit(inputs.lengthUnit);
    return `a wall ${n(inputs.length, 2)} ${u} long and ${n(inputs.height, 2)} ${u} high, ${n(inputs.thickness, 0)} mm thick`
      + (Number(inputs.openings) > 0 ? `, less ${n(inputs.openings, 2)} ${u === "m" ? "m²" : "sq ft"} of openings` : "");
  }
  if (kind === "concrete" || kind === "plaster") {
    if (inputs.by === "volume") return `${n(inputs.volume, 3)} ${inputs.volumeUnit === "m3" ? "m³" : "cft"}`;
    return `${areaWords(inputs.area, inputs.areaUnit)}, ${n(inputs.thickness, 2)} ${inputs.thicknessUnit === "in" ? "in" : "mm"} thick`;
  }
  if (kind === "steel") {
    const u = lengthUnit(inputs.lengthUnit === "ft" ? "ft" : "m");
    return (inputs.bars || []).map((bar) => `${plural(bar.count, "bar", "bars")} of ${bar.diameter} mm × ${n(bar.length, 2)} ${u}`).join(", ");
  }
  return "";
}

// The assumptions, in words.
export function assumptionWords(kind, a = {}) {
  const wastage = a.wastage !== undefined ? `${n(a.wastage, 2)}% for wastage` : null;
  const cement = a.bagKg ? `cement in ${n(a.bagKg, 2)} kg bags at ${n(a.cementDensity, 0)} kg/m³` : null;
  if (kind === "tiles") return [`one unit covers ${n(a.coverage, 2)} sq ft`, wastage].filter(Boolean).join(", ");
  if (kind === "paint") return [`one litre covers ${n(a.coverage, 2)} sq ft a coat`, a.packs?.length ? `packs of ${a.packs.map((p) => `${n(p, 1)} L`).join(", ")}` : null].filter(Boolean).join(", ");
  if (kind === "brickwork") {
    return [`bricks of ${n(a.brickLength, 0)} × ${n(a.brickWidth, 0)} × ${n(a.brickHeight, 0)} mm with a ${n(a.joint, 0)} mm joint`, `mortar ${a.mix}`,
      `dry-volume factor ${n(a.dryFactor, 2)}`, wastage, cement].filter(Boolean).join(", ");
  }
  if (kind === "concrete" || kind === "plaster") return [`mix ${a.mix}`, `dry-volume factor ${n(a.dryFactor, 2)}`, wastage, cement].filter(Boolean).join(", ");
  if (kind === "steel") {
    const weights = Object.entries(a.kgPerMetre || {}).map(([d, kg]) => `${d} mm ${n(kg, 3)} kg/m`).join(", ");
    return [weights && `weights of one metre: ${weights} (diameter² ÷ 162)`, `bars of ${n(a.barLength, 2)} m`, wastage].filter(Boolean).join(", ");
  }
  return "";
}

// What came out, in words.
export function resultWords(kind, r = {}) {
  if (kind === "tiles") return `${plural(r.units, "unit", "units")} for ${n(r.needed, 2)} sq ft, covering ${n(r.covers, 2)} sq ft`;
  if (kind === "paint") {
    const plan = r.plan?.packs?.length ? `; buy ${r.plan.packs.map((p) => `${p.count} × ${n(p.size, 1)} L`).join(" + ")} = ${n(r.plan.litres, 1)} L` : "";
    return `${n(r.litres, 1)} L${plan}`;
  }
  if (kind === "steel") {
    return [...(r.rows || []).map((row) => `${row.diameter} mm: ${n(row.metres, 2)} m, ${n(row.kg, 0)} kg (${plural(row.bars, "bar", "bars")})`), `${n(r.kg, 0)} kg in all`].join("; ");
  }
  return [kind === "brickwork" ? plural(r.bricks, "brick", "bricks") : null, plural(r.cementBags, "bag of cement", "bags of cement"),
    `${n(r.sandCft, 0)} cft of sand`, r.aggregateCft !== undefined ? `${n(r.aggregateCft, 0)} cft of aggregate` : null].filter(Boolean).join(", ");
}

// One working in one line: "Brickwork: a wall …; bricks of … → 1,122 bricks, 3 bags of cement and 21 cft of sand".
export function workingLine(kind, working = {}) {
  return `${KIND_WORDS[kind] || kind}: ${inputWords(kind, working.inputs)}; ${assumptionWords(kind, working.assumptions)} → ${resultWords(kind, working.result)}`;
}
