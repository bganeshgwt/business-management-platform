import { useCallback, useEffect, useMemo, useState } from "react";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useShake from "../../../../hooks/useShake";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { listBatches, stockOut } from "../services/inventory.service";
import { withApproval } from "../../../../services/approval";
import { getErrorMessage } from "../../../../services/api";
import { count, money } from "@bmp/shared/format";
import { Chip } from "./stockUi";
import { niceDate, qty } from "./stockFormat";
import "../../../../styles/backoffice.css";

// Batches & expiry. Every batch still holding stock, first to expire first,
// filtered the way the bell's expiry alerts link here (?show=soon&store=main).
//
// Kitchen issues, production and transfers take the earliest unexpired batch
// and refuse expired stock. A sale never fails for stock: when the only stock
// left is past its date, the bill takes it and the batch is marked "used
// after expiry" on that bill, listed here for a week so the manager can act —
// write off what is left, or enter today's delivery.

const SHOWS = [
  { key: "all", label: "All batches" },
  { key: "expiring", label: "Expiring in 7 days" },
  { key: "expired", label: "Expired, still in stock" },
  { key: "used_after_expiry", label: "Expired stock used on bills" },
  { key: "unknown", label: "No expiry date" },
];

// Shown from the bell: "within 2 days" is its own view.
const BELL_SHOWS = { soon: "Expiring within 2 days" };

const statusOf = (row) => {
  if (row.days_left === null) {
    return { label: "No expiry date", tone: "muted" };
  }

  if (row.days_left < 0) {
    const days = -row.days_left;
    return { label: days === 1 ? "Expired yesterday" : `Expired ${days} days ago`, tone: "danger" };
  }

  if (row.days_left === 0) {
    return { label: "Expires today", tone: "danger" };
  }

  if (row.days_left <= 2) {
    return { label: row.days_left === 1 ? "Expires tomorrow" : "In 2 days", tone: "warning" };
  }

  return { label: `${row.days_left} days left`, tone: row.days_left <= 7 ? "info" : "success" };
};

