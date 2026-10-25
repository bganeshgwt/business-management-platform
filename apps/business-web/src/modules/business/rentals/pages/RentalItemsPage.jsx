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
import { newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { LATE, SLAB_NOTE, VEHICLES, rateWords, wordOf } from "./rentals";
import "../styles/rentals.css";

// Rental items: each thing hired out, billed as a service item of the
// catalogue (its name on the bill, its GST slab: the slab of a sale of the
// like goods), hired one by one (each unit with its own name and number) or
// from a pool of how many the shop has; a motor vehicle self-drive or with the
// shop's driver; a meter read at each handover and return; the deposit for
// each one hired; rates by the hour, day, week and month; the minimum hire,
// the turnaround time between hires and the late fee after a grace time.
// Bookings keep the rates and rules they were made at. Below: each unit, in
// service, in maintenance or retired; and the handover settings.

const UNIT_STATES = { available: { label: "In service", tone: "success" }, maintenance: { label: "In maintenance", tone: "warning" }, retired: { label: "Retired", tone: "neutral" } };
const meterUnit = (item) => (item.meter === "km" ? "km" : item.meter === "hours" ? "h" : "");
const hiredWords = (i) => (i.kind === "pool" ? `${i.pool_quantity} in the pool` : `${i.units_in_service} ${i.units_in_service === 1 ? "unit" : "units"}`);
const vehicleWords = (i) => (!i.vehicle ? "" : `${wordOf(VEHICLES, i.vehicle)}, ${i.with_driver ? "with the shop's driver" : "self-drive"}`);
const selfDrive = (i) => ["car", "motorcycle"].includes(i.vehicle) && !i.with_driver;

// "₹400 an hour after 30 min", "the day rate a day", "None".
function lateText(i, exact) {
  if (i.late_per === "none") return "None";
  const rate = i.late_rate !== null && i.late_rate !== undefined ? exact(i.late_rate) : i.late_per === "hour" ? `${exact(i.rate_hour)}` : `${exact(i.rate_day)}`;
  return `${rate} ${i.late_per === "hour" ? "an hour" : "a day"}${Number(i.grace_minutes) ? ` after ${i.grace_minutes} min` : ""}`;
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
          A vehicle is handed over only on the hirer's driving licence, with its date.
        </p>
      )}
      <SectionCard flush icon="key" title="Items" description="Each item is billed as a service item: its name on the bill and its GST slab come from the item. Renting goods out is taxed at the slab of a sale of the like goods.">
        <DataGrid variant="compact" id="rental-items" caption="Rental items" rows={items} rowKey={(i) => i.id} currency={biz.symbol} rowNoun={["item", "items"]}
          rowClassName={(i) => (i.active ? "" : "dg-tone-muted")}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show items and units not in use</label>}
          columns={[
            { key: "name", header: "Item", value: (i) => i.name, mobile: "title", pin: true,
              render: (i) => (
                <span className="bz-two-line">
                  {canEdit ? <button type="button" className="link-button" onClick={() => setDialog({ kind: "item", item: i })}>{i.name}</button> : <span>{i.name}</span>}
                  <small className="muted"><span className="mono">{i.item_code}</span> · GST {Number(i.tax_rate)}%{i.hsn_code ? ` · SAC ${i.hsn_code}` : ""}</small>
                </span>
              ) },
            { key: "hired", header: "Hired out", value: (i) => hiredWords(i), mobile: "show",
              render: (i) => <span className="bz-two-line"><span>{hiredWords(i)}</span><small className="muted">{[vehicleWords(i), Number(i.out_now) ? `${i.out_now} out now` : null].filter(Boolean).join(" · ") || "one by one"}</small></span> },
            { key: "rates", header: "Rates", value: (i) => rateWords(i, biz.exact), mobile: "subtitle" },
            { key: "deposit", header: "Deposit each", type: "money", exact: true, value: (i) => Number(i.deposit) },
            { key: "late", header: "Late fee", value: (i) => lateText(i, biz.exact) },
            { key: "rules", header: "Minimum · turnaround", value: (i) => `${i.min_hours} h · ${i.buffer_minutes} min`,
              render: (i) => <span className="small">{Number(i.min_hours) ? `${i.min_hours} h minimum` : "No minimum"} · {Number(i.buffer_minutes) ? `${i.buffer_minutes} min between hires` : "no turnaround"}</span> },
            { key: "active", header: "In use", value: (i) => (i.active ? "Yes" : "No"), render: (i) => <ActiveBadge active={i.active && i.item_active} /> },
            canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (i) => (i.kind === "unit" && i.active
              ? <button type="button" className="chip-button" onClick={() => setDialog({ kind: "unit", item: i })}><Icon name="plus" size={13} /> Add a unit</button> : null) },
          ].filter(Boolean)}
          empty="No rental items yet" emptyHint={canEdit ? "Add what the shop hires out: a generator, chairs and tables, a camera, a car." : undefined} emptyIcon="key" />
      </SectionCard>
      <SectionCard flush icon="list" title="Units" description="Each unit of an item hired one by one. A unit in maintenance is not handed over; a retired one is not booked.">
        <DataGrid variant="compact" id="rental-units" caption="Units" rows={units} rowKey={(u) => u.id} rowNoun={["unit", "units"]}
          rowClassName={(u) => (u.status === "retired" ? "dg-tone-muted" : u.status === "maintenance" ? "dg-tone-warning" : "")}
          columns={[
            { key: "label", header: "Unit", value: (u) => `${u.label} ${u.serial_no || ""}`, mobile: "title", pin: true,
              render: (u) => <span className="bz-two-line"><span>{u.label}</span>{u.serial_no && <small className="mono muted">{u.serial_no}</small>}</span> },
            { key: "item", header: "Item", value: (u) => u.item.name, mobile: "subtitle" },
            { key: "meter", header: "Meter", value: (u) => (u.meter_reading === null ? "" : Number(u.meter_reading)),
              render: (u) => (u.meter_reading === null ? <span className="muted">—</span> : `${Number(u.meter_reading)} ${meterUnit(u.item)}`) },
            { key: "status", header: "State", type: "status", value: (u) => UNIT_STATES[u.status].label, mobile: "show",
              render: (u) => <span className="bz-two-line"><Badge tone={UNIT_STATES[u.status].tone} label={UNIT_STATES[u.status].label} />{u.status_note && <small className="muted">{u.status_note}</small>}</span> },
            (canEdit || canYard) && { key: "actions", header: "", label: "Actions", type: "actions", render: (u) => (
              <span className="rnt-actions">
                {canEdit && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "unit", item: u.item, unit: u })}>Rename</button>}
                {canYard && u.status === "available" && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "state", unit: u, status: "maintenance" })}>Send for maintenance</button>}
                {canYard && u.status !== "available" && <button type="button" className="chip-button" onClick={() => setUnitState(u, "available")}>Back in service</button>}
                {canYard && u.status !== "retired" && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "state", unit: u, status: "retired" })}>Retire</button>}
              </span>
            ) },
          ].filter(Boolean)}
          empty="No units" emptyHint="An item hired one by one has a unit for each one the shop has, each with its own name and number." emptyIcon="list" />
      </SectionCard>
      <HandoverSettings settings={data.settings} onSaved={(s) => setData((d) => ({ ...d, settings: s }))} />
      {dialog?.kind === "item" && <ItemDialog item={dialog.item || null} onClose={() => setDialog(null)} onSaved={() => reload(dialog.item ? "Rental item saved." : "Rental item added.")} />}
      {dialog?.kind === "unit" && <UnitDialog item={dialog.item} unit={dialog.unit || null} onClose={() => setDialog(null)} onSaved={() => reload(dialog.unit ? "Unit saved." : "Unit added.")} />}
      {dialog?.kind === "state" && <UnitStateDialog unit={dialog.unit} status={dialog.status} onClose={() => setDialog(null)}
        onSaved={() => reload(`${dialog.unit.label} ${UNIT_STATES[dialog.status].label.toLowerCase()}.`)} />}
    </div>
  );
}

