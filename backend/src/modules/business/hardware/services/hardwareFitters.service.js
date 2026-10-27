const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const expenses = require('../../core/services/businessExpenses.service');

// Hardware: the painters, plumbers, electricians, masons and carpenters who
// bring customers (module "fitter_commission").
//
//   fitter register → commission rules (a % of a line's net value for every
//   item, a category and the categories under it, or one item; or a flat
//   amount per stock unit of one item; the most specific wins)
//   → "Fitted by" on a bill: each line's commission worked out in paise when
//     the bill is posted and frozen with it (a later rule change never
//     changes it); a bill made without a fitter may have one named later
//     (by the rules in force then), and its fitter changed until the
//     commission on it is paid (payouts settle a fitter's oldest commission
//     first; a database trigger holds this); a sales order may name a fitter,
//     and every invoice its dispatches raise earns them their commission
//   → goods back on the bill take the commission back in proportion
//     (a database trigger on the return's lines)
//   → payouts, each an expense in the expense book (so Daily money and the
//     reports count it); reversing that expense takes the payout back
//   → a statement per fitter, and earned / taken back / paid / due by fitter.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const given = (value) => value !== undefined && value !== null && value !== '';
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const TRADES = ['painter', 'plumber', 'electrician', 'mason', 'carpenter', 'other'];
const TRADE_WORDS = { painter: 'painter', plumber: 'plumber', electrician: 'electrician', mason: 'mason', carpenter: 'carpenter', other: 'fitter' };
const MODULE_OFF = 'Fitters\' commission is not switched on for this business. An owner can turn it on in Settings › Business tools.';

function requireFitters(business) {
  if (business.business_type !== 'hardware') fail('Fitters belong to hardware shops', 404);
  if (!business.modules.includes('fitter_commission')) fail(MODULE_OFF, 403);
}

// A fitter's commission earned, taken back by returns, and paid (payouts
// whose expense was not reversed).
const earnedSql = (f) => `COALESCE((SELECT sum(b.commission) FROM hardware_fitter_bills b WHERE b.business_id=${f}.business_id AND b.fitter_id=${f}.id),0)`;
const takenBackSql = (f) => `COALESCE((SELECT sum(r.amount) FROM hardware_fitter_reversals r JOIN hardware_fitter_bills b ON b.business_id=r.business_id AND b.document_id=r.document_id
  WHERE b.business_id=${f}.business_id AND b.fitter_id=${f}.id),0)`;
const paidSql = (f) => `COALESCE((SELECT sum(p.amount) FROM hardware_fitter_payouts p JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id
  WHERE p.business_id=${f}.business_id AND p.fitter_id=${f}.id AND e.voided_at IS NULL),0)`;
const PAYOUT_SQL = `SELECT p.*,f.name AS fitter_name,f.trade,f.upi_id,e.method,e.method_name,e.reference,e.location_id,l.name AS location_name,e.voided_at,e.void_reason,
  (e.voided_at IS NOT NULL) AS reversed,u.name AS created_by_name
  FROM hardware_fitter_payouts p JOIN hardware_fitters f ON f.business_id=p.business_id AND f.id=p.fitter_id
  JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id
  JOIN business_locations l ON l.business_id=e.business_id AND l.id=e.location_id JOIN users u ON u.id=p.created_by WHERE p.business_id=$1`;

