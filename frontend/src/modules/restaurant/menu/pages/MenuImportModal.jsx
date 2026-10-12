import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import StatTile from "../../../../components/StatTile";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage } from "../../../../components/Feedback";
import { getImportGuide, importMenu } from "../services/menu.service";
import { downloadCsv, parseCsv } from "../../../../services/csv";
import { getErrorMessage } from "../../../../services/api";
import { count, money } from "../../../../services/format";
import "../../../../styles/menu.css";

// Menu import in two steps on purpose: the file is checked first and every
// change is shown, old value and new, before anything is written. What is
// imported is exactly what was previewed: if the menu changes in between (a
// dish sold out, a price edited), the server refuses the stale preview and
// this screen checks the file again.

const NEED_WORDS = {
  always: "Name or code",
  new: "For new dishes",
  optional: "Optional",
};

const FILTERS = [
  { key: "changes", label: "Changes" },
  { key: "flagged", label: "Second look" },
  { key: "create", label: "New" },
  { key: "update", label: "Updated" },
  { key: "unchanged", label: "Unchanged" },
];

// A spreadsheet read into { heading: cell } rows, headings exactly as typed:
// the server knows "Item Name", "GST %" and "Veg/Non-veg", and says which
// headings it did not recognise.
const readSheet = (text) => {
  const lines = parseCsv(text);

  if (lines.length < 2) {
    return [];
  }

  const headings = lines[0].map((heading) => String(heading).trim());

  return lines.slice(1).map((line) => {
    const row = {};

    headings.forEach((heading, index) => {
      if (heading) {
        row[heading] = line[index] === undefined ? "" : line[index];
      }
    });

    return row;
  });
};

// Internal column names in the words a manager uses, for a problem in a
// column the file did not name (a missing price on a new dish).
const COLUMN_WORDS = {
  category: "Category",
  name: "Name",
  code: "Short code",
  description: "Description",
  price: "Price",
  taxRate: "GST",
  foodType: "Veg/Non-veg",
  isAvailable: "Available",
  sortOrder: "Display order",
  status: "Status",
  sizes: "Sizes",
  addOns: "Add-ons",
  kitchenName: "Kitchen name",
  sizeKitchenNames: "Size kitchen names",
  addOnKitchenNames: "Add-on kitchen names",
};

const shown = (value, currency) => {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  return typeof value === "number" ? money(value, currency) : String(value);
};

