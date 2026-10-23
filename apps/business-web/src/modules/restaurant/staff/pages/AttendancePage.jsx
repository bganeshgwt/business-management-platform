import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import Modal from "../../../../components/Modal";
import {
  getAttendance,
  getLeaveRegister,
  listLeaveTypes,
  markRemaining,
  saveAttendance,
} from "../services/staff.service";
import { listOutlets } from "../../../../services/outlet.service";
import { getErrorMessage } from "../../../../services/api";
import { daysAgo, today } from "@bmp/shared/dates";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import MusterRoll from "./MusterRoll";
import "../../../../styles/access.css";
import "../../../../styles/staff.css";
import { hoursFromMinutes } from "./hoursText";
import "../styles/attendance.css";

const STATUSES = {
  present: "Present",
  absent: "Absent",
  half_day: "Half day",
  leave: "Leave",
  week_off: "Week off",
};

const asHours = hoursFromMinutes;

// The phone sheet's one-tap buttons: P / A / ½ / L / WO.
const QUICK = [
  { value: "present", short: "P", label: "Present" },
  { value: "absent", short: "A", label: "Absent" },
  { value: "half_day", short: "½", label: "Half day" },
  { value: "leave", short: "L", label: "Leave" },
  { value: "week_off", short: "WO", label: "Week off" },
];

const PHONE_QUERY = "(max-width: 640px)";

