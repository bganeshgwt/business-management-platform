import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import ContentTabs from "../../../../components/ContentTabs";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { ROOM_STATUS, SLAB_NOTE, WEEKDAYS } from "./lodging";
import { DayUseTab, PoliciesTab, RateCalendarTab, RatePlansTab, SeasonsTab } from "./LodgingRates";
import "../styles/lodging.css";

// Room types & rates (Settings): the two GST slabs a room night is billed at
// (the lower one at or below the limit a room a night, the higher above it),
// the weekend nights and the terms on the registration card; each room type
// with its occupancy, extra beds and rate plan (rack, weekend, extra adult,
// child and extra bed, each a night before GST), billed as a service item
// counted in nights; and the rooms with their numbers, floors and types. A
// stay keeps the rates it was booked at. The other tabs: rate plans with
// their meal plans, seasons, the rate calendar, day-use prices and policies
// (LodgingRates.jsx); the check-in and check-out times are with the slabs.

const TABS = [{ value: "rooms", label: "Room types & rooms" }, { value: "plans", label: "Rate plans" }, { value: "seasons", label: "Seasons" }, { value: "calendar", label: "Rate calendar" },
  { value: "day-use", label: "Day use" }, { value: "policies", label: "Policies" }];

const blankType = { name: "", hsnCode: "", baseOccupancy: "2", maxOccupancy: "2", maxExtraBeds: "0", rack: "", weekend: "", extraAdult: "", child: "", extraBed: "", description: "" };
const money = (value) => (value === null || value === undefined ? "" : String(Number(value)));

