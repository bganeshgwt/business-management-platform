import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import GuestShell from "../../../shared/GuestShell";
import { GuestError, GuestSkeleton } from "../../../shared/GuestStates";
import { guestErrorMessage } from "../../../shared/publicClient";
import { getItem, getItems, getShop } from "../services/shop.service";
import { cartFigures, firstQuantity, nextQuantity, quantityOf, quantityWords, readCart, setQuantity, writeCart } from "../services/shopCart";
import { CartGlyph, ItemPhoto, NotTaking, PolicyLink, Price, Sheet, Stepper } from "./ShopParts";
import { sellerExtras } from "../services/shopWords";

// A shop's online shop: /shop/<link>. The business band (open now, its
// phone, directions), what pickup and delivery cost, a search that answers as
// the guest types, the categories, and every item that shows online: its
// photo or initials, pack, price with the MRP struck and the saving, how many
// are left. Add puts it in the cart (kept on this phone, per shop); an item
// with sizes, colours or packs opens its page to choose. The cart bar stays at
// the foot: how many, the total, and what is still needed for free delivery.

const lineName = (card, variant) => (variant.label && variant.label !== card.name ? `${card.name} · ${variant.label}` : card.name);
const asItem = (card, variant) => ({ ...variant, productId: card.productId, name: lineName(card, variant), photo: card.photo });
const stockWords = (variant) => (variant.stock === "out" ? "Out of stock" : variant.stock === "low" ? `Only ${quantityWords(variant.left, variant.unit, variant.weighed).replace(/^About /, "")} left` : null);

function AddButton({ card, variant, cart, onChange }) {
  const quantity = quantityOf(cart, variant.skuId);
  const item = asItem(card, variant);
  if (variant.max <= 0) return <button type="button" className="g-add sp-add" disabled>Sold out</button>;
  if (!quantity) {
    return (
      <button type="button" className="g-add sp-add" onClick={() => onChange(setQuantity(cart, item, firstQuantity(variant)))} aria-label={`Add ${item.name}`}>
        Add <Icon name="plus" size={14} />
      </button>
    );
  }
  return (
    <span className="g-add-stepper sp-add">
      <Stepper small value={quantity} label={variant.weighed ? quantityWords(quantity, variant.unit, true).replace(/^About /, "") : quantity}
        onDown={() => onChange(setQuantity(cart, item, nextQuantity(variant, quantity, -1)))}
        onUp={() => onChange(setQuantity(cart, item, nextQuantity(variant, quantity, 1)))} canUp={nextQuantity(variant, quantity, 1) !== quantity} />
    </span>
  );
}

function ItemCard({ card, cart, onChange, onOpen }) {
  const single = card.variants.length === 1;
  const variant = card.variants[0];
  const words = single ? stockWords(variant) : null;
  return (
    <li className="sp-card">
      <button type="button" className="sp-card-open" onClick={() => onOpen(card.productId)} aria-label={`About ${card.name}`}>
        <ItemPhoto photo={card.photo} name={card.name} />
      </button>
      <div className="sp-card-body">
        <button type="button" className="sp-card-name" onClick={() => onOpen(card.productId)}>{card.name}</button>
        <span className="sp-card-pack">{single ? (variant.label !== card.name ? variant.label : variant.netQuantity || (variant.weighed ? `Loose, by the ${variant.unit}` : "")) : `${card.variants.length} options`}</span>
        <div className="sp-card-foot">
          {single ? <Price price={variant.price} mrp={variant.mrp} unit={variant.unit} weighed={variant.weighed} size="sm" />
            : <span className="sp-price is-sm">{card.samePrice ? <strong>{money(card.fromPrice)}</strong> : <><span className="sp-from">from</span> <strong>{money(card.fromPrice)}</strong></>}</span>}
          {single ? <AddButton card={card} variant={variant} cart={cart} onChange={onChange} />
            : <button type="button" className="g-add sp-add" onClick={() => onOpen(card.productId)}>Choose</button>}
        </div>
        {words && <span className={`sp-stock ${variant.stock === "out" ? "is-out" : "is-low"}`}>{words}</span>}
      </div>
    </li>
  );
}

