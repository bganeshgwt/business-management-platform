import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { businessToday, dateTime, newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { toast } from "../../../../services/toast";
import ReasonDialog from "../../core/pages/ReasonDialog";
import StatusBadge from "../../../../components/StatusBadge";
import { Segmented } from "../../fashion/pages/shared";
import { businessDate, refuse } from "../../fashion/pages/feFormat";

// The serial / IMEI register: every serial-numbered unit ever received, where
// it is now (in stock where, on the way, sold to whom, back with the
// supplier) and its whole history — read from the stock ledger, so it always
// agrees with stock. Models say whether a serial is an IMEI (checked when it
// is received) and how long the warranty runs.

const SERIAL_STATES = {
  in_stock: ["active", "In stock"], in_transit: ["warning", "On the way"], sold: ["info", "Sold"],
  returned_to_supplier: ["neutral", "Back to supplier"], written_off: ["inactive", "Written off"], out_of_stock: ["inactive", "Not in stock"],
};
const FILTERS = [{ value: "", label: "All" }, { value: "in_stock", label: "In stock" }, { value: "in_transit", label: "On the way" }, { value: "sold", label: "Sold" },
  { value: "returned_to_supplier", label: "Back to supplier" }, { value: "written_off", label: "Written off" }];

export default function SerialsPage() {
  const biz = useOpenBusiness();
  const [tab, setTab] = useState("units");
  const [status, setStatus] = useState("in_stock");
  const [location, setLocation] = useState("");
  const [age, setAge] = useState("");
  const params = { ...(status ? { status } : {}), ...(location ? { location } : {}), ...(status === "in_stock" && age ? { age } : {}) };
  const [receiving, setReceiving] = useState(false);
  const units = useServerList("serials", { gridId: "electronics-serials", params });
  const models = useServerList("electronics/models", { gridId: "electronics-models" });
  const [opened, setOpened] = useState(null);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");

  const unitColumns = useMemo(() => [
    { key: "serial", header: "Serial / IMEI", value: (u) => u.serial, className: "mono", mobile: "title", pin: true,
      render: (u) => <span className="bz-two-line"><strong className="mono">{u.serial}</strong>{u.imei2 && <small className="muted mono">IMEI 2: {u.imei2}</small>}</span> },
    { key: "label", header: "Model", value: (u) => u.label, mobile: "subtitle", render: (u) => <span className="bz-two-line"><span>{u.label}</span><small className="muted">{[u.model_number, u.code].filter(Boolean).join(" · ")}</small></span> },
    { key: "status", header: "Status", type: "status", value: (u) => u.status, render: (u) => (u.faulty ? <Badge tone="danger" label="Faulty · for supplier" /> : <Badge tone={SERIAL_STATES[u.status]?.[0]} label={SERIAL_STATES[u.status]?.[1] || u.status} />), mobile: "show" },
    { key: "location", header: "Where", value: (u) => (u.status === "in_transit" ? `To ${u.location_name}` : ["in_stock"].includes(u.status) ? u.location_name : "") },
    { key: "customer", header: "Sold to", value: (u) => u.customer_name || "", mobile: "show",
      render: (u) => (u.sold_no ? <span className="bz-two-line"><span>{u.customer_name || "Walk-in"}</span><small className="muted mono">{u.sold_no} · {dateTime(u.sold_at)}</small></span> : <span className="muted">—</span>) },
    { key: "warranty", header: "Warranty until", type: "date", value: (u) => u.warranty_ends_on },
    { key: "received", header: "Received", type: "date", value: (u) => u.received_at, render: (u) => (u.received_no ? <span className="bz-two-line"><span>{dateTime(u.received_at)}</span><small className="muted">{u.supplier_name}</small></span> : "—") },
    { key: "days", header: "Days in stock", type: "number", value: (u) => (u.days_in_stock === null ? null : Number(u.days_in_stock)),
      render: (u) => (u.days_in_stock === null ? <span className="muted">—</span> : <span className={Number(u.days_in_stock) > 60 ? "bz-minus" : ""}>{u.days_in_stock} days</span>) },
    { key: "cost", header: "Cost", type: "money", exact: true, value: (u) => Number(u.unit_cost), total: "sum", defaultHidden: !biz.can("purchasing.view") },
  ], [biz]);
  const modelColumns = useMemo(() => [
    { key: "label", header: "Item", value: (m) => m.label, mobile: "title", pin: true },
    { key: "code", header: "SKU code", value: (m) => m.code, className: "mono" },
    { key: "model_number", header: "Model number", value: (m) => m.model_number || "", mobile: "subtitle" },
    { key: "serial_kind", header: "Serials are", value: (m) => (m.serial_kind === "imei" ? "IMEI (checked)" : "Serial numbers"), filter: "select", mobile: "show",
      render: (m) => (m.serial_kind === "imei" ? "IMEI (checked)" : /phone|mobile|5g|4g/i.test(m.label) ? <Badge tone="warning" label="Not IMEI-checked" /> : "Serial numbers") },
    { key: "helpline", header: "Brand helpline", value: (m) => m.helpline || "", defaultHidden: true },
    { key: "warranty_months", header: "Warranty", type: "number", value: (m) => Number(m.warranty_months), render: (m) => (Number(m.warranty_months) ? `${m.warranty_months} months` : "None set"), mobile: "show" },
    { key: "in_stock", header: "Units in stock", type: "number", value: (m) => Number(m.in_stock), total: "sum" },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (m) => <button type="button" className="chip-button" onClick={() => setEditing(m)}>Edit</button> },
  ].filter(Boolean), [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="qr" title="Serial / IMEI register"
        description="Every serial-numbered unit: where it is now and everything that happened to it. A number can be in stock at one place only; an IMEI is checked when it is received."
        primary={biz.can("purchasing.create") && <button type="button" className="button" onClick={() => setReceiving(true)}><Icon name="truck" size={15} /> Scan phones in</button>} />
      <SuccessMessage message={notice} />
      <Segmented label="Show" options={[{ value: "units", label: "Units" }, { value: "faulty", label: "Faulty & back to supplier" }, { value: "models", label: "Models & warranty terms" }]} value={tab} onChange={setTab} />
      {tab === "faulty" ? <FaultyUnits /> : tab === "units" ? (
        <>
          <ErrorMessage message={units.error} />
          <SectionCard flush icon="qr" title="Units">
            <DataGrid {...units.gridProps} search={{ ...units.gridProps.search, placeholder: "IMEI, serial, model, customer or bill" }} caption="Serial-numbered units" columns={unitColumns}
              currency={biz.symbol} rowNoun={["unit", "units"]} onRowClick={(u) => setOpened(u)}
              rowClassName={(u) => (u.status === "in_transit" ? "dg-tone-warning" : ["written_off", "returned_to_supplier"].includes(u.status) ? "dg-tone-muted" : "")}
              exportName={biz.can("inventory.export") ? `${biz.business.code}-serials` : undefined}
              toolbar={(
                <>
                  <Segmented label="Status" options={FILTERS} value={status} onChange={setStatus} />
                  {status === "in_stock" && <Segmented label="Age" options={[{ value: "", label: "Any age" }, { value: "0_30", label: "0–30 days" }, { value: "31_60", label: "31–60" }, { value: "60_plus", label: "60+ days" }]} value={age} onChange={setAge} />}
                  {biz.locations.length > 1 && (
                    <label className="field">
                      <span>Location</span>
                      <select value={location} onChange={(e) => setLocation(e.target.value)}>
                        <option value="">All locations</option>
                        {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </label>
                  )}
                </>
              )}
              empty="No units here" emptyHint="Units appear when a purchase with serial / IMEI numbers is received." emptyIcon="qr" />
          </SectionCard>
        </>
      ) : (
        <>
          <ErrorMessage message={models.error} />
          <SectionCard flush icon="phone" title="Serial-numbered models" description="IMEI models refuse a mistyped IMEI at receipt. The warranty months fill in when a warranty is registered from a sale.">
            <DataGrid {...models.gridProps} caption="Models" columns={modelColumns} rowNoun={["model", "models"]}
              exportName={biz.can("catalog.export") ? `${biz.business.code}-models` : undefined}
              empty="No serial-numbered items" emptyHint="Add an item with serial tracking under Products." emptyIcon="phone" />
          </SectionCard>
        </>
      )}
      {opened && <UnitHistory unit={opened} onClose={() => setOpened(null)} onSaved={() => { setNotice("Unit details saved."); units.reload(); }} />}
      {receiving && <ScanInDialog onClose={() => setReceiving(false)} onSaved={(r) => { setReceiving(false); toast.success(`${r.units} unit${r.units === 1 ? "" : "s"} received on ${r.document.document_no}.`); units.reload(); }} />}
      {editing && <ModelDialog model={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice(`${editing.label} saved.`); models.reload(); }} />}
    </div>
  );
}

const SOURCE_WORDS = { purchase: "Received", sale: "Sold", sale_return: "Customer returned", purchase_return: "Sent back to supplier", transfer: "Transfer", count: "Stock count", correction: "Correction" };

export function UnitHistory({ unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [faulty, setFaulty] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "serials/history", { serial: unit.serial, skuId: unit.sku_id }, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, unit.serial, unit.sku_id, version]);
  const u = data?.unit || unit;
  const events = data ? [
    ...data.movements.map((m) => ({ key: `m${m.id}`, at: m.created_at, what: m.source === "transfer" ? (Number(m.quantity) < 0 ? `Sent to ${m.to_name}` : `Arrived at ${m.to_name}`) : SOURCE_WORDS[m.source] || m.source,
      ref: m.source_no || "", where: m.location_name, who: m.contact_name || m.reason || "" })),
    ...data.warranties.map((w) => ({ key: `w${w.id}`, at: w.created_at, what: w.status === "cancelled" ? "Warranty (cancelled)" : "Warranty registered", ref: `${businessDate(w.starts_on, biz.settings.date_format)} to ${businessDate(w.ends_on, biz.settings.date_format)}`, where: "", who: `${w.customer_name} · ${w.customer_phone}` })),
    ...data.repairs.map((r) => ({ key: `r${r.id}`, at: r.created_at, what: "Repair job", ref: r.job_no, where: "", who: r.problem })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at))) : [];
  return (
    <>
      <Modal title={u.serial} icon="qr" width={860} onClose={() => { if (!editing) onClose(); }} description={`${u.label}${u.model_number ? ` · ${u.model_number}` : ""}`}>
        <ErrorMessage message={error} />
        {!data && !error && <Loading />}
        {data && (
          <div className="stack">
            <div className="bz-totals">
              <span>Now <strong>{SERIAL_STATES[u.status]?.[1] || u.status}</strong></span>
              {u.location_name && ["in_stock", "in_transit"].includes(u.status) && <span>{u.status === "in_transit" ? "On the way to" : "At"} <strong>{u.location_name}</strong></span>}
              {u.sold_no && <span>Sold to <strong>{u.customer_name || "Walk-in"}</strong></span>}
              {u.imei2 && <span>IMEI 2 <strong className="mono">{u.imei2}</strong></span>}
              {u.warranty_ends_on && <span>Warranty until <strong>{businessDate(u.warranty_ends_on, biz.settings.date_format)}</strong></span>}
            </div>
            {u.note && <p className="muted small">Note: {u.note}</p>}
            <DataGrid variant="compact" id="serial-history" caption="History of this unit" rows={events} rowKey={(e) => e.key} rowNoun={["event", "events"]} columns={[
              { key: "at", header: "When", type: "datetime", value: (e) => e.at, mobile: "subtitle" },
              { key: "what", header: "What happened", value: (e) => e.what, mobile: "title" },
              { key: "ref", header: "Document", value: (e) => e.ref, className: "mono", mobile: "show" },
              { key: "where", header: "Where", value: (e) => e.where },
              { key: "who", header: "Who / why", value: (e) => e.who, mobile: "show" },
            ]} />
            {biz.can("inventory.edit") && (
              <div className="form-actions bz-start">
                <button type="button" className="button button-secondary" onClick={() => setEditing(true)}><Icon name="edit" size={15} /> Second IMEI and note</button>
                {u.status === "in_stock" && !u.faulty && <button type="button" className="button button-secondary" onClick={() => setFaulty(true)}><Icon name="alert" size={15} /> Faulty: hold for the supplier</button>}
              </div>
            )}
          </div>
        )}
      </Modal>
      {editing && <DetailsDialog unit={u} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setVersion((n) => n + 1); onSaved?.(); }} />}
      {faulty && (
        <ReasonDialog title={`Hold ${u.serial} for the supplier`} submitLabel="Mark faulty" description="It stays in stock but cannot be sold until it goes back to the supplier, is found fine, or is written off."
          onClose={() => setFaulty(false)} onSubmit={(reason) => businessWrite(biz.id, "electronics/faulty", { skuId: u.sku_id, serial: u.serial, kind: "faulty", reason })}
          onSaved={() => { setFaulty(false); setVersion((n) => n + 1); onSaved?.(); toast.success(`${u.serial} is held for the supplier.`); }} />
      )}
    </>
  );
}

