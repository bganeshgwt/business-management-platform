import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import Icon from "../../../components/Icon";
import StatusBadge from "../../../components/StatusBadge";
import SearchPicker from "../../../components/SearchPicker";
import FormField from "../../../components/FormField";
import { EmptyState } from "../../../components/Feedback";
import { dateTime, relative } from "../../../services/format";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useTasks from "./useTasks";
import { ISSUE_STATUS, PRIORITY, PROJECT_STATUS, SEVERITY, TASK_STATUS } from "./taskWords";

// Small pieces every task screen shares.

// A person from this business, searched on the server as you type (round 2:
// a big restaurant has hundreds of staff; loading them all was ~330 KB).
// kind "user": logins only (issues, projects). exclude: [{ kind, id }] or ids.
export function PeoplePicker({ kind, exclude = [], ...props }) {
  const { searchPeople } = useTasks();
  const skip = new Set(exclude.map((x) => (typeof x === "object" ? `${x.kind}:${x.id}` : `user:${x}`)));
  return (
    <SearchPicker minChars={0} limit={30} emptyText="Nobody by that name" loadingText="Looking…" {...props}
      search={(q, { signal }) => searchPeople(q, { signal, kind }).then((rows) => rows.filter((p) => !skip.has(`${p.kind}:${p.id}`)))}
      getKey={(p) => `${p.kind || "user"}:${p.id}`} getLabel={(p) => p.name} getDescription={(p) => p.detail || ""} />
  );
}

const MAPS = { task: TASK_STATUS, issue: ISSUE_STATUS, project: PROJECT_STATUS };
export function StatusPill({ kind = "task", status, overdue }) {
  if (overdue) return <StatusBadge status="overdue" label="Overdue" tone="danger" />;
  const word = MAPS[kind][status] || { label: status, tone: "neutral" };
  return <StatusBadge status={status} label={word.label} tone={word.tone} />;
}

export function PriorityTag({ priority }) {
  if (!priority || priority === "normal") return null;
  const word = PRIORITY[priority];
  return <span className={`tk-tag tone-${word.tone}`}><Icon name={priority === "low" ? "minus" : "alert"} size={12} /> {word.label}</span>;
}

export function SeverityTag({ severity }) {
  const word = SEVERITY[severity] || SEVERITY.medium;
  return <span className={`tk-tag tone-${word.tone}`}><span className="tk-dot" aria-hidden="true" /> {word.label}</span>;
}

export function CategoryTag({ code }) {
  const { categoryName, categoryIcon } = useTasks();
  if (!code) return null;
  return <span className="tk-tag tk-cat"><Icon name={categoryIcon(code)} size={12} /> {categoryName(code)}</span>;
}

export function Progress({ done, total, failed = 0, label }) {
  const pct = total ? Math.round((100 * done) / total) : 0;
  return (
    <span className="tk-progress" title={label || `${done} of ${total} done`}>
      <span className="tk-progress-track" aria-hidden="true">
        <span className={`tk-progress-fill ${failed ? "has-failed" : ""} ${pct === 100 ? "is-full" : ""}`} style={{ transform: `scaleX(${pct / 100})` }} />
      </span>
      <span className="tk-progress-text">{label || `${done}/${total}`}</span>
    </span>
  );
}

