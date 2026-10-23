const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const { applyAdjustment, lockLot } = require('../../core/services/businessReturns.service');
const salon = require('./businessSalon.service');
const pins = require('./businessManagerPin');
const refunds = require('./businessAdvanceRefunds');

// Salon & spa back office:
//   week        a weekly schedule per stylist (a day off or other hours per
//               weekday) and salon holidays; bookings outside them are
//               refused unless a manager lets them through (businessSalon).
//   back-bar    the products a service uses (30 ml colour, 10 ml developer);
//               billing the service takes them out of stock (FEFO) and keeps
//               the cost at the product's latest purchase price; the service
//               profitability report shows it.
//   advances    a client's advance or deposit handed back in cash / UPI /
//               bank, or a held deposit moved to their wallet — a reason and
//               a manager's PIN each time; a receipt is printed.
//   slab        monthly target commission plans (10% up to 50,000 of the
//               month's net service sales, 12% above) chosen per stylist
//               instead of the flat rules, and the month's payout statement.
// Money is integer paise; quantities thousandths.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const milli = (value) => Math.round(Number(value) * 1000);
const qty = (m) => (m / 1000).toFixed(3);
const divide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

repo.addLists({
  'salon-holidays': {
    sql: `SELECT h.id,h.business_id,h.location_id,h.day::text AS day,h.name,h.created_at,h.created_by,(h.day::timestamp AT TIME ZONE hb.timezone) AS day_at,
      l.name AS location_name,u.name AS created_by_name,
      (SELECT count(*)::int FROM business_appointments a JOIN businesses b ON b.id=a.business_id JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
        WHERE a.business_id=h.business_id AND a.status='booked' AND (a.starts_at AT TIME ZONE b.timezone)::date=h.day AND (h.location_id IS NULL OR r.location_id=h.location_id)) AS booked
      FROM salon_holidays h JOIN businesses hb ON hb.id=h.business_id JOIN users u ON u.id=h.created_by LEFT JOIN business_locations l ON l.business_id=h.business_id AND l.id=h.location_id
      WHERE h.business_id=$1 AND h.cancelled_at IS NULL`,
    // A salon-wide holiday (no location) is every branch's.
    search: ['name', 'location_name'], date: 'day_at', filters: { location: { any: ['location_id'], orNull: true } }, order: 'day,id',
  },
  'salon-backbar-usage': {
    sql: `SELECT x.*,d.document_no,d.contact_name,s.label AS service_name,loc.name AS location_name,(x.quantity-x.taken) AS short
      FROM salon_backbar_usage x JOIN business_documents d ON d.business_id=x.business_id AND d.id=x.document_id
      JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.service_sku_id JOIN business_locations loc ON loc.business_id=x.business_id AND loc.id=x.location_id
      WHERE x.business_id=$1`,
    search: ['label', 'service_name', 'document_no', 'contact_name'], date: 'created_at', filters: { product: 'product_sku_id', service: 'service_sku_id', location: 'location_id' }, order: 'created_at DESC,id DESC',
  },
  'salon-commission-plans': {
    sql: `SELECT p.*,COALESCE((SELECT json_agg(json_build_object('from_amount',s.from_amount,'percent',s.percent) ORDER BY s.from_amount) FROM salon_commission_slabs s
        WHERE s.business_id=p.business_id AND s.plan_id=p.id),'[]') AS slabs,
      (SELECT count(DISTINCT c.resource_id)::int FROM salon_commission_schemes c WHERE c.business_id=p.business_id AND c.plan_id=p.id) AS stylists
      FROM salon_commission_plans p WHERE p.business_id=$1`,
    search: ['name'], filters: { active: 'active' }, order: 'active DESC,name',
  },
  'salon-advance-refunds': {
    sql: `SELECT f.*,k.collection_no,c.name AS contact_name,c.phone AS contact_phone,a.name AS approved_by_name,u.name AS created_by_name
      FROM business_collection_refunds f JOIN business_collections k ON k.business_id=f.business_id AND k.id=f.collection_id
      JOIN business_contacts c ON c.business_id=f.business_id AND c.id=f.contact_id JOIN users a ON a.id=f.approved_by JOIN users u ON u.id=f.created_by
      WHERE f.business_id=$1 AND f.source='salon'`,
    search: ['refund_no', 'collection_no', 'contact_name', 'contact_phone', 'reason'], date: 'created_at', filters: { contact: 'contact_id' }, order: 'created_at DESC,id DESC',
  },
});

// --- The week and holidays -------------------------------------------------------------------

