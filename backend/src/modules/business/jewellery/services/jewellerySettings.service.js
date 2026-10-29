const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./jewelleryCommon');

// A jeweller's settings (Settings › Jewellery settings): how new tags are
// numbered, the hallmarking charge a new hallmarked piece starts with, the
// hallmarking rules the jewellery bill follows (whether the owner says the
// business's turnover is up to ₹40 lakh, left out of mandatory hallmarking,
// and for each location whether its district is under mandatory hallmarking,
// taken as so until the owner says), the rate sessions the shop names beyond
// morning and evening, old gold: its buy-back rules (the deduction a line of
// outside old gold starts with, one for each purity where the shop keeps one,
// and one for the shop's own pieces bought back) and any lower limit of the
// shop's own on cash paid out for old gold to one seller in a day, the cash
// report: the shop's own alert levels and whether the owner says it is a
// reporting entity under the PMLA, the KYC documents it accepts, whether a
// counter discount may come off the metal's value, and a company's net worth
// with its date (its gold schemes' money is held against 25% of it). One row a
// business, made when the settings are first saved or the first tag is given;
// the defaults stand until then.

const { fail } = c;
const DEFAULTS = { tag_prefix: 'T', last_tag_no: 0, hallmark_charge: '0.00', turnover_exempt: false, turnover_confirmed_at: null, old_gold_deduction: '0.00',
  old_gold_cash_limit: null, reporting_entity: false, reporting_entity_at: null, rate_sessions: [], own_piece_deduction: null, cash_alert_levels: [], kyc_kinds: [],
  discount_on_metal: false, company_net_worth: null, net_worth_on: null };
// The sessions every shop has; the shop names any others.
const BUILT_IN_SESSIONS = ['morning', 'evening'];
const MAX_SESSIONS = 8;
const MAX_LEVELS = 5;
const MAX_KYC_KINDS = 20;

// Each location with what its owner said about its district (null: not said yet).
const locationsOf = (db, business) => repo.all(db, `SELECT l.id,l.name,l.active,j.district,j.mandatory_hallmarking,j.confirmed_at,u.name AS confirmed_by_name
  FROM business_locations l LEFT JOIN jewellery_locations j ON j.business_id=l.business_id AND j.location_id=l.id LEFT JOIN users u ON u.id=j.confirmed_by
  WHERE l.business_id=$1 ORDER BY l.active DESC,l.id`, [business.id]);
// The deduction on outside old gold of each purity the shop keeps one for.
const purityDeductionsOf = (db, business) => repo.all(db, 'SELECT metal,purity,deduction_percent FROM jewellery_buyback_deductions WHERE business_id=$1', [business.id]);

async function settingsOf(db, businessId) {
  const row = await repo.one(db, 'SELECT * FROM jewellery_settings WHERE business_id=$1', [businessId]);
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS, business_id: businessId, updated_at: null, updated_by: null };
}

// The buy-back rule for a line of old gold: the shop's own piece's deduction
// (when the article is one it sold and the shop keeps that rule), else its
// purity's, else the general one; as the database checks it.
function buybackRule(settings, purityDeductions, { metal, purity, ownPiece }) {
  if (ownPiece && settings.own_piece_deduction !== null && settings.own_piece_deduction !== undefined) {
    return { rule: 'own_piece', percent: Number(settings.own_piece_deduction) };
  }
  const own = purityDeductions.find((d) => d.metal === metal && d.purity === purity);
  if (own) return { rule: 'purity', percent: Number(own.deduction_percent) };
  return { rule: 'general', percent: Number(settings.old_gold_deduction || 0) };
}
const RULE_WORDS = { own_piece: 'The shop\'s own piece bought back', purity: 'Outside jewellery of this purity', general: 'The shop\'s general deduction' };

const money2 = (value) => (value === null || value === undefined ? null : Number(value).toFixed(2));

