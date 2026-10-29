import Icon from "@bmp/ui/Icon";
import { moneyExact } from "@bmp/shared/format";
import { elapsed } from "@bmp/shared/dates";
import Modal from "../../components/Modal";
import StatusBadge from "../../components/StatusBadge";
import { ErrorMessage } from "../../components/Feedback";
import { describeTable } from "../../services/floorTables";
import { CallCard, OrderCard } from "../../modules/restaurant/orders/pages/TableRequestsPage";
import ReadyTicket from "./ReadyTicket";
import { orderLink } from "./captainFloor.js";

// Where the table's order is in the kitchen, in a waiter's words.
const KITCHEN_WORDS = {
  pending: "The order is with the kitchen.",
  preparing: "The kitchen is cooking it.",
  ready: "Its food is ready at the pass.",
  served: "Everything sent to the kitchen is served.",
};

const STATE_TONES = {
  free: "success",
  running: "primary",
  printed: "warning",
  paid: "success",
  joined: "neutral",
  held: "info",
  cleaning: "neutral",
  off: "neutral",
};

// Nothing waiting: a table the floor has not read yet.
const NOTHING = { calls: [], orders: [], ready: [], kitchen: null };

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// One table, opened from the captain app's tables: who is sitting there and
// for how long, what is waiting (a guest's call, a QR order, food at the pass,
// each answered right here) and what this person's role may do with the
// table: the dashboard floor's own actions (useFloorActions: Start order,
// Open order, Bill, Take payment or Open bill, Reprint, Mark ready, Seat a
// booking or a walk-in), with orders opened on the captain app's order screen.
export default function TableSheet({ table, waiting = NOTHING, floor, actions, requests, serving, billAsk = null, now, canBill, onClose }) {
  const info = describeTable(table, null);
  const live = table.live;
  // The table's bill request still open: a guest's from the QR code, or a waiter's.
  const billCall = waiting.calls.find((call) => call.type === "bill") || null;
  const list = actions.actionsFor(table);
  const working = Boolean(actions.busy && actions.busy.endsWith(`-${table.id}`));
  const canTakeOrders = Boolean(floor.can.accept);
  const facts = live
    ? [
        live.orderNumber,
        live.guestCount ? plural(Number(live.guestCount), "guest", "guests") : null,
        live.placedAt ? `seated ${elapsed(live.placedAt, now)}` : null,
        floor.can.money
          ? table.floorState === "printed" && live.billDue !== null
            ? `${moneyExact(live.billDue, floor.currency)} to pay`
            : moneyExact(live.orderTotal, floor.currency)
          : null,
      ].filter(Boolean)
    : [];
  const where = [
    [table.floorName, table.areaName].filter(Boolean).join(" · "),
    plural(Number(table.capacity), "seat", "seats"),
    table.captain ? (String(table.captain.userId) === String(floor.user.id) ? "Your table" : `${table.captain.userName}'s table`) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Modal title={`Table ${table.tableNo}`} icon="table" description={where} onClose={onClose} width={560} className="cpt-sheet">
      <div className="stack cpt-sheet-body">
        <div className="cpt-sheet-state">
          <StatusBadge tone={STATE_TONES[info.state] || "neutral"} label={info.label} />
          {facts.length > 0 && <span className="cpt-sheet-facts">{facts.join(" · ")}</span>}
        </div>
        {live && !live.joinedTo && waiting.kitchen && KITCHEN_WORDS[waiting.kitchen] && (
          <p className="muted small cpt-sheet-kitchen">
            <Icon name="chef" size={15} /> {KITCHEN_WORDS[waiting.kitchen]}
          </p>
        )}
        {live && live.joinedTo && (
          <p className="muted small cpt-sheet-kitchen">
            <Icon name="link" size={15} /> Pushed against table {live.joinedTo}: one party, one order.
          </p>
        )}

        <ErrorMessage message={actions.message && actions.message.tone === "error" ? actions.message.text : ""} />

        {list.length > 0 && (
          <div className="cpt-sheet-actions">
            {list.map((action) => (
              <button
                key={action.key}
                type="button"
                className={`button ${action.primary ? "" : action.danger ? "button-danger" : "button-secondary"}`}
                onClick={action.onClick}
                disabled={working}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
        {table.floorState === "running" && !canBill && !live.joinedTo && (
          // A captain who does not bill asks the counter for it in one tap:
          // the table's bill request, as a guest's Request bill makes it.
          <div className="cpt-sheet-bill">
            {billCall ? (
              <p className="muted small cpt-sheet-note">
                The counter has the bill request
                {billCall.askedByName ? `, asked by ${String(billCall.askedBy) === String(floor.user.id) ? "you" : billCall.askedByName}` : ", from the guests' QR code"}
                {billCall.repeatCount > 0 ? ` (asked ${billCall.repeatCount + 1} times)` : ""}. It raises the bill.
              </p>
            ) : floor.can.askBill && billAsk ? (
              <>
                <button type="button" className="button button-secondary" onClick={() => billAsk.ask(table)} disabled={billAsk.busy === table.id}>
                  <Icon name="receipt" size={16} />
                  {billAsk.busy === table.id ? "Asking…" : "Ask the counter for the bill"}
                </button>
                <ErrorMessage message={billAsk.error} />
              </>
            ) : (
              <p className="muted small cpt-sheet-note">The counter raises the bill when the guests ask for it.</p>
            )}
          </div>
        )}

        {waiting.ready.length > 0 && (
          <section className="stack cpt-sheet-part" aria-label="Food ready to serve">
            <h2>Food ready</h2>
            {waiting.ready.map((ticket) => (
              <ReadyTicket
                key={ticket.id}
                ticket={ticket}
                now={now}
                passMinutes={floor.pass.passMinutes}
                canServe={floor.can.serve}
                busy={serving.busy}
                error={serving.errors[ticket.id]}
                onServe={serving.serve}
                onServeDish={serving.serveDish}
              />
            ))}
          </section>
        )}

        {waiting.calls.length > 0 && (
          <section className="stack cpt-sheet-part" aria-label="Calls from the table">
            <h2>Calls</h2>
            {waiting.calls.map((request) => (
              <CallCard
                key={request.id}
                request={request}
                now={now}
                busy={requests.busy[request.id]}
                error={requests.errors[request.id]}
                canOpenPos={canTakeOrders}
                onAcknowledge={requests.acknowledge}
                onDone={requests.done}
                myUserId={floor.user.id}
                orderLink={orderLink}
              />
            ))}
          </section>
        )}

        {waiting.orders.length > 0 && (
          <section className="stack cpt-sheet-part" aria-label="Orders from the table's QR code">
            <h2>Orders from the QR code</h2>
            {waiting.orders.map((request) => (
              <OrderCard
                key={request.id}
                request={request}
                now={now}
                busy={requests.busy[request.id]}
                error={requests.errors[request.id]}
                canAct={canTakeOrders}
                canOpenPos={canTakeOrders}
                currency={floor.currency}
                workingOutlet={floor.workingOutlet}
                onAccept={requests.accept}
                onReject={requests.openReject}
                myUserId={floor.user.id}
                orderLink={orderLink}
              />
            ))}
          </section>
        )}
      </div>
    </Modal>
  );
}
