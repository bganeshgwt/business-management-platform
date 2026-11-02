import { rateOn } from "./tillRules.js";

// An offline till's bill, priced on the till from its snapshot with exactly
// the arithmetic the server uses for every bill (backend: business.service.js
// postDocument, businessPricing.js salePrice, businessOffers.js priceSale's
// counter discount, the fashion shop's GST by price): integer paise, BigInt
// where quantities multiply, half a paisa rounded up, the same order of
// steps. The integration test tests/integration/offline-till.test.js prices
// many carts here and by the server's quote and finds every line and total
// equal; keep the two in step.
//
// No offer or coupon runs offline (the bill is at the shelf price), and no
// points are redeemed: the till says so on the bill.
//
//   priceBill(snapshot, cart, { day, fullAccess })
//     snapshot  the till's snapshot (items by id, units, rules, settings, slab)
//     cart      { contactId, lines: [{ skuId, quantity, unit? }], discount?: { amount | percent, reason } }
//     day       the business date the bill is made on (GST rates in force then)
//   -> { ok, problems: [{ index?, message }], lines, subtotal, tax, roundOff, total, discount } (money in paise)

const paise = (number) => Math.round(Number(number) * 100);
const milli = (number) => Math.round(Number(number) * 1000);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const divide = roundedDivide;
const lineTax = (net, rate) => roundedDivide(BigInt(net) * BigInt(paise(rate)), 10000n);
const inclusiveNet = (gross, rate) => roundedDivide(BigInt(gross) * 10000n, 10000n + BigInt(paise(rate)));
const sum = (values) => values.reduce((total, value) => total + value, 0);
export const money = (value) => (value / 100).toFixed(2);

// total split over weights in proportion, the rounding carried forward: the parts add up exactly.
function split(total, weights) {
  const whole = sum(weights);
  if (!whole || !total) return weights.map(() => 0);
  let given = 0, running = 0;
  return weights.map((weight) => {
    running += weight;
    const upto = divide(BigInt(total) * BigInt(running), BigInt(whole));
    const part = upto - given;
    given = upto;
    return part;
  });
}

// The snapshot's lookups, built once per snapshot.
const indexes = new WeakMap();
export function indexOf(snapshot) {
  if (!indexes.has(snapshot)) {
    indexes.set(snapshot, {
      items: new Map((snapshot.items || []).map((item) => [Number(item.id), item])),
      units: new Map((snapshot.units || []).map((unit) => [unit.code, unit])),
    });
  }
  return indexes.get(snapshot);
}

// Stock units per entered unit, in millionths (businessService.conversion):
// the item's own pack, else a unit of the same kind through their base.
function conversion(item, entered, base) {
  const pack = (item.packs || []).find((p) => p.unit === entered.code);
  if (pack) return Math.round(Number(pack.quantity) * 1e6);
  const root = (u) => u.base || u.code;
  const toRoot = (u) => (u.base ? Number(u.factor) : 1);
  if (base && entered.kind === base.kind && root(entered) === root(base)) return Math.round((toRoot(entered) / toRoot(base)) * 1e6);
  return null;
}

const places = (value) => (String(value).split(".")[1] || "").length;
function decimalsProblem(quantity, unit) {
  if (unit.decimals === 0 && !Number.isInteger(Number(quantity))) return `must be a whole number of ${unit.name.toLowerCase()}`;
  if (places(quantity) > unit.decimals) return `can have at most ${unit.decimals} decimal places in ${unit.name.toLowerCase()}`;
  return null;
}

// The walk-in, member or customer price (businessPricing.js salePrice).
function salePrice(snapshot, item, contactId, quantity, entered) {
  const rules = (snapshot.rules || []).filter((r) => Number(r.skuId) === Number(item.id)
    && (r.contactId === null || Number(r.contactId) === Number(contactId))
    && ((r.unit === null && Number(r.minimum) <= quantity) || (r.unit !== null && entered && r.unit === entered.unit && Number(r.minimum) <= entered.quantity)));
  rules.sort((a, b) => (Number(b.contactId !== null) - Number(a.contactId !== null)) || (Number(b.unit !== null) - Number(a.unit !== null)) || (Number(b.minimum) - Number(a.minimum)));
  const rule = rules[0] || null;
  if (rule?.unit && entered) {
    const enteredPrice = paise(rule.price);
    const net = roundedDivide(BigInt(enteredPrice) * BigInt(milli(entered.quantity)), 1000n);
    const stockPrice = Number(((enteredPrice / 100) / (entered.factorMicro / 1e6)).toFixed(4));
    return { net, stockPrice, enteredPrice, packPrice: enteredPrice, priceKind: "rule" };
  }
  let price = Number(item.listPrice), priceKind = "list";
  if (rule) {
    price = Number(rule.price); priceKind = "rule";
  } else {
    if (item.branchPrice !== null && item.branchPrice !== undefined) { price = Number(item.branchPrice); priceKind = "branch"; }
    const member = Boolean(contactId) && snapshot.settings?.memberPrices;
    if (member && item.memberPrice !== null && item.memberPrice !== undefined && Number(item.memberPrice) < price) { price = Number(item.memberPrice); priceKind = "member"; }
  }
  const net = roundedDivide(BigInt(paise(price)) * BigInt(milli(quantity)), 1000n);
  const enteredPrice = entered ? roundedDivide(BigInt(paise(price)) * BigInt(entered.factorMicro), 1000000n) : null;
  return { net, stockPrice: price, enteredPrice, packPrice: null, priceKind };
}