function DetailsDialog({ unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ imei2: unit.imei2 || "", note: unit.note || "" });
  return (
    <FormDialog title={`Details of ${unit.serial}`} icon="edit" width={520} onClose={onClose} onSaved={onSaved}
      description="Dual-SIM phones have a second IMEI; it is checked, and the unit can then be found by either."
      onSubmit={() => businessWrite(biz.id, "serials/details", { skuId: unit.sku_id, serial: unit.serial, imei2: form.imei2 || null, note: form.note || null }, "put")}>
      <Field label="Second IMEI (optional)"><input className="mono" inputMode="numeric" maxLength={15} value={form.imei2} onChange={(e) => setForm((f) => ({ ...f, imei2: e.target.value.replace(/\D/g, "") }))} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="e.g. Box opened for demo" /></Field>
    </FormDialog>
  );
}

function ModelDialog({ model, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ modelNumber: model.model_number || "", serialKind: model.serial_kind, warrantyMonths: String(model.warranty_months || 0), warrantyTerms: model.warranty_terms || "", helpline: model.helpline || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={model.label} icon="phone" width={620} onClose={onClose} onSaved={onSaved}
      description="Changing to IMEI checks numbers received from now on; units already in stock are not re-checked."
      onSubmit={() => businessWrite(biz.id, `electronics/models/${model.sku_id}`, { ...form, modelNumber: form.modelNumber || null, warrantyTerms: form.warrantyTerms || null, helpline: form.helpline || null }, "put")}>
      <Field label="Model number"><input maxLength={60} value={form.modelNumber} onChange={set("modelNumber")} /></Field>
      <Field label="Serials are">
        <select value={form.serialKind} onChange={set("serialKind")}><option value="imei">IMEI numbers (15 digits, checked)</option><option value="serial">Serial numbers</option></select>
      </Field>
      <Field label="Brand helpline (printed on the card)"><input maxLength={60} value={form.helpline} onChange={set("helpline")} placeholder="e.g. 1800 123 4567" /></Field>
      <Field label="Warranty (months)" hint="0 when the model has no warranty."><input type="number" min="0" max="120" step="1" value={form.warrantyMonths} onChange={set("warrantyMonths")} /></Field>
      <Field label="Warranty terms (printed on the card)" wide><textarea rows={3} maxLength={1000} value={form.warrantyTerms} onChange={set("warrantyTerms")} /></Field>
    </FormDialog>
  );
}