// body: { days: [{ dow, off, worksFrom?, worksTo? }] } — the weekdays that
// differ from the stylist's usual hours; every weekday left out uses them.
async function saveWeek(business, user, resourceId, body) {
  salon.requireSalon(business);
  await access.require(business, 'appointments.create');
  const list = v.requiredArray(body.days ?? [], 'Week');
  if (list.length > 7) fail('A week has seven days');
  const days = list.map((d) => {
    const dow = Number(d?.dow);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) fail('Weekdays are 0 (Sunday) to 6 (Saturday)');
    const off = v.requiredBoolean(d.off, 'Day off', false);
    const has = (x) => x !== undefined && x !== null && x !== '';
    if (off) return { dow, off, from: null, to: null };
    if (has(d.worksFrom) !== has(d.worksTo)) fail(`${DAYS[dow]}: give both the start and the end, or neither`);
    const from = has(d.worksFrom) ? salon.timeText(d.worksFrom, `${DAYS[dow]} from`) : null;
    const to = has(d.worksTo) ? salon.timeText(d.worksTo, `${DAYS[dow]} till`) : null;
    if (from && to <= from) fail(`${DAYS[dow]}: the hours must end after they start`);
    return { dow, off, from, to };
  });
  if (new Set(days.map((d) => d.dow)).size !== days.length) fail('Each weekday may appear once');
  return repo.transaction(async (db) => {
    const staff = await salon.lockResource(db, business, id(resourceId, 'Stylist'), 'staff', 'Stylist');
    const profile = await repo.one(db, 'SELECT weekly_off FROM salon_resource_profiles WHERE business_id=$1 AND resource_id=$2', [business.id, staff.id]);
    const usualOff = new Set((profile?.weekly_off || []).map(Number));
    const working = [0, 1, 2, 3, 4, 5, 6].filter((dow) => {
      const own = days.find((d) => d.dow === dow);
      return own ? !own.off : !usualOff.has(dow);
    });
    if (!working.length) fail('Leave at least one working day in the week');
    await db.query('DELETE FROM salon_staff_week WHERE business_id=$1 AND resource_id=$2', [business.id, staff.id]);
    for (const d of days) {
      await db.query('INSERT INTO salon_staff_week(business_id,resource_id,dow,off,works_from,works_to,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [business.id, staff.id, d.dow, d.off, d.from, d.to, user.id]);
    }
    // Bookings still to come that the new week no longer covers are listed, not moved.
    const coming = await repo.all(db, `SELECT a.id,a.starts_at,a.ends_at FROM business_appointments a WHERE a.business_id=$1 AND a.resource_id=$2 AND a.status='booked' AND a.starts_at > now()
      ORDER BY a.starts_at LIMIT 200`, [business.id, staff.id]);
    const clashes = [];
    for (const a of coming) {
      const problem = await salon.availabilityProblem(db, business, staff, new Date(a.starts_at), new Date(a.ends_at));
      if (problem) clashes.push({ appointmentId: Number(a.id), startsAt: a.starts_at, problem });
    }
    await repo.audit(db, business.id, user.id, 'salon.staff_week_updated', staff.id, { days });
    return { resourceId: Number(staff.id), days, clashes };
  });
}

// body: { day, name, locationId? (none = every location) }. Bookings that day must be moved first.
async function addHoliday(business, user, body) {
  salon.requireSalon(business);
  await access.require(business, 'settings.edit');
  const day = core.dateText(body.day, 'Date');
  const name = v.requiredString(body.name, 'Holiday', 100);
  const locationId = body.locationId === undefined || body.locationId === null || body.locationId === '' ? null : id(body.locationId, 'Location');
  return repo.transaction(async (db) => {
    if (locationId && !await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId])) fail('Location not found', 404);
    const past = await repo.one(db, 'SELECT $2::date < (now() AT TIME ZONE timezone)::date AS past FROM businesses WHERE id=$1', [business.id, day]);
    if (past.past) fail('That day has already passed');
    const booked = await repo.one(db, `SELECT count(*)::int AS n FROM business_appointments a JOIN businesses b ON b.id=a.business_id
      JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
      WHERE a.business_id=$1 AND a.status='booked' AND (a.starts_at AT TIME ZONE b.timezone)::date=$2::date AND ($3::bigint IS NULL OR r.location_id=$3)`, [business.id, day, locationId]);
    if (booked.n) fail(`${booked.n} booking${booked.n === 1 ? ' is' : 's are'} made for that day. Move ${booked.n === 1 ? 'it' : 'them'} first.`, 409);
    const same = await repo.one(db, `SELECT id FROM salon_holidays WHERE business_id=$1 AND cancelled_at IS NULL AND day=$2 AND COALESCE(location_id,0)=COALESCE($3::bigint,0)`,
      [business.id, day, locationId]);
    if (same) fail('That day is already a holiday', 409);
    const row = await repo.one(db, 'INSERT INTO salon_holidays(business_id,location_id,day,name,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [business.id, locationId, day, name, user.id]);
    await repo.audit(db, business.id, user.id, 'salon.holiday_added', row.id, { day, name, locationId });
    return row;
  });
}
async function cancelHoliday(business, user, holidayId) {
  salon.requireSalon(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, 'UPDATE salon_holidays SET cancelled_at=now(),cancelled_by=$3 WHERE business_id=$1 AND id=$2 AND cancelled_at IS NULL RETURNING *',
      [business.id, id(holidayId, 'Holiday'), user.id]);
    if (!row) fail('Holiday not found', 404);
    await repo.audit(db, business.id, user.id, 'salon.holiday_cancelled', row.id, { day: row.day, name: row.name });
    return row;
  });
}

