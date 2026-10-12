#!/usr/bin/env node
//
// An evening at the cash desk, for the Bills screen, the bill dialog and the
// "given at the till" list:
//
//   1. A regular's table gets 10% off from the manager.
//   2. A guest declines the service charge; it comes off with its GST.
//   3. A staff meal is made no-charge by the cashier, approved by the manager.
//   4. A table paid by card complains about a cold starter: ₹150 goes back on
//      the card with a credit note.
//   5. A company lunch: half off the lassi that came late, the company's
//      GSTIN on the invoice, printed and then reprinted (a duplicate).
//
// It also caps a manager's own till discounts at 15% (Settings > Discounts at
// the till), unless the owner has set a cap already.
//
// Everything goes through the real order and bill services, on the open
// business day, and every table is settled so none is left occupied.
//
//   node scripts/seed-billing.js
//
// Safe to run again: each scene is added once per business day, and a run
// adds only the scenes that are missing. It never deletes anything.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");
const billRepository = require("../src/modules/restaurant/billing/repositories/bill.repository");
const auditRepository = require("../src/modules/access/repositories/audit.repository");

const say = (message) => console.log(message);

// Marks this script's orders, so a second run can tell they are there.
const MARK = "Demo: cash desk";

// A real, checkable GSTIN for the company lunch (Andhra Pradesh).
const COMPANY_GSTIN = "37AAACR5055K1Z6";

