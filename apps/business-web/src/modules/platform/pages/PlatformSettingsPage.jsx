import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
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
import { SAMPLE_GSTIN, firstInvoiceNumber, priceWords, yearSavingWords } from "../consoleWords";
import "../styles/console.css";

// Platform › Settings (/platform/settings): the company's details printed on
// every invoice, the free trial and the grace days, the price list, and where
// owners pay. ?tab=company, trial, prices or payment opens that tab, so a
// screen that finds something missing can link straight to where it is fixed.
// Beside each form, what it changes as it is typed: the invoice's top, a new
// business's time, the payment card owners see.
const TABS = [
  { value: "company", label: "Company" },
  { value: "trial", label: "Trial & renewal" },
  { value: "prices", label: "Prices" },
  { value: "payment", label: "Payment details" },
];
const ALIASES = { "trial-renewal": "trial", renewal: "trial", "price-list": "prices", payments: "payment", "payment-details": "payment" };

const COMPANY = [
  { key: "brandName", group: "The brand", label: "Brand name", hint: "The name owners know the platform by.", max: 80, required: true },
  { key: "legalName", group: "The supplier on every invoice", label: "Legal name", hint: "As registered for GST; it is the supplier on every invoice.", max: 200 },
  { key: "addressLine1", group: "The supplier on every invoice", label: "Address line 1", max: 200, wide: true },
  { key: "addressLine2", group: "The supplier on every invoice", label: "Address line 2", max: 200, wide: true, optional: true },
  { key: "city", group: "The supplier on every invoice", label: "City", max: 100 },
  { key: "postalCode", group: "The supplier on every invoice", label: "PIN code", max: 6, inputMode: "numeric" },
  { key: "gstin", group: "The supplier on every invoice", label: "GSTIN", hint: "15 characters; its first two digits are the company's state.", max: 15, mono: true, upper: true, required: true },
  { key: "pan", group: "The supplier on every invoice", label: "PAN", hint: "The PAN inside the GSTIN.", max: 10, mono: true, upper: true, optional: true },
  { key: "sacCode", group: "Invoices", label: "SAC code", hint: "Printed on each invoice line; 998315 unless your accountant says otherwise.", max: 6, mono: true, required: true },
  { key: "gstRate", group: "Invoices", label: "GST rate (%)", type: "number", step: "0.01", min: 0, max: 40, required: true },
  { key: "invoicePrefix", group: "Invoices", label: "Invoice prefix", hint: "2 to 5 letters, digits or dashes, not ending in a digit: BMP/2627/00001.", max: 5, mono: true, upper: true, required: true },
  { key: "phone", group: "Contact", label: "Phone", max: 30, optional: true },
  { key: "email", group: "Contact", label: "Email", type: "email", max: 150, optional: true },
  { key: "website", group: "Contact", label: "Website", max: 200, optional: true },
  { key: "supportPhone", group: "Contact", label: "Support phone", max: 30, optional: true },
  { key: "supportEmail", group: "Contact", label: "Support email", type: "email", max: 150, optional: true },
  { key: "grievanceOfficerName", group: "Grievance officer", label: "Grievance officer", hint: "Named on the privacy policy, as the DPDP Act asks.", max: 150, optional: true },
  { key: "grievanceOfficerEmail", group: "Grievance officer", label: "Grievance officer's email", type: "email", max: 150, optional: true },
];
const TRIAL = [
  { key: "trialDays", label: "Free trial (days)", type: "number", min: 0, max: 30, required: true,
    hint: "0 to 30. A new business uses everything its type offers for this many days; a change applies to trials that start afterwards. 0: it pays first." },
  { key: "graceDays", label: "Grace (days)", type: "number", min: 0, max: 30, required: true,
    hint: "0 to 30. After paid or given time ends, the business keeps working this long, with a warning. Never after a trial." },
];
const PAYMENT = [
  { key: "upiId", group: "UPI", label: "UPI ID", hint: "Owners pay to it; their screen shows it with a QR code.", max: 100, mono: true, optional: true },
  { key: "upiPayeeName", group: "UPI", label: "UPI payee name", max: 100, optional: true },
  { key: "bankName", group: "Bank transfer", label: "Bank name", max: 100, optional: true },
  { key: "bankAccountName", group: "Bank transfer", label: "Account name", max: 150, optional: true },
  { key: "bankAccountNumber", group: "Bank transfer", label: "Account number", max: 30, mono: true, inputMode: "numeric", optional: true },
  { key: "bankIfsc", group: "Bank transfer", label: "IFSC", max: 11, mono: true, upper: true, optional: true },
  { key: "paymentNote", group: "Bank transfer", label: "Note for owners", hint: "Shown beside the payment details, such as what to write in the payment's remarks.", max: 500, wide: true, optional: true },
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
            description="How long a new business is free, and how long one keeps working after its time ends."
            preview={(form) => <TimelinePreview form={form} />} />
        )}
        {tab === "prices" && <PriceList gstRate={settings?.gstRate} />}
        {settings && tab === "payment" && (
          <SettingsForm key={settings.updatedAt} icon="wallet" title="Payment details" fields={PAYMENT} values={settings} onSaved={setSettings} submitLabel="Save payment details"
            description="Until online payment arrives, owners pay to these and enter the payment's reference for you to confirm."
            preview={(form) => <PaymentPreview form={form} />} />
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
        description={`The supplier on every invoice: state ${settings.stateName ? `${settings.stateName} (${settings.stateCode})` : settings.stateCode}, from the GSTIN.`}
        preview={(form) => <InvoicePreview form={form} />} />
    </div>
  );
}

