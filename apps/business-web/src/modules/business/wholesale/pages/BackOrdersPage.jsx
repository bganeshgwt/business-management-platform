import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { OrderBadge, Segmented } from "./shared";
import { inPacks } from "./tradeFormat";

// Everything ordered and not yet sent, oldest order first, with what is in
// stock now at the dispatching godown. Lines that can go now are marked and
// open straight into their dispatch; the odd remainder of one line can be
// dropped; "By item" totals what is short to buy.
const VIEWS = [{ value: "lines", label: "By order line" }, { value: "items", label: "By item" }];

export default function BackOrdersPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [route, setRoute] = useState("");
  const [ready, setReady] = useState(false);
  const [view, setView] = useState("lines");
  const [closing, setClosing] = useState(null);
  const { options } = useOptions(["routes?active=true"]);
  const params = { ...(route ? { route } : {}), ...(ready ? { ready: "true" } : {}) };
  const list = useServerList("back-orders", { gridId: "wholesale-back-orders", params });
  const columns = useMemo(() => [
    { key: "order_no", header: "Order", value: (l) => l.order_no, mobile: "subtitle", pin: true,
      render: (l) => <button type="button" className="link-button mono" onClick={() => navigate(biz.path(`sales-orders?order=${l.order_id}`))}>{l.order_no}</button> },
    { key: "created_at", header: "Ordered", type: "date", value: (l) => l.created_at },
    { key: "contact_name", header: "Customer", value: (l) => l.contact_name, mobile: "show" },
    { key: "label", header: "Item", value: (l) => l.label, mobile: "title" },
    { key: "remaining", header: "Still to send", type: "number", value: (l) => Number(l.remaining), render: (l) => inPacks(l.remaining, l.unit, l.entered_unit || l.pack_unit, l.unit_factor || l.pack_factor), mobile: "show" },
    { key: "available", header: "In stock there", type: "number", value: (l) => Number(l.available), render: (l) => inPacks(l.available, l.unit, l.entered_unit || l.pack_unit, l.unit_factor || l.pack_factor), mobile: "show" },
    { key: "go", header: "Can go now", type: "status", value: (l) => (l.can_go_now ? "Yes" : Number(l.available) > 0 ? "Part" : "No"), mobile: "show",
      render: (l) => (l.can_go_now ? <Badge tone="success" label="Can go now" /> : Number(l.available) > 0 ? <Badge tone="warning" label="Part" /> : <Badge tone="danger" label="No stock" />) },
    { key: "value", header: "Value", type: "money", exact: true, value: (l) => Number(l.remaining_value), total: "sum" },
    { key: "route", header: "Route", value: (l) => l.route_name || "", defaultHidden: true },
    { key: "salesperson", header: "Salesperson", value: (l) => l.salesperson_name || "", defaultHidden: true },
    { key: "expected_on", header: "Wanted by", type: "date", value: (l) => l.expected_on, defaultHidden: true },
    { key: "status", header: "Order", type: "status", value: (l) => l.status, render: (l) => <OrderBadge status={l.status} />, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => (
      <div className="row-actions">
        {biz.can("sales_orders.approve") && Number(l.available) > 0 && <button type="button" className="chip-button" onClick={() => navigate(biz.path(`sales-orders?order=${l.order_id}&dispatch=1`))}>Dispatch</button>}
        {biz.can("sales_orders.cancel") && !l.free_of_line_id && <button type="button" className="chip-button" onClick={() => setClosing(l)}>Drop rest</button>}
      </div>
    ) },
  ], [biz, navigate]);
  return (
    <div className="stack">
      <BusinessHeader icon="layers" title="Back-orders"
        description="What customers ordered that has not gone out yet. 'Can go now' lines are covered by the stock in the godown; open one to dispatch it, or drop what will not be sent."
        secondary={biz.can("sales_orders.view") && <Link className="button button-secondary" to={biz.path("dispatch")}>Dispatch board</Link>} />
      <Segmented label="Show" value={view} options={VIEWS} onChange={setView} />
      {view === "items" ? <ShortItems route={route} routes={options?.["routes?active=true"] || []} onRoute={setRoute} /> : (
        <>
          <ErrorMessage message={list.error} />
          <SectionCard flush icon="list" title="Still to send">
            <DataGrid {...list.gridProps} caption="Back-orders" columns={columns} currency={biz.symbol} rowNoun={["line", "lines"]}
              toolbar={(
                <>
                  <label className="field">
                    <span>Route</span>
                    <select value={route} onChange={(e) => setRoute(e.target.value)}>
                      <option value="">All routes</option>
                      {(options?.["routes?active=true"] || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </label>
                  <label className="checkbox bz-check"><input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} /> Only what can go now</label>
                </>
              )}
              exportName={biz.can("sales_orders.export") ? `${biz.business.code}-back-orders` : undefined}
              rowClassName={(l) => (l.can_go_now ? "" : Number(l.available) > 0 ? "dg-tone-warning" : "dg-tone-danger")}
              empty="Nothing waiting to be sent" emptyHint="Every order has gone out or been closed." emptyIcon="check" />
          </SectionCard>
        </>
      )}
      {closing && (
        <ReasonDialog title={`Drop the rest of ${closing.label}`} submitLabel="Drop it"
          description={`${closing.order_no} · ${closing.contact_name}: ${inPacks(closing.remaining, closing.unit, closing.entered_unit, closing.unit_factor)} will not be sent.`}
          onClose={() => setClosing(null)} onSubmit={(reason) => businessWrite(biz.id, `sales-orders/${closing.order_id}/lines/${closing.id}/close`, { reason })}
          onSaved={() => { setClosing(null); toast.success("Dropped from the back-order"); list.reload(); }} />
      )}
    </div>
  );
}

