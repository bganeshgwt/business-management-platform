// The captain app's floor: whose tables these are, and what is waiting at
// each one, worked out from what the POS, Table requests and the kitchen
// already read (GET /tables, /orders, /table-requests and /kitchen/pass).
// Nothing here decides a rule of its own: a table's captain of the day comes
// from the server's captain sections, and the states from the floor plan.
//
// Kept free of React and of the API, so the rules can be tested on their own.

import { CALL_META } from "../../modules/restaurant/orders/services/tableRequestWords.js";

// The captain app's order screen: the POS's own, in its phone layout. It
// takes ?table= to start an order, ?order= to open one and &bill=1 to go on
// to its bill, as the POS does.
export const ORDER_SCREEN = "/captain/order";

export const orderLink = (orderId) => `${ORDER_SCREEN}?order=${orderId}`;

const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

// The tables a person has today by the captain sections (GET /tables names
// each table's captain: its own line of the day's plan, else its section's,
// else its floor's; nobody's while Captain sections is switched off). Empty
// for someone with no section today: then they see every table, as the POS
// shows them.
export const sectionOf = (tables, userId) =>
  userId ? (tables || []).filter((table) => table.captain && same(table.captain.userId, userId)) : [];

// The tables to show: the person's own while "My tables" is chosen and they
// have a section, every table otherwise.
export const shownTables = (tables, mine, onlyMine) => (onlyMine && mine.length > 0 ? mine : tables || []);

// Still waiting for someone: a call nobody has closed, a QR order nobody has
// accepted or rejected.
const OPEN_CALL = ["pending", "acknowledged"];
const OPEN_ORDER = ["pending", "processing"];

const empty = () => ({ calls: [], orders: [], ready: [], kitchen: null, orderId: null });

