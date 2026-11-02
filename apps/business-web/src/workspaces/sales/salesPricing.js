// The salesperson app's prices, worked out on the phone from the day's pack,
// step for step as the server prices an order line (priceLine in
// backend/src/modules/business/wholesale/services/businessWholesale.service.js):
//
//   the scheme the line reaches (the biggest; one marked "don't combine with
//   slab prices" prices it without quantity slabs) → the shop's own price, else
//   its price group's, else a slab for every customer, else the list price →
//   the scheme's discount → GST (on top, or inside the price) → the free goods.
//
// So the total the phone shows is the total the server makes, unless a price
// changed after the pack was read: the server prices every order again, and
// says so when it differs. Money is integer paise (BigInt where quantities
// multiply), quantities thousandths. Kept free of React, the API and the
// browser: tests/sales-app.test.js runs it, and the backend's integration test
// checks it against the server's own prices.

const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const lineTax = (net, rate) => roundedDivide(BigInt(net) * BigInt(paise(rate)), 10000n);
const inclusiveNet = (gross, rate) => roundedDivide(BigInt(gross) * 10000n, 10000n + BigInt(paise(rate)));
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Number(a) === Number(b);

// The pack's prices, indexed for pricing: items by id; price rules, schemes
// by item; group prices by group and item. `extra`: what a shop looked up off
// the beat brought ({ price_rules, group_prices }).
export function pricingIndex(pack, extra = []) {
  const items = new Map((pack?.items || []).map((item) => [Number(item.id), item]));
  const rules = new Map();
  const groupPrices = new Map();
  const schemes = new Map();
  const seenRules = new Set();
  const seenGroups = new Set();
  const add = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };
  for (const source of [pack, ...extra]) {
    for (const rule of source?.price_rules || []) {
      if (seenRules.has(rule.id)) continue;
      seenRules.add(rule.id);
      add(rules, Number(rule.sku_id), rule);
    }
    for (const row of source?.group_prices || []) {
      if (seenGroups.has(row.id)) continue;
      seenGroups.add(row.id);
      add(groupPrices, `${row.group_id}:${row.sku_id}`, row);
    }
  }
  // In the server's order: the biggest "buy" first, then the oldest.
  for (const scheme of pack?.schemes || []) add(schemes, Number(scheme.sku_id), scheme);
  for (const list of schemes.values()) list.sort((a, b) => Number(b.buy_quantity) - Number(a.buy_quantity) || Number(a.id) - Number(b.id));
  return { items, rules, groupPrices, schemes, rulesOn: Boolean(pack?.settings?.rules_on), taxMode: pack?.settings?.tax_mode || "exclusive" };
}

const inForce = (row, day) => row.valid_from <= day && (!row.valid_to || row.valid_to >= day);

// The scheme a line qualifies for, with the free goods it earns in the stock
// unit: { scheme, freeMilli, freeSkuId?, freeEntered, discount, noSlab } or null.
export function schemeFor(index, groupId, sku, quantityMilli, day) {
  const list = (index.schemes.get(Number(sku.id)) || []).filter((x) => inForce(x, day) && (x.group_id === null || x.group_id === undefined || same(x.group_id, groupId)));
  for (const scheme of list) {
    const factorMicro = scheme.unit_code ? Math.round(Number(scheme.quantity_in_base) * 1e6) : 1000000;
    if (!factorMicro) continue;
    const inUnitMilli = Math.floor((quantityMilli * 1000000) / factorMicro);
    const times = Math.floor(inUnitMilli / milli(scheme.buy_quantity));
    if (times < 1) continue;
    const freeInUnitMilli = times * milli(scheme.free_quantity);
    if (scheme.free_sku_id && Number(scheme.free_sku_id) !== Number(sku.id)) {
      const freeFactor = scheme.free_unit_code ? Math.round(Number(scheme.free_in_base) * 1e6) : 1000000;
      const freeMilli = Number((BigInt(freeInUnitMilli) * BigInt(freeFactor)) / 1000000n);
      return { scheme, freeMilli, freeSkuId: Number(scheme.free_sku_id), discount: Number(scheme.discount_percent), noSlab: Boolean(scheme.no_slab),
        freeEntered: scheme.free_unit_code && freeInUnitMilli ? { unit: scheme.free_unit_code, quantity: freeInUnitMilli / 1000, factorMicro: freeFactor } : null };
    }
    const freeMilli = Number((BigInt(freeInUnitMilli) * BigInt(factorMicro)) / 1000000n);
    return { scheme, freeMilli, freeEntered: scheme.unit_code && freeInUnitMilli ? { unit: scheme.unit_code, quantity: freeInUnitMilli / 1000, factorMicro } : null,
      discount: Number(scheme.discount_percent), noSlab: Boolean(scheme.no_slab) };
  }
  return null;
}

