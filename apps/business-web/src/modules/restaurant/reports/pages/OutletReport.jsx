// Outlet comparison tab of the Reports screen.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import { BarList } from "../../../../components/Charts";
import { EmptyState } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { money } from "@bmp/shared/format";
import { plural } from "./reportFormat";

// Outlet against outlet. Always the whole chain, whichever outlet the top
// bar is on: a comparison of one outlet with itself answers nothing.
//
// Bills raised with no outlet are shown under their own honest label rather
// than quietly dropped — a report whose rows do not add up to the sales
// summary is worse than no report.
export default function OutletReport({ data, currency }) {
  const named = data.outlets.filter((row) => row.outletId !== null);
  const untagged = data.outlets.find((row) => row.outletId === null);
  const columns = useMemo(
    () => [
      {
        key: "outlet",
        header: "Outlet",
        value: (row) => row.outletName,
        mobile: "title",
        className: "report-strong",
        render: (row) => (
          <>
            {row.outletName}
            {row.outletCode && <span className="muted small mono"> {row.outletCode}</span>}
          </>
        ),
      },
      { key: "bills", header: "Bills", type: "number", value: (row) => row.billCount, total: "sum", mobile: "show" },
      { key: "guests", header: "Covers", type: "number", value: (row) => row.guests, total: "sum" },
      { key: "perHead", header: "Per head", type: "money", value: (row) => row.perHead || null },
      {
        key: "sales",
        header: "Net sales",
        type: "money",
        value: (row) => row.netSales,
        render: (row) => <strong>{money(row.netSales, currency)}</strong>,
        total: "sum",
        mobile: "show",
      },
      { key: "share", header: "Share", type: "percent", value: (row) => row.share, mobile: "show" },
      { key: "tax", header: "Tax", type: "money", value: (row) => row.tax, total: "sum" },
      { key: "discounts", header: "Discounts", type: "money", value: (row) => row.discounts, total: "sum" },
      { key: "average", header: "Average bill", type: "money", value: (row) => row.averageBill, mobile: "show" },
    ],
    [currency]
  );

  if (data.outlets.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon="store"
          message="Nothing was billed in this period."
          hint="Pick a range the restaurant traded in, and every outlet lines up here."
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="report-scope tone-info">
        <Icon name="info" size={16} />
        <span>This comparison always shows every outlet, whichever one is picked at the top.</span>
      </p>

      {named.length <= 1 && (
        <p className="report-scope tone-neutral">
          <Icon name="store" size={16} />
          <span>
            {named.length === 1
              ? "One outlet is recording sales, so there is nothing to compare it against yet."
              : "No sales are tagged to an outlet yet."}{" "}
            <Link to="/restaurant/outlets">Set up outlets</Link> and the branches will line up here.
          </span>
        </p>
      )}

      {untagged && untagged.share > 0 && named.length > 0 && (
        <p className="report-scope tone-neutral">
          <Icon name="store" size={16} />
          <span>
            <strong>Main counter</strong> is the restaurant&apos;s own counter (sales taken with no outlet picked):{" "}
            {untagged.share}% of sales in this period.
          </span>
        </p>
      )}

      <SectionCard
        icon="pie"
        title="Share of sales"
        description={`${money(data.total, currency)} across the chain`}
      >
        <BarList
          rows={data.outlets.map((row) => ({
            label: row.outletName,
            value: row.netSales,
            sub: `${row.share}% · ${plural(row.billCount, "bill", "bills")}`,
          }))}
          currency={currency}
        />
      </SectionCard>

      <SectionCard icon="store" tone="neutral" title="Outlet by outlet" description="Sort by any column." flush>
        <DataGrid
          id="report-outlets"
          caption="Outlet by outlet"
          columns={columns}
          rows={data.outlets}
          rowKey={(row) => row.outletId ?? "none"}
          defaultSort={{ key: "sales", direction: "desc" }}
          exportName="outlet-comparison"
          currency={currency}
          rowNoun={["outlet", "outlets"]}
        />
      </SectionCard>
    </div>
  );
}
