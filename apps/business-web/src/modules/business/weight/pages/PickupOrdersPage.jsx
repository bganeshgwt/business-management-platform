import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateShort, timeOnly } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { Segmented } from "../../wholesale/pages/shared";
import { whatsappLink } from "../../retail/pages/retail";
import { ClientPicker } from "../../salon/pages/salonParts";
import { zonedInstant } from "../../salon/pages/salon";
import ManagerApproval from "../../salon/pages/ManagerApproval";
import { approvalFor, emptyApproval } from "../../salon/pages/approval";
import useAuth from "../../../../hooks/useAuth";
import { orderEstimate } from "./pickupMoney";

// Orders taken on the phone or WhatsApp for pickup: "2 kg
// boneless for 6 pm, Hotel Annapurna". Today's list in pickup order; mark it
// Ready (prints a packing slip, tells the customer), then Bill opens Quick
// bill with the order's items to weigh, and the bill closes the order. A
// saved customer's order may take an advance (when it is taken or later): a
// receipt in their name, taken off the order's bill at Quick bill. What is
// left of it once the order is cancelled goes back with a manager's PIN.
const ADVANCE_KINDS = ["cash", "upi", "card", "bank"];
const REFUND_KINDS = ["cash", "upi", "bank"];
const VIEWS = [{ value: "open", label: "To do" }, { value: "all", label: "Everything" }];
const STATUS = { open: { tone: "info", label: "To pack" }, ready: { tone: "success", label: "Ready" }, collected: { tone: "neutral", label: "Collected" }, cancelled: { tone: "neutral", label: "Cancelled" } };
const itemsText = (o, biz) => o.lines.map((l) => `${l.quantity ? `${Number(l.quantity)} ${l.unit}` : `${biz.exact(l.amount)} of`} ${l.label}${l.note ? ` (${l.note})` : ""}`).join(" · ");

export default function PickupOrdersPage() {
  const biz = useOpenBusiness();
  const tz = biz.business.timezone;
  const [view, setView] = useState("open");
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  const can = biz.can("sales.create");
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Orders for pickup" description={`Phone and WhatsApp orders, in pickup order. Ready prints a packing slip; Bill weighs it at Quick bill. Today is ${dateShort(businessToday(tz))}.`}
        primary={can && <button type="button" className="button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New order</button>} />
      <Segmented label="Show" value={view} options={VIEWS} onChange={setView} />
      <Orders key={`${view}-${version}`} view={view} />
      {creating && <NewOrderDialog onClose={() => setCreating(false)} onSaved={(o) => { setCreating(false); toast.success(`Order for ${o.customer_name} saved for ${timeOnly(o.pickup_at)}.`); setVersion((n) => n + 1); }} />}
    </div>
  );
}

