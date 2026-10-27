import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import LiveIndicator from "../../../../components/LiveIndicator";
import useServerNow from "../../../../hooks/useServerNow";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { dateLong, durationMinutes, timeOnly } from "@bmp/shared/format";
import { minutesSince } from "@bmp/shared/dates";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { TOKEN_WORDS, useQueue, useTokenActions } from "./tokenQueue";
import "../styles/health.css";

// How long someone has waited, on the server's clock (`now`): "just now", "12 min", "1 h 5 min".
const waited = (since, now) => { const minutes = minutesSince(since, now); return minutes < 1 ? "just now" : durationMinutes(minutes, { long: true }); };

// The day's token queue: the front desk gives each arriving patient a number
// for their doctor (priority for the elderly or unwell), the doctor calls the
// next one and starts the consultation from it, and the token is done when
// the visit is completed. "Display board" is the waiting-room screen. Its
// parts (the day's figures, a doctor's card, giving a token, the board, and
// the queue with what the desk and the doctors do with it in tokenQueue.js)
// also make up the clinic workspace's desk (workspaces/clinic).
export default function TokenQueuePage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { data, error, reload, live, offset } = useQueue(biz.id);
  const now = useServerNow(offset, 30000);
  const [issuing, setIssuing] = useState(false);
  const [board, setBoard] = useState(false);
  const canAct = biz.can("patients.create") || biz.can("patients.edit_clinical");
  const openVisit = (visitId) => navigate(biz.path(`visits/${visitId}`));
  const { act, next } = useTokenActions(reload, openVisit);
  const tokens = data?.tokens || [];
  if (board) return <DisplayBoard data={data} name={biz.business.name} onClose={() => setBoard(false)} />;
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Token queue" description={data ? `${dateLong(data.day)}: give a token on arrival; doctors call the next patient.` : "Today's queue"}
        primary={biz.can("patients.create") && <button type="button" className="button" onClick={() => setIssuing(true)}><Icon name="plus" size={16} /> Give a token</button>}
        actions={<LiveIndicator status={live} />}
        secondary={<button type="button" className="button button-secondary" onClick={() => setBoard(true)}><Icon name="grid" size={16} /> Display board</button>} />
      <ErrorMessage message={error} />
      <QueueTiles tokens={tokens} loading={!data} />
      {!data ? (!error && <Loading />) : data.doctors.length === 0 ? (
        <SectionCard icon="users" title="No tokens yet today"><p className="muted">Give the first patient a token when they arrive: choose them and their doctor.</p></SectionCard>
      ) : (
        <div className="hl-queue">
          {data.doctors.map((d) => <QueueCard key={d.resource_id || 0} doctor={d} tokens={tokens} now={now} canAct={canAct} onAct={act} onNext={next} onOpenVisit={openVisit} />)}
        </div>
      )}
      {issuing && <IssueDialog onClose={() => setIssuing(false)} onSaved={(t) => { setIssuing(false); toast.success(`Token ${t.token_no} for ${t.patient_name}${t.doctor_name ? ` (${t.doctor_name})` : ""}`); reload(); }} />}
    </div>
  );
}

// The day's figures: waiting (and called), with the doctor, seen, skipped.
export function QueueTiles({ tokens, loading }) {
  const count = (s) => tokens.filter((t) => t.status === s).length;
  return (
    <div className="stat-grid bz-stat-grid">
      <StatTile icon="clock" label="Waiting" value={loading ? "" : String(count("waiting") + count("called"))} loading={loading} />
      <StatTile icon="users" label="With the doctor" value={loading ? "" : String(count("in_consultation"))} loading={loading} />
      <StatTile icon="check" label="Seen" value={loading ? "" : String(count("done"))} loading={loading} />
      <StatTile icon="ban" label="Skipped" value={loading ? "" : String(count("skipped"))} loading={loading} />
    </div>
  );
}

