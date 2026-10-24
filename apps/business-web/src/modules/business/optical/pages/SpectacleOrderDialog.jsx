import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import { Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Field, FormError } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { RxTable } from "./RxGrid";
import { COATINGS, COST_BEARERS, EYES, LENS_TYPES, MATERIALS, REMAKE_REASONS, rxSummary } from "./optical";
import "../styles/optical.css";

// Booking a spectacle order, or a remake of a delivered one: the customer's
// prescription (copied onto the order as it is), the frame (from stock, or the
// customer's own), the right and left lens (type, index, material, coatings,
// tint, brand; billed as a lens item, or described and billed on another
// line), other items (a case, the fitting charge, the lab's lens charge), each
// eye's fitting PD and height, where it is made, the promised day, a discount
// and the advance. Every figure is the server's: the same calculation that
// prices a sale of these lines now.

// An advance is taken by the business's own methods of these kinds (no cheques).
const ADVANCE_KINDS = ["cash", "upi", "card", "bank"];
const INDEXES = ["1.50", "1.56", "1.59", "1.60", "1.67", "1.74"];
const blankLens = () => ({ make: true, lensType: "single_vision", skuId: "", index: "", material: "", coatings: [], tint: "", brand: "", description: "" });
let seq = 0;
const blankItem = (extra = {}) => ({ key: `i${(seq += 1)}`, skuId: "", quantity: "1", ...extra });
const half = (pd) => (pd ? (Number(pd) / 2).toFixed(1) : "");

