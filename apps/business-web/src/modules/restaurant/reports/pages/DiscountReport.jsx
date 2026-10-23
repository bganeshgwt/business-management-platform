// Discounts tab of the Reports screen.

import { useMemo } from "react";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { EmptyState } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { money } from "@bmp/shared/format";
import { DISCOUNT_KINDS } from "./reportCsv";

// Everything taken off bills, by what took it off: coupons by code, what
// staff gave at the till (by reason), no-charge bills — and, apart from them,
// points guests paid with, which are the guest's own money and not a
// discount anyone gave.
const DISCOUNT_TONES = { coupon: "badge-info", till: "badge-warning", points: "badge-active", complimentary: "badge-primary" };

export default function DiscountReport({ data, currency }) {
  const rows = data.rows || [];
  const totals = data.totals || {};
  const columns = useMemo(
    () => [
      {
        key: "kind",
        header: "Kind",
        type: "status",
        value: (row) => DISCOUNT_KINDS[row.kind] || "Discount",
        render: (row) => (
          <span className={`badge ${DISCOUNT_TONES[row.kind] || "badge-neutral"}`}>{DISCOUNT_KINDS[row.kind] || "Discount"}</span>
        ),
        filter: "select",
        mobile: "subtitle",
      },
      {
        key: "discount",
        header: "Discount",
        value: (row) => (row.kind === "coupon" ? row.discountCode : row.label),
        mobile: "title",
        render: (row) => (
          <span className={row.kind === "coupon" ? "mono" : ""}>
            {row.kind === "coupon" ? row.discountCode : row.label}
            {row.kind === "points" && row.points ? <span className="muted small"> · {row.points} points</span> : null}
          </span>
        ),
      },
      { key: "bills", header: "Bills", type: "number", value: (row) => row.timesUsed, total: "sum", mobile: "show" },
      { key: "taken", header: "Taken off", type: "money", value: (row) => row.discountTotal, total: "sum", mobile: "show" },
      { key: "sales", header: "Sales on those bills", type: "money", value: (row) => row.netSales, mobile: "show" },
    ],
    []
  );

  if (rows.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon="percent"
          message="No discounts were given in this period."
          hint="Coupons, discounts given at the till, no-charge bills and points redeemed are listed here."
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatTile
          size="sm"
          icon="percent"
          tone="warning"
          label="Given by staff and offers"
          value={money(totals.given, currency)}
          note="Coupons, till discounts and no-charge bills"
        />
        <StatTile
          size="sm"
          icon="gift"
          tone="success"
          label="Points redeemed"
          value={money(totals.points, currency)}
          note="Guests paying with their own points"
        />
      </div>
      <SectionCard
        icon="percent"
        title="What was taken off bills"
        description="A bill with a coupon and points is under both. Sales are the whole bills each was on."
        flush
      >
        <DataGrid
          id="report-discounts"
          caption="What was taken off bills"
          columns={columns}
          rows={rows}
          rowKey={(row, index) => `${row.kind}-${row.discountCode}-${row.reason || ""}-${index}`}
          defaultSort={{ key: "taken", direction: "desc" }}
          exportName="discounts"
          currency={currency}
          rowNoun={["discount", "discounts"]}
        />
      </SectionCard>
    </div>
  );
}
