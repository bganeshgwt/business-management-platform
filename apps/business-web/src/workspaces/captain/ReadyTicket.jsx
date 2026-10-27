import Icon from "@bmp/ui/Icon";
import { itemNames, qty, ticketClock, timeOfDay } from "../../services/kot";

// One ticket at the pass, as the waiter who carries it out reads it: the
// table, the dishes in the menu's own names (the guest's words, not the
// cooks'), how long the food has waited (amber at half the kitchen's pass
// time, red after it) and Served, for someone who may move a ticket.
export default function ReadyTicket({ ticket, now, passMinutes, canServe, busy, error, onServe }) {
  const waited = ticketClock(ticket, now, { passMinutes });

  return (
    <article className={`cpt-ready is-${waited.tone}`} aria-label={`Food ready for table ${ticket.tableNo}, ${ticket.kotNo}`}>
      <header className="cpt-ready-head">
        <span className="cpt-ready-table">{ticket.tableNo}</span>
        <span className="cpt-ready-title">
          <strong>Table {ticket.tableNo}</strong>
          <span className="muted small">
            {ticket.kotNo} · {ticket.stationName}
            {ticket.guestCount ? ` · ${ticket.guestCount} guests` : ""}
          </span>
        </span>
        <span className={`cpt-ready-clock is-${waited.tone}`} title={ticket.readyAt ? `At the pass since ${timeOfDay(ticket.readyAt)}` : undefined}>
          <Icon name="timer" size={14} />
          {waited.text}
        </span>
      </header>
      <ul className="cpt-ready-dishes">
        {(ticket.items || [])
          .filter((item) => item.liveQuantity > 0)
          .map((item) => {
            const names = itemNames(item, "menu");

            return (
              <li key={item.id}>
                <span className="cpt-ready-qty">{qty(item.liveQuantity)} ×</span>
                <span>
                  {names.main}
                  {names.variant ? <span className="muted"> ({names.variant})</span> : null}
                  {names.modifiers.length > 0 && <span className="muted small"> + {names.modifiers.join(", ")}</span>}
                  {item.notes && <span className="cpt-ready-note">“{item.notes}”</span>}
                </span>
              </li>
            );
          })}
      </ul>
      {error && (
        <p className="cpt-card-error" role="alert">
          {error}
        </p>
      )}
      {canServe && (
        <button type="button" className="button cpt-serve" onClick={() => onServe(ticket)} disabled={busy}>
          <Icon name="check" size={17} />
          {busy ? "Saving…" : "Served"}
        </button>
      )}
    </article>
  );
}
