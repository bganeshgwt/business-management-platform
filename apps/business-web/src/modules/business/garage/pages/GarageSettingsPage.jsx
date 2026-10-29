import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { km } from "./garage";
import "../styles/garage.css";

// A garage's settings: when the next service falls after a job (6 months and
// 5,000 km until changed; editable on each bill), service plans by model or
// engine that take its place, the service item that bills the owner's share of
// a cashless claim (lines on the owner's bill at the slabs of the insurer's
// lines: the deductible, the depreciation and what the insurer did not allow),
// whether parts are issued to mechanics, whether a road test comes before
// ready, and the mechanics' commission rates. GST on parts and labour is each
// item's own slab (Settings › Tax rates).

export default function GarageSettingsPage() {
  const biz = useOpenBusiness();
  const canEdit = biz.can("settings.edit");
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const { options } = useOptions(["catalog?active=true&kind=service"]);
  const services = useMemo(() => (options?.["catalog?active=true&kind=service"] || []).filter((s) => !s.internal_use), [options]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "garage/settings", undefined, controller.signal)
      .then((s) => { setSettings(s); setForm({ serviceMonths: String(s.service_months), serviceKm: String(s.service_km), share: s.claim_share, issueParts: s.issue_parts, roadTest: s.road_test_required }); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await businessWrite(biz.id, "garage/settings", { serviceMonths: form.serviceMonths, serviceKm: form.serviceKm, claimShareSkuId: form.share?.id || null,
        issueParts: form.issueParts, roadTestRequired: form.roadTest }, "put");
      toast.success("Garage settings saved.");
      setVersion((n) => n + 1);
    } catch (err) { toast.error(getErrorMessage(err)); } finally { setSaving(false); }
  };
  // The claim-share item made in one go: a service at the 18% slab (SAC 998714, repair services).
  const make = async () => {
    try {
      const slabs = await businessRead(biz.id, "tax-rates", { active: "true", limit: 100 });
      const slab = slabs.items.find((r) => Number(r.rate) === 18) || slabs.items.find((r) => r.is_default);
      const sku = await businessWrite(biz.id, "catalog", { kind: "service", unit: "service", name: "Insurance claim: owner's share", code: "CLAIM-SHARE", price: "0",
        hsnCode: "998714", taxRateId: slab?.id });
      setForm((f) => ({ ...f, share: sku }));
      toast.success("Item made. Save to use it for claims.");
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  if (!settings || !form) return <div className="stack"><BusinessHeader icon="settings" title="Garage settings" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <BusinessHeader icon="settings" title="Garage settings"
        description="When the next service falls after a job, how the owner's share of an insurance claim is billed, how parts leave stock, the road test and the mechanics' commission." />
      <form className="stack" onSubmit={save}>
        <SectionCard icon="calendar" title="The next service" description="Set on the vehicle when a job is billed; it can be changed on each bill.">
          <div className="gar-setting">
            <Field label="Months after a job"><input type="number" min="1" max="36" step="1" required disabled={!canEdit} value={form.serviceMonths} onChange={(e) => setForm((f) => ({ ...f, serviceMonths: e.target.value }))} /></Field>
            <Field label="Kilometres after a job"><input inputMode="numeric" required disabled={!canEdit} value={form.serviceKm} onChange={(e) => setForm((f) => ({ ...f, serviceKm: e.target.value }))} /></Field>
            <small className="muted">Now {settings.service_months} months or {km(settings.service_km)}, whichever comes first.</small>
          </div>
        </SectionCard>
        <SectionCard icon="shield" title="The owner's share of a claim"
          description="On a cashless claim the insurer is billed for the amount it approved; the owner's bill carries their share of the insurer's lines as lines of this service item, one at each GST slab of those lines (parts at 18%, tractor parts at 5%).">
          <div className="gar-setting">
            <div className="field">
              <SearchPicker label="Claim-share item" placeholder="A service item" value={form.share} disabled={!canEdit} onChange={(s) => setForm((f) => ({ ...f, share: s }))}
                options={services} getLabel={(s) => s.label} getDescription={(s) => `${s.code} · GST ${Number(s.tax_rate)}%${s.hsn_code ? ` · ${s.hsn_code}` : ""}`} />
            </div>
            {canEdit && biz.can("catalog.create") && !form.share && <button type="button" className="button button-secondary" onClick={make}>Make the item</button>}
          </div>
        </SectionCard>
        <SectionCard icon="box" title="The workshop's way of working">
          <label className="checkbox bz-check"><input type="checkbox" disabled={!canEdit} checked={form.issueParts} onChange={(e) => setForm((f) => ({ ...f, issueParts: e.target.checked }))} />
            Issue parts to mechanics: parts leave stock when the store issues them for a job (held for it), and the bill takes them; otherwise they leave stock when the job is billed</label>
          <label className="checkbox bz-check"><input type="checkbox" disabled={!canEdit} checked={form.roadTest} onChange={(e) => setForm((f) => ({ ...f, roadTest: e.target.checked }))} />
            A passed road test before a job is marked ready</label>
        </SectionCard>
        {canEdit && (
          <div className="form-actions bz-start">
            <button type="submit" className="button" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            {settings.updated_by_name && <small className="muted">Last saved by {settings.updated_by_name} on {dateShort(settings.updated_at, { year: true })}</small>}
          </div>
        )}
      </form>
      <ServicePlans biz={biz} canEdit={canEdit} />
      <CommissionRates biz={biz} canEdit={canEdit} services={services} />
    </div>
  );
}

// Service plans by model or engine: the kilometres and days to the next service, whichever first.
function ServicePlans({ biz, canEdit }) {
  const [plans, setPlans] = useState(null);
  const [editing, setEditing] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "garage/plans", undefined, controller.signal).then(setPlans).catch(() => setPlans([]));
    return () => controller.abort();
  }, [biz.id, version]);
  return (
    <SectionCard flush icon="calendar" title="Service plans by model"
      description="A plan for a make's model or engine takes the place of the months and kilometres above for vehicles of it, whichever of its kilometres or days comes first."
      actions={canEdit && <button type="button" className="button button-secondary button-sm" onClick={() => setEditing({})}><Icon name="plus" size={14} /> Add a plan</button>}>
      <DataGrid variant="compact" id="garage-service-plans" caption="Service plans" rows={plans || []} loading={!plans} rowKey={(p) => p.id} rowNoun={["plan", "plans"]}
        empty="No plans: every vehicle takes the months and kilometres above" columns={[
          { key: "vehicle", header: "Make and model", value: (p) => [p.make, p.model].filter(Boolean).join(" "), mobile: "title" },
          { key: "engine_code", header: "Engine", value: (p) => p.engine_code || "Any", className: "mono" },
          { key: "interval_km", header: "Kilometres", type: "number", value: (p) => p.interval_km, render: (p) => km(p.interval_km) },
          { key: "interval_days", header: "Days", type: "number", value: (p) => p.interval_days },
          { key: "active", header: "In use", value: (p) => (p.active ? "Yes" : "No") },
          canEdit && { key: "edit", header: "", value: () => "", render: (p) => <button type="button" className="link-button" onClick={() => setEditing(p)}>Change</button> },
        ].filter(Boolean)} />
      {editing && <PlanDialog biz={biz} plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast.success("Plan saved."); setVersion((n) => n + 1); }} />}
    </SectionCard>
  );
}

