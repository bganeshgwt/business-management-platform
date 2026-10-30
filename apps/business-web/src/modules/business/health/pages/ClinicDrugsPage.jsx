import { useId, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SheetImportModal from "../../../../components/SheetImportModal";
import StatusBadge from "../../../../components/StatusBadge";
import api from "../../../../services/api";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { FORMS } from "./healthFormat";
import "../styles/health.css";

// The clinic's own drug list, kept by its doctors: each medicine's generic
// name, brands, strength, form and route, the usual dose and how often (filled
// in when it is picked for a prescription), the most a day and its allergy
// group. The consultation's prescription picks from it and warns of a known
// allergy, the same medicine or group twice, or a day's dose over the most.
// A pharmacy's drug master is its own; this list is the clinic's.
const ROUTES = ["Oral", "Sublingual", "Topical", "Inhalation", "Eye", "Ear", "Nasal", "IV", "IM", "SC", "Rectal", "Vaginal"];
const GROUPS = ["Penicillins", "Cephalosporins", "Sulfonamides", "NSAIDs", "Macrolides", "Fluoroquinolones", "Tetracyclines", "Opioids", "ACE inhibitors", "Statins"];
const MAX_UNITS = ["mg", "g", "mcg", "ml", "IU", "units", "tablets", "capsules", "puffs", "drops", "sachets"];
const FILTERS = [["true", "In use"], ["false", "Switched off"], ["", "All"]];
const maxWords = (d) => (d.max_daily_amount ? `${Number(d.max_daily_amount).toLocaleString("en-IN")} ${d.max_daily_unit} a day` : "");

export default function ClinicDrugsPage() {
  const biz = useOpenBusiness();
  const [active, setActive] = useState("true");
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const list = useServerList("clinic/drugs", { gridId: "clinic-drugs", params: active ? { active } : {} });
  const canEdit = biz.can("patients.edit_clinical");
  const columns = useMemo(() => [
    { key: "generic", header: "Medicine", value: (d) => d.generic_name, mobile: "title", pin: true,
      render: (d) => <span className="bz-two-line"><strong>{[d.generic_name, d.strength].filter(Boolean).join(" ")}</strong><small className="muted">{d.brand_names || "—"}</small></span> },
    { key: "form", header: "Form", value: (d) => [d.form, d.route].filter(Boolean).join(" · "), mobile: "subtitle" },
    { key: "usual", header: "Usual dose", value: (d) => [d.usual_dose, d.usual_frequency].filter(Boolean).join(" · "), mobile: "show" },
    { key: "max", header: "Most a day", value: (d) => maxWords(d) },
    { key: "group", header: "Allergy group", value: (d) => d.allergy_group || "" },
    { key: "prescribed", header: "Prescribed", type: "number", value: (d) => Number(d.prescribed || 0), defaultHidden: true },
    { key: "active", header: "Status", value: (d) => (d.active ? "In use" : "Off"), render: (d) => <StatusBadge status={d.active ? "active" : "inactive"} label={d.active ? "In use" : "Switched off"} /> },
  ], []);
  return (
    <div className="stack">
      <BusinessHeader icon="heart" title="Drug list"
        description="The clinic's own medicines: the prescription picks from them, fills the usual dose, and warns of a patient's allergy, a medicine twice or a dose over the most a day."
        primary={canEdit && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> New medicine</button>}
        secondary={canEdit && <button type="button" className="button button-secondary" onClick={() => setImporting(true)}><Icon name="upload" size={16} /> Import</button>} />
      <SectionCard flush icon="list" title="Medicines">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Generic, brand, strength or group" }} caption="Drug list" columns={columns}
          rowNoun={["medicine", "medicines"]} onRowClick={canEdit ? (d) => setEditing(d) : undefined} rowClassName={(d) => (!d.active ? "dg-tone-muted" : "")}
          toolbar={(
            <div className="segmented" role="group" aria-label="Which medicines">
              {FILTERS.map(([value, label]) => <button key={value || "all"} type="button" className={`segment ${active === value ? "is-active" : ""}`} aria-pressed={active === value} onClick={() => setActive(value)}>{label}</button>)}
            </div>
          )}
          empty="No medicines on the list" emptyHint={canEdit ? "Add the medicines your doctors prescribe, or import them from a spreadsheet." : "A doctor adds the medicines the clinic prescribes."} emptyIcon="heart" />
      </SectionCard>
      {editing && <DrugDialog drug={editing} onClose={() => setEditing(null)} onSaved={(d) => { setEditing(null); toast.success(`${d.generic_name} saved`); list.reload(); }} />}
      {importing && (
        <SheetImportModal title="Import the drug list" noun="medicine" nounPlural="medicines" sampleName="drug-list.csv"
          description="Your clinic's medicines from a spreadsheet: new ones are added and those kept are updated, after you see every change."
          lead="A medicine is found by its generic name, strength and form: one kept already is updated, any other is added. The most a day is an amount and its unit, like 4000 mg."
          loadGuide={() => businessRead(biz.id, "clinic/drugs/import-guide")}
          runImport={(payload) => api.post(`/businesses/${biz.id}/clinic/drugs/import`, payload).then((r) => r.data)}
          onClose={() => setImporting(false)}
          onImported={(message) => { setImporting(false); toast.success(message); list.reload(); }} />
      )}
    </div>
  );
}

function DrugDialog({ drug, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const lists = useId();
  const [form, setForm] = useState({ genericName: drug.generic_name || "", brandNames: drug.brand_names || "", strength: drug.strength || "", form: drug.form || "",
    route: drug.route || "", usualDose: drug.usual_dose || "", usualFrequency: drug.usual_frequency || "", maxDailyAmount: drug.max_daily_amount ? String(Number(drug.max_daily_amount)) : "",
    maxDailyUnit: drug.max_daily_unit || "mg", allergyGroup: drug.allergy_group || "", active: drug.active ?? true });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const body = () => ({ ...form, maxDailyAmount: form.maxDailyAmount || null, maxDailyUnit: form.maxDailyAmount ? form.maxDailyUnit : null });
  return (
    <FormDialog title={drug.id ? `Edit ${drug.generic_name}` : "New medicine"} icon="heart" width={720} onClose={onClose} onSaved={onSaved}
      description="By its generic name. The usual dose and how often fill the prescription line; the most a day and the allergy group are what it is checked against."
      onSubmit={() => (drug.id ? businessWrite(biz.id, `clinic/drugs/${drug.id}`, body(), "put") : businessWrite(biz.id, "clinic/drugs", body()))}>
      <datalist id={`${lists}-forms`}>{FORMS.map((f) => <option key={f} value={f[0].toUpperCase() + f.slice(1)} />)}</datalist>
      <datalist id={`${lists}-routes`}>{ROUTES.map((r) => <option key={r} value={r} />)}</datalist>
      <datalist id={`${lists}-groups`}>{GROUPS.map((g) => <option key={g} value={g} />)}</datalist>
      <Field label="Generic name"><input required maxLength={150} value={form.genericName} onChange={set("genericName")} placeholder="Paracetamol" /></Field>
      <Field label="Brand names" hint="Separated by commas"><input maxLength={300} value={form.brandNames} onChange={set("brandNames")} placeholder="Dolo, Calpol" /></Field>
      <Field label="Strength"><input maxLength={60} value={form.strength} onChange={set("strength")} placeholder="650 mg, or 125 mg/5 ml" /></Field>
      <Field label="Form"><input maxLength={40} list={`${lists}-forms`} value={form.form} onChange={set("form")} /></Field>
      <Field label="Route"><input maxLength={40} list={`${lists}-routes`} value={form.route} onChange={set("route")} /></Field>
      <Field label="Usual dose"><input maxLength={60} value={form.usualDose} onChange={set("usualDose")} placeholder="1 tab" /></Field>
      <Field label="How often" hint="1-0-1, OD, BD, TDS, QID, HS, every 6 hours"><input maxLength={60} value={form.usualFrequency} onChange={set("usualFrequency")} /></Field>
      <Field label="Most a day" hint="Leave empty to check no dose">
        <span className="bz-inline">
          <input className="hl-qty" type="number" min="0" step="0.001" value={form.maxDailyAmount} onChange={set("maxDailyAmount")} aria-label="Most a day, amount" />
          <select value={form.maxDailyUnit} onChange={set("maxDailyUnit")} aria-label="Most a day, unit">{MAX_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select>
        </span>
      </Field>
      <Field label="Allergy group" hint="An allergy to one medicine of the group warns for all of it"><input maxLength={80} list={`${lists}-groups`} value={form.allergyGroup} onChange={set("allergyGroup")} /></Field>
      {drug.id && <label className="hl-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (offered on new prescriptions)</label>}
    </FormDialog>
  );
}
