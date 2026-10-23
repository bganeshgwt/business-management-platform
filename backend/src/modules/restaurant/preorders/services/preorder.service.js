// Pre-orders (a bakery's cakes, a café's party trays): an order for a later
// day, with the message on the cake, an advance and when it is due.
//
//   booked → in_production → ready → collected   (or cancelled)
//
// The advance is an ordinary customer advance (Dues & accounts › Advances), so it is in
// the day's cash and its receipt is numbered with the others. On collection
// the pre-order becomes a takeaway order on today's business day; the
// advance is put on that order, so its bill takes the advance first.
const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");
const crmService = require("../../crm/services/crm.service");
const crmRepository = require("../../crm/repositories/crm.repository");
const advanceService = require("../../billing/services/customerAdvance.service");
const orderService = require("../../orders/services/order.service");
const paymentTypeService = require("../../setup/services/paymentType.service");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const tradingDay = require("../../business-day/services/tradingDay");

const OPEN = ["booked", "in_production", "ready"];
const NEXT = { booked: ["in_production", "ready"], in_production: ["ready"], ready: [] };
const n = (value) => (value === null || value === undefined ? 0 : Number(value));

const SELECT = `SELECT p.*, c.name AS customer_name, c.mobile AS customer_mobile, o.name AS outlet_name,
    a.receipt_number AS advance_receipt, a.amount AS advance_amount, (a.amount - a.used_amount - a.refunded_amount) AS advance_held,
    ord.order_number, u.name AS created_by_name,
    COALESCE((SELECT json_agg(json_build_object('id', i.id, 'productId', i.product_id, 'productVariantId', i.product_variant_id,
        'name', pr.name || COALESCE(' (' || v.name || ')', ''), 'quantity', i.quantity, 'unitPrice', i.unit_price, 'notes', i.notes,
        'soldBy', pr.sold_by) ORDER BY i.id)
      FROM restaurant_preorder_items i JOIN products pr ON pr.id = i.product_id LEFT JOIN product_variants v ON v.id = i.product_variant_id
      WHERE i.preorder_id = p.id), '[]') AS items
  FROM restaurant_preorders p
  JOIN customers c ON c.id = p.customer_id
  LEFT JOIN outlets o ON o.id = p.outlet_id
  LEFT JOIN customer_advances a ON a.id = p.advance_id
  LEFT JOIN orders ord ON ord.id = p.order_id
  LEFT JOIN users u ON u.id = p.created_by
  WHERE p.restaurant_id = $1`;

const toPreorder = (row) => ({
  id: Number(row.id),
  number: row.preorder_number,
  status: row.status,
  customerId: Number(row.customer_id),
  customerName: row.customer_name,
  customerMobile: row.customer_mobile || null,
  dueAt: row.due_at,
  fulfilment: row.fulfilment,
  deliveryAddress: row.delivery_address || null,
  notes: row.notes || null,
  outletId: row.outlet_id ? Number(row.outlet_id) : null,
  outletName: row.outlet_name || null,
  estimatedTotal: n(row.estimated_total),
  advanceId: row.advance_id ? Number(row.advance_id) : null,
  advanceReceipt: row.advance_receipt || null,
  advanceAmount: n(row.advance_amount),
  advanceHeld: n(row.advance_held),
  balanceDue: Math.max(0, Math.round((n(row.estimated_total) - n(row.advance_amount)) * 100) / 100),
  orderId: row.order_id ? Number(row.order_id) : null,
  orderNumber: row.order_number || null,
  cancelReason: row.cancel_reason || null,
  items: (row.items || []).map((item) => ({ ...item, quantity: n(item.quantity), unitPrice: n(item.unitPrice) })),
  createdAt: row.created_at,
  createdByName: row.created_by_name || null,
  collectedAt: row.collected_at || null,
});

