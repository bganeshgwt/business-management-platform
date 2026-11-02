// The guest's cart and orders on this device (pure rules, and the device's
// storage wrapped so a private window or blocked storage never breaks the
// page). tests/shop-cart.test.js checks them.
//
// A cart is kept per shop link: { lines, substitution, note, service }, each
// line { skuId, productId, name, unit, unitName, weighed, step, max, price,
// mrp, photo, quantity, substitution }. Its prices are the ones the guest
// saw; the shop checks them again before the order is placed, and any change
// is shown for the guest to accept (applyCheck).

const CART = (token) => `shop.cart.${token}`;
const MINE = "shop.mine";
const KEEP_DAYS = 60;

const storage = () => {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

const read = (key, fallback) => {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const write = (key, value) => {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the cart lives in the page until it is placed.
  }
};

export const emptyCart = () => ({ lines: [], substitution: "remove", note: "", service: null });

export function readCart(token) {
  const saved = read(CART(token), null);
  if (!saved || !Array.isArray(saved.lines)) return emptyCart();
  return { ...emptyCart(), ...saved, lines: saved.lines.filter((line) => line && line.skuId && line.quantity > 0) };
}

export const writeCart = (token, cart) => write(CART(token), cart);

export const clearCart = (token) => {
  try {
    storage()?.removeItem(CART(token));
  } catch {
    // Nothing to clear.
  }
};

const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

// The first quantity an Add button puts in the cart: one, or for a loose item
// a kilo, a litre or a metre (1,000 g or ml) when that much is there, else one step.
export function firstQuantity(variant) {
  if (!variant.weighed) return variant.max >= 1 ? 1 : 0;
  const one = ["g", "ml"].includes(variant.unit) ? 1000 : 1;
  return variant.max >= one ? one : variant.max >= variant.step ? variant.step : 0;
}

// The next quantity up or down, in the item's steps, never past what is in stock.
export function nextQuantity(variant, current, direction) {
  const step = variant.weighed ? variant.step : 1;
  const next = round3(Number(current || 0) + (direction > 0 ? step : -step));
  if (direction > 0) return next > variant.max ? Number(current || 0) : next;
  return next < step - 1e-9 ? 0 : next;
}

export const quantityOf = (cart, skuId) => cart.lines.find((line) => line.skuId === skuId)?.quantity || 0;

// The cart with this item at this quantity (0 takes it out).
export function setQuantity(cart, item, quantity) {
  const lines = cart.lines.filter((line) => line.skuId !== item.skuId);
  if (quantity > 0) {
    const old = cart.lines.find((line) => line.skuId === item.skuId);
    const line = {
      skuId: item.skuId, productId: item.productId, name: item.name, unit: item.unit, unitName: item.unitName, weighed: Boolean(item.weighed),
      step: item.step, max: item.max, price: item.price, mrp: item.mrp ?? null, photo: item.photo || null, quantity: round3(quantity),
      substitution: old?.substitution ?? null,
    };
    const at = cart.lines.findIndex((one) => one.skuId === item.skuId);
    if (at >= 0) lines.splice(at, 0, line);
    else lines.push(line);
  }
  return { ...cart, lines };
}

// "2", "About 500 g", "About 1.5 kg" — how a quantity reads on a line.
export function quantityWords(quantity, unit, weighed) {
  const value = Number(quantity);
  if (!weighed) return String(value);
  if (unit === "kg" && value < 1) return `About ${Math.round(value * 1000)} g`;
  if (unit === "litre" && value < 1) return `About ${Math.round(value * 1000)} ml`;
  if (unit === "g" && value >= 1000) return `About ${round3(value / 1000)} kg`;
  if (unit === "ml" && value >= 1000) return `About ${round3(value / 1000)} litre`;
  const words = { kg: "kg", g: "g", litre: value === 1 ? "litre" : "litres", ml: "ml", metre: value === 1 ? "metre" : "metres" };
  return `About ${round3(value)} ${words[unit] || unit}`;
}

// An amount in paise, as the shop works it out: price × quantity, to the paisa.
const amountOf = (price, quantity) => Math.round(Math.round(Number(price) * 100) * Number(quantity));

// The cart's figures on this device, as the shop works them out (the shop's
// check is the one that counts): { items, delivery, roundOff, total, allowance,
// moreForFree, moreForMinimum } in rupees.
export function cartFigures(cart, terms, service) {
  const items = cart.lines.reduce((sum, line) => sum + amountOf(line.price, line.quantity), 0);
  const delivery = service === "delivery" && terms?.delivery ? terms.delivery : null;
  const fee = delivery ? Math.round(delivery.fee * 100) : 0;
  const freeAbove = delivery && delivery.freeAbove !== null && delivery.freeAbove !== undefined ? Math.round(delivery.freeAbove * 100) : null;
  const charge = fee > 0 && !(freeAbove !== null && items >= freeAbove) ? fee : 0;
  const raw = items + charge;
  const total = terms?.roundsToRupee ? Math.floor((raw + 50) / 100) * 100 : raw;
  const allowance = cart.lines.filter((line) => line.weighed).reduce((sum, line) => sum + Math.floor(amountOf(line.price, line.quantity) / 10), 0);
  const minimum = delivery ? Math.round((delivery.minOrder || 0) * 100) : 0;
  return {
    count: cart.lines.length,
    items: items / 100,
    delivery: charge / 100,
    roundOff: (total - raw) / 100,
    total: total / 100,
    allowance: allowance / 100,
    moreForFree: delivery && fee > 0 && freeAbove !== null && items < freeAbove ? (freeAbove - items) / 100 : 0,
    moreForMinimum: delivery && minimum > 0 && items < minimum ? (minimum - items) / 100 : 0,
    hasWeighed: cart.lines.some((line) => line.weighed),
  };
}

// What changed since the guest put each item in the cart, in their words.
export function changeWords(line, money = (n) => `₹${n}`) {
  switch (line.problem) {
    case "gone": return `${line.name} is no longer sold online.`;
    case "out": return `${line.name} has just run out.`;
    case "less": return `Only ${quantityWords(line.quantity, line.unit, line.weighed).replace(/^About /, "")} of ${line.name} is left.`;
    case "price": return `${line.name} is now ${money(line.price)} (was ${money(line.seenPrice)}).`;
    case "quantity": return `${line.name} is sold in steps of ${line.step} ${line.unit}: changed to ${quantityWords(line.quantity, line.unit, line.weighed)}.`;
    default: return null;
  }
}

// The cart as the shop priced it: today's prices and what is in stock; gone and out-of-stock items taken out.
export function applyCheck(cart, check) {
  const byId = new Map((check.lines || []).map((line) => [line.skuId, line]));
  const lines = [];
  for (const line of cart.lines) {
    const now = byId.get(line.skuId);
    if (!now) { lines.push(line); continue; }
    if (now.problem === "gone" || now.problem === "out" || !(now.quantity > 0)) continue;
    lines.push({ ...line, name: now.name || line.name, price: now.price, mrp: now.mrp ?? null, max: now.max, step: now.step, weighed: now.weighed, unit: now.unit,
      unitName: now.unitName, photo: now.photo || line.photo, quantity: now.quantity });
  }
  return { ...cart, lines };
}

// Lines that came back to the cart with no price yet (an order being
// changed) take the shop's own from its check: price, steps, stock and photo.
export function fillPrices(cart, check) {
  if (!cart.lines.some((line) => line.price === null || line.price === undefined)) return cart;
  const byId = new Map((check.lines || []).map((line) => [line.skuId, line]));
  const lines = [];
  for (const line of cart.lines) {
    if (line.price !== null && line.price !== undefined) { lines.push(line); continue; }
    const now = byId.get(line.skuId);
    if (!now || now.problem === "gone" || now.problem === "out" || !(now.quantity > 0)) continue;
    lines.push({ ...line, name: now.name || line.name, price: now.price, mrp: now.mrp ?? null, max: now.max, step: now.step, weighed: now.weighed, unit: now.unit,
      unitName: now.unitName, photo: now.photo || null, productId: now.productId ?? line.productId, quantity: now.quantity });
  }
  return { ...cart, lines };
}

// The lines a check is asked for: what the guest saw.
export const checkLines = (cart) => cart.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity, price: line.price, name: line.name,
  ...(line.substitution ? { substitution: line.substitution } : {}) }));

// --- The orders placed from this device ---------------------------------------------------------

export function myOrders(now = Date.now()) {
  const list = read(MINE, []);
  return (Array.isArray(list) ? list : []).filter((entry) => entry && entry.guestToken && now - new Date(entry.placedAt).getTime() < KEEP_DAYS * 86400000)
    .sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt)));
}

export function rememberOrder(entry) {
  const list = myOrders().filter((one) => one.guestToken !== entry.guestToken);
  write(MINE, [entry, ...list].slice(0, 30));
}
