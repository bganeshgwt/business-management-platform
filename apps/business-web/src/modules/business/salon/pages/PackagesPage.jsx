import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../../components/ActionMenu";
import Modal from "../../../../components/Modal";
import StatTile from "../../../../components/StatTile";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { PLAN_STATE, packageMessage, whatsappLink } from "./salon";

// Packages (sessions of services, valid for a number of days) and
// memberships (a discount on services and products) are sold on a bill like
// any service. What a client bought is kept as it was sold: changing a plan
// later only changes future sales.
const TABS = [{ value: "clients", label: "What clients hold" }, { value: "plans", label: "Plans for sale" }];

export default function PackagesPage() {
  const [tab, setTab] = useState("clients");
  const [notice, setNotice] = useState("");
  return (
    <div className="stack">
      <BusinessHeader icon="gift" title="Packages & memberships"
        description="A package pays for its sessions on later bills until it runs out or expires; a membership takes its discount off every bill while it is valid. Sell either from New bill." />
      <SuccessMessage message={notice} />
      <Segmented label="Show" value={tab} options={TABS} onChange={(value) => { setTab(value); setNotice(""); }} />
      {tab === "clients" ? <ClientPlans onNotice={setNotice} /> : <Plans onNotice={setNotice} />}
    </div>
  );
}

const STATES = [{ value: "active", label: "In use" }, { value: "used_up", label: "All used" }, { value: "expired", label: "Expired" }, { value: "cancelled", label: "Cancelled" }, { value: "", label: "All" }];

// What the salon still owes clients (pro pass F-10): active plans, sessions
// not used yet at the package's price per session, plans expiring in 30 days.
function PlanTiles({ version }) {
  const biz = useOpenBusiness();
  const [totals, setTotals] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "salon/client-plans-summary", {}, controller.signal).then(setTotals).catch(() => setTotals(null));
    return () => controller.abort();
  }, [biz.id, version]);
  return (
    <div className="sw-tiles">
      <StatTile icon="gift" tone="primary" label="Active plans" value={totals ? totals.active : undefined} loading={!totals} note="packages and memberships in use" />
      <StatTile icon="clock" tone="warning" label="Sessions not used yet" value={totals ? totals.sessions_left : undefined} loading={!totals}
        note={totals ? `${biz.amount(totals.sessions_left_value)} still owed in services` : undefined} />
      <StatTile icon="calendar" label="Expiring in 30 days" value={totals ? totals.expiring_30 : undefined} loading={!totals} note="remind them to come in" />
    </div>
  );
}

