import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { count } from "@bmp/shared/format";
import { GOODS, word } from "../../../../services/businessNav";
import { WEIGHED as WEIGHED_TYPES } from "../../../../services/businessTypes";
import { BusinessHeader } from "./ui";
import { useOpenBusiness } from "./hooks";
import useAuth from "../../../../hooks/useAuth";
import { PeopleToday, SalesPicture } from "./OverviewToday";
import { overviewLink } from "./overviewLink";

// The wholesale day: orders, back-orders, collections, cheques, beats.
const WholesaleToday = lazy(() => import("../../wholesale/pages/WholesaleToday"));
// A meat or weight shop's day: kg sold, cut, wasted, use-by, rates, pickups.
const WeightToday = lazy(() => import("../../weight/pages/WeightToday"));

// The owner's first screen: today at the counter in four figures, what needs
// doing today for this type of business (each line opens its screen), and the
// right first actions — Quick bill for a shop, the salon bill for a salon, a
// sales order for a wholesaler.

const METHOD_WORDS = { cash: "cash", upi: "UPI", card: "card", bank: "bank", cheque: "cheque" };
// "▲ 23% vs last Fri by this time": today so far against the same weekday a
// week ago at the same hour (null when there is nothing to compare).
function paceWords(sales) {
  if (!sales) return null;
  const now = Number(sales.today), then = Number(sales.last_week_by_now);
  if (!(then > 0)) return now > 0 ? { up: true, text: `last ${sales.weekday} had nothing by now` } : null;
  const change = Math.round(((now - then) / then) * 100);
  // A very quiet last week makes a percent meaningless: "8× last Fri by now".
  if (change >= 300) return { up: true, text: `${Math.round(now / then)}× last ${sales.weekday} by now` };
  return { up: change >= 0, text: `${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}% vs last ${sales.weekday} by now` };
}
const greet = (date) => (date.getHours() < 12 ? "Good morning" : date.getHours() < 17 ? "Good afternoon" : "Good evening");
// Who a business with appointments books: stylists, doctors, technicians.
const PEOPLE = { salon: "Stylists", healthcare: "Doctors", electronics: "Technicians", optical: "Optometrists", garage: "Mechanics", memberships: "Trainers" };

// The singular of each type's customer word ("Add a customer").
const CUSTOMER_ONE = { salon: "client", healthcare: "patient", memberships: "member", lodging: "guest" };

