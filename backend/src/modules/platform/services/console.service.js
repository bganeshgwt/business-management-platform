const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const { STATES, gstinProblem } = require('../../../utils/gstin');
const math = require('./planMath');
const settings = require('./planSettings.service');
const catalogue = require('./planCatalogue.service');
const subscriptions = require('./subscriptions.service');
const invoices = require('./planInvoices.service');

// The platform console's operations, for the platform's own super admin: the
// company's settings and the price list, one business's plan, time and use,
// the payments to confirm, and the invoice register. Every change goes through
// the paid plans' own services (planSettings, planCatalogue, subscriptions),
// which keep the rules and write the audit; this file checks who is asking,
// lists, and shapes the answers.
//
// A business is seen in counts and dates only: never its customers, bills,
// patients, or what its own sales came to. The money here is the platform's
// own: its orders, payments and invoices.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };

// Only the platform's own accounts. The router already asks for
// platform.restaurants.manage; a restaurant's user is refused even when a role
// gives them that permission.
function requirePlatform(user) {
  if (!user || user.restaurantId || !(user.permissions || []).includes('platform.restaurants.manage')) {
    fail("The platform console is for the platform's own accounts", 403);
  }
}

// A calendar date from a query or a body, or null when it is not given.
function readDay(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  try { if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(); math.addDays(text, 0); } catch { fail(`${name} must be a date (YYYY-MM-DD)`); }
  return text;
}
const searchOf = (value) => (typeof value === 'string' && value.trim() ? `%${value.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);

// --- Settings and the price list ------------------------------------------------------------

async function getSettings(user) {
  requirePlatform(user);
  return settings.view(await settings.get());
}

async function saveSettings(user, body) {
  requirePlatform(user);
  return settings.view(await settings.update(user, body));
}

// The whole price list, with every business type, so the screen shows each
// type's plans and, from the prices' types, the modules a plan of it may hold.
async function getPrices(user) {
  requirePlatform(user);
  const list = await catalogue.all();
  const types = await repo.all(repo.pool, 'SELECT code,name FROM business_types ORDER BY name');
  return { ...list, types };
}

async function savePrices(user, body) {
  requirePlatform(user);
  await catalogue.update(user, body);
  return getPrices(user);
}

// --- One business -----------------------------------------------------------------------------

async function businessRow(id) {
  const row = await repo.one(repo.pool, `SELECT b.*,t.name AS type_name,r.code AS restaurant_code,r.format,r.status AS restaurant_status,
      s.legal_name,s.gstin,s.city,s.state_code
    FROM businesses b JOIN business_types t ON t.code=b.business_type LEFT JOIN restaurants r ON r.id=b.legacy_restaurant_id
    LEFT JOIN business_settings s ON s.business_id=b.id WHERE b.id=$1`, [v.requiredId(id, 'Business')]);
  if (!row) fail('Business not found', 404);
  return row;
}

// Who owns it: its full-access members, or, for a restaurant, the
// restaurant's admins (the logins that manage its users and roles).
async function ownersOf(row) {
  const people = row.legacy_restaurant_id
    ? await repo.all(repo.pool, `SELECT u.id,u.name,u.email,u.mobile,u.last_login_at FROM users u
        WHERE u.restaurant_id=$1 AND u.status='active' AND (SELECT count(DISTINCT p.code) FROM user_roles ur JOIN roles ro ON ro.id=ur.role_id AND ro.status='active'
          JOIN role_permissions rp ON rp.role_id=ro.id JOIN permissions p ON p.id=rp.permission_id
          WHERE ur.user_id=u.id AND p.code IN ('users.manage','roles.manage'))=2
        ORDER BY u.name`, [row.legacy_restaurant_id])
    : await repo.all(repo.pool, `SELECT u.id,u.name,u.email,u.mobile,u.last_login_at FROM business_memberships m
        JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.full_access JOIN users u ON u.id=m.user_id
        WHERE m.business_id=$1 AND m.active ORDER BY u.name`, [row.id]);
  return people.map((p) => ({ id: p.id, name: p.name, email: p.email, mobile: p.mobile, lastLoginAt: p.last_login_at }));
}

// How much the business is used, in counts and dates only: the last sign-in
// of any of its people, its sales documents this month (its own month) and in
// all (a restaurant's bills, void ones left out), its active people and its
// active locations (a restaurant's outlets). Never what was sold, to whom, or
// what it came to.
async function usageOf(row) {
  const monthStart = "(date_trunc('month', business_local_today($2)::timestamp) AT TIME ZONE business_time_zone($2))";
  const counts = row.legacy_restaurant_id
    ? await repo.one(repo.pool, `SELECT
        (SELECT max(u.last_login_at) FROM users u WHERE u.restaurant_id=$1) AS last_sign_in_at,
        (SELECT count(*)::int FROM bills x WHERE x.restaurant_id=$1 AND x.bill_status<>'void' AND x.billed_at>=${monthStart}) AS this_month,
        (SELECT count(*)::int FROM bills x WHERE x.restaurant_id=$1 AND x.bill_status<>'void') AS in_all,
        (SELECT count(*)::int FROM users u WHERE u.restaurant_id=$1 AND u.status='active') AS people,
        (SELECT count(*)::int FROM outlets o WHERE o.restaurant_id=$1 AND o.status='active') AS places`, [row.legacy_restaurant_id, row.id])
    : await repo.one(repo.pool, `SELECT
        (SELECT max(u.last_login_at) FROM business_memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND m.active) AS last_sign_in_at,
        (SELECT count(*)::int FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND d.created_at>=${monthStart}) AS this_month,
        (SELECT count(*)::int FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale') AS in_all,
        (SELECT count(*)::int FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active' WHERE m.business_id=$1 AND m.active) AS people,
        (SELECT count(*)::int FROM business_locations l WHERE l.business_id=$1 AND l.active) AS places`, [row.id, row.id]);
  return { lastSignInAt: counts.last_sign_in_at, salesThisMonth: counts.this_month, salesTotal: counts.in_all, activeUsers: counts.people, activeLocations: counts.places };
}

const toPeriod = (p) => ({
  id: p.id, kind: p.kind, startsOn: p.starts_on, endsOn: p.ends_on, everything: p.everything, planCode: p.plan_code, planName: p.plan_name, modules: p.modules,
  orderId: p.order_id, reason: p.reason, createdAt: p.created_at, createdBy: p.created_by_name, cancelledAt: p.cancelled_at, cancelledBy: p.cancelled_by_name,
  cancelReason: p.cancel_reason,
});
const toGrant = (g) => ({
  id: g.id, moduleCode: g.module_code, moduleName: g.module_name, kind: g.kind, startsOn: g.starts_on, endsOn: g.ends_on, orderId: g.order_id, reason: g.reason,
  createdAt: g.created_at, createdBy: g.created_by_name, cancelledAt: g.cancelled_at, cancelReason: g.cancel_reason,
});

// One business as the platform sees it: its owners, plan, selection and what
// it may use today, what it can buy, its use in counts and dates, and its
// timeline: access periods, add-on grants, orders (with their lines and
// payments) and invoices.
async function getBusiness(user, id) {
  requirePlatform(user);
  const row = await businessRow(id);
  const db = repo.pool;
  const usage = await usageOf(row);
  const opened = await repo.one(db, 'SELECT max(last_opened_at) AS at FROM business_memberships WHERE business_id=$1 AND active', [row.id]);
  const lastActiveAt = [usage.lastSignInAt, opened.at].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
  const periods = await repo.all(db, `SELECT p.*,pl.name AS plan_name,c.name AS created_by_name,x.name AS cancelled_by_name FROM business_access_periods p
    LEFT JOIN platform_plans pl ON pl.code=p.plan_code LEFT JOIN users c ON c.id=p.created_by LEFT JOIN users x ON x.id=p.cancelled_by
    WHERE p.business_id=$1 ORDER BY p.id`, [row.id]);
  const grants = await repo.all(db, `SELECT a.*,m.name AS module_name,c.name AS created_by_name FROM business_access_addons a
    JOIN platform_modules m ON m.code=a.module_code LEFT JOIN users c ON c.id=a.created_by WHERE a.business_id=$1 ORDER BY a.id`, [row.id]);
  const orderRows = await repo.all(db, 'SELECT * FROM platform_orders WHERE business_id=$1 ORDER BY id DESC LIMIT 100', [row.id]);
  const orders = [];
  for (const order of orderRows) orders.push(await subscriptions.orderView(db, order));
  const invoiceRows = await repo.all(db, 'SELECT id,number,issued_on,paid_on,order_id,total_amount,sample FROM platform_invoices WHERE business_id=$1 ORDER BY id', [row.id]);
  const codes = [...new Set([...periods.flatMap((p) => p.modules), ...orders.flatMap((o) => o.modules || [])])];
  const names = await repo.all(db, 'SELECT code,name FROM platform_modules WHERE code=ANY($1::text[])', [codes]);
  const company = await settings.get(db);
  const { today } = await repo.one(db, 'SELECT business_local_today($1)::text AS today', [row.id]);
  // The place of supply its orders will name, worked out as an order does it:
  // the state of its GSTIN (a restaurant's is in its own settings), else its
  // state in Business settings; null when it has neither yet.
  const ownGstin = row.legacy_restaurant_id
    ? (await repo.one(db, 'SELECT gst_number FROM restaurant_settings WHERE restaurant_id=$1', [row.legacy_restaurant_id]))?.gst_number : null;
  const gstin = row.gstin || (ownGstin && !gstinProblem(ownGstin) ? String(ownGstin).replace(/[\s-]/g, '').toUpperCase() : null);
  const placeOfSupplyCode = gstin ? gstin.slice(0, 2) : row.state_code || null;
  return {
    business: {
      id: row.id, name: row.name, code: row.code, type: row.business_type, typeName: row.type_name, status: row.status, currency: row.currency, timezone: row.timezone,
      createdAt: row.created_at, restaurantId: row.legacy_restaurant_id, restaurantCode: row.restaurant_code, restaurantStatus: row.restaurant_status,
      format: row.format, legalName: row.legal_name, gstin: row.gstin, city: row.city, stateCode: row.state_code, stateName: STATES[row.state_code] || null, lastActiveAt,
      today, placeOfSupplyCode, placeOfSupplyName: STATES[placeOfSupplyCode] || null,
    },
    owners: await ownersOf(row),
    plan: await subscriptions.planOf(row.id, db),
    selection: await subscriptions.selectionOf(db, row.id),
    entitled: (await repo.one(db, 'SELECT business_entitled_modules($1) AS m', [row.id])).m,
    catalogue: await catalogue.forType(row.business_type, db),
    usage,
    periods: periods.map(toPeriod),
    grants: grants.map(toGrant),
    orders,
    invoices: invoiceRows.map((i) => ({ id: i.id, number: i.number, issuedOn: i.issued_on, paidOn: i.paid_on, orderId: i.order_id, total: i.total_amount, sample: i.sample })),
    moduleNames: Object.fromEntries(names.map((m) => [m.code, m.name])),
    sampleMode: settings.isSample(company),
    gstRate: company.gst_rate,
  };
}

// The selection for its next order, set by the platform (also during given time).
async function setSelection(user, id, body) {
  requirePlatform(user);
  return subscriptions.setSelection(await businessRow(id), user, body, { by: 'platform' });
}

async function giveTime(user, id, body) {
  requirePlatform(user);
  return subscriptions.giveTime(user, (await businessRow(id)).id, body);
}

async function giveAddons(user, id, body) {
  requirePlatform(user);
  return subscriptions.giveAddons(user, (await businessRow(id)).id, body);
}

async function createOrder(user, id, body) {
  requirePlatform(user);
  return subscriptions.createOrder(await businessRow(id), user, body, { by: 'platform' });
}

// A payment the platform received for one of the business's open orders:
// entered and confirmed at once.
async function recordPayment(user, id, body) {
  requirePlatform(user);
  return subscriptions.recordPayment(user, (await businessRow(id)).id, body.orderId, body);
}

// --- Payments -------------------------------------------------------------------------------

const PAYMENT_STATES = ['pending', 'confirmed', 'rejected'];

// Every payment, those being checked first, then the newest; filtered by
// state, the date paid and a search (business name or code, reference). With
// them: how many wait, and the open orders with no payment being checked, for
// a payment the platform received.
async function listPayments(user, query = {}) {
  requirePlatform(user);
  const status = query.status ? v.requiredEnum(String(query.status), 'Status', PAYMENT_STATES) : null;
  const from = readDay(query.from, 'From');
  const to = readDay(query.to, 'To');
  const rows = await repo.all(repo.pool, `SELECT p.*,b.name AS business_name,b.code AS business_code,b.business_type,t.name AS type_name,
      o.kind AS order_kind,o.status AS order_status,o.plan_code,o.billing_period,o.starts_on,o.ends_on,sb.name AS submitted_by_name,db.name AS decided_by_name,
      i.id AS invoice_id,i.number AS invoice_number,i.sample AS invoice_sample
    FROM platform_payments p JOIN businesses b ON b.id=p.business_id JOIN business_types t ON t.code=b.business_type
    JOIN platform_orders o ON o.id=p.order_id LEFT JOIN users sb ON sb.id=p.submitted_by LEFT JOIN users db ON db.id=p.decided_by
    LEFT JOIN LATERAL (SELECT x.id,x.number,x.sample FROM platform_invoices x WHERE x.order_id=p.order_id AND NOT x.sample AND x.payment_id=p.id
      UNION ALL SELECT x.id,x.number,x.sample FROM platform_invoices x WHERE x.order_id=p.order_id AND x.sample AND x.payment_id=p.id LIMIT 1) i ON TRUE
    WHERE ($1::text IS NULL OR p.status=$1) AND ($2::date IS NULL OR p.paid_on>=$2) AND ($3::date IS NULL OR p.paid_on<=$3)
      AND ($4::text IS NULL OR concat_ws(' ',b.name,b.code,p.reference) ILIKE $4)
    ORDER BY (p.status='pending') DESC,p.submitted_at DESC,p.id DESC LIMIT 1000`, [status, from, to, searchOf(query.q)]);
  const waiting = await repo.one(repo.pool, "SELECT count(*)::int AS n FROM platform_payments WHERE status='pending'");
  const open = await repo.all(repo.pool, `SELECT o.*,b.name AS business_name,b.code AS business_code,o.valid_until<business_local_today(o.business_id) AS expired
    FROM platform_orders o JOIN businesses b ON b.id=o.business_id
    WHERE o.status='open' AND NOT EXISTS (SELECT 1 FROM platform_payments p WHERE p.order_id=o.id AND p.status='pending')
    ORDER BY o.created_at DESC LIMIT 500`);
  return {
    items: rows.map((p) => ({
      id: p.id, businessId: p.business_id, businessName: p.business_name, businessCode: p.business_code, businessType: p.business_type, typeName: p.type_name,
      orderId: p.order_id, orderKind: p.order_kind, orderStatus: p.order_status, planCode: p.plan_code, billingPeriod: p.billing_period, startsOn: p.starts_on,
      endsOn: p.ends_on, amount: p.amount, method: p.method, reference: p.reference, paidOn: p.paid_on, status: p.status, submittedAt: p.submitted_at,
      submittedBy: p.submitted_by_name, decidedAt: p.decided_at, decidedBy: p.decided_by_name, decisionNote: p.decision_note,
      // Entered by the platform itself (a payment it received), not by the owner.
      recorded: p.status === 'confirmed' && p.submitted_by !== null && p.submitted_by === p.decided_by,
      invoiceId: p.invoice_id, invoiceNumber: p.invoice_number, invoiceSample: p.invoice_sample,
    })),
    pendingCount: waiting.n,
    openOrders: open.map((o) => ({
      id: o.id, businessId: o.business_id, businessName: o.business_name, businessCode: o.business_code, kind: o.kind, planCode: o.plan_code,
      billingPeriod: o.billing_period, startsOn: o.starts_on, endsOn: o.ends_on, total: o.total_amount, validUntil: o.valid_until, createdAt: o.created_at,
      expired: o.expired,
    })),
    sampleMode: settings.isSample(await settings.get()),
  };
}

async function confirmPayment(user, id) {
  requirePlatform(user);
  return subscriptions.applyPayment(user, id);
}

async function rejectPayment(user, id, body) {
  requirePlatform(user);
  return subscriptions.rejectPayment(user, id, body.reason);
}

// --- Invoices -------------------------------------------------------------------------------

// The register of the company's invoices for a period (the date issued), in
// the order they were issued: the real tax invoices, which the GST return is
// filed from, or (sample=true) the SAMPLE ones, kept apart. At most
// REGISTER_ROWS; `truncated` says there were more, so a screen never takes a
// part of a period for the whole of it.
const REGISTER_ROWS = 5000;
async function listInvoices(user, query = {}) {
  requirePlatform(user);
  const sampleText = query.sample === undefined || query.sample === '' ? 'false' : String(query.sample);
  if (!['true', 'false'].includes(sampleText)) fail('sample must be true or false');
  const from = readDay(query.from, 'From');
  const to = readDay(query.to, 'To');
  const rows = await repo.all(repo.pool, `SELECT i.*,b.name AS business_name,b.code AS business_code,o.gst_rate FROM platform_invoices i
    JOIN businesses b ON b.id=i.business_id JOIN platform_orders o ON o.id=i.order_id
    WHERE i.sample=$1 AND ($2::date IS NULL OR i.issued_on>=$2) AND ($3::date IS NULL OR i.issued_on<=$3)
      AND ($4::text IS NULL OR concat_ws(' ',i.number,b.name,b.code,i.buyer->>'name',i.buyer->>'gstin') ILIKE $4)
    ORDER BY i.issued_on,i.id LIMIT ${REGISTER_ROWS + 1}`, [sampleText === 'true', from, to, searchOf(query.q)]);
  const truncated = rows.length > REGISTER_ROWS;
  const items = rows.slice(0, REGISTER_ROWS).map((i) => ({
    id: i.id, number: i.number, issuedOn: i.issued_on, paidOn: i.paid_on, businessId: i.business_id, businessName: i.business_name, businessCode: i.business_code,
    orderId: i.order_id, buyerName: i.buyer.name || null, buyerGstin: i.buyer.gstin || null, placeOfSupplyCode: i.place_of_supply.code,
    placeOfSupplyName: i.place_of_supply.name || STATES[i.place_of_supply.code] || null, gstRate: i.gst_rate, taxable: i.taxable_amount, cgst: i.cgst_amount,
    sgst: i.sgst_amount, igst: i.igst_amount, total: i.total_amount, sample: i.sample, supplierGstin: i.supplier_gstin,
  }));
  const sum = (key) => math.toRupees(items.reduce((total, item) => total + math.toPaise(item[key]), 0n));
  const samples = await repo.one(repo.pool, 'SELECT count(*)::int AS n FROM platform_invoices WHERE sample');
  return {
    items,
    totals: { count: items.length, taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), total: sum('total') },
    truncated,
    sampleCount: samples.n,
    sampleMode: settings.isSample(await settings.get()),
  };
}

// One invoice for its print view, with the business it was issued to and the
// order's other invoice (the tax invoice issued for a sample, or the sample).
async function getInvoice(user, id) {
  requirePlatform(user);
  const invoice = await invoices.view(id);
  const extra = await repo.one(repo.pool, `SELECT b.name,b.code,(SELECT json_build_object('id',x.id,'number',x.number,'sample',x.sample) FROM platform_invoices x
      WHERE x.order_id=i.order_id AND x.id<>i.id ORDER BY x.id LIMIT 1) AS other
    FROM platform_invoices i JOIN businesses b ON b.id=i.business_id WHERE i.id=$1`, [invoice.id]);
  return { ...invoice, businessName: extra.name, businessCode: extra.code, otherInvoice: extra.other };
}

// The real tax invoice for an order invoiced in sample mode, once the real
// GSTIN is saved.
async function issueTaxInvoice(user, orderId) {
  requirePlatform(user);
  return subscriptions.issueTaxInvoice(user, orderId);
}

module.exports = {
  requirePlatform, getSettings, saveSettings, getPrices, savePrices, getBusiness, setSelection, giveTime, giveAddons, createOrder, recordPayment,
  listPayments, confirmPayment, rejectPayment, listInvoices, getInvoice, issueTaxInvoice,
};
