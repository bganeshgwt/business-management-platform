import { useCallback, useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { BOOKING_STATUSES, WEEKDAYS, dayWords } from "./memberships";
import "../styles/memberships.css";

// Classes: the week's classes made from the timetable, each with its places,
// its waitlist and its bookings. The desk (or a trainer) books a member on a
// membership that books the class, cancels (free before the cut-off, a late
// cancel after it with the shop's penalty), and marks attendance on the class
// list (a no-show once it has begun); a full class puts the member on its
// waitlist, and a place that frees promotes the first on it. The timetable
// below (rooms, and each class on its weekday with its instructor, places,
// booking window, cut-off and waitlist) is changed by those who set up plans.

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekdayOf = (day) => { const d = new Date(`${day}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };

export default function ClassesPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [from, setFrom] = useState(today);
  const [week, setWeek] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState("week");
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "member-plans/classes", { from, days: 7 }, controller.signal)
      .then((w) => { setWeek(w); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, from, version]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Classes"
        description="The week's classes from the timetable: book members, keep the waitlist, mark attendance. A full class puts a member on its waitlist; a place that frees promotes the first on it." />
      <div className="fe-chips" role="group" aria-label="Classes or timetable">
        {[["week", "The week"], ["timetable", "Timetable"]].map(([value, label]) => (
          <button key={value} type="button" aria-pressed={tab === value} className={`fe-chip ${tab === value ? "is-active" : ""}`} onClick={() => setTab(value)}>{label}</button>
        ))}
      </div>
      <ErrorMessage message={error} />
      {tab === "week" && (
        <>
          <div className="bz-row-actions">
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom(addDays(from, -7))}><Icon name="arrow-left" size={14} /> Week before</button>
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom(today)}>This week</button>
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom(addDays(from, 7))}>Week after</button>
          </div>
          {!week ? <Loading /> : (
            <div className="mem-week">
              {days.map((day) => {
                const list = week.sessions.filter((s) => s.day === day);
                return (
                  <section key={day} className="mem-day" aria-label={`${WEEKDAYS[weekdayOf(day) - 1]} ${dayWords(day)}`}>
                    <h3>{WEEKDAYS[weekdayOf(day) - 1]} <small className="muted">{dayWords(day)}</small></h3>
                    {!list.length && <p className="muted small">No classes</p>}
                    {list.map((s) => (
                      <button key={s.id} type="button" className={`mem-class ${s.cancelled_at ? "is-off" : ""} ${open === s.id ? "is-open" : ""}`} onClick={() => setOpen(s.id)}>
                        <strong>{s.time} {s.class_name}</strong>
                        <small>{s.room_name}{s.trainer_name ? ` · ${s.trainer_name}` : ""}</small>
                        <small>{s.cancelled_at ? "Called off" : `${s.held} of ${s.capacity} booked${s.waiting ? ` · ${s.waiting} waiting` : ""}`}</small>
                      </button>
                    ))}
                  </section>
                );
              })}
            </div>
          )}
          {open && <ClassList sessionId={open} onChanged={reload} version={version} />}
        </>
      )}
      {tab === "timetable" && <Timetable onChanged={reload} />}
    </div>
  );
}

function ClassList({ sessionId, onChanged, version }) {
  const biz = useOpenBusiness();
  const [s, setSession] = useState(null);
  const [error, setError] = useState("");
  const [member, setMember] = useState(null);
  const [busy, setBusy] = useState(false);
  const [calling, setCalling] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `member-plans/classes/${sessionId}`, undefined, controller.signal).then((x) => { setSession(x); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, sessionId, version]);
  const act = async (work, message) => {
    setBusy(true);
    try {
      const next = await work();
      setSession(next);
      toast.success(typeof message === "function" ? message(next) : message);
      onChanged();
    } catch (err) { toast.error(getErrorMessage(err)); } finally { setBusy(false); }
  };
  if (!s) return <ErrorMessage message={error} />;
  const canBook = biz.can("member_plans.create") && !s.cancelled_at && !s.begun;
  const book = () => act(() => businessWrite(biz.id, `member-plans/classes/${s.id}/bookings`, { requestKey: newKey(), contactId: member.contact_id }),
    (next) => `${member.name} ${next.booking?.status === "waitlisted" ? "is on the waitlist" : "is booked"}.`).then(() => setMember(null));
  const cancel = (b) => act(() => businessWrite(biz.id, `member-plans/class-bookings/${b.id}/cancel`, {}),
    (next) => `${b.member_name}'s booking cancelled${next.late ? ", late" : ""}${next.promoted ? `; ${next.promoted} is promoted from the waitlist` : ""}.`);
  const mark = (b, status) => act(() => businessWrite(biz.id, `member-plans/class-bookings/${b.id}/attendance`, { status }), `${b.member_name}: ${BOOKING_STATUSES[status].label.toLowerCase()}.`);
  return (
    <SectionCard flush icon="calendar" title={`${s.class_name}, ${dayWords(s.day)} at ${s.time}`}
      description={`${s.room_name}${s.trainer_name ? ` · ${s.trainer_name}` : ""} · ${s.held} of ${s.capacity} places${s.waitlist_size ? `, waitlist of ${s.waitlist_size}` : ""}${s.cancelled_at ? ` · called off: ${s.cancel_reason}` : ""}`}
      actions={!s.cancelled_at && !s.begun && biz.can("member_plans.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => setCalling(true)}>Call off</button>}>
      {canBook && (
        <div className="mem-book">
          <SearchPicker label="Book a member" placeholder="Name, phone or member code" value={member} onChange={setMember} minChars={2}
            search={(q, { signal }) => businessRead(biz.id, "member-plans/members", { q, limit: 10 }, signal).then((page) => page.items)}
            getLabel={(m) => m.name} getDescription={(m) => [m.member_code, m.plan_name].filter(Boolean).join(" · ")} />
          <button type="button" className="button" disabled={!member || busy} onClick={book}>Book</button>
        </div>
      )}
      <DataGrid variant="compact" id="member-class-list" caption="Class list" rows={s.bookings} rowKey={(b) => b.id} rowNoun={["booking", "bookings"]} empty="Nobody has booked yet"
        columns={[
          { key: "member_name", header: "Member", value: (b) => b.member_name, mobile: "title",
            render: (b) => <span className="bz-two-line"><span>{b.member_name}</span><small className="muted mono">{b.member_code}</small></span> },
          { key: "plan_name", header: "Membership", value: (b) => `${b.plan_name} ${b.membership_no}` },
          { key: "status", header: "", value: (b) => BOOKING_STATUSES[b.status]?.label, mobile: "show",
            render: (b) => <Badge tone={BOOKING_STATUSES[b.status]?.tone} label={`${BOOKING_STATUSES[b.status]?.label}${b.penalty ? ` · ${b.penalty === "fee" ? "fee billed" : "a session taken"}` : ""}`} /> },
          { key: "actions", header: "", label: "Actions", type: "actions", render: (b) => biz.can("member_plans.create") && !s.cancelled_at && (
            <span className="bz-row-actions">
              {["booked", "promoted"].includes(b.status) && <button type="button" className="chip-button" disabled={busy} onClick={() => mark(b, "attended")}>Attended</button>}
              {["booked", "promoted"].includes(b.status) && s.begun && <button type="button" className="chip-button" disabled={busy} onClick={() => mark(b, "no_show")}>No-show</button>}
              {["booked", "promoted", "waitlisted"].includes(b.status) && !s.begun && <button type="button" className="chip-button" disabled={busy} onClick={() => cancel(b)}>Cancel</button>}
            </span>
          ) },
        ]} />
      {calling && (
        <CallOffDialog session={s} onClose={() => setCalling(false)} onSaved={(next) => { setCalling(false); setSession(next); toast.success("Class called off."); onChanged(); }} />
      )}
    </SectionCard>
  );
}

function CallOffDialog({ session, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Call off ${session.class_name}`} icon="x-circle" width={500} onClose={onClose} onSaved={onSaved} submitLabel="Call it off"
      description="Every booking and the waitlist are cancelled, with no penalty."
      onSubmit={() => businessWrite(biz.id, `member-plans/classes/${session.id}/call-off`, { reason })}>
      <Field label="Reason" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Instructor unwell" /></Field>
    </FormDialog>
  );
}

// --- The timetable ---------------------------------------------------------------------------------------

function Timetable({ onChanged }) {
  const biz = useOpenBusiness();
  const [rooms, setRooms] = useState(null);
  const [slots, setSlots] = useState(null);
  const [trainers, setTrainers] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  const canEdit = biz.can("member_plans.edit");
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "member-plans/rooms", undefined, controller.signal), businessRead(biz.id, "member-plans/class-slots", undefined, controller.signal)])
      .then(([r, s]) => { setRooms(r); setSlots(s); }).catch((err) => toast.error(getErrorMessage(err)));
    if (biz.has("appointments") && biz.can("appointments.view")) {
      businessRead(biz.id, "resources", { limit: 100 }, controller.signal).then((page) => setTrainers(page.items || [])).catch(() => setTrainers([]));
    }
    return () => controller.abort();
  }, [biz.id, version]);
  const saved = (message) => { setDialog(null); toast.success(message); setVersion((n) => n + 1); onChanged(); };
  if (!rooms || !slots) return <Loading />;
  return (
    <>
      <SectionCard flush icon="locations" title="Rooms" actions={canEdit && <button type="button" className="button button-sm" onClick={() => setDialog({ room: {} })}><Icon name="plus" size={14} /> Add a room</button>}>
        <DataGrid variant="compact" id="member-rooms" caption="Rooms" rows={rooms} rowKey={(r) => r.id} rowNoun={["room", "rooms"]} empty="No rooms yet"
          onRowClick={canEdit ? (r) => setDialog({ room: r }) : undefined} columns={[
            { key: "name", header: "Room", value: (r) => r.name, mobile: "title" },
            { key: "location_name", header: "Location", value: (r) => r.location_name },
            { key: "capacity", header: "Places", type: "number", value: (r) => r.capacity },
            { key: "active", header: "", value: (r) => (r.active ? "In use" : "Not in use"), render: (r) => <ActiveBadge active={r.active} /> },
          ]} />
      </SectionCard>
      <SectionCard flush icon="calendar" title="Weekly timetable"
        actions={canEdit && rooms.some((r) => r.active) && <button type="button" className="button button-sm" onClick={() => setDialog({ slot: {} })}><Icon name="plus" size={14} /> Add a class</button>}>
        <DataGrid variant="compact" id="member-class-slots" caption="Weekly timetable" rows={slots} rowKey={(s) => s.id} rowNoun={["class", "classes"]} empty="No classes on the timetable yet"
          onRowClick={canEdit ? (s) => setDialog({ slot: s }) : undefined} columns={[
            { key: "weekday", header: "Day", value: (s) => s.weekday, render: (s) => WEEKDAYS[s.weekday - 1], mobile: "subtitle" },
            { key: "starts_at", header: "Time", value: (s) => s.starts_at, render: (s) => `${s.starts_at} · ${s.minutes} min` },
            { key: "class_name", header: "Class", value: (s) => s.class_name, mobile: "title" },
            { key: "room_name", header: "Room", value: (s) => s.room_name },
            { key: "trainer_name", header: "Instructor", value: (s) => s.trainer_name || "" },
            { key: "capacity", header: "Places", type: "number", value: (s) => s.capacity },
            { key: "rules", header: "Booking", value: (s) => `${s.book_hours} h before · cut-off ${s.cancel_hours} h · waitlist ${s.waitlist_size}` },
            { key: "active", header: "", value: (s) => (s.active ? "On" : "Off"), render: (s) => <ActiveBadge active={s.active} /> },
          ]} />
      </SectionCard>
      {dialog?.room && <RoomDialog room={dialog.room} onClose={() => setDialog(null)} onSaved={(r) => saved(`${r.name} saved.`)} />}
      {dialog?.slot && <SlotDialog slot={dialog.slot} rooms={rooms.filter((r) => r.active || r.id === dialog.slot.room_id)} trainers={trainers} onClose={() => setDialog(null)}
        onSaved={(s) => saved(`${s.class_name} on ${WEEKDAYS[s.weekday - 1]} saved.`)} />}
    </>
  );
}

function RoomDialog({ room, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(room.id);
  const [form, setForm] = useState({ name: room.name || "", capacity: room.capacity ? String(room.capacity) : "20", active: room.active !== false,
    locationId: String(room.location_id || biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title={editing ? `Change ${room.name}` : "Add a room"} icon="locations" width={500} onClose={onClose} onSaved={onSaved}
      onSubmit={() => (editing ? businessWrite(biz.id, `member-plans/rooms/${room.id}`, form, "put") : businessWrite(biz.id, "member-plans/rooms", form))}>
      <Field label="Room"><input required maxLength={80} value={form.name} onChange={set("name")} placeholder="e.g. Studio A" /></Field>
      <Field label="Places in the room"><input type="number" required min="1" max="500" value={form.capacity} onChange={set("capacity")} /></Field>
      {!editing && biz.locations.length > 1 && <Field label="Location"><select value={form.locationId} onChange={set("locationId")}>{biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>}
    </FormDialog>
  );
}

function SlotDialog({ slot, rooms, trainers, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(slot.id);
  const [form, setForm] = useState({ roomId: String(slot.room_id || rooms[0]?.id || ""), className: slot.class_name || "", weekday: String(slot.weekday || 1), startsAt: slot.starts_at || "07:00",
    minutes: String(slot.minutes || 60), trainerId: slot.trainer_id ? String(slot.trainer_id) : "", capacity: slot.capacity ? String(slot.capacity) : "",
    bookHours: String(slot.book_hours ?? 168), cancelHours: String(slot.cancel_hours ?? 2), waitlistSize: String(slot.waitlist_size ?? 0), active: slot.active !== false });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const room = rooms.find((r) => String(r.id) === form.roomId);
  const body = { ...form, capacity: form.capacity || undefined, trainerId: form.trainerId || undefined };
  return (
    <FormDialog title={editing ? `Change ${slot.class_name}` : "Add a class"} icon="calendar" width={680} onClose={onClose} onSaved={onSaved}
      description="A change makes again the classes to come that nobody has booked; those booked keep their terms."
      onSubmit={() => (editing ? businessWrite(biz.id, `member-plans/class-slots/${slot.id}`, body, "put") : businessWrite(biz.id, "member-plans/class-slots", body))}>
      <Field label="Class"><input required maxLength={80} value={form.className} onChange={set("className")} placeholder="e.g. Yoga" /></Field>
      <Field label="Room"><select required value={form.roomId} onChange={set("roomId")}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.capacity})</option>)}</select></Field>
      <Field label="Weekday"><select value={form.weekday} onChange={set("weekday")}>{WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></Field>
      <Field label="Starts at"><input type="time" required value={form.startsAt} onChange={set("startsAt")} /></Field>
      <Field label="Minutes"><input type="number" required min="5" max="600" value={form.minutes} onChange={set("minutes")} /></Field>
      <Field label="Instructor"><select value={form.trainerId} onChange={set("trainerId")}><option value="">None</option>{trainers.filter((t) => t.active !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <Field label="Places" hint={room ? `The room holds ${room.capacity}; empty: all of them.` : undefined}><input type="number" min="1" max={room?.capacity || 500} value={form.capacity} onChange={set("capacity")} /></Field>
      <Field label="Booking opens (hours before)"><input type="number" required min="1" max="720" value={form.bookHours} onChange={set("bookHours")} /></Field>
      <Field label="Cancel cut-off (hours before)" hint="A cancel after it is a late cancel, with the shop's penalty."><input type="number" required min="0" max="168" value={form.cancelHours} onChange={set("cancelHours")} /></Field>
      <Field label="Waitlist"><input type="number" required min="0" max="100" value={form.waitlistSize} onChange={set("waitlistSize")} /></Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> On the timetable</label>}
    </FormDialog>
  );
}
