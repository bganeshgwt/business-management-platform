import { useCallback, useEffect, useRef, useState } from "react";
import { count, money } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { outletStorage } from "../../../../services/api";
import { listPreorders } from "../../preorders/services/preorder.service";
import LiveBlock, { Facts, Figures } from "./LiveBlock";

// Pre-orders (a bakery's cakes, a café's party trays): what is due today and
// tomorrow, what is ready to hand over, and what is still to be baked. Staff
// tied to an outlet get that outlet's (the server sends no other); anyone
// else gets every outlet's, and with one outlet picked at the top the block
// says "All outlets", as Staff and Stock do. The advances they hold show
// while Advances & deposits is on, as on the Pre-orders page; with it off,
// none is taken. A pre-order booked, started, made ready or collected on
// another device shows within a second (live updates); the card has no timer
// of its own.
const TZ = "Asia/Kolkata";
const dayOf = (date) => new Date(date).toLocaleDateString("en-CA", { timeZone: TZ });
const time = (date) => new Date(date).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

export default function PreordersBlock({ currency }) {
  const { user, hasFeature } = useAuth();
  const advancesOn = hasFeature("advances");
  const scope = !user.outletId && outletStorage.get() ? "All outlets" : undefined;
  const [entry, setEntry] = useState(null);
  const shown = useRef(true);
  const load = useCallback(
    () => listPreorders({ status: "open" }).then((rows) => { if (shown.current) setEntry({ data: { rows, at: Date.now() } }); }).catch(() => { if (shown.current) setEntry({ data: null }); }),
    []
  );
  useEffect(() => {
    shown.current = true;
    load();
    return () => { shown.current = false; };
  }, [load]);
  useLiveRefresh({ restaurant: true }, ["preorder"], load, { every: 0 });
  return (
    <LiveBlock icon="calendar" tone="warning" title="Pre-orders" to="/preorders" openLabel="Open pre-orders" entry={entry} scope={scope}
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
              advancesOn && { label: "Advances held", value: money(rows.reduce((sum, r) => sum + r.advanceHeld, 0), currency) },
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
