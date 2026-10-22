import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import FormField from "../../../../components/FormField";
import {
  addPayrollAdjustment,
  deletePayrollAdjustment,
  deletePayrollPayment,
  getPayroll,
  recordPayrollPayment,
  recordPayrollPaymentsBulk,
  savePayrollSettings,
} from "../services/staff.service";
import { getTips } from "../services/tip.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart, today } from "@bmp/shared/dates";
import { dateShort, money, moneyExact } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { downloadCsv } from "../../../../services/csv";
import { escapeHtml, printDocument } from "../../../../services/print";
import useAuth from "../../../../hooks/useAuth";
import { Link } from "react-router-dom";
import { StatutorySettingsModal, StatutorySummary } from "./StatutoryPanel";
import "../../../../styles/access.css";
import "../../../../styles/access-sweep.css";
import "../styles/payroll.css";

const SALARY_TYPES = { monthly: "Monthly", daily: "Daily wage", hourly: "Hourly" };
const KINDS = {
  advance: { label: "Advance", hint: "Cash given now, taken back from this period's pay" },
  deduction: { label: "Deduction", hint: "A fine, breakage, canteen or uniform charge" },
  bonus: { label: "Bonus", hint: "An incentive or festival bonus added to this period's pay" },
  // Written only by "Mark paid", when part of the pay was held back.
  arrears: { label: "Pay owed", hint: "Pay held back from an earlier period" },
};
// What a person can record by hand.
const ENTRY_KINDS = ["advance", "deduction", "bonus"];
const METHODS = { cash: "Cash", bank: "Bank transfer", upi: "UPI", cheque: "Cheque" };

// First and last day of the month before the one `date` falls in.
const lastMonth = () => {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);

  return { from: first.toLocaleDateString("en-CA"), to: last.toLocaleDateString("en-CA") };
};

// "September" for a whole calendar month, else null.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (from, to) => {
  if (!from || !to || from.slice(8) !== "01" || from.slice(0, 7) !== to.slice(0, 7)) {
    return null;
  }

  const [year, month] = from.split("-").map(Number);
  const last = new Date(year, month, 0).getDate();
  return Number(to.slice(8)) === last ? MONTHS[month - 1] : null;
};

// Salaries for a month are paid in the first days of the next one. Until the
// 15th the page opens on last month while anyone in it is still unpaid.
const PAYDAY_WINDOW_ENDS = 15;

// What a person's bank transfer is: the full net pay of an unpaid row (none
// when advances are more than the pay), or what was paid.
const transferAmount = (row) => (row.paid ? row.paid.amountPaid : Math.max(0, row.netPay));
const sumPaise = (values) => values.reduce((total, value) => total + Math.round(Number(value || 0) * 100), 0) / 100;

const PERIODS = [
  { key: "this", label: "This month", range: () => ({ from: monthStart(), to: today() }) },
  { key: "last", label: "Last month", range: lastMonth },
];

// "1 Sep 2026" (the en-IN locale spells September "Sept").
const dayLabel = (value) => dateShort(value, { year: true });

const days = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

// The whole day count in words, for the Days cell's tooltip (the cell's
// short form wraps; this never truncates).
const dayBreakdown = (row) =>
  [
    `${days(row.payableDays)} payable days`,
    `${row.presentDays} present`,
    row.halfDays ? `${row.halfDays} half days` : "",
    row.weekOffs ? `${row.weekOffs} week offs${row.paidWeekOffs ? " (paid)" : " (unpaid)"}` : "",
    row.paidLeaveDays ? `${row.paidLeaveDays} paid leave` : "",
    row.unpaidLeaveDays ? `${row.unpaidLeaveDays} unpaid leave` : "",
    row.absentDays ? `${row.absentDays} absent` : "",
  ]
    .filter(Boolean)
    .join(" · ");

// "−₹1,177.42" rather than "₹-1,177.42" when the advances are more than the pay.
const signed = (format, value, currency) => (value < 0 ? `−${format(-value, currency)}` : format(value, currency));

