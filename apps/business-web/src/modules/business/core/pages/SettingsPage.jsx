import { useEffect, useState } from "react";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { COMMON_CURRENCIES } from "./newBusiness";

const zoneList = (() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return ["Asia/Kolkata"]; } })();
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader, Badge, Field } from "./ui";
import { useDirtyGuard, useOpenBusiness } from "./hooks";
import { confirmAction } from "../../../../services/confirm";
import SettingsLayout, { SettingsSaveBar } from "../../../../components/SettingsLayout";
import { toast } from "../../../../services/toast";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fromRow = (s) => ({
  displayName: s.display_name || "", legalName: s.legal_name || "", gstin: s.gstin || "", addressLine1: s.address_line1 || "", addressLine2: s.address_line2 || "",
  city: s.city || "", stateCode: s.state_code || "", postalCode: s.postal_code || "", phone: s.phone || "", email: s.email || "", logoPath: s.logo_path || "",
  taxMode: s.tax_mode, rounding: s.rounding, fiscalYearStartMonth: String(s.fiscal_year_start_month), dateFormat: s.date_format,
  invoiceFooter: s.invoice_footer || "", receiptFooter: s.receipt_footer || "",
  maxBillDiscountPercent: String(Number(s.max_bill_discount_percent ?? 10)), walkInCredit: Boolean(s.walk_in_credit),
  counterPinEveryBill: Boolean(s.counter_pin_every_bill),
  currency: s.currency || "INR", timezone: s.timezone || "Asia/Kolkata",
  // Business rules.
  voucherValidDays: String(s.voucher_valid_days ?? 90), nearExpiryDays: String(s.near_expiry_days ?? 30),
  ageing1: String(s.ageing_days?.[0] ?? 30), ageing2: String(s.ageing_days?.[1] ?? 60), ageing3: String(s.ageing_days?.[2] ?? 90),
  weightButtons: (s.weight_buttons_grams || [250, 500, 1000, 2000]).join(", "), receiptWidthMm: String(s.receipt_width_mm ?? 80),
  dayCutoffHour: String(s.day_cutoff_hour ?? 5),
});
// What the API takes: the rules as numbers and lists.
const toBody = (form) => {
  const { ageing1, ageing2, ageing3, weightButtons, ...rest } = form;
  return {
    ...rest,
    ageingDays: [ageing1, ageing2, ageing3].map(Number),
    weightButtonsGrams: weightButtons.split(/[\s,]+/).filter(Boolean).map(Number),
    voucherValidDays: Number(form.voucherValidDays), nearExpiryDays: Number(form.nearExpiryDays),
    receiptWidthMm: Number(form.receiptWidthMm), dayCutoffHour: Number(form.dayCutoffHour),
  };
};

const SECTIONS = [
  { id: "bz-settings-details", label: "Business details" },
  { id: "bz-settings-prices", label: "Prices and totals" },
  { id: "bz-settings-rules", label: "Rules" },
  { id: "bz-settings-modules", label: "Business tools" },
];

