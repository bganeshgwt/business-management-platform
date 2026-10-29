import { dateShort } from "@bmp/shared/format";
import { whatsappLink } from "../../retail/pages/retail";

// Optical shops: the words, power formats and messages the prescription,
// spectacle order and recall screens share. The server checks every power
// and step again (optical/services); these only show and prepare them.

// An optical shop with its tools on.
export const usesOptical = (biz) => biz.type === "optical" && biz.has("optical");

export const EYES = [{ value: "right", label: "Right eye", short: "R" }, { value: "left", label: "Left eye", short: "L" }];
export const ZONES = [{ value: "distance", label: "Distance" }, { value: "intermediate", label: "Intermediate" }, { value: "near", label: "Near" }];
// A horizontal prism's base (in or out) and a vertical one's (up or down), each its own prism.
export const PRISM_BASES = [{ value: "in", label: "Base in" }, { value: "out", label: "Base out" }];
export const VERTICAL_BASES = [{ value: "up", label: "Base up" }, { value: "down", label: "Base down" }];
export const LENS_TYPES = [{ value: "single_vision", label: "Single vision" }, { value: "bifocal", label: "Bifocal" }, { value: "progressive", label: "Progressive" }];
export const MATERIALS = [{ value: "cr39", label: "CR-39 (plastic)" }, { value: "polycarbonate", label: "Polycarbonate" }, { value: "trivex", label: "Trivex" },
  { value: "glass", label: "Glass" }, { value: "other", label: "Other" }];
export const COATINGS = [{ value: "anti_reflective", label: "Anti-reflective" }, { value: "blue_cut", label: "Blue cut" }, { value: "uv", label: "UV" },
  { value: "photochromic", label: "Photochromic" }, { value: "scratch_resistant", label: "Scratch-resistant" }];
export const REMAKE_REASONS = [{ value: "power_change", label: "Power changed" }, { value: "non_adaptation", label: "Could not get used to them" },
  { value: "measurement", label: "Measurement or fitting error" }, { value: "lab_defect", label: "Lab defect" }, { value: "breakage", label: "Breakage" },
  { value: "coating", label: "Coating peeled" }, { value: "other", label: "Other" }];
export const COST_BEARERS = [{ value: "lab", label: "The lab" }, { value: "shop", label: "The shop" }, { value: "customer", label: "The customer" }];
// A prescription for spectacles, or for contact lenses.
export const KINDS = [{ value: "spectacles", label: "Spectacles" }, { value: "contact_lens", label: "Contact lenses" }];
// How often a contact lens is replaced, and in how many days (as the server counts them).
export const MODALITIES = [{ value: "daily", label: "Daily", days: 1 }, { value: "fortnightly", label: "Fortnightly", days: 14 }, { value: "monthly", label: "Monthly", days: 30 },
  { value: "quarterly", label: "Every three months", days: 90 }, { value: "half_yearly", label: "Every six months", days: 180 }, { value: "yearly", label: "Yearly", days: 365 }];
