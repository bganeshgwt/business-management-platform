const stockTransferRepository = require("../repositories/stockTransfer.repository");
const inventoryRepository = require("../repositories/inventory.repository");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const stockSettingsService = require("./stockSettings.service");
const { pinnedStore, ONE_OUTLET } = require("./inventory.service");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const tradingDay = require("../../business-day/services/tradingDay");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// Transfer notes between stores, and indents (sweep SW-B-11).
//
//   * One note carries many items from one store to another, numbered
//     TRF-0001, valued at cost, printable as a delivery challan.
//   * With "the receiving store confirms" on (Settings → Stock & purchasing)
//     stock leaves the sender at dispatch and travels "in transit" until the
//     receiver checks it; anything short or damaged is written off at the
//     receiving store with the reason. Otherwise a note lands at once.
//   * An outlet asks for stock with an indent; the main store (or whichever
//     store it asked) sends it, all at once or in parts, as notes against it.
//     Both sides see where it stands.
//   * Batches travel with the stock, first to expire first.
//   * Someone tied to one outlet sends from, receives into, and asks for their
//     own store only, and sees the notes and indents that involve it.
//
// A store is named by its outlet id; null is the main store.

const MAX_LINES = 200;
const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));
const storeKey = (id) => (id === null || id === undefined ? null : Number(id));

const STATUS_WORDS = { in_transit: "in transit", received: "received", cancelled: "cancelled" };

const toTransferSummary = (row) => ({
  id: row.id,
  transferNumber: row.transfer_number,
  fromOutletId: numberOrNull(row.from_outlet_id),
  toOutletId: numberOrNull(row.to_outlet_id),
  fromName: row.from_name,
  toName: row.to_name,
  indentId: numberOrNull(row.indent_id),
  indentNumber: row.indent_number || null,
  transferDate: row.transfer_date,
  status: row.transfer_status,
  twoStep: row.two_step,
  sentValue: Number(row.sent_value),
  receivedValue: numberOrNull(row.received_value),
  shortfallValue: numberOrNull(row.shortfall_value),
  vehicle: row.vehicle,
  notes: row.notes,
  lineCount: row.line_count,
  dispatchedAt: row.dispatched_at,
  dispatchedByName: row.dispatched_by_name || null,
  receivedAt: row.received_at,
  receivedByName: row.received_by_name || null,
  receiptNote: row.receipt_note || null,
  cancelledAt: row.cancelled_at,
  cancelReason: row.cancel_reason || null,
});

const toTransfer = (row) => ({
  ...toTransferSummary({ ...row, line_count: row.lines.length }),
  fromAddress: row.from_address || null,
  toAddress: row.to_address || null,
  cancelledByName: row.cancelled_by_name || null,
  lines: row.lines.map((line) => ({
    id: line.id,
    inventoryItemId: Number(line.inventory_item_id),
    itemName: line.item_name,
    itemCode: line.item_code,
    unit: line.unit,
    indentLineId: numberOrNull(line.indent_line_id),
    quantity: Number(line.quantity),
    unitCost: numberOrNull(line.unit_cost),
    value: Number(line.value),
    receivedQuantity: numberOrNull(line.received_quantity),
    shortfallQuantity: numberOrNull(line.shortfall_quantity),
    shortfallReason: line.shortfall_reason || null,
    shortfallNote: line.shortfall_note || null,
    batches: (Array.isArray(line.batch_allocations) ? line.batch_allocations : []).length,
  })),
});

const toIndent = (row) => ({
  id: row.id,
  indentNumber: row.indent_number,
  outletId: Number(row.outlet_id),
  outletName: row.outlet_name,
  supplyOutletId: numberOrNull(row.supply_outlet_id),
  supplyName: row.supply_name,
  neededBy: row.needed_by,
  status: row.indent_status,
  notes: row.notes,
  closedReason: row.closed_reason || null,
  closedAt: row.closed_at || null,
  closedByName: row.closed_by_name || null,
  createdAt: row.created_at,
  createdByName: row.created_by_name || null,
  lineCount: row.line_count ?? (row.lines ? row.lines.length : undefined),
  openLines: row.open_lines ?? undefined,
  ...(row.lines
    ? {
        lines: row.lines.map((line) => ({
          id: line.id,
          inventoryItemId: Number(line.inventory_item_id),
          itemName: line.item_name,
          unit: line.unit,
          active: line.item_status === "active",
          quantity: Number(line.quantity),
          sentQuantity: Number(line.sent_quantity),
          receivedQuantity: Number(line.received_quantity),
          stillToSend: round3(Math.max(0, Number(line.quantity) - Number(line.sent_quantity))),
          supplyStock: round3(line.supply_stock),
          note: line.note,
        })),
        transfers: row.transfers.map((transfer) => ({
          id: transfer.id,
          transferNumber: transfer.transfer_number,
          status: transfer.transfer_status,
          dispatchedAt: transfer.dispatched_at,
          receivedAt: transfer.received_at,
          sentValue: Number(transfer.sent_value),
        })),
      }
    : {}),
});

