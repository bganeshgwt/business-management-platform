const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const v = require('../../../../utils/validate');
const { guestPageUrl } = require('../../../../utils/guestLinks');
const engine = require('./onlineBookingEngine');
const { expireDue } = require('./onlineBookingExpiry');
const { fail, newToken } = require('./onlineBookingCommon');
const { termsOf } = require('../../core/services/businessWords.service');

// Online booking › Booking link: one booking link per location,
// its rules, and what shows online (online_appointments.manage to change;
// online_appointments.view to see).

// The types that book people's time (the module applies to these only).
const TYPES = ['salon', 'healthcare', 'optical', 'garage', 'memberships', 'electronics'];
function requireBooking(business) {
  if (!TYPES.includes(business.business_type)) fail('This screen belongs to businesses that take appointments', 404);
}

// A new link starts on its trade's usual rules: a clinic confirms each
// request, books a week ahead and stops at the session's start; a salon books
// at once a month ahead with two hours' notice; anyone else books at once.
function defaultsFor(type) {
  if (type === 'healthcare') return { confirm_mode: 'confirm', days_ahead: 7, min_notice_minutes: 0, slot_step_minutes: 15 };
  if (type === 'salon') return { confirm_mode: 'instant', days_ahead: 30, min_notice_minutes: 120, slot_step_minutes: 15 };
  return { confirm_mode: 'instant', days_ahead: 30, min_notice_minutes: 120, slot_step_minutes: 30 };
}

