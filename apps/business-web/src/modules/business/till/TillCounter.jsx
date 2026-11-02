import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../components/SectionCard";
import Modal from "../../../components/Modal";
import { ErrorMessage } from "../../../components/Feedback";
import { Field } from "../core/pages/ui";
import { printReceipt } from "../retail/pages/retail";
import { qrSvg, upiPayLink } from "../../restaurant/orders/services/upi";
import { priceBill, money } from "./tillPricing.js";
import { dayOf } from "./tillRules.js";
import { findCode, searchCustomers, searchItems } from "./tillSnapshot.js";
import { snapshotAge } from "../../../services/offline/snapshots";
import "./till.css";

// Quick bill with no network: the counter as an offline till (useTill.js).
// Items, prices, GST rates, customers and payment methods come from what the
// till keeps (its snapshot); every figure is worked out by tillPricing.js,
// the server's own arithmetic; each bill takes the till's next number, is
// kept on this computer before its receipt prints, and is sent when the
// network is back. What needs the network is said so: offers, coupons and
// points, returns and exchanges, new customers, closing the shift, switching
// the cashier, items the till does not hold.
//
// Keys as on Quick bill: F2 items · F4 customer · F6 cash · F7 UPI · F8 card ·
// F9 udhaar · F12 or Ctrl+Enter take it · after a bill, Enter the next, P print.

const CASH_LIMIT = 20000000;
const PAN_ABOVE = 20000000;
const WEIGHT_STEPS = [250, 500, 1000, 2000];
const TENDERS = [["cash", "Cash", "F6"], ["upi", "UPI", "F7"], ["card", "Card", "F8"], ["split", "Split", ""], ["udhaar", "Udhaar", "F9"]];
const key = () => crypto.randomUUID();
const paise = (value) => Math.round(Number(value || 0) * 100);
const trim = (n) => String(Number(Number(n).toFixed(3)));

// What one cash part of each waiting bill to this customer took today, from what the till holds.
function cashTodayFrom(items, contactId, day, timezone) {
  return items.filter((item) => item.kind === "till_bill" && Number(item.body?.contactId) === Number(contactId)
    && item.meta?.madeAt && dayOf(item.meta.madeAt, timezone) === day)
    .reduce((sum, item) => sum + (item.body.payments || []).filter((p) => p.method === "cash").reduce((s, p) => s + paise(p.amount), 0), 0);
}
// What the till's waiting bills put on this customer's udhaar.
function udhaarFrom(items, contactId) {
  return items.filter((item) => item.kind === "till_bill" && Number(item.body?.contactId) === Number(contactId))
    .reduce((sum, item) => sum + paise(item.body.total) - (item.body.payments || []).reduce((s, p) => s + paise(p.amount), 0), 0);
}

