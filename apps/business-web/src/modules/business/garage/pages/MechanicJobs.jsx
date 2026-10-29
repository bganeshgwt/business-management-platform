import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { duration } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { Badge } from "../../core/pages/ui";
import { quantity } from "../../core/pages/hooks";
import { AddPhoto, GaragePhoto } from "./GaragePhoto";
import { RoadTestDialog } from "./JobCardMore";
import { STATUSES, STEP_WORDS, atWords, km, lineWords } from "./garage";
import "../styles/garage.css";

// A mechanic's own screen, phone first: the job cards assigned to them, and
// on each its complaints, the parts issued for it, the labour lines to tick
// done, the next step of the work, the road test, and a note or a photo. It
// is the mechanic's view of Business Admin's Job cards (the same address and
// guard): their role sees only their own job cards and no money.

export function MechanicBoard({ biz, board, onOpen }) {
  const items = board?.items || [];
  return (
    <div className="gar-phone" data-motion-skip>
      {!items.length && <p className="gar-empty">No job card is assigned to you now.</p>}
      <ul className="gar-phone-list">
        {items.map((j) => (
          <li key={j.id}>
            <button type="button" className={`gar-phone-card ${j.overdue ? "is-late" : ""}`} onClick={() => onOpen(j)}>
              <span className="gar-phone-top"><span className="gar-plate">{j.registration_no}</span><Badge tone={STATUSES[j.status]?.tone} label={STATUSES[j.status]?.label || j.status} /></span>
              <span>{j.vehicle_name} · {j.job_no}</span>
              <span className="muted small">{(j.complaints || []).join(" · ")}</span>
              <span className="gar-card-meta">
                {j.promised_at && <span className={j.overdue ? "is-late" : ""}><Icon name="clock" size={12} /> {atWords(j.promised_at)}{j.overdue ? " · late" : ""}</span>}
                {j.work.lines > 0 && <span>{j.work.done} of {j.work.lines} done</span>}
                {j.bay && <span>{j.bay}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">{biz.business.name}: only the job cards you are on are shown.</p>
    </div>
  );
}

export function MechanicJobCard({ biz, job, onChanged }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const open = !["delivered", "cancelled"].includes(job.status);
  const status = STATUSES[job.status] || { label: job.status };
  const labour = job.lines.filter((l) => l.kind !== "part");
  const parts = job.lines.filter((l) => l.kind === "part");
  const heldOf = (lineId) => (job.parts_held || []).find((p) => Number(p.line_id) === Number(lineId));
  const act = async (fn, message) => {
    setBusy(true);
    try { await fn(); onChanged(message); } catch (err) { toast.error(getErrorMessage(err)); } finally { setBusy(false); }
  };
  const tick = (line) => act(() => businessWrite(biz.id, `garage/job-cards/${job.id}/work`, { lines: [{ lineId: line.id, done: !line.done }] }), line.done ? `${line.label}: not done.` : `${line.label}: done.`);
  const step = (to) => act(() => businessWrite(biz.id, `garage/job-cards/${job.id}/status`, { status: to, note: note.trim() || undefined }), `${STATUSES[to].label}.`)
    .then(() => setNote(""));
  const saveNote = () => act(() => businessWrite(biz.id, `garage/job-cards/${job.id}/notes`, { note }), "Note added.").then(() => setNote(""));
  const roadTestFirst = job.garage?.road_test_required && !job.garage.road_tested;
  return (
    <div className="gar-phone stack" data-motion-skip>
      <Link className="link-button" to={biz.path("job-cards")}><Icon name="arrow-left" size={14} /> My job cards</Link>
      <header className="gar-phone-head">
        <span className="gar-phone-top"><span className="gar-plate">{job.registration_no}</span><Badge tone={status.tone} label={status.label} /></span>
        <h1>{job.vehicle_name}</h1>
        <p className="muted small">{job.job_no}{job.bay ? ` · ${job.bay}` : ""}{job.odometer_in !== null ? ` · in at ${km(job.odometer_in)}` : ""}{open && job.status_since ? ` · ${status.label.toLowerCase()} for ${duration(job.status_since)}` : ""}</p>
        {job.promised_at && <p className={job.overdue ? "gar-note" : "small"}>Promised for {atWords(job.promised_at)}{job.overdue ? " · late" : ""}</p>}
      </header>
      <section className="gar-phone-section" aria-label="What the customer says">
        <h2>What the customer says</h2>
        <ol className="gar-list">{job.complaints.map((x, i) => <li key={i}>{x}</li>)}</ol>
        {job.inspection_notes && <p className="small">Inspection: {job.inspection_notes}</p>}
      </section>
      <section className="gar-phone-section" aria-label="Labour">
        <h2>The work</h2>
        {labour.length ? (
          <ul className="gar-phone-ticks">
            {labour.map((l) => (
              <li key={l.id}>
                <label className="gar-phone-tick">
                  <input type="checkbox" checked={Boolean(l.done)} disabled={!open || busy} onChange={() => tick(l)} />
                  <span>{lineWords(l)}{l.done && l.done_by_name ? <small className="muted"> · {l.done_by_name}</small> : null}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : <p className="muted small">No labour on the estimate yet.</p>}
      </section>
      <section className="gar-phone-section" aria-label="Parts">
        <h2>Parts</h2>
        {parts.length ? (
          <ul className="gar-phone-ticks">
            {parts.map((l) => {
              const held = heldOf(l.id);
              return (
                <li key={l.id}>
                  <label className="gar-phone-tick">
                    <input type="checkbox" checked={Boolean(l.done)} disabled={!open || busy} onChange={() => tick(l)} aria-label={`${l.label} fitted`} />
                    <span>{l.label} × {quantity(l.quantity, l.unit)}
                      {held && Number(held.issued) > 0 ? <small className="muted"> · issued {quantity(held.issued, l.unit)}{Number(held.returned) > 0 ? `, back ${quantity(held.returned, l.unit)}` : ""}</small>
                        : job.garage?.issue_parts ? <small className="muted"> · not issued yet</small> : null}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : <p className="muted small">No parts on the estimate yet.</p>}
      </section>
      {open && (
        <section className="gar-phone-section" aria-label="Note or photo">
          <h2>A note or a photo</h2>
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Rear drums worn: tell the owner" aria-label="Note" />
          <div className="gar-phone-actions">
            <button type="button" className="button button-secondary" disabled={busy || !note.trim()} onClick={saveNote}>Save the note</button>
            <AddPhoto biz={biz} jobId={job.id} caption={note} label="Add a photo" onAdded={() => { setNote(""); onChanged(); }} />
          </div>
          {(job.photos || []).length > 0 && <div className="gar-photos">{job.photos.map((p) => <GaragePhoto key={p.id} biz={biz} photo={p} />)}</div>}
        </section>
      )}
      {open && (
        <section className="gar-phone-section" aria-label="Next step">
          <h2>Next step</h2>
          {roadTestFirst && <p className="small">A passed road test comes before ready.</p>}
          <div className="gar-phone-actions">
            {(job.next || []).map((to) => (
              <button key={to} type="button" className="button" disabled={busy || (job.status === "ready" && !note.trim())} onClick={() => step(to)}>
                {job.status === "ready" ? `Back to ${to === "in_progress" ? "work" : "waiting for parts"}` : STEP_WORDS[to]}
              </button>
            ))}
            {job.status !== "estimate_sent" && <button type="button" className="button button-secondary" onClick={() => setTesting(true)}>Road test</button>}
          </div>
          {job.status === "ready" && <p className="muted small">To send it back to work, write why in the note first.</p>}
          {job.status === "estimate_sent" && <p className="muted small">The estimate is with the owner: the desk records their approval.</p>}
        </section>
      )}
      {testing && <RoadTestDialog biz={biz} job={job} onClose={() => setTesting(false)} onSaved={() => { setTesting(false); onChanged("Road test recorded."); }} />}
    </div>
  );
}
