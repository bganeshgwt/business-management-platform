import { escapeHtml, printDocument } from "../../../../services/print";
import { moneyExact } from "@bmp/shared/format";
import { niceDate, qty } from "./stockFormat";

// A transfer note as it travels with the goods: a delivery challan. Stock
// moved between a restaurant's own stores is not a sale, so the challan says
// so and carries the value at cost (what the goods are worth on the books),
// not a selling price. A4 for the office file, 80 mm for the thermal printer
// at the store door. The receiving store signs it, and — once received — the
// challan shows what arrived and anything short or damaged.

const SHORT_WORDS = { short: "Short", damaged: "Damaged", spoiled: "Spoiled" };

const STATUS_WORDS = {
  in_transit: "IN TRANSIT",
  received: "RECEIVED",
  cancelled: "CANCELLED",
};

const lineRows = (transfer, currency, compact) =>
  transfer.lines
    .map((line, index) => {
      const received =
        line.receivedQuantity !== null && transfer.status === "received"
          ? `<div class="sub">Received ${escapeHtml(qty(line.receivedQuantity, line.unit))}${
              line.shortfallQuantity > 0
                ? ` · ${escapeHtml(SHORT_WORDS[line.shortfallReason] || "Short")} ${escapeHtml(qty(line.shortfallQuantity, line.unit))}${
                    line.shortfallNote ? ` (${escapeHtml(line.shortfallNote)})` : ""
                  }`
                : ""
            }</div>`
          : "";

      return compact
        ? `<tr><td>${escapeHtml(line.itemName)}${received}</td><td class="r">${escapeHtml(qty(line.quantity, line.unit))}</td><td class="r">${moneyExact(line.value, currency)}</td></tr>`
        : `<tr><td>${index + 1}</td><td>${escapeHtml(line.itemName)}${line.itemCode ? ` <span class="muted">${escapeHtml(line.itemCode)}</span>` : ""}${received}</td><td class="r">${escapeHtml(qty(line.quantity, line.unit))}</td><td class="r">${line.unitCost === null ? "—" : moneyExact(line.unitCost, currency)}</td><td class="r">${moneyExact(line.value, currency)}</td></tr>`;
    })
    .join("");

const A4_STYLES = `
  body { font-family: system-ui, sans-serif; font-size: 12.5px; color: #111; }
  .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 10px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: .02em; }
  h2 { font-size: 14px; margin: 0 0 2px; }
  .muted { color: #555; }
  .sub { color: #444; font-size: 11px; margin-top: 2px; }
  .route { margin: 14px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .route div { border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #ccc; padding: 6px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .r { text-align: right; }
  tfoot td { font-weight: 700; border-top: 2px solid #111; border-bottom: 0; }
  .note { margin-top: 10px; }
  .sign { margin-top: 48px; display: flex; justify-content: space-between; gap: 24px; }
  .sign div { border-top: 1px solid #111; padding-top: 4px; min-width: 160px; text-align: center; }
  .stamp { position: fixed; top: 40%; left: 0; right: 0; text-align: center; font-size: 84px; font-weight: 800;
           color: rgba(200, 0, 0, .12); transform: rotate(-24deg); letter-spacing: .1em; pointer-events: none; }`;

const RECEIPT_STYLES = `
  @page { size: 80mm auto; margin: 3mm; }
  body { font-family: "Courier New", monospace; font-size: 11.5px; color: #000; width: 72mm; }
  .c { text-align: center; }
  h1 { font-size: 14px; margin: 4px 0; }
  .muted { color: #333; }
  .sub { font-size: 10.5px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; padding-left: 6px; }
  .total td { font-weight: 700; border-top: 1px dashed #000; padding-top: 4px; }
  .sign { margin-top: 26px; }
  .sign div { border-top: 1px solid #000; padding-top: 2px; margin-top: 22px; text-align: center; }`;

