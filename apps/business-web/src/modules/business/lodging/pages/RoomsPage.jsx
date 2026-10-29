import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { OutOfOrderDialog, OutOfServiceDialog, RoomCheckDialog, TicketDialog } from "./HouseDialogs";
import { CLEANING, ROOM_STATUS, atWords, dateWords, dayWords } from "./lodging";
import "../styles/lodging.css";

// Rooms & housekeeping: every room in a column for where it stands tonight —
// vacant dirty (to make up, first: housekeeping's list), vacant clean (ready
// for a guest), occupied (with who is in it and when they leave) and out of
// order (a period booked for it covers tonight, with why). Each room shows its
// cleanliness apart: dirty → being cleaned → clean → inspected, with who
// cleaned and inspected it last; do not disturb on a guest's room; out of
// service (still sold, flagged). Housekeeping takes each step, counts the
// linen and the minibar (what a guest used goes on their folio), books a room
// out of order ahead or opens a maintenance ticket. Below, the out-of-order
// periods tonight and ahead.

const COLUMNS = ["vacant_dirty", "vacant_clean", "occupied", "out_of_order"];
// The steps that may follow each, as buttons.
const STEPS = { dirty: [["cleaning", "Start cleaning"], ["clean", "Mark clean"]], cleaning: [["clean", "Mark clean"]], clean: [["inspected", "Inspected"], ["dirty", "Mark dirty"]],
  inspected: [["dirty", "Mark dirty"]] };

