import { useId, useState } from "react";
import { addressProblem, mobileDigits, mobileProblem, nameProblem, pinProblem } from "./fieldRules";
import "./shared.css";

// The fields every guest page asks with: a mobile, a name, an address, and a
// declaration the guest ticks. Each shows its own problem once the guest has
// left the box (the rules in fieldRules.js), or the page's (`error`: the
// API's answer, or every box at once when "Book" is pressed). Labels are
// real labels, and a problem is read out with its box.

const Problem = ({ id, text }) =>
  text ? (
    <small id={id} className="gs-field-problem" role="alert">
      {text}
    </small>
  ) : null;

function useShown(error, rule) {
  const [left, setLeft] = useState(false);
  return { problem: error || (left ? rule : null), leave: () => setLeft(true) };
}

// An Indian mobile: +91 and ten digits starting 6 to 9, on the number pad. A
// number pasted with +91, 0091 or a leading 0 is taken as its ten digits;
// `onChange` always gets digits only (at most ten).
export function MobileField({ value, onChange, error = null, label = "Mobile number", hint = null, required = true, autoFocus = false }) {
  const id = useId();
  const { problem, leave } = useShown(error, mobileProblem(value, { required }));

  return (
    <div className={`gs-field ${problem ? "has-problem" : ""}`}>
      <label htmlFor={id}>
        {label}
        {!required && <em> optional</em>}
      </label>
      <div className="gs-mobile">
        <span className="gs-mobile-code" aria-hidden="true">
          +91
        </span>
        <input
          id={id}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={18}
          placeholder="98765 43210"
          value={value || ""}
          autoFocus={autoFocus}
          aria-invalid={Boolean(problem)}
          aria-describedby={[hint ? `${id}-hint` : null, problem ? `${id}-problem` : null].filter(Boolean).join(" ") || undefined}
          onChange={(event) => onChange(mobileDigits(event.target.value))}
          onBlur={leave}
        />
      </div>
      {hint && (
        <small id={`${id}-hint`} className="gs-field-hint">
          {hint}
        </small>
      )}
      <Problem id={`${id}-problem`} text={problem} />
    </div>
  );
}

// A guest's name, as it should appear on the booking or order.
export function NameField({ value, onChange, error = null, label = "Your name", hint = null, required = true, autoFocus = false }) {
  const id = useId();
  const { problem, leave } = useShown(error, nameProblem(value, { required }));

  return (
    <div className={`gs-field ${problem ? "has-problem" : ""}`}>
      <label htmlFor={id}>
        {label}
        {!required && <em> optional</em>}
      </label>
      <input
        id={id}
        autoComplete="name"
        maxLength={80}
        value={value || ""}
        autoFocus={autoFocus}
        aria-invalid={Boolean(problem)}
        aria-describedby={[hint ? `${id}-hint` : null, problem ? `${id}-problem` : null].filter(Boolean).join(" ") || undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={leave}
      />
      {hint && (
        <small id={`${id}-hint`} className="gs-field-hint">
          {hint}
        </small>
      )}
      <Problem id={`${id}-problem`} text={problem} />
    </div>
  );
}

// A delivery address: the address itself, a landmark (optional) and the PIN
// code (six digits). `value` is { address, landmark, pinCode }; `errors` the
// page's problems by the same names (a PIN code outside the delivery area).
export function AddressFields({ value, onChange, errors = {}, required = true }) {
  const id = useId();
  const current = value || {};
  const set = (name) => (event) => onChange({ ...current, [name]: name === "pinCode" ? event.target.value.replace(/\D/g, "").slice(0, 6) : event.target.value });
  const address = useShown(errors.address, addressProblem(current.address, { required }));
  const pin = useShown(errors.pinCode, pinProblem(current.pinCode, { required }));

  return (
    <fieldset className="gs-fields">
      <legend>Delivery address</legend>
      <div className={`gs-field ${address.problem ? "has-problem" : ""}`}>
        <label htmlFor={`${id}-address`}>House or flat, street and area</label>
        <textarea
          id={`${id}-address`}
          rows={2}
          maxLength={500}
          autoComplete="street-address"
          value={current.address || ""}
          aria-invalid={Boolean(address.problem)}
          aria-describedby={address.problem ? `${id}-address-problem` : undefined}
          onChange={set("address")}
          onBlur={address.leave}
        />
        <Problem id={`${id}-address-problem`} text={address.problem} />
      </div>
      <div className="gs-field-pair">
        <div className="gs-field">
          <label htmlFor={`${id}-landmark`}>
            Landmark <em>optional</em>
          </label>
          <input id={`${id}-landmark`} maxLength={200} placeholder="Near the temple, opposite the bank…" value={current.landmark || ""} onChange={set("landmark")} />
        </div>
        <div className={`gs-field gs-field-pin ${pin.problem ? "has-problem" : ""}`}>
          <label htmlFor={`${id}-pin`}>PIN code</label>
          <input
            id={`${id}-pin`}
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            placeholder="500034"
            value={current.pinCode || ""}
            aria-invalid={Boolean(pin.problem)}
            aria-describedby={pin.problem ? `${id}-pin-problem` : undefined}
            onChange={set("pinCode")}
            onBlur={pin.leave}
          />
          <Problem id={`${id}-pin-problem`} text={pin.problem} />
        </div>
      </div>
    </fieldset>
  );
}

// A declaration the guest makes by ticking it, where a page asks for one
// (a salon's "I am 18 or over, or I am booking for my child as their parent
// or guardian"). Never ticked for them; the page refuses to go on unticked.
//   <DeclarationCheck checked={adult} onChange={setAdult} error={problems.adult}>
//     I am 18 or over, or I am booking for my child as their parent or guardian.
//   </DeclarationCheck>
export function DeclarationCheck({ checked, onChange, error = null, children }) {
  const id = useId();

  return (
    <div className={`gs-declare ${error ? "has-problem" : ""}`}>
      <label htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(checked)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-problem` : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{children}</span>
      </label>
      <Problem id={`${id}-problem`} text={error} />
    </div>
  );
}
