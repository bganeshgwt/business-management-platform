// Adds a second branch to the demo restaurant, so the outlet picker, the
// branch's own tables and business day, and the "All outlets" reports have
// something real to show.
//
// The branch (FoodEx — Madhapur) cooks from the main store: its sales draw on
// the main kitchen's stock, as a satellite outlet does. It gets a floor with
// six tables and a week of trading — six closed days and today open — rung up
// through the real order, bill and business-day services, so prices, tax,
// stock and the day's cash all follow the POS's own rules.
//
// Usage:  node scripts/demo-restaurant-branch.js [--restaurant-id 1] [--user-id 2]
// It refuses to run twice (the branch's code, MDP, is taken the second time).
const pool = require("../src/config/database");
const outletService = require("../src/modules/restaurant/setup/services/outlet.service");
const tableService = require("../src/modules/restaurant/tables/services/table.service");
const businessDayService = require("../src/modules/restaurant/business-day/services/businessDay.service");
const orderService = require("../src/modules/restaurant/orders/services/order.service");
const billService = require("../src/modules/restaurant/billing/services/bill.service");

const DAYS = 6;
const CODE = "MDP";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? Number(process.argv[at + 1]) : fallback;
};

// Fixed seed: the same branch on every fresh run.
let randomState = 20261021;
const random = () => {
  randomState = (randomState * 1103515245 + 12345) % 2147483648;
  return randomState / 2147483648;
};
const between = (low, high) => low + Math.floor(random() * (high - low + 1));
const pick = (list) => list[Math.floor(random() * list.length)];
const isoDate = (date) => date.toISOString().slice(0, 10);

