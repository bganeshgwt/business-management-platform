// A booking's detail panel and history.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Modal from "../../../../components/Modal";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { money } from "@bmp/shared/format";
import { getReservation } from "../services/reservation.service";
import { at, bookingActions, heldSeats, heldUntil, liveState, longDate, occasionLabel, sourceLabel, tableOffNow, tableOffSentence, tablesLabel, timeLabel, toMinutes, toneOf, waitText } from "./reservationFormat";
import { Glyph, LiveChip, StatusChip } from "./ReservationChips";

// ---------------------------------------------------------------- one booking

const HISTORY_WORDS = {
  create: "Booked",
  update: "Changed",
  confirm: "Confirmed",
  seat: "Seated",
  complete: "Completed",
  cancel: "Cancelled",
  no_show: "Marked no-show",
  request: "Requested online",
  accept: "Accepted",
  decline: "Declined",
};

// The life of a booking, from its own timestamps (which every booking has)
// with names added from the audit trail where one was written.
const lifeOf = (booking) => {
  const steps = [
    // An online request was made by the guest, not by anyone on the staff.
    booking.source === "online" && !booking.createdByName
      ? { key: "request", at: booking.createdAt, who: "the guest" }
      : { key: "create", at: booking.createdAt, who: booking.createdByName },
    booking.confirmedAt && {
      key: (booking.history || []).some((row) => row.action === "accept") ? "accept" : "confirm",
      at: booking.confirmedAt,
    },
    booking.declinedAt && { key: "decline", at: booking.declinedAt, note: booking.cancelReason },
    booking.seatedAt && { key: "seat", at: booking.seatedAt },
    booking.completedAt && { key: "complete", at: booking.completedAt },
    booking.noShowAt && { key: "no_show", at: booking.noShowAt },
    booking.cancelledAt && { key: "cancel", at: booking.cancelledAt, note: booking.cancelReason },
  ].filter(Boolean);

  for (const step of steps) {
    const logged = (booking.history || []).find((row) => row.action === step.key);

    if (logged) {
      step.who = logged.userName;
    }
  }

  const changes = (booking.history || [])
    .filter((row) => row.action === "update")
    .map((row) => ({
      key: `update-${row.id}`,
      at: row.at,
      who: row.userName,
      label: "Changed",
      note: row.details
        ? Object.entries(row.details)
            .map(([field, change]) => `${field}: ${change.from ?? "—"} → ${change.to ?? "—"}`)
            .join(" · ")
        : null,
    }));

  return [...steps.map((step) => ({ ...step, label: HISTORY_WORDS[step.key] })), ...changes].sort(
    (a, b) => new Date(a.at) - new Date(b.at)
  );
};

