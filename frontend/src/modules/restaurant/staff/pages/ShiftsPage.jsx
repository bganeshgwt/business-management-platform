import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import StatusBadge from "../../../../components/StatusBadge";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import SuccessCheck from "../../../../components/SuccessCheck";
import {
  copyRosterWeek,
  createShift,
  deleteShift,
  getRoster,
  listEmployees,
  listLeaveTypes,
  listShifts,
  saveAssignment,
  updateShift,
} from "../services/staff.service";
import { getErrorMessage } from "../../../../services/api";
import { today } from "../../../../services/dates";
import { count } from "../../../../services/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import useAuth from "../../../../hooks/useAuth";
import LeaveChoice from "./LeaveChoice";
import "../../../../styles/access.css";
import "../../../../styles/access-sweep.css";

const EMPTY_SHIFT = {
  name: "",
  startTime: "09:00",
  endTime: "17:00",
  breakMinutes: 30,
  graceMinutes: 10,
  status: "active",
};

// The seven days starting from the chosen date.
const weekFrom = (start) =>
  Array.from({ length: 7 }, (unused, index) => {
    const date = new Date(`${start}T00:00:00`);
    date.setDate(date.getDate() + index);
    return date.toLocaleDateString("en-CA");
  });

const dayLabel = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });

// "1 Oct" under the weekday in the roster's column heads.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (value) => MONTHS[Number(String(value).slice(5, 7)) - 1] || "";

// The date a week before or after, for the arrows beside "Week starting".
const shiftWeek = (start, weeks) => {
  const date = new Date(`${start}T00:00:00`);
  date.setDate(date.getDate() + weeks * 7);
  return date.toLocaleDateString("en-CA");
};

// "8h" or "8h 30m" of clock time, across midnight when the end is earlier.
const lengthOf = (shift) => {
  const [startHour, startMinute] = String(shift.startTime).split(":").map(Number);
  const [endHour, endMinute] = String(shift.endTime).split(":").map(Number);
  let minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);

  if (minutes <= 0) {
    minutes += 24 * 60;
  }

  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
};

// Today's column heading in the brand colour.
const TODAY_STYLE = { color: "var(--primary)" };

const overnight = (shift) => String(shift.endTime) <= String(shift.startTime);

// "Mon 6 Oct" for the printed sheet and the text copy.
const weekdayLabel = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

const SKIP_WORDS = {
  inactive: "inactive",
  left: "has left",
  shift_not_used: "shift no longer used",
  paid: "pay already marked paid",
  already_filled: "day already filled",
};

// What one roster entry says, in words: "Morning 08:00–16:00", "Week off",
// "Leave (Casual)".
const entryWords = (entry) => {
  if (!entry) {
    return "—";
  }

  if (entry.assignmentStatus === "week_off") {
    return "Week off";
  }

  if (entry.assignmentStatus === "leave") {
    return entry.leaveTypeName ? `Leave (${entry.leaveTypeName})` : "Leave";
  }

  return `${entry.shiftName} ${entry.startTime}–${entry.endTime}`;
};

