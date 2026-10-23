import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { REASONS, kg, processWords, weightOf } from "./weight";

// Everything sold by weight, per location. Today: what the
// day opened with, what came in, was cut, sold and wasted since, and what
// should be on the counter now — then "Close the day": weigh what is left and
// post the difference (drip loss written off, a surplus put back). The 7-day
// view keeps the week's figures, value at cost and margin.
const VIEWS = [{ value: "today", label: "Today" }, { value: "week", label: "Last 7 days" }];

export default function WeightStockPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const words = processWords(biz.type);
  const [view, setView] = useState("today");
  const [location, setLocation] = useState("");
  const [closing, setClosing] = useState(false);
  const [today, setToday] = useState(null);
  const [todayError, setTodayError] = useState("");
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    if (view !== "today") return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "weight/stock-today", { location: location || undefined }, controller.signal)
      .then((r) => { setToday(r.rows); setTodayError(""); })
      .catch((err) => { if (!controller.signal.aborted) setTodayError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, location, view, version]);
  const actions = (r) => [
    biz.has("processing") && biz.can("processing.create") && Number(r.on_hand) > 0 && { label: words.action, icon: "scale", onClick: () => navigate(`${businessPath(biz.id, "processing")}?new=${r.sku_id}`) },
    biz.has("wastage") && biz.can("wastage.create") && Number(r.on_hand) > 0 && { label: "Record wastage", icon: "trash", onClick: () => navigate(`${businessPath(biz.id, "wastage")}?new=${r.sku_id}`) },
    biz.can("catalog.edit") && { label: "Change the rate", icon: "tag", onClick: () => navigate(businessPath(biz.id, "rates")) },
    { label: "Stock movements", icon: "list", onClick: () => navigate(`${businessPath(biz.id, "movements")}?q=${encodeURIComponent(r.label)}`) },
  ].filter(Boolean);
  const actionColumn = { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <ActionMenu label={`Actions for ${r.label}`} items={actions(r)} /> };
  const unitWeight = (value, r) => weightOf(value, r.unit);
  const todayColumns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", pin: true },
    { key: "location_name", header: "Location", value: (r) => r.location_name, mobile: "subtitle", defaultHidden: biz.locations.length < 2 },
    { key: "opening", header: "Opened with", type: "number", value: (r) => Number(r.opening), render: (r) => unitWeight(r.opening, r) },
    { key: "received", header: "Received", type: "number", value: (r) => Number(r.received), render: (r) => (Number(r.received) ? unitWeight(r.received, r) : "—") },
    { key: "cut_in", header: biz.type === "weight_retail" ? "Repacked in" : "Cut in", type: "number", value: (r) => Number(r.cut_in), render: (r) => (Number(r.cut_in) ? unitWeight(r.cut_in, r) : "—"), defaultHidden: !biz.has("processing") },
    { key: "cut_out", header: biz.type === "weight_retail" ? "Sorted out" : "Cut out", type: "number", value: (r) => Number(r.cut_out), render: (r) => (Number(r.cut_out) ? unitWeight(r.cut_out, r) : "—"), defaultHidden: !biz.has("processing") },
    { key: "sold", header: "Sold", type: "number", mobile: "show", value: (r) => Number(r.sold), render: (r) => (Number(r.sold) ? unitWeight(r.sold, r) : "—") },
    { key: "wasted", header: "Wasted", type: "number", mobile: "show", value: (r) => Number(r.wasted), render: (r) => (Number(r.wasted) ? unitWeight(r.wasted, r) : "—") },
    { key: "on_hand", header: "Should be here", type: "number", value: (r) => Number(r.on_hand), mobile: "show", render: (r) => <strong>{unitWeight(r.on_hand, r)}</strong> },
    { key: "day", header: "Today", value: (r) => `${r.sold}`, mobile: "show", defaultHidden: true,
      render: (r) => `sold ${unitWeight(r.sold, r)} · cut ${unitWeight(Number(r.cut_in), r)} · wasted ${unitWeight(r.wasted, r)}` },
    { key: "next_expiry", header: "Use by", type: "date", value: (r) => r.next_expiry, render: (r) => (r.next_expiry ? dateShort(r.next_expiry) : "—"), defaultHidden: true },
    { key: "value", header: "Value at cost", type: "money", exact: true, value: (r) => Number(r.value), total: "sum", defaultHidden: true },
    { key: "low", header: "Status", type: "status", value: (r) => (r.low ? "low" : Number(r.use_soon) > 0 ? "use_soon" : "ok"),
      render: (r) => (r.low ? <Badge tone="warning" label="Low" /> : Number(r.use_soon) > 0 ? <Badge tone="warning" label={`Use ${unitWeight(r.use_soon, r)} by tomorrow`} />
        : Number(r.on_hand) > 0 ? <Badge tone="active" label="In stock" /> : <Badge tone="inactive" label="None" />) },
    actionColumn,
  ], [biz]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = today || [];
  const totalKg = rows.reduce((s, r) => s + Number(r.on_hand) * Number(r.kg_factor || 1), 0);
  const soldKg = rows.reduce((s, r) => s + Number(r.sold) * Number(r.kg_factor || 1), 0);
  const wastedKg = rows.reduce((s, r) => s + Number(r.wasted) * Number(r.kg_factor || 1), 0);
  return (
    <div className="stack">
      <BusinessHeader icon="scale" title="Stock by weight"
        description="Loose goods in kg or g. Today shows what the day opened with and what moved since; close the day by weighing what is left."
        primary={biz.can("inventory.edit") && <button type="button" className="button" onClick={() => setClosing(true)}><Icon name="scale" size={16} /> Close the day</button>} />
      <div className="sw-tiles">
        <StatTile icon="scale" tone="primary" label="Should be here now" value={today ? kg(totalKg) : undefined} loading={view === "today" && !today && !todayError} />
        <StatTile icon="receipt" tone="success" label="Sold today" value={today ? kg(soldKg) : undefined} loading={view === "today" && !today && !todayError} />
        <StatTile icon="trash" tone="warning" label="Wasted today" value={today ? kg(wastedKg) : undefined} loading={view === "today" && !today && !todayError} />
        <StatTile icon="rupee" label="Value at cost" money={today ? rows.reduce((s, r) => s + Number(r.value || 0), 0) : undefined} loading={view === "today" && !today && !todayError} />
      </div>
      <SectionCard flush icon="box" title={view === "today" ? "Weighed items today" : "Weighed items, last 7 days"}
        actions={(
          <div className="sw-toolbar">
            <Segmented label="Show" value={view} options={VIEWS} onChange={setView} />
            {biz.locations.length > 1 && (
              <label className="field"><span>Location</span>
                <select value={location} onChange={(e) => setLocation(e.target.value)}>
                  <option value="">Every location</option>
                  {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
            )}
          </div>
        )}>
        {view === "today" ? (
          <DataGrid id="weight-stock-today" caption="Stock by weight today" columns={todayColumns} rows={rows} rowKey={(r) => r.id} loading={!today && !todayError}
            error={today ? "" : todayError} onRetry={reload} currency={biz.symbol} rowNoun={["item", "items"]}
            exportName={biz.can("inventory.export") ? `${biz.business.code}-stock-today` : undefined}
            rowClassName={(r) => (r.low ? "dg-tone-warning" : Number(r.on_hand) <= 0 ? "dg-tone-muted" : "")}
            empty="No items sold by weight" emptyHint="Items stocked in kg or g appear here." emptyIcon="scale" />
        ) : <WeekGrid location={location} actionColumn={actionColumn} />}
      </SectionCard>
      <Closes />
      {closing && <CloseDayDialog rows={rows} location={location} onClose={() => setClosing(false)}
        onSaved={(c) => { setClosing(false); toast.success(`Day closed: ${Number(c.short_kg) ? `${kg(c.short_kg)} short (${biz.exact(c.short_value)} written off)` : "nothing short"}${Number(c.over_kg) ? `, ${kg(c.over_kg)} over` : ""}.`); reload(); }} />}
    </div>
  );
}

