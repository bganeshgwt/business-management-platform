import { useEffect, useState } from "react";
import { count, money } from "../../../../services/format";
import { listPreorders } from "../../preorders/services/preorder.service";
import LiveBlock, { Facts, Figures } from "./LiveBlock";

// Pre-orders (a bakery's cakes, a café's party trays): what is due today and
// tomorrow, what is ready to hand over, and what is still to be baked.
const TZ = "Asia/Kolkata";
const dayOf = (date) => new Date(date).toLocaleDateString("en-CA", { timeZone: TZ });
const time = (date) => new Date(date).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

export default function PreordersBlock({ currency }) {
  const [entry, setEntry] = useState(null);
  useEffect(() => {
    let live = true;
    listPreorders({ status: "open" }).then((rows) => { if (live) setEntry({ data: { rows, at: Date.now() } }); }).catch(() => { if (live) setEntry({ data: null }); });
    return () => { live = false; };
  }, []);
  return (
    <LiveBlock icon="calendar" tone="warning" title="Pre-orders" to="/preorders" openLabel="Open pre-orders" entry={entry}
      summary={({ rows, at }) => {
        const today = dayOf(at);
        const due = rows.filter((r) => dayOf(r.dueAt) === today);
        return due.length ? `${count(due.length)} due today · ${count(rows.filter((r) => r.status === "ready").length)} ready` : "Nothing due today";
      }}
      alert={({ rows, at }) => {
        const today = dayOf(at);
        const late = rows.filter((r) => dayOf(r.dueAt) === today && r.status === "booked" && new Date(r.dueAt).getTime() - at < 3 * 3600000).length;
        return late ? { tone: "warning", text: `${count(late)} not started, due within 3 hours` } : null;
      }}>
      {({ rows, at }) => {
        const today = dayOf(at);
        const tomorrow = dayOf(at + 86400000);
        const due = rows.filter((r) => dayOf(r.dueAt) === today).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
        return (
          <>
            <Figures items={[
              { label: "Due today", value: count(due.length), to: "/preorders" },
              { label: "Tomorrow", value: count(rows.filter((r) => dayOf(r.dueAt) === tomorrow).length), to: "/preorders" },
              { label: "Advances held", value: money(rows.reduce((sum, r) => sum + r.advanceHeld, 0), currency) },
            ]} />
            <Facts items={due.slice(0, 4).map((r) => ({
              icon: r.status === "ready" ? "check-circle" : "clock",
              label: `${time(r.dueAt)} · ${r.customerName}`,
              value: r.items.map((i) => i.name).join(", "),
              tone: r.status === "ready" ? null : "warning",
            }))} />
          </>
        );
      }}
    </LiveBlock>
  );
}
