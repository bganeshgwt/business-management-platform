import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { LabStatus } from "./healthParts";
import { METHOD_WORDS, PURPOSE_WORDS, SEX_WORDS, patientLine } from "./healthFormat";
import "../styles/health.css";

// One patient: who they are, their consent (given, withdrawn, by whom and on
// which notice), visits, appointments and lab orders. The clinical card
// (blood group, allergies, long-term conditions, current medicines) shows
// only to clinical roles, and opening it is logged.
export default function PatientPage() {
  const biz = useOpenBusiness();
  const { contactId } = useParams();
  const navigate = useNavigate();
  const [p, setP] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `clinic/patients/${contactId}`, undefined, controller.signal)
      .then((row) => { setP(row); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version]);
  const refresh = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };

  async function startVisit() {
    try {
      const visit = await businessWrite(biz.id, "clinic/visits", { contactId: Number(contactId) });
      navigate(businessPath(biz.id, `visits/${visit.id}`));
    } catch (err) { toast.error(getErrorMessage(err)); }
  }

  if (!p) return <div className="stack"><BusinessHeader icon="user" title="Patient" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const active = p.consents.filter((k) => !k.withdrawn_at);
  return (
    <div className="stack">
      <BusinessHeader icon="user" title={p.name} description={`${patientLine(p)}${p.phone ? ` · ${p.phone}` : ""}`}
        primary={p.consent_active && (biz.can("patients.edit_clinical") || biz.can("patients.create")) && <button type="button" className="button" onClick={startVisit}><Icon name="plus" size={16} /> Start a visit</button>}
        secondary={<Link className="button button-secondary" to={businessPath(biz.id, "patients")}>All patients</Link>}
        more={[biz.can("patients.edit") && { label: "Edit details", icon: "edit", onClick: () => setDialog("edit") }, biz.can("patients.create") && { label: "Add consent", icon: "shield", onClick: () => setDialog("consent") }].filter(Boolean)} />
      {!p.consent_active && <p className="hl-note hl-note-warning">No active consent for treatment: the record is kept for the retention period, but no new visit or test can be started until consent is given again.</p>}
      <div className="hl-two">
        <SectionCard icon="user" title="Details">
          <dl className="hl-facts">
            <dt>Patient ID</dt><dd className="mono">{p.patient_no}</dd>
            <dt>Sex · age</dt><dd>{SEX_WORDS[p.sex]} · {p.age} y{p.date_of_birth ? ` (born ${dateShort(p.date_of_birth, { year: true })})` : ""}</dd>
            <dt>Phone</dt><dd>{p.phone || "—"}</dd>
            <dt>Address</dt><dd>{p.address || "—"}</dd>
            <dt>Guardian</dt><dd>{p.guardian_name || "—"}</dd>
            <dt>Emergency</dt><dd>{p.emergency_phone || "—"}</dd>
            <dt>Registered</dt><dd>{dateTime(p.created_at)}</dd>
          </dl>
        </SectionCard>
        {p.clinical_access ? (
          <SectionCard icon="heart" title="Clinical card" description="Seen only by clinical roles; this view was logged."
            actions={biz.can("patients.edit_clinical") && <button type="button" className="chip-button" onClick={() => setDialog("clinical")}>Edit</button>}>
            <dl className="hl-facts">
              <dt>Blood group</dt><dd>{p.clinical.blood_group || "—"}</dd>
              <dt>Allergies</dt><dd className={p.clinical.allergies ? "hl-alert-text" : ""}>{p.clinical.allergies || "None known"}</dd>
              <dt>Conditions</dt><dd>{p.clinical.conditions || "—"}</dd>
              <dt>Medicines</dt><dd>{p.clinical.current_medicines || "—"}</dd>
            </dl>
          </SectionCard>
        ) : (
          <SectionCard icon="lock" title="Clinical card"><p className="muted">Clinical notes are for doctors only. Your role sees the patient's details, consent, visits and whether a report is ready.</p></SectionCard>
        )}
      </div>
      <SectionCard flush icon="shield" title="Consent" description={`${active.length} active · the notice version each was given on is kept`}>
        <DataGrid id="clinic-patient-consents" caption="Consents" variant="compact" rows={p.consents} columns={[
          { key: "purpose", header: "Purpose", value: (k) => PURPOSE_WORDS[k.purpose], mobile: "title" },
          { key: "given", header: "Given", type: "datetime", value: (k) => k.created_at, mobile: "subtitle" },
          { key: "how", header: "How", value: (k) => `${METHOD_WORDS[k.method]} · by ${k.given_by}` },
          { key: "version", header: "Notice", value: (k) => k.notice_version },
          { key: "recorded", header: "Recorded by", value: (k) => k.recorded_by_name, defaultHidden: true },
          { key: "status", header: "Status", value: (k) => (k.withdrawn_at ? "Withdrawn" : "Active"), mobile: "show",
            render: (k) => (k.withdrawn_at ? <span className="bz-two-line"><StatusBadge tone="neutral" label={`Withdrawn ${dateShort(k.withdrawn_at)}`} /><small className="muted">{k.withdrawal_reason}</small></span> : <StatusBadge status="active" label="Active" />) },
          biz.can("patients.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (k) => (!k.withdrawn_at && <button type="button" className="link-button danger" onClick={() => setDialog({ withdraw: k })}>Withdraw</button>) },
        ].filter(Boolean)} />
      </SectionCard>
      <SectionCard flush icon="clipboard" title="Visits">
        <DataGrid id="clinic-patient-visits" caption="Visits" variant="compact" rows={p.visits} onRowClick={(v) => navigate(businessPath(biz.id, `visits/${v.id}`))} columns={[
          { key: "no", header: "Visit", value: (v) => v.visit_no, className: "mono", mobile: "title" },
          { key: "date", header: "Date", type: "datetime", value: (v) => v.created_at, mobile: "subtitle" },
          { key: "doctor", header: "Doctor", value: (v) => v.doctor_name || "" },
          { key: "status", header: "Status", value: (v) => v.status, render: (v) => <StatusBadge status={v.status === "completed" ? "completed" : "open"} label={v.status === "completed" ? "Done" : "In consultation"} /> },
          { key: "follow", header: "Follow-up", type: "date", value: (v) => v.follow_up_on },
          { key: "bill", header: "Bill", value: (v) => v.document_no || "" },
        ]} empty="No visits yet" />
      </SectionCard>
      {biz.has("lab") && biz.can("lab.view") && (
        <SectionCard flush icon="activity" title="Lab orders">
          <DataGrid id="clinic-patient-lab" caption="Lab orders" variant="compact" rows={p.lab_orders} onRowClick={(o) => navigate(businessPath(biz.id, `lab-orders/${o.id}`))} columns={[
            { key: "no", header: "Order", value: (o) => o.order_no, className: "mono", mobile: "title" },
            { key: "date", header: "Ordered", type: "datetime", value: (o) => o.created_at, mobile: "subtitle" },
            { key: "status", header: "Status", value: (o) => o.status, render: (o) => <LabStatus status={o.status} />, mobile: "show" },
            { key: "approved", header: "Reported", type: "datetime", value: (o) => o.approved_at },
          ]} empty="No tests yet" />
        </SectionCard>
      )}
      {dialog === "edit" && <EditDialog p={p} onClose={() => setDialog(null)} onSaved={() => refresh("Details saved")} />}
      {dialog === "clinical" && <ClinicalDialog p={p} onClose={() => setDialog(null)} onSaved={() => refresh("Clinical card saved")} />}
      {dialog === "consent" && <ConsentDialog p={p} onClose={() => setDialog(null)} onSaved={() => refresh("Consent recorded")} />}
      {dialog?.withdraw && <ReasonDialog title={`Withdraw consent: ${PURPOSE_WORDS[dialog.withdraw.purpose]}`} icon="shield" submitLabel="Record withdrawal" label="Reason, as the patient gave it"
        description={dialog.withdraw.purpose === "treatment" ? "No new visit or test is started after this. Records the law requires are kept for the retention period." : "This use of their data stops from now."}
        onSubmit={(reason) => businessWrite(biz.id, `clinic/consents/${dialog.withdraw.id}/withdraw`, { reason })} onClose={() => setDialog(null)} onSaved={() => refresh("Withdrawal recorded")} />}
    </div>
  );
}

