import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { dateShort, timeOnly } from "@bmp/shared/format";
import SectionCard from "../../components/SectionCard";
import { EmptyState } from "../../components/Feedback";
import { toast } from "../../services/toast";
import { useSales } from "./salesContext";
import { recordsOfDay } from "./salesJournal";
import { distanceText, reasonLabel, readShopRef } from "./salesRules";
import { CheckInDialog, NoOrderDialog, ReceiptDialog, SendState, ShopChips, StartDayDialog } from "./salesParts";
import { money } from "./salesFormat";
import CollectDialog from "./CollectDialog";

// A shop, and the visit to it: who and where it is, what it owes and its
// credit, its last order; then the visit itself: check in (the place, its
// distance from the shop's saved place, a reason when far or off the beat),
// take an order, collect, and check out with the order or why there was none.
export default function SalesShopPage() {
  const sales = useSales();
  const navigate = useNavigate();
  const { shopRef } = useParams();
  const [sheet, setSheet] = useState(null);
  const base = `/sales/${sales.businessId}`;
  const keep = sales.watching ? `?salesperson=${sales.watching}` : "";
  const shop = readShopRef(shopRef) ? sales.shopByRef(shopRef) : null;

  if (!shop) {
    return (
      <div className="sl-page">
        <EmptyState icon="store" message="This shop is not on this phone" hint="Find it under Shops: your own shops work offline; any other shop is found with the network." />
        <Link className="button button-secondary" to={`${base}/shops${keep}`}>Shops</Link>
      </div>
    );
  }

  const visits = sales.visits.filter((v) => shop.refs.includes(v.shopRef));
  const open = visits.find((v) => !v.out);
  const orders = recordsOfDay(sales.entries, sales.day, sales.today, "order").filter((r) => (r.entry ? shop.refs.includes(r.entry.shopRef) : shop.id && r.server.contact_id === shop.id));
  const collections = recordsOfDay(sales.entries, sales.day, sales.today, "collection").filter((r) => (r.entry ? shop.refs.includes(r.entry.shopRef) : shop.id && r.server.contact_id === shop.id));
  const onBeat = sales.beats.today.some((b) => Number(b.id) === Number(shop.beat_id)) || sales.beats.anyDay.some((b) => Number(b.id) === Number(shop.beat_id));
  const limitLeft = shop.credit_limit !== null && shop.credit_limit !== undefined ? Number(shop.credit_limit) - Math.max(0, Number(shop.balance)) - Number(shop.pending_orders) : null;
  const beat = (sales.pack?.beats || []).find((b) => Number(b.id) === Number(shop.beat_id));
  const depotId = Number(beat?.depot_id || sales.pack?.default_depot_id);
  const orderOfOpen = open ? orders.filter((r) => (r.entry ? r.entry.visitKey === open.key : r.server.visit_key === open.key)) : [];

  const checkIn = async (details) => {
    await sales.actions.checkIn(shop, details);
    setSheet(null);
    toast.success(details.far ? "Checked in (away from the shop's place: flagged for the office)" : "Checked in");
  };
  const checkOut = async (details) => {
    await sales.actions.checkOut(shop, open, details);
    setSheet(null);
    toast.success("Checked out");
    navigate(`${base}${keep}`);
  };
  const start = async ({ place }) => {
    await sales.actions.startDay({ place });
    setSheet("checkin");
  };

  return (
    <div className="sl-page">
      <div className="sl-shop-head">
        <Link to={`${base}/shops${keep}`} className="sl-back" aria-label="Back to shops"><Icon name="undo" size={18} /></Link>
        <div>
          <h1 className="sl-title">{shop.name}</h1>
          <p className="muted small">{[shop.contact_person, beat?.name, shop.address].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      <ShopChips shop={shop} />

      <dl className="sl-facts">
        <div><dt>Owes</dt><dd>{money(Math.max(0, Number(shop.balance)))}</dd></div>
        <div><dt>Overdue</dt><dd className={Number(shop.overdue) > 0 ? "is-warning" : ""}>{Number(shop.overdue) > 0 ? `${money(shop.overdue)} · ${shop.most_days_overdue} d` : "—"}</dd></div>
        <div><dt>Credit left</dt><dd>{shop.approval === "pending" ? "Cash only" : limitLeft === null ? "No limit" : money(Math.max(0, limitLeft))}</dd></div>
        <div><dt>Last order</dt><dd>{shop.last_order ? `${dateShort(shop.last_order.created_at)} · ${money(shop.last_order.total)}` : "None yet"}</dd></div>
      </dl>
      <div className="sl-contact">
        {shop.phone && <a className="button button-secondary button-sm" href={`tel:${shop.phone}`}><Icon name="phone" size={15} /> Call</a>}
        {shop.place && (
          <a className="button button-secondary button-sm" href={`https://www.google.com/maps?q=${shop.place.latitude},${shop.place.longitude}`} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={15} /> Shop&apos;s place in Maps
          </a>
        )}
      </div>

      {sales.actions && !open && (
        <section className="sl-visit-start">
          {!sales.started ? (
            <>
              <p>Start your day to check in: your place is recorded from then until you end it.</p>
              <button type="button" className="button sl-wide" onClick={() => setSheet("start")}><Icon name="sun" size={17} /> Start my day</button>
            </>
          ) : (
            <>
              {sales.ended && <p className="muted small">Your day has ended: a visit now keeps its time but not your place.</p>}
              {!onBeat && <p className="muted small">Not on today&apos;s beat: the check-in asks why.</p>}
              <button type="button" className="button sl-wide" onClick={() => setSheet("checkin")}><Icon name="check" size={17} /> {visits.length ? "Check in again" : "Check in"}</button>
            </>
          )}
        </section>
      )}

      {open && (
        <SectionCard icon="clock" title={`Checked in ${timeOnly(open.at)}`} tone="primary"
          description={[open.distance !== null && open.distance !== undefined ? `${distanceText(open.distance)} from the shop's place` : null, open.far ? "away from the shop: flagged" : null, open.offBeat ? "off today's beat" : null].filter(Boolean).join(" · ") || undefined}>
          {sales.actions ? (
            <div className="sl-visit-actions">
              <Link className="sl-action is-primary" to={`${base}/shops/${shop.ref}/order`}><Icon name="receipt" size={22} /><span>Take an order</span></Link>
              {sales.settings?.receivables !== false && (
                <button type="button" className="sl-action" onClick={() => setSheet("collect")}><Icon name="wallet" size={22} /><span>Collect</span></button>
              )}
              {orderOfOpen.length ? (
                <button type="button" className="sl-action" onClick={() => checkOut({ outcome: "order" })}><Icon name="logout" size={22} /><span>Check out</span></button>
              ) : (
                <button type="button" className="sl-action" onClick={() => setSheet("noorder")}><Icon name="minus" size={22} /><span>No order · check out</span></button>
              )}
            </div>
          ) : <p className="muted">Checked in, not yet out.</p>}
        </SectionCard>
      )}

      {(orders.length > 0 || collections.length > 0) && (
        <SectionCard icon="list" title="Today at this shop" flush>
          <ul className="sl-records">
            {orders.map((r) => <OrderRow key={r.key} record={r} sales={sales} />)}
            {collections.map((r) => <CollectionRow key={r.key} record={r} sales={sales} onReceipt={() => setSheet({ receipt: r })} />)}
          </ul>
        </SectionCard>
      )}

      {visits.filter((v) => v.out).map((v) => (
        <p key={v.key} className="sl-visit-done">
          <Icon name={v.orderKeys.length ? "check" : "minus"} size={15} />
          Visited {timeOnly(v.at)}{v.out?.at ? `–${timeOnly(v.out.at)}` : ""}: {v.orderKeys.length ? "order taken" : `no order · ${reasonLabel(v.out?.reason)}`}
        </p>
      ))}

      {sheet === "start" && <StartDayDialog recordPlaces={sales.settings?.record_places !== false} onStart={start} onClose={() => setSheet(null)} />}
      {sheet === "checkin" && <CheckInDialog shop={shop} settings={sales.settings} onBeat={onBeat} dayStarted={sales.started && !sales.ended} onCheckIn={checkIn} onClose={() => setSheet(null)} />}
      {sheet === "noorder" && <NoOrderDialog shop={shop} today={sales.today} onSave={checkOut} onClose={() => setSheet(null)} />}
      {sheet === "collect" && (
        <CollectDialog shop={shop} depotId={depotId} onDone={(receipt) => setSheet({ receipt })} onClose={() => setSheet(null)} visit={open} />
      )}
      {sheet?.receipt && (
        <ReceiptDialog business={sales.biz.settings.display_name || sales.biz.business.name} shop={shop} salesperson={sales.me?.salesperson?.name || ""}
          collection={sheet.receipt.entry ? sheet.receipt.entry.data : { amount: sheet.receipt.server.amount, method: sheet.receipt.server.method, reference: sheet.receipt.server.reference,
            chequeDate: sheet.receipt.server.cheque_date, bank: sheet.receipt.server.bank }}
          number={sheet.receipt.entry ? sheet.receipt.entry.result?.collection_no : sheet.receipt.server.collection_no} at={sheet.receipt.at} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

function OrderRow({ record, sales }) {
  const state = record.entry ? sales.status(record.entry) : { state: "sent" };
  const result = record.entry?.result || record.server;
  const total = result?.total ?? record.entry?.data.phoneTotal;
  const difference = result && Number(result.price_difference ?? 0) !== 0 ? Number(result.price_difference) : null;
  return (
    <li className="sl-record">
      <span className="sl-record-head">
        <strong>{result?.order_no || "Order"}</strong>
        <SendState state={state} />
      </span>
      <span className="sl-record-meta">{money(total)}{record.entry ? ` · ${record.entry.data.lines?.length || 0} lines` : ""}</span>
      {difference !== null && <span className="sl-record-note">Priced again by the office: {difference > 0 ? "up" : "down"} {money(Math.abs(difference))} from the phone&apos;s {money(result.phone_total)}.</span>}
      {state.state === "attention" && <span className="sl-record-why">{state.message}</span>}
    </li>
  );
}

function CollectionRow({ record, sales, onReceipt }) {
  const state = record.entry ? sales.status(record.entry) : { state: "sent" };
  const data = record.entry ? record.entry.data : record.server;
  const number = record.entry?.result?.collection_no || record.server?.collection_no;
  return (
    <li className="sl-record">
      <span className="sl-record-head">
        <strong>{number || "Collection"}</strong>
        <SendState state={state} />
      </span>
      <span className="sl-record-meta">{money(data.amount)} · {data.method === "upi" ? "UPI" : data.method === "cheque" ? `Cheque ${data.reference}` : "Cash"}</span>
      {state.state === "attention" && <span className="sl-record-why">{state.message}</span>}
      <button type="button" className="link-button" onClick={onReceipt}>Receipt</button>
    </li>
  );
}