export default function MenuImportModal({ currency = "₹", onClose, onImported }) {
  const fileRef = useRef(null);

  const [guide, setGuide] = useState(null);
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [check, setCheck] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("changes");
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    getImportGuide()
      .then(setGuide)
      .catch(() => setGuide(null));
  }, []);

  // The check: a dry run that returns the full preview, or the problems.
  const runCheck = async (sheetRows, name) => {
    setBusy(true);
    setConfirmed(false);

    try {
      const result = await importMenu(sheetRows, true, { fileName: name });
      setCheck(result.data);
    } catch (err) {
      const response = err.response && err.response.data;

      if (response && response.data && response.data.problems) {
        setCheck(response.data);
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (event) => {
    const file = event.target.files && event.target.files[0];

    setCheck(null);
    setError("");
    setNotice("");
    setRows([]);
    setFileName("");
    setFilter("changes");

    if (!file) {
      return;
    }

    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      setError("Choose a .csv file. In Excel: File → Save As → CSV UTF-8, then choose that file here.");
      return;
    }

    const parsed = readSheet(await file.text());

    if (parsed.length === 0) {
      setError("That file has no rows under its heading row.");
      return;
    }

    setRows(parsed);
    setFileName(file.name);
    await runCheck(parsed, file.name);
  };

  const confirm = async () => {
    setBusy(true);
    setError("");

    try {
      // The tick-box answer goes to the server too: it refuses flagged
      // changes that were not confirmed, whoever sends the file.
      const result = await importMenu(rows, false, {
        fileName,
        fingerprint: check.fingerprint,
        confirmFlagged: check.flagged > 0 ? confirmed : false,
      });
      onImported(result.message);
    } catch (err) {
      const response = err.response && err.response.data;

      if (err.response && err.response.status === 409 && response && response.data && response.data.reason === "stale_preview") {
        // The menu moved since the check: show what the file would do now.
        setNotice(response.message);
        setBusy(false);
        await runCheck(rows, fileName);
        return;
      }

      if (response && response.data && response.data.problems) {
        setCheck(response.data);
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const downloadSample = () => {
    if (guide) {
      downloadCsv([guide.sample.columns, ...guide.sample.rows], "menu-import-sample.csv");
    }
  };

  const problems = (check && check.problems) || [];
  const headings = (check && check.columns && check.columns.headings) || {};
  const columnName = (key) => (key ? headings[key] || COLUMN_WORDS[key] || key : "—");
  const planned = useMemo(() => (check && check.rows) || [], [check]);
  const ready = Boolean(check && check.ok && rows.length > 0);
  const changeCount = check ? check.created + check.updated : 0;
  // An add-on repriced by the file counts as work even when no dish changes.
  const workCount = check ? changeCount + check.addOnPriceChanges.length : 0;

  const visible = useMemo(() => {
    if (filter === "changes") {
      return planned.filter((row) => row.action !== "unchanged" || row.notes.length > 0 || row.flagged);
    }

    if (filter === "flagged") {
      return planned.filter((row) => row.flagged);
    }

    return planned.filter((row) => row.action === filter);
  }, [planned, filter]);

  const counts = {
    changes: planned.filter((row) => row.action !== "unchanged" || row.notes.length > 0 || row.flagged).length,
    flagged: check ? check.flagged : 0,
    create: check ? check.created : 0,
    update: check ? check.updated : 0,
    unchanged: check ? check.unchanged : 0,
  };


  const importLabel = busy
    ? "Working…"
    : ready && workCount === 0
      ? "Nothing to import"
      : ready && changeCount > 0
        ? `Import ${count(changeCount)} dish${changeCount === 1 ? "" : "es"}`
        : "Import";

  return (
    <Modal
      title="Import menu from a spreadsheet"
      description="Add new dishes and update existing ones from Excel or Google Sheets, after seeing every change."
      icon="upload"
      onClose={onClose}
      width={1040}
      footer={
        <>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            onClick={confirm}
            disabled={!ready || busy || workCount === 0 || (check.flagged > 0 && !confirmed)}
          >
            {importLabel}
          </button>
        </>
      }
    >
      <div className="stack mnu-import">
        <ErrorMessage message={error} />
        {notice && <div className="alert alert-notice">{notice}</div>}

        {!check && (
          <>
            <ul className="mnu-promises">
              <li>
                <Icon name="check-circle" size={18} className="mnu-promise-icon" />
                <span>
                  <strong>Only what your file says changes.</strong>
                  <span>Columns you leave out, and empty cells, keep what the dish has now.</span>
                </span>
              </li>
              <li>
                <Icon name="check-circle" size={18} className="mnu-promise-icon" />
                <span>
                  <strong>Sold-out dishes stay sold out.</strong>
                  <span>An import never puts a dish back on sale.</span>
                </span>
              </li>
              <li>
                <Icon name="check-circle" size={18} className="mnu-promise-icon" />
                <span>
                  <strong>Nothing is saved until you press Import.</strong>
                  <span>You see every change, old and new, first. Risky ones wait for your tick.</span>
                </span>
              </li>
            </ul>

            <label className={`mnu-drop${busy ? " is-busy" : ""}`}>
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={readFile} disabled={busy} />
              <span className="mnu-drop-icon" aria-hidden="true">
                {busy ? <span className="spinner" /> : <Icon name="upload" size={22} />}
              </span>
              <span className="mnu-drop-title">{busy ? "Checking the file…" : "Choose a CSV file"}</span>
              <span className="muted small">
                From Excel or Google Sheets: File → Save As / Download → CSV. Up to{" "}
                {guide ? count(guide.maxRows) : "2,000"} rows.
              </span>
            </label>

            <div className="mnu-guide-head">
              <p className="muted small">
                A dish is found by its short code, then by its name. Found dishes are updated, the rest are
                added. Headings like “Item Name”, “GST %” or “Veg/Non-veg” are understood.
              </p>
              <button type="button" className="button button-secondary button-sm" onClick={downloadSample} disabled={!guide}>
                <Icon name="download" size={15} /> Download sample file
              </button>
            </div>

            {guide && (
              <details className="mnu-guide">
                <summary>
                  <Icon name="chevron-right" size={16} className="mnu-guide-caret" />
                  What each column means
                </summary>
                <DataGrid
                  id="menu-import-columns"
                  variant="compact"
                  caption="What each column of the import file means"
                  rows={guide.columns}
                  rowKey={(column) => column.key}
                  pageSize={false}
                  rowNoun={["column", "columns"]}
                  columns={[
                    {
                      key: "key",
                      header: "Column",
                      value: (column) => column.key,
                      mobile: "title",
                      render: (column) => <span className="mono nowrap">{column.key}</span>,
                    },
                    {
                      key: "need",
                      header: "Needed",
                      value: (column) => NEED_WORDS[column.need],
                      mobile: "subtitle",
                      render: (column) => (
                        <span className={`badge ${column.need === "optional" ? "badge-neutral" : "badge-primary"}`}>
                          {NEED_WORDS[column.need]}
                        </span>
                      ),
                    },
                    { key: "help", header: "What to write", value: (column) => column.help, mobile: "show", minWidth: 240 },
                    {
                      key: "example",
                      header: "Example",
                      value: (column) => column.example,
                      mobile: "show",
                      render: (column) => <span className="mono">{column.example}</span>,
                    },
                  ]}
                />
              </details>
            )}
          </>
        )}

        {check && (
          <>
            <div className="mnu-file-line">
              <span className="mnu-file-name">
                <Icon name="file" size={16} />
                <strong>{fileName}</strong>
                <span className="muted"> · {count(rows.length)} row{rows.length === 1 ? "" : "s"}</span>
              </span>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => {
                  setCheck(null);
                  setRows([]);
                  setNotice("");
                  if (fileRef.current) {
                    fileRef.current.value = "";
                  }
                }}
                disabled={busy}
              >
                <Icon name="refresh" size={15} /> Choose another file
              </button>
            </div>

            <div className="stat-grid mnu-mini-stats">
              <StatTile size="sm" icon="plus" tone="success" label="New dishes" value={count(check.created)} />
              <StatTile size="sm" icon="edit" tone="info" label="Dishes changing" value={count(check.updated)} />
              <StatTile size="sm" icon="check" label="Unchanged" value={count(check.unchanged)} />
              <StatTile
                size="sm"
                icon="eye"
                tone={check.flagged > 0 ? "warning" : "neutral"}
                label="Need a second look"
                value={count(check.flagged)}
              />
              <StatTile
                size="sm"
                icon="x-circle"
                tone={problems.length > 0 ? "danger" : "neutral"}
                label="Problems"
                value={count(problems.length)}
              />
            </div>

            {problems.length > 0 && (
              <div className="stack">
                <div className="alert">
                  {problems.length} problem{problems.length === 1 ? "" : "s"} in the file. Nothing has been imported.
                  Fix {problems.length === 1 ? "it" : "them"} in the spreadsheet and choose the file again.
                </div>
                <DataGrid
                  id="menu-import-problems"
                  variant="compact"
                  caption="Problems in the file"
                  rows={problems}
                  rowKey={(problem, index) => `${problem.line}-${problem.column}-${index}`}
                  rowNoun={["problem", "problems"]}
                  columns={[
                    {
                      key: "line",
                      header: "Row",
                      type: "number",
                      value: (problem) => problem.line,
                      mobile: "subtitle",
                      width: 84,
                      pin: true,
                      render: (problem, ctx) => <span className="mono">{ctx.card ? `Row ${problem.line}` : problem.line}</span>,
                    },
                    {
                      key: "column",
                      header: "Column",
                      value: (problem) => columnName(problem.column),
                      mobile: "title",
                      render: (problem) => <span className="nowrap">{columnName(problem.column)}</span>,
                    },
                    { key: "message", header: "Problem", value: (problem) => problem.message, mobile: "show", minWidth: 240 },
                  ]}
                />
              </div>
            )}

            {(check.newCategories.length > 0 || check.newAddOns.length > 0 || check.addOnPriceChanges.length > 0) && (
              <div className="mnu-side-effects">
                {check.newCategories.length > 0 && (
                  <div>
                    <strong>New categories:</strong>{" "}
                    {check.newCategories.map((row, index) => (
                      <span key={row.name}>
                        {index > 0 && ", "}
                        {row.name}
                        {row.similarTo && <span className="mnu-flag-text"> (looks like “{row.similarTo}” — a typo?)</span>}
                      </span>
                    ))}
                  </div>
                )}
                {check.newAddOns.length > 0 && (
                  <div>
                    <strong>New add-ons:</strong>{" "}
                    {check.newAddOns.map((row) => `${row.name} ${money(row.price, currency)}`).join(", ")}
                  </div>
                )}
                {check.addOnPriceChanges.length > 0 && (
                  <div>
                    <strong>Add-on prices changing everywhere:</strong>{" "}
                    {check.addOnPriceChanges.map((row, index) => (
                      <span key={row.id} className={row.flag ? "mnu-flag-text" : ""}>
                        {index > 0 && ", "}
                        {row.name} {money(row.from, currency)} → {money(row.to, currency)} (on {row.dishCount} dish
                        {row.dishCount === 1 ? "" : "es"}){row.flag && " — a typo?"}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <p className="muted small">
              Using columns: <span className="mono">{check.columns.used.map(columnName).join(", ") || "none"}</span>
              {check.columns.ignored.length > 0 && (
                <>
                  {" "}· Ignored (not a column we know):{" "}
                  <span className="mono">{check.columns.ignored.join(", ")}</span>
                </>
              )}
            </p>

            <div className="segmented mnu-filter" role="tablist" aria-label="Show">
              {FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === item.key}
                  className={`segment${filter === item.key ? " is-active" : ""}`}
                  onClick={() => setFilter(item.key)}
                >
                  {item.label} <span className="mnu-count">{count(counts[item.key])}</span>
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <p className="mnu-lead">
                <Icon name="info" size={16} />
                <span>Nothing to show here.</span>
              </p>
            ) : (
              // Every row of the file, a page at a time (a file holds up to 2,000).
              <DataGrid
                id="menu-import-preview"
                variant="compact"
                caption="What the import will do, row by row"
                rows={visible}
                rowKey={(row) => row.line}
                rowClassName={(row) => (row.flagged ? "dg-tone-warning" : "")}
                rowNoun={["row", "rows"]}
                columns={[
                  {
                    key: "line",
                    header: "Row",
                    type: "number",
                    value: (row) => row.line,
                    mobile: "subtitle",
                    width: 84,
                    pin: true,
                    render: (row, ctx) => <span className="mono">{ctx.card ? `Row ${row.line}` : row.line}</span>,
                  },
                  {
                    key: "dish",
                    header: "Dish",
                    value: (row) => row.name,
                    mobile: "title",
                    width: 240,
                    render: (row) => (
                      <>
                        <div className="mnu-dish">{row.name}</div>
                        <div className="muted small">{row.category}</div>
                        <span className={`mnu-action mnu-action-${row.action}`}>
                          {row.action === "create" ? "New" : row.action === "update" ? "Changes" : "No change"}
                        </span>
                      </>
                    ),
                  },
                  {
                    key: "what",
                    header: "What happens",
                    value: (row) => (row.action === "create" ? "New" : row.action === "update" ? "Changes" : "No change"),
                    sortable: false,
                    mobile: "show",
                    minWidth: 260,
                    render: (row) => (
                      <>
                        {row.action === "create" && row.details && (
                          <div className="mnu-change">
                            {shown(row.details.price, currency)} · {row.details.foodType || "—"} · {row.details.taxRate || "—"}
                            {row.details.available === false && " · Sold out"}
                            {row.details.sizes && <div className="muted small">Sizes: {row.details.sizes}</div>}
                            {row.details.addOns && <div className="muted small">Add-ons: {row.details.addOns}</div>}
                            {row.details.kitchenName && (
                              <div className="muted small">Kitchen name: {row.details.kitchenName}</div>
                            )}
                            {row.details.sizeKitchenNames && (
                              <div className="muted small">Size kitchen names: {row.details.sizeKitchenNames}</div>
                            )}
                          </div>
                        )}
                        {row.changes.map((change, index) => (
                          <div key={`${change.field}-${index}`} className={`mnu-change${change.flag ? " is-flag" : ""}`}>
                            <span className="mnu-change-label">{change.label}</span>{" "}
                            <span className="mnu-from">{shown(change.from, currency)}</span>
                            <span aria-hidden="true"> → </span>
                            <span className="mnu-to">{shown(change.to, currency)}</span>
                            {change.derived && <span className="muted small"> (follows the dish price)</span>}
                            {change.flag && <div className="mnu-flag-text">{change.flag}</div>}
                          </div>
                        ))}
                        {(row.flags || [])
                          .filter((flag) => !row.changes.some((change) => change.flag === flag))
                          .map((flag) => (
                            <div key={flag} className="mnu-change is-flag">
                              <div className="mnu-flag-text">{flag}</div>
                            </div>
                          ))}
                        {row.notes.map((note) => (
                          <div key={note} className="muted small mnu-note">
                            {note}
                          </div>
                        ))}
                      </>
                    ),
                  },
                ]}
              />
            )}

            {ready && check.flagged > 0 && (
              <label className="checkbox mnu-confirm">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>
                  I have checked the {check.flagged} dish{check.flagged === 1 ? "" : "es"} marked for a second look
                </span>
              </label>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
