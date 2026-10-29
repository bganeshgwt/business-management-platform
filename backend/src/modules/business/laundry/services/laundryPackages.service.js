const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./laundryCommon');
const money = require('./laundryMoney');

// Prepaid packages (module "laundry"), sold as the salon sells its packages:
//   plans     so many kilos (a kilo package: bundles washed by the kilo) or
//             pieces (a piece package: garments by the piece) of the services
//             a plan covers, for so many days; each plan is sold as its own
//             service item (its price, GST slab and SAC are the item's), so GST
//             is charged on the bill that sells it, at its item's rate. What
//             is left when the customer buys the next one of the same unit is
//             carried into it as the plan's rule says (none, all, or up to a
//             quantity), when bought within its days of the end. Switched
//             off, never deleted.
//   selling   a bill of the plan's item through the core, paid now or later,
//             and the customer's package made with it: the plan as it is
//             then, from the business's day for its days. A plan's item is
//             sold only here (the database refuses it on any other bill).
//   using     garments taken in draw on a package in force (laundryPricing.js):
//             what it holds pays for them, and their bill lines charge the
//             rest; a cancelled garment gives back what it drew.
//   cancelling a package nothing was drawn from, carried in or on: then its
//             bill line can be credited from the bill, as any line.
// Money is integer paise; quantities to the gram or the piece.

const { fail, id } = c;
const UNITS = ['kg', 'piece'];
const RULES = ['none', 'all', 'up_to'];
const whole = (value, name, min, max) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return Number(text);
};
// A quantity in the plan's unit: kilos to the gram, pieces whole.
const quantityOf = (value, unit, name) => (unit === 'kg' ? core.decimal(value, `${name} (kilos)`, 3, 0.001, 99999.999) : whole(value, `${name} (pieces)`, 1, 99999));

const PACKAGES_SQL = `SELECT p.id,p.plan_id,p.contact_id,ct.name AS customer_name,ct.phone AS customer_phone,p.name,p.unit,p.quantity,p.carried_in,p.carry_forward,p.carry_max,
    p.carry_days,p.service_ids,p.starts_on::text AS starts_on,p.ends_on::text AS ends_on,p.price,p.status,p.cancel_reason,p.created_at,d.document_no,p.document_id,
    laundry_package_left(p.business_id,p.id) AS left_now,(t.today BETWEEN p.starts_on AND p.ends_on) AS in_force,(t.today>p.ends_on) AS ended,
    (SELECT n.carried_in FROM laundry_packages n WHERE n.business_id=p.business_id AND n.carried_from=p.id) AS carried_on,
    COALESCE((SELECT sum(i.package_quantity) FROM laundry_order_items i WHERE i.business_id=p.business_id AND i.package_id=p.id AND i.status<>'cancelled'),0) AS used,
    d.location_id
  FROM laundry_packages p JOIN businesses b ON b.id=p.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.timezone)::date AS today) t
  JOIN business_contacts ct ON ct.business_id=p.business_id AND ct.id=p.contact_id JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
  WHERE p.business_id=$1`;
repo.addLists({
  // Customers' packages: those in force first, ending soonest.
  'laundry-packages': { sql: PACKAGES_SQL, search: ['customer_name', 'customer_phone', 'name', 'document_no'], date: 'created_at',
    filters: { contact: 'contact_id', status: 'status', in_force: 'in_force', unit: 'unit', plan: 'plan_id' }, order: 'in_force DESC,ends_on,id DESC' },
});
const listShape = (business, page) => (c.seesMoney(business) ? page : { ...page, items: page.items.map((p) => ({ ...p, price: null })) });

// --- Plans -------------------------------------------------------------------------------------------

async function plans(business) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  return repo.all(repo.pool, `SELECT pl.*,s.label AS item_name,s.code AS item_code,s.price,s.tax_rate,s.hsn_code,(s.active AND pr.active) AS item_active,
      COALESCE((SELECT array_agg(ps.service_id ORDER BY ps.service_id) FROM laundry_plan_services ps WHERE ps.business_id=pl.business_id AND ps.plan_id=pl.id),'{}') AS service_ids,
      (SELECT count(*)::int FROM laundry_packages p WHERE p.business_id=pl.business_id AND p.plan_id=pl.id) AS sold
    FROM laundry_plans pl JOIN catalog_skus s ON s.business_id=pl.business_id AND s.id=pl.sku_id JOIN catalog_products pr ON pr.business_id=s.business_id AND pr.id=s.product_id
    WHERE pl.business_id=$1 ORDER BY pl.active DESC,lower(pl.name),pl.id`, [business.id]);
}

