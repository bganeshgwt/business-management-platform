import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort } from "@bmp/shared/format";
import { barcodeSvg } from "../../retail/services/barcode";
import { DEPOSIT_NOTE, FUELS, atFull, idWords, lineWords, wordOf } from "./rentals";
import { privacyLine } from "../../../personal-data/printLine";

// Printing for a rental business: the quote, the booking slip and the
// handover slip (every line with its unit, period and hire, the deposit asked,
// the late fee rule; at the handover what was noted about each, its meter and
// fuel, the hirer's photo ID and driving licence, with lines to sign), the
// deposit receipt (no GST: a refundable deposit is not a payment for the hire)
// and the slip for money handed back. Times are on the business's clock.

const bars = (code, height = 40) => { try { return barcodeSvg(code, { height }).svg; } catch { return ""; } };
const BASE = "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} h2{font-size:14px;margin:10px 0 4px} small{color:#555}"
  + " .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px} .bc{width:190px;height:44px} .bc svg{width:100%;height:100%}"
  + " dl{display:grid;grid-template-columns:130px 1fr;gap:3px 12px;margin:6px 0} dt{color:#555}"
  + " table{width:100%;border-collapse:collapse;margin-top:6px} td,th{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top} th{background:#f2f2f2} .r{text-align:right}"
  + " .big{font-size:17px;font-weight:700} .note{font-size:11px;color:#333;margin:6px 0} .terms{white-space:pre-wrap;font-size:11px;border:1px solid #bbb;padding:6px;margin-top:8px}"
  + " .sign{display:flex;justify-content:space-between;gap:24px;margin-top:34px} .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}";
const money = (biz, value) => escapeHtml(biz.exact(value));
const shopName = (biz) => biz.settings.display_name || biz.business.name;
const METHOD_WORDS = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", cheque: "Cheque" };
const methodText = (row) => `${escapeHtml(row.method_name || METHOD_WORDS[row.method] || row.method || "")}${row.reference ? ` · ${escapeHtml(row.reference)}` : ""}`;

function shopHead(biz, seller, title, code) {
  const s = seller || biz.settings || {};
  const svg = code ? bars(code) : "";
  return `<div class="head"><div><h1>${escapeHtml(s.legal_name || s.display_name || biz.business.name)}</h1>
    <small>${escapeHtml([s.address_line1, s.address_line2, s.city, s.postal_code].filter(Boolean).join(", "))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ""}${s.gstin ? ` · GSTIN ${escapeHtml(s.gstin)}` : ""}</small>
    <h2>${escapeHtml(title)}</h2></div>${svg ? `<div class="bc">${svg}</div>` : ""}</div>`;
}

// The late fee rule of a line, as the hirer is told it: "₹400 an hour (or part of one) after 30 minutes".
function lateRule(biz, line) {
  if (line.late_per === "none" || !line.late_rate) return null;
  const grace = Number(line.grace_minutes || 0);
  return `${lineWords(line)}: ${biz.exact(line.late_rate)} ${line.late_per === "hour" ? "an hour" : "a day"} (or part of one) late${line.quantity > 1 ? ", for each one" : ""}${grace ? `, after ${grace} minutes' grace` : ""}`;
}

// What was noted about a line at the handover: the note, its meter and its fuel.
function handedOver(line) {
  const parts = [line.out_note, line.meter_out !== null && line.meter_out !== undefined ? `${line.meter === "hours" ? "Hour meter" : "Odometer"} ${Number(line.meter_out)}` : null,
    line.fuel_out ? `Fuel ${wordOf(FUELS, line.fuel_out).toLowerCase()}` : null].filter(Boolean);
  return parts.length ? parts.map(escapeHtml).join("<br>") : "Nothing noted";
}

