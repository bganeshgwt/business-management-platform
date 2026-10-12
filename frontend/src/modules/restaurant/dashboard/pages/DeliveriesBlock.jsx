import { count, money } from "../../../../services/format";
import LiveBlock, { Facts, Figures } from "./LiveBlock";

// Deliveries (orders.view): what is waiting to go, what is on the road, what
// is late against the promised time, and how the day has gone. The cash the
// riders are carrying is money, so only people who may see takings get it.
export default function DeliveriesBlock({ entry, canSeeSales, currency }) {
  return (
    <LiveBlock
      icon="scooter"
      tone="success"
      title="Deliveries"
      to="/deliveries"
      panel={entry && entry.data && entry.data.stats.lateNow > 0 ? "deliveries.late" : "deliveries.dispatch"}
      openLabel="Open deliveries"
      entry={entry}
      summary={(summary) => {
        const stats = summary.stats;

        if (stats.toDispatch + stats.outNow === 0) {
          return stats.deliveredToday > 0
            ? `Nothing waiting · ${count(stats.deliveredToday)} delivered today`
            : "No deliveries running";
        }

        return `${count(stats.deliveredToday)} delivered today`;
      }}
      alert={(summary) =>
        summary.stats.lateNow > 0 ? { tone: "danger", text: `${count(summary.stats.lateNow)} late` } : null
      }
    >
      {(summary) => {
        const stats = summary.stats;

        return (
          <>
            <Figures
              items={[
                { label: "To dispatch", value: count(stats.toDispatch), panel: "deliveries.dispatch", to: "/deliveries" },
                { label: "Out now", value: count(stats.outNow), panel: "deliveries.out", to: "/deliveries" },
                {
                  label: "Late",
                  title: "Running late against the promised time",
                  value: count(stats.lateNow),
                  tone: "danger",
                  alert: stats.lateNow > 0,
                  panel: "deliveries.late",
                  to: "/deliveries",
                },
              ]}
            />
            <Facts
              items={[
                {
                  icon: "check-circle",
                  label: `On time today (within ${summary.slaMinutes} min)`,
                  value: stats.timedCount > 0 ? `${Math.round(stats.onTimeRate)}%` : "—",
                  tone: stats.timedCount > 0 && stats.onTimeRate < 80 ? "warning" : null,
                },
                {
                  icon: "users",
                  label: "Riders",
                  value: `${count(summary.ridersFree)} free · ${count(summary.ridersOnRun)} out`,
                },
                canSeeSales && {
                  icon: "cash",
                  label: "Cash with riders",
                  value: money(stats.cashWithRiders, currency),
                },
              ]}
            />
          </>
        );
      }}
    </LiveBlock>
  );
}
