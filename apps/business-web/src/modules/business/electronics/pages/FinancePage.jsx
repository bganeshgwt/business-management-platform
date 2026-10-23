import { useCallback, useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import "../../core/styles/kits-finance.css";

// EMI & financiers. An EMI sale at the counter leaves the
// financed part owed by the financier (Bajaj Finserv, HDFC Bank, ICICI Bank,
// Home Credit, or one the owner adds). Here: what each financier owes, the
// cases, recording a payout (net of the dealer subvention the financier
// keeps), cancelling a loan after the goods came back, and the financier list.

const CASE_STATES = { pending: ["warning", "Awaiting payout"], settled: ["success", "Paid out"], cancelled: ["inactive", "Cancelled"] };
const STATUS_FILTERS = [{ value: "", label: "All" }, { value: "pending", label: "Awaiting payout" }, { value: "settled", label: "Paid out" }, { value: "cancelled", label: "Cancelled" }];
const paise = (v) => Math.round(Number(v || 0) * 100);

export default function FinancePage() {
  const biz = useOpenBusiness();
  const [tab, setTab] = useState("owed");
  const [owed, setOwed] = useState(null);
  const [owedError, setOwedError] = useState("");
  const [version, setVersion] = useState(0);
  const [settling, setSettling] = useState(null);
  const canEdit = biz.can("finance.edit");
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "finance/outstanding", {}, controller.signal)
      .then((data) => { setOwed(data); setOwedError(""); })
      .catch((err) => { if (!controller.signal.aborted) setOwedError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);

  const owedColumns = useMemo(() => [
    { key: "name", header: "Financier", value: (r) => r.name, mobile: "title", pin: true },
    { key: "cases", header: "Cases awaiting payout", type: "number", value: (r) => r.cases, mobile: "show" },
    { key: "financed", header: "Owed (financed)", type: "money", exact: true, value: (r) => Number(r.financed), total: "sum", mobile: "show" },
    { key: "subvention_percent", header: "Subvention", value: (r) => `${Number(r.subvention_percent)}%` },
    { key: "expected_subvention", header: "Expected subvention", type: "money", exact: true, value: (r) => Number(r.expected_subvention), total: "sum" },
    { key: "payout", header: "Expected payout", type: "money", exact: true, value: (r) => Number(r.financed) - Number(r.expected_subvention), total: "sum" },
    { key: "oldest_days", header: "Oldest (days)", type: "number", value: (r) => (r.cases ? Number(r.oldest_days) : 0) },
    { key: "over_15_days", header: "Over 15 days", type: "number", value: (r) => r.over_15_days },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      r.cases > 0 ? <button type="button" className="chip-button" onClick={() => setSettling(r)}><Icon name="wallet" size={14} /> Record payout</button> : null
    ) },
  ].filter(Boolean), [canEdit]);

  return (
    <div className="stack">
      <BusinessHeader icon="wallet" title="EMI & financiers"
        description="Bills sold on EMI: the financed part is owed by the financier, not the customer, until the payout comes in. Payouts come net of the dealer subvention the financier keeps." />
      <div className="stat-grid">
        <StatTile icon="wallet" tone="warning" label="Owed by financiers" money={owed ? Number(owed.total) : undefined} loading={!owed && !owedError}
          note={owed ? `${owed.items.reduce((s, r) => s + r.cases, 0)} cases awaiting payout` : undefined} />
        <StatTile icon="percent" tone="neutral" label="Expected subvention" money={owed ? Number(owed.expectedSubvention) : undefined} loading={!owed && !owedError} note="kept by financiers from their payouts" />
        <StatTile icon="money" tone="success" label="Expected payout" money={owed ? Number(owed.expectedPayout) : undefined} loading={!owed && !owedError} />
        <StatTile icon="clock" tone={owed && owed.items.some((r) => r.over_15_days > 0) ? "danger" : "neutral"} label="Waiting over 15 days"
          value={owed ? String(owed.items.reduce((s, r) => s + r.over_15_days, 0)) : undefined} loading={!owed && !owedError} note="cases to chase with the financier" />
      </div>
      <Segmented label="Show" options={[{ value: "owed", label: "Owed by financier" }, { value: "cases", label: "EMI cases" }, { value: "financiers", label: "Financiers" }]} value={tab} onChange={setTab} />
      {tab === "owed" && (
        <>
          <ErrorMessage message={owedError} />
          <SectionCard flush icon="wallet" title="Outstanding by financier" description="Every case still awaiting its payout, whatever day it was sold.">
            <DataGrid id="emi-owed" rows={owed?.items || []} loading={!owed && !owedError} rowKey={(r) => r.id} caption="Outstanding by financier" columns={owedColumns}
              currency={biz.symbol} rowNoun={["financier", "financiers"]} empty="Nothing is owed by financiers" emptyHint="EMI sales at Quick bill appear here until the payout is recorded." emptyIcon="wallet" />
          </SectionCard>
        </>
      )}
      {tab === "cases" && <Cases onChanged={reload} version={version} />}
      {tab === "financiers" && <Financiers onChanged={reload} />}
      {settling && <PayoutDialog financier={settling} onClose={() => setSettling(null)} onSaved={() => { setSettling(null); reload(); }} />}
    </div>
  );
}

