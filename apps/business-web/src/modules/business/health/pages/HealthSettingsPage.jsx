import { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useDirtyGuard, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { NOT_OWN } from "../../core/pages/approvers";
import "../styles/health.css";

// Pharmacy settings (drug licences, retention, near-expiry window) or Clinic &
// lab settings (lab details, consent notice, retention, referral commission),
// and the people who sign: registered pharmacists, doctors, pathologists.
// The defaults are the standard practice written in docs/BUSINESS_RULES.md
// › Pharmacy, clinic and lab.
const KIND_WORDS = { pharmacist: "Registered pharmacist", doctor: "Doctor", pathologist: "Pathologist" };

export default function HealthSettingsPage() {
  const biz = useOpenBusiness();
  const pharmacy = biz.type === "pharmacy";
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(null);
  const canEdit = pharmacy ? biz.can("pharmacy.edit") || biz.can("settings.edit") : biz.can("settings.edit");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "health/settings", undefined, controller.signal)
      .then((s) => { setSaved(s); setForm(s); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const dirty = Boolean(form && saved && JSON.stringify(form) !== JSON.stringify(saved));
  useDirtyGuard(dirty);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError("");
    const body = pharmacy ? {
      drugLicence20: form.drug_licence_20 || "", drugLicence21: form.drug_licence_21 || "", drugLicence20b: form.drug_licence_20b || "", drugLicence21b: form.drug_licence_21b || "",
      drugLicence20f: form.drug_licence_20f || "", h1RetentionYears: form.h1_retention_years, xRetentionYears: form.x_retention_years,
      prescriptionRetentionYears: form.prescription_retention_years, rxScanRequired: Boolean(form.rx_scan_required), nearExpiryDays: form.near_expiry_days,
    } : {
      labName: form.lab_name || "", labRegistration: form.lab_registration || "", reportFooter: form.report_footer || "", clinicalRetentionYears: form.clinical_retention_years,
      consentNotice: form.consent_notice, referralCommissionEnabled: Boolean(form.referral_commission_enabled), referralCommissionPercent: form.referral_commission_percent,
    };
    try {
      await businessWrite(biz.id, "health/settings", body, "put");
      toast.success("Settings saved");
      setVersion((n) => n + 1);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const signatories = useMemo(() => (saved?.signatories || []).filter((s) => (pharmacy ? s.kind === "pharmacist" : s.kind !== "pharmacist")), [saved, pharmacy]);
  const columns = [
    { key: "name", header: "Name", value: (s) => s.name, mobile: "title", render: (s) => <span className="bz-two-line"><strong>{s.name}</strong><small className="muted">{s.qualification || s.user_name}</small></span> },
    { key: "kind", header: "Signs as", value: (s) => KIND_WORDS[s.kind], mobile: "subtitle" },
    { key: "reg", header: "Registration", value: (s) => s.registration_no, render: (s) => <span className="bz-two-line"><span className="mono">{s.registration_no}</span><small className="muted">{s.council || ""}</small></span> },
    { key: "calendar", header: "Calendar", value: (s) => s.resource_name || "", defaultHidden: pharmacy },
    // A PIN someone else set signs nothing until its person chooses their own.
    { key: "pin", header: "PIN", value: (s) => (!s.has_pin ? "Not set" : s.pin_given ? NOT_OWN : "Set"),
      render: (s) => (!s.has_pin ? <StatusBadge tone="warning" label="No PIN yet" /> : s.pin_given ? <StatusBadge tone="warning" label={NOT_OWN} /> : <StatusBadge status="active" label="PIN set" />) },
    { key: "active", header: "Status", value: (s) => (s.active ? "Active" : "Off"), render: (s) => <StatusBadge status={s.active ? "active" : "inactive"} label={s.active ? "Active" : "Switched off"} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => <button type="button" className="chip-button" onClick={() => setAdding(s)}>Edit</button> },
  ].filter(Boolean);

  if (!form) return <div className="stack"><BusinessHeader icon="settings" title={pharmacy ? "Pharmacy settings" : "Clinic & lab settings"} /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <BusinessHeader icon="settings" title={pharmacy ? "Pharmacy settings" : "Clinic & lab settings"}
        description={pharmacy ? "Drug licence numbers printed on every bill, how long the registers and prescriptions are kept, and the registered pharmacists who sign off Schedule X."
          : "The lab's details on reports, the consent notice patients agree to, how long clinical records are kept, and the doctors and pathologists who sign."} />
      <form className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        <fieldset className="bz-fieldset" disabled={!canEdit || busy}>
          {pharmacy ? (
            <>
              <SectionCard icon="file" title="Drug licences" description="Printed on every bill. Form 20 / 21 are retail licences; 20B / 21B wholesale; 20F lets you sell Schedule X. A branch licensed on its own enters its numbers under Licences by branch below.">
                <div className="form-grid">
                  <Field label="Form 20 (retail)"><input value={form.drug_licence_20 || ""} onChange={set("drug_licence_20")} maxLength={60} /></Field>
                  <Field label="Form 21 (retail, Schedule C / C1)"><input value={form.drug_licence_21 || ""} onChange={set("drug_licence_21")} maxLength={60} /></Field>
                  <Field label="Form 20B (wholesale)"><input value={form.drug_licence_20b || ""} onChange={set("drug_licence_20b")} maxLength={60} /></Field>
                  <Field label="Form 21B (wholesale, Schedule C / C1)"><input value={form.drug_licence_21b || ""} onChange={set("drug_licence_21b")} maxLength={60} /></Field>
                  <Field label="Form 20F (Schedule X)" hint="Without it, do not stock Schedule X medicines."><input value={form.drug_licence_20f || ""} onChange={set("drug_licence_20f")} maxLength={60} /></Field>
                </div>
              </SectionCard>
              <SectionCard icon="clock" title="Registers and prescriptions" description="Standard practice: the H1 register 3 years (Rule 65), Schedule X prescriptions 2 years. Check with your drugs inspector.">
                <div className="form-grid">
                  <Field label="H1 register kept for (years)"><input type="number" min="1" max="30" required value={form.h1_retention_years} onChange={set("h1_retention_years")} /></Field>
                  <Field label="Schedule X register kept for (years)"><input type="number" min="1" max="30" required value={form.x_retention_years} onChange={set("x_retention_years")} /></Field>
                  <Field label="Prescriptions kept for (years)"><input type="number" min="1" max="30" required value={form.prescription_retention_years} onChange={set("prescription_retention_years")} /></Field>
                  <Field label="Expiring soon means within (days)"><input type="number" min="7" max="365" required value={form.near_expiry_days} onChange={set("near_expiry_days")} /></Field>
                  <label className="hl-check field-wide"><input type="checkbox" checked={Boolean(form.rx_scan_required)} onChange={set("rx_scan_required")} /> A photo or scan of the prescription is required for Schedule H, H1 and X sales</label>
                </div>
              </SectionCard>
            </>
          ) : (
            <>
              <SectionCard icon="activity" title="The lab on its reports" description="Shown at the top of every printed lab report.">
                <div className="form-grid">
                  <Field label="Lab name"><input value={form.lab_name || ""} onChange={set("lab_name")} maxLength={150} placeholder={form.seller?.display_name || ""} /></Field>
                  <Field label="Registration / accreditation" hint="Clinical establishment registration, NABL number…"><input value={form.lab_registration || ""} onChange={set("lab_registration")} maxLength={120} /></Field>
                  <Field label="Report footer" wide><textarea rows={2} value={form.report_footer || ""} onChange={set("report_footer")} maxLength={500} /></Field>
                </div>
              </SectionCard>
              <SectionCard icon="shield" title="Patient consent and records" description="DPDP Act 2023: patients are told what is collected and why, and may withdraw. A changed notice becomes a new version; each consent keeps the version it was given on.">
                <div className="form-grid">
                  <Field label={`Consent notice (now ${saved.consent_version})`} wide><textarea rows={6} required minLength={50} maxLength={4000} value={form.consent_notice || ""} onChange={set("consent_notice")} /></Field>
                  <Field label="Clinical records kept for (years)" hint="At least 3 years (IMC Regulations 1.3.1); longer for medico-legal cases."><input type="number" min="1" max="30" required value={form.clinical_retention_years} onChange={set("clinical_retention_years")} /></Field>
                </div>
              </SectionCard>
              <SectionCard icon="alert" title="Referral commission" description="Off by default. A commission for referring patients or samples is an ethical and legal question (IMC Regulations 6.4 forbid it for doctors). Switch on only after advice.">
                <div className="form-grid">
                  <label className="hl-check field-wide"><input type="checkbox" checked={Boolean(form.referral_commission_enabled)} onChange={set("referral_commission_enabled")} disabled={!biz.can("settings.edit")} /> Record a referral commission on tests sent to an outside lab</label>
                  {form.referral_commission_enabled && <Field label="Commission (% of the bill)"><input type="number" min="0" max="50" step="0.01" value={form.referral_commission_percent} onChange={set("referral_commission_percent")} /></Field>}
                </div>
              </SectionCard>
            </>
          )}
          {canEdit && (
            <div className="form-actions">
              <button type="button" className="button button-secondary" disabled={!dirty} onClick={() => setForm(saved)}>Undo changes</button>
              <button type="submit" className="button" disabled={!dirty || busy}>{busy ? "Saving…" : "Save settings"}</button>
            </div>
          )}
        </fieldset>
      </form>
      {pharmacy && (saved.locationLicences || []).length > 1 && <BranchLicences rows={saved.locationLicences} canEdit={canEdit} business={saved} onSaved={() => setVersion((n) => n + 1)} />}
      <SectionCard flush icon="users" title={pharmacy ? "Registered pharmacists" : "Doctors and pathologists"}
        description={pharmacy ? "The pharmacist named on bills and who signs off Schedule X with their own PIN." : "The doctor's registration number prints on prescriptions; the pathologist approves reports with their PIN."}
        actions={canEdit && <button type="button" className="button" onClick={() => setAdding({ kind: pharmacy ? "pharmacist" : "doctor" })}><Icon name="plus" size={15} /> Add</button>}>
        <DataGrid id="health-signatories" caption="People who sign" rows={signatories} columns={columns} rowNoun={["person", "people"]} variant="compact"
          empty="Nobody set up yet" emptyHint={pharmacy ? "Add the registered pharmacist from your staff." : "Add each doctor and the pathologist from your staff."} />
      </SectionCard>
      {adding && <SignatoryDialog current={adding} pharmacy={pharmacy} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); setVersion((n) => n + 1); }} />}
    </div>
  );
}

