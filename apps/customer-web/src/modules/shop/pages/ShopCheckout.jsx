import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import GuestShell from "../../../shared/GuestShell";
import ConsentChoices from "../../../shared/ConsentChoices";
import { AddressFields, MobileField, NameField } from "../../../shared/fields";
import { addressProblem, mobileProblem, nameProblem, pinProblem } from "../../../shared/fieldRules";
import { GuestError, GuestSkeleton } from "../../../shared/GuestStates";
import { guestErrorMessage, newClientKey, refusalReason } from "../../../shared/publicClient";
import { ForgetDetails } from "../../privacy/GuestPrivacy";
import { checkCart, getShop, placeOrder } from "../services/shop.service";
import { applyCheck, changeWords, checkLines, clearCart, readCart, rememberOrder, writeCart } from "../services/shopCart";
import { BillLines } from "./ShopCart";
import { NotTaking, PolicyLink } from "./ShopParts";
import { dayWords, sellerExtras, SUBSTITUTIONS, timeWords, todayInIndia } from "../services/shopWords";

// Checkout: /shop/<link>/checkout. Pickup or delivery (the address, landmark
// and PIN code checked against the shop's area, and a delivery slot when the
// shop offers them), the guest's name and mobile, how they pay, what they
// agree to hear about (never ticked for them), and one total with every
// charge shown. "Place order" sends it once: a retry after the network
// dropped sends the same order again (its clientKey), never a second one.

const ME = "shop.me";
const readMe = () => {
  try { return JSON.parse(window.localStorage.getItem(ME) || "null") || {}; } catch { return {}; }
};
const writeMe = (me) => {
  try { window.localStorage.setItem(ME, JSON.stringify(me)); } catch { /* storage blocked: nothing kept */ }
};
const forgetMe = () => {
  try { window.localStorage.removeItem(ME); } catch { /* nothing to forget */ }
};