function ClientPlans({ onNotice }) {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [extending, setExtending] = useState(null);
  const [usage, setUsage] = useState(null);
  const [state, setState] = useState("active");
  const [kind, setKind] = useState("");
  const list = useServerList("salon/client-plans", { gridId: "salon-client-plans", period: true, params: { ...(state ? { state } : {}), ...(kind ? { kind } : {}) } });
  const [cancelling, setCancelling] = useState(null);
  const canEdit = biz.can("packages.edit");
  const bookSession = (p) => {
    const next = p.services.find((s) => Number(s.sessions) > Number(s.used));
    navigate(`${businessPath(biz.id, "salon-calendar")}?book=1&contact=${p.contact_id}${next ? `&sku=${next.sku_id}` : ""}`);
  };
  const unused = (p) => p.status === "active" && (p.kind === "package" ? p.sessions_used === 0 : Number(p.saved) === 0);
  const actions = (p) => [
    p.kind === "package" && p.state === "active" && biz.can("appointments.create") && { label: "Book a session", icon: "calendar", onClick: () => bookSession(p) },
    p.state === "active" && p.contact_phone && { label: "Remind on WhatsApp", icon: "message", onClick: () => window.open(whatsappLink(p.contact_phone, packageMessage(p, biz)), "_blank", "noopener") },
    canEdit && p.status === "active" && p.state !== "used_up" && { label: "Extend validity", icon: "clock", onClick: () => setExtending(p) },
    { label: "Usage", icon: "list", onClick: () => setUsage(p) },
    canEdit && unused(p) && { separator: true },
    canEdit && unused(p) && { label: "Cancel (unused)", icon: "x", danger: true, onClick: () => setCancelling(p) },
  ].filter(Boolean);
  const columns = useMemo(() => [
    { key: "contact_name", header: "Client", value: (p) => p.contact_name, mobile: "title", pin: true },
    { key: "name", header: "Package / membership", value: (p) => p.name, mobile: "subtitle" },
    { key: "kind", header: "Kind", type: "status", value: (p) => p.kind, render: (p) => <Badge tone={p.kind === "membership" ? "info" : "neutral"} label={p.kind === "membership" ? "Membership" : "Package"} /> },
    { key: "use", header: "Sessions / savings", value: (p) => (p.kind === "package" ? p.sessions_total - p.sessions_used : Number(p.saved)), mobile: "show",
      render: (p, ctx) => (p.kind === "package" ? (
        <span title={p.services.map((s) => `${s.label}: ${s.used} of ${s.sessions} used`).join("\n")}>
          {p.sessions_total - p.sessions_used} of {p.sessions_total} left
          <span className="sw-meter" aria-hidden="true"><i style={{ width: `${(100 * p.sessions_used) / Math.max(1, p.sessions_total)}%` }} /></span>
          {!ctx?.card && p.services.length > 1 && <small className="muted" style={{ display: "block" }}>{p.services.map((s) => `${s.label} ${Number(s.sessions) - Number(s.used)}/${s.sessions}`).join(" · ")}</small>}
        </span>
      ) : `${Number(p.service_discount_percent)}% / ${Number(p.product_discount_percent)}% · saved ${biz.exact(p.saved)}`) },
    { key: "price", header: "Paid", type: "money", exact: true, value: (p) => Number(p.price), total: "sum" },
    { key: "starts_on", header: "From", type: "date", value: (p) => p.starts_on, defaultHidden: true },
    { key: "ends_on", header: "Valid till", type: "date", value: (p) => p.ends_on, mobile: "show" },
    { key: "state", header: "Status", type: "status", value: (p) => p.state, render: (p) => <Badge tone={PLAN_STATE[p.state]?.tone} label={`${PLAN_STATE[p.state]?.label || p.state}${p.state === "active" && p.days_left <= 14 ? ` · ${p.days_left} days left` : ""}`} /> },
    { key: "document_no", header: "Sold on bill", value: (p) => p.document_no, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions",
      render: (p) => (
        <div className="row-actions">
          {p.kind === "package" && p.state === "active" && biz.can("appointments.create") && <button type="button" className="chip-button" onClick={() => bookSession(p)}>Book</button>}
          <ActionMenu label={`More for ${p.contact_name}'s ${p.name}`} items={actions(p)} />
        </div>
      ) },
  ].filter(Boolean), [biz, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PlanTiles version={list.data} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="users" title="Packages and memberships sold">
        <DataGrid {...list.gridProps} caption="Packages and memberships clients hold" columns={columns} currency={biz.symbol}
          rowNoun={["client plan", "client plans"]} exportName={biz.can("packages.export") ? `${biz.business.code}-client-packages` : undefined}
          rowClassName={(p) => (p.state === "cancelled" || p.state === "expired" ? "dg-tone-muted" : p.state === "active" && p.days_left <= 7 ? "dg-tone-warning" : "")}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field"><span>Status</span>
                <select value={state} onChange={(e) => setState(e.target.value)}>{STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
              </label>
              <label className="field"><span>Kind</span>
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">Both</option><option value="package">Packages</option><option value="membership">Memberships</option>
                </select>
              </label>
            </>
          )}
          empty="Nothing sold in these dates" emptyHint="Sell a package or membership from New bill, or pick other dates." emptyIcon="gift" />
      </SectionCard>
      {cancelling && (
        <ReasonDialog title={`Cancel ${cancelling.contact_name}'s ${cancelling.name}?`} submitLabel="Cancel it"
          description="Only an unused package or membership can be cancelled. Afterwards, return its line on the bill to give a credit note or refund."
          onSubmit={(reason) => businessWrite(biz.id, `salon/client-plans/${cancelling.id}/cancel`, { reason })}
          onClose={() => setCancelling(null)} onSaved={() => { setCancelling(null); onNotice(`${cancelling.name} cancelled. Return its line on bill ${cancelling.document_no} to refund it.`); list.reload(); }} />
      )}
      {extending && <ExtendDialog plan={extending} onClose={() => setExtending(null)}
        onSaved={(row) => { setExtending(null); onNotice(`${extending.contact_name}'s ${extending.name} now runs till ${dateShort(row.ends_on, { year: true })}.`); list.reload(); }} />}
      {usage && <UsageDialog plan={usage} onClose={() => setUsage(null)} />}
    </>
  );
}

// A later end date with a reason (audited); a manager's call, so it needs packages.edit.
function ExtendDialog({ plan, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const end = String(plan.ends_on).slice(0, 10);
  const plus = (days) => new Date(new Date(`${end}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
  const [form, setForm] = useState({ endsOn: plus(30), reason: "" });
  return (
    <FormDialog title={`Extend ${plan.contact_name}'s ${plan.name}`} icon="clock" width={520} submitLabel="Extend" onClose={onClose} onSaved={onSaved}
      description={`Valid till ${dateShort(end, { year: true })} now. The new date is kept with your name and the reason.`}
      onSubmit={() => businessWrite(biz.id, `salon/client-plans/${plan.id}`, form, "patch")}>
      <Field label="Valid till" hint="Quick: +30, +60 or +90 days below">
        <input required type="date" min={plus(1)} value={form.endsOn} onChange={(e) => setForm((f) => ({ ...f, endsOn: e.target.value }))} />
      </Field>
      <div className="sw-row field-wide">{[30, 60, 90].map((d) => <button key={d} type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, endsOn: plus(d) }))}>+{d} days</button>)}</div>
      <Field label="Reason" wide><input required maxLength={300} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Client was travelling" /></Field>
    </FormDialog>
  );
}

