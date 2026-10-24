import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { Segmented } from "../../wholesale/pages/shared";
import { whatsappLink } from "../../retail/pages/retail";
import { TRADES, tradeWord, upiPayLink } from "./hardware";
import "../styles/hardware.css";

// Fitters: the painters, plumbers, electricians, masons and carpenters who
// bring customers. A bill names its fitter ("Fitted by"); each line earns by
// the most specific rule (the item's, its category's or every item's), worked
// out with the bill and kept with it; goods back take it back in proportion.
// Payouts go through the expense book; a fitter's statement shows it all.

const TABS = [{ value: "fitters", label: "Fitters" }, { value: "rules", label: "Commission rules" }, { value: "payouts", label: "Payouts" }];
const PAY_KINDS = ["cash", "upi", "card", "bank"];
const ENTRY_WORDS = { earned: "Bill", taken_back: "Goods back", paid: "Paid", payout_reversed: "Payout reversed" };
// Paying a fitter is an expense of the shop.
const mayPay = (biz) => biz.can("fitter_commission.approve") && biz.can("expenses.create");

export default function FittersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState("fitters");
  const [openId, setOpenId] = useState(() => (params.get("fitter") ? Number(params.get("fitter")) : null));
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (params.get("fitter")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);
  const changed = () => setVersion((n) => n + 1);
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Fitters"
        description="The painters, plumbers, electricians, masons and carpenters who bring customers. Name the fitter on a bill: their commission is worked out with it, taken back when goods come back, and paid from here."
        primary={tab === "fitters" && biz.can("fitter_commission.create") && <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add a fitter</button>} />
      <Segmented label="Show" value={tab} options={TABS} onChange={setTab} />
      {tab === "fitters" && <FitterList version={version} onOpen={setOpenId} />}
      {tab === "rules" && <Rules />}
      {tab === "payouts" && <Payouts />}
      {adding && <FitterDialog fitter={{}} onClose={() => setAdding(false)} onSaved={(f) => { setAdding(false); toast.success(`${f.name} added.`); changed(); }} />}
      {openId && <FitterStatement fitterId={openId} onClose={() => setOpenId(null)} onChanged={changed} />}
    </div>
  );
}

