const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./garageCommon');
// The manager's say-so with their PIN (shared with the salon and repairs).
const pins = () => require('../../salon-weight/services/businessManagerPin');

// Vehicles (module "garage", garages): each customer's vehicles.
//
//   a vehicle   its registration number as printed (upper case, letters and
//               digits only; one vehicle per number), make, model, variant,
//               fuel, year, engine code, chassis and engine numbers, insurance and PUC
//               expiry, the next service due, notes. Switched off when sold
//               or scrapped, never deleted.
//   owners      the owner now (a customer); a change of owner is kept by the
//               database, and the customer's statement lists their jobs on
//               every vehicle they have had serviced here (a fleet).
//   odometer    every reading in the vehicle's log. A reading lower than the
//               last (a meter changed or reset) needs a manager's approval
//               (garage.approve; their PIN, or their own say-so) with a note
//               why; the average a day since the last meter change gives the
//               reading the vehicle has probably reached.

const { fail, id } = c;
// A vehicle can be made this many years ahead of today (next year's model).
const YEAR_AHEAD = 1;

repo.addLists({
  // Every vehicle, the latest first, with its owner, the latest reading, the
  // next service and an open job card if there is one.
  'garage-vehicles': {
    sql: `SELECT v.id,v.registration_no,v.make,v.model,v.variant,v.fuel,v.year,v.engine_code,v.contact_id,c.name AS owner_name,c.phone AS owner_phone,v.chassis_no,v.engine_no,
      v.odometer_km,v.odometer_at,v.insurance_expires_on,v.puc_expires_on,v.next_service_on,v.next_service_km,v.active,v.created_at,
      concat_ws(' ',v.make,v.model,v.variant) AS vehicle_name,
      (SELECT count(*)::int FROM garage_job_cards j WHERE j.business_id=v.business_id AND j.vehicle_id=v.id AND j.status<>'cancelled') AS jobs,
      (SELECT max(j.created_at) FROM garage_job_cards j WHERE j.business_id=v.business_id AND j.vehicle_id=v.id AND j.status<>'cancelled') AS last_job_at,
      o.id AS open_job_id,o.job_no AS open_job_no,o.status AS open_job_status
      FROM garage_vehicles v JOIN business_contacts c ON c.business_id=v.business_id AND c.id=v.contact_id
      LEFT JOIN LATERAL (SELECT j.id,j.job_no,j.status FROM garage_job_cards j WHERE j.business_id=v.business_id AND j.vehicle_id=v.id
        AND j.status NOT IN ('delivered','cancelled') ORDER BY j.id DESC LIMIT 1) o ON true
      WHERE v.business_id=$1`,
    search: ['registration_no', 'vehicle_name', 'owner_name', 'owner_phone', 'chassis_no', 'engine_no'], date: 'created_at',
    filters: { owner: 'contact_id', active: 'active', fuel: 'fuel' }, order: 'id DESC',
  },
});

// --- Reading a request ---------------------------------------------------------------------

function readYear(value) {
  if (!c.given(value)) return null;
  const text = String(value).trim();
  const latest = new Date().getUTCFullYear() + YEAR_AHEAD;
  if (!/^\d{4}$/.test(text) || Number(text) < 1950 || Number(text) > latest) fail(`Year must be a year from 1950 to ${latest}`);
  return Number(text);
}

// The engine's code as the maker writes it (K12M, 1.2 VVT is 12VVT): letters, digits and dashes. Empty is none.
function readEngineCode(value) {
  if (!c.given(value)) return null;
  const text = String(value).toUpperCase().replace(/[\s.]+/g, '');
  if (!/^[A-Z0-9-]{2,30}$/.test(text)) fail('Engine code must be 2 to 30 letters, digits or dashes, like K12M');
  return text;
}

