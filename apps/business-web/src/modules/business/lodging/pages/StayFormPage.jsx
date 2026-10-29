import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
import { RATE_KINDS, ROOM_STATUS, SLAB_NOTE, SOURCES, addDays, atWords, dateWords, nightCount, weekdayWords } from "./lodging";
import "../styles/lodging.css";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// A reservation taken at the desk or on the phone, or an OTA's booking typed
// in: the guest (found by name or phone, or typed new), a company billed
// instead, where it came from, the nights (dates on the property's clock: a
// night belongs to the date it starts on), the room type and, if chosen now,
// the room; adults, children and extra beds; an agreed rate for every night if
// any. Every figure is the server's: each night at its own rate, with the GST
// slab its value decides. The room is never booked twice, nor the room type
// over its rooms: the server refuses it. A rate plan of the room type (its
// meals priced per night as their own lines), a discount (by the discount
// permission) and a day use (a block of hours on one day, priced by the room
// type's day-use rates, its room named) go with it; the calendar's minimum
// stay, closed to arrival and stop-sell are shown as the server words them.
// With ?edit=<id>, a reservation changes (a day use: its notes, discount and
// who is billed).

const PAY_KINDS = ["cash", "upi", "card", "bank"];
const QUICK = [1, 2, 3, 7];

