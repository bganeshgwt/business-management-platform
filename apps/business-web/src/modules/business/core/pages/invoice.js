import { escapeHtml, printDocument } from "../../../../services/print";
import { amountInWords, moneyExact } from "@bmp/shared/format";

// The one GST tax invoice every Business Admin type prints: A4 for the file
// and the buyer, 80 mm for the till. Everything on it is what was posted —
// lines, HSN, MRP, rates, discounts, GST, round-off — never recalculated;
// only the CGST / SGST halves are split here, to the paisa, so they always
// add up to the GST that was charged.
//
//   printTaxInvoice(doc, biz, { paper: "a4" | "80mm", change, udhaar })
//   doc:    GET /businesses/:id/documents/:docId (with seller, retail extras)
//   change: cash given back (till); udhaar: { earlier, thisBill, total } (till)

// GST state codes (the first two digits of a GSTIN).
export const GST_STATES = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
  "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", 10: "Bihar", 11: "Sikkim", 12: "Arunachal Pradesh", 13: "Nagaland",
  14: "Manipur", 15: "Mizoram", 16: "Tripura", 17: "Meghalaya", 18: "Assam", 19: "West Bengal", 20: "Jharkhand", 21: "Odisha",
  22: "Chhattisgarh", 23: "Madhya Pradesh", 24: "Gujarat", 26: "Dadra & Nagar Haveli and Daman & Diu", 27: "Maharashtra",
  29: "Karnataka", 30: "Goa", 31: "Lakshadweep", 32: "Kerala", 33: "Tamil Nadu", 34: "Puducherry", 35: "Andaman & Nicobar Islands",
  36: "Telangana", 37: "Andhra Pradesh", 38: "Ladakh", 97: "Other territory",
};
const stateName = (code) => (code ? `${GST_STATES[code] || "State"} (${code})` : "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// A date in the business's own format and time zone (Business settings › Prices, totals and numbering).
export function businessDate(value, format = "DD MMM YYYY", timezone = "Asia/Kolkata") {
  if (!value) return "";
  const text = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value)
    : new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(value));
  const [y, m, d] = text.split("-");
  switch (format) {
    case "DD/MM/YYYY": return `${d}/${m}/${y}`;
    case "DD-MM-YYYY": return `${d}-${m}-${y}`;
    case "YYYY-MM-DD": return text;
    default: return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  }
}

const p = (value) => Math.round(Number(value || 0) * 100);
const r = (paise) => paise / 100;
const qty = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const RATE = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
// Half of a line's GST to each of CGST and SGST; the odd paisa goes to CGST.
const halves = (taxPaise) => [taxPaise - Math.floor(taxPaise / 2), Math.floor(taxPaise / 2)];

