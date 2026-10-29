import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SidePanel from "../../../../components/SidePanel";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { dateTime, newKey } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { ALL_PURITIES, ID_KINDS, OLD_GOLD_NEXT, OLD_GOLD_STATES, TEST_METHODS, approvalBody, emptyApproval, finenessOf, grams, perGram, purityWords } from "./jewellery";
import { printOldGoldVoucher } from "./jewelleryPrint";
import JewelleryApproval from "./JewelleryApproval";
import JewelleryPhoto from "./JewelleryPhoto";
import { OldGoldPayoutsDialog } from "./OldGoldPayouts";
import { RefinerySendForm } from "./RefineryDialogs";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// The forms and the panel of Old gold: old gold taken in on a voucher (the
// seller, the photo ID seen, each article tested and weighed, valued by the
// server at today's buy rate as it is typed, the PAN or Form 97 over
// ₹2,00,000, and the seller's declaration), each line's deduction the shop's
// buy-back rule (its own pieces by HUID or tag, each purity's, the general
// one) unless a manager approves another; the voucher's panel with its
// articles, where each one's metal goes next, its photos, what was used and
// paid out on it and what is left; paying it out (UPI or bank transfer first;
// cash is limited), with the seller's other vouchers too, putting it back
// from a returned bill, and cancelling it while nothing is paid out or used.

const ID_WORDS = Object.fromEntries(ID_KINDS.map((k) => [k.value, k.label]));
const TEST_WORDS = Object.fromEntries(TEST_METHODS.map((k) => [k.value, k.label]));
const PAYOUT_KINDS = ["upi", "bank", "cash"];
const splitKey = (key) => { const [metal, purity] = String(key).split(":"); return { metal, purity }; };
// A line's deduction left empty takes the shop's buy-back rule.
const blankLine = () => ({ key: newKey(), description: "", pieces: "1", purity: "gold:22K", testMethod: "xrf", testedFineness: "", grossWeight: "", lessWeight: "",
  deductionPercent: "", tag: "", huid: "" });
const lineBody = (l) => ({ description: l.description.trim(), pieces: l.pieces || "1", ...splitKey(l.purity), testMethod: l.testMethod,
  ...(l.testedFineness !== "" ? { testedFineness: l.testedFineness } : {}), grossWeight: l.grossWeight, ...(l.lessWeight !== "" ? { lessWeight: l.lessWeight } : {}),
  ...(l.deductionPercent !== "" ? { deductionPercent: l.deductionPercent } : {}), ...(l.tag.trim() ? { tag: l.tag.trim() } : {}), ...(l.huid.trim() ? { huid: l.huid.trim() } : {}) });
// The seller's words, kept the same whoever prints them.
export const CASH_RULE = "A seller does not receive ₹2,00,000 or more in cash for old gold in a day or for one voucher (Income-tax Act 2025, section 186): pay by UPI or bank transfer.";

