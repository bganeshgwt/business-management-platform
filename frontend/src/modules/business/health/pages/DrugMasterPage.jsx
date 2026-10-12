import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { quantity, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { ScheduleBadge } from "./healthParts";
import { FORMS, SCHEDULES } from "./healthFormat";
import "../styles/health.css";

// The drug master: the shared catalogue's goods with their salt, strength,
// form, maker, schedule, pack and storage. The schedule decides what the
// counter asks for (a prescription for H / H1 / X, the pharmacist's PIN for X)
// and which register a sale goes into. Items with the same salt and strength
// are each other's substitutes.
const FILTERS = [["", "All"], ["unset", "No details yet"], ["H", "Sch. H"], ["H1", "Sch. H1"], ["X", "Sch. X"], ["none", "OTC"]];

export default function DrugMasterPage() {
  const biz = useOpenBusiness();
  const [schedule, setSchedule] = useState("");
  const [cold, setCold] = useState(false);
  const [editing, setEditing] = useState(null);
  const list = useServerList("pharmacy/drugs", { gridId: "pharmacy-drug-master", params: { ...(schedule ? { schedule } : {}), ...(cold ? { cold_chain: "true" } : {}) } });
  const canEdit = biz.can("pharmacy.edit");
  const columns = useMemo(() => [
    { key: "label", header: "Medicine", value: (d) => d.label, mobile: "title", pin: true, render: (d) => <span className="bz-two-line"><strong>{d.label}</strong><small className="muted mono">{d.code}</small></span> },
    { key: "composition", header: "Salt / composition", value: (d) => [d.composition, d.strength].filter(Boolean).join(" "), mobile: "subtitle" },
    { key: "form", header: "Form", value: (d) => d.form || "" },
    { key: "maker", header: "Manufacturer", value: (d) => d.manufacturer || "" },
    { key: "schedule", header: "Schedule", value: (d) => d.schedule, render: (d) => <ScheduleBadge schedule={d.schedule} />, mobile: "show" },
    { key: "pack", header: "Pack", value: (d) => (d.units_per_strip ? `${d.units_per_strip}/strip${d.strips_per_box ? ` × ${d.strips_per_box}` : ""}` : ""),
      render: (d) => (d.units_per_strip ? <span>{d.units_per_strip} per strip{d.strips_per_box ? ` · ${d.strips_per_box} strips/box` : ""}{d.loose_sale ? <small className="muted"> · loose OK</small> : ""}</span> : <span className="muted">—</span>) },
    { key: "storage", header: "Storage", value: (d) => (d.cold_chain ? "Cold chain" : d.storage || ""), render: (d) => (d.cold_chain ? <StatusBadge tone="info" label="2–8 °C" /> : <small className="muted">{d.storage || "—"}</small>), defaultHidden: true },
    { key: "stock", header: "Stock", type: "number", value: (d) => Number(d.stock), render: (d) => quantity(d.stock, d.unit), mobile: "show" },
    { key: "subs", header: "Substitutes", type: "number", value: (d) => Number(d.substitutes || 0) },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (d) => <button type="button" className="chip-button" onClick={() => setEditing(d)}>{d.has_master ? "Edit" : "Add details"}</button> },
  ].filter(Boolean), [canEdit]);
  return (
    <div className="stack">
      <BusinessHeader icon="heart" title="Drug master"
        description="Each medicine's salt, strength, schedule and pack. The schedule decides what the counter asks for; the same salt and strength makes a substitute." />
      <SectionCard flush icon="list" title="Medicines">
        <DataGrid {...list.gridProps} caption="Drug master" columns={columns} currency={biz.symbol} rowNoun={["medicine", "medicines"]}
          toolbar={(
            <>
              <div className="segmented" role="group" aria-label="Schedule">
                {FILTERS.map(([value, label]) => <button key={value || "all"} type="button" className={`segment ${schedule === value ? "is-active" : ""}`} aria-pressed={schedule === value} onClick={() => setSchedule(value)}>{label}</button>)}
              </div>
              <label className="hl-check"><input type="checkbox" checked={cold} onChange={(e) => setCold(e.target.checked)} /> Cold chain only</label>
            </>
          )}
          exportName={biz.can("pharmacy.export") ? `${biz.business.code}-drug-master` : undefined}
          empty="No medicines match" emptyHint="Add medicines under Products first; then give each its drug details here." emptyIcon="heart" />
      </SectionCard>
      {editing && <DrugDialog drug={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </div>
  );
}

function DrugDialog({ drug, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({
    composition: drug.composition || "", strength: drug.strength || "", form: drug.form || "tablet", manufacturer: drug.manufacturer || "",
    schedule: drug.schedule === "unset" ? "none" : drug.schedule, unitsPerStrip: drug.units_per_strip ?? "", stripsPerBox: drug.strips_per_box ?? "",
    looseSale: Boolean(drug.loose_sale), coldChain: Boolean(drug.cold_chain), storage: drug.storage || "",
  });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const byTablet = ["tablet", "capsule"].includes(drug.unit);
  return (
    <FormDialog title={`Drug details · ${drug.label}`} icon="heart" width={680} onClose={onClose} onSaved={onSaved} successMessage={`${drug.label} saved`}
      description={`Stocked in ${drug.unit}s. ${byTablet ? "Tablets per strip adds the strip as a pack size, so the counter can sell strips." : ""}`}
      onSubmit={() => businessWrite(biz.id, `pharmacy/drugs/${drug.id}`, { ...form, unitsPerStrip: form.unitsPerStrip === "" ? null : Number(form.unitsPerStrip), stripsPerBox: form.stripsPerBox === "" ? null : Number(form.stripsPerBox) }, "put")}>
      <Field label="Salt / composition" wide hint="Generic names joined with +, e.g. Amoxicillin + Clavulanic acid. Substitutes match on this and the strength."><input required maxLength={300} value={form.composition} onChange={set("composition")} /></Field>
      <Field label="Strength"><input maxLength={60} value={form.strength} onChange={set("strength")} placeholder="500 mg" /></Field>
      <Field label="Form"><select value={form.form} onChange={set("form")}>{FORMS.map((f) => <option key={f} value={f}>{f}</option>)}</select></Field>
      <Field label="Manufacturer"><input maxLength={150} value={form.manufacturer} onChange={set("manufacturer")} /></Field>
      <Field label="Schedule" hint="H, H1 and X need a prescription; H1 and X go into registers; X needs the pharmacist's PIN.">
        <select value={form.schedule} onChange={set("schedule")}>{SCHEDULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </Field>
      <Field label="Tablets per strip"><input type="number" min="1" max="1000" value={form.unitsPerStrip} onChange={set("unitsPerStrip")} /></Field>
      <Field label="Strips per box"><input type="number" min="1" max="1000" value={form.stripsPerBox} onChange={set("stripsPerBox")} /></Field>
      <Field label="Storage"><input maxLength={150} value={form.storage} onChange={set("storage")} placeholder="Store below 30 °C" /></Field>
      <label className="hl-check field-wide"><input type="checkbox" checked={form.looseSale} disabled={!byTablet} onChange={set("looseSale")} /> A strip may be cut and sold by the tablet{byTablet ? "" : " (stock it in tablets to allow this)"}</label>
      <label className="hl-check field-wide"><input type="checkbox" checked={form.coldChain} onChange={set("coldChain")} /> Cold chain (keep at 2–8 °C)</label>
    </FormDialog>
  );
}
