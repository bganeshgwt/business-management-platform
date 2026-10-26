import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import LiveIndicator from "../../../../components/LiveIndicator";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import { getErrorMessage } from "../../../../services/api";
import { dateLong, timeOnly } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import "../styles/health.css";

// The day's token queue: the front desk gives each arriving patient a number
// for their doctor (priority for the elderly or unwell), the doctor calls the
// next one and starts the consultation from it, and the token is done when
// the visit is completed. "Display board" is the waiting-room screen.
const TOKEN_WORDS = { waiting: ["warning", "Waiting"], called: ["info", "Called"], in_consultation: ["success", "With the doctor"], done: ["neutral", "Done"],
  skipped: ["neutral", "Skipped"], cancelled: ["neutral", "Cancelled"] };

function useQueue(bizId) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(bizId, "clinic/queue", undefined, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [bizId, version]);
  // The queue moves at the desk and in the cabins: a token given or called
  // anywhere shows within a second (live updates), and the queue also reads
  // itself every minute as a safety net.
  const live = useLiveRefresh({ business: bizId }, ["token", "visit"], reload);
  return { data, error, reload, live };
}

export default function TokenQueuePage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { data, error, reload, live } = useQueue(biz.id);
  const [issuing, setIssuing] = useState(false);
  const [board, setBoard] = useState(false);
  const canAct = biz.can("patients.create") || biz.can("patients.edit_clinical");
  const act = async (token, action) => {
    try {
      const done = await businessWrite(biz.id, `clinic/tokens/${token.id}`, { action });
      if (action === "start" && done.visit_id) { navigate(businessPath(biz.id, `visits/${done.visit_id}`)); return; }
      reload();
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const next = async (doctor) => {
    try {
      const r = await businessWrite(biz.id, "clinic/tokens/next", { resourceId: doctor.resource_id || undefined });
      toast[r.called ? "success" : "info"](r.called ? `Token ${r.called.token_no}: ${r.called.patient_name}` : r.message);
      reload();
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const tokens = data?.tokens || [];
  const count = (s) => tokens.filter((t) => t.status === s).length;
  if (board) return <DisplayBoard data={data} name={biz.business.name} onClose={() => setBoard(false)} />;
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Token queue" description={data ? `${dateLong(data.day)}: give a token on arrival; doctors call the next patient.` : "Today's queue"}
        primary={biz.can("patients.create") && <button type="button" className="button" onClick={() => setIssuing(true)}><Icon name="plus" size={16} /> Give a token</button>}
        actions={<LiveIndicator status={live} />}
        secondary={<button type="button" className="button button-secondary" onClick={() => setBoard(true)}><Icon name="grid" size={16} /> Display board</button>} />
      <ErrorMessage message={error} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="clock" label="Waiting" value={data ? String(count("waiting") + count("called")) : ""} loading={!data} />
        <StatTile icon="users" label="With the doctor" value={data ? String(count("in_consultation")) : ""} loading={!data} />
        <StatTile icon="check" label="Seen" value={data ? String(count("done")) : ""} loading={!data} />
        <StatTile icon="ban" label="Skipped" value={data ? String(count("skipped")) : ""} loading={!data} />
      </div>
      {!data && !error ? <Loading /> : data.doctors.length === 0 ? (
        <SectionCard icon="users" title="No tokens yet today"><p className="muted">Give the first patient a token when they arrive: choose them and their doctor.</p></SectionCard>
      ) : (
        <div className="hl-queue">
          {data.doctors.map((d) => {
            const mine = tokens.filter((t) => String(t.resource_id || 0) === String(d.resource_id || 0));
            const now = d.serving || d.called;
            const open = mine.filter((t) => ["waiting", "called", "skipped"].includes(t.status) && t.id !== now?.id);
            return (
              <section key={d.resource_id || 0} className="hl-queue-card" aria-label={`${d.name}'s queue`}>
                <header className="hl-queue-head"><strong>{d.name}</strong><span className="muted">{d.waiting} waiting · {d.done} seen</span></header>
                <div className="hl-queue-now">
                  <span className="hl-token">{now ? now.token_no : "–"}</span>
                  <span className="grow bz-two-line">{now ? <><strong>{now.patient_name}</strong><small className="muted">{TOKEN_WORDS[now.status][1]}{now.priority ? " · priority" : ""}</small></> : <span className="muted">No one called yet</span>}</span>
                  {now && canAct && now.status === "called" && <button type="button" className="chip-button" onClick={() => act(now, "start")}>Start</button>}
                  {now?.visit_id && <button type="button" className="chip-button" onClick={() => navigate(businessPath(biz.id, `visits/${now.visit_id}`))}>Open visit</button>}
                </div>
                <ul className="hl-queue-list">
                  {open.length === 0 && <li className="muted">No one else waiting</li>}
                  {open.map((t) => (
                    <li key={t.id}>
                      <span className="hl-token is-small">{t.token_no}</span>
                      <span className="grow"><span>{t.patient_name}{t.priority && <> <StatusBadge tone="danger" label="Priority" /></>}</span>
                        <small className="muted">{t.patient_no} · since {timeOnly(t.issued_at)}{t.appointment_at ? ` · booked ${timeOnly(t.appointment_at)}` : ""}{t.note ? ` · ${t.note}` : ""}</small></span>
                      {t.status !== "waiting" && <StatusBadge tone={TOKEN_WORDS[t.status][0]} label={TOKEN_WORDS[t.status][1]} />}
                      {canAct && (
                        <span className="bz-inline">
                          <button type="button" className="link-button" onClick={() => act(t, "call")}>{t.status === "skipped" ? "Call back" : "Call"}</button>
                          <button type="button" className="link-button danger" onClick={() => act(t, "cancel")} aria-label={`Cancel token ${t.token_no}`}>Cancel</button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {canAct && (
                  <footer className="hl-queue-foot">
                    <button type="button" className="button" onClick={() => next(d)} disabled={!d.waiting}><Icon name="bell" size={16} /> Next patient</button>
                    {now?.status === "called" && <button type="button" className="button button-secondary" onClick={() => act(now, "skip")}>Not here</button>}
                  </footer>
                )}
              </section>
            );
          })}
        </div>
      )}
      {issuing && <IssueDialog onClose={() => setIssuing(false)} onSaved={(t) => { setIssuing(false); toast.success(`Token ${t.token_no} for ${t.patient_name}${t.doctor_name ? ` (${t.doctor_name})` : ""}`); reload(); }} />}
    </div>
  );
}

function IssueDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["resources?active=true"]);
  const [patient, setPatient] = useState(null);
  const [form, setForm] = useState({ resourceId: "", priority: false, note: "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title="Give a token" icon="users" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Give token"
      description="Patients with an appointment today can be checked in from Today's patients."
      onSubmit={() => businessWrite(biz.id, "clinic/tokens", { contactId: patient?.contact_id, resourceId: form.resourceId || undefined, priority: form.priority, note: form.note || undefined })}>
      <div className="field-wide">
        <SearchPicker label="Patient" minChars={1} onChange={setPatient} autoFocus value={patient}
          search={(q, { signal }) => businessRead(biz.id, "clinic/patients", { q, limit: 20 }, signal).then((r) => r.items)}
          getKey={(p) => p.contact_id} getLabel={(p) => p.name} getDescription={(p) => `${p.patient_no} · ${p.phone || "no phone"}${p.consent_active ? "" : " · consent withdrawn"}`}
          isDisabled={(p) => !p.consent_active} emptyText="No registered patient by that name, ID or phone. Register them under Patients first." />
      </div>
      <Field label="Doctor"><select value={form.resourceId} onChange={set("resourceId")}><option value="">Any doctor (clinic queue)</option>
        {(options?.["resources?active=true"] || []).filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
      <Field label="Note"><input maxLength={200} value={form.note} placeholder="e.g. Fever, review report" onChange={set("note")} /></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.priority} onChange={set("priority")} /> Priority (elderly, pregnant, very unwell): called before the others</label>
    </FormDialog>
  );
}

// The waiting-room screen: each doctor's current token, large, and who is next.
function DisplayBoard({ data, name, onClose }) {
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
