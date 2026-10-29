import Icon from "@bmp/ui/Icon";
import { itemNames, qty, ticketClock, timeOfDay } from "../../services/kot";
import { passSince, waitingDishes } from "./captainFloor.js";

// One ticket at the pass, as the waiter who carries it out reads it: the
// table, the dishes waiting in the menu's own names (the guest's words, not
// the cooks'), how long the food has waited (amber at half the kitchen's pass
// time, red after it) and Served, for someone who may move a ticket. A ticket
// the kitchen marked ready is served at once; on a ticket still cooking, each
// dish the kitchen ticked done is served on its own, and the rest is said to
// be cooking. Dishes already served from the floor are not listed.
export default function ReadyTicket({ ticket, now, passMinutes, canServe, busy, error, onServe, onServeDish }) {
  const whole = ticket.status === "ready";
  const since = passSince(ticket);
  const waited = ticketClock({ ...ticket, status: "ready", readyAt: since }, now, { passMinutes });
  const dishes = waitingDishes(ticket);
  const cooking = whole ? [] : (ticket.items || []).filter((item) => item.liveQuantity > 0 && !item.isDone && !item.servedAt);
  const busyOn = (item) => Boolean(busy && busy[`${ticket.id}.${item.id}`]);

  return (
    <article className={`cpt-ready is-${waited.tone}`} aria-label={`Food ready for table ${ticket.tableNo}, ${ticket.kotNo}`}>
      <header className="cpt-ready-head">
        <span className="cpt-ready-table">{ticket.tableNo}</span>
        <span className="cpt-ready-title">
          <strong>Table {ticket.tableNo}</strong>
          <span className="muted small">
            {ticket.kotNo} · {ticket.stationName}
            {ticket.courseName ? ` · ${ticket.courseName}` : ""}
            {ticket.guestCount ? ` · ${ticket.guestCount} guests` : ""}
          </span>
        </span>
        <span className={`cpt-ready-clock is-${waited.tone}`} title={since ? `At the pass since ${timeOfDay(since)}` : undefined}>
          <Icon name="timer" size={14} />
          {waited.text}
        </span>
      </header>
      <ul className="cpt-ready-dishes">
        {dishes.map((item) => {
          const names = itemNames(item, "menu");

          return (
            <li key={item.id} className={whole ? "" : "cpt-ready-dish"}>
              <span className="cpt-ready-qty">{qty(item.liveQuantity)} ×</span>
              <span>
                {names.main}
                {names.variant ? <span className="muted"> ({names.variant})</span> : null}
                {names.modifiers.length > 0 && <span className="muted small"> + {names.modifiers.join(", ")}</span>}
                {item.notes && <span className="cpt-ready-note">“{item.notes}”</span>}
              </span>
              {!whole && canServe && (
                <button
                  type="button"
                  className="button button-sm cpt-serve-dish"
                  onClick={() => onServeDish(ticket, item)}
                  disabled={busyOn(item)}
                  aria-label={`Served: ${names.main}, table ${ticket.tableNo}`}
                >
                  <Icon name="check" size={15} />
                  {busyOn(item) ? "Saving…" : "Served"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {cooking.length > 0 && (
        <p className="muted small cpt-ready-cooking">
          Still cooking: {cooking.map((item) => `${qty(item.liveQuantity)} × ${itemNames(item, "menu").main}`).join(", ")}
        </p>
      )}
      {error && (
        <p className="cpt-card-error" role="alert">
          {error}
        </p>
      )}
      {whole && canServe && (
        <button type="button" className="button cpt-serve" onClick={() => onServe(ticket)} disabled={Boolean(busy && busy[ticket.id])}>
          <Icon name="check" size={17} />
          {busy && busy[ticket.id] ? "Saving…" : "Served"}
        </button>
      )}
    </article>
  );
}