// --- Scanning a box of phones in (pro pass E-15) -------------------------------------------

// IMEI check digit (Luhn), as the server checks it.
const validImei = (code) => /^\d{15}$/.test(code) && [...code].reduce((sum, c, i) => {
  let d = Number(c);
  if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
  return sum + d;
}, 0) % 10 === 0;

// Model and cost once, then IMEI 1 / IMEI 2 per unit (scanner: Enter moves
// on), or two columns pasted from the distributor's sheet. One purchase.
function ScanInDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["electronics/models?active=true", "contacts?kind=supplier&active=true"]);
  const models = options?.["electronics/models?active=true"] || [];
  const suppliers = options?.["contacts?kind=supplier&active=true"] || [];
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ contactId: "", locationId: String(locations[0]?.id || ""), billNo: "", billDate: businessToday(biz.business.timezone), skuId: "", unitPrice: "", expected: "" });
  const [units, setUnits] = useState([]);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [paste, setPaste] = useState("");
  const [problem, setProblem] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const model = models.find((m) => String(m.sku_id) === form.skuId);
  const imei = model?.serial_kind === "imei";
  const taken = new Set(units.flatMap((u) => [u.serial, u.imei2].filter(Boolean)));
  const check = (a, b, seen = taken) => {
    if (!a) return "Scan IMEI 1.";
    if (imei && !validImei(a)) return `${a} is not a valid IMEI (15 digits with a check digit).`;
    if (b && !validImei(b)) return `IMEI 2 ${b} is not valid.`;
    if (b && a === b) return "IMEI 2 is the same as IMEI 1.";
    if (seen.has(a) || (b && seen.has(b))) return `${seen.has(a) ? a : b} is already in this list.`;
    return "";
  };
  const add = () => {
    const a = first.replace(/\s+/g, ""), b = second.replace(/\s+/g, "");
    const why = check(a, b);
    setProblem(why);
    if (why) return;
    setUnits((all) => [...all, { serial: a, imei2: b || null }]);
    setFirst(""); setSecond("");
    document.getElementById("fe-imei1")?.focus();
  };
  const addPasted = () => {
    const rows = paste.split(/\r?\n/).map((line) => line.split(/[\s,;\t]+/).filter(Boolean)).filter((r) => r.length);
    const added = [];
    const seen = new Set(taken);
    for (const [a, b] of rows) {
      const why = check(a, b, seen);
      if (why) { setProblem(why); return; }
      added.push({ serial: a, imei2: b || null }); seen.add(a); if (b) seen.add(b);
    }
    setUnits((all) => [...all, ...added]); setPaste(""); setProblem("");
  };
  const expected = Number(form.expected) || 0;
  const submit = () => {
    if (!units.length) return Promise.reject(refuse("Scan at least one unit."));
    return businessWrite(biz.id, "electronics/receipts", { requestKey, contactId: form.contactId, locationId: form.locationId,
      ...(form.billNo.trim() ? { supplierBillNo: form.billNo.trim(), supplierBillDate: form.billDate || undefined } : {}),
      lines: [{ skuId: form.skuId, unitPrice: form.unitPrice, units }] });
  };
  return (
    <FormDialog title="Scan phones in" icon="truck" width={860} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={!options}
      submitLabel={units.length ? `Receive ${units.length} unit${units.length === 1 ? "" : "s"}` : "Receive"}
      description="Choose the model and its cost once, then scan IMEI 1 and IMEI 2 from each box. Every number is checked before anything is saved.">
      <FormError message={error} />
      <Field label="Supplier"><select required value={form.contactId} onChange={set("contactId")}><option value="">Choose…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      {locations.length > 1 ? <Field label="Into"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field> : <span />}
      <Field label="Supplier bill number (optional)"><input maxLength={60} value={form.billNo} onChange={set("billNo")} /></Field>
      <Field label="Bill date"><input type="date" value={form.billDate} onChange={set("billDate")} /></Field>
      <Field label="Model"><select required value={form.skuId} onChange={set("skuId")}><option value="">Choose…</option>{models.map((m) => <option key={m.sku_id} value={m.sku_id}>{m.label}{m.serial_kind === "imei" ? " · IMEI" : ""}</option>)}</select></Field>
      <Field label="Cost per unit (before GST)"><input required type="number" min="0" step="0.01" value={form.unitPrice} onChange={set("unitPrice")} /></Field>
      <Field label="Units on the bill (optional)" hint="Shows how many are still to scan."><input type="number" min="0" step="1" value={form.expected} onChange={set("expected")} /></Field>
      <div className="field-wide fe-inline-row">
        <Field label="IMEI 1"><input id="fe-imei1" className="mono" inputMode="numeric" maxLength={30} value={first} disabled={!form.skuId} onChange={(e) => setFirst(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); document.getElementById("fe-imei2")?.focus(); } }} /></Field>
        <Field label="IMEI 2 (dual SIM)"><input id="fe-imei2" className="mono" inputMode="numeric" maxLength={30} value={second} disabled={!form.skuId} onChange={(e) => setSecond(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /></Field>
        <button type="button" className="button button-secondary" disabled={!form.skuId || !first.trim()} onClick={add}><Icon name="plus" size={15} /> Add unit</button>
      </div>
      {problem && <p className="field-wide fe-warn" role="alert"><Icon name="alert" size={15} /> {problem}</p>}
      <details className="field-wide">
        <summary>Paste from a sheet (IMEI 1 and IMEI 2 per line)</summary>
        <textarea rows={4} className="mono" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"356731910001007 356731910001015\n356731910001023 356731910001031"} />
        <button type="button" className="button button-secondary button-sm" disabled={!paste.trim() || !form.skuId} onClick={addPasted}>Add these</button>
      </details>
      <div className="field-wide">
        <p className="small"><strong>{units.length}</strong> scanned{expected ? ` of ${expected} · ${Math.max(0, expected - units.length)} to go` : ""}{model ? ` · ${model.label}` : ""}</p>
        {units.length > 0 && (
          <DataGrid variant="compact" caption="Units scanned" rows={units} rowKey={(u) => u.serial} rowNoun={["unit", "units"]} columns={[
            { key: "serial", header: "IMEI 1", value: (u) => u.serial, className: "mono", mobile: "title" },
            { key: "imei2", header: "IMEI 2", value: (u) => u.imei2 || "", className: "mono", mobile: "show" },
            { key: "remove", header: "", label: "Remove", type: "actions", render: (u) => <button type="button" className="link-button danger" onClick={() => setUnits((all) => all.filter((x) => x.serial !== u.serial))}>Remove</button> },
          ]} />
        )}
      </div>
    </FormDialog>
  );
}

