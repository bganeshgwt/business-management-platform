import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "../../../../components/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "../services/menu.service";
import { getErrorMessage } from "../../../../services/api";
import { count } from "../../../../services/format";
import useAuth from "../../../../hooks/useAuth";
import "../../../../styles/menu.css";

const EMPTY = { name: "", description: "", sortOrder: 0, status: "active" };

export default function CategoriesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("menu.manage");

  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  // A category still holding dishes cannot be deleted (the server refuses),
  // so Delete explains that up front and offers what does work: hiding it.
  const [blocked, setBlocked] = useState(null);

  // `loading` starts true, so nothing is set synchronously while the effect runs.
  const load = useCallback(
    () =>
      listCategories()
        .then(setCategories)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    // New categories go to the end of the menu by default.
    setForm({ ...EMPTY, sortOrder: categories.length + 1 });
    setFormError("");
    setEditing({});
  };

  const openEdit = (category) => {
    setForm({
      name: category.name,
      description: category.description || "",
      sortOrder: category.sortOrder,
      status: category.status,
    });
    setFormError("");
    setEditing(category);
  };

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  // An edit sends only the fields that were changed in the form, so a change
  // made elsewhere meanwhile (switching the category off) is not put back.
  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      ...form,
      name: form.name.trim(),
      description: form.description.trim() || null,
      sortOrder: Number(form.sortOrder),
    };

    try {
      if (editing.id) {
        const was = { ...editing, description: editing.description || null };
        const changed = Object.fromEntries(
          ["name", "description", "sortOrder", "status"]
            .filter((key) => payload[key] !== was[key])
            .map((key) => [key, payload[key]])
        );

        if (Object.keys(changed).length > 0) {
          await updateCategory(editing.id, changed);
        }

        setSuccess(Object.keys(changed).length > 0 ? "Category updated" : `Nothing changed on "${editing.name}"`);
      } else {
        await createCategory(payload);
        setSuccess("Category created");
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteCategory(deleting.id);
      setDeleting(null);
      setSuccess("Category deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const startDelete = (category) => {
    setError("");

    if (Number(category.productCount) > 0) {
      setBlocked(category);
    } else {
      setDeleting(category);
    }
  };

  // Hiding sends only the status, like the form does for a status change.
  const hideInstead = async () => {
    const category = blocked;
    setBlocked(null);
    setError("");

    try {
      await updateCategory(category.id, { status: "inactive" });
      setSuccess(`"${category.name}" hidden. Its dishes are off the menu, and kept.`);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const shownCount = categories.filter((category) => category.status === "active").length;
  const dishCount = categories.reduce((sum, category) => sum + Number(category.productCount || 0), 0);

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew}>
      <Icon name="plus" size={16} /> Add category
    </button>
  );

  return (
    <div className="stack mnu-page">
      <PageHeader
        icon="grid"
        title="Menu categories"
        description="The groups your menu is split into, in the order guests and staff see them."
        action={addButton}
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!loading && categories.length > 0 && (
        <div className="stat-grid mnu-tiles">
          <StatTile icon="grid" tone="primary" label="On the menu" value={count(shownCount)} note="categories shown" />
          <StatTile
            icon="eye-off"
            tone="neutral"
            label="Hidden"
            value={count(categories.length - shownCount)}
            note="kept, but off the menu"
          />
          <StatTile icon="utensils" tone="info" label="Dishes" value={count(dishCount)} note="across every category" />
        </div>
      )}

      <SectionCard
        icon="list"
        title="Menu order"
        description="The POS and the QR menu list categories from the lowest number up. A hidden category takes its dishes off the menu without deleting them."
        className="mnu-list"
        flush
      >
        <DataGrid
          id="menu-categories"
          caption="Menu categories"
          columns={[
            {
              key: "order",
              header: "Order",
              type: "number",
              value: (category) => Number(category.sortOrder),
              mobile: "show",
              width: 120,
              render: (category) => <span className="mnu-order">{category.sortOrder}</span>,
            },
            { key: "name", header: "Name", value: (category) => category.name, mobile: "title", pin: true, filter: "text" },
            {
              key: "description",
              header: "Description",
              value: (category) => category.description,
              filter: "text",
              mobile: "show",
              minWidth: 160,
            },
            {
              key: "dishes",
              header: "Dishes",
              type: "number",
              value: (category) => Number(category.productCount || 0),
              total: "sum",
              mobile: "show",
            },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (category) => category.status,
              filter: "select",
              filterOptions: [
                { value: "active", label: "On the menu" },
                { value: "inactive", label: "Hidden" },
              ],
              csv: (category) => (category.status === "active" ? "On the menu" : "Hidden"),
              mobile: "subtitle",
              // Hidden is a choice, not a fault: grey, in the tile's own word.
              render: (category) => (
                <span className={`badge status-badge ${category.status === "active" ? "badge-active" : "badge-neutral"}`}>
                  <span className="badge-dot" aria-hidden="true" />
                  {category.status === "active" ? "On the menu" : "Hidden"}
                </span>
              ),
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              // Edit is the everyday one; Delete sits behind the menu, away from it.
              render: (category) => (
                <div className="row-actions">
                  <button type="button" className="chip-button" onClick={() => openEdit(category)}>
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  <ActionMenu
                    label={`More actions for ${category.name}`}
                    items={[{ label: "Delete", icon: "trash", danger: true, onClick: () => startDelete(category) }]}
                  />
                </div>
              ),
            },
          ]}
          rows={categories}
          rowKey={(category) => category.id}
          loading={loading}
          empty="No categories yet"
          emptyIcon="grid"
          emptyHint="Every dish belongs to a category. Start with the sections of your printed menu: Starters, Main Course, Breads, Desserts."
          emptyAction={addButton}
          rowClassName={(category) => (category.status === "active" ? "" : "dg-tone-muted")}
          defaultSort={{ key: "order", direction: "asc" }}
          rowNoun={["category", "categories"]}
          search="Category name"
          exportName="menu-categories"
        />
      </SectionCard>

      {editing && (
        <Modal
          title={editing.id ? "Edit category" : "Add category"}
          description="A group of dishes on the POS and the QR menu."
          icon={editing.id ? "edit" : "plus"}
          onClose={() => setEditing(null)}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <label className="field">
              <span>Name *</span>
              <input value={form.name} onChange={change("name")} required autoFocus maxLength={100} placeholder="Starters" />
            </label>

            <label className="field">
              <span>Display order</span>
              <input
                type="number"
                min="0"
                value={form.sortOrder}
                onChange={change("sortOrder")}
              />
              <small className="muted">Lower numbers come first</small>
            </label>

            <label className="field field-wide">
              <span>Description</span>
              <input value={form.description} onChange={change("description")} />
            </label>

            <label className="field field-wide">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">On the menu</option>
                <option value="inactive">Hidden (its dishes are off the menu, and kept)</option>
              </select>
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {blocked && (
        <Modal title={`Can’t delete “${blocked.name}” yet`} icon="ban" onClose={() => setBlocked(null)} width={480}>
          <p>
            It still holds {count(blocked.productCount)} {Number(blocked.productCount) === 1 ? "dish" : "dishes"}, archived
            ones included. Move {Number(blocked.productCount) === 1 ? "it" : "them"} to another category on the Products
            page, or delete {Number(blocked.productCount) === 1 ? "it" : "them"}, and the category can go.
          </p>
          {blocked.status === "active" && (
            <p className="muted small">To take it off the menu now, hide it: its dishes are kept and can come back.</p>
          )}
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={() => setBlocked(null)}>
              {blocked.status === "active" ? "Keep it" : "OK"}
            </button>
            {blocked.status === "active" && (
              <button type="button" className="button" onClick={hideInstead}>
                Hide “{blocked.name}”
              </button>
            )}
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete category"
          message={`Delete "${deleting.name}"? It has no dishes, so nothing else needs it.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
