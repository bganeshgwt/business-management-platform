import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../../components/ActionMenu";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart } from "@bmp/shared/dates";
import { dateShort, dateTime } from "@bmp/shared/format";
import { escapeHtml, printDocument } from "../../../../services/print";
import { newKey } from "../../core/pages/hooks";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import "../../../../styles/business-salon-weight.css";
import CommissionPlans from "./CommissionPlans";

// What each stylist earned: commission is worked out on every bill line
// they did (on its value before GST, after discounts) from the most
// specific rule, and kept as it was; returned lines take it back in
// proportion.
const TABS = [{ value: "staff", label: "By stylist" }, { value: "lines", label: "Bill lines" }, { value: "payouts", label: "Paid out" }, { value: "rules", label: "Rules" },
  { value: "plans", label: "Target plans" }];
const KIND_WORDS = { service: "Service", goods: "Product", plan: "Package / membership sale", session: "Package session" };

export default function CommissionsPage() {
  const [tab, setTab] = useState("staff");
  const [notice, setNotice] = useState("");
  const [lineStaff, setLineStaff] = useState("");
  return (
    <div className="stack">
      <BusinessHeader icon="percent" title="Staff commissions"
        description="Commission on what each person did, after discounts and returns, plus their tips; pay it out and print a slip. Package sessions earn on the session's value." />
      <SuccessMessage message={notice} />
      <Segmented label="Show" value={tab} options={TABS} onChange={(value) => { setTab(value); setNotice(""); }} />
      {tab === "staff" && <ByStylist onNotice={setNotice} onLines={(id) => { setLineStaff(String(id)); setTab("lines"); }} />}
      {tab === "lines" && <Lines staff={lineStaff} setStaff={setLineStaff} />}
      {tab === "payouts" && <Payouts />}
      {tab === "rules" && <Rules onNotice={setNotice} />}
      {tab === "plans" && <CommissionPlans onNotice={setNotice} />}
    </div>
  );
}

// A commission slip for one stylist and period: earned, tips, paid, due and the lines.
async function printSlip(biz, row, range) {
  const lines = [];
  for (let offset = 0; ; offset += 100) {
    const page = await businessRead(biz.id, "salon/commission-lines", { staff: row.resource_id, from: range.from, to: range.to, limit: 100, offset });
    lines.push(...page.items);
    if (!page.items.length || lines.length >= page.total) break;
  }
  const money = (v) => escapeHtml(biz.exact(v));
  const body = `<div class="slip"><h1>${escapeHtml(biz.business.name)}</h1><h2>Commission slip — ${escapeHtml(row.name)}</h2>
    <p>${escapeHtml(dateShort(range.from, { year: true }))} to ${escapeHtml(dateShort(range.to, { year: true }))}</p>
    <table><tbody>
      <tr><th>Commission earned</th><td>${money(row.commission)}</td></tr><tr><th>Tips</th><td>${money(row.tips)}</td></tr>
      <tr><th>Paid out</th><td>${money(row.paid)}</td></tr><tr class="total"><th>Due</th><td>${money(row.due)}</td></tr></tbody></table>
    <table class="lines"><thead><tr><th>Date</th><th>Bill</th><th>Item</th><th>Kind</th><th>Value</th><th>Commission</th></tr></thead><tbody>
    ${lines.map((l) => `<tr><td>${escapeHtml(dateShort(l.created_at))}</td><td>${escapeHtml(l.document_no)}</td><td>${escapeHtml(l.label)}</td><td>${escapeHtml(KIND_WORDS[l.item_kind] || l.item_kind)}</td><td>${money(l.commission_base)}</td><td>${money(l.commission_after_returns)}</td></tr>`).join("")}
    </tbody></table><p class="sign">Received by ____________________ &nbsp; Date ____________</p></div>`;
  printDocument({ title: `Commission slip ${row.name}`, body, styles: `
    .slip { font: 12px/1.4 system-ui, sans-serif; color: #000; }
    .slip h1 { font-size: 16px; margin: 0; } .slip h2 { font-size: 14px; margin: 4px 0; }
    .slip table { border-collapse: collapse; margin: 8px 0; } .slip th, .slip td { border: 1px solid #999; padding: 3px 6px; text-align: left; }
    .slip td:last-child { text-align: right; } .slip .total th, .slip .total td { font-weight: 700; }
    .slip .lines { width: 100%; } .slip .sign { margin-top: 28px; }` });
}

