const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./fuelCommon');
const money = require('./fuelMoney');
const tanks = require('./fuelTanks.service');

// A fuel station's records and its owner's view (module "fuel"):
//   inspections   each inspection of an outlet (the oil company's officers,
//                 Weights & Measures, PESO, the fire service …): when, by
//                 whom, what was found and what was done. Kept as written and
//                 never erased (the guidelines ask for five years).
//   sales         the daily sales register printed from the shifts closed on a
//                 day: each shift's nozzles with their readings, the test
//                 pumped back and the litres, and each fuel's sales at its
//                 price, on credit, in big fills and to walk-in buyers. It is
//                 the station's own register: the oil companies' formats are
//                 not matched.
//   outlets       every outlet of the business at a glance, for an owner with
//                 several: today's shifts and sales, the stock register's
//                 latest variation by tank, what is owed there and the alerts.

const { fail, id } = c;

// --- Inspections -------------------------------------------------------------------------------

// query: { locationId?, from?, to? } — the inspections, newest first (all outlets the person works at when none is chosen).
async function inspections(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const locationId = c.given(query.locationId) ? id(query.locationId, 'Outlet') : business.location_scope || null;
  if (locationId) access.requireLocation(business, locationId);
  const from = c.given(query.from) ? c.readDate(query.from, 'From date') : null;
  const to = c.given(query.to) ? c.readDate(query.to, 'To date') : null;
  return repo.all(repo.pool, `SELECT i.id,i.location_id,l.name AS location_name,i.inspected_on::text AS inspected_on,i.inspected_by,i.authority,i.findings,i.actions,i.created_at,
      u.name AS created_by_name FROM fuel_inspections i JOIN business_locations l ON l.business_id=i.business_id AND l.id=i.location_id JOIN users u ON u.id=i.created_by
    WHERE i.business_id=$1 AND ($2::bigint IS NULL OR i.location_id=$2) AND ($3::date IS NULL OR i.inspected_on>=$3) AND ($4::date IS NULL OR i.inspected_on<=$4)
    ORDER BY i.inspected_on DESC,i.id DESC LIMIT 500`, [business.id, locationId, from, to]);
}

