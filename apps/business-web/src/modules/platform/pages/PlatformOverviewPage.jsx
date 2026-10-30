import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import StatTile from "../../../components/StatTile";
import { ColumnChart } from "../../../components/Charts";
import { ErrorMessage, ScreenLoading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { count, dateShort, money, moneyExact } from "@bmp/shared/format";
import { getPlatformOverview } from "../services/dashboards.service";
import { avgDaysText, funnelRows } from "../funnelWords";
import "../styles/dashboards.css";

// Platform › Overview (/platform), the platform super admin's home: the money
// the company has taken (its tax invoices; SAMPLE ones left out), the monthly
// and yearly recurring income of the paying businesses, every business by
// state, the last 30 days' free trials, the renewals due, and what is waiting:
// payments to confirm, new enquiries, and what going live still needs.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthWord = (key) => MONTHS[Number(key.slice(5, 7)) - 1];

// Each state, as a tile that opens the businesses in it.
const STATE_TILES = [
  ["trial", "On trial", "timer", "info"],
  ["paid", "Paying", "check-circle", "success"],
  ["given", "Given time", "gift", "primary"],
  ["grace", "In grace", "clock", "warning"],
  ["checking", "Payment being checked", "search", "info"],
  ["ended", "Ended (read-only)", "lock", "danger"],
  ["off", "Switched off", "ban", "neutral"],
];

// What going live needs, each with the settings tab that sees to it.
function goLiveSteps(todo) {
  const missing = todo.companyProblems;
  return [
    {
      key: "company", done: missing.length === 0, to: "/platform/settings?tab=company", fix: "Company details",
      text: missing.length === 0 ? "The company's details are complete." : `Complete the company's details: ${missing.join(", ")}.`,
    },
    {
      key: "gstin", done: !todo.sampleGstin, to: "/platform/settings?tab=company", fix: "Enter the GSTIN",
      text: todo.sampleGstin ? "Enter the company's real GSTIN. Until then every invoice is a SAMPLE, not a tax invoice." : "The company's real GSTIN is entered.",
    },
    {
      key: "prices", done: todo.pricesReviewed, to: "/platform/settings?tab=prices", fix: "Review prices",
      text: todo.pricesReviewed ? "The price list has been reviewed." : "Review the price list: it still holds the starting prices.",
    },
    {
      key: "payment", done: !todo.paymentDetailsMissing, to: "/platform/settings?tab=payment", fix: "Payment details",
      text: todo.paymentDetailsMissing ? "Enter the UPI ID or bank account owners pay to." : "Owners can see the UPI ID or bank account to pay to.",
    },
  ];
}

export default function PlatformOverviewPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getPlatformOverview()
      .then((result) => { setData(result); setError(""); })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="stack pd-page">
      <PageHeader icon="chart" eyebrow="Platform" title="Platform overview"
        description="The platform's own sales, its businesses by state, the free trials and what is waiting for you."
        secondary={<button type="button" className="button button-secondary" onClick={load}><Icon name="refresh" size={16} /> Refresh</button>} />
      <ErrorMessage message={error} />
      {!data && !error && <ScreenLoading label="Loading the overview…" />}
      {data && (
        <>
          <Money money={data.money} />
          <SectionCard icon="store" title="Businesses by state" description="Each business's state today, on its own date. A tile opens the businesses in that state.">
            <div className="stat-grid">
              {STATE_TILES.map(([state, label, icon, tone]) => (
                <StatTile key={state} size="sm" icon={icon} tone={data.states[state] ? tone : "neutral"} label={label} value={count(data.states[state])}
                  to={`/platform/businesses?state=${state}`} />
              ))}
            </div>
          </SectionCard>
          <div className="pd-two">
            <TrialsBlock funnel={data.funnel30} />
            <RenewalsBlock renewals={data.renewals} />
          </div>
          <ToDo todo={data.todo} />
        </>
      )}
    </div>
  );
}

function Money({ money: m }) {
  const points = m.byMonth.map((month) => ({ label: monthWord(month.month), value: Number(month.collected) }));
  const yearTotal = m.byMonth.reduce((sum, month) => sum + Number(month.collected), 0);
  return (
    <SectionCard icon="wallet" tone="primary" title="Money"
      description="From the company's tax invoices, GST included unless it says before GST. Recurring income is the paying businesses' plans and add-ons, before GST."
      actions={<Link className="button button-ghost button-sm" to="/platform/reports">Sales report <Icon name="arrow-right" size={14} /></Link>}>
      <div className="stat-grid">
        <StatTile icon="cash" tone="primary" label="Collected today" money={m.today} />
        <StatTile icon="calendar" label="This month" money={m.thisMonth} note={`${moneyExact(m.beforeGstThisMonth)} before GST, ${moneyExact(m.gstThisMonth)} GST`} />
        <StatTile icon="history" label="Last month" money={m.lastMonth} />
        <StatTile icon="chart" label="This financial year" money={m.thisFy} note={`Since ${dateShort(m.fyStart, { year: true })}`} />
        <StatTile icon="trend-up" tone="success" label="Monthly recurring income" money={m.mrr}
          note={`${count(m.payingBusinesses)} paying ${m.payingBusinesses === 1 ? "business" : "businesses"}, before GST`} />
        <StatTile icon="refresh" label="Yearly recurring income" money={m.arr} note="The monthly figure for a year" />
      </div>
      {m.sampleInvoices.count > 0 && (
        <p className="pd-note">
          {count(m.sampleInvoices.count)} SAMPLE {m.sampleInvoices.count === 1 ? "invoice" : "invoices"} ({moneyExact(m.sampleInvoices.total)}) issued
          while the company's GSTIN was the sample one {m.sampleInvoices.count === 1 ? "is" : "are"} left out: {m.sampleInvoices.count === 1 ? "it is" : "they are"} not tax invoices.
        </p>
      )}
      <h3 className="pd-subhead">Collected in the last 12 months</h3>
      {yearTotal > 0
        ? <ColumnChart points={points} height={140} />
        : <p className="muted small">Nothing collected in the last 12 months yet.</p>}
    </SectionCard>
  );
}