function Cases({ onChanged, version }) {
  const biz = useOpenBusiness();
  const [status, setStatus] = useState("");
  const list = useServerList("finance/cases", { gridId: "emi-cases", period: true, params: { ...(status ? { status } : {}), v: version } });
  const [cancelling, setCancelling] = useState(null);
  const canEdit = biz.can("finance.edit");
  const columns = useMemo(() => [
    { key: "loan_no", header: "Loan no.", value: (c) => c.loan_no, className: "mono", mobile: "title", pin: true },
    { key: "financier", header: "Financier", value: (c) => c.financier_name, mobile: "subtitle" },
    { key: "document_no", header: "Bill", value: (c) => c.document_no, className: "mono" },
    { key: "customer", header: "Customer", value: (c) => c.customer_name || "—", render: (c) => <span className="bz-two-line"><span>{c.customer_name || "—"}</span><small className="muted">{c.customer_phone || ""}</small></span> },
    { key: "created_at", header: "Sold", type: "date", value: (c) => c.created_at, mobile: "show" },
    { key: "down_payment", header: "Down payment", type: "money", exact: true, value: (c) => Number(c.down_payment) },
    { key: "financed_amount", header: "Financed", type: "money", exact: true, value: (c) => Number(c.financed_amount), total: "sum", mobile: "show" },
    { key: "tenure", header: "Months", type: "number", value: (c) => c.tenure_months ?? "", defaultHidden: true },
    { key: "do_no", header: "DO no.", value: (c) => c.do_no || "", className: "mono", defaultHidden: true },
    { key: "status", header: "Status", type: "status", value: (c) => c.status, render: (c) => <Badge tone={CASE_STATES[c.status]?.[0]} label={CASE_STATES[c.status]?.[1]} /> },
    { key: "subvention_charged", header: "Subvention kept", type: "money", exact: true, value: (c) => (c.subvention_charged === null ? null : Number(c.subvention_charged)) },
    { key: "received_on", header: "Paid out on", type: "date", value: (c) => c.received_on || null, defaultHidden: true },
    { key: "age", header: "Days waiting", type: "number", value: (c) => (c.status === "pending" ? Number(c.age_days) : null) },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => (
      c.status === "pending" ? <button type="button" className="chip-button" onClick={() => setCancelling(c)}>Cancel loan</button> : null
    ) },
  ].filter(Boolean), [canEdit]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="file" title="EMI cases" description="Bills sold on EMI in the dates chosen.">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Loan, DO, bill or customer" }} caption="EMI cases" columns={columns}
          currency={biz.symbol} rowNoun={["case", "cases"]} rowClassName={(c) => (c.status === "cancelled" ? "dg-tone-muted" : c.status === "pending" && Number(c.age_days) > 15 ? "dg-tone-warning" : "")}
          toolbar={<><PeriodFilter list={list} /><Segmented label="Status" options={STATUS_FILTERS} value={status} onChange={setStatus} /></>}
          exportName={`${biz.business.code}-emi-cases`} empty="No EMI sales in these dates" emptyHint="Pick other dates, or sell on EMI at Quick bill." emptyIcon="file" />
      </SectionCard>
      {cancelling && (
        <ReasonDialog title={`Cancel loan ${cancelling.loan_no}`} submitLabel="Cancel the loan" label="Why the financier cancelled"
          description={`Only once the goods on ${cancelling.document_no} have been taken back. The financed ${biz.exact(cancelling.financed_amount)} is reversed on the bill; the customer gets back only what they paid.`}
          onClose={() => setCancelling(null)} onSubmit={(reason) => businessWrite(biz.id, `finance/cases/${cancelling.id}/cancel`, { reason, requestKey: newKey() })}
          onSaved={() => { setCancelling(null); list.reload(); onChanged(); }} />
      )}
    </>
  );
}

