import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import { dateShort, timeOnly } from "@bmp/shared/format";
import SectionCard from "../../components/SectionCard";
import { EmptyState } from "../../components/Feedback";
import { confirmAction } from "../../services/confirm";
import { useSales } from "./salesContext";
import { recordsOfDay } from "./salesJournal";
import { methodLabel, reasonLabel } from "./salesRules";
import { SendState } from "./salesParts";
import { money } from "./salesFormat";

// Orders: what was taken today and whether each reached the office —
// waiting, sending, sent (with the office's number, and any price
// difference), or needing attention with the server's own reason (a credit
// hold the office may let through, a limit it may raise, a new shop's cash
// only): "Try again" sends it with the same request key once that is sorted.
// Then collections, visits, new shops and the day's start and end, and
// anything from earlier days still waiting.
const REFUSAL_WAY = {
  credit_hold: "Ask the office to let it through (Sales orders › Field sales), then Try again.",
  credit_limit: "Collect, or ask the office to raise the limit, then Try again.",
  cash_only: "Collect what is owed, or ask the office to approve the shop and set its credit, then Try again.",
  duplicate_shop: "This shop is already a customer: discard the new shop and visit that one.",
  plan_ended: "The business's plan has ended: the owner renews it in Your plan, then Try again.",
};

export default function SalesOrdersTab() {
  const sales = useSales();
  const today = sales.today;
  const orders = recordsOfDay(sales.entries, sales.day, today, "order");
  const collections = recordsOfDay(sales.entries, sales.day, today, "collection");
  const others = sales.entries.filter((e) => e.date === today && ["visit", "checkout", "shop", "start", "end"].includes(e.kind)).sort((a, b) => b.at.localeCompare(a.at));
  const earlier = sales.entries.filter((e) => e.date < today && ["waiting", "sending", "attention"].includes(sales.status(e).state));

  if (!orders.length && !collections.length && !others.length && !earlier.length) {
    return (
      <div className="sl-page">
        <h1 className="sl-title">Orders</h1>
        <EmptyState icon="receipt" message="Nothing taken today yet" hint="Orders and collections show here as you take them, with whether each reached the office." />
      </div>
    );
  }

  return (
    <div className="sl-page">
      <h1 className="sl-title">Orders</h1>
      {earlier.length > 0 && (
        <SectionCard icon="alert" tone="warning" title="From earlier days, still on this phone" flush>
          <ul className="sl-records">{earlier.map((e) => <EntryRow key={e.id} entry={e} sales={sales} withDate />)}</ul>
        </SectionCard>
      )}
      <SectionCard icon="receipt" title="Orders" description={orders.length ? undefined : "None today"} flush>
        {orders.length > 0 && <ul className="sl-records">{orders.map((r) => (r.entry ? <EntryRow key={r.key} entry={r.entry} sales={sales} /> : <ServerOrder key={r.key} row={r.server} />))}</ul>}
      </SectionCard>
      <SectionCard icon="wallet" title="Collections" description={collections.length ? undefined : "None today"} flush>
        {collections.length > 0 && <ul className="sl-records">{collections.map((r) => (r.entry ? <EntryRow key={r.key} entry={r.entry} sales={sales} /> : <ServerCollection key={r.key} row={r.server} />))}</ul>}
      </SectionCard>
      {others.length > 0 && (
        <SectionCard icon="list" title="Visits, new shops and the day" flush>
          <ul className="sl-records">{others.map((e) => <EntryRow key={e.id} entry={e} sales={sales} />)}</ul>
        </SectionCard>
      )}
    </div>
  );
}