// --- Stores ---

// A store named by its outlet (null = the main store): it must be this
// restaurant's, and stock can only leave a store that keeps it.
const storeOf = async (restaurantId, outletId) => {
  if (outletId === null || outletId === undefined) {
    return { outletId: null, storeId: null, name: "Main store", status: "active", ownStore: true };
  }

  const outlet = await inventoryRepository.findOutlet(restaurantId, outletId);

  if (!outlet) {
    throw new AppError(400, "That outlet does not belong to your restaurant");
  }

  return {
    outletId: Number(outlet.id),
    storeId: outlet.own_store ? Number(outlet.id) : null,
    name: outlet.name,
    status: outlet.status,
    ownStore: outlet.own_store,
  };
};

// The store a pinned person works with, or null for owners and managers who
// are not tied to one outlet.
const mineFor = async (restaurantId, pinnedOutletId) => pinnedStore(restaurantId, pinnedOutletId);

const requireMine = (mine, storeId, words) => {
  if (mine && storeKey(storeId) !== mine.storeId) {
    throw new AppError(403, words || ONE_OUTLET);
  }
};

// --- Transfer notes ---

const listTransfers = async (restaurantId, filters, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const mine = await mineFor(restaurantId, pinnedOutletId);
  const scope = {
    ...filters,
    store: mine ? { storeId: mine.storeId } : filters.storeId !== undefined ? { storeId: filters.storeId } : null,
    direction: filters.direction || null,
  };
  const [{ rows, total }, transit] = await Promise.all([
    stockTransferRepository.findTransfers(restaurantId, scope),
    stockTransferRepository.transitTotals(restaurantId, scope),
  ]);
  const items = rows.map(toTransferSummary);

  return {
    items,
    total,
    limit: filters.limit || 100,
    offset: filters.offset || 0,
    // Every note on the road, whatever the dates or page on show.
    inTransit: { count: transit.count, value: round2(transit.value) },
  };
};

const getTransfer = async (restaurantId, id, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const row = await stockTransferRepository.findTransferById(restaurantId, id);
  const mine = await mineFor(restaurantId, pinnedOutletId);

  // Another store's note is, for someone tied to one outlet, a note that
  // does not exist — the same answer as an id from another restaurant.
  if (
    !row ||
    (mine && storeKey(row.from_outlet_id) !== mine.storeId && storeKey(row.to_outlet_id) !== mine.storeId)
  ) {
    throw new AppError(404, "Transfer note not found");
  }

  return toTransfer(row);
};

// Lines as typed: each item once, a quantity above zero, all this
// restaurant's active items. Rounded to the gram.
const readLines = async (restaurantId, lines) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AppError(400, "Add at least one item to send");
  }

  if (lines.length > MAX_LINES) {
    throw new AppError(400, `One note can carry up to ${MAX_LINES} items. Split it into two notes.`);
  }

  const seen = new Set();
  const read = [];

  for (const line of lines) {
    const quantity = round3(line.quantity);

    if (!(quantity > 0)) {
      continue;
    }

    const id = Number(line.inventoryItemId);

    if (seen.has(id)) {
      throw new AppError(400, "The same item is on the note twice");
    }

    seen.add(id);

    const item = await inventoryRepository.findItemById(restaurantId, id);

    if (!item) {
      throw new AppError(400, "One of the items does not exist");
    }

    read.push({ ...line, inventoryItemId: id, quantity, item });
  }

  if (read.length === 0) {
    throw new AppError(400, "Enter a quantity above zero for at least one item");
  }

  return read;
};

// The open day's date; with none open, today on the restaurant's clock, or
// last night's until the cut-off hour when that day was just closed.
const businessDateFor = async (restaurantId) => {
  const day = await businessDayRepository.findOpen(restaurantId);

  return day
    ? day.business_date
    : tradingDay.dateWithNoDayOpenAt(restaurantId, undefined, await restaurantRepository.findSettings(restaurantId));
};

