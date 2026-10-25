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
import { ActiveBadge, BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { COUNTED, wordOf } from "./laundry";
import "../styles/laundry.css";

// The price list: the services the shop offers, each billed as a service item
// of the catalogue (its name on the bill, its GST slab and SAC: laundry, dry
// cleaning, pressing and dyeing are in SAC group 99971, at 18% with input tax
// credit); the garments it takes, counted as a piece, a pair or a set; and the
// price of each garment for each service, for each one or by the kilo. Orders
// keep the prices they were taken in at. Below: how orders are billed and
// handed over, the express surcharge, the days, and the terms on the receipt.

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
              <option value="item">each</option><option value="kg">a kg</option>
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
          { key: "active", header: "Offered", value: (s) => (s.active ? "Yes" : "No"), render: (s) => <ActiveBadge active={s.active && s.item_active} /> },
          canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => (
            <button type="button" className="chip-button" onClick={() => toggleService(s)}>{s.active ? "Stop offering" : "Offer again"}</button>
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
        {services.length > 0 && <p className="ldy-note">An empty price takes the garment off the list for that service. "A kg" prices a bundle by its weight; its pieces are counted at intake too.</p>}
      </SectionCard>
      <OrderSettings settings={data.settings} onSaved={(s) => setData((d) => ({ ...d, settings: s }))} />
      {dialog?.kind === "service" && <ServiceDialog onClose={() => setDialog(null)} onSaved={() => reload("Service added.")} />}
      {dialog?.kind === "garment" && <GarmentDialog garment={dialog.garment || null} onClose={() => setDialog(null)} onSaved={() => reload(dialog.garment ? "Garment saved." : "Garment added.")} />}
    </div>
  );
}

// How orders are billed and handed over, express, the days, and the terms on every receipt.
function OrderSettings({ settings, onSaved }) {
  const biz = useOpenBusiness();
  const canEdit = biz.can("settings.edit");
  const [form, setForm] = useState(() => ({ ...settings, receiptTerms: settings.receiptTerms || "" }));
  const [saving, setSaving] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await businessWrite(biz.id, "laundry/settings", { billAt: form.billAt, partDelivery: form.partDelivery, expressPercent: form.expressPercent,
        readyDays: form.readyDays, expressDays: form.expressDays, unclaimedDays: form.unclaimedDays, receiptTerms: form.receiptTerms }, "put");
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
