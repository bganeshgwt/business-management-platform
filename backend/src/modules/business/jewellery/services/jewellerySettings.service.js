const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./jewelleryCommon');

// A jeweller's settings (Settings › Jewellery settings): how new tags are
// numbered, the hallmarking charge a new hallmarked piece starts with, the
// hallmarking rules the jewellery bill follows (whether the owner says the
// business's turnover is up to ₹40 lakh, left out of mandatory hallmarking,
// and for each location whether its district is under mandatory hallmarking,
// taken as so until the owner says), old gold: the deduction a new line
// starts with and any lower limit of the shop's own on cash paid out for old
// gold to one seller in a day, and the cash report: the shop's own alert
// level and whether the owner says it is a reporting entity under the PMLA.
// One row a business, made when the settings are first saved or the first tag
// is given; the defaults stand until then.

const { fail } = c;
const DEFAULTS = { tag_prefix: 'T', last_tag_no: 0, hallmark_charge: '0.00', turnover_exempt: false, turnover_confirmed_at: null, old_gold_deduction: '0.00',
  old_gold_cash_limit: null, cash_watch_level: null, reporting_entity: false, reporting_entity_at: null };

// Each location with what its owner said about its district (null: not said yet).
const locationsOf = (db, business) => repo.all(db, `SELECT l.id,l.name,l.active,j.district,j.mandatory_hallmarking,j.confirmed_at,u.name AS confirmed_by_name
  FROM business_locations l LEFT JOIN jewellery_locations j ON j.business_id=l.business_id AND j.location_id=l.id LEFT JOIN users u ON u.id=j.confirmed_by
  WHERE l.business_id=$1 ORDER BY l.active DESC,l.id`, [business.id]);

async function settingsOf(db, businessId) {
  const row = await repo.one(db, 'SELECT * FROM jewellery_settings WHERE business_id=$1', [businessId]);
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS, business_id: businessId, updated_at: null, updated_by: null };
}

function view(business, s, locations) {
  const pieces = require('./jewelleryPieces.service');
  const oldGold = require('./jewelleryOldGold.service');
  const words = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));
  const money = c.seesMoney(business);
  return { tagPrefix: s.tag_prefix, nextTag: `${s.tag_prefix}${String(Number(s.last_tag_no) + 1).padStart(5, '0')}`,
    hallmarkCharge: money ? Number(s.hallmark_charge).toFixed(2) : null, updatedAt: s.updated_at,
    oldGoldDeduction: Number(s.old_gold_deduction).toFixed(2),
    oldGoldCashLimit: money && s.old_gold_cash_limit !== null ? Number(s.old_gold_cash_limit).toFixed(2) : null,
    cashWatchLevel: money && s.cash_watch_level !== null ? Number(s.cash_watch_level).toFixed(2) : null, reportingEntity: s.reporting_entity,
    reportingEntityAt: s.reporting_entity_at,
    turnoverExempt: s.turnover_exempt, turnoverConfirmedAt: s.turnover_confirmed_at,
    locations: locations.map((l) => ({ id: l.id, name: l.name, active: l.active, district: l.district, confirmed: l.mandatory_hallmarking !== null,
      mandatory: l.mandatory_hallmarking ?? true, confirmedAt: l.confirmed_at, confirmedByName: l.confirmed_by_name })),
    exemptions: words(pieces.EXEMPTIONS), stoneKinds: words(pieces.STONE_KINDS), comesIn: words(pieces.COME_IN), purities: c.ALL_PURITIES,
    testMethods: words(oldGold.TEST_METHODS), idKinds: words(oldGold.ID_KINDS), declaration: oldGold.DECLARATION };
}

async function settings(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  return view(business, await settingsOf(repo.pool, business.id), await locationsOf(repo.pool, business));
}

