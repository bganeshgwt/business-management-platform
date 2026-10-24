import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort } from "@bmp/shared/format";
import { barcodeSvg } from "../../retail/services/barcode";
import { COST_BEARERS, EYES, REMAKE_REASONS, lensWords, power, rowOf, wordOf, zonesOf } from "./optical";

// Printing for an optical shop: a prescription for the customer, the job
// card for the lab or the workshop (A5 or A4, with the prescription and the
// fitting, never the prices), and the customer's slip with the promised day,
// the price, the advance paid and what is left to pay.

const fmt = (value) => escapeHtml(dateShort(value, { year: true }));
const BASE = "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} h2{font-size:14px;margin:10px 0 4px} small{color:#555}"
  + " .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px} .bc{width:190px;height:44px} .bc svg{width:100%;height:100%}"
  + " dl{display:grid;grid-template-columns:120px 1fr;gap:3px 12px;margin:6px 0} dt{color:#555}"
  + " table{width:100%;border-collapse:collapse;margin-top:6px} td,th{border:1px solid #bbb;padding:4px 6px;text-align:left} th{background:#f2f2f2} .r{text-align:right}"
  + " .sign{display:flex;justify-content:space-between;gap:24px;margin-top:30px} .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}";

function shopHead(biz, seller, title, code) {
  const s = seller || biz.settings || {};
  let bars = "";
  try { bars = code ? barcodeSvg(code).svg : ""; } catch { bars = ""; }
  return `<div class="head"><div><h1>${escapeHtml(s.legal_name || s.display_name || biz.business.name)}</h1>
    <small>${escapeHtml([s.address_line1, s.address_line2, s.city, s.postal_code].filter(Boolean).join(", "))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ""}</small>
    <h2>${escapeHtml(title)}</h2></div>${bars ? `<div class="bc">${bars}</div>` : ""}</div>`;
}

// The powers as a table: a row per eye and vision.
function rxHtml(rows) {
  const zones = zonesOf(rows);
  const body = EYES.flatMap((eye) => zones.map((zone, index) => {
    const r = rowOf(rows, eye.value, zone.value);
    const prism = r?.prism ? `${Number(r.prism)} ${r.prism_base || ""}` : "";
    return `<tr>${index === 0 ? `<th rowspan="${zones.length}">${eye.short}</th>` : ""}<td>${zone.label}</td><td>${r ? power(r.sph) : ""}</td><td>${r ? power(r.cyl) : ""}</td>
      <td>${r?.axis ?? ""}</td><td>${r ? power(r.add) : ""}</td><td>${escapeHtml(prism)}</td><td>${escapeHtml(r?.acuity || "")}</td></tr>`;
  })).join("");
  return `<table><thead><tr><th>Eye</th><th>Vision</th><th>SPH</th><th>CYL</th><th>AXIS</th><th>ADD</th><th>Prism</th><th>Acuity</th></tr></thead><tbody>${body}</tbody></table>`;
}
const pd = (p) => (p.pdBinocular || p.pd_binocular ? `${Number(p.pdBinocular || p.pd_binocular)} mm (both eyes)`
  : p.pdRight || p.pd_right ? `R ${Number(p.pdRight || p.pd_right)} mm · L ${Number(p.pdLeft || p.pd_left)} mm` : "—");

// A prescription, for the customer to keep.
export function printPrescription(biz, p) {
  printDocument({
    title: `Prescription ${p.customer_name}`,
    styles: `@page{size:A5;margin:10mm} ${BASE}`,
    body: `${shopHead(biz, null, "Eye prescription")}
      <dl><dt>Name</dt><dd>${escapeHtml(p.customer_name)}${p.customer_phone ? ` · ${escapeHtml(p.customer_phone)}` : ""}</dd>
      <dt>Day of the test</dt><dd>${fmt(p.examined_on)}</dd>
      <dt>Examined by</dt><dd>${escapeHtml(p.examiner_name)}${p.registration_no ? ` · Reg. no. ${escapeHtml(p.registration_no)}` : ""}</dd></dl>
      ${rxHtml(p.rows)}
      <dl><dt>PD</dt><dd>${escapeHtml(pd(p))}</dd><dt>Valid until</dt><dd>${fmt(p.valid_until)}</dd>
      ${p.notes ? `<dt>Notes</dt><dd>${escapeHtml(p.notes)}</dd>` : ""}</dl>
      <div class="sign"><span>Signature</span><span>${escapeHtml(p.examiner_name)}</span></div>`,
  });
}

function lineRows(order) {
  return order.lines.map((l) => {
    const what = l.part === "frame" ? (l.own_frame ? `Customer's own frame: ${l.description}` : `${l.label}${l.description ? ` · ${l.description}` : ""}`)
      : l.part === "lens" ? `${lensWords(l)}${l.label ? ` (${l.label})` : ""}${l.description ? ` · ${l.description}` : ""}` : l.label;
    const part = l.part === "frame" ? "Frame" : l.part === "lens" ? `${l.eye === "right" ? "Right" : "Left"} lens` : "Item";
    return { part, what, line: l };
  });
}

