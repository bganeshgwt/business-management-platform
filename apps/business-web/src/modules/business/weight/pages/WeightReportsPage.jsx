import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { kg, percentText, weightOf, yieldTone } from "./weight";

// Actual processing output, loss and wastage for a period.
export default function WeightReportsPage() {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const seesYield = biz.can("processing.view");
  const seesWaste = biz.can("wastage.view");
  const tabs = [
    seesYield && { value: "yield-cuts", label: "By output" }, seesYield && { value: "yield-suppliers", label: "By supplier" }, seesYield && { value: "yield-days", label: "By day" },
    seesYield && { value: "yield-offcuts", label: "Offcuts" },
    seesWaste && { value: "waste-items", label: "Wastage by item" }, seesWaste && { value: "waste-reasons", label: "Wastage by reason" }, seesWaste && { value: "waste-days", label: "Wastage by day" },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.value);
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const [location, setLocation] = useState("");
  // Optional staff and supplier filters for processing history.
  const [filters, setFilters] = useState({ cutter: "", supplier: "" });
  const [yieldData, setYield] = useState(null);
  const [wasteData, setWaste] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const query = { ...range, location: location || undefined };
    const yieldQuery = { ...query, cutter: filters.cutter || undefined, supplier: filters.supplier || undefined };
    Promise.all([
      seesYield ? businessRead(biz.id, "weight/reports/yield", yieldQuery, controller.signal) : null,
      seesWaste ? businessRead(biz.id, "weight/reports/wastage", query, controller.signal) : null,
    ]).then(([y, w]) => { setYield(y); setWaste(w); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range, location, seesYield, seesWaste, version, filters]);

  const toolbar = (
    <>
      <DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="dates" onChange={(next) => { setRange(next); setYield(null); setWaste(null); }} />
      {tab?.startsWith("yield") && (
        <>
          {(yieldData?.cutters || []).length > 0 && (
            <label className="field"><span>{biz.type === "weight_retail" ? "Sorted by" : "Cut by"}</span>
              <select value={filters.cutter} onChange={(e) => setFilters((f) => ({ ...f, cutter: e.target.value }))}>
                <option value="">Everyone</option>
                {yieldData.cutters.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          {(yieldData?.suppliers || []).length > 0 && (
            <label className="field"><span>Supplier</span>
              <select value={filters.supplier} onChange={(e) => setFilters((f) => ({ ...f, supplier: e.target.value }))}>
                <option value="">Every supplier</option>
                {yieldData.suppliers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
        </>
      )}
      {biz.locations.length > 1 && (
        <label className="field"><span>Location</span>
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">Every location</option>
            {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      )}
    </>
  );
  const grid = { currency: biz.symbol, loading: tab?.startsWith("yield") ? !yieldData && !error : !wasteData && !error, error, onRetry: () => setVersion((n) => n + 1), toolbar,
    exportName: biz.can("reports.export") ? `${biz.business.code}-${tab}` : undefined };

  return (
    <div className="stack">
      <BusinessHeader icon="chart" title={biz.type === "weight_retail" ? "Repacking & wastage" : "Cutting & wastage"}
        description="Input weight, usable output, processing loss and discarded stock for the selected dates." />
      <div className="sw-tiles">
        {seesYield && <StatTile icon="scale" tone="primary" label="Yield" value={yieldData?.totals.yieldPercent ? percentText(yieldData.totals.yieldPercent) : "—"}
          note={yieldData ? `${kg(yieldData.totals.outputKg)} of cuts from ${kg(yieldData.totals.inputKg)}` : ""} />}
        {seesYield && <StatTile icon="trend-down" tone="warning" label="Processing loss" value={yieldData ? kg(yieldData.totals.lossKg) : undefined} loading={!yieldData && !error}
          note={yieldData ? `${yieldData.totals.batches} batches` : ""} />}
        {seesWaste && <StatTile icon="trash" tone="danger" label="Wasted" value={wasteData ? kg(wasteData.totals.kg) : undefined} loading={!wasteData && !error} note={wasteData ? `${wasteData.totals.entries} entries` : ""} />}
        {seesWaste && <StatTile icon="rupee" label="Wastage at cost" money={wasteData ? Number(wasteData.totals.value) : undefined} loading={!wasteData && !error} />}
        {/* What offcuts sold cheap brought in, from the bills. */}
        {seesYield && <StatTile icon="rupee" tone="success" label="Recovered from offcuts" money={yieldData ? Number(yieldData.offcuts.recovered) : undefined} loading={!yieldData && !error}
          note={yieldData ? `${yieldData.offcuts.items.length} ${yieldData.offcuts.items.length === 1 ? "offcut" : "offcuts"} on the bills` : ""} />}
      </div>
      <Segmented label="Report" value={tab} options={tabs} onChange={setTab} />
      <ErrorMessage message={error} />
      {/* One grid per tab, each with its own id; the key remounts it when the tab changes. */}
      {tab === "yield-cuts" && <YieldCuts key={tab} rows={yieldData?.cuts} grid={grid} />}
      {tab === "yield-days" && <YieldDays key={tab} rows={yieldData ? mergeDays(yieldData.days, yieldData.offcuts.days) : undefined} grid={grid} />}
      {tab === "yield-offcuts" && <Offcuts key={tab} rows={yieldData?.offcuts.items} grid={grid} />}
      {tab === "yield-suppliers" && <YieldSuppliers key={tab} rows={yieldData?.bySupplier} grid={grid} />}
      {tab === "waste-items" && <WasteItems key={tab} rows={wasteData?.items} grid={grid} />}
      {tab === "waste-reasons" && <WasteReasons key={tab} rows={wasteData?.reasons} grid={grid} />}
      {tab === "waste-days" && <WasteDays key={tab} rows={wasteData?.days} grid={grid} />}
    </div>
  );
}

function YieldCuts({ rows, grid }) {
  const columns = useMemo(() => [
    { key: "label", header: "Cut", value: (r) => r.label, mobile: "title", pin: true },
    { key: "from_label", header: "From", value: (r) => r.from_label, mobile: "subtitle", filter: "select" },
    { key: "batches", header: "Batches", type: "number", value: (r) => r.batches },
    { key: "kg", header: "Weight", type: "number", value: (r) => Number(r.kg), total: "sum", render: (r) => kg(r.kg), mobile: "show" },
    { key: "share_percent", header: "Of the input", type: "percent", value: (r) => Number(r.share_percent), mobile: "show",
      render: (r) => <span className={yieldTone(r.share_percent, r.expected_percent)}>{percentText(r.share_percent)}</span> },
    { key: "expected_percent", header: "Expected", type: "percent", value: (r) => (r.expected_percent === null ? null : Number(r.expected_percent)) },
    { key: "cost", header: "Cost carried", type: "money", exact: true, value: (r) => Number(r.cost), total: "sum" },
    { key: "cost_per_kg", header: "Cost per kg", type: "money", exact: true, value: (r) => Number(r.cost_per_kg) },
  ], []);
  return (
    <SectionCard flush icon="layers" title="What each cut gave">
      <DataGrid id="weight-report-yield-cuts" caption="Yield by cut" columns={columns} rows={rows || []} rowKey={(r) => `${r.output_sku_id}-${r.from_label}`} {...grid}
        rowNoun={["cut", "cuts"]} empty="Nothing cut in these dates" emptyIcon="layers" />
    </SectionCard>
  );
}

// Each day's cutting, with what offcuts brought in on that day's bills (a day
// with offcut sales and no cutting shows too).
function mergeDays(days, offcutDays) {
  const byDay = new Map((days || []).map((d) => [d.day, { ...d, recovered: 0 }]));
  for (const o of offcutDays || []) {
    byDay.set(o.day, { day: o.day, batches: 0, input_kg: 0, output_kg: 0, loss_kg: 0, yield_percent: null, ...byDay.get(o.day), recovered: Number(o.recovered) });
  }
  return [...byDay.values()].sort((a, b) => String(b.day).localeCompare(String(a.day)));
}

function YieldDays({ rows, grid }) {
  const columns = useMemo(() => [
    { key: "day", header: "Day", type: "date", value: (r) => r.day, mobile: "title", pin: true },
    { key: "batches", header: "Batches", type: "number", value: (r) => r.batches, total: "sum" },
    { key: "input_kg", header: "In", type: "number", value: (r) => Number(r.input_kg), total: "sum", render: (r) => kg(r.input_kg), mobile: "show" },
    { key: "output_kg", header: "Cuts", type: "number", value: (r) => Number(r.output_kg), total: "sum", render: (r) => kg(r.output_kg) },
    { key: "loss_kg", header: "Loss", type: "number", value: (r) => Number(r.loss_kg), total: "sum", render: (r) => kg(r.loss_kg) },
    { key: "yield_percent", header: "Yield", type: "percent", value: (r) => (r.yield_percent === null ? null : Number(r.yield_percent)), mobile: "show" },
    { key: "recovered", header: "Recovered from offcuts", type: "money", exact: true, value: (r) => Number(r.recovered || 0), total: "sum" },
  ], []);
  return (
    <SectionCard flush icon="calendar" title="Cutting by day">
      <DataGrid id="weight-report-yield-days" caption="Cutting by day" columns={columns} rows={rows || []} rowKey={(r) => r.day} {...grid}
        rowNoun={["day", "days"]} empty="Nothing cut in these dates" emptyIcon="calendar" />
    </SectionCard>
  );
}

// Offcuts by item: what was cut as offcuts in these dates, and what their
// bills brought in (before GST, less what came back).
function Offcuts({ rows, grid }) {
  const columns = useMemo(() => [
    { key: "label", header: "Offcut", value: (r) => r.label, mobile: "title", pin: true },
    { key: "cut_kg", header: "Cut", type: "number", value: (r) => Number(r.cut_kg), total: "sum", render: (r) => kg(r.cut_kg) },
    { key: "quantity", header: "Sold", type: "number", value: (r) => Number(r.quantity), render: (r) => weightOf(r.quantity, r.unit), mobile: "show" },
    { key: "bills", header: "Bills", type: "number", value: (r) => r.bills, total: "sum" },
    { key: "recovered", header: "Recovered", type: "money", exact: true, value: (r) => Number(r.recovered), total: "sum", mobile: "show" },
  ], []);
  return (
    <SectionCard flush icon="rupee" title="What offcuts brought in"
      description="A cut sold for less a kilo than its whole item cost is an offcut (bones, skin, fish heads). Recovered is what its bills brought in, before GST, less returns.">
      <DataGrid id="weight-report-offcuts" caption="Offcuts" columns={columns} rows={rows || []} rowKey={(r) => r.sku_id} {...grid}
        rowNoun={["offcut", "offcuts"]} defaultSort={{ key: "recovered", direction: "desc" }}
        empty="No offcuts cut or sold in these dates" emptyHint="Cuts priced below what their whole item cost a kilo show here." emptyIcon="rupee" />
    </SectionCard>
  );
}

function WasteItems({ rows, grid }) {
  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", pin: true },
    { key: "entries", header: "Entries", type: "number", value: (r) => r.entries, total: "sum" },
    { key: "quantity", header: "Wasted", type: "number", value: (r) => Number(r.kg ?? r.quantity), total: "sum", render: (r) => weightOf(r.quantity, r.unit), mobile: "show" },
    { key: "sold_quantity", header: "Sold", type: "number", value: (r) => Number(r.sold_quantity), render: (r) => weightOf(r.sold_quantity, r.unit) },
    { key: "wastage_percent", header: "Wasted of sold + wasted", type: "percent", value: (r) => (r.wastage_percent === null ? null : Number(r.wastage_percent)), mobile: "show" },
    { key: "value", header: "Cost", type: "money", exact: true, value: (r) => Number(r.value), total: "sum", mobile: "show" },
  ], []);
  return (
    <SectionCard flush icon="trash" title="Wastage by item">
      <DataGrid id="weight-report-waste-items" caption="Wastage by item" columns={columns} rows={rows || []} rowKey={(r) => r.sku_id} {...grid}
        rowNoun={["item", "items"]} defaultSort={{ key: "value", direction: "desc" }} rowClassName={(r) => (Number(r.wastage_percent) >= 10 ? "dg-tone-danger" : "")}
        empty="No wastage in these dates" emptyIcon="trash" />
    </SectionCard>
  );
}

function WasteReasons({ rows, grid }) {
  const columns = useMemo(() => [
    { key: "label", header: "Reason", value: (r) => r.label, mobile: "title", pin: true },
    { key: "entries", header: "Entries", type: "number", value: (r) => r.entries, total: "sum", mobile: "show" },
    { key: "kg", header: "Weight", type: "number", value: (r) => Number(r.kg || 0), total: "sum", render: (r) => kg(r.kg), mobile: "show" },
    { key: "value", header: "Cost", type: "money", exact: true, value: (r) => Number(r.value), total: "sum", mobile: "show" },
  ], []);
  return (
    <SectionCard flush icon="pie" title="Wastage by reason">
      <DataGrid id="weight-report-waste-reasons" caption="Wastage by reason" columns={columns} rows={rows || []} rowKey={(r) => r.reason} {...grid}
        rowNoun={["reason", "reasons"]} empty="No wastage in these dates" emptyIcon="pie" />
    </SectionCard>
  );
}

function WasteDays({ rows, grid }) {
  const columns = useMemo(() => [
    { key: "day", header: "Day", type: "date", value: (r) => r.day, mobile: "title", pin: true },
    { key: "entries", header: "Entries", type: "number", value: (r) => r.entries, total: "sum" },
    { key: "kg", header: "Weight", type: "number", value: (r) => Number(r.kg || 0), total: "sum", render: (r) => kg(r.kg), mobile: "show" },
    { key: "value", header: "Cost", type: "money", exact: true, value: (r) => Number(r.value), total: "sum", mobile: "show" },
  ], []);
  return (
    <SectionCard flush icon="calendar" title="Wastage by day">
      <DataGrid id="weight-report-waste-days" caption="Wastage by day" columns={columns} rows={rows || []} rowKey={(r) => r.day} {...grid}
        rowNoun={["day", "days"]} empty="No wastage in these dates" emptyIcon="calendar" />
    </SectionCard>
  );
}

// The average yield of each whole item by the supplier it
// was bought from (total cut ÷ total whole weight), against that item's
// average over every supplier — whose birds dress out lighter shows here.
function YieldSuppliers({ rows, grid }) {
  const columns = useMemo(() => [
    { key: "supplier_name", header: "Supplier", value: (r) => r.supplier_name, mobile: "title", pin: true, filter: "select" },
    { key: "input_label", header: "Whole item", value: (r) => r.input_label, mobile: "subtitle", filter: "select" },
    { key: "batches", header: "Batches", type: "number", value: (r) => r.batches, total: "sum" },
    { key: "input_kg", header: "Cut", type: "number", value: (r) => Number(r.input_kg), total: "sum", render: (r) => kg(r.input_kg), mobile: "show" },
    { key: "output_kg", header: "Usable", type: "number", value: (r) => Number(r.output_kg), total: "sum", render: (r) => kg(r.output_kg) },
    { key: "yield_percent", header: "Average yield", type: "percent", value: (r) => Number(r.yield_percent), mobile: "show",
      render: (r) => <span className={yieldTone(r.yield_percent, r.expected_percent ?? r.item_average_percent)}>{percentText(r.yield_percent)}</span> },
    { key: "versus_average", header: "Against the item's average", value: (r) => (r.versus_average === null ? null : Number(r.versus_average)), mobile: "show",
      render: (r) => (r.versus_average === null ? "—" : <span className={Number(r.versus_average) < -0.5 ? "sw-yield-low" : Number(r.versus_average) > 0.5 ? "sw-yield-good" : ""}>
        {Number(r.versus_average) > 0 ? "+" : ""}{Number(r.versus_average).toFixed(1)} pts</span>) },
    { key: "range", header: "Worst – best batch", value: (r) => Number(r.worst_percent), render: (r) => `${percentText(r.worst_percent)} – ${percentText(r.best_percent)}`, defaultHidden: true },
    { key: "expected_percent", header: "Expected", type: "percent", value: (r) => (r.expected_percent === null ? null : Number(r.expected_percent)), defaultHidden: true },
    { key: "cost_per_usable_kg", header: "Cost per usable kg", type: "money", exact: true, value: (r) => Number(r.cost_per_usable_kg), mobile: "show" },
  ], []);
  return (
    <SectionCard flush icon="truck" title="Yield by supplier" description="Each whole item's yield from each supplier it was bought from, in these dates.">
      <DataGrid id="weight-report-yield-suppliers" caption="Yield by supplier" columns={columns} rows={rows || []} rowKey={(r) => `${r.supplier_id ?? "none"}-${r.input_sku_id}`} {...grid}
        rowNoun={["supplier and item", "suppliers and items"]} rowClassName={(r) => (Number(r.versus_average) < -2 ? "dg-tone-warning" : "")}
        empty="Nothing cut in these dates" emptyHint="Batches are linked to the purchase that brought their whole item in." emptyIcon="truck" />
    </SectionCard>
  );
}