// An item's own page, over the shop: its photo, every option, the
// declarations a packaged product carries, and its unit price.
function ItemSheet({ token, productId, cart, onChange, onClose }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(null);
  useEffect(() => {
    let alive = true;
    getItem(token, productId)
      .then((answer) => { if (alive) { setItem(answer); setChosen(answer.variants.find((v) => v.max > 0)?.skuId ?? answer.variants[0]?.skuId); } })
      .catch((err) => alive && setError(guestErrorMessage(err, "the shop")));
    return () => { alive = false; };
  }, [token, productId]);
  const variant = item?.variants.find((v) => v.skuId === chosen) || null;
  return (
    <Sheet title={item ? item.name : "Item"} onClose={onClose} wide
      footer={variant && (
        <div className="sp-sheet-buy">
          <Price price={variant.price} mrp={variant.mrp} unit={variant.unit} weighed={variant.weighed} size="lg" />
          <AddButton card={item} variant={variant} cart={cart} onChange={onChange} />
        </div>
      )}>
      {error && <GuestError message={error} />}
      {!item && !error && <GuestSkeleton cards={1} lines={4} />}
      {item && (
        <div className="sp-item">
          <ItemPhoto photo={item.photo} name={item.name} large />
          <div className="sp-item-text">
            {item.brand && <span className="sp-item-brand">{item.brand}</span>}
            {item.description && <p className="sp-item-description">{item.description}</p>}
            {item.variants.length > 1 && (
              <fieldset className="sp-options">
                <legend>Choose</legend>
                <div className="sp-option-list">
                  {item.variants.map((one) => (
                    <button key={one.skuId} type="button" className={`sp-option ${one.skuId === chosen ? "is-on" : ""}`} aria-pressed={one.skuId === chosen}
                      disabled={one.max <= 0} onClick={() => setChosen(one.skuId)}>
                      <strong>{[one.size, one.colour].filter(Boolean).join(" · ") || one.label}</strong>
                      <span>{money(one.price)}{one.max <= 0 ? " · out of stock" : ""}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            {variant && (
              <ul className="sp-item-facts">
                {stockWords(variant) && <li className={variant.stock === "out" ? "is-out" : "is-low"}><Icon name="box" size={15} /> {stockWords(variant)}</li>}
                {variant.unitSalePrice && <li><Icon name="scale" size={15} /> {money(variant.unitSalePrice.amount)} per {variant.unitSalePrice.per}</li>}
                {variant.weighed && <li><Icon name="scale" size={15} /> Weighed when packed: you pay for what is packed, and are told the final amount</li>}
                {variant.mrp && <li><Icon name="tag" size={15} /> MRP {money(variant.mrp)} (incl. of all taxes)</li>}
              </ul>
            )}
            {item.declarations.length > 0 && (
              <dl className="sp-declarations">
                {item.declarations.map((row) => (
                  <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
                ))}
              </dl>
            )}
            <p className="sp-note-small">Prices include GST. No member prices, offers or coupons online.</p>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export default function ShopHome() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [cart, setCartState] = useState(() => readCart(token));
  const [typed, setTyped] = useState("");
  const [filters, setFilters] = useState({ q: "", category: "", country: "", sort: "" });
  const [list, setList] = useState(null);
  const [listError, setListError] = useState("");
  const [more, setMore] = useState(false);
  const firstList = useRef(true);
  const opened = params.get("item");

  const setCart = useCallback((next) => { setCartState(next); writeCart(token, next); }, [token]);

  useEffect(() => {
    let alive = true;
    getShop(token)
      .then((answer) => {
        if (!alive) return;
        setPage(answer);
        setList(answer.items);
        document.title = `${answer.card?.name || "Shop"} · Order online`;
      })
      .catch((err) => alive && setError(err));
    return () => { alive = false; };
  }, [token, attempt]);

  // The search answers as the guest types (a quarter second after the last key).
  useEffect(() => {
    const timer = setTimeout(() => setFilters((current) => (current.q === typed.trim() ? current : { ...current, q: typed.trim() })), 250);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    if (!page || !page.shop.taking && ["off", "not_taking_orders"].includes(page.shop.reason)) return undefined;
    if (firstList.current) { firstList.current = false; return undefined; }
    const controller = new AbortController();
    setListError("");
    getItems(token, filters, controller.signal)
      .then(setList)
      .catch((err) => { if (!controller.signal.aborted) setListError(guestErrorMessage(err, "the shop")); });
    return () => controller.abort();
  }, [token, filters, page]);

  const loadMore = async () => {
    setMore(true);
    try {
      const next = await getItems(token, { ...filters, page: list.page + 1 });
      setList((current) => ({ ...next, items: [...current.items, ...next.items] }));
    } catch (err) {
      setListError(guestErrorMessage(err, "the shop"));
    } finally {
      setMore(false);
    }
  };

  const shop = page?.shop;
  const service = cart.service || (shop?.pickup ? "pickup" : "delivery");
  const figures = useMemo(() => (shop ? cartFigures(cart, shop, service) : null), [cart, shop, service]);
  const forDelivery = useMemo(() => (shop?.delivery ? cartFigures(cart, shop, "delivery") : null), [cart, shop]);
  const openItem = (productId) => setParams((current) => { const next = new URLSearchParams(current); next.set("item", String(productId)); return next; });
  const closeItem = () => setParams((current) => { const next = new URLSearchParams(current); next.delete("item"); return next; }, { replace: true });

  if (error) {
    const missing = error.response?.status === 404;
    return (
      <GuestShell card={null}>
        <GuestError heading="h1" title={missing ? "This shop link does not open" : "The shop did not open"} message={guestErrorMessage(error, "the shop")}
          onRetry={missing ? null : () => { setError(""); setAttempt((n) => n + 1); }} icon={missing ? "link" : "alert-circle"} />
      </GuestShell>
    );
  }
  if (!page) {
    return (
      <GuestShell card={null} wide>
        <GuestSkeleton cards={4} lines={3} label="Opening the shop" />
      </GuestShell>
    );
  }
  if (["off", "not_taking_orders"].includes(shop.reason)) {
    return (
      <GuestShell card={page.card} seller={sellerExtras(shop.seller)} context="Online shop">
        <NotTaking card={page.card} shop={shop} />
        <PolicyLink policy={shop.policy} name={page.card?.name} />
      </GuestShell>
    );
  }
  const searching = Boolean(filters.q || filters.category || filters.country);
  return (
    <GuestShell card={page.card} seller={sellerExtras(shop.seller)} context="Online shop" wide
      actions={<Link className="g-pill sp-mine-link" to="/shop" aria-label="Your orders"><Icon name="receipt" size={16} /><span className="g-hide-narrow">Your orders</span></Link>}>
      <section className="sp-terms" aria-label="Pickup, delivery and paying">
        {shop.pickup && <span className="sp-term"><Icon name="store" size={15} /> Pickup · ready in about {shop.pickup.minutes} min</span>}
        {shop.delivery && (
          <span className="sp-term"><Icon name="truck" size={15} /> Delivery {shop.delivery.fee > 0 ? `${money(shop.delivery.fee)}` : "free"}
            {shop.delivery.fee > 0 && shop.delivery.freeAbove ? ` · free above ${money(shop.delivery.freeAbove)}` : ""}</span>
        )}
        {shop.delivery && shop.delivery.minOrder > 0 && <span className="sp-term"><Icon name="receipt" size={15} /> Delivery for orders of {money(shop.delivery.minOrder)} or more</span>}
        <span className="sp-term"><Icon name="money" size={15} /> Pay {shop.pickup ? "at the shop" : ""}{shop.pickup && shop.delivery ? " or " : ""}{shop.delivery ? "on delivery" : ""}</span>
      </section>
      {!shop.taking && <p className="sp-banner is-warning" role="status"><Icon name="clock" size={18} /> {shop.message}</p>}
      {shop.taking && shop.whenClosed && <p className="sp-banner" role="status"><Icon name="clock" size={18} /> {shop.whenClosed}</p>}
      {shop.note && <p className="sp-banner is-note"><Icon name="info" size={18} /> {shop.note}</p>}

      <div className="sp-tools">
        <label className="g-search sp-search">
          <Icon name="search" size={18} />
          <input type="search" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Search atta, butter, rice…" aria-label="Search the shop" enterKeyHint="search" />
          {typed && <button type="button" className="sp-clear" onClick={() => setTyped("")} aria-label="Clear the search"><Icon name="x" size={16} /></button>}
        </label>
        {(page.countries.length > 0 || list?.total > 6) && (
          <div className="sp-selects">
            {page.countries.length > 0 && (
              <label className="sp-select">
                <span>Made in</span>
                <select value={filters.country} onChange={(event) => setFilters((current) => ({ ...current, country: event.target.value }))}>
                  <option value="">Anywhere</option>
                  <option value="India">India</option>
                  {page.countries.map((country) => <option key={country.name} value={country.name}>{country.name} ({country.count})</option>)}
                </select>
              </label>
            )}
            <label className="sp-select">
              <span>Sort</span>
              <select value={filters.sort} onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value }))}>
                <option value="">Name</option>
                <option value="price_low">Price: low to high</option>
                <option value="price_high">Price: high to low</option>
                {page.countries.length > 0 && <option value="country">Country of origin</option>}
              </select>
            </label>
          </div>
        )}
      </div>
      {page.categories.length > 0 && (
        <nav className="g-chips sp-chips" aria-label="Categories">
          <button type="button" className={`g-chip ${!filters.category ? "is-active" : ""}`} aria-pressed={!filters.category} onClick={() => setFilters((current) => ({ ...current, category: "" }))}>All</button>
          {page.categories.map((category) => (
            <button key={category.id} type="button" className={`g-chip ${String(filters.category) === String(category.id) ? "is-active" : ""}`}
              aria-pressed={String(filters.category) === String(category.id)} onClick={() => setFilters((current) => ({ ...current, category: String(category.id) }))}>
              {category.name}
            </button>
          ))}
        </nav>
      )}

      {listError && <GuestError message={listError} onRetry={() => setFilters((current) => ({ ...current }))} />}
      {list && list.items.length === 0 && (
        <section className="sp-empty">
          <Icon name="search" size={26} />
          <h2>{searching ? "Nothing matches that" : "Nothing to order online yet"}</h2>
          <p>{searching ? "Try another word, or look in All." : "The shop has not put anything online yet. Please call them to order."}</p>
        </section>
      )}
      {list && list.items.length > 0 && (
        <>
          <ul className="sp-grid" aria-label={searching ? "Search results" : "Items"}>
            {list.items.map((card) => <ItemCard key={card.productId} card={card} cart={cart} onChange={setCart} onOpen={openItem} />)}
          </ul>
          {list.page < list.pages && (
            <button type="button" className="g-secondary sp-more" onClick={loadMore} disabled={more}>
              {more ? "Loading…" : `Show more (${list.items.length} of ${list.total})`}
            </button>
          )}
        </>
      )}
      <p className="sp-note-small sp-center">Prices include GST and are the shop&apos;s own. No member prices, offers or coupons online.</p>
      <PolicyLink policy={shop.policy} name={page.card?.name} />

      {figures && figures.count > 0 && (
        <div className="sp-cartbar" role="region" aria-label="Your cart">
          <div className="sp-cartbar-inner">
            <span className="sp-cartbar-count"><CartGlyph /> {figures.count} {figures.count === 1 ? "item" : "items"}</span>
            <span className="sp-cartbar-text">
              <strong>{money(figures.items)}</strong>
              {forDelivery && forDelivery.moreForFree > 0 && <small>{money(forDelivery.moreForFree)} more for free delivery</small>}
              {forDelivery && !forDelivery.moreForFree && shop.delivery?.fee > 0 && shop.delivery?.freeAbove && <small>Free delivery unlocked</small>}
            </span>
            <button type="button" className="g-primary sp-cartbar-go" onClick={() => navigate(`/shop/${token}/cart`)}>
              View cart <Icon name="chevron-right" size={16} />
            </button>
          </div>
        </div>
      )}
      {opened && <ItemSheet token={token} productId={opened} cart={cart} onChange={setCart} onClose={closeItem} />}
    </GuestShell>
  );
}
