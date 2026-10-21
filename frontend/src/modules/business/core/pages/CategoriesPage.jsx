import { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useOptions, useServerList } from "./hooks";

// The category tree: up to five levels, each name once under its parent.
export default function CategoriesPage() {
  const biz = useOpenBusiness();
  const list = useServerList("categories", { gridId: "business-categories" });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  // Departments (a department store's Clothing, Home…): top-level categories belong to one.
  const goods = biz.has("inventory");
  const [departments, setDepartments] = useState([]);
  const loadDepartments = useCallback((signal) => {
    if (!goods) return;
    businessRead(biz.id, "departments", undefined, signal).then(setDepartments).catch(() => {});
  }, [biz.id, goods]);
  useEffect(() => {
    const controller = new AbortController();
    loadDepartments(controller.signal);
    return () => controller.abort();
  }, [loadDepartments]);
  const departmentName = useCallback((id) => departments.find((d) => String(d.id) === String(id))?.name || "", [departments]);

  const columns = useMemo(() => [
    { key: "path", header: "Category", value: (c) => c.path, mobile: "title", pin: true,
      render: (c) => <span className="bz-tree" style={{ "--depth": c.depth - 1 }}>{c.depth > 1 && <span className="bz-tree-mark" aria-hidden="true">└</span>}<strong>{c.name}</strong></span> },
    { key: "parent", header: "Inside", value: (c) => c.parent_name || "", render: (c) => c.parent_name || <span className="muted">Top level</span>, mobile: "subtitle" },
    departments.length > 0 && { key: "department", header: "Department", value: (c) => departmentName(c.department_id), render: (c) => departmentName(c.department_id) || <span className="muted">—</span> },
    { key: "products", header: "Products", type: "number", value: (c) => c.product_count, total: "sum", mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (c) => (c.active ? "active" : "inactive"), render: (c) => <ActiveBadge active={c.active} /> },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => <button type="button" className="chip-button" onClick={() => setEditing(c)}>Edit</button> },
  ], [biz, departments.length, departmentName]);

  return (
    <div className="stack">
      <BusinessHeader icon="layers" title="Categories"
        description="Group products the way your shelves and reports are arranged — Staples › Rice › Basmati. Up to five levels."
        actions={biz.can("catalog.create") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add category</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      {goods && <DepartmentsCard departments={departments} onChanged={(text) => { setNotice(text); loadDepartments(); list.reload(); }} />}
      <SectionCard flush icon="list" title="Category tree">
        <DataGrid {...list.gridProps} caption="Categories" columns={columns.filter(Boolean)} rowNoun={["category", "categories"]}
          rowClassName={(c) => (!c.active ? "dg-tone-muted" : "")} exportName={biz.can("catalog.export") ? `${biz.business.code}-categories` : undefined}
          empty="No categories yet" emptyHint="Products without a category still sell; categories only help you find and report." emptyIcon="layers" />
      </SectionCard>
      {editing && <CategoryDialog category={editing} departments={departments.filter((d) => d.active)} onClose={() => setEditing(null)}
        onSaved={(c) => { setEditing(null); setNotice(`${c.name} saved.`); list.reload(); }} />}
    </div>
  );
}