export default function ShiftsPage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission("staff.manage");
  // Leave types, when the restaurant has set them up: marking leave then asks
  // which, with what the person has left.
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [leaveFor, setLeaveFor] = useState(null);
  const [copying, setCopying] = useState(false);
  const [textCopy, setTextCopy] = useState(false);

  const [shifts, setShifts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [roster, setRoster] = useState([]);
  const [weekStart, setWeekStart] = useState(today());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_SHIFT);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const days = weekFrom(weekStart);

  const loadRoster = useCallback(
    () =>
      getRoster({ from: days[0], to: days[6] })
        .then(setRoster)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weekStart]
  );

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  const loadLists = useCallback(
    () =>
      Promise.all([listShifts(), listEmployees({ status: "active" })])
        .then(([shiftRows, employeeRows]) => {
          setShifts(shiftRows);
          setEmployees(employeeRows);
        })
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    loadLists();
  }, [loadLists]);

  useEffect(() => {
    listLeaveTypes()
      .then((rows) => setLeaveTypes(rows.filter((row) => row.status === "active")))
      .catch(() => setLeaveTypes([]));
  }, []);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const saveShift = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      ...form,
      breakMinutes: Number(form.breakMinutes || 0),
      graceMinutes: Number(form.graceMinutes || 0),
    };

    try {
      if (editing.id) {
        await updateShift(editing.id, payload);
        setSuccess("Shift updated");
      } else {
        await createShift(payload);
        setSuccess("Shift created");
      }

      setEditing(null);
      loadLists();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const removeShift = async (shift) => {
    try {
      await deleteShift(shift.id);
      setSuccess("Shift deleted");
      loadLists();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  // Each cell in the grid saves straight away: rosters are edited quickly.
  // Leave asks which leave first, when the restaurant has leave types.
  const assign = async (employeeId, workDate, value) => {
    setError("");

    if (value === "leave" && leaveTypes.length > 0) {
      const employee = employees.find((row) => Number(row.id) === Number(employeeId));
      setLeaveFor({ employee: { id: employeeId, name: employee ? employee.name : "" }, date: workDate });
      return;
    }

    try {
      const payload =
        value === "week_off" || value === "leave"
          ? { employeeId, workDate, assignmentStatus: value, shiftId: null }
          : { employeeId, workDate, assignmentStatus: "scheduled", shiftId: Number(value) };

      await saveAssignment(payload);
      loadRoster();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const saveLeave = async ({ leaveTypeId, acceptOverAllowance }) => {
    await saveAssignment({
      employeeId: leaveFor.employee.id,
      workDate: leaveFor.date,
      assignmentStatus: "leave",
      shiftId: null,
      leaveTypeId,
      acceptOverAllowance,
    });
    setLeaveFor(null);
    loadRoster();
  };

  const entryOf = (employeeId, date) =>
    roster.find((row) => Number(row.employeeId) === Number(employeeId) && row.workDate === date) || null;

  // The week on paper for the staff notice board: A4 across, person by day.
  const printWeek = () => {
    const head = days.map((date) => `<th>${escapeHtml(weekdayLabel(date))}</th>`).join("");
    const rows = employees
      .map(
        (employee) =>
          `<tr><td class="n">${escapeHtml(employee.name)}</td>${days
            .map((date) => {
              const entry = entryOf(employee.id, date);
              const kind = !entry ? "e" : entry.assignmentStatus === "scheduled" ? "s" : "o";
              return `<td class="${kind}">${escapeHtml(entry ? entryWords(entry) : "")}</td>`;
            })
            .join("")}</tr>`
      )
      .join("");

    printDocument({
      title: `Roster ${days[0]} to ${days[6]}`,
      styles: `
        @page { size: A4 landscape; margin: 10mm; }
        body { font-family: system-ui, sans-serif; font-size: 11px; color: #111; }
        h1 { font-size: 17px; margin: 0; } .m { color: #555; margin-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th, td { border: 1px solid #999; padding: 6px 5px; text-align: left; vertical-align: top; }
        th { background: #eee; } td.n { font-weight: 600; } td.o { background: #f4f4f4; font-style: italic; }
        .k { margin-top: 10px; color: #555; }
      `,
      body: `
        <h1>${escapeHtml(user.restaurantName || "")} · Staff roster</h1>
        <div class="m">${escapeHtml(weekdayLabel(days[0]))} to ${escapeHtml(weekdayLabel(days[6]))}</div>
        <table><thead><tr><th>Name</th>${head}</tr></thead><tbody>${rows}</tbody></table>
        <div class="k">${shifts
          .filter((shift) => shift.status === "active")
          .map((shift) => `${escapeHtml(shift.name)} ${escapeHtml(shift.startTime)}–${escapeHtml(shift.endTime)}`)
          .join(" · ")}</div>
      `,
    });
  };

  const cellValue = (employeeId, date) => {
    const entry = roster.find(
      (row) => Number(row.employeeId) === Number(employeeId) && row.workDate === date
    );

    if (!entry) {
      return "";
    }

    return entry.assignmentStatus === "scheduled" ? String(entry.shiftId) : entry.assignmentStatus;
  };

  const openNew = () => {
    setForm(EMPTY_SHIFT);
    setFormError("");
    setEditing({});
  };

  const openEdit = (shift) => {
    setForm({
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      breakMinutes: shift.breakMinutes,
      graceMinutes: shift.graceMinutes,
      status: shift.status,
    });
    setFormError("");
    setEditing(shift);
  };

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew}>
      <Icon name="plus" size={16} /> Add shift
    </button>
  );

  // The week at a glance: how much of it is planned, and what is still open.
  const activeShifts = shifts.filter((shift) => shift.status === "active");
  const inWeek = roster.filter(
    (row) => days.includes(row.workDate) && employees.some((employee) => Number(employee.id) === Number(row.employeeId))
  );
  const onShift = inWeek.filter((row) => row.assignmentStatus === "scheduled").length;
  const offOrLeave = inWeek.filter((row) => row.assignmentStatus !== "scheduled").length;
  const openDays = Math.max(0, employees.length * days.length - inWeek.length);
  const todayDate = today();

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="calendar"
        title="Shifts & roster"
        description="Set your shift timings once, then plan who works which day. The time clock and attendance read late and overtime from this roster."
        action={addButton}
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!loading && employees.length > 0 && shifts.length > 0 && (
        <div className="stat-grid">
          <StatTile
            icon="clock"
            tone="primary"
            label="Shift patterns"
            value={count(activeShifts.length)}
            note={
              shifts.length > activeShifts.length
                ? `in use · ${shifts.length - activeShifts.length} switched off`
                : "in use"
            }
          />
          <StatTile
            icon="users"
            tone="success"
            label="Shifts this week"
            value={count(onShift)}
            note={`across ${employees.length} active ${employees.length === 1 ? "person" : "people"}`}
          />
          <StatTile icon="sun" tone="info" label="Week offs & leave" value={count(offOrLeave)} note="days this week" />
          <StatTile
            icon="alert"
            tone={openDays > 0 ? "warning" : "success"}
            label="Not planned yet"
            value={count(openDays)}
            note={openDays > 0 ? "person-days left blank" : "every day has a plan"}
          />
        </div>
      )}

      <SectionCard
        icon="clock"
        title="Shift patterns"
        description="Grace is how late someone can arrive before it counts as late. An end before the start runs past midnight."
        flush
      >
        <DataGrid
          id="shift-patterns"
          caption="Shift patterns"
          columns={[
            {
              key: "name",
              header: "Shift",
              value: (shift) => shift.name,
              mobile: "title",
              pin: true,
              render: (shift) => (
                <div className="acc-who">
                  <span className="acc-shift-mark" aria-hidden="true">
                    <Icon name={overnight(shift) ? "moon" : "sun"} size={16} />
                  </span>
                  <span className="acc-who-text">
                    <strong>{shift.name}</strong>
                    {/* The times are what people look for; the length follows, quieter. */}
                    <span className="small">
                      <span className="mono nowrap">
                        {shift.startTime} – {shift.endTime}
                      </span>{" "}
                      <span className="muted">· {lengthOf(shift)}</span>
                    </span>
                  </span>
                </div>
              ),
            },
            {
              key: "timing",
              header: "Timing",
              value: (shift) => shift.startTime,
              mobile: "subtitle",
              csv: (shift) => `${shift.startTime} – ${shift.endTime}${overnight(shift) ? " (+1 day)" : ""}`,
              render: (shift) => (
                <>
                  <span className="mono nowrap">
                    {shift.startTime} – {shift.endTime}
                  </span>{" "}
                  <span className="muted small nowrap">{lengthOf(shift)}</span>
                  {overnight(shift) && <span className="badge badge-neutral acc-next-badge">+1 day</span>}
                </>
              ),
            },
            {
              key: "break",
              header: "Break",
              type: "number",
              value: (shift) => shift.breakMinutes,
              mobile: "show",
              render: (shift) => `${shift.breakMinutes} min`,
            },
            {
              key: "grace",
              header: "Grace",
              type: "number",
              value: (shift) => shift.graceMinutes,
              mobile: "show",
              render: (shift) => `${shift.graceMinutes} min`,
            },
            { key: "onRoster", header: "On roster", type: "number", value: (shift) => shift.assignedCount, mobile: "show" },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (shift) => shift.status,
              render: (shift) => <StatusBadge status={shift.status} />,
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (shift) => (
                <div className="row-actions">
                  <button type="button" className="chip-button" onClick={() => openEdit(shift)}>
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  <ActionMenu
                    label={`More actions for ${shift.name}`}
                    items={[{ label: "Delete", icon: "trash", danger: true, onClick: () => removeShift(shift) }]}
                  />
                </div>
              ),
            },
          ]}
          rows={shifts}
          rowKey={(shift) => shift.id}
          empty="No shift patterns yet"
          emptyIcon="clock"
          emptyHint="Add the blocks of hours your team works. Morning and Evening are a good start; a late bar shift can run past midnight."
          emptyAction={addButton}
          rowClassName={(shift) => (shift.status === "active" ? "" : "dg-tone-muted")}
          pageSize={false}
        />
      </SectionCard>

      <SectionCard
        icon="calendar"
        title="Weekly roster"
        description={
          canManage
            ? "Pick a shift, a week off or leave in each box. Every change saves straight away."
            : "Who works which day this week."
        }
        actions={
          <div className="acc-week-nav">
            {employees.length > 0 && shifts.length > 0 && (
              <div className="asw-week-tools">
                {canManage && (
                  <button type="button" className="button button-secondary button-sm" onClick={() => setCopying(true)}>
                    <Icon name="copy" size={15} /> Copy last week
                  </button>
                )}
                <button type="button" className="button button-secondary button-sm" onClick={printWeek}>
                  <Icon name="print" size={15} /> Print
                </button>
                <button type="button" className="button button-secondary button-sm" onClick={() => setTextCopy(true)}>
                  <Icon name="message" size={15} /> Copy as text
                </button>
              </div>
            )}
            <button
              type="button"
              className="button button-secondary button-sm button-icon"
              onClick={() => setWeekStart(shiftWeek(weekStart, -1))}
              aria-label="Previous week"
            >
              <Icon name="chevron-left" size={16} />
            </button>
            <label className="acc-week-field">
              <span className="sr-only">Week starting</span>
              <input type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} />
            </label>
            <button
              type="button"
              className="button button-secondary button-sm button-icon"
              onClick={() => setWeekStart(shiftWeek(weekStart, 1))}
              aria-label="Next week"
            >
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
        }
        flush
      >
        {loading ? (
          <div className="acc-pad">
            <Loading />
          </div>
        ) : employees.length === 0 ? (
          <EmptyState
            icon="users"
            message="Add employees first"
            hint="The roster lists everyone marked active on the Employees page."
            action={
              <Link className="button button-secondary" to="/staff">
                Go to Employees
              </Link>
            }
          />
        ) : shifts.length === 0 ? (
          <EmptyState
            icon="clock"
            message="Add a shift pattern before building the roster"
            hint="Each box in the roster is filled with one of your shift patterns."
            action={addButton}
          />
        ) : (
          <>
            <DataGrid
              id="shift-roster"
              caption={`Weekly roster, ${dayLabel(days[0])} to ${dayLabel(days[6])}`}
              columns={[
                {
                  key: "employee",
                  header: "Employee",
                  value: (employee) => employee.name,
                  mobile: "title",
                  pin: true,
                  render: (employee) => <strong className="acc-roster-name">{employee.name}</strong>,
                },
                // One column per day of the week. Keyed by position, not date,
                // so a column's remembered width carries from week to week.
                ...days.map((date, index) => ({
                  key: `day${index}`,
                  header: (
                    <span>
                      <span className="acc-roster-day" style={date === todayDate ? TODAY_STYLE : undefined}>
                        {dayLabel(date)}
                      </span>
                      <span className="acc-roster-month" style={date === todayDate ? TODAY_STYLE : undefined}>
                        {date === todayDate ? "Today" : monthLabel(date)}
                      </span>
                    </span>
                  ),
                  label: date === todayDate ? `${dayLabel(date)} (today)` : dayLabel(date),
                  value: (employee) => {
                    const entry = entryOf(employee.id, date);
                    return entry ? entryWords(entry) : "";
                  },
                  sortable: false,
                  filter: "none",
                  searchable: false,
                  hideable: false,
                  minWidth: 120,
                  mobile: "show",
                  render: (employee) => {
                    const value = cellValue(employee.id, date);
                    const kind = value === "" ? "empty" : value === "week_off" ? "off" : value === "leave" ? "leave" : "shift";
                    const leaveName = value === "leave" ? entryOf(employee.id, date)?.leaveTypeName : null;

                    return (
                      <select
                        className={`acc-roster-cell is-${kind}`}
                        value={value}
                        onChange={(event) => assign(employee.id, date, event.target.value)}
                        disabled={!canManage}
                        aria-label={`${employee.name}, ${dayLabel(date)}`}
                      >
                        <option value="">—</option>
                        {shifts
                          .filter((shift) => shift.status === "active")
                          .map((shift) => (
                            <option key={shift.id} value={shift.id}>
                              {shift.name}
                            </option>
                          ))}
                        <option value="week_off">Week off</option>
                        <option value="leave">{leaveName ? `Leave · ${leaveName}` : "Leave"}</option>
                      </select>
                    );
                  },
                })),
              ]}
              rows={employees}
              rowKey={(employee) => employee.id}
              search="Find a person"
              exportName={`roster-${days[0]}`}
              rowNoun={["person", "people"]}
            />
            <ul className="acc-legend" aria-label="What the colours mean">
              <li>
                <span className="acc-swatch is-shift" /> On a shift
              </li>
              <li>
                <span className="acc-swatch is-off" /> Week off
              </li>
              <li>
                <span className="acc-swatch is-leave" /> Leave
              </li>
              <li>
                <span className="acc-swatch is-empty" /> Not planned — counts as not rostered
              </li>
            </ul>
          </>
        )}
      </SectionCard>

      {leaveFor && (
        <LeaveChoice employee={leaveFor.employee} date={leaveFor.date} onClose={() => setLeaveFor(null)} onSave={saveLeave} />
      )}

      {copying && (
        <CopyWeekModal
          weekStart={days[0]}
          weekEnd={days[6]}
          onClose={() => setCopying(false)}
          onCopied={() => loadRoster()}
        />
      )}

      {textCopy && (
        <TextCopyModal
          employees={employees}
          days={days}
          entryOf={entryOf}
          restaurantName={user.restaurantName}
          onClose={() => setTextCopy(false)}
        />
      )}

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : "Add shift"}
          description="A named block of working hours. It can run past midnight."
          icon="clock"
          onClose={() => setEditing(null)}
        >
          <form className="form-grid" onSubmit={saveShift}>
            <ErrorMessage message={formError} />

            <label className="field field-wide">
              <span>Name *</span>
              <input
                value={form.name}
                onChange={change("name")}
                required
                autoFocus
                placeholder="Morning"
              />
            </label>

            <label className="field">
              <span>Starts *</span>
              <input type="time" value={form.startTime} onChange={change("startTime")} required />
            </label>

            <label className="field">
              <span>Ends *</span>
              <input type="time" value={form.endTime} onChange={change("endTime")} required />
              <small className="muted">An end before the start means it runs past midnight</small>
            </label>

            <label className="field">
              <span>Break (minutes)</span>
              <input
                type="number"
                min="0"
                max="599"
                value={form.breakMinutes}
                onChange={change("breakMinutes")}
              />
            </label>

            <label className="field">
              <span>Grace (minutes)</span>
              <input
                type="number"
                min="0"
                max="119"
                value={form.graceMinutes}
                onChange={change("graceMinutes")}
              />
              <small className="muted">Arriving within this is not counted late</small>
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// "Copy last week": fills the week shown from the seven days before it, in one
// go. A day already planned stays as it is unless "replace" is ticked.
function CopyWeekModal({ weekStart, weekEnd, onClose, onCopied }) {
  const [replace, setReplace] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    setBusy(true);
    setError("");

    try {
      const answer = await copyRosterWeek(weekStart, replace);
      setResult(answer);
      onCopied();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reasons = result
    ? Object.entries(
        result.data.skipped.reduce((sum, item) => ({ ...sum, [item.reason]: (sum[item.reason] || 0) + 1 }), {})
      )
    : [];

  return (
    <Modal
      title="Copy last week"
      description={`Fills ${weekdayLabel(weekStart)} – ${weekdayLabel(weekEnd)} from the seven days before it: shifts, week offs and leave.`}
      icon="copy"
      onClose={onClose}
      width={520}
    >
      {result ? (
        <div className="stack">
          <div className="asw-done">
            <SuccessCheck size={44} label="Roster copied" />
            <div>
              <strong>{result.message}</strong>
              <p className="muted small">Every copied day can still be changed in the grid.</p>
            </div>
          </div>
          {result.data.skipped.length > 0 && (
            <div>
              <p className="section-heading">Skipped</p>
              <ul className="asw-skip-list">
                {reasons.map(([reason, total]) => (
                  <li key={reason}>
                    <strong>{total}</strong> {SKIP_WORDS[reason] || reason}
                    <span className="muted small">
                      {" "}
                      ·{" "}
                      {[...new Set(result.data.skipped.filter((item) => item.reason === reason).map((item) => item.name))].join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <ErrorMessage message={error} />
          <ul className="asw-facts">
            <li>
              <Icon name="check" size={16} />
              <span>People who are inactive or have left, and shifts no longer used, are skipped.</span>
            </li>
            <li>
              <Icon name="lock" size={16} />
              <span>Days whose pay is already marked paid are not changed.</span>
            </li>
          </ul>
          <label className="checkbox">
            <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
            <span>Replace days already filled this week with last week's</span>
          </label>
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="button" onClick={copy} disabled={busy}>
              {busy ? "Copying…" : "Copy last week"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// One person's week, or everyone's, as text to paste into a message.
function TextCopyModal({ employees, days, entryOf, restaurantName, onClose }) {
  const [who, setWho] = useState("all");
  const [copied, setCopied] = useState(false);

  const range = `${weekdayLabel(days[0])} – ${weekdayLabel(days[6])}`;
  const text =
    who === "all"
      ? [
          `${restaurantName || "Roster"} · roster ${range}`,
          "",
          ...employees.map(
            (employee) =>
              `${employee.name}: ${days
                .map((date) => `${weekdayLabel(date).split(" ")[0]} ${entryWords(entryOf(employee.id, date))}`)
                .join(", ")}`
          ),
        ].join("\n")
      : (() => {
          const employee = employees.find((row) => String(row.id) === who);

          return [
            `${employee ? employee.name : ""} · your shifts ${range}`,
            ...days.map((date) => `${weekdayLabel(date)}: ${entryWords(entryOf(employee.id, date))}`),
          ].join("\n");
        })();

  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Modal title="Copy as text" description="Ready to paste into a message to the team, or to one person." icon="message" onClose={onClose} width={560}>
      <div className="stack">
        <label className="field">
          <span>Whose week</span>
          <select
            value={who}
            onChange={(event) => {
              setWho(event.target.value);
              setCopied(false);
            }}
          >
            <option value="all">Everyone</option>
            {employees.map((employee) => (
              <option key={employee.id} value={String(employee.id)}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>
        <textarea className="asw-text-copy" rows={Math.min(14, text.split("\n").length + 1)} value={text} readOnly />
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
