const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
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

// The fills of a month (business dates), from the shifts' credit slips in
// force: each on its shift's fuel bill, or held for the month's invoice (its
// invoice once billed, none while it waits).
const FILLS_SQL = `SELECT k.id,k.contact_id,k.vehicle_id,k.registration,k.product_id,sk.label AS product_name,sk.unit,k.litres,k.price,k.amount,k.slip_no,k.over_limit,k.held,k.serial,
    x.closed_at,(x.closed_at AT TIME ZONE b.timezone)::date::text AS day,s.shift_no,s.attendant_name,s.location_id,d.document_no,d.id AS document_id,(d.id IS NOT NULL) AS billed
  FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
  JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id JOIN businesses b ON b.id=k.business_id
  JOIN fuel_products f ON f.business_id=k.business_id AND f.id=k.product_id JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id
  LEFT JOIN fuel_month_invoice_fills mf ON mf.business_id=k.business_id AND mf.slip_id=k.id LEFT JOIN fuel_month_invoices mi ON mi.business_id=mf.business_id AND mi.id=mf.invoice_id
  LEFT JOIN business_documents d ON d.business_id=k.business_id AND d.id=COALESCE(k.document_id,mi.document_id)
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
    SELECT ct.id,ct.name,ct.phone,ct.credit_limit,ct.credit_days,ct.active,${repo.contactBalanceSql('ct')} AS balance,${HELD_SQL('ct')} AS held,
      COALESCE(t.billing,'shift') AS billing,t.interest_rate,t.interest_after_days,
      (SELECT count(*)::int FROM fills WHERE fills.contact_id=ct.id AND NOT fills.billed) AS unbilled_fills,
      (SELECT count(*)::int FROM fuel_indent_books ib WHERE ib.business_id=ct.business_id AND ib.contact_id=ct.id AND ib.active) AS books,
      (SELECT count(*)::int FROM fuel_vehicles v WHERE v.business_id=ct.business_id AND v.contact_id=ct.id AND v.active) AS vehicles,
      (SELECT count(*)::int FROM fills WHERE fills.contact_id=ct.id) AS fills,
      (SELECT COALESCE(sum(amount),0)::numeric(14,2) FROM fills WHERE fills.contact_id=ct.id) AS amount,
      (SELECT COALESCE(json_agg(json_build_object('product',t.product_name,'unit',t.unit,'litres',t.litres) ORDER BY t.product_name),'[]') FROM
        (SELECT product_name,unit,sum(litres) AS litres FROM fills WHERE fills.contact_id=ct.id GROUP BY product_name,unit) t) AS litres
    FROM business_contacts ct LEFT JOIN fuel_fleet_terms t ON t.business_id=ct.business_id AND t.contact_id=ct.id WHERE ct.business_id=$1 AND ct.kind='customer'
      AND (EXISTS (SELECT 1 FROM fuel_vehicles v WHERE v.business_id=ct.business_id AND v.contact_id=ct.id) OR EXISTS (SELECT 1 FROM fills WHERE fills.contact_id=ct.id))
    ORDER BY ct.name`, [business.id, from, to]);
  return { month, from, to, items: rows.map((r) => ({ ...r, over_limit: r.credit_limit !== null && money.paise(r.balance) + money.paise(r.held) > money.paise(r.credit_limit) })) };
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
  const terms = await termsOf(db, business, customer.id);
  const unbilled = fills.filter((f) => !f.billed);
  const invoices = await repo.all(db, `SELECT i.id,i.location_id,l.name AS location_name,i.month::text AS month,d.id AS document_id,d.document_no,d.total,i.created_at,
      (SELECT count(*)::int FROM fuel_month_invoice_fills b WHERE b.business_id=i.business_id AND b.invoice_id=i.id) AS fills
    FROM fuel_month_invoices i JOIN business_documents d ON d.business_id=i.business_id AND d.id=i.document_id JOIN business_locations l ON l.business_id=i.business_id AND l.id=i.location_id
    WHERE i.business_id=$1 AND i.contact_id=$2 AND i.month=$3 ORDER BY i.id`, [business.id, customer.id, from]);
  return { month, from, to, today, customer, terms, vehicles: vehiclesShaped, totals: totalsOf(fills), amount: money.rupees(fills.reduce((s, f) => s + money.paise(f.amount), 0)),
    fills: fills.length, unbilled: { fills: unbilled.length, amount: money.rupees(unbilled.reduce((s, f) => s + money.paise(f.amount), 0)),
      outlets: [...new Set(unbilled.map((f) => String(f.location_id)))].map(Number) }, invoices,
    ledger: receivables ? { opening: receivables.opening, debit: receivables.debit, credit: receivables.credit, closing: receivables.closing, entries: receivables.entries } : null,
    seller };
}

