import { useEffect, useRef } from "react";
import useShake from "../hooks/useShake";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];

// A PIN entry for a till or tablet: dots for what has been typed, and keys
// big enough for a finger. A keyboard works too — the digits go into a real
// (masked) input, so typing, pasting and Enter behave as expected.
//
// `shakeKey` — give it a number that goes up each time a PIN is refused (a
// count of refusals); the dots shake once for each new refusal. 0 or
// nothing never shakes.
export default function PinPad({ value, onChange, onSubmit, disabled, label = "PIN", autoFocus = true, shakeKey = 0 }) {
  const input = useRef(null);
  const [dotsRef, shake] = useShake();

  useEffect(() => {
    if (autoFocus && input.current) {
      input.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    if (shakeKey) {
      shake();
    }
  }, [shakeKey, shake]);

  const press = (key) => {
    if (disabled) {
      return;
    }

    if (key === "clear") {
      onChange("");
    } else if (key === "back") {
      onChange(value.slice(0, -1));
    } else if (value.length < 6) {
      onChange(value + key);
    }

    if (input.current) {
      input.current.focus();
    }
  };

  return (
    <div className="acc-pinpad">
      <label className="acc-pin-field">
        <span className="sr-only">{label}</span>
        <input
          ref={input}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]*"
          maxLength={6}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <span className="acc-pin-dots" aria-hidden="true" ref={dotsRef}>
          {Array.from({ length: Math.max(4, value.length) }, (unused, index) => (
            <span key={index} className={`acc-pin-dot ${index < value.length ? "is-filled" : ""}`} />
          ))}
        </span>
      </label>

      <div className="acc-keys">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`acc-key ${key.length > 1 ? "acc-key-muted" : ""}`}
            onClick={() => press(key)}
            disabled={disabled}
            aria-label={key === "back" ? "Delete last digit" : key === "clear" ? "Clear" : key}
          >
            {key === "back" ? "⌫" : key === "clear" ? "Clear" : key}
          </button>
        ))}
      </div>
    </div>
  );
}
