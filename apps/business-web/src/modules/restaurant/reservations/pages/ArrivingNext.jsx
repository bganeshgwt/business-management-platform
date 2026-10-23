import { liveState, tablesLabel, timeLabel, toMinutes } from "./reservationFormat";
import "./arriving.css";

// "Arriving next": the parties due in the next two hours (and any running
// late), first on the page, each with what the host does when they walk in:
// Seat, Call, No-show. The timeline and the agenda stay below for the whole
// day; this is the list a host works from at the door.
const WINDOW = 120;

const phoneOf = (booking) => {
  const digits = String(booking.guestMobile || "").replace(/\D/g, "");
  return digits.length >= 10 && !/x/i.test(booking.guestMobile || "") ? digits : null;
};

export default function ArrivingNext({ board, clock, lateAfter, canSeat, canManage, handlers }) {
  const due = board.bookings
    .filter((booking) => ["booked", "confirmed"].includes(booking.status))
    .map((booking) => ({ booking, live: liveState(booking, clock, true, lateAfter), start: toMinutes(booking.startTime) }))
    .filter(({ live, start }) => (live && ["late", "missed", "due"].includes(live.key)) || (start >= clock.minutes && start - clock.minutes <= WINDOW))
    .sort((a, b) => a.start - b.start);

  if (due.length === 0) {
    return null;
  }

  return (
    <section className="card rsv-next" aria-labelledby="rsv-next-title">
      <div className="rsv-next-head">
        <h2 id="rsv-next-title">Arriving next</h2>
        <span className="muted small">
          {due.length} {due.length === 1 ? "party" : "parties"} in the next two hours or running late
        </span>
      </div>
      <ul className="rsv-next-list">
        {due.map(({ booking, live }) => {
          const late = live && (live.key === "late" || live.key === "missed");
          const phone = phoneOf(booking);

          return (
            <li key={booking.id} className={`rsv-next-row ${late ? "is-late" : ""}`}>
              <button type="button" className="rsv-next-who" onClick={() => handlers.open(booking)}>
                <strong className="rsv-next-time">{timeLabel(toMinutes(booking.startTime))}</strong>
                <span className="rsv-next-name">
                  {booking.guestName} · {booking.partySize}
                  <span className="muted small">
                    {booking.tableNo ? ` · Table ${tablesLabel(booking)}` : " · no table yet"}
                    {late ? ` · ${live.label}` : ""}
                  </span>
                </span>
              </button>
              <span className="rsv-next-actions">
                {canSeat && (
                  <button type="button" className="button button-sm" onClick={() => handlers.seat(booking)}>
                    Seat
                  </button>
                )}
                {phone && (
                  <a className="button button-sm button-secondary" href={`tel:${phone}`}>
                    Call
                  </a>
                )}
                {canManage && late && (
                  <button type="button" className="button button-sm button-secondary" onClick={() => handlers.noShow(booking)}>
                    No-show
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