// One list per view (the "everything" view has a date range, "to do" does not).
function Orders({ view }) {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [cancelling, setCancelling] = useState(null);
  const [advancing, setAdvancing] = useState(null);
  const [handingBack, setHandingBack] = useState(null);
  const list = useServerList("weight/pickup-orders", { gridId: "weight-pickup-orders", period: view === "all" ? "ahead" : false, params: view === "open" ? { active: "true" } : {} });
  const can = biz.can("sales.create");
  const takesMoney = biz.can("sales.edit");
  const status = async (o, next) => {
    try {
      await businessWrite(biz.id, `weight/pickup-orders/${o.id}/status`, { status: next });
      if (next === "ready") {
        printSlip(o, biz);
        toast.success(`${o.customer_name}'s order is ready.`, o.phone ? { action: { label: "Tell them", onClick: () => window.open(whatsappLink(o.phone, readyText(o, biz)), "_blank", "noopener") } } : undefined);
      }
      list.reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const columns = useMemo(() => [
    { key: "pickup_at", header: "Pickup", type: "datetime", value: (o) => o.pickup_at, mobile: "subtitle",
      render: (o) => <span>{o.today ? timeOnly(o.pickup_at) : `${dateShort(o.pickup_at)}, ${timeOnly(o.pickup_at)}`}{o.late && <Badge tone="warning" label="Late" />}</span> },
    { key: "customer_name", header: "Customer", value: (o) => o.customer_name, mobile: "title", pin: true,
      render: (o) => <span>{o.customer_name}{o.phone && <small className="muted" style={{ display: "block" }}>{o.phone}</small>}</span> },
    { key: "items", header: "Items", value: (o) => itemsText(o, biz), mobile: "show" },
    { key: "notes", header: "Notes", value: (o) => o.notes || "", defaultHidden: true },
    { key: "status", header: "Status", type: "status", value: (o) => o.status, mobile: "show",
      render: (o) => <Badge tone={STATUS[o.status].tone} label={`${STATUS[o.status].label}${o.document_no ? ` · ${o.document_no}` : ""}`} /> },
    // The advance taken, and once the order is closed, what is left of it to hand back.
    { key: "advance", header: "Advance", type: "money", exact: true, value: (o) => (o.advance === null ? null : Number(o.advance)), mobile: "show",
      render: (o) => (o.advance === null ? <span className="muted">—</span> : (
        <span>{biz.exact(o.advance)}{o.advance_to_hand_back && <small className="muted" style={{ display: "block" }}>{biz.exact(o.advance_left)} to hand back</small>}</span>
      )) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => (["open", "ready"].includes(o.status) && can ? (
      <div className="row-actions">
        {o.status === "open" && <button type="button" className="chip-button" onClick={() => status(o, "ready")}>Ready</button>}
        <button type="button" className="chip-button" onClick={() => navigate(`${businessPath(biz.id, "counter")}?pickup=${o.id}`)}>Bill</button>
        <ActionMenu label={`More for ${o.customer_name}'s order`} items={[
          { label: "Print packing slip", icon: "print", onClick: () => printSlip(o, biz) },
          o.phone && { label: "WhatsApp: ready", icon: "message", onClick: () => window.open(whatsappLink(o.phone, readyText(o, biz)), "_blank", "noopener") },
          takesMoney && o.contact_id && o.advance === null && { label: "Take an advance", icon: "wallet", onClick: () => setAdvancing(o) },
          o.status === "ready" && { label: "Back to packing", icon: "undo", onClick: () => status(o, "open") },
          { separator: true },
          { label: "Cancel the order", icon: "x", danger: true, onClick: () => setCancelling(o) },
        ].filter(Boolean)} />
      </div>
    ) : o.advance_to_hand_back && takesMoney ? (
      <div className="row-actions">
        <button type="button" className="chip-button" onClick={() => setHandingBack(o)}>Hand back the advance</button>
      </div>
    ) : null) },
  ], [biz, can, navigate, takesMoney]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="clipboard" title={view === "open" ? "To pack and hand over" : "Orders"}>
        <DataGrid {...list.gridProps} caption="Orders for pickup" columns={columns} currency={biz.symbol} rowNoun={["order", "orders"]}
          rowClassName={(o) => (o.late ? "dg-tone-warning" : o.status === "cancelled" || o.status === "collected" ? "dg-tone-muted" : "")}
          empty={view === "open" ? "No orders waiting" : "No orders in these dates"} emptyHint="Take one with New order when a customer calls." emptyIcon="clipboard" />
      </SectionCard>
      {cancelling && (
        <ReasonDialog title={`Cancel ${cancelling.customer_name}'s order?`} submitLabel="Cancel the order"
          description={cancelling.advance === null ? "Nothing has been billed for it."
            : `Nothing has been billed for it. Its advance of ${biz.exact(cancelling.advance)} stays ${cancelling.customer_name}'s: hand it back with a manager's PIN, or keep it on their account.`}
          onSubmit={(reason) => businessWrite(biz.id, `weight/pickup-orders/${cancelling.id}/status`, { status: "cancelled", reason })}
          onClose={() => setCancelling(null)} onSaved={() => { setCancelling(null); list.reload(); }} />
      )}
      {advancing && <AdvanceDialog order={advancing} onClose={() => setAdvancing(null)}
        onSaved={() => { toast.success(`Advance taken on ${advancing.customer_name}'s order.`); setAdvancing(null); list.reload(); }} />}
      {handingBack && <HandBackDialog order={handingBack} onClose={() => setHandingBack(null)}
        onSaved={(refund) => { toast.success(`${biz.exact(refund.amount)} handed back to ${handingBack.customer_name} (${refund.refund_no}).`); setHandingBack(null); list.reload(); }} />}
    </>
  );
}

// An advance on an order already taken: a receipt in its customer's name.
function AdvanceDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: "", method: "upi", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Advance on ${order.customer_name}'s order`} icon="wallet" width={520} submitLabel="Take the advance" onClose={onClose} onSaved={onSaved}
      description="A receipt in the customer's name, taken off the order's bill when it is picked up."
      onSubmit={() => businessWrite(biz.id, `weight/pickup-orders/${order.id}/advance`, { amount: form.amount, ...methods.body(form.method, ADVANCE_KINDS),
        reference: form.reference.trim() || null, requestKey })}>
      <Field label={`Advance (${biz.symbol})`}><input required type="number" min="1" step="0.01" inputMode="decimal" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by"><select value={methods.resolve(form.method, ADVANCE_KINDS)} onChange={set("method")}>{methods.options(ADVANCE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="Reference (optional)" wide><input maxLength={100} value={form.reference} onChange={set("reference")} placeholder="e.g. UPI ref" /></Field>
    </FormDialog>
  );
}