// Old gold taken in. `contact`: the customer already chosen (the jewellery bill).
export function OldGoldForm({ biz, settings, contact, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [customer, setCustomer] = useState(contact || null);
  const [typed, setTyped] = useState(null);
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""));
  const [idKind, setIdKind] = useState("aadhaar");
  const [idRef, setIdRef] = useState("");
  const [pan, setPan] = useState(contact?.pan || "");
  const [declared, setDeclared] = useState(false);
  const [owner, setOwner] = useState(false);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState(() => [blankLine()]);
  const [quote, setQuote] = useState(null);
  const [approval, setApproval] = useState(emptyApproval);
  const [reason, setReason] = useState("");
  const set = (key, change) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));
  // The lines ready to value (what it is and its weight), and the server's valuation of them.
  const ready = useMemo(() => lines.filter((l) => l.description.trim() && Number(l.grossWeight) > 0), [lines]);
  const payload = useMemo(() => (ready.length ? JSON.stringify({ lines: ready.map(lineBody) }) : null), [ready]);
  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "jewellery/old-gold/preview", JSON.parse(payload))
        .then((data) => setQuote({ payload, data, error: "" }))
        .catch((err) => setQuote({ payload, data: null, error: getErrorMessage(err) }));
    }, 250);
    return () => clearTimeout(timer);
  }, [biz.id, payload]);
  const figures = payload && quote?.payload === payload ? quote.data : null;
  const problem = payload && quote?.payload === payload ? quote.error : "";
  const valued = (key) => figures?.lines[ready.findIndex((l) => l.key === key)] || null;
  const chooseCustomer = (next) => { setCustomer(next); if (next?.pan) setPan(next.pan); };
  const submit = () => businessWrite(biz.id, "jewellery/old-gold", {
    requestKey, locationId, ...(customer ? { contactId: customer.id } : { customer: { name: typed?.name?.trim() || "", phone: typed?.phone?.trim() || undefined,
      consents: consentChanges(typed?.consents, []) || undefined } }),
    idKind, idRef: idRef.trim(), ...(pan.trim() ? { pan: pan.trim() } : declared ? { panDeclaration: true } : {}), ownerDeclared: owner, lines: lines.map(lineBody),
    notes: notes.trim() || undefined, ...(figures?.needsApproval ? { approval: { ...approvalBody(approval), reason: reason.trim() } } : {}),
  });
  return (
    <FormDialog title="Take in old gold" icon="scale" width={940} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Make the voucher"
      successMessage={(g) => `Old gold ${g.voucher_no}: ${biz.exact(g.value)}.`}
      description="Each article tested and weighed, valued at today's buy rate for the purity it is valued as, scaled to the fineness found, less the shop's buy-back deduction (its own pieces known by their HUID or tag).">
      {contact ? <Field label="Seller" wide><input readOnly value={contact.name} /></Field> : typed ? (
        <>
          <Field label="Seller's name"><input required maxLength={150} value={typed.name} onChange={(e) => setTyped((c) => ({ ...c, name: e.target.value }))} /></Field>
          <Field label="Phone"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((c) => ({ ...c, phone: e.target.value }))} /></Field>
          <NewCustomerConsents value={typed.consents} onChange={(consents) => setTyped((c) => ({ ...c, consents }))} />
          <div className="field-wide"><button type="button" className="link-button" onClick={() => setTyped(null)}>Find a customer instead</button></div>
        </>
      ) : (
        <div className="field-wide jw-row">
          <div className="field jw-grow">
            <SearchPicker label="Seller (a customer)" placeholder="Name or phone" value={customer} onChange={chooseCustomer} minChars={2}
              search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
              getLabel={(x) => x.name} getDescription={(x) => x.phone || ""} />
          </div>
          {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setCustomer(null); setTyped({ name: "", phone: "" }); }}><Icon name="user" size={15} /> New customer</button>}
        </div>
      )}
      <Field label="Photo ID seen">
        <select value={idKind} onChange={(e) => setIdKind(e.target.value)}>{ID_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
      </Field>
      <Field label={idKind === "aadhaar" ? "Last 4 digits of the Aadhaar number" : "Its number"} hint={idKind === "aadhaar" ? "Only the last four digits are kept." : undefined}>
        <input required className="mono" maxLength={idKind === "aadhaar" ? 4 : 30} inputMode={idKind === "aadhaar" ? "numeric" : undefined} value={idRef} onChange={(e) => setIdRef(e.target.value.toUpperCase())} />
      </Field>
      {locations.length > 1 && <Field label="Taken in at"><select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <div className="field-wide jw-og-lines">
        {lines.map((l, index) => {
          const v = valued(l.key);
          const { metal, purity } = splitKey(l.purity);
          return (
            <fieldset key={l.key} className="jw-og-line">
              <legend>Article {index + 1}</legend>
              <div className="jw-row">
                <Field label="What it is"><input required maxLength={150} value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} placeholder="e.g. Old bangles" /></Field>
                <Field label="How many"><input type="number" min="1" max="1000" step="1" value={l.pieces} onChange={(e) => set(l.key, { pieces: e.target.value })} /></Field>
                <Field label="Valued as"><select value={l.purity} onChange={(e) => set(l.key, { purity: e.target.value })}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
                <Field label="Tested by"><select value={l.testMethod} onChange={(e) => set(l.key, { testMethod: e.target.value })}>{TEST_METHODS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>
                <Field label="Fineness found" hint="Parts in a thousand.">
                  <input type="number" min="0.1" max="999.9" step="0.1" value={l.testedFineness} placeholder={String(finenessOf(metal, purity))} onChange={(e) => set(l.key, { testedFineness: e.target.value })} />
                </Field>
              </div>
              <div className="jw-row">
                <Field label="Gross weight (g)"><input required type="number" min="0.001" step="0.001" value={l.grossWeight} onChange={(e) => set(l.key, { grossWeight: e.target.value })} /></Field>
                <Field label="Stones and dirt (g)"><input type="number" min="0" step="0.001" value={l.lessWeight} onChange={(e) => set(l.key, { lessWeight: e.target.value })} /></Field>
                <Field label="Deduction (%)" hint={v && !v.problem ? `Rule: ${Number(v.rulePercent)}% (${v.ruleWords.toLowerCase()})` : "Empty: the shop's rule."}>
                  <input type="number" min="0" max="99.99" step="0.01" value={l.deductionPercent} placeholder={v && !v.problem ? String(Number(v.rulePercent)) : ""} onChange={(e) => set(l.key, { deductionPercent: e.target.value })} />
                </Field>
                <Field label="This shop's tag (if it sold it)"><input className="mono" maxLength={30} value={l.tag} onChange={(e) => set(l.key, { tag: e.target.value.toUpperCase() })} /></Field>
                <Field label="HUID (if it has one)"><input className="mono" maxLength={6} value={l.huid} onChange={(e) => set(l.key, { huid: e.target.value.toUpperCase() })} /></Field>
                {lines.length > 1 && <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>}
              </div>
              {v && (v.problem ? <p className="bz-due small" role="alert">{v.problem}</p> : (
                <p className="jw-og-value">Net {grams(v.netWeight)} · fine {grams(v.fineWeight)} · {purityWords(metal, purity)} at {perGram(biz, v.buyRate)}
                  {Number(v.deductionPercent) ? ` less ${Number(v.deductionPercent)}%` : ""}{v.ownTag ? ` (this shop's ${v.ownTag})` : ""}{v.override ? " · not the rule: a manager approves" : ""}: <strong>{biz.exact(v.value)}</strong></p>
              ))}
            </fieldset>
          );
        })}
        {lines.length < 30 && <button type="button" className="chip-button" onClick={() => setLines((all) => [...all, blankLine()])}><Icon name="plus" size={13} /> Another article</button>}
      </div>
      {problem && <div className="field-wide"><p className="bz-due small" role="alert">{problem}</p></div>}
      {figures && !figures.problems.length && (
        <div className="field-wide jw-totals">
          <span>Net {grams(figures.netWeight)}</span><span>Fine {grams(figures.fineWeight)}</span>
          {Number(figures.roundOff) !== 0 && <span>Round-off {biz.exact(figures.roundOff)}</span>}
          <strong>Value {biz.exact(figures.value)}</strong>
        </div>
      )}
      {figures?.needsApproval && (
        <>
          <Field label="Why the deduction is changed" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Long-standing customer" /></Field>
          <JewelleryApproval title="A deduction other than the shop's rule needs a manager" value={approval} onChange={setApproval} />
        </>
      )}
      {(figures?.panNeeded || idKind === "pan_card" || pan) && (
        <fieldset className="field-wide jw-row jw-pan">
          <legend>Old gold worth more than ₹2,00,000 records the seller's PAN</legend>
          {!declared && idKind !== "pan_card" && <Field label="Seller's PAN"><input maxLength={10} className="mono" value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} placeholder="ABCDE1234F" /></Field>}
          {idKind === "pan_card" && <p className="muted small">The PAN card's number is the PAN.</p>}
          {idKind !== "pan_card" && <label className="checkbox bz-check"><input type="checkbox" checked={declared} onChange={(e) => { setDeclared(e.target.checked); if (e.target.checked) setPan(""); }} /> The seller has no PAN and signed a declaration (Form 97)</label>}
        </fieldset>
      )}
      <label className="field-wide checkbox bz-check"><input type="checkbox" checked={owner} onChange={(e) => setOwner(e.target.checked)} required />
        {settings?.declaration || "The seller declares the metal is their own and that they have the right to sell it."}</label>
      <Field label="Notes (optional)" wide><input maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </FormDialog>
  );
}

