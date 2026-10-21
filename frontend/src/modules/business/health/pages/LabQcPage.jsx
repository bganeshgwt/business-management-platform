import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "../../../../services/format";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import "../styles/health.css";

// Quality control: the lab's controls (lot, level, target mean and SD) for
// each parameter, the runs measured on them every day, judged by the
// Westgard rules, and a Levey-Jennings chart per control. While a parameter's
// QC is failed today, its patient reports cannot be signed.
const OUTCOME = { accepted: ["success", "In control"], warning: ["warning", "Warning"], rejected: ["danger", "Failed"], not_run: ["neutral", "Not run today"] };
const RULE_WORDS = {
  "1-2s": "one value beyond 2 SD (warning)", "1-3s": "one value beyond 3 SD", "2-2s": "two values beyond 2 SD on the same side",
  "R-4s": "two controls 4 SD apart", "4-1s": "four values beyond 1 SD on the same side", "10x": "ten values on the same side of the mean",
};
const num = (value, digits = 2) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("en-IN", { maximumFractionDigits: digits }));

export default function LabQcPage() {
  const biz = useOpenBusiness();
  const [today, setToday] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  const canEdit = biz.can("lab.edit");
  const materials = useServerList("lab/qc/materials", { gridId: "lab-qc-materials", params: { active: "true" } });
  const runs = useServerList("lab/qc/runs", { gridId: "lab-qc-runs", period: "month" });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lab/qc/today", undefined, controller.signal).then(setToday).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  const done = () => { setDialog(null); setVersion((n) => n + 1); materials.reload(); runs.reload(); };

  const materialColumns = useMemo(() => [
    { key: "test", header: "Test", value: (m) => `${m.test_code} · ${m.parameter_name}`, mobile: "title", render: (m) => <span className="bz-two-line"><strong>{m.parameter_name}</strong><small className="muted">{m.test_code} · {m.test_name}</small></span> },
    { key: "control", header: "Control", value: (m) => `${m.name} ${m.level}`, render: (m) => <span className="bz-two-line"><span>{m.name}</span><small className="muted">{m.level} · lot {m.lot_no}</small></span> },
    { key: "target", header: "Target", value: (m) => Number(m.mean), mobile: "subtitle", render: (m) => `${num(m.mean)} ± ${num(m.sd)} ${m.unit || ""}` },
    { key: "expiry", header: "Lot expires", type: "date", value: (m) => m.expires_on, render: (m) => (m.expires_on ? <span className={m.expired ? "hl-danger" : ""}>{dateShort(m.expires_on, { year: true })}{m.expired ? " (expired)" : ""}</span> : "—"), defaultHidden: true },
    { key: "last", header: "Last run", value: (m) => m.last_run?.run_at || "", render: (m) => (m.last_run ? <span className="bz-two-line"><span>{num(m.last_run.value)} <small className="muted">z {num(m.last_run.z)}</small></span><small className="muted">{dateTime(m.last_run.run_at)}</small></span> : <span className="muted">Never</span>) },
    { key: "today", header: "Today", value: (m) => m.today_outcome || "not_run", mobile: "show", render: (m) => <StatusBadge tone={OUTCOME[m.today_outcome || "not_run"][0]} label={OUTCOME[m.today_outcome || "not_run"][1]} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", width: 230, render: (m) => (
      <span className="bz-inline">
        {canEdit && !m.expired && <button type="button" className="chip-button" onClick={() => setDialog({ run: m })}>Record run</button>}
        <button type="button" className="chip-button" onClick={() => setDialog({ chart: m })}>Chart</button>
        {canEdit && <button type="button" className="link-button" onClick={() => setDialog({ edit: m })}>Edit</button>}
      </span>) },
  ], [canEdit]);
  const runColumns = useMemo(() => [
    { key: "time", header: "When", type: "datetime", value: (r) => r.run_at, mobile: "subtitle" },
    { key: "test", header: "Parameter", value: (r) => r.parameter_name, mobile: "title", render: (r) => <span className="bz-two-line"><strong>{r.parameter_name}</strong><small className="muted">{r.material_name} · {r.level}</small></span> },
    { key: "value", header: "Value", type: "number", value: (r) => Number(r.value), render: (r) => `${num(r.value)} ${r.unit || ""}` },
    { key: "z", header: "z (SD)", type: "number", value: (r) => Number(r.z), render: (r) => num(r.z) },
    { key: "outcome", header: "Outcome", value: (r) => r.outcome, mobile: "show", render: (r) => <span className="bz-two-line"><StatusBadge tone={OUTCOME[r.outcome][0]} label={OUTCOME[r.outcome][1]} />{r.rules?.length > 0 && <small className="muted">{r.rules.join(", ")}</small>}</span> },
    { key: "action", header: "Note / corrective action", value: (r) => [r.note, r.corrective_action].filter(Boolean).join(" · "), defaultHidden: false },
    { key: "by", header: "By", value: (r) => r.entered_by_name, defaultHidden: true },
  ], []);

  const failed = (today?.parameters || []).filter((p) => p.status === "rejected");
  return (
    <div className="stack">
      <BusinessHeader icon="shield" title="Quality control" description="Run the controls before patient samples; a failed control holds that parameter's reports until QC passes again."
        primary={canEdit && <button type="button" className="button" onClick={() => setDialog({ run: null })}><Icon name="plus" size={16} /> Record QC run</button>}
        secondary={canEdit && <button type="button" className="button button-secondary" onClick={() => setDialog({ edit: {} })}>New control</button>} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="check" label="In control today" value={today ? String(today.accepted) : ""} loading={!today} />
        <StatTile icon="alert" label="Warnings (1-2s)" value={today ? String(today.warning) : ""} loading={!today} />
        <StatTile icon="ban" label="Failed: reports held" value={today ? String(today.rejected) : ""} loading={!today} tone={today?.rejected ? "danger" : undefined} />
        <StatTile icon="clock" label="Not run yet today" value={today ? String(today.not_run) : ""} loading={!today} />
      </div>
      {failed.length > 0 && (
        <div className="hl-alert" role="alert">
          <strong>Reports on hold:</strong> {failed.map((p) => `${p.parameter_name} (${p.test_code})`).join(", ")}. Correct the analyser (calibrate, fresh reagent or control), note what was done and run QC again.
        </div>
      )}
      <SectionCard flush icon="list" title="Controls" description="Each control's target from its insert sheet (or the lab's own 20 runs).">
        <DataGrid {...materials.gridProps} caption="QC controls" columns={materialColumns} rowNoun={["control", "controls"]}
          rowClassName={(m) => (m.today_outcome === "rejected" ? "dg-tone-danger" : m.today_outcome === "warning" ? "dg-tone-warning" : "")}
          empty="No controls yet. Add the control material you run on the analyser." emptyIcon="shield" />
      </SectionCard>
      <SectionCard flush icon="history" title="QC runs">
        <DataGrid {...runs.gridProps} caption="QC runs" columns={runColumns} rowNoun={["run", "runs"]} toolbar={<PeriodFilter list={runs} />}
          rowClassName={(r) => (r.outcome === "rejected" ? "dg-tone-danger" : r.outcome === "warning" ? "dg-tone-warning" : "")}
          exportName={biz.can("lab.export") ? `${biz.business.code}-qc-runs` : undefined} empty="No QC runs in this period" emptyIcon="history" />
      </SectionCard>
      <SectionCard icon="info" title="The Westgard rules used">
        <ul className="hl-notes">{Object.entries(RULE_WORDS).map(([rule, words]) => <li key={rule}><strong>{rule}</strong>: {words}{rule === "1-2s" ? "" : ": the run is rejected"}</li>)}</ul>
      </SectionCard>
      {dialog?.edit && <MaterialDialog material={dialog.edit} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog && "run" in dialog && <RunDialog material={dialog.run} materials={materials.data?.items || []} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.chart && <ChartDialog material={dialog.chart} onClose={() => setDialog(null)} />}
    </div>
  );
}

