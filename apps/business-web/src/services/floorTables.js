// How the till describes a table, in the words a waiter uses: free, eating
// (how long, how much), joined to another table's party, being cleaned, out
// of service, or held for a booking ("Held for 8:30 · Rao · 4").
//
// Kept free of React so the rules can be tested on their own.

// "20:30" -> "8:30"; the floor knows whether it is lunch or dinner.
const shortTime = (hhmm) => {
  const [hours, minutes] = String(hhmm || "").split(":").map(Number);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return String(hhmm || "");
  }

  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")}`;
};

// "Held for 8:30 · Anita Rao · 4": when, who, how many.
export const heldText = (booking) =>
  booking ? `Held for ${shortTime(booking.startTime)} · ${booking.guestName} · ${booking.partySize}` : "";

// The same, as a sentence: "held for Anita Rao at 8:30 (4 guests)".
export const heldSentence = (booking) =>
  booking
    ? `held for ${booking.guestName} at ${shortTime(booking.startTime)} (${booking.partySize} ${booking.partySize === 1 ? "guest" : "guests"})`
    : "";

// "25 Sep": the app's own month names, the same on every browser.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const dayMonth = (value) => {
  if (!value) {
    return "";
  }

  const text = String(value);
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = plain ? new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3])) : new Date(text);

  return Number.isNaN(date.getTime()) ? text : `${date.getDate()} ${MONTHS[date.getMonth()]}`;
};

// Which party each joined table belongs to, from GET /orders/joined-tables
// (open orders and billed ones not yet paid: a party waiting for its change
// is still sitting there): Map tableId -> { orderId, orderNumber,
// mainTableNo, orderStatus }.
export const joinedTableMap = (joins) => {
  const map = new Map();

  for (const join of joins || []) {
    map.set(join.tableId, {
      orderId: join.orderId,
      orderNumber: join.orderNumber,
      mainTableNo: join.mainTableNo,
      orderStatus: join.orderStatus,
    });
  }

  return map;
};

// Why a table is out of service, when it is not the table's own switch.
const OFF_BECAUSE = { floor: "Floor closed", area: "Section closed" };

// Where an order sits, joined tables included: "PF2 + PF3".
export const tablesText = (order) =>
  [order.tableNo, ...(order.joinedTables || []).map((table) => table.tableNo)].filter(Boolean).join(" + ");

// { state, label, note, orderId }
//   state: free | running | printed | paid | joined | held | cleaning | off
export const describeTable = (table, joinedBy) => {
  const joined = joinedBy ? joinedBy.get(table.id) : null;

  if (table.live) {
    const state = table.live.fullyPaid ? "paid" : table.live.billId ? "printed" : "running";

    return {
      state,
      label: state === "paid" ? "Paid" : state === "printed" ? "Bill printed" : "Eating",
      note: table.live.guestCount ? `${table.live.guestCount} guests` : null,
      orderId: table.live.orderId,
      orderNumber: table.live.orderNumber,
    };
  }

  if (joined) {
    return {
      state: "joined",
      label: `With ${joined.mainTableNo}`,
      note: joined.orderNumber,
      orderId: joined.orderId,
      orderNumber: joined.orderNumber,
    };
  }

  if (table.inService === false) {
    return { state: "off", label: "Out of service", note: OFF_BECAUSE[table.outOfServiceReason] || null };
  }

  if (table.turn || table.floorState === "cleaning") {
    return { state: "cleaning", label: "Being cleaned", note: `${table.capacity} seats` };
  }

  // "Held for 8:30 · Anita Rao · 4", on two lines so a narrow tile keeps it.
  if (table.booking) {
    return {
      state: "held",
      label: `Held for ${shortTime(table.booking.startTime)}`,
      note: `${table.booking.guestName} · ${table.booking.partySize}`,
      booking: table.booking,
    };
  }

  return { state: "free", label: "Free", note: `${table.capacity} seats` };
};

// The extra line a tile shows when the table cannot be chosen here ("Guests
// are eating here"), or null when it would only repeat what the tile already
// says ("Out of service" twice on one tile).
export const tileWhy = (off, info) => (off && off !== info.label && off !== info.note ? off : null);

// Tables by floor, then by section, in the order the floor plan keeps them.
export const groupTables = (tables) => {
  const groups = [];

  for (const table of tables) {
    const name = table.areaName ? `${table.floorName} · ${table.areaName}` : table.floorName || "Tables";
    let group = groups.find((one) => one.name === name);

    if (!group) {
      group = { name, tables: [] };
      groups.push(group);
    }

    group.tables.push(table);
  }

  return groups;
};

// The order source a delivery channel stands for: Swiggy and Zomato orders
// are partner orders, a phone order is a phone order, and so on.
export const sourceForChannel = (channel) =>
  ({ aggregator: "partner", phone: "phone", website: "website", own: "pos" })[channel && channel.type] || "pos";
