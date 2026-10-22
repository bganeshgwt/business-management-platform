// Plain helpers for the wholesale screens (no components here, so fast refresh works).

export const ORDER_STATUS = {
  open: { tone: "info", label: "Open" },
  part_dispatched: { tone: "warning", label: "Part sent" },
  dispatched: { tone: "active", label: "Dispatched" },
  closed: { tone: "neutral", label: "Closed short" },
  cancelled: { tone: "inactive", label: "Cancelled" },
};
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Units a line may be entered in: the stock unit, its pack sizes, and units
// of the same kind (g for a kg item). factor = stock units in one.
export function unitChoices(sku, units) {
  if (!sku) return [];
  const base = units.find((u) => u.code === sku.unit);
  const root = base?.base_unit_code || sku.unit;
  const related = units.filter((u) => u.active && u.code !== sku.unit && u.kind === base?.kind && (u.base_unit_code || u.code) === root);
  return [
    { code: sku.unit, label: base?.name || sku.unit, factor: 1 },
    ...(sku.pack_sizes || []).map((p) => ({ code: p.unit_code, label: `${units.find((u) => u.code === p.unit_code)?.name || p.unit_code} of ${Number(p.quantity_in_base)}`, factor: Number(p.quantity_in_base) })),
    ...related.filter((u) => !(sku.pack_sizes || []).some((p) => p.unit_code === u.code)).map((u) => ({
      code: u.code, label: u.name, factor: (u.base_unit_code ? Number(u.factor_to_base) : 1) / (base?.base_unit_code ? Number(base.factor_to_base) : 1),
    })),
  ];
}

// "3 case (216 each)" — what was typed and what it is in the stock unit.
export const packText = (enteredQty, enteredUnit, qty, unit) => {
  const n = (v) => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  return enteredUnit ? `${n(enteredQty)} ${enteredUnit} (${n(qty)} ${unit})` : `${n(qty)} ${unit}`;
};

// A stock-unit quantity shown in whole packs where it divides evenly: "1 case + 8 each".
export function inPacks(qty, unit, packUnit, factor) {
  const n = Number(qty || 0);
  const f = Number(factor || 0);
  const fmt = (v) => v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
  if (!packUnit || !f || n < f) return `${fmt(n)} ${unit}`;
  const packs = Math.floor(n / f + 1e-9);
  const rest = Math.round((n - packs * f) * 1000) / 1000;
  return rest ? `${packs} ${packUnit} + ${fmt(rest)} ${unit}` : `${packs} ${packUnit} (${fmt(n)} ${unit})`;
}


// The pack an item is mostly sold in (its biggest pack size): { unit, factor } or null.
export function packOf(sku) {
  const sizes = (sku?.pack_sizes || []).filter((p) => p.active !== false);
  if (!sizes.length) return null;
  const best = sizes.reduce((a, b) => (Number(b.quantity_in_base) > Number(a.quantity_in_base) ? b : a));
  return { unit: best.unit_code, factor: Number(best.quantity_in_base) };
}

// A stock-unit quantity as cases + pieces: { cases, pieces }.
export function splitPacks(qty, factor) {
  const n = Number(qty || 0);
  if (!factor) return { cases: 0, pieces: n };
  const cases = Math.floor(n / factor + 1e-9);
  return { cases, pieces: Math.round((n - cases * factor) * 1000) / 1000 };
}

// The words for where a price came from.
export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
