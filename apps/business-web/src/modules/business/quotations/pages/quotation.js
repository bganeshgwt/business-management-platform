// Words and small helpers the quotation screens share.

// A quotation's state as people say it, and how it is drawn.
export const STATES = {
  open: { label: "Open", tone: "info" },
  part_billed: { label: "Part billed", tone: "warning" },
  expired: { label: "Expired", tone: "danger" },
  billed: { label: "Billed", tone: "success" },
  ordered: { label: "On a sales order", tone: "success" },
  cancelled: { label: "Cancelled", tone: "inactive" },
};

// How long a new quotation holds its prices unless the person changes it.
export const DEFAULT_VALID_DAYS = 7;
export const MAX_VALID_DAYS = 180;

export const addDays = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

// "Valid 3 more days", "Valid today only", "Expired 2 days ago".
export function validityWords(validUntil, today) {
  const left = daysBetween(today, validUntil);
  if (left < 0) return `Expired ${-left === 1 ? "yesterday" : `${-left} days ago`}`;
  if (left === 0) return "Valid today only";
  return `Valid ${left === 1 ? "1 more day" : `${left} more days`}`;
}

// Units a line may be typed in, as on New sale: the item's stock unit, its
// pack sizes ("Coil of 25") and units of the same kind (g for a kg item).
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

// How much of a quotation line, in its stock unit, as it was quoted: its pack
// ("6 coil" for 150 m in coils of 25) when it was quoted in packs, a kit in kits.
export const quotedUnits = (line, stockQuantity) => {
  const factor = line.entered_unit && !line.kit_parts ? Number(line.unit_factor) : 1;
  return { quantity: Math.round((Number(stockQuantity) / factor) * 1000) / 1000, unit: line.entered_unit && !line.kit_parts ? line.entered_unit : line.unit };
};

// A line as typed: the item, the unit it is typed in and how many.
let seq = 0;
export const emptyLine = (extra = {}) => ({ key: `q${(seq += 1)}`, skuId: "", unit: "", quantity: "1", ...extra });
