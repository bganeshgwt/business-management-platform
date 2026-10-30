import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { TYPE_ICONS } from "../../../services/businessNav";
import SiteLayout from "../SiteLayout";
import CallBackForm from "../CallBackForm";
import { useSiteInfo, useSitePricing } from "../useSite";
import { plusGst, priceLabel, startLabel, trialWords, typeGroups, typeLine } from "../siteWords.js";

// The platform's home page (/welcome), where a visitor at the bare address
// lands: what the platform does for each kind of business it serves, in the
// product overview's groups, what every business gets, how its pricing works
// with today's prices and the free trial, and the ways in: a free trial,
// signing in, or a call back.

// What every business gets: the shared core (PRODUCT_OVERVIEW.md "The shared core").
const EVERY_BUSINESS = [
  { icon: "receipt", title: "Billing with GST", text: "GST invoices and till receipts, paid by cash, UPI, card or on credit; returns and refunds each with their own number." },
  { icon: "box", title: "Stock with a history", text: "Stock by branch and batch, transfers between branches, and counts approved before stock changes." },
  { icon: "truck", title: "Buying", text: "Supplier bills with free quantity and discount, purchase orders and supplier payments." },
  { icon: "users", title: "Customers and dues", text: "What each customer owes, its ageing, reminders and numbered collection receipts." },
  { icon: "wallet", title: "Daily money", text: "Takings by method, person and counter matched with the cash, and expenses with their reasons." },
  { icon: "shield", title: "Staff and access", text: "A login for each person, with the role, branch and department you choose, PIN approvals and an activity log." },
  { icon: "chart", title: "Reports", text: "Money by day, branches side by side, what is owed, and every list exported." },
  { icon: "lock", title: "Your customers' data", text: "Consent to messages, requests to see or erase data, and the breach register, as the DPDP Act asks." },
];

// The lowest monthly price of a type's default plan: "Plans from ₹499 a month".
function lowestPlan(pricing) {
  const plans = (pricing?.types || []).flatMap((type) => type.plans.filter((plan) => plan.isDefault && plan.monthly !== null));
  return plans.reduce((low, plan) => (!low || Number(plan.monthly) < Number(low.monthly) ? plan : low), null);
}

export default function WelcomePage() {
  const { data: info } = useSiteInfo();
  const { data: pricing } = useSitePricing();
  const trialDays = info ? info.trialDays : null;
  const trial = trialDays > 0;
  const types = pricing?.types || [];
  const lowest = lowestPlan(pricing);

  return (
    <SiteLayout
      title={null}
      description={`Billing with GST, stock, customers, staff and daily money for restaurants, shops, clinics and more, in one login.${trial ? ` Free for ${trialWords(trialDays)}.` : ""}`}
    >
      <section className="site-hero">
        <div className="site-wrap site-hero-inner">
          {trial && <p className="site-eyebrow">Free for {trialWords(trialDays)}</p>}
          <h1>Billing, stock, staff and daily money for your business</h1>
          <p className="site-lede">
            One login for restaurants and cafés, shops and wholesalers, salons, clinics{types.length ? ` and ${types.length} kinds of business in all` : " and many more kinds of business"}. Each
            gets the screens and rules of its own trade, on a computer, tablet or phone.
          </p>
          <div className="site-actions">
            <Link to="/signup" className="button button-lg">{startLabel(info ? trialDays : 1)}</Link>
            <Link to="/login" className="button button-lg button-secondary">Sign in</Link>
            <a href="#call-back" className="button button-lg button-ghost site-hero-ghost">Request a call back</a>
          </div>
          {trial && (
            <p className="site-hero-note">
              <Icon name="check" size={16} /> The first {trialWords(trialDays)} are free, with everything your type of business can use. No payment details to start.
            </p>
          )}
        </div>
      </section>

      <section className="site-section" aria-labelledby="types-heading">
        <div className="site-wrap">
          <div className="site-section-head">
            <h2 id="types-heading">Made for your kind of business</h2>
            <p className="muted">Every business gets the shared tools below; each type adds what is its own.</p>
          </div>
          <div className="site-groups">
            {typeGroups(types).map((group) => (
              <div key={group.title} className="site-group">
                <h3>{group.title}</h3>
                <ul>
                  {group.types.map((type) => (
                    <li key={type.code} className="site-type">
                      <span className="site-type-icon" aria-hidden="true">
                        <Icon name={TYPE_ICONS[type.code] || "store"} size={18} />
                      </span>
                      <span>
                        <Link to={`/pricing?type=${type.code}`} className="site-type-name">{type.name}</Link>
                        <small>{typeLine(type.code)}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="site-section site-section-alt" aria-labelledby="every-heading">
        <div className="site-wrap">
          <div className="site-section-head">
            <h2 id="every-heading">What every business gets</h2>
            <p className="muted">Built once and shared, so a fix reaches every type of business at the same time.</p>
          </div>
          <ul className="site-features">
            {EVERY_BUSINESS.map((item) => (
              <li key={item.title} className="site-feature">
                <span className="site-feature-icon" aria-hidden="true">
                  <Icon name={item.icon} size={18} />
                </span>
                <strong>{item.title}</strong>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="site-section" aria-labelledby="pricing-heading">
        <div className="site-wrap">
          <div className="site-section-head">
            <h2 id="pricing-heading">How pricing works</h2>
            {lowest && pricing && (
              <p className="muted">
                Plans from {priceLabel(lowest, "month")} {plusGst(pricing.gstRate)}, for each business.
              </p>
            )}
          </div>
          <ol className="site-steps">
            <li className="site-step">
              <strong>{trial ? `Start free for ${trialWords(trialDays)}` : "Sign up"}</strong>
              <span>
                {trial
                  ? "Register yourself and your business. Everything your type of business can use is unlocked for the trial."
                  : "Register yourself and your business, and choose your plan. Your business opens once your first payment is confirmed."}
              </span>
            </li>
            <li className="site-step">
              <strong>Choose your plan</strong>
              <span>Each type of business has its plan. Add the modules and applications you need, and pay monthly or yearly, for each business.</span>
            </li>
            <li className="site-step">
              <strong>Pay and carry on</strong>
              <span>Pay by UPI or bank transfer and enter the reference. Your business carries on as soon as we confirm it, with our GST invoice.</span>
            </li>
          </ol>
          <p>
            <Link to="/pricing" className="button button-secondary">
              See the prices <Icon name="arrow-right" size={16} />
            </Link>
          </p>
        </div>
      </section>

      <section className="site-section site-section-alt" id="call-back" aria-labelledby="call-back-heading">
        <div className="site-wrap site-callback">
          <div className="site-section-head">
            <h2 id="call-back-heading">Request a call back</h2>
            <p className="muted">Tell us about your business and we will call you to show you around and answer your questions.</p>
          </div>
          <div className="card">
            <CallBackForm info={info} types={types} />
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}
