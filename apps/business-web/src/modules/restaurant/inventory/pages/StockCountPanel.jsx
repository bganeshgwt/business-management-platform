import { useCallback, useEffect, useMemo, useState } from "react";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { BarList } from "../../../../components/Charts";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import TruncationNotice from "../../../../components/TruncationNotice";
import {
  cancelStockCount,
  createStockCount,
  getCountVariance,
  getStockCount,
  listInventoryItems,
  listStockCounts,
  postStockCount,
  saveStockCountLines,
} from "../services/inventory.service";
import { getErrorMessage } from "../../../../services/api";
import { count as countOf, money, moneyExact } from "@bmp/shared/format";
import { dayMonth, daysAgo, today } from "@bmp/shared/dates";
import { downloadCsv } from "../../../../services/csv";
import { escapeHtml, printDocument } from "../../../../services/print";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { Chip, Tile } from "./stockUi";
import "../styles/inventory.css";
import { qty, signedMoney } from "./stockFormat";

const STATUS = {
  draft: { label: "Counting", tone: "warning" },
  posted: { label: "Posted", tone: "success" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

// "23 Sep, 4:10 pm" — the app's month names, not the browser's "Sept".
const when = (value) => (value ? dayMonth(value, { time: true }) || "—" : "—");

// What a count covers, beyond categories and areas: a spot check.
const KIND_WORDS = { high_value: "High-value top 20", low: "Low stock" };

const scopeText = (scope = {}) => {
  const parts = [
    ...(scope.kind && KIND_WORDS[scope.kind] ? [KIND_WORDS[scope.kind]] : []),
    ...(scope.items ? [scope.items === 1 ? "1 chosen item" : `${scope.items} chosen items`] : []),
    ...(scope.categories || []).map((c) => c || "No category"),
    ...(scope.storageAreas || []).map((a) => a || "No area"),
  ];

  return parts.length ? parts.join(", ") : "Every item";
};

const signed = (value, unit) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${qty(Math.abs(value), unit)}`;

// The weekly (or nightly) count: the list of counts and the variance report,
// or one count sheet being filled in.
export default function StockCountPanel({ stores, currency }) {
  const [openId, setOpenId] = useQueryFilter("count");

  return openId ? (
    <CountSheet id={Number(openId)} currency={currency} onBack={() => setOpenId("")} />
  ) : (
    <CountList stores={stores} currency={currency} onOpen={(id) => setOpenId(String(id))} />
  );
}

function CountList({ stores, currency, onOpen }) {
  const { hasPermission } = useAuth();
  const canCount = hasPermission("inventory.count");
  const [counts, setCounts] = useState(null);
  const [variance, setVariance] = useState(null);
  const [range, setRange] = useState({ from: daysAgo(29), to: today() });
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([listStockCounts({ limit: 100 }), getCountVariance(range)])
        .then(([countPage, report]) => {
          setCounts(countPage);
          setVariance(report);
        })
        .catch((err) => setError(getErrorMessage(err))),
    [range]
  );

  useEffect(() => {
    load();
  }, [load]);

  if (!counts || !variance) {
    return error ? <ErrorMessage message={error} /> : <Loading />;
  }

  const open = counts.items.filter((count) => count.status === "draft");
  const worst = variance.items.filter((item) => item.shortageValue > 0).slice(0, 12);

  const exportVariance = () =>
    downloadCsv(
      [
        ["Item", "Category", "Unit", "Times counted", "Short qty", "Short value", "Extra qty", "Extra value", "Net value"],
        ...variance.items.map((item) => [
          item.itemName,
          item.category || "",
          item.unitShortName,
          item.timesCounted,
          item.shortageQuantity,
          item.shortageValue,
          item.excessQuantity,
          item.excessValue,
          item.netValue,
        ]),
      ],
      `stock-variance-${range.from}-to-${range.to}.csv`
    );

  return (
    <div className="stack">
      <ErrorMessage message={error} />

      <div className="stk-intro">
        <p>
          Count the shelves, and the system shows what is missing or extra — in quantity and in money — and
          corrects stock once a manager posts the count.
        </p>
        {canCount && (
          <button type="button" className="button" onClick={() => setStarting(true)}>
            <Icon name="plus" size={16} /> Start a count
          </button>
        )}
      </div>

      {open.length > 0 && (
        <div className="alert alert-notice">
          <span>
            {open.length === 1 ? "A count is" : `${open.length} counts are`} still open:{" "}
            {open.map((count, index) => (
              <span key={count.id}>
                {index > 0 && ", "}
                <button type="button" className="link-button" onClick={() => onOpen(count.id)}>
                  {count.countNumber} · {count.storeName}
                </button>
              </span>
            ))}
            . Post {open.length === 1 ? "it" : "them"} to correct stock.
          </span>
        </div>
      )}

      <SectionCard
        icon="scale"
        title="What the counts found"
        description="Posted counts in the period: what was short or extra against the books, at cost."
        actions={
          <button
            type="button"
            className="button button-secondary button-sm"
            onClick={exportVariance}
            disabled={variance.items.length === 0}
          >
            <Icon name="download" size={15} /> Export CSV
          </button>
        }
        flush
      >
        <div className="stk-filterbar filters">
          <div className="stk-daterange">
            <DateRangeFilter from={range.from} to={range.to} onChange={setRange} label="count period" />
          </div>
        </div>

        <div className="stk-pad stack">
        <div className="stat-grid">
          <Tile
            icon="clipboard"
            label="Counts posted"
            value={countOf(variance.countCount)}
            note={`${countOf(variance.totals.linesCounted)} item counts`}
          />
          <Tile
            icon="trend-down"
            label="Found short"
            value={money(variance.totals.shortageValue, currency)}
            tone={variance.totals.shortageValue > 0 ? "danger" : undefined}
            note="at cost, less than the books"
          />
          <Tile
            icon="trend-up"
            label="Found extra"
            value={money(variance.totals.excessValue, currency)}
            tone={variance.totals.excessValue > 0 ? "success" : undefined}
            note="more than the books"
          />
          <Tile
            icon="scale"
            label="Net difference"
            value={signedMoney(variance.totals.netValue, currency)}
            tone={variance.totals.netValue < 0 ? "danger" : variance.totals.netValue > 0 ? "success" : undefined}
            note={`${variance.totals.linesWithVariance} items off`}
          />
        </div>

        {variance.items.length === 0 ? (
          <EmptyState
            icon="clipboard"
            message="No counts posted in this period."
            hint="Count the walk-in and dry store every week; high-value items (meat, paneer, oil) every night."
          />
        ) : (
          <div className="two-column">
            <div className="stack">
              <h3 className="stk-subhead">Where the money went — items found short</h3>
              {worst.length === 0 ? (
                <p className="muted small">Nothing was short in this period.</p>
              ) : (
                <DataGrid
                  id="count-variance-worst"
                  caption="Items found short"
                  variant="compact"
                  pageSize={false}
                  currency={currency}
                  rowNoun={["item", "items"]}
                  rows={worst}
                  rowKey={(item) => item.inventoryItemId}
                  columns={[
                    {
                      key: "item",
                      header: "Item",
                      value: (item) => item.itemName,
                      mobile: "title",
                      render: (item) => (
                        <>
                          {item.itemName}
                          {item.category && <div className="muted small">{item.category}</div>}
                        </>
                      ),
                    },
                    { key: "counted", header: "Counted", type: "number", value: (item) => item.timesCounted, render: (item) => `${item.timesCounted}×` },
                    {
                      key: "short",
                      header: "Short",
                      type: "number",
                      value: (item) => item.shortageQuantity,
                      render: (item) => <span className="stk-var-short nowrap">−{qty(item.shortageQuantity, item.unitShortName)}</span>,
                    },
                    {
                      key: "value",
                      header: "Value",
                      type: "money",
                      value: (item) => item.shortageValue,
                      total: "sum",
                      render: (item) => <span className="stk-var-short">{money(item.shortageValue, currency)}</span>,
                    },
                  ]}
                />
              )}
            </div>
            <div className="stack stk-reason-bars">
              <h3 className="stk-subhead">What people said it was</h3>
              <BarList
                rows={variance.byReason.map((reason) => ({
                  label: reason.label,
                  value: Math.abs(reason.value),
                  sub: `${reason.lines} item${reason.lines === 1 ? "" : "s"}${reason.value > 0 ? ", extra" : ""}`,
                }))}
                currency={currency}
              />
            </div>
          </div>
        )}
        </div>
      </SectionCard>

      <SectionCard
        icon="history"
        title="Count history"
        description="Every sheet, newest first. Open one to carry on counting or to see what it found."
        flush
      >
        <TruncationNotice shown={counts.items.length} total={counts.total} what="counts" hint="Older sheets are not listed here." />
        <DataGrid
          id="stock-count-history"
          caption="Count history"
          rows={counts.items}
          rowKey={(count) => count.id}
          currency={currency}
          rowNoun={["count", "counts"]}
          empty="No stock counts yet."
          emptyIcon="clipboard"
          emptyHint="Start one for a storage area, count what is on the shelf, and post it."
          emptyAction={
            canCount && (
              <button type="button" className="button" onClick={() => setStarting(true)}>
                <Icon name="plus" size={16} /> Start a count
              </button>
            )
          }
          rowClassName={(count) => (count.status === "cancelled" ? "dg-tone-muted" : "")}
          exportName="stock-counts"
          columns={[
            {
              key: "number",
              header: "Count",
              value: (count) => count.countNumber,
              mobile: "title",
              pin: true,
              render: (count) => (
                <>
                  <strong className="mono">{count.countNumber}</strong>
                  <div className="muted small">{when(count.postedAt || count.createdAt)}</div>
                </>
              ),
            },
            {
              key: "store",
              header: "Store · what",
              value: (count) => count.storeName,
              csv: (count) => `${count.storeName} · ${scopeText(count.scope)}${count.blind ? " · blind" : ""}`,
              filter: "select",
              mobile: "subtitle",
              render: (count) => (
                <>
                  {count.storeName}
                  <div className="muted small">
                    {scopeText(count.scope)}
                    {count.blind ? " · blind" : ""}
                  </div>
                </>
              ),
            },
            {
              key: "counted",
              header: "Counted",
              type: "number",
              value: (count) => count.countedCount,
              csv: (count) => `${count.countedCount} of ${count.lineCount}`,
              mobile: "show",
              render: (count) => (
                <span className="nowrap">
                  {count.countedCount} of {count.lineCount}
                </span>
              ),
            },
            {
              key: "short",
              header: "Short",
              type: "money",
              value: (count) => (count.status === "posted" ? count.shortageValue : null),
              mobile: "hide",
            },
            {
              key: "extra",
              header: "Extra",
              type: "money",
              value: (count) => (count.status === "posted" ? count.excessValue : null),
              mobile: "hide",
            },
            {
              key: "net",
              header: "Net",
              type: "money",
              value: (count) => (count.status === "posted" ? count.netValue : null),
              total: "sum",
              mobile: "show",
              render: (count) =>
                count.status === "posted" ? (
                  <span className={count.netValue < 0 ? "stk-var-short" : count.netValue > 0 ? "stk-var-over" : ""}>
                    {signedMoney(count.netValue, currency)}
                  </span>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (count) => count.status,
              filter: "select",
              filterOptions: Object.entries(STATUS).map(([value, entry]) => ({ value, label: entry.label })),
              csv: (count) => STATUS[count.status].label,
              mobile: "show",
              render: (count) => (
                <>
                  <Chip tone={STATUS[count.status].tone}>{STATUS[count.status].label}</Chip>
                  {count.postedByName && <div className="muted small">by {count.postedByName}</div>}
                </>
              ),
            },
            {
              key: "open",
              header: "",
              label: "Open",
              type: "actions",
              render: (count) => (
                <button type="button" className="link-button" onClick={() => onOpen(count.id)}>
                  {count.status === "draft" ? "Continue" : "Open"}
                </button>
              ),
            },
          ]}
        />
      </SectionCard>

      {starting && (
        <StartCountDialog
          stores={stores}
          onClose={() => setStarting(false)}
          onStarted={(count) => {
            setStarting(false);
            onOpen(count.id);
          }}
        />
      )}
    </div>
  );
}

// What to count: the whole store (optionally some categories and areas), one
// storage area, or a daily spot check — the 20 items worth most on the shelf
// (paneer, ghee, chicken, liquor) or those at or below their reorder level.
const SCOPES = [
  { key: "all", label: "All items", hint: "The full count, month end" },
  { key: "area", label: "One storage area", hint: "The walk-in, the dry store" },
  { key: "high_value", label: "High-value top 20", hint: "The daily spot check" },
  { key: "low", label: "Low stock", hint: "At or below reorder level" },
];

const costOf = (item) => item.averageCost ?? item.lastCost ?? 0;

function StartCountDialog({ stores, onClose, onStarted }) {
  const { user } = useAuth();
  const [items, setItems] = useState(null);
  const [scope, setScope] = useState("all");
  const [oneArea, setOneArea] = useState(null);
  const [store, setStore] = useState("main");
  const [categories, setCategories] = useState([]);
  const [areas, setAreas] = useState([]);
  const [blind, setBlind] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const [countedAt, setCountedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listInventoryItems()
      .then((rows) => setItems(rows.filter((row) => row.status === "active")))
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const holding = stores.filter((row) => !row.outletId || row.ownStore);
  const allCategories = useMemo(
    () => [...new Set((items || []).map((item) => item.category || ""))].sort(),
    [items]
  );
  const allAreas = useMemo(
    () => [...new Set((items || []).map((item) => item.storageArea || ""))].sort(),
    [items]
  );

  const toggle = (list, setList, value) =>
    setList(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);

  // What the sheet will hold. For the spot checks this is worked out from
  // the whole restaurant's stock; the server picks them by what the chosen
  // store holds, which is the same list unless outlets keep stock of their own.
  const matching = useMemo(() => {
    const list = items || [];

    if (scope === "area") {
      return oneArea === null ? [] : list.filter((item) => (item.storageArea || "") === oneArea);
    }

    if (scope === "low") {
      return list.filter((item) => !item.stockHidden && Number(item.currentStock) <= Number(item.reorderLevel));
    }

    if (scope === "high_value") {
      return list
        .filter((item) => !item.stockHidden && item.currentStock > 0 && costOf(item) > 0)
        .sort((a, b) => b.currentStock * costOf(b) - a.currentStock * costOf(a))
        .slice(0, 20)
        .sort((a, b) => (a.storageArea || "~").localeCompare(b.storageArea || "~") || a.name.localeCompare(b.name));
    }

    return list.filter(
      (item) =>
        (categories.length === 0 || categories.includes(item.category || "")) &&
        (areas.length === 0 || areas.includes(item.storageArea || ""))
    );
  }, [items, scope, oneArea, categories, areas]);
  // For someone counting: items whose stock they cannot see are on an open
  // blind count, and a sheet over them is made blind by the server too.
  const blindAlready = matching.some((item) => item.stockHidden);

  const start = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const count = await createStockCount({
        outletId: store === "main" ? null : Number(store),
        categories: scope === "all" ? categories : [],
        storageAreas: scope === "all" ? areas : scope === "area" ? [oneArea] : [],
        ...(scope === "high_value" || scope === "low" ? { scope } : {}),
        blind: blind || blindAlready,
        countedAt: earlier && countedAt ? new Date(countedAt).toISOString() : null,
        notes: notes || null,
      });
      onStarted(count);
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  // A blank sheet for the clipboard, before anything is started: item, unit,
  // area and an empty Counted box. What the books say is left off a blind count.
  const printBlankSheet = () => {
    const isBlind = blind || blindAlready;
    const storeName = (holding.find((row) => (row.outletId ? String(row.outletId) : "main") === store) || {}).name || "Main store";
    const what =
      scope === "area"
        ? oneArea || "No storage area"
        : scope === "all"
          ? scopeText({ categories, storageAreas: areas })
          : KIND_WORDS[scope];
    const groups = matching.reduce((list, item) => {
      const key = item.storageArea || "No storage area";
      const group = list.find((entry) => entry.key === key) || list[list.push({ key, rows: [] }) - 1];
      group.rows.push(item);
      return list;
    }, []);
    const body = groups
      .map(
        (group) => `
      <h3>${escapeHtml(group.key)}</h3>
      <table>
        <thead><tr><th>Item</th><th>Unit</th><th>Area</th>${isBlind ? "" : "<th class='r'>Books say</th>"}<th class='r'>Counted</th><th>Note</th></tr></thead>
        <tbody>
          ${group.rows
            .map(
              (item) => `<tr><td>${escapeHtml(item.name)}${
                item.packs && item.packs.length
                  ? `<br><small>${item.packs.map((pk) => `${escapeHtml(pk.name)} = ${qty(pk.size, item.unitShortName)}`).join(", ")}</small>`
                  : ""
              }</td><td>${escapeHtml(item.unitShortName)}</td><td>${escapeHtml(item.storageArea || "")}</td>${
                isBlind ? "" : `<td class='r'>${item.stockHidden ? "" : qty(item.currentStock)}</td>`
              }<td class='r box'></td><td class='box wide'></td></tr>`
            )
            .join("")}
        </tbody>
      </table>`
      )
      .join("");

    printDocument({
      title: "Stock count sheet",
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        h3 { font-size: 13px; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #999; padding: 5px 6px; text-align: left; vertical-align: top; }
        th { background: #eee; font-size: 11px; }
        .r { text-align: right; }
        .box { min-width: 70px; height: 22px; }
        .wide { min-width: 140px; }
        .meta { color: #444; margin-bottom: 8px; }`,
      body: `
        <h1>Stock count sheet — ${escapeHtml(storeName)}</h1>
        <div class="meta">${escapeHtml((user && user.restaurantName) || "")} · ${escapeHtml(what)} · ${matching.length} items${isBlind ? " · blind count" : ""} · printed ${escapeHtml(dayMonth(new Date(), { time: true }) || "")}<br>
        Counted by: ____________________ &nbsp; Checked by: ____________________</div>
        ${body}`,
    });
  };

  return (
    <Modal
      title="Start a stock count"
      description="Pick what is being counted; the sheet lists it in the order you walk the store."
      icon="clipboard"
      onClose={onClose}
      width={640}
    >
      {!items ? (
        <Loading />
      ) : (
        <form className="stack stk-scope" onSubmit={start}>
          <ErrorMessage message={error} />

          {holding.length > 1 && (
            <label className="field">
              <span>Store being counted</span>
              <select value={store} onChange={(event) => setStore(event.target.value)}>
                {holding.map((row) => (
                  <option key={row.outletId || "main"} value={row.outletId ? String(row.outletId) : "main"}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="field">
            <span>What to count</span>
            <div className="stk-scope-choices" role="radiogroup" aria-label="What to count">
              {SCOPES.map((choice) => (
                <button
                  type="button"
                  key={choice.key}
                  role="radio"
                  aria-checked={scope === choice.key}
                  className="stk-scope-choice"
                  onClick={() => setScope(choice.key)}
                >
                  <strong>{choice.label}</strong>
                  <span>{choice.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {scope === "area" && (
            <div className="field">
              <span>Storage area</span>
              <div className="stk-picker" role="radiogroup" aria-label="Storage area">
                {allAreas.map((value) => (
                  <button
                    type="button"
                    key={value || "none"}
                    role="radio"
                    aria-checked={oneArea === value}
                    aria-pressed={oneArea === value}
                    onClick={() => setOneArea(value)}
                  >
                    {value || "No area set"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {scope === "all" && (
          <>
          <div className="field">
            <span>Storage areas (none picked = all)</span>
            <div className="stk-picker">
              {allAreas.map((value) => (
                <button
                  type="button"
                  key={value || "none"}
                  aria-pressed={areas.includes(value)}
                  onClick={() => toggle(areas, setAreas, value)}
                >
                  {value || "No area set"}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>Categories (none picked = all)</span>
            <div className="stk-picker">
              {allCategories.map((value) => (
                <button
                  type="button"
                  key={value || "none"}
                  aria-pressed={categories.includes(value)}
                  onClick={() => toggle(categories, setCategories, value)}
                >
                  {value || "No category"}
                </button>
              ))}
            </div>
          </div>
          </>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={blind || blindAlready}
              disabled={blindAlready}
              onChange={(event) => setBlind(event.target.checked)}
            />
            <span>
              Blind count — the people counting do not see what the system expects, so they count what is
              really there
            </span>
          </label>
          {blindAlready && (
            <p className="muted small">
              Some of these items are already being counted blind, so this sheet is blind too.
            </p>
          )}

          <label className="checkbox">
            <input type="checkbox" checked={earlier} onChange={(event) => setEarlier(event.target.checked)} />
            <span>It was counted earlier (for example last night after closing)</span>
          </label>

          {earlier && (
            <label className="field">
              <span>Counted at</span>
              <input
                type="datetime-local"
                value={countedAt}
                onChange={(event) => setCountedAt(event.target.value)}
                required
              />
              <small className="muted">
                The system compares against what it expected at that moment, so sales since then are not
                counted as missing.
              </small>
            </label>
          )}

          <label className="field">
            <span>Notes</span>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Weekly count, walk-in" />
          </label>

          <div className="alert alert-info">
            <span>
              <strong>{matching.length}</strong> item{matching.length === 1 ? "" : "s"} will be on the sheet, in
              the order you walk the store. Items already on another open count for this store are left off.
              {scope === "area" && oneArea === null ? " Pick the storage area above." : ""}
            </span>
          </div>

          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={printBlankSheet}
              disabled={matching.length === 0}
              title="A paper sheet to count on first; type the figures in after starting the count"
            >
              <Icon name="print" size={16} /> Print count sheet
            </button>
            <button type="submit" className="button" disabled={busy || matching.length === 0}>
              {busy ? "Starting…" : "Start counting"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// What someone typed for one line: a quantity in the item's unit, or packs
// plus loose units when the item has a pack ("2 tins and 3.5 L").
const smallestPack = (line) => (line.packs.length ? [...line.packs].sort((a, b) => a.size - b.size)[0] : null);

const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

// A counted figure split back into whole packs and what is left over.
const splitPacks = (value, pack) => {
  if (value === null || value === undefined || !pack) {
    return { packs: "", loose: "" };
  }

  const whole = Math.floor(round3(value) / pack.size);

  return { packs: String(whole), loose: String(round3(value - whole * pack.size)) };
};

const typedQuantity = (edit, line) => {
  if (!edit) {
    return line.countedQuantity;
  }

  const pack = smallestPack(line);

  if (pack) {
    if (edit.packs === "" && edit.loose === "") {
      return null;
    }

    return round3(Number(edit.packs || 0) * pack.size + Number(edit.loose || 0));
  }

  return edit.counted === "" ? null : Number(edit.counted);
};

function CountSheet({ id, currency, onBack }) {
  const { hasPermission, user } = useAuth();
  const canCount = hasPermission("inventory.count");
  const canPost = hasPermission("inventory.manage");
  const [sheet, setSheet] = useState(null);
  const [edits, setEdits] = useState({});
  const [areaFilter, setAreaFilter] = useState("");
  const [show, setShow] = useState("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(
    () =>
      getStockCount(id)
        .then((data) => {
          setSheet(data);
          setEdits({});
        })
        .catch((err) => setError(getErrorMessage(err))),
    [id]
  );

  useEffect(() => {
    load();
  }, [load]);

  const draft = sheet && sheet.status === "draft";
  const editable = draft && canCount;

  const rows = useMemo(() => {
    if (!sheet) {
      return [];
    }

    return sheet.lines.map((line) => {
      const edit = edits[line.id];
      const counted = typedQuantity(edit, line);
      const reason = edit && edit.reason !== undefined ? edit.reason : line.reason || "";
      const note = edit && edit.note !== undefined ? edit.note : line.note || "";
      const variance =
        counted === null || line.systemQuantity === null
          ? null
          : Math.round((counted - line.systemQuantity) * 1000) / 1000;
      const value =
        variance === null ? null : Math.round(variance * (line.unitCost || 0) * 100) / 100;

      return { ...line, counted, reason, note, variance, value, dirty: Boolean(edit), edit };
    });
  }, [sheet, edits]);

  if (!sheet) {
    return error ? <ErrorMessage message={error} /> : <Loading />;
  }

  const areas = [...new Set(sheet.lines.map((line) => line.storageArea || ""))];
  const countedCount = rows.filter((row) => row.counted !== null).length;
  const dirtyCount = rows.filter((row) => row.dirty).length;
  const withVariance = rows.filter((row) => row.variance !== null && row.variance !== 0);
  const needReason = withVariance.filter((row) => !row.reason).length;
  const shortage = withVariance.filter((row) => row.value < 0).reduce((sum, row) => sum - row.value, 0);
  const excess = withVariance.filter((row) => row.value > 0).reduce((sum, row) => sum + row.value, 0);

  const visible = rows.filter(
    (row) =>
      (!areaFilter || (row.storageArea || "") === areaFilter) &&
      (!search || row.itemName.toLowerCase().includes(search.toLowerCase())) &&
      (show === "all" ||
        (show === "todo" && row.counted === null) ||
        (show === "diff" && row.variance !== null && row.variance !== 0))
  );

  const groups = [];

  for (const row of visible) {
    const key = row.storageArea || "";
    const last = groups[groups.length - 1];

    if (last && last.key === key) {
      last.rows.push(row);
    } else {
      groups.push({ key, rows: [row] });
    }
  }

  const edit = (line, patch) =>
    setEdits((current) => {
      const pack = smallestPack(line);
      const base = current[line.id] || {
        counted: line.countedQuantity === null ? "" : String(line.countedQuantity),
        ...splitPacks(line.countedQuantity, pack),
        reason: line.reason || "",
        note: line.note || "",
      };

      return { ...current, [line.id]: { ...base, ...patch } };
    });

  const sheetColumns = countSheetColumns({ sheet, editable, currency, onEdit: edit });

  const save = async () => {
    setBusy(true);
    setError("");

    try {
      const lines = rows
        .filter((row) => row.dirty)
        .map((row) => ({
          id: row.id,
          countedQuantity: row.counted,
          reason: row.reason || null,
          note: row.note || null,
        }));

      setSheet(await saveStockCountLines(id, { lines }));
      setEdits({});
      setSuccess(`Saved ${lines.length} line${lines.length === 1 ? "" : "s"}`);
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const post = async () => {
    setBusy(true);
    setError("");

    try {
      if (dirtyCount > 0 && !(await save())) {
        return;
      }

      setSheet(await postStockCount(id));
      setSuccess("Count posted — stock now matches what was counted");
      setConfirming(null);
    } catch (err) {
      setError(getErrorMessage(err));
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);

    try {
      setSheet(await cancelStockCount(id));
      setConfirming(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // A sheet to take round the store on a clipboard, in walking order. The
  // expected figures stay off it whenever they are off the screen.
  const printSheet = () => {
    const noExpected = sheet.blind || sheet.expectedHidden || sheet.status === "posted";
    const body = groups.length
      ? rows
          .reduce((list, row) => {
            const key = row.storageArea || "No storage area";
            const group = list.find((entry) => entry.key === key) || list[list.push({ key, rows: [] }) - 1];
            group.rows.push(row);
            return list;
          }, [])
          .map(
            (group) => `
          <h3>${escapeHtml(group.key)}</h3>
          <table>
            <thead><tr><th>Item</th><th>Unit</th>${noExpected ? "" : "<th class='r'>Expected</th>"}<th class='r'>Counted</th><th>Note</th></tr></thead>
            <tbody>
              ${group.rows
                .map(
                  (row) => `<tr><td>${escapeHtml(row.itemName)}${
                    row.packs.length ? `<br><small>${row.packs.map((p) => `${escapeHtml(p.name)} = ${qty(p.size, row.unitShortName)}`).join(", ")}</small>` : ""
                  }</td><td>${escapeHtml(row.unitShortName)}</td>${
                    noExpected ? "" : `<td class='r'>${row.systemQuantity === null ? "" : qty(row.systemQuantity)}</td>`
                  }<td class='r box'>${row.counted === null ? "" : qty(row.counted)}</td><td class='box wide'></td></tr>`
                )
                .join("")}
            </tbody>
          </table>`
          )
          .join("")
      : "";

    printDocument({
      title: `${sheet.countNumber} count sheet`,
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        h3 { font-size: 13px; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #999; padding: 5px 6px; text-align: left; vertical-align: top; }
        th { background: #eee; font-size: 11px; }
        .r { text-align: right; }
        .box { min-width: 70px; height: 22px; }
        .wide { min-width: 140px; }
        .meta { color: #444; margin-bottom: 8px; }`,
      body: `
        <h1>Stock count ${escapeHtml(sheet.countNumber)} — ${escapeHtml(sheet.storeName)}</h1>
        <div class="meta">${escapeHtml(user.restaurantName || "")} · ${escapeHtml(scopeText(sheet.scope))} · printed ${escapeHtml(new Date().toLocaleString("en-IN"))}<br>
        Counted by: ____________________ &nbsp; Checked by: ____________________</div>
        ${body}`,
    });
  };

  const exportCsv = () =>
    downloadCsv(
      [
        ["Item", "Category", "Storage area", "Unit", "Expected", "Counted", "Difference", "Unit cost", "Value", "Reason", "Note"],
        ...rows.map((row) => [
          row.itemName,
          row.category || "",
          row.storageArea || "",
          row.unitShortName,
          row.systemQuantity ?? "",
          row.counted ?? "",
          row.variance ?? "",
          row.unitCost ?? "",
          row.value ?? "",
          row.reasonLabel || (sheet.reasons.find((r) => r.value === row.reason) || {}).label || "",
          row.note || "",
        ]),
      ],
      `${sheet.countNumber}.csv`
    );

  const status = STATUS[sheet.status];
  const progress = sheet.lines.length ? Math.round((countedCount / sheet.lines.length) * 100) : 0;

  return (
    <div className="stack">
      <div className="stk-section-title stk-sheet-head">
        <div>
          <button type="button" className="link-button stk-back" onClick={onBack}>
            <Icon name="arrow-left" size={15} /> All counts
          </button>
          <h2>
            <span className="mono">{sheet.countNumber}</span> · {sheet.storeName}{" "}
            <Chip tone={status.tone}>{status.label}</Chip>{" "}
            {sheet.blind && <Chip tone="info">Blind count</Chip>}
          </h2>
          <p className="muted small">
            {scopeText(sheet.scope)} · started {when(sheet.createdAt)} by {sheet.createdByName || "—"}
            {sheet.countedAt ? ` · counted at ${when(sheet.countedAt)}` : ""}
            {sheet.postedAt ? ` · posted ${when(sheet.postedAt)} by ${sheet.postedByName}` : ""}
            {sheet.notes ? ` · ${sheet.notes}` : ""}
          </p>
        </div>
        <div className="stk-actions">
          <button type="button" className="button button-secondary" onClick={printSheet}>
            <Icon name="print" size={16} /> {draft ? "Print count sheet" : "Print"}
          </button>
          {!sheet.expectedHidden && (
            <button type="button" className="button button-secondary" onClick={exportCsv}>
              <Icon name="download" size={16} /> Export CSV
            </button>
          )}
        </div>
      </div>

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <div className="card stack">
        <div className="stack">
          <div>
            <div className="muted small stk-progress-label">
              {countedCount} of {sheet.lines.length} items counted
              {draft && countedCount < sheet.lines.length ? " — items left blank are not changed when posted" : ""}
            </div>
            <div className="stk-progress" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>
          {!sheet.expectedHidden && (
            <div className="stat-grid">
              <Tile
                icon="trend-down"
                label="Short"
                value={money(shortage, currency)}
                tone={shortage > 0 ? "danger" : undefined}
              />
              <Tile
                icon="trend-up"
                label="Extra"
                value={money(excess, currency)}
                tone={excess > 0 ? "success" : undefined}
              />
              <Tile
                icon="scale"
                label="Net"
                value={signedMoney(excess - shortage, currency)}
                tone={excess - shortage < 0 ? "danger" : excess - shortage > 0 ? "success" : undefined}
              />
              {draft && (
                <Tile
                  icon="message"
                  label="Need a reason"
                  value={needReason}
                  tone={needReason > 0 ? "warning" : undefined}
                />
              )}
            </div>
          )}
        </div>

        {sheet.expectedHidden && (
          <div className="alert alert-info">
            <span>
              {sheet.blind
                ? "Blind count: count what is on the shelf and type it in. A manager sees the differences and posts the count."
                : "Some of these items are being counted blind on another sheet, so what the system expects stays hidden here too. Count what is on the shelf and type it in; a manager sees the differences and posts the count."}
            </span>
          </div>
        )}

        <div className="stk-toolbar">
          <label className="field">
            <span>Find</span>
            <span className="input-with-icon">
              <Icon name="search" size={17} className="input-icon" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Item name"
              />
            </span>
          </label>
          {areas.length > 1 && (
            <label className="field">
              <span>Storage area</span>
              <select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}>
                <option value="">All areas</option>
                {areas.map((value) => (
                  <option key={value || "none"} value={value}>
                    {value || "No area set"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="field stk-show">
            <span>Show</span>
            <div className="segmented" role="radiogroup" aria-label="Which lines">
              {[
                { key: "all", label: "All" },
                { key: "todo", label: "Not counted" },
                ...(sheet.expectedHidden ? [] : [{ key: "diff", label: "Differences" }]),
              ].map((option) => (
                <button
                  type="button"
                  key={option.key}
                  role="radio"
                  aria-checked={show === option.key}
                  className={`segment ${show === option.key ? "is-active" : ""}`}
                  onClick={() => setShow(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* One entry grid per storage area, in walking order, so the sheet on
            screen follows the walk through the store like the printed one. */}
        {groups.length === 0 ? (
          <DataGrid variant="editor" caption="Count sheet" columns={sheetColumns} rows={[]} empty="Nothing matches." emptyIcon="search" />
        ) : (
          groups.map((group) => (
            <div key={group.key || "none"} className="stack stk-count-group">
              <h3 className="stk-subhead">
                {group.key || "No storage area"} · {group.rows.length}
              </h3>
              <DataGrid
                variant="editor"
                caption={`Count sheet: ${group.key || "no storage area"}`}
                columns={sheetColumns}
                rows={group.rows}
                rowKey={(row) => row.id}
                rowNoun={["item", "items"]}
              />
            </div>
          ))
        )}

        {draft && (
          <div className="form-actions stk-count-actions">
            {canPost && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setConfirming("cancel")}
                disabled={busy}
              >
                Cancel this count
              </button>
            )}
            {editable && (
              <button type="button" className="button button-secondary" onClick={save} disabled={busy || dirtyCount === 0}>
                {busy ? "Saving…" : dirtyCount ? `Save ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}` : "Saved"}
              </button>
            )}
            {canPost && (
              <button
                type="button"
                className="button"
                onClick={() => setConfirming("post")}
                disabled={busy || countedCount === 0 || needReason > 0}
                title={needReason > 0 ? "Give a reason for every difference first" : undefined}
              >
                Post count
              </button>
            )}
          </div>
        )}
      </div>

      {confirming === "post" && (
        <Modal title={`Post ${sheet.countNumber}?`} icon="check-circle" onClose={() => setConfirming(null)} width={460}>
          <div className="stack">
            <p>
              Stock for the {countedCount} counted item{countedCount === 1 ? "" : "s"} is set to what was counted.
              {withVariance.length > 0 && (
                <>
                  {" "}
                  {withVariance.length} item{withVariance.length === 1 ? " is" : "s are"} off — short{" "}
                  <strong>{moneyExact(shortage, currency)}</strong>, extra <strong>{moneyExact(excess, currency)}</strong>.
                </>
              )}
            </p>
            <p className="muted small">Sales billed after each item was counted are kept. This cannot be undone.</p>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setConfirming(null)}>
                Not yet
              </button>
              <button type="button" className="button" onClick={post} disabled={busy}>
                {busy ? "Posting…" : "Post and correct stock"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirming === "cancel" && (
        <Modal title={`Cancel ${sheet.countNumber}?`} icon="alert" onClose={() => setConfirming(null)} width={440}>
          <div className="stack">
            <p>The sheet is kept in the history as cancelled. Stock is not changed.</p>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setConfirming(null)}>
                Keep counting
              </button>
              <button type="button" className="button button-danger" onClick={cancel} disabled={busy}>
                Cancel count
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// The count sheet's columns. The figures typed in are held in `edits` (row.edit)
// until saved, so a line keeps what was typed when the grid redraws (a phone
// turning sideways swaps the table for cards).
const DASH = <span className="muted">—</span>;

function countSheetColumns({ sheet, editable, currency, onEdit }) {
  const hidden = sheet.expectedHidden;
  const anyPacks = sheet.lines.some((line) => line.packs.length > 0);
  const typed = (row, field, fallback) => (row.edit && row.edit[field] !== undefined ? row.edit[field] : fallback);

  return [
    {
      key: "item",
      header: "Item",
      value: (row) => row.itemName,
      mobile: "title",
      render: (row) => (
        <>
          <strong>{row.itemName}</strong>
          <div className="muted small">
            {row.category || "—"}
            {row.packs.length > 0 && ` · ${row.packs.map((p) => `${p.name} = ${qty(p.size, row.unitShortName)}`).join(", ")}`}
          </div>
        </>
      ),
    },
    !hidden && {
      key: "expected",
      header: "Expected",
      type: "number",
      value: (row) => row.systemQuantity,
      render: (row) => (row.systemQuantity === null ? DASH : <span className="nowrap">{qty(row.systemQuantity, row.unitShortName)}</span>),
    },
    {
      key: "counted",
      header: "Counted",
      type: "number",
      minWidth: editable ? (anyPacks ? 300 : 170) : undefined,
      value: (row) => row.counted,
      render: (row) => {
        const pack = smallestPack(row);

        if (!editable) {
          return row.counted === null ? <span className="muted">Not counted</span> : qty(row.counted, row.unitShortName);
        }

        const split = splitPacks(row.countedQuantity, pack);

        return (
          <>
            <div className="stk-count-input">
              {pack ? (
                <>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    aria-label={`${row.itemName}: whole ${pack.name}s`}
                    placeholder="0"
                    className={row.counted !== null ? "is-counted" : ""}
                    value={typed(row, "packs", split.packs)}
                    onChange={(event) => onEdit(row, { packs: event.target.value })}
                  />
                  <span className="stk-unit">{pack.name}</span>
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    inputMode="decimal"
                    aria-label={`${row.itemName}: loose ${row.unitShortName}`}
                    placeholder="0"
                    className={row.counted !== null ? "is-counted" : ""}
                    value={typed(row, "loose", split.loose)}
                    onChange={(event) => onEdit(row, { loose: event.target.value })}
                  />
                  <span className="stk-unit">{row.unitShortName}</span>
                </>
              ) : (
                <>
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    inputMode="decimal"
                    aria-label={`${row.itemName} counted`}
                    className={row.counted !== null ? "is-counted" : ""}
                    value={typed(row, "counted", row.countedQuantity === null ? "" : String(row.countedQuantity))}
                    onChange={(event) => onEdit(row, { counted: event.target.value })}
                  />
                  <span className="stk-unit">{row.unitShortName}</span>
                </>
              )}
            </div>
            {pack && row.counted !== null && <span className="stk-line-note">= {qty(row.counted, row.unitShortName)}</span>}
          </>
        );
      },
    },
    !hidden && {
      key: "difference",
      header: "Difference",
      type: "number",
      value: (row) => row.variance,
      render: (row) =>
        row.variance === null ? (
          DASH
        ) : (
          <span className={`nowrap ${row.variance < 0 ? "stk-var-short" : row.variance > 0 ? "stk-var-over" : ""}`}>
            {row.variance === 0 ? "Matches" : signed(row.variance, row.unitShortName)}
          </span>
        ),
    },
    !hidden && {
      key: "value",
      header: "Value",
      type: "money",
      value: (row) => (row.value === 0 ? null : row.value),
      render: (row) =>
        row.value === null || row.value === 0 ? (
          DASH
        ) : (
          <span className={`nowrap ${row.value < 0 ? "stk-var-short" : "stk-var-over"}`}>{signedMoney(row.value, currency)}</span>
        ),
    },
    {
      key: "reason",
      header: "Reason · note",
      minWidth: editable ? 190 : undefined,
      className: "stk-count-reason",
      value: (row) => row.reason,
      render: (row) => {
        const needsReason = row.variance !== null && row.variance !== 0 && !row.reason;

        return editable ? (
          <div className="stack" style={{ gap: 4 }}>
            <select
              value={row.reason}
              className={needsReason ? "needs-reason" : ""}
              aria-label={`Why ${row.itemName} is different`}
              onChange={(event) => onEdit(row, { reason: event.target.value })}
              disabled={!hidden && (row.variance === null || row.variance === 0) && !row.reason}
            >
              <option value="">{needsReason ? "Why is it different?" : "Reason"}</option>
              {sheet.reasons.map((reason) => (
                <option key={reason.value} value={reason.value}>
                  {reason.label}
                </option>
              ))}
            </select>
            <input
              value={row.note}
              placeholder="Note"
              maxLength={200}
              aria-label={`Note for ${row.itemName}`}
              onChange={(event) => onEdit(row, { note: event.target.value })}
            />
          </div>
        ) : (
          <span className="small">
            {row.reasonLabel || (sheet.reasons.find((r) => r.value === row.reason) || {}).label || "—"}
            {row.note && <div className="muted">{row.note}</div>}
          </span>
        );
      },
    },
  ];
}