// True on a phone-width screen; follows the window as it turns or resizes.
const usePhone = () => {
  const [phone, setPhone] = useState(() => {
    try {
      return window.matchMedia(PHONE_QUERY).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let media;

    try {
      media = window.matchMedia(PHONE_QUERY);
    } catch {
      return undefined;
    }

    const follow = (event) => setPhone(event.matches);
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  return phone;
};

// A check-out earlier in the day than the check-in is the next morning:
// in 17:00, out 01:00 is an evening shift that ran past midnight.
const endsNextDay = (checkIn, checkOut) => Boolean(checkIn && checkOut && checkOut <= checkIn);

// The same rules the server uses to place the times (staff.service
// resolveTimes): on a shift past midnight (22:00-06:00), a time before the
// shift's end is the morning after the shift began, so arriving at 00:10 is
// late for that night, not early the morning before.
const placeTimes = (row, draft) => {
  const overnight = Boolean(row.overnight && row.endTime);
  const inNextDay = Boolean(overnight && draft.checkIn && draft.checkIn < row.endTime);
  const outNextDay = draft.checkIn
    ? inNextDay || endsNextDay(draft.checkIn, draft.checkOut)
    : Boolean(overnight && draft.checkOut && draft.checkOut <= row.endTime);

  return { inNextDay, outNextDay: Boolean(draft.checkOut) && outNextDay };
};

export default function AttendancePage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission("staff.manage");
  const [view, setView] = useQueryFilter("view", "day");
  // Leave types (when set up) and each person's balance on the day, so a
  // leave day says which leave and what is left.
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [balances, setBalances] = useState({});
  const [outlets, setOutlets] = useState([]);
  // A leave day over the allowance waiting for the manager's "save anyway".
  const [overAllowance, setOverAllowance] = useState(null);

  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [skipped, setSkipped] = useState([]);
  const [savingId, setSavingId] = useState(null);
  const [marking, setMarking] = useState(false);
  // Phone: one compact line per person; times open with "Edit times".
  const phone = usePhone();
  const [timesOpen, setTimesOpen] = useState(null);

  const draftsFrom = (list) =>
    Object.fromEntries(
      list.map((row) => [
        row.employeeId,
        {
          attendanceStatus:
            row.attendanceStatus ||
            (row.rosterStatus === "week_off" ? "week_off" : row.rosterStatus === "leave" ? "leave" : "present"),
          // Times on the restaurant's own clock, as the server worked them out.
          checkIn: row.checkInTime || "",
          checkOut: row.checkOutTime || "",
          notes: row.notes || "",
          leaveTypeId: row.leaveTypeId ? String(row.leaveTypeId) : "",
        },
      ])
    );

  const load = useCallback(
    () =>
      getAttendance(date)
        .then((data) => {
          setRows(data.rows);
          setDrafts(draftsFrom(data.rows));
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [date]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    listLeaveTypes()
      .then((rows) => setLeaveTypes(rows.filter((row) => row.status === "active")))
      .catch(() => setLeaveTypes([]));

    if (hasPermission("outlets.view")) {
      listOutlets()
        .then(setOutlets)
        .catch(() => setOutlets([]));
    }
  }, [hasPermission]);

  useEffect(() => {
    if (leaveTypes.length === 0) {
      return;
    }

    getLeaveRegister(date)
      .then((data) =>
        setBalances(Object.fromEntries(data.people.map((person) => [person.employeeId, person.types])))
      )
      .catch(() => setBalances({}));
  }, [date, leaveTypes]);

  const defaultLeaveType = leaveTypes.find((type) => type.isDefault) || leaveTypes[0] || null;

  // "Casual · 1 left" beside a leave type, from the person's balance.
  const leaveLabel = (employeeId, type) => {
    const cell = (balances[employeeId] || []).find((item) => Number(item.typeId) === Number(type.id));

    if (!type.paid) {
      return `${type.name} · unpaid`;
    }

    return cell ? `${type.name} · ${Math.max(0, cell.left)} left` : type.name;
  };

  const setDraft = (employeeId, changes) =>
    setDrafts({ ...drafts, [employeeId]: { ...drafts[employeeId], ...changes } });

  // changes: a status tapped on the phone sheet, saved at once.
  const save = async (row, acceptOverAllowance = false, changes = null) => {
    const draft = { ...drafts[row.employeeId], ...(changes || {}) };
    setError("");
    setSkipped([]);
    setSavingId(row.employeeId);

    const leaveTypeId =
      draft.attendanceStatus === "leave" && leaveTypes.length > 0
        ? Number(draft.leaveTypeId || (defaultLeaveType ? defaultLeaveType.id : 0)) || null
        : null;

    try {
      const updated = await saveAttendance({
        employeeId: row.employeeId,
        attendanceDate: date,
        shiftId: row.shiftId || null,
        attendanceStatus: draft.attendanceStatus,
        // Wall-clock times: the server places them on the restaurant's clock
        // and moves a check-out after midnight to the next day.
        checkInTime: draft.checkIn || null,
        checkOutTime: draft.checkOut || null,
        notes: draft.notes || null,
        leaveTypeId,
        acceptOverAllowance,
      });

      setRows(updated);
      setDrafts((current) => ({ ...current, ...draftsFrom(updated.filter((item) => item.employeeId === row.employeeId)) }));
      setSuccess(`Saved for ${row.employeeName}`);
      setOverAllowance(null);

      if (draft.attendanceStatus === "leave" && leaveTypes.length > 0) {
        getLeaveRegister(date)
          .then((data) => setBalances(Object.fromEntries(data.people.map((person) => [person.employeeId, person.types]))))
          .catch(() => undefined);
      }
    } catch (err) {
      // Over the allowance: the manager is asked first, the day is unpaid.
      if (err.response?.data?.data?.reason === "leave_over_allowance") {
        setOverAllowance({ row, message: err.response.data.message, changes });
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setSavingId(null);
    }
  };

  // Everyone with nothing recorded yet, the way the roster says: a week off is
  // marked as a week off, leave as leave, and people on a shift as present for
  // its times. Nobody is guessed at — the server says who it left, and why.
  const markAll = async () => {
    setError("");
    setSuccess("");
    setSkipped([]);
    setMarking(true);

    try {
      const result = await markRemaining(date);
      setRows(result.data.rows);
      setDrafts(draftsFrom(result.data.rows));
      setSuccess(result.message);
      setSkipped(result.data.skipped);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setMarking(false);
    }
  };

  // One tap on the phone sheet: that status, saved now. Present on a shift
  // with no times yet takes the shift's times, as "Mark remaining" does.
  const quickMark = (row, status) => {
    const draft = drafts[row.employeeId] || {};
    const changes = { attendanceStatus: status };

    if ((status === "present" || status === "half_day") && !draft.checkIn && row.startTime) {
      changes.checkIn = row.startTime;
      changes.checkOut = draft.checkOut || row.endTime || "";
    }

    setDraft(row.employeeId, changes);
    save(row, false, changes);
  };

  const unmarked = rows.filter((row) => !row.attendanceId).length;

  const totals = rows.reduce(
    (sum, row) => ({
      present: sum.present + (["present", "half_day"].includes(row.attendanceStatus) ? 1 : 0),
      absent: sum.absent + (row.attendanceStatus === "absent" ? 1 : 0),
      late: sum.late + (row.lateMinutes > 0 ? 1 : 0),
      hours: sum.hours + row.workedMinutes,
    }),
    { present: 0, absent: 0, late: 0, hours: 0 }
  );

  const statusLabel = (value) => STATUSES[value] || STATUSES.present;

  // The phone sheet: name and shift, the five one-tap buttons (saved at once),
  // and the times behind "Edit times".
  const phoneColumns = [
    {
      key: "employee",
      header: "Employee",
      value: (row) => row.employeeName,
      mobile: "title",
      render: (row) => (
        <span className="acc-who-text">
          <strong>{row.employeeName}</strong>
          <span className="muted small">
            {row.shiftName
              ? `${row.startTime} – ${row.endTime}${row.overnight ? " (+1)" : ""}`
              : row.rosterStatus === "week_off"
                ? "Week off on the roster"
                : row.rosterStatus === "leave"
                  ? "On leave on the roster"
                  : "Not rostered"}
            {row.workedMinutes > 0 ? ` · ${asHours(row.workedMinutes)}` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "mark",
      header: "Mark",
      label: "Mark",
      sortable: false,
      value: (row) => statusLabel((drafts[row.employeeId] || {}).attendanceStatus),
      mobile: "show",
      render: (row) => {
        const draft = drafts[row.employeeId] || {};
        const locked = !canManage || row.clocked;
        const current = row.attendanceId ? draft.attendanceStatus : null;
        const off = ["absent", "leave", "week_off"].includes(draft.attendanceStatus);

        return (
          <div className="acc-quick">
            <div className="acc-quick-buttons" role="group" aria-label={`Mark ${row.employeeName}`}>
              {QUICK.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`acc-quick-button is-${item.value} ${current === item.value ? "is-active" : ""}`}
                  aria-pressed={current === item.value}
                  aria-label={`${item.label} for ${row.employeeName}`}
                  title={item.label}
                  disabled={locked || savingId === row.employeeId}
                  onClick={() => quickMark(row, item.value)}
                >
                  {item.short}
                </button>
              ))}
            </div>
            {row.clocked ? (
              <Link className="acc-clock-chip" to="/staff/timeclock">
                <Icon name="clock" size={12} /> On the time clock
              </Link>
            ) : (
              canManage &&
              !off && (
                <button
                  type="button"
                  className="link-button small"
                  aria-expanded={timesOpen === row.employeeId}
                  onClick={() => setTimesOpen(timesOpen === row.employeeId ? null : row.employeeId)}
                >
                  {timesOpen === row.employeeId ? "Hide times" : "Edit times"}
                </button>
              )
            )}
            {timesOpen === row.employeeId && !row.clocked && !off && (
              <div className="acc-quick-times">
                <label className="field">
                  <span>In</span>
                  <input
                    type="time"
                    value={draft.checkIn || ""}
                    onChange={(event) => setDraft(row.employeeId, { checkIn: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Out</span>
                  <input
                    type="time"
                    value={draft.checkOut || ""}
                    onChange={(event) => setDraft(row.employeeId, { checkOut: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => save(row)}
                  disabled={savingId === row.employeeId}
                >
                  {savingId === row.employeeId ? "Saving…" : "Save times"}
                </button>
              </div>
            )}
          </div>
        );
      },
    },
  ];

  const tabBar = (
    <div className="acc-tabs" role="tablist" aria-label="Attendance views" data-motion-tabs>
      {[
        { key: "day", label: "Day sheet", icon: "clipboard" },
        { key: "month", label: "Month register", icon: "calendar" },
      ].map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={view === item.key}
          className={`acc-tab ${view === item.key ? "is-active" : ""}`}
          onClick={() => setView(item.key)}
        >
          <Icon name={item.icon} size={16} />
          {item.label}
        </button>
      ))}
    </div>
  );

  if (view === "month") {
    return (
      <div className="stack acc-page">
        <PageHeader
          icon="clipboard"
          title="Attendance"
          description="The month's register: every person, every day, with the totals payroll pays on. Print it for the file or export it."
        />
        {tabBar}
        <MusterRoll canManage={canManage} restaurantName={user.restaurantName} outlets={outlets} leaveTypes={leaveTypes} />
      </div>
    );
  }

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="clipboard"
        title="Attendance"
        description="Mark who worked, and from when to when. Hours, lateness and overtime are worked out for you."
        action={
          canManage && (
            <button
              type="button"
              className="button"
              onClick={markAll}
              disabled={loading || marking || unmarked === 0}
              title="Marks everyone not yet recorded, following the roster"
            >
              <Icon name="check" size={16} />
              {marking ? "Marking…" : `Mark remaining (${unmarked})`}
            </button>
          )
        }
      />

      {tabBar}

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {skipped.length > 0 && (
        <div className="alert alert-notice" role="status">
          <strong>Left for you to mark:</strong>{" "}
          {skipped.map((item) => `${item.name} ${item.reason}`).join("; ")}.
        </div>
      )}

      <div className="stat-grid">
        <StatTile
          icon="check-circle"
          tone="success"
          label="Worked"
          value={totals.present}
          of={rows.length ? `/${rows.length}` : undefined}
          note="present or half day"
        />
        <StatTile
          icon="x-circle"
          tone={totals.absent > 0 ? "danger" : "neutral"}
          label="Absent"
          value={totals.absent}
          note="loss-of-pay days"
        />
        <StatTile
          icon="timer"
          tone={totals.late > 0 ? "warning" : "neutral"}
          label="Arrived late"
          value={totals.late}
          note="after the shift's grace"
        />
        <StatTile icon="clock" tone="info" label="Hours worked" value={asHours(totals.hours)} note="everyone together" />
        <StatTile
          icon="clipboard"
          tone={unmarked > 0 ? "primary" : "success"}
          label="Still to mark"
          value={unmarked}
          note={unmarked > 0 ? "nothing recorded yet" : "everyone is recorded"}
        />
      </div>

      <SectionCard
        icon="list"
        title="Day sheet"
        description="Leave is approved leave (paid, if your pay policy says so); Absent is a loss-of-pay day. A check-out earlier than the check-in is the next morning. Days recorded on the time clock are corrected there."
        actions={
          !loading &&
          rows.length > 0 && (
            <span className="acc-count">
              {rows.length - unmarked} of {rows.length} recorded
            </span>
          )
        }
        flush
      >
        {/* One line per active person for the chosen day: the sheet is the
            day's whole team, so it is not split into pages. */}
        <DataGrid
          id={phone ? "attendance-day-phone" : "attendance-day"}
          caption={`Attendance for ${date}`}
          columns={phone ? phoneColumns : [
            {
              key: "employee",
              header: "Employee",
              width: 162,
              value: (row) => row.employeeName,
              mobile: "title",
              pin: true,
              render: (row) => (
                <span className="acc-who-text">
                  <strong>{row.employeeName}</strong>
                  {row.employeeCode && <span className="muted small mono">{row.employeeCode}</span>}
                  {!row.attendanceId && (
                    <span className="acc-unmarked">
                      <span className="acc-unmarked-dot" aria-hidden="true" />
                      Not marked yet
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "shift",
              header: "Shift",
              width: 132,
              value: (row) => row.shiftName || (row.rosterStatus === "week_off" ? "Week off" : row.rosterStatus === "leave" ? "On leave" : ""),
              mobile: "subtitle",
              render: (row) =>
                row.shiftName ? (
                  <span className="small">
                    {row.shiftName}
                    <span className="muted mono acc-block">
                      {row.startTime} – {row.endTime}
                      {row.overnight ? " (+1)" : ""}
                    </span>
                  </span>
                ) : row.rosterStatus === "week_off" ? (
                  <span className="badge badge-neutral">Week off</span>
                ) : row.rosterStatus === "leave" ? (
                  <span className="badge badge-warning">On leave</span>
                ) : (
                  <span className="muted small">Not rostered</span>
                ),
            },
            {
              key: "status",
              header: "Status",
              width: 128,
              value: (row) => statusLabel((drafts[row.employeeId] || {}).attendanceStatus),
              sortable: false,
              mobile: "show",
              render: (row) => {
                const draft = drafts[row.employeeId] || {};
                const locked = !canManage || row.clocked;

                return (
                  <>
                    <select
                      className={`acc-status-select is-${draft.attendanceStatus || "present"}`}
                      value={draft.attendanceStatus || "present"}
                      onChange={(event) => setDraft(row.employeeId, { attendanceStatus: event.target.value })}
                      disabled={locked}
                      aria-label={`Status for ${row.employeeName}: ${statusLabel(draft.attendanceStatus)}`}
                    >
                      {Object.entries(STATUSES).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {draft.attendanceStatus === "leave" && leaveTypes.length > 0 && (
                      <select
                        className="staff-leave-select"
                        value={draft.leaveTypeId || (defaultLeaveType ? String(defaultLeaveType.id) : "")}
                        onChange={(event) => setDraft(row.employeeId, { leaveTypeId: event.target.value })}
                        disabled={locked}
                        aria-label={`Which leave for ${row.employeeName}`}
                      >
                        {leaveTypes.map((type) => (
                          <option key={type.id} value={type.id}>
                            {leaveLabel(row.employeeId, type)}
                          </option>
                        ))}
                      </select>
                    )}
                    {row.clocked && (
                      <div>
                        <Link className="acc-clock-chip" to="/staff/timeclock">
                          <Icon name="clock" size={12} /> On the time clock
                        </Link>
                      </div>
                    )}
                  </>
                );
              },
            },
            {
              key: "in",
              header: "In",
              width: 112,
              value: (row) => (drafts[row.employeeId] || {}).checkIn || "",
              sortable: false,
              mobile: "show",
              render: (row) => {
                const draft = drafts[row.employeeId] || {};
                const off = ["absent", "leave", "week_off"].includes(draft.attendanceStatus);
                const { inNextDay } = off ? {} : placeTimes(row, draft);

                return (
                  <>
                    <input
                      type="time"
                      value={draft.checkIn || ""}
                      onChange={(event) => setDraft(row.employeeId, { checkIn: event.target.value })}
                      disabled={!canManage || row.clocked || off}
                      aria-label={`Check-in for ${row.employeeName}`}
                    />
                    {inNextDay && <div className="small acc-next-day">next day (after midnight)</div>}
                  </>
                );
              },
            },
            {
              key: "out",
              header: "Out",
              width: 112,
              value: (row) => (drafts[row.employeeId] || {}).checkOut || "",
              sortable: false,
              mobile: "show",
              render: (row) => {
                const draft = drafts[row.employeeId] || {};
                const off = ["absent", "leave", "week_off"].includes(draft.attendanceStatus);
                const { outNextDay } = off ? {} : placeTimes(row, draft);

                return (
                  <>
                    <input
                      type="time"
                      value={draft.checkOut || ""}
                      onChange={(event) => setDraft(row.employeeId, { checkOut: event.target.value })}
                      disabled={!canManage || row.clocked || off}
                      aria-label={`Check-out for ${row.employeeName}`}
                    />
                    {outNextDay && <div className="small acc-next-day">next day</div>}
                  </>
                );
              },
            },
            {
              key: "worked",
              header: "Worked",
              type: "number",
              width: 120,
              value: (row) => row.workedMinutes,
              mobile: "show",
              csv: (row) => asHours(row.workedMinutes),
              render: (row) => <strong>{asHours(row.workedMinutes)}</strong>,
            },
            {
              key: "late",
              header: "Late",
              type: "number",
              width: 100,
              value: (row) => row.lateMinutes,
              csv: (row) => row.lateMinutes,
              render: (row) => (row.lateMinutes > 0 ? <span className="text-danger">{row.lateMinutes} min</span> : <span className="muted">—</span>),
            },
            {
              key: "overtime",
              header: "Overtime",
              type: "number",
              width: 130,
              value: (row) => row.overtimeMinutes,
              csv: (row) => row.overtimeMinutes,
              render: (row) => (row.overtimeMinutes > 0 ? asHours(row.overtimeMinutes) : <span className="muted">—</span>),
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (row) =>
                row.clocked ? null : (
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    onClick={() => save(row)}
                    disabled={savingId === row.employeeId}
                  >
                    {savingId === row.employeeId ? "Saving…" : row.attendanceId ? "Update" : "Save"}
                  </button>
                ),
            },
          ]}
          rows={rows}
          rowKey={(row) => row.employeeId}
          loading={loading}
          pageSize={false}
          empty="No active employees"
          emptyIcon="users"
          emptyHint="Attendance lists everyone marked active on the Employees page."
          emptyAction={
            <Link className="button button-secondary" to="/staff">
              Go to Employees
            </Link>
          }
          rowClassName={(row) => (!row.attendanceId ? "dg-tone-warning" : "")}
          toolbar={
            <>
              <label className="field">
                <span>Date</span>
                <input
                  type="date"
                  value={date}
                  max={today()}
                  onChange={(event) => {
                    setDate(event.target.value);
                    setSkipped([]);
                  }}
                />
              </label>

              <div className="field">
                <span>Quick pick</span>
                {/* Attendance is marked today, or yesterday when someone forgot.
                    Anything further back is worth choosing deliberately. */}
                <div className="segmented" role="radiogroup" aria-label="Quick date">
                  {[
                    { key: today(), label: "Today" },
                    { key: daysAgo(1), label: "Yesterday" },
                  ].map((option) => (
                    <button
                      type="button"
                      key={option.key}
                      className={`segment ${date === option.key ? "is-active" : ""}`}
                      role="radio"
                      aria-checked={date === option.key}
                      onClick={() => setDate(option.key)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          }
          exportName={`attendance-${date}`}
        />
      </SectionCard>

      {overAllowance && (
        <Modal title="Over the leave allowance" icon="alert" onClose={() => setOverAllowance(null)} width={460}>
          <div className="stack">
            <p>{overAllowance.message}</p>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setOverAllowance(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button staff-button-warning"
                onClick={() => save(overAllowance.row, true, overAllowance.changes)}
                disabled={savingId === overAllowance.row.employeeId}
              >
                Save anyway — unpaid
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
