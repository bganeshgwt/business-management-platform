import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getMusterRoll, saveAttendance } from "../services/staff.service";
import { getErrorMessage } from "../../../../services/api";
import { count } from "../../../../services/format";
import { downloadCsv } from "../../../../services/csv";
import { escapeHtml, printDocument } from "../../../../services/print";
import { hoursFromDecimal } from "./hoursText";

// The month's attendance register (muster roll): one row per person, one
// column per day, and each person's totals — the register kept for a labour
// inspection or a salary dispute. Its day counts are the ones payroll pays
// on, so the two always agree. Tapping a day opens it to correct; the
// paid-period lock still applies.

const DEPARTMENTS = {
  kitchen: "Kitchen",
  service: "Service",
  management: "Management",
  delivery: "Delivery",
  housekeeping: "Housekeeping",
  other: "Other",
};

const STATUSES = { present: "Present", absent: "Absent", half_day: "Half day", leave: "Leave", week_off: "Week off" };

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

const thisMonth = () => new Date().toLocaleDateString("en-CA").slice(0, 7);

const monthWords = (month) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

const dayWords = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

// Late-day counts in the warning colour, as the register's red mark is.
const LATE_STYLE = { color: "var(--warning-text)" };

const hoursText = (value) => (value ? hoursFromDecimal(value) : "0");