function WeekGrid({ location, actionColumn }) {
  const biz = useOpenBusiness();
  const list = useServerList("weight/stock", { gridId: "weight-stock", params: location ? { location } : {} });
  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", pin: true },
    { key: "category", header: "Category", value: (r) => r.category || "", filter: "select", defaultHidden: true },
    { key: "location_name", header: "Location", value: (r) => r.location_name, mobile: "subtitle", defaultHidden: biz.locations.length < 2 },
    { key: "on_hand", header: "On hand", type: "number", value: (r) => Number(r.on_hand_kg), total: "sum", mobile: "show", render: (r) => weightOf(r.on_hand, r.unit) },
    { key: "average_cost", header: "Cost / kg", type: "money", exact: true, value: (r) => (r.average_cost === null ? null : Number(r.average_cost)) },
    { key: "price", header: "Rate", type: "money", exact: true, value: (r) => Number(r.price), render: (r) => `${biz.exact(r.price)} / ${r.unit}` },
    { key: "margin", header: "Margin", type: "percent", defaultHidden: true, value: (r) => (r.average_cost === null || !Number(r.price) ? null : (100 * (Number(r.price) - Number(r.average_cost))) / Number(r.price)) },
    { key: "value", header: "Value at cost", type: "money", exact: true, value: (r) => Number(r.value), total: "sum", defaultHidden: true },
    { key: "sold_7d", header: "Sold", type: "number", value: (r) => Number(r.sold_7d), render: (r) => weightOf(r.sold_7d, r.unit), mobile: "show" },
    { key: "cut_7d", header: biz.type === "weight_retail" ? "Made by repacking" : "Made by cutting", type: "number", value: (r) => Number(r.cut_7d), render: (r) => weightOf(r.cut_7d, r.unit), defaultHidden: !biz.has("processing") },
    { key: "cut_used_7d", header: biz.type === "weight_retail" ? "Used for sorting" : "Used for cutting", type: "number", value: (r) => Number(r.cut_used_7d), render: (r) => weightOf(r.cut_used_7d, r.unit), defaultHidden: !biz.has("processing") },
    { key: "wasted_7d", header: "Wasted", type: "number", value: (r) => Number(r.wasted_7d), render: (r) => weightOf(r.wasted_7d, r.unit) },
    { key: "next_expiry", header: "Use by", type: "date", value: (r) => r.next_expiry, render: (r) => (r.next_expiry ? dateShort(r.next_expiry) : "—") },
    actionColumn,
  ], [biz, actionColumn]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <DataGrid {...list.gridProps} caption="Stock by weight, last 7 days" columns={columns} currency={biz.symbol} rowNoun={["item", "items"]}
        rowKey={(r) => r.id} exportName={biz.can("inventory.export") ? `${biz.business.code}-stock-by-weight` : undefined}
        rowClassName={(r) => (r.low ? "dg-tone-warning" : Number(r.on_hand) <= 0 ? "dg-tone-muted" : "")}
        empty="No items sold by weight" emptyHint="Items stocked in kg or g appear here." emptyIcon="scale" />
    </>
  );
}

