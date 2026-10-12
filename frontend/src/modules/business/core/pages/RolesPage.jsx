import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "./FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useServerList } from "./hooks";

const ACTIONS = [["view", "See"], ["create", "Add"], ["edit", "Change"], ["approve", "Approve"], ["cancel", "Cancel"], ["refund", "Refund"], ["export", "Export"], ["print", "Print"], ["discount", "Discount"],
  // Tasks, issues & projects: assign to others, review / close, keep templates.
  ["assign", "Assign"], ["review", "Review"], ["manage", "Manage"],
  // Clinic (round 2): reading and writing clinical notes.
  ["view_clinical", "See clinical"], ["edit_clinical", "Write clinical"]];

// Roles of this business and what each may do: one row per module, one
// column per action. Every business has its own copies, so changing
// "Manager" here changes no other business.
export default function RolesPage() {
  const biz = useOpenBusiness();
  const list = useServerList("roles", { gridId: "business-roles" });
  const [catalogue, setCatalogue] = useState(null);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "permissions", undefined, controller.signal)
      .then(setCatalogue)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const editable = biz.can("access.edit");
  const columns = [
    { key: "name", header: "Role", value: (r) => r.name, mobile: "title", pin: true, render: (r) => <span className="bz-two-line"><strong>{r.name}</strong>{r.description && <small className="muted">{r.description}</small>}</span> },
    { key: "kind", header: "Kind", value: (r) => (r.full_access ? "Owner" : r.template_code ? "Standard" : "Your own"), render: (r) => <Badge tone={r.full_access ? "info" : r.template_code ? "neutral" : "active"} label={r.full_access ? "Everything" : r.template_code ? "Standard" : "Your own"} />, mobile: "subtitle" },
    { key: "people", header: "People", type: "number", value: (r) => r.member_count, mobile: "show" },
    { key: "permissions", header: "Permissions", type: "number", value: (r) => r.permission_count },
    { key: "active", header: "Status", type: "status", value: (r) => (r.active ? "active" : "inactive"), render: (r) => <ActiveBadge active={r.active} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <button type="button" className="chip-button" onClick={() => setEditing(r)}>{editable && !r.full_access ? "Edit" : "View"}</button> },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="shield" title="Roles & permissions"
        description="What each role may do in this business. What the business can use (its modules) is checked as well, so a permission for a module that is off does nothing."
        actions={editable && <button type="button" className="button" disabled={!catalogue} onClick={() => setEditing({})}><Icon name="plus" size={16} /> New role</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="list" title="Roles">
        <DataGrid {...list.gridProps} caption="Roles" columns={columns} rowNoun={["role", "roles"]} rowClassName={(r) => (!r.active ? "dg-tone-muted" : "")} empty="No roles" />
      </SectionCard>
      {editing && catalogue && <RoleDialog role={editing} catalogue={catalogue} readOnly={!editable || editing.full_access}
        onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); setNotice(`${r.name} saved.`); list.reload(); }} />}
    </div>
  );
}

function RoleDialog({ role, catalogue, readOnly, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(role.id);
  const all = catalogue.permissions.map((p) => p.code);
  const [form, setForm] = useState({ name: role.name || "", description: role.description || "", active: role.active ?? true });
  const [chosen, setChosen] = useState(() => new Set(role.full_access ? all : role.permissions || []));
  const mine = new Set(biz.context.role.full_access ? all : biz.context.permissions);
  const toggle = (code) => setChosen((set) => {
    const next = new Set(set);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const body = { ...form, permissions: [...chosen] };
  return (
    <FormDialog title={editing ? `${readOnly ? "" : "Edit "}${role.name}` : "New role"} icon="shield" width={980} onClose={onClose} onSaved={onSaved} hideSubmit={readOnly}
      description={role.full_access ? "The Owner role always has every permission, including any added later." : readOnly ? "You can see this role but not change it." : "Tick what this role may do. You can only give permissions you have yourself."}
      onSubmit={() => (editing ? businessWrite(biz.id, `roles/${role.id}`, body, "patch") : businessWrite(biz.id, "roles", body))}>
      <Field label="Name"><input required maxLength={80} disabled={readOnly} value={form.name} onChange={set("name")} /></Field>
      <Field label="What it is for"><input maxLength={300} disabled={readOnly} value={form.description} onChange={set("description")} /></Field>
      <div className="field-wide bz-matrix-wrap">
        <table className="bz-matrix">
          <caption className="sr-only">Permissions by module</caption>
          <thead>
            <tr><th scope="col">Module</th>{ACTIONS.map(([, label]) => <th key={label} scope="col">{label}</th>)}</tr>
          </thead>
          <tbody>
            {catalogue.modules.filter((m) => catalogue.permissions.some((p) => p.module_code === m.code)).map((m) => (
              <tr key={m.code} className={biz.has(m.code) ? "" : "is-off"}>
                <th scope="row">{m.name}{!biz.has(m.code) && <small className="muted"> · off</small>}</th>
                {ACTIONS.map(([action, label]) => {
                  const permission = catalogue.permissions.find((p) => p.module_code === m.code && p.action === action);
                  if (!permission) return <td key={action} className="bz-matrix-none" aria-hidden="true">·</td>;
                  return (
                    <td key={action}>
                      <input type="checkbox" checked={chosen.has(permission.code)} disabled={readOnly || !mine.has(permission.code)}
                        title={permission.name} aria-label={`${m.name}: ${label} — ${permission.name}`} onChange={() => toggle(permission.code)} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && !readOnly && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>}
    </FormDialog>
  );
}
