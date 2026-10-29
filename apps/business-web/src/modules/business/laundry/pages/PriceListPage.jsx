import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { dateShort } from "@bmp/shared/format";
import { COUNTED, PER_WORDS, WEEKDAYS, wordOf } from "./laundry";
import "../styles/laundry.css";

// The price list: the services the shop offers, each billed as a service item
// of the catalogue (its name on the bill, its GST slab and SAC: laundry, dry
// cleaning, pressing and dyeing are in SAC group 99971, at 18% with input tax
// credit); the garments it takes, counted as a piece, a pair or a set; and the
// price of each garment for each service, for each one, by the kilo or by the
// square foot (carpets, curtains); prices of their own for a counter, a
// customer or a group of customers, from a date; the customer groups. Orders
// keep the prices they were taken in at. Below: how orders are billed and
// handed over, the express surcharge, the days (each service may have its
// own), the days the shop is closed, how an area is rounded, the quality check
// and packing, and the terms on the receipt.

const key = (garmentId, serviceId) => `${garmentId}:${serviceId}`;

export default function PriceListPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [showOff, setShowOff] = useState(false);
  const canEdit = biz.can("catalog.edit");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "laundry/price-list", undefined, controller.signal)
      .then((d) => { setData(d); setError(""); setDraft({}); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };

  const services = useMemo(() => (data?.services || []).filter((s) => s.active), [data]);
  const garments = useMemo(() => (data?.garments || []).filter((g) => showOff || g.active), [data, showOff]);
  const priceOf = (g, s) => draft[key(g.id, s.id)] ?? (() => {
    const p = (data?.prices || []).find((x) => Number(x.garment_type_id) === Number(g.id) && Number(x.service_id) === Number(s.id));
    return p ? { price: String(Number(p.price).toFixed(2)), per: p.per } : { price: "", per: "item" };
  })();
  const setCell = (g, s, change) => setDraft((d) => ({ ...d, [key(g.id, s.id)]: { ...priceOf(g, s), ...change } }));
  const changed = Object.keys(draft).length;
  const savePrices = async () => {
    setSaving(true);
    try {
      const prices = Object.entries(draft).map(([k, v]) => {
        const [garmentTypeId, serviceId] = k.split(":");
        return { garmentTypeId, serviceId, per: v.per, price: v.price === "" ? null : v.price };
      });
      const saved = await businessWrite(biz.id, "laundry/prices", { prices }, "put");
      setData(saved);
      setDraft({});
      toast.success("Prices saved.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const toggleService = (s) => businessWrite(biz.id, `laundry/services/${s.id}`, { active: !s.active }, "put")
    .then(() => reload(`${s.name} ${s.active ? "is not offered now" : "is offered again"}.`)).catch((err) => toast.error(getErrorMessage(err)));

  if (!data) return <div className="stack"><BusinessHeader icon="tag" title="Price list" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const off18 = data.services.filter((s) => s.active && Number(s.tax_rate) !== 18);
  const columns = [
    { key: "garment", header: "Garment", value: (g) => g.name, mobile: "title", pin: true,
      render: (g) => (
        <span className="bz-two-line">
          {canEdit ? <button type="button" className="link-button" onClick={() => setDialog({ kind: "garment", garment: g })}>{g.name}</button> : <span>{g.name}</span>}
          <small className="muted">{g.counted_as === "set" ? `A set of ${g.pieces}` : wordOf(COUNTED, g.counted_as)}{g.active ? "" : " · not taken in"}</small>
        </span>
      ) },
    ...services.map((s) => ({
      key: `s${s.id}`, header: s.name, value: (g) => priceOf(g, s).price, sortable: false, minWidth: 170,
      render: (g) => {
        const p = priceOf(g, s);
        return (
          <span className="ldy-price">
            <input aria-label={`${s.name}: ${g.name}`} type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="—" disabled={!canEdit}
              value={p.price} onChange={(e) => setCell(g, s, { price: e.target.value })} />
            <select aria-label={`${s.name}: ${g.name}, priced`} disabled={!canEdit} value={p.per} onChange={(e) => setCell(g, s, { per: e.target.value })}>
              <option value="item">each</option><option value="kg">a kg</option><option value="sqft">a sq ft</option>
            </select>
          </span>
        );
      },
    })),
  ];

  return (
    <div className="stack">
      <BusinessHeader icon="tag" title="Price list"
        description="Each garment's price for each service, for each one or by the kilo. Orders keep the prices they were taken in at; the activity log keeps every change."
        primary={canEdit && <button type="button" className="button" onClick={() => setDialog({ kind: "garment" })}><Icon name="plus" size={16} /> Add a garment</button>}
        secondary={canEdit && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "service" })}><Icon name="plus" size={16} /> Add a service</button>} />
      <ErrorMessage message={error} />
      <SectionCard flush icon="list" title="Services"
        description="Each service is billed as a service item: its name on the bill, its GST slab and its SAC come from the item.">
        {off18.length > 0 && <p className="ldy-note ldy-warn">Laundry, dry cleaning, pressing and dyeing are at 18% with input tax credit: check the GST slab of {off18.map((s) => s.name).join(", ")}.</p>}
        <DataGrid variant="compact" id="laundry-services" caption="Services" rows={data.services} rowKey={(s) => s.id} rowNoun={["service", "services"]} columns={[
          { key: "name", header: "Service", value: (s) => s.name, mobile: "title", render: (s) => <span className="bz-two-line"><span>{s.name}</span><small className="muted mono">{s.item_code}</small></span> },
          { key: "gst", header: "GST", value: (s) => Number(s.tax_rate), render: (s) => `${Number(s.tax_rate)}%`, mobile: "show" },
          { key: "sac", header: "SAC", value: (s) => s.hsn_code || "", render: (s) => (s.hsn_code ? <span className="mono">{s.hsn_code}</span> : <span className="muted">—</span>) },
          { key: "prices", header: "Prices", type: "number", value: (s) => s.prices },
          { key: "days", header: "Days (express)", value: (s) => s.ready_days ?? "", render: (s) => (s.ready_days === null && s.express_days === null
            ? <span className="muted">The shop's</span> : `${s.ready_days ?? data.settings.readyDays} (${s.express_days ?? data.settings.expressDays})`) },
          { key: "active", header: "Offered", value: (s) => (s.active ? "Yes" : "No"), render: (s) => <ActiveBadge active={s.active && s.item_active} /> },
          canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => (
            <span className="bz-row-actions">
              <button type="button" className="chip-button" onClick={() => setDialog({ kind: "days", service: s })}>Days</button>
              <button type="button" className="chip-button" onClick={() => toggleService(s)}>{s.active ? "Stop offering" : "Offer again"}</button>
            </span>
          ) },
        ].filter(Boolean)} empty="No services yet" emptyHint={canEdit ? "Add the services the shop offers: dry cleaning, wash and iron, wash and fold, steam press." : undefined} emptyIcon="list" />
      </SectionCard>
      <SectionCard flush icon="tag" title="Prices"
        actions={canEdit && changed > 0 && (
          <span className="form-actions bz-start">
            <button type="button" className="button button-secondary" disabled={saving} onClick={() => setDraft({})}>Undo changes</button>
            <button type="button" className="button" disabled={saving} onClick={savePrices}>{saving ? "Saving…" : `Save ${changed} ${changed === 1 ? "price" : "prices"}`}</button>
          </span>
        )}>
        {services.length === 0 ? <p className="ldy-note">Add a service first; each garment then takes a price for it.</p> : (
          <DataGrid variant="editor" id="laundry-prices" caption="Prices by garment and service" rows={garments} rowKey={(g) => g.id} rowNoun={["garment", "garments"]} columns={columns}
            toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show garments not taken in</label>}
            empty="No garments yet" emptyHint={canEdit ? "Add the garments taken in: shirt, trouser, saree, suit, blanket." : undefined} emptyIcon="tag" />
        )}
        {services.length > 0 && <p className="ldy-note">An empty price takes the garment off the list for that service. "A kg" prices a bundle by its weight; its pieces are counted at intake too. "A sq ft" prices a carpet or curtain by its length × width in feet.</p>}
      </SectionCard>
      <OwnPrices data={data} />
      <Groups />
      <OrderSettings settings={data.settings} onSaved={(s) => setData((d) => ({ ...d, settings: s }))} />
      {dialog?.kind === "service" && <ServiceDialog onClose={() => setDialog(null)} onSaved={() => reload("Service added.")} />}
      {dialog?.kind === "days" && <DaysDialog service={dialog.service} settings={data.settings} onClose={() => setDialog(null)} onSaved={() => reload("Days saved.")} />}
      {dialog?.kind === "garment" && <GarmentDialog garment={dialog.garment || null} onClose={() => setDialog(null)} onSaved={() => reload(dialog.garment ? "Garment saved." : "Garment added.")} />}
    </div>
  );
}

