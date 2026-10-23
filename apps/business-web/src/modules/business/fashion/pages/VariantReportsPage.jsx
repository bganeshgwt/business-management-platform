import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import TruncationNotice from "../../../../components/TruncationNotice";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { Segmented } from "./shared";
import { qty } from "./feFormat";
import { MarkdownDialog } from "./fashionParts";

// Variant reports: what sold (less what came back) by size × colour in the
// period, what is on the shelf now and how much sold through. Also by style
// with its size curve and stock age, and the broken size runs (a middle size
// sold out while others are left), each with Reorder and Mark down.
const VIEWS = [
  { value: "style", label: "By style" },
  { value: "broken", label: "Broken sizes" },
  { value: "variant", label: "By variant" },
  { value: "size", label: "By size" },
  { value: "color", label: "By colour" },
];
const BEST_FIRST = { key: "net_sales", direction: "desc" };
const SELL_THROUGH = "Sell-through: pieces sold (less returns) out of pieces sold plus pieces still in stock.";

// The size curve: one small bar per size, its share of the style's sales.
function SizeCurve({ sizes }) {
  return (
    <span className="fe-curve" aria-label={sizes.map((s) => `${s.size} ${s.share ?? 0}%`).join(", ")}>
      {sizes.map((s) => (
        <span key={s.size} className="fe-curve-bar" title={`${s.size}: ${qty(s.net_qty)} sold, ${qty(s.stock_qty)} left (${s.share ?? 0}% of sales)`}>
          <span className={Number(s.stock_qty) <= 0 ? "is-out" : ""} style={{ height: `${Math.max(4, Number(s.share || 0))}%` }} />
          <small>{s.size}</small>
        </span>
      ))}
    </span>
  );
}

