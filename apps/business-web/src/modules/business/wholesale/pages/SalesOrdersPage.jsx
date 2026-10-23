import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { escapeHtml, printDocument } from "../../../../services/print";
import { balanceText, count, dateShort, dateTime, money } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { printTaxInvoice } from "../../core/pages/invoice";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { AccountDialog } from "../../receivables/pages/receivablesParts";
import { OrderBadge, Segmented } from "./shared";
import { inPacks, packOf, packText, splitPacks } from "./tradeFormat";
import { ChallanDialog, DeliveryDialog, TransportDialog, TransportFields } from "./deliveryParts";
import { DELIVERY, emptyTransport, transportBody } from "./deliveryFormat";

// Sales orders of a wholesale business. An order fixes the prices; each
// dispatch sends part or all of it with its own tax invoice; what is not sent
// yet is a back-order until it is sent or the order is closed short.
// Fast order entry (search, cases + pieces, discount, free goods,
// repeat last order, the customer's dues while ordering), credit hold with a
// manager's release, editing before dispatch, transport and delivery.

const STATUS_TABS = [
  { value: "open,part_dispatched", label: "To dispatch" },
  { value: "dispatched", label: "Dispatched" },
  { value: "closed,cancelled", label: "Closed" },
  { value: "", label: "All" },
];