// --- Terms: billing per shift or by the month, and interest ---------------------------------------

// What a fleet customer owes on fills held for the month's invoice and not yet billed.
const HELD_SQL = (ct) => `(SELECT COALESCE(sum(k.amount),0) FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
  WHERE k.business_id=${ct}.business_id AND k.contact_id=${ct}.id AND k.held AND NOT EXISTS (SELECT 1 FROM fuel_month_invoice_fills b WHERE b.business_id=k.business_id AND b.slip_id=k.id))`;

async function termsOf(db, business, contactId) {
  const row = await repo.one(db, 'SELECT billing,interest_rate,interest_after_days,updated_at FROM fuel_fleet_terms WHERE business_id=$1 AND contact_id=$2', [business.id, contactId]);
  return { billing: row?.billing || 'shift', interestRate: row?.interest_rate ?? null, interestAfterDays: row ? Number(row.interest_after_days) : 0, updatedAt: row?.updated_at || null };
}
async function customerOf(db, business, contactId) {
  const customer = await repo.one(db, `SELECT ct.id,ct.name,ct.active,ct.credit_days,ct.credit_limit FROM business_contacts ct WHERE ct.business_id=$1 AND ct.id=$2 AND ct.kind='customer'`,
    [business.id, id(contactId, 'Customer')]);
  if (!customer) fail('Customer not found', 404);
  return customer;
}

// body: { billing: shift | month, interestRate? (% a month; empty: none), interestAfterDays? } — a fleet customer's terms with the station.
// Fills already held for a month stay held for its invoice when billing goes back to each shift.
async function saveTerms(business, user, contactId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.edit');
  await access.require(business, 'sales.view');
  const billing = v.requiredEnum(body.billing ?? 'shift', 'Billed', ['shift', 'month']);
  const interestRate = c.given(body.interestRate) ? c.readDecimal(body.interestRate, 'Interest (% a month)', 2, { min: 0, max: 10, minExclusive: true }) : null;
  const interestAfterDays = c.given(body.interestAfterDays) ? c.whole(body.interestAfterDays, 'Interest from this many days after a bill falls due', 0, 365) : 0;
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const customer = await customerOf(db, business, contactId);
    const before = await termsOf(db, business, customer.id);
    await db.query(`INSERT INTO fuel_fleet_terms(business_id,contact_id,billing,interest_rate,interest_after_days,updated_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (business_id,contact_id) DO UPDATE SET billing=EXCLUDED.billing,interest_rate=EXCLUDED.interest_rate,interest_after_days=EXCLUDED.interest_after_days,
        updated_by=EXCLUDED.updated_by,updated_at=now()`, [business.id, customer.id, billing, interestRate, interestAfterDays, user.id]);
    const after = await termsOf(db, business, customer.id);
    const changed = ['billing', 'interestRate', 'interestAfterDays'].filter((k) => String(before[k] ?? '') !== String(after[k] ?? ''));
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'fuel_fleet.terms_changed', customer.id, { customer: customer.name, from: Object.fromEntries(changed.map((k) => [k, before[k]])),
        to: Object.fromEntries(changed.map((k) => [k, after[k]])) });
    }
    return { customer: { id: customer.id, name: customer.name }, terms: after };
  });
}

// --- Slip (indent) books ---------------------------------------------------------------------

const BOOKS_SQL = `SELECT ib.id,ib.contact_id,ct.name AS customer_name,ib.book_no,ib.first_serial,ib.last_serial,ib.issued_on::text AS issued_on,ib.active,ib.note,ib.created_at,
    (ib.last_serial-ib.first_serial+1) AS slips,
    (SELECT count(*)::int FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
      WHERE k.business_id=ib.business_id AND k.book_id=ib.id) AS used
  FROM fuel_indent_books ib JOIN business_contacts ct ON ct.business_id=ib.business_id AND ct.id=ib.contact_id WHERE ib.business_id=$1`;

