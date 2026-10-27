import { useEffect, useRef, useState } from "react";
import SectionCard from "../../../components/SectionCard";
import DataGrid from "../../../components/DataGrid/DataGrid";
import { useOpenBusiness, useServerList } from "../../business/core/pages/hooks";
import { hsnSummary } from "../services/gstThresholds.service";
import { hsnWhen } from "../gstThresholds";
import "../styles/gst-thresholds.css";

// On a shop's catalogue, once its PAN's turnover has passed the figure from
// which every invoice carries a longer HSN / SAC code (last year: asked now;
// this year so far: from the next 1 April, listed now to prepare): the items
// whose code is shorter, or missing, to fix one by one (Edit opens the item's
// own form). Whoever looks after the catalogue sees what to fix, never the
// turnover. `refreshKey` changes when an item is saved, so the list follows
// the fixes.
export default function HsnToFix({ onEdit, refreshKey }) {
  const biz = useOpenBusiness();
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    hsnSummary(biz.id, controller.signal).then(setSummary).catch(() => { if (!controller.signal.aborted) setSummary(null); });
    return () => controller.abort();
  }, [biz.id, refreshKey]);
  if (!summary?.applies || summary.count === 0) return null;
  return <ItemsToFix summary={summary} onEdit={onEdit} refreshKey={refreshKey} />;
}

function ItemsToFix({ summary, onEdit, refreshKey }) {
  const biz = useOpenBusiness();
  const list = useServerList("gst-thresholds/hsn-items", { gridId: "gst-hsn-items" });
  const { reload } = list;
  const seen = useRef(refreshKey);
  useEffect(() => {
    if (seen.current !== refreshKey) {
      seen.current = refreshKey;
      reload();
    }
  }, [refreshKey, reload]);
  const columns = [
    { key: "label", header: "Item", value: (s) => s.label, mobile: "title", pin: true,
      render: (s) => <span className="bz-two-line"><strong>{s.label}</strong>{s.product_name !== s.label && <small className="muted">{s.product_name}</small>}</span> },
    { key: "code", header: "SKU", value: (s) => s.code, className: "mono", mobile: "subtitle" },
    { key: "hsn", header: "HSN / SAC now", value: (s) => s.hsn_code || "", mobile: "show",
      render: (s) => (s.hsn_code ? <span className="mono">{s.hsn_code}</span> : <span className="muted">None</span>) },
    { key: "kind", header: "Kind", value: (s) => (s.kind === "service" ? "Service (SAC)" : "Goods (HSN)") },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions",
      render: (s) => <button type="button" className="chip-button" onClick={() => onEdit(s)}>Edit</button> },
  ].filter(Boolean);
  return (
    <SectionCard flush tone="warning" icon="alert" title="HSN / SAC codes to fix" className="gst-hsn-card"
      description={`${summary.rule.applies} This applies to this business's invoices ${hsnWhen(summary)}: ${summary.count === 1 ? "one item has" : `${summary.count} items have`} a shorter code, or none. Give each its full ${summary.digits}-digit code; it prints on every bill.`}>
      <DataGrid {...list.gridProps} caption="Items whose HSN / SAC code is shorter" columns={columns} currency={biz.symbol}
        empty="Every item has its full code" emptyIcon="check-circle" />
    </SectionCard>
  );
}