repo.addLists({
  'hardware-fitters': {
    sql: `SELECT x.*,(x.earned-x.taken_back-x.paid) AS due,(x.earned-x.taken_back-x.paid>0) AS has_due FROM (
      SELECT f.*,(SELECT count(*)::int FROM hardware_fitter_bills b WHERE b.business_id=f.business_id AND b.fitter_id=f.id) AS bill_count,
      (SELECT max(b.created_at) FROM hardware_fitter_bills b WHERE b.business_id=f.business_id AND b.fitter_id=f.id) AS last_bill_at,
      ${earnedSql('f')} AS earned,${takenBackSql('f')} AS taken_back,${paidSql('f')} AS paid
      FROM hardware_fitters f WHERE f.business_id=$1) x`,
    search: ['name', 'phone', 'upi_id', 'area', 'trade'], filters: { active: 'active', trade: 'trade', id: 'id', has_due: 'has_due' }, order: 'active DESC,name',
  },
  'hardware-fitter-rules': {
    sql: `SELECT r.*,c.name AS category_name,s.label AS sku_label,s.code AS sku_code,s.unit AS sku_unit,u.name AS created_by_name,
      CASE WHEN r.sku_id IS NOT NULL THEN 'item' WHEN r.category_id IS NOT NULL THEN 'category' ELSE 'all' END AS scope
      FROM hardware_fitter_rules r LEFT JOIN catalog_categories c ON c.business_id=r.business_id AND c.id=r.category_id
      LEFT JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id JOIN users u ON u.id=r.created_by WHERE r.business_id=$1`,
    search: ['category_name', 'sku_label', 'sku_code'], filters: { active: 'active', scope: 'scope' },
    order: "active DESC,scope='item' DESC,scope='category' DESC,category_name,sku_label",
  },
  'hardware-fitter-payouts': {
    sql: PAYOUT_SQL, search: ['fitter_name', 'reference', 'notes'], date: 'created_at', filters: { fitter: 'fitter_id', location: 'location_id', reversed: 'reversed' }, order: 'id DESC',
  },
});

function readPhone(value) {
  const phone = v.optionalString(value, 'Phone', 30);
  if (phone && phone.replace(/\D/g, '').length < 10) fail('A phone number has at least 10 digits');
  return phone || null;
}
function readFitter(body) {
  const upiId = v.optionalString(body.upiId, 'UPI id', 100);
  if (upiId && !/^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(upiId)) fail('A UPI id looks like name@bank, for example ramesh@okicici');
  return { name: v.requiredString(body.name, 'Name', 150), trade: v.requiredEnum(body.trade, 'Trade', TRADES), phone: readPhone(body.phone),
    upiId: upiId || null, area: v.optionalString(body.area, 'Area', 100) || null };
}
async function phoneFree(db, business, phone, fitterId = null) {
  if (!phone) return;
  const clash = await repo.one(db, 'SELECT name FROM hardware_fitters WHERE business_id=$1 AND phone=$2 AND ($3::bigint IS NULL OR id<>$3)', [business.id, phone, fitterId]);
  if (clash) fail(`${clash.name} already has this phone number`, 409);
}

// --- Fitters --------------------------------------------------------------------------------------

// body: { name, trade, phone?, upiId?, area? }
async function create(business, user, body) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.create');
  const f = readFitter(body);
  return repo.transaction(async (db) => {
    await phoneFree(db, business, f.phone);
    const row = await repo.one(db, `INSERT INTO hardware_fitters(business_id,name,trade,phone,upi_id,area,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [business.id, f.name, f.trade, f.phone, f.upiId, f.area, user.id]);
    await repo.audit(db, business.id, user.id, 'fitter.created', row.id, { name: row.name, trade: row.trade });
    return row;
  });
}

// body: { name, trade, phone?, upiId?, area?, active? } — a fitter switched off keeps what they earned and are owed.
async function update(business, user, fitterId, body) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.edit');
  const f = readFitter(body);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM hardware_fitters WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(fitterId, 'Fitter')]);
    if (!current) fail('Fitter not found', 404);
    const active = v.requiredBoolean(body.active, 'Active', current.active);
    await phoneFree(db, business, f.phone, current.id);
    const row = await repo.one(db, `UPDATE hardware_fitters SET name=$3,trade=$4,phone=$5,upi_id=$6,area=$7,active=$8,updated_by=$9,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, current.id, f.name, f.trade, f.phone, f.upiId, f.area, active, user.id]);
    await repo.audit(db, business.id, user.id, 'fitter.updated', row.id, { name: row.name, active, ...(active !== current.active ? { was: current.active ? 'active' : 'switched off' } : {}) });
    return row;
  });
}

// --- Commission rules ---------------------------------------------------------------------------

const scopeWords = (rule) => (rule.sku_label ? rule.sku_label : rule.category_name ? `everything in ${rule.category_name}` : 'every item');
const PER_UNIT_ONE_ITEM = 'An amount per unit is set for one item; for a category or every item give a percent';