export default function ShopCheckout() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [cart, setCart] = useState(() => readCart(token));
  const [check, setCheck] = useState(null);
  const [me] = useState(readMe);
  const [name, setName] = useState(me.name || "");
  const [mobile, setMobile] = useState(me.mobile || "");
  const [address, setAddress] = useState(me.address || { address: "", landmark: "", pinCode: "" });
  const [paymentMode, setPaymentMode] = useState("");
  const [slot, setSlot] = useState(null);
  const [consents, setConsents] = useState([]);
  const [problems, setProblems] = useState({});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const keyFor = useRef({ body: null, key: null });

  useEffect(() => {
    getShop(token).then((answer) => { setPage(answer); document.title = `Checkout · ${answer.card?.name || "Shop"}`; }).catch(setError);
  }, [token]);

  const shop = page?.shop;
  const offered = shop ? [shop.pickup && "pickup", shop.delivery && "delivery"].filter(Boolean) : [];
  const service = offered.includes(cart.service) ? cart.service : offered[0] || "pickup";
  const modes = service === "pickup" ? ["pay_at_shop"] : [shop?.payments.cashOnDelivery && "cash_on_delivery", shop?.payments.upiOnDelivery && "upi_on_delivery"].filter(Boolean);
  const mode = modes.includes(paymentMode) ? paymentMode : modes[0];
  const sent = JSON.stringify(checkLines(cart));

  useEffect(() => {
    if (!page || !cart.lines.length || ["off", "not_taking_orders"].includes(page.shop.reason)) return;
    checkCart(token, { service, lines: JSON.parse(sent) }).then(setCheck).catch((err) => setSendError(guestErrorMessage(err, "the shop")));
  }, [token, page, service, sent, cart.lines.length]);

  if (!cart.lines.length && !sending) return <Navigate to={`/shop/${token}/cart`} replace />;
  if (error) return <GuestShell card={null}><GuestError heading="h1" title="Checkout did not open" message={guestErrorMessage(error, "the shop")} /></GuestShell>;
  if (!page) return <GuestShell card={null}><GuestSkeleton cards={3} label="Opening checkout" /></GuestShell>;
  if (["off", "not_taking_orders"].includes(shop.reason)) {
    return <GuestShell card={page.card} seller={sellerExtras(shop.seller)} context="Checkout"><NotTaking card={page.card} shop={shop} /></GuestShell>;
  }

  const delivery = service === "delivery";
  const pinOutside = delivery && /^[1-9]\d{5}$/.test(address.pinCode || "") && !shop.delivery.pins.includes(address.pinCode);
  const slots = delivery && shop.delivery.slots ? (check?.slots || []) : [];
  const today = todayInIndia();
  const totals = check?.totals || null;
  const changed = check?.changed ? check.lines.filter((line) => line.problem) : [];
  const setService = (next) => { const updated = { ...cart, service: next }; setCart(updated); writeCart(token, updated); setSlot(null); };

  const validate = () => {
    const found = {
      name: nameProblem(name),
      mobile: mobileProblem(mobile),
      ...(delivery ? { address: addressProblem(address.address), pinCode: pinProblem(address.pinCode) || (pinOutside ? `The shop delivers to ${shop.delivery.pins.join(", ")} only` : null) } : {}),
      ...(delivery && shop.delivery.slots && !slot ? { slot: "Choose a delivery slot" } : {}),
    };
    const left = Object.fromEntries(Object.entries(found).filter(([, value]) => value));
    setProblems(left);
    return Object.keys(left).length === 0;
  };

  const submit = async (event) => {
    event.preventDefault();
    setSendError("");
    if (!validate() || !totals) return;
    const body = {
      service, paymentMode: mode, name: name.trim(), mobile, lines: checkLines(cart), total: totals.total, substitution: cart.substitution, note: cart.note.trim() || null,
      ...(delivery ? { address: { address: address.address.trim(), landmark: address.landmark?.trim() || null, pinCode: address.pinCode } } : {}),
      ...(delivery && slot ? { slot: { date: slot.date, from: slot.from } } : {}),
      ...(consents.length && page.card.privacy ? { consents, privacyNoticeId: page.card.privacy.id } : {}),
    };
    // One order for one body: the same key again after a dropped connection, a new one for new details.
    const text = JSON.stringify(body);
    if (keyFor.current.body !== text) keyFor.current = { body: text, key: newClientKey() };
    setSending(true);
    try {
      const answer = await placeOrder(token, { ...body, clientKey: keyFor.current.key });
      writeMe({ name: body.name, mobile, ...(delivery ? { address: body.address } : me.address ? { address: me.address } : {}) });
      rememberOrder({ guestToken: answer.order.guestToken, orderNo: answer.order.orderNo, shopName: page.card?.name || "Shop", total: answer.order.totals.total,
        placedAt: answer.order.placedAt, service });
      clearCart(token);
      navigate(`/shop/status/${answer.order.guestToken}`, { replace: true, state: { placed: true } });
    } catch (err) {
      const reason = refusalReason(err);
      const data = err.response?.data?.data || {};
      if (reason === "cart_changed" && Array.isArray(data.lines)) setCheck({ ...check, lines: data.lines, changed: true, totals: data.totals || check?.totals });
      if ((reason === "slot_full" || reason === "slot_closed") && Array.isArray(data.slots)) { setCheck({ ...check, slots: data.slots }); setSlot(null); }
      if (data.field) setProblems((current) => ({ ...current, [data.field]: guestErrorMessage(err, "the shop") }));
      setSendError(guestErrorMessage(err, "the shop"));
      setSending(false);
    }
  };

  const byDay = slots.reduce((groups, one) => ({ ...groups, [one.date]: [...(groups[one.date] || []), one] }), {});
  return (
    <GuestShell card={page.card} seller={sellerExtras(shop.seller)} context="Checkout">
      <Link className="sp-back" to={`/shop/${token}/cart`}><Icon name="chevron-left" size={16} /> Back to the cart</Link>
      <h1 className="sp-title">Checkout</h1>
      {!shop.taking && <p className="sp-banner is-warning" role="status"><Icon name="clock" size={18} /> {shop.message}</p>}
      {changed.length > 0 && (
        <section className="sp-changes" role="alert">
          <h2><Icon name="alert-circle" size={18} /> Your cart has changed</h2>
          <ul>{changed.map((line) => <li key={line.skuId}>{changeWords(line, money)}</li>)}</ul>
          <button type="button" className="g-primary" onClick={() => { const next = applyCheck(cart, check); setCart(next); writeCart(token, next); }}>OK, update my cart</button>
        </section>
      )}
      <form className="sp-checkout" onSubmit={submit} noValidate>
        {offered.length > 1 && (
          <div className="sp-service" role="radiogroup" aria-label="Pickup or delivery">
            {offered.map((option) => (
              <button key={option} type="button" role="radio" aria-checked={service === option} className={`sp-service-option ${service === option ? "is-on" : ""}`} onClick={() => setService(option)}>
                <Icon name={option === "pickup" ? "store" : "truck"} size={18} />
                <span><strong>{option === "pickup" ? "Pickup" : "Delivery"}</strong>
                  <small>{option === "pickup" ? `Ready in about ${shop.pickup.minutes} min` : `As soon as possible, about ${shop.delivery.minutes} min`}</small></span>
              </button>
            ))}
          </div>
        )}
        {delivery ? (
          <>
            <AddressFields value={address} onChange={setAddress} errors={{ address: problems.address, pinCode: problems.pinCode || (pinOutside ? `The shop delivers to ${shop.delivery.pins.join(", ")} only. Choose pickup, or another address.` : null) }} />
            {shop.delivery.areaNote && <p className="sp-hint"><Icon name="map-pin" size={15} /> {shop.delivery.areaNote}</p>}
            {shop.delivery.slots ? (
              <fieldset className="sp-box sp-slots" aria-describedby={problems.slot ? "sp-slot-problem" : undefined}>
                <legend>When to deliver</legend>
                {Object.keys(byDay).length === 0 && <p className="sp-hint">No delivery slot is open now. Choose pickup, or try again later.</p>}
                {Object.entries(byDay).map(([date, list]) => (
                  <div key={date} className="sp-slot-day">
                    <span className="sp-slot-date">{dayWords(date, today)}</span>
                    <div className="sp-slot-list">
                      {list.map((one) => {
                        const on = slot && slot.date === one.date && slot.from === one.from;
                        return (
                          <button key={one.from} type="button" className={`sp-slot ${on ? "is-on" : ""}`} aria-pressed={on} disabled={!one.open} onClick={() => setSlot(one)}>
                            <strong>{timeWords(one.from)} – {timeWords(one.to)}</strong>
                            <small>{one.past ? "Closed" : one.left > 0 ? `${one.left} left` : "Full"}</small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {problems.slot && <small id="sp-slot-problem" className="gs-field-problem" role="alert">{problems.slot}</small>}
              </fieldset>
            ) : (
              <p className="sp-when"><Icon name="clock" size={16} /> As soon as possible: about {shop.delivery.minutes} minutes after the shop accepts it.</p>
            )}
          </>
        ) : (
          <p className="sp-when"><Icon name="clock" size={16} /> {shop.whenClosed || `Ready to collect about ${shop.pickup?.minutes} minutes after the shop accepts it.`}</p>
        )}
        {delivery && shop.whenClosed && <p className="sp-banner"><Icon name="clock" size={18} /> {shop.whenClosed}</p>}
        <fieldset className="gs-fields">
          <legend>Your details</legend>
          <NameField value={name} onChange={setName} error={problems.name} />
          <MobileField value={mobile} onChange={setMobile} error={problems.mobile} hint="The shop calls this number if anything needs your say." />
        </fieldset>
        {(me.name || me.mobile) && <ForgetDetails what={me.address ? "your name, mobile and address" : "your name and mobile"} onForget={() => { forgetMe(); setName(""); setMobile(""); setAddress({ address: "", landmark: "", pinCode: "" }); }} />}
        <fieldset className="sp-box">
          <legend>How you pay</legend>
          {modes.map((option) => (
            <label key={option} className="sp-radio">
              <input type="radio" name="payment" checked={mode === option} onChange={() => setPaymentMode(option)} />
              <span><strong>{option === "pay_at_shop" ? "Pay at the shop when you collect" : option === "cash_on_delivery" ? "Cash on delivery" : "UPI on delivery"}</strong>
                <small>{option === "upi_on_delivery" ? "Scan the shop's QR code on the order slip when it arrives." : option === "cash_on_delivery" ? "Keep the amount ready; the final amount is on your order's page once it is packed." : "Cash, UPI or card at the counter."}</small></span>
            </label>
          ))}
          <p className="sp-note-small">No money is taken online.</p>
        </fieldset>
        <p className="sp-hint"><Icon name="refresh" size={15} /> If an item has run out: {SUBSTITUTIONS.find(([value]) => value === cart.substitution)?.[1] || "Remove it"}. <Link to={`/shop/${token}/cart`}>Change</Link></p>
        <ConsentChoices privacy={page.card.privacy} value={consents} onChange={setConsents} businessName={page.card.name} />
        <section className="sp-box" aria-label="The bill">
          {totals ? <BillLines figures={totals} service={service} roundsToRupee={shop.roundsToRupee} upTo={totals.upTo} /> : <GuestSkeleton cards={1} lines={3} />}
          <p className="sp-note-small">One total, every charge shown. Prices include GST. Nothing is added later without your OK.</p>
        </section>
        {sendError && <p className="sp-banner is-warning" role="alert"><Icon name="alert-circle" size={18} /> {sendError}</p>}
        <button type="submit" className="g-primary g-block-button sp-go" disabled={sending || !totals || changed.length > 0 || !shop.taking}>
          {sending ? "Placing your order…" : `Place order · ${totals ? money(totals.total) : ""}`}
        </button>
        <p className="sp-note-small sp-center">{delivery ? "Pay on delivery" : "Pay at pickup"} · the shop accepts your order, packs it and tells you here.</p>
      </form>
      <PolicyLink policy={shop.policy} name={page.card?.name} />
    </GuestShell>
  );
}
