const repo = require('../repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('./businessAccess.service');
const { dateText } = require('./business.service');
const { displayName } = require('./businessPaymentMethods.service');

// Day close for a shop counter (pro pass C-04): what was sold and what money
// came in and went out over a day (or a few), by payment method, by the
// person who took it and by counter / location, with the cash that should be
// in the drawer. Read-only: it adds up what was posted and changes nothing.
//
// Money in: payments taken on sales (at the counter or later on the bill) and
// collections from customers (udhaar / outstanding, advances included).
// Money out: refunds to customers (on bills, and advances handed back,
// business_collection_refunds) and payments to suppliers. A cheque that
// bounced is taken off on the day it bounced (round 2 check).
// EMI (round 2): the financed part of a bill is not money in at the counter;
// it is shown apart (booked on EMI), and the financier's payout is money in
// on the day it is recorded, net of the subvention the financier kept.
// Split payments need nothing special: each part is its own payment row.
// Each is counted on its own posting date in the business's time zone.
// Totals stay by kind (cash, UPI, card, bank, cheque); `byMethodName` also
// splits each kind by the business's own method names (PhonePe, Paytm…).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const paise = (value) => Math.round(Number(value || 0) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const METHODS = ['cash', 'upi', 'card', 'bank', 'cheque'];

async function takings(business, query, db = repo.pool) {
  await access.requireAny(business, ['reports.view', 'sales.view']);
  const today = (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
  const from = query.from ? dateText(query.from, 'From date') : today;
  const to = query.to ? dateText(query.to, 'To date') : from;
  if (to < from) fail('The end date is before the start date');
  if (Date.parse(to) - Date.parse(from) > 31 * 86400000) fail('Choose up to 31 days for a day close');
  const locationId = query.locationId ? v.requiredId(query.locationId, 'Location') : null;
  const values = [business.id, from, to, business.timezone, locationId];
  const day = (column) => `(${column} AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`;
  const queries = [
    () => repo.one(db, `SELECT count(*)::int AS bills, COALESCE(sum(d.total),0) AS total, COALESCE(sum(d.tax),0) AS tax, COALESCE(sum(d.round_off),0) AS round_off,
        COALESCE(sum(d.total - COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id AND p.created_at=d.created_at),0))
          FILTER (WHERE d.contact_id IS NOT NULL),0) AS on_credit,
        COALESCE(sum(GREATEST(0,d.total - COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)))
          FILTER (WHERE d.contact_id IS NULL),0) AS walk_in_unpaid,
        count(*) FILTER (WHERE d.contact_id IS NULL)::int AS walk_in_bills
      FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND ${day('d.created_at')} AND ($5::bigint IS NULL OR d.location_id=$5)`, values),
    // Every movement of money, one row each: in (+) or out (-).
    () => repo.all(db, `SELECT * FROM (
        SELECT 'sale_payment' AS source, p.method, p.method_name, p.created_by AS person, d.location_id, p.amount AS amount, (p.created_at=d.created_at) AS at_sale, p.created_at
          FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
          WHERE p.business_id=$1 AND d.kind='sale' AND p.collection_id IS NULL AND p.method<>'finance' AND ${day('p.created_at')}
        UNION ALL SELECT 'finance_payout', s.method, NULL, s.created_by, s.location_id, s.amount_received, false, s.created_at
          FROM electronics_finance_settlements s WHERE s.business_id=$1 AND s.amount_received>0 AND ${day('s.created_at')}
        UNION ALL SELECT 'collection', k.method, k.method_name, k.created_by, k.location_id, k.amount, false, k.created_at
          FROM business_collections k WHERE k.business_id=$1 AND ${day('k.created_at')}
        UNION ALL SELECT 'supplier_refund', f.method, f.method_name, f.created_by, d.location_id, f.amount, false, f.created_at
          FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
          WHERE f.business_id=$1 AND d.kind='purchase' AND ${day('f.created_at')}
        UNION ALL SELECT 'refund', f.method, f.method_name, f.created_by, d.location_id, -f.amount, false, f.created_at
          FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
          WHERE f.business_id=$1 AND d.kind='sale' AND f.method<>'finance' AND ${day('f.created_at')}
        UNION ALL SELECT 'refund', f.method, f.method_name, f.created_by, k.location_id, -f.amount, false, f.created_at
          FROM business_collection_refunds f JOIN business_collections k ON k.business_id=f.business_id AND k.id=f.collection_id
          WHERE f.business_id=$1 AND ${day('f.created_at')}
        UNION ALL SELECT 'bounce', k.method, k.method_name, q.bounced_by, k.location_id, -k.amount, false, q.bounced_at
          FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
          WHERE q.business_id=$1 AND q.status='bounced' AND ${day('q.bounced_at')}
        UNION ALL SELECT 'supplier', p.method, p.method_name, p.created_by, d.location_id, -p.amount, false, p.created_at
          FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
          WHERE p.business_id=$1 AND d.kind='purchase' AND p.supplier_payment_id IS NULL AND ${day('p.created_at')}
        UNION ALL SELECT 'supplier', k.method, k.method_name, k.created_by, k.location_id, -k.amount, false, k.created_at
          FROM business_supplier_payments k WHERE k.business_id=$1 AND ${day('k.created_at')}
      ) m WHERE ($5::bigint IS NULL OR m.location_id=$5)`, values),
    () => repo.one(db, `SELECT count(*)::int AS count, COALESCE(sum(r.total),0) AS total FROM business_returns r
      JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
      WHERE r.business_id=$1 AND d.kind='sale' AND ${day('r.created_at')} AND ($5::bigint IS NULL OR d.location_id=$5)`, values),
    () => repo.all(db, `SELECT x.source, COALESCE(sum(x.amount),0) AS amount FROM retail_sale_discounts x
      JOIN business_documents d ON d.business_id=x.business_id AND d.id=x.document_id
      WHERE x.business_id=$1 AND ${day('d.created_at')} AND ($5::bigint IS NULL OR d.location_id=$5) GROUP BY x.source`, values),
    () => repo.all(db, `SELECT d.created_by AS person, count(*)::int AS bills, sum(d.total) AS sales FROM business_documents d
      WHERE d.business_id=$1 AND d.kind='sale' AND ${day('d.created_at')} AND ($5::bigint IS NULL OR d.location_id=$5) GROUP BY d.created_by`, values),
    () => repo.all(db, 'SELECT id,name,code FROM business_locations WHERE business_id=$1 ORDER BY id', [business.id]),
    () => repo.one(db, 'SELECT display_name,legal_name,gstin,address_line1,city,postal_code,phone FROM business_settings WHERE business_id=$1', [business.id]),
    () => repo.one(db, `SELECT
        COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
          WHERE p.business_id=$1 AND p.method='finance' AND ${day('p.created_at')} AND ($5::bigint IS NULL OR d.location_id=$5)),0) AS booked,
        (SELECT count(*)::int FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
          WHERE p.business_id=$1 AND p.method='finance' AND ${day('p.created_at')} AND ($5::bigint IS NULL OR d.location_id=$5)) AS bills,
        COALESCE((SELECT sum(f.amount) FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
          WHERE f.business_id=$1 AND f.method='finance' AND ${day('f.created_at')} AND ($5::bigint IS NULL OR d.location_id=$5)),0) AS cancelled,
        COALESCE((SELECT sum(s.subvention_total) FROM electronics_finance_settlements s WHERE s.business_id=$1 AND ${day('s.created_at')} AND ($5::bigint IS NULL OR s.location_id=$5)),0) AS subvention`, values),
  ];
  const results = db === repo.pool ? await Promise.all(queries.map(query => query())) : [];
  if (db !== repo.pool) for (const query of queries) results.push(await query());
  const [sales, money, returns, discounts, people, locations, seller, finance] = results;

  const byMethod = () => Object.fromEntries(METHODS.map((m) => [m, 0]));
  const received = byMethod(), refunds = byMethod(), suppliers = byMethod(), bounced = byMethod(), expenses = byMethod();
  let atSale = 0, laterOnBills = 0, collections = 0, fromFinanciers = 0, fromSuppliers = 0;
  const persons = new Map(), places = new Map();
  // { received: Map("upi|PhonePe" -> paise), refunds, suppliers, bounced }
  const named = { received: new Map(), refunds: new Map(), suppliers: new Map(), bounced: new Map(), expenses: new Map() };
  const addNamed = (group, method, name, amount) => {
    const key = `${method}|${displayName(method, name)}`;
    named[group].set(key, (named[group].get(key) || 0) + amount);
  };
  const personRow = (key) => {
    if (!persons.has(key)) persons.set(key, { userId: key, bills: 0, sales: 0, in: byMethod(), out: 0 });
    return persons.get(key);
  };
  const placeRow = (key) => {
    if (!places.has(key)) places.set(key, { locationId: key, bills: 0, sales: 0, in: byMethod(), out: 0 });
    return places.get(key);
  };
  const seesExpenses = access.can(business, 'expenses.view');
  money.push(...await require('./businessExpenses.service').moneyRows(business,from,to,locationId,db));
  for (const row of money) {
    const amount = paise(row.amount);
    const method = METHODS.includes(row.method) ? row.method : null;
    if (row.source === 'sale_payment' || row.source === 'collection' || row.source === 'finance_payout' || row.source === 'supplier_refund') {
      if (method) { received[method] += amount; addNamed('received', method, row.method_name, amount); }
      if (row.source === 'collection') collections += amount;
      else if (row.source === 'finance_payout') fromFinanciers += amount;
      else if (row.source === 'supplier_refund') { if (method) fromSuppliers += amount; }
      else if (row.at_sale) atSale += amount;
      else laterOnBills += amount;
      if (method) { personRow(String(row.person)).in[method] += amount; placeRow(String(row.location_id)).in[method] += amount; }
    } else {
      if (method) {
        ({ refund: refunds, bounce: bounced, expense: expenses }[row.source] || suppliers)[method] -= amount;
        addNamed({ refund: 'refunds', bounce: 'bounced', expense: 'expenses' }[row.source] || 'suppliers', method, row.method_name, -amount);
      }
      personRow(String(row.person)).out -= amount;
      placeRow(String(row.location_id)).out -= amount;
    }
  }
  for (const p of people) {
    const row = personRow(String(p.person));
    row.bills = p.bills; row.sales = paise(p.sales);
  }
  const placeSales = await repo.all(db, `SELECT d.location_id, count(*)::int AS bills, sum(d.total) AS sales FROM business_documents d
    WHERE d.business_id=$1 AND d.kind='sale' AND ${day('d.created_at')} AND ($5::bigint IS NULL OR d.location_id=$5) GROUP BY d.location_id`, values);
  for (const p of placeSales) {
    const row = placeRow(String(p.location_id));
    row.bills = p.bills; row.sales = paise(p.sales);
  }
  const names = persons.size ? await repo.all(db, 'SELECT id,name FROM users WHERE id=ANY($1::bigint[])', [[...persons.keys()]]) : [];
  const sum = (o) => Object.values(o).reduce((s, x) => s + x, 0);
  const asMoney = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, rupees(x)]));
  const discount = (source) => paise(discounts.find((d) => d.source === source)?.amount);
  // Each kind's names in the usual kind order, then by name.
  const namedList = (map) => [...map.entries()].filter(([, amount]) => amount !== 0)
    .map(([key, amount]) => { const [method, ...rest] = key.split('|'); return { method, name: rest.join('|'), amount: rupees(amount) }; })
    .sort((a, b) => METHODS.indexOf(a.method) - METHODS.indexOf(b.method) || a.name.localeCompare(b.name));
  return {
    from, to, timezone: business.timezone, locationId, generatedAt: new Date().toISOString(), seller,
    sales: {
      bills: sales.bills, total: rupees(paise(sales.total)), tax: rupees(paise(sales.tax)), roundOff: rupees(paise(sales.round_off)),
      returns: rupees(paise(returns.total)), returnsCount: returns.count, net: rupees(paise(sales.total) - paise(returns.total)),
      onCredit: rupees(paise(sales.on_credit)), walkInBills: sales.walk_in_bills, walkInUnpaid: rupees(paise(sales.walk_in_unpaid)),
      offers: rupees(discount('offer')), points: rupees(discount('points')), counterDiscounts: rupees(discount('manual')),
    },
    received: { ...asMoney(received), total: rupees(sum(received)), atSale: rupees(atSale), laterOnBills: rupees(laterOnBills), collections: rupees(collections), fromFinanciers: rupees(fromFinanciers), fromSuppliers: rupees(fromSuppliers) },
    // EMI: financed on today's bills (owed by financiers, not in the drawer),
    // loans cancelled, and the subvention financiers kept from their payouts.
    finance: { booked: rupees(paise(finance.booked)), bills: finance.bills, cancelled: rupees(paise(finance.cancelled)), subvention: rupees(paise(finance.subvention)) },
    refunds: { ...asMoney(refunds), total: rupees(sum(refunds)) },
    suppliers: { ...asMoney(suppliers), total: rupees(sum(suppliers)) },
    // Cheques returned unpaid on these days (counted as money in on the day
    // they were received; their receipt stops counting the day they bounce).
    bounced: { ...asMoney(bounced), total: rupees(sum(bounced)) },
    expenses: seesExpenses ? { ...asMoney(expenses), total: rupees(sum(expenses)), visible: true } : { visible: false },
    // Cash that came in less cash that went out over these days.
    cashInHand: rupees(received.cash - refunds.cash - suppliers.cash - bounced.cash - expenses.cash),
    net: rupees(sum(received) - sum(refunds) - sum(suppliers) - sum(bounced) - sum(expenses)),
    // The same money by the business's own method names: [{ method (kind), name, amount }].
    byMethodName: { received: namedList(named.received), refunds: namedList(named.refunds), suppliers: namedList(named.suppliers), bounced: namedList(named.bounced), expenses: seesExpenses ? namedList(named.expenses) : [] },
    byPerson: [...persons.values()].map((p) => ({ ...p, name: names.find((n) => String(n.id) === p.userId)?.name || `User ${p.userId}`,
      sales: rupees(p.sales), in: asMoney(p.in), received: rupees(sum(p.in)), out: rupees(p.out) })).sort((a, b) => b.bills - a.bills || a.name.localeCompare(b.name)),
    byLocation: [...places.values()].map((p) => ({ ...p, name: locations.find((l) => String(l.id) === p.locationId)?.name || `Location ${p.locationId}`,
      sales: rupees(p.sales), in: asMoney(p.in), received: rupees(sum(p.in)), out: rupees(p.out) })),
  };
}

