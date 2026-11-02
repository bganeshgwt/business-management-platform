const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const receivables = require('./businessReceivables.service');
const rules = require('./salespersonAppRules');
const app = require('./salespersonApp.service');
const registry = require('../../../personal-data/services/personalDataRegistry');

// The office's side of the salesperson app (Sales orders › Field sales):
//
//   report       one day, every salesperson (or one): attendance (the day's
//                start and end), beat adherence (planned shops visited of
//                planned), calls, productive calls and the strike rate, lines
//                per call, order value, collections by mode, cash not yet
//                handed over, new shops, no-order reasons, the first and last
//                check-in, the month's orders against the target, and every
//                visit with its times, distance and a link to its place
//   new shops    shops added in the field, waiting: approved with their credit
//   refusals     orders refused on arrival; a held one let through with a
//                reason by credit control, after which the salesperson's next
//                try with the same request key goes
//   beats        the visit order of a beat's shops; a shop's saved place cleared
//   settings     the check-in distance, and whether places are recorded
//   erasure      a salesperson's recorded places blanked (their personal data)

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);

// --- The day report ----------------------------------------------------------------------------

async function report(business, user, query) {
  await access.require(business, 'salesperson_app.view');
  const date = query.date ? core.dateText(query.date, 'Day') : await app.today(repo.pool, business);
  const only = optionalId(query.salesperson, 'Salesperson');
  const weekday = rules.isoWeekday(date);
  const params = [business.id, date, business.timezone];
  const db = repo.pool;
  const [people, days, planned, visits, orders, collections, refusals, shops, unsettled, month] = await Promise.all([
    repo.all(db, `SELECT s.id,s.name,s.phone,s.monthly_target,s.active,u.name AS user_name FROM wholesale_salespeople s LEFT JOIN users u ON u.id=s.user_id
      WHERE s.business_id=$1 AND ($2::bigint IS NULL OR s.id=$2) ORDER BY s.name`, [business.id, only]),
    repo.all(db, 'SELECT * FROM wholesale_salesperson_days WHERE business_id=$1 AND day=$2', [business.id, date]),
    // The shops on each salesperson's beats for that day of the week (the plan).
    repo.all(db, `SELECT b.salesperson_id,cb.contact_id FROM wholesale_customer_beats cb JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
      JOIN business_contacts c ON c.business_id=cb.business_id AND c.id=cb.contact_id AND c.active
      WHERE cb.business_id=$1 AND b.active AND b.salesperson_id IS NOT NULL AND b.visit_day=$2`, [business.id, weekday]),
    repo.all(db, `SELECT v.*,c.name AS contact_name,b.name AS beat_name FROM wholesale_visits v JOIN business_contacts c ON c.business_id=v.business_id AND c.id=v.contact_id
      LEFT JOIN wholesale_beats b ON b.business_id=v.business_id AND b.id=v.beat_id WHERE v.business_id=$1 AND v.day=$2 ORDER BY v.checked_in_at,v.id`, [business.id, date]),
    repo.all(db, `SELECT f.salesperson_id,f.visit_key,f.phone_total,f.taken_at,f.offline,o.id,o.order_no,o.contact_id,o.contact_name,o.total,o.status,
        (SELECT count(*)::int FROM wholesale_order_lines x WHERE x.business_id=o.business_id AND x.order_id=o.id AND x.free_of_line_id IS NULL) AS lines
      FROM wholesale_field_orders f JOIN wholesale_orders o ON o.business_id=f.business_id AND o.id=f.order_id
      WHERE f.business_id=$1 AND (f.taken_at AT TIME ZONE $3)::date=$2::date AND o.status<>'cancelled'`, params),
    repo.all(db, `SELECT f.salesperson_id,f.visit_key,k.id,k.collection_no,k.contact_id,k.contact_name,k.amount,k.method,k.reference,
        ${receivables.liveSql('k')} AS live FROM wholesale_field_collections f JOIN business_collections k ON k.business_id=f.business_id AND k.id=f.collection_id
      WHERE f.business_id=$1 AND (f.taken_at AT TIME ZONE $3)::date=$2::date`, params),
    // Refused on arrival that day, and every one still open.
    repo.all(db, `SELECT r.*,c.name AS contact_name,s.name AS salesperson_name,u.name AS released_by_name,o.order_no FROM wholesale_field_refusals r
      JOIN business_contacts c ON c.business_id=r.business_id AND c.id=r.contact_id JOIN wholesale_salespeople s ON s.business_id=r.business_id AND s.id=r.salesperson_id
      LEFT JOIN users u ON u.id=r.released_by LEFT JOIN wholesale_orders o ON o.business_id=r.business_id AND o.id=r.order_id
      WHERE r.business_id=$1 AND ((r.last_at AT TIME ZONE $3)::date=$2::date OR (r.first_at AT TIME ZONE $3)::date=$2::date OR r.order_id IS NULL)
      ORDER BY r.order_id IS NULL DESC,r.last_at DESC`, params),
    repo.all(db, `SELECT p.added_by_salesperson_id AS salesperson_id,c.id,c.name,p.approval FROM wholesale_customer_profiles p
      JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id
      WHERE p.business_id=$1 AND p.added_by_salesperson_id IS NOT NULL AND (c.created_at AT TIME ZONE $3)::date=$2::date`, params),
    // Cash each salesperson collected, not yet handed over at the evening settlement.
    repo.all(db, `SELECT wd.salesperson_id,COALESCE(sum(k.amount) FILTER (WHERE (k.created_at AT TIME ZONE $3)::date=$2::date),0) AS today,
        COALESCE(sum(k.amount) FILTER (WHERE (k.created_at AT TIME ZONE $3)::date<$2::date),0) AS earlier
      FROM business_collections k JOIN wholesale_collection_details wd ON wd.business_id=k.business_id AND wd.collection_id=k.id
      WHERE k.business_id=$1 AND k.method='cash' AND (k.created_at AT TIME ZONE $3)::date<=$2::date AND ${receivables.liveSql('k')}
      AND NOT EXISTS (SELECT 1 FROM wholesale_settlement_receipts sr WHERE sr.business_id=k.business_id AND sr.collection_id=k.id)
      GROUP BY wd.salesperson_id`, params),
    // Each salesperson's orders in that day's month, against their monthly target.
    repo.all(db, `SELECT o.salesperson_id,COALESCE(sum(o.total),0) AS ordered,count(*)::int AS orders FROM wholesale_orders o
      WHERE o.business_id=$1 AND o.salesperson_id IS NOT NULL AND o.status<>'cancelled'
      AND date_trunc('month',o.created_at AT TIME ZONE $3)=date_trunc('month',$2::date) AND (o.created_at AT TIME ZONE $3)::date<=$2::date
      GROUP BY o.salesperson_id`, params),
  ]);
  const of = (list, key = 'salesperson_id') => (sid) => list.filter((row) => Number(row[key]) === Number(sid));
  const ordersBy = of(orders), collectionsBy = of(collections), visitsBy = of(visits), plannedBy = of(planned), shopsBy = of(shops);
  const rows = [];
  for (const person of people) {
    const day = days.find((d) => Number(d.salesperson_id) === Number(person.id)) || null;
    const myVisits = visitsBy(person.id), myOrders = ordersBy(person.id), myCollections = collectionsBy(person.id).filter((k) => k.live);
    const myPlanned = new Set(plannedBy(person.id).map((p) => Number(p.contact_id)));
    // Nothing that day and no plan: an inactive salesperson stays off the report.
    if (!day && !myVisits.length && !myOrders.length && !myCollections.length && !myPlanned.size && !person.active) continue;
    const ordersOfVisit = (visit) => myOrders.filter((o) => o.visit_key === visit.request_key);
    const productiveVisits = myVisits.filter((visit) => ordersOfVisit(visit).length > 0);
    const visitedPlanned = new Set(myVisits.map((visit) => Number(visit.contact_id)).filter((cid) => myPlanned.has(cid)));
    const lines = productiveVisits.reduce((sum, visit) => sum + ordersOfVisit(visit).reduce((s, o) => s + o.lines, 0), 0);
    const byMode = { cash: 0, cheque: 0, upi: 0, other: 0 };
    for (const k of myCollections) byMode[byMode[k.method] === undefined ? 'other' : k.method] += paise(k.amount);
    const reasons = {};
    for (const visit of myVisits) if (visit.no_order_reason) reasons[visit.no_order_reason] = (reasons[visit.no_order_reason] || 0) + 1;
    const cash = unsettled.find((u) => Number(u.salesperson_id) === Number(person.id));
    const monthRow = month.find((m) => Number(m.salesperson_id) === Number(person.id));
    const checkIns = myVisits.map((visit) => visit.checked_in_at).sort();
    rows.push({
      id: person.id, name: person.name, phone: person.phone, user_name: person.user_name, active: person.active,
      day: day && { started_at: day.started_at, ended_at: day.ended_at, cash_in_hand: day.cash_in_hand, end_note: day.end_note,
        start_place: day.start_latitude === null ? null : rules.mapsLink(day.start_latitude, day.start_longitude),
        end_place: day.end_latitude === null ? null : rules.mapsLink(day.end_latitude, day.end_longitude), offline: day.start_offline || day.end_offline },
      planned: myPlanned.size, visited_planned: visitedPlanned.size, calls: myVisits.length, productive: productiveVisits.length, lines,
      ...rules.dayFigures({ planned: myPlanned.size, visitedPlanned: visitedPlanned.size, calls: myVisits.length, productive: productiveVisits.length, lines }),
      orders: myOrders.length, order_value: rupees(myOrders.reduce((s, o) => s + paise(o.total), 0)),
      price_differences: myOrders.filter((o) => paise(o.total) !== paise(o.phone_total)).length,
      collections: { cash: rupees(byMode.cash), cheque: rupees(byMode.cheque), upi: rupees(byMode.upi), other: rupees(byMode.other),
        total: rupees(byMode.cash + byMode.cheque + byMode.upi + byMode.other), count: myCollections.length },
      cash_unsettled: { today: cash?.today || '0', earlier: cash?.earlier || '0' },
      new_shops: shopsBy(person.id).length, no_order_reasons: reasons,
      far: myVisits.filter((visit) => visit.far).length, off_beat: myVisits.filter((visit) => visit.off_beat).length,
      first_check_in: checkIns[0] || null, last_check_in: checkIns.at(-1) || null,
      month: { target: person.monthly_target, ordered: monthRow?.ordered || '0', orders: monthRow?.orders || 0 },
      visits: myVisits.map((visit) => {
        const taken = ordersOfVisit(visit);
        const paid = myCollections.filter((k) => k.visit_key === visit.request_key);
        return {
          id: visit.id, contact_id: visit.contact_id, contact_name: visit.contact_name, beat_name: visit.beat_name, checked_in_at: visit.checked_in_at,
          checked_out_at: visit.checked_out_at, outcome: visit.outcome, no_order_reason: visit.no_order_reason, note: visit.note, promised_on: visit.promised_on,
          distance_m: visit.distance_m, accuracy_m: visit.accuracy_m, far: visit.far, far_reason: visit.far_reason, off_beat: visit.off_beat,
          off_beat_reason: visit.off_beat_reason, place_saved: visit.place_saved, offline: visit.offline,
          maps: visit.latitude === null ? null : rules.mapsLink(visit.latitude, visit.longitude),
          orders: taken.map((o) => ({ id: o.id, order_no: o.order_no, total: o.total, phone_total: o.phone_total, lines: o.lines })),
          collected: rupees(paid.reduce((s, k) => s + paise(k.amount), 0)),
        };
      }),
    });
  }
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const totals = {
    salespeople: rows.length, started: rows.filter((r) => r.day).length, ended: rows.filter((r) => r.day?.ended_at).length,
    planned: sum('planned'), visited_planned: sum('visited_planned'), calls: sum('calls'), productive: sum('productive'), lines: sum('lines'),
    ...rules.dayFigures({ planned: sum('planned'), visitedPlanned: sum('visited_planned'), calls: sum('calls'), productive: sum('productive'), lines: sum('lines') }),
    order_value: rupees(rows.reduce((s, r) => s + paise(r.order_value), 0)),
    collections: Object.fromEntries(['cash', 'cheque', 'upi', 'other', 'total'].map((m) => [m, rupees(rows.reduce((s, r) => s + paise(r.collections[m]), 0))])),
    cash_unsettled: rupees(rows.reduce((s, r) => s + paise(r.cash_unsettled.today) + paise(r.cash_unsettled.earlier), 0)),
    new_shops: sum('new_shops'), refused_open: refusals.filter((r) => !r.order_id).length,
  };
  return {
    date, weekday, totals, salespeople: rows,
    refusals: refusals.filter((r) => !only || Number(r.salesperson_id) === only),
    pending_shops: await pendingShops(business, { only }),
    settings: await app.fieldSettings(db, business),
  };
}