function EditDialog({ p, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ name: p.name, phone: p.phone || "", address: p.address || "", sex: p.sex, dateOfBirth: p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : "",
    ageYears: p.age_years ?? "", guardianName: p.guardian_name || "", emergencyPhone: p.emergency_phone || "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <FormDialog title={`Edit ${p.name}`} icon="user" onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `clinic/patients/${p.contact_id}`, { ...form, dateOfBirth: form.dateOfBirth || null, ageYears: form.dateOfBirth ? null : form.ageYears }, "patch")}>
      <Field label="Full name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Mobile"><input type="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
      <Field label="Sex"><select value={form.sex} onChange={set("sex")}>{Object.entries(SEX_WORDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Date of birth"><input type="date" value={form.dateOfBirth} onChange={set("dateOfBirth")} /></Field>
      {!form.dateOfBirth && <Field label="Age at registration (years)"><input type="number" min="0" max="130" value={form.ageYears} onChange={set("ageYears")} /></Field>}
      <Field label="Guardian"><input maxLength={150} value={form.guardianName} onChange={set("guardianName")} /></Field>
      <Field label="Emergency phone"><input type="tel" maxLength={30} value={form.emergencyPhone} onChange={set("emergencyPhone")} /></Field>
      <Field label="Address" wide><input maxLength={300} value={form.address} onChange={set("address")} /></Field>
    </FormDialog>
  );
}

function ClinicalDialog({ p, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ bloodGroup: p.clinical.blood_group || "", allergies: p.clinical.allergies || "", conditions: p.clinical.conditions || "", currentMedicines: p.clinical.current_medicines || "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <FormDialog title={`Clinical card · ${p.name}`} icon="heart" onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `clinic/patients/${p.contact_id}/clinical`, form, "put")}>
      <Field label="Blood group"><select value={form.bloodGroup} onChange={set("bloodGroup")}><option value="">Not known</option>{["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((g) => <option key={g}>{g}</option>)}</select></Field>
      <Field label="Allergies" wide><input maxLength={500} value={form.allergies} onChange={set("allergies")} placeholder="Drug allergies first, e.g. Penicillin (rash)" /></Field>
      <Field label="Long-term conditions" wide><input maxLength={500} value={form.conditions} onChange={set("conditions")} /></Field>
      <Field label="Current medicines" wide><input maxLength={500} value={form.currentMedicines} onChange={set("currentMedicines")} /></Field>
    </FormDialog>
  );
}

function ConsentDialog({ p, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const taken = new Set(p.consents.filter((k) => !k.withdrawn_at).map((k) => k.purpose));
  const free = Object.keys(PURPOSE_WORDS).filter((k) => !taken.has(k));
  const [form, setForm] = useState({ purpose: free[0] || "", method: "signed_form", givenBy: "Self" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <FormDialog title="Record consent" icon="shield" width={520} onClose={onClose} onSaved={onSaved} disabled={!free.length}
      description={free.length ? "Shown the current notice; recorded with its version." : "Every purpose already has an active consent."}
      onSubmit={() => businessWrite(biz.id, `clinic/patients/${p.contact_id}/consents`, form)}>
      <Field label="Purpose"><select value={form.purpose} onChange={set("purpose")}>{free.map((k) => <option key={k} value={k}>{PURPOSE_WORDS[k]}</option>)}</select></Field>
      <Field label="How it was given"><select value={form.method} onChange={set("method")}>{Object.entries(METHOD_WORDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Given by"><input required maxLength={150} value={form.givenBy} onChange={set("givenBy")} /></Field>
    </FormDialog>
  );
}