const main = async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant yet — nothing to do.");
    return;
  }

  const restaurantId = restaurant.id;

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

  const manager = (await staff("MANAGER")) || owner;
  const cashier = (await staff("CASHIER")) || owner;

  // The manager's cap, unless the owner already chose one.
  const managerRole = (await pool.query("SELECT id FROM roles WHERE code = 'MANAGER' AND restaurant_id IS NULL")).rows[0];

  if (managerRole) {
    const capped = await pool.query(
      `INSERT INTO till_discount_limits (restaurant_id, role_id, max_percent, created_by, updated_by)
       VALUES ($1, $2, 15, $3, $3)
       ON CONFLICT (restaurant_id, role_id) DO NOTHING
       RETURNING role_id`,
      [restaurantId, managerRole.id, owner.id]
    );
    say(capped.rows.length ? "  a manager may take up to 15% off a bill on their own" : "  the manager's discount cap was already set");
  }

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

  // Each scene is marked on its order, so a second run adds only what is missing.
  const done = new Set(
    (
      await pool.query(
        `SELECT notes FROM orders
         WHERE restaurant_id = $1 AND business_day_id = $2 AND notes LIKE $3`,
        [restaurantId, day.id, `${MARK}%`]
      )
    ).rows.map((row) => row.notes)
  );
  const scene = (key) => `${MARK} · ${key}`;

  // The restaurant's best sellers that carry GST, dearest first, so the
  // demo bills look like tonight's (and the cheapest one is the late drink).
  const dishes = (
    await pool.query(
      `SELECT p.id, p.name, p.price FROM products p
       JOIN categories c ON c.id = p.category_id AND c.status = 'active'
       LEFT JOIN order_items oi ON oi.product_id = p.id
       WHERE p.restaurant_id = $1 AND p.status = 'active' AND p.is_available AND NOT p.is_combo
         AND p.tax_percentage > 0 AND p.price BETWEEN 30 AND 600
         AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active')
       GROUP BY p.id
       ORDER BY COUNT(oi.id) DESC, p.id
       LIMIT 12`,
      [restaurantId]
    )
  ).rows.sort((x, y) => Number(y.price) - Number(x.price));

  if (dishes.length < 4) {
    say("Not enough dishes on the menu to ring up — nothing added.");
    return;
  }

  // A table with nobody at it, on a floor and in a section that are open.
  // Asked for each scene: every scene settles its table, so a quiet test
  // restaurant with one free table still gets all five.
  const freeTable = async () =>
    (
      await pool.query(
        `SELECT t.id, t.table_no FROM dining_tables t
         LEFT JOIN floors f ON f.id = t.floor_id
         LEFT JOIN dining_areas a ON a.id = t.area_id
         WHERE t.restaurant_id = $1 AND t.status = 'active'
           AND COALESCE(f.status, 'active') = 'active' AND COALESCE(a.status, 'active') = 'active'
           AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.order_status IN ('open', 'billed'))
           AND NOT EXISTS (SELECT 1 FROM order_joined_tables j WHERE j.table_id = t.id AND j.released_at IS NULL)
         ORDER BY t.table_no
         LIMIT 1`,
        [restaurantId]
      )
    ).rows[0] || null;

  const place = async (type, lines, extra = {}) => {
    if (done.has(extra.scene)) {
      say(`  ${extra.scene.slice(MARK.length + 3)}: already there`);
      return null;
    }

    const table = type === "dine_in" ? await freeTable() : null;

    if (type === "dine_in" && !table) {
      say(`  ${extra.scene.slice(MARK.length + 3)}: no free table right now`);
      return null;
    }

    try {
      return await orderService.create(
        restaurantId,
        {
          orderType: type,
          source: "pos",
          tableId: table ? table.id : null,
          outletId: null,
          customerId: null,
          customerName: extra.customerName || null,
          customerMobile: null,
          guestCount: type === "dine_in" ? extra.guests || 2 : null,
          notes: extra.scene,
          items: lines.map(([dish, quantity]) => ({
            productId: dish.id,
            productVariantId: null,
            modifierIds: [],
            quantity,
            notes: null,
          })),
        },
        extra.by || cashier.id
      );
    } catch (error) {
      say(`  (an order could not be placed: ${error.message})`);
      return null;
    }
  };

  const pay = (bill, method, userId = cashier.id) =>
    billService.addPayment(
      restaurantId,
      bill.id,
      {
        paymentMethod: method,
        amount: bill.dueAmount,
        tenderedAmount: method === "cash" ? Math.ceil(bill.dueAmount / 100) * 100 : null,
        transactionRef: method === "upi" ? `UPI${String(bill.id).padStart(6, "4")}` : method === "card" ? "CARD-4417" : null,
      },
      userId
    );

  const note = (userId, userName, action, bill, details, approver) =>
    auditRepository.record({
      restaurantId,
      userId,
      userName,
      action,
      entityType: "bill",
      entityId: bill.id,
      entityLabel: bill.billNumber,
      details,
      approvedBy: approver ? approver.id : null,
      approverName: approver ? approver.name : null,
    });

  const [big, mid, second, third] = dishes;
  const cheap = dishes[dishes.length - 1];
  let made = 0;

  // 1. A regular's table: 10% off from the manager.
  const regular = await place("dine_in", [[big, 1], [mid, 2]], { customerName: "Mr. Varma (regular)", guests: 3, scene: scene("regular") });

  if (regular) {
    let bill = await billService.createForOrder(restaurantId, { orderId: regular.id }, cashier.id);
    ({ bill } = await billService.adjust(
      restaurantId,
      bill.id,
      { manualDiscount: { type: "percentage", value: 10 }, discountReason: "regular", discountNote: "Comes every Friday" },
      { userId: manager.id, approverId: null }
    ));
    await note(manager.id, manager.name, "discount", bill, { tillDiscount: bill.manualDiscount.amount, reason: "Regular guest" });
    await pay(bill, "upi");
    made += 1;
    say(`  ${bill.billNumber}: 10% off for a regular, paid by UPI`);
  }

  // 2. The guest declines the service charge.
  const declined = await place("dine_in", [[second, 1], [cheap, 2]], { guests: 2, scene: scene("service charge declined") });

  if (declined) {
    let bill = await billService.createForOrder(restaurantId, { orderId: declined.id }, cashier.id);

    if (bill.serviceCharge > 0) {
      ({ bill } = await billService.adjust(
        restaurantId,
        bill.id,
        { serviceCharge: { waive: true, reason: "Guest asked to remove it" } },
        { userId: cashier.id, approverId: null }
      ));
      await note(cashier.id, cashier.name, "service_charge_waived", bill, { reason: "Guest asked to remove it" });
    }

    await pay(bill, "cash");
    made += 1;
    say(`  ${bill.billNumber}: service charge declined, paid in cash`);
  }

  // 3. A staff meal, no-charge, approved by the manager.
  const meal = await place("takeaway", [[third, 1]], { customerName: "Staff meal", by: cashier.id, scene: scene("staff meal") });

  if (meal) {
    let bill = await billService.createForOrder(restaurantId, { orderId: meal.id }, cashier.id);
    ({ bill } = await billService.adjust(
      restaurantId,
      bill.id,
      { complimentary: { reason: "staff_meal", note: "Kitchen team, late shift" } },
      { userId: cashier.id, approverId: manager.id }
    ));
    await note(cashier.id, cashier.name, "complimentary", bill, { reason: "Staff meal", value: bill.subtotal }, manager);
    made += 1;
    say(`  ${bill.billNumber}: staff meal, no-charge (approved by ${manager.name})`);
  }

  // 4. Paid by card, then ₹150 back for a cold starter, with a credit note.
  const cold = await place("dine_in", [[big, 2], [second, 1]], { guests: 4, scene: scene("credit note") });

  if (cold) {
    let bill = await billService.createForOrder(restaurantId, { orderId: cold.id }, cashier.id);
    bill = await pay(bill, "card");
    const refund = { amount: 150, refundMethod: "card", reason: "Starter came cold", reversePoints: true, items: [] };
    await billService.checkRefund(await billRepository.findHeader(restaurantId, bill.id), refund);
    ({ bill } = await billService.addRefund(restaurantId, bill.id, refund, manager.id));
    await note(manager.id, manager.name, "refund", bill, { amount: 150, method: "card", reason: "Starter came cold" });
    made += 1;
    say(`  ${bill.billNumber}: ₹150 back on the card, ${bill.creditNotes[0] ? bill.creditNotes[0].number : "credit note"}`);
  }

  // 5. A company lunch: half off the late lassi, the company's GSTIN on the
  //    invoice, printed, then printed again for their accounts.
  const lunch = await place("dine_in", [[mid, 2], [second, 2], [cheap, 1]], { customerName: "Rao Traders", guests: 4, scene: scene("company lunch") });

  if (lunch) {
    let bill = await billService.createForOrder(restaurantId, { orderId: lunch.id }, cashier.id);
    const lassi = bill.items.find((item) => item.itemName === cheap.name) || bill.items[bill.items.length - 1];
    ({ bill } = await billService.adjust(
      restaurantId,
      bill.id,
      {
        itemDiscounts: [{ orderItemId: lassi.orderItemId, type: "percentage", value: 50 }],
        discountReason: "delay",
        discountNote: `${lassi.itemName} came 20 minutes late`,
      },
      { userId: manager.id, approverId: null }
    ));
    await note(manager.id, manager.name, "discount", bill, { dishDiscounts: bill.itemDiscountAmount, reason: "Food or service was slow" });
    await pool.query(
      `INSERT INTO bill_gst_recipients (restaurant_id, bill_id, gstin, legal_name, created_by, updated_by)
       VALUES ($1, $2, $3, 'Rao Traders Pvt Ltd', $4, $4)
       ON CONFLICT (bill_id) DO NOTHING`,
      [restaurantId, bill.id, COMPANY_GSTIN, cashier.id]
    );
    await billService.registerPrint(restaurantId, bill.id);
    await billService.registerPrint(restaurantId, bill.id);
    await note(cashier.id, cashier.name, "reprint", bill, { printCount: 2 });
    await pay({ ...bill, dueAmount: bill.dueAmount }, "upi");
    made += 1;
    say(`  ${bill.billNumber}: company lunch (B2B, GSTIN ${COMPANY_GSTIN}), printed twice`);
  }

  say(`Cash desk: ${made} demo bills on ${day.business_date}.`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