// Shops added in the field that wait for the office's approval.
async function pendingShops(business, { only = null } = {}) {
  await access.require(business, 'salesperson_app.view');
  return repo.all(repo.pool, `SELECT c.id,c.name,c.phone,c.gstin,c.address,c.created_at,p.contact_person,p.latitude,p.longitude,s.id AS salesperson_id,s.name AS salesperson_name,
      b.name AS beat_name,${repo.contactBalanceSql('c')} AS balance,
      (SELECT count(*)::int FROM wholesale_orders o WHERE o.business_id=c.business_id AND o.contact_id=c.id AND o.status<>'cancelled') AS orders
    FROM wholesale_customer_profiles p JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id
    JOIN wholesale_salespeople s ON s.business_id=p.business_id AND s.id=p.added_by_salesperson_id
    LEFT JOIN wholesale_customer_beats cb ON cb.business_id=c.business_id AND cb.contact_id=c.id LEFT JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
    WHERE p.business_id=$1 AND p.approval='pending' AND c.active AND ($2::bigint IS NULL OR s.id=$2) ORDER BY c.created_at`, [business.id, only])
    .then((rows) => rows.map((row) => ({ ...row, maps: row.latitude === null ? null : rules.mapsLink(row.latitude, row.longitude) })));
}

// body: { creditLimit, creditDays, priceGroupId? }. The office approves a shop
// added in the field and sets its credit: from then on the usual credit rules
// apply (the limit, the hold), in place of cash only.
async function approveShop(business, user, contactId, body) {
  await access.require(business, 'salesperson_app.approve');
  const limit = body.creditLimit === undefined || body.creditLimit === null || body.creditLimit === '' ? null : core.decimal(body.creditLimit, 'Credit limit', 2, 0, 1000000000);
  if (limit !== null && limit <= 0) fail('Set a credit limit above ₹0, or leave it empty for no limit', 400, { field: 'creditLimit' });
  const days = core.decimal(body.creditDays ?? 0, 'Credit days', 0, 0, 365);
  const groupId = optionalId(body.priceGroupId, 'Price group');
  return repo.transaction(async (db) => {
    const shop = await repo.one(db, `SELECT c.*,p.approval FROM business_contacts c JOIN wholesale_customer_profiles p ON p.business_id=c.business_id AND p.contact_id=c.id
      WHERE c.business_id=$1 AND c.id=$2 FOR UPDATE OF c,p`, [business.id, id(contactId, 'Shop')]);
    if (!shop || !shop.approval) fail('That shop was not added from the field', 404);
    if (shop.approval === 'approved') fail(`${shop.name} is already approved`, 409);
    if (groupId && !(await repo.one(db, 'SELECT id FROM wholesale_price_groups WHERE business_id=$1 AND id=$2 AND active', [business.id, groupId]))) fail('Price group not found', 404);
    await db.query('UPDATE business_contacts SET credit_limit=$3,credit_days=$4,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, shop.id, limit === null ? null : limit.toFixed(2), days]);
    const saved = await repo.one(db, `UPDATE wholesale_customer_profiles SET approval='approved',approved_by=$3,approved_at=now(),updated_by=$3,updated_at=now()
      ${body.priceGroupId !== undefined ? ',price_group_id=$4' : ''} WHERE business_id=$1 AND contact_id=$2 RETURNING *`,
    body.priceGroupId !== undefined ? [business.id, shop.id, user.id, groupId] : [business.id, shop.id, user.id]);
    await repo.audit(db, business.id, user.id, 'shop.approved', shop.id, { shop: shop.name, creditLimit: limit === null ? null : limit.toFixed(2), creditDays: days, priceGroupId: groupId });
    return { contact_id: shop.id, name: shop.name, approval: saved.approval, credit_limit: limit === null ? null : limit.toFixed(2), credit_days: days };
  });
}

// body: { reason }. Credit control lets an order refused for a credit hold
// through: the salesperson's next try with the same request key goes, and the
// release is kept with the order (as the order screen's own release is).
async function releaseRefusal(business, user, refusalId, body) {
  await access.require(business, 'receivables.approve');
  const reason = v.requiredString(body.reason, 'Reason for letting the order through', 300);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `SELECT r.*,c.name AS contact_name FROM wholesale_field_refusals r JOIN business_contacts c ON c.business_id=r.business_id AND c.id=r.contact_id
      WHERE r.business_id=$1 AND r.id=$2 FOR UPDATE OF r`, [business.id, id(refusalId, 'Refused order')]);
    if (!row) fail('Refused order not found', 404);
    if (row.order_id) fail('This order has already gone through', 409);
    if (row.reason !== 'credit_hold') {
      fail(row.reason === 'credit_limit' ? 'An order over the credit limit goes once the limit is raised or the shop pays: raise the limit on the customer, or collect first.'
        : 'A new shop buys for cash only until it is approved: approve it and set its credit, or collect first.', 409, { reason: row.reason });
    }
    if (row.released_at) fail('This order was already let through', 409);
    const saved = await repo.one(db, 'UPDATE wholesale_field_refusals SET released_by=$3,released_at=now(),release_reason=$4,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, row.id, user.id, reason]);
    await repo.audit(db, business.id, user.id, 'field_order.released', row.id, { shop: row.contact_name, reason });
    return { ...saved, contact_name: row.contact_name, released_by_name: user.name };
  });
}

