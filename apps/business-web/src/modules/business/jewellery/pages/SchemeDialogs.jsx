import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
import { KIND_WORDS, usePaymentMethods } from "../../core/pages/paymentMethods";
import { ALL_PURITIES, SCHEME_STAGES, approvalBody, emptyApproval, grams, perGram, schemeReminder, splitPurity } from "./jewellery";
import { printSchemePassbook } from "./jewelleryPrint";
import JewelleryApproval from "./JewelleryApproval";
// An instalment reminder needs the member's consent to reminders (asked first, in one tap).
import ConsentLink from "../../../personal-data/components/ConsentLink";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// The forms and the panel of Gold schemes: a customer joining a plan (its
// terms shown for them to accept, their monthly amount, a nominee, and the
// first instalment taken now); a scheme's passbook with each instalment due
// and paid; taking an instalment; stopping a scheme with a manager's approval
// (no more instalments, no discount: what was paid is still used on a
// jewellery bill, never paid back in money); redeeming it on the jewellery
// bill; on its day 364, closing it into the customer's safekeeping (billed as
// gold or silver equal to its money at that day's rate, the metal set aside
// for them) and their collecting it later; and, when the bill that redeemed it
// is returned within its tenure, putting its money back onto the scheme.

const PAY_KINDS = ["upi", "cash", "card", "bank"];
const CASH_RULE = "Cash into one scheme stays under ₹2,00,000: its instalments pay one jewellery bill, and one bill takes less than that in cash (Income-tax Act 2025, section 186).";

function PaidBy({ methods, value, onChange }) {
  return (
    <>
      <Field label="Paid by">
        <select value={methods.resolve(value.method, PAY_KINDS)} onChange={(e) => onChange({ ...value, method: e.target.value })}>
          {methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
      </Field>
      <Field label="Reference (optional)"><input maxLength={100} value={value.reference} onChange={(e) => onChange({ ...value, reference: e.target.value })} /></Field>
    </>
  );
}

// A customer joins a plan, paying the first instalment now.
export function EnrolForm({ biz, plans, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const locations = biz.locations.filter((l) => l.active);
  const open = plans.filter((p) => p.active);
  const [requestKey] = useState(newKey);
  const [planId, setPlanId] = useState(String(open[0]?.id || ""));
  const plan = open.find((p) => String(p.id) === planId) || null;
  const [customer, setCustomer] = useState(null);
  const [typed, setTyped] = useState(null);
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""));
  const [instalment, setInstalment] = useState(open[0] ? String(Number(open[0].min_instalment)) : "");
  const [nominee, setNominee] = useState({ name: "", relation: "" });
  const [accepted, setAccepted] = useState(false);
  const [pay, setPay] = useState({ method: "upi", reference: "" });
  const choosePlan = (value) => { setPlanId(value); const next = open.find((p) => String(p.id) === value); if (next && Number(instalment) < Number(next.min_instalment)) setInstalment(String(Number(next.min_instalment))); };
  const submit = () => businessWrite(biz.id, "jewellery/schemes", {
    requestKey, locationId, planId, ...(customer ? { contactId: customer.id } : { customer: { name: typed?.name?.trim() || "", phone: typed?.phone?.trim() || undefined,
      consents: consentChanges(typed?.consents, []) || undefined } }),
    instalment, nomineeName: nominee.name.trim() || undefined, nomineeRelation: nominee.relation.trim() || undefined, termsAccepted: accepted,
    payment: { ...methods.body(pay.method, PAY_KINDS), reference: pay.reference.trim() || undefined },
  });
  return (
    <FormDialog title="Enrol in a gold scheme" icon="calendar" width={760} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Enrol and take the first instalment"
      successMessage={(s) => `Scheme ${s.scheme_no} for ${s.member_name}: first instalment ${biz.exact(s.instalment)} taken.`}
      description="The customer pays every month; the money is turned into jewellery on a jewellery bill within the year, never paid back in money.">
      {open.length === 0 ? <p className="field-wide jw-note">No plan is switched on: set one up under Settings › Gold scheme plans.</p> : (
        <>
          <Field label="Plan" wide>
            <select value={planId} onChange={(e) => choosePlan(e.target.value)}>{open.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.instalments} months · from {biz.exact(p.min_instalment)}</option>)}</select>
          </Field>
          {typed ? (
            <>
              <Field label="Customer's name"><input required maxLength={150} value={typed.name} onChange={(e) => setTyped((c) => ({ ...c, name: e.target.value }))} /></Field>
              <Field label="Phone"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((c) => ({ ...c, phone: e.target.value }))} /></Field>
              <NewCustomerConsents value={typed.consents} onChange={(consents) => setTyped((c) => ({ ...c, consents }))} />
              <div className="field-wide"><button type="button" className="link-button" onClick={() => setTyped(null)}>Find a customer instead</button></div>
            </>
          ) : (
            <div className="field-wide jw-row">
              <div className="field jw-grow">
                <SearchPicker label="Customer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
                  search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                  getLabel={(x) => x.name} getDescription={(x) => x.phone || ""} />
              </div>
              {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setCustomer(null); setTyped({ name: "", phone: "" }); }}><Icon name="user" size={15} /> New customer</button>}
            </div>
          )}
          <Field label="Each month (₹)" hint={plan ? `At least ${biz.exact(plan.min_instalment)}, in whole rupees.` : undefined}>
            <input required type="number" min={plan ? Number(plan.min_instalment) : 1} step="1" value={instalment} onChange={(e) => setInstalment(e.target.value)} />
          </Field>
          {locations.length > 1 && <Field label="At"><select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
          <Field label="Nominee (optional)"><input maxLength={150} value={nominee.name} onChange={(e) => setNominee((n) => ({ ...n, name: e.target.value }))} /></Field>
          <Field label="Nominee's relation"><input maxLength={60} value={nominee.relation} onChange={(e) => setNominee((n) => ({ ...n, relation: e.target.value }))} placeholder="e.g. Son" /></Field>
          {plan && (
            <div className="field-wide jw-scheme-terms">
              <p><strong>{plan.instalments} instalments of {biz.exact(Number(instalment) || 0)}</strong>; with every one paid, a discount of {biz.exact(Math.round(Number(instalment || 0) * Number(plan.discount_percent)) / 100)} on the jewellery bill from the scheme's maturity.</p>
              <pre>{plan.terms}</pre>
            </div>
          )}
          <label className="field-wide checkbox bz-check"><input type="checkbox" required checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> The customer has read and accepts these terms</label>
          <PaidBy methods={methods} value={pay} onChange={setPay} />
          <p className="field-wide muted small">{CASH_RULE}</p>
        </>
      )}
    </FormDialog>
  );
}