function CategoryDialog({ category, departments, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(category.id);
  const { options } = useOptions(["categories"]);
  const [form, setForm] = useState({ name: category.name || "", parentId: category.parent_id ? String(category.parent_id) : "", sortOrder: String(category.sort_order ?? 0), active: category.active ?? true,
    departmentId: category.department_id ? String(category.department_id) : (biz.context.member?.department_id ? String(biz.context.member.department_id) : "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  // A category cannot sit inside itself or anything inside it.
  const parents = (options?.categories || []).filter((c) => c.active && c.id !== category.id && !(editing && c.path.startsWith(`${category.path} › `)));
  const body = { name: form.name, parentId: form.parentId || null, sortOrder: form.sortOrder || 0, active: form.active,
    ...(departments.length && !form.parentId ? { departmentId: form.departmentId || null } : {}) };
  return (
    <FormDialog title={editing ? `Edit ${category.name}` : "Add a category"} icon="layers" width={520} onClose={onClose} onSaved={onSaved}
      onSubmit={() => (editing ? businessWrite(biz.id, `categories/${category.id}`, body, "patch") : businessWrite(biz.id, "categories", body))}>
      <Field label="Name" wide><input required maxLength={100} value={form.name} onChange={set("name")} /></Field>
      <Field label="Inside" wide>
        <select value={form.parentId} onChange={set("parentId")}>
          <option value="">Top level</option>
          {parents.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
        </select>
      </Field>
      {departments.length > 0 && !form.parentId && (
        <Field label="Department" hint="Its sub-categories follow it.">
          <select value={form.departmentId} onChange={set("departmentId")} disabled={Boolean(biz.context.member?.department_id)}>
            <option value="">No department</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      )}
      {departments.length > 0 && form.parentId && <p className="field-wide muted small">A sub-category is in the department of the category it sits inside.</p>}
      <Field label="Order" hint="Lower numbers are listed first."><input type="number" min="0" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>}
    </FormDialog>
  );
}

// The store's departments: add, rename, switch off. Staff can be tied to one
// (Staff & access); reports show sales and margin by department.
function DepartmentsCard({ departments, onChanged }) {
  const biz = useOpenBusiness();
  const canEdit = biz.can("settings.edit");
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (work, text) => {
    setBusy(true); setError("");
    try { await work(); onChanged(text); setName(""); setRenaming(null); }
    catch (err) { setError(getErrorMessage(err)); }
    finally { setBusy(false); }
  };
  if (!canEdit && !departments.length) return null;
  return (
    <SectionCard icon="grid" title="Departments" description="For a store with departments (Clothing, Home, Grocery…). A top-level category belongs to one; staff can be tied to one in Staff & access.">
      <ErrorMessage message={error} />
      {departments.length > 0 && (
        <ul className="bz-departments">
          {departments.map((d) => (
            <li key={d.id} className={d.active ? "" : "is-off"}>
              {renaming?.id === d.id ? (
                <span className="rt-inline">
                  <input aria-label={`New name for ${d.name}`} maxLength={80} value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                  <button type="button" className="button button-sm" disabled={busy || !renaming.name.trim()}
                    onClick={() => run(() => businessWrite(biz.id, `departments/${d.id}`, { name: renaming.name.trim(), active: d.active }, "patch"), `${renaming.name.trim()} saved.`)}>Save</button>
                  <button type="button" className="link-button" onClick={() => setRenaming(null)}>Cancel</button>
                </span>
              ) : (
                <>
                  <strong>{d.name}</strong>
                  <span className="muted small">{d.category_count} {d.category_count === 1 ? "category" : "categories"} · {d.staff_count} staff{d.active ? "" : " · switched off"}</span>
                  {canEdit && (
                    <span className="bz-row-actions">
                      <button type="button" className="chip-button" onClick={() => setRenaming({ id: d.id, name: d.name })}>Rename</button>
                      <button type="button" className="chip-button" disabled={busy}
                        onClick={() => run(() => businessWrite(biz.id, `departments/${d.id}`, { name: d.name, active: !d.active }, "patch"), `${d.name} ${d.active ? "switched off" : "switched on"}.`)}>{d.active ? "Switch off" : "Switch on"}</button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form className="rt-inline" onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(() => businessWrite(biz.id, "departments", { name: name.trim() }), `${name.trim()} added.`); }}>
          <input aria-label="New department" placeholder="e.g. Clothing" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="button button-secondary button-sm" disabled={busy || !name.trim()}><Icon name="plus" size={14} /> Add department</button>
        </form>
      )}
    </SectionCard>
  );
}