// query: { contactId? } — the slip books issued, each with its slips used and left.
async function books(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const contactId = c.given(query.contactId) ? id(query.contactId, 'Customer') : null;
  const rows = await repo.all(repo.pool, `SELECT * FROM (${BOOKS_SQL}) x WHERE ($2::bigint IS NULL OR x.contact_id=$2) ORDER BY x.customer_name,x.first_serial`, [business.id, contactId]);
  return rows.map((b) => ({ ...b, unused: b.slips - b.used }));
}

// A book with each of its slips: used once (on which shift, for which vehicle), or still unused (as ranges).
async function book(business, bookId) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const row = await repo.one(repo.pool, `${BOOKS_SQL} AND ib.id=$2`, [business.id, id(bookId, 'Slip book')]);
  if (!row) fail('Slip book not found', 404);
  const used = await repo.all(repo.pool, `SELECT k.serial,k.registration,k.litres,sk.label AS product_name,sk.unit,s.shift_no,s.id AS shift_id,x.closed_at,k.held
    FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id
    JOIN fuel_products f ON f.business_id=k.business_id AND f.id=k.product_id JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id
    WHERE k.business_id=$1 AND k.book_id=$2 ORDER BY k.serial`, [business.id, row.id]);
  const taken = new Set(used.map((u) => Number(u.serial)));
  const unused = [];
  for (let n = row.first_serial; n <= row.last_serial; n += 1) {
    if (taken.has(n)) continue;
    const last = unused.at(-1);
    if (last && last.to === n - 1) last.to = n; else unused.push({ from: n, to: n });
  }
  return { ...row, unused: row.slips - row.used, usedSlips: used, unusedRanges: unused };
}

// body: { contactId, bookNo, firstSerial, lastSerial, issuedOn? (today), note? } — slips issued to a fleet customer.
async function issueBook(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.edit');
  const bookNo = v.requiredString(typeof body.bookNo === 'string' ? body.bookNo : String(body.bookNo ?? ''), 'Book number', 30);
  const firstSerial = c.whole(body.firstSerial, 'First slip', 1, 999999999);
  const lastSerial = c.whole(body.lastSerial, 'Last slip', 1, 999999999);
  if (lastSerial < firstSerial) fail('The last slip is not before the first');
  if (lastSerial - firstSerial >= 10000) fail('A book holds at most 10,000 slips');
  const note = c.optionalText(body.note, 'Note', 300);
  const bookId = await repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const customer = await customerOf(db, business, body.contactId);
    if (!customer.active) fail(`${customer.name} is switched off`, 409);
    const issuedOn = c.given(body.issuedOn) ? c.readDate(body.issuedOn, 'Issued on') : await c.today(db, business);
    const clash = await repo.one(db, `SELECT book_no,first_serial,last_serial FROM fuel_indent_books WHERE business_id=$1 AND contact_id=$2
      AND (lower(book_no)=lower($3) OR int4range(first_serial,last_serial,'[]') && int4range($4,$5,'[]')) LIMIT 1`, [business.id, customer.id, bookNo, firstSerial, lastSerial]);
    if (clash) fail(`${customer.name} has book ${clash.book_no} already, slips ${clash.first_serial} to ${clash.last_serial}`, 409);
    const row = await repo.one(db, `INSERT INTO fuel_indent_books(business_id,contact_id,book_no,first_serial,last_serial,issued_on,note,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`, [business.id, customer.id, bookNo, firstSerial, lastSerial, issuedOn, note, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_indent_book.issued', row.id, { customer: customer.name, bookNo, firstSerial, lastSerial, issuedOn });
    return row.id;
  });
  return book(business, bookId);
}

// body: { active?, note? } — a book withdrawn (taken back or lost: its slips no longer taken) or back in use.
async function updateBook(business, user, bookId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.edit');
  const target = await repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const current = await repo.one(db, 'SELECT * FROM fuel_indent_books WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(bookId, 'Slip book')]);
    if (!current) fail('Slip book not found', 404);
    const active = v.requiredBoolean(body.active, 'In use', current.active);
    const note = body.note === undefined ? current.note : c.optionalText(body.note, 'Note', 300);
    await db.query('UPDATE fuel_indent_books SET active=$3,note=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, current.id, active, note, user.id]);
    if (active !== current.active) await repo.audit(db, business.id, user.id, active ? 'fuel_indent_book.restored' : 'fuel_indent_book.withdrawn', current.id, { bookNo: current.book_no, note });
    return current.id;
  });
  return book(business, target);
}

