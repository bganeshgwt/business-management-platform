import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort, dateTime } from "@bmp/shared/format";
import { barcodeSvg } from "../../retail/services/barcode";
import { LIEN_NOTE, defectWords, offWords, quantityWords } from "./laundry";
import { privacyLine } from "../../../personal-data/printLine";

// Printing for a laundry: the order receipt for the customer (every garment
// with its tag, what was noted about it at intake and what the customer
// acknowledged, the photos taken as a count, the prices when the person sees
// money with what a package, an offer or a discount took off, the shop's
// terms and the hold until paid, with a line for the customer to sign or a
// note that they signed on the screen), and the tag
// labels: one for every piece, with its tag number as a barcode, on a label
// roll or an A4 sheet.

const fmt = (value) => escapeHtml(dateShort(value, { year: true }));
const bars = (code, height = 40) => { try { return barcodeSvg(code, { height }).svg; } catch { return ""; } };
const BASE = "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} h2{font-size:14px;margin:10px 0 4px} small{color:#555}"
  + " .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px} .bc{width:190px;height:44px} .bc svg{width:100%;height:100%}"
  + " dl{display:grid;grid-template-columns:120px 1fr;gap:3px 12px;margin:6px 0} dt{color:#555}"
  + " table{width:100%;border-collapse:collapse;margin-top:6px} td,th{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top} th{background:#f2f2f2} .r{text-align:right}"
  + " .note{font-size:11px;color:#333;margin:6px 0} .terms{white-space:pre-wrap;font-size:11px;border:1px solid #bbb;padding:6px;margin-top:8px}"
  + " .sign{display:flex;justify-content:space-between;gap:24px;margin-top:30px} .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}";

function shopHead(biz, seller, title, code) {
  const s = seller || biz.settings || {};
  const svg = code ? bars(code) : "";
  return `<div class="head"><div><h1>${escapeHtml(s.legal_name || s.display_name || biz.business.name)}</h1>
    <small>${escapeHtml([s.address_line1, s.address_line2, s.city, s.postal_code].filter(Boolean).join(", "))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ""}</small>
    <h2>${escapeHtml(title)}</h2></div>${svg ? `<div class="bc">${svg}</div>` : ""}</div>`;
}

// What was noted about a garment at intake, with the customer's acknowledgement.
function notedHtml(item) {
  const parts = [defectWords(item), item.risk_note ? `Risk explained: ${item.risk_note}` : null, item.instructions ? `Asked: ${item.instructions}` : null].filter(Boolean);
  if (!parts.length) return "";
  return `${parts.map(escapeHtml).join("<br>")}${item.acknowledged ? "<br><strong>Acknowledged by the customer</strong>" : ""}`;
}

// The order receipt: the customer keeps it to collect their garments.
export function printOrderReceipt(biz, order) {
  const money = order.money !== false;
  const items = order.items.filter((i) => i.status !== "cancelled");
  const rows = items.map((i) => `<tr><td><strong>${escapeHtml(i.tag_no)}</strong></td><td>${escapeHtml(i.garment_name)}${[i.colour, i.brand].some(Boolean) ? `<br><small>${escapeHtml([i.colour, i.brand].filter(Boolean).join(" · "))}</small>` : ""}</td>
    <td>${escapeHtml(i.service_name)}</td><td>${escapeHtml(quantityWords(i))}</td><td>${notedHtml(i)}${i.declared_value ? `<br><small>Value declared: ${escapeHtml(biz.exact(i.declared_value))}</small>` : ""}</td>
    ${money ? `<td class="r">${escapeHtml(biz.exact(Number(i.net) + Number(i.tax)))}${offWords(biz.exact, i) ? `<br><small>${escapeHtml(offWords(biz.exact, i))}</small>` : ""}</td>` : ""}</tr>`).join("");
  const pieces = items.reduce((s, i) => s + Number(i.pieces), 0);
  const photos = (order.files || []).filter((f) => f.kind === "photo").length;
  const noted = items.some((i) => notedHtml(i));
  const paid = money && order.bills.length ? Number(order.paid) : 0;
  const advance = money && order.advance ? Number(order.advance.amount) : 0;
  const toPay = money ? Math.max(0, Number(order.due) + Number(order.bill?.due || 0)) : 0;
  printDocument({
    title: `${order.order_no} receipt`,
    styles: `@page{size:A5;margin:10mm} ${BASE}`,
    body: `${shopHead(biz, order.seller, `Garment order ${order.order_no}`, order.order_no)}
      <dl><dt>Customer</dt><dd>${escapeHtml(order.customer_name)}${order.customer_phone ? ` · ${escapeHtml(order.customer_phone)}` : ""}</dd>
      <dt>Taken in</dt><dd>${escapeHtml(dateTime(order.created_at))}</dd>
      <dt>Ready by</dt><dd><strong>${fmt(order.promised_on)}</strong>${order.express ? " · <strong>EXPRESS</strong>" : ""}</dd>
      <dt>Garments</dt><dd>${items.length} (${pieces} ${pieces === 1 ? "piece" : "pieces"})</dd>
      ${photos ? `<dt>Photos</dt><dd>${photos} ${photos === 1 ? "photo" : "photos"} kept with the order</dd>` : ""}</dl>
      <table><thead><tr><th>Tag</th><th>Garment</th><th>Service</th><th>How many</th><th>Noted at intake</th>${money ? '<th class="r">Amount</th>' : ""}</tr></thead><tbody>${rows}</tbody></table>
      ${money ? `<dl><dt>Total</dt><dd><strong>${escapeHtml(biz.exact(order.total))}</strong> including GST</dd>
        ${order.bills.length ? `<dt>Paid</dt><dd>${escapeHtml(biz.exact(paid))}</dd>` : advance ? `<dt>Advance paid</dt><dd>${escapeHtml(biz.exact(advance))} (${escapeHtml(order.advance.collection_no)})</dd>` : ""}
        <dt>To pay on collection</dt><dd><strong>${escapeHtml(biz.exact(toPay))}</strong></dd></dl>` : ""}
      <p class="note">${escapeHtml(LIEN_NOTE)} Please bring this receipt when you collect your garments.${order.bill_at === "delivery" ? " The bill is made when you collect them." : ""}</p>
      ${order.terms ? `<div class="terms">${escapeHtml(order.terms)}</div>` : ""}
      ${privacyLine(biz) ? `<p class="note">${escapeHtml(privacyLine(biz))}</p>` : ""}
      <div class="sign"><span>${order.signed ? "Signed by the customer on the screen at intake" : noted ? "Customer: I have seen what is noted above about my garments" : "Customer"}</span><span>For ${escapeHtml(biz.settings.display_name || biz.business.name)}</span></div>`,
  });
}

