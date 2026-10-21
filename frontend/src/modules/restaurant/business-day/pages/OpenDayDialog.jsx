import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { openBusinessDay, reopenBusinessDay } from "../services/businessDay.service";
import { getErrorMessage } from "../../../../services/api";
import useAuth from "../../../../hooks/useAuth";
import useShake from "../../../../hooks/useShake";
import { dateText } from "./moneyText";
// The day dialogs' own styles, wherever they open (the dashboard too).
import "../../../../styles/billing.css";
import "../../../../styles/cash.css";
import { forgetBusinessDay } from "./staleDayStatus";

// The time now, as the till shows it ("2:45 pm"), kept current while the dialog is open.
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Opening the business day: the date (today, or last night's before the
// morning cut-off) and the cash counted into the drawer. The same dialog on
// the Business day page and the dashboard. `opening` is the status's
// { dates, taken, suggested, today, cutoffHour }. One business day per date:
// when every date that may be opened was opened and closed already, the
// dialog offers to reopen the latest one (with a reason) instead.
// onOpened(day, { reopened }) once the day is open.
export default function OpenDayDialog({ opening, currency, initialDate, onClose, onOpened }) {
  const { hasPermission } = useAuth();
  const allowed = opening.dates;
  const isTaken = (date) => opening.taken.some((row) => row.date === date);
  const free = allowed.filter((date) => !isTaken(date));
  // Every date is used: the latest closed one may be opened again.
  const closedDay = free.length ? null
    : [...opening.taken].filter((row) => row.dayStatus === "closed").sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  const canReopen = hasPermission("business_day.close");
  const time = useClock();
  const [form, setForm] = useState({ businessDate: initialDate || opening.suggested || free[0] || opening.today || "", cash: "", notes: "", reason: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [formRef, shakeForm] = useShake();
  const takenToday = opening.taken.find((row) => row.date === opening.today);

  const refuse = (message) => { setError(message); shakeForm(); };

  const submit = async (event) => {
    event.preventDefault();
    setError("");

    if (closedDay) {
      if (!canReopen) return refuse("Ask a manager to reopen the day.");
      if (!form.reason.trim()) return refuse("Say why the day is being opened again.");
    } else {
      if (!allowed.includes(form.businessDate)) {
        return refuse(allowed.length > 1
          ? `Open today's day (${dateText(allowed[1])}) or last night's (${dateText(allowed[0])}).`
          : `Only today's business day (${dateText(allowed[0])}) can be opened.`);
      }
      if (isTaken(form.businessDate)) return refuse(`${dateText(form.businessDate)} was opened already. Pick the other date.`);
      if (form.cash === "" || Number(form.cash) < 0) return refuse("Count the opening cash into the drawer and enter it (0 if it starts empty).");
    }

    setSaving(true);

    try {
      const day = closedDay
        ? await reopenBusinessDay(closedDay.id, form.reason.trim())
        : await openBusinessDay({
          businessDate: form.businessDate,
          openingCash: Math.round(Number(form.cash) * 100) / 100,
          notes: form.notes.trim() || null,
        });
      forgetBusinessDay();
      onOpened(day, { reopened: Boolean(closedDay) });
    } catch (err) {
      refuse(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={closedDay ? "Reopen business day" : "Open business day"}
      icon="sun"
      description={closedDay ? "Today's day was closed already. Reopen it to keep taking orders on it." : "Orders and payments from now on count towards this day."}
      onClose={onClose}
      width={480}
    >
      <form className="form-grid bd-form" onSubmit={submit} noValidate ref={formRef}>
        {closedDay ? (
          <>
            <div className="field-wide bd-open-when">
              <Icon name="calendar" size={18} />
              <span>
                <strong>{dateText(closedDay.date, { weekday: true })}</strong>
                <small className="muted">Closed already · one business day per date · now {time}</small>
              </span>
            </div>
            <label className="field field-wide">
              <span>Why open it again?</span>
              <textarea
                rows={2}
                maxLength={300}
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
                placeholder="Closed by mistake before the last table paid"
                autoFocus
              />
              <small className="muted">
                {canReopen ? "Its count is cleared and counted again at the next close. The reason goes in the activity log." : "Only a manager who may close the day can reopen it."}
              </small>
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span>Business date</span>
              <span className="bd-date">
                <Icon name="calendar" size={16} />
                <input
                  type="date"
                  value={form.businessDate}
                  min={allowed[0]}
                  max={allowed[allowed.length - 1]}
                  onChange={(event) => setForm({ ...form, businessDate: event.target.value })}
                  onClick={(event) => event.currentTarget.showPicker?.()}
                  required
                />
              </span>
              <small className="muted">
                Opens at <strong>{time}</strong> (now).{" "}
                {allowed.length > 1
                  ? `Today, or last night's day until ${opening.cutoffHour}:00 this morning (it ran past midnight).`
                  : "Today, on the restaurant's clock."}
              </small>
            </label>

            <label className="field">
              <span>Opening cash ({currency})</span>
              <span className="bd-cash">
                <span className="bd-cash-symbol" aria-hidden="true">
                  {currency}
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={form.cash}
                  onChange={(event) => setForm({ ...form, cash: event.target.value })}
                  placeholder="Count the float"
                  autoFocus
                />
              </span>
              <small className="muted">Cash in the drawer before service starts (0 if it starts empty)</small>
            </label>

            {takenToday && (
              <p className="field-wide small muted">
                Today&apos;s day was opened already, so last night&apos;s is offered.
              </p>
            )}

            <label className="field field-wide">
              <span>Notes (optional)</span>
              <textarea
                rows={2}
                value={form.notes}
                maxLength={500}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                placeholder="Anything the next shift should know"
              />
            </label>
          </>
        )}

        <ErrorMessage message={error} />

        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving || (closedDay && !canReopen)}>
            {saving ? (closedDay ? "Reopening…" : "Opening…") : closedDay ? "Reopen day" : "Open day"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
