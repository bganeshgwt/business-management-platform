import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, relative } from "../../../../services/format";
import { word } from "../../../../services/businessNav";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { AccountDialog, CollectionDialog, FollowUpDialog } from "./receivablesParts";
import { printStatements, reminderText, whatsappLink } from "./receivablesFormat";

// Who owes what, and how old it is: 0–30, 31–60, 61–90 and over 90 days from
// the bill date, with what is past its due date. Advances are applied to the
// oldest items first. Shared by wholesale (outstanding) and retail (udhaar).
// Pro pass D-14: call, WhatsApp and promise on each row, the last reminder
// and promise, statements for every overdue customer at once; D-19: every
// amount to the paisa.

const SHOW = [
  { value: "owing", label: "Owing" },
  { value: "overdue", label: "Overdue" },
  { value: "advance", label: "Advances" },
  { value: "all", label: "All customers" },
];

export default function OutstandingPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [show, setShow] = useState("owing");
  const [sort, setSort] = useState("outstanding");
  const [route, setRoute] = useState("");
  const routes = biz.has("sales_orders") && biz.can("sales_orders.view");
  const { options } = useOptions(routes ? ["routes?active=true"] : []);
  const list = useServerList("outstanding", { gridId: "receivables-outstanding", params: { show, sort, ...(route ? { route } : {}) } });
  const [account, setAccount] = useState(() => (params.get("customer") ? Number(params.get("customer")) : null));
  const [collecting, setCollecting] = useState(null);
  const [following, setFollowing] = useState(null);
  const [holdRules, setHoldRules] = useState(false);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (params.get("customer")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);
  const title = word(biz.type, "outstanding", "Outstanding");
  const t = list.data?.totals;
  const today = businessToday(biz.business.timezone);

  const columns = useMemo(() => [
    { key: "name", header: "Customer", value: (r) => r.name, mobile: "title", pin: true,
      render: (r) => <button type="button" className="link-button bz-link-left" onClick={() => setAccount(r.contact_id)}>{r.name}</button> },
    { key: "phone", header: "Phone", value: (r) => r.phone || "", mobile: "subtitle",
      render: (r) => (r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : <span className="muted">—</span>) },
    { key: "balance", header: show === "advance" ? "Advance held" : "Owes", type: "money", exact: true, value: (r) => (show === "advance" ? -Number(r.balance) : Number(r.balance)), total: "sum", mobile: "show" },
    { key: "d30", header: biz.ages.first, type: "money", exact: true, value: (r) => Number(r.days_0_30), total: "sum" },
    { key: "d60", header: biz.ages.second, type: "money", exact: true, value: (r) => Number(r.days_31_60), total: "sum" },
    { key: "d90", header: biz.ages.third, type: "money", exact: true, value: (r) => Number(r.days_61_90), total: "sum" },
    { key: "d90p", header: biz.ages.over, type: "money", exact: true, value: (r) => Number(r.days_over_90), total: "sum", mobile: "show" },
    { key: "overdue", header: "Overdue", type: "money", exact: true, value: (r) => Number(r.overdue), total: "sum", mobile: "show" },
    { key: "late", header: "Days late", type: "number", value: (r) => Number(r.most_days_overdue) || null, defaultHidden: true },
    { key: "cheques", header: "Cheques in hand", type: "money", exact: true, value: (r) => Number(r.uncleared_cheques) || null, defaultHidden: true },
    { key: "promised", header: "Promised on", type: "date", value: (r) => r.promised_on,
      render: (r) => (r.promised_on ? <span className={r.promised_on < today ? "bz-due" : ""}>{dateShort(r.promised_on)}{r.promised_on < today ? " (broken)" : ""}</span> : <span className="muted">—</span>) },
    { key: "reminded", header: "Last reminder", type: "date", value: (r) => r.last_reminder_at, defaultHidden: true,
      render: (r) => (r.last_reminder_at ? relative(r.last_reminder_at) : <span className="muted">—</span>) },
    { key: "bills", header: "Open bills", type: "number", value: (r) => r.open_bills, defaultHidden: true },
    { key: "oldest", header: "Oldest bill", type: "date", value: (r) => r.oldest_bill },
    { key: "last", header: "Last paid", type: "date", value: (r) => r.last_collection_at, defaultHidden: true },
    { key: "limit", header: "Credit limit", type: "money", value: (r) => (r.credit_limit === null ? null : Number(r.credit_limit)), defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => {
      const wa = Number(r.balance) > 0 ? whatsappLink(r.phone, reminderText(r, biz)) : null;
      return (
        <div className="row-actions">
          {biz.can("receivables.create") && Number(r.balance) > 0 && <button type="button" className="chip-button" onClick={() => setCollecting(r.contact_id)}>Collect</button>}
          {wa && <a className="chip-button" href={wa} target="_blank" rel="noreferrer" title="Send a WhatsApp reminder">WhatsApp</a>}
          {biz.can("receivables.create") && Number(r.balance) > 0 && <button type="button" className="chip-button" onClick={() => setFollowing(r)}>Promise</button>}
          <button type="button" className="chip-button" onClick={() => setAccount(r.contact_id)}>Account</button>
        </div>
      );
    } },
  ], [biz, show, today]);

  // Every overdue customer's statement from their oldest unpaid bill, one per page.
  const printOverdue = async () => {
    setPrinting(true);
    try {
      const rows = [];
      for (let offset = 0; offset < 500; offset += 100) {
        const page = await businessRead(biz.id, "outstanding", { show: "overdue", sort: "name", limit: 100, offset, ...(route ? { route } : {}) });
        rows.push(...page.items);
        if (rows.length >= page.total || !page.items.length) break;
      }
      if (!rows.length) { toast.info("Nobody is overdue"); return; }
      const statements = [];
      for (const r of rows) statements.push(await businessRead(biz.id, `receivables/customers/${r.contact_id}/statement`, { from: r.oldest_bill || today, to: today }));
      printStatements(statements, biz);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="stack">
      <BusinessHeader icon="wallet" title={title}
        description="What each customer owes, by age from the bill date, and what is past its due date. Money received is put against the oldest bills first; any advance lowers what they owe."
        primary={biz.can("receivables.create") && <button type="button" className="button" onClick={() => setCollecting(true)}><Icon name="plus" size={16} /> Record collection</button>}
        more={[
          ...(biz.can("receivables.print") ? [{ label: printing ? "Preparing statements…" : "Print statements for overdue customers", icon: "print", onClick: printOverdue, disabled: printing }] : []),
          ...(routes ? [{ label: "Credit hold rules", icon: "shield", onClick: () => setHoldRules(true) }] : []),
        ]} />
      <ErrorMessage message={list.error} />
      {t && (
        <div className="bz-ageing" role="list" aria-label="Totals">
          {[["Owed in all", t.outstanding, "danger"], [biz.ages.first, t.days_0_30], [biz.ages.second, t.days_31_60], [biz.ages.third, t.days_61_90], [biz.ages.over, t.days_over_90, Number(t.days_over_90) > 0 ? "danger" : ""], ["Overdue", t.overdue, Number(t.overdue) > 0 ? "warning" : ""]].map(([label, value, tone]) => (
            <div key={label} role="listitem" className={`bz-ageing-cell ${tone ? `is-${tone}` : ""}`}><small>{label}</small><strong>{biz.exact(value)}</strong></div>
          ))}
        </div>
      )}
      {t && Number(t.uncleared_cheques) > 0 && (
        <p className="muted small"><Icon name="info" size={13} /> Cheques in hand not yet cleared: {biz.exact(t.uncleared_cheques)}{Number(t.post_dated_cheques) > 0 ? ` (post-dated ${biz.exact(t.post_dated_cheques)})` : ""}. They already lower what is owed; a bounce adds them back.</p>
      )}
      <SectionCard flush icon="list" title={show === "advance" ? "Customers holding an advance" : "Customers"}>
        <DataGrid {...list.gridProps} caption={title} columns={columns} currency={biz.symbol} rowNoun={["customer", "customers"]}
          server={{ ...list.gridProps.server, totals: t ? { balance: show === "advance" ? -Number(t.balance) : Number(t.balance), d30: Number(t.days_0_30), d60: Number(t.days_31_60), d90: Number(t.days_61_90), d90p: Number(t.days_over_90), overdue: Number(t.overdue) } : undefined }}
          toolbar={(
            <>
              <Segmented label="Show" value={show} options={SHOW} onChange={setShow} />
              <label className="field">
                <span>Order</span>
                <select value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="outstanding">Most owed first</option>
                  <option value="overdue">Most overdue first</option>
                  <option value="promised">Promised soonest</option>
                  <option value="name">By name</option>
                </select>
              </label>
              {routes && (
                <label className="field">
                  <span>Route</span>
                  <select value={route} onChange={(e) => setRoute(e.target.value)}>
                    <option value="">All routes</option>
                    {(options?.["routes?active=true"] || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
          exportName={biz.can("receivables.export") ? `${biz.business.code}-outstanding` : undefined}
          rowClassName={(r) => (Number(r.days_over_90) > 0 ? "dg-tone-danger" : Number(r.overdue) > 0 ? "dg-tone-warning" : "")}
          empty={show === "advance" ? "Nobody holds an advance" : "Nobody owes anything"} emptyIcon="check" />
      </SectionCard>
      {account && <AccountDialog contactId={account} onClose={() => setAccount(null)} onChanged={() => list.reload()} />}
      {collecting && <CollectionDialog contactId={collecting === true ? null : collecting} onClose={() => setCollecting(null)}
        onSaved={(c) => { setCollecting(null); toast.success(`Receipt ${c.collection_no} saved for ${biz.exact(c.amount)}${Number(c.unallocated) ? `; ${biz.exact(c.unallocated)} kept as advance` : ""}`); list.reload(); }} />}
      {following && <FollowUpDialog customer={following} onClose={() => setFollowing(null)} onSaved={() => { setFollowing(null); list.reload(); }} />}
      {holdRules && <HoldRulesDialog onClose={() => setHoldRules(false)} />}
    </div>
  );
}

// Credit hold (pro pass D-07): hold new orders of a customer whose bill is
// more than N days past its due date; a manager can let one through.
function HoldRulesDialog({ onClose }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    businessRead(biz.id, "wholesale-settings").then((s) => setForm({
      days: s.hold_overdue_days ? String(s.hold_overdue_days) : "", charge: String(Number(s.bounce_charge ?? 500)),
      bounces: s.bounce_hold_count ? String(s.bounce_hold_count) : "", window: String(s.bounce_hold_days ?? 90),
    })).catch((err) => setError(getErrorMessage(err)));
  }, [biz.id]);
  const canEdit = biz.can("settings.edit");
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const off = !canEdit || form === null;
  return (
    <FormDialog title="Credit hold rules" icon="shield" width={600} submitLabel="Save rules" hideSubmit={!canEdit} disabled={form === null}
      successMessage="Credit rules saved"
      description="A new order for a customer on hold is refused until they pay — or a manager lets it through with their PIN and a reason. A customer can be marked 'never hold' on their details."
      onClose={onClose} onSaved={onClose} onSubmit={() => businessWrite(biz.id, "wholesale-settings", {
        holdOverdueDays: form.days || null, bounceCharge: form.charge || "0", bounceHoldCount: form.bounces || null, bounceHoldDays: form.window || "90",
      }, "put")}>
      {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
      <Field label="Hold orders when a bill is overdue by more than (days)" hint="Leave empty for no hold." wide>
        <input type="number" min="1" max="365" step="1" disabled={off} value={form?.days ?? ""} onChange={set("days")} />
      </Field>
      <Field label="Bank charge for a bounced cheque" hint="Added to the customer's account; can be changed on each bounce.">
        <input type="number" min="0" max="100000" step="0.01" required disabled={off} value={form?.charge ?? ""} onChange={set("charge")} />
      </Field>
      <Field label="Hold after this many bounced cheques" hint="Leave empty to never hold for bounces.">
        <input type="number" min="1" max="20" step="1" disabled={off} value={form?.bounces ?? ""} onChange={set("bounces")} />
      </Field>
      <Field label="…within (days)" hint="The hold lifts once the older bounces are out of this window.">
        <input type="number" min="7" max="365" step="1" required disabled={off} value={form?.window ?? ""} onChange={set("window")} />
      </Field>
      {!canEdit && <p className="field-wide muted small">The owner sets this rule.</p>}
    </FormDialog>
  );
}
