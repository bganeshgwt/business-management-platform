import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import StatTile from "../../../components/StatTile";
import ContentTabs from "../../../components/ContentTabs";
import DataGrid from "../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../components/DateRangeFilter";
import StatusBadge from "../../../components/StatusBadge";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { count, dateShort, moneyExact } from "@bmp/shared/format";
import { today } from "@bmp/shared/dates";
import { getDuesReport, getRenewalsReport, getSalesReport } from "../services/dashboards.service";
import { stateWord } from "../funnelWords";
import "../styles/dashboards.css";

// Platform › Reports (/platform/reports): the platform's sales from its tax
// invoices (never a SAMPLE one) by month, plan, module, application, business
// type, state, new or renewal, and monthly or yearly; the renewals due, with
// what each would ask; and the orders not paid, by how old they are. Each
// report has a CSV.

const TABS = [{ value: "sales", label: "Sales" }, { value: "renewals", label: "Renewals due" }, { value: "dues", label: "Orders not paid" }];
const SALES_BY = [
  { value: "month", label: "Month" }, { value: "plan", label: "Plan" }, { value: "module", label: "Module" }, { value: "application", label: "Application" },
  { value: "type", label: "Business type" }, { value: "state", label: "State" }, { value: "kind", label: "New or renewal" }, { value: "period", label: "Monthly or yearly" },
];
// Plans, modules and applications are lines of an invoice: their sales are before GST only.
const LINE_REPORTS = ["plan", "module", "application"];
const WITHIN = [7, 15, 30, 60, 90];
const STATE_TONES = { trial: "info", paid: "success", given: "primary", grace: "warning", checking: "info", ended: "danger", off: "neutral" };
const PERIOD_WORDS = { month: "Monthly", year: "Yearly" };
const KIND_WORDS = { subscription: "Plan", add_on: "Add-ons" };
const phoneLink = (mobile) => (mobile ? <a href={`tel:${mobile}`}>{mobile}</a> : null);
// 1 April of this financial year.
const fyStart = () => {
  const [year, month] = today().split("-").map(Number);
  return `${month >= 4 ? year : year - 1}-04-01`;
};

export default function PlatformReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "sales";
  const setTab = (value) => setParams(value === "sales" ? {} : { tab: value }, { replace: true });
  return (
    <div className="stack pd-page">
      <PageHeader icon="chart" eyebrow="Platform" title="Platform reports"
        description="The platform's own sales from its tax invoices, the renewals coming up, and the orders owners have not paid." />
      <ContentTabs label="Platform reports" value={tab} options={TABS} onChange={setTab}>
        {tab === "sales" && <SalesReport />}
        {tab === "renewals" && <RenewalsReport initialWithin={Number(params.get("within")) || 30} />}
        {tab === "dues" && <DuesReport />}
      </ContentTabs>
    </div>
  );
}

// A report read with these params; read again whenever they change. The
// figures already on screen stay until the new ones come.
function useReport(read, params) {
  const key = JSON.stringify(params);
  const [state, setState] = useState({ data: null, error: "" });
  useEffect(() => {
    let current = true;
    read(JSON.parse(key))
      .then((data) => current && setState({ data, error: "" }))
      .catch((err) => current && setState({ data: null, error: getErrorMessage(err) }));
    return () => { current = false; };
  }, [read, key]);
  return state;
}

