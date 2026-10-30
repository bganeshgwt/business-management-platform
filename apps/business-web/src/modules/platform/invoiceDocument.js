import { escapeHtml, printDocument } from "../../services/print.js";
import { amountInWords, moneyExact } from "@bmp/shared/format";
import { dayWords } from "./consoleWords.js";

// The company's GST tax invoice for a plan, as CGST Rules, rule 46, asks: the
// supplier's name, address and GSTIN; the number and date; the buyer, with
// their GSTIN when registered; the place of supply; each line with its SAC and
// taxable value; CGST and SGST within the supplier's state, IGST to another,
// each with its rate; the total and the amount in words (lakh and crore);
// "Tax is not payable on reverse charge"; who signs it. A SAMPLE invoice
// (issued under the sample GSTIN) carries a band at the top and a mark across
// every printed page.
//
// One document for the screen and the paper: the invoice page shows
// invoiceHtml() with the screen's styles (styles/console.css), and Print
// sends it on A4 with INVOICE_STYLES through the app's print helper.
//
//   invoice: GET /api/users/platform/invoices/:id (or an owner's own invoice)

export const SAMPLE_WORDS = "SAMPLE — NOT A TAX INVOICE";

const money = (value) => escapeHtml(moneyExact(Number(value || 0)));
const text = (value) => escapeHtml(value ?? "");
const stateOf = (name, code) => (code ? `${text(name || "State")} (${text(code)})` : "");

// What the invoice says, worked out once: its title, whether the supply goes
// to another state, its tax rows and the total in words.
export function invoiceFacts(invoice) {
  const supplierState = invoice.supplier?.stateCode || String(invoice.supplier?.gstin || "").slice(0, 2);
  const placeCode = invoice.placeOfSupply?.code;
  const interstate = Number(invoice.igst) > 0 || Boolean(supplierState && placeCode && supplierState !== placeCode);
  const rate = Number(invoice.gstRate || 0);
  const taxes = interstate
    ? [{ label: `IGST @ ${rate}%`, amount: invoice.igst }]
    : [{ label: `CGST @ ${rate / 2}%`, amount: invoice.cgst }, { label: `SGST @ ${rate / 2}%`, amount: invoice.sgst }];
  return { title: invoice.sample ? "Invoice (sample)" : "Tax invoice", interstate, taxes, words: amountInWords(Number(invoice.total || 0)), sample: Boolean(invoice.sample) };
}

const address = (party) => [party.addressLine1, party.addressLine2, [party.city, party.postalCode].filter(Boolean).join(" ")].filter(Boolean).map(text).join(", ");