// A clothes shop's GST by price, as the rule stood on the day.
function slabOn(slab, day) {
  if (!slab) return null;
  const dated = (slab.changes || []).filter((c) => String(c.startsOn) <= day).sort((a, b) => String(a.startsOn).localeCompare(String(b.startsOn)));
  return dated.length ? dated[dated.length - 1] : slab;
}

function readDiscount(discount) {
  if (!discount) return { value: null };
  const has = (value) => value !== undefined && value !== null && String(value).trim() !== "" && Number(value) !== 0;
  if (!has(discount.amount) && !has(discount.percent)) return { value: null };
  if (has(discount.amount) && has(discount.percent)) return { problem: "Give the discount as an amount or a percent, not both" };
  const text = String(has(discount.amount) ? discount.amount : discount.percent).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { problem: "The discount must be a positive number with at most 2 decimal places" };
  if (has(discount.percent) && Number(text) > 100) return { problem: "A discount cannot be more than 100%" };
  if (!String(discount.reason ?? "").trim()) return { problem: "Say why the discount is given (for example \"regular customer\")" };
  return { value: has(discount.amount) ? { amount: paise(text) } : { percent: Number(text) }, reason: String(discount.reason).trim().slice(0, 120) };
}

export function priceBill(snapshot, cart, { day, fullAccess = false } = {}) {
  const { items, units } = indexOf(snapshot);
  const taxMode = snapshot.settings?.taxMode === "inclusive" ? "inclusive" : "exclusive";
  const problems = [];
  const prepared = [];
  (cart.lines || []).forEach((input, index) => {
    const item = items.get(Number(input.skuId));
    if (!item) { problems.push({ index, message: "This item is not on this till: it needs the network" }); return; }
    const base = units.get(item.unit) || { code: item.unit, name: item.unit, decimals: 3, kind: "count" };
    const typed = String(input.quantity ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(typed) || !(Number(typed) > 0)) { problems.push({ index, message: `Enter the quantity of ${item.label}` }); return; }
    let quantity, entered = null, factorMicro = 1000000;
    if (input.unit && input.unit !== item.unit) {
      const enteredUnit = units.get(input.unit);
      if (!enteredUnit) { problems.push({ index, message: `${item.label} has no unit ${input.unit}` }); return; }
      if (places(typed) > 3 || Number(typed) < 0.001 || Number(typed) > 100000) { problems.push({ index, message: "Quantity must be between 0.001 and 100000, with at most 3 decimal places" }); return; }
      const bad = decimalsProblem(typed, enteredUnit);
      if (bad) { problems.push({ index, message: `Quantity ${bad}` }); return; }
      factorMicro = conversion(item, enteredUnit, base);
      if (!factorMicro) { problems.push({ index, message: `${item.label} has no pack size in ${enteredUnit.name.toLowerCase()}` }); return; }
      const baseMilli = BigInt(milli(typed)) * BigInt(factorMicro);
      if (baseMilli % 1000000n !== 0n) { problems.push({ index, message: `${typed} ${enteredUnit.name.toLowerCase()} does not make an exact quantity in ${base.name.toLowerCase()}` }); return; }
      quantity = Number(baseMilli / 1000000n) / 1000;
      if (quantity <= 0 || quantity > 100000) { problems.push({ index, message: "Quantity must be between 0.001 and 100000 in the stock unit" }); return; }
      entered = { unit: enteredUnit.code, quantity: Number(typed) };
    } else {
      if (places(typed) > 3 || Number(typed) < 0.001 || Number(typed) > 100000) { problems.push({ index, message: "Quantity must be between 0.001 and 100000, with at most 3 decimal places" }); return; }
      quantity = Number(typed);
    }
    const bad = decimalsProblem(quantity, base);
    if (bad) { problems.push({ index, message: `Quantity ${bad}` }); return; }
    const priced = salePrice(snapshot, item, cart.contactId || null, quantity, entered && { ...entered, factorMicro });
    const rate = rateOn(item.taxRate, item.changes, day);
    // Nothing is billed above its MRP.
    if (item.mrp !== null && item.mrp !== undefined) {
      const shelf = taxMode === "inclusive" ? paise(priced.stockPrice) : paise(priced.stockPrice) + lineTax(paise(priced.stockPrice), rate);
      if (shelf > paise(item.mrp)) { problems.push({ index, message: `${item.label} would sell above its MRP of ${Number(item.mrp).toFixed(2)}: it needs the network` }); return; }
    }
    prepared.push({ index, item, quantity, entered, factorMicro, rate, amount: priced.net, price: priced.stockPrice, enteredPrice: priced.enteredPrice,
      packPrice: priced.packPrice, priceKind: priced.priceKind });
  });

  // The counter discount, as priceSale gives it: on what the customer pays,
  // split in proportion, back into each line's price terms.
  const perLine = prepared.map(() => 0);
  const discount = readDiscount(cart.discount);
  let given = null;
  if (discount.problem) problems.push({ message: discount.problem });
  else if (discount.value && prepared.length) {
    const payable = prepared.map((line) => (taxMode === "inclusive" ? line.amount : line.amount + divide(BigInt(line.amount) * BigInt(paise(line.rate)), 10000n)));
    const bill = sum(payable);
    const value = discount.value.amount ?? divide(BigInt(bill) * BigInt(Math.round(discount.value.percent * 100)), 10000n);
    const cap = Math.floor((bill * paise(snapshot.settings?.maxDiscountPercent ?? 10)) / 10000);
    if (value > bill) problems.push({ message: `The discount is more than the bill (${money(bill)})` });
    else if (!fullAccess && value > cap) problems.push({ message: `At most ${Number(snapshot.settings?.maxDiscountPercent ?? 10)}% of a bill (${money(cap)} on this one) can be taken off at the counter` });
    else {
      split(value, payable).forEach((part, i) => {
        if (part <= 0) return;
        const line = prepared[i];
        const share = Math.min(line.amount - perLine[i], taxMode === "inclusive" ? part : divide(BigInt(part) * 10000n, 10000n + BigInt(paise(line.rate))));
        if (share > 0) perLine[i] += share;
      });
      given = { value, cap, reason: discount.reason };
    }
  }

  // GST by the value of each piece after the discount (a clothes shop).
  const slab = slabOn(snapshot.slab, day);
  if (slab) {
    const unitsOf = (item) => units.get(item.unit);
    prepared.forEach((line, i) => {
      if (!line.item.slab || Number(unitsOf(line.item)?.decimals ?? 0) !== 0) return;
      const low = Number(slab.rateLow), high = Number(slab.rateHigh);
      const pieces = Number(line.quantity);
      if (!(pieces > 0)) return;
      const each = (line.amount - perLine[i]) / pieces;
      const value = taxMode === "inclusive" ? each / (1 + low / 100) : each;
      line.rate = Math.round(value) <= paise(slab.threshold) ? low : high;
    });
  }

  let subtotal = 0, tax = 0;
  const lines = prepared.map((line, i) => {
    const amount = line.amount - perLine[i];
    let net, lineGst;
    if (taxMode === "inclusive") {
      net = inclusiveNet(amount, line.rate); lineGst = amount - net;
    } else {
      net = amount; lineGst = lineTax(amount, line.rate);
    }
    subtotal += net; tax += lineGst;
    return {
      index: line.index, skuId: line.item.id, label: line.item.label, unit: line.item.unit, hsn: line.item.hsn || null, mrp: line.item.mrp ?? null,
      quantity: line.quantity, enteredUnit: line.entered?.unit || null, enteredQuantity: line.entered?.quantity ?? null,
      unitPrice: line.price, enteredPrice: line.enteredPrice, packPrice: line.packPrice, priceKind: line.priceKind, taxRate: Number(line.rate).toFixed(2),
      amount: line.amount, discount: perLine[i], net, tax: lineGst,
    };
  });
  const raw = subtotal + tax;
  const rounded = snapshot.settings?.rounding === "nearest_rupee" ? Math.floor((raw + 50) / 100) * 100 : raw;
  return { ok: problems.length === 0 && lines.length > 0, problems, taxMode, lines, subtotal, tax, roundOff: rounded - raw, total: rounded, discount: given };
}
