const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./fuelCommon');
const money = require('./fuelMoney');

// Fleet credit (module "fuel", fuel stations): a fleet customer is a customer
// of the business (their credit days and credit limit kept with them), with
// vehicles by registration, each with the fuel it takes on credit and the most
// it takes in one fill. Its fills come from the shifts' credit slips, each
// billed on the customer's fuel bill of the shift; the month's statement lists
// them vehicle by vehicle, with the account's bills, payments and balance.
// An oil company's fleet or loyalty card is not the dealer's credit: it is a
// payment method of the business, taken with the shift's takings.

const { fail, id } = c;

const VEHICLES_SQL = `SELECT v.id,v.contact_id,ct.name AS customer_name,ct.phone AS customer_phone,v.registration,v.description,v.product_id,s.label AS product_name,v.fill_limit,
    v.active,v.created_at,v.updated_at,
    (SELECT max(x.closed_at) FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
      WHERE k.business_id=v.business_id AND k.vehicle_id=v.id) AS last_fill_at
  FROM fuel_vehicles v JOIN business_contacts ct ON ct.business_id=v.business_id AND ct.id=v.contact_id
  LEFT JOIN fuel_products f ON f.business_id=v.business_id AND f.id=v.product_id LEFT JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
  WHERE v.business_id=$1`;

repo.addLists({
  // Every fleet vehicle with its customer, in use first.
  'fuel-vehicles': { sql: VEHICLES_SQL, search: ['registration', 'customer_name', 'customer_phone', 'description'], filters: { contact: 'contact_id', active: 'active' },
    order: 'active DESC,customer_name,registration' },
});

function readVehicle(body, current = null) {
  const keep = (name) => body[name] === undefined && current;
  return {
    description: keep('description') ? current.description : c.optionalText(body.description, 'Description', 150),
    productId: keep('productId') ? current.product_id : c.given(body.productId) ? id(body.productId, 'Fuel it takes') : null,
    fillLimit: keep('fillLimit') ? current.fill_limit : c.given(body.fillLimit) ? c.readLitres(body.fillLimit, 'Most it takes in a fill (litres)', { min: 0, minExclusive: true, max: 100000 }) : null,
    active: v.requiredBoolean(body.active, 'In use', current ? current.active : true),
  };
}
async function checkProduct(db, business, productId) {
  if (!productId) return;
  if (!await repo.one(db, 'SELECT 1 FROM fuel_products WHERE business_id=$1 AND id=$2 AND active', [business.id, productId])) fail('Fuel not found', 404);
}

// body: { contactId, registration, description?, productId?, fillLimit? }
async function createVehicle(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.edit');
  const registration = c.readPlate(body.registration);
  const read = readVehicle(body);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const customer = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(body.contactId, 'Customer')]);
    if (!customer) fail('Customer not found', 404);
    if (!customer.active) fail(`${customer.name} is switched off`, 409);
    await checkProduct(db, business, read.productId);
    const clash = await repo.one(db, `SELECT ct.name FROM fuel_vehicles v JOIN business_contacts ct ON ct.business_id=v.business_id AND ct.id=v.contact_id
      WHERE v.business_id=$1 AND v.registration=$2 AND v.active`, [business.id, registration]);
    if (clash) fail(`${registration} is ${clash.name}'s vehicle: switch it off there first`, 409);
    const row = await repo.one(db, `INSERT INTO fuel_vehicles(business_id,contact_id,registration,description,product_id,fill_limit,active,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,TRUE,$7,$7) RETURNING *`, [business.id, customer.id, registration, read.description, read.productId, read.fillLimit, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_vehicle.created', row.id, { registration, customer: customer.name, fillLimit: row.fill_limit });
    return repo.one(db, `${VEHICLES_SQL} AND v.id=$2`, [business.id, row.id]);
  });
}

// body: { description?, productId?, fillLimit?, active? } — what is left out stays; a vehicle keeps its customer and registration.
async function updateVehicle(business, user, vehicleId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.edit');
  if (body.registration !== undefined || body.contactId !== undefined) fail('A vehicle keeps its customer and its registration: switch it off and add it again');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const current = await repo.one(db, 'SELECT * FROM fuel_vehicles WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(vehicleId, 'Vehicle')]);
    if (!current) fail('Vehicle not found', 404);
    const read = readVehicle(body, current);
    await checkProduct(db, business, read.productId);
    if (read.active && !current.active) {
      const clash = await repo.one(db, 'SELECT 1 FROM fuel_vehicles WHERE business_id=$1 AND registration=$2 AND active AND id<>$3', [business.id, current.registration, current.id]);
      if (clash) fail(`${current.registration} is in use with another customer`, 409);
    }
    await db.query('UPDATE fuel_vehicles SET description=$3,product_id=$4,fill_limit=$5,active=$6,updated_by=$7,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, current.id, read.description, read.productId, read.fillLimit, read.active, user.id]);
    const was = { description: current.description, productId: current.product_id, fillLimit: current.fill_limit, active: current.active };
    const now = { description: read.description, productId: read.productId, fillLimit: read.fillLimit, active: read.active };
    const changed = Object.keys(now).filter((k) => String(was[k] ?? '') !== String(now[k] ?? ''));
    if (changed.length) await repo.audit(db, business.id, user.id, 'fuel_vehicle.updated', current.id, { registration: current.registration,
      from: Object.fromEntries(changed.map((k) => [k, was[k]])), to: Object.fromEntries(changed.map((k) => [k, now[k]])) });
    return repo.one(db, `${VEHICLES_SQL} AND v.id=$2`, [business.id, current.id]);
  });
}

