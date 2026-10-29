import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useDirtyGuard, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { addHours, nowInput, rateWords, unitWords, zonedInput } from "./rentals";
import "../styles/rentals.css";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// A booking made at the counter, or a quote: the hirer (found by name or
// phone, or typed new), when it goes out and when it is due back (typed on
// the shop's clock), and what is hired: a button for each rental item, a unit
// of an item hired one by one (each marked free or not over that time), or how
// many from a pool or kits (with how many are free at the booking's
// location; a kit by its scarcest part). Every figure is the server's: the
// cheapest mix of the item's rates for the hours, a discount on the hire for
// those who may give one (within the business's most), GST at its slab, the
// deposit asked. A reserved booking holds what it books; the server refuses
// anything not free. With ?edit=<id>, a quote or a reserved booking changes its
// times, lines and discount (lines kept keep their booked rates).

const PAY_KINDS = ["cash", "upi", "card", "bank"];
const QUICK = [{ hours: 4, label: "4 hours" }, { hours: 24, label: "1 day" }, { hours: 72, label: "3 days" }, { hours: 168, label: "1 week" }];
let seq = 0;
const blankLine = (extra = {}) => ({ key: `l${(seq += 1)}`, itemId: "", unitId: "", quantity: "1", ...extra });

export default function BookingFormPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const methods = usePaymentMethods();
  const [params] = useSearchParams();
  const editId = params.get("edit");
  const locations = biz.locations.filter((l) => l.active);
  const [items, setItems] = useState(null);
  const [existing, setExisting] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [requestKey, setRequestKey] = useState(newKey);
  const [customer, setCustomer] = useState(null);
  const [typed, setTyped] = useState(null);
  const [lines, setLines] = useState([]);
  const [form, setForm] = useState(() => {
    const out = nowInput(biz);
    return { locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""), outAt: out, dueAt: addHours(out, 24), quote: false, notes: "",
      advance: "", method: "cash", reference: "", discount: "", discountReason: "" };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canPay = biz.can("sales.edit");
  const canDiscount = biz.can("sales.discount");
  useDirtyGuard(lines.length > 0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "rentals/items", undefined, controller.signal).then((r) => setItems(r.items.filter((i) => i.active)))
      .catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    if (editId) {
      businessRead(biz.id, `rentals/bookings/${editId}`, undefined, controller.signal).then((b) => {
        setExisting(b);
        setForm((f) => ({ ...f, outAt: zonedInput(b.out_at, biz), dueAt: zonedInput(b.due_at, biz), notes: b.notes || "", locationId: String(b.location_id),
          discount: Number(b.discount_percent) ? String(Number(b.discount_percent)) : "", discountReason: b.discount_reason || "" }));
        setLines(b.lines.filter((l) => !l.kit_line_id).map((l) => blankLine({ itemId: String(l.item_id), unitId: l.unit_id ? String(l.unit_id) : "", quantity: String(l.quantity) })));
      }).catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    }
    return () => controller.abort();
  }, [biz.id, editId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const itemOf = (itemId) => (items || []).find((i) => String(i.id) === String(itemId)) || null;
  const setLine = (k, change) => setLines((all) => all.map((l) => (l.key === k ? { ...l, ...change } : l)));
  const timesValid = form.outAt && form.dueAt && form.dueAt > form.outAt;

  // What is free over the booking's time (this booking's own holds left out when it is being changed).
  const [free, setFree] = useState(null);
  useEffect(() => {
    if (!timesValid) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessRead(biz.id, "rentals/free", { outAt: form.outAt, dueAt: form.dueAt, location: form.locationId || undefined, ...(editId ? { booking: editId } : {}) }, controller.signal)
        .then((r) => setFree({ key: `${form.outAt}|${form.dueAt}`, items: r.items })).catch(() => {});
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [biz.id, form.outAt, form.dueAt, form.locationId, editId, timesValid]);
  const freeOf = (itemId) => free?.items.find((i) => String(i.itemId) === String(itemId)) || null;
  const unitFree = (itemId, unitId) => freeOf(itemId)?.units?.find((u) => String(u.id) === String(unitId)) || null;

  // A button for each item: a new line, with the first unit free then (for an item hired one by one).
  const addItem = (item) => {
    const taken = lines.filter((l) => String(l.itemId) === String(item.id)).map((l) => String(l.unitId));
    if (item.kind !== "unit" && taken.length) return;
    const candidates = (freeOf(item.id)?.units || []).filter((u) => u.free && !taken.includes(String(u.id)));
    const unit = item.kind === "unit" ? String(candidates[0]?.id || item.units.find((u) => u.status !== "retired" && !taken.includes(String(u.id)))?.id || "") : "";
    setLines((all) => [...all, blankLine({ itemId: String(item.id), unitId: unit })]);
  };
  const body = useMemo(() => lines.filter((l) => l.itemId).map((l) => (itemOf(l.itemId)?.kind === "unit" ? { itemId: l.itemId, unitId: l.unitId || undefined }
    : { itemId: l.itemId, quantity: l.quantity || undefined })), [lines, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const discount = canDiscount && Number(form.discount) > 0 ? { percent: form.discount, reason: form.discountReason.trim() || "Discount" } : null;
  const payload = timesValid && body.length ? JSON.stringify({ locationId: form.locationId, outAt: form.outAt, dueAt: form.dueAt, lines: body, ...(discount ? { discount } : {}),
    ...(editId ? { bookingId: editId } : {}) }) : null;
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "rentals/bookings/preview", JSON.parse(payload))
        .then((data) => setQuote({ payload, data, error: "" })).catch((err) => setQuote({ payload, data: null, error: getErrorMessage(err) }));
    }, 300);
    return () => clearTimeout(timer);
  }, [biz.id, payload]);
  const figures = payload && quote?.payload === payload ? quote.data : null;
  const problem = payload && quote?.payload === payload ? quote.error : "";
  const complete = lines.filter((l) => l.itemId);
  const figureOf = (l) => (figures ? figures.lines[complete.findIndex((x) => x.key === l.key)] : null);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!existing && !customer && !typed?.name?.trim()) return setError("Choose the hirer, or type the new hirer's name");
    if (!body.length) return setError("Add what is hired out");
    if (!timesValid) return setError("The due back time is after the out time");
    if (canDiscount && Number(form.discount) > 0 && !form.discountReason.trim()) return setError("Give the reason for the discount");
    const discountBody = canDiscount ? { discount: Number(form.discount) > 0 ? { percent: form.discount, reason: form.discountReason.trim() } : null } : {};
    const advance = canPay && !form.quote && Number(form.advance) > 0 ? form.advance : null;
    setBusy(true);
    try {
      const booking = existing
        ? await businessWrite(biz.id, `rentals/bookings/${existing.id}`, { outAt: form.outAt, dueAt: form.dueAt, lines: body, notes: form.notes.trim() || null, ...discountBody }, "patch")
        : await businessWrite(biz.id, "rentals/bookings", {
          requestKey, locationId: form.locationId, status: form.quote ? "quote" : "reserved", outAt: form.outAt, dueAt: form.dueAt, lines: body, notes: form.notes.trim() || undefined,
          ...(discountBody.discount ? discountBody : {}),
          ...(customer ? { contactId: customer.id } : { customer: { name: typed.name.trim(), phone: typed.phone?.trim() || undefined, consents: consentChanges(typed.consents, []) || undefined } }),
          ...(advance ? { advance: { amount: advance, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
        });
      toast.success(existing ? `Booking ${booking.booking_no} changed.` : `${booking.status === "quote" ? "Quote" : "Booking"} ${booking.booking_no} saved.`);
      setLines([]);
      setRequestKey(newKey());
      navigate(biz.path(`rental-bookings/${booking.id}`));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const title = existing ? `Change ${existing.booking_no}` : "New booking";
  if (!items || (editId && !existing)) return <div className="stack"><BusinessHeader icon="calendar" title={title} /><ErrorMessage message={loadError} />{!loadError && <Loading label="Loading the rental items…" />}</div>;
  if (!biz.can(existing ? "rentals.edit" : "rentals.create")) return <div className="stack"><BusinessHeader icon="calendar" title={title} /><p className="rnt-note">Your role does not make bookings.</p></div>;
  return (
    <form className="stack" onSubmit={submit}>
      <BusinessHeader icon="calendar" title={title}
        description="Each line is priced at the cheapest mix of the item's hour, day, week and month rates for the hours booked, with GST at its slab. Times are the shop's own clock."
        secondary={<Link className="button button-secondary" to={biz.path(existing ? `rental-bookings/${existing.id}` : "rental-bookings")}><Icon name="list" size={15} /> {existing ? "Back to the booking" : "Bookings"}</Link>} />
      {!items.length && <p className="rnt-note rnt-warn">No rental items yet: add what is hired out under Rental items first.</p>}
      <SectionCard icon="user" title="Hirer">
        {existing ? <p className="rnt-note">{existing.customer_name}{existing.customer_phone ? ` · ${existing.customer_phone}` : ""}</p> : (
          <div className="rnt-customer">
            {typed ? (
              <>
                <Field label="Name"><input required maxLength={150} autoFocus value={typed.name} onChange={(e) => setTyped((c) => ({ ...c, name: e.target.value }))} /></Field>
                <Field label="Phone"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((c) => ({ ...c, phone: e.target.value }))} /></Field>
                <NewCustomerConsents value={typed.consents} onChange={(consents) => setTyped((c) => ({ ...c, consents }))} />
                <button type="button" className="link-button" onClick={() => setTyped(null)}>Find a hirer instead</button>
              </>
            ) : (
              <>
                <div className="field rnt-grow">
                  <SearchPicker label="Hirer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
                    search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                    getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
                </div>
                {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setCustomer(null); setTyped({ name: "", phone: "" }); }}><Icon name="user-plus" size={15} /> New hirer</button>}
              </>
            )}
            {locations.length > 1 && <Field label="Booked at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
          </div>
        )}
      </SectionCard>
      <SectionCard icon="clock" title="When" description="Typed on the shop's clock. An hour or part of one counts as an hour.">
        <div className="rnt-when">
          <Field label="Out from"><input type="datetime-local" required value={form.outAt} disabled={existing?.status === "out"} onChange={set("outAt")} /></Field>
          <Field label="Due back by"><input type="datetime-local" required min={form.outAt} value={form.dueAt} onChange={set("dueAt")} /></Field>
          <div className="rnt-quick" role="group" aria-label="Hire for">
            {QUICK.map((q) => <button key={q.hours} type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, dueAt: addHours(f.outAt, q.hours) }))}>{q.label}</button>)}
            {!existing && <button type="button" className="chip-button" onClick={() => setForm((f) => { const out = nowInput(biz); return { ...f, outAt: out, dueAt: f.dueAt > out ? f.dueAt : addHours(out, 24) }; })}>Out now</button>}
          </div>
        </div>
        {!timesValid && <p className="bz-due small" role="alert">The due back time is after the out time.</p>}
      </SectionCard>
      <SectionCard icon="box" title="What is hired" description="Tap an item to add it. A unit is hired by its number; a pool by how many.">
        <div className="rnt-item-buttons" role="group" aria-label="Add an item">
          {items.map((item) => (
            <button key={item.id} type="button" className="rnt-item-button" onClick={() => addItem(item)} disabled={item.kind !== "unit" && lines.some((l) => String(l.itemId) === String(item.id))}>
              <Icon name="plus" size={13} /> {item.name}
            </button>
          ))}
        </div>
        {lines.length === 0 ? <p className="rnt-note">Nothing added yet.</p> : (
          <ol className="rnt-lines">
            {lines.map((l, index) => {
              const item = itemOf(l.itemId);
              const f = figureOf(l);
              const pool = item && item.kind !== "unit" ? freeOf(item.id) : null;
              return (
                <li key={l.key} className={`rnt-line ${f && f.free === false ? "is-clash" : ""}`}>
                  <div className="rnt-line-main">
                    <span className="rnt-line-no" aria-hidden="true">{index + 1}</span>
                    <span className="rnt-line-item"><strong>{item?.name || "Item"}</strong><small className="muted">{item ? rateWords(item, biz.exact) : ""}</small></span>
                    {item?.kind === "unit" ? (
                      <Field label="Unit">
                        <select required value={l.unitId} onChange={(e) => setLine(l.key, { unitId: e.target.value })}>
                          <option value="">Choose…</option>
                          {item.units.filter((u) => u.status !== "retired").map((u) => {
                            const state = unitFree(item.id, u.id);
                            return <option key={u.id} value={u.id}>{unitWords(u.label, u.serial_no)}{u.status === "maintenance" ? " · in maintenance" : ""}{state && !state.free ? ` · booked (${state.clash.bookingNo})` : ""}</option>;
                          })}
                        </select>
                      </Field>
                    ) : (
                      <Field label={pool ? (item.kind === "kit" ? `How many kits (${pool.free} free)` : `How many (${pool.free} of ${pool.poolQuantity} free)`) : "How many"}>
                        <input type="number" min="1" step="1" required value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />
                      </Field>
                    )}
                    <span className="rnt-line-figure" aria-live="polite">
                      {f ? <><strong>{biz.exact(f.amount)}</strong><small className="muted">{f.period}{Number(f.deposit) > 0 ? ` · deposit ${biz.exact(f.deposit)}` : ""}</small></> : ""}
                    </span>
                    <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>
                  </div>
                  {f && f.parts?.length > 0 && <p className="rnt-parts small muted">{f.parts.map((x) => `${x.quantity} × ${x.itemName}${x.billed ? ` ${biz.exact(x.amount)}` : ""}`).join(" · ")}</p>}
                  {f && f.free === false && <p className="rnt-clash" role="alert">{f.words}</p>}
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>
      <SectionCard icon="wallet" title={existing ? "Notes" : "Advance and notes"}>
        <div className="form-grid bz-form">
          {!existing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.quote} onChange={set("quote")} /> Save as a quote: it holds nothing until it is reserved</label>}
          {canDiscount && (
            <>
              <Field label="Discount on the hire (%)" hint={`At most ${Number(biz.settings.max_bill_discount_percent ?? 10)}%${biz.can("settings.edit") ? " (Business settings)" : ""}; billed on every line's hire.`}>
                <input type="number" min="0" max="100" step="0.01" value={form.discount} onChange={set("discount")} />
              </Field>
              {Number(form.discount) > 0 && <Field label="Reason for the discount"><input required maxLength={300} value={form.discountReason} onChange={set("discountReason")} placeholder="e.g. Regular customer" /></Field>}
            </>
          )}
          {!existing && canPay && !form.quote && (
            <>
              <Field label="Advance taken (optional)" hint="A receipt of money on account for the hire; it pays the bill first."><input type="number" min="0" step="0.01" value={form.advance} onChange={set("advance")} /></Field>
              {Number(form.advance) > 0 && (
                <>
                  <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
                  <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
                </>
              )}
            </>
          )}
          <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Deliver to the community hall by 9 am" /></Field>
        </div>
      </SectionCard>
      <div className="rnt-total" aria-live="polite">
        {problem ? <p className="bz-due small" role="alert">{problem}</p> : !payload ? <span className="muted small">Add what is hired to see the price.</span> : !figures ? <span className="muted small">Working out the price…</span> : (
          <>
            {Number(figures.discount) > 0 && <span>Discount {biz.exact(figures.discount)}</span>}
            <span>Before GST {biz.exact(figures.subtotal)}</span>
            <span>GST {biz.exact(figures.tax)}</span>
            <strong>Total {biz.exact(figures.total)}</strong>
            {Number(figures.deposit) > 0 && <span>Deposit asked {biz.exact(figures.deposit)}</span>}
            {!figures.free && <span className="bz-due">Something is not free then</span>}
          </>
        )}
        <ErrorMessage message={error} />
        <div className="form-actions">
          <button type="submit" className="button" disabled={busy || !lines.length}><Icon name="check" size={16} /> {busy ? "Saving…" : existing ? "Save the changes" : form.quote ? "Save the quote" : "Book it"}</button>
        </div>
      </div>
    </form>
  );
}