// Sends one note. data: { fromOutletId, toOutletId, lines: [{ inventoryItemId,
// quantity, indentLineId? }], vehicle, notes, indentId? }
const dispatch = async (restaurantId, data, userId, { pinnedOutletId = null, indent = null } = {}) => {
  requireRestaurantId(restaurantId);

  const from = await storeOf(restaurantId, data.fromOutletId);
  const to = await storeOf(restaurantId, data.toOutletId);

  if (storeKey(from.outletId) === storeKey(to.outletId)) {
    throw new AppError(400, "Choose two different stores to send stock between");
  }

  // Stock leaves a shelf; an outlet that sells from the main store has none.
  if (from.outletId && !from.ownStore) {
    throw new AppError(
      400,
      `${from.name} does not keep its own stock — its sales come from the main store. Send from the main store instead.`
    );
  }

  // Nothing new goes onto a closed outlet's shelf.
  if (to.outletId && to.status !== "active") {
    throw new AppError(400, `${to.name} is not active, so stock cannot be sent there. Set the outlet active first.`);
  }

  // Someone tied to one outlet sends their own stock, nobody else's.
  const mine = await mineFor(restaurantId, pinnedOutletId);
  requireMine(mine, from.storeId, `You are set up to work at one outlet only, so you can send stock from ${mine ? mine.name : "your store"} only.`);

  const lines = await readLines(restaurantId, data.lines);
  const balances = new Map();

  for (const line of lines) {
    if (!balances.has(line.inventoryItemId)) {
      balances.set(line.inventoryItemId, await inventoryRepository.findBalances(restaurantId, line.inventoryItemId));
    }

    const held = balances
      .get(line.inventoryItemId)
      .find((row) => storeKey(row.outlet_id) === storeKey(from.storeId));
    const available = held ? Number(held.quantity) : 0;

    if (line.quantity > available + 0.0000001) {
      throw new AppError(
        400,
        `Only ${round3(available)} ${line.item.unit_short_name} of ${line.item.name} is held at ${from.name}. Lower the quantity or leave it off this note.`
      );
    }
  }

  // Against an indent: only what it asks for, and no more than is still
  // asked for.
  if (indent) {
    for (const line of lines) {
      const asked = indent.lines.find((entry) => entry.inventoryItemId === line.inventoryItemId);

      if (!asked) {
        throw new AppError(400, `${line.item.name} is not on ${indent.indentNumber}. Send it on a note of its own.`);
      }

      if (line.quantity > asked.stillToSend + 0.0000001) {
        throw new AppError(
          400,
          `Only ${asked.stillToSend} ${asked.unit} of ${asked.itemName} is still asked for on ${indent.indentNumber}.`
        );
      }

      line.indentLineId = asked.id;
    }
  }

  const settings = await stockSettingsService.get(restaurantId);
  const result = await stockTransferRepository.dispatch(
    restaurantId,
    {
      fromStoreId: from.storeId,
      toOutletId: to.outletId,
      indentId: indent ? indent.id : null,
      transferDate: await businessDateFor(restaurantId),
      twoStep: settings.transferReceiptRequired,
      vehicle: data.vehicle,
      notes: data.notes,
      fromName: from.name,
      toName: to.name,
      lines: lines.map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        indentLineId: line.indentLineId || null,
        itemName: line.item.name,
      })),
    },
    userId
  );

  if (result.error === "NEGATIVE_STOCK") {
    throw new AppError(
      400,
      `Only ${round3(result.available)} of ${result.itemName} is held at ${from.name} now — someone used some meanwhile. Check the note and send again.`
    );
  }

  return getTransfer(restaurantId, result.id);
};

// The receiving store confirms what arrived. data: { lines: [{ lineId,
// receivedQuantity, shortfallReason, shortfallNote }], note }. Every line must
// be answered; a line that came short needs a reason.
const REASONS = ["short", "damaged", "spoiled"];