const valuesOf = (values, fields) => Object.fromEntries(fields.map((f) => [f.key, values[f.key] === null || values[f.key] === undefined ? "" : String(values[f.key])]));

// One card of settings: its fields, saved together, in their groups, and
// beside them what they change as they are typed (preview, given the form).
// A field left empty is cleared; the server says which value it cannot take.
// Its parent keys it by the settings' last change, so after a save it starts
// from what was saved.
function SettingsForm({ icon, title, description, fields, values, onSaved, submitLabel, preview }) {
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
      <div className={preview ? "pc-settings-split" : undefined}>
        <div className="form-grid pc-settings-fields">
          <ErrorMessage message={error} />
          {fields.map((f, index) => (
            <Fragment key={f.key}>
              {f.group && f.group !== fields[index - 1]?.group && <h3 className="section-heading field-wide">{f.group}</h3>}
              <FormField label={f.label} hint={f.hint} optional={f.optional} wide={f.wide}>
                <input type={f.type || "text"} className={f.mono ? "mono" : undefined} maxLength={f.type === "number" ? undefined : f.max} min={f.min} max={f.type === "number" ? f.max : undefined}
                  step={f.step} inputMode={f.inputMode} required={f.required} value={form[f.key]}
                  onChange={(e) => setForm((old) => ({ ...old, [f.key]: f.upper ? e.target.value.toUpperCase() : e.target.value }))} />
              </FormField>
            </Fragment>
          ))}
          <div className="form-actions">
            <button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
          </div>
        </div>
        {preview && <aside className="pc-preview" aria-label={`${title}: how it shows`}>{preview(form)}</aside>}
      </div>
    </SectionCard>
  );
}

const PreviewLabel = ({ children }) => <p className="pc-preview-label"><Icon name="eye" size={14} /> {children}</p>;

// The top of the company's invoice as the details stand in the form: the
// supplier, its GSTIN, and the number the year's first invoice takes.
function InvoicePreview({ form }) {
  const sample = form.gstin.trim().toUpperCase() === SAMPLE_GSTIN;
  const address = [form.addressLine1, form.addressLine2, [form.city, form.postalCode].map((part) => part.trim()).filter(Boolean).join(" ")]
    .map((line) => line.trim()).filter(Boolean);
  const rate = Number(form.gstRate);
  return (
    <>
      <PreviewLabel>On every invoice</PreviewLabel>
      <div className={`pc-paper${sample ? " is-sample" : ""}`}>
        {sample && <span className="pc-paper-band">Sample — not a tax invoice</span>}
        <div className="pc-paper-top">
          <div className="pc-paper-supplier">
            <strong className={form.legalName.trim() ? undefined : "is-missing"}>{form.legalName.trim() || "Legal name"}</strong>
            {address.length ? address.map((line) => <span key={line}>{line}</span>) : <span className="is-missing">Address</span>}
            <span className="mono">GSTIN {form.gstin.trim() || "—"}</span>
          </div>
          <div className="pc-paper-number">
            <span>{sample ? "Sample invoice" : "Tax invoice"}</span>
            <strong className="mono">{firstInvoiceNumber(form.invoicePrefix, form.gstin)}</strong>
          </div>
        </div>
        <div className="pc-paper-line">
          <span>Plan and add-ons · SAC <span className="mono">{form.sacCode.trim() || "—"}</span></span>
          <span className="pc-paper-bars" aria-hidden="true"><i /><i /></span>
        </div>
        <div className="pc-paper-tax">
          <span>GST {Number.isFinite(rate) ? `${rate}%` : "—"}</span>
          <span>CGST + SGST, or IGST</span>
        </div>
      </div>
      <p className="pc-preview-note">
        {form.brandName.trim() || "The brand"} is the name owners see; the legal name is the supplier the invoice is from.
        {sample ? " Until the real GSTIN is in, invoices are samples, numbered in their own series." : ""}
      </p>
    </>
  );
}

