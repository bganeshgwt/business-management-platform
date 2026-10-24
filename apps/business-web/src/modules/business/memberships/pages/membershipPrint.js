import QRCode from "qrcode";
import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort } from "@bmp/shared/format";
import { runWords } from "./memberships";

// The membership slip: the member, their code as a QR to scan at the desk,
// the plan and its terms as sold, and the refund policy of the version sold,
// for the member to keep and sign. Money shows only to those who see sales.

const STYLES = "@page{size:A5;margin:10mm} body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} h2{font-size:14px;margin:12px 0 4px} small{color:#555}"
  + " .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px} .qr{width:120px;height:120px} .code{font:600 14px ui-monospace,monospace;text-align:center}"
  + " dl{display:grid;grid-template-columns:120px 1fr;gap:3px 12px;margin:6px 0} dt{color:#555} .policy{border:1px solid #bbb;padding:6px 8px;white-space:pre-wrap}"
  + " .sign{display:flex;justify-content:space-between;gap:24px;margin-top:34px} .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}";

export async function printMembership(biz, m, member) {
  let qr = "";
  try {
    qr = member.member_code ? await QRCode.toDataURL(member.member_code, { width: 240, margin: 1, errorCorrectionLevel: "M" }) : "";
  } catch {
    qr = "";
  }
  const s = biz.settings || {};
  const money = m.money !== false;
  const day = (value) => escapeHtml(dateShort(value, { year: true }));
  printDocument({
    title: m.membership_no,
    styles: STYLES,
    body: `<div class="head"><div><h1>${escapeHtml(s.legal_name || s.display_name || biz.business.name)}</h1>
      <small>${escapeHtml([s.address_line1, s.address_line2, s.city, s.postal_code].filter(Boolean).join(", "))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ""}${s.gstin ? ` · GSTIN ${escapeHtml(s.gstin)}` : ""}</small>
      <h2>Membership ${escapeHtml(m.membership_no)}</h2></div>
      ${qr ? `<div><img class="qr" src="${qr}" alt=""><div class="code">${escapeHtml(member.member_code)}</div></div>` : ""}</div>
      <dl><dt>Member</dt><dd><strong>${escapeHtml(member.name)}</strong>${member.phone ? ` · ${escapeHtml(member.phone)}` : ""}</dd>
      <dt>Plan</dt><dd>${escapeHtml(m.plan_name)} · ${escapeHtml(m.term)}</dd>
      <dt>Runs</dt><dd>${escapeHtml(runWords(m))}</dd>
      ${m.grace_days ? `<dt>Grace days</dt><dd>${escapeHtml(m.grace_days)} after the last day</dd>` : ""}
      ${m.max_freezes ? `<dt>Freezes</dt><dd>Up to ${escapeHtml(m.max_freezes)}, ${escapeHtml(m.max_freeze_days)} days in all</dd>` : ""}
      <dt>Passed on</dt><dd>${m.transferable ? "Can be passed on to another member" : "Not passed on to another member"}</dd>
      ${money ? `<dt>Price</dt><dd>${escapeHtml(biz.exact(m.price))} (${escapeHtml(biz.exact(m.price_net))} + GST ${escapeHtml(biz.exact(m.price_tax))})${Number(m.joining_fee) > 0 ? ` · joining fee ${escapeHtml(biz.exact(m.joining_fee))}` : ""}</dd>` : ""}
      ${money && m.bill ? `<dt>Bill</dt><dd>${escapeHtml(m.bill.document_no)}</dd>` : ""}
      <dt>Sold</dt><dd>${day(m.created_at)}</dd></dl>
      <h2>Refund policy (version ${escapeHtml(m.policy_version)})</h2>
      <div class="policy">${escapeHtml(m.policy)}</div>
      <div class="sign"><span>Member</span><span>For ${escapeHtml(s.display_name || biz.business.name)}</span></div>`,
  });
}