async function main() {
  const restaurantId = arg("restaurant-id", 1);
  const userId = arg("user-id", 2);
  const { rows: [restaurant] } = await pool.query("SELECT id, name FROM restaurants WHERE id = $1", [restaurantId]);
  if (!restaurant) throw new Error(`Restaurant ${restaurantId} not found`);
  const { rows: taken } = await pool.query("SELECT id FROM outlets WHERE restaurant_id = $1 AND code = $2", [restaurantId, CODE]);
  if (taken.length) {
    console.log(`${restaurant.name} already has its Madhapur branch (outlet ${taken[0].id}). Nothing to do.`);
    return;
  }
  const { rows: [settings] } = await pool.query("SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1", [restaurantId]);
  const timezone = settings?.timezone || "Asia/Kolkata";

  const outlet = await outletService.create(restaurantId, {
    name: "FoodEx — Madhapur", code: CODE, contact: "040 4855 2200",
    address: "Plot 14, Ayyappa Society, Madhapur, Hyderabad 500081",
    orderPrefix: "MDP", invoicePrefix: "MDP", status: "active",
  }, userId);
  console.log(`  outlet · ${outlet.name} (${outlet.id})`);

  const floor = await tableService.createFloor(restaurantId, { name: "Madhapur dining", outletId: outlet.id, sortOrder: 9, status: "active" }, userId);
  const area = await tableService.createArea(restaurantId, { floorId: floor.id, name: "Madhapur hall", sortOrder: 0, status: "active" }, userId);
  const tables = [];
  for (let n = 1; n <= 6; n += 1) {
    tables.push(await tableService.createTable(restaurantId, {
      floorId: floor.id, areaId: area.id, outletId: outlet.id, tableNo: `M${n}`, capacity: n <= 4 ? 4 : 6, status: "active",
    }, userId));
  }
  console.log(`  tables · ${tables.length} (M1–M6)`);

  // The main menu's dishes (the branch sells the same menu).
  const { rows: products } = await pool.query(
    `SELECT id FROM products WHERE restaurant_id = $1 AND status = 'active' AND COALESCE(is_available, TRUE) ORDER BY id`, [restaurantId]);
  const { rows: customers } = await pool.query(
    "SELECT id, name, mobile FROM customers WHERE restaurant_id = $1 ORDER BY id LIMIT 40", [restaurantId]);
  if (!products.length) throw new Error("The restaurant has no menu yet: run the restaurant demo first");

  const orderTypes = ["dine_in", "dine_in", "takeaway", "takeaway", "delivery"];
  const paymentMethods = ["cash", "upi", "upi", "upi", "card"];
  let orders = 0, bills = 0, sales = 0;

  for (let back = DAYS; back >= 0; back -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - back);
    const businessDate = isoDate(date);
    const openingCash = 1500;
    const day = await businessDayService.openDay(restaurantId, { businessDate, openingCash, notes: null, outletId: outlet.id }, userId);
    const covers = back === 0 ? 9 : between(10, 18);
    let cashTaken = 0;
    const stamps = [];

    for (let n = 0; n < covers; n += 1) {
      const orderType = pick(orderTypes);
      const table = orderType === "dine_in" ? pick(tables) : null;
      const customer = customers.length && random() < 0.3 ? pick(customers) : null;
      const items = [];
      for (let l = between(1, 3); l > 0; l -= 1) {
        const product = pick(products);
        if (!items.some((line) => line.productId === product.id)) {
          items.push({ productId: product.id, productVariantId: null, modifierIds: [], quantity: between(1, 2), notes: null });
        }
      }
      let order;
      try {
        order = await orderService.create(restaurantId, {
          orderType, source: "pos", tableId: table ? table.id : null, outletId: outlet.id,
          customerId: customer ? customer.id : null, customerName: customer ? customer.name : null, customerMobile: customer ? customer.mobile : null,
          guestCount: orderType === "dine_in" ? between(1, 5) : null, notes: null, items,
        }, userId);
      } catch {
        continue; // A dish short of stock: skip that order, as the till would.
      }
      orders += 1;
      const at = `${between(12, 22)}:${String(between(0, 59)).padStart(2, "0")}`;
      stamps.push({ orderId: order.id, billId: null, at });
      // Today a couple of tables are still eating.
      if (back === 0 && n >= covers - 2) continue;

      const bill = await billService.createForOrder(restaurantId, { orderId: order.id, discountCode: null, outletId: outlet.id, loyaltyPoints: null, items: [] }, userId);
      const method = pick(paymentMethods);
      await billService.addPayment(restaurantId, bill.id, {
        paymentMethod: method, amount: bill.dueAmount,
        tenderedAmount: method === "cash" ? Math.ceil(bill.dueAmount / 100) * 100 : null,
        transactionRef: method === "upi" ? `UPI${between(100000, 999999)}` : null,
      }, userId);
      stamps[stamps.length - 1].billId = bill.id;
      bills += 1;
      sales += bill.totalAmount;
      if (method === "cash") cashTaken += bill.totalAmount;
    }

    // Each order and bill at the time it was taken that day, not this second.
    for (const stamp of stamps) {
      await pool.query(`UPDATE orders SET created_at = ($2::date + $3::time) AT TIME ZONE $4 WHERE restaurant_id = $1 AND id = $5`,
        [restaurantId, businessDate, stamp.at, timezone, stamp.orderId]);
      if (stamp.billId) {
        await pool.query(`UPDATE bills SET billed_at = ($2::date + $3::time + INTERVAL '40 minutes') AT TIME ZONE $5,
            settled_at = CASE WHEN settled_at IS NULL THEN NULL ELSE ($2::date + $3::time + INTERVAL '45 minutes') AT TIME ZONE $5 END
          WHERE restaurant_id = $1 AND id = $4`, [restaurantId, businessDate, stamp.at, stamp.billId, timezone]);
        await pool.query(`UPDATE payments SET paid_at = ($2::date + $3::time + INTERVAL '45 minutes') AT TIME ZONE $4 WHERE restaurant_id = $1 AND bill_id = $5`,
          [restaurantId, businessDate, stamp.at, timezone, stamp.billId]);
      }
    }
    if (back > 0) {
      await businessDayService.closeDay(restaurantId, { closingCash: Math.round(openingCash + cashTaken), notes: null, outletId: outlet.id }, userId);
    }
    await pool.query(`UPDATE business_days SET opened_at = business_date + TIME '11:00',
        closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE business_date + TIME '23:15' END
      WHERE restaurant_id = $1 AND id = $2`, [restaurantId, day.id]);
  }
  console.log(`  trading · ${DAYS + 1} days, ${orders} orders, ${bills} bills, ₹${Math.round(sales).toLocaleString("en-IN")}`);
  console.log("Done. Pick “FoodEx — Madhapur” in the outlet picker at the top of the restaurant app.");
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => pool.end());