// --- The month's invoice -----------------------------------------------------------------------

// body: { requestKey, month (YYYY-MM), locationId } — one invoice billing the
// customer's fills held for that month at the outlet and not yet billed, a
// line for each fill: the stock leaves with it, once.
async function invoiceMonth(business, user, contactId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.edit');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, contactId: String(contactId) });
  const { month, from, to } = c.readMonth(body.month);
  const invoiceId = await repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM fuel_month_invoices WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old.id;
    }
    const customer = await customerOf(db, business, contactId);
    const location = await c.locationOf(db, business, body.locationId);
    const today = await c.today(db, business);
    if (from > today) fail(`${c.dateWords(from)} is to come: a month's fills are billed once they are in`);
    const fills = await repo.all(db, `SELECT k.*,f.sku_id,sk.label AS product_name,(x.closed_at AT TIME ZONE b.timezone)::date::text AS day,s.shift_no FROM fuel_credit_slips k
      JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id
      JOIN businesses b ON b.id=k.business_id JOIN fuel_products f ON f.business_id=k.business_id AND f.id=k.product_id JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id
      WHERE k.business_id=$1 AND k.contact_id=$2 AND k.held AND s.location_id=$3 AND (x.closed_at AT TIME ZONE b.timezone)::date BETWEEN $4 AND $5
        AND NOT EXISTS (SELECT 1 FROM fuel_month_invoice_fills mf WHERE mf.business_id=k.business_id AND mf.slip_id=k.id)
      ORDER BY x.closed_at,k.seq`, [business.id, customer.id, location.id, from, to]);
    const monthWords = new Date(`${from}T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    if (!fills.length) fail(`No fills of ${customer.name} held for ${monthWords} at ${location.name} are left to bill`, 409);
    const lines = fills.map((k) => ({
      input: { skuId: k.sku_id, quantity: k.litres },
      fixed: { price: Number(k.price), net: money.paise(k.amount), tax: 0, priceRuleId: null, enteredPrice: null,
        label: `${k.product_name} · ${k.registration} · ${c.dateWords(k.day)}${k.slip_no ? ` · slip ${k.slip_no}` : ''} · price includes state VAT`.slice(0, 150) },
    }));
    const documentBody = { kind: 'sale', locationId: location.id, contactId: customer.id, lines: lines.map((l) => l.input), notes: `Fuel on credit for ${month}: ${fills.length} fills` };
    const doc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'invoice'), hash: c.hashOf(documentBody),
      lines: documentBody.lines, paidNow: [], fixed: lines.map((l) => l.fixed), fuel: true });
    const total = fills.reduce((sum, k) => sum + money.paise(k.amount), 0);
    if (money.paise(doc.total) !== total) fail(`The month's invoice would come to ${doc.total}, not ${money.rupees(total)}. Try again.`, 409);
    const docLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]);
    const invoice = await repo.one(db, `INSERT INTO fuel_month_invoices(business_id,contact_id,location_id,month,document_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [business.id, customer.id, location.id, from, doc.id, requestKey, hash, user.id]);
    for (const [index, k] of fills.entries()) {
      await db.query('INSERT INTO fuel_month_invoice_fills(business_id,invoice_id,slip_id,line_id) VALUES($1,$2,$3,$4)', [business.id, invoice.id, k.id, docLines[index].id]);
    }
    await repo.audit(db, business.id, user.id, 'fuel_month_invoice.billed', invoice.id, { customer: customer.name, month, location: location.name, documentNo: doc.document_no,
      fills: fills.length, total: doc.total });
    await repo.event(db, business.id, user.id, 'fuel_month_invoice.billed', 'fuel_month_invoice', invoice.id, { contactId: customer.id, locationId: location.id, month,
      documentId: doc.id, total: doc.total, slipIds: fills.map((k) => Number(k.id)) });
    return invoice.id;
  });
  return repo.one(repo.pool, `SELECT i.id,i.contact_id,i.location_id,i.month::text AS month,d.id AS document_id,d.document_no,d.total,d.due_on::text AS due_on,
      (SELECT count(*)::int FROM fuel_month_invoice_fills b WHERE b.business_id=i.business_id AND b.invoice_id=i.id) AS fills
    FROM fuel_month_invoices i JOIN business_documents d ON d.business_id=i.business_id AND d.id=i.document_id WHERE i.business_id=$1 AND i.id=$2`, [business.id, invoiceId]);
}

// --- Interest on overdue credit ----------------------------------------------------------------

// The customer's fuel bills (each shift's and each month's invoice), with what
// changed each one's balance and when, on the business's clock; not the
// interest bills (interest never earns interest).
async function fuelBillsOf(db, business, contactId) {
  const bills = await repo.all(db, `SELECT d.id,d.document_no,(d.created_at AT TIME ZONE b.timezone)::date::text AS day,d.due_on::text AS due_on,d.total
    FROM business_documents d JOIN businesses b ON b.id=d.business_id
    WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale' AND d.id IN (SELECT document_id FROM fuel_credit_slips WHERE business_id=$1 AND contact_id=$2 AND document_id IS NOT NULL
      UNION SELECT document_id FROM fuel_month_invoices WHERE business_id=$1 AND contact_id=$2) ORDER BY d.created_at,d.id`, [business.id, contactId]);
  const ids = bills.map((x) => x.id);
  const changes = ids.length ? await repo.all(db, `SELECT x.document_id,x.day,x.amount FROM (
      SELECT r.document_id,(r.created_at AT TIME ZONE $3)::date::text AS day,-r.total AS amount FROM business_returns r WHERE r.business_id=$1 AND r.document_id=ANY($2::bigint[])
      UNION ALL SELECT p.document_id,(p.created_at AT TIME ZONE $3)::date::text,-p.amount FROM business_payments p WHERE p.business_id=$1 AND p.document_id=ANY($2::bigint[])
      UNION ALL SELECT f.document_id,(f.created_at AT TIME ZONE $3)::date::text,f.amount FROM business_refunds f WHERE f.business_id=$1 AND f.document_id=ANY($2::bigint[])) x
    ORDER BY x.day`, [business.id, ids, business.timezone]) : [];
  return bills.map((bill) => ({ ...bill, changes: changes.filter((x) => String(x.document_id) === String(bill.id)).map((x) => ({ day: x.day, amount: money.paise(x.amount) })) }));
}

// The interest worked out to a day by the customer's terms (simple interest,
// rate % a month, a thirtieth of it a day, on what is still owed on each bill
// from so many days after it falls due), what was billed of it and what is due now.
async function interestOn(db, business, customer, upTo) {
  const terms = await termsOf(db, business, customer.id);
  const billed = money.paise((await repo.one(db, 'SELECT COALESCE(sum(amount),0) AS a FROM fuel_fleet_interest WHERE business_id=$1 AND contact_id=$2', [business.id, customer.id])).a);
  if (!terms.interestRate) return { terms, upTo, bills: [], total: 0, billed, due: 0 };
  const rate = Number(terms.interestRate).toFixed(2);
  const each = (await fuelBillsOf(db, business, customer.id)).map((bill) => interestMaths().billInterest({ documentId: Number(bill.id), documentNo: bill.document_no, day: bill.day,
    total: money.paise(bill.total), changes: bill.changes }, { interest: 'after_due', rate, dueOn: c.addDays(bill.due_on, terms.interestAfterDays) }, upTo));
  const total = each.reduce((sum, b) => sum + b.interest, 0);
  return { terms, upTo, bills: each, total, billed, due: Math.max(0, total - billed) };
}
// The interest maths of season credit (agriInterest.js): the same simple interest, day by day, to the paisa.
const interestMaths = () => require('../../agri/services/agriInterest');
const interestShape = (i) => ({ terms: i.terms, upTo: i.upTo, worked: money.rupees(i.total), billed: money.rupees(i.billed), due: money.rupees(i.due),
  bills: i.bills.filter((b) => b.days > 0).map((b) => ({ ...b, interest: money.rupees(b.interest), periods: b.periods.map((p) => ({ ...p, owed: money.rupees(p.owed) })) })) });

// The interest on a fleet customer's overdue fuel bills, worked out to today, and the interest bills made.
async function interest(business, contactId) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  await access.require(business, 'sales.view');
  const db = repo.pool;
  const customer = await customerOf(db, business, contactId);
  const worked = await interestOn(db, business, customer, await c.today(db, business));
  const charges = await repo.all(db, `SELECT i.id,i.document_id,d.document_no,i.worked_to::text AS worked_to,i.amount,i.rate,i.created_at,u.name AS created_by_name FROM fuel_fleet_interest i
    JOIN business_documents d ON d.business_id=i.business_id AND d.id=i.document_id JOIN users u ON u.id=i.created_by WHERE i.business_id=$1 AND i.contact_id=$2 ORDER BY i.id`,
  [business.id, customer.id]);
  return { customer: { id: customer.id, name: customer.name }, ...interestShape(worked), charges };
}

// body: { requestKey, locationId, amount } — the interest due now, as the
// person saw it, billed on the interest item to the customer, due at once.
// Refused when it has moved since (a payment came in).
async function chargeInterest(business, user, contactId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.approve');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, contactId: String(contactId) });
  const seen = money.paise(c.readMoney(body.amount, 'Interest', { min: 0, minExclusive: true }));
  await repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const done = await repo.one(db, 'SELECT document_id,request_hash FROM fuel_fleet_interest WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return;
    }
    const customer = await customerOf(db, business, contactId);
    const location = await c.locationOf(db, business, body.locationId);
    const settings = await c.settingsOf(db, business.id);
    if (!settings.interest_sku_id) fail('Choose the service item interest is billed as under Settings › Pumps & nozzles first', 409);
    const today = await c.today(db, business);
    const worked = await interestOn(db, business, customer, today);
    if (!worked.terms.interestRate) fail(`${customer.name}'s terms carry no interest`, 409);
    if (worked.due <= 0) fail(`No interest is due from ${customer.name} today`, 409);
    if (worked.due !== seen) fail(`The interest due is now ₹${money.rupees(worked.due)}, not ₹${money.rupees(seen)}: look at it again before billing it`, 409);
    const sku = await repo.one(db, 'SELECT s.id,s.label,s.tax_rate,s.active FROM catalog_skus s WHERE s.business_id=$1 AND s.id=$2', [business.id, settings.interest_sku_id]);
    if (!sku?.active) fail('The item interest is billed as is switched off: choose another under Settings › Pumps & nozzles', 409);
    // The interest is the line's price in the business's own price terms (with GST inside, or before it), billed
    // exact to the paisa as the fuel tools bill (no round-off), on the customer's account whatever their limit.
    const taxMode = (await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]))?.tax_mode || 'exclusive';
    const net = taxMode === 'inclusive' ? core.inclusiveNet(worked.due, Number(sku.tax_rate)) : worked.due;
    const tax = taxMode === 'inclusive' ? worked.due - net : core.lineTax(worked.due, Number(sku.tax_rate));
    const rate = Number(worked.terms.interestRate).toFixed(2).replace(/\.00$/, '');
    const label = `Interest on overdue fuel credit to ${c.dateWords(today)} (${rate}% a month)`.slice(0, 150);
    const documentBody = { kind: 'sale', locationId: location.id, contactId: customer.id, lines: [{ skuId: sku.id, quantity: '1' }],
      notes: `Interest on overdue fuel bills, worked out to ${c.dateWords(today)}` };
    const saved = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'interest'), hash: c.hashOf(documentBody),
      lines: documentBody.lines, paidNow: [], fixed: [{ price: worked.due / 100, net, tax, label }], dueDay: today, charge: true, fuel: true });
    const workings = interestShape(worked).bills;
    const row = await repo.one(db, `INSERT INTO fuel_fleet_interest(business_id,contact_id,document_id,worked_to,amount,rate,workings,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [business.id, customer.id, saved.id, today, money.rupees(worked.due), worked.terms.interestRate, JSON.stringify(workings),
      requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_fleet.interest_billed', customer.id, { customer: customer.name, documentNo: saved.document_no, workedTo: today,
      amount: money.rupees(worked.due), worked: money.rupees(worked.total), billedBefore: money.rupees(worked.billed), interestId: row.id });
    await repo.event(db, business.id, user.id, 'fuel_fleet.interest_billed', 'contact', customer.id, { documentId: saved.id, documentNo: saved.document_no, amount: money.rupees(worked.due),
      workedTo: today });
  });
  return interest(business, contactId);
}

module.exports = { VEHICLES_SQL, FILLS_SQL, HELD_SQL, createVehicle, updateVehicle, vehicles, fleet, statement, termsOf, saveTerms, books, book, issueBook, updateBook, invoiceMonth,
  interest, chargeInterest, interestOn };