const receive = async (restaurantId, id, data, userId, { pinnedOutletId = null } = {}) => {
  const transfer = await getTransfer(restaurantId, id, { pinnedOutletId });
  const mine = await mineFor(restaurantId, pinnedOutletId);

  requireMine(mine, transfer.toOutletId === null ? null : (await storeOf(restaurantId, transfer.toOutletId)).storeId,
    `${transfer.transferNumber} is going to ${transfer.toName}. Only that store can confirm what arrived.`);

  if (transfer.status !== "in_transit") {
    throw new AppError(409, `${transfer.transferNumber} is already ${STATUS_WORDS[transfer.status] || transfer.status}`);
  }

  const answers = [];

  for (const line of transfer.lines) {
    const entry = (data.lines || []).find((row) => Number(row.lineId) === Number(line.id));

    if (!entry || entry.receivedQuantity === undefined || entry.receivedQuantity === null || entry.receivedQuantity === "") {
      throw new AppError(400, `Say how much ${line.itemName} arrived (0 if none did)`);
    }

    const received = round3(entry.receivedQuantity);

    if (!(received >= 0)) {
      throw new AppError(400, `How much ${line.itemName} arrived must be a number, 0 or more`);
    }

    if (received > line.quantity + 0.0000001) {
      throw new AppError(
        400,
        `${received} ${line.unit} of ${line.itemName} is more than the ${line.quantity} ${line.unit} sent on this note. Anything extra goes on a note of its own.`
      );
    }

    const short = round3(line.quantity - received);

    if (short > 0 && !REASONS.includes(entry.shortfallReason)) {
      throw new AppError(
        400,
        `${line.itemName} came ${short} ${line.unit} short. Say whether it was short, damaged or spoiled, so it can be written off.`
      );
    }

    answers.push({
      lineId: line.id,
      receivedQuantity: received,
      shortfallReason: short > 0 ? entry.shortfallReason : null,
      shortfallNote: short > 0 ? (entry.shortfallNote ? String(entry.shortfallNote).slice(0, 200) : null) : null,
    });
  }

  const result = await stockTransferRepository.receive(restaurantId, id, { lines: answers, note: data.note }, userId);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Transfer note not found");
  }

  if (result.error === "NOT_IN_TRANSIT") {
    throw new AppError(409, `${transfer.transferNumber} is already ${STATUS_WORDS[result.status] || result.status}`);
  }

  return getTransfer(restaurantId, id);
};

// A note sent by mistake, still on the road: the stock goes back to the
// sending store. Only the sender (or someone not tied to one outlet) can.
const cancel = async (restaurantId, id, reason, userId, { pinnedOutletId = null } = {}) => {
  const transfer = await getTransfer(restaurantId, id, { pinnedOutletId });
  const mine = await mineFor(restaurantId, pinnedOutletId);
  const from = await storeOf(restaurantId, transfer.fromOutletId);

  requireMine(mine, from.storeId, `${transfer.transferNumber} was sent by ${transfer.fromName}. Only that store can call it back.`);

  if (transfer.status !== "in_transit") {
    throw new AppError(
      409,
      transfer.status === "received"
        ? `${transfer.transferNumber} has already been received. Send the stock back on a new note instead.`
        : `${transfer.transferNumber} is already cancelled`
    );
  }

  const result = await stockTransferRepository.cancel(restaurantId, id, reason, userId);

  if (result.error === "NOT_IN_TRANSIT") {
    throw new AppError(409, `${transfer.transferNumber} is already ${STATUS_WORDS[result.status] || result.status}`);
  }

  return getTransfer(restaurantId, id);
};

// --- Indents ---

const listIndents = async (restaurantId, filters, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const mine = await mineFor(restaurantId, pinnedOutletId);
  const scope = { ...filters, store: mine ? { outletId: Number(pinnedOutletId), storeId: mine.storeId } : null };
  const [{ rows, total }, open] = await Promise.all([
    stockTransferRepository.findIndents(restaurantId, scope),
    stockTransferRepository.openIndentCount(restaurantId, scope),
  ]);

  return {
    items: rows.map(toIndent),
    total,
    limit: filters.limit || 100,
    offset: filters.offset || 0,
    // Every indent still waiting, whatever the dates or page on show.
    open,
  };
};

const getIndent = async (restaurantId, id, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const row = await stockTransferRepository.findIndentById(restaurantId, id);
  const mine = await mineFor(restaurantId, pinnedOutletId);

  if (
    !row ||
    (mine && Number(row.outlet_id) !== Number(pinnedOutletId) && storeKey(row.supply_outlet_id) !== mine.storeId)
  ) {
    throw new AppError(404, "Indent not found");
  }

  return toIndent(row);
};

