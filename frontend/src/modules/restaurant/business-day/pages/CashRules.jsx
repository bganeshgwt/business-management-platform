import { useState } from "react";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { saveCashRules } from "../services/businessDay.service";
import { getErrorMessage } from "../../../../services/api";
import { moneyExact } from "../../../../services/format";
import useShake from "../../../../hooks/useShake";

const HOURS = Array.from({ length: 13 }, (_, hour) => hour);

const hourWords = (hour) => (hour === 0 ? "Midnight (today's date only)" : hour === 12 ? "12 noon" : `${hour}:00 in the morning`);

// The rules the cash-up runs by: until when last night's day may still be
// opened, how far over or short a count may be without a reason, and whether
// the counter sees what the drawer should hold. Owners set them; everyone who
// runs the day can read them.
export default function CashRules({ rules, currency, canEdit, onSaved }) {
  const [form, setForm] = useState({
    cutoffHour: String(rules.cutoffHour),
    varianceThreshold: String(rules.varianceThreshold),
    blindCount: rules.blindCount,
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [formRef, shake] = useShake();

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");

    const threshold = Number(form.varianceThreshold);

    if (form.varianceThreshold === "" || !Number.isFinite(threshold) || threshold < 0) {
      setError("Enter the most a count may be over or short without a reason (0 means every rupee needs one).");
      shake();
      return;
    }

    setSaving(true);

    try {
      const saved = await saveCashRules({
        cutoffHour: Number(form.cutoffHour),
        varianceThreshold: Math.round(threshold * 100) / 100,
        blindCount: Boolean(form.blindCount),
      });
      setSuccess("Cash rules saved");
      onSaved(saved);
    } catch (err) {
      setError(getErrorMessage(err));
      shake();
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      icon="sliders"
      title="Cash rules"
      description={
        canEdit
          ? "How the day is opened and the drawer counted, for every till of the restaurant."
          : "How the day is opened and the drawer counted. The owner sets these."
      }
      as="form"
      onSubmit={submit}
      noValidate
      flush
    >
      <div className="cash-rules" ref={formRef}>
        <label className="field">
          <span>Last night&apos;s day may be opened until</span>
          <select
            value={form.cutoffHour}
            onChange={(event) => setForm({ ...form, cutoffHour: event.target.value })}
            disabled={!canEdit}
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {hourWords(hour)}
              </option>
            ))}
          </select>
          <small className="muted">
            Only today&apos;s business day can be opened. Until this hour, last night&apos;s too, for a night that ran past
            midnight before anyone opened it.
          </small>
        </label>

        <label className="field">
          <span>Over or short needing a reason ({currency})</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="decimal"
            value={form.varianceThreshold}
            onChange={(event) => setForm({ ...form, varianceThreshold: event.target.value })}
            disabled={!canEdit}
          />
          <small className="muted">
            A count more than {moneyExact(Number(form.varianceThreshold) || 0, currency)} out cannot close without saying
            why. It is written on the day and in the activity log.
          </small>
        </label>

        <label className="field">
          <span>Counting</span>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.blindCount)}
              onChange={(event) => setForm({ ...form, blindCount: event.target.checked })}
              disabled={!canEdit}
            />
            Blind count
          </label>
          <small className="muted">
            The cashier counts without seeing what the drawer should hold, so a count cannot be made to match. Managers who
            close the day still see it.
          </small>
        </label>

        {canEdit && (
          <div className="cash-rules-actions">
            <ErrorMessage message={error} />
            <SuccessMessage message={success} />
            <button type="submit" className="button" disabled={saving}>
              <Icon name="check" size={16} /> {saving ? "Saving…" : "Save rules"}
            </button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
