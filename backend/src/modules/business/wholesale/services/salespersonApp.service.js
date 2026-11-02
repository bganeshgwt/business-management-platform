const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const wholesale = require('./businessWholesale.service');
const receivables = require('./businessReceivables.service');
const credit = require('./businessWholesaleCredit.service');
const rules = require('./salespersonAppRules');
const { normaliseMobile } = require('../../../../utils/phone');
const { readGstin } = require('../../../../utils/gstin');

// The salesperson app (the staff app's /sales): a wholesaler's field
// salesperson's day, on their phone, online or with no network.
//
//   me          who the login is here: their salesperson, or (the office)
//               every salesperson whose day they may open, read-only
//   pack        what the phone keeps to work the day offline: the
//               salesperson's beats and shops in visit order with what each
//               owes, how late, its hold, credit and open bills, the last
//               order (to repeat it), the catalogue with the depot's stock,
//               the prices that apply to these shops (their own, their price
//               group's, the slabs), the schemes, and the settings
//   day         what reached the server of one day: the day's start and end,
//               visits, orders, collections, refused orders and new shops
//   writes      start and end the day; check in at a shop and check out with
//               the outcome; an order and a collection through the wholesale
//               module's own services; a new shop for the office to approve
//
// Every write is tied on the server to the login's own salesperson
// (wholesale_salespeople.user_id) and carries a request key, so a phone that
// sends it again after a dropped connection makes it once. The phone may make
// them with no network and send them later, in order: a visit names its shop
// by id, or a shop added on the phone by that shop's request key; an order or
// a collection names its visit by the visit's request key, so whichever
// reaches the server first, they are linked. Places are kept only between
// the start and the end of the salesperson's day.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const optionalKey = (value, name) => (value === undefined || value === null || value === '' ? null : core.uuid(value, name));
const flag = (value) => value === true;

// --- Who is asking -----------------------------------------------------------------------------

// The login's own salesperson in this business, or a refusal saying how to
// get linked.
async function ownSalesperson(db, business, user) {
  const row = await repo.one(db, 'SELECT * FROM wholesale_salespeople WHERE business_id=$1 AND user_id=$2', [business.id, user.id]);
  if (!row) fail('Your login is not linked to a salesperson in this business. The office links it under Sales orders › Routes & salespeople.', 403, { reason: 'not_a_salesperson' });
  if (!row.active) fail(`${row.name} is switched off as a salesperson here. Ask the office.`, 403, { reason: 'salesperson_inactive' });
  return row;
}

// Whose day a read is about: the salesperson asked for (the office, with
// salesperson_app.view), else the login's own.
async function whose(business, user, query) {
  const asked = optionalId(query?.salesperson, 'Salesperson');
  const mine = await repo.one(repo.pool, 'SELECT * FROM wholesale_salespeople WHERE business_id=$1 AND user_id=$2', [business.id, user.id]);
  if (!asked || (mine && Number(mine.id) === asked)) {
    await access.require(business, 'salesperson_app.create');
    return ownSalesperson(repo.pool, business, user);
  }
  await access.require(business, 'salesperson_app.view');
  const row = await repo.one(repo.pool, 'SELECT * FROM wholesale_salespeople WHERE business_id=$1 AND id=$2', [business.id, asked]);
  if (!row) fail('Salesperson not found', 404);
  return row;
}

const today = async (db, business) => (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
const dayOf = async (db, business, at) => (await repo.one(db, 'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day', [at, business.timezone])).day;

// The app's settings (Sales orders › Field sales, its Settings button): 100 m
// and places recorded unless changed.
async function fieldSettings(db, business) {
  const row = await repo.one(db, 'SELECT * FROM wholesale_settings WHERE business_id=$1', [business.id]);
  return {
    checkin_distance_m: row?.checkin_distance_m ?? 100,
    record_places: row ? row.record_places : true,
    hold_overdue_days: row?.hold_overdue_days ?? null,
    bounce_hold_count: row ? row.bounce_hold_count : 2,
    bounce_hold_days: row?.bounce_hold_days ?? 90,
  };
}

// When the phone says something happened: never more than ten minutes ahead
// of the server's clock (a phone's clock drifts), never more than 14 days ago.
function readMoment(value, name) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  const at = new Date(String(value));
  if (Number.isNaN(at.getTime())) fail(`${name} is not a time`);
  const now = Date.now();
  if (at.getTime() > now + 10 * 60000) fail(`${name} is in the future: check the phone's clock`);
  if (at.getTime() < now - 14 * 86400000) fail(`${name} is more than 14 days ago`);
  return at.toISOString();
}

// The shop a write is about: an existing customer by id, or a shop added on
// the phone by that shop's request key (newShopKey).
async function readShop(db, business, body, lock = false) {
  const contactId = optionalId(body.contactId, 'Shop');
  const shopKey = optionalKey(body.newShopKey, 'New shop');
  if (!contactId && !shopKey) fail('Say which shop', 400);
  const row = contactId
    ? await repo.one(db, `SELECT c.* FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2 AND c.kind='customer' ${lock ? 'FOR UPDATE' : ''}`, [business.id, contactId])
    : await repo.one(db, `SELECT c.* FROM wholesale_customer_profiles p JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id
        WHERE p.business_id=$1 AND p.field_request_key=$2 ${lock ? 'FOR UPDATE OF c' : ''}`, [business.id, shopKey]);
  if (!row) fail(contactId ? 'Shop not found' : 'That new shop has not reached the office yet', 404, { reason: contactId ? 'shop_not_found' : 'new_shop_not_here' });
  if (!row.active || row.erased_at) fail(`${row.erased_at ? 'This shop\'s record was erased' : `${row.name} is switched off`}: orders and visits are no longer taken for it`, 409, { reason: 'shop_inactive' });
  return row;
}

// The customer's beat, and whether it is this salesperson's beat for that day.
async function shopBeat(db, business, contactId, salespersonId, day) {
  const beat = await repo.one(db, `SELECT b.*,r.location_id AS depot_id,r.active AS route_active FROM wholesale_customer_beats cb
    JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id JOIN wholesale_routes r ON r.business_id=b.business_id AND r.id=b.route_id
    WHERE cb.business_id=$1 AND cb.contact_id=$2`, [business.id, contactId]);
  const weekday = rules.isoWeekday(day);
  const onBeat = Boolean(beat && beat.active && Number(beat.salesperson_id) === Number(salespersonId) && (beat.visit_day === null || Number(beat.visit_day) === weekday));
  return { beat: beat || null, onBeat };
}

// The day row a place may be kept under: started by then and not yet ended.
async function openDayAt(db, business, salespersonId, day, at) {
  const row = await repo.one(db, 'SELECT * FROM wholesale_salesperson_days WHERE business_id=$1 AND salesperson_id=$2 AND day=$3', [business.id, salespersonId, day]);
  if (!row) return null;
  const t = Date.parse(at);
  return Date.parse(row.started_at) <= t && (!row.ended_at || t <= Date.parse(row.ended_at)) ? row : null;
}

// --- Reads: me, the pack, one day ------------------------------------------------------------

