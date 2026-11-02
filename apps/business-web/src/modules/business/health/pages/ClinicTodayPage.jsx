import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import LiveIndicator from "../../../../components/LiveIndicator";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateLong, timeOnly } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { ReportReady } from "./healthParts";
import { RegisterDialog } from "./PatientsPage";
import "../styles/health.css";
import "../../online-booking/styles/online-booking.css";

const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const aboutOf = (age, sex) => [age !== null && age !== undefined && age !== "" ? `${age} y` : null, sex].filter(Boolean).join(", ");
// Booked online: for whom, as the guest gave it; or, booked for themselves on a
// family member's record (one phone), the name they booked under.
const forWhom = (r) => {
  if (r.for_whom === "someone_else") return `For ${r.person_name}${aboutOf(r.person_age, r.person_sex) ? ` (${aboutOf(r.person_age, r.person_sex)})` : ""}`;
  return r.booker_name && !sameName(r.booker_name, r.patient_name) ? `Booked as ${r.booker_name}` : null;
};
// Who the guest said is coming: the person booked for, or the booker.
const typedOf = (r) => (r.for_whom === "someone_else" ? { name: r.person_name, age: r.person_age, sex: r.person_sex }
  : { name: r.booker_name || r.patient_name, age: r.person_age, sex: r.person_sex });
// The registration form filled from what the guest gave online: the person booked for; the booker on a
// record of their own (the booking found a family member's); or the customer the booking found.
const prefillOf = (r) => {
  if (r.for_whom === "someone_else") {
    return { name: r.person_name, phone: r.booker_mobile || r.patient_phone || "", sex: r.person_sex || "", ageYears: r.person_age ?? "", guardianName: r.booker_name || "", givenBy: "Parent or guardian" };
  }
  if (r.source === "guests_site" && r.registered) return { name: r.booker_name || "", phone: r.booker_mobile || "", sex: r.person_sex || "", ageYears: r.person_age ?? "" };
  return { contactId: r.contact_id, name: r.patient_name, ...(r.source === "guests_site" ? { sex: r.person_sex || "", ageYears: r.person_age ?? "" } : {}) };
};

