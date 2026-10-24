import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { monthStart } from "@bmp/shared/dates";
import { BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { tradeWord } from "./hardware";

// Fitters' commission by fitter for a period: their bills and those bills'
// value before GST, commission earned, taken back by returns and paid in the
// dates, and what each is due now.
export default function FitterReportPage() {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState(() => ({ from: monthStart(anchor), to: anchor }));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "hardware/fitter-report", range, controller.signal)
      .then((result) => { setData(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range, version]);
  const totals = data?.totals;
  const columns = useMemo(() => [
    { key: "name", header: "Fitter", value: (r) => r.name, mobile: "title", pin: true,
      render: (r) => <Link to={businessPath(biz.id, `fitters?fitter=${r.id}`)}>{r.name}</Link> },
    { key: "trade", header: "Trade", value: (r) => tradeWord(r.trade), mobile: "subtitle" },
    { key: "phone", header: "Phone", value: (r) => r.phone || "", defaultHidden: true },
    { key: "bills", header: "Bills", type: "number", value: (r) => r.bills, total: "sum" },
    { key: "sales", header: "Bills before tax", type: "money", exact: true, value: (r) => Number(r.sales), total: "sum" },
    { key: "earned", header: "Earned", type: "money", exact: true, value: (r) => Number(r.earned), total: "sum" },
    { key: "taken_back", header: "Taken back", type: "money", exact: true, value: (r) => Number(r.taken_back), total: "sum" },
    { key: "paid", header: "Paid", type: "money", exact: true, value: (r) => Number(r.paid), total: "sum" },
    { key: "due", header: "Due now", type: "money", exact: true, value: (r) => Number(r.due), total: "sum", mobile: "show" },
  ], [biz.id]);
  return (
    <div className="stack">
      <BusinessHeader icon="percent" title="Fitters' commission"
        description="What each fitter earned on their bills in these dates, what goods coming back took back, what was paid, and what each is due now." />
      <div className="stat-grid">
        <StatTile icon="percent" tone="primary" label="Earned" money={totals?.earned} loading={!totals && !error} note={totals ? `on ${totals.bills} bill${totals.bills === 1 ? "" : "s"}` : undefined} />
        <StatTile icon="undo" label="Taken back" money={totals?.takenBack} loading={!totals && !error} note="for goods returned" />
        <StatTile icon="wallet" tone="success" label="Paid" money={totals?.paid} loading={!totals && !error} />
        <StatTile icon="clock" tone="warning" label="Due now" money={totals?.due} loading={!totals && !error} note="to every fitter, whatever the dates" />
      </div>
      <SectionCard flush icon="users" title="By fitter">
        <DataGrid id="hardware-fitter-report" caption="Fitters' commission by fitter" columns={columns} rows={data?.rows || []} loading={!data && !error} error={data ? "" : error}
          onRetry={() => setVersion((n) => n + 1)} currency={biz.symbol} rowNoun={["fitter", "fitters"]} defaultSort={{ key: "earned", direction: "desc" }}
          exportName={biz.can("reports.export") ? `${biz.business.code}-fitter-commission-${range.from}-${range.to}` : undefined}
          toolbar={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="bill dates" onChange={setRange} />}
          empty="No fitters yet" emptyHint="Add fitters on the Fitters screen and name them on their bills." emptyIcon="users" />
      </SectionCard>
    </div>
  );
}
