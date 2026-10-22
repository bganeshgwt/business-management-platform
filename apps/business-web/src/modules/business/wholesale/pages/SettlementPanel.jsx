import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { balanceText, dateLong, dateShort } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { METHODS, methodName } from "../../receivables/pages/receivablesFormat";

// The evening question (pro pass D-03): "Ravi went out today — what did he
// collect in cash, UPI and cheques, what did he hand over, what is short?"
// Pick a salesperson and a day: their receipts not yet settled, by method;
// type the cash handed over; a shortage or excess needs a note. Receipts he
// brings back on paper can be entered here several at a time.
export default function SettlementPanel({ onChanged, onOpenReceipt }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const { options, error: optionsError } = useOptions(["salespeople?active=true"]);
  const people = options?.["salespeople?active=true"] || [];
  const [salespersonId, setSalespersonId] = useState("");
  const [day, setDay] = useState(today);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [handed, setHanded] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const [requestKey, setRequestKey] = useState(newKey);
  const chosen = salespersonId || (people[0] ? String(people[0].id) : "");
  const history = useServerList("settlements", { gridId: "wholesale-settlements", params: chosen ? { salesperson: chosen } : {} });

  useEffect(() => {
    if (!chosen) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "settlements/preview", { salesperson: chosen, day }, controller.signal)
      .then((p) => { setPreview(p); setError(""); setHanded(Number(p.totals.cash) ? Number(p.totals.cash).toFixed(2) : ""); setNotes(""); setRequestKey(newKey()); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, chosen, day, version]);

  const t = preview?.totals;
  const difference = t ? Math.round((Number(handed || 0) - Number(t.cash)) * 100) / 100 : 0;
  const canSettle = biz.can("receivables.approve");
  const settle = async (event) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const saved = await businessWrite(biz.id, "settlements", { salespersonId: chosen, day, cashHanded: handed || "0", notes: notes || undefined, requestKey });
      toast.success(`${saved.salesperson_name}'s ${dateShort(day)} settled${Number(saved.difference) ? ` · ${Number(saved.difference) < 0 ? "short" : "excess"} ${biz.exact(Math.abs(Number(saved.difference)))}` : ""}`);
      setVersion((n) => n + 1); history.reload(); onChanged?.();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const columns = useMemo(() => [
    { key: "collection_no", header: "Receipt", value: (r) => r.collection_no, mobile: "title", render: (r) => <button type="button" className="link-button mono" onClick={() => onOpenReceipt?.(r.id)}>{r.collection_no}</button> },
    { key: "contact", header: "Customer", value: (r) => r.contact_name, mobile: "subtitle" },
    { key: "method", header: "Paid by", value: (r) => methodName(r.method), mobile: "show" },
    { key: "reference", header: "Reference", value: (r) => [r.reference, r.bank, r.cheque_date && `dated ${dateShort(r.cheque_date)}`].filter(Boolean).join(" · ") },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (r) => Number(r.amount), total: "sum", mobile: "show" },
  ], [onOpenReceipt]);
  const historyColumns = useMemo(() => [
    { key: "day", header: "Day", type: "date", value: (s) => s.day, mobile: "title" },
    { key: "salesperson", header: "Salesperson", value: (s) => s.salesperson_name, mobile: "subtitle" },
    { key: "receipts", header: "Receipts", type: "number", value: (s) => s.receipts },
    { key: "cash", header: "Cash collected", type: "money", exact: true, value: (s) => Number(s.cash), total: "sum" },
    { key: "handed", header: "Handed over", type: "money", exact: true, value: (s) => Number(s.cash_handed), total: "sum", mobile: "show" },
    { key: "difference", header: "Short / excess", type: "money", exact: true, value: (s) => Number(s.difference), total: "sum", mobile: "show",
      render: (s) => (Number(s.difference) ? <span className={Number(s.difference) < 0 ? "bz-due" : ""}>{Number(s.difference) < 0 ? "Short " : "Excess "}{biz.exact(Math.abs(Number(s.difference)))}</span> : <Badge tone="success" label="Tallied" />) },
    { key: "upi", header: "UPI", type: "money", exact: true, value: (s) => Number(s.upi), defaultHidden: true },
    { key: "cheques", header: "Cheques", type: "money", exact: true, value: (s) => Number(s.cheques), defaultHidden: true },
    { key: "notes", header: "Note", value: (s) => s.notes || "" },
    { key: "by", header: "Settled by", value: (s) => s.created_by_name, defaultHidden: true },
  ], [biz]);
  const person = people.find((p) => String(p.id) === chosen);
  return (
    <div className="stack">
      <ErrorMessage message={optionsError} />
      <SectionCard icon="users" title="Settle a salesperson's day"
        description="Receipts the salesperson recorded (or you entered for them) that day and not settled yet. Cash should come back in hand; UPI and cheques are listed to check."
        actions={biz.can("receivables.create") && chosen && <button type="button" className="button button-secondary button-sm" onClick={() => setEntering(true)}><Icon name="plus" size={15} /> Enter receipts</button>}>
        {!options ? <Loading /> : !people.length ? <p className="muted">Add salespeople under Routes & salespeople first.</p> : (
          <div className="stack">
            <div className="bz-toolbar-row">
              <label className="field">
                <span>Salesperson</span>
                <select value={chosen} onChange={(e) => setSalespersonId(e.target.value)}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </label>
              <label className="field">
                <span>Day</span>
                <input type="date" max={today} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
              </label>
              {preview && <span className="muted small">{dateLong(day)}</span>}
            </div>
            <ErrorMessage message={error} />
            {!preview && !error && <Loading />}
            {preview && (
              <>
                <div className="bz-figures" role="list" aria-label="Collected by method">
                  {[["Cash", t.cash], ["UPI", t.upi], [`Cheques (${t.cheque_count})`, t.cheques], ["Bank / card", t.other]].map(([label, value]) => (
                    <div key={label} className="bz-figure" role="listitem"><small>{label}</small><strong>{biz.exact(value)}</strong></div>
                  ))}
                </div>
                <DataGrid variant="compact" id="wholesale-settlement-receipts" caption="Receipts to settle" rows={preview.receipts} columns={columns} currency={biz.symbol}
                  rowNoun={["receipt", "receipts"]} empty={preview.earlier.length ? "Everything this day is already settled" : "No receipts by this salesperson on this day"} />
                {preview.earlier.length > 0 && (
                  <p className="muted small"><Icon name="check" size={13} /> Already settled this day: {preview.earlier.map((s) => `${biz.exact(s.cash_handed)} handed over (${s.receipts} receipts${Number(s.difference) ? `, ${Number(s.difference) < 0 ? "short" : "excess"} ${biz.exact(Math.abs(Number(s.difference)))}` : ""})`).join("; ")}.</p>
                )}
                {canSettle && (preview.receipts.length > 0) && (
                  <form className="form-grid" onSubmit={settle}>
                    <Field label="Cash handed over">
                      <input type="number" min="0" step="0.01" inputMode="decimal" required value={handed} onChange={(e) => setHanded(e.target.value)} />
                    </Field>
                    <div className={`bz-figure ${difference < 0 ? "is-danger" : difference > 0 ? "" : "is-success"}`} aria-live="polite">
                      <small>{difference < 0 ? "Short" : difference > 0 ? "Excess" : "Cash tallies"}</small>
                      <strong>{biz.exact(Math.abs(difference))}</strong>
                    </div>
                    <Field label={difference ? "Why it does not tally" : "Note (optional)"} wide>
                      <input required={Boolean(difference)} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={difference ? "e.g. ₹50 given as change to a shop" : undefined} />
                    </Field>
                    <div className="form-actions field-wide bz-start">
                      <button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : `Settle ${person?.name || ""}'s day`}</button>
                      <button type="button" className="button button-secondary" onClick={() => printSettlement(preview, handed, notes, biz)}><Icon name="print" size={15} /> Print</button>
                    </div>
                  </form>
                )}
                {!canSettle && preview.receipts.length > 0 && <p className="muted small">An accountant or manager settles the day.</p>}
              </>
            )}
          </div>
        )}
      </SectionCard>
      <SectionCard flush icon="list" title="Settlements">
        <DataGrid {...history.gridProps} caption="Settlements" columns={historyColumns} currency={biz.symbol} rowNoun={["settlement", "settlements"]}
          rowClassName={(s) => (Number(s.difference) < 0 ? "dg-tone-danger" : "")}
          exportName={biz.can("receivables.export") ? `${biz.business.code}-settlements` : undefined}
          empty="No settlements yet" emptyIcon="check" />
      </SectionCard>
      {entering && person && <QuickReceiptsDialog salesperson={person} onClose={() => setEntering(false)}
        onSaved={(n) => { setEntering(false); toast.success(`${n} receipts saved for ${person.name}`); setVersion((x) => x + 1); onChanged?.(); }} />}
    </div>
  );
}

