import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import { ErrorMessage } from "../../../../components/Feedback";
import LiveIndicator from "../../../../components/LiveIndicator";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import useConfirm from "../../../../hooks/useConfirm";
import { toast } from "../../../../services/toast";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateLong, duration } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { Badge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import ClientPanel from "./ClientPanel";
import { ClientPicker } from "./salonParts";
import {
  STATUS_WORDS, WEEKDAYS, addDays, awayOn, bookingMessage, hoursOn, categoryTone, clockMinutes, clockText, hourLabel, longDay, methodWord, minutesOfDay,
  minutesText, sendMessage, timeOfDay, whatsappLink, zonedInstant,
} from "./salon";
import ManagerApproval from "./ManagerApproval";
import { approvalFor, emptyApproval } from "./approval";
import useAuth from "../../../../hooks/useAuth";
// A reminder needs the client's consent to reminders (asked first, in one tap).
import { useConsentGate } from "../../../personal-data/useConsentGate";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import "../styles/salon.css";

// The salon's day (or week): one column per stylist and per room, bookings
// drawn at their time and length, coloured by service, a red line at "now"
// and the view opening on it. Click a free time to book; drag a booking to
// another time or stylist to move it (never a cancellation charge); click a
// booking to mark the client arrived, move it, message them, bill it, or mark
// a no-show / cancel. Walk-ins wait in the strip above until a stylist is free.
const HOUR_PX = 64;
const PX = HOUR_PX / 60;
const VIEWS = [{ value: "day", label: "Day" }, { value: "week", label: "Week" }];
const startOfWeek = (day) => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
};