export default function BookingDetail({ id, version, clock, lateAfter, canManage, canSeat, canOrder, handlers, onClose }) {
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    getReservation(id)
      .then((data) => {
        setBooking(data);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [id, version]);

  const title = booking ? `${booking.guestName} · ${booking.reference}` : "Booking";

  if (!booking || booking.id !== id) {
    return (
      <Modal title={title} icon="calendar" onClose={onClose} width={680}>
        {error ? <ErrorMessage message={error} /> : <Loading />}
      </Modal>
    );
  }

  const start = toMinutes(booking.startTime);
  const live = liveState(booking, clock, booking.date === clock.date, lateAfter);
  const can = bookingActions(booking, { clock, canManage, canSeat });
  // A seated party still eating after their booked slot: worth knowing when
  // the next booking on the table is due.
  const overstay = heldUntil(booking, clock, booking.date === clock.date) - (start + booking.durationMinutes);
  const closeThen = (action) => () => {
    onClose();
    action(booking);
  };
  // Refusals ("it is not 7:30 pm yet") are shown here, where they were asked.
  const act = (action) => async () => {
    setActionError("");

    const outcome = await action(booking, true);

    if (!outcome.ok) {
      setActionError(outcome.message);
    }
  };

  return (
    <Modal title={title} icon="calendar" onClose={onClose} width={680}>
      <div className="rsv-detail">
        <div className={`rsv-detail-hero rsv-tone-${toneOf(booking, live)}`}>
          <div className="rsv-detail-when">
            <span className="rsv-detail-date">{longDate(booking.date)}</span>
            <strong>
              {timeLabel(start)} – {timeLabel(start + booking.durationMinutes)}
            </strong>
          </div>
          <div className="rsv-detail-chips">
            <StatusChip status={booking.status} />
            <LiveChip live={live} />
            {overstay > 0 && (
              <span className="rsv-chip rsv-tone-late">Still at the table, {waitText(overstay)} past their slot</span>
            )}
            {booking.occasion && (
              <span className="rsv-tag">
                <Glyph name="gift" size={12} /> {occasionLabel(booking.occasion)}
              </span>
            )}
          </div>
          <div className="rsv-detail-facts">
            <span>
              <Glyph name="users" /> {booking.partySize} {booking.partySize === 1 ? "guest" : "guests"}
            </span>
            <span>
              <Glyph name="table" />{" "}
              {booking.tableNo
                ? `${booking.extraTables?.length ? "Tables" : "Table"} ${tablesLabel(booking)} · ${heldSeats(booking)} seats${
                    booking.areaName ? ` · ${booking.areaName}` : ""
                  }`
                : "No table yet"}
            </span>
            {booking.capacityOverride && (
              <span className="rsv-tag">
                Extra chairs agreed{booking.capacityOverrideReason ? `: ${booking.capacityOverrideReason}` : ""}
              </span>
            )}
          </div>
          {tableOffNow(booking) && (
            <p className="alert alert-notice rsv-table-off">
              Table {booking.tableNo} cannot take a party right now: {tableOffSentence(booking)}. The booking keeps
              it. Edit the booking to give them another table before they arrive, or leave it if it opens again by
              then.
            </p>
          )}
        </div>

        {booking.specialRequests && (
          <p className="rsv-request-box">
            <Glyph name="note" size={14} /> <span><strong>Guest asked:</strong> {booking.specialRequests}</span>
          </p>
        )}
        {booking.internalNotes && (
          <p className="rsv-internal-box">
            <strong>Staff note:</strong> {booking.internalNotes}
          </p>
        )}
        {booking.status === "cancelled" && (
          <p className="alert">Cancelled — {booking.cancelReason}</p>
        )}
        {booking.status === "declined" && (
          <p className="alert">Declined — {booking.cancelReason}. The guest sees this on their booking link.</p>
        )}
        {booking.status === "requested" && (
          <p className="alert alert-notice">
            Asked online {at(booking.createdAt)}. No table is held until you accept — the guest sees your answer on
            their booking link.
          </p>
        )}

        <dl className="details rsv-detail-list">
          <dt>Mobile</dt>
          <dd>
            {/* Staff who may not see guests' full numbers are shown the last
                four digits ("XXXXXX4823"): shown, but not a number to dial. */}
            {booking.guestMobile && /X/.test(booking.guestMobile) ? (
              <span>
                <Glyph name="phone" size={13} /> {booking.guestMobile}
              </span>
            ) : booking.guestMobile ? (
              <a href={`tel:${booking.guestMobile}`}>
                <Glyph name="phone" size={13} /> {booking.guestMobile}
              </a>
            ) : (
              "—"
            )}
          </dd>
          <dt>Guest book</dt>
          <dd>
            {booking.customerId
              ? `${booking.customerName}${booking.customerPoints !== null ? ` · ${booking.customerPoints} points` : ""}`
              : "Not linked"}
          </dd>
          {booking.guestRecord && booking.guestRecord.bookings > 0 && (
            <>
              <dt>Before</dt>
              <dd className={booking.guestRecord.noShows > 0 ? "rsv-warn-text" : ""}>
                {booking.guestRecord.bookings} other bookings · {booking.guestRecord.completed} came ·{" "}
                {booking.guestRecord.noShows} no-shows · {booking.guestRecord.cancelled} cancelled
              </dd>
            </>
          )}
          <dt>Booked by</dt>
          <dd>{sourceLabel(booking.source)}</dd>
          {booking.orderId && (
            <>
              <dt>Order</dt>
              <dd>
                {booking.orderNumber} ·{" "}
                {booking.billTotal !== null
                  ? `billed ${money(booking.billTotal)}`
                  : `${money(booking.orderTotal || 0)} so far`}{" "}
                · {booking.orderStatus}
                {canOrder && ["open", "billed"].includes(booking.orderStatus) && (
                  <>
                    {" "}
                    <Link to={`/pos?order=${booking.orderId}`}>Open in POS</Link>
                  </>
                )}
              </dd>
            </>
          )}
        </dl>

        <div>
          <p className="section-heading">History</p>
          <ol className="rsv-history">
            {lifeOf(booking).map((step) => (
              <li key={step.key}>
                <span className="rsv-history-dot" aria-hidden="true" />
                <div>
                  <strong>{step.label}</strong>
                  <span className="muted small">
                    {" "}
                    {at(step.at)}
                    {step.who ? ` · ${step.who}` : ""}
                  </span>
                  {step.note && <p className="muted small rsv-history-note">{step.note}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>

        <ErrorMessage message={actionError} />

        <div className="rsv-detail-actions">
          {can.edit && (
            <button type="button" className="button button-secondary" onClick={closeThen(handlers.edit)}>
              Edit
            </button>
          )}
          {can.cancel && (
            <button type="button" className="button button-secondary rsv-danger-text" onClick={closeThen(handlers.cancel)}>
              Cancel booking
            </button>
          )}
          {can.noShow && (
            <button type="button" className="button button-secondary rsv-danger-text" onClick={act(handlers.noShow)}>
              No-show
            </button>
          )}
          {can.decline && (
            <button type="button" className="button button-secondary rsv-danger-text" onClick={closeThen(handlers.decline)}>
              Decline
            </button>
          )}
          <span className="rsv-spacer" />
          {can.accept && (
            <button type="button" className="button" onClick={closeThen(handlers.accept)}>
              <Glyph name="check" size={14} /> Accept
            </button>
          )}
          {can.confirm && (
            <button type="button" className="button button-secondary" onClick={act(handlers.confirm)}>
              <Glyph name="check" size={14} /> Confirm
            </button>
          )}
          {can.complete && (
            <button type="button" className="button button-secondary" onClick={act(handlers.complete)}>
              Mark completed
            </button>
          )}
          {booking.status === "seated" && booking.orderId && canOrder && (
            <Link className="button" to={`/pos?order=${booking.orderId}`}>
              Open in POS
            </Link>
          )}
          {can.seat && (
            <button type="button" className="button" onClick={closeThen(handlers.seat)}>
              {booking.status === "no_show" ? "Arrived after all — seat" : "Seat now"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
