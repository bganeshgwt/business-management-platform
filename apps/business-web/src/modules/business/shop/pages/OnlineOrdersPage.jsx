import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { count } from "@bmp/shared/format";
import ContentTabs from "../../../../components/ContentTabs";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import LiveIndicator from "../../../../components/LiveIndicator";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { playChime, unlockChime } from "../../../../services/kot";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { complaintAction, complaints as readComplaints, onlineBoard, onlineReport, orderAction } from "../services/onlineShop.service";
import { COMPLAINT_OUTCOMES, DECLINE_REASONS, LANES, PAYMENT_WORDS, STATUS_TONES, STATUS_WORDS, complaintClock, declineClock, span } from "./onlineShop";
import "../styles/online-shop.css";

// Online orders (in Business Admin): the orders customers place from the shop
// link, from new to done. New orders wait on their own lane with the clock
// to the shop's own decline; Packing holds what was accepted; Ready & out
// what is billed and waiting at the counter or on its way; Done the day's
// finished ones. Everything moves live, and a new order chimes. Complaints
// and the report are tabs of their own.

const SOUND = "os.chime";
const soundOn = () => { try { return window.localStorage.getItem(SOUND) !== "off"; } catch { return true; } };

// The clock every card counts from: the server's (offset: how far this
// device's clock is from it, as the last read found), so a phone set a few
// minutes out still says the same as the guest's page.
function useClock(offset) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  return now + offset;
}

