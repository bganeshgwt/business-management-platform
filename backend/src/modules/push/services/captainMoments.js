// What alerts a captain's closed phone, by the captain app's own rules, so a
// phone in a pocket is alerted for the same moments, and the same people, as
// the open app chimes for (apps/business-web/src/workspaces/captain:
// captainFloor.js arrivals and waitingDishes, useCaptainFloor.js can):
//
//   - a guest's call at a table (a waiter, water, the bill, something else),
//     or a waiter asking the counter for a table's bill: key call:<request>;
//   - a QR order waiting for a yes: key order:<request>;
//   - food at the pass: the ticket, and each dish waiting on it, so a dish
//     coming up after another alerts again: ready:<ticket>, ready:<ticket>.<dish>.
//
// Whose phone: a captain with tables of their own today (captain sections)
// hears of those, unless they chose All tables; one with none hears of every
// table shown to them (their outlet's and those of no outlet, or the whole
// restaurant). Only who may see it in the app: the captain app itself
// (orders.create and the Captain app feature); calls and QR orders need
// orders.view, and a guest's request QR ordering switched on; food needs the
// kitchen display and kot.manage or kds.view. A waiter's own bill ask never
// alerts their own phone. Nothing older than the phone's alerts, or than a
// quarter of an hour, is news. A captain clocked out on the time clock is off
// shift and hears nothing.
//
// Kept free of the database, so the rules are tested on their own beside the
// app's (tests/captain-push-rules.test.js).

const OPEN_CALL = ['pending', 'acknowledged'];
const OPEN_ORDER = ['pending', 'processing'];
// A moment older than this when the server hears of it is not news: a call
// answered half an hour after it was made rings no phone.
const FRESH_MS = 15 * 60 * 1000;
// A clock-in this old with no clock-out is a forgotten one (the time clock's own rule).
const STALE_HOURS = 16;
// How long a push service keeps an alert for a phone that is off, and the
// alert's urgency: a call is old news in two minutes, food at the pass in five.
const TTL = { call: 120, order: 120, ready: 300 };

const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const timeOf = (value) => (value ? new Date(value).getTime() : NaN);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// --- Moments -------------------------------------------------------------------

// A table request as a moment, or null when nothing waits on it: a guest's
// call or a waiter's bill ask still open, or a QR order waiting for a yes, at
// a table. `row`: table_requests with its table.
const requestMoment = (row) => {
  if (!row || !row.table_id) return null;
  const order = row.request_type === 'order';
  if (!(order ? OPEN_ORDER : OPEN_CALL).includes(row.status)) return null;
  const kind = order ? 'order' : 'call';
  return {
    kind,
    tableId: String(row.table_id),
    tableNo: row.table_no,
    outletName: row.outlet_name || null,
    requestOutletId: row.outlet_id ? String(row.outlet_id) : null,
    channel: row.channel || 'qr',
    askedBy: row.created_by ? String(row.created_by) : null,
    type: row.request_type,
    itemCount: Number(row.item_count) || 0,
    orderId: row.order_id ? String(row.order_id) : null,
    keys: [{ key: `${kind}:${row.id}`, at: timeOf(row.created_at) }],
  };
};

// The dishes of a ticket at the pass that wait to be carried out, as the
// captain app counts them: on a ready ticket every live dish not yet served,
// on a ticket still cooking the ones the kitchen has ticked done.
const waitingDishes = (ticket) =>
  ((ticket && ticket.items) || []).filter((item) => Number(item.liveQuantity) > 0 && !item.servedAt && (ticket.status === 'ready' || item.isDone));

// A ticket at the pass as a moment, or null. `ticket`: as GET /kitchen/pass
// gives it; `place`: its outlet and its order's table ({ ticketOutletId,
// tableId, tableNo, outletName }); `order`: every ticket of the same order at
// the pass, for the count of dishes waiting at the table.
const foodMoment = (ticket, place, order = [ticket]) => {
  if (!ticket || !place || !place.tableId) return null;
  const dishes = waitingDishes(ticket);
  const readyAt = ticket.status === 'ready' ? timeOf(ticket.readyAt) : timeOf(ticket.passSince);
  const keys = [{ key: `ready:${ticket.id}`, at: readyAt },
    ...dishes.map((item) => ({ key: `ready:${ticket.id}.${item.id}`, at: timeOf(item.doneAt) || readyAt }))];
  const waiting = order.reduce((sum, each) => sum + waitingDishes(each).reduce((count, item) => count + Math.max(0, Number(item.liveQuantity) || 0), 0), 0);
  return {
    kind: 'ready',
    tableId: String(place.tableId),
    tableNo: place.tableNo,
    outletName: place.outletName || null,
    ticketOutletId: place.ticketOutletId ? String(place.ticketOutletId) : null,
    orderId: ticket.orderId ? String(ticket.orderId) : null,
    dishes: Math.round(waiting),
    keys,
  };
};

// The keys of a moment that are news for a phone whose alerts began at
// `since`: from after it, and from the last quarter of an hour.
const freshKeys = (moment, { since, now = Date.now() }) => {
  const from = Math.max(timeOf(since) || 0, now - FRESH_MS);
  return moment.keys.filter((entry) => Number.isFinite(entry.at) && entry.at >= from && entry.at <= now + 60000).map((entry) => entry.key);
};

