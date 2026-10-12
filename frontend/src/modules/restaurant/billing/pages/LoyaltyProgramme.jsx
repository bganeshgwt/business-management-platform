import { useEffect, useState } from "react";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { getLoyaltyProgramme, saveLoyaltyRules } from "../../crm/services/loyalty.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money, moneyExact } from "../../../../services/format";
import useShake from "../../../../hooks/useShake";

// The rules as the form holds them: text boxes, where empty means "no limit"
// or "never".
const toForm = (rules) => ({
  enabled: rules.enabled,
  earnAmount: String(rules.earnAmount),
  earnBasis: rules.earnBasis,
  pointValue: String(rules.pointValue),
  minRedeem: String(rules.minRedeem),
  maxRedeemPoints: rules.maxRedeemPoints === null ? "" : String(rules.maxRedeemPoints),
  maxRedeemPercent: rules.maxRedeemPercent === null ? "" : String(rules.maxRedeemPercent),
  expiryDays: rules.expiryDays === null ? "" : String(rules.expiryDays),
});

const blankOr = (value) => (String(value).trim() === "" ? null : Number(value));

// What the rules mean for a guest, in one paragraph, worked out as typed.
const explain = (form, currency) => {
  const earn = Number(form.earnAmount);
  const value = Number(form.pointValue);

  if (!form.enabled) {
    return "Points are switched off: bills earn nothing and the till takes no points. Points guests already hold stay on their record.";
  }

  if (!(earn > 0) || !(value > 0)) {
    return "Enter the spend for one point and what a point is worth.";
  }

  const bill = 1000;
  const base = form.earnBasis === "pre_tax" ? bill : bill * 1.05;
  const points = Math.floor(base / earn + 1e-9);
  const parts = [
    form.earnBasis === "pre_tax"
      ? `A ${moneyExact(bill, currency)} meal earns ${points} point${points === 1 ? "" : "s"} (on the food, not the GST on it)`
      : `A ${moneyExact(bill, currency)} meal with 5% GST (${moneyExact(base, currency)}) earns ${points} point${points === 1 ? "" : "s"}`,
    `worth ${moneyExact(points * value, currency)} off a later bill.`,
  ];
  const limits = [];

  if (String(form.maxRedeemPoints).trim() !== "") {
    limits.push(`${form.maxRedeemPoints} points`);
  }

  if (String(form.maxRedeemPercent).trim() !== "") {
    limits.push(`${form.maxRedeemPercent}% of the bill`);
  }

  const sentences = [parts.join(", ")];
  sentences.push(limits.length ? `One bill can use at most ${limits.join(" or ")}, whichever is less.` : "One bill can use as many points as the guest has, up to the food's value.");
  sentences.push(
    String(form.expiryDays).trim() !== ""
      ? `Points not used within ${form.expiryDays} days of being earned run out, oldest first.`
      : "Points never run out."
  );

  return sentences.join(" ");
};

