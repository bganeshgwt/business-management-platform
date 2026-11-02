import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import Modal from "../../components/Modal";
import { EmptyState, ErrorMessage } from "../../components/Feedback";
import { toast } from "../../services/toast";
import { inPacks, packOf } from "../../modules/business/wholesale/pages/tradeFormat";
import { useSales } from "./salesContext";
import { priceLine, priceOrder, rupeesText } from "./salesPricing";
import { orderCheck, readShopRef } from "./salesRules";
import { money } from "./salesFormat";

// Taking an order at a shop: the catalogue at this shop's own prices (its own
// price, its price group's, the slab for its quantity, per case when ordered
// in cases), the schemes and their free goods, the depot's stock; "Repeat
// last order"; the order's summary with the free goods and GST. Priced on the
// phone exactly as the server prices it (salesPricing.js); the server prices
// it again when it arrives and says so if it differs. An order the phone's
// copy shows on credit hold, over the limit or a new shop's cash only is
// stopped here, with why and the office's number to call; it may still be
// sent for the office to decide (refused on arrival, it waits under Orders
// until the office lets it through, then Try again sends it).
const SHOWN = 60;

export default function SalesOrderPage() {
  const sales = useSales();
  const navigate = useNavigate();
  const { shopRef } = useParams();
  const shop = readShopRef(shopRef) ? sales.shopByRef(shopRef) : null;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [cart, setCart] = useState([]);
  const [reviewing, setReviewing] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const base = `/sales/${sales.businessId}`;
  const items = useMemo(() => sales.pack?.items || [], [sales.pack]);
  const ctx = useMemo(() => ({ contactId: shop?.id || null, groupId: shop?.price_group_id || null, day: sales.today }), [shop, sales.today]);
  const beat = (sales.pack?.beats || []).find((b) => Number(b.id) === Number(shop?.beat_id));
  const depotId = Number(beat?.depot_id || sales.pack?.default_depot_id);
  const visit = shop ? sales.visits.find((v) => shop.refs.includes(v.shopRef) && !v.out) : null;
  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean))].sort(), [items]);

  // What each cart line asks for: whole packs alone go in packs (the pack price applies), anything else in pieces.
  const lines = cart.map((line) => {
    const pack = packOf(line.sku);
    const cases = Number(line.cases || 0), pieces = Number(line.pieces || 0);
    return pack && cases > 0 && !pieces ? { skuId: line.sku.id, quantity: String(cases), unit: pack.unit } : { skuId: line.sku.id, quantity: String(Math.round((cases * (pack?.factor || 0) + pieces) * 1000) / 1000) };
  }).filter((l) => Number(l.quantity) > 0);
  const linesKey = JSON.stringify(lines);
  const priced = useMemo(() => priceOrder(sales.index, ctx, JSON.parse(linesKey)), [sales.index, ctx, linesKey]);
  const since = shop ? sales.sinceFor(shop) : null;
  const check = shop ? orderCheck(shop, priced.total, since) : { ok: true };

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return items.filter((i) => (!category || i.category === category) && (!words || [i.label, i.code, i.barcode].some((t) => String(t || "").toLowerCase().includes(words)))).slice(0, SHOWN);
  }, [items, query, category]);

  if (!shop) return <EmptyState icon="store" message="This shop is not on this phone" hint="Open it from Shops." />;
  if (sales.actions && !visit) {
    return (
      <div className="sl-page">
        <EmptyState icon="clock" message={`Check in at ${shop.name} first`} hint="An order is taken on a visit, so the office sees where and when." />
        <Link className="button" to={`${base}/shops/${shop.ref}`}>Back to {shop.name}</Link>
      </div>
    );
  }

  const add = (sku, extra = {}) => setCart((all) => {
    const pack = packOf(sku);
    const same = all.find((l) => l.sku.id === sku.id);
    if (same) return all.map((l) => (l === same ? { ...l, ...(pack ? { cases: String(Number(l.cases || 0) + 1) } : { pieces: String(Number(l.pieces || 0) + 1) }) } : l));
    return [...all, { sku, cases: pack ? "1" : "", pieces: pack ? "" : "1", ...extra }];
  });
  const set = (skuId, field, value) => setCart((all) => all.map((l) => (l.sku.id === skuId ? { ...l, [field]: value } : l)));
  const step = (skuId, field, by) => setCart((all) => all.map((l) => (l.sku.id === skuId ? { ...l, [field]: String(Math.max(0, Number(l[field] || 0) + by)) } : l)));
  const remove = (skuId) => setCart((all) => all.filter((l) => l.sku.id !== skuId));
  const repeat = () => {
    const last = shop.last_order?.lines || [];
    const next = [];
    for (const old of last) {
      const sku = items.find((i) => Number(i.id) === Number(old.sku_id));
      if (!sku) continue;
      const pack = packOf(sku);
      if (old.entered_unit && pack && old.entered_unit === pack.unit) next.push({ sku, cases: String(Number(old.entered_quantity)), pieces: "" });
      else if (pack && Number(old.quantity) >= pack.factor) {
        const cases = Math.floor(Number(old.quantity) / pack.factor);
        next.push({ sku, cases: String(cases), pieces: String(Math.round((Number(old.quantity) - cases * pack.factor) * 1000) / 1000 || "") });
      } else next.push({ sku, cases: "", pieces: String(Number(old.quantity)) });
    }
    setCart(next);
    toast.success(next.length < last.length ? `Last order copied: ${last.length - next.length} of its items are no longer sold` : "Last order copied: change what you need");
  };

  const place = async () => {
    setBusy(true);
    setProblem("");
    try {
      const summary = priced.lines.map((l) => ({ label: l.sku.label, quantity: l.entered ? `${l.entered.quantity} ${l.entered.unit}` : `${l.quantity} ${l.sku.unit}`, total: rupeesText(l.total),
        free: l.free ? inPacks(l.free.quantityMilli / 1000, l.sku.unit, l.free.entered?.unit, l.free.entered ? l.free.quantityMilli / 1000 / l.free.entered.quantity : null) : l.otherFree?.sku ? `${l.otherFree.quantityMilli / 1000} ${l.otherFree.sku.label}` : null }));
      await sales.actions.placeOrder(shop, visit, { lines, phoneTotal: rupeesText(priced.total), depotId, notes: notes.trim() || null, summary });
      toast.success(!check.ok ? "Sent for the office to decide: it waits under Orders until the office lets it through"
        : sales.online ? "Order placed" : "Order kept on this phone: it goes to the office when the connection is back");
      navigate(`${base}/shops/${shop.ref}`);
    } catch (err) {
      setProblem(err?.message || "The order could not be kept on this phone.");
      setBusy(false);
    }
  };
  const officePhone = (sales.biz.allLocations || []).find((l) => Number(l.id) === depotId)?.phone || (sales.biz.allLocations || [])[0]?.phone || null;

  return (
    <div className="sl-order">
      <header className="sl-order-head">
        <Link to={`${base}/shops/${shop.ref}`} className="sl-back" aria-label={`Back to ${shop.name}`}><Icon name="undo" size={18} /></Link>
        <div>
          <h1 className="sl-title">Order · {shop.name}</h1>
          <p className="muted small">{shop.approval === "pending" ? "New shop: cash on delivery until approved" : shop.credit_limit !== null && shop.credit_limit !== undefined ? `Credit limit ${money(shop.credit_limit)}` : "No credit limit"}</p>
        </div>
      </header>
      <div className="sl-order-tools">
        <label className="sl-search">
          <Icon name="search" size={17} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Item name, code or barcode" aria-label="Find an item" />
        </label>
        {shop.last_order?.lines?.length > 0 && cart.length === 0 && (
          <button type="button" className="button button-secondary button-sm" onClick={repeat}><Icon name="history" size={15} /> Repeat last order</button>
        )}
      </div>
      {categories.length > 1 && (
        <div className="sl-cats" role="radiogroup" aria-label="Category">
          <button type="button" role="radio" aria-checked={!category} className={`sl-reason ${!category ? "is-active" : ""}`} onClick={() => setCategory("")}>All</button>
          {categories.map((c) => <button key={c} type="button" role="radio" aria-checked={category === c} className={`sl-reason ${category === c ? "is-active" : ""}`} onClick={() => setCategory(c)}>{c}</button>)}
        </div>
      )}

      {cart.length > 0 && (
        <section className="sl-cart" aria-label="On this order">
          {priced.lines.map((line) => {
            const item = cart.find((c) => Number(c.sku.id) === Number(line.input.skuId));
            const pack = packOf(item.sku);
            return (
              <div key={item.sku.id} className="sl-cart-line">
                <div className="sl-cart-name">
                  <strong>{item.sku.label}</strong>
                  <span className="muted small">
                    {line.error ? line.error : `${money(line.total / 100)}${line.scheme ? ` · ${line.scheme.name}` : ""}${line.discount ? ` · ${line.discount}% off` : ""}`}
                  </span>
                  {line.free && <span className="sl-free">+ {inPacks(line.free.quantityMilli / 1000, item.sku.unit, pack?.unit, pack?.factor)} free</span>}
                  {line.otherFree?.sku && <span className="sl-free">+ {line.otherFree.quantityMilli / 1000} {line.otherFree.sku.unit} {line.otherFree.sku.label} free</span>}
                  {line.otherFree?.error && <span className="sl-issue">{line.otherFree.error}</span>}
                </div>
                <div className="sl-steppers">
                  {pack && <Stepper label={`${item.sku.label} ${pack.unit}`} unit={pack.unit} value={item.cases} onChange={(v) => set(item.sku.id, "cases", v)} onStep={(by) => step(item.sku.id, "cases", by)} />}
                  <Stepper label={`${item.sku.label} ${item.sku.unit}`} unit={item.sku.unit} value={item.pieces} onChange={(v) => set(item.sku.id, "pieces", v)} onStep={(by) => step(item.sku.id, "pieces", by)} />
                  <button type="button" className="sl-remove" onClick={() => remove(item.sku.id)} aria-label={`Remove ${item.sku.label}`}><Icon name="trash" size={16} /></button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <ul className="sl-items" aria-label="Items">
        {shown.map((sku) => <ItemRow key={sku.id} sku={sku} ctx={ctx} index={sales.index} depotId={depotId} inCart={cart.some((c) => c.sku.id === sku.id)} onAdd={() => add(sku)} />)}
      </ul>
      {!shown.length && <EmptyState icon="search" message={query ? `No item matches "${query.trim()}"` : "No items in the day's copy"} hint="The catalogue comes with the day's pack; read it again with the network for new items." />}
      {items.length > SHOWN && shown.length === SHOWN && <p className="muted small sl-more-items">Showing {SHOWN} items: search to find the rest.</p>}

      <div className="sl-order-bar">
        <div>
          <strong>{money(priced.total / 100)}</strong>
          <span className="muted small"> · {lines.length} {lines.length === 1 ? "line" : "lines"}</span>
        </div>
        <button type="button" className="button" disabled={!lines.length || priced.problems.length > 0} onClick={() => setReviewing(true)}>Review order</button>
      </div>

      {reviewing && (
        <Modal title="Review the order" icon="receipt" description={shop.name} onClose={() => setReviewing(false)} width={560} className="sl-sheet"
          footer={check.ok
            ? <button type="button" className="button sl-wide" onClick={place} disabled={busy}><Icon name="check" size={16} /> {busy ? "Placing…" : `Place order · ${money(priced.total / 100)}`}</button>
            : (
              <div className="sl-foot-stack">
                {officePhone && <a className="button sl-wide" href={`tel:${officePhone}`}><Icon name="phone" size={16} /> Call the office</a>}
                <button type="button" className="button button-secondary sl-wide" onClick={place} disabled={busy}><Icon name="upload" size={16} /> {busy ? "Sending…" : "Send it for the office to decide"}</button>
              </div>
            )}>
          <table className="sl-review">
            <tbody>
              {priced.lines.map((line) => (
                <tr key={line.input.skuId}>
                  <td>
                    {line.sku.label}
                    <small className="muted">{line.entered ? `${line.entered.quantity} ${line.entered.unit} (${line.quantity} ${line.sku.unit})` : `${line.quantity} ${line.sku.unit}`}{line.scheme ? ` · ${line.scheme.name}` : ""}</small>
                    {line.free && <small className="sl-free">Free: {inPacks(line.free.quantityMilli / 1000, line.sku.unit, line.free.entered?.unit, line.free.entered ? (line.free.quantityMilli / 1000) / line.free.entered.quantity : null)}</small>}
                    {line.otherFree?.sku && <small className="sl-free">Free: {line.otherFree.quantityMilli / 1000} {line.otherFree.sku.unit} {line.otherFree.sku.label}</small>}
                  </td>
                  <td className="r">{money(line.total / 100)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>Before GST</td><td className="r">{money(priced.subtotal / 100)}</td></tr>
              <tr><td>GST</td><td className="r">{money(priced.tax / 100)}</td></tr>
              <tr className="sl-review-total"><td>Total</td><td className="r">{money(priced.total / 100)}</td></tr>
            </tfoot>
          </table>
          {!check.ok && (
            <div className="alert alert-error" role="alert">
              <strong>{check.title}.</strong> {check.message}
              <small className="sl-alert-more">Or send it: the office sees it turned back, and once it lets it through (or raises the limit, or approves the shop), Try again on Orders sends the same order.</small>
            </div>
          )}
          {check.ok && (
            <label className="field">
              <span>Note for the office (optional)</span>
              <input maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Delivery before 11 am, back gate…" />
            </label>
          )}
          <p className="muted small">The office prices every order again when it arrives; any difference is shown to you.</p>
          <ErrorMessage message={problem} />
        </Modal>
      )}
    </div>
  );
}

function Stepper({ label, unit, value, onChange, onStep }) {
  return (
    <span className="sl-stepper">
      <button type="button" onClick={() => onStep(-1)} aria-label={`One ${unit} less`}><Icon name="minus" size={15} /></button>
      <input aria-label={label} type="number" min="0" step="any" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" onClick={() => onStep(1)} aria-label={`One ${unit} more`}><Icon name="plus" size={15} /></button>
      <small>{unit}</small>
    </span>
  );
}

// One item of the catalogue at this shop's price for a pack (or a piece), its
// scheme and the depot's stock.
function ItemRow({ sku, ctx, index, depotId, inCart, onAdd }) {
  const pack = packOf(sku);
  const one = useMemo(() => priceLine(index, ctx, pack ? { skuId: sku.id, quantity: "1", unit: pack.unit } : { skuId: sku.id, quantity: "1" }), [index, ctx, sku, pack]);
  const schemes = (index.schemes.get(Number(sku.id)) || []).filter((x) => x.valid_from <= ctx.day && (!x.valid_to || x.valid_to >= ctx.day) && (x.group_id === null || Number(x.group_id) === Number(ctx.groupId)));
  const stock = Number(sku.stock?.[depotId] || 0);
  return (
    <li className={`sl-item ${inCart ? "is-in" : ""}`}>
      <div className="sl-item-body">
        <strong>{sku.label}</strong>
        <span className="muted small">
          {one.error ? one.error : `${money((one.total) / 100)} a ${pack ? pack.unit : sku.unit}${pack ? ` of ${pack.factor}` : ""}${one.source === "customer" ? " · their price" : one.source === "group" ? " · group price" : ""}`}
        </span>
        <span className="sl-item-tags">
          {schemes.slice(0, 2).map((x) => <span key={x.id} className="sl-chip is-info">{x.name}</span>)}
          <span className={`sl-chip ${stock > 0 ? "is-neutral" : "is-warning"}`}>{stock > 0 ? `${inPacks(stock, sku.unit, pack?.unit, pack?.factor)} in stock` : "None in stock"}</span>
        </span>
      </div>
      <button type="button" className="sl-add" onClick={onAdd} aria-label={`Add ${sku.label}`}><Icon name="plus" size={18} /></button>
    </li>
  );
}
