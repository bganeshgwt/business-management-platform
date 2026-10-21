import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import ContentTabs from "../../../../components/ContentTabs";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import "../styles/health.css";

// Doctors: each doctor's consultation fee and follow-up rule (free or reduced
// within N days), OPD timings by weekday (mornings and evenings), the length
// of an appointment slot, leave, and their share of the fees. Earnings: each
// doctor's patients and fees in a period.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TABS = [["doctors", "Doctors & OPD"], ["earnings", "Earnings"]];

function opdText(sessions) {
  const byTime = new Map();
  for (const s of sessions || []) {
    const key = `${s.starts}–${s.ends}`;
    if (!byTime.has(key)) byTime.set(key, []);
    byTime.get(key).push(s.dow);
  }
  return [...byTime.entries()].map(([time, days]) => `${days.sort().map((d) => DAYS[d]).join(", ")} ${time}`);
}

export default function DoctorsPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([v]) => v === params.get("tab")) ? params.get("tab") : "doctors";
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Doctors" description="Fees and follow-ups, OPD timings, leave, and what each doctor earns." />
      <ContentTabs label="Doctors" value={tab} options={TABS.filter(([v]) => v !== "earnings" || biz.can("reports.view")).map(([value, label]) => ({ value, label }))}
        onChange={(key) => setParams((p) => { const next = new URLSearchParams(p); next.set("tab", key); return next; }, { replace: true })}>
        {tab === "earnings" ? <Earnings /> : <DoctorList />}
      </ContentTabs>
    </div>
  );
}

