import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../../../../components/Icon";
import { BarList, ColumnChart } from "../../../../components/Charts";
import { count, money } from "../../../../services/format";
import { paymentMethodLabel } from "../../../../services/labels";
import { plural, shortDate } from "../../reports/pages/reportFormat";
import { hourLabel } from "./liveFormat";

// The business day's trading in one panel, for someone who sees sales: what
// came in and how, where the orders came from, the shape of the day, what is
// selling, and the money that left again. Today only — the week and the month
// live in Full analysis. On a wide screen this is the dashboard's right-hand
// column; narrower, its sections flow side by side under live service.

// One colour per payment method, in a fixed order so a method keeps its
// colour from one refresh to the next.
const METHOD_TONES = ["var(--primary)", "var(--info)", "var(--violet)", "var(--warning)", "var(--muted)"];

function Section({ icon, title, aside, children }) {
  return (
    <section className="trade-section">
      <header className="trade-section-head">
        <h3>
          <Icon name={icon} size={15} />
          {title}
        </h3>
        {aside && <span className="trade-section-aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function Payments({ byMethod, duesCollected, cash, currency }) {
  const rows = [...byMethod].sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);

  return (
    <Section icon="wallet" title="Money in" aside={money(total, currency)}>
      {total === 0 ? (
        <p className="muted small">Nothing collected in this business day yet.</p>
      ) : (
        <>
          {/* One bar split by method: the mix at a glance, the rows below
              give the exact figures. */}
          <div className="trade-stack" role="img" aria-label="Money in by payment method">
            {rows.map((row, index) => (
              <span
                key={row.paymentMethod}
                style={{ flexGrow: row.amount, background: METHOD_TONES[Math.min(index, METHOD_TONES.length - 1)] }}
                title={`${paymentMethodLabel(row.paymentMethod)}: ${money(row.amount, currency)}`}
              />
            ))}
          </div>
          <ul className="trade-legend">
            {rows.map((row, index) => (
              <li key={row.paymentMethod}>
                <span className="trade-dot" style={{ background: METHOD_TONES[Math.min(index, METHOD_TONES.length - 1)] }} />
                <span className="trade-legend-label">{paymentMethodLabel(row.paymentMethod)}</span>
                <span className="trade-legend-share">{Math.round((row.amount / total) * 100)}%</span>
                <span className="trade-legend-value">{money(row.amount, currency)}</span>
              </li>
            ))}
          </ul>
          {duesCollected > 0 && (
            <p className="muted small">{money(duesCollected, currency)} of it is earlier days&apos; dues collected today.</p>
          )}
        </>
      )}

      {cash && !cash.outletOnly && (
        <div className="trade-drawer">
          <span>
            <Icon name="lock" size={14} />
            Expected in drawer
          </span>
          <strong>{money(cash.expected, currency)}</strong>
          <small>
            {money(cash.openingCash, currency)} opening + {money(cash.cashSales, currency)} cash sales
            {cash.cashRefunds > 0 ? ` − ${money(cash.cashRefunds, currency)} refunds` : ""}
            {cash.cashExpenses > 0 ? ` − ${money(cash.cashExpenses, currency)} expenses` : ""}
          </small>
        </div>
      )}
      {cash && cash.outletOnly && (
        <p className="muted small">
          {money(cash.cashSales, currency)} cash taken at this outlet. Pick All outlets to see what the drawer should hold.
        </p>
      )}
    </Section>
  );
}

// Every hour from the first sale (or late morning) to now, at least eight of
// them: one busy hour on its own was drawn as a single block filling the card.
const dayColumns = (byHour) => {
  const sales = new Map(byHour.map((row) => [row.hour, row.netSales]));
  const hours = [...sales.keys()];
  const now = new Date().getHours();
  let first = Math.min(11, ...hours);
  let last = Math.max(Math.min(now, 23), ...hours);
  if (last < first) last = first;
  if (last - first < 7) first = Math.max(0, last - 7);
  if (last - first < 7) last = first + 7;

  return Array.from({ length: last - first + 1 }, (ignored, index) => ({
    label: hourLabel(first + index),
    value: sales.get(first + index) || 0,
  }));
};

function Hours({ byHour, currency }) {
  const busiest =
    byHour.length > 0 ? byHour.reduce((best, row) => (row.netSales > best.netSales ? row : best)).hour : null;

  return (
    <Section icon="clock" title="Through the day" aside={busiest === null ? null : `Busiest ${hourLabel(busiest)}`}>
      {byHour.length === 0 ? (
        <p className="muted small">Nothing billed yet today.</p>
      ) : (
        <ColumnChart points={dayColumns(byHour)} currency={currency} height={110} />
      )}
    </Section>
  );
}

function Items({ items, currency, canSeeReports }) {
  const [view, setView] = useState("top");
  const best = items.topItems.length > 0 ? items.topItems[0].grossSales : 0;
  const rows = view === "top" ? items.topItems : items.lowItems;

  return (
    <Section icon="utensils" title="Items" aside={items.soldLines > 0 ? plural(items.soldLines, "dish", "dishes") : null}>
      {items.soldLines === 0 ? (
        <p className="muted small">Nothing sold in this business day yet.</p>
      ) : (
        <>
          <div className="segmented trade-switch" role="radiogroup" aria-label="Items sold this business day">
            {[
              ["top", "Best sellers"],
              ["low", "Slowest"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`segment ${view === key ? "is-active" : ""}`}
                role="radio"
                aria-checked={view === key}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <BarList
            rows={rows.map((row) => ({ label: row.itemName, value: row.grossSales, sub: `${count(row.quantity)} sold` }))}
            currency={currency}
            scale={view === "low" ? best : undefined}
          />
          {items.unsoldToday > 0 && (
            <p className="muted small">
              {count(items.unsoldToday)} {items.unsoldToday === 1 ? "dish has" : "dishes have"} not sold today.{" "}
              {canSeeReports && <Link to="/reports?tab=items">See which</Link>}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function Leakage({ discounts, refunds, voids, expensesToday, currency }) {
  const cells = [
    { label: "Discounts", value: money(discounts, currency), hot: discounts > 0 },
    { label: "Refunds", value: money(refunds, currency), hot: refunds > 0 },
    { label: "Bills voided", value: count(voids), hot: voids > 0 },
    expensesToday !== null && { label: "Expenses", value: money(expensesToday, currency), hot: false },
  ].filter(Boolean);

  return (
    <Section icon="alert" title="Money out">
      <dl className="trade-leak">
        {cells.map((cell) => (
          <div key={cell.label} className={cell.hot ? "is-hot" : ""}>
            <dt>{cell.label}</dt>
            <dd>{cell.value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export default function TradingToday({ data, cash, currency, canOrders, canSeeReports, expensesToday }) {
  return (
    <div className="trade-panel">
      <header className="trade-head">
        <div>
          <h2 id="dash-trading-title">Today&apos;s trading</h2>
          <p>Business day {shortDate(data.businessDate)} · this day only</p>
        </div>
        {canSeeReports && (
          <Link className="button button-ghost button-sm" to="/reports">
            Full analysis <Icon name="arrow-right" size={14} />
          </Link>
        )}
      </header>
      <div className="trade-body">
        {canOrders && (
          <Payments byMethod={data.byMethod} duesCollected={data.duesCollected || 0} cash={cash} currency={currency} />
        )}
        {canOrders && <Hours byHour={data.byHour} currency={currency} />}
        <Items items={data} currency={currency} canSeeReports={canSeeReports} />
        {canOrders && (
          <Leakage
            discounts={data.discounts}
            refunds={data.refunds}
            voids={data.voids}
            expensesToday={expensesToday}
            currency={currency}
          />
        )}
      </div>
    </div>
  );
}
