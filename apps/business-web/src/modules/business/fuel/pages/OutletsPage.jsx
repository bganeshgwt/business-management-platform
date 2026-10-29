import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { FlagBadge } from "./FuelParts";
import { dayWords, qty } from "./fuel";
import "../styles/fuel.css";

// Every outlet at a glance, for an owner with several: today's shifts and
// sales, the attendants' shorts and excess today, each tank's latest day of
// the stock register against the tolerance, what customers owe on the
// outlet's bills and its fleet fills not yet billed, and the bell's alerts.
// Money for those who see sales.

const SEVERITY_TONES = { critical: "danger", warning: "warning", info: "info" };

export default function OutletsPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/outlets", undefined, controller.signal).then((x) => { setData(x); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  return (
    <div className="stack">
      <BusinessHeader icon="store" title="Outlets" description="Each outlet today: its shifts and sales, the stock register's latest day by tank, what is owed there and its alerts." />
      <ErrorMessage message={error} />
      {!data ? !error && <Loading /> : (
        <>
          {data.totals && (
            <div className="stat-grid">
              <StatTile icon="receipt" tone="primary" label="Sold today" value={biz.exact(data.totals.sales)} note={`${data.outlets.length} ${data.outlets.length === 1 ? "outlet" : "outlets"}`} />
              <StatTile icon="wallet" tone="neutral" label="Customers owe" value={biz.exact(data.totals.customers)} note={`${biz.exact(data.totals.unbilled)} of fleet fills not yet billed`} />
              <StatTile icon="users" tone={Number(data.totals.attendants) > 0 ? "warning" : "neutral"} label="Attendants owe" value={biz.exact(data.totals.attendants)} />
            </div>
          )}
          <div className="fuel-outlets">
            {data.outlets.map((o) => (
              <SectionCard key={o.location.id} icon="store" title={o.location.name}
                description={`${o.shifts.open} ${o.shifts.open === 1 ? "shift" : "shifts"} open · ${o.shifts.closed} closed today${o.sales !== null ? ` · ${biz.exact(o.sales)} sold` : ""}`}>
                <dl className="fuel-facts">
                  <dt>Sold today</dt><dd>{o.litres.length ? o.litres.map((l) => `${l.name} ${qty(l.litres, l.unit)}`).join(" · ") : "Nothing yet"}</dd>
                  {o.short !== null && <><dt>Attendants today</dt><dd className="mono">short {biz.exact(o.short)} · excess {biz.exact(o.excess)}</dd></>}
                  {o.dues && <><dt>Owed here</dt><dd className="mono">customers {biz.exact(o.dues.customers)} · fills not billed {biz.exact(o.dues.unbilled)} · attendants {biz.exact(o.dues.attendants)}</dd></>}
                </dl>
                <ul className="fuel-history" aria-label={`Stock register at ${o.location.name}`}>
                  {o.stock.map((t) => <li key={t.tankNo}>Tank {t.tankNo} ({t.product}){t.day ? ` · ${dayWords(t.day)}` : ""} · <FlagBadge flag={t.flag} />{t.variation !== null ? ` ${t.variation} L (${t.percent}%)` : ""}</li>)}
                </ul>
                <p className="small">
                  Alerts: <Badge tone="danger" label={`${o.alerts.critical} critical`} /> <Badge tone="warning" label={`${o.alerts.warning} to see to`} /> <Badge tone="info" label={`${o.alerts.info} to note`} />
                </p>
                {o.alerts.items.length > 0 && (
                  <ul className="fuel-history">
                    {o.alerts.items.map((a, i) => <li key={i}><Badge tone={SEVERITY_TONES[a.severity] || "neutral"} label={a.severity} /> {a.link ? <Link to={a.link}>{a.title}</Link> : a.title}</li>)}
                  </ul>
                )}
              </SectionCard>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
