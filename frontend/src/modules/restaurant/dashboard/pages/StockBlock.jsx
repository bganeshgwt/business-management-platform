import { count, money } from "../../../../services/format";
import LiveBlock, { Facts, Figures } from "./LiveBlock";

// The waste of the last seven days against the seven before, in words. Up is
// the bad direction here, so it takes the warning tone; a week with nothing
// logged before it has nothing to be compared with, and says so.
const wasteTrend = (week) => {
  if (!week.previousValue) {
    return { text: "none logged the week before", tone: null };
  }

  const change = Math.round(((week.value - week.previousValue) / week.previousValue) * 100);

  if (change === 0) {
    return { text: "level with the week before", tone: null };
  }

  return change > 0
    ? { text: `▲ ${change}% on the week before`, tone: "warning" }
    : { text: `▼ ${Math.abs(change)}% on the week before`, tone: "success" };
};

// Stock (inventory.view): what has run out, what is about to, what to order,
// and what went in the bin. `scope` says "All outlets" when an outlet is
// chosen in the top bar: these figures are the whole restaurant's stock, and
// must not pass for the outlet's own. When the figures are one outlet's own
// store (someone tied to an outlet that keeps its own shelf: the summary
// names the store), the card says that store instead.
export default function StockBlock({ entry, scope }) {
  const store = entry && entry.data && entry.data.store;

  return (
    <LiveBlock
      icon="box"
      tone="warning"
      title="Stock"
      scope={store ? store.name : scope}
      to="/inventory/insights?tab=reorder"
      panel={entry && entry.data && entry.data.stock.out === 0 ? "stock.order" : "stock.out"}
      openLabel="Open stock insights"
      entry={entry}
      summary={(summary) =>
        summary.stock.toOrder > 0
          ? `${count(summary.stock.toOrder)} ${summary.stock.toOrder === 1 ? "item" : "items"} to order`
          : "Nothing needs ordering"
      }
      alert={(summary) =>
        summary.stock.out > 0 ? { tone: "danger", text: `${count(summary.stock.out)} out` } : null
      }
    >
      {(summary) => {
        const { stock } = summary;
        const trend = wasteTrend(summary.wasteLast7Days);

        return (
          <>
            <Figures
              items={[
                { label: "Out", value: count(stock.out), tone: "danger", alert: stock.out > 0, panel: "stock.out", to: "/inventory/insights?tab=reorder" },
                { label: "Critical", value: count(stock.critical), tone: "warning", alert: stock.critical > 0, panel: "stock.critical", to: "/inventory/insights?tab=reorder" },
                { label: "Low", value: count(stock.low), panel: "stock.low", to: "/inventory/insights?tab=reorder" },
                { label: "To order", value: count(stock.toOrder), panel: "stock.order", to: "/inventory/insights?tab=reorder" },
              ]}
            />
            <Facts
              items={[
                {
                  icon: "trash",
                  label: "Waste today",
                  value: money(summary.wasteToday.value, summary.currency),
                },
                {
                  icon: trend.tone === "success" ? "trend-down" : "trend-up",
                  label: "Waste, last 7 days",
                  sub: trend.text,
                  subTone: trend.tone,
                  value: money(summary.wasteLast7Days.value, summary.currency),
                },
              ]}
            />
          </>
        );
      }}
    </LiveBlock>
  );
}
