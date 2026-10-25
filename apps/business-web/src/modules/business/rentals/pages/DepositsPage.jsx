import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { DEPOSIT_NOTE, STATUS_WORDS, atWords } from "./rentals";
import "../styles/rentals.css";

// Deposits held: the refundable deposits taken for bookings, kept apart from
// sales. Each is a collection receipt in the hirer's name; what of it paid the
// booking's bill (applied: part of the payment then, the bill carrying the
// GST of what the shop kept) and what went back are that receipt's own
// payments and refunds. What is left is held: the shop owes it to the hirer.
// Booking by booking, those still holding money first (back or cancelled,
// to hand back, before those still out), and in all.

const STATES = { held: { label: "Held", tone: "info" }, to_hand_back: { label: "To hand back", tone: "warning" }, settled: { label: "Settled", tone: "neutral" } };

export default function DepositsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [show, setShow] = useState("holding");
  const [totals, setTotals] = useState(null);
  const [error, setError] = useState("");
  const list = useServerList("rentals/deposits", { gridId: "rental-deposits", params: show === "holding" ? { holding: "true" } : {} });
  const reloadKey = list.data?.total;
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "rentals/deposits/totals", undefined, controller.signal)
      .then((t) => { setTotals(t); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, reloadKey]);
  const many = biz.locations.length > 1;
  const columns = useMemo(() => [
    { key: "booking_no", header: "Booking", value: (d) => d.booking_no, className: "mono", mobile: "title", pin: true },
    { key: "customer", header: "Hirer", value: (d) => `${d.customer_name} ${d.customer_phone || ""}`, mobile: "show",
      render: (d) => <span className="bz-two-line"><span>{d.customer_name}</span>{d.customer_phone && <small className="muted">{d.customer_phone}</small>}</span> },
    { key: "state", header: "Deposit", type: "status", value: (d) => STATES[d.state].label, mobile: "show",
      render: (d) => <span className="bz-two-line"><Badge tone={STATES[d.state].tone} label={STATES[d.state].label} /><small className="muted">booking {STATUS_WORDS[d.status]?.toLowerCase()}</small></span>,
      filter: "select", filterOptions: Object.values(STATES).map((s) => ({ value: s.label, label: s.label })) },
    { key: "due_at", header: "Due back", type: "datetime", value: (d) => d.due_at, render: (d) => (d.returned_at ? `back ${atWords(d.returned_at, biz)}` : d.cancelled_at ? "cancelled" : atWords(d.due_at, biz)) },
    { key: "deposit_due", header: "Asked", type: "money", exact: true, value: (d) => Number(d.deposit_due), defaultHidden: true },
    { key: "collected", header: "Collected", type: "money", exact: true, value: (d) => Number(d.collected), total: "sum" },
    { key: "applied", header: "Applied to the bill", type: "money", exact: true, value: (d) => Number(d.applied), total: "sum" },
    { key: "refunded", header: "Handed back", type: "money", exact: true, value: (d) => Number(d.refunded), total: "sum" },
    { key: "held", header: "Held", type: "money", exact: true, value: (d) => Number(d.held), total: "sum", mobile: "subtitle" },
    { key: "receipts", header: "Receipts", value: (d) => d.receipts || "", className: "mono", defaultHidden: true },
    { key: "document_no", header: "Bill", value: (d) => d.document_no || "", className: "mono" },
    { key: "first_taken_at", header: "Taken", type: "datetime", value: (d) => d.first_taken_at, render: (d) => atWords(d.first_taken_at, biz), defaultHidden: true },
    { key: "location", header: "Location", value: (d) => d.location_name, defaultHidden: !many },
  ], [biz, many]);

  return (
    <div className="stack">
      <BusinessHeader icon="wallet" title="Deposits held" description={`${DEPOSIT_NOTE} The shop owes what it holds to its hirers.`} />
      <ErrorMessage message={error} />
      {totals && (
        <div className="stat-grid">
          <StatTile icon="wallet" tone={Number(totals.held) > 0 ? "warning" : "neutral"} label="Held now" money={Number(totals.held)} note={`for ${totals.bookings} ${totals.bookings === 1 ? "booking" : "bookings"}`} />
          <StatTile icon="alert" tone={totals.to_hand_back ? "danger" : "success"} label="To hand back" money={Number(totals.to_hand_back_amount)}
            note={totals.to_hand_back ? `${totals.to_hand_back} back or cancelled` : "nothing waiting"} />
          <StatTile icon="receipt" tone="primary" label="Applied to bills" money={Number(totals.applied)} note={`of ${biz.exact(totals.collected)} collected`} />
          <StatTile icon="refresh" tone="neutral" label="Handed back" money={Number(totals.refunded)} />
        </div>
      )}
      <SectionCard flush icon="wallet" title={show === "holding" ? "Holding money" : "Every deposit"}
        actions={<Segmented label="Show" options={[{ value: "holding", label: "Holding money" }, { value: "all", label: "Every deposit" }]} value={show} onChange={setShow} />}>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Booking, hirer, phone, receipt or bill" }} caption="Deposits" columns={columns}
          currency={biz.symbol} rowNoun={["deposit", "deposits"]} onRowClick={(d) => navigate(biz.path(`rental-bookings/${d.id}`))}
          rowClassName={(d) => (d.state === "to_hand_back" ? "dg-tone-warning" : d.state === "settled" ? "dg-tone-muted" : "")}
          exportName={biz.can("sales.export") ? `${biz.business.code}-deposits` : undefined}
          empty={show === "holding" ? "No deposit is held" : "No deposits taken yet"} emptyHint="A deposit is taken for a booking, at the handover or before it." emptyIcon="wallet" />
      </SectionCard>
    </div>
  );
}
