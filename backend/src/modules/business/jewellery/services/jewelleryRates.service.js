const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');

// Today's rates (module "jewellery"): a manager sets, for each purity, the
// selling rate per gram and the rate per gram the shop pays for old metal, as
// a rate sheet of the day: morning or evening, from the shop's own reckoning,
// the local association's rate or the IBJA rate typed in. A sheet is never
// changed: a correction is a new sheet, and a bill always takes the latest
// rate of its own day for each purity (the database checks it). The rate
// board shows the rates in use in large type for a screen in the showroom.

const { fail } = c;
const SESSIONS = ['morning', 'evening'];
const SOURCES = ['shop', 'association', 'ibja'];
const SESSION_WORDS = { morning: 'Morning', evening: 'Evening' };
const SOURCE_WORDS = { shop: 'The shop\'s own rates', association: 'The local association\'s rates', ibja: 'IBJA rates' };

// Every rate sheet with its rates, newest first.
repo.addLists({
  'jewellery-rate-sheets': {
    sql: `SELECT s.id,s.rate_date::text AS rate_date,s.session,s.source,s.note,s.created_at,u.name AS set_by_name,
        (SELECT json_agg(json_build_object('metal',r.metal,'purity',r.purity,'sell_rate',r.sell_rate,'buy_rate',r.buy_rate) ORDER BY r.metal,r.purity)
          FROM jewellery_rates r WHERE r.business_id=s.business_id AND r.sheet_id=s.id) AS rates,
        EXISTS (SELECT 1 FROM jewellery_rate_sheets n WHERE n.business_id=s.business_id AND n.rate_date=s.rate_date AND (n.created_at,n.id)>(s.created_at,s.id)) AS replaced
      FROM jewellery_rate_sheets s JOIN users u ON u.id=s.created_by WHERE s.business_id=$1`,
    search: ['note', 'set_by_name', 'session', 'source'], date: 'created_at', filters: { session: 'session', source: 'source', day: 'rate_date' }, order: 'created_at DESC,id DESC',
  },
});

// The rates in use now: for each purity, the latest sheet of the business's
// day that rates it (none: not set today).
const CURRENT_SQL = `SELECT DISTINCT ON (r.metal,r.purity) r.metal,r.purity,r.sell_rate,r.buy_rate,r.sheet_id,s.session,s.source,s.note,s.created_at AS set_at,u.name AS set_by_name
  FROM jewellery_rates r JOIN jewellery_rate_sheets s ON s.business_id=r.business_id AND s.id=r.sheet_id JOIN users u ON u.id=s.created_by
  WHERE r.business_id=$1 AND s.rate_date=$2::date ORDER BY r.metal,r.purity,s.created_at DESC,s.id DESC`;

const shapeRate = (row) => ({ ...row, fineness: c.purityOf(row.metal, row.purity)?.fineness ?? null, mark: c.purityMark(row.metal, row.purity),
  label: c.purityWords(row.metal, row.purity) });
const ordered = (rows) => [...rows].sort((a, b) => c.sortKey(a.metal, a.purity) - c.sortKey(b.metal, b.purity));

// Today's rates in use, keyed by "metal:purity", inside a caller's transaction (a bill, an old gold voucher).
async function ratesNow(db, business) {
  const day = await c.today(db, business);
  const rows = await repo.all(db, CURRENT_SQL, [business.id, day]);
  return { day, byPurity: new Map(rows.map((r) => [`${r.metal}:${r.purity}`, r])) };
}