// A financier's payout: tick the cases it covers, check the subvention on
// each, and the amount must match what reached the bank to the paisa.
function PayoutDialog({ financier, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [cases, setCases] = useState(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState({});
  const [requestKey] = useState(newKey);
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState({ receivedOn: businessToday(biz.business.timezone), method: "bank", reference: "", locationId: String(locations[0]?.id || ""), amount: "", notes: "" });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "finance/cases", { status: "pending", financierId: financier.id, limit: 100 }, controller.signal)
      .then((data) => {
        setCases(data.items);
        setPicked(Object.fromEntries(data.items.map((c) => [c.id, { on: true, subvention: (Math.round(paise(c.financed_amount) * Number(financier.subvention_percent) / 100) / 100).toFixed(2) }])));
      })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, financier]);
  const chosen = (cases || []).filter((c) => picked[c.id]?.on);
  const due = chosen.reduce((s, c) => s + paise(c.financed_amount) - paise(picked[c.id].subvention), 0) / 100;
  const kept = chosen.reduce((s, c) => s + paise(picked[c.id].subvention), 0) / 100;
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const amount = form.amount === "" ? due : Number(form.amount);
  return (
    <FormDialog title={`Payout from ${financier.name}`} icon="wallet" width={820} onClose={onClose} onSaved={onSaved} submitLabel="Record payout"
      successMessage={(s) => `Payout of ${biz.exact(s.amount_received)} recorded for ${s.cases} ${s.cases === 1 ? "case" : "cases"}`}
      disabled={!chosen.length}
      onSubmit={() => businessWrite(biz.id, "finance/settlements", {
        requestKey, financierId: financier.id, locationId: form.locationId, receivedOn: form.receivedOn, method: form.method, reference: form.reference || null, notes: form.notes || null,
        amountReceived: amount.toFixed(2), cases: chosen.map((c) => ({ caseId: c.id, subvention: picked[c.id].subvention })),
      })}
      description="Tick the loans this payout covers and check the subvention the financier kept on each (from its payout advice). The amount received must match to the paisa.">
      <div className="field-wide">
        <ErrorMessage message={error} />
        {!cases && !error && <Loading />}
        {cases && (
          <ul className="bz-payout-cases">
            {cases.map((c) => (
              <li key={c.id} className={picked[c.id]?.on ? "" : "is-off"}>
                <label className="checkbox"><input type="checkbox" checked={Boolean(picked[c.id]?.on)} onChange={(e) => setPicked((p) => ({ ...p, [c.id]: { ...p[c.id], on: e.target.checked } }))} />
                  <span className="bz-two-line"><strong className="mono">{c.loan_no}</strong><small className="muted">{c.document_no} · {c.customer_name || "—"} · {dateShort(c.created_at)} · financed {biz.exact(c.financed_amount)}</small></span></label>
                <input aria-label={`Subvention on ${c.loan_no}`} type="number" min="0" step="0.01" value={picked[c.id]?.subvention ?? "0"} disabled={!picked[c.id]?.on}
                  onChange={(e) => setPicked((p) => ({ ...p, [c.id]: { ...p[c.id], subvention: e.target.value } }))} />
              </li>
            ))}
          </ul>
        )}
        {cases && <p className="small">{chosen.length} {chosen.length === 1 ? "case" : "cases"} · subvention {biz.exact(kept)} · <strong>to receive {biz.exact(due)}</strong></p>}
      </div>
      <Field label="Amount received"><input type="number" min="0" step="0.01" value={form.amount} placeholder={due.toFixed(2)} onChange={set("amount")} /></Field>
      <Field label="Received on"><input required type="date" value={form.receivedOn} onChange={set("receivedOn")} /></Field>
      <Field label="Received by">
        <select value={form.method} onChange={set("method")}><option value="bank">Bank transfer (NEFT / RTGS)</option><option value="upi">UPI</option><option value="cheque">Cheque</option></select>
      </Field>
      <Field label="UTR / cheque no. (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
      {locations.length > 1 && (
        <Field label="Counted at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      )}
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function Financiers({ onChanged }) {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "finance/financiers", {}, controller.signal)
      .then((data) => { setRows(data.items); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const canEdit = biz.can("finance.edit");
  const columns = useMemo(() => [
    { key: "name", header: "Financier", value: (f) => f.name, mobile: "title", pin: true },
    { key: "subvention_percent", header: "Dealer subvention", value: (f) => `${Number(f.subvention_percent)}%`, mobile: "show" },
    { key: "pending_cases", header: "Awaiting payout", type: "number", value: (f) => f.pending_cases },
    { key: "outstanding", header: "Owed", type: "money", exact: true, value: (f) => Number(f.outstanding), total: "sum" },
    { key: "active", header: "Status", type: "status", value: (f) => (f.active ? "active" : "inactive"), render: (f) => <ActiveBadge active={f.active} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (f) => <button type="button" className="chip-button" onClick={() => setEditing(f)}><Icon name="edit" size={14} /> Change</button> },
  ].filter(Boolean), [canEdit]);
  return (
    <>
      <ErrorMessage message={error} />
      <SectionCard flush icon="users" title="Financiers" actions={canEdit && <button type="button" className="button button-sm" onClick={() => setEditing({})}><Icon name="plus" size={14} /> Add a financier</button>}>
        <DataGrid id="emi-financiers" rows={rows || []} loading={!rows && !error} rowKey={(f) => f.id} caption="Financiers" columns={columns} currency={biz.symbol}
          rowNoun={["financier", "financiers"]} rowClassName={(f) => (f.active ? "" : "dg-tone-muted")} empty="No financiers yet" emptyIcon="users" />
      </SectionCard>
      {editing && (
        <FinancierDialog financier={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setVersion((n) => n + 1); onChanged(); }} />
      )}
    </>
  );
}

function FinancierDialog({ financier, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ name: financier?.name || "", subventionPercent: financier ? String(Number(financier.subvention_percent)) : "0", active: financier ? financier.active : true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title={financier ? `Change ${financier.name}` : "Add a financier"} icon="users" width={520} onClose={onClose} onSaved={onSaved}
      successMessage="Financier saved"
      onSubmit={() => (financier ? businessWrite(biz.id, `finance/financiers/${financier.id}`, form, "patch") : businessWrite(biz.id, "finance/financiers", form))}
      description="The subvention is the scheme charge the financier keeps from each payout (for example 0% EMI schemes). It is the default on a payout; each payout can say otherwise.">
      <Field label="Name"><input required maxLength={100} value={form.name} onChange={set("name")} placeholder="e.g. TVS Credit" /></Field>
      <Field label="Dealer subvention (%)"><input type="number" min="0" max="30" step="0.01" value={form.subventionPercent} onChange={set("subventionPercent")} /></Field>
      {financier && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Offered at the counter</label>}
    </FormDialog>
  );
}