// --- Beats and places -----------------------------------------------------------------------

// A beat's shops in visit order, with the place each has saved.
async function beatShops(business, beatId) {
  await access.require(business, 'sales_orders.view');
  const beat = await repo.one(repo.pool, 'SELECT id,name,visit_day,salesperson_id FROM wholesale_beats WHERE business_id=$1 AND id=$2', [business.id, id(beatId, 'Beat')]);
  if (!beat) fail('Beat not found', 404);
  const shops = await repo.all(repo.pool, `SELECT c.id,c.name,c.address,cb.visit_order,p.latitude,p.longitude,p.place_saved_at,p.place_accuracy_m,u.name AS place_saved_by_name,p.approval
    FROM wholesale_customer_beats cb JOIN business_contacts c ON c.business_id=cb.business_id AND c.id=cb.contact_id
    LEFT JOIN wholesale_customer_profiles p ON p.business_id=c.business_id AND p.contact_id=c.id LEFT JOIN users u ON u.id=p.place_saved_by
    WHERE cb.business_id=$1 AND cb.beat_id=$2 AND c.active ORDER BY cb.visit_order NULLS LAST,c.name`, [business.id, beat.id]);
  return { beat, shops: shops.map((s) => ({ ...s, maps: s.latitude === null ? null : rules.mapsLink(s.latitude, s.longitude) })) };
}

