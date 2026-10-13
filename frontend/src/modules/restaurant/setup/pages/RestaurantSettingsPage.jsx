import { useEffect, useMemo, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import FormField from "../../../../components/FormField";
import SearchPicker from "../../../../components/SearchPicker";
import SettingsLayout, { SettingsSaveBar } from "../../../../components/SettingsLayout";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { listTaxRates } from "../../menu/services/menu.service";
import { toast } from "../../../../services/toast";
import {
  getDiscountLimits,
  getInvoiceSeries,
  getSettings,
  listTimezones,
  saveDiscountLimits,
  updateSettings,
} from "../services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { ORDER_TYPE_OPTIONS } from "../../../../services/labels";
import useAuth from "../../../../hooks/useAuth";
import { Link, useLocation } from "react-router-dom";
import { FEATURES_PATH } from "../../../../services/features";
import PaymentTypesCard from "./PaymentTypesCard";
import AlertRulesCard from "./AlertRulesCard";
import "../../../../styles/billing.css";
import "../styles/invoice-series.css";
import "../styles/setup.css";

// The time it is now in a time zone, to check the choice at a glance.
const nowIn = (timezone) => {
  try {
    return new Date().toLocaleTimeString("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  } catch {
    return null;
  }
};

// The sections, in the order they sit on the page, for the index beside them.
// Their ids are also the anchors the profile's set-up checklist links to
// (/restaurant/settings#settings-gst).
const SECTIONS = [
  { id: "settings-gst", label: "GST and invoice" },
  { id: "settings-region", label: "Currency and time" },
  { id: "settings-service", label: "Service charge" },
  { id: "settings-numbering", label: "Order and bill numbers" },
  { id: "settings-upi", label: "UPI payments" },
  { id: "settings-loyalty", label: "Loyalty" },
  { id: "settings-printing", label: "Printing" },
  { id: "settings-alerts", label: "Alerts and timings" },
  { id: "settings-discounts", label: "Discounts at the till" },
  { id: "settings-payment-types", label: "Payment types" },
];

// India first: nearly every restaurant here keeps Indian time.
const HOME_ZONE = "Asia/Kolkata";

// The financial year a date falls in, as a bill number prints it: "26-27".
const yearTag = (date = new Date()) => {
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(year % 100).padStart(2, "0")}-${String((year + 1) % 100).padStart(2, "0")}`;
};

export default function RestaurantSettingsPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("restaurant.settings.manage");
  const location = useLocation();
  // The tax rate new dishes get (Menu -> Tax rates), named instead of a
  // number here. null: not known (no menu permission, or not loaded).
  const [defaultRate, setDefaultRate] = useState(undefined);
  const [savedAt, setSavedAt] = useState(null);

  const [form, setForm] = useState(null);
  // What the server last said, so the save bar can tell unsaved changes.
  const [saved, setSaved] = useState(null);
  const [zones, setZones] = useState([]);
  const [limits, setLimits] = useState(null);
  const [limitDraft, setLimitDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [savingLimits, setSavingLimits] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [limitsError, setLimitsError] = useState("");
  const [limitsSuccess, setLimitsSuccess] = useState("");
  // Each till's invoice series (the main counter's and every outlet's).
  const [series, setSeries] = useState([]);

  useEffect(() => {
    getSettings()
      .then((loaded) => {
        setForm(loaded);
        setSaved(loaded);
      })
      .catch((err) => setError(getErrorMessage(err)));

    getInvoiceSeries()
      .then(setSeries)
      .catch(() => setSeries([]));

    listTimezones()
      .then(setZones)
      .catch(() => setZones([]));

    listTaxRates()
      .then((rates) => setDefaultRate(rates.find((rate) => rate.isDefault && rate.status !== "inactive") || null))
      .catch(() => setDefaultRate(undefined));

    getDiscountLimits()
      .then((data) => {
        setLimits(data.roles);
        setLimitDraft(Object.fromEntries(data.roles.map((role) => [role.id, role.maxPercent === null ? "" : String(role.maxPercent)])));
      })
      .catch(() => setLimits(null));
  }, []);

  // The saved zone is always in the list, even one the list does not carry.
  // Asia/Kolkata leads, then the rest as the server orders them.
  const zoneOptions = useMemo(() => {
    const list = !form || zones.some((zone) => zone.name === form.timezone)
      ? zones
      : [{ name: form.timezone, offset: "", label: form.timezone }, ...zones];
    const home = list.find((zone) => zone.name === HOME_ZONE) || { name: HOME_ZONE, offset: "+05:30", label: "Asia/Kolkata (UTC+05:30) · India" };

    return [home, ...list.filter((zone) => zone.name !== HOME_ZONE)];
  }, [zones, form]);

  // A link from the set-up checklist (/restaurant/settings#settings-gst)
  // lands on its section once the form is on screen.
  const ready = Boolean(form);
  useEffect(() => {
    if (!ready || !location.hash) {
      return;
    }

    const target = document.getElementById(location.hash.slice(1));
    target?.scrollIntoView({ block: "start" });
  }, [ready, location.hash]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const toggleType = (type) => {
    const types = form.serviceChargeOrderTypes || ["dine_in"];

    setForm({
      ...form,
      serviceChargeOrderTypes: types.includes(type) ? types.filter((one) => one !== type) : [...types, type],
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);

    try {
      // Loyalty on or off is switched in Settings -> Features, never here: a
      // form loaded before a switch must not switch it back.
      const rest = { ...form };
      delete rest.loyaltyEnabled;
      const updated = await updateSettings({
        ...rest,
        // Number inputs give text, and the API expects numbers.
        defaultTaxPercentage: Number(form.defaultTaxPercentage),
        serviceChargePercentage: Number(form.serviceChargePercentage),
        loyaltyEarnAmount: Number(form.loyaltyEarnAmount),
        loyaltyPointValue: Number(form.loyaltyPointValue),
        loyaltyMinRedeem: Number(form.loyaltyMinRedeem),
        printCopies: Number(form.printCopies),
        // Alerts and timings: numbers, and the list of notes as it is.
        ...(form.rules
          ? {
              rules: Object.fromEntries(
                Object.entries(form.rules).map(([key, value]) => [key, Array.isArray(value) ? value : Number(value)])
              ),
            }
          : {}),
      });
      setForm(updated);
      setSaved(updated);
      setSavedAt(new Date());
      setSuccess("");
      toast.success("Settings saved");
      // An outlet without a prefix of its own numbers under the restaurant's.
      getInvoiceSeries()
        .then(setSeries)
        .catch(() => undefined);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveLimits = async (event) => {
    event.preventDefault();
    setLimitsError("");
    setLimitsSuccess("");
    setSavingLimits(true);

    try {
      const stored = await saveDiscountLimits(
        limits.map((role) => ({
          roleId: role.id,
          maxPercent: limitDraft[role.id] === "" || limitDraft[role.id] === undefined ? null : Number(limitDraft[role.id]),
        }))
      );
      setLimits(stored.roles);
      setLimitsSuccess("Discount limits saved");
    } catch (err) {
      setLimitsError(getErrorMessage(err));
    } finally {
      setSavingLimits(false);
    }
  };

  if (!form) {
    return error ? <ErrorMessage message={error} /> : <Loading />;
  }

  const types = form.serviceChargeOrderTypes || ["dine_in"];
  const here = nowIn(form.timezone);
  const dirty = canEdit && saved !== null && JSON.stringify(form) !== JSON.stringify(saved);
  const sections = SECTIONS.filter((section) => section.id !== "settings-discounts" || limits);

  return (
    <div className="stack settings-page">
      <PageHeader
        icon="settings"
        title="Settings"
        description="How every order and bill is worked out, numbered and printed"
      />

      {!canEdit && (
        <div className="alert alert-info">You can see these settings. Changing them needs the permission to manage settings.</div>
      )}

      <SettingsLayout sections={sections}>
          <form className="settings-sections" onSubmit={handleSubmit}>

            <SectionCard
              id="settings-gst"
              icon="percent"
              title="GST and tax invoice"
              description="How tax is added to the menu price, and the registration numbers a tax invoice must carry."
            >
              <div className="form-grid">
                <label className="field">
                  <span>Tax mode</span>
                  <select value={form.taxMode} onChange={change("taxMode")} disabled={!canEdit}>
                    <option value="exclusive">Exclusive (GST added to the menu price)</option>
                    <option value="inclusive">Inclusive (menu price already has GST)</option>
                  </select>
                  <small className="muted">Most restaurants add GST on top of the menu price</small>
                </label>

                {/* The rate a new dish starts on is the default tax rate in
                    Menu -> Tax rates; each dish keeps its own. The old
                    percentage is still saved as it was (sent back unchanged). */}
                <div className="field">
                  <span>Tax on new dishes</span>
                  <p className="settings-readonly">
                    {defaultRate ? (
                      <>
                        New dishes get <strong>{defaultRate.name}</strong>
                        {defaultRate.percentage !== undefined ? ` (${Number(defaultRate.percentage)}%)` : ""}
                      </>
                    ) : defaultRate === null ? (
                      <span className="text-warning">No default tax rate is set, so a new dish must be given one</span>
                    ) : (
                      "New dishes get the default tax rate"
                    )}
                  </p>
                  <small className="muted">
                    Change it in <Link to="/menu/tax-rates">Menu → Tax rates</Link>. Each dish is charged at its own rate.
                  </small>
                </div>

                <FormField label="GSTIN" optional hint="With a GSTIN the bill prints as a Tax Invoice">
                  <input
                    className="mono"
                    value={form.gstNumber || ""}
                    onChange={change("gstNumber")}
                    maxLength={20}
                    disabled={!canEdit}
                    placeholder="37ABCDE1234F1Z5"
                  />
                </FormField>

                <FormField label="FSSAI number" optional hint="Printed on the bill when filled in">
                  <input
                    className="mono"
                    value={form.fssaiNumber || ""}
                    onChange={change("fssaiNumber")}
                    maxLength={20}
                    disabled={!canEdit}
                  />
                </FormField>

                <label className="checkbox field-wide settings-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(form.gstSplit)}
                    onChange={(event) => setForm({ ...form, gstSplit: event.target.checked })}
                    disabled={!canEdit}
                  />
                  <span>Show the tax as CGST + SGST, each at half the rate, on bills and reports</span>
                </label>
              </div>
            </SectionCard>

            <SectionCard
              id="settings-region"
              icon="clock"
              tone="info"
              title="Currency and time zone"
              description="The money sign on every screen and bill, and the clock that business days, happy hours and reports keep."
            >
              <div className="form-grid">
                <label className="field">
                  <span>Currency code</span>
                  <input value={form.currencyCode} onChange={change("currencyCode")} maxLength={3} required disabled={!canEdit} />
                  <small className="muted">Three letters, such as INR</small>
                </label>

                <label className="field">
                  <span>Currency symbol</span>
                  <input value={form.currencySymbol} onChange={change("currencySymbol")} maxLength={5} required disabled={!canEdit} />
                  <small className="muted">Shown before every amount</small>
                </label>

                <div className="field-wide">
                  <SearchPicker
                    label="Time zone"
                    value={zoneOptions.find((zone) => zone.name === form.timezone) || null}
                    onChange={(zone) => zone && setForm({ ...form, timezone: zone.name })}
                    options={zoneOptions}
                    getKey={(zone) => zone.name}
                    getLabel={(zone) => zone.label || zone.name}
                    getKeywords={(zone) => `${zone.name} ${zone.offset || ""}`}
                    placeholder="Type a city, such as Kolkata or Dubai"
                    clearable={false}
                    disabled={!canEdit}
                    hint={`${here ? `It is ${here} there now. ` : ""}India is Asia/Kolkata (UTC+05:30), first in the list.`}
                  />
                </div>
              </div>
            </SectionCard>

            <SectionCard
              id="settings-service"
              icon="users"
              tone="success"
              title="Service charge"
              description="Charged on the dishes after discount. GST is charged on it at the same rate as the food, and a guest who asks can have it taken off at the till."
            >
              <div className="form-grid">
                <label className="field">
                  <span>Service charge %</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={form.serviceChargePercentage}
                    onChange={change("serviceChargePercentage")}
                    disabled={!canEdit}
                  />
                  <small className="muted">0 means no service charge</small>
                </label>

                <div className="field">
                  <span>Charged on</span>
                  <div className="sc-types">
                    {ORDER_TYPE_OPTIONS.map(({ value, label }) => (
                      <label className={`checkbox sc-type ${types.includes(value) ? "is-on" : ""}`} key={value}>
                        <input
                          type="checkbox"
                          checked={types.includes(value)}
                          onChange={() => toggleType(value)}
                          disabled={!canEdit}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <small className="muted">Table service: dine-in only is usual. A takeaway guest got no service.</small>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              id="settings-numbering"
              icon="receipt"
              tone="neutral"
              title="Order and bill numbers"
              description="How order and bill numbers look on screen and on paper, and what billing does to stock."
            >
              <div className="form-grid">
                <label className="field">
                  <span>Order prefix</span>
                  <input className="mono" value={form.orderPrefix} onChange={change("orderPrefix")} maxLength={10} required disabled={!canEdit} />
                  <small className="muted">
                    Order numbers will look like <span className="settings-sample mono">{form.orderPrefix}-0001</span>
                  </small>
                </label>

                <label className="field">
                  <span>Invoice prefix</span>
                  <input
                    className="mono"
                    value={form.invoicePrefix}
                    onChange={change("invoicePrefix")}
                    maxLength={10}
                    pattern="[A-Za-z0-9][A-Za-z0-9\/\-]{0,9}"
                    title="Letters, digits, - and / only: GST allows nothing else in an invoice number"
                    required
                    disabled={!canEdit}
                  />
                  <small className="muted">
                    Bill numbers will look like{" "}
                    <span className="settings-sample mono">
                      {form.invoiceNumbering === "financial_year" ? `${form.invoicePrefix}/${yearTag()}/0001` : `${form.invoicePrefix}-0001`}
                    </span>{" "}
                    {form.invoiceNumbering === "financial_year" ? "and start again at 0001 on 1 April." : "and carry on from the last one."}{" "}
                    Letters, digits, - and / only.
                  </small>
                </label>

                <label className="field">
                  <span>Numbering</span>
                  <select
                    value={form.invoiceNumbering || "continuous"}
                    onChange={change("invoiceNumbering")}
                    disabled={!canEdit}
                  >
                    <option value="continuous">One series that never restarts</option>
                    <option value="financial_year">Start again each financial year</option>
                  </select>
                  <small className="muted">
                    {form.invoiceNumbering === "financial_year"
                      ? "The year goes in the number (by the business date), for the main counter, each outlet and the credit notes. Prefixes can then be 4 characters at most, to stay within GST's 16."
                      : "Bills already printed keep their numbers whichever you choose."}
                  </small>
                </label>

                {series.length > 1 && (
                  <div className="field-wide invoice-series">
                    <span className="invoice-series-title">Bill numbers at each till</span>
                    <small className="muted">
                      GST allows an invoice number of 16 characters at most. An outlet with no prefix of its own numbers
                      under one worked out from its code; set its own on the Outlets page.
                    </small>
                    <ul>
                      {series.map((row) => (
                        <li key={row.outletId ?? "main"}>
                          <span className="invoice-series-name">
                            {row.name}
                            {row.status !== "active" ? <span className="muted"> · closed</span> : null}
                          </span>
                          <span className="settings-sample mono">{row.example}</span>
                          <span className="small muted invoice-series-note">
                            {row.outletId === null
                              ? "Restaurant prefix"
                              : row.derived
                                ? "From the outlet's code"
                                : "The outlet's own prefix"}
                            {row.sharedWith.length > 0 ? ` · shares its numbering with ${row.sharedWith.join(", ")}` : ""}
                            {row.hasOwnGstin && row.derived ? " · has its own GSTIN: give it a prefix of its own" : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <label className="checkbox field-wide settings-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(form.autoConsumeStock)}
                    onChange={(event) => setForm({ ...form, autoConsumeStock: event.target.checked })}
                    disabled={!canEdit}
                  />
                  <span>Take recipe ingredients out of stock automatically when a bill is made</span>
                </label>
              </div>
            </SectionCard>

            <SectionCard
              id="settings-upi"
              icon="wallet"
              tone="success"
              title="UPI payments"
              description="Guests scan a QR code for the exact amount due, printed on the bill and shown on the payment screen. The cashier still records the payment with its UTR."
            >
              <div className="form-grid">
                <FormField label="UPI ID" optional hint="The UPI ID money is paid to (name@bank). Empty: no QR codes.">
                  <input
                    className="mono"
                    value={form.upiVpa || ""}
                    onChange={change("upiVpa")}
                    maxLength={100}
                    placeholder="kirancafe@okhdfcbank"
                    disabled={!canEdit}
                  />
                </FormField>

                <FormField label="Name the guest sees" optional hint="An outlet that banks on its own sets its own on the Outlets page.">
                  <input
                    value={form.upiPayeeName || ""}
                    onChange={change("upiPayeeName")}
                    maxLength={100}
                    placeholder="Kiran Cafe"
                    disabled={!canEdit}
                  />
                </FormField>
              </div>
            </SectionCard>

            <SectionCard
              id="settings-loyalty"
              icon="gift"
              tone="violet"
              title="Loyalty"
              description="Points guests earn when they pay, and spend on a later bill."
            >
              <div className="form-grid">
                {/* On or off is the Loyalty points feature; the rules stay here. */}
                <p className="field-wide muted small settings-feature-note">
                  <Icon name={form.loyaltyEnabled ? "check-circle" : "info"} size={15} />{" "}
                  Loyalty points are <strong>{form.loyaltyEnabled ? "on" : "off"}</strong>. Switch them on or off in{" "}
                  <Link to={FEATURES_PATH}>Settings → Features</Link>; the rules below apply whenever they are on.
                </p>

                <label className="field">
                  <span>Spend per point</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={form.loyaltyEarnAmount ?? 100}
                    onChange={change("loyaltyEarnAmount")}
                    disabled={!canEdit}
                  />
                  <small className="muted">
                    {form.currencySymbol}
                    {form.loyaltyEarnAmount || 100} spent earns 1 point
                  </small>
                </label>

                <label className="field">
                  <span>Point value</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.loyaltyPointValue ?? 1}
                    onChange={change("loyaltyPointValue")}
                    disabled={!canEdit}
                  />
                  <small className="muted">
                    1 point comes off a bill as {form.currencySymbol}
                    {form.loyaltyPointValue || 1}
                  </small>
                </label>

                <label className="field">
                  <span>Minimum points to redeem</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={form.loyaltyMinRedeem ?? 50}
                    onChange={change("loyaltyMinRedeem")}
                    disabled={!canEdit}
                  />
                  <small className="muted">Stops guests spending 2 points at a time</small>
                </label>
              </div>
            </SectionCard>

            <SectionCard
              id="settings-printing"
              icon="print"
              tone="neutral"
              title="Printing"
              description="How the bill comes out of the printer. Every print is counted; copies after the first say DUPLICATE."
            >
              <div className="form-grid">
                <label className="field">
                  <span>Paper</span>
                  <select value={form.printPaperWidth || "80mm"} onChange={change("printPaperWidth")} disabled={!canEdit}>
                    <option value="58mm">58 mm thermal</option>
                    <option value="80mm">80 mm thermal</option>
                    <option value="a4">A4 invoice</option>
                  </select>
                  <small className="muted">What the receipt is laid out for</small>
                </label>

                <label className="field">
                  <span>Copies</span>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={form.printCopies ?? 1}
                    onChange={change("printCopies")}
                    disabled={!canEdit}
                  />
                  <small className="muted">Two is usual where a copy stays with the kitchen</small>
                </label>

                <FormField
                  label="Bill header"
                  optional
                  wide
                  hint="A line under the restaurant name; the address and phone come from Restaurant profile"
                >
                  <input
                    value={form.billHeader || ""}
                    onChange={change("billHeader")}
                    maxLength={200}
                    placeholder="Pure veg · Since 1998"
                    disabled={!canEdit}
                  />
                </FormField>

                <FormField id="settings-logo" label="Receipt logo URL" optional wide hint="A square or wide logo shown above the restaurant name.">
                  <input value={form.receiptLogoPath || ""} onChange={change("receiptLogoPath")} maxLength={500} placeholder="https://…/logo.png" disabled={!canEdit} />
                </FormField>

                <label className="field">
                  <span>Document type</span>
                  <select value={form.documentType || "auto"} onChange={change("documentType")} disabled={!canEdit}>
                    <option value="auto">Automatic</option>
                    <option value="tax_invoice">Tax Invoice</option>
                    <option value="bill_of_supply">Bill of Supply</option>
                  </select>
                </label>

                <label className="field">
                  <span>Composition rate (%)</span>
                  <input type="number" min="0" max="100" step="0.01" value={form.compositionPercentage ?? ""} onChange={change("compositionPercentage")} disabled={!canEdit || form.documentType !== "bill_of_supply"} />
                </label>

                <FormField label="Composition declaration" optional wide>
                  <input value={form.compositionNote || ""} onChange={change("compositionNote")} maxLength={200} placeholder="Composition taxable person, not eligible to collect tax" disabled={!canEdit || form.documentType !== "bill_of_supply"} />
                </FormField>

                <FormField label="Bill footer" optional wide hint="Printed at the bottom of the receipt">
                  <input
                    value={form.billFooter || ""}
                    onChange={change("billFooter")}
                    maxLength={200}
                    placeholder="Thank you, please visit again"
                    disabled={!canEdit}
                  />
                </FormField>

                <label className="checkbox field-wide settings-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(form.autoPrintBill)}
                    onChange={(event) => setForm({ ...form, autoPrintBill: event.target.checked })}
                    disabled={!canEdit}
                  />
                  <span>Print the receipt by itself when a bill that was never printed is paid</span>
                </label>

                <label className="checkbox field-wide settings-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(form.printShowQr)}
                    onChange={(event) => setForm({ ...form, printShowQr: event.target.checked })}
                    disabled={!canEdit}
                  />
                  <span>
                    Print the table&apos;s ordering QR code on dine-in bills{" "}
                    <small className="muted">(menu, call staff, feedback — 58 mm, 80 mm and A4)</small>
                  </span>
                </label>
              </div>
            </SectionCard>

            {form.rules && (
              <AlertRulesCard
                rules={form.rules}
                onChange={(rules) => setForm({ ...form, rules })}
                canEdit={canEdit}
                currency={form.currencySymbol || "₹"}
              />
            )}

            {/* Beside the Save button, where the eye is when it is pressed. */}
            <ErrorMessage message={error} />
            <SuccessMessage message={dirty ? "" : success} />

            <SettingsSaveBar
              dirty={dirty}
              saving={saving}
              savedAt={savedAt}
              disabled={!canEdit}
              saveLabel="Save settings"
              onReset={() => setForm(saved)}
            />
          </form>

          {limits && (
            <SectionCard
              as="form"
              id="settings-discounts"
              onSubmit={saveLimits}
              icon="shield"
              tone="warning"
              title="Discounts at the till"
              description="The most each role may take off a bill on its own. Above that, someone allowed more approves with their PIN. Staff without the discount permission always need a manager. Saved on its own."
            >
              <ErrorMessage message={limitsError} />
              <SuccessMessage message={limitsSuccess} />
              {limits.length === 0 ? (
                <p className="muted">No role may give discounts yet. Give a role “Give an on-the-spot discount at the till” under Roles.</p>
              ) : (
                <div className="discount-limits">
                  {limits.map((role) => (
                    <div key={role.id} className="discount-limit">
                      <span className="discount-limit-name">
                        <strong>{role.name}</strong>
                        <span className="small muted">
                          {role.people} {role.people === 1 ? "person" : "people"}
                          {role.custom ? " · your own role" : ""}
                        </span>
                      </span>
                      <span className="discount-limit-input">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.5"
                          aria-label={`Most ${role.name} may take off, %`}
                          placeholder="No cap"
                          value={limitDraft[role.id] ?? ""}
                          onChange={(event) => setLimitDraft({ ...limitDraft, [role.id]: event.target.value })}
                          disabled={!canEdit}
                        />
                        <span className="muted">% off</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {canEdit && limits.length > 0 && (
                <div className="form-actions">
                  <button type="submit" className="button button-secondary" disabled={savingLimits}>
                    {savingLimits ? "Saving…" : "Save discount limits"}
                  </button>
                </div>
              )}
            </SectionCard>
          )}

          <PaymentTypesCard canEdit={canEdit} />
      </SettingsLayout>
    </div>
  );
}
