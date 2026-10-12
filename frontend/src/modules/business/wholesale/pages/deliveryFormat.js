import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "../../../../services/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import { printTaxInvoices } from "../../core/pages/invoice";
import { inPacks } from "./tradeFormat";

// Plain helpers for dispatch and delivery (no components here, so fast refresh works).

export const DELIVERY = {
  out_for_delivery: { tone: "info", label: "Out for delivery" },
  delivered: { tone: "success", label: "Delivered" },
  part_returned: { tone: "warning", label: "Part returned" },
  refused: { tone: "danger", label: "Refused" },
};

export const emptyTransport = (from = {}) => ({
  vehicleNo: from.vehicle_no || "", driverName: from.driver_name || "", helperName: from.helper_name || "", transporterName: from.transporter_name || "",
  transporterId: from.transporter_id || "", lrNo: from.lr_no || "", ewayBillNo: from.eway_bill_no || "", ewayBillDate: from.eway_bill_date || "", distanceKm: from.distance_km ?? "",
});
export const transportBody = (form) => Object.fromEntries(Object.entries(form).filter(([, v]) => v !== "" && v !== null && v !== undefined));

// The invoices of a run (or any dispatches) printed together, one per page.
export async function printInvoicesOf(biz, documentIds) {
  const id = toast.info("Preparing invoices…", { duration: 0 });
  try {
    const docs = [];
    for (const documentId of documentIds) docs.push(await businessRead(biz.id, `documents/${documentId}`));
    printTaxInvoices(docs, biz);
    toast.success(`${docs.length} invoices ready to print`, { id });
  } catch (err) {
    toast.error(getErrorMessage(err), { id });
  }
}

const SHEET_STYLES = "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} h2{font-size:14px;margin:14px 0 4px} table{width:100%;border-collapse:collapse;margin-top:6px} td,th{border:1px solid #bbb;padding:5px;text-align:left;vertical-align:top} th{background:#f3f4f6} .r{text-align:right} .sign{width:22%} .muted{color:#555}";
const packs = (item, quantity) => inPacks(quantity, item.unit, item.pack_unit, item.pack_factor);

// The pick list of some orders: per item, what to pick and which batches.
export function printPickList(pick, biz) {
  const rows = pick.items.map((i, n) => `<tr><td>${n + 1}</td><td>${escapeHtml(i.label)}<br><span class="muted">${escapeHtml(i.code)}</span></td>
    <td class="r">${escapeHtml(packs(i, i.wanted))}</td><td class="r">${escapeHtml(packs(i, i.available))}</td>
    <td>${i.take.map((t) => `${escapeHtml(t.lot_code || "—")}${t.expires_on ? ` (exp ${escapeHtml(dateShort(t.expires_on, { year: true }))})` : ""}: ${escapeHtml(packs(i, t.quantity))}`).join("<br>") || "—"}</td>
    <td class="r">${Number(i.short) > 0 ? escapeHtml(packs(i, i.short)) : ""}</td><td>${escapeHtml(i.order_nos)}</td><td></td></tr>`).join("");
  printDocument({
    title: "Pick list",
    styles: SHEET_STYLES,
    body: `<h1>${escapeHtml(biz.settings.display_name || biz.business.name)}</h1>
      <p><strong>Pick list</strong> · ${escapeHtml(pick.location.name)} · ${escapeHtml(dateTime(new Date()))} · ${pick.orders.length} orders: ${pick.orders.map((o) => `${escapeHtml(o.order_no)} ${escapeHtml(o.contact_name)}`).join(", ")}</p>
      <table><thead><tr><th>#</th><th>Item</th><th class="r">Pick</th><th class="r">In godown</th><th>Batches to take (earliest expiry first)</th><th class="r">Short</th><th>Orders</th><th class="sign">Picked</th></tr></thead><tbody>${rows}</tbody></table>`,
  });
}