// body: { categoryId? | skuId?, percent? | perUnit? } — neither id: every item; an amount per unit for one item only.
async function createRule(business, user, body) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.edit');
  if (given(body.categoryId) && given(body.skuId)) fail('A rule is for every item, a category or one item, not two at once');
  if (given(body.percent) === given(body.perUnit)) fail('Give the commission as a percent of the net value, or (for one item) an amount per unit');
  const percent = given(body.percent) ? core.decimal(body.percent, 'Commission %', 2, 0.01, 50) : null;
  const perUnit = given(body.perUnit) ? core.decimal(body.perUnit, 'Commission per unit', 2, 0.01, 100000) : null;
  if (perUnit !== null && !given(body.skuId)) fail(PER_UNIT_ONE_ITEM);
  return repo.transaction(async (db) => {
    let category = null, sku = null;
    if (given(body.categoryId)) {
      category = await repo.one(db, 'SELECT id,name FROM catalog_categories WHERE business_id=$1 AND id=$2', [business.id, id(body.categoryId, 'Category')]);
      if (!category) fail('Category not found', 404);
    }
    if (given(body.skuId)) {
      sku = await repo.one(db, 'SELECT id,label FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, id(body.skuId, 'Item')]);
      if (!sku) fail('Item not found', 404);
    }
    const scope = { sku_label: sku?.label, category_name: category?.name };
    const clash = await repo.one(db, 'SELECT id FROM hardware_fitter_rules WHERE business_id=$1 AND active AND COALESCE(category_id,0)=$2 AND COALESCE(sku_id,0)=$3',
      [business.id, category?.id || 0, sku?.id || 0]);
    if (clash) fail(`There is already a rule for ${scopeWords(scope)}: change it or switch it off first`, 409);
    const row = await repo.one(db, 'INSERT INTO hardware_fitter_rules(business_id,category_id,sku_id,percent,per_unit,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *',
      [business.id, category?.id || null, sku?.id || null, percent, perUnit, user.id]);
    await repo.audit(db, business.id, user.id, 'fitter_rule.created', row.id, { scope: scopeWords(scope), percent: row.percent, perUnit: row.per_unit });
    return row;
  });
}

// body: { percent? | perUnit?, active? } — a bill already posted keeps the commission it earned.
async function updateRule(business, user, ruleId, body) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.edit');
  return repo.transaction(async (db) => {
    const rule = await repo.one(db, `SELECT r.*,c.name AS category_name,s.label AS sku_label FROM hardware_fitter_rules r
      LEFT JOIN catalog_categories c ON c.business_id=r.business_id AND c.id=r.category_id LEFT JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id
      WHERE r.business_id=$1 AND r.id=$2 FOR UPDATE OF r`, [business.id, id(ruleId, 'Rule')]);
    if (!rule) fail('Rule not found', 404);
    const active = v.requiredBoolean(body.active, 'Active', rule.active);
    let percent = rule.percent, perUnit = rule.per_unit;
    if (given(body.percent) || given(body.perUnit)) {
      if (given(body.percent) && given(body.perUnit)) fail('Give a percent or an amount per unit, not both');
      percent = given(body.percent) ? core.decimal(body.percent, 'Commission %', 2, 0.01, 50) : null;
      perUnit = given(body.perUnit) ? core.decimal(body.perUnit, 'Commission per unit', 2, 0.01, 100000) : null;
      if (perUnit !== null && !rule.sku_id) fail(PER_UNIT_ONE_ITEM);
    }
    if (active && !rule.active) {
      const clash = await repo.one(db, 'SELECT id FROM hardware_fitter_rules WHERE business_id=$1 AND active AND id<>$2 AND COALESCE(category_id,0)=$3 AND COALESCE(sku_id,0)=$4',
        [business.id, rule.id, rule.category_id || 0, rule.sku_id || 0]);
      if (clash) fail(`Another rule for ${scopeWords(rule)} is on: switch it off first`, 409);
    }
    const row = await repo.one(db, 'UPDATE hardware_fitter_rules SET percent=$3,per_unit=$4,active=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, rule.id, percent, perUnit, active, user.id]);
    await repo.audit(db, business.id, user.id, 'fitter_rule.updated', row.id, { scope: scopeWords(rule),
      from: { percent: rule.percent, perUnit: rule.per_unit, active: rule.active }, to: { percent: row.percent, perUnit: row.per_unit, active } });
    return row;
  });
}

// --- Commission on a bill (inside the sale's own posting) -------------------------------------