export default function SpectacleOrderDialog({ prescriptionId, remake, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true"]);
  const items = useMemo(() => (options?.["catalog?active=true"] || []).filter((s) => !s.is_kit && !s.internal_use), [options]);
  const skuOf = (skuId) => items.find((s) => String(s.id) === String(skuId)) || null;
  const locations = biz.locations.filter((l) => l.active);
  const today = businessToday(biz.business.timezone);
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [customer, setCustomer] = useState(remake ? { id: remake.contact_id, name: remake.customer_name, phone: remake.customer_phone } : null);
  const [loaded, setHistory] = useState(null);
  const [rxId, setRxId] = useState(prescriptionId ? String(prescriptionId) : remake ? String(remake.prescription_id) : "");
  const [loadError, setLoadError] = useState("");
  const [labs, setLabs] = useState([]);
  const [lenses, setLenses] = useState({ right: blankLens(), left: blankLens() });
  const [extras, setExtras] = useState([]);
  const [form, setForm] = useState(() => ({
    locationId: String(remake?.location_id || locations[0]?.id || ""), frameMode: remake ? "own" : "stock", frameSkuId: "",
    frameDescription: remake ? `Frame of ${remake.order_no}` : "", madeAt: remake?.made_at || "lab", labName: remake?.lab_name || "", labOrderNo: "", promisedOn: "",
    // null until typed: the prescription's PD fills them in (below).
    pdRight: remake?.pd_right ? String(Number(remake.pd_right)) : null, pdLeft: remake?.pd_left ? String(Number(remake.pd_left)) : null,
    heightRight: remake?.fitting_height_right ? String(Number(remake.fitting_height_right)) : "", heightLeft: remake?.fitting_height_left ? String(Number(remake.fitting_height_left)) : "",
    discountMode: "amount", discountValue: "", discountReason: "", advance: "", advanceMethod: "cash", advanceReference: "", notes: "",
    remakeReason: "non_adaptation", remakeCostBy: "lab", remakeNote: "",
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const free = Boolean(remake) && form.remakeCostBy !== "customer";
  const canDiscount = biz.can("sales.discount") && !free;
  const canAdvance = biz.can("sales.edit") && !free;

  // A prescription chosen first (from the list or a customer's page): its customer.
  useEffect(() => {
    if (!prescriptionId || customer) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `optical/prescriptions/${prescriptionId}`, undefined, controller.signal)
      .then((p) => setCustomer({ id: p.contact_id, name: p.customer_name, phone: p.customer_phone }))
      .catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, prescriptionId, customer]);
  // The customer's prescriptions, newest first; the latest unless one was chosen.
  useEffect(() => {
    if (!customer) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `optical/customers/${customer.id}`, undefined, controller.signal)
      .then((h) => { setHistory(h); setRxId((id) => (id && h.prescriptions.some((p) => String(p.id) === id) ? id : String(h.prescriptions[0]?.id || ""))); })
      .catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, customer]);
  // The labs used before, for the lab's name.
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "optical/orders", { limit: 100 }, controller.signal)
      .then((page) => setLabs([...new Set(page.items.map((o) => o.lab_name).filter(Boolean))]))
      .catch(() => {});
    return () => controller.abort();
  }, [biz.id]);
  // The history shown is the chosen customer's (an older answer for another customer is not).
  const history = loaded && customer && Number(loaded.customer.id) === Number(customer.id) ? loaded : null;
  const rx = history?.prescriptions.find((p) => String(p.id) === rxId) || null;
  // Each eye's fitting PD: as typed, else the prescription's (each eye's, or half of both eyes' together).
  const pdRight = form.pdRight ?? (rx ? (rx.pd_right ? String(Number(rx.pd_right)) : half(rx.pd_binocular)) : "");
  const pdLeft = form.pdLeft ?? (rx ? (rx.pd_left ? String(Number(rx.pd_left)) : half(rx.pd_binocular)) : "");

  const setLens = (eye, name, value) => setLenses((all) => ({ ...all, [eye]: { ...all[eye], [name]: value } }));
  const toggleCoating = (eye, coating) => setLenses((all) => {
    const now = all[eye].coatings;
    return { ...all, [eye]: { ...all[eye], coatings: now.includes(coating) ? now.filter((c) => c !== coating) : [...now, coating] } };
  });
  // The left lens as the right; a lens sold by the pair is billed once, on the right lens.
  const leftAsRight = () => setLenses((all) => ({ ...all, left: { ...all.right, skuId: skuOf(all.right.skuId)?.unit === "pair" ? "" : all.right.skuId } }));
  const made = EYES.filter((e) => lenses[e.value].make);
  const needsHeight = made.some((e) => lenses[e.value].lensType !== "single_vision");

  // What the server is asked to price, and to book.
  const order = useMemo(() => {
    if (!rxId || !form.locationId || !made.length) return null;
    const frame = form.frameMode === "own" ? { ownFrame: true, description: form.frameDescription.trim() || "Customer's own frame" } : form.frameSkuId ? { skuId: form.frameSkuId } : null;
    if (!frame) return null;
    const discount = canDiscount && Number(form.discountValue) > 0 && form.discountReason.trim() ? { discount: { [form.discountMode]: form.discountValue, reason: form.discountReason.trim() } } : {};
    return {
      locationId: form.locationId, prescriptionId: rxId, frame,
      lenses: made.map((e) => {
        const l = lenses[e.value];
        return { eye: e.value, lensType: l.lensType, ...(l.skuId ? { skuId: l.skuId } : {}), ...(l.index ? { index: l.index } : {}), ...(l.material ? { material: l.material } : {}),
          coatings: l.coatings, ...(l.tint.trim() ? { tint: l.tint.trim() } : {}), ...(l.brand.trim() ? { brand: l.brand.trim() } : {}), ...(l.description.trim() ? { description: l.description.trim() } : {}) };
      }),
      items: extras.filter((x) => x.skuId && Number(x.quantity) > 0).map((x) => ({ skuId: x.skuId, quantity: x.quantity })),
      ...discount,
      ...(remake ? { remake: { orderId: remake.id, reason: form.remakeReason, costBy: form.remakeCostBy, ...(form.remakeNote.trim() ? { note: form.remakeNote.trim() } : {}) } } : {}),
    };
  }, [rxId, form, made, lenses, extras, canDiscount, remake]);
  const payload = order ? JSON.stringify(order) : null;
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "optical/orders/preview", JSON.parse(payload))
        .then((data) => setQuote({ payload, data, error: "" }))
        .catch((err) => setQuote({ payload, data: null, error: getErrorMessage(err) }));
    }, 300);
    return () => clearTimeout(timer);
  }, [biz.id, payload]);
  const figures = payload && quote?.payload === payload ? quote.data : null;
  const problem = payload && quote?.payload === payload ? quote.error : "";

  const submit = () => {
    if (!customer) throw new Error("Choose the customer");
    if (!rxId) throw new Error("The customer has no prescription yet: record one first");
    if (!made.length) throw new Error("Make the right lens, the left lens or both");
    if (!order) throw new Error("Choose the frame: one from stock, or the customer's own");
    return businessWrite(biz.id, "optical/orders", {
      ...order, requestKey,
      measurements: { pdRight: (lenses.right.make && pdRight) || undefined, pdLeft: (lenses.left.make && pdLeft) || undefined, ...(needsHeight ? { fittingHeightRight: form.heightRight || undefined, fittingHeightLeft: form.heightLeft || undefined } : {}) },
      madeAt: form.madeAt, ...(form.madeAt === "lab" ? { labName: form.labName.trim(), labOrderNo: form.labOrderNo.trim() || undefined } : {}),
      promisedOn: form.promisedOn, notes: form.notes.trim() || undefined,
      ...(canAdvance && Number(form.advance) > 0 ? { advance: { amount: form.advance, ...methods.body(form.advanceMethod, ADVANCE_KINDS), reference: form.advanceReference.trim() || undefined } } : {}),
    });
  };

  const pickItem = (filter) => ({
    options: items.filter(filter), getLabel: (s) => s.label, getKeywords: (s) => `${s.code} ${s.barcode || ""} ${s.product_name || ""}`,
    getDescription: (s) => `${s.code} · ${biz.exact(s.price)}${s.kind === "service" ? " · service" : ` · ${quantity(s.stock, s.unit)} in stock`}`,
  });
  const frameSku = skuOf(form.frameSkuId);
  return (
    <FormDialog title={remake ? `Remake of ${remake.order_no}` : "Book a spectacle order"} icon="clipboard" width={1080} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={remake ? "Book the remake" : "Book the order"} disabled={!options}
      description={remake ? "A new order linked to the delivered one. When the lab or the shop bears the cost, the customer pays nothing." : `Priced exactly as a sale of these items would be now${biz.settings.tax_mode === "inclusive" ? " (prices include GST)" : ""}. The frame and the lenses leave stock when the spectacles are delivered and billed.`}>
      <FormError message={error || loadError} />
      {!options && !error && <div className="field-wide"><Loading label="Loading items…" /></div>}
      {!remake && (
        <div className="field-wide">
          <SearchPicker label="Customer" placeholder="Name or phone" value={customer} onChange={(c) => { setCustomer(c); setRxId(""); }} minChars={2} required
            search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
            getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
        </div>
      )}
      {locations.length > 1 && (
        <Field label="Booked at"><select value={form.locationId} onChange={set("locationId")} disabled={Boolean(remake)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      )}
      {customer && history && (
        history.prescriptions.length ? (
          <>
            <Field label="Prescription" wide>
              <select required value={rxId} onChange={(e) => { setRxId(e.target.value); setForm((f) => ({ ...f, pdRight: null, pdLeft: null })); }}>
                {history.prescriptions.map((p) => <option key={p.id} value={p.id}>{dateShort(p.examined_on, { year: true })} · {p.examiner_name} · {rxSummary(p.rows)}{p.lapsed ? " · lapsed" : ""}</option>)}
              </select>
            </Field>
            {rx && <div className="field-wide"><RxTable rows={rx.rows} caption="The prescription on this order" /></div>}
          </>
        ) : <p className="field-wide opt-note">{customer.name} has no prescription yet: record one under Customers › Prescriptions first.</p>
      )}
      <Field label="Frame">
        <select value={form.frameMode} onChange={set("frameMode")}>
          <option value="stock">From stock</option>
          <option value="own">The customer's own frame</option>
        </select>
      </Field>
      {form.frameMode === "stock" ? (
        <div className="field">
          <SearchPicker label="Frame from stock" placeholder="Name, code or barcode" value={frameSku} required onChange={(s) => setForm((f) => ({ ...f, frameSkuId: s ? String(s.id) : "" }))}
            {...pickItem((s) => s.kind === "goods")} />
        </div>
      ) : (
        <Field label="What the customer's frame is"><input required maxLength={200} value={form.frameDescription} onChange={set("frameDescription")} placeholder="e.g. Black metal, Ray-Ban, scratched left arm" /></Field>
      )}
      {EYES.map((eye) => {
        const l = lenses[eye.value];
        const sku = skuOf(l.skuId);
        const pairOnRight = eye.value === "left" && skuOf(lenses.right.skuId)?.unit === "pair" && lenses.right.make;
        return (
          <div key={eye.value} className="field-wide opt-lens">
            <p className="opt-lens-head">
              <label className="checkbox bz-check"><input type="checkbox" checked={l.make} onChange={(e) => setLens(eye.value, "make", e.target.checked)} /> {eye.label} lens</label>
              {eye.value === "left" && <button type="button" className="button button-secondary button-sm" onClick={leftAsRight}>Same as the right lens</button>}
            </p>
            {l.make && (
              <>
                <Field label="Type">
                  <select value={l.lensType} onChange={(e) => setLens(eye.value, "lensType", e.target.value)}>{LENS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
                </Field>
                <div className="field">
                  <SearchPicker label="Billed as (optional)" placeholder="A lens item" value={sku} onChange={(s) => setLens(eye.value, "skuId", s ? String(s.id) : "")}
                    hint={pairOnRight ? "Sold by the pair: billed once, on the right lens." : "Empty: the lens is billed on another line (the lab's charge)."} {...pickItem(() => true)} />
                </div>
                <Field label="Index">
                  <input list="opt-indexes" inputMode="decimal" value={l.index} onChange={(e) => setLens(eye.value, "index", e.target.value)} placeholder="1.56" />
                </Field>
                <Field label="Material">
                  <select value={l.material} onChange={(e) => setLens(eye.value, "material", e.target.value)}><option value="">—</option>{MATERIALS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select>
                </Field>
                <Field label="Tint (optional)"><input maxLength={60} value={l.tint} onChange={(e) => setLens(eye.value, "tint", e.target.value)} placeholder="e.g. Grey 50%" /></Field>
                <Field label="Brand (optional)"><input maxLength={100} value={l.brand} onChange={(e) => setLens(eye.value, "brand", e.target.value)} placeholder="e.g. Essilor Crizal" /></Field>
                <fieldset className="opt-coatings">
                  <legend>Coatings</legend>
                  {COATINGS.map((c) => <label key={c.value} className="checkbox"><input type="checkbox" checked={l.coatings.includes(c.value)} onChange={() => toggleCoating(eye.value, c.value)} /> {c.label}</label>)}
                </fieldset>
                <Field label="Description (optional)" wide><input maxLength={200} value={l.description} onChange={(e) => setLens(eye.value, "description", e.target.value)} placeholder="Anything else the lab needs" /></Field>
              </>
            )}
          </div>
        );
      })}
      <datalist id="opt-indexes">{INDEXES.map((x) => <option key={x} value={x} />)}</datalist>
      <div className="field-wide">
        <p className="muted small">Other items on the order: a case, the fitting charge, or the lab's charge for lenses not kept as items.</p>
        {extras.map((x) => (
          <div key={x.key} className="opt-item-row">
            <div className="field"><SearchPicker aria-label="Item" placeholder="Name, code or barcode" value={skuOf(x.skuId)}
              onChange={(s) => setExtras((all) => all.map((y) => (y.key === x.key ? { ...y, skuId: s ? String(s.id) : "" } : y)))} {...pickItem(() => true)} /></div>
            <Field label="Qty"><input type="number" min="0.001" step="0.001" value={x.quantity} onChange={(e) => setExtras((all) => all.map((y) => (y.key === x.key ? { ...y, quantity: e.target.value } : y)))} /></Field>
            <button type="button" className="link-button danger" onClick={() => setExtras((all) => all.filter((y) => y.key !== x.key))}>Remove</button>
          </div>
        ))}
        <button type="button" className="button button-secondary button-sm" disabled={extras.length >= 20} onClick={() => setExtras((all) => [...all, blankItem()])}><Icon name="plus" size={14} /> Add an item</button>
      </div>
      {lenses.right.make && <Field label="Fitting PD, right eye (mm)" hint="From the prescription; change it if measured."><input required inputMode="decimal" value={pdRight} onChange={set("pdRight")} placeholder="31.5" /></Field>}
      {lenses.left.make && <Field label="Fitting PD, left eye (mm)"><input required inputMode="decimal" value={pdLeft} onChange={set("pdLeft")} placeholder="31.5" /></Field>}
      {needsHeight && lenses.right.make && lenses.right.lensType !== "single_vision" && <Field label="Fitting height, right eye (mm)"><input required inputMode="decimal" value={form.heightRight} onChange={set("heightRight")} placeholder="18" /></Field>}
      {needsHeight && lenses.left.make && lenses.left.lensType !== "single_vision" && <Field label="Fitting height, left eye (mm)"><input required inputMode="decimal" value={form.heightLeft} onChange={set("heightLeft")} placeholder="18" /></Field>}
      <Field label="Made">
        <select value={form.madeAt} onChange={set("madeAt")}><option value="lab">At a lab</option><option value="in_house">In our workshop</option></select>
      </Field>
      {form.madeAt === "lab" && (
        <>
          <Field label="Lab's name"><input required maxLength={150} list="opt-labs" value={form.labName} onChange={set("labName")} /><datalist id="opt-labs">{labs.map((n) => <option key={n} value={n} />)}</datalist></Field>
          <Field label="Lab's order number (optional)" hint="Or add it when the order goes to the lab."><input maxLength={60} value={form.labOrderNo} onChange={set("labOrderNo")} /></Field>
        </>
      )}
      <Field label="Promised for"><input type="date" required min={today} value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      {remake && (
        <>
          <Field label="Why it is made again"><select value={form.remakeReason} onChange={set("remakeReason")}>{REMAKE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
          <Field label="Who bears the cost" hint={free ? "The customer pays nothing for this order." : "Priced as any order."}>
            <select value={form.remakeCostBy} onChange={set("remakeCostBy")}>{COST_BEARERS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
          </Field>
          <Field label="Note on the remake (optional)" wide><input maxLength={300} value={form.remakeNote} onChange={set("remakeNote")} placeholder="e.g. Blurred at the edges after two weeks" /></Field>
        </>
      )}
      {canDiscount && (
        <>
          <Field label="Discount (optional)">
            <span className="opt-inline">
              <select aria-label="Discount as" value={form.discountMode} onChange={set("discountMode")}><option value="amount">{biz.symbol} off</option><option value="percent">% off</option></select>
              <input aria-label="Discount" type="number" min="0" step="0.01" value={form.discountValue} onChange={set("discountValue")} />
            </span>
          </Field>
          <Field label="Reason for the discount"><input maxLength={120} required={Number(form.discountValue) > 0} value={form.discountReason} onChange={set("discountReason")} placeholder="e.g. Regular customer" /></Field>
        </>
      )}
      {canAdvance && (
        <>
          <Field label="Advance taken (optional)" hint="Taken off the bill at delivery."><input type="number" min="0" step="1" value={form.advance} onChange={set("advance")} /></Field>
          {Number(form.advance) > 0 && (
            <>
              <Field label="Advance paid by"><select value={methods.resolve(form.advanceMethod, ADVANCE_KINDS)} onChange={set("advanceMethod")}>{methods.options(ADVANCE_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
              <Field label="Reference (optional)"><input maxLength={100} value={form.advanceReference} onChange={set("advanceReference")} /></Field>
            </>
          )}
        </>
      )}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Thin lenses; customer collects after 6 pm" /></Field>
      <div className="field-wide" aria-live="polite">
        {problem ? <p className="bz-due small" role="alert">{problem}</p> : !payload ? <p className="muted small">Choose the prescription, the frame and the lenses to see the price.</p>
          : !figures ? <p className="muted small">Working out the price…</p> : (
            <p className="opt-total">
              {figures.lines.map((l, i) => <span key={i}>{l.label}: {biz.exact(Number(l.net) + Number(l.tax))}</span>)}
              {Number(figures.savings) > 0 && <span>Saves {biz.exact(figures.savings)}</span>}
              <span>GST {biz.exact(figures.tax)}</span>
              <strong>Total {biz.exact(figures.total)}{Number(form.advance) > 0 && canAdvance ? ` · to pay at delivery ${biz.exact(Math.max(0, Number(figures.total) - Number(form.advance)))}` : ""}</strong>
            </p>
          )}
      </div>
    </FormDialog>
  );
}
