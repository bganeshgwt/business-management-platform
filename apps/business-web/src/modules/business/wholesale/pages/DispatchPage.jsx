import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { OrderBadge, Segmented } from "./shared";
import { DAYS } from "./tradeFormat";
import { ChallanDialog, DeliveryDialog, TransportDialog, TransportFields } from "./deliveryParts";
import { DELIVERY, emptyTransport, printInvoicesOf, printLoadSheet, printPickList, transportBody } from "./deliveryFormat";

// Dispatch (pro pass D-04, D-10): the orders waiting to go, by route, beat
// day or wanted-by date; tick them, print one pick list, send them together
// on one van (each order gets its own tax invoice; what is not in stock
// stays a back-order), print the load sheet and every invoice at once; then
// mark each delivery as delivered, part returned or refused.
const TABS = [{ value: "board", label: "To dispatch" }, { value: "out", label: "On the way" }, { value: "runs", label: "Delivery runs" }];

export default function DispatchPage() {
  const [tab, setTab] = useState("board");
  return (
    <div className="stack">
      <BusinessHeader icon="truck" title="Dispatch"
        description="Pick the orders for a van, print the pick list, send them in one go and print the load sheet with every invoice. Mark each delivery when the van is back." />
      <Segmented label="Show" value={tab} options={TABS} onChange={setTab} />
      {tab === "board" && <Board onSent={() => setTab("runs")} />}
      {tab === "out" && <OnTheWay />}
      {tab === "runs" && <Runs />}
    </div>
  );
}