export function invoiceHtml(invoice) {
  const facts = invoiceFacts(invoice);
  const supplier = invoice.supplier || {};
  const buyer = invoice.buyer || {};
  const place = invoice.placeOfSupply || {};
  const contact = [supplier.phone && `Ph ${supplier.phone}`, supplier.email, supplier.website].filter(Boolean).map(text).join(" · ");
  const lines = (invoice.lines || []).map((line) => `<tr><td>${text(line.lineNo)}</td>
      <td>${text(line.description)}${Number(line.chargedDays) < Number(line.periodDays)
    ? `<br><small>For ${text(line.chargedDays)} of ${text(line.periodDays)} days, at ${money(line.fullPrice)} for the whole period</small>` : ""}</td>
      <td>${text(line.sac)}</td><td class="pi-r">${money(line.taxable)}</td></tr>`).join("");
  const taxes = facts.taxes.map((tax) => `<tr><td>${text(tax.label)}</td><td class="pi-r">${money(tax.amount)}</td></tr>`).join("");
  return `${facts.sample ? `<div class="pi-sample-mark" aria-hidden="true">${SAMPLE_WORDS}</div><div class="pi-sample-band">${SAMPLE_WORDS}</div>` : ""}
  <div class="pi-top"><div><div class="pi-name">${text(supplier.name)}</div>
      ${supplier.brandName && supplier.brandName !== supplier.name ? `<div class="pi-muted">${text(supplier.brandName)}</div>` : ""}
      <div>${address(supplier)}</div>
      <div>GSTIN <strong>${text(supplier.gstin)}</strong>${supplier.stateCode ? ` · State ${stateOf(supplier.stateName, supplier.stateCode)}` : ""}</div>
      ${supplier.pan ? `<div>PAN ${text(supplier.pan)}</div>` : ""}
      ${contact ? `<div class="pi-muted">${contact}</div>` : ""}</div>
    <div class="pi-right"><div class="pi-kind">${text(facts.title)}</div><div>No. <strong>${text(invoice.number)}</strong></div><div>Date ${text(dayWords(invoice.issuedOn))}</div>
      ${invoice.paidOn ? `<div>Paid on ${text(dayWords(invoice.paidOn))}</div>` : ""}</div></div>
  <div class="pi-parties"><div class="pi-box"><b>Bill to</b><strong>${text(buyer.name)}</strong>
      ${address(buyer) ? `<div>${address(buyer)}</div>` : ""}
      ${buyer.gstin ? `<div>GSTIN <strong>${text(buyer.gstin)}</strong></div>` : '<div class="pi-muted">Unregistered (no GSTIN)</div>'}
      ${buyer.stateCode ? `<div>State ${stateOf(buyer.stateName, buyer.stateCode)}</div>` : ""}</div>
    <div class="pi-box"><b>Place of supply</b><strong>${stateOf(place.name, place.code)}</strong>
      <div>${facts.interstate ? "Supply to another state: IGST" : "Within the state: CGST and SGST"}</div></div></div>
  <table class="pi-lines"><thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="pi-r">Taxable value</th></tr></thead><tbody>${lines}</tbody></table>
  <div class="pi-totals"><div><p class="pi-words"><strong>Amount in words:</strong> ${text(facts.words)}</p>
      <p>Tax is not payable on reverse charge.</p></div>
    <table><tbody><tr><td>Taxable value</td><td class="pi-r">${money(invoice.taxable)}</td></tr>${taxes}
      <tr class="pi-grand"><td>Total</td><td class="pi-r">${money(invoice.total)}</td></tr></tbody></table></div>
  <div class="pi-sign"><small>Certified that the particulars given above are true and correct.</small>
    <div class="pi-r">For ${text(supplier.name)}<br><br><br>${text(invoice.signatory || "Authorised signatory")}</div></div>`;
}

// The paper: A4, black on white. The mark across a SAMPLE invoice is a fixed
// box, which a browser prints on every page.
export const INVOICE_STYLES = `@page{size:A4;margin:12mm}
  body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111}
  .pi-name{font-size:18px;font-weight:700} .pi-kind{font-size:15px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
  .pi-top{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:8px}
  .pi-right{text-align:right} .pi-muted{color:#555}
  .pi-parties{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}
  .pi-box{border:1px solid #bbb;padding:8px;border-radius:4px}
  .pi-box b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#555;margin-bottom:2px}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;text-align:left}
  th{background:#f3f4f6;font-size:10.5px} .pi-r{text-align:right;white-space:nowrap} small{color:#555}
  .pi-totals{display:grid;grid-template-columns:1fr 260px;gap:16px;margin-top:10px} .pi-totals table td{border:0;border-bottom:1px solid #eee}
  .pi-grand td{font-size:14px;font-weight:700;border-top:2px solid #111} .pi-words{font-style:italic}
  .pi-sign{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:28px}
  .pi-sample-band{border:2px solid #b91c1c;color:#b91c1c;font-weight:800;letter-spacing:.12em;text-align:center;padding:6px;margin-bottom:10px}
  .pi-sample-mark{position:fixed;top:42%;left:0;right:0;text-align:center;font-size:40px;font-weight:800;letter-spacing:.08em;color:rgba(185,28,28,.16);transform:rotate(-24deg);pointer-events:none}`;

export function printPlanInvoice(invoice) {
  printDocument({ title: invoice.number, styles: INVOICE_STYLES, body: invoiceHtml(invoice) });
}