// How orders are billed and handed over, express, the days, and the terms on every receipt.
function OrderSettings({ settings, onSaved }) {
  const biz = useOpenBusiness();
  const canEdit = biz.can("settings.edit");
  const [form, setForm] = useState(() => ({ ...settings, receiptTerms: settings.receiptTerms || "", closedDays: settings.closedDays || [] }));
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await businessWrite(biz.id, "laundry/settings", { billAt: form.billAt, partDelivery: form.partDelivery, expressPercent: form.expressPercent,
        readyDays: form.readyDays, expressDays: form.expressDays, unclaimedDays: form.unclaimedDays, receiptTerms: form.receiptTerms, areaRounding: form.areaRounding,
        closedDays: form.closedDays, qcRequired: form.qcRequired, packingRequired: form.packingRequired }, "put");
      onSaved(saved);
      toast.success("Order settings saved. Orders taken in before keep their own rules.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SectionCard icon="settings" title="Order settings" description="Orders taken in keep the rules they were taken in under.">
      <form className="form-grid bz-form" onSubmit={save}>
        <fieldset className="bz-fieldset" disabled={!canEdit || saving}>
          <Field label="Billed" hint="At delivery: an advance may be taken at intake. At intake: the bill is made when the order is taken in.">
            <select value={form.billAt} onChange={set("billAt")}><option value="delivery">When the garments are delivered</option><option value="intake">When the order is taken in</option></select>
          </Field>
          <Field label="Part of an order handed over" hint="Garments are held until paid as this says, unless the customer has an account with the shop.">
            <select value={form.partDelivery} onChange={set("partDelivery")}><option value="whole_order">The whole order is paid first</option><option value="garments">The garments handed over are paid for</option></select>
          </Field>
          <Field label="Express surcharge (%)" hint="Added to each garment's price on an express order."><input type="number" min="0" max="200" step="0.01" required value={form.expressPercent} onChange={set("expressPercent")} /></Field>
          <Field label="Days to the promised day"><input type="number" min="0" max="60" required value={form.readyDays} onChange={set("readyDays")} /></Field>
          <Field label="Days to the promised day, express"><input type="number" min="0" max="60" required value={form.expressDays} onChange={set("expressDays")} /></Field>
          <Field label="Unclaimed after (days ready)"><input type="number" min="1" max="365" required value={form.unclaimedDays} onChange={set("unclaimedDays")} /></Field>
          <fieldset className="field-wide ldy-picks">
            <legend>Closed each week (the promised day skips these days)</legend>
            {WEEKDAYS.map((d) => <label key={d.value} className="checkbox"><input type="checkbox" checked={form.closedDays.includes(d.value)}
              onChange={() => setForm((f) => ({ ...f, closedDays: f.closedDays.includes(d.value) ? f.closedDays.filter((x) => x !== d.value) : [...f.closedDays, d.value] }))} /> {d.label}</label>)}
          </fieldset>
          <Field label="Area by the square foot, rounded" hint="Length × width in feet.">
            <select value={form.areaRounding} onChange={set("areaRounding")}><option value="exact">To the hundredth</option><option value="nearest">To the nearest whole sq ft</option><option value="up">Up to the next whole sq ft</option></select>
          </Field>
          <label className="checkbox bz-check"><input type="checkbox" checked={form.qcRequired} onChange={(e) => setForm((f) => ({ ...f, qcRequired: e.target.checked }))} /> A quality check before the rack</label>
          <label className="checkbox bz-check"><input type="checkbox" checked={form.packingRequired} onChange={(e) => setForm((f) => ({ ...f, packingRequired: e.target.checked }))} /> Packed before the rack</label>
          <Field label="Terms printed on every receipt" wide hint="What the shop asks of its customers in its own words. A printed disclaimer does not protect a shop from its own negligence: note each garment's defects and risks at intake instead.">
            <textarea rows={4} maxLength={2000} value={form.receiptTerms} onChange={set("receiptTerms")} placeholder="e.g. Please check your garments when you collect them, and tell us of any problem the same day." />
          </Field>
        </fieldset>
        {canEdit && <div className="form-actions"><button type="submit" className="button" disabled={saving}>{saving ? "Saving…" : "Save the settings"}</button></div>}
      </form>
    </SectionCard>
  );
}

