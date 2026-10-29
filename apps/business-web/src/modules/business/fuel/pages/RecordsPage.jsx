import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { escapeHtml, printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { OutletPicker } from "./FuelParts";
import { atWords, dayWords, firstOutlet, qty, reading } from "./fuel";
import "../styles/fuel.css";

// A fuel station's records: the daily sales register printed from the shifts
// closed on a day (each nozzle's readings and the test pumped back, each
// fuel's sales at its price), and the inspection log (when, by whom, what was
// found and what was done), kept as written and never erased. The register is
// the station's own: the oil companies' own formats are not matched.

export default function RecordsPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [locationId, setLocationId] = useState(firstOutlet(biz));
  const [date, setDate] = useState(today);
  const [register, setRegister] = useState(null);
  const [log, setLog] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "fuel/sales-register", { date, locationId }, controller.signal), businessRead(biz.id, "fuel/inspections", { locationId }, controller.signal)])
      .then(([r, l]) => { setRegister(r); setLog(l); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, date, locationId, version]);
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Registers & inspections" description="The daily sales register from the shifts, and every inspection of the outlet, kept for good."
        primary={register && biz.can("fuel.print") && <button type="button" className="button button-secondary" onClick={() => printRegister(biz, register)}><Icon name="print" size={16} /> Print the day's register</button>} />
      <div className="fuel-toolbar">
        <OutletPicker biz={biz} value={locationId} onChange={setLocationId} />
        <label className="field fuel-outlet"><span>Day</span><input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
      </div>
      <ErrorMessage message={error} />
      {!register ? !error && <Loading /> : (
        <SectionCard flush icon="clipboard" title={`Daily sales register · ${dayWords(register.date)}`} description={register.formatsNote}>
          <DataGrid variant="compact" id="fuel-sales-register" caption="Daily sales register" rows={register.fuels} rowKey={(f) => f.productId} currency={biz.symbol} rowNoun={["fuel", "fuels"]}
            columns={[
              { key: "name", header: "Fuel", value: (f) => f.name, mobile: "title" },
              { key: "litres", header: "Sold", value: (f) => Number(f.litres), render: (f) => qty(f.litres, f.unit), mobile: "subtitle" },
              { key: "credit", header: "On credit", value: (f) => Number(f.credit), render: (f) => qty(f.credit, f.unit) },
              { key: "big", header: "Big fills", value: (f) => Number(f.big), render: (f) => qty(f.big, f.unit), defaultHidden: true },
              { key: "walk", header: "Walk-in", value: (f) => Number(f.walkIn), render: (f) => qty(f.walkIn, f.unit) },
              register.money && { key: "price", header: "Price", value: (f) => f.prices.join(", "), render: (f) => f.prices.map((p) => biz.exact(p)).join(" · ") },
              register.money && { key: "amount", header: "Amount", type: "money", exact: true, value: (f) => Number(f.amount), total: "sum", mobile: "show" },
            ].filter(Boolean)}
            empty="No shift closed on this day" emptyIcon="logbook" />
          {register.shifts.map((s) => (
            <details key={s.shiftId} className="fuel-details">
              <summary>Shift {s.shiftNo} · {s.attendant} · closed {atWords(s.closedAt, biz)}</summary>
              <ul className="fuel-history">
                {s.nozzles.map((n) => <li key={n.nozzle_no}>Nozzle {n.nozzle_no} · {n.product_name}{n.tank_no ? ` · tank ${n.tank_no}` : ""}: {reading(n.opening)} → {reading(n.closing)}, test {qty(n.test, n.unit)}, sold {qty(n.litres, n.unit)}</li>)}
              </ul>
            </details>
          ))}
        </SectionCard>
      )}
      <SectionCard flush icon="shield" title="Inspection log" description="Each inspection, as written: it is never changed or erased. A later entry adds to it."
        actions={biz.can("fuel.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Record an inspection</button>}>
        <DataGrid variant="compact" id="fuel-inspections" caption="Inspection log" rows={log || []} loading={!log && !error} rowKey={(i) => i.id} rowNoun={["inspection", "inspections"]}
          exportName={biz.can("fuel.export") ? `${biz.business.code}-inspections` : undefined}
          columns={[
            { key: "on", header: "Inspected on", value: (i) => i.inspected_on, render: (i) => dayWords(i.inspected_on), mobile: "title" },
            { key: "by", header: "By", value: (i) => `${i.inspected_by}${i.authority ? ` (${i.authority})` : ""}`, mobile: "subtitle" },
            { key: "findings", header: "Found", value: (i) => i.findings },
            { key: "actions", header: "Done", value: (i) => i.actions || "" },
            { key: "location", header: "Outlet", value: (i) => i.location_name, defaultHidden: true },
          ]}
          empty="No inspection recorded" emptyIcon="shield" />
      </SectionCard>
      {adding && <InspectionDialog biz={biz} locationId={locationId} onClose={() => setAdding(false)}
        onSaved={() => { setAdding(false); toast.success("Inspection recorded."); setVersion((n) => n + 1); }} />}
    </div>
  );
}

function InspectionDialog({ biz, locationId, onClose, onSaved }) {
  const [form, setForm] = useState({ inspectedOn: businessToday(biz.business.timezone), inspectedBy: "", authority: "", findings: "", actions: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Record an inspection" icon="shield" width={600} onClose={onClose} onSaved={onSaved} submitLabel="Record it"
      description="Once recorded, an inspection is kept as written and never erased."
      onSubmit={() => businessWrite(biz.id, "fuel/inspections", { locationId, inspectedOn: form.inspectedOn, inspectedBy: form.inspectedBy.trim(), authority: form.authority.trim() || null,
        findings: form.findings.trim(), actions: form.actions.trim() || null })}>
      <Field label="Inspected on"><input type="date" required value={form.inspectedOn} onChange={set("inspectedOn")} /></Field>
      <Field label="By whom"><input required maxLength={150} value={form.inspectedBy} onChange={set("inspectedBy")} placeholder="Name and post" /></Field>
      <Field label="For (optional)"><input maxLength={150} value={form.authority} onChange={set("authority")} placeholder="Oil company, Weights & Measures, PESO …" /></Field>
      <Field label="What was found" wide><textarea required maxLength={2000} rows={3} value={form.findings} onChange={set("findings")} /></Field>
      <Field label="What was done (optional)" wide><textarea maxLength={2000} rows={2} value={form.actions} onChange={set("actions")} /></Field>
    </FormDialog>
  );
}

// The day's register on A4.
function printRegister(biz, register) {
  const fuels = register.fuels.map((f) => `<tr><td>${escapeHtml(f.name)}</td><td class="r">${escapeHtml(qty(f.litres, f.unit))}</td><td class="r">${escapeHtml(qty(f.credit, f.unit))}</td>
    <td class="r">${escapeHtml(qty(f.walkIn, f.unit))}</td><td class="r">${register.money ? escapeHtml(f.prices.map((p) => biz.exact(p)).join(", ")) : ""}</td>
    <td class="r">${register.money ? escapeHtml(biz.exact(f.amount)) : ""}</td></tr>`).join("");
  const shifts = register.shifts.map((s) => s.nozzles.map((n) => `<tr><td>${escapeHtml(s.shiftNo)}</td><td>${escapeHtml(s.attendant)}</td><td>${escapeHtml(n.nozzle_no)} · ${escapeHtml(n.product_name)}</td>
    <td class="r">${escapeHtml(reading(n.opening))}</td><td class="r">${escapeHtml(reading(n.closing))}</td><td class="r">${escapeHtml(qty(n.test, n.unit))}</td>
    <td class="r">${escapeHtml(qty(n.litres, n.unit))}</td></tr>`).join("")).join("");
  printDocument({
    title: `Sales register ${register.date}`,
    styles: "@page{size:A4;margin:12mm} body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} small{color:#555} table{width:100%;border-collapse:collapse;margin-top:8px}"
      + " td,th{border:1px solid #bbb;padding:4px 6px;text-align:left} th{background:#f2f2f2} .r{text-align:right} .note{font-size:11px;margin-top:8px}",
    body: `<h1>${escapeHtml(biz.business.name)} · ${escapeHtml(register.location.name)}</h1><small>Daily sales register · ${escapeHtml(dayWords(register.date))}</small>
      <table><thead><tr><th>Shift</th><th>Attendant</th><th>Nozzle</th><th class="r">Opening</th><th class="r">Closing</th><th class="r">Test</th><th class="r">Sold</th></tr></thead><tbody>${shifts}</tbody></table>
      <table><thead><tr><th>Fuel</th><th class="r">Sold</th><th class="r">On credit</th><th class="r">Walk-in</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>${fuels}</tbody></table>
      ${register.money ? `<p><strong>Total: ${escapeHtml(biz.exact(register.total))}</strong></p>` : ""}<p class="note">${escapeHtml(register.formatsNote)}</p>`,
  });
}