function FitterList({ version, onOpen }) {
  const biz = useOpenBusiness();
  const [trade, setTrade] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [dueOnly, setDueOnly] = useState(false);
  const list = useServerList("hardware/fitters", { gridId: "hardware-fitters",
    params: { ...(trade ? { trade } : {}), ...(activeOnly ? { active: "true" } : {}), ...(dueOnly ? { has_due: "true" } : {}) } });
  // A fitter added, or paid from their statement, shows at once.
  const { reload } = list;
  useEffect(() => { if (version) reload(); }, [version, reload]);
  const [editing, setEditing] = useState(null);
  const [paying, setPaying] = useState(null);
  const canPay = mayPay(biz);
  const columns = useMemo(() => [
    { key: "name", header: "Fitter", value: (f) => f.name, mobile: "title", pin: true,
      render: (f) => <span className="bz-two-line"><button type="button" className="link-button bz-link-left" onClick={() => onOpen(f.id)}>{f.name}</button>{f.area && <small className="muted">{f.area}</small>}</span> },
    { key: "trade", header: "Trade", value: (f) => tradeWord(f.trade), mobile: "subtitle" },
    { key: "phone", header: "Phone", value: (f) => f.phone || "" },
    { key: "upi_id", header: "UPI id", value: (f) => f.upi_id || "", className: "mono", defaultHidden: true },
    { key: "bill_count", header: "Bills", type: "number", value: (f) => f.bill_count, total: "sum" },
    { key: "earned", header: "Earned", type: "money", exact: true, value: (f) => Number(f.earned), total: "sum" },
    { key: "taken_back", header: "Taken back", type: "money", exact: true, value: (f) => Number(f.taken_back), total: "sum", defaultHidden: true },
    { key: "paid", header: "Paid", type: "money", exact: true, value: (f) => Number(f.paid), total: "sum" },
    { key: "due", header: "Due", type: "money", exact: true, value: (f) => Number(f.due), total: "sum", mobile: "show" },
    { key: "last_bill_at", header: "Last bill", type: "date", value: (f) => f.last_bill_at,
      render: (f) => (f.last_bill_at ? dateShort(f.last_bill_at, { year: true }) : <span className="muted">—</span>) },
    { key: "active", header: "Status", type: "status", value: (f) => (f.active ? "Active" : "Switched off"), render: (f) => <ActiveBadge active={f.active} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (f) => (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={() => onOpen(f.id)}>Statement</button>
        {canPay && Number(f.due) > 0.004 && <button type="button" className="chip-button" onClick={() => setPaying(f)}>Pay</button>}
        {biz.can("fitter_commission.edit") && <button type="button" className="chip-button" onClick={() => setEditing(f)}>Edit</button>}
      </span>
    ) },
  ], [biz, canPay, onOpen]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="users" title="Fitters">
        <DataGrid {...list.gridProps} caption="Fitters" columns={columns} currency={biz.symbol} rowNoun={["fitter", "fitters"]}
          toolbar={(
            <>
              <label className="field">
                <span>Trade</span>
                <select value={trade} onChange={(e) => setTrade(e.target.value)}>
                  <option value="">Every trade</option>
                  {TRADES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label className="checkbox bz-check"><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active fitters only</label>
              <label className="checkbox bz-check"><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> With commission due</label>
            </>
          )}
          rowClassName={(f) => (!f.active ? "dg-tone-muted" : "")}
          empty="No fitters yet" emptyHint="Add the fitters who bring customers, then choose them on their bills." emptyIcon="users" />
      </SectionCard>
      {editing && <FitterDialog fitter={editing} onClose={() => setEditing(null)} onSaved={(f) => { setEditing(null); toast.success(`${f.name} saved.`); list.reload(); }} />}
      {paying && <PayDialog fitter={paying} due={paying.due} onClose={() => setPaying(null)}
        onSaved={(p) => { setPaying(null); toast.success(`${biz.exact(p.amount)} paid to ${p.fitter_name}.`); list.reload(); }} />}
    </>
  );
}

function FitterDialog({ fitter, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(fitter.id);
  const [form, setForm] = useState({ name: fitter.name || "", trade: fitter.trade || "painter", phone: fitter.phone || "", upiId: fitter.upi_id || "",
    area: fitter.area || "", active: fitter.active ?? true });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => {
    const body = { name: form.name.trim(), trade: form.trade, phone: form.phone.trim() || null, upiId: form.upiId.trim() || null, area: form.area.trim() || null };
    return editing ? businessWrite(biz.id, `hardware/fitters/${fitter.id}`, { ...body, active: form.active }, "patch") : businessWrite(biz.id, "hardware/fitters", body);
  };
  return (
    <FormDialog title={editing ? `Edit ${fitter.name}` : "Add a fitter"} icon="users" width={600} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={editing ? "Switch a fitter off when they stop coming: what they earned and are owed stays." : "Someone who brings customers to the shop and earns commission on their bills."}>
      <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Ramesh Kumar" /></Field>
      <Field label="Trade">
        <select value={form.trade} onChange={set("trade")}>{TRADES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
      </Field>
      <Field label="Phone (optional)" hint="For the statement on WhatsApp. One fitter per number."><input maxLength={30} inputMode="tel" value={form.phone} onChange={set("phone")} /></Field>
      <Field label="UPI id (optional)" hint="To pay them from a UPI app, e.g. ramesh@okicici"><input maxLength={100} className="mono" value={form.upiId} onChange={set("upiId")} /></Field>
      <Field label="Area (optional)" wide><input maxLength={100} value={form.area} onChange={set("area")} placeholder="Where they mostly work" /></Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active (may be named on new bills)</label>}
    </FormDialog>
  );
}

// A fitter's statement: bills earned, goods back, payouts, with the running balance.
function FitterStatement({ fitterId, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [billId, setBillId] = useState(null);
  const [paying, setPaying] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `hardware/fitters/${fitterId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, fitterId, version]);
  const fitter = data?.fitter;
  const due = Number(data?.totals.due || 0);
  const share = () => {
    const t = data.totals;
    const bills = data.statement.filter((e) => e.kind === "earned").slice(-10);
    const text = [`*${biz.business.name}*`, `Commission statement for ${fitter.name} (${tradeWord(fitter.trade).toLowerCase()})`,
      `Earned ${biz.exact(t.earned)}${Number(t.takenBack) ? ` · taken back ${biz.exact(t.takenBack)} for goods returned` : ""} · paid ${biz.exact(t.paid)}`,
      `Due ${biz.exact(t.due)}`, ...bills.map((e) => `• ${e.document_no} (${dateShort(e.at, { year: true })}), ${e.customer}: ${biz.exact(e.amount)}`)].join("\n");
    window.open(whatsappLink(fitter.phone, text), "_blank", "noopener");
  };
  const print = () => {
    const money = (v) => escapeHtml(biz.exact(v));
    const t = data.totals;
    printDocument({ title: `Commission statement ${fitter.name}`, styles: `
      .st { font: 12px/1.45 system-ui, sans-serif; color: #000; } .st h1 { font-size: 16px; margin: 0; } .st h2 { font-size: 14px; margin: 4px 0 10px; }
      .st table { border-collapse: collapse; width: 100%; margin: 8px 0; } .st th, .st td { border: 1px solid #999; padding: 3px 6px; text-align: left; }
      .st td.n { text-align: right; } .st .sum td { font-weight: 700; } .st .sign { margin-top: 28px; }`,
    body: `<div class="st"><h1>${escapeHtml(biz.business.name)}</h1><h2>Commission statement: ${escapeHtml(fitter.name)} (${escapeHtml(tradeWord(fitter.trade))})${fitter.phone ? ` · ${escapeHtml(fitter.phone)}` : ""}</h2>
      <table><tbody><tr><th>Earned</th><td class="n">${money(t.earned)}</td></tr><tr><th>Taken back (goods returned)</th><td class="n">${money(t.takenBack)}</td></tr>
      <tr><th>Paid</th><td class="n">${money(t.paid)}</td></tr><tr class="sum"><th>Due</th><td class="n">${money(t.due)}</td></tr></tbody></table>
      <table><thead><tr><th>Date</th><th>What</th><th>Reference</th><th>Customer</th><th>Amount</th><th>Balance</th></tr></thead><tbody>
      ${data.statement.map((e) => `<tr><td>${escapeHtml(dateShort(e.at, { year: true }))}</td><td>${escapeHtml(ENTRY_WORDS[e.kind] || e.kind)}</td><td>${escapeHtml(e.reference || "")}</td>
        <td>${escapeHtml(e.customer || "")}</td><td class="n">${money(e.amount)}</td><td class="n">${money(e.balance)}</td></tr>`).join("")}
      </tbody></table><p class="sign">Received by ____________________ &nbsp; Date ____________</p></div>` });
  };
  return (
    <>
      <Modal title={fitter ? fitter.name : "Loading…"} icon="users" width={940} onClose={() => { if (!billId && !paying) onClose(); }}
        description={fitter ? [tradeWord(fitter.trade), fitter.phone, fitter.upi_id && `UPI ${fitter.upi_id}`, fitter.area, !fitter.active && "switched off"].filter(Boolean).join(" · ") : undefined}>
        <ErrorMessage message={error} />
        {!data && !error && <Loading />}
        {data && (
          <div className="stack bz-detail">
            <div className="bz-totals">
              <span>Earned <strong>{biz.exact(data.totals.earned)}</strong></span>
              {Number(data.totals.takenBack) > 0 && <span>Taken back <strong>{biz.exact(data.totals.takenBack)}</strong></span>}
              <span>Paid <strong>{biz.exact(data.totals.paid)}</strong></span>
              <span className={due > 0.004 ? "bz-due" : ""}>Due <strong>{biz.exact(data.totals.due)}</strong></span>
            </div>
            <DataGrid variant="compact" id="hardware-fitter-statement" caption="Statement" rows={data.statement} rowKey={(e, i) => `${e.kind}-${e.reference}-${i}`} currency={biz.symbol}
              rowNoun={["entry", "entries"]} empty="No bills with this fitter yet" columns={[
                { key: "at", header: "Date", type: "datetime", value: (e) => e.at, render: (e) => dateTime(e.at), mobile: "subtitle" },
                { key: "kind", header: "What", value: (e) => ENTRY_WORDS[e.kind] || e.kind, mobile: "title" },
                { key: "reference", header: "Reference", value: (e) => (e.kind === "earned" ? "" : e.reference || ""), className: "mono" },
                { key: "bill", header: "Bill", value: (e) => e.document_no || "",
                  render: (e) => (!e.document_no ? "" : biz.can("sales.view") ? <button type="button" className="link-button mono" onClick={() => setBillId(e.document_id)}>{e.document_no}</button> : e.document_no) },
                { key: "customer", header: "Customer", value: (e) => e.customer || "" },
                { key: "bill_value", header: "Bill before tax", type: "money", exact: true, value: (e) => (e.bill_value === null ? null : Number(e.bill_value)), defaultHidden: true },
                { key: "amount", header: "Amount", type: "money", exact: true, value: (e) => Number(e.amount), mobile: "show" },
                { key: "balance", header: "Balance", type: "money", exact: true, value: (e) => Number(e.balance) },
              ]} />
            <div className="form-actions bz-start">
              {mayPay(biz) && due > 0.004 && <button type="button" className="button" onClick={() => setPaying(true)}><Icon name="wallet" size={15} /> Pay {biz.exact(due)}</button>}
              {fitter.phone && <button type="button" className="button button-secondary" onClick={share}><Icon name="message" size={15} /> Send the statement on WhatsApp</button>}
              <button type="button" className="button button-secondary" onClick={print}><Icon name="print" size={15} /> Print the statement</button>
            </div>
            {due > 0.004 && biz.can("fitter_commission.approve") && !mayPay(biz) && (
              <p className="small muted">{biz.has("expenses") ? "A payout is recorded as a paid expense, which your role does not record." : "A payout is recorded as a paid expense: switch Daily expenses on under Settings › Business tools to pay fitters."}</p>
            )}
          </div>
        )}
      </Modal>
      {billId && <DocumentDetail documentId={billId} onClose={() => setBillId(null)} onChanged={() => { setVersion((n) => n + 1); onChanged?.(); }} />}
      {paying && fitter && <PayDialog fitter={fitter} due={data.totals.due} onClose={() => setPaying(false)}
        onSaved={(p) => { setPaying(false); toast.success(`${biz.exact(p.amount)} paid to ${p.fitter_name}.`); setVersion((n) => n + 1); onChanged?.(); }} />}
    </>
  );
}

// A payout: an expense of the shop, never more than is due. With the
// fitter's UPI id, a UPI app opens with the amount filled in.
function PayDialog({ fitter, due, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState({ amount: Number(due).toFixed(2), method: fitter.upi_id ? "upi" : "cash", reference: "", notes: "",
    locationId: String(biz.currentLocationId || locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const upi = upiPayLink({ upiId: fitter.upi_id, name: fitter.name, amount: form.amount, note: `Commission from ${biz.business.name}` });
  const submit = () => businessWrite(biz.id, `hardware/fitters/${fitter.id}/payouts`, { requestKey, amount: form.amount, ...methods.body(form.method, PAY_KINDS),
    reference: form.reference.trim() || undefined, notes: form.notes.trim() || undefined, locationId: form.locationId || undefined });
  return (
    <FormDialog title={`Pay ${fitter.name}`} icon="wallet" width={560} submitLabel="Record the payout" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={`Due ${biz.exact(due)}. The payout is recorded as a paid expense of the shop, so Daily money counts it.`}>
      <Field label={`Amount (${biz.symbol})`} hint={`Up to ${biz.exact(due)}`}><input required type="number" inputMode="decimal" min="0.01" max={Number(due)} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by">
        <select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
      </Field>
      {upi && methods.body(form.method, PAY_KINDS).method === "upi" && (
        <p className="field-wide small hw-upi"><a className="button button-secondary button-sm" href={upi}><Icon name="external" size={14} /> Pay {fitter.upi_id} in a UPI app</a> <span className="muted">Then type the UPI reference below.</span></p>
      )}
      <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} placeholder="UPI or bank reference" /></Field>
      {locations.length > 1 && (
        <Field label="Paid at">
          <select required value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </Field>
      )}
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} placeholder="e.g. October commission" /></Field>
    </FormDialog>
  );
}

// --- Rules ----------------------------------------------------------------------------------

const scopeOf = (r) => (r.scope === "item" ? r.sku_label : r.scope === "category" ? `${r.category_name} (and the categories under it)` : "Every item");
const rateOf = (r, biz) => (r.per_unit !== null && r.per_unit !== undefined ? `${biz.exact(r.per_unit)} a ${r.sku_unit || "unit"}` : `${Number(r.percent)}% of the value before GST`);
const WINS = { item: "its category's rule and the rule for every item", category: "the rule for every item", all: "nothing: it applies where no other rule does" };

function Rules() {
  const biz = useOpenBusiness();
  const list = useServerList("hardware/fitter-rules", { gridId: "hardware-fitter-rules" });
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const canEdit = biz.can("fitter_commission.edit");
  const toggle = async (rule) => {
    try {
      await businessWrite(biz.id, `hardware/fitter-rules/${rule.id}`, { active: !rule.active }, "patch");
      toast.success(`${scopeOf(rule)}: ${rule.active ? "switched off" : "switched on"}.`);
      setError("");
      list.reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const columns = [
    { key: "scope", header: "On", value: (r) => scopeOf(r), mobile: "title", pin: true },
    { key: "rate", header: "Commission", value: (r) => Number(r.per_unit ?? r.percent), mobile: "show", render: (r) => rateOf(r, biz) },
    { key: "wins", header: "Wins over", value: (r) => WINS[r.scope] },
    { key: "updated_at", header: "Changed", type: "datetime", value: (r) => r.updated_at, defaultHidden: true },
    { key: "active", header: "Status", type: "status", value: (r) => (r.active ? "Active" : "Switched off"), render: (r) => <ActiveBadge active={r.active} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <span className="bz-row-actions">
        {r.active && <button type="button" className="chip-button" onClick={() => setEditing(r)}>Change</button>}
        <button type="button" className="chip-button" onClick={() => toggle(r)}>{r.active ? "Switch off" : "Switch on"}</button>
      </span>
    ) },
  ].filter(Boolean);
  return (
    <>
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="percent" title="Commission rules" description="A line earns by its item's rule, else its category's (the nearest one up), else the rule for every item. A bill keeps what it earned when a rule changes."
        actions={canEdit && <button type="button" className="button button-sm" onClick={() => setEditing({})}><Icon name="plus" size={15} /> Add a rule</button>}>
        <DataGrid {...list.gridProps} caption="Commission rules" columns={columns} rowNoun={["rule", "rules"]} rowClassName={(r) => (!r.active ? "dg-tone-muted" : "")}
          empty="No commission rules yet" emptyHint="Without a rule, a fitter's bills earn nothing." emptyIcon="percent" />
      </SectionCard>
      {editing && <RuleDialog rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast.success("Commission rule saved. It applies to bills from now on."); list.reload(); }} />}
    </>
  );
}

function RuleDialog({ rule, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(rule.id);
  const { options, error } = useOptions(editing ? [] : ["categories?active=true", "catalog?active=true"]);
  const perUnit = rule.per_unit !== null && rule.per_unit !== undefined;
  const [form, setForm] = useState({ scope: "category", categoryId: "", sku: null, mode: perUnit ? "per_unit" : "percent",
    percent: rule.percent && !perUnit ? String(Number(rule.percent)) : "", perUnit: perUnit ? String(Number(rule.per_unit)) : "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value, ...(name === "scope" && e.target.value !== "item" ? { mode: "percent" } : {}) }));
  const scope = editing ? rule.scope : form.scope;
  const rate = form.mode === "per_unit" ? { perUnit: form.perUnit } : { percent: form.percent };
  const submit = () => (editing ? businessWrite(biz.id, `hardware/fitter-rules/${rule.id}`, rate, "patch")
    : businessWrite(biz.id, "hardware/fitter-rules", { ...(scope === "category" ? { categoryId: form.categoryId } : {}), ...(scope === "item" ? { skuId: form.sku?.id } : {}), ...rate }));
  const items = options?.["catalog?active=true"] || [];
  return (
    <FormDialog title={editing ? `Change the rule for ${scopeOf(rule).replace(/ \(.*\)$/, "")}` : "Add a commission rule"} icon="percent" width={600} onSubmit={submit} onClose={onClose} onSaved={onSaved}
      disabled={!editing && !options} description="Changing a rule never changes commission already earned on a bill.">
      <FormError message={error} />
      {!editing && (
        <>
          <Field label="On">
            <select value={form.scope} onChange={set("scope")}>
              <option value="all">Every item</option>
              <option value="category">A category (and the categories under it)</option>
              <option value="item">One item</option>
            </select>
          </Field>
          {form.scope === "category" && (
            <Field label="Category">
              <select required value={form.categoryId} onChange={set("categoryId")}>
                <option value="">Choose the category…</option>
                {(options?.["categories?active=true"] || []).map((c) => <option key={c.id} value={c.id}>{c.path || c.name}</option>)}
              </select>
            </Field>
          )}
          {form.scope === "item" && (
            <div className="field field-wide">
              <SearchPicker label="Item" required options={items} value={form.sku} getKey={(s) => s.id} getLabel={(s) => s.label}
                getKeywords={(s) => `${s.code || ""} ${s.barcode || ""}`} getDescription={(s) => [s.code, s.unit && `per ${s.unit}`].filter(Boolean).join(" · ")}
                placeholder="Type the item's name or code" onChange={(sku) => setForm((f) => ({ ...f, sku }))} />
            </div>
          )}
        </>
      )}
      {scope === "item" && (
        <Field label="Pay as">
          <select value={form.mode} onChange={set("mode")}>
            <option value="percent">A percent of the value before GST</option>
            <option value="per_unit">An amount for each unit sold</option>
          </select>
        </Field>
      )}
      {form.mode === "per_unit"
        ? <Field label={`Per ${form.sku?.unit || rule.sku_unit || "unit"} (${biz.symbol})`} hint="e.g. ₹2 for every bag of cement"><input required type="number" inputMode="decimal" min="0.01" step="0.01" value={form.perUnit} onChange={set("perUnit")} /></Field>
        : <Field label="Commission (%)" hint="Of each line's value before GST, after discounts; up to 50%"><input required type="number" inputMode="decimal" min="0.01" max="50" step="0.01" value={form.percent} onChange={set("percent")} /></Field>}
    </FormDialog>
  );
}

// --- Payouts --------------------------------------------------------------------------------

function Payouts() {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const list = useServerList("hardware/fitter-payouts", { gridId: "hardware-fitter-payouts", period: true });
  const columns = useMemo(() => [
    { key: "created_at", header: "Paid on", type: "datetime", value: (p) => p.created_at, mobile: "subtitle", render: (p) => dateTime(p.created_at) },
    { key: "fitter_name", header: "Fitter", value: (p) => p.fitter_name, mobile: "title", pin: true },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (p) => Number(p.amount), mobile: "show" },
    { key: "method", header: "By", value: (p) => p.method_name || methods.name(p.method, PAY_KINDS) },
    { key: "reference", header: "Reference", value: (p) => p.reference || "", className: "mono" },
    { key: "location_name", header: "Paid at", value: (p) => p.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "notes", header: "Notes", value: (p) => p.notes || "" },
    { key: "reversed", header: "Status", type: "status", value: (p) => (p.reversed ? "Reversed" : "Paid"),
      render: (p) => <span title={p.void_reason || undefined}><Badge tone={p.reversed ? "neutral" : "success"} label={p.reversed ? "Reversed" : "Paid"} /></span> },
    { key: "void_reason", header: "Reversal reason", value: (p) => p.void_reason || "", defaultHidden: true },
    { key: "created_by_name", header: "Recorded by", value: (p) => p.created_by_name, defaultHidden: true },
  ], [biz, methods]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="wallet" title="Payouts to fitters" description="Each payout is a paid expense of the shop. To take one back, reverse its expense under Daily money › Expenses.">
        <DataGrid {...list.gridProps} caption="Payouts to fitters" columns={columns} currency={biz.symbol} rowNoun={["payout", "payouts"]}
          rowClassName={(p) => (p.reversed ? "dg-tone-muted" : "")} toolbar={<PeriodFilter list={list} />}
          empty="Nothing paid in these dates" emptyHint="Pay a fitter from their statement." emptyIcon="wallet" />
      </SectionCard>
    </>
  );
}
