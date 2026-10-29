import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { FUEL_TYPES, LATE, PAPERS, SLAB_NOTE, VEHICLES, VEHICLE_CLASSES, paperState, rateWords, slabWords, wordOf } from "./rentals";
import { printUnitLabels } from "./rentalsPrint";
import "../styles/rentals.css";

// Rental items: each thing hired out, billed as a service item of the
// catalogue (its name on the bill, its GST slab: the slab of a sale of the
// like goods), hired one by one (each unit with its own name and number),
// from a pool of how many the shop has (counted at each location), or as a
// kit of pooled parts (billed as the kit or by its parts); a motor vehicle
// self-drive or with the shop's driver, with a kilometre allowance and a fuel
// charge; a meter read at each handover and return; the deposit for each one
// hired; rates by the hour, day, week and month; the minimum hire, the
// turnaround time between hires and the late fee after a grace time (by the
// hour, the day or slabs, with a cap). Bookings keep the rates and rules they
// were made at. Below: each unit (a vehicle with its class, engine, length,
// fuel, papers and the slab they make), the classes with their checklists,
// and the handover settings.

const UNIT_STATES = { available: { label: "In service", tone: "success" }, maintenance: { label: "In maintenance", tone: "warning" }, retired: { label: "Retired", tone: "neutral" } };
const meterUnit = (item) => (item.meter === "km" ? "km" : item.meter === "hours" ? "h" : "");
const hiredWords = (i) => (i.kind === "pool" ? `${i.pool_quantity} in the pool` : i.kind === "kit" ? `a kit of ${i.parts.length} ${i.parts.length === 1 ? "part" : "parts"}`
  : `${i.units_in_service} ${i.units_in_service === 1 ? "unit" : "units"}`);
const vehicleWords = (i) => (!i.vehicle ? "" : `${wordOf(VEHICLES, i.vehicle)}, ${i.with_driver ? "with the shop's driver" : "self-drive"}`);
const selfDrive = (i) => ["car", "motorcycle"].includes(i.vehicle) && !i.with_driver;

// "₹400 an hour after 30 min", "the day rate a day", "None", "by slabs".
function lateText(i, exact) {
  if (i.late_per === "none") return "None";
  if (i.late_per === "slabs") return `By slabs${i.late_slabs ? "" : ` (${i.class_name || "its class"})`}${i.late_cap ? `, at most ${exact(i.late_cap)}` : ""}`;
  const rate = i.late_rate !== null && i.late_rate !== undefined ? exact(i.late_rate) : i.late_per === "hour" ? `${exact(i.rate_hour)}` : `${exact(i.rate_day)}`;
  return `${rate} ${i.late_per === "hour" ? "an hour" : "a day"}${Number(i.grace_minutes) ? ` after ${i.grace_minutes} min` : ""}${i.late_cap ? `, at most ${exact(i.late_cap)}` : ""}`;
}
// "100 km a day free, ₹12 a km more · fuel ₹300 an eighth".
function fleetWords(i, exact) {
  return [i.km_per ? `${i.km_allowance} km a ${i.km_per} free, ${exact(i.extra_km_rate)} a km more` : null,
    i.fuel_per ? `fuel ${exact(i.fuel_rate)} ${i.fuel_per === "eighth" ? "an eighth of a tank" : `a litre (${Number(i.tank_litres)} L tank)`} short` : null].filter(Boolean).join(" · ");
}

