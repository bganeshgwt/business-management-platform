import { useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useServerList } from "./hooks";

// Named GST slabs. A slab's rate never changes: when the law changes, add the
// new slab and move items to it, so old bills still say what they charged.
export default function TaxRatesPage() {
  const biz = useOpenBusiness();
  const list = useServerList("tax-rates", { gridId: "business-tax-rates" });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const columns = [
    { key: "name", header: "Slab", value: (t) => t.name, mobile: "title", pin: true, render: (t) => <span className="bz-inline"><strong>{t.name}</strong>{t.is_default && <Badge tone="info" label="Default" />}</span> },
    { key: "rate", header: "Rate", type: "percent", value: (t) => Number(t.rate), mobile: "subtitle" },
    { key: "skus", header: "Items using it", type: "number", value: (t) => t.sku_count, mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (t) => (t.active ? "active" : "inactive"), render: (t) => <ActiveBadge active={t.active} /> },
    biz.can("settings.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (t) => <button type="button" className="chip-button" onClick={() => setEditing(t)}>Edit</button> },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="percent" title="Tax rates"
        description="The GST slabs your items can use. Since 22 September 2025 most goods are at 5% or 18%, with 40% for a few. A slab's rate is fixed once created."
        actions={biz.can("settings.edit") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add slab</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="GST slabs">
        <DataGrid {...list.gridProps} caption="Tax rates" columns={columns.filter(Boolean)} rowNoun={["slab", "slabs"]}
          rowClassName={(t) => (!t.active ? "dg-tone-muted" : "")} empty="No tax rates" />
      </SectionCard>
      {editing && <TaxDialog rate={editing} onClose={() => setEditing(null)} onSaved={(t) => { setEditing(null); setNotice(`${t.name} saved.`); list.reload(); }} />}
    </div>
  );
}

function TaxDialog({ rate, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(rate.id);
  const [form, setForm] = useState({ name: rate.name || "", rate: rate.rate ? String(Number(rate.rate)) : "", isDefault: rate.is_default || false, active: rate.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title={editing ? `Edit ${rate.name}` : "Add a GST slab"} icon="percent" width={500} onClose={onClose} onSaved={onSaved}
      onSubmit={() => (editing ? businessWrite(biz.id, `tax-rates/${rate.id}`, { name: form.name, isDefault: form.isDefault, active: form.active }, "patch") : businessWrite(biz.id, "tax-rates", form))}>
      <Field label="Name"><input required maxLength={60} value={form.name} onChange={set("name")} placeholder="e.g. GST 3% (gold)" /></Field>
      <Field label="Rate %" hint={editing ? "Fixed once created." : undefined}><input required type="number" min="0" max="100" step="0.01" disabled={editing} value={form.rate} onChange={set("rate")} /></Field>
      <label className="checkbox bz-check"><input type="checkbox" checked={form.isDefault} onChange={set("isDefault")} /> Default for new items</label>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>}
    </FormDialog>
  );
}