// body: { contactIds: [...] }: the beat's shops in the order they are visited.
async function setVisitOrder(business, user, beatId, body) {
  await access.require(business, 'sales_orders.edit');
  const ids = v.requiredArray(body.contactIds, 'Shops in visit order').map((x) => id(x, 'Shop'));
  if (new Set(ids).size !== ids.length) fail('A shop may appear once');
  const saved = await repo.transaction(async (db) => {
    const beat = await repo.one(db, 'SELECT * FROM wholesale_beats WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(beatId, 'Beat')]);
    if (!beat) fail('Beat not found', 404);
    const on = (await repo.all(db, 'SELECT contact_id FROM wholesale_customer_beats WHERE business_id=$1 AND beat_id=$2', [business.id, beat.id])).map((r) => Number(r.contact_id));
    if (ids.length !== on.length || ids.some((x) => !on.includes(x))) fail('List every shop on the beat once, and only those', 409);
    for (const [index, contactId] of ids.entries()) {
      await db.query('UPDATE wholesale_customer_beats SET visit_order=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND beat_id=$2 AND contact_id=$3',
        [business.id, beat.id, contactId, index + 1, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'beat.visit_order_set', beat.id, { beat: beat.name, shops: ids.length });
    return beat;
  });
  return beatShops(business, saved.id);
}

// The office clears a shop's saved place (it moved, or was saved wrong): the
// next check-in there may save it again.
async function clearPlace(business, user, contactId) {
  await access.require(business, 'salesperson_app.edit');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `SELECT p.*,c.name FROM wholesale_customer_profiles p JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id
      WHERE p.business_id=$1 AND p.contact_id=$2 FOR UPDATE OF p`, [business.id, id(contactId, 'Shop')]);
    if (!row || row.latitude === null) fail('This shop has no saved place', 409);
    await db.query(`UPDATE wholesale_customer_profiles SET latitude=NULL,longitude=NULL,place_accuracy_m=NULL,place_saved_at=NULL,place_saved_by=NULL,updated_by=$3,updated_at=now()
      WHERE business_id=$1 AND contact_id=$2`, [business.id, row.contact_id, user.id]);
    await repo.audit(db, business.id, user.id, 'shop.place_cleared', row.contact_id, { shop: row.name });
    return { contact_id: row.contact_id, cleared: true };
  });
}

