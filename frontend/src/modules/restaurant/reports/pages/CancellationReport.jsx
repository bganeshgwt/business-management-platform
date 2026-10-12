// Cancellations tab of the Reports screen.

import { useMemo, useState } from "react";
import { getCancellationReport } from "../services/report.service";
import { getErrorMessage } from "../../../../services/api";
import { ErrorMessage } from "../../../../components/Feedback";
import { orderTypeLabel } from "../../../../services/labels";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import TruncationNotice from "../../../../components/TruncationNotice";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { count, money } from "../../../../services/format";
import { clockTime, dayAndDate } from "./reportFormat";

const byWho = (row) => (
  <span className="small">
    {row.byName || "—"}
    {row.approvedBy && <div className="muted">approved by {row.approvedBy}</div>}
  </span>
);

// Cancelled orders and voided bills, filed under the business day they belong
// to — a void at 00:40 on a night still trading is that night's — with who
// did it and who approved it, from the activity log.
export default function CancellationReport({ data: first, currency }) {
  // The first page of each list comes with the report; the next ones are
  // asked for here, one list at a time ("26–50 of 2,319"). The Reports page
  // gives this a new key for each range, so a new range starts on page 1.
  const [voided, setVoided] = useState({ rows: first.voidedBills, page: 1, pageSize: first.paging?.pageSize || 25 });
  const [cancelled, setCancelled] = useState({ rows: first.cancelledOrders, page: 1, pageSize: first.paging?.pageSize || 25 });
  const [pageError, setPageError] = useState("");
  const data = first;

  const range = { from: first.from, to: first.to, outletId: first.outletClosed ? first.outletId : undefined };
  const turn = (which) => async ({ page, pageSize }) => {
    setPageError("");

    try {
      const result = await getCancellationReport(
        which === "void" ? { ...range, voidPage: page, pageSize } : { ...range, cancelPage: page, pageSize }
      );

      if (which === "void") {
        setVoided({ rows: result.voidedBills, page, pageSize });
      } else {
        setCancelled({ rows: result.cancelledOrders, page, pageSize });
      }
    } catch (err) {
      setPageError(getErrorMessage(err));
    }
  };
  const paged = Boolean(first.paging);
  const voidColumns = useMemo(
    () => [
      {
        key: "bill",
        header: "Bill",
        value: (row) => row.billNumber,
        mobile: "title",
        render: (row) => (
          <span className="nowrap">
            <span className="mono">{row.billNumber}</span>
            <div className="muted small">{dayAndDate(row.businessDate)}</div>
          </span>
        ),
      },
      { key: "order", header: "Order", value: (row) => row.orderNumber, className: "mono small nowrap" },
      { key: "amount", header: "Value", type: "money", value: (row) => row.amount, total: "sum", mobile: "show" },
      { key: "reason", header: "Reason", value: (row) => row.reason || "", mobile: "show" },
      { key: "by", header: "Voided by", value: (row) => row.byName || "", render: byWho, filter: "select", mobile: "show" },
      {
        key: "at",
        header: "When",
        type: "datetime",
        value: (row) => row.voidedAt,
        render: (row) => <span className="small nowrap">{clockTime(row.voidedAt, data.timezone)}</span>,
        mobile: "subtitle",
      },
    ],
    [data.timezone]
  );
  const cancelColumns = useMemo(
    () => [
      {
        key: "order",
        header: "Order",
        value: (row) => row.orderNumber,
        mobile: "title",
        render: (row) => (
          <span className="nowrap">
            <span className="mono">{row.orderNumber}</span>
            <div className="muted small">{dayAndDate(row.businessDate)}</div>
          </span>
        ),
      },
      { key: "type", header: "Type", value: (row) => orderTypeLabel(row.orderType), filter: "select", mobile: "show" },
      { key: "amount", header: "Value", type: "money", value: (row) => row.amount, total: "sum", mobile: "show" },
      { key: "reason", header: "Reason", value: (row) => row.reason || "", mobile: "show" },
      { key: "by", header: "Cancelled by", value: (row) => row.byName || "", render: byWho, filter: "select", mobile: "show" },
      {
        key: "at",
        header: "When",
        type: "datetime",
        value: (row) => row.cancelledAt,
        render: (row) => <span className="small nowrap">{clockTime(row.cancelledAt, data.timezone)}</span>,
        mobile: "subtitle",
      },
    ],
    [data.timezone]
  );

  return (
    <div className="stack">
      <ErrorMessage message={pageError} />
      <div className="stat-grid">
        <StatTile
          icon="x-circle"
          tone="danger"
          label="Bills voided"
          value={count(data.voidedTotals.count)}
          note={money(data.voidedTotals.value, currency)}
        />
        <StatTile
          icon="ban"
          tone="warning"
          label="Orders cancelled"
          value={count(data.cancelledTotals.count)}
          note={money(data.cancelledTotals.value, currency)}
        />
      </div>

      <SectionCard
        icon="receipt"
        tone="danger"
        title={`Voided bills (${count(data.voidedTotals.count)})`}
        description="Bills cancelled after they were raised, with the reason given."
        flush
      >
        {!paged && (
          <TruncationNotice shown={data.voidedTotals.shown} total={data.voidedTotals.count} what="voided bills" hint="Pick a shorter range to list them all; the counts above include every one." />
        )}
        <DataGrid
          id="report-voided-bills"
          caption="Voided bills"
          columns={voidColumns}
          rows={paged ? voided.rows : data.voidedBills}
          server={
            paged
              ? { total: data.voidedTotals.count, page: voided.page, pageSize: voided.pageSize, onChange: turn("void") }
              : undefined
          }
          rowKey={(row) => row.billNumber}
          empty="No bills were voided."
          emptyHint="Nothing to look into here."
          emptyIcon="check-circle"
          defaultSort={{ key: "at", direction: "desc" }}
          exportName="voided-bills"
          currency={currency}
          rowNoun={["bill", "bills"]}
        />
      </SectionCard>

      <SectionCard
        icon="ban"
        tone="warning"
        title={`Cancelled orders (${count(data.cancelledTotals.count)})`}
        description="Orders cancelled, with the reason given."
        flush
      >
        {!paged && (
          <TruncationNotice shown={data.cancelledTotals.shown} total={data.cancelledTotals.count} what="cancelled orders" hint="Pick a shorter range to list them all; the counts above include every one." />
        )}
        <DataGrid
          id="report-cancelled-orders"
          caption="Cancelled orders"
          columns={cancelColumns}
          rows={paged ? cancelled.rows : data.cancelledOrders}
          server={
            paged
              ? { total: data.cancelledTotals.count, page: cancelled.page, pageSize: cancelled.pageSize, onChange: turn("cancel") }
              : undefined
          }
          rowKey={(row) => row.orderNumber}
          empty="No orders were cancelled."
          emptyHint="Nothing to look into here."
          emptyIcon="check-circle"
          defaultSort={{ key: "at", direction: "desc" }}
          exportName="cancelled-orders"
          currency={currency}
          rowNoun={["order", "orders"]}
        />
      </SectionCard>
    </div>
  );
}
