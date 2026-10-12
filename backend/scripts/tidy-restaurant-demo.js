// Tidies the demo restaurant (FoodEx) so it opens today like a restaurant in
// the middle of service, using the app's own services:
//
//   npm run demo:tidy-restaurant -- --user-id <restaurant admin id>
//
// 1. Every business day still open from an earlier date (the main counter and
//    each outlet) is closed properly:
//      - open orders placed before today are cancelled with the reason
//        "Demo tidy-up: stale order" (they stay in the cancellations report);
//      - open orders placed today on that old day are billed and paid in cash,
//        because they are today's real trade;
//      - unpaid bills are carried as dues, the app's own way of closing with
//        money still owed (they stay under Bills, unpaid, with a note on the day);
//      - open cash drawers are counted at what they should hold;
//      - the day is closed with the cash the drawer should hold, so the count
//        matches (no over/short).
// 2. Today's main business day is opened if none is (opening float ₹5,000) and
//    today's trade is topped up to what a restaurant has served by this hour:
//    a few covers before lunch, a third of the day by 3 pm, the rest at dinner,
//    two tables still eating. Today's main business day is never closed.
//
// Nothing is deleted. Safe to run again: closed days are left as they are,
// and today is only topped up to the same planned number of covers.
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const pool = require('../src/config/database');
const users = require('../src/modules/access/repositories/user.repository');
const businessDay = require('../src/modules/restaurant/business-day/services/businessDay.service');
const businessDayRepository = require('../src/modules/restaurant/business-day/repositories/businessDay.repository');
const cashDrawer = require('../src/modules/restaurant/business-day/services/cashDrawer.service');
const tradingDay = require('../src/modules/restaurant/business-day/services/tradingDay');
const restaurantRepository = require('../src/modules/restaurant/setup/repositories/restaurant.repository');
const orderService = require('../src/modules/restaurant/orders/services/order.service');
const billService = require('../src/modules/restaurant/billing/services/bill.service');

const REASON = 'Demo tidy-up: stale order';
const seeded = (text) => {
  let a = crypto.createHash('sha256').update(text).digest().readUInt32LE(0);
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};

// The trading date of a moment (before the morning cut-off it is still last night).
const tradingDateOf = (settings, at) => {
  const cutoff = Number(settings?.day_cutoff_hour ?? 5);
  return tradingDay.todayOf(settings, new Date(new Date(at).getTime() - cutoff * 3600000));
};

async function payInCash(restaurantId, orderId, outletId, userId) {
  const bill = await billService.createForOrder(restaurantId, { orderId, discountCode: null, outletId, loyaltyPoints: null, items: [] }, userId);
  if (bill.dueAmount > 0) {
    await billService.addPayment(restaurantId, bill.id, { paymentMethod: 'cash', amount: bill.dueAmount, tenderedAmount: Math.ceil(bill.dueAmount / 100) * 100, transactionRef: null }, userId);
  }
  return bill;
}

async function closeOldDays(restaurantId, user, settings, today) {
  const days = (await pool.query(`SELECT id, outlet_id, business_date::text AS business_date FROM business_days
    WHERE restaurant_id = $1 AND day_status = 'open' AND business_date < $2::date ORDER BY business_date, id`, [restaurantId, today])).rows;
  const done = { days: 0, cancelled: 0, billedToday: 0, dues: 0, duesAmount: 0, refused: [] };
  for (const day of days) {
    const outletId = day.outlet_id ? Number(day.outlet_id) : null;
    // Open orders block the close: older ones are cancelled, today's are billed.
    const unsettled = await businessDayRepository.findUnsettled(restaurantId, day.id, outletId);
    for (const order of unsettled.orders) {
      try {
        if (order.placed_at && tradingDateOf(settings, order.placed_at) >= today) {
          await payInCash(restaurantId, Number(order.id), outletId, user.id);
          done.billedToday += 1;
        } else {
          await orderService.cancel(restaurantId, Number(order.id), { reason: REASON, reasonCode: 'other' }, user.id);
          done.cancelled += 1;
        }
      } catch (error) {
        done.refused.push(`order ${order.order_number}: ${error.message}`);
      }
    }
    // Each cashier's drawer is counted at what it should hold.
    const drawers = await cashDrawer.listDrawers(restaurantId, outletId, user).catch(() => []);
    for (const drawer of (Array.isArray(drawers) ? drawers : drawers.drawers || []).filter((d) => (d.drawerStatus || d.drawer_status) === 'open')) {
      const expected = Number(drawer.expectedCash ?? drawer.expected ?? drawer.figures?.expected);
      if (!Number.isFinite(expected)) { done.refused.push(`drawer ${drawer.id}: expected cash not known`); continue; }
      await cashDrawer.closeDrawer(restaurantId, outletId, drawer.id, { closingCash: expected, countMethod: 'total', varianceReason: null }, user);
    }
    try {
      const preview = await businessDay.closePreview(restaurantId, outletId, user);
      const inDrawer = Number(preview.figures.inDrawer ?? 0);
      const result = await businessDay.closeDay(restaurantId, { outletId, closingCash: inDrawer, countMethod: 'total', carryUnpaid: true,
        notes: 'Closed by the demo tidy-up: stale orders cancelled, unpaid bills carried as dues, cash counted as expected.' }, user);
      done.days += 1;
      done.dues += result.result.unpaidBills.length;
      done.duesAmount += result.result.unpaidBills.reduce((s, b) => s + Number(b.due), 0);
    } catch (error) {
      done.refused.push(`day ${day.business_date}${outletId ? ` (outlet ${outletId})` : ''}: ${error.message}`);
    }
  }
  return done;
}

