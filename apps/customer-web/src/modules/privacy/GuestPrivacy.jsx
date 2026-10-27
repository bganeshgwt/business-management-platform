import "./privacy.css";

// The restaurant's privacy notice, shown wherever the guests' site takes a
// guest's name and number: one line on what the details are for and whom to
// ask, with the whole notice a tap away. `privacy` is the menu's or booking
// page's own ({ id, version, notice, billsText, offersText, contact }), null
// while the restaurant has published none.
export function PrivacyNote({ privacy, restaurantName, purpose }) {
  if (!privacy) return null;
  return (
    <details className="gp-note">
      <summary>
        {purpose} {restaurantName ? `${restaurantName}'s` : "The restaurant's"} privacy notice says how your details are used
        {privacy.contact ? `; ask ${privacy.contact} about them.` : "."}
      </summary>
      <pre className="gp-notice">{privacy.notice}</pre>
    </details>
  );
}

// What a guest may agree to as they order: their bill on WhatsApp, and offers.
// Each is a yes of its own, given on the notice's line for it; leaving both
// unticked is fine. `value` is the list ticked.
export function GuestConsents({ privacy, value, onChange }) {
  if (!privacy) return null;
  const toggle = (purpose) => onChange(value.includes(purpose) ? value.filter((p) => p !== purpose) : [...value, purpose]);
  return (
    <fieldset className="gp-consents">
      <legend>If you like <em>optional</em></legend>
      <label className="gp-consent">
        <input type="checkbox" checked={value.includes("bills_digital")} onChange={() => toggle("bills_digital")} />
        <span>{privacy.billsText}</span>
      </label>
      <label className="gp-consent">
        <input type="checkbox" checked={value.includes("offers")} onChange={() => toggle("offers")} />
        <span>{privacy.offersText}</span>
      </label>
    </fieldset>
  );
}

// The details this phone keeps for next time (name, mobile, address), and a
// way to forget them.
export function ForgetDetails({ onForget, what = "your name and mobile" }) {
  return (
    <p className="gp-forget">
      This phone keeps {what} for your next order.{" "}
      <button type="button" className="gp-link" onClick={onForget}>Forget them on this phone</button>
    </p>
  );
}