export const printTransfer = (transfer, { restaurantName, gstNumber, currency = "₹", paper = "a4" }) => {
  const stamp = transfer.status === "cancelled" ? '<div class="stamp">CANCELLED</div>' : "";
  const totalLabel = "Value at cost";

  if (paper === "80mm") {
    return printDocument({
      title: `${transfer.transferNumber} challan`,
      styles: RECEIPT_STYLES,
      body: `
        <div class="c">
          <strong>${escapeHtml(restaurantName || "")}</strong>
          ${gstNumber ? `<div>GSTIN ${escapeHtml(gstNumber)}</div>` : ""}
          <h1>DELIVERY CHALLAN</h1>
          <div>${escapeHtml(transfer.transferNumber)} · ${escapeHtml(niceDate(transfer.transferDate))}</div>
          <div>${escapeHtml(STATUS_WORDS[transfer.status] || "")}</div>
        </div>
        <hr />
        <div>From: <strong>${escapeHtml(transfer.fromName)}</strong></div>
        <div>To: <strong>${escapeHtml(transfer.toName)}</strong></div>
        ${transfer.indentNumber ? `<div>Against indent ${escapeHtml(transfer.indentNumber)}</div>` : ""}
        ${transfer.vehicle ? `<div>Vehicle / driver: ${escapeHtml(transfer.vehicle)}</div>` : ""}
        <hr />
        <table>${lineRows(transfer, currency, true)}
          <tr class="total"><td colspan="2">${totalLabel}</td><td class="r">${moneyExact(transfer.sentValue, currency)}</td></tr>
        </table>
        ${transfer.status === "received" && transfer.shortfallValue > 0 ? `<div class="sub">Written off on arrival: ${moneyExact(transfer.shortfallValue, currency)}</div>` : ""}
        <hr />
        <div class="sub">Stock moved between our own stores. Not a sale.</div>
        <div class="sign"><div>Sent by</div><div>Received by</div></div>`,
    });
  }

  return printDocument({
    title: `${transfer.transferNumber} ${transfer.fromName} to ${transfer.toName}`,
    styles: A4_STYLES,
    body: `
      ${stamp}
      <div class="head">
        <div>
          <h2>${escapeHtml(restaurantName || "")}</h2>
          ${gstNumber ? `<div class="muted">GSTIN ${escapeHtml(gstNumber)}</div>` : ""}
        </div>
        <div style="text-align:right">
          <h1>DELIVERY CHALLAN</h1>
          <div><strong>${escapeHtml(transfer.transferNumber)}</strong></div>
          <div class="muted">Date ${escapeHtml(niceDate(transfer.transferDate))}</div>
          <div class="muted">${escapeHtml(STATUS_WORDS[transfer.status] || "")}</div>
        </div>
      </div>
      <div class="route">
        <div><div class="muted">From</div><strong>${escapeHtml(transfer.fromName)}</strong>${transfer.fromAddress ? `<div class="muted">${escapeHtml(transfer.fromAddress)}</div>` : ""}</div>
        <div><div class="muted">To</div><strong>${escapeHtml(transfer.toName)}</strong>${transfer.toAddress ? `<div class="muted">${escapeHtml(transfer.toAddress)}</div>` : ""}</div>
      </div>
      ${transfer.indentNumber ? `<p class="muted">Sent against indent ${escapeHtml(transfer.indentNumber)}</p>` : ""}
      ${transfer.vehicle ? `<p class="muted">Vehicle / driver: ${escapeHtml(transfer.vehicle)}</p>` : ""}
      <table>
        <thead><tr><th>#</th><th>Item</th><th class="r">Quantity</th><th class="r">Cost / unit</th><th class="r">Value</th></tr></thead>
        <tbody>${lineRows(transfer, currency, false)}</tbody>
        <tfoot><tr><td colspan="4">${totalLabel}</td><td class="r">${moneyExact(transfer.sentValue, currency)}</td></tr></tfoot>
      </table>
      ${
        transfer.status === "received"
          ? `<p class="note">Received ${escapeHtml(niceDate(String(transfer.receivedAt || "").slice(0, 10)))}${transfer.receivedByName ? ` by ${escapeHtml(transfer.receivedByName)}` : ""}: ${moneyExact(transfer.receivedValue || 0, currency)} arrived${
              transfer.shortfallValue > 0 ? `, ${moneyExact(transfer.shortfallValue, currency)} short or damaged and written off` : ""
            }.</p>`
          : ""
      }
      ${transfer.status === "cancelled" && transfer.cancelReason ? `<p class="note">Called back: ${escapeHtml(transfer.cancelReason)}</p>` : ""}
      ${transfer.notes ? `<p class="note"><strong>Notes:</strong> ${escapeHtml(transfer.notes)}</p>` : ""}
      <p class="muted">Stock moved between the restaurant's own stores, valued at cost. This is not a sale and carries no GST.</p>
      <div class="sign"><div>Sent by${transfer.dispatchedByName ? ` (${escapeHtml(transfer.dispatchedByName)})` : ""}</div><div>Driver</div><div>Received by</div></div>`,
  });
};
