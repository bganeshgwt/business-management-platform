import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "../../../../services/dates";
import { BusinessHeader } from "./ui";
import { businessToday, useOpenBusiness } from "./hooks";

const LABELS = {
  sale: "Sales", purchase: "Purchases received", sale_return: "Sales returns", purchase_return: "Returns to suppliers",
  sale_payment: "Collected from customers", purchase_payment: "Paid to suppliers", sale_refund: "Refunded to customers", purchase_refund: "Refunds from suppliers",
};

// Money events by the day they were posted: sales, returns, collections and
// refunds each on their own date. An operational register, not a GST return.
export default function ReportsPage() {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  // A branch picked in the top bar (or the one this person works at).
  const place = biz.currentLocationId ? biz.allLocations.find((l) => Number(l.id) === Number(biz.currentLocationId)) : null;
  const branches = biz.allLocations.filter((l) => l.active).length > 1 && biz.can("sales.view");
  const [range, setRange] = useState({ from: monthStart(anchor), to: anchor });
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "reports", range, controller.signal)
      .then((r) => { setReport(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range]);
  const totals = useMemo(() => {
    const sum = (kind, field = "total") => (report?.rows || []).filter((r) => r.kind === kind).reduce((s, r) => s + Number(r[field]), 0);
    return { sales: sum("sale") - sum("sale_return"), tax: sum("sale", "tax") - sum("sale_return", "tax"), collected: sum("sale_payment") - sum("sale_refund"), purchases: sum("purchase") - sum("purchase_return") };
  }, [report]);
  const columns = [
    { key: "day", header: "Date", type: "date", value: (r) => r.day, mobile: "subtitle" },
    { key: "kind", header: "What", value: (r) => LABELS[r.kind] || r.kind, mobile: "title" },
    { key: "entries", header: "Entries", type: "number", value: (r) => r.entries, total: "sum" },
    { key: "net", header: "Before tax", type: "money", exact: true, value: (r) => Number(r.net) },
    { key: "tax", header: "Tax", type: "money", exact: true, value: (r) => Number(r.tax) },
    { key: "total", header: "Amount", type: "money", exact: true, value: (r) => Number(r.total), mobile: "show" },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="chart" title="Reports" description={`Money in and out by the day it was posted (${biz.business.timezone}). This is an operational register, not a GST filing pack.${place ? ` Showing ${place.name} only.` : ""}`} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        {biz.can("sales.view") && <StatTile icon="receipt" tone="primary" label="Net sales" value={report ? biz.amount(totals.sales) : "—"} note="after returns" />}
        {biz.can("sales.view") && <StatTile icon="percent" label="GST on sales" value={report ? biz.amount(totals.tax) : "—"} note="after returns" />}
        {biz.can("sales.view") && <StatTile icon="wallet" tone="success" label="Collected" value={report ? biz.amount(totals.collected) : "—"} note="less refunds" />}
        {biz.can("purchasing.view") && <StatTile icon="truck" label="Purchases" value={report ? biz.amount(totals.purchases) : "—"} note="after returns" />}
      </div>
      <SectionCard flush icon="list" title="Day by day">
        <DataGrid id="business-report-days" caption="Money events by day" columns={columns} currency={biz.symbol}
          rows={(report?.rows || []).map((r) => ({ ...r, id: `${r.day}-${r.kind}` }))} loading={!report && !error}
          toolbar={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="report dates" onChange={(next) => { if (next.from && next.to) setRange(next); }} />}
          exportName={biz.can("reports.export") ? `${biz.business.code}-money-${range.from}-${range.to}` : undefined}
          empty="Nothing posted in these dates" emptyIcon="chart" />
      </SectionCard>
      {branches && <BranchComparison range={range} />}
    </div>
  );
}

// Which location is carrying the others: every branch side by side for the
// same dates (a branch picked in the top bar does not narrow it; someone who
// works at one location sees theirs).
function BranchComparison({ range }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "reports/locations", range, controller.signal)
      .then((r) => { setData(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range]);
  const columns = [
    { key: "name", header: "Location", value: (l) => l.name, mobile: "title", pin: true, render: (l) => <span>{l.name}{!l.active && <span className="muted small"> (closed)</span>}</span> },
    { key: "bills", header: "Bills", type: "number", value: (l) => l.bills, total: "sum" },
    { key: "sales", header: "Sales", type: "money", value: (l) => Number(l.sales), total: "sum" },
    { key: "returns", header: "Returns", type: "money", value: (l) => Number(l.returns), total: "sum" },
    { key: "net", header: "Net sales", type: "money", value: (l) => Number(l.net_sales), total: "sum", mobile: "show" },
    { key: "share", header: "Share", type: "number", value: (l) => l.share_percent, render: (l) => `${l.share_percent}%` },
    { key: "average", header: "Average bill", type: "money", value: (l) => Number(l.average_bill) },
    { key: "collected", header: "Collected", type: "money", value: (l) => Number(l.collected), total: "sum" },
    biz.can("purchasing.view") && { key: "purchases", header: "Purchases", type: "money", value: (l) => Number(l.purchases), total: "sum" },
    biz.can("inventory.view") && { key: "stock", header: "Stock at cost", type: "money", value: (l) => Number(l.stock_value), total: "sum" },
  ].filter(Boolean);
  return (
    <SectionCard flush icon="map-pin" title="Locations compared" description="Sales, returns and money collected in these dates, and the stock each location holds now.">
      <ErrorMessage message={error} />
      <DataGrid id="business-report-locations" caption="Locations compared" columns={columns} currency={biz.symbol}
        rows={data?.locations || []} loading={!data && !error}
        exportName={biz.can("reports.export") ? `${biz.business.code}-locations-${range.from}-${range.to}` : undefined}
        empty="No location has sales in these dates" emptyIcon="map-pin" />
    </SectionCard>
  );
}