function Board({ onSent }) {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { options } = useOptions(["routes?active=true"]);
  const [filters, setFilters] = useState({ route: "", day: "", wantedBy: "" });
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [sending, setSending] = useState(false);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "dispatch-board", Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), controller.signal)
      .then((r) => { setRows(r); setError(""); setPicked((p) => new Set([...p].filter((x) => r.some((o) => o.id === x)))); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, filters, version]);
  const set = (name) => (e) => setFilters((f) => ({ ...f, [name]: e.target.value }));
  const toggle = (id) => setPicked((p) => { const next = new Set(p); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const chosen = (rows || []).filter((o) => picked.has(o.id));
  const value = chosen.reduce((s, o) => s + Number(o.pending_value), 0);
  const printPick = async () => {
    setBusy(true);
    try { printPickList(await businessRead(biz.id, "pick-list", { orders: [...picked].join(",") }), biz); } catch (err) { toast.error(getErrorMessage(err)); } finally { setBusy(false); }
  };
  const columns = useMemo(() => [
    { key: "pick", header: "", label: "Choose", render: (o) => <input type="checkbox" aria-label={`Choose ${o.order_no}`} checked={picked.has(o.id)} onChange={() => toggle(o.id)} /> },
    { key: "order_no", header: "Order", value: (o) => o.order_no, mobile: "title",
      render: (o) => <button type="button" className="link-button mono" onClick={() => navigate(biz.path(`sales-orders?order=${o.id}`))}>{o.order_no}</button> },
    { key: "contact", header: "Customer", value: (o) => o.contact_name, mobile: "subtitle" },
    { key: "route", header: "Route · beat", value: (o) => [o.route_name, o.beat_name].filter(Boolean).join(" · "), render: (o) => (o.route_name ? `${o.route_name}${o.beat_name ? ` · ${o.beat_name}` : ""}` : <span className="muted">No route</span>) },
    { key: "wanted", header: "Wanted by", type: "date", value: (o) => o.expected_on },
    { key: "value", header: "To send", type: "money", exact: true, value: (o) => Number(o.pending_value), total: "sum", mobile: "show" },
    { key: "stock", header: "Stock", type: "status", value: (o) => (o.lines_ready === o.lines ? "All in stock" : o.lines_none === o.lines ? "None" : "Part"), mobile: "show",
      render: (o) => (o.lines_ready === o.lines ? <Badge tone="success" label="All in stock" /> : o.lines_none === o.lines ? <Badge tone="danger" label="Nothing in stock" /> : <Badge tone="warning" label={`${o.lines_ready} of ${o.lines} lines`} />) },
    { key: "status", header: "Order", type: "status", value: (o) => o.status, render: (o) => <OrderBadge status={o.status} />, defaultHidden: true },
    { key: "salesperson", header: "Salesperson", value: (o) => o.salesperson_name || "", defaultHidden: true },
  ], [biz, navigate, picked]);
  return (
    <>
      <ErrorMessage message={error} />
      <SectionCard flush icon="clipboard" title="Orders waiting to go">
        <DataGrid id="wholesale-dispatch-board" caption="Orders to dispatch" rows={rows || []} loading={!rows && !error} columns={columns} currency={biz.symbol} rowKey={(o) => o.id}
          rowNoun={["order", "orders"]} rowClassName={(o) => (picked.has(o.id) ? "dg-tone-info" : o.lines_none === o.lines ? "dg-tone-muted" : "")}
          toolbar={(
            <>
              <label className="field"><span>Route</span>
                <select value={filters.route} onChange={set("route")}><option value="">All routes</option>{(options?.["routes?active=true"] || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              </label>
              <label className="field"><span>Beat day</span>
                <select value={filters.day} onChange={set("day")}><option value="">Any day</option>{DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
              </label>
              <label className="field"><span>Wanted by</span><input type="date" value={filters.wantedBy} onChange={set("wantedBy")} /></label>
              <button type="button" className="button button-secondary button-sm" disabled={!rows?.length} onClick={() => setPicked(new Set((rows || []).filter((o) => o.lines_ready > 0).map((o) => o.id)))}>Choose all that can go</button>
            </>
          )}
          empty="Nothing waiting to be sent" emptyHint="Orders appear here until they are dispatched or closed." emptyIcon="check" />
      </SectionCard>
      {chosen.length > 0 && (
        <div className="bz-selected-bar" role="region" aria-label="Chosen orders">
          <span><strong>{chosen.length} orders</strong> · {biz.exact(value)} to send</span>
          <div className="row-actions">
            <button type="button" className="button button-secondary" disabled={busy} onClick={printPick}><Icon name="print" size={15} /> Pick list</button>
            {biz.can("sales_orders.approve") && <button type="button" className="button" onClick={() => setSending(true)}><Icon name="truck" size={16} /> Send on one van</button>}
            <button type="button" className="link-button" onClick={() => setPicked(new Set())}>Clear</button>
          </div>
        </div>
      )}
      {sending && <RunDialog orders={chosen} onClose={() => setSending(false)}
        onSaved={(run) => {
          setSending(false); setPicked(new Set()); setVersion((n) => n + 1);
          toast.success(`${run.sent.length} invoices raised on load sheet ${run.id}${run.skipped.length ? ` · ${run.skipped.length} left: ${run.skipped.map((s) => `${s.orderNo} (${s.reason})`).join(", ")}` : ""}`, {
            duration: 12000, action: { label: "Print load sheet", onClick: () => printLoadSheet(run, biz) } });
          onSent();
        }} />}
    </>
  );
}

function RunDialog({ orders, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const { options } = useOptions(["routes?active=true"]);
  const routes = [...new Set(orders.map((o) => o.route_id).filter(Boolean))];
  const [form, setForm] = useState(() => ({ ...emptyTransport(), driverPhone: "", routeId: routes.length === 1 ? String(routes[0]) : "", notes: "" }));
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  return (
    <FormDialog title={`Send ${orders.length} orders on one van`} icon="truck" width={820} submitLabel="Dispatch and invoice all" onClose={onClose} onSaved={onSaved}
      description="Each order sends what is in stock now (whole cases for lines ordered in cases) on its own tax invoice; the rest stays a back-order. An order with nothing in stock, or over its credit limit, is left out and named."
      onSubmit={() => businessWrite(biz.id, "delivery-runs", { requestKey, orderIds: orders.map((o) => o.id), ...transportBody({ ...form, ewayBillNo: "", ewayBillDate: "", distanceKm: "" }) })}>
      <p className="field-wide muted small">{orders.map((o) => `${o.order_no} ${o.contact_name}`).join(" · ")}</p>
      <TransportFields form={form} set={set} eway={false} />
      <Field label="Driver's phone (optional)"><input maxLength={30} value={form.driverPhone} onChange={set("driverPhone")} /></Field>
      <Field label="Route">
        <select value={form.routeId} onChange={set("routeId")}><option value="">Mixed / none</option>{(options?.["routes?active=true"] || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      </Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function OnTheWay() {
  const biz = useOpenBusiness();
  const [show, setShow] = useState("out_for_delivery");
  const list = useServerList("dispatches", { gridId: "wholesale-dispatches", period: show !== "out_for_delivery", params: show ? { delivery: show } : {} });
  const [acting, setActing] = useState(null);
  const columns = useMemo(() => [
    { key: "document_no", header: "Invoice", value: (d) => d.document_no, mobile: "title", render: (d) => <span className="mono">{d.document_no}</span> },
    { key: "contact", header: "Customer", value: (d) => d.contact_name, mobile: "subtitle" },
    { key: "sent", header: "Sent", type: "datetime", value: (d) => d.created_at },
    { key: "vehicle", header: "Vehicle · driver", value: (d) => [d.vehicle_no, d.driver_name].filter(Boolean).join(" · ") },
    { key: "route", header: "Route", value: (d) => d.route_name || "", defaultHidden: true },
    { key: "total", header: "Invoice", type: "money", exact: true, value: (d) => Number(d.total), total: "sum" },
    { key: "collect", header: "To collect", type: "money", exact: true, value: (d) => Math.max(0, Number(d.to_collect)), total: "sum", mobile: "show" },
    { key: "challan", header: "Challan", value: (d) => d.challan_no || "", render: (d) => <span className="mono">{d.challan_no || "—"}</span>, defaultHidden: true },
    { key: "lr", header: "LR no.", value: (d) => d.lr_no || "", defaultHidden: true },
    { key: "eway", header: "E-way bill", value: (d) => d.eway_bill_no || "", defaultHidden: true },
    { key: "status", header: "Delivery", type: "status", value: (d) => d.delivery_status, mobile: "show", render: (d) => <Badge tone={DELIVERY[d.delivery_status]?.tone} label={DELIVERY[d.delivery_status]?.label} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (d) => (
      <div className="row-actions">
        {biz.can("sales_orders.approve") && d.delivery_status === "out_for_delivery" && <button type="button" className="chip-button" onClick={() => setActing({ kind: "delivered", d })}>Delivered</button>}
        {biz.can("sales_orders.approve") && biz.can("sales.refund") && d.delivery_status === "out_for_delivery" && <button type="button" className="chip-button" onClick={() => setActing({ kind: "part_returned", d })}>Came back</button>}
        {biz.can("sales_orders.approve") && <button type="button" className="chip-button" onClick={() => setActing({ kind: "transport", d })}>E-way bill</button>}
        <button type="button" className="chip-button" onClick={() => setActing({ kind: "challan", d })}><Icon name="print" size={13} /> Challan</button>
        {biz.can("sales.print") && <button type="button" className="chip-button" onClick={() => printInvoicesOf(biz, [d.document_id])}>Invoice</button>}
      </div>
    ) },
  ], [biz]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="truck" title="Deliveries">
        <DataGrid {...list.gridProps} caption="Deliveries" columns={columns} currency={biz.symbol} rowNoun={["invoice", "invoices"]}
          toolbar={(
            <>
              <Segmented label="Show" value={show} options={[{ value: "out_for_delivery", label: "On the way" }, { value: "delivered", label: "Delivered" }, { value: "part_returned", label: "Part returned" }, { value: "refused", label: "Refused" }, { value: "", label: "All" }]} onChange={setShow} />
              {show !== "out_for_delivery" && <PeriodFilter list={list} />}
            </>
          )}
          empty={show === "out_for_delivery" ? "Nothing on the way" : "Nothing here"} emptyIcon="truck" />
      </SectionCard>
      {acting?.kind === "transport" && <TransportDialog dispatch={acting.d} onClose={() => setActing(null)} onSaved={() => { setActing(null); list.reload(); }} />}
      {acting?.kind === "challan" && <ChallanDialog dispatch={acting.d} onClose={() => setActing(null)} onSaved={() => { setActing(null); list.reload(); }} />}
      {(acting?.kind === "delivered" || acting?.kind === "part_returned") && <DeliveryDialog dispatch={acting.d} initial={acting.kind} onClose={() => setActing(null)} onSaved={() => { setActing(null); list.reload(); }} />}
    </>
  );
}

function Runs() {
  const biz = useOpenBusiness();
  const list = useServerList("delivery-runs", { gridId: "wholesale-delivery-runs", period: true });
  const [loading, setLoading] = useState(null);
  const open = async (run, what) => {
    setLoading(run.id);
    try {
      const detail = await businessRead(biz.id, `delivery-runs/${run.id}`);
      if (what === "sheet") printLoadSheet(detail, biz);
      else await printInvoicesOf(biz, detail.invoices.map((d) => d.document_id));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(null);
    }
  };
  const columns = [
    { key: "id", header: "Load sheet", value: (r) => r.id, mobile: "title", render: (r) => `No. ${r.id}` },
    { key: "created_at", header: "Sent", type: "datetime", value: (r) => r.created_at, mobile: "subtitle" },
    { key: "vehicle", header: "Vehicle", value: (r) => r.vehicle_no || "" },
    { key: "driver", header: "Driver", value: (r) => r.driver_name || "" },
    { key: "route", header: "Route", value: (r) => r.route_name || "" },
    { key: "invoices", header: "Invoices", type: "number", value: (r) => r.invoices, total: "sum", mobile: "show" },
    { key: "value", header: "Value", type: "money", exact: true, value: (r) => Number(r.value), total: "sum", mobile: "show" },
    { key: "out", header: "Still out", type: "number", value: (r) => r.out_for_delivery, render: (r) => (r.out_for_delivery ? <Badge tone="info" label={`${r.out_for_delivery} on the way`} /> : <Badge tone="success" label="All marked" />) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <div className="row-actions">
        <button type="button" className="chip-button" disabled={loading === r.id} onClick={() => open(r, "sheet")}><Icon name="print" size={13} /> Load sheet</button>
        {biz.can("sales.print") && <button type="button" className="chip-button" disabled={loading === r.id} onClick={() => open(r, "invoices")}>All invoices</button>}
      </div>
    ) },
  ];
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="layers" title="Delivery runs">
        <DataGrid {...list.gridProps} caption="Delivery runs" columns={columns} currency={biz.symbol} rowNoun={["run", "runs"]} toolbar={<PeriodFilter list={list} />}
          empty="No delivery runs in these dates" emptyHint={`Send orders on one van from 'To dispatch'. Today is ${dateShort(businessToday(biz.business.timezone), { year: true })}.`} emptyIcon="truck" />
      </SectionCard>
    </>
  );
}
