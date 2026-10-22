import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import { ErrorMessage } from "../../../../components/Feedback";
import { listStockMovements, listStores, searchInventoryItems } from "../services/inventory.service";
import SearchPicker from "../../../../components/SearchPicker";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { dayMonth, today } from "@bmp/shared/dates";
import { downloadCsv } from "../../../../services/csv";
import { count, money } from "@bmp/shared/format";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { Chip, Tile } from "./stockUi";
import { niceDate, qty, unitMoney } from "./stockFormat";
import "../../../../styles/stock.css";
import "../../../../styles/backoffice-sweep.css";
import "../styles/stock-pro.css";

// Every type a movement can have, in the words a store manager uses.
const TYPE_LABELS = {
  opening: "Opening stock",
  purchase: "Purchase received",
  return: "Returned to supplier",
  adjustment: "Adjustment",
  wastage: "Wastage",
  consumption: "Used / sold",
  transfer: "Transfer",
};

const TYPE_TONES = {
  opening: "muted",
  purchase: "success",
  return: "warning",
  adjustment: "info",
  wastage: "danger",
  consumption: "primary",
  transfer: "muted",
};

// The list pages on the server (25, 50 or 100 a page); the export takes up to
// 5,000 rows of the same filter.
const PAGE_SIZE = 25;
const EXPORT_SIZE = 5000;

// The notes minus whatever the reference already says ("GRN-0116 · Bill 4521"
// is on the line above), so a count's own note still shows and nothing twice.
const extraNote = (movement) => {
  if (!movement.notes) {
    return "";
  }

  const label = movement.referenceLabel || "";

  return movement.notes
    .split(" · ")
    .filter((part) => !label.includes(part))
    .join(" · ");
};

// Where a reference opens: the bill, the purchase order, the stock count or
// the transfer note it came from. Others (a direct move, a wastage log) have
// no screen of their own and stay as words.
const referenceLink = (movement) => {
  const id = movement.referenceId;
  const label = movement.referenceLabel || "";

  switch (movement.referenceType) {
    case "bill":
      return label ? `/bills?search=${encodeURIComponent(label)}` : null;
    case "purchase_order":
      return id ? `/purchasing/orders?open=${id}` : null;
    case "goods_receipt":
    case "goods_receipt_void":
      return "/purchasing/orders?tab=bills";
    case "stock_count":
      return id ? `/inventory/items?tab=counts&count=${id}` : null;
    case "transfer_note":
      return id ? `/inventory/transfers?open=${id}` : null;
    default:
      return null;
  }
};

// Stock value of a movement at the cost it carried: + for stock in, - out.
const valueAtCost = (movement) =>
  movement.stockHidden || movement.unitCost === null || movement.quantity === null
    ? null
    : Math.round(movement.quantity * movement.unitCost * 100) / 100;

// The day and the time on two lines, so the column stays narrow and the
// item names beside it get the room.
const whenDay = (value) => dayMonth(value, { year: true });

const whenTime = (value) => new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

const dayOf = (value) => new Date(value).toLocaleDateString("en-CA");

const shortDay = (value) => dayMonth(value);

// A delivery typed in after the day it arrived counts from the day it came
// in (for closing stock and counts). The list stays in the order things were
// entered, so the running balance reads down the page, and such a row names
// both days.
const enteredLate = (movement) =>
  Boolean(movement.effectiveAt) && dayOf(movement.effectiveAt) !== dayOf(movement.createdAt);

// What the date filter goes by. Nearly always the same moment; they differ
// only for a bill typed in days after its goods came.
const DATE_BASES = [
  { value: "arrived", label: "When it happened" },
  { value: "entered", label: "When it was entered" },
];