export default function RentalItemsPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [showOff, setShowOff] = useState(false);
  const canEdit = biz.can("catalog.edit");
  const canYard = biz.can("rentals.edit");
  const today = businessToday(biz.business.timezone);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "rentals/items", undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const items = useMemo(() => (data?.items || []).filter((i) => showOff || i.active), [data, showOff]);
  const units = useMemo(() => (data?.items || []).filter((i) => i.kind === "unit" && (showOff || i.active))
    .flatMap((i) => i.units.filter((u) => showOff || u.status !== "retired").map((u) => ({ ...u, item: i }))), [data, showOff]);
  const setUnitState = (u, status, statusNote) => businessWrite(biz.id, `rentals/units/${u.id}`, { status, ...(statusNote ? { statusNote } : {}) }, "patch")
    .then(() => reload(`${u.label} ${UNIT_STATES[status].label.toLowerCase()}.`)).catch((err) => toast.error(getErrorMessage(err)));

  if (!data) return <div className="stack"><BusinessHeader icon="key" title="Rental items" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const selfDriving = (data.items || []).filter((i) => i.active && selfDrive(i));
  const many = biz.locations.filter((l) => l.active).length > 1;
  const settings = data.settings;

  return (
    <div className="stack">
      <BusinessHeader icon="key" title="Rental items"
        description="What the shop hires out, with its rates, deposit and late fee. A booking keeps the rates and rules it was made at; the activity log keeps every change."
        primary={canEdit && <button type="button" className="button" onClick={() => setDialog({ kind: "item" })}><Icon name="plus" size={16} /> Add a rental item</button>} />
      <ErrorMessage message={error} />
      {selfDriving.length > 0 && (
        <p className="rnt-note rnt-warn">
          {selfDriving.map((i) => i.name).join(", ")} {selfDriving.length === 1 ? "goes" : "go"} out self-drive: each location needs the State Transport Authority's rent-a-cab
          (cars) or rent-a-motorcycle licence in force, kept under {biz.can("licences.view") && biz.has("licences") ? <Link to={biz.path("licences")}>Settings › Licences</Link> : "Settings › Licences"}.
          A vehicle is handed over only on the hirer's driving licence, with its date, and goes in the hirer register.
        </p>
      )}
      {(data.warnings || []).map((w) => <p key={w} className="rnt-note rnt-warn" role="status">{w}</p>)}
      <SectionCard flush icon="key" title="Items" description="Each item is billed as a service item: its name on the bill and its GST slab come from the item. Renting goods out is taxed at the slab of a sale of the like goods.">
        <DataGrid variant="compact" id="rental-items" caption="Rental items" rows={items} rowKey={(i) => i.id} currency={biz.symbol} rowNoun={["item", "items"]}
          rowClassName={(i) => (i.active ? "" : "dg-tone-muted")}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show items and units not in use</label>}
          columns={[
            { key: "name", header: "Item", value: (i) => i.name, mobile: "title", pin: true,
              render: (i) => (
                <span className="bz-two-line">
                  {canEdit ? <button type="button" className="link-button" onClick={() => setDialog({ kind: "item", item: i })}>{i.name}</button> : <span>{i.name}</span>}
                  <small className="muted"><span className="mono">{i.item_code}</span> · GST {Number(i.tax_rate)}%{i.hsn_code ? ` · SAC ${i.hsn_code}` : ""}{i.class_name ? ` · ${i.class_name}` : ""}</small>
                </span>
              ) },
            { key: "hired", header: "Hired out", value: (i) => hiredWords(i), mobile: "show",
              render: (i) => <span className="bz-two-line"><span>{hiredWords(i)}</span><small className="muted">{[vehicleWords(i),
                i.kind === "kit" ? `${i.parts.map((p) => `${p.quantity} × ${p.name}`).join(", ")} · billed ${i.kit_billing === "kit" ? "as the kit" : "by its parts"}` : null,
                i.kind === "pool" && many ? i.counts.map((c) => `${c.quantity} at ${c.location_name}`).join(", ") : null,
                Number(i.out_now) ? `${i.out_now} out now` : null].filter(Boolean).join(" · ") || "one by one"}</small></span> },
            { key: "rates", header: "Rates", value: (i) => (i.kind === "kit" && i.kit_billing === "parts" ? "Its parts' rates" : rateWords(i, biz.exact)), mobile: "subtitle" },
            { key: "deposit", header: "Deposit each", type: "money", exact: true, value: (i) => Number(i.deposit) },
            { key: "late", header: "Late fee", value: (i) => (i.kind === "kit" ? "Its parts'" : lateText(i, biz.exact)) },
            { key: "fleet", header: "Kilometres · fuel", value: (i) => fleetWords(i, biz.exact), defaultHidden: !(data.items || []).some((i) => i.vehicle) },
            { key: "rules", header: "Minimum · turnaround", value: (i) => `${i.min_hours} h · ${i.buffer_minutes} min`,
              render: (i) => <span className="small">{Number(i.min_hours) ? `${i.min_hours} h minimum` : "No minimum"} · {Number(i.buffer_minutes) ? `${i.buffer_minutes} min between hires` : "no turnaround"}</span> },
            { key: "active", header: "In use", value: (i) => (i.active ? "Yes" : "No"), render: (i) => <ActiveBadge active={i.active && i.item_active} /> },
            canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (i) => (i.kind === "unit" && i.active
              ? <button type="button" className="chip-button" onClick={() => setDialog({ kind: "unit", item: i })}><Icon name="plus" size={13} /> Add a unit</button> : null) },
          ].filter(Boolean)}
          empty="No rental items yet" emptyHint={canEdit ? "Add what the shop hires out: a generator, chairs and tables, a shamiana set, a car." : undefined} emptyIcon="key" />
      </SectionCard>
      <SectionCard flush icon="list" title="Units" description="Each unit of an item hired one by one, where it is kept. A unit in maintenance is not handed over; a retired one is not booked."
        actions={units.length > 0 && biz.can("rentals.print") && <button type="button" className="button button-secondary button-sm" onClick={() => printUnitLabels(biz, units.filter((u) => u.serial_no))}><Icon name="print" size={14} /> Barcode labels</button>}>
        <DataGrid variant="compact" id="rental-units" caption="Units" rows={units} rowKey={(u) => u.id} rowNoun={["unit", "units"]}
          rowClassName={(u) => (u.status === "retired" ? "dg-tone-muted" : u.status === "maintenance" || u.slab_warning ? "dg-tone-warning" : "")}
          columns={[
            { key: "label", header: "Unit", value: (u) => `${u.label} ${u.serial_no || ""}`, mobile: "title", pin: true,
              render: (u) => <span className="bz-two-line"><span>{u.label}</span>{u.serial_no && <small className="mono muted">{u.serial_no}</small>}</span> },
            { key: "item", header: "Item", value: (u) => u.item.name, mobile: "subtitle" },
            { key: "location", header: "Kept at", value: (u) => u.location_name, defaultHidden: !many },
            { key: "meter", header: "Meter", value: (u) => (u.meter_reading === null ? "" : Number(u.meter_reading)),
              render: (u) => (u.meter_reading === null ? <span className="muted">—</span> : `${Number(u.meter_reading)} ${meterUnit(u.item)}`) },
            { key: "vehicle", header: "Vehicle", value: (u) => [u.vehicle_class, u.engine_cc ? `${u.engine_cc} cc` : null, u.fuel_type].filter(Boolean).join(" · "),
              defaultHidden: !units.some((u) => u.item.vehicle),
              render: (u) => (!u.item.vehicle ? <span className="muted">—</span> : (
                <span className="bz-two-line"><span>{[u.vehicle_class, u.engine_cc ? `${u.engine_cc} cc` : null, u.length_mm ? `${u.length_mm} mm` : null, wordOf(FUEL_TYPES, u.fuel_type)].filter(Boolean).join(" · ") || "Not given"}</span>
                  {u.slab !== null && u.slab !== undefined && <small className={u.slab_matches ? "muted" : "bz-due"}>{u.slab_matches ? `${u.slab}% as the like goods` : `${u.slab}% as the like goods: the item is billed at ${Number(u.item.tax_rate)}%`}</small>}</span>)) },
            { key: "papers", header: "Papers", value: (u) => PAPERS.filter((p) => u[p.column]).map((p) => `${p.label} ${u[p.column]}`).join(", "), defaultHidden: !units.some((u) => u.item.vehicle),
              render: (u) => {
                const kept = PAPERS.map((p) => ({ ...p, state: paperState(u[p.column], today, settings.papersWarnDays, settings.papersUrgentDays) })).filter((p) => p.state);
                return kept.length ? <span className="rnt-papers">{kept.map((p) => <Badge key={p.key} tone={p.state.tone} label={`${p.label}: ${p.state.words}`} />)}</span> : <span className="muted">—</span>;
              } },
            { key: "status", header: "State", type: "status", value: (u) => UNIT_STATES[u.status].label, mobile: "show",
              render: (u) => <span className="bz-two-line"><Badge tone={UNIT_STATES[u.status].tone} label={UNIT_STATES[u.status].label} />{u.status_note && <small className="muted">{u.status_note}</small>}</span> },
            (canEdit || canYard) && { key: "actions", header: "", label: "Actions", type: "actions", render: (u) => (
              <span className="rnt-actions">
                {canEdit && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "unit", item: u.item, unit: u })}>Details</button>}
                {canYard && u.status === "available" && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "state", unit: u, status: "maintenance" })}>Send for maintenance</button>}
                {canYard && u.status !== "available" && <button type="button" className="chip-button" onClick={() => setUnitState(u, "available")}>Back in service</button>}
                {canYard && u.status !== "retired" && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "state", unit: u, status: "retired" })}>Retire</button>}
              </span>
            ) },
          ].filter(Boolean)}
          empty="No units" emptyHint="An item hired one by one has a unit for each one the shop has, each with its own name and number." emptyIcon="list" />
      </SectionCard>
      <SectionCard flush icon="list" title="Classes" description="A class's checklist is checked at every handover and return of its items; its late fee slabs stand in for an item's own."
        actions={canEdit && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "class" })}><Icon name="plus" size={14} /> Add a class</button>}>
        <DataGrid variant="compact" id="rental-classes" caption="Classes" rows={(data.classes || []).filter((k) => showOff || k.active)} rowKey={(k) => k.id} rowNoun={["class", "classes"]}
          columns={[
            { key: "name", header: "Class", value: (k) => k.name, mobile: "title", pin: true,
              render: (k) => (canEdit ? <button type="button" className="link-button" onClick={() => setDialog({ kind: "class", value: k })}>{k.name}</button> : k.name) },
            { key: "checklist", header: "Checklist", value: (k) => k.checklist.join(", ") || "—", mobile: "subtitle" },
            { key: "slabs", header: "Late fee slabs", value: (k) => (k.late_slabs ? `${slabWords(k.late_slabs, biz.exact)}${k.late_cap ? `; at most ${biz.exact(k.late_cap)}` : ""}` : "—") },
            { key: "items", header: "Items", type: "number", value: (k) => k.items },
            { key: "active", header: "In use", value: (k) => (k.active ? "Yes" : "No"), render: (k) => <ActiveBadge active={k.active} /> },
          ]}
          empty="No classes yet" emptyHint="A class (two-wheelers, cars, tents) keeps the checklist its items are checked against." emptyIcon="categories" />
      </SectionCard>
      <HandoverSettings settings={settings} onSaved={(s) => setData((d) => ({ ...d, settings: s }))} />
      {dialog?.kind === "item" && <ItemDialog item={dialog.item || null} items={data.items} classes={data.classes || []} onClose={() => setDialog(null)}
        onSaved={() => reload(dialog.item ? "Rental item saved." : "Rental item added.")} />}
      {dialog?.kind === "unit" && <UnitDialog item={dialog.item} unit={dialog.unit || null} onClose={() => setDialog(null)} onSaved={() => reload(dialog.unit ? "Unit saved." : "Unit added.")} />}
      {dialog?.kind === "class" && <ClassDialog value={dialog.value || null} onClose={() => setDialog(null)} onSaved={() => reload(dialog.value ? "Class saved." : "Class added.")} />}
      {dialog?.kind === "state" && <UnitStateDialog unit={dialog.unit} status={dialog.status} onClose={() => setDialog(null)}
        onSaved={() => reload(`${dialog.unit.label} ${UNIT_STATES[dialog.status].label.toLowerCase()}.`)} />}
    </div>
  );
}