// --- Back-bar products ---------------------------------------------------------------------------

const PRODUCT_SQL = `SELECT s.id,s.label,s.unit,s.tracking,s.active,p.kind,u.decimals FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.id=$2`;
// The cost of one stock unit: the latest purchase (its cost per stock unit,
// before GST), else the average cost of the stock held, else nothing.
const COST_SQL = (sku) => `COALESCE(
  (SELECT COALESCE(l.stock_unit_cost, l.net/NULLIF(l.quantity,0)) FROM business_document_lines l JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id
    WHERE l.business_id=$1 AND l.sku_id=${sku} AND d.kind='purchase' AND l.quantity>0 ORDER BY d.created_at DESC,l.id DESC LIMIT 1),
  (SELECT sum(x.quantity*x.unit_cost)/NULLIF(sum(x.quantity),0) FROM business_stock_lots x WHERE x.business_id=$1 AND x.sku_id=${sku} AND x.quantity>0),0)`;

async function recipe(business, skuId) {
  salon.requireSalon(business);
  await access.require(business, 'catalog.view');
  const service = await repo.one(repo.pool, `SELECT s.id,s.label,s.price FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.id=$2 AND p.kind='service'`, [business.id, id(skuId, 'Service')]);
  if (!service) fail('Service not found', 404);
  const products = await repo.all(repo.pool, `SELECT r.product_sku_id AS sku_id,s.label,s.unit,s.code,r.quantity,${COST_SQL('r.product_sku_id')} AS unit_cost,
      (SELECT COALESCE(sum(l.quantity),0) FROM business_stock_lots l WHERE l.business_id=r.business_id AND l.sku_id=r.product_sku_id) AS in_stock
    FROM salon_service_products r JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.product_sku_id
    WHERE r.business_id=$1 AND r.service_sku_id=$2 ORDER BY s.label`, [business.id, service.id]);
  for (const p of products) p.cost = rupees(Math.round(Number(p.quantity) * Number(p.unit_cost) * 100));
  return { service, products, cost: rupees(products.reduce((s, p) => s + paise(p.cost), 0)) };
}