export default function VariantReportsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: monthStart(anchor), to: anchor });
  const [view, setView] = useState(query.get("productId") ? "variant" : "style");
  const [productId, setProductId] = useState(query.get("productId") || "");
  const [location, setLocation] = useState("");
  const [data, setData] = useState(null);
  const [styles, setStyles] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [marking, setMarking] = useState(null);
  const { options } = useOptions(["fashion/products"]);
  const products = options?.["fashion/products"] || [];
  const canMark = biz.has("offers") && biz.can("offers.create");
  const canReorder = biz.can("purchasing.create");

  useEffect(() => {
    const controller = new AbortController();
    const params = { ...range, productId: productId || undefined, locationId: location || undefined };
    Promise.all([businessRead(biz.id, "fashion/reports/variants", params, controller.signal), businessRead(biz.id, "fashion/reports/styles", params, controller.signal)])
      .then(([variants, byStyle]) => { setData(variants); setStyles(byStyle); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range, productId, location, version]);

  const ages = useMemo(() => new Map((styles?.ageing || []).map((a) => [Number(a.sku_id), a])), [styles]);
  const actions = (row) => (
    <div className="row-actions">
      {canReorder && <button type="button" className="chip-button" onClick={() => navigate(`${biz.path(`variants/${row.product_id}`)}?receive=1`)}><Icon name="truck" size={14} /> Reorder</button>}
      {canMark && <button type="button" className="chip-button" onClick={() => setMarking({ id: row.product_id, name: row.product_name })}><Icon name="percent" size={14} /> Mark down</button>}
    </div>
  );

  const variantColumns = useMemo(() => [
    { key: "product", header: "Product", value: (r) => r.product_name, filter: "select", mobile: "subtitle" },
    { key: "variant", header: "Variant", value: (r) => `${r.color} / ${r.size}${r.fabric ? ` / ${r.fabric}` : ""}`, mobile: "title", pin: true },
    { key: "size", header: "Size", value: (r) => r.size, filter: "select", defaultHidden: true },
    { key: "color", header: "Colour", value: (r) => r.color, filter: "select", defaultHidden: true },
    { key: "code", header: "SKU code", value: (r) => r.code, className: "mono", defaultHidden: true },
    { key: "net_qty", header: "Sold (net)", type: "number", value: (r) => Number(r.net_qty), total: "sum", mobile: "show" },
    { key: "returned_qty", header: "Came back", type: "number", value: (r) => Number(r.returned_qty), total: "sum" },
    { key: "net_sales", header: "Net sales", type: "money", value: (r) => Number(r.net_sales), total: "sum", mobile: "show" },
    { key: "stock_qty", header: "In stock now", type: "number", value: (r) => Number(r.stock_qty), total: "sum", mobile: "show" },
    { key: "stock_value", header: "Stock value", type: "money", value: (r) => Number(r.stock_value), total: "sum" },
    { key: "sell_through", header: "Sell-through", type: "percent", value: (r) => r.sell_through },
    { key: "oldest", header: "Oldest piece", type: "number", value: (r) => (ages.get(Number(r.sku_id))?.oldest_days ?? null), render: (r) => { const d = ages.get(Number(r.sku_id))?.oldest_days; return d === null || d === undefined ? "—" : `${d} days`; } },
  ], [ages]);
  const groupColumns = useMemo(() => [
    { key: "key", header: view === "size" ? "Size" : "Colour", value: (r) => r.key, mobile: "title", pin: true },
    { key: "variants", header: "Variants", type: "number", value: (r) => r.variants, total: "sum" },
    { key: "net_qty", header: "Sold (net)", type: "number", value: (r) => Number(r.net_qty), total: "sum", mobile: "show" },
    { key: "net_sales", header: "Net sales", type: "money", value: (r) => Number(r.net_sales), total: "sum", mobile: "show" },
    { key: "stock_qty", header: "In stock now", type: "number", value: (r) => Number(r.stock_qty), total: "sum", mobile: "show" },
    { key: "stock_value", header: "Stock value", type: "money", value: (r) => Number(r.stock_value), total: "sum" },
  ], [view]);
  const styleColumns = [
    { key: "product_name", header: "Style", value: (r) => r.product_name, mobile: "title", pin: true,
      render: (r) => <span className="bz-two-line"><strong>{r.product_name}</strong><small className="muted">{[r.brand, r.category].filter(Boolean).join(" · ") || "—"}</small></span> },
    { key: "curve", header: "Size curve (share of sales)", value: (r) => r.sizes.map((s) => `${s.size} ${s.share ?? 0}%`).join(" "), render: (r) => <SizeCurve sizes={r.sizes} />, minWidth: 180 },
    { key: "net_qty", header: "Sold (net)", type: "number", value: (r) => Number(r.net_qty), total: "sum", mobile: "show" },
    { key: "net_sales", header: "Net sales", type: "money", value: (r) => Number(r.net_sales), total: "sum" },
    { key: "stock_qty", header: "In stock", type: "number", value: (r) => Number(r.stock_qty), total: "sum", mobile: "show" },
    { key: "sell_through", header: "Sell-through", type: "percent", value: (r) => r.sell_through, mobile: "show" },
    { key: "d0_30", header: "0–30 days", type: "number", value: (r) => Number(r.ages.d0_30), total: "sum", defaultHidden: true },
    { key: "d31_60", header: "31–60 days", type: "number", value: (r) => Number(r.ages.d31_60), total: "sum" },
    { key: "d61_90", header: "61–90 days", type: "number", value: (r) => Number(r.ages.d61_90), total: "sum" },
    { key: "d91_plus", header: "Over 90 days", type: "number", value: (r) => Number(r.ages.d91_plus), total: "sum" },
    { key: "broken", header: "Broken runs", type: "number", value: (r) => r.broken_colors, total: "sum" },
    (canReorder || canMark) && { key: "actions", header: "", label: "Actions", type: "actions", render: actions },
  ].filter(Boolean);
  const brokenColumns = [
    { key: "product_name", header: "Style", value: (r) => r.product_name, mobile: "title", pin: true },
    { key: "color", header: "Colour", value: (r) => r.color, mobile: "subtitle" },
    { key: "missing", header: "Sold out", value: (r) => r.missing.join(", "), render: (r) => <strong className="bz-minus">{r.missing.join(", ")}</strong>, mobile: "show" },
    { key: "left", header: "Still in stock", value: (r) => r.in_stock.map((s) => `${s.size} ${qty(s.stock)}`).join(" · "), mobile: "show" },
    { key: "stock_qty", header: "Pieces left", type: "number", value: (r) => Number(r.stock_qty), total: "sum" },
    (canReorder || canMark) && { key: "actions", header: "", label: "Actions", type: "actions", render: actions },
  ].filter(Boolean);

  const items = data?.items || [];
  const sold = items.reduce((s, r) => s + Number(r.net_qty), 0);
  const sales = items.reduce((s, r) => s + Math.round(Number(r.net_sales) * 100), 0) / 100;
  const stock = items.reduce((s, r) => s + Number(r.stock_qty), 0);
  const old = (styles?.styles || []).reduce((s, r) => s + Number(r.ages.d91_plus), 0);
  const rows = view === "style" ? styles?.styles : view === "broken" ? styles?.broken : view === "variant" ? items : view === "size" ? data?.bySize : data?.byColor;
  const columns = view === "style" ? styleColumns : view === "broken" ? brokenColumns : view === "variant" ? variantColumns : groupColumns;
  const noun = { style: ["style", "styles"], broken: ["broken run", "broken runs"], variant: ["variant", "variants"], size: ["size", "sizes"], color: ["colour", "colours"] }[view];

  return (
    <div className="stack">
      <BusinessHeader icon="chart" title="Variant reports"
        description="Sales less returns for the dates chosen, by style, size and colour, next to what is on the shelf now and how long it has been there. Net sales are before GST." />
      <div className="stat-grid">
        <StatTile icon="tag" tone="primary" label="Pieces sold (net)" value={qty(sold)} loading={!data && !error} />
        <StatTile icon="money" label="Net sales" money={sales} loading={!data && !error} />
        <StatTile icon="box" label="Pieces in stock now" value={qty(stock)} loading={!data && !error} />
        <StatTile icon="alert" tone={(styles?.broken || []).length ? "warning" : "neutral"} label="Broken size runs" value={(styles?.broken || []).length} note={old > 0 ? `${qty(old)} pieces over 90 days old` : "No stock over 90 days old"} loading={!styles && !error} />
      </div>
      <ErrorMessage message={data ? error : ""} />
      {data && view === "variant" && <TruncationNotice shown={items.length} total={data.truncated ? items.length + 1 : items.length} what="variants" />}
      <SectionCard flush icon="chart" title={VIEWS.find((v) => v.value === view).label}
        description={view === "broken" ? "A middle size sold out while other sizes of the colour are still on the shelf: reorder it, or mark the style down." : ["style", "variant"].includes(view) ? SELL_THROUGH : undefined}
        actions={<Segmented label="Report" options={VIEWS} value={view} onChange={setView} />}>
        <DataGrid key={view} id={`fashion-report-${view}`} caption={`Variant sales ${VIEWS.find((v) => v.value === view).label.toLowerCase()}`}
          columns={columns} rows={rows} rowKey={(r) => (view === "variant" ? r.sku_id : view === "style" ? r.product_id : view === "broken" ? `${r.product_id}-${r.color}` : r.key)}
          loading={!data && !error} error={data ? "" : error} onRetry={() => { setError(""); setVersion((n) => n + 1); }}
          defaultSort={view === "broken" ? undefined : BEST_FIRST} currency={biz.symbol} rowNoun={noun}
          exportName={biz.can("reports.export") ? `${biz.business.code}-variant-${view}` : undefined}
          empty={view === "broken" ? "No broken size runs" : "No variants yet"} emptyHint={view === "broken" ? "Every colour still has its middle sizes." : "Add products with sizes and colours first."} emptyIcon="chart"
          toolbar={(
            <>
              <DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="report dates" onChange={(next) => next.from && next.to && setRange(next)} />
              {products.length > 1 && (
                <label className="field">
                  <span>Product</span>
                  <select value={productId} onChange={(e) => setProductId(e.target.value)}>
                    <option value="">All products</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              )}
              {biz.locations.length > 1 && (
                <label className="field">
                  <span>Location</span>
                  <select value={location} onChange={(e) => setLocation(e.target.value)}>
                    <option value="">All locations</option>
                    {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              )}
            </>
          )} />
      </SectionCard>
      {marking && <MarkdownDialog products={[marking]} onClose={() => setMarking(null)} onSaved={() => setMarking(null)} />}
    </div>
  );
}