function view(business, s, locations, purityDeductions) {
  const pieces = require('./jewelleryPieces.service');
  const oldGold = require('./jewelleryOldGold.service');
  const kyc = require('./jewelleryKyc.service');
  const words = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));
  const money = c.seesMoney(business);
  return { tagPrefix: s.tag_prefix, nextTag: `${s.tag_prefix}${String(Number(s.last_tag_no) + 1).padStart(5, '0')}`,
    hallmarkCharge: money ? Number(s.hallmark_charge).toFixed(2) : null, updatedAt: s.updated_at,
    oldGoldDeduction: Number(s.old_gold_deduction).toFixed(2),
    ownPieceDeduction: money2(s.own_piece_deduction),
    purityDeductions: c.ALL_PURITIES.map((p) => {
      const kept = purityDeductions.find((d) => d.metal === p.metal && d.purity === p.purity);
      return { metal: p.metal, purity: p.purity, label: p.label, deductionPercent: kept ? Number(kept.deduction_percent).toFixed(2) : null };
    }),
    oldGoldCashLimit: money && s.old_gold_cash_limit !== null ? Number(s.old_gold_cash_limit).toFixed(2) : null,
    cashAlertLevels: money ? (s.cash_alert_levels || []).map((level) => Number(level).toFixed(2)) : [],
    reportingEntity: s.reporting_entity, reportingEntityAt: s.reporting_entity_at,
    turnoverExempt: s.turnover_exempt, turnoverConfirmedAt: s.turnover_confirmed_at,
    rateSessions: s.rate_sessions || [],
    kycKinds: s.kyc_kinds || [],
    discountOnMetal: Boolean(s.discount_on_metal),
    companyNetWorth: money ? money2(s.company_net_worth) : null, netWorthOn: money && s.net_worth_on ? String(s.net_worth_on).slice(0, 10) : null,
    locations: locations.map((l) => ({ id: l.id, name: l.name, active: l.active, district: l.district, confirmed: l.mandatory_hallmarking !== null,
      mandatory: l.mandatory_hallmarking ?? true, confirmedAt: l.confirmed_at, confirmedByName: l.confirmed_by_name })),
    exemptions: words(pieces.EXEMPTIONS), stoneKinds: words(pieces.STONE_KINDS), comesIn: words(pieces.COME_IN), purities: c.ALL_PURITIES,
    testMethods: words(oldGold.TEST_METHODS), idKinds: words(oldGold.ID_KINDS), declaration: oldGold.DECLARATION, ruleWords: RULE_WORDS,
    kycAadhaar: kyc.AADHAAR_RULE };
}

async function settings(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const [s, locations, deductions] = await c.inTurn(() => settingsOf(repo.pool, business.id), () => locationsOf(repo.pool, business), () => purityDeductionsOf(repo.pool, business));
  return view(business, s, locations, deductions);
}