async function me(business, user) {
  const work = access.can(business, 'salesperson_app.create');
  const watch = access.can(business, 'salesperson_app.view');
  if (!work && !watch) await access.require(business, 'salesperson_app.create');
  const mine = await repo.one(repo.pool, 'SELECT id,name,phone,active,monthly_target FROM wholesale_salespeople WHERE business_id=$1 AND user_id=$2', [business.id, user.id]);
  const day = await today(repo.pool, business);
  const salespeople = watch ? await repo.all(repo.pool, `SELECT s.id,s.name,s.phone,u.name AS user_name,
      (SELECT count(*)::int FROM wholesale_beats b WHERE b.business_id=s.business_id AND b.salesperson_id=s.id AND b.active) AS beats
      FROM wholesale_salespeople s LEFT JOIN users u ON u.id=s.user_id WHERE s.business_id=$1 AND s.active ORDER BY s.name`, [business.id]) : [];
  return {
    salesperson: mine?.active ? mine : null, inactive: mine && !mine.active ? mine.name : null,
    can_work: work && Boolean(mine?.active), can_watch: watch, salespeople,
    settings: await fieldSettings(repo.pool, business), today: day, weekday: rules.isoWeekday(day),
  };
}

// Customers' field details, for the given ids: what the pack and a looked-up
// shop carry. `settings`: fieldSettings; `day`: the business's today.
async function shopsOf(db, business, ids, settings, day) {
  if (!ids.length) return [];
  const params = [business.id, ids, business.timezone, day];
  const [rows, open, bills, bounces, last] = await Promise.all([
    repo.all(db, `SELECT c.id,c.name,c.phone,c.address,c.gstin,c.credit_limit,c.credit_days,cb.beat_id,cb.visit_order,
        COALESCE(p.trade_type,'trade') AS trade_type,p.price_group_id,p.contact_person,p.latitude,p.longitude,p.place_accuracy_m,
        p.approval,p.added_by_salesperson_id,p.field_request_key AS field_key,COALESCE(p.hold_exempt,false) AS hold_exempt,
        ${repo.contactBalanceSql('c')} AS balance,
        (SELECT COALESCE(sum(${wholesale.remainingValueSql('x')}),0) FROM wholesale_order_lines x JOIN wholesale_orders o ON o.business_id=x.business_id AND o.id=x.order_id
          WHERE x.business_id=c.business_id AND o.contact_id=c.id AND o.status IN ('open','part_dispatched')) AS pending_orders,
        (SELECT count(*)::int FROM wholesale_orders o WHERE o.business_id=c.business_id AND o.contact_id=c.id AND o.status IN ('open','part_dispatched')) AS open_orders,
        business_cash_from_customer(c.business_id,c.id,$3,$4::date) AS cash_today,
        EXISTS (SELECT 1 FROM business_consents k WHERE k.business_id=c.business_id AND k.contact_id=c.id AND k.purpose='bills_digital' AND k.withdrawn_at IS NULL) AS bills_consent,
        (SELECT m.promised_on::text FROM retail_credit_reminders m WHERE m.business_id=c.business_id AND m.contact_id=c.id AND m.promised_on IS NOT NULL ORDER BY m.id DESC LIMIT 1) AS promised_on
      FROM business_contacts c LEFT JOIN wholesale_customer_beats cb ON cb.business_id=c.business_id AND cb.contact_id=c.id
      LEFT JOIN wholesale_customer_profiles p ON p.business_id=c.business_id AND p.contact_id=c.id
      WHERE c.business_id=$1 AND c.id=ANY($2::bigint[]) AND c.kind='customer' AND c.active AND c.erased_at IS NULL`, params),
    // What each owes and how late, oldest first (receivables' open items).
    repo.all(db, `WITH oi AS (${receivables.openItemsSql}) SELECT contact_id,
        COALESCE(sum(open_amount) FILTER (WHERE overdue),0) AS overdue,
        COALESCE(max(days_overdue) FILTER (WHERE open_amount>0),0)::int AS most_days_overdue,
        COALESCE(sum(open_amount) FILTER (WHERE $3::int IS NOT NULL AND days_overdue>$3::int),0) AS held_amount,
        min(due_on) FILTER (WHERE $3::int IS NOT NULL AND days_overdue>$3::int AND open_amount>0) AS held_oldest_due
      FROM oi WHERE contact_id=ANY($4::bigint[]) AND open_amount>0 GROUP BY contact_id`, [business.id, null, settings.hold_overdue_days, ids]),
    // The bills still to collect, oldest due first: the order a collection settles them in.
    repo.all(db, `SELECT * FROM (SELECT d.contact_id,d.id AS document_id,d.document_no,(d.created_at AT TIME ZONE $3)::date::text AS bill_date,d.due_on::text AS due_on,
        d.total-COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
        -COALESCE((SELECT sum(amount) FROM business_payments x WHERE x.business_id=d.business_id AND x.document_id=d.id),0)
        +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS outstanding,d.created_at
      FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id=ANY($2::bigint[])) b
      WHERE b.outstanding>0.004 ORDER BY b.contact_id,b.due_on NULLS FIRST,b.created_at,b.document_id`, [business.id, ids, business.timezone]),
    settings.bounce_hold_count ? repo.all(db, `SELECT contact_id,count(*)::int AS bounces FROM business_collection_cheques
      WHERE business_id=$1 AND contact_id=ANY($2::bigint[]) AND status='bounced' AND bounced_at > now() - make_interval(days => $3::int) GROUP BY contact_id`,
    [business.id, ids, settings.bounce_hold_days]) : [],
    // The last order, to repeat it: its paid lines, as they are still to send or were sent.
    repo.all(db, `SELECT DISTINCT ON (o.contact_id) o.contact_id,o.id,o.order_no,o.created_at,o.total,o.status,
        COALESCE((SELECT json_agg(json_build_object('sku_id',x.sku_id,'label',x.label,'unit',x.unit,'quantity',x.quantity,
          'entered_unit',x.entered_unit,'entered_quantity',x.entered_quantity) ORDER BY x.id)
          FROM wholesale_order_lines x WHERE x.business_id=o.business_id AND x.order_id=o.id AND x.free_of_line_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM wholesale_order_edits e WHERE e.business_id=x.business_id AND e.order_id=x.order_id AND x.id=ANY(e.removed_line_ids))),'[]') AS lines
      FROM wholesale_orders o WHERE o.business_id=$1 AND o.contact_id=ANY($2::bigint[]) AND o.status<>'cancelled' ORDER BY o.contact_id,o.id DESC`, [business.id, ids]),
  ]);
  const by = (list) => new Map(list.map((row) => [Number(row.contact_id), row]));
  const ages = by(open), bounced = by(bounces), lastOrder = by(last);
  const billsOf = new Map();
  for (const bill of bills) {
    const key = Number(bill.contact_id);
    if (!billsOf.has(key)) billsOf.set(key, []);
    billsOf.get(key).push({ document_id: bill.document_id, document_no: bill.document_no, bill_date: bill.bill_date, due_on: bill.due_on, outstanding: bill.outstanding });
  }
  return rows.map((row) => {
    const age = ages.get(Number(row.id)) || { overdue: '0', most_days_overdue: 0, held_amount: '0', held_oldest_due: null };
    const bounces = bounced.get(Number(row.id))?.bounces || 0;
    // The hold as the server works it out at order time (businessWholesaleCredit holdOf).
    const byOverdue = Boolean(settings.hold_overdue_days) && age.most_days_overdue > settings.hold_overdue_days;
    const byBounces = Boolean(settings.bounce_hold_count) && bounces >= settings.bounce_hold_count;
    const held = !row.hold_exempt && (byOverdue || byBounces);
    const lastRow = lastOrder.get(Number(row.id));
    return {
      id: row.id, name: row.name, phone: row.phone, address: row.address, gstin: row.gstin, contact_person: row.contact_person,
      credit_limit: row.credit_limit, credit_days: row.credit_days, beat_id: row.beat_id, visit_order: row.visit_order,
      trade_type: row.trade_type, price_group_id: row.price_group_id, approval: row.approval, added_by_salesperson_id: row.added_by_salesperson_id, field_key: row.field_key,
      place: row.latitude === null ? null : { latitude: Number(row.latitude), longitude: Number(row.longitude), accuracy: row.place_accuracy_m },
      balance: row.balance, overdue: age.overdue, most_days_overdue: age.most_days_overdue, pending_orders: row.pending_orders, open_orders: row.open_orders,
      cash_today: row.cash_today, bills_consent: row.bills_consent, promised_on: row.promised_on,
      hold: { held, reason: held ? (byOverdue ? 'overdue' : 'bounced_cheques') : null, exempt: row.hold_exempt, overdue: age.held_amount, oldest_due: age.held_oldest_due,
        days: age.most_days_overdue, limit_days: settings.hold_overdue_days, bounces, bounce_limit: settings.bounce_hold_count, bounce_days: settings.bounce_hold_days },
      open_bills: billsOf.get(Number(row.id)) || [],
      last_order: lastRow ? { id: lastRow.id, order_no: lastRow.order_no, created_at: lastRow.created_at, total: lastRow.total, status: lastRow.status, lines: lastRow.lines } : null,
    };
  });
}

