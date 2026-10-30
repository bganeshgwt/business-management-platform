import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import StatTile from "../../../components/StatTile";
import StatusBadge from "../../../components/StatusBadge";
import DataGrid from "../../../components/DataGrid/DataGrid";
import FormField from "../../../components/FormField";
import { EmptyState, ErrorMessage, Loading } from "../../../components/Feedback";
import FormDialog from "../../business/core/pages/FormDialog";
import { getErrorMessage } from "../../../services/api";
import { toast } from "../../../services/toast";
import { confirmAction } from "../../../services/confirm";
import { formatLabel } from "../../../services/restaurantFormats";
import { GST_STATES } from "../../business/core/pages/invoice";
import { count, moneyExact, relative } from "@bmp/shared/format";
import { today } from "@bmp/shared/dates";
import { resetPlatformAdminPassword, resetPlatformBusinessOwner, setPlatformBusinessStatus, setPlatformRestaurantStatus } from "../services/platform.service";
import {
  consoleBusiness, giveConsoleAddons, giveConsoleTime, issueConsoleTaxInvoice, makeConsoleOrder, recordConsolePayment, setConsoleSelection,
} from "../services/console.service";
import { METHOD_WORDS, PAYMENT_STATES, PERIOD_KINDS, dayWords, endsWords, priceWords, stateWords } from "../consoleWords";
import "../styles/console.css";

// One business as the platform sees it (/platform/businesses/:businessId):
// its plan's state and when its time ends, the plan and add-ons of its next
// order, what it may use now, its owners, how much it is used (counts and
// dates only, never its customers, bills or patients), and its timeline:
// the time it was given or paid for, modules given or bought, orders with
// their payments, and invoices. From here the platform gives it time or a
// module, changes its plan, makes its order, records a payment, issues the
// tax invoice for an order invoiced while the GSTIN was the sample one,
// switches it off or on, and sets a new password for a locked-out owner.
const PERIODS = { month: "monthly", year: "yearly" };
const ORDER_STATES = { open: { label: "Open", tone: "info" }, paid: { label: "Paid", tone: "success" }, cancelled: { label: "Cancelled", tone: "neutral" } };
const money = (value) => moneyExact(Number(value || 0));
const STATE_OPTIONS = Object.entries(GST_STATES).map(([code, name]) => [String(code).padStart(2, "0"), name]).sort((a, b) => a[1].localeCompare(b[1]));

