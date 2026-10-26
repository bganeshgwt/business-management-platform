import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { getErrorMessage } from "../../../../services/api";
import { acceptReservation, cancelReservation, completeReservation, confirmReservation, declineReservation, getReservationBoard, markReservationNoShow, markWaitlistLeft, notifyWaitlistEntry, removeWaitlistEntry, seatReservation, seatWaitlistEntry } from "../services/reservation.service";
import { OnlineBookingDialog, OnlineRequestsPanel } from "./OnlineBooking";
import "../../../../styles/reservations.css";
import "./onlineBooking.css";
import { clockIn, liveState, minutesSince, timeLabel } from "./reservationFormat";
import ArrivingNext from "./ArrivingNext";
import { Glyph } from "./ReservationChips";
import DateBar from "./DateBar";
import SummaryTiles from "./SummaryTiles";
import Attention from "./Attention";
import Timeline from "./Timeline";
import Agenda from "./Agenda";
import WaitlistPanel from "./WaitlistPanel";
import BookingEditor from "./BookingEditor";
import { AcceptDialog, CancelDialog, DeclineDialog, SeatDialog } from "./BookingDialogs";
import WalkInEditor from "./WalkInEditor";
import BookingDetail from "./BookingDetail";

// ---------------------------------------------------------------- page