// What a vehicle says about itself; on a change, what is left out stays.
function readVehicle(body, current = null) {
  const keep = (key, column, read) => (body[key] === undefined && current ? current[column] : read(body[key]));
  return {
    registration_no: keep('registrationNo', 'registration_no', (x) => c.readRegistration(x)),
    make: keep('make', 'make', (x) => v.requiredString(typeof x === 'string' ? x : '', 'Make', 60)),
    model: keep('model', 'model', (x) => v.requiredString(typeof x === 'string' ? x : '', 'Model', 60)),
    variant: keep('variant', 'variant', (x) => c.optionalText(x, 'Variant', 60)),
    fuel: keep('fuel', 'fuel', (x) => v.optionalEnum(x, 'Fuel', c.FUELS, null)),
    year: keep('year', 'year', readYear),
    chassis_no: keep('chassisNo', 'chassis_no', (x) => c.readFrameNumber(x, 'Chassis number', 5)),
    engine_no: keep('engineNo', 'engine_no', (x) => c.readFrameNumber(x, 'Engine number', 3)),
    engine_code: keep('engineCode', 'engine_code', readEngineCode),
    insurance_expires_on: keep('insuranceExpiresOn', 'insurance_expires_on', (x) => c.readDate(x, 'Insurance valid until', true)),
    puc_expires_on: keep('pucExpiresOn', 'puc_expires_on', (x) => c.readDate(x, 'PUC valid until', true)),
    next_service_on: keep('nextServiceOn', 'next_service_on', (x) => c.readDate(x, 'Next service on', true)),
    next_service_km: keep('nextServiceKm', 'next_service_km', (x) => { const n = c.readKm(x, 'Next service at'); if (n === 0) fail('Next service at must be more than 0 km'); return n; }),
    notes: keep('notes', 'notes', (x) => c.optionalText(x, 'Notes', 500)),
  };
}

// The owner: { contactId } (a saved customer) or { name, phone? } (a new one).
function readOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Choose the owner: a saved customer, or a new one\'s name');
  if (c.given(value.contactId)) return { contactId: id(value.contactId, 'Owner') };
  const name = v.requiredString(typeof value.name === 'string' ? value.name : '', 'Owner\'s name', 150);
  const phone = c.optionalText(value.phone, 'Owner\'s phone', 30);
  if (phone && phone.replace(/\D/g, '').length < 10) fail('A phone number has at least 10 digits');
  return { name, phone, consents: value.consents };
}

// A saved customer, or a new one made in the same transaction (needs contacts.create).
async function ownerContact(db, business, user, owner) {
  if (owner.contactId) {
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, owner.contactId]);
    if (!contact) fail('Owner not found among the customers', 404);
    return contact;
  }
  return core.createContact(business, user, { kind: 'customer', name: owner.name, phone: owner.phone, consents: owner.consents }, db);
}

// A manager's approval of a lower reading: { reason, approverId?, pin? }, read
// before the transaction (a PIN check holds no locks). null when none is given.
async function readLowerApproval(business, user, value) {
  if (value === undefined || value === null || value === '') return null;
  return pins().readApproval(business, user, value, 'garage.approve', { reasonLabel: 'Why the reading is lower', selfWithoutPin: true });
}

// --- Odometer readings ------------------------------------------------------------------------

