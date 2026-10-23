import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatusBadge from "../../../../components/StatusBadge";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import "../styles/health.css";

// The lab's tests: each with its parameters, units and reference ranges by sex
// and age band (and critical limits), the sample it needs and the catalogue
// service it is billed as; profiles group tests sold together (a health
// check-up). Results are judged against these ranges as they are typed.
const SAMPLES = ["blood", "serum", "plasma", "urine", "stool", "swab", "sputum", "other"];
const blankRange = () => ({ key: newKey(), sex: "any", ageFrom: "0", ageTo: "150", low: "", high: "", criticalLow: "", criticalHigh: "", normalText: "" });
const blankParam = () => ({ key: newKey(), name: "", unit: "", resultType: "numeric", decimals: "1", active: true, ranges: [blankRange()] });

export default function LabTestsPage() {
  const biz = useOpenBusiness();
  const [kind, setKind] = useState("");
  const [editing, setEditing] = useState(null);
  const list = useServerList("lab/tests", { gridId: "lab-tests", params: kind ? { kind } : {} });
  const canEdit = biz.can("lab.edit");
  const open = async (row) => {
    try { setEditing(row ? await businessRead(biz.id, `lab/tests/${row.id}`) : { kind: kind || "test" }); } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const columns = useMemo(() => [
    { key: "name", header: "Test", value: (t) => t.name, mobile: "title", render: (t) => <span className="bz-two-line"><strong>{t.name}</strong><small className="muted mono">{t.code}</small></span> },
    { key: "kind", header: "Kind", value: (t) => (t.kind === "profile" ? "Profile" : t.parameter_count > 1 ? "Panel" : "Test"), mobile: "subtitle" },
    { key: "contents", header: "Contents", value: (t) => (t.kind === "profile" ? t.profile_codes : `${t.parameter_count} parameter${t.parameter_count === 1 ? "" : "s"}`) },
    { key: "sample", header: "Sample", value: (t) => `${t.sample_type}${t.container ? ` · ${t.container}` : ""}` },
    { key: "tat", header: "Report in", value: (t) => `${t.turnaround_hours} h`, defaultHidden: true },
    { key: "billed", header: "Billed as", value: (t) => t.sku_label || "", render: (t) => (t.sku_label ? <span className="bz-two-line"><span>{t.sku_label}</span><small className="muted">{biz.exact(t.sku_price)}</small></span> : <StatusBadge tone="warning" label="Not linked" />) },
    { key: "active", header: "Status", value: (t) => (t.active ? "Active" : "Off"), render: (t) => <StatusBadge status={t.active ? "active" : "inactive"} label={t.active ? "Active" : "Switched off"} /> },
  ], [biz]);
  return (
    <div className="stack">
      <BusinessHeader icon="activity" title="Tests & panels" description="Parameters, units and reference ranges by sex and age; profiles of several tests."
        primary={canEdit && <button type="button" className="button" onClick={() => open(null)}><Icon name="plus" size={16} /> New test</button>} />
      <SectionCard flush icon="list" title="Test catalogue">
        <DataGrid {...list.gridProps} caption="Lab tests" columns={columns} rowNoun={["test", "tests"]} onRowClick={canEdit ? (t) => open(t) : undefined}
          toolbar={(
            <div className="segmented" role="group" aria-label="Kind">
              {[["", "All"], ["test", "Tests & panels"], ["profile", "Profiles"]].map(([v, l]) => <button key={v || "all"} type="button" className={`segment ${kind === v ? "is-active" : ""}`} aria-pressed={kind === v} onClick={() => setKind(v)}>{l}</button>)}
            </div>
          )}
          empty="No tests yet" emptyHint="Add CBC, sugar, lipid profile… with their reference ranges." emptyIcon="activity" />
      </SectionCard>
      {editing && <TestDialog test={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </div>
  );
}

function TestDialog({ test, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const isProfile = test.kind === "profile";
  const { options } = useOptions(["catalog?kind=service", ...(isProfile ? ["lab/tests?kind=test"] : [])]);
  const [form, setForm] = useState({ code: test.code || "", name: test.name || "", sampleType: test.sample_type || "blood", container: test.container || "", method: test.method || "",
    turnaroundHours: String(test.turnaround_hours || 24), skuId: test.sku_id ? String(test.sku_id) : "", active: test.active ?? true, testIds: (test.tests || []).map((t) => t.id) });
  const [params, setParams] = useState(() => (test.parameters?.length ? test.parameters.map((p) => ({ key: String(p.id), id: p.id, name: p.name, unit: p.unit || "", resultType: p.result_type, decimals: String(p.decimals), active: p.active,
    ranges: p.ranges.map((r) => ({ key: String(r.id), sex: r.sex, ageFrom: String(r.ageFrom), ageTo: String(r.ageTo), low: r.low ?? "", high: r.high ?? "", criticalLow: r.criticalLow ?? "", criticalHigh: r.criticalHigh ?? "", normalText: r.normalText || "" })) }))
    : isProfile ? [] : [blankParam()]));
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setParam = (key, patch) => setParams((all) => all.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const setRange = (pkey, rkey, patch) => setParams((all) => all.map((p) => (p.key === pkey ? { ...p, ranges: p.ranges.map((r) => (r.key === rkey ? { ...r, ...patch } : r)) } : p)));
  const body = () => ({
    ...form, kind: isProfile ? "profile" : "test", skuId: form.skuId ? Number(form.skuId) : null,
    parameters: params.map(({ key: _k, ranges, ...p }) => ({ ...p, ranges: ranges.map(({ key: _r, ...r }) => r) })),
  });
  return (
    <FormDialog title={test.id ? `Edit ${test.name}` : isProfile ? "New profile" : "New test"} icon="activity" width={980} onClose={onClose} onSaved={onSaved} successMessage="Test saved"
      onSubmit={() => (test.id ? businessWrite(biz.id, `lab/tests/${test.id}`, body(), "put") : businessWrite(biz.id, "lab/tests", body()))}>
      <Field label="Code"><input required maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,29}" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} /></Field>
      <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Billed as (service)"><select value={form.skuId} onChange={set("skuId")}><option value="">Not billed by itself</option>{(options?.["catalog?kind=service"] || []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
      {!isProfile && <>
        <Field label="Sample"><select value={form.sampleType} onChange={set("sampleType")}>{SAMPLES.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Container"><input maxLength={60} value={form.container} onChange={set("container")} placeholder="EDTA (purple top)" /></Field>
        <Field label="Method"><input maxLength={100} value={form.method} onChange={set("method")} /></Field>
        <Field label="Report in (hours)"><input type="number" min="1" max="720" value={form.turnaroundHours} onChange={set("turnaroundHours")} /></Field>
      </>}
      <label className="hl-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>
      {isProfile ? (
        <div className="field-wide hl-test-list">
          <strong>Tests in this profile</strong>
          {(options?.["lab/tests?kind=test"] || []).map((t) => (
            <label key={t.id} className="hl-check"><input type="checkbox" checked={form.testIds.includes(t.id)} onChange={() => setForm((f) => ({ ...f, testIds: f.testIds.includes(t.id) ? f.testIds.filter((x) => x !== t.id) : [...f.testIds, t.id] }))} /> {t.name} <small className="muted">{t.code}</small></label>
          ))}
        </div>
      ) : (
        <div className="field-wide stack">
          {params.map((p, index) => (
            <fieldset key={p.key} className="hl-param">
              <legend>Parameter {index + 1}</legend>
              <div className="hl-param-row">
                <Field label="Name"><input required maxLength={120} value={p.name} onChange={(e) => setParam(p.key, { name: e.target.value })} /></Field>
                <Field label="Unit"><input maxLength={30} value={p.unit} onChange={(e) => setParam(p.key, { unit: e.target.value })} /></Field>
                <Field label="Result"><select value={p.resultType} onChange={(e) => setParam(p.key, { resultType: e.target.value })}><option value="numeric">Number</option><option value="text">Text</option></select></Field>
                <Field label="Decimals"><input type="number" min="0" max="4" value={p.decimals} onChange={(e) => setParam(p.key, { decimals: e.target.value })} /></Field>
                <label className="hl-check"><input type="checkbox" checked={p.active} onChange={(e) => setParam(p.key, { active: e.target.checked })} /> In use</label>
              </div>
              <DataGrid id="lab-test-ranges" caption={`Reference ranges of ${p.name || `parameter ${index + 1}`}`} variant="editor" rows={p.ranges} rowKey={(r) => r.key} pageSize={false} columns={[
                { key: "sex", header: "Sex", value: (r) => r.sex, render: (r, ctx) => <select aria-label={ctx.label} value={r.sex} onChange={(e) => setRange(p.key, r.key, { sex: e.target.value })}><option value="any">Any</option><option value="female">Female</option><option value="male">Male</option></select> },
                ...[["ageFrom", "Age from (y)"], ["ageTo", "Age to (y)"]].map(([k, h]) => ({ key: k, header: h, value: (r) => r[k], render: (r, ctx) => <input aria-label={ctx.label} className="hl-qty" type="number" min="0" max="150" step="0.1" value={r[k]} onChange={(e) => setRange(p.key, r.key, { [k]: e.target.value })} /> })),
                ...(p.resultType === "numeric" ? [["low", "Low"], ["high", "High"], ["criticalLow", "Critical low"], ["criticalHigh", "Critical high"]] : [["normalText", "Normal answer"]]).map(([k, h]) => ({
                  key: k, header: h, value: (r) => r[k], render: (r, ctx) => <input aria-label={ctx.label} className={k === "normalText" ? "" : "hl-qty"} inputMode={k === "normalText" ? "text" : "decimal"} value={r[k]} onChange={(e) => setRange(p.key, r.key, { [k]: e.target.value })} /> })),
                { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <button type="button" className="link-button danger" onClick={() => setParam(p.key, { ranges: p.ranges.filter((x) => x.key !== r.key) })}>Remove</button> },
              ]} empty="No range: results are shown without a flag" />
              <div className="bz-inline">
                <button type="button" className="chip-button" onClick={() => setParam(p.key, { ranges: [...p.ranges, blankRange()] })}>Add a range</button>
                {!p.id && <button type="button" className="link-button danger" onClick={() => setParams((all) => all.filter((x) => x.key !== p.key))}>Remove parameter</button>}
              </div>
            </fieldset>
          ))}
          <button type="button" className="button button-secondary" onClick={() => setParams((all) => [...all, blankParam()])}><Icon name="plus" size={15} /> Add parameter</button>
        </div>
      )}
    </FormDialog>
  );
}