export default function BatchStockPanel({ stores = [], currency = "₹" }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("inventory.manage");
  const [show, setShow] = useQueryFilter("show", "all");
  const [store, setStore] = useQueryFilter("store", "all");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [waste, setWaste] = useState(null);
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [formRef, shake] = useShake();

  const holding = stores.filter((entry) => !entry.outletId || entry.ownStore);

  const load = useCallback(
    () =>
      listBatches({ show, store: store === "all" ? undefined : store })
        .then((data) => {
          setRows(data);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [show, store]
  );

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(
    () =>
      (rows || []).filter((row) =>
        `${row.name} ${row.batch_number || ""} ${row.store}`.toLowerCase().includes(search.trim().toLowerCase())
      ),
    [rows, search]
  );

  const valueOf = (row) => (row.unit_cost === null ? 0 : Math.max(0, row.quantity) * row.unit_cost);
  const expired = visible.filter((row) => row.days_left !== null && row.days_left < 0 && row.quantity > 0);
  const soon = visible.filter((row) => row.days_left !== null && row.days_left >= 0 && row.days_left <= 2 && row.quantity > 0);
  const usedAfter = visible.filter((row) => row.used_after_expiry > 0);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const amount = Number(quantity);
      await withApproval(
        (headers) =>
          stockOut(
            {
              inventoryItemId: waste.inventory_item_id,
              batchId: waste.id,
              outletId: waste.outlet_id,
              transactionType: "wastage",
              wasteReason: waste.days_left !== null && waste.days_left < 0 ? "expired" : "spoiled",
              quantity: amount,
              reason: reason.trim(),
              notes: `Batch ${waste.batch_number || waste.id}`,
            },
            headers
          ),
        `Write off ${qty(amount, waste.unit)} of ${waste.name}`
      );
      setWaste(null);
      setSuccess(`${qty(amount, waste.unit)} of ${waste.name} written off from batch ${waste.batch_number || "unlabelled"}`);
      await load();
    } catch (err) {
      if (!err.approvalCancelled) {
        setError(getErrorMessage(err));
        shake();
      }
    } finally {
      setBusy(false);
    }
  };

  const showLabel = BELL_SHOWS[show] || (SHOWS.find((entry) => entry.key === show) || SHOWS[0]).label;

  // Every batch as a grid row: S.No., sort by expiry or value, page, export.
  const columns = [
    {
      key: "item",
      header: "Item",
      value: (row) => row.name,
      pin: true,
      mobile: "title",
      width: 220,
      render: (row) => (
        <span className="bo-cell-stack">
          <strong>{row.name}</strong>
          <span className="muted small">{row.store}</span>
        </span>
      ),
    },
    { key: "store", header: "Store", value: (row) => row.store, defaultHidden: true, filter: "select" },
    {
      key: "batch",
      header: "Batch",
      value: (row) => row.batch_number || "Unlabelled",
      render: (row) => (
        <span className="bo-cell-stack">
          <span className="mono">{row.batch_number || "Unlabelled"}</span>
          {row.received_on && <span className="muted small">In {niceDate(row.received_on)}</span>}
        </span>
      ),
      mobile: "subtitle",
    },
    {
      key: "expiry",
      header: "Expiry",
      type: "date",
      // Sorted by the date it expires; no date sorts last.
      value: (row) => row.expiry_date || "9999-12-31",
      csv: (row) => row.expiry_date || "",
      render: (row) => {
        const status = statusOf(row);

        return (
          <span className="bo-cell-stack">
            <span>
              <Chip tone={status.tone}>{status.label}</Chip>
            </span>
            {row.expiry_date && <span className="muted small">{niceDate(row.expiry_date)}</span>}
          </span>
        );
      },
      mobile: "show",
      width: 170,
    },
    {
      key: "left",
      header: "Left",
      type: "number",
      value: (row) => row.quantity,
      render: (row) => (
        <span className="bo-cell-stack">
          <span className="nowrap">{qty(row.quantity, row.unit)}</span>
          {row.used_after_expiry > 0 && (
            <span className="small bo-short" title="Sales took this after the batch had expired">
              <Icon name="receipt" size={12} /> {qty(row.used_after_expiry, row.unit)} used after expiry
              {row.used_on_bills.length > 0 && (
                <span className="bo-bills">
                  {" "}on {row.used_on_bills.slice(0, 3).join(", ")}
                  {row.used_on_bills.length > 3 ? ` +${row.used_on_bills.length - 3}` : ""}
                </span>
              )}
            </span>
          )}
        </span>
      ),
      mobile: "show",
    },
    {
      key: "value",
      header: "Value",
      type: "money",
      value: (row) => (row.unit_cost === null ? null : valueOf(row)),
      render: (row) => (row.unit_cost === null ? "—" : money(valueOf(row), currency)),
      total: "sum",
      mobile: "show",
    },
  ];

  if (canManage) {
    columns.push({
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) =>
        row.quantity > 0 ? (
          <button
            type="button"
            className="button button-secondary button-sm"
            onClick={() => {
              setWaste(row);
              setQuantity(String(row.quantity));
              setReason(row.days_left !== null && row.days_left < 0 ? "Past its expiry date" : "");
              setError("");
            }}
          >
            Write off
          </button>
        ) : null,
    });
  }

  return (
    <section className="stack">
      <div className="stat-grid">
        <StatTile
          icon="alert"
          tone={expired.length ? "danger" : "neutral"}
          label="Expired, still on the shelf"
          value={money(expired.reduce((sum, row) => sum + valueOf(row), 0), currency)}
          note={expired.length ? `${count(expired.length)} batch${expired.length === 1 ? "" : "es"} to write off` : "Nothing past its date"}
          onClick={() => setShow("expired")}
        />
        <StatTile
          icon="clock"
          tone={soon.length ? "warning" : "neutral"}
          label="Expire within 2 days"
          value={money(soon.reduce((sum, row) => sum + valueOf(row), 0), currency)}
          note={soon.length ? `${count(soon.length)} batch${soon.length === 1 ? "" : "es"} — use these first` : "None this soon"}
          onClick={() => setShow("soon")}
        />
        <StatTile
          icon="receipt"
          tone={usedAfter.length ? "warning" : "neutral"}
          label="Expired stock used on bills"
          value={count(usedAfter.length)}
          note={usedAfter.length ? "In the last week — see the bills below" : "None in the last week"}
          onClick={() => setShow("used_after_expiry")}
        />
      </div>

      <SectionCard
        flush
        icon="calendar"
        title={showLabel}
        description="First to expire is used first. A bill is never refused for stock: if only expired stock is left, the sale takes it and it is marked here."
      >
        <div className="stk-filterbar bo-batch-filters">
          <div className="segmented bo-batch-shows" role="tablist" aria-label="Show">
            {SHOWS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={show === entry.key}
                className={`segment${show === entry.key ? " is-active" : ""}`}
                onClick={() => setShow(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="bo-batch-find">
            {holding.length > 1 && (
              <label className="field">
                <span className="sr-only">Store</span>
                <select value={store} onChange={(event) => setStore(event.target.value)}>
                  <option value="all">All stores</option>
                  {holding.map((entry) => (
                    <option key={entry.outletId || "main"} value={entry.outletId ? String(entry.outletId) : "main"}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span className="sr-only">Find</span>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Item, batch or store" />
            </label>
          </div>
        </div>

        <div className="stack bo-pad">
          <ErrorMessage message={error} />
          <SuccessMessage message={success} />
        </div>

        <DataGrid
          id="stock-batches"
          caption={showLabel}
          columns={columns}
          rows={visible}
          rowKey={(row) => `${row.id}:${row.outlet_id || "main"}`}
          loading={rows === null}
          empty={show === "all" ? "No batches with stock" : `Nothing here: ${showLabel.toLowerCase()}`}
          emptyIcon="calendar"
          emptyHint="Batches are made when stock comes in with a batch number or an expiry date on a purchase bill or stock in."
          rowClassName={(row) =>
            row.used_after_expiry > 0 ? "dg-tone-warning" : row.days_left !== null && row.days_left < 0 && row.quantity > 0 ? "dg-tone-danger" : ""
          }
          search={false}
          exportName={`batches-${show}`}
          currency={currency}
        />
      </SectionCard>

      {waste && (
        <Modal title={`Write off · ${waste.name}`} description={`Batch ${waste.batch_number || "unlabelled"} at ${waste.store}. Only this batch is reduced.`} icon="trash" onClose={() => !busy && setWaste(null)}>
          <form className="stack" onSubmit={save} ref={formRef}>
            <ErrorMessage message={error} />
            <label className="field">
              <span>Quantity ({waste.unit})</span>
              <input type="number" min="0.001" max={waste.quantity} step="0.001" required value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            </label>
            <label className="field">
              <span>Why</span>
              <textarea required maxLength={150} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <p className="muted small">Over the write-off limit, a manager's PIN is asked for before it is recorded.</p>
            <div className="form-actions">
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => setWaste(null)}>
                Cancel
              </button>
              <button className="button button-danger" disabled={busy || !reason.trim()}>
                {busy ? "Recording…" : "Write off"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
