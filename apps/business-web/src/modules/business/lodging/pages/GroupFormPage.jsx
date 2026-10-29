import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useDirtyGuard, useOpenBusiness } from "../../core/pages/hooks";
import { ROUTE_KINDS, addDays } from "./lodging";
import "../styles/lodging.css";

// A group booking: one booking of several rooms (a block) for a group or a
// company, billed to its organiser or the company (found, or typed new): the
// group's dates, and each room with its room type, rate plan, room (or none
// yet), guests and, if it comes or goes apart, its own dates. Each kind of
// charge goes to the group's folio or to each room's own (the room and its tax
// to the group, to start with). Each room is a stay of its own, checked by the
// server as any reservation (the calendar, the rooms free).

const blankRoom = (roomTypeId = "") => ({ roomTypeId, ratePlanId: "", roomId: "", adults: "2", children: "0", ownDates: false, arrival: "", departure: "" });

export default function GroupFormPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const today = businessToday(biz.business.timezone);
  const locations = biz.locations.filter((l) => l.active);
  const [setup, setSetup] = useState(null);
  const [plans, setPlans] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [requestKey, setRequestKey] = useState(newKey);
  const [organiser, setOrganiser] = useState(null);
  const [typed, setTyped] = useState(null);
  const [form, setForm] = useState({ locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""), name: "", arrival: today, departure: addDays(today, 1),
    notes: "", route: { room: "group", meals: "stay", extras: "stay", goods: "stay" } });
  const [rooms, setRooms] = useState([blankRoom(), blankRoom()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  useDirtyGuard(Boolean(form.name || organiser || typed));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/setup", undefined, controller.signal).then((s) => {
      setSetup(s);
      const first = String(s.roomTypes.find((t) => t.active)?.id || "");
      setRooms((all) => all.map((r) => (r.roomTypeId ? r : { ...r, roomTypeId: first })));
    }).catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    businessRead(biz.id, "lodging/rates", { days: 1 }, controller.signal).then((r) => setPlans(r.plans.filter((p) => p.active))).catch(() => setPlans([]));
    return () => controller.abort();
  }, [biz.id]);
  const change = (index, name) => (e) => setRooms((all) => all.map((r, i) => (i !== index ? r
    : name === "roomTypeId" ? { ...r, roomTypeId: e.target.value, ratePlanId: "", roomId: "" } : { ...r, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value })));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!organiser && !typed?.name?.trim()) return setError("Choose the organiser or company the group is billed to, or type a new one's name");
    if (form.departure <= form.arrival) return setError("The departure is after the arrival: a stay is one night at least");
    setBusy(true);
    try {
      const group = await businessWrite(biz.id, "lodging/groups", {
        requestKey, locationId: form.locationId, name: form.name.trim(),
        ...(organiser ? { contactId: organiser.id } : { guest: { name: typed.name.trim(), phone: typed.phone?.trim() || undefined } }),
        arrival: form.arrival, departure: form.departure, route: form.route, notes: form.notes.trim() || undefined,
        rooms: rooms.map((r) => ({ roomTypeId: r.roomTypeId, ratePlanId: r.ratePlanId || undefined, roomId: r.roomId || undefined, adults: r.adults, children: r.children || 0,
          ...(r.ownDates ? { arrival: r.arrival, departure: r.departure } : {}) })),
      });
      toast.success(`Group booking ${group.group_no} saved.`);
      setOrganiser(null);
      setTyped(null);
      setForm((f) => ({ ...f, name: "" }));
      setRequestKey(newKey());
      navigate(biz.path(`lodging-groups/${group.id}`));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!setup) return <div className="stack"><BusinessHeader icon="users" title="New group booking" /><ErrorMessage message={loadError} />{!loadError && <Loading label="Loading the room types…" />}</div>;
  if (!biz.can("lodging.create")) return <div className="stack"><BusinessHeader icon="users" title="New group booking" /><p className="ldg-note">Your role does not take reservations.</p></div>;
  const types = setup.roomTypes.filter((t) => t.active);
  const searchCustomers = (q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items);
  return (
    <form className="stack" onSubmit={submit}>
      <BusinessHeader icon="users" title="New group booking"
        description="Several rooms booked together for a group or a company: each room is a stay of its own, and the group's folio is billed to the organiser or company once every room has left."
        secondary={<Link className="button button-secondary" to={biz.path("lodging-reservations")}><Icon name="arrow-left" size={15} /> Reservations</Link>} />
      <SectionCard icon="users" title="The group">
        <div className="form-grid bz-form">
          <Field label="Group name"><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Sharma wedding party, Infotech offsite" /></Field>
          {typed ? (
            <>
              <Field label="Organiser or company"><input required maxLength={150} value={typed.name} onChange={(e) => setTyped((c) => ({ ...c, name: e.target.value }))} /></Field>
              <Field label="Phone (optional)"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((c) => ({ ...c, phone: e.target.value }))} /></Field>
              <button type="button" className="link-button" onClick={() => setTyped(null)}>Find one instead</button>
            </>
          ) : (
            <>
              <div className="field">
                <SearchPicker label="Billed to (organiser or company)" placeholder="Name or phone" value={organiser} onChange={setOrganiser} minChars={2} search={searchCustomers}
                  getLabel={(x) => x.name} getDescription={(x) => (x.gstin ? `GSTIN ${x.gstin}` : x.phone || "")} />
              </div>
              {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setOrganiser(null); setTyped({ name: "", phone: "" }); }}><Icon name="user-plus" size={15} /> New organiser</button>}
            </>
          )}
          {locations.length > 1 && <Field label="Property"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
          <Field label="Arrival"><input type="date" required min={today} value={form.arrival}
            onChange={(e) => setForm((f) => ({ ...f, arrival: e.target.value, departure: f.departure > e.target.value ? f.departure : addDays(e.target.value, 1) }))} /></Field>
          <Field label="Departure"><input type="date" required min={form.arrival ? addDays(form.arrival, 1) : undefined} value={form.departure} onChange={set("departure")} /></Field>
          <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
        </div>
      </SectionCard>
      <SectionCard icon="home" title="Rooms" description="Two rooms or more. A room without a room number is given one at check-in; each room's guest is named on the rooming list (until then, the organiser)."
        actions={rooms.length < 50 && <button type="button" className="button button-secondary button-sm" onClick={() => setRooms((all) => [...all, blankRoom(String(types[0]?.id || ""))])}><Icon name="plus" size={14} /> Add a room</button>}>
        <div className="form-grid bz-form">
          {rooms.map((r, i) => {
            const type = types.find((t) => String(t.id) === r.roomTypeId);
            const typeRooms = setup.rooms.filter((x) => x.active && String(x.room_type_id) === r.roomTypeId && String(x.location_id) === form.locationId);
            return (
              <fieldset key={i} className="field-wide ldg-fieldset" aria-label={`Room ${i + 1}`}>
                <legend>Room {i + 1}</legend>
                <Field label="Room type"><select required value={r.roomTypeId} onChange={change(i, "roomTypeId")}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
                <Field label="Rate plan"><select value={r.ratePlanId} onChange={change(i, "ratePlanId")}>
                  <option value="">No plan</option>{plans.filter((p) => String(p.room_type_id) === r.roomTypeId && (!p.location_id || String(p.location_id) === form.locationId)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.meal_plan})</option>)}</select></Field>
                <Field label="Room"><select value={r.roomId} onChange={change(i, "roomId")}>
                  <option value="">No room yet</option>{typeRooms.map((x) => <option key={x.id} value={x.id}>{x.room_no}</option>)}</select></Field>
                <Field label="Adults"><input type="number" required min="1" max={type?.max_occupancy || 30} value={r.adults} onChange={change(i, "adults")} /></Field>
                <Field label="Children"><input type="number" min="0" max="30" value={r.children} onChange={change(i, "children")} /></Field>
                <label className="checkbox bz-check"><input type="checkbox" checked={r.ownDates} onChange={change(i, "ownDates")} /> Its own dates</label>
                {r.ownDates && <Field label="Arrival"><input type="date" required min={today} value={r.arrival} onChange={change(i, "arrival")} /></Field>}
                {r.ownDates && <Field label="Departure"><input type="date" required min={r.arrival ? addDays(r.arrival, 1) : undefined} value={r.departure} onChange={change(i, "departure")} /></Field>}
                {rooms.length > 2 && <button type="button" className="link-button" onClick={() => setRooms((all) => all.filter((_, j) => j !== i))}>Remove</button>}
              </fieldset>
            );
          })}
        </div>
      </SectionCard>
      <SectionCard icon="receipt" title="Where the charges go" description="To the group's folio (billed to the organiser or company) or to each room's own folio (billed to its guest at its check-out).">
        <div className="form-grid bz-form">
          {ROUTE_KINDS.map((k) => (
            <Field key={k.value} label={k.label}><select value={form.route[k.value]} onChange={(e) => setForm((f) => ({ ...f, route: { ...f.route, [k.value]: e.target.value } }))}>
              <option value="group">The group's folio</option><option value="stay">Each room's own folio</option></select></Field>
          ))}
        </div>
      </SectionCard>
      <ErrorMessage message={error} />
      <div className="form-actions">
        <button type="submit" className="button" disabled={busy || !types.length}><Icon name="check" size={16} /> {busy ? "Saving…" : `Book ${rooms.length} rooms`}</button>
      </div>
    </form>
  );
}