// The bill lines that used a package's sessions or a membership's discount.
function UsageDialog({ plan, onClose }) {
  const biz = useOpenBusiness();
  const list = useServerList("salon/plan-usage", { gridId: "salon-plan-usage", params: { plan: plan.id } });
  const columns = [
    { key: "created_at", header: "Date", type: "date", value: (u) => u.created_at, mobile: "subtitle" },
    { key: "label", header: plan.kind === "package" ? "Session" : "Line", value: (u) => u.label, mobile: "title" },
    { key: "quantity", header: "Qty", type: "number", value: (u) => Number(u.quantity) },
    { key: "amount", header: "Saved", type: "money", exact: true, value: (u) => (u.amount === null ? null : Number(u.amount)), total: "sum" },
    { key: "document_no", header: "Bill", value: (u) => u.document_no, mobile: "show" },
  ];
  return (
    <Modal title={`${plan.contact_name}'s ${plan.name}`} icon="list" onClose={onClose} width={640} description={`Bought on bill ${plan.document_no}, valid till ${dateShort(plan.ends_on, { year: true })}`}>
      <DataGrid {...list.gridProps} variant="compact" caption="Usage" columns={columns} currency={biz.symbol} rowNoun={["use", "uses"]} empty="Not used yet" emptyIcon="gift" />
    </Modal>
  );
}

function Plans({ onNotice }) {
  const biz = useOpenBusiness();
  const list = useServerList("salon/plans", { gridId: "salon-plans" });
  const [editing, setEditing] = useState(null);
  const canCreate = biz.can("packages.create"), canEdit = biz.can("packages.edit");
  const toggle = async (plan) => {
    await businessWrite(biz.id, `salon/plans/${plan.id}`, { active: !plan.active }, "patch");
    onNotice(`${plan.name} ${plan.active ? "is no longer sold" : "is on sale again"}.`);
    list.reload();
  };
  const columns = [
    { key: "name", header: "Plan", value: (p) => p.name, mobile: "title", pin: true },
    { key: "kind", header: "Kind", type: "status", value: (p) => p.kind, mobile: "subtitle", render: (p) => <Badge tone={p.kind === "membership" ? "info" : "neutral"} label={p.kind === "membership" ? "Membership" : "Package"} /> },
    { key: "gives", header: "Gives", value: (p) => (p.kind === "package" ? p.services.map((s) => `${s.sessions} × ${s.label}`).join(", ") : `${Number(p.service_discount_percent)}% off services, ${Number(p.product_discount_percent)}% off products`), mobile: "show" },
    { key: "worth", header: "Sessions worth", type: "money", exact: true, value: (p) => (p.kind === "package" ? p.services.reduce((s, x) => s + Number(x.price) * x.sessions, 0) : null), defaultHidden: true },
    { key: "price", header: "Price", type: "money", exact: true, value: (p) => Number(p.price), mobile: "show" },
    { key: "validity_days", header: "Valid for", type: "number", value: (p) => p.validity_days, render: (p) => `${p.validity_days} days` },
    { key: "sold", header: "Sold", type: "number", value: (p) => p.sold },
    { key: "holders", header: "Holding now", type: "number", value: (p) => p.holders },
    { key: "active", header: "Status", type: "status", value: (p) => (p.active ? "active" : "inactive"), render: (p) => <ActiveBadge active={p.active} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => (
      <div className="row-actions">
        <button type="button" className="chip-button" onClick={() => setEditing(p)}>Edit</button>
        <button type="button" className="chip-button" onClick={() => toggle(p)}>{p.active ? "Stop selling" : "Sell again"}</button>
      </div>
    ) },
  ].filter(Boolean);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="gift" title="Plans for sale"
        actions={canCreate && (
          <div className="row-actions">
            <button type="button" className="button button-sm" onClick={() => setEditing({ kind: "package" })}><Icon name="plus" size={15} /> Package</button>
            <button type="button" className="button button-secondary button-sm" onClick={() => setEditing({ kind: "membership" })}><Icon name="plus" size={15} /> Membership</button>
          </div>
        )}>
        <DataGrid {...list.gridProps} caption="Package and membership plans" columns={columns} currency={biz.symbol} rowNoun={["plan", "plans"]}
          rowClassName={(p) => (!p.active ? "dg-tone-muted" : "")} exportName={biz.can("packages.export") ? `${biz.business.code}-plans` : undefined}
          empty="No packages or memberships yet" emptyIcon="gift" />
      </SectionCard>
      {editing && <PlanDialog plan={editing} onClose={() => setEditing(null)} onSaved={(p) => { setEditing(null); onNotice(`${p.name} saved.`); list.reload(); }} />}
    </>
  );
}

