import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../components/SectionCard";
import { ErrorMessage, Loading } from "../../components/Feedback";
import { businessRead } from "../../services/business.service";
import { getErrorMessage } from "../../services/api";
import { dateShort } from "@bmp/shared/format";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { ClinicalDialog } from "../../modules/business/health/pages/PatientPage";
import { FlagBadge } from "../../modules/business/health/pages/healthParts";
import { resultText } from "../../modules/business/health/pages/healthFormat";

// The patient's history beside a consultation, for clinical roles: the
// clinical card (allergies, current medicines, long-term conditions, blood
// group), kept up to date here by the doctor, and the earlier visits, each
// opened in place to read what was found, the diagnosis, the medicines, the
// advice, the referral and the approved results. Every look at clinical data
// is in the activity log, as anywhere else.
export default function PatientHistory({ contactId, visitId }) {
  const biz = useOpenBusiness();
  const [patient, setPatient] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [openId, setOpenId] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `clinic/patients/${contactId}`, undefined, controller.signal).then((p) => { setPatient(p); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version]);
  const earlier = (patient?.visits || []).filter((v) => String(v.id) !== String(visitId));
  const card = patient?.clinical || {};
  return (
    <SectionCard icon="history" title="History"
      description={patient ? `${patient.name} · ${earlier.length ? `${earlier.length} earlier visit${earlier.length === 1 ? "" : "s"}` : "first visit"}` : undefined}
      actions={patient?.clinical_access && biz.can("patients.edit_clinical") && <button type="button" className="chip-button" onClick={() => setEditing(true)}>Edit card</button>}>
      <ErrorMessage message={error} />
      {!patient ? (!error && <Loading label="Reading the history…" />) : (
        <div className="stack">
          <dl className="hl-facts">
            <dt>Allergies</dt><dd className={card.allergies ? "hl-alert-text" : ""}>{card.allergies || "None known"}</dd>
            <dt>Medicines</dt><dd>{card.current_medicines || "—"}</dd>
            <dt>Conditions</dt><dd>{card.conditions || "—"}</dd>
            <dt>Blood group</dt><dd>{card.blood_group || "—"}</dd>
          </dl>
          {earlier.length > 0 && (
            <ul className="cw-visits">
              {earlier.map((v) => (
                <li key={v.id}>
                  <button type="button" className="cw-visit-head" aria-expanded={openId === v.id} onClick={() => setOpenId(openId === v.id ? null : v.id)}>
                    <span className="bz-two-line">
                      <strong>{dateShort(v.created_at, { year: true })} · {v.visit_no}</strong>
                      <small className="muted">{v.doctor_name || "No doctor"}{v.status === "open" ? " · in consultation" : ""}{v.follow_up_on ? ` · follow-up ${dateShort(v.follow_up_on, { year: true })}` : ""}</small>
                    </span>
                    <Icon name={openId === v.id ? "chevron-up" : "chevron-down"} size={16} />
                  </button>
                  {openId === v.id && <EarlierVisit visitId={v.id} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && <ClinicalDialog p={patient} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setVersion((n) => n + 1); }} />}
    </SectionCard>
  );
}

// One earlier visit, read when it is opened (and that read is logged).
function EarlierVisit({ visitId }) {
  const biz = useOpenBusiness();
  const [visit, setVisit] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `clinic/visits/${visitId}`, undefined, controller.signal).then(setVisit)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, visitId]);
  if (!visit) return <div className="cw-visit">{error ? <ErrorMessage message={error} /> : <Loading label="Reading the visit…" />}</div>;
  const medicines = visit.prescription || [];
  const results = visit.lab_results || [];
  const said = visit.complaints || visit.diagnosis || visit.advice || visit.referred_to || medicines.length || results.length;
  return (
    <div className="cw-visit">
      {visit.complaints && <p><strong>Complaints:</strong> {visit.complaints}</p>}
      {visit.diagnosis && <p><strong>Diagnosis:</strong> {visit.diagnosis}{visit.icd10_code ? ` (${visit.icd10_code})` : ""}</p>}
      {medicines.length > 0 && (
        <ul className="cw-lines" aria-label="Medicines">
          {medicines.map((p) => <li key={p.id}>{[p.drug_name, p.strength, p.dose, p.frequency, p.duration, p.instructions].filter(Boolean).join(" · ")}</li>)}
        </ul>
      )}
      {visit.advice && <p><strong>Advice:</strong> {visit.advice}</p>}
      {visit.referred_to && <p><strong>Referred to:</strong> {visit.referred_to}{visit.referral_reason ? ` (${visit.referral_reason})` : ""}</p>}
      {results.length > 0 && (
        <ul className="cw-lines" aria-label="Lab results">
          {results.map((r) => <li key={`${r.order_no}-${r.test_name}-${r.parameter}`}>{r.parameter}: <strong>{resultText(r)}</strong> {r.unit} <FlagBadge flag={r.flag} /></li>)}
        </ul>
      )}
      {!said && <p className="muted">Nothing was written at this visit.</p>}
    </div>
  );
}
