import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { CollectionDialog } from "../../receivables/pages/receivablesParts";
import { Field } from "../../core/pages/ui";
import { udhaarRisk } from "./counterState";

// Pieces of Quick bill (CounterPage): the customer with their udhaar risk,
// the size × colour picker, held bills and the small counter discount.

// --- The customer, with what they owe ------------------------------------------------

// Who the bill is for: needed for udhaar, points and (electronics) the
// warranty; walk-in otherwise. A customer's udhaar risk shows here: what
// they owe, how much is overdue, the limit left and their last promise.
export function CustomerBox({ biz, customer, onChange, account }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "" });
  const [error, setError] = useState("");
  const [collecting, setCollecting] = useState(false);

  async function add(event) {
    event.preventDefault();
    setError("");
    try {
      const created = await businessWrite(biz.id, "contacts", { kind: "customer", name: form.name, phone: form.phone });
      onChange({ ...created, balance: 0 });
      setAdding(false); setForm({ name: "", phone: "" });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  if (customer) {
    const risk = udhaarRisk(customer, account, biz);
    return (
      <SectionCard icon="user" title="Customer" actions={<button type="button" className="link-button" onClick={() => onChange(null)}>Change</button>}>
        <div className="rt-customer">
          <strong>{customer.name}</strong>
          <span className="muted">{customer.phone || "No phone"}</span>
        </div>
        {(risk.owes > 0.004 || risk.limit !== null) && (
          <dl className="rt-risk">
            <div><dt>Owes</dt><dd>{biz.exact(risk.owes)}</dd></div>
            <div className={risk.overdue > 0.004 ? "is-bad" : ""}><dt>Overdue</dt><dd>{biz.exact(risk.overdue)}</dd></div>
            {risk.limit !== null && <div className={risk.limitLeft <= 0 ? "is-bad" : ""}><dt>Limit left</dt><dd>{biz.exact(Math.max(0, risk.limitLeft))}</dd></div>}
          </dl>
        )}
        {risk.promise && (
          <span className={`badge ${risk.promise.broken ? "badge-danger" : "badge-info"}`}>
            {risk.promise.broken ? `Promise broken ${dateShort(risk.promise.on)}` : `Promised ${dateShort(risk.promise.on)}`}
          </span>
        )}
        {risk.owes > 0.004 && biz.has("receivables") && biz.can("receivables.create") && (
          <div className="form-actions bz-start">
            <button type="button" className="button button-secondary button-sm" onClick={() => setCollecting(true)}><Icon name="wallet" size={14} /> Collect udhaar</button>
          </div>
        )}
        {collecting && <CollectionDialog contactId={customer.id} onClose={() => setCollecting(false)} onSaved={() => { setCollecting(false); onChange({ ...customer, refresh: Date.now() }); }} />}
      </SectionCard>
    );
  }
  return (
    <SectionCard icon="user" title="Customer" description="Walk-in pays in full. Pick a customer for udhaar or points.">
      {!adding ? (
        <>
          <SearchPicker aria-label="Find a customer by name or phone (F4)" placeholder="Name or phone  (F4 or Alt+C)" inputClassName="rt-find"
            search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 8 }, signal).then((page) => page.items)}
            minChars={2} getLabel={(c) => c.name} getKeywords={(c) => c.phone}
            getDescription={(c) => [c.phone, Number(c.balance) > 0.004 ? `owes ${biz.exact(c.balance)}` : null].filter(Boolean).join(" · ")}
            onChange={(c) => c && onChange(c)} clearOnSelect id="counter-customer"
            onCreate={biz.can("contacts.create") ? (text) => { setAdding(true); setForm({ name: /\d/.test(text) ? "" : text, phone: /\d/.test(text) ? text : "" }); } : undefined}
            createLabel={(text) => `New customer “${text}”`} emptyText="No customer matches" />
          {biz.can("contacts.create") && <button type="button" className="link-button rt-new-link" onClick={() => setAdding(true)}>+ New customer</button>}
        </>
      ) : (
        <form className="stack rt-new-customer" onSubmit={add}>
          <ErrorMessage message={error} />
          <Field label="Name"><input required maxLength={150} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
          <Field label="Phone"><input maxLength={30} inputMode="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></Field>
          <div className="form-actions bz-start">
            <button type="submit" className="button button-sm">Add customer</button>
            <button type="button" className="button button-secondary button-sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}

// --- Size × colour picker (fashion) ------------------------------------------------------

// Find a style by name or code, then tap the size and colour: the cell shows
// the stock here (greyed when none) and the price.
// `initialProduct` ({ id, name }) opens straight on one style (an exchange's
// "swap size or colour"); `title` / `description` reword the dialog.
export function VariantPicker({ biz, locationId, onPick, onClose, initialProduct = null, title = "Pick size and colour", description = "Find the style, then tap a size under its colour. Stock shown is at this counter." }) {
  const [product, setProduct] = useState(initialProduct);
  const [matrix, setMatrix] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!product) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `fashion/products/${product.id}`, { locationId }, controller.signal)
      .then((m) => { setMatrix(m); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => { controller.abort(); setMatrix(null); };
  }, [biz.id, product, locationId]);
  const cell = (size, color) => matrix?.variants.filter((v) => v.size.toLowerCase() === size.toLowerCase() && v.color.toLowerCase() === color.toLowerCase());
  return (
    <Modal title={title} icon="tag" width={820} onClose={onClose} description={description}>
      <div className="stack">
        <SearchPicker label="Style" placeholder="Style name or code" autoFocus value={product} onChange={setProduct}
          search={(q, { signal }) => businessRead(biz.id, "fashion/products", { q, limit: 12, active: "true" }, signal).then((page) => page.items)}
          getLabel={(p) => p.name} getDescription={(p) => `${p.category || "No category"} · ${(p.sizes || []).join(", ")} · ${Number(p.stock)} in stock`} minChars={1} />
        <ErrorMessage message={error} />
        {product && !matrix && !error && <Loading />}
        {matrix && (
          <div className="rt-matrix" role="grid" aria-label={`Sizes and colours of ${matrix.product.name}`}>
            <div className="rt-matrix-row is-head" role="row">
              <span role="columnheader">Colour</span>
              {matrix.sizes.map((size) => <span role="columnheader" key={size}>{size}</span>)}
            </div>
            {matrix.colors.map((color) => (
              <div className="rt-matrix-row" role="row" key={color}>
                <span role="rowheader"><strong>{color}</strong></span>
                {matrix.sizes.map((size) => {
                  const variants = cell(size, color) || [];
                  if (!variants.length) return <span key={size} className="rt-matrix-none" role="gridcell" aria-label={`${color} ${size}: not made`}>—</span>;
                  return (
                    <span key={size} role="gridcell" className="rt-matrix-cells">
                      {variants.map((v) => (
                        <button key={v.sku_id} type="button" className={`rt-matrix-cell ${Number(v.stock) <= 0 ? "is-empty" : ""}`} disabled={Number(v.stock) <= 0 || !v.active}
                          onClick={() => onPick(v)} aria-label={`${color} ${size}${v.fabric ? ` ${v.fabric}` : ""}: ${Number(v.stock)} in stock, ${biz.exact(v.price)}`}>
                          <strong>{Number(v.stock)}</strong>
                          <small>{biz.exact(v.price)}{v.fabric ? ` · ${v.fabric}` : ""}</small>
                        </button>
                      ))}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// --- Phone layout -------------------------------------------------------------------------


// The bill on a phone: one compact row per line — the item,
// its quantity control and the amount — instead of a tall card each.
export function PhoneLines({ lines, renderItem, renderQuantity, amountOf, onRemove, biz }) {
  return (
    <ul className="rt-phone-lines" aria-label="Bill lines">
      {lines.map((line, index) => (
        <li key={line.key} className="rt-phone-line">
          <div className="rt-phone-line-item">{renderItem(line)}</div>
          <div className="rt-phone-line-qty">{renderQuantity(line, { label: `Quantity of ${line.sku.label}`, index })}</div>
          <div className="rt-phone-line-amount">
            <strong>{biz.exact(amountOf(line))}</strong>
            <button type="button" className="icon-button rt-phone-remove" onClick={() => onRemove(line.key)} aria-label={`Remove ${line.sku.label}`} title="Remove">
              <Icon name="x" size={16} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// Always in reach on a phone: what the bill comes to and the way to pay it.
export function PayBar({ biz, total, lines, ready, label, onPay }) {
  return (
    <div className="rt-paybar" role="region" aria-label="To pay">
      <div className="rt-paybar-total">
        <span className="muted small">{lines} {lines === 1 ? "line" : "lines"} · To pay</span>
        <strong>{biz.exact(total)}</strong>
      </div>
      <button type="button" className="button rt-paybar-button" onClick={onPay} disabled={!lines}>
        {ready ? label : "Take payment"}
      </button>
    </div>
  );
}

// --- Returns from the counter -------------------------------------------------------------

// Find the bill a customer brings back — by its number, the customer's name
// or phone, or from today's latest bills — then Take back items on it.
export function ReturnFinder({ biz, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessRead(biz.id, "documents", { kind: "sale", q: q.trim() || undefined, limit: 8 }, controller.signal)
        .then((page) => { setRows(page.items); setError(""); })
        .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    }, q ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [biz.id, q]);
  return (
    <Modal title="Return items" icon="undo" width={640} onClose={onClose}
      description="Find the bill: scan or type its number, or the customer's name or phone. Returned items use the bill's own price and tax.">
      <div className="stack">
        <Field label="Bill number, customer or phone">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. SI/2627/0042 or 98450…" />
        </Field>
        <ErrorMessage message={error} />
        {!rows && !error && <Loading />}
        {rows && rows.length === 0 && <p className="muted">No bill matches. Check the number on the receipt.</p>}
        {rows && rows.length > 0 && (
          <ul className="rt-return-list">
            {rows.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => onPick(d)}>
                  <span><strong className="mono">{d.document_no}</strong> <small className="muted">{dateShort(d.created_at)} · {d.contact_name || "Walk-in"}</small></span>
                  <span>{biz.exact(d.total)} <span className="rt-return-go">Take back <Icon name="undo" size={14} /></span></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
