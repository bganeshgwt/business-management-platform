// A guest booking a table online (SW-A-21). Public, no login:
//   /book/:token                 the restaurant's (or outlet's) booking link
//   /book/status/:guestToken     the guest's own booking, its answer and a way to cancel
//
// Phone-first. A guest picks how many, the day and a time, leaves a name and
// a mobile, and sends a request; the restaurant answers it and the status page
// shows the answer. Tables are never shown — the restaurant gives the table.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import {
  bookingErrorMessage,
  cancelMyBooking,
  getBookingPage,
  getBookingTimes,
  getMyBooking,
  mineFor,
  rememberMine,
  requestBooking,
} from "../services/booking.service";
import "../styles/booking.css";

const OCCASIONS = [
  { value: "", label: "Just dinner" },
  { value: "birthday", label: "Birthday" },
  { value: "anniversary", label: "Anniversary" },
  { value: "date_night", label: "Date night" },
  { value: "business", label: "Business" },
  { value: "other", label: "Celebration" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parts = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  return { weekday: WEEKDAYS[at.getUTCDay()], day, month: MONTHS[month - 1] };
};

const longDate = (date) => {
  const { weekday, day, month } = parts(date);
  return `${weekday}, ${day} ${month}`;
};

const initials = (name) =>
  String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");

const telOf = (contact) => (contact ? `tel:${String(contact).replace(/[^\d+]/g, "")}` : null);

export default function BookingPage() {
  return (
    <div className="guest-booking">
      <Routes>
        <Route path="status/:guestToken" element={<BookingStatus />} />
        <Route path=":token" element={<BookingForm />} />
        <Route path="*" element={<Gone message="This booking link is not complete. Please check it, or contact the restaurant." />} />
      </Routes>
    </div>
  );
}

function TopBar({ place }) {
  return (
    <header className="gb-top">
      <div className="gb-top-inner">
        <span className="gb-mono" aria-hidden="true">
          {initials(place?.name) || <Icon name="utensils" size={18} />}
        </span>
        <span className="gb-top-title">
          <strong>{place?.name || "Book a table"}</strong>
          {place?.outletName && <span>{place.outletName}</span>}
        </span>
        {telOf(place?.contact) && (
          <a className="gb-call" href={telOf(place.contact)} aria-label={`Call ${place.name}`}>
            <Icon name="phone" size={16} /> <span>Call</span>
          </a>
        )}
      </div>
    </header>
  );
}

function Gone({ message, place }) {
  return (
    <>
      <TopBar place={place} />
      <main className="gb-shell">
        <section className="gb-card gb-center gb-gone">
          <span className="gb-gone-mark" aria-hidden="true">
            <Icon name="calendar" size={28} />
          </span>
          <h1>Online booking unavailable</h1>
          <p>{message}</p>
          {telOf(place?.contact) && (
            <a className="gb-button" href={telOf(place.contact)}>
              <Icon name="phone" size={17} /> Call {place.contact}
            </a>
          )}
        </section>
      </main>
    </>
  );
}

// ------------------------------------------------------------------ the form

function BookingForm() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(null);
  const [pageError, setPageError] = useState("");
  const [party, setParty] = useState(2);
  const [date, setDate] = useState("");
  const [times, setTimes] = useState(null);
  const [timesError, setTimesError] = useState("");
  const [time, setTime] = useState("");
  const [form, setForm] = useState({ guestName: "", guestMobile: "", occasion: "", notes: "", website: "" });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const stripRef = useRef(null);

  useEffect(() => {
    getBookingPage(token)
      .then((data) => {
        setPage(data);
        setDate(data.days.find((day) => day.open)?.date || data.today);
        setParty((current) => Math.min(current, data.maxPartySize));
      })
      .catch((err) => setPageError(bookingErrorMessage(err)));
  }, [token]);

  const day = page?.days.find((item) => item.date === date) || null;

  const loadTimes = useCallback(() => {
    if (!page || !page.enabled || !date || !day || !day.open) {
      return Promise.resolve();
    }

    return getBookingTimes(token, date, party)
      .then((data) => {
        setTimes(data);
        setTimesError("");
        // A time chosen before stays chosen only while it is still free.
        setTime((current) => (data.slots.some((slot) => slot.time === current && slot.available) ? current : ""));
      })
      .catch((err) => {
        setTimes(null);
        setTimesError(bookingErrorMessage(err));
      });
  }, [token, page, date, day, party]);

  useEffect(() => {
    loadTimes();
  }, [loadTimes]);

  const mine = useMemo(() => (page ? mineFor(token) : []), [page, token]);

  if (pageError) {
    return <Gone message={pageError} />;
  }

  if (!page) {
    return (
      <>
        <TopBar />
        <main className="gb-shell">
          <div className="gb-card gb-loading" role="status">
            <span className="gb-spinner" aria-hidden="true" /> Opening the booking page…
          </div>
        </main>
      </>
    );
  }

  if (!page.enabled) {
    return <Gone message={page.message} place={page.place} />;
  }

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const meals = [];

  for (const slot of times?.slots || []) {
    let meal = meals.find((item) => item.name === slot.meal);

    if (!meal) {
      meal = { name: slot.meal, slots: [] };
      meals.push(meal);
    }

    meal.slots.push(slot);
  }

  const chosenSlot = times?.slots.find((slot) => slot.time === time);
  const ready = Boolean(chosenSlot && form.guestName.trim() && form.guestMobile.trim());

  const submit = async (event) => {
    event.preventDefault();

    if (!chosenSlot) {
      setSendError("Please pick a time.");
      return;
    }

    setSending(true);
    setSendError("");

    try {
      const result = await requestBooking(token, {
        date,
        time,
        partySize: party,
        guestName: form.guestName,
        guestMobile: form.guestMobile,
        occasion: form.occasion || null,
        notes: form.notes || null,
        website: form.website,
      });

      rememberMine(token, result.data.guestToken);
      navigate(`/book/status/${result.data.guestToken}`, { replace: false, state: { justSent: true } });
    } catch (err) {
      setSendError(bookingErrorMessage(err));
      // The time may have just filled: show the times as they are now.
      loadTimes();
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <TopBar place={page.place} />
      <main className="gb-shell">
        <section className="gb-hero">
          <p className="gb-eyebrow">Table reservation</p>
          <h1>Book a table</h1>
          <p className="gb-hero-place">
            {page.place.name}
            {page.place.outletName ? ` · ${page.place.outletName}` : ""}
          </p>
          {page.place.address && (
            <p className="gb-hero-line">
              <Icon name="map-pin" size={15} /> {page.place.address}
            </p>
          )}
          {page.guestNote && (
            <p className="gb-hero-note">
              <Icon name="info" size={15} /> {page.guestNote}
            </p>
          )}
        </section>

        {mine.length > 0 && (
          <Link className="gb-mine" to={`/book/status/${mine[0]}`}>
            <Icon name="clipboard" size={16} /> See the booking you already asked for
            <Icon name="chevron-right" size={16} />
          </Link>
        )}

        <form className="gb-form" onSubmit={submit} noValidate>
          <section className="gb-card" aria-labelledby="gb-step-party">
            <h2 id="gb-step-party" className="gb-step">
              <span>1</span> How many guests?
            </h2>
            <div className="gb-party" role="radiogroup" aria-label="Number of guests">
              {Array.from({ length: page.maxPartySize }, (_, index) => index + 1).map((size) => (
                <button
                  key={size}
                  type="button"
                  role="radio"
                  aria-checked={party === size}
                  className={`gb-chip gb-party-chip ${party === size ? "is-on" : ""}`}
                  onClick={() => setParty(size)}
                >
                  {size}
                </button>
              ))}
            </div>
            <p className="gb-hint">
              More than {page.maxPartySize}?{" "}
              {telOf(page.place.contact) ? (
                <a href={telOf(page.place.contact)}>Call us on {page.place.contact}</a>
              ) : (
                "Please call the restaurant"
              )}{" "}
              and we will plan your table.
            </p>
          </section>

          <section className="gb-card" aria-labelledby="gb-step-day">
            <h2 id="gb-step-day" className="gb-step">
              <span>2</span> Which day?
            </h2>
            <div className="gb-days" ref={stripRef} role="radiogroup" aria-label="Day">
              {page.days.map((item, index) => {
                const { weekday, day: dayNo, month } = parts(item.date);

                return (
                  <button
                    key={item.date}
                    type="button"
                    role="radio"
                    aria-checked={date === item.date}
                    className={`gb-day ${date === item.date ? "is-on" : ""} ${item.open ? "" : "is-closed"}`}
                    onClick={() => setDate(item.date)}
                    title={item.reason || undefined}
                  >
                    <span className="gb-day-week">{index === 0 ? "Today" : index === 1 ? "Tmrw" : weekday}</span>
                    <strong>{dayNo}</strong>
                    <span className="gb-day-month">{item.open ? month : "Closed"}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="gb-card" aria-labelledby="gb-step-time" aria-live="polite">
            <h2 id="gb-step-time" className="gb-step">
              <span>3</span> What time?
            </h2>
            {day && !day.open ? (
              <p className="gb-refusal">
                <Icon name="alert-circle" size={17} /> {day.reason}
              </p>
            ) : timesError ? (
              <p className="gb-refusal">
                <Icon name="alert-circle" size={17} /> {timesError}
              </p>
            ) : !times ? (
              <p className="gb-hint gb-hint-row">
                <span className="gb-spinner" aria-hidden="true" /> Checking free times…
              </p>
            ) : times.reason && !times.slots.some((slot) => slot.available) ? (
              <p className="gb-refusal">
                <Icon name="alert-circle" size={17} /> {times.reason}
              </p>
            ) : (
              <>
                {meals.map((meal) => (
                  <div key={meal.name} className="gb-meal">
                    <p className="gb-meal-name">{meal.name}</p>
                    <div className="gb-times" role="radiogroup" aria-label={`${meal.name} times`}>
                      {meal.slots.map((slot) => (
                        <button
                          key={slot.time}
                          type="button"
                          role="radio"
                          aria-checked={time === slot.time}
                          disabled={!slot.available}
                          className={`gb-chip gb-time ${time === slot.time ? "is-on" : ""} ${slot.state === "full" ? "is-full" : ""}`}
                          onClick={() => setTime(slot.time)}
                          title={slot.state === "full" ? "Fully booked" : slot.state === "too_soon" ? "Too soon to book online" : undefined}
                        >
                          {slot.label}
                          {slot.state === "full" && <small>Full</small>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="gb-hint">
                  Greyed-out times are fully booked. Your table is planned for about{" "}
                  {page.durationMinutes} minutes.
                </p>
              </>
            )}
          </section>

          <section className="gb-card" aria-labelledby="gb-step-you">
            <h2 id="gb-step-you" className="gb-step">
              <span>4</span> Your details
            </h2>
            <div className="gb-fields">
              <label className="gb-field">
                <span>Your name</span>
                <input
                  value={form.guestName}
                  onChange={set("guestName")}
                  autoComplete="name"
                  maxLength={80}
                  required
                  placeholder="Your name"
                />
              </label>
              <label className="gb-field">
                <span>Mobile number</span>
                <input
                  value={form.guestMobile}
                  onChange={set("guestMobile")}
                  autoComplete="tel"
                  inputMode="tel"
                  maxLength={20}
                  required
                  placeholder="98765 43210"
                />
                <small>We call this number only about your booking.</small>
              </label>
              <div className="gb-field gb-field-wide">
                <span>Occasion</span>
                <div className="gb-occasions" role="radiogroup" aria-label="Occasion">
                  {OCCASIONS.map((item) => (
                    <button
                      key={item.value || "none"}
                      type="button"
                      role="radio"
                      aria-checked={form.occasion === item.value}
                      className={`gb-chip ${form.occasion === item.value ? "is-on" : ""}`}
                      onClick={() => setForm((current) => ({ ...current, occasion: item.value }))}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="gb-field gb-field-wide">
                <span>
                  Anything we should know? <em>optional</em>
                </span>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={set("notes")}
                  maxLength={300}
                  placeholder="A high chair, a quiet corner, a cake to bring out…"
                />
              </label>
              {/* Not for people: a form-filling bot fills it in and is refused. */}
              <label className="gb-trap" aria-hidden="true">
                Website
                <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
              </label>
            </div>
          </section>

          <div className="gb-submit">
            {sendError && (
              <p className="gb-refusal" role="alert">
                <Icon name="alert-circle" size={17} /> {sendError}
              </p>
            )}
            <button type="submit" className="gb-button gb-button-wide" disabled={!ready || sending}>
              {sending
                ? "Sending…"
                : chosenSlot
                  ? `Request a table for ${party} · ${longDate(date)}, ${chosenSlot.label}`
                  : "Pick a time to continue"}
            </button>
            <p className="gb-hint gb-center">
              This is a request: the restaurant confirms it, and you see their answer on the next page.
            </p>
          </div>
        </form>
      </main>
    </>
  );
}

// ------------------------------------------------------------------ the guest's booking

const STATUS_WORDS = {
  requested: { icon: "clock", title: "Request received", line: (b) => `${b.place.name} will confirm your table shortly. Keep this page — it updates by itself.` },
  booked: { icon: "check-circle", title: "Your table is confirmed", line: (b) => `See you on ${longDate(b.date)} at ${b.timeLabel}.` },
  confirmed: { icon: "check-circle", title: "Your table is confirmed", line: (b) => `See you on ${longDate(b.date)} at ${b.timeLabel}.` },
  seated: { icon: "utensils", title: "Enjoy your meal", line: () => "You have been seated." },
  completed: { icon: "heart", title: "Thank you for visiting", line: () => "We hope to see you again soon." },
  declined: { icon: "x-circle", title: "Sorry, we can't take this booking", line: () => "The restaurant could not offer this table." },
  cancelled: { icon: "x-circle", title: "Booking cancelled", line: () => "This booking is cancelled." },
  no_show: { icon: "x-circle", title: "We missed you", line: () => "This booking time has passed." },
};

function BookingStatus() {
  const { guestToken } = useParams();
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const load = useCallback(
    () =>
      getMyBooking(guestToken)
        .then((data) => {
          setBooking(data);
          setError("");
        })
        .catch((err) => setError(bookingErrorMessage(err))),
    [guestToken]
  );

  useEffect(() => {
    load();
  }, [load]);

  // While the restaurant has not answered, look again every 20 seconds, and
  // the moment the guest comes back to the tab.
  const waiting = booking?.status === "requested";

  useEffect(() => {
    if (!waiting) {
      return undefined;
    }

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        load();
      }
    }, 20000);
    const onVisible = () => document.visibilityState === "visible" && load();

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [waiting, load]);

  if (error && !booking) {
    return <Gone message={error} />;
  }

  if (!booking) {
    return (
      <>
        <TopBar />
        <main className="gb-shell">
          <div className="gb-card gb-loading" role="status">
            <span className="gb-spinner" aria-hidden="true" /> Finding your booking…
          </div>
        </main>
      </>
    );
  }

  const words = STATUS_WORDS[booking.status] || STATUS_WORDS.cancelled;

  const cancel = async () => {
    setBusy(true);
    setActionError("");

    try {
      const result = await cancelMyBooking(guestToken);
      setBooking({ ...result.data });
      setConfirming(false);
    } catch (err) {
      setActionError(bookingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar place={booking.place} />
      <main className="gb-shell gb-status-shell">
        <section className={`gb-status gb-tone-${booking.tone}`} aria-live="polite">
          <span className="gb-status-mark" aria-hidden="true">
            <Icon name={words.icon} size={30} />
          </span>
          {booking.statusLabel !== words.title && <p className="gb-status-chip">{booking.statusLabel}</p>}
          <h1>{words.title}</h1>
          <p>{words.line(booking)}</p>
          {booking.reason && (
            <p className="gb-status-reason">
              <strong>{booking.status === "declined" ? "The restaurant says:" : "Reason:"}</strong> {booking.reason}
            </p>
          )}
          {waiting && (
            <p className="gb-status-live">
              <span className="gb-pulse" aria-hidden="true" /> Waiting for the restaurant
            </p>
          )}
        </section>

        <section className="gb-card gb-ticket" aria-label="Your booking">
          <div className="gb-ticket-when">
            <span>{longDate(booking.date)}</span>
            <strong>{booking.timeLabel}</strong>
          </div>
          <dl className="gb-ticket-facts">
            <div>
              <dt>Guests</dt>
              <dd>{booking.partySize}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{booking.guestName}</dd>
            </div>
            <div>
              <dt>Mobile</dt>
              <dd>{booking.guestMobile}</dd>
            </div>
            <div>
              <dt>Booking ref.</dt>
              <dd className="gb-mono-text">{booking.reference}</dd>
            </div>
            {booking.occasion && (
              <div>
                <dt>Occasion</dt>
                <dd>{OCCASIONS.find((item) => item.value === booking.occasion)?.label || booking.occasion}</dd>
              </div>
            )}
            {booking.notes && (
              <div className="gb-ticket-wide">
                <dt>Your note</dt>
                <dd>{booking.notes}</dd>
              </div>
            )}
          </dl>
          <div className="gb-ticket-place">
            <strong>
              {booking.place.name}
              {booking.place.outletName ? ` · ${booking.place.outletName}` : ""}
            </strong>
            {booking.place.address && (
              <span>
                <Icon name="map-pin" size={14} /> {booking.place.address}
              </span>
            )}
          </div>
        </section>

        {actionError && (
          <p className="gb-refusal" role="alert">
            <Icon name="alert-circle" size={17} /> {actionError}
          </p>
        )}

        <div className="gb-actions">
          {telOf(booking.place.contact) && (
            <a className="gb-button gb-button-quiet" href={telOf(booking.place.contact)}>
              <Icon name="phone" size={16} /> Call {booking.place.contact}
            </a>
          )}
          {booking.bookAgain && (
            <Link className="gb-button gb-button-quiet" to={`/book/${booking.bookAgain}`}>
              <Icon name="calendar" size={16} /> Book another table
            </Link>
          )}
          {booking.canCancel && !confirming && (
            <button type="button" className="gb-button gb-button-danger-quiet" onClick={() => setConfirming(true)}>
              Cancel this booking
            </button>
          )}
        </div>

        {confirming && (
          <section className="gb-card gb-confirm" role="alertdialog" aria-labelledby="gb-confirm-title">
            <h2 id="gb-confirm-title">Cancel your booking?</h2>
            <p>
              {longDate(booking.date)} at {booking.timeLabel} for {booking.partySize}. The restaurant is told straight
              away and the table goes to someone else.
            </p>
            <div className="gb-actions">
              <button type="button" className="gb-button gb-button-quiet" onClick={() => setConfirming(false)} disabled={busy}>
                Keep it
              </button>
              <button type="button" className="gb-button gb-button-danger" onClick={cancel} disabled={busy}>
                {busy ? "Cancelling…" : "Yes, cancel"}
              </button>
            </div>
          </section>
        )}

        <p className="gb-hint gb-center">Bookmark this page to check your booking any time.</p>
      </main>
    </>
  );
}