// The weigh-ups already done.
function Closes() {
  const biz = useOpenBusiness();
  const list = useServerList("weight/day-closes", { gridId: "weight-day-closes", period: true });
  if (!list.data?.items?.length) return null;
  const columns = [
    { key: "created_at", header: "Closed", type: "datetime", value: (c) => c.created_at, mobile: "title", render: (c) => dateTime(c.created_at) },
    { key: "location_name", header: "Location", value: (c) => c.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "items", header: "Items weighed", type: "number", value: (c) => c.lines.length },
    { key: "short_kg", header: "Short", type: "number", value: (c) => Number(c.short_kg), render: (c) => kg(c.short_kg), mobile: "show" },
    { key: "short_value", header: "Written off", type: "money", exact: true, value: (c) => Number(c.short_value), total: "sum", mobile: "show" },
    { key: "over_kg", header: "Over", type: "number", value: (c) => Number(c.over_kg), render: (c) => kg(c.over_kg) },
    { key: "created_by_name", header: "By", value: (c) => c.created_by_name },
  ];
  return (
    <SectionCard flush icon="history" title="End-of-day weigh-ups">
      <DataGrid {...list.gridProps} caption="End-of-day weigh-ups" columns={columns} currency={biz.symbol} rowNoun={["close", "closes"]} empty="No weigh-ups yet" emptyIcon="scale" />
    </SectionCard>
  );
}