function ByStylist({ onNotice, onLines }) {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "salon/commissions", range, controller.signal)
      .then((result) => { setData(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range, version]);
  const rows = data?.rows;
  const sum = (key) => (rows || []).reduce((s, r) => s + Number(r[key] || 0), 0);
  const [paying, setPaying] = useState(null);
  const canPay = biz.can("commissions.edit");
  const columns = useMemo(() => [
    { key: "name", header: "Stylist", value: (r) => r.name, mobile: "title", pin: true },
    { key: "role_label", header: "Role", value: (r) => r.role_label || "", mobile: "subtitle", defaultHidden: true },
    { key: "scheme", header: "On services", value: (r) => r.scheme || "Flat rules",
      render: (r) => (r.scheme ? <span title={(r.slab_months || []).map((m) => `${m.month}: ${m.plan}, month's sales ${biz.exact(m.monthSales)} → ${biz.exact(m.slab)}`).join(" · ")}><Badge tone="info" label={r.scheme} /></span> : <span className="muted">Flat rules</span>) },
    { key: "bills", header: "Bills", type: "number", value: (r) => r.bills, total: "sum", defaultHidden: true },
    { key: "services_done", header: "Services", type: "number", value: (r) => Number(r.services_done), total: "sum",
      render: (r) => `${Number(r.services_done)}${Number(r.sessions_done) ? ` (${Number(r.sessions_done)} from packages)` : ""}` },
    { key: "service_sales", header: "Service sales", type: "money", exact: true, value: (r) => Number(r.service_sales), total: "sum" },
    { key: "session_value", header: "Package sessions", type: "money", exact: true, value: (r) => Number(r.session_value), total: "sum", defaultHidden: true },
    { key: "plan_sales", header: "Packages sold", type: "money", exact: true, value: (r) => Number(r.plan_sales), total: "sum", defaultHidden: true },
    { key: "product_sales", header: "Product sales", type: "money", exact: true, value: (r) => Number(r.product_sales), total: "sum", defaultHidden: true },
    { key: "commission", header: "Earned", type: "money", exact: true, value: (r) => Number(r.commission), total: "sum", mobile: "show" },
    { key: "tips", header: "Tips", type: "money", exact: true, value: (r) => Number(r.tips), total: "sum" },
    { key: "paid", header: "Paid", type: "money", exact: true, value: (r) => Number(r.paid), total: "sum" },
    { key: "due", header: "Due", type: "money", exact: true, value: (r) => Number(r.due), total: "sum", mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <div className="row-actions">
        {canPay && Number(r.due) > 0 && <button type="button" className="chip-button" onClick={() => setPaying(r)}>Pay out</button>}
        <ActionMenu label={`More for ${r.name}`} items={[
          { label: "Bill lines", icon: "list", onClick: () => onLines(r.resource_id) },
          { label: "Print slip", icon: "print", onClick: () => printSlip(biz, r, range).catch(() => {}) },
        ]} />
      </div>
    ) },
  ], [biz, canPay, range, onLines]);
  return (
    <>
      <div className="sw-tiles">
        <StatTile icon="percent" tone="primary" label="Commission earned" money={rows ? sum("commission") : undefined} loading={!rows} note="after returns" />
        <StatTile icon="gift" label="Tips" money={rows ? sum("tips") : undefined} loading={!rows} note="owed to the stylists" />
        <StatTile icon="wallet" tone="success" label="Paid out" money={rows ? sum("paid") : undefined} loading={!rows} />
        <StatTile icon="clock" tone="warning" label="Still due" money={rows ? sum("due") : undefined} loading={!rows} note="commission and tips not paid yet" />
      </div>
      <SectionCard flush icon="users" title="Commission by stylist">
        <DataGrid id="salon-commission-staff" caption="Commission by stylist" columns={columns} rows={rows || []} loading={!rows && !error} error={rows ? "" : error}
          onRetry={() => setVersion((n) => n + 1)} currency={biz.symbol} rowNoun={["stylist", "stylists"]} defaultSort={{ key: "commission", direction: "desc" }}
          exportName={biz.can("commissions.export") ? `${biz.business.code}-commissions` : undefined}
          toolbar={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="bill dates" onChange={setRange} />}
          empty="No bill lines with a stylist in these dates" emptyHint="Pick the stylist on each line of a bill." emptyIcon="percent" />
      </SectionCard>
      {paying && <PayDialog row={paying} range={range} onClose={() => setPaying(null)}
        onSaved={(p) => { setPaying(null); onNotice(`${biz.exact(p.amount)} paid to ${p.resource_name}.`); setVersion((n) => n + 1); }} />}
    </>
  );
}

