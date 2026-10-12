import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "../../../../services/dates";
import { BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { inPacks } from "./tradeFormat";
import { Segmented } from "./shared";

// Wholesale reports: sales (invoiced less returns) and orders by customer,
// salesperson or route for a period; collections by day, method and
// salesperson; what is outstanding now by route or salesperson; and (round
// 2) the free goods and discounts each retailer got from each scheme.

const REPORTS = [
  { value: "salesperson", label: "By salesperson" },
  { value: "route", label: "By route" },
  { value: "customer", label: "By customer" },
  { value: "collections", label: "Collections" },
  // Round 2: what each retailer got from each scheme (free goods and discount).
  { value: "schemes", label: "Schemes by retailer" },
  { value: "outstanding:route", label: "Outstanding by route" },
  { value: "outstanding:salesperson", label: "Outstanding by salesperson" },
];

// Stable objects: the grid reads these props on every render.
const NEWEST_FIRST = { key: "day", direction: "desc" };

export default function WholesaleReportsPage() {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [report, setReport] = useState("salesperson");
  const [range, setRange] = useState({ from: monthStart(anchor), to: anchor });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [group, by] = report.split(":");
  const needsMoney = group === "collections" || group === "outstanding";
  const allowed = needsMoney ? biz.can("receivables.view") : biz.can("sales.view");
  const options = REPORTS.filter((r) => (r.value.startsWith("collections") || r.value.startsWith("outstanding") ? biz.can("receivables.view")
    : r.value === "schemes" ? biz.can("sales_orders.view") : biz.can("sales.view")));

  useEffect(() => {
    if (!allowed) return undefined;
    const controller = new AbortController();
    const query = group === "outstanding" ? { group, by } : group === "schemes" ? range : { group, ...range };
    businessRead(biz.id, group === "schemes" ? "wholesale-scheme-report" : "wholesale-reports", query, controller.signal)
      .then((result) => { setData({ ...result, key: report }); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, group, by, range, report, allowed, version]);

  const columns = useMemo(() => {
    if (group === "collections") {
      return [
        { key: "day", header: "Day", type: "date", value: (r) => r.day, mobile: "subtitle" },
        { key: "method", header: "Paid by", value: (r) => (r.method === "upi" ? "UPI" : r.method[0].toUpperCase() + r.method.slice(1)), filter: "select", mobile: "title" },
        { key: "salesperson", header: "Salesperson", value: (r) => r.salesperson, filter: "select", mobile: "show" },
        { key: "route", header: "Route", value: (r) => r.route, filter: "select" },
        { key: "receipts", header: "Receipts", type: "number", value: (r) => r.receipts, total: "sum" },
        { key: "amount", header: "Collected", type: "money", exact: true, value: (r) => Number(r.amount), total: "sum", mobile: "show" },
        { key: "applied", header: "Applied to bills", type: "money", exact: true, value: (r) => Number(r.applied), total: "sum" },
      ];
    }
    if (group === "schemes") {
      return [
        { key: "retailer", header: "Retailer", value: (r) => r.contact_name, filter: "select", mobile: "title", pin: true },
        { key: "scheme", header: "Scheme", value: (r) => r.scheme_name, filter: "select", mobile: "subtitle" },
        { key: "item", header: "On item", value: (r) => r.item, defaultHidden: true },
        { key: "orders", header: "Orders", type: "number", value: (r) => r.orders, total: "sum" },
        { key: "bought", header: "Bought and sent", type: "number", value: (r) => Number(r.bought), render: (r) => inPacks(r.bought, r.unit, r.pack?.unit, r.pack?.factor) },
        { key: "free", header: "Free goods sent", type: "number", value: (r) => Number(r.free_sent),
          render: (r) => (Number(r.free_ordered) > 0 ? `${inPacks(r.free_sent, r.free_unit, r.free_pack?.unit, r.free_pack?.factor)}${r.free_item ? ` of ${r.free_item}` : ""}` : "—") },
        { key: "free_value", header: "Free goods value", type: "money", exact: true, value: (r) => Number(r.free_value), total: "sum", mobile: "show" },
        { key: "discount", header: "Discount given", type: "money", exact: true, value: (r) => Number(r.discount_value), total: "sum", mobile: "show" },
      ];
    }
    if (group === "outstanding") {
      return [
        { key: "name", header: by === "route" ? "Route" : "Salesperson", value: (r) => r.name, mobile: "title" },
        { key: "customers", header: "Customers owing", type: "number", value: (r) => r.customers, total: "sum" },
        { key: "balance", header: "Outstanding", type: "money", exact: true, value: (r) => Number(r.balance), total: "sum", mobile: "show" },
        { key: "d30", header: "0–30 days", type: "money", exact: true, value: (r) => Number(r.days_0_30), total: "sum" },
        { key: "d60", header: "31–60", type: "money", exact: true, value: (r) => Number(r.days_31_60), total: "sum" },
        { key: "d90", header: "61–90", type: "money", exact: true, value: (r) => Number(r.days_61_90), total: "sum" },
        { key: "d90p", header: "Over 90", type: "money", exact: true, value: (r) => Number(r.days_over_90), total: "sum", mobile: "show" },
        { key: "overdue", header: "Overdue", type: "money", exact: true, value: (r) => Number(r.overdue), total: "sum" },
      ];
    }
    const label = { salesperson: "Salesperson", route: "Route", customer: "Customer" }[group];
    return [
      { key: "name", header: label, value: (r) => r.name, mobile: "title" },
      { key: "orders", header: "Orders taken", type: "number", value: (r) => r.orders, total: "sum" },
      { key: "ordered", header: "Order value", type: "money", exact: true, value: (r) => Number(r.ordered), total: "sum" },
      { key: "invoices", header: "Invoices", type: "number", value: (r) => r.invoices, total: "sum", mobile: "show" },
      { key: "invoiced", header: "Invoiced", type: "money", exact: true, value: (r) => Number(r.invoiced), total: "sum" },
      { key: "returned", header: "Returns", type: "money", exact: true, value: (r) => Number(r.returned), total: "sum" },
      { key: "net", header: "Net sales", type: "money", exact: true, value: (r) => Number(r.net_sales), total: "sum", mobile: "show" },
    ];
  }, [group, by]);

  const rows = data?.key === report ? data.rows : null;
  return (
    <div className="stack">
      <BusinessHeader icon="chart" title="Wholesale reports"
        description={group === "schemes"
          ? "Orders taken in the period that earned a scheme: what each retailer bought on it and was sent, the free goods sent (valued at the list price) and the discount given on those lines."
          : "Sales are invoices dated in the period less returns dated in the period. An invoice belongs to the salesperson and route of the order it was dispatched from; counter sales are shown on their own line."} />
      <ErrorMessage message={allowed ? "" : "Your role cannot see the figures this report adds up."} />
      <SectionCard flush icon="list" title={REPORTS.find((r) => r.value === report)?.label}>
        <DataGrid key={report} id={`wholesale-report-${report.replace(":", "-")}`} caption="Wholesale report" columns={columns} rows={rows || []} rowKey={(r, i) => `${r.id ?? r.day ?? r.contact_id}-${r.scheme_id || ""}-${r.method || ""}-${r.salesperson || ""}-${r.route || ""}-${i}`}
          loading={allowed && !rows && !error} error={rows ? "" : error} onRetry={() => setVersion((n) => n + 1)} currency={biz.symbol}
          defaultSort={group === "collections" ? NEWEST_FIRST : undefined}
          toolbar={(
            <>
              <Segmented label="Report" value={report} options={options} onChange={setReport} />
              {group !== "outstanding" && <DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="report dates" onChange={(next) => next.from && next.to && setRange(next)} />}
            </>
          )}
          exportName={biz.can("reports.export") ? `${biz.business.code}-wholesale-${report.replace(":", "-")}` : undefined}
          empty={group === "outstanding" ? "Nobody owes anything" : group === "schemes" ? "No scheme was earned in these dates" : "Nothing in these dates"} emptyIcon="chart" />
      </SectionCard>
    </div>
  );
}
