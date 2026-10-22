// The agenda list of bookings and its booking cards.

import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import ActionMenu from "../../../../components/ActionMenu";
import { EmptyState } from "../../../../components/Feedback";
import { bookingActions, hourLabel, liveState, occasionLabel, sourceLabel, tableOffNow, tableOffWords, tablesLabel, timeLabel, toMinutes, toneOf } from "./reservationFormat";
import { Glyph, LiveChip, StatusChip } from "./ReservationChips";

// ---------------------------------------------------------------- agenda

const AGENDA_FILTERS = [
  { key: "all", label: "All", test: (booking) => !["cancelled", "declined"].includes(booking.status) },
  { key: "requested", label: "Online requests", test: (booking) => booking.status === "requested" },
  { key: "arriving", label: "To arrive", test: (booking) => ["booked", "confirmed"].includes(booking.status) },
  { key: "seated", label: "Seated", test: (booking) => booking.status === "seated" },
  { key: "completed", label: "Completed", test: (booking) => booking.status === "completed" },
  {
    key: "missed",
    label: "No-show / cancelled",
    test: (booking) => ["no_show", "cancelled", "declined"].includes(booking.status),
  },
];

export default function Agenda({ board, clock, isToday, isPast, lateAfter, show, setShow, canManage, canSeat, canOrder, handlers, onNew }) {
  const filter = AGENDA_FILTERS.find((item) => item.key === show) || AGENDA_FILTERS[0];
  const visible = board.bookings.filter(filter.test);

  const hours = [];

  for (const booking of visible) {
    const hour = Math.floor(toMinutes(booking.startTime) / 60) * 60;
    let group = hours.find((item) => item.hour === hour);

    if (!group) {
      group = { hour, items: [] };
      hours.push(group);
    }

    group.items.push(booking);
  }

  return (
    <div className="rsv-agenda">
      <div className="rsv-board-head">
        <div className="rsv-head-main">
          <span className="section-card-icon tone-primary" aria-hidden="true">
            <Icon name="list" size={18} />
          </span>
          <div>
            <h2>Agenda</h2>
            <p className="muted small">Every booking in time order, with the next step one click away.</p>
          </div>
        </div>
        <div className="rsv-filter-chips" role="radiogroup" aria-label="Show">
          {AGENDA_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="radio"
              aria-checked={filter.key === item.key}
              className={`tab ${filter.key === item.key ? "active" : ""}`}
              onClick={() => setShow(item.key)}
            >
              {item.label} <span className="rsv-count">{board.bookings.filter(item.test).length}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          message={
            board.bookings.length > 0
              ? "Nothing in this view."
              : board.hours && !board.hours.isOpen
                ? "The restaurant is closed on this day."
                : isPast
                  ? "No bookings on this day."
                  : "No bookings on this day yet."
          }
          hint={
            board.bookings.length > 0
              ? "Pick another filter above to see the rest of the day."
              : board.hours && !board.hours.isOpen
                ? "Opening hours are set under Restaurant → Business hours."
                : isPast
                  ? "Nobody booked for this day."
                  : "Take one from the phone with New booking — it lands here and on the timeline."
          }
          action={
            board.bookings.length === 0 &&
            canManage &&
            !isPast &&
            (!board.hours || board.hours.isOpen) && (
              <button type="button" className="button" onClick={onNew}>
                New booking
              </button>
            )
          }
        />
      ) : (
        hours.map((group) => (
          <section key={group.hour} className="rsv-hour">
            <h3 className="rsv-hour-head">
              <span>{hourLabel(group.hour)}</span>
              <span className="muted">
                {group.items.length} {group.items.length === 1 ? "booking" : "bookings"} ·{" "}
                {group.items.reduce((sum, booking) => sum + booking.partySize, 0)} covers
              </span>
            </h3>
            <div className="rsv-cards">
              {group.items.map((booking) => (
                <BookingCard
                  key={booking.id}
                  booking={booking}
                  live={liveState(booking, clock, isToday, lateAfter)}
                  clock={clock}
                  isToday={isToday}
                  canManage={canManage}
                  canSeat={canSeat}
                  canOrder={canOrder}
                  handlers={handlers}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function BookingCard({ booking, live, clock, canManage, canSeat, canOrder, handlers }) {
  const start = toMinutes(booking.startTime);
  const can = bookingActions(booking, { clock, canManage, canSeat });
  const tone = toneOf(booking, live);
  // Once the slot is over the likely next step is the no-show; seating stays
  // one click away for the party that does turn up hours late.
  const missed = live?.key === "missed";
  // A no-show from a slot long over (lunch, seen at dinner) is history: the
  // "they turned up after all" seat moves into the menu instead of being the
  // card's main button.
  const slotOver = booking.date === clock.date && clock.minutes >= start + booking.durationMinutes;
  const oldNoShow = booking.status === "no_show" && slotOver;
  // Seat is the obvious next step only once the party is close; an evening
  // booking at lunchtime can still be seated early from the menu.
  const seatFirst =
    can.seat && !missed && !oldNoShow && (booking.status === "no_show" || start - clock.minutes <= 60);

  const menu = [
    { label: "View details", onClick: () => handlers.open(booking) },
    can.edit && { label: "Edit booking", onClick: () => handlers.edit(booking) },
    can.complete && { label: "Mark completed", onClick: () => handlers.complete(booking) },
    can.seat && oldNoShow && { label: "Arrived after all — seat", onClick: () => handlers.seat(booking) },
  ].filter(Boolean);

  return (
    <article className={`rsv-card rsv-tone-${tone}`}>
      <button type="button" className="rsv-card-main" onClick={() => handlers.open(booking)}>
        <span className="rsv-card-when">
          <strong>{timeLabel(start)}</strong>
          <small>until {timeLabel(start + booking.durationMinutes)}</small>
        </span>
        <span className="rsv-card-info">
          <span className="rsv-card-line">
            <strong className="rsv-card-name">{booking.guestName}</strong>
            <StatusChip status={booking.status} />
            <LiveChip live={live} />
            {booking.occasion && (
              <span className="rsv-tag">
                <Glyph name="gift" size={12} /> {occasionLabel(booking.occasion)}
              </span>
            )}
          </span>
          <span className="rsv-card-facts">
            <span>
              <Glyph name="users" size={13} /> {booking.partySize} {booking.partySize === 1 ? "guest" : "guests"}
            </span>
            <span className={booking.tableNo && !tableOffNow(booking) ? "" : "rsv-missing"}>
              <Glyph name="table" size={13} />{" "}
              {booking.tableNo
                ? `${booking.extraTables?.length ? "Tables" : "Table"} ${tablesLabel(booking)}`
                : "No table yet"}
              {booking.capacityOverride && " (extra chairs)"}
              {tableOffNow(booking) && ` · ${tableOffWords(booking)}, move them`}
            </span>
            {booking.guestMobile && (
              <span>
                <Glyph name="phone" size={13} /> {booking.guestMobile}
              </span>
            )}
            <span className="muted">
              {sourceLabel(booking.source)} · {booking.reference}
            </span>
          </span>
          {booking.specialRequests && (
            <span className="rsv-card-request">
              <Glyph name="note" size={13} /> {booking.specialRequests}
            </span>
          )}
          {booking.status === "cancelled" && booking.cancelReason && (
            <span className="rsv-card-reason">Cancelled: {booking.cancelReason}</span>
          )}
          {booking.status === "declined" && booking.cancelReason && (
            <span className="rsv-card-reason">Declined: {booking.cancelReason}</span>
          )}
        </span>
      </button>

      <div className="rsv-card-actions">
        {can.decline && (
          <button type="button" className="rsv-quiet-button" onClick={() => handlers.decline(booking)}>
            Decline
          </button>
        )}
        {can.accept && (
          <button type="button" className="button rsv-small-button" onClick={() => handlers.accept(booking)}>
            <Glyph name="check" size={13} /> Accept
          </button>
        )}
        {can.cancel && (
          <button type="button" className="rsv-quiet-button" onClick={() => handlers.cancel(booking)}>
            Cancel
          </button>
        )}
        {can.noShow && !missed && (
          <button type="button" className="chip-button rsv-danger-chip" onClick={() => handlers.noShow(booking)}>
            No-show
          </button>
        )}
        {can.confirm && !missed && (
          <button type="button" className="chip-button" onClick={() => handlers.confirm(booking)}>
            <Glyph name="check" size={13} /> Confirm
          </button>
        )}
        {can.seat && !seatFirst && !oldNoShow && (
          <button type="button" className="chip-button" onClick={() => handlers.seat(booking)}>
            {missed ? "Arrived — seat" : "Seat early"}
          </button>
        )}
        {missed && can.noShow && (
          <button type="button" className="button rsv-small-button rsv-danger-button" onClick={() => handlers.noShow(booking)}>
            Mark no-show
          </button>
        )}
        {seatFirst && (
          <button type="button" className="button rsv-small-button" onClick={() => handlers.seat(booking)}>
            {booking.status === "no_show" ? "Arrived — seat" : "Seat"}
          </button>
        )}
        {booking.status === "seated" && booking.orderId && canOrder && (
          <Link className="button rsv-small-button" to={`/pos?order=${booking.orderId}`}>
            Open in POS
          </Link>
        )}
        <ActionMenu items={menu} label={`More for ${booking.guestName}`} />
      </div>
    </article>
  );
}