// A service: a new service item (its name, GST slab and SAC), or an existing one.
function ServiceDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["tax-rates?active=true"]);
  const slabs = options?.["tax-rates?active=true"] || [];
  const [existing, setExisting] = useState(null);
  const [form, setForm] = useState({ useExisting: false, name: "", taxRateId: "", hsnCode: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const slab = form.taxRateId || String(slabs.find((r) => r.is_default)?.id || "");
  const submit = () => {
    if (form.useExisting) {
      if (!existing) throw new Error("Choose the service item");
      return businessWrite(biz.id, "laundry/services", { skuId: existing.id });
    }
    return businessWrite(biz.id, "laundry/services", { item: { name: form.name, taxRateId: slab || undefined, hsnCode: form.hsnCode.trim() || undefined } });
  };
  return (
    <FormDialog title="Add a service" icon="list" width={640} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Add the service"
      description="A service is billed as a service item of the catalogue: its prices are on the price list, by garment.">
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.useExisting} onChange={set("useExisting")} /> Billed as a service item already in the catalogue</label>
      {form.useExisting ? (
        <div className="field-wide">
          <SearchPicker label="Service item" placeholder="Name or code" value={existing} onChange={setExisting} minChars={1}
            search={(q, { signal }) => businessRead(biz.id, "catalog", { kind: "service", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
            getLabel={(s) => s.label} getDescription={(s) => `${s.code} · GST ${Number(s.tax_rate)}%${s.hsn_code ? ` · SAC ${s.hsn_code}` : ""}`} />
        </div>
      ) : (
        <>
          <Field label="Service" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Dry cleaning, Wash & iron, Wash & fold, Steam press" /></Field>
          <Field label="GST" hint="Laundry, dry cleaning, pressing and dyeing: 18%, with input tax credit.">
            <select required value={slab} onChange={set("taxRateId")}>{slabs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </Field>
          <Field label="SAC (optional)" hint="Laundry, dry cleaning, pressing and dyeing are in group 99971 (dry cleaning 999712). Have an accountant confirm each code.">
            <input inputMode="numeric" maxLength={8} className="mono" value={form.hsnCode} onChange={set("hsnCode")} placeholder="999712" />
          </Field>
        </>
      )}
    </FormDialog>
  );
}

function GarmentDialog({ garment, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => ({ name: garment?.name || "", countedAs: garment?.counted_as || "piece", pieces: garment?.counted_as === "set" ? String(garment.pieces) : "2",
    active: garment ? garment.active : true }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => {
    const body = { name: form.name, countedAs: form.countedAs, ...(form.countedAs === "set" ? { pieces: form.pieces } : {}) };
    return garment ? businessWrite(biz.id, `laundry/garments/${garment.id}`, { ...body, active: form.active }, "put") : businessWrite(biz.id, "laundry/garments", body);
  };
  return (
    <FormDialog title={garment ? `Change ${garment.name}` : "Add a garment"} icon="tag" width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={garment ? "Save" : "Add the garment"} description={garment ? "Orders taken in keep the garment as it was." : "Each garment then takes a price for each service on the price list."}>
      <Field label="Garment" wide><input required maxLength={80} value={form.name} onChange={set("name")} placeholder="e.g. Shirt, Saree, Suit (2 piece), Blanket, Shoes" /></Field>
      <Field label="Counted as"><select value={form.countedAs} onChange={set("countedAs")}>{COUNTED.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></Field>
      {form.countedAs === "set" && <Field label="Pieces in the set" hint="Each piece gets its own tag label."><input type="number" min="2" max="20" required value={form.pieces} onChange={set("pieces")} /></Field>}
      {garment && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> Taken in (untick to stop taking it)</label>}
    </FormDialog>
  );
}

// A service's own days to the promised day, and for express (empty: the shop's).
function DaysDialog({ service, settings, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ readyDays: service.ready_days ?? "", expressDays: service.express_days ?? "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Days for ${service.name}`} icon="calendar" width={520} onClose={onClose} onSaved={onSaved}
      description={`The promised day comes from the slowest garment on the order. Empty: the shop's days (${settings.readyDays}, express ${settings.expressDays}).`}
      onSubmit={() => businessWrite(biz.id, `laundry/services/${service.id}`, { readyDays: String(form.readyDays), expressDays: String(form.expressDays) }, "put")}>
      <Field label="Days to the promised day"><input type="number" min="0" max="60" value={form.readyDays} onChange={set("readyDays")} /></Field>
      <Field label="Days, express"><input type="number" min="0" max="60" value={form.expressDays} onChange={set("expressDays")} /></Field>
    </FormDialog>
  );
}

const SCOPES = { location: "Counter", group: "Group", customer: "Customer" };
// Prices of their own: for a counter, a group of customers or one customer, from a date (ended, never deleted).
function OwnPrices({ data }) {
  const biz = useOpenBusiness();
  const [ended, setEnded] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useServerList("laundry/price-overrides", { gridId: "laundry-price-overrides", params: ended ? {} : { current: "true" } });
  const canEdit = biz.can("catalog.edit");
  const end = (o) => businessWrite(biz.id, `laundry/price-overrides/${o.id}/end`, {}).then(() => { toast.success("Price ended."); list.reload(); }).catch((err) => toast.error(getErrorMessage(err)));
  return (
    <SectionCard flush icon="tag" title="Prices of their own"
      description="A counter's, a group's or a customer's price for a garment and service, from a date. A customer's comes first, then their group's, then the counter's, then the list."
      actions={canEdit && <button type="button" className="button button-secondary button-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add a price of its own</button>}>
      <DataGrid {...list.gridProps} caption="Prices of their own" rowNoun={["price", "prices"]} currency={biz.symbol}
        toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={ended} onChange={(e) => setEnded(e.target.checked)} /> Show those ended</label>}
        columns={[
          { key: "garment", header: "Garment and service", value: (o) => `${o.garment_name} ${o.service_name}`, mobile: "title",
            render: (o) => <span className="bz-two-line"><span>{o.garment_name}</span><small className="muted">{o.service_name}</small></span> },
          { key: "for", header: "For", value: (o) => o.customer_name || o.group_name || o.location_name, mobile: "show",
            render: (o) => <span className="bz-two-line"><span>{o.customer_name || o.group_name || o.location_name}</span><small className="muted">{SCOPES[o.scope]}</small></span> },
          { key: "price", header: "Price", type: "money", exact: true, value: (o) => Number(o.price), render: (o) => `${biz.exact(o.price)} ${PER_WORDS[o.per]}` },
          { key: "from", header: "In force", value: (o) => o.valid_from, render: (o) => (
            <span className="bz-two-line"><span>{dateShort(o.valid_from, { year: true })}{o.valid_to ? ` to ${dateShort(o.valid_to, { year: true })}` : " on"}</span>
              <small className="muted">{o.in_force ? <Badge tone="success" label="In force" /> : o.current ? "to come" : "ended"}</small></span>) },
          canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => (o.current ? <button type="button" className="chip-button" onClick={() => end(o)}>End</button> : null) },
        ].filter(Boolean)} empty="No prices of their own" emptyHint="Every garment is at its price on the list." emptyIcon="tag" />
      {adding && <OwnPriceDialog data={data} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); toast.success("Price saved."); list.reload(); }} />}
    </SectionCard>
  );
}

function OwnPriceDialog({ data, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [groups, setGroups] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [form, setForm] = useState({ garmentTypeId: "", serviceId: "", scope: "customer", locationId: String(biz.locations[0]?.id || ""), groupId: "", price: "", validFrom: today });
  useEffect(() => { businessRead(biz.id, "laundry/groups").then((g) => setGroups(g.filter((x) => x.active))).catch(() => {}); }, [biz.id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const listed = data.prices.find((p) => String(p.garment_type_id) === form.garmentTypeId && String(p.service_id) === form.serviceId);
  const servicesFor = data.services.filter((s) => data.prices.some((p) => String(p.garment_type_id) === form.garmentTypeId && String(p.service_id) === String(s.id)));
  return (
    <FormDialog title="A price of its own" icon="tag" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Save the price"
      description="From the day given; the one in force then ends the day before. Orders keep the prices they were taken in at."
      onSubmit={() => {
        if (form.scope === "customer" && !customer) throw new Error("Choose the customer");
        return businessWrite(biz.id, "laundry/price-overrides", { garmentTypeId: form.garmentTypeId, serviceId: form.serviceId, price: form.price, validFrom: form.validFrom,
          ...(form.scope === "customer" ? { contactId: customer.id } : form.scope === "group" ? { groupId: form.groupId } : { locationId: form.locationId }) });
      }}>
      <Field label="Garment"><select required value={form.garmentTypeId} onChange={(e) => setForm((f) => ({ ...f, garmentTypeId: e.target.value, serviceId: "" }))}>
        <option value="">Choose…</option>{data.garments.filter((g) => g.active).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
      <Field label="Service"><select required value={form.serviceId} onChange={set("serviceId")}>
        <option value="">Choose…</option>{servicesFor.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="For"><select value={form.scope} onChange={set("scope")}><option value="customer">A customer</option><option value="group">A group of customers</option><option value="location">A counter</option></select></Field>
      {form.scope === "customer" && (
        <div className="field">
          <SearchPicker label="Customer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
            search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
            getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
        </div>
      )}
      {form.scope === "group" && <Field label="Group"><select required value={form.groupId} onChange={set("groupId")}><option value="">Choose…</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>}
      {form.scope === "location" && <Field label="Counter"><select value={form.locationId} onChange={set("locationId")}>{biz.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label={`Price${listed ? ` (${PER_WORDS[listed.per]}; the list's ${biz.exact(listed.price)})` : ""}`}><input type="number" required min="0.01" step="0.01" value={form.price} onChange={set("price")} /></Field>
      <Field label="From"><input type="date" required min={today} value={form.validFrom} onChange={set("validFrom")} /></Field>
    </FormDialog>
  );
}

// Groups of customers priced together, and who is in each.
function Groups() {
  const biz = useOpenBusiness();
  const [groups, setGroups] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  const canEdit = biz.can("catalog.edit");
  useEffect(() => { businessRead(biz.id, "laundry/groups").then(setGroups).catch(() => setGroups([])); }, [biz.id, version]);
  const done = (message) => { setDialog(null); toast.success(message); setVersion((n) => n + 1); };
  return (
    <SectionCard flush icon="users" title="Customer groups" description="Customers priced together: a housing society, the hotels you serve. A customer is in one group at a time."
      actions={canEdit && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "group" })}><Icon name="plus" size={14} /> Add a group</button>}>
      <DataGrid variant="compact" id="laundry-groups" caption="Customer groups" rows={groups || []} loading={!groups} rowKey={(g) => g.id} rowNoun={["group", "groups"]} columns={[
        { key: "name", header: "Group", value: (g) => g.name, mobile: "title" },
        { key: "members", header: "Customers", type: "number", value: (g) => g.members },
        { key: "active", header: "In use", value: (g) => (g.active ? "Yes" : "No"), render: (g) => <ActiveBadge active={g.active} /> },
        { key: "actions", header: "", label: "Actions", type: "actions", render: (g) => (
          <span className="bz-row-actions">
            <button type="button" className="chip-button" onClick={() => setDialog({ kind: "members", group: g })}>Customers</button>
            {canEdit && <button type="button" className="chip-button" onClick={() => businessWrite(biz.id, `laundry/groups/${g.id}`, { active: !g.active }, "put")
              .then(() => done(g.active ? `${g.name} switched off.` : `${g.name} in use again.`)).catch((err) => toast.error(getErrorMessage(err)))}>{g.active ? "Switch off" : "Use again"}</button>}
          </span>) },
      ]} empty="No groups yet" emptyIcon="users" />
      {dialog?.kind === "group" && <GroupDialog onClose={() => setDialog(null)} onSaved={() => done("Group added.")} />}
      {dialog?.kind === "members" && <MembersDialog group={dialog.group} canEdit={canEdit} onClose={() => { setDialog(null); setVersion((n) => n + 1); }} />}
    </SectionCard>
  );
}

function GroupDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [name, setName] = useState("");
  return (
    <FormDialog title="Add a customer group" icon="users" width={480} onClose={onClose} onSaved={onSaved} submitLabel="Add the group"
      onSubmit={() => businessWrite(biz.id, "laundry/groups", { name })}>
      <Field label="Group" wide><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Green Meadows Society" /></Field>
    </FormDialog>
  );
}

function MembersDialog({ group, canEdit, onClose }) {
  const biz = useOpenBusiness();
  const list = useServerList("laundry/group-members", { gridId: "laundry-group-members", params: { group: group.id } });
  const [customer, setCustomer] = useState(null);
  const put = (contactId, groupId) => businessWrite(biz.id, "laundry/group-members", { contactId, groupId }, "put")
    .then(() => { setCustomer(null); list.reload(); }).catch((err) => toast.error(getErrorMessage(err)));
  return (
    <FormDialog title={`Customers in ${group.name}`} icon="users" width={620} onClose={onClose} submitLabel="Done" onSubmit={() => null} onSaved={onClose}>
      {canEdit && (
        <div className="field-wide ldy-customer">
          <div className="field ldy-grow">
            <SearchPicker label="Add a customer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
              search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
              getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
          </div>
          <button type="button" className="button button-secondary" disabled={!customer} onClick={() => put(customer.id, group.id)}>Add</button>
        </div>
      )}
      <div className="field-wide">
        <DataGrid {...list.gridProps} variant="compact" caption={`Customers in ${group.name}`} rowNoun={["customer", "customers"]} columns={[
          { key: "name", header: "Customer", value: (m) => m.name, mobile: "title" },
          { key: "phone", header: "Phone", value: (m) => m.phone || "" },
          canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (m) => <button type="button" className="chip-button" onClick={() => put(m.id, null)}>Take out</button> },
        ].filter(Boolean)} empty="No customers in this group" emptyIcon="users" />
      </div>
    </FormDialog>
  );
}