// --- Faulty units and DOA (pro pass E-17) ----------------------------------------------------

const FAULTY_STATES = { awaiting_supplier: ["pending", "Waiting for supplier"], sent: ["info", "Sent back"], restocked: ["active", "Found fine"], written_off: ["inactive", "Written off"] };

function FaultyUnits() {
  const biz = useOpenBusiness();
  const [status, setStatus] = useState("awaiting_supplier");
  const list = useServerList("electronics/faulty", { gridId: "electronics-faulty", params: status ? { status } : {} });
  const [sending, setSending] = useState(null);
  const [closing, setClosing] = useState(null);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="alert" title="Faulty and dead-on-arrival units"
        description="A faulty unit stays in stock but cannot be sold. Send it back to the supplier (a purchase return on the bill it came in on), or close it if it was fine or is written off.">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "IMEI, model, supplier or claim" }} caption="Faulty units" currency={biz.symbol} rowNoun={["unit", "units"]}
          toolbar={<Segmented label="Status" options={[{ value: "awaiting_supplier", label: "Waiting" }, { value: "sent", label: "Sent back" }, { value: "", label: "All" }]} value={status} onChange={setStatus} />}
          columns={[
            { key: "serial", header: "IMEI / serial", value: (f) => f.serial, className: "mono", mobile: "title", pin: true,
              render: (f) => <span className="bz-two-line"><strong className="mono">{f.serial}</strong><small className="muted">{f.label}</small></span> },
            { key: "kind", header: "Why", value: (f) => (f.kind === "doa" ? "Dead on arrival" : "Faulty"), mobile: "subtitle",
              render: (f) => <span className="bz-two-line"><span>{f.kind === "doa" ? "Dead on arrival" : "Faulty"}</span><small className="muted">{f.reason}</small></span> },
            { key: "replacement", header: "Replaced by", value: (f) => f.replacement_serial || "", className: "mono", render: (f) => (f.replacement_serial ? <span className="bz-two-line"><span className="mono">{f.replacement_serial}</span><small className="muted">{f.sold_no}</small></span> : "—") },
            { key: "supplier", header: "Supplier", value: (f) => f.supplier_name || "", mobile: "show", render: (f) => <span className="bz-two-line"><span>{f.supplier_name || "—"}</span><small className="muted mono">{f.purchase_no || ""}</small></span> },
            { key: "status", header: "Status", value: (f) => f.status, render: (f) => <StatusBadge status={FAULTY_STATES[f.status]?.[0]} label={FAULTY_STATES[f.status]?.[1]} />, mobile: "show" },
            { key: "claim", header: "Claim / return", value: (f) => [f.claim_no, f.purchase_return_no].filter(Boolean).join(" · "), className: "mono" },
            { key: "where", header: "Where", value: (f) => f.location_name || "", defaultHidden: biz.locations.length < 2 },
            { key: "created_at", header: "Since", type: "date", value: (f) => f.created_at },
            { key: "actions", header: "", label: "Actions", type: "actions", render: (f) => (f.status === "awaiting_supplier" ? (
              <div className="row-actions">
                {biz.can("purchasing.refund") && biz.can("inventory.edit") && <button type="button" className="chip-button" onClick={() => setSending(f)}><Icon name="truck" size={14} /> Send back</button>}
                {biz.can("inventory.edit") && <button type="button" className="chip-button" onClick={() => setClosing(f)}>Close</button>}
              </div>) : null) },
          ]} empty={status === "awaiting_supplier" ? "No faulty units waiting" : "Nothing here"} emptyHint="Units marked dead on arrival in an exchange, or faulty from the unit's history, appear here." emptyIcon="alert" />
      </SectionCard>
      {sending && <SendDialog unit={sending} onClose={() => setSending(null)} onSaved={(r) => { setSending(null); toast.success(`${r.serial} sent back on ${r.return_no}.`); list.reload(); }} />}
      {closing && <CloseDialog unit={closing} onClose={() => setClosing(null)} onSaved={() => { setClosing(null); toast.success("Closed."); list.reload(); }} />}
    </>
  );
}

