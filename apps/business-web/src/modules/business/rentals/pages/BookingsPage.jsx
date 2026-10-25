import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Badge, BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { BOARD, STAGES, atWords, messageLink } from "./rentals";
import "../styles/rentals.css";

// Bookings: the day's board, a column for each stage a booking can be in
// (overdue, due back today, out, reserved, quotes, back to settle), each card
// with its hirer, what is hired, when it goes out or is due back on the
// business's clock and the deposit held; every booking by when it goes out
// for the desk; and a new booking. A booking opens with its lines and money.

export default function BookingsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [view, setView] = useState("board");
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "rentals/bookings/board", undefined, controller.signal)
      .then((b) => { setBoard(b); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const open = (b) => navigate(biz.path(`rental-bookings/${b.id}`));
  const counts = board?.counts;
  // ?new=1 (the Overview's "Make a booking") opens the booking form on its own page.
  const [params] = useSearchParams();
  if (params.get("new") === "1" && biz.can("rentals.create")) return <Navigate to={biz.path("rental-bookings/new")} replace />;

  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Bookings"
        description="What goes out, what is out and what is due back, on the shop's own clock. A booking holds its units and pieces from its out time to its due time and the turnaround time; the bill is made when everything is back."
        primary={biz.can("rentals.create") && <Link className="button" to={biz.path("rental-bookings/new")}><Icon name="plus" size={16} /> New booking</Link>} />
      <ErrorMessage message={error} />
      <SectionCard flush icon="calendar" title={view === "board" ? "Open bookings" : "All bookings"}
        description={view === "board" && counts ? [`${counts.out_now} out`, counts.overdue ? `${counts.overdue} overdue` : null, counts.pickup_today ? `${counts.pickup_today} going out today` : null,
          counts.late_pickup ? `${counts.late_pickup} past the out time` : null].filter(Boolean).join(" · ") : undefined}
        actions={<Segmented label="Show" options={[{ value: "board", label: "Board" }, { value: "all", label: "All bookings by date" }]} value={view} onChange={setView} />}>
        {view === "board" ? (board ? <Board biz={biz} board={board} onOpen={open} /> : !error && <Loading />) : <AllBookings biz={biz} onOpen={open} />}
      </SectionCard>
    </div>
  );
}

