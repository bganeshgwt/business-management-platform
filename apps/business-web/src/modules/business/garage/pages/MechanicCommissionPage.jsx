import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import "../styles/garage.css";

// Mechanics' commission on labour for a period: each mechanic's labour billed,
// the commission it earned (a rate per labour item, or per mechanic, in
// Settings › Garage settings), what was taken back when the labour was
// credited, and what was paid, and what each is due now (below nothing, the
// mechanic owes it); a mechanic's lines; and a payout, which goes through the
// expense book so the drawer and the day's money see it.

const PAY_KINDS = ["cash", "upi", "bank"];

export default function MechanicCommissionPage() {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [person, setPerson] = useState(null);
  const [paying, setPaying] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "garage/commission", range, controller.signal)
      .then((result) => { setData(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range, version]);
  const canPay = biz.can("garage.approve") && biz.can("expenses.create");
  const totals = data?.totals;
  const columns = useMemo(() => [
    { key: "name", header: "Mechanic", value: (r) => r.name, mobile: "title", pin: true,
      render: (r) => <button type="button" className="link-button" onClick={() => setPerson(r)}>{r.name}</button> },
    { key: "own_rate", header: "Own rate", value: (r) => (r.own_rate ? `${Number(r.own_rate)}%` : "—"), defaultHidden: true },
    { key: "jobs", header: "Job cards", type: "number", value: (r) => r.jobs, total: "sum" },
    { key: "lines", header: "Labour lines", type: "number", value: (r) => r.lines, total: "sum" },
    { key: "labour", header: "Labour billed (before GST)", type: "money", exact: true, value: (r) => Number(r.labour), total: "sum" },
    { key: "earned", header: "Earned", type: "money", exact: true, value: (r) => Number(r.earned), total: "sum" },
    { key: "taken_back", header: "Taken back", type: "money", exact: true, value: (r) => Number(r.taken_back), total: "sum" },
    { key: "paid", header: "Paid", type: "money", exact: true, value: (r) => Number(r.paid), total: "sum" },
    // Below nothing: commission taken back after it was paid, owed by the mechanic.
    { key: "due", header: "Due now", type: "money", exact: true, value: (r) => Number(r.due), total: "sum", mobile: "show",
      render: (r) => (Number(r.due) < 0 ? <span className="bz-due">{biz.exact(-Number(r.due))} owed by them</span> : biz.exact(r.due)) },
    canPay && { key: "pay", header: "", value: () => "", render: (r) => (Number(r.due) > 0 ? <button type="button" className="button button-secondary button-sm" onClick={() => setPaying(r)}>Pay</button> : null) },
  ].filter(Boolean), [biz, canPay]);
  return (
    <div className="stack">
      <BusinessHeader icon="percent" title="Mechanics' commission"
        description="Commission on the labour billed in these dates, by mechanic: a labour line earns its rate for the mechanic who did it (or the job card's mechanics, shared), and a credit of its bill line takes it back. Rates are in Settings › Garage settings." />
      <div className="stat-grid">
        <StatTile icon="percent" tone="primary" label="Earned" money={totals?.earned} loading={!totals && !error} note={totals ? `on ${totals.lines} labour line${totals.lines === 1 ? "" : "s"}` : undefined} />
        <StatTile icon="receipt" label="Labour billed" money={totals?.labour} loading={!totals && !error} note="before GST" />
        <StatTile icon="undo" label="Taken back" money={totals?.taken_back} loading={!totals && !error} note="on labour credited" />
        <StatTile icon="wallet" tone="success" label="Paid" money={totals?.paid} loading={!totals && !error} />
        <StatTile icon="clock" tone="warning" label="Due now" money={totals?.due} loading={!totals && !error} note="to every mechanic, whatever the dates" />
      </div>
      <SectionCard flush icon="users" title="By mechanic">
        <DataGrid id="garage-mechanic-commission" caption="Mechanics' commission by mechanic" columns={columns} rows={data?.rows || []} loading={!data && !error} error={data ? "" : error}
          onRetry={() => setVersion((n) => n + 1)} currency={biz.symbol} rowNoun={["mechanic", "mechanics"]} defaultSort={{ key: "earned", direction: "desc" }}
          exportName={biz.can("reports.export") ? `${biz.business.code}-mechanic-commission-${range.from}-${range.to}` : undefined}
          toolbar={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="bill dates" onChange={setRange} />}
          empty="No commission yet" emptyHint="Set the rates in Settings › Garage settings; labour billed from then on earns them." emptyIcon="users" />
      </SectionCard>
      {person && <PersonLines biz={biz} person={person} range={range} onClose={() => setPerson(null)} />}
      {paying && <PayoutDialog biz={biz} person={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); toast.success(`${paying.name} paid.`); setVersion((n) => n + 1); }} />}
    </div>
  );
}