export default function TillCounter({ biz, till, carried = null, onCarried, onBusy }) {
  const { snapshot, settings } = till;
  const tz = biz.business.timezone;
  const day = dayOf(till.now, tz);
  const [lines, setLines] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [findCustomer, setFindCustomer] = useState("");
  const [discount, setDiscount] = useState({ mode: "amount", value: "", reason: "" });
  const [tender, setTender] = useState("cash");
  const [received, setReceived] = useState("");
  const [splitCash, setSplitCash] = useState("");
  const [splitOther, setSplitOther] = useState("upi");
  const [reference, setReference] = useState("");
  const [partPaid, setPartPaid] = useState("");
  const [buyer, setBuyer] = useState({ pan: "", panDeclaration: false });
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [posted, setPosted] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const scanRef = useRef(null);
  const canPay = biz.can("sales.edit");
  const canDiscount = biz.can("sales.discount");
  const fullAccess = Boolean(biz.context?.role?.full_access);
  const stop = till.limit.state === "stop";

  // The bill being built online when the network went: carried over, item by item.
  useEffect(() => {
    if (!carried || !snapshot) return;
    const kept = [], missing = [];
    for (const line of carried.lines || []) {
      const item = snapshot.items.find((row) => Number(row.id) === Number(line.sku?.id));
      if (item && Number(line.quantity) > 0) kept.push({ key: key(), item, quantity: String(line.quantity), unit: line.unit && line.unit !== item.unit ? line.unit : "" });
      else missing.push(line.sku?.label || "An item");
    }
    setLines(kept);
    if (carried.customer) setCustomer(snapshot.customers.find((c) => Number(c.id) === Number(carried.customer.id)) || null);
    if (missing.length) setNote(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on this till offline and ${missing.length === 1 ? "was" : "were"} left off the bill.`);
    onCarried?.();
    // Carried once, when the till takes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carried, snapshot]);

  // While a bill is in hand (or its receipt is on screen), the till keeps billing even if the network comes back.
  useEffect(() => { onBusy?.(lines.length > 0 || Boolean(posted)); }, [lines.length, posted, onBusy]);
  useEffect(() => () => onBusy?.(false), [onBusy]);

  const cart = useMemo(() => ({
    contactId: customer?.id || null,
    lines: lines.filter((l) => Number(l.quantity) > 0).map((l) => ({ skuId: l.item.id, quantity: l.quantity, ...(l.unit ? { unit: l.unit } : {}) })),
    ...(canDiscount && Number(discount.value) > 0 && discount.reason.trim() ? { discount: { [discount.mode]: discount.value, reason: discount.reason.trim() } } : {}),
  }), [lines, customer, discount, canDiscount]);
  const priced = useMemo(() => (snapshot && cart.lines.length ? priceBill(snapshot, cart, { day, fullAccess }) : null), [snapshot, cart, day, fullAccess]);
  // Each bill line's priced line (lines still waiting for a weight have none yet).
  const pricedOf = useMemo(() => {
    const usable = lines.filter((l) => Number(l.quantity) > 0);
    return new Map(usable.map((l, i) => [l.key, priced?.lines.find((x) => x.index === i) || null]));
  }, [lines, priced]);
  const total = priced?.total || 0;
  const waitingWeight = lines.filter((l) => !(Number(l.quantity) > 0));

  // --- Items ---------------------------------------------------------------------------------
  function add(item, count = 1, scaleQuantity = null) {
    setError("");
    setNote("");
    setLines((all) => {
      const weighed = unitKind(item) === "weight";
      if (scaleQuantity !== null) return [...all, { key: key(), item, quantity: String(scaleQuantity), unit: "", scale: true }];
      const same = !weighed && all.find((l) => l.item.id === item.id && !l.unit);
      if (same) return all.map((l) => (l === same ? { ...l, quantity: String(Number(l.quantity || 0) + count) } : l));
      return [...all, { key: key(), item, quantity: weighed && count === 1 ? "" : String(count), unit: "", focus: weighed }];
    });
  }
  const unitKind = (item) => snapshot.units.find((u) => u.code === item.unit)?.kind || "count";
  function lookUp(text) {
    const found = findCode(snapshot, text);
    if (!found) {
      const hits = searchItems(snapshot, text, 2);
      if (hits.length === 1) { add(hits[0]); return true; }
      setError(`Nothing on this till matches "${text}". Items added after ${snapshotAge(snapshot.savedAt)} need the network.`);
      return false;
    }
    if (found.excluded) {
      const why = { serial: "each unit is chosen by its serial number", kit: "a kit is priced by its parts", internal: "it is kept for use in the shop" }[found.excluded.reason];
      setError(`${found.excluded.label} needs the network: ${why}.`);
      return false;
    }
    add(found.item, 1, found.quantity);
    return true;
  }
  const setLine = (lineKey, changes) => { setError(""); setLines((all) => all.map((l) => (l.key === lineKey ? { ...l, ...changes, focus: false } : l))); };
  const removeLine = (lineKey) => setLines((all) => all.filter((l) => l.key !== lineKey));
  const matches = useMemo(() => (query.trim().length >= 2 ? searchItems(snapshot, query, 24) : []), [snapshot, query]);
  const shelf = query.trim().length >= 2 ? matches : snapshot.items.slice(0, 24);

  // --- Paying --------------------------------------------------------------------------------
  const methodOf = (kind) => snapshot.methods.find((m) => m.kind === kind) || null;
  const paidParts = () => {
    if (!canPay || total <= 0) return [];
    const part = (kind, amount, extra = {}) => ({ method: kind, amount, ...(methodOf(kind) ? { methodId: methodOf(kind).id, methodName: methodOf(kind).name } : {}), ...extra });
    if (tender === "cash") return [part("cash", total, paise(received) > total ? { tendered: paise(received) } : {})];
    if (tender === "upi" || tender === "card") return [part(tender, total, reference.trim() ? { reference: reference.trim().slice(0, 100) } : {})];
    if (tender === "split") {
      const cash = Math.min(paise(splitCash), total);
      return [cash > 0 && part("cash", cash), total - cash > 0 && part(splitOther, total - cash, reference.trim() ? { reference: reference.trim().slice(0, 100) } : {})].filter(Boolean);
    }
    if (tender === "udhaar") return paise(partPaid) > 0 ? [part("cash", Math.min(paise(partPaid), total))] : [];
    return [];
  };
  const parts = priced ? paidParts() : [];
  const paidNow = parts.reduce((s, p) => s + p.amount, 0);
  const cashNow = parts.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  const change = tender === "cash" && paise(received) > total ? paise(received) - total : 0;
  const onCredit = Math.max(0, total - paidNow);
  const balance = customer ? paise(customer.balance || 0) + udhaarFrom(till.items, customer.id) : 0;
  const limit = customer?.creditLimit !== null && customer?.creditLimit !== undefined ? paise(customer.creditLimit) : null;
  const panNeeded = total > PAN_ABOVE && !(customer?.pan || customer?.gstin);
  const panText = buyer.pan.trim().toUpperCase();

  // Why the bill cannot be taken now (in the till's own words), or "".
  const blocked = (() => {
    if (stop) return till.limit.words;
    if (!priced) return "";
    if (priced.problems.length) return priced.problems[0].message;
    if (waitingWeight.length) return `Enter the weight of ${waitingWeight.map((l) => l.item.label).join(", ")}.`;
    if (!biz.can("sales.create")) return "Your role does not bill.";
    if (customer?.gstin && settings.einvoicing) return `${customer.name} has a GSTIN, and this business e-invoices: a bill to them needs the network (the IRP).`;
    if (tender === "udhaar" && !customer) return "Udhaar: pick the customer who will pay later.";
    if (!customer && onCredit > 0 && !settings.walkInCredit) return canPay ? "A walk-in pays the whole bill now. To give udhaar, pick the customer." : "Your role takes no payments: a walk-in's bill needs someone who does.";
    if (customer && onCredit > 0 && limit !== null && balance + onCredit > limit) {
      return `${customer.name} would owe ${biz.exact((balance + onCredit) / 100)}, over their limit of ${biz.exact(limit / 100)}. Take more now, or raise the limit online.`;
    }
    if (tender === "cash" && received !== "" && paise(received) < total) return "The cash received is less than the bill.";
    if (tender === "split" && (paise(splitCash) <= 0 || paise(splitCash) >= total)) return "Split: enter the cash part; the rest goes by UPI or card.";
    if (cashNow >= CASH_LIMIT) return "Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186). Take the rest by UPI or card.";
    if (customer && cashNow > 0 && cashTodayFrom(till.items, customer.id, day, tz) + cashNow >= CASH_LIMIT) {
      return `Cash from ${customer.name} today would reach ₹2,00,000 (Income-tax Act 2025, section 186). Take the rest by UPI or card.`;
    }
    if (panNeeded && !buyer.panDeclaration && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panText)) return "A bill over ₹2,00,000 records the buyer's PAN, or their declaration (Form 97).";
    return "";
  })();
  const ready = Boolean(priced?.ok) && !blocked && !saving && !posted;

  async function take() {
    if (!ready) return;
    setSaving(true);
    setError("");
    try {
      const saved = await till.saveBill({
        priced, cart, payments: parts, customer,
        buyer: panNeeded ? (buyer.panDeclaration ? { panDeclaration: true } : { pan: panText }) : null,
        discountReason: cart.discount?.reason || "",
      });
      const udhaar = customer && onCredit > 0 ? { earlier: balance / 100, thisBill: onCredit / 100, total: (balance + onCredit) / 100 } : null;
      setPosted({ ...saved, change, total, paid: paidNow, udhaar, item: saved.item });
    } catch (err) {
      setError(err.message || "The bill could not be kept on this computer.");
    } finally {
      setSaving(false);
    }
  }
  function next() {
    setLines([]); setCustomer(null); setDiscount({ mode: "amount", value: "", reason: "" }); setTender("cash"); setReceived(""); setSplitCash(""); setReference("");
    setPartPaid(""); setBuyer({ pan: "", panDeclaration: false }); setPosted(null); setError(""); setNote(""); setQuery("");
    setTimeout(() => scanRef.current?.focus(), 0);
  }
  const print = () => posted && printReceipt(posted.receipt, biz, { change: posted.change / 100, udhaar: posted.udhaar });

  // Keyboard, as on Quick bill.
  const keys = useRef({});
  keys.current = { take, next, print, posted, ready };
  useEffect(() => {
    function onKey(event) {
      const k = keys.current;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "");
      if (k.posted) {
        if ((event.key === "p" || event.key === "P") && !typing) { event.preventDefault(); k.print(); }
        if (event.key === "F2" || (event.key === "Enter" && !typing && !/^(BUTTON|A)$/.test(event.target?.tagName || ""))) { event.preventDefault(); k.next(); }
        return;
      }
      const map = { F6: "cash", F7: "upi", F8: "card", F9: "udhaar" };
      if (event.key === "F2") { event.preventDefault(); scanRef.current?.focus(); }
      else if (event.key === "F4") { event.preventDefault(); document.getElementById("till-customer")?.focus(); }
      else if (map[event.key]) { event.preventDefault(); setTender(map[event.key]); }
      else if (event.key === "F12" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); if (k.ready) k.take(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const upiLink = tender === "upi" && settings.upiId && total > 0
    ? upiPayLink({ vpa: settings.upiId, payeeName: settings.upiPayee || biz.business.name, amount: total / 100, note: `${till.till.code} ${biz.business.name}`.slice(0, 50) }) : null;
  const customerHits = searchCustomers(snapshot, findCustomer);
  const weightSteps = settings.weightButtons?.length ? settings.weightButtons : WEIGHT_STEPS;

  return (
    <section className="stack till-counter" aria-label="Offline billing">
      <div className={`till-banner is-${till.limit.state}`} role="status">
        <Icon name={stop ? "ban" : "alert"} size={18} />
        <div>
          <strong>{stop ? "Offline billing has stopped on this till" : `Offline · billing on till ${till.till.code}`}</strong>
          <span>{stop ? till.limit.words
            : `${till.till.name} · items and prices as of ${new Date(snapshot.savedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} (${snapshotAge(snapshot.savedAt)})`
              + ` · ${till.waiting + till.attention} ${till.waiting + till.attention === 1 ? "bill" : "bills"} waiting to send`}</span>
          {till.limit.state === "warn" && <span className="till-banner-warn">{till.limit.words}</span>}
        </div>
      </div>
      <div className="rt-counter">
        <div className="stack rt-counter-main">
          <SectionCard icon="search" title="1 · Add items" description="Scan, type a name or code, or tap an item. The bill is at the shelf price: offers, coupons and points need the network.">
            <form className="rt-scan" role="search" onSubmit={(e) => { e.preventDefault(); if (query.trim() && lookUp(query.trim())) setQuery(""); }}>
              <Icon name="search" size={18} />
              <input ref={scanRef} autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setError(""); }} aria-label="Scan or type an item"
                placeholder="Scan a barcode or type a name  (F2)" autoComplete="off" disabled={stop} />
              <button type="submit" className="button button-sm" disabled={stop || !query.trim()}>Add to bill</button>
            </form>
            <ErrorMessage message={error} />
            {note && <p className="small rt-warn" role="status">{note}</p>}
            <ul className="till-shelf" aria-label="Items on this till">
              {shelf.map((item) => (
                <li key={item.id}>
                  <button type="button" className="till-shelf-item" disabled={stop} onClick={() => { add(item); scanRef.current?.focus(); }}>
                    <strong>{item.label}</strong>
                    <span className="muted small">{biz.exact(item.branchPrice ?? item.listPrice)} / {item.unit}{item.mrp ? ` · MRP ${biz.exact(item.mrp)}` : ""}</span>
                  </button>
                </li>
              ))}
              {!shelf.length && <li className="muted small till-shelf-none">No item on this till matches.</li>}
            </ul>
          </SectionCard>
        </div>
        <div className="stack rt-counter-side">
          <SectionCard flush icon="list" title="2 · Bill" className="rt-bill" actions={lines.length > 0 && <button type="button" className="button button-secondary button-sm" onClick={() => setLines([])}>Clear</button>}>
            {lines.length === 0
              ? <p className="muted rt-empty">Nothing on the bill yet. Scan or pick items.</p>
              : (
                <ul className="till-lines" aria-label="Bill lines">
                  {lines.map((line) => {
                    const at = pricedOf.get(line.key);
                    const weighed = unitKind(line.item) === "weight";
                    const units = [line.item.unit, ...(line.item.packs || []).map((p) => p.unit), ...(line.item.unit === "kg" ? ["g"] : [])];
                    return (
                      <li key={line.key} className="till-line">
                        <div className="till-line-item">
                          <strong>{line.item.label}</strong>
                          <small className="muted">{at ? `${biz.exact(at.unitPrice)} / ${line.item.unit}${at.priceKind === "member" ? " · member price" : at.priceKind === "branch" ? " · this branch's price" : ""} · GST ${Number(at.taxRate)}%` : `${biz.exact(line.item.listPrice)} / ${line.item.unit}`}{line.scale ? " · from scale label" : ""}</small>
                        </div>
                        <div className="till-line-qty">
                          {weighed && !line.scale ? (
                            <span className="rt-weigh-row">
                              <input type="number" inputMode="decimal" min="0.001" step="any" placeholder="Weight" autoFocus={line.focus} aria-label={`Weight of ${line.item.label}`}
                                className={!(Number(line.quantity) > 0) ? "is-missing" : ""} value={line.quantity} onChange={(e) => setLine(line.key, { quantity: e.target.value })} />
                              {units.length > 1 && <select aria-label={`Unit of ${line.item.label}`} value={line.unit || line.item.unit} onChange={(e) => setLine(line.key, { unit: e.target.value === line.item.unit ? "" : e.target.value, quantity: "" })}>
                                {units.map((u) => <option key={u} value={u}>{u}</option>)}
                              </select>}
                            </span>
                          ) : (
                            <span className="rt-qty rt-stepper">
                              <button type="button" className="chip-button" aria-label={`One less ${line.item.label}`} onClick={() => (Number(line.quantity) > 1 ? setLine(line.key, { quantity: String(Number(line.quantity) - 1) }) : removeLine(line.key))}>−</button>
                              <input type="number" inputMode="numeric" min="1" step="1" aria-label={`Quantity of ${line.item.label}`} value={line.quantity} onChange={(e) => setLine(line.key, { quantity: e.target.value })} />
                              <button type="button" className="chip-button" aria-label={`One more ${line.item.label}`} onClick={() => setLine(line.key, { quantity: String(Number(line.quantity || 0) + 1) })}>+</button>
                              {units.length > 1 && <select aria-label={`Unit of ${line.item.label}`} value={line.unit || line.item.unit} onChange={(e) => setLine(line.key, { unit: e.target.value === line.item.unit ? "" : e.target.value })}>
                                {units.map((u) => <option key={u} value={u}>{u}</option>)}
                              </select>}
                            </span>
                          )}
                          {weighed && !line.scale && (
                            <span className="rt-steps">
                              {weightSteps.map((g) => <button key={g} type="button" className="chip-button" onClick={() => setLine(line.key, { quantity: (line.unit || line.item.unit) === "g" ? String(g) : trim(g / 1000) })}>{g < 1000 ? `${g} g` : `${g / 1000} kg`}</button>)}
                            </span>
                          )}
                        </div>
                        <div className="till-line-amount">
                          <strong>{at ? biz.exact((at.net + at.tax) / 100) : "—"}</strong>
                          <button type="button" className="icon-button" onClick={() => removeLine(line.key)} aria-label={`Remove ${line.item.label}`} title="Remove"><Icon name="x" size={16} /></button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
          </SectionCard>
          <SectionCard icon="user" title="Customer" description={customer ? undefined : "Walk-in pays in full. Pick a customer for udhaar. New customers need the network."}
            actions={customer && <button type="button" className="link-button" onClick={() => { setCustomer(null); if (tender === "udhaar") setTender("cash"); }}>Change</button>}>
            {customer ? (
              <div className="stack">
                <div className="rt-customer"><strong>{customer.name}</strong><span className="muted">{customer.phone || "No phone"}</span></div>
                <dl className="rt-risk">
                  <div><dt>Owes</dt><dd>{biz.exact(balance / 100)}</dd></div>
                  {limit !== null && <div className={balance >= limit ? "is-bad" : ""}><dt>Limit left</dt><dd>{biz.exact(Math.max(0, limit - balance) / 100)}</dd></div>}
                </dl>
                <small className="muted">As of {snapshotAge(snapshot.savedAt)}, with this till's waiting bills.</small>
              </div>
            ) : (
              <div className="till-find">
                <input id="till-customer" className="rt-find" value={findCustomer} onChange={(e) => setFindCustomer(e.target.value)} placeholder="Name or phone  (F4)" aria-label="Find a customer by name or phone" autoComplete="off" />
                {customerHits.length > 0 && (
                  <ul className="till-find-list" role="listbox" aria-label="Customers">
                    {customerHits.map((c) => (
                      <li key={c.id}><button type="button" role="option" aria-selected="false" onClick={() => { setCustomer(c); setFindCustomer(""); }}>
                        <strong>{c.name}</strong><small className="muted">{[c.phone, Number(c.balance) > 0.004 ? `owes ${biz.exact(c.balance)}` : null].filter(Boolean).join(" · ")}</small>
                      </button></li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </SectionCard>
          {panNeeded && (
            <SectionCard icon="shield" title="Buyer's PAN" description="A bill over ₹2,00,000 records the buyer's PAN.">
              <Field label="PAN"><input maxLength={10} className="mono" placeholder="ABCDE1234F" disabled={buyer.panDeclaration} value={buyer.pan} onChange={(e) => setBuyer((b) => ({ ...b, pan: e.target.value.toUpperCase() }))} /></Field>
              <label className="checkbox"><input type="checkbox" checked={buyer.panDeclaration} onChange={(e) => setBuyer({ pan: "", panDeclaration: e.target.checked })} /> The buyer has no PAN and signed a declaration (Form 97)</label>
            </SectionCard>
          )}
          <SectionCard icon="wallet" title="3 · Take payment" className="rt-pay">
            <div className="rt-totals rt-totals-large" aria-live="polite">
              <div className="rt-grand"><span>To pay{lines.length ? <small className="muted"> · {lines.length} {lines.length === 1 ? "item" : "items"}</small> : null}</span><strong>{biz.exact(total / 100)}</strong></div>
              <p className="small muted rt-tax-line">{priced ? `${priced.taxMode === "inclusive" ? `Includes GST ${biz.exact(priced.tax / 100)}` : `${biz.exact(priced.subtotal / 100)} + GST ${biz.exact(priced.tax / 100)}`}${priced.roundOff ? ` · round-off ${biz.exact(priced.roundOff / 100)}` : ""}` : "Add items to see the total."}</p>
            </div>
            {canDiscount && lines.length > 0 && (
              <details className="rt-discount" open={Number(discount.value) > 0}>
                <summary>Discount on this bill <small className="muted">(up to {Number(settings.maxDiscountPercent ?? 10)}%)</small></summary>
                <div className="rt-inline">
                  <select aria-label="Discount as" value={discount.mode} onChange={(e) => setDiscount((d) => ({ ...d, mode: e.target.value }))}><option value="amount">{biz.symbol} off</option><option value="percent">% off</option></select>
                  <input aria-label="Discount" type="number" min="0" step="0.01" value={discount.value} onChange={(e) => setDiscount((d) => ({ ...d, value: e.target.value }))} />
                  <input aria-label="Reason for the discount" maxLength={120} placeholder="Reason (needed)" value={discount.reason} onChange={(e) => setDiscount((d) => ({ ...d, reason: e.target.value }))} />
                </div>
              </details>
            )}
            <p className="small muted till-online-only"><Icon name="info" size={13} /> Needs the network: offers and coupons, points, credit vouchers, EMI, returns and exchanges, closing the shift, switching the cashier.</p>
            <div className="segmented rt-tender rt-tender-grid" role="group" aria-label="Paid by">
              {TENDERS.map(([m, word, k]) => (
                <button key={m} type="button" className={`segment ${tender === m ? "is-active" : ""}`} aria-pressed={tender === m}
                  disabled={(m !== "udhaar" && !canPay) || (["upi", "card"].includes(m) && !methodOf(m))} onClick={() => setTender(m)}>{word} {k && <kbd>{k}</kbd>}</button>
              ))}
            </div>
            <form className="stack rt-pay-form" onSubmit={(e) => { e.preventDefault(); take(); }}>
              {tender === "cash" && canPay && (
                <Field label="Cash received" hint={change > 0 ? `Give back ${biz.exact(change / 100)}` : "Leave empty for the exact amount"}>
                  <input type="number" inputMode="decimal" min="0" step="0.01" value={received} onChange={(e) => setReceived(e.target.value)} />
                </Field>
              )}
              {tender === "upi" && (
                <div className="till-upi">
                  {upiLink ? (
                    <>
                      <span className="till-upi-qr" dangerouslySetInnerHTML={{ __html: qrSvg(upiLink, { label: `UPI QR for ${money(total)}` }) }} />
                      <p className="small">Ask the customer to scan and pay <strong>{biz.exact(total / 100)}</strong> to {settings.upiId}. Take the bill once the money shows on your phone or sound box.</p>
                    </>
                  ) : <p className="small">Take {biz.exact(total / 100)} on your UPI QR stand, then take the bill once the money shows.</p>}
                  <Field label="UPI reference (optional)"><input maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
                </div>
              )}
              {tender === "card" && <Field label="Card slip number (optional)" hint="Swipe on the card machine as usual."><input maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
              {tender === "split" && (
                <div className="rt-inline">
                  <Field label="Cash part"><input type="number" inputMode="decimal" min="0" step="0.01" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} /></Field>
                  <Field label={`Rest ${paise(splitCash) < total ? biz.exact((total - Math.min(total, paise(splitCash))) / 100) : ""} by`}>
                    <select value={splitOther} onChange={(e) => setSplitOther(e.target.value)}>{["upi", "card"].filter((k) => methodOf(k)).map((k) => <option key={k} value={k}>{k === "upi" ? "UPI" : "Card"}</option>)}</select>
                  </Field>
                </div>
              )}
              {tender === "udhaar" && customer && canPay && (
                <Field label="Paid now in cash (optional)" hint={`${biz.exact(onCredit / 100)} goes on ${customer.name}'s udhaar.`}>
                  <input type="number" min="0" step="0.01" value={partPaid} onChange={(e) => setPartPaid(e.target.value)} />
                </Field>
              )}
              {settings.pinEveryBill && <p className="small muted"><Icon name="lock" size={13} /> This business asks the biller's PIN for every bill: it cannot be checked offline, so the bill is marked "made offline, no PIN" for the manager.</p>}
              {blocked && priced && <p className="small rt-warn" role="status">{blocked}</p>}
              <button type="submit" className="button rt-post" disabled={!ready}>
                {saving ? "Keeping the bill…" : tender === "udhaar" ? `Put ${biz.exact(onCredit / 100)} on udhaar` : `Take ${biz.exact(total / 100)}${tender !== "cash" && tender !== "split" ? ` by ${tender === "upi" ? "UPI" : "card"}` : ""}`} <kbd>F12</kbd>
              </button>
            </form>
          </SectionCard>
        </div>
      </div>
      {posted && (
        <Modal title={`Bill ${posted.number} kept on this till`} icon="check" onClose={next} width={600}>
          <div className="rt-done">
            <div><span className="muted">Total</span><strong>{biz.exact(posted.total / 100)}</strong></div>
            <div><span className="muted">Paid</span><strong>{biz.exact(posted.paid / 100)}</strong></div>
            {posted.change > 0 && <div className="rt-change"><span>Give back</span><strong>{biz.exact(posted.change / 100)}</strong></div>}
            {posted.udhaar && <div><span className="muted">On {customer?.name}'s udhaar</span><strong>{biz.exact(posted.udhaar.thisBill)} · now owes {biz.exact(posted.udhaar.total)}</strong></div>}
          </div>
          <p className="small muted till-kept"><Icon name="clock" size={14} /> Saved on this computer before printing; it goes to the server by itself when the internet is back.</p>
          <div className="form-actions bz-start">
            <button type="button" className="button" data-autofocus onClick={next}><Icon name="plus" size={15} /> Next bill <kbd>Enter</kbd></button>
            {biz.can("sales.print") && <button type="button" className="button button-secondary" onClick={print}><Icon name="print" size={15} /> Print receipt <kbd>P</kbd></button>}
            <button type="button" className="button button-secondary" onClick={() => setVoiding(posted)}><Icon name="ban" size={15} /> Void…</button>
          </div>
        </Modal>
      )}
      {voiding && <VoidDialog till={till} bill={voiding} onClose={() => setVoiding(null)} onVoided={() => { setVoiding(null); next(); }} />}
    </section>
  );
}

// Voiding a bill on the till before it is sent: it keeps its number and moves nothing.
export function VoidDialog({ till, bill, onClose, onVoided }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const item = till.items.find((each) => each.id === (bill.item?.id || bill.id)) || bill.item || bill;
      await till.voidBill(item, reason.trim());
      onVoided?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const number = bill.number || bill.meta?.number;
  return (
    <Modal title={`Void bill ${number}?`} icon="ban" onClose={onClose} width={520}
      description="The number stays, as a cancelled bill: no stock and no money move. It is never deleted (GST rules). Take back the customer's receipt.">
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        <Field label="Why"><input required maxLength={300} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer changed their mind" /></Field>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>Keep the bill</button>
          <button type="submit" className="button button-danger" disabled={busy || !reason.trim()}>{busy ? "Voiding…" : "Void the bill"}</button>
        </div>
      </form>
    </Modal>
  );
}

