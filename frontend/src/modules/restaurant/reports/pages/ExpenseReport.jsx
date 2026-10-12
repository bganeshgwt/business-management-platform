import { useMemo } from "react";
import { BarList } from "../../../../components/Charts";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState } from "../../../../components/Feedback";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { count, money } from "../../../../services/format";
import { paymentMethodLabel } from "../../../../services/labels";
import { plural } from "./reportFormat";

// Where the money went: approved expenses by category, month by month.
// Money still waiting for approval is not yet a cost, but it is shown apart
// because an owner should know it is coming.
export default function ExpenseReport({ data, currency }) {
  const showMonths = data.months.length > 1;
  // One outlet picked: the expenses recorded for the whole restaurant, and
  // this outlet's share of them (by sales, as the P&L charges them).
  const shared = data.shared;

  // Report columns are built once per report (a long range has many months
  // and many categories). Money as the page shows it elsewhere: money(), in
  // the restaurant's currency (passed to the grids).
  const sharedColumns = useMemo(
    () => [
      { key: "category", header: "Category", mobile: "title", filter: "text", value: (row) => row.categoryName },
      { key: "entries", header: "Entries", type: "number", total: "sum", mobile: "show", value: (row) => row.count },
      { key: "amount", header: "Whole restaurant", type: "money", total: "sum", mobile: "show", value: (row) => row.amount },
      {
        key: "share",
        header: `${data.outletName}'s share`,
        type: "money",
        total: "sum",
        mobile: "show",
        value: (row) => row.share,
      },
    ],
    [data.outletName]
  );

  const categoryColumns = useMemo(
    () => [
      { key: "category", header: "Category", mobile: "title", filter: "text", value: (row) => row.categoryName },
      { key: "entries", header: "Entries", type: "number", total: "sum", mobile: "show", value: (row) => row.count },
      ...(showMonths
        ? data.months.map((month, index) => ({
            key: `month-${month.key}`,
            header: month.label,
            type: "money",
            total: "sum",
            // A month with nothing spent reads "—", as before.
            value: (row) => row.byMonth[index] || null,
          }))
        : []),
      { key: "amount", header: "Total", type: "money", total: "sum", mobile: "show", value: (row) => row.amount },
      {
        key: "share",
        header: "Share",
        type: "percent",
        mobile: "show",
        value: (row) => row.share,
        render: (row) => <span className="muted">{row.share}%</span>,
      },
    ],
    [data.months, showMonths]
  );

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatTile
          icon="wallet"
          tone="primary"
          label={shared ? `${data.outletName}'s own expenses` : "Approved expenses"}
          value={money(data.total, currency)}
          note={plural(data.approvedCount, "entry", "entries")}
        />
        {/* Waiting money is work for someone: the tile opens the list of
            entries to approve. */}
        <StatTile
          icon="clock"
          tone="warning"
          label="Waiting for approval"
          value={money(data.pending.amount, currency)}
          note={data.pending.count > 0 ? `${count(data.pending.count)} to approve →` : "nothing waiting"}
          to={data.pending.count > 0 ? "/expenses?status=pending" : undefined}
        />
        <StatTile
          icon="x-circle"
          label="Rejected"
          value={money(data.rejected.amount, currency)}
          note={`${plural(data.rejected.count, "entry", "entries")}, not counted`}
        />
      </div>

      {shared && (
        <SectionCard
          icon="store"
          tone="violet"
          title="Recorded for the whole restaurant"
          description="Rent, power and other costs that belong to no single outlet, and this outlet's share of them."
          flush
        >
          <p className="small report-pad report-lede">
            {money(shared.total, currency)} of approved expenses belong to no single outlet. They are shared by
            sales, month by month:{" "}
            {shared.wholeRevenue > 0
              ? `${data.outletName} made ${shared.salesPercent}% of the restaurant's sales and carries `
              : `the restaurant made no sales in this period, so they are shared as noted below — ${data.outletName} carries `}
            <strong>{money(shared.share, currency)}</strong> of them ({shared.percent}%). The profit &amp; loss
            charges it the same way.
          </p>
          {shared.categories.length === 0 ? (
            <p className="muted small report-pad">None in this period.</p>
          ) : (
            <DataGrid
              id="report-expenses-shared"
              caption="Expenses recorded for the whole restaurant, by category"
              columns={sharedColumns}
              rows={shared.categories}
              rowKey={(row) => row.categoryName}
              exportName="expenses-shared"
              currency={currency}
              rowNoun={["category", "categories"]}
            />
          )}
          {((shared.notes || []).length > 0 ||
            (shared.unassigned && shared.unassigned.costs !== 0) ||
            shared.pending.count > 0) && (
            <div className="report-card-foot stack-sm">
              {(shared.notes || []).map((note) => (
                <p key={note} className="muted small">
                  {note}
                </p>
              ))}
              {shared.unassigned && shared.unassigned.costs !== 0 && (
                <p className="muted small">
                  {money(shared.unassigned.costs, currency)} of them go with the{" "}
                  {money(shared.unassigned.revenue, currency)} of sales ({shared.unassigned.percent}%) taken at the main
                  counter, which is not an outlet.
                </p>
              )}
              {shared.pending.count > 0 && (
                <p className="muted small">
                  {count(shared.pending.count)} more ({money(shared.pending.amount, currency)}) for the whole restaurant{" "}
                  {shared.pending.count === 1 ? "is" : "are"} waiting for approval.
                </p>
              )}
            </div>
          )}
        </SectionCard>
      )}

      {data.categories.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="wallet"
            message={shared ? `No expenses were recorded for ${data.outletName} alone.` : "No approved expenses in this period."}
            hint={
              shared
                ? "Its share of the restaurant-wide expenses is above."
                : "Rent, power, gas, repairs and the rest recorded in Expenses appear here once approved."
            }
          />
        </div>
      ) : (
        <>
          <div className="two-column report-pair">
            <SectionCard
              icon="pie"
              title="By category"
              description={`${plural(data.categories.length, "category", "categories")}, with each one's share.`}
            >
              <BarList
                rows={data.categories.map((row) => ({
                  label: row.categoryName,
                  value: row.amount,
                  sub: `${row.share}%`,
                }))}
                currency={currency}
              />
            </SectionCard>

            <SectionCard icon="card" tone="info" title="Paid by" description="How the approved expenses were paid.">
              <BarList
                rows={data.byMode.map((row) => ({
                  label: paymentMethodLabel(row.paymentMode),
                  value: row.amount,
                }))}
                currency={currency}
              />
            </SectionCard>
          </div>

          <SectionCard
            icon="calendar"
            tone="neutral"
            title={`Category by ${showMonths ? "month" : "amount"}`}
            description={showMonths ? "Each category across the months of the range." : "Each category, with its share of the total."}
            flush
          >
            {/* The category column stays in view while the months scroll
                sideways; the totals line adds every category on show. */}
            <DataGrid
              id="report-expense-categories"
              caption={`Expenses, category by ${showMonths ? "month" : "amount"}`}
              columns={categoryColumns}
              rows={data.categories}
              rowKey={(row) => row.categoryName}
              exportName="expenses-by-category"
              currency={currency}
              rowNoun={["category", "categories"]}
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}