// How much of the day's covers a restaurant has served by this hour.
const servedBy = (h) => (h < 11 ? 0 : h < 12 ? 0.08 * (h - 11) : h < 15 ? 0.08 + 0.3 * ((h - 12) / 3) : h < 19 ? 0.38 + 0.07 * ((h - 15) / 4) : h < 23 ? 0.45 + 0.55 * ((h - 19) / 4) : 1);

async function tradeToday(restaurantId, user, settings, today) {
  let open = await businessDayRepository.findOpen(restaurantId, null);
  let opened = false;
  if (!open) {
    await businessDay.openDay(restaurantId, { businessDate: today, openingCash: 5000, notes: 'Opened by the demo tidy-up', outletId: null }, user.id);
    open = await businessDayRepository.findOpen(restaurantId, null);
    opened = true;
  }
  if (!open || String(open.business_date).slice(0, 10) !== today && tradingDateOf(settings, new Date()) !== today) return { opened, added: 0 };
  const zone = settings?.timezone || 'Asia/Kolkata';
  const now = new Date();
  const hour = tradingDay.hourOf(settings, now) + now.getMinutes() / 60;
  const random = seeded(`foodex|${today}`);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const covers = { 0: 46, 1: 24, 2: 26, 3: 28, 4: 32, 5: 48, 6: 54 }[weekday] + Math.round(random() * 8);
  const target = Math.round(covers * servedBy(hour));
  const done = Number((await pool.query('SELECT count(*)::int AS n FROM orders WHERE restaurant_id = $1 AND business_day_id = $2', [restaurantId, open.id])).rows[0].n);
  const products = (await pool.query("SELECT id, price FROM products WHERE restaurant_id = $1 AND status = 'active' AND is_available = TRUE ORDER BY id", [restaurantId])).rows;
  const tables = (await pool.query(`SELECT t.id FROM dining_tables t WHERE t.restaurant_id = $1 AND t.status = 'active' AND t.outlet_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.order_status = 'open') ORDER BY t.id`, [restaurantId])).rows.map((r) => Number(r.id));
  const customers = (await pool.query('SELECT id, name, mobile FROM customers WHERE restaurant_id = $1 ORDER BY id LIMIT 60', [restaurantId])).rows;
  let added = 0, billed = 0, sales = 0;
  const pick = (list) => list[Math.floor(random() * list.length)];
  for (let n = done; n < target && products.length; n += 1) {
    const type = pick(['dine_in', 'dine_in', 'dine_in', 'takeaway', 'takeaway', 'delivery']);
    const table = type === 'dine_in' ? tables.shift() : null;
    if (type === 'dine_in' && !table) continue;
    const customer = customers.length && random() < 0.35 ? pick(customers) : null;
    const items = [];
    for (let l = 0; l < 1 + Math.floor(random() * 4); l += 1) {
      const product = pick(products);
      if (!items.some((i) => i.productId === Number(product.id))) items.push({ productId: Number(product.id), productVariantId: null, modifierIds: [], quantity: 1 + Math.floor(random() * 2), notes: null });
    }
    let order;
    try {
      order = await orderService.create(restaurantId, { orderType: type, source: 'pos', tableId: table, outletId: null, customerId: customer ? Number(customer.id) : null,
        customerName: customer?.name || null, customerMobile: customer?.mobile || null, guestCount: type === 'dine_in' ? 1 + Math.floor(random() * 5) : null, notes: null, items }, user.id);
    } catch (error) {
      if (process.env.DEBUG_TIDY) console.log(`order not taken: ${error.message}`);
      continue; // a dish sold out or the table taken meanwhile
    }
    added += 1;
    // When it was taken, spread over the hours already past (the same stamping topup-demo.js does).
    const served = Math.min(hour, 23);
    const minutes = Math.round(Math.max(11 * 60, Math.min(served * 60 - 20, 11 * 60 + random() * (served * 60 - 11 * 60))));
    const at = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
    await pool.query('UPDATE orders SET placed_at = ($2::date + $3::time) AT TIME ZONE $4 WHERE id = $1', [order.id, today, at, zone]);
    // The last two tables are still eating.
    if (n >= target - 2 && type === 'dine_in') continue;
    const method = pick(['cash', 'cash', 'card', 'upi', 'upi', 'upi']);
    const bill = await billService.createForOrder(restaurantId, { orderId: order.id, discountCode: null, outletId: null, loyaltyPoints: null, items: [] }, user.id);
    await billService.addPayment(restaurantId, bill.id, { paymentMethod: method, amount: bill.dueAmount, tenderedAmount: method === 'cash' ? Math.ceil(bill.dueAmount / 100) * 100 : null,
      transactionRef: method === 'upi' ? `UPI${100000 + Math.floor(random() * 899999)}` : null }, user.id);
    await pool.query("UPDATE bills SET billed_at = ($2::date + $3::time + INTERVAL '40 minutes') AT TIME ZONE $4 WHERE id = $1 AND billed_at > now() - interval '1 hour'", [bill.id, today, at, zone]);
    await pool.query("UPDATE payments SET paid_at = ($2::date + $3::time + INTERVAL '45 minutes') AT TIME ZONE $4 WHERE bill_id = $1 AND paid_at > now() - interval '1 hour'", [bill.id, today, at, zone]);
    billed += 1;
    sales += Number(bill.totalAmount);
  }
  return { opened, added, billed, sales, target, covers };
}