const dayCount = (days) => `${days} ${days === 1 ? "day" : "days"}`;

// A new business's time as the trial and grace stand in the form.
function TimelinePreview({ form }) {
  const trial = Number(form.trialDays) || 0;
  const grace = Number(form.graceDays) || 0;
  return (
    <>
      <PreviewLabel>A new business, as these stand</PreviewLabel>
      <ol className="pc-timeline">
        <li className="tone-info">
          <strong>{trial > 0 ? `Free trial · ${dayCount(trial)}` : "No free trial"}</strong>
          <span>{trial > 0 ? "Everything its type offers, unlocked." : "It pays for its plan before it opens."}</span>
        </li>
        <li className="tone-success">
          <strong>Paid time</strong>
          <span>The plan and add-ons the owner paid for, by the month or the year.</span>
        </li>
        <li className="tone-warning">
          <strong>{grace > 0 ? `Grace · ${dayCount(grace)}` : "No grace"}</strong>
          <span>{grace > 0 ? "It keeps working, with a warning, while the owner renews." : "It stops working the day paid time ends."}</span>
        </li>
        <li className="tone-danger">
          <strong>Read-only</strong>
          <span>Everything can still be seen, printed and exported; nothing is deleted.</span>
        </li>
      </ol>
      {trial > 0 && <p className="pc-preview-note">A trial that ends unpaid goes straight to read-only: grace follows only paid or given time.</p>}
    </>
  );
}