// The prices a phone needs for these shops: the slabs for all customers and
// these shops' own (only while price lists are on, as the server prices), the
// group prices of their groups and the schemes, from today for a week ahead.
async function pricesFor(db, business, shops, day) {
  const ids = shops.map((s) => Number(s.id));
  const groups = [...new Set(shops.map((s) => s.price_group_id).filter(Boolean).map(Number))];
  const rulesOn = business.capabilities.includes('wholesale');
  const [priceRules, groupPrices] = await Promise.all([
    rulesOn ? repo.all(db, `SELECT id,sku_id,contact_id,unit_code,minimum_quantity,unit_price FROM business_price_rules
      WHERE business_id=$1 AND active AND (contact_id IS NULL OR contact_id=ANY($2::bigint[])) ORDER BY id`, [business.id, ids]) : [],
    groups.length ? repo.all(db, `SELECT id,group_id,sku_id,unit_code,minimum_quantity,unit_price,valid_from::text AS valid_from,valid_to::text AS valid_to
      FROM wholesale_group_prices WHERE business_id=$1 AND group_id=ANY($2::bigint[]) AND valid_from<=$3::date+7 AND (valid_to IS NULL OR valid_to>=$3::date) ORDER BY id`,
    [business.id, groups, day]) : [],
  ]);
  return { rulesOn, priceRules, groupPrices };
}

async function schemesFrom(db, business, day) {
  return repo.all(db, `SELECT x.id,x.name,x.sku_id,x.unit_code,x.buy_quantity,x.free_quantity,x.discount_percent,x.group_id,x.valid_from::text AS valid_from,
      x.valid_to::text AS valid_to,x.free_sku_id,x.free_unit_code,x.no_slab,u.quantity_in_base,fu.quantity_in_base AS free_in_base
    FROM wholesale_schemes x LEFT JOIN catalog_sku_units u ON u.business_id=x.business_id AND u.sku_id=x.sku_id AND u.unit_code=x.unit_code
    LEFT JOIN catalog_sku_units fu ON fu.business_id=x.business_id AND fu.sku_id=x.free_sku_id AND fu.unit_code=x.free_unit_code
    WHERE x.business_id=$1 AND x.active AND x.valid_from<=$2::date+7 AND (x.valid_to IS NULL OR x.valid_to>=$2::date) ORDER BY x.buy_quantity DESC,x.id`, [business.id, day]);
}

// The day's pack: everything the phone keeps to work the day with no network.
async function pack(business, user, query) {
  const salesperson = await whose(business, user, query);
  const db = repo.pool;
  const settings = await fieldSettings(db, business);
  const day = await today(db, business);
  const beats = await repo.all(db, `SELECT b.id,b.name,b.route_id,r.name AS route_name,b.visit_day,r.location_id AS depot_id,
      (SELECT count(*)::int FROM wholesale_customer_beats cb WHERE cb.business_id=b.business_id AND cb.beat_id=b.id) AS shops
    FROM wholesale_beats b JOIN wholesale_routes r ON r.business_id=b.business_id AND r.id=b.route_id
    WHERE b.business_id=$1 AND b.salesperson_id=$2 AND b.active AND r.active ORDER BY b.visit_day NULLS LAST,b.name`, [business.id, salesperson.id]);
  // The shops on their beats, and those they added that wait for the office.
  const ids = (await repo.all(db, `SELECT cb.contact_id FROM wholesale_customer_beats cb JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
      WHERE cb.business_id=$1 AND b.salesperson_id=$2 AND b.active
    UNION SELECT p.contact_id FROM wholesale_customer_profiles p WHERE p.business_id=$1 AND p.added_by_salesperson_id=$2 AND p.approval='pending'`,
  [business.id, salesperson.id])).map((r) => Number(r.contact_id));
  const shops = await shopsOf(db, business, ids, settings, day);
  const locations = await repo.all(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND active ORDER BY id', [business.id]);
  const member = business.member_location_id ? Number(business.member_location_id) : null;
  const defaultDepot = member || Number(locations[0]?.id) || null;
  const depots = [...new Set([defaultDepot, ...beats.map((b) => b.depot_id).filter(Boolean).map(Number)].filter(Boolean))];
  const [items, stock, schemes, prices, taxMode, month, notice] = await Promise.all([
    repo.all(db, `SELECT s.id,s.label,s.code,s.barcode,s.unit,u.name AS unit_name,u.decimals AS unit_decimals,s.price,s.tax_rate,s.mrp,
        cat.name AS category,
        COALESCE((SELECT json_agg(json_build_object('unit_code',x.unit_code,'quantity_in_base',x.quantity_in_base,'name',xu.name) ORDER BY x.quantity_in_base)
          FROM catalog_sku_units x JOIN business_units xu ON xu.business_id=x.business_id AND xu.code=x.unit_code
          WHERE x.business_id=s.business_id AND x.sku_id=s.id AND x.active),'[]') AS pack_sizes
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
      WHERE s.business_id=$1 AND s.active AND p.active AND p.kind='goods' AND NOT s.internal_use AND NOT s.is_kit ORDER BY s.label`, [business.id]),
    depots.length ? repo.all(db, `SELECT lot.sku_id,lot.location_id,sum(lot.quantity) AS quantity FROM business_stock_lots lot
      WHERE lot.business_id=$1 AND lot.location_id=ANY($2::bigint[]) AND lot.quantity>0 AND (lot.expires_on IS NULL OR lot.expires_on>=$3::date) GROUP BY 1,2`,
    [business.id, depots, day]) : [],
    schemesFrom(db, business, day),
    pricesFor(db, business, shops, day),
    repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]),
    repo.one(db, `SELECT COALESCE(sum(o.total),0) AS ordered,count(*)::int AS orders FROM wholesale_orders o
      WHERE o.business_id=$1 AND o.salesperson_id=$2 AND o.status<>'cancelled'
      AND date_trunc('month',o.created_at AT TIME ZONE $3)=date_trunc('month',now() AT TIME ZONE $3)`, [business.id, salesperson.id, business.timezone]),
    repo.one(db, 'SELECT id FROM business_privacy_notices WHERE business_id=$1 LIMIT 1', [business.id]),
  ]);
  const stockOf = new Map();
  for (const row of stock) {
    const key = Number(row.sku_id);
    if (!stockOf.has(key)) stockOf.set(key, {});
    stockOf.get(key)[row.location_id] = row.quantity;
  }
  return {
    read_at: new Date().toISOString(), today: day, weekday: rules.isoWeekday(day),
    salesperson: { id: salesperson.id, name: salesperson.name, phone: salesperson.phone, monthly_target: salesperson.monthly_target, active: salesperson.active },
    own: Number(salesperson.user_id) === Number(user.id),
    settings: { ...settings, tax_mode: taxMode?.tax_mode || 'exclusive', rules_on: prices.rulesOn, cash_limit: rupees(rules.CASH_LIMIT_PAISE),
      privacy_notice: Boolean(notice), receivables: business.modules.includes('receivables') },
    month: { target: salesperson.monthly_target, ordered: month.ordered, orders: month.orders },
    locations, default_depot_id: defaultDepot, beats, shops,
    items: items.map((item) => ({ ...item, stock: stockOf.get(Number(item.id)) || {} })),
    price_rules: prices.priceRules, group_prices: prices.groupPrices, schemes,
    no_order_reasons: Object.entries(rules.NO_ORDER_REASONS).map(([code, label]) => ({ code, label })),
  };
}

