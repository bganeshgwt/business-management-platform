import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { Badge, BusinessHeader, PeriodFilter } from "./ui";
import { quantity, useOpenBusiness, useServerList } from "./hooks";

const SOURCES = { sale: "Sale", purchase: "Purchase", return: "Return", transfer: "Transfer", count: "Stock count", correction: "Correction" };
const TONES = { sale: "info", purchase: "active", return: "warning", transfer: "neutral", count: "info", correction: "warning" };

// Every change to stock, newest first: what moved, why, and the balance after.
export default function MovementsPage() {
  const biz = useOpenBusiness();
  const [source, setSource] = useState("");
  const list = useServerList("movements", { gridId: "business-movements", period: true, params: source ? { source } : {} });

  const columns = useMemo(() => [
    { key: "created_at", header: "When", type: "datetime", value: (m) => m.created_at, mobile: "subtitle" },
    { key: "label", header: "Item", value: (m) => m.label, mobile: "title", pin: true },
    { key: "location", header: "Location", value: (m) => m.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "lot", header: "Batch / serial", value: (m) => m.lot_code || "", className: "mono", defaultHidden: !biz.has("batches") && !biz.has("serials") },
    { key: "source", header: "Why", type: "status", value: (m) => SOURCES[m.source] || m.source, render: (m) => <Badge tone={TONES[m.source]} label={SOURCES[m.source] || m.source} /> },
    { key: "source_no", header: "Reference", value: (m) => (m.source === "correction" ? m.reason || "" : m.source_no), render: (m) => (m.source === "correction" ? <span className="muted">{m.reason}</span> : <span className="mono">{m.source_no}</span>) },
    { key: "quantity", header: "Change", type: "number", value: (m) => Number(m.quantity), render: (m) => <span className={Number(m.quantity) < 0 ? "bz-minus" : "bz-plus"}>{Number(m.quantity) > 0 ? "+" : ""}{quantity(m.quantity, m.unit)}</span>, mobile: "show" },
    { key: "balance_after", header: "Balance after", type: "number", value: (m) => Number(m.balance_after), render: (m) => quantity(m.balance_after, m.unit), mobile: "show" },
  ], [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="history" title="Stock movements"
        description="The stock ledger: every sale, receipt, return, transfer, count and correction. Each batch's balance is the sum of its movements." />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Movements in this period">
        <DataGrid {...list.gridProps} caption="Stock movements" columns={columns} rowNoun={["movement", "movements"]}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field">
                <span>Why</span>
                <select value={source} onChange={(e) => setSource(e.target.value)}>
                  <option value="">Everything</option>
                  {Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            </>
          )}
          exportName={biz.can("inventory.export") ? `${biz.business.code}-stock-movements` : undefined}
          empty="No stock moved in these dates" emptyIcon="history" />
      </SectionCard>
    </div>
  );
}