// The load sheet of a delivery run: what is in the van and where it goes.
export function printLoadSheet(run, biz) {
  const items = run.items.map((i, n) => `<tr><td>${n + 1}</td><td>${escapeHtml(i.label)}</td><td class="r">${escapeHtml(packs(i, i.quantity))}</td><td>${escapeHtml(i.lots || "")}</td></tr>`).join("");
  const stops = run.invoices.map((d, n) => `<tr><td>${n + 1}</td><td>${escapeHtml(d.contact_name)}${d.contact_address ? `<br><span class="muted">${escapeHtml(d.contact_address)}</span>` : ""}${d.contact_phone ? `<br><span class="muted">${escapeHtml(d.contact_phone)}</span>` : ""}</td>
    <td>${escapeHtml(d.document_no)}<br><span class="muted">${escapeHtml(d.order_no)}</span></td><td class="r">${escapeHtml(biz.exact(d.total))}</td><td class="r">${escapeHtml(biz.exact(Math.max(0, Number(d.to_collect))))}</td><td></td><td class="sign"></td></tr>`).join("");
  const toCollect = run.invoices.reduce((s, d) => s + Math.max(0, Number(d.to_collect)), 0);
  printDocument({
    title: `Load sheet ${run.id}`,
    styles: SHEET_STYLES,
    body: `<h1>${escapeHtml(biz.settings.display_name || biz.business.name)}</h1>
      <p><strong>Load sheet ${run.id}</strong> · ${escapeHtml(dateTime(run.created_at))} · from ${escapeHtml(run.location_name)}${run.route_name ? ` · ${escapeHtml(run.route_name)}` : ""}<br>
      Vehicle ${escapeHtml(run.vehicle_no || "—")} · Driver ${escapeHtml(run.driver_name || "—")}${run.driver_phone ? ` (${escapeHtml(run.driver_phone)})` : ""}${run.helper_name ? ` · Helper ${escapeHtml(run.helper_name)}` : ""}</p>
      <h2>Goods loaded</h2>
      <table><thead><tr><th>#</th><th>Item</th><th class="r">Quantity</th><th>Batches</th></tr></thead><tbody>${items}</tbody></table>
      <h2>Deliveries</h2>
      <table><thead><tr><th>#</th><th>Shop</th><th>Invoice / order</th><th class="r">Invoice</th><th class="r">To collect</th><th>Collected</th><th class="sign">Shop's signature</th></tr></thead><tbody>${stops}</tbody></table>
      <p><strong>To collect on this run: ${escapeHtml(biz.exact(toCollect))}</strong></p>
      <p style="margin-top:40px;display:flex;justify-content:space-between"><span>Loaded by</span><span>Driver</span><span>Checked on return</span></p>`,
  });
}

// --- Delivery challan (round 2) -------------------------------------------------------

const CHALLAN_STYLES = `body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;max-width:190mm;margin:0 auto}
  @page{size:A4;margin:12mm} h1{font-size:18px;margin:0} h2{font-size:15px;margin:0;letter-spacing:.06em;text-transform:uppercase}
  .top{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:8px} .top .right{text-align:right}
  .muted{color:#555} .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
  .box{border:1px solid #bbb;padding:8px;border-radius:4px} .box b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#555;margin-bottom:2px}
  .facts{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 12px;border:1px solid #bbb;border-radius:4px;padding:8px;margin:8px 0}
  .facts div span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#555} .facts strong{font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border:1px solid #ccc;padding:4px 5px;vertical-align:top}
  th{background:#f3f4f6;font-size:10.5px;text-align:left} .r{text-align:right;white-space:nowrap} small{color:#555}
  .sign{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:40px;text-align:center} .sign div{border-top:1px solid #111;padding-top:4px}`;