async function main() {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
  const userId = Number(arg('--user-id'));
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Usage: npm run demo:tidy-restaurant -- --user-id <restaurant admin id> [--restaurant-id <id>]');
  if (process.env.NODE_ENV === 'production') throw new Error('Demo data is not for a live database');
  const profile = await users.findProfileById(userId);
  if (!profile || profile.status !== 'active' || !profile.restaurant_id) throw new Error('Active restaurant user not found');
  const restaurantId = Number(arg('--restaurant-id') || profile.restaurant_id);
  if (restaurantId !== Number(profile.restaurant_id)) throw new Error('The user must belong to that restaurant');
  if (!profile.permissions.includes('business_day.close')) throw new Error('This user may not close business days');
  const user = { id: Number(profile.id), name: profile.name, permissions: profile.permissions, roles: profile.roles, restaurantId };
  const settings = await restaurantRepository.findSettings(restaurantId);
  const today = tradingDateOf(settings, new Date());
  const closed = await closeOldDays(restaurantId, user, settings, today);
  const trade = await tradeToday(restaurantId, user, settings, today);
  console.log(`Restaurant ${restaurantId}: ${closed.days} old business day(s) closed (${closed.cancelled} stale orders cancelled, ${closed.billedToday} of today's orders billed, `
    + `${closed.dues} unpaid bills carried as dues, ₹${Math.round(closed.duesAmount).toLocaleString('en-IN')}).`);
  console.log(`Today ${today}: ${trade.opened ? 'business day opened; ' : ''}${trade.added} orders added (${trade.billed || 0} billed, ₹${Math.round(trade.sales || 0).toLocaleString('en-IN')}).`);
  if (closed.refused.length) console.log(`Not done (${closed.refused.length}): ${closed.refused.slice(0, 5).join(' | ')}${closed.refused.length > 5 ? ' …' : ''}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => pool.end());
}
module.exports = { main };
