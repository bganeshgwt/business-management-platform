import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { businessRead } from "../../../../services/business.service";
import { timeOnly } from "../../../../services/format";
import { useOpenBusiness } from "../../core/pages/hooks";
import { kg, percentText, processWords } from "./weight";

// A meat or weight shop's day on the Overview (pro pass F-22): kg sold,
// cut and wasted today, the yield against the templates, what must be used
// by tomorrow, whether today's rates are set, and the next pickups.
export default function WeightToday() {
  const biz = useOpenBusiness();
  const words = processWords(biz.type);
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "weight/today", {}, controller.signal).then(setData).catch(() => setData(null));
    return () => controller.abort();
  }, [biz.id]);
  if (!data) return null;
  const { sold, cut, wasted, useSoon, rates, pickups } = data;
  const useSoonKg = Number(useSoon.today_kg) + Number(useSoon.tomorrow_kg);
  return (
    <SectionCard icon="scale" title="Today at the counter" description="Weights for today, from the bills, cutting and wastage."
      actions={biz.can("catalog.edit") && (
        <Link className={`button button-sm ${rates.changed_today ? "button-secondary" : ""}`} to={biz.path("rates")}>
          <Icon name="tag" size={14} /> {rates.changed_today ? `Rates: ${rates.changed_today} changed today` : "Set today's rates"}
        </Link>
      )}>
      <div className="sw-tiles">
        <StatTile icon="receipt" tone="primary" label="Sold today" value={kg(sold.kg)} note={`${sold.bills} bill${sold.bills === 1 ? "" : "s"}`} to={biz.path("day-close")} />
        {cut && <StatTile icon="scale" tone="success" label={biz.type === "weight_retail" ? "Sorted today" : "Cut today"} value={kg(cut.input_kg)} to={biz.path("processing")}
          note={cut.batches ? `${kg(cut.output_kg)} out · ${percentText(cut.yield_percent)} yield${cut.expected_percent ? ` of ${percentText(cut.expected_percent)}` : ""}` : `nothing ${words.action.toLowerCase().split(" ")[0]} yet`} />}
        {wasted && <StatTile icon="trash" tone="warning" label="Wasted today" value={kg(wasted.kg)} note={`${biz.amount(wasted.value)} at cost`} to={biz.path("wastage")} />}
        <StatTile icon="clock" tone={useSoonKg > 0 ? "danger" : "neutral"} label="Use by tomorrow" value={kg(useSoonKg)}
          note={Number(useSoon.today_kg) > 0 ? `${kg(useSoon.today_kg)} must go today` : "nothing close to its date"} to={biz.path("weight-stock")} />
      </div>
      {pickups && pickups.total > 0 && (
        <ul className="bz-todo" style={{ marginTop: "0.75rem" }}>
          {pickups.items.slice(0, 3).map((o) => (
            <li key={o.id}>
              <Link to={biz.path("pickup-orders")} className={`bz-todo-line tone-${o.late ? "warning" : "info"}`}>
                <Icon name="clipboard" size={16} /><span>{timeOnly(o.pickup_at)} · {o.customer_name} · {o.lines.map((l) => l.label).join(", ")}{o.status === "ready" ? " (ready)" : ""}</span>
                <Icon name="chevron-right" size={14} className="bz-action-go" />
              </Link>
            </li>
          ))}
          {pickups.total > 3 && <li><Link to={biz.path("pickup-orders")} className="bz-todo-line tone-info"><span>{pickups.total - 3} more orders for pickup today</span></Link></li>}
        </ul>
      )}
    </SectionCard>
  );
}