// One customer's field card, for a visit off the beat (search reaches every
// customer of the business): the same as a shop in the pack, with the prices
// that are its own.
async function customer(business, user, contactId) {
  await access.requireAny(business, ['salesperson_app.create', 'salesperson_app.view']);
  const settings = await fieldSettings(repo.pool, business);
  const day = await today(repo.pool, business);
  const [shop] = await shopsOf(repo.pool, business, [id(contactId, 'Shop')], settings, day);
  if (!shop) fail('Shop not found', 404);
  const prices = await pricesFor(repo.pool, business, [shop], day);
  return { shop, price_rules: prices.priceRules.filter((r) => r.contact_id !== null), group_prices: prices.groupPrices };
}

// Every customer of the business by name, phone, GSTIN or beat (for a visit
// off the beat): up to 20, with the beat each is on.
async function searchCustomers(business, user, query) {
  await access.requireAny(business, ['salesperson_app.create', 'salesperson_app.view']);
  const text = typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '';
  if (text.length < 2) return [];
  const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const digits = text.replace(/\D/g, '');
  return repo.all(repo.pool, `SELECT c.id,c.name,c.phone,c.address,c.gstin,b.name AS beat_name,r.name AS route_name,s.name AS salesperson_name,b.visit_day,p.approval,
      ${repo.contactBalanceSql('c')} AS balance
    FROM business_contacts c LEFT JOIN wholesale_customer_beats cb ON cb.business_id=c.business_id AND cb.contact_id=c.id
    LEFT JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id LEFT JOIN wholesale_routes r ON r.business_id=b.business_id AND r.id=b.route_id
    LEFT JOIN wholesale_salespeople s ON s.business_id=b.business_id AND s.id=b.salesperson_id
    LEFT JOIN wholesale_customer_profiles p ON p.business_id=c.business_id AND p.contact_id=c.id
    WHERE c.business_id=$1 AND c.kind='customer' AND c.active AND c.erased_at IS NULL AND COALESCE(p.trade_type,'trade')='trade'
      AND (concat_ws(' ',c.name,c.gstin,b.name,c.address) ILIKE $2 OR ($3::text<>'' AND length($3)>=4 AND regexp_replace(COALESCE(c.phone,''),'\\D','','g') LIKE '%'||$3||'%'))
    ORDER BY c.name LIMIT 20`, [business.id, like, digits]);
}

// Shops already here with this mobile (its last ten digits) or GSTIN: a new
// shop is checked against them before it is added.
async function matches(db, business, phone, gstin) {
  if (!phone && !gstin) return [];
  return repo.all(db, `SELECT c.id,c.name,c.phone,c.gstin,b.name AS beat_name FROM business_contacts c
    LEFT JOIN wholesale_customer_beats cb ON cb.business_id=c.business_id AND cb.contact_id=c.id
    LEFT JOIN wholesale_beats b ON b.business_id=cb.business_id AND b.id=cb.beat_id
    WHERE c.business_id=$1 AND c.kind='customer' AND c.active AND c.erased_at IS NULL
      AND (($2::text IS NOT NULL AND right(regexp_replace(COALESCE(c.phone,''),'\\D','','g'),10)=$2) OR ($3::text IS NOT NULL AND upper(c.gstin)=$3))
    ORDER BY c.name LIMIT 5`, [business.id, phone, gstin]);
}
async function checkShop(business, user, query) {
  await access.require(business, 'salesperson_app.create');
  const phone = readMobile(query.phone);
  const gstin = query.gstin ? readGstin(query.gstin) : null;
  return matches(repo.pool, business, phone ? phone.slice(-10) : null, gstin);
}
// An Indian mobile, as its ten digits; nothing given is null.
function readMobile(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const mobile = normaliseMobile(String(value));
  if (!mobile || !/^[6-9]\d{9}$/.test(mobile)) fail('Enter the shop\'s 10-digit mobile number, or leave it empty', 400, { field: 'phone' });
  return mobile;
}

// What reached the server of one salesperson's day.
async function day(business, user, query) {
  const salesperson = await whose(business, user, query);
  const date = query.date ? core.dateText(query.date, 'Day') : await today(repo.pool, business);
  return dayRecord(repo.pool, business, salesperson, date);
}
async function dayRecord(db, business, salesperson, date) {
  const params = [business.id, salesperson.id, date, business.timezone];
  const [dayRow, visits, orders, collections, refusals, shops] = await Promise.all([
    repo.one(db, 'SELECT * FROM wholesale_salesperson_days WHERE business_id=$1 AND salesperson_id=$2 AND day=$3', [business.id, salesperson.id, date]),
    repo.all(db, `SELECT v.*,c.name AS contact_name,b.name AS beat_name FROM wholesale_visits v JOIN business_contacts c ON c.business_id=v.business_id AND c.id=v.contact_id
      LEFT JOIN wholesale_beats b ON b.business_id=v.business_id AND b.id=v.beat_id WHERE v.business_id=$1 AND v.salesperson_id=$2 AND v.day=$3 ORDER BY v.checked_in_at,v.id`,
    [business.id, salesperson.id, date]),
    repo.all(db, `SELECT o.id,o.order_no,o.contact_id,o.contact_name,o.total,o.status,o.created_at,o.request_key,f.phone_total,f.visit_key,f.taken_at,f.offline,
        (SELECT count(*)::int FROM wholesale_order_lines x WHERE x.business_id=o.business_id AND x.order_id=o.id AND x.free_of_line_id IS NULL) AS line_count
      FROM wholesale_field_orders f JOIN wholesale_orders o ON o.business_id=f.business_id AND o.id=f.order_id
      WHERE f.business_id=$1 AND f.salesperson_id=$2 AND (f.taken_at AT TIME ZONE $4)::date=$3::date ORDER BY f.taken_at,o.id`, params),
    repo.all(db, `SELECT k.id,k.collection_no,k.contact_id,k.contact_name,k.amount,k.method,k.reference,k.created_at,k.request_key,f.visit_key,f.taken_at,f.offline,
        q.cheque_date,q.bank,q.status AS cheque_status,EXISTS (SELECT 1 FROM wholesale_settlement_receipts sr WHERE sr.business_id=k.business_id AND sr.collection_id=k.id) AS settled
      FROM wholesale_field_collections f JOIN business_collections k ON k.business_id=f.business_id AND k.id=f.collection_id
      LEFT JOIN business_collection_cheques q ON q.business_id=k.business_id AND q.collection_id=k.id
      WHERE f.business_id=$1 AND f.salesperson_id=$2 AND (f.taken_at AT TIME ZONE $4)::date=$3::date ORDER BY f.taken_at,k.id`, params),
    repo.all(db, `SELECT r.*,c.name AS contact_name,u.name AS released_by_name,o.order_no FROM wholesale_field_refusals r
      JOIN business_contacts c ON c.business_id=r.business_id AND c.id=r.contact_id LEFT JOIN users u ON u.id=r.released_by
      LEFT JOIN wholesale_orders o ON o.business_id=r.business_id AND o.id=r.order_id
      WHERE r.business_id=$1 AND r.salesperson_id=$2 AND ((r.first_at AT TIME ZONE $4)::date=$3::date OR (r.last_at AT TIME ZONE $4)::date=$3::date) ORDER BY r.first_at`, params),
    repo.all(db, `SELECT c.id AS contact_id,c.name,c.phone,p.field_request_key AS request_key,p.approval,c.created_at FROM wholesale_customer_profiles p
      JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id
      WHERE p.business_id=$1 AND p.added_by_salesperson_id=$2 AND (c.created_at AT TIME ZONE $4)::date=$3::date ORDER BY c.id`, params),
  ]);
  return { date, salesperson: { id: salesperson.id, name: salesperson.name }, day: dayRow || null, visits, orders, collections, refusals, shops };
}

