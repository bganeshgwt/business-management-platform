import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import "../styles/memberships.css";

// Trainers' pay and sales commission, by month on the business's calendar:
// each trainer's fixed sum, the classes they took (with someone attending),
// the personal-training sessions they gave, and their share of the plans
// sold for them; each salesperson's share of the plans they sold (before
// GST, less what was credited back). The rates are the shop's own, set from
// a month on. A month is paid once per person through the expense book (as
// wages), so the drawer and the day's money see it.

const PAY_KINDS = ["cash", "upi", "bank"];

export default function TrainerPayPage() {
  const biz = useOpenBusiness();
  const [month, setMonth] = useState(businessToday(biz.business.timezone).slice(0, 7));
  const [report, setReport] = useState(null);
  const [rules, setRules] = useState([]);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "member-plans/pay", { month }, controller.signal), businessRead(biz.id, "member-plans/pay/rules", undefined, controller.signal)])
      .then(([r, list]) => { setReport(r); setRules(list); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, month, version]);
  const saved = (message) => { setDialog(null); toast.success(message); setVersion((n) => n + 1); };
  const canPay = biz.can("expenses.create");
  return (
    <div className="stack">
      <BusinessHeader icon="payroll" title="Trainer pay"
        description="Each trainer's and salesperson's month from the classes, personal-training sessions and plans sold, at the shop's own rates; paid once a month through the expense book."
        primary={<button type="button" className="button" onClick={() => setDialog({ rule: {} })}><Icon name="plus" size={16} /> Set a rate</button>} />
      <ErrorMessage message={error} />
      <Field label="Month"><input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
      {!report ? <Loading /> : (
        <>
          <div className="stat-grid">
            <StatTile icon="payroll" label="To pay this month" money={Number(report.totals.amount)} note={`${biz.exact(report.totals.paid)} paid`} />
            <StatTile icon="reports" label="Personal-training sales" money={Number(report.totals.ptSales)} note="before GST" />
            <StatTile icon="reports" label="Other plans sold" money={Number(report.totals.planSales)} note="before GST" />
          </div>
          <SectionCard flush icon="payroll" title={`Pay for ${report.month}`}>
            <DataGrid variant="compact" id="member-pay" caption="Pay for the month" rows={report.rows} rowKey={(r) => `${r.person.kind}-${r.person.id}`} rowNoun={["person", "people"]}
              currency={biz.symbol} empty="No trainer or salesperson has a rate or anything to their name this month" columns={[
                { key: "name", header: "Who", value: (r) => r.person.name, mobile: "title",
                  render: (r) => <span className="bz-two-line"><span>{r.person.name}</span><small className="muted">{r.person.kind === "trainer" ? "Trainer" : "Salesperson"}{r.rule ? ` · rate from ${r.rule.from_month}` : " · no rate set"}</small></span> },
                { key: "classes", header: "Classes", type: "number", value: (r) => r.figures.classes },
                { key: "pt", header: "PT sessions", type: "number", value: (r) => r.figures.ptSessions },
                { key: "ptSales", header: "PT sales", type: "money", exact: true, value: (r) => Number(r.figures.ptSales) },
                { key: "planSales", header: "Plans sold", type: "money", exact: true, value: (r) => Number(r.figures.planSales) },
                { key: "amount", header: "Pay", type: "money", exact: true, value: (r) => Number(r.amount), total: "sum", mobile: "show",
                  render: (r) => <span title={`Fixed ${r.parts.fixed} · classes ${r.parts.classes} · PT sessions ${r.parts.ptSessions} · PT sales ${r.parts.ptSales} · plans ${r.parts.planSales}`}>{biz.exact(r.amount)}</span> },
                { key: "paid", header: "", value: (r) => (r.paid ? "Paid" : ""), render: (r) => (r.paid ? <Badge tone="success" label={`Paid ${biz.exact(r.paid.amount)}`} />
                  : canPay && Number(r.amount) > 0 ? <button type="button" className="chip-button" onClick={() => setDialog({ pay: r })}><Icon name="wallet" size={14} /> Pay</button> : null) },
              ]} />
          </SectionCard>
        </>
      )}
      <SectionCard flush icon="settings" title="Rates" description="A new rate replaces the one before from its month; rates are kept as written.">
        <DataGrid variant="compact" id="member-pay-rules" caption="Rates" rows={rules} rowKey={(r) => r.id} rowNoun={["rate", "rates"]} currency={biz.symbol} empty="No rates yet" columns={[
          { key: "name", header: "Who", value: (r) => r.name, mobile: "title" },
          { key: "from_month", header: "From", value: (r) => r.from_month, mobile: "subtitle" },
          { key: "fixed", header: "A month", type: "money", exact: true, value: (r) => Number(r.fixed_monthly) },
          { key: "per_class", header: "Per class", type: "money", exact: true, value: (r) => Number(r.per_class) },
          { key: "per_pt", header: "Per PT session", type: "money", exact: true, value: (r) => Number(r.per_pt_session) },
          { key: "pt", header: "PT sales %", type: "number", value: (r) => Number(r.pt_sales_percent) },
          { key: "plans", header: "Plans %", type: "number", value: (r) => Number(r.plan_sales_percent) },
        ]} />
      </SectionCard>
      {dialog?.rule && <RuleDialog month={month} onClose={() => setDialog(null)} onSaved={(r) => saved(`Rate for ${r.name} from ${r.from_month} saved.`)} />}
      {dialog?.pay && <PayDialog row={dialog.pay} month={report.month} onClose={() => setDialog(null)} onSaved={() => saved(`${dialog.pay.person.name} paid for ${report.month}.`)} />}
    </div>
  );
}