export default function PlatformBusinessPage() {
  const { businessId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [dialog, setDialog] = useState(null);

  const load = useCallback(() => consoleBusiness(businessId)
    .then((result) => { setData(result); setError(""); })
    .catch((err) => { if (err.response?.status === 404) setMissing(true); else setError(getErrorMessage(err)); }), [businessId]);

  useEffect(() => { load(); }, [load]);

  if (missing) {
    return (
      <div className="stack pc-page">
        <PageHeader icon="store" eyebrow="Platform" title="No such business" />
        <EmptyState icon="store" message="There is no business at this address." action={<Link className="button" to="/platform/businesses">All businesses</Link>} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="stack pc-page">
        <PageHeader icon="store" eyebrow="Platform" title="Business" />
        {error ? <ErrorMessage message={error} /> : <Loading />}
      </div>
    );
  }

  const { business, plan } = data;
  const restaurant = Boolean(business.restaurantId);
  const on = (restaurant ? business.restaurantStatus : business.status) === "active";
  const openOrder = data.orders.find((o) => o.status === "open");
  const closed = () => { setDialog(null); load(); };

  const switchOnOff = async () => {
    const next = on ? "inactive" : "active";
    const yes = await confirmAction({
      title: on ? `Switch off ${business.name}?` : `Switch on ${business.name}?`,
      message: on ? "Its people are signed out and cannot open it until it is switched on again. Nothing is deleted." : "Its people can sign in and use it again at once.",
      confirmLabel: on ? "Switch off" : "Switch on", tone: on ? "danger" : "primary",
    });
    if (!yes) return;
    try {
      if (restaurant) await setPlatformRestaurantStatus(business.restaurantId, next);
      else await setPlatformBusinessStatus(business.id, next);
      toast.success(on ? `${business.name} is switched off.` : `${business.name} is on again.`);
      load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const issueTaxInvoice = async (order) => {
    const yes = await confirmAction({ title: "Issue the tax invoice?", tone: "primary", confirmLabel: "Issue tax invoice",
      message: `Order ${order.id} was invoiced while the GSTIN was the sample one. Its tax invoice is dated today, names the day the money came, and takes the next number of the real series.` });
    if (!yes) return;
    try {
      const invoice = await issueConsoleTaxInvoice(order.id);
      toast.success(`Tax invoice ${invoice.number} issued.`);
      load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  const more = [
    { label: "Change the plan", icon: "layers", onClick: () => setDialog("selection") },
    { label: "Give a module", icon: "plus", onClick: () => setDialog("addons") },
    { label: "Make an order", icon: "receipt", onClick: () => setDialog("order") },
    ...(data.owners.length ? [{ label: "Owner's password", icon: "key", onClick: () => setDialog("password") }] : []),
    { label: on ? "Switch off" : "Switch on", icon: on ? "ban" : "check-circle", onClick: switchOnOff },
  ];

  return (
    <div className="stack pc-page">
      <PageHeader icon="store" eyebrow="Platform" title={business.name}
        description={`${restaurant ? formatLabel(business.format) : business.typeName} · ${business.code} · on the platform since ${dayWords(business.createdAt)}${on ? "" : " · switched off"}`}
        primary={<button type="button" className="button" onClick={() => setDialog("time")}>Give time</button>}
        secondary={openOrder && !openOrder.payments.some((p) => p.status === "pending")
          ? <button type="button" className="button button-secondary" onClick={() => setDialog("payment")}>Record a payment</button> : null}
        more={more} />
      <ErrorMessage message={error} />

      <SectionCard icon="layers" title="Plan" description="Its time and what it may use now, and what its next order holds.">
        <dl className="pc-facts">
          <div>
            <dt>State</dt>
            <dd>
              <span><StatusBadge status={plan.state} label={stateWords(plan.state).label} tone={stateWords(plan.state).tone} /></span>
              <span>{endsWords(plan)}</span>
              {plan.daysLeft !== null && plan.daysLeft !== undefined && <small className="muted">{plan.daysLeft === 1 ? "1 day left" : `${plan.daysLeft} days left`}</small>}
            </dd>
          </div>
          <div>
            <dt>Next order</dt>
            <dd>
              <span>{data.selection ? `${data.selection.planName || data.selection.planCode}, ${PERIODS[data.selection.billingPeriod] || data.selection.billingPeriod}` : "No plan chosen"}</span>
              {data.selection && <small className="muted">{priceWords(data.selection.billingPeriod === "month" ? data.selection.monthly : data.selection.yearly, data.selection.billingPeriod, data.gstRate)}</small>}
              {data.selection?.addons.length > 0 && (
                <span className="pc-chips">{data.selection.addons.map((a) => <span key={a.code} className="pc-chip">{a.name}</span>)}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>May use now</dt>
            <dd>
              {plan.everything ? <span>Everything its type offers</span> : (
                <span className="pc-chips">{data.entitled.filter((code) => code !== "restaurant").map((code) => <span key={code} className="pc-chip">{data.moduleNames[code] || nameOf(data, code)}</span>)}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>{data.owners.length === 1 ? "Owner" : "Owners"}</dt>
            <dd>
              {data.owners.length === 0 && <span className="muted">No owner</span>}
              {data.owners.map((o) => (
                <span key={o.id} className="bz-two-line">
                  <strong>{o.name}</strong>
                  <small className="muted">{[o.email, o.mobile].filter(Boolean).join(" · ")}</small>
                  <small className="muted">Last signed in {o.lastLoginAt ? relative(o.lastLoginAt) : "never"}</small>
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt>Business</dt>
            <dd>
              <span>{[business.city, business.stateName].filter(Boolean).join(", ") || "No address yet"}</span>
              {business.gstin && <small className="muted mono">GSTIN {business.gstin}</small>}
              <small className="muted">{business.timezone} · {business.currency}</small>
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard icon="activity" title="How much it is used"
        description="Counts and dates only: the platform never sees a business's customers, bills or patients, or what its sales came to.">
        <div className="stat-grid">
          <StatTile icon="login" tone="primary" label="Last active" value={business.lastActiveAt ? relative(business.lastActiveAt) : "Never"}
            note={data.usage.lastSignInAt ? `last sign-in ${relative(data.usage.lastSignInAt)}` : "nobody has signed in"} />
          <StatTile icon="receipt" tone="info" label={restaurant ? "Bills this month" : "Sales this month"} value={count(data.usage.salesThisMonth)} note={`${count(data.usage.salesTotal)} in all`} />
          <StatTile icon="users" tone="neutral" label="Active people" value={count(data.usage.activeUsers)} note="with a login that works here" />
          <StatTile icon="store" tone="neutral" label={restaurant ? "Outlets" : "Locations"} value={count(data.usage.activeLocations)} note="active" />
        </div>
      </SectionCard>

      <Timeline data={data} onRecord={() => setDialog("payment")} onTaxInvoice={issueTaxInvoice} />

      {dialog === "time" && <GiveTimeDialog data={data} onClose={() => setDialog(null)} onSaved={closed} />}
      {dialog === "addons" && <GiveModulesDialog data={data} onClose={() => setDialog(null)} onSaved={closed} />}
      {dialog === "selection" && <SelectionDialog data={data} onClose={() => setDialog(null)} onSaved={closed} />}
      {dialog === "order" && <OrderDialog data={data} onClose={() => setDialog(null)} onSaved={closed} />}
      {dialog === "payment" && openOrder && <PaymentDialog data={data} order={openOrder} onClose={() => setDialog(null)} onSaved={closed} />}
      {dialog === "password" && <PasswordDialog data={data} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />}
    </div>
  );
}

const nameOf = (data, code) => data.catalogue.addons.find((a) => a.code === code)?.name || code;

function Timeline({ data, onRecord, onTaxInvoice }) {
  // "Now" is the business's own date (a restaurant's own time zone).
  const now = data.business.today || today();
  const realInvoiceOf = (orderId) => data.invoices.find((i) => i.orderId === orderId && !i.sample);
  const sampleInvoiceOf = (orderId) => data.invoices.find((i) => i.orderId === orderId && i.sample);
  const unlocks = (p) => (p.everything ? "Everything" : `${p.planName || "Plan"}${p.modules.length ? ` · ${p.modules.length} module${p.modules.length === 1 ? "" : "s"}` : ""}`);
  const periodState = (p) => {
    if (p.cancelledAt) return `Cancelled: ${p.cancelReason}`;
    if (p.startsOn > now) return "Starts later";
    if (!p.endsOn || p.endsOn >= now) return "Now";
    return "Over";
  };
  const periodColumns = useMemo(() => [
    { key: "kind", header: "Time", value: (p) => PERIOD_KINDS[p.kind] || p.kind, mobile: "title" },
    { key: "from", header: "From", type: "date", value: (p) => p.startsOn },
    { key: "to", header: "To", type: "date", value: (p) => p.endsOn || "", render: (p) => (p.endsOn ? dayWords(p.endsOn) : "No end date") },
    { key: "unlocks", header: "Unlocks", value: unlocks, render: (p) => <span title={p.modules.map((code) => data.moduleNames[code] || code).join(", ")}>{unlocks(p)}</span> },
    { key: "reason", header: "Reason", value: (p) => p.reason || "" },
    { key: "state", header: "", label: "Now", value: periodState, render: (p) => {
      const words = periodState(p);
      return words === "Now" ? <StatusBadge status="active" label="Now" tone="success" /> : <span className={p.cancelledAt ? "muted" : ""}>{words}</span>;
    } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [data]);

  const orderColumns = useMemo(() => [
    { key: "id", header: "Order", value: (o) => o.id, mobile: "title", render: (o) => `No. ${o.id}` },
    { key: "made", header: "Made", type: "date", value: (o) => o.createdAt },
    { key: "what", header: "For", value: (o) => (o.kind === "subscription" ? `${o.lines[0]?.name || "Plan"}, ${PERIODS[o.billingPeriod]}` : `Add-ons: ${o.lines.map((l) => l.name).join(", ")}`) },
    { key: "dates", header: "Dates", value: (o) => `${dayWords(o.startsOn)} to ${dayWords(o.endsOn)}` },
    { key: "total", header: "Total", type: "money", exact: true, value: (o) => Number(o.total) },
    { key: "status", header: "Status", type: "status", value: (o) => ORDER_STATES[o.status]?.label || o.status,
      render: (o) => <StatusBadge status={o.status} label={ORDER_STATES[o.status]?.label || o.status} tone={ORDER_STATES[o.status]?.tone} /> },
    { key: "payments", header: "Payments", value: (o) => o.payments.map((p) => `${METHOD_WORDS[p.method] || p.method} ${p.reference}`).join(", "),
      render: (o) => o.payments.map((p) => (
        <span key={p.id} className="bz-two-line"><span>{METHOD_WORDS[p.method] || p.method} · {p.reference}</span>
          <small className="muted">{PAYMENT_STATES[p.status]?.label || p.status}{p.decisionNote ? `: ${p.decisionNote}` : ""}</small></span>
      )) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => {
      if (o.status === "open" && !o.payments.some((p) => p.status === "pending")) return <button type="button" className="chip-button" onClick={onRecord}>Record payment</button>;
      if (o.status === "paid" && !data.sampleMode && sampleInvoiceOf(o.id) && !realInvoiceOf(o.id)) {
        return <button type="button" className="chip-button" onClick={() => onTaxInvoice(o)}>Issue tax invoice</button>;
      }
      return null;
    } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [data]);

  return (
    <>
      <SectionCard icon="calendar" title="Time it may be used" description="Trials, paid time and time given, as they were made; a period is never changed, only cancelled with a reason." flush>
        <DataGrid id="platform-business-periods" caption="Time it may be used" variant="compact" pageSize={false} rows={data.periods} columns={periodColumns}
          rowClassName={(p) => (p.cancelledAt ? "dg-tone-muted" : "")} empty="No time yet" emptyHint="Give it time, or it waits for its first payment." />
      </SectionCard>
      {data.grants.length > 0 && (
        <SectionCard icon="plus" title="Modules given or bought" description="A module unlocked on its own dates, on top of its plan." flush>
          <DataGrid id="platform-business-grants" caption="Modules given or bought" variant="compact" pageSize={false} rows={data.grants}
            rowClassName={(g) => (g.cancelledAt ? "dg-tone-muted" : "")} columns={[
              { key: "module", header: "Module", value: (g) => g.moduleName, mobile: "title" },
              { key: "kind", header: "How", value: (g) => (g.kind === "paid" ? `Bought (order ${g.orderId})` : "Given") },
              { key: "from", header: "From", type: "date", value: (g) => g.startsOn },
              { key: "to", header: "To", type: "date", value: (g) => g.endsOn },
              { key: "reason", header: "Reason", value: (g) => g.reason || "" },
            ]} />
        </SectionCard>
      )}
      <SectionCard icon="receipt" title="Orders and payments" description="What it was asked to pay, before and with GST, and the payments for it." flush>
        <DataGrid id="platform-business-orders" caption="Orders and payments" variant="compact" pageSize={false} rows={data.orders} columns={orderColumns}
          rowClassName={(o) => (o.status === "cancelled" ? "dg-tone-muted" : "")} empty="No orders yet" emptyHint="Its owner makes one in Your plan, or you make one here." />
      </SectionCard>
      <SectionCard icon="file" title="Invoices" flush>
        <DataGrid id="platform-business-invoices" caption="Invoices" variant="compact" pageSize={false} rows={data.invoices} columns={[
          { key: "number", header: "Number", value: (i) => i.number, mobile: "title", render: (i) => <Link to={`/platform/invoices/${i.id}`} className="mono">{i.number}</Link> },
          { key: "issued", header: "Issued", type: "date", value: (i) => i.issuedOn },
          { key: "total", header: "Total", type: "money", exact: true, value: (i) => Number(i.total) },
          { key: "sample", header: "", label: "Sample", value: (i) => (i.sample ? "SAMPLE" : ""), render: (i) => (i.sample ? <StatusBadge status="sample" label="SAMPLE" tone="warning" /> : null) },
        ]} empty="No invoices yet" emptyHint="Each payment confirmed issues one." />
      </SectionCard>
    </>
  );
}

// Plans of the business's type, and the modules a plan does not already hold.
const planOf = (data, code) => data.catalogue.plans.find((p) => p.code === code);
const extrasFor = (data, plan) => data.catalogue.addons.filter((a) => !(plan?.modules || []).some((m) => m.code === a.code));

function ModuleChecks({ label, modules, chosen, onChange, note }) {
  if (!modules.length) return null;
  return (
    <div className="field field-wide">
      <span>{label}</span>
      <div className="pc-modules">
        {modules.map((m) => (
          <label key={m.code} className="checkbox">
            <input type="checkbox" checked={chosen.includes(m.code)} onChange={(e) => onChange(e.target.checked ? [...chosen, m.code] : chosen.filter((c) => c !== m.code))} />
            <span>{m.name}{m.soldAs === "application" ? " (application)" : ""}{note ? note(m) : ""}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function GiveTimeDialog({ data, onClose, onSaved }) {
  const onTrial = data.plan.state === "trial";
  const [form, setForm] = useState({
    until: true, endsOn: "", everything: false, planCode: data.selection?.planCode || data.catalogue.plans[0]?.code || "", modules: [], reason: "", replaceTrial: onTrial,
  });
  const plan = planOf(data, form.planCode);
  return (
    <FormDialog title={`Give time: ${data.business.name}`} icon="calendar" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Give time"
      description="Free time, with a reason. It replaces time given before that covers today; otherwise it starts after the time the business already has."
      successMessage={() => `Time given to ${data.business.name}.`}
      onSubmit={() => giveConsoleTime(data.business.id, {
        ...(form.until ? { endsOn: form.endsOn } : { noEnd: true }), everything: form.everything,
        ...(form.everything ? {} : { planCode: form.planCode, modules: form.modules }), reason: form.reason.trim(), replaceTrial: onTrial && form.replaceTrial,
      })}>
      <FormField label="Until">
        <select value={form.until ? "until" : "no_end"} onChange={(e) => setForm((f) => ({ ...f, until: e.target.value === "until" }))}>
          <option value="until">A date</option><option value="no_end">No end date</option>
        </select>
      </FormField>
      {form.until && <FormField label="Free until"><input type="date" required value={form.endsOn} onChange={(e) => setForm((f) => ({ ...f, endsOn: e.target.value }))} /></FormField>}
      <label className="checkbox field-wide">
        <input type="checkbox" checked={form.everything} onChange={(e) => setForm((f) => ({ ...f, everything: e.target.checked }))} /> Unlock everything its type offers
      </label>
      {!form.everything && (
        <>
          <FormField label="Plan" wide>
            <select required value={form.planCode} onChange={(e) => setForm((f) => ({ ...f, planCode: e.target.value, modules: [] }))}>
              {data.catalogue.plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select>
          </FormField>
          <ModuleChecks label="And these modules" modules={extrasFor(data, plan)} chosen={form.modules} onChange={(modules) => setForm((f) => ({ ...f, modules }))} />
        </>
      )}
      {onTrial && (
        <label className="checkbox field-wide">
          <input type="checkbox" checked={form.replaceTrial} onChange={(e) => setForm((f) => ({ ...f, replaceTrial: e.target.checked }))} />
          Replace the free trial: the time starts the day the trial began (otherwise after the trial ends)
        </label>
      )}
      <FormField label="Reason" wide hint="Kept with the time given."><input required maxLength={300} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></FormField>
    </FormDialog>
  );
}

function GiveModulesDialog({ data, onClose, onSaved }) {
  const [form, setForm] = useState({ modules: [], endsOn: "", reason: "" });
  const offered = data.catalogue.addons.filter((a) => !data.entitled.includes(a.code));
  return (
    <FormDialog title={`Give a module: ${data.business.name}`} icon="plus" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Give"
      description="Unlocked at once, until the date you choose, on top of its plan."
      successMessage={() => "Given. It is unlocked now."}
      onSubmit={() => giveConsoleAddons(data.business.id, { modules: form.modules, endsOn: form.endsOn, reason: form.reason.trim() })}>
      {offered.length === 0 ? <p className="field-wide muted">It may already use every module its type offers.</p>
        : <ModuleChecks label="Modules and applications" modules={offered} chosen={form.modules} onChange={(modules) => setForm((f) => ({ ...f, modules }))} />}
      <FormField label="Until"><input type="date" required value={form.endsOn} onChange={(e) => setForm((f) => ({ ...f, endsOn: e.target.value }))} /></FormField>
      <FormField label="Reason" hint="Kept with what was given."><input required maxLength={300} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></FormField>
    </FormDialog>
  );
}

function SelectionDialog({ data, onClose, onSaved }) {
  const [form, setForm] = useState({
    planCode: data.selection?.planCode || data.catalogue.plans[0]?.code || "", billingPeriod: data.selection?.billingPeriod || "year",
    addons: (data.selection?.addons || []).map((a) => a.code),
  });
  const plan = planOf(data, form.planCode);
  return (
    <FormDialog title={`Change the plan: ${data.business.name}`} icon="layers" width={720} onClose={onClose} onSaved={onSaved} submitLabel="Save the plan"
      description="What its next order holds. It never changes what the business may use today."
      successMessage={() => "The plan for its next order is saved."}
      onSubmit={() => setConsoleSelection(data.business.id, form)}>
      <FormField label="Plan">
        <select required value={form.planCode} onChange={(e) => setForm((f) => ({ ...f, planCode: e.target.value }))}>
          {data.catalogue.plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
        </select>
      </FormField>
      <FormField label="Billing">
        <select value={form.billingPeriod} onChange={(e) => setForm((f) => ({ ...f, billingPeriod: e.target.value }))}>
          <option value="year">Yearly{plan ? `: ${priceWords(plan.yearly, "year", data.gstRate)}` : ""}</option>
          <option value="month">Monthly{plan ? `: ${priceWords(plan.monthly, "month", data.gstRate)}` : ""}</option>
        </select>
      </FormField>
      <ModuleChecks label="Add-ons" modules={extrasFor(data, plan)} chosen={form.addons} onChange={(addons) => setForm((f) => ({ ...f, addons }))}
        note={(m) => ` · ${priceWords(form.billingPeriod === "month" ? m.monthly : m.yearly, form.billingPeriod, data.gstRate)}`} />
    </FormDialog>
  );
}

function OrderDialog({ data, onClose, onSaved }) {
  const paidTime = data.plan.state === "paid";
  const [form, setForm] = useState({ kind: "subscription", modules: [], stateCode: "" });
  // Its orders' place of supply: its GSTIN's state (a restaurant's own GSTIN too), else its state.
  const needsState = !data.business.placeOfSupplyCode;
  return (
    <FormDialog title={`Make an order: ${data.business.name}`} icon="receipt" width={680} onClose={onClose} onSaved={onSaved} submitLabel="Make the order"
      description="The order its owner pays, with GST, held for 7 days. A new order replaces an open one that has no payment being checked."
      successMessage={(order) => `Order ${order.id} made: ${money(order.total)} with GST.`}
      onSubmit={() => makeConsoleOrder(data.business.id, { kind: form.kind, ...(form.kind === "add_on" ? { modules: form.modules } : {}), ...(form.stateCode ? { stateCode: form.stateCode } : {}) })}>
      <FormField label="Order for" wide>
        <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
          <option value="subscription">Its plan and add-ons, for one {data.selection?.billingPeriod === "month" ? "month" : "year"}</option>
          {paidTime && <option value="add_on">Modules for the rest of its paid time</option>}
        </select>
      </FormField>
      {form.kind === "add_on" && (
        <ModuleChecks label="Modules" modules={data.catalogue.addons.filter((a) => !data.entitled.includes(a.code))} chosen={form.modules}
          onChange={(modules) => setForm((f) => ({ ...f, modules }))} />
      )}
      {needsState && (
        <FormField label="Its state, for GST" wide hint="The place of supply on the invoice; saved to its settings.">
          <select required value={form.stateCode} onChange={(e) => setForm((f) => ({ ...f, stateCode: e.target.value }))}>
            <option value="">Choose…</option>
            {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
          </select>
        </FormField>
      )}
    </FormDialog>
  );
}

function PaymentDialog({ data, order, onClose, onSaved }) {
  const [form, setForm] = useState({ method: "bank", reference: "", paidOn: today() });
  return (
    <FormDialog title={`Record a payment: ${data.business.name}`} icon="money" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Record and confirm"
      description={`Money the company received for order ${order.id} (${money(order.total)} with GST). It is confirmed at once: the invoice is issued and the time added.`}
      successMessage={(result) => `Payment recorded. Invoice ${result.invoice?.number || ""} issued.`}
      onSubmit={() => recordConsolePayment(data.business.id, { orderId: order.id, method: form.method, reference: form.reference.trim(), paidOn: form.paidOn })}>
      <FormField label="Paid by">
        <select value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}>
          {Object.entries(METHOD_WORDS).map(([code, words]) => <option key={code} value={code}>{words}</option>)}
        </select>
      </FormField>
      <FormField label="Date paid"><input type="date" required max={today()} value={form.paidOn} onChange={(e) => setForm((f) => ({ ...f, paidOn: e.target.value }))} /></FormField>
      <FormField label="Reference" wide hint="The UPI or bank transaction number, the cheque number, or who handed over the cash.">
        <input required maxLength={100} value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} />
      </FormField>
    </FormDialog>
  );
}

function PasswordDialog({ data, onClose, onSaved }) {
  const [userId, setUserId] = useState(String(data.owners[0].id));
  const [password, setPassword] = useState("");
  const restaurant = Boolean(data.business.restaurantId);
  return (
    <FormDialog title={`Owner's password: ${data.business.name}`} icon="key" width={540} onClose={onClose} onSaved={onSaved} submitLabel="Set password"
      description="For an owner locked out of their own business. Their open sessions end, and they choose their own password at their next sign-in."
      successMessage={() => "New password set. Tell the owner; they choose their own at their next sign-in."}
      onSubmit={() => (restaurant ? resetPlatformAdminPassword(data.business.restaurantId, Number(userId), password) : resetPlatformBusinessOwner(data.business.id, Number(userId), password))}>
      <FormField label="Owner" wide>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          {data.owners.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.email}</option>)}
        </select>
      </FormField>
      <FormField label="New password" wide hint="8 to 72 characters.">
        <input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} />
      </FormField>
    </FormDialog>
  );
}