function SignatoryDialog({ current, pharmacy, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["members", ...(pharmacy ? [] : ["resources"])]);
  const [form, setForm] = useState({ kind: current.kind, userId: current.user_id || "", name: current.name || "", qualification: current.qualification || "",
    registrationNo: current.registration_no || "", council: current.council || "", resourceId: current.resource_id || "", active: current.active ?? true });
  const set = useCallback((key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value })), []);
  const members = (options?.members || []).filter((m) => m.active);
  return (
    <FormDialog title={current.id ? `Edit ${current.name}` : "Add a person who signs"} icon="users" width={620} onClose={onClose} onSaved={onSaved} successMessage="Saved"
      description="They sign with their own PIN (My profile › Personal PIN). Use the name and number exactly as on their council registration."
      onSubmit={() => businessWrite(biz.id, "health/signatories", { ...form, userId: Number(form.userId), resourceId: form.resourceId ? Number(form.resourceId) : null })}>
      {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
      {!pharmacy && (
        <Field label="Signs as">
          <select value={form.kind} onChange={set("kind")} disabled={Boolean(current.id)}>
            <option value="doctor">Doctor</option><option value="pathologist">Pathologist</option>
          </select>
        </Field>
      )}
      <Field label="Staff member">
        <select required value={form.userId} onChange={(e) => { const m = members.find((x) => String(x.id) === e.target.value); setForm((f) => ({ ...f, userId: e.target.value, name: f.name || m?.name || "" })); }} disabled={Boolean(current.id)}>
          <option value="">Choose…</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role_name}</option>)}
        </select>
      </Field>
      <Field label="Name as registered"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Qualification"><input maxLength={120} value={form.qualification} onChange={set("qualification")} placeholder={form.kind === "pharmacist" ? "B.Pharm / D.Pharm" : "MBBS, MD"} /></Field>
      <Field label="Registration number"><input required maxLength={60} value={form.registrationNo} onChange={set("registrationNo")} /></Field>
      <Field label="Council"><input maxLength={150} value={form.council} onChange={set("council")} placeholder={form.kind === "pharmacist" ? "State Pharmacy Council" : "State Medical Council"} /></Field>
      {form.kind === "doctor" && (
        <Field label="Appointment calendar" hint="Visits booked with this calendar print this doctor's details.">
          <select value={form.resourceId} onChange={set("resourceId")}>
            <option value="">None</option>
            {(options?.resources || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
      )}
      <label className="hl-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>
    </FormDialog>
  );
}