function SendDialog({ unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ claimNo: "", note: "" });
  return (
    <FormDialog title={`Send ${unit.serial} back`} icon="truck" width={540} onClose={onClose} onSaved={onSaved} submitLabel="Post the return to the supplier"
      description={`A purchase return on ${unit.purchase_no || "the bill it came in on"}${unit.supplier_name ? ` to ${unit.supplier_name}` : ""}; the supplier owes you its cost.`}
      onSubmit={() => businessWrite(biz.id, `electronics/faulty/${unit.id}/send`, { requestKey, claimNo: form.claimNo || undefined, note: form.note || undefined })}>
      <Field label="Claim / RMA number (optional)"><input maxLength={60} value={form.claimNo} onChange={(e) => setForm((f) => ({ ...f, claimNo: e.target.value }))} /></Field>
      <Field label="Note (optional)"><input maxLength={300} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></Field>
    </FormDialog>
  );
}

function CloseDialog({ unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ status: "restocked", note: "" });
  return (
    <FormDialog title={`Close ${unit.serial}`} icon="check" width={540} onClose={onClose} onSaved={onSaved} submitLabel={form.status === "restocked" ? "Sellable again" : "Write it off"}
      onSubmit={() => businessWrite(biz.id, `electronics/faulty/${unit.id}/close`, { requestKey, ...form })}>
      <Field label="Outcome"><select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}><option value="restocked">Found fine: sell it again</option><option value="written_off">Write it off (leaves stock)</option></select></Field>
      <Field label="Note" wide><input required maxLength={300} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder={form.status === "restocked" ? "e.g. Tested, works" : "e.g. Supplier refused the claim"} /></Field>
    </FormDialog>
  );
}