function SalesReport() {
  const [range, setRange] = useState(() => ({ from: fyStart(), to: today() }));
  const [by, setBy] = useState("month");
  const { data, error } = useReport(getSalesReport, { ...range, by });
  const lines = LINE_REPORTS.includes(by);
  const heading = SALES_BY.find((option) => option.value === by).label;
  const columns = useMemo(() => [
    { key: "label", header: heading, value: (r) => r.label, mobile: "title", pin: true, csv: (r) => r.label },
    { key: "code", header: "Code", value: (r) => r.key || "", defaultHidden: true },
    { key: "invoices", header: "Invoices", type: "number", value: (r) => r.invoices },
    { key: "taxable", header: "Sales before GST", type: "money", exact: true, value: (r) => Number(r.taxable), total: "sum", mobile: "show" },
    ...(lines ? [] : [
      { key: "gst", header: "GST", type: "money", exact: true, value: (r) => Number(r.gst), total: "sum" },
      { key: "total", header: "Total", type: "money", exact: true, value: (r) => Number(r.total), total: "sum" },
    ]),
  ], [heading, lines]);
  const rows = (data?.rows || []).map((row) => ({ ...row, id: row.key ?? row.label }));
  return (
    <>
      <div className="pd-filters pd-filter-box">
        <DateRangeFilter from={range.from} to={range.to} label="invoice dates" onChange={(next) => { if (next.from && next.to) setRange(next); }} />
        <label className="field">
          <span>Sales by</span>
          <select aria-label="Sales by" value={by} onChange={(event) => setBy(event.target.value)}>
            {SALES_BY.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <div className="stat-grid">
        <StatTile icon="receipt" label="Tax invoices" value={data ? count(data.totals.invoices) : "—"} loading={!data && !error} />
        <StatTile icon="wallet" tone="primary" label="Sales before GST" money={data?.totals.taxable} value="—" loading={!data && !error} />
        <StatTile icon="percent" label="GST" money={data?.totals.gst} value="—" loading={!data && !error} />
        <StatTile icon="cash" tone="success" label="Collected, GST included" money={data?.totals.total} value="—" loading={!data && !error} />
      </div>
      {data && data.sample.invoices > 0 && (
        <p className="pd-note">
          {count(data.sample.invoices)} SAMPLE {data.sample.invoices === 1 ? "invoice" : "invoices"} ({moneyExact(data.sample.total)}) in these dates
          {data.sample.invoices === 1 ? " is" : " are"} left out: issued under the sample GSTIN, {data.sample.invoices === 1 ? "it is" : "they are"} not tax invoices.
        </p>
      )}
      <SectionCard flush icon="chart" title={`Sales by ${heading.toLowerCase()}`}
        description={lines ? `What the invoices' ${by} lines came to, before GST: GST is charged on the whole invoice.` : "Whole invoices: before GST, the GST and the total."}>
        <ErrorMessage message={error} />
        <DataGrid id="platform-sales" caption={`Sales by ${heading.toLowerCase()}`} columns={columns} rows={rows} loading={!data && !error}
          exportName={`platform-sales-by-${by}`} rowNoun={["row", "rows"]} empty="No tax invoices in these dates" emptyIcon="receipt" />
      </SectionCard>
    </>
  );
}

function RenewalsReport({ initialWithin }) {
  const [within, setWithin] = useState(WITHIN.includes(initialWithin) ? initialWithin : 30);
  const { data, error } = useReport(getRenewalsReport, { within });
  const columns = useMemo(() => [
    { key: "name", header: "Business", value: (r) => r.name, mobile: "title", pin: true,
      render: (r) => <span className="pd-two-line"><strong>{r.name}</strong><small>{r.typeName}</small></span> },
    { key: "state", header: "Today", type: "status", value: (r) => stateWord(r.state),
      render: (r) => <StatusBadge status={r.state} label={stateWord(r.state)} tone={STATE_TONES[r.state] || "neutral"} /> },
    { key: "endsOn", header: "Paid time ends", type: "date", value: (r) => r.endsOn, mobile: "show" },
    { key: "daysLeft", header: "Days left", type: "number", value: (r) => r.daysLeft,
      render: (r) => (r.daysLeft < 0 ? <span className="pd-two-line"><span>Ended {count(-r.daysLeft)} {r.daysLeft === -1 ? "day" : "days"} ago</span>
        {r.graceEndsOn && <small>Grace until {dateShort(r.graceEndsOn)}</small>}</span> : count(r.daysLeft)) },
    { key: "plan", header: "Renews on", value: (r) => `${r.planName || "No plan"}${r.billingPeriod ? `, ${PERIOD_WORDS[r.billingPeriod].toLowerCase()}` : ""}` },
    { key: "value", header: "Renewal before GST", type: "money", exact: true, value: (r) => Number(r.value), total: "sum", mobile: "show" },
    { key: "owner", header: "Owner", value: (r) => r.ownerName || "",
      render: (r) => <span className="pd-two-line"><span>{r.ownerName || "—"}</span>{r.ownerMobile && <small>{phoneLink(r.ownerMobile)}</small>}</span> },
    { key: "mobile", header: "Owner's mobile", value: (r) => r.ownerMobile || "", defaultHidden: true },
    { key: "email", header: "Owner's email", value: (r) => r.ownerEmail || "", defaultHidden: true },
    { key: "order", header: "Open order", value: (r) => (r.openOrder ? `${moneyExact(r.openOrder.total)}${r.openOrder.checking ? ", payment being checked" : ""}` : ""),
      csv: (r) => (r.openOrder ? r.openOrder.total : "") },
  ], []);
  return (
    <>
      <div className="pd-filters pd-filter-box">
        <label className="field">
          <span>Paid time ending within</span>
          <select aria-label="Paid time ending within" value={within} onChange={(event) => setWithin(Number(event.target.value))}>
            {WITHIN.map((days) => <option key={days} value={days}>{days} days</option>)}
          </select>
        </label>
      </div>
      <div className="stat-grid">
        <StatTile icon="calendar" tone="primary" label="Renewals due" value={data ? count(data.totals.count) : "—"} loading={!data && !error}
          note={`Within ${within} days, and those in grace`} />
        <StatTile icon="wallet" label="Worth before GST" money={data?.totals.value} value="—" loading={!data && !error} note="At today's prices" />
      </div>
      <SectionCard flush icon="list" title="Renewals due"
        description="Paying businesses whose paid time ends within these days, and those already in grace, soonest first, with what the renewal would ask at today's prices.">
        <ErrorMessage message={error} />
        <DataGrid id="platform-renewals" caption="Renewals due" columns={columns} rows={(data?.items || []).map((item) => ({ ...item, id: item.businessId }))}
          loading={!data && !error} exportName="platform-renewals" rowNoun={["business", "businesses"]}
          rowClassName={(r) => (r.state === "grace" ? "dg-tone-warning" : "")} empty="No paid time ends within these days" emptyIcon="calendar" />
      </SectionCard>
    </>
  );
}

function DuesReport() {
  const { data, error } = useReport(getDuesReport, {});
  const columns = useMemo(() => [
    { key: "orderId", header: "Order", type: "number", value: (r) => r.orderId, mobile: "title", pin: true },
    { key: "name", header: "Business", value: (r) => r.name, mobile: "subtitle",
      render: (r) => <span className="pd-two-line"><strong>{r.name}</strong><small>{r.typeName}</small></span> },
    { key: "kind", header: "For", value: (r) => `${KIND_WORDS[r.kind] || r.kind}, ${PERIOD_WORDS[r.billingPeriod].toLowerCase()}` },
    { key: "createdOn", header: "Made on", type: "date", value: (r) => r.createdOn },
    { key: "ageDays", header: "Days old", type: "number", value: (r) => r.ageDays, mobile: "show" },
    { key: "band", header: "Age", value: (r) => `${r.band} days`, filter: "select" },
    { key: "validUntil", header: "Prices held until", type: "date", value: (r) => r.validUntil,
      render: (r) => (r.expired ? <span className="pd-two-line"><span>{dateShort(r.validUntil)}</span><small>Expired: to be made again</small></span> : dateShort(r.validUntil)) },
    { key: "total", header: "Total", type: "money", exact: true, value: (r) => Number(r.total), total: "sum", mobile: "show" },
    { key: "checking", header: "Payment", value: (r) => (r.checking ? "Being checked" : "Not paid"),
      render: (r) => <StatusBadge status={r.checking ? "checking" : "unpaid"} label={r.checking ? "Being checked" : "Not paid"} tone={r.checking ? "info" : "warning"} /> },
    { key: "owner", header: "Owner", value: (r) => r.ownerName || "",
      render: (r) => <span className="pd-two-line"><span>{r.ownerName || "—"}</span>{r.ownerMobile && <small>{phoneLink(r.ownerMobile)}</small>}</span> },
    { key: "mobile", header: "Owner's mobile", value: (r) => r.ownerMobile || "", defaultHidden: true },
    { key: "state", header: "Today", value: (r) => stateWord(r.state), defaultHidden: true },
  ], []);
  return (
    <>
      <div className="stat-grid">
        {(data?.bands || [{ band: "0-30", label: "Up to 30 days" }, { band: "31-60", label: "31 to 60 days" }, { band: "61-90", label: "61 to 90 days" }, { band: "90+", label: "Over 90 days" }])
          .map((band) => (
            <StatTile key={band.band} size="sm" icon="clock" tone={band.count && band.band !== "0-30" ? "warning" : "neutral"} label={band.label}
              money={band.total} value="—" loading={!data && !error} note={data ? `${count(band.count)} ${band.count === 1 ? "order" : "orders"}` : ""} />
          ))}
      </div>
      <SectionCard flush icon="list" title="Orders not paid"
        description="Every open order, oldest first, by how many days old it is. An order holds its prices for 7 days; after that the owner makes it again.">
        <ErrorMessage message={error} />
        <DataGrid id="platform-dues" caption="Orders not paid" columns={columns} rows={(data?.items || []).map((item) => ({ ...item, id: item.orderId }))}
          loading={!data && !error} exportName="platform-dues" rowNoun={["order", "orders"]}
          rowClassName={(r) => (r.ageDays > 30 ? "dg-tone-warning" : "")} empty="Every order is paid or cancelled" emptyIcon="check-circle" />
      </SectionCard>
    </>
  );
}
