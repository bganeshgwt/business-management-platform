import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import GuestShell from "../../../shared/GuestShell";
import { GuestEmpty, GuestError, GuestSkeleton } from "../../../shared/GuestStates";
import { guestErrorMessage } from "../../../shared/publicClient";
import { checkCart, getShop } from "../services/shop.service";
import { applyCheck, cartFigures, changeWords, checkLines, fillPrices, nextQuantity, quantityWords, readCart, setQuantity, writeCart } from "../services/shopCart";
import { ItemPhoto, NotTaking, PolicyLink, Stepper } from "./ShopParts";
import { sellerExtras, SUBSTITUTIONS } from "../services/shopWords";

// The cart: /shop/<link>/cart. Each line to change or take out, what to do
// if an item has run out (the order's choice, and a line's own), a note for
// the shop, and the bill as it stands, every charge shown. The cart is checked
// with the shop as it opens and after each change: a price changed or an item
// run out since the guest added it is shown, for them to accept, before the
// order can go.


export function BillLines({ figures, service, roundsToRupee, upTo = null }) {
  return (
    <dl className="sp-bill">
      <div><dt>Items</dt><dd>{money(figures.items)}</dd></div>
      {service === "delivery" && <div><dt>Delivery charge</dt><dd>{figures.delivery > 0 ? money(figures.delivery) : "Free"}</dd></div>}
      {roundsToRupee && figures.roundOff !== 0 && <div><dt>Rounded off</dt><dd>{figures.roundOff > 0 ? "+" : "−"}{money(Math.abs(figures.roundOff))}</dd></div>}
      <div className="is-total"><dt>Total</dt><dd>{money(figures.total)}</dd></div>
      {upTo !== null && upTo > figures.total && (
        <p className="sp-bill-note">Weighed items are billed by what is packed: at most {money(upTo)} (10% more) without asking you.</p>
      )}
    </dl>
  );
}