// Late fee slabs as typed: from so many hours late, a flat amount and/or a multiple of the hourly rate.
const blankSlab = (from = "") => ({ key: newKey(), from, flat: "", times: "" });
const slabsOf = (list) => (list || []).map((s) => ({ key: newKey(), from: String(s.from), flat: Number(s.flat) ? String(Number(s.flat)) : "", times: Number(s.times) ? String(Number(s.times)) : "" }));
const slabsBody = (rows) => rows.map((s, i) => ({ from: i === 0 ? 0 : s.from, flat: s.flat || "0", times: s.times || "0" }));
function SlabsEditor({ rows, onChange, symbol }) {
  const set = (k, name) => (e) => onChange(rows.map((s) => (s.key === k ? { ...s, [name]: e.target.value } : s)));
  return (
    <fieldset className="field-wide rnt-fieldset">
      <legend>Late fee slabs</legend>
      {rows.map((s, i) => (
        <div key={s.key} className="rnt-unit-row">
          <Field label={i === 0 ? "From (hours late)" : "From more than (hours late)"}><input type="number" min="0" step="1" disabled={i === 0} value={i === 0 ? "0" : s.from} onChange={set(s.key, "from")} /></Field>
          <Field label={`Flat amount (${symbol})`}><input type="number" min="0" step="0.01" value={s.flat} onChange={set(s.key, "flat")} /></Field>
          <Field label="Times the hour rate, each hour"><input type="number" min="0" step="0.01" value={s.times} onChange={set(s.key, "times")} /></Field>
          {rows.length > 1 && i > 0 && <button type="button" className="link-button danger" onClick={() => onChange(rows.filter((x) => x.key !== s.key))}>Remove</button>}
        </div>
      ))}
      <button type="button" className="chip-button" onClick={() => onChange([...rows, blankSlab()])}><Icon name="plus" size={13} /> Another slab</button>
      <small className="muted field-wide">The slab the hours late fall in prices all of them: e.g. up to 3 hours a flat ₹100 and twice the hour rate an hour, more than 3 hours five times the hour rate. These are the shop's own terms.</small>
    </fieldset>
  );
}