// A hirer's photo ID at every handover, and the shop's terms on the slips.
function HandoverSettings({ settings, onSaved }) {
  const biz = useOpenBusiness();
  const canEdit = biz.can("settings.edit");
  const [form, setForm] = useState(() => ({ idRequired: settings.idRequired, terms: settings.terms || "" }));
  const [saving, setSaving] = useState(false);
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      onSaved(await businessWrite(biz.id, "rentals/settings", { idRequired: form.idRequired, terms: form.terms.trim() || null }, "put"));
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
          <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.idRequired} onChange={(e) => setForm((f) => ({ ...f, idRequired: e.target.checked }))} /> Record the hirer's photo ID at every handover (of an Aadhaar card, only its last four digits are kept)</label>
          <Field label="Terms printed on the booking and handover slips" wide hint="The shop's terms in its own words: what the hirer looks after, the late fee, what a damage or loss costs.">
            <textarea rows={4} maxLength={2000} value={form.terms} onChange={(e) => setForm((f) => ({ ...f, terms: e.target.value }))} placeholder="e.g. The hirer returns everything clean and in the condition noted at the handover." />
          </Field>
        </fieldset>
        {canEdit && <div className="form-actions"><button type="submit" className="button" disabled={saving}>{saving ? "Saving…" : "Save the settings"}</button></div>}
      </form>
    </SectionCard>
  );
}

const rateOf = (value) => (value === null || value === undefined ? "" : String(Number(value)));