function PayForm({ biz, scheme, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [pay, setPay] = useState({ method: "upi", reference: "" });
  const next = Number(scheme.paid_count) + 1;
  return (
    <FormDialog title={`Instalment ${next} of ${scheme.instalments}`} icon="wallet" onClose={onClose} onSaved={onSaved} submitLabel={`Take ${biz.exact(scheme.instalment)}`}
      successMessage="Instalment taken." description={`${scheme.member_name}'s scheme ${scheme.scheme_no}, due ${dateShort(scheme.next_due, { year: true })}.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/schemes/${scheme.id}/instalments`, { requestKey, ...methods.body(pay.method, PAY_KINDS), reference: pay.reference.trim() || undefined })}>
      <PaidBy methods={methods} value={pay} onChange={setPay} />
      <p className="field-wide muted small">{CASH_RULE}</p>
    </FormDialog>
  );
}

function StopForm({ biz, scheme, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [approval, setApproval] = useState(emptyApproval);
  return (
    <FormDialog title={`Stop scheme ${scheme.scheme_no}`} icon="alert" onClose={onClose} onSaved={onSaved} submitLabel="Stop the scheme" successMessage="Stopped."
      description={`No more instalments and no discount. The ${biz.exact(scheme.paid)} paid is still used on a jewellery bill by ${dateShort(scheme.close_by, { year: true })}: it is never paid back in money.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/schemes/${scheme.id}/stop`, { reason: reason.trim(), approval: approvalBody(approval) })}>
      <Field label="Why" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Cannot pay the instalments" /></Field>
      <JewelleryApproval title="A manager approves" value={approval} onChange={setApproval} />
    </FormDialog>
  );
}