// The plan's rule as typed; what is not given stays as it was.
async function readRule(db, business, body, current = null) {
  const unit = current ? current.unit : v.requiredEnum(body.unit, 'Kilos or pieces', UNITS);
  const quantity = body.quantity === undefined && current ? Number(current.quantity) : quantityOf(body.quantity, unit, 'How much it holds');
  const validityDays = body.validityDays === undefined && current ? current.validity_days : whole(body.validityDays, 'Days it runs', 1, 3650);
  const carryForward = body.carryForward === undefined && current ? current.carry_forward : v.requiredEnum(body.carryForward ?? 'none', 'What is left', RULES);
  const carryMax = carryForward !== 'up_to' ? null : body.carryMax === undefined && current?.carry_max !== null && current ? Number(current.carry_max)
    : quantityOf(body.carryMax, unit, 'Carried into the next at most');
  const carryDays = body.carryDays === undefined && current ? current.carry_days : c.given(body.carryDays) ? whole(body.carryDays, 'Days after the end to buy the next', 0, 365) : 0;
  let serviceIds = null;
  if (body.serviceIds !== undefined || !current) {
    const list = v.requiredArray(body.serviceIds, 'Services it covers');
    serviceIds = [...new Set(list.map((x) => id(x, 'Service')))];
    if (!serviceIds.length) fail('Choose the services the package covers');
    const found = await repo.all(db, 'SELECT id FROM laundry_services WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, serviceIds]);
    if (found.length !== serviceIds.length) fail('Service not found', 404);
  }
  return { unit, quantity, validityDays, carryForward, carryMax, carryDays, serviceIds };
}

async function savePlanServices(db, business, planId, serviceIds) {
  await db.query('DELETE FROM laundry_plan_services WHERE business_id=$1 AND plan_id=$2', [business.id, planId]);
  for (const serviceId of serviceIds) await db.query('INSERT INTO laundry_plan_services(business_id,plan_id,service_id) VALUES($1,$2,$3)', [business.id, planId, serviceId]);
}

// A free item code for a plan's item: LPK-01, LPK-02 ….
async function freeCode(db, businessId) {
  const count = await repo.one(db, 'SELECT count(*)::int AS n FROM laundry_plans WHERE business_id=$1', [businessId]);
  for (let n = count.n + 1; ; n += 1) {
    const code = `LPK-${String(n).padStart(2, '0')}`;
    if (!await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [businessId, code])) return code;
  }
}