// Today's patients: the day's appointments by time with their visit (not
// started, in consultation, done), whether they are registered with consent,
// billed, and whether their lab report is ready. The front desk registers and
// starts the visit; the doctor opens it to write the consultation. Live: an
// appointment booked, a token given, a visit started or billed, a report
// ready anywhere shows here within a second.
export default function ClinicTodayPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [day, setDay] = useState(businessToday(biz.business.timezone));
  const [doctor, setDoctor] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [registering, setRegistering] = useState(null);
  // An online booking's patient chosen among those who share the booker's mobile: { row, patients }.
  const [choosing, setChoosing] = useState(null);
  const { options } = useOptions(["resources"]);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const live = useLiveRefresh({ business: biz.id }, ["appointment", "token", "visit", "lab", "sale"], reload);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "clinic/today", { day, ...(doctor ? { doctor } : {}) }, controller.signal)
      .then((d) => { setData(d); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, day, doctor, version]);
  const canStart = biz.can("patients.edit_clinical") || biz.can("patients.create");
  const isToday = day === businessToday(biz.business.timezone);

  async function giveToken(row, contactId) {
    try {
      const token = await businessWrite(biz.id, "clinic/tokens", { appointmentId: row.appointment_id, ...(contactId ? { contactId } : {}) });
      toast.success(`Token ${token.token_no} for ${token.patient_name}`);
      reload();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    }
  }
  // Booked online, and come: a family books on one phone, so the desk first sees
  // the clinic's patients on the booker's mobile and gives the token to the one
  // who came, on their own record; it registers someone only when they are new.
  async function arrive(row) {
    try {
      const { patients } = await businessRead(biz.id, `clinic/appointments/${row.appointment_id}/same-mobile`);
      const others = patients.filter((p) => !p.booked);
      if (row.for_whom === "someone_else" ? patients.length : others.length) {
        setChoosing({ row, patients });
        return;
      }
      if (row.for_whom !== "someone_else" && row.registered) await giveToken(row);
      else setRegistering(row);
    } catch (err) { toast.error(getErrorMessage(err)); }
  }
  async function start(row) {
    try {
      const visit = await businessWrite(biz.id, "clinic/visits", { appointmentId: row.appointment_id });
      navigate(biz.path(`visits/${visit.id}`));
    } catch (err) { toast.error(getErrorMessage(err)); }
  }
  const rows = data?.appointments || [];
  const columns = [
    { key: "time", header: "Time", value: (r) => r.starts_at, render: (r) => timeOnly(r.starts_at), mobile: "subtitle", width: 90 },
    { key: "patient", header: "Patient", value: (r) => r.patient_name, mobile: "title", render: (r) => (
      <span className="bz-two-line"><strong>{r.patient_name} {r.source === "guests_site" && <span className="ob-online-tag">Online</span>}</strong>
        <small className="muted">{r.patient_no || "Not registered"}{r.patient_phone ? ` · ${r.patient_phone}` : ""}</small>
        {r.source === "guests_site" && <small className="muted">{[forWhom(r), r.visit_kind === "follow_up" ? "Visited before" : r.visit_kind === "new" ? "New" : null, r.online_reason].filter(Boolean).join(" · ")}</small>}</span>
    ) },
    { key: "doctor", header: "Doctor", value: (r) => r.doctor_name },
    { key: "token", header: "Token", type: "number", value: (r) => r.token_no, width: 80, render: (r) => (r.token_no ? <strong className="mono">{r.token_no}</strong> : <span className="muted">—</span>) },
    { key: "service", header: "For", value: (r) => r.service_name, defaultHidden: true },
    { key: "visit", header: "Visit", value: (r) => r.visit_status || r.appointment_status, mobile: "show", render: (r) => (
      r.appointment_status === "cancelled" ? <StatusBadge tone="neutral" label="Cancelled" /> : r.appointment_status === "no_show" ? <StatusBadge status="no_show" />
        : r.appointment_status === "requested" && r.holds ? <StatusBadge tone="warning" label="Online request" />
        : ["declined", "expired", "requested"].includes(r.appointment_status) ? <StatusBadge tone="neutral" label={r.appointment_status === "declined" ? "Declined" : "Not answered"} />
        : r.visit_status === "completed" ? <StatusBadge status="completed" label="Seen" /> : r.visit_status === "open" ? <StatusBadge tone="info" label="In consultation" /> : <StatusBadge tone="warning" label="Waiting" />) },
    { key: "bill", header: "Billed", value: (r) => (r.document_id ? "Yes" : "No"), render: (r) => (r.document_id ? <StatusBadge status="paid" label="Billed" /> : <span className="muted">—</span>) },
    { key: "lab", header: "Lab", value: (r) => r.lab_status || "none", render: (r) => <ReportReady status={r.lab_status} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", width: 230, render: (r) => {
      if (["cancelled", "no_show", "declined", "expired"].includes(r.appointment_status)) return null;
      if (r.appointment_status === "requested") return r.holds ? <Link className="chip-button" to={biz.path("online-booking")}>Answer in Online booking</Link> : null;
      const online = r.source === "guests_site";
      // Booked online for someone else (a child, a parent), or by someone not yet a patient: on the day,
      // the patient who came takes the appointment with their token, on their own record.
      if (online && !r.token_no && !r.visit_id && (r.for_whom === "someone_else" || !r.registered)) {
        if (!isToday) return <small className="muted">{r.for_whom === "someone_else" ? `${r.person_name}: token on arrival` : "Token on arrival"}</small>;
        return biz.can("patients.create") && <button type="button" className="chip-button" onClick={() => arrive(r)}>Arrived: token</button>;
      }
      if (!r.registered) return biz.can("patients.create") && <button type="button" className="chip-button" onClick={() => setRegistering(r)}>Register</button>;
      if (r.visit_id) return <button type="button" className="chip-button" onClick={() => navigate(biz.path(`visits/${r.visit_id}`))}>Open visit</button>;
      if (!r.consent_active) return <small className="muted">No consent</small>;
      return (
        <span className="bz-inline">
          {!r.token_no && isToday && biz.can("patients.create") && <button type="button" className="chip-button" onClick={() => (online ? arrive(r) : giveToken(r))}>Arrived: token</button>}
          {canStart && <button type="button" className="chip-button" onClick={() => start(r)}>Start visit</button>}
        </span>
      );
    } },
  ];
  const waiting = rows.filter((r) => r.appointment_status === "booked" && !r.visit_id).length;
  const seen = rows.filter((r) => r.visit_status === "completed").length;
  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Today's patients" description={`${dateLong(day)}: appointments by time, their visit, bill and lab report.`} actions={<LiveIndicator status={live} />} />
      <ErrorMessage message={error} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="calendar" label="Appointments" value={data ? String(rows.length) : ""} loading={!data} />
        <StatTile icon="clock" label="Waiting" value={data ? String(waiting) : ""} loading={!data} />
        <StatTile icon="check" label="Seen" value={data ? String(seen + (data.walk_ins || []).filter((w) => w.visit_status === "completed").length) : ""} loading={!data} />
        <StatTile icon="activity" label="Reports pending" value={data ? String(rows.filter((r) => r.lab_status === "pending").length) : ""} loading={!data} />
      </div>
      <SectionCard flush icon="list" title="Appointments">
        <DataGrid id="clinic-today" caption="Today's appointments" rows={rows} rowKey={(r) => r.appointment_id} columns={columns} rowNoun={["appointment", "appointments"]} loading={!data && !error}
          toolbar={(
            <>
              <label className="field hl-inline-field"><span>Day</span><input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
              <label className="field hl-inline-field"><span>Doctor</span>
                <select value={doctor} onChange={(e) => setDoctor(e.target.value)}><option value="">All</option>{(options?.resources || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              </label>
            </>
          )}
          empty="No appointments on this day" emptyIcon="calendar" />
      </SectionCard>
      {data?.walk_ins?.length > 0 && (
        <SectionCard flush icon="users" title="Walk-in visits">
          <DataGrid id="clinic-today-walk-ins" caption="Walk-in visits" variant="compact" rows={data.walk_ins} rowKey={(w) => w.visit_id} onRowClick={(w) => navigate(biz.path(`visits/${w.visit_id}`))} columns={[
            { key: "time", header: "Came in", value: (w) => w.created_at, render: (w) => timeOnly(w.created_at), mobile: "subtitle" },
            { key: "patient", header: "Patient", value: (w) => w.patient_name, mobile: "title" },
            { key: "doctor", header: "Doctor", value: (w) => w.doctor_name || "" },
            { key: "status", header: "Visit", value: (w) => w.visit_status, render: (w) => (w.visit_status === "completed" ? <StatusBadge status="completed" label="Seen" /> : <StatusBadge tone="info" label="In consultation" />) },
          ]} />
        </SectionCard>
      )}
      {choosing && (
        <FamilyChoice row={choosing.row} patients={choosing.patients} onClose={() => setChoosing(null)}
          onGive={async (patient) => {
            const row = choosing.row;
            if (await giveToken(row, Number(patient.contact_id) === Number(row.contact_id) ? undefined : patient.contact_id)) setChoosing(null);
          }}
          onRegister={() => { const row = choosing.row; setChoosing(null); setRegistering(row); }} />
      )}
      {registering && <RegisterDialog prefill={prefillOf(registering)} onClose={() => setRegistering(null)}
        onSaved={async (patient) => {
          const row = registering;
          setRegistering(null);
          // Booked online and come today: the patient just registered takes the appointment with their token at once.
          if (row.source === "guests_site" && isToday && patient?.contact_id) await giveToken(row, Number(patient.contact_id) === Number(row.contact_id) ? undefined : patient.contact_id);
          else reload();
        }} />}
    </div>
  );
}