// The A4 delivery challan of one dispatch: its own number, the invoice it goes
// with, consignor and consignee, transport (transporter, vehicle, LR, e-way
// bill typed in by hand) and every line with batch and value; free goods at no value.
export function printChallan(c, biz) {
  const s = c.seller || {};
  const sellerName = s.legal_name || s.display_name || biz.business.name;
  const address = (parts) => parts.filter(Boolean).map(escapeHtml).join(", ");
  const money = (v) => escapeHtml(biz.exact(v));
  const rows = c.lines.map((l, n) => `<tr><td>${n + 1}</td>
    <td>${escapeHtml(l.label)}${l.free ? `<br><small>Free${l.scheme_name ? ` · ${escapeHtml(l.scheme_name)}` : ""}</small>` : ""}</td>
    <td>${escapeHtml(l.hsn_code || "—")}</td><td>${escapeHtml(l.lot_code || "—")}${l.expires_on ? `<br><small>exp ${escapeHtml(dateShort(l.expires_on, { year: true }))}</small>` : ""}</td>
    <td class="r">${escapeHtml(inPacks(l.quantity, l.unit, l.entered_unit, l.unit_factor))}</td>
    <td class="r">${l.free ? "Free" : money(Number(l.net) + Number(l.tax))}</td></tr>`).join("");
  const value = c.lines.reduce((t, l) => t + Number(l.net) + Number(l.tax), 0);
  const fact = (label, text) => `<div><span>${label}</span><strong>${escapeHtml(text || "—")}</strong></div>`;
  printDocument({
    title: `Delivery challan ${c.challan_no}`,
    styles: CHALLAN_STYLES,
    body: `<div class="top"><div><h1>${escapeHtml(sellerName)}</h1>
        <div>${address([s.address_line1, s.address_line2, s.city, s.postal_code])}</div>
        <div>${[s.gstin && `GSTIN <strong>${escapeHtml(s.gstin)}</strong>`, s.phone && `Ph ${escapeHtml(s.phone)}`].filter(Boolean).join(" · ")}</div></div>
      <div class="right"><h2>Delivery challan</h2><div>No. <strong>${escapeHtml(c.challan_no)}</strong></div><div>Date ${escapeHtml(dateShort(c.created_at, { year: true }))}</div>
        <div>Against invoice <strong>${escapeHtml(c.document_no)}</strong></div><div class="muted">Order ${escapeHtml(c.order_no)}</div></div></div>
      <div class="grid"><div class="box"><b>Consignor (from)</b><strong>${escapeHtml(sellerName)}</strong><div>${escapeHtml(c.location_name)}</div></div>
        <div class="box"><b>Consignee (deliver to)</b><strong>${escapeHtml(c.contact_name)}</strong>
          ${c.contact_address ? `<div>${escapeHtml(c.contact_address)}${c.contact_pin ? ` – ${escapeHtml(c.contact_pin)}` : ""}</div>` : ""}
          ${c.contact_phone ? `<div>Ph ${escapeHtml(c.contact_phone)}${c.contact_person ? ` · ${escapeHtml(c.contact_person)}` : ""}</div>` : ""}
          <div>${c.contact_gstin ? `GSTIN <strong>${escapeHtml(c.contact_gstin)}</strong>` : '<span class="muted">Unregistered (no GSTIN)</span>'}</div></div></div>
      <div class="facts">${fact("Transporter", [c.transporter_name, c.transporter_id].filter(Boolean).join(" · "))}${fact("Vehicle no.", c.vehicle_no)}${fact("LR / docket no.", c.lr_no)}
        ${fact("E-way bill no.", c.eway_bill_no)}${fact("E-way bill date", c.eway_bill_date ? dateShort(c.eway_bill_date, { year: true }) : "")}${fact("Driver", c.driver_name)}</div>
      <table><thead><tr><th>#</th><th>Item</th><th>HSN</th><th>Batch</th><th class="r">Quantity</th><th class="r">Value (incl. GST)</th></tr></thead><tbody>${rows}</tbody>
        <tfoot><tr><td colspan="5" class="r"><strong>Value of goods</strong></td><td class="r"><strong>${money(value)}</strong></td></tr></tfoot></table>
      <p class="muted">Goods sent against tax invoice ${escapeHtml(c.document_no)} for supply. Please check the goods and sign on receipt; report transit damage within 48 hours.</p>
      <div class="sign"><div>Prepared by${c.created_by_name ? `<br><small>${escapeHtml(c.created_by_name)}</small>` : ""}</div><div>Driver / transporter</div><div>Received in good condition<br><small>Shop's signature and stamp</small></div></div>`,
  });
}
