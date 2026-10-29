import { useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import SheetImportModal from "../../../../components/SheetImportModal";
import api, { getErrorMessage } from "../../../../services/api";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { FUELS, wordOf } from "./garage";
import "../styles/garage.css";

// A garage's parts data, its own (no catalogue is shipped): the makes and
// models each part fits (typed, or imported from a CSV file), a part's newer
// number (an old number replaced by a new one) and the group of parts that do
// the same job. A vehicle's page lists the parts that fit it; the parts
// counter and the job card offer a substitute when a part is out of stock.

export default function GaragePartsPage() {
  const biz = useOpenBusiness();
  const canEdit = biz.can("catalog.edit");
  const fitments = useServerList("garage/part-fitments", { gridId: "garage-part-fitments" });
  const links = useServerList("garage/part-links", { gridId: "garage-part-links" });
  const [dialog, setDialog] = useState(null);
  const changed = (message) => { setDialog(null); if (message) toast.success(message); fitments.reload?.(); links.reload?.(); };
  const remove = async (f) => {
    try {
      await businessWrite(biz.id, `garage/part-fitments/${f.id}`, undefined, "delete");
      changed(`${f.label} no longer listed for ${[f.make, f.model].filter(Boolean).join(" ")}.`);
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const fitColumns = useMemo(() => [
    { key: "label", header: "Part", value: (f) => `${f.label} ${f.code}`, mobile: "title", render: (f) => <span className="bz-two-line"><span>{f.label}</span><small className="muted mono">{f.code}</small></span> },
    { key: "vehicle", header: "Fits", value: (f) => [f.make, f.model || "every model", f.variant].filter(Boolean).join(" "), mobile: "subtitle" },
    { key: "fuel", header: "Fuel", value: (f) => (f.fuel ? wordOf(FUELS, f.fuel) : "Any") },
    { key: "years", header: "Years", value: (f) => (f.year_from || f.year_to ? `${f.year_from || "…"}–${f.year_to || "…"}` : "Any") },
    { key: "engine_code", header: "Engine", value: (f) => f.engine_code || "Any", className: "mono" },
    canEdit && { key: "actions", header: "", value: () => "", render: (f) => <button type="button" className="link-button danger" onClick={() => remove(f)}>Take off</button> },
  ].filter(Boolean), [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const linkColumns = useMemo(() => [
    { key: "label", header: "Part", value: (p) => `${p.label} ${p.code}`, mobile: "title", render: (p) => <span className="bz-two-line"><span>{p.label}</span><small className="muted mono">{p.code}</small></span> },
    { key: "newer", header: "Replaced by", value: (p) => (p.superseded_by_label ? `${p.superseded_by_label} ${p.superseded_by_code}` : "—") },
    { key: "group", header: "Does the same job as", value: (p) => p.group_name || "—", mobile: "subtitle" },
    canEdit && { key: "actions", header: "", value: () => "", render: (p) => <button type="button" className="link-button" onClick={() => setDialog({ kind: "link", part: p })}>Change</button> },
  ].filter(Boolean), [canEdit]);
  return (
    <div className="stack">
      <BusinessHeader icon="box" title="Parts fitment"
        description="The makes and models each part fits, a part's newer number, and the parts that do the same job: the vehicle's page lists the parts that fit, and the parts counter and the job card offer a substitute when one is out of stock."
        primary={canEdit && <button type="button" className="button" onClick={() => setDialog({ kind: "fit" })}><Icon name="plus" size={16} /> Add a fitment</button>}
        secondary={canEdit && (
          <>
            <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "import" })}><Icon name="upload" size={15} /> Import from a CSV file</button>
            <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "link", part: null })}>Newer number or group</button>
          </>
        )} />
      <SectionCard flush icon="truck" title="What each part fits">
        <DataGrid {...fitments.gridProps} search={{ ...fitments.gridProps.search, placeholder: "Part, make, model or engine" }} caption="Parts fitment" columns={fitColumns}
          rowNoun={["fitment", "fitments"]} empty="No fitment yet" emptyHint={canEdit ? "Add the makes and models each part fits, or import them from a spreadsheet." : undefined} emptyIcon="box" />
      </SectionCard>
      <SectionCard flush icon="switch" title="Newer numbers and parts that do the same job">
        <DataGrid {...links.gridProps} search={{ ...links.gridProps.search, placeholder: "Part, newer part or group" }} caption="Newer numbers and groups" columns={linkColumns}
          rowNoun={["part", "parts"]} empty="None recorded" emptyHint={canEdit ? "Record an old number replaced by a new one, or a group of parts that do the same job." : undefined} emptyIcon="switch" />
      </SectionCard>
      {dialog?.kind === "fit" && <FitmentDialog onClose={() => setDialog(null)} onSaved={(f) => changed(`${f.label} fits ${[f.make, f.model].filter(Boolean).join(" ")}.`)} />}
      {dialog?.kind === "link" && <LinkDialog part={dialog.part} onClose={() => setDialog(null)} onSaved={(p) => changed(`${p.label} saved.`)} />}
      {dialog?.kind === "import" && (
        <SheetImportModal title="Import parts fitment" noun="fitment" nounPlural="fitments" sampleName="parts-fitment.csv"
          description="The makes and models each part fits, from a spreadsheet: new fitments are added after you see each one; those already here are left as they are."
          lead="A part is found by its item code (or barcode). Leave Model, Variant, Fuel, the years or the engine empty for any."
          loadGuide={() => businessRead(biz.id, "garage/part-fitments/import-guide")}
          runImport={(payload) => api.post(`/businesses/${biz.id}/garage/part-fitments/import`, payload).then((r) => r.data)}
          onClose={() => setDialog(null)} onImported={(message) => changed(message)} />
      )}
    </div>
  );
}

function FitmentDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["catalog?active=true&kind=goods"]);
  const parts = useMemo(() => (options?.["catalog?active=true&kind=goods"] || []).filter((s) => !s.is_kit), [options]);
  const [part, setPart] = useState(null);
  const [form, setForm] = useState({ make: "", model: "", variant: "", fuel: "", yearFrom: "", yearTo: "", engineCode: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="A part fits" icon="box" width={680} onClose={onClose} onSaved={onSaved} disabled={!options} submitLabel="Add the fitment"
      description="Leave a field empty for any: a make alone fits every model of it."
      onSubmit={() => {
        if (!part) throw new Error("Choose the part");
        return businessWrite(biz.id, "garage/part-fitments", { skuId: part.id, ...form });
      }}>
      <div className="field-wide">
        <SearchPicker label="Part" placeholder="Name, code or barcode" value={part} onChange={setPart} options={parts} required
          getLabel={(s) => s.label} getKeywords={(s) => `${s.code} ${s.barcode || ""}`} getDescription={(s) => s.code} />
      </div>
      <Field label="Make"><input required maxLength={60} value={form.make} onChange={set("make")} placeholder="e.g. Maruti Suzuki" /></Field>
      <Field label="Model (optional)"><input maxLength={60} value={form.model} onChange={set("model")} placeholder="e.g. Swift" /></Field>
      <Field label="Variant (optional)"><input maxLength={60} value={form.variant} onChange={set("variant")} /></Field>
      <Field label="Fuel"><select value={form.fuel} onChange={set("fuel")}><option value="">Any</option>{FUELS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>
      <Field label="Year from (optional)"><input inputMode="numeric" maxLength={4} value={form.yearFrom} onChange={set("yearFrom")} /></Field>
      <Field label="Year to (optional)"><input inputMode="numeric" maxLength={4} value={form.yearTo} onChange={set("yearTo")} /></Field>
      <Field label="Engine code (optional)"><input maxLength={30} className="mono" value={form.engineCode} onChange={set("engineCode")} placeholder="e.g. K12M" /></Field>
    </FormDialog>
  );
}

function LinkDialog({ part, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["catalog?active=true&kind=goods", "garage/part-groups"]);
  const items = useMemo(() => (options?.["catalog?active=true&kind=goods"] || []).filter((s) => !s.is_kit), [options]);
  const groups = options?.["garage/part-groups"] || [];
  const [chosen, setChosen] = useState(part ? { id: part.sku_id, label: part.label, code: part.code } : null);
  const [newer, setNewer] = useState(part?.superseded_by_sku_id ? { id: part.superseded_by_sku_id, label: part.superseded_by_label, code: part.superseded_by_code } : null);
  const [group, setGroup] = useState(part?.group_name || "");
  return (
    <FormDialog title={part ? `${part.label}` : "A newer number or a group"} icon="switch" width={640} onClose={onClose} onSaved={onSaved} disabled={!options}
      description="An old number replaced by a new one; or parts that do the same job, offered for one another when one is out of stock."
      onSubmit={() => {
        if (!chosen) throw new Error("Choose the part");
        return businessWrite(biz.id, `garage/parts/${chosen.id}`, { supersededBySkuId: newer?.id || null, group: group.trim() || null }, "put");
      }}>
      <div className="field-wide">
        <SearchPicker label="Part" placeholder="Name, code or barcode" value={chosen} onChange={setChosen} options={items} required disabled={Boolean(part)}
          getLabel={(s) => s.label} getKeywords={(s) => `${s.code} ${s.barcode || ""}`} getDescription={(s) => s.code} />
      </div>
      <div className="field-wide">
        <SearchPicker label="Replaced by (optional)" placeholder="The newer part" value={newer} onChange={setNewer} options={items.filter((s) => !chosen || Number(s.id) !== Number(chosen.id))}
          getLabel={(s) => s.label} getKeywords={(s) => `${s.code} ${s.barcode || ""}`} getDescription={(s) => s.code} />
      </div>
      <Field label="Does the same job as (a group, optional)" wide hint="Type a group's name: a new name starts a group.">
        <input list="garage-part-groups" maxLength={80} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="e.g. Front brake pads, Swift" />
        <datalist id="garage-part-groups">{groups.map((g) => <option key={g.id} value={g.name} />)}</datalist>
      </Field>
    </FormDialog>
  );
}