// data: { outletId, supplyOutletId, neededBy, notes, lines: [{ inventoryItemId,
// quantity, note }] }. Someone tied to one outlet asks for their own outlet.
const createIndent = async (restaurantId, data, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const outletId = pinnedOutletId ? Number(pinnedOutletId) : data.outletId;

  if (!outletId) {
    throw new AppError(400, "Choose the outlet the stock is for");
  }

  if (pinnedOutletId && data.outletId && Number(data.outletId) !== Number(pinnedOutletId)) {
    throw new AppError(403, ONE_OUTLET);
  }

  const asking = await storeOf(restaurantId, outletId);
  const supplying = await storeOf(restaurantId, data.supplyOutletId ?? null);

  if (asking.status !== "active") {
    throw new AppError(400, `${asking.name} is not active, so it cannot ask for stock.`);
  }

  if (!asking.ownStore) {
    throw new AppError(
      400,
      `${asking.name} sells from the main store and keeps no stock of its own, so it has nothing to ask for. Switch on "keeps its own stock" under Stores first.`
    );
  }

  if (supplying.outletId && !supplying.ownStore) {
    throw new AppError(400, `${supplying.name} keeps no stock of its own. Ask the main store instead.`);
  }

  if (storeKey(supplying.storeId) === storeKey(asking.storeId)) {
    throw new AppError(400, "An outlet cannot ask itself for stock. Choose the store that will send it.");
  }

  const lines = await readLines(restaurantId, data.lines);

  for (const line of lines) {
    if (line.item.status !== "active") {
      throw new AppError(400, `${line.item.name} is inactive and cannot be asked for`);
    }
  }

  const result = await stockTransferRepository.createIndent(
    restaurantId,
    {
      outletId: asking.outletId,
      supplyOutletId: supplying.outletId,
      neededBy: data.neededBy,
      notes: data.notes,
      lines: lines.map((line) => ({ inventoryItemId: line.inventoryItemId, quantity: line.quantity, note: line.note })),
    },
    userId
  );

  return getIndent(restaurantId, result.id);
};

// The supplying store sends what it can: a note from it to the asking outlet,
// carrying the chosen quantities (no more than still asked for).
const fulfilIndent = async (restaurantId, id, data, userId, { pinnedOutletId = null } = {}) => {
  const indent = await getIndent(restaurantId, id, { pinnedOutletId });

  if (!["requested", "part_sent"].includes(indent.status)) {
    throw new AppError(409, `${indent.indentNumber} is ${indent.status === "sent" ? "fully sent" : indent.status} — there is nothing left to send`);
  }

  const supply = await storeOf(restaurantId, indent.supplyOutletId);
  const mine = await mineFor(restaurantId, pinnedOutletId);

  requireMine(mine, supply.storeId, `${indent.indentNumber} asks ${indent.supplyName} for stock. Only that store can send it.`);

  return dispatch(
    restaurantId,
    {
      fromOutletId: indent.supplyOutletId,
      toOutletId: indent.outletId,
      lines: data.lines,
      vehicle: data.vehicle,
      notes: data.notes || `Against ${indent.indentNumber}`,
    },
    userId,
    { pinnedOutletId, indent }
  );
};

// close: the supplying store will not send the rest (with why). cancel: the
// outlet withdraws an indent nothing has been sent against.
const closeIndent = async (restaurantId, id, kind, reason, userId, { pinnedOutletId = null } = {}) => {
  const indent = await getIndent(restaurantId, id, { pinnedOutletId });

  if (!["requested", "part_sent"].includes(indent.status)) {
    throw new AppError(409, `${indent.indentNumber} is already ${indent.status === "part_sent" ? "part sent" : indent.status}`);
  }

  if (kind === "cancelled" && indent.status !== "requested") {
    throw new AppError(409, `Stock has already been sent against ${indent.indentNumber}. Ask the main store to close the rest instead.`);
  }

  const mine = await mineFor(restaurantId, pinnedOutletId);

  if (mine) {
    if (kind === "cancelled" && Number(indent.outletId) !== Number(pinnedOutletId)) {
      throw new AppError(403, ONE_OUTLET);
    }

    if (kind === "closed") {
      requireMine(mine, (await storeOf(restaurantId, indent.supplyOutletId)).storeId);
    }
  }

  if (!(await stockTransferRepository.closeIndent(restaurantId, id, kind, reason, userId))) {
    throw new AppError(409, `${indent.indentNumber} has just been changed by someone else. Open it again.`);
  }

  return getIndent(restaurantId, id);
};

module.exports = {
  REASONS,
  listTransfers,
  getTransfer,
  dispatch,
  receive,
  cancel,
  listIndents,
  getIndent,
  createIndent,
  fulfilIndent,
  closeIndent,
};
