import { escapeHtml, printDocument } from "../../../../services/print";
import { atFull, dayWords, methodName, monthWords, qty, reading } from "./fuel";

// Printing for a fuel station: a shift's settlement (each nozzle's readings
// and test, what each fuel sold at its price, the credit slips, the takings
// and the cash, the attendant's short or excess, with lines to sign) and a
// fleet customer's statement for a month (each vehicle's fills with their
// slips, the totals, and the account's balance). Times are on the business's
// clock; fuel is outside GST, its price including state VAT.

const BASE = "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} h2{font-size:14px;margin:12px 0 4px} small{color:#555}"
  + " dl{display:grid;grid-template-columns:150px 1fr;gap:3px 12px;margin:6px 0} dt{color:#555}"
  + " table{width:100%;border-collapse:collapse;margin-top:6px} td,th{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top} th{background:#f2f2f2} .r{text-align:right}"
  + " .big{font-size:16px;font-weight:700} .note{font-size:11px;color:#333;margin:6px 0}"
  + " .sign{display:flex;justify-content:space-between;gap:24px;margin-top:34px} .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}";
const money = (biz, value) => escapeHtml(biz.exact(value));
const shopHead = (biz, seller, title) => {
  const s = seller || biz.settings || {};
  return `<h1>${escapeHtml(s.legal_name || s.display_name || biz.business.name)}</h1>
    <small>${escapeHtml([s.address_line1, s.address_line2, s.city, s.postal_code].filter(Boolean).join(", "))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ""}${s.gstin ? ` · GSTIN ${escapeHtml(s.gstin)}` : ""}</small>
    <h2>${escapeHtml(title)}</h2>`;
};

// A closed shift's settlement, for the attendant and the manager to sign.
export function printShift(biz, shift) {
  const close = shift.close;
  const d = Number(close.difference);
  const standing = d < 0 ? `Short ${biz.exact(-d)}` : d > 0 ? `Excess ${biz.exact(d)}` : "Exact";
  const readings = close.readings.map((r) => `<tr><td>${escapeHtml(r.nozzle_no)}</td><td>${escapeHtml(r.product_name)}${r.tank_no ? ` · tank ${escapeHtml(r.tank_no)}` : ""}</td>
    <td class="r">${escapeHtml(reading(r.opening))}</td><td class="r">${escapeHtml(reading(r.closing))}</td><td class="r">${escapeHtml(qty(r.test, r.unit))}</td>
    <td class="r">${escapeHtml(qty(r.litres, r.unit))}</td></tr>`).join("");
  const products = close.products.map((p) => `<tr><td>${escapeHtml(p.product_name)}</td><td class="r">${money(biz, p.price)}</td><td class="r">${escapeHtml(qty(p.litres, p.unit))}</td>
    <td class="r">${escapeHtml(qty(p.credit_litres, p.unit))}</td><td class="r">${escapeHtml(qty(p.walk_in_litres, p.unit))}</td><td class="r">${money(biz, p.amount)}</td></tr>`).join("");
  const slips = close.slips.map((s) => `<tr><td>${escapeHtml(s.customer_name)}</td><td>${escapeHtml(s.registration)}</td><td>${escapeHtml(s.slip_no || "—")}</td>
    <td>${escapeHtml(s.product_name)}</td><td class="r">${escapeHtml(qty(s.litres, s.unit))}</td><td class="r">${money(biz, s.amount)}</td><td>${escapeHtml(s.document_no || "Held for the month")}</td></tr>`).join("");
  const takings = close.takings.map((t) => `<tr><td>${escapeHtml(methodName(t))}${t.reference ? ` · ${escapeHtml(t.reference)}` : ""}</td><td class="r">${money(biz, t.amount)}</td></tr>`).join("");
  printDocument({
    title: `Shift ${shift.shift_no}`,
    styles: `@page{size:A4;margin:12mm} ${BASE}`,
    body: `${shopHead(biz, null, `Shift settlement ${shift.shift_no}`)}
      <dl><dt>Attendant</dt><dd>${escapeHtml(shift.attendant_name)}</dd><dt>Outlet</dt><dd>${escapeHtml(shift.location_name)}</dd>
      <dt>Opened</dt><dd>${escapeHtml(atFull(shift.opened_at, biz))}</dd><dt>Closed</dt><dd>${escapeHtml(atFull(close.closed_at, biz))}${close.closed_by_name ? ` by ${escapeHtml(close.closed_by_name)}` : ""}</dd></dl>
      <h2>Readings</h2><table><thead><tr><th>Nozzle</th><th>Fuel</th><th class="r">Opening</th><th class="r">Closing</th><th class="r">Test pumped back</th><th class="r">Sold</th></tr></thead><tbody>${readings}</tbody></table>
      <h2>Sales at the price in force</h2><table><thead><tr><th>Fuel</th><th class="r">Price</th><th class="r">Sold</th><th class="r">On credit</th><th class="r">Walk-in</th><th class="r">Amount</th></tr></thead><tbody>${products}</tbody></table>
      ${slips ? `<h2>Credit slips</h2><table><thead><tr><th>Customer</th><th>Vehicle</th><th>Slip</th><th>Fuel</th><th class="r">Quantity</th><th class="r">Amount</th><th>Bill</th></tr></thead><tbody>${slips}</tbody></table>` : ""}
      <h2>Money handed in</h2><table><tbody>${takings}<tr><td>Cash counted</td><td class="r">${money(biz, close.cash)}</td></tr></tbody></table>
      <dl><dt>Expected</dt><dd>${money(biz, close.expected)}</dd><dt>Credit sales</dt><dd>${money(biz, close.credit)}</dd><dt>Walk-in sales</dt><dd>${money(biz, close.walk_in)}</dd>
      <dt>Handed in</dt><dd>${money(biz, Number(close.other) + Number(close.cash))}</dd><dt>Attendant</dt><dd class="big">${escapeHtml(standing)}</dd></dl>
      ${close.note ? `<p class="note">${escapeHtml(close.note)}</p>` : ""}
      <p class="note">Fuel is outside GST: its price includes state VAT. The 5-litre test is poured back into the tank and is not a sale.</p>
      <div class="sign"><span>Attendant</span><span>Manager</span></div>`,
  });
}