// A reading into the vehicle's log, inside the caller's transaction (the
// business locked). A reading lower than the last needs `approval`; the
// database refuses it otherwise.
async function recordReading(db, business, user, vehicle, readingKm, { source, jobCardId = null, approval = null }) {
  const last = vehicle.odometer_km === null || vehicle.odometer_km === undefined ? null : Number(vehicle.odometer_km);
  const lower = last !== null && readingKm < last;
  if (lower && !approval) {
    fail(`${vehicle.registration_no} reads ${c.km(readingKm)} km, lower than its last reading of ${c.km(last)} km. A manager approves a lower reading (a meter changed or reset), with a note why.`, 409,
      { reason: 'odometer_lower', lastKm: last, lastAt: vehicle.odometer_at });
  }
  const row = await repo.one(db, `INSERT INTO garage_odometer_readings(business_id,vehicle_id,reading_km,source,job_card_id,lower_approved_by,lower_reason,recorded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, vehicle.id, readingKm, source, jobCardId, lower ? approval.approver.id : null, lower ? approval.reason : null, user.id]);
  await repo.audit(db, business.id, lower ? approval.approver.id : user.id, 'odometer.recorded', vehicle.id, {
    registrationNo: vehicle.registration_no, km: readingKm, source, ...(lower ? { lowerThan: last, reason: approval.reason, recordedBy: user.id } : {}) });
  return row;
}

// body: { km, approval?: { reason, approverId?, pin? } }
async function recordOdometer(business, user, vehicleId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  const readingKm = c.readKm(body.km, 'Odometer');
  if (readingKm === null) fail('Odometer is required');
  const approval = await readLowerApproval(business, user, body.approval);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const vehicle = await lockVehicle(db, business, vehicleId);
    await recordReading(db, business, user, vehicle, readingKm, { source: 'vehicle', approval });
    return load(db, business, vehicle.id);
  });
}

// --- Vehicles ----------------------------------------------------------------------------------

async function lockVehicle(db, business, vehicleId) {
  const vehicle = await repo.one(db, 'SELECT * FROM garage_vehicles WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(vehicleId, 'Vehicle')]);
  if (!vehicle) fail('Vehicle not found', 404);
  return vehicle;
}

// One number per vehicle and one chassis per vehicle: say which vehicle has it.
async function checkUnique(db, business, fields, vehicleId = null) {
  const same = await repo.one(db, 'SELECT id FROM garage_vehicles WHERE business_id=$1 AND registration_no=$2 AND ($3::bigint IS NULL OR id<>$3)', [business.id, fields.registration_no, vehicleId]);
  if (same) fail(`${fields.registration_no} is already a vehicle here: open it to change it`, 409, { vehicleId: Number(same.id) });
  if (fields.chassis_no) {
    const chassis = await repo.one(db, 'SELECT registration_no FROM garage_vehicles WHERE business_id=$1 AND chassis_no=$2 AND ($3::bigint IS NULL OR id<>$3)', [business.id, fields.chassis_no, vehicleId]);
    if (chassis) fail(`Chassis ${fields.chassis_no} is already on ${chassis.registration_no}: a vehicle that was registered again keeps its record, with its new number`, 409);
  }
}


// body: { registrationNo, make, model, variant?, fuel?, year?, chassisNo?, engineNo?, owner: { contactId } | { name, phone? },
//   odometerKm?, insuranceExpiresOn?, pucExpiresOn?, nextServiceOn?, nextServiceKm?, notes? }
async function create(business, user, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.create');
  const fields = readVehicle(body);
  const owner = readOwner(body.owner);
  if (!owner.contactId) await access.require(business, 'contacts.create');
  const readingKm = c.readKm(body.odometerKm, 'Odometer');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    await checkUnique(db, business, fields);
    const contact = await ownerContact(db, business, user, owner);
    const vehicle = await repo.one(db, `INSERT INTO garage_vehicles(business_id,registration_no,make,model,variant,fuel,year,contact_id,chassis_no,engine_no,
        insurance_expires_on,puc_expires_on,next_service_on,next_service_km,notes,created_by,updated_by,engine_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17) RETURNING *`,
    [business.id, fields.registration_no, fields.make, fields.model, fields.variant, fields.fuel, fields.year, contact.id, fields.chassis_no, fields.engine_no,
      fields.insurance_expires_on, fields.puc_expires_on, fields.next_service_on, fields.next_service_km, fields.notes, user.id, fields.engine_code]);
    await repo.audit(db, business.id, user.id, 'vehicle.added', vehicle.id, { registrationNo: vehicle.registration_no, owner: contact.name, ...(owner.contactId ? {} : { newCustomer: true }) });
    if (readingKm !== null) await recordReading(db, business, user, vehicle, readingKm, { source: 'vehicle' });
    return load(db, business, vehicle.id);
  });
}

// body: any of create's fields but the owner and the reading (they have their own changes), and active.
async function update(business, user, vehicleId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  if (body.owner !== undefined) fail('Change the owner with Change owner, which keeps the owners');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await lockVehicle(db, business, vehicleId);
    const fields = readVehicle(body, current);
    const active = body.active === undefined ? current.active : v.requiredBoolean(body.active, 'Active');
    await checkUnique(db, business, fields, current.id);
    if (!active && current.active) {
      const open = await repo.one(db, "SELECT job_no FROM garage_job_cards WHERE business_id=$1 AND vehicle_id=$2 AND status NOT IN ('delivered','cancelled') ORDER BY id LIMIT 1", [business.id, current.id]);
      if (open) fail(`${current.registration_no} has an open job card (${open.job_no}): deliver or cancel it before switching the vehicle off`, 409);
    }
    const columns = Object.keys(fields);
    await db.query(`UPDATE garage_vehicles SET ${columns.map((column, index) => `${column}=$${index + 3}`).join(',')},active=$${columns.length + 3},updated_by=$${columns.length + 4},updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, current.id, ...columns.map((column) => fields[column]), active, user.id]);
    // Dates are plain YYYY-MM-DD text; every value is compared as written.
    const text = (x) => (x === null || x === undefined ? null : String(x));
    const before = { ...Object.fromEntries(columns.map((column) => [column, text(current[column])])), active: current.active };
    const after = { ...Object.fromEntries(columns.map((column) => [column, text(fields[column])])), active };
    const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'vehicle.updated', current.id, { registrationNo: fields.registration_no,
        from: Object.fromEntries(changed.map((key) => [key, before[key]])), to: Object.fromEntries(changed.map((key) => [key, after[key]])) });
    }
    return load(db, business, current.id);
  });
}

