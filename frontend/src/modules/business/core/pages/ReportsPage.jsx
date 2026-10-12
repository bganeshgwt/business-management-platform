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
      <BusinessHeader icon="chart" title="Reports" description={`Money in and out by the day it was posted (${biz.business.timezone}). This is an operational register, not a GST filing pack.`} />
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
    </div>
  );
}
