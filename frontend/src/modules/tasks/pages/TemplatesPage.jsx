import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import DataGrid from "../../../components/DataGrid/DataGrid";
import Modal from "../../../components/Modal";
import FormField from "../../../components/FormField";
import ActionMenu from "../../../components/ActionMenu";
import Icon from "../../../components/Icon";
import { ErrorMessage } from "../../../components/Feedback";
import { dateShort } from "../../../services/format";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useTasks from "./useTasks";
import ItemsEditor from "./ItemsEditor";
import ScheduleFormDialog from "./ScheduleForm";
import { CategorySelect, CategoryTag } from "./parts";
import { frequencyText, itemsForApi, rangeText, withKeys } from "./taskWords";

// The template library (built in, for this kind of business) and the
// business's own templates. Use one now, make it recurring, or copy it and
// change it. Categories: the owner's twelve plus food safety and health & safety.

function Preview({ template, onClose, onUse, onCopy, onRecurring }) {
  const t = useTasks();
  const numbers = template.items.reduce((list, item) => [...list, item.kind === "section" ? null : (list.filter((x) => x !== null).length + 1)], []);
  return (
    <Modal title={template.name} icon="clipboard" onClose={onClose} width={640} description={template.description || undefined}>
      <div className="stack">
        <div className="tk-card-meta">
          <CategoryTag code={template.category} />
          <span className="muted">{template.itemCount} checks</span>
          {template.suggested && <span className="muted"><Icon name="refresh" size={12} /> Usually {frequencyText({ ...template.suggested, dueTimes: template.suggested.times }).toLowerCase()}</span>}
          {template.requiresReview && <span className="tk-tag tone-warning">Reviewed by a manager</span>}
        </div>
        <ol className="tk-preview">
          {template.items.map((i, index) => {
            if (i.kind === "section") return <li key={index} className="tk-preview-section">{i.label}</li>;
            const n = numbers[index];
            const range = i.kind === "number" ? rangeText({ minValue: i.minValue ?? i.min_value ?? null, maxValue: i.maxValue ?? i.max_value ?? null, unit: i.unit }) : "";
            return (
              <li key={index}>
                <span className="tk-preview-no">{n}</span>
                <span>{i.label}{!i.required && <span className="muted"> (optional)</span>}</span>
                <span className="muted small">
                  {{ checkbox: "Tick", yes_no: `Yes / No${i.expected === "no" ? " (No passes)" : ""}`, number: `Reading${range ? `: OK ${range}` : ""}`, text: "Text", photo: "Photo", signature: "Signature",
                    choice: `Choice: ${(i.options || []).map((o) => o.label + (o.fail ? " ✕" : "")).join(", ")}` }[i.kind]}
                  {(i.photoRequired || i.photo_required) && " · photo"}{i.critical && " · critical"}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="form-actions">
          {t.can("tasks.manage") && onCopy && <button type="button" className="button button-secondary" onClick={onCopy}>Copy and edit</button>}
          {t.can("tasks.assign") && <button type="button" className="button button-secondary" onClick={onRecurring}>Make it recurring</button>}
          {t.can("tasks.create") && <button type="button" className="button" onClick={onUse}>Use now</button>}
        </div>
      </div>
    </Modal>
  );
}

function Editor({ template, onClose, onSaved }) {
  const t = useTasks();
  const [form, setForm] = useState(() => ({ name: template?.name || "", description: template?.description || "", category: template?.category || "day_to_day",
    priority: template?.priority || "normal", requiresReview: template?.requiresReview || false, estimatedMinutes: template?.estimatedMinutes || "" }));
  const [items, setItems] = useState(() => withKeys(template?.items || []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { ...form, estimatedMinutes: form.estimatedMinutes === "" ? null : Number(form.estimatedMinutes), items: itemsForApi(items) };
      const saved = template?.id ? await t.api.updateTemplate(template.id, { ...body, active: template.active }) : await t.api.createTemplate(body);
      toast.success(`Template saved: ${saved.name}`);
      onSaved(saved);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={template?.id ? "Change template" : "New template"} icon="clipboard" onClose={onClose} width={860} dismissible={!busy}>
      <form className="form-grid tk-form" onSubmit={submit}>
        <FormField label="Name" wide><input value={form.name} maxLength={120} required onChange={(e) => set("name", e.target.value)} /></FormField>
        <FormField label="What it is for" optional wide><textarea rows={2} maxLength={1000} value={form.description} onChange={(e) => set("description", e.target.value)} /></FormField>
        <CategorySelect value={form.category} onChange={(v) => set("category", v)} />
        <FormField label="Priority">
          <select value={form.priority} onChange={(e) => set("priority", e.target.value)}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </FormField>
        <FormField label="Minutes it takes" optional><input type="number" min={1} max={1440} value={form.estimatedMinutes} onChange={(e) => set("estimatedMinutes", e.target.value)} /></FormField>
        <label className="field tk-inline"><input type="checkbox" checked={form.requiresReview} onChange={(e) => set("requiresReview", e.target.checked)} /> A manager reviews it when done</label>
        <div className="field-wide"><h3 className="tk-sub">Checklist</h3><ItemsEditor items={items} onChange={setItems} /></div>
        <ErrorMessage message={error} />
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button" disabled={busy}>{busy ? "Saving…" : "Save template"}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function TemplatesPage() {
  const t = useTasks();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "library";
  const [category, setCategory] = useState("");
  const [library, setLibrary] = useState(null);
  const [own, setOwn] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);

  const load = useCallback(() => Promise.all([t.api.library(), t.api.templates({ all: 1 })])
    .then(([lib, mine]) => { setLibrary(lib); setOwn(mine); setError(""); }).catch((err) => setError(getErrorMessage(err))), [t.api]);
  useEffect(() => { load(); }, [load]);

  const open = async (row) => {
    try {
      const full = row.source === "own" ? await t.api.template(row.id) : await t.api.libraryOne(row.code);
      setDialog({ kind: "preview", template: { ...row, ...full } });
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const startFrom = async (template) => {
    try {
      const task = await t.api.createTask(template.source === "own" ? { templateId: template.id } : { libraryCode: template.code });
      toast.success(`Task created: ${task.title}`);
      navigate(t.link(`run/${task.id}`));
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const copy = async (template) => {
    try {
      const saved = await t.api.copyTemplate(template.source === "own" ? { templateId: template.id } : { libraryCode: template.code });
      await load();
      setParams({ tab: "own" }, { replace: true });
      setDialog({ kind: "edit", template: saved });
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const recurring = async (template) => {
    try {
      const full = template.items ? template : template.source === "own" ? await t.api.template(template.id) : await t.api.libraryOne(template.code);
      setDialog({ kind: "recurring", template: { ...template, ...full } });
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const actionsFor = (row) => [
    { label: "Preview", icon: "eye", onClick: () => open(row) },
    t.can("tasks.create") && { label: "Use now", icon: "check", onClick: () => startFrom(row) },
    t.can("tasks.assign") && { label: "Make it recurring", icon: "refresh", onClick: () => recurring(row) },
    t.can("tasks.manage") && { label: "Copy and edit", icon: "copy", onClick: () => copy(row) },
    t.can("tasks.manage") && row.source === "own" && { label: "Edit", icon: "edit", onClick: async () => setDialog({ kind: "edit", template: await t.api.template(row.id) }) },
    t.can("tasks.manage") && row.source === "own" && { label: row.active ? "Archive" : "Restore", icon: row.active ? "trash" : "undo",
      onClick: async () => { try { await t.api.templateActive(row.id, !row.active); toast.success(row.active ? "Archived" : "Restored"); load(); } catch (err) { toast.error(getErrorMessage(err)); } } },
  ].filter(Boolean);

  const rows = (tab === "library" ? library : own) || [];
  const filtered = rows.filter((r) => !category || r.category === category);
  const columns = [
    { key: "name", header: "Template", value: (r) => r.name, mobile: "title", minWidth: 240,
      render: (r) => <button type="button" className="tk-link-button tk-grid-title" onClick={() => open(r)}>{r.name}</button> },
    { key: "category", header: "Category", value: (r) => t.categoryName(r.category), render: (r) => <CategoryTag code={r.category} />, mobile: "subtitle" },
    { key: "items", header: "Checks", type: "number", value: (r) => r.itemCount },
    tab === "library"
      ? { key: "repeat", header: "Usually", value: (r) => (r.suggested ? frequencyText({ ...r.suggested, dueTimes: r.suggested.times }) : "When needed") }
      : { key: "used", header: "Recurring tasks using it", type: "number", value: (r) => r.usedBy },
    tab === "library"
      ? { key: "for", header: "For", value: (r) => (r.common ? "Every business" : "This kind of business") }
      : { key: "updated", header: "Changed", type: "date", value: (r) => r.updatedAt, render: (r) => `${dateShort(r.updatedAt)}${r.updatedByName ? ` · ${r.updatedByName}` : ""}` },
    ...(tab === "own" ? [{ key: "active", header: "State", type: "status", value: (r) => (r.active ? "active" : "archived") }] : []),
    { key: "actions", header: "", type: "actions", render: (r) => <ActionMenu items={actionsFor(r)} label={`Actions for ${r.name}`} /> },
  ];

  return (
    <div className="stack tk-page">
      <PageHeader title="Templates" icon="clipboard" description="Ready checklists for your kind of business, and your own. Use one now, repeat it, or copy and change it."
        primary={t.can("tasks.manage") && <button type="button" className="button" onClick={() => setDialog({ kind: "edit", template: null })}><Icon name="plus" size={16} /> New template</button>} />
      <ErrorMessage message={error} />
      <div className="segmented tk-status-filter" role="tablist" aria-label="Templates" data-motion-tabs>
        <button type="button" role="tab" aria-selected={tab === "library"} className={`segment ${tab === "library" ? "is-active" : ""}`} onClick={() => setParams({}, { replace: true })}>Library ({library?.length ?? "…"})</button>
        <button type="button" role="tab" aria-selected={tab === "own"} className={`segment ${tab === "own" ? "is-active" : ""}`} onClick={() => setParams({ tab: "own" }, { replace: true })}>Ours ({own?.length ?? "…"})</button>
      </div>
      <div className="tk-cat-chips" role="group" aria-label="Category">
        <button type="button" className={`tk-cat-chip ${!category ? "is-on" : ""}`} aria-pressed={!category} onClick={() => setCategory("")}>All</button>
        {t.categories.filter((c) => rows.some((r) => r.category === c.code)).map((c) => (
          <button key={c.code} type="button" className={`tk-cat-chip ${category === c.code ? "is-on" : ""}`} aria-pressed={category === c.code} onClick={() => setCategory(c.code)}>
            <Icon name={c.icon} size={13} /> {c.name} <span className="tk-count">{rows.filter((r) => r.category === c.code).length}</span>
          </button>
        ))}
      </div>
      <DataGrid key={tab} id={`tasks-templates-${tab}`} caption="Templates" columns={columns} rows={filtered} loading={!library && !error} rowKey={(r) => r.code || r.id}
        rowNoun={["template", "templates"]} exportName={tab === "library" ? "template-library" : "our-templates"} onRowClick={open}
        rowClassName={(r) => (r.active === false ? "dg-tone-muted" : "")}
        empty={tab === "own" ? "No templates of your own yet" : "No templates in this category"} emptyIcon="clipboard"
        emptyHint={tab === "own" ? "Copy one from the library and change it, or start a new one." : undefined} />
      {dialog?.kind === "preview" && (
        <Preview template={dialog.template} onClose={() => setDialog(null)} onUse={() => startFrom(dialog.template)}
          onCopy={() => copy(dialog.template)} onRecurring={() => recurring(dialog.template)} />
      )}
      {dialog?.kind === "edit" && <Editor template={dialog.template} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />}
      {dialog?.kind === "recurring" && <ScheduleFormDialog template={dialog.template} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); navigate(t.link("recurring")); }} />}
    </div>
  );
}
