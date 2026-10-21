import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError } from "./ui";
import { dateTime, useOpenBusiness, useOptions, useServerList } from "./hooks";

// Who can open this business and with which role. One sign-in per person
// works across every business they are a member of.
export default function StaffAccessPage() {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const list = useServerList("members", { gridId: "business-members" });
  const [editing, setEditing] = useState(null);
  const [newLogin, setNewLogin] = useState(false);
  const [password, setPassword] = useState(null);
  const [notice, setNotice] = useState("");
  const editable = biz.can("access.edit");
  const branches = biz.allLocations.filter((l) => l.active).length > 1 || Boolean(biz.member.location_id);
  const columns = [
    { key: "name", header: "Person", value: (m) => m.name, mobile: "title", pin: true, render: (m) => <span className="bz-two-line"><strong>{m.name}{m.id === user.id ? " (you)" : ""}</strong><small className="muted">{m.email}</small></span> },
    { key: "role", header: "Role", value: (m) => m.role_name, render: (m) => (m.full_access ? <Badge tone="info" label="Owner" /> : m.role_name), mobile: "subtitle" },
    // Someone tied to a location bills, stocks and reports there only.
    branches && { key: "location", header: "Works at", value: (m) => m.location_name || "Every location",
      render: (m) => (m.location_name ? m.location_name : <span className="muted">Every location</span>) },
    // Someone tied to a department handles its products and stock only.
    { key: "department", header: "Department", value: (m) => m.department_name || "", defaultHidden: true,
      render: (m) => m.department_name || <span className="muted">All</span> },
    { key: "last", header: "Last opened", type: "datetime", value: (m) => m.last_opened_at, render: (m) => (String(m.id) === String(user.id) ? <span>Using it now</span> : m.last_opened_at ? dateTime(m.last_opened_at) : <span className="muted">Not yet</span>) },
    { key: "active", header: "Access", type: "status", value: (m) => (m.active ? "active" : "inactive"), render: (m) => <ActiveBadge active={m.active} />, mobile: "show" },
    editable && { key: "actions", header: "", label: "Actions", type: "actions", render: (m) => !m.full_access && m.id !== user.id && (
      <span className="bz-actions">
        <button type="button" className="chip-button" onClick={() => setEditing(m)}>Change</button>
        <button type="button" className="chip-button" onClick={() => setPassword(m)}>Password</button>
      </span>
    ) },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Staff & access"
        description="Who can open this business and what their role lets them do. Removing access takes effect on their next click."
        actions={editable && (
          <span className="bz-actions">
            <button type="button" className="button button-secondary" onClick={() => setNewLogin(true)}><Icon name="plus" size={16} /> New staff login</button>
            <button type="button" className="button" onClick={() => setEditing({})}><Icon name="user-plus" size={16} /> Give access</button>
          </span>
        )} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="People with access"
        actions={<Link className="button button-secondary button-sm" to={biz.path("roles")}>Roles & permissions</Link>}>
        <DataGrid {...list.gridProps} caption="People with access" columns={columns.filter(Boolean)} rowNoun={["person", "people"]}
          rowClassName={(m) => (!m.active ? "dg-tone-muted" : "")} empty="Nobody else has access yet" emptyIcon="users" />
      </SectionCard>
      {editing && <AccessDialog member={editing} onClose={() => setEditing(null)}
        onSaved={(m) => { setEditing(null); setNotice(`Access saved: ${m.role_name}${m.active ? "" : " (switched off)"}.`); list.reload(); }} />}
      {newLogin && <NewLoginDialog onClose={() => setNewLogin(false)}
        onSaved={(m) => { setNewLogin(false); setNotice(`${m.name} can now sign in with ${m.email} and the password you set (${m.role_name}).`); list.reload(); }} />}
      {password && <PasswordDialog member={password} onClose={() => setPassword(null)}
        onSaved={(m) => { setPassword(null); setNotice(`New password set for ${m.name}. Their open sessions have ended.`); }} />}
    </div>
  );
}

