import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "../../../components/Modal";
import FormField from "../../../components/FormField";
import SearchPicker from "../../../components/SearchPicker";
import ActionMenu from "../../../components/ActionMenu";
import Icon from "../../../components/Icon";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useTasks from "./useTasks";
import ItemsEditor from "./ItemsEditor";
import { AssignField, CategorySelect, PeoplePicker, PhotoButton, PlaceSelect } from "./parts";
import { fromLocalInput, itemsForApi, todayText, withKeys } from "./taskWords";

// The three "+ Create" dialogs: a task (from a template or blank), an issue
// (with photos), a project (blank or from a project template).

// "+ Create" → Task / Issue / Project, as this person may.
export function CreateMenu({ onCreated, compact = false }) {
  const { can, has } = useTasks();
  const [open, setOpen] = useState(null);
  const items = [
    can("tasks.create") && { label: "Task", icon: "check", onClick: () => setOpen("task") },
    has("issues") && can("issues.create") && { label: "Issue", icon: "alert", onClick: () => setOpen("issue") },
    has("projects") && can("projects.create") && { label: "Project", icon: "layers", onClick: () => setOpen("project") },
  ].filter(Boolean);
  if (!items.length) return null;
  const done = (kind, value) => { setOpen(null); onCreated?.(kind, value); };
  return (
    <>
      {items.length === 1
        ? <button type="button" className="button" onClick={items[0].onClick}><Icon name="plus" size={16} /> {compact ? items[0].label : `New ${items[0].label.toLowerCase()}`}</button>
        : <span className="tk-create"><ActionMenu text={<><Icon name="plus" size={16} /> Create</>} label="Create a task, issue or project" items={items} /></span>}
      {open === "task" && <TaskFormDialog onClose={() => setOpen(null)} onSaved={(t) => done("task", t)} />}
      {open === "issue" && <IssueFormDialog onClose={() => setOpen(null)} onSaved={(i) => done("issue", i)} />}
      {open === "project" && <ProjectFormDialog onClose={() => setOpen(null)} onSaved={(p) => done("project", p)} />}
    </>
  );
}

