import { escapeHtml, printDocument } from "../../../../services/print";
import { barcodeSvg } from "../../retail/services/barcode";
import { RATE_KINDS, atFull, dateWords, idWords, nightCount, partyWords, wordOf, GENDERS } from "./lodging";

// Printing for a lodging business: the registration card a guest signs at
// check-in (the stay, the room, every occupant with their photo ID — of an
// Aadhaar only the last four digits — and a foreigner's passport, visa or OCI
// card, arrival in India and next destination, the property's terms); the
// guest register for the local police, every occupant of the stays between two
// dates with their ID details; and the slip for money handed back. Times are on
// the business's clock.

const bars = (code, height = 40) => { try { return barcodeSvg(code, { height }).svg; } catch { return ""; } };
const BASE = "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} h2{font-size:14px;margin:10px 0 4px} small{color:#555}"
  + " .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px} .bc{width:190px;height:44px} .bc svg{width:100%;height:100%}"
  + " dl{display:grid;grid-template-columns:150px 1fr;gap:3px 12px;margin:6px 0} dt{color:#555}"
  + " table{width:100%;border-collapse:collapse;margin-top:6px} td,th{border:1px solid #bbb;padding:3px 5px;text-align:left;vertical-align:top} th{background:#f2f2f2} .r{text-align:right}"
  + " .big{font-size:17px;font-weight:700} .note{font-size:11px;color:#333;margin:6px 0} .terms{white-space:pre-wrap;font-size:11px;border:1px solid #bbb;padding:6px;margin-top:8px}"
  + " .sign{display:flex;justify-content:space-between;gap:24px;margin-top:34px} .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}";
const shopName = (biz) => biz.settings.display_name || biz.business.name;
const money = (biz, value) => escapeHtml(biz.exact(value));
const METHOD_WORDS = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", cheque: "Cheque" };
const methodText = (row) => `${escapeHtml(row.method_name || METHOD_WORDS[row.method] || row.method || "")}${row.reference ? ` · ${escapeHtml(row.reference)}` : ""}`;

function shopHead(biz, seller, title, code) {
  const s = seller || biz.settings || {};
  const svg = code ? bars(code) : "";
  return `<div class="head"><div><h1>${escapeHtml(s.legal_name || s.display_name || biz.business.name)}</h1>
    <small>${escapeHtml([s.address_line1, s.address_line2, s.city, s.postal_code].filter(Boolean).join(", "))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ""}${s.gstin ? ` · GSTIN ${escapeHtml(s.gstin)}` : ""}</small>
    <h2>${escapeHtml(title)}</h2></div>${svg ? `<div class="bc">${svg}</div>` : ""}</div>`;
}
// A foreigner's papers: passport, visa or OCI card, arrival in India, next destination.
const foreignWords = (g) => (g.foreigner ? [g.id_ref ? `Passport ${g.id_ref}` : null, g.visa_type ? `${g.visa_type}${g.visa_no ? ` ${g.visa_no}` : ""}` : null,
  g.arrived_india_on ? `in India from ${dateWords(g.arrived_india_on)}` : null, g.next_destination ? `next: ${g.next_destination}` : null].filter(Boolean).join(" · ") : "");
const personWords = (g) => [wordOf(GENDERS, g.gender || ""), g.age !== null && g.age !== undefined ? `${g.age} yrs` : null, g.child ? "child" : null]
  .filter((x) => x && x !== "Not said").join(", ");

// The registration card of a stay, for the guest to sign.
export function printRegistrationCard(biz, stay) {
  const showMoney = stay.money !== false;
  const nights = nightCount(stay.arrival, stay.departure);
  const rows = (stay.guests || []).map((g) => `<tr><td>${escapeHtml(g.seq)}</td><td><strong>${escapeHtml(g.full_name)}</strong>${personWords(g) ? `<br><small>${escapeHtml(personWords(g))}</small>` : ""}</td>
    <td>${escapeHtml(g.nationality)}</td><td>${escapeHtml(g.foreigner ? foreignWords(g) : idWords(g.id_kind, g.id_ref))}</td>
    <td>${escapeHtml([g.phone, g.address].filter(Boolean).join(" · "))}</td></tr>`).join("");
  const rate = stay.agreed_rate ? `${RATE_KINDS.agreed}: ${biz.exact(stay.agreed_rate)} a night` : `${biz.exact(stay.rack_rate)} a night${stay.weekend_rate ? `, ${biz.exact(stay.weekend_rate)} on weekend nights` : ""}`;
  printDocument({
    title: `${stay.stay_no} registration`,
    styles: `@page{size:A4;margin:12mm} ${BASE}`,
    body: `${shopHead(biz, stay.seller, `Registration card ${stay.stay_no}`, stay.stay_no)}
      <dl><dt>Guest</dt><dd>${escapeHtml(stay.guest_name)}${stay.guest_phone ? ` · ${escapeHtml(stay.guest_phone)}` : ""}</dd>
      ${stay.bill_to_name ? `<dt>Billed to</dt><dd>${escapeHtml(stay.bill_to_name)}${stay.bill_to_gstin ? ` · GSTIN ${escapeHtml(stay.bill_to_gstin)}` : ""}</dd>` : ""}
      <dt>Room</dt><dd><strong>${escapeHtml(stay.room_no || "—")}</strong> · ${escapeHtml(stay.room_type)} · ${escapeHtml(partyWords(stay.adults, stay.children))}${Number(stay.extra_beds) ? ` · ${escapeHtml(stay.extra_beds)} extra bed` : ""}</dd>
      <dt>Arrival</dt><dd>${escapeHtml(dateWords(stay.arrival))}${stay.checked_in_at ? ` · checked in ${escapeHtml(atFull(stay.checked_in_at, biz))}` : ""}</dd>
      <dt>Departure</dt><dd>${escapeHtml(dateWords(stay.departure))} · ${nights} ${nights === 1 ? "night" : "nights"}</dd>
      ${stay.arrived_from || stay.going_to ? `<dt>Coming from / going to</dt><dd>${escapeHtml(stay.arrived_from || "—")} / ${escapeHtml(stay.going_to || "—")}</dd>` : ""}
      ${stay.purpose ? `<dt>Purpose of the visit</dt><dd>${escapeHtml(stay.purpose)}</dd>` : ""}
      ${showMoney ? `<dt>Rate</dt><dd>${escapeHtml(rate)} before GST</dd>` : ""}
      ${showMoney && Number(stay.advance_summary?.taken || 0) ? `<dt>Advance paid</dt><dd>${money(biz, stay.advance_summary.taken)}</dd>` : ""}</dl>
      <table><thead><tr><th>#</th><th>Occupant</th><th>Nationality</th><th>Photo ID / passport and visa</th><th>Phone and address</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Recorded at check-in</td></tr>'}</tbody></table>
      ${(stay.guests || []).some((g) => g.foreigner) ? '<p class="note">Foreign nationals (OCI cardholders included) are reported on Form-III within 24 hours of arrival and of departure.</p>' : ""}
      ${stay.terms ? `<div class="terms">${escapeHtml(stay.terms)}</div>` : ""}
      <div class="sign"><span>Guest: the details above are correct</span><span>For ${escapeHtml(shopName(biz))}</span></div>`,
  });
}