// Tag label layouts: a label roll (one label a page) or an A4 sheet.
export const TAG_LAYOUTS = {
  roll: { label: "Label roll · 50 × 25 mm", width: 50, height: 25 },
  a40: { label: "A4 · 40 per sheet (4 × 10, 48.5 × 25.4 mm)", columns: 4, rows: 10, width: 48.5, height: 25.4, top: 21.5, left: 8 },
};

// Labels for these garments: one for every piece, each with the tag as a barcode.
export function printTags(biz, order, items, layout = "roll") {
  const shape = TAG_LAYOUTS[layout] || TAG_LAYOUTS.roll;
  const shop = biz.settings.display_name || biz.business.name;
  const cells = [];
  for (const item of items) {
    const pieces = Math.max(1, Number(item.pieces));
    for (let n = 1; n <= pieces; n += 1) {
      cells.push(`<div class="lbl"><div class="top"><span>${escapeHtml(shop)}</span>${order.express ? "<b>EXPRESS</b>" : ""}</div>
        <div class="mid"><div class="tag">${escapeHtml(item.tag_no)}</div><div class="bc">${bars(item.tag_no, 30)}</div></div>
        <div class="foot"><span>${escapeHtml(order.order_no)} · ${escapeHtml(order.customer_name)}</span><span>${pieces > 1 ? `${n}/${pieces} · ` : ""}${fmt(order.promised_on)}</span></div>
        <div class="svc">${escapeHtml(item.service_name)} · ${escapeHtml(item.garment_name)}</div></div>`);
    }
  }
  const label = ".lbl{box-sizing:border-box;width:100%;height:100%;padding:1.2mm 1.8mm;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;font:6.5pt system-ui;color:#000}"
    + " .top{display:flex;justify-content:space-between;gap:2mm;white-space:nowrap;overflow:hidden} .top b{font-weight:800}"
    + " .mid{display:flex;align-items:center;gap:1.5mm;min-height:0;flex:1} .tag{font:800 15pt ui-monospace,Consolas,monospace;line-height:1} .bc{flex:1;min-width:0;height:8mm} .bc svg{width:100%;height:100%}"
    + " .foot{display:flex;justify-content:space-between;gap:1.5mm;white-space:nowrap;overflow:hidden} .svc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}";
  if (layout === "a40") {
    const per = shape.columns * shape.rows;
    const pages = [];
    for (let i = 0; i < cells.length; i += per) pages.push(`<div class="sheet">${cells.slice(i, i + per).join("")}</div>`);
    printDocument({
      title: `${order.order_no} tags`,
      styles: `@page{size:A4;margin:0} body{margin:0} .sheet{width:210mm;height:296mm;box-sizing:border-box;padding:${shape.top}mm 0 0 ${shape.left}mm;display:grid;
        grid-template-columns:repeat(${shape.columns},${shape.width}mm);grid-auto-rows:${shape.height}mm;page-break-after:always;overflow:hidden} ${label}`,
      body: pages.join(""),
    });
    return;
  }
  printDocument({
    title: `${order.order_no} tags`,
    styles: `@page{size:${shape.width}mm ${shape.height}mm;margin:0} body{margin:0} .page{width:${shape.width}mm;height:${shape.height}mm;page-break-after:always;overflow:hidden} ${label}`,
    body: cells.map((cell) => `<div class="page">${cell}</div>`).join(""),
  });
}
