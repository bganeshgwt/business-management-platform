const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./fuelCommon');
const money = require('./fuelMoney');

// A fuel station's alerts on the bell, worked out from live data, on the
// business's own date:
//   stamping     a dispensing unit's or a measure's Weights & Measures stamping
//                falling due within the business's warning days (warning), or
//                fallen due (critical)
//   register     a tank's latest day of the stock register beyond the
//                tolerance: more in the tank than the book (critical: the MDG
//                asks for sampling and stops sales and supplies) or less beyond
//                the allowance (warning: the dealer is asked to explain)
//   density      a load accepted in the last week with its density outside the
//                tolerance (warning)
//   shifts       a shift open for more than 16 hours (warning)
//   dips         a tank in use without today's dip, from 10 am (info)
//   prices       a fuel sold at an outlet with no price set there (warning)
//   credit       a fleet customer owing more than their credit limit (warning)

const OPEN_HOURS = 16;
const DIP_HOUR = 10;

async function bell(business, base, limit) {
  const scope = business.location_scope || null;
  const zone = business.timezone || 'Asia/Kolkata';
  const settings = await c.settingsOf(repo.pool, business.id);
  const warn = Number(settings.stamping_warn_days);
  const nowIso = new Date().toISOString();
  const items = [];
  const dayWords = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n < 0 ? `${-n} days ago` : `in ${n} days`);
  // Weights & Measures stamping of the dispensing units and the measures.
  const stamps = await repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE $3)::date AS d)
    SELECT 'unit' AS kind,d.id,d.unit_no AS name,d.stamping_due::text AS due,(d.stamping_due - today.d) AS days,l.name AS location_name FROM fuel_dispensers d CROSS JOIN today
      JOIN business_locations l ON l.business_id=d.business_id AND l.id=d.location_id
      WHERE d.business_id=$1 AND d.status<>'retired' AND d.stamping_due <= today.d + $2::int AND ($4::bigint IS NULL OR d.location_id=$4)
    UNION ALL SELECT 'measure',m.id,m.name,m.stamping_due::text,(m.stamping_due - today.d),l.name FROM fuel_measures m CROSS JOIN today
      JOIN business_locations l ON l.business_id=m.business_id AND l.id=m.location_id
      WHERE m.business_id=$1 AND m.active AND m.stamping_due <= today.d + $2::int AND ($4::bigint IS NULL OR m.location_id=$4)
    ORDER BY due LIMIT $5`, [business.id, warn, zone, scope, limit]);
  for (const s of stamps) {
    const days = Number(s.days);
    const what = s.kind === 'unit' ? `Dispensing unit ${s.name}` : s.name;
    items.push({ id: `fuel:stamping:${s.kind}:${s.id}:${s.due}:${days < 0 ? 'x' : 'soon'}`, severity: days < 0 ? 'critical' : 'warning', category: 'Fuel',
      title: days < 0 ? `${what}'s stamping fell due ${dayWords(days)}` : `${what}'s stamping falls due ${dayWords(days)}`,
      detail: `Weights & Measures · ${s.location_name} · due ${c.dateWords(s.due)}`, at: `${s.due}T00:00:00.000Z`, link: `${base}/fuel-pumps` });
  }
  // The latest day of each tank's stock register, beyond the tolerance.
  const tanks = await repo.all(repo.pool, `SELECT t.id,t.tank_no,t.location_id,f.family,s.label AS product_name FROM fuel_tanks t
    JOIN fuel_products f ON f.business_id=t.business_id AND f.id=t.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    WHERE t.business_id=$1 AND t.active AND ($2::bigint IS NULL OR t.location_id=$2) ORDER BY t.id LIMIT 50`, [business.id, scope]);
  for (const tank of tanks) {
    const [next, dip] = await repo.all(repo.pool, 'SELECT dip_on::text AS dip_on,taken_at,stock FROM fuel_dips WHERE business_id=$1 AND tank_id=$2 ORDER BY dip_on DESC LIMIT 2', [business.id, tank.id]);
    if (!dip) continue;
    const sums = await repo.one(repo.pool, `SELECT
        COALESCE((SELECT sum(x.invoice_litres) FROM fuel_receipt_lines x JOIN fuel_receipts r ON r.business_id=x.business_id AND r.id=x.receipt_id
          WHERE x.business_id=$1 AND x.tank_id=$2 AND r.status='accepted' AND r.received_at>=$3 AND r.received_at<$4),0) AS receipts,
        COALESCE((SELECT sum(x.litres) FROM fuel_close_readings x JOIN fuel_shift_closes k ON k.business_id=x.business_id AND k.id=x.close_id
          WHERE x.business_id=$1 AND x.tank_id=$2 AND k.reopened_at IS NULL AND k.closed_at>=$3 AND k.closed_at<$4),0) AS sales`, [business.id, tank.id, dip.taken_at, next.taken_at]);
    const f = money.registerFigures({ opening: money.milli(dip.stock), receipts: money.milli(sums.receipts), sales: money.milli(sums.sales), closing: money.milli(next.stock),
      family: tank.family, settings });
    if (f.flag === 'within') continue;
    items.push({ id: `fuel:register:${tank.id}:${dip.dip_on}:${f.flag}`, severity: f.flag === 'gain' ? 'critical' : 'warning', category: 'Fuel',
      title: `Tank ${tank.tank_no} (${tank.product_name}): ${f.flag === 'gain' ? 'more' : 'less'} by the dip than the book, beyond the tolerance`,
      detail: `${c.dateWords(dip.dip_on)}: ${money.litres(Math.abs(f.variation))} litres ${f.flag === 'gain' ? 'over' : 'short'}${f.percent === null ? '' : ` (${money.percentText(f.percent)}%)`}`,
      at: new Date(next.taken_at).toISOString(), link: `${base}/fuel-register` });
  }
  // Loads accepted in the last week outside the density tolerance.
  const loads = await repo.all(repo.pool, `SELECT r.id,r.invoice_no,r.lorry_no,r.received_at,r.density_note FROM fuel_receipts r
    WHERE r.business_id=$1 AND r.status='accepted' AND r.density_approved_by IS NOT NULL AND r.received_at > now() - interval '7 days' AND ($2::bigint IS NULL OR r.location_id=$2)
    ORDER BY r.received_at DESC LIMIT $3`, [business.id, scope, limit]);
  for (const r of loads) {
    items.push({ id: `fuel:density:${r.id}`, severity: 'warning', category: 'Fuel', title: `Load ${r.invoice_no} was accepted outside the density tolerance`,
      detail: `Lorry ${r.lorry_no} · ${r.density_note}`, at: new Date(r.received_at).toISOString(), link: `${base}/fuel-receipts` });
  }
  // Shifts left open.
  const open = await repo.all(repo.pool, `SELECT s.id,s.shift_no,s.attendant_name,s.opened_at FROM fuel_shifts s WHERE s.business_id=$1 AND s.status='open'
      AND s.opened_at < now() - make_interval(hours => $2) AND ($3::bigint IS NULL OR s.location_id=$3) ORDER BY s.opened_at LIMIT $4`, [business.id, OPEN_HOURS, scope, limit]);
  for (const s of open) {
    items.push({ id: `fuel:open:${s.id}`, severity: 'warning', category: 'Fuel', title: `Shift ${s.shift_no} is still open`,
      detail: `${s.attendant_name} · opened ${c.timeWords(s.opened_at, zone)}`, at: new Date(s.opened_at).toISOString(), link: `${base}/fuel-shifts/${s.id}` });
  }
  // Today's dips not taken, from mid-morning.
  const clock = await repo.one(repo.pool, 'SELECT (now() AT TIME ZONE $1)::date::text AS day, extract(hour FROM now() AT TIME ZONE $1)::int AS hour', [zone]);
  if (clock.hour >= DIP_HOUR) {
    const missing = await repo.one(repo.pool, `SELECT count(*)::int AS n FROM fuel_tanks t WHERE t.business_id=$1 AND t.active AND ($3::bigint IS NULL OR t.location_id=$3)
      AND NOT EXISTS (SELECT 1 FROM fuel_dips d WHERE d.business_id=t.business_id AND d.tank_id=t.id AND d.dip_on=$2)`, [business.id, clock.day, scope]);
    if (missing.n) {
      items.push({ id: `fuel:dips:${clock.day}:${missing.n}`, severity: 'info', category: 'Fuel', title: `Today's dip is not taken for ${c.plural(missing.n, 'tank')}`,
        detail: 'The morning dips start the day\'s stock register', at: nowIso, link: `${base}/fuel-dips` });
    }
  }
  // A fuel sold at an outlet with no price there.
  const unpriced = await repo.all(repo.pool, `SELECT DISTINCT l.name AS location_name,s.label FROM fuel_nozzles n JOIN business_locations l ON l.business_id=n.business_id AND l.id=n.location_id
    JOIN fuel_products f ON f.business_id=n.business_id AND f.id=n.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    WHERE n.business_id=$1 AND n.active AND ($2::bigint IS NULL OR n.location_id=$2) AND fuel_price_at(n.business_id,n.location_id,n.product_id,now()) IS NULL LIMIT $3`,
  [business.id, scope, limit]);
  for (const u of unpriced) {
    items.push({ id: `fuel:price:${u.location_name}:${u.label}`, severity: 'warning', category: 'Fuel', title: `${u.label} has no price at ${u.location_name}`,
      detail: 'A shift opens on its nozzles once its price is set', at: nowIso, link: `${base}/fuel-pumps` });
  }
  // Fleet customers over their credit limit (money: for those who see sales).
  if (access.can(business, 'sales.view')) {
    const over = await repo.all(repo.pool, `SELECT * FROM (SELECT ct.id,ct.name,ct.credit_limit,${repo.contactBalanceSql('ct')} AS balance FROM business_contacts ct
      WHERE ct.business_id=$1 AND ct.kind='customer' AND ct.credit_limit IS NOT NULL
        AND EXISTS (SELECT 1 FROM fuel_vehicles v WHERE v.business_id=ct.business_id AND v.contact_id=ct.id AND v.active)) x
      WHERE x.balance > x.credit_limit ORDER BY x.balance - x.credit_limit DESC LIMIT $2`, [business.id, limit]);
    for (const o of over) {
      items.push({ id: `fuel:credit:${o.id}:${o.balance}`, severity: 'warning', category: 'Fuel', title: `${o.name} owes more than their credit limit`,
        detail: `Owes ₹${Number(o.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })} · limit ₹${Number(o.credit_limit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
        at: nowIso, link: `${base}/fuel-fleet` });
    }
  }
  return items;
}

module.exports = { bell };