const findOne = async (restaurantId, id, db = pool) => {
  const row = (await db.query(`${SELECT} AND p.id = $2`, [restaurantId, id])).rows[0];

  if (!row) {
    throw new AppError(404, "Pre-order not found");
  }

  return toPreorder(row);
};

// filters: { status: open | <status> | all, from, to (due dates), search }
const list = async (restaurantId, filters = {}) => {
  const values = [restaurantId];
  const where = [];

  if (!filters.status || filters.status === "open") {
    where.push("p.status IN ('booked','in_production','ready')");
  } else if (filters.status !== "all") {
    values.push(filters.status);
    where.push(`p.status = $${values.length}`);
  }

  if (filters.from) {
    values.push(filters.from);
    where.push(`(p.due_at AT TIME ZONE COALESCE(s.timezone,'Asia/Kolkata'))::date >= $${values.length}::date`);
  }

  if (filters.to) {
    values.push(filters.to);
    where.push(`(p.due_at AT TIME ZONE COALESCE(s.timezone,'Asia/Kolkata'))::date <= $${values.length}::date`);
  }

  if (filters.search) {
    values.push(`%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(p.preorder_number ILIKE $${values.length} OR c.name ILIKE $${values.length} OR c.mobile ILIKE $${values.length} OR p.notes ILIKE $${values.length})`);
  }

  const sql = SELECT.replace("WHERE p.restaurant_id = $1",
    "LEFT JOIN restaurant_settings s ON s.restaurant_id = p.restaurant_id WHERE p.restaurant_id = $1");
  const rows = (await pool.query(`${sql}${where.length ? ` AND ${where.join(" AND ")}` : ""} ORDER BY p.due_at, p.id LIMIT 300`, values)).rows;

  return rows.map(toPreorder);
};

// What to bake for a day: every open pre-order's items due that day, added
// up by item, each with its messages. With no day asked for, the day the till
// is trading on (the open business day, else the restaurant's own date), not
// the server's: on a server clock in UTC, a bake list opened after midnight in
// India would otherwise show the day before.
const bakeList = async (restaurantId, asked, ctx = {}) => {
  const outletId = ctx.outletId || null;
  const day = asked || (await tradingDay.currentDateOf(restaurantId, outletId, await restaurantRepository.findSettings(restaurantId, outletId)));
  const rows = (await pool.query(
    `SELECT i.product_id, pr.name || COALESCE(' (' || v.name || ')', '') AS name, pr.sold_by, sum(i.quantity) AS quantity,
        json_agg(json_build_object('number', p.preorder_number, 'dueAt', p.due_at, 'quantity', i.quantity, 'notes', i.notes, 'customer', c.name) ORDER BY p.due_at) AS orders
     FROM restaurant_preorder_items i
     JOIN restaurant_preorders p ON p.id = i.preorder_id
     JOIN restaurant_settings s ON s.restaurant_id = p.restaurant_id
     JOIN products pr ON pr.id = i.product_id LEFT JOIN product_variants v ON v.id = i.product_variant_id
     JOIN customers c ON c.id = p.customer_id
     WHERE p.restaurant_id = $1 AND p.status IN ('booked','in_production','ready')
       AND (p.due_at AT TIME ZONE s.timezone)::date = $2::date
     GROUP BY i.product_id, pr.name, v.name, pr.sold_by ORDER BY pr.name`,
    [restaurantId, day]
  )).rows;

  return { day, items: rows.map((row) => ({ productId: Number(row.product_id), name: row.name, soldBy: row.sold_by, quantity: n(row.quantity), orders: row.orders })) };
};

// The guest: the one picked, or found (or added) by mobile.
const guestFor = async (restaurantId, data, userId) => {
  if (data.customerId) {
    const guest = await crmRepository.findCustomerById(restaurantId, data.customerId);

    if (!guest || guest.erased_at) {
      throw new AppError(404, "Guest not found");
    }

    return guest.id;
  }

  if (!data.customerMobile) {
    throw new AppError(400, "Choose the guest, or type their name and mobile");
  }

  const found = await crmRepository.findCustomerByMobile(restaurantId, data.customerMobile);

  if (found && !found.erased_at) {
    return found.id;
  }

  const created = await crmService.createCustomer(restaurantId, { name: data.customerName || "Guest", mobile: data.customerMobile }, userId);
  return created.id;
};