export default function MusterRoll({ canManage, restaurantName, outlets = [], leaveTypes = [] }) {
  const [month, setMonth] = useState(thisMonth());
  const [outletId, setOutletId] = useState("");
  const [department, setDepartment] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [cell, setCell] = useState(null);

  const load = useCallback(
    () =>
      getMusterRoll({ month, outletId: outletId || undefined, department: department || undefined })
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [month, outletId, department]
  );

  useEffect(() => {
    load();
  }, [load]);

  const weekdayOf = (date) => WEEKDAY[new Date(`${date}T00:00:00`).getDay()];
  const isSunday = (date) => new Date(`${date}T00:00:00`).getDay() === 0;

  const exportCsv = () => {
    downloadCsv(
      [
        ["Employee", "Code", "Department", ...data.days.map((date) => date.slice(8)), "Present", "Half days", "Absent", "Leave", "Week offs", "Late days", "Overtime hours"],
        ...data.rows.map((row) => [
          row.name,
          row.employeeCode || "",
          DEPARTMENTS[row.department] || row.department,
          ...data.days.map((date) => `${row.cells[date].code}${row.cells[date].late ? " late" : ""}`),
          row.totals.present,
          row.totals.halfDays,
          row.totals.absent,
          row.totals.leave,
          row.totals.weekOffs,
          row.totals.lateDays,
          row.totals.overtimeHours,
        ]),
      ],
      `attendance-register-${month}.csv`
    );
  };

  // A4 across, as a register is kept: restaurant, month, every day, totals,
  // and the lines for signatures.
  const print = () => {
    const head = data.days
      .map((date) => `<th class="d${isSunday(date) ? " su" : ""}">${Number(date.slice(8))}<br><span>${weekdayOf(date)}</span></th>`)
      .join("");
    const rows = data.rows
      .map(
        (row, index) =>
          `<tr><td class="c">${index + 1}</td><td class="n">${escapeHtml(row.name)}${row.employeeCode ? `<br><span>${escapeHtml(row.employeeCode)}</span>` : ""}</td>${data.days
            .map((date) => {
              const value = row.cells[date];
              return `<td class="d k-${value.status}">${escapeHtml(value.code)}${value.late ? "<sup>L</sup>" : ""}</td>`;
            })
            .join("")}<td class="t">${row.totals.present}</td><td class="t">${row.totals.halfDays}</td><td class="t">${row.totals.absent}</td><td class="t">${row.totals.leave}</td><td class="t">${row.totals.weekOffs}</td><td class="t">${row.totals.lateDays}</td><td class="t">${hoursText(row.totals.overtimeHours)}</td></tr>`
      )
      .join("");

    printDocument({
      title: `Attendance register ${month}`,
      styles: `
        @page { size: A4 landscape; margin: 8mm; }
        body { font-family: system-ui, sans-serif; font-size: 8.5px; color: #111; }
        h1 { font-size: 14px; margin: 0; } .m { color: #444; margin: 2px 0 6px; font-size: 10px; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th, td { border: 1px solid #888; padding: 2px 1px; text-align: center; }
        th { background: #eee; font-weight: 600; } th span, td span { color: #555; font-weight: 400; }
        td.n { text-align: left; padding-left: 3px; width: 92px; } td.c { width: 14px; }
        th.su, td.su { background: #f6f6f6; } td.k-absent { font-weight: 700; } td.t { font-weight: 600; width: 22px; }
        sup { font-size: 6px; color: #b00; }
        .legend { margin-top: 6px; color: #444; font-size: 9px; }
        .sign { margin-top: 26px; display: flex; justify-content: space-between; font-size: 10px; }
      `,
      body: `
        <h1>${escapeHtml(restaurantName || "")} · Attendance register (muster roll)</h1>
        <div class="m">${escapeHtml(monthWords(month))} · ${data.rows.length} employees</div>
        <table>
          <thead><tr><th class="c">#</th><th class="n">Employee</th>${head}<th class="t">P</th><th class="t">½</th><th class="t">A</th><th class="t">L</th><th class="t">WO</th><th class="t">Late</th><th class="t">OT</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="legend">P present · ½ half day · A absent · L leave · WO week off · <sup>L</sup> late · — not on the staff then</div>
        <div class="sign"><span>Prepared by: ____________________</span><span>Manager: ____________________</span><span>Employer's signature &amp; seal: ____________________</span></div>
      `,
    });
  };

  return (
    <div className="stack">
      <SectionCard
        icon="calendar"
        title={`Attendance register · ${monthWords(month)}`}
        description="P present · ½ half day · A absent · L leave · WO week off; a red mark is a late arrival. Tap a day to correct it."
        actions={
          <div className="asw-inline-actions">
            <button type="button" className="button button-secondary button-sm" onClick={print} disabled={!data || data.rows.length === 0}>
              <Icon name="print" size={15} /> Print
            </button>
            <button type="button" className="button button-secondary button-sm" onClick={exportCsv} disabled={!data || data.rows.length === 0}>
              <Icon name="download" size={15} /> CSV
            </button>
          </div>
        }
        flush
      >
        <div className="acc-filterbar filters">
          <label className="field">
            <span>Month</span>
            <input type="month" value={month} max={thisMonth()} onChange={(event) => setMonth(event.target.value || thisMonth())} />
          </label>
          {outlets.length > 0 && (
            <label className="field">
              <span>Outlet</span>
              <select value={outletId} onChange={(event) => setOutletId(event.target.value)}>
                <option value="">All outlets</option>
                {outlets.map((outlet) => (
                  <option key={outlet.id} value={outlet.id}>
                    {outlet.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Department</span>
            <select value={department} onChange={(event) => setDepartment(event.target.value)}>
              <option value="">All</option>
              {Object.entries(DEPARTMENTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <ErrorMessage message={error} />

        {!data ? (
          error ? null : (
            <div className="acc-pad">
              <Loading label="Loading the register…" />
            </div>
          )
        ) : data.rows.length === 0 ? (
          <EmptyState icon="users" message="Nobody to show" hint="The register lists active staff, and anyone with a day recorded in the month." />
        ) : (
          <>
            <div className="asw-muster-tiles">
              <StatTile size="sm" icon="check-circle" tone="success" label="Present days" value={count(data.totals.present)} note={data.totals.halfDays ? `+ ${data.totals.halfDays} half days` : "full days"} />
              <StatTile size="sm" icon="x-circle" tone={data.totals.absent ? "danger" : "neutral"} label="Absent" value={count(data.totals.absent)} note="loss-of-pay days" />
              <StatTile size="sm" icon="calendar" tone="info" label="Leave · week offs" value={`${data.totals.leave} · ${data.totals.weekOffs}`} />
              <StatTile size="sm" icon="timer" tone={data.totals.lateDays ? "warning" : "neutral"} label="Late arrivals" value={count(data.totals.lateDays)} note={`${hoursText(data.totals.overtimeHours)} overtime`} />
              <StatTile size="sm" icon="clipboard" tone={data.totals.unmarked ? "warning" : "success"} label="Days not marked" value={count(data.totals.unmarked)} note="past days with nothing recorded" />
            </div>

            <DataGrid
              id="muster-roll"
              caption={`Attendance register for ${monthWords(month)}`}
              columns={[
                {
                  key: "name",
                  header: "Employee",
                  value: (row) => row.name,
                  mobile: "title",
                  pin: true,
                  render: (row) => (
                    <span className="acc-who-text">
                      <strong>{row.name}</strong>
                      <span className="muted small">{row.designation || DEPARTMENTS[row.department]}</span>
                    </span>
                  ),
                },
                // One narrow column per day of the month: the register's
                // letter, a button to correct it for a manager.
                ...data.days.map((date) => ({
                  key: `d${date.slice(8)}`,
                  header: (
                    <span className={`asw-muster-day ${isSunday(date) ? "is-sunday" : ""} ${date === data.today ? "is-today" : ""}`}>
                      <span>{Number(date.slice(8))}</span>
                      <small>{weekdayOf(date)}</small>
                    </span>
                  ),
                  label: dayWords(date),
                  value: (row) => `${row.cells[date].code || ""}${row.cells[date].late ? " late" : ""}`,
                  align: "center",
                  // Room for "WO" inside the grid's cell padding.
                  minWidth: 60,
                  width: 64,
                  sortable: false,
                  filter: "none",
                  searchable: false,
                  hideable: false,
                  render: (row) => {
                    const value = row.cells[date];
                    const editable = canManage && !["not_employed", "future"].includes(value.status);

                    return (
                      <div className={`asw-muster-cell is-${value.status} ${isSunday(date) ? "is-sunday" : ""}`}>
                        {editable ? (
                          <button
                            type="button"
                            className="asw-muster-button"
                            onClick={() => setCell({ row, date, value })}
                            aria-label={`${row.name}, ${dayWords(date)}: ${STATUSES[value.status] || "not marked"}${value.late ? ", late" : ""}`}
                            title={`${STATUSES[value.status] || "Not marked"}${value.leaveType ? ` (${value.leaveType})` : ""}${value.late ? ` · ${value.lateMinutes} min late` : ""}`}
                          >
                            {value.code || "·"}
                            {value.late && <span className="asw-late-mark" aria-hidden="true" />}
                          </button>
                        ) : (
                          <span className="asw-muster-static" title={STATUSES[value.status] || ""}>
                            {value.code}
                            {value.late && <span className="asw-late-mark" aria-hidden="true" />}
                          </span>
                        )}
                      </div>
                    );
                  },
                })),
                { key: "present", header: "P", label: "Present", type: "number", value: (row) => row.totals.present, total: "sum", width: 56 },
                { key: "halfDays", header: "½", label: "Half days", type: "number", value: (row) => row.totals.halfDays, total: "sum", width: 56, render: (row) => row.totals.halfDays || "" },
                {
                  key: "absent",
                  header: "A",
                  label: "Absent",
                  type: "number",
                  value: (row) => row.totals.absent,
                  total: "sum",
                  width: 56,
                  render: (row) => (row.totals.absent ? <strong className="text-danger">{row.totals.absent}</strong> : ""),
                },
                { key: "leave", header: "L", label: "Leave", type: "number", value: (row) => row.totals.leave, total: "sum", width: 56, render: (row) => row.totals.leave || "" },
                { key: "weekOffs", header: "WO", label: "Week offs", type: "number", value: (row) => row.totals.weekOffs, total: "sum", width: 56, render: (row) => row.totals.weekOffs || "" },
                {
                  key: "lateDays",
                  header: "Late",
                  label: "Late days",
                  type: "number",
                  value: (row) => row.totals.lateDays,
                  total: "sum",
                  width: 60,
                  render: (row) => (row.totals.lateDays ? <strong style={LATE_STYLE}>{row.totals.lateDays}</strong> : ""),
                },
                { key: "overtime", header: "OT", label: "Overtime hours", type: "number", value: (row) => row.totals.overtimeHours, csv: (row) => row.totals.overtimeHours, width: 84, render: (row) => (row.totals.overtimeHours ? hoursFromDecimal(row.totals.overtimeHours) : "") },
              ]}
              rows={data.rows}
              rowKey={(row) => row.employeeId}
              // A register is read across: the month stays a table on a
              // phone, scrolling sideways under the pinned names.
              cardsBelow={0}
              rowNoun={["person", "people"]}
              // No grid export: the CSV and Print buttons above give the
              // register's own layout (every day's letter and the totals).
            />
          </>
        )}
      </SectionCard>

      {cell && (
        <DayFix
          cell={cell}
          leaveTypes={leaveTypes}
          onClose={() => setCell(null)}
          onSaved={() => {
            setCell(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// One day, opened from the register to correct. The same rules as the day
// sheet: a paid period is closed, a time-clock day is corrected on the clock,
// leave over the allowance is warned about first.
function DayFix({ cell, leaveTypes, onClose, onSaved }) {
  const { row, date, value } = cell;
  const [status, setStatus] = useState(["present", "absent", "half_day", "leave", "week_off"].includes(value.status) ? value.status : "present");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState(() => {
    const match = leaveTypes.find((type) => type.name === value.leaveType) || leaveTypes.find((type) => type.isDefault);
    return match ? String(match.id) : "";
  });
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (accept = false) => {
    setBusy(true);
    setError("");

    try {
      await saveAttendance({
        employeeId: row.employeeId,
        attendanceDate: date,
        attendanceStatus: status,
        checkInTime: ["present", "half_day"].includes(status) ? checkIn || null : null,
        checkOutTime: ["present", "half_day"].includes(status) ? checkOut || null : null,
        leaveTypeId: status === "leave" && leaveTypeId ? Number(leaveTypeId) : null,
        acceptOverAllowance: accept,
      });
      onSaved();
    } catch (err) {
      if (err.response?.data?.data?.reason === "leave_over_allowance") {
        setWarning(err.response.data.message);
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${row.name} · ${dayWords(date)}`} description="Correct this day. Hours, lateness and overtime are worked out again." icon="edit" onClose={onClose} width={480}>
      {value.clocked ? (
        <div className="stack">
          <p>
            This day was recorded on the time clock, so it is corrected there, as a punch with a reason — the record keeps
            what the tablet saw.
          </p>
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Close
            </button>
            <Link className="button" to={`/staff/timeclock?tab=day&date=${date}`}>
              <Icon name="clock" size={15} /> Open the time clock
            </Link>
          </div>
        </div>
      ) : (
        <div className="form-grid">
          <ErrorMessage message={error} />
          <label className="field field-wide">
            <span>Status</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setWarning("");
              }}
            >
              {Object.entries(STATUSES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {["present", "half_day"].includes(status) && (
            <>
              <label className="field">
                <span>In</span>
                <input type="time" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} />
              </label>
              <label className="field">
                <span>Out</span>
                <input type="time" value={checkOut} onChange={(event) => setCheckOut(event.target.value)} />
                <small className="muted">Earlier than In means after midnight</small>
              </label>
            </>
          )}
          {status === "leave" && leaveTypes.length > 0 && (
            <label className="field field-wide">
              <span>Leave type</span>
              <select
                value={leaveTypeId}
                onChange={(event) => {
                  setLeaveTypeId(event.target.value);
                  setWarning("");
                }}
              >
                {leaveTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                    {type.paid ? "" : " (unpaid)"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {warning && (
            <div className="alert alert-notice field-wide" role="alert">
              {warning}
            </div>
          )}
          <div className="form-actions field-wide">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            {warning ? (
              <button type="button" className="button asw-button-warning" onClick={() => save(true)} disabled={busy}>
                {busy ? "Saving…" : "Save anyway — unpaid"}
              </button>
            ) : (
              <button type="button" className="button" onClick={() => save(false)} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