export default function StayFormPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const methods = usePaymentMethods();
  const [params] = useSearchParams();
  const editId = params.get("edit");
  const today = businessToday(biz.business.timezone);
  const locations = biz.locations.filter((l) => l.active);
  const [setup, setSetup] = useState(null);
  const [existing, setExisting] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [requestKey, setRequestKey] = useState(newKey);
  const [guest, setGuest] = useState(null);
  const [typed, setTyped] = useState(null);
  const [billTo, setBillTo] = useState(null);
  const [form, setForm] = useState({ locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""), source: "walk_in", otaName: "", otaBookingId: "",
    arrival: today, departure: addDays(today, 1), roomTypeId: "", roomId: "", adults: "2", children: "0", extraBeds: "0", agreedRate: "", advance: "", method: "cash", reference: "", notes: "",
    ratePlanId: "", discount: "", discountReason: "", dayUse: false, dayFrom: "", dayHours: "4" });
  const [plans, setPlans] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  useDirtyGuard(Boolean(guest || typed));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/setup", undefined, controller.signal).then((s) => {
      setSetup(s);
      setForm((f) => ({ ...f, roomTypeId: f.roomTypeId || String(s.roomTypes.find((t) => t.active)?.id || "") }));
    }).catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    businessRead(biz.id, "lodging/rates", { days: 1 }, controller.signal).then((r) => setPlans(r.plans)).catch(() => setPlans([]));
    if (editId) {
      businessRead(biz.id, `lodging/stays/${editId}`, undefined, controller.signal).then((s) => {
        setExisting(s);
        setForm((f) => ({ ...f, locationId: String(s.location_id), source: s.source, otaName: s.ota_name || "", otaBookingId: s.ota_booking_id || "", arrival: s.arrival, departure: s.departure,
          roomTypeId: String(s.room_type_id), roomId: s.room_id ? String(s.room_id) : "", adults: String(s.adults), children: String(s.children), extraBeds: String(s.extra_beds),
          agreedRate: s.agreed_rate ? String(Number(s.agreed_rate)) : "", notes: s.notes || "", ratePlanId: s.rate_plan_id ? String(s.rate_plan_id) : "",
          discount: s.discount_percent ? String(Number(s.discount_percent)) : "", discountReason: s.discount_reason || "", dayUse: Boolean(s.day_use), dayHours: String(s.day_hours || 4) }));
        if (s.bill_to_contact_id) setBillTo({ id: s.bill_to_contact_id, name: s.bill_to_name });
      }).catch((err) => { if (!controller.signal.aborted) setLoadError(getErrorMessage(err)); });
    }
    return () => controller.abort();
  }, [biz.id, editId]);
  const types = (setup?.roomTypes || []).filter((t) => t.active || String(t.id) === form.roomTypeId);
  const type = types.find((t) => String(t.id) === form.roomTypeId) || null;
  const dayUse = form.dayUse;
  const datesValid = dayUse ? Boolean(form.arrival) : form.arrival && form.departure && form.departure > form.arrival;
  // The room type's plans shared by every property, or the property's own.
  const typePlans = plans.filter((p) => String(p.room_type_id) === form.roomTypeId && (!p.location_id || String(p.location_id) === form.locationId)
    && (p.active || String(p.id) === form.ratePlanId));
  const canDiscount = biz.can("sales.discount");
  const discountBody = Number(form.discount) > 0 ? { percent: form.discount, reason: form.discountReason.trim() } : null;

  // The rooms of the type free over these nights (this stay's own nights left out when it is being changed).
  const [rooms, setRooms] = useState(null);
  useEffect(() => {
    if (!datesValid || !form.roomTypeId) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessRead(biz.id, "lodging/free", { arrival: form.arrival, departure: dayUse ? addDays(form.arrival, 1) : form.departure, roomType: form.roomTypeId, ...(editId ? { stay: editId } : {}) }, controller.signal)
        .then((r) => setRooms({ key: `${form.arrival}|${form.departure}|${form.roomTypeId}|${dayUse}`, list: r.rooms })).catch(() => {});
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [biz.id, form.arrival, form.departure, form.roomTypeId, editId, datesValid, dayUse]);
  const roomList = rooms?.key === `${form.arrival}|${form.departure}|${form.roomTypeId}|${dayUse}` ? rooms.list : [];

  // The nights priced by the server, each at its rate and slab.
  const dayUseReady = !dayUse || Boolean(existing) || (form.roomId && /^\d{2}:\d{2}$/.test(form.dayFrom) && Number(form.dayHours) > 0);
  const payload = datesValid && form.roomTypeId && dayUseReady && !existing?.day_use ? JSON.stringify({ locationId: form.locationId, arrival: form.arrival, roomTypeId: form.roomTypeId,
    roomId: form.roomId || undefined, adults: form.adults, children: form.children || 0, ...(editId ? { stayId: editId } : {}),
    ...(dayUse ? { dayUse: { from: form.dayFrom, hours: form.dayHours } } : { departure: form.departure, extraBeds: form.extraBeds || 0, agreedRate: form.agreedRate || undefined,
      ratePlanId: form.ratePlanId || undefined }),
    ...(discountBody ? { discount: { percent: discountBody.percent } } : {}) }) : null;
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "lodging/stays/preview", JSON.parse(payload)).then((data) => setQuote({ payload, data, error: "" }))
        .catch((err) => setQuote({ payload, data: null, error: getErrorMessage(err) }));
    }, 300);
    return () => clearTimeout(timer);
  }, [biz.id, payload]);
  const figures = payload && quote?.payload === payload ? quote.data : null;
  const problem = payload && quote?.payload === payload ? quote.error : "";
  const nights = datesValid && !dayUse ? nightCount(form.arrival, form.departure) : 0;
  const withMeals = Boolean(figures?.nights.some((n) => Number(n.meals) > 0));
  const withDiscount = Boolean(figures?.nights.some((n) => Number(n.discount) > 0));
  const canPay = biz.can("sales.edit");

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!existing && !guest && !typed?.name?.trim()) return setError("Choose the guest, or type the new guest's name");
    if (!datesValid) return setError("The departure is after the arrival: a stay is one night at least");
    if (dayUse && !form.roomId) return setError("Choose the room: a day use names its room");
    setBusy(true);
    try {
      const discount = canDiscount ? { discount: discountBody } : {};
      const common = existing?.day_use ? { billToContactId: billTo?.id || null, notes: form.notes.trim() || null, ...discount } : { arrival: form.arrival, departure: form.departure, roomTypeId: form.roomTypeId, roomId: form.roomId || null, adults: form.adults, children: form.children || 0,
        extraBeds: form.extraBeds || 0, agreedRate: form.agreedRate || null, billToContactId: billTo?.id || null, source: form.source,
        ...(form.source === "ota" ? { otaName: form.otaName.trim(), otaBookingId: form.otaBookingId.trim() } : {}), notes: form.notes.trim() || null,
        ratePlanId: form.ratePlanId || null, ...discount };
      const dayBody = { arrival: form.arrival, roomTypeId: form.roomTypeId, roomId: form.roomId, adults: form.adults, children: form.children || 0, source: form.source,
        ...(form.source === "ota" ? { otaName: form.otaName.trim(), otaBookingId: form.otaBookingId.trim() } : {}), dayUse: { from: form.dayFrom, hours: form.dayHours },
        ...(discountBody && canDiscount ? { discount: discountBody } : {}), billToContactId: billTo?.id || undefined, notes: form.notes.trim() || undefined };
      const stay = existing
        ? await businessWrite(biz.id, `lodging/stays/${existing.id}`, common, "patch")
        : await businessWrite(biz.id, "lodging/stays", {
          requestKey, locationId: form.locationId, ...(dayUse ? dayBody : { ...common, roomId: form.roomId || undefined, agreedRate: form.agreedRate || undefined, billToContactId: billTo?.id || undefined,
            notes: form.notes.trim() || undefined, ratePlanId: form.ratePlanId || undefined, discount: discountBody && canDiscount ? discountBody : undefined }),
          ...(guest ? { contactId: guest.id } : { guest: { name: typed.name.trim(), phone: typed.phone?.trim() || undefined, consents: consentChanges(typed.consents, []) || undefined } }),
          ...(canPay && Number(form.advance) > 0 ? { advance: { amount: form.advance, ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined } } : {}),
        });
      toast.success(existing ? `${stay.stay_no} changed.` : `Reservation ${stay.stay_no} saved.`);
      setGuest(null);
      setTyped(null);
      setRequestKey(newKey());
      navigate(biz.path(`lodging-stays/${stay.id}`));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const title = existing ? `Change ${existing.stay_no}` : "New reservation";
  if (!setup || (editId && !existing)) return <div className="stack"><BusinessHeader icon="calendar" title={title} /><ErrorMessage message={loadError} />{!loadError && <Loading label="Loading the room types…" />}</div>;
  if (!biz.can("lodging.create")) return <div className="stack"><BusinessHeader icon="calendar" title={title} /><p className="ldg-note">Your role does not take reservations.</p></div>;
  const searchCustomers = (q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items);
  return (
    <form className="stack" onSubmit={submit}>
      <BusinessHeader icon="calendar" title={title}
        description="Each night is priced at its own rate (rack, weekend or agreed) with the GST slab its value decides. Dates are the property's own: a night belongs to the date it starts on."
        secondary={<Link className="button button-secondary" to={biz.path(existing ? `lodging-stays/${existing.id}` : "lodging-desk")}><Icon name="arrow-left" size={15} /> {existing ? "Back to the stay" : "Front desk"}</Link>} />
      {!setup.settings.ready && <p className="ldg-note ldg-warn">Set the two GST slabs of a room night first, under Settings › Room types &amp; rates.</p>}
      {!setup.roomTypes.length && <p className="ldg-note ldg-warn">No room types yet: add them with their rooms under Settings › Room types &amp; rates.</p>}
      <SectionCard icon="user" title="Guest">
        <div className="form-grid bz-form">
          {existing ? <p className="field-wide ldg-note">{existing.guest_name}{existing.guest_phone ? ` · ${existing.guest_phone}` : ""}</p> : typed ? (
            <>
              <Field label="Name"><input required maxLength={150} autoFocus value={typed.name} onChange={(e) => setTyped((c) => ({ ...c, name: e.target.value }))} /></Field>
              <Field label="Phone"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((c) => ({ ...c, phone: e.target.value }))} /></Field>
              <NewCustomerConsents value={typed.consents} onChange={(consents) => setTyped((c) => ({ ...c, consents }))} />
              <button type="button" className="link-button" onClick={() => setTyped(null)}>Find a guest instead</button>
            </>
          ) : (
            <>
              <div className="field">
                <SearchPicker label="Guest" placeholder="Name or phone" value={guest} onChange={setGuest} minChars={2} search={searchCustomers} getLabel={(x) => x.name} getDescription={(x) => x.phone || ""} />
              </div>
              {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setGuest(null); setTyped({ name: "", phone: "" }); }}><Icon name="user-plus" size={15} /> New guest</button>}
            </>
          )}
          <div className="field">
            <SearchPicker label="Billed to a company (optional)" placeholder="Company name" value={billTo} onChange={setBillTo} minChars={2} search={searchCustomers}
              getLabel={(x) => x.name} getDescription={(x) => (x.gstin ? `GSTIN ${x.gstin}` : "")} />
          </div>
          <Field label="Booked by"><select value={form.source} onChange={set("source")}>{SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
          {form.source === "ota" && <Field label="OTA"><input required maxLength={60} value={form.otaName} onChange={set("otaName")} placeholder="MakeMyTrip, Booking.com…" /></Field>}
          {form.source === "ota" && <Field label="OTA booking id"><input required maxLength={60} className="mono" value={form.otaBookingId} onChange={set("otaBookingId")} /></Field>}
          {locations.length > 1 && !existing && <Field label="Property"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
        </div>
      </SectionCard>
      <SectionCard icon="calendar" title="Nights and room" description={dayUse ? "A day use: the room for a block of hours on one day, at the room type's day-use price." : "The arrival date is the first night; the departure date is the morning the guest leaves."}>
        <div className="form-grid bz-form">
          {!existing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={dayUse}
            onChange={(e) => setForm((f) => ({ ...f, dayUse: e.target.checked, ratePlanId: "", agreedRate: "", extraBeds: "0" }))} /> Day use (a block of hours on one day, no night)</label>}
          {existing?.day_use && <p className="field-wide ldg-note">A day use on {dateWords(existing.arrival)}, {atWords(existing.day_from, biz, { today: false })} to {atWords(existing.day_until, biz, { today: false })}: it keeps its day, hours, room and guests. Cancel it and book again to change them.</p>}
          {dayUse ? (
            <>
              <Field label="Day"><input type="date" required disabled={Boolean(existing)} min={existing ? undefined : today} value={form.arrival} onChange={set("arrival")} /></Field>
              {!existing && <Field label="From (time)"><input type="time" required value={form.dayFrom} onChange={set("dayFrom")} /></Field>}
              {!existing && <Field label="Hours"><input type="number" required min="1" max="12" value={form.dayHours} onChange={set("dayHours")} /></Field>}
            </>
          ) : (
            <>
          <Field label="Arrival"><input type="date" required min={existing ? undefined : today} value={form.arrival}
            onChange={(e) => setForm((f) => ({ ...f, arrival: e.target.value, departure: f.departure > e.target.value ? f.departure : addDays(e.target.value, 1) }))} /></Field>
          <Field label="Departure"><input type="date" required min={form.arrival ? addDays(form.arrival, 1) : undefined} value={form.departure} onChange={set("departure")} /></Field>
          <div className="ldg-quick field-wide" role="group" aria-label="Nights">
            {QUICK.map((n) => <button key={n} type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, departure: addDays(f.arrival, n) }))}>{n === 7 ? "1 week" : `${n} ${n === 1 ? "night" : "nights"}`}</button>)}
            {datesValid && <span className="muted small">{nights} {nights === 1 ? "night" : "nights"}</span>}
          </div>
            </>
          )}
          <Field label="Room type"><select required disabled={existing?.day_use} value={form.roomTypeId} onChange={(e) => setForm((f) => ({ ...f, roomTypeId: e.target.value, roomId: "", ratePlanId: "" }))}>
            <option value="">Choose…</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} · {biz.exact(t.rack_rate)}{t.weekend_rate ? ` (weekend ${biz.exact(t.weekend_rate)})` : ""} · up to {t.max_occupancy}</option>)}
          </select></Field>
          <Field label="Room" hint={dayUse ? "A day use names its room." : "Or choose it at check-in."}><select required={dayUse} disabled={existing?.day_use} value={form.roomId} onChange={set("roomId")}>
            <option value="">{dayUse ? "Choose the room…" : "No room yet"}</option>
            {existing?.day_use && <option value={form.roomId}>{existing.room_no}</option>}
            {roomList.map((r) => <option key={r.id} value={r.id}>{r.roomNo}{r.floor ? ` · floor ${r.floor}` : ""}{r.free ? "" : r.clash.outOfOrder ? ` · ${ROOM_STATUS.out_of_order.label.toLowerCase()}` : ` · taken (${r.clash.stayNo})`}{r.outOfService ? " · out of service" : ""}</option>)}
          </select></Field>
          <Field label="Adults"><input type="number" required disabled={existing?.day_use} min="1" max={type?.max_occupancy || 30} value={form.adults} onChange={set("adults")} /></Field>
          <Field label="Children"><input type="number" disabled={existing?.day_use} min="0" max="30" value={form.children} onChange={set("children")} /></Field>
          {!dayUse && (
            <>
          <Field label="Extra beds"><input type="number" min="0" max={type?.max_extra_beds || 0} value={form.extraBeds} onChange={set("extraBeds")} /></Field>
          <Field label="Rate plan" hint="Its meals are billed as their own lines, at their own GST slab."><select value={form.ratePlanId} onChange={set("ratePlanId")}>
            <option value="">No plan (the room type's rates, room only)</option>
            {typePlans.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.meal_plan}){p.refundable ? "" : " · not refundable"}</option>)}
          </select></Field>
          <Field label="Agreed rate a night (optional, before GST)" hint="An OTA's price or a company's rate: in place of the rack and weekend rates."><input type="number" min="0.01" step="0.01" value={form.agreedRate} onChange={set("agreedRate")} /></Field>
            </>
          )}
          {canDiscount && <Field label="Discount (%, optional)" hint="Within the most a bill takes off (Business settings). The discounted night's value decides its slab."><input type="number" min="0" max="100" step="0.01" value={form.discount} onChange={set("discount")} /></Field>}
          {canDiscount && Number(form.discount) > 0 && <Field label="Reason for the discount"><input required maxLength={300} value={form.discountReason} onChange={set("discountReason")} placeholder="e.g. Corporate rate, regular guest" /></Field>}
        </div>
      </SectionCard>
      <SectionCard flush icon="receipt" title="The nights" description={SLAB_NOTE}>
        {problem ? <p className="ldg-clash ldg-audit" role="alert">{problem}</p> : existing?.day_use ? <p className="ldg-empty">A day use keeps its price; a discount changed here is worked out when it is saved.</p>
          : !payload ? <p className="ldg-empty">{dayUse ? "Give the day, the room, the start and the hours to see the price." : "Give the dates and the room type to see the nights."}</p> : !figures ? <Loading label="Working out the nights…" /> : (
          <>
            <table className="ldg-bill" aria-label="Nights">
              <thead><tr><th>Night</th><th>Rate</th>{withDiscount && <th className="r">Discount</th>}<th className="r">Value</th><th className="r">GST</th>{withMeals && <th className="r">Meals</th>}<th className="r">With GST</th></tr></thead>
              <tbody>
                {figures.nights.map((n) => (
                  <tr key={n.night}><td>{weekdayWords(n.night)}</td><td>{RATE_KINDS[n.rateKind]}{n.extraAdults ? ` · +${n.extraAdults} adult` : ""}{n.children ? ` · ${n.children} child` : ""}{n.extraBeds ? ` · ${n.extraBeds} bed` : ""}</td>
                    {withDiscount && <td className="r">{Number(n.discount) > 0 ? `− ${biz.exact(n.discount)}` : ""}</td>}
                    <td className="r">{biz.exact(n.amount)}</td><td className="r">{Number(n.taxRate)}% · {biz.exact(n.tax)}</td>
                    {withMeals && <td className="r">{Number(n.meals) > 0 ? `${biz.exact(n.meals)} + GST ${biz.exact(n.mealsTax)}` : ""}</td>}<td className="r">{biz.exact(n.total)}</td></tr>
                ))}
              </tbody>
            </table>
            {!figures.roomFree && <p className="ldg-clash ldg-audit" role="alert">{figures.roomWords}</p>}
            {!figures.typeFree && <p className="ldg-clash ldg-audit" role="alert">{figures.typeWords}</p>}
            {figures.calendarFree === false && <p className="ldg-clash ldg-audit" role="alert">{figures.calendarWords}</p>}
            {figures.dayFrom && <p className="ldg-note">Day use from {atWords(figures.dayFrom, biz, { today: false })} to {atWords(figures.dayUntil, biz, { today: false })}.</p>}
            <div className="ldg-totals" aria-live="polite">
              <span>Before GST {biz.exact(figures.subtotal)}</span><span>GST {biz.exact(figures.tax)}</span><strong>Total {biz.exact(figures.total)}</strong>
            </div>
          </>
        )}
      </SectionCard>
      <SectionCard icon="wallet" title={existing ? "Notes" : "Advance and notes"}>
        <div className="form-grid bz-form">
          {!existing && canPay && (
            <>
              <Field label="Advance taken (optional)" hint="A receipt of money on account for the stay; it pays the bill first at check-out."><input type="number" min="0" step="0.01" value={form.advance} onChange={set("advance")} /></Field>
              {Number(form.advance) > 0 && (
                <>
                  <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
                  <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
                </>
              )}
            </>
          )}
          <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Late arrival, about 11 pm" /></Field>
        </div>
      </SectionCard>
      <ErrorMessage message={error} />
      <div className="form-actions">
        <button type="submit" className="button" disabled={busy || !setup.roomTypes.length}><Icon name="check" size={16} /> {busy ? "Saving…" : existing ? "Save the changes" : "Reserve"}</button>
      </div>
    </form>
  );
}