export function DeclineDialog({ order, onClose, onDone }) {
  const biz = useOpenBusiness();
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Decline ${order.orderNo}`} icon="ban" width={520} submitLabel="Decline the order"
      description="The customer sees your reason on their order's page, and pays nothing." onClose={onClose} onSaved={onDone}
      onSubmit={() => orderAction(biz.id, order.id, "decline", { reason: reason.trim() })}>
      <div className="field-wide os-reasons" role="group" aria-label="Quick reasons">
        {DECLINE_REASONS.map((text) => <button key={text} type="button" className="chip-button" onClick={() => setReason(text)}>{text}</button>)}
      </div>
      <Field label="Reason the customer sees" wide><input required maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    </FormDialog>
  );
}

function OrderCard({ order, now, onOpen, onAccept, onDecline, busy }) {
  const biz = useOpenBusiness();
  const clock = order.status === "placed" ? declineClock(order.autoDeclineAt, now) : null;
  const waited = span(now - new Date(order.placedAt).getTime());
  return (
    <li className={`os-card is-${order.status}`}>
      <button type="button" className="os-card-open" onClick={() => onOpen(order)} aria-label={`Open order ${order.orderNo} for ${order.name}`}>
        <span className="os-card-top">
          <strong>{order.orderNo}</strong>
          <Badge tone={STATUS_TONES[order.status]} label={STATUS_WORDS[order.status]} />
        </span>
        <span className="os-card-name">{order.name}</span>
        <span className="os-card-meta">
          <span><Icon name={order.service === "pickup" ? "store" : "truck"} size={14} /> {order.service === "pickup" ? "Pickup" : `Delivery${order.pinCode ? ` · ${order.pinCode}` : ""}`}</span>
          {order.slot && <span><Icon name="calendar" size={14} /> {order.slot.date.slice(5)} {order.slot.from}</span>}
          <span><Icon name="clock" size={14} /> {waited} ago</span>
        </span>
        <span className="os-card-figures">
          <span>{order.lines} {order.lines === 1 ? "item" : "items"}{order.status === "accepted" && order.packingAt ? ` · ${order.decided} packed` : ""}</span>
          <strong>{biz.exact(order.finalTotal ?? order.total)}</strong>
        </span>
        {clock && <span className={`os-clock is-${clock.tone}`}><Icon name="timer" size={14} /> {clock.words}</span>}
        {order.changeStatus === "waiting" && <span className="os-clock is-warning"><Icon name="alert-circle" size={14} /> Waiting for the customer's OK</span>}
        {order.riderName && order.status === "out_for_delivery" && <span className="os-card-note">With {order.riderName}</span>}
        {order.openComplaints > 0 && <span className="os-clock is-danger"><Icon name="alert" size={14} /> {order.openComplaints} open {order.openComplaints === 1 ? "complaint" : "complaints"}</span>}
        {order.declined && <span className="os-card-note">{order.declined.auto ? "Not accepted in time" : order.declined.reason}</span>}
        {order.cancelled && <span className="os-card-note">{order.cancelled.by === "guest" ? "Cancelled by the customer" : order.cancelled.reason}</span>}
        <span className="os-card-pay">{PAYMENT_WORDS[order.paymentMode]}</span>
      </button>
      {order.status === "placed" && biz.can("online_shop.approve") && (
        <span className="os-card-actions">
          <button type="button" className="button button-sm" disabled={busy} onClick={() => onAccept(order)}><Icon name="check" size={14} /> Accept</button>
          <button type="button" className="button button-secondary button-sm" disabled={busy} onClick={() => onDecline(order)}>Decline</button>
        </span>
      )}
    </li>
  );
}

function Board({ lane, board, error, now, reload }) {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [declining, setDeclining] = useState(null);
  const [busy, setBusy] = useState(false);
  const open = (order) => navigate(businessPath(biz.id, `online-orders/${order.id}`));
  const accept = async (order) => {
    setBusy(true);
    try {
      await orderAction(biz.id, order.id, "accept", { revision: order.revision });
      toast.success(`${order.orderNo} accepted. The customer sees it now.`);
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
      reload();
    } finally {
      setBusy(false);
    }
  };
  if (error) return <ErrorMessage message={error} />;
  if (!board) return <Loading label="Reading the orders…" />;
  const orders = board.orders;
  if (!orders.length) {
    const words = { new: "No new orders. A new one chimes and shows here.", packing: "Nothing being packed.", out: "Nothing waiting at the counter or on its way.",
      done: "Nothing finished in the last day." };
    return <EmptyState icon="receipt" message={words[lane]} hint={lane === "new" ? "Share your shop link from Settings › Online shop." : undefined} />;
  }
  return (
    <>
      <ul className="os-board" aria-label={`${LANES.find((one) => one.value === lane)?.label} orders`}>
        {orders.map((order) => <OrderCard key={order.id} order={order} now={now} busy={busy} onOpen={open} onAccept={accept} onDecline={setDeclining} />)}
      </ul>
      {declining && <DeclineDialog order={declining} onClose={() => setDeclining(null)} onDone={() => { setDeclining(null); toast.success("Declined. The customer sees your reason."); reload(); }} />}
    </>
  );
}

// --- Complaints ---------------------------------------------------------------------------------

function ComplaintDialog({ complaint, mode, onClose, onDone }) {
  const biz = useOpenBusiness();
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState("taken_back");
  const resolving = mode === "resolve";
  return (
    <FormDialog title={`${resolving ? "Resolve" : "Acknowledge"} ticket ${complaint.ticketNo}`} icon={resolving ? "check-circle" : "message"} width={560}
      description={resolving ? "Say what was done. A damaged, wrong, expired or late item is taken back on its bill (Sales history) first." : "Tell the customer who has it and what happens next. They see it on their order's page."}
      submitLabel={resolving ? "Resolve" : "Acknowledge"} onClose={onClose} onSaved={onDone}
      onSubmit={() => complaintAction(biz.id, complaint.id, mode, resolving ? { outcome, resolution: note.trim() } : { note: note.trim() })}>
      {resolving && (
        <Field label="What was done" wide>
          <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>{COMPLAINT_OUTCOMES.map((one) => <option key={one.value} value={one.value}>{one.label}</option>)}</select>
        </Field>
      )}
      <Field label="What you tell the customer" wide><textarea required rows={3} maxLength={resolving ? 1000 : 500} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
    </FormDialog>
  );
}

function Complaints({ now }) {
  const biz = useOpenBusiness();
  const [view, setView] = useState("open");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(null);
  const [bill, setBill] = useState(null);
  const load = useCallback(() => readComplaints(biz.id, { status: view === "all" ? undefined : view })
    .then((answer) => { setData(answer); setError(""); }).catch((err) => setError(getErrorMessage(err))), [biz.id, view]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh({ business: biz.id }, ["online_complaint"], load);
  const canReview = biz.can("online_shop.review");
  return (
    <>
      <Segmented label="Show" value={view} options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }, { value: "all", label: "All" }]} onChange={setView} />
      <ErrorMessage message={error} />
      {!data && !error && <Loading label="Reading the complaints…" />}
      {data && !data.complaints.length && <EmptyState icon="smile" message={view === "open" ? "No open complaints." : "No complaints here."}
        hint="A customer reports a problem from their order's page; it gets a ticket number and shows here." />}
      {data && data.complaints.length > 0 && (
        <ul className="os-complaints">
          {data.complaints.map((row) => {
            const clock = complaintClock(row, now);
            return (
              <li key={row.id} className={`os-complaint is-${row.status}`}>
                <header>
                  <strong>Ticket {row.ticketNo}</strong>
                  <Badge tone={clock.tone === "neutral" ? "info" : clock.tone} label={clock.words} />
                </header>
                <p className="os-complaint-who">
                  <Link to={businessPath(biz.id, `online-orders/${row.orderId}`)}>Order {row.orderNo}</Link> · {row.name}{row.mobile ? ` · ${row.mobile}` : ""}
                </p>
                <p><strong>{row.kindWords}:</strong> {row.details}</p>
                {row.acknowledgement && <p className="os-complaint-reply"><Icon name="message" size={14} /> {row.acknowledgement}{row.acknowledgedBy ? ` (${row.acknowledgedBy})` : ""}</p>}
                {row.resolution && <p className="os-complaint-reply"><Icon name="check-circle" size={14} /> {row.outcomeWords}: {row.resolution}{row.resolvedBy ? ` (${row.resolvedBy})` : ""}</p>}
                <span className="row-actions">
                  {canReview && row.status === "open" && <button type="button" className="button button-sm" onClick={() => setActing({ complaint: row, mode: "acknowledge" })}>Acknowledge</button>}
                  {canReview && row.status !== "resolved" && <button type="button" className={`button button-sm ${row.status === "open" ? "button-secondary" : ""}`} onClick={() => setActing({ complaint: row, mode: "resolve" })}>Resolve</button>}
                  {row.documentId && biz.can("sales.view") && <button type="button" className="chip-button" onClick={() => setBill(row.documentId)}>The bill</button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {acting && <ComplaintDialog complaint={acting.complaint} mode={acting.mode} onClose={() => setActing(null)}
        onDone={() => { setActing(null); toast.success("Saved. The customer sees it on their order's page."); load(); }} />}
      {bill && <DocumentDetail documentId={bill} onClose={() => setBill(null)} onChanged={load} />}
    </>
  );
}

// --- Report -------------------------------------------------------------------------------------

function Report() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    onlineReport(biz.id, range, controller.signal).then((answer) => { setData(answer); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range]);
  const columns = useMemo(() => [
    { key: "day", header: "Day", type: "date", value: (row) => row.day, mobile: "title", pin: true },
    { key: "placed", header: "Placed", type: "number", value: (row) => row.placed, total: "sum", mobile: "show" },
    { key: "completed", header: "Completed", type: "number", value: (row) => row.completed, total: "sum", mobile: "show" },
    { key: "value", header: "Value", type: "money", exact: true, value: (row) => row.value, total: "sum", mobile: "show" },
    { key: "declined", header: "Declined", type: "number", value: (row) => row.declined, total: "sum" },
    { key: "declined_auto", header: "Not answered", type: "number", value: (row) => row.declined_auto, total: "sum" },
    { key: "cancelled_guest", header: "Cancelled by customer", type: "number", value: (row) => row.cancelled_guest, total: "sum" },
    { key: "cancelled_shop", header: "Cancelled by shop", type: "number", value: (row) => row.cancelled_shop, total: "sum" },
    { key: "accept", header: "Minutes to accept", type: "number", value: (row) => row.acceptMinutes },
    { key: "pack", header: "Minutes to pack", type: "number", value: (row) => row.packMinutes },
  ], []);
  return (
    <>
      <div className="os-range"><DateRangeFilter from={range.from} to={range.to} anchor={today} label="report dates" onChange={setRange} /></div>
      <ErrorMessage message={error} />
      {!data && !error && <Loading label="Adding up the orders…" />}
      {data && (
        <>
          <div className="stat-grid os-tiles">
            <StatTile icon="receipt" label="Orders placed" value={count(data.totals.placed)} note={`${count(data.totals.completed)} completed`} />
            <StatTile icon="money" tone="success" label="Value completed" money={data.totals.value} currency={biz.symbol} />
            <StatTile icon="timer" tone="info" label="Minutes to accept" value={data.totals.acceptMinutes ?? "—"} note="on average, from placing" />
            <StatTile icon="box" tone="info" label="Minutes to pack" value={data.totals.packMinutes ?? "—"} note="on average, from accepting" />
            <StatTile icon="x-circle" tone={data.totals.declined + data.totals.declined_auto ? "warning" : "neutral"} label="Declined"
              value={count(data.totals.declined + data.totals.declined_auto)} note={`${count(data.totals.declined_auto)} not answered in time`} />
            <StatTile icon="ban" label="Cancelled" value={count(data.totals.cancelled_guest + data.totals.cancelled_shop)} note={`${count(data.totals.cancelled_guest)} by customers`} />
          </div>
          <SectionCard flush icon="calendar" title="By day">
            <DataGrid id="online-orders-report" caption="Online orders by day" columns={columns} rows={data.days} rowKey={(row) => row.day} currency={biz.symbol}
              rowNoun={["day", "days"]} search={false} exportName={biz.can("online_shop.export") ? `${biz.business.code}-online-orders` : undefined} empty="No online orders on these days" />
          </SectionCard>
          {data.reasons.length > 0 && (
            <SectionCard icon="list" title="Declines and cancellations, by reason">
              <ul className="os-reasons-list">
                {data.reasons.map((row) => (
                  <li key={`${row.kind}-${row.by}-${row.reason}`}><span>{row.kind === "declined" ? "Declined" : row.by === "guest" ? "Cancelled by the customer" : "Cancelled by the shop"}: {row.reason}</span><strong>{count(row.count)}</strong></li>
                ))}
              </ul>
            </SectionCard>
          )}
        </>
      )}
    </>
  );
}

export default function OnlineOrdersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "new";
  const lane = LANES.some((one) => one.value === tab) ? tab : null;
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [sound, setSound] = useState(soundOn);
  const lastNew = useRef(null);
  const [offset, setOffset] = useState(0);
  const now = useClock(offset);

  const load = useCallback(() => onlineBoard(biz.id, { lane: lane || "new" }).then((answer) => {
    setBoard(answer);
    setError("");
    if (answer.serverTime) setOffset(new Date(answer.serverTime).getTime() - Date.now());
    // A new order chimes (not the first read, and only while the sound is on).
    if (lastNew.current !== null && answer.counts.new > lastNew.current && soundOn()) playChime();
    lastNew.current = answer.counts.new;
  }).catch((err) => setError(getErrorMessage(err))), [biz.id, lane]);
  useEffect(() => { load(); }, [load]);
  const live = useLiveRefresh({ business: biz.id }, ["online_order"], load);

  // A browser plays sound only after someone has touched the page.
  useEffect(() => {
    const unlock = () => unlockChime();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    try { window.localStorage.setItem(SOUND, next ? "on" : "off"); } catch { /* kept for this visit */ }
    if (next) { unlockChime(); playChime(); }
  };
  const counts = board?.counts || { new: 0, packing: 0, out: 0, done: 0 };
  const options = [...LANES.map((one) => ({ value: one.value, label: counts[one.value] ? `${one.label} (${counts[one.value]})` : one.label })),
    { value: "complaints", label: "Complaints" }, { value: "report", label: "Report" }];
  return (
    <div className="stack os-page">
      <BusinessHeader icon="truck" title="Online orders"
        description="Orders from your shop link: accept, pack, bill and hand over. The customer sees each step on their order's page as it happens."
        actions={<span className="os-head-actions">
          <LiveIndicator status={live} />
          <button type="button" className={`chip-button ${sound ? "is-active" : ""}`} aria-pressed={sound} onClick={toggleSound}>
            <Icon name="bell" size={14} /> {sound ? "Chime on" : "Chime off"}
          </button>
          {biz.can("online_shop.view") && <Link className="button button-secondary button-sm" to={businessPath(biz.id, "online-shop")}><Icon name="link" size={14} /> Shop link & settings</Link>}
        </span>} />
      <div className="stat-grid os-tiles">
        <StatTile icon="bell" tone={counts.new ? "warning" : "neutral"} label="New" value={count(counts.new)} note="waiting to be accepted" onClick={() => setParams({ tab: "new" })} />
        <StatTile icon="box" tone="info" label="Packing" value={count(counts.packing)} note="accepted" onClick={() => setParams({ tab: "packing" })} />
        <StatTile icon="truck" tone="primary" label="Ready & out" value={count(counts.out)} note="billed, to hand over" onClick={() => setParams({ tab: "out" })} />
        <StatTile icon="check-circle" tone="success" label="Done" value={count(counts.done)} note="in the last day" onClick={() => setParams({ tab: "done" })} />
      </div>
      <ContentTabs label="Online orders" value={tab} options={options} onChange={(value) => setParams({ tab: value })}>
        {lane && <Board lane={lane} board={board?.lane === lane ? board : null} error={error} now={now} reload={load} />}
        {tab === "complaints" && <Complaints now={now} />}
        {tab === "report" && <Report />}
      </ContentTabs>
    </div>
  );
}
