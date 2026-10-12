// Salon round 2 helpers (R2-SVC) shared by the salon screens and repairs.
import { escapeHtml, printDocument } from "../../../../services/print";
import { dateTime } from "../../../../services/format";
import { WEEKDAYS, methodWord } from "./salon";

const hhmm = (t) => (t ? String(t).slice(0, 5) : "");

// "Sat 14:00–18:00 · Sun off": the weekdays that differ from the usual hours.
export function weekText(r) {
  return (r.week || []).map((w) => `${WEEKDAYS[Number(w.dow)]} ${w.off ? "off" : w.works_from ? `${hhmm(w.works_from)}–${hhmm(w.works_to)}` : "salon hours"}`).join(" · ");
}

// A refund receipt the client signs.
export function printRefundReceipt(biz, refund, client) {
  const money = (v) => escapeHtml(biz.exact(v));
  printDocument({
    title: refund.refund_no,
    styles: ".rf{font:13px/1.45 system-ui,sans-serif;color:#000;max-width:520px} .rf h1{font-size:16px;margin:0} .rf h2{font-size:14px;margin:6px 0} .rf table{border-collapse:collapse;width:100%;margin:8px 0} .rf th,.rf td{border-bottom:1px solid #bbb;padding:4px 6px;text-align:left} .rf td:last-child{text-align:right} .rf .big{font-size:18px;font-weight:700} .rf .sign{display:flex;justify-content:space-between;gap:24px;margin-top:40px} .rf .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}",
    body: `<div class="rf"><h1>${escapeHtml(biz.business.name)}</h1><h2>Advance refund ${escapeHtml(refund.refund_no)}</h2>
      <table><tbody>
        <tr><th>Date</th><td>${escapeHtml(dateTime(refund.created_at))}</td></tr>
        <tr><th>Client</th><td>${escapeHtml(client || refund.contact_name || "")}</td></tr>
        <tr><th>From receipt</th><td>${escapeHtml(refund.collection_no)}</td></tr>
        <tr><th>Paid back by</th><td>${escapeHtml(methodWord(refund.method))}${refund.reference ? ` · ${escapeHtml(refund.reference)}` : ""}</td></tr>
        <tr><th>Reason</th><td>${escapeHtml(refund.reason)}</td></tr>
        <tr><th>Approved by</th><td>${escapeHtml(refund.approved_by_name || "")}</td></tr>
        ${refund.left !== undefined ? `<tr><th>Advance left after this</th><td>${money(refund.left)}</td></tr>` : ""}
        <tr><th>Amount refunded</th><td class="big">${money(refund.amount)}</td></tr>
      </tbody></table>
      <div class="sign"><span>Received by the client</span><span>For ${escapeHtml(biz.business.name)}</span></div></div>`,
  });
}