// The voucher's value paid out: by UPI or bank transfer, or cash within the limits.
function PayoutForm({ biz, voucher, settings, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: Number(voucher.balance).toFixed(2), method: "upi", reference: "" });
  const own = settings?.oldGoldCashLimit;
  return (
    <FormDialog title={`Pay out old gold ${voucher.voucher_no}`} icon="wallet" onClose={onClose} onSaved={onSaved} submitLabel="Pay out" successMessage="Paid out."
      description={`${voucher.seller_name} has ${biz.exact(voucher.balance)} left on this voucher. It is written in the expense book.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/old-gold/${voucher.id}/payout`, { requestKey, ...methods.body(form.method, PAYOUT_KINDS), amount: form.amount,
        reference: form.reference.trim() || undefined })}>
      <Field label="Amount"><input required type="number" min="0.01" max={voucher.balance} step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
      <Field label="Paid by">
        <select value={methods.resolve(form.method, PAYOUT_KINDS)} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}>
          {methods.options(PAYOUT_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
      </Field>
      <Field label="Reference (optional)" wide hint="The UPI or bank transfer's reference."><input maxLength={100} value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} /></Field>
      <p className="field-wide muted small">{CASH_RULE}{own ? ` The shop pays at most ${biz.exact(own)} in cash to one seller in a day (its own limit).` : ""}</p>
    </FormDialog>
  );
}