// Day 364: the scheme's money billed as metal at today's rate, held in the customer's safekeeping.
function CloseForm({ biz, scheme, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [purity, setPurity] = useState("gold:22K");
  const [preview, setPreview] = useState({ key: "", data: null, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/schemes/${scheme.id}/close`, splitPurity(purity), controller.signal).then((data) => setPreview({ key: purity, data, error: "" }))
      .catch((err) => { if (!controller.signal.aborted) setPreview({ key: purity, data: null, error: getErrorMessage(err) }); });
    return () => controller.abort();
  }, [biz.id, scheme.id, purity]);
  const shown = preview.key === purity ? preview : { data: null, error: "" };
  return (
    <FormDialog title={`Close scheme ${scheme.scheme_no} on its day 364`} icon="calendar" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Close it into safekeeping"
      disabled={!shown.data?.enough} successMessage="Closed: the metal is held for the customer."
      description={`${scheme.member_name}'s ${biz.exact(scheme.held)} is billed as metal at today's rate and set aside from the shop's metal, held in their safekeeping (never sold to anyone else) until they collect it.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/schemes/${scheme.id}/close`, { requestKey, ...splitPurity(purity) })}>
      <Field label="Billed as"><select value={purity} onChange={(e) => setPurity(e.target.value)}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
      <ErrorMessage message={shown.error} />
      {shown.data && (
        <div className="field-wide jw-totals">
          <span>{grams(shown.data.netWeight)} at {perGram(biz, shown.data.rate)}</span><span>Bill {biz.exact(shown.data.total)}</span>
          <span>Due on collection {biz.exact(shown.data.due)}</span>
          {!shown.data.enough && <strong className="bz-minus">The shop holds {grams(shown.data.shopHolds)} of it here: bring the metal in first, or choose another purity.</strong>}
        </div>
      )}
    </FormDialog>
  );
}

// The customer collects the metal their scheme was closed into, paying the few rupees still due on its bill.
function CollectForm({ biz, scheme, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [pay, setPay] = useState({ method: "upi", reference: "" });
  const [note, setNote] = useState("");
  return (
    <FormDialog title={`${scheme.member_name} collects ${scheme.close_tag}`} icon="check" onClose={onClose} onSaved={onSaved} submitLabel="Hand it over" successMessage="Collected."
      description={`${grams(scheme.close_weight)} held in safekeeping since ${dateShort(scheme.closed_at, { year: true })}, sold on ${scheme.redeemed_document_no}. Anything still due on the bill is taken now.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/schemes/${scheme.id}/collect`, { requestKey, note: note.trim() || undefined,
        payment: { ...methods.body(pay.method, PAY_KINDS), reference: pay.reference.trim() || undefined } })}>
      <PaidBy methods={methods} value={pay} onChange={setPay} />
      <Field label="Note (optional)" wide><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Collected by her son with her letter" /></Field>
    </FormDialog>
  );
}

// The bill that redeemed the scheme was returned within its tenure: its money goes back onto the scheme.
function PutBackForm({ biz, scheme, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [amount, setAmount] = useState(scheme.put_back.amount);
  return (
    <FormDialog title={`Put the scheme's money back from ${scheme.put_back.documentNo}`} icon="undo" onClose={onClose} onSaved={onSaved} submitLabel="Put it back" successMessage="Back on the scheme."
      description={`Up to ${biz.exact(scheme.put_back.amount)} of what the scheme paid on the returned bill goes back onto it, to be redeemed on another jewellery bill by ${dateShort(scheme.close_by, { year: true })}. After that it stays on the bill as the customer's credit.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/schemes/${scheme.id}/put-back`, { requestKey, amount })}>
      <Field label="Amount"><input required type="number" min="0.01" max={scheme.put_back.amount} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
    </FormDialog>
  );
}

// A scheme's panel: the passbook, what it gives, and what can be done.
export function SchemePanel({ biz, schemeId, onClose, onChanged }) {
  const privacy = useShopPrivacy();
  const [scheme, setScheme] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    if (!schemeId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/schemes/${schemeId}`, undefined, controller.signal).then((s) => { setScheme(s); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, schemeId, version]);
  const done = () => { setDialog(null); setVersion((n) => n + 1); onChanged?.(); };
  const stage = scheme ? SCHEME_STAGES[scheme.stage] : null;
  const facts = useMemo(() => (scheme ? [
    ["Member", `${scheme.member_name}${scheme.member_phone ? ` · ${scheme.member_phone}` : ""}`], ["Plan", `${scheme.plan_name} · ${scheme.instalments} × ${biz.exact(scheme.instalment)}`],
    ["Nominee", scheme.nominee_name ? `${scheme.nominee_name}${scheme.nominee_relation ? ` (${scheme.nominee_relation})` : ""}` : null],
    ["Joined", `${dateShort(scheme.started_on, { year: true })} · terms accepted ${dateTime(scheme.terms_accepted_at)}`],
    ["Matures", dateShort(scheme.maturity_on, { year: true })], ["Close by", `${dateShort(scheme.close_by, { year: true })}${scheme.status !== "redeemed" ? ` (${scheme.days_left} days)` : ""}`],
    ["Paid in", `${biz.exact(scheme.paid)} · ${scheme.paid_count} of ${scheme.instalments}`],
    ["Discount", scheme.status === "redeemed" ? `${biz.exact(scheme.discount)} on ${scheme.redeemed_document_no}` : scheme.status === "stopped" ? "None: the scheme was stopped"
      : `${biz.exact(scheme.discount_when_complete)} with every instalment paid, from its maturity (about ${scheme.yearly_rate}% a year)`],
    ["Stopped", scheme.stopped_at ? `${dateTime(scheme.stopped_at)} · ${scheme.stop_reason} · approved by ${scheme.stop_approved_by_name}` : null],
    ["Safekeeping", scheme.close_id ? `${grams(scheme.close_weight)} as piece ${scheme.close_tag}, closed ${dateTime(scheme.closed_at)}${scheme.collected_at ? ` · collected ${dateTime(scheme.collected_at)} by ${scheme.collected_by_name}` : " · waiting to be collected"}` : null],
    ["Money put back", (scheme.moves || []).length ? scheme.moves.map((m) => `${m.kind === "back" ? "Back from" : "Used on"} ${m.document_no} ${biz.exact(m.amount)}`).join(" · ") : null],
    ["Location", biz.locations.length > 1 ? scheme.location_name : null],
  ].filter(([, value]) => value) : []), [scheme, biz]);
  return (
    <SidePanel open title={scheme ? `Gold scheme ${scheme.scheme_no}` : "Gold scheme"} icon="calendar" wide onClose={onClose}
      footer={scheme && (
        <div className="jw-panel-actions">
          {scheme.can_pay && biz.can("jewellery.create") && biz.can("sales.edit") && <button type="button" className="button" onClick={() => setDialog("pay")}><Icon name="wallet" size={15} /> Take the instalment</button>}
          {scheme.can_close && biz.can("jewellery.approve") && biz.can("sales.create") && <button type="button" className="button" onClick={() => setDialog("close")}><Icon name="calendar" size={15} /> Close on day 364</button>}
          {scheme.can_collect && biz.can("jewellery.create") && biz.can("sales.edit") && <button type="button" className="button" onClick={() => setDialog("collect")}><Icon name="check" size={15} /> Collected</button>}
          {scheme.put_back && scheme.put_back.withinTenure && biz.can("jewellery.create") && biz.can("sales.refund") && (
            <button type="button" className="button button-secondary" onClick={() => setDialog("back")}><Icon name="undo" size={15} /> Put back from {scheme.put_back.documentNo}</button>
          )}
          {scheme.status !== "redeemed" && biz.can("jewellery.create") && biz.can("sales.edit") && (
            <Link className="button button-secondary" to={`${biz.path("jewellery-bill")}?scheme=${scheme.id}`}><Icon name="receipt" size={15} /> Redeem on a jewellery bill</Link>
          )}
          {scheme.status !== "redeemed" && scheme.member_phone && (
            <ConsentLink privacy={privacy} purpose="reminders" person={{ id: scheme.contact_id, name: scheme.member_name }} href={schemeReminder(biz, scheme)}
              className="button button-secondary">Remind on WhatsApp</ConsentLink>
          )}
          {biz.can("jewellery.print") && <button type="button" className="button button-secondary" onClick={() => printSchemePassbook(biz, scheme)}><Icon name="print" size={15} /> Print the passbook</button>}
          {scheme.status === "active" && biz.can("jewellery.cancel") && <button type="button" className="button button-secondary danger" onClick={() => setDialog("stop")}>Stop</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!scheme ? !error && <Loading /> : (
        <div className="stack">
          <div className="jw-piece-head">
            <Badge tone={stage?.tone} label={stage?.label || scheme.stage} />
            <strong>{scheme.member_name}</strong>
            <span className="muted">{biz.exact(scheme.paid)} paid in</span>
          </div>
          <dl className="jw-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          <table className="jw-rates">
            <thead><tr><th scope="col">No.</th><th scope="col">Due</th><th scope="col">Paid</th><th scope="col">Receipt</th><th scope="col">Amount</th></tr></thead>
            <tbody>{scheme.schedule.map((i) => (
              <tr key={i.seq} className={i.late ? "jw-late" : ""}>
                <th scope="row">{i.seq}</th><td>{dateShort(i.due_on, { year: true })}</td>
                <td>{i.paid ? `${dateShort(i.paid.paid_on, { year: true })} · ${i.paid.method_name || KIND_WORDS[i.paid.method] || i.paid.method}` : i.late ? <span className="bz-minus">Late</span> : <span className="muted">—</span>}</td>
                <td className="mono">{i.paid?.collection_no || ""}</td><td>{biz.exact(i.paid ? i.paid.amount : scheme.instalment)}</td>
              </tr>
            ))}</tbody>
          </table>
          <details><summary>Terms as accepted</summary><pre className="jw-terms">{scheme.terms}</pre></details>
        </div>
      )}
      {dialog === "pay" && <PayForm biz={biz} scheme={scheme} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog === "stop" && <StopForm biz={biz} scheme={scheme} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog === "close" && <CloseForm biz={biz} scheme={scheme} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog === "collect" && <CollectForm biz={biz} scheme={scheme} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog === "back" && <PutBackForm biz={biz} scheme={scheme} onClose={() => setDialog(null)} onSaved={done} />}
    </SidePanel>
  );
}
