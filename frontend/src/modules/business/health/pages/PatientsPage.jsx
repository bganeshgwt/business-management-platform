import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { METHOD_WORDS, PURPOSE_WORDS, SEX_WORDS } from "./healthFormat";
import "../styles/health.css";

// Patients: registered with a patient ID, age or date of birth, sex and the
// consent the DPDP Act asks for (what for, the notice they saw, how it was
// given). Front desk sees these and the visits; the clinical record opens
// only for doctors (patients.view_clinical), and each look is logged.
export default function PatientsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [consent, setConsent] = useState("");
  const list = useServerList("clinic/patients", { gridId: "clinic-patients", params: consent ? { consent } : {} });
  const columns = useMemo(() => [
    { key: "name", header: "Patient", value: (p) => p.name, mobile: "title", pin: true, render: (p) => <span className="bz-two-line"><strong>{p.name}</strong><small className="muted mono">{p.patient_no}</small></span> },
    { key: "phone", header: "Phone", value: (p) => p.phone || "", mobile: "subtitle" },
    { key: "sex", header: "Sex", value: (p) => SEX_WORDS[p.sex] },
    { key: "age", header: "Age", type: "number", value: (p) => p.age, render: (p) => `${p.age} y`, mobile: "show" },
    { key: "visits", header: "Visits", type: "number", value: (p) => p.visits },
    { key: "last", header: "Last visit", type: "date", value: (p) => p.last_visit_at, mobile: "show" },
    { key: "consent", header: "Consent", value: (p) => (p.consent_active ? "Given" : "Withdrawn"), render: (p) => (p.consent_active ? <StatusBadge status="active" label="Consent given" /> : <StatusBadge tone="danger" label="Withdrawn" />) },
  ], []);
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Patients" description="Registered with consent. Clinical notes open only for doctors; every look is logged."
        primary={biz.can("patients.create") && <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Register patient</button>} />
      <SectionCard flush icon="list" title="All patients">
        <DataGrid {...list.gridProps} caption="Patients" columns={columns} rowNoun={["patient", "patients"]} onRowClick={(p) => navigate(businessPath(biz.id, `patients/${p.contact_id}`))}
          toolbar={(
            <div className="segmented" role="group" aria-label="Consent">
              {[["", "All"], ["true", "Consent given"], ["false", "Withdrawn"]].map(([v, l]) => <button key={v || "all"} type="button" className={`segment ${consent === v ? "is-active" : ""}`} aria-pressed={consent === v} onClick={() => setConsent(v)}>{l}</button>)}
            </div>
          )}
          exportName={biz.can("patients.export") ? `${biz.business.code}-patients` : undefined}
          empty="No patients yet" emptyHint="Register a patient at their first visit." emptyIcon="users" />
      </SectionCard>
      {adding && <RegisterDialog onClose={() => setAdding(false)} onSaved={(p) => { setAdding(false); navigate(businessPath(biz.id, `patients/${p.contact_id}`)); }} />}
    </div>
  );
}

export function RegisterDialog({ onClose, onSaved, prefill = {} }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ name: prefill.name || "", phone: prefill.phone || "", email: "", address: "", sex: "", dateOfBirth: "", ageYears: "", guardianName: "", emergencyPhone: "",
    purposes: ["treatment"], method: "signed_form", givenBy: "Self", agreed: false });
  useEffect(() => {
    businessRead(biz.id, "health/settings").then((s) => setNotice({ text: s.consent_notice, version: s.consent_version })).catch(() => setNotice({ text: "", version: "" }));
  }, [biz.id]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const toggle = (purpose) => setForm((f) => ({ ...f, purposes: f.purposes.includes(purpose) ? f.purposes.filter((p) => p !== purpose) : [...f.purposes, purpose] }));
  return (
    <FormDialog title="Register a patient" icon="users" width={760} onClose={onClose} onSaved={onSaved} submitLabel="Register"
      successMessage={(p) => `${p.name} registered as ${p.patient_no}`}
      onSubmit={() => businessWrite(biz.id, "clinic/patients", {
        ...(prefill.contactId ? { contactId: prefill.contactId } : { name: form.name, phone: form.phone, email: form.email, address: form.address }),
        sex: form.sex, dateOfBirth: form.dateOfBirth || null, ageYears: form.dateOfBirth ? null : form.ageYears, guardianName: form.guardianName, emergencyPhone: form.emergencyPhone,
        consent: { purposes: form.purposes, method: form.method, givenBy: form.givenBy } })}>
      {!prefill.contactId && <>
        <Field label="Full name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
        <Field label="Mobile"><input type="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
      </>}
      <Field label="Sex"><select required value={form.sex} onChange={set("sex")}><option value="">Choose…</option>{Object.entries(SEX_WORDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Date of birth" hint="Or give the age instead."><input type="date" max={today} value={form.dateOfBirth} onChange={set("dateOfBirth")} /></Field>
      {!form.dateOfBirth && <Field label="Age (years)"><input type="number" min="0" max="130" required value={form.ageYears} onChange={set("ageYears")} /></Field>}
      <Field label="Guardian (for a child)"><input maxLength={150} value={form.guardianName} onChange={set("guardianName")} /></Field>
      <Field label="Emergency phone"><input type="tel" maxLength={30} value={form.emergencyPhone} onChange={set("emergencyPhone")} /></Field>
      {!prefill.contactId && <Field label="Address" wide><input maxLength={300} value={form.address} onChange={set("address")} /></Field>}
      <div className="field-wide hl-consent">
        <strong>Consent (DPDP Act){notice?.version ? ` · notice ${notice.version}` : ""}</strong>
        <p className="hl-notice">{notice?.text || "Loading the notice…"}</p>
        {Object.entries(PURPOSE_WORDS).map(([purpose, label]) => (
          <label key={purpose} className="hl-check"><input type="checkbox" checked={form.purposes.includes(purpose)} disabled={purpose === "treatment"} onChange={() => toggle(purpose)} /> {label}{purpose === "treatment" ? " (needed to register)" : " (optional)"}</label>
        ))}
        <div className="form-grid">
          <Field label="How it was given"><select value={form.method} onChange={set("method")}>{Object.entries(METHOD_WORDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Given by"><input required maxLength={150} value={form.givenBy} onChange={set("givenBy")} placeholder="Self, parent, guardian…" /></Field>
        </div>
        <label className="hl-check"><input type="checkbox" required checked={form.agreed} onChange={set("agreed")} /> The patient (or guardian) was shown this notice and agreed</label>
      </div>
    </FormDialog>
  );
}
