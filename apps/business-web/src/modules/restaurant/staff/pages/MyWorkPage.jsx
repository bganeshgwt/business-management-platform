import { useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getMyPayslip, getMyWork } from "../../../../services/auth.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, moneyExact } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import useAuth from "../../../../hooks/useAuth";
import "../../../../styles/access.css";
import "../../../../styles/access-sweep.css";
import { hoursFromDecimal, hoursFromMinutes } from "./hoursText";

// My work: your own shifts this week and next, this month's attendance, the
// leave you have left, and your payslips once paid. Found through your own
// login's link to your staff record, so it needs no staff permissions and
// shows nobody else's.

const STATUS = {
  present: { label: "Present", tone: "success" },
  half_day: { label: "Half day", tone: "info" },
  absent: { label: "Absent", tone: "danger" },
  leave: { label: "Leave", tone: "warning" },
  week_off: { label: "Week off", tone: "neutral" },
};

const METHODS = { cash: "Cash", bank: "Bank transfer", upi: "UPI", cheque: "Cheque" };

const weekday = (date) => new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short" });
const dayNumber = (date) => new Date(`${date}T00:00:00`).getDate();
// "6 Oct" / "6 Oct 2026" (the en-IN locale spells September "Sept").
const dayMonth = (date) => dateShort(date);
const fullDate = (date) => dateShort(date, { year: true });
const monthName = (date) => new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const hours = hoursFromMinutes;
const days = (value) => (Number.isInteger(value) ? String(value) : Number(value).toFixed(1));

