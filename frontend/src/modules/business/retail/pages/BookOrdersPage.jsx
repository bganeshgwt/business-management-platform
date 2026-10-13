import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import useConfirm from "../../../../hooks/useConfirm";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { newKey, quantity, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { whatsappLink } from "./retail";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
// A book-order advance: the business's own methods of these kinds (no cheques).
const ADVANCE_KINDS = ["cash", "upi", "card", "bank"];
import "../styles/business-retail.css";

// Booklists and customer orders (pro pass C-24), for bookshops.
//   School sets: a school's list for a class (books, notebooks, pens) under
//   one code. Scanning or typing the code at Quick bill puts the whole set on
//   the bill; lines can still be changed there.
//   Customer orders: a book the customer wants that is not on the shelf —
//   title, who and their phone, an advance kept on their account (a numbered
//   receipt), then Arrived (tell them on WhatsApp) and Collected.

const ORDER_STATES = {
  ordered: ["info", "Ordered"],
  arrived: ["warning", "Arrived — tell the customer"],
  collected: ["success", "Collected"],
  cancelled: ["neutral", "Cancelled"],
};

export default function BookOrdersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "sets" ? "sets" : "orders";
  return (
    <div className="stack">
      <BusinessHeader icon="book" title="Booklists & orders"
        description="School sets bill a whole booklist in one scan. Customer orders keep track of books asked for and not on the shelf." />
      <div className="segmented bz-tabs" role="tablist" aria-label="Booklists and orders">
        {[["orders", "Customer orders"], ["sets", "School sets"]].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`segment ${tab === key ? "is-active" : ""}`}
            onClick={() => setParams(key === "orders" ? {} : { tab: key }, { replace: true })}>{label}</button>
        ))}
      </div>
      {tab === "orders" ? <OrdersTab biz={biz} /> : <SetsTab biz={biz} />}
    </div>
  );
}

// --- Customer orders ----------------------------------------------------------------------