export default function ShopCart() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [cart, setCartState] = useState(() => readCart(token));
  const [check, setCheck] = useState(null);
  const [checkError, setCheckError] = useState("");

  const setCart = useCallback((next) => { setCartState(next); writeCart(token, next); }, [token]);

  useEffect(() => {
    getShop(token).then((answer) => { setPage(answer); document.title = `Your cart · ${answer.card?.name || "Shop"}`; }).catch(setError);
  }, [token]);

  const shop = page?.shop;
  const offered = shop ? [shop.pickup && "pickup", shop.delivery && "delivery"].filter(Boolean) : [];
  const service = offered.includes(cart.service) ? cart.service : offered[0] || "pickup";

  // Checked with the shop a moment after each change.
  const sent = JSON.stringify(checkLines(cart));
  useEffect(() => {
    if (!page || !cart.lines.length || ["off", "not_taking_orders"].includes(page.shop.reason)) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      checkCart(token, { service, lines: JSON.parse(sent) })
        .then((answer) => {
          if (!alive) return;
          setCheck(answer);
          setCheckError("");
          // Items back from an order being changed take today's prices first.
          const filled = fillPrices(cart, answer);
          if (filled !== cart) setCart(filled);
        })
        .catch((err) => alive && setCheckError(guestErrorMessage(err, "the shop")));
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, page, sent, service, cart.lines.length]);

  const figures = useMemo(() => (shop ? cartFigures(cart, shop, service) : null), [cart, shop, service]);
  const changes = check?.changed ? check.lines.filter((line) => line.problem && cart.lines.some((one) => one.skuId === line.skuId && one.price !== null)) : [];

  if (error) return <GuestShell card={null}><GuestError heading="h1" title="The cart did not open" message={guestErrorMessage(error, "the shop")} /></GuestShell>;
  if (!page) return <GuestShell card={null}><GuestSkeleton cards={3} label="Opening your cart" /></GuestShell>;
  if (["off", "not_taking_orders"].includes(shop.reason)) {
    return <GuestShell card={page.card} seller={sellerExtras(shop.seller)} context="Your cart"><NotTaking card={page.card} shop={shop} /></GuestShell>;
  }
  const back = <Link className="sp-back" to={`/shop/${token}`}><Icon name="chevron-left" size={16} /> Keep shopping</Link>;
  if (!cart.lines.length) {
    return (
      <GuestShell card={page.card} seller={sellerExtras(shop.seller)} context="Your cart">
        {back}
        <GuestEmpty heading="h1" icon="box" title="Your cart is empty" action={<Link className="g-primary" to={`/shop/${token}`}>Start shopping</Link>}>
          Add what you need from the shop; it stays here on this phone until you order.
        </GuestEmpty>
      </GuestShell>
    );
  }
  const blocked = changes.length > 0;
  const belowMinimum = service === "delivery" && figures.moreForMinimum > 0;
  return (
    <GuestShell card={page.card} seller={sellerExtras(shop.seller)} context="Your cart">
      {back}
      <h1 className="sp-title">Your cart</h1>
      {offered.length > 1 && (
        <div className="sp-service" role="radiogroup" aria-label="Pickup or delivery">
          {offered.map((option) => (
            <button key={option} type="button" role="radio" aria-checked={service === option} className={`sp-service-option ${service === option ? "is-on" : ""}`}
              onClick={() => setCart({ ...cart, service: option })}>
              <Icon name={option === "pickup" ? "store" : "truck"} size={18} />
              <span><strong>{option === "pickup" ? "Pickup" : "Delivery"}</strong>
                <small>{option === "pickup" ? `Ready in about ${shop.pickup.minutes} min` : shop.delivery.fee > 0 ? `${money(shop.delivery.fee)}${shop.delivery.freeAbove ? `, free above ${money(shop.delivery.freeAbove)}` : ""}` : "Free"}</small></span>
            </button>
          ))}
        </div>
      )}
      {blocked && (
        <section className="sp-changes" role="alert">
          <h2><Icon name="alert-circle" size={18} /> Your cart has changed since you added these</h2>
          <ul>{changes.map((line) => <li key={line.skuId}>{changeWords(line, money)}</li>)}</ul>
          <button type="button" className="g-primary" onClick={() => setCart(applyCheck(cart, check))}>OK, update my cart</button>
        </section>
      )}
      {checkError && <p className="sp-banner is-warning" role="alert"><Icon name="alert-circle" size={18} /> {checkError}</p>}
      <ul className="sp-lines">
        {cart.lines.map((line) => {
          const item = { ...line };
          const amount = Math.round(Math.round(line.price * 100) * line.quantity) / 100;
          return (
            <li key={line.skuId} className="sp-line">
              <ItemPhoto photo={line.photo} name={line.name} />
              <div className="sp-line-text">
                <strong>{line.name}</strong>
                <span className="sp-line-sub">
                  {line.price === null ? "Checking today's price…" : `${money(line.price)}${line.weighed ? ` per ${line.unit} · weighed when packed` : " each"}`}
                </span>
                <label className="sp-line-sub sp-line-choice">
                  <span>If it runs out</span>
                  <select value={line.substitution || ""} onChange={(event) => setCart({ ...cart, lines: cart.lines.map((one) => (one.skuId === line.skuId ? { ...one, substitution: event.target.value || null } : one)) })}>
                    <option value="">As for the order</option>
                    {SUBSTITUTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
              <div className="sp-line-side">
                <Stepper small value={line.quantity} label={line.weighed ? quantityWords(line.quantity, line.unit, true).replace(/^About /, "") : line.quantity}
                  onDown={() => setCart(setQuantity(cart, item, nextQuantity(item, line.quantity, -1)))}
                  onUp={() => setCart(setQuantity(cart, item, nextQuantity(item, line.quantity, 1)))} canUp={nextQuantity(item, line.quantity, 1) !== line.quantity} />
                <strong className="sp-line-amount">{line.weighed ? "about " : ""}{money(amount)}</strong>
                <button type="button" className="sp-remove" onClick={() => setCart(setQuantity(cart, item, 0))} aria-label={`Take ${line.name} out`}>
                  <Icon name="trash" size={15} /> Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <fieldset className="sp-box">
        <legend>If an item has run out</legend>
        {SUBSTITUTIONS.map(([value, label, hint]) => (
          <label key={value} className="sp-radio">
            <input type="radio" name="substitution" value={value} checked={cart.substitution === value} onChange={() => setCart({ ...cart, substitution: value })} />
            <span><strong>{label}</strong><small>{hint}</small></span>
          </label>
        ))}
      </fieldset>
      <label className="sp-box sp-note-field">
        <span>Note for the shop <em>optional</em></span>
        <textarea rows={2} maxLength={500} value={cart.note} onChange={(event) => setCart({ ...cart, note: event.target.value })} placeholder="Ripe bananas please, no plastic bags…" />
      </label>
      <section className="sp-box" aria-label="The bill">
        <BillLines figures={figures} service={service} roundsToRupee={shop.roundsToRupee} upTo={figures.hasWeighed ? figures.total + figures.allowance : null} />
        {service === "delivery" && figures.moreForFree > 0 && <p className="sp-hint"><Icon name="truck" size={15} /> Add {money(figures.moreForFree)} more for free delivery.</p>}
        {belowMinimum && <p className="sp-hint is-warning"><Icon name="info" size={15} /> Delivery is for orders of {money(shop.delivery.minOrder)} or more: add {money(figures.moreForMinimum)} more, or choose pickup.</p>}
        <p className="sp-note-small">No member prices, offers or coupons online. Prices include GST.</p>
      </section>
      <button type="button" className="g-primary g-block-button sp-go" disabled={blocked || belowMinimum} onClick={() => navigate(`/shop/${token}/checkout`)}>
        Checkout · {money(figures.total)} <Icon name="chevron-right" size={16} />
      </button>
      <PolicyLink policy={shop.policy} name={page.card?.name} />
    </GuestShell>
  );
}
