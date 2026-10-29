import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { atWords, dayWords, firstOutlet } from "./fuel";
import "../styles/fuel.css";

// The attendants' accounts: a shift closed short leaves the short due from
// its attendant (the walk-in bills are paid it from their account, so nothing
// is left due on them); an excess is held on the account. A short is
// recovered when the attendant pays it, or by a deduction when they are paid
// their wages (the wages paid out go in the expense book); an excess goes to
// other income only when a manager takes it there. What is paid in and what
// goes to income are money in on the day's money. Per attendant and period.

const KIND_WORDS = { short: "Short on a shift", excess: "Excess on a shift", short_reversed: "Short reversed (shift reopened)", excess_reversed: "Excess reversed (shift reopened)",
  paid: "Paid by the attendant", deducted: "Deducted from the wages", to_income: "Excess taken to income" };

export default function AttendantsPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/attendant-accounts", { from, to }, controller.signal)
      .then((x) => { setData(x); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, from, to, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const totals = data?.totals;
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Attendants' accounts"
        description="What each attendant owes for shifts closed short, and the excess held for them; recovered when they pay or from their wages, an excess taken to income by a manager." />
      <div className="fuel-toolbar">
        <label className="field fuel-outlet"><span>From</span><input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="field fuel-outlet"><span>To</span><input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      <ErrorMessage message={error} />
      {totals && (
        <div className="stat-grid">
          <StatTile icon="alert" tone={Number(totals.due) > 0 ? "danger" : "success"} label="Owed by attendants now" value={biz.exact(totals.due)} note={`${biz.exact(totals.short)} short in the period`} />
          <StatTile icon="wallet" tone="neutral" label="Recovered in the period" value={biz.exact(Number(totals.paid) + Number(totals.deducted))} note={`${biz.exact(totals.deducted)} from wages`} />
          <StatTile icon="cash" tone={Number(totals.held) > 0 ? "warning" : "neutral"} label="Excess held now" value={biz.exact(totals.held)} note={`${biz.exact(totals.toIncome)} taken to income`} />
        </div>
      )}
      <SectionCard flush icon="users" title={`Attendants · ${dayWords(from)} to ${dayWords(to)}`}>
        <DataGrid variant="compact" id="fuel-attendant-accounts" caption="Attendants' accounts" rows={data?.items || []} loading={!data && !error} rowKey={(x) => x.attendantId}
          currency={biz.symbol} rowNoun={["attendant", "attendants"]} onRowClick={(x) => setDialog({ kind: "account", person: x })}
          exportName={biz.can("fuel.export") ? `${biz.business.code}-attendants-${from}-${to}` : undefined}
          columns={[
            { key: "name", header: "Attendant", value: (x) => x.name, mobile: "title", pin: true },
            { key: "opening", header: "Owed before", type: "money", exact: true, value: (x) => Number(x.opening.due), defaultHidden: true },
            { key: "short", header: "Short", type: "money", exact: true, value: (x) => Number(x.period.short) - Number(x.period.shortReversed), total: "sum" },
            { key: "excess", header: "Excess", type: "money", exact: true, value: (x) => Number(x.period.excess) - Number(x.period.excessReversed), total: "sum" },
            { key: "paid", header: "Paid", type: "money", exact: true, value: (x) => Number(x.period.paid), total: "sum" },
            { key: "deducted", header: "From wages", type: "money", exact: true, value: (x) => Number(x.period.deducted), total: "sum" },
            { key: "income", header: "To income", type: "money", exact: true, value: (x) => Number(x.period.toIncome), total: "sum" },
            { key: "due", header: "Owes now", type: "money", exact: true, value: (x) => Number(x.closing.due), total: "sum", mobile: "show" },
            { key: "held", header: "Held now", type: "money", exact: true, value: (x) => Number(x.closing.held), total: "sum" },
            { key: "actions", header: "", label: "Actions", type: "actions", render: (x) => (
              <span className="fuel-inline">
                {biz.can("fuel.edit") && Number(x.closing.due) > 0 && <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); setDialog({ kind: "paid", person: x }); }}>Paid</button>}
                {biz.can("fuel.approve") && Number(x.closing.due) > 0 && <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); setDialog({ kind: "deducted", person: x }); }}>From wages</button>}
                {biz.can("fuel.approve") && Number(x.closing.held) > 0 && <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); setDialog({ kind: "to_income", person: x }); }}>To income</button>}
              </span>
            ) },
          ]}
          empty="No shorts or excess yet" emptyHint="A shift closed short or in excess opens its attendant's account." emptyIcon="users" />
      </SectionCard>
      {dialog && dialog.kind !== "account" && <EntryDialog biz={biz} kind={dialog.kind} person={dialog.person} onClose={() => setDialog(null)} onSaved={() => reload("Saved on the attendant's account.")} />}
      {dialog?.kind === "account" && <AccountDialog biz={biz} person={dialog.person} from={from} to={to} onClose={() => setDialog(null)} />}
    </div>
  );
}

