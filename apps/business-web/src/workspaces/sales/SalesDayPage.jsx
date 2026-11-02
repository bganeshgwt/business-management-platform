import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import { timeOnly } from "@bmp/shared/format";
import SectionCard from "../../components/SectionCard";
import StatTile from "../../components/StatTile";
import { toast } from "../../services/toast";
import { useSales } from "./salesContext";
import useFigures from "./useDayFigures";
import { reasonLabel } from "./salesRules";
import { EndDayDialog } from "./salesParts";
import { money } from "./salesFormat";

// Day: the day's figures as the office sees them (calls, productive calls
// and the strike rate, lines per call, beat adherence, the order value, what
// was collected by mode), the cash and cheques to hand over at the evening
// settlement, why shops did not order, and "End my day": after it, no place
// is recorded until the next day starts.
export default function SalesDayPage() {
  const sales = useSales();
  const figures = useFigures(sales);
  const [ending, setEnding] = useState(false);
  const reasons = {};
  for (const visit of sales.visits) if (visit.out?.reason) reasons[visit.out.reason] = (reasons[visit.out.reason] || 0) + 1;
  const cheques = figures.cheques.map((r) => (r.entry ? { shop: r.entry.data.shopName, amount: r.entry.data.amount, number: r.entry.data.reference, bank: r.entry.data.bank, date: r.entry.data.chequeDate }
    : { shop: r.server.contact_name, amount: r.server.amount, number: r.server.reference, bank: r.server.bank, date: r.server.cheque_date }));

  const end = async (details) => {
    await sales.actions.endDay(details);
    setEnding(false);
    toast.success("Your day has ended. Hand over the cash and cheques at the office.");
  };

  return (
    <div className="sl-page">
      <div className="sl-page-head">
        <h1 className="sl-title">The day</h1>
        <span className={`sl-day-state is-${sales.ended ? "ended" : sales.started ? "started" : "idle"}`}>
          {sales.ended ? `Ended ${timeOnly(sales.endedAt)}` : sales.started ? `Started ${timeOnly(sales.startedAt)}` : "Not started"}
        </span>
      </div>
      <div className="sl-stats">
        <StatTile size="sm" icon="store" tone="primary" label="Beat visited" value={`${figures.visitedPlanned} of ${figures.planned}`} note={figures.adherence !== null ? `${figures.adherence}% of the plan` : "No beat planned"} />
        <StatTile size="sm" icon="users" tone="primary" label="Calls" value={String(figures.calls)} note={`${figures.productive} productive${figures.strikeRate !== null ? ` · ${figures.strikeRate}% strike rate` : ""}`} />
        <StatTile size="sm" icon="receipt" tone="success" label="Order value" value={money(figures.orderValue / 100)} note={`${figures.orders} orders${figures.linesPerCall !== null ? ` · ${figures.linesPerCall} lines a call` : ""}`} />
        <StatTile size="sm" icon="wallet" tone="info" label="Collected" value={money(figures.collected / 100)} note={`UPI ${money(figures.upi / 100)} · cheques ${money(figures.cheque / 100)}`} />
      </div>

      <SectionCard icon="cash" title="To hand over at the office" description="The evening settlement counts it against these receipts.">
        <dl className="sl-handover">
          <div><dt>Cash</dt><dd>{money(figures.cash / 100)}</dd></div>
          <div><dt>Cheques</dt><dd>{cheques.length} · {money(figures.cheque / 100)}</dd></div>
        </dl>
        {cheques.length > 0 && (
          <ul className="sl-bills">
            {cheques.map((c) => <li key={`${c.number}-${c.bank}`}><span>{c.number} · {c.bank} · {c.shop}{c.date > sales.today ? ` · dated ${c.date}` : ""}</span><span>{money(c.amount)}</span></li>)}
          </ul>
        )}
      </SectionCard>

      {Object.keys(reasons).length > 0 && (
        <SectionCard icon="minus" title="Why no order">
          <ul className="sl-bills">
            {Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([code, n]) => <li key={code}><span>{reasonLabel(code)}</span><span>{n}</span></li>)}
          </ul>
        </SectionCard>
      )}

      {sales.waiting.total > 0 && !sales.watching && (
        <p className="alert alert-notice">{sales.waiting.total} {sales.waiting.total === 1 ? "thing waits" : "things wait"} on this phone to be sent{sales.waiting.attention ? `, ${sales.waiting.attention} needing attention (see Orders)` : ""}.</p>
      )}

      {sales.actions && sales.started && !sales.ended && (
        <button type="button" className="button sl-wide" onClick={() => setEnding(true)}><Icon name="moon" size={17} /> End my day</button>
      )}
      {ending && (
        <EndDayDialog cash={figures.cash} cheques={{ count: cheques.length, amount: figures.cheque }} upi={figures.upi} waiting={sales.waiting.total}
          recordPlaces={sales.settings?.record_places !== false} onEnd={end} onClose={() => setEnding(false)} />
      )}
    </div>
  );
}