// A rental item: added (its service item, how it is hired out, its units) or changed (its rates and rules).
function ItemDialog({ item, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(item ? [] : ["tax-rates?active=true"]);
  const slabs = options?.["tax-rates?active=true"] || [];
  const [existing, setExisting] = useState(null);
  const [form, setForm] = useState(() => ({
    kind: item?.kind || "unit", useExisting: false, name: "", taxRateId: "", hsnCode: "", vehicle: item?.vehicle || "", withDriver: Boolean(item?.with_driver),
    meter: item?.meter || "", poolQuantity: item?.pool_quantity === null || item?.pool_quantity === undefined ? "" : String(item.pool_quantity),
    rateHour: rateOf(item?.rate_hour), rateDay: rateOf(item?.rate_day), rateWeek: rateOf(item?.rate_week), rateMonth: rateOf(item?.rate_month),
    deposit: item ? rateOf(item.deposit) : "", minHours: item ? String(item.min_hours) : "0", bufferMinutes: item ? String(item.buffer_minutes) : "0",
    graceMinutes: item ? String(item.grace_minutes) : "0", latePer: item?.late_per || "hour", lateRate: rateOf(item?.late_rate), description: item?.description || "",
    sortOrder: item ? String(item.sort_order) : "0", active: item ? item.active : true,
  }));
  const [units, setUnits] = useState(() => [{ key: newKey(), label: "", serialNo: "", meterReading: "" }]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const slab = form.taxRateId || String(slabs.find((r) => r.is_default)?.id || "");
  const unitKind = form.kind === "unit";
  const vehicle = unitKind ? form.vehicle : "";
  const meter = !unitKind ? "" : vehicle ? "km" : form.meter;
  const setUnit = (key, name) => (e) => setUnits((all) => all.map((u) => (u.key === key ? { ...u, [name]: e.target.value } : u)));
  const rules = {
    rates: { hour: form.rateHour || null, day: form.rateDay || null, week: form.rateWeek || null, month: form.rateMonth || null }, deposit: form.deposit || "0",
    minHours: form.minHours || "0", bufferMinutes: form.bufferMinutes || "0", graceMinutes: form.graceMinutes || "0", latePer: form.latePer,
    lateRate: form.latePer === "none" ? null : form.lateRate || null, description: form.description.trim() || null, sortOrder: form.sortOrder || "0",
  };
  const submit = () => {
    if (item) {
      return businessWrite(biz.id, `rentals/items/${item.id}`, { ...rules, ...(item.kind === "pool" ? { poolQuantity: form.poolQuantity } : {}),
        ...(item.vehicle ? { withDriver: form.withDriver } : item.kind === "unit" ? { meter: form.meter || null } : {}), active: form.active }, "patch");
    }
    if (form.useExisting && !existing) throw new Error("Choose the service item");
    const typedUnits = unitKind ? units.filter((u) => u.label.trim()).map((u) => ({ label: u.label.trim(), serialNo: u.serialNo.trim() || undefined,
      ...(meter && u.meterReading !== "" ? { meterReading: u.meterReading } : {}) })) : [];
    return businessWrite(biz.id, "rentals/items", {
      ...(form.useExisting ? { skuId: existing.id } : { item: { name: form.name.trim(), taxRateId: slab || undefined, hsnCode: form.hsnCode.trim() || undefined } }),
      kind: form.kind, ...(unitKind ? { vehicle: vehicle || undefined, ...(vehicle ? { withDriver: form.withDriver } : { meter: meter || undefined }), units: typedUnits } : { poolQuantity: form.poolQuantity }),
      ...rules,
    });
  };
  return (
    <FormDialog title={item ? `Change ${item.name}` : "Add a rental item"} icon="key" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={item ? "Save" : "Add the item"} description={item ? "Bookings made before keep the rates and rules they were made at." : "Billed as a service item of the catalogue, at the rates below."}>
      {!item && (
        <>
          <Field label="Hired out">
            <select value={form.kind} onChange={set("kind")}><option value="unit">One by one (each unit with its own name and number)</option><option value="pool">From a pool (how many the shop has)</option></select>
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
              <Field label="Name on the bill" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Generator 15 kVA, Plastic chair, Innova Crysta" /></Field>
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
      {unitKind && vehicle && (
        <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.withDriver} onChange={set("withDriver")} /> Hired with the shop's driver (otherwise self-drive: the hirer's driving licence at every handover)</label>
      )}
      {unitKind && !vehicle && (
        <Field label="Meter" hint="Read at every handover and return.">
          <select value={form.meter} onChange={set("meter")}><option value="">No meter</option><option value="hours">Hour meter</option><option value="km">Kilometres</option></select>
        </Field>
      )}
      {form.kind === "pool" && (
        <Field label="How many the shop has" hint={item ? "Not below what bookings reserved or out hold at their busiest." : undefined}>
          <input type="number" required min={item ? 0 : 1} step="1" value={form.poolQuantity} onChange={set("poolQuantity")} />
        </Field>
      )}
      <fieldset className="field-wide rnt-fieldset">
        <legend>Rates ({biz.settings.tax_mode === "inclusive" ? "with GST" : "before GST"}, for one)</legend>
        <Field label="An hour"><input type="number" min="0.01" step="0.01" value={form.rateHour} onChange={set("rateHour")} /></Field>
        <Field label="A day (24 hours)"><input type="number" min="0.01" step="0.01" value={form.rateDay} onChange={set("rateDay")} /></Field>
        <Field label="A week"><input type="number" min="0.01" step="0.01" value={form.rateWeek} onChange={set("rateWeek")} /></Field>
        <Field label="A month (30 days)"><input type="number" min="0.01" step="0.01" value={form.rateMonth} onChange={set("rateMonth")} /></Field>
        <small className="muted field-wide">A booking is charged the cheapest mix of these that covers its hours. Leave out the ones the shop does not offer.</small>
      </fieldset>
      <Field label={`Deposit for each one (${biz.symbol})`} hint="Refundable: held apart from sales, it pays the bill only when the booking comes back."><input type="number" min="0" step="0.01" value={form.deposit} onChange={set("deposit")} /></Field>
      <Field label="Minimum hire (hours)"><input type="number" min="0" max="2160" step="1" value={form.minHours} onChange={set("minHours")} /></Field>
      <Field label="Turnaround time (minutes)" hint="Kept free after each hire for cleaning and checks."><input type="number" min="0" max="10080" step="1" value={form.bufferMinutes} onChange={set("bufferMinutes")} /></Field>
      <Field label="Late fee"><select value={form.latePer} onChange={set("latePer")}>{LATE.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
      {form.latePer !== "none" && (
        <>
          <Field label={`Late fee for each ${form.latePer} (or part of one)`} hint={`Left empty: the ${form.latePer} rate.`}><input type="number" min="0.01" step="0.01" value={form.lateRate} onChange={set("lateRate")} /></Field>
          <Field label="Grace time (minutes)" hint="No late fee within it."><input type="number" min="0" max="1440" step="1" value={form.graceMinutes} onChange={set("graceMinutes")} /></Field>
        </>
      )}
      <Field label="Description (optional)" wide><input maxLength={300} value={form.description} onChange={set("description")} /></Field>
      <Field label="Order on the list"><input type="number" min="0" max="999" step="1" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
      {item && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (untick to stop booking it; bookings made keep it)</label>}
      {!item && unitKind && (
        <fieldset className="field-wide rnt-fieldset">
          <legend>Units (each one the shop has)</legend>
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

// A unit added to an item, or renamed and renumbered.
function UnitDialog({ item, unit, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => ({ label: unit?.label || "", serialNo: unit?.serial_no || "", meterReading: "" }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => (unit
    ? businessWrite(biz.id, `rentals/units/${unit.id}`, { label: form.label.trim(), serialNo: form.serialNo.trim() || null }, "patch")
    : businessWrite(biz.id, `rentals/items/${item.id}/units`, { label: form.label.trim(), serialNo: form.serialNo.trim() || undefined,
      ...(item.meter && form.meterReading !== "" ? { meterReading: form.meterReading } : {}) }));
  return (
    <FormDialog title={unit ? `Rename ${unit.label}` : `Add a unit of ${item.name}`} icon="key" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={unit ? "Save" : "Add the unit"} description={unit ? "Bookings made keep the name and number they were made with." : undefined}>
      <Field label="Name"><input required maxLength={80} value={form.label} onChange={set("label")} placeholder={item.vehicle ? "e.g. Innova 2" : "e.g. Gen B"} /></Field>
      <Field label={item.vehicle ? "Registration number" : "Serial number (optional)"}><input required={Boolean(item.vehicle)} maxLength={30} className="mono" value={form.serialNo} onChange={set("serialNo")} /></Field>
      {!unit && item.meter && <Field label={item.meter === "km" ? "Odometer (km)" : "Hour meter"}><input type="number" min="0" step="0.1" value={form.meterReading} onChange={set("meterReading")} /></Field>}
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
      description={status === "maintenance" ? "It is not handed over until it is back in service; bookings still hold it." : "A retired unit is not booked; one booked or out is retired once it is back."}
      onSubmit={() => businessWrite(biz.id, `rentals/units/${unit.id}`, { status, statusNote: note.trim() }, "patch")}>
      <Field label={status === "maintenance" ? "What the maintenance is for" : "Why it is retired"} wide><input required maxLength={300} autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  );
}
