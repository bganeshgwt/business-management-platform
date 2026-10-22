import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { count, dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "./shared";
import { inPacks, packOf } from "./tradeFormat";
import { PO_STATUS, printPurchaseOrder } from "./purchaseFormat";

// Purchase orders to suppliers (round 2): to the company or the
// super-stockist. Raised by hand or from the reorder suggestions (items at or
// below their reorder level and customers' back-orders the godown cannot
// cover), sent and printed, received in parts — each receipt is an ordinary
// purchase with the supplier's bill — and closed short or cancelled.

const TABS = [
  { value: "open", label: "Open" },
  { value: "received", label: "Received" },
  { value: "done", label: "Closed / cancelled" },
  { value: "all", label: "All" },
];
const TAB_STATUS = { open: "draft,sent,part_received", received: "received", done: "closed,cancelled" };
const ITEMS = "catalog?active=true&kind=goods";
const SUPPLIERS = "contacts?kind=supplier&active=true";
// "12 case" / "12 case + 8 each" / "8 each": short, for crowded grids.
const shortPacks = (qty, unit, packUnit, factor) => inPacks(qty, unit, packUnit, factor).replace(/ \(.*\)$/, "");
const SENT_VIA_SHORT = { whatsapp: "WhatsApp", email: "Email", printed: "Printed", phone: "Phone", other: "Other" };
const SENT_VIA = [["whatsapp", "WhatsApp"], ["email", "Email"], ["printed", "Printed and handed over"], ["phone", "Phoned in"], ["other", "Other"]];

function PoBadge({ status, late }) {
  if (late) return <Badge status="overdue" tone="danger" label="Late" />;
  const s = PO_STATUS[status] || { tone: "neutral", label: status };
  return <Badge status={status} tone={s.tone} label={s.label} />;
}

export default function PurchaseOrdersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const canRaise = biz.can("purchasing.create");
  const [tab, setTab] = useState("open");
  const list = useServerList("purchase-orders", { gridId: "wholesale-purchase-orders", period: true, params: TAB_STATUS[tab] ? { status: TAB_STATUS[tab] } : {} });
  const { reload } = list;
  const [raising, setRaising] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const openId = params.get("po");
  const open = (id) => setParams((p) => { const next = new URLSearchParams(p); if (id) next.set("po", String(id)); else next.delete("po"); return next; });

  const rows = list.gridProps.rows;
  const pending = rows.reduce((s, p) => s + (["draft", "sent", "part_received"].includes(p.status) ? Number(p.pending_value) : 0), 0);
  const columns = [
    { key: "po_no", header: "PO no.", value: (p) => p.po_no, mobile: "title", pin: true, render: (p) => <span className="mono">{p.po_no}</span> },
    { key: "date", header: "Raised", type: "date", value: (p) => p.created_at, render: (p) => dateShort(p.created_at) },
    { key: "supplier", header: "Supplier", value: (p) => p.contact_name, mobile: "subtitle" },
    { key: "location", header: "Into", value: (p) => p.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "expected", header: "Expected by", type: "date", value: (p) => p.expected_on || "", render: (p) => (p.expected_on ? dateShort(p.expected_on) : "—") },
    { key: "lines", header: "Lines", type: "number", value: (p) => p.line_count, defaultHidden: true },
    { key: "total", header: "Order value", type: "money", exact: true, value: (p) => Number(p.total), total: "sum", mobile: "show" },
    { key: "received", header: "Received (bills)", type: "money", exact: true, value: (p) => Number(p.received_value), total: "sum" },
    { key: "pending", header: "Still to come", type: "money", exact: true, value: (p) => Number(p.pending_value), total: "sum" },
    { key: "status", header: "Status", type: "status", value: (p) => p.status, mobile: "show", render: (p) => <PoBadge status={p.status} late={p.late} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => <button type="button" className="chip-button" onClick={() => open(p.id)}>Open</button> },
  ];

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Purchase orders"
        description="Orders to the company or the super-stockist. Start from the reorder suggestions, send the order, then receive the goods against it — in parts if they come in parts. Each receipt is a purchase with the supplier's bill."
        primary={canRaise && <button type="button" className="button" onClick={() => setSuggesting(true)}><Icon name="sparkles" size={16} /> Reorder suggestions</button>}
        secondary={canRaise && <button type="button" className="button button-secondary" onClick={() => setRaising({})}><Icon name="plus" size={16} /> New purchase order</button>} />
      <div className="stat-grid">
        <StatTile icon="clipboard" label="Orders in these dates" value={count(list.data?.total ?? 0)} loading={!list.data} />
        <StatTile icon="money" label="Still to come (this page)" money={pending} loading={!list.data} note="Open orders at the costs asked" />
        <StatTile icon="clock" label="Late (this page)" value={count(rows.filter((p) => p.late).length)} loading={!list.data} note="Past the expected date, not all in" />
      </div>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Purchase orders">
        <DataGrid {...list.gridProps} caption="Purchase orders" columns={columns} currency={biz.symbol} rowNoun={["purchase order", "purchase orders"]}
          toolbar={<><PeriodFilter list={list} /><Segmented label="Show" value={tab} options={TABS} onChange={setTab} /></>}
          exportName={biz.can("purchasing.export") ? `${biz.business.code}-purchase-orders` : undefined}
          rowClassName={(p) => (p.status === "cancelled" ? "dg-tone-muted" : p.late ? "dg-tone-warning" : "")}
          empty="No purchase orders in these dates" emptyHint="Pick other dates, another tab, or start from the reorder suggestions." emptyIcon="purchaseOrders" />
      </SectionCard>
      {suggesting && <SuggestionsDialog onClose={() => setSuggesting(false)} onRaised={(made) => { setSuggesting(false); reload(); if (made.length === 1) open(made[0].id); }} />}
      {raising && <PoDialog po={raising.id ? raising : null} onClose={() => setRaising(null)} onSaved={(po) => { setRaising(null); reload(); open(po.id); }} />}
      {openId && <PoDetail poId={openId} onClose={() => open(null)} onChanged={reload} onEdit={(po) => { open(null); setRaising(po); }} />}
    </div>
  );
}

