// Guest-book match and party size stepper used by the booking and walk-in editors.

import { useEffect, useState } from "react";
import { lookupGuest } from "../services/reservation.service";
import { digitsOf } from "./reservationFormat";
import { Glyph } from "./ReservationChips";

// ---------------------------------------------------------------- guest lookup

// "12 visits · 340 points" when the server sent them: guest-book detail only
// reaches people who may open the guest book.
const guestBookFacts = (customer) =>
  customer && customer.visits !== undefined
    ? ` · ${customer.visits} ${customer.visits === 1 ? "visit" : "visits"} · ${customer.loyaltyPoints} points`
    : "";

// Recognises the caller from their number. Linking is always visible and can
// be undone; nobody is ever added to the guest book from here. When editing,
// the booking on screen is left out of "booked N times before".
export function GuestMatch({ mobile, customerId, customerName, excludeId, onLink, onUnlink }) {
  const [found, setFound] = useState(null);
  const digits = digitsOf(mobile);

  useEffect(() => {
    if (digits.length < 10) {
      return undefined;
    }

    const timer = setTimeout(() => {
      lookupGuest(digits, excludeId)
        .then((data) => setFound({ digits, ...data }))
        .catch(() => setFound({ digits, customer: null, record: null }));
    }, 350);

    return () => clearTimeout(timer);
  }, [digits, excludeId]);

  const match = found && found.digits === digits ? found : null;

  if (customerId) {
    return (
      <div className="rsv-guest is-linked">
        <Glyph name="check" size={14} />
        <span>
          Linked to <strong>{customerName || match?.customer?.name || "guest book entry"}</strong> in the guest book
          {guestBookFacts(match?.customer)}
        </span>
        <button type="button" className="link-button" onClick={onUnlink}>
          Unlink
        </button>
      </div>
    );
  }

  if (!match) {
    return null;
  }

  const record = match.record;

  return (
    <>
      {match.customer && (
        <div className="rsv-guest">
          <Glyph name="star" size={14} />
          <span>
            Returning guest: <strong>{match.customer.name}</strong>
            {guestBookFacts(match.customer)}
          </span>
          <button type="button" className="link-button" onClick={() => onLink(match.customer)}>
            Link
          </button>
        </div>
      )}
      {record && record.bookings > 0 && (
        <div className={`rsv-guest ${record.noShows > 0 ? "is-warning" : "is-plain"}`}>
          <Glyph name={record.noShows > 0 ? "alert" : "calendar"} size={14} />
          <span>
            Booked {record.bookings} {record.bookings === 1 ? "time" : "times"} before · {record.completed} came
            {record.noShows > 0 && ` · ${record.noShows} no-show${record.noShows === 1 ? "" : "s"} — worth a confirmation call`}
            {record.cancelled > 0 && ` · ${record.cancelled} cancelled`}
          </span>
        </div>
      )}
    </>
  );
}

export function PartyStepper({ value, onChange, max = 50 }) {
  const number = Number(value) || 0;

  return (
    <div className="rsv-stepper">
      <button type="button" onClick={() => onChange(Math.max(1, number - 1))} aria-label="One fewer guest">
        −
      </button>
      <input
        type="number"
        min="1"
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
        aria-label="Party size"
        required
      />
      <button type="button" onClick={() => onChange(Math.min(max, number + 1))} aria-label="One more guest">
        +
      </button>
      <span className="rsv-stepper-quick">
        {[2, 4, 6, 8].map((size) => (
          <button
            key={size}
            type="button"
            className={number === size ? "is-active" : ""}
            onClick={() => onChange(size)}
          >
            {size}
          </button>
        ))}
      </span>
    </div>
  );
}
