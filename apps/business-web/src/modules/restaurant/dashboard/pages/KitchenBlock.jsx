import { count } from "@bmp/shared/format";
import LiveBlock, { Facts, Figures } from "./LiveBlock";
import { minutesFrom, secondsText, waitText } from "./liveFormat";

// The kitchen (kds.view): tickets at each stage, how many are past the late
// mark, the oldest one still waiting, and today's average ticket time — the
// same late and warning marks the kitchen display colours its tickets by.
export default function KitchenBlock({ entry }) {
  return (
    <LiveBlock
      icon="chef"
      tone="primary"
      title="Kitchen"
      to="/kitchen"
      panel={entry && entry.data && entry.data.lateNow > 0 ? "kitchen.late" : "kitchen.open"}
      openLabel="Open the kitchen display"
      entry={entry}
      summary={(kitchen) =>
        kitchen.openCount === 0
          ? "Nothing on the pass right now"
          : `${count(kitchen.openCount)} ${kitchen.openCount === 1 ? "ticket" : "tickets"} open`
      }
      alert={(kitchen) =>
        kitchen.lateNow > 0 ? { tone: "danger", text: `${count(kitchen.lateNow)} late` } : null
      }
    >
      {(kitchen) => {
        const oldest = kitchen.oldestWaitingAt ? minutesFrom(kitchen.oldestWaitingAt, kitchen.serverTime) : null;
        const oldestTone =
          oldest === null ? null : oldest >= kitchen.lateMinutes ? "danger" : oldest >= kitchen.warnMinutes ? "warning" : null;

        return (
          <>
            <Figures
              items={[
                { label: "New", value: count(kitchen.newCount), panel: "kitchen.open", to: "/kitchen" },
                { label: "Cooking", value: count(kitchen.cookingCount), panel: "kitchen.open", to: "/kitchen" },
                { label: "Ready", title: "Ready at the pass, waiting to be served", value: count(kitchen.readyCount), panel: "kitchen.open", to: "/kitchen" },
              ]}
            />
            <Facts
              items={[
                {
                  icon: "alert",
                  label: `Late now (over ${kitchen.lateMinutes} min)`,
                  value: count(kitchen.lateNow),
                  tone: kitchen.lateNow > 0 ? "danger" : null,
                },
                {
                  icon: "timer",
                  label: "Oldest still waiting",
                  value: oldest === null ? "—" : waitText(oldest),
                  tone: oldestTone,
                },
                {
                  icon: "clock",
                  // "Today" is the business day; once it is closed the figure
                  // is the last day's, and the label says so.
                  label: kitchen.dayOpen ? "Average ticket time today" : "Average ticket time, last day",
                  value: kitchen.timedToday > 0 ? secondsText(kitchen.avgReadySeconds) : "—",
                },
                kitchen.earlierOpen > 0 && {
                  icon: "ban",
                  label: "Left open from earlier days (not counted)",
                  value: count(kitchen.earlierOpen),
                  tone: "warning",
                },
              ]}
            />
          </>
        );
      }}
    </LiveBlock>
  );
}
