import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { printTaxInvoice } from "../../core/pages/invoice";
import "../styles/laundry.css";

// Prepaid packages, sold as a salon sells its own: a plan of so many kilos (a
// kilo package, for bundles washed by the kilo) or pieces (for garments by the
// piece) of the services it covers, for so many days, sold as its own service
// item (its price and GST slab), so GST is charged on the bill that sells it.
// What is left when the customer buys the next one is carried into it as the
// plan says. The customers' packages with what each still holds; an unused
// one cancelled by a manager (its bill line is then credited from the bill).
// Garments taken in draw on a package at the counter (New order).

const UNIT_WORDS = { kg: "kg", piece: "pieces" };
const RULE_WORDS = { none: "Nothing is carried forward", all: "All that is left is carried forward", up_to: "Up to a quantity is carried forward" };

export default function LaundryPackagesPage() {
  const biz = useOpenBusiness();
  const [plans, setPlans] = useState(null);
  const [services, setServices] = useState([]);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  const list = useServerList("laundry/packages", { gridId: "laundry-packages" });
  const canPlan = biz.can("catalog.edit");
  const canSell = biz.can("laundry.create") && biz.can("sales.create");
  const money = biz.can("sales.view");
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "laundry/plans", undefined, controller.signal), businessRead(biz.id, "laundry/price-list", undefined, controller.signal)])
      .then(([p, l]) => { setPlans(p); setServices(l.services); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const done = (message) => { setDialog(null); toast.success(message); setVersion((n) => n + 1); list.reload(); };
  const serviceNames = (ids) => ids.map((x) => services.find((s) => String(s.id) === String(x))?.name).filter(Boolean).join(", ");
  if (!plans) return <div className="stack"><BusinessHeader icon="gift" title="Packages" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <BusinessHeader icon="gift" title="Packages"
        description="Prepaid kilos or pieces of the services a package covers, for its days. GST is charged on the bill that sells it; garments taken in then draw on it."
        primary={canSell && plans.some((p) => p.active) && <button type="button" className="button" onClick={() => setDialog({ kind: "sell" })}><Icon name="plus" size={16} /> Sell a package</button>}
        secondary={canPlan && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "plan" })}><Icon name="plus" size={16} /> Add a plan</button>} />
      <SectionCard flush icon="gift" title="Plans">
        <DataGrid variant="compact" id="laundry-plans" caption="Package plans" rows={plans} rowKey={(p) => p.id} rowNoun={["plan", "plans"]} currency={biz.symbol} columns={[
          { key: "name", header: "Plan", value: (p) => p.name, mobile: "title", render: (p) => <span className="bz-two-line"><span>{p.name}</span><small className="muted mono">{p.item_code}</small></span> },
          { key: "holds", header: "Holds", value: (p) => Number(p.quantity), render: (p) => `${Number(p.quantity)} ${UNIT_WORDS[p.unit]} for ${p.validity_days} days`, mobile: "show" },
          { key: "services", header: "Covers", value: (p) => serviceNames(p.service_ids) },
          { key: "carry", header: "What is left", value: (p) => p.carry_forward,
            render: (p) => (p.carry_forward === "none" ? "Not carried" : `${p.carry_forward === "all" ? "All" : `Up to ${Number(p.carry_max)} ${UNIT_WORDS[p.unit]}`} carried, within ${p.carry_days} days of the end`) },
          money && { key: "price", header: "Price", type: "money", exact: true, value: (p) => Number(p.price), render: (p) => `${biz.exact(p.price)} + GST ${Number(p.tax_rate)}%` },
          { key: "sold", header: "Sold", type: "number", value: (p) => p.sold },
          { key: "active", header: "Sold now", value: (p) => (p.active ? "Yes" : "No"), render: (p) => <ActiveBadge active={p.active && p.item_active} /> },
          canPlan && { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => (
            <button type="button" className="chip-button" onClick={() => businessWrite(biz.id, `laundry/plans/${p.id}`, { active: !p.active }, "put")
              .then(() => done(p.active ? `${p.name} is not sold now.` : `${p.name} is sold again.`)).catch((err) => toast.error(getErrorMessage(err)))}>{p.active ? "Stop selling" : "Sell again"}</button>) },
        ].filter(Boolean)} empty="No plans yet" emptyHint={canPlan ? "Add a plan: say Wash & fold 30 kg a month, or 50 pieces ironed." : undefined} emptyIcon="gift" />
      </SectionCard>
      <SectionCard flush icon="users" title="Customers' packages">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Customer, phone or bill" }} caption="Customers' packages" rowNoun={["package", "packages"]}
          currency={biz.symbol} rowClassName={(p) => (p.status === "cancelled" || p.ended ? "dg-tone-muted" : "")} columns={[
            { key: "customer", header: "Customer", value: (p) => `${p.customer_name} ${p.customer_phone || ""}`, mobile: "title",
              render: (p) => <span className="bz-two-line"><span>{p.customer_name}</span><small className="muted">{p.customer_phone || ""}</small></span> },
            { key: "name", header: "Package", value: (p) => p.name, render: (p) => <span className="bz-two-line"><span>{p.name}</span><small className="muted mono">{p.document_no}</small></span> },
            { key: "left", header: "Left", value: (p) => Number(p.left_now), mobile: "show",
              render: (p) => <span className="bz-two-line"><span>{Number(p.left_now)} of {Number(p.quantity) + Number(p.carried_in)} {UNIT_WORDS[p.unit]}</span>
                <small className="muted">{[Number(p.carried_in) > 0 ? `${Number(p.carried_in)} carried in` : null, p.carried_on ? `${Number(p.carried_on)} carried on` : null].filter(Boolean).join(" · ")}</small></span> },
            { key: "ends", header: "Runs", value: (p) => p.ends_on, render: (p) => (
              <span className="bz-two-line"><span>{dateShort(p.starts_on, { year: true })} to {dateShort(p.ends_on, { year: true })}</span>
                <small>{p.status === "cancelled" ? <Badge tone="neutral" label="Cancelled" /> : p.in_force ? <Badge tone="success" label="In force" /> : p.ended ? "ended" : "to come"}</small></span>) },
            { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => (
              <span className="bz-row-actions">
                {money && <button type="button" className="chip-button" onClick={() => businessRead(biz.id, `documents/${p.document_id}`).then((doc) => printTaxInvoice(doc, biz)).catch((err) => toast.error(getErrorMessage(err)))}>Bill</button>}
                {biz.can("laundry.cancel") && p.status === "active" && Number(p.used) === 0 && !p.carried_on && Number(p.carried_in) === 0
                  && <button type="button" className="chip-button" onClick={() => setDialog({ kind: "cancel", pack: p })}>Cancel</button>}
              </span>) },
          ]} empty="No packages sold yet" emptyIcon="gift" />
      </SectionCard>
      {dialog?.kind === "plan" && <PlanDialog services={services.filter((s) => s.active)} onClose={() => setDialog(null)} onSaved={() => done("Plan added.")} />}
      {dialog?.kind === "sell" && <SellDialog plans={plans.filter((p) => p.active && p.item_active)} onClose={() => setDialog(null)} onSaved={(p) => done(`${p.name} sold to ${p.customer_name} (${p.document_no}).`)} />}
      {dialog?.kind === "cancel" && <CancelPackageDialog pack={dialog.pack} onClose={() => setDialog(null)} onSaved={() => done(`${dialog.pack.name} cancelled: its bill line can now be credited from the bill.`)} />}
    </div>
  );
}