// What is waiting at each table, by table id (as a string):
//   calls    guests' open calls from the table's QR code (the API's order:
//            the longest waiting first)
//   orders   guests' QR orders waiting for a yes
//   ready    the table's tickets at the pass, the oldest first
//   kitchen  where its order is in the kitchen: pending (sent), preparing,
//            ready or served; null with no order
//   orderId  the order its guests are on
// A table pushed against another party's is that party's: its food and the
// kitchen's progress are shown once, at the party's own table.
export const waitingAt = (tables, { orders = [], requests = [], tickets = [] } = {}) => {
  const byTable = new Map((tables || []).map((table) => [String(table.id), empty()]));
  const tableOfOrder = new Map();

  for (const table of tables || []) {
    if (table.live && table.live.orderId) {
      byTable.get(String(table.id)).orderId = table.live.orderId;

      if (!table.live.joinedTo) {
        tableOfOrder.set(String(table.live.orderId), String(table.id));
      }
    }
  }

  for (const order of orders) {
    const at = byTable.get(tableOfOrder.get(String(order.id)));

    if (at) {
      at.kitchen = order.kitchenStatus || null;
    }
  }

  for (const request of requests) {
    const at = request.tableId ? byTable.get(String(request.tableId)) : null;

    if (!at) {
      continue;
    }

    if (request.type === "order") {
      if (OPEN_ORDER.includes(request.status)) {
        at.orders.push(request);
      }
    } else if (OPEN_CALL.includes(request.status)) {
      at.calls.push(request);
    }
  }

  for (const ticket of tickets) {
    const at = byTable.get(tableOfOrder.get(String(ticket.orderId)));

    if (at) {
      at.ready.push(ticket);
    }
  }

  return byTable;
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// How long plated food has waited at the pass: going cold at half the
// kitchen's pass time, late after all of it (the kitchen display's marks).
export const passTone = (ticket, now, passMinutes = 8) => {
  const since = ticket && ticket.readyAt ? now - new Date(ticket.readyAt).getTime() : 0;

  return since >= passMinutes * 60000 ? "late" : since >= (passMinutes * 60000) / 2 ? "warning" : "calm";
};

// What a table's tile says beside its state, the most urgent first:
//   a guest calling (a waiter, water, something else)    danger
//   the bill asked for from the QR code                   warning
//   a QR order waiting for a yes                          warning
//   food at the pass (late: danger)                       success
//   the order sent to the kitchen, or being cooked        info
//   the guests seated, or the party it is joined to       neutral
// [{ key, label, tone }]
export const marksOf = (table, waiting, { now = Date.now(), passMinutes = 8 } = {}) => {
  const at = waiting || empty();
  const marks = [];
  const calls = at.calls.filter((call) => call.type !== "bill");
  const bill = at.calls.some((call) => call.type === "bill");

  if (calls.length > 1) {
    marks.push({ key: "call", label: `${calls.length} calls`, tone: "danger" });
  } else if (calls.length === 1) {
    marks.push({ key: "call", label: (CALL_META[calls[0].type] || CALL_META.other).title, tone: "danger" });
  }

  if (bill) {
    marks.push({ key: "bill", label: CALL_META.bill.title, tone: "warning" });
  }

  if (at.orders.length > 0) {
    marks.push({ key: "qr", label: at.orders.length === 1 ? "QR order waiting" : `${at.orders.length} QR orders waiting`, tone: "warning" });
  }

  if (at.ready.length > 0) {
    const dishes = at.ready.reduce(
      (sum, ticket) => sum + (ticket.items || []).reduce((count, item) => count + Math.max(0, Number(item.liveQuantity) || 0), 0),
      0
    );
    const late = at.ready.some((ticket) => passTone(ticket, now, passMinutes) === "late");

    marks.push({ key: "ready", label: dishes > 0 ? `Food ready · ${plural(dishes, "dish", "dishes")}` : "Food ready", tone: late ? "danger" : "success" });
  } else if (at.kitchen === "ready") {
    marks.push({ key: "ready", label: "Food ready", tone: "success" });
  } else if (at.kitchen === "preparing") {
    marks.push({ key: "kitchen", label: "Cooking", tone: "info" });
  } else if (at.kitchen === "pending") {
    marks.push({ key: "kitchen", label: "Order sent", tone: "info" });
  }

  const live = table.live;

  if (live && live.joinedTo) {
    marks.push({ key: "joined", label: `With ${live.joinedTo}`, tone: "neutral" });
  } else if (live && live.guestCount) {
    marks.push({ key: "covers", label: plural(Number(live.guestCount), "guest", "guests"), tone: "neutral" });
  }

  return marks;
};

// What the Calls and Ready tabs count, over the tables shown: the calls and
// QR orders waiting, and the tickets at the pass.
export const countsOf = (tables, waiting) => {
  let calls = 0;
  let ready = 0;

  for (const table of tables || []) {
    const at = waiting.get(String(table.id));

    if (at) {
      calls += at.calls.length + at.orders.length;
      ready += at.ready.length;
    }
  }

  return { calls, ready };
};

// Every call, QR order or ticket at the pass (`kind`: calls, orders, ready)
// waiting at the tables shown, each with its table, the longest waiting
// first: what the Calls and Ready lists show.
export const waitingList = (tables, waiting, kind) => {
  const shown = new Map((tables || []).map((table) => [String(table.id), table]));
  const list = [];

  for (const [tableId, at] of waiting) {
    const table = shown.get(tableId);

    if (table) {
      for (const entry of at[kind]) {
        list.push({ table, entry });
      }
    }
  }

  const since = ({ entry }) => new Date(entry.readyAt || entry.createdAt || 0).getTime();

  return list.sort((a, b) => since(a) - since(b));
};

// What rings the phone: a call, a QR order or food at the pass at the tables
// shown that was not there at the last look. `seen` is the keys of the last
// look (null the first time, when nothing rings). Returns { keys, fresh }:
// every key now, and the new ones as { kind, table, entry }.
export const arrivals = (seen, tables, waiting) => {
  const keys = new Set();
  const fresh = [];

  for (const kind of ["calls", "orders", "ready"]) {
    for (const { table, entry } of waitingList(tables, waiting, kind)) {
      const key = `${kind}:${entry.id}`;
      keys.add(key);

      if (seen && !seen.has(key)) {
        fresh.push({ kind, table, entry });
      }
    }
  }

  return { keys, fresh };
};

// What a new arrival says on the screen: "Table 4: asked for water".
export const arrivalText = ({ kind, table, entry }) => {
  if (kind === "ready") {
    return `Food ready for table ${table.tableNo}`;
  }

  if (kind === "orders") {
    return `Table ${table.tableNo} sent an order from its QR code`;
  }

  const meta = CALL_META[entry.type] || CALL_META.other;

  return `Table ${table.tableNo}: ${meta.title.charAt(0).toLowerCase()}${meta.title.slice(1)}`;
};