// A new task, or a change to one (`task`). `preset` fills fields (a project, a template).
export function TaskFormDialog({ task, preset = {}, convertIssue, onClose, onSaved }) {
  const t = useTasks();
  const navigate = useNavigate();
  const editing = Boolean(task);
  const [library, setLibrary] = useState([]);
  const [own, setOwn] = useState([]);
  const [template, setTemplate] = useState(preset.template || null);
  const [form, setForm] = useState(() => ({
    title: task?.title || preset.title || "",
    description: task?.description || "",
    category: task?.category || preset.category || "day_to_day",
    priority: task?.priority || "normal",
    dueAt: task?.dueAt ? toLocal(task.dueAt) : preset.dueAt || "",
    placeId: task?.placeId || null,
    requiresReview: task?.requiresReview || false,
    projectId: task?.projectId || preset.projectId || null,
    projectListId: task?.projectListId || preset.projectListId || null,
    milestoneId: task?.milestoneId || preset.milestoneId || null,
  }));
  const [assignMode, setAssignMode] = useState(task?.assignMode || "people");
  const [assignees, setAssignees] = useState(task?.assignees || [{ kind: "user", id: t.userId }]);
  const [items, setItems] = useState([]);
  const [withChecklist, setWithChecklist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allowOthers = t.can("tasks.assign");

  const canCreate = t.can("tasks.create");
  useEffect(() => {
    if (editing) return;
    t.api.library().then(setLibrary).catch(() => {});
    if (canCreate) t.api.templates().then(setOwn).catch(() => {});
  }, [t.api, editing, canCreate]);

  const options = useMemo(() => [
    ...own.filter((x) => x.active).map((x) => ({ ...x, key: `own:${x.id}`, group: "Our templates" })),
    ...library.map((x) => ({ ...x, key: `lib:${x.code}`, group: "Library" })),
  ], [own, library]);

  const pick = (option) => {
    setTemplate(option);
    if (option) {
      setForm((f) => ({ ...f, title: f.title || option.name, category: option.category, priority: option.priority || f.priority, requiresReview: option.requiresReview || f.requiresReview }));
      setWithChecklist(false);
    }
  };
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = {
      title: form.title || undefined, description: form.description, category: form.category, priority: form.priority,
      dueAt: fromLocalInput(form.dueAt), placeId: form.placeId, requiresReview: form.requiresReview,
      assignMode: allowOthers ? assignMode : "people", assignees: allowOthers ? assignees.map(({ kind, id }) => ({ kind, id })) : [{ kind: "user", id: t.userId }],
    };
    if (form.projectId) Object.assign(body, { projectId: form.projectId, projectListId: form.projectListId, milestoneId: form.milestoneId });
    try {
      let saved;
      if (editing) {
        saved = await t.api.updateTask(task.id, body);
        toast.success("Task saved");
      } else {
        if (template) Object.assign(body, template.source === "own" ? { templateId: template.id } : { libraryCode: template.code });
        else if (withChecklist && items.length) body.items = itemsForApi(items);
        if (convertIssue) {
          const made = await t.api.convertIssue(convertIssue.id, body);
          saved = { id: made.taskId, title: body.title || form.title };
        } else {
          saved = await t.api.createTask(body);
        }
        const savedId = saved.id;
        toast.success(`Task created: ${saved.title}`, { action: { label: "Open", onClick: () => navigate(t.link(`run/${savedId}`)) } });
      }
      onSaved?.(saved);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? "Change task" : convertIssue ? `Task to fix ${convertIssue.code}` : "New task"} icon="check" onClose={onClose} width={720} dismissible={!busy}>
      <form className="form-grid tk-form" onSubmit={submit}>
        {!editing && (
          <div className="field-wide">
            <SearchPicker label="From a template" hint="Optional. Its checklist is copied into the task." placeholder="Opening checklist, temperature log, FSSAI…"
              options={options} value={template ? options.find((o) => o.key === (template.source === "own" ? `own:${template.id}` : `lib:${template.code}`)) || template : null}
              getKey={(o) => o.key} getLabel={(o) => o.name} getDescription={(o) => `${o.group} · ${t.categoryName(o.category)} · ${o.itemCount} checks`}
              getKeywords={(o) => `${o.description || ""} ${t.categoryName(o.category)}`} minChars={0} onChange={pick} />
          </div>
        )}
        <FormField label="Title" wide>
          <input value={form.title} maxLength={160} required={!template} placeholder={template ? template.name : "What needs doing"} onChange={(e) => set("title", e.target.value)} />
        </FormField>
        <FormField label="Details" optional wide>
          <textarea rows={2} maxLength={2000} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </FormField>
        <CategorySelect value={form.category} onChange={(v) => set("category", v)} />
        <FormField label="Priority">
          <select value={form.priority} onChange={(e) => set("priority", e.target.value)}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </FormField>
        <FormField label="Due" optional>
          <input type="datetime-local" value={form.dueAt} onChange={(e) => set("dueAt", e.target.value)} />
        </FormField>
        <PlaceSelect value={form.placeId} onChange={(v) => set("placeId", v)} />
        <AssignField mode={assignMode} assignees={assignees} allowOthers={allowOthers} onChange={(mode, list) => { setAssignMode(mode); setAssignees(list); }} />
        <label className="field field-wide tk-inline">
          <input type="checkbox" checked={form.requiresReview} onChange={(e) => set("requiresReview", e.target.checked)} /> A manager reviews it when it is done
        </label>
        {!editing && !template && (
          <div className="field-wide">
            {withChecklist
              ? <ItemsEditor items={items} onChange={setItems} />
              : <button type="button" className="chip-button" onClick={() => { setWithChecklist(true); setItems(withKeys([{ kind: "checkbox", label: "", required: true }])); }}>+ Add a checklist</button>}
          </div>
        )}
        <ErrorMessage message={error} />
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button" disabled={busy}>{busy ? "Saving…" : editing ? "Save" : "Create task"}</button>
        </div>
      </form>
    </Modal>
  );
}