// body: { name, unit: kg | piece, quantity, validityDays, carryForward?, carryMax?, carryDays?, serviceIds, price, taxRateId?, hsnCode? }:
// the plan and its own service item (its price, GST slab, the business's default slab unless chosen, and SAC).
async function createPlan(business, user, body) {
  c.requireLaundry(business);
  await access.require(business, 'catalog.edit');
  const name = v.requiredString(typeof body.name === 'string' ? body.name : '', 'Package', 150);
  const price = core.decimal(body.price, 'Price', 2, 0.01, 10000000);
  const rule = await readRule(repo.pool, business, body);
  if (await repo.one(repo.pool, 'SELECT 1 FROM laundry_plans WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, name])) fail(`There is a package called ${name} already`, 409);
  const slab = c.given(body.taxRateId) ? id(body.taxRateId, 'GST slab')
    : (await repo.one(repo.pool, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND is_default AND active', [business.id]))?.id;
  if (!slab) fail('Choose the package\'s GST slab');
  const code = await freeCode(repo.pool, business.id);
  await core.createCatalog(business, user, { kind: 'service', unit: 'service', name, label: name, code, price: price.toFixed(2), taxRateId: slab, hsnCode: body.hsnCode },
    async (db, sku) => {
      const plan = await repo.one(db, `INSERT INTO laundry_plans(business_id,sku_id,name,unit,quantity,validity_days,carry_forward,carry_max,carry_days,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`, [business.id, sku.id, name, rule.unit, rule.quantity, rule.validityDays, rule.carryForward, rule.carryMax,
        rule.carryDays, user.id]);
      await savePlanServices(db, business, plan.id, rule.serviceIds);
      await repo.audit(db, business.id, user.id, 'laundry_plan.created', plan.id, { name, unit: rule.unit, quantity: String(rule.quantity), validityDays: rule.validityDays,
        carryForward: rule.carryForward, carryMax: rule.carryMax, carryDays: rule.carryDays, serviceIds: rule.serviceIds, price: price.toFixed(2) });
    });
  return plans(business);
}

// body: { name?, quantity?, validityDays?, carryForward?, carryMax?, carryDays?, serviceIds?, active? } — packages sold keep the plan as it was then.
async function updatePlan(business, user, planId, body) {
  c.requireLaundry(business);
  await access.require(business, 'catalog.edit');
  await repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM laundry_plans WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(planId, 'Package')]);
    if (!current) fail('Package not found', 404);
    const name = body.name === undefined ? current.name : v.requiredString(typeof body.name === 'string' ? body.name : '', 'Package', 150);
    if (name.toLowerCase() !== current.name.toLowerCase() && await repo.one(db, 'SELECT 1 FROM laundry_plans WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, name])) {
      fail(`There is a package called ${name} already`, 409);
    }
    const rule = await readRule(db, business, body, current);
    const active = v.requiredBoolean(body.active, 'Sold', current.active);
    await db.query(`UPDATE laundry_plans SET name=$3,quantity=$4,validity_days=$5,carry_forward=$6,carry_max=$7,carry_days=$8,active=$9,updated_by=$10,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, current.id, name, rule.quantity, rule.validityDays, rule.carryForward, rule.carryMax, rule.carryDays, active, user.id]);
    if (rule.serviceIds) await savePlanServices(db, business, current.id, rule.serviceIds);
    await repo.audit(db, business.id, user.id, 'laundry_plan.updated', current.id, { name, quantity: String(rule.quantity), validityDays: rule.validityDays,
      carryForward: rule.carryForward, carryMax: rule.carryMax, carryDays: rule.carryDays, active, ...(rule.serviceIds ? { serviceIds: rule.serviceIds } : {}) });
  });
  return plans(business);
}

// --- A customer's packages -------------------------------------------------------------------------------

// What is carried into a new package from the customer's latest one of the same unit, by that one's rule.
async function carryFrom(db, business, contactId, unit) {
  const before = await repo.one(db, `SELECT p.id,p.name,p.carry_forward,p.carry_max,laundry_package_left(p.business_id,p.id) AS left_now,
      (t.today<=p.ends_on+p.carry_days) AS within
    FROM laundry_packages p JOIN businesses b ON b.id=p.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.timezone)::date AS today) t
    WHERE p.business_id=$1 AND p.contact_id=$2 AND p.unit=$3 AND p.status='active'
      AND NOT EXISTS (SELECT 1 FROM laundry_packages n WHERE n.business_id=p.business_id AND n.carried_from=p.id)
    ORDER BY p.ends_on DESC,p.id DESC LIMIT 1 FOR UPDATE OF p`, [business.id, contactId, unit]);
  if (!before || !before.within || before.carry_forward === 'none' || Number(before.left_now) <= 0) return null;
  const left = Number(before.left_now);
  const carried = before.carry_forward === 'all' ? left : Math.min(left, Number(before.carry_max));
  return carried > 0 ? { from: before, quantity: Math.round(carried * 1000) / 1000 } : null;
}

// body: { requestKey, planId, contactId, locationId, payment? | payments?, buyer? }: the plan's item billed through the core, and the package made with it.
async function sell(business, user, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const planId = id(body.planId, 'Package');
  const contactId = id(body.contactId, 'Customer');
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM laundry_packages WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return one(db, business, old.id);
    }
    const plan = await repo.one(db, `SELECT pl.*,(s.active AND p.active) AS item_active FROM laundry_plans pl JOIN catalog_skus s ON s.business_id=pl.business_id AND s.id=pl.sku_id
      JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id WHERE pl.business_id=$1 AND pl.id=$2`, [business.id, planId]);
    if (!plan) fail('Package not found', 404);
    if (!plan.active) fail(`${plan.name} is not sold now`, 409);
    if (!plan.item_active) fail(`${plan.name}, the item it is sold as, is switched off in the catalogue`, 409);
    const contact = await repo.one(db, "SELECT id,name,active FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
    if (!contact) fail('Customer not found', 404);
    if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
    const services = (await repo.all(db, 'SELECT service_id FROM laundry_plan_services WHERE business_id=$1 AND plan_id=$2 ORDER BY service_id', [business.id, plan.id])).map((s) => s.service_id);
    const carry = await carryFrom(db, business, contact.id, plan.unit);
    const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
    const documentBody = { kind: 'sale', locationId, contactId: contact.id, lines: [{ skuId: plan.sku_id, quantity: '1' }], notes: `Laundry package ${plan.name}`,
      buyer: { pan: buyer.pan, panDeclaration: buyer.panDeclaration } };
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'bill'), hash: c.hashOf(documentBody),
      lines: documentBody.lines, paidNow: parts });
    const line = await repo.one(db, 'SELECT id,net,tax FROM business_document_lines WHERE business_id=$1 AND document_id=$2 AND sku_id=$3 ORDER BY id LIMIT 1',
      [business.id, document.id, plan.sku_id]);
    const days = await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS starts_on,((now() AT TIME ZONE $1)::date + $2::int - 1)::text AS ends_on',
      [business.timezone || 'Asia/Kolkata', plan.validity_days]);
    const saved = await repo.one(db, `INSERT INTO laundry_packages(business_id,plan_id,contact_id,name,unit,quantity,carry_forward,carry_max,carry_days,service_ids,starts_on,ends_on,
        document_id,line_id,price,carried_from,carried_in,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [business.id, plan.id, contact.id, plan.name, plan.unit, plan.quantity, plan.carry_forward, plan.carry_max, plan.carry_days, services, days.starts_on, days.ends_on,
      document.id, line.id, money.rupees(c.paise(line.net) + c.paise(line.tax)), carry?.from.id || null, carry ? carry.quantity.toFixed(3) : '0', requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'laundry_package.sold', saved.id, { name: plan.name, customer: contact.name, unit: plan.unit, quantity: plan.quantity,
      startsOn: days.starts_on, endsOn: days.ends_on, documentNo: document.document_no, ...(carry ? { carriedIn: carry.quantity.toFixed(3), carriedFrom: carry.from.id } : {}) });
    await repo.event(db, business.id, user.id, 'laundry_package.sold', 'laundry_package', saved.id, { planId: plan.id, contactId: contact.id, documentId: document.id,
      unit: plan.unit, quantity: plan.quantity, carriedIn: carry ? carry.quantity.toFixed(3) : '0' });
    return one(db, business, saved.id);
  });
}

async function one(db, business, packageId) {
  const row = await repo.one(db, `SELECT * FROM (${PACKAGES_SQL}) x WHERE x.id=$2`, [business.id, packageId]);
  if (!row) fail('Package not found', 404);
  access.requireLocation(business, row.location_id);
  const draws = await repo.all(db, `SELECT i.id,i.order_id,o.order_no,i.tag_no,i.garment_name,i.service_name,i.package_quantity,i.status,o.created_at
    FROM laundry_order_items i JOIN laundry_orders o ON o.business_id=i.business_id AND o.id=i.order_id WHERE i.business_id=$1 AND i.package_id=$2 ORDER BY i.id`, [business.id, row.id]);
  return c.seesMoney(business) ? { ...row, draws } : { ...row, price: null, draws };
}

async function detail(business, packageId) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  return one(repo.pool, business, id(packageId, 'Package'));
}