// What is left of a closed order's advance, handed back with a manager's PIN.
function HandBackDialog({ order, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const left = Number(order.advance_left || 0);
  const [form, setForm] = useState({ amount: left.toFixed(2), method: "cash", reference: "" });
  const [approval, setApproval] = useState(emptyApproval);
  const kind = methods.kindOf(form.method, REFUND_KINDS);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Hand back ${order.customer_name}'s advance`} icon="wallet" width={600} submitLabel="Hand it back" onClose={onClose} onSaved={onSaved}
      description={`${biz.exact(left)} is left of the advance ${order.advance_no}.`}
      onSubmit={() => businessWrite(biz.id, `weight/pickup-orders/${order.id}/advance-refund`, { amount: form.amount, ...methods.body(form.method, REFUND_KINDS),
        reference: form.reference.trim() || null, requestKey, ...approvalFor(approval, user?.id) })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={left} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid back by"><select value={methods.resolve(form.method, REFUND_KINDS)} onChange={set("method")}>{methods.options(REFUND_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      {kind !== "cash" && <Field label="Reference" wide><input required maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
      <ManagerApproval permission="sales.refund" value={approval} onChange={setApproval} reasonLabel="Reason" reasonPlaceholder="e.g. Order cancelled" />
    </FormDialog>
  );
}

const readyText = (o, biz) => `Namaste ${o.customer_name.split(" ")[0]}, your order (${itemsText(o, biz)}) is ready for pickup at ${biz.business.name}.`;

// The packing slip: who, when, what, and the advance paid (it comes off the bill at pickup).
function printSlip(o, biz) {
  const advance = o.advance === null || o.advance === undefined ? ""
    : `<p class="advance"><strong>Advance paid ${escapeHtml(biz.exact(o.advance))}</strong> (${escapeHtml(o.advance_no || "")}) · comes off the bill</p>`;
  const body = `<div class="slip"><h1>${escapeHtml(o.customer_name)}</h1><p>${escapeHtml(o.phone || "")} · pickup ${escapeHtml(dateShort(o.pickup_at))} ${escapeHtml(timeOnly(o.pickup_at))}</p>
    <ul>${o.lines.map((l) => `<li><strong>${escapeHtml(l.quantity ? `${Number(l.quantity)} ${l.unit}` : `${biz.exact(l.amount)} of`)}</strong> ${escapeHtml(l.label)}${l.note ? ` — ${escapeHtml(l.note)}` : ""}</li>`).join("")}</ul>
    ${advance}${o.notes ? `<p>${escapeHtml(o.notes)}</p>` : ""}<p class="small">Order #${o.id} · ${escapeHtml(biz.business.name)}</p></div>`;
  printDocument({ title: `Packing slip ${o.customer_name}`, body, styles: `@page { size: 80mm auto; margin: 4mm; } .slip { font: 13px/1.4 system-ui, sans-serif; color: #000; width: 72mm; }
    .slip h1 { font-size: 18px; margin: 0; } .slip ul { padding-left: 16px; } .slip .small { font-size: 11px; }` });
}

function NewOrderDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const tz = biz.business.timezone;
  const { options, error } = useOptions(["catalog?active=true&kind=goods", "contacts?kind=customer&active=true"]);
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [extra, setExtra] = useState([]);
  const [contact, setContact] = useState(null);
  const [form, setForm] = useState({ name: "", phone: "", date: businessToday(tz), time: "18:00", notes: "", locationId: String(locations[0]?.id || ""),
    advance: "", method: "upi", reference: "" });
  const [lines, setLines] = useState([]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const items = options?.["catalog?active=true&kind=goods"] || [];
  const clients = [...extra, ...(options?.["contacts?kind=customer&active=true"] || [])];
  // An advance: in a saved customer's name, by someone who takes payments, up to the order's value.
  const methods = usePaymentMethods();
  const takesMoney = biz.can("sales.edit");
  const estimate = orderEstimate(lines, biz.settings.tax_mode);
  const advance = contact && takesMoney && Number(form.advance) > 0
    ? { amount: form.advance, ...methods.body(form.method, ADVANCE_KINDS), reference: form.reference.trim() || null } : null;
  const setLine = (key, changes) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...changes } : l)));
  const columns = [
    { key: "label", header: "Item", value: (l) => l.label, mobile: "title" },
    { key: "quantity", header: "Weight", type: "number", width: 120, value: (l) => Number(l.quantity || 0),
      render: (l, ctx) => <input aria-label={ctx.label} type="number" min="0" step="0.001" inputMode="decimal" placeholder={l.unit} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value, amount: "" })} /> },
    { key: "amount", header: `or ${biz.symbol} worth`, type: "number", width: 120, value: (l) => Number(l.amount || 0),
      render: (l, ctx) => <input aria-label={ctx.label} type="number" min="0" step="1" inputMode="decimal" placeholder={biz.symbol} value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value, quantity: "" })} /> },
    { key: "note", header: "How", value: (l) => l.note,
      render: (l, ctx) => <input aria-label={ctx.label} maxLength={150} placeholder="curry cut, no skin" value={l.note} onChange={(e) => setLine(l.key, { note: e.target.value })} /> },
    { key: "remove", header: "", label: "Remove", type: "actions", width: 56, render: (l) => <button type="button" className="icon-button danger" aria-label="Remove" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}><Icon name="trash" size={16} /></button> },
  ];
  return (
    <FormDialog title="New order for pickup" icon="clipboard" width={760} submitLabel="Save the order" onClose={onClose} onSaved={onSaved} disabled={!options}
      onSubmit={() => businessWrite(biz.id, "weight/pickup-orders", {
        locationId: form.locationId, contactId: contact?.id || null, customerName: contact ? null : form.name, phone: form.phone || contact?.phone || null,
        pickupAt: zonedInstant(form.date, form.time, tz), notes: form.notes || null, requestKey,
        lines: lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity || null, amount: l.amount || null, note: l.note || null })),
        ...(advance ? { advance } : {}),
      })}>
      <FormError message={error} />
      <div className="field-wide"><ClientPicker value={contact} onChange={setContact} clients={clients} onCreated={(c) => setExtra((all) => [c, ...all])} label="Customer" walkIn placeholder="Name or phone" /></div>
      {!contact && <Field label="Name (if not a saved customer)"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>}
      <Field label="Phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} placeholder={contact?.phone || "For the ready message"} /></Field>
      <Field label="Pickup day"><input required type="date" min={businessToday(tz)} value={form.date} onChange={set("date")} /></Field>
      <Field label="Pickup time"><input required type="time" step="300" value={form.time} onChange={set("time")} /></Field>
      {locations.length > 1 && <Field label="Location"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <div className="field-wide sw-stack">
        <SearchPicker aria-label="Add an item" options={items} clearOnSelect getKey={(s) => s.id} getLabel={(s) => s.label}
          getDescription={(s) => `${biz.exact(s.price)} / ${s.unit}`} getKeywords={(s) => s.code || ""} placeholder="Add an item — name or code"
          onChange={(s) => s && setLines((all) => [...all, { key: newKey(), skuId: s.id, label: s.label, unit: s.unit, price: s.price, taxRate: s.tax_rate,
            quantity: "", amount: "", note: "" }])} />
        {lines.length > 0 && <DataGrid variant="editor" caption="Items in the order" columns={columns} rows={lines} rowKey={(l) => l.key} currency={biz.symbol} />}
      </div>
      <Field label="Notes" wide><input maxLength={300} value={form.notes} onChange={set("notes")} placeholder="e.g. Cut small for biryani" /></Field>
      {takesMoney && (contact ? (
        <>
          <Field label={`Advance (${biz.symbol}, optional)`} hint={estimate > 0 ? `Up to ${biz.exact(estimate)}, the order at today's rates. It comes off the bill at pickup.` : "It comes off the bill at pickup."}>
            <input type="number" min="0" max={estimate || undefined} step="0.01" inputMode="decimal" value={form.advance} onChange={set("advance")} />
          </Field>
          {Number(form.advance) > 0 && (
            <>
              <Field label="Advance paid by"><select value={methods.resolve(form.method, ADVANCE_KINDS)} onChange={set("method")}>{methods.options(ADVANCE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
              <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} placeholder="e.g. UPI ref" /></Field>
            </>
          )}
        </>
      ) : <p className="sw-note field-wide">An advance is taken in a saved customer's name: choose or add the customer to take one.</p>)}
    </FormDialog>
  );
}