function PayDialog({ row, range, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: Number(row.due).toFixed(2), method: "cash", reference: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Pay ${row.name}`} icon="wallet" width={520} submitLabel="Record payout" onClose={onClose} onSaved={onSaved}
      description={`For ${dateShort(range.from)} to ${dateShort(range.to)}: earned ${biz.exact(row.commission)}, tips ${biz.exact(row.tips)}, paid ${biz.exact(row.paid)}.`}
      onSubmit={() => businessWrite(biz.id, "salon/commission-payouts", { resourceId: row.resource_id, from: range.from, to: range.to, ...form, reference: form.reference || null, note: form.note || null, requestKey })}>
      <Field label={`Amount (${biz.symbol})`} hint={`Due ${biz.exact(row.due)}`}><input required type="number" min="0.01" max={Number(row.due)} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by">
        <select value={form.method} onChange={set("method")}><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank transfer</option><option value="cheque">Cheque</option></select>
      </Field>
      {form.method !== "cash" && <Field label="Reference"><input required={form.method === "cheque"} maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
      <Field label="Note" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="September commission" /></Field>
    </FormDialog>
  );
}

function Payouts() {
  const biz = useOpenBusiness();
  const list = useServerList("salon/commission-payouts", { gridId: "salon-commission-payouts", period: true });
  const columns = useMemo(() => [
    { key: "created_at", header: "Paid on", type: "datetime", value: (p) => p.created_at, mobile: "subtitle", render: (p) => dateTime(p.created_at) },
    { key: "resource_name", header: "Stylist", value: (p) => p.resource_name, mobile: "title", pin: true },
    { key: "period", header: "For", value: (p) => p.period_from, render: (p) => `${dateShort(p.period_from)} – ${dateShort(p.period_to)}` },
    { key: "commission", header: "Earned then", type: "money", exact: true, value: (p) => Number(p.commission), defaultHidden: true },
    { key: "tips", header: "Tips then", type: "money", exact: true, value: (p) => Number(p.tips), defaultHidden: true },
    { key: "amount", header: "Paid", type: "money", exact: true, value: (p) => Number(p.amount), total: "sum", mobile: "show" },
    { key: "method", header: "By", value: (p) => p.method, render: (p) => ({ cash: "Cash", upi: "UPI", bank: "Bank", cheque: "Cheque" }[p.method] || p.method) },
    { key: "reference", header: "Reference", value: (p) => p.reference || "", defaultHidden: true },
    { key: "note", header: "Note", value: (p) => p.note || "" },
    { key: "created_by_name", header: "By whom", value: (p) => p.created_by_name, defaultHidden: true },
  ], []);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="wallet" title="Commission paid out">
        <DataGrid {...list.gridProps} caption="Commission payouts" columns={columns} currency={biz.symbol} rowNoun={["payout", "payouts"]}
          exportName={biz.can("commissions.export") ? `${biz.business.code}-commission-payouts` : undefined}
          toolbar={<PeriodFilter list={list} />} empty="Nothing paid out in these dates" emptyHint="Pay a stylist from By stylist." emptyIcon="wallet" />
      </SectionCard>
    </>
  );
}

function Lines({ staff, setStaff }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["salon/staff?kind=staff"]);
  const list = useServerList("salon/commission-lines", { gridId: "salon-commission-lines", period: true, params: staff ? { staff } : {} });
  const columns = useMemo(() => [
    { key: "created_at", header: "Date", type: "datetime", value: (l) => l.created_at, mobile: "subtitle" },
    { key: "document_no", header: "Bill", value: (l) => l.document_no, mobile: "title", pin: true },
    { key: "resource_name", header: "Stylist", value: (l) => l.resource_name, mobile: "show" },
    { key: "label", header: "Service / product", value: (l) => l.label, mobile: "show" },
    { key: "contact_name", header: "Client", value: (l) => l.contact_name || "Walk-in", defaultHidden: true },
    { key: "item_kind", header: "Kind", type: "status", value: (l) => l.item_kind,
      render: (l) => <Badge tone={l.item_kind === "service" || l.item_kind === "session" ? "info" : l.item_kind === "plan" ? "success" : "neutral"} label={KIND_WORDS[l.item_kind] || l.item_kind} /> },
    { key: "commission_base", header: "Value", type: "money", exact: true, value: (l) => Number(l.commission_base), total: "sum" },
    { key: "commission_percent", header: "Rate", type: "percent", value: (l) => Number(l.commission_percent),
      render: (l) => (Number(l.commission_percent) || !Number(l.commission_amount) ? `${Number(l.commission_percent)}%` : "Flat") },
    { key: "returned_quantity", header: "Returned", type: "number", value: (l) => Number(l.returned_quantity), defaultHidden: true },
    { key: "commission_after_returns", header: "Commission", type: "money", exact: true, value: (l) => Number(l.commission_after_returns), total: "sum", mobile: "show" },
  ], []);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Bill lines with a stylist">
        <DataGrid {...list.gridProps} caption="Commission per bill line" columns={columns} currency={biz.symbol} rowNoun={["line", "lines"]}
          exportName={biz.can("commissions.export") ? `${biz.business.code}-commission-lines` : undefined}
          rowClassName={(l) => (Number(l.returned_quantity) > 0 ? "dg-tone-warning" : "")}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field"><span>Stylist</span>
                <select value={staff} onChange={(e) => setStaff(e.target.value)}>
                  <option value="">Everyone</option>
                  {(options?.["salon/staff?kind=staff"] || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            </>
          )}
          empty="No lines in these dates" emptyIcon="receipt" />
      </SectionCard>
    </>
  );
}

const APPLIES = { service: "all services", goods: "all products", plan: "packages & memberships sold" };
function ruleScope(r) {
  return `${r.resource_name || "Everyone"} · ${r.sku_label || APPLIES[r.applies_to]}`;
}
const ruleRate = (r, biz) => (r.flat_amount !== null && r.flat_amount !== undefined ? `${biz.exact(r.flat_amount)} each` : `${Number(r.percent)}%`);

function Rules({ onNotice }) {
  const biz = useOpenBusiness();
  const list = useServerList("salon/commission-rules", { gridId: "salon-commission-rules" });
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const canEdit = biz.can("commissions.edit");
  const toggle = async (rule) => {
    try {
      await businessWrite(biz.id, `salon/commission-rules/${rule.id}`, { active: !rule.active }, "patch");
      onNotice(`${ruleScope(rule)}: ${rule.active ? "switched off" : "switched on"}.`);
      list.reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const columns = [
    { key: "who", header: "Who", value: (r) => r.resource_name || "Everyone", mobile: "title", pin: true },
    { key: "what", header: "On", value: (r) => r.sku_label || APPLIES[r.applies_to].replace(/^./, (c) => c.toUpperCase()), mobile: "subtitle" },
    { key: "percent", header: "Commission", value: (r) => Number(r.flat_amount ?? r.percent), mobile: "show", render: (r) => ruleRate(r, biz) },
    { key: "level", header: "Wins over", value: (r) => (r.resource_id && r.sku_id ? "every other rule" : r.resource_id ? "rules for everyone" : r.sku_id ? "everyone's general rule" : "nothing (the default)") },
    { key: "active", header: "Status", type: "status", value: (r) => (r.active ? "active" : "inactive"), render: (r) => <ActiveBadge active={r.active} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <div className="row-actions">
        {r.active && <button type="button" className="chip-button" onClick={() => setEditing(r)}>Change</button>}
        <button type="button" className="chip-button" onClick={() => toggle(r)}>{r.active ? "Switch off" : "Switch on"}</button>
      </div>
    ) },
  ].filter(Boolean);
  return (
    <>
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="percent" title="Commission rules"
        actions={canEdit && <button type="button" className="button button-sm" onClick={() => setEditing({})}><Icon name="plus" size={15} /> Add rule</button>}>
        <DataGrid {...list.gridProps} caption="Commission rules" columns={columns} rowNoun={["rule", "rules"]} rowClassName={(r) => (!r.active ? "dg-tone-muted" : "")}
          empty="No commission rules yet" emptyHint="Without a rule a stylist's lines earn 0%." emptyIcon="percent" />
      </SectionCard>
      {editing && <RuleDialog rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onNotice("Commission rule saved. It applies to bills from now on."); list.reload(); }} />}
    </>
  );
}

function RuleDialog({ rule, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["salon/staff?kind=staff&active=true", "catalog?active=true", ...(biz.has("packages") ? ["salon/plans"] : [])]);
  const flat = rule.flat_amount !== null && rule.flat_amount !== undefined;
  const [form, setForm] = useState({ resourceId: "", appliesTo: "service", skuId: "", mode: flat ? "flat" : "percent",
    percent: rule.percent && !flat ? String(Number(rule.percent)) : "10", flatAmount: flat ? String(Number(rule.flat_amount)) : "50" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value, ...(name === "appliesTo" ? { skuId: "" } : {}) }));
  const planSkus = new Set((options?.["salon/plans"] || []).map((p) => String(p.sku_id)));
  const items = form.appliesTo === "plan" ? (options?.["salon/plans"] || []).map((p) => ({ id: p.sku_id, label: p.name }))
    : (options?.["catalog?active=true"] || []).filter((s) => s.kind === form.appliesTo && !planSkus.has(String(s.id)));
  const rate = form.mode === "flat" ? { flatAmount: form.flatAmount, percent: "0" } : { percent: form.percent, flatAmount: null };
  const submit = () => (rule.id
    ? businessWrite(biz.id, `salon/commission-rules/${rule.id}`, rate, "patch")
    : businessWrite(biz.id, "salon/commission-rules", { resourceId: form.resourceId || null, appliesTo: form.appliesTo, skuId: form.skuId || null, ...rate }));
  return (
    <FormDialog title={rule.id ? `Change ${ruleScope(rule)}` : "Add a commission rule"} icon="percent" width={560} onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}
      description="Changing a rule never changes commission already earned.">
      <FormError message={error} />
      {!rule.id && (
        <>
          <Field label="For">
            <select value={form.resourceId} onChange={set("resourceId")}>
              <option value="">Every stylist</option>
              {(options?.["salon/staff?kind=staff&active=true"] || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="On">
            <select value={form.appliesTo} onChange={set("appliesTo")}>
              <option value="service">Services (and package sessions)</option><option value="goods">Products</option>
              {biz.has("packages") && <option value="plan">Selling packages & memberships</option>}
            </select>
          </Field>
          <Field label="Which one" hint="Leave as 'all' for every service or product">
            <select value={form.skuId} onChange={set("skuId")}>
              <option value="">All {form.appliesTo === "service" ? "services" : form.appliesTo === "plan" ? "packages & memberships" : "products"}</option>
              {items.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
        </>
      )}
      <Field label="Pay as">
        <select value={form.mode} onChange={set("mode")}><option value="percent">A percent of the value</option><option value="flat">A flat amount per item</option></select>
      </Field>
      {form.mode === "percent"
        ? <Field label="Commission (%)"><input required type="number" min="0" max="100" step="0.01" value={form.percent} onChange={set("percent")} /></Field>
        : <Field label={`Per item (${biz.symbol})`} hint="e.g. ₹50 for every haircut"><input required type="number" min="0" step="1" value={form.flatAmount} onChange={set("flatAmount")} /></Field>}
    </FormDialog>
  );
}