// body: { owner: { contactId } | { name, phone? }, note? } — the vehicle sold or handed over.
async function changeOwner(business, user, vehicleId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  const owner = readOwner(body.owner);
  if (!owner.contactId) await access.require(business, 'contacts.create');
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await lockVehicle(db, business, vehicleId);
    const contact = await ownerContact(db, business, user, owner);
    if (Number(contact.id) === Number(current.contact_id)) fail(`${contact.name} already owns ${current.registration_no}`, 409);
    const was = await repo.one(db, 'SELECT name FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, current.contact_id]);
    await db.query('UPDATE garage_vehicles SET contact_id=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, current.id, contact.id, user.id]);
    await repo.audit(db, business.id, user.id, 'vehicle.owner_changed', current.id, { registrationNo: current.registration_no, from: was?.name || null, to: contact.name,
      fromContactId: Number(current.contact_id), toContactId: Number(contact.id), ...(note ? { note } : {}) });
    return load(db, business, current.id);
  });
}

// --- Reading a vehicle -------------------------------------------------------------------------

const ZONE_SQL = 'CROSS JOIN (SELECT timezone AS tz,(now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1) z';

async function load(db, business, vehicleId) {
  const vehicle = await repo.one(db, `SELECT v.*,concat_ws(' ',v.make,v.model,v.variant) AS vehicle_name,ow.name AS owner_name,ow.phone AS owner_phone,ow.address AS owner_address,
      ow.gstin AS owner_gstin,cu.name AS created_by_name,${c.AVERAGE_SQL} AS average_km_day,${c.PROJECTED_SQL('v')} AS projected_km,
      drive.first_on AS driven_since
    FROM garage_vehicles v ${ZONE_SQL}
    JOIN business_contacts ow ON ow.business_id=v.business_id AND ow.id=v.contact_id
    JOIN users cu ON cu.id=v.created_by
    ${c.DRIVING_SQL('v')}
    WHERE v.business_id=$1 AND v.id=$2`, [business.id, vehicleId]);
  if (!vehicle) fail('Vehicle not found', 404);
  // One query at a time: `db` may be a transaction's own client.
  const owners = await repo.all(db, `SELECT o.id,o.contact_id,k.name,k.phone,o.since,u.name AS recorded_by_name FROM garage_vehicle_owners o
    JOIN business_contacts k ON k.business_id=o.business_id AND k.id=o.contact_id JOIN users u ON u.id=o.recorded_by
    WHERE o.business_id=$1 AND o.vehicle_id=$2 ORDER BY o.id DESC`, [business.id, vehicle.id]);
  const readings = await repo.all(db, `SELECT r.id,r.reading_km,r.source,r.recorded_at,r.lower_reason,u.name AS recorded_by_name,a.name AS approved_by_name,j.job_no,r.job_card_id
    FROM garage_odometer_readings r JOIN users u ON u.id=r.recorded_by LEFT JOIN users a ON a.id=r.lower_approved_by
    LEFT JOIN garage_job_cards j ON j.business_id=r.business_id AND j.id=r.job_card_id
    WHERE r.business_id=$1 AND r.vehicle_id=$2 ORDER BY r.id DESC LIMIT 50`, [business.id, vehicle.id]);
  const jobs = await repo.all(db, `SELECT j.id,j.job_no,j.status,j.created_at,j.delivered_at,j.odometer_in,j.complaints,j.customer_name,j.contact_id,j.total,j.location_id,
      d.document_no,d.total AS bill_total,i.document_no AS insurer_document_no,i.total AS insurer_bill_total
    FROM garage_job_cards j LEFT JOIN business_documents d ON d.business_id=j.business_id AND d.id=j.document_id
    LEFT JOIN business_documents i ON i.business_id=j.business_id AND i.id=j.insurer_document_id
    WHERE j.business_id=$1 AND j.vehicle_id=$2 AND ($3::bigint IS NULL OR j.location_id=$3) ORDER BY j.id DESC LIMIT 100`,
  [business.id, vehicle.id, business.member_location_id || null]);
  const reminders = await repo.all(db, `SELECT m.id,m.kind,m.channel,m.created_at,u.name AS by_name FROM garage_reminders m JOIN users u ON u.id=m.created_by
    WHERE m.business_id=$1 AND m.vehicle_id=$2 ORDER BY m.id DESC LIMIT 20`, [business.id, vehicle.id]);
  const money = c.seesMoney(business);
  return { ...vehicle, owners, readings, reminders, money,
    jobs: money ? jobs : jobs.map((j) => ({ ...j, total: null, bill_total: null, insurer_bill_total: null })),
    open_job: jobs.find((j) => c.OPEN.includes(j.status)) || null };
}

