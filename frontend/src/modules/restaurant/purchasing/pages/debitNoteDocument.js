import { escapeHtml, printDocument } from "../../../../services/print";
import { moneyExact } from "../../../../services/format";
import { niceDate, qty } from "../../inventory/pages/stockFormat";

// A purchase return printed as a debit note (sweep SW-B-23): what the
// restaurant sends the supplier with the goods going back, so the supplier
// issues a credit. Number and date, both parties with their GSTINs, the bill
// the goods came on, each line's quantity, rate, taxable value and GST, GST
// by rate, the total and the reason. A reprint carries the same number (it is
// the return's own); a voided return prints with CANCELLED across it.
//
// Both GSTINs starting with the same two digits (one state): GST splits into
// CGST and SGST; otherwise it is IGST. A line's amount includes its GST.

const r2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const sameState = (a, b) => Boolean(a && b && String(a).slice(0, 2) === String(b).slice(0, 2));

const rateGroups = (items) => {
  const groups = new Map();

  for (const item of items) {
    const rate = Number(item.taxRate || 0);
    const group = groups.get(rate) || { rate, taxable: 0, tax: 0 };
    group.taxable = r2(group.taxable + Number(item.amount) - Number(item.taxAmount || 0));
    group.tax = r2(group.tax + Number(item.taxAmount || 0));
    groups.set(rate, group);
  }

  return [...groups.values()].sort((a, b) => a.rate - b.rate);
};

const A4 = `
  body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; }
  .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 10px; }
  h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: .06em; }
  h2 { font-size: 14px; margin: 0 0 2px; }
  .muted { color: #555; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 14px 0 8px; }
  .parties > div { border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #555; margin-bottom: 2px; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 6px 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #ccc; padding: 5px 6px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
  .r { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; border-top: 2px solid #111; border-bottom: 0; }
  .gst { width: 60%; margin-left: auto; }
  .reason { margin-top: 12px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; }
  .sign { margin-top: 48px; display: flex; justify-content: space-between; gap: 24px; }
  .sign div { border-top: 1px solid #111; padding-top: 4px; min-width: 180px; text-align: center; }
  .stamp { position: fixed; top: 38%; left: 0; right: 0; text-align: center; font-size: 84px; font-weight: 800;
           color: rgba(200, 0, 0, .14); transform: rotate(-24deg); letter-spacing: .1em; pointer-events: none; }
  .void { color: #a00; font-weight: 700; margin-top: 6px; }`;

const SLIP = `
  body { font-family: ui-monospace, "Courier New", monospace; font-size: 11px; color: #000; width: 72mm; }
  h1 { font-size: 15px; text-align: center; margin: 0; letter-spacing: .08em; }
  .c { text-align: center; }
  .muted { color: #333; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .tot td { font-weight: 700; border-top: 1px dashed #000; padding-top: 4px; }
  .void { text-align: center; font-weight: 700; font-size: 14px; letter-spacing: .1em; border: 2px solid #000; margin: 6px 0; padding: 2px; }`;

