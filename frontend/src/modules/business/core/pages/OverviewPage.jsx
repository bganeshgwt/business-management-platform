import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { count } from "../../../../services/format";
import { GOODS, word } from "../../../../services/businessNav";
// Tasks (modules/tasks): today's checklists, overdue, issues waiting.
const TasksTodayCard = lazy(() => import("../../../tasks/pages/TasksTodayCard"));
import { BusinessHeader } from "./ui";
import { useOpenBusiness } from "./hooks";

// The wholesale day (pro pass D-08): orders, back-orders, collections, cheques, beats.
const WholesaleToday = lazy(() => import("../../wholesale/pages/WholesaleToday"));
// A meat or weight shop's day (pro pass F-22): kg sold, cut, wasted, use-by, rates, pickups.
const WeightToday = lazy(() => import("../../weight/pages/WeightToday"));
const WEIGHED_TYPES = ["meat", "weight_retail"];

// The owner's first screen (pro pass C-03, D-08, E-24, G-14): today at the
// counter in four figures, what needs doing today for this type of business
// (each line opens its screen), and the right first actions — Quick bill for
// a shop, the salon bill for a salon, a sales order for a wholesaler.

const METHOD_WORDS = { cash: "cash", upi: "UPI", card: "card", bank: "bank", cheque: "cheque" };
// The singular of each type's customer word ("Add a customer").
const CUSTOMER_ONE = { salon: "client", healthcare: "patient" };

function firstActions(biz) {
  const can = (p) => biz.can(p);
  const goods = GOODS.includes(biz.type);
  const list = [];
  if (goods && can("sales.create")) list.push({ to: "counter", icon: "receipt", label: "Quick bill" });
  // Pro pass F: a weight shop's morning (rates, cutting) and evening (wastage), and phone orders.
  if (WEIGHED_TYPES.includes(biz.type) && biz.has("weight")) {
    if (can("catalog.edit")) list.push({ to: "rates", icon: "tag", label: "Today's rates" });
    if (biz.has("processing") && can("processing.create")) list.push({ to: "processing?cut=1", icon: "scale", label: biz.type === "weight_retail" ? "Sort / repack" : "Cut / clean" });
    if (can("sales.create")) list.push({ to: "pickup-orders", icon: "clipboard", label: "Orders for pickup" });
    if (biz.has("wastage") && can("wastage.create")) list.push({ to: "wastage", icon: "trash", label: "Record wastage" });
  }
  if (biz.type === "salon" && can("sales.create")) list.push({ to: "salon-bill", icon: "receipt", label: "New bill" });
  if (biz.type === "salon" && can("appointments.view")) list.push({ to: "salon-calendar", icon: "calendar", label: "Today's calendar" });
  if (biz.type === "salon" && can("appointments.create")) list.push({ to: "salon-calendar?walkin=1", icon: "user-plus", label: "Walk-in" });
  if (biz.has("sales_orders") && can("sales_orders.create")) list.push({ to: "sales-orders?new=1", icon: "clipboard", label: "Take a sales order" });
  if (biz.has("sales_orders") && can("sales_orders.view")) list.push({ to: "dispatch", icon: "truck", label: "Dispatch orders" });
  if (biz.has("repairs") && can("repairs.create")) list.push({ to: "repairs?new=1", icon: "settings", label: "Take in a device" });
  if (biz.has("warranties") && can("warranties.view")) list.push({ to: "warranties", icon: "search", label: "Look up an IMEI" });
  if (biz.has("exchanges") && can("exchanges.create")) list.push({ to: "exchanges?new=1", icon: "undo", label: "Exchange an item" });
  if (biz.has("receivables") && can("receivables.create")) list.push({ to: goods ? "udhaar" : "collections?new=1", icon: "wallet", label: goods ? "Collect udhaar" : "Record a collection" });
  if (!goods && biz.type !== "salon" && can("sales.create")) list.push({ to: "sales?new=1", icon: "receipt", label: "New sale (invoice)" });
  if (biz.type !== "salon" && biz.type !== "healthcare" && can("appointments.create") && biz.has("appointments")) list.push({ to: "appointments?new=1", icon: "calendar", label: "Book an appointment" });
  if (biz.type === "healthcare" && can("appointments.create")) list.push({ to: "appointments?new=1", icon: "calendar", label: "Book an appointment" });
  if (can("purchasing.create")) list.push({ to: "purchases?new=1", icon: "truck", label: "Receive a purchase" });
  if (goods && can("sales.view")) list.push({ to: "day-close", icon: "clock", label: "Close the day" });
  if (can("catalog.create")) list.push({ to: "products?new=1", icon: "plus", label: `Add to ${word(biz.type, "products", "products & services").toLowerCase()}` });
  if (can("contacts.create")) list.push({ to: "customers?new=1", icon: "user", label: `Add a ${CUSTOMER_ONE[biz.type] || "customer"}` });
  return list.slice(0, 8);
}