function TrialsBlock({ funnel }) {
  const rows = funnelRows(funnel);
  return (
    <SectionCard icon="users" title="Free trials, last 30 days"
      description={`Trials that started from ${dateShort(funnel.from)} to ${dateShort(funnel.to)}, and the enquiries that came in.`}
      actions={<Link className="button button-ghost button-sm" to="/platform/leads">Leads & trials <Icon name="arrow-right" size={14} /></Link>}>
      <ul className="pd-funnel">
        {rows.map((row) => (
          <li key={row.key} className={`pd-funnel-row ${row.depth ? "is-nested" : ""}`}>
            <span className="pd-funnel-label">{row.label}</span>
            <strong className="pd-nowrap">{row.value === null ? "—" : count(row.value)}</strong>
            {(row.note || row.parts.length > 0) && (
              <span className="pd-funnel-meta">
                {row.note && <span>{row.note}</span>}
                {row.parts.map((part) => <span key={part.key}>{part.text}</span>)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="pd-funnel-summary">From a trial's start to its first payment, on average: {avgDaysText(funnel.avgDaysToPay)}.</p>
    </SectionCard>
  );
}

function RenewalsBlock({ renewals }) {
  return (
    <SectionCard icon="calendar" title="Renewals"
      description="Paying businesses whose paid time ends soon, with what their renewals would ask before GST, and paid time that ended this month without one."
      actions={<Link className="button button-ghost button-sm" to="/platform/reports?tab=renewals">Renewals due <Icon name="arrow-right" size={14} /></Link>}>
      <div className="stat-grid">
        <StatTile size="sm" icon="alert" tone={renewals.in7.count ? "warning" : "neutral"} label="Due in 7 days" value={count(renewals.in7.count)}
          note={`${money(renewals.in7.value)} before GST`} to="/platform/reports?tab=renewals&within=7" />
        <StatTile size="sm" icon="calendar" label="Due in 30 days" value={count(renewals.in30.count)}
          note={`${money(renewals.in30.value)} before GST`} to="/platform/reports?tab=renewals&within=30" />
        <StatTile size="sm" icon="trend-down" tone={renewals.endedThisMonthNotRenewed ? "danger" : "neutral"} label="Ended this month, not renewed"
          value={count(renewals.endedThisMonthNotRenewed)} note="In grace or ended" />
      </div>
    </SectionCard>
  );
}

function ToDo({ todo }) {
  const steps = goLiveSteps(todo);
  const ready = steps.every((step) => step.done);
  return (
    <SectionCard icon="clipboard" title="To do" description="What is waiting for you, and what going live still needs.">
      <div className="stat-grid">
        <StatTile size="sm" icon="wallet" tone={todo.paymentsToConfirm ? "warning" : "neutral"} label="Payments to confirm" value={count(todo.paymentsToConfirm)}
          note="Owners' payments to check" to="/platform/payments" />
        <StatTile size="sm" icon="phone" tone={todo.newEnquiries ? "info" : "neutral"} label="New enquiries" value={count(todo.newEnquiries)}
          note="Call-back requests not followed up" to="/platform/leads" />
        {!todo.sampleGstin && todo.taxInvoicesToIssue > 0 && (
          <StatTile size="sm" icon="receipt" tone="warning" label="Tax invoices to issue" value={count(todo.taxInvoicesToIssue)}
            note="Paid orders with only a SAMPLE invoice" to="/platform/invoices" />
        )}
      </div>
      {ready ? (
        <p className="pd-ready"><Icon name="check-circle" size={18} /> Ready to go live: the company's details, its real GSTIN, the reviewed prices and the payment details are all in.</p>
      ) : (
        <>
          <h3 className="pd-subhead">Before you go live</h3>
          <ul className="pd-checklist" aria-label="Before you go live">
            {steps.map((step) => (
              <li key={step.key} data-step={step.key} data-done={step.done ? "yes" : "no"}>
                <Icon name={step.done ? "check-circle" : "alert-circle"} size={18} className={step.done ? "pd-check-done" : "pd-check-todo"} />
                <span className="pd-check-text">{step.text}</span>
                {!step.done && <Link className="button button-secondary button-sm" to={step.to}>{step.fix}</Link>}
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
