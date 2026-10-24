import { dateShort } from "@bmp/shared/format";
import { whatsappLink } from "../../retail/pages/retail";

// Optical shops: the words, power formats and messages the prescription,
// spectacle order and recall screens share. The server checks every power
// and step again (optical/services); these only show and prepare them.

// An optical shop with its tools on.
export const usesOptical = (biz) => biz.type === "optical" && biz.has("optical");

export const EYES = [{ value: "right", label: "Right eye", short: "R" }, { value: "left", label: "Left eye", short: "L" }];
export const ZONES = [{ value: "distance", label: "Distance" }, { value: "intermediate", label: "Intermediate" }, { value: "near", label: "Near" }];
export const PRISM_BASES = [{ value: "in", label: "Base in" }, { value: "out", label: "Base out" }, { value: "up", label: "Base up" }, { value: "down", label: "Base down" }];
export const LENS_TYPES = [{ value: "single_vision", label: "Single vision" }, { value: "bifocal", label: "Bifocal" }, { value: "progressive", label: "Progressive" }];
export const MATERIALS = [{ value: "cr39", label: "CR-39 (plastic)" }, { value: "polycarbonate", label: "Polycarbonate" }, { value: "trivex", label: "Trivex" },
  { value: "glass", label: "Glass" }, { value: "other", label: "Other" }];
export const COATINGS = [{ value: "anti_reflective", label: "Anti-reflective" }, { value: "blue_cut", label: "Blue cut" }, { value: "uv", label: "UV" },
  { value: "photochromic", label: "Photochromic" }, { value: "scratch_resistant", label: "Scratch-resistant" }];
export const REMAKE_REASONS = [{ value: "power_change", label: "Power changed" }, { value: "non_adaptation", label: "Could not get used to them" },
  { value: "measurement", label: "Measurement or fitting error" }, { value: "lab_defect", label: "Lab defect" }, { value: "breakage", label: "Breakage" },
  { value: "coating", label: "Coating peeled" }, { value: "other", label: "Other" }];
export const COST_BEARERS = [{ value: "lab", label: "The lab" }, { value: "shop", label: "The shop" }, { value: "customer", label: "The customer" }];
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
// The PD as written: "63" both eyes, or "31.5 / 31" each eye.
export const pdText = (p) => (p?.pd_binocular ? `${Number(p.pd_binocular)}` : p?.pd_right ? `${Number(p.pd_right)} / ${Number(p.pd_left)}` : "");

// The prescription editor's value: { "right:distance": { sph, cyl, axis, add, prism, prismBase, acuity }, … },
// from a prescription's rows, and the rows it sends (every row, empty ones too: the server leaves those out).
const emptyRow = () => ({ sph: "", cyl: "", axis: "", add: "", prism: "", prismBase: "", acuity: "" });
const text = (value, format) => (value === null || value === undefined ? "" : format(value));
export function editorValue(rows) {
  const value = {};
  for (const eye of EYES) for (const zone of ZONES) {
    const r = rowOf(rows, eye.value, zone.value);
    value[`${eye.value}:${zone.value}`] = r ? {
      sph: text(r.sph, power), cyl: text(r.cyl, power), axis: text(r.axis, String), add: text(r.add, power),
      prism: text(r.prism, (x) => String(Number(x))), prismBase: r.prism_base || "", acuity: r.acuity || "",
    } : emptyRow();
  }
  return value;
}
export const editorRows = (value) => Object.entries(value).map(([key, r]) => {
  const [eye, zone] = key.split(":");
  return { eye, zone, sph: r.sph, cyl: r.cyl, axis: r.axis, add: zone === "distance" ? "" : r.add, prism: r.prism, prismBase: r.prism ? r.prismBase : "", acuity: r.acuity };
});

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

// The contact-lens power grid on the item form (with Variants on): the base
// curve, the diameter and up to four ranges of powers, each power becoming an
// item of the one lens product.
export const emptyGrid = () => ({ on: false, baseCurve: "", diameter: "", ranges: [{ from: "-0.50", to: "-6.00", step: "0.25" }] });
// How many powers the ranges make (each power once), as the server counts them.
export function gridCount(ranges) {
  const powers = new Set();
  for (const r of ranges || []) {
    const from = Math.round(Number(r.from) * 100), to = Math.round(Number(r.to) * 100), step = Math.round(Number(r.step) * 100);
    if (!Number.isFinite(from) || !Number.isFinite(to) || r.from === "" || r.to === "" || !step) continue;
    for (let p = Math.min(from, to); p <= Math.max(from, to) && powers.size <= 300; p += step) powers.add(p);
  }
  return powers.size;
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
  };
}

// The prepared WhatsApp messages: a recall reminder, and an order's stage.
export function recallMessage(biz, customer) {
  const shop = biz.settings.display_name || biz.business.name;
  const since = customer.examined_on ? ` since your last eye test on ${dateShort(customer.examined_on, { year: true })}` : "";
  return `Namaste ${customer.name}, it has been a while${since}. Eyes change over time: please visit us for an eye test.${biz.settings.phone ? ` Call ${biz.settings.phone} to book a time.` : ""}\n— ${shop}`;
}
export const recallLink = (biz, customer) => whatsappLink(customer.phone, recallMessage(biz, customer));

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