// What owners see where they pay, as the details stand in the form. The QR
// code is a real one for the UPI ID, with no amount: scanned with a phone, it
// shows whether the ID opens the right account.
function PaymentPreview({ form }) {
  const upi = form.upiId.trim();
  const payee = form.upiPayeeName.trim();
  const [qr, setQr] = useState({ upi: "", image: "" });

  useEffect(() => {
    let alive = true;
    if (!upi) return undefined;
    const link = `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(payee || upi)}&cu=INR`;
    const timer = window.setTimeout(() => {
      QRCode.toDataURL(link, { width: 200, margin: 1, errorCorrectionLevel: "M" })
        .then((image) => alive && setQr({ upi, image }))
        .catch(() => alive && setQr({ upi, image: "" }));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [upi, payee]);

  const bank = [["Bank", form.bankName], ["Account name", form.bankAccountName], ["Account number", form.bankAccountNumber], ["IFSC", form.bankIfsc]]
    .map(([label, value]) => [label, value.trim()]).filter(([, value]) => value);
  return (
    <>
      <PreviewLabel>What owners see in Your plan</PreviewLabel>
      <div className="pc-paycard">
        <strong className="pc-paycard-title">Pay for your plan</strong>
        {upi ? (
          <div className="pc-paycard-upi">
            {qr.upi === upi && qr.image ? <img src={qr.image} alt="" width="112" height="112" /> : <span className="pc-paycard-qr" aria-hidden="true" />}
            <span className="pc-two-line">
              <small>UPI</small>
              <strong className="mono">{upi}</strong>
              {payee && <small>{payee}</small>}
            </span>
          </div>
        ) : <p className="pc-paycard-empty">No UPI ID yet.</p>}
        {bank.length > 0 ? (
          <dl className="pc-paycard-bank">
            {bank.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd className={label === "Bank" || label === "Account name" ? undefined : "mono"}>{value}</dd></div>
            ))}
          </dl>
        ) : <p className="pc-paycard-empty">No bank account yet.</p>}
        {form.paymentNote.trim() && <p className="pc-paycard-note">{form.paymentNote.trim()}</p>}
      </div>
      {upi && <p className="pc-preview-note">Owners' codes carry their order's exact amount and number; this one carries none, so a scan only shows whose account it opens.</p>}
    </>
  );
}

// --- The price list --------------------------------------------------------------------------

const planCode = (type, name) => `${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`.slice(0, 40);
const blank = (value) => (value === null || value === undefined ? "" : String(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const planBody = (p) => ({ code: p.code, businessType: p.businessType, name: p.name.trim(), description: p.description || null, monthly: blank(p.monthly).trim() || null,
  yearly: blank(p.yearly).trim() || null, isDefault: p.isDefault, active: p.active, sortOrder: p.sortOrder, modules: [...p.modules].sort() });
const priceBody = (p) => ({ code: p.code, soldAs: p.soldAs, monthly: blank(p.monthly).trim() || null, yearly: blank(p.yearly).trim() || null, available: p.available });
const SOLD_AS = [["module", "Module"], ["application", "Application"]];

// Each business type's plans (price, the modules each includes, the default,
// whether it is offered) and every module's and application's price, saved
// together with one button, which also marks the price list reviewed. Prices
// are before GST. A change reaches a business at its next order. The bar at
// the foot counts what is not saved yet.
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

  // How many plans and prices differ from the list as it was loaded.
  const unsaved = useMemo(() => {
    if (!data) return 0;
    const originals = new Map(data.plans.map((p) => [p.code, planBody(p)]));
    const originalPrices = new Map(data.prices.map((p) => [p.code, priceBody(p)]));
    return plans.filter((p) => p.isNew || !same(originals.get(p.code), planBody(p))).length
      + prices.filter((p) => !same(originalPrices.get(p.code), priceBody(p))).length;
  }, [data, plans, prices]);

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
    <form className="stack pc-prices" onSubmit={save} aria-label="Price list">
      <div className={`alert ${data.pricesReviewedAt ? "alert-info" : "alert-notice"}`} role="status">
        {data.pricesReviewedAt ? `Prices last reviewed ${dateTime(data.pricesReviewedAt, { year: true })}.` : "The prices have not been reviewed yet: check them, then save to mark them reviewed."}
        {" "}Prices are before GST{gstRate ? ` (${Number(gstRate)}% is added on each invoice)` : ""}. A change reaches a business at its next order; open orders keep their prices.
      </div>
      <ErrorMessage message={error} />
      <SectionCard icon="layers" title="Plans" description="Each type of business has its plans; the default one is what a new business starts with."
        actions={(
          <label className="field pc-type-pick">
            <span>Type of business</span>
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type of business">
              {data.types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          </label>
        )}>
        <div className="pc-plans">
          {typePlans.map((plan) => (
            <PlanEditor key={plan.code || `new-${indexOf(plan)}`} plan={plan} modules={typeModules} typeName={typeName} gstRate={gstRate}
              onChange={(change) => setPlan(indexOf(plan), change)} onDefault={() => makeDefault(plan)} />
          ))}
          <button type="button" className="pc-plan-add" onClick={addPlan}><Icon name="plus" size={18} /> Add a plan for {typeName}</button>
        </div>
      </SectionCard>
      <SectionCard icon="tag" title="Modules and applications" flush
        description="Add-ons on top of a plan. A module's price is the same for every type of business that can use it; a price of 0 is free, an empty one not for sale yet."
        actions={(
          <label className="checkbox pc-flag">
            <input type="checkbox" checked={allModules} onChange={(e) => setAllModules(e.target.checked)} /> Every module, not only {typeName}'s
          </label>
        )}>
        <DataGrid variant="editor" caption="Module and application prices" rows={shownPrices} rowKey={(p) => p.code} columns={[
          { key: "name", header: "Module", value: (p) => p.name, render: (p) => {
            const saving = yearSavingWords(p.monthly, p.yearly);
            return <span className="pc-two-line"><strong>{p.name}</strong>{saving && <small>{saving}</small>}</span>;
          } },
          { key: "soldAs", header: "Sold as", render: (p, ctx) => (
            <span className="pc-segment" role="radiogroup" aria-label={`${ctx.label}: ${p.name}`}>
              {SOLD_AS.map(([value, label]) => (
                <label key={value}>
                  <input type="radio" name={`sold-as-${p.code}`} value={value} checked={p.soldAs === value} onChange={() => setPrice(p.code, { soldAs: value })} />
                  <span>{label}</span>
                </label>
              ))}
            </span>
          ) },
          { key: "monthly", header: "Monthly (₹)", render: (p, ctx) => (
            <input aria-label={`${ctx.label}: ${p.name}`} className="pc-price-input pc-rupee" inputMode="decimal" value={p.monthly} onChange={(e) => setPrice(p.code, { monthly: e.target.value })} />
          ) },
          { key: "yearly", header: "Yearly (₹)", render: (p, ctx) => (
            <input aria-label={`${ctx.label}: ${p.name}`} className="pc-price-input pc-rupee" inputMode="decimal" value={p.yearly} onChange={(e) => setPrice(p.code, { yearly: e.target.value })} />
          ) },
          { key: "available", header: "Owners may add it", render: (p, ctx) => (
            <label className="pc-switch">
              <input type="checkbox" role="switch" aria-label={`${ctx.label}: ${p.name}`} checked={p.available} onChange={(e) => setPrice(p.code, { available: e.target.checked })} />
              <span aria-hidden="true" />
            </label>
          ) },
        ]} />
      </SectionCard>
      <div className={`pc-savebar${unsaved ? " has-changes" : ""}`}>
        <span className="pc-savebar-text">
          {unsaved ? `${unsaved} ${unsaved === 1 ? "change" : "changes"} not saved yet` : "Nothing changed: saving marks the price list reviewed."}
        </span>
        <button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save prices"}</button>
      </div>
    </form>
  );
}

// One plan of a business type: its name, the default and offered marks, its
// prices with what they come to with GST and what a year saves, and the
// modules and applications it includes, as chips to tick.
function PlanEditor({ plan, modules, typeName, gstRate, onChange, onDefault }) {
  const included = modules.filter((m) => plan.modules.includes(m.code)).length;
  const saving = yearSavingWords(plan.monthly, plan.yearly);
  const groups = [["module", "Modules"], ["application", "Applications"]]
    .map(([kind, title]) => ({ kind, title, items: modules.filter((m) => (m.soldAs === "application") === (kind === "application")) }))
    .filter((group) => group.items.length > 0);
  const toggle = (code, on) => onChange({ modules: on ? [...plan.modules, code] : plan.modules.filter((c) => c !== code) });

  return (
    <fieldset className={`pc-plan${plan.isDefault ? " is-default" : ""}${plan.active ? "" : " is-off"}`} aria-label={`Plan ${plan.name || "(new)"}`}>
      <div className="pc-plan-head">
        <span className="pc-plan-mark" aria-hidden="true"><Icon name="layers" size={20} /></span>
        <FormField label="Plan name" className="pc-plan-name">
          <input required maxLength={80} value={plan.name} onChange={(e) => onChange({ name: e.target.value })} />
        </FormField>
        <div className="pc-plan-flags">
          <label className="pc-flag">
            <input type="radio" name={`default-${plan.businessType}`} checked={plan.isDefault} onChange={onDefault} /> Default for a new {typeName} business
          </label>
          <label className="pc-flag">
            <input type="checkbox" checked={plan.active} disabled={plan.isDefault} onChange={(e) => onChange({ active: e.target.checked })} /> Offered to owners
          </label>
        </div>
      </div>
      <div className="pc-plan-prices">
        <FormField label="Monthly price (₹)" hint={priceWords(plan.monthly, "month", gstRate || 18)}>
          <input className="pc-price-input pc-rupee" inputMode="decimal" value={plan.monthly} onChange={(e) => onChange({ monthly: e.target.value })} />
        </FormField>
        <FormField label="Yearly price (₹)" hint={priceWords(plan.yearly, "year", gstRate || 18)}>
          <input className="pc-price-input pc-rupee" inputMode="decimal" value={plan.yearly} onChange={(e) => onChange({ yearly: e.target.value })} />
        </FormField>
        {saving && <p className={`pc-plan-saving${saving.startsWith("Dearer") ? " is-dearer" : ""}`}><Icon name="percent" size={14} /> {saving}</p>}
      </div>
      <div className="pc-plan-modules">
        <p className="pc-plan-count"><strong>{included}</strong> of {modules.length} included</p>
        {groups.map((group) => (
          <div key={group.kind} className="pc-module-group">
            <span className="pc-module-group-title">{group.title}</span>
            <div className="pc-modules">
              {group.items.map((m) => (
                <label key={m.code} className="pc-module">
                  <input type="checkbox" checked={plan.modules.includes(m.code)} onChange={(e) => toggle(m.code, e.target.checked)} />
                  <span>{m.name}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