// What an entry was, in words.
function describe(entry) {
  const d = entry.data || {};
  switch (entry.kind) {
    case "order": return { title: d.shopName, meta: `${money(entry.result?.total ?? d.phoneTotal)} · ${d.lines?.length || 0} ${d.lines?.length === 1 ? "line" : "lines"}`, number: entry.result?.order_no };
    case "collection": return { title: d.shopName, meta: `${money(d.amount)} · ${methodLabel(d.method)}${d.reference ? ` ${d.reference}` : ""}`, number: entry.result?.collection_no };
    case "visit": return { title: `Check-in · ${d.shopName}`, meta: [d.far ? "away from the shop" : null, d.offBeat ? "off the beat" : null].filter(Boolean).join(" · ") };
    case "checkout": return { title: "Check-out", meta: d.outcome === "no_order" ? `No order · ${reasonLabel(d.noOrderReason)}` : "With an order" };
    case "shop": return { title: `New shop · ${d.name}`, meta: "Waits for the office's approval" };
    case "start": return { title: "Day started", meta: d.place ? "with your place" : "" };
    case "end": return { title: "Day ended", meta: d.cashInHand ? `Cash in hand ${money(d.cashInHand)}` : "" };
    default: return { title: entry.kind, meta: "" };
  }
}

function EntryRow({ entry, sales, withDate = false }) {
  const [busy, setBusy] = useState(false);
  const state = sales.status(entry);
  const words = describe(entry);
  const difference = entry.kind === "order" && entry.result && Number(entry.result.price_difference || 0) !== 0 ? Number(entry.result.price_difference) : null;
  const again = async () => {
    setBusy(true);
    try {
      await sales.actions?.retry(entry);
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    const sure = await confirmAction({
      title: "Discard this from the phone?",
      message: <p>It has not reached the office, and discarding it loses it for good. Anything that waits for it will need attention too.</p>,
      confirmLabel: "Discard it",
      cancelLabel: "Keep it",
    });
    if (sure) await sales.actions?.discard(entry);
  };
  return (
    <li className="sl-record" data-state={state.state}>
      <span className="sl-record-head">
        <strong>{words.number ? `${words.number} · ` : ""}{words.title}</strong>
        <SendState state={state} />
      </span>
      <span className="sl-record-meta">{[withDate ? dateShort(entry.at) : null, timeOnly(entry.at), words.meta, entry.offline ? "made offline" : null].filter(Boolean).join(" · ")}</span>
      {difference !== null && (
        <span className="sl-record-note">Priced again by the office at {money(entry.result.total)}: {difference > 0 ? "up" : "down"} {money(Math.abs(difference))} from the phone&apos;s {money(entry.result.phone_total)}. Tell the shop.</span>
      )}
      {state.state === "attention" && (
        <>
          <span className="sl-record-why">{state.message}{REFUSAL_WAY[state.reason] ? ` ${REFUSAL_WAY[state.reason]}` : ""}</span>
          {sales.actions && (
            <span className="sl-record-actions">
              <button type="button" className="button button-sm" onClick={again} disabled={busy || !sales.online}><Icon name="refresh" size={14} /> Try again</button>
              <button type="button" className="button button-secondary button-sm" onClick={discard}>Discard…</button>
            </span>
          )}
        </>
      )}
      {state.state === "waiting" && state.message && <span className="sl-record-meta">{state.message}</span>}
    </li>
  );
}

function ServerOrder({ row }) {
  const difference = Number(row.total) - Number(row.phone_total);
  return (
    <li className="sl-record">
      <span className="sl-record-head"><strong>{row.order_no} · {row.contact_name}</strong><SendState state={{ state: "sent" }} /></span>
      <span className="sl-record-meta">{[timeOnly(row.taken_at), money(row.total), `${row.line_count} lines`, row.offline ? "made offline" : null].filter(Boolean).join(" · ")}</span>
      {Math.abs(difference) >= 0.01 && <span className="sl-record-note">Priced again by the office: {difference > 0 ? "up" : "down"} {money(Math.abs(difference))} from the phone&apos;s {money(row.phone_total)}.</span>}
    </li>
  );
}

function ServerCollection({ row }) {
  return (
    <li className="sl-record">
      <span className="sl-record-head"><strong>{row.collection_no} · {row.contact_name}</strong><SendState state={{ state: "sent" }} /></span>
      <span className="sl-record-meta">{[timeOnly(row.taken_at), money(row.amount), methodLabel(row.method), row.settled ? "handed over" : null].filter(Boolean).join(" · ")}</span>
    </li>
  );
}
