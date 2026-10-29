import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "./StatTile";
import SuccessCheck from "./SuccessCheck";
import { ErrorMessage } from "./Feedback";
import DataGrid from "./DataGrid/DataGrid";
import useShake from "../hooks/useShake";
import { downloadCsv, parseCsv } from "../services/csv";
import { getErrorMessage } from "../services/api";
import { count } from "@bmp/shared/format";
import "../styles/menu.css";
import "../styles/backoffice.css";

// One import screen for every spreadsheet import: the restaurant's stock
// items, suppliers, recipes and guest book, a hardware shop's shades, and a
// shop's products, customers and suppliers. The file is read here with the
// app's one CSV reader and sent as plain rows (heading → cell); the server
// checks it first and says, row by row and column by column, what is wrong or
// what would change. Nothing is written until Import is pressed, and what is
// imported is exactly what was previewed: if a record changed in between, the
// server refuses the stale preview and the file is checked again.
//
// Props:
//   title, description          the dialog's heading
//   noun / nounPlural           "item" / "items", for the buttons and tiles
//   loadGuide()                 → { maxRows, columns: [{ key, label, need, help, example }], sample, notes? }
//   runImport(payload)          → the API's { message, data } for { rows, dryRun, fileName, fingerprint, requestKey?, ...options }
//   sampleName                  the sample file's name
//   promises                    [{ title, text }] shown before a file is chosen
//   lead                        how records are matched, one sentence
//   options                     extra fields for the request (the guest import's "mode")
//   optionsControl              a control for them, shown above the file box
//   extraTiles(check)           more tiles for the check (opening stock, points)
//   describeRow(row)            a line under a row's name (an ingredient, a mobile)
//   partial                     a row with a problem is refused alone and the rest
//                               go in (the shops' imports: rows "refused" with
//                               their reasons); otherwise any problem stops the file
//   requestKeys                 the import carries a request key, the same for every
//                               try of one check, so a retry is done once
//   onClose(), onImported(message)

const NEED_WORDS = {
  always: "Always",
  new: "For new ones",
  optional: "Optional",
};

// "Already here" and "Refused" show only when the check has such rows.
const FILTERS = [
  { key: "changes", label: "Changes" },
  { key: "create", label: "New" },
  { key: "update", label: "Updated" },
  { key: "skipped", label: "Already here" },
  { key: "refused", label: "Refused" },
  { key: "unchanged", label: "Unchanged" },
];
const ACTION_WORDS = { create: "New", update: "Changes", skipped: "Already here", refused: "Refused", unchanged: "No change" };
// A row worth a look: one that changes something, is refused, or carries a note.
const needsLook = (row) => row.action !== "unchanged" || (row.notes || []).length > 0;
// An import of thousands of rows takes a while: say so while it runs.
const LONG_FILE = 500;

// A spreadsheet read into { heading: cell } rows, headings exactly as typed.
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

const shown = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));

const DETAIL_WORDS = {
  mobile: "Mobile",
  gstin: "GSTIN",
  creditDays: "Credit days",
  unit: "Unit",
  category: "Category",
  reorderLevel: "Reorder level",
  packs: "Packs",
  opening: "Opening stock",
  store: "Store",
  base: "Base",
  formula: "Formula (ml per litre)",
  kind: "Kind",
  price: "Sale price",
  gst: "GST",
  mrp: "MRP",
  hsn: "HSN / SAC",
  cost: "Purchase price",
  phone: "Phone",
  email: "Email",
  state: "State",
  pan: "PAN",
  creditLimit: "Credit limit",
  balance: "Opening balance",
};

const detailText = (details) =>
  Object.entries(details || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "" && typeof value !== "object")
    .map(([key, value]) => `${DETAIL_WORDS[key] || key}: ${value}`)
    .join(" · ");

