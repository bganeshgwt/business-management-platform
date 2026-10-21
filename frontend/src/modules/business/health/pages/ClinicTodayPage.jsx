import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import { getErrorMessage } from "../../../../services/api";
import { dateLong, timeOnly } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import { BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { ReportReady } from "./healthParts";
import { RegisterDialog } from "./PatientsPage";
import "../styles/health.css";

// Today's patients: the day's appointments by time with their visit (not
// started, in consultation, done), whether they are registered with consent,
// billed, and whether their lab report is ready. The front desk registers and
// starts the visit; the doctor opens it to write the consultation.
export default function ClinicTodayPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [day, setDay] = useState(businessToday(biz.business.timezone));
  const [doctor, setDoctor] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [registering, setRegistering] = useState(null);
  const { options } = useOptions(["resources"]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "clinic/today", { day, ...(doctor ? { doctor } : {}) }, controller.signal)
      .then((d) => { setData(d); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, day, doctor, version]);
  const canStart = biz.can("patients.edit_clinical") || biz.can("patients.create");

  async function giveToken(row) {
    try {
      const token = await businessWrite(biz.id, "clinic/tokens", { appointmentId: row.appointment_id });
      toast.success(`Token ${token.token_no} for ${token.patient_name}`);
      setVersion((n) => n + 1);
    } catch (err) { toast.error(getErrorMessage(err)); }
  }
  async function start(row) {
    try {
      const visit = await businessWrite(biz.id, "clinic/visits", { appointmentId: row.appointment_id });
      navigate(businessPath(biz.id, `visits/${visit.id}`));
    } catch (err) { toast.error(getErrorMessage(err)); }
  }
  const rows = data?.appointments || [];
  const columns = [
    { key: "time", header: "Time", value: (r) => r.starts_at, render: (r) => timeOnly(r.starts_at), mobile: "subtitle", width: 90 },
    { key: "patient", header: "Patient", value: (r) => r.patient_name, mobile: "title", render: (r) => <span className="bz-two-line"><strong>{r.patient_name}</strong><small className="muted">{r.patient_no || "Not registered"}{r.patient_phone ? ` · ${r.patient_phone}` : ""}</small></span> },
    { key: "doctor", header: "Doctor", value: (r) => r.doctor_name },
    { key: "token", header: "Token", type: "number", value: (r) => r.token_no, width: 80, render: (r) => (r.token_no ? <strong className="mono">{r.token_no}</strong> : <span className="muted">—</span>) },
    { key: "service", header: "For", value: (r) => r.service_name, defaultHidden: true },
    { key: "visit", header: "Visit", value: (r) => r.visit_status || r.appointment_status, mobile: "show", render: (r) => (
      r.appointment_status === "cancelled" ? <StatusBadge tone="neutral" label="Cancelled" /> : r.appointment_status === "no_show" ? <StatusBadge status="no_show" />
        : r.visit_status === "completed" ? <StatusBadge status="completed" label="Seen" /> : r.visit_status === "open" ? <StatusBadge tone="info" label="In consultation" /> : <StatusBadge tone="warning" label="Waiting" />) },
    { key: "bill", header: "Billed", value: (r) => (r.document_id ? "Yes" : "No"), render: (r) => (r.document_id ? <StatusBadge status="paid" label="Billed" /> : <span className="muted">—</span>) },
    { key: "lab", header: "Lab", value: (r) => r.lab_status || "none", render: (r) => <ReportReady status={r.lab_status} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", width: 230, render: (r) => {
      if (["cancelled", "no_show"].includes(r.appointment_status)) return null;
      if (!r.registered) return biz.can("patients.create") && <button type="button" className="chip-button" onClick={() => setRegistering(r)}>Register</button>;
      if (r.visit_id) return <button type="button" className="chip-button" onClick={() => navigate(businessPath(biz.id, `visits/${r.visit_id}`))}>Open visit</button>;
      if (!r.consent_active) return <small className="muted">No consent</small>;
      return (
        <span className="bz-inline">
          {!r.token_no && day === businessToday(biz.business.timezone) && biz.can("patients.create") && <button type="button" className="chip-button" onClick={() => giveToken(r)}>Arrived: token</button>}
          {canStart && <button type="button" className="chip-button" onClick={() => start(r)}>Start visit</button>}
        </span>
      );
    } },
  ];
  const waiting = rows.filter((r) => r.appointment_status === "booked" && !r.visit_id).length;
  const seen = rows.filter((r) => r.visit_status === "completed").length;
  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Today's patients" description={`${dateLong(day)}: appointments by time, their visit, bill and lab report.`} />
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
          <DataGrid id="clinic-today-walk-ins" caption="Walk-in visits" variant="compact" rows={data.walk_ins} rowKey={(w) => w.visit_id} onRowClick={(w) => navigate(businessPath(biz.id, `visits/${w.visit_id}`))} columns={[
            { key: "time", header: "Came in", value: (w) => w.created_at, render: (w) => timeOnly(w.created_at), mobile: "subtitle" },
            { key: "patient", header: "Patient", value: (w) => w.patient_name, mobile: "title" },
            { key: "doctor", header: "Doctor", value: (w) => w.doctor_name || "" },
            { key: "status", header: "Visit", value: (w) => w.visit_status, render: (w) => (w.visit_status === "completed" ? <StatusBadge status="completed" label="Seen" /> : <StatusBadge tone="info" label="In consultation" />) },
          ]} />
        </SectionCard>
      )}
      {registering && <RegisterDialog prefill={{ contactId: registering.contact_id, name: registering.patient_name }} onClose={() => setRegistering(null)} onSaved={() => { setRegistering(null); setVersion((n) => n + 1); }} />}
    </div>
  );
}
