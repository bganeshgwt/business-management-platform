import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { dateShort } from "@bmp/shared/format";
import Modal from "../../components/Modal";
import StatusBadge from "../../components/StatusBadge";
import { ErrorMessage } from "../../components/Feedback";
import { whatsappLink } from "../../modules/business/retail/pages/retail";
import { STATE_WORDS } from "./salesJournal";
import { FAR_REASONS, NO_ORDER_REASONS, OFF_BEAT_REASONS, distanceMetres, distanceText, receiptText } from "./salesRules";
import { locate } from "./salesLocation";
import { money } from "./salesFormat";

// Pieces the salesperson app's screens share: a shop's card, a record's
// sending state, and the short sheets of the day (start, check-in, no order,
// end, a receipt).

const owes = (shop) => Number(shop.balance || 0);

// A record's state: waiting, sending, needing attention, sent.
export function SendState({ state }) {
  const words = STATE_WORDS[state.state] || STATE_WORDS.checking;
  return <StatusBadge tone={words.tone} label={words.label} />;
}

// What a shop's card says about its money and standing, as chips.
export function ShopChips({ shop }) {
  const chips = [];
  if (shop.approval === "pending") chips.push({ tone: "info", text: "New · cash only until approved" });
  if (shop.hold?.held) chips.push({ tone: "danger", text: shop.hold.reason === "overdue" ? `On hold · ${shop.hold.days} days late` : "On hold · cheques bounced" });
  if (owes(shop) > 0) chips.push({ tone: Number(shop.overdue) > 0 ? "warning" : "neutral", text: `Owes ${money(shop.balance)}${Number(shop.overdue) > 0 && !shop.hold?.held ? ` · ${shop.most_days_overdue} d overdue` : ""}` });
  if (owes(shop) < 0) chips.push({ tone: "success", text: `Advance ${money(-owes(shop))}` });
  if (Number(shop.open_orders) > 0) chips.push({ tone: "neutral", text: `${shop.open_orders} order${Number(shop.open_orders) === 1 ? "" : "s"} to deliver` });
  if (shop.promised_on) chips.push({ tone: "neutral", text: `Promised ${dateShort(shop.promised_on)}` });
  if (!chips.length) return null;
  return (
    <span className="sl-chips">
      {chips.map((chip) => <span key={chip.text} className={`sl-chip is-${chip.tone}`}>{chip.text}</span>)}
    </span>
  );
}

// A shop on the beat: its place in the visit order, how it stands, and
// whether it was visited today.
export function ShopCard({ shop, to, position, visit, distance }) {
  const done = visit?.out;
  return (
    <Link to={to} className={`sl-shop ${visit ? "is-visited" : ""}`} aria-label={`${shop.name}${visit ? (done ? ", visited" : ", checked in") : ""}`}>
      <span className={`sl-shop-mark ${done ? (visit.orderKeys?.length ? "is-order" : "is-no-order") : visit ? "is-open" : ""}`} aria-hidden="true">
        {done ? <Icon name={visit.orderKeys?.length ? "check" : "minus"} size={16} /> : visit ? <Icon name="clock" size={15} /> : position || <Icon name="store" size={15} />}
      </span>
      <span className="sl-shop-body">
        <span className="sl-shop-name">{shop.name}</span>
        <span className="sl-shop-meta">
          {[shop.address, shop.last_order ? `Last order ${dateShort(shop.last_order.created_at)}` : "No order yet", distance !== undefined && distance !== null ? distanceText(distance) : null].filter(Boolean).join(" · ")}
        </span>
        <ShopChips shop={shop} />
      </span>
      <Icon name="external" size={15} className="sl-shop-go" />
    </Link>
  );
}

// "Start my day": what is recorded and why (DPDP: notice and purpose), then
// the place if the business records places and the phone allows.
export function StartDayDialog({ recordPlaces, onStart, onClose }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const start = async () => {
    setBusy(true);
    setProblem("");
    try {
      const place = recordPlaces ? await locate() : null;
      await onStart({ place: place?.latitude ? place : null, problem: place?.problem || null });
    } catch (err) {
      setProblem(err?.message || "The day could not be started on this phone.");
      setBusy(false);
    }
  };
  return (
    <Modal title="Start my day" icon="sun" onClose={onClose} width={480} className="sl-sheet"
      footer={<button type="button" className="button sl-wide" onClick={start} disabled={busy}><Icon name="check" size={16} /> {busy ? "Starting…" : "Start my day"}</button>}>
      {recordPlaces ? (
        <div className="sl-notice">
          <Icon name="shield" size={18} />
          <p>
            <strong>Your location is recorded only during your working day:</strong> when you start the day, at each check-in and when you end it — so the office can see your visits.
            Nothing is recorded before you start or after you end the day, and never in between check-ins.
          </p>
        </div>
      ) : (
        <p className="muted">This business does not record places: your visits are kept with their times only.</p>
      )}
      <ErrorMessage message={problem} />
    </Modal>
  );
}

