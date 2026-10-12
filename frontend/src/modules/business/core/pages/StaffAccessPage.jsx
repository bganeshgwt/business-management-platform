import { useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import { businessWrite } from "../../../../services/business.service";
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
  const [notice, setNotice] = useState("");
  const editable = biz.can("access.edit");
  const columns = [
    { key: "name", header: "Person", value: (m) => m.name, mobile: "title", pin: true, render: (m) => <span className="bz-two-line"><strong>{m.name}{m.id === user.id ? " (you)" : ""}</strong><small className="muted">{m.email}</small></span> },
    { key: "role", header: "Role", value: (m) => m.role_name, render: (m) => (m.full_access ? <Badge tone="info" label="Owner" /> : m.role_name), mobile: "subtitle" },
    { key: "last", header: "Last opened", type: "datetime", value: (m) => m.last_opened_at, render: (m) => (String(m.id) === String(user.id) ? <span>Using it now</span> : m.last_opened_at ? dateTime(m.last_opened_at) : <span className="muted">Not yet</span>) },
    { key: "active", header: "Access", type: "status", value: (m) => (m.active ? "active" : "inactive"), render: (m) => <ActiveBadge active={m.active} />, mobile: "show" },
    editable && { key: "actions", header: "", label: "Actions", type: "actions", render: (m) => !m.full_access && m.id !== user.id && <button type="button" className="chip-button" onClick={() => setEditing(m)}>Change</button> },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Staff & access"
        description="Who can open this business and what their role lets them do. Removing access takes effect on their next click."
        actions={editable && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="user-plus" size={16} /> Give access</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="People with access"
        actions={<Link className="button button-secondary button-sm" to={biz.path("roles")}>Roles & permissions</Link>}>
        <DataGrid {...list.gridProps} caption="People with access" columns={columns.filter(Boolean)} rowNoun={["person", "people"]}
          rowClassName={(m) => (!m.active ? "dg-tone-muted" : "")} empty="Nobody else has access yet" emptyIcon="users" />
      </SectionCard>
      {editing && <AccessDialog member={editing} onClose={() => setEditing(null)}
        onSaved={(m) => { setEditing(null); setNotice(`Access saved: ${m.role_name}${m.active ? "" : " (switched off)"}.`); list.reload(); }} />}
    </div>
  );
}

function AccessDialog({ member, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(member.id);
  const { options, error } = useOptions(["roles?active=true", ...(editing ? [] : ["member-candidates"])]);
  const [form, setForm] = useState({ userId: member.id ? String(member.id) : "", roleId: member.role_id ? String(member.role_id) : "", active: member.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const roles = (options?.["roles?active=true"] || []).filter((r) => !r.full_access);
  const chosen = roles.find((r) => String(r.id) === form.roleId);
  return (
    <FormDialog title={editing ? `Access for ${member.name}` : "Give someone access"} icon="user-plus" width={560} onClose={onClose} onSaved={onSaved} disabled={!options}
      description="People from your own staff list can be added. The Owner role is given only when a business is set up."
      onSubmit={() => businessWrite(biz.id, "members", form)}>
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
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Can open this business</label>}
    </FormDialog>
  );
}