function RuleDialog({ month, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [people, setPeople] = useState({ trainers: [], staff: [] });
  const [form, setForm] = useState({ who: "", fromMonth: month, fixedMonthly: "", perClass: "", perPtSession: "", ptSalesPercent: "", planSalesPercent: "" });
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "resources", { limit: 100 }, controller.signal).catch(() => ({ items: [] })),
      businessRead(biz.id, "members", { limit: 100 }, controller.signal).catch(() => ({ items: [] }))])
      .then(([r, s]) => setPeople({ trainers: (r.items || []).filter((x) => x.active !== false), staff: (s.items || []).filter((x) => x.active) }));
    return () => controller.abort();
  }, [biz.id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const trainer = form.who.startsWith("t:");
  const submit = () => {
    if (!form.who) throw new Error("Choose the trainer or salesperson");
    const [kind, id] = form.who.split(":");
    return businessWrite(biz.id, "member-plans/pay/rules", { ...(kind === "t" ? { trainerId: id } : { userId: id }), fromMonth: form.fromMonth, fixedMonthly: form.fixedMonthly || "0",
      perClass: form.perClass || "0", perPtSession: form.perPtSession || "0", ptSalesPercent: form.ptSalesPercent || "0", planSalesPercent: form.planSalesPercent || "0" });
  };
  return (
    <FormDialog title="Set a rate" icon="payroll" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="A trainer of Trainers & studios, or a salesperson on the staff. The rate counts from the month chosen.">
      <Field label="Who"><select required value={form.who} onChange={set("who")}>
        <option value="">Choose…</option>
        {people.trainers.length > 0 && <optgroup label="Trainers">{people.trainers.map((t) => <option key={`t${t.id}`} value={`t:${t.id}`}>{t.name}</option>)}</optgroup>}
        {people.staff.length > 0 && <optgroup label="Salespeople">{people.staff.map((s) => <option key={`s${s.id}`} value={`s:${s.id}`}>{s.name}</option>)}</optgroup>}
      </select></Field>
      <Field label="From month"><input type="month" required value={form.fromMonth} onChange={set("fromMonth")} /></Field>
      {trainer && (
        <>
          <Field label="Fixed a month"><input type="number" min="0" step="0.01" value={form.fixedMonthly} onChange={set("fixedMonthly")} /></Field>
          <Field label="Per class taken"><input type="number" min="0" step="0.01" value={form.perClass} onChange={set("perClass")} /></Field>
          <Field label="Per personal-training session"><input type="number" min="0" step="0.01" value={form.perPtSession} onChange={set("perPtSession")} /></Field>
        </>
      )}
      <Field label="Share of personal-training sales (%)"><input type="number" min="0" max="100" step="0.01" value={form.ptSalesPercent} onChange={set("ptSalesPercent")} /></Field>
      <Field label="Share of other plans sold (%)"><input type="number" min="0" max="100" step="0.01" value={form.planSalesPercent} onChange={set("planSalesPercent")} /></Field>
    </FormDialog>
  );
}

function PayDialog({ row, month, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ method: "bank", reference: "", locationId: String(biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Pay ${row.person.name}`} icon="wallet" width={540} onClose={onClose} onSaved={onSaved} submitLabel={`Pay ${biz.exact(row.amount)}`}
      description={`${month}: fixed ${biz.exact(row.parts.fixed)}, classes ${biz.exact(row.parts.classes)}, PT sessions ${biz.exact(row.parts.ptSessions)}, PT sales ${biz.exact(row.parts.ptSales)}, plans ${biz.exact(row.parts.planSales)}. Recorded in the expense book as wages.`}
      onSubmit={() => businessWrite(biz.id, "member-plans/pay/payouts", { requestKey, month, ...(row.person.kind === "trainer" ? { trainerId: row.person.id } : { userId: row.person.id }),
        ...methods.body(form.method, PAY_KINDS), reference: form.reference.trim() || undefined, locationId: form.locationId })}>
      <Field label="Paid by"><select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} placeholder="e.g. NEFT UTR" /></Field>
      {biz.locations.length > 1 && <Field label="Paid at"><select value={form.locationId} onChange={set("locationId")}>{biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
    </FormDialog>
  );
}
