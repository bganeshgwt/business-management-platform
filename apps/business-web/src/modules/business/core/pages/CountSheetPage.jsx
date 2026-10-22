import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import ReasonDialog from "./ReasonDialog";
import { Badge, BusinessHeader } from "./ui";
import { dateTime, quantity, useDirtyGuard, useOpenBusiness } from "./hooks";

// One count sheet: type what is on the shelf, save as you go, and (with
// approval rights) post the differences.
export default function CountSheetPage() {
  const biz = useOpenBusiness();
  const { countId } = useParams();
  const [count, setCount] = useState(null);
  const [edits, setEdits] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  useDirtyGuard(Object.keys(edits).length > 0);

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `counts/${countId}`, undefined, controller.signal)
      .then((c) => { setCount(c); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, countId, version]);

  const open = count?.status === "open";
  const canEnter = open && biz.can("stock_counts.create");
  const value = (line, name) => (edits[line.id]?.[name] ?? (name === "counted" ? (line.counted_quantity === null ? "" : String(Number(line.counted_quantity))) : (line.reason ?? "")));
  const setValue = (line, name, next) => setEdits((all) => ({ ...all, [line.id]: { counted: value(line, "counted"), reason: value(line, "reason"), ...all[line.id], [name]: next } }));
  const difference = (line) => {
    const counted = value(line, "counted");
    if (counted === "" || counted === null) return null;
    const against = open ? line.current_quantity : line.system_quantity ?? line.expected_quantity;
    return Math.round((Number(counted) - Number(against)) * 1000) / 1000;
  };
  const lines = useMemo(() => count?.lines || [], [count]);
  const counted = lines.filter((l) => value(l, "counted") !== "").length;
  const differences = lines.filter((l) => (difference(l) ?? 0) !== 0).length;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await businessWrite(biz.id, `counts/${countId}/lines`, { lines: Object.entries(edits).map(([lineId, e]) => ({ lineId, countedQuantity: e.counted === "" ? null : e.counted, reason: e.reason || null })) }, "patch");
      setEdits({});
      setNotice("Counts saved.");
      setVersion((n) => n + 1);
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: "label", header: "Item", value: (l) => l.label, mobile: "title", render: (l) => <span className="bz-two-line"><strong>{l.label}</strong><small className="muted mono">{l.code}{l.lot_code ? ` · ${l.lot_code}` : ""}</small></span> },
    { key: "expected", header: open ? "System now" : "System then", type: "number", value: (l) => Number(open ? l.current_quantity : l.system_quantity ?? l.expected_quantity), render: (l) => quantity(open ? l.current_quantity : l.system_quantity ?? l.expected_quantity, l.unit) },
    { key: "counted", header: "Counted", type: "number", value: (l) => Number(value(l, "counted") || 0), render: (l, ctx) => (canEnter
      ? <input aria-label={ctx.label} type="number" min="0" step={l.unit_decimals === 0 ? "1" : "0.001"} value={value(l, "counted")} onChange={(e) => setValue(l, "counted", e.target.value)} placeholder="—" />
      : (l.counted_quantity === null ? <span className="muted">Not counted</span> : quantity(l.counted_quantity, l.unit))) },
    { key: "difference", header: "Difference", type: "number", value: (l) => difference(l) ?? 0, render: (l) => {
      const d = difference(l);
      if (d === null) return <span className="muted">—</span>;
      return <span className={d < 0 ? "bz-minus" : d > 0 ? "bz-plus" : "muted"}>{d > 0 ? "+" : ""}{quantity(d, l.unit)}</span>;
    } },
    { key: "reason", header: "Reason for a difference", value: (l) => value(l, "reason"), render: (l, ctx) => (canEnter
      ? <input aria-label={ctx.label} maxLength={300} value={value(l, "reason")} onChange={(e) => setValue(l, "reason", e.target.value)} placeholder={difference(l) ? "e.g. Damaged" : ""} />
      : l.reason || <span className="muted">—</span>) },
  ];

  if (!count) {
    return <div className="stack"><BusinessHeader icon="clipboard" title="Stock count" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  }
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title={`Count ${count.count_no}`}
        description={`${count.location_name} · started ${dateTime(count.created_at)} by ${count.created_by_name}${count.notes ? ` · ${count.notes}` : ""}`}
        actions={<Link className="button button-secondary" to={biz.path("counts")}><Icon name="arrow-left" size={15} /> All counts</Link>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="list" label="Lines on the sheet" value={lines.length} />
        <StatTile icon="check-circle" tone={counted === lines.length ? "success" : "primary"} label="Counted" value={counted} of={`of ${lines.length}`} />
        <StatTile icon="alert" tone={differences ? "warning" : "neutral"} label="Differences" value={differences} note={open ? "against stock right now" : "posted as corrections"} />
        <StatTile icon="clipboard" label="Status" value={<Badge status={count.status} label={open ? "Counting" : undefined} />} note={count.closed_at ? `${dateTime(count.closed_at)} · ${count.closed_by_name}` : undefined} />
      </div>
      <SectionCard flush icon="clipboard" title="Count sheet" description={open ? "Leave a line empty if you did not count it; it is skipped." : undefined}
        actions={open && (
          <div className="form-actions">
            {canEnter && <button type="button" className="button button-secondary" disabled={busy || !Object.keys(edits).length} onClick={save}>Save counts</button>}
            {biz.can("stock_counts.cancel") && <button type="button" className="button button-secondary" disabled={busy} onClick={() => setDialog("cancel")}>Cancel count</button>}
            {biz.can("stock_counts.approve") && <button type="button" className="button" disabled={busy || counted === 0} onClick={async () => { if (!Object.keys(edits).length || (await save())) setDialog("post"); }}>Approve and post</button>}
          </div>
        )}>
        <DataGrid variant={canEnter ? "editor" : "compact"} id="business-count-sheet" caption="Count sheet" rows={lines} rowKey={(l) => l.id} columns={columns}
          rowClassName={(l) => ((difference(l) ?? 0) < 0 ? "dg-tone-danger" : (difference(l) ?? 0) > 0 ? "dg-tone-warning" : "")} />
      </SectionCard>
      {dialog === "post" && (
        <ReasonDialog title={`Approve ${count.count_no}`} icon="check-circle" submitLabel="Post corrections" required={false}
          label="Reason for differences without their own" placeholder="e.g. Month-end count"
          description={`${differences} difference${differences === 1 ? "" : "s"} will be posted against the stock at this moment.`}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => businessWrite(biz.id, `counts/${countId}/post`, { reason: reason || undefined })}
          onSaved={(result) => { setDialog(null); setNotice(`${count.count_no} posted with ${result.corrections} correction${result.corrections === 1 ? "" : "s"}.`); setVersion((n) => n + 1); }} />
      )}
      {dialog === "cancel" && (
        <ReasonDialog title={`Cancel ${count.count_no}`} submitLabel="Cancel count" description="Nothing on the sheet is posted."
          onClose={() => setDialog(null)}
          onSubmit={(reason) => businessWrite(biz.id, `counts/${countId}/cancel`, { reason })}
          onSaved={() => { setDialog(null); setEdits({}); setNotice("Count cancelled. Nothing was posted."); setVersion((n) => n + 1); }} />
      )}
    </div>
  );
}
