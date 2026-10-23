import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import ActionMenu from "../../../components/ActionMenu";
import SectionCard from "../../../components/SectionCard";
import SuccessCheck from "../../../components/SuccessCheck";
import Modal from "../../../components/Modal";
import { ErrorMessage, ScreenLoading } from "../../../components/Feedback";
import { dateShort, dateTime, timeOnly } from "@bmp/shared/format";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useConfirm from "../../../hooks/useConfirm";
import useTasks from "./useTasks";
import { AuthImage, CategoryTag, Comments, History, PhotoButton, PhotoStrip, PriorityTag, Progress, SignaturePad, StatusPill } from "./parts";
import { TaskFormDialog } from "./forms";
import { rangeText } from "./taskWords";

// One task: the checklist to tick through (phone first: one big row per item,
// yes/no and choices as big buttons, readings with a number pad, the camera
// for photos, a finger for signatures), then Done. A failed answer turns red
// and raises an issue at once. Below: comments, photos and the history trail.
// A reviewer approves or sends it back here.

function Reason({ title, label, confirmLabel, onClose, onSubmit, optional = false }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} dismissible={!busy}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onSubmit(text.trim()); } finally { setBusy(false); }
      }}>
        <label className="field"><span>{label}</span>
          <textarea rows={3} maxLength={500} value={text} required={!optional} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button" disabled={busy}>{busy ? "Saving…" : confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

// Remounted (key) when the saved answer changes, so it always starts from it.
function NumberAnswer({ item, disabled, onSave }) {
  const [value, setValue] = useState(item.value ?? "");
  const out = value !== "" && ((item.minValue !== null && Number(value) < item.minValue) || (item.maxValue !== null && Number(value) > item.maxValue));
  const save = () => {
    const next = value === "" ? null : Number(value);
    if (next === (item.value ?? null)) return;
    onSave(next);
  };
  return (
    <div className={`tk-number ${out || item.failed ? "is-out" : ""}`}>
      <input type="number" inputMode="decimal" step="any" aria-label={item.label} value={value} disabled={disabled} placeholder="Reading"
        onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())} />
      {item.unit && <span className="tk-number-unit">{item.unit}</span>}
      {rangeText(item) && <span className="tk-number-range">OK: {rangeText(item)}</span>}
    </div>
  );
}

function TextAnswer({ item, disabled, onSave }) {
  const [value, setValue] = useState(item.value ?? "");
  return (
    <textarea className="tk-text" rows={2} maxLength={1000} aria-label={item.label} value={value} disabled={disabled} placeholder="Write here"
      onChange={(e) => setValue(e.target.value)} onBlur={() => value !== (item.value ?? "") && onSave(value || null)} />
  );
}

