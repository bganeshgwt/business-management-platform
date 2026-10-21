import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Badge } from "./ui";

// Every cashier's shift on one day (Daily money): the float they started
// with, what their own cash movements say the drawer should hold, what they
// counted, and the difference with its reason. A shift still open shows the
// cash it should hold so far. Shifts are opened and closed at Quick bill.
export default function CashierShifts({ biz, date, locationId, version }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!date) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "shifts", { date, ...(locationId ? { location: locationId } : {}) }, controller.signal)
      .then((r) => { setData(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, date, locationId, version]);
  if (!date || !biz.can("sales.create") || (data && !data.items.length)) return null;
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const columns = [
    { key: "cashier", header: "Cashier", value: (s) => s.cashier_name, mobile: "title", pin: true,
      render: (s) => <span className="bz-two-line"><strong>{s.cashier_name}</strong><small className="muted">{s.location_name}</small></span> },
    { key: "when", header: "Shift", value: (s) => s.opened_at, render: (s) => `${time(s.opened_at)} – ${s.closed_at ? time(s.closed_at) : "now"}` },
    { key: "opening", header: "Opening cash", type: "money", exact: true, value: (s) => Number(s.opening_cash) },
    { key: "expected", header: "Should hold", type: "money", exact: true, value: (s) => Number(s.closed_at ? s.expected_cash : s.expected_so_far) },
    { key: "counted", header: "Counted", type: "money", exact: true, value: (s) => (s.closed_at ? Number(s.counted_cash) : null), render: (s) => (s.closed_at ? biz.exact(s.counted_cash) : <span className="muted">Not yet</span>) },
    { key: "difference", header: "Difference", type: "money", exact: true, value: (s) => (s.closed_at ? Number(s.difference) : null), mobile: "show",
      render: (s) => {
        if (!s.closed_at) return <Badge tone="info" label="Open" />;
        const d = Number(s.difference);
        return d === 0 ? <Badge tone="active" label="Matches" /> : <span className="bz-two-line"><strong className={d < 0 ? "text-danger" : ""}>{biz.exact(Math.abs(d))} {d < 0 ? "short" : "over"}</strong>{s.reason && <small className="muted">{s.reason}</small>}</span>;
      } },
  ];
  return (
    <SectionCard flush icon="wallet" title="Cashier shifts" description="Each cashier's drawer, checked against their own cash sales, collections, refunds and expenses. Opened and closed at Quick bill.">
      <ErrorMessage message={error} />
      <DataGrid id="business-cashier-shifts" caption="Cashier shifts" columns={columns} currency={biz.symbol}
        rows={data?.items || []} loading={!data && !error} rowNoun={["shift", "shifts"]} empty="No shifts on this day" />
    </SectionCard>
  );
}
