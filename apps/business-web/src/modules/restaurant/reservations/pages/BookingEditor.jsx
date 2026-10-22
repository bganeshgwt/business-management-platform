// New and edit booking form.

import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { createReservation, getTableAvailability, updateReservation } from "../services/reservation.service";
import { DURATIONS, OCCASIONS, SOURCES, hhmm, tableOffNow, tableOffSentence, timeLabel, toMinutes } from "./reservationFormat";
import { GuestMatch, PartyStepper } from "./GuestMatch";
import TablePicker from "./TablePicker";

// ---------------------------------------------------------------- booking editor

const slotsFor = (date, week, today, clock, keep) => {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const hours = (week || []).find((row) => row && row.dayOfWeek === weekday);
  let first = 11 * 60;
  let last = 22 * 60 + 30;

  if (hours) {
    if (!hours.isOpen) {
      return { closed: true, slots: [] };
    }

    first = hours.openMinutes;
    last = hours.lastBookingMinutes;
  }

  const slots = [];

  for (let minutes = Math.ceil(first / 15) * 15; minutes <= last; minutes += 15) {
    if (date === today && minutes < clock.minutes - 15) {
      continue;
    }

    slots.push(hhmm(minutes % 1440));
  }

  if (keep && !slots.includes(keep)) {
    slots.unshift(keep);
  }

  return { closed: false, slots };
};

