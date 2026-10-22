// Bookings that need attention now.

import { Fragment, useState } from "react";
import { minutesSince, timeLabel, toMinutes } from "./reservationFormat";
import { Glyph } from "./ReservationChips";

// Names as links, capped so a long list does not bury the rest of the page.
function BookingLinks({ bookings, onOpen, max = 6 }) {
  const shown = bookings.slice(0, max);

  return (
    <>
      {shown.map((booking, index) => (
        <Fragment key={booking.id}>
          {index > 0 && ", "}
          <button type="button" className="rsv-inline-link" onClick={() => onOpen(booking)}>
            {booking.guestName} ({booking.partySize}) at {timeLabel(toMinutes(booking.startTime))}
          </button>
        </Fragment>
      ))}
      {bookings.length > shown.length && ` and ${bookings.length - shown.length} more`}
    </>
  );
}

export default function Attention({ late, missed, overdue, now, onOpen, onMarkMissed }) {
  const [marking, setMarking] = useState(false);

  return (
    <div className="rsv-attention" role="status">
      <span className="rsv-attention-icon" aria-hidden="true">
        <Glyph name="alert" size={18} />
      </span>
      <div className="rsv-attention-body">
        {late.length > 0 && (
          <p>
            <strong>
              {late.length} {late.length === 1 ? "party is" : "parties are"} running late.
            </strong>{" "}
            Call them, or mark a no-show to free the table: <BookingLinks bookings={late} onOpen={onOpen} />
          </p>
        )}
        {missed.length > 0 && (
          <p className="rsv-attention-row">
            <span>
              <strong>
                {missed.length} {missed.length === 1 ? "booking's slot has" : "bookings' slots have"} gone by with
                nobody seated.
              </strong>{" "}
              Mark the no-shows so the day's numbers are right: <BookingLinks bookings={missed} onOpen={onOpen} />
            </span>
            {onMarkMissed && (
              <button
                type="button"
                className="button button-secondary rsv-small-button rsv-attention-action"
                disabled={marking}
                onClick={() => {
                  setMarking(true);
                  onMarkMissed().finally(() => setMarking(false));
                }}
              >
                {marking ? "Marking…" : `Mark ${missed.length === 1 ? "it" : `all ${missed.length}`} as no-show`}
              </button>
            )}
          </p>
        )}
        {overdue.length > 0 && (
          <p>
            <strong>
              {overdue.length} {overdue.length === 1 ? "walk-in has" : "walk-ins have"} waited longer than quoted:
            </strong>{" "}
            {overdue
              .map((entry) => `${entry.guestName} ${minutesSince(entry.joinedAt, now)} min (quoted ${entry.quotedMinutes})`)
              .join(", ")}
            . Seat them or give them an honest update.
          </p>
        )}
      </div>
    </div>
  );
}
