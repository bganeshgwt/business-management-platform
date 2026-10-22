import { useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { setPin } from "../services/timeclock.service";
import "../styles/timeclock.css";

// Setting or resetting one person's time-clock PIN. The staff list and the
// time clock's PINs tab both open this, so the rules and the wording are the
// same wherever a manager does it.

const PIN_MIN = 4;
const PIN_MAX = 6;

// The easy guesses the server refuses too: repeats, runs and keypad lines.
const isWeakPin = (pin) =>
  /^(\d)\1+$/.test(pin) ||
  "01234567890".includes(pin) ||
  "09876543210".includes(pin) ||
  ["2580", "0852", "1212", "1122", "6969", "1004", "2000", "4321"].includes(pin);

// A four-digit PIN nobody could guess, and not the end of the person's mobile
// number (colleagues know that).
const suggestPin = (mobile) => {
  const tail = String(mobile || "").replace(/\D/g, "");
  const random = new Uint32Array(1);

  for (;;) {
    crypto.getRandomValues(random);
    const pin = String(random[0] % 10000).padStart(4, "0");

    if (!isWeakPin(pin) && !(tail.length >= 4 && tail.endsWith(pin))) {
      return pin;
    }
  }
};

const firstNameOf = (name) => String(name || "").trim().split(/\s+/)[0] || "them";

// row: { id, name, hasPin, mobile? } — the employee whose PIN this is.
export default function ClockPinModal({ row, onClose, onSaved }) {
  const [pin, setPinValue] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const firstName = row.firstName || firstNameOf(row.name);
  const digits = (value) => value.replace(/\D/g, "").slice(0, PIN_MAX);
  const lengthOk = pin.length >= PIN_MIN && pin.length <= PIN_MAX;
  const matches = lengthOk && pin === again;
  const strong = lengthOk && !isWeakPin(pin);

  const suggest = () => {
    const next = suggestPin(row.mobile);
    setPinValue(next);
    setAgain(next);
    setShow(true);
    setError("");
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const result = await setPin(row.id, { pin, confirmPin: again });
      onSaved(`${result.message}. Tell ${firstName} in person — it is never shown again.`);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${row.hasPin ? "Reset" : "Set"} clock PIN — ${row.name}`}
      description="For the time-clock tablet by the staff entrance."
      icon="key"
      onClose={onClose}
      width={460}
    >
      <form className="stack" onSubmit={submit}>
        <p className="muted small">
          {row.hasPin
            ? `The old PIN stops working at once, and any lockout is lifted. Use this when ${firstName} has forgotten it or someone else may know it.`
            : `${firstName} types this at the tablet to clock in, take a break and clock out.`}
        </p>
        <ErrorMessage message={error} />
        <label className="field">
          New PIN
          <input
            className="tc-pin-input"
            type={show ? "text" : "password"}
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(event) => setPinValue(digits(event.target.value))}
            placeholder="4 to 6 digits"
            autoFocus
          />
        </label>
        <label className="field">
          Type it again
          <input
            className="tc-pin-input"
            type={show ? "text" : "password"}
            inputMode="numeric"
            autoComplete="new-password"
            value={again}
            onChange={(event) => setAgain(digits(event.target.value))}
            placeholder="Same PIN again"
          />
        </label>
        <div className="row-actions">
          <button type="button" className="chip-button" onClick={suggest}>
            <Icon name="sparkles" size={14} /> Suggest a PIN
          </button>
          <button type="button" className="chip-button" onClick={() => setShow((value) => !value)} aria-pressed={show}>
            <Icon name="eye" size={14} /> {show ? "Hide digits" : "Show digits"}
          </button>
        </div>
        <ul className="tc-checks">
          <li className={lengthOk ? "is-ok" : ""}>
            <Icon name="check" size={14} /> 4 to 6 digits
          </li>
          <li className={strong ? "is-ok" : ""}>
            <Icon name="check" size={14} /> Not easy to guess (no 1234, 0000 or 2580)
          </li>
          <li className={matches ? "is-ok" : ""}>
            <Icon name="check" size={14} /> Both entries match
          </li>
        </ul>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving || !lengthOk || !again}>
            {saving ? "Saving…" : row.hasPin ? "Reset PIN" : "Save PIN"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
