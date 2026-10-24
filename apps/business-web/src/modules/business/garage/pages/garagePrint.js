import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort } from "@bmp/shared/format";
import { barcodeSvg } from "../../retail/services/barcode";
import { FUEL_LEVELS, LINE_KINDS, PAYERS, atWords, km, lineWords, wordOf } from "./garage";

// Printing for a garage: the job card's customer copy (what was booked in, the
// estimate with its prices, the advance and the claim, for the owner to sign)
// and its workshop copy (the work to do, never the prices), and a customer's
// statement of jobs per vehicle.

const fmt = (value) => escapeHtml(dateShort(value, { year: true }));
const BASE = "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} h2{font-size:14px;margin:10px 0 4px} small{color:#555}"
  + " .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px} .bc{width:190px;height:44px} .bc svg{width:100%;height:100%}"
  + " dl{display:grid;grid-template-columns:130px 1fr;gap:3px 12px;margin:6px 0} dt{color:#555}"
  + " table{width:100%;border-collapse:collapse;margin-top:6px} td,th{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top} th{background:#f2f2f2} .r{text-align:right}"
  + " .box{display:inline-block;width:12px;height:12px;border:1px solid #333} .sign{display:flex;justify-content:space-between;gap:24px;margin-top:30px}"
  + " .sign span{flex:1;border-top:1px solid #000;padding-top:4px;font-size:11px}";

function shopHead(biz, seller, title, code) {
  const s = seller || biz.settings || {};
  let bars = "";
  try { bars = code ? barcodeSvg(code).svg : ""; } catch { bars = ""; }
  return `<div class="head"><div><h1>${escapeHtml(s.legal_name || s.display_name || biz.business.name)}</h1>
    <small>${escapeHtml([s.address_line1, s.address_line2, s.city, s.postal_code].filter(Boolean).join(", "))}${s.phone ? ` · ${escapeHtml(s.phone)}` : ""}${s.gstin ? ` · GSTIN ${escapeHtml(s.gstin)}` : ""}</small>
    <h2>${escapeHtml(title)}</h2></div>${bars ? `<div class="bc">${bars}</div>` : ""}</div>`;
}

function facts(job) {
  return `<dl><dt>Vehicle</dt><dd><strong>${escapeHtml(job.registration_no)}</strong> · ${escapeHtml(job.vehicle_name)}</dd>
    <dt>Customer</dt><dd>${escapeHtml(job.customer_name)}${job.customer_phone ? ` · ${escapeHtml(job.customer_phone)}` : ""}</dd>
    <dt>Received</dt><dd>${escapeHtml(atWords(job.created_at))}${job.odometer_in !== null && job.odometer_in !== undefined ? ` · ${escapeHtml(km(job.odometer_in))}` : ""}${job.fuel_level ? ` · fuel ${escapeHtml(wordOf(FUEL_LEVELS, job.fuel_level).toLowerCase())}` : ""}</dd>
    ${job.promised_at ? `<dt>Promised for</dt><dd><strong>${escapeHtml(atWords(job.promised_at))}</strong></dd>` : ""}
    ${job.bay ? `<dt>Bay</dt><dd>${escapeHtml(job.bay)}</dd>` : ""}</dl>
    <h2>What the customer says</h2><ol>${(job.complaints || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>
    ${job.inspection_notes ? `<p><strong>Inspection:</strong> ${escapeHtml(job.inspection_notes)}</p>` : ""}`;
}