// Each item's category, then the categories above it, nearest first.
async function categoryPaths(db, businessId, skuIds) {
  const rows = await repo.all(db, `WITH RECURSIVE up AS (
      SELECT s.id AS sku_id,p.category_id,1 AS depth FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=ANY($2::bigint[]) AND p.category_id IS NOT NULL
      UNION ALL SELECT up.sku_id,c.parent_id,up.depth+1 FROM up JOIN catalog_categories c ON c.business_id=$1 AND c.id=up.category_id
      WHERE c.parent_id IS NOT NULL AND up.depth<6)
    SELECT sku_id,array_agg(category_id ORDER BY depth) AS categories FROM up GROUP BY sku_id`, [businessId, skuIds]);
  return new Map(rows.map((r) => [Number(r.sku_id), r.categories.map(Number)]));
}

// The rule a line earns by: the item's own, else its nearest category's, else every item's.
function ruleFor(rules, paths, skuId) {
  return rules.find((r) => r.sku_id && Number(r.sku_id) === skuId)
    || (paths.get(skuId) || []).map((categoryId) => rules.find((r) => r.category_id && Number(r.category_id) === categoryId)).find(Boolean)
    || rules.find((r) => !r.sku_id && !r.category_id) || null;
}

// What one line earns, in paise: a percent of its net value, or an amount per
// stock unit; never more than the net.
function lineCommission(rule, line) {
  if (rule.percent !== null) return roundedDivide(BigInt(line.net) * BigInt(paise(rule.percent)), 10000n);
  return Math.min(line.net, roundedDivide(BigInt(paise(rule.per_unit)) * BigInt(milli(line.quantity)), 1000n));
}

// A fitter who may be named on a bill: this business's, and switched on.
async function activeFitter(db, business, fitterId) {
  const fitter = await repo.one(db, 'SELECT * FROM hardware_fitters WHERE business_id=$1 AND id=$2', [business.id, id(fitterId, 'Fitter')]);
  if (!fitter) fail('Fitter not found', 404);
  if (!fitter.active) fail(`${fitter.name} is switched off. Switch them on again under Fitters to name them on a bill.`, 409);
  return fitter;
}

// saved: the sale just inserted; prepared: its lines (with ids, quantity in
// stock units, net in paise). A bill whose lines earn nothing still records
// its fitter.
async function recordBill(db, business, user, saved, prepared, fitterId) {
  if (!business.modules.includes('fitter_commission')) fail(MODULE_OFF, 403);
  await access.require(business, 'fitter_commission.create');
  await earn(db, business, user, saved, prepared, await activeFitter(db, business, fitterId));
}

