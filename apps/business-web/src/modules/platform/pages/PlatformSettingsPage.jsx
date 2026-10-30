import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import ContentTabs from "../../../components/ContentTabs";
import FormField from "../../../components/FormField";
import DataGrid from "../../../components/DataGrid/DataGrid";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { toast } from "../../../services/toast";
import { dateTime } from "@bmp/shared/format";
import { consolePrices, consoleSettings, saveConsolePrices, saveConsoleSettings } from "../services/console.service";
import { priceWords } from "../consoleWords";
import "../styles/console.css";

// Platform › Settings (/platform/settings): the company's details printed on
// every invoice, the free trial and the grace days, the price list, and where
// owners pay. ?tab=company, trial, prices or payment opens that tab, so a
// screen that finds something missing can link straight to where it is fixed.
const TABS = [
  { value: "company", label: "Company" },
  { value: "trial", label: "Trial & renewal" },
  { value: "prices", label: "Prices" },
  { value: "payment", label: "Payment details" },
];
const ALIASES = { "trial-renewal": "trial", renewal: "trial", "price-list": "prices", payments: "payment", "payment-details": "payment" };

const COMPANY = [
  { key: "brandName", label: "Brand name", hint: "The name owners know the platform by.", max: 80, required: true },
  { key: "legalName", label: "Legal name", hint: "As registered for GST; it is the supplier on every invoice.", max: 200 },
  { key: "addressLine1", label: "Address line 1", max: 200, wide: true },
  { key: "addressLine2", label: "Address line 2", max: 200, wide: true, optional: true },
  { key: "city", label: "City", max: 100 },
  { key: "postalCode", label: "PIN code", max: 6, inputMode: "numeric" },
  { key: "gstin", label: "GSTIN", hint: "15 characters; its first two digits are the company's state.", max: 15, mono: true, upper: true, required: true },
  { key: "pan", label: "PAN", hint: "The PAN inside the GSTIN.", max: 10, mono: true, upper: true, optional: true },
  { key: "phone", label: "Phone", max: 30, optional: true },
  { key: "email", label: "Email", type: "email", max: 150, optional: true },
  { key: "website", label: "Website", max: 200, optional: true },
  { key: "sacCode", label: "SAC code", hint: "Printed on each invoice line; 998315 unless your accountant says otherwise.", max: 6, mono: true, required: true },
  { key: "gstRate", label: "GST rate (%)", type: "number", step: "0.01", min: 0, max: 40, required: true },
  { key: "invoicePrefix", label: "Invoice prefix", hint: "2 to 5 letters, digits or dashes, not ending in a digit: BMP/2627/00001.", max: 5, mono: true, upper: true, required: true },
  { key: "supportPhone", label: "Support phone", max: 30, optional: true },
  { key: "supportEmail", label: "Support email", type: "email", max: 150, optional: true },
  { key: "grievanceOfficerName", label: "Grievance officer", hint: "Named on the privacy policy, as the DPDP Act asks.", max: 150, optional: true },
  { key: "grievanceOfficerEmail", label: "Grievance officer's email", type: "email", max: 150, optional: true },
];
const TRIAL = [
  { key: "trialDays", label: "Free trial (days)", type: "number", min: 0, max: 30, required: true,
    hint: "0 to 30. A new business uses everything its type offers for this many days; a change applies to trials that start afterwards. 0: it pays first." },
  { key: "graceDays", label: "Grace (days)", type: "number", min: 0, max: 30, required: true,
    hint: "0 to 30. After paid or given time ends, the business keeps working this long, with a warning. Never after a trial." },
];
const PAYMENT = [
  { key: "upiId", label: "UPI ID", hint: "Owners pay to it; their screen shows it with a QR code.", max: 100, mono: true, optional: true },
  { key: "upiPayeeName", label: "UPI payee name", max: 100, optional: true },
  { key: "bankName", label: "Bank name", max: 100, optional: true },
  { key: "bankAccountName", label: "Account name", max: 150, optional: true },
  { key: "bankAccountNumber", label: "Account number", max: 30, mono: true, inputMode: "numeric", optional: true },
  { key: "bankIfsc", label: "IFSC", max: 11, mono: true, upper: true, optional: true },
  { key: "paymentNote", label: "Note for owners", hint: "Shown beside the payment details, such as what to write in the payment's remarks.", max: 500, wide: true, optional: true },
];

