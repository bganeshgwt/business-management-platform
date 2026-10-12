import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useOptions, useServerList } from "./hooks";

const KINDS = { count: "Count (whole units)", weight: "Weight", volume: "Volume", length: "Length", time: "Time", service: "Service" };

// Units of measure and pack sizes. A unit may convert to a base unit of the
// same kind (g → kg); a pack size says how many stock units one pack holds
// for one product (1 strip = 10 tablets). Lines entered in packs are turned
// into stock units exactly.
export default function UnitsPage() {
  const biz = useOpenBusiness();
  const units = useServerList("units", { gridId: "business-units" });
  const packs = useServerList("pack-sizes", { gridId: "business-pack-sizes" });
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const unitColumns = useMemo(() => [
    { key: "name", header: "Unit", value: (u) => u.name, mobile: "title", pin: true },
    { key: "code", header: "Code", value: (u) => u.code, className: "mono", mobile: "subtitle" },
    { key: "kind", header: "Measures", value: (u) => KINDS[u.kind] },
    { key: "decimals", header: "Decimals", type: "number", value: (u) => u.decimals },
    { key: "base", header: "Converts to", value: (u) => (u.base_unit_code ? `${Number(u.factor_to_base)} ${u.base_unit_code}` : ""), render: (u) => (u.base_unit_code ? `1 ${u.code} = ${Number(u.factor_to_base)} ${u.base_unit_code}` : <span className="muted">Base unit</span>) },
    { key: "skus", header: "Items stocked in it", type: "number", value: (u) => u.sku_count },
    { key: "active", header: "Status", type: "status", value: (u) => (u.active ? "active" : "inactive"), render: (u) => <ActiveBadge active={u.active} /> },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (u) => <button type="button" className="chip-button" onClick={() => setDialog({ type: "unit", row: u })}>Edit</button> },
  ], [biz]);

  const packColumns = useMemo(() => [
    { key: "label", header: "Item", value: (p) => p.label, mobile: "title", pin: true },
    { key: "unit", header: "Pack", value: (p) => p.unit_code, mobile: "subtitle" },
    { key: "size", header: "Holds", value: (p) => Number(p.quantity_in_base), render: (p) => `1 ${p.unit_code} = ${Number(p.quantity_in_base)} ${p.base_unit}`, mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (p) => (p.active ? "active" : "inactive"), render: (p) => <ActiveBadge active={p.active} /> },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => (
      <button type="button" className="chip-button" onClick={async () => {
        try { await businessWrite(biz.id, `pack-sizes/${p.id}`, { active: !p.active }, "patch"); packs.reload(); } catch (err) { setError(getErrorMessage(err)); }
      }}>{p.active ? "Switch off" : "Switch on"}</button>
    ) },
  ], [biz, packs]);

  const saved = (message) => { setDialog(null); setNotice(message); units.reload(); packs.reload(); };
  return (
    <div className="stack">
      <BusinessHeader icon="scale" title="Units & pack sizes"
        description="How each item is counted, and the packs you buy or sell it in. Buying 2 boxes of 24 adds 48 to stock."
        actions={biz.can("catalog.create") && <button type="button" className="button" onClick={() => setDialog({ type: "unit", row: {} })}><Icon name="plus" size={16} /> Add unit</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error || units.error || packs.error} />
      <SectionCard flush icon="scale" title="Units">
        <DataGrid {...units.gridProps} caption="Units" columns={unitColumns.filter(Boolean)} rowNoun={["unit", "units"]}
          rowClassName={(u) => (!u.active ? "dg-tone-muted" : "")} empty="No units" />
      </SectionCard>
      <SectionCard flush icon="box" title="Pack sizes" description="Per item: how many stock units are in one pack."
        actions={biz.can("catalog.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ type: "pack" })}><Icon name="plus" size={15} /> Add pack size</button>}>
        <DataGrid {...packs.gridProps} caption="Pack sizes" columns={packColumns.filter(Boolean)} rowNoun={["pack size", "pack sizes"]}
          rowClassName={(p) => (!p.active ? "dg-tone-muted" : "")} empty="No pack sizes yet" emptyHint="Add one to buy or sell an item by the box, strip or case." emptyIcon="box" />
      </SectionCard>
      {dialog?.type === "unit" && <UnitDialog unit={dialog.row} onClose={() => setDialog(null)} onSaved={(u) => saved(`${u.name} saved.`)} />}
      {dialog?.type === "pack" && <PackDialog onClose={() => setDialog(null)} onSaved={() => saved("Pack size saved.")} />}
    </div>
  );
}

function UnitDialog({ unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(unit.id);
  const { options } = useOptions(editing ? [] : ["units"]);
  const [form, setForm] = useState({ code: "", name: unit.name || "", kind: "count", decimals: "0", baseUnitCode: "", factorToBase: "", active: unit.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const bases = (options?.units || []).filter((u) => !u.base_unit_code && u.kind === form.kind && u.active);
  const submit = () => (editing
    ? businessWrite(biz.id, `units/${unit.id}`, { name: form.name, active: form.active }, "patch")
    : businessWrite(biz.id, "units", { ...form, baseUnitCode: form.baseUnitCode || undefined, factorToBase: form.baseUnitCode ? form.factorToBase : undefined }));
  return (
    <FormDialog title={editing ? `Edit ${unit.name}` : "Add a unit"} icon="scale" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={editing ? "The code, kind and conversion stay fixed: past bills and stock depend on them." : undefined}>
      {!editing && <Field label="Code" hint="Short and lower-case, e.g. carton."><input required maxLength={20} value={form.code} onChange={set("code")} className="mono" /></Field>}
      <Field label="Name"><input required maxLength={60} value={form.name} onChange={set("name")} /></Field>
      {!editing && (
        <>
          <Field label="Measures">
            <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value, baseUnitCode: "", decimals: e.target.value === "count" ? "0" : "3" }))}>
              {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Decimal places"><input type="number" min="0" max="3" step="1" disabled={form.kind === "count"} value={form.decimals} onChange={set("decimals")} /></Field>
          <Field label="Converts to (optional)">
            <select value={form.baseUnitCode} onChange={set("baseUnitCode")}>
              <option value="">Nothing — it is a base unit</option>
              {bases.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}
            </select>
          </Field>
          {form.baseUnitCode && <Field label={`How many ${form.baseUnitCode} in one`}><input required type="number" min="0.000001" step="0.000001" value={form.factorToBase} onChange={set("factorToBase")} /></Field>}
        </>
      )}
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>}
    </FormDialog>
  );
}

function PackDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["catalog?kind=goods&active=true", "units?active=true"]);
  const items = options?.["catalog?kind=goods&active=true"] || [];
  const [form, setForm] = useState({ skuId: "", unitCode: "", quantityInBase: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const sku = items.find((s) => String(s.id) === form.skuId);
  const packUnits = (options?.["units?active=true"] || []).filter((u) => u.kind === "count" && u.code !== sku?.unit);
  return (
    <FormDialog title="Add a pack size" icon="box" width={560} onClose={onClose} onSaved={onSaved} disabled={!options}
      onSubmit={() => businessWrite(biz.id, "pack-sizes", form)}>
      <Field label="Item" wide>
        <select required value={form.skuId} onChange={set("skuId")}>
          <option value="">Choose…</option>
          {items.map((s) => <option key={s.id} value={s.id}>{s.label} · stocked in {s.unit}</option>)}
        </select>
      </Field>
      <Field label="Pack">
        <select required value={form.unitCode} onChange={set("unitCode")}>
          <option value="">Choose…</option>
          {packUnits.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}
        </select>
      </Field>
      <Field label={`${sku ? sku.unit : "Stock units"} in one pack`}><input required type="number" min="0.001" step="0.001" value={form.quantityInBase} onChange={set("quantityInBase")} /></Field>
    </FormDialog>
  );
}
