import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import GuestShell from "../../../shared/GuestShell";
import StatusSteps from "../../../shared/StatusSteps";
import { GuestError, GuestSkeleton } from "../../../shared/GuestStates";
import { guestErrorMessage, newClientKey } from "../../../shared/publicClient";
import { telHref } from "../../../shared/guestWords";
import { useGuestLive } from "../../../services/guestLive";
import { answerChange, cancelOrder, changeOrder, getOrder, reportProblem } from "../services/shop.service";
import { quantityWords, readCart, rememberOrder, setQuantity, writeCart } from "../services/shopCart";
import { PolicyLink, Sheet } from "./ShopParts";
import { dayWords, inWords, sellerExtras, timeWords, todayInIndia, useNow } from "../services/shopWords";

// One order's own page: /shop/status/<guest token>. Where it has got to, live
// (the shop's answer reaches it within a second or two; when the live stream
// cannot open it reads every few seconds), what happens next in plain words,
// the clock while it waits for the shop, a change the shop asks the guest to
// agree to, the final amount once it is packed (each line short, not
// available, weighed or replaced), and what the guest may still do: cancel
// until packing starts, change the order until the shop accepts it, call the
// shop, and report a problem (a ticket the shop answers).

const KINDS = [
  ["missing", "Something was missing"], ["wrong", "Wrong item"], ["damaged", "Damaged or leaking"], ["expired", "Past its expiry"],
  ["quality", "Poor quality"], ["late", "Came late"], ["billing", "Charged wrongly"], ["other", "Something else"],
];
const OUTCOMES = { taken_back: "Taken back", refunded: "Refunded", replaced: "Replaced", explained: "Explained", other: "Done" };
const STATUS_WORDS = { open: "Sent to the shop", acknowledged: "The shop is on it", resolved: "Resolved" };

function LineState({ line, all }) {
  if (line.state === "replaced") {
    const by = all.find((other) => other.replacesLineId === line.id);
    return <span className="sp-state is-replaced">Replaced{by ? ` by ${by.name}` : ""}</span>;
  }
  if (line.state === "unavailable") return <span className="sp-state is-off">Not available · not charged</span>;
  if (line.state === "short") return <span className="sp-state is-short">{line.packedQuantity} of {line.quantity} packed</span>;
  if (line.state === "ok" && line.weighed && line.packedQuantity !== null) return <span className="sp-state">Weighed: {quantityWords(line.packedQuantity, line.unit, true).replace(/^About /, "")}</span>;
  if (line.state === "ok") return <span className="sp-state is-ok">Packed</span>;
  return null;
}