async function detail(business, vehicleId) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  return load(repo.pool, business, id(vehicleId, 'Vehicle'));
}

// The vehicle with this registration number (as typed), and its open job card.
async function find(business, query) {
  c.requireGarage(business);
  await access.requireAny(business, ['garage.view', 'garage.create']);
  const plate = c.plateOf(query.registration);
  if (plate.length < 4) fail('Type the registration number on the plate');
  const vehicle = await repo.one(repo.pool, `SELECT v.id,v.registration_no,concat_ws(' ',v.make,v.model,v.variant) AS vehicle_name,v.make,v.model,v.variant,v.fuel,v.year,v.engine_code,v.active,
      v.contact_id,k.name AS owner_name,k.phone AS owner_phone,v.odometer_km,v.odometer_at,v.next_service_on,v.next_service_km,v.insurance_expires_on,v.puc_expires_on,
      (SELECT json_build_object('id',j.id,'job_no',j.job_no,'status',j.status) FROM garage_job_cards j WHERE j.business_id=v.business_id AND j.vehicle_id=v.id
        AND j.status NOT IN ('delivered','cancelled') ORDER BY j.id DESC LIMIT 1) AS open_job
    FROM garage_vehicles v JOIN business_contacts k ON k.business_id=v.business_id AND k.id=v.contact_id
    WHERE v.business_id=$1 AND v.registration_no=$2`, [business.id, plate]);
  return { registration_no: plate, vehicle: vehicle || null };
}

