const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');

// The shop's offers on making (module "jewellery"): a percentage off the
// making charge of the pieces of one metal (or every metal) billed between two
// days of the business's clock, by the shop's own rule (Akshaya Tritiya,
// Dhanteras, a wedding season). The jewellery bill gives each piece the best
// offer running on its day for its metal, and prints it as such. An offer's
// terms never change (a new one is made); it is switched off, never deleted.
// Money is for those who see sales.

const { fail, id } = c;
const MAX_DAYS = 366;

const OFFERS_SQL = `SELECT o.id,o.name,o.making_percent,o.metal,o.starts_on::text AS starts_on,o.ends_on::text AS ends_on,o.active,o.created_at,u.name AS by_name,
    (o.active AND o.starts_on<=(now() AT TIME ZONE b.timezone)::date AND o.ends_on>=(now() AT TIME ZONE b.timezone)::date) AS running,
    (SELECT count(*)::int FROM jewellery_bill_lines l WHERE l.business_id=o.business_id AND l.offer_id=o.id) AS pieces,
    COALESCE((SELECT sum(l.offer_discount) FROM jewellery_bill_lines l WHERE l.business_id=o.business_id AND l.offer_id=o.id),0) AS given
  FROM jewellery_offers o JOIN businesses b ON b.id=o.business_id JOIN users u ON u.id=o.created_by WHERE o.business_id=$1`;
const shape = (o) => ({ ...o, metal_words: o.metal ? c.METAL_WORDS[o.metal] : 'Every metal' });
const listIn = async (db, business) => ({ today: await c.today(db, business),
  items: (await repo.all(db, `${OFFERS_SQL} ORDER BY o.active DESC,o.starts_on DESC,o.id DESC`, [business.id])).map(shape) });

async function list(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  return listIn(repo.pool, business);
}

// body: { requestKey, name, makingPercent (more than 0, up to 100), metal? (none: every metal), startsOn, endsOn }
async function create(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const name = v.requiredString(body.name, 'Offer name', 80);
  const percent = c.decimal(body.makingPercent, 'Off the making charge (%)', 2, 0.01, 100);
  const metal = c.given(body.metal) ? v.requiredEnum(body.metal, 'Metal', c.METALS) : null;
  const startsOn = c.readDate(body.startsOn, 'From');
  const endsOn = c.readDate(body.endsOn, 'Until');
  if (endsOn < startsOn) fail('The offer ends on or after the day it starts');
  if (c.daysBetween(startsOn, endsOn) >= MAX_DAYS) fail('An offer runs for at most a year');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_offers WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return listIn(db, business);
    }
    if (endsOn < await c.today(db, business)) fail('The offer ends today or later');
    const row = await repo.one(db, `INSERT INTO jewellery_offers(business_id,name,making_percent,metal,starts_on,ends_on,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`, [business.id, name, percent.toFixed(2), metal, startsOn, endsOn, requestKey, hash, user.id]);
    const figures = { name, makingPercent: percent.toFixed(2), metal, startsOn, endsOn };
    await repo.audit(db, business.id, user.id, 'jewellery_offer.created', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_offer.created', 'jewellery_offer', row.id, figures);
    return listIn(db, business);
  });
}

// body: { active }. An offer switched off gives no more discounts; its bills keep theirs.
async function setActive(business, user, offerId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await c.requireMoney(business);
  const active = v.requiredBoolean(body.active, 'Active');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const offer = await repo.one(db, 'SELECT id,name,active FROM jewellery_offers WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(offerId, 'Offer')]);
    if (!offer) fail('Offer not found', 404);
    if (offer.active !== active) {
      await db.query('UPDATE jewellery_offers SET active=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, offer.id, active, user.id]);
      await repo.audit(db, business.id, user.id, 'jewellery_offer.updated', offer.id, { name: offer.name, from: { active: offer.active }, to: { active } });
    }
    return listIn(db, business);
  });
}

// The offers running on a day (the business's date), inside the caller's connection.
const running = (db, business, day) => repo.all(db, `SELECT id,name,making_percent,metal FROM jewellery_offers WHERE business_id=$1 AND active
  AND starts_on<=$2::date AND ends_on>=$2::date ORDER BY making_percent DESC,id`, [business.id, day]);
// The best of them for a metal, as the database checks it: the largest percentage, then the oldest.
const bestFor = (offers, metal) => offers.find((o) => !o.metal || o.metal === metal) || null;

module.exports = { list, create, setActive, running, bestFor };