function MaterialDialog({ material, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(material.id);
  const [tests, setTests] = useState([]);
  const [testId, setTestId] = useState("");
  const [loaded, setLoaded] = useState({ testId: "", list: [] });
  const parameters = loaded.testId === testId ? loaded.list : [];
  const [form, setForm] = useState({ parameterId: material.parameter_id || "", name: material.name || "", lotNo: material.lot_no || "", level: material.level || "Level 1",
    mean: material.mean ?? "", sd: material.sd ?? "", expiresOn: material.expires_on ? String(material.expires_on).slice(0, 10) : "", active: material.active !== false });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  useEffect(() => { if (!editing) businessRead(biz.id, "lab/tests", { limit: 100, active: "true" }).then((r) => setTests((r.items || []).filter((t) => t.kind !== "profile"))).catch(() => {}); }, [biz.id, editing]);
  useEffect(() => {
    if (!testId) return;
    businessRead(biz.id, `lab/tests/${testId}`).then((t) => setLoaded({ testId, list: (t.parameters || []).filter((p) => p.result_type === "numeric" && p.active !== false) }))
      .catch(() => setLoaded({ testId, list: [] }));
  }, [biz.id, testId]);
  return (
    <FormDialog title={editing ? `${material.name} · ${material.parameter_name}` : "New QC control"} icon="shield" width={620} onClose={onClose} onSaved={onSaved}
      submitLabel={editing ? "Save control" : "Add control"} description="The target mean and SD come from the control's insert sheet for your analyser, or from the lab's own first 20 runs."
      onSubmit={() => businessWrite(biz.id, editing ? `lab/qc/materials/${material.id}` : "lab/qc/materials", form, editing ? "put" : "post")}>
      {!editing && (
        <>
          <Field label="Test"><select required value={testId} onChange={(e) => { setTestId(e.target.value); setForm((f) => ({ ...f, parameterId: "" })); }}>
            <option value="">Choose…</option>{tests.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</select></Field>
          <Field label="Parameter"><select required value={form.parameterId} onChange={set("parameterId")} disabled={!testId}>
            <option value="">Choose…</option>{parameters.map((p) => <option key={p.id} value={p.id}>{p.name}{p.unit ? ` (${p.unit})` : ""}</option>)}</select></Field>
        </>
      )}
      <Field label="Control material"><input required maxLength={120} value={form.name} placeholder="e.g. Bio-Rad Lyphochek Assayed Chemistry" onChange={set("name")} /></Field>
      <Field label="Level"><select value={form.level} onChange={set("level")}>{["Level 1", "Level 2", "Level 3", "Normal", "Abnormal"].map((l) => <option key={l}>{l}</option>)}</select></Field>
      <Field label="Lot number"><input required maxLength={40} value={form.lotNo} onChange={set("lotNo")} /></Field>
      <Field label="Lot expires"><input type="date" value={form.expiresOn} onChange={set("expiresOn")} /></Field>
      <Field label="Target mean"><input required type="number" step="any" value={form.mean} onChange={set("mean")} /></Field>
      <Field label="SD (standard deviation)"><input required type="number" step="any" min="0.0001" value={form.sd} onChange={set("sd")} /></Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (untick when the lot is finished)</label>}
    </FormDialog>
  );
}

function RunDialog({ material, materials, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ materialId: material?.id || "", value: "", note: "", correctiveAction: "" });
  const [result, setResult] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const chosen = materials.find((m) => String(m.id) === String(form.materialId)) || material;
  const z = chosen && form.value !== "" ? (Number(form.value) - Number(chosen.mean)) / Number(chosen.sd) : null;
  if (result) {
    return (
      <Modal title={`QC ${OUTCOME[result.outcome][1].toLowerCase()}`} icon="shield" width={520} onClose={() => onSaved(result)}>
        <div className="stack">
          <p><StatusBadge tone={OUTCOME[result.outcome][0]} label={OUTCOME[result.outcome][1]} /> {num(result.value)} is {num(result.z)} SD from the mean ({num(result.mean)}).</p>
          {result.rules?.length > 0 && <ul className="hl-notes">{result.rules.map((r) => <li key={r}><strong>{r}</strong>: {RULE_WORDS[r]}</li>)}</ul>}
          {result.outcome === "rejected" && <p className="hl-danger">Reports with this parameter are on hold. Correct the cause, then run the control again.</p>}
          <div className="form-actions"><button type="button" className="button" onClick={() => onSaved(result)}>Done</button></div>
        </div>
      </Modal>
    );
  }
  return (
    <FormDialog title="Record a QC run" icon="shield" width={560} onClose={onClose} onSaved={setResult} submitLabel="Record run"
      onSubmit={() => businessWrite(biz.id, "lab/qc/runs", form)}>
      <Field label="Control" wide><select required value={form.materialId} onChange={set("materialId")}>
        <option value="">Choose…</option>{materials.filter((m) => !m.expired).map((m) => <option key={m.id} value={m.id}>{m.parameter_name} · {m.name} {m.level} (lot {m.lot_no})</option>)}</select></Field>
      <Field label="Measured value" hint={chosen ? `Target ${num(chosen.mean)} ± ${num(chosen.sd)} ${chosen.unit || ""}` : undefined}>
        <input required type="number" step="any" value={form.value} onChange={set("value")} autoFocus /></Field>
      <Field label="Distance from the mean">
        <output className={z !== null && Math.abs(z) > 3 ? "hl-danger" : z !== null && Math.abs(z) > 2 ? "hl-warn" : ""}>{z === null ? "—" : `${z.toFixed(2)} SD`}</output></Field>
      <Field label="Note" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="Optional" /></Field>
      <Field label="Corrective action (after a failed run)" wide><input maxLength={300} value={form.correctiveAction} onChange={set("correctiveAction")} placeholder="e.g. Recalibrated, fresh reagent pack opened" /></Field>
    </FormDialog>
  );
}