// The workshop copy: everything needed to do the work, never the prices.
export function printWorkshopCopy(biz, job, size = "A5") {
  const rows = job.lines.map((l) => `<tr><td><span class="box"></span></td><td>${escapeHtml(wordOf(LINE_KINDS, l.kind))}</td><td>${escapeHtml(lineWords(l))}</td>
    <td class="r">${escapeHtml(`${Number(l.quantity)} ${l.unit}`)}</td></tr>`).join("");
  printDocument({
    title: `${job.job_no} workshop`,
    styles: `@page{size:${size === "A4" ? "A4" : "A5"};margin:10mm} ${BASE}`,
    body: `${shopHead(biz, job.seller, `Job card ${job.job_no} · workshop copy`, job.job_no)}
      ${facts(job)}
      <dl><dt>Mechanics</dt><dd>${escapeHtml(job.mechanics.map((m) => m.name).join(", ") || "—")}</dd></dl>
      <h2>The work</h2>
      ${rows ? `<table><thead><tr><th>Done</th><th></th><th>What</th><th class="r">Qty</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No estimate yet.</p>"}
      ${job.notes ? `<p><strong>Notes:</strong> ${escapeHtml(job.notes)}</p>` : ""}
      <div class="sign"><span>Work done by</span><span>Road test and check</span></div>`,
  });
}

// The customer copy: what was booked in, the estimate with its prices (when
// this person sees money), the advance and the claim; signed by the owner.
export function printCustomerCopy(biz, job, size = "A5") {
  const money = job.money !== false;
  const rows = job.lines.map((l) => `<tr><td>${escapeHtml(lineWords(l))}</td><td class="r">${escapeHtml(`${Number(l.quantity)} ${l.unit}`)}</td>
    ${job.claim ? `<td>${escapeHtml(wordOf(PAYERS, l.payer))}</td>` : ""}${money ? `<td class="r">${escapeHtml(biz.exact(Number(l.net) + Number(l.tax)))}</td>` : ""}</tr>`).join("");
  const claim = job.claim ? `<h2>Insurance claim</h2><dl><dt>Insurer</dt><dd>${escapeHtml(job.claim.insurer_name)} · ${escapeHtml(job.claim.mode === "cashless" ? "cashless" : "reimbursement")}</dd>
    <dt>Policy</dt><dd>${escapeHtml(job.claim.policy_no)}${job.claim.claim_no ? ` · claim ${escapeHtml(job.claim.claim_no)}` : ""}</dd>
    ${money && job.claim.approved_amount ? `<dt>Approved by the insurer</dt><dd>${escapeHtml(biz.exact(job.claim.approved_amount))}</dd>
      <dt>Deductible</dt><dd>${escapeHtml(biz.exact(job.claim.deductible))}</dd><dt>Depreciation</dt><dd>${escapeHtml(biz.exact(job.claim.depreciation))}</dd>` : ""}</dl>` : "";
  printDocument({
    title: `${job.job_no} customer`,
    styles: `@page{size:${size === "A4" ? "A4" : "A5"};margin:10mm} ${BASE}`,
    body: `${shopHead(biz, job.seller, `Job card ${job.job_no}`, job.job_no)}
      ${facts(job)}
      <h2>Estimate${job.estimate_version ? ` (version ${job.estimate_version})` : ""}</h2>
      ${rows ? `<table><thead><tr><th>Work and parts</th><th class="r">Qty</th>${job.claim ? "<th>Paid by</th>" : ""}${money ? '<th class="r">Amount</th>' : ""}</tr></thead><tbody>${rows}</tbody></table>` : "<p>The estimate follows once the vehicle is checked.</p>"}
      ${money && rows ? `<dl><dt>Total</dt><dd><strong>${escapeHtml(biz.exact(job.total))}</strong>${job.tax_mode === "inclusive" ? " including GST" : " with GST"}</dd>
        ${job.advance ? `<dt>Advance paid</dt><dd>${escapeHtml(biz.exact(job.advance.amount))} (${escapeHtml(job.advance.collection_no)})</dd>` : ""}</dl>` : ""}
      ${claim}
      <p><small>This is not a tax invoice: the bill is made when the vehicle is delivered. Work beyond this estimate is done only with your approval.</small></p>
      <div class="sign"><span>Customer's signature</span><span>Service advisor</span></div>`,
  });
}

// A customer's statement: their vehicles and the jobs on each, with what was billed, paid and is due.
export function printStatement(biz, statement) {
  const money = statement.money !== false;
  const groups = statement.vehicles.map((v) => {
    const rows = v.jobs.map((j) => `<tr><td>${escapeHtml(j.job_no)}</td><td>${fmt(j.created_at)}</td><td>${escapeHtml(j.odometer_in === null ? "—" : km(j.odometer_in))}</td>
      <td>${escapeHtml((j.complaints || []).join("; "))}</td><td>${escapeHtml(j.document_no || "—")}${j.insurer_document_no ? ` <small>(insurer ${escapeHtml(j.insurer_document_no)})</small>` : ""}</td>
      ${money ? `<td class="r">${escapeHtml(j.billed === null ? "—" : biz.exact(j.billed))}</td><td class="r">${escapeHtml(j.due === null ? "—" : biz.exact(j.due))}</td>` : ""}</tr>`).join("");
    return `<h2>${escapeHtml(v.registration_no)} · ${escapeHtml(v.vehicle_name)}${v.owned_now ? "" : " <small>(no longer theirs)</small>"}</h2>
      ${rows ? `<table><thead><tr><th>Job card</th><th>Date</th><th>Reading</th><th>Work</th><th>Bill</th>${money ? '<th class="r">Billed</th><th class="r">Due</th>' : ""}</tr></thead><tbody>${rows}</tbody></table>` : "<p><small>No jobs in these dates.</small></p>"}`;
  }).join("");
  const c = statement.customer;
  printDocument({
    title: `Statement ${c.name}`,
    styles: `@page{size:A4;margin:12mm} ${BASE}`,
    body: `${shopHead(biz, statement.seller, "Statement of vehicles and jobs")}
      <dl><dt>Customer</dt><dd><strong>${escapeHtml(c.name)}</strong>${c.phone ? ` · ${escapeHtml(c.phone)}` : ""}${c.gstin ? ` · GSTIN ${escapeHtml(c.gstin)}` : ""}</dd>
      <dt>Period</dt><dd>${statement.from ? fmt(statement.from) : "From the first job"} to ${statement.to ? fmt(statement.to) : "today"}</dd></dl>
      ${groups}
      ${money ? `<dl><dt>Billed</dt><dd>${escapeHtml(biz.exact(statement.billed))}</dd><dt>Paid</dt><dd>${escapeHtml(biz.exact(statement.paid))}</dd>
        <dt>Due on these jobs</dt><dd><strong>${escapeHtml(biz.exact(statement.due))}</strong></dd></dl>` : ""}`,
  });
}