const toLocal = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Report an issue: what is wrong, how bad, where, a photo.
export function IssueFormDialog({ issue, onClose, onSaved }) {
  const t = useTasks();
  const navigate = useNavigate();
  const editing = Boolean(issue);
  const [form, setForm] = useState(() => ({
    title: issue?.title || "", description: issue?.description || "", category: issue?.category || "maintenance",
    severity: issue?.severity || "medium", placeId: issue?.placeId || null, assetLabel: issue?.assetLabel || "",
    dueAt: issue?.dueAt ? toLocal(issue.dueAt) : "", assigneeId: issue?.assigneeId || null,
  }));
  const [assignee, setAssignee] = useState(() => (issue?.assigneeId ? { kind: "user", id: issue.assigneeId, name: issue.assigneeName } : null));
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = { ...form, dueAt: fromLocalInput(form.dueAt), assetLabel: form.assetLabel || null };
    if (!t.can("issues.assign")) delete body.assigneeId;
    try {
      let saved;
      if (editing) {
        saved = await t.api.updateIssue(issue.id, body);
        toast.success("Issue saved");
      } else {
        saved = await t.api.createIssue(body);
        for (const file of photos) {
          const fd = new FormData();
          fd.append("kind", "photo");
          fd.append("file", file);
          await t.api.uploadIssueFile(saved.id, fd);
        }
        toast.success(`${saved.code} reported`, { action: { label: "Open", onClick: () => navigate(t.link(`issues/${saved.id}`)) } });
      }
      onSaved?.(saved);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? `Change ${issue.code}` : "Report an issue"} icon="alert" onClose={onClose} width={620} dismissible={!busy}>
      <form className="form-grid tk-form" onSubmit={submit}>
        <FormField label="What is wrong" wide>
          <input value={form.title} maxLength={200} required placeholder="Walk-in freezer not cooling, scale showing wrong weight…" onChange={(e) => set("title", e.target.value)} />
        </FormField>
        <FormField label="Details" optional wide>
          <textarea rows={3} maxLength={2000} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </FormField>
        <FormField label="How serious">
          <select value={form.severity} onChange={(e) => set("severity", e.target.value)}>
            <option value="low">Low: when there is time</option><option value="medium">Medium: this week</option>
            <option value="high">High: today</option><option value="critical">Critical: stop and fix now</option>
          </select>
        </FormField>
        <CategorySelect value={form.category} onChange={(v) => set("category", v)} />
        <PlaceSelect value={form.placeId} onChange={(v) => set("placeId", v)} />
        <FormField label="Equipment / asset" optional hint="Walk-in freezer, scale 2, van KA-01-AB-1234">
          <input value={form.assetLabel} maxLength={120} onChange={(e) => set("assetLabel", e.target.value)} />
        </FormField>
        {t.can("issues.assign") && (
          <div className="field">
            <PeoplePicker label="Assign to (optional)" kind="user" value={assignee} onChange={(p) => { setAssignee(p); set("assigneeId", p ? p.id : null); }} />
          </div>
        )}
        <FormField label="Fix by" optional>
          <input type="datetime-local" value={form.dueAt} onChange={(e) => set("dueAt", e.target.value)} />
        </FormField>
        {!editing && (
          <div className="field-wide tk-photo-pick">
            <PhotoButton label={photos.length ? "Add another photo" : "Add a photo"} onUpload={async (file) => setPhotos((p) => [...p, file].slice(0, 6))} />
            {photos.length > 0 && <span className="muted small">{photos.length} photo{photos.length === 1 ? "" : "s"} ready</span>}
          </div>
        )}
        <ErrorMessage message={error} />
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button" disabled={busy}>{busy ? "Saving…" : editing ? "Save" : "Report issue"}</button>
        </div>
      </form>
    </Modal>
  );
}