function ChecklistItem({ item, number, files, canWork, onAnswer, onUpload, onRemoveFile, issueLink }) {
  const [signing, setSigning] = useState(false);
  const [noting, setNoting] = useState(false);
  const mine = files.filter((f) => f.itemId === item.id);
  const needsPhoto = item.photoRequired || item.kind === "photo";
  const answer = (value) => onAnswer(item, { value });
  const done = item.kind === "checkbox" ? item.value === true : item.answered;
  return (
    <li className={`tk-item ${done ? "is-answered" : ""} ${item.failed ? "is-failed" : ""} ${item.critical ? "is-critical" : ""}`} id={`item-${item.id}`}>
      <div className="tk-item-head">
        {item.kind === "checkbox" ? (
          <button type="button" className={`tk-tick ${item.value ? "is-on" : ""}`} role="checkbox" aria-checked={Boolean(item.value)} disabled={!canWork}
            onClick={() => answer(!item.value)} aria-label={item.label}>
            {item.value ? <Icon name="check" size={18} /> : <span className="tk-tick-no">{number}</span>}
          </button>
        ) : <span className={`tk-item-no ${done ? "is-done" : ""}`}>{done ? <Icon name="check" size={14} /> : number}</span>}
        <div className="tk-item-text">
          <span className="tk-item-label" onClick={() => item.kind === "checkbox" && canWork && answer(!item.value)}>
            {item.label}{!item.required && <span className="muted small"> (optional)</span>}
          </span>
          {item.help && <span className="muted small">{item.help}</span>}
          {item.critical && <span className="tk-tag tone-danger small">Critical</span>}
        </div>
      </div>
      <div className="tk-item-answer">
        {item.kind === "yes_no" && (
          <div className="tk-yesno" role="group" aria-label={item.label}>
            {["yes", "no"].map((v) => (
              <button key={v} type="button" disabled={!canWork} aria-pressed={item.value === v}
                className={`tk-big ${item.value === v ? (item.failed ? "is-fail" : "is-pass") : ""}`} onClick={() => answer(item.value === v ? null : v)}>
                {v === "yes" ? "Yes" : "No"}
              </button>
            ))}
          </div>
        )}
        {item.kind === "choice" && (
          <div className="tk-choices" role="group" aria-label={item.label}>
            {(item.options || []).map((o) => (
              <button key={o.label} type="button" disabled={!canWork} aria-pressed={item.value === o.label}
                className={`tk-big ${item.value === o.label ? (o.fail ? "is-fail" : "is-pass") : ""}`} onClick={() => answer(item.value === o.label ? null : o.label)}>{o.label}</button>
            ))}
          </div>
        )}
        {item.kind === "number" && <NumberAnswer key={String(item.value)} item={item} disabled={!canWork} onSave={answer} />}
        {item.kind === "text" && <TextAnswer key={String(item.value)} item={item} disabled={!canWork} onSave={answer} />}
        {item.kind === "signature" && (
          mine.length ? <div className="tk-signed"><AuthImage fileId={mine[mine.length - 1].id} alt="Signature" /><span className="muted small">Signed by {mine[mine.length - 1].uploadedByName}</span></div>
            : signing ? <SignaturePad onCancel={() => setSigning(false)} onSave={async (file) => { await onUpload(item, file, "signature"); setSigning(false); }} />
              : canWork && <button type="button" className="button button-secondary" onClick={() => setSigning(true)}><Icon name="edit" size={15} /> Sign</button>
        )}
        {needsPhoto && (
          <div className="tk-item-photos">
            <PhotoStrip files={mine} onRemove={canWork ? onRemoveFile : null} />
            {canWork && <PhotoButton label={mine.length ? "Another photo" : item.kind === "photo" ? "Take photo" : "Add photo (needed)"} className="button button-secondary button-sm" onUpload={(file) => onUpload(item, file, "photo")} />}
          </div>
        )}
        {item.failed && (
          <p className="tk-item-fail" role="status">
            <Icon name="alert" size={14} /> {item.kind === "number" ? `Out of range (OK: ${rangeText(item)})` : "Failed"}
            {item.issueId && <> · {issueLink(item)}</>}
          </p>
        )}
        {(item.note || noting) ? (
          <input className="tk-note" aria-label={`Note on ${item.label}`} defaultValue={item.note || ""} maxLength={500} placeholder="Note" disabled={!canWork} autoFocus={noting && !item.note}
            onBlur={(e) => { setNoting(false); if (e.target.value !== (item.note || "")) onAnswer(item, { value: item.value, note: e.target.value }); }} />
        ) : canWork && item.kind !== "text" && <button type="button" className="tk-link-button" onClick={() => setNoting(true)}>Add note</button>}
        {item.answeredByName && <span className="tk-item-by muted small">{item.answeredByName} · {timeOnly(item.answeredAt)}</span>}
      </div>
    </li>
  );
}