export default function PlatformSettingsPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab");
  const tab = TABS.some((t) => t.value === asked) ? asked : ALIASES[asked] || "company";
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    consoleSettings().then(setSettings).catch((err) => setError(getErrorMessage(err)));
  }, []);

  const showTab = (value) => {
    const next = new URLSearchParams(params);
    if (value === "company") next.delete("tab");
    else next.set("tab", value);
    setParams(next, { replace: true });
  };

  return (
    <div className="stack pc-page">
      <PageHeader icon="settings" eyebrow="Platform" title="Platform settings"
        description="The company's details printed on every invoice, the free trial and the grace days, the prices owners pay, and where they pay." />
      <ErrorMessage message={error} />
      <ContentTabs label="Platform settings" value={tab} options={TABS} onChange={showTab}>
        {!settings && !error && <Loading />}
        {settings && tab === "company" && <CompanyTab settings={settings} onSaved={setSettings} />}
        {settings && tab === "trial" && (
          <SettingsForm key={settings.updatedAt} icon="clock" title="Trial & renewal" fields={TRIAL} values={settings} onSaved={setSettings} submitLabel="Save trial and grace"
            description="How long a new business is free, and how long one keeps working after its time ends." />
        )}
        {tab === "prices" && <PriceList gstRate={settings?.gstRate} />}
        {settings && tab === "payment" && (
          <SettingsForm key={settings.updatedAt} icon="wallet" title="Payment details" fields={PAYMENT} values={settings} onSaved={setSettings} submitLabel="Save payment details"
            description="Until online payment arrives, owners pay to these and enter the payment's reference for you to confirm." />
        )}
      </ContentTabs>
    </div>
  );
}

function CompanyTab({ settings, onSaved }) {
  return (
    <div className="stack">
      {settings.sampleGstin && (
        <div className="alert alert-notice" role="status">
          <strong>The GSTIN is the sample one ({settings.gstin}).</strong> Every invoice issued now is a SAMPLE, not a tax invoice, and is kept out of the
          GST register. Enter the company's real GSTIN before taking real payments.
        </div>
      )}
      {settings.companyProblems.length > 0 && (
        <div className="alert alert-info" role="status">
          Payments cannot be confirmed until the company's details are complete. Still to fill in: {settings.companyProblems.join(", ")}.
        </div>
      )}
      <SettingsForm key={settings.updatedAt} icon="store" title="Company" fields={COMPANY} values={settings} onSaved={onSaved} submitLabel="Save company details"
        description={`The supplier on every invoice: state ${settings.stateName ? `${settings.stateName} (${settings.stateCode})` : settings.stateCode}, from the GSTIN.`} />
    </div>
  );
}

const valuesOf = (values, fields) => Object.fromEntries(fields.map((f) => [f.key, values[f.key] === null || values[f.key] === undefined ? "" : String(values[f.key])]));

// One card of settings: its fields, saved together. A field left empty is
// cleared; the server says which value it cannot take. Its parent keys it by
// the settings' last change, so after a save it starts from what was saved.
function SettingsForm({ icon, title, description, fields, values, onSaved, submitLabel }) {
  const [form, setForm] = useState(() => valuesOf(values, fields));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const saved = await saveConsoleSettings(Object.fromEntries(fields.map((f) => [f.key, form[f.key].trim() === "" && !f.required ? null : form[f.key].trim()])));
      toast.success(`${title} saved.`);
      onSaved(saved);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard as="form" icon={icon} title={title} description={description} onSubmit={submit}>
      <div className="form-grid">
        <ErrorMessage message={error} />
        {fields.map((f) => (
          <FormField key={f.key} label={f.label} hint={f.hint} optional={f.optional} wide={f.wide}>
            <input type={f.type || "text"} className={f.mono ? "mono" : undefined} maxLength={f.type === "number" ? undefined : f.max} min={f.min} max={f.type === "number" ? f.max : undefined}
              step={f.step} inputMode={f.inputMode} required={f.required} value={form[f.key]}
              onChange={(e) => setForm((old) => ({ ...old, [f.key]: f.upper ? e.target.value.toUpperCase() : e.target.value }))} />
          </FormField>
        ))}
        <div className="form-actions">
          <button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
        </div>
      </div>
    </SectionCard>
  );
}

// --- The price list --------------------------------------------------------------------------