function PlanDialog({ biz, plan, onClose, onSaved }) {
  const [form, setForm] = useState({ make: plan.make || "", model: plan.model || "", engineCode: plan.engine_code || "", intervalKm: plan.interval_km ? String(plan.interval_km) : "10000",
    intervalDays: plan.interval_days ? String(plan.interval_days) : "365", active: plan.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title={plan.id ? "Change the plan" : "A service plan"} icon="calendar" width={600} onClose={onClose} onSaved={onSaved}
      description="Name the model, the engine code, or both."
      onSubmit={() => (plan.id ? businessWrite(biz.id, `garage/plans/${plan.id}`, form, "patch") : businessWrite(biz.id, "garage/plans", form))}>
      <Field label="Make"><input required maxLength={60} value={form.make} onChange={set("make")} placeholder="e.g. Maruti Suzuki" /></Field>
      <Field label="Model"><input maxLength={60} value={form.model} onChange={set("model")} placeholder="e.g. Swift" /></Field>
      <Field label="Engine code"><input maxLength={30} className="mono" value={form.engineCode} onChange={set("engineCode")} placeholder="e.g. K12M" /></Field>
      <Field label="Kilometres to the next service"><input required inputMode="numeric" value={form.intervalKm} onChange={set("intervalKm")} /></Field>
      <Field label="Days to the next service"><input required inputMode="numeric" value={form.intervalDays} onChange={set("intervalDays")} /></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use</label>
    </FormDialog>
  );
}

// Mechanics' commission: a rate per labour item (it comes first) or per mechanic.
function CommissionRates({ biz, canEdit, services }) {
  const [rates, setRates] = useState(null);
  const [people, setPeople] = useState([]);
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "garage/commission/rates", undefined, controller.signal).then(setRates).catch(() => setRates([]));
    businessRead(biz.id, "garage/mechanics", undefined, controller.signal).then(setPeople).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  const remove = async (r) => {
    try {
      await businessWrite(biz.id, "garage/commission/rates", r.sku_id ? { skuId: r.sku_id, percent: "" } : { userId: r.user_id, percent: "" }, "put");
      toast.success("Rate taken off.");
      setVersion((n) => n + 1);
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  return (
    <SectionCard flush icon="percent" title="Mechanics' commission"
      description="A labour line earns its item's rate, or else its mechanic's own, on its value before GST when the job is billed (Reports › Mechanics' commission)."
      actions={canEdit && <button type="button" className="button button-secondary button-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add a rate</button>}>
      <DataGrid variant="compact" id="garage-commission-rates" caption="Commission rates" rows={rates || []} loading={!rates} rowKey={(r) => r.id} rowNoun={["rate", "rates"]}
        empty="No commission rates" columns={[
          { key: "for", header: "For", value: (r) => (r.sku_id ? `${r.label} (labour)` : `${r.user_name} (mechanic)`), mobile: "title" },
          { key: "percent", header: "Rate", value: (r) => `${Number(r.percent)}%`, mobile: "show" },
          canEdit && { key: "remove", header: "", value: () => "", render: (r) => <button type="button" className="link-button danger" onClick={() => remove(r)}>Take off</button> },
        ].filter(Boolean)} />
      {adding && <RateDialog biz={biz} services={services} people={people} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); toast.success("Rate saved."); setVersion((n) => n + 1); }} />}
    </SectionCard>
  );
}

function RateDialog({ biz, services, people, onClose, onSaved }) {
  const [kind, setKind] = useState("labour");
  const [item, setItem] = useState(null);
  const [userId, setUserId] = useState("");
  const [percent, setPercent] = useState("");
  return (
    <FormDialog title="A commission rate" icon="percent" width={560} onClose={onClose} onSaved={onSaved}
      onSubmit={() => {
        if (kind === "labour" && !item) throw new Error("Choose the labour item");
        if (kind === "mechanic" && !userId) throw new Error("Choose the mechanic");
        return businessWrite(biz.id, "garage/commission/rates", kind === "labour" ? { skuId: item.id, percent } : { userId, percent }, "put");
      }}>
      <Field label="For"><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="labour">A labour item</option><option value="mechanic">A mechanic</option></select></Field>
      {kind === "labour" ? (
        <div className="field-wide"><SearchPicker label="Labour item" placeholder="A service item" value={item} onChange={setItem} options={services} required
          getLabel={(s) => s.label} getDescription={(s) => s.code} /></div>
      ) : (
        <Field label="Mechanic"><select required value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Choose…</option>{people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      )}
      <Field label="Commission %"><input required inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="e.g. 10" /></Field>
    </FormDialog>
  );
}
