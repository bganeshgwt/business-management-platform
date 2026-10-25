import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/jewellery.css";

// Gold scheme plans: the schemes the shop offers, each so many monthly
// instalments (up to 11) from a smallest monthly amount, and the discount
// given on the jewellery bill that redeems a scheme with every instalment
// paid (a percentage of one instalment; the benefit is a discount, never
// interest). A plan's terms never change once made: a new plan is made for
// other terms, and an old one is switched off (its schemes run on).

const TERMS = (n) => `Pay the same amount every month for ${n} months. With every instalment paid, the scheme's discount is taken off your jewellery bill from the day the scheme matures. What you pay is used only on jewellery from this shop and is never paid back in money. The scheme is billed within 364 days of the first instalment.`;

function PlanForm({ biz, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ name: "", instalments: "11", minInstalment: "1000", discountPercent: "100", terms: TERMS(11), edited: false });
  const set = (name) => (e) => setForm((f) => {
    const next = { ...f, [name]: e.target.value };
    // The terms follow the number of months until they are written by hand.
    if (name === "instalments" && !f.edited) next.terms = TERMS(e.target.value || "so many");
    if (name === "terms") next.edited = true;
    return next;
  });
  const n = Number(form.instalments) || 0;
  const yearly = n ? (Number(form.discountPercent || 0) * 24 / (n * (n + 1))).toFixed(1) : "0.0";
  return (
    <FormDialog title="A new gold scheme plan" icon="calendar" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Make the plan" successMessage="Plan made."
      description="Its terms never change once it is made: make a new plan for other terms."
      onSubmit={() => businessWrite(biz.id, "jewellery/scheme-plans", { requestKey, name: form.name.trim(), instalments: form.instalments, minInstalment: form.minInstalment,
        discountPercent: form.discountPercent, terms: form.terms.trim() })}>
      <Field label="Name"><input required maxLength={80} value={form.name} onChange={set("name")} placeholder="e.g. Swarna 11" /></Field>
      <Field label="Monthly instalments" hint="2 to 11."><input required type="number" min="2" max="11" step="1" value={form.instalments} onChange={set("instalments")} /></Field>
      <Field label="Smallest monthly instalment (₹)" hint="In whole rupees; each customer chooses their amount from this."><input required type="number" min="100" step="1" value={form.minInstalment} onChange={set("minInstalment")} /></Field>
      <Field label="Discount (% of one instalment)" hint="Given on the jewellery bill with every instalment paid, from the scheme's maturity. 100: one month free.">
        <input required type="number" min="0" max="100" step="0.01" value={form.discountPercent} onChange={set("discountPercent")} />
      </Field>
      <p className="field-wide muted small">As a yearly figure on the money held: about {yearly}% a year.{Number(yearly) > 12 ? " The jewellery trade federation's guidance for companies' schemes (GJF, 2014) keeps the discount within 12% a year." : ""}</p>
      <Field label="Terms, as printed on the passbook" wide hint="Say discount, never interest.">
        <textarea required rows={6} maxLength={4000} value={form.terms} onChange={set("terms")} />
      </Field>
    </FormDialog>
  );
}

export default function SchemePlansPage() {
  const biz = useOpenBusiness();
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState("");
  const [making, setMaking] = useState(false);
  const [version, setVersion] = useState(0);
  const canChange = biz.can("jewellery.approve");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/scheme-plans", undefined, controller.signal).then((p) => { setPlans(p.items); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const toggle = async (plan) => {
    try {
      const next = await businessWrite(biz.id, `jewellery/scheme-plans/${plan.id}`, { active: !plan.active }, "put");
      setPlans(next.items);
      toast.success(plan.active ? `${plan.name} is switched off: no one new joins it.` : `${plan.name} is switched on.`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  if (!plans) return <div className="stack"><BusinessHeader icon="calendar" title="Gold scheme plans" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Gold scheme plans"
        description="The gold schemes the shop offers: up to 11 monthly instalments, and a discount on the jewellery bill when every instalment is paid. A plan's terms never change once made."
        primary={canChange && <button type="button" className="button" onClick={() => setMaking(true)}><Icon name="plus" size={16} /> A new plan</button>} />
      <ErrorMessage message={error} />
      <SectionCard icon="calendar" title="Plans">
        {plans.length === 0 ? <p className="jw-note">No plans yet{canChange ? ": make one with A new plan." : "."}</p> : (
          <table className="jw-rates">
            <thead><tr><th scope="col">Plan</th><th scope="col">Instalments</th><th scope="col">From</th><th scope="col">Discount</th><th scope="col">Schemes</th><th scope="col">On</th></tr></thead>
            <tbody>{plans.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.name}<details><summary className="muted small">Terms</summary><pre className="jw-terms">{p.terms}</pre></details></th>
                <td>{p.instalments} months</td>
                <td>{biz.exact(p.min_instalment)} a month</td>
                <td>{Number(p.discount_percent)}% of one instalment<small className={Number(p.yearly_rate) > 12 ? "bz-minus" : "muted"}> · about {p.yearly_rate}% a year</small></td>
                <td>{p.open_schemes} open · {p.schemes} in all</td>
                <td>{canChange ? <button type="button" className="chip-button" onClick={() => toggle(p)}>{p.active ? "Switch off" : "Switch on"}</button> : <ActiveBadge active={p.active} />}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <p className="jw-note">A scheme's money is turned into jewellery within the year: each scheme is billed by its day 364, and is never paid back in money. The jewellery trade federation's guidance for companies' schemes (GJF, 2014) also keeps the discount within 12% a year.</p>
      </SectionCard>
      {making && <PlanForm biz={biz} onClose={() => setMaking(false)} onSaved={() => { setMaking(false); setVersion((n) => n + 1); }} />}
    </div>
  );
}
