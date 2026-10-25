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
import { atWords } from "./rentals";
import "../styles/rentals.css";

// Availability: a week (or two) of days on the business's clock, for every
// item in use. Each unit is a row with the bookings that hold it on each day
// (booked, out, or back and in its turnaround time); each pool is a row with
// how many are free on each day (of how many it has) at its busiest. A
// booking opens from its hold. Worked out from the bookings themselves; the
// database checks every booking again when it is saved.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayWords = (day) => { const d = new Date(`${day}T00:00:00Z`); return { weekday: WEEKDAYS[d.getUTCDay()], date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }; };
const PARTS = { booked: "Booked", out: "Out", back: "Back, turnaround" };

export default function AvailabilityPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const today = businessToday(biz.business.timezone);
  const [from, setFrom] = useState(today);
  const [days, setDays] = useState("7");
  const [itemId, setItemId] = useState("");
  const [names, setNames] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "rentals/availability", { from, days, item: itemId || undefined }, controller.signal)
      .then((d) => { setData(d); setError(""); if (!itemId) setNames(d.items.map((i) => ({ id: i.itemId, name: i.name }))); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, from, days, itemId]);
  const open = (h) => navigate(biz.path(`rental-bookings/${h.bookingId}`));
  const step = Number(days);

  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Availability"
        description="What is free day by day, on the shop's clock. A booking holds what it books from its out time to its due time and the turnaround time; what is out stays held until it is back."
        primary={biz.can("rentals.create") && <Link className="button" to={biz.path("rental-bookings/new")}><Icon name="plus" size={16} /> New booking</Link>} />
      <ErrorMessage message={error} />
      <SectionCard flush icon="calendar" title={data ? `${dayWords(data.from).date} to ${dayWords(data.to).date}` : "Availability"}
        actions={(
          <span className="rnt-week-tools">
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom((d) => shiftDay(d, -step))} aria-label="Earlier"><Icon name="chevron-left" size={14} /></button>
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom(today)} disabled={from === today}>Today</button>
            <button type="button" className="button button-secondary button-sm" onClick={() => setFrom((d) => shiftDay(d, step))} aria-label="Later"><Icon name="chevron-right" size={14} /></button>
            <Segmented label="Days" options={[{ value: "7", label: "Week" }, { value: "14", label: "Two weeks" }]} value={days} onChange={setDays} />
            <select aria-label="Item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">Every item</option>
              {names.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </span>
        )}>
        {!data ? (!error && <Loading />) : !data.items.length ? (
          <p className="rnt-empty">No rental items in use yet. Add what the shop hires out under Rental items.</p>
        ) : (
          <div className="rnt-week-wrap">
            <table className="rnt-week" aria-label="Availability">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  {data.days.map((day) => { const w = dayWords(day); return <th key={day} scope="col" className={day === today ? "is-today" : ""}><span>{w.weekday}</span> {w.date}</th>; })}
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (item.kind === "pool" ? (
                  <tr key={`p${item.itemId}`}>
                    <th scope="row"><span className="bz-two-line"><span>{item.name}</span><small className="muted">{item.poolQuantity} in the pool</small></span></th>
                    {item.days.map((d) => (
                      <td key={d.day} className={`rnt-cell ${d.free === 0 ? "is-full" : d.held ? "is-part" : "is-free"} ${d.day === today ? "is-today" : ""}`}>
                        <strong>{d.free}</strong> <small>free of {item.poolQuantity}</small>
                        {d.holds.length > 0 && (
                          <span className="rnt-hold-list">
                            {d.holds.map((h) => (
                              <button key={`${h.bookingId}:${h.part}`} type="button" className={`rnt-hold rnt-hold-${h.part}`} onClick={() => open(h)}
                                title={`${h.bookingNo} · ${h.customerName} · ${PARTS[h.part]} · ${atWords(h.startsAt, biz)} to ${atWords(h.endsAt, biz)}`}>{h.quantity} · {h.bookingNo}</button>
                            ))}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ) : (
                  <UnitRows key={`u${item.itemId}`} item={item} today={today} biz={biz} onOpen={open} />
                )))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <p className="rnt-note">Booked: reserved and not yet handed over. Out: handed over and not back (past its due time it stays held until it is back). Back, turnaround: returned and being made ready.</p>
    </div>
  );
}

function UnitRows({ item, today, biz, onOpen }) {
  return (
    <>
      <tr className="rnt-week-group"><th scope="rowgroup" colSpan={item.units[0]?.days.length + 1 || 1}>{item.name}</th></tr>
      {item.units.map((unit) => (
        <tr key={unit.unitId}>
          <th scope="row"><span className="bz-two-line"><span>{unit.label}</span><small className="muted">{[unit.serialNo, unit.status !== "available" ? (unit.status === "maintenance" ? "in maintenance" : "retired") : null].filter(Boolean).join(" · ")}</small></span></th>
          {unit.days.map((d) => (
            <td key={d.day} className={`rnt-cell ${d.holds.length ? "is-full" : unit.status === "available" ? "is-free" : "is-off"} ${d.day === today ? "is-today" : ""}`}>
              {d.holds.length ? d.holds.map((h) => (
                <button key={`${h.bookingId}:${h.part}`} type="button" className={`rnt-hold rnt-hold-${h.part}`} onClick={() => onOpen(h)}
                  title={`${PARTS[h.part]} · ${atWords(h.startsAt, biz)} to ${atWords(h.endsAt, biz)}`}>
                  <span>{h.bookingNo}</span><small>{h.customerName}</small>
                </button>
              )) : <small className="muted">{unit.status === "available" ? "Free" : unit.status === "maintenance" ? "Maintenance" : "Retired"}</small>}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
