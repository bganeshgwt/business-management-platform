import { useCallback, useEffect, useMemo, useState } from "react";
import { BarList } from "../../../../components/Charts";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { getStockValuation } from "../services/inventory.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money, moneyExact } from "@bmp/shared/format";
import { today } from "@bmp/shared/dates";
import { downloadCsv } from "../../../../services/csv";
import { escapeHtml, printDocument } from "../../../../services/print";
import useAuth from "../../../../hooks/useAuth";
import { Chip, StoreSelect, Tile } from "./stockUi";
import { niceDate, qty, unitMoney } from "./stockFormat";

// Closing stock on a date, for the accountant's month end: what was on the
// shelves at the end of that day and what it was worth at the prices paid
// then.
export default function ClosingStockPanel({ stores, currency }) {
  const { user } = useAuth();
  const [date, setDate] = useState(today());
  const [store, setStore] = useState("all");
  const [data, setData] = useState(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    () =>
      getStockValuation({ date, store })
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [date, store]
  );

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(
    () =>
      (data ? data.items : []).filter(
        (row) => !search || row.name.toLowerCase().includes(search.toLowerCase())
      ),
    [data, search]
  );

  const storeName = data && data.store ? data.store.name : "All stores";
  const multi = stores.filter((row) => !row.outletId || row.ownStore).length > 1;

  const exportCsv = () =>
    downloadCsv(
      [
        [`Closing stock as at end of ${date}`, storeName],
        ["Item", "Code", "Category", "Unit", "Quantity", "Unit cost", "Value", "Cost note"],
        ...data.items.map((row) => [
          row.name,
          row.code || "",
          row.category || "",
          row.unitShortName,
          row.quantity,
          row.unitCost ?? "",
          row.negative ? 0 : row.value,
          row.negative ? "Below zero — not counted" : row.costEstimated ? "No price by that date: today's cost" : "",
        ]),
        [],
        ["Total", "", "", "", "", "", data.totals.value],
      ],
      `closing-stock-${date}.csv`
    );

  const print = () =>
    printDocument({
      title: `Closing stock ${date}`,
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        th, td { border-bottom: 1px solid #ccc; padding: 4px 6px; text-align: left; }
        th { font-size: 11px; background: #f2f2f2; }
        .r { text-align: right; }
        tfoot td { font-weight: 700; border-top: 2px solid #333; }`,
      body: `
        <h1>Closing stock — end of ${escapeHtml(niceDate(date))}</h1>
        <div>${escapeHtml(user.restaurantName || "")} · ${escapeHtml(storeName)}</div>
        <table>
          <thead><tr><th>Item</th><th>Category</th><th class="r">Quantity</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead>
          <tbody>${data.items
            .filter((row) => !row.negative)
            .map(
              (row) =>
                `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.category || "")}</td><td class="r">${qty(row.quantity, row.unitShortName)}</td><td class="r">${row.unitCost === null ? "—" : unitMoney(row.unitCost, currency)}</td><td class="r">${moneyExact(row.value, currency)}</td></tr>`
            )
            .join("")}</tbody>
          <tfoot><tr><td colspan="4">Total closing stock</td><td class="r">${moneyExact(data.totals.value, currency)}</td></tr></tfoot>
        </table>`,
    });

  return (
    <div className="stack">
      <div className="stk-intro">
        <p>
          What was on the shelves at the end of a day and what it was worth at the prices paid then — the
          figure your accountant needs at month end. A bill entered late counts from the day its goods arrived.
        </p>
        <div className="stk-actions">
          <button type="button" className="button button-secondary" onClick={print} disabled={!data || data.items.length === 0}>
            <Icon name="print" size={16} /> Print
          </button>
          <button type="button" className="button button-secondary" onClick={exportCsv} disabled={!data || data.items.length === 0}>
            <Icon name="download" size={16} /> Export CSV
          </button>
        </div>
      </div>

      <ErrorMessage message={error} />

      <div className="card stk-filter-card">
        <div className="filters">
          <label className="field">
            <span>As at the end of</span>
            <input type="date" value={date} max={today()} onChange={(event) => setDate(event.target.value || today())} />
          </label>
          {multi && <StoreSelect stores={stores} value={store} onChange={setStore} includeAll />}
          <label className="field">
            <span>Find</span>
            <span className="input-with-icon">
              <Icon name="search" size={17} className="input-icon" />
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Item name" />
            </span>
          </label>
        </div>
      </div>

        {loading || !data ? (
          <Loading />
        ) : (
          <>
            <div className="stat-grid">
              <Tile
                icon="wallet"
                tone="primary"
                label="Closing stock"
                value={money(data.totals.value, currency)}
                note={`${storeName}, end of ${niceDate(date)}`}
              />
              <Tile icon="box" label="Items on the shelf" value={count(data.totals.itemCount)} />
              <Tile
                icon="tag"
                label="Priced at today's cost"
                value={count(data.totals.estimatedCount)}
                tone={data.totals.estimatedCount > 0 ? "info" : undefined}
                note="no purchase price on record by then"
              />
              <Tile
                icon="alert-circle"
                label="Below zero"
                value={count(data.totals.negativeCount)}
                tone={data.totals.negativeCount > 0 ? "danger" : undefined}
                note={data.totals.negativeCount > 0 ? "left out — count these" : "none"}
              />
            </div>

            {data.totals.hiddenCount > 0 && (
              <div className="alert alert-info">
                <span>
                  {data.totals.hiddenCount === 1 ? "1 item is" : `${data.totals.hiddenCount} items are`} on a blind stock
                  count and left out here until a manager posts it.
                </span>
              </div>
            )}

            {data.items.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon="box"
                  message="Nothing was in stock at the end of that day."
                  hint="Pick a later date, or another store."
                />
              </div>
            ) : (
              <div className="stk-closing">
                <SectionCard icon="pie" title="By category" description="Where the money on the shelves sits.">
                  <BarList
                    rows={data.byCategory.map((row) => ({
                      label: row.category,
                      value: row.value,
                      sub: `${row.itemCount} item${row.itemCount === 1 ? "" : "s"}`,
                    }))}
                    currency={currency}
                  />
                </SectionCard>
                <SectionCard
                  icon="list"
                  title="Item by item"
                  description="Quantity at the end of the day, at the price paid then."
                  flush
                >
                {/* The Export CSV and Print buttons above give the accountant's
                    sheet (with its heading and total line), so the grid has no
                    export of its own; the Find box above searches it. */}
                <DataGrid
                  id="closing-stock-items"
                  caption={`Closing stock, end of ${niceDate(date)}`}
                  rows={rows}
                  rowKey={(row) => row.id}
                  currency={currency}
                  rowNoun={["item", "items"]}
                  search={false}
                  empty="No item matches."
                  emptyIcon="search"
                  columns={[
                    {
                      key: "name",
                      header: "Item",
                      value: (row) => row.name,
                      mobile: "title",
                      render: (row) => (
                        <>
                          {row.name}
                          <div className="muted small">
                            {row.category || "Uncategorised"}
                            {row.status !== "active" ? " · inactive" : ""}
                          </div>
                        </>
                      ),
                    },
                    {
                      key: "category",
                      header: "Category",
                      value: (row) => row.category,
                      filter: "select",
                      defaultHidden: true,
                    },
                    {
                      key: "quantity",
                      header: "Quantity",
                      type: "number",
                      value: (row) => row.quantity,
                      mobile: "show",
                      render: (row) => <span className={`nowrap ${row.negative ? "stk-var-short" : ""}`}>{qty(row.quantity, row.unitShortName)}</span>,
                    },
                    {
                      key: "cost",
                      header: "Cost",
                      type: "money",
                      value: (row) => row.unitCost,
                      mobile: "show",
                      render: (row) => (
                        <>
                          {row.unitCost === null ? <span className="muted">—</span> : unitMoney(row.unitCost, currency)}
                          {row.costEstimated && (
                            <div>
                              <Chip tone="info" title="No purchase price on record by that date">
                                today's cost
                              </Chip>
                            </div>
                          )}
                        </>
                      ),
                    },
                    {
                      key: "value",
                      header: "Value",
                      type: "money",
                      exact: true,
                      // Stock below zero is left out of the total, as on the printout.
                      value: (row) => (row.negative ? null : row.value),
                      total: "sum",
                      mobile: "show",
                      render: (row) => (row.negative ? <Chip tone="danger">Below zero</Chip> : <strong>{moneyExact(row.value, currency)}</strong>),
                    },
                  ]}
                />
                </SectionCard>
              </div>
            )}
          </>
        )}
    </div>
  );
}
