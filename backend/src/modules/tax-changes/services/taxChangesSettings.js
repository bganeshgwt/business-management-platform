const crypto = require('node:crypto');
const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const money = require('./taxChangesMoney');

// GST rates kept in settings, changed by date. Three rates are not an item's
// own: a fashion shop's GST by price (the price per piece and its two rates),
// a lodge's two room-night slabs and the limit between them, and a
// restaurant's default GST rate (its advances' GST is worked out at it). A
// change of one is entered ahead like an item's, cancelled before its date if
// need be, and applied on the business's or restaurant's own date by the same
// database functions as the items' (business_tax_change_apply and
// business_tax_change_apply_menu); once in force it is kept for good with
// what the setting was. A setting can still be changed by hand from today,
// where it is kept (GST by price, Room types & rates, Restaurant settings).
//
// Everything here works from a `world` (taxChangesShop.js, taxChangesMenu.js):
//   setting               'fashion_price', 'lodging_slabs', 'restaurant_default', or null (none kept)
//   businessId(db, make)  the business the changes belong to
//   requireView() / requireEdit()
//   lock(db), applyDue(db), today(db)
//   current(db)           the setting's values now (null: not set up yet)
//   slab(db, id)          a shop's slab in use { id, name, rate } (room nights)
//   audit(db, action, entityId, details)

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// What each setting is called, and where it is changed by hand from today.
const SETTINGS = {
  fashion_price: { name: 'GST by price', where: 'Products & services › Size × colour (More: GST on clothing by price)' },
  lodging_slabs: { name: 'Room-night slabs', where: 'Settings › Room types & rates' },
  restaurant_default: { name: 'Default GST rate', where: 'Settings › GST and invoice' },
};

// A rupee amount or a rate, as the API takes it.
function decimal(value, name, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) fail(`${name} must be a number with at most two decimals`);
  const number = Number(text);
  if (number < min || number > max) fail(`${name} must be between ${min} and ${max}`);
  return number.toFixed(2);
}
function readDate(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail('Start date must be a valid date');
  return text;
}

// The values a change sets, as the API shows them.
function valuesOf(setting, row) {
  if (!row) return null;
  if (setting === 'fashion_price') return { threshold: Number(row.threshold).toFixed(2), rateLow: Number(row.rate_low).toFixed(2), rateHigh: Number(row.rate_high).toFixed(2) };
  if (setting === 'lodging_slabs') {
    return { lowTaxRateId: Number(row.low_tax_rate_id), highTaxRateId: Number(row.high_tax_rate_id), slabLimit: Number(row.slab_limit).toFixed(2),
      lowName: row.low_name || null, lowRate: row.low_rate === null || row.low_rate === undefined ? null : Number(row.low_rate).toFixed(2),
      highName: row.high_name || null, highRate: row.high_rate === null || row.high_rate === undefined ? null : Number(row.high_rate).toFixed(2) };
  }
  return { rate: Number(row.rate).toFixed(2) };
}
// The same values compared: only what the change sets.
const keyOf = (setting, values) => (setting === 'fashion_price' ? `${values.threshold}|${values.rateLow}|${values.rateHigh}`
  : setting === 'lodging_slabs' ? `${values.lowTaxRateId}|${values.highTaxRateId}|${values.slabLimit}` : `${values.rate}`);