function OrdersTab({ biz }) {
  const confirm = useConfirm();
  const [status, setStatus] = useState("");
  const list = useServerList("books/orders", { gridId: "retail-book-orders", params: status ? { status } : {} });
  const [creating, setCreating] = useState(false);
  const canCreate = biz.can("sales.create");

  async function move(order, next) {
    if (next === "cancelled" && !(await confirm({
      title: `Cancel ${order.order_no}?`,
      message: Number(order.advance) > 0 ? `The advance of ${biz.exact(order.advance)} stays on ${order.customer_name}'s account as credit (receipt ${order.collection_no}); refund it from Udhaar collections if they want it back.` : "The order is closed. Nothing else changes.",
      confirmLabel: "Cancel the order", cancelLabel: "Keep it",
    }))) return;
    try {
      await businessWrite(biz.id, `books/orders/${order.id}/status`, { status: next });
      toast.success(`${order.order_no}: ${ORDER_STATES[next][1].split(" —")[0].toLowerCase()}`);
      list.reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  const columns = useMemo(() => [
    { key: "title", header: "Book", value: (o) => o.title, mobile: "title", pin: true,
      render: (o) => <span className="bz-two-line"><strong>{o.title}</strong><small className="muted">{[o.author, o.isbn, o.quantity > 1 ? `${o.quantity} copies` : null].filter(Boolean).join(" · ") || "—"}</small></span> },
    { key: "customer", header: "Customer", value: (o) => o.customer_name, mobile: "subtitle",
      render: (o) => <span className="bz-two-line"><span>{o.customer_name}</span><small className="muted">{o.phone || "No phone"}</small></span> },
    { key: "order_no", header: "Order", value: (o) => o.order_no, className: "mono", defaultHidden: true },
    { key: "created_at", header: "Taken", type: "date", value: (o) => o.created_at, render: (o) => dateShort(o.created_at) },
    { key: "promised_on", header: "Expected by", type: "date", value: (o) => o.promised_on || "", render: (o) => (o.promised_on ? dateShort(o.promised_on) : <span className="muted">—</span>) },
    { key: "advance", header: "Advance", type: "money", exact: true, value: (o) => Number(o.advance), total: "sum", mobile: "show",
      render: (o) => (Number(o.advance) > 0 ? <span className="bz-two-line"><span>{biz.exact(o.advance)}</span><small className="muted mono">{o.collection_no}</small></span> : <span className="muted">None</span>) },
    { key: "stock", header: "On the shelf", type: "number", value: (o) => (o.sku_id ? Number(o.stock) : null), defaultHidden: true,
      render: (o) => (o.sku_id ? quantity(o.stock, "") : <span className="muted">Not stocked</span>) },
    { key: "status", header: "Status", type: "status", value: (o) => ORDER_STATES[o.status]?.[1] || o.status, mobile: "show",
      render: (o) => <Badge tone={ORDER_STATES[o.status]?.[0]} label={ORDER_STATES[o.status]?.[1] || o.status} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", width: 290, render: (o) => (
      <span className="bz-inline">
        {o.status === "ordered" && canCreate && <button type="button" className="chip-button" onClick={() => move(o, "arrived")}>Arrived</button>}
        {o.status === "arrived" && o.phone && (
          <a className="chip-button" target="_blank" rel="noreferrer"
            href={whatsappLink(o.phone, `Namaste ${o.customer_name}, your book "${o.title}" has arrived at ${biz.business.name}. ${Number(o.advance) > 0 ? `Your advance of ${biz.exact(o.advance)} is kept for it. ` : ""}Please collect it at your convenience.`)}>
            <Icon name="message" size={13} /> WhatsApp
          </a>
        )}
        {o.status === "arrived" && canCreate && <button type="button" className="chip-button" onClick={() => move(o, "collected")}>Collected</button>}
        {["ordered", "arrived"].includes(o.status) && biz.can("sales.edit") && <button type="button" className="chip-button rt-danger" onClick={() => move(o, "cancelled")}>Cancel</button>}
      </span>
    ) },
    // move is recreated each render; the columns only need the business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [biz, canCreate]);

  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Customer orders"
        actions={canCreate && <button type="button" className="button button-sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New order</button>}>
        <DataGrid {...list.gridProps} caption="Customer orders" columns={columns} currency={biz.symbol} rowNoun={["order", "orders"]}
          rowClassName={(o) => (o.status === "arrived" ? "dg-tone-warning" : ["collected", "cancelled"].includes(o.status) ? "dg-tone-muted" : "")}
          toolbar={(
            <label className="field">
              <span>Show</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Every order</option>
                {Object.entries(ORDER_STATES).map(([key, [, label]]) => <option key={key} value={key}>{label.split(" —")[0]}</option>)}
              </select>
            </label>
          )}
          empty="No customer orders yet" emptyHint="Take one when a customer asks for a book that is not on the shelf." emptyIcon="orders" />
      </SectionCard>
      {creating && <OrderDialog onClose={() => setCreating(false)} onSaved={() => { setCreating(false); list.reload(); }} />}
    </>
  );
}

function OrderDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [customer, setCustomer] = useState(null);
  const [form, setForm] = useState({ customerName: "", phone: "", title: "", author: "", isbn: "", quantity: "1", promisedOn: "", advance: "", method: "cash", notes: "" });
  const methods = usePaymentMethods();
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const location = biz.locations.find((l) => l.active && l.sells_at_counter !== false) || biz.locations.find((l) => l.active);
  const canAdvance = biz.has("receivables") && biz.can("receivables.create");
  return (
    <FormDialog title="New customer order" icon="orders" width={640} onClose={onClose} onSaved={onSaved} submitLabel="Save order"
      successMessage={(o) => `${o.order_no} saved${Number(o.advance) > 0 ? ` with ${biz.exact(o.advance)} advance` : ""}`}
      description="A book the customer wants that is not on the shelf. An advance is kept on the customer's account and comes off their bill."
      onSubmit={() => businessWrite(biz.id, "books/orders", {
        requestKey, locationId: location?.id, title: form.title, author: form.author || undefined, isbn: form.isbn || undefined, quantity: form.quantity,
        promisedOn: form.promisedOn || undefined, notes: form.notes || undefined, phone: form.phone || undefined,
        ...(customer ? { contactId: customer.id } : { customerName: form.customerName }),
        ...(customer && canAdvance && Number(form.advance) > 0 ? { advance: form.advance, ...methods.body(form.method, ADVANCE_KINDS) } : {}),
      })}>
      <SearchPicker label="Customer (optional)" placeholder="Name or phone of a regular" value={customer} onChange={setCustomer}
        search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 8 }, signal).then((page) => page.items)}
        minChars={2} getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} hint="Pick a customer on file to take an advance." className="field-wide" />
      {!customer && <Field label="Customer name"><input required maxLength={150} value={form.customerName} onChange={set("customerName")} /></Field>}
      <Field label={customer ? "Phone (optional)" : "Phone"}><input maxLength={30} inputMode="tel" value={form.phone} onChange={set("phone")} placeholder={customer?.phone || ""} required={!customer} /></Field>
      <Field label="Book title" wide><input required maxLength={200} value={form.title} onChange={set("title")} /></Field>
      <Field label="Author (optional)"><input maxLength={200} value={form.author} onChange={set("author")} /></Field>
      <Field label="ISBN (optional)" hint="10 or 13 digits; checked."><input maxLength={17} inputMode="numeric" className="mono" value={form.isbn} onChange={set("isbn")} /></Field>
      <Field label="Copies"><input required type="number" min="1" max="1000" step="1" value={form.quantity} onChange={set("quantity")} /></Field>
      <Field label="Expected by (optional)"><input type="date" value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      {customer && canAdvance && (
        <>
          <Field label="Advance (optional)"><input type="number" min="0" step="0.01" value={form.advance} onChange={set("advance")} /></Field>
          {Number(form.advance) > 0 && (
            <Field label="Advance paid by">
              <select value={methods.resolve(form.method, ADVANCE_KINDS)} onChange={set("method")}>{methods.options(ADVANCE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
            </Field>
          )}
        </>
      )}
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// --- School sets ------------------------------------------------------------------------------

function SetsTab({ biz }) {
  const list = useServerList("books/sets", { gridId: "retail-book-sets" });
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  async function open(set) {
    try {
      setEditing(await businessRead(biz.id, `books/sets/${set.id}`));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }
  const columns = useMemo(() => [
    { key: "name", header: "Set", value: (s) => s.name, mobile: "title", pin: true,
      render: (s) => <span className="bz-two-line"><strong>{s.name}</strong><small className="muted">{[s.school, s.class_name].filter(Boolean).join(" · ") || "—"}</small></span> },
    { key: "code", header: "Code to scan", value: (s) => s.code, className: "mono", mobile: "subtitle" },
    { key: "item_count", header: "Items", type: "number", value: (s) => Number(s.item_count) },
    { key: "total", header: "Set price", type: "money", exact: true, value: (s) => Number(s.total), mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (s) => (s.active ? "active" : "inactive"), render: (s) => <ActiveBadge active={s.active} /> },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => <button type="button" className="chip-button" onClick={() => open(s)}>Edit</button> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ].filter(Boolean), [biz]);
  return (
    <>
      <ErrorMessage message={list.error || error} />
      <SectionCard flush icon="list" title="School sets" description="Type or scan a set's code at Quick bill to bill the whole list."
        actions={biz.can("catalog.create") && <button type="button" className="button button-sm" onClick={() => setEditing({ items: [] })}><Icon name="plus" size={14} /> New set</button>}>
        <DataGrid {...list.gridProps} caption="School sets" columns={columns} currency={biz.symbol} rowNoun={["set", "sets"]}
          rowClassName={(s) => (!s.active ? "dg-tone-muted" : "")}
          empty="No school sets yet" emptyHint="Add a school's list for a class once; the counter bills it in one scan." emptyIcon="book" />
      </SectionCard>
      {editing && <SetDialog set={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </>
  );
}

function SetDialog({ set, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(set.id);
  const [form, setForm] = useState({ name: set.name || "", code: set.code || "", school: set.school || "", className: set.class_name || "", active: set.active ?? true });
  const [items, setItems] = useState(() => (set.items || []).map((i) => ({ skuId: i.sku_id, label: i.label, price: i.price, quantity: String(Number(i.quantity)) })));
  const [error, setError] = useState("");
  const set_ = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const total = items.reduce((sum, i) => sum + Number(i.price) * Number(i.quantity || 0), 0);
  function add(sku) {
    if (!sku) return;
    setItems((all) => (all.some((i) => i.skuId === sku.id) ? all.map((i) => (i.skuId === sku.id ? { ...i, quantity: String(Number(i.quantity) + 1) } : i))
      : [...all, { skuId: sku.id, label: sku.label, price: sku.price, quantity: "1" }]));
  }
  const body = () => ({ ...form, items: items.map((i) => ({ skuId: i.skuId, quantity: i.quantity })) });
  return (
    <FormDialog title={editing ? `Edit ${set.name}` : "New school set"} icon="book" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Save set"
      successMessage={(s) => `${s.name} saved: ${s.items.length} items, ${biz.exact(s.total)}`}
      onSubmit={() => {
        if (!items.length) { setError("Add at least one item to the set."); return Promise.reject(new Error("Add at least one item to the set.")); }
        return editing ? businessWrite(biz.id, `books/sets/${set.id}`, body(), "put") : businessWrite(biz.id, "books/sets", body());
      }}>
      <FormError message={error} />
      <Field label="Set name" wide><input required maxLength={150} value={form.name} onChange={set_("name")} placeholder="e.g. St. Mary's — Class 5 (2026–27)" /></Field>
      <Field label="Code to scan" hint="Letters, digits and dashes; printed on the list or a label."><input required maxLength={40} className="mono" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="SMS-C5" /></Field>
      <Field label="School (optional)"><input maxLength={150} value={form.school} onChange={set_("school")} /></Field>
      <Field label="Class (optional)"><input maxLength={60} value={form.className} onChange={set_("className")} /></Field>
      <div className="field-wide stack">
        <SearchPicker label="Add an item" placeholder="Title, ISBN, notebook, pen…" clearOnSelect onChange={add}
          search={(q, { signal }) => businessRead(biz.id, "catalog", { q, active: "true", kind: "goods", limit: 12 }, signal).then((page) => page.items)}
          getLabel={(s) => s.label} getDescription={(s) => `${s.code} · ${biz.exact(s.price)} · ${quantity(s.stock, s.unit)} in stock`} minChars={1} />
        {items.length > 0 ? (
          <ul className="rt-set-items">
            {items.map((i) => (
              <li key={i.skuId}>
                <span className="rt-set-item-name">{i.label}<small className="muted"> · {biz.exact(i.price)}</small></span>
                <input aria-label={`Quantity of ${i.label}`} type="number" min="1" step="1" value={i.quantity}
                  onChange={(e) => setItems((all) => all.map((x) => (x.skuId === i.skuId ? { ...x, quantity: e.target.value } : x)))} />
                <button type="button" className="icon-button" aria-label={`Remove ${i.label}`} onClick={() => setItems((all) => all.filter((x) => x.skuId !== i.skuId))}><Icon name="x" size={15} /></button>
              </li>
            ))}
            <li className="rt-set-total"><span>Set price</span><strong>{biz.exact(total)}</strong></li>
          </ul>
        ) : <p className="muted small">No items yet. Find each book or item above.</p>}
      </div>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set_("active")} /> In use (a set switched off does not scan)</label>}
    </FormDialog>
  );
}