// The quote, the booking slip (kind "quote" | "booking") or the handover slip ("handover").
export function printBookingSlip(biz, booking, kind = "booking") {
  const showMoney = booking.money !== false;
  const handover = kind === "handover";
  const title = { quote: `Quote ${booking.booking_no}`, booking: `Booking ${booking.booking_no}`, handover: `Handover ${booking.booking_no}` }[kind] || booking.booking_no;
  const rows = booking.lines.map((l) => `<tr><td><strong>${escapeHtml(l.item_name)}</strong>${l.unit_id ? `<br><small>${escapeHtml(l.unit_label)}${l.serial_no ? ` · ${escapeHtml(l.serial_no)}` : ""}</small>` : ""}</td>
    <td>${l.unit_id ? "1" : escapeHtml(l.quantity)}</td><td>${escapeHtml(l.period)}</td>
    ${showMoney ? `<td class="r">${money(biz, l.amount)}<br><small>GST ${escapeHtml(Number(l.tax_rate))}%</small></td><td class="r">${Number(l.deposit_each) ? money(biz, Number(l.deposit_each) * Number(l.quantity)) : "—"}</td>` : ""}
    ${handover ? `<td>${handedOver(l)}</td>` : ""}</tr>`).join("");
  const rules = booking.lines.map((l) => lateRule(biz, l)).filter(Boolean);
  const heldDeposit = showMoney ? Number(booking.deposit?.held || 0) : 0;
  const advance = showMoney ? Number(booking.advance_summary?.left || 0) : 0;
  printDocument({
    title,
    styles: `@page{size:A4;margin:12mm} ${BASE}`,
    body: `${shopHead(biz, booking.seller, title, booking.booking_no)}
      <dl><dt>Hirer</dt><dd>${escapeHtml(booking.customer_name)}${booking.customer_phone ? ` · ${escapeHtml(booking.customer_phone)}` : ""}</dd>
      <dt>Goes out</dt><dd>${escapeHtml(atFull(booking.out_at, biz))}</dd>
      <dt>Due back by</dt><dd><strong>${escapeHtml(atFull(booking.due_at, biz))}</strong></dd>
      ${handover ? `<dt>Handed over</dt><dd>${escapeHtml(atFull(booking.checked_out_at, biz))}${booking.checked_out_by_name ? ` by ${escapeHtml(booking.checked_out_by_name)}` : ""}</dd>` : ""}
      ${handover && booking.id_kind ? `<dt>Photo ID seen</dt><dd>${escapeHtml(idWords(booking.id_kind, booking.id_ref))}</dd>` : ""}
      ${handover && booking.licence_no ? `<dt>Driving licence</dt><dd>${escapeHtml(booking.licence_no)}, valid until ${escapeHtml(dateShort(booking.licence_valid_until, { year: true }))}</dd>` : ""}
      ${booking.location_name && biz.locations.length > 1 ? `<dt>From</dt><dd>${escapeHtml(booking.location_name)}</dd>` : ""}</dl>
      <table><thead><tr><th>Item</th><th>How many</th><th>Charged for</th>${showMoney ? '<th class="r">Hire</th><th class="r">Deposit</th>' : ""}${handover ? "<th>At the handover</th>" : ""}</tr></thead>
      <tbody>${rows}</tbody></table>
      ${showMoney ? `<dl><dt>Hire</dt><dd><strong>${money(biz, booking.total)}</strong> ${booking.tax_mode === "inclusive" ? "including" : "with"} GST ${money(biz, booking.tax)}</dd>
        ${Number(booking.deposit_due) ? `<dt>Deposit asked</dt><dd>${money(biz, booking.deposit_due)}${heldDeposit ? ` · ${money(biz, heldDeposit)} held` : ""}</dd>` : ""}
        ${handover && booking.deposit_waiver ? `<dt>Less deposit</dt><dd>${escapeHtml(booking.deposit_waived_by_name || "")} agreed: ${escapeHtml(booking.deposit_waiver)}</dd>` : ""}
        ${advance ? `<dt>Advance paid</dt><dd>${money(biz, advance)}</dd>` : ""}</dl>` : ""}
      ${rules.length ? `<p class="note"><strong>Late fee:</strong> ${rules.map(escapeHtml).join("; ")}.</p>` : ""}
      ${showMoney && Number(booking.deposit_due) ? `<p class="note">${escapeHtml(DEPOSIT_NOTE)}</p>` : ""}
      ${kind === "quote" ? `<p class="note">A quote holds nothing: the items are held once it is reserved.</p>` : ""}
      ${booking.notes ? `<p class="note">${escapeHtml(booking.notes)}</p>` : ""}
      ${booking.terms ? `<div class="terms">${escapeHtml(booking.terms)}</div>` : ""}
      ${privacyLine(biz) ? `<p class="note">${escapeHtml(privacyLine(biz))}</p>` : ""}
      <div class="sign"><span>${handover ? "Hirer: I have received the above in the condition noted" : "Hirer"}</span><span>For ${escapeHtml(shopName(biz))}</span></div>`,
  });
}