// Each pharmacy premises is licensed on its own: a branch's numbers print on
// the bills it raises. A branch with none uses the business-wide numbers.
const LICENCE_FORMS = [["drug_licence_20", "drugLicence20", "Form 20"], ["drug_licence_21", "drugLicence21", "Form 21"],
  ["drug_licence_20b", "drugLicence20b", "Form 20B"], ["drug_licence_21b", "drugLicence21b", "Form 21B"], ["drug_licence_20f", "drugLicence20f", "Form 20F"]];

function BranchLicences({ rows, canEdit, business, onSaved }) {
  const [editing, setEditing] = useState(null);
  const own = (row) => LICENCE_FORMS.filter(([column]) => row[column]).map(([column, , form]) => `${form} ${row[column]}`);
  const columns = [
    { key: "location", header: "Branch", value: (r) => r.location_name, mobile: "title", render: (r) => <span>{r.location_name}{!r.active && <span className="muted small"> (closed)</span>}</span> },
    { key: "licences", header: "Licences on its bills", value: (r) => own(r).join(" · ") || "Business licences",
      render: (r) => (own(r).length ? <span className="mono small">{own(r).join(" · ")}</span> : <span className="muted">Uses the business licences above</span>) },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <button type="button" className="chip-button" onClick={() => setEditing(r)}>Edit</button> },
  ].filter(Boolean);
  return (
    <SectionCard flush icon="map-pin" title="Licences by branch" description="Each pharmacy premises holds its own drug licences. Enter a branch's numbers to print them on its bills; leave them empty to use the business licences.">
      <DataGrid id="pharmacy-branch-licences" caption="Licences by branch" rows={rows.map((r) => ({ ...r, id: r.location_id }))} columns={columns} variant="compact" rowNoun={["branch", "branches"]} />
      {editing && <BranchLicenceDialog row={editing} business={business} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast.success("Licences saved"); onSaved(); }} />}
    </SectionCard>
  );
}

function BranchLicenceDialog({ row, business, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => Object.fromEntries(LICENCE_FORMS.map(([column, field]) => [field, row[column] || ""])));
  return (
    <FormDialog title={`Drug licences: ${row.location_name}`} icon="file" width={560} onClose={onClose} onSaved={onSaved}
      description="Leave every number empty to use the business licences on this branch's bills."
      onSubmit={() => businessWrite(biz.id, `health/location-licences/${row.location_id}`, form, "put")}>
      {LICENCE_FORMS.map(([column, field, label]) => (
        <Field key={field} label={label}>
          <input value={form[field]} maxLength={60} placeholder={business[column] || ""} onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))} />
        </Field>
      ))}
    </FormDialog>
  );
}
