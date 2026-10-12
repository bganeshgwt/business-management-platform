#!/usr/bin/env node
//
// A realistic evening of dishes taken off orders, for the Orders page's
// "Dishes cancelled after KOT" report and the POS:
//
//   1. A table's paneer tikka sent back for being too salty — taken off by the
//      captain with the manager's PIN.
//   2. A lassi punched twice by mistake — the cashier takes one off.
//   3. A party that waited 40 minutes for their biryani and walked out — the
//      whole order cancelled by the manager.
//
// Everything goes through the real order service (orders, KOTs, reasons,
// approvals), on the open business day, and the tables are settled
// afterwards so none is left occupied.
//
//   node scripts/seed-orders-core.js
//
// Safe to run again: it does nothing when tonight's demo cancellations are
// already there. It never deletes anything.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");

const say = (message) => console.log(message);

// Marks this script's orders, so a second run can tell they are there.
const MARK = "Demo: service log";

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant yet — nothing to do.");
    return;
  }

  const restaurantId = restaurant.id;
  const day = (
    await pool.query(
      "SELECT id, business_date FROM business_days WHERE restaurant_id = $1 AND day_status = 'open'",
      [restaurantId]
    )
  ).rows[0];

  if (!day) {
    say("No business day is open — open one, then run this again.");
    return;
  }

  const already = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders
     WHERE restaurant_id = $1 AND business_day_id = $2 AND notes = $3`,
    [restaurantId, day.id, MARK]
  );

  if (already.rows[0].n > 0) {
    say(`Tonight's cancellations are already there (${already.rows[0].n} orders) — nothing added.`);
    return;
  }

  // Who does what: a captain, a cashier and a manager if the restaurant has
  // them, the owner otherwise.
  const staff = async (code) =>
    (
      await pool.query(
        `SELECT u.id, u.name FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id AND r.code = $2
         WHERE u.restaurant_id = $1 AND u.status = 'active'
         ORDER BY u.id LIMIT 1`,
        [restaurantId, code]
      )
    ).rows[0] || null;

  const owner = await staff("RESTAURANT_ADMIN");

  if (!owner) {
    say("The restaurant has no admin — nothing to do.");
    return;
  }

  const captain = (await staff("CAPTAIN")) || owner;
  const cashier = (await staff("CASHIER")) || owner;
  const manager = (await staff("MANAGER")) || owner;
  // What a manager's PIN at the till looks like to the service.
  const approvedBy = (person) => async () => (person.id === manager.id ? null : { approverId: manager.id });

  // Dishes by what they are called on the demo menu; the first match wins.
  const dish = async (...patterns) => {
    for (const pattern of patterns) {
      const found = (
        await pool.query(
          `SELECT p.id, p.name FROM products p
           JOIN categories c ON c.id = p.category_id AND c.status = 'active'
           WHERE p.restaurant_id = $1 AND p.status = 'active' AND p.is_available
             AND NOT p.is_combo AND p.name ~* $2
             AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active')
           ORDER BY p.id LIMIT 1`,
          [restaurantId, pattern]
        )
      ).rows[0];

      if (found) {
        return found;
      }
    }

    return null;
  };

  const tikka = await dish("paneer tikka", "tikka", "kebab");
  const lassi = await dish("lassi", "buttermilk", "lime", "soda");
  const biryani = await dish("biryani", "pulao", "fried rice");
  const naan = await dish("naan", "roti", "paratha");
  const dal = await dish("dal", "paneer butter", "curry");

  const menu = [tikka, lassi, biryani, naan, dal].filter(Boolean);

  if (menu.length < 4) {
    say("The menu does not have enough everyday dishes (tikka, lassi, biryani, naan…) — nothing added.");
    return;
  }

  const freeTables = (
    await pool.query(
      `SELECT t.id, t.table_no FROM dining_tables t
       WHERE t.restaurant_id = $1 AND t.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.order_status IN ('open', 'billed'))
       ORDER BY t.id`,
      [restaurantId]
    )
  ).rows;

  const place = async (person, items, tableIndex) => {
    const table = freeTables[tableIndex] || null;

    return orderService.create(
      restaurantId,
      {
        orderType: table ? "dine_in" : "takeaway",
        source: table ? "captain" : "pos",
        tableId: table ? table.id : null,
        outletId: null,
        guestCount: table ? 2 + (tableIndex % 3) : null,
        customerName: table ? null : "Walk-in",
        notes: MARK,
        items: items.filter((item) => item.productId),
      },
      person.id
    );
  };

  const line = (order, product) => order.items.find((item) => item.productId === product.id && item.itemStatus !== "cancelled");

  const settle = async (order) => {
    const bill = await billService.createForOrder(
      restaurantId,
      { orderId: order.id, discountCode: null, outletId: null, loyaltyPoints: null, items: [] },
      cashier.id
    );
    await billService.addPayment(
      restaurantId,
      bill.id,
      { paymentMethod: "upi", amount: bill.dueAmount, tenderedAmount: null, transactionRef: null },
      cashier.id
    );
  };

  let made = 0;

  // 1. Sent back: too salty.
  if (tikka) {
    const order = await place(
      captain,
      [
        { productId: tikka.id, quantity: 2 },
        naan ? { productId: naan.id, quantity: 4 } : {},
        lassi ? { productId: lassi.id, quantity: 2 } : {},
      ],
      0
    );
    const edited = await orderService.updateItems(
      restaurantId,
      order.id,
      {
        // What the POS sends: only the line that changed, with the quantity
        // the screen showed.
        items: order.items
          .filter((item) => item.productId === tikka.id)
          .map((item) => ({ id: item.id, quantity: 1, seenQuantity: item.quantity })),
        changesOnly: true,
        cancelReason: "quality",
        cancelNote: "Guest said it was too salty",
      },
      captain.id,
      { gate: approvedBy(captain) }
    );
    await settle(edited);
    made += 1;
    say(`  ${edited.orderNumber}: 1 × ${tikka.name} sent back (too salty), approved by ${manager.name}`);
  }

  // 2. Punched twice by mistake.
  if (lassi) {
    const order = await place(cashier, [{ productId: lassi.id, quantity: 2 }, dal ? { productId: dal.id, quantity: 1 } : {}], 1);
    const lassiLine = line(order, lassi);
    const after = await orderService.cancelItem(
      restaurantId,
      order.id,
      lassiLine.id,
      { quantity: 1, reasonCode: "wrong_order", note: "Rung up twice" },
      cashier.id,
      { gate: approvedBy(cashier) }
    );
    await settle(after);
    made += 1;
    say(`  ${after.orderNumber}: 1 × ${lassi.name} rung up twice, taken off`);
  }

  // 3. Waited too long and left.
  if (biryani) {
    const order = await place(captain, [{ productId: biryani.id, quantity: 2 }, naan ? { productId: naan.id, quantity: 2 } : {}], 2);
    await orderService.cancel(
      restaurantId,
      order.id,
      { reason: "Took too long — waited 40 minutes and left", reasonCode: "delay" },
      manager.id,
      { gate: async () => null }
    );
    made += 1;
    say(`  ${order.orderNumber}: whole order cancelled — the party waited 40 minutes and left`);
  }

  say(`${restaurant.name}: ${made} orders with dishes taken off, on ${day.business_date}.`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
