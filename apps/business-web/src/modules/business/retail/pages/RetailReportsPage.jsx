import ContentTabs from "../../../../components/ContentTabs";
import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { BarList } from "../../../../components/Charts";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { businessToday, quantity, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/business-retail.css";

// Retail reports: what sells, what sits on the shelf, what each category
// earns, and what the stock is worth. Sales are net of returns and before
// GST; cost is what each sold unit cost when it left the shelf.

const TABS = [["top", "Top sellers"], ["slow", "Slow movers"], ["margin", "Margin by category"], ["value", "Stock value"]];
const pct = (part, whole) => (Number(whole) ? `${((Number(part) * 100) / Number(whole)).toFixed(1)}%` : "—");

function useReport(biz, path, params, enabled) {
  const [state, setState] = useState({ data: null, error: "", key: "" });
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, path, JSON.parse(key), controller.signal)
      .then((data) => setState({ data, error: "", key }))
      .catch((err) => { if (!controller.signal.aborted) setState({ data: null, error: getErrorMessage(err), key }); });
    return () => controller.abort();
  }, [biz.id, path, key, enabled]);
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : "", loading: state.key !== key };
}

export default function RetailReportsPage() {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [tab, setTab] = useState("top");
  const [range, setRange] = useState({ from: monthStart(anchor), to: anchor });
  const [days, setDays] = useState("30");
  const [location, setLocation] = useState("");
  const locations = biz.locations;
  const canSales = biz.can("sales.view"), canStock = biz.can("inventory.view");
  const tabs = TABS.filter(([key]) => (key === "top" || key === "margin" ? canSales : canStock));
  const active = tabs.some(([key]) => key === tab) ? tab : tabs[0]?.[0];
  const where = location ? { location } : {};
  const top = useReport(biz, "retail/reports/top-sellers", { ...range, ...where }, active === "top");
  const slow = useReport(biz, "retail/reports/slow-movers", { days, ...where }, active === "slow");
  const margin = useReport(biz, "retail/reports/category-margin", { ...range, ...where }, active === "margin");
  const value = useReport(biz, "retail/reports/stock-value", where, active === "value");
  const exportName = (name) => (biz.can("reports.export") ? `${biz.business.code}-${name}` : undefined);

  const dates = <DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="report dates" onChange={(next) => { if (next.from && next.to) setRange(next); }} />;
  const where2 = locations.length > 1 && (
    <label className="field">
      <span>Location</span>
      <select value={location} onChange={(e) => setLocation(e.target.value)}>
        <option value="">All locations</option>
        {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  );

  return (
    <div className="stack">
      <BusinessHeader icon="chart" title="Retail reports"
        description="Sales are after returns and before GST. Cost is what each unit cost when it was sold, so margins do not move when purchase prices change." />
      <ContentTabs label="Retail reports" value={active} options={tabs.map(([value,label])=>({value,label}))} onChange={setTab}>
      {/* The filters sit above the figures they change. */}
      {(active !== "value" || where2) && (
        <div className="rt-toolbar rt-report-filters">
          {(active === "top" || active === "margin") && dates}
          {active === "slow" && (
            <label className="field"><span>Look back</span>
              <select value={days} onChange={(e) => setDays(e.target.value)}>{["7", "14", "30", "60", "90", "180"].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
            </label>
          )}
          {where2}
        </div>
      )}
      {active === "top" && <TopSellers biz={biz} report={top} exportName={exportName("top-sellers")} />}
      {active === "slow" && <SlowMovers biz={biz} report={slow} days={days} exportName={exportName("slow-movers")} />}
      {active === "margin" && <Margin biz={biz} report={margin} exportName={exportName("category-margin")} />}
      {active === "value" && <StockValue biz={biz} report={value} exportName={exportName("stock-value")} />}
      </ContentTabs>
    </div>
  );
}

function TopSellers({ biz, report, exportName }) {
  const rows = report.data?.rows || [];
  const sum = (key) => rows.reduce((s, r) => s + Number(r[key]), 0);
  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", pin: true, render: (r) => <span className="bz-two-line"><strong>{r.label}</strong><small className="muted mono">{r.code}</small></span> },
    { key: "category", header: "Category", value: (r) => r.category || "", filter: "select", mobile: "subtitle" },
    { key: "quantity", header: "Sold", type: "number", value: (r) => Number(r.quantity), render: (r) => quantity(r.quantity, r.unit) },
    { key: "bills", header: "Bills", type: "number", value: (r) => r.bills, defaultHidden: true },
    { key: "net", header: "Sales", type: "money", exact: true, value: (r) => Number(r.net), total: "sum", mobile: "show" },
    { key: "cost", header: "Cost", type: "money", exact: true, value: (r) => Number(r.cost), total: "sum" },
    { key: "margin", header: "Margin", type: "money", exact: true, value: (r) => Number(r.margin), total: "sum", mobile: "show" },
    { key: "margin_percent", header: "Margin %", type: "percent", value: (r) => (Number(r.net) ? (Number(r.margin) * 100) / Number(r.net) : null) },
  ], []);
  return (
    <>
      <div className="stat-grid">
        <StatTile icon="receipt" tone="primary" label="Sales" value={report.data ? biz.amount(sum("net")) : "—"} note="after returns, before GST" />
        <StatTile icon="box" label="Cost of goods sold" value={report.data ? biz.amount(sum("cost")) : "—"} />
        <StatTile icon="chart" tone="success" label="Margin" value={report.data ? biz.amount(sum("margin")) : "—"} note={report.data ? pct(sum("margin"), sum("net")) : ""} />
        <StatTile icon="tag" label="Items sold" value={report.data ? String(rows.length) : "—"} />
      </div>
      {rows.length > 0 && (
        <SectionCard icon="chart" title="Best sellers by sales">
          <BarList currency={biz.symbol} rows={rows.slice(0, 8).map((r) => ({ label: r.label, value: Number(r.net), sub: quantity(r.quantity, r.unit) }))} />
        </SectionCard>
      )}
      <SectionCard flush icon="list" title="Every item sold">
        <ErrorMessage message={report.error} />
        <DataGrid id="retail-report-top" caption="Top sellers" rows={rows.map((r) => ({ ...r, id: r.sku_id }))} loading={report.loading} columns={columns} currency={biz.symbol}
          exportName={exportName} rowNoun={["item", "items"]} defaultSort={{ key: "net", direction: "desc" }}
          rowClassName={(r) => (Number(r.margin) < 0 ? "dg-tone-danger" : "")} empty="Nothing sold in these dates" emptyIcon="chart" />
      </SectionCard>
    </>
  );
}