function PersonLines({ biz, person, range, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `garage/commission/${person.user_id}`, range, controller.signal)
      .then(setData).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, person.user_id, range]);
  return (
    <FormDialog title={`${person.name}: ${dateShort(range.from)} to ${dateShort(range.to)}`} icon="percent" width={760} onClose={onClose} hideSubmit onSubmit={() => undefined}>
      <div className="field-wide">
        <DataGrid variant="compact" id="garage-commission-lines" caption="Labour lines" rows={data?.items || []} loading={!data && !error} error={error} rowKey={(i) => i.id}
          currency={biz.symbol} rowNoun={["line", "lines"]} empty="No labour in these dates" columns={[
            { key: "earned_on", header: "Billed", type: "date", value: (i) => i.earned_on, mobile: "subtitle" },
            { key: "job", header: "Job card", value: (i) => `${i.job_no} ${i.registration_no}` },
            { key: "label", header: "Labour", value: (i) => i.label, mobile: "title" },
            { key: "base", header: "Their part (before GST)", type: "money", exact: true, value: (i) => Number(i.base), total: "sum" },
            { key: "percent", header: "Rate", value: (i) => `${Number(i.percent)}%` },
            { key: "amount", header: "Earned", type: "money", exact: true, value: (i) => Number(i.amount), total: "sum", mobile: "show" },
          ]} />
        {data?.taken_back?.length > 0 && (
          <DataGrid variant="compact" id="garage-commission-taken-back" caption="Taken back on credits" rows={data.taken_back} rowKey={(i) => i.id}
            currency={biz.symbol} rowNoun={["credit", "credits"]} columns={[
              { key: "reversed_on", header: "Credited", type: "date", value: (i) => i.reversed_on, mobile: "subtitle" },
              { key: "credit", header: "Credit note", value: (i) => `${i.return_no} on ${i.document_no}` },
              { key: "label", header: "Labour", value: (i) => `${i.label} · ${i.job_no}`, mobile: "title" },
              { key: "base", header: "Their part credited", type: "money", exact: true, value: (i) => Number(i.base), total: "sum" },
              { key: "amount", header: "Taken back", type: "money", exact: true, value: (i) => Number(i.amount), total: "sum", mobile: "show" },
            ]} />
        )}
        {data?.payouts?.length > 0 && <p className="small">Paid: {data.payouts.map((p) => `${biz.exact(p.amount)} on ${dateShort(p.spent_on)}${p.voided_at ? " (reversed)" : ""}`).join("; ")}</p>}
      </div>
    </FormDialog>
  );
}

function PayoutDialog({ biz, person, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: Number(person.due).toFixed(2), method: "cash", reference: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Pay ${person.name}`} icon="wallet" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Pay"
      description={`${biz.exact(person.due)} is due. The payout is an expense of today, in the drawer's money.`}
      onSubmit={() => businessWrite(biz.id, `garage/commission/${person.user_id}/payouts`, { requestKey, amount: form.amount, ...methods.body(form.method, PAY_KINDS),
        reference: form.reference.trim() || undefined, notes: form.notes.trim() || undefined })}>
      <Field label={`Amount (${biz.symbol})`}><input required type="number" min="0.01" max={Number(person.due)} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} placeholder="e.g. This week's commission" /></Field>
    </FormDialog>
  );
}
