import { billNumber, fiscalYearOf } from "./tillRules.js";
import { money } from "./tillPricing.js";

// An offline till's bills as they wait in the outbox (services/offline/outbox.js),
// kept free of React and the browser for the tests (tests/till.test.js):
// what a bill sends, what its receipt prints, what may still be voided, and
// what the till reports to the server about what waits on it.

// One queue per business: the till's bills go in the order they were made.
export const queueOf = (businessId) => `till:${businessId}`;
export const isTillItem = (item, businessId) => item?.queue === queueOf(businessId);

const METHOD_WORDS = { cash: "Cash", upi: "UPI", card: "Card" };

// What the server is sent (POST /businesses/:id/till/bills).
export function billBody({ priced, cart, payments, number, madeAt, madeBy, offlineSince = null, pinRule = false, buyer = null, requestKey, locationId }) {
  return {
    requestKey, kind: "bill", number, madeAt, madeBy, offlineSince, pinRule, locationId,
    total: money(priced.total),
    contactId: cart.contactId || null,
    lines: priced.lines.map((line) => ({
      skuId: line.skuId,
      quantity: line.enteredUnit ? String(line.enteredQuantity) : String(line.quantity),
      ...(line.enteredUnit ? { unit: line.enteredUnit } : {}),
      unitPrice: String(line.unitPrice),
      packPrice: line.packPrice === null || line.packPrice === undefined ? null : money(line.packPrice),
      priceKind: line.priceKind, taxRate: line.taxRate, label: line.label,
    })),
    ...(cart.discount && priced.discount ? { discount: cart.discount } : {}),
    ...(buyer ? { buyer } : {}),
    payments: payments.map((part) => ({
      method: part.method, amount: money(part.amount),
      ...(part.methodId ? { methodId: part.methodId } : {}),
      ...(part.reference ? { reference: part.reference } : {}),
      ...(part.tendered ? { tendered: money(part.tendered) } : {}),
    })),
  };
}

// The same bill voided on the till before it was sent: it keeps its number,
// moves no stock and no money (CGST rule 56(8): never deleted).
export const voidBody = (body, reason, requestKey) => {
  const rest = { ...body };
  delete rest.payments;
  delete rest.discount;
  delete rest.buyer;
  return { ...rest, requestKey, kind: "void", void: { reason } };
};

// The receipt, as the counter prints a posted bill (core/pages/invoice.js):
// the same shape, from what the till worked out.
export function receiptDoc({ snapshot, priced, number, madeAt, customer = null, payments, buyer = null, discountReason = "" }) {
  const lines = priced.lines.map((line, index) => ({
    id: index + 1, label: line.label, lot_code: "", hsn_code: line.hsn, mrp: line.mrp, unit: line.unit, quantity: String(line.quantity),
    unit_price: Number(line.unitPrice).toFixed(2), tax_rate: line.taxRate, net: money(line.net), tax: money(line.tax),
    entered_unit: line.enteredUnit, entered_quantity: line.enteredQuantity, entered_unit_price: line.enteredUnit ? money(line.enteredPrice) : null,
  }));
  const discounts = priced.lines.filter((line) => line.discount > 0)
    .map((line, i) => ({ line_id: priced.lines.indexOf(line) + 1, amount: money(line.discount), label: `Discount: ${discountReason}`, key: i }));
  return {
    id: number, kind: "sale", document_no: number, created_at: madeAt, tax_mode: priced.taxMode,
    contact_id: customer?.id || null, contact_name: customer?.name || null, contact_phone: customer?.phone || null,
    contact_gstin: customer?.gstin || null, contact_address: customer?.address || null,
    buyer_pan: buyer?.pan || customer?.pan || null, pan_declaration: Boolean(buyer?.panDeclaration),
    place_of_supply: customer?.gstin ? String(customer.gstin).slice(0, 2) : snapshot.location?.stateCode || null,
    location_name: snapshot.location?.name || "", seller: snapshot.seller || {},
    subtotal: money(priced.subtotal), tax: money(priced.tax), round_off: money(priced.roundOff), total: money(priced.total),
    lines, payments: payments.map((part, i) => ({ id: i + 1, amount: money(part.amount), method: part.method, method_name: part.methodName || METHOD_WORDS[part.method] || part.method,
      reference: part.reference || null, tendered: part.tendered ? money(part.tendered) : null })),
    retail: { discounts, savings: money(priced.lines.reduce((s, l) => s + l.discount, 0)), loyalty: [] }, returns: [], refunds: [],
  };
}

// The words a waiting bill shows in the waiting list.
export const billLabel = (number, total, symbol = "₹") => `Bill ${number} · ${symbol}${Number(money(total)).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
export const voidLabel = (number) => `Voided bill ${number}`;

// A bill may be voided on the till while it waits (or was refused); once on
// its way or sent, it is the server's and is taken back as a return instead.
export function voidable(item) {
  if (!item) return { ok: false, why: "This bill has reached the server: take it back as a return from Quick bill online." };
  if (item.kind === "till_void") return { ok: false, why: "This bill is voided already." };
  if (item.state === "sending") return { ok: false, why: "This bill is being sent right now: try again in a moment." };
  if (item.state === "done") return { ok: false, why: "This bill has reached the server: take it back as a return from Quick bill online." };
  return { ok: true, why: "" };
}

// What the till reports about its waiting bills (POST …/till/heartbeat):
// how many wait and need attention, the oldest's time, the last number taken
// and the numbers of this year it still holds.
export function heartbeatOf(items, till, { day, startMonth = 4 } = {}) {
  const mine = items.filter((item) => isTillItem(item, till.businessId) && item.state !== "done");
  const year = fiscalYearOf(day, startMonth);
  const times = mine.map((item) => Date.parse(item.meta?.madeAt || 0)).filter(Number.isFinite);
  return {
    pending: mine.filter((item) => item.state !== "attention").length,
    attention: mine.filter((item) => item.state === "attention").length,
    oldestMadeAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastNumber: till.numbers?.[year] ? { year, seq: Number(till.numbers[year]) } : null,
    holding: mine.filter((item) => Number(item.meta?.year) === year).map((item) => Number(item.meta?.seq)).filter(Boolean).slice(0, 2000),
  };
}

// The waiting bills, as a file kept on the till for safety ("Download a copy").
export function waitingCopy(items, till, savedAt = new Date().toISOString()) {
  const mine = items.filter((item) => isTillItem(item, till.businessId) && item.state !== "done");
  return {
    till: { code: till.code, name: till.name, business: till.businessId, location: till.locationName || null },
    savedAt,
    bills: mine.map((item) => ({
      number: item.meta?.number || null, kind: item.kind === "till_void" ? "void" : "bill", state: item.state, madeAt: item.meta?.madeAt || null,
      madeBy: item.meta?.madeByName || null, customer: item.meta?.customer?.name || null, total: item.body?.total || null,
      reason: item.lastError || null, body: item.body,
    })),
  };
}

// The number a bill takes: the till's code, the year of the moment it is made, the next in that year's series.
export const numberFor = (till, year, seq) => billNumber(till.code, year, seq);
