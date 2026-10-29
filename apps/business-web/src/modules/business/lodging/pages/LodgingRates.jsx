import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { MEAL_PLANS, RATE_KINDS, WEEKDAYS, addDays, dateWords, policyWords, weekdayWords } from "./lodging";

// The rates of a lodging business beyond each room type's own (Settings ›
// Room types & rates, in its tabs): rate plans with their meal plans (the
// meals billed as a food service item of their own, so a room night's value
// alone decides its slab), seasons, the rate calendar (each date's rate and
// its minimum stay, closed to arrival and stop-sell), day-use prices by the
// block of hours, and the policies (early check-in, late check-out,
// cancellation, no-show, deposit), and each room type's linen and minibar
// checklist. A rate plan is one property's, or shared by every property. Every
// rate is before GST; the server works out and checks every stay against them.

const text = (value) => (value === null || value === undefined ? "" : String(Number(value)));
const orNull = (value) => (String(value ?? "").trim() === "" ? null : String(value).trim());

// The rates answer for a query (room type, plan, from, days), loaded again by reload().
function useRates(query) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const key = JSON.stringify(query || {});
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/rates", JSON.parse(key), controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, key, version]);
  return { data, error, reload: () => setVersion((n) => n + 1) };
}

// The food and other service items a plan's meals may be billed as (never a room type's nights).
function useMealItems() {
  const { options, error } = useOptions(["catalog?kind=service&active=true"]);
  const items = useMemo(() => (options?.["catalog?kind=service&active=true"] || []).filter((s) => s.unit !== "night" && !s.internal_use && !s.is_kit), [options]);
  return { items, error, loading: !options && !error };
}

const typeName = (setup, id) => setup.roomTypes.find((t) => Number(t.id) === Number(id))?.name || "";
const waiting = (error) => <div className="stack"><ErrorMessage message={error} />{!error && <Loading />}</div>;

// --- Rate plans -------------------------------------------------------------------------------------------

export function RatePlansTab({ setup }) {
  const biz = useOpenBusiness();
  const { data, error, reload } = useRates({});
  const [dialog, setDialog] = useState(null);
  const canEdit = biz.can("catalog.edit");
  if (!data) return waiting(error);
  const done = (message) => { setDialog(null); toast.success(message); reload(); };
  return (
    <SectionCard flush icon="receipt" title="Rate plans"
      description="A room type's plans: room only (EP), with breakfast (CP), half board (MAP) or full board (AP). The meals are billed as their own lines at their item's GST slab, so the room night's value alone decides its slab."
      actions={canEdit && setup.roomTypes.some((t) => t.active) && <button type="button" className="button button-sm" onClick={() => setDialog({})}><Icon name="plus" size={14} /> Add a rate plan</button>}>
      <DataGrid variant="compact" id="lodging-rate-plans" caption="Rate plans" rows={data.plans} rowKey={(p) => p.id} currency={biz.symbol} rowNoun={["rate plan", "rate plans"]}
        rowClassName={(p) => (p.active ? "" : "dg-tone-muted")} empty="No rate plans yet" emptyHint="Without a plan a stay takes its room type's rates, room only." emptyIcon="receipt" columns={[
          { key: "name", header: "Plan", value: (p) => p.name, mobile: "title", pin: true },
          { key: "room_type", header: "Room type", value: (p) => p.room_type, mobile: "subtitle" },
          { key: "location", header: "Property", value: (p) => p.location_name || "Every property", defaultHidden: biz.locations.length < 2 },
          { key: "meal_plan", header: "Meal plan", value: (p) => p.meal_plan_words, mobile: "show" },
          { key: "meals", header: "Meals a night", value: (p) => (p.meal_item ? `${p.meal_item} · adult ${biz.exact(p.meal_adult_rate)}${p.meal_child_rate !== null ? ` · child ${biz.exact(p.meal_child_rate)}` : ""}` : "") },
          { key: "room_rate", header: "Room a night", type: "money", exact: true, value: (p) => (p.room_rate === null ? null : Number(p.room_rate)) },
          { key: "weekend_rate", header: "Weekend", type: "money", exact: true, value: (p) => (p.weekend_rate === null ? null : Number(p.weekend_rate)) },
          { key: "refundable", header: "Refundable", value: (p) => (p.refundable ? "Yes" : "No") },
          { key: "policy", header: "Policy", value: (p) => p.policy_name || "The property's" },
          { key: "active", header: "In use", value: (p) => (p.active ? "Yes" : "No"), render: (p) => <ActiveBadge active={p.active} /> },
          canEdit && { key: "actions", header: "", type: "actions", render: (p) => <button type="button" className="link-button" onClick={() => setDialog({ plan: p })}>Edit</button> },
        ].filter(Boolean)} />
      {dialog && <PlanDialog setup={setup} policies={data.policies} plan={dialog.plan} onClose={() => setDialog(null)} onSaved={() => done(dialog.plan ? "Rate plan saved." : "Rate plan added.")} />}
    </SectionCard>
  );
}