// The commission each line earns by the rules in force, recorded with the
// bill and its fitter (inside the caller's transaction).
async function earn(db, business, user, saved, prepared, fitter) {
  const rules = await repo.all(db, 'SELECT * FROM hardware_fitter_rules WHERE business_id=$1 AND active', [business.id]);
  const paths = await categoryPaths(db, business.id, [...new Set(prepared.map((l) => Number(l.sku.id)))]);
  const earned = [];
  for (const line of prepared) {
    const rule = ruleFor(rules, paths, Number(line.sku.id));
    const commission = rule ? lineCommission(rule, line) : 0;
    if (commission > 0) earned.push({ line, rule, commission });
  }
  const total = earned.reduce((sum, e) => sum + e.commission, 0);
  await db.query('INSERT INTO hardware_fitter_bills(business_id,document_id,fitter_id,commission,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, saved.id, fitter.id, rupees(total), user.id]);
  for (const { line, rule, commission } of earned) {
    await db.query('INSERT INTO hardware_fitter_lines(business_id,line_id,document_id,rule_id,percent,per_unit,quantity,net,commission) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [business.id, line.id, saved.id, rule.id, rule.percent, rule.per_unit, line.quantity, rupees(line.net), rupees(commission)]);
  }
  await repo.audit(db, business.id, user.id, 'fitter_commission.earned', saved.id, { documentNo: saved.document_no, fitter: fitter.name, commission: rupees(total) });
  await repo.event(db, business.id, user.id, 'fitter_commission.earned', 'document', saved.id, { documentNo: saved.document_no, fitterId: fitter.id, commission: rupees(total),
    lines: earned.map((e) => ({ lineId: e.line.id, ruleId: e.rule.id, commission: rupees(e.commission) })) });
  return earned;
}

// --- A fitter named on a bill afterwards, and on a sales order ----------------------------------

// A posted bill's lines as a new bill's would be (ids, items, stock-unit quantity, net in paise).
async function billLines(db, business, documentId) {
  const rows = await repo.all(db, 'SELECT id,sku_id,quantity,net FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, documentId]);
  return rows.map((r) => ({ id: r.id, sku: { id: r.sku_id }, quantity: Number(r.quantity), net: paise(r.net) }));
}

// A fitter named on a bill already posted: its lines earn by the rules in
// force now, and what came back on the bill before takes back its share, as
// a return after naming them would (the database's own formula, in order).
async function nameLater(db, business, user, doc, fitter) {
  const earned = await earn(db, business, user, doc, await billLines(db, business, doc.id), fitter);
  for (const { line, commission } of earned) {
    const back = await repo.all(db, 'SELECT id,return_id,quantity FROM business_return_lines WHERE business_id=$1 AND line_id=$2 ORDER BY id', [business.id, line.id]);
    let returned = 0, reversed = 0;
    for (const r of back) {
      returned += milli(r.quantity);
      const share = roundedDivide(BigInt(commission) * BigInt(Math.min(returned, milli(line.quantity))), BigInt(milli(line.quantity)));
      const amount = Math.max(0, share - reversed);
      reversed += amount;
      await db.query(`INSERT INTO hardware_fitter_reversals(business_id,return_line_id,return_id,line_id,document_id,quantity,amount) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [business.id, r.id, r.return_id, line.id, doc.id, r.quantity, rupees(amount)]);
    }
  }
}

// body: { fitterId } — names the fitter on a bill made without one (the
// commission worked out now), or changes it while the commission on it is
// not paid. Someone who may manage commission does it; the activity log keeps it.
async function setBillFitter(business, user, documentId, body) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(documentId, 'Bill')]);
    if (!doc) fail('Bill not found', 404);
    access.requireLocation(business, doc.location_id);
    if (doc.kind !== 'sale') fail('A fitter is named on a sale');
    const fitter = await activeFitter(db, business, body.fitterId);
    const current = await repo.one(db, 'SELECT b.*,f.name AS fitter_name FROM hardware_fitter_bills b JOIN hardware_fitters f ON f.business_id=b.business_id AND f.id=b.fitter_id WHERE b.business_id=$1 AND b.document_id=$2 FOR UPDATE OF b',
      [business.id, doc.id]);
    if (current && String(current.fitter_id) === String(fitter.id)) return billExtras(db, business, doc.id);
    if (!current) {
      await nameLater(db, business, user, doc, fitter);
      await repo.audit(db, business.id, user.id, 'fitter_commission.named_later', doc.id, { documentNo: doc.document_no, fitter: fitter.name });
    } else {
      // The database refuses once the commission on the bill is paid (hardware_fitter_bills_guard).
      await db.query('UPDATE hardware_fitter_bills SET fitter_id=$3,changed_by=$4,changed_at=now() WHERE business_id=$1 AND document_id=$2', [business.id, doc.id, fitter.id, user.id]);
      await repo.audit(db, business.id, user.id, 'fitter_commission.fitter_changed', doc.id, { documentNo: doc.document_no, from: current.fitter_name, to: fitter.name,
        commission: current.commission });
      await repo.event(db, business.id, user.id, 'fitter_commission.moved', 'document', doc.id, { documentNo: doc.document_no, fromFitterId: current.fitter_id,
        toFitterId: fitter.id, commission: current.commission });
    }
    return billExtras(db, business, doc.id);
  });
}

async function orderFitter(business, orderId) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.view');
  const row = await repo.one(repo.pool, `SELECT f.id,f.name,f.trade,f.phone,f.active FROM hardware_order_fitters o JOIN hardware_fitters f ON f.business_id=o.business_id AND f.id=o.fitter_id
    WHERE o.business_id=$1 AND o.order_id=$2`, [business.id, id(orderId, 'Sales order')]);
  return { fitter: row || null };
}

// body: { fitterId } (null takes it off) — while the order is still to send.
// Its invoices from now on earn the fitter their commission; those already
// raised without a fitter are named now when the person may also name a
// fitter on a bill afterwards (manage commission).
async function setOrderFitter(business, user, orderId, body) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.create');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const order = await repo.one(db, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Sales order')]);
    if (!order) fail('Sales order not found', 404);
    access.requireLocation(business, order.location_id);
    if (['closed', 'cancelled'].includes(order.status) || order.status === 'dispatched') fail(`Sales order ${order.order_no} is ${order.status}; its fitter no longer changes`, 409);
    const current = await repo.one(db, 'SELECT o.fitter_id,f.name FROM hardware_order_fitters o JOIN hardware_fitters f ON f.business_id=o.business_id AND f.id=o.fitter_id WHERE o.business_id=$1 AND o.order_id=$2',
      [business.id, order.id]);
    if (!given(body.fitterId)) {
      if (current) {
        await db.query('DELETE FROM hardware_order_fitters WHERE business_id=$1 AND order_id=$2', [business.id, order.id]);
        await repo.audit(db, business.id, user.id, 'sales_order.fitter_cleared', order.id, { orderNo: order.order_no, fitter: current.name });
      }
      return { fitter: null };
    }
    const fitter = await activeFitter(db, business, body.fitterId);
    if (!current || String(current.fitter_id) !== String(fitter.id)) {
      await db.query(`INSERT INTO hardware_order_fitters(business_id,order_id,fitter_id,set_by) VALUES($1,$2,$3,$4)
        ON CONFLICT (business_id,order_id) DO UPDATE SET fitter_id=EXCLUDED.fitter_id,set_by=EXCLUDED.set_by,set_at=now()`, [business.id, order.id, fitter.id, user.id]);
      await repo.audit(db, business.id, user.id, 'sales_order.fitter_set', order.id, { orderNo: order.order_no, fitter: fitter.name, ...(current ? { from: current.name } : {}) });
    }
    const raised = !access.can(business, 'fitter_commission.edit') ? [] : await repo.all(db, `SELECT d.* FROM wholesale_dispatches w
      JOIN business_documents d ON d.business_id=w.business_id AND d.id=w.document_id
      WHERE w.business_id=$1 AND w.order_id=$2 AND NOT EXISTS (SELECT 1 FROM hardware_fitter_bills b WHERE b.business_id=w.business_id AND b.document_id=w.document_id)
      ORDER BY d.id`, [business.id, order.id]);
    for (const doc of raised) {
      await nameLater(db, business, user, doc, fitter);
      await repo.audit(db, business.id, user.id, 'fitter_commission.named_later', doc.id, { documentNo: doc.document_no, fitter: fitter.name, orderNo: order.order_no });
    }
    return { fitter: { id: fitter.id, name: fitter.name, trade: fitter.trade, phone: fitter.phone, active: fitter.active } };
  });
}

// An invoice a sales order's dispatch raised (inside the dispatch's own
// transaction): it earns the order's fitter their commission, when the order
// names one who is still on.
async function orderInvoice(db, business, user, orderId, doc) {
  if (business.business_type !== 'hardware' || !business.modules.includes('fitter_commission')) return;
  const named = await repo.one(db, `SELECT f.* FROM hardware_order_fitters o JOIN hardware_fitters f ON f.business_id=o.business_id AND f.id=o.fitter_id
    WHERE o.business_id=$1 AND o.order_id=$2`, [business.id, orderId]);
  if (!named?.active) return;
  await earn(db, business, user, doc, await billLines(db, business, doc.id), named);
}

// The fitter of a bill and, for those who see commission, what it earned,
// what returns took back, and each line's share.
async function billExtras(db, business, documentId) {
  const row = await repo.one(db, `SELECT f.id,f.name,f.trade,b.commission,
    COALESCE((SELECT sum(r.amount) FROM hardware_fitter_reversals r WHERE r.business_id=b.business_id AND r.document_id=b.document_id),0) AS taken_back
    FROM hardware_fitter_bills b JOIN hardware_fitters f ON f.business_id=b.business_id AND f.id=b.fitter_id WHERE b.business_id=$1 AND b.document_id=$2`, [business.id, documentId]);
  if (!row) return null;
  if (!access.can(business, 'fitter_commission.view')) return { id: row.id, name: row.name, trade: row.trade };
  const lines = await repo.all(db, 'SELECT line_id,percent,per_unit,commission FROM hardware_fitter_lines WHERE business_id=$1 AND document_id=$2 ORDER BY line_id', [business.id, documentId]);
  return { ...row, lines };
}

// --- Statement, payouts and the report ----------------------------------------------------------

// Everything a fitter earned, lost to returns and was paid, in date order with the running balance.
async function statement(business, fitterId) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.view');
  const fitter = await repo.one(repo.pool, `SELECT f.*,${earnedSql('f')} AS earned,${takenBackSql('f')} AS taken_back,${paidSql('f')} AS paid
    FROM hardware_fitters f WHERE f.business_id=$1 AND f.id=$2`, [business.id, id(fitterId, 'Fitter')]);
  if (!fitter) fail('Fitter not found', 404);
  const entries = await repo.all(repo.pool, `SELECT * FROM (
      SELECT b.created_at AS at,'earned' AS kind,d.document_no AS reference,d.id AS document_id,d.document_no,COALESCE(d.contact_name,'Walk-in') AS customer,
        d.subtotal AS bill_value,b.commission AS amount
        FROM hardware_fitter_bills b JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id WHERE b.business_id=$1 AND b.fitter_id=$2
      UNION ALL SELECT rt.created_at,'taken_back',COALESCE(rt.return_no,d.document_no),d.id,d.document_no,COALESCE(d.contact_name,'Walk-in'),NULL,-sum(r.amount)
        FROM hardware_fitter_reversals r JOIN hardware_fitter_bills b ON b.business_id=r.business_id AND b.document_id=r.document_id
        JOIN business_returns rt ON rt.business_id=r.business_id AND rt.id=r.return_id JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id
        WHERE r.business_id=$1 AND b.fitter_id=$2 GROUP BY r.return_id,rt.created_at,rt.return_no,d.id,d.document_no,d.contact_name HAVING sum(r.amount)>0
      UNION ALL SELECT p.created_at,'paid',COALESCE(e.reference,e.method_name,e.method),NULL,NULL,NULL,NULL,-p.amount
        FROM hardware_fitter_payouts p JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id WHERE p.business_id=$1 AND p.fitter_id=$2
      UNION ALL SELECT e.voided_at,'payout_reversed',e.void_reason,NULL,NULL,NULL,NULL,p.amount
        FROM hardware_fitter_payouts p JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id
        WHERE p.business_id=$1 AND p.fitter_id=$2 AND e.voided_at IS NOT NULL
    ) e ORDER BY at,kind<>'earned'`, [business.id, fitter.id]);
  let running = 0;
  const lines = entries.map((e) => {
    running += paise(e.amount);
    return { ...e, amount: rupees(paise(e.amount)), balance: rupees(running) };
  });
  const earned = paise(fitter.earned), takenBack = paise(fitter.taken_back), paid = paise(fitter.paid);
  return { fitter, statement: lines, totals: { earned: rupees(earned), takenBack: rupees(takenBack), paid: rupees(paid), due: rupees(earned - takenBack - paid) } };
}

// body: { requestKey, amount, method | methodId, reference?, notes?, locationId? } — never more than is due.
async function payout(business, user, fitterId, body) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.approve');
  await access.require(business, 'expenses.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, fitterId: String(fitterId) });
  const amount = core.decimal(body.amount, 'Amount', 2, 0.01, 10000000);
  const choice = paymentMethods.readChoice(body, 'Paid by', expenses.KINDS);
  const reference = v.optionalString(body.reference, 'Reference', 100) || null;
  const notes = v.optionalString(body.notes, 'Notes', 300) || null;
  return repo.transaction(async (db) => {
    // One payout at a time per business: what is due is read after the lock.
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM hardware_fitter_payouts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return repo.one(db, `${PAYOUT_SQL} AND p.id=$2`, [business.id, old.id]);
    }
    if (await repo.one(db, 'SELECT 1 FROM business_expenses WHERE business_id=$1 AND request_key=$2', [business.id, requestKey])) fail('This request key was already used for different data', 409);
    const fitter = await repo.one(db, `SELECT f.*,${earnedSql('f')} AS earned,${takenBackSql('f')} AS taken_back,${paidSql('f')} AS paid
      FROM hardware_fitters f WHERE f.business_id=$1 AND f.id=$2`, [business.id, id(fitterId, 'Fitter')]);
    if (!fitter) fail('Fitter not found', 404);
    const due = paise(fitter.earned) - paise(fitter.taken_back) - paise(fitter.paid);
    if (paise(amount) > due) fail(`${fitter.name} is due ${rupees(Math.max(0, due))}: a payout cannot be more than that`, 409);
    const chosen = body.locationId || business.location_scope || business.member_location_id;
    if (!chosen) fail('Choose the location that paid');
    const locationId = id(chosen, 'Location');
    access.requireLocation(business, locationId);
    if (!await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId])) fail('That location is not available', 404);
    const today = (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
    const expense = await expenses.insertExpense(db, business, user, { locationId, spentOn: today, category: 'other',
      description: `Fitter's commission: ${fitter.name} (${TRADE_WORDS[fitter.trade]})`.slice(0, 200), amount: amount.toFixed(2), choice, reference, requestKey });
    const row = await repo.one(db, `INSERT INTO hardware_fitter_payouts(business_id,fitter_id,expense_id,amount,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,amount`, [business.id, fitter.id, expense.id, amount.toFixed(2), notes, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'fitter.paid', row.id, { fitter: fitter.name, amount: row.amount, method: expense.method, expenseId: expense.id });
    await repo.event(db, business.id, user.id, 'fitter_commission.paid', 'fitter_payout', row.id, { fitterId: fitter.id, amount: row.amount, method: expense.method, expenseId: expense.id });
    return repo.one(db, `${PAYOUT_SQL} AND p.id=$2`, [business.id, row.id]);
  });
}

// For a period: each fitter's bills, the net value of those bills, commission
// earned, taken back and paid in the period, and what is due now.
async function report(business, query) {
  requireFitters(business);
  await access.require(business, 'fitter_commission.view');
  const today = (await repo.one(repo.pool, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
  const from = given(query.from) ? core.dateText(query.from, 'From date') : `${today.slice(0, 8)}01`;
  const to = given(query.to) ? core.dateText(query.to, 'To date') : today;
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  const day = (column) => `(${column} AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`;
  const rows = await repo.all(repo.pool, `SELECT f.id,f.name,f.trade,f.phone,f.upi_id,f.active,
    (SELECT count(*)::int FROM hardware_fitter_bills b WHERE b.business_id=f.business_id AND b.fitter_id=f.id AND ${day('b.created_at')}) AS bills,
    COALESCE((SELECT sum(d.subtotal) FROM hardware_fitter_bills b JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id
      WHERE b.business_id=f.business_id AND b.fitter_id=f.id AND ${day('b.created_at')}),0) AS sales,
    COALESCE((SELECT sum(b.commission) FROM hardware_fitter_bills b WHERE b.business_id=f.business_id AND b.fitter_id=f.id AND ${day('b.created_at')}),0) AS earned,
    COALESCE((SELECT sum(r.amount) FROM hardware_fitter_reversals r JOIN hardware_fitter_bills b ON b.business_id=r.business_id AND b.document_id=r.document_id
      WHERE b.business_id=f.business_id AND b.fitter_id=f.id AND ${day('r.created_at')}),0) AS taken_back,
    COALESCE((SELECT sum(p.amount) FROM hardware_fitter_payouts p WHERE p.business_id=f.business_id AND p.fitter_id=f.id AND ${day('p.created_at')}),0)
      -COALESCE((SELECT sum(p.amount) FROM hardware_fitter_payouts p JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id
        WHERE p.business_id=f.business_id AND p.fitter_id=f.id AND e.voided_at IS NOT NULL AND ${day('e.voided_at')}),0) AS paid,
    ${earnedSql('f')}-${takenBackSql('f')}-${paidSql('f')} AS due
    FROM hardware_fitters f WHERE f.business_id=$1 ORDER BY f.name`, [business.id, from, to, business.timezone]);
  const shown = rows.filter((r) => r.active || r.bills || paise(r.earned) || paise(r.taken_back) || paise(r.paid) || paise(r.due));
  const sum = (key) => rupees(shown.reduce((total, r) => total + paise(r[key]), 0));
  return { from, to, rows: shown, totals: { bills: shown.reduce((n, r) => n + r.bills, 0), sales: sum('sales'), earned: sum('earned'), takenBack: sum('taken_back'), paid: sum('paid'), due: sum('due') } };
}

module.exports = { TRADES, requireFitters, create, update, createRule, updateRule, recordBill, billExtras, statement, payout, report, setBillFitter, orderFitter, setOrderFitter,
  orderInvoice };