// Everything both papers print, worked out once.
function invoiceFacts(doc) {
  const seller = doc.seller || {};
  const sale = doc.kind === "sale";
  const pos = doc.place_of_supply || (doc.contact_gstin ? String(doc.contact_gstin).slice(0, 2) : seller.state_code) || null;
  const interstate = Boolean(sale && pos && seller.state_code && pos !== seller.state_code);
  const discounts = doc.retail?.discounts || [];
  // A dispatched wholesale order: each line's trade / scheme discount off the
  // list price, and free goods.
  const trade = doc.wholesale?.lines || [];
  const lines = doc.lines.map((line, index) => {
    const tax = p(line.tax);
    const [cgst, sgst] = interstate ? [0, 0] : halves(tax);
    const extra = trade.find((t) => t.document_line_id === line.id);
    const free = Boolean(extra?.free);
    const listValue = extra && !free && Number(extra.discount_percent) > 0 && doc.tax_mode !== "inclusive" ? Math.round(Number(extra.list_unit_price) * Number(line.quantity) * 100) : 0;
    const discount = discounts.filter((d) => d.line_id === line.id).reduce((s, d) => s + p(d.amount), 0) + Math.max(0, listValue - p(line.net));
    return {
      n: index + 1, label: line.label, lot: [line.lot_code, pharmacyLine(doc, line)].filter(Boolean).join(" · "), kit: line.kit_label || "", hsn: line.hsn_code || "", mrp: line.mrp ? p(line.mrp) : null,
      quantity: line.entered_unit ? `${qty(line.entered_quantity)} ${line.entered_unit}` : `${qty(line.quantity)} ${line.unit}`,
      rate: Number(line.entered_unit_price || line.unit_price), discount, taxable: p(line.net), gstRate: Number(line.tax_rate),
      cgst, sgst, igst: interstate ? tax : 0, tax, amount: p(line.net) + tax, free, exempt: Number(line.tax_rate) === 0 && tax === 0,
      note: free ? `Free${extra.scheme_name ? ` · ${extra.scheme_name}` : ""}` : extra && Number(extra.discount_percent) > 0 ? `${Number(extra.discount_percent)}% off${extra.scheme_name ? ` · ${extra.scheme_name}` : ""}` : "",
    };
  });
  // The GST summary by HSN and rate (what the return is filed by).
  const summary = new Map();
  for (const l of lines) {
    const key = `${l.hsn}|${l.gstRate}`;
    const row = summary.get(key) || { hsn: l.hsn, rate: l.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    row.taxable += l.taxable; row.cgst += l.cgst; row.sgst += l.sgst; row.igst += l.igst; row.tax += l.tax;
    summary.set(key, row);
  }
  // A 0% (exempt / nil-rated) slab is one "Exempt" row of the summary when the
  // bill has such lines; a row with nothing in it (free goods at a rate) is
  // left out, and so are tax rows of zero.
  const summaryRows = [...summary.values()].filter((row) => row.taxable !== 0 || row.tax !== 0)
    .map((row) => ({ ...row, exempt: row.rate === 0 && row.tax === 0 }));
  const sum = (key) => lines.reduce((s, l) => s + l[key], 0);
  const paid = doc.payments.reduce((s, x) => s + p(x.amount), 0);
  const returned = (doc.returns || []).reduce((s, x) => s + p(x.total), 0);
  const refunded = (doc.refunds || []).reduce((s, x) => s + p(x.amount), 0);
  return {
    seller, sale, pos, interstate, lines, summary: summaryRows.sort((a, b) => a.rate - b.rate || a.hsn.localeCompare(b.hsn)),
    taxable: sum("taxable"), cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"), tax: p(doc.tax), roundOff: p(doc.round_off), total: p(doc.total),
    discount: sum("discount"), paid, due: p(doc.total) - returned - paid + refunded,
    title: sale ? (seller.gstin ? "Tax invoice" : "Invoice") : "Purchase receipt",
  };
}

const A4_STYLES = `body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;max-width:190mm;margin:0 auto}
  @page{size:A4;margin:12mm} h1{font-size:18px;margin:0} h2{font-size:15px;margin:0;letter-spacing:.06em;text-transform:uppercase}
  .top{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:8px}
  .top .right{text-align:right} .muted{color:#555} .warn{border:1px solid #b45309;color:#7c2d12;padding:6px 8px;margin:8px 0;font-size:11px}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0} .box{border:1px solid #bbb;padding:8px;border-radius:4px}
  .box b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#555;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border:1px solid #ccc;padding:4px 5px;vertical-align:top}
  th{background:#f3f4f6;font-size:10.5px;text-align:left} .r{text-align:right;white-space:nowrap} small{color:#555}
  .totals{display:grid;grid-template-columns:1fr 260px;gap:16px;margin-top:10px} .totals table td{border:0;border-bottom:1px solid #eee}
  .grand td{font-size:14px;font-weight:700;border-top:2px solid #111!important} .words{font-style:italic}
  .sign{display:flex;justify-content:space-between;margin-top:28px;align-items:flex-end} .sign .r{text-align:right}`;

// A pharmacy bill: each line's schedule and expiry,
// and the drug licence numbers, the registered pharmacist and the prescription.
function pharmacyLine(doc, line) {
  const x = (doc.pharmacy?.lines || []).find((l) => l.line_id === line.id);
  if (!x) return "";
  const exp = x.expires_on ? `Exp ${String(x.expires_on).slice(5, 7)}/${String(x.expires_on).slice(2, 4)}` : "";
  return [x.schedule && !["none", "G"].includes(x.schedule) ? `Sch. ${x.schedule}` : "", exp].filter(Boolean).join(" · ");
}
function pharmacyBlock(doc) {
  const ph = doc.pharmacy;
  if (!ph) return "";
  const licences = (ph.licences || []).map((l) => `${escapeHtml(l.form)}: ${escapeHtml(l.number)}`).join(" · ");
  const rx = ph.prescription;
  return `<div class="small">${licences ? `D.L. No. ${licences}` : ""}${ph.pharmacist ? `${licences ? "<br>" : ""}Registered pharmacist: ${escapeHtml(ph.pharmacist.name)} (Reg. ${escapeHtml(ph.pharmacist.registration_no)})` : ""}${rx ? `<br>Rx: ${escapeHtml(rx.doctor_name)} (Reg. ${escapeHtml(rx.doctor_reg_no)}), ${escapeHtml(String(rx.prescribed_on).slice(0, 10))} · Patient ${escapeHtml(rx.patient_name)}` : ""}</div>`;
}

function a4(doc, biz, f) {
  const { seller } = f;
  const money = (paise) => escapeHtml(moneyExact(r(paise), biz.symbol));
  const date = (value) => escapeHtml(businessDate(value, seller.date_format, biz.business.timezone));
  const sellerName = seller.legal_name || seller.display_name || biz.business.name;
  const address = (parts) => parts.filter(Boolean).map(escapeHtml).join(", ");
  const taxHead = f.interstate ? "<th class=\"r\">IGST</th>" : "<th class=\"r\">CGST</th><th class=\"r\">SGST</th>";
  const rows = f.lines.map((l) => `<tr><td>${l.n}</td>
    <td>${escapeHtml(l.label)}${l.lot ? `<br><small>${escapeHtml(l.lot)}</small>` : ""}${l.kit ? `<br><small>Part of ${escapeHtml(l.kit)}</small>` : ""}${l.mrp ? `<br><small>MRP ${money(l.mrp)}</small>` : ""}${l.note ? `<br><small>${escapeHtml(l.note)}</small>` : ""}</td>
    <td>${escapeHtml(l.hsn || "—")}</td><td class="r">${escapeHtml(l.quantity)}</td><td class="r">${l.free ? "Free" : escapeHtml(`${biz.symbol}${RATE.format(l.rate)}`)}</td>
    <td class="r">${l.discount ? money(l.discount) : "—"}</td><td class="r">${money(l.taxable)}</td><td class="r">${l.exempt ? "Exempt" : `${l.gstRate}%`}</td>
    ${l.exempt ? (f.interstate ? '<td class="r">—</td>' : '<td class="r">—</td><td class="r">—</td>') : f.interstate ? `<td class="r">${money(l.igst)}</td>` : `<td class="r">${money(l.cgst)}</td><td class="r">${money(l.sgst)}</td>`}
    <td class="r">${money(l.amount)}</td></tr>`).join("");
  const dash = f.interstate ? '<td class="r">—</td>' : '<td class="r">—</td><td class="r">—</td>';
  const hsnRows = f.summary.map((s) => `<tr><td>${escapeHtml(s.hsn || "—")}</td><td class="r">${money(s.taxable)}</td><td class="r">${s.exempt ? "Exempt" : `${s.rate}%`}</td>
    ${s.exempt ? `${dash}<td class="r">—</td>` : `${f.interstate ? `<td class="r">${money(s.igst)}</td>` : `<td class="r">${money(s.cgst)}</td><td class="r">${money(s.sgst)}</td>`}<td class="r">${money(s.tax)}</td>`}</tr>`).join("");
  const savings = Number(doc.retail?.savings || 0);
  return `<div class="top"><div><h1>${escapeHtml(sellerName)}</h1>
      ${seller.legal_name && seller.display_name && seller.legal_name !== seller.display_name ? `<div class="muted">${escapeHtml(seller.display_name)}</div>` : ""}
      ${seller.branch_name ? `<div class="muted">${escapeHtml(seller.branch_name)}</div>` : ""}
      <div>${address([seller.address_line1, seller.address_line2, seller.city, seller.postal_code])}</div>
      <div>${[seller.gstin && `GSTIN <strong>${escapeHtml(seller.gstin)}</strong>`, seller.state_code && `State ${escapeHtml(stateName(seller.state_code))}`].filter(Boolean).join(" · ")}</div>
      ${pharmacyBlock(doc)}
      <div class="muted">${[seller.phone && `Ph ${seller.phone}`, seller.email].filter(Boolean).map(escapeHtml).join(" · ")}</div></div>
    <div class="right"><h2>${escapeHtml(f.title)}</h2><div>No. <strong>${escapeHtml(doc.document_no)}</strong></div><div>Date ${date(doc.created_at)}</div>
      ${f.sale && doc.contact_id && doc.due_on && f.due > 0 ? `<div>Due ${date(doc.due_on)}</div>` : ""}
      ${doc.supplier_bill_no ? `<div>Supplier bill ${escapeHtml(doc.supplier_bill_no)}${doc.supplier_bill_date ? ` · ${date(String(doc.supplier_bill_date).slice(0, 10))}` : ""}</div>` : ""}</div></div>
  ${f.sale && !seller.gstin ? '<div class="warn">This business has no GSTIN in Business settings, so this is not a GST tax invoice. Add the GSTIN to print tax invoices.</div>' : ""}
  <div class="parties"><div class="box"><b>${f.sale ? "Bill to" : "Supplier"}</b><strong>${escapeHtml(doc.contact_name || "Walk-in customer")}</strong>
      ${doc.contact_address ? `<div>${escapeHtml(doc.contact_address)}</div>` : ""}${doc.contact_phone ? `<div>Ph ${escapeHtml(doc.contact_phone)}</div>` : ""}
      ${doc.contact_gstin ? `<div>GSTIN <strong>${escapeHtml(doc.contact_gstin)}</strong></div>` : f.sale ? '<div class="muted">Unregistered (no GSTIN)</div>' : ""}</div>
    <div class="box"><b>${f.sale ? "Place of supply" : "Received at"}</b>${f.sale ? `<strong>${escapeHtml(stateName(f.pos) || "—")}</strong><div>${f.interstate ? "Inter-state supply: IGST" : "Within the state: CGST + SGST"}</div>` : ""}
      <div>${escapeHtml(doc.location_name || "")}</div>${doc.tax_mode === "inclusive" && f.sale ? '<div class="muted">Prices include GST</div>' : ""}</div></div>
  ${transportBox(doc, date)}
  <table><thead><tr><th>#</th><th>Item</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Discount</th><th class="r">Taxable value</th><th class="r">GST</th>${taxHead}<th class="r">Amount</th></tr></thead>
    <tbody>${rows}</tbody></table>
  <div class="totals"><div>
      ${hsnRows ? `<table><thead><tr><th>HSN/SAC</th><th class="r">Taxable value</th><th class="r">Rate</th>${taxHead}<th class="r">Total tax</th></tr></thead><tbody>${hsnRows}</tbody></table>` : ""}
      <p class="words"><strong>Amount in words:</strong> ${escapeHtml(amountInWords(r(f.total)))}</p>
      ${savings > 0 ? `<p>Offers and points on this bill: ${money(p(savings))}</p>` : ""}</div>
    <table><tbody>
      <tr><td>Taxable value</td><td class="r">${money(f.taxable)}</td></tr>
      ${f.interstate ? (f.igst ? `<tr><td>IGST</td><td class="r">${money(f.igst)}</td></tr>` : "") : `${f.cgst ? `<tr><td>CGST</td><td class="r">${money(f.cgst)}</td></tr>` : ""}${f.sgst ? `<tr><td>SGST</td><td class="r">${money(f.sgst)}</td></tr>` : ""}`}
      ${f.roundOff ? `<tr><td>Round-off</td><td class="r">${money(f.roundOff)}</td></tr>` : ""}
      <tr class="grand"><td>Total</td><td class="r">${money(f.total)}</td></tr>
      ${doc.payments.length > 1 ? doc.payments.map((x) => `<tr><td>${x.method === "finance" ? `On EMI · ${escapeHtml(financeWords(doc))}` : `Paid · ${escapeHtml(METHOD_WORDS[x.method] || x.method)}`}</td><td class="r">${money(p(x.amount))}</td></tr>`).join("")
        : f.paid ? `<tr><td>${doc.payments[0]?.method === "finance" ? `On EMI · ${escapeHtml(financeWords(doc))}` : "Paid"}</td><td class="r">${money(f.paid)}</td></tr>` : ""}
      ${f.due > 0 ? `<tr><td><strong>Balance due</strong></td><td class="r"><strong>${money(f.due)}</strong></td></tr>` : ""}
    </tbody></table></div>
  ${seller.invoice_footer ? `<p><small>${escapeHtml(seller.invoice_footer)}</small></p>` : ""}
  <div class="sign"><small>Certified that the particulars given above are true and correct.${f.sale ? " Goods once sold are subject to the shop's exchange policy." : ""}</small>
    <div class="r">For ${escapeHtml(sellerName)}<br><br><br>Authorised signatory</div></div>`;
}

// Order, salesperson and transport of a dispatched wholesale order, with the
// e-way bill. Nothing for any other sale.
function transportBox(doc, date) {
  const w = doc.wholesale;
  if (!w) return "";
  const parts = [
    w.order_no && `Order <strong>${escapeHtml(w.order_no)}</strong>${w.ordered_at ? ` (${date(w.ordered_at)})` : ""}`,
    w.salesperson_name && `Salesperson ${escapeHtml(w.salesperson_name)}`,
    w.route_name && `Route ${escapeHtml(w.route_name)}`,
    w.vehicle_no && `Vehicle <strong>${escapeHtml(w.vehicle_no)}</strong>`,
    w.driver_name && `Driver ${escapeHtml(w.driver_name)}`,
    w.transporter_name && `Transporter ${escapeHtml(w.transporter_name)}${w.transporter_id ? ` (${escapeHtml(w.transporter_id)})` : ""}`,
    w.lr_no && `LR / docket ${escapeHtml(w.lr_no)}`,
    w.eway_bill_no && `E-way bill <strong>${escapeHtml(w.eway_bill_no)}</strong>${w.eway_bill_date ? ` dated ${date(w.eway_bill_date)}` : ""}`,
    w.distance_km !== null && w.distance_km !== undefined && `${w.distance_km} km`,
  ].filter(Boolean);
  return `<div class="box" style="margin-bottom:6px"><b>Order and transport</b>${parts.join(" · ")}</div>`;
}

const TILL_STYLES = `body{font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#000;width:72mm}
  @page{size:80mm auto;margin:3mm} h1{font-size:15px;margin:0;text-align:center} .c{text-align:center} small{color:#333}
  .row{display:flex;justify-content:space-between;gap:8px} .line{padding:3px 0;border-bottom:1px dashed #999}
  .save{font-size:11px;padding-left:8px} .tot{font-size:15px;font-weight:700;border-top:1px solid #000;margin-top:4px;padding-top:4px}
  .small{font-size:11px} hr{border:0;border-top:1px dashed #000;margin:6px 0} .you{font-weight:700;text-align:center;margin:6px 0}
  .words{font-size:10.5px;font-style:italic}`;

function till(doc, biz, f, { change = 0, udhaar = null } = {}) {
  const { seller } = f;
  const money = (paise) => escapeHtml(moneyExact(r(paise), biz.symbol));
  const discounts = doc.retail?.discounts || [];
  const lineRows = f.lines.map((l, i) => {
    const saved = discounts.filter((d) => d.line_id === doc.lines[i].id).map((d) => `<div class="save">− ${money(p(d.amount))} ${escapeHtml(d.label)}</div>`).join("");
    return `<div class="line"><div>${escapeHtml(l.label)}${l.lot ? ` <small>${escapeHtml(l.lot)}</small>` : ""}${l.kit ? `<br><small>in ${escapeHtml(l.kit)}</small>` : ""}</div>
      <div class="row small"><span>${l.hsn ? `HSN ${escapeHtml(l.hsn)} · ` : ""}${escapeHtml(l.quantity)} × ${escapeHtml(`${biz.symbol}${RATE.format(l.rate)}`)}${l.mrp && l.mrp > Math.round(l.rate * 100) ? ` <s>MRP ${money(l.mrp)}</s>` : ""}</span><span>${money(l.amount)}</span></div>${saved}</div>`;
  }).join("");
  const exemptValue = f.summary.filter((s) => s.exempt).reduce((sum, s) => sum + s.taxable, 0);
  const gstRows = f.summary.filter((s) => s.tax > 0).map((s) => (f.interstate
    ? `<div class="row small"><span>IGST ${s.rate}% on ${money(s.taxable)}</span><span>${money(s.igst)}</span></div>`
    : `<div class="row small"><span>CGST ${s.rate / 2}% + SGST ${s.rate / 2}% on ${money(s.taxable)}</span><span>${money(s.cgst)} + ${money(s.sgst)}</span></div>`)).join("")
    + (exemptValue ? `<div class="row small"><span>Exempt / nil-rated</span><span>${money(exemptValue)}</span></div>` : "");
  const loyalty = doc.retail?.loyalty || [];
  const earned = loyalty.find((e) => e.kind === "earn");
  const redeemed = loyalty.find((e) => e.kind === "redeem");
  const savings = Number(doc.retail?.savings || 0);
  return `<h1>${escapeHtml(seller.display_name || seller.legal_name || biz.business.name)}</h1>
    ${seller.branch_name ? `<div class="c small">${escapeHtml(seller.branch_name)}</div>` : ""}
    <div class="c small">${[seller.address_line1, seller.city, seller.postal_code].filter(Boolean).map(escapeHtml).join(", ")}${seller.phone ? `<br>Ph ${escapeHtml(seller.phone)}` : ""}${seller.gstin ? `<br>GSTIN ${escapeHtml(seller.gstin)}` : ""}</div>${pharmacyBlock(doc)}
    <div class="c"><strong>${escapeHtml(f.title.toUpperCase())}</strong></div>
    <hr><div class="row"><span>${escapeHtml(doc.document_no)}</span><span>${escapeHtml(businessDate(doc.created_at, seller.date_format, biz.business.timezone))} ${escapeHtml(new Date(doc.created_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }))}</span></div>
    ${doc.contact_name ? `<div>${escapeHtml(doc.contact_name)}${doc.contact_phone ? ` · ${escapeHtml(doc.contact_phone)}` : ""}</div>` : ""}
    ${doc.contact_gstin ? `<div class="small">GSTIN ${escapeHtml(doc.contact_gstin)}</div>` : ""}
    ${f.interstate ? `<div class="small">Place of supply ${escapeHtml(stateName(f.pos))}</div>` : ""}<hr>
    ${lineRows}
    <div class="row small"><span>Taxable value</span><span>${money(f.taxable)}</span></div>${gstRows}
    ${f.roundOff ? `<div class="row small"><span>Round-off</span><span>${money(f.roundOff)}</span></div>` : ""}
    <div class="row tot"><span>TOTAL</span><span>${money(f.total)}</span></div>
    <div class="words">${escapeHtml(amountInWords(r(f.total)))}</div>
    ${doc.payments.map((x) => `<div class="row small"><span>${x.method === "finance" ? `On EMI · ${escapeHtml(financeWords(doc))}` : `Paid · ${escapeHtml(METHOD_WORDS[x.method] || x.method)}`}</span><span>${money(p(x.amount))}</span></div>`).join("")}
    ${changeBack(doc, change) > 0 ? `<div class="row small"><span>Change returned (cash)</span><span>${money(changeBack(doc, change))}</span></div>` : ""}
    ${udhaar ? `<hr><div class="row small"><span>Earlier udhaar</span><span>${money(p(udhaar.earlier))}</span></div>
      <div class="row small"><span>This bill on udhaar</span><span>${money(p(udhaar.thisBill))}</span></div>
      <div class="row"><strong>Total udhaar now</strong><strong>${money(p(udhaar.total))}</strong></div>`
    : f.due > 0 ? `<div class="row"><span>Balance due</span><span>${money(f.due)}</span></div>` : ""}
    ${savings > 0 ? `<div class="you">You saved ${money(p(savings))} today</div>` : ""}
    ${redeemed ? `<div class="row small"><span>Points redeemed</span><span>${escapeHtml(String(-redeemed.points))}</span></div>` : ""}
    ${earned ? `<div class="row small"><span>Points earned</span><span>${escapeHtml(String(earned.points))}</span></div>` : ""}
    ${(doc.warranties || []).map((w) => `<div class="small">Warranty ${escapeHtml(w.serial)} until ${escapeHtml(businessDate(w.ends_on, seller.date_format))}</div>`).join("")}
    <hr><div class="c small">${escapeHtml(seller.receipt_footer || "Thank you, visit again!")}</div>`;
}

const METHOD_WORDS = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", cheque: "Cheque", credit_note: "Credit note", finance: "EMI" };
// An EMI bill's financier and loan.
const financeWords = (doc) => (doc.finance || []).map((f) => `${f.financier_name} ${f.loan_no}`).join(", ") || "financier";
// Change given back: what the counter says, or (a reprint) cash handed over less the cash part (paise).
const changeBack = (doc, change) => (change > 0 ? p(change) : doc.payments.reduce((s, x) => s + (x.method === "cash" && x.tendered ? Math.max(0, p(x.tendered) - p(x.amount)) : 0), 0));

// Several A4 invoices in one print (a delivery run's invoices), one per page.
export function printTaxInvoices(docs, biz) {
  printDocument({
    title: docs.length === 1 ? docs[0].document_no : `${docs.length} invoices`,
    styles: `${A4_STYLES} .invoice-page{page-break-after:always} .invoice-page:last-child{page-break-after:auto}`,
    body: docs.map((doc) => `<section class="invoice-page">${a4(doc, biz, invoiceFacts(doc))}</section>`).join(""),
  });
}

export function printTaxInvoice(doc, biz, { paper = "a4", ...extra } = {}) {
  const facts = invoiceFacts(doc);
  printDocument({
    title: doc.document_no,
    styles: paper === "80mm" ? tillStyles(biz) : A4_STYLES,
    body: paper === "80mm" ? till(doc, biz, facts, extra) : a4(doc, biz, facts),
  });
}

// The till receipt on the business's own paper (Business settings › Rules:
// 80 mm, or 58 mm for a small printer). "80mm" in the callers means "the till".
function tillStyles(biz) {
  if (Number(biz?.settings?.receipt_width_mm) !== 58) return TILL_STYLES;
  return TILL_STYLES.replace("width:72mm", "width:50mm").replace("@page{size:80mm auto;", "@page{size:58mm auto;").replace("font:12px/1.35", "font:11px/1.3");
}
