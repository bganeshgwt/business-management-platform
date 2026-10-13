import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import { businessRead } from "../../../../services/business.service";
import { count } from "../../../../services/format";
import { useOpenBusiness } from "../../core/pages/hooks";

// The distributor's day on the Overview (pro pass D-08): orders to send,
// back-orders, vans on the road, collected today by salesperson, overdue,
// cheques to deposit, and today's beats. Each figure opens its screen.
export default function WholesaleToday() {
  const biz = useOpenBusiness();
  const [s, setS] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "wholesale-summary", undefined, controller.signal).then(setS).catch(() => {});
    return () => controller.abort();
  }, [biz.id]);
  const loading = !s;
  const collected = (s?.collected_today || []).reduce((sum, r) => sum + Number(r.amount), 0);
  const money = biz.can("receivables.view");
  const tiles = [
    <StatTile key="orders" icon="clipboard" tone="info" label="Orders to dispatch" value={s ? count(s.orders_to_dispatch.count) : undefined} loading={loading}
      note={s ? `${biz.amount(s.orders_to_dispatch.value)} to send${s.orders_to_dispatch.due_today ? ` · ${s.orders_to_dispatch.due_today} due` : ""}` : undefined} to={biz.path("dispatch")} />,
    <StatTile key="back" icon="layers" tone={Number(s?.back_orders.value) > 0 ? "warning" : "neutral"} label="Back-orders" money={s ? Number(s.back_orders.value) : undefined} loading={loading}
      note={s ? `${count(s.back_orders.lines)} lines part sent` : undefined} to={biz.path("back-orders")} />,
    money && <StatTile key="collected" icon="wallet" tone="success" label="Collected today" money={s ? collected : undefined} loading={loading}
      note={s ? (s.collected_today.map((r) => `${r.name.split(" ")[0]} ${biz.amount(r.amount)}`).join(" · ") || "nothing yet") : undefined} to={biz.path("collections")} />,
    money && <StatTile key="overdue" icon="alert" tone={Number(s?.overdue?.amount) > 0 ? "danger" : "neutral"} label="Overdue" money={s ? Number(s.overdue.amount) : undefined} loading={loading}
      note={s ? `${count(s.overdue.customers)} customers${Number(s.overdue.over_90) > 0 ? ` · ${biz.amount(s.overdue.over_90)} ${biz.ages.over.toLowerCase()}` : ""}` : undefined} to={biz.path("outstanding")} />,
  ].filter(Boolean);
  const todo = s ? [
    money && s.cheques.to_deposit > 0 && { icon: "wallet", tone: "warning", text: `${s.cheques.to_deposit} ${s.cheques.to_deposit === 1 ? "cheque" : "cheques"} to deposit · ${biz.amount(s.cheques.to_deposit_value)}`, to: "collections?tab=cheques" },
    money && s.cheques.bounced_30_days > 0 && { icon: "alert", tone: "danger", text: `${s.cheques.bounced_30_days} ${s.cheques.bounced_30_days === 1 ? "cheque" : "cheques"} bounced in 30 days`, to: "collections?tab=cheques" },
    money && s.cheques.post_dated > 0 && { icon: "clock", tone: "info", text: `${s.cheques.post_dated} post-dated ${s.cheques.post_dated === 1 ? "cheque" : "cheques"} in hand · ${biz.amount(s.cheques.post_dated_value)}`, to: "collections?tab=cheques" },
    s.out_for_delivery.count > 0 && { icon: "truck", tone: "info", text: `${s.out_for_delivery.count} ${s.out_for_delivery.count === 1 ? "invoice" : "invoices"} on the way · mark delivered when the van is back`, to: "dispatch" },
    money && (s.unsettled_today || []).length > 0 && { icon: "users", tone: "warning", text: `Settle today's cash: ${s.unsettled_today.map((p) => p.name).join(", ")}`, to: "collections?tab=settle" },
  ].filter(Boolean) : [];
  return (
    <>
      <div className="stat-grid bz-stat-grid">{tiles}</div>
      <div className="bz-two">
        <SectionCard icon="map-pin" title="Today's beats" description={s ? (s.beats_today.length ? "Shops the salespeople visit today." : "No beats are set for today.") : "Checking…"}
          actions={biz.can("sales_orders.view") && <Link className="button button-secondary button-sm" to={biz.path("routes")}>Routes</Link>}>
          {s && s.beats_today.length > 0 && (
            <ul className="bz-beats-list">
              {s.beats_today.map((b) => (
                <li key={b.id}><span><strong>{b.name}</strong> <span className="muted">· {b.route_name}{b.salesperson_name ? ` · ${b.salesperson_name}` : ""}</span></span>
                  <span className="muted">{b.shops} shops · {b.orders_today} orders today</span></li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard icon="check" title="Money and deliveries" description={s ? (todo.length ? "Tap a line to open it." : "Nothing waiting.") : "Checking…"}>
          {todo.length > 0 && (
            <ul className="bz-todo">
              {todo.map((t) => (
                <li key={t.text}>
                  <Link to={biz.path(t.to)} className={`bz-todo-line tone-${t.tone}`}><Icon name={t.icon} size={16} /><span>{t.text}</span><Icon name="chevron-right" size={14} className="bz-action-go" /></Link>
                </li>
              ))}
            </ul>
          )}
          {s?.hold_overdue_days && <p className="muted small">New orders are held when a bill is more than {s.hold_overdue_days} days overdue.</p>}
        </SectionCard>
      </div>
    </>
  );
}
