import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { balanceText, dateShort, relative } from "@bmp/shared/format";
import { word } from "../../../../services/businessNav";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field, FormError } from "../../core/pages/ui";
import { CHEQUE_STATUS, STATEMENT_KINDS, chequeWord, printStatements, reminderText, whatsappLink } from "./receivablesFormat";
import "../../../../styles/business-trade.css";
import { businessToday, newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
// A reminder (a call, a WhatsApp, an SMS) needs the customer's consent to reminders.
import ConsentLink from "../../../personal-data/components/ConsentLink";
import { useConsentGate } from "../../../personal-data/useConsentGate";
import { REMINDER_CHANNELS, notAgreed } from "../../../personal-data/personalData";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";

// Shared receivables pieces: recording a collection, a customer's account
// (open bills with their age, advances, cheques, reminders), follow-ups and
// the statement.

// Record money received from a customer — the one collection form, opened
// from Collections, Outstanding, a customer's account and a sale. Automatic
// allocation settles the oldest bills first (an old opening balance before
// any bill); "bills I choose" names them; "keep as advance" settles nothing
// yet. A cheque carries its date and bank.
export function CollectionDialog({ contactId: fixedContact, documentId, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const wholesale = biz.has("sales_orders") && biz.can("sales_orders.view");
  const customerPath = wholesale ? "customer-beats" : "contacts?kind=customer&active=true";
  const { options, error } = useOptions([customerPath, ...(wholesale ? ["salespeople?active=true", "routes?active=true"] : [])]);
  const locations = biz.locations.filter((l) => l.active);
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ contactId: fixedContact ? String(fixedContact) : "", locationId: String(locations[0]?.id || ""), amount: "", method: "cash",
    reference: "", chequeDate: today, bank: "", notes: "", mode: documentId ? "choose" : "auto", salespersonId: "", routeId: "" });
  // `form.method`: one of the business's own methods; the cheque fields go by its kind.
  const methods = usePaymentMethods();
  const kind = methods.kindOf(form.method);
  const [bills, setBills] = useState(null);
  const [account, setAccount] = useState(null);
  const [amounts, setAmounts] = useState({});
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  // Trade customers by name (walk-ins left out), with what they owe.
  const customers = useMemo(() => (options?.[customerPath] || [])
    .filter((c) => c.trade_type !== "walk_in" || String(c.id) === String(fixedContact))
    .slice().sort((a, b) => a.name.localeCompare(b.name)), [options, customerPath, fixedContact]);
  const customer = customers.find((c) => String(c.id) === form.contactId) || null;

  useEffect(() => {
    if (!form.contactId) return undefined;
    const controller = new AbortController();
    Promise.all([
      businessRead(biz.id, `receivables/customers/${form.contactId}/open-bills`, undefined, controller.signal),
      businessRead(biz.id, `receivables/customers/${form.contactId}`, undefined, controller.signal),
    ]).then(([rows, acc]) => {
      setBills(rows); setAccount(acc);
      // From a sale: that bill, for what is still open on it.
      const bill = documentId ? rows.find((b) => String(b.id) === String(documentId)) : null;
      setAmounts(bill ? { [bill.id]: Number(bill.outstanding).toFixed(2) } : {});
      if (bill) setForm((f) => ({ ...f, amount: f.amount || Number(bill.outstanding).toFixed(2) }));
    }).catch(() => { if (!controller.signal.aborted) { setBills([]); setAccount(null); } });
    return () => controller.abort();
  }, [biz.id, form.contactId, documentId]);
  // The beat's salesperson and route are the defaults for a wholesale collection.
  const salespersonId = form.salespersonId || (customer?.salesperson_id ? String(customer.salesperson_id) : "");
  const routeId = form.routeId || (customer?.route_id ? String(customer.route_id) : "");
  const owes = Number(account?.summary?.balance ?? customer?.balance ?? 0);
  const overdue = Number(account?.summary?.overdue || 0);

  const chosen = Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const submit = () => businessWrite(biz.id, "collections", {
    contactId: form.contactId, locationId: form.locationId, amount: form.amount, ...methods.body(form.method), requestKey,
    reference: form.reference || undefined, notes: form.notes || undefined,
    ...(kind === "cheque" ? { chequeDate: form.chequeDate || undefined, bank: form.bank || undefined } : {}),
    ...(form.mode === "advance" ? { allocations: [] } : {}),
    ...(form.mode === "choose" ? { allocations: Object.entries(amounts).filter(([, v]) => Number(v) > 0).map(([id, amount]) => ({ documentId: Number(id), amount })) } : {}),
    ...(wholesale && salespersonId ? { salespersonId } : {}),
    ...(wholesale && routeId ? { routeId } : {}),
  });
  const quick = [owes > 0 && { label: `Full ${biz.exact(owes)}`, value: owes }, overdue > 0 && overdue < owes && { label: `Overdue ${biz.exact(overdue)}`, value: overdue }].filter(Boolean);
  return (
    <FormDialog title={`Record a ${word(biz.type, "collections", "collection").toLowerCase().replace(/s$/, "")}`} icon="wallet" width={780} submitLabel="Save receipt"
      onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}
      description="A numbered receipt is issued. Money is put against the customer's bills; anything left over stays as their advance.">
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      <div className="field">
        <SearchPicker label="Customer" required value={customer} disabled={Boolean(fixedContact)} options={customers}
          onChange={(c) => { setForm((f) => ({ ...f, contactId: c ? String(c.id) : "", amount: "", salespersonId: "", routeId: "" })); setBills(null); setAccount(null); }}
          getKey={(c) => c.id} getLabel={(c) => c.name} getKeywords={(c) => `${c.phone || ""} ${c.route_name || ""} ${c.beat_name || ""} ${c.gstin || ""}`}
          getDescription={(c) => [balanceText(c.balance), c.route_name && `${c.route_name}${c.beat_name ? ` · ${c.beat_name}` : ""}`].filter(Boolean).join(" · ")}
          placeholder="Name, phone or route" name="contact_id" />
      </div>
      {locations.length > 1 ? (
        <Field label="Received at">
          <select required value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </Field>
      ) : <div className="field bz-owes-card" aria-live="polite">{account ? <OwesLine summary={account.summary} /> : <span className="muted small">Choose a customer to see what they owe.</span>}</div>}
      {locations.length > 1 && account && <div className="field-wide bz-owes-card"><OwesLine summary={account.summary} /></div>}
      <Field label="Amount received" hint={quick.length ? undefined : customer ? balanceText(owes) : undefined}>
        <input required type="number" min="0.01" step="0.01" inputMode="decimal" value={form.amount} onChange={set("amount")} />
      </Field>
      <Field label="Paid by">
        <select value={methods.resolve(form.method)} onChange={set("method")}>{methods.options().map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
      </Field>
      {quick.length > 0 && (
        <div className="field-wide bz-quick-amounts" role="group" aria-label="Fill in the amount">
          {quick.map((q) => <button key={q.label} type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, amount: q.value.toFixed(2) }))}>{q.label}</button>)}
        </div>
      )}
      <Field label={kind === "cheque" ? "Cheque number" : "Reference (optional)"}>
        <input required={kind === "cheque"} maxLength={100} value={form.reference} onChange={set("reference")} placeholder={kind === "upi" ? "UPI transaction ID" : kind === "cheque" ? "6-digit number" : undefined} />
      </Field>
      {kind === "cheque" && (
        <>
          <Field label="Cheque date" hint={form.chequeDate > today ? "Post-dated: it can be deposited from this date." : undefined}>
            <input type="date" required value={form.chequeDate} onChange={set("chequeDate")} />
          </Field>
          <Field label="Bank (optional)"><input maxLength={100} value={form.bank} onChange={set("bank")} placeholder="e.g. HDFC Bank, Hadapsar" /></Field>
        </>
      )}
      {wholesale && (
        <>
          <Field label="Collected by">
            <select value={salespersonId} onChange={set("salespersonId")}>
              <option value="">Office</option>
              {(options?.["salespeople?active=true"] || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Route">
            <select value={routeId} onChange={set("routeId")}>
              <option value="">None</option>
              {(options?.["routes?active=true"] || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
        </>
      )}
      <Field label="Put it against" wide>
        <select value={form.mode} onChange={set("mode")}>
          <option value="auto">Oldest bills first (automatic)</option>
          <option value="choose">Bills I choose</option>
          <option value="advance">Nothing yet — keep as an advance</option>
        </select>
      </Field>
      {form.mode === "choose" && (
        <div className="field-wide bz-lines">
          {!form.contactId ? <p className="muted small">Choose the customer first.</p> : !bills ? <Loading /> : (
            <DataGrid variant="editor" caption="Open bills" rows={bills} rowKey={(b) => b.id} currency={biz.symbol} empty="No open bills" columns={[
              { key: "no", header: "Bill", value: (b) => b.document_no, render: (b) => <span className="mono">{b.document_no}</span> },
              { key: "date", header: "Date", type: "date", value: (b) => b.created_at },
              { key: "due", header: "Due", type: "date", value: (b) => b.due_on },
              { key: "outstanding", header: "Open", type: "money", exact: true, value: (b) => Number(b.outstanding), total: "sum" },
              { key: "pay", header: "Pay now", type: "money", exact: true, value: (b) => Number(amounts[b.id]) || 0, total: "sum", render: (b, ctx) => (
                <input aria-label={ctx.label} type="number" min="0" step="0.01" max={b.outstanding} value={amounts[b.id] || ""} onChange={(e) => setAmounts((a) => ({ ...a, [b.id]: e.target.value }))} />
              ) },
            ]} />
          )}
          <span className="muted small">Chosen {biz.exact(chosen)}{Number(form.amount) > chosen ? ` · ${biz.exact(Number(form.amount) - chosen)} stays as advance` : ""}</span>
        </div>
      )}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// "Owes ₹28,447.40 · ₹17,119.40 overdue · oldest bill 76 days" for a customer.
function OwesLine({ summary }) {
  const biz = useOpenBusiness();
  if (!summary) return null;
  const balance = Number(summary.balance);
  return (
    <span className="bz-owes-line">
      <strong className={balance > 0 ? "bz-due" : ""}>{balanceText(balance, { exact: true }).replace("₹", biz.symbol)}</strong>
      {Number(summary.overdue) > 0 && <span className="bz-due"> · {biz.exact(summary.overdue)} overdue</span>}
      {Number(summary.most_days_overdue) > 0 && <span className="muted"> · {summary.most_days_overdue} days late</span>}
      {Number(summary.uncleared_cheques) > 0 && <span className="muted"> · cheques in hand {biz.exact(summary.uncleared_cheques)}</span>}
    </span>
  );
}

// Note a call, a WhatsApp or a visit, and the date and amount promised.
export function FollowUpDialog({ customer, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ channel: "call", promisedOn: "", promisedAmount: "", note: "" });
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const gate = useConsentGate(useShopPrivacy());
  const person = { id: customer.contact_id || customer.id, name: customer.name };
  const submit = async () => {
    if (REMINDER_CHANNELS.includes(form.channel) && !(await gate.ensure("reminders", person, { sending: false }))) throw notAgreed(customer.name, "reminders");
    return businessWrite(biz.id, `receivables/customers/${person.id}/follow-ups`, {
      channel: form.channel, promisedOn: form.promisedOn || undefined, promisedAmount: form.promisedAmount || undefined, note: form.note || undefined });
  };
  return (
    <FormDialog title={`Follow up · ${customer.name}`} icon="phone" width={560} submitLabel="Save" onClose={onClose} onSaved={onSaved}
      successMessage={(r) => (r.promised_on ? `Promise noted: ${dateShort(r.promised_on)}` : "Follow-up noted")}
      description={`${balanceText(customer.balance)}${Number(customer.overdue) > 0 ? ` · ${biz.exact(customer.overdue)} overdue` : ""}`}
      onSubmit={submit}>
      {gate.dialog}
      <Field label="How">
        <select value={form.channel} onChange={set("channel")}>
          <option value="call">Phone call</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option><option value="visit">Visit</option><option value="other">Other</option>
        </select>
      </Field>
      <Field label="Promised to pay on (optional)"><input type="date" min={today} value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      <Field label="Amount promised (optional)"><input type="number" min="0.01" step="0.01" value={form.promisedAmount} onChange={set("promisedAmount")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={250} value={form.note} onChange={set("note")} placeholder="e.g. Will send cheque with the salesman" /></Field>
    </FormDialog>
  );
}

// Deposit, cleared or bounced. A bounce needs credit control. The bank charge
// starts at the business's setting (Rs 500 unless changed) and can be changed
// for this cheque; reaching the bounce limit puts the customer on credit hold.
export function ChequeActionDialog({ cheque, action, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ depositedInto: "", reason: "", charge: action === "bounce" ? "500" : "" });
  const [rules, setRules] = useState(null);
  useEffect(() => {
    if (action !== "bounce") return undefined;
    const controller = new AbortController();
    // Without the wholesale module the defaults apply (Rs 500; 2 bounces in 90 days).
    businessRead(biz.id, "wholesale-settings", undefined, controller.signal)
      .then((s) => { setRules(s); setForm((f) => ({ ...f, charge: String(Number(s.bounce_charge ?? 500)) })); })
      .catch(() => setRules({ bounce_charge: "500.00", bounce_hold_count: 2, bounce_hold_days: 90 }));
    return () => controller.abort();
  }, [action, biz.id]);
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const titles = { deposit: "Deposit cheque", clear: "Cheque cleared", bounce: "Cheque bounced" };
  const amount = biz.exact(cheque.amount);
  return (
    <FormDialog title={`${titles[action]} · ${cheque.cheque_no}`} icon="wallet" width={540} onClose={onClose} onSaved={onSaved}
      submitLabel={{ deposit: "Mark deposited", clear: "Mark cleared", bounce: "Mark bounced" }[action]}
      successMessage={(r) => ({ deposit: `Cheque ${cheque.cheque_no} deposited`, clear: `Cheque ${cheque.cheque_no} cleared`,
        bounce: `Cheque ${cheque.cheque_no} marked bounced${r?.credit_hold ? ` · ${cheque.contact_name} is on credit hold (${r.credit_hold.bounces} bounces in ${r.credit_hold.days} days)` : ""}` }[action])}
      description={action === "bounce"
        ? `${amount} from ${cheque.contact_name} (${cheque.collection_no}) stops counting: exactly the bills it settled open again, and the bank charge is added to their account.`
        : `${amount} from ${cheque.contact_name} · ${cheque.collection_no}${cheque.bank ? ` · ${cheque.bank}` : ""}`}
      onSubmit={() => businessWrite(biz.id, `collections/${cheque.collection_id}/cheque`, action === "bounce"
        ? { action, reason: form.reason, charge: form.charge || undefined }
        : action === "deposit" ? { action, depositedInto: form.depositedInto || undefined } : { action })}>
      {action === "deposit" && <Field label="Deposited into (optional)" wide><input maxLength={100} value={form.depositedInto} onChange={set("depositedInto")} placeholder="e.g. SBI current account" /></Field>}
      {action === "bounce" && (
        <>
          <Field label="Why it bounced" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Funds insufficient" /></Field>
          <Field label="Bank charge to the customer" hint={`Your setting is ${biz.exact(rules?.bounce_charge ?? 500)}. Change it for this cheque, or 0 for none.`}>
            <input type="number" min="0" max="100000" step="0.01" required value={form.charge} onChange={set("charge")} />
          </Field>
          {rules?.bounce_hold_count ? (
            <p className="field-wide muted small"><Icon name="shield" size={13} /> {rules.bounce_hold_count} bounced cheques in {rules.bounce_hold_days} days put a customer on credit hold for new orders.</p>
          ) : null}
        </>
      )}
      {action === "clear" && <p className="field-wide muted">The money is in the bank. Nothing else changes on the customer's account.</p>}
    </FormDialog>
  );
}

// A customer's account: balance, age buckets, each open item, advances,
// cheques not yet cleared and the reminders sent.
export function AccountDialog({ contactId, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const today = businessToday(biz.business.timezone);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `receivables/customers/${contactId}`, undefined, controller.signal)
      .then((a) => { setAccount(a); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version]);
  const s = account?.summary || {};
  const free = (account?.advances || []).reduce((sum, a) => sum + Number(a.unallocated), 0);
  // Unapplied money first covers an opening balance (older than any bill); the rest is a true advance.
  const towardsOpening = account ? Math.min(free, Math.max(0, Number(account.contact.opening_balance))) : 0;
  const advance = Math.round((free - towardsOpening) * 100) / 100;
  const applyAdvance = async () => {
    setBusy(true);
    try {
      const result = await businessWrite(biz.id, `receivables/customers/${contactId}/apply-advance`, { requestKey: newKey() });
      setVersion((n) => n + 1);
      toast.success(`${biz.exact(result.applied)} of advance put against the bills`);
      onChanged?.(`${biz.exact(result.applied)} of advance put against ${account.contact.name}'s bills.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const privacy = useShopPrivacy();
  const row = account ? { ...s, name: account.contact.name, contact_id: account.contact.id } : null;
  const wa = account ? whatsappLink(account.contact.phone, reminderText(row, biz)) : null;
  return (
    <>
      <Modal title={account ? account.contact.name : "Loading…"} icon="wallet" width={980} onClose={() => { if (!action) onClose(); }}
        description={account ? [account.contact.phone, account.contact.gstin && `GSTIN ${account.contact.gstin}`, account.contact.credit_limit !== null && `credit limit ${biz.amount(account.contact.credit_limit)}`, `${account.contact.credit_days} credit days`].filter(Boolean).join(" · ") : undefined}>
        <ErrorMessage message={error} />
        {!account && !error && <Loading />}
        {account && (
          <div className="stack">
            <div className="bz-ageing" role="list" aria-label="Age of what is owed">
              {[["Owes now", s.balance, Number(s.balance) > 0 ? "danger" : "neutral"], [biz.ages.first, s.days_0_30], [biz.ages.second, s.days_31_60], [biz.ages.third, s.days_61_90], [biz.ages.over, s.days_over_90, Number(s.days_over_90) > 0 ? "danger" : ""], ["Overdue", s.overdue, Number(s.overdue) > 0 ? "warning" : ""]].map(([label, value, tone]) => (
                <div key={label} role="listitem" className={`bz-ageing-cell ${tone ? `is-${tone}` : ""}`}><small>{label}</small><strong>{biz.exact(value || 0)}</strong></div>
              ))}
            </div>
            <DataGrid variant="compact" id="receivables-open-items" caption="Open bills" rows={account.items} rowKey={(i) => `${i.document_id || i.reference}`} currency={biz.symbol} rowNoun={["bill", "bills"]}
              rowClassName={(i) => (i.overdue ? "dg-tone-danger" : "")} empty="Nothing open" columns={[
                { key: "reference", header: "Bill", value: (i) => i.reference, mobile: "title", render: (i) => <span className="mono">{i.reference}</span> },
                { key: "bill_date", header: "Date", type: "date", value: (i) => i.bill_date },
                { key: "due_on", header: "Due", type: "date", value: (i) => i.due_on },
                { key: "age", header: "Age (days)", type: "number", value: (i) => i.age_days, mobile: "show" },
                { key: "amount", header: "Bill balance", type: "money", exact: true, value: (i) => Number(i.amount) },
                { key: "open", header: "Still open", type: "money", exact: true, value: (i) => Number(i.open_amount), total: "sum", mobile: "show" },
                { key: "state", header: "Status", type: "status", value: (i) => (i.overdue ? "Overdue" : "Due"), render: (i) => <Badge tone={i.overdue ? "danger" : "warning"} label={i.overdue ? `Overdue ${i.days_overdue} d` : "Not yet due"} /> },
              ]} />
            {towardsOpening > 0 && <p className="muted"><Icon name="info" size={14} /> {biz.exact(towardsOpening)} received has gone against the opening balance of {biz.exact(account.contact.opening_balance)} ({account.advances.map((a) => a.collection_no).join(", ")}).</p>}
            {advance > 0 && <p className="muted"><Icon name="info" size={14} /> {biz.exact(advance)} received is an advance, not yet put against a bill. It already lowers what they owe.</p>}
            {account.cheques?.length > 0 && (
              <SectionCard icon="wallet" title="Cheques">
                <ul className="bz-history">
                  {account.cheques.map((c) => (
                    <li key={c.collection_id}>
                      <Badge tone={CHEQUE_STATUS[c.status]?.tone} label={chequeWord(c, today)} /> {c.cheque_no}{c.bank ? ` · ${c.bank}` : ""} · {biz.exact(c.amount)} · dated {dateShort(c.cheque_date)} · {c.collection_no}
                      {c.status === "bounced" && Number(c.bounce_charge) > 0 ? ` · charge ${biz.exact(c.bounce_charge)}` : ""}
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}
            {account.reminders?.length > 0 && (
              <SectionCard icon="phone" title="Follow-ups">
                <ul className="bz-history">
                  {account.reminders.map((m) => (
                    <li key={m.id}>
                      <strong>{{ call: "Call", whatsapp: "WhatsApp", sms: "SMS", visit: "Visit", other: "Note" }[m.channel] || m.channel}</strong> · {relative(m.created_at)} by {m.created_by_name}
                      {m.promised_on && <> · promised {dateShort(m.promised_on)}{m.promised_on < today && Number(s.balance) > 0 ? <span className="bz-due"> (broken)</span> : null}</>}
                      {m.note ? ` · ${m.note}` : ""}
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}
            <div className="form-actions bz-start">
              {biz.can("receivables.create") && <button type="button" className="button" onClick={() => setAction("collect")}><Icon name="wallet" size={16} /> Record collection</button>}
              {biz.can("receivables.create") && advance > 0 && account.items.some((i) => i.document_id) && <button type="button" className="button button-secondary" disabled={busy} onClick={applyAdvance}>Put advance against bills</button>}
              <button type="button" className="button button-secondary" onClick={() => setAction("statement")}><Icon name="file" size={15} /> Statement</button>
              {account.contact.phone && (
                <ConsentLink privacy={privacy} purpose="reminders" person={{ id: account.contact.id, name: account.contact.name }} href={`tel:${account.contact.phone}`}
                  className="button button-secondary"><Icon name="phone" size={15} /> Call</ConsentLink>
              )}
              {wa && <ConsentLink privacy={privacy} purpose="reminders" person={{ id: account.contact.id, name: account.contact.name }} href={wa} className="button button-secondary">WhatsApp reminder</ConsentLink>}
              {biz.can("receivables.create") && <button type="button" className="button button-secondary" onClick={() => setAction("follow")}>Note a promise</button>}
            </div>
          </div>
        )}
      </Modal>
      {action === "collect" && <CollectionDialog contactId={contactId} onClose={() => setAction(null)}
        onSaved={(c) => { setAction(null); setVersion((n) => n + 1); toast.success(`Receipt ${c.collection_no} saved`); onChanged?.(`Receipt ${c.collection_no} saved for ${biz.exact(c.amount)}.`); }} />}
      {action === "statement" && account && <StatementDialog contact={account.contact} from={s.oldest_bill || undefined} onClose={() => setAction(null)} />}
      {action === "follow" && row && <FollowUpDialog customer={row} onClose={() => setAction(null)} onSaved={() => { setAction(null); setVersion((n) => n + 1); onChanged?.(""); }} />}
    </>
  );
}

// The statement opens from the oldest unpaid bill when there is one,
// so the bills behind the balance are on it; otherwise the current month.
function StatementDialog({ contact, from, onClose }) {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: from && from < monthStart(anchor) ? from : monthStart(anchor), to: anchor });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `receivables/customers/${contact.id}/statement`, range, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contact.id, range]);
  const columns = useMemo(() => [
    { key: "day", header: "Date", type: "date", value: (e) => e.day, mobile: "subtitle" },
    { key: "kind", header: "What", value: (e) => STATEMENT_KINDS[e.kind] || e.kind, mobile: "title" },
    { key: "reference", header: "Reference", value: (e) => e.reference, mobile: "show" },
    { key: "debit", header: "Debit", type: "money", exact: true, value: (e) => Number(e.debit) || null, total: "sum", mobile: "show" },
    { key: "credit", header: "Credit", type: "money", exact: true, value: (e) => Number(e.credit) || null, total: "sum", mobile: "show" },
    { key: "balance", header: "Balance", type: "money", exact: true, value: (e) => Number(e.balance), total: "none" },
  ], []);
  return (
    <Modal title={`Statement · ${contact.name}`} icon="file" width={900} onClose={onClose}
      description={data ? `Brought forward ${biz.exact(data.opening)} · closing ${biz.exact(data.closing)}` : undefined}>
      <ErrorMessage message={error} />
      <SectionCard flush icon="list" title="Entries" actions={data && biz.can("receivables.print") && <button type="button" className="button button-secondary button-sm" onClick={() => printStatements([data], biz)}><Icon name="print" size={15} /> Print</button>}>
        <DataGrid id="receivables-statement" caption="Statement" columns={columns} rows={data?.entries || []} rowKey={(e, i) => `${e.kind}-${e.reference}-${i}`}
          loading={!data && !error} currency={biz.symbol} pageSize={50} rowNoun={["entry", "entries"]}
          toolbar={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="statement dates" onChange={(next) => next.from && next.to && setRange(next)} />}
          exportName={biz.can("receivables.export") ? `statement-${contact.name}` : undefined} empty="No entries in these dates" emptyIcon="file" />
      </SectionCard>
    </Modal>
  );
}