function PlanDialog({ services, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["tax-rates?active=true"]);
  const slabs = options?.["tax-rates?active=true"] || [];
  const [form, setForm] = useState({ name: "", unit: "kg", quantity: "", validityDays: "30", carryForward: "none", carryMax: "", carryDays: "0", price: "", taxRateId: "", hsnCode: "", serviceIds: [] });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const slab = form.taxRateId || String(slabs.find((r) => r.is_default)?.id || "");
  const toggle = (sid) => setForm((f) => ({ ...f, serviceIds: f.serviceIds.includes(sid) ? f.serviceIds.filter((x) => x !== sid) : [...f.serviceIds, sid] }));
  return (
    <FormDialog title="Add a package plan" icon="gift" width={680} onClose={onClose} onSaved={onSaved} submitLabel="Add the plan"
      description="The plan is sold as its own service item: its price and GST slab are the item's, and GST is charged when it is sold."
      onSubmit={() => businessWrite(biz.id, "laundry/plans", { ...form, taxRateId: slab || undefined, hsnCode: form.hsnCode.trim() || undefined,
        carryMax: form.carryForward === "up_to" ? form.carryMax : undefined })}>
      <Field label="Plan" wide><input required maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Wash & fold 30 kg a month" /></Field>
      <Field label="Holds"><select value={form.unit} onChange={set("unit")}><option value="kg">Kilos (bundles by the kilo)</option><option value="piece">Pieces (garments by the piece)</option></select></Field>
      <Field label={form.unit === "kg" ? "Kilos" : "Pieces"}><input type="number" required min={form.unit === "kg" ? "0.001" : "1"} step={form.unit === "kg" ? "0.001" : "1"} value={form.quantity} onChange={set("quantity")} /></Field>
      <Field label="Days it runs"><input type="number" required min="1" max="3650" value={form.validityDays} onChange={set("validityDays")} /></Field>
      <Field label={`Price (${biz.symbol}, before GST as the shop prices)`}><input type="number" required min="0.01" step="0.01" value={form.price} onChange={set("price")} /></Field>
      <Field label="GST"><select required value={slab} onChange={set("taxRateId")}>{slabs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
      <Field label="SAC (optional)"><input inputMode="numeric" maxLength={8} className="mono" value={form.hsnCode} onChange={set("hsnCode")} placeholder="999712" /></Field>
      <fieldset className="field-wide ldy-picks">
        <legend>Covers</legend>
        {services.map((s) => <label key={s.id} className="checkbox"><input type="checkbox" checked={form.serviceIds.includes(s.id)} onChange={() => toggle(s.id)} /> {s.name}</label>)}
      </fieldset>
      <Field label="What is left when the next is bought"><select value={form.carryForward} onChange={set("carryForward")}>{Object.entries(RULE_WORDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      {form.carryForward === "up_to" && <Field label={`Carried at most (${UNIT_WORDS[form.unit]})`}><input type="number" required min="0.001" step="0.001" value={form.carryMax} onChange={set("carryMax")} /></Field>}
      {form.carryForward !== "none" && <Field label="Bought within (days after the end)"><input type="number" min="0" max="365" value={form.carryDays} onChange={set("carryDays")} /></Field>}
    </FormDialog>
  );
}

function SellDialog({ plans, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [customer, setCustomer] = useState(null);
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState({ planId: String(plans[0]?.id || ""), locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""), amount: "", method: "cash", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const plan = plans.find((p) => String(p.id) === form.planId);
  return (
    <FormDialog title="Sell a package" icon="gift" width={600} onClose={onClose} onSaved={onSaved} submitLabel="Sell and post the bill"
      description={plan ? `${plan.name}: ${Number(plan.quantity)} ${UNIT_WORDS[plan.unit]} for ${plan.validity_days} days, ${biz.exact(plan.price)} + GST ${Number(plan.tax_rate)}%. What is left of the customer's last one is carried in as its plan says.` : undefined}
      onSubmit={() => {
        if (!customer) throw new Error("Choose the customer");
        return businessWrite(biz.id, "laundry/packages", { requestKey, planId: form.planId, contactId: customer.id, locationId: form.locationId,
          ...(biz.can("sales.edit") && form.amount ? { payment: { amount: form.amount, ...methods.body(form.method, ["cash", "upi", "card", "bank"]), reference: form.reference.trim() || undefined } } : {}) });
      }}>
      <div className="field field-wide">
        <SearchPicker label="Customer" placeholder="Name or phone" value={customer} onChange={setCustomer} minChars={2}
          search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
          getLabel={(c) => c.name} getDescription={(c) => c.phone || ""} />
      </div>
      <Field label="Plan"><select value={form.planId} onChange={set("planId")}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      {locations.length > 1 && <Field label="Sold at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      {biz.can("sales.edit") && (
        <>
          <Field label="Paid now (optional)" hint="Full: type full, or the amount."><input value={form.amount} onChange={set("amount")} placeholder="full" /></Field>
          <Field label="Paid by"><select value={methods.resolve(form.method, ["cash", "upi", "card", "bank"])} onChange={set("method")}>{methods.options(["cash", "upi", "card", "bank"]).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
          <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
    </FormDialog>
  );
}

function CancelPackageDialog({ pack, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Cancel ${pack.name}`} icon="ban" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Cancel it"
      description={`${pack.customer_name}'s package, unused. Its bill line (${pack.document_no}) can then be credited from the bill.`}
      onSubmit={() => businessWrite(biz.id, `laundry/packages/${pack.id}/cancel`, { reason })}>
      <Field label="Reason" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bought by mistake" /></Field>
    </FormDialog>
  );
}