function CancelForm({ biz, voucher, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Cancel old gold ${voucher.voucher_no}`} icon="alert" onClose={onClose} onSaved={onSaved} submitLabel="Cancel the voucher" successMessage="Cancelled."
      description={`Nothing was paid out or used on it. Its ${grams(voucher.net_weight)} of metal goes back out of the shop's metal.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/old-gold/${voucher.id}/cancel`, { reason: reason.trim() })}>
      <Field label="Why" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The customer took it back" /></Field>
    </FormDialog>
  );
}

// A bill this voucher paid was returned: its part goes back on the voucher.
function PutBackForm({ biz, voucher, choice, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [amount, setAmount] = useState(choice.amount);
  return (
    <FormDialog title={`Put old gold back from ${choice.documentNo}`} icon="undo" onClose={onClose} onSaved={onSaved} submitLabel="Put it back" successMessage="Put back on the voucher."
      description={`${choice.documentNo} was returned: up to ${biz.exact(choice.amount)} of what ${voucher.voucher_no} paid on it goes back on the voucher, to pay out or use again.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/old-gold/${voucher.id}/put-back`, { requestKey, documentId: choice.documentId, amount })}>
      <Field label="Amount"><input required type="number" min="0.01" max={choice.amount} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
    </FormDialog>
  );
}

