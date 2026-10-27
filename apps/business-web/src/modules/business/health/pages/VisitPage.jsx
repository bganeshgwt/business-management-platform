import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import LiveIndicator from "../../../../components/LiveIndicator";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useDirtyGuard, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
// A visit or lab bill paid in full at the desk: UPI, cash or card.
const PAY_KINDS = ["upi", "cash", "card"];
import { FlagBadge, LabStatus, ReportReady } from "./healthParts";
import { SEX_WORDS, resultText } from "./healthFormat";
import { printPrescription, printReferral } from "./healthPrint";
import "../styles/health.css";

// One visit. The doctor writes the consultation: vitals, complaints,
// examination, diagnosis (free text and an optional ICD-10 code), advice, the
// prescription by generic name, the follow-up date and a referral (to whom
// and why, with its letter); completing it closes the record (a later
// correction is a dated note) and marks the appointment done. As a doctor
// types a medicine, the ones this clinic has prescribed before are offered,
// each with its usual strength, dose and timing. The front desk sees only
// who, when, the bill and whether the report is ready, and bills the visit or
// orders tests from here.
//
// Live: the visit's own changes and those of its lab orders (a sample taken,
// a report approved) show within a second, unless something is being typed
// here. It has no minute's safety net: every read of a consultation is
// logged as a look at clinical data.
//
// The clinic workspace opens it beside the doctor's queue: onLoaded(visit)
// says whose visit it is, and onOrdered(order) keeps the consultation open
// after tests are ordered (Business Admin goes on to the lab order).
const VITALS = [["bpSystolic", "bp_systolic", "BP systolic", "mmHg", 40, 300, 1], ["bpDiastolic", "bp_diastolic", "BP diastolic", "mmHg", 20, 200, 1],
  ["pulse", "pulse", "Pulse", "/min", 20, 250, 1], ["temperatureC", "temperature_c", "Temperature", "°C", 30, 45, 0.1], ["spo2", "spo2", "SpO₂", "%", 50, 100, 1],
  ["respRate", "resp_rate", "Breathing", "/min", 4, 80, 1], ["weightKg", "weight_kg", "Weight", "kg", 0.5, 400, 0.1], ["heightCm", "height_cm", "Height", "cm", 20, 250, 0.1]];
const blankItem = () => ({ key: newKey(), drugName: "", strength: "", dose: "", frequency: "", duration: "", instructions: "" });
const RX_FIELDS = ["strength", "dose", "frequency", "duration", "instructions"];