function firstActions(biz) {
  const can = (p) => biz.can(p);
  const goods = GOODS.includes(biz.type);
  const list = [];
  if (goods && can("sales.create")) list.push({ to: "counter", icon: "receipt", label: "Quick bill" });
  // A weight shop's morning (rates, cutting) and evening (wastage), and phone orders.
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
  if (biz.has("quotations") && can("quotations.create")) list.push({ to: "quotations?new=1", icon: "clipboard", label: "Make a quotation" });
  // A farm-input shop's day: the PoS device's stock against the shop's, and its farmers.
  if (biz.has("agri") && can("agri.create")) list.push({ to: "agri-subsidy?check=1", icon: "scale", label: "Type the PoS stock" });
  if (biz.has("agri") && can("agri.edit")) list.push({ to: "farmers?new=1", icon: "user-plus", label: "Add a farmer" });
  // An optical shop's day: spectacle orders to book, and the prescriptions from its eye tests.
  if (biz.type === "optical" && biz.has("optical") && can("optical.create") && can("sales.create")) list.push({ to: "spectacle-orders?new=1", icon: "clipboard", label: "Book a spectacle order" });
  if (biz.type === "optical" && biz.has("optical") && can("optical.create")) list.push({ to: "prescriptions?new=1", icon: "eye", label: "Record a prescription" });
  // A garage's day: job cards to open for the vehicles coming in, and their vehicles.
  if (biz.type === "garage" && biz.has("garage") && can("garage.create")) list.push({ to: "job-cards?new=1", icon: "clipboard", label: "Open a job card" });
  if (biz.type === "garage" && biz.has("garage") && can("garage.create")) list.push({ to: "vehicles?new=1", icon: "truck", label: "Add a vehicle" });
  // A gym's, studio's or coaching centre's day: members checking in at the desk, and memberships to sell.
  if (biz.type === "memberships" && biz.has("member_plans") && can("member_plans.create")) list.push({ to: "check-in", icon: "check", label: "Check a member in" });
  if (biz.type === "memberships" && biz.has("member_plans") && can("member_plans.create") && can("sales.create")) list.push({ to: "members?new=1", icon: "user-plus", label: "Sell a membership" });
  // A laundry's day: garment orders to take in at the counter, and the ready garments on the racks.
  if (biz.type === "laundry" && biz.has("laundry") && can("laundry.create")) list.push({ to: "laundry-new", icon: "clipboard", label: "Take in an order" });
  if (biz.type === "laundry" && biz.has("laundry") && can("laundry.view")) list.push({ to: "ready-racks", icon: "tag", label: "Find a garment" });
  // A jeweller's day starts with the day's rates; then pieces are billed at them.
  if (biz.type === "jewellery" && biz.has("jewellery") && can("jewellery.approve")) list.push({ to: "gold-rates", icon: "tag", label: "Set today's rates" });
  if (biz.type === "jewellery" && biz.has("jewellery") && can("jewellery.create") && can("sales.create")) list.push({ to: "jewellery-bill", icon: "receipt", label: "Make a jewellery bill" });
  // A rental business's day: bookings to make, and what goes out and comes back, on the board.
  if (biz.type === "rentals" && biz.has("rentals") && can("rentals.create")) list.push({ to: "rental-bookings?new=1", icon: "calendar", label: "Make a booking" });
  if (biz.type === "rentals" && biz.has("rentals") && can("rentals.view")) list.push({ to: "rental-bookings", icon: "clock", label: "What is due back" });
  // A fuel station's day: the morning dips, shifts opened on the nozzles and closed with their takings, the tanker loads, the day's prices.
  if (biz.type === "fuel_station" && biz.has("fuel") && can("fuel.create")) list.push({ to: "fuel-shifts?open=1", icon: "clock", label: "Open a shift" });
  if (biz.type === "fuel_station" && biz.has("fuel") && can("fuel.create")) list.push({ to: "fuel-dips", icon: "layers", label: "Take the morning dips" });
  if (biz.type === "fuel_station" && biz.has("fuel") && can("fuel.create") && can("contacts.view")) list.push({ to: "fuel-receipts", icon: "truck", label: "Record a tanker load" });
  if (biz.type === "fuel_station" && biz.has("fuel") && can("catalog.edit") && can("settings.view")) list.push({ to: "fuel-pumps", icon: "tag", label: "Set today's prices" });
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
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [picture, setPicture] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "summary", undefined, controller.signal)
      .then(setSummary)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    // The picture of the day loads beside it; the page works without it.
    businessRead(biz.id, "overview", undefined, controller.signal).then(setPicture).catch(() => {});
    return () => controller.abort();
  }, [biz.id]);
  const pace = paceWords(picture?.sales);

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
      note={summary && s.bills_today !== undefined ? <>{count(s.bills_today)} bills{pace ? <> · <span className={pace.up ? "text-success" : "text-danger"}>{pace.text}</span></> : ` · this month ${biz.amount(s.sales_month)}`}</> : "after returns"} to={overviewLink(goods ? "day-close" : "sales")} />,
    has("taken_today") && <StatTile key="taken" icon="wallet" tone="success" label="Money in today" money={summary ? takenTotal : undefined} loading={loading}
      note={takenNote || "nothing taken yet"} to={overviewLink(goods ? "day-close" : "reports")} />,
    has("receivables") && <StatTile key="due" icon="clipboard" tone={Number(s.receivables) > 0 ? "warning" : "neutral"} label={`${word(biz.type, "customers", "Customers")} owe`} money={summary ? Number(s.receivables_owed ?? s.receivables) : undefined} loading={loading}
      note={summary ? [Number(s.credit_given_today) > 0 && `${biz.amount(s.credit_given_today)} given today`, Number(s.receivables_advances) > 0 && `${biz.amount(s.receivables_advances)} advances`].filter(Boolean).join(" · ") || "net of advances" : undefined}
      to={overviewLink(receivablesPath)} />,
    has("payables") && <StatTile key="pay" icon="truck" tone={Number(s.payables_overdue) > 0 ? "danger" : "neutral"} label="To pay suppliers" money={summary ? Number(s.payables) : undefined} loading={loading}
      note={summary && Number(s.payables_overdue) > 0 ? `${biz.amount(s.payables_overdue)} overdue` : "none overdue"} to={overviewLink("suppliers")} />,
    biz.type === "salon" && has("appointments_today") && <StatTile key="appt" icon="calendar" tone="info" label="Appointments today" value={summary ? count(s.appointments_today) : undefined} loading={loading}
      note={summary && s.appointments_left_today !== undefined ? `${count(s.appointments_left_today)} still to come today` : undefined} to={overviewLink("salon-calendar")} />,
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
  const enabled = biz.context.moduleCatalogue.filter((m) => m.kind === "optional" && !['tasks','issues','projects'].includes(m.code) && biz.has(m.code));

  return (
    <div className="stack">
      <BusinessHeader icon="grid" title={`${greet(new Date())}, ${(user?.name || "").split(" ")[0] || "there"}`}
        // The two things done most often (Quick bill / New bill first), at the top: no scrolling to start a bill.
        actions={actions.length > 0 && (
          <span className="bz-actions">
            {actions[1] && <Link className="button button-secondary" to={overviewLink(actions[1].to)}><Icon name={actions[1].icon} size={16} /> {actions[1].label}</Link>}
            <Link className="button" to={overviewLink(actions[0].to)}><Icon name={actions[0].icon} size={16} /> {actions[0].label}</Link>
          </span>
        )}
        description={`${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} · ${biz.locations.length === 1 ? biz.locations[0].name : biz.context.currentLocationId ? biz.locations.find((l) => String(l.id) === String(biz.context.currentLocationId))?.name : "All branches"} · ${biz.context.role.name}`} />
      <ErrorMessage message={error} />
      {tiles.length > 0 && <div className="stat-grid bz-stat-grid">{tiles}</div>}
      {/* What needs doing and the usual actions come first, before the charts. */}
      <div className="bz-two">
        <SectionCard icon="check" title="Needs doing today" description={summary ? (todo.length || walkIn ? "Tap a line to open it." : "Nothing waiting. A good day so far.") : "Checking…"}>
          {(todo.length > 0 || walkIn) && (
            <ul className="bz-todo">
              {todo.map((t) => (
                <li key={t.key}>
                  <Link to={overviewLink(t.to)} className={`bz-todo-line tone-${t.tone}`}>
                    <Icon name={t.icon} size={16} /><span>{t.text(Number(s[t.key]))}</span><Icon name="chevron-right" size={14} className="bz-action-go" />
                  </Link>
                </li>
              ))}
              {walkIn && (
                <li>
                  <Link to={overviewLink("sales")} className="bz-todo-line tone-warning">
                    <Icon name="receipt" size={16} /><span>{biz.amount(s.receivables_walk_in)} unpaid on walk-in bills</span><Icon name="chevron-right" size={14} className="bz-action-go" />
                  </Link>
                </li>
              )}
            </ul>
          )}
        </SectionCard>
        {actions.length > 0 && (
          <SectionCard icon="zap" title="Start here" description="The things done most often in this business.">
            <div className="bz-actions-grid">
              {actions.map((a) => (
                <Link key={a.label} className="bz-action" to={overviewLink(a.to)}>
                  <span className="bz-action-icon" aria-hidden="true"><Icon name={a.icon} size={18} /></span>
                  <span>{a.label}</span>
                  <Icon name="chevron-right" size={16} className="bz-action-go" />
                </Link>
              ))}
            </div>
          </SectionCard>
        )}
      </div>
      {picture?.appointments && ["salon", "healthcare"].includes(biz.type) && (
        <PeopleToday biz={biz} appointments={picture.appointments} personWord={PEOPLE[biz.type] || "Team"}
          calendarPath={overviewLink(biz.type === "salon" ? "salon-calendar" : "appointments")} />
      )}
      {picture?.sales && <SalesPicture biz={biz} sales={picture.sales} salesPath={biz.can("reports.view") ? overviewLink("reports") : null} />}
      {biz.has("sales_orders") && biz.can("sales_orders.view") && <Suspense fallback={null}><WholesaleToday /></Suspense>}
      {WEIGHED_TYPES.includes(biz.type) && biz.has("weight") && biz.can("inventory.view") && <Suspense fallback={null}><WeightToday /></Suspense>}
      <SectionCard icon="layers" title="What this business uses"
        description={biz.can("settings.edit") ? "Manage business tools under Settings." : "Set by the owner."}
        actions={biz.can("settings.view") && <Link className="button button-secondary button-sm" to={overviewLink("settings")}>Settings</Link>}>
        <div className="bz-chips">
          {enabled.map((m) => <span key={m.code} className="bz-chip" title={m.description}>{m.name}</span>)}
        </div>
      </SectionCard>
    </div>
  );
}