export default function ReservationsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("reservations.manage");
  const canOrder = hasPermission("orders.create");
  const canSeat = canManage && canOrder;
  // Opening the online channel and its limits is a manager's decision; the
  // host stand answers the requests (reservations.manage).
  const canSetOnline = hasPermission("reservations.online");

  const [dateParam, setDateParam] = useQueryFilter("date");
  // A phone opens on the agenda: the timeline is a wide grid made for a desk.
  const [view, setView] = useQueryFilter(
    "view",
    typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 640px)").matches ? "agenda" : "timeline"
  );
  const [show, setShow] = useQueryFilter("show", "all");
  const [bookingParam, setBookingParam] = useQueryFilter("booking");

  const [board, setBoard] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const [detailVersion, setDetailVersion] = useState(0);

  const [editor, setEditor] = useState(null);
  const [seating, setSeating] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [walkIn, setWalkIn] = useState(null);
  const [answering, setAnswering] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [onlineOpen, setOnlineOpen] = useState(false);

  const fetchBoard = useCallback(
    () =>
      getReservationBoard(dateParam || undefined)
        .then((data) => {
          setBoard(data);
          setLoadError("");
        })
        .catch((err) => setLoadError(getErrorMessage(err))),
    [dateParam]
  );

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  // The host stand is left open all service: a booking made, a guest seated
  // or a table freed on another device shows within a second (live updates).
  // As a safety net the book also reads itself every minute while the tab is
  // visible, and catches up the moment someone looks at it again.
  const live = useLiveRefresh({ restaurant: true }, ["reservation", "waitlist", "table"], fetchBoard);

  // Waiting times and "12 min late" age by the minute.
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice || notice.tone === "error") {
      return undefined;
    }

    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const refresh = () => {
    setRefreshing(true);
    fetchBoard().finally(() => setRefreshing(false));
  };

  // Every action ends the same way: say what happened, reload the book. A
  // dialog that asked for the action shows a refusal itself (`quiet`), since
  // the page's own message would be hidden behind it.
  const run = async (action, { link, quiet } = {}) => {
    try {
      const result = await action();
      setNotice({ tone: "success", text: result.message, link: link ? link(result) : null });
      setDetailVersion((version) => version + 1);
      fetchBoard();
      return { ok: true, result };
    } catch (err) {
      const message = getErrorMessage(err);

      if (!quiet) {
        setNotice({ tone: "error", text: message });
      }

      return { ok: false, message };
    }
  };

  if (!board) {
    return (
      <div className="stack">
        <PageHeader
          icon="calendar"
          title="Reservations"
          description="Bookings, the floor timeline and the walk-in waitlist, live."
        />
        {loadError ? <ErrorMessage message={loadError} /> : <Loading label="Opening the book…" />}
      </div>
    );
  }

  const clock = clockIn(board.timezone, tick);
  const today = clock.date;
  const date = dateParam || board.date;
  const isToday = date === today;
  const isPast = date < today;
  const stale = board.date !== date;
  const lateAfter = board.lateAfterMinutes || 15;

  const openBooking = (booking) => setBookingParam(String(booking.id));
  const goTo = (next) => setDateParam(next === today ? "" : next);

  const handlers = {
    open: openBooking,
    edit: (booking) => setEditor({ booking }),
    confirm: (booking, quiet) => run(() => confirmReservation(booking.id), { quiet }),
    seat: (booking) => setSeating({ kind: "booking", item: booking }),
    noShow: (booking, quiet) => run(() => markReservationNoShow(booking.id), { quiet }),
    cancel: (booking) => setCancelling(booking),
    complete: (booking, quiet) => run(() => completeReservation(booking.id), { quiet }),
    accept: (booking) => setAnswering(booking),
    decline: (booking) => setDeclining(booking),
  };

  const waitHandlers = {
    seat: (entry) => setSeating({ kind: "walkin", item: entry }),
    notify: (entry) => run(() => notifyWaitlistEntry(entry.id)),
    left: (entry) => run(() => markWaitlistLeft(entry.id)),
    remove: (entry) => run(() => removeWaitlistEntry(entry.id)),
    edit: (entry) => setWalkIn({ entry }),
  };

  const liveKey = (booking) => (isToday ? liveState(booking, clock, true, lateAfter)?.key : null);
  const late = board.bookings.filter((booking) => liveKey(booking) === "late");
  const missed = board.bookings.filter((booking) => liveKey(booking) === "missed");
  const overdue = board.waitlist.waiting.filter(
    (entry) => minutesSince(entry.joinedAt, tick) > entry.quotedMinutes
  );

  // End-of-service tidying: every booking whose slot went by with nobody
  // seated, marked in one go. One at a time, so each is audited like a
  // single click and a refusal (someone seated one meanwhile) stops nothing.
  const markAllNoShow = async (list) => {
    let marked = 0;
    const refused = [];

    for (const booking of list) {
      try {
        await markReservationNoShow(booking.id);
        marked += 1;
      } catch (err) {
        refused.push(`${booking.guestName}: ${getErrorMessage(err)}`);
      }
    }

    setNotice(
      refused.length > 0
        ? { tone: "error", text: `${marked} marked as no-shows. Not marked — ${refused.join("; ")}` }
        : { tone: "success", text: `${marked} ${marked === 1 ? "booking" : "bookings"} marked as no-shows` }
    );
    setDetailVersion((version) => version + 1);
    fetchBoard();
  };

  return (
    <div className="stack rsv-page">
      <PageHeader
        icon="calendar"
        title="Reservations"
        description="Bookings, the floor timeline and the walk-in waitlist, live."
        action={
          <div className="header-actions rsv-header-actions">
            <button
              type="button"
              className="button button-secondary live-badge"
              onClick={refresh}
              disabled={refreshing}
              data-live={live}
              title={live === "live" ? "Bookings change here by themselves. Refresh now." : "Live updates are reconnecting; the book still reads itself every minute. Refresh now."}
            >
              <span className={`live-dot ${refreshing ? "is-busy" : ""}`} aria-hidden="true" />
              {live === "live" ? "Live" : live === "reconnecting" ? "Reconnecting" : live === "off" ? "Not live" : "Connecting"} · {timeLabel(clock.minutes)}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setOnlineOpen(true)}
              title="The link guests book a table from"
            >
              <Glyph name="link" /> Online booking
            </button>
            {canManage && (
              <>
                <button type="button" className="button button-secondary" onClick={() => setWalkIn({})}>
                  <Glyph name="door" /> Add walk-in
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => setEditor({ prefill: { date: isPast ? today : date } })}
                >
                  <Glyph name="plus" /> New booking
                </button>
              </>
            )}
          </div>
        }
      />

      {notice && (
        <div className={`alert ${notice.tone === "success" ? "alert-success" : ""} rsv-notice`} role="status">
          <span>{notice.text}</span>
          {notice.link && canOrder && (
            <Link className="rsv-notice-link" to={notice.link}>
              Open in POS
            </Link>
          )}
          <button type="button" className="rsv-notice-close" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Glyph name="x" size={14} />
          </button>
        </div>
      )}

      {loadError && (
        <div className="alert">Could not refresh just now — showing the book as it was. {loadError}</div>
      )}

      <DateBar
        date={date}
        today={today}
        outlook={board.outlook}
        hours={stale ? null : board.hours}
        view={view}
        setView={setView}
        goTo={goTo}
        onFind={(booking) => {
          goTo(booking.date);
          setBookingParam(String(booking.id));
        }}
      />

      <SummaryTiles board={board} isToday={isToday} stale={stale} />

      {isToday && !stale && (late.length > 0 || missed.length > 0 || overdue.length > 0) && (
        <Attention
          late={late}
          missed={missed}
          overdue={overdue}
          now={tick}
          onOpen={openBooking}
          onMarkMissed={canManage ? () => markAllNoShow(missed) : null}
        />
      )}

      {isToday && !stale && (
        <ArrivingNext
          board={board}
          clock={clock}
          lateAfter={lateAfter}
          canSeat={canSeat}
          canManage={canManage}
          handlers={handlers}
        />
      )}

      <OnlineRequestsPanel
        requests={board.requests || []}
        today={today}
        nowMs={tick}
        canManage={canManage}
        onOpen={(booking) => {
          goTo(booking.date);
          setBookingParam(String(booking.id));
        }}
        onAccept={handlers.accept}
        onDecline={handlers.decline}
        onSettings={() => setOnlineOpen(true)}
      />

      <WaitlistPanel
        waitlist={board.waitlist}
        timezone={board.timezone}
        now={tick}
        canManage={canManage}
        canSeat={canSeat}
        handlers={waitHandlers}
        onAdd={() => setWalkIn({})}
      />

      <section className={`card rsv-board ${stale ? "rsv-stale" : ""}`} aria-busy={stale}>
          {view === "agenda" ? (
            <Agenda
              board={board}
              clock={clock}
              isToday={isToday}
              isPast={isPast}
              lateAfter={lateAfter}
              show={show}
              setShow={setShow}
              canManage={canManage}
              canSeat={canSeat}
              canOrder={canOrder}
              handlers={handlers}
              onNew={() => setEditor({ prefill: { date } })}
            />
          ) : (
            <Timeline
              board={board}
              clock={clock}
              now={tick}
              isToday={isToday}
              lateAfter={lateAfter}
              canBook={canManage && !isPast}
              onOpen={openBooking}
              onBookAt={(slot) => setEditor({ prefill: { date, ...slot } })}
            />
          )}
      </section>

      {bookingParam && (
        <BookingDetail
          id={Number(bookingParam)}
          version={detailVersion}
          clock={clock}
          lateAfter={lateAfter}
          canManage={canManage}
          canSeat={canSeat}
          canOrder={canOrder}
          handlers={handlers}
          onClose={() => setBookingParam("")}
        />
      )}

      {editor && (
        <BookingEditor
          booking={editor.booking || null}
          prefill={editor.prefill || {}}
          board={board}
          today={today}
          clock={clock}
          onClose={() => setEditor(null)}
          onSaved={(result) => {
            setEditor(null);
            setNotice({ tone: "success", text: result.message });
            setDetailVersion((version) => version + 1);
            if (result.data.date !== date) {
              goTo(result.data.date);
            } else {
              fetchBoard();
            }
          }}
        />
      )}

      {seating && (
        <SeatDialog
          target={seating}
          onClose={() => setSeating(null)}
          onSeat={(payload) =>
            run(
              () =>
                seating.kind === "booking"
                  ? seatReservation(seating.item.id, payload)
                  : seatWaitlistEntry(seating.item.id, payload),
              { link: (result) => `/pos?order=${result.data.order.id}`, quiet: true }
            ).then((outcome) => {
              if (outcome.ok) {
                setSeating(null);
              }
              return outcome;
            })
          }
        />
      )}

      {cancelling && (
        <CancelDialog
          booking={cancelling}
          onClose={() => setCancelling(null)}
          onConfirm={(reason) =>
            run(() => cancelReservation(cancelling.id, reason), { quiet: true }).then((outcome) => {
              if (outcome.ok) {
                setCancelling(null);
              }
              return outcome;
            })
          }
        />
      )}

      {answering && (
        <AcceptDialog
          booking={answering}
          onClose={() => setAnswering(null)}
          onAccept={(payload) =>
            run(() => acceptReservation(answering.id, payload), { quiet: true }).then((outcome) => {
              if (outcome.ok) {
                setAnswering(null);
              }
              return outcome;
            })
          }
        />
      )}

      {declining && (
        <DeclineDialog
          booking={declining}
          onClose={() => setDeclining(null)}
          onConfirm={(reason) =>
            run(() => declineReservation(declining.id, reason), { quiet: true }).then((outcome) => {
              if (outcome.ok) {
                setDeclining(null);
              }
              return outcome;
            })
          }
        />
      )}

      {onlineOpen && (
        <OnlineBookingDialog
          canEdit={canSetOnline}
          onClose={() => setOnlineOpen(false)}
          onSaved={(message) => {
            setNotice({ tone: "success", text: message });
            fetchBoard();
          }}
        />
      )}

      {walkIn && (
        <WalkInEditor
          entry={walkIn.entry || null}
          onClose={() => setWalkIn(null)}
          onSaved={(result) => {
            setWalkIn(null);
            setNotice({ tone: "success", text: result.message });
            fetchBoard();
          }}
        />
      )}
    </div>
  );
}
