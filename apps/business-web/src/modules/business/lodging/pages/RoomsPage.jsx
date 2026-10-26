import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { OutOfOrderDialog } from "./LodgingDialogs";
import { ROOM_STATUS, atWords, dayWords } from "./lodging";
import "../styles/lodging.css";

// Rooms & housekeeping: every room in a column for its status — vacant dirty
// (to make up, first: housekeeping's list), vacant clean (ready for a guest),
// occupied (with who is in it and when they leave) and out of order (with
// why). Housekeeping marks a room clean once made up, or dirty again, and puts
// it out of order and back; a room is occupied only while a guest is checked
// in, and is left dirty when they check out. The front desk sees the same board.

const COLUMNS = ["vacant_dirty", "vacant_clean", "occupied", "out_of_order"];

export default function RoomsPage() {
  const biz = useOpenBusiness();
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/rooms/board", undefined, controller.signal).then((b) => { setBoard(b); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const mark = async (room, status) => {
    setBusy(room.id);
    try {
      await businessWrite(biz.id, `lodging/rooms/${room.id}/status`, { status });
      toast.success(`Room ${room.room_no}: ${ROOM_STATUS[status].label.toLowerCase()}.`);
      setVersion((n) => n + 1);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const canMark = biz.can("lodging.edit");
  const many = biz.locations.length > 1;
  return (
    <div className="stack">
      <BusinessHeader icon="home" title="Rooms & housekeeping"
        description="Every room by its status. A room left by a guest is vacant dirty until housekeeping marks it clean; only a vacant clean room is given to the next guest." />
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
                    {rooms.map((r) => (
                      <li key={r.id} className="ldg-room" aria-label={`Room ${r.room_no}`}>
                        <span className="ldg-room-top"><span className="ldg-room-no">{r.room_no}</span><small>{r.room_type}{r.floor ? ` · floor ${r.floor}` : ""}</small></span>
                        {many && <small>{r.location_name}</small>}
                        {r.guest && <small><Link to={biz.path(`lodging-stays/${r.guest.id}`)}>{r.guest.guest_name}</Link> · leaves {dayWords(r.guest.departure)}</small>}
                        {!r.guest && r.arriving && <small>Arriving: {r.arriving.guest_name} ({r.arriving.stay_no})</small>}
                        {r.status_note && <small>{r.status_note}</small>}
                        <small className="muted">{atWords(r.status_at, biz)} · {r.status_by_name}</small>
                        {canMark && status !== "occupied" && (
                          <span className="ldg-room-actions">
                            {status === "vacant_dirty" && <button type="button" className="button button-sm" disabled={busy === r.id} onClick={() => mark(r, "vacant_clean")}>Mark clean</button>}
                            {status === "vacant_clean" && <button type="button" className="button button-secondary button-sm" disabled={busy === r.id} onClick={() => mark(r, "vacant_dirty")}>Mark dirty</button>}
                            {status === "out_of_order" && <button type="button" className="button button-sm" disabled={busy === r.id} onClick={() => mark(r, "vacant_dirty")}>Back in order</button>}
                            {status !== "out_of_order" && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog(r)}>Out of order</button>}
                          </span>
                        )}
                      </li>
                    ))}
                    {!rooms.length && <li className="ldg-empty">None</li>}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </SectionCard>
      {dialog && <OutOfOrderDialog room={dialog} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast.success(`Room ${dialog.room_no} is out of order.`); setVersion((n) => n + 1); }} />}
    </div>
  );
}