function Board({ biz, board, onOpen }) {
  const money = biz.can("sales.view");
  return (
    <div className="rnt-board" data-motion-skip>
      {BOARD.map((stage) => {
        const cards = board.items.filter((b) => b.stage === stage);
        return (
          <section key={stage} className={`rnt-col rnt-col-${stage}`} aria-label={STAGES[stage].label}>
            <h2 className="rnt-col-head">{STAGES[stage].label} <span>{cards.length}</span></h2>
            <ul className="rnt-col-list">
              {cards.map((b) => (
                <li key={b.id} className={`rnt-card ${b.overdue ? "is-late" : ""}`}>
                  <button type="button" className="rnt-card-open" onClick={() => onOpen(b)}>
                    <span className="rnt-card-top"><strong>{b.customer_name}</strong><span className="mono small muted">{b.booking_no}</span></span>
                    <span className="small">{b.items}</span>
                    <span className="rnt-card-meta">
                      {["quote", "reserved"].includes(b.status)
                        ? <span className={b.late_pickup ? "is-late" : ""}><Icon name="clock" size={12} /> out {atWords(b.out_at, biz)}{b.late_pickup ? " · not handed over" : ""}</span>
                        : b.status === "out" ? <span className={b.overdue ? "is-late" : ""}><Icon name="clock" size={12} /> due back {atWords(b.due_at, biz)}{b.overdue ? " · late" : ""}</span>
                          : <span>{b.status === "cancelled" ? "cancelled" : "back"}{b.document_no ? ` · ${b.document_no}` : ""}</span>}
                      {money && Number(b.deposit_held) > 0 && <span>deposit {biz.exact(b.deposit_held)}</span>}
                      {money && Number(b.bill_due) > 0 && <span className="is-late">to pay {biz.exact(b.bill_due)}</span>}
                      {money && b.stage === "to_settle" && Number(b.deposit_held) + Number(b.advance_left) > 0 && <span>to hand back</span>}
                    </span>
                  </button>
                  {b.customer_phone && ["reserved", "out"].includes(b.status) && (
                    <a className="rnt-card-message" href={messageLink(biz, b, b.overdue ? "late" : b.status === "out" ? "due" : "booked")} target="_blank" rel="noopener noreferrer"
                      title="Message the hirer on WhatsApp" aria-label={`WhatsApp ${b.customer_name}`}><Icon name="message" size={14} /></a>
                  )}
                </li>
              ))}
              {!cards.length && <li className="rnt-empty">Nothing here</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function AllBookings({ biz, onOpen }) {
  const list = useServerList("rentals/bookings", { gridId: "rental-bookings", period: "ahead" });
  const money = biz.can("sales.view");
  const many = biz.locations.length > 1;
  const columns = useMemo(() => [
    { key: "booking_no", header: "Booking", value: (b) => b.booking_no, className: "mono", mobile: "title", pin: true },
    { key: "customer", header: "Hirer", value: (b) => `${b.customer_name} ${b.customer_phone || ""}`, mobile: "show",
      render: (b) => <span className="bz-two-line"><span>{b.customer_name}</span>{b.customer_phone && <small className="muted">{b.customer_phone}</small>}</span> },
    { key: "items", header: "What is hired", value: (b) => b.items || "", mobile: "subtitle" },
    { key: "out_at", header: "Out", type: "datetime", value: (b) => b.out_at, render: (b) => atWords(b.out_at, biz) },
    { key: "due_at", header: "Due back", type: "datetime", value: (b) => b.due_at, render: (b) => <span className={b.overdue ? "bz-minus" : ""}>{atWords(b.due_at, biz)}{b.overdue ? " · late" : ""}</span> },
    { key: "stage", header: "Stage", type: "status", value: (b) => STAGES[b.stage]?.label || b.stage, mobile: "show",
      render: (b) => <Badge tone={STAGES[b.stage]?.tone} label={STAGES[b.stage]?.label || b.stage} />,
      filter: "select", filterOptions: Object.values(STAGES).map((s) => ({ value: s.label, label: s.label })) },
    money && { key: "total", header: "Hire", type: "money", exact: true, value: (b) => (b.total === null ? null : Number(b.total)), total: "sum" },
    money && { key: "deposit_held", header: "Deposit held", type: "money", exact: true, value: (b) => (b.deposit_held === null ? null : Number(b.deposit_held)), total: "sum" },
    money && { key: "bill_due", header: "To pay", type: "money", exact: true, value: (b) => (b.bill_due === null ? null : Number(b.bill_due)), total: "sum" },
    { key: "document_no", header: "Bill", value: (b) => b.document_no || "", className: "mono", defaultHidden: true },
    { key: "location", header: "Location", value: (b) => b.location_name, defaultHidden: !many },
  ].filter(Boolean), [biz, money, many]);
  return (
    <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Booking, hirer, phone, item or bill" }} caption="Bookings" columns={columns}
      currency={biz.symbol} rowNoun={["booking", "bookings"]} onRowClick={onOpen} toolbar={<PeriodFilter list={list} />}
      rowClassName={(b) => (b.overdue ? "dg-tone-danger" : b.stage === "to_settle" ? "dg-tone-warning" : ["closed", "cancelled"].includes(b.stage) ? "dg-tone-muted" : "")}
      exportName={biz.can("sales.export") ? `${biz.business.code}-bookings` : undefined}
      empty="No bookings going out in these dates" emptyHint="Pick other dates." emptyIcon="calendar" />
  );
}