export default function VisitPage({ onLoaded, onOrdered }) {
  const biz = useOpenBusiness();
  const { visitId } = useParams();
  const navigate = useNavigate();
  const [visit, setVisit] = useState(null);
  const [form, setForm] = useState(null);
  const [items, setItems] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [medicines, setMedicines] = useState([]);
  const medicineList = useId();
  const loaded = useRef(onLoaded);
  const typing = useRef(false);
  const orderIds = useRef([]);
  useDirtyGuard(dirty);
  useEffect(() => { loaded.current = onLoaded; });
  useEffect(() => { typing.current = dirty; }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `clinic/visits/${visitId}`, undefined, controller.signal).then((v) => {
      setVisit(v); setError(""); setDirty(false);
      setForm(Object.fromEntries([...VITALS.map(([key, col]) => [key, v[col] ?? ""]), ["complaints", v.complaints || ""], ["examination", v.examination || ""], ["diagnosis", v.diagnosis || ""],
        ["icd10Code", v.icd10_code || ""], ["advice", v.advice || ""], ["followUpOn", v.follow_up_on ? String(v.follow_up_on).slice(0, 10) : ""],
        ["referredTo", v.referred_to || ""], ["referralReason", v.referral_reason || ""]]));
      setItems((v.prescription || []).map((p) => ({ key: String(p.id), drugName: p.drug_name, strength: p.strength || "", dose: p.dose || "", frequency: p.frequency || "", duration: p.duration || "", instructions: p.instructions || "" })));
      orderIds.current = (v.lab_orders || []).map((o) => String(o.id));
      if (loaded.current) loaded.current(v);
    }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, visitId, version]);
  const reload = useCallback((batch) => {
    const ours = batch.reasons.some((reason) => reason !== "change") || batch.changes.some((change) =>
      (change.area === "visit" && String(change.id) === String(visitId)) || (change.area === "lab" && orderIds.current.includes(String(change.id))));
    if (ours && !typing.current) setVersion((n) => n + 1);
  }, [visitId]);
  const live = useLiveRefresh({ business: biz.id }, ["visit", "lab"], reload, { every: 0, refreshOnVisible: false });
  // The medicines offered as a doctor types: only while they may write this consultation.
  const writing = Boolean(visit?.clinical_access && visit.status === "open" && biz.can("patients.edit_clinical"));
  useEffect(() => {
    if (!writing) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "clinic/medicines", undefined, controller.signal).then(setMedicines).catch(() => {});
    return () => controller.abort();
  }, [biz.id, writing]);
  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setDirty(true); };
  const setItem = (key, patch) => { setItems((all) => all.map((i) => (i.key === key ? { ...i, ...patch } : i))); setDirty(true); };
  // A medicine this clinic has prescribed before fills its usual strength,
  // dose, timing and duration, on a line that has none of them yet.
  const setMedicine = (key, value) => {
    const known = medicines.find((m) => m.drug_name.toLowerCase() === value.trim().toLowerCase());
    setItems((all) => all.map((i) => {
      if (i.key !== key) return i;
      const blank = RX_FIELDS.every((field) => !i[field]);
      return known && blank ? { ...i, drugName: value, ...Object.fromEntries(RX_FIELDS.map((field) => [field, known[field] || ""])) } : { ...i, drugName: value };
    }));
    setDirty(true);
  };

  async function save(complete) {
    setBusy(true); setError("");
    try {
      const body = { ...Object.fromEntries(Object.entries(form).map(([k, val]) => [k, val === "" ? null : val])), followUpOn: form.followUpOn || null,
        prescription: items.filter((i) => i.drugName.trim()).map(({ key: _key, ...rest }) => rest) };
      await businessWrite(biz.id, `clinic/visits/${visitId}`, body, "patch");
      if (complete) await businessWrite(biz.id, `clinic/visits/${visitId}`, { complete: true }, "patch");
      toast.success(complete ? "Consultation completed" : "Saved");
      setVersion((n) => n + 1);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally { setBusy(false); }
  }
  const withSeller = (print) => async () => {
    const settings = await businessRead(biz.id, "health/settings").catch(() => ({}));
    print(visit, settings.seller, biz.business.name);
  };
  // Tests ordered: Business Admin goes on to the lab order; the clinic
  // workspace stays on the consultation, the order added to it.
  const ordered = (order) => {
    if (!onOrdered) { navigate(biz.path(`lab-orders/${order.id}`)); return; }
    setDialog(null);
    orderIds.current = [...orderIds.current, String(order.id)];
    setVisit((v) => ({ ...v, lab_status: "pending", lab_orders: [...(v.lab_orders || []), { id: order.id, order_no: order.order_no, status: order.status, approved_at: order.approved_at }] }));
    onOrdered(order);
  };

  if (!visit || !form) return <div className="stack"><BusinessHeader icon="clipboard" title="Visit" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const clinical = visit.clinical_access;
  const open = visit.status === "open";
  const canWrite = clinical && open && biz.can("patients.edit_clinical");
  const bmi = form.weightKg && form.heightCm ? (Number(form.weightKg) / ((Number(form.heightCm) / 100) ** 2)).toFixed(1) : null;
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title={`${visit.patient_name} · ${visit.visit_no}`}
        description={`${visit.patient_no} · ${SEX_WORDS[visit.sex]} · ${visit.age} y · ${visit.doctor_name || "No doctor"} · ${dateTime(visit.created_at)}`}
        actions={<LiveIndicator status={live} />}
        primary={canWrite && <button type="button" className="button" disabled={busy} onClick={() => save(true)}><Icon name="check" size={16} /> Complete consultation</button>}
        secondary={<Link className="button button-secondary" to={biz.path(`patients/${visit.contact_id}`)}>Patient</Link>}
        more={[clinical && biz.can("patients.print") && { label: "Print prescription", icon: "print", onClick: withSeller(printPrescription) },
          clinical && visit.referred_to && biz.can("patients.print") && { label: "Print referral letter", icon: "print", onClick: withSeller(printReferral) },
          !visit.document_id && biz.can("sales.create") && { label: "Bill this visit", icon: "receipt", onClick: () => setDialog("bill") },
          biz.has("lab") && biz.can("lab.create") && { label: "Order tests", icon: "activity", onClick: () => setDialog("lab") }].filter(Boolean)} />
      <div className="hl-strip">
        <StatusBadge status={open ? "open" : "completed"} label={open ? "In consultation" : `Completed ${dateTime(visit.completed_at)}`} />
        {visit.document_no ? <StatusBadge status="paid" label={`Billed ${visit.document_no} · ${biz.exact(visit.bill_total)}`} /> : <StatusBadge tone="warning" label="Not billed" />}
        <ReportReady status={visit.lab_status} />
        {visit.follow_up_on && <StatusBadge tone="info" label={`Follow-up ${dateShort(visit.follow_up_on, { year: true })}`} />}
        {clinical && visit.referred_to && <StatusBadge tone="info" label={`Referred to ${visit.referred_to}`} />}
      </div>
      <ErrorMessage message={error} />
      {!clinical ? (
        <SectionCard icon="lock" title="Consultation"><p className="muted">The consultation notes are for doctors only. You can bill this visit, order tests and see whether the report is ready.</p></SectionCard>
      ) : (
        <>
          {visit.patient_clinical?.allergies && <p className="hl-note hl-note-danger"><Icon name="alert" size={15} /> Allergies: {visit.patient_clinical.allergies}</p>}
          <fieldset className="bz-fieldset stack" disabled={!canWrite || busy}>
            <SectionCard icon="activity" title="Vitals" description={bmi ? `BMI ${bmi}` : undefined}>
              <div className="hl-vitals">
                {VITALS.map(([key, , label, unit, min, max, step]) => (
                  <Field key={key} label={`${label} (${unit})`}><input type="number" min={min} max={max} step={step} value={form[key]} onChange={set(key)} /></Field>
                ))}
              </div>
            </SectionCard>
            <SectionCard icon="clipboard" title="Consultation">
              <div className="form-grid">
                <Field label="Complaints" wide><textarea rows={2} maxLength={2000} value={form.complaints} onChange={set("complaints")} /></Field>
                <Field label="Examination" wide><textarea rows={2} maxLength={2000} value={form.examination} onChange={set("examination")} /></Field>
                <Field label="Diagnosis"><input maxLength={1000} value={form.diagnosis} onChange={set("diagnosis")} /></Field>
                <Field label="ICD-10 code (optional)" hint="e.g. J06.9, E11.9, I10"><input maxLength={10} pattern="[A-Za-z][0-9][0-9A-Za-z](\.[0-9A-Za-z]{1,4})?" title="A letter, two characters, then an optional . and up to four" value={form.icd10Code} onChange={set("icd10Code")} /></Field>
                <Field label="Advice" wide><textarea rows={2} maxLength={2000} value={form.advice} onChange={set("advice")} /></Field>
                <Field label="Follow-up on"><input type="date" min={businessToday(biz.business.timezone)} value={form.followUpOn} onChange={set("followUpOn")} /></Field>
                <Field label="Referred to" hint="A specialist or a hospital, e.g. Dr. S. Rao, cardiologist, City Hospital"><input maxLength={200} value={form.referredTo} onChange={set("referredTo")} /></Field>
                <Field label="Reason for the referral" wide><textarea rows={2} maxLength={1000} value={form.referralReason} onChange={set("referralReason")} /></Field>
              </div>
            </SectionCard>
            <SectionCard flush icon="file" title="Prescription"
              description={canWrite && medicines.length ? "By generic name; the medicines this clinic has prescribed before are offered as you type. Printed with the doctor's registration number."
                : "By generic name. Printed with the doctor's registration number."}
              actions={canWrite && <button type="button" className="button button-secondary" onClick={() => { setItems((all) => [...all, blankItem()]); setDirty(true); }}><Icon name="plus" size={15} /> Add medicine</button>}>
              {canWrite && medicines.length > 0 && (
                <datalist id={medicineList}>
                  {medicines.map((m) => <option key={m.drug_name} value={m.drug_name} label={[m.strength, m.dose, m.frequency, m.duration].filter(Boolean).join(" · ")} />)}
                </datalist>
              )}
              <DataGrid id="clinic-visit-prescription" caption="Prescription" variant="editor" rows={items} rowKey={(i) => i.key} pageSize={false} columns={[
                ["drugName", "Medicine (generic)", 150], ["strength", "Strength", 60], ["dose", "Dose", 60], ["frequency", "When (1-0-1)", 60], ["duration", "For", 60], ["instructions", "Instructions", 200],
              ].map(([key, header, max]) => ({ key, header, value: (i) => i[key], render: (i, ctx) => (key === "drugName"
                ? <input aria-label={ctx.label} maxLength={max} required list={canWrite && medicines.length ? medicineList : undefined} autoComplete="off" value={i[key]} onChange={(e) => setMedicine(i.key, e.target.value)} />
                : <input aria-label={ctx.label} maxLength={max} value={i[key]} onChange={(e) => setItem(i.key, { [key]: e.target.value })} />) }))
                .concat(canWrite ? [{ key: "actions", header: "", label: "Actions", type: "actions", render: (i) => <button type="button" className="link-button danger" onClick={() => { setItems((all) => all.filter((x) => x.key !== i.key)); setDirty(true); }}>Remove</button> }] : [])}
                empty="No medicines" emptyHint={canWrite ? "Add each medicine by its generic name." : undefined} />
            </SectionCard>
            {canWrite && (
              <div className="form-actions">
                <button type="button" className="button button-secondary" disabled={busy || !dirty} onClick={() => save(false)}>{busy ? "Saving…" : "Save draft"}</button>
                <button type="button" className="button" disabled={busy} onClick={() => save(true)}>Complete consultation</button>
              </div>
            )}
          </fieldset>
          {visit.lab_results?.length > 0 && (
            <SectionCard flush icon="activity" title="Lab results (approved)">
              <DataGrid id="clinic-visit-results" caption="Lab results" variant="compact" rows={visit.lab_results} rowKey={(r) => `${r.order_no}-${r.test_name}-${r.parameter}`} columns={[
                { key: "test", header: "Test", value: (r) => r.test_name, mobile: "subtitle" },
                { key: "parameter", header: "Parameter", value: (r) => r.parameter, mobile: "title" },
                { key: "value", header: "Result", value: (r) => resultText(r), render: (r) => <span className="bz-inline"><strong>{resultText(r)}</strong> {r.unit} <FlagBadge flag={r.flag} /></span>, mobile: "show" },
                { key: "range", header: "Reference", value: (r) => r.range_text || "" },
              ]} rowClassName={(r) => (String(r.flag).startsWith("critical") ? "dg-tone-danger" : ["low", "high", "abnormal"].includes(r.flag) ? "dg-tone-warning" : "")} />
            </SectionCard>
          )}
          {!open && (
            <SectionCard icon="edit" title="Notes added later" actions={biz.can("patients.edit_clinical") && <button type="button" className="chip-button" onClick={() => setDialog("note")}>Add a note</button>}>
              {visit.notes?.length ? <ul className="hl-notes">{visit.notes.map((n) => <li key={n.id}><small className="muted">{dateTime(n.created_at)} · {n.created_by_name}</small><p>{n.body}</p></li>)}</ul> : <p className="muted">None.</p>}
            </SectionCard>
          )}
        </>
      )}
      {visit.lab_orders?.length > 0 && (
        <SectionCard flush icon="activity" title="Lab orders">
          <DataGrid id="clinic-visit-lab" caption="Lab orders" variant="compact" rows={visit.lab_orders} onRowClick={(o) => navigate(biz.path(`lab-orders/${o.id}`))} columns={[
            { key: "no", header: "Order", value: (o) => o.order_no, className: "mono", mobile: "title" },
            { key: "status", header: "Status", value: (o) => o.status, render: (o) => <LabStatus status={o.status} />, mobile: "show" },
            { key: "approved", header: "Reported", type: "datetime", value: (o) => o.approved_at },
          ]} />
        </SectionCard>
      )}
      {dialog === "note" && <NoteDialog visitId={visit.id} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setVersion((n) => n + 1); }} />}
      {dialog === "bill" && <BillDialog visit={visit} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setVersion((n) => n + 1); }} />}
      {dialog === "lab" && <OrderTestsDialog visit={visit} onClose={() => setDialog(null)} onSaved={ordered} />}
    </div>
  );
}