// A class: its checklist and late fee slabs with a cap.
function ClassDialog({ value, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => ({ name: value?.name || "", checklist: (value?.checklist || []).join("\n"), cap: value?.late_cap ? String(Number(value.late_cap)) : "", active: value ? value.active : true }));
  const [slabs, setSlabs] = useState(() => (value?.late_slabs ? slabsOf(value.late_slabs) : []));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => businessWrite(biz.id, value ? `rentals/classes/${value.id}` : "rentals/classes", {
    name: form.name.trim(), checklist: form.checklist.split("\n").map((p) => p.trim()).filter(Boolean), lateSlabs: slabs.length ? slabsBody(slabs) : null,
    lateCap: slabs.length && form.cap ? form.cap : null, active: form.active }, value ? "patch" : "post");
  return (
    <FormDialog title={value ? `Change ${value.name}` : "Add a class"} icon="list" width={680} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel={value ? "Save" : "Add the class"}>
      <Field label="Name"><input required maxLength={80} value={form.name} onChange={set("name")} placeholder="e.g. Two-wheelers, Cars, Tents" /></Field>
      <Field label="Checklist (a point a line)" wide hint="Checked at every handover and return of its items; a point not as it should be is said why.">
        <textarea rows={4} value={form.checklist} onChange={set("checklist")} placeholder={"Body and paint\nTyres\nHelmet"} />
      </Field>
      {slabs.length ? <SlabsEditor rows={slabs} onChange={setSlabs} symbol={biz.symbol} />
        : <button type="button" className="chip-button field-wide" onClick={() => setSlabs([blankSlab("0")])}><Icon name="plus" size={13} /> Late fee slabs for its items</button>}
      {slabs.length > 0 && <Field label={`Most late fee for each one (${biz.symbol}, optional)`}><input type="number" min="0.01" step="0.01" value={form.cap} onChange={set("cap")} /></Field>}
      {value && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>}
    </FormDialog>
  );
}

// A vehicle's papers, the bell before each runs out, and cancellation slabs; a hirer's photo ID at every handover, and the shop's terms on the slips.
function HandoverSettings({ settings, onSaved }) {
  const biz = useOpenBusiness();
  const canEdit = biz.can("settings.edit");
  const [form, setForm] = useState(() => ({ idRequired: settings.idRequired, terms: settings.terms || "", warn: String(settings.papersWarnDays), urgent: String(settings.papersUrgentDays),
    lapsed: settings.papersLapsed, noShow: settings.noShowPercent === null ? "" : String(settings.noShowPercent) }));
  const [cancel, setCancel] = useState(() => (settings.cancelSlabs || []).map((s) => ({ key: newKey(), hours: String(s.hours), percent: String(s.percent) })));
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setRow = (k, name) => (e) => setCancel((all) => all.map((r) => (r.key === k ? { ...r, [name]: e.target.value } : r)));
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      onSaved(await businessWrite(biz.id, "rentals/settings", { idRequired: form.idRequired, terms: form.terms.trim() || null, papersWarnDays: form.warn, papersUrgentDays: form.urgent,
        papersLapsed: form.lapsed, cancelSlabs: cancel.filter((r) => r.hours !== "").map((r) => ({ hours: r.hours, percent: r.percent || "0" })), noShowPercent: form.noShow || null }, "put"));
      toast.success("Handover settings saved.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SectionCard icon="settings" title="Handover settings">
      <form className="form-grid bz-form" onSubmit={save}>
        <fieldset className="bz-fieldset" disabled={!canEdit || saving}>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.idRequired} onChange={set("idRequired")} /> Record the hirer's photo ID at every handover (of an Aadhaar card, only its last four digits are kept)</label>
          <Field label="Terms printed on the booking and handover slips" wide hint="The shop's terms in its own words: what the hirer looks after, the late fee, what a damage or loss costs.">
            <textarea rows={4} maxLength={2000} value={form.terms} onChange={set("terms")} placeholder="e.g. The hirer returns everything clean and in the condition noted at the handover." />
          </Field>
          <Field label="Warn of a vehicle's paper running out (days before)"><input type="number" min="1" max="365" step="1" value={form.warn} onChange={set("warn")} /></Field>
          <Field label="And again (days before)"><input type="number" min="0" max="365" step="1" value={form.urgent} onChange={set("urgent")} /></Field>
          <Field label="A vehicle with a paper run out">
            <select value={form.lapsed} onChange={set("lapsed")}><option value="refuse">Is not handed over</option><option value="warn">Is handed over, with a warning</option></select>
          </Field>
          <fieldset className="field-wide rnt-fieldset">
            <legend>Cancellation charges (the shop's terms; none until set)</legend>
            {cancel.map((r) => (
              <div key={r.key} className="rnt-unit-row">
                <Field label="Cancelled at least (hours before the out time)"><input type="number" min="0" max="2160" step="1" value={r.hours} onChange={setRow(r.key, "hours")} /></Field>
                <Field label="Charge (% of the hire)"><input type="number" min="0" max="100" step="0.01" value={r.percent} onChange={setRow(r.key, "percent")} /></Field>
                <button type="button" className="link-button danger" onClick={() => setCancel((all) => all.filter((x) => x.key !== r.key))}>Remove</button>
              </div>
            ))}
            <button type="button" className="chip-button" onClick={() => setCancel((all) => [...all, { key: newKey(), hours: "", percent: "" }])}><Icon name="plus" size={13} /> A slab</button>
            {cancel.length > 0 && <Field label="Not handed over by the out time, a no-show (% of the hire)"><input type="number" min="0" max="100" step="0.01" value={form.noShow} onChange={set("noShow")} /></Field>}
            <small className="muted field-wide">With slabs set, a reserved booking's cancellation charge is worked out from the hours left before its out time (e.g. more than 72 hours 10%, 24 to 72 hours 25%), billed with its GST; a manager may waive it.</small>
          </fieldset>
        </fieldset>
        {canEdit && <div className="form-actions"><button type="submit" className="button" disabled={saving}>{saving ? "Saving…" : "Save the settings"}</button></div>}
      </form>
    </SectionCard>
  );
}

