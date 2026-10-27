import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useDirtyGuard, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { DEFECTS, rateWords } from "./laundry";
import "../styles/laundry.css";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// Taking in a garment order at the counter, fast: the customer (found by name
// or phone, or typed new), a button for each garment on the price list, and
// one line a tagged garment (or a bundle by the kilo, weighed and counted)
// with its service, colour and brand; what was noted about it (its defects,
// the customer's instructions, what they were told about the risk to it and
// whether they acknowledged it, a value they declared); express or not; the
// promised day; and the advance (billed at delivery) or the payment now
// (billed at intake). Every figure is the server's, worked out as the order
// will be kept. The tags are the next numbers unless one is typed.

const PAY_KINDS = ["cash", "upi", "card", "bank"];
let seq = 0;
const blankLine = (extra = {}) => ({ key: `l${(seq += 1)}`, garmentTypeId: "", serviceId: "", quantity: "1", pieces: "", colour: "", brand: "", tagNo: "", defects: [],
  defectNote: "", instructions: "", riskNote: "", acknowledged: false, declaredValue: "", open: false, ...extra });

export default function IntakePage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const methods = usePaymentMethods();
  const today = businessToday(biz.business.timezone);
  const locations = biz.locations.filter((l) => l.active);
  const [list, setList] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [requestKey, setRequestKey] = useState(newKey);
  const [customer, setCustomer] = useState(null);
  const [typedCustomer, setTypedCustomer] = useState(null);
  const [lines, setLines] = useState([]);
  const [form, setForm] = useState({ locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""), express: false, promisedOn: "", notes: "",
    money: "", method: "cash", reference: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canTake = biz.can("laundry.create");
  const canPay = biz.can("sales.edit");
  useDirtyGuard(lines.length > 0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "laundry/price-list", undefined, controller.signal).then(setList).catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const garments = useMemo(() => (list?.garments || []).filter((g) => g.active), [list]);
  const services = useMemo(() => (list?.services || []).filter((s) => s.active && s.item_active), [list]);
  const priceOf = (garmentTypeId, serviceId) => (list?.prices || []).find((p) => String(p.garment_type_id) === String(garmentTypeId) && String(p.service_id) === String(serviceId)) || null;
  const servicesFor = (garmentTypeId) => services.filter((s) => priceOf(garmentTypeId, s.id));
  const garmentOf = (garmentTypeId) => garments.find((g) => String(g.id) === String(garmentTypeId)) || null;
  const setLine = (k, change) => setLines((all) => all.map((l) => (l.key === k ? { ...l, ...change } : l)));
  // A garment button: a new line with the service last used for it (or the first it has a price for).
  const addGarment = (g) => {
    const last = [...lines].reverse().find((l) => String(l.garmentTypeId) === String(g.id) && l.serviceId);
    const service = last?.serviceId || String(servicesFor(g.id)[0]?.id || "");
    setLines((all) => [...all, blankLine({ garmentTypeId: String(g.id), serviceId: service })]);
  };
  const copyLine = (l) => setLines((all) => {
    const index = all.findIndex((x) => x.key === l.key);
    // Another bundle by the kilo is weighed on its own.
    return [...all.slice(0, index + 1), blankLine({ garmentTypeId: l.garmentTypeId, serviceId: l.serviceId, quantity: l.weighed ? "1" : l.quantity, colour: l.colour, brand: l.brand }),
      ...all.slice(index + 1)];
  });
  const toggleDefect = (l, d) => setLine(l.key, { defects: l.defects.includes(d) ? l.defects.filter((x) => x !== d) : [...l.defects, d] });

  // What the server is asked to price, and to take in.
  const itemsBody = (all) => all.filter((l) => l.garmentTypeId && l.serviceId).map((l) => {
    const kg = priceOf(l.garmentTypeId, l.serviceId)?.per === "kg";
    // A bundle by the kilo goes with the weight typed, never a count; the server asks for it until it is weighed.
    return {
      garmentTypeId: l.garmentTypeId, serviceId: l.serviceId, quantity: (kg ? (l.weighed ? l.quantity : "") : l.quantity) || undefined, ...(kg || l.pieces ? { pieces: l.pieces || undefined } : {}),
      ...(l.tagNo.trim() ? { tagNo: l.tagNo.trim() } : {}), ...(l.colour.trim() ? { colour: l.colour.trim() } : {}), ...(l.brand.trim() ? { brand: l.brand.trim() } : {}),
      ...(l.defects.length ? { defects: l.defects } : {}), ...(l.defectNote.trim() ? { defectNote: l.defectNote.trim() } : {}),
      ...(l.instructions.trim() ? { instructions: l.instructions.trim() } : {}), ...(l.riskNote.trim() ? { riskNote: l.riskNote.trim() } : {}),
      ...(l.acknowledged ? { acknowledged: true } : {}), ...(l.declaredValue ? { declaredValue: l.declaredValue } : {}),
    };
  });
  const payload = useMemo(() => {
    const items = itemsBody(lines);
    if (!items.length || !form.locationId) return null;
    return JSON.stringify({ locationId: form.locationId, express: form.express, items });
  }, [lines, form.locationId, form.express]); // eslint-disable-line react-hooks/exhaustive-deps
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "laundry/orders/preview", JSON.parse(payload))
        .then((data) => setQuote({ payload, data, error: "" }))
        .catch((err) => setQuote({ payload, data: null, error: getErrorMessage(err) }));
    }, 250);
    return () => clearTimeout(timer);
  }, [biz.id, payload]);
  const figures = payload && quote?.payload === payload ? quote.data : null;
  const problem = payload && quote?.payload === payload ? quote.error : "";
  // The figures of each complete line, in the order sent.
  const complete = lines.filter((l) => l.garmentTypeId && l.serviceId);
  const figureOf = (l) => (figures ? figures.items[complete.findIndex((x) => x.key === l.key)] : null);
  const billAt = figures?.billAt || list?.settings.billAt || "delivery";
  const promisedOn = form.promisedOn || figures?.promisedOn || "";

  const reset = () => {
    setLines([]); setCustomer(null); setTypedCustomer(null); setQuote(null); setRequestKey(newKey());
    setForm((f) => ({ ...f, express: false, promisedOn: "", notes: "", money: "", reference: "" }));
  };
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!customer && !typedCustomer?.name?.trim()) return setError("Choose the customer, or type the new customer's name");
    const items = itemsBody(lines);
    if (!items.length) return setError("Add the garments taken in");
    if (!promisedOn) return setError("Choose the promised day");
    const amount = canPay && Number(form.money) > 0 ? form.money : null;
    setBusy(true);
    try {
      const order = await businessWrite(biz.id, "laundry/orders", {
        requestKey, locationId: form.locationId, ...(customer ? { contactId: customer.id } : { customer: { name: typedCustomer.name.trim(), phone: typedCustomer.phone?.trim() || undefined,
          consents: consentChanges(typedCustomer.consents, []) || undefined } }),
        express: form.express, promisedOn, notes: form.notes.trim() || undefined, items,
        ...(amount && billAt === "delivery" ? { advance: { amount, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
        ...(amount && billAt === "intake" ? { payment: { amount: Math.abs(Number(amount) - Number(figures?.total || 0)) < 0.005 ? "full" : amount, ...methods.body(form.method, PAY_KINDS),
          reference: form.reference.trim() || undefined } } : {}),
      });
      toast.success(`Order ${order.order_no} taken in: tags ${order.items.map((i) => i.tag_no).join(", ")}.`);
      reset();
      navigate(biz.path(`garment-orders/${order.id}?taken=1`));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!list) return <div className="stack"><BusinessHeader icon="clipboard" title="New order" /><ErrorMessage message={loadError} />{!loadError && <Loading label="Loading the price list…" />}</div>;
  if (!canTake) return <div className="stack"><BusinessHeader icon="clipboard" title="New order" /><p className="ldy-note">Your role does not take orders in.</p></div>;
  const ready = garments.some((g) => servicesFor(g.id).length);
  return (
    <form className="stack" onSubmit={submit}>
      <BusinessHeader icon="clipboard" title="New order"
        description={`Each garment gets a tag and is priced from the price list${list.settings.expressPercent !== "0.00" ? `; express adds ${Number(list.settings.expressPercent)}%` : ""}. Billed ${billAt === "intake" ? "now, when the order is taken in" : "when the garments are handed over"}.`}
        secondary={<Link className="button button-secondary" to={biz.path("garment-orders")}><Icon name="list" size={15} /> Orders</Link>} />
      {!ready && <p className="ldy-note ldy-warn">The price list has no prices yet: add the services, the garments and their prices under Services & items › Price list first.</p>}
      <SectionCard icon="user" title="Customer">
        <div className="ldy-customer">
          {typedCustomer ? (
            <>
              <Field label="Name"><input required maxLength={150} autoFocus value={typedCustomer.name} onChange={(e) => setTypedCustomer((c) => ({ ...c, name: e.target.value }))} /></Field>
              <Field label="Phone"><input inputMode="tel" maxLength={30} value={typedCustomer.phone} onChange={(e) => setTypedCustomer((c) => ({ ...c, phone: e.target.value }))} /></Field>
              <NewCustomerConsents value={typedCustomer.consents} onChange={(consents) => setTypedCustomer((c) => ({ ...c, consents }))} />
              <button type="button" className="link-button" onClick={() => setTypedCustomer(null)}>Find a customer instead</button>
            </>
          ) : (
            <>
              <div className="field ldy-grow">
                <SearchPicker label="Customer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
                  search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                  getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
              </div>
              {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setCustomer(null); setTypedCustomer({ name: "", phone: "" }); }}><Icon name="user-plus" size={15} /> New customer</button>}
            </>
          )}
          {locations.length > 1 && <Field label="Taken in at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
        </div>
      </SectionCard>
      <SectionCard icon="tag" title="Garments" description="Tap a garment to add it; each line is one tagged garment (or several of a kind under one tag), or a bundle weighed by the kilo.">
        <div className="ldy-garment-buttons" role="group" aria-label="Add a garment">
          {garments.filter((g) => servicesFor(g.id).length).map((g) => (
            <button key={g.id} type="button" className="ldy-garment-button" onClick={() => addGarment(g)}><Icon name="plus" size={13} /> {g.name}</button>
          ))}
        </div>
        {lines.length === 0 ? <p className="ldy-note">No garments yet.</p> : (
          <ol className="ldy-lines">
            {lines.map((l, index) => {
              const price = priceOf(l.garmentTypeId, l.serviceId);
              const kg = price?.per === "kg";
              const f = figureOf(l);
              const g = garmentOf(l.garmentTypeId);
              return (
                <li key={l.key} className="ldy-line">
                  <div className="ldy-line-main">
                    <span className="ldy-line-no" aria-hidden="true">{index + 1}</span>
                    <Field label="Garment">
                      <select value={l.garmentTypeId} onChange={(e) => setLine(l.key, { garmentTypeId: e.target.value, serviceId: String(servicesFor(e.target.value)[0]?.id || ""), quantity: "1", weighed: false })}>
                        <option value="">Choose…</option>{garments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Service">
                      <select value={l.serviceId} onChange={(e) => setLine(l.key, { serviceId: e.target.value, quantity: "1", weighed: false })}>
                        <option value="">Choose…</option>
                        {servicesFor(l.garmentTypeId).map((s) => <option key={s.id} value={s.id}>{s.name} · {rateWords(biz.exact, priceOf(l.garmentTypeId, s.id))}</option>)}
                      </select>
                    </Field>
                    {kg ? (
                      <>
                        <Field label="Weight (kg)"><input type="number" min="0.001" step="0.001" inputMode="decimal" required value={l.weighed ? l.quantity : ""}
                          onChange={(e) => setLine(l.key, { quantity: e.target.value, weighed: true })} placeholder="2.5" /></Field>
                        <Field label="Pieces"><input type="number" min="1" max="999" required value={l.pieces} onChange={(e) => setLine(l.key, { pieces: e.target.value })} /></Field>
                      </>
                    ) : (
                      <Field label={g?.counted_as === "pair" ? "Pairs" : g?.counted_as === "set" ? "Sets" : "How many"}>
                        <input type="number" min="1" max="999" step="1" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />
                      </Field>
                    )}
                    <Field label="Colour"><input maxLength={40} value={l.colour} onChange={(e) => setLine(l.key, { colour: e.target.value })} /></Field>
                    <Field label="Brand"><input maxLength={60} value={l.brand} onChange={(e) => setLine(l.key, { brand: e.target.value })} /></Field>
                    <span className="ldy-line-amount" aria-live="polite">{f ? biz.exact(Number(f.amount) + (figures.taxMode === "exclusive" ? Number(f.tax) : 0)) : ""}</span>
                    <span className="ldy-line-actions">
                      <button type="button" className={`chip-button ${l.defects.length || l.riskNote || l.defectNote ? "is-marked" : ""}`} aria-expanded={l.open} onClick={() => setLine(l.key, { open: !l.open })}>
                        <Icon name="alert" size={13} /> Noted{l.defects.length ? ` (${l.defects.length})` : ""}
                      </button>
                      <button type="button" className="chip-button" onClick={() => copyLine(l)} title="Another of the same, with its own tag"><Icon name="copy" size={13} /> Another</button>
                      <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>
                    </span>
                  </div>
                  {l.open && (
                    <div className="ldy-line-details">
                      <fieldset className="ldy-defects">
                        <legend>Defects seen at intake</legend>
                        {DEFECTS.map((d) => <label key={d.value} className="checkbox"><input type="checkbox" checked={l.defects.includes(d.value)} onChange={() => toggleDefect(l, d.value)} /> {d.label}</label>)}
                      </fieldset>
                      <Field label="Note on the defects"><input maxLength={300} value={l.defectNote} onChange={(e) => setLine(l.key, { defectNote: e.target.value })} placeholder="e.g. Ink mark on the left cuff" /></Field>
                      <Field label="Customer's instructions"><input maxLength={300} value={l.instructions} onChange={(e) => setLine(l.key, { instructions: e.target.value })} placeholder="e.g. No starch; fold, do not hang" /></Field>
                      <Field label="What the customer was told about the risk" wide hint="Records what was said and acknowledged; it never limits a claim.">
                        <input maxLength={300} value={l.riskNote} onChange={(e) => setLine(l.key, { riskNote: e.target.value })} placeholder="e.g. Old silk: colour may run; taken at the owner's risk" />
                      </Field>
                      <label className="checkbox bz-check"><input type="checkbox" checked={l.acknowledged} onChange={(e) => setLine(l.key, { acknowledged: e.target.checked })} /> The customer saw and acknowledged this</label>
                      <Field label="Value declared (optional)"><input type="number" min="0.01" step="0.01" value={l.declaredValue} onChange={(e) => setLine(l.key, { declaredValue: e.target.value })} /></Field>
                      <Field label="Tag (optional)" hint="Empty: the next number."><input maxLength={20} className="mono" value={l.tagNo} onChange={(e) => setLine(l.key, { tagNo: e.target.value })} /></Field>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>
      <SectionCard icon="calendar" title="Promised day and money">
        <div className="form-grid bz-form">
          <label className="checkbox bz-check"><input type="checkbox" checked={form.express} onChange={set("express")} /> Express{Number(list.settings.expressPercent) > 0 ? ` (+${Number(list.settings.expressPercent)}% on each garment)` : ""}</label>
          <Field label="Promised for"><input type="date" required min={today} value={promisedOn} onChange={set("promisedOn")} /></Field>
          {canPay && (
            <>
              <Field label={billAt === "intake" ? "Paid now (optional)" : "Advance taken (optional)"} hint={billAt === "intake" ? "The rest stays on the customer's dues." : "Taken off the bill when the garments are handed over."}>
                <input type="number" min="0" step="0.01" value={form.money} onChange={set("money")} />
              </Field>
              {Number(form.money) > 0 && (
                <>
                  <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
                  <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
                </>
              )}
            </>
          )}
          <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Customer collects after 7 pm" /></Field>
        </div>
      </SectionCard>
      <div className="ldy-total" aria-live="polite">
        {problem ? <p className="bz-due small" role="alert">{problem}</p> : !payload ? <span className="muted small">Add the garments to see the price.</span> : !figures ? <span className="muted small">Working out the price…</span> : (
          <>
            <span>{figures.items.length} {figures.items.length === 1 ? "line" : "lines"} · {figures.pieces} {figures.pieces === 1 ? "piece" : "pieces"}</span>
            <span>Before GST {biz.exact(figures.subtotal)}</span>
            <span>GST {biz.exact(figures.tax)}</span>
            <strong>Total {biz.exact(figures.total)}{Number(form.money) > 0 && canPay ? ` · to pay later ${biz.exact(Math.max(0, Number(figures.total) - Number(form.money)))}` : ""}</strong>
          </>
        )}
        <ErrorMessage message={error} />
        <div className="form-actions">
          {lines.length > 0 && <button type="button" className="button button-secondary" disabled={busy} onClick={reset}>Clear</button>}
          <button type="submit" className="button" disabled={busy || !lines.length}><Icon name="check" size={16} /> {busy ? "Taking in…" : "Take in the order"}</button>
        </div>
      </div>
    </form>
  );
}
