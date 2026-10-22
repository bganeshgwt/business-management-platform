import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import { BarList, ColumnChart, TrendChart } from "../../../../components/Charts";
import { count } from "@bmp/shared/format";

// The Overview's picture of the day (GET overview): how today compares, the
// last two weeks, today hour by hour and the best sellers; for a business
// with appointments, who comes next and how each person's day is going.

const dayLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const timeText = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hourLabel = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

export function SalesPicture({ biz, sales, salesPath }) {
  const points = sales.days.map((d, i) => ({ label: dayLabel(d.day), value: Number(d.sales), inProgress: i === sales.days.length - 1 }));
  const fortnight = sales.days.reduce((sum, d) => sum + Number(d.sales), 0);
  const best = sales.days.reduce((top, d) => (Number(d.sales) > Number(top.sales) ? d : top), sales.days[0]);
  // A working day's hours: from the first sale (or 9) to the last (or 8 pm).
  const sold = sales.hours.map((h) => h.hour);
  const from = Math.min(9, ...sold), to = Math.max(20, ...sold);
  const byHour = Array.from({ length: to - from + 1 }, (_, i) => {
    const hour = from + i;
    return { label: hourLabel(hour), value: Number(sales.hours.find((h) => h.hour === hour)?.sales || 0) };
  });
  const busiest = sales.hours.reduce((top, h) => (!top || Number(h.sales) > Number(top.sales) ? h : top), null);
  const top = sales.top_today.length ? sales.top_today : sales.top_week;
  return (
    <div className="bz-ov-grid">
      <SectionCard icon="chart" title="Sales, last 14 days" className="bz-ov-trend"
        description={`${biz.amount(fortnight)} in two weeks · best day ${dayLabel(best.day)} (${biz.amount(best.sales)}). Today is still going.`}
        actions={salesPath && <Link className="button button-ghost button-sm" to={salesPath}>Reports <Icon name="arrow-right" size={14} /></Link>}>
        <TrendChart points={points} currency={biz.symbol} label="Sales, last 14 days" />
      </SectionCard>
      <SectionCard icon="clock" title="Today, hour by hour"
        description={sales.bills_today ? `${count(sales.bills_today)} bills · average ${biz.amount(sales.average_bill)}${busiest ? ` · busiest ${hourLabel(busiest.hour)}` : ""}` : "No bills yet today."}>
        <ColumnChart points={byHour} currency={biz.symbol} />
      </SectionCard>
      <SectionCard icon="star" title={sales.top_today.length ? "Best sellers today" : "Best sellers this week"}
        description={sales.top_today.length ? "By value, after discounts." : "Nothing sold yet today; the last seven days instead."}>
        <BarList rows={top.map((t) => ({ label: t.label, value: Number(t.value), sub: t.unit === "service" ? `${Number(t.quantity)} done` : `${Number(t.quantity)} ${t.unit}` }))} currency={biz.symbol} empty="Nothing sold in the last seven days." />
      </SectionCard>
    </div>
  );
}

// Who comes next, and each person's day (stylists, doctors, technicians).
export function PeopleToday({ biz, appointments, calendarPath, personWord }) {
  const { next, people } = appointments;
  const working = people.filter((p) => p.booked > 0 || Number(p.sales || 0) > 0);
  return (
    <div className="bz-two bz-ov-people">
      <SectionCard icon="calendar" title="Up next" description={next.length ? "The next bookings today." : "No more bookings today."}
        actions={calendarPath && <Link className="button button-ghost button-sm" to={calendarPath}>Calendar <Icon name="arrow-right" size={14} /></Link>}>
        {next.length > 0 && (
          <ul className="bz-ov-next">
            {next.map((a) => (
              <li key={a.id} className={a.in_progress ? "is-now" : ""}>
                <span className="bz-ov-time">{a.in_progress ? "Now" : timeText(a.starts_at)}</span>
                <span className="bz-ov-who"><strong>{a.client}</strong><small className="muted">{a.service}</small></span>
                <span className="bz-ov-staff"><Icon name="user" size={13} /> {a.staff}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard icon="users" title={`${personWord} today`}
        description={working.length ? `${working.length} working · bookings done and sales so far${working.some((p) => p.commission !== null) ? ", with commission" : ""}.` : "Nobody has bookings or sales yet today."}>
        {working.length > 0 && (
          <ul className="bz-ov-team">
            {working.map((p) => {
              const state = p.busy ? ["is-busy", "With a client"] : p.next_at ? ["is-next", `Next ${timeText(p.next_at)}`] : ["is-free", p.done ? "Done for now" : "Free"];
              return (
                <li key={p.id}>
                  <span className="bz-ov-avatar" aria-hidden="true">{p.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
                  <span className="bz-ov-who"><strong>{p.name}</strong><small className="muted">{p.done}/{p.booked} bookings done</small></span>
                  <span className={`bz-ov-state ${state[0]}`}>{state[1]}</span>
                  {p.sales !== null && (
                    <span className="bz-ov-money"><strong>{biz.amount(p.sales)}</strong>{p.commission !== null && <small className="muted">{biz.amount(p.commission)} commission</small>}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