// The shop's own price or a slab (only while price lists are on), else the
// list price: { rule, net (paise), stockPrice (rupees), enteredPrice (paise) }.
function salePrice(index, contactId, sku, quantity, entered, rulesOn) {
  let rule = null;
  if (rulesOn) {
    const found = (index.rules.get(Number(sku.id)) || []).filter((r) => (r.contact_id === null || same(r.contact_id, contactId))
      && ((r.unit_code === null && Number(r.minimum_quantity) <= quantity)
        || (r.unit_code !== null && entered && r.unit_code === entered.unit && Number(r.minimum_quantity) <= entered.quantity)));
    found.sort((a, b) => Number(b.contact_id !== null) - Number(a.contact_id !== null) || Number(b.unit_code !== null) - Number(a.unit_code !== null)
      || Number(b.minimum_quantity) - Number(a.minimum_quantity));
    rule = found[0] || null;
  }
  if (rule?.unit_code && entered) {
    const enteredPrice = paise(rule.unit_price);
    const net = roundedDivide(BigInt(enteredPrice) * BigInt(milli(entered.quantity)), 1000n);
    return { rule, net, stockPrice: Number(((enteredPrice / 100) / (entered.factorMicro / 1e6)).toFixed(4)), enteredPrice };
  }
  const price = rule ? Number(rule.unit_price) : Number(sku.price);
  const net = roundedDivide(BigInt(paise(price)) * BigInt(milli(quantity)), 1000n);
  const enteredPrice = entered ? roundedDivide(BigInt(paise(price)) * BigInt(entered.factorMicro), 1000000n) : null;
  return { rule, net, stockPrice: price, enteredPrice };
}

// The group price that beats the slab for all customers, if any. baseOnly: a
// scheme that does not stack on slabs takes only the group's price from one
// unit or one pack.
function groupPrice(index, groupId, sku, quantity, entered, day, baseOnly) {
  if (!groupId) return null;
  const found = (index.groupPrices.get(`${groupId}:${sku.id}`) || []).filter((g) => inForce(g, day)
    && ((g.unit_code === null && Number(g.minimum_quantity) <= quantity)
      || (g.unit_code !== null && g.unit_code === (entered?.unit || null) && Number(g.minimum_quantity) <= (entered?.quantity ?? 0)))
    && (!baseOnly || Number(g.minimum_quantity) <= 1));
  found.sort((a, b) => Number(b.unit_code !== null) - Number(a.unit_code !== null) || Number(b.minimum_quantity) - Number(a.minimum_quantity));
  return found[0] || null;
}

