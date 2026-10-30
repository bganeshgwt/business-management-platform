import { amountInWords, dateShort, moneyExact } from "@bmp/shared/format";
import { escapeHtml as esc, printDocument } from "../../services/print";
import { A4_STYLES } from "../business/core/pages/invoice";
import { percent } from "./planWords";

// The company's GST tax invoice for a payment of a plan (CGST Rules, rule 46),
// printed or saved as a PDF from Your plan: the supplier's name, address and
// GSTIN; the invoice's number and date; the buyer's name and address, with
// their GSTIN when registered; the place of supply; each line with its SAC
// and taxable value; each tax with its rate; the total in figures and words;
// no reverse charge; who signs. An invoice issued under the sample GSTIN is a
// sample, and says so across its top. It reads like a business's own A4
// invoice (business/core/pages/invoice.js).

const STYLES = `${A4_STYLES}
  .sample{border:2px solid #b91c1c;color:#b91c1c;font-weight:800;font-size:16px;letter-spacing:.08em;text-align:center;padding:6px;margin-bottom:10px}`;

const date = (value) => esc(dateShort(value, { year: true }));
const lines = (...parts) => parts.filter((part) => part !== null && part !== undefined && String(part).trim() !== "").map(esc).join("<br>");
const address = (party) => lines(party.addressLine1, party.addressLine2, [party.city, party.postalCode].filter(Boolean).join(" "));

export function planInvoiceHtml(invoice) {
  const supplier = invoice.supplier || {};
  const buyer = invoice.buyer || {};
  const place = invoice.placeOfSupply || {};
  const rate = Number(invoice.gstRate);
  // Within the company's own state CGST and SGST, to another state IGST.
  const tax = supplier.stateCode && supplier.stateCode === place.code
    ? [[`CGST @ ${percent(rate / 2)}`, invoice.cgst], [`SGST @ ${percent(rate / 2)}`, invoice.sgst]]
    : [[`IGST @ ${percent(rate)}`, invoice.igst]];
  const items = (invoice.lines || []).map((line) => `<tr><td>${esc(line.lineNo)}</td><td>${esc(line.description)}${Number(line.chargedDays) < Number(line.periodDays)
    ? `<br><small>${esc(line.chargedDays)} of ${esc(line.periodDays)} days</small>` : ""}</td><td>${esc(line.sac)}</td><td class="r">${moneyExact(line.taxable)}</td></tr>`).join("");
  const contact = [supplier.phone, supplier.email, supplier.website].filter(Boolean).map(esc).join(" · ");
  return `${invoice.sample ? '<div class="sample">SAMPLE — NOT A TAX INVOICE</div>' : ""}
    <div class="top">
      <div>
        <h1>${esc(supplier.name || supplier.brandName)}</h1>
        <div class="muted">${address(supplier)}<br>GSTIN ${esc(supplier.gstin)}${supplier.pan ? ` · PAN ${esc(supplier.pan)}` : ""}<br>State: ${esc(supplier.stateName)} (${esc(supplier.stateCode)})${contact ? `<br>${contact}` : ""}</div>
      </div>
      <div class="right"><h2>${invoice.sample ? "Sample invoice" : "Tax invoice"}</h2><div>No. <b>${esc(invoice.number)}</b></div><div>Date ${date(invoice.issuedOn)}</div></div>
    </div>
    <div class="parties">
      <div class="box"><b>Billed to</b>${esc(buyer.name)}${address(buyer) ? `<br>${address(buyer)}` : ""}<br>${buyer.gstin ? `GSTIN ${esc(buyer.gstin)}` : "Not registered for GST"}<br>State: ${esc(buyer.stateName)} (${esc(buyer.stateCode)})</div>
      <div class="box"><b>Place of supply</b>${esc(place.name)} (${esc(place.code)})<br><br><b>Payment received on</b>${date(invoice.paidOn)}</div>
    </div>
    <table><thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="r">Taxable value</th></tr></thead><tbody>${items}</tbody></table>
    <div class="totals">
      <div class="words">${esc(amountInWords(invoice.total))}</div>
      <table>
        <tr><td>Taxable value</td><td class="r">${moneyExact(invoice.taxable)}</td></tr>
        ${tax.map(([label, amount]) => `<tr><td>${esc(label)}</td><td class="r">${moneyExact(amount)}</td></tr>`).join("")}
        <tr class="grand"><td>Total</td><td class="r">${moneyExact(invoice.total)}</td></tr>
      </table>
    </div>
    <div class="sign"><div class="muted">Tax is not payable on reverse charge.</div><div class="r">${esc(invoice.signatory)}</div></div>`;
}

// Prints the invoice in this page (services/print.js); its number names the PDF.
export const printPlanInvoice = (invoice) => printDocument({ title: `Invoice ${invoice.number}`, styles: STYLES, body: planInvoiceHtml(invoice) });