function AccessDialog({ member, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(member.id);
  const { options, error } = useOptions(["roles?active=true", ...(editing ? [] : ["member-candidates"])]);
  // A manager tied to a location gives access at that location only.
  const pinned = biz.member.location_id ? String(biz.member.location_id) : null;
  // A manager tied to a department gives access in that department only.
  const pinnedDepartment = biz.member.department_id ? String(biz.member.department_id) : null;
  const [form, setForm] = useState({ userId: member.id ? String(member.id) : "", roleId: member.role_id ? String(member.role_id) : "", active: member.active ?? true,
    workLocationId: pinned || (member.location_id ? String(member.location_id) : ""),
    workDepartmentId: pinnedDepartment || (member.department_id ? String(member.department_id) : "") });
  const [departments, setDepartments] = useState([]);
  useEffect(() => {
    if (!biz.has("inventory")) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "departments", undefined, controller.signal)
      .then((rows) => setDepartments(rows.filter((d) => d.active || String(d.id) === form.workDepartmentId))).catch(() => {});
    return () => controller.abort();
    // Loaded once for the dialog; the chosen department stays listed even when switched off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biz.id]);
  const places = biz.allLocations.filter((l) => l.active || String(l.id) === form.workLocationId);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const roles = (options?.["roles?active=true"] || []).filter((r) => !r.full_access);
  const chosen = roles.find((r) => String(r.id) === form.roleId);
  return (
    <FormDialog title={editing ? `Access for ${member.name}` : "Give someone access"} icon="user-plus" width={560} onClose={onClose} onSaved={onSaved} disabled={!options}
      description="People from your own staff list can be added. The Owner role is given only when a business is set up."
      onSubmit={() => businessWrite(biz.id, "members", { ...form, ...(departments.length || pinnedDepartment ? {} : { workDepartmentId: undefined }) })}>
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      {!editing && (
        <Field label="Person" wide>
          <select required value={form.userId} onChange={set("userId")}>
            <option value="">Choose…</option>
            {(options?.["member-candidates"] || []).map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
          </select>
          {options && !(options["member-candidates"] || []).length && <span className="muted small">Everyone on your staff list already has access here. Change a person's role from the list instead.</span>}
        </Field>
      )}
      <Field label="Role" wide>
        <select required value={form.roleId} onChange={set("roleId")}>
          <option value="">Choose…</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      {chosen?.description && <p className="field-wide muted small">{chosen.description}</p>}
      {(places.length > 1 || pinned) && (
        <Field label="Works at" wide hint="Tied to one location, they bill, move stock and see reports there only.">
          <select value={form.workLocationId} disabled={Boolean(pinned)} onChange={set("workLocationId")}>
            {!pinned && <option value="">Every location</option>}
            {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
      )}
      {(departments.length > 0 || pinnedDepartment) && (
        <Field label="Department" wide hint="Tied to one department, they see and change its products and stock only. Billing stays open to every item.">
          <select value={form.workDepartmentId} disabled={Boolean(pinnedDepartment)} onChange={set("workDepartmentId")}>
            {!pinnedDepartment && <option value="">All departments</option>}
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      )}
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Can open this business</label>}
    </FormDialog>
  );
}

// A login of their own for a member of staff (no restaurant needed): name,
// email and a first password, with their role and where they work.
function NewLoginDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["roles?active=true"]);
  const pinned = biz.member.location_id ? String(biz.member.location_id) : null;
  const [form, setForm] = useState({ name: "", email: "", mobile: "", password: "", roleId: "", workLocationId: pinned || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const roles = (options?.["roles?active=true"] || []).filter((r) => !r.full_access);
  const places = biz.allLocations.filter((l) => l.active);
  return (
    <FormDialog title="New staff login" icon="user-plus" width={600} onClose={onClose} onSaved={onSaved} disabled={!options} submitLabel="Create login"
      description="For someone who has no login yet. Tell them their email and this password; they can change it in My profile."
      onSubmit={() => businessWrite(biz.id, "staff-accounts", { ...form, name: form.name.trim(), email: form.email.trim(), mobile: form.mobile.trim() })}>
      <FormError message={error} />
      <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Email" hint="They sign in with it."><input type="email" required maxLength={150} value={form.email} onChange={set("email")} /></Field>
      <Field label="Mobile"><input maxLength={20} value={form.mobile} onChange={set("mobile")} /></Field>
      <Field label="First password" hint="8 to 72 characters."><input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={form.password} onChange={set("password")} /></Field>
      <Field label="Role" wide>
        <select required value={form.roleId} onChange={set("roleId")}>
          <option value="">Choose…</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      {(places.length > 1 || pinned) && (
        <Field label="Works at" wide>
          <select value={form.workLocationId} disabled={Boolean(pinned)} onChange={set("workLocationId")}>
            {!pinned && <option value="">Every location</option>}
            {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
      )}
    </FormDialog>
  );
}

// A new password for one of this business's staff (a login used only here).
function PasswordDialog({ member, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [password, setPasswordValue] = useState("");
  return (
    <FormDialog title={`New password for ${member.name}`} icon="key" width={480} onClose={onClose} onSaved={onSaved} submitLabel="Set password"
      description="Their open sessions end; they sign in again with this password."
      onSubmit={() => businessWrite(biz.id, `staff-accounts/${member.id}/password`, { password })}>
      <Field label="New password" wide><input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={password} onChange={(e) => setPasswordValue(e.target.value)} /></Field>
    </FormDialog>
  );
}
