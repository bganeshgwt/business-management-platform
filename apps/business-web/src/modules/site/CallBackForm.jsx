import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import FormField from "../../components/FormField";
import { getErrorMessage } from "../../services/api";
import { mobileHint } from "../../services/phone";
import { requestCallBack } from "./services/site.service";
import { savedRef } from "./useSite";
import { refFrom, typeGroups } from "./siteWords.js";

// The request to be called back, on the home page and the contact page. It
// says beside the box the person ticks what is collected and why; the lead it
// makes keeps where they came from (the link's ref).

const EMPTY = { name: "", mobile: "", email: "", businessType: "", city: "", message: "", consent: false, website: "" };

export default function CallBackForm({ info, types = [] }) {
  const [form, setForm] = useState(EMPTY);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const set = (key) => (event) => {
    const { type, checked, value } = event.target;
    setForm((current) => ({ ...current, [key]: type === "checkbox" ? checked : value }));
  };
  const hint = mobileHint(form.mobile);
  const brand = info?.brandName || "the platform";

  const submit = async (event) => {
    event.preventDefault();
    setSending(true);
    setError("");

    try {
      await requestCallBack({ ...form, ref: savedRef() || refFrom(window.location.search) });
      setSent(true);
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="site-sent" role="status">
        <span className="site-sent-mark" aria-hidden="true">
          <Icon name="check" size={22} />
        </span>
        <div>
          <p className="site-sent-title">Thank you, we will call you.</p>
          <p className="muted">We call on the mobile number you gave{form.email ? `, or write to ${form.email}` : ""}.</p>
        </div>
      </div>
    );
  }

  return (
    <form className="site-form" onSubmit={submit} aria-busy={sending}>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <div className="form-grid">
        <FormField label="Your name">
          <input value={form.name} onChange={set("name")} autoComplete="name" maxLength={150} required />
        </FormField>
        <FormField label="Mobile" hint={hint?.text}>
          <input type="tel" value={form.mobile} onChange={set("mobile")} autoComplete="tel" inputMode="tel" maxLength={20} required placeholder="98765 43210" />
        </FormField>
        <FormField label="Email" optional>
          <input type="email" value={form.email} onChange={set("email")} autoComplete="email" maxLength={150} />
        </FormField>
        <FormField label="Type of business" optional>
          <select value={form.businessType} onChange={set("businessType")}>
            <option value="">Not sure yet</option>
            {typeGroups(types).map((group) => (
              <optgroup key={group.title} label={group.title}>
                {group.types.map((type) => (
                  <option key={type.code} value={type.code}>{type.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </FormField>
        <FormField label="City" optional>
          <input value={form.city} onChange={set("city")} autoComplete="address-level2" maxLength={100} />
        </FormField>
        <FormField label="What should we know?" optional wide hint="Your business, its branches, what you use today: anything that helps the call.">
          <textarea value={form.message} onChange={set("message")} rows={3} maxLength={1000} />
        </FormField>
        <div className="site-honeypot" aria-hidden="true">
          <label>
            Leave this empty
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
          </label>
        </div>
        <label className="checkbox field-wide site-consent">
          <input type="checkbox" checked={form.consent} onChange={set("consent")} required />
          <span>
            I agree to be contacted about {brand} at this number and email. <Link to="/privacy-policy">Privacy policy</Link>
          </span>
        </label>
        <div className="form-actions">
          <button type="submit" className="button" disabled={sending}>
            {sending && <span className="spinner spinner-inverse" aria-hidden="true" />}
            {sending ? "Sending…" : "Request a call back"}
          </button>
        </div>
      </div>
    </form>
  );
}
