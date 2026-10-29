import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { atWords } from "./rentals";
import { printRegister } from "./rentalsPrint";
import "../styles/rentals.css";

// The hirer register of the rent-a-cab and rent-a-motorcycle schemes: for
// each vehicle, every hire handed over in the chosen dates (on the shop's
// calendar), as the forms list them — Form 5 (a cab) or Form 3 (a motorcycle),
// and Form 6 or 4 for foreign nationals — printed for the State Transport
// Authority's inspection. Kept from each handover and return.

export default function RegisterPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [unit, setUnit] = useState("");
  const [data, setData] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!from || !to || to < from) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "rentals/register", { from, to, unit: unit || undefined }, controller.signal)
      .then((d) => { setData(d); setError(""); if (!unit) setVehicles(d.vehicles.map((v) => ({ id: v.unitId, label: `${v.label} (${v.registration})` }))); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, from, to, unit]);
  const hired = (data?.vehicles || []).filter((v) => v.rows.length || v.foreignRows.length);
  return (
    <div className="stack">
      <BusinessHeader icon="file" title="Hirer register"
        description="Every hire of each vehicle, as the State Transport Authority's forms list it: Form 5 for a cab and Form 3 for a motorcycle (Forms 6 and 4 for foreign nationals)."
        primary={data && <button type="button" className="button" onClick={() => printRegister(biz, data)} disabled={!hired.length}><Icon name="print" size={16} /> Print the register</button>} />
      <ErrorMessage message={error} />
      <SectionCard icon="calendar" title="Dates and vehicle">
        <div className="rnt-when">
          <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Vehicle"><select value={unit} onChange={(e) => setUnit(e.target.value)}><option value="">Every vehicle</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>
        </div>
      </SectionCard>
      {!data ? (!error && <Loading />) : !hired.length ? <p className="rnt-empty">No vehicle was handed over in these dates.</p> : hired.map((v) => (
        <SectionCard key={v.unitId} flush icon="key" title={`${v.label} · ${v.registration}`} description={[v.itemName, v.scheme, v.vehicleClass].filter(Boolean).join(" · ")}>
          {[[v.form, v.rows, false], [v.foreignForm, v.foreignRows, true]].filter(([, list]) => list.length).map(([form, list, foreign]) => (
            <div key={form} className="rnt-week-wrap">
              <table className="rnt-register-table" aria-label={`${form} of ${v.label}`}>
                <caption>{form}</caption>
                <thead><tr><th>Hirer</th><th>{foreign ? "Passport, date of birth, permit" : "Driving licence"}</th><th>Hired</th><th>Returned</th><th>Total km</th><th>Signed</th><th>Remarks</th></tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.bookingId}>
                      <td><strong>{r.name}</strong><br /><small>{r.address || "Address not kept"}</small><br /><small>{r.telephone}</small></td>
                      <td>{foreign ? (
                        <small>{r.passport?.number} · {r.passport?.nation}, {r.passport?.authority} · {dateShort(r.passport?.issuedOn, { year: true })} to {dateShort(r.passport?.validUntil, { year: true })}<br />
                          born {dateShort(r.birthDate, { year: true })}{r.permit ? ` · permit ${r.permit.number} (${dateShort(r.permit.issuedOn, { year: true })}) ${r.permit.classes.join(", ")}` : ""}{r.visa ? ` · visa ${r.visa.number}` : ""}</small>
                      ) : (
                        <small>{r.licence.number} · {r.licence.authority} · {r.licence.classes.join(", ")}<br />{dateShort(r.licence.issuedOn, { year: true })} to {dateShort(r.licence.validUntil, { year: true })}</small>
                      )}</td>
                      <td>{atWords(r.hiredAt, biz, { today: false })}</td>
                      <td>{r.returnedAt ? atWords(r.returnedAt, biz, { today: false }) : <span className="muted">Out</span>}</td>
                      <td className="r">{r.totalKm ?? "—"}</td>
                      <td>{r.signed ? "On screen" : "—"}</td>
                      <td><small>{[r.bookingNo, r.remarks].filter(Boolean).join(" · ")}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </SectionCard>
      ))}
    </div>
  );
}