// The workshop's steps, in order, before the quality check.
export const WORKSHOP_STEPS = [{ value: "cutting", label: "Cutting" }, { value: "edging", label: "Edging" }, { value: "fitting", label: "Fitting" }];
// The groups a customer's recall months may come from.
export const RECALL_GROUPS = [{ key: "child", label: "Child" }, { key: "lens_wearer", label: "Contact lenses" }, { key: "progressive", label: "Progressive" }];
export const STATUSES = {
  booked: { label: "Booked", tone: "info" }, at_lab: { label: "At the lab", tone: "warning" }, in_workshop: { label: "In the workshop", tone: "info" },
  quality_check: { label: "Quality check", tone: "warning" }, ready: { label: "Ready to collect", tone: "success" }, delivered: { label: "Delivered", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
// The words of each next step, as its button says it.
export const STEP_WORDS = { at_lab: "Send to the lab", in_workshop: "Into the workshop", quality_check: "Ready for the quality check", ready: "Passed the quality check" };
export const wordOf = (list, value) => list.find((x) => x.value === value)?.label || "";
// The same day so many months on (the month's last day when it has fewer days), as the server works it out.
export function addMonths(day, months) {
  const [y, m, d] = String(day).slice(0, 10).split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  target.setUTCDate(Math.min(d, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
  return target.toISOString().slice(0, 10);
}
export const OPEN = ["booked", "at_lab", "in_workshop", "quality_check", "ready"];

// A power as written on a prescription: +1.50, -2.25, 0.00.
export const power = (value) => {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
};
// The rows of a prescription by eye and vision.
export const rowOf = (rows, eye, zone) => (rows || []).find((r) => r.eye === eye && r.zone === zone) || null;
// The zones a prescription has rows for (distance always shown first).
export const zonesOf = (rows) => ZONES.filter((z) => z.value === "distance" || (rows || []).some((r) => r.zone === z.value));
// "R -2.25 / -0.75 × 180 · L -2.00 · ADD +1.50": one line for a list.
export function rxSummary(rows) {
  const eye = (side) => {
    const d = rowOf(rows, side, "distance");
    const n = rowOf(rows, side, "near") || rowOf(rows, side, "intermediate");
    const parts = [];
    if (d && d.sph !== null && d.sph !== undefined) parts.push(`${power(d.sph)}${d.cyl !== null && d.cyl !== undefined && Number(d.cyl) !== 0 ? ` / ${power(d.cyl)} × ${d.axis}` : ""}`);
    if (n && n.add !== null && n.add !== undefined) parts.push(`ADD ${power(n.add)}`);
    return parts.length ? `${side === "right" ? "R" : "L"} ${parts.join(" ")}` : "";
  };
  return [eye("right"), eye("left")].filter(Boolean).join(" · ");
}
// A contact-lens prescription in one line: "R -2.00 BC 8.4 DIA 14 · L -2.25 / -0.75 × 180 BC 8.6 DIA 14.5".
export function lensSummary(lenses) {
  return (lenses || []).map((l) => `${l.eye === "right" ? "R" : "L"} ${power(l.power)}${l.cyl !== null && l.cyl !== undefined ? ` / ${power(l.cyl)} × ${l.axis}` : ""}`
    + `${l.add !== null && l.add !== undefined ? ` ADD ${power(l.add)}` : ""} BC ${Number(l.base_curve)} DIA ${Number(l.diameter)}${l.colour ? ` ${l.colour}` : ""}`).join(" · ");
}
// A prescription's powers in one line, whichever kind it is.
export const powersSummary = (p) => (p?.kind === "contact_lens" ? lensSummary(p.lenses) : rxSummary(p?.rows));
// A prism as written: "1 in", "0.5 down"; a row may have both.
export const prismText = (r) => [r?.prism ? `${Number(r.prism)} ${r.prism_base || r.prismBase || ""}`.trim() : "",
  r?.prism_vertical ? `${Number(r.prism_vertical)} ${r.prism_vertical_base || ""}`.trim() : ""].filter(Boolean).join(", ");
// The PD as written: "63" both eyes, or "31.5 / 31" each eye.
export const pdText = (p) => (p?.pd_binocular ? `${Number(p.pd_binocular)}` : p?.pd_right ? `${Number(p.pd_right)} / ${Number(p.pd_left)}` : "");

// The prescription editor's value: { "right:distance": { sph, cyl, axis, add, prism, prismBase, acuity }, … },
// from a prescription's rows, and the rows it sends (every row, empty ones too: the server leaves those out).
const emptyRow = () => ({ sph: "", cyl: "", axis: "", add: "", prism: "", prismBase: "", prismVertical: "", prismVerticalBase: "", acuity: "" });
const text = (value, format) => (value === null || value === undefined ? "" : format(value));
export function editorValue(rows) {
  const value = {};
  for (const eye of EYES) for (const zone of ZONES) {
    const r = rowOf(rows, eye.value, zone.value);
    value[`${eye.value}:${zone.value}`] = r ? {
      sph: text(r.sph, power), cyl: text(r.cyl, power), axis: text(r.axis, String), add: text(r.add, power),
      prism: text(r.prism, (x) => String(Number(x))), prismBase: r.prism_base || "", prismVertical: text(r.prism_vertical, (x) => String(Number(x))),
      prismVerticalBase: r.prism_vertical_base || "", acuity: r.acuity || "",
    } : emptyRow();
  }
  return value;
}
export const editorRows = (value) => Object.entries(value).map(([key, r]) => {
  const [eye, zone] = key.split(":");
  return { eye, zone, sph: r.sph, cyl: r.cyl, axis: r.axis, add: zone === "distance" ? "" : r.add, prism: r.prism, prismBase: r.prism ? r.prismBase : "",
    prismVertical: r.prismVertical, prismVerticalBase: r.prismVertical ? r.prismVerticalBase : "", acuity: r.acuity };
});

// The contact-lens editor's value: { right: { baseCurve, diameter, power, cyl, axis, add, colour, brand, modality, wearingSchedule }, left: … },
// from a prescription's lenses, and the lenses it sends (an eye left empty is skipped by the server).
const emptyLens = () => ({ baseCurve: "", diameter: "", power: "", cyl: "", axis: "", add: "", colour: "", brand: "", modality: "", wearingSchedule: "" });
export function lensEditorValue(lenses) {
  const value = {};
  for (const eye of EYES) {
    const l = (lenses || []).find((x) => x.eye === eye.value);
    value[eye.value] = l ? {
      baseCurve: String(Number(l.base_curve)), diameter: String(Number(l.diameter)), power: text(l.power, power), cyl: text(l.cyl, power), axis: text(l.axis, String),
      add: text(l.add, power), colour: l.colour || "", brand: l.brand || "", modality: l.modality || "", wearingSchedule: l.wearing_schedule || "",
    } : emptyLens();
  }
  return value;
}
export const lensEditorRows = (value) => EYES.map((eye) => ({ eye: eye.value, ...value[eye.value] }));

// A lens item's own details (index, material, coatings, design, tint), as an order picks them.
export const lensDetailsOf = (sku) => {
  const a = sku?.attributes || {};
  return { lensType: a.lensDesign || "", index: a.lensIndex || "", material: a.lensMaterial || "", coatings: Array.isArray(a.coatings) ? a.coatings : [], tint: a.tint || "" };
};
// An item keeps details of a spectacle lens or a contact lens.
export const isContactLensItem = (sku) => Boolean(sku?.attributes?.baseCurve);
// The item form's spectacle lens details from an item, and the attributes it
// sends (empty ones clear a detail on an item changed).
const LENS_ITEM_KEYS = ["lensDesign", "lensIndex", "lensMaterial", "coatings", "tint"];
export const lensItemForm = (sku) => {
  const a = sku?.attributes || {};
  return { on: Boolean(a.lensDesign || a.lensIndex || a.lensMaterial || a.coatings || a.tint), lensDesign: a.lensDesign || "", lensIndex: a.lensIndex || "",
    lensMaterial: a.lensMaterial || "", coatings: Array.isArray(a.coatings) ? a.coatings : [], tint: a.tint || "" };
};
export function lensItemAttributes(value, { editing = false, was = null } = {}) {
  if (!value.on) return editing && was?.on ? Object.fromEntries(LENS_ITEM_KEYS.map((key) => [key, ""])) : {};
  const out = { lensDesign: value.lensDesign, lensIndex: value.lensIndex, lensMaterial: value.lensMaterial, coatings: value.coatings, tint: value.tint };
  return editing ? out : Object.fromEntries(Object.entries(out).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
}

// Plus and minus cylinder are the same prescription: add the CYL to the SPH,
// change the CYL's sign and turn the AXIS by 90°.
export function transpose(row) {
  const sph = Number(row.sph || 0), cyl = Number(row.cyl);
  if (!row.cyl || !Number.isFinite(cyl) || cyl === 0 || !row.axis) return row;
  const axis = ((Number(row.axis) + 90 - 1) % 180) + 1;
  return { ...row, sph: power(sph + cyl), cyl: power(-cyl), axis: String(axis) };
}

// The order's line of a lens, in words: "Progressive · 1.60 · Polycarbonate · Anti-reflective · Essilor Varilux".
export function lensWords(line) {
  return [wordOf(LENS_TYPES, line.lens_type), line.lens_index ? Number(line.lens_index).toFixed(2) : null, wordOf(MATERIALS, line.material) || null,
    ...(line.coatings || []).map((c) => wordOf(COATINGS, c)), line.tint ? `tint ${line.tint}` : null, line.brand].filter(Boolean).join(" · ");
}
// The frame's size as written on a job card: "52 □ 18 · B 38".
export const frameSizeText = (o) => (o?.frame_a || o?.frame_dbl ? `${o.frame_a ? Number(o.frame_a) : "—"} □ ${o.frame_dbl ? Number(o.frame_dbl) : "—"}${o.frame_b ? ` · B ${Number(o.frame_b)}` : ""}` : "");

// The contact-lens power grid on the item form (with Variants on): the base
// curve, the diameter and up to four ranges of powers, each power becoming an
// item of the one lens product.
export const emptyGrid = () => ({ on: false, baseCurve: "", diameter: "", ranges: [{ from: "-0.50", to: "-6.00", step: "0.25" }],
  modality: "", lensesPerPack: "", toric: false, cylinders: "", axes: "", adds: "", colours: "" });
// A list typed with commas or spaces: "-0.75, -1.25" → ["-0.75", "-1.25"].
export const listOf = (text) => String(text || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
// A list of names typed with commas: "Blue, Grey" → ["Blue", "Grey"].
export const namesOf = (text) => String(text || "").split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
// How many powers the ranges make (each power once), as the server counts them.
export function gridCount(ranges, grid = {}) {
  const powers = new Set();
  for (const r of ranges || []) {
    const from = Math.round(Number(r.from) * 100), to = Math.round(Number(r.to) * 100), step = Math.round(Number(r.step) * 100);
    if (!Number.isFinite(from) || !Number.isFinite(to) || r.from === "" || r.to === "" || !step) continue;
    for (let p = Math.min(from, to); p <= Math.max(from, to) && powers.size <= 3000; p += step) powers.add(p);
  }
  // Each power with each CYL and AXIS (a toric), ADD (a multifocal) and colour.
  const times = (list) => Math.max(1, list.length);
  return powers.size * (grid.toric ? times(listOf(grid.cylinders)) * times(listOf(grid.axes)) : 1) * times(listOf(grid.adds)) * times(namesOf(grid.colours));
}
// The power grid's request from the item form: a new lens product, or more powers for one chosen.
export function gridBody(form, taxRateId) {
  return {
    ...(form.productId ? { productId: form.productId } : {
      name: form.name, brand: form.brand || undefined, categoryId: form.categoryId || undefined, unit: form.unit, tracking: form.tracking,
      taxRateId: taxRateId || undefined, hsnCode: form.hsnCode || undefined, reorderLevel: form.reorderLevel || 0, codePrefix: form.code || undefined,
    }),
    price: form.price, mrp: form.mrp || undefined, baseCurve: form.lensGrid.baseCurve, diameter: form.lensGrid.diameter,
    ranges: form.lensGrid.ranges.filter((r) => r.from !== "" && r.to !== ""),
    ...(form.lensGrid.toric ? { cylinders: listOf(form.lensGrid.cylinders), axes: listOf(form.lensGrid.axes) } : {}),
    ...(listOf(form.lensGrid.adds).length ? { adds: listOf(form.lensGrid.adds) } : {}), ...(namesOf(form.lensGrid.colours).length ? { colours: namesOf(form.lensGrid.colours) } : {}),
    ...(form.productId ? {} : { modality: form.lensGrid.modality || undefined, lensesPerPack: form.lensGrid.lensesPerPack || undefined }),
  };
}

// The prepared WhatsApp messages: a recall reminder, and an order's stage.
export function recallMessage(biz, customer) {
  const shop = biz.settings.display_name || biz.business.name;
  const since = customer.examined_on ? ` since your last eye test on ${dateShort(customer.examined_on, { year: true })}` : "";
  return `Namaste ${customer.name}, it has been a while${since}. Eyes change over time: please visit us for an eye test.${biz.settings.phone ? ` Call ${biz.settings.phone} to book a time.` : ""}\n— ${shop}`;
}
export const recallLink = (biz, customer) => whatsappLink(customer.phone, recallMessage(biz, customer));
// Contact lenses running out: the reminder to buy the next pack.
export function lensDueMessage(biz, row) {
  const shop = biz.settings.display_name || biz.business.name;
  return `Namaste ${row.name}, the contact lenses you bought on ${dateShort(row.sold_on, { year: true })} will run out around ${dateShort(row.due_on, { year: true })}. `
    + `Please visit us for your next pack${biz.settings.phone ? `, or call ${biz.settings.phone}` : ""}.\n— ${shop}`;
}
export const lensDueLink = (biz, row) => whatsappLink(row.phone, lensDueMessage(biz, row));

export function orderMessage(biz, order, stage) {
  const shop = biz.settings.display_name || biz.business.name;
  const due = order.bill && Number(order.bill.due) > 0 ? ` Amount to pay: ${biz.exact(order.bill.due)}.` : "";
  const lines = {
    booked: `Namaste ${order.customer_name}, your spectacles are booked (order ${order.order_no}). They will be ready by ${dateShort(order.promised_on, { year: true })}.`,
    ready: `Namaste ${order.customer_name}, your spectacles are ready to collect (order ${order.order_no}).${due} Please bring the order slip.`,
    delayed: `Namaste ${order.customer_name}, your spectacles (order ${order.order_no}) need a little more time. Sorry for the wait; we will message you when they are ready.`,
    reminder: `Namaste ${order.customer_name}, your spectacles (order ${order.order_no}) are ready and waiting for you.${due}`,
  };
  return `${lines[stage] || lines.booked}${biz.settings.phone ? ` Call us on ${biz.settings.phone}.` : ""}\n— ${shop}`;
}
export const MESSAGE_STAGES = [{ value: "booked", label: "Order booked" }, { value: "ready", label: "Ready to collect" }, { value: "delayed", label: "Running late" },
  { value: "reminder", label: "Collect reminder" }];
// The stage that fits the order's status (the button offered first).
export const stageFor = (status) => (status === "ready" ? "ready" : "booked");