function NoteDialog({ visitId, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [body, setBody] = useState("");
  return (
    <FormDialog title="Add a note" icon="edit" width={560} onClose={onClose} onSaved={onSaved} successMessage="Note added" description="The consultation stays as written; the note is added below it with today's date and your name."
      onSubmit={() => businessWrite(biz.id, `clinic/visits/${visitId}/notes`, { body })}>
      <Field label="Note" wide><textarea required rows={4} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </FormDialog>
  );
}

// The consultation is the doctor's fee: full for a first visit, the follow-up
// fee (or nothing) within their follow-up days, else the booked service.
const FEE_WORDS = { consultation: "Consultation", follow_up: "Follow-up", free_follow_up: "Free follow-up", booked_service: "Booked service" };
function BillDialog({ visit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [method, setMethod] = useState("upi");
  const methods = usePaymentMethods();
  const [key] = useState(newKey);
  const [fee, setFee] = useState(null);
  useEffect(() => { businessRead(biz.id, `clinic/visits/${visit.id}/fee`).then(setFee).catch(() => setFee({ kind: "none" })); }, [biz.id, visit.id]);
  const free = fee?.kind === "free_follow_up";
  const last = fee?.last_consultation;
  return (
    <FormDialog title={`Bill ${visit.visit_no}`} icon="receipt" width={520} onClose={onClose} onSaved={onSaved} disabled={!fee || fee.kind === "none"}
      submitLabel={free ? "Record free follow-up" : "Bill and take payment"}
      successMessage={(r) => (r.document ? `Billed ${r.document.document_no}` : "Recorded as a free follow-up")}
      description={!fee ? "Working out the fee…" : fee.kind === "none" ? "No fee is set for this doctor and nothing was booked; bill it on the Sales screen, or set the doctor's fee under Doctors."
        : "Consultations are exempt from GST."}
      onSubmit={() => businessWrite(biz.id, `clinic/visits/${visit.id}/bill`, { requestKey: key, locationId: visit.location_id, ...(free ? {} : { payment: { amount: "full", ...methods.body(method, PAY_KINDS) } }) })}>
      {fee && fee.kind !== "none" && (
        <div className="field-wide hl-fee">
          <span className="bz-two-line"><strong>{FEE_WORDS[fee.kind]}{fee.label && !free ? `: ${fee.label}` : ""}</strong>
            {last && <small className="muted">Within {fee.follow_up_days} days of {last.visit_no} ({dateShort(last.day)})</small>}</span>
          <strong>{free ? biz.amount(0) : biz.amount(fee.price)}</strong>
        </div>
      )}
      {!free && <Field label="Paid by"><select value={methods.resolve(method, PAY_KINDS)} onChange={(e) => setMethod(e.target.value)}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>}
    </FormDialog>
  );
}

// Tests for a visit or a patient. Billed now only by someone who bills (a
// doctor's order is billed at the desk); the order reaches the lab either way.
export function OrderTestsDialog({ visit, patient, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["lab/tests?active=true"]);
  const canBill = biz.can("sales.create");
  const [chosen, setChosen] = useState([]);
  const [priority, setPriority] = useState("routine");
  const [bill, setBill] = useState(canBill);
  const [method, setMethod] = useState("upi");
  const methods = usePaymentMethods();
  const [key] = useState(newKey);
  const tests = options?.["lab/tests?active=true"] || [];
  const toggle = (id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const total = tests.filter((t) => chosen.includes(t.id)).reduce((s, t) => s + Number(t.sku_price || 0), 0);
  return (
    <FormDialog title={`Order tests · ${visit?.patient_name || patient?.name}`} icon="activity" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Order" successMessage={(o) => `${o.order_no} ordered`}
      onSubmit={() => businessWrite(biz.id, "lab/orders", { requestKey: key, locationId: biz.locations.find((l) => l.active)?.id, ...(visit ? { visitId: visit.id } : { contactId: patient.contact_id }),
        testIds: chosen, priority, referredBy: visit?.doctor_name || undefined, bill, ...(bill ? { payment: { amount: "full", ...methods.body(method, PAY_KINDS) } } : {}) })}>
      {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
      <div className="field-wide hl-test-list">
        {tests.map((t) => (
          <label key={t.id} className="hl-check"><input type="checkbox" checked={chosen.includes(t.id)} onChange={() => toggle(t.id)} />
            <span><strong>{t.name}</strong> <small className="muted">{t.code} · {t.kind === "profile" ? `profile: ${t.profile_codes}` : `${t.parameter_count} parameter${t.parameter_count === 1 ? "" : "s"}`} · {t.sample_type}{t.sku_price ? ` · ${biz.exact(t.sku_price)}` : ""}</small></span></label>
        ))}
        {!tests.length && <p className="muted">No tests set up yet (Lab orders › Tests & panels).</p>}
      </div>
      <Field label="Priority"><select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="routine">Routine</option><option value="urgent">Urgent</option></select></Field>
      {canBill && <label className="hl-check"><input type="checkbox" checked={bill} onChange={(e) => setBill(e.target.checked)} /> Bill the tests now{bill && total ? ` (${biz.exact(total)})` : ""}</label>}
      {bill && <Field label="Paid by"><select value={methods.resolve(method, PAY_KINDS)} onChange={(e) => setMethod(e.target.value)}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>}
    </FormDialog>
  );
}
