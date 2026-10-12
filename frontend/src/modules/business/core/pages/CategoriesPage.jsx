import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useOptions, useServerList } from "./hooks";

// The category tree: up to five levels, each name once under its parent.
export default function CategoriesPage() {
  const biz = useOpenBusiness();
  const list = useServerList("categories", { gridId: "business-categories" });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");

  const columns = useMemo(() => [
    { key: "path", header: "Category", value: (c) => c.path, mobile: "title", pin: true,
      render: (c) => <span className="bz-tree" style={{ "--depth": c.depth - 1 }}>{c.depth > 1 && <span className="bz-tree-mark" aria-hidden="true">└</span>}<strong>{c.name}</strong></span> },
    { key: "parent", header: "Inside", value: (c) => c.parent_name || "", render: (c) => c.parent_name || <span className="muted">Top level</span>, mobile: "subtitle" },
    { key: "products", header: "Products", type: "number", value: (c) => c.product_count, total: "sum", mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (c) => (c.active ? "active" : "inactive"), render: (c) => <ActiveBadge active={c.active} /> },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => <button type="button" className="chip-button" onClick={() => setEditing(c)}>Edit</button> },
  ], [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="layers" title="Categories"
        description="Group products the way your shelves and reports are arranged — Staples › Rice › Basmati. Up to five levels."
        actions={biz.can("catalog.create") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add category</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Category tree">
        <DataGrid {...list.gridProps} caption="Categories" columns={columns.filter(Boolean)} rowNoun={["category", "categories"]}
          rowClassName={(c) => (!c.active ? "dg-tone-muted" : "")} exportName={biz.can("catalog.export") ? `${biz.business.code}-categories` : undefined}
          empty="No categories yet" emptyHint="Products without a category still sell; categories only help you find and report." emptyIcon="layers" />
      </SectionCard>
      {editing && <CategoryDialog category={editing} onClose={() => setEditing(null)}
        onSaved={(c) => { setEditing(null); setNotice(`${c.name} saved.`); list.reload(); }} />}
    </div>
  );
}

function CategoryDialog({ category, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(category.id);
  const { options } = useOptions(["categories"]);
  const [form, setForm] = useState({ name: category.name || "", parentId: category.parent_id ? String(category.parent_id) : "", sortOrder: String(category.sort_order ?? 0), active: category.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  // A category cannot sit inside itself or anything inside it.
  const parents = (options?.categories || []).filter((c) => c.active && c.id !== category.id && !(editing && c.path.startsWith(`${category.path} › `)));
  const body = { name: form.name, parentId: form.parentId || null, sortOrder: form.sortOrder || 0, active: form.active };
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
      <Field label="Order" hint="Lower numbers are listed first."><input type="number" min="0" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>}
    </FormDialog>
  );
}
