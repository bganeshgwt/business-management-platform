import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { STATUS_WORDS, addDays, dayWords, nightsWords } from "./lodging";
import "../styles/lodging.css";

// Reservations: two weeks of nights on the property's clock, for every room
// type: how many rooms are left each night, each room with the stay in it (or
// booked for it) each night, and the reservations with no room chosen yet.
// A stay opens from its night. The server checks every stay again when it is
// saved: a room is never booked twice, nor a room type over its rooms.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (day) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];

export default function ReservationsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const today = businessToday(biz.business.timezone);
  const [from, setFrom] = useState(today);
  const [days, setDays] = useState("14");
  const [typeId, setTypeId] = useState("");
  const [names, setNames] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/calendar", { from, days, roomType: typeId || undefined }, controller.signal)
      .then((d) => { setData(d); setError(""); if (!typeId) setNames(d.types.map((t) => ({ id: t.id, name: t.name }))); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, from, days, typeId]);
  const open = (stay) => navigate(biz.path(`lodging-stays/${stay.id}`));
  const step = Number(days);
  // A stay's chip on the night it starts (or the first night shown), spanning the nights it holds that are on show.
  const chip = (stay, day, list) => {
    const first = stay.arrival > list[0] ? stay.arrival : list[0];
    if (day !== first) return null;
    return (
      <button type="button" className={`ldg-hold ldg-hold-${stay.status}`} onClick={() => open(stay)}
        title={`${stay.stayNo} · ${stay.guestName} · ${STATUS_WORDS[stay.status]} · ${nightsWords(stay.arrival, stay.departure)}`}>
        <span className="mono">{stay.stayNo}</span><small>{stay.guestName}</small>
      </button>
    );
  };
  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Reservations"
        description="Each night on the property's clock, room by room: a room is held from the arrival night to the night before the departure. Rooms left counts every reservation, with a room or not."
        primary={biz.can("lodging.create") && <Link className="button" to={biz.path("lodging-stays/new")}><Icon name="plus" size={16} /> New reservation</Link>}
        secondary={biz.can("lodging.create") && <Link className="button button-secondary" to={biz.path("lodging-groups/new")}><Icon name="users" size={16} /> New group booking</Link>} />
      <ErrorMessage message={error} />
      <SectionCard flush icon="calendar" title={data ? `${dayWords(data.from)} to ${dayWords(data.to)}` : "Reservations"}
        actions={(
          <span className="ldg-cal-tools">
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom((d) => addDays(d, -step))} aria-label="Earlier"><Icon name="chevron-left" size={14} /></button>
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom(today)} disabled={from === today}>Today</button>
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom((d) => addDays(d, step))} aria-label="Later"><Icon name="chevron-right" size={14} /></button>
            <Segmented label="Nights" options={[{ value: "7", label: "Week" }, { value: "14", label: "Two weeks" }]} value={days} onChange={setDays} />
            <select aria-label="Room type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Every room type</option>
              {names.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </span>
        )}>
        {!data ? (!error && <Loading />) : !data.types.length ? (
          <p className="ldg-empty">No room types yet. Add them with their rooms under Settings › Room types &amp; rates.</p>
        ) : (
          <div className="ldg-cal-wrap">
            <table className="ldg-cal" aria-label="Reservations calendar">
              <thead>
                <tr>
                  <th scope="col">Room</th>
                  {data.days.map((day) => <th key={day} scope="col" className={day === today ? "is-today" : ""}><span>{weekday(day)}</span>{dayWords(day)}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.types.map((type) => (
                  <TypeRows key={type.id} type={type} days={data.days} today={today} chip={chip} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function TypeRows({ type, days, today, chip }) {
  return (
    <>
      <tr className="ldg-cal-group">
        <th scope="rowgroup">{type.name}</th>
        {type.left.map((l) => <td key={l.day} className={l.day === today ? "is-today" : ""}><span className={`ldg-cal-left ${l.left === 0 ? "is-full" : ""}`}>{l.left === 0 ? "Full" : `${l.left} left`}</span></td>)}
      </tr>
      {type.rooms.map((room) => (
        <tr key={room.id}>
          <th scope="row"><span className="bz-two-line"><span>Room {room.roomNo}</span>{room.status === "out_of_order" && <small className="muted">out of order</small>}</span></th>
          {room.nights.map((n) => <td key={n.day} className={`ldg-cell ${n.day === today ? "is-today" : ""}`}>{n.stay ? chip(n.stay, n.day, days) : null}</td>)}
        </tr>
      ))}
      {type.unassigned.map((stay) => (
        <tr key={`u${stay.id}`}>
          <th scope="row"><small className="muted">No room yet</small></th>
          {days.map((day, i) => <td key={day} className={`ldg-cell ${day === today ? "is-today" : ""}`}>{stay.nights[i] ? chip(stay, day, days) : null}</td>)}
        </tr>
      ))}
    </>
  );
}