// The values as people say them: "Up to ₹2,500.00 a piece 5%, above it 18%".
function words(setting, values) {
  if (!values) return 'Not set up';
  const rupees = (amount) => `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (setting === 'fashion_price') return `Up to ${rupees(values.threshold)} a piece ${money.rateWords(values.rateLow)}, above it ${money.rateWords(values.rateHigh)}`;
  if (setting === 'lodging_slabs') {
    const name = (n, rate) => n || (rate === null ? 'a slab' : money.rateWords(rate));
    return `A room night up to ${rupees(values.slabLimit)} at ${name(values.lowName, values.lowRate)}, above it ${name(values.highName, values.highRate)}`;
  }
  return money.rateWords(values.rate);
}

const SELECT = `SELECT c.*,c.starts_on::text AS starts_on,u.name AS created_by_name,cu.name AS cancelled_by_name,
    lo.name AS low_name,lo.rate AS low_rate,hi.name AS high_name,hi.rate AS high_rate
  FROM business_tax_setting_changes c JOIN users u ON u.id=c.created_by LEFT JOIN users cu ON cu.id=c.cancelled_by
  LEFT JOIN business_tax_rates lo ON lo.business_id=c.business_id AND lo.id=c.low_tax_rate_id
  LEFT JOIN business_tax_rates hi ON hi.business_id=c.business_id AND hi.id=c.high_tax_rate_id`;
function shape(row) {
  const values = valuesOf(row.setting, row);
  const before = row.before ? (row.setting === 'fashion_price'
    ? (row.before.threshold === null ? null : valuesOf(row.setting, { threshold: row.before.threshold, rate_low: row.before.rateLow, rate_high: row.before.rateHigh }))
    : row.setting === 'lodging_slabs'
      ? (row.before.lowTaxRateId === null || row.before.lowTaxRateId === undefined ? null : valuesOf(row.setting, { low_tax_rate_id: row.before.lowTaxRateId,
        high_tax_rate_id: row.before.highTaxRateId, slab_limit: row.before.slabLimit, low_name: row.before.lowName, low_rate: row.before.lowRate,
        high_name: row.before.highName, high_rate: row.before.highRate }))
      : valuesOf(row.setting, { rate: row.before.rate })) : null;
  return {
    id: Number(row.id), setting: row.setting, name: SETTINGS[row.setting].name, startsOn: row.starts_on,
    status: row.status, state: row.status === 'applied' ? 'in_force' : row.status,
    values, words: words(row.setting, values), before, beforeWords: before ? words(row.setting, before) : null,
    reason: row.reason, note: row.note, settledAt: row.settled_at, createdAt: row.created_at, createdByName: row.created_by_name,
    cancelledAt: row.cancelled_at, cancelledByName: row.cancelled_by_name, cancelReason: row.cancel_reason,
  };
}

async function changesOf(db, businessId, setting) {
  if (!businessId || !setting) return [];
  return (await repo.all(db, `${SELECT} WHERE c.business_id=$1 AND c.setting=$2
    ORDER BY c.status='scheduled' DESC,c.starts_on DESC,c.id DESC LIMIT 200`, [businessId, setting])).map(shape);
}

// The setting kept by this business, its values now, and its changes: those
// to come first, then those in force, refused or cancelled.
async function read(world) {
  await world.requireView();
  if (!world.setting) return { setting: null, changes: [] };
  return repo.transaction(async (db) => {
    await world.applyDue(db);
    const current = await world.current(db);
    return {
      setting: world.setting, name: SETTINGS[world.setting].name, where: SETTINGS[world.setting].where, today: await world.today(db),
      current, currentWords: words(world.setting, current), changes: await changesOf(db, await world.businessId(db, false), world.setting),
    };
  });
}

// The new values asked for, checked as the setting itself checks them.
async function readValues(world, db, body) {
  const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
  if (world.setting === 'fashion_price') {
    const threshold = decimal(values.threshold, 'Price per piece', 1, 10000000);
    const rateLow = decimal(values.rateLow, 'Lower GST rate', 0, 100);
    const rateHigh = decimal(values.rateHigh, 'Higher GST rate', 0, 100);
    if (Number(rateHigh) < Number(rateLow)) fail('The higher rate must be at least the lower rate');
    return { threshold, rateLow, rateHigh };
  }
  if (world.setting === 'lodging_slabs') {
    const low = await world.slab(db, v.requiredId(values.lowTaxRateId, 'Slab at or below the limit'));
    const high = await world.slab(db, v.requiredId(values.highTaxRateId, 'Slab above the limit'));
    if (Number(low.id) === Number(high.id)) fail('The two slabs are different slabs: the lower one, and the higher one above the limit');
    if (Number(low.rate) >= Number(high.rate)) fail(`A room night at or below the limit is billed at the lower slab and one above it at the higher: ${low.name} is not below ${high.name}`);
    return { lowTaxRateId: Number(low.id), highTaxRateId: Number(high.id), slabLimit: decimal(values.slabLimit, 'The limit a room a night', 1, 10000000),
      lowName: low.name, lowRate: Number(low.rate).toFixed(2), highName: high.name, highRate: Number(high.rate).toFixed(2) };
  }
  return { rate: decimal(values.rate, 'Default GST rate', 0, 100) };
}

// body: { requestKey, startsOn, reason, values: { threshold, rateLow, rateHigh } | { lowTaxRateId, highTaxRateId, slabLimit } | { rate } }
async function schedule(world, user, body) {
  await world.requireEdit();
  if (!world.setting) fail('This business keeps no GST rate in its settings', 404);
  if (!UUID.test(String(body.requestKey || ''))) fail('A valid request key is required');
  const hash = sha256(body);
  const startsOn = readDate(body.startsOn);
  const reason = v.requiredString(body.reason, 'Reason', 300);
  const { setting } = world;
  return repo.transaction(async (db) => {
    const businessId = await world.businessId(db, true);
    await world.lock(db);
    const old = await repo.one(db, 'SELECT id,request_hash FROM business_tax_setting_changes WHERE business_id=$1 AND request_key=$2', [businessId, body.requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(await repo.one(db, `${SELECT} WHERE c.business_id=$1 AND c.id=$2`, [businessId, old.id]));
    }
    await world.applyDue(db);
    const problem = money.startProblem(startsOn, await world.today(db), `To change ${SETTINGS[setting].name.toLowerCase()} from today, change it under ${SETTINGS[setting].where}.`);
    if (problem) fail(problem);
    const current = await world.current(db);
    if (!current) {
      fail(setting === 'fashion_price' ? `Set up GST by price first, under ${SETTINGS[setting].where}`
        : `Set the two GST slabs for room nights first, under ${SETTINGS[setting].where}`, 409, { reason: 'not_set_up' });
    }
    const values = await readValues(world, db, body);
    const same = await repo.one(db, 'SELECT id FROM business_tax_setting_changes WHERE business_id=$1 AND setting=$2 AND starts_on=$3 AND status=\'scheduled\'', [businessId, setting, startsOn]);
    if (same) fail(`${SETTINGS[setting].name} already changes on ${money.dateWords(startsOn)}: cancel that change first`, 409);
    // What is in force the day before: the last change to come before it, else today's.
    const earlier = await repo.one(db, `${SELECT} WHERE c.business_id=$1 AND c.setting=$2 AND c.status='scheduled' AND c.starts_on<$3 ORDER BY c.starts_on DESC,c.id DESC LIMIT 1`,
      [businessId, setting, startsOn]);
    const then = earlier ? valuesOf(setting, earlier) : current;
    if (keyOf(setting, then) === keyOf(setting, values)) fail(`${SETTINGS[setting].name} is ${words(setting, values)} on ${money.dateWords(startsOn)} already`, 409, { reason: 'already_set' });
    const saved = await repo.one(db, `INSERT INTO business_tax_setting_changes(business_id,setting,starts_on,threshold,rate_low,rate_high,low_tax_rate_id,high_tax_rate_id,slab_limit,rate,
      reason,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [businessId, setting, startsOn, values.threshold ?? null, values.rateLow ?? null, values.rateHigh ?? null, values.lowTaxRateId ?? null, values.highTaxRateId ?? null,
      values.slabLimit ?? null, values.rate ?? null, reason, body.requestKey, hash, user.id]);
    await world.audit(db, 'tax_change.setting_scheduled', saved.id, { setting, name: SETTINGS[setting].name, startsOn, reason, from: words(setting, then), to: words(setting, values) });
    return shape(await repo.one(db, `${SELECT} WHERE c.business_id=$1 AND c.id=$2`, [businessId, saved.id]));
  });
}

