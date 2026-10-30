import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import FormField from "../../../components/FormField";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import useAuth from "../../../hooks/useAuth";
import { getErrorMessage } from "../../../services/api";
import { gstinHint } from "../../../services/guestBook";
import { mobileHint } from "../../../services/phone";
import { formatLabel } from "../../../services/restaurantFormats";
import SiteLayout from "../SiteLayout";
import { signUp } from "../services/site.service";
import { savedRef, useSiteInfo, useSitePricing } from "../useSite";
import { addonsFor, needsWords, plusGst, priceLabel, priceSummary, refFrom, startLabel, toggleAddon, trialWords, typeGroups } from "../siteWords.js";

// Signing up (/signup): an owner registers themselves and their business,
// chooses a plan, and starts a free trial, signed in at once. The type, plan
// and period of the pricing page's link come filled in. What it comes to
// after the trial is summed up beside the form as it is chosen.

const formOf = (params) => ({
  name: "", mobile: "", email: "", password: "",
  businessName: "", type: params.get("type") || "", format: "restaurant", city: "", stateCode: "", gstin: "",
  planCode: params.get("plan") || "", billingPeriod: params.get("period") === "year" ? "year" : "month", addons: [],
  acceptedTerms: false, website: "",
});

const KINDS = [["module", "Modules you can add"], ["application", "Applications you can add"]];