// A fleet customer's statement for a month: the fills vehicle by vehicle.
export function printStatement(biz, statement) {
  const c = statement.customer;
  const vehicles = statement.vehicles.map((v) => `<h2>${escapeHtml(v.registration)}</h2>
    <table><thead><tr><th>Date</th><th>Slip</th><th>Fuel</th><th class="r">Quantity</th><th class="r">Price</th><th class="r">Amount</th><th>Bill</th></tr></thead><tbody>
    ${v.fills.map((f) => `<tr><td>${escapeHtml(dayWords(f.day))}</td><td>${escapeHtml(f.slip_no || "—")}</td><td>${escapeHtml(f.product_name)}</td><td class="r">${escapeHtml(qty(f.litres, f.unit))}</td>
      <td class="r">${money(biz, f.price)}</td><td class="r">${money(biz, f.amount)}</td><td>${escapeHtml(f.document_no)}</td></tr>`).join("")}
    <tr><td colspan="5"><strong>${escapeHtml(v.registration)}</strong></td><td class="r"><strong>${money(biz, v.amount)}</strong></td><td></td></tr></tbody></table>`).join("");
  const totals = statement.totals.map((t) => `<tr><td>${escapeHtml(t.product)}</td><td class="r">${escapeHtml(qty(t.litres, t.unit))}</td><td class="r">${money(biz, t.amount)}</td></tr>`).join("");
  printDocument({
    title: `${c.name} · ${monthWords(statement.month)}`,
    styles: `@page{size:A4;margin:12mm} ${BASE}`,
    body: `${shopHead(biz, statement.seller, `Fleet statement for ${monthWords(statement.month)}`)}
      <dl><dt>Customer</dt><dd>${escapeHtml(c.name)}${c.phone ? ` · ${escapeHtml(c.phone)}` : ""}</dd>${c.gstin ? `<dt>GSTIN</dt><dd>${escapeHtml(c.gstin)}</dd>` : ""}
      <dt>Period</dt><dd>${escapeHtml(dayWords(statement.from))} to ${escapeHtml(dayWords(statement.to))}</dd></dl>
      ${vehicles || "<p>No fills this month.</p>"}
      ${totals ? `<h2>The month</h2><table><thead><tr><th>Fuel</th><th class="r">Quantity</th><th class="r">Amount</th></tr></thead><tbody>${totals}
        <tr><td colspan="2"><strong>${statement.fills} ${statement.fills === 1 ? "fill" : "fills"}</strong></td><td class="r"><strong>${money(biz, statement.amount)}</strong></td></tr></tbody></table>` : ""}
      ${statement.ledger ? `<dl><dt>Opening balance</dt><dd>${money(biz, statement.ledger.opening)}</dd><dt>Billed</dt><dd>${money(biz, statement.ledger.debit)}</dd>
        <dt>Paid and credited</dt><dd>${money(biz, statement.ledger.credit)}</dd><dt>Balance</dt><dd class="big">${money(biz, statement.ledger.closing)}</dd></dl>`
    : `<dl><dt>Owed now</dt><dd class="big">${money(biz, c.balance)}</dd></dl>`}
      <p class="note">Fuel is outside GST: its price includes state VAT.</p>`,
  });
}