// --- Settings ----------------------------------------------------------------------------------

async function settings(business) {
  await access.requireAny(business, ['salesperson_app.view', 'salesperson_app.create', 'salesperson_app.edit']);
  return app.fieldSettings(repo.pool, business);
}
// body: { checkinDistance?, recordPlaces? }: a field left out keeps what is saved.
async function saveSettings(business, user, body) {
  await access.require(business, 'salesperson_app.edit');
  return repo.transaction(async (db) => {
    const current = await app.fieldSettings(db, business);
    const distance = body.checkinDistance === undefined ? current.checkin_distance_m : Number(body.checkinDistance);
    if (!Number.isInteger(distance) || distance < 20 || distance > 1000) fail('The check-in distance is whole metres from 20 to 1,000', 400, { field: 'checkinDistance' });
    const record = body.recordPlaces === undefined ? current.record_places : v.requiredBoolean(body.recordPlaces, 'Record places');
    const row = await repo.one(db, `INSERT INTO wholesale_settings(business_id,checkin_distance_m,record_places,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(business_id) DO UPDATE SET checkin_distance_m=EXCLUDED.checkin_distance_m,record_places=EXCLUDED.record_places,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING checkin_distance_m,record_places`, [business.id, distance, record, user.id]);
    await repo.audit(db, business.id, user.id, 'salesperson_app.settings_updated', business.id, { checkinDistance: distance, recordPlaces: record });
    return row;
  });
}

