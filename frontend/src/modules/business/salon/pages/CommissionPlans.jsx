import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { toast } from "../../../../services/toast";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { escapeHtml, printDocument } from "../../../../services/print";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, Field, FormError } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";

// Monthly target (slab) commission (round 2, R2-SVC): plans with slabs on the
// month's net service sales (after discounts and returns, before GST), which
// plan each stylist is on from which month (or the flat rules), and the
// month's payout statement with the bands worked out.

const MODE_WORDS = { stepped: "Each slab at its own rate", whole: "Whole month at the slab reached" };
const monthOf = (day) => day.slice(0, 7);
const monthLabel = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
const nextMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

function slabsText(biz, plan) {
  const slabs = plan.slabs || [];
  return slabs.map((s, n) => {
    const to = slabs[n + 1]?.from_amount;
    return `${Number(s.percent)}% ${to ? `${Number(s.from_amount) ? `${biz.amount(s.from_amount)}–` : "up to "}${biz.amount(to)}` : `above ${biz.amount(s.from_amount)}`}`;
  }).join(", ");
}

export default function CommissionPlans({ onNotice }) {
  const biz = useOpenBusiness();
  const plans = useServerList("salon/commission-plans", { gridId: "salon-commission-plans" });
  const [schemes, setSchemes] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [choosing, setChoosing] = useState(null);
  const [statement, setStatement] = useState(null);
  const canEdit = biz.can("commissions.edit");
  const month = monthOf(businessToday(biz.business.timezone));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "salon/commission-schemes", {}, controller.signal).then((r) => { setSchemes(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const toggle = async (p) => {
    try {
      await businessWrite(biz.id, `salon/commission-plans/${p.id}`, { active: !p.active }, "patch");
      toast.success(`${p.name} ${p.active ? "switched off" : "switched on"}`);
      plans.reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const planColumns = useMemo(() => [
    { key: "name", header: "Plan", value: (p) => p.name, mobile: "title", pin: true },
    { key: "slabs", header: "Slabs", value: (p) => slabsText(biz, p), mobile: "show" },
    { key: "mode", header: "Pays", value: (p) => MODE_WORDS[p.mode], mobile: "subtitle" },
    { key: "stylists", header: "Stylists", type: "number", value: (p) => p.stylists },
    { key: "active", header: "Status", type: "status", value: (p) => (p.active ? "active" : "inactive"), render: (p) => <ActiveBadge active={p.active} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => <button type="button" className="chip-button" onClick={() => toggle(p)}>{p.active ? "Switch off" : "Switch on"}</button> },
  ].filter(Boolean), [biz, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const schemeColumns = useMemo(() => [
    { key: "name", header: "Stylist", value: (r) => r.name, mobile: "title", pin: true },
    { key: "plan_name", header: `This month (${monthLabel(month)})`, value: (r) => r.plan_name || "Flat rules", mobile: "show",
      render: (r) => (r.plan_id ? <Badge tone="info" label={r.plan_name} /> : <span className="muted">Flat rules</span>) },
    { key: "later", header: "Later", value: (r) => (r.later || []).map((l) => `${monthLabel(String(l.from_month).slice(0, 7))}: ${l.plan_name || "flat rules"}`).join(" · "), mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <div className="row-actions">
        <button type="button" className="chip-button" onClick={() => setStatement(r)}>Statement</button>
        {canEdit && <button type="button" className="chip-button" onClick={() => setChoosing(r)}>Change plan</button>}
      </div>
    ) },
  ], [canEdit, month]);
  return (
    <>
      <ErrorMessage message={plans.error || error} />
      <SectionCard flush icon="users" title="Which way each stylist earns on services"
        description="Flat rules pay per bill line (the Rules tab). A target plan pays on the month's net service sales instead; products, packages sold and package sessions stay on the rules.">
        <DataGrid id="salon-commission-schemes" caption="Stylists' commission plans" columns={schemeColumns} rows={schemes || []} loading={!schemes && !error}
          rowKey={(r) => r.resource_id} rowNoun={["stylist", "stylists"]} empty="No stylists yet" emptyIcon="users" />
      </SectionCard>
      <SectionCard flush icon="percent" title="Target plans"
        actions={canEdit && <button type="button" className="button button-sm" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New plan</button>}>
        <DataGrid {...plans.gridProps} caption="Target plans" columns={planColumns} rowNoun={["plan", "plans"]} rowClassName={(p) => (!p.active ? "dg-tone-muted" : "")}
          empty="No target plans yet" emptyHint="For example 10% up to ₹50,000 of a month's service sales, 12% above." emptyIcon="percent" />
      </SectionCard>
      {creating && <PlanDialog onClose={() => setCreating(false)} onSaved={(p) => { setCreating(false); onNotice(`${p.name} saved. Choose it for a stylist under "Change plan".`); plans.reload(); }} />}
      {choosing && <SchemeDialog row={choosing} month={month} onClose={() => setChoosing(null)}
        onSaved={(s) => { setChoosing(null); onNotice(`${s.resource_name}: ${s.plan_name || "flat rules"} from ${monthLabel(String(s.from_month).slice(0, 7))}.`); setVersion((n) => n + 1); plans.reload(); }} />}
      {statement && <StatementDialog row={statement} month={month} onClose={() => setStatement(null)} />}
    </>
  );
}

function PlanDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ name: "", mode: "stepped" });
  const [slabs, setSlabs] = useState([{ key: newKey(), fromAmount: "0", percent: "10" }, { key: newKey(), fromAmount: "50000", percent: "12" }]);
  const setSlab = (key, changes) => setSlabs((all) => all.map((s) => (s.key === key ? { ...s, ...changes } : s)));
  return (
    <FormDialog title="New target plan" icon="percent" width={600} submitLabel="Save plan" onClose={onClose} onSaved={onSaved}
      description="Worked out on each month's net service sales (after discounts and returns, before GST). The slabs cannot be changed once saved, so paid months stay as they were."
      onSubmit={() => businessWrite(biz.id, "salon/commission-plans", { ...form, slabs: slabs.map((s) => ({ fromAmount: s.fromAmount, percent: s.percent })) })}>
      <Field label="Name"><input required maxLength={100} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Senior target 50k" /></Field>
      <Field label="How the slabs pay">
        <select value={form.mode} onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}>
          <option value="stepped">Each slab at its own rate (10% of the first 50,000, 12% of the rest)</option>
          <option value="whole">The whole month at the slab reached (12% of everything once past 50,000)</option>
        </select>
      </Field>
      <div className="field-wide sw-stack">
        <strong>Slabs</strong>
        {slabs.map((s, n) => (
          <div key={s.key} className="sw-row">
            <span className="muted">From {biz.symbol}</span>
            <input aria-label={`Slab ${n + 1} from`} required type="number" min="0" step="1" style={{ width: "9rem" }} value={s.fromAmount} disabled={n === 0}
              onChange={(e) => setSlab(s.key, { fromAmount: e.target.value })} />
            <input aria-label={`Slab ${n + 1} commission %`} required type="number" min="0" max="100" step="0.01" style={{ width: "6rem" }} value={s.percent}
              onChange={(e) => setSlab(s.key, { percent: e.target.value })} />
            <span className="muted">%</span>
            <button type="button" className="link-button danger" disabled={n === 0} onClick={() => setSlabs((all) => all.filter((x) => x.key !== s.key))}>Remove</button>
          </div>
        ))}
        <div className="sw-row">
          <button type="button" className="button button-secondary button-sm" disabled={slabs.length >= 10} onClick={() => setSlabs((all) => [...all, { key: newKey(), fromAmount: "", percent: "" }])}>
            <Icon name="plus" size={14} /> Add a slab
          </button>
        </div>
      </div>
    </FormDialog>
  );
}

function SchemeDialog({ row, month, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [plans, setPlans] = useState(null);
  const [form, setForm] = useState({ planId: row.plan_id ? String(row.plan_id) : "", fromMonth: month });
  useEffect(() => {
    businessRead(biz.id, "salon/commission-plans", { active: "true", limit: 100 }).then((r) => setPlans(r.items)).catch(() => setPlans([]));
  }, [biz.id]);
  return (
    <FormDialog title={`${row.name}: commission on services`} icon="percent" width={520} submitLabel="Save" onClose={onClose} onSaved={onSaved} disabled={!plans}
      description="From the month chosen on. Months already worked keep their plan."
      onSubmit={() => businessWrite(biz.id, `salon/staff/${row.resource_id}/commission-scheme`, { planId: form.planId || null, fromMonth: form.fromMonth }, "put")}>
      <Field label="Plan">
        <select value={form.planId} onChange={(e) => setForm((f) => ({ ...f, planId: e.target.value }))}>
          <option value="">Flat rules (per bill line)</option>
          {(plans || []).map((p) => <option key={p.id} value={p.id}>{p.name} — {slabsText(biz, p)}</option>)}
        </select>
      </Field>
      <Field label="From">
        <select value={form.fromMonth} onChange={(e) => setForm((f) => ({ ...f, fromMonth: e.target.value }))}>
          <option value={month}>{monthLabel(month)} (this month)</option>
          <option value={nextMonth(month)}>{monthLabel(nextMonth(month))}</option>
          <option value={nextMonth(nextMonth(month))}>{monthLabel(nextMonth(nextMonth(month)))}</option>
        </select>
      </Field>
    </FormDialog>
  );
}

const KIND_WORDS = { goods: "Products", plan: "Packages / memberships sold", session: "Package sessions" };

function StatementDialog({ row, month: current, onClose }) {
  const biz = useOpenBusiness();
  const [month, setMonth] = useState(current);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  // The statement shown is the one read for the month chosen (none while reading).
  const data = result?.month === month ? result.data : null;
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "salon/commission-statement", { month, staff: row.resource_id }, controller.signal).then((r) => { setResult({ month, data: r }); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, month, row.resource_id]);
  const months = [];
  for (let m = current, n = 0; n < 12; n += 1) {
    months.push(m);
    const [y, mm] = m.split("-").map(Number);
    m = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
  }
  const bandColumns = [
    { key: "range", header: "Slab", value: (b) => b.from, mobile: "title", render: (b) => (b.to ? `${biz.amount(b.from)} – ${biz.amount(b.to)}` : `Above ${biz.amount(b.from)}`) },
    { key: "percent", header: "Rate", type: "percent", value: (b) => Number(b.percent), mobile: "show" },
    { key: "base", header: "Sales in this slab", type: "money", exact: true, value: (b) => Number(b.base), total: "sum", mobile: "show" },
    { key: "amount", header: "Commission", type: "money", exact: true, value: (b) => Number(b.amount), total: "sum", mobile: "show" },
  ];
  return (
    <Modal title={`Payout statement — ${row.name}`} icon="receipt" width={680} onClose={onClose}>
      <div className="sw-stack">
        <div className="sw-row" style={{ alignItems: "flex-end" }}>
          <label className="field"><span>Month</span>
            <select value={month} onChange={(e) => setMonth(e.target.value)}>{months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select>
          </label>
          {data && <button type="button" className="button button-secondary" onClick={() => printStatement(biz, data)}><Icon name="print" size={15} /> Print</button>}
        </div>
        <FormError message={error} />
        {!data && !error && <p className="sw-note">Working it out…</p>}
        {data && (
          <>
            <dl className="sw-facts sw-facts-4">
              <div><dt>Plan</dt><dd>{data.scheme.name}</dd></div>
              <div><dt>Net service sales</dt><dd>{biz.exact(data.serviceSales)}</dd></div>
              <div><dt>On services</dt><dd>{biz.exact(data.serviceCommission)}</dd></div>
              <div><dt>Due</dt><dd><strong>{biz.exact(data.due)}</strong></dd></div>
            </dl>
            {data.bands.length > 0 && (
              <DataGrid id="salon-statement-bands" variant="compact" caption="Slabs" columns={bandColumns} rows={data.bands} rowKey={(b) => b.from} currency={biz.symbol}
                rowNoun={["slab", "slabs"]} pageSize={false} rowClassName={(b) => (Number(b.base) > 0 ? "" : "dg-tone-muted")} />
            )}
            <ul className="sw-list">
              {data.others.map((o) => <li key={o.kind}><span>{KIND_WORDS[o.kind] || o.kind} ({o.lines} line{o.lines === 1 ? "" : "s"}, {biz.exact(o.value)})</span><strong>{biz.exact(o.commission)}</strong></li>)}
              <li><span>Commission earned</span><strong>{biz.exact(data.commission)}</strong></li>
              <li><span>Tips</span><strong>{biz.exact(data.tips)}</strong></li>
              <li><span>Paid out for the month</span><strong>{biz.exact(data.paid)}</strong></li>
              <li><span>Still due</span><strong>{biz.exact(data.due)}</strong></li>
            </ul>
            <p className="sw-note">Pay it from By stylist with the dates set to this month.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function printStatement(biz, data) {
  const money = (v) => escapeHtml(biz.exact(v));
  const bands = data.bands.map((b) => `<tr><td>${b.to ? `${money(b.from)} – ${money(b.to)}` : `Above ${money(b.from)}`}</td><td>${escapeHtml(Number(b.percent))}%</td><td>${money(b.base)}</td><td>${money(b.amount)}</td></tr>`).join("");
  const others = data.others.map((o) => `<tr><th>${escapeHtml(KIND_WORDS[o.kind] || o.kind)}</th><td>${money(o.commission)}</td></tr>`).join("");
  printDocument({
    title: `Statement ${data.staff.name} ${data.month}`,
    styles: ".st{font:12px/1.4 system-ui,sans-serif;color:#000} .st h1{font-size:16px;margin:0} .st h2{font-size:14px;margin:4px 0} .st table{border-collapse:collapse;margin:8px 0;width:100%} .st th,.st td{border:1px solid #999;padding:3px 6px;text-align:left} .st td:last-child{text-align:right} .st .total th,.st .total td{font-weight:700} .st .sign{margin-top:28px}",
    body: `<div class="st"><h1>${escapeHtml(biz.business.name)}</h1><h2>Commission statement — ${escapeHtml(data.staff.name)}, ${escapeHtml(monthLabel(data.month))}</h2>
      <p>Plan: ${escapeHtml(data.scheme.name)} · Net service sales ${money(data.serviceSales)} (after discounts and returns, before GST)</p>
      ${bands ? `<table><thead><tr><th>Slab</th><th>Rate</th><th>Sales in slab</th><th>Commission</th></tr></thead><tbody>${bands}</tbody></table>` : ""}
      <table><tbody><tr><th>On services</th><td>${money(data.serviceCommission)}</td></tr>${others}
        <tr><th>Commission earned</th><td>${money(data.commission)}</td></tr><tr><th>Tips</th><td>${money(data.tips)}</td></tr>
        <tr><th>Paid out</th><td>${money(data.paid)}</td></tr><tr class="total"><th>Due</th><td>${money(data.due)}</td></tr></tbody></table>
      <p class="sign">Received by ____________________ &nbsp; Date ____________</p></div>`,
  });
}