// Weigh what is left: each item's weight on the scale against what the books
// expect. Short is written off (drip loss unless another reason is chosen);
// over is put back. Items left empty are not touched.
function CloseDayDialog({ rows, location, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(location || String(locations[0]?.id || ""));
  const [requestKey] = useState(newKey);
  const [counts, setCounts] = useState({});
  const items = rows.filter((r) => String(r.location_id) === String(locationId) && (Number(r.on_hand) > 0 || Number(r.opening) > 0));
  const diffOf = (r) => (counts[r.sku_id]?.counted === undefined || counts[r.sku_id]?.counted === "" ? null : Number(counts[r.sku_id].counted) - Number(r.on_hand));
  const set = (skuId, name, value) => setCounts((all) => ({ ...all, [skuId]: { ...all[skuId], [name]: value } }));
  const shortValue = items.reduce((s, r) => { const d = diffOf(r); return s + (d !== null && d < 0 ? -d * Number(r.average_cost || 0) : 0); }, 0);
  const columns = [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title" },
    { key: "on_hand", header: "Should be", type: "number", value: (r) => Number(r.on_hand), render: (r) => weightOf(r.on_hand, r.unit) },
    { key: "counted", header: "Weighed now", type: "number", width: 140, value: (r) => Number(counts[r.sku_id]?.counted || 0),
      render: (r, ctx) => <input aria-label={ctx.label} type="number" min="0" step="0.001" inputMode="decimal" placeholder={r.unit} value={counts[r.sku_id]?.counted ?? ""} onChange={(e) => set(r.sku_id, "counted", e.target.value)} /> },
    { key: "diff", header: "Difference", type: "number", value: (r) => diffOf(r) ?? 0,
      render: (r) => { const d = diffOf(r); return d === null ? <span className="muted">—</span> : <span className={d < 0 ? "sw-yield-low" : d > 0 ? "sw-yield-good" : ""}>{d > 0 ? "+" : ""}{weightOf(d, r.unit)}{d < 0 && r.average_cost ? <small style={{ display: "block" }}>{biz.exact(-d * Number(r.average_cost))}</small> : null}</span>; } },
    { key: "reason", header: "If short", width: 170, value: (r) => counts[r.sku_id]?.reason || "drip_loss",
      render: (r, ctx) => (diffOf(r) !== null && diffOf(r) < 0 ? (
        <select aria-label={ctx.label} value={counts[r.sku_id]?.reason || "drip_loss"} onChange={(e) => set(r.sku_id, "reason", e.target.value)}>
          {REASONS.filter((x) => x.value !== "other").map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      ) : <span className="muted">—</span>) },
  ];
  return (
    <FormDialog title="Close the day: weigh what is left" icon="scale" width={820} submitLabel="Post the weigh-up" onClose={onClose} onSaved={onSaved}
      description="Weigh each item still on the counter and in the chiller. Leave an item empty to skip it."
      onSubmit={() => businessWrite(biz.id, "weight/day-close", { locationId, requestKey,
        lines: items.filter((r) => diffOf(r) !== null).map((r) => ({ skuId: r.sku_id, counted: counts[r.sku_id].counted, ...(diffOf(r) < 0 ? { reason: counts[r.sku_id]?.reason || "drip_loss" } : {}) })) })}>
      {locations.length > 1 && (
        <Field label="Location">
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </Field>
      )}
      <div className="field-wide">
        <DataGrid variant="editor" caption="Weigh what is left" columns={columns} rows={items} rowKey={(r) => r.id} currency={biz.symbol} rowNoun={["item", "items"]} />
      </div>
      <p className="sw-note field-wide">{shortValue > 0 ? `About ${biz.exact(shortValue)} at cost will be written off.` : "Nothing short so far."}</p>
    </FormDialog>
  );
}
