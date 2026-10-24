import { useEffect, useMemo, useState } from "react";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { km } from "./garage";
import "../styles/garage.css";

// A garage's settings: when the next service falls after a job (6 months and
// 5,000 km until changed; editable on each bill), and the service item that
// bills the owner's share of a cashless claim (one line on the owner's bill:
// the deductible, the depreciation and what the insurer did not allow). GST on
// parts and labour is each item's own slab (Settings › Tax rates).

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
      .then((s) => { setSettings(s); setForm({ serviceMonths: String(s.service_months), serviceKm: String(s.service_km), share: s.claim_share }); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await businessWrite(biz.id, "garage/settings", { serviceMonths: form.serviceMonths, serviceKm: form.serviceKm, claimShareSkuId: form.share?.id || null }, "put");
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
        description="When the next service falls after a job, and how the owner's share of an insurance claim is billed." />
      <form className="stack" onSubmit={save}>
        <SectionCard icon="calendar" title="The next service" description="Set on the vehicle when a job is billed; it can be changed on each bill.">
          <div className="gar-setting">
            <Field label="Months after a job"><input type="number" min="1" max="36" step="1" required disabled={!canEdit} value={form.serviceMonths} onChange={(e) => setForm((f) => ({ ...f, serviceMonths: e.target.value }))} /></Field>
            <Field label="Kilometres after a job"><input inputMode="numeric" required disabled={!canEdit} value={form.serviceKm} onChange={(e) => setForm((f) => ({ ...f, serviceKm: e.target.value }))} /></Field>
            <small className="muted">Now {settings.service_months} months or {km(settings.service_km)}, whichever comes first.</small>
          </div>
        </SectionCard>
        <SectionCard icon="shield" title="The owner's share of a claim"
          description="On a cashless claim the insurer is billed for the amount it approved; the owner's bill carries their share of the insurer's lines as one line of this service item (repair service, SAC 998714, 18%).">
          <div className="gar-setting">
            <div className="field">
              <SearchPicker label="Claim-share item" placeholder="A service item" value={form.share} disabled={!canEdit} onChange={(s) => setForm((f) => ({ ...f, share: s }))}
                options={services} getLabel={(s) => s.label} getDescription={(s) => `${s.code} · GST ${Number(s.tax_rate)}%${s.hsn_code ? ` · ${s.hsn_code}` : ""}`} />
            </div>
            {canEdit && biz.can("catalog.create") && !form.share && <button type="button" className="button button-secondary" onClick={make}>Make the item</button>}
          </div>
        </SectionCard>
        {canEdit && (
          <div className="form-actions bz-start">
            <button type="submit" className="button" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            {settings.updated_by_name && <small className="muted">Last saved by {settings.updated_by_name} on {dateShort(settings.updated_at, { year: true })}</small>}
          </div>
        )}
      </form>
    </div>
  );
}
