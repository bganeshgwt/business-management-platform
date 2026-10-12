import { useEffect, useState } from "react";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import PinPad from "../../../../components/PinPad";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { deviceTokens } from "../../../../services/auth.service";
import { Field } from "../../core/pages/ui";
import { methodWord } from "./retail";
import { newPart, partsSummary, round2 } from "./counterPayState";
import "../styles/counter-pay.css";

// Round 2 (R2-CORE) pieces of Quick bill: several payments on one bill
// (split payment), an EMI sale through a financier, the per-staff PIN at a
// shared till, and the bill carried across a switch of biller.

const PART_METHODS = ["cash", "upi", "card"];
// Cash + UPI + card on one bill. `due` is what these parts should cover;
// "Rest" fills a part with what is still left. The change comes only from cash.
export function PaymentParts({ biz, parts, onChange, due, label = "Payments", leftWord = "Left to pay" }) {
  const set = (key, changes) => onChange(parts.map((p) => (p.key === key ? { ...p, ...changes } : p)));
  const { paid, change } = partsSummary(parts);
  const left = round2(due - paid);
  return (
    <fieldset className="rt-parts">
      <legend className="small">{label}</legend>
      {parts.map((part, index) => {
        const others = round2(paid - (Number(part.amount) > 0 ? Number(part.amount) : 0));
        const rest = round2(Math.max(0, due - others));
        return (
          <div key={part.key} className="rt-part">
            <select aria-label={`Payment ${index + 1} by`} value={part.method} onChange={(e) => set(part.key, { method: e.target.value, tendered: "" })}>
              {PART_METHODS.map((m) => <option key={m} value={m}>{methodWord(m)}</option>)}
            </select>
            <input aria-label={`Payment ${index + 1} amount`} type="number" inputMode="decimal" min="0" step="0.01" placeholder="Amount"
              value={part.amount} onChange={(e) => set(part.key, { amount: e.target.value })} />
            <button type="button" className="chip-button" disabled={!(rest > 0)} onClick={() => set(part.key, { amount: String(rest) })} title="Fill with what is left">Rest</button>
            {part.method === "cash"
              ? <input aria-label={`Cash handed over for payment ${index + 1}`} type="number" inputMode="decimal" min="0" step="0.01" placeholder="Cash handed over"
                  value={part.tendered} onChange={(e) => set(part.key, { tendered: e.target.value })} />
              : <input aria-label={`Reference for payment ${index + 1}`} maxLength={100} placeholder={part.method === "upi" ? "UPI ref (optional)" : "Card slip (optional)"}
                  value={part.reference} onChange={(e) => set(part.key, { reference: e.target.value })} />}
            {parts.length > 1 && (
              <button type="button" className="icon-button" aria-label={`Remove payment ${index + 1}`} title="Remove" onClick={() => onChange(parts.filter((p) => p.key !== part.key))}>
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        );
      })}
      <div className="rt-parts-foot">
        {parts.length < 8 && <button type="button" className="link-button" onClick={() => onChange([...parts, newPart(parts.some((p) => p.method === "upi") ? "card" : "upi")])}>+ Add a payment</button>}
        <span className="small">
          {left > 0.004 ? <>{leftWord} <strong>{biz.exact(left)}</strong></> : left < -0.004 ? <span className="rt-warn">{biz.exact(-left)} more than the bill</span> : <span className="rt-ok">Covered</span>}
          {change > 0.004 && <> · Give back <strong>{biz.exact(change)}</strong> from cash</>}
        </span>
      </div>
    </fieldset>
  );
}

// An EMI sale: financier, loan / DO number, tenure, and the down payment.
export function FinanceFields({ biz, value, onChange, toPay }) {
  const [financiers, setFinanciers] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "finance/financiers", {}, controller.signal)
      .then((data) => setFinanciers(data.items.filter((f) => f.active)))
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const set = (changes) => onChange({ ...value, ...changes });
  const { paid } = partsSummary(value.down);
  const financed = round2(toPay - paid);
  return (
    <div className="stack rt-emi">
      <ErrorMessage message={error} />
      {!financiers && !error && <Loading />}
      {financiers && (
        <>
          <div className="rt-inline">
            <Field label="Financier">
              <select required value={value.financierId} onChange={(e) => set({ financierId: e.target.value })}>
                <option value="">Choose…</option>
                {financiers.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <Field label="Loan / agreement no.">
              <input required maxLength={60} value={value.loanNo} onChange={(e) => set({ loanNo: e.target.value })} placeholder="e.g. BFL-778812" />
            </Field>
          </div>
          <div className="rt-inline">
            <Field label="DO number (optional)"><input maxLength={60} value={value.doNo} onChange={(e) => set({ doNo: e.target.value })} /></Field>
            <Field label="Months (optional)"><input type="number" min="1" max="60" step="1" value={value.tenure} onChange={(e) => set({ tenure: e.target.value })} /></Field>
          </div>
          <PaymentParts biz={biz} parts={value.down} onChange={(down) => set({ down })} due={toPay} label="Down payment by the customer" leftWord="Financed" />
          <p className="small rt-emi-sum">
            Financed by {financiers.find((f) => String(f.id) === String(value.financierId))?.name || "the financier"}: <strong>{biz.exact(Math.max(0, financed))}</strong>
            {" "}· owed by the financier, not the customer.
          </p>
        </>
      )}
    </div>
  );
}
// --- Who is billing: switch the till by PIN ------------------------------------------------
export function BillerButton({ biz, onSwitch }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button button-secondary rt-biller" onClick={() => setOpen(true)} title="Switch who is billing on this till">
        <Icon name="user" size={15} /> <span className="rt-biller-name">{user.name}</span> <small className="muted">Switch</small>
      </button>
      {open && <BillerDialog biz={biz} mode="switch" onClose={() => setOpen(false)} onSwitched={(session) => { setOpen(false); onSwitch(session); }} />}
    </>
  );
}

// mode "switch": pick a person and type their PIN (the till carries on as
// them). mode "confirm": the PIN of the person billing, for this bill.
export function BillerDialog({ biz, mode, onClose, onSwitched, onConfirm, error: outerError = "" }) {
  const { user } = useAuth();
  const [people, setPeople] = useState(null);
  const [who, setWho] = useState(mode === "confirm" ? Number(user.id) : null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState(outerError);
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState(outerError ? 1 : 0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "counter/staff", {}, controller.signal)
      .then((data) => setPeople(data.people))
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const person = people?.find((p) => p.id === who) || (who === Number(user.id) ? { id: Number(user.id), name: user.name, hasPin: user.hasPin } : null);

  async function submit(event) {
    event?.preventDefault();
    if (!person) { setError("Choose who is billing"); return; }
    if (pin.length < 4) { setError("Enter the PIN (4 to 6 digits)"); return; }
    setError("");
    if (person.id === Number(user.id)) {
      if (mode === "confirm") { onConfirm(pin); setPin(""); return; }
      onClose();
      return;
    }
    setBusy(true);
    try {
      const session = await businessWrite(biz.id, "counter/switch", { userId: person.id, pin, deviceTokens: deviceTokens() });
      onSwitched(session);
    } catch (err) {
      setPin(""); setError(getErrorMessage(err)); setRefusals((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={mode === "confirm" ? "Your PIN for this bill" : "Who is billing?"} icon="lock" width={560} onClose={onClose}
      description={mode === "confirm" ? "This business asks the biller's PIN for every bill. Someone else billing? Pick them first: the till switches to them and the bill stays." : "Pick your name and type your PIN. The till carries on as you and the bill being built stays."}>
      <form className="stack rt-biller-form" onSubmit={submit}>
        {!people && !error && <Loading />}
        {people && (
          <div className="rt-biller-people" role="group" aria-label="People who bill here">
            {people.map((p) => (
              <button key={p.id} type="button" className={`rt-biller-person ${who === p.id ? "is-active" : ""}`} aria-pressed={who === p.id}
                disabled={!p.hasPin || p.locked || busy} onClick={() => { setWho(p.id); setPin(""); setError(""); }}
                title={!p.hasPin ? "No PIN yet: set one under My profile" : p.locked ? "PIN locked after wrong tries" : p.roleName}>
                <strong>{p.name}{p.id === Number(user.id) ? " (now)" : ""}</strong>
                <small className="muted">{!p.hasPin ? "No PIN yet" : p.locked ? "PIN locked" : p.roleName}</small>
              </button>
            ))}
          </div>
        )}
        {person && !person.hasPin && <p className="small rt-warn">{person.name} has no PIN yet. Set one under My profile, or an admin sets it under Users.</p>}
        {person && person.hasPin !== false && (
          <PinPad key={person.id} value={pin} onChange={setPin} onSubmit={submit} disabled={busy} shakeKey={refusals} label={`${person.name}'s PIN`} />
        )}
        <ErrorMessage message={error} />
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="button" disabled={busy || !person || person.hasPin === false}>
            {busy ? "Checking…" : mode === "confirm" && person?.id === Number(user.id) ? "Take the payment" : person && person.id !== Number(user.id) ? `Continue as ${person.name.split(" ")[0]}` : "Done"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
