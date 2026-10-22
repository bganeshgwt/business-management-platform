import { dateShort } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { inPacks } from "./tradeFormat";

// Plain helpers for purchase orders (no components here, so fast refresh works).

export const PO_STATUS = {
  draft: { tone: "neutral", label: "Draft" },
  sent: { tone: "info", label: "Sent" },
  part_received: { tone: "warning", label: "Part received" },
  received: { tone: "success", label: "Received" },
  closed: { tone: "neutral", label: "Closed short" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

const STYLES = `body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;max-width:190mm;margin:0 auto}
  @page{size:A4;margin:12mm} h1{font-size:18px;margin:0} h2{font-size:15px;margin:0;letter-spacing:.06em;text-transform:uppercase}
  .top{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:8px} .top .right{text-align:right}
  .muted{color:#555} .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
  .box{border:1px solid #bbb;padding:8px;border-radius:4px} .box b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#555;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border:1px solid #ccc;padding:4px 5px;vertical-align:top}
  th{background:#f3f4f6;font-size:10.5px;text-align:left} .r{text-align:right;white-space:nowrap} small{color:#555}
  .sign{display:flex;justify-content:space-between;margin-top:36px;align-items:flex-end}`;

// The A4 purchase order the supplier receives: what to send, in cases, at
// what cost before GST, where to deliver and by when.
export function printPurchaseOrder(po, biz) {
  const s = po.seller || {};
  const name = s.legal_name || s.display_name || biz.business.name;
  const address = (parts) => parts.filter(Boolean).map(escapeHtml).join(", ");
  const money = (v) => escapeHtml(biz.exact(v));
  const rows = po.lines.map((l, n) => `<tr><td>${n + 1}</td><td>${escapeHtml(l.label)}<br><small>${escapeHtml(l.sku_code || "")}</small></td>
    <td>${escapeHtml(l.hsn_code || "—")}</td><td class="r">${escapeHtml(inPacks(l.quantity, l.unit, l.entered_unit, l.unit_factor))}</td>
    <td class="r">${l.entered_unit ? `${money(Number(l.unit_cost) * Number(l.unit_factor))} / ${escapeHtml(l.entered_unit)}` : `${money(l.unit_cost)} / ${escapeHtml(l.unit)}`}</td>
    <td class="r">${escapeHtml(`${Number(l.tax_rate)}%`)}</td><td class="r">${money(l.net)}</td></tr>`).join("");
  printDocument({
    title: `Purchase order ${po.po_no}`,
    styles: STYLES,
    body: `<div class="top"><div><h1>${escapeHtml(name)}</h1><div>${address([s.address_line1, s.address_line2, s.city, s.postal_code])}</div>
        <div>${[s.gstin && `GSTIN <strong>${escapeHtml(s.gstin)}</strong>`, s.phone && `Ph ${escapeHtml(s.phone)}`, s.email && escapeHtml(s.email)].filter(Boolean).join(" · ")}</div></div>
      <div class="right"><h2>Purchase order</h2><div>No. <strong>${escapeHtml(po.po_no)}</strong></div><div>Date ${escapeHtml(dateShort(po.created_at, { year: true }))}</div>
        ${po.expected_on ? `<div>Deliver by <strong>${escapeHtml(dateShort(po.expected_on, { year: true }))}</strong></div>` : ""}</div></div>
      <div class="grid"><div class="box"><b>To (supplier)</b><strong>${escapeHtml(po.contact_name)}</strong>${po.contact_address ? `<div>${escapeHtml(po.contact_address)}</div>` : ""}
          ${po.contact_phone ? `<div>Ph ${escapeHtml(po.contact_phone)}</div>` : ""}${po.contact_gstin ? `<div>GSTIN ${escapeHtml(po.contact_gstin)}</div>` : ""}</div>
        <div class="box"><b>Deliver to</b><strong>${escapeHtml(name)}</strong><div>${escapeHtml(po.location_name)}</div><div>${address([s.address_line1, s.address_line2, s.city])}</div></div></div>
      <table><thead><tr><th>#</th><th>Item</th><th>HSN</th><th class="r">Quantity</th><th class="r">Rate before GST</th><th class="r">GST</th><th class="r">Value before GST</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="6" class="r">Value before GST</td><td class="r">${money(po.subtotal)}</td></tr>
          <tr><td colspan="6" class="r">GST (estimate)</td><td class="r">${money(po.tax)}</td></tr>
          <tr><td colspan="6" class="r"><strong>Estimated total</strong></td><td class="r"><strong>${money(po.total)}</strong></td></tr></tfoot></table>
      ${po.notes ? `<p><strong>Notes:</strong> ${escapeHtml(po.notes)}</p>` : ""}
      <p class="muted">Please quote ${escapeHtml(po.po_no)} on your invoice and delivery challan. Send only what is ordered; batches with at least 60% shelf life left.</p>
      <div class="sign"><small>Raised by ${escapeHtml(po.created_by_name || "")}</small><div class="r">For ${escapeHtml(name)}<br><br><br>Authorised signatory</div></div>`,
  });
}