// --- The day: start and end ------------------------------------------------------------------

// body: { requestKey, startedAt, place?, offline? }. One day per salesperson
// and date: starting again (another phone, or this one after losing its copy)
// answers with the day already started.
async function startDay(business, user, body) {
  await access.require(business, 'salesperson_app.create');
  const key = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const at = readMoment(body.startedAt, 'The start');
  const place = rules.readPlace(body.place, 'The start\'s place');
  return repo.transaction(async (db) => {
    const me = await ownSalesperson(db, business, user);
    await db.query('SELECT id FROM wholesale_salespeople WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, me.id]);
    const again = await repo.one(db, 'SELECT * FROM wholesale_salesperson_days WHERE business_id=$1 AND start_key=$2', [business.id, key]);
    if (again) {
      if (again.start_hash !== hash) fail('This request key was already used for different data', 409);
      return again;
    }
    const date = await dayOf(db, business, at);
    const started = await repo.one(db, 'SELECT * FROM wholesale_salesperson_days WHERE business_id=$1 AND salesperson_id=$2 AND day=$3', [business.id, me.id, date]);
    if (started) return { ...started, already_started: true };
    const settings = await fieldSettings(db, business);
    const kept = settings.record_places ? place : null;
    const row = await repo.one(db, `INSERT INTO wholesale_salesperson_days(business_id,salesperson_id,day,started_at,start_latitude,start_longitude,start_accuracy_m,
      start_offline,start_key,start_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [business.id, me.id, date, at, kept?.latitude ?? null, kept?.longitude ?? null, kept?.accuracy ?? null, flag(body.offline), key, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'salesperson.day_started', row.id, { salesperson: me.name, day: date, at, place: Boolean(kept), offline: flag(body.offline) });
    return row;
  });
}

// body: { requestKey, endedAt, place?, cashInHand?, note?, offline? }.
async function endDay(business, user, body) {
  await access.require(business, 'salesperson_app.create');
  const key = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const at = readMoment(body.endedAt, 'The end');
  const place = rules.readPlace(body.place, 'The end\'s place');
  const cash = body.cashInHand === undefined || body.cashInHand === null || body.cashInHand === '' ? null : core.decimal(body.cashInHand, 'Cash in hand', 2, 0, 100000000);
  const note = v.optionalString(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const me = await ownSalesperson(db, business, user);
    await db.query('SELECT id FROM wholesale_salespeople WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, me.id]);
    const again = await repo.one(db, 'SELECT * FROM wholesale_salesperson_days WHERE business_id=$1 AND end_key=$2', [business.id, key]);
    if (again) {
      if (again.end_hash !== hash) fail('This request key was already used for different data', 409);
      return again;
    }
    const date = await dayOf(db, business, at);
    const row = await repo.one(db, 'SELECT * FROM wholesale_salesperson_days WHERE business_id=$1 AND salesperson_id=$2 AND day=$3 FOR UPDATE', [business.id, me.id, date]);
    if (!row) fail('Start your day before you end it', 409, { reason: 'day_not_started' });
    if (row.ended_at) return { ...row, already_ended: true };
    if (Date.parse(at) < Date.parse(row.started_at)) fail('The day cannot end before it started', 400);
    const settings = await fieldSettings(db, business);
    const kept = settings.record_places ? place : null;
    const saved = await repo.one(db, `UPDATE wholesale_salesperson_days SET ended_at=$3,end_latitude=$4,end_longitude=$5,end_accuracy_m=$6,cash_in_hand=$7,end_note=$8,
      end_offline=$9,end_key=$10,end_hash=$11,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,
    [business.id, row.id, at, kept?.latitude ?? null, kept?.longitude ?? null, kept?.accuracy ?? null, cash === null ? null : cash.toFixed(2), note, flag(body.offline), key, hash]);
    await repo.audit(db, business.id, user.id, 'salesperson.day_ended', row.id, { salesperson: me.name, day: date, at, cashInHand: saved.cash_in_hand, offline: flag(body.offline) });
    return saved;
  });
}

// --- Visits -------------------------------------------------------------------------------------

// body: { requestKey, contactId | newShopKey, checkedInAt, place?, farReason?,
// offBeatReason?, savePlace?, offline? }. The place is kept only within the
// salesperson's started day while the business records places; its distance
// from the shop's saved place decides "far" (a reason is asked on the phone;
// one that reaches here without, the shop's place having changed since the
// phone's copy, is kept flagged with no reason). "Save this as the shop's
// place" sets a place the shop does not have yet.
async function checkIn(business, user, body) {
  await access.require(business, 'salesperson_app.create');
  const key = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const at = readMoment(body.checkedInAt, 'The check-in');
  const place = rules.readPlace(body.place, 'The check-in\'s place');
  const farReason = v.optionalString(body.farReason, 'Why away from the shop', 200);
  const offBeatReason = v.optionalString(body.offBeatReason, 'Why a shop off the beat', 200);
  const answer = (visit) => ({ ...visit, maps: visit.latitude === null ? null : rules.mapsLink(visit.latitude, visit.longitude) });
  const done = await repo.one(repo.pool, 'SELECT * FROM wholesale_visits WHERE business_id=$1 AND request_key=$2', [business.id, key]);
  if (done) {
    if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
    return answer(done);
  }
  return repo.transaction(async (db) => {
    const me = await ownSalesperson(db, business, user);
    await db.query('SELECT id FROM wholesale_salespeople WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, me.id]);
    const again = await repo.one(db, 'SELECT * FROM wholesale_visits WHERE business_id=$1 AND request_key=$2', [business.id, key]);
    if (again) {
      if (again.request_hash !== hash) fail('This request key was already used for different data', 409);
      return answer(again);
    }
    const shop = await readShop(db, business, body);
    const date = await dayOf(db, business, at);
    const settings = await fieldSettings(db, business);
    const { beat, onBeat } = await shopBeat(db, business, shop.id, me.id, date);
    const openDay = await openDayAt(db, business, me.id, date, at);
    const kept = settings.record_places && openDay ? place : null;
    const profile = await repo.one(db, 'SELECT latitude,longitude FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2 FOR UPDATE', [business.id, shop.id]);
    const saved = profile && profile.latitude !== null ? { latitude: Number(profile.latitude), longitude: Number(profile.longitude) } : null;
    const distance = kept && saved ? rules.distanceMetres(kept, saved) : null;
    const far = distance !== null && distance > settings.checkin_distance_m;
    const savePlace = flag(body.savePlace) && Boolean(kept) && !saved;
    if (savePlace) {
      await db.query(`INSERT INTO wholesale_customer_profiles(business_id,contact_id,latitude,longitude,place_accuracy_m,place_saved_at,place_saved_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(business_id,contact_id) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,
        place_accuracy_m=EXCLUDED.place_accuracy_m,place_saved_at=EXCLUDED.place_saved_at,place_saved_by=EXCLUDED.place_saved_by
        WHERE wholesale_customer_profiles.latitude IS NULL`, [business.id, shop.id, kept.latitude, kept.longitude, kept.accuracy, at, user.id]);
      await repo.audit(db, business.id, user.id, 'shop.place_saved', shop.id, { shop: shop.name, accuracy: kept.accuracy });
    }
    const visit = await repo.one(db, `INSERT INTO wholesale_visits(business_id,salesperson_id,contact_id,beat_id,day,checked_in_at,latitude,longitude,accuracy_m,distance_m,
      far,far_reason,off_beat,off_beat_reason,place_saved,offline,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [business.id, me.id, shop.id, beat?.id || null, date, at, kept?.latitude ?? null, kept?.longitude ?? null, kept?.accuracy ?? null, distance,
      far, far ? farReason : null, !onBeat, onBeat ? null : offBeatReason, savePlace, flag(body.offline), key, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'visit.checked_in', visit.id, { shop: shop.name, day: date, far, distance, offBeat: !onBeat,
      reason: (far ? farReason : null) || (onBeat ? null : offBeatReason) || undefined, offline: flag(body.offline) });
    return answer(visit);
  });
}

// POST /sales/visits/:visitKey/check-out — body: { requestKey, checkedOutAt,
// outcome: 'order' | 'no_order', noOrderReason?, note?, promisedOn?,
// promisedAmount?, offline? }. A promised payment date also goes in the dues
// book (the Outstanding screen's promise), as a visit.
async function checkOut(business, user, visitKey, body) {
  await access.require(business, 'salesperson_app.create');
  const visitId = core.uuid(visitKey, 'Visit');
  const key = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const at = readMoment(body.checkedOutAt, 'The check-out');
  const outcome = v.requiredEnum(body.outcome, 'Outcome', ['order', 'no_order']);
  const reason = outcome === 'no_order' ? v.requiredEnum(body.noOrderReason, 'Why no order', Object.keys(rules.NO_ORDER_REASONS)) : null;
  const note = v.optionalString(body.note, 'Note', 500);
  if (reason === 'other' && !note) fail('Say why there was no order', 400, { field: 'note' });
  const promisedOn = body.promisedOn ? core.dateText(body.promisedOn, 'Promised payment date') : null;
  const promisedAmount = body.promisedAmount === undefined || body.promisedAmount === null || body.promisedAmount === '' ? null
    : core.decimal(body.promisedAmount, 'Promised amount', 2, 0.01, 100000000);
  if (promisedAmount !== null && !promisedOn) fail('Say when they promised to pay', 400, { field: 'promisedOn' });
  return repo.transaction(async (db) => {
    const me = await ownSalesperson(db, business, user);
    const visit = await repo.one(db, 'SELECT * FROM wholesale_visits WHERE business_id=$1 AND request_key=$2 FOR UPDATE', [business.id, visitId]);
    if (!visit || Number(visit.salesperson_id) !== Number(me.id)) fail('That visit has not reached the office', 404, { reason: 'visit_not_here' });
    if (visit.checkout_key) {
      if (visit.checkout_key === key) {
        if (visit.checkout_hash !== hash) fail('This request key was already used for different data', 409);
        return visit;
      }
      fail(`This visit was already checked out at ${new Date(visit.checked_out_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: business.timezone })}`, 409, { reason: 'checked_out' });
    }
    if (Date.parse(at) < Date.parse(visit.checked_in_at)) fail('The check-out cannot come before the check-in', 400);
    if (promisedOn && promisedOn < visit.day) fail('The promised date is before the visit', 400, { field: 'promisedOn' });
    const saved = await repo.one(db, `UPDATE wholesale_visits SET checked_out_at=$3,outcome=$4,no_order_reason=$5,note=$6,promised_on=$7,promised_amount=$8,
      checkout_key=$9,checkout_hash=$10,offline=offline OR $11,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`,
    [business.id, visit.id, at, outcome, reason, note, promisedOn, promisedAmount === null ? null : promisedAmount.toFixed(2), key, hash, flag(body.offline)]);
    if (promisedOn) {
      const contact = await repo.one(db, `SELECT c.id,${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, visit.contact_id]);
      const words = [promisedAmount !== null && `Promised ${rupees(paise(promisedAmount))}`, `On ${me.name}'s visit`, note].filter(Boolean).join(' · ').slice(0, 300);
      await db.query(`INSERT INTO retail_credit_reminders(business_id,contact_id,channel,balance,promised_on,note,created_by) VALUES($1,$2,'visit',$3,$4,$5,$6)`,
        [business.id, visit.contact_id, contact.balance, promisedOn, words, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'visit.checked_out', visit.id, { outcome, reason, promisedOn, offline: flag(body.offline) });
    return saved;
  });
}

// --- Orders and collections ---------------------------------------------------------------------

// A refusal's reason, from the wholesale module's own refusal (a credit hold,
// the credit limit) or the field's own (a new shop's cash only).
const refusalOf = (error) => (error instanceof AppError && error.statusCode === 409 && ['credit_hold', 'credit_limit', 'cash_only'].includes(error.details?.reason)
  ? error.details.reason : null);

// Records an order refused on arrival (one row per request key, however
// often it is tried), so the office sees it and may let a held one through.
async function recordRefusal(business, user, me, contact, body, key, reason, message) {
  const total = body.phoneTotal === undefined ? null : core.decimal(body.phoneTotal, 'Total on the phone', 2, 0, 1000000000).toFixed(2);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `INSERT INTO wholesale_field_refusals(business_id,salesperson_id,contact_id,visit_key,request_key,reason,message,phone_total)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(business_id,request_key) DO UPDATE SET tries=wholesale_field_refusals.tries+1,last_at=now(),
      reason=EXCLUDED.reason,message=EXCLUDED.message,updated_at=now() RETURNING *`,
    [business.id, me.id, contact.id, optionalKey(body.visitKey, 'Visit'), key, reason, String(message).slice(0, 600), total]);
    await repo.audit(db, business.id, user.id, 'field_order.refused', row.id, { shop: contact.name, reason, tries: row.tries });
    return row;
  });
}