export default function BookingEditor({ booking, prefill, board, today, clock, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    guestMobile: booking?.guestMobile || "",
    guestName: booking?.guestName || "",
    customerId: booking?.customerId || null,
    customerName: booking?.customerName || null,
    partySize: booking?.partySize || prefill.partySize || 2,
    date: booking?.date || prefill.date || today,
    startTime: booking?.startTime || prefill.startTime || "",
    durationMinutes: booking?.durationMinutes || 90,
    tableId: booking?.tableId ? String(booking.tableId) : prefill.tableId ? String(prefill.tableId) : "",
    extraTableIds: (booking?.extraTables || []).map((table) => String(table.id)),
    occasion: booking?.occasion || "",
    source: booking?.source || "phone",
    specialRequests: booking?.specialRequests || "",
    internalNotes: booking?.internalNotes || "",
  }));
  const [overrides, setOverrides] = useState({
    capacity: Boolean(booking?.capacityOverride),
    clash: false,
    reason: booking?.capacityOverrideReason || "",
  });
  const [availability, setAvailability] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const { closed, slots } = slotsFor(form.date, board.week, today, clock, booking?.startTime);
  // A time picked on the timeline snaps to the nearest bookable slot, so the
  // select never shows one time while the form holds another.
  const startTime = !form.startTime
    ? slots[0] || ""
    : slots.includes(form.startTime)
      ? form.startTime
      : slots.find((slot) => slot >= form.startTime) || slots[slots.length - 1] || "";
  const query = `${form.date}|${startTime}|${form.durationMinutes}|${form.partySize}`;

  useEffect(() => {
    if (!startTime || !form.partySize || closed) {
      return undefined;
    }

    const timer = setTimeout(() => {
      getTableAvailability({
        date: form.date,
        time: startTime,
        duration: form.durationMinutes,
        partySize: form.partySize,
        excludeId: booking?.id,
      })
        .then((data) => setAvailability({ query, ...data }))
        .catch((err) => setError(getErrorMessage(err)));
    }, 200);

    return () => clearTimeout(timer);
  }, [query, form.date, startTime, form.durationMinutes, form.partySize, booking?.id, closed]);

  const set = (field) => (value) => setForm((current) => ({ ...current, [field]: value }));
  const field = (name) => (event) => set(name)(event.target.value);

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      guestName: form.guestName,
      guestMobile: form.guestMobile || null,
      customerId: form.customerId,
      partySize: Number(form.partySize),
      date: form.date,
      startTime,
      durationMinutes: Number(form.durationMinutes),
      tableId: form.tableId ? Number(form.tableId) : null,
      extraTableIds: form.tableId ? form.extraTableIds.filter((id) => id !== form.tableId).map(Number) : [],
      overrideCapacity: overrides.capacity,
      capacityOverrideReason:
        overrides.capacity && form.tableId && form.extraTableIds.length > 0 ? overrides.reason.trim() || null : null,
      occasion: form.occasion || null,
      source: form.source,
      specialRequests: form.specialRequests || null,
      internalNotes: form.internalNotes || null,
    };

    try {
      const result = booking ? await updateReservation(booking.id, payload) : await createReservation(payload);
      onSaved(result);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const fresh = availability && availability.query === query ? availability : null;

  return (
    <Modal
      title={booking ? `Edit booking ${booking.reference}` : "New booking"}
      description="Who is coming, when, and which table is held for them."
      icon="calendar"
      onClose={onClose}
      width={980}
    >
      <form className="rsv-editor" onSubmit={save}>
        <div className="rsv-editor-form">
          <ErrorMessage message={error} />

          <p className="section-heading rsv-first-heading">Guest</p>
          <div className="rsv-row-2">
            <label className="field">
              <span>Mobile</span>
              <input
                type="tel"
                inputMode="tel"
                value={form.guestMobile}
                onChange={field("guestMobile")}
                placeholder="98765 43210"
                autoFocus={!booking}
                maxLength={20}
              />
            </label>
            <label className="field">
              <span>Guest name *</span>
              <input value={form.guestName} onChange={field("guestName")} required maxLength={150} />
            </label>
          </div>
          <GuestMatch
            mobile={form.guestMobile}
            customerId={form.customerId}
            customerName={form.customerName}
            excludeId={booking?.id}
            onLink={(customer) =>
              setForm((current) => ({
                ...current,
                customerId: customer.id,
                customerName: customer.name,
                guestName: current.guestName || customer.name,
              }))
            }
            onUnlink={() => setForm((current) => ({ ...current, customerId: null, customerName: null }))}
          />

          <p className="section-heading">When</p>
          <div className="field">
            <span>Party size *</span>
            <PartyStepper value={form.partySize} onChange={set("partySize")} />
          </div>
          <div className="rsv-row-3">
            <label className="field">
              <span>Date *</span>
              <input
                type="date"
                value={form.date}
                min={booking ? undefined : today}
                onChange={(event) => setForm((current) => ({ ...current, date: event.target.value, startTime: "" }))}
                required
              />
            </label>
            <label className="field">
              <span>Time *</span>
              <select value={startTime} onChange={field("startTime")} disabled={closed || slots.length === 0} required>
                {closed && <option value="">Closed this day</option>}
                {!closed && slots.length === 0 && <option value="">No times left today</option>}
                {slots.map((slot) => (
                  <option key={slot} value={slot}>
                    {timeLabel(toMinutes(slot))}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Stays for</span>
              <select value={form.durationMinutes} onChange={(event) => set("durationMinutes")(Number(event.target.value))}>
                {DURATIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {closed && <p className="alert alert-notice">The restaurant is closed on this day. Pick another date.</p>}

          <p className="section-heading">Details</p>
          <div className="field">
            <span>Occasion</span>
            <div className="rsv-choice-row" role="radiogroup" aria-label="Occasion">
              {[{ value: "", label: "None" }, ...OCCASIONS].map((option) => (
                <button
                  key={option.value || "none"}
                  type="button"
                  role="radio"
                  aria-checked={form.occasion === option.value}
                  className={`rsv-choice ${form.occasion === option.value ? "is-active" : ""}`}
                  onClick={() => set("occasion")(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Booked by</span>
            <select value={form.source} onChange={field("source")}>
              {SOURCES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Special requests</span>
            <textarea
              rows={2}
              value={form.specialRequests}
              onChange={field("specialRequests")}
              maxLength={500}
              placeholder="High chair, cake at dessert, nut allergy…"
            />
          </label>
          <label className="field">
            <span>Internal notes</span>
            <textarea
              rows={2}
              value={form.internalNotes}
              onChange={field("internalNotes")}
              maxLength={500}
              placeholder="Only staff see this — regular, VIP, advance paid…"
            />
          </label>
        </div>

        <div className="rsv-editor-side">
          <p className="section-heading rsv-first-heading">Table</p>
          {/* The booking's own table went out of service after it was
              taken: it stays held (a name or a number can still be fixed),
              and is not offered below; picking another table moves them. */}
          {booking && tableOffNow(booking) && String(form.tableId) === String(booking.tableId) && (
            <p className="alert alert-notice rsv-table-off">
              Table {booking.tableNo} stays held for this booking, but {tableOffSentence(booking)} right now. Pick
              another table below to move them.
            </p>
          )}
          {booking?.status === "requested" ? (
            // An online request holds no table until someone says yes to it;
            // the table is picked in Accept, where the guest is told at once.
            <p className="alert alert-notice">
              This is an online request still waiting for an answer. Correct the details here if the guest asked; give
              it a table when you accept it.
            </p>
          ) : closed ? (
            <p className="muted small">No tables to show on a closed day.</p>
          ) : (
            <TablePicker
              availability={fresh || availability}
              loading={!fresh}
              value={form.tableId}
              onChange={(id) =>
                setForm((current) => ({
                  ...current,
                  tableId: id,
                  extraTableIds: id ? current.extraTableIds.filter((item) => item !== id) : [],
                }))
              }
              extraIds={form.extraTableIds}
              onExtraChange={set("extraTableIds")}
              mode="book"
              allowNone
              overrides={overrides}
              setOverrides={setOverrides}
            />
          )}
        </div>

        <div className="form-actions rsv-editor-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="button" disabled={saving || closed || !startTime}>
            {saving ? "Saving…" : booking ? "Save changes" : "Save booking"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