// The loyalty programme on Discounts & offers: what the points guests hold
// are worth, how they moved, and the rules they are earned and used by.
export default function LoyaltyProgramme({ currency, canEdit }) {
  const [programme, setProgramme] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [formRef, shake] = useShake();

  useEffect(() => {
    getLoyaltyProgramme()
      .then((data) => {
        setProgramme(data);
        setForm(toForm(data.rules));
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  if (!programme || !form) {
    return error ? <ErrorMessage message={error} /> : <Loading label="Loading the points programme…" />;
  }

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const s = programme.summary;
  const expiryWasOff = programme.rules.expiryDays === null;

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);

    try {
      const saved = await saveLoyaltyRules({
        earnAmount: Number(form.earnAmount),
        earnBasis: form.earnBasis,
        pointValue: Number(form.pointValue),
        minRedeem: Number(form.minRedeem || 0),
        maxRedeemPoints: blankOr(form.maxRedeemPoints),
        maxRedeemPercent: blankOr(form.maxRedeemPercent),
        expiryDays: blankOr(form.expiryDays),
      });
      setProgramme(saved);
      setForm(toForm(saved.rules));
      setSuccess("Loyalty rules saved. The till uses them from the next bill.");
    } catch (err) {
      setError(getErrorMessage(err));
      shake();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatTile
          icon="star"
          tone="primary"
          size="sm"
          label="Points guests hold"
          value={count(s.pointsHeld)}
          note={`Worth ${money(s.valueHeld, currency)} off future bills`}
        />
        <StatTile icon="users" tone="info" size="sm" label="Guests with points" value={count(s.holders)} note="Holding at least one point" />
        <StatTile
          icon="trend-up"
          tone="success"
          size="sm"
          label="Earned, last 30 days"
          value={count(s.last30.earned)}
          note={`${count(s.last30.redeemed)} used · ${count(s.last30.expired)} expired`}
        />
        <StatTile
          icon="clock"
          tone={s.expiringIn30Days.points > 0 ? "warning" : "neutral"}
          size="sm"
          label="Running out in 30 days"
          value={count(s.expiringIn30Days.points)}
          note={
            programme.rules.expiryDays === null
              ? "Points do not expire"
              : `${count(s.expiringIn30Days.guests)} guest${s.expiringIn30Days.guests === 1 ? "" : "s"} could be reminded`
          }
        />
      </div>

      <SectionCard
        icon="gift"
        title="How points work"
        description={
          canEdit
            ? "Earned when a bill is paid, used at the till, taken back when a bill is refunded. Changes apply from the next bill."
            : "Earned when a bill is paid, used at the till, taken back when a bill is refunded. The owner sets these rules."
        }
        as="form"
        onSubmit={submit}
        noValidate
        flush
      >
        <fieldset className="loyalty-rules" disabled={!canEdit} ref={formRef}>
          {/* On or off is the Loyalty points feature (Settings -> Features). */}

          <p className="section-heading">Earning</p>

          <label className="field">
            <span>Spend for one point ({currency}) *</span>
            <input type="number" min="1" step="1" value={form.earnAmount} onChange={set("earnAmount")} />
            <small className="muted">Every full amount spent earns one point.</small>
          </label>

          <div className="field">
            <span>Points are earned on</span>
            <div className="segmented" role="radiogroup" aria-label="Points are earned on">
              <button
                type="button"
                role="radio"
                aria-checked={form.earnBasis === "total"}
                className={`segment ${form.earnBasis === "total" ? "is-active" : ""}`}
                onClick={() => setForm({ ...form, earnBasis: "total" })}
              >
                Bill total
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={form.earnBasis === "pre_tax"}
                className={`segment ${form.earnBasis === "pre_tax" ? "is-active" : ""}`}
                onClick={() => setForm({ ...form, earnBasis: "pre_tax" })}
              >
                Food before tax
              </button>
            </div>
            <small className="muted">
              {form.earnBasis === "pre_tax"
                ? "The food after discounts, before GST and service charge: GST is not the guest's spend here."
                : "What the guest pays, GST and service charge included."}
            </small>
          </div>

          <p className="section-heading">Using points</p>

          <label className="field">
            <span>One point is worth ({currency}) *</span>
            <input type="number" min="0.01" step="0.01" value={form.pointValue} onChange={set("pointValue")} />
          </label>

          <label className="field">
            <span>Fewest points to use</span>
            <input type="number" min="0" step="1" value={form.minRedeem} onChange={set("minRedeem")} />
            <small className="muted">A guest with fewer cannot use them yet.</small>
          </label>

          <label className="field">
            <span>Most points on one bill</span>
            <input type="number" min="1" step="1" value={form.maxRedeemPoints} onChange={set("maxRedeemPoints")} placeholder="No limit" />
          </label>

          <label className="field">
            <span>Most of a bill points may pay (%)</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={form.maxRedeemPercent}
              onChange={set("maxRedeemPercent")}
              placeholder="No limit"
            />
            <small className="muted">So 800 points cannot eat an ₹855 dinner for ₹55.</small>
          </label>

          <p className="section-heading">Running out</p>

          <label className="field">
            <span>Points expire after (days)</span>
            <input type="number" min="1" max="3650" step="1" value={form.expiryDays} onChange={set("expiryDays")} placeholder="Never" />
            <small className="muted">
              {expiryWasOff && String(form.expiryDays).trim() !== ""
                ? "Points guests hold now get the whole period from today."
                : "Counted from the day each point was earned; the oldest are used first."}
            </small>
          </label>

          <p className="loyalty-example">
            <Icon name="info" size={16} />
            <span>{explain(form, currency)}</span>
          </p>

          {canEdit && (
            <div className="cash-rules-actions">
              <ErrorMessage message={error} />
              <SuccessMessage message={success} />
              <button type="submit" className="button" disabled={saving}>
                <Icon name="check" size={16} /> {saving ? "Saving…" : "Save rules"}
              </button>
            </div>
          )}
        </fieldset>
      </SectionCard>
    </div>
  );
}