// note: the return as GET /purchase-returns/:id gives it (items included).
// place: { name, address, gstin, currency }
export const printDebitNote = (note, place, { compact = false } = {}) => {
  const currency = place.currency || "₹";
  const money = (value) => moneyExact(value, currency);
  const voided = note.status === "void";
  const intra = sameState(place.gstin, note.supplierGstin);
  const groups = rateGroups(note.items || []);
  const against = note.billNumber
    ? `Bill ${escapeHtml(note.billNumber)}${note.billDate ? ` dated ${escapeHtml(niceDate(note.billDate))}` : ""}`
    : note.receiptNumber
      ? `Goods receipt ${escapeHtml(note.receiptNumber)}`
      : note.poNumber
        ? `Order ${escapeHtml(note.poNumber)}`
        : "No bill (goods returned on account)";

  if (compact) {
    const body = `
      <h1>DEBIT NOTE</h1>
      <div class="c"><strong>${escapeHtml(place.name)}</strong></div>
      ${place.gstin ? `<div class="c">GSTIN ${escapeHtml(place.gstin)}</div>` : ""}
      ${voided ? `<div class="void">CANCELLED</div>` : ""}
      <hr />
      <div>No. <strong>${escapeHtml(note.returnNumber)}</strong> · ${escapeHtml(niceDate(note.returnDate))}</div>
      <div>To: ${escapeHtml(note.supplierName)}</div>
      ${note.supplierGstin ? `<div>GSTIN ${escapeHtml(note.supplierGstin)}</div>` : ""}
      <div class="muted">Against: ${against}</div>
      <hr />
      <table>
        ${(note.items || [])
          .map(
            (item) => `<tr><td>${escapeHtml(item.itemName)}<br /><span class="muted">${escapeHtml(qty(item.quantity, item.unitShortName))} × ${money(item.unitPrice)}${
              item.taxRate ? ` + ${item.taxRate}%` : ""
            }</span></td><td class="r">${money(item.amount)}</td></tr>`
          )
          .join("")}
        <tr class="tot"><td>Taxable</td><td class="r">${money(note.taxableAmount)}</td></tr>
        ${groups
          .filter((group) => group.tax > 0)
          .map((group) => `<tr><td>GST ${group.rate}%</td><td class="r">${money(group.tax)}</td></tr>`)
          .join("")}
        <tr class="tot"><td>Credit due</td><td class="r">${money(note.totalAmount)}</td></tr>
      </table>
      <hr />
      <div>Reason: ${escapeHtml(note.reason || "—")}</div>
      ${voided ? `<div class="muted">Cancelled: ${escapeHtml(note.voidReason || "")}</div>` : ""}
      <br /><div>Received by (supplier): ____________</div>`;

    printDocument({ title: `Debit note ${note.returnNumber}`, styles: SLIP, body });
    return;
  }

  const gstRows = groups
    .map((group) =>
      intra
        ? `<tr><td>${group.rate}%</td><td class="r">${money(group.taxable)}</td><td class="r">${money(r2(group.tax / 2))}</td><td class="r">${money(
            r2(group.tax - r2(group.tax / 2))
          )}</td><td class="r">${money(group.tax)}</td></tr>`
        : `<tr><td>${group.rate}%</td><td class="r">${money(group.taxable)}</td><td class="r">${money(group.tax)}</td><td class="r">${money(group.tax)}</td></tr>`
    )
    .join("");

  const body = `
    ${voided ? `<div class="stamp">CANCELLED</div>` : ""}
    <div class="head">
      <div>
        <h1>DEBIT NOTE</h1>
        <div class="muted">For goods returned to the supplier</div>
        ${voided ? `<div class="void">Cancelled${note.voidReason ? `: ${escapeHtml(note.voidReason)}` : ""}</div>` : ""}
      </div>
      <div style="text-align:right">
        <div><strong>${escapeHtml(note.returnNumber)}</strong></div>
        <div>Date ${escapeHtml(niceDate(note.returnDate))}</div>
      </div>
    </div>
    <div class="parties">
      <div>
        <div class="label">From</div>
        <h2>${escapeHtml(place.name)}</h2>
        ${place.address ? `<div>${escapeHtml(place.address)}</div>` : ""}
        ${place.gstin ? `<div>GSTIN ${escapeHtml(place.gstin)}</div>` : `<div class="muted">GSTIN not on record</div>`}
      </div>
      <div>
        <div class="label">To (supplier)</div>
        <h2>${escapeHtml(note.supplierName)}</h2>
        ${note.supplierAddress ? `<div>${escapeHtml(note.supplierAddress)}</div>` : ""}
        ${note.supplierGstin ? `<div>GSTIN ${escapeHtml(note.supplierGstin)}</div>` : `<div class="muted">Unregistered supplier</div>`}
      </div>
    </div>
    <div class="facts">
      <span><span class="label">Against</span><br />${against}</span>
      ${note.goodsArrivedOn ? `<span><span class="label">Goods received</span><br />${escapeHtml(niceDate(note.goodsArrivedOn))}</span>` : ""}
      <span><span class="label">Prepared by</span><br />${escapeHtml(note.createdByName || "—")}</span>
    </div>
    <table>
      <thead><tr><th>#</th><th>Item</th><th class="r">Quantity</th><th class="r">Rate</th><th class="r">Taxable value</th><th class="r">GST</th><th class="r">Amount</th></tr></thead>
      <tbody>
        ${(note.items || [])
          .map(
            (item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.itemName)}</td><td class="r">${escapeHtml(
              qty(item.quantity, item.unitShortName)
            )}</td><td class="r">${money(item.unitPrice)}</td><td class="r">${money(r2(item.amount - (item.taxAmount || 0)))}</td><td class="r">${
              item.taxRate ? `${item.taxRate}% · ${money(item.taxAmount)}` : "—"
            }</td><td class="r">${money(item.amount)}</td></tr>`
          )
          .join("")}
      </tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="r">${money(note.taxableAmount)}</td><td class="r">${money(note.taxAmount)}</td><td class="r">${money(note.totalAmount)}</td></tr></tfoot>
    </table>
    ${
      groups.some((group) => group.tax > 0)
        ? `<table class="gst">
      <thead><tr><th>GST rate</th><th class="r">Taxable</th>${intra ? `<th class="r">CGST</th><th class="r">SGST</th>` : `<th class="r">IGST</th>`}<th class="r">GST</th></tr></thead>
      <tbody>${gstRows}</tbody>
    </table>`
        : ""
    }
    <div class="reason"><span class="label">Reason for return</span><br />${escapeHtml(note.reason || "—")}${
      note.notes ? `<br /><span class="muted">${escapeHtml(note.notes)}</span>` : ""
    }</div>
    <p><strong>Credit due from the supplier: ${money(note.totalAmount)}</strong></p>
    <div class="sign"><div>For ${escapeHtml(place.name)}</div><div>Received by (supplier)</div></div>`;

  printDocument({ title: `Debit note ${note.returnNumber}`, styles: A4, body });
};