// This business's own details and billing rules, and the modules it uses.
// Nothing here touches any other business.
export default function SettingsPage() {
  const biz = useOpenBusiness();
  const editable = biz.can("settings.edit");
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useDirtyGuard(dirty);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "settings", undefined, controller.signal)
      .then((s) => { setForm(fromRow(s)); setSaved(fromRow(s)); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const set = (name) => (e) => { setDirty(true); setForm((f) => ({ ...f, [name]: e.target.value })); };

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await businessWrite(biz.id, "settings", toBody(form), "put");
      setForm(fromRow(saved));
      setSaved(fromRow(saved));
      setSavedAt(new Date());
      setDirty(false);
      setNotice("");
      toast.success("Settings saved. New sales use them from now on; posted bills keep what they were.");
      biz.reloadContext();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <BusinessHeader icon="settings" title="Business settings" description="The name and GSTIN on your bills, how prices and totals work, and which modules this business uses." />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error} />
      {!form && !error && <Loading />}
      {form && (
        <SettingsLayout sections={SECTIONS}>
        <form className="stack" onSubmit={save}>
          <fieldset className="bz-plain-fieldset" disabled={!editable || busy}>
            <SectionCard id="bz-settings-details" icon="store" title="Business details" description="Printed at the top of invoices and receipts.">
              <div className="form-grid">
                <Field label="Name shown in the app"><input required maxLength={150} value={form.displayName} onChange={set("displayName")} /></Field>
                <Field label="Legal name (on invoices)"><input maxLength={200} value={form.legalName} onChange={set("legalName")} /></Field>
                <Field label="GSTIN" hint="Its first two digits set the state."><input maxLength={20} className="mono" value={form.gstin} onChange={set("gstin")} /></Field>
                <Field label="GST state code"><input maxLength={2} inputMode="numeric" className="mono" value={form.stateCode} onChange={set("stateCode")} placeholder="e.g. 27" /></Field>
                <Field label="Address line 1"><input maxLength={200} value={form.addressLine1} onChange={set("addressLine1")} /></Field>
                <Field label="Address line 2"><input maxLength={200} value={form.addressLine2} onChange={set("addressLine2")} /></Field>
                <Field label="City"><input maxLength={100} value={form.city} onChange={set("city")} /></Field>
                <Field label="PIN code"><input maxLength={6} inputMode="numeric" value={form.postalCode} onChange={set("postalCode")} /></Field>
                <Field label="Phone"><input maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
                <Field label="Email"><input type="email" maxLength={150} value={form.email} onChange={set("email")} /></Field>
                <Field label="Logo (optional)" wide hint="The web address of your logo image; it is printed at the top of invoices."><input maxLength={300} value={form.logoPath} onChange={set("logoPath")} /></Field>
              </div>
            </SectionCard>
            <SectionCard id="bz-settings-prices" icon="receipt" title="Prices, totals and numbering" description="How new sales are worked out.">
              <div className="form-grid">
                <Field label="Selling prices" hint="Inclusive: the price on the shelf already has GST in it.">
                  <select value={form.taxMode} onChange={set("taxMode")}>
                    <option value="exclusive">Before GST (GST added on top)</option>
                    <option value="inclusive">Including GST</option>
                  </select>
                </Field>
                <Field label="Round sale totals">
                  <select value={form.rounding} onChange={set("rounding")}>
                    <option value="none">No rounding (to the paisa)</option>
                    <option value="nearest_rupee">To the nearest rupee</option>
                  </select>
                </Field>
                <Field label="Financial year starts in" hint="Document numbers start again each financial year. Fixed once the first document is numbered.">
                  <select value={form.fiscalYearStartMonth} onChange={set("fiscalYearStartMonth")}>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </Field>
                <Field label="Currency" hint="Three letters, e.g. INR. Cannot change once bills or purchases are recorded.">
                  <input required list="settings-currencies" className="mono" maxLength={3} value={form.currency} onChange={(e) => { setDirty(true); setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() })); }} />
                  <datalist id="settings-currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
                </Field>
                <Field label="Time zone" hint="Decides what “today” is for bills, the day close and reports.">
                  <input required list="settings-zones" maxLength={60} value={form.timezone} onChange={set("timezone")} />
                  <datalist id="settings-zones">{zoneList.map((z) => <option key={z} value={z} />)}</datalist>
                </Field>
                <Field label="Date format on documents">
                  <select value={form.dateFormat} onChange={set("dateFormat")}>
                    {["DD/MM/YYYY", "DD-MM-YYYY", "DD MMM YYYY", "YYYY-MM-DD"].map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </Field>
                <Field label="Most discount at the counter (%)" hint="The most a manager can take off a bill at Quick bill (with a reason). The owner is not limited.">
                  <input type="number" min="0" max="100" step="0.5" value={form.maxBillDiscountPercent} onChange={set("maxBillDiscountPercent")} />
                </Field>
                <Field label="Walk-in customers" hint="Udhaar is for named customers; a walk-in pays the whole bill unless you allow otherwise.">
                  <select value={form.walkInCredit ? "yes" : "no"} onChange={(e) => { setDirty(true); setForm((f) => ({ ...f, walkInCredit: e.target.value === "yes" })); }}>
                    <option value="no">Pay the whole bill (recommended)</option>
                    <option value="yes">May leave a bill unpaid</option>
                  </select>
                </Field>
                <Field label="Shared till" hint="Each cashier switches the till to themselves with their own PIN; every bill records who billed it. Asking for every bill stops anyone billing under a colleague's name.">
                  <select value={form.counterPinEveryBill ? "yes" : "no"} onChange={(e) => { setDirty(true); setForm((f) => ({ ...f, counterPinEveryBill: e.target.value === "yes" })); }}>
                    <option value="no">Ask the PIN only to switch who is billing</option>
                    <option value="yes">Ask the biller's PIN for every bill</option>
                  </select>
                </Field>
                <Field label="Invoice footer" wide><input maxLength={500} value={form.invoiceFooter} onChange={set("invoiceFooter")} placeholder="e.g. Goods once sold will be exchanged within 7 days with the bill." /></Field>
                <Field label="Receipt footer" wide><input maxLength={300} value={form.receiptFooter} onChange={set("receiptFooter")} placeholder="e.g. Thank you! Visit again." /></Field>
              </div>
            </SectionCard>
            <SectionCard id="bz-settings-rules" icon="sliders" title="Rules" description="How this business works day to day. Each starts at the usual value; change only what you need.">
              <div className="form-grid">
                <Field label="Expiring soon means within (days)" hint="Batches shown on the Overview, the bell, the near-expiry list and the stock list.">
                  <input type="number" min="1" max="365" required value={form.nearExpiryDays} onChange={set("nearExpiryDays")} />
                </Field>
                <Field label="Credit vouchers valid for (days)" hint="A voucher from an exchange or return can be spent until then.">
                  <input type="number" min="1" max="3650" required value={form.voucherValidDays} onChange={set("voucherValidDays")} />
                </Field>
                <Field label="Customer credit age groups (days)" hint="What customers owe is grouped by the age of the bill: up to the first, up to the second, up to the third, and older." wide>
                  <span style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                    <input type="number" min="1" max="3650" required aria-label="First group up to (days)" value={form.ageing1} onChange={set("ageing1")} />
                    <input type="number" min="2" max="3650" required aria-label="Second group up to (days)" value={form.ageing2} onChange={set("ageing2")} />
                    <input type="number" min="3" max="3650" required aria-label="Third group up to (days)" value={form.ageing3} onChange={set("ageing3")} />
                  </span>
                </Field>
                <Field label="Quick weight buttons (grams)" hint="At Quick bill for loose goods, e.g. 100, 250, 500, 1000. Up to 8.">
                  <input required value={form.weightButtons} onChange={set("weightButtons")} />
                </Field>
                <Field label="Till receipt paper" hint="The width of the receipt printer's roll.">
                  <select value={form.receiptWidthMm} onChange={set("receiptWidthMm")}>
                    <option value="80">80 mm</option>
                    <option value="58">58 mm</option>
                  </select>
                </Field>
                <Field label="Day cut-off" hint="A task due after midnight, before this hour, belongs to the day before (a late closing check).">
                  <select value={form.dayCutoffHour} onChange={set("dayCutoffHour")}>
                    {Array.from({ length: 13 }, (_, h) => <option key={h} value={h}>{h === 0 ? "Midnight" : h === 12 ? "Noon" : `${h} am`}</option>)}
                  </select>
                </Field>
              </div>
            </SectionCard>
          </fieldset>
          <SettingsSaveBar
            dirty={dirty}
            saving={busy}
            savedAt={savedAt}
            disabled={!editable}
            saveLabel="Save settings"
            onReset={() => { setForm(saved); setDirty(false); }}
          />
        </form>
        <ModulesCard />
        </SettingsLayout>
      )}
      {!form && <ModulesCard />}
    </div>
  );
}