export default function RoomTypesPage() {
  const biz = useOpenBusiness();
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "rooms";
  const showTab = (value) => setParams((p) => { if (value === "rooms") p.delete("tab"); else p.set("tab", value); return p; }, { replace: true });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/setup", undefined, controller.signal).then((s) => { setSetup(s); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const done = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const canItems = biz.can("catalog.edit");
  if (!setup) return <div className="stack"><BusinessHeader icon="settings" title="Room types & rates" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const many = biz.locations.length > 1;
  return (
    <div className="stack">
      <BusinessHeader icon="settings" title="Room types & rates" description="The GST slabs of a room night, the check-in and check-out times, each room type's rates and its rooms, rate plans with their meals, seasons, the rate calendar, day-use prices and policies. A change of rates applies to stays booked after it: a stay keeps the rates it was booked at." />
      <ErrorMessage message={error} />
      <ContentTabs label="Room types & rates" value={tab} options={TABS} onChange={showTab}>
      {tab === "plans" && <RatePlansTab setup={setup} />}
      {tab === "seasons" && <SeasonsTab setup={setup} />}
      {tab === "calendar" && <RateCalendarTab setup={setup} />}
      {tab === "day-use" && <DayUseTab setup={setup} />}
      {tab === "policies" && <PoliciesTab />}
      {tab === "rooms" && <>
      <SlabSettings setup={setup} onSaved={() => done("Saved.")} />
      <SectionCard flush icon="home" title="Room types" actions={canItems && <button type="button" className="button button-sm" onClick={() => setDialog({ kind: "type" })}><Icon name="plus" size={14} /> Add a room type</button>}>
        <DataGrid variant="compact" id="lodging-room-types" caption="Room types" rows={setup.roomTypes} rowKey={(t) => t.id} currency={biz.symbol} rowNoun={["room type", "room types"]}
          rowClassName={(t) => (t.active ? "" : "dg-tone-muted")} empty="No room types yet" emptyHint="Add a room type with its rates, then its rooms." emptyIcon="home" columns={[
            { key: "name", header: "Room type", value: (t) => t.name, mobile: "title", pin: true,
              render: (t) => <span className="bz-two-line"><span>{t.name}</span><small className="muted">{[t.description, t.hsn_code ? `SAC ${t.hsn_code}` : null].filter(Boolean).join(" · ")}</small></span> },
            { key: "occupancy", header: "Guests", value: (t) => t.max_occupancy, render: (t) => `${t.base_occupancy} in the rate · up to ${t.max_occupancy}${t.max_extra_beds ? ` · ${t.max_extra_beds} extra bed` : ""}` },
            { key: "rack", header: "Rack a night", type: "money", exact: true, value: (t) => Number(t.rack_rate) },
            { key: "weekend", header: "Weekend", type: "money", exact: true, value: (t) => (t.weekend_rate === null ? null : Number(t.weekend_rate)) },
            { key: "extra_adult", header: "Extra adult", type: "money", exact: true, value: (t) => (t.extra_adult_rate === null ? null : Number(t.extra_adult_rate)) },
            { key: "child", header: "Child", type: "money", exact: true, value: (t) => (t.child_rate === null ? null : Number(t.child_rate)) },
            { key: "extra_bed", header: "Extra bed", type: "money", exact: true, value: (t) => (t.extra_bed_rate === null ? null : Number(t.extra_bed_rate)) },
            { key: "rooms", header: "Rooms", type: "number", value: (t) => t.rooms_in_use },
            { key: "active", header: "In use", value: (t) => (t.active ? "Yes" : "No"), render: (t) => <ActiveBadge active={t.active} /> },
            canItems && { key: "actions", header: "", type: "actions", render: (t) => <button type="button" className="link-button" onClick={() => setDialog({ kind: "type", type: t })}>Edit</button> },
          ].filter(Boolean)} />
      </SectionCard>
      <SectionCard flush icon="home" title="Rooms" actions={canItems && setup.roomTypes.some((t) => t.active) && <button type="button" className="button button-sm" onClick={() => setDialog({ kind: "rooms" })}><Icon name="plus" size={14} /> Add rooms</button>}>
        <DataGrid variant="compact" id="lodging-rooms" caption="Rooms" rows={setup.rooms} rowKey={(r) => r.id} rowNoun={["room", "rooms"]} rowClassName={(r) => (r.active ? "" : "dg-tone-muted")}
          empty="No rooms yet" emptyIcon="home" columns={[
            { key: "room_no", header: "Room", value: (r) => r.room_no, mobile: "title", pin: true },
            { key: "type", header: "Room type", value: (r) => r.room_type, mobile: "subtitle" },
            { key: "floor", header: "Floor", value: (r) => r.floor || "" },
            { key: "status", header: "Status", value: (r) => ROOM_STATUS[r.status].label, render: (r) => <Badge tone={ROOM_STATUS[r.status].tone} label={ROOM_STATUS[r.status].label} /> },
            { key: "location", header: "Property", value: (r) => r.location_name, defaultHidden: !many },
            { key: "active", header: "In use", value: (r) => (r.active ? "Yes" : "No"), render: (r) => <ActiveBadge active={r.active} /> },
            canItems && { key: "actions", header: "", type: "actions", render: (r) => <button type="button" className="link-button" onClick={() => setDialog({ kind: "room", room: r })}>Edit</button> },
          ].filter(Boolean)} />
      </SectionCard>
      </>}
      </ContentTabs>
      {dialog?.kind === "type" && <RoomTypeDialog type={dialog.type} slabsReady={setup.settings.ready} onClose={() => setDialog(null)} onSaved={() => done(dialog.type ? "Room type saved." : "Room type added.")} />}
      {dialog?.kind === "rooms" && <AddRoomsDialog setup={setup} onClose={() => setDialog(null)} onSaved={() => done("Rooms added.")} />}
      {dialog?.kind === "room" && <RoomDialog setup={setup} room={dialog.room} onClose={() => setDialog(null)} onSaved={() => done(`Room ${dialog.room.room_no} saved.`)} />}
    </div>
  );
}

