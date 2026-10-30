import { count, money } from "@bmp/shared/format";
import { plural } from "../../reports/pages/reportFormat";
import LiveBlock, { Facts, Figures } from "./LiveBlock";
import { minutesFrom, secondsText, waitText } from "./liveFormat";

// What the tables are asking for (orders.view), and how fast it is answered:
// the bills the waiters ask for from the captain app, in every restaurant;
// with QR ordering or the online ordering page on (`guests`), the guests' calls
// for a waiter, the bill or water too, and their orders waiting to be
// accepted. The money the accepted orders brought in is shown only to people
// who may see takings.
export default function RequestsBlock({ entry, guests, canSeeSales, currency }) {
  return (
    <LiveBlock
      icon={guests ? "qr" : "bell"}
      tone="warning"
      title="Table requests"
      to="/table-requests"
      panel={!guests || (entry && entry.data && entry.data.pendingOrders === 0 && entry.data.openCalls > 0) ? "requests.calls" : "requests.orders"}
      openLabel="Open table requests"
      entry={entry}
      summary={(requests) =>
        requests.pendingOrders + requests.openCalls === 0
          ? "All answered"
          : guests
            ? `${plural(requests.pendingOrders, "order", "orders")} and ${plural(requests.openCalls, "call", "calls")} open`
            : `${plural(requests.openCalls, "call", "calls")} open`
      }
      alert={(requests) =>
        requests.pendingOrders + requests.unansweredCalls > 0
          ? { tone: "warning", text: `${count(requests.pendingOrders + requests.unansweredCalls)} to answer` }
          : null
      }
    >
      {(requests) => (
        <>
          <Figures
            items={[
              guests && {
                label: "QR orders",
                title: "QR orders waiting to be accepted",
                value: count(requests.pendingOrders),
                note: "to accept",
                tone: "warning",
                alert: requests.pendingOrders > 0,
                panel: "requests.orders",
                to: "/table-requests",
              },
              {
                label: "Calls open",
                value: count(requests.openCalls),
                panel: "requests.calls",
                to: "/table-requests",
                note: requests.unansweredCalls > 0 ? `${count(requests.unansweredCalls)} unanswered` : undefined,
              },
              { label: "Answer time", title: "Average time to answer a call today", value: secondsText(requests.avgResponseSeconds) },
            ]}
          />
          <Facts
            items={[
              requests.pendingOrders > 0 &&
                requests.oldestOrderAt && {
                  icon: "timer",
                  label: "Oldest order waiting",
                  value: waitText(minutesFrom(requests.oldestOrderAt, requests.serverTime)),
                  tone: "warning",
                },
              requests.openCalls > 0 &&
                requests.oldestCallAt && {
                  icon: "bell",
                  label: "Oldest call",
                  value: waitText(minutesFrom(requests.oldestCallAt, requests.serverTime)),
                  tone: "warning",
                },
              guests && {
                icon: "receipt",
                label: "QR orders accepted today",
                value: canSeeSales
                  ? `${count(requests.acceptedToday)} · ${money(requests.acceptedValueToday, currency)}`
                  : count(requests.acceptedToday),
              },
              {
                icon: "check-circle",
                label: "Calls answered today",
                value: `${count(requests.callsDoneToday)} of ${count(requests.callsToday)}`,
              },
            ]}
          />
        </>
      )}
    </LiveBlock>
  );
}
