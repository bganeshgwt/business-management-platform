import { useEffect, useMemo, useState } from "react";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { PRIORITIES, addDays, dateWords } from "./lodging";

// The house's dialogs: a room booked out of order (from today or ahead, to a
// last night or until put back), out of service with why, a room's linen or
// minibar counted against its checklist (the minibar the guest used goes on
// their folio), a maintenance ticket opened (with the out-of-order period the
// work needs) and finished or cancelled, and a guest moved to another property.
// Every rule is the server's; these only ask.

// A room put out of order: its first night (today or ahead), its last (none: until put back in order) and why.
export function OutOfOrderDialog({ room, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ startsOn: today, endsOn: "", reason: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Room ${room.room_no} out of order`} icon="ban" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Put it out of order"
      description="It is off sale those nights: a reservation that would need it is refused with the reason. Leave the last night empty to keep it out of order until it is put back."
      onSubmit={() => businessWrite(biz.id, "lodging/out-of-order", { requestKey, roomId: room.id, startsOn: form.startsOn, endsOn: form.endsOn || undefined, reason: form.reason.trim() })}>
      <Field label="From the night of"><input required type="date" min={today} value={form.startsOn} onChange={set("startsOn")} /></Field>
      <Field label="To the night of (optional)"><input type="date" min={form.startsOn} value={form.endsOn} onChange={set("endsOn")} /></Field>
      <Field label="Why" wide><input required maxLength={300} autoFocus value={form.reason} onChange={set("reason")} placeholder="e.g. AC not cooling, technician called" /></Field>
    </FormDialog>
  );
}

// A room out of service: still sold, flagged with why.
export function OutOfServiceDialog({ room, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [note, setNote] = useState("");
  return (
    <FormDialog title={`Room ${room.room_no} out of service`} icon="info" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Flag it"
      description="The room stays on sale; the front desk sees the flag and why."
      onSubmit={() => businessWrite(biz.id, `lodging/rooms/${room.id}/flags`, { outOfService: true, note: note.trim() })}>
      <Field label="Why" wide><input required maxLength={300} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. TV not working, view blocked" /></Field>
    </FormDialog>
  );
}

// A room's linen or minibar counted against its room type's checklist.
export function RoomCheckDialog({ room, kind, items, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const mine = items.filter((i) => Number(i.room_type_id) === Number(room.room_type_id) && i.kind === kind);
  const [found, setFound] = useState(() => Object.fromEntries(mine.map((i) => [i.id, String(i.par)])));
  const [note, setNote] = useState("");
  const guest = room.status === "occupied" && room.guest;
  return (
    <FormDialog title={`Room ${room.room_no}: ${kind === "minibar" ? "minibar" : "linen"} check`} icon="check" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Save the check"
      description={kind === "minibar" ? (guest ? `What is used goes on ${guest.guest_name}'s folio (${guest.stay_no}) at the item's price.` : "No guest in the room: the count is kept, nothing is charged.")
        : "How many of each are in the room."}
      onSubmit={() => businessWrite(biz.id, `lodging/rooms/${room.id}/checks`, { requestKey, kind, lines: mine.map((i) => ({ itemId: i.id, found: found[i.id] })), note: note.trim() || undefined })}>
      {!mine.length && <p className="field-wide ldg-clash" role="alert">This room type has no {kind} checklist yet: set it under Settings › Room types &amp; rates.</p>}
      {mine.map((i) => (
        <Field key={i.id} label={`${i.name} (holds ${i.par})`}>
          <input required type="number" min="0" max="999" step="1" value={found[i.id]} onChange={(e) => setFound((f) => ({ ...f, [i.id]: e.target.value }))} />
        </Field>
      ))}
      <Field label="Note (optional)" wide><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </FormDialog>
  );
}

// A maintenance ticket: the room, the issue, its priority, who it is given to, and the out-of-order period the work needs.
export function TicketDialog({ rooms, room, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [staff, setStaff] = useState([]);
  const [form, setForm] = useState({ roomId: room ? String(room.id) : "", issue: "", priority: "normal", assignedTo: "", down: false, startsOn: today, endsOn: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/tickets/staff", undefined, controller.signal).then(setStaff).catch(() => {});
    return () => controller.abort();
  }, [biz.id]);
  return (
    <FormDialog title="Open a maintenance ticket" icon="settings" width={640} onClose={onClose} onSaved={onSaved} submitLabel="Open the ticket"
      description="A room's repair: the issue, its priority and who does it. When the work needs the room off sale, book it out of order with the ticket; it is put back in order when the ticket is done."
      onSubmit={() => businessWrite(biz.id, "lodging/tickets", { requestKey, roomId: form.roomId, issue: form.issue.trim(), priority: form.priority, assignedTo: form.assignedTo || undefined,
        ...(form.down ? { outOfOrder: { startsOn: form.startsOn, endsOn: form.endsOn || undefined } } : {}) })}>
      <Field label="Room"><select required value={form.roomId} onChange={set("roomId")}>
        <option value="">Choose…</option>
        {rooms.map((r) => <option key={r.id} value={r.id}>Room {r.room_no} · {r.room_type}{biz.locations.length > 1 ? ` · ${r.location_name}` : ""}</option>)}</select></Field>
      <Field label="Priority"><select value={form.priority} onChange={set("priority")}>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
      <Field label="The issue" wide><input required maxLength={500} autoFocus value={form.issue} onChange={set("issue")} placeholder="e.g. Geyser leaking" /></Field>
      <Field label="Given to (optional)"><select value={form.assignedTo} onChange={set("assignedTo")}>
        <option value="">No one yet</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.down} onChange={set("down")} /> The work needs the room out of order</label>
      {form.down && (
        <>
          <Field label="From the night of"><input required type="date" min={today} value={form.startsOn} onChange={set("startsOn")} /></Field>
          <Field label="To the night of (optional: until the work is done)"><input type="date" min={form.startsOn} value={form.endsOn} onChange={set("endsOn")} /></Field>
        </>
      )}
    </FormDialog>
  );
}

// A ticket done (with what was done) or cancelled (with why).
export function TicketStepDialog({ ticket, step, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(false);
  const done = step === "done";
  return (
    <FormDialog title={`Ticket ${ticket.ticket_no}: ${done ? "work done" : "cancel"}`} icon={done ? "check" : "ban"} width={540} onClose={onClose} onSaved={onSaved}
      submitLabel={done ? "Mark it done" : "Cancel the ticket"} description={`Room ${ticket.room_no} · ${ticket.issue}`}
      onSubmit={() => businessWrite(biz.id, `lodging/tickets/${ticket.id}/${done ? "done" : "cancel"}`, done ? { outcome: text.trim() || undefined, keepOutOfOrder: keep } : { reason: text.trim(), keepOutOfOrder: keep })}>
      <Field label={done ? "What was done (optional)" : "Why it is cancelled"} wide><input required={!done} maxLength={500} autoFocus value={text} onChange={(e) => setText(e.target.value)} /></Field>
      {ticket.out_of_order_id && !ticket.out_of_order_withdrawn && (
        <label className="checkbox bz-check field-wide"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep the room out of order (otherwise it is back in order from tonight)</label>
      )}
    </FormDialog>
  );
}

// A guest moved to another property mid-stay: checked out here (the folio billed with this property's GST), checked in there, linked.
export function MovePropertyDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const places = biz.locations.filter((l) => l.active && Number(l.id) !== Number(stay.location_id));
  const [setup, setSetup] = useState(null);
  const [free, setFree] = useState([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ locationId: String(places[0]?.id || ""), roomTypeId: String(stay.room_type_id), roomId: "", departure: stay.departure > today ? stay.departure : addDays(today, 1),
    pay: "", method: "cash" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/setup", undefined, controller.signal).then(setSetup).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  useEffect(() => {
    if (!form.locationId || !form.roomTypeId || !form.departure || form.departure <= today) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "lodging/free", { arrival: today, departure: form.departure, roomType: form.roomTypeId, location: form.locationId }, controller.signal)
      .then((r) => setFree(r.rooms)).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, form.locationId, form.roomTypeId, form.departure, today]);
  const types = useMemo(() => (setup?.roomTypes || []).filter((t) => t.active), [setup]);
  const rooms = free.filter((r) => r.free && r.status === "vacant_clean");
  return (
    <FormDialog title={`Move ${stay.guest_name} to another property`} icon="home" width={640} onClose={onClose} onSaved={onSaved} submitLabel="Move the guest"
      description={`Checked out here today: the folio is billed with this property's GST, paid by the advance first; what is left of the advance carries to the new stay. Checked in at the other property tonight, with the same occupants.`}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/move`, { requestKey, locationId: form.locationId, roomTypeId: form.roomTypeId, roomId: form.roomId, departure: form.departure,
        ...(Number(form.pay) > 0 ? { payment: { amount: form.pay, method: form.method } } : {}) })}>
      {error && <p className="field-wide ldg-clash" role="alert">{error}</p>}
      {!places.length && <p className="field-wide ldg-clash" role="alert">The business has one property: add another under Settings › Locations first.</p>}
      <Field label="Property"><select required value={form.locationId} onChange={set("locationId")}>{places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      <Field label="Room type"><select required value={form.roomTypeId} onChange={set("roomTypeId")}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <Field label="Room" hint={rooms.length ? undefined : "No room of the type is free and clean there for these nights."}><select required value={form.roomId} onChange={set("roomId")}>
        <option value="">Choose…</option>{rooms.map((r) => <option key={r.id} value={r.id}>Room {r.roomNo}{r.outOfService ? ` · out of service (${r.outOfService})` : ""}</option>)}</select></Field>
      <Field label="Leaving there on"><input required type="date" min={addDays(today, 1)} value={form.departure} onChange={set("departure")} /></Field>
      <Field label={`Paid now here (${biz.symbol}, optional)`} hint={`The bill here covers the nights to ${dateWords(today)}.`}><input type="number" min="0" step="0.01" value={form.pay} onChange={set("pay")} /></Field>
      {Number(form.pay) > 0 && <Field label="Paid by"><select value={form.method} onChange={set("method")}>{["cash", "upi", "card", "bank"].map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}</select></Field>}
    </FormDialog>
  );
}