// The two GST slabs of a room night, the limit, the weekend nights and the terms.
function SlabSettings({ setup, onSaved }) {
  const biz = useOpenBusiness();
  const s = setup.settings;
  const pick = (rate) => String(setup.slabs.find((x) => Number(x.rate) === rate)?.id || "");
  const [form, setForm] = useState({ low: String(s.lowTaxRateId || pick(5)), high: String(s.highTaxRateId || pick(18)), limit: String(Number(s.slabLimit)), weekend: s.weekendNights, terms: s.terms || "",
    checkIn: s.checkInTime || "12:00", checkOut: s.checkOutTime || "11:00" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canEdit = biz.can("settings.edit");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const toggle = (day) => setForm((f) => ({ ...f, weekend: f.weekend.includes(day) ? f.weekend.filter((d) => d !== day) : [...f.weekend, day].sort() }));
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await businessWrite(biz.id, "lodging/settings", { lowTaxRateId: form.low, highTaxRateId: form.high, slabLimit: form.limit, weekendNights: form.weekend, terms: form.terms.trim() || null,
        checkInTime: form.checkIn, checkOutTime: form.checkOut }, "put");
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard icon="percent" title="GST slabs, nights and times" description={SLAB_NOTE}>
      {!s.ready && <p className="ldg-note ldg-warn">Nothing is reserved or billed until the two slabs are saved.</p>}
      <form className="form-grid bz-form" onSubmit={save}>
        <fieldset className="bz-fieldset" disabled={!canEdit || busy}>
          <Field label={`Slab at or below the limit (${biz.exact(form.limit || 0)} a night)`}><select required value={form.low} onChange={set("low")}>
            <option value="">Choose…</option>{setup.slabs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="Slab above the limit"><select required value={form.high} onChange={set("high")}>
            <option value="">Choose…</option>{setup.slabs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="The limit a room a night (before GST)" hint="₹7,500 from 22 September 2025."><input required type="number" min="1" step="0.01" value={form.limit} onChange={set("limit")} /></Field>
          <div className="field field-wide">
            <span>Weekend nights (at the weekend rate)</span>
            <div className="ldg-weekdays" role="group" aria-label="Weekend nights">
              {WEEKDAYS.map(([day, name]) => <label key={day} className="checkbox bz-check"><input type="checkbox" checked={form.weekend.includes(day)} onChange={() => toggle(day)} /> {name}</label>)}
            </div>
            <small className="muted">A night belongs to the date it starts on: Friday and Saturday nights are the usual weekend.</small>
          </div>
          <Field label="Check-in from" hint="The property's own time: before it on the arrival day, the policy's early check-in charge applies."><input required type="time" value={form.checkIn} onChange={set("checkIn")} /></Field>
          <Field label="Check-out by" hint="After it on the departure day, the policy's late check-out charge applies."><input required type="time" value={form.checkOut} onChange={set("checkOut")} /></Field>
          <Field label="Terms on the registration card (optional)" wide><textarea rows={3} maxLength={2000} value={form.terms} onChange={set("terms")} /></Field>
        </fieldset>
        {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
        {canEdit && <div className="form-actions field-wide"><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save the slabs, nights and times"}</button></div>}
      </form>
    </SectionCard>
  );
}

function RoomTypeDialog({ type, slabsReady, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(type ? { name: type.name, hsnCode: type.hsn_code || "", baseOccupancy: String(type.base_occupancy), maxOccupancy: String(type.max_occupancy),
    maxExtraBeds: String(type.max_extra_beds), rack: money(type.rack_rate), weekend: money(type.weekend_rate), extraAdult: money(type.extra_adult_rate), child: money(type.child_rate),
    extraBed: money(type.extra_bed_rate), description: type.description || "", active: type.active } : { ...blankType, active: true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const body = { baseOccupancy: form.baseOccupancy, maxOccupancy: form.maxOccupancy, maxExtraBeds: form.maxExtraBeds || 0, description: form.description.trim() || null,
    rates: { rack: form.rack, weekend: form.weekend || null, extraAdult: form.extraAdult || null, child: form.child || null, extraBed: form.extraBed || null } };
  return (
    <FormDialog title={type ? `Edit ${type.name}` : "Add a room type"} icon="home" width={680} onClose={onClose} onSaved={onSaved} submitLabel={type ? "Save" : "Add the room type"}
      description={type ? "Stays already booked keep the rates they were booked at." : `Its nights are billed as a service item counted in nights, made with it.${slabsReady ? "" : " Set the GST slabs of a room night too."}`}
      onSubmit={() => (type ? businessWrite(biz.id, `lodging/room-types/${type.id}`, { ...body, active: form.active }, "patch")
        : businessWrite(biz.id, "lodging/room-types", { item: { name: form.name.trim(), hsnCode: form.hsnCode.trim() || undefined }, ...body }))}>
      {!type && <Field label="Name"><input required maxLength={150} autoFocus value={form.name} onChange={set("name")} placeholder="e.g. Deluxe, Suite, Standard non-AC" /></Field>}
      {!type && <Field label="SAC (optional)"><input maxLength={8} inputMode="numeric" value={form.hsnCode} onChange={set("hsnCode")} /></Field>}
      <Field label="Adults in the rate"><input required type="number" min="1" max="20" value={form.baseOccupancy} onChange={set("baseOccupancy")} /></Field>
      <Field label="Most guests in the room"><input required type="number" min="1" max="30" value={form.maxOccupancy} onChange={set("maxOccupancy")} /></Field>
      <Field label="Extra beds allowed"><input type="number" min="0" max="5" value={form.maxExtraBeds} onChange={set("maxExtraBeds")} /></Field>
      <Field label="Rack rate a night (before GST)"><input required type="number" min="0.01" step="0.01" value={form.rack} onChange={set("rack")} /></Field>
      <Field label="Weekend rate a night (optional)"><input type="number" min="0.01" step="0.01" value={form.weekend} onChange={set("weekend")} /></Field>
      <Field label="Each extra adult a night (optional)" hint="Beyond the adults in the rate; none set: no more adults than that."><input type="number" min="0" step="0.01" value={form.extraAdult} onChange={set("extraAdult")} /></Field>
      <Field label="Each child a night (optional)" hint="None set: children stay free."><input type="number" min="0" step="0.01" value={form.child} onChange={set("child")} /></Field>
      <Field label="Each extra bed a night"><input type="number" min="0" step="0.01" required={Number(form.maxExtraBeds) > 0} value={form.extraBed} onChange={set("extraBed")} /></Field>
      <Field label="Description (optional)" wide><input maxLength={300} value={form.description} onChange={set("description")} /></Field>
      {type && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (switched off, it takes no new reservations)</label>}
    </FormDialog>
  );
}

function AddRoomsDialog({ setup, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const types = setup.roomTypes.filter((t) => t.active);
  const [form, setForm] = useState({ locationId: String(biz.currentLocationId || locations[0]?.id || ""), roomTypeId: String(types[0]?.id || ""), numbers: "", floor: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const numbers = form.numbers.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <FormDialog title="Add rooms" icon="plus" width={560} onClose={onClose} onSaved={onSaved} submitLabel={numbers.length > 1 ? `Add ${numbers.length} rooms` : "Add the room"}
      description="Room numbers of one type, separated by commas or one on each line."
      onSubmit={() => businessWrite(biz.id, "lodging/rooms", { locationId: form.locationId, roomTypeId: form.roomTypeId, rooms: numbers.map((roomNo) => ({ roomNo, floor: form.floor.trim() || undefined })) })}>
      {locations.length > 1 && <Field label="Property"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="Room type"><select required value={form.roomTypeId} onChange={set("roomTypeId")}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <Field label="Room numbers" wide><textarea required rows={3} value={form.numbers} onChange={set("numbers")} placeholder="101, 102, 103" /></Field>
      <Field label="Floor (optional)"><input maxLength={30} value={form.floor} onChange={set("floor")} /></Field>
    </FormDialog>
  );
}

function RoomDialog({ setup, room, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ roomNo: room.room_no, floor: room.floor || "", roomTypeId: String(room.room_type_id), active: room.active });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title={`Room ${room.room_no}`} icon="home" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Save"
      description="A room with a stay reserved for it or in it keeps its type and stays in use until the stay moves."
      onSubmit={() => businessWrite(biz.id, `lodging/rooms/${room.id}`, { roomNo: form.roomNo.trim(), floor: form.floor.trim() || null, roomTypeId: form.roomTypeId, active: form.active }, "patch")}>
      <Field label="Room number"><input required maxLength={20} value={form.roomNo} onChange={set("roomNo")} /></Field>
      <Field label="Floor (optional)"><input maxLength={30} value={form.floor} onChange={set("floor")} /></Field>
      <Field label="Room type"><select value={form.roomTypeId} onChange={set("roomTypeId")}>{setup.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>
    </FormDialog>
  );
}