// body: { tagPrefix? (up to 6 letters; empty: numbers only), hallmarkCharge?, turnoverExempt?,
//   locations?: [{ locationId, mandatory (true / false), district? }], oldGoldDeduction?, oldGoldCashLimit? (empty: none),
//   cashWatchLevel? (empty: none), reportingEntity? };
//   what is left out stays.
async function saveSettings(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'settings.edit');
  let prefix;
  if (body.tagPrefix !== undefined) {
    prefix = String(body.tagPrefix ?? '').trim().toUpperCase();
    if (!/^[A-Z]{0,6}$/.test(prefix)) fail('The letters a tag starts with are up to 6 letters (A to Z), or none');
  }
  const charge = body.hallmarkCharge === undefined ? undefined : c.decimal(body.hallmarkCharge, 'Hallmarking charge', 2, 0, 10000);
  const deduction = body.oldGoldDeduction === undefined ? undefined : c.decimal(body.oldGoldDeduction, 'The deduction on old gold', 2, 0, 99.99);
  // The shop's own lower limit on cash paid out for old gold to one seller in a day (null: none).
  let cashLimit;
  if (body.oldGoldCashLimit !== undefined) {
    cashLimit = c.given(body.oldGoldCashLimit) ? c.decimal(body.oldGoldCashLimit, 'The shop\'s cash limit for old gold', 2, 1, 199999.99) : null;
  }
  // The cash report's own alert level for one customer in a month (null: none), and whether the shop is a PMLA reporting entity.
  let watchLevel;
  if (body.cashWatchLevel !== undefined) {
    watchLevel = c.given(body.cashWatchLevel) ? c.decimal(body.cashWatchLevel, 'The shop\'s cash alert level', 2, 1, 999999.99) : null;
  }
  const reporting = body.reportingEntity === undefined ? undefined : v.requiredBoolean(body.reportingEntity, 'A reporting entity under the PMLA');
  if (charge !== undefined || deduction !== undefined || cashLimit !== undefined || watchLevel !== undefined || reporting !== undefined) await c.requireMoney(business);
  const exempt = body.turnoverExempt === undefined ? undefined : v.requiredBoolean(body.turnoverExempt, 'Exempt by turnover');
  const places = body.locations === undefined || body.locations === null ? [] : v.requiredArray(body.locations, 'Locations').map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Location ${index + 1} must be an object`);
    return { locationId: c.id(raw.locationId, 'Location'), mandatory: v.requiredBoolean(raw.mandatory, 'Under mandatory hallmarking'),
      district: c.optionalText(raw.district, 'District', 80) };
  });
  return repo.transaction(async (db) => {
    const before = await settingsOf(db, business.id);
    const next = { tag_prefix: prefix ?? before.tag_prefix, hallmark_charge: charge === undefined ? Number(before.hallmark_charge) : charge,
      turnover_exempt: exempt === undefined ? before.turnover_exempt : exempt,
      old_gold_deduction: deduction === undefined ? Number(before.old_gold_deduction) : deduction,
      old_gold_cash_limit: cashLimit === undefined ? (before.old_gold_cash_limit === null ? null : Number(before.old_gold_cash_limit)) : cashLimit,
      cash_watch_level: watchLevel === undefined ? (before.cash_watch_level === null ? null : Number(before.cash_watch_level)) : watchLevel,
      reporting_entity: reporting === undefined ? before.reporting_entity : reporting };
    const turnoverSaid = exempt !== undefined && exempt !== before.turnover_exempt;
    const reportingSaid = reporting !== undefined && reporting !== before.reporting_entity;
    const amount = (value) => (value === null ? null : value.toFixed(2));
    await db.query(`INSERT INTO jewellery_settings(business_id,tag_prefix,hallmark_charge,turnover_exempt,turnover_confirmed_by,turnover_confirmed_at,old_gold_deduction,old_gold_cash_limit,
        cash_watch_level,reporting_entity,reporting_entity_by,reporting_entity_at,updated_by)
      VALUES($1,$2,$3,$4,CASE WHEN $5 THEN $6::bigint END,CASE WHEN $5 THEN now() END,$7,$8,$9,$10,CASE WHEN $11 THEN $6::bigint END,CASE WHEN $11 THEN now() END,$6)
      ON CONFLICT (business_id) DO UPDATE SET tag_prefix=EXCLUDED.tag_prefix,hallmark_charge=EXCLUDED.hallmark_charge,turnover_exempt=EXCLUDED.turnover_exempt,
        turnover_confirmed_by=CASE WHEN $5 THEN $6::bigint ELSE jewellery_settings.turnover_confirmed_by END,
        turnover_confirmed_at=CASE WHEN $5 THEN now() ELSE jewellery_settings.turnover_confirmed_at END,old_gold_deduction=EXCLUDED.old_gold_deduction,
        old_gold_cash_limit=EXCLUDED.old_gold_cash_limit,cash_watch_level=EXCLUDED.cash_watch_level,reporting_entity=EXCLUDED.reporting_entity,
        reporting_entity_by=CASE WHEN $11 THEN $6::bigint ELSE jewellery_settings.reporting_entity_by END,
        reporting_entity_at=CASE WHEN $11 THEN now() ELSE jewellery_settings.reporting_entity_at END,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, next.tag_prefix, next.hallmark_charge.toFixed(2), next.turnover_exempt, turnoverSaid || (next.turnover_exempt && !before.turnover_confirmed_at), user.id,
      next.old_gold_deduction.toFixed(2), amount(next.old_gold_cash_limit), amount(next.cash_watch_level), next.reporting_entity,
      reportingSaid || (next.reporting_entity && !before.reporting_entity_at)]);
    const changedPlaces = [];
    for (const p of places) {
      access.requireLocation(business, p.locationId);
      const place = await repo.one(db, `SELECT l.id,l.name,j.mandatory_hallmarking,j.district FROM business_locations l
        LEFT JOIN jewellery_locations j ON j.business_id=l.business_id AND j.location_id=l.id WHERE l.business_id=$1 AND l.id=$2`, [business.id, p.locationId]);
      if (!place) fail('Location not found', 404);
      if (place.mandatory_hallmarking === p.mandatory && (place.district || null) === p.district) continue;
      await db.query(`INSERT INTO jewellery_locations(business_id,location_id,district,mandatory_hallmarking,confirmed_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (business_id,location_id) DO UPDATE SET district=EXCLUDED.district,mandatory_hallmarking=EXCLUDED.mandatory_hallmarking,confirmed_by=EXCLUDED.confirmed_by,confirmed_at=now()`,
      [business.id, place.id, p.district, p.mandatory, user.id]);
      changedPlaces.push({ location: place.name, from: place.mandatory_hallmarking, to: p.mandatory, district: p.district });
    }
    const limitText = (value) => (value === null || value === undefined ? null : Number(value).toFixed(2));
    await repo.audit(db, business.id, user.id, 'jewellery_settings.updated', business.id, {
      from: { tagPrefix: before.tag_prefix, hallmarkCharge: Number(before.hallmark_charge).toFixed(2), turnoverExempt: before.turnover_exempt,
        oldGoldDeduction: Number(before.old_gold_deduction).toFixed(2), oldGoldCashLimit: limitText(before.old_gold_cash_limit), cashWatchLevel: limitText(before.cash_watch_level),
        reportingEntity: before.reporting_entity },
      to: { tagPrefix: next.tag_prefix, hallmarkCharge: next.hallmark_charge.toFixed(2), turnoverExempt: next.turnover_exempt,
        oldGoldDeduction: next.old_gold_deduction.toFixed(2), oldGoldCashLimit: limitText(next.old_gold_cash_limit), cashWatchLevel: limitText(next.cash_watch_level),
        reportingEntity: next.reporting_entity },
      ...(changedPlaces.length ? { districts: changedPlaces } : {}) });
    return view(business, await settingsOf(db, business.id), await locationsOf(db, business));
  });
}

module.exports = { settingsOf, settings, saveSettings };
