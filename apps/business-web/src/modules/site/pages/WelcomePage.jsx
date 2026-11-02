import { Fragment, useId, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import { motionAllowed } from "../../../components/motion";
import { TYPE_ICONS } from "../../../services/businessNav";
import SiteLayout from "../SiteLayout";
import CallBackForm from "../CallBackForm";
import { useSiteInfo, useSitePricing } from "../useSite";
import {
  catalogueSize, homeQuestions, lowestAddon, lowestPlan, plusGst, priceLabel, startLabel, trialWords, typeGroups, typeLine, yearlySaving,
} from "../siteWords.js";
import HeroStage from "../welcome/HeroStage";
import TileArt from "../welcome/TileArt";
import { usePauseOffscreen, useReveal, useSpotlight } from "../welcome/pageMotion";
import "../welcome/welcome.css";

// The platform's home page (/welcome), where a visitor at the bare address
// lands: what the platform does, on a moving tour of its screens; the kinds
// of business it serves, in the product overview's groups; what every
// business gets; how pricing works, with today's prices and the free trial;
// the questions people ask; and the ways in: a free trial, signing in, or a
// call back. Every price, count and number of days comes from the site's API.

// What every business gets: the shared core (PRODUCT_OVERVIEW.md "The shared core").
const EVERY_BUSINESS = [
  { key: "bill", icon: "receipt", title: "Billing with GST", text: "GST invoices and till receipts, paid by cash, UPI, card or on credit; returns and refunds each with their own number." },
  { key: "money", icon: "wallet", title: "Daily money", text: "Takings by method, person and counter matched with the cash, and expenses with their reasons." },
  { key: "stock", icon: "box", title: "Stock with a history", text: "Stock by branch and batch, transfers between branches, and counts approved before stock changes." },
  { key: "staff", icon: "shield", title: "Staff and access", text: "A login for each person, with the role, branch and department you choose, PIN approvals and an activity log." },
  { key: "reports", icon: "chart", title: "Reports", text: "Money by day, branches side by side, what is owed, and every list exported." },
  { key: "buy", icon: "truck", title: "Buying", text: "Supplier bills with free quantity and discount, purchase orders and supplier payments." },
  { key: "dues", icon: "users", title: "Customers and dues", text: "What each customer owes, its ageing, reminders and numbered collection receipts." },
  { key: "data", icon: "lock", title: "Your customers' data", text: "Consent to messages, requests to see or erase data, and the breach register, as the DPDP Act asks." },
];

// The applications a group's types can add (the captain app, the kitchen
// display, the laboratory …), each once.
const appsOf = (types) => [
  ...new Map(types.flatMap((type) => (type.addons || []).filter((addon) => addon.soldAs === "application" && addon.available)).map((addon) => [addon.code, addon])).values(),
];

// Each group's mark, beside its name.
const GROUP_ICONS = {
  Food: "utensils", Shops: "store", Trade: "truck", "Speciality retail": "tag", "Building and farm": "layers",
  "Vehicles and fuel": "fire", Services: "sparkles", Stays: "home", Health: "heart", "Weight-based": "scale",
};

// Points of light drifting up through the hero: where each starts across it,
// its size, how long it takes, when it sets off and how far it sways.
const SPARKS = [
  { x: "6%", size: 3, time: 16, wait: 0, sway: 24 }, { x: "14%", size: 2, time: 21, wait: 6, sway: -18 },
  { x: "23%", size: 4, time: 18, wait: 11, sway: 30 }, { x: "37%", size: 2, time: 23, wait: 3, sway: -26 },
  { x: "48%", size: 3, time: 17, wait: 9, sway: 18 }, { x: "57%", size: 2, time: 20, wait: 14, sway: -14 },
  { x: "66%", size: 4, time: 19, wait: 1, sway: 22 }, { x: "74%", size: 2, time: 24, wait: 8, sway: -30 },
  { x: "82%", size: 3, time: 15, wait: 12, sway: 16 }, { x: "91%", size: 2, time: 22, wait: 5, sway: -20 },
];

function Backdrop() {
  return (
    <div className="wl-backdrop" aria-hidden="true">
      <span className="wl-aurora wl-aurora-a" />
      <span className="wl-aurora wl-aurora-b" />
      <span className="wl-aurora wl-aurora-c" />
      <span className="wl-beam" />
      <span className="wl-grid" />
      {SPARKS.map((spark) => (
        <span
          key={spark.x}
          className="wl-spark"
          style={{ "--x": spark.x, "--size": `${spark.size}px`, "--time": `${spark.time}s`, "--wait": `${spark.wait}s`, "--sway": `${spark.sway}px` }}
        />
      ))}
      <span className="wl-noise" />
    </div>
  );
}

// Words that rise in one after another; `from` is the first one's place in the heading.
function Words({ text, from }) {
  return text.split(" ").map((word, index) => (
    <Fragment key={index}>
      {index > 0 && " "}
      <span className="wl-word" style={{ "--w": from + index }}>{word}</span>
    </Fragment>
  ));
}

// The stroke drawn under "your business".
function Swoosh() {
  const ink = `wl-ink-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg className="wl-swoosh" viewBox="0 0 320 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={ink} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="0.55" stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#fcd34d" />
        </linearGradient>
      </defs>
      <path d="M5 17 C 72 7, 172 3, 315 10" pathLength="1" stroke={`url(#${ink})`} />
    </svg>
  );
}

// Every type the price list offers, drifting past in two rows; the types
// themselves, with links, are listed in the next section.
function TypeRibbon({ types }) {
  if (!types.length) return null;
  const half = Math.ceil(types.length / 2);

  return (
    <div className="wl-ribbon">
      <p className="wl-ribbon-label">{types.length} kinds of business, one platform</p>
      {[types.slice(0, half), types.slice(half)].map((row, index) => (
        <div key={index} className={`wl-marquee${index ? " is-reverse" : ""}`} aria-hidden="true">
          <div className="wl-marquee-track" style={{ "--marquee-time": `${row.length * 6}s` }}>
            {[0, 1].map((copy) =>
              row.map((type) => (
                <span key={`${copy}-${type.code}`} className={`wl-chip${copy ? " is-copy" : ""}`}>
                  <span className="wl-chip-icon"><Icon name={TYPE_ICONS[type.code] || "store"} size={16} /></span>
                  {type.name}
                </span>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function WelcomePage() {
  const { data: info } = useSiteInfo();
  const { data: pricing } = useSitePricing();
  const navigate = useNavigate();
  const { search } = useLocation();
  const pageRef = useRef(null);
  const heroRef = useRef(null);
  const finalRef = useRef(null);
  useReveal(pageRef);
  useSpotlight(pageRef);
  usePauseOffscreen(heroRef);
  usePauseOffscreen(finalRef);

  const trialDays = info ? info.trialDays : null;
  const trial = trialDays > 0;
  const types = pricing?.types || [];
  const lowest = lowestPlan(pricing);
  const addon = lowestAddon(pricing);
  const modules = catalogueSize(pricing);
  const saving = yearlySaving(lowest);
  const start = startLabel(info ? trialDays : 1);
  const gst = plusGst(pricing?.gstRate);
  const support = [info?.support?.phone || info?.company?.phone, info?.support?.email || info?.company?.email].filter(Boolean);

  // A link to the call-back form glides down to it where motion is welcome
  // (otherwise the browser jumps there); the address keeps its query and
  // says #call-back, as the plain link would.
  const toCallBack = (event) => {
    const form = document.getElementById("call-back");
    if (!form || !motionAllowed()) return;
    event.preventDefault();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    navigate({ search, hash: "call-back" }, { preventScrollReset: true });
  };

  return (
    <SiteLayout
      title={null}
      description={`Billing with GST, stock, customers, staff and daily money for restaurants, shops, clinics and more, in one login.${trial ? ` Free for ${trialWords(trialDays)}.` : ""}`}
      overHero
    >
      <div ref={pageRef} className="wl">
        <section ref={heroRef} className="site-hero wl-hero" aria-labelledby="hero-heading">
          <Backdrop />
          <div className="wl-wrap wl-hero-grid">
            <div className="wl-hero-copy">
              {trial && (
                <p className="site-eyebrow wl-eyebrow">
                  <span className="wl-eyebrow-dot" aria-hidden="true" />
                  Free for {trialWords(trialDays)}
                </p>
              )}
              <h1 id="hero-heading" className="wl-title">
                <Words text="Billing, stock, staff and" from={0} />{" "}
                <span className="wl-title-glow"><Words text="daily money" from={4} /></span>{" "}
                <Words text="for" from={6} />{" "}
                <span className="wl-title-mark">
                  <Words text="your business" from={7} />
                  <Swoosh />
                </span>
              </h1>
              <p className="wl-lede">
                One login for restaurants and cafés, shops and wholesalers, salons, clinics{types.length ? ` and ${types.length} kinds of business in all` : " and many more kinds of business"}. Each
                gets the screens and rules of its own trade, on a computer, tablet or phone.
              </p>
              <div className="wl-actions">
                <Link to="/signup" className="button button-lg wl-cta">
                  <span className="wl-cta-shine" aria-hidden="true" />
                  {start}
                  <Icon name="arrow-right" size={18} />
                </Link>
                <Link to="/login" className="button button-lg button-secondary wl-glass">Sign in</Link>
                <a href="#call-back" className="button button-lg button-ghost wl-ghost" onClick={toCallBack}>
                  <Icon name="phone" size={17} />
                  Request a call back
                </a>
              </div>
              <ul className="wl-proof">
                {trial && (
                  <li style={{ "--i": 0 }}><Icon name="check" size={14} strokeWidth={3} />Everything your type of business can use</li>
                )}
                {trial && (
                  <li style={{ "--i": 1 }}><Icon name="check" size={14} strokeWidth={3} />No payment details to start</li>
                )}
                <li style={{ "--i": 2 }}><Icon name="check" size={14} strokeWidth={3} />On a computer, tablet or phone</li>
              </ul>
            </div>
            <HeroStage types={types} />
          </div>
          <TypeRibbon types={types} />
        </section>

        <section className="wl-section wl-section-types" aria-labelledby="types-heading">
          <div className="wl-wrap">
            <header className="wl-head" data-reveal>
              <p className="wl-kicker"><Icon name="store" size={14} />For your trade</p>
              <h2 id="types-heading">Made for your kind of business</h2>
              <p className="wl-sub">Every business gets the shared tools below; each type adds what is its own.</p>
            </header>
            <div className="wl-groups" data-spotlight-area>
              {typeGroups(types).map((group) => {
                const apps = appsOf(group.types);
                return (
                  <article key={group.title} className={`wl-group wl-spot${group.types.length > 2 ? " is-wide" : ""}`} data-reveal data-spotlight>
                    <span className="wl-group-mark" aria-hidden="true"><Icon name={GROUP_ICONS[group.title] || "box"} size={150} strokeWidth={1.2} /></span>
                    <header className="wl-group-head">
                      <span className="wl-group-icon" aria-hidden="true"><Icon name={GROUP_ICONS[group.title] || "box"} size={20} /></span>
                      <h3>{group.title}</h3>
                      <span className="wl-group-count">{group.types.length === 1 ? "1 kind" : `${group.types.length} kinds`}</span>
                    </header>
                    <ul className="wl-types">
                      {group.types.map((type) => (
                        <li key={type.code} className="wl-type">
                          <span className="wl-type-icon" aria-hidden="true"><Icon name={TYPE_ICONS[type.code] || "store"} size={17} /></span>
                          <span className="wl-type-body">
                            <Link to={`/pricing?type=${type.code}`} className="wl-type-name">{type.name}</Link>
                            <small>{typeLine(type.code)}</small>
                          </span>
                          <span className="wl-type-go" aria-hidden="true"><Icon name="arrow-right" size={16} /></span>
                        </li>
                      ))}
                    </ul>
                    {apps.length > 0 && (
                      <div className="wl-group-apps">
                        <span>Apps to add</span>
                        <ul>
                          {apps.map((app) => <li key={app.code}>{app.name}</li>)}
                        </ul>
                      </div>
                    )}
                  </article>
                );
              })}
              {types.length > 0 && (
                <article className="wl-group wl-group-ask" data-reveal>
                  <span className="wl-group-icon" aria-hidden="true"><Icon name="help" size={20} /></span>
                  <h3>Not sure which fits?</h3>
                  <p>Tell us how your business works, and we will call you to show you the screens of your trade and the plan that fits it.</p>
                  <div className="wl-group-ask-actions">
                    <a href="#call-back" className="button wl-cta" onClick={toCallBack}>
                      <span className="wl-cta-shine" aria-hidden="true" />
                      Request a call back
                    </a>
                    <Link to="/pricing" className="button button-secondary wl-glass">See the prices</Link>
                  </div>
                </article>
              )}
            </div>
          </div>
        </section>

        <section className="wl-section wl-section-tint" aria-labelledby="every-heading">
          <div className="wl-wrap">
            <header className="wl-head" data-reveal>
              <p className="wl-kicker"><Icon name="layers" size={14} />The shared core</p>
              <h2 id="every-heading">What every business gets</h2>
              <p className="wl-sub">Built once and shared, so a fix reaches every type of business at the same time.</p>
            </header>
            <ul className="wl-bento" data-spotlight-area>
              {EVERY_BUSINESS.map((item) => (
                <li key={item.key} className={`wl-tile wl-spot is-${item.key}`} data-reveal data-spotlight>
                  <div className="wl-tile-art" aria-hidden="true"><TileArt kind={item.key} /></div>
                  <div className="wl-tile-words">
                    <h3><Icon name={item.icon} size={17} />{item.title}</h3>
                    <p>{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="wl-section wl-section-pricing" aria-labelledby="pricing-heading">
          <div className="wl-wrap">
            <header className="wl-head is-centred" data-reveal>
              <p className="wl-kicker"><Icon name="rupee" size={14} />Pricing</p>
              <h2 id="pricing-heading">How pricing works</h2>
              <p className="wl-sub">
                {lowest && pricing ? `Plans from ${priceLabel(lowest, "month")} ${gst}, for each business. ` : ""}Pay monthly or yearly, and add only the modules you use.
              </p>
            </header>
            <ul className="wl-stats">
              {trial && (
                <li className="wl-stat" data-reveal>
                  <span className="wl-stat-label">Free trial</span>
                  <strong>{trialWords(trialDays)}</strong>
                  <span className="wl-stat-note">With everything your type of business can use</span>
                </li>
              )}
              {lowest && (
                <li className="wl-stat" data-reveal>
                  <span className="wl-stat-label">Plans from</span>
                  <strong>{money(lowest.monthly)}<small> a month</small></strong>
                  <span className="wl-stat-note">{gst}, for each business</span>
                </li>
              )}
              {modules > 0 && (
                <li className="wl-stat" data-reveal>
                  <span className="wl-stat-label">To choose from</span>
                  <strong>{modules}</strong>
                  <span className="wl-stat-note">Modules and applications</span>
                </li>
              )}
              {addon && (
                <li className="wl-stat" data-reveal>
                  <span className="wl-stat-label">Add-ons from</span>
                  <strong>{money(addon.monthly)}<small> a month</small></strong>
                  <span className="wl-stat-note">Each module or application you add</span>
                </li>
              )}
            </ul>
            <ol className="wl-steps" data-reveal>
              <li className="wl-step">
                <span className="wl-step-mark" aria-hidden="true">1</span>
                <h3>{trial ? `Start free for ${trialWords(trialDays)}` : "Sign up"}</h3>
                <p>
                  {trial
                    ? "Register yourself and your business. Everything your type of business can use is unlocked for the trial."
                    : "Register yourself and your business, and choose your plan. Your business opens once your first payment is confirmed."}
                </p>
              </li>
              <li className="wl-step">
                <span className="wl-step-mark" aria-hidden="true">2</span>
                <h3>Choose your plan</h3>
                <p>Each type of business has its plan. Add the modules and applications you need, and pay monthly or yearly, for each business.</p>
              </li>
              <li className="wl-step">
                <span className="wl-step-mark" aria-hidden="true">3</span>
                <h3>Pay and carry on</h3>
                <p>Pay by UPI or bank transfer and enter the reference. Your business carries on as soon as we confirm it, with our GST invoice.</p>
              </li>
            </ol>
            <div className="wl-pricing-cta" data-reveal>
              <Link to="/pricing" className="button button-lg wl-solid">
                See the prices
                <Icon name="arrow-right" size={18} />
              </Link>
              {lowest && saving > 0 && (
                <p className="wl-saving">
                  <Icon name="percent" size={15} />
                  Or {priceLabel(lowest, "year")}: {saving}% less than paying by the month
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="wl-section wl-section-tint" aria-labelledby="questions-heading">
          <div className="wl-wrap wl-questions">
            <header className="wl-head" data-reveal>
              <p className="wl-kicker"><Icon name="help" size={14} />Questions</p>
              <h2 id="questions-heading">Good to know</h2>
              <p className="wl-sub">What owners ask before they start. Anything else, <a href="#call-back" onClick={toCallBack}>ask us to call you</a>.</p>
            </header>
            <div className="wl-faq">
              {homeQuestions(info).map((item) => (
                <details key={item.question} className="wl-faq-item" data-reveal>
                  <summary>
                    <span>{item.question}</span>
                    <span className="wl-faq-mark" aria-hidden="true" />
                  </summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="wl-section" id="call-back" aria-labelledby="call-back-heading">
          <div className="wl-wrap wl-callback">
            <div className="wl-callback-panel" data-reveal>
              <p className="wl-kicker is-on-dark"><Icon name="phone" size={14} />Talk to us</p>
              <h2 id="call-back-heading">Request a call back</h2>
              <p className="wl-callback-lede">Tell us about your business and we will call you to show you around and answer your questions.</p>
              <ul className="wl-callback-points">
                <li><Icon name="check" size={15} strokeWidth={3} />The screens of your type of business, shown on the call</li>
                <li><Icon name="check" size={15} strokeWidth={3} />Help choosing your plan and its add-ons</li>
                <li><Icon name="check" size={15} strokeWidth={3} />Answers on billing, GST, stock and staff</li>
              </ul>
              {support.length > 0 && <p className="wl-callback-reach">{support.join(" · ")}</p>}
            </div>
            <div className="card wl-callback-card" data-reveal>
              <CallBackForm info={info} types={types} />
            </div>
          </div>
        </section>

        <section ref={finalRef} className="wl-final" aria-labelledby="final-heading">
          <div className="wl-backdrop" aria-hidden="true">
            <span className="wl-aurora wl-aurora-a" />
            <span className="wl-aurora wl-aurora-b" />
            <span className="wl-grid" />
          </div>
          <div className="wl-wrap" data-reveal>
            <h2 id="final-heading">
              {trial ? (
                <>
                  Start free for <span className="wl-final-glow">{trialWords(trialDays)}</span>
                </>
              ) : (
                "Run your business on one platform"
              )}
            </h2>
            <p>
              {trial
                ? "One page to sign up, and you are signed in at once, in your own business. Choose your plan whenever you are ready."
                : "One page to sign up, with your plan. Your business opens as soon as your first payment is confirmed."}
            </p>
            <div className="wl-final-actions">
              <Link to="/signup" className="button button-lg wl-cta">
                <span className="wl-cta-shine" aria-hidden="true" />
                {start}
                <Icon name="arrow-right" size={18} />
              </Link>
              <Link to="/pricing" className="button button-lg button-secondary wl-glass">See the prices</Link>
            </div>
          </div>
        </section>
      </div>
    </SiteLayout>
  );
}
