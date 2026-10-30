import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort, dateTime } from "@bmp/shared/format";
import { barcodeSvg } from "../../retail/services/barcode";
import { FLAG_WORDS, SEX_WORDS, isFlagged, resultText } from "./healthFormat";

// Printouts of the health module: the doctor's prescription and referral
// letter (A5), the lab report (A4 with the lab's details, signature line and
// approval time), sample barcode labels, the H1 / Schedule X registers and a
// debit note.

const e = escapeHtml;
const A4 = `@page{size:A4;margin:14mm} body{font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#111}
  h1{font-size:18px;margin:0} h2{font-size:13px;margin:14px 0 6px} .muted{color:#555} .small{font-size:10px}
  table{width:100%;border-collapse:collapse} th,td{border-bottom:1px solid #ccc;padding:5px 6px;text-align:left;vertical-align:top}
  th{background:#f2f2f2;font-size:10.5px} .r{text-align:right} .top{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #222;padding-bottom:8px}
  .facts{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px;margin:10px 0;padding:8px;border:1px solid #ccc}
  .flag{font-weight:bold} .crit{font-weight:bold;text-decoration:underline} .sign{display:flex;justify-content:space-between;margin-top:42px}
  .foot{margin-top:18px;border-top:1px solid #ccc;padding-top:6px}
  .amended{border:1.5px solid #111;padding:6px 8px;margin:8px 0;font-size:11px} .superseded{border:2px solid #b91c1c;color:#b91c1c;padding:6px 8px;margin:8px 0;font-weight:bold;text-align:center}`;

const address = (s) => [s?.address_line1, s?.address_line2, s?.city, s?.postal_code].filter(Boolean).map(e).join(", ");
const vitalsOf = (v) => [
  v.bp_systolic && `BP ${v.bp_systolic}/${v.bp_diastolic || "–"} mmHg`, v.pulse && `Pulse ${v.pulse}/min`, v.temperature_c && `Temp ${v.temperature_c} °C`,
  v.spo2 && `SpO₂ ${v.spo2}%`, v.weight_kg && `Wt ${v.weight_kg} kg`, v.height_cm && `Ht ${v.height_cm} cm`, v.resp_rate && `RR ${v.resp_rate}/min`,
].filter(Boolean).join(" · ");