// --- Reorder suggestions ------------------------------------------------------------

function SuggestionsDialog({ onClose, onRaised }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  // A wholesaler orders for a godown and its customers' back-orders; a shop for its branch shelves.
  const orders = biz.has("sales_orders");
  const place = orders ? "godown" : "branch";
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || locations[0]?.id || ""));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [qty, setQty] = useState({});
  const [fallback, setFallback] = useState(null);
  const [busy, setBusy] = useState(false);
  const { options } = useOptions([SUPPLIERS]);
  const suppliers = options?.[SUPPLIERS] || [];

  useEffect(() => {
    if (!locationId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "purchase-orders/suggestions", { location: locationId }, controller.signal)
      .then((d) => { setData(d); setPicked(new Set(d.items.filter((i) => i.supplier_id).map((i) => i.sku_id))); setQty({}); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, locationId]);

  // The answer for the godown chosen now (another godown's while the new one loads is not shown).
  const current = data && String(data.location.id) === locationId ? data : null;
  const items = useMemo(() => current?.items || [], [current]);
  const amountOf = (i) => Number(qty[i.sku_id] ?? i.suggested_quantity) * (i.suggested_unit !== i.unit ? Number(i.pack_factor) : 1) * Number(i.last_cost || 0);
  const chosen = items.filter((i) => picked.has(i.sku_id) && Number(qty[i.sku_id] ?? i.suggested_quantity) > 0);
  const noSupplier = chosen.filter((i) => !i.supplier_id);
  const groups = chosen.reduce((m, i) => {
    const sid = i.supplier_id || fallback?.id;
    if (!sid) return m;
    m.set(sid, [...(m.get(sid) || []), i]);
    return m;
  }, new Map());

  const raise = async () => {
    setBusy(true);
    setError("");
    const made = [];
    try {
      for (const [contactId, lines] of groups) {
        made.push(await businessWrite(biz.id, "purchase-orders", {
          requestKey: newKey(), contactId, locationId: Number(locationId),
          lines: lines.map((i) => ({ skuId: i.sku_id, quantity: String(qty[i.sku_id] ?? i.suggested_quantity), ...(i.suggested_unit !== i.unit ? { unit: i.suggested_unit } : {}),
            source: i.reason, ...(i.last_cost ? {} : { unitCost: "0" }) })),
        }));
      }
      toast.success(made.length === 1 ? `${made[0].po_no} raised as a draft` : `${made.length} purchase orders raised as drafts`);
      onRaised(made);
    } catch (err) {
      setError(made.length ? `${made.length} raised; then: ${getErrorMessage(err)}` : getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id) => setPicked((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const columns = [
    // Sized to fit the dialog at 1440 (the last cost is a column to switch on).
    { key: "pick", header: "", label: "Choose", width: 44, minWidth: 44, render: (i) => <input type="checkbox" aria-label={`Order ${i.label}`} checked={picked.has(i.sku_id)} onChange={() => toggle(i.sku_id)} /> },
    { key: "item", header: "Item", value: (i) => i.label, mobile: "title", width: 175,
      render: (i) => <span className="bz-two-line"><span>{i.label}</span><small className="muted">{i.code}</small></span> },
    { key: "supplier", header: "Last bought from", value: (i) => i.supplier_name || "", filter: "select", mobile: "subtitle", width: 135,
      render: (i) => i.supplier_name || <span className="muted">Never bought</span> },
    { key: "why", header: "Why", value: (i) => (i.reason === "back_order" ? "Back-orders" : "Below reorder level"), filter: "select", width: 120,
      render: (i) => <Badge tone={i.reason === "back_order" ? "warning" : "info"} label={i.reason === "back_order" ? "Back-orders" : "Low stock"} /> },
    { key: "stock", header: "In stock", type: "number", width: 125, value: (i) => Number(i.stock), render: (i) => shortPacks(i.stock, i.unit, i.pack_unit, i.pack_factor) },
    { key: "level", header: "Reorder level", type: "number", value: (i) => Number(i.reorder_level), render: (i) => quantity(i.reorder_level, i.unit), defaultHidden: true },
    orders && { key: "back", header: "Back orders", type: "number", width: 110, value: (i) => Number(i.back_orders), render: (i) => (Number(i.back_orders) ? shortPacks(i.back_orders, i.unit, i.pack_unit, i.pack_factor) : "—") },
    { key: "on", header: "On order", type: "number", width: 100, value: (i) => Number(i.on_order), render: (i) => (Number(i.on_order) ? shortPacks(i.on_order, i.unit, i.pack_unit, i.pack_factor) : "—") },
    { key: "qty", header: "Order", width: 135, render: (i) => (
      <label className="bz-cases" style={{ gridTemplateColumns: "4.5rem auto", alignItems: "center" }}>
        <input aria-label={`${i.label} quantity`} className="bz-small-input" type="number" min="0" step={i.suggested_unit !== i.unit ? "1" : "any"}
          value={qty[i.sku_id] ?? i.suggested_quantity} onChange={(e) => setQty((q) => ({ ...q, [i.sku_id]: e.target.value }))} />{i.suggested_unit}
      </label>
    ) },
    { key: "cost", header: "Last cost", type: "money", exact: true, defaultHidden: true, value: (i) => Number(i.last_cost || 0), render: (i) => (i.last_cost ? `${biz.exact(i.last_cost)} / ${i.unit}` : "—") },
    { key: "value", header: "Value", type: "money", exact: true, width: 110, value: (i) => amountOf(i), total: "sum", mobile: "show" },
  ].filter(Boolean);
  return (
    <Modal title="Reorder suggestions" icon="sparkles" width={1180} onClose={onClose} dismissible={!busy}
      description={orders
        ? "What to order now at one godown: customers' back-orders plus the reorder level, less what is in stock and already on order, in whole cases. One draft order is raised for each supplier."
        : "What to order now for one branch: up to each item's reorder level, less what is in stock and already on order, in whole cases. One draft order is raised for each supplier."}>
      <div className="stack">
        <div className="form-grid">
          {locations.length > 1 && (
            <Field label={orders ? "Godown" : "Branch"}><select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          )}
          <div className="field">
            <SearchPicker label="Supplier for items never bought (optional)" value={fallback} options={suppliers} onChange={setFallback}
              getKey={(s) => s.id} getLabel={(s) => s.name} getDescription={(s) => s.phone || ""} placeholder="Supplier name" />
          </div>
        </div>
        <ErrorMessage message={error} />
        {!current && !error ? <Loading label="Working out what to order…" /> : (
          <DataGrid id="wholesale-reorder-suggestions" variant="compact" caption="Reorder suggestions" rows={items} rowKey={(i) => i.sku_id} columns={columns} currency={biz.symbol}
            rowNoun={["item", "items"]} empty="Nothing to order" emptyHint={orders ? "Every item is above its reorder level and back-orders are covered." : `Every item at this ${place} is above its reorder level. Set reorder levels on Products to get suggestions.`} emptyIcon="check" />
        )}
        {noSupplier.length > 0 && !fallback && <p className="bz-note-card is-warning small">{noSupplier.length} chosen item{noSupplier.length === 1 ? " has" : "s have"} never been bought: choose a supplier above for {noSupplier.length === 1 ? "it" : "them"}, or untick {noSupplier.length === 1 ? "it" : "them"}.</p>}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Close</button>
          <button type="button" className="button" disabled={busy || !groups.size || (noSupplier.length > 0 && !fallback)} onClick={raise}>
            {busy ? "Raising…" : `Raise ${groups.size || ""} draft order${groups.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Raise / change a draft -------------------------------------------------------------

const lineFrom = (sku, extra = {}) => {
  const pack = packOf(sku);
  return { key: newKey(), sku, unit: pack ? pack.unit : sku.unit, quantity: "", cost: "", ...extra };
};

function PoDialog({ po, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(po);
  const { options, error } = useOptions([ITEMS, SUPPLIERS]);
  const items = useMemo(() => options?.[ITEMS] || [], [options]);
  const suppliers = options?.[SUPPLIERS] || [];
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [supplier, setSupplier] = useState(null);
  const [form, setForm] = useState({ locationId: String(po?.location_id || locations[0]?.id || ""), expectedOn: po?.expected_on || "", notes: po?.notes || "" });
  const [typed, setTyped] = useState(null);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const seed = useMemo(() => (!editing || !items.length ? [] : po.lines.map((l) => {
    const sku = items.find((x) => x.id === l.sku_id) || { id: l.sku_id, label: l.label, unit: l.unit, pack_sizes: [] };
    const inPack = Boolean(l.entered_unit);
    return lineFrom(sku, { unit: l.entered_unit || l.unit, quantity: String(Number(inPack ? l.entered_quantity : l.quantity)),
      cost: (inPack ? Number(l.unit_cost) * Number(l.unit_factor) : Number(l.unit_cost)).toFixed(2) });
  })), [editing, items, po]);
  const lines = typed ?? seed;
  const setLines = (next) => setTyped((all) => (typeof next === "function" ? next(all ?? seed) : next));
  const setLine = (key, name, value) => setLines((all) => all.map((l) => (l.key === key ? { ...l, [name]: value } : l)));
  const chosenSupplier = supplier || (editing ? suppliers.find((s) => s.id === po.contact_id) || null : null);
  const factorOf = (l) => (l.unit === l.sku.unit ? 1 : Number((l.sku.pack_sizes || []).find((p) => p.unit_code === l.unit)?.quantity_in_base || 1));
  const estimate = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.cost || 0) * (1 + Number(l.sku.tax_rate || 0) / 100), 0);

  const submit = () => {
    if (!chosenSupplier) return Promise.reject(Object.assign(new Error("Choose the supplier"), { response: { data: { message: "Choose the supplier" } } }));
    const out = lines.filter((l) => Number(l.quantity) > 0).map((l) => ({ skuId: l.sku.id, quantity: String(l.quantity), ...(l.unit !== l.sku.unit ? { unit: l.unit } : {}), ...(l.cost !== "" ? { unitCost: String(l.cost) } : {}) }));
    if (!out.length) return Promise.reject(Object.assign(new Error("Add at least one item"), { response: { data: { message: "Add at least one item with a quantity" } } }));
    const body = { contactId: chosenSupplier.id, expectedOn: form.expectedOn || null, notes: form.notes || null, lines: out };
    return editing ? businessWrite(biz.id, `purchase-orders/${po.id}`, body, "patch") : businessWrite(biz.id, "purchase-orders", { ...body, requestKey, locationId: Number(form.locationId) });
  };
  const columns = [
    { key: "item", header: "Item", render: (l) => <span className="bz-two-line"><span>{l.sku.label}</span><small className="muted">{[l.sku.code, packOf(l.sku) && `${packOf(l.sku).unit} of ${packOf(l.sku).factor}`].filter(Boolean).join(" · ")}</small></span> },
    { key: "qty", header: "Quantity", render: (l) => (
      <span className="bz-cases" style={{ gridTemplateColumns: "1fr auto" }}>
        <input aria-label={`${l.sku.label} quantity`} className="bz-small-input" type="number" min="0" step={l.unit === l.sku.unit ? "any" : "1"} value={l.quantity} onChange={(e) => setLine(l.key, "quantity", e.target.value)} />
        <select aria-label={`${l.sku.label} unit`} value={l.unit} onChange={(e) => setLine(l.key, "unit", e.target.value)}>
          <option value={l.sku.unit}>{l.sku.unit}</option>
          {(l.sku.pack_sizes || []).map((p) => <option key={p.unit_code} value={p.unit_code}>{p.unit_code} of {Number(p.quantity_in_base)}</option>)}
        </select>
      </span>
    ) },
    { key: "units", header: "In stock units", type: "number", value: (l) => Number(l.quantity || 0) * factorOf(l), render: (l) => quantity(Number(l.quantity || 0) * factorOf(l), l.sku.unit) },
    { key: "cost", header: "Cost before GST", render: (l) => <input aria-label={`${l.sku.label} cost per ${l.unit}`} className="bz-small-input" type="number" min="0" step="0.01" placeholder="Last cost" value={l.cost} onChange={(e) => setLine(l.key, "cost", e.target.value)} /> },
    { key: "amount", header: "Estimate incl. GST", type: "money", exact: true, value: (l) => Number(l.quantity || 0) * Number(l.cost || 0) * (1 + Number(l.sku.tax_rate || 0) / 100), total: "sum" },
    { key: "remove", header: "", label: "Remove", type: "actions", render: (l) => <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button> },
  ];
  return (
    <FormDialog title={editing ? `Change ${po.po_no}` : "New purchase order"} icon="clipboard" width={1040} submitLabel={editing ? "Save changes" : "Raise as draft"}
      onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options} successMessage={(r) => (editing ? `${r.po_no} saved` : `${r.po_no} raised as a draft`)}
      description="The cost is per the unit chosen (per case when ordered in cases), before GST; left empty, the last purchase cost is used. A draft can still be changed; send it when it is ready.">
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading label="Loading items and suppliers…" /></div>}
      <div className="field">
        <SearchPicker label="Supplier" required value={chosenSupplier} options={suppliers} onChange={setSupplier} autoFocus={!editing}
          getKey={(s) => s.id} getLabel={(s) => s.name} getDescription={(s) => [s.phone, s.gstin].filter(Boolean).join(" · ")} placeholder="Company or super-stockist" />
      </div>
      {!editing && locations.length > 1 && (
        <Field label="Deliver to"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      )}
      <Field label="Expected by (optional)"><input type="date" min={businessToday(biz.business.timezone)} value={form.expectedOn} onChange={set("expectedOn")} /></Field>
      <div className="field-wide">
        <SearchPicker aria-label="Add item" placeholder="Add an item: name or code" options={items.filter((i) => !lines.some((l) => l.sku.id === i.id))} clearOnSelect
          getKey={(i) => i.id} getLabel={(i) => i.label} getKeywords={(i) => `${i.code || ""} ${i.barcode || ""}`} getDescription={(i) => `${i.code || ""} · ${quantity(i.stock, i.unit)} in stock`}
          onChange={(sku) => sku && setLines((all) => [...all, lineFrom(sku)])} />
      </div>
      <div className="field-wide bz-lines">
        <DataGrid variant="editor" caption="Lines" rows={lines} rowKey={(l) => l.key} columns={columns} currency={biz.symbol} empty="No items yet" emptyHint="Add items above." />
      </div>
      <p className="field-wide muted small">Estimate {biz.exact(estimate)} including GST at each item's rate. The supplier's bill, entered when the goods come in, is what is owed.</p>
      <Field label="Notes for the supplier (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Deliver before 11 am; no short-dated stock" /></Field>
    </FormDialog>
  );
}

// --- One purchase order ------------------------------------------------------------------

function PoDetail({ poId, onClose, onChanged, onEdit }) {
  const biz = useOpenBusiness();
  const canRaise = biz.can("purchasing.create");
  const [po, setPo] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [action, setAction] = useState(null);
  const [via, setVia] = useState("whatsapp");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `purchase-orders/${poId}`, undefined, controller.signal).then((d) => { setPo(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, poId, version]);
  const changed = (message) => { setAction(null); setVersion((n) => n + 1); if (message) toast.success(message); onChanged(); };
  const open = po && ["draft", "sent", "part_received"].includes(po.status);
  const send = async () => {
    setBusy(true);
    try {
      await businessWrite(biz.id, `purchase-orders/${po.id}/send`, { via });
      if (via === "printed") printPurchaseOrder(po, biz);
      changed(`${po.po_no} marked sent`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const columns = [
    { key: "item", header: "Item", value: (l) => l.label, mobile: "title", render: (l) => <span className="bz-two-line"><span>{l.label}</span><small className="muted">{l.sku_code}</small></span> },
    { key: "ordered", header: "Ordered", type: "number", value: (l) => Number(l.quantity), render: (l) => inPacks(l.quantity, l.unit, l.entered_unit, l.unit_factor), mobile: "show" },
    { key: "received", header: "Received", type: "number", value: (l) => Number(l.received_quantity), render: (l) => (Number(l.received_quantity) ? inPacks(l.received_quantity, l.unit, l.entered_unit, l.unit_factor) : "—"), mobile: "show" },
    { key: "remaining", header: "Still to come", type: "number", value: (l) => Number(l.remaining), render: (l) => (Number(l.remaining) ? <strong>{inPacks(l.remaining, l.unit, l.entered_unit, l.unit_factor)}</strong> : Number(l.closed_quantity) ? <span className="muted">Will not come</span> : "—") },
    { key: "cost", header: "Cost", type: "money", exact: true, value: (l) => Number(l.unit_cost), render: (l) => (l.entered_unit ? `${biz.exact(Number(l.unit_cost) * Number(l.unit_factor))} / ${l.entered_unit}` : `${biz.exact(l.unit_cost)} / ${l.unit}`) },
    { key: "value", header: "Value incl. GST", type: "money", exact: true, value: (l) => Number(l.net) + Number(l.tax), total: "sum" },
    { key: "source", header: "Why", value: (l) => ({ manual: "Added by hand", reorder: "Reorder level", back_order: "Back-orders" }[l.source]), defaultHidden: true },
    { key: "stock", header: "In stock now", type: "number", value: (l) => Number(l.stock), render: (l) => inPacks(l.stock, l.unit, l.entered_unit, l.unit_factor), defaultHidden: true },
  ];
  return (
    <Modal title={po ? `${po.po_no} · ${po.contact_name}` : "Purchase order"} icon="clipboard" width={1040} onClose={onClose}>
      {error && <ErrorMessage message={error} />}
      {!po && !error && <Loading label="Opening the purchase order…" />}
      {po && (
        <div className="stack">
          <div className="bz-customer-card" aria-label="Order">
            <div><small>Status</small><strong><PoBadge status={po.status} /></strong></div>
            <div title={`Raised by ${po.created_by_name}`}><small>Raised</small><strong>{dateShort(po.created_at)}</strong></div>
            <div><small>Expected by</small><strong>{po.expected_on ? dateShort(po.expected_on) : "—"}</strong></div>
            <div><small>Order value</small><strong>{biz.exact(po.total)}</strong></div>
            <div><small>Into</small><strong>{po.location_name}</strong></div>
            {po.sent_at && <div title={dateTime(po.sent_at)}><small>Sent</small><strong>{dateShort(po.sent_at)}{po.sent_via ? ` · ${SENT_VIA_SHORT[po.sent_via] || po.sent_via}` : ""}</strong></div>}
          </div>
          {po.close_reason && <p className="bz-note-card small">{po.status === "cancelled" ? "Cancelled" : "Closed short"} {dateTime(po.closed_at)} by {po.closed_by_name}: {po.close_reason}</p>}
          {po.notes && <p className="muted small">Notes for the supplier: {po.notes}</p>}
          <DataGrid id="wholesale-po-lines" caption="Lines" rows={po.lines} rowKey={(l) => l.id} columns={columns} currency={biz.symbol} rowNoun={["line", "lines"]} />
          <SectionCard icon="receipt" title="Received against this order" description="Each receipt is a purchase in Purchases, with the supplier's bill; pay it from Suppliers.">
            {po.receipts.length === 0 ? <p className="muted">Nothing received yet.</p> : (
              <ul className="bz-history">
                {po.receipts.map((r) => (
                  <li key={r.id}><span className="mono">{r.document_no}</span> · {biz.exact(r.total)} · {dateTime(r.created_at)} by {r.created_by_name}
                    {r.supplier_bill_no ? ` · supplier bill ${r.supplier_bill_no}` : ""}</li>
                ))}
              </ul>
            )}
          </SectionCard>
          <div className="form-actions">
            {biz.can("purchasing.print") && <button type="button" className="button button-secondary" onClick={() => printPurchaseOrder(po, biz)}><Icon name="print" size={15} /> Print</button>}
            {canRaise && po.status === "draft" && <button type="button" className="button button-secondary" onClick={() => onEdit(po)}><Icon name="edit" size={15} /> Change</button>}
            {canRaise && open && <button type="button" className="button button-secondary" onClick={() => setAction("close")}>{po.status === "part_received" ? "Close short" : "Cancel order"}</button>}
            {canRaise && po.status === "draft" && (
              <span className="inline-form">
                <select aria-label="Sent by" value={via} onChange={(e) => setVia(e.target.value)}>{SENT_VIA.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
                <button type="button" className="button button-secondary" disabled={busy} onClick={send}><Icon name="mail" size={15} /> Mark sent</button>
              </span>
            )}
            {canRaise && open && <button type="button" className="button" onClick={() => setAction("receive")}><Icon name="download" size={15} /> Receive goods</button>}
          </div>
        </div>
      )}
      {action === "receive" && <ReceiveDialog po={po} onClose={() => setAction(null)} onSaved={(d) => changed(d.status === "received" ? `${po.po_no} received in full` : `Received; ${po.po_no} is part received`)} />}
      {action === "close" && (
        <ReasonDialog title={po.status === "part_received" ? `Close ${po.po_no} short?` : `Cancel ${po.po_no}?`}
          description={po.status === "part_received" ? "What has not come will not come. What was received stays." : "Nothing came on this order; it is kept, marked cancelled."}
          placeholder="e.g. Company out of stock; ordered from the super-stockist instead" submitLabel={po.status === "part_received" ? "Close short" : "Cancel order"}
          onSubmit={(reason) => businessWrite(biz.id, `purchase-orders/${po.id}/close`, { reason })} onClose={() => setAction(null)}
          onSaved={() => changed(po.status === "part_received" ? `${po.po_no} closed short` : `${po.po_no} cancelled`)} />
      )}
    </Modal>
  );
}

// What came in: the supplier's bill, and per line the quantity (in the
// order's pack or stock unit), the bill's cost, and the batch and expiry.
function ReceiveDialog({ po, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [bill, setBill] = useState({ supplierBillNo: "", supplierBillDate: businessToday(biz.business.timezone), notes: "" });
  const waiting = po.lines.filter((l) => Number(l.remaining) > 0);
  const [rows, setRows] = useState(() => Object.fromEntries(waiting.map((l) => {
    const inPack = l.entered_unit && Number.isInteger(Math.round((Number(l.remaining) / Number(l.unit_factor)) * 1000) / 1000);
    return [l.id, { quantity: String(inPack ? Number(l.remaining) / Number(l.unit_factor) : Number(l.remaining)), unit: inPack ? l.entered_unit : l.unit,
      cost: (inPack ? Number(l.unit_cost) * Number(l.unit_factor) : Number(l.unit_cost)).toFixed(2), lotCode: "", expiresOn: "" }];
  })));
  const setRow = (id, name, value) => setRows((r) => ({ ...r, [id]: { ...r[id], [name]: value } }));
  const anyBatch = waiting.some((l) => l.tracking === "batch");
  const submit = () => businessWrite(biz.id, `purchase-orders/${po.id}/receive`, {
    requestKey, supplierBillNo: bill.supplierBillNo || undefined, supplierBillDate: bill.supplierBillNo ? bill.supplierBillDate || undefined : undefined, notes: bill.notes || undefined,
    lines: waiting.filter((l) => Number(rows[l.id].quantity) > 0).map((l) => {
      const r = rows[l.id];
      return { poLineId: l.id, quantity: r.quantity, ...(r.unit !== l.unit ? { unit: r.unit } : {}), unitCost: r.cost,
        ...(r.lotCode ? { lotCode: r.lotCode } : {}), ...(r.expiresOn ? { expiresOn: r.expiresOn } : {}) };
    }),
  });
  const columns = [
    { key: "item", header: "Item", render: (l) => <span className="bz-two-line"><span>{l.label}</span><small className="muted">Still to come {inPacks(l.remaining, l.unit, l.entered_unit, l.unit_factor)}</small></span> },
    { key: "qty", header: "Came in", render: (l) => (
      <span className="bz-cases" style={{ gridTemplateColumns: "1fr auto" }}>
        <input aria-label={`${l.label} received`} className="bz-small-input" type="number" min="0" step="any" value={rows[l.id].quantity} onChange={(e) => setRow(l.id, "quantity", e.target.value)} />
        <select aria-label={`${l.label} unit`} value={rows[l.id].unit} onChange={(e) => {
          const unit = e.target.value;
          const factor = Number(l.unit_factor || 1);
          setRows((r) => ({ ...r, [l.id]: { ...r[l.id], unit, cost: (unit === l.unit ? Number(l.unit_cost) : Number(l.unit_cost) * factor).toFixed(2),
            quantity: String(unit === l.unit ? Number(r[l.id].quantity || 0) * factor : Number(r[l.id].quantity || 0) / factor) } }));
        }}>
          <option value={l.unit}>{l.unit}</option>
          {l.entered_unit && <option value={l.entered_unit}>{l.entered_unit}</option>}
        </select>
      </span>
    ) },
    { key: "cost", header: "Cost on the bill", render: (l) => <input aria-label={`${l.label} cost`} className="bz-small-input" type="number" min="0" step="0.01" required value={rows[l.id].cost} onChange={(e) => setRow(l.id, "cost", e.target.value)} /> },
    anyBatch && { key: "batch", header: "Batch · expiry", render: (l) => (l.tracking === "batch" ? (
      <span className="bz-cases" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(8.5rem, 1fr))" }}>
        <input aria-label={`${l.label} batch`} className="bz-small-input" required={Number(rows[l.id].quantity) > 0} maxLength={100} placeholder="Batch" value={rows[l.id].lotCode} onChange={(e) => setRow(l.id, "lotCode", e.target.value)} />
        <input aria-label={`${l.label} expiry`} type="date" value={rows[l.id].expiresOn} onChange={(e) => setRow(l.id, "expiresOn", e.target.value)} />
      </span>
    ) : <span className="muted">—</span>) },
  ].filter(Boolean);
  return (
    <FormDialog title={`Receive against ${po.po_no}`} icon="download" width={980} submitLabel="Receive into stock" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      successMessage={(d) => `Goods in · ${d.receipts?.[d.receipts.length - 1]?.document_no || "purchase posted"}`}
      description={`${po.contact_name} · into ${po.location_name}. Enter what actually came; set a line to 0 if it did not come this time. The purchase is posted with the supplier's bill and the rest stays on order.`}>
      <Field label="Supplier's bill no. (optional)"><input maxLength={60} value={bill.supplierBillNo} onChange={(e) => setBill((b) => ({ ...b, supplierBillNo: e.target.value }))} /></Field>
      <Field label="Bill date"><input type="date" max={businessToday(biz.business.timezone)} value={bill.supplierBillDate} onChange={(e) => setBill((b) => ({ ...b, supplierBillDate: e.target.value }))} /></Field>
      <div className="field-wide bz-lines">
        <DataGrid variant="editor" caption="Goods received" rows={waiting} rowKey={(l) => l.id} columns={columns} currency={biz.symbol} />
      </div>
      <Field label="Notes (optional)" wide><input maxLength={300} value={bill.notes} onChange={(e) => setBill((b) => ({ ...b, notes: e.target.value }))} placeholder="e.g. 2 cases short, damaged carton refused" /></Field>
    </FormDialog>
  );
}