// The guest register: every occupant of the stays between two dates, with their ID details, for the local police.
export function printGuestRegister(biz, register) {
  const rows = register.items.map((g, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(atFull(g.arrived_at, biz))}</td>
    <td><strong>${escapeHtml(g.full_name)}</strong>${personWords(g) ? `<br><small>${escapeHtml(personWords(g))}</small>` : ""}</td>
    <td>${escapeHtml([g.address, g.phone].filter(Boolean).join(" · "))}</td><td>${escapeHtml(g.nationality)}</td>
    <td>${escapeHtml(g.foreigner ? foreignWords(g) : idWords(g.id_kind, g.id_ref))}</td>
    <td>${escapeHtml(g.room_no || "—")}<br><small>${escapeHtml(g.stay_no)} · ${escapeHtml(partyWords(g.adults, g.children))}</small></td>
    <td>${escapeHtml([g.arrived_from, g.going_to].map((x) => x || "—").join(" → "))}${g.purpose ? `<br><small>${escapeHtml(g.purpose)}</small>` : ""}</td>
    <td>${g.departed_at ? escapeHtml(atFull(g.departed_at, biz)) : "In the house"}</td>
    <td>${g.foreigner ? escapeHtml([g.frro_arrival_ack ? `Arrival ${g.frro_arrival_ack}` : "Arrival not reported", g.departed_at ? (g.frro_departure_ack ? `Departure ${g.frro_departure_ack}` : "Departure not reported") : null].filter(Boolean).join("; ")) : ""}</td></tr>`).join("");
  const period = register.from === register.to ? dateWords(register.from) : `${dateWords(register.from)} to ${dateWords(register.to)}`;
  printDocument({
    title: `Guest register ${register.from}`,
    styles: `@page{size:A4 landscape;margin:10mm} ${BASE} td,th{font-size:10.5px}`,
    body: `${shopHead(biz, register.seller, `Guest register · ${period}`)}
      <p class="note">Every occupant of the rooms, not only the one who booked, with the photo ID seen (of an Aadhaar card only the last four digits are kept). Foreign nationals with their Form-III acknowledgements.</p>
      <table><thead><tr><th>S.No.</th><th>Arrived</th><th>Name</th><th>Address and phone</th><th>Nationality</th><th>Photo ID / passport and visa</th><th>Room</th><th>From → to, purpose</th><th>Left</th><th>Form-III</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="10">No guests in these dates</td></tr>'}</tbody></table>
      <div class="sign"><span>Prepared by</span><span>For ${escapeHtml(shopName(biz))}</span></div>`,
  });
}

// The slip for money handed back from an advance or a deposit, for the guest to sign.
export function printMoneyBack(biz, stay, refund) {
  const deposit = refund.purpose === "deposit";
  printDocument({
    title: refund.refund_no,
    styles: `@page{size:A5;margin:10mm} ${BASE}`,
    body: `${shopHead(biz, stay.seller, `${deposit ? "Deposit handed back" : "Advance refunded"} ${refund.refund_no}`)}
      <dl><dt>Date</dt><dd>${escapeHtml(atFull(refund.created_at, biz))}</dd>
      <dt>Guest</dt><dd>${escapeHtml(stay.guest_name)}</dd>
      <dt>Stay</dt><dd>${escapeHtml(stay.stay_no)}</dd>
      <dt>From receipt</dt><dd>${escapeHtml(refund.collection_no || "")}</dd>
      <dt>Handed back by</dt><dd>${methodText(refund)}</dd>
      <dt>Reason</dt><dd>${escapeHtml(refund.reason || "")}</dd>
      ${refund.approved_by_name ? `<dt>Approved by</dt><dd>${escapeHtml(refund.approved_by_name)}</dd>` : ""}
      <dt>Amount</dt><dd class="big">${money(biz, refund.amount)}</dd></dl>
      <div class="sign"><span>Received by the guest</span><span>For ${escapeHtml(shopName(biz))}</span></div>`,
  });
}
