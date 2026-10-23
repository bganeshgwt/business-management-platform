// The deliveries report.

import { useEffect, useState } from "react";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { BarList } from "../../../../components/Charts";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { getErrorMessage } from "../../../../services/api";
import { count, money, moneyExact } from "@bmp/shared/format";
import { downloadCsv } from "../../../../services/csv";
import { getChannelReport } from "../services/delivery.service";
import { TYPE_LABEL, duration, initials, longDate, rupees } from "./deliveryFormat";

// ---------------------------------------------------------------- report

export default function ReportTab() {
  const [from, setFrom] = useQueryFilter("from");
  const [to, setTo] = useQueryFilter("to");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getChannelReport({ from: from || undefined, to: to || undefined })
      .then((data) => {
        setReport(data);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [from, to]);

  if (!report && !error) {
    return <Loading label="Adding up the channels…" />;
  }

  if (!report) {
    return <ErrorMessage message={error} />;
  }

  const currency = report.currency;
  const totals = report.totals;
  const channelRows = report.rows.filter((row) => row.kind !== "order_type");
  const commissionShare = totals.gross > 0 ? Math.round((totals.commission / totals.gross) * 1000) / 10 : 0;
  const deliveryGross = channelRows.reduce((sum, row) => sum + row.gross, 0);
  const aggregatorRows = report.rows.filter((row) => row.commission > 0);

  const exportCsv = () => {
    const header = [
      "Channel",
      "Kind",
      "Orders",
      "Bills",
      "Bill total (gross)",
      "Commission %",
      "Commission",
      "Net",
      "Average order",
      "Share %",
      "Delivered",
      "Avg door to door (min)",
      "On time %",
    ];
    const lines = report.rows.map((row) => [
      row.label,
      row.kind === "order_type" ? "Order type" : row.kind === "untagged" ? "Delivery (no channel)" : TYPE_LABEL[row.channelType] || "",
      row.orders,
      row.bills,
      row.gross.toFixed(2),
      row.effectiveRate ?? row.ratePercent ?? 0,
      row.commission.toFixed(2),
      row.net.toFixed(2),
      row.averageOrderValue.toFixed(2),
      row.share,
      row.delivery ? row.delivery.delivered : "",
      row.delivery && row.delivery.avgDoorMinutes !== null ? row.delivery.avgDoorMinutes : "",
      row.delivery && row.delivery.onTimeRate !== null ? row.delivery.onTimeRate : "",
    ]);

    downloadCsv(
      [
        header,
        ...lines,
        ["Total", "", totals.orders, totals.bills, totals.gross.toFixed(2), commissionShare, totals.commission.toFixed(2), totals.net.toFixed(2), totals.averageOrderValue.toFixed(2), 100, "", "", ""],
      ],
      `channel-report-${report.from}-to-${report.to}.csv`
    );
  };

  const channelColumns = [
    {
      key: "channel",
      header: "Channel",
      value: (row) => row.label,
      mobile: "title",
      render: (row) => (
        <span>
          <span className={`dlv-channel sw-${row.kind === "channel" ? row.color : "none"}`}>
            {row.kind === "channel" && <i aria-hidden="true" />}
            {row.label}
          </span>
          {row.kind === "channel" && !row.active && <span className="tag">switched off</span>}
          {row.kind === "untagged" && (
            <span className="dlv-row-hint">
              {row.delivery && row.delivery.orders > 0
                ? `${count(row.delivery.orders)} placed with no channel${row.orders === 0 ? ", none billed yet" : ""} — set it on the board`
                : "Set their channel on the board"}
            </span>
          )}
        </span>
      ),
    },
    { key: "orders", header: "Orders", type: "number", value: (row) => row.orders, mobile: "show" },
    { key: "gross", header: "Bill total", type: "money", exact: true, value: (row) => row.gross, mobile: "show" },
    {
      key: "rate",
      header: "Rate",
      type: "percent",
      value: (row) => (row.kind === "order_type" ? null : row.effectiveRate ?? row.ratePercent),
    },
    { key: "commission", header: "Commission", type: "money", exact: true, value: (row) => (row.commission > 0 ? row.commission : null) },
    {
      key: "net",
      header: "Net",
      type: "money",
      exact: true,
      value: (row) => row.net,
      mobile: "show",
      render: (row) => <b>{moneyExact(row.net, currency)}</b>,
    },
    { key: "avg", header: "Avg order", type: "money", value: (row) => (row.orders > 0 ? row.averageOrderValue : null) },
    { key: "share", header: "Share", type: "percent", value: (row) => row.share },
    {
      key: "time",
      header: "Avg time",
      type: "number",
      value: (row) => (row.delivery ? row.delivery.avgDoorMinutes : null),
      render: (row) => (row.delivery && row.delivery.avgDoorMinutes !== null ? duration(row.delivery.avgDoorMinutes) : "—"),
    },
    {
      key: "ontime",
      header: "On time",
      type: "percent",
      value: (row) => (row.delivery ? row.delivery.onTimeRate : null),
      render: (row) =>
        row.delivery && row.delivery.onTimeRate !== null ? (
          <span className={`dlv-ontime ${row.delivery.onTimeRate >= 85 ? "is-ok" : row.delivery.onTimeRate >= 70 ? "is-warn" : "is-late"}`}>
            {row.delivery.onTimeRate}%
          </span>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div className="stack">
      <div className="card dlv-report-filters">
        <div className="filters">
          <DateRangeFilter
            from={report.from}
            to={report.to}
            anchor={report.businessDate}
            label="report range"
            onChange={(range) => {
              setFrom(range.from);
              setTo(range.to);
            }}
          />
          <button type="button" className="button button-secondary dlv-export" onClick={exportCsv}>
            <Icon name="download" size={16} /> Export CSV
          </button>
        </div>
        <p className="muted small">
          Money is each bill's total as the guest paid it (after discounts, with tax), dated by business day, void
          bills left out — the same bills, and the same figure, as Net sales on the Sales report.
        </p>
      </div>

      {error && <ErrorMessage message={error} />}

      {/* Headline tiles in whole rupees, so a figure never breaks across two
          lines; the table below carries every paisa. */}
      <div className="stat-grid dlv-stats dlv-report-tiles">
        <StatTile
          icon="receipt"
          tone="primary"
          label="Bill totals"
          value={rupees(totals.gross, currency)}
          note={`${count(totals.bills)} bills · ${rupees(deliveryGross, currency)} from delivery channels`}
        />
        <StatTile
          icon="percent"
          tone={totals.commission > 0 ? "warning" : "neutral"}
          label="Commission paid"
          value={rupees(totals.commission, currency)}
          note={
            deliveryGross > 0
              ? `${Math.round((totals.commission / deliveryGross) * 1000) / 10}% of channel sales · ${commissionShare}% of all sales`
              : "nothing sold through a channel"
          }
        />
        <StatTile
          icon="wallet"
          tone="success"
          label="Net to you"
          value={rupees(totals.net, currency)}
          note="bill totals less channel commission"
        />
        <StatTile
          icon="tag"
          tone="info"
          label="Average order"
          value={rupees(totals.averageOrderValue, currency)}
          note={`${count(totals.orders)} orders`}
        />
        <StatTile
          icon="timer"
          tone={
            report.delivery.onTimeRate === null
              ? "neutral"
              : report.delivery.onTimeRate >= 85
                ? "success"
                : report.delivery.onTimeRate >= 70
                  ? "warning"
                  : "danger"
          }
          label="Deliveries on time"
          value={report.delivery.onTimeRate === null ? "—" : `${report.delivery.onTimeRate}%`}
          note={
            report.delivery.avgDoorMinutes !== null
              ? `avg ${duration(report.delivery.avgDoorMinutes)} door to door · ${report.delivery.delivered} delivered`
              : `${report.delivery.delivered} delivered · none timed`
          }
        />
      </div>

      <div className={`dlv-reconcile ${report.reconciliation.matches ? "is-ok" : "is-off"}`} role="status">
        <Icon name={report.reconciliation.matches ? "check" : "alert"} size={16} />
        {report.reconciliation.matches ? (
          <span>
            <b>Reconciles with Bills.</b> {moneyExact(report.reconciliation.gross, currency)} across{" "}
            {count(report.reconciliation.bills)} bills from {longDate(report.from)} to {longDate(report.to)} — it
            matches <b>Net sales</b> on the Sales report for the same days.
          </span>
        ) : (
          <span>
            <b>Does not reconcile.</b> The channels add up to {moneyExact(totals.gross, currency)} but the bills
            total {moneyExact(report.reconciliation.gross, currency)} (difference{" "}
            {moneyExact(report.reconciliation.difference, currency)}).
          </span>
        )}
      </div>

      <div className="dlv-report-charts">
        <SectionCard icon="pie" title="Where the money came from" description="Bill totals, by channel.">
          <BarList
            currency={currency}
            rows={report.rows
              .filter((row) => row.gross > 0)
              .map((row) => ({ label: row.label, value: row.gross, sub: `${row.share}%` }))}
          />
        </SectionCard>

        <SectionCard
          icon="percent"
          tone="warning"
          title="What the channels kept"
          description="Commission, by channel."
        >
          {aggregatorRows.length === 0 ? (
            <p className="muted small">No commission in this range — every sale was yours to keep.</p>
          ) : (
            <BarList
              currency={currency}
              rows={aggregatorRows.map((row) => ({
                label: row.label,
                value: row.commission,
                sub: `${row.effectiveRate ?? row.ratePercent}%`,
              }))}
            />
          )}
        </SectionCard>
      </div>

      <SectionCard
        icon="list"
        title="By channel"
        description={`${longDate(report.from)} – ${longDate(report.to)}`}
        flush
      >
        <DataGrid
          id="delivery-channel-report"
          caption="Sales by channel"
          rows={report.rows}
          rowKey={(row) => row.key}
          currency={currency}
          pageSize={false}
          rowNoun={["channel", "channels"]}
          rowClassName={(row) => (row.kind === "order_type" ? "dg-tone-muted" : "")}
          columns={channelColumns}
          footer={(ctx) => {
            const cell = {
              channel: "Total",
              orders: count(totals.orders),
              gross: moneyExact(totals.gross, currency),
              rate: `${commissionShare}%`,
              commission: moneyExact(totals.commission, currency),
              net: moneyExact(totals.net, currency),
              avg: money(totals.averageOrderValue, currency),
              share: "100%",
              time: report.delivery.avgDoorMinutes !== null ? duration(report.delivery.avgDoorMinutes) : "—",
              ontime: report.delivery.onTimeRate === null ? "—" : `${report.delivery.onTimeRate}%`,
            };

            if (ctx.cards) {
              return (
                <div className="dlv-report-total">
                  <strong>Total</strong>
                  <span>
                    {cell.orders} orders · {cell.gross} billed · {cell.commission} commission · <b>{cell.net} net</b>
                  </span>
                </div>
              );
            }

            return (
              <tr className="dlv-report-total-row">
                {Array.from({ length: ctx.leading }, (_, at) => (
                  <td key={`lead-${at}`} />
                ))}
                {ctx.columns.map((column) => (
                  <td key={column.key} className={column.key === "channel" ? "" : "right nowrap"}>
                    <b>{cell[column.key] ?? ""}</b>
                  </td>
                ))}
              </tr>
            );
          }}
        />
      </SectionCard>

      <SectionCard
        icon="users"
        tone="info"
        title="Riders"
        description={`On time means at the door within ${report.slaMinutes} min of ordering.`}
        flush
      >
        {report.riders.length === 0 ? (
          <EmptyState
            icon="scooter"
            message="No deliveries with a rider in this range"
            hint="Riders appear here once they have taken an order out."
          />
        ) : (
          <DataGrid
            id="delivery-rider-report"
            caption="Riders"
            rows={report.riders}
            rowKey={(rider) => rider.riderId || "partner"}
            pageSize={false}
            exportName={`rider-report-${report.from}-to-${report.to}`}
            rowNoun={["rider", "riders"]}
            columns={[
              {
                key: "rider",
                header: "Rider",
                value: (rider) => rider.name,
                mobile: "title",
                render: (rider) => (
                  <span className="dlv-rider-cell">
                    <span className={`dlv-avatar small ${rider.partner ? "is-partner" : ""}`} aria-hidden="true">
                      {rider.partner ? <Icon name="scooter" size={13} /> : initials(rider.name)}
                    </span>
                    {rider.name}
                  </span>
                ),
              },
              { key: "delivered", header: "Delivered", type: "number", value: (rider) => rider.delivered, total: "sum", mobile: "show" },
              { key: "ride", header: "Avg ride", type: "number", value: (rider) => rider.avgRideMinutes, render: (rider) => duration(rider.avgRideMinutes) },
              {
                key: "door",
                header: "Avg door to door",
                type: "number",
                value: (rider) => rider.avgDoorMinutes,
                render: (rider) => duration(rider.avgDoorMinutes),
                mobile: "show",
              },
              {
                key: "ontime",
                header: "On time",
                type: "percent",
                value: (rider) => rider.onTimeRate,
                mobile: "show",
                render: (rider) =>
                  rider.onTimeRate === null ? (
                    "—"
                  ) : (
                    <span className={`dlv-ontime ${rider.onTimeRate >= 85 ? "is-ok" : rider.onTimeRate >= 70 ? "is-warn" : "is-late"}`}>
                      {rider.onTimeRate}%
                    </span>
                  ),
              },
              { key: "late", header: "Late", type: "number", value: (rider) => Math.max(0, rider.timed - rider.onTime), total: "sum" },
            ]}
          />
        )}
      </SectionCard>
    </div>
  );
}