const rateOf = (value) => (value === null || value === undefined ? "" : String(Number(value)));

// A rental item: added (its service item, how it is hired out, its units or parts) or changed (its rates and rules).
function ItemDialog({ item, items, classes, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(item ? [] : ["tax-rates?active=true"]);
  const slabs = options?.["tax-rates?active=true"] || [];
  const locations = biz.locations.filter((l) => l.active);
  const [existing, setExisting] = useState(null);
  const [form, setForm] = useState(() => ({
    kind: item?.kind || "unit", useExisting: false, name: "", taxRateId: "", hsnCode: "", vehicle: item?.vehicle || "", withDriver: Boolean(item?.with_driver),
    meter: item?.meter || "", poolQuantity: item?.kind === "pool" ? String(item.counts?.[0]?.quantity ?? item.pool_quantity) : "", locationId: String(item?.counts?.[0]?.location_id || locations[0]?.id || ""),
    rateHour: rateOf(item?.rate_hour), rateDay: rateOf(item?.rate_day), rateWeek: rateOf(item?.rate_week), rateMonth: rateOf(item?.rate_month),
    deposit: item ? rateOf(item.deposit) : "", minHours: item ? String(item.min_hours) : "0", bufferMinutes: item ? String(item.buffer_minutes) : "0",
    graceMinutes: item ? String(item.grace_minutes) : "0", latePer: item?.late_per || "hour", lateRate: rateOf(item?.late_rate), lateCap: rateOf(item?.late_cap), description: item?.description || "",
    sortOrder: item ? String(item.sort_order) : "0", active: item ? item.active : true, classId: item?.class_id ? String(item.class_id) : "", kitBilling: item?.kit_billing || "kit",
    kmPer: item?.km_per || "", kmAllowance: item?.km_allowance === null || item?.km_allowance === undefined ? "" : String(item.km_allowance), kmRate: rateOf(item?.extra_km_rate),
    fuelPer: item?.fuel_per || "", fuelRate: rateOf(item?.fuel_rate), tankLitres: item?.tank_litres ? String(Number(item.tank_litres)) : "",
  }));
  const [units, setUnits] = useState(() => [{ key: newKey(), label: "", serialNo: "", meterReading: "" }]);
  const [parts, setParts] = useState(() => (item?.parts || []).map((p) => ({ key: newKey(), itemId: String(p.item_id), quantity: String(p.quantity) })));
  const [ownSlabs, setOwnSlabs] = useState(() => (item?.late_slabs ? slabsOf(item.late_slabs) : []));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const slab = form.taxRateId || String(slabs.find((r) => r.is_default)?.id || "");
  const unitKind = form.kind === "unit", kit = form.kind === "kit";
  const vehicle = unitKind ? form.vehicle : "";
  const meter = !unitKind ? "" : vehicle ? "km" : form.meter;
  const pools = items.filter((i) => i.kind === "pool" && i.active);
  const chosenClass = classes.find((k) => String(k.id) === form.classId) || null;
  const setUnit = (key, name) => (e) => setUnits((all) => all.map((u) => (u.key === key ? { ...u, [name]: e.target.value } : u)));
  const setPart = (key, name) => (e) => setParts((all) => all.map((p) => (p.key === key ? { ...p, [name]: e.target.value } : p)));
  const byParts = kit && form.kitBilling === "parts";
  const rules = {
    rates: { hour: form.rateHour || null, day: form.rateDay || null, week: form.rateWeek || null, month: form.rateMonth || null }, deposit: form.deposit || "0",
    minHours: form.minHours || "0", bufferMinutes: form.bufferMinutes || "0", graceMinutes: form.graceMinutes || "0", latePer: kit ? "none" : form.latePer,
    lateRate: kit || ["none"].includes(form.latePer) ? null : form.lateRate || null, lateCap: kit || form.latePer === "none" ? null : form.lateCap || null,
    lateSlabs: !kit && form.latePer === "slabs" && ownSlabs.length ? slabsBody(ownSlabs) : null, classId: form.classId || null,
    description: form.description.trim() || null, sortOrder: form.sortOrder || "0",
    ...(meter === "km" ? { km: form.kmPer ? { allowance: form.kmAllowance || "0", per: form.kmPer, rate: form.kmRate } : null } : {}),
    ...(vehicle || item?.vehicle ? { fuel: form.fuelPer ? { per: form.fuelPer, rate: form.fuelRate, tankLitres: form.tankLitres || undefined } : null } : {}),
  };
  const partsBody = () => parts.filter((p) => p.itemId).map((p) => ({ itemId: p.itemId, quantity: p.quantity || "1" }));
  const submit = () => {
    if (item) {
      return businessWrite(biz.id, `rentals/items/${item.id}`, { ...rules, ...(item.kind === "pool" ? { poolQuantity: form.poolQuantity, locationId: form.locationId } : {}),
        ...(item.kind === "kit" ? { kitBilling: form.kitBilling, parts: partsBody() } : {}),
        ...(item.vehicle ? { withDriver: form.withDriver } : item.kind === "unit" ? { meter: form.meter || null } : {}), active: form.active }, "patch");
    }
    if (form.useExisting && !existing) throw new Error("Choose the service item");
    const typedUnits = unitKind ? units.filter((u) => u.label.trim()).map((u) => ({ label: u.label.trim(), serialNo: u.serialNo.trim() || undefined, locationId: form.locationId || undefined,
      ...(meter && u.meterReading !== "" ? { meterReading: u.meterReading } : {}) })) : [];
    return businessWrite(biz.id, "rentals/items", {
      ...(form.useExisting ? { skuId: existing.id } : { item: { name: form.name.trim(), taxRateId: slab || undefined, hsnCode: form.hsnCode.trim() || undefined } }),
      kind: form.kind, ...(unitKind ? { vehicle: vehicle || undefined, ...(vehicle ? { withDriver: form.withDriver } : { meter: meter || undefined }), units: typedUnits }
        : kit ? { kitBilling: form.kitBilling, parts: partsBody() } : { poolQuantity: form.poolQuantity, locationId: form.locationId || undefined }),
      ...rules, ...(byParts && Object.values(rules.rates).every((r) => !r) ? { rates: {} } : {}),
    });
  };
  return (
    <FormDialog title={item ? `Change ${item.name}` : "Add a rental item"} icon="key" width={780} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={item ? "Save" : "Add the item"} description={item ? "Bookings made before keep the rates and rules they were made at." : "Billed as a service item of the catalogue, at the rates below."}>
      {!item && (
        <>
          <Field label="Hired out">
            <select value={form.kind} onChange={set("kind")}><option value="unit">One by one (each unit with its own name and number)</option><option value="pool">From a pool (how many the shop has)</option>
              <option value="kit">As a kit of parts from pools (a shamiana set)</option></select>
          </Field>
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.useExisting} onChange={set("useExisting")} /> Billed as a service item already in the catalogue</label>
          {form.useExisting ? (
            <div className="field-wide">
              <SearchPicker label="Service item" placeholder="Name or code" value={existing} onChange={setExisting} minChars={1}
                search={(q, { signal }) => businessRead(biz.id, "catalog", { kind: "service", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                getLabel={(s) => s.label} getDescription={(s) => `${s.code} · GST ${Number(s.tax_rate)}%${s.hsn_code ? ` · SAC ${s.hsn_code}` : ""}`} />
            </div>
          ) : (
            <>
              <Field label="Name on the bill" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Generator 15 kVA, Plastic chair, Shamiana 20x40" /></Field>
              <Field label="GST slab" hint={SLAB_NOTE}>
                <select required value={slab} onChange={set("taxRateId")}>{slabs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              </Field>
              <Field label="SAC (optional)" hint="Renting goods without an operator is in heading 9973 (997329 for other goods; a passenger vehicle with a driver is 9966). Have an accountant confirm each code.">
                <input inputMode="numeric" maxLength={8} className="mono" value={form.hsnCode} onChange={set("hsnCode")} placeholder="997329" />
              </Field>
            </>
          )}
          {unitKind && (
            <Field label="Vehicle"><select value={form.vehicle} onChange={set("vehicle")}>{VEHICLES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
          )}
        </>
      )}
      {kit && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Parts of one kit (items from a pool)</legend>
          {parts.map((p) => (
            <div key={p.key} className="rnt-unit-row">
              <Field label="Part"><select required value={p.itemId} onChange={setPart(p.key, "itemId")}><option value="">Choose…</option>
                {pools.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
              <Field label="How many in one kit"><input type="number" required min="1" step="1" value={p.quantity} onChange={setPart(p.key, "quantity")} /></Field>
              <button type="button" className="link-button danger" onClick={() => setParts((all) => all.filter((x) => x.key !== p.key))}>Remove</button>
            </div>
          ))}
          <button type="button" className="chip-button" onClick={() => setParts((all) => [...all, { key: newKey(), itemId: "", quantity: "1" }])}><Icon name="plus" size={13} /> A part</button>
          <Field label="Billed"><select value={form.kitBilling} onChange={set("kitBilling")}><option value="kit">As the kit, at its own rates</option><option value="parts">By its parts, at their rates</option></select></Field>
          <small className="muted field-wide">Booking a kit holds its parts: each is checked for what is free, goes out and comes back as a line of its own. A unit is booked as its own line.</small>
        </fieldset>
      )}
      {unitKind && vehicle && (
        <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.withDriver} onChange={set("withDriver")} /> Hired with the shop's driver (otherwise self-drive: the hirer's driving licence and the hirer register at every handover)</label>
      )}
      {unitKind && !vehicle && (
        <Field label="Meter" hint="Read at every handover and return.">
          <select value={form.meter} onChange={set("meter")}><option value="">No meter</option><option value="hours">Hour meter</option><option value="km">Kilometres</option></select>
        </Field>
      )}
      {form.kind === "pool" && (
        <>
          <Field label={locations.length > 1 ? "How many at the location" : "How many the shop has"} hint={item ? "Not below what bookings reserved or out hold there at their busiest." : undefined}>
            <input type="number" required min={item ? 0 : 1} step="1" value={form.poolQuantity} onChange={set("poolQuantity")} />
          </Field>
          {locations.length > 1 && <Field label="Location"><select value={form.locationId} onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value,
            poolQuantity: item ? String(item.counts.find((c) => String(c.location_id) === e.target.value)?.quantity ?? 0) : f.poolQuantity }))}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
        </>
      )}
      {!(kit && form.kitBilling === "parts") && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Rates ({biz.settings.tax_mode === "inclusive" ? "with GST" : "before GST"}, for one)</legend>
          <Field label="An hour"><input type="number" min="0.01" step="0.01" value={form.rateHour} onChange={set("rateHour")} /></Field>
          <Field label="A day (24 hours)"><input type="number" min="0.01" step="0.01" value={form.rateDay} onChange={set("rateDay")} /></Field>
          <Field label="A week"><input type="number" min="0.01" step="0.01" value={form.rateWeek} onChange={set("rateWeek")} /></Field>
          <Field label="A month (30 days)"><input type="number" min="0.01" step="0.01" value={form.rateMonth} onChange={set("rateMonth")} /></Field>
          <small className="muted field-wide">A booking is charged the cheapest mix of these that covers its hours. Leave out the ones the shop does not offer.</small>
        </fieldset>
      )}
      <Field label={`Deposit for each one (${biz.symbol})`} hint="Refundable: held apart from sales, it pays the bill only when the booking comes back."><input type="number" min="0" step="0.01" value={form.deposit} onChange={set("deposit")} /></Field>
      <Field label="Minimum hire (hours)"><input type="number" min="0" max="2160" step="1" value={form.minHours} onChange={set("minHours")} /></Field>
      {!kit && <Field label="Turnaround time (minutes)" hint="Kept free after each hire for cleaning and checks."><input type="number" min="0" max="10080" step="1" value={form.bufferMinutes} onChange={set("bufferMinutes")} /></Field>}
      {!kit && classes.length > 0 && (
        <Field label="Class" hint="Its checklist at every handover and return; its late fee slabs when the item has none.">
          <select value={form.classId} onChange={set("classId")}><option value="">None</option>{classes.filter((k) => k.active || String(k.id) === form.classId).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
        </Field>
      )}
      {!kit && <Field label="Late fee"><select value={form.latePer} onChange={set("latePer")}>{LATE.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>}
      {!kit && ["hour", "day"].includes(form.latePer) && (
        <Field label={`Late fee for each ${form.latePer} (or part of one)`} hint={`Left empty: the ${form.latePer} rate.`}><input type="number" min="0.01" step="0.01" value={form.lateRate} onChange={set("lateRate")} /></Field>
      )}
      {!kit && form.latePer === "slabs" && (
        <>
          <Field label="Hour rate the slabs multiply" hint="Left empty: the hour rate."><input type="number" min="0.01" step="0.01" value={form.lateRate} onChange={set("lateRate")} /></Field>
          {ownSlabs.length ? <SlabsEditor rows={ownSlabs} onChange={setOwnSlabs} symbol={biz.symbol} /> : (
            <p className="field-wide rnt-note">{chosenClass?.late_slabs ? `By ${chosenClass.name}'s slabs: ${slabWords(chosenClass.late_slabs, biz.exact)}.` : "Choose a class with slabs, or give the item its own."}{" "}
              <button type="button" className="link-button" onClick={() => setOwnSlabs([blankSlab("0")])}>Slabs of its own</button></p>
          )}
        </>
      )}
      {!kit && form.latePer !== "none" && (
        <>
          <Field label="Grace time (minutes)" hint="No late fee within it."><input type="number" min="0" max="1440" step="1" value={form.graceMinutes} onChange={set("graceMinutes")} /></Field>
          <Field label={`Most late fee for each one (${biz.symbol}, optional)`} hint={form.latePer === "slabs" && chosenClass?.late_cap && !form.lateCap ? `Left empty: ${chosenClass.name}'s ${biz.exact(chosenClass.late_cap)}.` : undefined}>
            <input type="number" min="0.01" step="0.01" value={form.lateCap} onChange={set("lateCap")} /></Field>
        </>
      )}
      {meter === "km" && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Kilometres</legend>
          <Field label="Free kilometres"><select value={form.kmPer} onChange={set("kmPer")}><option value="">No allowance (kilometres not charged)</option><option value="day">So many a day of the hire</option><option value="booking">So many a booking</option></select></Field>
          {form.kmPer && <Field label="Kilometres free"><input type="number" min="0" step="1" required value={form.kmAllowance} onChange={set("kmAllowance")} /></Field>}
          {form.kmPer && <Field label={`Each kilometre more (${biz.symbol})`}><input type="number" min="0.01" step="0.01" required value={form.kmRate} onChange={set("kmRate")} /></Field>}
        </fieldset>
      )}
      {(vehicle || item?.vehicle) && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Fuel short at the return</legend>
          <Field label="Charged"><select value={form.fuelPer} onChange={set("fuelPer")}><option value="">Not charged</option><option value="eighth">For each eighth of a tank</option><option value="litre">For each litre (an eighth of the tank's litres)</option></select></Field>
          {form.fuelPer && <Field label={form.fuelPer === "eighth" ? `An eighth of a tank (${biz.symbol})` : `A litre (${biz.symbol})`}><input type="number" min="0.01" step="0.01" required value={form.fuelRate} onChange={set("fuelRate")} /></Field>}
          {form.fuelPer === "litre" && <Field label="Tank (litres)"><input type="number" min="0.1" step="0.1" required value={form.tankLitres} onChange={set("tankLitres")} /></Field>}
        </fieldset>
      )}
      <Field label="Description (optional)" wide><input maxLength={300} value={form.description} onChange={set("description")} /></Field>
      <Field label="Order on the list"><input type="number" min="0" max="999" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {item && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (untick to stop booking it; bookings made keep it)</label>}
      {!item && unitKind && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Units (each one the shop has)</legend>
          {locations.length > 1 && <Field label="Kept at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
          {units.map((u, index) => (
            <div key={u.key} className="rnt-unit-row">
              <Field label={`Unit ${index + 1}: name`}><input maxLength={80} value={u.label} onChange={setUnit(u.key, "label")} placeholder={vehicle ? "e.g. Innova 1" : "e.g. Gen A"} /></Field>
              <Field label={vehicle ? "Registration number" : "Serial number (optional)"}><input maxLength={30} required={Boolean(vehicle && u.label.trim())} className="mono" value={u.serialNo} onChange={setUnit(u.key, "serialNo")} placeholder={vehicle ? "TS09AB1234" : undefined} /></Field>
              {meter && <Field label={meter === "km" ? "Odometer (km)" : "Hour meter"}><input type="number" min="0" step="0.1" value={u.meterReading} onChange={setUnit(u.key, "meterReading")} /></Field>}
              {units.length > 1 && <button type="button" className="link-button danger" onClick={() => setUnits((all) => all.filter((x) => x.key !== u.key))}>Remove</button>}
            </div>
          ))}
          <button type="button" className="chip-button" onClick={() => setUnits((all) => [...all, { key: newKey(), label: "", serialNo: "", meterReading: "" }])}><Icon name="plus" size={13} /> Another unit</button>
        </fieldset>
      )}
    </FormDialog>
  );
}