export default function MyWorkPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [slip, setSlip] = useState(null);

  useEffect(() => {
    getMyWork()
      .then(setData)
      .catch((err) =>
        setError({ message: getErrorMessage(err), notLinked: err.response?.data?.data?.reason === "not_linked" })
      );
  }, []);

  const openSlip = (row) => {
    setSlip({ row, detail: null });
    getMyPayslip(row.id)
      .then((detail) => setSlip({ row, detail }))
      .catch((err) => setSlip({ row, detail: null, error: getErrorMessage(err) }));
  };

  // A login not linked to a staff record: a friendly note, not an error.
  if (data && data.linked === false) {
    return (
      <div className="stack acc-page">
        <PageHeader icon="calendar" title="My work" description="Your shifts, attendance, leave and payslips." />
        <SectionCard flush>
          <EmptyState
            icon="user"
            message="Your login is not linked to a staff record yet"
            hint="So there is no roster or pay to show. Ask your manager to link it under Staff → Employees."
          />
        </SectionCard>
      </div>
    );
  }

  if (error) {
    return (
      <div className="stack acc-page">
        <PageHeader icon="calendar" title="My work" description="Your shifts, attendance, leave and payslips." />
        {error.notLinked ? (
          <SectionCard flush>
            <EmptyState icon="user" message="Your login is not linked to a staff record yet" hint={error.message} />
          </SectionCard>
        ) : (
          <ErrorMessage message={error.message} />
        )}
      </div>
    );
  }

  if (!data) {
    return <Loading label="Opening your shifts and pay…" />;
  }

  const month = data.month;

  return (
    <div className="stack acc-page asw-mywork">
      <PageHeader
        icon="calendar"
        title="My work"
        eyebrow={[data.employee.designation, data.employee.outletName].filter(Boolean).join(" · ") || undefined}
        description={`${data.employee.name}${data.employee.employeeCode ? ` · staff code ${data.employee.employeeCode}` : ""}. Your shifts, this month's attendance, your leave and your payslips.`}
      />

      {data.weeks.map((week) => (
        <SectionCard key={week.from} icon="calendar" title={week.label} description={`${dayMonth(week.from)} – ${dayMonth(week.to)}`}>
          <ol className="asw-week-strip">
            {week.days.map((day) => (
              <li key={day.date} className={`asw-day is-${day.status} ${day.today ? "is-today" : ""} motion-item`}>
                <span className="asw-day-name">
                  {weekday(day.date)} <strong>{dayNumber(day.date)}</strong>
                </span>
                {day.status === "scheduled" ? (
                  <>
                    <span className="asw-day-shift">{day.shiftName}</span>
                    <span className="asw-day-time">
                      {day.startTime}–{day.endTime}
                    </span>
                  </>
                ) : day.status === "week_off" ? (
                  <span className="asw-day-shift">Week off</span>
                ) : day.status === "leave" ? (
                  <span className="asw-day-shift">{day.leaveType ? `${day.leaveType} leave` : "Leave"}</span>
                ) : (
                  <span className="asw-day-shift muted">Not on the roster</span>
                )}
                {day.today && <span className="asw-day-today">Today</span>}
              </li>
            ))}
          </ol>
        </SectionCard>
      ))}

      <SectionCard icon="clipboard" title={`Attendance · ${monthName(month.from)}`} description="As the attendance sheet and the time clock recorded it so far this month.">
        <div className="stack">
          <div className="asw-muster-tiles">
            <StatTile size="sm" icon="check-circle" tone="success" label="Days present" value={String(month.present)} note={month.halfDays ? `+ ${month.halfDays} half day${month.halfDays === 1 ? "" : "s"}` : "full days"} />
            <StatTile size="sm" icon="timer" tone={month.lateDays ? "warning" : "neutral"} label="Late marks" value={String(month.lateDays)} note={month.lateMinutes ? `${hoursFromMinutes(month.lateMinutes)} in all` : "on time every day"} />
            <StatTile size="sm" icon="clock" tone="info" label="Hours worked" value={hoursFromDecimal(month.workedHours)} note={month.overtimeHours ? `${hoursFromDecimal(month.overtimeHours)} overtime` : "no overtime"} />
            <StatTile size="sm" icon="calendar" tone="neutral" label="Off" value={`${month.weekOffs + month.leave}`} note={`${month.weekOffs} week off · ${month.leave} leave${month.absent ? ` · ${month.absent} absent` : ""}`} />
          </div>
          {month.days.length === 0 ? (
            <p className="muted small">Nothing recorded yet this month.</p>
          ) : (
            <ul className="asw-attendance-list">
              {month.days.slice(0, 31).map((day) => {
                const status = STATUS[day.status] || { label: day.status, tone: "neutral" };

                return (
                  <li key={day.date}>
                    <span className="asw-att-date">
                      {weekday(day.date)} {dayMonth(day.date)}
                    </span>
                    <span className={`badge status-badge asw-tone-${status.tone}`}>
                      <span className="badge-dot" aria-hidden="true" />
                      {status.label}
                      {day.leaveType ? ` · ${day.leaveType}` : ""}
                    </span>
                    <span className="asw-att-times small muted">
                      {day.checkIn ? `${day.checkIn}–${day.checkOut || "…"}` : ""}
                      {day.workedMinutes ? ` · ${hours(day.workedMinutes)}` : ""}
                    </span>
                    {day.lateMinutes > 0 && <span className="small text-danger">{day.lateMinutes} min late</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SectionCard>

      {data.leave && (
        <SectionCard icon="calendar" title="Leave left" description="Paid leave up to each allowance; days over it are unpaid.">
          <ul className="asw-leave-cards">
            {data.leave.map((type) => (
              <li key={type.typeId} className="motion-item">
                <span className="asw-leave-name">{type.name}</span>
                {type.paid ? (
                  <>
                    <strong className={`asw-leave-left ${type.left < 1 ? "is-empty" : ""}`}>{days(Math.max(0, type.left))}</strong>
                    <span className="muted small">
                      of {days(type.available)} left in {type.periodLabel}
                      {type.carriedIn ? ` (${days(type.carriedIn)} carried in)` : ""}
                    </span>
                  </>
                ) : (
                  <span className="muted small">Unpaid · {type.taken} taken in {type.periodLabel}</span>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard icon="wallet" title="Payslips" description="Each pay period once it is marked paid." flush>
        {data.payslips.length === 0 ? (
          <EmptyState icon="wallet" message="No payslips yet" hint="Your payslip shows here once your pay for a period is marked paid." />
        ) : (
          <ul className="asw-slip-list">
            {data.payslips.map((row) => (
              <li key={row.id} className="motion-item">
                <span className="asw-slip-period">
                  <strong>
                    {fullDate(row.periodFrom)} – {fullDate(row.periodTo)}
                  </strong>
                  <span className="muted small">
                    Paid {fullDate(row.paidOn)} · {METHODS[row.paymentMethod] || row.paymentMethod}
                  </span>
                </span>
                <strong className="asw-slip-net">{moneyExact(row.amountPaid)}</strong>
                <button type="button" className="chip-button" onClick={() => openSlip(row)}>
                  <Icon name="receipt" size={14} /> Payslip
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {slip && <PayslipModal slip={slip} restaurantName={user.restaurantName} onClose={() => setSlip(null)} />}
    </div>
  );
}

function PayslipModal({ slip, restaurantName, onClose }) {
  const detail = slip.detail;
  const lines = detail
    ? [
        ["Payable days", days(detail.payableDays)],
        ["Leave (paid)", days(detail.paidLeaveDays)],
        ["Leave (unpaid)", days(detail.unpaidLeaveDays)],
        ["Earned", moneyExact(detail.earned)],
        ["Bonus", `+ ${moneyExact(detail.bonus)}`],
        ...(detail.tips ? [["Tips", `+ ${moneyExact(detail.tips)}`]] : []),
        ["Advances", `− ${moneyExact(detail.advances)}`],
        ["Deductions", `− ${moneyExact(detail.deductions)}`],
        ...(detail.pfEmployee ? [["Provident fund (PF)", `− ${moneyExact(detail.pfEmployee)}`]] : []),
        ...(detail.esiEmployee ? [["ESI", `− ${moneyExact(detail.esiEmployee)}`]] : []),
        ...(detail.professionalTax ? [["Professional tax", `− ${moneyExact(detail.professionalTax)}`]] : []),
      ]
    : [];

  const print = () =>
    printDocument({
      title: `Payslip ${detail.periodFrom} to ${detail.periodTo}`,
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; max-width: 520px; }
        h1 { font-size: 18px; margin: 0; } .muted { color: #555; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        td { padding: 4px 0; border-bottom: 1px solid #ddd; } .r { text-align: right; }
      `,
      body: `
        <h1>${escapeHtml(restaurantName || "")}</h1>
        <div class="muted">Payslip · ${escapeHtml(fullDate(detail.periodFrom))} to ${escapeHtml(fullDate(detail.periodTo))}</div>
        <h2>${escapeHtml(detail.employee.name)}${detail.employee.employeeCode ? ` · ${escapeHtml(detail.employee.employeeCode)}` : ""}</h2>
        <table>
          ${lines.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td class="r">${escapeHtml(value)}</td></tr>`).join("")}
          <tr><td><b>Net pay</b></td><td class="r"><b>${escapeHtml(moneyExact(detail.netPay))}</b></td></tr>
          <tr><td>Paid on ${escapeHtml(fullDate(detail.paidOn))} (${escapeHtml(METHODS[detail.paymentMethod] || detail.paymentMethod)})</td><td class="r">${escapeHtml(moneyExact(detail.amountPaid))}</td></tr>
        </table>
      `,
    });

  return (
    <Modal
      title="Payslip"
      description={`${fullDate(slip.row.periodFrom)} – ${fullDate(slip.row.periodTo)}`}
      icon="receipt"
      onClose={onClose}
      width={480}
    >
      {slip.error ? (
        <ErrorMessage message={slip.error} />
      ) : !detail ? (
        <Loading />
      ) : (
        <div className="stack">
          <ul className="asw-slip-lines">
            {lines.map(([label, value]) => (
              <li key={label}>
                <span>{label}</span>
                <span>{value}</span>
              </li>
            ))}
            <li className="is-total">
              <span>Net pay</span>
              <span>{moneyExact(detail.netPay)}</span>
            </li>
            <li>
              <span>
                Paid on {fullDate(detail.paidOn)} · {METHODS[detail.paymentMethod] || detail.paymentMethod}
              </span>
              <span>{moneyExact(detail.amountPaid)}</span>
            </li>
          </ul>
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={print}>
              <Icon name="print" size={15} /> Print
            </button>
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
