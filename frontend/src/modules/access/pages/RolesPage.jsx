import { useCallback, useEffect, useMemo, useState } from "react";
import PageHeader from "../../../components/PageHeader";
import Modal from "../../../components/Modal";
import ConfirmDialog from "../../../components/ConfirmDialog";
import ActionMenu from "../../../components/ActionMenu";
import DataGrid from "../../../components/DataGrid/DataGrid";
import StatusBadge from "../../../components/StatusBadge";
import Icon from "../../../components/Icon";
import StatTile from "../../../components/StatTile";
import SectionCard from "../../../components/SectionCard";
import { EmptyState, ErrorMessage, SuccessMessage } from "../../../components/Feedback";
import {
  copyRole,
  createRole,
  deleteRole,
  listPermissions,
  listRoles,
  updateRole,
} from "../services/role.service";
import { getErrorMessage } from "../../../services/api";
import { count } from "../../../services/format";
import useAuth from "../../../hooks/useAuth";
import "../../../styles/access.css";

const EMPTY = { code: "", name: "", description: "", status: "active", permissions: [] };

// Module codes as a person would name the area.
const MODULE_LABELS = {
  billing: "Billing",
  crm: "Guests",
  discounts: "Discounts",
  expenses: "Expenses",
  inventory: "Inventory",
  kitchen: "Kitchen",
  menu: "Menu",
  operations: "Business day",
  orders: "Orders",
  payments: "Payments",
  purchasing: "Purchasing",
  reports: "Reports",
  reservations: "Reservations",
  restaurant: "Restaurant",
  staff: "Staff",
  tables: "Tables",
  tasks: "Tasks, issues & projects",
  users: "Users & access",
};

// The permissions that decide whether money can leak: flagged in the picker
// so an owner trimming a Cashier copy sees what matters.
const SENSITIVE = new Set([
  "bills.void",
  "bills.refund",
  "bills.discount",
  "bills.complimentary",
  "bills.reprint",
  "orders.cancel_after_kot",
  "business_day.close",
  "loyalty.adjust",
  "customers.credit",
  "staff.salaries",
  "sales.view",
  "users.manage",
  "roles.manage",
]);

const moduleLabel = (module) => MODULE_LABELS[module] || module.charAt(0).toUpperCase() + module.slice(1);