// One doctor's queue: who is being seen or was called, then everyone waiting
// with how long they have waited (on the server's clock, `now`), and the
// doctor's buttons. `mine`: the signed-in doctor's own queue.
export function QueueCard({ doctor: d, tokens, now, canAct, onAct, onNext, onOpenVisit, mine = false }) {
  const list = tokens.filter((t) => String(t.resource_id || 0) === String(d.resource_id || 0));
  const current = d.serving || d.called;
  const open = list.filter((t) => ["waiting", "called", "skipped"].includes(t.status) && t.id !== current?.id);
  const longest = list.filter((t) => t.status === "waiting").sort((a, b) => String(a.issued_at).localeCompare(String(b.issued_at)))[0];
  return (
    <section className={`hl-queue-card${mine ? " is-mine" : ""}`} aria-label={`${d.name}'s queue`}>
      <header className="hl-queue-head">
        <strong>{mine ? `Your queue · ${d.name}` : d.name}</strong>
        <span className="muted">{d.waiting} waiting · {d.done} seen{longest ? ` · longest ${waited(longest.issued_at, now)}` : ""}</span>
      </header>
      <div className="hl-queue-now">
        <span className="hl-token">{current ? current.token_no : "–"}</span>
        <span className="grow bz-two-line">{current ? <><strong>{current.patient_name}</strong><small className="muted">{TOKEN_WORDS[current.status][1]}{current.priority ? " · priority" : ""}
          {current.status === "in_consultation" && current.started_at ? ` · ${waited(current.started_at, now)}` : ""}</small></> : <span className="muted">No one called yet</span>}</span>
        {current && canAct && current.status === "called" && <button type="button" className="chip-button" onClick={() => onAct(current, "start")}>Start</button>}
        {current?.visit_id && <button type="button" className="chip-button" onClick={() => onOpenVisit(current.visit_id)}>Open visit</button>}
      </div>
      <ul className="hl-queue-list">
        {open.length === 0 && <li className="muted">No one else waiting</li>}
        {open.map((t) => (
          <li key={t.id}>
            <span className="hl-token is-small">{t.token_no}</span>
            <span className="grow"><span>{t.patient_name}{t.priority && <> <StatusBadge tone="danger" label="Priority" /></>}</span>
              <small className="muted">{t.patient_no} · since {timeOnly(t.issued_at)}{t.status === "waiting" ? ` · waiting ${waited(t.issued_at, now)}` : ""}
                {t.appointment_at ? ` · booked ${timeOnly(t.appointment_at)}` : ""}{t.note ? ` · ${t.note}` : ""}</small></span>
            {t.status !== "waiting" && <StatusBadge tone={TOKEN_WORDS[t.status][0]} label={TOKEN_WORDS[t.status][1]} />}
            {canAct && (
              <span className="bz-inline">
                <button type="button" className="link-button" onClick={() => onAct(t, "call")}>{t.status === "skipped" ? "Call back" : "Call"}</button>
                <button type="button" className="link-button danger" onClick={() => onAct(t, "cancel")} aria-label={`Cancel token ${t.token_no}`}>Cancel</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canAct && (
        <footer className="hl-queue-foot">
          <button type="button" className="button" onClick={() => onNext(d)} disabled={!d.waiting}><Icon name="bell" size={16} /> Next patient</button>
          {current?.status === "called" && <button type="button" className="button button-secondary" onClick={() => onAct(current, "skip")}>Not here</button>}
        </footer>
      )}
    </section>
  );
}

// Gives a token: the patient (or the one chosen already, `patient`), their
// doctor (or `resourceId`) or the clinic's queue, priority and a note.
export function IssueDialog({ onClose, onSaved, patient: chosen = null, resourceId = "" }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["resources?active=true"]);
  const [patient, setPatient] = useState(chosen);
  const [form, setForm] = useState({ resourceId: resourceId ? String(resourceId) : "", priority: false, note: "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title="Give a token" icon="users" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Give token"
      description="Patients with an appointment today can be checked in from Today's patients."
      onSubmit={() => businessWrite(biz.id, "clinic/tokens", { contactId: patient?.contact_id, resourceId: form.resourceId || undefined, priority: form.priority, note: form.note || undefined })}>
      <div className="field-wide">
        <SearchPicker label="Patient" minChars={1} onChange={setPatient} autoFocus={!chosen} value={patient}
          search={(q, { signal }) => businessRead(biz.id, "clinic/patients", { q, limit: 20 }, signal).then((r) => r.items)}
          getKey={(p) => p.contact_id} getLabel={(p) => p.name} getDescription={(p) => `${p.patient_no} · ${p.phone || "no phone"}${p.consent_active ? "" : " · consent withdrawn"}`}
          isDisabled={(p) => !p.consent_active} emptyText="No registered patient by that name, ID or phone. Register them under Patients first." />
      </div>
      <Field label="Doctor"><select value={form.resourceId} onChange={set("resourceId")} autoFocus={Boolean(chosen)}><option value="">Any doctor (clinic queue)</option>
        {(options?.["resources?active=true"] || []).filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
      <Field label="Note"><input maxLength={200} value={form.note} placeholder="e.g. Fever, review report" onChange={set("note")} /></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.priority} onChange={set("priority")} /> Priority (elderly, pregnant, very unwell): called before the others</label>
    </FormDialog>
  );
}

// The waiting-room screen: each doctor's current token, large, and who is next.
export function DisplayBoard({ data, name, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 30000); return () => clearInterval(t); }, []);
  return (
    <div className="hl-board" role="dialog" aria-label="Token display board">
      <div className="hl-board-head"><strong>{name}</strong>
        <span className="bz-inline"><span>{clock.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</span>
          <button type="button" className="button button-secondary" onClick={onClose}>Close (Esc)</button></span></div>
      <div className="hl-board-grid">
        {(data?.doctors || []).map((d) => {
          const now = d.serving || d.called;
          return (
            <div key={d.resource_id || 0} className="hl-board-card">
              <h2>{d.name}</h2>
              <div className="hl-board-now" aria-live="polite">{now ? now.token_no : "–"}</div>
              <div className="hl-board-next">{d.next.length ? `Next: ${d.next.map((n) => n.token_no).join(", ")}` : "No one waiting"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
