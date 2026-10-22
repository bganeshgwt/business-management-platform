import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath, word } from "../../../../services/businessNav";
import FormDialog from "./FormDialog";
import { Badge, BusinessHeader, Field, PeriodFilter } from "./ui";
import { useOpenBusiness, useOptions, useServerList } from "./hooks";
import "../../health/styles/health.css";

const clock = (value) => new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

// Bookings against staff and rooms. Two bookings for the same person never
// overlap; back-to-back is fine.
const dayIn = (value, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(value));
const onOrBefore = (value, timeZone) => dayIn(value, timeZone) <= dayIn(Date.now(), timeZone);

export default function AppointmentsPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("");
  const list = useServerList("appointments", { gridId: "business-appointments", period: "ahead", params: status ? { status } : {} });
  // A salon books, finishes and cancels in its Calendar, where service times,
  // rooms, deposits and the no-show rule apply (the server applies them here too).
  const salon = biz.type === "salon";
  const [booking, setBooking] = useState(() => params.get("new") === "1" && biz.can("appointments.create") && !salon);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (params.get("new")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);

  const update = async (row, next) => {
    try {
      await businessWrite(biz.id, `appointments/${row.id}`, { status: next }, "patch");
      setNotice(`${row.contact_name}'s appointment marked ${next === "no_show" ? "no-show" : next}.`);
      list.reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const columns = [
    { key: "starts_at", header: "When", type: "datetime", value: (a) => a.starts_at, mobile: "subtitle",
      render: (a) => `${new Date(a.starts_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}, ${clock(a.starts_at)}–${clock(a.ends_at)}` },
    { key: "contact_name", header: word(biz.type, "customers", "Customers").replace(/s$/, ""), value: (a) => a.contact_name, mobile: "title", pin: true },
    { key: "service_name", header: "Service", value: (a) => a.service_name, mobile: "show" },
    { key: "resource_name", header: "With", value: (a) => a.resource_name, mobile: "show" },
    { key: "status", header: "Status", type: "status", value: (a) => a.status, render: (a) => <Badge status={a.status} /> },
    salon && { key: "actions", header: "", label: "Actions", type: "actions", render: (a) => (
      <Link className="chip-button" to={`${businessPath(biz.id, "salon-calendar")}?date=${new Intl.DateTimeFormat("en-CA", { timeZone: biz.business.timezone }).format(new Date(a.starts_at))}`}>Open in calendar</Link>
    ) },
    !salon && (biz.can("appointments.edit") || biz.can("appointments.cancel")) && { key: "actions", header: "", label: "Actions", type: "actions", render: (a) => a.status === "booked" && (
      <div className="row-actions">
        {/* Done on the day or later; no-show only once the start time has passed (the server checks both). */}
        {biz.can("appointments.edit") && onOrBefore(a.starts_at, biz.business.timezone) && <button type="button" className="chip-button" onClick={() => update(a, "completed")}>Done</button>}
        {biz.can("appointments.edit") && new Date(a.starts_at).getTime() <= Date.now() && <button type="button" className="chip-button" onClick={() => update(a, "no_show")}>No-show</button>}
        {biz.can("appointments.cancel") && <button type="button" className="chip-button" onClick={() => update(a, "cancelled")}>Cancel</button>}
      </div>
    ) },
  ];

  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title={salon ? "Appointment history" : "Appointments"}
        description={salon
          ? "Every booking for the period. Book, finish, mark a no-show or cancel in the Calendar, where service times, rooms, deposits and the no-show rule apply."
          : "Who is booked with whom, and when. The same person or room cannot be double-booked."}
        actions={salon
          ? <Link className="button" to={businessPath(biz.id, "salon-calendar")}><Icon name="calendar" size={16} /> Open the calendar</Link>
          : biz.can("appointments.create") && <button type="button" className="button" onClick={() => setBooking(true)}><Icon name="plus" size={16} /> Book appointment</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="list" title="Appointments this month and the next 30 days">
        <DataGrid {...list.gridProps} caption="Appointments" columns={columns.filter(Boolean)} rowNoun={["appointment", "appointments"]}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field">
                <span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">All</option>
                  <option value="booked">Booked</option>
                  <option value="completed">Completed</option>
                  <option value="no_show">No-show</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
            </>
          )}
          rowClassName={(a) => (a.status === "cancelled" ? "dg-tone-muted" : a.status === "no_show" ? "dg-tone-warning" : "")}
          empty="No appointments in these dates" emptyIcon="calendar" />
      </SectionCard>
      {booking && <BookDialog onClose={() => setBooking(false)} onSaved={() => { setBooking(false); setNotice("Appointment booked."); list.reload(); }} />}
    </div>
  );
}

function BookDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["contacts?kind=customer&active=true", "catalog?kind=service&active=true", "resources"]);
  const [form, setForm] = useState({ contactId: "", skuId: "", resourceId: "", date: "", start: "10:00", minutes: "60" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  // A clinic books a doctor's free slot in their OPD timings (and their fee).
  const clinic = biz.type === "healthcare";
  const slotKey = clinic && form.resourceId && form.date ? `${form.resourceId}|${form.date}` : "";
  const [loaded, setLoaded] = useState({ key: "", data: null });
  const [picked, setPicked] = useState(null);
  useEffect(() => {
    if (!slotKey) return undefined;
    const [doctor, day] = slotKey.split("|");
    const controller = new AbortController();
    businessRead(biz.id, "clinic/slots", { doctor, day }, controller.signal).then((r) => {
      setLoaded({ key: slotKey, data: r });
      if (r.doctor.consultation_sku_id) setForm((f) => (f.skuId ? f : { ...f, skuId: String(r.doctor.consultation_sku_id) }));
    }).catch(() => { if (!controller.signal.aborted) setLoaded({ key: slotKey, data: null }); });
    return () => controller.abort();
  }, [biz.id, slotKey]);
  // A slot chosen for another doctor or day no longer counts.
  const slots = loaded.key === slotKey ? loaded.data : null;
  const slot = picked?.key === slotKey ? picked.slot : null;
  const setSlot = (s) => setPicked({ key: slotKey, slot: s });
  const bySlot = Boolean(slots?.scheduled);
  const submit = () => {
    if (bySlot) {
      if (!slot) throw new Error("Choose a free slot");
      return businessWrite(biz.id, "appointments", { contactId: form.contactId, skuId: form.skuId, resourceId: form.resourceId, startsAt: slot.starts_at, endsAt: slot.ends_at });
    }
    const starts = new Date(`${form.date}T${form.start}`);
    const ends = new Date(starts.getTime() + Number(form.minutes) * 60000);
    return businessWrite(biz.id, "appointments", { contactId: form.contactId, skuId: form.skuId, resourceId: form.resourceId, startsAt: starts.toISOString(), endsAt: ends.toISOString() });
  };
  return (
    <FormDialog title="Book an appointment" icon="calendar" width={620} submitLabel="Book" onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}>
      <Field label={word(biz.type, "customers", "Customers").replace(/s$/, "")}>
        <select required value={form.contactId} onChange={set("contactId")}>
          <option value="">Choose…</option>
          {(options?.["contacts?kind=customer&active=true"] || []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
        </select>
      </Field>
      <Field label="Service">
        <select required value={form.skuId} onChange={set("skuId")}>
          <option value="">Choose…</option>
          {(options?.["catalog?kind=service&active=true"] || []).map((s) => <option key={s.id} value={s.id}>{s.label} · {biz.exact(s.price)}</option>)}
        </select>
      </Field>
      <Field label="With">
        <select required value={form.resourceId} onChange={set("resourceId")}>
          <option value="">Choose…</option>
          {(options?.resources || []).filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}{r.role_label ? ` · ${r.role_label}` : ""}</option>)}
        </select>
      </Field>
      <Field label="Date"><input required type="date" value={form.date} onChange={set("date")} /></Field>
      {bySlot || slots?.leave ? (
        <div className="field-wide stack-sm">
          <span className="bz-inline"><strong>Free slots</strong><span className="muted">{slots.doctor.slot_minutes} minutes each{slots.doctor.consultation_label ? ` · fee ${biz.exact(slots.doctor.consultation_price)}` : ""}</span></span>
          {slots.leave ? <p className="muted">{slots.doctor.name} is on leave that day{slots.leave.reason ? ` (${slots.leave.reason})` : ""}.</p>
            : slots.slots.length === 0 ? <p className="muted">{slots.doctor.name} has no OPD that day.</p> : (
              <div className="hl-slots" role="group" aria-label="Free slots">
                {slots.slots.map((s) => (
                  <button key={s.starts_at} type="button" className={`hl-slot ${slot?.starts_at === s.starts_at ? "is-on" : ""}`} disabled={s.taken || s.past}
                    aria-pressed={slot?.starts_at === s.starts_at} onClick={() => setSlot(s)} title={s.taken ? "Booked" : s.past ? "Past" : "Free"}>{clock(s.starts_at)}</button>
                ))}
              </div>
            )}
        </div>
      ) : (
        <>
          <Field label="Starts at"><input required type="time" value={form.start} onChange={set("start")} /></Field>
          <Field label="Takes">
            <select value={form.minutes} onChange={set("minutes")}>
              {[15, 30, 45, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}</option>)}
            </select>
          </Field>
        </>
      )}
    </FormDialog>
  );
}