// A customer's packages in force with something left (the intake screen).
async function forCustomer(business, contactId) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  return repo.all(repo.pool, `SELECT * FROM (${PACKAGES_SQL}) x WHERE x.contact_id=$2 AND x.status='active' AND x.in_force AND x.left_now>0 ORDER BY x.ends_on,x.id`,
    [business.id, id(contactId, 'Customer')]);
}

// body: { reason } — a package nothing was drawn from, carried in or on.
async function cancel(business, user, packageId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.cancel');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const row = await repo.one(db, 'SELECT * FROM laundry_packages WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(packageId, 'Package')]);
    if (!row) fail('Package not found', 404);
    if (row.status === 'cancelled') fail(`Package ${row.name} was cancelled already`, 409);
    const used = await repo.one(db, `SELECT EXISTS (SELECT 1 FROM laundry_order_items WHERE business_id=$1 AND package_id=$2 AND status<>'cancelled') AS drawn,
      EXISTS (SELECT 1 FROM laundry_packages WHERE business_id=$1 AND carried_from=$2) AS carried`, [business.id, row.id]);
    if (used.drawn || used.carried || Number(row.carried_in) > 0) fail(`Package ${row.name} was used: it is no longer cancelled`, 409);
    await db.query("UPDATE laundry_packages SET status='cancelled',cancel_reason=$3,cancelled_by=$4,cancelled_at=now() WHERE business_id=$1 AND id=$2", [business.id, row.id, reason, user.id]);
    await repo.audit(db, business.id, user.id, 'laundry_package.cancelled', row.id, { name: row.name, reason });
    return one(db, business, row.id);
  });
}

module.exports = { plans, createPlan, updatePlan, sell, detail, forCustomer, cancel, listShape };
