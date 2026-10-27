import { escapeHtml, printDocument } from "../../../../services/print";
import { amountInWords, moneyExact } from "@bmp/shared/format";
import { A4_STYLES, GST_STATES, businessDate } from "../../core/pages/invoice";
import { privacyLine } from "../../../personal-data/printLine";
import { ESTIMATE_NOTE, workingLine } from "../../hardware/pages/workings";

// A quotation on A4 under the business's own header, laid out like its bills,
// and the same quotation as a WhatsApp message. Everything on it is what the
// server worked out when it was made or last revised: lines, HSN, MRP, rates,
// discounts, GST and round-off. Only the CGST / SGST halves are split here, to
// the paisa, so they always add up to the GST quoted.

const p = (value) => Math.round(Number(value || 0) * 100);
const r = (paise) => paise / 100;
const qty = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const RATE = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
// Half of a line's GST to each of CGST and SGST; the odd paisa goes to CGST.
const halves = (taxPaise) => [taxPaise - Math.floor(taxPaise / 2), Math.floor(taxPaise / 2)];
const stateName = (code) => (code ? `${GST_STATES[code] || "State"} (${code})` : "");
const lineQuantity = (l) => (l.entered_unit ? `${qty(l.entered_quantity)} ${l.entered_unit}` : `${qty(l.quantity)} ${l.unit}`);
const lineRate = (l) => Number(l.entered_unit_price || l.unit_price);

// Where the goods are supplied, as the bill will say: the buyer's GSTIN state,
// otherwise the selling location's own state, otherwise the business's.
function supply(q) {
  const seller = q.seller || {};
  const pos = (q.contact_gstin ? String(q.contact_gstin).slice(0, 2) : null) || seller.state_code || null;
  return { pos, interstate: Boolean(pos && seller.state_code && pos !== seller.state_code) };
}