export default function SalonCalendarPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const tz = biz.business.timezone;
  const today = businessToday(tz);
  const [params, setParams] = useSearchParams();
  const [day, setDay] = useState(() => (/^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : today));
  const [view, setView] = useState(() => (params.get("view") === "week" ? "week" : "day"));
  const [location, setLocation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [booking, setBooking] = useState(() => (params.get("book") ? {
    contactId: params.get("contact") || "", skuId: params.get("sku") || "", resourceId: params.get("staff") || "",
  } : null));
  const [opened, setOpened] = useState(null);
  const [moving, setMoving] = useState(null);
  const [docId, setDocId] = useState(null);
  const [client, setClient] = useState(null);
  const [reminders, setReminders] = useState(false);
  const [walkIn, setWalkIn] = useState(() => params.get("walkin") === "1");
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  // A booking made, moved, started or finished on another device shows
  // within a second (live updates); the calendar had no timer of its own, and
  // has none now. Only the calendar reads again: the walk-in list follows its
  // own changes, keeping a stylist being picked there.
  const [heard, setHeard] = useState(0);
  const live = useLiveRefresh({ business: biz.id }, ["appointment"], () => setHeard((n) => n + 1), { every: 0 });
  const days = view === "week" ? 7 : 1;
  const from = view === "week" ? startOfWeek(day) : day;

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "salon/calendar", { date: from, days, location: location || undefined }, controller.signal)
      .then((result) => { setData(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, from, days, location, version, heard]);
  // A booking asked for in the address (?book=1&contact=…) is opened once.
  useEffect(() => {
    if (params.get("book") || params.get("walkin")) setParams((p) => { const next = new URLSearchParams(p); ["book", "contact", "sku", "staff", "walkin"].forEach((k) => next.delete(k)); return next; }, { replace: true });
  }, [params, setParams]);

  const go = (next) => {
    setDay(next);
    setData(null);
    setParams(next === today && view === "day" ? {} : { date: next, ...(view === "week" ? { view } : {}) }, { replace: true });
  };
  const switchView = (next) => {
    setView(next);
    setData(null);
    setParams({ ...(day !== today ? { date: day } : {}), ...(next === "week" ? { view: next } : {}) }, { replace: true });
  };
  const activeLocations = biz.locations.filter((l) => l.active);
  const appointments = useMemo(() => data?.appointments || [], [data]);
  const fresh = data && data.date === from && data.days === days;
  const dayRows = useMemo(() => appointments.filter((a) => a.day === day), [appointments, day]);
  const count = (status) => dayRows.filter((a) => a.status === status).length;
  const arrived = dayRows.filter((a) => a.status === "booked" && a.arrived_at).length;
  const late = dayRows.filter((a) => a.late).length;
  const depositsHeld = dayRows.reduce((s, a) => s + (a.status === "booked" ? Number(a.deposit_unused || 0) : 0), 0);
  const canBook = biz.can("appointments.create");
  // The open booking, fresh after every reload.
  const shown = opened ? appointments.find((a) => Number(a.id) === Number(opened.id)) || opened : null;

  // Drag a booking to another time or stylist: ask, then move. A failed move
  // leaves it where it was (nothing on screen changed yet).
  const dropMove = async (appointment, resource, minutes) => {
    const startsAt = zonedInstant(appointment.day, clockText(minutes), tz);
    const sameStaff = Number(resource.id) === Number(appointment.resource_id);
    if (sameStaff && new Date(startsAt).getTime() === new Date(appointment.starts_at).getTime()) return;
    const ok = await confirm({
      title: `Move ${appointment.contact_name}'s ${appointment.service_name}?`, tone: "primary", confirmLabel: "Move it", cancelLabel: "Leave it",
      message: `To ${hourLabelExact(minutes)}${sameStaff ? "" : ` with ${resource.name}`}. The deposit and price stay with the booking; nothing is charged.`,
    });
    if (!ok) return;
    try {
      await businessWrite(biz.id, `salon/appointments/${appointment.id}`, { startsAt, ...(sameStaff ? {} : { resourceId: resource.id }) }, "patch");
      toast.success(`${appointment.contact_name} moved to ${hourLabelExact(minutes)}${sameStaff ? "" : ` with ${resource.name}`}`, {
        action: appointment.contact_phone ? { label: "Tell them", onClick: () => window.open(whatsappLink(appointment.contact_phone, bookingMessage("confirmation", { ...appointment, starts_at: startsAt, resource_name: sameStaff ? appointment.resource_name : resource.name }, biz)), "_blank", "noopener") } : undefined,
      });
      reload();
    } catch (err) {
      // Outside the stylist's hours: open Move, where a manager can let it through.
      if (err?.response?.data?.data?.reason === "outside_hours") {
        toast.info(`${getErrorMessage(err)} Opening Move so a manager can let it through.`, { duration: 7000 });
        setMoving(appointment);
        return;
      }
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <div className="stack sw-cal-page">
      <BusinessHeader icon="calendar" title="Calendar"
        description="Each stylist's and room's day. Drag a booking to move it; a booking blocks its service time plus clean-up."
        actions={<LiveIndicator status={live} />}
        primary={canBook && fresh && <button type="button" className="button" onClick={() => setBooking({})}><Icon name="plus" size={16} /> Book</button>}
        secondary={canBook && <button type="button" className="button button-secondary" onClick={() => setWalkIn(true)}><Icon name="user-plus" size={16} /> Walk-in</button>}
        more={[
          { label: "Tomorrow's reminders", icon: "message", onClick: () => setReminders(true) },
          { label: "Appointment history", icon: "history", onClick: () => navigate(businessPath(biz.id, "appointments")) },
        ]} />
      <ErrorMessage message={error} />
      <div className="sw-summary" aria-label="The day in numbers">
        <span><strong>{fresh ? count("booked") : "—"}</strong> to come{late ? <em className="is-late"> · {late} late</em> : null}</span>
        <span><strong>{fresh ? arrived : "—"}</strong> here now</span>
        <span><strong>{fresh ? count("completed") : "—"}</strong> done</span>
        <span><strong>{fresh ? count("no_show") + count("cancelled") : "—"}</strong> no-show / cancelled</span>
        <span><strong>{fresh ? biz.amount(depositsHeld) : "—"}</strong> deposits held</span>
      </div>
      {canBook && <WalkIns key={version} biz={biz} staff={(data?.resources || []).filter((r) => r.kind === "staff")} onChanged={reload} />}
      <SectionCard flush icon="calendar" title={view === "week" ? `Week of ${longDay(from)}` : day === today ? `Today, ${longDay(day)}` : longDay(day)}
        actions={(
          <div className="sw-toolbar">
            <Segmented label="View" value={view} options={VIEWS} onChange={switchView} />
            <div className="sw-daynav" role="group" aria-label="Day">
              <button type="button" className="button button-secondary button-sm" aria-label={view === "week" ? "Previous week" : "Previous day"} onClick={() => go(addDays(day, view === "week" ? -7 : -1))}><Icon name="chevron-left" size={15} /></button>
              <button type="button" className="button button-secondary button-sm" onClick={() => go(today)} disabled={day === today}>Today</button>
              <button type="button" className="button button-secondary button-sm" aria-label={view === "week" ? "Next week" : "Next day"} onClick={() => go(addDays(day, view === "week" ? 7 : 1))}><Icon name="chevron-right" size={15} /></button>
            </div>
            <label className="field">
              <span className="sr-only">Date</span>
              <input type="date" value={day} onChange={(e) => e.target.value && go(e.target.value)} aria-label="Date" />
            </label>
            {activeLocations.length > 1 && (
              <label className="field">
                <span className="sr-only">Location</span>
                <select value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Location">
                  <option value="">Every location</option>
                  {activeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
            )}
          </div>
        )}>
        {!fresh ? (!error && <p className="sw-note sw-pad">Loading…</p>)
          : view === "week" ? <WeekGrid data={data} from={from} today={today} onDay={(d) => { setView("day"); go(d); }} />
            : <DayGrid data={data} day={day} today={today} canMove={biz.can("appointments.edit")}
              onSlot={(slot) => canBook && setBooking(slot)} onOpen={setOpened} onDrop={dropMove} />}
      </SectionCard>
      {view === "day" && <DayList biz={biz} rows={fresh ? dayRows : null} error={error} onRetry={reload} onOpen={setOpened} />}
      {booking && fresh && (
        <BookDialog day={view === "day" ? day : from} data={data} slot={booking} onClose={() => setBooking(null)}
          onSaved={(a, summary) => {
            setBooking(null);
            toast.success(`Booked${a.deposit_no ? `, deposit receipt ${a.deposit_no}` : ""}.`, summary.phone ? {
              duration: 8000, action: { label: "Send confirmation", onClick: () => sendMessage(biz, "confirmation", { ...a, ...summary }).then(reload) },
            } : undefined);
            reload();
          }} />
      )}
      {shown && (
        <AppointmentDialog appointment={shown} timezone={tz} onClose={() => setOpened(null)} onOpenDocument={setDocId}
          onClient={() => { setClient(opened.contact_id); setOpened(null); }} onMove={() => setMoving(opened)}
          onBookNext={() => { const a = opened; setOpened(null); setBooking({ contactId: a.contact_id, skuId: a.sku_id, resourceId: a.resource_id, nextVisit: true }); }}
          onChanged={(message) => { setOpened(null); if (message) toast.success(message); reload(); }} onRefresh={reload} />
      )}
      {moving && fresh && <MoveDialog appointment={moving} data={data} onClose={() => setMoving(null)} onSaved={(row) => { setMoving(null); setOpened(null); toast.success(`Moved to ${timeOfDay(row.starts_at, tz)} with ${row.resource_name}`); reload(); }} />}
      {docId && <DocumentDetail documentId={docId} onClose={() => setDocId(null)} onChanged={reload} />}
      <ClientPanel contactId={client} onClose={() => setClient(null)}
        onBook={(card) => { setClient(null); setBooking({ contactId: card.contact.id, resourceId: card.profile?.preferred_resource_id || "" }); }} />
      <Reminders open={reminders} onClose={() => setReminders(false)} day={addDays(today, 1)} />
      {walkIn && <WalkInDialog data={data} onClose={() => setWalkIn(false)} onSaved={(w) => { setWalkIn(false); toast.success(`${w.contact_name} is on the waiting list.`); reload(); }} />}
    </div>
  );
}

const hourLabelExact = (minutes) => {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};

function DayGrid({ data, day, today, canMove, onSlot, onOpen, onDrop }) {
  const tz = data.timezone;
  const open = clockMinutes(data.settings.opens_at);
  const close = clockMinutes(data.settings.closes_at);
  const height = (close - open) * PX;
  const columns = data.resources;
  const scroller = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const nowMinutes = minutesOfDay(now, tz);
  const showNow = day === today && nowMinutes >= open && nowMinutes <= close;
  // Open the day on "now" (an hour before), or on the first booking.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const first = data.appointments.filter((a) => a.day === day && a.status !== "cancelled").map((a) => minutesOfDay(a.starts_at, tz))[0];
    const target = showNow ? nowMinutes - 60 : first !== undefined ? first - 30 : open;
    node.scrollTop = Math.max(0, (target - open) * PX);
    // Only when the day changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, data.date]);
  if (!columns.length) {
    return <p className="sw-note sw-pad">Add stylists and rooms under Stylists &amp; services to see their day here.</p>;
  }
  const hours = [];
  for (let m = Math.ceil(open / 60) * 60; m < close; m += 60) hours.push(m);
  const blocks = (resource) => data.appointments.filter((a) => a.day === day && a.status !== "cancelled"
    && (resource.kind === "room" ? Number(a.room_id) === Number(resource.id) : Number(a.resource_id) === Number(resource.id)));
  const minutesAt = (event, column) => {
    const rect = column.getBoundingClientRect();
    const y = event.clientY - rect.top;
    return Math.min(close - 15, Math.max(open, open + Math.round(y / PX / 15) * 15));
  };
  const slotClick = (resource) => (event) => {
    if (resource.kind === "room" || event.target !== event.currentTarget) return;
    onSlot({ resourceId: resource.id, time: clockText(minutesAt(event, event.currentTarget)) });
  };
  return (
    <div className="sw-cal-scroll" ref={scroller}>
      <div className="sw-cal" style={{ "--sw-cols": columns.length, "--sw-height": `${height}px`, "--sw-hour": `${HOUR_PX}px` }}>
        <div className="sw-cal-corner" />
        {columns.map((r) => {
          const away = awayOn(r, day, data.holidays);
          const shift = hoursOn(r, day);
          return (
            <div key={r.id} className={`sw-cal-head ${r.kind === "room" ? "is-room" : ""}`}>
              {r.name}
              <small>{away || (r.kind === "room" ? "Room" : shift.from ? `${shift.from}–${shift.to}` : r.role_label || "Stylist")}</small>
            </div>
          );
        })}
        <div className="sw-cal-times" aria-hidden="true" style={{ backgroundPositionY: `${(Math.ceil(open / 60) * 60 - open) * PX}px` }}>
          {hours.map((m) => <span key={m} className={`sw-cal-time ${m === open ? "is-first" : ""}`} style={{ top: (m - open) * PX }}>{hourLabel(m)}</span>)}
        </div>
        {columns.map((r) => {
          const away = awayOn(r, day, data.holidays);
          const shift = hoursOn(r, day);
          const from = shift.from ? clockMinutes(shift.from) : null;
          const to = shift.to ? clockMinutes(shift.to) : null;
          return (
            <div key={r.id} className={`sw-cal-col ${r.kind === "room" ? "is-room" : ""} ${dragging ? "is-drop" : ""}`} onClick={slotClick(r)}
              style={{ backgroundPositionY: `${(Math.ceil(open / 60) * 60 - open) * PX}px` }}
              title={r.kind === "room" ? undefined : away ? `${r.name}: ${away}` : `Click a free time to book with ${r.name}`}
              onDragOver={(e) => { if (dragging && r.kind === "staff") e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragging && r.kind === "staff") { const a = dragging; setDragging(null); onDrop(a, r, minutesAt(e, e.currentTarget)); } }}>
              {away && <span className="sw-cal-off" style={{ top: 0, height }} aria-hidden="true">{away}</span>}
              {!away && from !== null && from > open && <span className="sw-cal-off" style={{ top: 0, height: (from - open) * PX }} aria-hidden="true" />}
              {!away && to !== null && to < close && <span className="sw-cal-off" style={{ top: (to - open) * PX, height: (close - to) * PX }} aria-hidden="true" />}
              {showNow && <span className="sw-cal-now" style={{ top: (nowMinutes - open) * PX }} />}
              {blocks(r).map((a) => {
                const start = Math.max(open, minutesOfDay(a.starts_at, tz));
                const end = Math.min(close, minutesOfDay(a.ends_at, tz) || close);
                const short = end - start < 40;
                const movable = canMove && a.status === "booked" && r.kind === "staff" && !a.bill_document_id;
                const state = a.late ? "is-late" : a.arrived_at && a.status === "booked" ? "is-arrived" : `is-${a.status}`;
                const label = `${a.contact_name}, ${a.service_name}, ${timeOfDay(a.starts_at, tz)}, ${a.late ? "late, not arrived" : a.arrived_at && a.status === "booked" ? "arrived" : STATUS_WORDS[a.status]}`;
                return (
                  <button key={`${r.id}-${a.id}`} type="button" className={`sw-appt ${categoryTone(a.category)} ${state} ${r.kind === "room" ? "is-room" : ""} ${short ? "is-short" : ""}`}
                    style={{ top: (start - open) * PX + 1, height: Math.max(22, (end - start) * PX - 3) }} onClick={() => onOpen(a)}
                    draggable={movable} onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(a.id)); setDragging(a); }}
                    onDragEnd={() => setDragging(null)} aria-label={label} title={short ? label : undefined}>
                    <strong>
                      {a.member && <Icon name="star" size={11} />}{Number(a.deposit_amount) > 0 && <span className="sw-appt-mark" aria-hidden="true">₹</span>}
                      {short ? `${timeOfDay(a.starts_at, tz)} ${a.contact_name} · ${a.service_name}` : a.contact_name}
                    </strong>
                    {!short && <span>{timeOfDay(a.starts_at, tz)} · {a.service_name}</span>}
                    {!short && (r.kind === "room" ? <span>with {a.resource_name}</span> : a.room_name && <span>{a.room_name}</span>)}
                    {!short && (a.late ? <span>Late — not here yet</span> : a.arrived_at && a.status === "booked" ? <span>Here since {timeOfDay(a.arrived_at, tz)}</span>
                      : a.status !== "booked" ? <span>{STATUS_WORDS[a.status]}{a.bill_no ? ` · ${a.bill_no}` : ""}</span> : a.first_visit ? <span>First visit</span> : null)}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Every stylist across the week: bookings and booked hours per day; a day off
// or leave is named. Click a day to open it.
function WeekGrid({ data, from, today, onDay }) {
  const tz = data.timezone;
  const daysList = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const staff = data.resources.filter((r) => r.kind === "staff");
  const cell = (r, d) => {
    const rows = data.appointments.filter((a) => a.day === d && Number(a.resource_id) === Number(r.id) && a.status !== "cancelled");
    const minutes = rows.reduce((s, a) => s + (new Date(a.ends_at) - new Date(a.starts_at)) / 60000, 0);
    return { rows, minutes };
  };
  if (!staff.length) return <p className="sw-note sw-pad">Add stylists under Stylists &amp; services to see their week.</p>;
  return (
    <div className="sw-week-scroll">
      <table className="sw-week">
        <thead>
          <tr>
            <th scope="col">Stylist</th>
            {daysList.map((d) => (
              <th key={d} scope="col" className={d === today ? "is-today" : ""}>
                <button type="button" className="link-button" onClick={() => onDay(d)}>{WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} {Number(d.slice(8))}</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {staff.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.name}<small>{r.role_label || "Stylist"}</small></th>
              {daysList.map((d) => {
                const away = awayOn(r, d, data.holidays);
                const { rows, minutes } = cell(r, d);
                return (
                  <td key={d} className={`${away ? "is-away" : ""} ${d === today ? "is-today" : ""}`}>
                    <button type="button" className="sw-week-cell" onClick={() => onDay(d)} aria-label={`${r.name}, ${dateLong(d)}: ${away || `${rows.length} bookings`}`}>
                      {away ? <span className="muted">{away}</span> : rows.length ? (
                        <>
                          <strong>{rows.length}</strong> <span>booking{rows.length === 1 ? "" : "s"}</span>
                          <small>{minutesText(Math.round(minutes))} busy · first {timeOfDay(rows[0].starts_at, tz)}</small>
                        </>
                      ) : <span className="muted">Free</span>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayList({ biz, rows, error, onRetry, onOpen }) {
  const tz = biz.business.timezone;
  const columns = useMemo(() => [
    { key: "starts_at", header: "Time", type: "datetime", value: (a) => a.starts_at, mobile: "subtitle",
      render: (a) => `${timeOfDay(a.starts_at, tz)} – ${timeOfDay(a.ends_at, tz)}` },
    { key: "contact_name", header: "Client", value: (a) => a.contact_name, mobile: "title", pin: true,
      render: (a) => <button type="button" className="link-button bz-link-left" onClick={() => onOpen(a)}>{a.contact_name}</button> },
    { key: "service_name", header: "Service", value: (a) => a.service_name, mobile: "show" },
    { key: "resource_name", header: "Stylist", value: (a) => a.resource_name, filter: "select", mobile: "show" },
    { key: "room_name", header: "Room", value: (a) => a.room_name || "", defaultHidden: true },
    { key: "deposit", header: "Deposit", type: "money", exact: true, value: (a) => (a.deposit_amount === null ? null : Number(a.deposit_amount)), total: "sum" },
    { key: "status", header: "Status", type: "status", value: (a) => (a.late ? "late" : a.arrived_at && a.status === "booked" ? "arrived" : a.status), filter: "select", mobile: "show",
      filterOptions: [...Object.entries(STATUS_WORDS).map(([value, label]) => ({ value, label })), { value: "arrived", label: "Here" }, { value: "late", label: "Late" }],
      render: (a) => (a.late ? <Badge status="overdue" tone="warning" label="Late" /> : a.arrived_at && a.status === "booked" ? <Badge tone="success" label="Here" /> : <Badge status={a.status} label={STATUS_WORDS[a.status]} />) },
    { key: "reminded", header: "Message", value: (a) => (a.reminder_sent_at ? "Reminded" : a.confirmation_sent_at ? "Confirmed" : ""), defaultHidden: true },
    { key: "paper", header: "Bill / charge", value: (a) => a.bill_no || a.fee_no || "", render: (a) => (a.bill_no ? `Bill ${a.bill_no}` : a.fee_no ? `Charge ${a.fee_no}` : "—") },
  ], [tz, onOpen]);
  return (
    <SectionCard flush icon="list" title="The day's bookings" className="sw-daylist">
      <DataGrid id="salon-day-list" caption="The day's bookings" columns={columns} rows={rows || []} loading={!rows && !error} error={rows ? "" : error} onRetry={onRetry}
        currency={biz.symbol} rowNoun={["booking", "bookings"]} defaultSort={{ key: "starts_at", direction: "asc" }}
        rowClassName={(a) => (a.status === "cancelled" ? "dg-tone-muted" : a.status === "no_show" || a.late ? "dg-tone-warning" : "")}
        empty="Nothing booked on this day" emptyHint="Click a free time in the calendar above to book." emptyIcon="calendar" />
    </SectionCard>
  );
}

// The walk-in waiting list: who is waiting, for what and how long; seat them
// with a free stylist (booked from now) or let them go.
function WalkIns({ biz, staff, onChanged }) {
  const today = businessToday(biz.business.timezone);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [pick, setPick] = useState({});
  const [heard, setHeard] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "salon/walk-ins", { status: "waiting", from: today, to: today, limit: 50 }, controller.signal).then((r) => setRows(r.items)).catch(() => setRows([]));
    return () => controller.abort();
  }, [biz.id, today, heard]);
  // Someone joining or leaving the list on another device (live updates).
  useLiveRefresh({ business: biz.id }, ["walk_in"], () => setHeard((n) => n + 1), { every: 0 });
  if (!rows?.length) return null;
  const act = async (w, action) => {
    setBusy(w.id);
    try {
      if (action === "seat") {
        const resourceId = pick[w.id] || w.resource_id;
        if (!resourceId) { toast.error("Choose the stylist who will do it"); setBusy(null); return; }
        await businessWrite(biz.id, `salon/walk-ins/${w.id}/seat`, { resourceId, requestKey: newKey() });
        toast.success(`${w.contact_name} seated.`);
      } else {
        await businessWrite(biz.id, `salon/walk-ins/${w.id}/left`, {});
        toast.info(`${w.contact_name} left the waiting list.`);
      }
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
      setBusy(null);
    }
  };
  return (
    <section className="sw-waiting" aria-label="Walk-ins waiting">
      <strong className="sw-waiting-title"><Icon name="users" size={16} /> Waiting ({rows.length})</strong>
      {rows.map((w) => (
        <div key={w.id} className="sw-waiting-card">
          <span><strong>{w.contact_name}</strong> · {w.service_name}<small>{duration(w.arrived_at)} waiting{w.resource_name ? ` · asked for ${w.resource_name}` : ""}{w.note ? ` · ${w.note}` : ""}</small></span>
          <select aria-label={`Stylist for ${w.contact_name}`} value={pick[w.id] || w.resource_id || ""} onChange={(e) => setPick((p) => ({ ...p, [w.id]: e.target.value }))}>
            <option value="">Seat with…</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button type="button" className="button button-sm" disabled={busy === w.id} onClick={() => act(w, "seat")}>Seat</button>
          <button type="button" className="button button-secondary button-sm" disabled={busy === w.id} onClick={() => act(w, "left")}>Left</button>
        </div>
      ))}
    </section>
  );
}

function WalkInDialog({ data, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["contacts?kind=customer&active=true"]);
  const [extra, setExtra] = useState([]);
  const [contact, setContact] = useState(null);
  const [form, setForm] = useState({ skuId: "", resourceId: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const clients = [...extra, ...(options?.["contacts?kind=customer&active=true"] || [])];
  const services = data?.services || [];
  const staff = (data?.resources || []).filter((r) => r.kind === "staff");
  return (
    <FormDialog title="Walk-in" icon="user-plus" width={560} submitLabel="Add to the waiting list" onClose={onClose} onSaved={onSaved} disabled={!options || !data}
      description="The client waits in the strip above the calendar until a stylist is free; seating books them from that moment."
      onSubmit={() => {
        if (!contact) throw Object.assign(new Error(), { response: { data: { message: "Choose the client, or add a new one" } } });
        return businessWrite(biz.id, "salon/walk-ins", { contactId: contact.id, skuId: form.skuId, resourceId: form.resourceId || null, note: form.note || null });
      }}>
      <FormError message={error} />
      <div className="field-wide"><ClientPicker value={contact} onChange={setContact} clients={clients} onCreated={(c) => setExtra((all) => [c, ...all])} required autoFocus /></div>
      <Field label="Service">
        <select required value={form.skuId} onChange={set("skuId")}>
          <option value="">Choose…</option>
          {services.map((s) => <option key={s.id} value={s.id}>{s.label} · {minutesText(s.duration_minutes)}</option>)}
        </select>
      </Field>
      <Field label="Stylist asked for" hint="Optional — anyone free otherwise">
        <select value={form.resourceId} onChange={set("resourceId")}>
          <option value="">Anyone</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Note" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="Short on the sides" /></Field>
    </FormDialog>
  );
}

function BookDialog({ day, data, slot, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const tz = biz.business.timezone;
  const { options, error } = useOptions(["contacts?kind=customer&active=true"]);
  const [requestKey] = useState(newKey);
  const [extra, setExtra] = useState([]);
  const staffList = data.resources.filter((r) => r.kind === "staff");
  const rooms = data.resources.filter((r) => r.kind === "room");
  const [form, setForm] = useState({ skuId: slot.skuId ? String(slot.skuId) : "", resourceId: slot.resourceId ? String(slot.resourceId) : "", roomId: "",
    date: slot.nextVisit ? addDays(day, 28) : day, time: slot.time || "10:00", deposit: "", method: "upi", reference: "", notes: "" });
  // The deposit's method: one of the business's own (paymentMethods.js).
  const methods = usePaymentMethods();
  const [picked, setContact] = useState(undefined);
  const clients = useMemo(() => [...extra, ...(options?.["contacts?kind=customer&active=true"] || [])], [extra, options]);
  // A client named in the address or by "Book next visit" is chosen once the list is in.
  const contact = picked !== undefined ? picked : (slot.contactId && clients.find((c) => String(c.id) === String(slot.contactId))) || null;
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const service = data.services.find((s) => String(s.id) === form.skuId);
  const canDo = (r) => !r.skills.length || r.skills.map(String).includes(form.skuId);
  const suggested = service ? Math.round((Number(service.price) * Number(data.settings.deposit_percent)) / 100) : 0;
  const length = service ? Number(service.duration_minutes) + Number(service.buffer_minutes) : 0;
  const ends = service ? clockText(clockMinutes(form.time) + length) : "";
  const stylist = staffList.find((r) => String(r.id) === form.resourceId);
  const away = stylist ? awayOn(stylist, form.date, data.holidays) : "";
  const money = biz.can("sales.edit");
  const { user } = useAuth();
  const [override, setOverride] = useState(null);
  const submit = async () => {
    if (!contact) throw Object.assign(new Error(), { response: { data: { message: "Choose the client, or add a new one" } } });
    const saved = await businessWrite(biz.id, "salon/appointments", {
      contactId: contact.id, skuId: form.skuId, resourceId: form.resourceId, roomId: form.roomId || null, startsAt: zonedInstant(form.date, form.time, tz),
      notes: form.notes || null, requestKey,
      ...(money && Number(form.deposit) > 0 ? { deposit: { amount: form.deposit, ...methods.body(form.method), reference: form.reference || null } } : {}),
      ...(override ? { override: approvalFor(override.value, user?.id) } : {}),
    }).catch((err) => overrideAsked(err, override, setOverride));
    return { saved, summary: { contact_name: contact.name, contact_phone: contact.phone, service_name: service?.label, resource_name: stylist?.name, deposit_amount: Number(form.deposit) > 0 ? form.deposit : null } };
  };
  return (
    <FormDialog title={slot.nextVisit ? "Book the next visit" : "Book an appointment"} icon="calendar" width={680} submitLabel="Book" onSubmit={submit} onClose={onClose}
      onSaved={({ saved, summary }) => onSaved(saved, summary)} disabled={!options}
      description={`The salon books from ${String(data.settings.opens_at).slice(0, 5)} to ${String(data.settings.closes_at).slice(0, 5)}.`}>
      <FormError message={error} />
      <div className="field-wide"><ClientPicker value={contact} onChange={setContact} clients={clients} onCreated={(c) => setExtra((all) => [c, ...all])} required autoFocus={!slot.contactId} /></div>
      <Field label="Service" hint={service ? `${minutesText(service.duration_minutes)}${Number(service.buffer_minutes) ? ` + ${service.buffer_minutes} min clean-up` : ""}${service.needs_room ? " · needs a room" : ""}` : undefined}>
        <select required value={form.skuId} onChange={(e) => setForm((f) => ({ ...f, skuId: e.target.value, deposit: "" }))}>
          <option value="">Choose…</option>
          {data.services.map((s) => <option key={s.id} value={s.id}>{s.label} · {biz.exact(s.price)} · {minutesText(s.duration_minutes)}</option>)}
        </select>
      </Field>
      <Field label="Stylist" hint={away ? `${stylist.name}: ${away} that day` : form.skuId && staffList.some((r) => !canDo(r)) ? "Only stylists who do this service are listed" : undefined}>
        <select required value={form.resourceId} onChange={set("resourceId")}>
          <option value="">Choose…</option>
          {staffList.filter(canDo).map((r) => <option key={r.id} value={r.id}>{r.name}{r.role_label ? ` · ${r.role_label}` : ""}{awayOn(r, form.date) ? ` (${awayOn(r, form.date).toLowerCase()})` : ""}</option>)}
        </select>
      </Field>
      <Field label="Room" hint={service?.needs_room ? "This service needs a room" : "Optional"}>
        <select required={Boolean(service?.needs_room)} value={form.roomId} onChange={set("roomId")}>
          <option value="">{service?.needs_room ? "Choose…" : "No room"}</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Date" hint={form.date !== day ? dateLong(form.date) : undefined}><input required type="date" value={form.date} onChange={set("date")} /></Field>
      <Field label="Starts at" hint={ends ? `Busy until ${ends}` : undefined}><input required type="time" step="300" value={form.time} onChange={set("time")} /></Field>
      {money && (
        <>
          <Field label={`Deposit (${biz.symbol})`} hint={suggested ? `Suggested ${biz.exact(suggested)} (${Number(data.settings.deposit_percent)}% of the price)` : "Optional"}>
            <input type="number" min="0" step="0.01" value={form.deposit} placeholder={suggested ? String(suggested) : "0"} onChange={set("deposit")} />
          </Field>
          {Number(form.deposit) > 0 && (
            <Field label="Deposit paid by">
              <select value={methods.resolve(form.method)} onChange={set("method")}>{methods.options().map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
            </Field>
          )}
          {Number(form.deposit) > 0 && methods.kindOf(form.method) === "cheque" && <Field label="Cheque number"><input required maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
        </>
      )}
      <Field label="Notes for this visit" wide><input maxLength={300} value={form.notes} onChange={set("notes")} placeholder="Wants a trim only" /></Field>
      {override && <OverrideFields override={override} onChange={(value) => setOverride((o) => ({ ...o, value }))} />}
      {Number(form.deposit) > 0 && (
        <p className="sw-note field-wide">
          The deposit is kept as the client&apos;s advance and taken off their bill. A no-show keeps {Number(data.settings.no_show_fee_percent)}% of the price, and cancelling
          less than {data.settings.free_cancel_hours} hours before keeps {Number(data.settings.late_cancel_fee_percent)}% — only ever out of the deposit. Moving a booking costs nothing.
        </p>
      )}
    </FormDialog>
  );
}

function MoveDialog({ appointment: a, data, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const tz = biz.business.timezone;
  const staffList = data.resources.filter((r) => r.kind === "staff");
  const rooms = data.resources.filter((r) => r.kind === "room");
  const skills = (r) => !r.skills.length || r.skills.map(String).includes(String(a.sku_id));
  const startMinutes = minutesOfDay(a.starts_at, tz);
  const [form, setForm] = useState({ date: a.day, time: clockText(startMinutes - (startMinutes % 5)), resourceId: String(a.resource_id), roomId: a.room_id ? String(a.room_id) : "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const stylist = staffList.find((r) => String(r.id) === form.resourceId);
  const away = stylist ? awayOn(stylist, form.date, data.holidays) : "";
  const { user } = useAuth();
  const [override, setOverride] = useState(null);
  return (
    <FormDialog title={`Move ${a.contact_name}'s ${a.service_name}`} icon="calendar" width={560} submitLabel="Move" onClose={onClose} onSaved={onSaved}
      description="Same checks as a new booking. The deposit and the price booked stay with it; moving never charges the late-cancellation fee."
      onSubmit={() => businessWrite(biz.id, `salon/appointments/${a.id}`, {
        startsAt: zonedInstant(form.date, form.time, tz), resourceId: form.resourceId, roomId: form.roomId || null,
        ...(override ? { override: approvalFor(override.value, user?.id) } : {}),
      }, "patch").catch((err) => overrideAsked(err, override, setOverride))}>
      <Field label="Date"><input required type="date" value={form.date} onChange={set("date")} /></Field>
      <Field label="Starts at"><input required type="time" step="300" value={form.time} onChange={set("time")} /></Field>
      <Field label="Stylist" hint={away ? `${stylist.name}: ${away} that day` : undefined}>
        <select required value={form.resourceId} onChange={set("resourceId")}>
          {staffList.filter(skills).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Room">
        <select value={form.roomId} onChange={set("roomId")}>
          <option value="">No room</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      {override && <OverrideFields override={override} onChange={(value) => setOverride((o) => ({ ...o, value }))} />}
    </FormDialog>
  );
}

// Tomorrow's bookings, each with WhatsApp; a sent reminder is marked.
function Reminders({ open, onClose, day }) {
  const biz = useOpenBusiness();
  const gate = useConsentGate(useShopPrivacy());
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "salon/calendar", { date: day }, controller.signal)
      .then((r) => { setData(r); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, day, open, version]);
  const rows = (data?.appointments || []).filter((a) => a.status === "booked");
  const left = rows.filter((a) => !a.reminder_sent_at).length;
  const tz = biz.business.timezone;
  const can = biz.can("appointments.create") || biz.can("appointments.edit");
  return (
    <SidePanel open={open} onClose={onClose} icon="message" title={`Reminders for ${longDay(day)}`} count={rows.length} label="Tomorrow's reminders"
      rule={data ? (left ? `${left} still to send · opens WhatsApp with the message ready` : "Every client has been reminded") : undefined}>
      <ErrorMessage message={error} />
      {!data && !error && <p className="sw-note">Reading tomorrow's bookings…</p>}
      {data && !rows.length && <p className="sw-note">Nothing booked for {longDay(day)}.</p>}
      {rows.length > 0 && (
        <ul className="sw-list sw-remind">
          {rows.map((a) => (
            <li key={a.id}>
              <span><strong>{timeOfDay(a.starts_at, tz)}</strong> {a.contact_name} · {a.service_name} with {a.resource_name}{!a.contact_phone && <small className="muted"> · no phone</small>}</span>
              {a.reminder_sent_at ? <Badge tone="success" label="Sent" />
                : can && a.contact_phone && <button type="button" className="button button-sm" onClick={() => sendMessage(biz, "reminder", a, gate).then(() => setVersion((n) => n + 1))}><Icon name="message" size={14} /> Send</button>}
            </li>
          ))}
        </ul>
      )}
      {gate.dialog}
    </SidePanel>
  );
}

function AppointmentDialog({ appointment: a, timezone, onClose, onChanged, onOpenDocument, onClient, onMove, onBookNext, onRefresh }) {
  const biz = useOpenBusiness();
  const gate = useConsentGate(useShopPrivacy());
  const navigate = useNavigate();
  const [asking, setAsking] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestKey] = useState(newKey);
  const ask = async (status) => {
    setError("");
    setAsking(status);
    setPreview(null);
    try {
      setPreview(await businessRead(biz.id, `salon/appointments/${a.id}/fee`, { status }));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await businessWrite(biz.id, `salon/appointments/${a.id}/status`, { status: asking, requestKey });
      const word = asking === "no_show" ? "marked a no-show" : asking === "cancelled" ? "cancelled" : "marked done";
      onChanged(`${a.contact_name}'s ${a.service_name} ${word}.${result.fee ? ` Charge ${result.fee.documentNo} of ${biz.exact(result.fee.total)} paid from the deposit.` : ""}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  const arrive = async () => {
    setBusy(true);
    try {
      await businessWrite(biz.id, `salon/appointments/${a.id}/arrived`, {});
      toast.success(`${a.contact_name} is here.`);
      onRefresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const booked = a.status === "booked";
  const [now] = useState(() => Date.now());
  const started = new Date(a.starts_at).getTime() <= now;
  const dayOf = (value) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(value));
  const onTheDay = dayOf(a.starts_at) <= dayOf(now);
  const isToday = dayOf(a.starts_at) === dayOf(now);
  const billable = (booked || a.status === "completed") && !a.bill_document_id && biz.can("sales.create") && onTheDay;
  const canMessage = (biz.can("appointments.create") || biz.can("appointments.edit")) && booked && a.contact_phone;
  return (
    <Modal title={`${a.contact_name} · ${a.service_name}`} icon="calendar" onClose={onClose} width={600}
      description={`${longDayOf(a.starts_at, timezone)}, ${timeOfDay(a.starts_at, timezone)} – ${timeOfDay(a.ends_at, timezone)}`}>
      <div className="sw-stack">
        <ErrorMessage message={error} />
        <dl className="sw-facts">
          <div><dt>Status</dt><dd>{a.late ? <Badge tone="warning" label="Late — not here yet" /> : a.arrived_at && booked ? <Badge tone="success" label={`Here since ${timeOfDay(a.arrived_at, timezone)}`} /> : <Badge status={a.status} label={STATUS_WORDS[a.status]} />}</dd></div>
          <div><dt>Stylist</dt><dd>{a.resource_name}</dd></div>
          <div><dt>Room</dt><dd>{a.room_name || "—"}</dd></div>
          <div><dt>Price when booked</dt><dd>{a.price_at_booking ? biz.exact(a.price_at_booking) : "—"}</dd></div>
          <div><dt>Phone</dt><dd>{a.contact_phone ? <a href={`tel:${a.contact_phone}`}>{a.contact_phone}</a> : "—"}</dd></div>
          <div><dt>Deposit</dt><dd>{a.deposit_amount ? `${biz.exact(a.deposit_amount)} (${a.deposit_no}, ${methodWord(a.deposit_method)})` : "None"}</dd></div>
          {a.deposit_amount && <div><dt>Deposit not used yet</dt><dd>{biz.exact(a.deposit_unused)}</dd></div>}
          {(a.client_no_shows > 0 || a.member || a.first_visit) && (
            <div><dt>Client</dt><dd>{[a.member && "Member", a.first_visit && "First visit", a.client_no_shows > 0 && `${a.client_no_shows} no-show${a.client_no_shows === 1 ? "" : "s"} before`].filter(Boolean).join(" · ")}</dd></div>
          )}
          <div><dt>Messages</dt><dd>{[a.confirmation_sent_at && "Confirmed", a.reminder_sent_at && "Reminded"].filter(Boolean).join(" · ") || "None sent"}</dd></div>
          {a.notes && <div><dt>Notes</dt><dd>{a.notes}</dd></div>}
        </dl>
        <div className="sw-row">
          {a.bill_document_id && <button type="button" className="chip-button" onClick={() => onOpenDocument(a.bill_document_id)}>Bill {a.bill_no} · {biz.exact(a.bill_total)}</button>}
          {a.fee_document_id && <button type="button" className="chip-button" onClick={() => onOpenDocument(a.fee_document_id)}>Charge {a.fee_no} · {biz.exact(a.fee_total)}</button>}
          <button type="button" className="chip-button" onClick={onClient}><Icon name="user" size={13} /> Client card</button>
          {canMessage && <button type="button" className="chip-button" onClick={() => sendMessage(biz, isToday || a.confirmation_sent_at ? "reminder" : "confirmation", a, gate).then(onRefresh)}>
            <Icon name="message" size={13} /> {isToday || a.confirmation_sent_at ? "WhatsApp reminder" : "WhatsApp confirmation"}</button>}
        </div>
        {gate.dialog}
        {asking ? (
          <div className="sw-stack">
            <p>
              {asking === "completed" && "Mark this appointment done? Bill it from New bill when the client pays."}
              {asking !== "completed" && !preview && "Working out the deposit rule…"}
              {asking !== "completed" && preview && (Number(preview.fee) > 0
                ? `${asking === "no_show" ? "A no-show" : `Cancelling within ${preview.freeCancelHours} hours of the start`} keeps ${biz.exact(preview.fee)} of the deposit as a charge (${preview.percent}% of the price, at most the deposit). It is billed and paid from the deposit; ${biz.exact(Number(preview.depositUnused) - Number(preview.fee))} stays as ${a.contact_name}'s advance. Moving the booking instead costs nothing.`
                : `No charge: ${Number(preview.depositUnused) > 0 ? `the ${biz.exact(preview.depositUnused)} deposit stays as ${a.contact_name}'s advance for the next bill.` : "there is no deposit to keep."}`)}
            </p>
            <div className="sw-row">
              <button type="button" className="button button-secondary" onClick={() => setAsking(null)} disabled={busy}>Back</button>
              <button type="button" className={`button ${asking === "completed" ? "" : "button-danger"}`} onClick={confirm} disabled={busy || (asking !== "completed" && !preview)}>
                {busy ? "Saving…" : asking === "completed" ? "Mark done" : asking === "no_show" ? "Mark no-show" : "Cancel booking"}
              </button>
            </div>
          </div>
        ) : (
          <div className="sw-row">
            {billable && (
              <button type="button" className="button" onClick={() => navigate(`${businessPath(biz.id, "salon-bill")}?contact=${a.contact_id}&appointment=${a.id}`)}>
                <Icon name="receipt" size={15} /> Bill now
              </button>
            )}
            {booked && isToday && !a.arrived_at && biz.can("appointments.edit") && <button type="button" className="button button-secondary" onClick={arrive} disabled={busy}><Icon name="check" size={15} /> Arrived</button>}
            {booked && !a.bill_document_id && biz.can("appointments.edit") && <button type="button" className="button button-secondary" onClick={onMove}>Move</button>}
            {booked && onTheDay && biz.can("appointments.edit") && <button type="button" className="button button-secondary" onClick={() => ask("completed")}>Done</button>}
            {booked && started && biz.can("appointments.edit") && <button type="button" className="button button-secondary" onClick={() => ask("no_show")}>No-show</button>}
            {booked && biz.can("appointments.cancel") && <button type="button" className="button button-secondary" onClick={() => ask("cancelled")}>Cancel booking</button>}
            {!booked && biz.can("appointments.create") && <button type="button" className="button button-secondary" onClick={onBookNext}><Icon name="calendar" size={15} /> Book next visit</button>}
          </div>
        )}
        {!booked && <p className="sw-note"><Link to={`${businessPath(biz.id, "appointments")}?contact=${a.contact_id}`}>All of {a.contact_name}'s visits</Link></p>}
      </div>
    </Modal>
  );
}
const longDayOf = (value, timezone) => new Date(value).toLocaleDateString("en-IN", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" });

// The first time a booking is refused for the stylist's hours,
// leave, day off or a holiday, the form shows "Let it through" (a manager's
// reason and PIN); the next press sends it.
function overrideAsked(err, override, setOverride) {
  const data = err?.response?.data?.data;
  if (data?.reason === "outside_hours" && !override) {
    setOverride({ rule: data.rule, value: emptyApproval() });
    throw Object.assign(new Error(), { response: { data: { message: `${data.rule} A manager can let it through: fill in "Let it through" below and press the button again.` } } });
  }
  throw err;
}
function OverrideFields({ override, onChange }) {
  return (
    <div className="field-wide bz-note-card is-warning">
      <ManagerApproval permission="appointments.approve" value={override.value} onChange={onChange} selfWithoutPin
        title="Let it through" note={override.rule} reasonLabel="Why it has to be then" reasonPlaceholder="e.g. Bride's trial, the only slot she has" />
    </div>
  );
}