// Levey-Jennings: each run against the mean and ±1, 2, 3 SD.
function ChartDialog({ material, onClose }) {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    businessRead(biz.id, "lab/qc/runs", { material: material.id, limit: 40 }).then((r) => setRows([...(r.items || [])].reverse())).catch((err) => setError(getErrorMessage(err)));
  }, [biz.id, material.id]);
  const W = 640, H = 260, left = 44, right = 12, top = 12, bottom = 28;
  const y = (z) => top + ((3.5 - Math.max(-3.5, Math.min(3.5, z))) / 7) * (H - top - bottom);
  const x = (i, n) => left + (n <= 1 ? (W - left - right) / 2 : (i / (n - 1)) * (W - left - right));
  const mean = Number(material.mean), sd = Number(material.sd);
  return (
    <Modal title={`${material.parameter_name} · ${material.name} ${material.level}`} description={`Lot ${material.lot_no} · target ${num(mean)} ± ${num(sd)} ${material.unit || ""}`} icon="activity" width={720} onClose={onClose}>
      <ErrorMessage message={error} />
      {!rows && !error ? <Loading /> : rows?.length === 0 ? <p className="muted">No runs yet.</p> : rows && (
        <figure className="hl-lj">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Levey-Jennings chart of the last ${rows.length} runs`}>
            {[3, 2, 1, 0, -1, -2, -3].map((k) => (
              <g key={k}>
                <line x1={left} x2={W - right} y1={y(k)} y2={y(k)} className={`hl-lj-line hl-lj-${Math.abs(k)}`} />
                <text x={left - 6} y={y(k) + 4} textAnchor="end" className="hl-lj-label">{k === 0 ? "Mean" : `${k > 0 ? "+" : "−"}${Math.abs(k)}SD`}</text>
              </g>
            ))}
            <polyline className="hl-lj-path" points={rows.map((r, i) => `${x(i, rows.length)},${y(Number(r.z))}`).join(" ")} />
            {rows.map((r, i) => (
              <circle key={r.id} cx={x(i, rows.length)} cy={y(Number(r.z))} r={4.5} className={`hl-lj-dot is-${r.outcome}`}>
                <title>{`${dateTime(r.run_at)}: ${num(r.value)} (${num(r.z)} SD) ${OUTCOME[r.outcome][1]}${r.rules?.length ? ` · ${r.rules.join(", ")}` : ""}`}</title>
              </circle>
            ))}
          </svg>
          <figcaption className="muted">Last {rows.length} runs, oldest on the left. Mean {num(mean)}; ±2 SD {num(mean - 2 * sd)} – {num(mean + 2 * sd)}; ±3 SD {num(mean - 3 * sd)} – {num(mean + 3 * sd)}.</figcaption>
        </figure>
      )}
    </Modal>
  );
}
