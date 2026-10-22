import { useMemo } from "react";
import { BarList } from "../../../../components/Charts";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState } from "../../../../components/Feedback";
import SectionCard from "../../../../components/SectionCard";
import { count, money } from "@bmp/shared/format";
import { plural } from "./reportFormat";

// Two different questions about staff, answered side by side.
//
//   Captains and waiters: who took the orders — what they sold, how many
//   guests they looked after, what each guest spent, and what was taken off
//   their orders after the kitchen had it. This is the one that decides
//   incentives and shows who sells and who only carries plates.
//
//   Cashiers: who raised the bills. At most restaurants that is one or two
//   people at the counter, which is why it could never answer the first.

export default function StaffReport({ data, currency }) {
  const waiters = data.waiters.rows;
  // The busiest sellers for the chart above the table: the first eight by
  // net sales, the table's opening order.
  const topSellers = [...waiters]
    .filter((row) => row.netSales > 0)
    .sort((x, y) => y.netSales - x.netSales)
    .slice(0, 8);

  // Report columns are built once per report: a chain can have many staff.
  // No totals line: the old tables had none (the figure above gives the sum).
  const waiterColumns = useMemo(
    () => [
      { key: "name", header: "Taken by", mobile: "title", filter: "text", value: (row) => row.userName, className: "report-strong" },
      { key: "orders", header: "Orders", type: "number", mobile: "show", value: (row) => row.orderCount },
      { key: "covers", header: "Covers", type: "number", value: (row) => row.covers || null },
      { key: "perHead", header: "Per head", type: "money", mobile: "show", value: (row) => row.perHead || null },
      { key: "plates", header: "Plates", type: "number", value: (row) => row.plates },
      {
        key: "sales",
        header: "Net sales",
        type: "money",
        mobile: "show",
        value: (row) => row.netSales,
        render: (row) => (
          <>
            <strong>{money(row.netSales, currency)}</strong>
            <div className="muted small">
              {row.orderCount > 0 ? `${money(row.averageOrder, currency)} an order` : "nothing billed"}
            </div>
          </>
        ),
      },
      {
        key: "split",
        header: "Dine-in / takeaway / delivery",
        label: "Dine-in / takeaway / delivery",
        align: "right",
        sortable: false,
        mobile: "show",
        value: (row) => `${row.dineInSales} / ${row.takeawaySales} / ${row.deliverySales}`,
        render: (row) => (
          <span className="small nowrap">
            {money(row.dineInSales, currency)} / {money(row.takeawaySales, currency)} /{" "}
            {money(row.deliverySales, currency)}
          </span>
        ),
      },
      {
        key: "removed",
        header: "Off after KOT",
        type: "number",
        mobile: "show",
        value: (row) => row.removedAfterKot || null,
        render: (row) => (
          <>
            {row.removedAfterKot ? (
              <>
                <span className="text-danger">{count(row.removedAfterKot)}</span>
                <div className="muted small">{money(row.removedValue, currency)}</div>
              </>
            ) : (
              "—"
            )}
            {row.removedWithVoid > 0 && <div className="muted small">+{count(row.removedWithVoid)} with a void</div>}
          </>
        ),
      },
    ],
    [currency]
  );

  // Dine-in sales by captain section (Floor → Captain sections): each bill
  // under the captain who held its table on its business day.
  const sections = data.waiters.sections || [];
  const sectionColumns = useMemo(
    () => [
      {
        key: "captain",
        header: "Captain",
        mobile: "title",
        className: "report-strong",
        value: (row) => row.captainName || "No captain set",
        render: (row) => row.captainName || <span className="muted">No captain set</span>,
      },
      { key: "sections", header: "Section", mobile: "subtitle", value: (row) => row.sections || "" },
      { key: "tables", header: "Tables", type: "number", value: (row) => row.tableCount },
      { key: "orders", header: "Orders", type: "number", mobile: "show", value: (row) => row.orderCount, total: "sum" },
      { key: "guests", header: "Covers", type: "number", value: (row) => row.guests, total: "sum" },
      { key: "perHead", header: "Per head", type: "money", mobile: "show", value: (row) => row.perHead || null },
      { key: "sales", header: "Dine-in sales", type: "money", mobile: "show", value: (row) => row.netSales, total: "sum" },
    ],
    []
  );

  const cashierColumns = useMemo(
    () => [
      { key: "name", header: "Billed by", mobile: "title", filter: "text", value: (row) => row.userName, className: "report-strong" },
      { key: "bills", header: "Bills", type: "number", mobile: "show", value: (row) => row.billCount },
      { key: "sales", header: "Net sales", type: "money", mobile: "show", value: (row) => row.netSales },
      { key: "average", header: "Average bill", type: "money", mobile: "show", value: (row) => row.averageBill },
    ],
    []
  );

  return (
    <div className="stack">
      {waiters.length > 0 && topSellers.length > 0 && (
        <SectionCard
          icon="star"
          tone="success"
          title="Sales by person"
          description={`${money(data.waiters.totals.netSales, currency)} across ${plural(waiters.length, "person", "people")} · the first eight by net sales`}
        >
          <BarList
            rows={topSellers.map((row) => ({
              label: row.userName,
              value: row.netSales,
              sub: plural(row.orderCount, "order", "orders"),
            }))}
            currency={currency}
          />
        </SectionCard>
      )}

      <SectionCard
        icon="users"
        title="Captains & waiters"
        description="Credited to whoever took the order. Per head is dine-in spend divided by the guests at their tables."
        flush
      >
        {waiters.length === 0 ? (
          <EmptyState
            icon="users"
            message="No orders were billed in this period."
            hint="Each order counts for the person who took it, once its bill is raised."
          />
        ) : (
          <>
            <DataGrid
              id="report-staff-waiters"
              caption="Captains and waiters"
              columns={waiterColumns}
              rows={waiters}
              rowKey={(row) => `${row.userId || "none"}-${row.userName}`}
              defaultSort={{ key: "sales", direction: "desc" }}
              exportName="staff-captains-waiters"
              currency={currency}
              rowNoun={["person", "people"]}
            />
            {data.waiters.totals.removedWithVoid > 0 && (
              <p className="muted small report-card-foot">
                &ldquo;Off after KOT&rdquo; counts dishes taken off a live order. The{" "}
                {plural(data.waiters.totals.removedWithVoid, "dish", "dishes")} marked &ldquo;with a void&rdquo; only
                closed out a bill that had already been voided. The void counts that money, and Theft control lists{" "}
                {data.waiters.totals.removedWithVoid === 1 ? "that dish" : "those dishes"} with it.
              </p>
            )}
          </>
        )}
      </SectionCard>

      <SectionCard
        icon="table"
        tone="violet"
        title="By captain section"
        description="Dine-in bills under the captain who had the table that day (Tables → Captain sections). Tables nobody was given are under No captain set."
        flush
      >
        <DataGrid
          id="report-staff-sections"
          caption="Dine-in sales by captain section"
          columns={sectionColumns}
          rows={sections}
          rowKey={(row) => row.captainId || "none"}
          defaultSort={{ key: "sales", direction: "desc" }}
          empty="No dine-in bills in this period."
          emptyIcon="table"
          exportName="staff-captain-sections"
          currency={currency}
          rowNoun={["captain", "captains"]}
        />
      </SectionCard>

      <SectionCard icon="receipt" tone="info" title="Cashiers" description="Who raised the bills." flush>
        {data.rows.length === 0 ? (
          <EmptyState icon="receipt" message="No bills were raised in this period." />
        ) : (
          <DataGrid
            id="report-staff-cashiers"
            caption="Cashiers: who raised the bills"
            columns={cashierColumns}
            rows={data.rows}
            rowKey={(row) => row.userName}
            exportName="staff-cashiers"
            currency={currency}
            rowNoun={["person", "people"]}
          />
        )}
      </SectionCard>
    </div>
  );
}