// A check-in: where the phone is, how far from the shop's saved place, and
// the reasons asked for when it is far or off today's beat.
export function CheckInDialog({ shop, settings, onBeat, dayStarted, onCheckIn, onClose }) {
  const recordPlaces = settings?.record_places !== false && dayStarted;
  const limit = Number(settings?.checkin_distance_m || 100);
  const [place, setPlace] = useState(null);
  const [finding, setFinding] = useState(recordPlaces);
  const [farReason, setFarReason] = useState("");
  const [offBeatReason, setOffBeatReason] = useState("");
  const [savePlace, setSavePlace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (!recordPlaces) return undefined;
    let alive = true;
    locate().then((found) => {
      if (!alive) return;
      setPlace(found);
      setFinding(false);
      setSavePlace(Boolean(found.latitude && !shop.place && found.accuracy <= 50));
    });
    return () => {
      alive = false;
    };
  }, [recordPlaces, shop.place]);
  const fix = place?.latitude ? place : null;
  const distance = fix && shop.place ? distanceMetres(fix, shop.place) : null;
  const far = distance !== null && distance > limit;
  const missing = (far && !farReason.trim()) || (!onBeat && !offBeatReason.trim());
  const go = async () => {
    setBusy(true);
    setProblem("");
    try {
      await onCheckIn({ place: fix, distance, far, farReason: farReason.trim(), offBeat: !onBeat, offBeatReason: offBeatReason.trim(), savePlace: savePlace && Boolean(fix) && !shop.place });
    } catch (err) {
      setProblem(err?.message || "The check-in could not be kept on this phone.");
      setBusy(false);
    }
  };
  return (
    <Modal title={`Check in at ${shop.name}`} icon="store" onClose={onClose} width={500} className="sl-sheet"
      footer={<button type="button" className="button sl-wide" onClick={go} disabled={busy || finding || missing}><Icon name="check" size={16} /> {finding ? "Finding your place…" : "Check in"}</button>}>
      <div className="sl-place" data-state={!recordPlaces ? "off" : finding ? "finding" : fix ? (far ? "far" : "near") : "none"}>
        <Icon name={fix ? (far ? "alert" : "check") : "info"} size={18} />
        <div>
          {!recordPlaces ? (
            <p>{dayStarted ? "This business does not record places: the visit keeps its time only." : "Your day has not started: the visit is kept with no place."}</p>
          ) : finding ? (
            <p>Finding where you are… (a few seconds; outdoors is quicker)</p>
          ) : fix ? (
            <p>
              {distance !== null
                ? far ? `You are ${distanceText(distance)} from ${shop.name}'s saved place: more than the ${limit} m allowed.` : `You are ${distanceText(distance)} from the shop's saved place.`
                : "The shop has no saved place yet."}
              <small className="muted"> Accurate to about {distanceText(fix.accuracy)}.</small>
            </p>
          ) : (
            <p>{place?.problem || "No place: the visit is kept without it."}</p>
          )}
        </div>
      </div>
      {far && (
        <ReasonPicker label="Why are you away from the shop?" choices={FAR_REASONS} value={farReason} onChange={setFarReason} />
      )}
      {!onBeat && (
        <ReasonPicker label={`${shop.name} is not on today's beat. Why this visit?`} choices={OFF_BEAT_REASONS} value={offBeatReason} onChange={setOffBeatReason} />
      )}
      {fix && !shop.place && (
        <label className="checkbox sl-check">
          <input type="checkbox" checked={savePlace} onChange={(e) => setSavePlace(e.target.checked)} />
          <span>
            Save this as the shop&apos;s place
            <small className="muted">{fix.accuracy > 50 ? `The phone is only sure to about ${distanceText(fix.accuracy)}: save it when you are at the shop's door.` : "Set once; the office can clear it."}</small>
          </span>
        </label>
      )}
      <ErrorMessage message={problem} />
    </Modal>
  );
}

// Quick reasons to tap, or one's own words.
function ReasonPicker({ label, choices, value, onChange }) {
  return (
    <fieldset className="sl-reasons">
      <legend>{label}</legend>
      <div className="sl-reason-chips">
        {choices.map((choice) => (
          <button key={choice} type="button" className={`sl-reason ${value === choice ? "is-active" : ""}`} aria-pressed={value === choice} onClick={() => onChange(choice)}>{choice}</button>
        ))}
      </div>
      <input type="text" maxLength={200} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Or say why in your own words" aria-label={label} />
    </fieldset>
  );
}