export default function RolesPage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission("roles.manage");
  const canMoveUsers = hasPermission("users.manage");

  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [copying, setCopying] = useState(null);
  const [copyForm, setCopyForm] = useState({ name: "", description: "", moveUsers: false });
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const mine = useMemo(() => new Set(user.permissions), [user.permissions]);

  // `loading` starts true, so nothing is set synchronously while the effect runs.
  const load = useCallback(
    () =>
      Promise.all([listRoles(), listPermissions()])
        .then(([roleRows, permissionRows]) => {
          setRoles(roleRows);
          // The platform-only permission is never assignable inside a restaurant.
          setPermissions(permissionRows.filter((p) => p.code !== "platform.restaurants.manage"));
          return roleRows;
        })
        .catch((err) => {
          setError(getErrorMessage(err));
          return [];
        })
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  // Grouped by area so the list is readable.
  const grouped = useMemo(() => {
    const map = new Map();

    permissions.forEach((permission) => {
      const list = map.get(permission.module) || [];
      list.push(permission);
      map.set(permission.module, list);
    });

    return Array.from(map.entries()).sort((a, b) => moduleLabel(a[0]).localeCompare(moduleLabel(b[0])));
  }, [permissions]);

  const openNew = () => {
    setForm(EMPTY);
    setFormError("");
    setEditing({});
  };

  const openEdit = (role) => {
    setForm({
      code: role.code,
      name: role.name,
      description: role.description || "",
      status: role.status,
      permissions: role.permissions,
    });
    setFormError("");
    setEditing(role);
  };

  const openCopy = (role) => {
    setCopyForm({
      name: `${role.name} (our version)`,
      description: role.description || `Our own version of ${role.name}`,
      moveUsers: false,
    });
    setFormError("");
    setCopying(role);
  };

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const togglePermission = (code) =>
    setForm({
      ...form,
      permissions: form.permissions.includes(code)
        ? form.permissions.filter((item) => item !== code)
        : [...form.permissions, code],
    });

  // Only permissions you hold can be switched on; any can be switched off.
  const toggleModule = (modulePermissions) => {
    const codes = modulePermissions.map((permission) => permission.code).filter((code) => mine.has(code));
    const allSelected = codes.every((code) => form.permissions.includes(code));

    setForm({
      ...form,
      permissions: allSelected
        ? form.permissions.filter((code) => !codes.includes(code))
        : [...new Set([...form.permissions, ...codes])],
    });
  };

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      if (editing.id) {
        await updateRole(editing.id, {
          name: form.name,
          description: form.description,
          status: form.status,
          permissions: form.permissions,
        });
        setSuccess(`${form.name} updated`);
      } else {
        await createRole({
          code: form.code,
          name: form.name,
          description: form.description,
          permissions: form.permissions,
        });
        setSuccess(`${form.name} created`);
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const submitCopy = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      const result = await copyRole(copying.id, {
        name: copyForm.name.trim(),
        description: copyForm.description.trim() || undefined,
        moveUsers: copyForm.moveUsers,
      });

      setCopying(null);
      setSuccess(`${result.message}. Untick what this role should not do, then save.`);

      // Straight into the copy, because trimming it is why it was made.
      const rows = await load();
      const created = rows.find((role) => role.id === result.data.id);

      if (created) {
        openEdit(created);
      }
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteRole(deleting.id);
      setDeleting(null);
      setSuccess("Role deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const viewingGroups = viewing
    ? grouped
        .map(([module, list]) => [module, list.filter((permission) => viewing.permissions.includes(permission.code))])
        .filter(([, list]) => list.length > 0)
    : [];

  const viewingSensitive = viewing ? viewing.permissions.filter((code) => SENSITIVE.has(code)).length : 0;

  // The figures above the list: what is fixed, what is the restaurant's own,
  // and the role most people hold.
  const builtIn = roles.filter((role) => role.isSystem);
  const own = roles.filter((role) => !role.isSystem);
  const busiest = roles.reduce((best, role) => (!best || role.userCount > best.userCount ? role : best), null);
  const allPermissions = permissions.length;

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew}>
      <Icon name="plus" size={16} /> Add role
    </button>
  );

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="key"
        title="Roles & permissions"
        description="What each job is allowed to do. Built-in roles are fixed — copy one to make your own version, then trim it."
        action={addButton}
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!loading && roles.length > 0 && (
        <div className="stat-grid">
          <StatTile
            icon="lock"
            tone="neutral"
            label="Built-in roles"
            value={count(builtIn.length)}
            note="shared by every restaurant · fixed"
          />
          <StatTile
            icon="edit"
            tone={own.length ? "success" : "neutral"}
            label="Your own roles"
            value={count(own.length)}
            note={own.length ? "made for this restaurant" : "none yet — copy a built-in role"}
          />
          {busiest && busiest.userCount > 0 && (
            <StatTile
              icon="users"
              tone="info"
              label="Most used"
              value={busiest.name}
              note={`${count(busiest.userCount)} ${busiest.userCount === 1 ? "person has" : "people have"} it`}
              className="acc-tile-text"
            />
          )}
        </div>
      )}

      <SectionCard
        icon="list"
        title="Roles"
        description="Permissions shows exactly what a role can open and do. Copy, edit and delete are in the ⋯ menu."
        actions={
          !loading &&
          roles.length > 0 && (
            <span className="acc-count">
              {count(roles.length)} {roles.length === 1 ? "role" : "roles"}
            </span>
          )
        }
        flush
      >
        <DataGrid
          id="roles"
          caption="Roles"
          columns={[
            {
              key: "name",
              header: "Role",
              value: (role) => role.name,
              mobile: "title",
              pin: true,
              csv: (role) => `${role.name} (${role.code})`,
              render: (role) => (
                <div className="acc-who">
                  <span className={`acc-role-mark ${role.isSystem ? "tone-neutral" : "tone-primary"}`} aria-hidden="true">
                    <Icon name={role.isSystem ? "lock" : "key"} size={16} />
                  </span>
                  <span className="acc-who-text">
                    <strong>
                      {role.name} <span className="mono muted small acc-role-code">{role.code}</span>
                    </strong>
                    {role.description && <span className="muted small">{role.description}</span>}
                  </span>
                </div>
              ),
            },
            {
              key: "type",
              header: "Type",
              value: (role) => (role.isSystem ? "Built-in" : "Your own"),
              mobile: "subtitle",
              render: (role) =>
                role.isSystem ? <span className="badge badge-neutral">Built-in</span> : <span className="badge badge-primary">Your own</span>,
            },
            {
              key: "permissions",
              header: "Permissions",
              type: "number",
              align: "left",
              value: (role) => role.permissions.length,
              mobile: "show",
              render: (role) => (
                <span className="acc-meter-line">
                  <strong>{role.permissions.length}</strong>
                  {allPermissions > 0 && (
                    <span className="acc-meter" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, (role.permissions.length / allPermissions) * 100)}%` }} />
                    </span>
                  )}
                </span>
              ),
            },
            { key: "people", header: "People", type: "number", value: (role) => role.userCount, mobile: "show" },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (role) => role.status,
              mobile: "show",
              render: (role) => <StatusBadge status={role.status} />,
            },
            {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (role) => (
                <div className="row-actions">
                  {/* Seeing what a role can do is the everyday reason to
                      come here; changing or removing one is not, and
                      Delete should not sit beside Edit. */}
                  <button type="button" className="chip-button" onClick={() => setViewing(role)}>
                    <Icon name="eye" size={14} /> Permissions
                  </button>

                  {canManage && role.code !== "SUPER_ADMIN" && (
                    <ActionMenu
                      label={`More actions for the ${role.name} role`}
                      items={[
                        ...(role.isSystem ? [] : [{ label: "Edit role", icon: "edit", onClick: () => openEdit(role) }]),
                        { label: "Copy role", icon: "copy", onClick: () => openCopy(role) },
                        ...(role.isSystem
                          ? []
                          : [
                              { separator: true },
                              { label: "Delete role", icon: "trash", danger: true, onClick: () => setDeleting(role) },
                            ]),
                      ]}
                    />
                  )}
                </div>
              ),
            },
          ]}
          rows={roles}
          rowKey={(role) => role.id}
          loading={loading}
          empty="No roles found"
          emptyIcon="key"
          emptyHint="The built-in roles should always be here. Reload the page; if they are still missing, the sign-in service needs a look."
          rowClassName={(role) => (role.status === "active" ? "" : "dg-tone-muted")}
          exportName="roles"
        />
      </SectionCard>

      {viewing && (
        <Modal
          title={`${viewing.name} — what it can do`}
          description={
            viewing.isSystem
              ? `A built-in role shared by every restaurant, so it cannot be changed here.${
                  canManage ? " Use Copy role to make your own version and trim it." : ""
                }`
              : viewing.description || "Everything this role can open and do."
          }
          icon="shield"
          onClose={() => setViewing(null)}
          width={680}
        >
          <div className="acc-perm-summary">
            <span>
              <strong>{count(viewing.permissions.length)}</strong> permissions
            </span>
            <span>
              <strong>{count(viewingGroups.length)}</strong> {viewingGroups.length === 1 ? "area" : "areas"}
            </span>
            {viewingSensitive > 0 && (
              <span className="acc-perm-summary-flag">
                <strong>{count(viewingSensitive)}</strong> touch money or control
              </span>
            )}
          </div>
          {viewingGroups.length === 0 ? (
            <EmptyState icon="lock" message="This role can do nothing yet" hint="Edit it and tick what it may do." />
          ) : (
            <div className="acc-perm-view">
              {viewingGroups.map(([module, list]) => (
                <div key={module} className="acc-perm-group">
                  <h3>
                    {moduleLabel(module)} <span className="acc-perm-group-count">{list.length}</span>
                  </h3>
                  <ul>
                    {list.map((permission) => (
                      <li key={permission.code}>
                        <Icon name="check" size={14} className="acc-perm-tick" />
                        <span>
                          {permission.name}
                          {SENSITIVE.has(permission.code) && <span className="acc-flag">money / control</span>}
                          {permission.enforced === false && <span className="acc-flag acc-flag-idle">not checked yet</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {copying && (
        <Modal
          title={`Copy ${copying.name}`}
          description={`Makes your own role with the same ${copying.permissions.length} permissions. You can then untick what it should not do — a cashier who bills but cannot void, say.`}
          icon="copy"
          onClose={() => setCopying(null)}
          width={500}
        >
          <form className="form-grid" onSubmit={submitCopy}>
            <ErrorMessage message={formError} />

            <label className="field field-wide">
              <span>Name of the copy</span>
              <input
                value={copyForm.name}
                onChange={(event) => setCopyForm({ ...copyForm, name: event.target.value })}
                required
                maxLength={100}
                autoFocus
              />
            </label>

            <label className="field field-wide">
              <span>Description</span>
              <input
                value={copyForm.description}
                onChange={(event) => setCopyForm({ ...copyForm, description: event.target.value })}
                maxLength={500}
              />
            </label>

            {canMoveUsers && copying.userCount > 0 && (
              <label className="checkbox field-wide acc-move-users">
                <input
                  type="checkbox"
                  checked={copyForm.moveUsers}
                  onChange={(event) => setCopyForm({ ...copyForm, moveUsers: event.target.checked })}
                />
                <span>
                  Move the {copying.userCount} {copying.userCount === 1 ? "person" : "people"} who have {copying.name}{" "}
                  onto the copy, so the changes apply to them
                </span>
              </label>
            )}

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setCopying(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Copying…" : "Copy role"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : "Add role"}
          description="Name the job, then tick what it may do. Greyed permissions are access you do not have yourself; “not checked yet” ones change nothing today."
          icon={editing.id ? "edit" : "plus"}
          onClose={() => setEditing(null)}
          width={760}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <p className="section-heading field-wide">The role</p>

            <label className="field">
              <span>Role name</span>
              <input value={form.name} onChange={change("name")} required autoFocus />
            </label>

            <label className="field">
              <span>Code</span>
              <input
                value={form.code}
                onChange={change("code")}
                required
                disabled={Boolean(editing.id)}
                placeholder="FLOOR_MANAGER"
              />
              <small className="muted">Fixed after creation</small>
            </label>

            <label className="field field-wide">
              <span>Description</span>
              <input value={form.description} onChange={change("description")} />
            </label>

            {editing.id && (
              <label className="field">
                <span>Status</span>
                <select value={form.status} onChange={change("status")}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
            )}

            <fieldset className="field field-wide acc-perm-picker">
              <legend>
                Permissions * <span className="acc-perm-selected">{form.permissions.length} selected</span>
              </legend>
              {grouped.map(([module, modulePermissions]) => {
                const on = modulePermissions.filter((permission) => form.permissions.includes(permission.code)).length;

                return (
                  <div className={`permission-group ${on > 0 ? "has-selected" : ""}`} key={module}>
                    <div className="permission-group-head">
                      <strong>{moduleLabel(module)}</strong>
                      <span className="muted small acc-perm-of">
                        {on} of {modulePermissions.length}
                      </span>
                      <button type="button" className="link-button" onClick={() => toggleModule(modulePermissions)}>
                        Toggle all
                      </button>
                    </div>
                    <div className="checkbox-grid">
                      {modulePermissions.map((permission) => {
                        const checked = form.permissions.includes(permission.code);
                        const blocked = !mine.has(permission.code) && !checked;

                        return (
                          <label className={`checkbox ${blocked ? "acc-blocked" : ""}`} key={permission.code}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => togglePermission(permission.code)}
                              disabled={blocked}
                            />
                            <span>
                              {permission.name}
                              {SENSITIVE.has(permission.code) && <span className="acc-flag">money / control</span>}
                              {permission.enforced === false && (
                                <span
                                  className="acc-flag acc-flag-idle"
                                  title="No screen checks this yet, so giving it or taking it away changes nothing today. It takes effect when that screen is updated."
                                >
                                  not checked yet
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </fieldset>

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

      {deleting && (
        <ConfirmDialog
          title="Delete role"
          message={`Delete the role "${deleting.name}"? Nobody may still have it.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