// A project: blank, or from a template (milestones, task lists and tasks made for it).
export function ProjectFormDialog({ project, onClose, onSaved }) {
  const t = useTasks();
  const navigate = useNavigate();
  const editing = Boolean(project);
  const [templates, setTemplates] = useState([]);
  const [templateCode, setTemplateCode] = useState("");
  const [form, setForm] = useState(() => ({
    name: project?.name || "", description: project?.description || "", startOn: project?.startOn || todayText(), endOn: project?.endOn || "",
    placeId: project?.placeId || null, ownerId: project?.ownerId || t.userId, status: project?.status || "active",
  }));
  // Members and owner as { id, name }: the picker searches people on the server.
  const [members, setMembers] = useState(() => (project?.members || []).filter((m) => m.role !== "owner").map((m) => ({ id: m.userId, name: m.name })));
  const [owner, setOwner] = useState(() => ({ kind: "user", id: project?.ownerId || t.userId, name: project?.ownerName || t.ctx?.userName || "You" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const memberIds = members.map((m) => m.id);

  useEffect(() => {
    if (!editing) t.api.projectTemplates().then(setTemplates).catch(() => {});
  }, [t.api, editing]);
  const chosen = templates.find((x) => x.code === templateCode);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let saved;
      const body = { name: form.name, description: form.description || null, startOn: form.startOn || null, endOn: form.endOn || null, placeId: form.placeId };
      if (editing) {
        saved = await t.api.updateProject(project.id, { ...body, status: form.status });
        saved = await t.api.projectMembers(project.id, memberIds);
        toast.success("Project saved");
      } else {
        saved = await t.api.createProject({ ...body, templateCode: templateCode || undefined, memberIds, ownerId: form.ownerId });
        toast.success(`Project started: ${saved.name}`);
        navigate(t.link(`projects/${saved.id}`));
      }
      onSaved?.(saved);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? "Change project" : "New project"} icon="layers" onClose={onClose} width={680} dismissible={!busy}>
      <form className="form-grid tk-form" onSubmit={submit}>
        {!editing && (
          <FormField label="Start from" optional wide hint={chosen ? `${chosen.milestones.length} milestones, ${chosen.lists.length} task lists, ${chosen.taskCount} tasks, about ${chosen.days} days` : "A blank project, or a ready plan you can change"}>
            <select value={templateCode} onChange={(e) => { setTemplateCode(e.target.value); const x = templates.find((y) => y.code === e.target.value); if (x && !form.name) set("name", x.name); }}>
              <option value="">Blank project</option>
              {templates.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
          </FormField>
        )}
        <FormField label="Project name" wide>
          <input value={form.name} maxLength={120} required onChange={(e) => set("name", e.target.value)} />
        </FormField>
        <FormField label="What it is for" optional wide>
          <textarea rows={2} maxLength={2000} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </FormField>
        <FormField label="Starts" optional><input type="date" value={form.startOn} onChange={(e) => set("startOn", e.target.value)} /></FormField>
        <FormField label="Ends" optional hint={!editing && chosen ? "Left empty: from the plan's length" : undefined}><input type="date" value={form.endOn} onChange={(e) => set("endOn", e.target.value)} /></FormField>
        {editing && (
          <FormField label="Status">
            <select value={form.status} onChange={(e) => set("status", e.target.value)}>
              <option value="planning">Planning</option><option value="active">Active</option><option value="on_hold">On hold</option>
              <option value="completed">Completed</option><option value="cancelled">Cancelled</option>
            </select>
          </FormField>
        )}
        <PlaceSelect value={form.placeId} onChange={(v) => set("placeId", v)} />
        {!editing && t.can("projects.manage") && (
          <div className="field">
            <PeoplePicker label="Owner" kind="user" value={owner} clearable={false} onChange={(p) => { if (p) { setOwner(p); set("ownerId", p.id); } }} />
          </div>
        )}
        <fieldset className="field field-wide">
          <legend>Members</legend>
          {members.length > 0 && (
            <ul className="tk-chips">
              {members.map((member) => (
                <li key={member.id} className="tk-chip">{member.name || "Member"}
                  <button type="button" className="tk-chip-x" aria-label={`Remove ${member.name || "member"}`} onClick={() => setMembers((m) => m.filter((x) => x.id !== member.id))}><Icon name="x" size={12} /></button>
                </li>
              ))}
            </ul>
          )}
          <PeoplePicker aria-label="Add a member" placeholder="Add a member: type a name" kind="user" exclude={[...memberIds, form.ownerId]} clearOnSelect
            onChange={(p) => p && setMembers((m) => [...m, { id: p.id, name: p.name }])} />
        </fieldset>
        <ErrorMessage message={error} />
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button" disabled={busy}>{busy ? "Saving…" : editing ? "Save" : "Start project"}</button>
        </div>
      </form>
    </Modal>
  );
}