function ModulesCard() {
  const biz = useOpenBusiness();
  const editable = biz.can("settings.edit");
  const [modules, setModules] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [version, setVersion] = useState(0);
  // A restaurant's modules are its features: the same switches as the
  // restaurant's own Settings -> Features, under the same rules (a switch
  // that would strand money is refused; the restaurant's activity log
  // records it).
  const restaurant = biz.type === "restaurant";
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "modules", undefined, controller.signal)
      .then(setModules)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const toggle = async (module) => {
    if (
      restaurant &&
      module.enabled &&
      !(await confirmAction({
        title: `Switch off ${module.name}?`,
        message: "Its screens, buttons and alerts are hidden for everyone in this restaurant. Nothing is deleted; switch it on again at any time.",
        confirmLabel: "Switch off",
      }))
    ) {
      return;
    }
    setBusy(module.code);
    setError("");
    setNotice("");
    try {
      const result = await businessWrite(biz.id, `modules/${module.code}`, { enabled: !module.enabled }, "put");
      if (result?.warnings?.length) setNotice(`${module.name} is switched off. ${result.warnings.join(" ")}`);
      setVersion((n) => n + 1);
      biz.reloadContext();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy("");
    }
  };
  const name = (code) => modules?.find((m) => m.code === code)?.name || code;
  const optional = (modules || []).filter((m) => m.kind === "optional" && (!restaurant || m.code !== "restaurant"));
  const groups = restaurant
    ? [...new Set(optional.map((m) => m.feature_group || "Other"))].map((title) => ({ title, list: optional.filter((m) => (m.feature_group || "Other") === title) }))
    : [
      {title:'Everyday work',list:optional.filter(m=>['catalog','contacts','sales','purchasing','inventory','expenses','appointments','patients','pharmacy','receivables','hardware_sites','hardware_rates','hardware_calculators','agri','optical','garage'].includes(m.code))},
      // Tools recommended for this trade come first, so an owner sees them before the rest.
      {title:'Optional workflows',list:optional.filter(m=>!['catalog','contacts','sales','purchasing','inventory','expenses','appointments','patients','pharmacy','receivables','hardware_sites','hardware_rates','hardware_calculators','agri','optical','garage'].includes(m.code))
        .sort((a,b)=>Number(Boolean(b.recommended&&!b.enabled))-Number(Boolean(a.recommended&&!a.enabled)))},
    ].filter(group=>group.list.length);
  const card = (m) => {
    const neededBy = (modules || []).filter((other) => other.enabled && other.requires.includes(m.code));
    const missing = m.requires.filter((code) => !modules.find((other) => other.code === code)?.enabled);
    return (
      <div key={m.code} className={`bz-module ${m.enabled ? "is-on" : ""}`}>
        <div>
          <strong>{m.name}</strong>
          {m.recommended && !m.enabled && <span className="bz-module-recommended">Recommended</span>}
          <p className="muted small">{m.description}</p>
          {m.recommended && !m.enabled && m.recommended_note && <p className="small bz-module-why">{m.recommended_note}</p>}
          {m.requires.filter((code) => code !== "restaurant").length > 0 && (
            <p className={`small ${missing.length ? "text-warning" : "muted"}`}>Needs {m.requires.filter((code) => code !== "restaurant").map(name).join(", ")}.</p>
          )}
          {restaurant && neededBy.length > 0 && <p className="muted small">{neededBy.map((other) => other.name).join(", ")} {neededBy.length === 1 ? "needs" : "need"} this.</p>}
        </div>
        {editable ? (
          <label className="bz-switch">
            <input type="checkbox" role="switch" checked={m.enabled} disabled={busy === m.code} onChange={() => toggle(m)} aria-label={`${m.name}: ${m.enabled ? "on" : "off"}`} />
            <span aria-hidden="true" />
          </label>
        ) : <Badge tone={m.enabled ? "active" : "inactive"} label={m.enabled ? "On" : "Off"} />}
      </div>
    );
  };
  return (
    <SectionCard id="bz-settings-modules" icon="layers" title={restaurant ? "Restaurant features" : "Business tools"}
      description={restaurant
        ? "The same switches as the restaurant's Settings → Features. Switching one off hides it everywhere in the restaurant; its records stay. A switch that would leave money stranded (an advance still held, rider cash not settled) is refused."
        : "Use the tools that match how this business operates. Enable packages, repairs, finance or laboratory work only when you offer them. Switching a tool off keeps its history."}>
      <ErrorMessage message={error} />
      <SuccessMessage message={notice} />
      {!modules && !error && <Loading />}
      {modules && (
        <div className="bz-modules">
          {groups.map((group) => (
            group.title
              ? [<p key={`h-${group.title}`} className="section-heading bz-module-group">{group.title}</p>, ...group.list.map(card)]
              : group.list.map(card)
          ))}
          {modules.filter((m) => restaurant && m.kind === "core").map((m) => (
            <div key={m.code} className="bz-module is-on is-core">
              <div><strong>{m.name}</strong><p className="muted small">{m.description}</p></div>
              <Badge tone="info" label="Always on" />
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
