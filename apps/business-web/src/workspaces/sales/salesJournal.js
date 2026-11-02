// The salesperson app's journal: what this phone did each day (the day's
// start and end, check-ins and check-outs, orders, collections, new shops),
// kept on the device (services/offline/snapshots.js) beside each write's
// outbox item. The app shows from it what was made, whatever the network,
// and whether it reached the office: waiting, sending, needing attention with
// the server's reason, or sent (with the office's number and total, kept as
// the outbox hands back the answer). Nothing is shown as sent that the outbox
// still holds, and nothing the outbox let go is shown as sent until its
// answer or the office's own copy of the day says so.
//
// An entry: { id (its request key), kind, date, at, shopRef, visitKey?,
//   outboxId, data, result?, sentAt?, offline }
//   kind  start | end | shop | visit | checkout | order | collection

import { readSnapshot, saveSnapshot } from "../../services/offline/snapshots.js";

const KEEP_DAYS = 7;
const keyOf = (businessId) => `sales-journal:${businessId}`;

const addDays = (date, n) => {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// The journal of one person in one business, read and written one change at
// a time (two quick taps never lose each other's entry).
const chains = new Map();
export function journalStore(userId, businessId) {
  const key = keyOf(businessId);
  const chainKey = `${userId}:${key}`;
  const load = async () => (await readSnapshot(key, userId))?.data?.entries || [];
  const update = (change) => {
    const run = (chains.get(chainKey) || Promise.resolve()).then(async () => {
      const next = change(await load());
      await saveSnapshot(key, userId, { entries: next });
      return next;
    });
    chains.set(chainKey, run.catch(() => undefined));
    return run;
  };
  return { load, update };
}

// Entries of the last week, and older ones only while they still wait to go.
export const keepRecent = (entries, today, waiting = new Set()) => entries.filter((e) => e.date >= addDays(today, -KEEP_DAYS) || waiting.has(e.outboxId));

// What the office's copy of a day knows, by request key (GET /sales/day).
export function serverKeys(day) {
  const keys = new Map();
  if (!day) return keys;
  if (day.day) {
    keys.set(day.day.start_key, { kind: "start", row: day.day });
    if (day.day.end_key) keys.set(day.day.end_key, { kind: "end", row: day.day });
  }
  for (const visit of day.visits || []) {
    keys.set(visit.request_key, { kind: "visit", row: visit });
    if (visit.checkout_key) keys.set(visit.checkout_key, { kind: "checkout", row: visit });
  }
  for (const order of day.orders || []) keys.set(order.request_key, { kind: "order", row: order });
  for (const collection of day.collections || []) keys.set(collection.request_key, { kind: "collection", row: collection });
  for (const shop of day.shops || []) keys.set(shop.request_key, { kind: "shop", row: shop });
  return keys;
}

// An entry's state, from its outbox item (still on the device) and its
// answer or the office's copy of the day:
//   waiting, sending, attention (the server's reason), sent, or gone (no
//   longer on the device and not at the office: discarded).
// `items`: the outbox's items by id; `known`: serverKeys(day);
// `checkedAfter`: when the office's day was read (gone only once read after).
export function statusOf(entry, items, known, checkedAfter = 0) {
  const item = items.get(entry.outboxId);
  if (item) {
    return { state: item.state === "sending" ? "sending" : item.state === "attention" ? "attention" : "waiting", message: item.lastError || null,
      reason: item.reason || null, status: item.status || null, attempts: item.attempts || 0 };
  }
  if (entry.result) return { state: "sent", row: entry.result };
  const server = known.get(entry.id);
  if (server) return { state: "sent", row: server.row };
  if (checkedAfter && entry.at && checkedAfter > Date.parse(entry.at) + 1000) return { state: "gone" };
  return { state: "checking" };
}

export const STATE_WORDS = {
  waiting: { label: "Waiting to send", tone: "warning" },
  sending: { label: "Sending", tone: "info" },
  attention: { label: "Needs attention", tone: "danger" },
  sent: { label: "Sent", tone: "success" },
  checking: { label: "Sent · checking", tone: "info" },
  gone: { label: "Not sent: discarded on this phone", tone: "neutral" },
};

// The day's visits as the phone shows them: this phone's check-ins and the
// office's (another phone's, or before this one kept a journal), by key, with
// their orders, collections and check-out.
export function visitsOfDay(entries, day, date) {
  const visits = new Map();
  for (const visit of day?.visits || []) {
    if (visit.day !== date) continue;
    visits.set(visit.request_key, { key: visit.request_key, contactId: visit.contact_id, shopRef: `c${visit.contact_id}`, name: visit.contact_name, at: visit.checked_in_at,
      out: visit.checked_out_at ? { at: visit.checked_out_at, outcome: visit.outcome, reason: visit.no_order_reason } : null, far: visit.far, offBeat: visit.off_beat,
      distance: visit.distance_m, server: visit });
  }
  for (const entry of entries.filter((e) => e.kind === "visit" && e.date === date)) {
    const known = visits.get(entry.id);
    visits.set(entry.id, { ...(known || {}), key: entry.id, contactId: known?.contactId || entry.data.contactId || null, shopRef: known?.shopRef && !entry.shopRef.startsWith("n") ? known.shopRef : entry.shopRef,
      name: entry.data.shopName, at: entry.at, far: entry.data.far, offBeat: entry.data.offBeat, distance: entry.data.distance, entry, out: known?.out || null });
  }
  for (const entry of entries.filter((e) => e.kind === "checkout" && e.date === date)) {
    const visit = visits.get(entry.visitKey);
    if (visit) visit.out = { at: entry.at, outcome: entry.data.outcome, reason: entry.data.noOrderReason, entry };
  }
  const ordersOf = (key) => [...(day?.orders || []).filter((o) => o.visit_key === key).map((o) => o.request_key),
    ...entries.filter((e) => e.kind === "order" && e.visitKey === key).map((e) => e.id)];
  for (const visit of visits.values()) visit.orderKeys = [...new Set(ordersOf(visit.key))];
  return [...visits.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Orders or collections of the day: the phone's, and the office's it does not hold.
export function recordsOfDay(entries, day, date, kind) {
  const list = entries.filter((e) => e.kind === kind && e.date === date).map((entry) => ({ key: entry.id, entry, at: entry.at }));
  const mine = new Set(list.map((r) => r.key));
  const rows = kind === "order" ? day?.orders || [] : day?.collections || [];
  for (const row of rows) if (!mine.has(row.request_key)) list.push({ key: row.request_key, server: row, at: row.taken_at || row.created_at });
  return list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const paise = (value) => Math.round(Number(value || 0) * 100);

// The day's money as the phone knows it, in paise: orders (the office's
// total once sent, the phone's until then; a refused one is not counted
// until it goes) and collections by mode, each its own or the office's.
// `status`: statusOf for an entry.
export function dayTotals(entries, day, date, status) {
  const counts = (record) => !record.entry || !["attention", "gone"].includes(status(record.entry).state);
  const orders = recordsOfDay(entries, day, date, "order");
  const collections = recordsOfDay(entries, day, date, "collection");
  const orderValue = orders.filter(counts).reduce((sum, r) => sum + paise(r.entry ? r.entry.result?.total ?? r.entry.data.phoneTotal : r.server.total), 0);
  const byMode = { cash: 0, cheque: 0, upi: 0 };
  const cheques = [];
  for (const record of collections.filter(counts)) {
    const method = record.entry ? record.entry.data.method : record.server.method;
    const amount = paise(record.entry ? record.entry.data.amount : record.server.amount);
    byMode[method] = (byMode[method] || 0) + amount;
    if (method === "cheque") cheques.push(record);
  }
  return {
    orders: orders.filter(counts).length, orderValue, refused: orders.filter((r) => r.entry && status(r.entry).state === "attention").length,
    cash: byMode.cash, cheque: byMode.cheque, upi: byMode.upi, collected: byMode.cash + byMode.cheque + byMode.upi, cheques,
  };
}