function PlanDialog({ setup, policies, plan, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const meals = useMealItems();
  const types = setup.roomTypes.filter((t) => t.active);
  const [form, setForm] = useState(plan ? { roomTypeId: String(plan.room_type_id), name: plan.name, mealPlan: plan.meal_plan, mealSkuId: plan.meal_sku_id ? String(plan.meal_sku_id) : "",
    mealAdultRate: text(plan.meal_adult_rate), mealChildRate: text(plan.meal_child_rate), roomRate: text(plan.room_rate), weekendRate: text(plan.weekend_rate), refundable: plan.refundable,
    policyId: plan.policy_id ? String(plan.policy_id) : "", active: plan.active, locationId: plan.location_id ? String(plan.location_id) : "" }
    : { roomTypeId: String(types[0]?.id || ""), name: "", mealPlan: "EP", mealSkuId: "", mealAdultRate: "", mealChildRate: "", roomRate: "", weekendRate: "", refundable: true, policyId: "", active: true,
      locationId: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const withMeals = form.mealPlan !== "EP";
  const body = () => ({ name: form.name.trim(), mealPlan: form.mealPlan,
    ...(withMeals ? { mealSkuId: form.mealSkuId, mealAdultRate: form.mealAdultRate, mealChildRate: orNull(form.mealChildRate) } : {}),
    roomRate: orNull(form.roomRate), weekendRate: orNull(form.weekendRate), refundable: form.refundable, policyId: form.policyId || null, locationId: form.locationId || null });
  return (
    <FormDialog title={plan ? `Edit ${plan.name}` : "Add a rate plan"} icon="receipt" width={680} onClose={onClose} onSaved={onSaved} submitLabel={plan ? "Save" : "Add the plan"}
      description="A stay booked under a plan keeps its rates. Leave the plan's room rates empty to use the room type's (and the seasons and the calendar's)."
      onSubmit={() => (plan ? businessWrite(biz.id, `lodging/rate-plans/${plan.id}`, { ...body(), active: form.active }, "patch")
        : businessWrite(biz.id, "lodging/rate-plans", { roomTypeId: form.roomTypeId, ...body() }))}>
      {meals.error && <p className="field-wide ldg-clash" role="alert">{meals.error}</p>}
      {!plan && <Field label="Room type"><select required value={form.roomTypeId} onChange={set("roomTypeId")}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
      <Field label="Plan name"><input required maxLength={80} value={form.name} onChange={set("name")} placeholder="e.g. Half board, Saver" /></Field>
      {biz.locations.length > 1 && <Field label="Property"><select value={form.locationId} onChange={set("locationId")}>
        <option value="">Every property</option>{biz.locations.filter((l) => l.active || String(l.id) === form.locationId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="Meal plan"><select value={form.mealPlan} onChange={set("mealPlan")}>{MEAL_PLANS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
      {withMeals && (
        <>
          <Field label="Meals billed as" hint="A food service item, at its own GST slab."><select required value={form.mealSkuId} onChange={set("mealSkuId")}>
            <option value="">{meals.loading ? "Loading…" : "Choose…"}</option>
            {meals.items.map((s) => <option key={s.id} value={s.id}>{s.label} · GST {Number(s.tax_rate)}%</option>)}</select></Field>
          <Field label="Meals a night for an adult (before GST)"><input required type="number" min="0" step="0.01" value={form.mealAdultRate} onChange={set("mealAdultRate")} /></Field>
          <Field label="Meals a night for a child (optional)"><input type="number" min="0" step="0.01" value={form.mealChildRate} onChange={set("mealChildRate")} /></Field>
        </>
      )}
      <Field label="Plan's room rate a night (optional)"><input type="number" min="0.01" step="0.01" value={form.roomRate} onChange={set("roomRate")} /></Field>
      <Field label="Plan's weekend rate (optional)"><input type="number" min="0.01" step="0.01" value={form.weekendRate} onChange={set("weekendRate")} /></Field>
      <Field label="Policy"><select value={form.policyId} onChange={set("policyId")}>
        <option value="">The property's policy</option>
        {policies.filter((p) => p.active || String(p.id) === form.policyId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.refundable} onChange={set("refundable")} /> Refundable (not refundable: a cancellation costs the full stay)</label>
      {plan && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>}
    </FormDialog>
  );
}

// --- Seasons ---------------------------------------------------------------------------------------------

export function SeasonsTab({ setup }) {
  const biz = useOpenBusiness();
  const { data, error, reload } = useRates({});
  const [dialog, setDialog] = useState(null);
  const canEdit = biz.can("catalog.edit");
  if (!data) return waiting(error);
  const done = (message) => { setDialog(null); toast.success(message); reload(); };
  return (
    <SectionCard flush icon="calendar" title="Seasons" description="A date range's weekday and weekend rates for a room type, or for one of its plans. Two seasons of the same never cover the same night."
      actions={canEdit && setup.roomTypes.some((t) => t.active) && <button type="button" className="button button-sm" onClick={() => setDialog({})}><Icon name="plus" size={14} /> Add a season</button>}>
      <DataGrid variant="compact" id="lodging-seasons" caption="Seasons" rows={data.seasons} rowKey={(s) => s.id} currency={biz.symbol} rowNoun={["season", "seasons"]}
        rowClassName={(s) => (s.active ? "" : "dg-tone-muted")} empty="No seasons yet" emptyIcon="calendar" columns={[
          { key: "name", header: "Season", value: (s) => s.name, mobile: "title", pin: true },
          { key: "room_type", header: "Room type", value: (s) => `${typeName(setup, s.room_type_id)}${s.plan_name ? ` · ${s.plan_name}` : ""}`, mobile: "subtitle" },
          { key: "dates", header: "Dates", value: (s) => s.starts_on, render: (s) => `${dateWords(s.starts_on)} to ${dateWords(s.ends_on)}`, mobile: "show" },
          { key: "weekday", header: "Weekday", type: "money", exact: true, value: (s) => Number(s.weekday_rate) },
          { key: "weekend", header: "Weekend", type: "money", exact: true, value: (s) => (s.weekend_rate === null ? null : Number(s.weekend_rate)) },
          { key: "min_stay", header: "Minimum stay", value: (s) => (s.min_stay ? `${s.min_stay} nights` : "") },
          { key: "active", header: "In use", value: (s) => (s.active ? "Yes" : "No"), render: (s) => <ActiveBadge active={s.active} /> },
          canEdit && { key: "actions", header: "", type: "actions", render: (s) => <button type="button" className="link-button" onClick={() => setDialog({ season: s })}>Edit</button> },
        ].filter(Boolean)} />
      {dialog && <SeasonDialog setup={setup} plans={data.plans} season={dialog.season} onClose={() => setDialog(null)} onSaved={() => done(dialog.season ? "Season saved." : "Season added.")} />}
    </SectionCard>
  );
}

function SeasonDialog({ setup, plans, season, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const types = setup.roomTypes.filter((t) => t.active);
  const [form, setForm] = useState(season ? { roomTypeId: String(season.room_type_id), ratePlanId: season.rate_plan_id ? String(season.rate_plan_id) : "", name: season.name,
    startsOn: season.starts_on, endsOn: season.ends_on, weekdayRate: text(season.weekday_rate), weekendRate: text(season.weekend_rate), extraAdultRate: text(season.extra_adult_rate),
    childRate: text(season.child_rate), extraBedRate: text(season.extra_bed_rate), minStay: season.min_stay ? String(season.min_stay) : "", active: season.active }
    : { roomTypeId: String(types[0]?.id || ""), ratePlanId: "", name: "", startsOn: "", endsOn: "", weekdayRate: "", weekendRate: "", extraAdultRate: "", childRate: "", extraBedRate: "", minStay: "", active: true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const ownPlans = plans.filter((p) => String(p.room_type_id) === form.roomTypeId && (p.active || String(p.id) === form.ratePlanId));
  const body = () => ({ ratePlanId: form.ratePlanId || null, name: form.name.trim(), startsOn: form.startsOn, endsOn: form.endsOn, weekdayRate: form.weekdayRate, weekendRate: orNull(form.weekendRate),
    extraAdultRate: orNull(form.extraAdultRate), childRate: orNull(form.childRate), extraBedRate: orNull(form.extraBedRate), minStay: orNull(form.minStay) });
  return (
    <FormDialog title={season ? `Edit ${season.name}` : "Add a season"} icon="calendar" width={680} onClose={onClose} onSaved={onSaved} submitLabel={season ? "Save" : "Add the season"}
      description="Its rates take the place of the room type's (or the plan's) on its dates; a date's own rate in the calendar comes first."
      onSubmit={() => (season ? businessWrite(biz.id, `lodging/seasons/${season.id}`, { ...body(), active: form.active }, "patch")
        : businessWrite(biz.id, "lodging/seasons", { roomTypeId: form.roomTypeId, ...body() }))}>
      {!season && <Field label="Room type"><select required value={form.roomTypeId} onChange={(e) => setForm((f) => ({ ...f, roomTypeId: e.target.value, ratePlanId: "" }))}>
        {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
      <Field label="For the plan"><select value={form.ratePlanId} onChange={set("ratePlanId")}>
        <option value="">Every stay of the room type</option>{ownPlans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Season name"><input required maxLength={80} value={form.name} onChange={set("name")} placeholder="e.g. Diwali, Peak winter" /></Field>
      <Field label="From"><input required type="date" value={form.startsOn} onChange={set("startsOn")} /></Field>
      <Field label="To (the last night)"><input required type="date" min={form.startsOn || undefined} value={form.endsOn} onChange={set("endsOn")} /></Field>
      <Field label="Weekday rate a night (before GST)"><input required type="number" min="0.01" step="0.01" value={form.weekdayRate} onChange={set("weekdayRate")} /></Field>
      <Field label="Weekend rate a night (optional)"><input type="number" min="0.01" step="0.01" value={form.weekendRate} onChange={set("weekendRate")} /></Field>
      <Field label="Each extra adult (optional)"><input type="number" min="0" step="0.01" value={form.extraAdultRate} onChange={set("extraAdultRate")} /></Field>
      <Field label="Each child (optional)"><input type="number" min="0" step="0.01" value={form.childRate} onChange={set("childRate")} /></Field>
      <Field label="Each extra bed (optional)"><input type="number" min="0" step="0.01" value={form.extraBedRate} onChange={set("extraBedRate")} /></Field>
      <Field label="Minimum stay in nights (optional)"><input type="number" min="1" max="60" value={form.minStay} onChange={set("minStay")} /></Field>
      {season && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>}
    </FormDialog>
  );
}

// --- The rate calendar -------------------------------------------------------------------------------------

export function RateCalendarTab({ setup }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const types = setup.roomTypes.filter((t) => t.active);
  const [typeId, setTypeId] = useState(String(types[0]?.id || ""));
  const [planId, setPlanId] = useState("");
  const [from, setFrom] = useState(today);
  const [dialog, setDialog] = useState(false);
  const { data, error, reload } = useRates({ roomType: typeId || undefined, plan: planId || undefined, from, days: 14 });
  const canEdit = biz.can("catalog.edit");
  if (!types.length) return <p className="ldg-empty">No room types yet: add them on the first tab.</p>;
  const plans = (data?.plans || []).filter((p) => String(p.room_type_id) === typeId && p.active);
  const calendar = data?.calendar;
  return (
    <SectionCard flush icon="calendar" title="Rate calendar"
      description="Each date's rate (the room type's, the weekend's, a season's or the date's own) and its restrictions: a minimum stay, closed to arrival, stop-sell. A reservation or change is checked against them."
      actions={(
        <span className="ldg-cal-tools">
          <select aria-label="Room type" value={typeId} onChange={(e) => { setTypeId(e.target.value); setPlanId(""); }}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <select aria-label="Rate plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">No plan</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value || today)} />
          {canEdit && <button type="button" className="button button-sm" onClick={() => setDialog(true)}><Icon name="edit" size={14} /> Set dates</button>}
        </span>
      )}>
      <ErrorMessage message={error} />
      {!calendar ? (!error && <Loading />) : (
        <div className="ldg-cal-wrap">
          <table className="ldg-bill" aria-label="Rate calendar">
            <thead><tr><th>Date</th><th>Rate</th><th className="r">Room a night</th><th className="r">Extra adult</th><th className="r">Child</th><th>Minimum stay</th><th>Restrictions</th></tr></thead>
            <tbody>
              {calendar.dates.map((d) => (
                <tr key={d.day}>
                  <td>{weekdayWords(d.day)}{d.weekend ? <small className="muted"> · weekend</small> : null}</td>
                  <td>{RATE_KINDS[d.rateKind] || d.rateKind}</td>
                  <td className="r">{biz.exact(d.roomRate)}</td>
                  <td className="r">{d.extraAdultRate === null ? "—" : biz.exact(d.extraAdultRate)}</td>
                  <td className="r">{d.childRate === null ? "—" : biz.exact(d.childRate)}</td>
                  <td>{d.minStay ? `${d.minStay} nights` : ""}</td>
                  <td>{[d.closedToArrival ? "Closed to arrival" : null, d.stopSell ? "Stop-sell" : null].filter(Boolean).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog && <SetDatesDialog typeId={typeId} planId={planId} from={from} typeLabel={`${typeName(setup, typeId)}${planId ? ` · ${plans.find((p) => String(p.id) === planId)?.name || ""}` : ""}`}
        onClose={() => setDialog(false)} onSaved={(r) => { setDialog(false); toast.success(`${r.dates} ${r.dates === 1 ? "date" : "dates"} changed.`); reload(); }} />}
    </SectionCard>
  );
}

function SetDatesDialog({ typeId, planId, from, typeLabel, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ from, to: addDays(from, 6), days: WEEKDAYS.map(([d]) => d), roomRate: "", minStay: "", closed: "", stopSell: "", clear: false });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const toggle = (day) => setForm((f) => ({ ...f, days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day].sort() }));
  const body = () => ({ roomTypeId: typeId, ...(planId ? { ratePlanId: planId } : {}), from: form.from, to: form.to, ...(form.days.length < 7 ? { weekdays: form.days } : {}),
    ...(form.clear ? { clear: true } : {
      ...(form.roomRate !== "" ? { roomRate: form.roomRate } : {}), ...(form.minStay !== "" ? { minStay: form.minStay } : {}),
      ...(form.closed ? { closedToArrival: form.closed === "yes" } : {}), ...(form.stopSell ? { stopSell: form.stopSell === "yes" } : {}),
    }) });
  return (
    <FormDialog title={`Set dates · ${typeLabel}`} icon="calendar" width={640} onClose={onClose} onSaved={onSaved} submitLabel={form.clear ? "Clear the dates" : "Set the dates"}
      description="What is left empty stays as it is on each date. Clearing takes the dates' own settings off: the room type's, weekend and season rates apply again."
      onSubmit={() => businessWrite(biz.id, "lodging/rate-days", body(), "put")}>
      <Field label="From"><input required type="date" value={form.from} onChange={set("from")} /></Field>
      <Field label="To"><input required type="date" min={form.from} value={form.to} onChange={set("to")} /></Field>
      <div className="field field-wide">
        <span>Days of the week</span>
        <div className="ldg-weekdays" role="group" aria-label="Days of the week">
          {WEEKDAYS.map(([day, name]) => <label key={day} className="checkbox bz-check"><input type="checkbox" checked={form.days.includes(day)} onChange={() => toggle(day)} /> {name}</label>)}
        </div>
      </div>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.clear} onChange={set("clear")} /> Clear these dates' own settings</label>
      {!form.clear && (
        <>
          <Field label="Room rate a night (optional, before GST)"><input type="number" min="0.01" step="0.01" value={form.roomRate} onChange={set("roomRate")} /></Field>
          <Field label="Minimum stay in nights (optional)"><input type="number" min="1" max="60" value={form.minStay} onChange={set("minStay")} /></Field>
          <Field label="Closed to arrival"><select value={form.closed} onChange={set("closed")}>
            <option value="">As it is</option><option value="yes">Closed to arrival</option><option value="no">Open to arrival</option></select></Field>
          <Field label="Stop-sell"><select value={form.stopSell} onChange={set("stopSell")}>
            <option value="">As it is</option><option value="yes">Stop-sell (not sold)</option><option value="no">On sale</option></select></Field>
        </>
      )}
    </FormDialog>
  );
}

// --- Day use -------------------------------------------------------------------------------------------------

export function DayUseTab({ setup }) {
  const biz = useOpenBusiness();
  const { data, error, reload } = useRates({});
  const [dialog, setDialog] = useState(null);
  const canEdit = biz.can("catalog.edit");
  if (!data) return waiting(error);
  const pricesOf = (typeId) => data.dayUse.filter((d) => Number(d.room_type_id) === Number(typeId));
  return (
    <SectionCard flush icon="calendar" title="Day use"
      description="A room for a block of hours on one day, at the room type's price for those hours (before GST). It never shares its room's hours with a night stay or another day use.">
      <DataGrid variant="compact" id="lodging-day-use" caption="Day-use prices" rows={setup.roomTypes.filter((t) => t.active)} rowKey={(t) => t.id} rowNoun={["room type", "room types"]}
        empty="No room types yet" emptyIcon="home" columns={[
          { key: "name", header: "Room type", value: (t) => t.name, mobile: "title", pin: true },
          { key: "prices", header: "Prices", value: (t) => pricesOf(t.id).map((d) => `${d.hours} h ${biz.exact(d.rate)}`).join(" · ") || "No day use", mobile: "show" },
          canEdit && { key: "actions", header: "", type: "actions", render: (t) => <button type="button" className="link-button" onClick={() => setDialog(t)}>Set prices</button> },
        ].filter(Boolean)} />
      {dialog && <DayUseDialog type={dialog} prices={pricesOf(dialog.id)} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast.success("Day-use prices saved."); reload(); }} />}
    </SectionCard>
  );
}

function DayUseDialog({ type, prices, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(() => (prices.length ? prices.map((p) => ({ hours: String(p.hours), rate: text(p.rate) })) : [{ hours: "4", rate: "" }]));
  const change = (index, name) => (e) => setRows((all) => all.map((r, i) => (i === index ? { ...r, [name]: e.target.value } : r)));
  return (
    <FormDialog title={`Day use · ${type.name}`} icon="calendar" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Save the prices"
      description="Each block of hours (1 to 12) priced once. Remove them all to sell no day use of this room type."
      onSubmit={() => businessWrite(biz.id, "lodging/day-use-rates", { roomTypeId: type.id, rates: rows.filter((r) => r.hours !== "" && r.rate !== "").map((r) => ({ hours: r.hours, rate: r.rate })) }, "put")}>
      {rows.map((r, i) => (
        <fieldset key={i} className="field-wide ldg-fieldset" aria-label={`Block ${i + 1}`}>
          <Field label="Hours"><input required type="number" min="1" max="12" value={r.hours} onChange={change(i, "hours")} /></Field>
          <Field label="Price (before GST)"><input required type="number" min="0.01" step="0.01" value={r.rate} onChange={change(i, "rate")} /></Field>
          <button type="button" className="link-button" onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>Remove</button>
        </fieldset>
      ))}
      {rows.length < 12 && <button type="button" className="button button-secondary field-wide" onClick={() => setRows((all) => [...all, { hours: "", rate: "" }])}><Icon name="plus" size={14} /> Add a block of hours</button>}
    </FormDialog>
  );
}

// --- Policies ------------------------------------------------------------------------------------------------

export function PoliciesTab() {
  const biz = useOpenBusiness();
  const { data, error, reload } = useRates({});
  const [dialog, setDialog] = useState(null);
  const canEdit = biz.can("settings.edit");
  if (!data) return waiting(error);
  const done = (message) => { setDialog(null); toast.success(message); reload(); };
  return (
    <SectionCard flush icon="settings" title="Policies"
      description="Early check-in and late check-out charges, the cancellation window and charge, the no-show charge and the deposit. A stay keeps the policy it was booked under (its plan's, else its property's default, else the business's); a manager may waive a charge."
      actions={canEdit && <button type="button" className="button button-sm" onClick={() => setDialog({})}><Icon name="plus" size={14} /> Add a policy</button>}>
      <DataGrid variant="compact" id="lodging-policies" caption="Policies" rows={data.policies} rowKey={(p) => p.id} rowNoun={["policy", "policies"]}
        rowClassName={(p) => (p.active ? "" : "dg-tone-muted")} empty="No policies yet" emptyHint="Without a policy nothing is charged for an early check-in or a late check-out, and a cancellation charge is typed." emptyIcon="settings" columns={[
          { key: "name", header: "Policy", value: (p) => p.name, mobile: "title", pin: true },
          { key: "location", header: "Property", value: (p) => `${p.location_name || "Every property"}${p.is_default ? " · default" : ""}`, mobile: "subtitle" },
          { key: "terms", header: "Terms", value: (p) => policyWords(p, biz).join(" · ") || "Nothing charged", mobile: "show" },
          { key: "active", header: "In use", value: (p) => (p.active ? "Yes" : "No"), render: (p) => <ActiveBadge active={p.active} /> },
          canEdit && { key: "actions", header: "", type: "actions", render: (p) => <button type="button" className="link-button" onClick={() => setDialog({ policy: p })}>Edit</button> },
        ].filter(Boolean)} />
      {dialog && <PolicyDialog policy={dialog.policy} onClose={() => setDialog(null)} onSaved={() => done(dialog.policy ? "Policy saved." : "Policy added.")} />}
    </SectionCard>
  );
}

const TIME_KINDS = [{ value: "", label: "Not charged" }, { value: "percent", label: "A percentage of the night" }, { value: "flat", label: "A flat fee" }, { value: "night", label: "A full night" }];

function PolicyDialog({ policy, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const p = policy || {};
  const [form, setForm] = useState({ name: p.name || "", locationId: p.location_id ? String(p.location_id) : "", isDefault: Boolean(p.is_default), earlyKind: p.early_kind || "", earlyValue: text(p.early_value),
    lateKind: p.late_kind || "", lateValue: text(p.late_value), cancelKind: p.cancel_kind || "", cancelFreeHours: p.cancel_free_hours === undefined || p.cancel_free_hours === null ? "48" : String(p.cancel_free_hours),
    cancelValue: text(p.cancel_value), noShowKind: p.no_show_kind || "", depositKind: p.deposit_kind || "", depositValue: text(p.deposit_value),
    depositDays: p.deposit_days === undefined || p.deposit_days === null ? "0" : String(p.deposit_days), active: policy ? policy.active : true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const valued = (kind) => kind === "percent" || kind === "flat";
  const body = () => ({ name: form.name.trim(), locationId: form.locationId || null, isDefault: form.isDefault,
    earlyKind: form.earlyKind || null, earlyValue: valued(form.earlyKind) ? form.earlyValue : null, lateKind: form.lateKind || null, lateValue: valued(form.lateKind) ? form.lateValue : null,
    cancelKind: form.cancelKind || null, cancelFreeHours: form.cancelKind ? form.cancelFreeHours : null, cancelValue: form.cancelKind ? form.cancelValue : null,
    noShowKind: form.noShowKind || null, depositKind: form.depositKind || null, depositValue: form.depositKind === "percent" ? form.depositValue : null,
    depositDays: form.depositKind ? form.depositDays : null });
  const locations = biz.locations.filter((l) => l.active || String(l.id) === form.locationId);
  return (
    <FormDialog title={policy ? `Edit ${policy.name}` : "Add a policy"} icon="settings" width={720} onClose={onClose} onSaved={onSaved} submitLabel={policy ? "Save" : "Add the policy"}
      description="Charges are worked out from the room nights' values (after any discount, before GST), billed at the room's GST slab."
      onSubmit={() => (policy ? businessWrite(biz.id, `lodging/policies/${policy.id}`, { ...body(), active: form.active }, "patch") : businessWrite(biz.id, "lodging/policies", body()))}>
      <Field label="Policy name"><input required maxLength={80} value={form.name} onChange={set("name")} placeholder="e.g. Standard, Peak season" /></Field>
      <Field label="Property"><select value={form.locationId} onChange={set("locationId")}>
        <option value="">Every property</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.isDefault} onChange={set("isDefault")} /> The default policy (for stays whose plan names none)</label>
      <Field label="Early check-in charged as"><select value={form.earlyKind} onChange={set("earlyKind")}>{TIME_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
      {valued(form.earlyKind) && <Field label={form.earlyKind === "percent" ? "Early check-in (% of the night)" : "Early check-in fee"}>
        <input required type="number" min="0.01" max={form.earlyKind === "percent" ? 100 : undefined} step="0.01" value={form.earlyValue} onChange={set("earlyValue")} /></Field>}
      <Field label="Late check-out charged as"><select value={form.lateKind} onChange={set("lateKind")}>{TIME_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
      {valued(form.lateKind) && <Field label={form.lateKind === "percent" ? "Late check-out (% of the night)" : "Late check-out fee"}>
        <input required type="number" min="0.01" max={form.lateKind === "percent" ? 100 : undefined} step="0.01" value={form.lateValue} onChange={set("lateValue")} /></Field>}
      <Field label="A cancellation costs"><select value={form.cancelKind} onChange={set("cancelKind")}>
        <option value="">Nothing</option><option value="nights">Nights of the stay</option><option value="percent">A percentage of the stay</option></select></Field>
      {form.cancelKind && (
        <>
          <Field label="Free until (hours before arrival)"><input required type="number" min="0" max="8760" value={form.cancelFreeHours} onChange={set("cancelFreeHours")} /></Field>
          <Field label={form.cancelKind === "nights" ? "Nights charged" : "Percentage of the stay"}>
            <input required type="number" min={form.cancelKind === "nights" ? 1 : 0.01} max={form.cancelKind === "nights" ? 30 : 100} step={form.cancelKind === "nights" ? 1 : 0.01} value={form.cancelValue} onChange={set("cancelValue")} /></Field>
        </>
      )}
      <Field label="A no-show costs"><select value={form.noShowKind} onChange={set("noShowKind")}>
        <option value="">Nothing</option><option value="first_night">The first night</option><option value="full_stay">The full stay</option></select></Field>
      <Field label="Deposit asked"><select value={form.depositKind} onChange={set("depositKind")}>
        <option value="">None</option><option value="percent">A percentage of the stay</option><option value="first_night">The first night</option></select></Field>
      {form.depositKind === "percent" && <Field label="Deposit (% of the stay)"><input required type="number" min="0.01" max="100" step="0.01" value={form.depositValue} onChange={set("depositValue")} /></Field>}
      {form.depositKind && <Field label="Deposit due (days before arrival)"><input required type="number" min="0" max="365" value={form.depositDays} onChange={set("depositDays")} /></Field>}
      {policy && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>}
    </FormDialog>
  );
}

// --- Linen and minibar checklists ------------------------------------------------------------------------

// Each room type's linen (named) and minibar (goods kept in stock by quantity) with how many a room holds: housekeeping counts a room
// against it, and what a guest used of the minibar goes on their folio.
export function ChecklistsTab({ setup }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/checklists", undefined, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  if (!data) return waiting(error);
  const canEdit = biz.can("catalog.edit");
  const rows = setup.roomTypes.filter((t) => t.active).map((t) => ({ ...t, items: data.items.filter((i) => Number(i.room_type_id) === Number(t.id)) }));
  const words = (items, kind) => items.filter((i) => i.kind === kind).map((i) => `${i.name} × ${i.par}`).join(", ");
  return (
    <SectionCard flush icon="check" title="Linen & minibar"
      description="What a room of each type holds. Housekeeping counts a room against it; what a guest used of the minibar goes on their folio as goods, and leaves stock when the folio is billed.">
      <DataGrid variant="compact" id="lodging-checklists" caption="Linen and minibar" rows={rows} rowKey={(t) => t.id} rowNoun={["room type", "room types"]} empty="No room types yet" emptyIcon="home" columns={[
        { key: "name", header: "Room type", value: (t) => t.name, mobile: "title", pin: true },
        { key: "linen", header: "Linen", value: (t) => words(t.items, "linen") || "", mobile: "show" },
        { key: "minibar", header: "Minibar", value: (t) => words(t.items, "minibar") || "", mobile: "subtitle" },
        canEdit && { key: "actions", header: "", type: "actions", render: (t) => <button type="button" className="link-button" onClick={() => setDialog(t)}>Edit</button> },
      ].filter(Boolean)} />
      {dialog && <ChecklistDialog type={dialog} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast.success(`${dialog.name}: checklist saved.`); setVersion((n) => n + 1); }} />}
    </SectionCard>
  );
}

function ChecklistDialog({ type, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["catalog?kind=goods&active=true"]);
  const goods = useMemo(() => (options?.["catalog?kind=goods&active=true"] || []).filter((s) => !s.is_kit && !["batch", "serial"].includes(s.tracking)), [options]);
  const [lines, setLines] = useState(() => type.items.map((i) => ({ kind: i.kind, name: i.kind === "linen" ? i.name : "", skuId: i.sku_id ? String(i.sku_id) : "", par: String(i.par) })));
  const change = (index, name, value) => setLines((list) => list.map((l, i) => (i === index ? { ...l, [name]: value } : l)));
  const add = (kind) => setLines((list) => [...list, { kind, name: "", skuId: "", par: kind === "linen" ? "2" : "1" }]);
  return (
    <FormDialog title={`${type.name}: linen and minibar`} icon="check" width={680} onClose={onClose} onSaved={onSaved} submitLabel="Save the checklist"
      description="An item taken off is switched off, never deleted: the checks made with it are kept."
      onSubmit={() => businessWrite(biz.id, "lodging/checklists", { roomTypeId: type.id, items: lines.map((l) => (l.kind === "linen" ? { kind: "linen", name: l.name.trim(), par: l.par }
        : { kind: "minibar", skuId: l.skuId, par: l.par })) }, "put")}>
      {lines.map((l, index) => (
        <div key={index} className="field-wide ldg-when">
          {l.kind === "linen"
            ? <Field label="Linen"><input required maxLength={80} value={l.name} onChange={(e) => change(index, "name", e.target.value)} placeholder="e.g. Bath towel" /></Field>
            : <Field label="Minibar item"><select required value={l.skuId} onChange={(e) => change(index, "skuId", e.target.value)}>
              <option value="">Choose…</option>{goods.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>}
          <Field label="A room holds"><input required type="number" min="1" max="99" step="1" value={l.par} onChange={(e) => change(index, "par", e.target.value)} /></Field>
          <button type="button" className="link-button" onClick={() => setLines((list) => list.filter((_, i) => i !== index))}>Take off</button>
        </div>
      ))}
      <div className="form-actions field-wide bz-start">
        <button type="button" className="button button-secondary button-sm" onClick={() => add("linen")}><Icon name="plus" size={14} /> Linen</button>
        <button type="button" className="button button-secondary button-sm" onClick={() => add("minibar")}><Icon name="plus" size={14} /> Minibar item</button>
      </div>
    </FormDialog>
  );
}