// Checking out with no order: why, from the fixed list ("Other" with a
// note), and the date they promised to pay, if they did.
export function NoOrderDialog({ shop, today, onSave, onClose }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [promisedOn, setPromisedOn] = useState("");
  const [promisedAmount, setPromisedAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const missing = !reason || (reason === "other" && !note.trim()) || (promisedAmount && !promisedOn);
  const save = async () => {
    setBusy(true);
    setProblem("");
    try {
      await onSave({ outcome: "no_order", noOrderReason: reason, note: note.trim() || null, promisedOn: promisedOn || null, promisedAmount: promisedAmount || null });
    } catch (err) {
      setProblem(err?.message || "This could not be kept on this phone.");
      setBusy(false);
    }
  };
  return (
    <Modal title="No order today" icon="minus" description={shop.name} onClose={onClose} width={500} className="sl-sheet"
      footer={<button type="button" className="button sl-wide" onClick={save} disabled={busy || missing}><Icon name="logout" size={16} /> Check out</button>}>
      <fieldset className="sl-reasons">
        <legend>Why no order?</legend>
        <div className="sl-reason-grid" role="radiogroup" aria-label="Why no order?">
          {NO_ORDER_REASONS.map((r) => (
            <button key={r.code} type="button" role="radio" aria-checked={reason === r.code} className={`sl-reason ${reason === r.code ? "is-active" : ""}`} onClick={() => setReason(r.code)}>{r.label}</button>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>{reason === "other" ? "What happened (needed)" : "Note (optional)"}</span>
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {Number(shop.balance) > 0 && (
        <div className="sl-two">
          <label className="field">
            <span>Promised to pay on</span>
            <input type="date" min={today} value={promisedOn} onChange={(e) => setPromisedOn(e.target.value)} />
          </label>
          <label className="field">
            <span>Amount promised ₹</span>
            <input type="number" inputMode="decimal" min="1" step="0.01" value={promisedAmount} onChange={(e) => setPromisedAmount(e.target.value)} />
          </label>
        </div>
      )}
      <ErrorMessage message={problem} />
    </Modal>
  );
}

// "End my day": the cash to hand over, a note, and the place.
export function EndDayDialog({ cash, cheques, upi, waiting, recordPlaces, onEnd, onClose }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const end = async () => {
    setBusy(true);
    setProblem("");
    try {
      const place = recordPlaces ? await locate({ waitMs: 6000 }) : null;
      await onEnd({ place: place?.latitude ? place : null, cashInHand: (cash / 100).toFixed(2), note: note.trim() || null });
    } catch (err) {
      setProblem(err?.message || "The day could not be ended on this phone.");
      setBusy(false);
    }
  };
  return (
    <Modal title="End my day" icon="moon" onClose={onClose} width={480} className="sl-sheet"
      footer={<button type="button" className="button sl-wide" onClick={end} disabled={busy}><Icon name="check" size={16} /> {busy ? "Ending…" : "End my day"}</button>}>
      <dl className="sl-handover">
        <div><dt>Cash to hand over</dt><dd>{money(cash / 100)}</dd></div>
        <div><dt>Cheques</dt><dd>{cheques.count} · {money(cheques.amount / 100)}</dd></div>
        <div><dt>UPI (already in the bank)</dt><dd>{money(upi / 100)}</dd></div>
      </dl>
      {waiting > 0 && (
        <p className="alert alert-notice">{waiting} {waiting === 1 ? "thing waits" : "things wait"} on this phone to be sent. {waiting === 1 ? "It goes" : "They go"} by itself when the connection is back; hand over the cash and cheques at the office as usual.</p>
      )}
      <p className="muted small">Your location is not recorded after this, until you start your next day.</p>
      <label className="field">
        <span>Note for the office (optional)</span>
        <textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <ErrorMessage message={problem} />
    </Modal>
  );
}

// A collection's receipt, to show the shop or share on WhatsApp (only with
// their consent to bills on WhatsApp, and a mobile to send it to).
export function ReceiptDialog({ business, shop, collection, salesperson, number, at, onClose }) {
  const text = receiptText({ business, shop: shop.name, collection, salesperson, number, at });
  const canShare = Boolean(shop.phone) && shop.bills_consent;
  return (
    <Modal title="Receipt" icon="receipt" description={number ? `Receipt ${number}` : "The number follows once it reaches the office"} onClose={onClose} width={480} className="sl-sheet"
      footer={
        <div className="sl-actions-row">
          {canShare && (
            <a className="button" href={whatsappLink(shop.phone, text)} target="_blank" rel="noopener noreferrer"><Icon name="message" size={16} /> Share on WhatsApp</a>
          )}
          <button type="button" className={`button ${canShare ? "button-secondary" : ""}`} onClick={onClose}>Done</button>
        </div>
      }>
      <div className="sl-receipt">
        <span className="sl-receipt-amount">{money(collection.amount)}</span>
        <pre className="sl-receipt-text">{text}</pre>
      </div>
      {!canShare && (
        <p className="muted small">
          {shop.phone ? `${shop.name} has not agreed to receive bills on WhatsApp: show the receipt on screen, or record their consent in their record.` : "No mobile number for this shop: show the receipt on screen."}
        </p>
      )}
    </Modal>
  );
}

