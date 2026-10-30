import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import FormField from "../../../components/FormField";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { toast } from "../../../services/toast";
import { formatLabel } from "../../../services/restaurantFormats";
import { GST_STATES } from "../../business/core/pages/invoice";
import { COMMON_CURRENCIES, codeFrom, timeZones } from "../../business/core/pages/newBusiness";
import { createPlatformBusiness } from "../services/platform.service";
import { consolePrices, consoleSettings } from "../services/console.service";
import { priceWords } from "../consoleWords";
import "../styles/console.css";

// A business the platform sets up for a customer (/platform/businesses/new):
// one form for every type. A restaurant (or a café, bakery or cloud kitchen)
// runs the restaurant's own set-up and always gets a new owner login, because
// a restaurant's people belong to that restaurant alone; any other type takes
// an existing login by its email, or a new one. Then its plan with add-ons,
// and how long it may be used: free until a date (the usual), with no end
// date, or the free trial every new business starts with.
const FORMATS = ["restaurant", "cafe", "bakery", "cloud_kitchen"];
const localZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata"; } catch { return "Asia/Kolkata"; }
};
const STATE_OPTIONS = Object.entries(GST_STATES).map(([code, name]) => [String(code).padStart(2, "0"), name]).sort((a, b) => a[1].localeCompare(b[1]));

const emptyForm = () => ({
  businessType: "", format: "restaurant", name: "", code: "", legalName: "", gstin: "", stateCode: "", addressLine1: "", addressLine2: "", city: "", postalCode: "",
  phone: "", email: "", currency: "INR", timezone: localZone(), locationName: "", locationCode: "",
  ownerEmail: "", ownerName: "", ownerMobile: "", ownerPassword: "",
  planCode: "", billingPeriod: "year", addons: [], access: "until", endsOn: "", reason: "", everything: false,
});