// The job card for the lab or the workshop: everything needed to make the
// spectacles, never the prices.
export function printJobCard(biz, order, size = "A5") {
  const rx = order.rx || {};
  const rows = lineRows(order).map((r) => `<tr><td>${escapeHtml(r.part)}</td><td>${escapeHtml(r.what)}</td></tr>`).join("");
  printDocument({
    title: order.order_no,
    styles: `@page{size:${size === "A4" ? "A4" : "A5"};margin:10mm} ${BASE}`,
    body: `${shopHead(biz, order.seller, `Spectacle job card ${order.order_no}`, order.order_no)}
      <dl><dt>Booked</dt><dd>${fmt(order.created_at)}</dd><dt>Promised for</dt><dd><strong>${fmt(order.promised_on)}</strong></dd>
      <dt>Customer</dt><dd>${escapeHtml(order.customer_name)}${order.customer_phone ? ` · ${escapeHtml(order.customer_phone)}` : ""}</dd>
      <dt>Made</dt><dd>${order.made_at === "lab" ? `At ${escapeHtml(order.lab_name)}${order.lab_order_no ? ` · lab order ${escapeHtml(order.lab_order_no)}` : ""}` : "In our workshop"}</dd>
      ${order.remake_of_no ? `<dt>Remake of</dt><dd>${escapeHtml(order.remake_of_no)} · ${escapeHtml(wordOf(REMAKE_REASONS, order.remake_reason))} · cost borne by ${escapeHtml(wordOf(COST_BEARERS, order.remake_cost_by).toLowerCase())}</dd>` : ""}</dl>
      <h2>Prescription</h2>
      <small>Tested ${fmt(rx.examinedOn)} by ${escapeHtml(rx.examinerName || "")}${rx.registrationNo ? ` (Reg. no. ${escapeHtml(rx.registrationNo)})` : ""} · PD ${escapeHtml(pd(rx))}</small>
      ${rxHtml(rx.rows || [])}
      <h2>Fitting</h2>
      <table><thead><tr><th></th><th>Right eye</th><th>Left eye</th></tr></thead><tbody>
        <tr><th>Fitting PD</th><td>${order.pd_right ? `${Number(order.pd_right)} mm` : ""}</td><td>${order.pd_left ? `${Number(order.pd_left)} mm` : ""}</td></tr>
        <tr><th>Fitting height</th><td>${order.fitting_height_right ? `${Number(order.fitting_height_right)} mm` : ""}</td><td>${order.fitting_height_left ? `${Number(order.fitting_height_left)} mm` : ""}</td></tr>
      </tbody></table>
      <h2>Frame and lenses</h2>
      <table><tbody>${rows}</tbody></table>
      ${order.notes ? `<p><strong>Notes:</strong> ${escapeHtml(order.notes)}</p>` : ""}
      <div class="sign"><span>Made by</span><span>Quality check passed by</span></div>`,
  });
}

// The customer's slip: the order, the promised day, the price, the advance and what is left to pay.
export function printCustomerSlip(biz, order) {
  const money = order.money !== false;
  const priced = lineRows(order).filter((r) => r.line.sku_id);
  const rows = priced.map((r) => `<tr><td>${escapeHtml(r.part)}</td><td>${escapeHtml(r.what)}</td>${money ? `<td class="r">${escapeHtml(biz.exact(Number(r.line.net) + Number(r.line.tax)))}</td>` : ""}</tr>`).join("");
  const advance = order.advance ? Number(order.advance.amount) : 0;
  printDocument({
    title: `${order.order_no} slip`,
    styles: `@page{size:A5;margin:10mm} ${BASE}`,
    body: `${shopHead(biz, order.seller, `Spectacle order ${order.order_no}`, order.order_no)}
      <dl><dt>Customer</dt><dd>${escapeHtml(order.customer_name)}${order.customer_phone ? ` · ${escapeHtml(order.customer_phone)}` : ""}</dd>
      <dt>Booked</dt><dd>${fmt(order.created_at)}</dd><dt>Ready by</dt><dd><strong>${fmt(order.promised_on)}</strong></dd></dl>
      ${rows ? `<table><thead><tr><th></th><th>Item</th>${money ? '<th class="r">Amount</th>' : ""}</tr></thead><tbody>${rows}</tbody></table>` : ""}
      ${money ? `<dl><dt>Total</dt><dd><strong>${escapeHtml(biz.exact(order.total))}</strong> including GST</dd>
        ${order.advance ? `<dt>Advance paid</dt><dd>${escapeHtml(biz.exact(advance))} (${escapeHtml(order.advance.collection_no)})</dd>` : ""}
        <dt>To pay on collection</dt><dd><strong>${escapeHtml(biz.exact(Math.max(0, Number(order.total) - advance)))}</strong></dd></dl>` : ""}
      <p><small>Please bring this slip when you collect your spectacles. This slip is not a tax invoice: the bill is made when you collect them.</small></p>`,
  });
}
