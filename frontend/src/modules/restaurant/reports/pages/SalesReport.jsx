// Sales tab of the Reports screen: totals, day by day, hours, order types and payments.

import { useMemo } from "react";
import { orderTypeLabel, paymentMethodLabel } from "../../../../services/labels";
import SectionCard from "../../../../components/SectionCard";
import SalesBreakdown from "./SalesBreakdown";
import StatTile from "../../../../components/StatTile";
import Icon from "../../../../components/Icon";
import { BarList, TrendChart } from "../../../../components/Charts";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { count, money } from "../../../../services/format";
import { dayAndDate, plural, shortDate } from "./reportFormat";

export default function SalesReport({ data, currency }) {
  const { summary } = data;

  // The best day in the range. Worth a tile of its own: it is one of the two
  // questions anybody actually opens a sales report to answer.
  const best = data.byDay.reduce(
    (top, row) => (row.billCount > 0 && (top === null || row.netSales > top.netSales) ? row : top),
    null
  );
  const quiet = data.byDay.length - data.daysTraded;

  return (
    <div className="stack">
      <div className={`stat-grid ${data.byDay.length > 1 && best ? "report-tiles-3" : ""}`}>
        <StatTile
          icon="rupee"
          tone="primary"
          label="Total billed (net sales)"
          value={money(summary.netSales, currency)}
          note="includes tax; before refunds"
        />
        <StatTile
          icon="receipt"
          tone="info"
          label="Bills"
          value={count(summary.billCount)}
          note={`${money(summary.collected, currency)} collected`}
        />
        <StatTile icon="wallet" label="Average bill" value={money(summary.averageBill, currency)} />
        {/* The same definition as the dashboard: dine-in spend divided by
            the guests at those tables. Takeaway has no covers. */}
        <StatTile
          icon="users"
          tone="violet"
          label="Per head (dine-in)"
          value={summary.covers > 0 ? money(summary.perHead, currency) : "—"}
          note={`${plural(summary.covers, "cover", "covers")}${
            summary.dineInWithoutGuests > 0
              ? ` · ${plural(summary.dineInWithoutGuests, "dine-in bill", "dine-in bills")} had no guest count`
              : ""
          }`}
        />
        <StatTile icon="percent" tone="warning" label="Discounts given" value={money(summary.discounts, currency)} />
        {data.byDay.length > 1 && best && (
          <StatTile
            icon="star"
            tone="success"
            label="Best day"
            value={money(best.netSales, currency)}
            note={`${dayAndDate(best.businessDate)} · ${plural(best.billCount, "bill", "bills")}`}
          />
        )}
      </div>

      {/* A line needs two days. For one day the card was a lone dot in a
          corner; the day's shape is in Busiest hours below. */}
      {data.byDay.length > 1 && (
        <SectionCard
          icon="trend-up"
          title="Sales by day"
          description={`${count(data.daysTraded)} of ${count(data.byDay.length)} days traded${
            quiet > 0 ? ` · ${count(quiet)} with no sales, drawn at zero` : ""
          }`}
        >
          <TrendChart
            label="Sales by day"
            points={data.byDay.map((row) => ({
              label: shortDate(row.businessDate),
              value: row.netSales,
            }))}
            currency={currency}
          />
        </SectionCard>
      )}

      {data.byDay.length > 1 && <DayByDay rows={data.byDay} best={best} currency={currency} />}

      <div className="two-column report-pair">
        <SectionCard icon="utensils" title="By order type" description="Dine-in, takeaway and delivery, by net sales.">
          <BarList
            rows={data.byOrderType.map((row) => ({
              label: orderTypeLabel(row.orderType),
              value: row.netSales,
              sub: plural(row.billCount, "bill", "bills"),
            }))}
            currency={currency}
          />
        </SectionCard>

        <SectionCard icon="card" tone="info" title="By payment method" description="What was collected, and how.">
          <BarList
            rows={data.byPaymentMode.map((row) => ({
              label: paymentMethodLabel(row.paymentMethod),
              value: row.amount,
              sub: plural(row.paymentCount, "payment", "payments"),
            }))}
            currency={currency}
          />
        </SectionCard>
      </div>

      {(data.byPaymentType || []).length > 0 && (
        <SectionCard
          icon="wallet"
          tone="info"
          title="By payment type"
          description="Your own payment types (meal cards, cheques, apps), each under its method: what each company's settlement is checked against."
        >
          <BarList
            rows={data.byPaymentType.map((row) => ({
              label: `${row.paymentTypeName} · ${paymentMethodLabel(row.paymentMethod)}`,
              value: row.amount,
              sub: plural(row.paymentCount, "payment", "payments"),
            }))}
            currency={currency}
          />
        </SectionCard>
      )}

      <SectionCard icon="clock" tone="warning" title="Busiest hours" description="On the restaurant's own clock.">
        <BarList
          rows={data.byHour.map((row) => ({
            label: `${String(row.hour).padStart(2, "0")}:00`,
            value: row.netSales,
            sub: plural(row.billCount, "bill", "bills"),
          }))}
          currency={currency}
        />
      </SectionCard>

      <SalesBreakdown summary={summary} currency={currency} />
    </div>
  );
}

// The figures behind the line. A chart shows the shape of a fortnight; it does
// not tell you that Saturday took 31,204 — and hovering every point to find the
// best one is not reading, it is hunting. Days with no sales are listed too:
// a closed Monday is a fact about the fortnight.
function DayByDay({ rows, best, currency }) {
  const columns = useMemo(
    () => [
      {
        key: "date",
        header: "Day",
        type: "date",
        value: (row) => row.businessDate,
        mobile: "title",
        render: (row) => (
          <span className="nowrap">
            {dayAndDate(row.businessDate)}{" "}
            {best && row.businessDate === best.businessDate && (
              <span className="badge badge-active status-badge">
                <Icon name="star" size={12} />
                Best
              </span>
            )}
            {row.billCount === 0 && <span className="muted small"> no sales</span>}
          </span>
        ),
      },
      { key: "bills", header: "Bills", type: "number", value: (row) => row.billCount, total: "sum", mobile: "show" },
      { key: "sales", header: "Net sales", type: "money", value: (row) => row.netSales, total: "sum", mobile: "show" },
      { key: "discounts", header: "Discounts", type: "money", value: (row) => row.discounts, total: "sum", mobile: "show" },
      { key: "average", header: "Average bill", type: "money", value: (row) => row.averageBill, mobile: "show" },
    ],
    [best]
  );

  return (
    <SectionCard
      icon="calendar"
      tone="info"
      title="Day by day"
      description="Every day in the range, quiet ones included. Sort by any column."
      flush
    >
      <DataGrid
        id="report-day-by-day"
        caption="Sales day by day"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.businessDate}
        rowClassName={(row) => (row.billCount === 0 ? "dg-tone-muted" : "")}
        defaultSort={{ key: "date", direction: "asc" }}
        exportName="sales-day-by-day"
        currency={currency}
        rowNoun={["day", "days"]}
        search={false}
      />
    </SectionCard>
  );
}