export function printQuotation(q, biz) {
  const seller = q.seller || {};
  const { pos, interstate } = supply(q);
  const money = (paise) => escapeHtml(moneyExact(r(paise), biz.symbol));
  const date = (value) => escapeHtml(businessDate(value, seller.date_format, biz.business.timezone));
  const sellerName = seller.legal_name || seller.display_name || biz.business.name;
  const address = (parts) => parts.filter(Boolean).map(escapeHtml).join(", ");
  const lines = q.lines.map((l, index) => {
    const tax = p(l.tax);
    const [cgst, sgst] = interstate ? [0, 0] : halves(tax);
    return { ...l, n: index + 1, tax, cgst, sgst, igst: interstate ? tax : 0, taxable: p(l.net), discount: p(l.discount), exempt: Number(l.tax_rate) === 0 && tax === 0 };
  });
  const sum = (key) => lines.reduce((s, l) => s + l[key], 0);
  const taxHead = interstate ? '<th class="r">IGST</th>' : '<th class="r">CGST</th><th class="r">SGST</th>';
  // A hardware shop's tinted line names its shade.
  const tintOf = (l) => (q.tints || []).find((t) => String(t.line_id) === String(l.id));
  const rows = lines.map((l) => `<tr><td>${l.n}</td>
    <td>${escapeHtml(l.label)}${tintOf(l) ? `<br><small>Tinted to ${escapeHtml(`${tintOf(l).maker} ${tintOf(l).code} ${tintOf(l).name}`)}</small>` : ""}${l.mrp ? `<br><small>MRP ${money(p(l.mrp))}</small>` : ""}${(l.offers || []).length ? `<br><small>${escapeHtml(l.offers.map((o) => o.label).join(", "))}</small>` : ""}</td>
    <td>${escapeHtml(l.hsn_code || "—")}</td><td class="r">${escapeHtml(lineQuantity(l))}</td><td class="r">${escapeHtml(`${biz.symbol}${RATE.format(lineRate(l))}`)}</td>
    <td class="r">${l.discount ? money(l.discount) : "—"}</td><td class="r">${money(l.taxable)}</td><td class="r">${l.exempt ? "Exempt" : `${Number(l.tax_rate)}%`}</td>
    ${interstate ? `<td class="r">${money(l.igst)}</td>` : `<td class="r">${money(l.cgst)}</td><td class="r">${money(l.sgst)}</td>`}
    <td class="r">${money(l.taxable + l.tax)}</td></tr>`).join("");
  const site = q.site ? `<div class="box" style="margin-bottom:6px"><b>Site</b><strong>${escapeHtml(q.site.name)}</strong>${q.site.address ? ` · ${escapeHtml(q.site.address)}` : ""}${q.site.contact_person ? ` · ${escapeHtml(q.site.contact_person)}` : ""}${q.site.phone ? ` · Ph ${escapeHtml(q.site.phone)}` : ""}</div>` : "";
  const body = `<div class="top"><div><h1>${escapeHtml(sellerName)}</h1>
      ${seller.legal_name && seller.display_name && seller.legal_name !== seller.display_name ? `<div class="muted">${escapeHtml(seller.display_name)}</div>` : ""}
      ${seller.branch_name ? `<div class="muted">${escapeHtml(seller.branch_name)}</div>` : ""}
      <div>${address([seller.address_line1, seller.address_line2, seller.city, seller.postal_code])}</div>
      <div>${[seller.gstin && `GSTIN <strong>${escapeHtml(seller.gstin)}</strong>`, seller.state_code && `State ${escapeHtml(stateName(seller.state_code))}`].filter(Boolean).join(" · ")}</div>
      <div class="muted">${[seller.phone && `Ph ${seller.phone}`, seller.email].filter(Boolean).map(escapeHtml).join(" · ")}</div></div>
    <div class="right"><h2>Quotation</h2><div>No. <strong>${escapeHtml(q.quotation_no)}</strong>${q.revision > 1 ? ` · revision ${q.revision}` : ""}</div>
      <div>Date ${date(q.updated_at || q.created_at)}</div><div>Valid until <strong>${date(q.valid_until)}</strong></div></div></div>
  <div class="parties"><div class="box"><b>Quotation for</b><strong>${escapeHtml(q.customer_name)}</strong>
      ${q.contact_address ? `<div>${escapeHtml(q.contact_address)}</div>` : ""}${q.customer_phone ? `<div>Ph ${escapeHtml(q.customer_phone)}</div>` : ""}
      ${q.contact_gstin ? `<div>GSTIN <strong>${escapeHtml(q.contact_gstin)}</strong></div>` : ""}</div>
    <div class="box"><b>Place of supply</b><strong>${escapeHtml(stateName(pos) || "—")}</strong><div>${interstate ? "Inter-state supply: IGST" : "Within the state: CGST + SGST"}</div>
      <div>${escapeHtml(q.location_name || "")}</div>${q.tax_mode === "inclusive" ? '<div class="muted">Prices include GST</div>' : ""}</div></div>
  ${site}
  <table><thead><tr><th>#</th><th>Item</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Discount</th><th class="r">Taxable value</th><th class="r">GST</th>${taxHead}<th class="r">Amount</th></tr></thead>
    <tbody>${rows}</tbody></table>
  <div class="totals"><div>
      <p class="words"><strong>Amount in words:</strong> ${escapeHtml(amountInWords(r(p(q.total))))}</p>
      ${p(q.savings) > 0 ? `<p>Offers and discount on this quotation: ${money(p(q.savings))}</p>` : ""}
      ${q.notes ? `<p>${escapeHtml(q.notes)}</p>` : ""}
      ${(q.calculations || []).length ? `<p><strong>How the quantities were worked out</strong> <small>(${escapeHtml(ESTIMATE_NOTE)})</small></p><ul>${q.calculations.map((w) => `<li><small>${escapeHtml(workingLine(w.kind, w.working))}</small></li>`).join("")}</ul>` : ""}</div>
    <table><tbody>
      <tr><td>Taxable value</td><td class="r">${money(sum("taxable"))}</td></tr>
      ${interstate ? `<tr><td>IGST</td><td class="r">${money(sum("igst"))}</td></tr>` : `<tr><td>CGST</td><td class="r">${money(sum("cgst"))}</td></tr><tr><td>SGST</td><td class="r">${money(sum("sgst"))}</td></tr>`}
      ${p(q.round_off) ? `<tr><td>Round-off</td><td class="r">${money(p(q.round_off))}</td></tr>` : ""}
      <tr class="grand"><td>Total</td><td class="r">${money(p(q.total))}</td></tr>
    </tbody></table></div>
  <p><small>This is a quotation, not a tax invoice. The prices hold until ${date(q.valid_until)}; goods are kept aside only once the bill is made.</small></p>
  ${privacyLine(biz) ? `<p><small>${escapeHtml(privacyLine(biz))}</small></p>` : ""}
  <div class="sign"><small>Thank you for the enquiry.</small><div class="r">For ${escapeHtml(sellerName)}<br><br><br>Authorised signatory</div></div>`;
  printDocument({ title: q.quotation_no, styles: A4_STYLES, body });
}

// The quotation as a message the shop sends on WhatsApp.
export function quotationMessage(q, biz) {
  const seller = q.seller || {};
  const amount = (value) => moneyExact(value, biz.symbol);
  return [
    `*${seller.display_name || biz.business.name}*`,
    `Quotation ${q.quotation_no} · ${businessDate(q.updated_at || q.created_at, seller.date_format, biz.business.timezone)}`,
    `For ${q.customer_name}${q.site ? ` · site ${q.site.name}` : ""}`,
    ...q.lines.map((l) => `• ${l.label}: ${lineQuantity(l)} × ${biz.symbol}${RATE.format(lineRate(l))} = ${amount(Number(l.net) + Number(l.tax))}`),
    `Total ${amount(q.total)}${q.tax_mode === "inclusive" ? " (GST included)" : " (with GST)"}`,
    `Valid until ${businessDate(q.valid_until, seller.date_format, biz.business.timezone)}.`,
  ].join("\n");
}
