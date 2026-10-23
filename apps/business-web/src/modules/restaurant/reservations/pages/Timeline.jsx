// The table timeline: bookings in lanes by table and time.

import { Fragment, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { EmptyState } from "../../../../components/Feedback";
import { LEGEND, STATUS, clockIn, heldUntil, hhmm, holdsTable, hourLabel, liveState, minutesSince, shortName, tablesLabel, timeLabel, toMinutes, toneOf, waitText } from "./reservationFormat";
import { Glyph } from "./ReservationChips";

// ---------------------------------------------------------------- timeline

const SLOT = 30;

const floorSlot = (minutes) => Math.floor(minutes / SLOT) * SLOT;

const ceilSlot = (minutes) => Math.ceil(minutes / SLOT) * SLOT;

// Unassigned bookings can overlap each other, so they are dealt into as many
// lanes as it takes for none to sit on top of another.
const intoLanes = (bookings) => {
  const lanes = [];

  for (const booking of [...bookings].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime))) {
    const start = toMinutes(booking.startTime);
    let lane = lanes.find((candidate) => candidate.end <= start);

    if (!lane) {
      lane = { end: 0, items: [] };
      lanes.push(lane);
    }

    lane.items.push(booking);
    lane.end = start + booking.durationMinutes;
  }

  return lanes;
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function Timeline({ board, clock, now, isToday, lateAfter, canBook, onOpen, onBookAt }) {
  const scrollRef = useRef(null);
  // A declined online request never held a table; an unanswered one is drawn
  // (dashed, in "No table yet") so the host sees the evening's demand.
  const bookings = board.bookings.filter((booking) => !["cancelled", "declined"].includes(booking.status));
  const bookedOrders = new Set(board.bookings.map((booking) => booking.orderId).filter(Boolean));
  const nowMinutes = isToday ? clock.minutes : null;
  // Opening hours for the day on screen (null when the restaurant has not
  // set any): the timeline greys out when the doors are shut, and an empty
  // slot can only be booked inside the hours bookings are taken.
  const hours = board.hours;
  const closedDay = Boolean(hours && !hours.isOpen);
  const bookable = canBook && !closedDay;

  // Tables in use by someone who never booked: a walk-in, or a party the POS
  // opened directly. Drawn so the book does not claim a table is free when
  // there are people sitting at it.
  const occupancy = isToday
    ? board.tables
        .filter((table) => table.live && !bookedOrders.has(table.live.orderId))
        .map((table) => {
          const placed = clockIn(board.timezone, Date.parse(table.live.placedAt));
          const start = placed.date === board.date ? placed.minutes : null;

          return { table, start, end: Math.max(clock.minutes, (start ?? clock.minutes) + SLOT) };
        })
    : [];

  let rangeStart = 11 * 60;
  let rangeEnd = 23 * 60 + 30;

  for (const booking of bookings) {
    rangeStart = Math.min(rangeStart, floorSlot(toMinutes(booking.startTime)));
    rangeEnd = Math.max(rangeEnd, ceilSlot(heldUntil(booking, clock, isToday)));
  }

  for (const block of occupancy) {
    if (block.start !== null) {
      rangeStart = Math.min(rangeStart, floorSlot(block.start));
    }
    rangeEnd = Math.max(rangeEnd, ceilSlot(block.end));
  }

  if (nowMinutes !== null) {
    rangeStart = Math.min(rangeStart, floorSlot(nowMinutes - SLOT));
    rangeEnd = Math.max(rangeEnd, ceilSlot(nowMinutes + SLOT));
  }

  rangeStart = Math.max(0, rangeStart);
  rangeEnd = Math.min(rangeEnd, 26 * 60);

  const slots = (rangeEnd - rangeStart) / SLOT;
  const nowX = nowMinutes === null ? null : (nowMinutes - rangeStart) / SLOT;

  // The stretches of the grid when the restaurant is shut.
  const shut = closedDay
    ? [{ from: rangeStart, to: rangeEnd }]
    : hours
      ? [
          { from: rangeStart, to: Math.min(Math.max(hours.openMinutes, rangeStart), rangeEnd) },
          { from: Math.max(Math.min(hours.closeMinutes, rangeEnd), rangeStart), to: rangeEnd },
        ].filter((band) => band.to > band.from)
      : [];
  const bookFrom = hours && hours.isOpen ? hours.openMinutes : 0;
  const bookTo = hours && hours.isOpen ? hours.lastBookingMinutes : 26 * 60;

  // Opens on the part of the day that matters: now, when looking at today.
  useEffect(() => {
    const box = scrollRef.current;

    if (!box || nowX === null) {
      return;
    }

    // Only matters when the day is wider than the screen (a phone): then the
    // now-line is brought into view instead of opening on the morning.
    const slotWidth = (box.scrollWidth - box.querySelector(".rsv-tl-corner").offsetWidth) / slots;
    box.scrollLeft = Math.max(0, nowX * slotWidth - slotWidth * 2);
    // Only when the day or the range changes, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.date, rangeStart, slots]);

  const groups = [];

  for (const table of board.tables) {
    const key = `${table.floorName}|${table.areaName || ""}`;
    let group = groups.find((item) => item.key === key);

    if (!group) {
      group = { key, floor: table.floorName, area: table.areaName, tables: [] };
      groups.push(group);
    }

    group.tables.push(table);
  }

  const lanes = intoLanes(bookings.filter((booking) => !booking.tableId));

  const place = (start, length) => ({ "--x": (start - rangeStart) / SLOT, "--w": length / SLOT });

  // A party due within the hour whose table still has someone else on it:
  // the turn the host has to chase before they walk in.
  const blockedBy = (booking) => {
    if (!isToday || !booking.tableId || !["booked", "confirmed"].includes(booking.status)) {
      return null;
    }

    const table = board.tables.find((item) => item.id === booking.tableId);
    const due = toMinutes(booking.startTime) - clock.minutes;

    return table && table.live && table.live.orderId !== booking.orderId && due <= 60 ? table.live : null;
  };

  const renderBlock = (booking, rowTableId) => {
    const live = liveState(booking, clock, isToday, lateAfter);
    // On a joined table's row the block says which table the party sits at.
    const joinedRow = Boolean(rowTableId && booking.tableId && rowTableId !== booking.tableId);
    const tone = toneOf(booking, live);
    const start = toMinutes(booking.startTime);
    const blocked = blockedBy(booking);
    const end = heldUntil(booking, clock, isToday);
    // Minutes a seated party has stayed past the slot they booked.
    const over = end - (start + booking.durationMinutes);

    return (
      <button
        key={`${booking.id}-${rowTableId || "none"}`}
        type="button"
        className={`rsv-block rsv-tone-${tone} ${booking.durationMinutes < 60 ? "is-short" : ""} ${
          blocked ? "is-blocked" : ""
        } ${over > 0 ? "is-overstay" : ""} ${joinedRow ? "is-joined" : ""}`}
        style={{ ...place(start, end - start), "--booked": booking.durationMinutes / (end - start) }}
        onClick={() => onOpen(booking)}
        title={`${booking.guestName} · ${booking.partySize} guests${
          booking.extraTables?.length ? ` · tables ${tablesLabel(booking)}` : ""
        } · ${timeLabel(start)}–${timeLabel(
          start + booking.durationMinutes
        )} · ${live ? live.label : STATUS[booking.status].label}${
          blocked ? ` · table still in use (${blocked.orderNumber})` : ""
        }${over > 0 ? ` · still at the table, ${waitText(over)} past their slot` : ""}`}
      >
        <span className="rsv-block-name">
          {blocked && <Glyph name="alert" size={11} />}
          {booking.occasion && !blocked && <Glyph name="star" size={11} />}
          {booking.durationMinutes < 100 ? shortName(booking.guestName) : booking.guestName}
        </span>
        <span className="rsv-block-meta">
          <Glyph name="users" size={11} /> {booking.partySize}
          {booking.capacityOverride ? "+" : ""} · {timeLabel(start)}
          {joinedRow && <span className="rsv-block-joined">· with {booking.tableNo}</span>}
          {booking.specialRequests && <Glyph name="note" size={11} />}
          {over > 0 && <span className="rsv-block-over">· still here +{waitText(over)}</span>}
        </span>
      </button>
    );
  };

  const trackClick = (event, tableId) => {
    if (!bookable || event.target !== event.currentTarget) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = rangeStart + ((event.clientX - rect.left) / rect.width) * (rangeEnd - rangeStart);
    const snapped = Math.floor(minutes / 15) * 15;

    if ((isToday && snapped < clock.minutes - 15) || snapped < bookFrom || snapped > bookTo) {
      return;
    }

    onBookAt({ tableId, startTime: hhmm(snapped % 1440) });
  };

  return (
    <div className="rsv-timeline-wrap">
      <div className="rsv-board-head">
        <div className="rsv-head-main">
          <span className="section-card-icon tone-primary" aria-hidden="true">
            <Icon name="table" size={18} />
          </span>
          <div>
          <h2>Floor timeline</h2>
          <p className="muted small">
            {closedDay
              ? `Closed on ${WEEKDAY_NAMES[hours.dayOfWeek]}s — no bookings are taken for this day.`
              : bookable
                ? "Each row is a table. Click a block to open the booking, or an empty slot to book that table."
                : "Each row is a table. Click a block to open the booking."}
          </p>
          </div>
        </div>
        <ul className="rsv-legend" aria-label="Colour key">
          {LEGEND.map((item) => (
            <li key={item.tone}>
              <span className={`rsv-legend-swatch rsv-tone-${item.tone}`} aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
      </div>

      {board.tables.length === 0 ? (
        <EmptyState
          message="No tables to book yet."
          hint="Add tables under Tables & QR — the timeline draws one row for each."
          action={
            <Link className="button" to="/tables">
              Go to tables
            </Link>
          }
        />
      ) : (
        <div className="rsv-tl" ref={scrollRef}>
          <div className="rsv-tl-grid" style={{ "--slots": slots }}>
            <div className="rsv-tl-head">
              <div className="rsv-tl-corner">Table</div>
              <div className="rsv-tl-scale">
                {Array.from({ length: slots }, (_, index) => {
                  const minutes = rangeStart + index * SLOT;

                  return (
                    <span key={minutes} className={`rsv-tl-tick ${minutes % 60 === 0 ? "is-hour" : ""}`}>
                      {minutes % 60 === 0 ? hourLabel(minutes) : ""}
                    </span>
                  );
                })}
              </div>
            </div>

            {lanes.length > 0 && (
              <>
                <div className="rsv-tl-group is-attention">
                  <span>
                    No table yet
                    <em className="rsv-tl-group-count">
                      {lanes.reduce((sum, lane) => sum + lane.items.length, 0)} to place — open one to assign a table
                    </em>
                  </span>
                </div>
                {lanes.map((lane, index) => (
                  <div key={`lane-${index}`} className="rsv-tl-row">
                    <div className="rsv-tl-label">
                      {index === 0 && (
                        <>
                          <strong>No table</strong>
                          <span>to assign</span>
                        </>
                      )}
                    </div>
                    <div className="rsv-tl-track">{lane.items.map(renderBlock)}</div>
                  </div>
                ))}
              </>
            )}

            {groups.map((group) => (
              <Fragment key={group.key}>
                <div className="rsv-tl-group">
                  <span>
                    {group.floor}
                    {group.area ? ` · ${group.area}` : ""}
                    <em className="rsv-tl-group-count">
                      {group.tables.length} {group.tables.length === 1 ? "table" : "tables"}
                    </em>
                  </span>
                </div>
                {group.tables.map((table) => {
                  const inUse = occupancy.find((block) => block.table.id === table.id);
                  // A closed floor or section takes no new booking (the server
                  // refuses it); bookings already on it stay, flagged on their
                  // cards for the host to move.
                  const open = table.inService !== false;
                  const rowBookable = bookable && open;

                  return (
                    <div key={table.id} className={`rsv-tl-row ${open ? "" : "is-closed-table"}`}>
                      <div className="rsv-tl-label">
                        <strong>
                          {table.tableNo}
                          {isToday && table.live && <span className="rsv-dot" title="In use now" />}
                        </strong>
                        {open ? (
                          <span>{table.capacity} seats</span>
                        ) : (
                          <span className="rsv-tl-closed-tag">
                            {table.outOfServiceReason === "area" ? "Section closed" : "Floor closed"}
                          </span>
                        )}
                      </div>
                      <div
                        className={`rsv-tl-track ${rowBookable ? "is-bookable" : ""}`}
                        onClick={(event) => (rowBookable ? trackClick(event, table.id) : undefined)}
                        title={rowBookable ? `Book table ${table.tableNo}` : open ? undefined : "Closed right now: no new bookings"}
                      >
                        {inUse && (
                          <span
                            className="rsv-block rsv-tone-walkin is-static"
                            style={place(inUse.start ?? rangeStart, inUse.end - (inUse.start ?? rangeStart))}
                            title={`In use · ${table.live.orderNumber}${
                              table.live.guestCount ? ` · ${table.live.guestCount} guests` : ""
                            }`}
                          >
                            <span className="rsv-block-name">
                              {table.live.customerName || "Walk-in"}
                            </span>
                            <span className="rsv-block-meta">
                              {table.live.orderNumber} · {waitText(minutesSince(table.live.placedAt, now))}
                            </span>
                          </span>
                        )}
                        {bookings
                          .filter((booking) => holdsTable(booking, table.id))
                          .map((booking) => renderBlock(booking, table.id))}
                      </div>
                    </div>
                  );
                })}
              </Fragment>
            ))}

            <div className="rsv-tl-cols" aria-hidden="true">
              {Array.from({ length: slots }, (_, index) => (
                <span key={index} className={(rangeStart + index * SLOT) % 60 === 0 ? "is-hour" : ""} />
              ))}
            </div>

            {shut.map((band) => (
              <div
                key={band.from}
                className="rsv-tl-shut"
                style={{ "--x": (band.from - rangeStart) / SLOT, "--w": (band.to - band.from) / SLOT }}
                aria-hidden="true"
              />
            ))}

            {closedDay && (
              <div className="rsv-tl-closed">
                <div className="rsv-tl-closed-card" role="note">
                  <Glyph name="calendar" size={20} />
                  <div>
                    <strong>Closed on {WEEKDAY_NAMES[hours.dayOfWeek]}s</strong>
                    <p className="muted small">
                      No bookings are taken for this day. Opening hours are set under Settings → Business
                      hours.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {nowX !== null && nowX >= 0 && nowX <= slots && (
              <>
                <div className="rsv-tl-past" style={{ "--x": nowX }} aria-hidden="true" />
                <div className="rsv-tl-now" style={{ "--x": nowX }} aria-hidden="true">
                  <span>{timeLabel(nowMinutes)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