// A unit added to an item, or its name, number, vehicle details, papers and service schedule changed.
function UnitDialog({ item, unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState(() => ({ label: unit?.label || "", serialNo: unit?.serial_no || "", meterReading: "", locationId: String(locations[0]?.id || ""),
    vehicleClass: unit?.vehicle_class || "", engineCc: unit?.engine_cc ? String(unit.engine_cc) : "", lengthMm: unit?.length_mm ? String(unit.length_mm) : "", fuelType: unit?.fuel_type || "",
    ...Object.fromEntries(PAPERS.map((p) => [p.key, unit?.[p.column] || ""])), servicePer: unit?.service_per || "", serviceEvery: unit?.service_every ? String(unit.service_every) : "" }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const vehicle = Boolean(item.vehicle);
  const submit = () => (unit
    ? businessWrite(biz.id, `rentals/units/${unit.id}`, { label: form.label.trim(), serialNo: form.serialNo.trim() || null,
      ...(vehicle ? { vehicleClass: form.vehicleClass || null, engineCc: form.engineCc || null, lengthMm: form.lengthMm || null, fuelType: form.fuelType || null,
        ...Object.fromEntries(PAPERS.map((p) => [p.key, form[p.key] || null])) } : {}),
      servicePer: form.servicePer || null, ...(form.servicePer ? { serviceEvery: form.serviceEvery } : {}) }, "patch")
    : businessWrite(biz.id, `rentals/items/${item.id}/units`, { label: form.label.trim(), serialNo: form.serialNo.trim() || undefined, locationId: form.locationId || undefined,
      ...(item.meter && form.meterReading !== "" ? { meterReading: form.meterReading } : {}) }));
  return (
    <FormDialog title={unit ? `${unit.label}: details` : `Add a unit of ${item.name}`} icon="key" width={vehicle && unit ? 760 : 560} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={unit ? "Save" : "Add the unit"} description={unit ? "Bookings made keep the name and number they were made with." : undefined}>
      <Field label="Name"><input required maxLength={80} value={form.label} onChange={set("label")} placeholder={item.vehicle ? "e.g. Innova 2" : "e.g. Gen B"} /></Field>
      <Field label={item.vehicle ? "Registration number" : "Serial number (optional)"} hint="Printed on its barcode label; scanned at the handover and the return."><input required={Boolean(item.vehicle)} maxLength={30} className="mono" value={form.serialNo} onChange={set("serialNo")} /></Field>
      {!unit && item.meter && <Field label={item.meter === "km" ? "Odometer (km)" : "Hour meter"}><input type="number" min="0" step="0.1" value={form.meterReading} onChange={set("meterReading")} /></Field>}
      {!unit && locations.length > 1 && <Field label="Kept at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      {unit && vehicle && (
        <>
          <fieldset className="field-wide rnt-fieldset">
            <legend>The vehicle</legend>
            <Field label="Class (as a driving licence names it)" hint="The hirer's licence must cover it."><select value={form.vehicleClass} onChange={set("vehicleClass")}><option value="">Not given</option>
              {VEHICLE_CLASSES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
            <Field label="Engine (cc)"><input type="number" min="1" step="1" value={form.engineCc} onChange={set("engineCc")} /></Field>
            <Field label="Length (mm)"><input type="number" min="100" step="1" value={form.lengthMm} onChange={set("lengthMm")} /></Field>
            <Field label="Fuel"><select value={form.fuelType} onChange={set("fuelType")}><option value="">Not given</option>{FUEL_TYPES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
            <small className="muted field-wide">They decide the like goods' slab: a small car (petrol, LPG or CNG up to 1200 cc, diesel up to 1500 cc, up to 4000 mm) or a motorcycle up to 350 cc 18%, other cars and bigger motorcycles 40%, electric 5%. A mismatch with the item's slab is shown; the item's slab is the one billed.</small>
          </fieldset>
          <fieldset className="field-wide rnt-fieldset">
            <legend>Papers (valid until)</legend>
            {PAPERS.map((p) => <Field key={p.key} label={p.label}><input type="date" value={form[p.key]} onChange={set(p.key)} /></Field>)}
          </fieldset>
        </>
      )}
      {unit && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Service schedule</legend>
          <Field label="Serviced every"><select value={form.servicePer} onChange={set("servicePer")}><option value="">No schedule</option>
            {item.meter === "hours" && <option value="hours">So many running hours</option>}{item.meter === "km" && <option value="km">So many kilometres</option>}<option value="days">So many days</option></select></Field>
          {form.servicePer && <Field label={form.servicePer === "days" ? "Days" : form.servicePer === "km" ? "Kilometres" : "Running hours"}><input type="number" required min="1" step="1" value={form.serviceEvery} onChange={set("serviceEvery")} /></Field>}
          <small className="muted field-wide">Counted from the last service (or from now); the bell says when it is due.</small>
        </fieldset>
      )}
    </FormDialog>
  );
}

// A unit sent for maintenance (not handed over until it is back) or retired (not booked), with why.
function UnitStateDialog({ unit, status, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [note, setNote] = useState("");
  return (
    <FormDialog title={status === "maintenance" ? `Send ${unit.label} for maintenance` : `Retire ${unit.label}`} icon="settings" width={520} onClose={onClose} onSaved={onSaved}
      submitLabel={status === "maintenance" ? "Send it" : "Retire it"}
      description={status === "maintenance" ? "It is not handed over until it is back in service; bookings still hold it. Maintenance booked ahead is on Yard & fleet." : "A retired unit is not booked; one booked or out is retired once it is back."}
      onSubmit={() => businessWrite(biz.id, `rentals/units/${unit.id}`, { status, statusNote: note.trim() }, "patch")}>
      <Field label={status === "maintenance" ? "What the maintenance is for" : "Why it is retired"} wide><input required maxLength={300} autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  );
}