export default function TaskRunPage() {
  const { taskId } = useParams();
  const t = useTasks();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [task, setTask] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [justDone, setJustDone] = useState(false);
  const [tab, setTab] = useState("comments");
  // The answers still being sent (a plain holder, not shown on screen).
  const [line] = useState(() => {
    let last = Promise.resolve();
    return { add: (work) => (last = last.then(work)), idle: () => last };
  });

  const load = useCallback(() => t.api.task(taskId).then((value) => { setTask(value); setError(""); }).catch((err) => setError(getErrorMessage(err))), [t.api, taskId]);
  useEffect(() => { load(); }, [load]);

  // Answers are sent one after another, so a fast thumb never races itself.
  const queue = (work) => {
    return line.add(() => work().catch((err) => { toast.error(getErrorMessage(err)); load(); }));
  };
  const onAnswer = (item, body) => queue(async () => {
    const result = await t.api.answer(task.id, item.id, body);
    setTask(result.task);
    if (result.raisedIssue) {
      toast.error(`Failed check: issue ISS-${String(result.raisedIssue.number).padStart(4, "0")} raised`, {
        action: { label: "Open", onClick: () => navigate(t.link(`issues/${result.raisedIssue.id}`)) },
      });
    }
  });
  const onUpload = (item, file, kind) => queue(async () => {
    const fd = new FormData();
    if (item) fd.append("itemId", String(item.id));
    fd.append("kind", kind);
    fd.append("file", file);
    await t.api.uploadTaskFile(task.id, fd);
    await load();
  });
  const onRemoveFile = async (file) => {
    if (!(await confirm({ title: "Remove this photo?", message: "It is taken off the task. A record that it was removed is kept.", confirmLabel: "Remove" }))) return;
    await queue(async () => { await t.api.removeFile(file.id); await load(); });
  };

  const act = async (work, success) => {
    setBusy(true);
    try {
      await line.idle();
      const value = await work();
      if (value) setTask(value);
      if (success) toast.success(success);
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="stack"><ErrorMessage message={error} /><Link to={t.link()} className="button button-secondary">Back to my tasks</Link></div>;
  if (!task) return <ScreenLoading label="Opening the task…" />;

  const can = task.can;
  const items = task.items;
  const left = items.filter((i) => i.kind !== "section" && i.required && !(i.kind === "checkbox" ? i.value === true : i.answered)).length;
  const numbers = items.reduce((list, item) => [...list, item.kind === "section" ? null : (list.filter((x) => x !== null).length + 1)], []);
  const issueLink = (item) => <Link to={t.link(`issues/${item.issueId}`)}>Issue ISS-{String(item.issueNumber).padStart(4, "0")} raised</Link>;
  const generalFiles = task.files.filter((f) => !f.itemId);
  const notYet = task.status === "todo" && task.opensAt && new Date(task.opensAt) > new Date();
  const more = [
    can.edit && { label: "Change task", icon: "edit", onClick: () => setDialog("edit") },
    can.cancel && { label: "Cancel task", icon: "ban", danger: true, onClick: () => setDialog("cancel") },
    can.reopen && { label: "Reopen", icon: "undo", onClick: () => setDialog("reopen") },
    t.can("tasks.manage") && !task.scheduleId && task.answeredCount === 0 && ["todo", "in_progress"].includes(task.status) && {
      label: "Delete", icon: "trash", danger: true, onClick: async () => {
        if (!(await confirm({ title: "Delete this task?", message: "It is removed for everyone. Use Cancel to keep a record instead.", confirmLabel: "Delete" }))) return;
        if (await act(() => t.api.removeTask(task.id).then(() => null), "Task deleted")) navigate(t.link());
      },
    },
  ].filter(Boolean);

  return (
    <div className="stack tk-page tk-run">
      <div className="tk-run-head card">
        <Link to={t.link()} className="tk-back"><Icon name="undo" size={14} /> My tasks</Link>
        <div className="tk-run-title">
          <h1>{task.title}</h1>
          <div className="tk-run-actions">
            <StatusPill status={task.status} overdue={task.overdue} />
            {more.length > 0 && <ActionMenu items={more} label="Task actions" />}
          </div>
        </div>
        <div className="tk-card-meta">
          {task.dueAt && <span className={task.overdue ? "text-danger" : ""}><Icon name="clock" size={13} /> Due {dateShort(task.dueAt)}, {timeOnly(task.dueAt)}</span>}
          {task.shiftLabel && <span>{task.shiftLabel}</span>}
          {task.placeName && <span><Icon name="store" size={13} /> {task.placeName}</span>}
          <CategoryTag code={task.category} />
          <PriorityTag priority={task.priority} />
          <span><Icon name="user" size={13} /> {task.assigneeNames}</span>
          {task.projectName && <Link to={t.link(`projects/${task.projectId}`)}><Icon name="layers" size={13} /> {task.projectName}</Link>}
          {task.issueId && <Link to={t.link(`issues/${task.issueId}`)}><Icon name="alert" size={13} /> From an issue</Link>}
          {task.scheduleId && <span className="muted"><Icon name="refresh" size={13} /> Recurring</span>}
        </div>
        {task.description && <p className="tk-run-desc">{task.description}</p>}
        {task.reviewStatus === "changes_requested" && <p className="tk-banner tone-danger"><Icon name="undo" size={14} /> Sent back by {task.reviewedByName}: {task.reviewNote}</p>}
        {task.reviewStatus === "pending" && <p className="tk-banner tone-warning"><Icon name="clock" size={14} /> Done by {task.completedByName}, waiting for a manager's review</p>}
        {task.reviewStatus === "approved" && <p className="tk-banner tone-success"><Icon name="check" size={14} /> Approved by {task.reviewedByName}{task.reviewNote ? `: ${task.reviewNote}` : ""}</p>}
        {task.status === "missed" && <p className="tk-banner tone-danger"><Icon name="alert" size={14} /> Missed: its time ran out before it was done.</p>}
        {task.status === "cancelled" && <p className="tk-banner tone-neutral"><Icon name="ban" size={14} /> Cancelled: {task.cancelReason}</p>}
        {notYet && <p className="tk-banner tone-info"><Icon name="clock" size={14} /> Opens at {timeOnly(task.opensAt)}.</p>}
        {task.itemCount > 0 && (
          <div className="tk-run-progress">
            <Progress done={task.answeredCount} total={task.itemCount} failed={task.failedCount}
              label={`${task.answeredCount} of ${task.itemCount} checks${task.failedCount ? ` · ${task.failedCount} failed` : ""}${task.scorePercent !== null ? ` · score ${Math.round(task.scorePercent)}%` : ""}`} />
            {task.criticalFailed && <span className="tk-tag tone-danger">Critical check failed</span>}
          </div>
        )}
      </div>

      {items.length > 0 && (
        <ol className="tk-checklist" aria-label="Checklist">
          {items.map((item, index) => {
            if (item.kind === "section") return <li key={item.id} className="tk-section"><h2>{item.label}</h2></li>;
            return <ChecklistItem key={item.id} item={item} number={numbers[index]} files={task.files} canWork={can.work && !notYet}
              onAnswer={onAnswer} onUpload={onUpload} onRemoveFile={onRemoveFile} issueLink={issueLink} />;
          })}
        </ol>
      )}

      {(can.work || can.review) && (
        <div className="tk-run-bar" data-motion-layer>
          {justDone && <SuccessCheck size={30} label="Task done" />}
          {can.work && task.status === "todo" && items.length === 0 && !notYet && (
            <button type="button" className="button button-secondary button-lg" disabled={busy} onClick={() => act(() => t.api.startTask(task.id), "Started")}>Start</button>
          )}
          {can.work && !notYet && (
            <button type="button" className="button button-lg tk-done-button" disabled={busy || left > 0}
              onClick={async () => { if (await act(() => t.api.complete(task.id, {}), "Task done")) setJustDone(true); }}>
              <Icon name="check" size={18} /> {left > 0 ? `${left} check${left === 1 ? "" : "s"} left` : "Mark done"}
            </button>
          )}
          {can.review && (
            <>
              <button type="button" className="button button-secondary button-lg" disabled={busy} onClick={() => setDialog("sendback")}>Send back</button>
              <button type="button" className="button button-lg" disabled={busy} onClick={() => act(() => t.api.review(task.id, { decision: "approve" }), "Approved")}><Icon name="check" size={18} /> Approve</button>
            </>
          )}
        </div>
      )}

      <SectionCard icon="message" title="Notes and evidence" flush>
        <div className="segmented tk-run-tabs" role="tablist" aria-label="Task details">
          {[["comments", `Comments (${task.comments.length})`], ["photos", `Photos (${task.files.length})`], ["history", "History"]].map(([code, label]) => (
            <button key={code} type="button" role="tab" aria-selected={tab === code} className={`segment ${tab === code ? "is-active" : ""}`} onClick={() => setTab(code)}>{label}</button>
          ))}
        </div>
        <div className="tk-run-tab">
          {tab === "comments" && <Comments comments={task.comments} onAdd={async (body) => { await t.api.commentTask(task.id, body); await load(); }} />}
          {tab === "photos" && (
            <div className="stack">
              {task.files.length === 0 && <p className="muted small">No photos yet.</p>}
              <PhotoStrip files={task.files} onRemove={can.work ? onRemoveFile : null} />
              {can.work && generalFiles.length < 20 && <PhotoButton label="Add a photo" onUpload={(file) => onUpload(null, file, "photo")} />}
            </div>
          )}
          {tab === "history" && <History items={task.history} />}
        </div>
        <p className="muted small tk-run-foot">Created by {task.createdByName || "the schedule"} · {dateTime(task.createdAt)}{task.completedAt ? ` · done ${dateTime(task.completedAt)} by ${task.completedByName}` : ""}</p>
      </SectionCard>

      {dialog === "edit" && <TaskFormDialog task={task} onClose={() => setDialog(null)} onSaved={(v) => { setDialog(null); setTask(v); }} />}
      {dialog === "cancel" && <Reason title="Cancel this task" label="Why" confirmLabel="Cancel task" onClose={() => setDialog(null)}
        onSubmit={async (reason) => { if (await act(() => t.api.cancel(task.id, { reason }), "Task cancelled")) setDialog(null); }} />}
      {dialog === "reopen" && <Reason title="Reopen this task" label="Why" confirmLabel="Reopen" onClose={() => setDialog(null)}
        onSubmit={async (reason) => { if (await act(() => t.api.reopen(task.id, { reason }), "Task reopened")) setDialog(null); }} />}
      {dialog === "sendback" && <Reason title="Send back" label="What needs to change" confirmLabel="Send back" onClose={() => setDialog(null)}
        onSubmit={async (note) => { if (await act(() => t.api.review(task.id, { decision: "changes", note }), "Sent back")) setDialog(null); }} />}
    </div>
  );
}