export function printPrescription(visit, seller, businessName) {
  const items = (visit.prescription || []).map((p, i) => `<tr><td>${i + 1}</td><td><strong>${e(p.drug_name)}</strong>${p.strength ? ` ${e(p.strength)}` : ""}</td>
    <td>${e(p.dose || "")}</td><td>${e(p.frequency || "")}</td><td>${e(p.duration || "")}</td><td>${e(p.instructions || "")}</td></tr>`).join("");
  printDocument({
    title: `Prescription ${visit.visit_no}`,
    styles: `${A4.replace("size:A4;margin:14mm", "size:A5;margin:10mm")} .rx{font-size:22px;font-family:Georgia,serif;margin:8px 0}`,
    body: `<div class="top"><div><h1>${e(visit.doctor_signed_name || visit.doctor_name || "")}</h1>
        <div>${e(visit.doctor_qualification || "")}</div>
        <div>${visit.doctor_reg_no ? `Reg. No. <strong>${e(visit.doctor_reg_no)}</strong>${visit.doctor_council ? `, ${e(visit.doctor_council)}` : ""}` : '<span class="muted">Registration number not set up</span>'}</div></div>
      <div class="r"><strong>${e(seller?.display_name || businessName)}</strong><div class="small">${address(seller)}</div><div class="small">${e(seller?.phone || "")}</div></div></div>
      <div class="facts"><div>Patient: <strong>${e(visit.patient_name)}</strong></div><div>${e(visit.patient_no)} · ${e(SEX_WORDS[visit.sex] || "")} · ${e(String(visit.age ?? ""))} y</div>
        <div>Date: ${e(dateShort(visit.created_at, { year: true }))} · ${e(visit.visit_no)}</div></div>
      ${vitalsOf(visit) ? `<div class="small">${e(vitalsOf(visit))}</div>` : ""}
      ${visit.complaints ? `<p><strong>Complaints:</strong> ${e(visit.complaints)}</p>` : ""}
      ${visit.diagnosis ? `<p><strong>Diagnosis:</strong> ${e(visit.diagnosis)}${visit.icd10_code ? ` (ICD-10 ${e(visit.icd10_code)})` : ""}</p>` : ""}
      <div class="rx">℞</div>
      ${items ? `<table><thead><tr><th>#</th><th>Medicine (generic)</th><th>Dose</th><th>When</th><th>For</th><th>Instructions</th></tr></thead><tbody>${items}</tbody></table>` : '<p class="muted">No medicines.</p>'}
      ${visit.advice ? `<p><strong>Advice:</strong> ${e(visit.advice)}</p>` : ""}
      ${visit.follow_up_on ? `<p><strong>Review on:</strong> ${e(dateShort(visit.follow_up_on, { year: true }))}</p>` : ""}
      ${visit.referred_to ? `<p><strong>Referred to:</strong> ${e(visit.referred_to)}</p>` : ""}
      <div class="sign"><span></span><span class="r">${e(visit.doctor_signed_name || visit.doctor_name || "")}<br>Signature</span></div>`,
  });
}

// The doctor's letter to whom the patient is referred: why, what was found,
// the diagnosis, the medicines and allergies, and approved lab results.
export function printReferral(visit, seller, businessName) {
  const doctor = visit.doctor_signed_name || visit.doctor_name || "";
  const clinical = visit.patient_clinical || {};
  const medicines = (visit.prescription || []).map((p) => [p.drug_name, p.strength, p.frequency, p.duration].filter(Boolean).map(e).join(" "));
  const results = (visit.lab_results || []).map((r) => `<tr><td>${e(r.test_name)}</td><td>${e(r.parameter)}</td><td>${e(resultText(r))} ${e(r.unit || "")}${isFlagged(r.flag) ? ` (${e(FLAG_WORDS[r.flag])})` : ""}</td>
    <td>${e(r.range_text || "")}</td></tr>`).join("");
  printDocument({
    title: `Referral ${visit.visit_no}`,
    styles: A4.replace("size:A4;margin:14mm", "size:A5;margin:10mm"),
    body: `<div class="top"><div><h1>${e(doctor)}</h1><div>${e(visit.doctor_qualification || "")}</div>
        <div>${visit.doctor_reg_no ? `Reg. No. <strong>${e(visit.doctor_reg_no)}</strong>${visit.doctor_council ? `, ${e(visit.doctor_council)}` : ""}` : '<span class="muted">Registration number not set up</span>'}</div></div>
      <div class="r"><strong>${e(seller?.display_name || businessName)}</strong><div class="small">${address(seller)}</div><div class="small">${e(seller?.phone || "")}</div></div></div>
      <h2>REFERRAL LETTER</h2>
      <p><strong>To:</strong> ${e(visit.referred_to || "")}</p>
      <div class="facts"><div>Patient: <strong>${e(visit.patient_name)}</strong></div><div>${e(visit.patient_no)} · ${e(SEX_WORDS[visit.sex] || "")} · ${e(String(visit.age ?? ""))} y</div>
        <div>Date: ${e(dateShort(visit.created_at, { year: true }))} · ${e(visit.visit_no)}</div></div>
      ${visit.referral_reason ? `<p><strong>Reason for the referral:</strong> ${e(visit.referral_reason)}</p>` : ""}
      ${visit.complaints ? `<p><strong>Complaints:</strong> ${e(visit.complaints)}</p>` : ""}
      ${visit.examination ? `<p><strong>Examination:</strong> ${e(visit.examination)}</p>` : ""}
      ${vitalsOf(visit) ? `<p class="small">${e(vitalsOf(visit))}</p>` : ""}
      ${visit.diagnosis ? `<p><strong>Diagnosis:</strong> ${e(visit.diagnosis)}${visit.icd10_code ? ` (ICD-10 ${e(visit.icd10_code)})` : ""}</p>` : ""}
      <p><strong>Allergies:</strong> ${e(clinical.allergies || "None known")}</p>
      ${clinical.conditions ? `<p><strong>Long-term conditions:</strong> ${e(clinical.conditions)}</p>` : ""}
      ${medicines.length || clinical.current_medicines ? `<p><strong>Medicines:</strong> ${[...medicines, ...(clinical.current_medicines ? [e(clinical.current_medicines)] : [])].join("; ")}</p>` : ""}
      ${results ? `<table><thead><tr><th>Test</th><th>Parameter</th><th>Result</th><th>Reference</th></tr></thead><tbody>${results}</tbody></table>` : ""}
      <div class="sign"><span></span><span class="r">${e(doctor)}<br>Signature</span></div>`,
  });
}

export function printLabReport(report) {
  const lab = report.lab || {};
  const rows = report.tests.map((t) => `<tr><th colspan="4">${e(t.name)}${t.profile_name ? ` <span class="muted">(${e(t.profile_name)})</span>` : ""}${t.method ? ` <span class="muted small">· ${e(t.method)}</span>` : ""}</th></tr>`
    + (t.parameters || []).map((p) => {
      const flagged = isFlagged(p.flag);
      const cls = p.flag?.startsWith("critical") ? "crit" : flagged ? "flag" : "";
      return `<tr><td>${e(p.name)}</td><td class="${cls}">${e(resultText(p))}${flagged ? ` ${e(FLAG_WORDS[p.flag] === "High" ? "H" : FLAG_WORDS[p.flag] === "Low" ? "L" : FLAG_WORDS[p.flag])}` : ""}</td>
        <td>${e(p.unit || "")}</td><td>${e(p.range_text || "")}</td></tr>`;
    }).join("")).join("");
  const sample = report.samples.map((s) => `${e(s.barcode)} (${e(s.sample_type)})`).join(", ");
  // An amended report says what it replaces and why; an earlier version
  // printed again says it is superseded.
  const version = report.report_version || 1;
  const banner = report.superseded
    ? `<div class="superseded">SUPERSEDED: version ${e(String(version))} of this report was replaced by a later amended report. Do not use for treatment.</div>`
    : report.amends ? `<div class="amended"><strong>AMENDED REPORT (version ${e(String(version))})</strong>. This replaces version ${e(String(report.amends.version))} reported ${e(dateTime(report.amends.approved_at))}.${report.report_amend_reason ? ` Reason: ${e(report.report_amend_reason)}` : ""}</div>` : "";
  printDocument({
    title: `Lab report ${report.order_no}`,
    styles: A4,
    body: `<div class="top"><div><h1>${e(lab.name)}</h1><div>${address(lab)}</div><div class="small">${[lab.phone, lab.email].filter(Boolean).map(e).join(" · ")}</div>
        ${lab.registration ? `<div class="small">${e(lab.registration)}</div>` : ""}</div><div class="r"><strong>LABORATORY REPORT</strong><div>${e(report.order_no)}${version > 1 ? ` · v${e(String(version))}` : ""}</div></div></div>
      ${banner}
      <div class="facts"><div>Patient: <strong>${e(report.patient_name)}</strong></div><div>${e(report.patient_no)} · ${e(SEX_WORDS[report.sex] || "")} · ${e(String(report.age ?? ""))} y</div>
        <div>Referred by: ${e(report.referred_by || "Self")}</div>
        <div>Sample: ${sample}</div><div>Collected: ${e(dateTime(report.samples[0]?.collected_at) || "—")}</div><div>Reported: ${e(dateTime(report.approved_at))}</div></div>
      <table><thead><tr><th>Test</th><th>Result</th><th>Unit</th><th>Biological reference range</th></tr></thead><tbody>${rows}</tbody></table>
      ${report.outside_lab ? `<p class="small">Tested at ${e(report.outside_lab)}${report.outside_ref_no ? ` (ref. ${e(report.outside_ref_no)})` : ""}.</p>` : ""}
      <p class="small">H = above, L = below the reference range; values in <u>bold underline</u> are critical and were told to the doctor.</p>
      <div class="sign"><span class="small">Checked and approved electronically<br>${e(dateTime(report.approved_at))}</span>
        <span class="r">${e(report.pathologist_name || "")}<br>${e(report.pathologist_qualification || "")}${report.pathologist_reg_no ? `<br>Reg. No. ${e(report.pathologist_reg_no)}` : ""}<br>Pathologist</span></div>
      <div class="foot small muted">${e(lab.footer || "")} · End of report</div>`,
  });
}

export function printSampleLabels(order) {
  // A cancelled test, and a sample only it needed, get no label.
  const tests = order.tests.filter((t) => !t.cancelled_at);
  const labels = order.samples.filter((s) => s.needed !== false).map((s) => {
    let svg = "";
    try { svg = barcodeSvg(s.barcode, { height: 34 }).svg; } catch { svg = ""; }
    return `<div class="label">${svg}<div><strong>${e(s.barcode)}</strong> · ${e(s.sample_type)}</div><div>${e(order.patient_name)} · ${e(order.patient_no)}</div>
      <div>${e(order.order_no)} · ${e(tests.filter((t) => String(t.sample_id) === String(s.id)).map((t) => t.code).join(", "))}</div><div>${e(s.container || "")}</div></div>`;
  }).join("");
  printDocument({
    title: `Sample labels ${order.order_no}`,
    styles: `@page{size:50mm 25mm;margin:1mm} body{font-family:Arial,sans-serif;font-size:8px;margin:0} .label{width:48mm;height:23mm;overflow:hidden;page-break-after:always}
      .label:last-child{page-break-after:auto} svg{max-width:46mm;height:9mm}`,
    body: labels,
  });
}

export function printRegister(title, rows, columns, seller, period) {
  printDocument({
    title,
    styles: A4.replace("size:A4;margin:14mm", "size:A4 landscape;margin:10mm"),
    body: `<div class="top"><div><h1>${e(title)}</h1><div class="muted">${e(period || "")}</div></div><div class="r"><strong>${e(seller?.display_name || "")}</strong><div class="small">${address(seller)}</div></div></div>
      <table><thead><tr><th>S.No.</th>${columns.map(([h]) => `<th>${e(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td>${columns.map(([, f]) => `<td>${e(f(r) ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <p class="small muted">${rows.length} entries · printed ${e(dateTime(new Date()))}</p>`,
  });
}

export function printDebitNote(note, seller, symbol = "₹") {
  printDocument({
    title: `Debit note ${note.note_no}`,
    styles: A4,
    body: `<div class="top"><div><h1>${e(seller?.legal_name || seller?.display_name || "")}</h1><div>${address(seller)}</div>${seller?.gstin ? `<div>GSTIN ${e(seller.gstin)}</div>` : ""}</div>
      <div class="r"><strong>DEBIT NOTE</strong><div>${e(note.note_no)}</div><div>${e(dateShort(note.created_at, { year: true }))}</div></div></div>
      <div class="facts"><div>To: <strong>${e(note.supplier_name)}</strong></div><div>${e(note.supplier_address || "")}</div><div>${note.supplier_gstin ? `GSTIN ${e(note.supplier_gstin)}` : ""}</div></div>
      <p>Reason: <strong>${e({ expired: "Expired stock", near_expiry: "Near-expiry stock", breakage: "Breakage", recall: "Recalled batch", other: "Return" }[note.reason] || note.reason)}</strong>${note.notes ? ` · ${e(note.notes)}` : ""}</p>
      <table><thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th class="r">Quantity</th><th class="r">Value</th><th>Our return no.</th></tr></thead>
      <tbody>${note.lines.map((l) => `<tr><td>${e(l.label)}</td><td>${e(l.lot_code)}</td><td>${e(l.expires_on ? dateShort(l.expires_on, { year: true }) : "")}</td>
        <td class="r">${e(Number(l.quantity))} ${e(l.unit)}</td><td class="r">${e(symbol)}${e(Number(l.value).toFixed(2))}</td><td>${e(l.return_no || (l.adjustment_id ? "Written off" : ""))}</td></tr>`).join("")}</tbody></table>
      <p class="r">Credit claimed: <strong>${e(symbol)}${e(Number(note.claimed).toFixed(2))}</strong>${Number(note.written_off) ? ` · written off ${e(symbol)}${e(Number(note.written_off).toFixed(2))}` : ""}</p>
      <div class="sign"><span>Received by (distributor)</span><span class="r">For ${e(seller?.display_name || "")}<br>Authorised signatory</span></div>`,
  });
}
