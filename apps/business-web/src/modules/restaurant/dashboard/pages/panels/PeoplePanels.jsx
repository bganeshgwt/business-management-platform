import { useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../../components/DataGrid/DataGrid";
import {
  getReservationBoard,
  markReservationNoShow,
  seatReservation,
} from "../../../reservations/services/reservation.service";
import { getErrorMessage } from "../../../../../services/api";
import { toast } from "../../../../../services/toast";
import useConfirm from "../../../../../hooks/useConfirm";
import { getBoard as getTimeclockBoard } from "../../../staff/services/timeclock.service";
import { count } from "@bmp/shared/format";
import { plural } from "../../../reports/pages/reportFormat";
import { clock12, clockTime, toMinutes, waitText } from "../liveFormat";
import { PanelFacts, PanelMessage } from "./panelKit";
import { errorText, refreshDashboard, usePanelQuery } from "./panelData";

const badge = (label, tone) => (
  <span className={`badge badge-${tone} status-badge`}>
    <span className="badge-dot" aria-hidden="true" />
    {label}
  </span>
);

// ------------------------------------------------------------------ reservations

const BOOKING = {
  requested: ["Requested", "info"],
  booked: ["Booked", "neutral"],
  confirmed: ["Confirmed", "info"],
  seated: ["Seated", "success"],
  completed: ["Done", "neutral"],
  cancelled: ["Cancelled", "neutral"],
  no_show: ["No-show", "danger"],
  declined: ["Declined", "neutral"],
};


// Today's book, by the same rule as the Reservations card: a booking still
// booked or confirmed is late from `lateAfterMinutes` past its time until its
// slot is over (then it is "gone by, not marked").
export function ReservationsPanel({ ctx, view }) {
  const hasPermission = ctx ? ctx.hasPermission : () => false;
  const navigate = useNavigate();
  const query = usePanelQuery("reservations", null, () => getReservationBoard());
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const confirm = useConfirm();
  const canSeat = hasPermission("reservations.manage") && hasPermission("orders.create");
  const canMark = hasPermission("reservations.manage");
  const board = query.data || null;

  const seat = async (booking) => {
    setBusy(booking.id);
    setMessage(null);

    try {
      const result = await seatReservation(booking.id, {});
      await refreshDashboard();
      const order = result.data && result.data.order;

      if (order && order.id) {
        navigate(`/pos?order=${order.id}`);
      } else {
        toast.success(result.message || "Seated.");
      }
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const markNoShow = async (booking) => {
    const sure = await confirm({
      title: `${booking.guestName || "The guest"} did not come?`,
      message: "The booking is marked as a no-show and its table is free for walk-ins.",
      confirmLabel: "Mark no-show",
      cancelLabel: "Keep the booking",
    });

    if (!sure) {
      return;
    }

    setBusy(booking.id);
    setMessage(null);

    try {
      await markReservationNoShow(booking.id);
      toast.success(`${booking.guestName || "The booking"} marked as a no-show; the table is free.`);
      await refreshDashboard();
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  // A number to call, only when it is the whole number (staff without the
  // guests' contacts see it masked).
  const phoneOf = (booking) => {
    const digits = String(booking.guestMobile || "").replace(/\D/g, "");
    return digits.length >= 10 && !/x/i.test(booking.guestMobile) ? digits : null;
  };
  const waitingStatus = (booking) => ["booked", "confirmed"].includes(booking.status);
  const pastBy = (booking) => (board ? board.nowMinutes - toMinutes(booking.startTime) : 0);
  const isLate = (booking) =>
    Boolean(board && board.isToday) &&
    waitingStatus(booking) &&
    pastBy(booking) >= board.lateAfterMinutes &&
    pastBy(booking) < Number(booking.durationMinutes || 0);
  const isMissed = (booking) =>
    Boolean(board && board.isToday) && waitingStatus(booking) && pastBy(booking) >= Number(booking.durationMinutes || 0);
  const bookings = board ? board.bookings : [];
  const rows =
    view === "arriving" ? bookings.filter(waitingStatus) : view === "all" ? bookings : bookings.filter(isLate);
  const summary = board ? board.summary : null;

  return (
    <>
      <PanelMessage message={message && message.text} tone={message && message.tone} onDismiss={() => setMessage(null)} />
      {summary && (
        <PanelFacts
          items={[
            { label: "Bookings", value: count(summary.bookings) },
            { label: "Still to arrive", value: count(summary.toArrive) },
            { label: "Running late", value: count(summary.late), tone: summary.late > 0 ? "warning" : null },
            summary.missed > 0 && { label: "Gone by, not marked", value: count(summary.missed), tone: "warning" },
            { label: "Seated", value: count(summary.seated) },
          ]}
        />
      )}
      <DataGrid
        id={`dash-panel-bookings-${view || "late"}`}
        caption="Today's bookings"
        variant="compact"
        columns={[
          {
            key: "guest",
            header: "Guest",
            value: (booking) => booking.guestName || booking.customerName || "",
            mobile: "title",
            render: (booking) => (
              <span className="panel-cell-stack">
                <strong>{booking.guestName || booking.customerName || "Guest"}</strong>
                {booking.guestMobile && <span className="muted">{booking.guestMobile}</span>}
              </span>
            ),
          },
          { key: "time", header: "Time", value: (booking) => booking.startTime, render: (booking) => clock12(String(booking.startTime || "").slice(0, 5)), mobile: "subtitle" },
          { key: "party", header: "Guests", type: "number", value: (booking) => booking.partySize, mobile: "show" },
          { key: "table", header: "Table", value: (booking) => booking.tableNo || "", mobile: "show" },
          {
            key: "status",
            header: "Status",
            value: (booking) => booking.status,
            render: (booking) =>
              isLate(booking)
                ? badge(`Late ${waitText(pastBy(booking))}`, "warning")
                : isMissed(booking)
                  ? badge("Gone by, not marked", "danger")
                  : badge(...(BOOKING[booking.status] || [booking.status, "neutral"])),
            mobile: "show",
          },
          { key: "note", header: "Note", value: (booking) => booking.specialRequests || booking.occasion || "", defaultHidden: true },
          {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (booking) =>
              waitingStatus(booking) ? (
                <span className="panel-row-actions">
                  {canSeat && (
                    <button type="button" className="button button-sm" disabled={busy === booking.id} onClick={() => seat(booking)}>
                      Seat
                    </button>
                  )}
                  {phoneOf(booking) && (
                    <a className="button button-sm button-secondary" href={`tel:${phoneOf(booking)}`}>
                      Call
                    </a>
                  )}
                  {canMark && (isLate(booking) || isMissed(booking)) && (
                    <button
                      type="button"
                      className="button button-sm button-secondary"
                      disabled={busy === booking.id}
                      onClick={() => markNoShow(booking)}
                    >
                      No-show
                    </button>
                  )}
                </span>
              ) : null,
          },
        ]}
        rows={rows}
        rowKey={(booking) => booking.id}
        rowClassName={(booking) => (isLate(booking) ? "dg-tone-warning" : isMissed(booking) ? "dg-tone-danger" : "")}
        defaultSort={{ key: "time", direction: "asc" }}
        loading={!board && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty={view === "late" || !view ? "No booking is running late" : "No bookings for today"}
        emptyIcon="calendar"
        rowNoun={["booking", "bookings"]}
        search={false}
      />
    </>
  );
}

// ------------------------------------------------------------------ staff

const PERSON = {
  on_duty: ["On duty", "success"],
  on_break: ["On a break", "info"],
  late: ["Late", "warning"],
  expected: ["Expected", "neutral"],
  absent: ["Absent", "danger"],
  left: ["Left", "neutral"],
  off: ["Off today", "neutral"],
};


// Who is working, from the time clock (the whole restaurant: the clock is not
// kept per outlet). Late: rostered, past the start of the shift and its
// grace, and not clocked in. A clock-out never made: a session still open
// long after it should have ended.
export function StaffPanel({ ctx, view }) {
  const query = usePanelQuery("timeclock", null, () => getTimeclockBoard());
  const board = query.data || null;
  const zone = board ? board.timezone : undefined;
  const missed = board ? board.missedClockOuts || [] : [];
  const people = board ? board.staff : [];
  const rows =
    view === "duty"
      ? people.filter((one) => one.status === "on_duty" || one.status === "on_break")
      : view === "expected"
        ? people.filter((one) => one.status === "expected")
        : people.filter((one) => one.status === "late");

  return (
    <>
      {board && (
        <PanelFacts
          items={[
            { label: "On duty", value: count(board.counts.onDuty) },
            { label: "Late", value: count(board.counts.late), tone: board.counts.late > 0 ? "warning" : null },
            { label: "Expected", value: count(board.counts.expected) },
            { label: "Clock-outs not made", value: count(missed.length), tone: missed.length > 0 ? "warning" : null },
          ]}
        />
      )}
      {ctx.wholeRestaurant && <p className="panel-note">The time clock is kept for the whole restaurant, not per outlet.</p>}
      {view === "missed" ? (
        <DataGrid
          id="dash-panel-staff-missed"
          caption="Clock-outs never made"
          variant="compact"
          columns={[
            { key: "name", header: "Person", value: (row) => row.employeeName, mobile: "title" },
            { key: "day", header: "Work day", type: "date", value: (row) => row.workDate, mobile: "subtitle" },
            {
              key: "in",
              header: "Clocked in",
              value: (row) => row.checkIn || row.since,
              render: (row) => clockTime(row.checkIn || row.since, zone),
              mobile: "show",
            },
            {
              key: "open",
              header: "Open for",
              value: (row) => Number(row.hoursOpen || 0),
              render: (row) => plural(Math.round(Number(row.hoursOpen || 0)), "hour", "hours"),
              align: "right",
              mobile: "show",
            },
          ]}
          rows={missed}
          rowKey={(row) => row.attendanceId}
          loading={!board && query.isLoading}
          error={errorText(query)}
          onRetry={() => query.refetch()}
          empty="Every session has been clocked out"
          emptyIcon="check-circle"
          rowNoun={["session", "sessions"]}
          search={false}
        />
      ) : (
        <DataGrid
          id={`dash-panel-staff-${view || "late"}`}
          caption="Staff"
          variant="compact"
          columns={[
            {
              key: "name",
              header: "Person",
              value: (one) => one.name,
              mobile: "title",
              render: (one) => (
                <span className="panel-cell-stack">
                  <strong>{one.name}</strong>
                  <span className="muted">{one.designation || one.department || ""}</span>
                </span>
              ),
            },
            {
              key: "shift",
              header: "Shift",
              value: (one) => (one.shift ? one.shift.startsAt : null),
              render: (one) =>
                one.shift ? `${clockTime(one.shift.startsAt, zone)} – ${clockTime(one.shift.endsAt, zone)}` : "—",
              mobile: "subtitle",
            },
            {
              key: "status",
              header: "Status",
              value: (one) => one.status,
              render: (one) =>
                one.status === "late" && one.lateByMinutes
                  ? badge(`Late ${waitText(one.lateByMinutes)}`, "warning")
                  : badge(...(PERSON[one.status] || [one.status, "neutral"])),
              mobile: "show",
            },
            {
              key: "since",
              header: "In since",
              value: (one) => (one.session ? one.session.since || one.session.checkIn : null),
              render: (one) => (one.session && (one.session.since || one.session.checkIn) ? clockTime(one.session.since || one.session.checkIn, zone) : "—"),
              defaultHidden: view !== "duty",
            },
          ]}
          rows={rows}
          rowKey={(one) => one.id}
          rowClassName={(one) => (one.status === "late" ? "dg-tone-warning" : "")}
          loading={!board && query.isLoading}
          error={errorText(query)}
          onRetry={() => query.refetch()}
          empty={view === "duty" ? "Nobody is clocked in" : view === "expected" ? "Nobody else is expected" : "Nobody is late"}
          emptyIcon="users"
          rowNoun={["person", "people"]}
          search={false}
        />
      )}
    </>
  );
}
