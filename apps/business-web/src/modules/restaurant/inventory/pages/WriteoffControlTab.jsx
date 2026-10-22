import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { getErrorMessage } from "../../../../services/api";
import { dayMonth } from "@bmp/shared/dates";
import { count, money } from "@bmp/shared/format";
import { getWriteoffControl } from "../services/inventoryInsight.service";
import { getStockSettings } from "../services/inventory.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { qty } from "./stockFormat";
import { Chip } from "./stockUi";
import "../../../../styles/backoffice-sweep.css";

// Who wrote off what (sweep SW-B-10, SW-B-22): the stock side of theft
// control. Waste is where stock leaves without a bill, so the owner sees, for
// a period, each person's waste at cost (items and whole dishes), every
// write-off over the limit with the manager who approved it, and the large
// purchase orders that were asked for, approved or sent back. Reversed waste
// is left out (the stock went back). For people who can read the activity log.

const OUTCOME = {
  asked: { label: "Asked for approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  sent_back: { label: "Sent back", tone: "danger" },
};

export default function WriteoffControlTab() {
  const [from, setFrom] = useQueryFilter("from");
  const [to, setTo] = useQueryFilter("to");
  const [data, setData] = useState(null);
  const [limits, setLimits] = useState(null);
  const [currency, setCurrency] = useState("₹");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getWriteoffControl({ from: from || undefined, to: to || undefined })
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => {
    getStockSettings()
      .then(setLimits)
      .catch(() => setLimits(null));
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);
  }, []);

  if (!data && !error) {
    return <Loading label="Adding up who wrote off what…" />;
  }

  if (!data) {
    return <ErrorMessage message={error} />;
  }

  const { summary } = data;
  const wasteLimit = limits ? limits.writeoffApprovalLimit : null;
  const poLimit = limits ? limits.poApprovalLimit : null;

  const personColumns = [
    { key: "name", header: "Person", value: (row) => row.userName, mobile: "title", pin: true, width: 240 },
    { key: "itemEntries", header: "Item entries", type: "number", value: (row) => row.items.entries, total: "sum", width: 130 },
    { key: "itemValue", header: "Items at cost", type: "money", value: (row) => row.items.value, total: "sum", mobile: "show", width: 150 },
    { key: "dishEntries", header: "Dishes", type: "number", value: (row) => row.dishes.entries, total: "sum", width: 110 },
    { key: "dishValue", header: "Dishes at cost", type: "money", value: (row) => row.dishes.value, total: "sum", mobile: "show", width: 150 },
    {
      key: "total",
      header: "Total written off",
      type: "money",
      width: 170,
      value: (row) => row.total,
      total: "sum",
      render: (row) => <strong>{money(row.total, currency)}</strong>,
      mobile: "show",
    },
    {
      key: "overLimit",
      header: "Over the limit",
      type: "number",
      width: 150,
      value: (row) => row.overLimit,
      render: (row) => (row.overLimit > 0 ? <Chip tone="warning">{count(row.overLimit)}</Chip> : <span className="muted">0</span>),
      total: "sum",
      mobile: "show",
    },
  ];

  const largeColumns = [
    {
      key: "at",
      header: "When",
      type: "datetime",
      value: (row) => row.at,
      render: (row) => <span className="nowrap">{dayMonth(row.at, { time: true })}</span>,
      mobile: "subtitle",
    },
    {
      key: "what",
      header: "What",
      value: (row) => row.what,
      mobile: "title",
      pin: true,
      render: (row) => (
        <span className="bo-cell-stack">
          <strong>{row.what}</strong>
          <span className="muted small">
            {[
              row.kind,
              row.quantity !== null && row.unit ? qty(row.quantity, row.unit) : null,
              row.store ? (/store$/i.test(row.store) ? row.store : `${row.store} store`) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      ),
    },
    { key: "value", header: "Value", type: "money", exact: true, value: (row) => row.value, total: "sum", mobile: "show" },
    { key: "limit", header: "Limit then", type: "money", value: (row) => row.limit, mobile: "hide" },
    { key: "loggedBy", header: "Logged by", value: (row) => row.loggedBy || "", mobile: "show" },
    {
      key: "approvedBy",
      header: "Approved by",
      value: (row) => row.approvedBy || "",
      render: (row) =>
        row.approvedBy ? (
          <span className="bo-cell-stack">
            <strong>{row.approvedBy}</strong>
            <span className="muted small">manager's PIN</span>
          </span>
        ) : (
          <span className="muted">own right</span>
        ),
      mobile: "show",
    },
  ];

  const orderColumns = [
    {
      key: "at",
      header: "When",
      type: "datetime",
      value: (row) => row.at,
      render: (row) => <span className="nowrap">{dayMonth(row.at, { time: true })}</span>,
      mobile: "subtitle",
    },
    {
      key: "po",
      header: "Order",
      value: (row) => row.poNumber,
      pin: true,
      mobile: "title",
      width: 120,
      render: (row) =>
        row.orderId ? (
          <Link className="mono nowrap" to={`/purchasing/orders?open=${row.orderId}`}>
            {row.poNumber}
          </Link>
        ) : (
          <span className="mono">{row.poNumber}</span>
        ),
    },
    { key: "supplier", header: "Supplier", value: (row) => row.supplier || "", mobile: "show", width: 180 },
    { key: "total", header: "Order total", type: "money", exact: true, value: (row) => row.total, mobile: "show", width: 140 },
    {
      key: "outcome",
      header: "What happened",
      type: "status",
      width: 190,
      value: (row) => (OUTCOME[row.outcome] || { label: row.outcome }).label,
      render: (row) => {
        const outcome = OUTCOME[row.outcome] || { label: row.outcome };
        return <Chip tone={outcome.tone}>{outcome.label}</Chip>;
      },
      filter: "select",
      mobile: "show",
    },
    {
      key: "by",
      header: "By",
      value: (row) => row.approvedBy || row.by || "",
      render: (row) => (
        <span className="bo-cell-stack">
          <span>{row.outcome === "approved" ? row.approvedBy || row.by : row.by}</span>
          {row.outcome === "approved" && row.approvedBy && row.approvedBy !== row.by && (
            <span className="muted small">PIN typed for {row.by}</span>
          )}
        </span>
      ),
    },
    { key: "note", header: "Note", value: (row) => row.note || "", render: (row) => row.note || <span className="muted">—</span> },
  ];

  return (
    <div className="stack">
      <div className="card ii-filter-card">
        <div className="filters">
          <DateRangeFilter
            from={data.from}
            to={data.to}
            label="write-off range"
            onChange={(range) => {
              setLoading(true);
              setFrom(range.from);
              setTo(range.to);
            }}
          />
        </div>
        <p className="muted small">
          {data.store ? `${data.store.name} store only. ` : ""}Waste logged by each person at cost, items and whole dishes;
          entries someone reversed are left out. Limits are set in{" "}
          <Link to="/inventory/settings">Stock → Stock & purchasing settings</Link>
          {wasteLimit !== null && wasteLimit !== undefined ? ` (write-offs over ${money(wasteLimit, currency)}` : " (no write-off limit set"}
          {poLimit !== null && poLimit !== undefined ? `, orders over ${money(poLimit, currency)})` : ", no order limit set)"}.
        </p>
      </div>

      <ErrorMessage message={error} />

      <div className="stat-grid">
        <StatTile
          icon="trash"
          tone="primary"
          label="Items wasted"
          value={money(summary.wastage.value, currency)}
          note={`${count(summary.wastage.entries)} entr${summary.wastage.entries === 1 ? "y" : "ies"}`}
        />
        <StatTile
          icon="utensils"
          tone="warning"
          label="Dishes written off"
          value={money(summary.dishes.value, currency)}
          note={`${count(summary.dishes.entries)} entr${summary.dishes.entries === 1 ? "y" : "ies"}`}
        />
        <StatTile
          icon="shield"
          tone={summary.largeWriteoffs.count ? "danger" : "neutral"}
          label="Over the limit"
          value={count(summary.largeWriteoffs.count)}
          note={summary.largeWriteoffs.count ? `${money(summary.largeWriteoffs.value, currency)} needed a second person` : "nothing large written off"}
        />
        <StatTile
          icon="clipboard"
          tone={summary.purchaseApprovals.sentBack ? "warning" : "neutral"}
          label="Large orders"
          value={`${count(summary.purchaseApprovals.approved)} approved`}
          note={`${count(summary.purchaseApprovals.asked)} asked · ${count(summary.purchaseApprovals.sentBack)} sent back`}
        />
      </div>

      <SectionCard icon="users" title="Who wrote off what" description="Each person's waste at cost, biggest first." flush>
        <DataGrid
          id="writeoff-by-person"
          currency={currency}
          caption="Write-offs by person"
          columns={personColumns}
          rows={data.byPerson}
          rowKey={(row) => `${row.userId}`}
          loading={loading}
          empty="Nothing written off in these dates."
          emptyIcon="trash"
          exportName={`writeoffs-by-person-${data.from}-to-${data.to}`}
        />
      </SectionCard>

      <SectionCard
        icon="shield"
        title="Write-offs over the limit"
        description="Every wastage, stock out or dish worth more than the limit, with who logged it and who approved it."
        flush
      >
        <DataGrid
          id="writeoff-large"
          currency={currency}
          caption="Write-offs over the limit"
          columns={largeColumns}
          rows={data.largeWriteoffs}
          rowKey={(row) => row.id}
          loading={loading}
          empty="No write-off went over the limit in these dates."
          emptyHint={wasteLimit === null || wasteLimit === undefined ? "No limit is set, so nothing needs a second person." : undefined}
          emptyIcon="shield"
          exportName={`writeoffs-over-limit-${data.from}-to-${data.to}`}
        />
      </SectionCard>

      <SectionCard
        icon="clipboard"
        title="Large purchase orders"
        description="Orders over the approval limit: asked for, approved (and by whom) or sent back with a note."
        flush
      >
        <DataGrid
          id="writeoff-po-approvals"
          currency={currency}
          caption="Large purchase orders"
          columns={orderColumns}
          rows={data.purchaseApprovals}
          rowKey={(row) => row.id}
          loading={loading}
          empty="No order went over the limit in these dates."
          emptyIcon="clipboard"
          exportName={`po-approvals-${data.from}-to-${data.to}`}
        />
      </SectionCard>
    </div>
  );
}