// body: { requestKey, contactId | newShopKey, visitKey?, locationId, lines:
// [{ skuId, quantity, unit? }], phoneTotal, takenAt, notes?, offline? }.
// Placed through the wholesale module's own order (prices, schemes, free
// goods, credit limit, credit hold, number, audit and event), as the login's
// own salesperson. Discounts and free goods by hand stay with the office. A
// shop added in the field and not yet approved buys for cash only: nothing
// owed and no order still to deliver. A refusal on arrival is recorded for
// the office; once it lets a held order through, the same request key goes.
async function takeOrder(business, user, body) {
  await access.require(business, 'salesperson_app.create');
  await access.require(business, 'sales_orders.create');
  const me = await ownSalesperson(repo.pool, business, user);
  const key = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const lines = v.requiredArray(body.lines, 'Lines');
  if (!lines.length || lines.length > 100) fail('Add between 1 and 100 lines');
  for (const line of lines) {
    if (!line || typeof line !== 'object') fail('Each line is an item and a quantity');
    if ((line.discountPercent && Number(line.discountPercent) !== 0) || (line.freeQuantity && Number(line.freeQuantity) !== 0)) {
      fail('Discounts and free goods given by hand are the office\'s: the order takes the shop\'s prices and schemes', 400);
    }
  }
  const phoneTotal = core.decimal(body.phoneTotal, 'Total on the phone', 2, 0, 1000000000);
  const takenAt = readMoment(body.takenAt, 'When the order was taken');
  const visitKey = optionalKey(body.visitKey, 'Visit');
  const notes = v.optionalString(body.notes, 'Notes', 300);
  const answer = async (db, order) => {
    const field = await repo.one(db, 'SELECT * FROM wholesale_field_orders WHERE business_id=$1 AND order_id=$2', [business.id, order.id]);
    const total = paise(order.total), phone = paise(field?.phone_total ?? phoneTotal);
    return { ...order, phone_total: rupees(phone), price_difference: rupees(total - phone), visit_key: field?.visit_key || visitKey };
  };
  const done = await repo.one(repo.pool, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND request_key=$2', [business.id, key]);
  if (done) {
    if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
    return answer(repo.pool, done);
  }
  const contact = await readShop(repo.pool, business, body);
  // The office let this order through a credit hold after it was refused.
  const refused = await repo.one(repo.pool, `SELECT r.*,u.name AS released_by_name FROM wholesale_field_refusals r LEFT JOIN users u ON u.id=r.released_by
    WHERE r.business_id=$1 AND r.request_key=$2`, [business.id, key]);
  const release = refused?.released_at ? { reason: refused.release_reason, approver: { id: refused.released_by, name: refused.released_by_name } } : null;
  try {
    return await repo.transaction(async (db) => {
      const profile = await repo.one(db, 'SELECT approval FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]);
      const pending = profile?.approval === 'pending';
      if (pending) {
        await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
        const owes = await repo.one(db, `SELECT ${repo.contactBalanceSql('c')} AS balance,
          (SELECT string_agg(o.order_no,', ' ORDER BY o.id) FROM wholesale_orders o WHERE o.business_id=c.business_id AND o.contact_id=c.id
            AND o.status IN ('open','part_dispatched') AND o.request_key<>$3) AS open_orders
          FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, contact.id, key]);
        const balance = paise(owes.balance);
        if (balance > 0 || owes.open_orders) {
          fail(`${contact.name} is a new shop the office has not approved yet, so it buys for cash only: ${balance > 0 ? `it still owes ${rupees(balance)}` : `order ${owes.open_orders} is not delivered yet`}. Collect first, or ask the office to approve the shop and set its credit.`,
            409, { reason: 'cash_only', owed: rupees(Math.max(0, balance)), openOrders: owes.open_orders || null });
        }
      }
      const order = await wholesale.placeOrder(db, business, user, {
        locationId: body.locationId, contactId: contact.id, salespersonId: me.id, lines: lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity, ...(l.unit ? { unit: l.unit } : {}) })),
        notes: [pending ? 'Cash on delivery: a new shop not yet approved.' : null, notes].filter(Boolean).join(' ').slice(0, 500) || null,
      }, { requestKey: key, hash, release, expectedOn: null });
      await db.query(`INSERT INTO wholesale_field_orders(business_id,order_id,salesperson_id,visit_key,phone_total,taken_at,offline) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(business_id,order_id) DO NOTHING`, [business.id, order.id, me.id, visitKey, phoneTotal.toFixed(2), takenAt, flag(body.offline)]);
      if (refused) await db.query('UPDATE wholesale_field_refusals SET order_id=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, refused.id, order.id]);
      // The server prices every order; a difference from the phone's copy is said, never hidden.
      if (paise(order.total) !== paise(phoneTotal)) {
        await repo.audit(db, business.id, user.id, 'sales_order.priced_again', order.id, { orderNo: order.order_no, phoneTotal: phoneTotal.toFixed(2), total: order.total });
      }
      return answer(db, order);
    });
  } catch (error) {
    const reason = refusalOf(error);
    if (reason) {
      const row = await recordRefusal(business, user, me, contact, body, key, reason, error.message);
      error.details = { ...error.details, refusalId: row.id, tries: row.tries };
    }
    throw error;
  }
}

// body: { requestKey, contactId | newShopKey, visitKey?, locationId, amount,
// method: 'cash' | 'cheque' | 'upi', reference (the cheque's number or the
// 12-digit UTR), chequeDate?, bank?, allocations?, takenAt, offline? }.
// Recorded through the shared receivables' own receipt (numbered, settling
// the oldest bills unless some are chosen; the cash limit is the database's
// rule), with the salesperson and route on it, so the evening settlement
// shows it.
async function collect(business, user, body) {
  await access.require(business, 'salesperson_app.create');
  await access.require(business, 'receivables.create');
  const me = await ownSalesperson(repo.pool, business, user);
  const key = core.uuid(body.requestKey);
  const method = v.requiredEnum(body.method, 'Paid by', ['cash', 'cheque', 'upi']);
  const takenAt = readMoment(body.takenAt, 'When it was collected');
  const visitKey = optionalKey(body.visitKey, 'Visit');
  let reference = null, chequeDate = null, bank = null;
  if (method === 'upi') reference = rules.readUtr(body.reference);
  if (method === 'cheque') {
    reference = rules.readChequeNo(body.reference);
    chequeDate = core.dateText(body.chequeDate, 'Cheque date');
    bank = v.requiredString(body.bank, 'Bank the cheque is drawn on', 100);
  }
  const contact = await readShop(repo.pool, business, body);
  // What the receipt is made of; the hash the receipt keeps is of what the
  // phone sent, so its retries are the same receipt and anything else with
  // the same key is refused.
  const shared = { locationId: body.locationId, contactId: contact.id, amount: body.amount, method, requestKey: key,
    ...(reference ? { reference } : {}), ...(chequeDate ? { chequeDate, bank } : {}),
    ...(body.allocations !== undefined && body.allocations !== null ? { allocations: body.allocations } : {}),
    notes: `Collected by ${me.name}${flag(body.offline) ? ' (made with no network)' : ''}`, phoneRequest: hashOf(body) };
  const { beat } = await shopBeat(repo.pool, business, contact.id, me.id, await dayOf(repo.pool, business, takenAt));
  const routeId = beat?.route_id || null;
  const saved = await receivables.createCollection(business, user, shared, {
    extend: async (db, collection) => {
      // Under the business's lock: a UPI reference is used once, and a cheque
      // is not taken twice from the same shop.
      if (method === 'upi') {
        const used = await repo.one(db, `SELECT k.collection_no,k.contact_name FROM business_collections k WHERE k.business_id=$1 AND k.id<>$2 AND k.method='upi' AND k.reference=$3
          AND ${receivables.liveSql('k')}`, [business.id, collection.id, reference]);
        if (used) fail(`UPI reference ${reference} is already on receipt ${used.collection_no} (${used.contact_name}). Check the number in the payer's app.`, 409, { reason: 'duplicate_utr', field: 'reference' });
      }
      if (method === 'cheque') {
        const used = await repo.one(db, `SELECT k.collection_no FROM business_collection_cheques q JOIN business_collections k ON k.business_id=q.business_id AND k.id=q.collection_id
          WHERE q.business_id=$1 AND q.collection_id<>$2 AND q.contact_id=$3 AND q.cheque_no=$4 AND lower(COALESCE(q.bank,''))=lower($5) AND q.status<>'bounced'`,
        [business.id, collection.id, contact.id, reference, bank]);
        if (used) fail(`Cheque ${reference} of ${bank} from ${contact.name} is already on receipt ${used.collection_no}`, 409, { reason: 'duplicate_cheque', field: 'reference' });
      }
      await db.query('INSERT INTO wholesale_collection_details(business_id,collection_id,salesperson_id,route_id) VALUES($1,$2,$3,$4)', [business.id, collection.id, me.id, routeId]);
      await db.query('INSERT INTO wholesale_field_collections(business_id,collection_id,salesperson_id,visit_key,taken_at,offline) VALUES($1,$2,$3,$4,$5,$6)',
        [business.id, collection.id, me.id, visitKey, takenAt, flag(body.offline)]);
    },
  });
  return { ...saved, visit_key: visitKey, salesperson_name: me.name };
}

// --- New shops -------------------------------------------------------------------------------------

// body: { requestKey, name, contactPerson?, phone?, gstin?, address, beatId?,
// place?, consents?, takenAt, offline? }. A customer added in the field:
// checked against every customer by mobile and GSTIN, then made with no
// credit (cash only) and "added by" the salesperson, on their beat, waiting
// for the office to approve it and set its credit. Its place is saved when the
// phone gave one within the salesperson's day.
async function addShop(business, user, body) {
  await access.require(business, 'salesperson_app.create');
  const key = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const name = v.requiredString(body.name, 'Shop name', 150);
  if (name.replace(/\s+/g, ' ').length < 2) fail('Enter the shop\'s name', 400, { field: 'name' });
  const address = v.requiredString(body.address, 'Address with a landmark', 500);
  const contactPerson = v.optionalString(body.contactPerson, 'Owner or contact person', 100);
  const phone = readMobile(body.phone);
  const gstin = body.gstin ? readGstin(body.gstin) : null;
  const place = rules.readPlace(body.place, 'The shop\'s place');
  const at = readMoment(body.takenAt, 'When the shop was added');
  const choices = require('../../../personal-data/services/consents').readChoices(body.consents);
  const answer = async (db, contactId) => {
    const row = await repo.one(db, `SELECT c.id,c.name,c.phone,c.gstin,c.address,p.approval,p.field_request_key AS request_key,cb.beat_id FROM business_contacts c
      JOIN wholesale_customer_profiles p ON p.business_id=c.business_id AND p.contact_id=c.id
      LEFT JOIN wholesale_customer_beats cb ON cb.business_id=c.business_id AND cb.contact_id=c.id WHERE c.business_id=$1 AND c.id=$2`, [business.id, contactId]);
    return { ...row, contact_id: row.id };
  };
  const done = await repo.one(repo.pool, 'SELECT contact_id,field_request_hash FROM wholesale_customer_profiles WHERE business_id=$1 AND field_request_key=$2', [business.id, key]);
  if (done) {
    if (done.field_request_hash !== hash) fail('This request key was already used for different data', 409);
    return answer(repo.pool, done.contact_id);
  }
  return repo.transaction(async (db) => {
    const me = await ownSalesperson(db, business, user);
    // Two phones adding the same shop at once make one: the second waits for the first.
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const again = await repo.one(db, 'SELECT contact_id,field_request_hash FROM wholesale_customer_profiles WHERE business_id=$1 AND field_request_key=$2', [business.id, key]);
    if (again) {
      if (again.field_request_hash !== hash) fail('This request key was already used for different data', 409);
      return answer(db, again.contact_id);
    }
    const same = await matches(db, business, phone ? phone.slice(-10) : null, gstin);
    if (same.length) {
      const found = same[0];
      fail(`${found.name}${found.beat_name ? ` (${found.beat_name})` : ''} is already a customer with this ${phone && right10(found.phone) === phone.slice(-10) ? 'mobile number' : 'GSTIN'}. Visit that shop instead.`,
        409, { reason: 'duplicate_shop', match: { id: found.id, name: found.name, beat_name: found.beat_name } });
    }
    const beatId = optionalId(body.beatId, 'Beat');
    if (beatId && !(await repo.one(db, 'SELECT id FROM wholesale_beats WHERE business_id=$1 AND id=$2 AND salesperson_id=$3 AND active', [business.id, beatId, me.id]))) {
      fail('Choose one of your own beats', 404);
    }
    const contact = await repo.one(db, `INSERT INTO business_contacts(business_id,kind,name,phone,address,gstin,credit_limit,credit_days)
      VALUES($1,'customer',$2,$3,$4,$5,NULL,0) RETURNING *`, [business.id, name, phone, address, gstin]);
    const date = await dayOf(db, business, at);
    const settings = await fieldSettings(db, business);
    const kept = settings.record_places && (await openDayAt(db, business, me.id, date, at)) ? place : null;
    await db.query(`INSERT INTO wholesale_customer_profiles(business_id,contact_id,contact_person,trade_type,latitude,longitude,place_accuracy_m,place_saved_at,place_saved_by,
      added_by_salesperson_id,approval,field_request_key,field_request_hash,updated_by) VALUES($1,$2,$3,'trade',$4,$5,$6,$7,$8,$9,'pending',$10,$11,$8)`,
    [business.id, contact.id, contactPerson, kept?.latitude ?? null, kept?.longitude ?? null, kept?.accuracy ?? null, kept ? at : null, user.id, me.id, key, hash]);
    if (beatId) {
      await db.query(`INSERT INTO wholesale_customer_beats(business_id,contact_id,beat_id,updated_by,visit_order)
        VALUES($1,$2,$3,$4,(SELECT max(visit_order)+1 FROM wholesale_customer_beats WHERE business_id=$1 AND beat_id=$3))`, [business.id, contact.id, beatId, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'contact.created', contact.id);
    await repo.audit(db, business.id, user.id, 'shop.added_from_field', contact.id, { shop: name, salesperson: me.name, beatId, place: Boolean(kept), offline: flag(body.offline) });
    if (choices) {
      // The shop said yes (or no) to the salesperson, in person at the shop:
      // recorded as just that, with the salesperson's login as who recorded it.
      const consents = require('../../../personal-data/services/consents');
      await consents.apply(db, { businessId: business.id, person: consents.personOf('contact_id', contact.id), choices, channel: 'field', method: 'verbal',
        userId: user.id, reason: 'Said no to the salesperson at the shop', audit: (dbx, action, entityId, details) => repo.audit(dbx, business.id, user.id, action, entityId, details) });
    }
    return answer(db, contact.id);
  });
}
const right10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

module.exports = {
  me, pack, customer, searchCustomers, checkShop, day, dayRecord, startDay, endDay, checkIn, checkOut, takeOrder, collect, addShop,
  ownSalesperson, fieldSettings, shopsOf, today,
};