function DoctorList() {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "clinic/doctors", undefined, controller.signal).then((r) => { setRows(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const done = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const cancelLeave = async (leave) => {
    try { await businessWrite(biz.id, `clinic/leave/${leave.id}/cancel`, {}); done("Leave cancelled"); } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const canFees = biz.can("settings.edit");
  const canLeave = biz.can("appointments.edit");
  const doctors = (rows || []).filter((d) => d.active);
  const columns = useMemo(() => [
    { key: "name", header: "Doctor", value: (d) => d.name, mobile: "title", render: (d) => (
      <span className="bz-two-line"><strong>{d.signed_name || d.name}</strong>
        <small className="muted">{[d.speciality || d.qualification, d.registration_no && `Reg. ${d.registration_no}`, d.location_name].filter(Boolean).join(" · ") || (d.is_doctor ? "" : "Room / other")}</small></span>) },
    { key: "fee", header: "Consultation", value: (d) => Number(d.consultation_price || 0), mobile: "subtitle", render: (d) => (d.consultation_label
      ? <span className="bz-two-line"><span>{biz.amount(d.consultation_price)}</span><small className="muted">{d.consultation_label}</small></span> : <span className="muted">Not set</span>) },
    { key: "follow", header: "Follow-up", value: (d) => d.follow_up_days, render: (d) => (!d.consultation_label || !Number(d.follow_up_days) ? <span className="muted">Full fee</span>
      : <span className="bz-two-line"><span>{d.follow_up_label ? biz.amount(d.follow_up_price) : "Free"}</span><small className="muted">within {d.follow_up_days} days</small></span>) },
    { key: "opd", header: "OPD timings", value: (d) => opdText(d.sessions).join("; "), mobile: "show", render: (d) => (d.sessions.length
      ? <span className="hl-opd">{opdText(d.sessions).map((t) => <span key={t}>{t}</span>)}</span> : <span className="muted">Any time</span>) },
    { key: "slot", header: "Slot", type: "number", value: (d) => d.slot_minutes, render: (d) => `${d.slot_minutes} min`, defaultHidden: true },
    { key: "share", header: "Doctor's share", type: "number", value: (d) => Number(d.share_percent), render: (d) => (Number(d.share_percent) ? `${Number(d.share_percent)}%` : "—"), defaultHidden: true },
    { key: "leave", header: "Leave", value: (d) => d.leave.length, render: (d) => (d.leave.length ? (
      <span className="bz-two-line">{d.leave.map((l) => (
        <span key={l.id} className="bz-inline"><StatusBadge tone="warning" label={l.from_date === l.to_date ? dateShort(l.from_date) : `${dateShort(l.from_date)} – ${dateShort(l.to_date)}`} />
          {canLeave && <button type="button" className="link-button" onClick={() => cancelLeave(l)}>Cancel</button>}</span>))}</span>) : <span className="muted">—</span>) },
    { key: "actions", header: "", label: "Actions", type: "actions", width: 190, render: (d) => (
      <span className="bz-inline">
        {canFees && <button type="button" className="chip-button" onClick={() => setDialog({ edit: d })}>Fees & OPD</button>}
        {canLeave && <button type="button" className="link-button" onClick={() => setDialog({ leave: d })}>Add leave</button>}
      </span>) },
  ], [biz, canFees, canLeave]); // eslint-disable-line react-hooks/exhaustive-deps
  const withFee = doctors.filter((d) => d.consultation_label).length;
  return (
    <div className="stack">
      <ErrorMessage message={error} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="users" label="Doctors" value={rows ? String(doctors.filter((d) => d.is_doctor).length) : ""} loading={!rows} />
        <StatTile icon="money" label="With a fee set" value={rows ? String(withFee) : ""} loading={!rows} />
        <StatTile icon="calendar" label="With OPD timings" value={rows ? String(doctors.filter((d) => d.sessions.length).length) : ""} loading={!rows} />
        <StatTile icon="clock" label="On leave ahead" value={rows ? String(doctors.filter((d) => d.leave.length).length) : ""} loading={!rows} />
      </div>
      <SectionCard flush icon="users" title="Doctors and rooms" description="Add doctors and rooms in Settings › Doctors & rooms; link a doctor's registration in Clinic & lab settings.">
        <DataGrid id="clinic-doctors" caption="Doctors" rows={doctors} rowKey={(d) => d.id} columns={columns} loading={!rows && !error} rowNoun={["doctor", "doctors"]}
          empty="No doctors yet" emptyIcon="users" />
      </SectionCard>
      {dialog?.edit && <DoctorDialog doctor={dialog.edit} onClose={() => setDialog(null)} onSaved={(d) => done(`${d.name}: fees and OPD saved`)} />}
      {dialog?.leave && <LeaveDialog doctor={dialog.leave} onClose={() => setDialog(null)}
        onSaved={(l) => done(l.booked ? `Leave added. ${l.booked} patient${l.booked === 1 ? " is" : "s are"} booked then: call to move them.` : "Leave added")} />}
    </div>
  );
}

function DoctorDialog({ doctor, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["catalog?kind=service&active=true"]);
  const services = options?.["catalog?kind=service&active=true"] || [];
  const [form, setForm] = useState({ speciality: doctor.speciality || "", consultationSkuId: doctor.consultation_sku_id || "", followUpSkuId: doctor.follow_up_sku_id || "",
    followUpDays: doctor.follow_up_days ?? 0, slotMinutes: doctor.slot_minutes ?? 10, sharePercent: Number(doctor.share_percent || 0) });
  const [sessions, setSessions] = useState(doctor.sessions.map((s) => ({ dow: String(s.dow), starts: s.starts, ends: s.ends, maxPatients: s.max_patients ?? "" })));
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setSession = (i, k) => (e) => setSessions((list) => list.map((s, n) => (n === i ? { ...s, [k]: e.target.value } : s)));
  const addSession = (template) => setSessions((list) => [...list, template || { dow: "1", starts: "10:00", ends: "13:00", maxPatients: "" }]);
  // Mon–Sat mornings and evenings in one go, the usual OPD.
  const weekdays = () => setSessions([1, 2, 3, 4, 5, 6].flatMap((d) => [{ dow: String(d), starts: "10:00", ends: "13:00", maxPatients: "" }, { dow: String(d), starts: "17:00", ends: "20:00", maxPatients: "" }]));
  return (
    <FormDialog title={`${doctor.signed_name || doctor.name}: fees & OPD`} icon="users" width={760} onClose={onClose} onSaved={onSaved} submitLabel="Save"
      onSubmit={() => businessWrite(biz.id, `clinic/doctors/${doctor.id}`, { ...form, sessions: sessions.map((s) => ({ ...s, dow: Number(s.dow) })) }, "put")}>
      <Field label="Speciality"><input maxLength={80} value={form.speciality} placeholder="e.g. General physician, Paediatrics" onChange={set("speciality")} /></Field>
      <Field label="Consultation fee (service on the bill)"><select value={form.consultationSkuId} onChange={set("consultationSkuId")}>
        <option value="">The booked service</option>{services.map((s) => <option key={s.id} value={s.id}>{s.label} · {biz.amount(s.price)}</option>)}</select></Field>
      <Field label="Follow-up within (days)" hint="0: every visit pays the full fee."><input type="number" min="0" max="90" value={form.followUpDays} onChange={set("followUpDays")} /></Field>
      <Field label="Follow-up fee" hint="None: the follow-up is free."><select value={form.followUpSkuId} onChange={set("followUpSkuId")} disabled={!form.consultationSkuId || !Number(form.followUpDays)}>
        <option value="">Free follow-up</option>{services.map((s) => <option key={s.id} value={s.id}>{s.label} · {biz.amount(s.price)}</option>)}</select></Field>
      <Field label="Appointment slot (minutes)"><input type="number" min="5" max="120" step="5" value={form.slotMinutes} onChange={set("slotMinutes")} /></Field>
      <Field label="Doctor's share of fees (%)" hint="For the Earnings report."><input type="number" min="0" max="100" step="0.5" value={form.sharePercent} onChange={set("sharePercent")} /></Field>
      <div className="field-wide stack-sm">
        <div className="bz-inline"><strong>OPD timings</strong><span className="muted">No timings: bookable at any time.</span></div>
        <div className="hl-sessions">
          {sessions.map((s, i) => (
            <div key={i} className="hl-session-row">
              <Field label="Day"><select value={s.dow} onChange={setSession(i, "dow")}>{DAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}</select></Field>
              <Field label="From"><input type="time" required value={s.starts} onChange={setSession(i, "starts")} /></Field>
              <Field label="To"><input type="time" required value={s.ends} onChange={setSession(i, "ends")} /></Field>
              <Field label="Max patients"><input type="number" min="1" max="500" placeholder="No cap" value={s.maxPatients} onChange={setSession(i, "maxPatients")} /></Field>
              <button type="button" className="icon-button" aria-label={`Remove ${DAYS[s.dow]} ${s.starts}`} onClick={() => setSessions((list) => list.filter((_, n) => n !== i))}><Icon name="trash" size={16} /></button>
            </div>
          ))}
        </div>
        <div className="bz-inline">
          <button type="button" className="chip-button" onClick={() => addSession(sessions.length ? { ...sessions[sessions.length - 1], dow: String((Number(sessions[sessions.length - 1].dow) + 1) % 7) } : null)}>Add a session</button>
          {sessions.length === 0 && <button type="button" className="link-button" onClick={weekdays}>Mon–Sat, 10–1 and 5–8</button>}
        </div>
      </div>
    </FormDialog>
  );
}

function LeaveDialog({ doctor, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ fromDate: today, toDate: today, reason: "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <FormDialog title={`Leave: ${doctor.signed_name || doctor.name}`} icon="calendar" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Add leave"
      description="No appointments or tokens are given on these days. Patients already booked are counted for you to call."
      onSubmit={() => businessWrite(biz.id, `clinic/doctors/${doctor.id}/leave`, form)}>
      <Field label="From"><input type="date" required min={today} value={form.fromDate} onChange={(e) => setForm((f) => ({ ...f, fromDate: e.target.value, toDate: f.toDate < e.target.value ? e.target.value : f.toDate }))} /></Field>
      <Field label="To"><input type="date" required min={form.fromDate} value={form.toDate} onChange={set("toDate")} /></Field>
      <Field label="Reason" wide><input maxLength={200} value={form.reason} placeholder="e.g. Conference, personal" onChange={set("reason")} /></Field>
    </FormDialog>
  );
}

function Earnings() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "clinic/doctor-earnings", range, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range]);
  const columns = [
    { key: "name", header: "Doctor", value: (r) => r.name, mobile: "title" },
    { key: "visits", header: "Patients", type: "number", value: (r) => r.visits, mobile: "subtitle" },
    { key: "first", header: "Consultations", type: "number", value: (r) => r.consultations },
    { key: "follow", header: "Paid follow-ups", type: "number", value: (r) => r.follow_ups },
    { key: "free", header: "Free follow-ups", type: "number", value: (r) => r.free_follow_ups },
    { key: "unbilled", header: "Not billed", type: "number", value: (r) => r.not_billed, render: (r) => (r.not_billed ? <StatusBadge tone="warning" label={String(r.not_billed)} /> : "0") },
    { key: "fees", header: "Fees", type: "money", value: (r) => Number(r.fees), render: (r) => biz.amount(r.fees), mobile: "show" },
    { key: "share", header: "Doctor's share", type: "money", value: (r) => Number(r.share), render: (r) => (Number(r.share_percent) ? `${biz.amount(r.share)} (${Number(r.share_percent)}%)` : "—") },
  ];
  return (
    <div className="stack">
      <ErrorMessage message={error} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="users" label="Patients seen" value={data ? String(data.totals.visits) : ""} loading={!data} />
        <StatTile icon="money" label="Consultation fees" value={data ? biz.amount(data.totals.fees) : ""} loading={!data} />
        <StatTile icon="wallet" label="Doctors' share" value={data ? biz.amount(data.totals.share) : ""} loading={!data} />
      </div>
      <SectionCard flush icon="chart" title="By doctor" description="Fees are the consultation and follow-up lines of each visit's bill (lab tests and medicines are not included).">
        <DataGrid id="clinic-doctor-earnings" caption="Doctor earnings" rows={data?.doctors || []} rowKey={(r) => r.resource_id} columns={columns} loading={!data && !error}
          toolbar={(
            <>
              <label className="field hl-inline-field"><span>From</span><input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} /></label>
              <label className="field hl-inline-field"><span>To</span><input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} /></label>
            </>
          )}
          exportName={biz.can("reports.export") ? `${biz.business.code}-doctor-earnings-${range.from}-${range.to}` : undefined} empty="No visits in this period" emptyIcon="users" />
      </SectionCard>
    </div>
  );
}
