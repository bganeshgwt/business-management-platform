import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../components/SearchPicker";
import SectionCard from "../../components/SectionCard";
import StatusBadge from "../../components/StatusBadge";
import { businessRead } from "../../services/business.service";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { RegisterDialog } from "../../modules/business/health/pages/PatientsPage";
import { SEX_WORDS } from "../../modules/business/health/pages/healthFormat";
import { TOKEN_WORDS } from "../../modules/business/health/pages/tokenQueue";
import { useDesk } from "./deskContext";
import { openTokensOf, registrationFrom } from "./clinicDesk.js";

// The patient at the front desk: found by name, mobile or patient ID, or
// registered there and then with their consent (Register a new patient, or
// "Register …" when the search finds no one); with whether their consent stands and any
// token they hold today, and what the desk does next: a token for a doctor,
// tests for the lab, or their page.
export default function PatientAtDesk({ onToken, onTests }) {
  const biz = useOpenBusiness();
  const desk = useDesk();
  const [patient, setPatient] = useState(null);
  const [registering, setRegistering] = useState(null);
  const tokens = patient ? openTokensOf(desk.tokens, patient.contact_id) : [];
  // The patient just registered, as the search would have found them.
  const registered = (p) => {
    setRegistering(null);
    setPatient({ contact_id: p.contact_id, name: p.name, phone: p.phone, patient_no: p.patient_no, sex: p.sex, age: p.age_years ?? null, consent_active: true });
  };
  return (
    <SectionCard icon="user-plus" title="Patient at the desk" description="Found by name, mobile or patient ID, or registered with their consent.">
      <div className="stack">
        <SearchPicker label="Find a patient" minChars={1} value={patient} onChange={setPatient}
          search={(q, { signal }) => businessRead(biz.id, "clinic/patients", { q, limit: 20 }, signal).then((r) => r.items)}
          getKey={(p) => p.contact_id} getLabel={(p) => p.name}
          getDescription={(p) => `${p.patient_no} · ${p.phone || "no phone"}${p.consent_active ? "" : " · consent withdrawn"}`}
          onCreate={(typed) => setRegistering(registrationFrom(typed))} createLabel={(typed) => `Register “${typed}”`}
          emptyText="No registered patient by that name, mobile or ID" />
        {!patient && (
          <button type="button" className="button button-secondary cw-register" onClick={() => setRegistering({})}>
            <Icon name="user-plus" size={16} /> Register a new patient
          </button>
        )}
        {patient && (
          <div className="cw-patient" role="group" aria-label={`${patient.name} at the desk`}>
            <span className="bz-two-line">
              <strong>{patient.name}</strong>
              <small className="muted">{[patient.patient_no, SEX_WORDS[patient.sex], patient.age != null ? `${patient.age} y` : null, patient.phone].filter(Boolean).join(" · ")}</small>
            </span>
            <div className="hl-strip">
              {patient.consent_active ? <StatusBadge status="active" label="Consent given" /> : <StatusBadge tone="danger" label="Consent withdrawn" />}
              {tokens.map((token) => (
                <StatusBadge key={token.id} tone="info" label={`Token ${token.token_no} · ${token.doctor_name || "clinic queue"} · ${TOKEN_WORDS[token.status][1]}`} />
              ))}
            </div>
            {!patient.consent_active && <p className="hl-note hl-note-warning">No token or test until their consent for treatment is recorded again (the patient&apos;s page, Add consent).</p>}
            <div className="cw-patient-actions">
              {patient.consent_active && <button type="button" className="button" onClick={() => onToken(patient)}><Icon name="users" size={16} /> Give a token</button>}
              {patient.consent_active && desk.can.tests && <button type="button" className="button button-secondary" onClick={() => onTests(patient)}><Icon name="activity" size={16} /> Order tests</button>}
              <Link className="button button-secondary" to={biz.path(`patients/${patient.contact_id}`)}>Patient&apos;s page</Link>
              <button type="button" className="link-button" onClick={() => setPatient(null)}>Clear</button>
            </div>
          </div>
        )}
      </div>
      {registering && <RegisterDialog prefill={registering} onClose={() => setRegistering(null)} onSaved={registered} />}
    </SectionCard>
  );
}