// Before its date only (the database refuses it from then on); asking again is the same cancellation.
async function cancel(world, user, changeId, body) {
  await world.requireEdit();
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const businessId = await world.businessId(db, false);
    if (!businessId || !world.setting) fail('GST rate change not found', 404);
    await world.lock(db);
    // A change whose date has come takes effect, rather than being cancelled.
    await world.applyDue(db);
    const row = await repo.one(db, 'SELECT id,status,starts_on::text AS starts_on FROM business_tax_setting_changes WHERE business_id=$1 AND setting=$2 AND id=$3 FOR UPDATE',
      [businessId, world.setting, v.requiredId(changeId, 'GST rate change')]);
    if (!row) fail('GST rate change not found', 404);
    if (row.status === 'cancelled') return shape(await repo.one(db, `${SELECT} WHERE c.business_id=$1 AND c.id=$2`, [businessId, row.id]));
    if (row.status !== 'scheduled') fail(`This GST rate change started on ${money.dateWords(row.starts_on)} and is ${row.status === 'applied' ? 'in force' : 'refused'}: it is kept for good. Enter another change to set it again.`, 409);
    await db.query(`UPDATE business_tax_setting_changes SET status='cancelled',cancelled_by=$3,cancelled_at=now(),cancel_reason=$4 WHERE business_id=$1 AND id=$2`,
      [businessId, row.id, user.id, reason]);
    await world.audit(db, 'tax_change.setting_cancelled', row.id, { setting: world.setting, name: SETTINGS[world.setting].name, startsOn: row.starts_on, reason });
    return shape(await repo.one(db, `${SELECT} WHERE c.business_id=$1 AND c.id=$2`, [businessId, row.id]));
  });
}

// The setting's changes still to come within `days` of `today`, for the bell.
async function upcoming(db, businessId, today, days) {
  return (await repo.all(db, `${SELECT} WHERE c.business_id=$1 AND c.status='scheduled' AND c.starts_on>$2::date AND c.starts_on<=$2::date+$3::int
    ORDER BY c.starts_on,c.id`, [businessId, today, days])).map(shape);
}

module.exports = { SETTINGS, read, schedule, cancel, upcoming, words };
