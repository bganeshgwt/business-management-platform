import { useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useServerList } from "./hooks";

// The shops, counters and warehouses where this business keeps stock and sells.
export default function LocationsPage() {
  const biz = useOpenBusiness();
  const list = useServerList("locations", { gridId: "business-locations" });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const columns = [
    { key: "name", header: "Location", value: (l) => l.name, mobile: "title", pin: true },
    { key: "code", header: "Code", value: (l) => l.code, className: "mono", mobile: "subtitle" },
    // Pro pass C-22: a warehouse keeps stock but is not offered as a till at Quick bill.
    { key: "counter", header: "Quick bill", value: (l) => (l.sells_at_counter === false ? "Stock only" : "Sells here"),
      render: (l) => <Badge tone={l.sells_at_counter === false ? "neutral" : "info"} label={l.sells_at_counter === false ? "Stock only" : "Sells here"} /> },
    { key: "active", header: "Status", type: "status", value: (l) => (l.active ? "active" : "inactive"), render: (l) => <ActiveBadge active={l.active} /> },
    biz.can("settings.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => <button type="button" className="chip-button" onClick={() => setEditing(l)}>Edit</button> },
  ];
  const saved = (l) => { setEditing(null); setNotice(`${l.name} saved.`); list.reload(); biz.reloadContext(); };
  return (
    <div className="stack">
      <BusinessHeader icon="map-pin" title="Locations"
        description="Each location has its own stock and its own document numbers. A location holding stock cannot be closed until it is moved or corrected."
        actions={biz.can("settings.edit") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add location</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Locations">
        <DataGrid {...list.gridProps} caption="Locations" columns={columns.filter(Boolean)} rowNoun={["location", "locations"]}
          rowClassName={(l) => (!l.active ? "dg-tone-muted" : "")} empty="No locations" />
      </SectionCard>
      {editing && <LocationDialog location={editing} onClose={() => setEditing(null)} onSaved={saved} />}
    </div>
  );
}

function LocationDialog({ location, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(location.id);
  const [form, setForm] = useState({ name: location.name || "", code: location.code || "", active: location.active ?? true, sellsAtCounter: location.sells_at_counter ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title={editing ? `Edit ${location.name}` : "Add a location"} icon="map-pin" width={480} onClose={onClose} onSaved={onSaved}
      onSubmit={() => (editing ? businessWrite(biz.id, `locations/${location.id}`, { name: form.name, active: form.active, sellsAtCounter: form.sellsAtCounter }, "patch") : businessWrite(biz.id, "locations", form))}>
      <Field label="Name" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Koregaon Park store" /></Field>
      <Field label="Code" hint="Short; used in document numbers."><input required maxLength={30} disabled={editing} className="mono" value={form.code} onChange={set("code")} placeholder="e.g. KP" /></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.sellsAtCounter} onChange={set("sellsAtCounter")} /> Sells at the counter (untick for a warehouse or godown: Quick bill then does not offer it)</label>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Open</label>}
    </FormDialog>
  );
}