// data: { customerId | customerName + customerMobile, dueAt, fulfilment, deliveryAddress, notes,
//         items: [{ productId, productVariantId, quantity, notes }],
//         advance: { amount, paymentMethod, paymentTypeId, transactionRef } }
const create = async (restaurantId, data, userId, ctx = {}) => {
  if (new Date(data.dueAt).getTime() < Date.now() - 15 * 60000) {
    throw new AppError(400, "A pre-order is for later today or a later day");
  }

  // Each item at its menu price (a size adds its difference; by weight, per kg).
  const priced = [];

  for (const item of data.items) {
    const product = (await pool.query(
      `SELECT p.id, p.name, p.price, p.status, v.id AS variant_id, p.price + v.price_delta AS variant_price
       FROM products p LEFT JOIN product_variants v ON v.id = $3 AND v.product_id = p.id
       WHERE p.restaurant_id = $1 AND p.id = $2`,
      [restaurantId, item.productId, item.productVariantId || null]
    )).rows[0];

    if (!product || product.status !== "active") {
      throw new AppError(404, "An item on the pre-order is not on the menu");
    }

    if (item.productVariantId && !product.variant_id) {
      throw new AppError(404, `That size of ${product.name} is not on the menu`);
    }

    priced.push({ ...item, unitPrice: n(product.variant_id ? product.variant_price : product.price) });
  }

  const total = Math.round(priced.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) * 100) / 100;

  if (data.advance && data.advance.amount > total + 0.009) {
    throw new AppError(400, `The advance is more than the order (₹${total.toFixed(2)})`);
  }

  // A wrong payment type is a mistake to correct before anything is saved.
  if (data.advance && data.advance.amount > 0) {
    await paymentTypeService.forPayment(restaurantId, data.advance.paymentMethod, data.advance.paymentTypeId, data.advance.transactionRef);
  }

  // The guest last of all: a refused pre-order leaves no new guest behind.
  const customerId = await guestFor(restaurantId, data, userId);
  const client = await pool.connect();
  let id;

  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM restaurants WHERE id = $1 FOR UPDATE", [restaurantId]);
    const next = (await client.query(
      "SELECT COALESCE(max(substring(preorder_number from '[0-9]+$')::int), 0) + 1 AS n FROM restaurant_preorders WHERE restaurant_id = $1",
      [restaurantId]
    )).rows[0].n;
    const number = `PRE-${String(next).padStart(4, "0")}`;
    const row = (await client.query(
      `INSERT INTO restaurant_preorders (restaurant_id, outlet_id, preorder_number, customer_id, due_at, fulfilment, delivery_address, notes,
         estimated_total, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
      [restaurantId, ctx.outletId || null, number, customerId, data.dueAt, data.fulfilment, data.deliveryAddress || null, data.notes || null, total.toFixed(2), userId]
    )).rows[0];
    id = row.id;

    for (const item of priced) {
      await client.query(
        `INSERT INTO restaurant_preorder_items (restaurant_id, preorder_id, product_id, product_variant_id, quantity, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [restaurantId, id, item.productId, item.productVariantId || null, item.quantity, item.unitPrice.toFixed(2), item.notes || null]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // The advance goes into the day's cash like any other. The pre-order is
  // kept even if the till cannot take it (no day open): the answer says why
  // (advanceRefused), and the advance is taken from the pre-order later.
  let advanceRefused = null;

  if (data.advance && data.advance.amount > 0) {
    try {
      await takeAdvance(restaurantId, id, data.advance, userId, ctx);
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      advanceRefused = error.message;
    }
  }

  const saved = await findOne(restaurantId, id);
  return advanceRefused ? { ...saved, advanceRefused } : saved;
};

const takeAdvance = async (restaurantId, id, advance, userId, ctx = {}) => {
  const preorder = await findOne(restaurantId, id);

  if (!OPEN.includes(preorder.status)) {
    throw new AppError(409, `${preorder.number} is ${preorder.status}`);
  }

  if (preorder.advanceId) {
    throw new AppError(409, `${preorder.number} already has its advance (${preorder.advanceReceipt})`);
  }

  const taken = await advanceService.create(restaurantId, {
    customerId: preorder.customerId,
    amount: advance.amount,
    paymentMethod: advance.paymentMethod,
    paymentTypeId: advance.paymentTypeId || null,
    transactionRef: advance.transactionRef || null,
    purpose: `Pre-order ${preorder.number}`,
  }, userId, ctx);
  await pool.query("UPDATE restaurant_preorders SET advance_id = $3, updated_by = $4, updated_at = NOW() WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id, taken.id, userId]);

  return findOne(restaurantId, id);
};

const setStatus = async (restaurantId, id, status, userId) => {
  const preorder = await findOne(restaurantId, id);

  if (preorder.status === status) {
    return preorder;
  }

  if (!(NEXT[preorder.status] || []).includes(status)) {
    throw new AppError(409, `${preorder.number} is ${preorder.status.replace("_", " ")}; it cannot be marked ${status.replace("_", " ")}`);
  }

  await pool.query("UPDATE restaurant_preorders SET status = $3, updated_by = $4, updated_at = NOW() WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id, status, userId]);
  return findOne(restaurantId, id);
};

const cancel = async (restaurantId, id, reason, userId) => {
  const preorder = await findOne(restaurantId, id);

  if (!OPEN.includes(preorder.status)) {
    throw new AppError(409, `${preorder.number} is ${preorder.status}`);
  }

  await pool.query(
    "UPDATE restaurant_preorders SET status = 'cancelled', cancel_reason = $3, updated_by = $4, updated_at = NOW() WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, id, reason, userId]
  );
  return findOne(restaurantId, id);
};

// Handed over: a takeaway order on today's business day with the pre-order's
// items and messages; the advance is put on it so its bill takes it first.
const collect = async (restaurantId, id, userId, ctx = {}) => {
  const preorder = await findOne(restaurantId, id);

  if (preorder.status === "collected") {
    return { preorder, orderId: preorder.orderId };
  }

  if (!OPEN.includes(preorder.status)) {
    throw new AppError(409, `${preorder.number} is ${preorder.status}`);
  }

  const order = await orderService.create(restaurantId, {
    orderType: "takeaway",
    source: "pos",
    outletId: ctx.outletId || preorder.outletId || null,
    outletPinned: Boolean(ctx.outletPinned),
    customerId: preorder.customerId,
    customerName: preorder.customerName,
    customerMobile: null,
    notes: [`Pre-order ${preorder.number}`, preorder.notes].filter(Boolean).join(" · "),
    items: preorder.items.map((item) => ({
      productId: item.productId,
      productVariantId: item.productVariantId || null,
      modifierIds: [],
      quantity: item.quantity,
      notes: item.notes || null,
    })),
  }, userId);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (preorder.advanceId) {
      await client.query("UPDATE customer_advances SET order_id = $3, updated_at = NOW() WHERE restaurant_id = $1 AND id = $2 AND order_id IS NULL",
        [restaurantId, preorder.advanceId, order.id]);
    }

    await client.query(
      `UPDATE restaurant_preorders SET status = 'collected', order_id = $3, collected_at = NOW(), updated_by = $4, updated_at = NOW()
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, id, order.id, userId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return { preorder: await findOne(restaurantId, id), orderId: Number(order.id), orderNumber: order.orderNumber };
};

module.exports = { list, bakeList, findOne, create, takeAdvance, setStatus, cancel, collect };
