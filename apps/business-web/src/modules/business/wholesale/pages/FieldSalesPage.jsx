import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { count, dateShort, timeOnly } from "@bmp/shared/format";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import LiveIndicator from "../../../../components/LiveIndicator";
import { EmptyState, ErrorMessage } from "../../../../components/Feedback";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { businessOptions, businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import "../../../../styles/business-trade.css";
import "../styles/field-sales.css";

// Field sales (Sales orders › Field sales): the office's view of a day of its
// salespeople, live as their phones send it. For each salesperson: when the
// day started and ended, beat adherence (planned shops visited of planned),
// calls, productive calls and the strike rate, lines per call, the order
// value, collections by mode, cash not yet handed over, new shops, why shops
// did not order, the month's orders against the target, and every visit with
// its times, its distance from the shop's saved place and a link to its
// place in Google Maps. Above them: orders refused on arrival (a credit hold
// let through here, a limit raised on the customer, a new shop approved), and
// shops added in the field waiting for approval with their credit.
const REASONS = {
  shop_closed: "Shop closed", owner_away: "Owner not available", enough_stock: "Enough stock", dues_or_hold: "Dues pending or credit hold",
  price_or_scheme: "Price or scheme", other_brand: "Prefers another brand", order_later: "Will order later", other: "Other",
};
const REFUSED = { credit_hold: "Credit hold", credit_limit: "Over the credit limit", cash_only: "New shop, cash only" };
const AREAS = ["field_sales", "sales_order", "collection"];

export default function FieldSalesPage() {
  const biz = useOpenBusiness();
  const [date, setDate] = useState(() => businessToday(biz.business.timezone));
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const load = useCallback(() => businessRead(biz.id, "sales/report", { date })
    .then((r) => { setReport(r); setError(""); })
    .catch((err) => setError(getErrorMessage(err))), [biz.id, date]);
  useEffect(() => {
    const soon = setTimeout(load, 0);
    return () => clearTimeout(soon);
  }, [load]);
  const live = useLiveRefresh({ business: biz.id }, AREAS, load);
  const t = report?.totals;
  const today = businessToday(biz.business.timezone);
  const saved = (message) => { setDialog(null); load(); return message; };

  return (
    <div className="stack fs-page">
      <BusinessHeader icon="users" title="Field sales"
        description="Each salesperson's day as their phone sends it: their beat, visits and check-in places, orders, collections and new shops."
        actions={
          <div className="bz-inline fs-tools">
            <LiveIndicator status={live} />
            <label className="fs-date"><span className="sr-only">Day</span><input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
            {biz.can("salesperson_app.create") && <Link className="button button-secondary button-sm" to={`/business-admin/${biz.id}/salesperson-app`}><Icon name="qr" size={15} /> On their phones</Link>}
            {biz.can("salesperson_app.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ settings: report?.settings })}><Icon name="settings" size={15} /> Settings</button>}
          </div>
        } />
      <ErrorMessage message={error} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="users" tone="primary" label="Out on the beat" value={t ? `${count(t.started)} of ${count(t.salespeople)}` : undefined} loading={!t}
          note={t ? `${count(t.ended)} ended their day` : undefined} />
        <StatTile icon="check" tone="success" label="Calls" value={t ? count(t.calls) : undefined} loading={!t}
          note={t ? `${count(t.productive)} productive${t.strike_rate !== null ? ` · ${t.strike_rate}% strike rate` : ""}${t.adherence !== null ? ` · ${t.adherence}% of the beat` : ""}` : undefined} />
        <StatTile icon="receipt" tone="info" label="Orders" money={t ? Number(t.order_value) : undefined} loading={!t}
          note={t ? `${t.lines_per_call !== null ? `${t.lines_per_call} lines a call` : "No orders yet"}` : undefined} />
        <StatTile icon="wallet" tone="success" label="Collected" money={t ? Number(t.collections.total) : undefined} loading={!t}
          note={t ? `Cash ${biz.amount(t.collections.cash)} · UPI ${biz.amount(t.collections.upi)} · cheques ${biz.amount(t.collections.cheque)}` : undefined} />
        <StatTile icon="cash" tone={t && Number(t.cash_unsettled) > 0 ? "warning" : "neutral"} label="Cash not handed over" money={t ? Number(t.cash_unsettled) : undefined} loading={!t}
          note="Counted at the evening settlement, under Payments received" to={`/business-admin/${biz.id}/collections?tab=settle`} />
      </div>

      {report && report.refusals.length > 0 && (
        <SectionCard icon="alert" tone="danger" title="Orders refused on arrival" flush
          description="The phone keeps each one; once its cause is sorted, the salesperson taps Try again and the same order goes.">
          <ul className="fs-rows">
            {report.refusals.map((r) => (
              <li key={r.id} className="fs-row">
                <div className="fs-row-main">
                  <strong>{r.contact_name}</strong>
                  <span className="muted small">{[r.salesperson_name, REFUSED[r.reason], `${r.tries} ${r.tries === 1 ? "try" : "tries"}`, `last ${timeOnly(r.last_at)}`, r.phone_total ? biz.amount(r.phone_total) : null].filter(Boolean).join(" · ")}</span>
                  <span className="small">{r.message}</span>
                  {r.released_at && !r.order_id && <span className="small fs-ok">Let through by {r.released_by_name}: {r.release_reason}. It goes on the salesperson&apos;s next try.</span>}
                  {r.order_id && <span className="small fs-ok">Went through{r.order_no ? ` as ${r.order_no}` : ""}{r.released_by_name ? `, let through by ${r.released_by_name}` : ""}.</span>}
                </div>
                {!r.order_id && !r.released_at && (
                  <div className="fs-row-actions">
                    {r.reason === "credit_hold" && biz.can("receivables.approve") && <button type="button" className="button button-sm" onClick={() => setDialog({ release: r })}>Let it through</button>}
                    {r.reason === "credit_limit" && <Link className="button button-secondary button-sm" to={`/business-admin/${biz.id}/outstanding`}>See their dues</Link>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {report && report.pending_shops.length > 0 && (
        <SectionCard icon="user-plus" tone="info" title="Shops from the field to approve" flush description="Cash only until approved with their credit.">
          <ul className="fs-rows">
            {report.pending_shops.map((s) => (
              <li key={s.id} className="fs-row">
                <div className="fs-row-main">
                  <strong>{s.name}</strong>
                  <span className="muted small">{[s.contact_person, s.phone, s.gstin, s.beat_name].filter(Boolean).join(" · ")}</span>
                  <span className="muted small">{s.address}</span>
                  <span className="small">Added by {s.salesperson_name} on {dateShort(s.created_at)} · {s.orders} {s.orders === 1 ? "order" : "orders"}{Number(s.balance) > 0 ? ` · owes ${biz.amount(s.balance)}` : ""}</span>
                </div>
                <div className="fs-row-actions">
                  {s.maps && <a className="button button-secondary button-sm" href={s.maps} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} /> Place</a>}
                  {biz.can("salesperson_app.approve") && <button type="button" className="button button-sm" onClick={() => setDialog({ approve: s })}>Approve</button>}
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {report && !report.salespeople.length && (
        <EmptyState icon="users" message="No salespeople yet" hint="Add them under Routes & salespeople, link each to their login, and put their shops on beats." />
      )}
      {report?.salespeople.map((s) => <Person key={s.id} s={s} biz={biz} date={date} />)}

      {dialog?.release && (
        <FormDialog title={`Let ${dialog.release.contact_name}'s order through`} icon="unlock" width={520} submitLabel="Let it through"
          description={`${dialog.release.message} The release is kept with the order.`}
          onSubmit={() => businessWrite(biz.id, `sales/refusals/${dialog.release.id}/release`, { reason: dialog.reason || "" })}
          onClose={() => setDialog(null)} onSaved={() => saved()} successMessage="Let through: it goes on the salesperson's next try.">
          <Field label="Why it may go" wide><input required maxLength={300} onChange={(e) => setDialog((d) => ({ ...d, reason: e.target.value }))} /></Field>
        </FormDialog>
      )}
      {dialog?.approve && <ApproveShop shop={dialog.approve} biz={biz} onClose={() => setDialog(null)} onSaved={() => saved()} />}
      {dialog && "settings" in dialog && <Settings biz={biz} settings={dialog.settings} onClose={() => setDialog(null)} onSaved={() => saved()} />}
    </div>
  );
}

// One salesperson's day.
function Person({ s, biz, date }) {
  const [open, setOpen] = useState(false);
  const reasons = Object.entries(s.no_order_reasons).sort((a, b) => b[1] - a[1]);
  const progress = s.month.target ? Math.min(100, Math.round((Number(s.month.ordered) * 100) / Number(s.month.target))) : null;
  return (
    <SectionCard icon="user" title={s.name} flush
      description={s.day ? `Day ${timeOnly(s.day.started_at)}–${s.day.ended_at ? timeOnly(s.day.ended_at) : "still out"}${s.first_check_in ? ` · first check-in ${timeOnly(s.first_check_in)}, last ${timeOnly(s.last_check_in)}` : ""}` : s.calls ? "Did not start the day on the app" : "Not out on the app"}
      actions={<Link className="button button-secondary button-sm" to={`/sales/${biz.id}?salesperson=${s.id}`}>Their app</Link>}>
      <dl className="fs-figures">
        <div><dt>Beat visited</dt><dd>{s.visited_planned} of {s.planned}{s.adherence !== null ? ` · ${s.adherence}%` : ""}</dd></div>
        <div><dt>Calls</dt><dd>{s.calls} · {s.productive} productive{s.strike_rate !== null ? ` · ${s.strike_rate}%` : ""}</dd></div>
        <div><dt>Lines a call</dt><dd>{s.lines_per_call ?? "—"}</dd></div>
        <div><dt>Orders</dt><dd>{biz.amount(s.order_value)} · {s.orders}{s.price_differences ? ` · ${s.price_differences} priced again` : ""}</dd></div>
        <div><dt>Collected</dt><dd>{biz.amount(s.collections.total)}<small className="muted"> cash {biz.amount(s.collections.cash)} · UPI {biz.amount(s.collections.upi)} · cheques {biz.amount(s.collections.cheque)}</small></dd></div>
        <div><dt>Cash not handed over</dt><dd className={Number(s.cash_unsettled.today) + Number(s.cash_unsettled.earlier) > 0 ? "fs-warn" : ""}>
          {biz.amount(s.cash_unsettled.today)}{Number(s.cash_unsettled.earlier) > 0 ? <small> + {biz.amount(s.cash_unsettled.earlier)} from earlier days</small> : null}
          {s.day?.cash_in_hand !== null && s.day?.cash_in_hand !== undefined ? <small className="muted"> · {biz.amount(s.day.cash_in_hand)} counted on the phone at the day&apos;s end</small> : null}</dd></div>
        <div><dt>New shops</dt><dd>{s.new_shops}</dd></div>
        <div><dt>Flagged visits</dt><dd>{s.far} away from the shop · {s.off_beat} off the beat</dd></div>
        <div className="fs-wide"><dt>This month</dt><dd>
          {biz.amount(s.month.ordered)} ordered{s.month.target ? ` of ${biz.amount(s.month.target)}` : ""}
          {progress !== null && <span className="fs-bar" role="img" aria-label={`${progress}% of the target`}><span style={{ transform: `scaleX(${progress / 100})` }} /></span>}
        </dd></div>
        {reasons.length > 0 && <div className="fs-wide"><dt>Why no order</dt><dd>{reasons.map(([code, n]) => `${REASONS[code] || code} ${n}`).join(" · ")}</dd></div>}
        {s.day && (s.day.start_place || s.day.end_place || s.day.end_note) && (
          <div className="fs-wide"><dt>The day&apos;s start and end</dt><dd>
            {s.day.start_place ? <a href={s.day.start_place} target="_blank" rel="noopener noreferrer">Start on the map</a> : <span className="muted">No start place</span>}
            {" · "}
            {s.day.end_place ? <a href={s.day.end_place} target="_blank" rel="noopener noreferrer">End on the map</a> : <span className="muted">{s.day.ended_at ? "No end place" : "Not ended"}</span>}
            {s.day.end_note ? <small className="muted"> · “{s.day.end_note}”</small> : null}
          </dd></div>
        )}
      </dl>
      {s.visits.length > 0 && (
        <div className="fs-visits">
          <button type="button" className="link-button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide" : "Show"} the {s.visits.length} {s.visits.length === 1 ? "visit" : "visits"}</button>
          {open && (
            <div className="fs-table-wrap">
              <table className="fs-table">
                <caption className="sr-only">{s.name}&apos;s visits on {date}</caption>
                <thead><tr><th>In–out</th><th>Shop</th><th>Outcome</th><th className="r">Order</th><th className="r">Collected</th><th>Check-in place</th></tr></thead>
                <tbody>
                  {s.visits.map((v) => (
                    <tr key={v.id} className={v.far || v.off_beat ? "is-flagged" : ""}>
                      <td>{timeOnly(v.checked_in_at)}{v.checked_out_at ? `–${timeOnly(v.checked_out_at)}` : ""}{v.offline ? <small className="muted"> offline</small> : null}</td>
                      <td>{v.contact_name}{v.off_beat ? <small className="fs-flag"> off the beat{v.off_beat_reason ? `: ${v.off_beat_reason}` : ""}</small> : null}</td>
                      <td>{v.outcome === "order" || v.orders.length ? "Order" : v.outcome === "no_order" ? REASONS[v.no_order_reason] || "No order" : <span className="muted">Not out</span>}{v.note ? <small className="muted"> {v.note}</small> : null}</td>
                      <td className="r">{v.orders.length ? biz.amount(v.orders.reduce((sum, o) => sum + Number(o.total), 0)) : "—"}</td>
                      <td className="r">{Number(v.collected) > 0 ? biz.amount(v.collected) : "—"}</td>
                      <td>
                        {v.maps ? <a href={v.maps} target="_blank" rel="noopener noreferrer">Map</a> : <span className="muted">No place</span>}
                        {v.distance_m !== null ? <small className={v.far ? "fs-flag" : "muted"}> {v.distance_m < 1000 ? `${v.distance_m} m` : `${(v.distance_m / 1000).toFixed(1)} km`} from the shop{v.far ? `: ${v.far_reason || "no reason given"}` : ""}</small> : null}
                        {v.place_saved ? <small className="muted"> · saved as the shop&apos;s place</small> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// Approving a shop from the field: its credit limit and days, and its price group.
function ApproveShop({ shop, biz, onClose, onSaved }) {
  const [form, setForm] = useState({ creditLimit: "", creditDays: "15", priceGroupId: "" });
  const [groups, setGroups] = useState([]);
  const canGroups = biz.can("wholesale.view");
  useEffect(() => {
    if (!canGroups) return undefined;
    const controller = new AbortController();
    businessOptions(biz.id, "price-groups", controller.signal, { active: true }).then(setGroups).catch(() => {});
    return () => controller.abort();
  }, [biz.id, canGroups]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <FormDialog title={`Approve ${shop.name}`} icon="check" width={520} submitLabel="Approve the shop"
      description="From now on its orders follow the usual credit rules: the limit, and the hold for overdue bills."
      onSubmit={() => businessWrite(biz.id, `sales/new-shops/${shop.id}/approve`, { creditLimit: form.creditLimit, creditDays: Number(form.creditDays || 0), ...(form.priceGroupId ? { priceGroupId: Number(form.priceGroupId) } : {}) })}
      onClose={onClose} onSaved={onSaved} successMessage={`${shop.name} is approved.`}>
      <Field label="Credit limit ₹ (empty for no limit)" wide><input type="number" min="1" step="0.01" inputMode="decimal" value={form.creditLimit} onChange={set("creditLimit")} /></Field>
      <Field label="Credit days" wide><input type="number" min="0" max="365" step="1" value={form.creditDays} onChange={set("creditDays")} /></Field>
      {groups.length > 0 && (
        <Field label="Price group" wide>
          <select value={form.priceGroupId} onChange={set("priceGroupId")}>
            <option value="">No group (list prices)</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      )}
    </FormDialog>
  );
}

// The app's settings: the check-in distance, and whether places are recorded at all.
function Settings({ biz, settings, onClose, onSaved }) {
  const [distance, setDistance] = useState(String(settings?.checkin_distance_m ?? 100));
  const [record, setRecord] = useState(settings?.record_places !== false);
  return (
    <FormDialog title="Salesperson app settings" icon="settings" width={520}
      onSubmit={() => businessWrite(biz.id, "sales/settings", { checkinDistance: Number(distance), recordPlaces: record }, "put")}
      onClose={onClose} onSaved={onSaved} successMessage="Settings saved.">
      <Field label="A check-in counts as at the shop within (metres)" hint="20 to 1,000. Farther, the salesperson says why and the visit is flagged." wide>
        <input type="number" min="20" max="1000" step="1" value={distance} onChange={(e) => setDistance(e.target.value)} />
      </Field>
      <label className="checkbox field-wide">
        <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
        Record where salespeople start and end their day and check in (only during their working day)
      </label>
    </FormDialog>
  );
}