export default function RoomsPage() {
  const biz = useOpenBusiness();
  const [board, setBoard] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/rooms/board", undefined, controller.signal).then((b) => { setBoard(b); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    businessRead(biz.id, "lodging/checklists", undefined, controller.signal).then((c) => setItems(c.items)).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const act = async (room, path, body, message) => {
    setBusy(room.id);
    try {
      await businessWrite(biz.id, path, body);
      reload(message);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const step = (room, to, label) => act(room, `lodging/rooms/${room.id}/status`, { cleaning: to }, `Room ${room.room_no}: ${label.toLowerCase()}.`);
  const back = (period, room) => act(room || { id: period.room_id }, `lodging/out-of-order/${period.id}/back`, {}, `Room ${room?.room_no || period.room_no} is back in order.`);
  const canMark = biz.can("lodging.edit");
  const many = biz.locations.length > 1;
  const hasList = (room, kind) => items.some((i) => Number(i.room_type_id) === Number(room.room_type_id) && i.kind === kind);
  const card = (r) => (
    <li key={r.id} className="ldg-room" aria-label={`Room ${r.room_no}`}>
      <span className="ldg-room-top"><span className="ldg-room-no">{r.room_no}</span><small>{r.room_type}{r.floor ? ` · floor ${r.floor}` : ""}</small></span>
      {many && <small>{r.location_name}</small>}
      <span className="ldg-room-marks">
        <Badge tone={CLEANING[r.cleaning].tone} label={CLEANING[r.cleaning].label} />
        {r.dnd && <Badge tone="danger" label="Do not disturb" />}
        {r.out_of_service && <Badge tone="warning" label="Out of service" />}
        {r.open_tickets > 0 && <Badge tone="info" label={`${r.open_tickets} ${r.open_tickets === 1 ? "ticket" : "tickets"}`} />}
      </span>
      {r.guest && <small><Link to={biz.path(`lodging-stays/${r.guest.id}`)}>{r.guest.guest_name}</Link> · leaves {dayWords(r.guest.departure)}</small>}
      {!r.guest && r.arriving && <small>Arriving: {r.arriving.guest_name} ({r.arriving.stay_no})</small>}
      {r.out_of_order && <small>{r.out_of_order.reason} · {r.out_of_order.ends_on ? `to the night of ${dayWords(r.out_of_order.ends_on)}` : "until put back in order"}</small>}
      {r.out_of_service && <small>Out of service: {r.out_of_service_note}</small>}
      {r.next_out_of_order && <small>Out of order from {dayWords(r.next_out_of_order.starts_on)}: {r.next_out_of_order.reason}</small>}
      {r.cleaned_at && <small className="muted">Cleaned {atWords(r.cleaned_at, biz)} · {r.cleaned_by_name}{r.inspected_at && r.cleaning === "inspected" ? ` · inspected by ${r.inspected_by_name}` : ""}</small>}
      {r.status_note && !r.out_of_order && <small>{r.status_note}</small>}
      <small className="muted">{atWords(r.status_at, biz)} · {r.status_by_name}</small>
      {canMark && (
        <span className="ldg-room-actions">
          {STEPS[r.cleaning].filter(([to]) => !(to === "cleaning" && r.dnd)).map(([to, label]) => (
            <button key={to} type="button" className={`button button-sm ${to === "dirty" ? "button-secondary" : ""}`} disabled={busy === r.id} onClick={() => step(r, to, label)}>{label}</button>
          ))}
          {r.status === "occupied" && (
            <button type="button" className="button button-secondary button-sm" disabled={busy === r.id}
              onClick={() => act(r, `lodging/rooms/${r.id}/flags`, { dnd: !r.dnd }, r.dnd ? `Room ${r.room_no}: do not disturb off.` : `Room ${r.room_no}: do not disturb.`)}>{r.dnd ? "Disturb again" : "Do not disturb"}</button>
          )}
          {r.out_of_service
            ? <button type="button" className="button button-secondary button-sm" disabled={busy === r.id} onClick={() => act(r, `lodging/rooms/${r.id}/flags`, { outOfService: false }, `Room ${r.room_no} is back in service.`)}>Back in service</button>
            : <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "service", room: r })}>Out of service</button>}
          {r.out_of_order
            ? <button type="button" className="button button-sm" disabled={busy === r.id} onClick={() => back(r.out_of_order, r)}>Back in order</button>
            : <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "down", room: r })}>Out of order</button>}
          {hasList(r, "linen") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "check", check: "linen", room: r })}>Linen</button>}
          {hasList(r, "minibar") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "check", check: "minibar", room: r })}>Minibar</button>}
          <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "ticket", room: r })}>Ticket</button>
        </span>
      )}
    </li>
  );
  return (
    <div className="stack">
      <BusinessHeader icon="home" title="Rooms & housekeeping"
        description={`Every room by where it stands tonight, its cleanliness kept apart: dirty, being cleaned, clean, inspected.${board?.inspectionRequired ? " A guest checks in only to an inspected room." : " Only a vacant clean room is given to the next guest."}`}
        secondary={<Link className="button button-secondary" to={biz.path("lodging-maintenance")}>Maintenance</Link>} />
      <ErrorMessage message={error} />
      <SectionCard flush icon="home" title="Rooms" description={board ? COLUMNS.map((s) => `${board.counts[s]} ${ROOM_STATUS[s].label.toLowerCase()}`).join(" · ") : undefined}>
        {!board ? (!error && <Loading />) : !board.rooms.length ? (
          <p className="ldg-empty">No rooms yet. Add the room types and their rooms under Settings › Room types &amp; rates.</p>
        ) : (
          <div className="ldg-board" data-motion-skip>
            {COLUMNS.map((status) => {
              const rooms = board.rooms.filter((r) => r.status === status);
              return (
                <section key={status} className={`ldg-col ldg-col-${status}`} aria-label={ROOM_STATUS[status].label}>
                  <h2 className="ldg-col-head">{ROOM_STATUS[status].label} <span>{rooms.length}</span></h2>
                  <ul className="ldg-col-list">
                    {rooms.map(card)}
                    {!rooms.length && <li className="ldg-empty">None</li>}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </SectionCard>
      {board && (
        <SectionCard flush icon="ban" title="Out of order tonight and ahead" description="Each room's nights off sale, with why: a reservation that would need the room is refused with the reason.">
          <DataGrid variant="compact" id="lodging-out-of-order" caption="Out of order" rows={board.periods} rowKey={(p) => p.id} rowNoun={["period", "periods"]}
            empty="No room is out of order" emptyIcon="check" columns={[
              { key: "room", header: "Room", value: (p) => p.room_no, mobile: "title", pin: true,
                render: (p) => <span className="bz-two-line"><span>Room {p.room_no}</span><small className="muted">{p.room_type}{many ? ` · ${p.location_name}` : ""}</small></span> },
              { key: "from", header: "From the night of", type: "date", value: (p) => p.starts_on, render: (p) => dateWords(p.starts_on), mobile: "subtitle" },
              { key: "to", header: "To the night of", type: "date", value: (p) => p.ends_on || "", render: (p) => (p.ends_on ? dateWords(p.ends_on) : "Until put back in order") },
              { key: "reason", header: "Why", value: (p) => p.reason, mobile: "show" },
              { key: "ticket", header: "Ticket", value: (p) => (p.ticket_no ? `Ticket ${p.ticket_no}` : ""), render: (p) => (p.ticket_no ? <Link to={biz.path("lodging-maintenance")}>Ticket {p.ticket_no}</Link> : "") },
              { key: "by", header: "Booked by", value: (p) => p.created_by_name, defaultHidden: true },
              canMark && { key: "actions", header: "", type: "actions",
                render: (p) => <button type="button" className="link-button" onClick={() => back(p)}>{p.begun ? "Back in order" : "Withdraw"}</button> },
            ].filter(Boolean)} />
        </SectionCard>
      )}
      {dialog?.kind === "down" && <OutOfOrderDialog room={dialog.room} onClose={() => setDialog(null)} onSaved={() => reload(`Room ${dialog.room.room_no} is booked out of order.`)} />}
      {dialog?.kind === "service" && <OutOfServiceDialog room={dialog.room} onClose={() => setDialog(null)} onSaved={() => reload(`Room ${dialog.room.room_no} is out of service.`)} />}
      {dialog?.kind === "check" && <RoomCheckDialog room={dialog.room} kind={dialog.check} items={items} onClose={() => setDialog(null)}
        onSaved={(r) => reload(r.check.lines.some((l) => l.charge_id) ? `Room ${dialog.room.room_no}: checked, the minibar used is on the folio.` : `Room ${dialog.room.room_no}: checked.`)} />}
      {dialog?.kind === "ticket" && <TicketDialog rooms={board?.rooms || []} room={dialog.room} onClose={() => setDialog(null)} onSaved={(r) => reload(`Ticket ${r.ticket.ticket_no} opened.`)} />}
    </div>
  );
}