const planCode = (type, name) => `${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`.slice(0, 40);
const blank = (value) => (value === null || value === undefined ? "" : String(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const planBody = (p) => ({ code: p.code, businessType: p.businessType, name: p.name.trim(), description: p.description || null, monthly: blank(p.monthly).trim() || null,
  yearly: blank(p.yearly).trim() || null, isDefault: p.isDefault, active: p.active, sortOrder: p.sortOrder, modules: [...p.modules].sort() });
const priceBody = (p) => ({ code: p.code, soldAs: p.soldAs, monthly: blank(p.monthly).trim() || null, yearly: blank(p.yearly).trim() || null, available: p.available });

// Each business type's plans (price, the modules each includes, the default,
// whether it is offered) and every module's and application's price, saved
// together with one button, which also marks the price list reviewed. Prices
// are before GST. A change reaches a business at its next order.
function PriceList({ gstRate }) {
  const [data, setData] = useState(null);
  const [plans, setPlans] = useState([]);
  const [prices, setPrices] = useState([]);
  const [type, setType] = useState("");
  const [allModules, setAllModules] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const take = useCallback((result) => {
    setData(result);
    setPlans(result.plans.map((p) => ({ ...p, monthly: blank(p.monthly), yearly: blank(p.yearly) })));
    setPrices(result.prices.map((p) => ({ ...p, monthly: blank(p.monthly), yearly: blank(p.yearly) })));
    setType((current) => current || (result.types.find((t) => t.code === "grocery") || result.types[0])?.code || "");
  }, []);

  useEffect(() => {
    consolePrices().then(take).catch((err) => setError(getErrorMessage(err)));
  }, [take]);

  const typePlans = plans.filter((p) => p.businessType === type);
  const typeModules = useMemo(() => prices.filter((p) => p.types.includes(type)), [prices, type]);
  const shownPrices = allModules ? prices : typeModules;
  const setPlan = (index, change) => setPlans((all) => all.map((p, i) => (i === index ? { ...p, ...change } : p)));
  const indexOf = (plan) => plans.indexOf(plan);
  const setPrice = (code, change) => setPrices((all) => all.map((p) => (p.code === code ? { ...p, ...change } : p)));

  const makeDefault = (plan) => setPlans((all) => all.map((p) => (p.businessType !== plan.businessType ? p : { ...p, isDefault: p === plan, active: p === plan ? true : p.active })));
  const addPlan = () => setPlans((all) => [...all, { code: "", businessType: type, name: "", description: null, monthly: "", yearly: "", isDefault: false, active: true,
    sortOrder: 10 + 10 * typePlans.length, modules: [], isNew: true }]);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      // A new plan's code comes from its name; one that would be another plan's is refused, never saved over it.
      const codes = new Set(data.plans.map((p) => p.code));
      for (const plan of plans.filter((p) => p.isNew)) {
        const code = planCode(plan.businessType, plan.name);
        if (codes.has(code)) {
          const typeName = data.types.find((t) => t.code === plan.businessType)?.name || plan.businessType;
          throw new Error(`${typeName} already has a plan called ${plan.name.trim()}. Give the new plan another name.`);
        }
        codes.add(code);
      }
      const originals = new Map(data.plans.map((p) => [p.code, planBody({ ...p, name: p.name })]));
      const changedPlans = plans.map((p) => (p.isNew ? { ...p, code: planCode(p.businessType, p.name) } : p)).map(planBody)
        .filter((p) => !originals.has(p.code) || !same(originals.get(p.code), p));
      const originalPrices = new Map(data.prices.map((p) => [p.code, priceBody(p)]));
      const changedPrices = prices.map(priceBody).filter((p) => !same(originalPrices.get(p.code), p));
      const saved = await saveConsolePrices({ plans: changedPlans, prices: changedPrices });
      take(saved);
      toast.success(changedPlans.length || changedPrices.length ? "Prices saved, and the price list marked reviewed." : "The price list is marked reviewed.");
    } catch (err) {
      setError(err.response ? getErrorMessage(err) : err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <ErrorMessage message={error} /> : <Loading />;
  const typeName = data.types.find((t) => t.code === type)?.name || type;

  return (
    <form className="stack" onSubmit={save} aria-label="Price list">
      <div className={`alert ${data.pricesReviewedAt ? "alert-info" : "alert-notice"}`} role="status">
        {data.pricesReviewedAt ? `Prices last reviewed ${dateTime(data.pricesReviewedAt, { year: true })}.` : "The prices have not been reviewed yet: check them, then save to mark them reviewed."}
        {" "}Prices are before GST{gstRate ? ` (${Number(gstRate)}% is added on each invoice)` : ""}. A change reaches a business at its next order; open orders keep their prices.
      </div>
      <ErrorMessage message={error} />
      <SectionCard icon="layers" title="Plans" description="Each type of business has its plans; the default one is what a new business starts with."
        actions={(
          <label className="field">
            <span>Type of business</span>
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type of business">
              {data.types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          </label>
        )}>
        <div className="stack">
          {typePlans.map((plan) => (
            <fieldset key={plan.code || `new-${indexOf(plan)}`} className="pc-plan" aria-label={`Plan ${plan.name || "(new)"}`}>
              <div className="pc-plan-head">
                <FormField label="Plan name">
                  <input required maxLength={80} value={plan.name} onChange={(e) => setPlan(indexOf(plan), { name: e.target.value })} />
                </FormField>
                <FormField label="Monthly price (₹)" hint={priceWords(plan.monthly, "month", gstRate || 18)}>
                  <input className="pc-price-input" inputMode="decimal" value={plan.monthly} onChange={(e) => setPlan(indexOf(plan), { monthly: e.target.value })} />
                </FormField>
                <FormField label="Yearly price (₹)" hint={priceWords(plan.yearly, "year", gstRate || 18)}>
                  <input className="pc-price-input" inputMode="decimal" value={plan.yearly} onChange={(e) => setPlan(indexOf(plan), { yearly: e.target.value })} />
                </FormField>
                <label className="checkbox">
                  <input type="radio" name={`default-${type}`} checked={plan.isDefault} onChange={() => makeDefault(plan)} /> Default for a new {typeName} business
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={plan.active} disabled={plan.isDefault} onChange={(e) => setPlan(indexOf(plan), { active: e.target.checked })} /> Offered to owners
                </label>
              </div>
              <div className="field">
                <span>Modules it includes</span>
                <div className="pc-modules">
                  {typeModules.map((m) => (
                    <label key={m.code} className="checkbox">
                      <input type="checkbox" checked={plan.modules.includes(m.code)}
                        onChange={(e) => setPlan(indexOf(plan), { modules: e.target.checked ? [...plan.modules, m.code] : plan.modules.filter((c) => c !== m.code) })} />
                      {m.name}{m.soldAs === "application" ? " (application)" : ""}
                    </label>
                  ))}
                </div>
              </div>
            </fieldset>
          ))}
          <div>
            <button type="button" className="button button-secondary" onClick={addPlan}><Icon name="plus" size={15} /> Add a plan for {typeName}</button>
          </div>
        </div>
      </SectionCard>
      <SectionCard icon="tag" title="Modules and applications" flush
        description="Add-ons on top of a plan. A module's price is the same for every type of business that can use it; a price of 0 is free, an empty one not for sale yet."
        actions={(
          <label className="checkbox">
            <input type="checkbox" checked={allModules} onChange={(e) => setAllModules(e.target.checked)} /> Every module, not only {typeName}'s
          </label>
        )}>
        <DataGrid variant="editor" caption="Module and application prices" rows={shownPrices} rowKey={(p) => p.code} columns={[
          { key: "name", header: "Module", value: (p) => p.name },
          { key: "soldAs", header: "Sold as", render: (p, ctx) => (
            <select aria-label={`${ctx.label}: ${p.name}`} value={p.soldAs} onChange={(e) => setPrice(p.code, { soldAs: e.target.value })}>
              <option value="module">Module</option><option value="application">Application</option>
            </select>
          ) },
          { key: "monthly", header: "Monthly (₹)", render: (p, ctx) => (
            <input aria-label={`${ctx.label}: ${p.name}`} className="pc-price-input" inputMode="decimal" value={p.monthly} onChange={(e) => setPrice(p.code, { monthly: e.target.value })} />
          ) },
          { key: "yearly", header: "Yearly (₹)", render: (p, ctx) => (
            <input aria-label={`${ctx.label}: ${p.name}`} className="pc-price-input" inputMode="decimal" value={p.yearly} onChange={(e) => setPrice(p.code, { yearly: e.target.value })} />
          ) },
          { key: "available", header: "Owners may add it", render: (p, ctx) => (
            <input type="checkbox" aria-label={`${ctx.label}: ${p.name}`} checked={p.available} onChange={(e) => setPrice(p.code, { available: e.target.checked })} />
          ) },
        ]} />
      </SectionCard>
      <div className="form-actions">
        <button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save prices"}</button>
      </div>
    </form>
  );
}