export default function SalesOrdersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("open,part_dispatched");
  const [salesperson, setSalesperson] = useState("");
  const [route, setRoute] = useState("");
  const { options } = useOptions(["salespeople", "routes"]);
  const list = useServerList("sales-orders", { gridId: "wholesale-orders", period: true,
    params: { ...(status ? { status } : {}), ...(salesperson ? { salesperson } : {}), ...(route ? { route } : {}) } });
  const [creating, setCreating] = useState(() => (params.get("new") === "1" && biz.can("sales_orders.create") ? { contactId: params.get("customer") || "" } : null));
  const [open, setOpen] = useState(() => (params.get("order") ? { id: Number(params.get("order")), dispatch: params.get("dispatch") === "1" } : null));
  useEffect(() => {
    if (params.get("new") || params.get("order")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);

  const columns = useMemo(() => [
    { key: "order_no", header: "Order", value: (o) => o.order_no, mobile: "title", pin: true,
      render: (o) => <button type="button" className="link-button mono bz-link-left" onClick={() => setOpen({ id: o.id })}>{o.order_no}</button> },
    { key: "created_at", header: "Taken", type: "datetime", value: (o) => o.created_at },
    { key: "contact_name", header: "Customer", value: (o) => o.contact_name, mobile: "subtitle" },
    { key: "salesperson", header: "Salesperson", value: (o) => o.salesperson_name || "" },
    { key: "route", header: "Route", value: (o) => o.route_name || "", defaultHidden: true },
    { key: "total", header: "Order value", type: "money", exact: true, value: (o) => Number(o.total), total: "sum", mobile: "show" },
    { key: "invoiced", header: "Invoiced", type: "money", exact: true, value: (o) => Number(o.invoiced), total: "sum", defaultHidden: true },
    { key: "pending", header: "Still to send", type: "money", exact: true, value: (o) => Number(o.pending_value), total: "sum", mobile: "show" },
    { key: "expected_on", header: "Wanted by", type: "date", value: (o) => o.expected_on, defaultHidden: true },
    { key: "status", header: "Status", type: "status", value: (o) => o.status, mobile: "show", render: (o) => (
      <span className="bz-two-line"><OrderBadge status={o.status} />
        {(o.hold_released || o.edited || o.out_for_delivery > 0) && <small className="muted">{[o.hold_released && "hold released", o.edited && "edited", o.out_for_delivery > 0 && "on the way"].filter(Boolean).join(" · ")}</small>}
      </span>
    ) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => (
      <button type="button" className="chip-button" onClick={() => setOpen({ id: o.id, dispatch: ["open", "part_dispatched"].includes(o.status) && biz.can("sales_orders.approve") })}>
        {["open", "part_dispatched"].includes(o.status) && biz.can("sales_orders.approve") ? "Dispatch" : "View"}
      </button>
    ) },
  ], [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Sales orders"
        description="Orders from shops and retailers. Prices are fixed when the order is taken; stock leaves and the invoice is raised when you dispatch, in one go or in parts."
        primary={biz.can("sales_orders.create") && <button type="button" className="button" onClick={() => setCreating({})}><Icon name="plus" size={16} /> New order</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Orders in this period">
        <DataGrid {...list.gridProps} caption="Sales orders" columns={columns} currency={biz.symbol} rowNoun={["order", "orders"]}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <Segmented label="Show" value={status} options={STATUS_TABS} onChange={setStatus} />
              <label className="field">
                <span>Salesperson</span>
                <select value={salesperson} onChange={(e) => setSalesperson(e.target.value)}>
                  <option value="">Anyone</option>
                  {(options?.salespeople || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Route</span>
                <select value={route} onChange={(e) => setRoute(e.target.value)}>
                  <option value="">All routes</option>
                  {(options?.routes || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
            </>
          )}
          exportName={biz.can("sales_orders.export") ? `${biz.business.code}-sales-orders` : undefined}
          rowClassName={(o) => (o.status === "cancelled" ? "dg-tone-muted" : o.status === "part_dispatched" ? "dg-tone-warning" : "")}
          empty="No orders in these dates" emptyHint="Pick other dates or another tab above." emptyIcon="clipboard" />
      </SectionCard>
      {creating && <OrderDialog initialContactId={creating.contactId} onClose={() => setCreating(null)}
        onSaved={(o) => { setCreating(null); toast.success(`${o.order_no} taken for ${o.contact_name}${o.hold_released ? " (credit hold released)" : ""}`); list.reload(); setOpen({ id: o.id }); }} />}
      {open && <OrderDetail orderId={open.id} startDispatch={open.dispatch} onClose={() => setOpen(null)} onChanged={() => list.reload()} />}
    </div>
  );
}

let lineSeq = 0;
const lineOf = (sku, extra = {}) => {
  const pack = packOf(sku);
  return { key: `l${(lineSeq += 1)}`, sku, cases: pack ? "1" : "", pieces: pack ? "" : "1", discount: "", free: "", ...extra };
};
// What a line asks for: whole packs alone go in packs (the pack price applies), anything else in pieces.
function lineQuantity(line) {
  const pack = packOf(line.sku);
  const cases = Number(line.cases || 0), pieces = Number(line.pieces || 0);
  if (pack && cases > 0 && !pieces) return { unit: pack.unit, quantity: String(cases), inPack: true };
  return { quantity: String(Math.round((cases * (pack?.factor || 0) + pieces) * 1000) / 1000), inPack: false };
}
const stockUnits = (line) => {
  const pack = packOf(line.sku);
  return Number(line.cases || 0) * (pack?.factor || 0) + Number(line.pieces || 0);
};

// New order, or (with `order`) a change to what is still to send.
function OrderDialog({ order, initialContactId, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(order);
  const { options, error } = useOptions(["catalog?active=true&kind=goods", "customer-beats?trade=trade", "salespeople?active=true", ...(biz.can("inventory.view") ? ["stock"] : [])]);
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ locationId: String(order?.location_id || locations[0]?.id || ""), contactId: order ? String(order.contact_id) : initialContactId || "",
    salespersonId: "", expectedOn: order?.expected_on || "", notes: order?.notes || "", reason: "" });
  const [typed, setTyped] = useState(null);
  const [summary, setSummary] = useState(null);
  const [hold, setHold] = useState(null);
  const [release, setRelease] = useState({ reason: "", approverId: "", pin: "" });
  const [releasers, setReleasers] = useState(null);
  const [account, setAccount] = useState(false);
  const items = useMemo(() => options?.["catalog?active=true&kind=goods"] || [], [options]);
  const customers = options?.["customer-beats?trade=trade"] || [];
  const people = options?.["salespeople?active=true"] || [];
  const stock = options?.stock || [];
  const customer = customers.find((c) => String(c.id) === form.contactId) || null;
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const setLine = (key, name, value) => setLines((all) => all.map((l) => (l.key === key ? { ...l, [name]: value } : l)));
  const available = (sku) => stock.filter((l) => l.sku_id === sku?.id && String(l.location_id) === form.locationId && !l.expired).reduce((s, l) => s + Number(l.quantity), 0);
  const canDiscount = biz.can("sales.discount") || biz.can("wholesale.edit");

  // Editing: the lines still to send, as cases + pieces (until the person changes them).
  const seed = useMemo(() => (!editing || !items.length ? [] : order.lines.filter((l) => !l.free_of_line_id && Number(l.remaining) > 0).map((l) => {
    const sku = items.find((x) => x.id === l.sku_id) || { id: l.sku_id, label: l.label, unit: l.unit, pack_sizes: l.unit_factor ? [{ unit_code: l.entered_unit, quantity_in_base: l.unit_factor }] : [] };
    const split = splitPacks(l.remaining, packOf(sku)?.factor);
    return lineOf(sku, { key: `o${l.id}`, orderLineId: l.id, cases: split.cases ? String(split.cases) : "", pieces: split.pieces ? String(split.pieces) : "", discount: Number(l.discount_percent) ? String(Number(l.discount_percent)) : "", origDiscount: Number(l.discount_percent) });
  })), [editing, items, order]);
  const lines = typed ?? seed;
  const setLines = (next) => setTyped((all) => (typeof next === "function" ? next(all ?? seed) : next));
  // The customer while ordering: what they owe, how late, hold, last order.
  useEffect(() => {
    if (!form.contactId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `sales-orders/customer-summary/${form.contactId}`, undefined, controller.signal).then(setSummary).catch(() => {});
    return () => controller.abort();
  }, [biz.id, form.contactId]);
  useEffect(() => {
    if (!hold || biz.can("receivables.approve") || releasers) return;
    businessRead(biz.id, "hold-releasers").then(setReleasers).catch(() => setReleasers([]));
  }, [biz, hold, releasers]);

  const repeatLast = () => {
    const last = summary?.last_order;
    if (!last) return;
    setLines(last.lines.map((l) => {
      const sku = items.find((s) => s.id === l.sku_id);
      if (!sku) return null;
      const pack = packOf(sku);
      const split = l.entered_unit && pack && l.entered_unit === pack.unit ? { cases: Number(l.entered_quantity), pieces: 0 } : splitPacks(l.quantity, pack?.factor);
      return lineOf(sku, { cases: split.cases ? String(split.cases) : "", pieces: split.pieces ? String(split.pieces) : "", discount: canDiscount && Number(l.discount_percent) ? String(Number(l.discount_percent)) : "" });
    }).filter(Boolean));
    toast.info(`${last.order_no} copied — change what you need`);
  };
  const addItem = (sku) => {
    if (!sku) return;
    setLines((all) => {
      const same = all.find((l) => l.sku.id === sku.id && !l.orderLineId);
      if (same) {
        const pack = packOf(sku);
        return all.map((l) => (l === same ? { ...l, ...(pack ? { cases: String(Number(l.cases || 0) + 1) } : { pieces: String(Number(l.pieces || 0) + 1) }) } : l));
      }
      return [...all, lineOf(sku)];
    });
  };
  const listValue = (l) => {
    const units = stockUnits(l);
    const amount = Number(l.sku.price || 0) * units * (1 - Number(l.discount || 0) / 100);
    return biz.settings.tax_mode === "inclusive" ? amount : amount * (1 + Number(l.sku.tax_rate || 0) / 100);
  };
  const estimate = lines.reduce((s, l) => s + listValue(l), 0);

  const body = () => {
    const out = lines.filter((l) => stockUnits(l) > 0 || l.orderLineId).map((l) => {
      const q = lineQuantity(l);
      const base = { quantity: stockUnits(l) > 0 ? q.quantity : "0", ...(q.unit ? { unit: q.unit } : {}),
        ...(Number(l.discount) || l.origDiscount ? { discountPercent: String(Number(l.discount || 0)) } : {}),
        ...(Number(l.free) > 0 ? { freeQuantity: l.free } : {}) };
      return l.orderLineId ? { orderLineId: l.orderLineId, ...base } : { skuId: l.sku.id, ...base };
    });
    const releaseBody = hold ? { release: { reason: release.reason, ...(release.approverId ? { approverId: release.approverId, pin: release.pin } : {}) } } : {};
    if (editing) return { requestKey, reason: form.reason, lines: out, expectedOn: form.expectedOn || null, notes: form.notes || null, ...releaseBody };
    return { locationId: form.locationId, contactId: form.contactId, requestKey, notes: form.notes || undefined, expectedOn: form.expectedOn || undefined,
      ...(form.salespersonId ? { salespersonId: form.salespersonId } : {}), lines: out, ...releaseBody };
  };
  const submit = async () => {
    if (!editing && !lines.some((l) => stockUnits(l) > 0)) throw new Error("Add at least one item");
    try {
      return editing ? await businessWrite(biz.id, `sales-orders/${order.id}`, body(), "patch") : await businessWrite(biz.id, "sales-orders", body());
    } catch (err) {
      const data = err?.response?.data?.data;
      if (data?.reason === "credit_hold" && !hold) {
        setHold(data);
        throw new Error(`${customer?.name || "This customer"} is on credit hold. Fill in "Let it through" below and press ${editing ? "Save changes" : "Take order"} again, or collect first.`);
      }
      throw err;
    }
  };
  const shown = form.contactId && String(summary?.contact?.id) === form.contactId ? summary : null;
  const acct = shown?.account;
  const creditLeft = shown?.contact?.credit_limit != null && acct ? Number(shown.contact.credit_limit) - Number(acct.balance) : null;
  const columns = [
    { key: "item", header: "Item", render: (l) => (
      <span className="bz-two-line"><span>{l.sku.label}</span>
        <small className="muted">{[l.sku.code, packOf(l.sku) && `${packOf(l.sku).unit} of ${packOf(l.sku).factor}`, biz.can("inventory.view") && `${quantity(available(l.sku), l.sku.unit)} in stock`].filter(Boolean).join(" · ")}</small>
      </span>
    ) },
    { key: "qty", header: "Cases + pieces", render: (l) => {
      const pack = packOf(l.sku);
      return (
        <div className="bz-cases">
          {pack ? <label>{pack.unit}<input aria-label={`${l.sku.label} ${pack.unit}`} type="number" min="0" step="1" inputMode="numeric" value={l.cases} onChange={(e) => setLine(l.key, "cases", e.target.value)} /></label> : <span />}
          <label>{l.sku.unit}<input aria-label={`${l.sku.label} ${l.sku.unit}`} type="number" min="0" step="any" inputMode="decimal" value={l.pieces} onChange={(e) => setLine(l.key, "pieces", e.target.value)} /></label>
        </div>
      );
    } },
    { key: "units", header: "In pieces", type: "number", value: (l) => stockUnits(l), render: (l) => <span className={biz.can("inventory.view") && stockUnits(l) > available(l.sku) ? "bz-due" : ""}>{quantity(stockUnits(l), l.sku.unit)}</span> },
    canDiscount && { key: "discount", header: "Disc. %", render: (l) => <input aria-label={`${l.sku.label} discount %`} className="bz-small-input" type="number" min="0" max="99.99" step="0.01" value={l.discount} onChange={(e) => setLine(l.key, "discount", e.target.value)} /> },
    canDiscount && { key: "free", header: "Free", render: (l) => {
      const inPack = lineQuantity(l).inPack;
      return <label className="bz-cases" style={{ gridTemplateColumns: "1fr" }}><input aria-label={`${l.sku.label} free ${inPack ? packOf(l.sku).unit : l.sku.unit}`} className="bz-small-input" type="number" min="0" step={inPack ? "1" : "any"} value={l.free} onChange={(e) => setLine(l.key, "free", e.target.value)} />{inPack ? packOf(l.sku).unit : l.sku.unit}</label>;
    } },
    { key: "amount", header: "Estimate", type: "money", exact: true, value: (l) => listValue(l), total: "sum" },
    { key: "remove", header: "", label: "Remove", type: "actions", render: (l) => <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button> },
  ].filter(Boolean);
  return (
    <>
      <FormDialog title={editing ? `Change ${order.order_no}` : "New sales order"} icon="clipboard" width={1100} submitLabel={editing ? "Save changes" : "Take order"} onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}
        description={editing ? "Change what is still to send. A changed line is priced again at today's price; what was already sent stays as it is." : "Search items by name, code or barcode; Enter adds the line. The server prices each line: the customer's own price, their price group, a slab, then the list price, with any scheme."}>
        <FormError message={error} />
        {!options && !error && <div className="field-wide"><Loading label="Loading items and customers…" /></div>}
        {editing && order.lines.some((l) => Number(l.dispatched_quantity) > 0) && (
          <p className="field-wide bz-note-card small" aria-label="Already sent">
            <Icon name="lock" size={13} /> Already sent, cannot be changed:{" "}
            {order.lines.filter((l) => Number(l.dispatched_quantity) > 0).map((l) => `${l.label} ${inPacks(l.dispatched_quantity, l.unit, l.entered_unit, l.unit_factor)}`).join(" · ")}
          </p>
        )}
        {!editing && (
          <div className="field">
            <SearchPicker label="Customer" required value={customer} options={customers} autoFocus={!initialContactId}
              onChange={(c) => { setForm((f) => ({ ...f, contactId: c ? String(c.id) : "", salespersonId: "" })); setHold(null); }}
              getKey={(c) => c.id} getLabel={(c) => c.name} getKeywords={(c) => `${c.phone || ""} ${c.route_name || ""} ${c.beat_name || ""} ${c.gstin || ""}`}
              getDescription={(c) => [balanceText(c.balance), c.beat_name && `${c.beat_name}${c.beat_today ? " (today)" : ""}`].filter(Boolean).join(" · ")}
              placeholder="Shop name, phone or beat" name="contact_id" />
          </div>
        )}
        {!editing && locations.length > 1 && (
          <Field label="Dispatch from">
            <select required value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          </Field>
        )}
        {!editing && (
          <Field label="Salesperson" hint={customer?.beat_name ? `Beat: ${customer.beat_name} (${customer.route_name}).` : "Customers on a beat get its route and salesperson."}>
            <select value={form.salespersonId} onChange={set("salespersonId")}>
              <option value="">{customer?.salesperson_name ? `${customer.salesperson_name} (from the beat)` : "None"}</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {shown && (
          <div className="field-wide bz-customer-card" aria-label="Customer">
            {acct && <div className={Number(acct.balance) > 0 ? "is-danger" : ""}><small>{Number(acct.balance) < 0 ? "Advance" : "Owes"}</small><strong>{biz.exact(Math.abs(Number(acct.balance)))}</strong></div>}
            {acct && <div className={Number(acct.overdue) > 0 ? "is-danger" : ""}><small>Overdue</small><strong>{Number(acct.overdue) > 0 ? `${biz.exact(acct.overdue)} · ${acct.most_days_overdue} d` : "Nothing"}</strong></div>}
            {acct && acct.oldest_bill && <div><small>Oldest unpaid bill</small><strong>{dateShort(acct.oldest_bill)}</strong></div>}
            {creditLeft !== null && <div className={creditLeft < estimate ? "is-danger" : ""}><small>Credit left</small><strong>{biz.exact(creditLeft)}</strong></div>}
            <div><small>Last order</small><strong>{shown.last_order ? `${dateShort(shown.last_order.created_at)} · ${money(shown.last_order.total, biz.symbol)}` : "None yet"}</strong></div>
            <div className="bz-customer-card-actions">
              {shown.hold?.held && <Badge tone="danger" label={shown.hold.reason === "bounced_cheques" ? `On credit hold · ${shown.hold.bounces} cheques bounced` : `On credit hold · ${shown.hold.days} days overdue`} />}
              {!editing && shown.last_order?.lines?.length > 0 && <button type="button" className="chip-button" onClick={repeatLast}><Icon name="refresh" size={13} /> Repeat last order</button>}
              {acct && <button type="button" className="chip-button" onClick={() => setAccount(true)}>Account</button>}
            </div>
          </div>
        )}
        <div className="field-wide bz-lines">
          <div className="bz-line-add">
            <SearchPicker aria-label="Add item" options={items} onChange={addItem} clearOnSelect placeholder="Add an item — name, code or barcode, then Enter"
              getKey={(s) => s.id} getLabel={(s) => s.label} getKeywords={(s) => `${s.code} ${s.barcode || ""} ${s.product_name || ""}`}
              getDescription={(s) => [s.code, packOf(s) && `${packOf(s).unit} of ${packOf(s).factor}`, money(s.price, biz.symbol), biz.can("inventory.view") && `${count(available(s))} in stock`].filter(Boolean).join(" · ")} />
            <span className="muted small">{lines.length} lines</span>
          </div>
          <DataGrid variant="editor" caption="Order lines" rows={lines} rowKey={(l) => l.key} columns={columns} currency={biz.symbol} empty="Search above to add items" />
          <div className="bz-lines-foot">
            <span className="muted small">Estimate at list price {biz.exact(estimate)} — group, slab and scheme prices are applied by the server.</span>
          </div>
        </div>
        {hold && (
          <div className="field-wide bz-note-card is-warning" role="group" aria-label="Let it through">
            <strong>Let it through: {hold.holdReason === "bounced_cheques" ? `${hold.bounces} cheques bounced in the last ${hold.bounceDays} days.` : `${biz.exact(hold.overdue)} is ${hold.days} days overdue (limit ${hold.limitDays} days).`}</strong>
            {!biz.can("receivables.approve") && (
              <>
                <label className="field"><span>Manager</span>
                  <select required value={release.approverId} onChange={(e) => setRelease((r) => ({ ...r, approverId: e.target.value }))}>
                    <option value="">Choose…</option>
                    {(releasers || []).map((p) => <option key={p.id} value={p.id} disabled={!p.has_pin}>{p.name}{p.has_pin ? "" : " (no PIN set)"}</option>)}
                  </select>
                </label>
                <label className="field"><span>Their PIN</span><input type="password" inputMode="numeric" autoComplete="off" required minLength={4} maxLength={8} value={release.pin} onChange={(e) => setRelease((r) => ({ ...r, pin: e.target.value }))} /></label>
              </>
            )}
            <label className="field" style={{ flex: "1 1 16rem" }}><span>Reason</span><input required maxLength={300} value={release.reason} onChange={(e) => setRelease((r) => ({ ...r, reason: e.target.value }))} placeholder="e.g. Cheque promised for Friday" /></label>
          </div>
        )}
        <Field label="Wanted by (optional)"><input type="date" value={form.expectedOn || ""} onChange={set("expectedOn")} /></Field>
        <Field label="Notes (optional)"><input maxLength={500} value={form.notes || ""} onChange={set("notes")} placeholder="e.g. Deliver before 10 am" /></Field>
        {editing && <Field label="Why it changed" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Shop phoned: 2 cases only" /></Field>}
      </FormDialog>
      {account && form.contactId && <AccountDialog contactId={Number(form.contactId)} onClose={() => setAccount(false)} />}
    </>
  );
}

function OrderDetail({ orderId, startDispatch, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null);
  const [version, setVersion] = useState(0);
  const started = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `sales-orders/${orderId}`, undefined, controller.signal)
      .then((o) => { setOrder(o); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, orderId, version]);
  const live = order && ["open", "part_dispatched"].includes(order.status);
  useEffect(() => {
    if (startDispatch && live && !started.current) { started.current = true; setAction({ kind: "dispatch" }); }
  }, [startDispatch, live]);
  const changed = (message) => { setAction(null); setVersion((n) => n + 1); if (message) toast.success(message); onChanged(); };
  const printInvoice = async (documentId) => {
    try { printTaxInvoice(await businessRead(biz.id, `documents/${documentId}`), biz); } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const labelOf = (lineId) => order.lines.find((l) => l.id === lineId)?.label || "Item";
  return (
    <>
      <Modal title={order ? `Order ${order.order_no}` : "Loading…"} icon="clipboard" width={1000} onClose={() => { if (!action) onClose(); }}
        description={order ? `${order.contact_name} · from ${order.location_name} · taken ${dateTime(order.created_at)} by ${order.created_by_name}` : undefined}>
        <ErrorMessage message={error} />
        {!order && !error && <Loading />}
        {order && (
          <div className="stack bz-detail">
            <div className="bz-inline">
              <OrderBadge status={order.status} />
              {order.salesperson_name && <span className="bz-chip"><Icon name="user" size={13} /> {order.salesperson_name}</span>}
              {order.route_name && <span className="bz-chip"><Icon name="map-pin" size={13} /> {order.route_name}{order.beat_name ? ` · ${order.beat_name}` : ""}</span>}
              {biz.can("receivables.view") && <button type="button" className="chip-button" onClick={() => setAction({ kind: "account" })}><Icon name="wallet" size={13} /> Customer account</button>}
              {order.expected_on && <span className="muted small">Wanted by {dateShort(order.expected_on)}</span>}
              {order.closed_at && <span className="muted small">{order.status === "cancelled" ? "Cancelled" : "Closed"} {dateTime(order.closed_at)} — {order.close_reason}</span>}
            </div>
            {order.hold_releases.map((h) => (
              <p key={h.id} className="bz-note-card is-warning small">Credit hold released by {h.released_by_name} ({dateTime(h.created_at)}): {biz.exact(h.overdue)} was {h.overdue_days} days overdue. Reason: {h.reason}</p>
            ))}
            <DataGrid variant="compact" id="wholesale-order-lines" caption="Order lines" rows={order.lines} currency={biz.symbol} rowNoun={["line", "lines"]}
              rowClassName={(l) => (l.removed_by_edit ? "dg-tone-muted" : Number(l.remaining) > 0 && live && Number(l.available) < Number(l.remaining) ? "dg-tone-warning" : "")} columns={[
                { key: "label", header: "Item", mobile: "title", render: (l) => (
                  <span className="bz-two-line"><span>{l.removed_by_edit ? <s>{l.label}</s> : l.label}</span>
                    {(l.scheme_name || Number(l.discount_percent) > 0 || l.removed_by_edit) && <small className="muted">{[l.removed_by_edit && "taken off in an edit", !l.free_of_line_id && Number(l.discount_percent) > 0 && `${Number(l.discount_percent)}% off`, l.scheme_name].filter(Boolean).join(" · ")}</small>}
                  </span>
                ) },
                { key: "ordered", header: "Ordered", value: (l) => Number(l.quantity), render: (l) => packText(l.entered_quantity, l.entered_unit, l.quantity, l.unit) },
                { key: "rate", header: "Rate", type: "money", exact: true, value: (l) => Number(l.entered_unit_price || l.unit_price),
                  render: (l) => (l.free_of_line_id ? <Badge tone="info" label="Free" /> : `${biz.exact(l.entered_unit_price || l.unit_price)} / ${l.entered_unit || l.unit}`) },
                { key: "dispatched", header: "Sent", type: "number", value: (l) => Number(l.dispatched_quantity), render: (l) => inPacks(l.dispatched_quantity, l.unit, l.entered_unit, l.unit_factor) },
                { key: "remaining", header: "Still to send", type: "number", value: (l) => Number(l.remaining), render: (l) => (Number(l.remaining) ? inPacks(l.remaining, l.unit, l.entered_unit, l.unit_factor) : <span className="muted">—</span>), mobile: "show" },
                live && { key: "available", header: "In stock", type: "number", value: (l) => Number(l.available), render: (l) => quantity(l.available, l.unit), mobile: "show" },
                { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => Number(l.net) + Number(l.tax), total: "sum" },
                live && biz.can("sales_orders.cancel") && { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => (Number(l.remaining) > 0 && !l.free_of_line_id
                  ? <button type="button" className="chip-button" onClick={() => setAction({ kind: "closeLine", line: l })}>Drop rest</button> : null) },
              ].filter(Boolean)} />
            <div className="bz-totals">
              <span>Before tax <strong>{biz.exact(order.subtotal)}</strong></span>
              <span>Tax <strong>{biz.exact(order.tax)}</strong></span>
              <span>Order value <strong>{biz.exact(order.total)}</strong></span>
            </div>
            {order.dispatches.length > 0 && (
              <SectionCard icon="truck" title="Dispatches">
                <ul className="bz-history">
                  {order.dispatches.map((d) => (
                    <li key={d.id}>
                      <Badge tone={DELIVERY[d.delivery_status]?.tone} label={DELIVERY[d.delivery_status]?.label || d.delivery_status} /> Invoice <span className="mono">{d.document_no}</span> · {biz.exact(d.total)} · {dateTime(d.created_at)} by {d.created_by_name}
                      {[d.vehicle_no && `vehicle ${d.vehicle_no}`, d.driver_name && `driver ${d.driver_name}`, d.eway_bill_no && `e-way ${d.eway_bill_no}`, d.return_no && `returned ${d.return_no}`, d.received_by && `received by ${d.received_by}`].filter(Boolean).map((x) => ` · ${x}`).join("")}
                      <br /><small className="muted">{d.lines.map((x) => `${labelOf(x.order_line_id)} ${Number(x.entered_quantity || x.quantity)} ${x.entered_unit || order.lines.find((l) => l.id === x.order_line_id)?.unit || ""}${x.lot_code ? ` (batch ${x.lot_code}${x.expires_on ? `, exp ${dateShort(x.expires_on, { year: true })}` : ""})` : ""}`).join("; ")}</small>
                      <div className="row-actions" style={{ marginTop: 4 }}>
                        {biz.can("sales.print") && <button type="button" className="chip-button" onClick={() => printInvoice(d.document_id)}><Icon name="print" size={13} /> Invoice</button>}
                        <button type="button" className="chip-button" onClick={() => setAction({ kind: "challan", dispatch: { ...d, contact_name: order.contact_name } })}><Icon name="print" size={13} /> Challan{d.challan_no ? ` ${d.challan_no}` : ""}</button>
                        {biz.can("sales_orders.approve") && <button type="button" className="chip-button" onClick={() => setAction({ kind: "transport", dispatch: { ...d, contact_name: order.contact_name } })}>Transport / e-way bill</button>}
                        {biz.can("sales_orders.approve") && d.delivery_status === "out_for_delivery" && <button type="button" className="chip-button" onClick={() => setAction({ kind: "delivery", dispatch: { ...d, contact_name: order.contact_name } })}>Mark delivered / returned</button>}
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}
            {order.edits.length > 0 && (
              <p className="muted small"><Icon name="edit" size={13} /> Changed: {order.edits.map((e) => `${dateTime(e.created_at)} by ${e.created_by_name} — ${e.reason} (${biz.exact(e.total_before)} → ${biz.exact(e.total_after)})`).join("; ")}</p>
            )}
            {order.notes && <p className="muted">{order.notes}</p>}
            <div className="form-actions bz-start">
              {live && biz.can("sales_orders.approve") && <button type="button" className="button" onClick={() => setAction({ kind: "dispatch" })}><Icon name="truck" size={16} /> Dispatch</button>}
              {live && biz.can("sales_orders.create") && <button type="button" className="button button-secondary" onClick={() => setAction({ kind: "edit" })}><Icon name="edit" size={15} /> Change order</button>}
              {live && biz.can("sales_orders.cancel") && <button type="button" className="button button-secondary" onClick={() => setAction({ kind: "close" })}>{order.status === "open" ? "Cancel order" : "Close the back-order"}</button>}
              {biz.can("sales_orders.print") && <button type="button" className="button button-secondary" onClick={() => printOrder(order, biz)}><Icon name="print" size={15} /> Print order</button>}
            </div>
          </div>
        )}
      </Modal>
      {action?.kind === "dispatch" && order && <DispatchDialog order={order} onClose={() => setAction(null)}
        onSaved={(r) => changed(`Dispatched on invoice ${r.document.document_no}${r.status === "part_dispatched" ? "; the rest is a back-order" : "; the order is complete"}`)} />}
      {action?.kind === "edit" && order && <OrderDialog order={order} onClose={() => setAction(null)} onSaved={() => changed(`${order.order_no} changed`)} />}
      {action?.kind === "account" && order && <AccountDialog contactId={order.contact_id} onClose={() => setAction(null)} />}
      {action?.kind === "transport" && <TransportDialog dispatch={action.dispatch} onClose={() => setAction(null)} onSaved={() => changed("")} />}
      {action?.kind === "challan" && <ChallanDialog dispatch={action.dispatch} onClose={() => setAction(null)} onSaved={() => changed("")} />}
      {action?.kind === "delivery" && <DeliveryDialog dispatch={action.dispatch} onClose={() => setAction(null)} onSaved={() => changed("")} />}
      {action?.kind === "closeLine" && order && (
        <ReasonDialog title={`Drop the rest of ${action.line.label}`} submitLabel="Drop it"
          description={`${inPacks(action.line.remaining, action.line.unit, action.line.entered_unit, action.line.unit_factor)} will not be sent. The rest of the order stays.`}
          onClose={() => setAction(null)} onSubmit={(reason) => businessWrite(biz.id, `sales-orders/${order.id}/lines/${action.line.id}/close`, { reason })}
          onSaved={() => changed(`${action.line.label}: the rest is dropped`)} />
      )}
      {action?.kind === "close" && order && (
        <ReasonDialog title={order.status === "open" ? `Cancel ${order.order_no}` : `Close what is left of ${order.order_no}`} submitLabel={order.status === "open" ? "Cancel order" : "Close back-order"}
          description={order.status === "open" ? "Nothing has been sent on this order." : "Invoices already raised stay as they are; only what was not sent is dropped."}
          onClose={() => setAction(null)} onSubmit={(reason) => businessWrite(biz.id, `sales-orders/${order.id}/close`, { reason })}
          onSaved={(o) => changed(`${o.order_no} ${o.status === "cancelled" ? "cancelled" : "closed short"}`)} />
      )}
    </>
  );
}

function DispatchDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const open = order.lines.filter((l) => Number(l.remaining) > 0);
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    businessRead(biz.id, `sales-orders/customer-summary/${order.contact_id}`).then(setSummary).catch(() => {});
  }, [biz.id, order.contact_id]);
  // Start each line at what can go now: the remainder, or what is in stock (whole packs when ordered in packs).
  const start = (l) => {
    const can = Math.min(Number(l.remaining), Number(l.available));
    if (l.entered_unit) {
      const packs = Math.floor(can / Number(l.unit_factor) + 1e-9);
      if (packs * Number(l.unit_factor) === Number(l.remaining) || packs > 0) return { unit: l.entered_unit, quantity: String(packs) };
    }
    return { unit: l.unit, quantity: String(Math.max(0, can)) };
  };
  const [lines, setLines] = useState(() => open.map((l) => ({ id: l.id, ...start(l) })));
  const [form, setForm] = useState(() => ({ ...emptyTransport(), ewayBillDate: businessToday(biz.business.timezone), notes: "" }));
  const [showTransport, setShowTransport] = useState(false);
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const setLine = (lineId, name, value) => setLines((all) => all.map((x) => (x.id === lineId ? { ...x, [name]: value } : x)));
  const value = lines.reduce((s, x) => {
    const l = open.find((o) => o.id === x.id);
    const units = Number(x.quantity || 0) * (x.unit !== l.unit ? Number(l.unit_factor) : 1);
    return s + ((Number(l.net) + Number(l.tax)) * units) / Number(l.quantity);
  }, 0);
  const submit = () => businessWrite(biz.id, `sales-orders/${order.id}/dispatch`, {
    requestKey, ...transportBody({ ...form, ...(form.ewayBillNo ? {} : { ewayBillDate: "" }) }),
    lines: lines.filter((x) => Number(x.quantity) > 0).map((x) => {
      const l = open.find((o) => o.id === x.id);
      return { orderLineId: x.id, quantity: x.quantity, ...(x.unit !== l.unit ? { unit: x.unit } : {}) };
    }),
  });
  const acct = summary?.account;
  return (
    <FormDialog title={`Dispatch ${order.order_no}`} icon="truck" width={960} submitLabel="Dispatch and invoice" onSubmit={submit} onClose={onClose} onSaved={onSaved}
      description="Stock leaves now, oldest expiry first (expired batches are never sent), and a tax invoice is raised at the order's prices. Set a line to 0 to leave it for later.">
      {(summary?.hold?.held || Number(acct?.overdue) > 0) && (
        <div className={`field-wide bz-note-card ${summary?.hold?.held ? "is-danger" : "is-warning"}`}>
          <Icon name="alert" size={15} /> {order.contact_name} {summary?.hold?.held ? (summary.hold.reason === "bounced_cheques" ? `is on credit hold: ${summary.hold.bounces} cheques bounced in ${summary.hold.bounceDays} days.` : `is on credit hold: ${biz.exact(summary.hold.overdue)} is ${summary.hold.days} days overdue.`) : `has ${biz.exact(acct.overdue)} overdue (${acct.most_days_overdue} days).`} Collect on delivery if you can.
        </div>
      )}
      <div className="field-wide bz-lines">
        <DataGrid variant="editor" caption="Lines to send" rows={open} rowKey={(l) => l.id} currency={biz.symbol} columns={[
          { key: "label", header: "Item", value: (l) => l.label, render: (l) => (l.free_of_line_id ? <span>{l.label} <Badge tone="info" label="Free" /></span> : l.label) },
          { key: "remaining", header: "Still to send", value: (l) => Number(l.remaining), render: (l) => inPacks(l.remaining, l.unit, l.entered_unit, l.unit_factor) },
          { key: "available", header: "In stock", value: (l) => Number(l.available), render: (l) => <span className={Number(l.available) < Number(l.remaining) ? "bz-due" : ""}>{quantity(l.available, l.unit)}</span> },
          { key: "send", header: "Send now", render: (l, ctx) => {
            const x = lines.find((y) => y.id === l.id);
            return <input aria-label={ctx.label} type="number" min="0" step="0.001" value={x.quantity} onChange={(e) => setLine(l.id, "quantity", e.target.value)} />;
          } },
          { key: "unit", header: "In", render: (l, ctx) => {
            const x = lines.find((y) => y.id === l.id);
            return (
              <select aria-label={ctx.label} value={x.unit} onChange={(e) => setLine(l.id, "unit", e.target.value)}>
                <option value={l.unit}>{l.unit}</option>
                {l.entered_unit && <option value={l.entered_unit}>{l.entered_unit} of {Number(l.unit_factor)}</option>}
              </select>
            );
          } },
        ]} />
        <div className="bz-lines-foot"><span className="muted small">Invoice about {biz.exact(value)}{value > 50000 ? " — over ₹50,000: an e-way bill is needed before the goods move." : ""}</span></div>
      </div>
      <div className="field-wide">
        <button type="button" className="link-button" aria-expanded={showTransport || value > 50000} onClick={() => setShowTransport((v) => !v)}>
          <Icon name={showTransport || value > 50000 ? "chevron-up" : "chevron-down"} size={14} /> Vehicle, driver and e-way bill
        </button>
      </div>
      {(showTransport || value > 50000) ? <TransportFields form={form} set={set} /> : <TransportFields form={form} set={set} eway={false} compact />}
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function printOrder(order, biz) {
  const rows = order.lines.filter((l) => !l.removed_by_edit).map((l, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(l.label)}${Number(l.discount_percent) > 0 && !l.free_of_line_id ? ` <small>(${Number(l.discount_percent)}% off)</small>` : ""}</td><td class="r">${escapeHtml(packText(l.entered_quantity, l.entered_unit, l.quantity, l.unit))}</td>
    <td class="r">${l.free_of_line_id ? "Free" : escapeHtml(biz.exact(l.entered_unit_price || l.unit_price))}</td><td class="r">${escapeHtml(inPacks(l.remaining, l.unit, l.entered_unit, l.unit_factor))}</td>
    <td class="r">${escapeHtml(biz.exact(Number(l.net) + Number(l.tax)))}</td></tr>`).join("");
  printDocument({
    title: order.order_no,
    styles: "body{font:13px system-ui;color:#111} h1{font-size:18px;margin:0} table{width:100%;border-collapse:collapse;margin-top:12px} td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left} .r{text-align:right}",
    body: `<h1>${escapeHtml(biz.settings.display_name || biz.business.name)}</h1>
      <p><strong>Sales order ${escapeHtml(order.order_no)}</strong> · ${escapeHtml(dateShort(order.created_at, { year: true }))}<br>
      ${escapeHtml(order.contact_name)}${order.route_name ? ` · ${escapeHtml(order.route_name)}` : ""}${order.salesperson_name ? ` · ${escapeHtml(order.salesperson_name)}` : ""}</p>
      <table><thead><tr><th>#</th><th>Item</th><th class="r">Ordered</th><th class="r">Rate</th><th class="r">Still to send</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="text-align:right"><strong>Order value ${escapeHtml(biz.exact(order.total))}</strong></p>
      <p><small>Not a tax invoice. Each dispatch has its own invoice.</small></p>`,
  });
}