// The attendant pays, a deduction from their wages, or their excess to income.
function EntryDialog({ biz, kind, person, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const due = kind === "to_income" ? person.closing.held : person.closing.due;
  const [form, setForm] = useState({ amount: String(Number(due).toFixed(2)), method: "cash", note: "", wages: "", wagesMethod: "cash" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const path = { paid: "pay", deducted: "deduct", to_income: "to-income" }[kind];
  const title = { paid: `${person.name} pays`, deducted: `Deduct from ${person.name}'s wages`, to_income: `${person.name}'s excess to income` }[kind];
  const submit = () => businessWrite(biz.id, `fuel/attendant-accounts/${person.attendantId}/${path}`, { requestKey, locationId: firstOutlet(biz), amount: form.amount.trim(),
    ...(kind === "paid" ? { method: form.method } : {}), note: form.note.trim() || null,
    ...(kind === "deducted" && form.wages.trim() ? { wages: form.wages.trim(), wagesPaidBy: { method: form.wagesMethod } } : {}) });
  return (
    <FormDialog title={title} icon="wallet" width={520} onClose={onClose} onSaved={onSaved} onSubmit={submit} submitLabel="Save"
      description={kind === "to_income" ? `${biz.exact(due)} is held for them. It shows as other income on the day's money.` : `They owe ${biz.exact(due)}.`}>
      <Field label={`Amount (${biz.symbol})`}><input required inputMode="decimal" className="mono" value={form.amount} onChange={set("amount")} /></Field>
      {kind === "paid" && (
        <Field label="Paid by">
          <select value={form.method} onChange={set("method")}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank">Bank transfer</option></select>
        </Field>
      )}
      {kind === "deducted" && (
        <>
          <Field label={`Wages paid out now (${biz.symbol}, optional)`} hint="What is paid after the deduction: it goes in the expense book as wages."><input inputMode="decimal" className="mono" value={form.wages} onChange={set("wages")} /></Field>
          <Field label="Wages paid by">
            <select value={form.wagesMethod} onChange={set("wagesMethod")}><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank transfer</option></select>
          </Field>
        </>
      )}
      <Field label={kind === "paid" ? "Note (optional)" : kind === "to_income" ? "Why it goes to income" : "What the deduction is for"} wide>
        <input required={kind !== "paid"} maxLength={300} value={form.note} onChange={set("note")} placeholder={kind === "deducted" ? "e.g. October wages" : ""} />
      </Field>
    </FormDialog>
  );
}

// One attendant's account in the period, entry by entry.
function AccountDialog({ biz, person, from, to, onClose }) {
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `fuel/attendant-accounts/${person.attendantId}`, { from, to }, controller.signal).then(setAccount)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, person.attendantId, from, to]);
  return (
    <FormDialog title={`${person.name}'s account`} icon="users" width={720} onClose={onClose} onSaved={onClose} onSubmit={async () => null} submitLabel="Close"
      description={account ? `Owes ${biz.exact(account.now.due)} now · ${biz.exact(account.now.held)} held for them.` : undefined}>
      <ErrorMessage message={error} />
      <div className="field-wide">
        <DataGrid variant="compact" id="fuel-attendant-entries" caption="Entries" rows={account?.entries || []} loading={!account && !error} rowKey={(e) => e.id} currency={biz.symbol}
          rowNoun={["entry", "entries"]}
          columns={[
            { key: "at", header: "When", value: (e) => e.created_at, render: (e) => atWords(e.created_at, biz), mobile: "title" },
            { key: "kind", header: "What", value: (e) => KIND_WORDS[e.kind] || e.kind, mobile: "subtitle" },
            { key: "shift", header: "Shift", value: (e) => e.shift_no || "", className: "mono" },
            { key: "amount", header: "Amount", type: "money", exact: true, value: (e) => Number(e.amount), mobile: "show" },
            { key: "note", header: "Note", value: (e) => e.note || "" },
          ]}
          empty="Nothing in this period" emptyIcon="users" />
      </div>
    </FormDialog>
  );
}