export default function PayrollPage() {
  const { user, hasFeature } = useAuth();
  // Before the 15th, start on last month (the one being paid now); the first
  // load switches to this month if everyone in it is already paid.
  const opensOnLastMonth = new Date().getDate() < PAYDAY_WINDOW_ENDS;
  const autoPeriod = useRef(opensOnLastMonth);
  const [from, setFrom] = useState(() => (opensOnLastMonth ? lastMonth().from : monthStart()));
  const [to, setTo] = useState(() => (opensOnLastMonth ? lastMonth().to : today()));
  const [tipsWaiting, setTipsWaiting] = useState(0);
  const [payingAll, setPayingAll] = useState(false);
  const [payAllForm, setPayAllForm] = useState({ paymentMethod: "bank", paidOn: today(), reference: "", note: "" });
  const [data, setData] = useState(null);
  const [currency, setCurrency] = useState("₹");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [adjusting, setAdjusting] = useState(null);
  const [adjustForm, setAdjustForm] = useState({ kind: "advance", amount: "", date: today(), note: "" });
  const [paying, setPaying] = useState(null);
  const [payForm, setPayForm] = useState({ amountPaid: "", paymentMethod: "bank", paidOn: today(), reference: "", note: "" });
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [statutoryOpen, setStatutoryOpen] = useState(false);

  const load = useCallback(
    () =>
      getPayroll({ from, to })
        .then((result) => {
          // Opened on last month and everyone in it is paid: show this month.
          if (autoPeriod.current) {
            autoPeriod.current = false;

            if (result.totals.paidCount >= result.totals.headcount) {
              setFrom(monthStart());
              setTo(today());
              return; // still loading: this month's sheet follows
            }
          }

          setData(result);
          setError("");
          setLoading(false);
        })
        .catch((err) => {
          setError(getErrorMessage(err));
          setLoading(false);
        }),
    [from, to]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Tips collected in the period and not yet shared out: they belong in this
  // pay (Staff -> Tips shares them; the shares then appear in the Tips column).
  const tipsOn = hasFeature("tips");

  useEffect(() => {
    if (!tipsOn) {
      return undefined;
    }

    let live = true;
    getTips({ from, to })
      .then((result) => live && setTipsWaiting(Number(result?.totals?.unshared || 0)))
      .catch(() => live && setTipsWaiting(0));

    return () => {
      live = false;
    };
  }, [from, to, tipsOn]);

  useEffect(() => {
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);
  }, []);

  const activePeriod = PERIODS.find((period) => {
    const range = period.range();
    return range.from === from && range.to === to;
  });

  const setRange = (range) => {
    autoPeriod.current = false;
    setFrom(range.from);
    setTo(range.to);
  };

  const togglePolicy = async (field) => {
    setError("");

    try {
      await savePayrollSettings({ ...data.settings, [field]: !data.settings[field] });
      setSuccess("Pay policy saved. Figures below are updated.");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const openAdjust = (row, kind = "advance") => {
    setAdjustForm({ kind, amount: "", date: to > today() ? today() : to, note: "" });
    setFormError("");
    setAdjusting(row);
  };

  const submitAdjust = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      await addPayrollAdjustment({
        employeeId: adjusting.employeeId,
        kind: adjustForm.kind,
        amount: Number(adjustForm.amount),
        date: adjustForm.date,
        note: adjustForm.note,
      });
      setSuccess(`${KINDS[adjustForm.kind].label} of ${money(adjustForm.amount, currency)} recorded for ${adjusting.name}`);
      setAdjusting(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openPay = (row) => {
    setPayForm({
      amountPaid: String(Math.max(0, row.netPay)),
      paymentMethod: "bank",
      paidOn: today(),
      reference: "",
      note: "",
    });
    setFormError("");
    setPaying(row);
  };

  const submitPay = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      await recordPayrollPayment({
        employeeId: paying.employeeId,
        from,
        to,
        amountPaid: Number(payForm.amountPaid || 0),
        paymentMethod: payForm.paymentMethod,
        paidOn: payForm.paidOn,
        reference: payForm.reference || undefined,
        note: payForm.note || undefined,
      });
      setSuccess(`${paying.name} marked paid for ${dayLabel(from)} to ${dayLabel(to)}`);
      setPaying(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const runConfirmed = async () => {
    setSaving(true);

    try {
      await confirm.run();
      setSuccess(confirm.done);
      setConfirm(null);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () => {
    if (!data) {
      return;
    }

    downloadCsv(
      [
        ["Employee", "Code", "Department", "Salary type", "Salary", "Present", "Half days", "Week offs",
         "Paid week offs", "Leave", "Paid leave", "Unpaid leave", "Absent", "Payable days", "Hours", "Overtime hours",
         "Earned", "Bonus", "Tips", "Advances", "Deductions", "PF", "ESI", "Professional tax", "Net pay",
         "PF employer", "ESI employer", "Paid", "Paid on"],
        ...data.employees.map((row) => [
          row.name, row.employeeCode, row.department, row.salaryType, row.salaryAmount,
          row.presentDays, row.halfDays, row.weekOffs, row.paidWeekOffs, row.leaveDays, row.paidLeaveDays,
          row.unpaidLeaveDays, row.absentDays, row.payableDays, row.workedHours, row.overtimeHours, row.estimatedPay,
          row.bonus, row.tips, row.advances, row.deductions, row.pfEmployee, row.esiEmployee, row.professionalTax,
          row.netPay, row.pfEmployer, row.esiEmployer,
          row.paid ? row.paid.amountPaid : "", row.paid ? row.paid.paidOn : "",
        ]),
      ],
      `payroll-${from}-to-${to}.csv`
    );
  };

  // A payslip for one person and period, on the restaurant's printer. A paid
  // period prints what was paid; an open one, the figures as they stand.
  const printSlip = (row) => {
    const line = (label, value, strong = false) =>
      `<tr><td>${escapeHtml(label)}</td><td class="r">${strong ? "<b>" : ""}${escapeHtml(value)}${strong ? "</b>" : ""}</td></tr>`;
    const figures = row.paid
      ? {
          earned: row.paid.earned,
          bonus: row.paid.bonus,
          tips: row.paid.tips,
          advances: row.paid.advances,
          deductions: row.paid.deductions,
          pfEmployee: row.paid.pfEmployee,
          esiEmployee: row.paid.esiEmployee,
          professionalTax: row.paid.professionalTax,
          pfEmployer: row.paid.pfEmployer,
          esiEmployer: row.paid.esiEmployer,
          netPay: row.paid.netPay,
          paidLeaveDays: row.paid.paidLeaveDays,
          unpaidLeaveDays: row.paid.unpaidLeaveDays,
        }
      : {
          earned: row.estimatedPay,
          bonus: row.bonus,
          tips: row.tips,
          advances: row.advances,
          deductions: row.deductions,
          pfEmployee: row.pfEmployee,
          esiEmployee: row.esiEmployee,
          professionalTax: row.professionalTax,
          pfEmployer: row.pfEmployer,
          esiEmployer: row.esiEmployer,
          netPay: row.netPay,
          paidLeaveDays: row.paidLeaveDays,
          unpaidLeaveDays: row.unpaidLeaveDays,
        };

    printDocument({
      title: `Payslip ${row.name} ${from} to ${to}`,
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; max-width: 520px; }
        h1 { font-size: 18px; margin: 0; } h2 { font-size: 13px; margin: 14px 0 4px; }
        .muted { color: #555; } table { width: 100%; border-collapse: collapse; }
        td { padding: 4px 0; border-bottom: 1px solid #ddd; } .r { text-align: right; }
        .sign { margin-top: 40px; display: flex; justify-content: space-between; }
      `,
      body: `
        <h1>${escapeHtml(user.restaurantName || "")}</h1>
        <div class="muted">Payslip · ${escapeHtml(dayLabel(from))} to ${escapeHtml(dayLabel(to))}</div>
        <h2>${escapeHtml(row.name)}${row.employeeCode ? ` · ${escapeHtml(row.employeeCode)}` : ""}</h2>
        <div class="muted">${escapeHtml(row.designation || "")} · ${escapeHtml(SALARY_TYPES[row.salaryType])} ${escapeHtml(moneyExact(row.salaryAmount, currency))}</div>
        <h2>Days</h2>
        <table>
          ${line("Present", days(row.presentDays))}
          ${line("Half days", days(row.halfDays))}
          ${line(`Week offs${row.paidWeekOffs ? " (paid)" : ""}`, days(row.weekOffs))}
          ${line("Leave (paid)", days(figures.paidLeaveDays))}
          ${line("Leave (unpaid — loss of pay)", days(figures.unpaidLeaveDays))}
          ${line("Absent (loss of pay)", days(row.absentDays))}
          ${line("Payable days", days(row.payableDays), true)}
        </table>
        <h2>Pay</h2>
        <table>
          ${line("Earned", moneyExact(figures.earned, currency))}
          ${line("Bonus", `+ ${moneyExact(figures.bonus, currency)}`)}
          ${figures.tips ? line("Tips", `+ ${moneyExact(figures.tips, currency)}`) : ""}
          ${line("Advances", `− ${moneyExact(figures.advances, currency)}`)}
          ${line("Deductions", `− ${moneyExact(figures.deductions, currency)}`)}
          ${figures.pfEmployee ? line("Provident fund (PF)", `− ${moneyExact(figures.pfEmployee, currency)}`) : ""}
          ${figures.esiEmployee ? line("ESI", `− ${moneyExact(figures.esiEmployee, currency)}`) : ""}
          ${figures.professionalTax ? line("Professional tax", `− ${moneyExact(figures.professionalTax, currency)}`) : ""}
          ${line("Net pay", signed(moneyExact, figures.netPay, currency), true)}
          ${row.paid ? line(`Paid on ${dayLabel(row.paid.paidOn)} (${METHODS[row.paid.paymentMethod]})`, moneyExact(row.paid.amountPaid, currency), true) : ""}
          ${row.paid
            ? row.paid.carried
                .map((item) =>
                  line(
                    item.kind === "advance" ? "Advance still to recover (next pay period)" : "Pay still owed (next pay period)",
                    moneyExact(item.amount, currency)
                  )
                )
                .join("")
            : ""}
        </table>
        ${figures.pfEmployer || figures.esiEmployer
          ? `<p class="muted">Paid by the restaurant on top of your pay: ${[
              figures.pfEmployer ? `PF ${escapeHtml(moneyExact(figures.pfEmployer, currency))}` : "",
              figures.esiEmployer ? `ESI ${escapeHtml(moneyExact(figures.esiEmployer, currency))}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}${row.uan ? ` · UAN ${escapeHtml(row.uan)}` : ""}${row.esiNumber ? ` · ESI no. ${escapeHtml(row.esiNumber)}` : ""}</p>`
          : ""}
        <div class="sign"><span>Employee signature</span><span>For ${escapeHtml(user.restaurantName || "the restaurant")}</span></div>
      `,
    });
  };

  // The PF · ESI · PT column shows while the setting is on, and also when it
  // is off but someone was already paid with deductions (a paid period keeps
  // what it was paid with, so its row must still show them).
  const statutorySetting = Boolean(
    data && data.statutory && (data.statutory.pfEnabled || data.statutory.esiEnabled || data.statutory.ptEnabled)
  );
  const statutoryOn = statutorySetting || Boolean(data && data.totals && data.totals.statutoryDeductions > 0);
  const showTips = Boolean(data && data.employees.some((row) => row.tips > 0));

  const actionsFor = (row) => [
    { label: "Add advance", icon: "minus", onClick: () => openAdjust(row, "advance") },
    { label: "Add deduction", icon: "tag", onClick: () => openAdjust(row, "deduction") },
    { label: "Add bonus", icon: "gift", onClick: () => openAdjust(row, "bonus") },
    { label: "Print payslip", icon: "print", onClick: () => printSlip(row) },
    ...(row.paid
      ? [
          { separator: true },
          {
            label: "Undo payment",
            icon: "undo",
            danger: true,
            onClick: () =>
              setConfirm({
                title: "Undo payment",
                message: `Undo the payment of ${money(row.paid.amountPaid, currency)} to ${row.name} for this period? Use this only if it was recorded by mistake.`,
                label: "Undo payment",
                done: `Payment to ${row.name} undone`,
                run: () => deletePayrollPayment(row.paid.id),
              }),
          },
        ]
      : []),
  ];

  const adjustments = useMemo(() => (data ? data.adjustments : []), [data]);

  // An entry inside a period already marked paid is part of that payment: the
  // server refuses to remove it, so the screen does not offer to.
  const inPaidPeriod = (item) => {
    const row = data && data.employees.find((employee) => employee.employeeId === item.employeeId);
    return Boolean(row && row.payments.some((payment) => payment.periodFrom <= item.date && payment.periodTo >= item.date));
  };

  // Everyone "Mark all paid" would pay: not paid, and no part of the period
  // paid already (that person is settled one by one).
  const unpaid = useMemo(() => (data ? data.employees.filter((row) => !row.paid && !row.partlyPaid) : []), [data]);
  const unpaidTotal = sumPaise(unpaid.map((row) => Math.max(0, row.netPay)));
  const periodNotOver = to > today();

  const openPayAll = () => {
    setPayAllForm({ paymentMethod: "bank", paidOn: today(), reference: "", note: "" });
    setFormError("");
    setPayingAll(true);
  };

  const submitPayAll = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      const result = await recordPayrollPaymentsBulk({
        employeeIds: unpaid.map((row) => row.employeeId),
        from,
        to,
        paymentMethod: payAllForm.paymentMethod,
        paidOn: payAllForm.paidOn,
        reference: payAllForm.reference || undefined,
        note: payAllForm.note || undefined,
        expectedTotal: unpaidTotal,
      });
      toast.success(
        `${result.data.count} ${result.data.count === 1 ? "person" : "people"} marked paid · ${moneyExact(result.data.total, currency)}`
      );
      setPayingAll(false);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // The bank's bulk-transfer (NEFT) sheet: one line per person to be paid,
  // with the account to pay into. People without bank details are listed
  // with blanks so nobody is left out silently.
  const exportBank = () => {
    if (!data) {
      return;
    }

    const lines = data.employees.filter((row) => transferAmount(row) > 0);

    if (lines.length === 0) {
      toast.info("Nobody has pay to transfer in this period.");
      return;
    }

    const missing = lines.filter((row) => !row.bankAccountNumber || !row.bankIfsc);

    downloadCsv(
      [
        ["Name on account", "Account number", "IFSC", "Amount", "Employee", "Employee code", "Narration"],
        ...lines.map((row) => [
          row.bankAccountName || row.name,
          row.bankAccountNumber || "",
          row.bankIfsc || "",
          transferAmount(row).toFixed(2),
          row.name,
          row.employeeCode || "",
          `Salary ${monthName(from, to) || `${from} to ${to}`}`,
        ]),
      ],
      `bank-transfers-${from}-to-${to}.csv`
    );

    if (missing.length > 0) {
      const names = missing.slice(0, 3).map((row) => row.name).join(", ");
      toast.error(
        `${missing.length} ${missing.length === 1 ? "person has" : "people have"} no bank account or IFSC (${names}${missing.length > 3 ? "…" : ""}). Add them in Staff, on each person's form.`
      );
    } else {
      toast.success(`Bank sheet saved · ${lines.length} transfers · ${moneyExact(sumPaise(lines.map(transferAmount)), currency)}`);
    }
  };

  const exportButton = (
    <button type="button" className="button button-secondary" onClick={exportCsv} disabled={!data}>
      <Icon name="download" size={16} /> Export CSV
    </button>
  );

  return (
    <div className="stack acc-page">
      <PageHeader
        icon="wallet"
        title="Payroll"
        description="Attendance turned into pay: paid week offs and leave, advances and deductions, and a record of what was paid."
        primary={
          unpaid.length > 0 && (
            <button
              type="button"
              className="button"
              onClick={openPayAll}
              disabled={periodNotOver}
              title={periodNotOver ? "This period has not ended yet" : undefined}
            >
              <Icon name="check-circle" size={16} /> Mark all paid…
            </button>
          )
        }
        secondary={exportButton}
        more={[{ label: "Export for bank (NEFT sheet)", icon: "download", onClick: exportBank }]}
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {tipsWaiting > 0 && (
        <p className="alert alert-notice acc-tips-waiting">
          <Icon name="gift" size={16} />
          <span>
            Tips waiting to share in this period: <strong>{moneyExact(tipsWaiting, currency)}</strong>
            {" · "}
            <Link to={`/staff/tips?from=${from}&to=${to}`}>Share out</Link>
          </span>
        </p>
      )}

      <div className="card acc-toolbar">
        <div className="filters">
          <label className="field">
            <span>From</span>
            <input type="date" value={from} max={to} onChange={(event) => { autoPeriod.current = false; setFrom(event.target.value); }} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={to} min={from} onChange={(event) => { autoPeriod.current = false; setTo(event.target.value); }} />
          </label>
          <div className="field">
            <span>Pay period</span>
            <div className="segmented" role="radiogroup" aria-label="Pay period">
              {PERIODS.map((period) => (
                <button
                  key={period.key}
                  type="button"
                  role="radio"
                  aria-checked={activePeriod?.key === period.key}
                  className={`segment ${activePeriod?.key === period.key ? "is-active" : ""}`}
                  onClick={() => setRange(period.range())}
                >
                  {period.label}
                </button>
              ))}
            </div>
          </div>
          <p className="filters-summary muted small">
            {monthName(from, to) ? (
              <>
                Paying for <strong>{monthName(from, to)}</strong> ({dayLabel(from)} – {dayLabel(to)})
                {data && data.from === from && data.to === to && data.totals.headcount > 0 && (
                  <> · {data.totals.paidCount} of {data.totals.headcount} paid</>
                )}
              </>
            ) : (
              <>Paying for {dayLabel(from)} – {dayLabel(to)}</>
            )}
          </p>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : !data ? (
        <EmptyState
          icon="wallet"
          message="No payroll data"
          hint="Pick a period above. Pay is worked out from the attendance marked in it."
        />
      ) : (
        <>
          <div className="stat-grid">
            <StatTile icon="users" tone="neutral" label="Employees" value={data.totals.headcount} note="in this period" />
            <StatTile
              icon="money"
              tone="primary"
              label="Earned"
              money={data.totals.estimatedPay}
              currency={currency}
              note={`${days(data.totals.payableDays)} payable days`}
            />
            <StatTile
              icon="minus"
              tone="warning"
              label="Advances & deductions"
              money={data.totals.advances + data.totals.deductions}
              currency={currency}
              note={data.totals.bonus > 0 ? `+ ${money(data.totals.bonus, currency)} bonus` : "taken off the pay"}
            />
            <StatTile
              icon="wallet"
              tone="success"
              label="Net to pay"
              money={data.totals.netPay}
              currency={currency}
              note={`earned + bonus${data.totals.tips ? " + tips" : ""} − advances − deductions${statutoryOn ? " − PF, ESI, PT" : ""}`}
            />
            <StatTile
              icon="check-circle"
              tone={data.totals.headcount > 0 && data.totals.paidCount === data.totals.headcount ? "success" : "info"}
              label="Marked paid"
              value={data.totals.paidCount}
              of={`/${data.totals.headcount}`}
              note={data.totals.paid > 0 ? `${money(data.totals.paid, currency)} paid` : "nobody paid yet"}
            />
          </div>

          <SectionCard
            icon="sliders"
            tone="info"
            title="Pay policy"
            description="Two choices that change everyone's figures below. They save as soon as you tick them."
            bodyClassName="acc-policy"
          >
            <p className="muted small">
              Monthly salaries are paid per calendar day: a full month with every day worked, off or on approved leave
              pays exactly the monthly salary. Absent days are loss of pay. Daily-wage and hourly staff are paid for
              days or hours worked. Overtime is listed, not paid automatically — add it as a bonus.
            </p>
            <div className="acc-policy-switches">
              <label className="checkbox">
                <input type="checkbox" checked={data.settings.weekOffsPaid} onChange={() => togglePolicy("weekOffsPaid")} />
                <span>Week offs are paid</span>
              </label>
              {data.employees.some((row) => row.leaveTypesInUse) ? (
                <span className="small asw-policy-note">
                  <Icon name="calendar" size={14} />
                  {/* One flex item, so the link stays inside the sentence. */}
                  <span>
                    Leave is paid up to each person's allowance (<Link to="/staff?tab=leave">leave types</Link>); over it
                    is loss of pay.
                  </span>
                </span>
              ) : (
                <label className="checkbox">
                  <input type="checkbox" checked={data.settings.leavePaid} onChange={() => togglePolicy("leavePaid")} />
                  <span>Approved leave is paid</span>
                </label>
              )}
              <button type="button" className="button button-secondary button-sm" onClick={() => setStatutoryOpen(true)}>
                <Icon name="percent" size={14} /> PF, ESI &amp; professional tax: {statutorySetting ? "on" : "off"}
              </button>
            </div>
          </SectionCard>

          <SectionCard
            icon="list"
            title="Pay sheet"
            description="Mark paid records the payment and closes the period for that person. Advances, bonuses and payslips are in each person's ⋯ menu."
            actions={
              data.employees.length > 0 && (
                <span className="acc-count">
                  {data.totals.paidCount} of {data.totals.headcount} paid
                  {unpaid.length > 0 && !periodNotOver && (
                    <>
                      {" · "}
                      <button type="button" className="link-button" onClick={openPayAll}>
                        Mark all paid…
                      </button>
                    </>
                  )}
                </span>
              )
            }
            flush
          >
            <DataGrid
              id="payroll-sheet"
              caption={`Pay sheet ${from} to ${to}`}
              columns={[
                {
                  key: "name",
                  header: "Employee",
                  width: 160,
                  value: (row) => row.name,
                  mobile: "title",
                  pin: true,
                  render: (row) => (
                    <span className="acc-who-text">
                      <strong>{row.name}</strong>
                      <span className="muted small">
                        {SALARY_TYPES[row.salaryType]} {money(row.salaryAmount, currency)}
                        {row.status !== "active" ? " · left" : ""}
                      </span>
                      {/* A new salary that started inside this period:
                          the days before it are paid at the old rate. */}
                      {(row.salaryChanges || []).map((change) => (
                        <span key={change.from} className="small acc-salary-change">
                          New salary from {dayLabel(change.from)}
                        </span>
                      ))}
                    </span>
                  ),
                },
                {
                  key: "days",
                  width: 176,
                  minWidth: 150,
                  className: "asw-log-cell",
                  header: "Days",
                  type: "number",
                  value: (row) => row.payableDays,
                  mobile: "show",
                  csv: (row) => row.payableDays,
                  render: (row) => (
                    <span className="small" title={dayBreakdown(row)}>
                      <strong>{days(row.payableDays)}</strong> payable
                      <span className="muted acc-block pay-days-split">
                        {row.presentDays}P
                        {row.halfDays ? ` · ${row.halfDays}½` : ""}
                        {row.weekOffs ? ` · ${row.weekOffs} off${row.paidWeekOffs ? "" : " (unpaid)"}` : ""}
                        {row.leaveDays
                          ? row.unpaidLeaveDays && row.paidLeaveDays
                            ? ` · ${row.paidLeaveDays} paid leave · ${row.unpaidLeaveDays} unpaid`
                            : ` · ${row.leaveDays} leave${row.paidLeaveDays ? "" : " (unpaid)"}`
                          : ""}
                        {row.absentDays ? <span className="text-danger">{` · ${row.absentDays}A`}</span> : ""}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "earned",
                  width: 112,
                  header: "Earned",
                  type: "money",
                  value: (row) => row.estimatedPay,
                  total: "sum",
                  mobile: "show",
                  render: (row) => <span className="nowrap">{money(row.estimatedPay, currency)}</span>,
                },
                {
                  key: "bonus",
                  width: 100,
                  header: "Bonus",
                  type: "money",
                  value: (row) => row.bonus,
                  total: "sum",
                  render: (row) => (row.bonus ? <span className="nowrap acc-money-plus">+{money(row.bonus, currency)}</span> : <span className="muted">—</span>),
                },
                showTips && {
                  key: "tips",
                  width: 100,
                  header: "Tips",
                  type: "money",
                  value: (row) => row.tips,
                  total: "sum",
                  render: (row) => (row.tips ? <span className="nowrap acc-money-plus">+{money(row.tips, currency)}</span> : <span className="muted">—</span>),
                },
                {
                  // One column, as on the "Advances & deductions" tile: what
                  // comes off before PF, ESI and PT (the pay file keeps both).
                  key: "advances",
                  width: 124,
                  header: <span title="Advances and deductions">Taken off</span>,
                  label: "Advances & deductions",
                  type: "money",
                  value: (row) => Math.round((row.advances + row.deductions) * 100) / 100,
                  total: "sum",
                  render: (row) =>
                    row.advances || row.deductions ? (
                      <span className="nowrap">
                        −{money(row.advances + row.deductions, currency)}
                        {row.advances > 0 && row.deductions > 0 && (
                          <>
                            <span className="muted small acc-block">advance {money(row.advances, currency)}</span>
                            <span className="muted small acc-block">deduction {money(row.deductions, currency)}</span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    ),
                },
                statutoryOn && {
                  key: "statutory",
                  header: "PF · ESI · PT",
                  width: 140,
                  className: "asw-log-cell",
                  type: "money",
                  value: (row) => row.statutoryDeductions,
                  total: "sum",
                  csv: (row) => row.statutoryDeductions,
                  render: (row) =>
                    row.statutoryDeductions ? (
                      <span
                        title={`PF ${moneyExact(row.pfEmployee, currency)} · ESI ${moneyExact(row.esiEmployee, currency)} · professional tax ${moneyExact(row.professionalTax, currency)}`}
                      >
                        −{money(row.statutoryDeductions, currency)}
                        {[
                          row.pfEmployee > 0 && `PF ${money(row.pfEmployee, currency)}`,
                          row.esiEmployee > 0 && `ESI ${money(row.esiEmployee, currency)}`,
                          row.professionalTax > 0 && `PT ${money(row.professionalTax, currency)}`,
                        ]
                          .filter(Boolean)
                          .map((line) => (
                            <span key={line} className="muted small acc-block">
                              {line}
                            </span>
                          ))}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    ),
                },
                {
                  key: "netPay",
                  width: 116,
                  header: "Net pay",
                  type: "money",
                  value: (row) => row.netPay,
                  total: "sum",
                  mobile: "show",
                  render: (row) => (
                    <span className="acc-net">
                      <strong className={row.netPay < 0 ? "text-danger" : ""}>{signed(money, row.netPay, currency)}</strong>
                      {row.netPay < 0 && !row.paid && (
                        <span className="small text-danger acc-block">advance exceeds pay · the rest moves to next period</span>
                      )}
                    </span>
                  ),
                },
                {
                  key: "paid",
                  header: "Paid",
                  width: 140,
                  className: "asw-log-cell",
                  type: "status",
                  value: (row) => (row.paid ? "paid" : row.partlyPaid ? "part paid" : "not paid"),
                  mobile: "show",
                  csv: (row) => (row.paid ? `Paid ${row.paid.amountPaid} on ${row.paid.paidOn}` : row.partlyPaid ? "Part of period paid" : "Not paid"),
                  render: (row) =>
                    row.paid ? (
                      <div className="acc-paid-cell">
                        <span className="badge badge-active status-badge" title={row.paid.reference || undefined}>
                          <span className="badge-dot" aria-hidden="true" />
                          Paid {dayLabel(row.paid.paidOn)}
                        </span>
                        <span className="small">{money(row.paid.amountPaid, currency)}</span>
                        {row.paid.carried.map((item) => (
                          <span key={item.id} className="small muted">
                            {item.kind === "advance" ? "Advance to recover" : "Still owed"} {money(item.amount, currency)} → next period
                          </span>
                        ))}
                        {row.changedSincePaid && (
                          <span
                            className="badge badge-warning status-badge"
                            title="Attendance or pay entries in this period changed after it was paid. Undo the payment and pay again, or settle the difference next period."
                          >
                            <span className="badge-dot" aria-hidden="true" />
                            Changed since paid · now {money(row.changedSincePaid.netNow, currency)}
                          </span>
                        )}
                      </div>
                    ) : row.partlyPaid ? (
                      <span className="badge badge-warning status-badge">
                        <span className="badge-dot" aria-hidden="true" />
                        Part of period paid
                      </span>
                    ) : (
                      <button type="button" className="chip-button" onClick={() => openPay(row)}>
                        <Icon name="check" size={14} /> Mark paid
                      </button>
                    ),
                },
                {
                  key: "actions",
                  header: "",
                  label: "Actions",
                  type: "actions",
                  render: (row) => (
                    <div className="row-actions">
                      <ActionMenu label={`More for ${row.name}`} items={actionsFor(row)} />
                    </div>
                  ),
                },
              ]}
              rows={data.employees}
              rowKey={(row) => row.employeeId}
              currency={currency}
              empty="No employees for this period"
              emptyIcon="users"
              emptyHint="Pay is listed for everyone who was on the staff list in these dates."
              rowClassName={(row) => (row.changedSincePaid ? "dg-tone-warning" : row.status !== "active" ? "dg-tone-muted" : "")}
              // No grid export here: "Export CSV" at the top of the page gives
              // the full pay file (every day count, PF and ESI employer parts,
              // paid on), which is what the accountant asks for.
            />
          </SectionCard>

          {statutoryOn && <StatutorySummary key={from.slice(0, 7)} initialMonth={from.slice(0, 7)} currency={currency} />}

          <SectionCard
            icon="receipt"
            tone="warning"
            title="Advances, deductions and bonuses"
            description="In this period. Add one from a person's ⋯ menu in the pay sheet."
            flush
          >
            <DataGrid
              id="payroll-adjustments"
              caption="Advances, deductions and bonuses"
              columns={[
                {
                  key: "date",
                  header: "Date",
                  type: "date",
                  value: (item) => item.date,
                  mobile: "subtitle",
                  render: (item) => <span className="nowrap small">{dayLabel(item.date)}</span>,
                },
                {
                  key: "employee",
                  header: "Employee",
                  value: (item) => item.employeeName,
                  mobile: "title",
                  pin: true,
                  render: (item) => <strong>{item.employeeName}</strong>,
                },
                {
                  key: "kind",
                  header: "Type",
                  type: "status",
                  value: (item) => KINDS[item.kind].label,
                  mobile: "show",
                  render: (item) => (
                    <>
                      <span className={`badge ${item.kind === "bonus" || item.kind === "arrears" ? "badge-active" : "badge-warning"}`}>
                        {KINDS[item.kind].label}
                      </span>
                      {item.carriedFromPaymentId && <div className="small muted">Carried forward</div>}
                    </>
                  ),
                },
                {
                  key: "amount",
                  header: "Amount",
                  type: "money",
                  value: (item) => item.amount,
                  mobile: "show",
                  render: (item) => <strong>{money(item.amount, currency)}</strong>,
                },
                { key: "note", header: "Reason", value: (item) => item.note || "", mobile: "show", className: "asw-log-cell" },
                { key: "by", header: "Recorded by", value: (item) => item.createdByName || "", mobile: "hide" },
                {
                  key: "actions",
                  header: "",
                  label: "Actions",
                  type: "actions",
                  render: (item) =>
                    inPaidPeriod(item) ? (
                      <span className="small muted nowrap">In a paid period</span>
                    ) : (
                      <div className="row-actions">
                        <ActionMenu
                          label={`More for this ${KINDS[item.kind].label.toLowerCase()}`}
                          items={[
                            {
                              label: "Remove",
                              icon: "trash",
                              danger: true,
                              onClick: () =>
                                setConfirm({
                                  title: `Remove ${KINDS[item.kind].label.toLowerCase()}`,
                                  message: `Remove the ${KINDS[item.kind].label.toLowerCase()} of ${money(item.amount, currency)} for ${item.employeeName} (${item.note})?`,
                                  label: "Remove",
                                  done: "Entry removed",
                                  run: () => deletePayrollAdjustment(item.id),
                                }),
                            },
                          ]}
                        />
                      </div>
                    ),
                },
              ]}
              rows={adjustments}
              rowKey={(item) => item.id}
              currency={currency}
              empty="None in this period"
              emptyIcon="wallet"
              emptyHint="Cash given in advance, a fine or breakage, or a festival bonus is recorded from a person's ⋯ menu above, and comes off or onto their net pay."
              exportName={`payroll-adjustments-${from}-to-${to}`}
            />
          </SectionCard>
        </>
      )}

      {adjusting && (
        <Modal
          title={`${KINDS[adjustForm.kind].label} — ${adjusting.name}`}
          description="It goes on their pay for the period its date falls in."
          icon="wallet"
          onClose={() => setAdjusting(null)}
          width={460}
        >
          <form className="form-grid" onSubmit={submitAdjust}>
            <ErrorMessage message={formError} />

            <div className="field field-wide">
              <span>Type</span>
              <div className="segmented" role="radiogroup" aria-label="Type">
                {ENTRY_KINDS.map((key) => [key, KINDS[key]]).map(([key, kind]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={adjustForm.kind === key}
                    className={`segment ${adjustForm.kind === key ? "is-active" : ""}`}
                    onClick={() => setAdjustForm({ ...adjustForm, kind: key })}
                  >
                    {kind.label}
                  </button>
                ))}
              </div>
              <small className="muted">{KINDS[adjustForm.kind].hint}</small>
            </div>

            <label className="field">
              <span>Amount ({currency}) *</span>
              <input
                type="number"
                min="1"
                step="0.01"
                value={adjustForm.amount}
                onChange={(event) => setAdjustForm({ ...adjustForm, amount: event.target.value })}
                required
                autoFocus
              />
            </label>

            <label className="field">
              <span>Date *</span>
              <input
                type="date"
                value={adjustForm.date}
                onChange={(event) => setAdjustForm({ ...adjustForm, date: event.target.value })}
                required
              />
            </label>

            <label className="field field-wide">
              <span>Reason *</span>
              <input
                value={adjustForm.note}
                onChange={(event) => setAdjustForm({ ...adjustForm, note: event.target.value })}
                maxLength={200}
                required
                placeholder={adjustForm.kind === "advance" ? "Advance for rent" : adjustForm.kind === "bonus" ? "Diwali bonus" : "Broken glasses"}
              />
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setAdjusting(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : `Record ${KINDS[adjustForm.kind].label.toLowerCase()}`}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {paying && (
        <Modal
          title={`Mark paid — ${paying.name}`}
          description="Records what was handed over, and closes this period for them."
          icon="check-circle"
          onClose={() => setPaying(null)}
          width={480}
        >
          <form className="form-grid" onSubmit={submitPay}>
            <ErrorMessage message={formError} />

            <div className="field-wide acc-pay-summary">
              <div>
                <span className="muted small">Period</span>
                <strong>{dayLabel(from)} – {dayLabel(to)}</strong>
              </div>
              <div>
                <span className="muted small">Earned</span>
                <strong>{moneyExact(paying.estimatedPay, currency)}</strong>
              </div>
              <div>
                <span className="muted small">Bonus{paying.tips ? " + tips" : ""} − advances − deductions</span>
                <strong>{signed(moneyExact, paying.bonus + (paying.tips || 0) - paying.advances - paying.deductions, currency)}</strong>
              </div>
              {paying.statutoryDeductions > 0 && (
                <div>
                  <span className="muted small">PF, ESI and professional tax</span>
                  <strong>− {moneyExact(paying.statutoryDeductions, currency)}</strong>
                </div>
              )}
              <div className="acc-pay-net">
                <span className="muted small">Net pay</span>
                <strong>{signed(moneyExact, paying.netPay, currency)}</strong>
              </div>
            </div>

            <label className="field">
              <span>Amount paid ({currency}) *</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={payForm.amountPaid}
                onChange={(event) => setPayForm({ ...payForm, amountPaid: event.target.value })}
                required
              />
              {(() => {
                // Mirrors the server: more than the net pay is refused;
                // less carries the rest to the next period as pay owed.
                const payable = Math.max(0, paying.netPay);
                const amount = Number(payForm.amountPaid || 0);

                if (amount > payable + 1) {
                  return (
                    <small className="text-danger">
                      More than the net pay. If you are paying extra, add it as a bonus or an advance first.
                    </small>
                  );
                }

                if (payable - amount >= 1) {
                  return (
                    <small className="muted">
                      {moneyExact(payable - amount, currency)} still owed moves to the next pay period.
                    </small>
                  );
                }

                return null;
              })()}
            </label>

            <label className="field">
              <span>Paid by</span>
              <select
                value={payForm.paymentMethod}
                onChange={(event) => setPayForm({ ...payForm, paymentMethod: event.target.value })}
              >
                {Object.entries(METHODS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Paid on</span>
              <input
                type="date"
                value={payForm.paidOn}
                onChange={(event) => setPayForm({ ...payForm, paidOn: event.target.value })}
                required
              />
            </label>

            <label className="field">
              <span>Reference</span>
              <input
                value={payForm.reference}
                onChange={(event) => setPayForm({ ...payForm, reference: event.target.value })}
                maxLength={60}
                placeholder="UTR / cheque no."
              />
            </label>

            <label className="field field-wide">
              <span>Note</span>
              <input
                value={payForm.note}
                onChange={(event) => setPayForm({ ...payForm, note: event.target.value })}
                maxLength={200}
              />
            </label>

            {to > today() && (
              <div className="alert field-wide" role="alert">
                This period runs to {dayLabel(to)}, which has not happened yet. Paying it now would close those days,
                so their attendance could no longer be marked. Mark pay up to today instead, or give the money as an
                advance, which this month's pay then takes back.
                <div className="acc-pay-future-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setPaying(null);
                      setTo(today());
                    }}
                  >
                    Show pay up to today
                  </button>
                </div>
              </div>
            )}

            {paying.netPay < 0 && (
              <p className="alert alert-notice field-wide">
                Advances and deductions are {moneyExact(-paying.netPay, currency)} more than the pay. Nothing is paid
                now, and that {moneyExact(-paying.netPay, currency)} is taken from the next pay period.
              </p>
            )}

            <p className="muted small field-wide">
              The figures are kept on the payment as they are now. The period is then closed for this person:
              attendance and roster days in it cannot be changed, and later advances go into the next one.
            </p>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setPaying(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving || to > today()}>
                {saving ? "Saving…" : "Mark paid"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {payingAll && (
        <Modal
          title={`Mark all paid — ${monthName(from, to) || `${dayLabel(from)} – ${dayLabel(to)}`}`}
          description="Pays everyone not yet paid in this period their full net pay, in one go."
          icon="check-circle"
          onClose={() => !saving && setPayingAll(false)}
          dismissible={!saving}
          width={560}
        >
          <form className="form-grid" onSubmit={submitPayAll}>
            <ErrorMessage message={formError} />

            <div className="field-wide acc-payall-list">
              <DataGrid
                id="payroll-pay-all"
                variant="compact"
                caption="People to be paid"
                pageSize={false}
                search={false}
                rows={unpaid}
                rowKey={(row) => row.employeeId}
                currency={currency}
                rowNoun={["person", "people"]}
                columns={[
                  {
                    key: "name",
                    header: "Employee",
                    value: (row) => row.name,
                    mobile: "title",
                    render: (row) => (
                      <span>
                        {row.name}
                        {row.netPay < 0 && (
                          <span className="small muted acc-block">
                            Advances are {moneyExact(-row.netPay, currency)} more than the pay: nothing paid, the rest
                            moves to next period
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: "net",
                    header: "Net pay",
                    type: "money",
                    exact: true,
                    value: (row) => Math.max(0, row.netPay),
                    total: "sum",
                    mobile: "show",
                  },
                ]}
              />
            </div>

            <FormField label="Paid by">
              <select
                value={payAllForm.paymentMethod}
                onChange={(event) => setPayAllForm({ ...payAllForm, paymentMethod: event.target.value })}
              >
                {Object.entries(METHODS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Paid on">
              <input
                type="date"
                value={payAllForm.paidOn}
                onChange={(event) => setPayAllForm({ ...payAllForm, paidOn: event.target.value })}
                required
              />
            </FormField>

            <FormField label="Reference" optional hint="The bank batch or UTR number">
              <input
                value={payAllForm.reference}
                onChange={(event) => setPayAllForm({ ...payAllForm, reference: event.target.value })}
                maxLength={60}
                placeholder="UTR / batch no."
              />
            </FormField>

            <FormField label="Note" optional>
              <input
                value={payAllForm.note}
                onChange={(event) => setPayAllForm({ ...payAllForm, note: event.target.value })}
                maxLength={200}
              />
            </FormField>

            <p className="muted small field-wide">
              Each person gets their own payment record, payslip and activity-log line, as if marked one by one. Their
              period is then closed: attendance and roster days in it cannot be changed. If anything changed since this
              sheet was opened, nobody is paid and you are asked to reload.
            </p>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setPayingAll(false)} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving || periodNotOver}>
                {saving ? "Saving…" : `Mark ${unpaid.length} paid · ${moneyExact(unpaidTotal, currency)}`}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {statutoryOpen && (
        <StatutorySettingsModal
          onClose={() => setStatutoryOpen(false)}
          onSaved={() => {
            setStatutoryOpen(false);
            setSuccess("PF, ESI and professional tax saved. The pay sheet below is worked out again.");
            load();
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          onConfirm={runConfirmed}
          onCancel={() => setConfirm(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