// A customer's statement: their vehicles (those they own now and any other
// they had serviced here), each with its job cards in the period, and what
// they were billed, paid and still owe. query: { from?, to? }
async function statement(business, contactId, query = {}) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  const from = query.from ? core.dateText(query.from, 'From date') : null;
  const to = query.to ? core.dateText(query.to, 'To date') : null;
  if (from && to && to < from) fail('The end date is before the start date');
  const customer = await repo.one(repo.pool, `SELECT k.id,k.name,k.phone,k.address,k.gstin,${repo.contactBalanceSql('k')} AS balance FROM business_contacts k
    WHERE k.business_id=$1 AND k.id=$2 AND k.kind='customer'`, [business.id, id(contactId, 'Customer')]);
  if (!customer) fail('Customer not found', 404);
  const jobs = await repo.all(repo.pool, `SELECT j.id,j.job_no,j.vehicle_id,j.status,j.created_at,j.delivered_at,j.odometer_in,j.complaints,j.total,j.location_id,
      d.document_no,d.total AS bill_total,
      COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
        -COALESCE((SELECT sum(f.amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS paid,
      COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned,
      i.document_no AS insurer_document_no,i.total AS insurer_bill_total
    FROM garage_job_cards j JOIN businesses b ON b.id=j.business_id
    LEFT JOIN business_documents d ON d.business_id=j.business_id AND d.id=j.document_id
    LEFT JOIN business_documents i ON i.business_id=j.business_id AND i.id=j.insurer_document_id
    WHERE j.business_id=$1 AND j.contact_id=$2 AND j.status<>'cancelled'
      AND ($3::date IS NULL OR (j.created_at AT TIME ZONE b.timezone)::date >= $3) AND ($4::date IS NULL OR (j.created_at AT TIME ZONE b.timezone)::date <= $4)
      AND ($5::bigint IS NULL OR j.location_id=$5)
    ORDER BY j.id`, [business.id, customer.id, from, to, business.member_location_id || null]);
  const vehicles = await repo.all(repo.pool, `SELECT v.id,v.registration_no,concat_ws(' ',v.make,v.model,v.variant) AS vehicle_name,v.contact_id,v.odometer_km,v.next_service_on,v.next_service_km,v.active
    FROM garage_vehicles v WHERE v.business_id=$1 AND (v.contact_id=$2 OR v.id=ANY($3::bigint[])) ORDER BY v.registration_no`,
  [business.id, customer.id, [...new Set(jobs.map((j) => Number(j.vehicle_id)))]]);
  const money = c.seesMoney(business);
  const paise = (x) => Math.round(Number(x || 0) * 100);
  const rupees = (p) => (p / 100).toFixed(2);
  const settings = await repo.one(repo.pool, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  let billed = 0, paid = 0;
  const groups = vehicles.map((vehicle) => {
    const own = jobs.filter((j) => Number(j.vehicle_id) === Number(vehicle.id)).map((j) => {
      const bill = j.document_no ? paise(j.bill_total) - paise(j.returned) : 0;
      billed += bill; paid += j.document_no ? paise(j.paid) : 0;
      return { ...j, billed: j.document_no ? rupees(bill) : null, due: j.document_no ? rupees(Math.max(0, bill - paise(j.paid))) : null };
    });
    const total = own.reduce((sum, j) => sum + (j.billed ? paise(j.billed) : 0), 0);
    return { ...vehicle, owned_now: Number(vehicle.contact_id) === Number(customer.id), jobs: own, billed: rupees(total) };
  });
  const out = { customer, from, to, vehicles: groups, jobs: jobs.length, billed: rupees(billed), paid: rupees(paid), due: rupees(Math.max(0, billed - paid)), seller: core.branchSeller(settings, null), money };
  if (money) return out;
  return { ...out, customer: { ...customer, balance: null }, billed: null, paid: null, due: null,
    vehicles: groups.map((g) => ({ ...g, billed: null, jobs: g.jobs.map((j) => ({ ...j, total: null, bill_total: null, paid: null, returned: null, billed: null, due: null, insurer_bill_total: null })) })) };
}

// Who may approve: a lower reading (garage.approve), or an advance handed
// back (sales.refund). Members whose role holds it, with whether they have a PIN
// and whether someone else set it (pin_given: it approves nothing until they choose their own).
const APPROVALS = ['garage.approve', 'sales.refund'];
async function approvers(business, query = {}) {
  c.requireGarage(business);
  const permission = query.permission === undefined ? 'garage.approve' : String(query.permission);
  if (!APPROVALS.includes(permission)) fail('Unknown approval');
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin,u.pin_must_change AS pin_given FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code=$2))
    ORDER BY u.name`, [business.id, permission]);
}

module.exports = { create, update, changeOwner, recordOdometer, recordReading, readLowerApproval, detail, find, statement, approvers, lockVehicle };