// The vehicles in use, by customer: what the close's credit slips choose from.
async function vehicles(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const all = query.all === true || query.all === 'true';
  return repo.all(repo.pool, `SELECT * FROM (${VEHICLES_SQL}) x WHERE ($2 OR x.active) ORDER BY x.customer_name,x.registration LIMIT 2000`, [business.id, all]);
}

// The fills of a month (business dates), from the shifts' credit slips in force.
const FILLS_SQL = `SELECT k.id,k.contact_id,k.vehicle_id,k.registration,k.product_id,sk.label AS product_name,sk.unit,k.litres,k.price,k.amount,k.slip_no,k.over_limit,
    x.closed_at,(x.closed_at AT TIME ZONE b.timezone)::date::text AS day,s.shift_no,s.attendant_name,d.document_no,k.document_id
  FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
  JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id JOIN businesses b ON b.id=k.business_id
  JOIN fuel_products f ON f.business_id=k.business_id AND f.id=k.product_id JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id
  JOIN business_documents d ON d.business_id=k.business_id AND d.id=k.document_id
  WHERE k.business_id=$1 AND (x.closed_at AT TIME ZONE b.timezone)::date BETWEEN $2 AND $3`;

// query: { month? (this month) } — every fleet customer (one with vehicles or
// fills): their vehicles, the month's fills and what they owe against their limit.
async function fleet(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  await access.require(business, 'sales.view');
  const today = await c.today(repo.pool, business);
  const { month, from, to } = c.readMonth(query.month || today.slice(0, 7));
  const rows = await repo.all(repo.pool, `WITH fills AS (${FILLS_SQL})
    SELECT ct.id,ct.name,ct.phone,ct.credit_limit,ct.credit_days,ct.active,${repo.contactBalanceSql('ct')} AS balance,
      (SELECT count(*)::int FROM fuel_vehicles v WHERE v.business_id=ct.business_id AND v.contact_id=ct.id AND v.active) AS vehicles,
      (SELECT count(*)::int FROM fills WHERE fills.contact_id=ct.id) AS fills,
      (SELECT COALESCE(sum(amount),0)::numeric(14,2) FROM fills WHERE fills.contact_id=ct.id) AS amount,
      (SELECT COALESCE(json_agg(json_build_object('product',t.product_name,'unit',t.unit,'litres',t.litres) ORDER BY t.product_name),'[]') FROM
        (SELECT product_name,unit,sum(litres) AS litres FROM fills WHERE fills.contact_id=ct.id GROUP BY product_name,unit) t) AS litres
    FROM business_contacts ct WHERE ct.business_id=$1 AND ct.kind='customer'
      AND (EXISTS (SELECT 1 FROM fuel_vehicles v WHERE v.business_id=ct.business_id AND v.contact_id=ct.id) OR EXISTS (SELECT 1 FROM fills WHERE fills.contact_id=ct.id))
    ORDER BY ct.name`, [business.id, from, to]);
  return { month, from, to, items: rows.map((r) => ({ ...r, over_limit: r.credit_limit !== null && money.paise(r.balance) > money.paise(r.credit_limit) })) };
}

// query: { month? (this month) } — a fleet customer's statement: the fills of
// the month vehicle by vehicle with their totals, and the account's ledger
// (bills, payments and the balance) where the person sees receivables.
async function statement(business, contactId, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  await access.require(business, 'sales.view');
  const db = repo.pool;
  const today = await c.today(db, business);
  const { month, from, to } = c.readMonth(query.month || today.slice(0, 7));
  const customer = await repo.one(db, `SELECT ct.id,ct.name,ct.phone,ct.address,ct.gstin,ct.pan,ct.credit_limit,ct.credit_days,${repo.contactBalanceSql('ct')} AS balance
    FROM business_contacts ct WHERE ct.business_id=$1 AND ct.id=$2 AND ct.kind='customer'`, [business.id, id(contactId, 'Customer')]);
  if (!customer) fail('Customer not found', 404);
  const fills = await repo.all(db, `SELECT * FROM (${FILLS_SQL}) f WHERE f.contact_id=$4 ORDER BY f.registration,f.closed_at,f.id`, [business.id, from, to, customer.id]);
  const plates = [...new Set(fills.map((f) => f.registration))];
  const totalsOf = (list) => {
    const byFuel = new Map();
    for (const f of list) {
      const t = byFuel.get(f.product_name) || { product: f.product_name, unit: f.unit, litres: 0, amount: 0 };
      t.litres += money.milli(f.litres); t.amount += money.paise(f.amount);
      byFuel.set(f.product_name, t);
    }
    return [...byFuel.values()].map((t) => ({ ...t, litres: money.litres(t.litres), amount: money.rupees(t.amount) }));
  };
  const vehiclesShaped = plates.map((registration) => {
    const mine = fills.filter((f) => f.registration === registration);
    return { registration, fills: mine, totals: totalsOf(mine), amount: money.rupees(mine.reduce((s, f) => s + money.paise(f.amount), 0)) };
  });
  const receivables = business.modules.includes('receivables') && access.can(business, 'receivables.view')
    ? await require('../../wholesale/services/businessReceivables.service').statement(business, customer.id, { from, to }) : null;
  const seller = await repo.one(db, 'SELECT display_name,legal_name,gstin,address_line1,address_line2,city,postal_code,phone,state_code FROM business_settings WHERE business_id=$1', [business.id]);
  return { month, from, to, today, customer, vehicles: vehiclesShaped, totals: totalsOf(fills), amount: money.rupees(fills.reduce((s, f) => s + money.paise(f.amount), 0)),
    fills: fills.length, ledger: receivables ? { opening: receivables.opening, debit: receivables.debit, credit: receivables.credit, closing: receivables.closing, entries: receivables.entries } : null,
    seller };
}

module.exports = { VEHICLES_SQL, FILLS_SQL, createVehicle, updateVehicle, vehicles, fleet, statement };