export default function SheetImportModal({
  title,
  description,
  noun = "record",
  nounPlural = "records",
  loadGuide,
  runImport,
  sampleName = "sample.csv",
  promises = [],
  lead,
  options = {},
  optionsControl = null,
  extraTiles = null,
  describeRow = null,
  partial = false,
  requestKeys = false,
  onClose,
  onImported,
}) {
  const fileRef = useRef(null);
  const [dropRef, shake] = useShake();
  const [guide, setGuide] = useState(null);
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [check, setCheck] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState("changes");
  const [done, setDone] = useState(null);
  // One request key for each check: pressing Import again after a lost answer
  // sends the same key, and the server answers the first import.
  const requestKey = useMemo(() => (requestKeys && check ? crypto.randomUUID() : null), [requestKeys, check]);

  useEffect(() => {
    loadGuide()
      .then(setGuide)
      .catch(() => setGuide(null));
    // loadGuide is a service function, the same for the dialog's whole life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const optionKey = JSON.stringify(options);

  const runCheck = async (sheetRows, name) => {
    setBusy(true);

    try {
      const result = await runImport({ rows: sheetRows, dryRun: true, fileName: name, ...options });
      setCheck(result.data);

      if (result.data && result.data.problems && result.data.problems.length > 0) {
        shake();
      }
    } catch (err) {
      const response = err.response && err.response.data;

      if (response && response.data && response.data.problems) {
        setCheck(response.data);
        shake();
      } else {
        setError(getErrorMessage(err));
        shake();
      }
    } finally {
      setBusy(false);
    }
  };

  // The guest import's "already in the book" choice changes the plan, so the
  // same file is checked again when it changes.
  useEffect(() => {
    if (rows.length > 0 && check) {
      runCheck(rows, fileName);
    }
    // Re-run only when the options change; rows and the check are read as they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKey]);

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
      shake();
      return;
    }

    const parsed = readSheet(await file.text());

    if (parsed.length === 0) {
      setError("That file has no rows under its heading row.");
      shake();
      return;
    }

    setRows(parsed);
    setFileName(file.name);
    await runCheck(parsed, file.name);
  };

  const confirm = async () => {
    setBusy(true);
    setImporting(true);
    setError("");

    try {
      const result = await runImport({ rows, dryRun: false, fileName, fingerprint: check.fingerprint, ...(requestKey ? { requestKey } : {}), ...options });
      setDone(result.message);
    } catch (err) {
      const response = err.response && err.response.data;

      if (err.response && err.response.status === 409 && response && response.data && response.data.reason === "stale_preview") {
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

      shake();
    } finally {
      setBusy(false);
      setImporting(false);
    }
  };

  const downloadSample = () => {
    if (guide) {
      downloadCsv([guide.sample.columns, ...guide.sample.rows], sampleName);
    }
  };

  const problems = (check && check.problems) || [];
  const headings = (check && check.columns && check.columns.headings) || {};
  const labelOf = (key) => {
    const column = guide && guide.columns.find((entry) => entry.key === key);
    return headings[key] || (column && column.label) || key || "—";
  };
  const planned = useMemo(() => (check && check.rows) || [], [check]);
  const ready = Boolean(check && check.ok && rows.length > 0);
  const work = check ? check.created + check.updated : 0;

  const counts = {
    changes: planned.filter(needsLook).length,
    create: check ? check.created : 0,
    update: check ? check.updated : 0,
    skipped: planned.filter((row) => row.action === "skipped").length,
    refused: planned.filter((row) => row.action === "refused").length,
    unchanged: check ? check.unchanged : 0,
  };
  const filters = FILTERS.filter((item) => !["skipped", "refused"].includes(item.key) || counts[item.key] > 0);
  // A check run again may have no rows left for the tab chosen: show the changes then.
  const shownFilter = filters.some((item) => item.key === filter) ? filter : "changes";

  const visible = useMemo(() => {
    if (shownFilter === "changes") {
      return planned.filter(needsLook);
    }

    return planned.filter((row) => row.action === shownFilter);
  }, [planned, shownFilter]);

  if (done) {
    return (
      <Modal
        title={title}
        icon="upload"
        onClose={() => onImported(done)}
        width={520}
        footer={
          <button type="button" className="button" onClick={() => onImported(done)}>
            Done
          </button>
        }
      >
        <div className="bo-done">
          <SuccessCheck size={48} label="Imported" />
          <p>{done}</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      description={description}
      icon="upload"
      onClose={onClose}
      width={1040}
      footer={
        <>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button" onClick={confirm} disabled={!ready || busy || work === 0}>
            {busy
              ? "Working…"
              : ready && work === 0
                ? "Nothing to import"
                : ready
                  ? `Import ${count(work)} ${work === 1 ? noun : nounPlural}`
                  : "Import"}
          </button>
        </>
      }
    >
      <div className="stack mnu-import" ref={dropRef}>
        <ErrorMessage message={error} />
        {notice && <div className="alert alert-notice">{notice}</div>}
        {importing && rows.length >= LONG_FILE && (
          <div className="alert alert-notice" role="status">
            Importing {count(rows.length)} rows. A file this long takes a minute or two: keep this window open until it says it is done.
          </div>
        )}
        {optionsControl}

        {!check && (
          <>
            <ul className="mnu-promises">
              {[
                { title: "Only what your file says changes.", text: "Columns you leave out, and empty cells, keep what is on file now." },
                partial
                  ? { title: "A row with a problem is left out.", text: "You see each one and why first; the rest go in together, or none of them do." }
                  : { title: "All or nothing.", text: "If any row has a problem, nothing is imported until it is fixed." },
                { title: "Nothing is saved until you press Import.", text: "You see every change, old and new, first. The same file twice changes nothing." },
                ...promises,
              ].map((promise) => (
                <li key={promise.title}>
                  <Icon name="check-circle" size={18} className="mnu-promise-icon" />
                  <span>
                    <strong>{promise.title}</strong>
                    <span>{promise.text}</span>
                  </span>
                </li>
              ))}
            </ul>

            <label className={`mnu-drop${busy ? " is-busy" : ""}`}>
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={readFile} disabled={busy} />
              <span className="mnu-drop-icon" aria-hidden="true">
                {busy ? <span className="spinner" /> : <Icon name="upload" size={22} />}
              </span>
              <span className="mnu-drop-title">{busy ? "Checking the file…" : "Choose a CSV file"}</span>
              <span className="muted small">
                From Excel or Google Sheets: File → Save As / Download → CSV. Up to {guide ? count(guide.maxRows) : "2,000"} rows.
              </span>
            </label>

            <div className="mnu-guide-head">
              <p className="muted small">{lead}</p>
              <button type="button" className="button button-secondary button-sm" onClick={downloadSample} disabled={!guide}>
                <Icon name="download" size={15} /> Download sample file
              </button>
            </div>
            {guide && guide.notes && guide.notes.length > 0 && (
              <ul className="mnu-guide-notes">
                {guide.notes.map((note) => (
                  <li key={note} className="small">
                    <Icon name="info" size={15} /> <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}

            {guide && (
              <details className="mnu-guide">
                <summary>
                  <Icon name="chevron-right" size={16} className="mnu-guide-caret" />
                  What each column means
                </summary>
                <DataGrid
                  id="sheet-import-guide"
                  caption="What each column means"
                  variant="compact"
                  pageSize={false}
                  rowNoun={["column", "columns"]}
                  rows={guide.columns}
                  rowKey={(column) => column.key}
                  columns={[
                    { key: "label", header: "Column", value: (column) => column.label, mobile: "title", render: (column) => <span className="nowrap">{column.label}</span> },
                    {
                      key: "need",
                      header: "Needed",
                      value: (column) => column.need,
                      mobile: "subtitle",
                      render: (column) => (
                        <span className={`badge ${column.need === "optional" ? "badge-neutral" : "badge-primary"}`}>{NEED_WORDS[column.need] || column.need}</span>
                      ),
                    },
                    { key: "help", header: "What to write", value: (column) => column.help, minWidth: 220 },
                    { key: "example", header: "Example", value: (column) => column.example, render: (column) => <span className="mono">{column.example}</span> },
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
              <StatTile size="sm" icon="plus" tone="success" label={`New ${nounPlural}`} value={count(check.created)} />
              <StatTile size="sm" icon="edit" tone="info" label="Changing" value={count(check.updated)} />
              <StatTile size="sm" icon="check" label="Unchanged" value={count(check.unchanged)} />
              {counts.skipped > 0 && <StatTile size="sm" icon="ban" label="Already here" value={count(counts.skipped)} />}
              {counts.refused > 0 && <StatTile size="sm" icon="alert" tone="warning" label="Refused" value={count(counts.refused)} />}
              {extraTiles && extraTiles(check)}
              {/* Where a row's problem only refuses that row, the tile is for problems with the whole file. */}
              {(!partial || problems.length > 0) && (
                <StatTile
                  size="sm"
                  icon="x-circle"
                  tone={problems.length > 0 ? "danger" : "neutral"}
                  label="Problems"
                  value={count(problems.length)}
                />
              )}
            </div>

            {problems.length > 0 && (
              <div className="stack">
                <div className="alert">
                  {problems.length} problem{problems.length === 1 ? "" : "s"} in the file. Nothing has been imported. Fix{" "}
                  {problems.length === 1 ? "it" : "them"} in the spreadsheet and choose the file again.
                </div>
                <DataGrid
                  id="sheet-import-problems"
                  caption="Problems in the file"
                  variant="compact"
                  rowNoun={["problem", "problems"]}
                  rows={problems}
                  rowKey={(problem, index) => `${problem.line}-${problem.column}-${index}`}
                  rowClassName={() => "dg-tone-danger"}
                  columns={[
                    { key: "line", header: "Row", type: "number", align: "left", width: 90, value: (problem) => problem.line, mobile: "title", render: (problem, ctx) => <span className="mono">{ctx.card ? `Row ${problem.line}` : problem.line}</span> },
                    { key: "column", header: "Column", value: (problem) => labelOf(problem.column), mobile: "subtitle", render: (problem) => <span className="nowrap">{labelOf(problem.column)}</span> },
                    { key: "problem", header: "Problem", value: (problem) => problem.message, minWidth: 240, mobile: "show" },
                  ]}
                />
              </div>
            )}

            {partial && counts.refused > 0 && problems.length === 0 && (
              <div className="alert alert-notice">
                {counts.refused === 1 ? "1 row has a problem and is left out" : `${count(counts.refused)} rows have a problem and are left out`}: see why under
                Refused. Import the rest now, or fix {counts.refused === 1 ? "it" : "them"} in the spreadsheet and choose the file again.
              </div>
            )}

            <p className="muted small">
              Using columns: <span className="mono">{check.columns.used.map(labelOf).join(", ") || "none"}</span>
              {check.columns.ignored.length > 0 && (
                <>
                  {" "}
                  · Ignored (not a column we know): <span className="mono">{check.columns.ignored.join(", ")}</span>
                </>
              )}
            </p>

            <div className="segmented mnu-filter" role="tablist" aria-label="Show">
              {filters.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={shownFilter === item.key}
                  className={`segment${shownFilter === item.key ? " is-active" : ""}`}
                  onClick={() => setFilter(item.key)}
                >
                  {item.label} <span className="mnu-count">{count(counts[item.key])}</span>
                </button>
              ))}
            </div>

            <DataGrid
              id="sheet-import-preview"
              caption="What the import would do"
              variant="compact"
              rowNoun={["row", "rows"]}
              rows={visible}
              rowKey={(row) => `${row.line}-${row.key}`}
              rowClassName={(row) => (row.action === "refused" ? "dg-tone-danger" : "")}
              empty="Nothing to show here."
              emptyIcon="info"
              columns={[
                { key: "line", header: "Row", type: "number", align: "left", width: 90, value: (row) => row.line, render: (row) => <span className="mono">{row.line}</span> },
                {
                  key: "name",
                  header: noun.charAt(0).toUpperCase() + noun.slice(1),
                  value: (row) => row.name,
                  mobile: "title",
                  // Nothing pinned in a dialog: the spreadsheet's row number stays first.
                  pin: false,
                  render: (row) => (
                    <>
                      <div className="mnu-dish">{row.name}</div>
                      {describeRow && <div className="muted small">{describeRow(row)}</div>}
                      <span className={`mnu-action mnu-action-${row.action}`}>{ACTION_WORDS[row.action] || ACTION_WORDS.unchanged}</span>
                    </>
                  ),
                },
                {
                  key: "what",
                  header: "What happens",
                  minWidth: 260,
                  mobile: "show",
                  sortable: false,
                  value: (row) => [row.action === "create" ? detailText(row.details) : "", ...(row.reasons || []).map((reason) => reason.message),
                    ...(row.changes || []).map((change) => change.label), ...(row.notes || [])].filter(Boolean).join(" · "),
                  render: (row) => (
                    <>
                      {(row.reasons || []).map((reason, index) => (
                        <div key={`${reason.column}-${index}`} className="mnu-change mnu-reason">
                          <span className="mnu-change-label">{labelOf(reason.column)}</span> {reason.message}
                        </div>
                      ))}
                      {row.action === "create" && row.details && detailText(row.details) && <div className="mnu-change">{detailText(row.details)}</div>}
                      {(row.changes || []).map((change, index) => (
                        <div key={`${change.field}-${index}`} className="mnu-change">
                          <span className="mnu-change-label">{change.label}</span> <span className="mnu-from">{shown(change.from)}</span>
                          <span aria-hidden="true"> → </span>
                          <span className="mnu-to">{shown(change.to)}</span>
                        </div>
                      ))}
                      {(row.notes || []).map((note) => (
                        <div key={note} className="muted small mnu-note">
                          {note}
                        </div>
                      ))}
                    </>
                  ),
                },
              ]}
            />
          </>
        )}
      </div>
    </Modal>
  );
}