// The receipt for a deposit: money held for the booking, with no GST.
export function printDepositReceipt(biz, booking, receipt) {
  printDocument({
    title: `${receipt.collection_no} deposit`,
    styles: `@page{size:A5;margin:10mm} ${BASE}`,
    body: `${shopHead(biz, booking.seller, `Deposit receipt ${receipt.collection_no}`)}
      <dl><dt>Date</dt><dd>${escapeHtml(atFull(receipt.created_at, biz))}</dd>
      <dt>Received from</dt><dd>${escapeHtml(booking.customer_name)}${booking.customer_phone ? ` · ${escapeHtml(booking.customer_phone)}` : ""}</dd>
      <dt>For booking</dt><dd>${escapeHtml(booking.booking_no)} · ${escapeHtml(booking.lines.map(lineWords).join(", "))}</dd>
      <dt>Due back by</dt><dd>${escapeHtml(atFull(booking.due_at, biz))}</dd>
      <dt>Paid by</dt><dd>${methodText(receipt)}</dd>
      <dt>Refundable deposit</dt><dd class="big">${money(biz, receipt.amount)}</dd></dl>
      <p class="note">${escapeHtml(DEPOSIT_NOTE)} No GST is charged on this receipt.</p>
      ${privacyLine(biz) ? `<p class="note">${escapeHtml(privacyLine(biz))}</p>` : ""}
      <div class="sign"><span>Hirer</span><span>For ${escapeHtml(shopName(biz))}</span></div>`,
  });
}

// The slip for money handed back from a deposit or an advance, for the hirer to sign.
export function printMoneyBack(biz, booking, refund) {
  const deposit = refund.purpose !== "advance";
  printDocument({
    title: refund.refund_no,
    styles: `@page{size:A5;margin:10mm} ${BASE}`,
    body: `${shopHead(biz, booking.seller, `${deposit ? "Deposit handed back" : "Advance refunded"} ${refund.refund_no}`)}
      <dl><dt>Date</dt><dd>${escapeHtml(atFull(refund.created_at, biz))}</dd>
      <dt>Hirer</dt><dd>${escapeHtml(booking.customer_name)}</dd>
      <dt>Booking</dt><dd>${escapeHtml(booking.booking_no)}</dd>
      <dt>From receipt</dt><dd>${escapeHtml(refund.collection_no || "")}</dd>
      <dt>Handed back by</dt><dd>${methodText(refund)}</dd>
      <dt>Reason</dt><dd>${escapeHtml(refund.reason || "")}</dd>
      ${refund.approved_by_name ? `<dt>Approved by</dt><dd>${escapeHtml(refund.approved_by_name)}</dd>` : ""}
      <dt>Amount</dt><dd class="big">${money(biz, refund.amount)}</dd></dl>
      <div class="sign"><span>Received by the hirer</span><span>For ${escapeHtml(shopName(biz))}</span></div>`,
  });
}
