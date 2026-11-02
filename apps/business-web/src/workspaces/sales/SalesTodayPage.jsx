import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { timeOnly } from "@bmp/shared/format";
import SectionCard from "../../components/SectionCard";
import StatTile from "../../components/StatTile";
import { ErrorMessage, EmptyState } from "../../components/Feedback";
import { snapshotAge } from "../../services/offline/snapshots";
import { toast } from "../../services/toast";
import { useSales } from "./salesContext";
import { DAY_NAMES } from "./salesRules";
import useFigures from "./useDayFigures";
import { ShopCard, StartDayDialog } from "./salesParts";
import { money } from "./salesFormat";

// Today: the day started (with its notice), today's beat, how far along the
// salesperson is (shops visited of planned, productive calls, the order value
// and what was collected) and the next shop to visit. The office, with no
// salesperson of its own, chooses whose day to read.
export default function SalesTodayPage() {
  const sales = useSales();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const figures = useFigures(sales);
  const base = `/sales/${sales.businessId}`;
  const keep = sales.watching ? `?salesperson=${sales.watching}` : "";

  if (!sales.watching && sales.me && !sales.me.salesperson) return <Whose sales={sales} />;
  if (!sales.pack) {
    return (
      <div className="sl-page">
        <ErrorMessage message={sales.error} />
        <EmptyState icon="alert" message="Your day has not been read on this phone yet" hint="Open the app once with the network: it keeps your beat, prices and dues for the day, and works offline from then on." />
      </div>
    );
  }

  const next = sales.planned.find((shop) => !sales.visits.some((v) => shop.refs.includes(v.shopRef)));
  const date = new Date(`${sales.today}T00:00:00`);
  const beatNames = sales.beats.today.map((b) => b.name);

  const start = async ({ place, problem }) => {
    await sales.actions.startDay({ place });
    setStarting(false);
    toast.success(problem ? `Day started without your place: ${problem}` : "Your day has started.");
  };

  return (
    <div className="sl-page">
      <ErrorMessage message={sales.error} />
      <section className="sl-hero" aria-labelledby="sl-hero-title">
        <div className="sl-hero-head">
          <div>
            <p className="sl-hero-eyebrow">{DAY_NAMES[sales.weekday - 1]}, {date.toLocaleDateString("en-IN", { day: "numeric", month: "long" })}</p>
            <h1 id="sl-hero-title">{beatNames.length ? beatNames.join(" · ") : "No beat planned today"}</h1>
            <p className="sl-hero-sub">
              {sales.beats.today.length
                ? `${sales.planned.length} ${sales.planned.length === 1 ? "shop" : "shops"} in visit order${sales.beats.today[0]?.route_name ? ` · ${sales.beats.today[0].route_name}` : ""}`
                : sales.beats.anyDay.length ? `Any-day beats: ${sales.beats.anyDay.map((b) => b.name).join(", ")}` : "Ask the office to put your beats on the days you visit them."}
            </p>
          </div>
          <span className={`sl-day-state is-${sales.ended ? "ended" : sales.started ? "started" : "idle"}`}>
            {sales.ended ? `Ended ${timeOnly(sales.endedAt)}` : sales.started ? `Started ${timeOnly(sales.startedAt)}` : "Not started"}
          </span>
        </div>
        <div className="sl-progress" role="img" aria-label={`${figures.visitedPlanned} of ${figures.planned} planned shops visited`}>
          <span className="sl-progress-bar" style={{ transform: `scaleX(${figures.planned ? Math.min(1, figures.visitedPlanned / figures.planned) : 0})` }} />
        </div>
        <p className="sl-progress-words">{figures.visitedPlanned} of {figures.planned} planned shops visited{figures.adherence !== null ? ` · ${figures.adherence}%` : ""}</p>
        {sales.actions && !sales.started && (
          <button type="button" className="button sl-hero-button" onClick={() => setStarting(true)}><Icon name="sun" size={17} /> Start my day</button>
        )}
        {sales.actions && sales.started && !sales.ended && next && (
          <button type="button" className="button sl-hero-button" onClick={() => navigate(`${base}/shops/${next.ref}`)}>
            <Icon name="store" size={17} /> Next: {next.name}
          </button>
        )}
      </section>

      <div className="sl-stats">
        <StatTile size="sm" icon="users" tone="primary" label="Calls" value={String(figures.calls)} note={figures.strikeRate !== null ? `${figures.productive} with an order · ${figures.strikeRate}% strike rate` : "No visits yet"} />
        <StatTile size="sm" icon="receipt" tone="success" label="Orders" value={money(figures.orderValue / 100)} note={`${figures.orders} ${figures.orders === 1 ? "order" : "orders"}${figures.linesPerCall !== null ? ` · ${figures.linesPerCall} lines a call` : ""}`} />
        <StatTile size="sm" icon="wallet" tone="info" label="Collected" value={money(figures.collected / 100)} note={`Cash ${money(figures.cash / 100)} · UPI ${money(figures.upi / 100)}`} />
        <StatTile size="sm" icon="chart" tone="neutral" label="This month" value={money(sales.pack.month?.ordered)} note={sales.pack.month?.target ? `of ${money(sales.pack.month.target)} target` : "ordered"} />
      </div>

      {figures.refused > 0 && (
        <Link to={`${base}/orders${keep}`} className="alert alert-error sl-alert-link">
          {figures.refused} {figures.refused === 1 ? "order was" : "orders were"} refused by the office: see why, and try again once it is sorted.
        </Link>
      )}

      <SectionCard icon="list" title="Today's shops" description={sales.planned.length ? "In the order you visit them." : undefined} flush
        actions={<Link className="button button-secondary button-sm" to={`${base}/shops${keep}`}>All shops</Link>}>
        {sales.planned.length ? (
          <ul className="sl-list">
            {sales.planned.slice(0, 8).map((shop, i) => (
              <li key={shop.ref}>
                <ShopCard shop={shop} to={`${base}/shops/${shop.ref}${keep}`} position={i + 1} visit={sales.visits.find((v) => shop.refs.includes(v.shopRef))} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="store" message="No shops planned for today" hint="Your other shops are under Shops, and any customer can be found there by name or mobile." />
        )}
      </SectionCard>

      <p className="sl-foot muted small">
        Prices and dues read {snapshotAge(sales.pack.savedAt)}{sales.packIsToday ? "" : " (an earlier day: they are read again when the network is back)"}.
        {sales.online && <> <button type="button" className="link-button" onClick={() => sales.refresh()} disabled={sales.refreshing}>{sales.refreshing ? "Reading…" : "Read again"}</button></>}
      </p>

      {starting && <StartDayDialog recordPlaces={sales.settings?.record_places !== false} onStart={start} onClose={() => setStarting(false)} />}
    </div>
  );
}

// A login with no salesperson of its own: the office chooses whose day to
// read; a salesperson not linked yet, or switched off, is told whom to ask.
function Whose({ sales }) {
  const list = sales.me?.salespeople || [];
  if (!sales.me?.can_watch) {
    return (
      <div className="sl-page">
        {sales.me?.inactive
          ? <EmptyState icon="lock" message={`${sales.me.inactive} is switched off as a salesperson here`} hint="Ask the office to switch you on again under Sales orders › Routes & salespeople." />
          : <EmptyState icon="user" message="Your login is not linked to a salesperson here" hint="Ask the office to link it to you under Sales orders › Routes & salespeople. The app then opens on your beat." />}
      </div>
    );
  }
  return (
    <div className="sl-page">
      <h1 className="sl-title">Whose day?</h1>
      <p className="muted">You read a salesperson&apos;s day here as they see it, read only. The office&apos;s report of every salesperson is in Business Admin, under Sales orders.</p>
      {list.length ? (
        <ul className="sl-list sl-people">
          {list.map((person) => (
            <li key={person.id}>
              <Link className="sl-shop" to={`/sales/${sales.businessId}?salesperson=${person.id}`}>
                <span className="sl-shop-mark" aria-hidden="true"><Icon name="user" size={15} /></span>
                <span className="sl-shop-body">
                  <span className="sl-shop-name">{person.name}</span>
                  <span className="sl-shop-meta">{[person.user_name ? `Login: ${person.user_name}` : "No login linked", `${person.beats} ${person.beats === 1 ? "beat" : "beats"}`].join(" · ")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="users" message="No salespeople yet" hint="Add them in Business Admin under Routes & salespeople, and link each to their login." />
      )}
    </div>
  );
}
