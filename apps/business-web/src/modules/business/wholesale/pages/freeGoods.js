// Free goods on a return of a dispatched order's invoice, for the return
// dialog's preview (the server works the credit out: businessWholesaleFreeGoods
// and freeGoodsMaths.js). Quantities in thousandths of a unit.

const milli = (value) => Math.round(Number(value || 0) * 1000);
const half = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);

// The free goods that belong to the paid goods returned so far: free × paid
// returned ÷ paid bought, to the thousandth (half away from zero), as the server.
export function belongsMilli(freeMilli, paidBackMilli, paidMilli, decimals = 3) {
  if (paidMilli <= 0 || freeMilli <= 0 || paidBackMilli <= 0) return 0;
  const step = 10n ** BigInt(3 - Math.max(0, Math.min(3, Number(decimals))));
  return Number(half(BigInt(freeMilli) * BigInt(Math.min(paidBackMilli, paidMilli)), BigInt(paidMilli) * step) * step);
}

// The free goods of the invoice that came with this paid line, as the
// invoice's extras give them (wholesale.free_goods), or null.
export const freeGoodsOf = (doc, lineId) => (doc?.wholesale?.free_goods || []).find((group) => group.paid_line_ids.map(String).includes(String(lineId))) || null;

// For one free item, with `quantity` of the paid line coming back now: what
// belongs to the paid goods returned, the most that can come back now, what
// is suggested to come back (what belongs and is not back, in the unit's own
// steps: whole for a count unit), and what is kept (charged, or given back
// when less than nothing) if `backNow` of them come back with it. All in
// thousandths.
export function freePreview(group, free, quantity, backNow) {
  const belongs = belongsMilli(milli(free.quantity), milli(group.paid_returned) + milli(quantity), milli(group.paid_quantity));
  const left = milli(free.quantity) - milli(free.returned);
  const step = 10 ** (3 - Math.max(0, Math.min(3, Number(free.unit_decimals ?? 3))));
  const suggested = Math.floor(Math.max(0, Math.min(belongs - milli(free.returned), left)) / step) * step;
  const back = backNow === undefined || backNow === "" ? suggested : Math.min(milli(backNow), left);
  const kept = Math.max(0, belongs - milli(free.returned) - back) - milli(free.kept);
  return { belongs, left, suggested, back, kept };
}

// A quantity coming back spread over the free item's lines (its batches), in
// order, each up to what is left on it: [{ lineId, quantity }].
export function spreadBack(free, backMilli) {
  const parts = [];
  let rest = backMilli;
  for (const line of free.lines) {
    if (rest <= 0) break;
    const take = Math.min(rest, milli(line.quantity) - milli(line.returned));
    if (take > 0) parts.push({ lineId: line.id, quantity: (take / 1000).toFixed(3) });
    rest -= Math.max(0, take);
  }
  return parts;
}
