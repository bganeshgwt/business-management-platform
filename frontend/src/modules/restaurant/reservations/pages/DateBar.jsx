// The reservations date bar and booking search.

import { Fragment, useEffect, useRef, useState } from "react";
import { listReservations } from "../services/reservation.service";
import { addDays, longDate, relativeDay, shortDate, tablesLabel, timeLabel, toMinutes } from "./reservationFormat";
import { Glyph, StatusChip } from "./ReservationChips";

// ---------------------------------------------------------------- date bar

export default function DateBar({ date, today, outlook, hours, view, setView, goTo, onFind }) {
  const busiest = Math.max(1, ...(outlook || []).map((day) => day.covers));
  const weekRef = useRef(null);

  // On a phone the week scrolls sideways; keep the day being viewed centred.
  useEffect(() => {
    const strip = weekRef.current;
    const current = strip && strip.querySelector(".is-current");

    if (current && strip.scrollWidth > strip.clientWidth) {
      strip.scrollLeft = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
    }
  }, [date, outlook]);

  return (
    <div className="card rsv-datebar">
      <div className="rsv-datenav">
        <button type="button" className="rsv-navbtn" onClick={() => goTo(addDays(date, -1))} aria-label="Previous day">
          <Glyph name="left" />
        </button>
        <div className="rsv-datebox">
          <span className={`rsv-date-relative ${date === today ? "is-today" : ""}`}>{relativeDay(date, today)}</span>
          <strong className="rsv-date-long">{longDate(date)}</strong>
          {hours && (
            <span className="rsv-hours">
              <Glyph name="clock" size={12} />
              {hours.isOpen
                ? `Open ${timeLabel(hours.openMinutes)} – ${timeLabel(hours.closeMinutes)} · last booking ${timeLabel(hours.lastBookingMinutes)}`
                : "Closed this day"}
            </span>
          )}
        </div>
        <button type="button" className="rsv-navbtn" onClick={() => goTo(addDays(date, 1))} aria-label="Next day">
          <Glyph name="right" />
        </button>
        {date !== today && (
          <button type="button" className="button button-secondary rsv-today" onClick={() => goTo(today)}>
            Today
          </button>
        )}
        <label className="rsv-datepick">
          <span className="sr-only">Pick a date</span>
          <Glyph name="calendar" />
          <input type="date" value={date} onChange={(event) => event.target.value && goTo(event.target.value)} />
        </label>
      </div>

      <div className="rsv-datebar-side">
        <BookingSearch today={today} onPick={onFind} />
        <div className="segmented" role="radiogroup" aria-label="Book view">
          {[
            { key: "timeline", label: "Timeline" },
            { key: "agenda", label: "Agenda" },
          ].map((option) => (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={view === option.key}
              className={`segment ${view === option.key ? "is-active" : ""}`}
              onClick={() => setView(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {outlook && (
        <div className="rsv-week" ref={weekRef} role="list" aria-label="The week around this day">
          {outlook.map((day) => (
            <button
              key={day.date}
              type="button"
              role="listitem"
              className={`rsv-week-day ${day.date === date ? "is-current" : ""} ${day.date === today ? "is-today" : ""} ${
                day.isOpen ? "" : "is-closed"
              }`}
              onClick={() => goTo(day.date)}
              aria-current={day.date === date ? "date" : undefined}
            >
              <span className="rsv-week-name">{shortDate(day.date)}</span>
              {day.isOpen ? (
                <>
                  <strong>{day.covers}</strong>
                  <span className="rsv-week-note">
                    covers · {day.bookings} {day.bookings === 1 ? "booking" : "bookings"}
                  </span>
                  <span className="rsv-week-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round((day.covers / busiest) * 100)}%` }} />
                  </span>
                </>
              ) : (
                <span className="rsv-week-note">Closed</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// "I have a booking under Mehta" — found without knowing which day it is.
function BookingSearch({ today, onPick }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const query = text.trim();

  useEffect(() => {
    if (query.length < 2) {
      return undefined;
    }

    const timer = setTimeout(() => {
      listReservations({ search: query, from: addDays(today, -30), to: addDays(today, 180), limit: 8 })
        .then((data) => setResults({ query, ...data }))
        .catch(() => setResults({ query, items: [], total: 0 }));
    }, 250);

    return () => clearTimeout(timer);
  }, [query, today]);

  const shown = results && results.query === query ? results : null;
  // The server sends upcoming bookings first (soonest first), then the past
  // (latest first); they are shown under their own headings so tonight's
  // booking is never lost among a regular's old visits.
  const groups = shown
    ? [
        { key: "upcoming", label: "Today and upcoming", items: shown.items.filter((booking) => booking.date >= today) },
        { key: "earlier", label: "Earlier", items: shown.items.filter((booking) => booking.date < today) },
      ].filter((group) => group.items.length > 0)
    : [];

  const renderResult = (booking) => (
    <li key={booking.id}>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setText("");
          onPick(booking);
        }}
      >
        <span className="rsv-search-when">
          {booking.date === today ? "Today" : shortDate(booking.date)} · {timeLabel(toMinutes(booking.startTime))} ·{" "}
          {booking.reference}
        </span>
        <span className="rsv-search-who">
          <strong>{booking.guestName}</strong> · {booking.partySize} · {tablesLabel(booking) || "no table"}
        </span>
        <StatusChip status={booking.status} />
      </button>
    </li>
  );

  return (
    <div className="rsv-search">
      <Glyph name="search" size={15} />
      <input
        type="search"
        value={text}
        placeholder="Find a booking: name, mobile or R-number"
        aria-label="Find a booking"
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      />
      {open && query.length >= 2 && (
        <div className="rsv-search-results" onMouseDown={(event) => event.preventDefault()}>
          {!shown ? (
            <p className="muted small rsv-search-empty">Searching…</p>
          ) : shown.items.length === 0 ? (
            <p className="muted small rsv-search-empty">No booking matches “{query}” in the last 30 or next 180 days.</p>
          ) : (
            <ul>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <li className="rsv-search-group" aria-hidden="true">
                    {group.label}
                  </li>
                  {group.items.map(renderResult)}
                </Fragment>
              ))}
              {shown.total > shown.items.length && (
                <li className="muted small rsv-search-more">
                  {shown.total - shown.items.length} more, further ahead or further back — type the R-number to
                  find a particular one
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