function SlowMovers({ biz, report, days, exportName }) {
  const rows = report.data?.rows || [];
  const unsold = rows.filter((r) => Number(r.sold) === 0);
  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", pin: true, render: (r) => <span className="bz-two-line"><strong>{r.label}</strong><small className="muted mono">{r.code}</small></span> },
    { key: "category", header: "Category", value: (r) => r.category || "", filter: "select" },
    { key: "on_hand", header: "On hand", type: "number", value: (r) => Number(r.on_hand), render: (r) => quantity(r.on_hand, r.unit) },
    { key: "value", header: "Stock value", type: "money", value: (r) => Number(r.value), total: "sum", mobile: "show" },
    { key: "sold", header: `Sold in ${days} days`, type: "number", value: (r) => Number(r.sold), render: (r) => (Number(r.sold) ? quantity(r.sold, r.unit) : <Badge tone="danger" label="Not sold" />), mobile: "subtitle" },
    { key: "days_since_sale", header: "Days since last sale", type: "number", value: (r) => (r.days_since_sale === null ? null : Number(r.days_since_sale)), render: (r) => (r.days_since_sale === null ? <span className="muted">Never sold</span> : r.days_since_sale), mobile: "show" },
    { key: "cover_days", header: "Lasts (days at this pace)", type: "number", value: (r) => (r.cover_days === null ? null : Number(r.cover_days)) },
  ], [days]);
  return (
    <>
      <div className="stat-grid">
        <StatTile icon="alert" tone="danger" label={`Not sold in ${days} days`} value={report.data ? String(unsold.length) : "—"} note={report.data ? `${biz.amount(unsold.reduce((s, r) => s + Number(r.value), 0))} tied up` : ""} />
        <StatTile icon="box" label="Items in stock" value={report.data ? String(rows.length) : "—"} />
        <StatTile icon="wallet" tone="warning" label="Stock value" value={report.data ? biz.amount(rows.reduce((s, r) => s + Number(r.value), 0)) : "—"} note="at cost" />
      </div>
      <SectionCard flush icon="list" title="Slowest first" description="Items with stock, ordered by how little of it sold. Consider an offer or a smaller next order.">
        <ErrorMessage message={report.error} />
        <DataGrid id="retail-report-slow" caption="Slow movers" rows={rows.map((r) => ({ ...r, id: r.sku_id }))} loading={report.loading} columns={columns} currency={biz.symbol}
          exportName={exportName} rowNoun={["item", "items"]} rowClassName={(r) => (Number(r.sold) === 0 ? "dg-tone-warning" : "")}
          empty="No stock on hand" emptyIcon="box" />
      </SectionCard>
    </>
  );
}

