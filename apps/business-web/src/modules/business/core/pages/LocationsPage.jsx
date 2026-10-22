import { useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "./ui";
import { useOpenBusiness, useServerList } from "./hooks";

const DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
// "Mon–Sat 09:00–21:00 · Sun 10:00–14:00": days with the same hours run together.
function hoursText(hours) {
  if (!hours) return "";
  const parts = [];
  for (const [day, label] of DAYS) {
    const slot = hours[day];
    const text = slot ? `${slot.open}–${slot.close}` : null;
    const last = parts[parts.length - 1];
    if (text && last && last.text === text && last.to === DAYS.findIndex(([d]) => d === day) - 1) { last.to += 1; last.toLabel = label; }
    else if (text) parts.push({ text, from: label, to: DAYS.findIndex(([d]) => d === day), toLabel: label });
  }
  return parts.map((p) => `${p.from === p.toLabel ? p.from : `${p.from}–${p.toLabel}`} ${p.text}`).join(" · ");
}
// Open now, in the business's time zone (a close before the open runs past midnight).
function openNow(hours, timezone) {
  if (!hours) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = parts.weekday.toLowerCase().slice(0, 3);
  const now = `${parts.hour}:${parts.minute}`;
  const slot = hours[day];
  if (!slot) return false;
  return slot.open < slot.close ? now >= slot.open && now < slot.close : now >= slot.open || now < slot.close;
}

// The shops, counters and warehouses where this business keeps stock and sells.
export default function LocationsPage() {
  const biz = useOpenBusiness();
  const list = useServerList("locations", { gridId: "business-locations" });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const columns = [
    { key: "name", header: "Location", value: (l) => l.name, mobile: "title", pin: true },
    { key: "code", header: "Code", value: (l) => l.code, className: "mono", mobile: "subtitle" },
    // A branch's own address and GSTIN print on its bills; empty = Business settings.
    { key: "address", header: "Address on its bills", value: (l) => [l.address_line1, l.city].filter(Boolean).join(", "),
      render: (l) => ([l.address_line1, l.city, l.gstin].some(Boolean)
        ? <span className="bz-two-line"><span>{[l.address_line1, l.city].filter(Boolean).join(", ") || "—"}</span>{l.gstin && <small className="muted mono">GSTIN {l.gstin}</small>}</span>
        : <span className="muted">Business settings</span>) },
    // Pro pass C-22: a warehouse keeps stock but is not offered as a till at Quick bill.
    { key: "counter", header: "Quick bill", value: (l) => (l.sells_at_counter === false ? "Stock only" : "Sells here"),
      render: (l) => <Badge tone={l.sells_at_counter === false ? "neutral" : "info"} label={l.sells_at_counter === false ? "Stock only" : "Sells here"} /> },
    { key: "hours", header: "Opening hours", value: (l) => hoursText(l.opening_hours), render: (l) => {
      if (!l.opening_hours) return <span className="muted">Not given</span>;
      const open = l.active && openNow(l.opening_hours, biz.business.timezone);
      return <span className="bz-two-line"><span>{hoursText(l.opening_hours)}</span>{l.active && <small className={open ? "text-success" : "muted"}>{open ? "Open now" : "Closed now"}</small>}</span>;
    } },
    { key: "active", header: "Status", type: "status", value: (l) => (l.active ? "active" : "inactive"), render: (l) => <ActiveBadge active={l.active} /> },
    biz.can("settings.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => <button type="button" className="chip-button" onClick={() => setEditing(l)}>Edit</button> },
  ];
  const saved = (l) => { setEditing(null); setNotice(`${l.name} saved.`); list.reload(); biz.reloadContext(); };
  return (
    <div className="stack">
      <BusinessHeader icon="map-pin" title="Locations"
        description="Each location has its own stock, document numbers and, if you enter them, its own address and GSTIN on its bills. A location holding stock, or with staff tied to it, cannot be closed until they are moved."
        actions={biz.can("settings.edit") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add location</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Locations">
        <DataGrid {...list.gridProps} caption="Locations" columns={columns.filter(Boolean)} rowNoun={["location", "locations"]}
          rowClassName={(l) => (!l.active ? "dg-tone-muted" : "")} empty="No locations" />
      </SectionCard>
      {editing && <LocationDialog location={editing} onClose={() => setEditing(null)} onSaved={saved} />}
    </div>
  );
}

const ADDRESS_FIELDS = { addressLine1: "address_line1", addressLine2: "address_line2", city: "city", postalCode: "postal_code", stateCode: "state_code", gstin: "gstin", phone: "phone" };

function LocationDialog({ location, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(location.id);
  const [form, setForm] = useState(() => ({
    name: location.name || "", code: location.code || "", active: location.active ?? true, sellsAtCounter: location.sells_at_counter ?? true,
    ...Object.fromEntries(Object.entries(ADDRESS_FIELDS).map(([field, column]) => [field, location[column] || ""])),
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const address = Object.fromEntries(Object.keys(ADDRESS_FIELDS).map((field) => [field, form[field].trim()]));
  // Opening hours: a ticked day with its open and close times; an unticked day is closed.
  const [hours, setHours] = useState(() => Object.fromEntries(DAYS.map(([day]) => [day, location.opening_hours?.[day]
    ? { on: true, ...location.opening_hours[day] } : { on: false, open: "09:00", close: "21:00" }])));
  const setHour = (day, changes) => setHours((h) => ({ ...h, [day]: { ...h[day], ...changes } }));
  const openingHours = Object.fromEntries(Object.entries(hours).filter(([, h]) => h.on).map(([day, h]) => [day, { open: h.open, close: h.close }]));
  return (
    <FormDialog title={editing ? `Edit ${location.name}` : "Add a location"} icon="map-pin" width={620} onClose={onClose} onSaved={onSaved}
      onSubmit={() => (editing
        ? businessWrite(biz.id, `locations/${location.id}`, { name: form.name, active: form.active, sellsAtCounter: form.sellsAtCounter, ...address, openingHours }, "patch")
        : businessWrite(biz.id, "locations", { name: form.name, code: form.code, sellsAtCounter: form.sellsAtCounter, ...address, openingHours }))}>
      <Field label="Name" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Koregaon Park store" /></Field>
      <Field label="Code" hint="Short; used in document numbers."><input required maxLength={30} disabled={editing} className="mono" value={form.code} onChange={set("code")} placeholder="e.g. KP" /></Field>
      <Field label="Phone"><input maxLength={30} value={form.phone} onChange={set("phone")} placeholder="Empty: the business phone" /></Field>
      <p className="field-wide muted small">Address and GSTIN print on this location's bills. Leave them empty to print the ones in Business settings. A branch registered on its own GSTIN (often in another state) enters it here; its bills are then supplied from that state.</p>
      <Field label="Address line 1" wide><input maxLength={200} value={form.addressLine1} onChange={set("addressLine1")} /></Field>
      <Field label="Address line 2" wide><input maxLength={200} value={form.addressLine2} onChange={set("addressLine2")} /></Field>
      <Field label="City"><input maxLength={100} value={form.city} onChange={set("city")} /></Field>
      <Field label="PIN code"><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={form.postalCode} onChange={set("postalCode")} /></Field>
      <Field label="GSTIN" hint="Only if this location is registered separately."><input className="mono" maxLength={15} value={form.gstin} onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))} /></Field>
      <Field label="GST state code" hint="Two digits; taken from the GSTIN when empty."><input inputMode="numeric" pattern="[0-9]{2}" maxLength={2} value={form.stateCode} onChange={set("stateCode")} /></Field>
      <fieldset className="field-wide bz-hours">
        <legend>Opening hours <span className="muted small">(untick a day the location is closed)</span></legend>
        {DAYS.map(([day, label]) => (
          <div key={day} className={`bz-hours-row ${hours[day].on ? "" : "is-closed"}`}>
            <label className="checkbox"><input type="checkbox" checked={hours[day].on} onChange={(e) => setHour(day, { on: e.target.checked })} /> {label}</label>
            <input type="time" aria-label={`${label} opens`} disabled={!hours[day].on} value={hours[day].open} onChange={(e) => setHour(day, { open: e.target.value })} />
            <span className="muted">to</span>
            <input type="time" aria-label={`${label} closes`} disabled={!hours[day].on} value={hours[day].close} onChange={(e) => setHour(day, { close: e.target.value })} />
            {!hours[day].on && <span className="muted small">Closed</span>}
          </div>
        ))}
      </fieldset>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.sellsAtCounter} onChange={set("sellsAtCounter")} /> Sells at the counter (untick for a warehouse or godown: Quick bill then does not offer it)</label>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Open</label>}
    </FormDialog>
  );
}