// Per item across every waiting order: what is wanted, what is in stock and
// what is short — the list to buy from the company.
function ShortItems({ route, routes, onRoute }) {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const all = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const page = await businessRead(biz.id, "back-orders", { limit: 100, offset, ...(route ? { route } : {}) }, controller.signal);
        all.push(...page.items);
        if (all.length >= page.total || !page.items.length) break;
      }
      const map = new Map();
      for (const l of all) {
        const key = `${l.sku_id}-${l.location_id}`;
        const row = map.get(key) || { key, sku_id: l.sku_id, label: l.label.replace(/ \(free\)$/, ""), code: l.sku_code, unit: l.unit, pack_unit: l.pack_unit, pack_factor: l.pack_factor, wanted: 0, available: Number(l.available), orders: new Set(), value: 0 };
        row.wanted += Number(l.remaining); row.orders.add(l.order_no); row.value += Number(l.remaining_value);
        map.set(key, row);
      }
      setRows([...map.values()].map((r) => ({ ...r, short: Math.max(0, r.wanted - r.available), orders: r.orders.size })).sort((a, b) => b.short - a.short || a.label.localeCompare(b.label)));
      setError("");
    })().catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, route]);
  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title" },
    { key: "code", header: "Code", value: (r) => r.code, mobile: "subtitle" },
    { key: "wanted", header: "Wanted", type: "number", value: (r) => r.wanted, render: (r) => inPacks(r.wanted, r.unit, r.pack_unit, r.pack_factor), mobile: "show" },
    { key: "available", header: "In stock", type: "number", value: (r) => r.available, render: (r) => quantity(r.available, r.unit) },
    { key: "short", header: "Short", type: "number", value: (r) => r.short, render: (r) => (r.short ? <span className="bz-due">{inPacks(r.short, r.unit, r.pack_unit, r.pack_factor)}</span> : <Badge tone="success" label="Covered" />), mobile: "show" },
    { key: "orders", header: "Orders", type: "number", value: (r) => r.orders },
    { key: "value", header: "Value", type: "money", exact: true, value: (r) => r.value, total: "sum" },
  ], []);
  return (
    <>
      <ErrorMessage message={error} />
      <SectionCard flush icon="layers" title="By item" description="Short = wanted less what is in stock. Order the short items from the company (Purchases)."
        actions={biz.can("purchasing.create") && <Link className="button button-secondary button-sm" to={biz.path("purchases?new=1")}>Receive a purchase</Link>}>
        <DataGrid id="wholesale-back-order-items" caption="Back-orders by item" rows={rows || []} loading={!rows && !error} columns={columns} currency={biz.symbol} rowKey={(r) => r.key}
          rowNoun={["item", "items"]} rowClassName={(r) => (r.short ? "dg-tone-warning" : "")}
          toolbar={(
            <label className="field">
              <span>Route</span>
              <select value={route} onChange={(e) => onRoute(e.target.value)}>
                <option value="">All routes</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
          exportName={biz.can("sales_orders.export") ? `${biz.business.code}-back-orders-by-item` : undefined}
          empty="Nothing waiting to be sent" emptyIcon="check" />
      </SectionCard>
    </>
  );
}