export default function SignupPage() {
  const { user, acceptSession } = useAuth();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [params] = useSearchParams();
  const { data: info } = useSiteInfo();
  const { data: pricing, error: loadError } = useSitePricing();
  const [form, setForm] = useState(() => formOf(params));
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const groups = typeGroups(pricing?.types || []);
  const type = (pricing?.types || []).find((item) => item.code === form.type) || null;
  const plans = type?.plans || [];
  const plan = plans.find((item) => item.code === form.planCode) || plans.find((item) => item.isDefault) || plans[0] || null;
  const offered = addonsFor(type, plan);
  const chosen = offered.filter((addon) => form.addons.includes(addon.code));
  const trialDays = info ? info.trialDays : null;
  const heading = trialDays === 0 ? "Sign up" : "Start a free trial";

  const set = (key) => (event) => {
    const { type: kind, checked, value } = event.target;
    setForm((current) => ({ ...current, [key]: kind === "checkbox" ? checked : value }));
  };
  const chooseType = (event) => {
    const code = event.target.value;
    const next = (pricing?.types || []).find((item) => item.code === code);
    const base = next?.plans.find((item) => item.isDefault) || next?.plans[0];
    setForm((current) => ({ ...current, type: code, planCode: base ? base.code : "", addons: [], format: "restaurant" }));
  };
  const choosePlan = (code) => {
    const next = plans.find((item) => item.code === code);
    const still = addonsFor(type, next).map((addon) => addon.code);
    setForm((current) => ({ ...current, planCode: code, addons: current.addons.filter((addon) => still.includes(addon)) }));
  };
  const toggle = (code, on) => setForm((current) => ({ ...current, addons: toggleAddon(current.addons, code, on, offered) }));
  const period = (billingPeriod) => setForm((current) => ({ ...current, billingPeriod }));

  const submit = async (event) => {
    event.preventDefault();
    setSending(true);
    setError("");

    try {
      const session = await signUp({
        owner: { name: form.name, mobile: form.mobile, email: form.email, password: form.password },
        business: {
          name: form.businessName, type: form.type, ...(form.type === "restaurant" ? { format: form.format } : {}),
          city: form.city, stateCode: form.stateCode, ...(form.gstin.trim() ? { gstin: form.gstin } : {}),
        },
        selection: { planCode: plan?.code, billingPeriod: form.billingPeriod, addons: chosen.map((addon) => addon.code) },
        ref: savedRef() || refFrom(search),
        acceptedTerms: form.acceptedTerms,
        website: form.website,
      });

      // A login that must finish two-step sign-in first signs in on the sign-in page.
      if (session.twoFactor) {
        navigate("/login", { replace: true });
        return;
      }

      acceptSession(session);
      navigate("/", { replace: true });
    } catch (failure) {
      setError(getErrorMessage(failure));
      setSending(false);
    }
  };

  const mobile = mobileHint(form.mobile);
  const gstin = gstinHint(form.gstin);
  const description = `Register yourself and your business, choose its plan${trialDays > 0 ? `, and use it free for ${trialWords(trialDays)}` : ""}. No payment details to start.`;

  if (user) {
    return (
      <SiteLayout title={heading} description={description}>
        <div className="site-wrap site-page site-narrow">
          <h1>{heading}</h1>
          <div className="card stack">
            <p>
              You are signed in as <strong>{user.name}</strong>. A business of your own is added from Your businesses, with Add a business; it starts a free trial of its own.
            </p>
            <p>
              <Link to="/" className="button">Open your business</Link>
            </p>
          </div>
        </div>
      </SiteLayout>
    );
  }

  return (
    <SiteLayout title={heading} description={description}>
      <div className="site-wrap site-page">
        <header className="site-page-head">
          <h1>{heading}</h1>
          <p className="site-lede">
            Register yourself and your business on one page.
            {trialDays > 0 ? ` It is free for ${trialWords(trialDays)}, with everything your type of business can use, and no payment details are asked for.` : ""}
            {" "}Already registered? <Link to="/login">Sign in</Link>.
          </p>
        </header>

        {loadError ? (
          <ErrorMessage message={getErrorMessage(loadError)} />
        ) : !pricing ? (
          <Loading label="Loading the plans…" />
        ) : (
          <form className="site-signup" onSubmit={submit} aria-busy={sending}>
            <div className="site-signup-form stack">
              <section className="card stack" aria-labelledby="you-heading">
                <h2 id="you-heading">About you</h2>
                <div className="form-grid">
                  <FormField label="Your name">
                    <input value={form.name} onChange={set("name")} autoComplete="name" maxLength={150} required />
                  </FormField>
                  <FormField label="Mobile" hint={mobile?.text}>
                    <input type="tel" value={form.mobile} onChange={set("mobile")} autoComplete="tel" inputMode="tel" maxLength={20} required placeholder="98765 43210" />
                  </FormField>
                  <FormField label="Email" hint="You sign in with your email or mobile number.">
                    <input type="email" value={form.email} onChange={set("email")} autoComplete="email" maxLength={150} required />
                  </FormField>
                  <FormField label="Password" hint="8 to 72 characters.">
                    <input type={showPassword ? "text" : "password"} value={form.password} onChange={set("password")} autoComplete="new-password" minLength={8} maxLength={72} required />
                  </FormField>
                  <label className="checkbox field-wide">
                    <input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} />
                    Show the password
                  </label>
                </div>
              </section>

              <section className="card stack" aria-labelledby="business-heading">
                <h2 id="business-heading">Your business</h2>
                <div className="form-grid">
                  <FormField label="Business name">
                    <input value={form.businessName} onChange={set("businessName")} autoComplete="organization" maxLength={150} required />
                  </FormField>
                  <FormField label="Type of business">
                    <select value={form.type} onChange={chooseType} required>
                      <option value="">Choose…</option>
                      {groups.map((group) => (
                        <optgroup key={group.title} label={group.title}>
                          {group.types.map((item) => (
                            <option key={item.code} value={item.code}>{item.name}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </FormField>
                  {type?.formats && (
                    <FormField label="Format" wide hint="A restaurant gets a login of its own: use an email and a mobile number that have no login yet.">
                      <select value={form.format} onChange={set("format")} required>
                        {type.formats.map((format) => (
                          <option key={format} value={format}>{formatLabel(format)}</option>
                        ))}
                      </select>
                    </FormField>
                  )}
                  <FormField label="City">
                    <input value={form.city} onChange={set("city")} autoComplete="address-level2" maxLength={100} required />
                  </FormField>
                  <FormField label="State" hint="Where the business is: the place of supply on our GST invoices.">
                    <select value={form.stateCode} onChange={set("stateCode")} required>
                      <option value="">Choose…</option>
                      {pricing.states.map((state) => (
                        <option key={state.code} value={state.code}>{state.name}</option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="GSTIN" optional wide hint={gstin ? gstin.text : "If the business is registered for GST, our invoices carry it."}>
                    <input value={form.gstin} onChange={set("gstin")} autoCapitalize="characters" spellCheck={false} maxLength={20} />
                  </FormField>
                </div>
              </section>

              <section className="card stack" aria-labelledby="plan-heading">
                <div className="site-plan-head">
                  <h2 id="plan-heading">Your plan</h2>
                  <div className="site-toggle" role="group" aria-label="Pay for">
                    <button type="button" aria-pressed={form.billingPeriod === "month"} onClick={() => period("month")}>Monthly</button>
                    <button type="button" aria-pressed={form.billingPeriod === "year"} onClick={() => period("year")}>Yearly</button>
                  </div>
                </div>
                {!type ? (
                  <p className="muted">Choose the type of your business to see its plan.</p>
                ) : !plan ? (
                  <p className="muted">No plan is offered for this type of business yet. Ask us to call you back.</p>
                ) : (
                  <>
                    <fieldset className="site-choices">
                      <legend className="sr-only">Plan</legend>
                      {plans.map((item) => (
                        <label key={item.code} className={`site-choice ${item.code === plan.code ? "is-chosen" : ""}`}>
                          <input type="radio" name="plan" value={item.code} checked={item.code === plan.code} onChange={() => choosePlan(item.code)} />
                          <span>
                            <strong>{item.name}</strong> · {priceLabel(item, form.billingPeriod)} {plusGst(pricing.gstRate)}
                            {item.modules.length > 0 && <small>Includes {item.modules.map((module) => module.name).join(", ")}.</small>}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    {KINDS.map(([kind, legend]) => {
                      const list = offered.filter((addon) => (kind === "application" ? addon.soldAs === "application" : addon.soldAs !== "application"));
                      return list.length === 0 ? null : (
                        <fieldset key={kind} className="site-choices">
                          <legend>{legend}</legend>
                          {list.map((addon) => (
                            <label key={addon.code} className={`site-choice ${form.addons.includes(addon.code) ? "is-chosen" : ""}`}>
                              <input type="checkbox" checked={form.addons.includes(addon.code)} onChange={(event) => toggle(addon.code, event.target.checked)} />
                              <span>
                                <strong>{addon.name}</strong> · {priceLabel(addon, form.billingPeriod)}
                                {addon.recommended && <span className="badge badge-info site-badge">Recommended</span>}
                                {(addon.description || needsWords(addon, offered)) && (
                                  <small>{[addon.description, needsWords(addon, offered) && `It ${needsWords(addon, offered)}.`].filter(Boolean).join(" ")}</small>
                                )}
                              </span>
                            </label>
                          ))}
                        </fieldset>
                      );
                    })}
                    {trialDays > 0 && (
                      <p className="small muted">
                        During the trial you can switch on anything your type of business has, chosen here or not. The plan and add-ons can be changed in Your plan until you pay.
                      </p>
                    )}
                  </>
                )}
              </section>
            </div>

            <aside className="site-signup-summary">
              <div className="card stack">
                <h2>What it comes to</h2>
                {type && plan ? (
                  <>
                    <ul className="site-summary-lines">
                      <li>
                        <span>{type.name}: {plan.name}</span>
                        <span>{priceLabel(plan, form.billingPeriod)}</span>
                      </li>
                      {chosen.map((addon) => (
                        <li key={addon.code}>
                          <span>{addon.name}</span>
                          <span>{priceLabel(addon, form.billingPeriod)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="site-summary" data-testid="price-summary">
                      {priceSummary({ plan, addons: chosen, billingPeriod: form.billingPeriod, trialDays: trialDays ?? 0, gstRate: pricing.gstRate })}
                    </p>
                  </>
                ) : (
                  <p className="muted">Choose the type of your business and its plan.</p>
                )}
                <div className="site-honeypot" aria-hidden="true">
                  <label>
                    Leave this empty
                    <input type="text" name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
                  </label>
                </div>
                <label className="checkbox site-consent">
                  <input type="checkbox" checked={form.acceptedTerms} onChange={set("acceptedTerms")} required />
                  <span>
                    I accept the <Link to="/terms" target="_blank">terms of service</Link> and the <Link to="/privacy-policy" target="_blank">privacy policy</Link>, and agree to be contacted about my account.
                  </span>
                </label>
                {error && (
                  <div className="alert" role="alert">
                    {error}
                    {/Sign in instead\.$/.test(error) && (
                      <>
                        {" "}
                        <Link to="/login">Sign in</Link>
                      </>
                    )}
                  </div>
                )}
                <button type="submit" className="button button-lg site-submit" disabled={sending}>
                  {sending && <span className="spinner spinner-inverse" aria-hidden="true" />}
                  {sending ? "Setting up your business…" : startLabel(trialDays === null ? 1 : trialDays)}
                </button>
                <p className="small muted">
                  <Icon name="lock" size={14} /> Your password is kept only in a form that cannot be read back.
                </p>
              </div>
            </aside>
          </form>
        )}
      </div>
    </SiteLayout>
  );
}