// --- A salesperson's places, erased ---------------------------------------------------------

// The places a salesperson's phone recorded (their day's start and end, each
// check-in) are their personal data: erased on the business's word (they
// left, or asked), keeping each day and visit with its times, distance and
// outcome as the trade record (personalDataRegistry.js › STAFF_TABLES).
async function erasePlaces(business, user, salespersonId, body = {}) {
  await access.require(business, 'privacy.manage');
  const reason = v.requiredString(body.reason, 'Why the places are erased', 300);
  return repo.transaction(async (db) => {
    const person = await repo.one(db, 'SELECT * FROM wholesale_salespeople WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(salespersonId, 'Salesperson')]);
    if (!person) fail('Salesperson not found', 404);
    const erased = {};
    for (const [table, entry] of Object.entries(registry.STAFF_TABLES)) {
      const columns = Object.keys(entry.erase);
      const sets = columns.map((column, index) => `${column}=$${index + 3}`).join(',');
      const any = columns.map((column) => `${column} IS NOT NULL`).join(' OR ');
      const result = await db.query(`UPDATE ${table} SET ${sets},updated_at=now() WHERE business_id=$1 AND ${entry.person}=$2 AND (${any})`,
        [business.id, person.id, ...columns.map((column) => entry.erase[column])]);
      erased[table] = result.rowCount;
    }
    await repo.audit(db, business.id, user.id, 'salesperson.places_erased', person.id, { salesperson: person.name, reason, erased });
    return { salesperson_id: person.id, erased };
  });
}

// --- The bell ------------------------------------------------------------------------------------

// Orders refused on arrival and still waiting (the last week), and shops from
// the field waiting for approval, for those who see the field's day.
async function bell(business, base, limit) {
  const items = [];
  const refused = await repo.all(repo.pool, `SELECT r.id,r.reason,r.last_at,r.released_at,c.name AS contact_name,s.name AS salesperson_name FROM wholesale_field_refusals r
    JOIN business_contacts c ON c.business_id=r.business_id AND c.id=r.contact_id JOIN wholesale_salespeople s ON s.business_id=r.business_id AND s.id=r.salesperson_id
    WHERE r.business_id=$1 AND r.order_id IS NULL AND r.released_at IS NULL AND r.last_at > now() - interval '7 days' ORDER BY r.last_at DESC LIMIT $2`, [business.id, limit]);
  const why = { credit_hold: 'credit hold', credit_limit: 'over the credit limit', cash_only: 'a new shop, cash only' };
  for (const row of refused) {
    items.push({ id: `field-refused:${row.id}`, severity: 'warning', category: 'Field sales',
      title: `${row.contact_name}'s order from ${row.salesperson_name} was refused`, detail: `On arrival: ${why[row.reason]}`,
      at: new Date(row.last_at).toISOString(), link: `${base}/field-sales` });
  }
  const waiting = await repo.one(repo.pool, `SELECT count(*)::int AS n,min(c.created_at) AS since FROM wholesale_customer_profiles p
    JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id WHERE p.business_id=$1 AND p.approval='pending' AND c.active`, [business.id]);
  if (waiting.n > 0) {
    items.push({ id: `field-shops:${waiting.n}:${new Date(waiting.since).toISOString().slice(0, 10)}`, severity: 'info', category: 'Field sales',
      title: `${waiting.n} ${waiting.n === 1 ? 'shop' : 'shops'} from the field ${waiting.n === 1 ? 'waits' : 'wait'} for approval`,
      detail: 'Cash only until approved with their credit', at: new Date(waiting.since).toISOString(), link: `${base}/field-sales` });
  }
  return items;
}

module.exports = { report, pendingShops, approveShop, releaseRefusal, beatShops, setVisitOrder, clearPlace, settings, saveSettings, erasePlaces, bell };