const FIELDS = {
  enabled: ['enabled', (x) => v.requiredBoolean(x, 'Taking online bookings')],
  confirmMode: ['confirm_mode', (x) => v.requiredEnum(x, 'How bookings are confirmed', ['instant', 'confirm'])],
  daysAhead: ['days_ahead', (x) => whole(x, 'Days guests can book ahead', 1, 90)],
  minNoticeMinutes: ['min_notice_minutes', (x) => whole(x, 'Notice before a booking (minutes)', 0, 2880)],
  slotStepMinutes: ['slot_step_minutes', (x) => {
    const n = whole(x, 'Times every (minutes)', 10, 60);
    if (![10, 15, 20, 30, 60].includes(n)) fail('Times every 10, 15, 20, 30 or 60 minutes');
    return n;
  }],
  cancelHours: ['cancel_hours', (x) => whole(x, 'Guests cancel or change online until (hours before)', 0, 168)],
  maxChanges: ['max_changes', (x) => whole(x, 'Changes online per booking', 0, 5)],
  maxOpenPerMobile: ['max_open_per_mobile', (x) => whole(x, 'Bookings one mobile may hold', 1, 10)],
  showPrices: ['show_prices', (x) => v.requiredBoolean(x, 'Show prices')],
  allowAnyStaff: ['allow_any_staff', (x) => v.requiredBoolean(x, 'Let guests choose anyone')],
  confirmAfterNoShows: ['confirm_after_no_shows', (x) => whole(x, 'No-shows before bookings need your OK', 0, 10)],
  requestExpiryHours: ['request_expiry_hours', (x) => whole(x, 'Hours to answer a request', 1, 72)],
  onlineSharePercent: ['online_share_percent', (x) => whole(x, 'Share of a session booked online (%)', 10, 100)],
  upiAdvance: ['upi_advance', (x) => v.requiredBoolean(x, 'Take an advance by UPI')],
  upiId: ['upi_id', (x) => {
    const text = v.optionalString(x, 'UPI id', 100);
    if (text && !/^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(text)) fail('A UPI id looks like name@bank, for example shinesalon@okicici');
    return text || null;
  }],
  upiPayee: ['upi_payee', (x) => v.optionalString(x, 'Name on the UPI account', 100) || null],
  guestNote: ['guest_note', (x) => v.optionalString(x, 'A note for guests', 300) || null],
};
function whole(value, name, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

const linkUrl = (token) => guestPageUrl(`/appointments/${token}`);

// What stands in the way of good online bookings at a link, in words for the
// owner: the business's own (t, businessWords.service).
function readiness(business, shown, link, privacy, t) {
  const notes = [];
  const people = shown.people.filter((p) => p.shown);
  if (shown.kind === 'salon') {
    if (!shown.services.some((s) => s.shown)) notes.push({ level: 'warning', text: 'No service shows online: give your services their times under Stylists & services › Service times.' });
    if (!people.length) notes.push({ level: 'warning', text: `No ${t.lower('provider')} shows online at this location.` });
    if (shown.salon.depositPercent > 0 && !(link && link.upi_advance)) notes.push({ level: 'info', text: `The salon takes a ${shown.salon.depositPercent}% deposit, so online bookings come as requests: the desk takes the deposit when it confirms. Switch on the UPI advance to have ${t.lower('customer', 'many')} pay it first.` });
  } else if (shown.kind === 'clinic') {
    const ready = shown.people.filter((p) => p.ready && p.shown);
    if (!ready.length) notes.push({ level: 'warning', text: `No ${t.lower('provider')} shows online: ${t.a('provider')} needs OPD timings and a consultation fee (Doctors, fees & OPD).` });
    for (const doctor of shown.people.filter((p) => p.shown && !p.ready)) {
      notes.push({ level: 'info', text: `${doctor.name} is not shown online: ${!doctor.sessions.length ? 'no OPD timings' : 'no consultation fee'} yet.` });
    }
    for (const doctor of ready.filter((p) => !p.registrationNo)) {
      notes.push({ level: 'warning', text: `${doctor.name}: registration number not given. ${t('customer', 'many')} should see it before they book (Doctors, fees & OPD).` });
    }
  } else {
    if (!shown.services.some((s) => s.shown && s.minutes)) notes.push({ level: 'warning', text: `No service shows online yet: tick the services ${t.lower('customer', 'many')} may book and give each its length.` });
    if (!people.length) notes.push({ level: 'warning', text: 'Nobody shows online at this location.' });
    const hours = shown.location && shown.location.opening_hours;
    if (!hours || !Object.keys(hours).length) notes.push({ level: 'warning', text: `${shown.location ? shown.location.name : 'This location'} has no opening hours, so no times can show: set them in Settings › Locations.` });
  }
  if (!privacy) notes.push({ level: 'info', text: `Publish your privacy notice (Settings › Personal data) so ${t.lower('customer', 'many')} can agree to reminders when they book.` });
  return notes;
}

const linkView = (link) => (link ? {
  id: Number(link.id), locationId: Number(link.location_id), token: link.token, url: linkUrl(link.token), enabled: link.enabled, confirmMode: link.confirm_mode,
  daysAhead: Number(link.days_ahead), minNoticeMinutes: Number(link.min_notice_minutes), slotStepMinutes: Number(link.slot_step_minutes), cancelHours: Number(link.cancel_hours),
  maxChanges: Number(link.max_changes), maxOpenPerMobile: Number(link.max_open_per_mobile), showPrices: link.show_prices, allowAnyStaff: link.allow_any_staff,
  confirmAfterNoShows: Number(link.confirm_after_no_shows), requestExpiryHours: Number(link.request_expiry_hours), onlineSharePercent: Number(link.online_share_percent),
  upiAdvance: link.upi_advance, upiId: link.upi_id, upiPayee: link.upi_payee, guestNote: link.guest_note, updatedAt: link.updated_at,
} : null);

// Every location's link (or none yet) with what shows online and what to fix.
async function overview(business) {
  requireBooking(business);
  await access.require(business, 'online_appointments.view');
  await expireDue(business.id);
  const locations = await repo.all(repo.pool, 'SELECT id,name,code FROM business_locations WHERE business_id=$1 AND active AND ($2::bigint IS NULL OR id=$2) ORDER BY id',
    [business.id, business.location_scope || null]);
  const links = await repo.all(repo.pool, 'SELECT * FROM business_booking_links WHERE business_id=$1', [business.id]);
  const privacy = await repo.one(repo.pool, 'SELECT id FROM business_privacy_notices WHERE business_id=$1 LIMIT 1', [business.id]);
  const salon = business.business_type === 'salon' ? await repo.one(repo.pool, 'SELECT deposit_percent FROM salon_settings WHERE business_id=$1', [business.id]) : null;
  const t = await termsOf(business);
  const result = [];
  for (const location of locations) {
    const link = links.find((l) => Number(l.location_id) === Number(location.id)) || null;
    const shown = await engine.offer(repo.pool, business, link || { id: 0, location_id: location.id, allow_any_staff: true }, { all: true });
    result.push({ location: { id: Number(location.id), name: location.name }, link: linkView(link),
      services: shown.services.map((s) => ({ id: s.id, label: s.label, category: s.category, minutes: s.minutes, block: s.block, room: s.room, price: s.price, shown: s.shown })),
      people: shown.people.map((p) => ({ id: p.id, name: p.name, role: p.role, shown: p.shown,
        ...(shown.kind === 'clinic' ? { ready: p.ready, sessions: p.sessions.length, fee: p.fee, registrationNo: p.registrationNo, council: p.council, qualifications: p.qualifications } : {}) })),
      notes: readiness(business, shown, link, privacy, t) });
  }
  return { kind: engine.kindOf(business), type: business.business_type, locations: result, depositPercent: salon ? Number(salon.deposit_percent || 0) : null,
    privacyNotice: Boolean(privacy), canManage: access.can(business, 'online_appointments.manage'), canApprove: access.can(business, 'online_appointments.approve') };
}

async function lockLink(db, business, linkId) {
  const link = await repo.one(db, 'SELECT * FROM business_booking_links WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, v.requiredId(linkId, 'Booking link')]);
  if (!link) fail('Booking link not found', 404);
  access.requireLocation(business, link.location_id);
  return link;
}

// body: { locationId } — the location's booking link, switched on, on its trade's rules.
async function createLink(business, user, body) {
  requireBooking(business);
  await access.require(business, 'online_appointments.manage');
  const locationId = v.requiredId(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  return repo.transaction(async (db) => {
    if (!await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId])) fail('Location not found', 404);
    if (await repo.one(db, 'SELECT 1 FROM business_booking_links WHERE business_id=$1 AND location_id=$2', [business.id, locationId])) fail('This location has its booking link already', 409);
    const d = defaultsFor(business.business_type);
    const link = await repo.one(db, `INSERT INTO business_booking_links(business_id,location_id,token,confirm_mode,days_ahead,min_notice_minutes,slot_step_minutes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [business.id, locationId, newToken(), d.confirm_mode, d.days_ahead, d.min_notice_minutes, d.slot_step_minutes, user.id]);
    await repo.audit(db, business.id, user.id, 'online_booking.link_created', link.id, { locationId, ...d });
    return linkView(link);
  });
}

// body: any of FIELDS; what is left out stays as it is.
async function updateLink(business, user, linkId, body) {
  requireBooking(business);
  await access.require(business, 'online_appointments.manage');
  const changes = {};
  for (const [key, [column, read]] of Object.entries(FIELDS)) if (body[key] !== undefined) changes[column] = read(body[key]);
  if (!Object.keys(changes).length) fail('Nothing to change');
  return repo.transaction(async (db) => {
    const link = await lockLink(db, business, linkId);
    const next = { ...link, ...changes };
    if (next.upi_advance && !next.upi_id) fail('Give the UPI id guests pay the advance to');
    const columns = Object.keys(changes);
    const row = await repo.one(db, `UPDATE business_booking_links SET ${columns.map((c, i) => `${c}=$${i + 3}`).join(',')},updated_by=$${columns.length + 3},updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, link.id, ...columns.map((c) => changes[c]), user.id]);
    const changed = Object.fromEntries(columns.filter((c) => String(link[c]) !== String(changes[c])).map((c) => [c, { from: link[c], to: changes[c] }]));
    await repo.audit(db, business.id, user.id, 'online_booking.settings_updated', link.id, changed);
    return linkView(row);
  });
}

