import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { getErrorMessage } from "../../../../services/api";
import { moneyExact } from "@bmp/shared/format";
import { getRiderSettlements, markRiderRepaid } from "../services/delivery.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { dayMonth } from "@bmp/shared/dates";

const ACTION_WORDS = { none: "Full", owed: "Owed by rider", written_off: "Written off" };

// The daily rider settlement report (SW-A-19): who handed in what, for one
// business date (today's unless another is picked), and every shortfall a
// rider still owes, whichever day it was — a debt stays on the list until
// he hands it over.
export default function RiderCashTab() {
  const [dateParam, setDateParam] = useQueryFilter("rdate");
  const [paging, setPaging] = useState(() => ({ page: 1, pageSize: rememberedPageSize("rider-settlements", 25) }));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [currency, setCurrency] = useState("₹");

  useEffect(() => {
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol || "₹"))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    getRiderSettlements({ date: dateParam || undefined, page: paging.page, pageSize: paging.pageSize })
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [dateParam, paging, reload]);

  const repaid = async (row) => {
    setBusyId(row.id);
    setError("");

    try {
      const result = await markRiderRepaid(row.id);
      setMessage(result.message);
      setReload((n) => n + 1);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const columns = useMemo(
    () => [
      { key: "rider", header: "Rider", value: (row) => row.riderName, mobile: "title", filter: "select" },
      { key: "settledAt", header: "Settled", type: "datetime", value: (row) => row.settledAt, mobile: "subtitle" },
      { key: "bills", header: "Orders", type: "number", value: (row) => row.billCount, total: "sum", mobile: "show" },
      { key: "expected", header: "Cash expected", type: "money", exact: true, value: (row) => row.cashExpected, total: "sum", mobile: "show" },
      { key: "handed", header: "Cash handed in", type: "money", exact: true, value: (row) => row.cashHanded, total: "sum", mobile: "show" },
      { key: "upi", header: "UPI at the door", type: "money", exact: true, value: (row) => row.upiAmount, total: "sum" },
      { key: "short", header: "Shortfall", type: "money", exact: true, value: (row) => row.shortfall, total: "sum", mobile: "show" },
      {
        key: "action",
        header: "Shortfall is",
        value: (row) => row.shortfallAction,
        filter: "select",
        filterOptions: Object.entries(ACTION_WORDS).map(([value, label]) => ({ value, label })),
        render: (row) =>
          row.shortfallAction === "none" ? (
            <span className="muted">—</span>
          ) : (
            <span className={`badge ${row.shortfallAction === "owed" && !row.repaidAt ? "badge-warning" : "badge-inactive"}`}>
              {row.shortfallAction === "owed" && row.repaidAt ? "Handed over" : ACTION_WORDS[row.shortfallAction]}
            </span>
          ),
        csv: (row) => (row.shortfallAction === "owed" && row.repaidAt ? "Handed over" : ACTION_WORDS[row.shortfallAction]),
      },
      { key: "reason", header: "Reason", value: (row) => row.shortfallReason || "", defaultHidden: false },
      {
        key: "by",
        header: "Settled by",
        value: (row) => row.settledByName || "",
        render: (row) => (
          <span>
            {row.settledByName || "—"}
            {row.approvedByName && <span className="muted small"> · approved by {row.approvedByName}</span>}
          </span>
        ),
      },
      {
        key: "billsList",
        header: "Bills",
        value: (row) => row.bills.map((bill) => bill.billNumber).join(", "),
        defaultHidden: true,
      },
    ],
    []
  );

  const owedColumns = useMemo(
    () => [
      { key: "rider", header: "Rider", value: (row) => row.riderName, mobile: "title" },
      { key: "date", header: "Business day", type: "date", value: (row) => row.businessDate, mobile: "subtitle" },
      { key: "short", header: "Owes", type: "money", exact: true, value: (row) => row.shortfall, total: "sum", mobile: "show" },
      { key: "reason", header: "Reason", value: (row) => row.shortfallReason || "", mobile: "show" },
      {
        key: "actions",
        header: "",
        label: "Actions",
        type: "actions",
        render: (row) => (
          <button type="button" className="chip-button" onClick={() => repaid(row)} disabled={busyId === row.id}>
            {busyId === row.id ? "Saving…" : "Handed over"}
          </button>
        ),
      },
    ],
    // repaid reads busyId; the column re-renders with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId]
  );

  const totals = data ? data.totals : null;

  return (
    <div className="stack">
      {message && (
        <div className="alert alert-success" role="status">
          {message}
        </div>
      )}

      {totals && (
        <div className="stat-grid dlv-rc-tiles">
          <StatTile icon="scooter" label="Settlements" value={String(totals.settlements)} note={`${totals.bills} orders`} />
          <StatTile icon="cash" label="Cash handed in" value={moneyExact(totals.cashHanded, currency)} note={`of ${moneyExact(totals.cashExpected, currency)} expected`} />
          <StatTile icon="phone" label="UPI at the door" value={moneyExact(totals.upiAmount, currency)} />
          <StatTile
            icon="alert"
            label="Short"
            value={moneyExact(totals.shortfall, currency)}
            tone={totals.shortfall > 0 ? "danger" : undefined}
          />
        </div>
      )}

      <SectionCard
        icon="wallet"
        title="Rider settlements"
        description={data ? `Business day ${dayMonth(data.date)}. Settle a rider from his card on the Live board.` : "Settle a rider from his card on the Live board."}
        flush
      >
        <DataGrid
          id="rider-settlements"
          caption="Rider settlements"
          columns={columns}
          rows={data ? data.items : []}
          rowKey={(row) => row.id}
          loading={loading && !data}
          error={error}
          onRetry={() => setReload((n) => n + 1)}
          empty="No rider settled on this day"
          emptyHint="Riders appear here once their cash is settled from the Live board."
          emptyIcon="wallet"
          rowClassName={(row) => (row.shortfall > 0 && row.shortfallAction === "owed" && !row.repaidAt ? "dg-tone-warning" : "")}
          exportName="rider-settlements"
          currency={currency}
          rowNoun={["settlement", "settlements"]}
          toolbar={
            <label className="dlv-rc-date">
              <span className="muted small">Day</span>
              <input
                type="date"
                value={dateParam || (data ? data.date : "")}
                onChange={(event) => {
                  setPaging((current) => ({ ...current, page: 1 }));
                  setDateParam(event.target.value || null);
                }}
                aria-label="Business day"
              />
            </label>
          }
          server={{
            total: data ? data.total : 0,
            page: paging.page,
            pageSize: paging.pageSize,
            totals: totals
              ? {
                  bills: totals.bills,
                  expected: totals.cashExpected,
                  handed: totals.cashHanded,
                  upi: totals.upiAmount,
                  short: totals.shortfall,
                }
              : undefined,
            onChange: ({ page, pageSize }) => setPaging({ page: pageSize !== paging.pageSize ? 1 : page, pageSize }),
          }}
        />
      </SectionCard>

      <SectionCard
        icon="alert"
        tone="warning"
        title="Still owed by riders"
        description="Shortfalls kept as owed, from any day, until the rider hands the money over."
        flush
      >
        <DataGrid
          id="rider-dues"
          caption="Shortfalls still owed by riders"
          columns={owedColumns}
          rows={data ? data.owed : []}
          rowKey={(row) => row.id}
          loading={loading && !data}
          empty="No rider owes anything"
          emptyIcon="check-circle"
          currency={currency}
          rowNoun={["shortfall", "shortfalls"]}
        />
      </SectionCard>
    </div>
  );
}
