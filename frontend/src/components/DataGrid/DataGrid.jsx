/* =====================================================================================
   DataGrid — every list in the app, drawn and behaving the same way.

   import DataGrid from "../../components/DataGrid/DataGrid";

   <DataGrid
     id="purchase-orders"            // stable id: column widths, hidden columns, row height and rows per
                                     // page are remembered per viewer (localStorage, every access guarded)
     caption="Purchase orders"       // read by screen readers (visually hidden)
     columns={[
       { key: "number", header: "PO no.", value: (r) => r.poNumber, mobile: "title", pin: true },
       { key: "supplier", header: "Supplier", value: (r) => r.supplierName, filter: "text" },
       { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge … />, filter: "select" },
       { key: "date", header: "Date", type: "date", value: (r) => r.createdAt },
       { key: "total", header: "Total", type: "money", value: (r) => r.total, total: "sum" },
       { key: "actions", header: "", type: "actions", render: (r) => <ActionMenu … /> },
     ]}
     rows={rows}
     rowKey={(r) => r.id}            // default: r.id, else the row's position (read once, on mount)
     loading={loading}               // first load: 6 shimmering rows; a reload keeps the rows + a thin bar
     error={error}                   // message string, shown inside the grid; onRetry={load} adds "Try again"
     empty="No purchase orders yet"  // + emptyHint="…", emptyIcon="receipt", emptyAction={<button…>}
     toolbar={<>page filters / buttons</>}  // the grid's toolbar row, left of the grid's own controls
     onRowClick={(r) => open(r)}     // whole row clickable; Enter opens, ArrowUp/ArrowDown move.
                                     // Omit when rows have their own buttons.
     selectable                      // checkboxes; bulkActions={(selectedRows, clear) => <…/>},
                                     // onSelectionChange={(selectedRows) => …}
                                     // canSelect={(r) => r.status === "open"}: only these rows get a
                                     // working box (others greyed, skipped by "select all")
     pageSize={25}                   // client paging, picker 25 / 50 / 100; false = every row, no pager
     server={{ total, page, pageSize, sort, onChange }}  // the API pages (and maybe sorts): see below
     exportName="purchase-orders"    // "Export CSV": S.No. + visible columns, every filtered row in the
                                     // current order, money as plain numbers, dates YYYY-MM-DD
     variant="full"                  // full | compact (no toolbar; small tables in cards and dialogs)
                                     // | editor (entry lines inside a form)
     rowClassName={(r) => …}         // e.g. "dg-tone-danger" — see the row tones below
     footer={…}                      // a custom <tfoot> row, or (ctx) => row; replaces the automatic totals.
                                     // ctx = { columns, leading, totals, rows, cards }: `leading` cells
                                     // (S.No., checkbox) come before the first column; on phones
                                     // (ctx.cards) return any element instead of a <tr>.
     search                          // true | false | "placeholder" | { value, onChange, placeholder }
     defaultSort={{ key: "date", direction: "desc" }}   // the order before anyone clicks a header
     serial                          // S.No. column, first, on by default: 1, 2, 3… in the order shown,
                                     // running on across pages (page 2 at 25 a page starts at 26; with
                                     // server paging (page - 1) * pageSize + 1). Not sortable or
                                     // hideable; first column of the CSV; "#12" on phone cards, "Line 3"
                                     // in an editor. serial={false} only where a number would mislead,
                                     // with a comment saying why.
     cardsBelow={640}                // grid width (px) under which rows become phone cards
                                     // (default 640; 480 for compact; 0 = never)
     currency={currency}             // the restaurant's symbol for money cells and totals (default ₹);
                                     // a column's own `currency` wins. CSV headings name it: "Total (AED)".
     rowNoun={["buyer", "buyers"]}   // what the totals label counts: "Total · 12 buyers" (or "buyer";
                                     // default rows, lines in an editor)
   />

   Column fields
     key            unique, stable (it names the remembered width and the CSV column)
     header         heading (text or a node); label: the words when the header is an icon or empty
     value(row)     the raw value used for sort, search, filter, totals and CSV (default row[key])
     render(row, ctx)  what the cell shows (default: the value, formatted for its type).
                    ctx = { index, serial, label, card } — in an editor give each input aria-label={ctx.label}
     type           text | number | money | percent | date | datetime | status | actions
     exact          money only: always two decimals (moneyExact) — bills, payments, tax. Negative
                    money reads "−₹3,868.40". currency: this column's symbol (default: the grid's)
     align          left | right | center (number, money, percent and actions default right)
     sortable       default true (never for actions)
     filter         text | select | none;  filterOptions: [{ value, label }] for a select (default: the
                    values present)
     total          sum | count | none — over ALL filtered rows, labelled "Total · 312 rows"
     width, minWidth  starting width and the narrowest it may be (px). Unsized columns fit their
                    content (words at least 8.5rem, the title column 12rem); an editor's figure
                    columns start at 140px.
     pin            stays put while the grid scrolls sideways. Order never changes: every column
                    before a pinned one is pinned with it. Without any pin, the first column is
                    pinned (and the title column when it comes second).
                    A last column of type "actions" pins to the RIGHT edge (pin: false opts out).
     hideable       default true, except pinned, title and actions columns
     defaultHidden  starts hidden; the column menu can show it
     mobile         title | subtitle | show | hide — the phone card. Without any "show", the card
                    lists the first 4 visible columns after the title and subtitles.
     searchable     include in the quick search (default: text and status columns)
     csv(row)       the exported value, when value(row) is not what a spreadsheet wants
     className      extra class on the column's cells

   server mode (the API pages): rows are one page as the API returned them; the grid does not
   sort, filter or slice them. It shows server.total / page / pageSize in the pager and calls
     server.onChange({ page, pageSize, sort, filters })
   for every change. Rows per page is remembered per `id`: on mount, if the remembered size differs
   from server.pageSize, the grid calls onChange once with it; start the page's state with
   rememberedPageSize(id, 25) from "./useGridLayout" to skip that second request.
   Header sorting appears only when the object has a `sort` key (the API sorts).
   Column filters are reported, not applied. Search: pass search={{ value, onChange }} and query the
   API. Optional: server.totals = { key: amount } for true totals (else totals say "This page"),
   server.fetchAll = async () => allRows for a full CSV export (else the page on show is exported).

   Row tones for rowClassName: dg-tone-danger (overdue, short), dg-tone-warning, dg-tone-success,
   dg-tone-muted (closed, switched off).
   ===================================================================================== */

import { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Icon from "../Icon";
import { EmptyState } from "../Feedback";
import { downloadCsv } from "../../services/csv";
import { today } from "../../services/dates";
import { count } from "../../services/format";
import {
  computeTotals,
  csvValue,
  directionWords,
  filterOptions,
  formatTotal,
  formatValue,
  humanise,
  isEmpty,
  isNumeric,
  nextSort,
  normaliseColumns,
  prepareRows,
  readValue,
  searchText,
  sortPrepared,
} from "./gridModel";
import useGridLayout from "./useGridLayout";
import useContainerWidth from "./useContainerWidth";
import GridPager from "./GridPager";
import GridColumnMenu from "./GridColumnMenu";
import GridCards from "./GridCards";
import "../../styles/data-grid.css";

const PAGE_SIZES = [25, 50, 100];
const SKELETON_ROWS = 6;
const MIN_WIDTH = 56;
const MAX_WIDTH = 900;
// A list longer than this scrolls inside a frame about one screen tall, so
// its header stays in view; shorter lists are left at their own height.
const FRAME_AFTER = 15;
const INTERACTIVE = "a, button, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [role='checkbox']";

// Where the visible part of the page starts for this element: the top of
// the box it scrolls in (the app scrolls its page area, under the top bar),
// or the window.
const visibleTop = (node) => {
  for (let box = node.parentElement; box; box = box.parentElement) {
    const { overflowY } = window.getComputedStyle(box);

    if ((overflowY === "auto" || overflowY === "scroll") && box.scrollHeight > box.clientHeight) {
      return Math.max(0, box.getBoundingClientRect().top);
    }
  }

  return 0;
};

// Columns hidden under the right-pinned actions: there is more table to the
// right of what shows, so the actions column casts a soft shadow leftwards.
const markMoreRight = (box) => {
  box.classList.toggle("has-more-right", box.scrollLeft + box.clientWidth < box.scrollWidth - 2);
};

const defaultKey = (row, index) => (row && row.id !== undefined && row.id !== null ? row.id : index);
// The narrowest a column may be made: its own minWidth, else room for a
// heading of words on two lines (about 110px), else room for a figure.
const WORDY = new Set(["text", "status", "date", "datetime"]);
// A heading may wrap between words, never inside one: its longest word (about
// 8px a letter at the header's size, plus padding and the sort arrow) sets a
// floor too, so "Quantity" in a 70px column is not cut to "Quanti".
const headingFloor = (column) => {
  const words = String(column.label || "").split(/\s+/);
  const longest = Math.max(0, ...words.map((word) => word.length));
  return longest ? Math.ceil(longest * 8.2 + 60) : 0;
};
const minOf = (column) => column.minWidth || Math.max(WORDY.has(column.type) ? 110 : MIN_WIDTH, headingFloor(column));
const clampWidth = (width, column) => Math.round(Math.min(MAX_WIDTH, Math.max(minOf(column), width)));

// Roughly how wide a table needs to be before its words get squeezed, from
// the same minimums the stylesheet gives each kind of column. Used to keep a
// small table a table in a narrow dialog rather than turning it into cards.
const naturalWidth = (column) => {
  if (column.width) {
    return Math.max(column.width, minOf(column));
  }

  if (column.minWidth) {
    return column.minWidth + 16;
  }

  if (column.isTitle) {
    return 192;
  }

  return { text: 136, status: 120, datetime: 150, date: 104, actions: 96 }[column.type] || 100;
};

// The DataGrid a page renders. Its `id` names everything the grid remembers
// and keeps (layout, sort, filters, page, selection, row keys), so a grid
// whose id changes — a tab bar showing two lists in one place — starts afresh
// as the other list instead of carrying the first one's state across.
export default function DataGrid(props) {
  return <DataGridView key={props.id ?? ""} {...props} />;
}

function DataGridView({
  id,
  caption,
  columns,
  rows,
  rowKey,
  loading = false,
  error = "",
  onRetry,
  empty = "Nothing here yet",
  emptyHint,
  emptyIcon,
  emptyAction,
  toolbar,
  onRowClick,
  selectable = false,
  canSelect,
  bulkActions,
  onSelectionChange,
  pageSize = 25,
  server,
  exportName,
  variant = "full",
  rowClassName,
  footer,
  search: searchProp,
  defaultSort = null,
  serial = true,
  cardsBelow,
  currency,
  rowNoun,
  className = "",
}) {
  const editor = variant === "editor";
  const compact = variant === "compact";
  const full = !editor && !compact;
  const serverMode = Boolean(server) && !editor;
  const label = caption || "Table";

  const rootRef = useRef(null);
  const scrollRef = useRef(null);
  const tableRef = useRef(null);
  const revealedRef = useRef(false);
  const filterPanelId = useId();

  const [layout, updateLayout] = useGridLayout(editor ? undefined : id);
  const [sortState, setSortState] = useState(defaultSort);
  const [searchState, setSearchState] = useState("");
  const [filters, setFilters] = useState({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pageState, setPageState] = useState(1);
  const [selected, setSelected] = useState(() => new Set());
  const [activeKey, setActiveKey] = useState(null);
  const [printing, setPrinting] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ---- Columns ------------------------------------------------------------------
  // Recomputed when `columns` changes identity; for a long list, build the
  // array with useMemo so a page re-render does not re-read every row.
  const cols = useMemo(() => normaliseColumns(columns, { currency }), [columns, currency]);
  const hiddenMap = useMemo(() => (full && layout.hidden) || {}, [full, layout.hidden]);
  const isHidden = useCallback(
    (column) => (column.hideable ? (hiddenMap[column.key] ?? Boolean(column.defaultHidden)) : false),
    [hiddenMap]
  );
  const visible = useMemo(() => cols.map((column, index) => ({ column, index })).filter(({ column }) => !isHidden(column)), [cols, isHidden]);
  const visibleCols = useMemo(() => visible.map(({ column }) => column), [visible]);
  const indexOf = useMemo(() => new Map(cols.map((column, index) => [column.key, index])), [cols]);

  // ---- Rows ---------------------------------------------------------------------
  // rowKey is taken once: an inline arrow is a new function on every render,
  // and depending on it would rebuild every row's values each time, while the
  // key it gives a row never changes.
  const [keyOf] = useState(() => rowKey || defaultKey);
  const prepared = useMemo(() => prepareRows(rows, cols, keyOf), [rows, cols, keyOf]);

  // ---- Search and filters -------------------------------------------------------
  const controlledSearch = searchProp && typeof searchProp === "object";
  const searchValue = controlledSearch ? String(searchProp.value ?? "") : searchState;
  const searchPlaceholder =
    (controlledSearch && searchProp.placeholder) || (typeof searchProp === "string" && searchProp) || "Search…";
  const showSearch =
    full &&
    searchProp !== false &&
    (controlledSearch || (!serverMode && (Boolean(searchProp) || prepared.length > 8 || searchValue !== "")));
  // Typing stays instant on a long list: the filtering follows a beat behind.
  const term = useDeferredValue(serverMode ? "" : searchValue.trim().toLowerCase());
  const deferredFilters = useDeferredValue(filters);

  // Built once when a search starts, not on every keystroke.
  const searching = Boolean(term);
  const searchIndex = useMemo(() => {
    if (!searching) {
      return null;
    }

    const searchable = cols.map((column, index) => ({ column, index })).filter(({ column }) => column.searchable && column.type !== "actions");
    return prepared.map((item) => searchable.map(({ column, index }) => searchText(column, item.values[index])).join(" "));
  }, [searching, prepared, cols]);

  const filterColumns = useMemo(() => visible.filter(({ column }) => column.filter !== "none"), [visible]);
  const activeFilters = useMemo(
    () => Object.entries(deferredFilters).filter(([key, value]) => value !== "" && value !== undefined && indexOf.has(key)),
    [deferredFilters, indexOf]
  );
  const filterCount = Object.values(filters).filter((value) => value !== "" && value !== undefined).length;

  const filtered = useMemo(() => {
    if (serverMode || editor) {
      return prepared;
    }

    const words = term ? term.split(/\s+/) : [];

    if (words.length === 0 && activeFilters.length === 0) {
      return prepared;
    }

    const tests = activeFilters.map(([key, wanted]) => {
      const index = indexOf.get(key);
      const column = cols[index];

      if (column.filter === "select") {
        return (item) => String(item.values[index] ?? "") === wanted;
      }

      const needle = String(wanted).trim().toLowerCase();
      return (item) => searchText(column, item.values[index]).includes(needle);
    });

    return prepared.filter((item) => {
      if (words.length) {
        const haystack = searchIndex[item.index];

        if (!words.every((word) => haystack.includes(word))) {
          return false;
        }
      }

      return tests.every((test) => test(item));
    });
  }, [serverMode, editor, prepared, term, activeFilters, indexOf, cols, searchIndex]);

  // ---- Sort ---------------------------------------------------------------------
  const serverSorts = serverMode && Object.prototype.hasOwnProperty.call(server, "sort");
  const canSort = !editor && (!serverMode || serverSorts);
  const sort = serverMode ? (server.sort ?? null) : sortState;

  const sorted = useMemo(() => {
    if (serverMode || editor || !sort) {
      return filtered;
    }

    const index = indexOf.get(sort.key);

    if (index === undefined || !cols[index].sortable) {
      return filtered;
    }

    return sortPrepared(filtered, cols[index], index, sort.direction);
  }, [serverMode, editor, sort, filtered, indexOf, cols]);

  // ---- Paging -------------------------------------------------------------------
  const pagingOn = !editor && (serverMode || pageSize !== false);
  const baseSize = typeof pageSize === "number" && pageSize > 0 ? pageSize : 25;
  const sizes = useMemo(() => [...new Set([baseSize, ...PAGE_SIZES])].sort((a, b) => a - b), [baseSize]);
  const size = serverMode
    ? Number(server.pageSize) || baseSize
    : sizes.includes(layout.pageSize) ? layout.pageSize : baseSize;
  const total = serverMode ? Number(server.total ?? prepared.length) : sorted.length;
  const pageCount = pagingOn ? Math.max(1, Math.ceil(total / size)) : 1;
  const rawPage = serverMode ? Number(server.page) || 1 : pageState;
  const page = Math.min(Math.max(1, rawPage), pageCount);

  const pageItems = useMemo(() => {
    if (serverMode || !pagingOn || printing) {
      return sorted;
    }

    return sorted.slice((page - 1) * size, page * size);
  }, [serverMode, pagingOn, printing, sorted, page, size]);

  // Serial numbers follow the rows as shown and run on across pages: page 2
  // at 25 a page starts at 26, whether the grid or the API did the paging.
  const firstSerial = pagingOn && !(printing && !serverMode) ? (serverMode ? (rawPage - 1) * size + 1 : (page - 1) * size + 1) : 1;
  const serialOn = serial !== false;

  // ---- Totals -------------------------------------------------------------------
  const totalCols = visibleCols.filter((column) => column.total !== "none");
  const wantTotals = totalCols.length > 0;
  const serverTotals = serverMode ? server.totals : undefined;
  const totals = useMemo(() => {
    if (!wantTotals) {
      return null;
    }

    if (serverTotals) {
      return serverTotals;
    }

    return computeTotals(cols, serverMode ? prepared : sorted);
  }, [wantTotals, serverTotals, serverMode, cols, prepared, sorted]);
  // What the totals label counts: the page's own word (rowNoun), else lines
  // in an entry table (its cards are headed "Line 2"), else rows.
  const [oneNoun, manyNoun] = Array.isArray(rowNoun)
    ? rowNoun
    : typeof rowNoun === "string"
      ? [rowNoun, `${rowNoun}s`]
      : editor
        ? ["line", "lines"]
        : ["row", "rows"];
  const noun = (amount) => (amount === 1 ? oneNoun : manyNoun);
  const totalsLabel =
    serverMode && !server.totals
      ? `This page · ${count(prepared.length)} ${noun(prepared.length)}`
      : `Total · ${count(total)} ${noun(total)}`;

  // ---- Phone cards --------------------------------------------------------------
  const width = useContainerWidth(rootRef);
  // Cards when the grid is narrow AND its table would not fit: a phone list,
  // not a three-column table in a 460px dialog. `cardsBelow` given by the
  // page is a plain width rule (0 = never cards).
  const breakpoint = cardsBelow ?? (compact ? 420 : editor ? 520 : 640);
  const needed =
    (serial !== false ? 52 : 0) + (selectable && !editor ? 36 : 0) + visibleCols.reduce((sum, column) => sum + naturalWidth(column), 0);
  const cards =
    !printing && breakpoint > 0 && width < breakpoint && (cardsBelow !== undefined || width < 360 || needed > width);

  // ---- Selection ----------------------------------------------------------------
  // Only rows that pass the filters count as chosen: a bulk action should never
  // reach a row the filter has hidden from view.
  const selectedItems = useMemo(
    () => (selectable ? sorted.filter((item) => selected.has(item.key)) : []),
    [selectable, sorted, selected]
  );

  const changeSelection = (next) => {
    setSelected(next);

    if (onSelectionChange) {
      onSelectionChange(sorted.filter((item) => next.has(item.key)).map((item) => item.row));
    }
  };

  const toggleRow = (key) => {
    const next = new Set(selected);

    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }

    changeSelection(next);
  };

  // Rows the page says cannot be chosen (canSelect) keep a greyed box and are
  // left out of "select every row on this page".
  const pickable = (item) => !canSelect || Boolean(canSelect(item.row));
  const pagePickable = pageItems.filter(pickable);
  const pageAllSelected = pagePickable.length > 0 && pagePickable.every((item) => selected.has(item.key));
  const pageSomeSelected = pagePickable.some((item) => selected.has(item.key));

  const togglePage = () => {
    const next = new Set(selected);

    for (const item of pagePickable) {
      if (pageAllSelected) {
        next.delete(item.key);
      } else {
        next.add(item.key);
      }
    }

    changeSelection(next);
  };

  const clearSelection = () => changeSelection(new Set());

  // ---- Changes ------------------------------------------------------------------
  const report = (change) => {
    if (serverMode && typeof server.onChange === "function") {
      server.onChange({ page: rawPage, pageSize: size, sort: server.sort ?? null, filters, ...change });
    }
  };

  const setSearch = (value) => {
    if (controlledSearch) {
      searchProp.onChange?.(value);
    } else {
      setSearchState(value);
    }

    setPageState(1);
  };

  const setFilter = (key, value) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    setPageState(1);
    report({ page: 1, filters: next });
  };

  const clearSearchAndFilters = () => {
    if (searchValue) {
      setSearch("");
    }

    setFilters({});
    setPageState(1);
    report({ page: 1, filters: {} });
  };

  const applySort = (next) => {
    if (serverMode) {
      report({ page: 1, sort: next });
    } else {
      setSortState(next);
      setPageState(1);
    }
  };

  const goToPage = (next) => {
    const target = Math.min(Math.max(1, next), pageCount);

    if (serverMode) {
      report({ page: target });
    } else {
      setPageState(target);
    }

    // The top of the new page, not the bottom of the old one: the grid's
    // own frame goes back to its first row, and a page that had scrolled
    // past the grid's top brings it back into view.
    scrollRef.current?.scrollTo?.({ top: 0 });

    const root = rootRef.current;

    if (root && root.getBoundingClientRect().top < visibleTop(root)) {
      root.scrollIntoView({ block: "start" });
    }
  };

  // Rows per page is remembered per `id` in server mode too. The page holds
  // the number it asks the API for, so on mount the grid tells it the
  // remembered choice once, when that differs (rememberedPageSize() lets a
  // page start with it and skip the second request).
  const rememberedSize = sizes.includes(layout.pageSize) ? layout.pageSize : null;
  const sizeSyncedRef = useRef(false);

  useEffect(() => {
    if (sizeSyncedRef.current || !serverMode) {
      return;
    }

    sizeSyncedRef.current = true;

    if (rememberedSize && rememberedSize !== Number(server.pageSize) && typeof server.onChange === "function") {
      server.onChange({ page: 1, pageSize: rememberedSize, sort: server.sort ?? null, filters: {} });
    }
  }, [serverMode, rememberedSize, server]);

  const setPageSize = (next) => {
    updateLayout({ pageSize: next });
    setPageState(1);
    report({ page: 1, pageSize: next });
  };

  const setWidth = useCallback(
    (key, value) => updateLayout((current) => ({ ...current, widths: { ...(current.widths || {}), [key]: value } })),
    [updateLayout]
  );

  const toggleHidden = (key) => {
    const column = cols[indexOf.get(key)];
    updateLayout((current) => ({ ...current, hidden: { ...(current.hidden || {}), [key]: !isHidden(column) } }));
  };

  const resetLayout = () => {
    updateLayout((current) => (current.pageSize ? { pageSize: current.pageSize } : {}));
  };

  const density = layout.density === "compact" || layout.density === "comfortable" ? layout.density : compact ? "compact" : "comfortable";

  // ---- Export -------------------------------------------------------------------
  const exportCsv = async () => {
    const exportCols = visible.filter(({ column }) => column.type !== "actions");
    let items = sorted;
    // Numbered as on screen: a server page exported alone keeps its 26–50.
    let startAt = serverMode ? firstSerial : 1;

    if (serverMode && typeof server.fetchAll === "function") {
      setExporting(true);

      try {
        items = prepareRows(await server.fetchAll(), cols, keyOf);
        startAt = 1;
      } catch {
        items = sorted;
      } finally {
        setExporting(false);
      }
    }

    // Money goes out as plain numbers, so a column priced in the restaurant's
    // own currency says which in its heading: "Total (AED)".
    const heading = (column) =>
      column.type === "money" && column.currency ? `${column.label} (${String(column.currency).trim()})` : column.label;
    const head = [...(serialOn ? ["S.No."] : []), ...exportCols.map(({ column }) => heading(column))];
    const body = items.map((item, position) => [
      ...(serialOn ? [startAt + position] : []),
      ...exportCols.map(({ column, index }) => csvValue(column, item.values[index], item.row)),
    ]);

    downloadCsv([head, ...body], `${exportName}-${today()}.csv`);
  };

  // ---- Printing -----------------------------------------------------------------
  // A printed list is every filtered row, as a plain table — never page 1 of
  // 13 or a stack of phone cards. flushSync, so the rows are there before the
  // browser lays out the printout.
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);

    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);

    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  // ---- First-load entrance ------------------------------------------------------
  // Rows rise in once, the first time real rows arrive. The rows of that
  // first render are marked for the shared cascade (useMotionScope reads
  // data-motion-item when it sees them inserted, in the microtask after this
  // effect) and unmarked a frame later, so a sort that moves them, a new page
  // or a refresh just shows the rows.
  const showingRows = pageItems.length > 0 && !(loading && prepared.length === 0);

  useLayoutEffect(() => {
    if (revealedRef.current || !showingRows || !rootRef.current) {
      return;
    }

    revealedRef.current = true;
    const items = [...rootRef.current.querySelectorAll(".dg-row:not(.dg-row-skeleton), .dg-cards > .dg-card")];
    items.forEach((node) => node.setAttribute("data-motion-item", ""));
    requestAnimationFrame(() => items.forEach((node) => node.removeAttribute("data-motion-item")));
  }, [showingRows]);

  // ---- Pinned columns -----------------------------------------------------------
  const pinnedCols = visibleCols.filter((column) => column.pin);
  const pinLead = pinnedCols.length > 0;
  const slotOf = new Map();
  let slot = 0;

  if (pinLead && serialOn) {
    slotOf.set("__serial", slot++);
  }

  if (pinLead && selectable && !editor) {
    slotOf.set("__select", slot++);
  }

  for (const column of pinnedCols) {
    slotOf.set(column.key, slot++);
  }

  const lastSlot = slot - 1;
  const pinSignature = [...slotOf.keys()].join("|");

  // Each pinned column sits where the ones before it end. Measured from the
  // header cells and kept up to date as they change size.
  useLayoutEffect(() => {
    const table = tableRef.current;

    if (cards || !table || !pinSignature) {
      return undefined;
    }

    const heads = [...table.querySelectorAll("thead > tr.dg-head-row > [data-pin-slot]")];
    // Written only when a value really changes: every pinned cell reads
    // these, so a needless write restyles the whole table.
    const place = () => {
      let left = 0;

      for (const head of heads) {
        const name = `--dg-pin-${head.dataset.pinSlot}`;

        if (table.style.getPropertyValue(name) !== `${left}px`) {
          table.style.setProperty(name, `${left}px`);
        }

        left += head.offsetWidth;
      }
    };

    place();

    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(place);
    heads.forEach((head) => observer.observe(head));

    return () => observer.disconnect();
  }, [cards, pinSignature]);

  // The scroll box is a keyboard stop only when there is something to scroll.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const table = tableRef.current;

    if (cards || !box || !table || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const check = () => {
      const overflows = table.offsetWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1;
      box.classList.toggle("is-overflowing", table.offsetWidth > box.clientWidth + 1);
      markMoreRight(box);

      if (overflows) {
        box.setAttribute("tabindex", "0");
      } else {
        box.removeAttribute("tabindex");
      }
    };

    const observer = new ResizeObserver(check);
    observer.observe(box);
    observer.observe(table);

    return () => observer.disconnect();
  }, [cards]);

  const onScroll = (event) => {
    event.currentTarget.classList.toggle("is-scrolled-x", event.currentTarget.scrollLeft > 2);
    markMoreRight(event.currentTarget);
  };

  // ---- Resizing -----------------------------------------------------------------
  const widths = useMemo(() => layout.widths || {}, [layout.widths]);
  const resizable = full && !cards && !printing;

  const startResize = (event, column, index) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const handle = event.currentTarget;
    const head = handle.parentElement;
    const table = tableRef.current;
    const startX = event.clientX;
    const startWidth = head.getBoundingClientRect().width;
    let latest = widths[column.key] || clampWidth(startWidth, column);

    if (!widths[column.key]) {
      setWidth(column.key, latest);
    }

    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("is-dragging");

    // During the drag only a CSS variable changes, so a 500-row list does not
    // re-render on every pixel; the width is saved when the pointer lets go.
    const move = (moveEvent) => {
      latest = clampWidth(startWidth + moveEvent.clientX - startX, column);
      table.style.setProperty(`--dg-w-${index}`, `${latest}px`);
    };

    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      handle.classList.remove("is-dragging");
      setWidth(column.key, latest);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  const currentWidth = (column, index) => {
    if (widths[column.key]) {
      return widths[column.key];
    }

    const head = tableRef.current?.querySelector(`thead > tr.dg-head-row > [data-col-index="${index}"]`);
    return clampWidth(head ? head.getBoundingClientRect().width : column.width || 160, column);
  };

  const onResizeKey = (event, column, index) => {
    const step = event.shiftKey ? 64 : 16;

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setWidth(column.key, clampWidth(currentWidth(column, index) + (event.key === "ArrowRight" ? step : -step), column));
    } else if (event.key === "Enter") {
      event.preventDefault();
      fitColumn(column, index);
    }
  };

  // Double-click the edge: as wide as the widest thing in the column on this
  // page, measured on an unwrapped copy.
  const fitColumn = (column, index) => {
    const table = tableRef.current;
    const root = rootRef.current;

    if (!table || !root) {
      return;
    }

    const probe = document.createElement("div");
    probe.className = "dg-measure";
    root.appendChild(probe);

    let widest = 0;
    const head = table.querySelector(`thead > tr.dg-head-row > [data-col-index="${index}"] .dg-head-label`);

    if (head) {
      probe.classList.add("is-head");
      probe.replaceChildren(...[...head.childNodes].map((node) => node.cloneNode(true)));
      widest = probe.getBoundingClientRect().width + 26;
      probe.classList.remove("is-head");
    }

    for (const cell of table.querySelectorAll(`tbody > tr > [data-col-index="${index}"]`)) {
      const content = cell.querySelector(":scope > .dg-cell") || cell;
      probe.replaceChildren(...[...content.childNodes].map((node) => node.cloneNode(true)));
      widest = Math.max(widest, probe.getBoundingClientRect().width);
    }

    probe.remove();

    const padding = density === "compact" ? 24 : 32;
    setWidth(column.key, clampWidth(Math.ceil(widest) + padding + 2, column));
  };

  // ---- Keyboard -----------------------------------------------------------------
  // Editor: Enter moves to the same field on the next line (Shift+Enter: the
  // line above), the way a stock count or a supplier's invoice is keyed in.
  // It never submits the form from inside the lines.
  const onEditorKeyDown = (event) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) {
      return;
    }

    const target = event.target;

    if (!(target instanceof HTMLElement) || !target.matches("input, select") || target.matches("[type=button], [type=submit], [type=reset]")) {
      return;
    }

    const cell = target.closest("[data-col]");
    const line = target.closest("[data-row]");

    if (!cell || !line) {
      return;
    }

    event.preventDefault();

    const fieldsIn = (node) => [...node.querySelectorAll("input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled)")];
    const position = fieldsIn(cell).indexOf(target);
    const lines = [...line.parentElement.children].filter((node) => node.hasAttribute("data-row"));
    const next = lines[lines.indexOf(line) + (event.shiftKey ? -1 : 1)];
    const nextCell = next?.querySelector(`[data-col="${CSS.escape(cell.dataset.col)}"]`);
    const field = nextCell ? fieldsIn(nextCell)[Math.max(0, position)] : null;

    if (field) {
      field.focus();

      if (typeof field.select === "function" && field.matches("input")) {
        field.select();
      }
    }
  };

  const onRowKeyDown = (event, item) => {
    if (event.target !== event.currentTarget) {
      return;
    }

    const row = event.currentTarget;

    if (event.key === "Enter") {
      event.preventDefault();
      onRowClick(item.row);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      (event.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling)?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? row.parentElement.firstElementChild : row.parentElement.lastElementChild)?.focus();
    }
  };

  const onRowClickEvent = (event, item) => {
    const inner = event.target.closest(INTERACTIVE);

    // A button, link or field inside the row does its own job; a drag to
    // copy a bill number is not a click on the row.
    if ((inner && inner !== event.currentTarget) || window.getSelection()?.toString()) {
      return;
    }

    onRowClick(item.row);
  };

  // ---- Cells --------------------------------------------------------------------
  const titleColumn = visibleCols.find((column) => column.isTitle) || visibleCols.find((column) => column.type !== "actions");

  const titleText = (item) => {
    if (!titleColumn) {
      return "";
    }

    const value = item.values[indexOf.get(titleColumn.key)];
    return isEmpty(value) ? "" : formatValue(titleColumn, value);
  };

  const renderCell = (column, item, number, card = false) => {
    const index = indexOf.get(column.key);

    if (column.render) {
      return column.render(item.row, {
        index: item.index,
        serial: number,
        label: `${column.label}, ${editor ? "line" : "row"} ${number}`,
        card,
      });
    }

    const value = item.values[index] ?? readValue(column, item.row);

    if (isEmpty(value)) {
      return <span className="dg-blank">—</span>;
    }

    if (column.type === "status") {
      return (
        <span className={`badge status-badge badge-${String(value).toLowerCase()}`}>
          <span className="badge-dot" aria-hidden="true" />
          {humanise(value)}
        </span>
      );
    }

    return formatValue(column, value);
  };

  // ---- Layout of the table ------------------------------------------------------
  const showSelect = selectable && !editor && !printing;
  const leading = (showSelect ? 1 : 0) + (serialOn ? 1 : 0);
  const columnCount = leading + visibleCols.length;
  const framed = !cards && !printing && pageItems.length > FRAME_AFTER;

  // A column's width: what this viewer dragged it to, else the column's own
  // `width`, else (in an entry table) a sensible box for a figure. Without
  // any of those the column takes the width of its content.
  const widthOf = (column) => {
    if (resizable && widths[column.key]) {
      return widths[column.key];
    }

    if (column.width) {
      return Math.max(column.width, minOf(column));
    }

    return editor && isNumeric(column) ? 140 : null;
  };

  const widthVars = {};

  visible.forEach(({ column, index }) => {
    const width = widthOf(column);

    if (width) {
      widthVars[`--dg-w-${index}`] = `${width}px`;
    }
  });

  const sizedStyle = (column, index) =>
    widthOf(column)
      ? { width: `var(--dg-w-${index})`, minWidth: `var(--dg-w-${index})`, maxWidth: `var(--dg-w-${index})` }
      : column.minWidth
        ? { minWidth: column.minWidth }
        : undefined;

  const rightKey = visibleCols.length > 0 && visibleCols[visibleCols.length - 1].pinRight ? visibleCols[visibleCols.length - 1].key : null;

  const pinProps = (key) => {
    const at = slotOf.get(key);

    if (cards) {
      return {};
    }

    if (at === undefined) {
      return key === rightKey ? { style: { right: 0 }, pinClass: "is-pinned-right" } : {};
    }

    return {
      "data-pin-slot": at,
      style: { left: `var(--dg-pin-${at}, 0px)` },
      pinClass: `is-pinned ${at === lastSlot ? "is-pin-edge" : ""}`,
    };
  };

  const cellClass = (column, extra = "") =>
    [
      "dg-cell-td",
      `align-${column.align}`,
      `type-${column.type}`,
      column.isTitle ? "is-title" : "",
      widthOf(column) ? "is-sized" : "",
      column.className || "",
      extra,
    ]
      .filter(Boolean)
      .join(" ");

  const sortOf = (column) => (sort && sort.key === column.key ? sort.direction : null);
  const columnSortable = (column) => canSort && column.sortable;

  // ---- Announcements ------------------------------------------------------------
  const sortedColumn = sort ? cols[indexOf.get(sort.key)] : null;
  const announcement = loading
    ? ""
    : [
        total === 0 ? "No rows" : pagingOn && total > size ? `Rows ${count((page - 1) * size + 1)} to ${count(Math.min(total, page * size))} of ${count(total)}` : `${count(total)} ${total === 1 ? "row" : "rows"}`,
        sortedColumn ? `sorted by ${sortedColumn.label}, ${sort.direction === "asc" ? "ascending" : "descending"}` : "",
      ]
        .filter(Boolean)
        .join(", ");

  // ---- States -------------------------------------------------------------------
  const firstLoad = loading && prepared.length === 0;
  const failed = Boolean(error) && prepared.length === 0 && !loading;
  const nothing = !loading && !error && prepared.length === 0;
  const noMatch = !loading && prepared.length > 0 && sorted.length === 0;
  const narrowed = searchValue !== "" || filterCount > 0;

  const stateBlock = failed ? (
    <div className="dg-state is-error" role="alert">
      <span className="dg-state-icon" aria-hidden="true">
        <Icon name="alert-circle" size={22} />
      </span>
      <p className="dg-state-message">{error}</p>
      {onRetry && (
        <button type="button" className="button button-secondary dg-tool" onClick={onRetry}>
          <Icon name="refresh" size={15} /> Try again
        </button>
      )}
    </div>
  ) : nothing ? (
    serverMode && narrowed ? (
      <EmptyState icon="search" message="No rows match" hint="Nothing matches the search or filters." action={<ClearButton onClick={clearSearchAndFilters} />} />
    ) : (
      <EmptyState icon={emptyIcon} message={empty} hint={emptyHint} action={emptyAction} />
    )
  ) : noMatch ? (
    <EmptyState icon="search" message="No rows match" hint="Nothing in this list matches the search or filters." action={<ClearButton onClick={clearSearchAndFilters} />} />
  ) : null;

  // ---- Toolbar ------------------------------------------------------------------
  const sortChoices = cards && canSort ? visibleCols.filter((column) => column.sortable) : [];
  const toolsVisible = full && !printing;

  const toolbarRow = toolsVisible ? (
    <div className="dg-toolbar">
      {toolbar && <div className="dg-toolbar-page">{toolbar}</div>}
      <div className="dg-toolbar-tools">
        {showSearch && (
          <label className="dg-search">
            <span className="sr-only">Search {label}</span>
            <Icon name="search" size={16} className="dg-search-icon" />
            <input type="search" value={searchValue} placeholder={searchPlaceholder} onChange={(event) => setSearch(event.target.value)} />
          </label>
        )}
        {sortChoices.length > 0 && (
          <label className="dg-sortby">
            <span className="sr-only">Sort by</span>
            <Icon name="chevrons-up-down" size={16} className="dg-sortby-icon" />
            <select
              value={sort ? `${sort.key}:${sort.direction}` : ""}
              onChange={(event) => {
                const [key, direction] = event.target.value.split(":");
                applySort(key ? { key, direction } : null);
              }}
            >
              <option value="">Sort: default</option>
              {sortChoices.flatMap((column) =>
                ["asc", "desc"].map((direction) => (
                  <option key={`${column.key}:${direction}`} value={`${column.key}:${direction}`}>
                    {column.label} ({directionWords(column, direction)})
                  </option>
                ))
              )}
            </select>
          </label>
        )}
        {filterColumns.length > 0 && (
          <button
            type="button"
            className={`button button-secondary dg-tool ${filtersOpen ? "is-open" : ""}`}
            aria-expanded={filtersOpen}
            aria-controls={filterPanelId}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <Icon name="filter" size={15} />
            <span className="dg-tool-word">Filters</span>
            {filterCount > 0 && <span className="dg-tool-count">{filterCount}</span>}
          </button>
        )}
        {!cards && (
          <GridColumnMenu
            items={cols.map((column) => ({ key: column.key, label: column.label, hideable: column.hideable, hidden: isHidden(column) }))}
            density={density}
            onToggle={toggleHidden}
            onDensity={(value) => updateLayout({ density: value })}
            onReset={resetLayout}
          />
        )}
        {exportName && (
          <button type="button" className="button button-secondary dg-tool" onClick={exportCsv} disabled={exporting || total === 0}>
            <Icon name="download" size={15} />
            {/* On a phone the button is the icon alone, so the sort list and
                Filters fit on the same line; the words stay for screen readers. */}
            <span className={cards ? "sr-only" : "dg-tool-word"}>{exporting ? "Exporting…" : "Export CSV"}</span>
          </button>
        )}
      </div>
    </div>
  ) : toolbar && !printing ? (
    <div className="dg-toolbar is-plain">
      <div className="dg-toolbar-page">{toolbar}</div>
    </div>
  ) : null;

  const filterControl = (column, index, inPanel) => {
    const value = filters[column.key] ?? "";
    const name = `Filter ${column.label}`;

    return column.filter === "select" ? (
      <select value={value} onChange={(event) => setFilter(column.key, event.target.value)} aria-label={inPanel ? undefined : name}>
        <option value="">All</option>
        {filterOptions(column, index, prepared).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ) : (
      <input
        type="search"
        value={value}
        placeholder={inPanel ? `Any ${column.label.toLowerCase()}` : "Filter…"}
        onChange={(event) => setFilter(column.key, event.target.value)}
        aria-label={inPanel ? undefined : name}
      />
    );
  };

  const filterPanel =
    toolsVisible && filtersOpen && cards && filterColumns.length > 0 ? (
      <div className="dg-filter-panel" id={filterPanelId}>
        {filterColumns.map(({ column, index }) => (
          <label key={column.key} className="dg-filter-field">
            <span>{column.label}</span>
            {filterControl(column, index, true)}
          </label>
        ))}
        {filterCount > 0 && (
          <button type="button" className="button button-ghost dg-tool" onClick={clearSearchAndFilters}>
            Clear filters
          </button>
        )}
      </div>
    ) : null;

  const bulkBar =
    selectable && !editor && selectedItems.length > 0 && !printing ? (
      <div className="dg-bulk" role="region" aria-label="Selected rows">
        <span className="dg-bulk-count">
          <strong>{count(selectedItems.length)}</strong> selected
        </span>
        <div className="dg-bulk-actions">{bulkActions ? bulkActions(selectedItems.map((item) => item.row), clearSelection) : null}</div>
        <button type="button" className="button button-ghost dg-tool" onClick={clearSelection}>
          <Icon name="x" size={15} /> Clear
        </button>
      </div>
    ) : null;

  // ---- Footer / totals ----------------------------------------------------------
  const labelColumn = visibleCols.find((column) => column.total === "none" && column.type !== "actions");
  const footerContext = { columns: visibleCols, leading, totals, rows: sorted.map((item) => item.row), cards };
  const customFooter = typeof footer === "function" ? footer(footerContext) : footer;

  const totalsRow =
    totals && !customFooter && !firstLoad && sorted.length > 0 ? (
      <tr className="dg-total-row">
        {serialOn && <td className={`dg-serial-col ${pinProps("__serial").pinClass || ""}`} style={pinProps("__serial").style} />}
        {showSelect && <td className={`dg-select-col ${pinProps("__select").pinClass || ""}`} style={pinProps("__select").style} />}
        {visible.map(({ column, index }) => {
          const pin = pinProps(column.key);

          if (column === labelColumn) {
            return (
              <th key={column.key} scope="row" className={cellClass(column, `dg-total-label ${pin.pinClass || ""}`)} style={{ ...pin.style, ...sizedStyle(column, index) }}>
                {totalsLabel}
              </th>
            );
          }

          return (
            <td key={column.key} className={cellClass(column, pin.pinClass || "")} style={{ ...pin.style, ...sizedStyle(column, index) }}>
              {column.total !== "none" ? formatTotal(column, totals[column.key]) : null}
            </td>
          );
        })}
      </tr>
    ) : null;

  const totalsCard =
    totals && !customFooter && !firstLoad && sorted.length > 0 ? (
      <div className="dg-card dg-card-total" role="group" aria-label={totalsLabel}>
        <p className="dg-card-title">{totalsLabel}</p>
        <dl className="dg-card-fields">
          {totalCols.map((column) => (
            <div key={column.key} className="dg-card-field align-right">
              <dt>{column.label}</dt>
              <dd>{formatTotal(column, totals[column.key])}</dd>
            </div>
          ))}
        </dl>
      </div>
    ) : null;

  // ---- Body ---------------------------------------------------------------------
  const skeletonRows = Array.from({ length: SKELETON_ROWS }, (_, row) => (
    <tr key={`skeleton-${row}`} className="dg-row dg-row-skeleton" aria-hidden="true">
      {serialOn && (
        <td className="dg-serial-col">
          <span className="skeleton dg-skeleton" style={{ width: 18, marginLeft: "auto" }} />
        </td>
      )}
      {showSelect && <td className="dg-select-col" />}
      {visibleCols.map((column, at) => (
        <td key={column.key} className={cellClass(column)}>
          <span className="skeleton dg-skeleton" style={{ width: column.type === "actions" ? 28 : `${[72, 54, 64, 46, 58, 40][(row + at) % 6]}%`, marginLeft: column.align === "right" ? "auto" : undefined }} />
        </td>
      ))}
    </tr>
  ));

  // Arrow keys move between rows; Tab stops on one row only (the last one
  // used, else the first), so a long page is not fifty Tab presses deep.
  const activeOnPage = activeKey !== null && pageItems.some((item) => item.key === activeKey) ? activeKey : null;

  const bodyRows = pageItems.map((item, position) => {
    const number = firstSerial + position;
    const isSelected = showSelect && selected.has(item.key);
    const extra = rowClassName ? rowClassName(item.row) || "" : "";
    const clickable = Boolean(onRowClick) && !editor;
    const tabbable = activeOnPage === null ? position === 0 : activeOnPage === item.key;

    return (
      <tr
        key={item.key}
        className={`dg-row ${extra} ${isSelected ? "is-selected" : ""} ${clickable ? "is-clickable" : ""}`}
        data-row={number}
        tabIndex={clickable ? (tabbable ? 0 : -1) : undefined}
        onClick={clickable ? (event) => onRowClickEvent(event, item) : undefined}
        onKeyDown={clickable ? (event) => onRowKeyDown(event, item) : undefined}
        onFocus={clickable ? (event) => event.target === event.currentTarget && setActiveKey(item.key) : undefined}
      >
        {serialOn && (
          <td className={`dg-serial-col ${pinProps("__serial").pinClass || ""}`} style={pinProps("__serial").style}>
            {number}
          </td>
        )}
        {showSelect && (
          <td className={`dg-select-col ${pinProps("__select").pinClass || ""}`} style={pinProps("__select").style}>
            <input type="checkbox" className="dg-check" checked={isSelected} onChange={() => toggleRow(item.key)} aria-label={`Select ${titleText(item) || `row ${number}`}`}
              disabled={!pickable(item)} />
          </td>
        )}
        {visible.map(({ column, index }) => {
          const pin = pinProps(column.key);
          const sized = widthOf(column);

          return (
            <td key={column.key} className={cellClass(column, pin.pinClass || "")} style={pin.style} data-col={column.key} data-col-index={index}>
              {sized ? (
                <div className="dg-cell" style={{ width: `calc(var(--dg-w-${index}) - var(--dg-pad-x) * 2)` }}>
                  {renderCell(column, item, number)}
                </div>
              ) : (
                renderCell(column, item, number)
              )}
            </td>
          );
        })}
      </tr>
    );
  });

  const tableView = (
    <div className={`dg-scroll ${framed ? "is-framed" : ""}`} ref={scrollRef} onScroll={onScroll} role="region" aria-label={label}>
      <table ref={tableRef} className="dg-table" style={widthVars} aria-busy={loading || undefined}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="dg-head-row">
            {serialOn && (
              <th scope="col" className={`dg-serial-col ${pinProps("__serial").pinClass || ""}`} style={pinProps("__serial").style} data-pin-slot={pinProps("__serial")["data-pin-slot"]}>
                <abbr title="Serial number">S.No.</abbr>
              </th>
            )}
            {showSelect && (
              <th scope="col" className={`dg-select-col ${pinProps("__select").pinClass || ""}`} style={pinProps("__select").style} data-pin-slot={pinProps("__select")["data-pin-slot"]}>
                <input
                  type="checkbox"
                  className="dg-check"
                  checked={pageAllSelected}
                  ref={(node) => {
                    if (node) {
                      node.indeterminate = pageSomeSelected && !pageAllSelected;
                    }
                  }}
                  onChange={togglePage}
                  disabled={pagePickable.length === 0}
                  aria-label="Select every row on this page"
                />
              </th>
            )}
            {visible.map(({ column, index }) => {
              const pin = pinProps(column.key);
              const direction = sortOf(column);
              const sortable = columnSortable(column);

              return (
                <th
                  key={column.key}
                  scope="col"
                  className={`${cellClass(column, pin.pinClass || "")} ${direction ? "is-sorted" : ""}`}
                  style={{ ...pin.style, ...sizedStyle(column, index) }}
                  data-pin-slot={pin["data-pin-slot"]}
                  data-col-index={index}
                  aria-sort={sortable ? (direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none") : undefined}
                >
                  {sortable ? (
                    <button type="button" className="dg-sort" onClick={() => applySort(nextSort(sort, column.key))}>
                      <span className="dg-head-label">{column.header}</span>
                      <span className="dg-caret" data-dir={direction || "none"} aria-hidden="true">
                        <Icon name="arrow-up" size={13} strokeWidth={2.4} />
                      </span>
                    </button>
                  ) : (
                    <span className="dg-head-label">
                      {column.header}
                      {!column.header && <span className="sr-only">{column.label}</span>}
                    </span>
                  )}
                  {resizable && column.type !== "actions" && (
                    <span
                      className="dg-resize"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${column.label} column`}
                      aria-valuemin={column.minWidth || MIN_WIDTH}
                      aria-valuemax={MAX_WIDTH}
                      aria-valuenow={widths[column.key] || undefined}
                      title="Drag to resize · double-click to fit"
                      tabIndex={0}
                      onPointerDown={(event) => startResize(event, column, index)}
                      onDoubleClick={() => fitColumn(column, index)}
                      onKeyDown={(event) => onResizeKey(event, column, index)}
                      onClick={(event) => event.stopPropagation()}
                    />
                  )}
                </th>
              );
            })}
          </tr>
          {toolsVisible && filtersOpen && !cards && filterColumns.length > 0 && (
            <tr className="dg-filter-row" id={filterPanelId}>
              {serialOn && <td className={`dg-serial-col ${pinProps("__serial").pinClass || ""}`} style={pinProps("__serial").style} />}
              {showSelect && <td className={`dg-select-col ${pinProps("__select").pinClass || ""}`} style={pinProps("__select").style} />}
              {visible.map(({ column, index }) => {
                const pin = pinProps(column.key);

                return (
                  <td key={column.key} className={`dg-filter-cell ${pin.pinClass || ""}`} style={pin.style}>
                    {column.filter !== "none" ? filterControl(column, index, false) : null}
                  </td>
                );
              })}
            </tr>
          )}
        </thead>
        <tbody onKeyDown={editor ? onEditorKeyDown : undefined}>
          {firstLoad
            ? skeletonRows
            : stateBlock
              ? (
                  <tr className="dg-state-row">
                    <td colSpan={columnCount}>{stateBlock}</td>
                  </tr>
                )
              : bodyRows}
        </tbody>
        {(customFooter || totalsRow) && (
          <tfoot>
            {customFooter || totalsRow}
          </tfoot>
        )}
      </table>
    </div>
  );

  const cardsView = (
    <div className="dg-cards-wrap" aria-busy={loading || undefined}>
      {firstLoad ? (
        <div className="dg-cards" aria-hidden="true">
          {Array.from({ length: 3 }, (_, at) => (
            <div key={at} className="dg-card dg-card-skeleton">
              <span className="skeleton dg-skeleton" style={{ width: "55%", height: 16 }} />
              <span className="skeleton dg-skeleton" style={{ width: "35%" }} />
              <span className="skeleton dg-skeleton" style={{ width: "80%" }} />
              <span className="skeleton dg-skeleton" style={{ width: "70%" }} />
            </div>
          ))}
        </div>
      ) : stateBlock ? (
        <div className="dg-cards-state">{stateBlock}</div>
      ) : (
        <>
          {showSelect && pageItems.length > 0 && (
            <label className="dg-cards-select">
              <input
                type="checkbox"
                className="dg-check"
                checked={pageAllSelected}
                ref={(node) => {
                  if (node) {
                    node.indeterminate = pageSomeSelected && !pageAllSelected;
                  }
                }}
                onChange={togglePage}
                disabled={pagePickable.length === 0}
              />
              Select all {count(pagePickable.length)} on this page
            </label>
          )}
          <GridCards
            items={pageItems}
            columns={visibleCols}
            editor={editor}
            firstSerial={firstSerial}
            serial={serialOn}
            selectable={showSelect}
            canSelect={pickable}
            selected={selected}
            onToggleRow={toggleRow}
            onRowClick={editor ? null : onRowClick}
            activeKey={activeOnPage}
            onActivate={setActiveKey}
            rowClassName={rowClassName}
            renderCell={renderCell}
            titleText={titleText}
            onEditorKeyDown={onEditorKeyDown}
            caption={label}
          />
          {customFooter ? (
            footerContext.cards && typeof footer === "function" ? (
              customFooter
            ) : (
              <table className="dg-table dg-footer-table">
                <tfoot>{customFooter}</tfoot>
              </table>
            )
          ) : (
            totalsCard
          )}
        </>
      )}
    </div>
  );

  const showPager = pagingOn && !printing && !firstLoad && !stateBlock && total > 0 && (full || pageCount > 1);
  const pagerControls = pageCount > 1 || total > sizes[0];

  const classes = [
    "dg",
    `dg-${variant}`,
    `is-${density}`,
    cards ? "is-cards" : "is-table",
    loading && prepared.length > 0 ? "is-refreshing" : "",
    printing ? "is-printing" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={classes} style={{ "--dg-view-w": `${width}px` }}>
      {toolbarRow}
      {filterPanel}
      {bulkBar}
      {Boolean(error) && prepared.length > 0 && (
        <div className="dg-inline-error" role="alert">
          <Icon name="alert-circle" size={16} />
          <span>{error}</span>
          {onRetry && (
            <button type="button" className="link-button" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
      <div className="dg-body">
        {loading && prepared.length > 0 && <span className="dg-progress" aria-hidden="true" />}
        {cards ? cardsView : tableView}
      </div>
      {showPager && (
        <GridPager
          page={page}
          pageCount={pageCount}
          pageSize={size}
          sizes={sizes}
          total={total}
          onPage={goToPage}
          onPageSize={setPageSize}
          controls={pagerControls}
          label={label}
        />
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

function ClearButton({ onClick }) {
  return (
    <button type="button" className="button button-secondary dg-tool" onClick={onClick}>
      <Icon name="x" size={15} /> Clear search and filters
    </button>
  );
}