// The overview's "today at the counter" figures and what needs doing today,
// per business type (pro pass C-03, D-08, E-24). Each figure is sent only to
// someone allowed to see what it adds up (the route filters by FIGURES).
async function today(business) {
  const has = (module) => business.modules.includes(module);
  const id = business.id;
  const tz = business.timezone;
  const day = `(now() AT TIME ZONE $2)::date`;
  const result = {};
  const counter = await repo.one(repo.pool, `SELECT
      (SELECT count(*)::int FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND (d.created_at AT TIME ZONE $2)::date=${day} AND ($3::bigint IS NULL OR d.location_id=$3)) AS bills_today,
      (SELECT json_object_agg(method, amount) FROM (SELECT p.method, sum(p.amount) AS amount FROM business_payments p
        JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
        WHERE p.business_id=$1 AND d.kind='sale' AND p.collection_id IS NULL AND p.method<>'finance' AND (p.created_at AT TIME ZONE $2)::date=${day}
          AND ($3::bigint IS NULL OR d.location_id=$3) GROUP BY p.method
        UNION ALL SELECT 'collections', sum(k.amount) FROM business_collections k WHERE k.business_id=$1 AND (k.created_at AT TIME ZONE $2)::date=${day}
          AND ($3::bigint IS NULL OR k.location_id=$3) HAVING count(*)>0) x) AS taken_today,
      (SELECT COALESCE(sum(d.total - COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id AND p.created_at=d.created_at),0)),0)
        FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id IS NOT NULL AND (d.created_at AT TIME ZONE $2)::date=${day}
          AND ($3::bigint IS NULL OR d.location_id=$3)) AS credit_given_today`, [id, tz, business.location_scope || null]);
  Object.assign(result, counter);
  if (has('receivables') && business.modules.includes('sales')) {
    const promises = await repo.one(repo.pool, `WITH latest AS (SELECT DISTINCT ON (contact_id) contact_id,promised_on FROM retail_credit_reminders
        WHERE business_id=$1 ORDER BY contact_id,created_at DESC,id DESC),
      owing AS (SELECT c.id FROM business_contacts c WHERE c.business_id=$1 AND c.kind='customer' AND ${repo.contactBalanceSql('c')}>0)
      SELECT count(*) FILTER (WHERE l.promised_on=${day})::int AS promises_due_today, count(*) FILTER (WHERE l.promised_on<${day})::int AS promises_broken
      FROM latest l JOIN owing o ON o.id=l.contact_id`, [id, tz]);
    Object.assign(result, promises);
  }
  if (has('appointments')) {
    // Still to come today only (a salon's day, not every future booking).
    Object.assign(result, await repo.one(repo.pool, `SELECT count(*)::int AS appointments_left_today FROM business_appointments
      WHERE business_id=$1 AND status='booked' AND starts_at>=now() AND (starts_at AT TIME ZONE $2)::date=${day}`, [id, tz]));
  }
  if (has('exchanges')) {
    Object.assign(result, await repo.one(repo.pool, `SELECT count(*)::int AS exchanges_today FROM business_exchanges WHERE business_id=$1 AND (created_at AT TIME ZONE $2)::date=${day}`, [id, tz]));
  }
  if (has('variants')) {
    // Styles with some sizes sold out while others are still in stock.
    Object.assign(result, await repo.one(repo.pool, `SELECT count(*)::int AS broken_sizes FROM (SELECT v.product_id FROM fashion_variants v
        JOIN catalog_skus s ON s.business_id=v.business_id AND s.id=v.sku_id AND s.active
        LEFT JOIN LATERAL (SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id) st ON true
        WHERE v.business_id=$1 GROUP BY v.product_id HAVING bool_or(st.q>0) AND bool_or(st.q<=0)) x`, [id]));
  }
  if (has('repairs')) {
    Object.assign(result, await repo.one(repo.pool, `SELECT count(*) FILTER (WHERE status='ready')::int AS repairs_ready,
        count(*) FILTER (WHERE status NOT IN ('ready','delivered','cancelled') AND promised_on < ${day})::int AS repairs_overdue
      FROM electronics_repair_jobs WHERE business_id=$1`, [id, tz]));
  }
  if (has('warranties')) {
    Object.assign(result, await repo.one(repo.pool, `SELECT count(*)::int AS warranties_missing FROM business_document_lines dl
      JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id AND d.kind='sale'
      JOIN electronics_models m ON m.business_id=dl.business_id AND m.sku_id=dl.sku_id AND m.warranty_months>0
      WHERE dl.business_id=$1 AND dl.lot_code<>''
        AND NOT EXISTS (SELECT 1 FROM electronics_warranties w WHERE w.business_id=dl.business_id AND w.line_id=dl.id AND w.status='active')
        AND COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id),0) < dl.quantity`, [id]));
  }
  if (has('sales_orders')) {
    Object.assign(result, await repo.one(repo.pool, `SELECT count(*)::int AS orders_to_dispatch FROM wholesale_orders WHERE business_id=$1 AND status IN ('open','part_dispatched')`, [id]));
  }
  if (has('purchasing')) {
    Object.assign(result, await repo.one(repo.pool, `SELECT COALESCE(sum(GREATEST(0, d.total
        -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
        -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
        +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0))),0) AS payables_overdue
      FROM business_documents d WHERE d.business_id=$1 AND d.kind='purchase' AND d.due_on < ${day}`, [id, tz]));
  }
  return result;
}

// Who may see each of today's figures.
const TODAY_FIGURES = {
  bills_today: 'sales.view', taken_today: 'sales.view', credit_given_today: 'sales.view', appointments_left_today: 'appointments.view',
  promises_due_today: 'receivables.view', promises_broken: 'receivables.view',
  exchanges_today: 'exchanges.view', broken_sizes: 'inventory.view', repairs_ready: 'repairs.view', repairs_overdue: 'repairs.view',
  warranties_missing: 'warranties.view', orders_to_dispatch: 'sales_orders.view', payables_overdue: 'purchasing.view',
};

module.exports = { takings, today, TODAY_FIGURES };