// The strip of task screens at the top of every task page (the sidebar has
// them too; on a phone this is the quicker way across).
export function TasksNav() {
  const { link, can, has } = useTasks();
  const tabs = [
    ["", "My tasks", "check", true],
    ["board", "Team board", "grid", can("tasks.view")],
    ["calendar", "Calendar", "calendar", true],
    ["issues", "Issues", "alert", has("issues")],
    ["projects", "Projects", "layers", has("projects")],
    ["templates", "Templates", "clipboard", can("tasks.create") || can("tasks.manage")],
    ["recurring", "Recurring", "refresh", can("tasks.view")],
    ["reports", "Reports", "chart", can("tasks.view")],
  ].filter((t) => t[3]);
  return (
    <nav className="tk-nav" aria-label="Task screens">
      <div className="tk-nav-row" data-motion-tabs>
        {tabs.map(([path, label, icon]) => (
          <NavLink key={path} to={link(path)} end={!path} className={({ isActive }) => `tk-nav-link ${isActive ? "is-active" : ""}`}>
            <Icon name={icon} size={15} /> {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

// Who does it: people (one or several), a role, whoever is on shift, nobody yet.
export function AssignField({ mode, assignees, onChange, allowOthers = true }) {
  const { roles, userId, world } = useTasks();
  const setMode = (next) => onChange(next, next === "people" ? assignees.filter((a) => !["role", "business_role"].includes(a.kind)) : []);
  const chosen = assignees.filter((a) => !["role", "business_role"].includes(a.kind));
  const role = assignees.find((a) => ["role", "business_role"].includes(a.kind));
  const nameOf = (a) => a.name || (a.kind === "user" && a.id === userId ? "You" : "Someone");
  if (!allowOthers) {
    return <p className="muted small">Assigned to you. Assigning to others needs the “Assign tasks” permission.</p>;
  }
  const modes = [["people", "People"], ["role", "A role"], ["on_shift", "Whoever is on shift"], ["unassigned", "Nobody yet"]];
  return (
    <fieldset className="field field-wide tk-assign">
      <legend>Assign to</legend>
      <div className="segmented" role="group" aria-label="Assign to">
        {modes.map(([code, label]) => (
          <button key={code} type="button" className={`segment ${mode === code ? "is-active" : ""}`} aria-pressed={mode === code} onClick={() => setMode(code)}>{label}</button>
        ))}
      </div>
      {mode === "people" && (
        <>
          {chosen.length > 0 && (
            <ul className="tk-chips" aria-label="Assigned">
              {chosen.map((a) => (
                <li key={`${a.kind}:${a.id}`} className="tk-chip">
                  {nameOf(a)}{a.kind === "user" && a.id === userId ? " (you)" : ""}
                  <button type="button" className="tk-chip-x" aria-label={`Remove ${nameOf(a)}`} onClick={() => onChange("people", chosen.filter((x) => !(x.kind === a.kind && x.id === a.id)))}>
                    <Icon name="x" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <PeoplePicker aria-label="Add a person" placeholder="Add a person: type a name" exclude={chosen} clearOnSelect
            onChange={(p) => p && onChange("people", [...chosen, { kind: p.kind, id: p.id, name: p.name }])} />
          <small className="muted">Several people: any one of them can do it. {world === "restaurant" ? "Staff without a login are done for by their manager." : "Stylists or rooms without a login are done for by a manager."}</small>
        </>
      )}
      {mode === "role" && (
        <select aria-label="Role" value={role ? `${role.kind}:${role.id}` : ""} onChange={(e) => {
          const r = roles.find((x) => `${x.kind}:${x.id}` === e.target.value);
          onChange("role", r ? [{ kind: r.kind, id: r.id, name: r.name }] : []);
        }} required>
          <option value="">Choose a role…</option>
          {roles.map((r) => <option key={`${r.kind}:${r.id}`} value={`${r.kind}:${r.id}`}>{r.name}</option>)}
        </select>
      )}
      {mode === "on_shift" && <small className="muted">{world === "restaurant" ? "Shows for everyone rostered or clocked in that day at that outlet (everyone, on a day with no roster). The first to start it does it." : "Shows for everyone working here; the first to start it does it."}</small>}
      {mode === "unassigned" && <small className="muted">A manager assigns it later.</small>}
    </fieldset>
  );
}

export function PlaceSelect({ value, onChange, label }) {
  const { places, placeWord, outletScope } = useTasks();
  if (!places.length) return null;
  return (
    <FormField label={label || placeWord} optional>
      <select value={outletScope || value || ""} disabled={Boolean(outletScope)} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{`Whole business (every ${placeWord.toLowerCase()})`}</option>
        {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </FormField>
  );
}

export function CategorySelect({ value, onChange }) {
  const { categories } = useTasks();
  return (
    <FormField label="Category">
      <select value={value} onChange={(e) => onChange(e.target.value)} required>
        {categories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
    </FormField>
  );
}

// A private photo: fetched with the sign-in, shown from a blob.
export function AuthImage({ fileId, alt, className = "" }) {
  const { api } = useTasks();
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    let made = null;
    api.fileBlob(fileId).then((blob) => {
      made = URL.createObjectURL(blob);
      if (live) setUrl(made);
      else URL.revokeObjectURL(made);
    }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [api, fileId]);
  return url ? <img src={url} alt={alt} className={className} loading="lazy" /> : <span className={`tk-img-wait skeleton ${className}`} aria-label="Loading photo" />;
}

// Phone cameras take 4000 px photos; 1600 px is plenty for evidence.
const shrink = (file) => new Promise((resolve) => {
  if (!file.type.startsWith("image/") || file.size < 400000) return resolve(file);
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => resolve(blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file), "image/jpeg", 0.82);
  };
  img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
  img.src = url;
});

// "Take photo": opens the camera on a phone, the file picker elsewhere.
export function PhotoButton({ onUpload, label = "Take photo", className = "button button-secondary", disabled }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      await onUpload(await shrink(file));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <button type="button" className={className} disabled={disabled || busy} onClick={() => input.current?.click()}>
        <Icon name="plus" size={15} /> {busy ? "Uploading…" : label}
      </button>
    </>
  );
}

// A signature drawn with a finger or the mouse, saved as a PNG.
export function SignaturePad({ onSave, onCancel }) {
  const canvas = useRef(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = canvas.current;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const g = c.getContext("2d");
    g.scale(ratio, ratio);
    g.lineWidth = 2.4;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#1b2a3a";
  }, []);
  const at = (e) => {
    const r = canvas.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const down = (e) => {
    drawing.current = true;
    canvas.current.setPointerCapture(e.pointerId);
    const g = canvas.current.getContext("2d");
    g.beginPath();
    g.moveTo(...at(e));
  };
  const move = (e) => {
    if (!drawing.current) return;
    const g = canvas.current.getContext("2d");
    g.lineTo(...at(e));
    g.stroke();
    setEmpty(false);
  };
  const up = () => { drawing.current = false; };
  const clear = () => {
    const c = canvas.current;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  };
  const save = () => {
    setBusy(true);
    canvas.current.toBlob(async (blob) => {
      try {
        await onSave(new File([blob], "signature.png", { type: "image/png" }));
      } catch (err) {
        toast.error(getErrorMessage(err));
      } finally {
        setBusy(false);
      }
    }, "image/png");
  };
  return (
    <div className="tk-sign">
      <canvas ref={canvas} className="tk-sign-pad" aria-label="Sign here" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
      <div className="tk-sign-actions">
        <button type="button" className="button button-ghost button-sm" onClick={clear} disabled={empty || busy}>Clear</button>
        {onCancel && <button type="button" className="button button-ghost button-sm" onClick={onCancel}>Cancel</button>}
        <button type="button" className="button button-sm" onClick={save} disabled={empty || busy}>{busy ? "Saving…" : "Save signature"}</button>
      </div>
    </div>
  );
}

export function Comments({ comments, onAdd }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onAdd(text.trim());
      setText("");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tk-comments">
      {comments.length === 0 && <p className="muted small">No comments yet.</p>}
      <ul className="tk-comment-list">
        {comments.map((c) => (
          <li key={c.id} className={`tk-comment ${c.mine ? "is-mine" : ""}`}>
            <div className="tk-comment-head"><strong>{c.author}</strong> <span className="muted small" title={dateTime(c.createdAt)}>{relative(c.createdAt)}</span></div>
            <p>{c.body}</p>
          </li>
        ))}
      </ul>
      <form className="tk-comment-form" onSubmit={submit}>
        <textarea aria-label="Write a comment" rows={2} maxLength={2000} placeholder="Write a comment…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="button button-sm" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send"}</button>
      </form>
    </div>
  );
}

const HISTORY_WORDS = {
  created: "created it", started: "started", completed: "marked it done", approved: "approved it", changes_requested: "sent it back",
  cancelled: "cancelled it", reopened: "reopened it", missed: "Missed: its time ran out", updated: "changed it", item_failed: "recorded a failed check",
  item_passed: "corrected a failed check", file_added: "added a photo", file_removed: "removed a photo", signed: "signed",
  reported: "reported it", assigned: "assigned it", in_progress: "started fixing it", resolved: "marked it fixed", closed: "closed it",
  task_made: "made a task from it", task_added: "added a task", task_done: "finished a task", members: "changed the members",
  milestone_added: "added a milestone", milestone_done: "completed a milestone", milestone_reopened: "reopened a milestone",
  milestone_changed: "changed a milestone", milestone_removed: "removed a milestone", list_added: "added a task list", list_renamed: "renamed a task list",
  list_removed: "removed a task list", status_active: "made it active", status_on_hold: "put it on hold", status_completed: "completed it",
  status_cancelled: "cancelled it", status_planning: "moved it to planning",
};
const historyDetail = (h) => {
  const d = h.details || {};
  if (d.item) return `${d.item}${d.value !== undefined && d.value !== null ? `: ${d.value}` : ""}${d.issue ? ` (issue ISS-${String(d.issue).padStart(4, "0")})` : ""}`;
  if (d.reason) return d.reason;
  if (d.note) return d.note;
  if (d.title && h.action.startsWith("task_")) return d.title;
  if (d.name) return d.name;
  if (d.file) return d.file;
  if (d.late) return "after its due time";
  return "";
};
export function History({ items }) {
  if (!items.length) return <p className="muted small">Nothing yet.</p>;
  return (
    <ol className="tk-history">
      {items.map((h) => (
        <li key={h.id}>
          <span className="tk-history-dot" aria-hidden="true" />
          <div>
            <span>{h.action === "missed" ? HISTORY_WORDS.missed : <><strong>{h.actor}</strong> {HISTORY_WORDS[h.action] || h.action.replace(/_/g, " ")}</>}</span>
            {historyDetail(h) && <span className="muted"> · {historyDetail(h)}</span>}
            <div className="muted small">{dateTime(h.at)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function PhotoStrip({ files, onRemove }) {
  const [open, setOpen] = useState(null);
  if (!files.length) return null;
  return (
    <>
      <ul className="tk-photos">
        {files.map((f) => (
          <li key={f.id} className="tk-photo">
            {f.mimeType.startsWith("image/")
              ? <button type="button" className="tk-photo-open" onClick={() => setOpen(f)} aria-label={`Open ${f.fileName}`}><AuthImage fileId={f.id} alt={f.kind === "signature" ? "Signature" : f.fileName} /></button>
              : <span className="tk-file"><Icon name="file" size={18} /> {f.fileName}</span>}
            {onRemove && f.mine && <button type="button" className="tk-photo-x" aria-label={`Remove ${f.fileName}`} onClick={() => onRemove(f)}><Icon name="x" size={12} /></button>}
          </li>
        ))}
      </ul>
      {open && (
        <div className="tk-lightbox" role="dialog" aria-modal="true" aria-label={open.fileName} data-motion-layer onClick={() => setOpen(null)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(null)} tabIndex={-1}>
          <AuthImage fileId={open.id} alt={open.fileName} />
          <p>{open.uploadedByName} · {dateTime(open.uploadedAt)}</p>
          <button type="button" className="button button-secondary" autoFocus onClick={() => setOpen(null)}>Close</button>
        </div>
      )}
    </>
  );
}

// A screen this person's role does not include, said in words.
export function NotAllowed({ what }) {
  return <EmptyState icon="lock" message={`${what} is not part of your role`} hint="Ask the owner or a manager if you need it." />;
}
