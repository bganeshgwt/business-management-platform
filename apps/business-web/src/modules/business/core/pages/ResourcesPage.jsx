import { useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { word } from "../../../../services/businessNav";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useServerList } from "./hooks";

// The people and rooms appointments are booked against.
export default function ResourcesPage() {
  const biz = useOpenBusiness();
  const title = word(biz.type, "resources", "Staff & rooms");
  const list = useServerList("resources", { gridId: "business-resources" });
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const columns = [
    { key: "name", header: "Name", value: (r) => r.name, mobile: "title", pin: true },
    { key: "role_label", header: "Role", value: (r) => r.role_label || "", mobile: "subtitle" },
    { key: "location_name", header: "Location", value: (r) => r.location_name, mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (r) => (r.active ? "active" : "inactive"), render: (r) => <ActiveBadge active={r.active} /> },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="users" title={title} description="Each one has its own diary: an appointment books them for its whole length."
        actions={biz.can("appointments.create") && <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title={title}>
        <DataGrid {...list.gridProps} caption={title} columns={columns} empty="Nobody to book yet" emptyIcon="users" />
      </SectionCard>
      {adding && <ResourceDialog onClose={() => setAdding(false)} onSaved={(r) => { setAdding(false); setNotice(`${r.name} added.`); list.reload(); }} />}
    </div>
  );
}

function ResourceDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState({ name: "", roleLabel: "", locationId: String(locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Add someone to book" icon="user-plus" width={520} onClose={onClose} onSaved={onSaved} onSubmit={() => businessWrite(biz.id, "resources", form)}>
      <Field label="Name" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder={biz.type === "salon" ? "e.g. Priya (senior stylist) or Spa room 2" : "e.g. Dr. Rao or Room 1"} /></Field>
      <Field label="Role (optional)"><input maxLength={100} value={form.roleLabel} onChange={set("roleLabel")} /></Field>
      <Field label="Location">
        <select required value={form.locationId} onChange={set("locationId")}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
    </FormDialog>
  );
}
