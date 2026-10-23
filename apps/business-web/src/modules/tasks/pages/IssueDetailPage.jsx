import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import ActionMenu from "../../../components/ActionMenu";
import SectionCard from "../../../components/SectionCard";
import Modal from "../../../components/Modal";
import { ErrorMessage, ScreenLoading } from "../../../components/Feedback";
import { dateTime, relative } from "@bmp/shared/format";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useConfirm from "../../../hooks/useConfirm";
import useTasks from "./useTasks";
import { CategoryTag, Comments, History, PeoplePicker, PhotoButton, PhotoStrip, SeverityTag, StatusPill } from "./parts";
import { IssueFormDialog, TaskFormDialog } from "./forms";

// One issue: what is wrong, the photos, who is fixing it, and its life:
// open → being fixed → fixed (with what was done) → closed by a manager.
// "Make a task" gives the fix to someone as a task that points back here.

function NoteDialog({ title, label, confirmLabel, onClose, onSubmit, required = true }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} dismissible={!busy}>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSubmit(text.trim()); } finally { setBusy(false); } }}>
        <label className="field"><span>{label}</span><textarea rows={3} maxLength={1000} required={required} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button" disabled={busy}>{busy ? "Saving…" : confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function IssueDetailPage() {
  const { issueId } = useParams();
  const t = useTasks();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [issue, setIssue] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => t.api.issue(issueId).then((v) => { setIssue(v); setError(""); }).catch((err) => setError(getErrorMessage(err))), [t.api, issueId]);
  useEffect(() => { load(); }, [load]);

  const act = async (work, message) => {
    setBusy(true);
    try {
      const value = await work();
      if (value) setIssue(value);
      if (message) toast.success(message);
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const status = (next, note, message) => act(() => t.api.issueStatus(issue.id, { status: next, note }), message);

  if (error) return <div className="stack"><ErrorMessage message={error} /><Link className="button button-secondary" to={t.link("issues")}>Back to issues</Link></div>;
  if (!issue) return <ScreenLoading label="Opening the issue…" />;
  const can = issue.can;
  const more = [
    can.edit && { label: "Change details", icon: "edit", onClick: () => setDialog("edit") },
    can.convert && { label: "Make a task to fix it", icon: "check", onClick: () => setDialog("task") },
    can.remove && { label: "Delete", icon: "trash", danger: true, onClick: async () => {
      if (!(await confirm({ title: `Delete ${issue.code}?`, message: "It is removed for everyone. Close it instead to keep the record.", confirmLabel: "Delete" }))) return;
      if (await act(() => t.api.removeIssue(issue.id).then(() => null), "Issue deleted")) navigate(t.link("issues"));
    } },
  ].filter(Boolean);

  return (
    <div className="stack tk-page tk-issue">
      <div className="tk-run-head card">
        <Link to={t.link("issues")} className="tk-back"><Icon name="undo" size={14} /> Issues</Link>
        <div className="tk-run-title">
          <h1><span className="tk-code">{issue.code}</span> {issue.title}</h1>
          <div className="tk-run-actions">
            <StatusPill kind="issue" status={issue.status} />
            {more.length > 0 && <ActionMenu items={more} label="Issue actions" />}
          </div>
        </div>
        <div className="tk-card-meta">
          <SeverityTag severity={issue.severity} />
          <CategoryTag code={issue.category} />
          {issue.placeName && <span><Icon name="store" size={13} /> {issue.placeName}</span>}
          {issue.assetLabel && <span><Icon name="settings" size={13} /> {issue.assetLabel}</span>}
          <span title={dateTime(issue.reportedAt)}><Icon name="user" size={13} /> {issue.reportedByName}, {relative(issue.reportedAt)}</span>
          {issue.dueAt && <span className={issue.overdue ? "text-danger" : ""}><Icon name="clock" size={13} /> Fix by {dateTime(issue.dueAt)}</span>}
        </div>
        {issue.description && <p className="tk-run-desc">{issue.description}</p>}
        {issue.sourceTaskId && <p className="tk-banner tone-info"><Icon name="clipboard" size={14} /> Raised by a failed check on <Link to={t.link(`run/${issue.sourceTaskId}`)}>{issue.sourceTaskTitle}</Link></p>}
        {issue.logbook && <p className="tk-banner tone-info"><Icon name="book" size={14} /> From the log book ({issue.logbook.business_date}, {issue.logbook.shift_label}): <Link to="/logbook">open the log book</Link></p>}
        {issue.resolutionNote && <p className="tk-banner tone-success"><Icon name="check" size={14} /> Fixed by {issue.resolvedByName}: {issue.resolutionNote}</p>}
        {issue.tasks.length > 0 && (
          <p className="tk-banner tone-neutral"><Icon name="check" size={14} /> Task{issue.tasks.length > 1 ? "s" : ""}: {issue.tasks.map((x, i) => <span key={x.id}>{i > 0 && ", "}<Link to={t.link(`run/${x.id}`)}>{x.title}</Link> ({x.status.replace("_", " ")})</span>)}</p>
        )}
      </div>

      <SectionCard icon="user" title="Who is fixing it" actions={can.assign && (
        <div className="tk-assignee-pick">
          <PeoplePicker aria-label="Assign to" placeholder="Assign to…" kind="user" value={issue.assigneeId ? { kind: "user", id: issue.assigneeId, name: issue.assigneeName } : null}
            onChange={(p) => act(() => t.api.updateIssue(issue.id, { assigneeId: p ? p.id : null }), p ? `Assigned to ${p.name}` : "Unassigned")} />
        </div>
      )}>
        <p>{issue.assigneeName ? <strong>{issue.assigneeName}</strong> : <span className="muted">Nobody yet.</span>}</p>
        <div className="tk-issue-steps">
          {issue.status === "open" && can.work && <button type="button" className="button" disabled={busy} onClick={() => status("in_progress", null, "Marked as being fixed")}>Start fixing</button>}
          {can.resolve && <button type="button" className="button" disabled={busy} onClick={() => setDialog("resolve")}><Icon name="check" size={16} /> Mark fixed</button>}
          {can.close && <button type="button" className="button" disabled={busy} onClick={() => status("closed", null, "Issue closed")}>Check and close</button>}
          {can.reopen && <button type="button" className="button button-secondary" disabled={busy} onClick={() => setDialog("reopen")}>Reopen</button>}
          {can.convert && <button type="button" className="button button-secondary" disabled={busy} onClick={() => setDialog("task")}>Make a task</button>}
        </div>
      </SectionCard>

      <SectionCard icon="eye" title="Photos" description="What it looked like, and after the fix.">
        <div className="stack">
          {issue.files.length === 0 && <p className="muted small">No photos yet.</p>}
          <PhotoStrip files={issue.files} onRemove={async (f) => {
            if (!(await confirm({ title: "Remove this photo?", confirmLabel: "Remove" }))) return;
            await act(() => t.api.removeFile(f.id).then(load).then(() => null));
          }} />
          {(can.edit || can.work) && <PhotoButton label="Add a photo" onUpload={async (file) => {
            const fd = new FormData();
            fd.append("kind", "photo");
            fd.append("file", file);
            await t.api.uploadIssueFile(issue.id, fd);
            await load();
          }} />}
        </div>
      </SectionCard>

      <SectionCard icon="message" title="Comments"><Comments comments={issue.comments} onAdd={async (body) => { await t.api.commentIssue(issue.id, body); await load(); }} /></SectionCard>
      <SectionCard icon="history" title="History"><History items={issue.history} /></SectionCard>

      {dialog === "edit" && <IssueFormDialog issue={issue} onClose={() => setDialog(null)} onSaved={(v) => { setDialog(null); setIssue(v); }} />}
      {dialog === "resolve" && <NoteDialog title="Mark fixed" label="What was done" confirmLabel="Mark fixed" onClose={() => setDialog(null)}
        onSubmit={async (note) => { if (await status("resolved", note, "Marked fixed")) setDialog(null); }} />}
      {dialog === "reopen" && <NoteDialog title="Reopen" label="Why (optional)" required={false} confirmLabel="Reopen" onClose={() => setDialog(null)}
        onSubmit={async (note) => { if (await status("open", note || null, "Reopened")) setDialog(null); }} />}
      {dialog === "task" && <TaskFormDialog preset={{ title: `Fix: ${issue.title}`.slice(0, 160), category: issue.category }} onClose={() => setDialog(null)}
        onSaved={() => { setDialog(null); load(); }} convertIssue={issue} />}
    </div>
  );
}