export default function PlatformNewBusinessPage() {
  const navigate = useNavigate();
  const [catalogue, setCatalogue] = useState(null);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [codeTouched, setCodeTouched] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => timeZones(), []);

  useEffect(() => {
    Promise.all([consolePrices(), consoleSettings()])
      .then(([prices, company]) => { setCatalogue(prices); setSettings(company); })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const set = (key, transform = (x) => x) => (event) => {
    const value = transform(event.target.value);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const restaurant = form.businessType === "restaurant";
  const plans = (catalogue?.plans || []).filter((p) => p.businessType === form.businessType && p.active);
  const plan = plans.find((p) => p.code === form.planCode);
  const addons = (catalogue?.prices || []).filter((m) => m.types.includes(form.businessType) && !(plan?.modules || []).includes(m.code));
  const trialDays = settings?.trialDays ?? 0;
  const gstRate = settings?.gstRate || 18;

  const chooseType = (event) => {
    const type = event.target.value;
    const first = (catalogue?.plans || []).find((p) => p.businessType === type && p.isDefault) || (catalogue?.plans || []).find((p) => p.businessType === type && p.active);
    setForm((f) => ({ ...f, businessType: type, planCode: first ? first.code : "", addons: [] }));
  };
  const toggleAddon = (code, on) => setForm((f) => ({ ...f, addons: on ? [...f.addons, code] : f.addons.filter((c) => c !== code) }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const trimmed = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]));
    const business = restaurant
      ? { format: trimmed.format, stateCode: trimmed.stateCode, timezone: trimmed.timezone }
      : { legalName: trimmed.legalName, gstin: trimmed.gstin, stateCode: trimmed.stateCode, currency: trimmed.currency, timezone: trimmed.timezone,
        locationName: trimmed.locationName, locationCode: trimmed.locationCode };
    try {
      const made = await createPlatformBusiness({
        businessType: trimmed.businessType, name: trimmed.name, code: trimmed.code, addressLine1: trimmed.addressLine1, addressLine2: trimmed.addressLine2,
        city: trimmed.city, postalCode: trimmed.postalCode, phone: trimmed.phone, email: trimmed.email, ...business,
        owner: { email: trimmed.ownerEmail, name: trimmed.ownerName, mobile: trimmed.ownerMobile, password: form.ownerPassword },
        selection: trimmed.planCode ? { planCode: trimmed.planCode, billingPeriod: trimmed.billingPeriod, addons: trimmed.addons } : undefined,
        access: trimmed.access === "trial" ? { kind: "trial" }
          : { kind: trimmed.access, reason: trimmed.reason, everything: trimmed.everything, ...(trimmed.access === "until" ? { endsOn: trimmed.endsOn } : {}) },
      });
      toast.success(made.owner.created
        ? `${made.business.name} is set up. ${made.owner.name} signs in with the email and password you gave, then chooses their own password.`
        : `${made.business.name} is set up. ${made.owner.name} finds it in their business switcher.`);
      const left = (made.restaurant?.skipped || []).filter((s) => s.enabled).map((s) => catalogue.prices.find((p) => p.code === s.feature)?.name || s.feature);
      if (left.length) toast.info(`Outside its plan, so not switched on: ${left.join(", ")}. Give it time that unlocks them, or add them to its plan.`);
      navigate(`/platform/businesses/${made.business.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      window.scrollTo?.({ top: 0, behavior: "smooth" });
    } finally {
      setBusy(false);
    }
  };

  if (!catalogue || !settings) {
    return (
      <div className="stack pc-page">
        <PageHeader icon="plus" eyebrow="Platform" title="New business" description="A business of any type set up for a customer, with its plan and how long it may be used." />
        {error ? <ErrorMessage message={error} /> : <Loading />}
      </div>
    );
  }

  return (
    <form className="stack pc-page" onSubmit={submit}>
      <PageHeader icon="plus" eyebrow="Platform" title="New business"
        description="A business of any type set up for a customer, with its plan and how long it may be used."
        secondary={<Link className="button button-secondary" to="/platform/businesses">Businesses</Link>} />
      <ErrorMessage message={error} />

      <SectionCard icon="store" title="The business">
        <div className="form-grid">
          <FormField label="Type of business" hint="Fixed once created: it decides the screens and rules.">
            <select required value={form.businessType} onChange={chooseType}>
              <option value="">Choose…</option>
              {catalogue.types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          </FormField>
          {restaurant && (
            <FormField label="Format" hint="How its POS opens and the features it starts with; the owner can change them later.">
              <select value={form.format} onChange={set("format")}>
                {FORMATS.map((code) => <option key={code} value={code}>{formatLabel(code)}</option>)}
              </select>
            </FormField>
          )}
          <FormField label="Business name">
            <input required maxLength={150} value={form.name}
              onChange={(e) => { const name = e.target.value; setForm((f) => ({ ...f, name, code: codeTouched ? f.code : codeFrom(name) })); }} />
          </FormField>
          <FormField label="Business code" hint={restaurant ? "Staff type it with their staff code at sign-in; letters and digits. Fixed once created." : "Short and unique. Fixed once created."}>
            <input required className="mono" maxLength={restaurant ? 30 : 40} value={form.code}
              onChange={(e) => { setCodeTouched(true); setForm((f) => ({ ...f, code: e.target.value.toUpperCase() })); }} />
          </FormField>
          {!restaurant && (
            <>
              <FormField label="Legal name" optional hint="As on the GST registration, if different."><input maxLength={200} value={form.legalName} onChange={set("legalName")} /></FormField>
              <FormField label="GSTIN" optional><input className="mono" maxLength={15} value={form.gstin} onChange={set("gstin", (x) => x.toUpperCase())} /></FormField>
            </>
          )}
          <FormField label="State" optional={!restaurant} hint="The place of supply on the platform's invoices to it.">
            <select required={restaurant} value={form.stateCode} onChange={set("stateCode")}>
              <option value="">{restaurant ? "Choose…" : "From the GSTIN"}</option>
              {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
            </select>
          </FormField>
          <FormField label="Address line 1" optional wide><input maxLength={200} value={form.addressLine1} onChange={set("addressLine1")} /></FormField>
          <FormField label="Address line 2" optional wide><input maxLength={200} value={form.addressLine2} onChange={set("addressLine2")} /></FormField>
          <FormField label="City" optional><input maxLength={100} value={form.city} onChange={set("city")} /></FormField>
          <FormField label="PIN code" optional><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={form.postalCode} onChange={set("postalCode")} /></FormField>
          <FormField label="Phone" optional><input maxLength={restaurant ? 20 : 30} inputMode="tel" value={form.phone} onChange={set("phone")} /></FormField>
          <FormField label="Business email" optional><input type="email" maxLength={150} value={form.email} onChange={set("email")} /></FormField>
          {!restaurant && (
            <FormField label="Currency" hint="Cannot change once bills are recorded.">
              <input required list="console-currencies" className="mono" maxLength={3} value={form.currency} onChange={set("currency", (x) => x.toUpperCase())} />
            </FormField>
          )}
          <FormField label="Time zone" hint="Decides what “today” is for its bills, its trial and its end date.">
            <input required list="console-zones" maxLength={60} value={form.timezone} onChange={set("timezone")} />
          </FormField>
          {!restaurant && (
            <>
              <FormField label="First location" optional hint="The shop, counter or godown; Main store when empty."><input maxLength={150} value={form.locationName} onChange={set("locationName")} /></FormField>
              <FormField label="Location code" optional hint="Used in bill numbers; MAIN when empty."><input className="mono" maxLength={30} value={form.locationCode} onChange={set("locationCode", (x) => x.toUpperCase())} /></FormField>
            </>
          )}
          <datalist id="console-currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
          <datalist id="console-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
        </div>
      </SectionCard>

      <SectionCard icon="user" title="The owner"
        description={restaurant
          ? "A restaurant's owner is always a new login: a restaurant's people belong to that restaurant alone. Use an email and a mobile number that have no login yet."
          : "Someone who already has a login (the same email) becomes the owner of this business too; otherwise give a name and a first password for a new login."}>
        <div className="form-grid">
          <FormField label="Owner's email"><input type="email" required maxLength={150} value={form.ownerEmail} onChange={set("ownerEmail")} /></FormField>
          <FormField label="Owner's name" optional={!restaurant}><input required={restaurant} maxLength={150} value={form.ownerName} onChange={set("ownerName")} /></FormField>
          <FormField label="Owner's mobile" optional><input maxLength={20} inputMode="tel" value={form.ownerMobile} onChange={set("ownerMobile")} /></FormField>
          <FormField label="Owner's first password" optional={!restaurant} hint="8 to 72 characters; they choose their own at the first sign-in.">
            <input type="password" autoComplete="new-password" required={restaurant} minLength={8} maxLength={72} value={form.ownerPassword} onChange={set("ownerPassword")} />
          </FormField>
        </div>
      </SectionCard>

      <SectionCard icon="layers" title="Plan" description={`What its next order holds. Prices are before GST (${Number(gstRate)}% is added on the invoice).`}>
        {!form.businessType ? <p className="muted">Choose the type of business first.</p> : (
          <div className="form-grid">
            <FormField label="Plan">
              <select required value={form.planCode} onChange={(e) => setForm((f) => ({ ...f, planCode: e.target.value, addons: [] }))}>
                {plans.length === 0 && <option value="">No plan offered for this type</option>}
                {plans.map((p) => <option key={p.code} value={p.code}>{p.name}{p.isDefault ? " (default)" : ""}</option>)}
              </select>
            </FormField>
            <FormField label="Billing">
              <select value={form.billingPeriod} onChange={set("billingPeriod")}>
                <option value="year">Yearly{plan ? `: ${priceWords(plan.yearly, "year", gstRate)}` : ""}</option>
                <option value="month">Monthly{plan ? `: ${priceWords(plan.monthly, "month", gstRate)}` : ""}</option>
              </select>
            </FormField>
            {addons.length > 0 && (
              <div className="field field-wide">
                <span>Add-ons on top of the plan</span>
                <div className="pc-modules">
                  {addons.map((m) => (
                    <label key={m.code} className="checkbox">
                      <input type="checkbox" checked={form.addons.includes(m.code)} onChange={(e) => toggleAddon(m.code, e.target.checked)} />
                      <span>{m.name}{m.soldAs === "application" ? " (application)" : ""} · {priceWords(form.billingPeriod === "month" ? m.monthly : m.yearly, form.billingPeriod, gstRate)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard icon="calendar" title="How long it may be used"
        description="Time you give is free, with a reason, and replaces the free trial; afterwards the owner pays for the plan above, or it turns read-only.">
        <div className="stack">
          <div className="pc-choices" role="radiogroup" aria-label="How long it may be used">
            <label className="pc-choice">
              <input type="radio" name="access" value="until" checked={form.access === "until"} onChange={set("access")} />
              <span><strong>Free until a date</strong><small className="muted">It works until the end of that day, then the grace days.</small></span>
            </label>
            <label className="pc-choice">
              <input type="radio" name="access" value="no_end" checked={form.access === "no_end"} onChange={set("access")} />
              <span><strong>Free with no end date</strong><small className="muted">Until you give it an end date.</small></span>
            </label>
            <label className="pc-choice">
              <input type="radio" name="access" value="trial" disabled={!trialDays} checked={form.access === "trial"} onChange={set("access")} />
              <span><strong>Free trial ({trialDays} days)</strong>
                <small className="muted">{trialDays ? "From today, with everything its type offers; then the owner pays." : "The free trial is set to 0 days in Platform › Settings."}</small></span>
            </label>
          </div>
          {form.access !== "trial" && (
            <div className="form-grid">
              {form.access === "until" && (
                <FormField label="Free until"><input type="date" required value={form.endsOn} onChange={set("endsOn")} /></FormField>
              )}
              <FormField label="Reason" hint="Kept with the time given, such as “Pilot customer”." wide>
                <input required maxLength={300} value={form.reason} onChange={set("reason")} />
              </FormField>
              <label className="checkbox field-wide">
                <input type="checkbox" checked={form.everything} onChange={(e) => setForm((f) => ({ ...f, everything: e.target.checked }))} />
                Unlock everything its type offers, not only the plan and add-ons above
              </label>
            </div>
          )}
        </div>
      </SectionCard>

      <div className="form-actions">
        <Link className="button button-secondary" to="/platform/businesses">Cancel</Link>
        <button type="submit" className="button" disabled={busy}>{busy ? "Setting it up…" : "Create business"}</button>
      </div>
    </form>
  );
}
