import { moneyExact } from "../../../../services/format";
import { NOTES, notesTotal } from "./cashMath";

// A drawer counted note by note or as one typed total. The figure a count
// gives is `value` (a string, so an empty box stays empty: an empty count is
// refused, never read as ₹0).
//
//   method   "notes" | "total"
//   notes    { 500: "3", 100: "12", coins: "35.50" }
//   refused  draws the box in the error colour after a refused count
//   message  says why, right under the box
export default function CashCount({
  countRef,
  currency, value, onChange, method, onMethod, notes, onNotes, refused = false, label = "Cash counted in the drawer", autoFocus = false, message = "",
}) {
  const setNote = (key, next) => {
    const all = { ...notes, [key]: next };
    const total = notesTotal(all);

    onNotes(all);
    // Nothing counted yet stays empty, not "0".
    onChange(Object.values(all).some((item) => String(item).trim() !== "") ? String(total) : "");
  };

  return (
    <div className={`cash-count field-wide ${refused ? "is-refused" : ""}`} ref={countRef}>
      <div className="cash-count-head">
        <span>{label}</span>
        <div className="segmented" role="radiogroup" aria-label="How the cash is counted">
          <button
            type="button"
            role="radio"
            aria-checked={method === "notes"}
            className={`segment ${method === "notes" ? "is-active" : ""}`}
            onClick={() => onMethod("notes")}
          >
            Note by note
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={method === "total"}
            className={`segment ${method === "total" ? "is-active" : ""}`}
            onClick={() => onMethod("total")}
          >
            Type the total
          </button>
        </div>
      </div>

      {method === "notes" ? (
        <>
          <div className="cash-count-notes">
            {NOTES.map((note, index) => (
              <label key={note} className="bd-count-row">
                <span className="bd-count-note">
                  {currency}
                  {note}
                </span>
                <span className="muted small" aria-hidden="true">
                  ×
                </span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  aria-label={`Number of ${currency}${note} notes`}
                  value={notes[note] ?? ""}
                  onChange={(event) => setNote(note, event.target.value)}
                  placeholder="0"
                  autoFocus={autoFocus && index === 0}
                />
              </label>
            ))}
            <label className="bd-count-row">
              <span className="bd-count-note">Coins</span>
              <span className="muted small" aria-hidden="true">
                {currency}
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                aria-label="Coins, total value"
                value={notes.coins ?? ""}
                onChange={(event) => setNote("coins", event.target.value)}
                placeholder="0"
              />
            </label>
          </div>
          <div className="cash-count-total" aria-live="polite">
            <span className="muted">Counted</span>
            <strong>{value === "" ? "—" : moneyExact(value, currency)}</strong>
          </div>
        </>
      ) : (
        <label className="field">
          <span className="sr-only">{label}</span>
          <span className="bd-cash">
            <span className="bd-cash-symbol" aria-hidden="true">
              {currency}
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              aria-label={label}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder="Count the drawer"
              autoFocus={autoFocus}
            />
          </span>
        </label>
      )}
      {message && (
        <small className="cash-count-error" role="alert">
          {message}
        </small>
      )}
    </div>
  );
}