export default function OverviewPage() {
  const biz = useOpenBusiness();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "summary", undefined, controller.signal)
      .then(setSummary)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);

  const s = summary || {};
  const loading = !summary && !error;
  const has = (key) => loading || key in s;
  const goods = GOODS.includes(biz.type);
  const taken = s.taken_today || {};
  const takenTotal = Object.entries(taken).filter(([k]) => k !== "collections").reduce((sum, [, v]) => sum + Number(v), 0) + Number(taken.collections || 0);
  const takenNote = Object.entries(taken).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k === "collections" ? "udhaar" : METHOD_WORDS[k] || k} ${biz.amount(v)}`).join(" · ");
  const receivablesPath = biz.can("receivables.view") ? (goods ? "udhaar" : "outstanding") : "customers";

  // At most four headline figures, all whole rupees.
  const tiles = [
    has("sales_today") && <StatTile key="today" icon="receipt" tone="primary" label="Sales today" money={summary ? Number(s.sales_today) : undefined} loading={loading}
      note={summary && s.bills_today !== undefined ? `${count(s.bills_today)} bills · this month ${biz.amount(s.sales_month)}` : "after returns"} to={biz.path(goods ? "day-close" : "sales")} />,
    has("taken_today") && <StatTile key="taken" icon="wallet" tone="success" label="Money in today" money={summary ? takenTotal : undefined} loading={loading}
      note={takenNote || "nothing taken yet"} to={biz.path(goods ? "day-close" : "reports")} />,
    has("receivables") && <StatTile key="due" icon="clipboard" tone={Number(s.receivables) > 0 ? "warning" : "neutral"} label={`${word(biz.type, "customers", "Customers")} owe`} money={summary ? Number(s.receivables_owed ?? s.receivables) : undefined} loading={loading}
      note={summary ? [Number(s.credit_given_today) > 0 && `${biz.amount(s.credit_given_today)} given today`, Number(s.receivables_advances) > 0 && `${biz.amount(s.receivables_advances)} advances`].filter(Boolean).join(" · ") || "net of advances" : undefined}
      to={biz.path(receivablesPath)} />,
    has("payables") && <StatTile key="pay" icon="truck" tone={Number(s.payables_overdue) > 0 ? "danger" : "neutral"} label="To pay suppliers" money={summary ? Number(s.payables) : undefined} loading={loading}
      note={summary && Number(s.payables_overdue) > 0 ? `${biz.amount(s.payables_overdue)} overdue` : "none overdue"} to={biz.path("suppliers")} />,
    biz.type === "salon" && has("appointments_today") && <StatTile key="appt" icon="calendar" tone="info" label="Appointments today" value={summary ? count(s.appointments_today) : undefined} loading={loading}
      note={summary && s.appointments_left_today !== undefined ? `${count(s.appointments_left_today)} still to come today` : undefined} to={biz.path("salon-calendar")} />,
  ].filter(Boolean).slice(0, 4);

  // What needs doing today, by type: only lines with something to do.
  const todo = [
    { key: "promises_broken", icon: "alert", tone: "danger", text: (n) => `${n} udhaar ${n === 1 ? "promise" : "promises"} broken`, to: "udhaar" },
    { key: "promises_due_today", icon: "clock", tone: "warning", text: (n) => `${n} ${n === 1 ? "customer" : "customers"} promised to pay today`, to: "udhaar" },
    { key: "orders_to_dispatch", icon: "truck", tone: "info", text: (n) => `${n} sales ${n === 1 ? "order" : "orders"} to dispatch`, to: "sales-orders" },
    { key: "repairs_ready", icon: "check", tone: "success", text: (n) => `${n} ${n === 1 ? "repair" : "repairs"} ready to hand over`, to: "repairs" },
    { key: "repairs_overdue", icon: "alert", tone: "danger", text: (n) => `${n} ${n === 1 ? "repair is" : "repairs are"} past the promised date`, to: "repairs" },
    { key: "warranties_missing", icon: "shield", tone: "warning", text: (n) => `${n} sold ${n === 1 ? "unit has" : "units have"} no warranty registered`, to: "warranties" },
    { key: "exchanges_today", icon: "undo", tone: "info", text: (n) => `${n} ${n === 1 ? "exchange" : "exchanges"} today`, to: "exchanges" },
    { key: "broken_sizes", icon: "tag", tone: "warning", text: (n) => `${n} ${n === 1 ? "style has" : "styles have"} sizes sold out`, to: "variants" },
    { key: "low_stock", icon: "alert", tone: "warning", text: (n) => `${n} ${n === 1 ? "item is" : "items are"} low on stock`, to: "stock" },
    { key: "expiring_soon", icon: "clock", tone: "warning", text: (n) => `${n} ${n === 1 ? "batch expires" : "batches expire"} in ${biz.settings.near_expiry_days || 30} days`, to: "near-expiry", when: biz.has("batches") && !WEIGHED_TYPES.includes(biz.type) },
    { key: "transfers_in_transit", icon: "layers", tone: "info", text: (n) => `${n} stock ${n === 1 ? "transfer" : "transfers"} on the way`, to: "transfers" },
    { key: "counts_open", icon: "clipboard", tone: "info", text: (n) => `${n} stock ${n === 1 ? "count" : "counts"} open`, to: "counts" },
    { key: "appointments_left_today", icon: "calendar", tone: "info", text: (n) => `${n} ${n === 1 ? "appointment" : "appointments"} still to come today`, to: biz.type === "salon" ? "salon-calendar" : "appointments" },
  ].filter((t) => t.when !== false && summary && Number(s[t.key]) > 0);
  const walkIn = summary && Number(s.receivables_walk_in) > 0;
  const actions = firstActions(biz);
  const enabled = biz.context.moduleCatalogue.filter((m) => m.kind === "optional" && biz.has(m.code));

  return (
    <div className="stack">
      <BusinessHeader icon="grid" title="Overview" description={`${biz.business.type_name}. Your role here: ${biz.context.role.name}.`} />
      <ErrorMessage message={error} />
      {tiles.length > 0 && <div className="stat-grid bz-stat-grid">{tiles}</div>}
      {biz.has("sales_orders") && biz.can("sales_orders.view") && <Suspense fallback={null}><WholesaleToday /></Suspense>}
      {WEIGHED_TYPES.includes(biz.type) && biz.has("weight") && biz.can("inventory.view") && <Suspense fallback={null}><WeightToday /></Suspense>}
      {biz.has("tasks") && <Suspense fallback={null}><TasksTodayCard businessId={biz.id} /></Suspense>}
      <div className="bz-two">
        {actions.length > 0 && (
          <SectionCard icon="zap" title="Start here" description="The things done most often in this business.">
            <div className="bz-actions-grid">
              {actions.map((a) => (
                <Link key={a.label} className="bz-action" to={biz.path(a.to)}>
                  <span className="bz-action-icon" aria-hidden="true"><Icon name={a.icon} size={18} /></span>
                  <span>{a.label}</span>
                  <Icon name="chevron-right" size={16} className="bz-action-go" />
                </Link>
              ))}
            </div>
          </SectionCard>
        )}
        <SectionCard icon="check" title="Needs doing today" description={summary ? (todo.length || walkIn ? "Tap a line to open it." : "Nothing waiting. A good day so far.") : "Checking…"}>
          {(todo.length > 0 || walkIn) && (
            <ul className="bz-todo">
              {todo.map((t) => (
                <li key={t.key}>
                  <Link to={biz.path(t.to)} className={`bz-todo-line tone-${t.tone}`}>
                    <Icon name={t.icon} size={16} /><span>{t.text(Number(s[t.key]))}</span><Icon name="chevron-right" size={14} className="bz-action-go" />
                  </Link>
                </li>
              ))}
              {walkIn && (
                <li>
                  <Link to={biz.path("sales")} className="bz-todo-line tone-warning">
                    <Icon name="receipt" size={16} /><span>{biz.amount(s.receivables_walk_in)} unpaid on walk-in bills</span><Icon name="chevron-right" size={14} className="bz-action-go" />
                  </Link>
                </li>
              )}
            </ul>
          )}
        </SectionCard>
      </div>
      <SectionCard icon="layers" title="What this business uses"
        description={biz.can("settings.edit") ? "Switch modules on or off under Business settings." : "Set by the owner."}
        actions={biz.can("settings.view") && <Link className="button button-secondary button-sm" to={biz.path("settings")}>Settings</Link>}>
        <div className="bz-chips">
          {enabled.map((m) => <span key={m.code} className="bz-chip" title={m.description}>{m.name}</span>)}
        </div>
      </SectionCard>
    </div>
  );
}