// body: { locationId, inspectedOn, inspectedBy, authority?, findings, actions? } — an inspection written down, for good.
async function recordInspection(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.edit');
  const inspectedOn = c.readDate(body.inspectedOn, 'Inspected on');
  const inspectedBy = v.requiredString(typeof body.inspectedBy === 'string' ? body.inspectedBy : '', 'Inspected by', 150);
  const authority = c.optionalText(body.authority, 'For', 150);
  const findings = v.requiredString(typeof body.findings === 'string' ? body.findings : '', 'What was found', 2000);
  const actions = c.optionalText(body.actions, 'What was done', 2000);
  const saved = await repo.transaction(async (db) => {
    const location = await c.locationOf(db, business, body.locationId);
    if (inspectedOn > await c.today(db, business)) fail('An inspection is written down once it has happened');
    const row = await repo.one(db, `INSERT INTO fuel_inspections(business_id,location_id,inspected_on,inspected_by,authority,findings,actions,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [business.id, location.id, inspectedOn, inspectedBy, authority, findings, actions, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_inspection.recorded', row.id, { location: location.name, inspectedOn, inspectedBy, authority });
    return row.id;
  });
  return (await inspections(business, {})).find((i) => String(i.id) === String(saved));
}

// --- The daily sales register ------------------------------------------------------------------

// query: { date? (today), locationId? } — the shifts closed on a day at an
// outlet, nozzle by nozzle, and each fuel's sales; money for those who see sales.
async function salesRegister(business, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const db = repo.pool;
  const location = await c.boardOutlet(db, business, query.locationId || query.location);
  const today = await c.today(db, business);
  const date = c.given(query.date) ? c.readDate(query.date, 'Date') : today;
  const sees = c.seesMoney(business);
  const closes = await repo.all(db, `SELECT k.id,k.shift_id,s.shift_no,s.attendant_name,s.opened_at,k.closed_at,k.expected,k.credit,k.walk_in,k.big,k.goods_walk_in,k.goods_credit,k.difference
    FROM fuel_shift_closes k JOIN fuel_shifts s ON s.business_id=k.business_id AND s.id=k.shift_id JOIN businesses b ON b.id=k.business_id
    WHERE k.business_id=$1 AND s.location_id=$2 AND k.reopened_at IS NULL AND (k.closed_at AT TIME ZONE b.timezone)::date=$3 ORDER BY k.closed_at,k.id`, [business.id, location.id, date]);
  const ids = closes.map((x) => x.id);
  const readings = ids.length ? await repo.all(db, `SELECT r.close_id,n.nozzle_no,sk.label AS product_name,sk.unit,t.tank_no,r.opening,r.closing,r.test,r.litres FROM fuel_close_readings r
    JOIN fuel_shift_nozzles n ON n.business_id=r.business_id AND n.shift_id=r.shift_id AND n.nozzle_id=r.nozzle_id
    JOIN fuel_products f ON f.business_id=r.business_id AND f.id=r.product_id JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id
    LEFT JOIN fuel_tanks t ON t.business_id=r.business_id AND t.id=r.tank_id WHERE r.business_id=$1 AND r.close_id=ANY($2::bigint[]) ORDER BY n.nozzle_no`, [business.id, ids]) : [];
  const products = ids.length ? await repo.all(db, `SELECT p.close_id,p.product_id,sk.label AS product_name,sk.unit,f.sort_order,p.price,p.litres,p.credit_litres,p.big_litres,p.walk_in_litres,
      p.credit_amount,p.big_amount,p.walk_in_amount,p.amount FROM fuel_close_products p JOIN fuel_products f ON f.business_id=p.business_id AND f.id=p.product_id
    JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id WHERE p.business_id=$1 AND p.close_id=ANY($2::bigint[]) ORDER BY f.sort_order,sk.label`, [business.id, ids]) : [];
  // Each fuel's day: its litres and money added up over the shifts, to the millilitre and the paisa.
  const fuels = new Map();
  for (const p of products) {
    const f = fuels.get(String(p.product_id)) || { productId: Number(p.product_id), name: p.product_name, unit: p.unit, prices: new Set(), litres: 0, credit: 0, big: 0, walkIn: 0, amount: 0 };
    f.prices.add(p.price);
    f.litres += money.milli(p.litres); f.credit += money.milli(p.credit_litres); f.big += money.milli(p.big_litres); f.walkIn += money.milli(p.walk_in_litres);
    f.amount += money.paise(p.amount);
    fuels.set(String(p.product_id), f);
  }
  const hide = (value) => (sees ? value : null);
  return {
    date, today, location, money: sees, formatsNote: 'The station\'s own register from its shifts: the oil companies\' own formats are not matched.',
    shifts: closes.map((x) => ({ shiftId: x.shift_id, shiftNo: x.shift_no, attendant: x.attendant_name, openedAt: x.opened_at, closedAt: x.closed_at,
      expected: hide(x.expected), difference: hide(x.difference), otherSales: hide(money.rupees(money.paise(x.goods_walk_in) + money.paise(x.goods_credit))),
      nozzles: readings.filter((r) => String(r.close_id) === String(x.id)).map(({ close_id: _c, ...r }) => r) })),
    fuels: [...fuels.values()].map((f) => ({ productId: f.productId, name: f.name, unit: f.unit, prices: sees ? [...f.prices] : [], litres: money.litres(f.litres),
      credit: money.litres(f.credit), big: money.litres(f.big), walkIn: money.litres(f.walkIn), amount: hide(money.rupees(f.amount)) })),
    total: hide(money.rupees([...fuels.values()].reduce((sum, f) => sum + f.amount, 0))),
  };
}

// --- Every outlet at a glance ------------------------------------------------------------------

// query: {} — each outlet the person works at: today's shifts (open, closed,
// litres and sales), its attendants' shorts and excess today, each tank's
// latest day of the stock register, what customers owe on its bills and its
// fleet fills not yet billed, and the bell's alerts there.
async function outlets(business) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const db = repo.pool;
  const sees = c.seesMoney(business);
  const today = await c.today(db, business);
  const settings = await c.settingsOf(db, business.id);
  const locations = await repo.all(db, 'SELECT id,name,code FROM business_locations WHERE business_id=$1 AND active AND ($2::bigint IS NULL OR id=$2) ORDER BY id',
    [business.id, business.location_scope || null]);
  const bell = require('./fuelBell.service');
  const out = [];
  for (const location of locations) {
    const shifts = await repo.one(db, `SELECT
        (SELECT count(*)::int FROM fuel_shifts s WHERE s.business_id=$1 AND s.location_id=$2 AND s.status='open') AS open,
        (SELECT count(*)::int FROM fuel_shift_closes k JOIN fuel_shifts s ON s.business_id=k.business_id AND s.id=k.shift_id
          WHERE k.business_id=$1 AND s.location_id=$2 AND k.reopened_at IS NULL AND (k.closed_at AT TIME ZONE $3)::date=$4) AS closed,
        (SELECT COALESCE(sum(k.expected),0) FROM fuel_shift_closes k JOIN fuel_shifts s ON s.business_id=k.business_id AND s.id=k.shift_id
          WHERE k.business_id=$1 AND s.location_id=$2 AND k.reopened_at IS NULL AND (k.closed_at AT TIME ZONE $3)::date=$4) AS sales,
        (SELECT COALESCE(sum(GREATEST(0,-k.difference)),0) FROM fuel_shift_closes k JOIN fuel_shifts s ON s.business_id=k.business_id AND s.id=k.shift_id
          WHERE k.business_id=$1 AND s.location_id=$2 AND k.reopened_at IS NULL AND (k.closed_at AT TIME ZONE $3)::date=$4) AS short,
        (SELECT COALESCE(sum(GREATEST(0,k.difference)),0) FROM fuel_shift_closes k JOIN fuel_shifts s ON s.business_id=k.business_id AND s.id=k.shift_id
          WHERE k.business_id=$1 AND s.location_id=$2 AND k.reopened_at IS NULL AND (k.closed_at AT TIME ZONE $3)::date=$4) AS excess`,
    [business.id, location.id, business.timezone, today]);
    const litres = await repo.all(db, `SELECT sk.label AS name,sk.unit,sum(p.litres) AS litres FROM fuel_close_products p JOIN fuel_shift_closes k ON k.business_id=p.business_id AND k.id=p.close_id
      JOIN fuel_shifts s ON s.business_id=k.business_id AND s.id=k.shift_id JOIN fuel_products f ON f.business_id=p.business_id AND f.id=p.product_id
      JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id
      WHERE p.business_id=$1 AND s.location_id=$2 AND k.reopened_at IS NULL AND (k.closed_at AT TIME ZONE $3)::date=$4 GROUP BY sk.label,sk.unit,f.sort_order ORDER BY f.sort_order,sk.label`,
    [business.id, location.id, business.timezone, today]);
    // Each tank's latest day of the register that a next morning's dip has closed.
    const tankList = await repo.all(db, `${tanks.TANKS_SQL} AND t.location_id=$2 AND t.active ORDER BY t.sort_order,lower(t.tank_no)`, [business.id, location.id]);
    const stock = [];
    for (const tank of tankList) {
      const last = await repo.all(db, 'SELECT dip_on::text AS day FROM fuel_dips WHERE business_id=$1 AND tank_id=$2 ORDER BY dip_on DESC LIMIT 2', [business.id, tank.id]);
      if (last.length < 2) { stock.push({ tankNo: tank.tank_no, product: tank.product_name, day: null, flag: 'open', variation: null, percent: null }); continue; }
      const row = (await tanks.tankRows(db, business, tank, last[1].day, last[1].day, settings)).find((r) => r.day === last[1].day);
      stock.push({ tankNo: tank.tank_no, product: tank.product_name, day: row?.day || null, flag: row?.flag || 'open', variation: row?.variation ?? null, percent: row?.percent ?? null });
    }
    const dues = sees ? await repo.one(db, `SELECT
        COALESCE((SELECT sum(GREATEST(0, d.total
          -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
          -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
          +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0)))
          FROM business_documents d WHERE d.business_id=$1 AND d.location_id=$2 AND d.kind='sale' AND d.contact_id IS NOT NULL),0) AS customers,
        COALESCE((SELECT sum(k.amount) FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
          JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id WHERE k.business_id=$1 AND s.location_id=$2 AND k.held
            AND NOT EXISTS (SELECT 1 FROM fuel_month_invoice_fills b WHERE b.business_id=k.business_id AND b.slip_id=k.id)),0) AS unbilled,
        COALESCE((SELECT sum(CASE e.kind WHEN 'short' THEN e.amount WHEN 'short_reversed' THEN -e.amount WHEN 'paid' THEN -e.amount WHEN 'deducted' THEN -e.amount ELSE 0 END)
          FROM fuel_attendant_entries e WHERE e.business_id=$1 AND e.location_id=$2),0) AS attendants`, [business.id, location.id]) : null;
    const alerts = await bell.bell({ ...business, location_scope: location.id }, `/business-admin/${business.id}`, 50);
    const count = (severity) => alerts.filter((a) => a.severity === severity).length;
    out.push({
      location, shifts: { open: shifts.open, closed: shifts.closed }, litres,
      sales: sees ? money.rupees(money.paise(shifts.sales)) : null, short: sees ? money.rupees(money.paise(shifts.short)) : null, excess: sees ? money.rupees(money.paise(shifts.excess)) : null,
      stock, beyond: stock.filter((s) => s.flag === 'loss' || s.flag === 'gain').length,
      dues: dues ? { customers: money.rupees(money.paise(dues.customers)), unbilled: money.rupees(money.paise(dues.unbilled)), attendants: money.rupees(money.paise(dues.attendants)) } : null,
      alerts: { critical: count('critical'), warning: count('warning'), info: count('info'), items: alerts.slice(0, 5).map((a) => ({ title: a.title, severity: a.severity, link: a.link })) },
    });
  }
  const sum = (pick) => money.rupees(out.reduce((total, o) => total + money.paise(pick(o) || 0), 0));
  return { today, money: sees, outlets: out, totals: sees ? { sales: sum((o) => o.sales), customers: sum((o) => o.dues.customers), unbilled: sum((o) => o.dues.unbilled),
    attendants: sum((o) => o.dues.attendants) } : null };
}

module.exports = { inspections, recordInspection, salesRegister, outlets };