// A new token: the old link and every QR printed with it stop working.
async function replaceToken(business, user, linkId) {
  requireBooking(business);
  await access.require(business, 'online_appointments.manage');
  return repo.transaction(async (db) => {
    const link = await lockLink(db, business, linkId);
    const row = await repo.one(db, 'UPDATE business_booking_links SET token=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, link.id, newToken(), user.id]);
    await repo.audit(db, business.id, user.id, 'online_booking.link_replaced', link.id, {});
    return linkView(row);
  });
}

// body: { services: [{ skuId, shown, minutes? }], people: [{ resourceId, shown }] } — what shows online.
// A salon's services keep the times of Service times; anyone else's need a length to show.
async function setShown(business, user, linkId, body) {
  requireBooking(business);
  await access.require(business, 'online_appointments.manage');
  const services = v.requiredArray(body.services ?? [], 'Services').map((s) => ({
    skuId: v.requiredId(s && s.skuId, 'Service'), shown: v.requiredBoolean(s && s.shown, 'Shown online'),
    minutes: s && s.minutes !== undefined && s.minutes !== null && s.minutes !== '' ? whole(s.minutes, 'Length (minutes)', 5, 480) : null,
  }));
  const people = v.requiredArray(body.people ?? [], 'People').map((p) => ({ resourceId: v.requiredId(p && p.resourceId, 'Person'), shown: v.requiredBoolean(p && p.shown, 'Shown online') }));
  if (services.length > 500 || people.length > 200) fail('Too many at once');
  const salon = business.business_type === 'salon';
  for (const s of services) if (!salon && business.business_type !== 'healthcare' && s.shown && !s.minutes) fail('Give each service shown online its length in minutes');
  return repo.transaction(async (db) => {
    const link = await lockLink(db, business, linkId);
    for (const s of services) {
      const sku = await repo.one(db, `SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND p.kind='service'`, [business.id, s.skuId]);
      if (!sku) fail('Only services are booked online', 404);
      await db.query(`INSERT INTO business_booking_link_services(business_id,link_id,sku_id,shown,minutes,updated_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (link_id,sku_id) DO UPDATE SET shown=EXCLUDED.shown,minutes=EXCLUDED.minutes,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [business.id, link.id, s.skuId, s.shown, salon ? null : s.minutes, user.id]);
    }
    for (const p of people) {
      const person = await repo.one(db, 'SELECT id FROM business_resources WHERE business_id=$1 AND id=$2 AND location_id=$3', [business.id, p.resourceId, link.location_id]);
      if (!person) fail('That person is not at this link\'s location', 404);
      await db.query(`INSERT INTO business_booking_link_people(business_id,link_id,resource_id,shown,updated_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (link_id,resource_id) DO UPDATE SET shown=EXCLUDED.shown,updated_by=EXCLUDED.updated_by,updated_at=now()`, [business.id, link.id, p.resourceId, p.shown, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'online_booking.shown_changed', link.id, { services: services.length, people: people.length });
    return { linkId: Number(link.id), services: services.length, people: people.length };
  });
}

module.exports = { TYPES, requireBooking, overview, createLink, updateLink, replaceToken, setShown, defaultsFor, linkUrl };