// A list of names as typed: trimmed, at most so many, each at most so long, none twice.
function readNames(value, name, { most, longest, reserved = [] }) {
  const list = v.requiredArray(value, name).map((x) => String(x ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (list.length > most) fail(`${name}: at most ${most}`);
  for (const x of list) {
    if (x.length > longest) fail(`${name}: "${x}" is longer than ${longest} letters`);
    if (reserved.includes(x.toLowerCase())) fail(`${name}: ${x} is one every shop has already`);
  }
  const twice = list.find((x, i) => list.findIndex((y) => y.toLowerCase() === x.toLowerCase()) !== i);
  if (twice) fail(`${name}: ${twice} is there twice`);
  return list;
}

// body: { tagPrefix? (up to 6 letters; empty: numbers only), hallmarkCharge?, turnoverExempt?,
//   locations?: [{ locationId, mandatory (true / false), district? }], oldGoldDeduction?, oldGoldCashLimit? (empty: none),
//   ownPieceDeduction? (empty: none), purityDeductions?: [{ metal, purity, deductionPercent }] (all the purities' own; the rest take the general),
//   cashAlertLevels?: [amounts below ₹10 lakh] (up to 5), reportingEntity?, rateSessions?: [names] (up to 8), kycKinds?: [names] (up to 20),
//   discountOnMetal?, companyNetWorth? (empty: none) with netWorthOn };
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
  const ownDeduction = body.ownPieceDeduction === undefined ? undefined
    : c.given(body.ownPieceDeduction) ? c.decimal(body.ownPieceDeduction, 'The deduction on the shop\'s own pieces', 2, 0, 99.99) : null;
  let purityDeductions;
  if (body.purityDeductions !== undefined) {
    purityDeductions = v.requiredArray(body.purityDeductions ?? [], 'Deductions by purity').filter((raw) => raw && c.given(raw.deductionPercent)).map((raw, index) => {
      if (typeof raw !== 'object' || Array.isArray(raw)) fail(`Deduction ${index + 1} must be an object`);
      const { metal, purity } = c.readPurity(raw.metal, raw.purity);
      return { metal, purity, percent: c.decimal(raw.deductionPercent, `${c.purityWords(metal, purity)}: deduction`, 2, 0, 99.99) };
    });
    const keys = purityDeductions.map((d) => `${d.metal}:${d.purity}`);
    if (new Set(keys).size !== keys.length) fail('A purity has one deduction');
  }
  // The shop's own lower limit on cash paid out for old gold to one seller in a day (null: none).
  let cashLimit;
  if (body.oldGoldCashLimit !== undefined) {
    cashLimit = c.given(body.oldGoldCashLimit) ? c.decimal(body.oldGoldCashLimit, 'The shop\'s cash limit for old gold', 2, 1, 199999.99) : null;
  }
  // The cash report's own alert levels for one customer in a month (lowest first), and whether the shop is a PMLA reporting entity.
  let levels;
  if (body.cashAlertLevels !== undefined) {
    levels = v.requiredArray(body.cashAlertLevels ?? [], 'Cash alert levels').filter((x) => c.given(x))
      .map((x, index) => c.decimal(x, `Cash alert level ${index + 1}`, 2, 1, 999999.99));
    if (levels.length > MAX_LEVELS) fail(`The cash report keeps at most ${MAX_LEVELS} alert levels`);
    if (new Set(levels).size !== levels.length) fail('An alert level is there twice');
    levels.sort((a, b) => a - b);
  }
  const reporting = body.reportingEntity === undefined ? undefined : v.requiredBoolean(body.reportingEntity, 'A reporting entity under the PMLA');
  const sessions = body.rateSessions === undefined ? undefined
    : readNames(body.rateSessions ?? [], 'Rate sessions', { most: MAX_SESSIONS, longest: 40, reserved: BUILT_IN_SESSIONS });
  const kycKinds = body.kycKinds === undefined ? undefined : readNames(body.kycKinds ?? [], 'KYC documents accepted', { most: MAX_KYC_KINDS, longest: 60 });
  const onMetal = body.discountOnMetal === undefined ? undefined : v.requiredBoolean(body.discountOnMetal, 'A counter discount on the metal');
  let netWorth;
  if (body.companyNetWorth !== undefined || body.netWorthOn !== undefined) {
    if (c.given(body.companyNetWorth)) {
      const amount = c.decimal(body.companyNetWorth, 'The company\'s net worth', 2, 1, 99999999999999);
      if (!c.given(body.netWorthOn)) fail('Give the date the net worth is as of (its balance sheet\'s)');
      netWorth = { amount, on: c.readDate(body.netWorthOn, 'Net worth as of') };
    } else {
      netWorth = null;
    }
  }
  if (charge !== undefined || deduction !== undefined || cashLimit !== undefined || levels !== undefined || reporting !== undefined || ownDeduction !== undefined
    || purityDeductions !== undefined || onMetal !== undefined || netWorth !== undefined) await c.requireMoney(business);
  const exempt = body.turnoverExempt === undefined ? undefined : v.requiredBoolean(body.turnoverExempt, 'Exempt by turnover');
  const places = body.locations === undefined || body.locations === null ? [] : v.requiredArray(body.locations, 'Locations').map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Location ${index + 1} must be an object`);
    return { locationId: c.id(raw.locationId, 'Location'), mandatory: v.requiredBoolean(raw.mandatory, 'Under mandatory hallmarking'),
      district: c.optionalText(raw.district, 'District', 80) };
  });
  return repo.transaction(async (db) => {
    const before = await settingsOf(db, business.id);
    if (netWorth && netWorth.on > await c.today(db, business)) fail('The net worth is as of a day that has passed');
    const keepLevels = () => (before.cash_alert_levels || []).map(Number);
    const next = { tag_prefix: prefix ?? before.tag_prefix, hallmark_charge: charge === undefined ? Number(before.hallmark_charge) : charge,
      turnover_exempt: exempt === undefined ? before.turnover_exempt : exempt,
      old_gold_deduction: deduction === undefined ? Number(before.old_gold_deduction) : deduction,
      old_gold_cash_limit: cashLimit === undefined ? (before.old_gold_cash_limit === null ? null : Number(before.old_gold_cash_limit)) : cashLimit,
      own_piece_deduction: ownDeduction === undefined ? (before.own_piece_deduction === null ? null : Number(before.own_piece_deduction)) : ownDeduction,
      cash_alert_levels: levels === undefined ? keepLevels() : levels,
      reporting_entity: reporting === undefined ? before.reporting_entity : reporting,
      rate_sessions: sessions === undefined ? before.rate_sessions || [] : sessions,
      kyc_kinds: kycKinds === undefined ? before.kyc_kinds || [] : kycKinds,
      discount_on_metal: onMetal === undefined ? Boolean(before.discount_on_metal) : onMetal,
      company_net_worth: netWorth === undefined ? (before.company_net_worth === null ? null : Number(before.company_net_worth)) : netWorth?.amount ?? null,
      net_worth_on: netWorth === undefined ? (before.net_worth_on ? String(before.net_worth_on).slice(0, 10) : null) : netWorth?.on ?? null };
    const turnoverSaid = exempt !== undefined && exempt !== before.turnover_exempt;
    const reportingSaid = reporting !== undefined && reporting !== before.reporting_entity;
    const amount = (value) => (value === null ? null : value.toFixed(2));
    await db.query(`INSERT INTO jewellery_settings(business_id,tag_prefix,hallmark_charge,turnover_exempt,turnover_confirmed_by,turnover_confirmed_at,old_gold_deduction,old_gold_cash_limit,
        cash_alert_levels,reporting_entity,reporting_entity_by,reporting_entity_at,updated_by,own_piece_deduction,rate_sessions,kyc_kinds,discount_on_metal,company_net_worth,net_worth_on)
      VALUES($1,$2,$3,$4,CASE WHEN $5 THEN $6::bigint END,CASE WHEN $5 THEN now() END,$7,$8,$9,$10,CASE WHEN $11 THEN $6::bigint END,CASE WHEN $11 THEN now() END,$6,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (business_id) DO UPDATE SET tag_prefix=EXCLUDED.tag_prefix,hallmark_charge=EXCLUDED.hallmark_charge,turnover_exempt=EXCLUDED.turnover_exempt,
        turnover_confirmed_by=CASE WHEN $5 THEN $6::bigint ELSE jewellery_settings.turnover_confirmed_by END,
        turnover_confirmed_at=CASE WHEN $5 THEN now() ELSE jewellery_settings.turnover_confirmed_at END,old_gold_deduction=EXCLUDED.old_gold_deduction,
        old_gold_cash_limit=EXCLUDED.old_gold_cash_limit,cash_alert_levels=EXCLUDED.cash_alert_levels,reporting_entity=EXCLUDED.reporting_entity,
        reporting_entity_by=CASE WHEN $11 THEN $6::bigint ELSE jewellery_settings.reporting_entity_by END,
        reporting_entity_at=CASE WHEN $11 THEN now() ELSE jewellery_settings.reporting_entity_at END,updated_by=EXCLUDED.updated_by,updated_at=now(),
        own_piece_deduction=EXCLUDED.own_piece_deduction,rate_sessions=EXCLUDED.rate_sessions,kyc_kinds=EXCLUDED.kyc_kinds,discount_on_metal=EXCLUDED.discount_on_metal,
        company_net_worth=EXCLUDED.company_net_worth,net_worth_on=EXCLUDED.net_worth_on`,
    [business.id, next.tag_prefix, next.hallmark_charge.toFixed(2), next.turnover_exempt, turnoverSaid || (next.turnover_exempt && !before.turnover_confirmed_at), user.id,
      next.old_gold_deduction.toFixed(2), amount(next.old_gold_cash_limit), next.cash_alert_levels.map((x) => x.toFixed(2)), next.reporting_entity,
      reportingSaid || (next.reporting_entity && !before.reporting_entity_at), amount(next.own_piece_deduction), next.rate_sessions, next.kyc_kinds, next.discount_on_metal,
      amount(next.company_net_worth), next.net_worth_on]);
    const beforeDeductions = await purityDeductionsOf(db, business);
    if (purityDeductions !== undefined) {
      await db.query('DELETE FROM jewellery_buyback_deductions WHERE business_id=$1', [business.id]);
      for (const d of purityDeductions) {
        await db.query('INSERT INTO jewellery_buyback_deductions(business_id,metal,purity,deduction_percent,updated_by) VALUES($1,$2,$3,$4,$5)',
          [business.id, d.metal, d.purity, d.percent.toFixed(2), user.id]);
      }
    }
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
    const deductionsText = (rows) => rows.map((d) => `${c.purityWords(d.metal, d.purity)} ${Number(d.deduction_percent ?? d.percent).toFixed(2)}%`).sort();
    await repo.audit(db, business.id, user.id, 'jewellery_settings.updated', business.id, {
      from: { tagPrefix: before.tag_prefix, hallmarkCharge: Number(before.hallmark_charge).toFixed(2), turnoverExempt: before.turnover_exempt,
        oldGoldDeduction: Number(before.old_gold_deduction).toFixed(2), oldGoldCashLimit: limitText(before.old_gold_cash_limit),
        ownPieceDeduction: limitText(before.own_piece_deduction), purityDeductions: deductionsText(beforeDeductions),
        cashAlertLevels: (before.cash_alert_levels || []).map(limitText), reportingEntity: before.reporting_entity, rateSessions: before.rate_sessions || [],
        kycKinds: before.kyc_kinds || [], discountOnMetal: Boolean(before.discount_on_metal), companyNetWorth: limitText(before.company_net_worth),
        netWorthOn: before.net_worth_on ? String(before.net_worth_on).slice(0, 10) : null },
      to: { tagPrefix: next.tag_prefix, hallmarkCharge: next.hallmark_charge.toFixed(2), turnoverExempt: next.turnover_exempt,
        oldGoldDeduction: next.old_gold_deduction.toFixed(2), oldGoldCashLimit: limitText(next.old_gold_cash_limit), ownPieceDeduction: limitText(next.own_piece_deduction),
        purityDeductions: purityDeductions === undefined ? deductionsText(beforeDeductions) : deductionsText(purityDeductions),
        cashAlertLevels: next.cash_alert_levels.map(limitText), reportingEntity: next.reporting_entity, rateSessions: next.rate_sessions, kycKinds: next.kyc_kinds,
        discountOnMetal: next.discount_on_metal, companyNetWorth: limitText(next.company_net_worth), netWorthOn: next.net_worth_on },
      ...(changedPlaces.length ? { districts: changedPlaces } : {}) });
    return view(business, await settingsOf(db, business.id), await locationsOf(db, business), await purityDeductionsOf(db, business));
  });
}

module.exports = { settingsOf, settings, saveSettings, buybackRule, purityDeductionsOf, RULE_WORDS, BUILT_IN_SESSIONS };