// A voucher's panel: the seller, each article as valued, what became of the value, and what can be done.
export function OldGoldPanel({ biz, voucherId, settings, onClose, onChanged }) {
  const [voucher, setVoucher] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    if (!voucherId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/old-gold/${voucherId}`, undefined, controller.signal).then((g) => { setVoucher(g); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, voucherId, version]);
  const done = () => { setDialog(null); setVersion((n) => n + 1); onChanged?.(); };
  const [busy, setBusy] = useState(false);
  const [nextError, setNextError] = useState("");
  // A line kept to resell as it is, or put back with the metal to melt (a manager's say).
  const setNext = async (line, next) => {
    if (busy) return;
    setBusy(true);
    setNextError("");
    try {
      setVoucher(await businessWrite(biz.id, `jewellery/old-gold/${voucher.id}/next`, { seq: line.seq, next }));
      onChanged?.();
    } catch (err) {
      setNextError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const state = voucher ? OLD_GOLD_STATES[voucher.state] : null;
  const settlements = useMemo(() => (voucher ? [
    ...voucher.uses.map((u) => ({ key: `u${u.id}`, at: u.created_at, words: Number(u.amount) > 0 ? `Used on bill ${u.document_no}` : `Put back from bill ${u.document_no}`, amount: u.amount, by: u.by_name })),
    ...voucher.payouts.map((p) => ({ key: `p${p.id}`, at: p.created_at, words: `Paid out by ${p.method_words}${p.reference ? ` · ${p.reference}` : ""}`, amount: p.amount, by: p.by_name })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at))) : []), [voucher]);
  return (
    <SidePanel open title={voucher ? `Old gold ${voucher.voucher_no}` : "Old gold"} icon="scale" wide onClose={onClose}
      footer={voucher && (
        <div className="jw-panel-actions">
          {voucher.state === "open" && biz.can("jewellery.approve") && <button type="button" className="button" onClick={() => setDialog({ kind: "payout" })}><Icon name="wallet" size={15} /> Pay out</button>}
          {voucher.state === "open" && biz.can("jewellery.approve") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "many" })}>With {voucher.seller_name}&apos;s other vouchers</button>}
          {biz.can("sales.refund") && voucher.putBack.map((p) => <button key={p.documentId} type="button" className="button button-secondary" onClick={() => setDialog({ kind: "back", choice: p })}>Put back from {p.documentNo}</button>)}
          {biz.can("jewellery.print") && <button type="button" className="button button-secondary" onClick={() => printOldGoldVoucher(biz, voucher)}><Icon name="print" size={15} /> Print the voucher</button>}
          {voucher.cancellable && biz.can("jewellery.cancel") && <button type="button" className="button button-secondary danger" onClick={() => setDialog({ kind: "cancel" })}>Cancel</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!voucher ? !error && <Loading /> : (
        <div className="stack">
          <div className="jw-piece-head">
            <Badge tone={state?.tone} label={state?.label || voucher.state} />
            <strong>{voucher.seller_name}</strong>
            <span className="muted">{biz.exact(voucher.balance)} left of {biz.exact(voucher.value)}</span>
          </div>
          <dl className="jw-facts">
            {[["Phone", voucher.seller_phone], ["Photo ID seen", `${ID_WORDS[voucher.id_kind] || voucher.id_kind} ${voucher.id_kind === "aadhaar" ? "ending " : ""}${voucher.id_ref}`],
              ["PAN", voucher.pan || (voucher.pan_declaration ? "None: Form 97 declaration signed" : null)], ["Taken in", `${dateTime(voucher.created_at)} · ${voucher.by_name}`],
              ["Valued at", `Buy rates of ${dateShort(voucher.rate_date, { year: true })}`], ["Location", biz.locations.length > 1 ? voucher.location_name : null],
              ["Metal", `${grams(voucher.net_weight)} · fine ${grams(voucher.fine_weight)}`], ["Notes", voucher.notes],
              ["Cancelled", voucher.cancelled_at ? `${dateTime(voucher.cancelled_at)} · ${voucher.cancelled_by_name}: ${voucher.cancel_reason}` : null]]
              .filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <table className="jw-rates">
            <thead><tr><th scope="col">Article</th><th scope="col">Valued as · tested</th><th scope="col">Gross · less</th><th scope="col">Net · fine</th><th scope="col">Rate · deduction</th><th scope="col">Value</th><th scope="col">Next</th></tr></thead>
            <tbody>{voucher.lines.map((l) => (
              <tr key={l.seq}>
                <th scope="row">{l.description}{Number(l.pieces) > 1 ? ` (${l.pieces})` : ""}{l.huid && <small className="muted"> · HUID {l.huid}{l.own_tag ? `, this shop's ${l.own_tag}` : ""}</small>}</th>
                <td>{l.mark} · {TEST_WORDS[l.test_method]} {Number(l.tested_fineness).toFixed(1)}</td>
                <td>{grams(l.gross_weight)} · {grams(l.less_weight)}</td>
                <td>{grams(l.net_weight)} · {grams(l.fine_weight)}</td>
                <td>{perGram(biz, l.buy_rate)} · {Number(l.deduction_percent)}%
                  {l.rule_words && <small className="muted bz-two-line">{l.override_by_name ? `Not the rule (${Number(l.rule_percent)}%): ${l.override_by_name} approved, ${l.override_reason}` : l.rule_words}</small>}</td>
                <td>{biz.exact(l.value)}</td>
                <td><span className="bz-two-line"><span>{OLD_GOLD_NEXT[l.next]?.label || l.next_words}{l.refinery_no ? ` · ${l.refinery_no}` : ""}{l.karigar_issue_no ? ` · ${l.karigar_issue_no}` : ""}</span>
                  {voucher.state !== "cancelled" && biz.can("jewellery.approve") && ["melt", "resell"].includes(l.next) && (
                    <>
                      <button type="button" className="link-button" disabled={busy} onClick={() => setNext(l, l.next === "melt" ? "resell" : "melt")}>{l.next === "melt" ? "Keep to resell" : "Back to melt"}</button>
                      <button type="button" className="link-button" disabled={busy} onClick={() => setDialog({ kind: "refinery", line: l })}>Send on a refinery challan</button>
                    </>
                  )}</span></td>
              </tr>
            ))}</tbody>
          </table>
          <ErrorMessage message={nextError} />
          {Number(voucher.round_off) !== 0 && <p className="muted small">Rounded by {biz.exact(voucher.round_off)} to {biz.exact(voucher.value)}.</p>}
          <section>
            <h3 className="jw-subhead">Photos of what came in</h3>
            <div className="jw-photos">
              {voucher.photos.map((p) => <JewelleryPhoto key={p.id} biz={biz} fileId={p.id} replaces={false} canChange={biz.can("jewellery.create")} onChanged={() => setVersion((n) => n + 1)} />)}
              {voucher.state !== "cancelled" && biz.can("jewellery.create") && voucher.photos.length < 10 && (
                <JewelleryPhoto biz={biz} oldGoldId={voucher.id} canChange onChanged={() => setVersion((n) => n + 1)} />
              )}
            </div>
          </section>
          <section>
            <h3 className="jw-subhead">What became of it</h3>
            {settlements.length === 0 ? <p className="jw-note">Nothing paid out or used yet.</p> : (
              <ol className="jw-history">{settlements.map((s) => <li key={s.key}><span>{dateTime(s.at)} · {s.by}</span><span>{s.words}: {biz.exact(Math.abs(Number(s.amount)))}</span></li>)}</ol>
            )}
          </section>
        </div>
      )}
      {dialog?.kind === "payout" && <PayoutForm biz={biz} voucher={voucher} settings={settings} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "refinery" && <RefinerySendForm biz={biz} carries={[{ voucherId: voucher.id, seq: dialog.line.seq, voucherNo: voucher.voucher_no, description: dialog.line.description }]}
        start={{ locationId: voucher.location_id, purity: `${dialog.line.metal}:${dialog.line.purity}`, netWeight: Number(dialog.line.net_weight).toFixed(3) }} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "many" && <OldGoldPayoutsDialog biz={biz} seller={{ id: voucher.contact_id, name: voucher.seller_name }} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "cancel" && <CancelForm biz={biz} voucher={voucher} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "back" && <PutBackForm biz={biz} voucher={voucher} choice={dialog.choice} onClose={() => setDialog(null)} onSaved={done} />}
    </SidePanel>
  );
}
