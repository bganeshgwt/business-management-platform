import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { dateTime } from "@bmp/shared/format";
import { BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { businessToday, quantity, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import "../../../../styles/business-salon-weight.css";

// Service profitability (round 2, R2-SVC): per service in a period, what it
// sold for (after discounts and returns, before GST), the back-bar products
// it used (at their latest purchase price) and the stylists' commission, and
// what is left; and every product taken by a service, with any shortfall.
const TABS = [{ value: "services", label: "By service" }, { value: "usage", label: "Products used" }];

export default function SalonReportsPage() {
  const [tab, setTab] = useState("services");
  return (
    <div className="stack">
      <BusinessHeader icon="chart" title="Service profitability"
        description="What each service earns after the products it used and the stylist's commission. Products are costed at their latest purchase price." />
      <Segmented label="Show" value={tab} options={TABS} onChange={setTab} />
      {tab === "services" ? <ByService /> : <Usage />}
    </div>
  );
}

function ByService() {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "salon/reports/service-profitability", range, controller.signal).then((r) => { setData(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range, version]);
  const columns = useMemo(() => [
    { key: "label", header: "Service", value: (r) => r.label, mobile: "title", pin: true },
    { key: "done", header: "Done", type: "number", value: (r) => Number(r.done), total: "sum", mobile: "show" },
    { key: "sales", header: "Sales", type: "money", exact: true, value: (r) => Number(r.sales), total: "sum", mobile: "show" },
    { key: "product_cost", header: "Products used", type: "money", exact: true, value: (r) => Number(r.product_cost), total: "sum", mobile: "show" },
    { key: "product_cost_per_service", header: "Products per service", type: "money", exact: true, value: (r) => Number(r.product_cost_per_service), defaultHidden: true },
    { key: "commission", header: "Commission", type: "money", exact: true, value: (r) => Number(r.commission), total: "sum" },
    { key: "margin", header: "Left", type: "money", exact: true, value: (r) => Number(r.margin), total: "sum", mobile: "show" },
    { key: "margin_percent", header: "Left %", type: "percent", value: (r) => (r.margin_percent === null ? null : Number(r.margin_percent)) },
  ], []);
  const t = data?.totals;
  return (
    <>
      <div className="sw-tiles">
        <StatTile icon="money" tone="primary" label="Service sales" money={t ? Number(t.sales) : undefined} loading={!data && !error} note="after discounts, before GST" />
        <StatTile icon="layers" label="Products used" money={t ? Number(t.productCost) : undefined} loading={!data && !error} note="back-bar, at the latest purchase price" />
        <StatTile icon="percent" label="Commission" money={t ? Number(t.commission) : undefined} loading={!data && !error} note="flat rules, per line" />
        <StatTile icon="trend-up" tone="success" label="Left" money={t ? Number(t.margin) : undefined} loading={!data && !error}
          note={data?.short?.lines ? `${data.short.lines} use${data.short.lines === 1 ? "" : "s"} short of stock in the books` : undefined} />
      </div>
      <ErrorMessage message={error} />
      <SectionCard flush icon="chart" title="By service" description={data?.commissionNote}>
        <DataGrid id="salon-report-profitability" caption="Service profitability" columns={columns} rows={data?.rows || []} rowKey={(r) => r.sku_id}
          loading={!data && !error} error={data ? "" : error} onRetry={() => setVersion((n) => n + 1)} currency={biz.symbol} rowNoun={["service", "services"]}
          defaultSort={{ key: "sales", direction: "desc" }} exportName={biz.can("reports.export") ? `${biz.business.code}-service-profitability` : undefined}
          rowClassName={(r) => (Number(r.margin) < 0 ? "dg-tone-danger" : "")}
          toolbar={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="bill dates" onChange={(next) => { setRange(next); setData(null); }} />}
          empty="No services billed in these dates" emptyIcon="chart" />
      </SectionCard>
    </>
  );
}

function Usage() {
  const biz = useOpenBusiness();
  const list = useServerList("salon/backbar-usage", { gridId: "salon-backbar-usage", period: true });
  const columns = useMemo(() => [
    { key: "created_at", header: "When", type: "datetime", value: (u) => u.created_at, mobile: "subtitle", render: (u) => dateTime(u.created_at) },
    { key: "label", header: "Product", value: (u) => u.label, mobile: "title", pin: true },
    { key: "service_name", header: "Service", value: (u) => u.service_name, mobile: "show" },
    { key: "document_no", header: "Bill", value: (u) => u.document_no },
    { key: "contact_name", header: "Client", value: (u) => u.contact_name || "Walk-in", defaultHidden: true },
    { key: "quantity", header: "Used", type: "number", value: (u) => Number(u.quantity), render: (u) => quantity(u.quantity, u.unit), mobile: "show" },
    { key: "short", header: "Not in stock", type: "number", value: (u) => Number(u.short), render: (u) => (Number(u.short) > 0 ? <span className="sw-yield-low">{quantity(u.short, u.unit)}</span> : "—") },
    { key: "cost", header: "Cost", type: "money", exact: true, value: (u) => Number(u.cost), total: "sum", mobile: "show" },
    { key: "location_name", header: "Location", value: (u) => u.location_name, defaultHidden: biz.locations.length < 2 },
  ], [biz.locations.length]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="layers" title="Products taken by services"
        description="Taken from stock when the service is billed. Not in stock: the books had less than the recipe; receive or count the product.">
        <DataGrid {...list.gridProps} caption="Back-bar products used" columns={columns} currency={biz.symbol} rowNoun={["use", "uses"]}
          rowClassName={(u) => (Number(u.short) > 0 ? "dg-tone-warning" : "")} toolbar={<PeriodFilter list={list} />}
          exportName={biz.can("reports.export") ? `${biz.business.code}-backbar-usage` : undefined}
          empty="No products used in these dates" emptyHint="Set the products each service uses under Stylists & services › Service times." emptyIcon="layers" />
      </SectionCard>
    </>
  );
}