// --- Who --------------------------------------------------------------------------

// Off shift by the time clock: the last punch of the past week a clock-out,
// or a clock-in with no clock-out since that is a forgotten one. Someone who
// does not use the time clock (no punch in a week) is never off shift here.
// `sub.lastPunch`: { type, at, clockInAt } or null.
const offShift = (sub, now = Date.now()) => {
  const punch = sub.lastPunch;
  if (!punch || !punch.type) return false;
  if (punch.type === 'clock_out') return true;
  const start = timeOf(punch.clockInAt || punch.at);
  return Number.isFinite(start) && now - start > STALE_HOURS * 3600000;
};

// The tables the captain app shows someone working in `outletId`: that
// outlet's and those of no outlet; every one with none.
const shownTo = (table, outletId) => Boolean(table) && (!outletId || !table.outletId || same(table.outletId, outletId));

// Whether the phone of `sub` is alerted for `moment`.
//   sub        { userId, outletId, allTables, permissions[], lastPunch }
//   features   the restaurant's features switched on (a Set)
//   tables     its active tables: Map of id -> { outletId }
//   captainOf  (outletId) -> Map of table id -> the captain's user id today
//              (empty while captain sections are switched off)
const receives = (sub, moment, { features, tables, captainOf, now = Date.now() }) => {
  const can = (code) => (sub.permissions || []).includes(code);
  if (!moment || !features.has('captain_app') || !can('orders.create')) return false;
  const table = tables.get(String(moment.tableId));
  if (!shownTo(table, sub.outletId)) return false;

  if (moment.kind === 'ready') {
    // The pass: the kitchen display's, for whoever may read an order's tickets, at their outlet.
    if (!features.has('kitchen_display') || !(can('kot.manage') || can('kds.view'))) return false;
    if (sub.outletId && !same(moment.ticketOutletId, sub.outletId)) return false;
  } else {
    // The inbox: a waiter's bill ask always, a guest's request while QR ordering is on.
    if (!can('orders.view')) return false;
    if (!moment.askedBy && !(moment.channel === 'qr' && features.has('qr_ordering'))) return false;
    if (sub.outletId && !same(moment.requestOutletId, sub.outletId) && !(!moment.requestOutletId && moment.channel === 'qr')) return false;
    if (moment.askedBy && same(moment.askedBy, sub.userId)) return false;
  }

  // My tables: a captain with a section today among the tables shown hears of
  // those only, unless they chose All tables.
  const captains = captainOf(sub.outletId) || new Map();
  let mine = 0;
  for (const [tableId, userId] of captains) {
    if (same(userId, sub.userId) && shownTo(tables.get(String(tableId)), sub.outletId)) mine += 1;
  }
  if (mine > 0 && !sub.allTables && !same(captains.get(String(moment.tableId)), sub.userId)) return false;

  return !offShift(sub, now);
};

// --- Words ------------------------------------------------------------------------

const CALLS = {
  call_waiter: ['is calling', 'Wants a waiter'],
  bill: ['wants the bill', 'Wants the bill'],
  water: ['asked for water', 'Asked for water'],
  other: ['needs something', 'Needs something'],
};

// The notification: short, the table and what is waiting, never a guest's
// name, number or note. Tagged per table, so a newer alert at a table
// replaces the one before on the phone; a topic per table and kind, so the
// push service replaces one still waiting for a phone that is off.
const message = (moment) => {
  const table = `Table ${moment.tableNo}`;
  const place = moment.outletName ? ` · ${moment.outletName}` : '';
  let title;
  let body;
  if (moment.kind === 'ready') {
    title = moment.dishes > 0 ? `${table}: ${plural(moment.dishes, 'dish', 'dishes')} ready` : `${table}: food ready`;
    body = `At the pass, to carry out${place}`;
  } else if (moment.kind === 'order') {
    title = `${table} sent an order`;
    body = `From its QR code${moment.itemCount ? ` · ${plural(moment.itemCount, 'item', 'items')}` : ''}, waiting for a yes${place}`;
  } else {
    const [said, detail] = CALLS[moment.type] || CALLS.other;
    title = `${table} ${said}`;
    body = moment.askedBy ? `Asked from the captain app${place}` : `${detail} from the table's QR code${place}`;
  }
  return {
    payload: {
      title,
      body,
      url: moment.kind === 'ready' ? '/captain/ready' : '/captain/calls',
      tag: `table-${moment.tableId}`,
      kind: moment.kind,
      table: moment.tableNo,
      orderId: moment.orderId || null,
    },
    topic: `t${moment.tableId}${moment.kind === 'ready' ? 'food' : moment.kind}`.slice(0, 32),
    ttl: TTL[moment.kind],
    urgency: 'high',
  };
};

// A test alert to one's own phone.
const testMessage = () => ({
  payload: { title: 'Test alert', body: 'Alerts reach this phone even while the captain app is closed.', url: '/captain', tag: 'test', kind: 'test' },
  topic: 'test',
  ttl: 60,
  urgency: 'high',
});

module.exports = { FRESH_MS, STALE_HOURS, TTL, requestMoment, waitingDishes, foodMoment, freshKeys, offShift, shownTo, receives, message, testMessage };