function Complaints({ order, onReport }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("missing");
  const [details, setDetails] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState("");
  const [key] = useState(() => newClientKey());
  const send = async (event) => {
    event.preventDefault();
    if (details.trim().length < 5) { setProblem("Tell the shop what happened, in a few words."); return; }
    setSending(true);
    setProblem("");
    try {
      await onReport({ clientKey: key, kind, details: details.trim() });
      setOpen(false);
      setDetails("");
    } catch (err) {
      setProblem(guestErrorMessage(err, "the shop"));
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="sp-box sp-complaints" aria-labelledby="sp-complaints-title">
      <h2 id="sp-complaints-title">Something wrong with this order?</h2>
      {order.complaints.map((row) => (
        <article key={row.id} className={`sp-ticket is-${row.status}`}>
          <header><strong>Ticket {row.ticketNo}</strong><span>{STATUS_WORDS[row.status]}</span></header>
          <p>{row.details}</p>
          {row.acknowledgement && <p className="sp-ticket-reply"><Icon name="message" size={14} /> {row.acknowledgement}</p>}
          {row.resolution && <p className="sp-ticket-reply"><Icon name="check-circle" size={14} /> {OUTCOMES[row.outcome] || "Resolved"}: {row.resolution}</p>}
          {row.status !== "resolved" && <small>The shop answers within 48 hours, and resolves it within a month.</small>}
        </article>
      ))}
      {order.canComplain && (
        <button type="button" className="g-secondary" onClick={() => setOpen(true)}><Icon name="alert" size={16} /> Report a problem</button>
      )}
      {open && (
        <Sheet title="Report a problem" onClose={() => setOpen(false)}>
          <form className="sp-report" onSubmit={send}>
            <label className="sp-select is-block"><span>What went wrong</span>
              <select value={kind} onChange={(event) => setKind(event.target.value)}>{KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            </label>
            <label className="sp-note-field"><span>Tell the shop what happened</span>
              <textarea rows={4} maxLength={1000} value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Which item, and what was wrong with it" />
            </label>
            {problem && <p className="gs-field-problem" role="alert">{problem}</p>}
            <p className="sp-note-small">You get a ticket number. A damaged, wrong, expired or late item is taken back, and its money refunded or the item replaced.</p>
            <button type="submit" className="g-primary g-block-button" disabled={sending}>{sending ? "Sending…" : "Send to the shop"}</button>
          </form>
        </Sheet>
      )}
    </section>
  );
}

export default function ShopStatus() {
  const { guestToken } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState("");
  const [actError, setActError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const now = useNow(15000);

  const load = useCallback(() => getOrder(guestToken).then((next) => { setAnswer(next); setError(null); return next; }).catch((err) => { setError(err); }), [guestToken]);
  useEffect(() => { load(); }, [load]);
  const order = answer?.order;
  const live = useGuestLive(order && answer.live ? answer.live : null, load, { fallbackMs: order?.status === "placed" ? 8000 : 20000 });

  // A shop that has not answered by its time: read again then, so both sides say the same.
  useEffect(() => {
    if (!order?.autoDeclineAt) return undefined;
    const wait = new Date(order.autoDeclineAt).getTime() - Date.now() + 2000;
    if (wait > 2147483647) return undefined;
    const timer = setTimeout(load, Math.max(1000, wait));
    return () => clearTimeout(timer);
  }, [order?.autoDeclineAt, load]);

  useEffect(() => {
    if (order) {
      document.title = `Order ${order.orderNo} · ${answer.card?.name || "Shop"}`;
      rememberOrder({ guestToken: order.guestToken, orderNo: order.orderNo, shopName: answer.card?.name || "Shop", total: order.totals.final ?? order.totals.total,
        placedAt: order.placedAt, service: order.service, status: order.status });
    }
  }, [order, answer]);

  const act = async (name, work) => {
    setActing(name);
    setActError("");
    try {
      const next = await work();
      setAnswer(next);
      return next;
    } catch (err) {
      setActError(guestErrorMessage(err, "the shop"));
      return null;
    } finally {
      setActing("");
    }
  };

  if (error && !answer) {
    const missing = error.response?.status === 404;
    return <GuestShell card={null}><GuestError heading="h1" title={missing ? "We could not find this order" : "Your order did not open"} message={guestErrorMessage(error, "the shop")} onRetry={missing ? null : load} /></GuestShell>;
  }
  if (!answer) return <GuestShell card={null}><GuestSkeleton band cards={2} label="Opening your order" /></GuestShell>;

  const phone = answer.card?.location?.phone;
  const call = telHref(phone);
  const change = order.change;
  const changeOrderNow = async () => {
    const next = await act("change", () => changeOrder(guestToken));
    if (next?.cart) {
      const token = next.cart.linkPath.replace(/^\/shop\//, "");
      let cart = readCart(token);
      // Back in the cart at no price yet: the cart reads today's prices from the shop as it opens.
      for (const line of next.cart.lines) {
        cart = setQuantity(cart, { skuId: line.skuId, name: line.name, price: null, step: 1, max: 999, unit: "each" }, line.quantity);
      }
      writeCart(token, cart);
      navigate(`${next.cart.linkPath}/cart`);
    }
  };
  const slot = order.slot ? `${dayWords(order.slot.date, todayInIndia())}, ${timeWords(order.slot.from)} – ${timeWords(order.slot.to)}` : null;
  const shownTotal = order.totals.final ?? order.totals.total;
  return (
    <GuestShell card={answer.card} seller={sellerExtras(answer.shop?.seller)} context={`Order ${order.orderNo}`}>
      {state?.placed && <p className="sp-banner is-good" role="status"><Icon name="check-circle" size={18} /> Your order is placed. Keep this page: it shows every step.</p>}
      <section className={`sp-status is-${order.stage.key}`} aria-labelledby="sp-status-title">
        <span className="sp-status-no">Order {order.orderNo} · {order.service === "pickup" ? "Pickup" : "Delivery"}</span>
        <h1 id="sp-status-title">{order.stage.label}</h1>
        {order.stage.detail && <p>{order.stage.detail}</p>}
        {order.status === "placed" && order.autoDeclineAt && (
          <p className="sp-clock"><Icon name="timer" size={16} /> The shop has until {order.autoDecline} to accept ({inWords(order.autoDeclineAt, now)}).</p>
        )}
        <StatusSteps steps={order.steps} current={order.current} stopped={order.stage.stopped} live={live} />
      </section>

      {change && (
        <section className="sp-ask" aria-labelledby="sp-ask-title" role="alert">
          <h2 id="sp-ask-title"><Icon name="alert-circle" size={18} /> The shop asks: is this OK?</h2>
          {change.note && <p>{change.note}</p>}
          <ul>
            {change.lines.map((row) => (
              <li key={`${row.name}-${row.now}`}>
                <span>{row.kind === "added" ? `Added: ${row.now}` : row.was ? `${row.was} → ${row.now}` : row.now}</span>
                <strong>{money(row.amountAfter)}</strong>
              </li>
            ))}
          </ul>
          <p className="sp-ask-total">Your order would come to <strong>{money(change.totalAfter)}</strong> instead of {money(change.totalBefore)}.</p>
          <div className="sp-ask-actions">
            <button type="button" className="g-primary" disabled={Boolean(acting)} onClick={() => act("accept", () => answerChange(guestToken, change.id, true))}>
              <Icon name="check" size={16} /> Yes, that's fine
            </button>
            <button type="button" className="g-secondary" disabled={Boolean(acting)} onClick={() => act("reject", () => answerChange(guestToken, change.id, false))}>
              No, leave it out
            </button>
          </div>
        </section>
      )}
      {actError && <p className="sp-banner is-warning" role="alert"><Icon name="alert-circle" size={18} /> {actError}</p>}

      <section className="sp-box" aria-labelledby="sp-items-title">
        <h2 id="sp-items-title">{order.totals.final !== null ? "Packed for you" : "Your order"}</h2>
        <ul className="sp-order-lines">
          {order.lines.filter((line) => !line.replacesLineId).map((line) => (
            <li key={line.id} className={line.state === "unavailable" || line.state === "replaced" ? "is-out" : ""}>
              <span className="sp-order-line">
                <strong>{line.name}{line.added ? " (added)" : ""}</strong>
                <small>{quantityWords(line.quantity, line.unit, line.weighed)}{line.weighed ? "" : ` × ${money(line.price)}`}</small>
                <LineState line={line} all={order.lines} />
              </span>
              <span className="sp-order-amount">
                {line.state !== "pending" && line.packedAmount !== line.amount && <s>{money(line.amount)}</s>}
                <strong>{money(line.state === "pending" ? line.amount : line.packedAmount)}</strong>
              </span>
            </li>
          ))}
          {order.lines.filter((line) => line.replacesLineId).map((line) => (
            <li key={line.id} className="is-replacement">
              <span className="sp-order-line"><strong>{line.name}</strong><small>In place of another item · {quantityWords(line.packedQuantity ?? line.quantity, line.unit, line.weighed).replace(/^About /, "")}</small></span>
              <span className="sp-order-amount"><strong>{money(line.packedAmount)}</strong></span>
            </li>
          ))}
        </ul>
        <dl className="sp-bill">
          {order.totals.delivery > 0 && <div><dt>Delivery charge</dt><dd>{money(order.totals.delivery)}</dd></div>}
          <div className="is-total"><dt>{order.totals.final !== null ? "Final amount" : "Total"}</dt><dd>{money(shownTotal)}</dd></div>
          {order.totals.final !== null && order.totals.final !== order.totals.total && <p className="sp-bill-note">You placed it at {money(order.totals.total)}; the bill follows what was packed.</p>}
          {order.totals.final === null && order.totals.allowance > 0 && <p className="sp-bill-note">Weighed items are billed by what is packed: at most {money(order.totals.total + order.totals.allowance)} without asking you.</p>}
        </dl>
      </section>

      <section className="sp-box sp-facts" aria-label="Details">
        <p><Icon name={order.service === "pickup" ? "store" : "truck"} size={16} /> {order.service === "pickup" ? "Pickup at the shop" : `Delivery to ${[order.address?.address, order.address?.landmark, order.address?.pinCode].filter(Boolean).join(", ")}`}</p>
        {slot && <p><Icon name="calendar" size={16} /> {slot}</p>}
        <p><Icon name="money" size={16} /> {order.paymentWords}</p>
        <p><Icon name="refresh" size={16} /> If an item ran out: {order.substitutionWords}</p>
        {order.note && <p><Icon name="message" size={16} /> {order.note}</p>}
        <p><Icon name="clock" size={16} /> Placed {order.placed}</p>
      </section>

      <div className="sp-actions">
        {call && <a className="g-primary" href={call}><Icon name="phone" size={16} /> Call the shop</a>}
        {order.canChange && <button type="button" className="g-secondary" disabled={Boolean(acting)} onClick={changeOrderNow}><Icon name="edit" size={16} /> Change this order</button>}
        {order.canCancel && <button type="button" className="g-secondary sp-danger" disabled={Boolean(acting)} onClick={() => setConfirmCancel(true)}><Icon name="x-circle" size={16} /> Cancel order</button>}
        {answer.shop?.linkPath && <Link className="g-secondary" to={answer.shop.linkPath}><Icon name="store" size={16} /> Back to the shop</Link>}
      </div>
      {confirmCancel && (
        <Sheet title="Cancel this order?" onClose={() => setConfirmCancel(false)}
          footer={<>
            <button type="button" className="g-secondary" onClick={() => setConfirmCancel(false)}>Keep it</button>
            <button type="button" className="g-primary sp-danger-fill" disabled={Boolean(acting)} onClick={async () => { await act("cancel", () => cancelOrder(guestToken)); setConfirmCancel(false); }}>
              Yes, cancel it
            </button>
          </>}>
          <p>Cancelling costs you nothing. Once the shop starts packing, call them instead.</p>
        </Sheet>
      )}
      <Complaints order={order} onReport={(body) => reportProblem(guestToken, body).then(setAnswer)} />
      <PolicyLink policy={answer.shop?.policy} name={answer.card?.name} />
    </GuestShell>
  );
}
