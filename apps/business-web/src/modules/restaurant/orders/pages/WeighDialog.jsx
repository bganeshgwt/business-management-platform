import { useState } from "react";
import Modal from "../../../../components/Modal";
import { moneyExact } from "@bmp/shared/format";

// A bake or sweet sold by weight: the price is per kg; the counter types the
// grams on the scale (or taps a usual weight) and the line is that weight.
const USUAL = [100, 250, 500, 750, 1000];

export default function WeighDialog({ product, unitPrice, currency, onClose, onAdd }) {
  const [grams, setGrams] = useState("");
  const value = Number(grams);
  const kg = Math.round((value / 1000) * 100) / 100;
  const ok = Number.isFinite(value) && value >= 10 && value <= 50000;
  const add = (event) => {
    event?.preventDefault();
    if (ok) onAdd(kg);
  };
  return (
    <Modal title={`Weigh: ${product.name}`} description={`${moneyExact(unitPrice, currency)} per kg`} icon="scale" onClose={onClose} width={440}>
      <form className="stack" onSubmit={add}>
        <label className="field">
          <span>Weight on the scale (grams)</span>
          <input type="number" inputMode="numeric" min="10" max="50000" step="5" autoFocus value={grams} onChange={(e) => setGrams(e.target.value)} placeholder="e.g. 350" />
        </label>
        <div className="pos-weigh-usual" role="group" aria-label="Usual weights">
          {USUAL.map((g) => (
            <button key={g} type="button" className={`chip-button ${value === g ? "is-active" : ""}`} onClick={() => setGrams(String(g))}>
              {g >= 1000 ? `${g / 1000} kg` : `${g} g`}
            </button>
          ))}
        </div>
        <p className="pos-weigh-total" aria-live="polite">
          {ok ? <>{kg} kg · <strong>{moneyExact(kg * unitPrice, currency)}</strong></> : <span className="muted">Type the weight in grams</span>}
        </p>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="button" disabled={!ok}>Add {ok ? `${kg} kg` : ""}</button>
        </div>
      </form>
    </Modal>
  );
}
