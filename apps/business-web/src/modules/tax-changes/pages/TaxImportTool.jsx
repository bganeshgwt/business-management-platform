import { useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../components/Modal";
import DataGrid from "../../../components/DataGrid/DataGrid";
import StatTile from "../../../components/StatTile";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { count } from "@bmp/shared/format";
import { addDays, nextApril, onDate, plural, rateText, readCodeList } from "../taxChanges";
import { OpenDocuments } from "./TaxNotices";
import "../styles/tax-changes.css";

// A GST notification's list, pasted or read from a CSV file: HSN / SAC codes,
// each with its new rate. A code of 4 or 6 digits finds every item whose code
// starts with it. The preview shows what each line finds, the codes that
// found nothing and the items two lines give different rates (put the list
// right first); scheduled, it becomes one change per new rate, or more when
// a rate moves more than 2,000 items, all in one go.
//
// api: shopChanges(id) or menuChanges(); words: WORDS.shop or WORDS.menu;
// pricesInclude: true, false or "mixed"; today: the business's own date.
export default function TaxImportTool({ api, words, pricesInclude, today, onClose, onScheduled }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [startsOn, setStartsOn] = useState(() => nextApril(today));
  const [keepNet, setKeepNet] = useState(false);
  const [preview, setPreview] = useState(null);
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => readCodeList(text), [text]);

  // Anything changed throws the preview away: what is scheduled is what was last shown.
  const changed = () => { setPreview(null); setError(""); };
  const readFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("That file is over 2 MB: a notification's list is smaller. Save only its codes and rates."); return; }
    const reader = new FileReader();
    reader.onload = () => { setText(String(reader.result || "")); setFileName(file.name); changed(); };
    reader.onerror = () => setError("That file could not be read. Save it as CSV (comma separated) and try again.");
    reader.readAsText(file);
  };
  const runPreview = async () => {
    setBusy(true);
    setError("");
    try {
      setPreview(await api.importPreview({ startsOn, keeps: keepNet ? "net" : "total", lines: list.lines }));
      setRequestKey(crypto.randomUUID());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const schedule = async () => {
    setBusy(true);
    setError("");
    try {
      onScheduled(await api.importSchedule({ requestKey, startsOn, keeps: keepNet ? "net" : "total", reason: reason.trim(), lines: list.lines }));
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  const blocked = preview && (preview.conflicts.length > 0 || preview.lines.some((l) => l.problem && l.found > 0));
  const ready = preview && !preview.dateProblem && !blocked && preview.moving > 0 && reason.trim() && !busy;
  const lineColumns = [
    { key: "code", header: "HSN / SAC", value: (l) => l.code, className: "mono", mobile: "title", pin: true },
    { key: "rate", header: "New rate", value: (l) => Number(l.rate), mobile: "subtitle",
      render: (l) => (l.target ? <>{l.target.name}</> : <span className="text-danger">{rateText(l.rate)}: {l.problem}</span>) },
    { key: "found", header: `${words.Items} found`, type: "number", value: (l) => l.found, mobile: "show" },
    { key: "items", header: words.Items, value: (l) => l.items.map((i) => i.label).join(", "),
      render: (l) => (l.found ? <small>{l.items.map((i) => i.label).join(", ")}{l.more > 0 ? ` and ${count(l.more)} more` : ""}</small> : <span className="muted">Finds nothing</span>) },
  ];

  return (
    <Modal title="Import a notification's list" icon="upload" width={1080} onClose={busy ? () => {} : onClose} dismissible={!busy}
      description={`HSN / SAC codes and their new rates, as the notification gives them. A code of 4 or 6 digits finds every ${words.item} whose code starts with it.`}
      footer={<>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={schedule} disabled={!ready}>
          {busy && preview ? "Scheduling…" : preview ? `Schedule ${plural(preview.changes.length, "change", "changes")} for ${plural(preview.moving, words.item, words.items)}` : "Schedule"}
        </button>
      </>}>
      <div className="stack txc-tool">
        <ErrorMessage message={error} />
        <div className="txc-grid">
          <fieldset className="field txc-panel">
            <legend>1 · The list</legend>
            <label className="field">
              <span>Paste it, one code and rate a line</span>
              <textarea rows={7} className="mono" value={text} onChange={(e) => { setText(e.target.value); setFileName(""); changed(); }}
                placeholder={"1905 31 00   5%\n4820, 12\n9963\t18"} />
            </label>
            <label className="field">
              <span>Or read a CSV file</span>
              <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={readFile} />
              {fileName && <small className="muted">Read {fileName}</small>}
            </label>
            <p className="muted small txc-note" aria-live="polite">
              {list.lines.length ? `${plural(list.lines.length, "line", "lines")} with a code and a rate` : "No codes yet"}
              {list.skipped.length > 0 && ` · ${plural(list.skipped.length, "line", "lines")} left out (not a code and a rate): ${list.skipped.slice(0, 3).map((s) => `line ${s.line}`).join(", ")}${list.skipped.length > 3 ? "…" : ""}`}
            </p>
          </fieldset>
          <fieldset className="field txc-panel">
            <legend>2 · The change</legend>
            <label className="field">
              <span>From</span>
              <input type="date" required min={addDays(today, 1)} value={startsOn} onChange={(e) => { setStartsOn(e.target.value); changed(); }} />
              <small className="muted">The first day of the new rates, on your own date.</small>
            </label>
            {pricesInclude !== false && (
              <label className="checkbox">
                <input type="checkbox" checked={keepNet} onChange={(e) => { setKeepNet(e.target.checked); changed(); }} />
                <span>Keep the price before GST instead<small className="muted txc-block">Otherwise a price that includes GST keeps its total.</small></span>
              </label>
            )}
            <div className="txc-go">
              <button type="button" className="button button-secondary" onClick={runPreview} disabled={!list.lines.length || !startsOn || busy}>
                <Icon name="eye" size={16} /> {busy && !preview ? "Working…" : preview ? "Preview again" : "Preview"}
              </button>
            </div>
          </fieldset>
        </div>

        {preview && (
          <>
            {preview.dateProblem && <div className="alert">{preview.dateProblem}</div>}
            <div className="stat-grid txc-stats">
              <StatTile size="sm" icon="check" tone="primary" label={`${words.Items} to move`} value={count(preview.moving)} />
              <StatTile size="sm" icon="layers" tone="neutral" label="Changes it becomes" value={count(preview.changes.length)} />
              <StatTile size="sm" icon="search" tone="neutral" label="Codes that find nothing" value={count(preview.unmatched.length)} />
              <StatTile size="sm" icon="alert" tone={preview.conflicts.length ? "danger" : "neutral"} label="Given two rates" value={count(preview.conflicts.length)} />
            </div>
            {preview.changes.length > 0 && (
              <p className="small">
                It becomes {preview.changes.map((c) => `${c.target.name} for ${plural(c.items, words.item, words.items)}`).join("; ")}
                {preview.changes.length > new Set(preview.changes.map((c) => c.target.id)).size ? `. A change holds 2,000 ${words.items}, so a larger rate is split into more than one, all scheduled now.` : "."}
              </p>
            )}
            {preview.conflicts.length > 0 && (
              <div className="alert" role="alert">
                <strong>{plural(preview.conflicts.length, words.item, words.items)} given two rates: put the list right first.</strong>
                <ul className="txc-document-list small">
                  {preview.conflicts.map((c) => <li key={c.id}>{c.label} ({c.hsn}): {c.lines.map((l) => `${l.code} at ${rateText(l.rate)}`).join(", ")}</li>)}
                </ul>
              </div>
            )}
            <DataGrid id="tax-import-lines" variant="compact" caption="What each line finds" rows={preview.lines} rowKey={(l) => l.code} columns={lineColumns}
              rowNoun={["line", "lines"]} rowClassName={(l) => (l.problem && l.found ? "dg-tone-danger" : !l.found ? "dg-tone-muted" : "")} />
            {preview.unmatched.length > 0 && <p className="muted small">Codes that find nothing: <span className="mono">{preview.unmatched.join(", ")}</span></p>}
            {preview.leftOutCount > 0 && (
              <details className="small">
                <summary>{plural(preview.leftOutCount, `${words.item} stays`, `${words.items} stay`)} where {preview.leftOutCount === 1 ? "it is" : "they are"}</summary>
                <ul className="txc-document-list">{preview.leftOut.map((i) => <li key={i.id}>{i.label}: <span className="muted">{i.problem}</span></li>)}</ul>
              </details>
            )}
            <OpenDocuments documents={preview.documents} words={words} />
            <label className="field field-wide">
              <span>Reason</span>
              <input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Notification 9/2027-Central Tax (Rate) of 15 March 2027" />
              <small className="muted">Kept with each change for good, with your name, from {onDate(startsOn)}.</small>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