async function todayRates(db, business) {
  const day = await c.today(db, business);
  const rows = ordered((await repo.all(db, CURRENT_SQL, [business.id, day])).map(shapeRate));
  // The rates last set on an earlier day, to start today's sheet from.
  const before = ordered((await repo.all(db, `SELECT DISTINCT ON (r.metal,r.purity) r.metal,r.purity,r.sell_rate,r.buy_rate,s.rate_date::text AS rate_date
    FROM jewellery_rates r JOIN jewellery_rate_sheets s ON s.business_id=r.business_id AND s.id=r.sheet_id
    WHERE r.business_id=$1 AND s.rate_date<$2::date ORDER BY r.metal,r.purity,s.rate_date DESC,s.created_at DESC,s.id DESC`, [business.id, day])).map(shapeRate));
  const sheets = await repo.one(db, 'SELECT count(*)::int AS n,max(created_at) AS last_at FROM jewellery_rate_sheets WHERE business_id=$1 AND rate_date=$2::date', [business.id, day]);
  const seller = await repo.one(db, 'SELECT display_name,legal_name,phone,city FROM business_settings WHERE business_id=$1', [business.id]);
  const rated = new Set(rows.map((r) => `${r.metal}:${r.purity}`));
  return { day, rates: rows, previous: before, sheets: sheets.n, lastSetAt: sheets.last_at, seller,
    notRated: c.ALL_PURITIES.filter((p) => !rated.has(`${p.metal}:${p.purity}`)).map((p) => ({ metal: p.metal, purity: p.purity, label: p.label })),
    purities: c.ALL_PURITIES, sessions: SESSIONS.map((s) => ({ value: s, label: SESSION_WORDS[s] })), sources: SOURCES.map((s) => ({ value: s, label: SOURCE_WORDS[s] })) };
}

async function today(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  return todayRates(repo.pool, business);
}

// body: { requestKey, session, source, note?, rates: [{ metal, purity, sellRate, buyRate? }] }
function readSheet(body) {
  const session = v.requiredEnum(body.session, 'Session', SESSIONS);
  const source = v.requiredEnum(body.source ?? 'shop', 'Where the rates come from', SOURCES);
  const list = v.requiredArray(body.rates, 'Rates');
  if (!list.length) fail('Give the rate of at least one purity');
  if (list.length > c.ALL_PURITIES.length) fail('Each purity is rated once');
  const rates = list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Rate ${index + 1} must be an object`);
    const { metal, purity } = c.readPurity(raw.metal, raw.purity);
    const words = c.purityWords(metal, purity);
    const sellRate = c.readRate(raw.sellRate, `${words}: selling rate per gram`);
    const buyRate = c.given(raw.buyRate) ? c.readRate(raw.buyRate, `${words}: old ${c.METAL_WORDS[metal].toLowerCase()} rate per gram`) : null;
    return { metal, purity, sellRate, buyRate };
  });
  const keys = rates.map((r) => `${r.metal}:${r.purity}`);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) fail(`${c.purityWords(...twice.split(':'))} is rated twice on this sheet`);
  return { session, source, note: c.optionalText(body.note, 'Note', 300), rates };
}

async function setRates(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const sheet = readSheet(body);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_rate_sheets WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return todayRates(db, business);
    }
    const row = await repo.one(db, `INSERT INTO jewellery_rate_sheets(business_id,session,source,note,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,rate_date::text AS rate_date`, [business.id, sheet.session, sheet.source, sheet.note, requestKey, hash, user.id]);
    for (const r of sheet.rates) {
      await db.query('INSERT INTO jewellery_rates(business_id,sheet_id,metal,purity,sell_rate,buy_rate) VALUES($1,$2,$3,$4,$5,$6)',
        [business.id, row.id, r.metal, r.purity, r.sellRate.toFixed(2), r.buyRate === null ? null : r.buyRate.toFixed(2)]);
    }
    const figures = { day: row.rate_date, session: sheet.session, source: sheet.source,
      rates: sheet.rates.map((r) => ({ purity: c.purityWords(r.metal, r.purity), sell: r.sellRate.toFixed(2), buy: r.buyRate === null ? null : r.buyRate.toFixed(2) })) };
    await repo.audit(db, business.id, user.id, 'jewellery_rates.set', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_rates.set', 'jewellery_rate_sheet', row.id, { ...figures,
      rates: sheet.rates.map((r) => ({ metal: r.metal, purity: r.purity, sellRate: r.sellRate.toFixed(2), buyRate: r.buyRate === null ? null : r.buyRate.toFixed(2) })) });
    return todayRates(db, business);
  });
}

module.exports = { today, setRates, ratesNow, todayRates, SESSIONS, SOURCES, SESSION_WORDS, SOURCE_WORDS };
