import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/rentals.css";

// Use and earnings for dates on the shop's calendar: each unit's days out
// against its days available (less maintenance booked) and the share of them
// it was out, the hires it went on and what it earned (the hire and the fees on
// bills dated then, before GST); each item with its units added up, a pool by
// piece-days, a kit by the hire billed as the kit.

const KIND = { unit: "One by one", pool: "Pool", kit: "Kit" };

export default function RentalReportsPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!from || !to || to < from) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "rentals/reports", { from, to }, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, from, to]);
  const money = data?.money;
  const exportName = biz.can("rentals.view") ? `${biz.business.code}-rental-use` : undefined;
  const useColumn = { key: "use", header: "Out (share of days)", type: "number", value: (r) => r.use, render: (r) => (r.use === null ? <span className="muted">—</span> : `${r.use}%`) };
  return (
    <div className="stack">
      <BusinessHeader icon="chart" title="Use & earnings" description="How much of the time each unit and item was out, and what it earned, for the dates chosen on the shop's calendar." />
      <ErrorMessage message={error} />
      <SectionCard icon="calendar" title="Dates">
        <div className="rnt-when">
          <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </SectionCard>
      {!data ? (!error && <Loading />) : (
        <>
          {money && (
            <div className="stat-grid">
              <StatTile icon="money" tone="primary" label="Hire earned" money={Number(data.totals.hire)} note="before GST, bills in these dates" />
              <StatTile icon="receipt" tone="neutral" label="Fees and charges" money={Number(data.totals.fees)} note="late, kilometres, fuel, damage" />
            </div>
          )}
          <SectionCard flush icon="key" title="By unit">
            <DataGrid variant="compact" id="rental-report-units" caption="Use by unit" rows={data.units} rowKey={(u) => u.unitId} currency={biz.symbol} rowNoun={["unit", "units"]} exportName={exportName}
              columns={[
                { key: "label", header: "Unit", value: (u) => u.label, mobile: "title", pin: true, render: (u) => <span className="bz-two-line"><span>{u.label}</span><small className="muted">{u.itemName}</small></span> },
                { key: "hires", header: "Hires", type: "number", value: (u) => u.hires, total: "sum" },
                { key: "daysOut", header: "Days out", type: "number", value: (u) => u.daysOut, total: "sum", mobile: "show" },
                { key: "daysAvailable", header: "Days available", type: "number", value: (u) => u.daysAvailable, total: "sum" },
                useColumn,
                money && { key: "hire", header: "Hire", type: "money", exact: true, value: (u) => Number(u.hire), total: "sum", mobile: "subtitle" },
                money && { key: "fees", header: "Fees", type: "money", exact: true, value: (u) => Number(u.fees), total: "sum" },
              ].filter(Boolean)}
              empty="No units" emptyIcon="key" />
          </SectionCard>
          <SectionCard flush icon="box" title="By item" description="A pool counts piece-days: each piece out for a day is one, against its pieces for each day.">
            <DataGrid variant="compact" id="rental-report-items" caption="Use by item" rows={data.items} rowKey={(i) => i.itemId} currency={biz.symbol} rowNoun={["item", "items"]} exportName={exportName}
              columns={[
                { key: "name", header: "Item", value: (i) => i.name, mobile: "title", pin: true },
                { key: "kind", header: "Hired out", value: (i) => KIND[i.kind] },
                { key: "hires", header: "Hires", type: "number", value: (i) => i.hires },
                { key: "daysOut", header: "Days out", type: "number", value: (i) => i.daysOut, render: (i) => (i.daysOut === null ? <span className="muted">—</span> : i.daysOut) },
                { key: "daysAvailable", header: "Days available", type: "number", value: (i) => i.daysAvailable, render: (i) => (i.daysAvailable === null ? <span className="muted">—</span> : i.daysAvailable) },
                useColumn,
                money && { key: "hire", header: "Hire", type: "money", exact: true, value: (i) => Number(i.hire), total: "sum", mobile: "subtitle" },
                money && { key: "fees", header: "Fees", type: "money", exact: true, value: (i) => Number(i.fees), total: "sum" },
              ].filter(Boolean)}
              empty="No items" emptyIcon="box" />
          </SectionCard>
        </>
      )}
    </div>
  );
}
