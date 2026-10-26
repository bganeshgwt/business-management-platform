import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { RATE_KINDS, dateWords, dayWords, partyWords, stayWords, wordOf, SOURCES } from "./lodging";
import "../styles/lodging.css";

// The front desk's day on the property's clock: today's arrivals (and
// reservations past their arrival day not checked in), the guests in the house
// and today's departures (and guests past their departure day), each with the
// step to take; the rooms by status; and the night audit, which posts every
// room night up to tonight not posted yet, each at its night's rate and the
// GST slab its value decides. Run again, it posts nothing twice.

export default function FrontDeskPage() {
  const biz = useOpenBusiness();
  const [day, setDay] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [audit, setAudit] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/desk", undefined, controller.signal).then((d) => { setDay(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const runAudit = async () => {
    setBusy(true);
    try {
      const result = await businessWrite(biz.id, "lodging/night-audit", {});
      setAudit(result);
      toast.success(result.nights ? `${result.nights} ${result.nights === 1 ? "room night" : "room nights"} posted.` : "Every room night up to tonight is posted already.");
      setVersion((n) => n + 1);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const money = biz.can("sales.view");
  const can = (p) => biz.can(p);
  if (!day) return <div className="stack"><BusinessHeader icon="home" title="Front desk" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const row = (s, action) => (
    <li key={s.id} className={`ldg-row ${s.late_arrival || s.stage === "overstay" ? "is-late" : ""}`}>
      <span className="ldg-row-main">
        <strong>{s.guest_name}</strong>
        <span className="ldg-row-meta">
          <span className="mono">{s.stay_no}</span>
          <span>{s.room_type}{s.room_no ? ` · room ${s.room_no}` : " · no room yet"}</span>
          <span>{stayWords(s.arrival, s.departure)}</span>
          <span>{partyWords(s.adults, s.children)}</span>
          {s.source === "ota" ? <span>{s.ota_name} {s.ota_booking_id}</span> : <span>{wordOf(SOURCES, s.source)}</span>}
          {s.bill_to_name && <span>billed to {s.bill_to_name}</span>}
          {s.late_arrival && <span className="ldg-late">was to arrive {dayWords(s.arrival)}</span>}
          {s.stage === "overstay" && <span className="ldg-late">was to leave {dayWords(s.departure)}</span>}
          {s.nights_to_post > 0 && <span className="ldg-due">{s.nights_to_post} {s.nights_to_post === 1 ? "night" : "nights"} to post</span>}
          {money && Number(s.held) > 0 && <span>held {biz.exact(s.held)}</span>}
        </span>
      </span>
      <span className="ldg-row-actions">
        {action}
        <Link className="button button-secondary button-sm" to={biz.path(`lodging-stays/${s.id}`)}>Open</Link>
      </span>
    </li>
  );
  const departures = day.departures;
  const inHouse = day.inHouse.filter((s) => !departures.some((d) => d.id === s.id));
  return (
    <div className="stack">
      <BusinessHeader icon="home" title="Front desk"
        description={`Today, ${dateWords(day.today)}, on the property's clock: who arrives, who is in the house and who leaves. Check-in records every occupant; check-out bills the folio.`}
        primary={can("lodging.create") && <Link className="button" to={biz.path("lodging-stays/new")}><Icon name="plus" size={16} /> New reservation</Link>}
        secondary={can("lodging.create") && <button type="button" className="button button-secondary" onClick={runAudit} disabled={busy || !day.audit.ready}><Icon name="clock" size={15} /> {busy ? "Posting…" : "Run the night audit"}</button>} />
      <ErrorMessage message={error} />
      {!day.audit.ready && <p className="ldg-note ldg-warn">Set the two GST slabs of a room night under Settings › Room types &amp; rates: nothing is reserved or billed until then.</p>}
      <div className="stat-grid">
        <StatTile icon="calendar" tone="info" label="Arriving" value={String(day.counts.arrivals)} note={day.counts.late ? `${day.counts.late} past their arrival day` : "today"} />
        <StatTile icon="home" tone="success" label="In the house" value={String(day.counts.inHouse)} note={`${day.rooms.occupied} of ${day.rooms.rooms} rooms occupied`} />
        <StatTile icon="check" tone={day.counts.overstays ? "danger" : "warning"} label="Leaving today" value={String(day.counts.departures)} note={day.counts.overstays ? `${day.counts.overstays} past their departure day` : "check out by the time agreed"} />
        <StatTile icon="refresh" tone={day.rooms.vacant_dirty ? "warning" : "neutral"} label="Rooms to make up" value={String(day.rooms.vacant_dirty)} note={`${day.rooms.vacant_clean} ready · ${day.rooms.out_of_order} out of order`}
          to={biz.path("lodging-rooms")} />
      </div>
      {day.audit.nights > 0 && <p className="ldg-note">{day.audit.nights} {day.audit.nights === 1 ? "room night" : "room nights"} up to tonight not posted yet ({day.audit.stays} {day.audit.stays === 1 ? "stay" : "stays"}): run the night audit.</p>}
      {audit && (
        <SectionCard flush icon="clock" title="Night audit" description={audit.nights ? `${audit.nights} ${audit.nights === 1 ? "room night" : "room nights"} posted for ${dateWords(audit.today)}` : "Nothing new to post: every room night up to tonight is posted."}>
          {audit.posted.length > 0 && (
            <table className="ldg-bill" aria-label="Room nights posted">
              <thead><tr><th>Stay</th><th>Room</th><th>Night</th><th>Rate</th>{money && <th className="r">Value</th>}{money && <th className="r">GST</th>}</tr></thead>
              <tbody>
                {audit.posted.flatMap((p) => p.nights.map((n) => (
                  <tr key={`${p.stayId}:${n.night}`}><td>{p.stayNo} · {p.guestName}</td><td>{p.roomNo}</td><td>{dateWords(n.night)}</td><td>{RATE_KINDS[n.rateKind]}</td>
                    {money && <td className="r">{biz.exact(n.amount)}</td>}{money && <td className="r">{Number(n.taxRate)}% · {biz.exact(n.tax)}</td>}</tr>
                )))}
              </tbody>
            </table>
          )}
        </SectionCard>
      )}
      <SectionCard flush icon="calendar" title="Arrivals" aria-label="Arrivals" description="Reserved for tonight, and those past their arrival day not checked in yet.">
        <ul className="ldg-list">
          {day.arrivals.map((s) => row(s, can("lodging.create") && <Link className="button button-sm" to={biz.path(`lodging-stays/${s.id}?do=check-in`)}>Check in</Link>))}
          {!day.arrivals.length && <li className="ldg-empty">No arrivals today</li>}
        </ul>
      </SectionCard>
      <SectionCard flush icon="home" title="In the house" aria-label="In the house">
        <ul className="ldg-list">
          {inHouse.map((s) => row(s, null))}
          {!inHouse.length && <li className="ldg-empty">No other guests in the house</li>}
        </ul>
      </SectionCard>
      <SectionCard flush icon="check" title="Departures" aria-label="Departures" description="Leaving today, and those past their departure day: extend the stay, or check the guest out.">
        <ul className="ldg-list">
          {departures.map((s) => row(s, can("lodging.create") && <Link className="button button-sm" to={biz.path(`lodging-stays/${s.id}?do=check-out`)}>Check out</Link>))}
          {!departures.length && <li className="ldg-empty">No departures today</li>}
        </ul>
      </SectionCard>
    </div>
  );
}