// One line, as { skuId, quantity, unit? } (unit: one of the item's pack
// sizes; left out, the stock unit). ctx: { contactId, groupId, day }.
// Returns { sku, quantity, entered, net, tax, total, source, discount,
// scheme, free, otherFree } in paise, or { error } when the phone cannot
// price it (an item no longer in the pack, a pack it does not have).
export function priceLine(index, ctx, input) {
  const sku = index.items.get(Number(input?.skuId));
  if (!sku) return { error: "This item is not in the day's copy of the catalogue: refresh it when online" };
  const asked = Number(input.quantity);
  if (!Number.isFinite(asked) || asked <= 0) return { error: "Enter a quantity" };
  let quantity, entered = null, factorMicro = 1000000;
  if (input.unit && input.unit !== sku.unit) {
    const pack = (sku.pack_sizes || []).find((p) => p.unit_code === input.unit);
    if (!pack) return { error: `${sku.label} has no pack size in ${input.unit}` };
    factorMicro = Math.round(Number(pack.quantity_in_base) * 1e6);
    const base = BigInt(milli(asked)) * BigInt(factorMicro);
    if (base % 1000000n !== 0n) return { error: `${asked} ${input.unit} does not make an exact quantity in ${sku.unit_name || sku.unit}` };
    quantity = Number(base / 1000000n) / 1000;
    entered = { unit: input.unit, quantity: asked };
  } else {
    quantity = asked;
  }
  if (quantity <= 0 || quantity > 100000) return { error: "A line is at most 1,00,000 in the stock unit" };
  const scheme = schemeFor(index, ctx.groupId, sku, milli(quantity), ctx.day);
  const noSlab = Boolean(scheme?.noSlab);
  const withFactor = entered && { ...entered, factorMicro };
  let priced = salePrice(index, ctx.contactId, sku, quantity, withFactor, index.rulesOn);
  // A slab for every customer gives way to the list price when the scheme does not combine with slabs.
  if (noSlab && priced.rule && priced.rule.contact_id === null) priced = salePrice(index, ctx.contactId, sku, quantity, withFactor, false);
  let stockPrice = priced.stockPrice, enteredPrice = priced.enteredPrice, gross = priced.net;
  let source = priced.rule ? (priced.rule.contact_id !== null ? "customer" : "slab") : "list";
  if (!(priced.rule && priced.rule.contact_id !== null)) {
    const group = groupPrice(index, ctx.groupId, sku, quantity, entered, ctx.day, noSlab);
    if (group) {
      source = "group";
      if (group.unit_code && entered) {
        enteredPrice = paise(group.unit_price);
        gross = roundedDivide(BigInt(enteredPrice) * BigInt(milli(entered.quantity)), 1000n);
        stockPrice = Number(((enteredPrice / 100) / (factorMicro / 1e6)).toFixed(4));
      } else {
        stockPrice = Number(group.unit_price);
        gross = roundedDivide(BigInt(paise(stockPrice)) * BigInt(milli(quantity)), 1000n);
        enteredPrice = entered ? roundedDivide(BigInt(paise(stockPrice)) * BigInt(factorMicro), 1000000n) : null;
      }
    }
  }
  const discountBp = Math.min(9999, Math.round((scheme?.discount || 0) * 100));
  const listPrice = stockPrice;
  let net = gross;
  if (discountBp) {
    net = roundedDivide(BigInt(gross) * BigInt(10000 - discountBp), 10000n);
    stockPrice = Number(((stockPrice * (10000 - discountBp)) / 10000).toFixed(4));
    if (enteredPrice !== null) enteredPrice = roundedDivide(BigInt(enteredPrice) * BigInt(10000 - discountBp), 10000n);
  }
  let tax;
  if (index.taxMode === "inclusive") {
    const amount = net;
    net = inclusiveNet(amount, Number(sku.tax_rate));
    tax = amount - net;
  } else {
    tax = lineTax(net, Number(sku.tax_rate));
  }
  // Free goods: the same item (in its pack when whole packs), or another item as its own line.
  let free = null, otherFree = null;
  if (scheme?.freeSkuId && scheme.freeMilli > 0) {
    const item = index.items.get(scheme.freeSkuId);
    otherFree = item
      ? { sku: item, quantityMilli: scheme.freeMilli, entered: scheme.freeEntered }
      : { error: `The free item of ${scheme.scheme.name} is no longer sold: the office ends or changes the scheme`, quantityMilli: scheme.freeMilli };
  } else if (scheme && scheme.freeMilli > 0) {
    const packFactor = entered ? factorMicro : scheme.freeEntered?.factorMicro;
    const packUnit = entered ? entered.unit : scheme.freeEntered?.unit;
    const wholePacks = packFactor && (BigInt(scheme.freeMilli) * 1000000n) % (BigInt(packFactor) * 1000n) === 0n;
    free = { quantityMilli: scheme.freeMilli,
      entered: wholePacks ? { unit: packUnit, quantity: Number((BigInt(scheme.freeMilli) * 1000000n) / BigInt(packFactor)) / 1000 } : null };
  }
  return {
    sku, quantity, entered, factorMicro, listPrice, stockPrice, enteredPrice, net, tax, total: net + tax, source, discount: discountBp / 100,
    scheme: scheme ? { id: scheme.scheme.id, name: scheme.scheme.name } : null, free, otherFree,
  };
}

// A whole order: its lines priced, their sum, and what keeps it from being
// placed (a line the phone cannot price). Lines: [{ skuId, quantity, unit? }].
export function priceOrder(index, ctx, lines) {
  const priced = lines.map((line) => ({ input: line, ...priceLine(index, ctx, line) }));
  const problems = priced.filter((line) => line.error || line.otherFree?.error).map((line) => line.error || line.otherFree.error);
  const subtotal = priced.reduce((sum, line) => sum + (line.net || 0), 0);
  const tax = priced.reduce((sum, line) => sum + (line.tax || 0), 0);
  return { lines: priced, subtotal, tax, total: subtotal + tax, problems };
}

// The rupees text the server takes for a total in paise.
export const rupeesText = (p) => (p / 100).toFixed(2);
