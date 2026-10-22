// Seat, cancel, accept and decline dialogs.

import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { getTableAvailability } from "../services/reservation.service";
import { CANCEL_REASONS, occasionLabel, shortDate, tablesLabel, timeLabel, toMinutes } from "./reservationFormat";
import { Glyph } from "./ReservationChips";
import TablePicker from "./TablePicker";

// ---------------------------------------------------------------- seating

export function SeatDialog({ target, onClose, onSeat }) {
  const { kind, item } = target;
  const [availability, setAvailability] = useState(null);
  const [error, setError] = useState("");
  const [tableId, setTableId] = useState("");
  const [overrides, setOverrides] = useState({ capacity: false, clash: false });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTableAvailability({
      now: true,
      partySize: item.partySize,
      duration: item.durationMinutes || 90,
      excludeId: kind === "booking" ? item.id : undefined,
    })
      .then(setAvailability)
      .catch((err) => setError(getErrorMessage(err)));
  }, [kind, item]);

  // The booked table if it is ready; otherwise the best free one.
  // A large party's main table alone is "too small": with its other tables
  // joined it is the right one.
  const multiBooked = kind === "booking" && (item.extraTables || []).length > 0;
  const booked = availability?.tables.find(
    (table) => table.id === item.tableId && (table.fit === "free" || (multiBooked && table.fit === "small"))
  );
  const chosen = tableId || (booked ? String(booked.id) : availability?.suggestedTableId ? String(availability.suggestedTableId) : "");

  const seat = async () => {
    setSaving(true);
    setError("");

    const outcome = await onSeat({
      tableId: Number(chosen),
      overrideCapacity: overrides.capacity,
      overrideClash: overrides.clash,
    });

    setSaving(false);

    if (!outcome.ok) {
      setError(outcome.message);
    }
  };

  const chosenTable = availability?.tables.find((table) => String(table.id) === chosen);

  return (
    <Modal
      title={`Seat ${item.guestName} · party of ${item.partySize}`}
      description="Pick the table. Seating opens their order on the POS."
      icon="table"
      onClose={onClose}
      width={620}
    >
      <div className="stack">
        <p className="muted small">
          {kind === "booking"
            ? `Booked for ${timeLabel(toMinutes(item.startTime))}${
                item.tableNo ? ` at ${tablesLabel(item)}` : ", no table assigned"
              }. ${multiBooked ? `Seated at ${item.tableNo}, the order opens there with the other tables joined. ` : ""}`
            : "Walk-in from the waitlist. "}
          Seating opens a dine-in order on the table for {item.partySize} guests; add dishes from the POS.
        </p>
        {item.specialRequests && (
          <p className="rsv-request-box">
            <Glyph name="note" size={14} /> {item.specialRequests}
          </p>
        )}
        <ErrorMessage message={error} />

        <TablePicker
          availability={availability}
          loading={!availability}
          value={chosen}
          onChange={setTableId}
          mode="now"
          overrides={overrides}
          setOverrides={setOverrides}
        />

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Not yet
          </button>
          <button type="button" className="button" onClick={seat} disabled={!chosen || saving}>
            {saving
              ? "Seating…"
              : chosenTable
                ? `Seat at ${
                    multiBooked && chosenTable.id === item.tableId ? tablesLabel(item) : chosenTable.tableNo
                  } & open order`
                : "Seat"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function CancelDialog({ booking, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    const outcome = await onConfirm(reason);

    setBusy(false);

    if (!outcome.ok) {
      setError(outcome.message);
    }
  };

  return (
    <Modal
      title={`Cancel ${booking.guestName}'s booking`}
      description="The table is freed for someone else."
      icon="x-circle"
      onClose={onClose}
      width={480}
    >
      <form className="stack" onSubmit={submit}>
        <p className="muted small">
          {shortDate(booking.date)} · {timeLabel(toMinutes(booking.startTime))} · {booking.partySize} guests
          {booking.tableNo ? ` · ${booking.extraTables?.length ? "tables" : "table"} ${tablesLabel(booking)}` : ""}.{" "}
          {booking.extraTables?.length ? "Every table it holds is released" : "The table is released"} straight away.
        </p>
        <ErrorMessage message={error} />
        <div className="rsv-choice-row">
          {CANCEL_REASONS.map((option) => (
            <button
              key={option}
              type="button"
              className={`rsv-choice ${reason === option ? "is-active" : ""}`}
              onClick={() => setReason(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Reason *</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={200} />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep booking
          </button>
          <button type="submit" className="button button-danger" disabled={busy || !reason.trim()}>
            {busy ? "Cancelling…" : "Cancel booking"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- online requests

// Saying yes to an online request: on a table now (the smallest free one that
// fits is picked already), on several for a large party, or with no table yet
// to place later. The guest's link shows "Confirmed" the moment it is saved.
export function AcceptDialog({ booking, onClose, onAccept }) {
  const [availability, setAvailability] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [tableId, setTableId] = useState("");
  const [extraIds, setExtraIds] = useState([]);
  const [overrides, setOverrides] = useState({ capacity: false, clash: false, reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getTableAvailability({
      date: booking.date,
      time: booking.startTime,
      duration: booking.durationMinutes,
      partySize: booking.partySize,
    })
      .then((data) => {
        setAvailability(data);
        setTableId(data.suggestedTableId ? String(data.suggestedTableId) : "");
      })
      .catch((err) => setLoadError(getErrorMessage(err)));
  }, [booking]);

  const chosen = availability?.tables.find((table) => String(table.id) === String(tableId));
  const label = chosen
    ? [chosen.tableNo, ...availability.tables.filter((table) => extraIds.includes(String(table.id))).map((table) => table.tableNo)].join(
        " + "
      )
    : null;

  const submit = async () => {
    setBusy(true);
    setError("");

    const outcome = await onAccept({
      tableId: tableId ? Number(tableId) : null,
      extraTableIds: tableId ? extraIds.filter((id) => id !== tableId).map(Number) : [],
      overrideCapacity: overrides.capacity,
      capacityOverrideReason: overrides.capacity && extraIds.length > 0 ? overrides.reason.trim() || null : null,
    });

    setBusy(false);

    if (!outcome.ok) {
      setError(outcome.message);
    }
  };

  return (
    <Modal
      title={`Accept ${booking.guestName}'s request`}
      description="The guest sees it confirmed on their booking link as soon as you accept."
      icon="check-circle"
      onClose={onClose}
      width={720}
    >
      <div className="stack">
        <div className="obk-accept-summary">
          <span>
            <Glyph name="calendar" size={14} /> {shortDate(booking.date)} · {timeLabel(toMinutes(booking.startTime))}
          </span>
          <span>
            <Glyph name="users" size={14} /> {booking.partySize} {booking.partySize === 1 ? "guest" : "guests"}
          </span>
          {booking.occasion && (
            <span>
              <Glyph name="gift" size={14} /> {occasionLabel(booking.occasion)}
            </span>
          )}
          {booking.guestMobile && (
            <span>
              <Glyph name="phone" size={14} /> {booking.guestMobile}
            </span>
          )}
        </div>
        {booking.specialRequests && (
          <p className="rsv-request-box">
            <Glyph name="note" size={14} /> <span><strong>Guest asked:</strong> {booking.specialRequests}</span>
          </p>
        )}
        <ErrorMessage message={loadError || error} />
        <TablePicker
          availability={availability}
          loading={!availability}
          value={tableId}
          onChange={(id) => {
            setTableId(id);
            setExtraIds((current) => (id ? current.filter((item) => item !== id) : []));
          }}
          extraIds={extraIds}
          onExtraChange={setExtraIds}
          mode="book"
          allowNone
          overrides={overrides}
          setOverrides={setOverrides}
        />
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="button" onClick={submit} disabled={busy}>
            {busy ? "Accepting…" : label ? `Accept on ${label}` : "Accept without a table"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Reasons a guest can act on: they read this word for word on their link.
const DECLINE_REASONS = [
  "Fully booked at that time",
  "Closed for a private event that day",
  "Please call us to book this group",
  "We can offer another time — please call us",
];

export function DeclineDialog({ booking, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    const outcome = await onConfirm(reason.trim());

    setBusy(false);

    if (!outcome.ok) {
      setError(outcome.message);
    }
  };

  return (
    <Modal
      title={`Decline ${booking.guestName}'s request`}
      description="The guest reads your reason on their booking link."
      icon="x-circle"
      onClose={onClose}
      width={500}
    >
      <form className="stack" onSubmit={submit}>
        <p className="muted small">
          {shortDate(booking.date)} · {timeLabel(toMinutes(booking.startTime))} · {booking.partySize} guests ·{" "}
          {booking.reference}
        </p>
        <ErrorMessage message={error} />
        <div className="rsv-choice-row">
          {DECLINE_REASONS.map((option) => (
            <button
              key={option}
              type="button"
              className={`rsv-choice ${reason === option ? "is-active" : ""}`}
              onClick={() => setReason(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Reason the guest will read *</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={200} />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Back
          </button>
          <button type="submit" className="button button-danger" disabled={busy || !reason.trim()}>
            {busy ? "Declining…" : "Decline request"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
