import { escapeHtml, printDocument } from "../../../../services/print";
import { moneyExact } from "../../../../services/format";
import { niceDate, qty, unitMoney } from "../../inventory/pages/stockFormat";
import { dayMonth } from "../../../../services/dates";

// A purchase order as it goes to the supplier: printed, saved as a PDF from
// the print dialog, or sent as a message. Suppliers in India mostly take
// orders on WhatsApp, so the message form matters as much as the paper one.

const lineQuantity = (line) =>
  line.packName && line.packQuantity
    ? `${qty(line.packQuantity)} × ${line.packName} (${qty(line.quantity, line.unitShortName)})`
    : qty(line.quantity, line.unitShortName);

const linePrice = (line, currency) =>
  line.packName && line.packPrice !== null
    ? `${moneyExact(line.packPrice, currency)} / ${line.packName}`
    : `${unitMoney(line.unitPrice, currency)} / ${line.unitShortName}`;

// An order that was over the approval limit says who approved it, when, and
// for what total — the supplier and the store both see it was signed off.
const approvalLine = (order, currency) => {
  const approval = order.approval || {};

  if (!approval.approvedAt) {
    return "";
  }

  // The app's own month names ("Sep"), not the browser's "Sept".
  const when = `${dayMonth(approval.approvedAt, { year: true })}, ${dayMonth(approval.approvedAt, { time: true }).split(", ").pop()}`;
  const amount = approval.approvedAmount !== null && approval.approvedAmount !== undefined
    ? ` for ${moneyExact(approval.approvedAmount, currency)}`
    : "";

  return `<p class="approved"><strong>Approved</strong> by ${escapeHtml(approval.approvedByName || "an approver")} on ${escapeHtml(
    when.replace("Sept", "Sep")
  )}${amount}${approval.note ? ` · “${escapeHtml(approval.note)}”` : ""}</p>`;
};

export const printPurchaseOrder = (order, { restaurantName, gstNumber, currency }) =>
  printDocument({
    title: `${order.poNumber} ${order.supplierName}`,
    styles: `
      body { font-family: system-ui, sans-serif; font-size: 12.5px; color: #111; }
      .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 10px; }
      h1 { font-size: 20px; margin: 0; letter-spacing: .02em; }
      h2 { font-size: 14px; margin: 0 0 2px; }
      .muted { color: #555; }
      .to { margin: 14px 0; display: flex; justify-content: space-between; gap: 24px; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td { border-bottom: 1px solid #ccc; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #f2f2f2; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
      .r { text-align: right; }
      tfoot td { font-weight: 700; border-top: 2px solid #111; border-bottom: 0; }
      .sign { margin-top: 48px; display: flex; justify-content: space-between; }
      .sign div { border-top: 1px solid #111; padding-top: 4px; min-width: 180px; text-align: center; }
      .approved { margin-top: 14px; padding: 6px 10px; border: 1px solid #2a7a4b; border-radius: 6px; color: #1d5c37; }
      .draft { position: fixed; top: 40%; left: 0; right: 0; text-align: center; font-size: 96px; font-weight: 800;
               color: rgba(200, 0, 0, .12); transform: rotate(-24deg); letter-spacing: .1em; pointer-events: none; }`,
    body: `
      ${order.poStatus === "draft" ? '<div class="draft">DRAFT</div>' : ""}
      ${order.poStatus === "pending_approval" ? '<div class="draft">NOT APPROVED</div>' : ""}
      <div class="head">
        <div>
          <h2>${escapeHtml(restaurantName || "")}</h2>
          ${gstNumber ? `<div class="muted">GSTIN ${escapeHtml(gstNumber)}</div>` : ""}
          <div class="muted">Deliver to: ${escapeHtml(order.storeName || "Main store")}</div>
        </div>
        <div style="text-align:right">
          <h1>${order.poStatus === "draft" ? "DRAFT PURCHASE ORDER" : order.poStatus === "pending_approval" ? "PURCHASE ORDER — AWAITING APPROVAL" : "PURCHASE ORDER"}</h1>
          <div><strong>${escapeHtml(order.poNumber)}</strong></div>
          <div class="muted">Date ${escapeHtml(niceDate(order.orderDate))}</div>
          ${order.expectedDate ? `<div class="muted">Deliver by ${escapeHtml(niceDate(order.expectedDate))}</div>` : ""}
        </div>
      </div>
      <div class="to">
        <div>
          <div class="muted">To</div>
          <strong>${escapeHtml(order.supplierName)}</strong>
          ${order.supplierContact ? `<div>${escapeHtml(order.supplierContact)}</div>` : ""}
          ${order.supplierMobile ? `<div>${escapeHtml(order.supplierMobile)}</div>` : ""}
          ${order.supplierAddress ? `<div class="muted">${escapeHtml(order.supplierAddress)}</div>` : ""}
          ${order.supplierGstin ? `<div class="muted">GSTIN ${escapeHtml(order.supplierGstin)}</div>` : ""}
        </div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Item</th><th class="r">Quantity</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
        <tbody>
          ${order.items
            .map(
              (line, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(line.itemName)}</td><td class="r">${escapeHtml(lineQuantity(line))}</td><td class="r">${escapeHtml(linePrice(line, currency))}</td><td class="r">${moneyExact(line.amount, currency)}</td></tr>`
            )
            .join("")}
        </tbody>
        <tfoot><tr><td colspan="4">Total (before GST)</td><td class="r">${moneyExact(order.totalAmount, currency)}</td></tr></tfoot>
      </table>
      ${order.notes ? `<p><strong>Notes:</strong> ${escapeHtml(order.notes)}</p>` : ""}
      <p class="muted">Please send your bill with the goods, quoting ${escapeHtml(order.poNumber)}. Goods that are damaged, short in weight or not as ordered will be returned.</p>
      ${approvalLine(order, currency)}
      <div class="sign"><div>Prepared by${order.createdByName ? `<br><span class="muted">${escapeHtml(order.createdByName)}</span>` : ""}</div><div>${
        order.approval && order.approval.approvedAt
          ? `Approved by<br><span class="muted">${escapeHtml(order.approval.approvedByName || "")}</span>`
          : "Authorised signatory"
      }</div></div>`,
  });

// The order as a plain message, for WhatsApp or email.
export const orderMessage = (order, { restaurantName, currency }) =>
  [
    `*Purchase order ${order.poNumber}* from ${restaurantName || "us"}`,
    `Date: ${niceDate(order.orderDate)}${order.expectedDate ? ` · deliver by ${niceDate(order.expectedDate)}` : ""}`,
    `Deliver to: ${order.storeName || "Main store"}`,
    "",
    ...order.items.map(
      (line, index) => `${index + 1}. ${line.itemName} — ${lineQuantity(line)} @ ${linePrice(line, currency)}`
    ),
    "",
    `Total (before GST): ${moneyExact(order.totalAmount, currency)}`,
    ...(order.notes ? [`Note: ${order.notes}`] : []),
    "Please send the bill with the goods, quoting the PO number.",
  ].join("\n");

// wa.me needs the number with its country code and nothing else.
export const whatsappLink = (mobile, text) => {
  const digits = String(mobile || "").replace(/\D/g, "");
  const full = digits.length === 10 ? `91${digits}` : digits.replace(/^0+/, "");

  return full ? `https://wa.me/${full}?text=${encodeURIComponent(text)}` : null;
};

export const mailLink = (email, subject, text) =>
  email ? `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}` : null;