function Margin({ biz, report, exportName }) {
  const rows = report.data?.rows || [];
  const net = rows.reduce((s, r) => s + Number(r.net), 0), cost = rows.reduce((s, r) => s + Number(r.cost), 0);
  const columns = useMemo(() => [
    { key: "category", header: "Category", value: (r) => r.category, mobile: "title", pin: true },
    { key: "items", header: "Items sold", type: "number", value: (r) => r.items },
    { key: "net", header: "Sales", type: "money", exact: true, value: (r) => Number(r.net), total: "sum", mobile: "show" },
    { key: "share", header: "Share of sales", type: "percent", value: (r) => (net ? (Number(r.net) * 100) / net : null) },
    { key: "cost", header: "Cost", type: "money", exact: true, value: (r) => Number(r.cost), total: "sum" },
    { key: "margin", header: "Margin", type: "money", exact: true, value: (r) => Number(r.margin), total: "sum", mobile: "show" },
    { key: "margin_percent", header: "Margin %", type: "percent", value: (r) => (r.margin_percent === null ? null : Number(r.margin_percent)), mobile: "subtitle" },
  ], [net]);
  return (
    <>
      <div className="stat-grid">
        <StatTile icon="receipt" tone="primary" label="Sales" value={report.data ? biz.amount(net) : "—"} />
        <StatTile icon="chart" tone="success" label="Margin" value={report.data ? biz.amount(net - cost) : "—"} note={report.data ? pct(net - cost, net) : ""} />
        <StatTile icon="layers" label="Categories" value={report.data ? String(rows.length) : "—"} />
      </div>
      {rows.length > 0 && (
        <SectionCard icon="chart" title="Margin by category">
          <BarList currency={biz.symbol} rows={rows.slice(0, 8).map((r) => ({ label: r.category, value: Math.max(0, Number(r.margin)), sub: r.margin_percent === null ? "" : `${Number(r.margin_percent)}%` }))} />
        </SectionCard>
      )}
      <SectionCard flush icon="list" title="By category">
        <ErrorMessage message={report.error} />
        <DataGrid id="retail-report-margin" caption="Margin by category" rows={rows.map((r) => ({ ...r, id: r.key }))} loading={report.loading} columns={columns} currency={biz.symbol}
          exportName={exportName} rowNoun={["category", "categories"]} empty="Nothing sold in these dates" emptyIcon="chart" />
      </SectionCard>
    </>
  );
}

function StockValue({ biz, report, exportName }) {
  const rows = report.data?.rows || [];
  const cost = rows.reduce((s, r) => s + Number(r.cost_value), 0), sale = rows.reduce((s, r) => s + Number(r.sale_value), 0);
  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", pin: true, render: (r) => <span className="bz-two-line"><strong>{r.label}</strong><small className="muted mono">{r.code}</small></span> },
    { key: "category", header: "Category", value: (r) => r.category || "", filter: "select", mobile: "subtitle" },
    { key: "quantity", header: "On hand", type: "number", value: (r) => Number(r.quantity), render: (r) => quantity(r.quantity, r.unit) },
    { key: "average_cost", header: "Average cost", type: "money", exact: true, value: (r) => Number(r.average_cost) },
    { key: "cost_value", header: "Value at cost", type: "money", exact: true, value: (r) => Number(r.cost_value), total: "sum", mobile: "show" },
    { key: "sale_value", header: "Value at selling price", type: "money", exact: true, value: (r) => Number(r.sale_value), total: "sum", mobile: "show" },
    { key: "markup", header: "Margin in stock", type: "money", exact: true, value: (r) => Number(r.sale_value) - Number(r.cost_value), total: "sum" },
  ], []);
  return (
    <>
      <div className="stat-grid">
        <StatTile icon="box" tone="primary" label="Stock at cost" value={report.data ? biz.amount(cost) : "—"} />
        <StatTile icon="tag" label="At selling price" value={report.data ? biz.amount(sale) : "—"} note="before GST" />
        <StatTile icon="chart" tone="success" label="Margin in stock" value={report.data ? biz.amount(sale - cost) : "—"} note={report.data ? pct(sale - cost, sale) : ""} />
      </div>
      <SectionCard flush icon="list" title="Stock on hand by item">
        <ErrorMessage message={report.error} />
        <DataGrid id="retail-report-value" caption="Stock value" rows={rows.map((r) => ({ ...r, id: r.sku_id }))} loading={report.loading} columns={columns} currency={biz.symbol}
          exportName={exportName} rowNoun={["item", "items"]} defaultSort={{ key: "cost_value", direction: "desc" }} empty="No stock on hand" emptyIcon="box" />
      </SectionCard>
    </>
  );
}
