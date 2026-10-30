import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { TYPE_ICONS } from "../../../services/businessNav";
import SiteLayout from "../SiteLayout";
import { useSiteInfo, useSitePricing } from "../useSite";
import { addonsFor, gstPercent, periodWords, plusGst, priceLabel, priceOf, startLabel, trialWords, typeGroups, typeLine } from "../siteWords.js";

// The platform's prices (/pricing): each business type's plans, and the
// modules and applications an owner can add, monthly or yearly, before GST,
// with the free trial before the first payment. The type and the period are
// in the address, so a link can open the prices of one type.

// What a year saves against twelve months: "₹989 less than paying monthly".
function yearSaving(plan) {
  const monthly = priceOf(plan, "month");
  const yearly = priceOf(plan, "year");
  if (monthly === null || yearly === null) return null;
  const saved = Math.round(Number(monthly) * 1200) - Math.round(Number(yearly) * 100);
  return saved > 0 ? `${money(saved / 100)} less than paying monthly` : null;
}

function Price({ item, period }) {
  const price = priceOf(item, period);
  if (price === null) return <p className="site-price">Price not set yet</p>;
  return (
    <p className="site-price">
      <strong>{Number(price) === 0 ? "Free" : money(price)}</strong> {Number(price) === 0 ? null : periodWords(period)}
    </p>
  );
}

export default function PricingPage() {
  const { data: info } = useSiteInfo();
  const { data: pricing, error } = useSitePricing();
  const [params, setParams] = useSearchParams();
  const [period, setPeriod] = useState(params.get("period") === "year" ? "year" : "month");
  const groups = typeGroups(pricing?.types || []);
  const types = groups.flatMap((group) => group.types);
  const type = types.find((item) => item.code === params.get("type")) || types[0];
  const plans = type?.plans || [];
  const basePlan = plans.find((plan) => plan.isDefault) || plans[0];
  const addons = addonsFor(type, basePlan);
  const trialDays = info ? info.trialDays : null;

  const choose = (code) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("type", code);
      return next;
    }, { replace: true });

  const signupLink = (plan) => `/signup?type=${type.code}${plan ? `&plan=${plan.code}` : ""}&period=${period}`;

  return (
    <SiteLayout title="Pricing" description="Each type of business's plan, monthly or yearly, and the modules and applications you can add to it. Prices before GST.">
      <div className="site-wrap site-page">
        <header className="site-page-head">
          <h1>Pricing</h1>
          <p className="site-lede">
            Each business pays for itself: the plan for its type, and the modules and applications you add, monthly or yearly.
            {pricing ? ` Prices are before GST; GST at ${gstPercent(pricing.gstRate)} is added.` : ""}
          </p>
          {trialDays > 0 && (
            <p className="site-trial-note">
              <Icon name="sparkles" size={16} /> Free for {trialWords(trialDays)}, with everything your type of business can use. No payment details to start.
            </p>
          )}
        </header>

        {error ? (
          <ErrorMessage message={getErrorMessage(error)} />
        ) : !pricing ? (
          <Loading label="Loading the prices…" />
        ) : (
          <>
            <div className="site-controls">
              <label className="field site-type-picker">
                <span>Your type of business</span>
                <select value={type?.code || ""} onChange={(event) => choose(event.target.value)}>
                  {groups.map((group) => (
                    <optgroup key={group.title} label={group.title}>
                      {group.types.map((item) => (
                        <option key={item.code} value={item.code}>{item.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <div className="site-toggle" role="group" aria-label="Pay for">
                <button type="button" aria-pressed={period === "month"} onClick={() => setPeriod("month")}>Monthly</button>
                <button type="button" aria-pressed={period === "year"} onClick={() => setPeriod("year")}>Yearly</button>
              </div>
            </div>

            {type && (
              <section className="site-type-prices" aria-labelledby="type-heading">
                <div className="site-type-head">
                  <span className="site-type-icon" aria-hidden="true">
                    <Icon name={TYPE_ICONS[type.code] || "store"} size={20} />
                  </span>
                  <div>
                    <h2 id="type-heading">{type.name}</h2>
                    <p className="muted">{typeLine(type.code)}</p>
                    {type.formats && <p className="muted small">You choose its format when you sign up.</p>}
                  </div>
                </div>

                {plans.length === 0 ? (
                  <p className="muted">No plan is offered for this type of business yet. Ask us to call you back.</p>
                ) : (
                  <div className="site-plans">
                    {plans.map((plan) => (
                      <article key={plan.code} className="card site-plan">
                        <h3>{plan.name}</h3>
                        {plan.description && <p className="muted">{plan.description}</p>}
                        <Price item={plan} period={period} />
                        <p className="small muted">{plusGst(pricing.gstRate)}{period === "year" && yearSaving(plan) ? ` · ${yearSaving(plan)}` : ""}</p>
                        {plan.modules.length > 0 && (
                          <>
                            <p className="site-plan-includes">Includes</p>
                            <ul className="site-checklist">
                              {plan.modules.map((module) => (
                                <li key={module.code}>
                                  <Icon name="check" size={15} /> {module.name}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <Link to={signupLink(plan)} className="button site-plan-start">{startLabel(trialDays === null ? 1 : trialDays)}</Link>
                      </article>
                    ))}
                  </div>
                )}

                {addons.length > 0 && (
                  <div className="site-addons">
                    {[["module", "Modules you can add"], ["application", "Applications you can add"]].map(([kind, heading]) => {
                      const list = addons.filter((addon) => (kind === "application" ? addon.soldAs === "application" : addon.soldAs !== "application"));
                      return list.length === 0 ? null : (
                        <div key={kind} className="site-addon-group">
                          <h3>{heading}</h3>
                          <ul>
                            {list.map((addon) => (
                              <li key={addon.code} className="site-addon">
                                <span>
                                  <strong>{addon.name}</strong>
                                  {addon.recommended && <span className="badge badge-info site-badge">Recommended</span>}
                                  {addon.description && <small>{addon.description}</small>}
                                </span>
                                <span className="site-addon-price">{priceLabel(addon, period)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                    <p className="small muted">Add-on prices are before GST and are added to the plan. Anything not listed here can be asked for.</p>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </SiteLayout>
  );
}