// body: { products: [{ skuId, quantity }] } — replaces the service's recipe (empty = none).
async function saveRecipe(business, user, skuId, body) {
  salon.requireSalon(business);
  await access.require(business, 'catalog.edit');
  const list = v.requiredArray(body.products ?? [], 'Products used');
  if (list.length > 20) fail('A service uses at most 20 products');
  const wanted = list.map((p) => ({ skuId: id(p?.skuId, 'Product'), quantity: core.decimal(p?.quantity, 'Quantity used', 3, 0.001, 100000) }));
  if (new Set(wanted.map((p) => p.skuId)).size !== wanted.length) fail('A product may appear once in a recipe');
  await repo.transaction(async (db) => {
    const service = await repo.one(db, `SELECT s.id,s.label FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2 AND p.kind='service' FOR UPDATE OF s`, [business.id, id(skuId, 'Service')]);
    if (!service) fail('Service not found', 404);
    for (const w of wanted) {
      const sku = await repo.one(db, PRODUCT_SQL, [business.id, w.skuId]);
      if (!sku || sku.kind !== 'goods') fail('Choose products kept in stock', 404);
      if (sku.tracking === 'serial') fail(`${sku.label} is serial-numbered; use loose products for the back-bar`);
      if (Number(sku.decimals) === 0 && !Number.isInteger(w.quantity)) fail(`${sku.label} is counted in whole ${sku.unit}; use a product kept in ml or g for part of a pack`);
    }
    await db.query('DELETE FROM salon_service_products WHERE business_id=$1 AND service_sku_id=$2', [business.id, service.id]);
    for (const w of wanted) {
      await db.query('INSERT INTO salon_service_products(business_id,service_sku_id,product_sku_id,quantity,updated_by) VALUES($1,$2,$3,$4,$5)',
        [business.id, service.id, w.skuId, w.quantity, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'salon.recipe_updated', service.id, { service: service.label, products: wanted });
  });
  return recipe(business, skuId);
}

// Called by the bill posting (businessSalonSales.recordSale) for a salon:
// each service line takes its recipe out of the stock at the bill's
// location, oldest use-by first. What is not in the books is kept as short
// and never stops the bill (the product was used). Returned services give
// nothing back: what was used is used.
async function consumeBackbar(db, business, user, saved, lines) {
  if (business.business_type !== 'salon') return;
  const services = lines.filter((l) => !l.preset && l.sku.kind === 'service' && l.id);
  if (!services.length) return;
  const recipes = await repo.all(db, `SELECT r.service_sku_id,r.product_sku_id,r.quantity,s.label,s.unit,${COST_SQL('r.product_sku_id')} AS unit_cost
    FROM salon_service_products r JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.product_sku_id
    WHERE r.business_id=$1 AND r.service_sku_id=ANY($2::bigint[]) ORDER BY r.service_sku_id,r.product_sku_id`, [business.id, services.map((l) => Number(l.sku.id))]);
  if (!recipes.length) return;
  const used = [];
  for (const line of services) {
    for (const r of recipes.filter((x) => Number(x.service_sku_id) === Number(line.sku.id))) {
      const want = Math.round(milli(r.quantity) * Number(line.quantity));
      if (want <= 0) continue;
      const lots = await repo.all(db, `SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND quantity>0
        ORDER BY expires_on NULLS LAST,id`, [business.id, r.product_sku_id, saved.location_id]);
      let left = want;
      for (const [n, row] of lots.entries()) {
        if (left <= 0) break;
        const lot = await lockLot(db, business.id, row.id);
        const take = Math.min(left, milli(lot.quantity));
        if (take <= 0) continue;
        await applyAdjustment(db, business, user, lot, -(take / 1000), `Back-bar: ${line.sku.label} on ${saved.document_no}`.slice(0, 300),
          salon.derivedKey(saved.request_key, `backbar-${line.id}-${r.product_sku_id}-${n}`));
        left -= take;
      }
      const cost = Math.round((want / 1000) * Number(r.unit_cost) * 100);
      await db.query(`INSERT INTO salon_backbar_usage(business_id,document_id,line_id,location_id,service_sku_id,product_sku_id,label,unit,quantity,taken,unit_cost,cost)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [business.id, saved.id, line.id, saved.location_id, line.sku.id, r.product_sku_id, r.label, r.unit,
        qty(want), qty(want - left), Number(r.unit_cost).toFixed(4), rupees(cost)]);
      used.push({ lineId: line.id, productSkuId: Number(r.product_sku_id), quantity: qty(want), short: qty(left), cost: rupees(cost) });
    }
  }
  if (used.length) await repo.event(db, business.id, user.id, 'backbar.used', 'document', saved.id, { documentNo: saved.document_no, used });
}

// Per service in a period (bill dates): how many were done, what they sold
// for (after discounts and returns, before GST), the back-bar products used
// and the stylists' commission on them, and what is left.
async function serviceProfitability(business, query) {
  salon.requireSalon(business);
  await access.require(business, 'reports.view');
  const from = core.dateText(query.from, 'From date'), to = core.dateText(query.to, 'To date');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  const rows = await repo.all(repo.pool, `WITH lines AS (
      SELECT l.id,l.sku_id,l.label,l.quantity,l.net,
        COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0) AS returned_q,
        COALESCE((SELECT sum(rl.net) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0) AS returned_net
      FROM business_document_lines l JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id JOIN businesses b ON b.id=d.business_id
      JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE l.business_id=$1 AND d.kind='sale' AND p.kind='service' AND (d.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date
        AND NOT EXISTS (SELECT 1 FROM salon_plans x WHERE x.business_id=s.business_id AND x.sku_id=s.id)
        AND NOT EXISTS (SELECT 1 FROM salon_settings y WHERE y.business_id=s.business_id AND y.fee_sku_id=s.id))
    SELECT x.sku_id,max(x.label) AS label,sum(x.quantity-x.returned_q) AS done,sum(x.net-x.returned_net) AS sales,
      COALESCE(sum((SELECT sum(u.cost) FROM salon_backbar_usage u WHERE u.business_id=$1 AND u.line_id=x.id)),0) AS product_cost,
      COALESCE(sum((SELECT sum(round(ls.commission_amount*(x.quantity-x.returned_q)/NULLIF(x.quantity,0),2)) FROM salon_line_staff ls WHERE ls.business_id=$1 AND ls.line_id=x.id)),0) AS commission
    FROM lines x GROUP BY x.sku_id ORDER BY sum(x.net-x.returned_net) DESC`, [business.id, from, to]);
  for (const r of rows) {
    const margin = paise(r.sales) - paise(r.product_cost) - paise(r.commission);
    r.margin = rupees(margin);
    r.margin_percent = paise(r.sales) > 0 ? ((margin * 100) / paise(r.sales)).toFixed(1) : null;
    r.product_cost_per_service = Number(r.done) > 0 ? rupees(Math.round(paise(r.product_cost) / Number(r.done))) : '0.00';
  }
  const sum = (key) => rupees(rows.reduce((s, r) => s + paise(r[key]), 0));
  const short = await repo.one(repo.pool, `SELECT count(*)::int AS lines,COALESCE(sum(u.quantity-u.taken),0) AS quantity FROM salon_backbar_usage u JOIN businesses b ON b.id=u.business_id
    WHERE u.business_id=$1 AND u.taken<u.quantity AND (u.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date`, [business.id, from, to]);
  return { from, to, rows, totals: { sales: sum('sales'), productCost: sum('product_cost'), commission: sum('commission'), margin: sum('margin') }, short,
    commissionNote: 'Commission is the per-line amount from the flat rules; stylists on a monthly target plan are settled on the payout statement.' };
}

// --- A client's advance: refund or wallet ---------------------------------------------------------

// body: { collectionId, mode: cash | wallet, amount?, method?, reference?, reason, approverId?, pin?, requestKey }
//  cash    hands back what is left of that receipt (or `amount` of it) by
//          cash, UPI or bank; a numbered refund with a receipt.
//  wallet  a deposit held for a booking still to come stops being held: it
//          becomes the client's advance for any bill (no money moves).
async function advanceRefund(business, user, contactId, body) {
  salon.requireSalon(business);
  await access.require(business, 'sales.edit');
  const mode = v.requiredEnum(body.mode, 'Refund or wallet', ['cash', 'wallet']);
  const collectionId = id(body.collectionId, 'Advance');
  const input = mode === 'cash' ? refunds.readRefund(body) : null;
  const approval = await pins.readApproval(business, user, body, 'sales.refund', { reasonLabel: mode === 'cash' ? 'Reason for the refund' : 'Reason for moving it to the wallet' });
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Client')]);
    if (!contact) fail('Client not found', 404);
    if (mode === 'cash') {
      const result = await refunds.refundCollection(db, business, user, { collectionId, contactId: contact.id, input, approval, source: 'salon', label: contact.name });
      return { mode, ...result };
    }
    const held = await repo.one(db, `SELECT k.id,k.collection_no,${salon.freeSql('k')} AS free,sd.appointment_id,a.starts_at,s.label AS service_name
      FROM business_collections k JOIN salon_appointment_details sd ON sd.business_id=k.business_id AND sd.deposit_collection_id=k.id
      JOIN business_appointments a ON a.business_id=sd.business_id AND a.id=sd.appointment_id JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
      WHERE k.business_id=$1 AND k.id=$2 AND k.contact_id=$3 FOR UPDATE OF k`, [business.id, collectionId, contact.id]);
    if (!held) fail('That is not a deposit for one of this client\'s bookings', 404);
    if (await repo.one(db, 'SELECT 1 FROM salon_deposit_releases WHERE business_id=$1 AND collection_id=$2', [business.id, held.id])) {
      return { mode, release: { collectionId: Number(held.id), collectionNo: held.collection_no }, repeated: true };
    }
    const still = await repo.one(db, `SELECT ${salon.notHeldSql('k', "'{}'")} AS free_now FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, held.id]);
    if (still.free_now) fail(`${held.collection_no} is already the client's advance: the booking is over or cancelled. Use it on a bill, or refund it.`, 409);
    if (paise(held.free) <= 0) fail(`Nothing is left of ${held.collection_no}`, 409);
    await db.query('INSERT INTO salon_deposit_releases(business_id,collection_id,appointment_id,reason,approved_by,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [business.id, held.id, held.appointment_id, approval.reason, approval.approver.id, user.id]);
    await repo.audit(db, business.id, approval.approver.id, 'deposit.moved_to_wallet', held.id, {
      collectionNo: held.collection_no, amount: rupees(paise(held.free)), appointmentId: held.appointment_id, reason: approval.reason, requestedBy: user.id });
    await repo.event(db, business.id, user.id, 'deposit.moved_to_wallet', 'collection', held.id, { contactId: contact.id, appointmentId: held.appointment_id, amount: rupees(paise(held.free)) });
    return { mode, release: { collectionId: Number(held.id), collectionNo: held.collection_no, amount: rupees(paise(held.free)), appointmentId: Number(held.appointment_id),
      approvedBy: approval.approver.name, reason: approval.reason } };
  });
}

// --- Monthly target (slab) commission ----------------------------------------------------------------

function readSlabs(body) {
  const list = v.requiredArray(body.slabs, 'Slabs');
  if (!list.length || list.length > 10) fail('A plan has between 1 and 10 slabs');
  const slabs = list.map((s, n) => ({ from: paise(core.decimal(s?.fromAmount ?? (n === 0 ? 0 : undefined), `Slab ${n + 1}: from`, 2, 0, 100000000)),
    percent: core.decimal(s?.percent, `Slab ${n + 1}: commission %`, 2, 0, 100) })).sort((a, b) => a.from - b.from);
  if (slabs[0].from !== 0) fail('The first slab starts at 0');
  if (new Set(slabs.map((s) => s.from)).size !== slabs.length) fail('Two slabs start at the same amount');
  return slabs;
}
// body: { name, mode: stepped | whole, slabs: [{ fromAmount, percent }] }. The
// slabs are fixed once saved (a new plan for new rates, chosen from a month).
async function createCommissionPlan(business, user, body) {
  salon.requireSalon(business);
  await access.require(business, 'commissions.edit');
  const name = v.requiredString(body.name, 'Plan name', 100);
  const mode = v.requiredEnum(body.mode ?? 'stepped', 'How the slabs pay', ['stepped', 'whole']);
  const slabs = readSlabs(body);
  return repo.transaction(async (db) => {
    if (await repo.one(db, 'SELECT 1 FROM salon_commission_plans WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, name])) fail('A plan with that name exists', 409);
    const plan = await repo.one(db, 'INSERT INTO salon_commission_plans(business_id,name,mode,created_by,updated_by) VALUES($1,$2,$3,$4,$4) RETURNING *', [business.id, name, mode, user.id]);
    for (const s of slabs) await db.query('INSERT INTO salon_commission_slabs(business_id,plan_id,from_amount,percent) VALUES($1,$2,$3,$4)', [business.id, plan.id, rupees(s.from), s.percent]);
    await repo.audit(db, business.id, user.id, 'commission_plan.created', plan.id, { name, mode, slabs: slabs.map((s) => ({ from: rupees(s.from), percent: s.percent })) });
    return { ...plan, slabs: slabs.map((s) => ({ from_amount: rupees(s.from), percent: s.percent })) };
  });
}
// body: { name?, active? } — rates never change; make a new plan instead.
async function updateCommissionPlan(business, user, planId, body) {
  salon.requireSalon(business);
  await access.require(business, 'commissions.edit');
  if (body.slabs !== undefined || body.mode !== undefined) fail('A plan\'s slabs are fixed once saved, so past months stay as they were paid. Make a new plan and choose it from next month.', 409);
  return repo.transaction(async (db) => {
    const plan = await repo.one(db, 'SELECT * FROM salon_commission_plans WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(planId, 'Plan')]);
    if (!plan) fail('Plan not found', 404);
    const name = body.name === undefined ? plan.name : v.requiredString(body.name, 'Plan name', 100);
    const active = v.requiredBoolean(body.active, 'Active', plan.active);
    const row = await repo.one(db, 'UPDATE salon_commission_plans SET name=$3,active=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, plan.id, name, active, user.id]);
    await repo.audit(db, business.id, user.id, 'commission_plan.updated', plan.id, { name, active });
    return row;
  });
}

const monthText = (value, name = 'Month') => {
  const text = String(value ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) fail(`${name} must look like 2026-10`);
  return `${text}-01`;
};
// body: { planId (null = flat rules), fromMonth: 'YYYY-MM' } — from the current month on.
async function setScheme(business, user, resourceId, body) {
  salon.requireSalon(business);
  await access.require(business, 'commissions.edit');
  const fromMonth = monthText(body.fromMonth, 'From month');
  const planId = body.planId === undefined || body.planId === null || body.planId === '' ? null : id(body.planId, 'Plan');
  return repo.transaction(async (db) => {
    const staff = await salon.lockResource(db, business, id(resourceId, 'Stylist'), 'staff', 'Stylist');
    const now = await repo.one(db, "SELECT to_char(date_trunc('month', now() AT TIME ZONE timezone),'YYYY-MM-DD') AS month FROM businesses WHERE id=$1", [business.id]);
    if (fromMonth < now.month) fail('Choose this month or a later one; months already worked keep their plan');
    let plan = null;
    if (planId) {
      plan = await repo.one(db, 'SELECT * FROM salon_commission_plans WHERE business_id=$1 AND id=$2', [business.id, planId]);
      if (!plan) fail('Plan not found', 404);
      if (!plan.active) fail(`${plan.name} is switched off`, 409);
    }
    const row = await repo.one(db, `INSERT INTO salon_commission_schemes(business_id,resource_id,plan_id,from_month,created_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(business_id,resource_id,from_month) DO UPDATE SET plan_id=EXCLUDED.plan_id,created_by=EXCLUDED.created_by,created_at=now() RETURNING *`,
    [business.id, staff.id, plan?.id || null, fromMonth, user.id]);
    await repo.audit(db, business.id, user.id, 'commission_scheme.set', staff.id, { staff: staff.name, plan: plan?.name || 'flat rules', fromMonth });
    return { ...row, plan_name: plan?.name || null, resource_name: staff.name };
  });
}

// Every stylist's plan now and later (the latest choice per month).
async function schemes(business) {
  salon.requireSalon(business);
  await access.require(business, 'commissions.view');
  return repo.all(repo.pool, `SELECT r.id AS resource_id,r.name,r.role_label,
      cur.plan_id,cp.name AS plan_name,cur.from_month,
      (SELECT json_agg(json_build_object('from_month',n.from_month,'plan_id',n.plan_id,'plan_name',np.name) ORDER BY n.from_month) FROM salon_commission_schemes n
        LEFT JOIN salon_commission_plans np ON np.business_id=n.business_id AND np.id=n.plan_id
        WHERE n.business_id=r.business_id AND n.resource_id=r.id AND n.from_month > date_trunc('month', now() AT TIME ZONE b.timezone)::date) AS later
    FROM business_resources r JOIN businesses b ON b.id=r.business_id LEFT JOIN salon_resource_profiles p ON p.business_id=r.business_id AND p.resource_id=r.id
    LEFT JOIN LATERAL (SELECT c.* FROM salon_commission_schemes c WHERE c.business_id=r.business_id AND c.resource_id=r.id
      AND c.from_month <= date_trunc('month', now() AT TIME ZONE b.timezone)::date ORDER BY c.from_month DESC LIMIT 1) cur ON true
    LEFT JOIN salon_commission_plans cp ON cp.business_id=r.business_id AND cp.id=cur.plan_id
    WHERE r.business_id=$1 AND r.active AND COALESCE(p.kind,'staff')='staff' ORDER BY r.name`, [business.id]);
}

// The slab commission on a month's sales (paise), with each band's share.
function slabCommission(plan, slabs, salesPaise) {
  const sorted = [...slabs].map((s) => ({ from: paise(s.from_amount), percent: Number(s.percent) })).sort((a, b) => a.from - b.from);
  const pct = (amount, percent) => divide(BigInt(amount) * BigInt(paise(percent)), 10000n);
  const bands = [];
  if (plan.mode === 'whole') {
    const reached = [...sorted].reverse().find((s) => salesPaise >= s.from) || sorted[0];
    sorted.forEach((s, n) => {
      const to = sorted[n + 1]?.from ?? null;
      const here = s === reached;
      bands.push({ from: rupees(s.from), to: to === null ? null : rupees(to), percent: s.percent, base: here ? rupees(salesPaise) : '0.00', amount: here ? rupees(pct(salesPaise, s.percent)) : '0.00', reached: here });
    });
    return { amount: pct(salesPaise, reached.percent), bands };
  }
  let total = 0;
  sorted.forEach((s, n) => {
    const to = sorted[n + 1]?.from ?? null;
    const base = Math.max(0, Math.min(salesPaise, to === null ? salesPaise : to) - s.from);
    const amount = pct(base, s.percent);
    total += amount;
    bands.push({ from: rupees(s.from), to: to === null ? null : rupees(to), percent: s.percent, base: rupees(base), amount: rupees(amount), reached: salesPaise > s.from || (n === 0) });
  });
  return { amount: total, bands };
}

// The months of a date range ('YYYY-MM-01').
function monthsOf(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
const monthEnd = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// For businessSalon.commissionReport: per stylist on a slab plan, the slab
// commission that belongs to the range (a month's slab is worked out on the
// whole month's net service sales — after discounts and returns, before GST
// — and shared over the range by its part of those sales), and the flat-rule
// commission on their service lines it replaces.
async function slabAdjustments(db, business, from, to) {
  const months = monthsOf(from, to);
  const schemesRows = await repo.all(db, `SELECT c.resource_id,c.plan_id,c.from_month::text AS from_month FROM salon_commission_schemes c WHERE c.business_id=$1 AND c.from_month <= $2::date
    ORDER BY c.resource_id,c.from_month`, [business.id, months[months.length - 1]]);
  if (!schemesRows.some((s) => s.plan_id)) return new Map();
  const planIds = [...new Set(schemesRows.filter((s) => s.plan_id).map((s) => Number(s.plan_id)))];
  const plans = await repo.all(db, `SELECT p.*,COALESCE((SELECT json_agg(json_build_object('from_amount',s.from_amount,'percent',s.percent)) FROM salon_commission_slabs s
    WHERE s.business_id=p.business_id AND s.plan_id=p.id),'[]') AS slabs FROM salon_commission_plans p WHERE p.business_id=$1 AND p.id=ANY($2::bigint[])`, [business.id, planIds]);
  const planOf = new Map(plans.map((p) => [Number(p.id), p]));
  const schemeFor = (resourceId, month) => {
    const mine = schemesRows.filter((s) => Number(s.resource_id) === Number(resourceId) && String(s.from_month).slice(0, 10) <= month);
    const last = mine[mine.length - 1];
    return last?.plan_id ? planOf.get(Number(last.plan_id)) : null;
  };
  const slabStaff = [...new Set(schemesRows.filter((s) => s.plan_id).map((s) => Number(s.resource_id)))];
  const sales = await repo.all(db, `SELECT ls.resource_id,to_char(date_trunc('month', d.created_at AT TIME ZONE b.timezone),'YYYY-MM-DD') AS month,
      COALESCE(sum(l.net - COALESCE((SELECT sum(rl.net) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0)),0) AS month_sales,
      COALESCE(sum(l.net - COALESCE((SELECT sum(rl.net) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0))
        FILTER (WHERE (d.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date),0) AS range_sales,
      COALESCE(sum(round(ls.commission_amount*(l.quantity-COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0))/l.quantity,2))
        FILTER (WHERE (d.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date),0) AS range_rule
    FROM salon_line_staff ls JOIN business_document_lines l ON l.business_id=ls.business_id AND l.id=ls.line_id
    JOIN business_documents d ON d.business_id=ls.business_id AND d.id=ls.document_id JOIN businesses b ON b.id=d.business_id
    WHERE ls.business_id=$1 AND ls.item_kind='service' AND ls.resource_id=ANY($6::bigint[])
      AND (d.created_at AT TIME ZONE b.timezone)::date BETWEEN $4::date AND $5::date GROUP BY 1,2`,
  [business.id, from, to, months[0], monthEnd(months[months.length - 1]), slabStaff]);
  const out = new Map();
  for (const resourceId of slabStaff) {
    const entry = { slab: 0, replaced: 0, months: [] };
    for (const month of months) {
      const plan = schemeFor(resourceId, month);
      if (!plan) continue;
      const row = sales.find((s) => Number(s.resource_id) === resourceId && s.month === month) || { month_sales: 0, range_sales: 0, range_rule: 0 };
      const monthSales = paise(row.month_sales), rangeSales = paise(row.range_sales);
      const { amount } = slabCommission(plan, plan.slabs, monthSales);
      const share = monthSales > 0 ? divide(BigInt(amount) * BigInt(Math.max(0, rangeSales)), BigInt(monthSales)) : 0;
      entry.slab += share;
      entry.replaced += paise(row.range_rule);
      entry.months.push({ month: month.slice(0, 7), plan: plan.name, monthSales: rupees(monthSales), slab: rupees(amount), inRange: rupees(share) });
    }
    if (entry.months.length) out.set(resourceId, entry);
  }
  return out;
}

// The month's payout statement for one stylist: plan and bands, net service
// sales, slab (or flat) commission on services, other commission (products,
// packages sold, package sessions), tips, paid, due.
async function statement(business, query) {
  salon.requireSalon(business);
  await access.require(business, 'commissions.view');
  const month = monthText(query.month);
  const resourceId = id(query.staff, 'Stylist');
  const from = month, to = monthEnd(month);
  const report = await salon.commissionReport(business, { from, to });
  const staff = await repo.one(repo.pool, 'SELECT id,name,role_label FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, resourceId]);
  if (!staff) fail('Stylist not found', 404);
  const row = report.rows.find((r) => Number(r.resource_id) === resourceId) || { commission: '0.00', tips: '0.00', paid: '0.00', due: '0.00', service_sales: '0.00' };
  const scheme = await repo.one(repo.pool, `SELECT c.plan_id FROM salon_commission_schemes c WHERE c.business_id=$1 AND c.resource_id=$2 AND c.from_month <= $3::date
    ORDER BY c.from_month DESC LIMIT 1`, [business.id, resourceId, month]);
  let plan = null, bands = [];
  const kinds = await repo.all(repo.pool, `SELECT ls.item_kind,count(*)::int AS lines,
      COALESCE(sum(l.net - COALESCE((SELECT sum(rl.net) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0)),0) AS value,
      COALESCE(sum(round(ls.commission_amount*(l.quantity-COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0))/l.quantity,2)),0) AS commission
    FROM salon_line_staff ls JOIN business_document_lines l ON l.business_id=ls.business_id AND l.id=ls.line_id
    JOIN business_documents d ON d.business_id=ls.business_id AND d.id=ls.document_id JOIN businesses b ON b.id=d.business_id
    WHERE ls.business_id=$1 AND ls.resource_id=$2 AND (d.created_at AT TIME ZONE b.timezone)::date BETWEEN $3::date AND $4::date GROUP BY ls.item_kind`, [business.id, resourceId, from, to]);
  const service = kinds.find((k) => k.item_kind === 'service') || { value: '0.00', commission: '0.00', lines: 0 };
  let serviceCommission = paise(service.commission);
  if (scheme?.plan_id) {
    plan = await repo.one(repo.pool, `SELECT p.*,COALESCE((SELECT json_agg(json_build_object('from_amount',s.from_amount,'percent',s.percent) ORDER BY s.from_amount) FROM salon_commission_slabs s
      WHERE s.business_id=p.business_id AND s.plan_id=p.id),'[]') AS slabs FROM salon_commission_plans p WHERE p.business_id=$1 AND p.id=$2`, [business.id, scheme.plan_id]);
    const worked = slabCommission(plan, plan.slabs, paise(service.value));
    bands = worked.bands;
    serviceCommission = worked.amount;
  }
  const others = kinds.filter((k) => k.item_kind !== 'service').map((k) => ({ kind: k.item_kind, lines: k.lines, value: k.value, commission: k.commission }));
  return {
    month: month.slice(0, 7), from, to, staff, scheme: plan ? { planId: Number(plan.id), name: plan.name, mode: plan.mode, slabs: plan.slabs } : { planId: null, name: 'Flat rules' },
    serviceSales: rupees(paise(service.value)), serviceLines: service.lines, serviceCommission: rupees(serviceCommission), bands, others,
    commission: row.commission, tips: row.tips, paid: row.paid, due: row.due,
  };
}

module.exports = {
  saveWeek, addHoliday, cancelHoliday, recipe, saveRecipe, consumeBackbar, serviceProfitability, advanceRefund,
  createCommissionPlan, updateCommissionPlan, setScheme, schemes, statement, slabAdjustments,
};