const emptyRow = () => ({ key: newKey(), contact: null, amount: "", method: "cash", reference: "", chequeDate: "", requestKey: newKey() });

// Several receipts at once — what a salesperson brings back on paper. His
// beat's customers come first; each row becomes its own numbered receipt.
function QuickReceiptsDialog({ salesperson, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const { options, error } = useOptions(["customer-beats?trade=trade"]);
  const customers = useMemo(() => (options?.["customer-beats?trade=trade"] || []).slice()
    .sort((a, b) => Number(b.salesperson_id === salesperson.id) - Number(a.salesperson_id === salesperson.id) || a.name.localeCompare(b.name)), [options, salesperson.id]);
  const location = biz.locations.find((l) => l.active);
  const [rows, setRows] = useState(() => [emptyRow(), emptyRow(), emptyRow()]);
  const [saved, setSaved] = useState({});
  const set = (key, name, value) => setRows((all) => all.map((r) => (r.key === key ? { ...r, [name]: value } : r)));
  const filled = rows.filter((r) => r.contact && Number(r.amount) > 0);
  const submit = async () => {
    let done = 0;
    for (const row of filled) {
      if (saved[row.key]) { done += 1; continue; }
      try {
        const receipt = await businessWrite(biz.id, "collections", {
          locationId: location.id, contactId: row.contact.id, amount: row.amount, method: row.method, requestKey: row.requestKey,
          reference: row.reference || undefined, salespersonId: salesperson.id, ...(row.contact.route_id ? { routeId: row.contact.route_id } : {}),
          ...(row.method === "cheque" ? { chequeDate: row.chequeDate || today } : {}),
        });
        setSaved((s) => ({ ...s, [row.key]: receipt.collection_no }));
        done += 1;
      } catch (err) {
        throw new Error(`${row.contact.name}: ${getErrorMessage(err)}${done ? ` (${done} saved before this one; fix it and save again — saved rows are not repeated)` : ""}`);
      }
    }
    return done;
  };
  return (
    <FormDialog title={`Enter receipts · ${salesperson.name}`} icon="wallet" width={980} submitLabel={`Save ${filled.length || ""} receipts`.replace("  ", " ")}
      onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options || !filled.length}
      description="One line per receipt. His beat's shops come first in the list. Each line gets its own receipt number; money goes to the oldest bills first.">
      {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
      {!options && <div className="field-wide"><Loading /></div>}
      <div className="field-wide bz-lines">
        <DataGrid variant="editor" caption="Receipts" rows={rows} rowKey={(r) => r.key} currency={biz.symbol} columns={[
          { key: "customer", header: "Customer", render: (r, ctx) => (saved[r.key] ? <span>{r.contact?.name} <Badge tone="success" label={saved[r.key]} /></span> : (
            <SearchPicker aria-label={ctx.label} value={r.contact} options={customers} onChange={(c) => set(r.key, "contact", c)}
              getKey={(c) => c.id} getLabel={(c) => c.name} getKeywords={(c) => `${c.phone || ""} ${c.beat_name || ""}`}
              getDescription={(c) => [balanceText(c.balance), c.salesperson_id === salesperson.id ? c.beat_name : c.route_name].filter(Boolean).join(" · ")} placeholder="Shop" />
          )) },
          { key: "amount", header: "Amount", render: (r, ctx) => <input aria-label={ctx.label} className="bz-small-input" type="number" min="0.01" step="0.01" disabled={Boolean(saved[r.key])} value={r.amount} onChange={(e) => set(r.key, "amount", e.target.value)} /> },
          { key: "method", header: "Paid by", render: (r, ctx) => (
            <select aria-label={ctx.label} disabled={Boolean(saved[r.key])} value={r.method} onChange={(e) => set(r.key, "method", e.target.value)}>
              {METHODS.filter(([code]) => code !== "card").map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          ) },
          { key: "reference", header: "Cheque no. / ref.", render: (r, ctx) => <input aria-label={ctx.label} className="bz-small-input" maxLength={100} required={r.method === "cheque"} disabled={Boolean(saved[r.key])} value={r.reference} onChange={(e) => set(r.key, "reference", e.target.value)} /> },
          { key: "date", header: "Cheque date", render: (r, ctx) => (r.method === "cheque" ? <input aria-label={ctx.label} type="date" disabled={Boolean(saved[r.key])} value={r.chequeDate || today} onChange={(e) => set(r.key, "chequeDate", e.target.value)} /> : <span className="muted">—</span>) },
          { key: "remove", header: "", label: "Remove", type: "actions", render: (r) => !saved[r.key] && rows.length > 1 && <button type="button" className="link-button danger" onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>Remove</button> },
        ]} />
        <div className="bz-lines-foot">
          <button type="button" className="button button-secondary" disabled={rows.length >= 30} onClick={() => setRows((all) => [...all, emptyRow()])}><Icon name="plus" size={15} /> Add line</button>
          <span className="muted small">{filled.length} filled · {biz.exact(filled.reduce((s, r) => s + Number(r.amount || 0), 0))}</span>
        </div>
      </div>
    </FormDialog>
  );
}

function printSettlement(preview, handed, notes, biz) {
  const t = preview.totals;
  const rows = preview.receipts.map((r) => `<tr><td>${escapeHtml(r.collection_no)}</td><td>${escapeHtml(r.contact_name)}</td><td>${escapeHtml(methodName(r.method))}${r.reference ? ` · ${escapeHtml(r.reference)}` : ""}</td><td class="r">${escapeHtml(biz.exact(r.amount))}</td></tr>`).join("");
  const difference = Number(handed || 0) - Number(t.cash);
  printDocument({
    title: `Settlement ${preview.salesperson.name} ${preview.day}`,
    styles: "body{font:13px system-ui;color:#111} h1{font-size:18px;margin:0} table{width:100%;border-collapse:collapse;margin-top:12px} td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left} .r{text-align:right}",
    body: `<h1>${escapeHtml(biz.settings.display_name || biz.business.name)}</h1>
      <p><strong>Salesperson settlement</strong> · ${escapeHtml(preview.salesperson.name)} · ${escapeHtml(dateLong(preview.day))}</p>
      <table><thead><tr><th>Receipt</th><th>Customer</th><th>Paid by</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <p>Cash ${escapeHtml(biz.exact(t.cash))} · UPI ${escapeHtml(biz.exact(t.upi))} · Cheques ${escapeHtml(biz.exact(t.cheques))} (${t.cheque_count}) · Bank/card ${escapeHtml(biz.exact(t.other))}</p>
      <p><strong>Cash handed over ${escapeHtml(biz.exact(handed || 0))}</strong>${difference ? ` · ${difference < 0 ? "short" : "excess"} ${escapeHtml(biz.exact(Math.abs(difference)))}` : " · tallies"}${notes ? ` · ${escapeHtml(notes)}` : ""}</p>
      <p style="margin-top:40px;display:flex;justify-content:space-between"><span>Salesperson</span><span>Received by</span></p>`,
  });
}