export default function StockLedgerPage() {
  const [movements, setMovements] = useState([]);
  const [total, setTotal] = useState(0);
  // The figures above the list, over every movement the filter matches.
  const [summary, setSummary] = useState(null);
  const [paging, setPaging] = useState(() => ({
    page: 1,
    pageSize: rememberedPageSize("stock-movements", PAGE_SIZE),
  }));
  // The item picked in the filter ({ id, name }); the address bar keeps its id.
  const [pickedItem, setPickedItem] = useState(null);
  const [stores, setStores] = useState([]);
  const [currency, setCurrency] = useState("₹");
  // In the address bar, so "Stock movements" on an item opens filtered to it.
  const [itemFilter, setItemFilter] = useQueryFilter("item");
  const [typeFilter, setTypeFilter] = useQueryFilter("type");
  const [storeFilter, setStoreFilter] = useQueryFilter("store");
  // A list that grows every day opens on today, with the dates in sight.
  const [from, setFrom] = useQueryFilter("from", today());
  const [to, setTo] = useQueryFilter("to", today());
  const [dateBasis, setDateBasis] = useQueryFilter("dates", "arrived");
  const [search, setSearch] = useState("");
  // On a phone the rarely changed filters fold away behind "More filters".
  const [moreFilters, setMoreFilters] = useState(false);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  const filters = useCallback(
    (limit) => ({
      itemId: itemFilter || undefined,
      type: typeFilter || undefined,
      store: storeFilter || undefined,
      from: from || undefined,
      to: to || undefined,
      dateBasis: dateBasis === "entered" ? "entered" : undefined,
      search: search.trim() || undefined,
      limit,
    }),
    [itemFilter, typeFilter, storeFilter, from, to, dateBasis, search]
  );

  const load = useCallback(
    () =>
      listStockMovements({ ...filters(paging.pageSize), offset: (paging.page - 1) * paging.pageSize })
        .then((page) => {
          setMovements(page.items);
          setTotal(page.total);
          setSummary(page.summary || null);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [filters, paging]
  );

  // Any filter change starts again at page 1.
  const refilter = (apply) => (value) => {
    setLoading(true);
    setPaging((current) => ({ ...current, page: 1 }));
    apply(value);
  };

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    listStores()
      .then(setStores)
      .catch(() => setStores([]));

    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);
  }, []);

  const holding = stores.filter((store) => !store.outletId || store.ownStore);

  // Opened from an item ("Stock movements" on the stock list): the picker
  // shows that item's name, read off its first movement.
  const firstName =
    movements[0] && String(movements[0].inventoryItemId) === String(itemFilter) ? movements[0].itemName : null;
  const itemShown =
    pickedItem && String(pickedItem.id) === String(itemFilter)
      ? pickedItem
      : itemFilter
        ? { id: Number(itemFilter), name: firstName || "The chosen item" }
        : null;

  // The same filter, up to 5,000 rows, as a file the accountant can open.
  const exportCsv = async () => {
    setExporting(true);

    try {
      const page = await listStockMovements(filters(EXPORT_SIZE));

      downloadCsv(
        [
          ["Entered", "Happened (counts from)", "Item", "Category", "Type", "Change", "Unit", "Balance after", "Unit cost", "Value", "Store", "Reference", "Reason", "Notes", "By"],
          // An item on an open blind count goes out with its figures blank,
          // as the screen shows it: quantities in a file add up to the stock
          // just as well as the ones on screen.
          ...page.items.map((movement) => [
            new Date(movement.createdAt).toLocaleString("en-IN"),
            new Date(movement.effectiveAt || movement.createdAt).toLocaleString("en-IN"),
            movement.itemName,
            movement.category || "",
            TYPE_LABELS[movement.transactionType] || movement.transactionType,
            movement.stockHidden ? "" : movement.quantity,
            movement.unitShortName,
            movement.balanceAfter ?? "",
            movement.unitCost ?? "",
            movement.stockHidden || movement.unitCost === null
              ? ""
              : Math.round(movement.quantity * movement.unitCost * 100) / 100,
            movement.storeName,
            movement.referenceLabel || "",
            movement.reason || "",
            movement.notes || "",
            movement.createdByName || "",
          ]),
        ],
        `stock-movements-${from || "start"}-to-${to || today()}.csv`
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const hiddenRows = movements.filter((m) => m.stockHidden).length;
  // Counted by the server over every movement the filter matches, so the
  // figures hold whichever page is on screen. Quantities only for one item
  // (and never one on a blind count).
  const figures = summary || { in: 0, out: 0, waste: 0, inQuantity: null, outQuantity: null };
  const oneItem =
    itemFilter && figures.inQuantity !== null && movements.length > 0 ? movements[0].unitShortName : null;
  const inQty = figures.inQuantity || 0;
  const outQty = figures.outQuantity || 0;
  const inRows = figures.in;
  const outRows = figures.out;
  const wasteRows = figures.waste;
  const scope = "in these dates";

  const when = (movement) => (dateBasis === "entered" ? movement.createdAt : movement.effectiveAt || movement.createdAt);

  // The ledger as a grid: S.No. across pages, the server's pages, and the
  // same cells as before.
  const columns = [
    {
      key: "when",
      header: "When",
      type: "datetime",
      value: (movement) => when(movement),
      sortable: false,
      mobile: "subtitle",
      width: 132,
      render: (movement) => (
        <span className="small">
          <span className="nowrap">{whenDay(when(movement))}</span>{" "}
          <span className="muted stk-when-time">{whenTime(when(movement))}</span>
          {enteredLate(movement) && (
            <span className="muted" style={{ display: "block" }} title="Entered late: it counts in stock from the day the goods arrived">
              {dateBasis === "entered" ? `arrived ${shortDay(movement.effectiveAt)}` : `entered ${shortDay(movement.createdAt)}`}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "item",
      header: "Item",
      value: (movement) => movement.itemName,
      sortable: false,
      pin: true,
      mobile: "title",
      width: 170,
      render: (movement) => <strong className="stk-ledger-item">{movement.itemName}</strong>,
    },
    {
      key: "type",
      header: "Type",
      type: "status",
      value: (movement) => TYPE_LABELS[movement.transactionType] || movement.transactionType,
      sortable: false,
      mobile: "show",
      width: 150,
      render: (movement) => (
        <Chip tone={TYPE_TONES[movement.transactionType]}>
          {TYPE_LABELS[movement.transactionType] || movement.transactionType}
        </Chip>
      ),
    },
    {
      key: "change",
      header: "Change",
      type: "number",
      value: (movement) => (movement.stockHidden ? null : movement.quantity),
      sortable: false,
      mobile: "show",
      width: 150,
      render: (movement) =>
        movement.stockHidden ? (
          <span className="bo-cell-stack">
            <span>
              <Chip tone="muted">Being counted</Chip>
            </span>
            {movement.unitCost !== null && (
              <span className="muted small stk-ledger-cost">
                at {unitMoney(movement.unitCost, currency)}/{movement.unitShortName}
              </span>
            )}
          </span>
        ) : (
          <span className={`bo-cell-stack ${movement.quantity < 0 ? "stk-var-short" : "stk-var-over"}`}>
            <span className="nowrap">
              {movement.quantity > 0 ? "+" : "−"}
              {qty(Math.abs(movement.quantity), movement.unitShortName)}
            </span>
            {movement.unitCost !== null && (
              <span className="muted small stk-ledger-cost">
                at {unitMoney(movement.unitCost, currency)}/{movement.unitShortName}
              </span>
            )}
            {/* A sale that had to take stock from a batch past its date:
                the bill went through, and this says so. */}
            {movement.expiredQuantity > 0 && (
              <span className="small">
                <Link
                  to="/inventory/items?tab=batches&show=used_after_expiry"
                  className="stk-expired-used"
                  title="Taken from a batch past its expiry date"
                >
                  Expired stock used: {qty(movement.expiredQuantity, movement.unitShortName)}
                </Link>
              </span>
            )}
          </span>
        ),
    },
    {
      key: "value",
      header: "Value at cost",
      type: "money",
      value: valueAtCost,
      sortable: false,
      mobile: "show",
      width: 120,
      render: (movement) => {
        const amount = valueAtCost(movement);

        return amount === null ? (
          <span className="muted">—</span>
        ) : (
          <span className={`nowrap ${amount < 0 ? "stk-var-short" : ""}`}>{money(amount, currency)}</span>
        );
      },
    },
    {
      key: "balance",
      header: "Balance",
      type: "number",
      value: (movement) => (movement.stockHidden ? null : movement.balanceAfter),
      sortable: false,
      mobile: "show",
      width: 110,
      render: (movement) =>
        movement.stockHidden ? (
          <span className="muted" title="Hidden while the item is on a blind count">—</span>
        ) : (
          <span className="nowrap">{qty(movement.balanceAfter, movement.unitShortName)}</span>
        ),
    },
    {
      key: "by",
      header: holding.length > 1 ? "Store · by" : "By",
      value: (movement) => movement.createdByName || "",
      sortable: false,
      mobile: "show",
      width: 150,
      render: (movement) => (
        <span className="bo-cell-stack small stk-ledger-by">
          {holding.length > 1 && <span>{movement.storeName}</span>}
          <span className={holding.length > 1 ? "muted" : ""}>
            {holding.length > 1 ? "by " : ""}
            {movement.createdByName || "—"}
          </span>
        </span>
      ),
    },
    {
      key: "reference",
      header: "Reference · reason",
      value: (movement) => [movement.referenceLabel, movement.reason].filter(Boolean).join(" · "),
      sortable: false,
      mobile: "show",
      width: 250,
      render: (movement) => (
        <span className="bo-cell-stack small">
          {movement.referenceLabel &&
            (referenceLink(movement) ? (
              <Link className="stk-ref stk-ref-link" to={referenceLink(movement)} title="Open where this came from">
                {movement.referenceLabel}
              </Link>
            ) : (
              <strong className="stk-ref">{movement.referenceLabel}</strong>
            ))}
          <span className={movement.referenceLabel ? "muted" : ""}>{movement.reason || "—"}</span>
          {extraNote(movement) && <span className="muted">{extraNote(movement)}</span>}
        </span>
      ),
    },
  ];

  return (
    <div className="stack stk-page">
      <PageHeader
        icon="history"
        title="Stock movements"
        description="Every unit in and out — deliveries, sales, returns, counts, wastage — with who recorded it and the balance after."
        action={
          <button type="button" className="button button-secondary" onClick={exportCsv} disabled={exporting || movements.length === 0}>
            <Icon name="download" size={16} /> {exporting ? "Preparing…" : "Export CSV"}
          </button>
        }
      />

      <ErrorMessage message={error} />

      {hiddenRows > 0 && (
        <div className="alert alert-info">
          <span>
            <strong>{hiddenRows === 1 ? "1 movement" : `${count(hiddenRows)} movements`}</strong> below{" "}
            {hiddenRows === 1 ? "is for an item" : "are for items"} being counted blind, so{" "}
            {hiddenRows === 1 ? "its quantity stays" : "their quantities stay"} hidden until a manager posts the count.
          </span>
        </div>
      )}

      <div className={`card stk-filter-card ${moreFilters ? "" : "stk-filters-folded"}`}>
        <div className="filters">
          {/* Thousands of items: type a few letters rather than scroll a list. */}
          <SearchPicker
            label="Item"
            value={itemShown}
            onChange={(item) => {
              setPickedItem(item);
              refilter(setItemFilter)(item ? String(item.id) : "");
            }}
            search={(q, { signal }) => searchInventoryItems(q, { signal })}
            getLabel={(item) => item.name}
            getDescription={(item) =>
              [item.code, item.category, item.status && item.status !== "active" ? "retired" : null]
                .filter(Boolean)
                .join(" · ")
            }
            placeholder="All items — type a name or code"
            emptyText="No item by that name or code"
          />

          <label className="field stk-filter-more">
            <span>Type</span>
            <select value={typeFilter} onChange={(event) => refilter(setTypeFilter)(event.target.value)}>
              <option value="">All types</option>
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          {holding.length > 1 && (
            <label className="field stk-filter-more">
              <span>Store</span>
              <select value={storeFilter} onChange={(event) => refilter(setStoreFilter)(event.target.value)}>
                <option value="">All stores</option>
                {holding.map((store) => (
                  <option key={store.outletId || "main"} value={store.outletId ? String(store.outletId) : "main"}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>Reference or reason</span>
            <span className="input-with-icon">
              <Icon name="search" size={17} className="input-icon" />
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setPaging((current) => ({ ...current, page: 1 }));
                  setSearch(event.target.value);
                }}
                placeholder="PO-0004, INV-1042, SC-0003"
              />
            </span>
          </label>
          <div className="stk-daterange">
            <DateRangeFilter
              from={from}
              to={to}
              onChange={refilter((range) => {
                setFrom(range.from);
                setTo(range.to);
              })}
              label="movement dates"
            />
          </div>
          <label className="field stk-date-basis stk-filter-more">
            <span>Dates by</span>
            <select value={dateBasis} onChange={(event) => refilter(setDateBasis)(event.target.value)}>
              {DATE_BASES.map((basis) => (
                <option key={basis.value} value={basis.value}>
                  {basis.label}
                </option>
              ))}
            </select>
          </label>
          <div className="stk-filter-toggle-row">
            <button
              type="button"
              className="button button-secondary button-sm"
              onClick={() => setMoreFilters(!moreFilters)}
              aria-expanded={moreFilters}
            >
              <Icon name="sliders" size={15} /> {moreFilters ? "Fewer filters" : "More filters"}
            </button>
            {!moreFilters && (
              <span className="muted">
                {niceDate(from)} – {niceDate(to)}
                {typeFilter ? ` · ${TYPE_LABELS[typeFilter] || typeFilter}` : ""}
                {storeFilter ? ` · ${(holding.find((store) => (store.outletId ? String(store.outletId) : "main") === storeFilter) || {}).name || "one store"}` : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {summary && total > 0 && (
        <div className="stat-grid">
          <Tile icon="history" label="Movements" value={count(total)} note="in these dates" />
          <Tile
            icon="arrow-down"
            tone={inRows ? "success" : undefined}
            label="Stock in"
            value={oneItem ? `+${qty(inQty, oneItem)}` : count(inRows)}
            note={oneItem ? `over ${count(inRows)} movements ${scope}` : `movements ${scope}`}
          />
          <Tile
            icon="arrow-up"
            tone={outRows ? "warning" : undefined}
            label="Stock out"
            value={oneItem ? `−${qty(outQty, oneItem)}` : count(outRows)}
            note={oneItem ? `over ${count(outRows)} movements ${scope}` : `movements ${scope}`}
          />
          <Tile
            icon="trash"
            tone={wasteRows ? "danger" : undefined}
            label="Written off as waste"
            value={count(wasteRows)}
            note={`movements ${scope}`}
          />
        </div>
      )}

      <SectionCard
        icon="list"
        title="Ledger"
        description={
          dateBasis === "entered"
            ? "Dated by when each movement was entered."
            : "Dated by when the stock really moved: a bill entered late counts from the day its goods arrived."
        }
        actions={<span className="stk-count">{total === 1 ? "1 movement" : `${count(total)} movements`}</span>}
        flush
      >
        <DataGrid
          id="stock-movements"
          caption="Stock movements"
          columns={columns}
          rows={movements}
          rowKey={(movement) => movement.id}
          loading={loading}
          empty="No stock movements match."
          emptyIcon="history"
          emptyHint="Widen the dates or clear a filter."
          rowClassName={(movement) => (movement.expiredQuantity > 0 ? "dg-tone-warning" : "")}
          server={{
            total,
            page: paging.page,
            pageSize: paging.pageSize,
            onChange: ({ page, pageSize }) => {
              setLoading(true);
              setPaging({ page: pageSize !== paging.pageSize ? 1 : page, pageSize });
            },
          }}
        />
      </SectionCard>
    </div>
  );
}