// Who came for an online booking, among the clinic's patients who share the
// booker's mobile: each as the patients list shows them, beside what the guest
// typed, with the token for them; registering a new patient comes last.
function FamilyChoice({ row, patients, onClose, onGive, onRegister }) {
  const typed = typedOf(row);
  const typedAbout = aboutOf(typed.age, typed.sex);
  const [busy, setBusy] = useState(null);
  const ordered = [...patients].sort((a, b) => (Number(sameName(b.name, typed.name)) - Number(sameName(a.name, typed.name))) || (Number(b.booked) - Number(a.booked)));
  const give = async (patient) => {
    setBusy(patient.contact_id);
    try {
      await onGive(patient);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal title={`Who is ${typed.name}?`} icon="users" width={640} onClose={onClose} dismissible={busy === null}
      description="These patients of the clinic share the mobile this was booked with. Give the token to the patient's own record, or register them if they are new."
      footer={(
        <>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy !== null}>Not now</button>
          <button type="button" className="button button-secondary" onClick={onRegister} disabled={busy !== null}><Icon name="user-plus" size={15} /> Register as a new patient</button>
        </>
      )}>
      <p className="ob-family-typed">
        <span className="muted small">Booked online as</span>
        <strong>{typed.name}</strong>
        {typedAbout && <span>{typedAbout}</span>}
        {row.for_whom === "someone_else" && row.booker_name && <span className="muted small">by {row.booker_name}</span>}
      </p>
      <ul className="ob-family" aria-label="Patients on this mobile">
        {ordered.map((p) => (
          <li key={p.contact_id} className="ob-family-row">
            <span className="ob-family-who">
              <strong>{p.name}</strong>
              <small className="muted">{[p.patient_no, aboutOf(p.age, p.sex)].filter(Boolean).join(" · ")}</small>
              <span className="ob-family-tags">
                {sameName(p.name, typed.name) && <span className="ob-chip">Same name</span>}
                {p.booked && <span className="ob-chip">{row.for_whom === "someone_else" ? "The booker's record" : "On this booking now"}</span>}
                {!p.consent_active && <span className="ob-chip is-warning">No consent to treatment</span>}
              </span>
            </span>
            <button type="button" className="button button-sm" onClick={() => give(p)} disabled={busy !== null || !p.consent_active}>
              {busy === p.contact_id ? "Giving the token…" : `Give ${p.name} the token`}
            </button>
          </li>
        ))}
      </ul>
      {ordered.some((p) => !p.consent_active) && <p className="muted small">A patient with no consent to treatment records it on their page (Patients) before taking a token.</p>}
    </Modal>
  );
}