function PlanDialog({ plan, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const membership = plan.kind === "membership";
  const { options, error } = useOptions(["salon/services?active=true", "tax-rates?active=true"]);
  const [form, setForm] = useState({
    name: plan.name || "", description: plan.description || "", price: plan.price ? String(Number(plan.price)) : "", validityDays: String(plan.validity_days || (membership ? 365 : 180)),
    serviceDiscountPercent: plan.service_discount_percent ? String(Number(plan.service_discount_percent)) : "10",
    productDiscountPercent: plan.product_discount_percent ? String(Number(plan.product_discount_percent)) : "5", taxRateId: plan.tax_rate_id ? String(plan.tax_rate_id) : "",
  });
  const [services, setServices] = useState(() => (plan.services || []).map((s) => ({ key: newKey(), skuId: String(s.sku_id), sessions: String(s.sessions) })).concat(plan.id ? [] : [{ key: newKey(), skuId: "", sessions: "5" }]));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const catalogue = options?.["salon/services?active=true"] || [];
  const worth = services.reduce((s, x) => s + Number(catalogue.find((c) => String(c.id) === x.skuId)?.price || 0) * Number(x.sessions || 0), 0);
  const submit = () => {
    const body = { ...form, kind: plan.kind, validityDays: Number(form.validityDays), taxRateId: form.taxRateId || null,
      ...(membership ? {} : { services: services.filter((s) => s.skuId).map((s) => ({ skuId: s.skuId, sessions: Number(s.sessions) })) }) };
    return plan.id ? businessWrite(biz.id, `salon/plans/${plan.id}`, body, "patch") : businessWrite(biz.id, "salon/plans", body);
  };
  return (
    <FormDialog title={plan.id ? `Edit ${plan.name}` : membership ? "New membership" : "New package"} icon="gift" width={680} onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}
      description={plan.id ? "Changes apply to future sales; clients keep what they bought." : undefined}>
      <FormError message={error} />
      <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} placeholder={membership ? "Gold membership" : "Hair spa × 5"} /></Field>
      <Field label={`Price (${biz.symbol})`} hint={!membership && worth ? `The sessions are worth ${biz.exact(worth)} at today's prices` : undefined}>
        <input required type="number" min="0" step="0.01" value={form.price} onChange={set("price")} />
      </Field>
      <Field label="Valid for (days)" hint="From the day it is sold"><input required type="number" min="1" max="3650" value={form.validityDays} onChange={set("validityDays")} /></Field>
      {!plan.id && (
        <Field label="GST">
          <select value={form.taxRateId} onChange={set("taxRateId")}>
            <option value="">18% (services)</option>
            {(options?.["tax-rates?active=true"] || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}
      {membership ? (
        <>
          <Field label="Discount on services (%)"><input required type="number" min="0" max="100" step="0.01" value={form.serviceDiscountPercent} onChange={set("serviceDiscountPercent")} /></Field>
          <Field label="Discount on products (%)"><input required type="number" min="0" max="100" step="0.01" value={form.productDiscountPercent} onChange={set("productDiscountPercent")} /></Field>
        </>
      ) : (
        <div className="field-wide sw-stack">
          <strong>Sessions in the package</strong>
          {services.map((s) => (
            <div key={s.key} className="sw-row">
              <select aria-label="Service" required value={s.skuId} style={{ flex: "1 1 220px" }} onChange={(e) => setServices((all) => all.map((x) => (x.key === s.key ? { ...x, skuId: e.target.value } : x)))}>
                <option value="">Choose a service…</option>
                {catalogue.map((c) => <option key={c.id} value={c.id}>{c.label} · {biz.exact(c.price)}</option>)}
              </select>
              <input aria-label="Sessions" type="number" min="1" max="100" required value={s.sessions} style={{ width: "6rem" }} onChange={(e) => setServices((all) => all.map((x) => (x.key === s.key ? { ...x, sessions: e.target.value } : x)))} />
              <button type="button" className="link-button danger" onClick={() => setServices((all) => all.filter((x) => x.key !== s.key))} disabled={services.length === 1}>Remove</button>
            </div>
          ))}
          <div><button type="button" className="button button-secondary button-sm" onClick={() => setServices((all) => [...all, { key: newKey(), skuId: "", sessions: "1" }])}><Icon name="plus" size={14} /> Add a service</button></div>
        </div>
      )}
      <Field label="Description" wide><input maxLength={300} value={form.description} onChange={set("description")} /></Field>
    </FormDialog>
  );
}
