const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');
const licences = require('../../licences/services/businessLicences.service');
const records = require('../../licences/services/licenceRecords.service');
const buyers = require('./agriBuyers.service');
const overrides = require('./agriOverrides.service');

// A seeds, fertilisers & pesticides shop's bill, inside the sale's own
// posting (business.service.js › postDocument, which calls here for a sale of
// a farm-input shop with its tools on):
//   checkSale    before anything is saved: every fertiliser, seed, pesticide
//                and bio-input line is checked, and what the bill keeps is
//                worked out (a line refused refuses the whole bill)
//   checkCredit  once the payments are known: a season goes on a named
//                customer's bill on credit, within the season's limit
//   recordSale   after the bill and its lines are saved: agri_sale_lines,
//                agri_bills, the overrides used, the activity log and the outbox
// and checkPurchase for a receipt of stock, and invoiceExtras for what the
// bill shows and prints.
//
// Each line, by the kind of input its item is:
//   - an item made of a banned molecule is never sold, nor one of a molecule
//     allowed in one formulation only (carbofuran, 3% CG) in another;
//   - a fertiliser, seed or pesticide needs a licence in force covering it at
//     the selling location today, while Licences & registrations is on: for
//     wholesale sales when the buyer has a GSTIN (a B2B invoice), else for
//     retail sales. A licence past its date that stays in force while its
//     renewal is pending bills with a warning; an insecticide not endorsed on
//     the licence, or whose manufacturer's principal certificate is missing,
//     withdrawn or out of date, warns or stops as the shop's setting says;
//   - a seed lot past its validity (its batch's expiry), or any other batch
//     past its expiry, is not sold;
//   - a molecule barred on some crops needs the crop the farmer is buying for
//     (the line's own, or the bill's), and is refused for a barred crop or a
//     crop in a barred group (a tomato among vegetables);
//   - a pesticide whose label names its approved crops warns for a crop not
//     on it (nor in a group on it);
//   - a restricted-use pesticide (aluminium phosphide, methyl bromide, DDT,
//     the cypermethrin smoke generator) goes only to a customer tagged as a
//     pest-control operator or a government body in force, or on a manager's
//     override when the shop's setting allows one;
//   - a subsidised fertiliser needs the receipt number the government's PoS
//     device printed (the line's own, or the bill's), and a named farmer's
//     subsidised bags this month are held to the limit of the location's state
//     (a warning near it; over it, a stop or a manager's override, as the
//     shop's setting says). No Aadhaar number is ever asked for or kept;
//   - sulphur is sold with its buyer's name and address (rule 10B).
// The database repeats these rules where the line is kept (agri_sale_line_check),
// all but the endorsement, label, bag and sulphur checks.
// Warnings go back with the posted bill and into its activity log.

const { fail, SEASONS, SEASON_WORDS, LICENCE_FOR, LICENCE_WORDS, KIND_WORDS, normal, classification, dateWords, listWords, paise } = common;
const RECEIPT = /^[A-Za-z0-9/-]{3,40}$/;
const blank = (value) => value === undefined || value === null || value === '';
const money = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const seasonWords = (season, year) => `${SEASON_WORDS[season] || season} ${year}`;
// A refusal the counter acts on (data.reason), with the override it may ask for.
const stop = (message, details) => { throw new AppError(409, message, details); };

// Whether a body carries farm-input details, on the bill or on a line.
function given(body) {
  return !blank(body?.agri) || (Array.isArray(body?.lines) && body.lines.some((l) => l && typeof l === 'object' && (!blank(l.crop) || !blank(l.posReceipt))));
}

function readReceipt(value) {
  if (blank(value)) return null;
  const text = v.requiredString(value, 'PoS receipt number', 40).replace(/\s+/g, '');
  if (!RECEIPT.test(text)) fail('The PoS receipt number is as the PoS device prints it: letters, digits, - and / only');
  return text;
}
const readCrop = (value) => (blank(value) ? null : v.requiredString(value, 'Crop', 100).replace(/\s+/g, ' '));

// The bill's own details: the PoS receipt and the crop for every line that
// gives none of its own; a credit bill's season (its credit, or a season, its
// year and the harvest due date); a walk-in farmer's village; the manager's
// overrides it uses.
function readBill(body, contact, today) {
  const raw = body.agri;
  const none = { posReceipt: null, crop: null, season: null, seasonYear: null, dueOn: null, seasonCreditId: null, village: null, overrideIds: [] };
  if (blank(raw)) return none;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('The farm-input details must be an object');
  const seasonCreditId = blank(raw.seasonCreditId) ? null : v.requiredId(raw.seasonCreditId, 'Season credit');
  const season = blank(raw.season) ? null : v.requiredEnum(raw.season, 'Season', SEASONS);
  const parts = [season, raw.seasonYear, raw.dueOn].filter((x) => !blank(x));
  if (!seasonCreditId && parts.length && parts.length < 3) fail('Give the season, its year and the harvest due date together');
  let seasonYear = null, dueOn = null;
  if (season) {
    seasonYear = v.requiredId(raw.seasonYear, 'Season year');
    const year = Number(today.slice(0, 4));
    if (seasonYear < year - 1 || seasonYear > year + 1) fail(`The season's year is ${year - 1}, ${year} or ${year + 1}`);
  }
  if (!blank(raw.dueOn)) {
    dueOn = common.readDate(raw.dueOn, 'Harvest due date');
    if (dueOn < today) fail('The harvest due date is today or later');
    if (common.daysBetween(today, dueOn) > 400) fail('The harvest due date is at most 400 days away');
  }
  const village = blank(raw.village) ? null : v.requiredString(raw.village, 'Village', 100);
  if (village && contact) fail('A named customer\'s village is kept with their farmer details, not on the bill');
  const overrideIds = blank(raw.overrideIds) ? [] : v.requiredArray(raw.overrideIds, 'Overrides').map((x) => v.requiredId(x, 'Override'));
  if (overrideIds.length > 2) fail('Name one override of each kind on a bill');
  return { posReceipt: readReceipt(raw.posReceipt), crop: readCrop(raw.crop), season, seasonYear, dueOn, seasonCreditId, village, overrideIds };
}

// The shop's settings: whether an insecticide not endorsed on the licence,
// or without its principal's certificate in force, warns or stops.
async function endorsementCheck(db, business) {
  return (await common.settingsOf(db, business)).endorsement_check;
}

// The licence checks of one farm-input line, by its category: a stop (no
// licence in force for this kind of sale, or an endorsement check the shop
// blocks on) or warnings (in force only while its renewal is pending; an
// endorsement check the shop warns on). cache: one per bill.
async function licenceCheck(db, business, cache, { location, trade, today, sku, label, kind }) {
  const category = LICENCE_FOR[kind];
  if (!category || !business.modules.includes('licences')) return { stop: null, warnings: [] };
  const words = LICENCE_WORDS[category];
  if (!cache.standings.has(category)) cache.standings.set(category, await licences.standing(db, business, { locationId: location.id, category, on: today, trade }));
  const held = cache.standings.get(category);
  if (!held?.in_force) return { stop: `${label} is a ${KIND_WORDS[kind]}, and ${licences.whyNot(held, words, location.name, trade)}. Add or renew it under Settings › Licences, then bill it.`, warnings: [] };
  const warnings = [];
  if (held.by_renewal && !cache.pendingSaid.has(held.id)) {
    cache.pendingSaid.add(held.id);
    warnings.push(licences.pendingWords(held, words, location.name));
  }
  if (category === 'insecticide') {
    const note = await records.insecticideNote(db, business, { licence: held, sku, label, on: today, locationName: location.name });
    if (note) {
      if (cache.setting === undefined) cache.setting = await endorsementCheck(db, business);
      if (cache.setting === 'block') return { stop: `${note.message}.`, warnings };
      warnings.push(`${note.message}.`);
    }
  }
  return { stop: null, warnings };
}
const newCache = () => ({ standings: new Map(), pendingSaid: new Set(), setting: undefined });
// A sale to a buyer with a GSTIN is a B2B invoice: a wholesale sale.
const tradeOf = (contact) => (contact?.gstin ? 'wholesale' : 'retail');

// The molecules an item lists that the master knows.
const listedOf = (byName, item) => item.molecules.map((name) => byName.get(normal(name))).filter(Boolean);
// A molecule allowed in one formulation, on an item of another (null: none).
const wrongFormulation = (listed, item) => listed.find((m) => m.only_formulation && common.formulaKey(m.only_formulation) !== common.formulaKey(item.formulation)) || null;
const formulationWords = (label, m, item) => `${label} contains ${m.name}, which is sold only as its ${m.only_formulation} formulation (${m.source}); `
  + `this item is ${item.formulation ? `${item.formulation}` : 'of no formulation given'}. It cannot be sold.`;
// The restricted-use molecules an item is sold under (none: anyone may buy it).
const restrictedOf = (listed, item) => listed.filter((m) => m.users_only
  && (!m.users_formulation || common.formulaKey(item.formulation).includes(common.formulaKey(m.users_formulation))));
// The rule in words, inside a sentence: "used only by government bodies …", without its full stop.
const ruleWords = (m) => (m.restriction ? `${m.restriction.charAt(0).toLowerCase()}${m.restriction.slice(1).replace(/.$/, '')}` : m.source);
const restrictedWords = (label, molecules, overridable) => `${label} contains ${listWords(molecules.map((m) => m.name))}, which goes only to pest-control `
  + `operators and government bodies (${ruleWords(molecules[0])}): choose the customer tagged as one${overridable ? ', or ask a manager to allow it' : ''}.`;
// Whether a crop (as matched) is on a label's approved crops, by any of its names or groups.
const approvedFor = (entries, item, cropText, crop) => {
  const names = crop ? common.cropNames(entries, crop) : [cropText];
  return names.some((n) => item.approvedCrops.some((a) => normal(a) === normal(n)));
};
// The advisory line a pesticide prints: its dose, safety interval and protective gear.
function advisoryOf(item) {
  const parts = [item.dosePerAcre && `Dose ${item.dosePerAcre} per acre`,
    item.safetyDays !== null && `wait ${item.safetyDays} day${item.safetyDays === 1 ? '' : 's'} before harvest`, item.ppe && `wear ${item.ppe}`].filter(Boolean);
  return parts.length ? parts.join('; ').slice(0, 400) : null;
}
const isSulphur = (item) => item.molecules.some((name) => common.SULPHUR.includes(normal(name)));

// --- A farmer's subsidised bags this month ---------------------------------------------------------

// The limit for a location's state (its own, else the business's GST state): the shop's, else 50.
async function bagLimitAt(db, business, location) {
  const row = await repo.one(db, `SELECT COALESCE(l.state_code,s.state_code) AS state_code,lim.bags_per_month
    FROM business_locations l LEFT JOIN business_settings s ON s.business_id=l.business_id
    LEFT JOIN agri_bag_limits lim ON lim.business_id=l.business_id AND lim.state_code=COALESCE(l.state_code,s.state_code)
    WHERE l.business_id=$1 AND l.id=$2`, [business.id, location.id]);
  return { stateCode: row?.state_code || null, limit: Number(row?.bags_per_month || common.BAG_LIMIT) };
}
// A customer's subsidised bags on the business's own month so far (each
// fertiliser's stock unit), less what came back on those bills.
async function bagsThisMonth(db, business, contactId) {
  const row = await repo.one(db, `SELECT COALESCE(sum(dl.quantity-COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=dl.business_id AND rl.line_id=dl.id),0)),0) AS bags
    FROM agri_sale_lines a JOIN business_document_lines dl ON dl.business_id=a.business_id AND dl.id=a.line_id
    JOIN business_documents d ON d.business_id=a.business_id AND d.id=a.document_id JOIN businesses b ON b.id=d.business_id
    WHERE a.business_id=$1 AND a.subsidised AND d.contact_id=$2
      AND date_trunc('month',d.created_at AT TIME ZONE b.timezone)=date_trunc('month',now() AT TIME ZONE b.timezone)`, [business.id, contactId]);
  return Math.round(Number(row.bags) * 1000) / 1000;
}
// What the bill's subsidised bags do to the customer's month: { level: 'warn' | 'stop' | null, message,
// before (this month so far), after (with these bags), limit }. A walk-in's bags are not counted.
async function bagCheck(db, business, { location, contact, adding }) {
  if (!contact) return { level: null };
  const { limit } = await bagLimitAt(db, business, location);
  const before = await bagsThisMonth(db, business, contact.id);
  const after = Math.round((before + adding) * 1000) / 1000;
  const words = `${contact.name}'s subsidised bags this month come to ${after} with this bill`;
  if (adding <= 0) return { level: null, before, after, limit };
  if (after > limit) return { level: 'stop', before, after, limit, message: `${words}, over the limit of ${limit} a month for a farmer here` };
  if (after * 100 >= limit * common.BAG_WARN_PERCENT) return { level: 'warn', before, after, limit, message: `${words}, near the limit of ${limit} a month for a farmer here.` };
  return { level: null, before, after, limit };
}

// --- Season credit at the counter -----------------------------------------------------------------

// The season's credit a bill goes on: the one named, or the customer's for
// the season given (opened with that due date, no limit and no interest,
// when the customer has none yet). `charge`: interest billed on it.
async function seasonFor(db, business, user, bill, contact, today, charge) {
  if (!bill.seasonCreditId && !bill.season) return null;
  if (!contact) fail('Season credit is for a named customer: choose the farmer first');
  let account;
  if (bill.seasonCreditId) {
    account = await repo.one(db, 'SELECT * FROM agri_season_credits WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, bill.seasonCreditId]);
    if (!account || Number(account.contact_id) !== Number(contact.id)) fail('That season\'s credit is not this customer\'s', 404);
    if (bill.season && (bill.season !== account.season || bill.seasonYear !== account.season_year)) fail(`That credit is for ${seasonWords(account.season, account.season_year)}`);
  } else {
    account = await repo.one(db, 'SELECT * FROM agri_season_credits WHERE business_id=$1 AND contact_id=$2 AND season=$3 AND season_year=$4 FOR UPDATE',
      [business.id, contact.id, bill.season, bill.seasonYear]);
    if (!account) {
      account = await repo.one(db, `INSERT INTO agri_season_credits(business_id,contact_id,season,season_year,due_on,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`, [business.id, contact.id, bill.season, bill.seasonYear, bill.dueOn, user.id]);
      await repo.audit(db, business.id, user.id, 'season_credit.opened', account.id, { name: contact.name, season: account.season, seasonYear: account.season_year, dueOn: account.due_on });
    }
  }
  if (bill.dueOn && bill.dueOn !== account.due_on) {
    fail(`${contact.name}'s ${seasonWords(account.season, account.season_year)} credit falls due on ${dateWords(account.due_on)}: bill it on that date`, 409);
  }
  if (!charge && account.closed_at) {
    fail(`${contact.name}'s ${seasonWords(account.season, account.season_year)} credit is closed: open it again under Farm inputs › Season credit, or bill on another season`, 409);
  }
  if (!charge && account.due_on < today) {
    fail(`${contact.name}'s ${seasonWords(account.season, account.season_year)} credit fell due on ${dateWords(account.due_on)}: new credit goes on a new season`, 409);
  }
  return account;
}
// What is still owed on a season's bills (paise).
async function owedOnSeason(db, business, seasonCreditId) {
  const row = await repo.one(db, `SELECT COALESCE(sum(d.total
      -COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
      -COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
      +COALESCE((SELECT sum(f.amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0)),0) AS owed
    FROM agri_bills ab JOIN business_documents d ON d.business_id=ab.business_id AND d.id=ab.document_id
    WHERE ab.business_id=$1 AND ab.season_credit_id=$2`, [business.id, seasonCreditId]);
  return paise(row.owed);
}

// --- The bill -----------------------------------------------------------------------------------

// prepared: the bill's lines (each with its item, its stock-unit quantity
// and batch); location: the selling location; contact: the customer, or null.
// charge: a charge the agri services raise themselves (interest on season
// credit): its season may be closed or past due, and its limit is not asked.
async function checkSale(db, business, { prepared, body, location, contact, user, charge = false }) {
  const today = await common.today(db, business);
  const bill = readBill(body, contact, today);
  const settings = await common.settingsOf(db, business);
  const { byName } = await common.molecules(db);
  const crops = await common.cropsOf(db, business);
  const tags = contact ? await buyers.tagsOf(db, business, contact.id, today) : [];
  const used = await overrides.forBill(db, business, bill.overrideIds, { location, contact, today });
  const cache = newCache();
  const trade = tradeOf(contact);
  const warnings = [];
  const lines = [];
  let sulphur = false;
  for (const line of prepared) {
    const item = classification(line.sku.attributes);
    const input = (Array.isArray(body.lines) && body.lines[line.inputIndex]) || {};
    const ownCrop = readCrop(input.crop), ownReceipt = readReceipt(input.posReceipt);
    if (!item.kind || item.kind === 'other') {
      if (ownCrop || ownReceipt) fail(`${line.sku.label} is not a fertiliser, seed or pesticide: a crop or a PoS receipt goes on a farm input's line`);
      continue;
    }
    const label = line.sku.label;
    const listed = listedOf(byName, item);
    const banned = listed.find((m) => m.status === 'banned');
    if (banned) fail(`${label} contains ${banned.name}, banned in India (${banned.source}). It cannot be sold.`, 409);
    const limited = wrongFormulation(listed, item);
    if (limited) fail(formulationWords(label, limited, item), 409);
    const checked = await licenceCheck(db, business, cache, { location, trade, today, sku: line.sku, label, kind: item.kind });
    if (checked.stop) fail(checked.stop, 409);
    warnings.push(...checked.warnings);
    if (line.lotCode) {
      const lot = await repo.one(db, 'SELECT expires_on FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4',
        [business.id, location.id, line.sku.id, line.lotCode]);
      if (lot?.expires_on && lot.expires_on < today) {
        fail(item.kind === 'seed' ? `Seed lot ${line.lotCode} of ${label} was valid until ${dateWords(lot.expires_on)}: it cannot be sold.`
          : `Batch ${line.lotCode} of ${label} expired on ${dateWords(lot.expires_on)}: it cannot be sold. Keep it apart, marked not for sale.`, 409);
      }
    }
    const cropText = ownCrop || bill.crop;
    const crop = cropText ? common.matchCrop(crops, cropText) : null;
    const barred = listed.filter((m) => m.status === 'crop_restricted');
    if (barred.length && !cropText) {
      fail(`${label} contains ${listWords(barred.map((m) => m.name))}, which must not be used on some crops: give the crop the farmer is buying it for.`);
    }
    const inGroups = crop ? [crop.code, ...crop.groups].filter(Boolean) : [];
    const pair = crop && barred.find((m) => m.crops.some((c) => inGroups.includes(c.code)));
    if (pair) {
      const on = pair.crops.find((c) => inGroups.includes(c.code));
      const via = on.code === crop.code ? '' : ` (${crop.name.toLowerCase()} is one)`;
      fail(`${pair.name} must not be used on ${on.name.toLowerCase()}${via}: ${label} cannot be sold for it (${pair.source}).`, 409);
    }
    // The crops its label approves: another crop is billed with a warning.
    const offLabel = item.kind === 'pesticide' && item.approvedCrops.length > 0 && Boolean(cropText) && !approvedFor(crops, item, cropText, crop);
    if (offLabel) warnings.push(`${label} is not approved on its label for ${cropText} (its label names ${listWords(item.approvedCrops)}).`);
    // A restricted-use pesticide: a tagged buyer, or a manager's override.
    let restrictedBy = null, overrideId = null;
    const restricted = restrictedOf(listed, item);
    if (restricted.length) {
      const tag = ['pest_control_operator', 'government'].find((t) => tags.some((x) => x.tag === t));
      if (tag) restrictedBy = tag;
      else if (used.restricted_use?.sku_ids.includes(Number(line.sku.id))) { restrictedBy = 'override'; overrideId = used.restricted_use.id; }
      else {
        const overridable = settings.restricted_use === 'override';
        stop(restrictedWords(label, restricted, overridable), { reason: 'restricted_use', override: overridable, skuIds: [Number(line.sku.id)] });
      }
    }
    const receipt = item.subsidised ? ownReceipt || bill.posReceipt : null;
    if (item.subsidised && !receipt) fail(`${label} is a subsidised fertiliser: give the receipt number the PoS device printed for this sale.`);
    if (!item.subsidised && ownReceipt) fail(`${label} is not a subsidised fertiliser: a PoS receipt goes on a subsidised fertiliser's line`);
    if (isSulphur(item)) sulphur = true;
    lines.push({ line, kind: item.kind, subsidised: item.subsidised, posReceipt: receipt, crop: cropText, cropCode: crop?.code || null, shopCropId: crop?.shopCropId || null,
      molecules: item.molecules, formulation: item.formulation, offLabel, restrictedBy, overrideId, advisory: settings.advisory_on && item.kind === 'pesticide' ? advisoryOf(item) : null });
  }
  if (bill.posReceipt && !lines.some((l) => l.subsidised)) fail('A PoS receipt goes on a bill with a subsidised fertiliser on it');
  if (bill.village && !lines.length) fail('A walk-in farmer\'s village goes on a bill with farm inputs on it');
  const buyerName = contact ? null : v.optionalString(body.buyer?.name, 'Buyer name', 150);
  // Sulphur's buyers go in a register with their names and addresses (rule 10B).
  if (sulphur) {
    const where = contact ? contact.address || (await repo.one(db, 'SELECT village FROM agri_farmers WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]))?.village : bill.village;
    if (!(contact || buyerName) || !where) {
      fail(contact ? `Sulphur is sold with its buyer's address (Insecticides Rules 1971, rule 10B): give ${contact.name} an address, or their village as a farmer`
        : 'Sulphur is sold with its buyer\'s name and address (Insecticides Rules 1971, rule 10B): type the farmer\'s name and village, or choose the customer');
    }
  }
  // A named farmer's subsidised bags this month.
  const adding = lines.filter((l) => l.subsidised).reduce((sum, l) => sum + Number(l.line.quantity), 0);
  const bags = await bagCheck(db, business, { location, contact, adding });
  let bagOverride = null;
  if (bags.level === 'stop') {
    if (used.bag_limit) {
      bagOverride = used.bag_limit;
      warnings.push(`${bags.message}; allowed by a manager's override.`);
    } else {
      const overridable = settings.bag_limit_mode === 'override';
      stop(`${bags.message}. ${overridable ? 'Ask a manager to allow it, or bill fewer bags.' : 'Bill fewer bags.'}`, { reason: 'bag_limit', override: overridable });
    }
  } else if (bags.level === 'warn') warnings.push(bags.message);
  if (used.restricted_use && !lines.some((l) => l.overrideId)) fail('That manager\'s override is for restricted-use pesticides, and this bill sells none the buyer may not buy');
  if (used.bag_limit && !bagOverride) fail('That manager\'s override is for subsidised bags over the limit, and this bill keeps within it');
  const account = await seasonFor(db, business, user, bill, contact, today, charge);
  return { ...bill, season: account?.season || null, seasonYear: account?.season_year || null, dueOn: charge ? null : account?.due_on || null, account, charge,
    today, lines, buyerName: lines.length ? buyerName : null, tags: tags.map((t) => t.tag), used, bagOverride, warnings: [...new Set(warnings)] };
}

// The counter asks ahead, as the lines are typed. body: { locationId,
// contactId?, crop?, lines: [{ skuId, quantity? (stock units), crop? }] }.
// Returns { trade, notes: [{ skuId?, label?, kind, level: 'stop' | 'warn', message, override? }] }:
//   licence      the licence checks, as the bill will make them
// and with all: true (counter-check), the rest the bill checks:
//   formulation  a molecule sold only in another formulation (a stop)
//   restricted   a restricted-use pesticide for a buyer not tagged (a stop; override: when a manager may allow it)
//   label        a crop not on a pesticide's label (a warning)
//   bags         a named farmer's subsidised bags this month (a warning near the limit; a stop over it)
async function counterCheck(business, user, body, { all = false } = {}) {
  common.requireAgri(business);
  await access.require(business, 'sales.create');
  const locationId = v.requiredId(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  const list = v.requiredArray(body.lines, 'Lines');
  if (list.length > 100) fail('Ask about at most 100 lines at once');
  const asked = list.map((l) => ({ skuId: v.requiredId(l?.skuId, 'Item'), quantity: blank(l?.quantity) ? 0 : Number(l.quantity), crop: readCrop(l?.crop) }));
  if (asked.some((l) => !Number.isFinite(l.quantity) || l.quantity < 0 || l.quantity > 100000)) fail('A quantity is a number from 0 to 100000');
  const skuIds = [...new Set(asked.map((l) => l.skuId))];
  const db = repo.pool;
  const location = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
  if (!location) fail('Location not found', 404);
  const contact = body.contactId ? await repo.one(db, "SELECT id,name,gstin FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'",
    [business.id, v.requiredId(body.contactId, 'Customer')]) : null;
  const today = await common.today(db, business);
  const skus = await repo.all(db, 'SELECT id,product_id,label,attributes FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, skuIds]);
  const cache = newCache();
  const trade = tradeOf(contact);
  const notes = [];
  for (const skuId of skuIds) {
    const sku = skus.find((s) => Number(s.id) === skuId);
    const kind = sku && classification(sku.attributes).kind;
    if (!kind || !LICENCE_FOR[kind]) continue;
    const checked = await licenceCheck(db, business, cache, { location, trade, today, sku, label: sku.label, kind });
    if (checked.stop) notes.push({ skuId, label: sku.label, kind: 'licence', level: 'stop', message: checked.stop });
    for (const message of checked.warnings) notes.push({ skuId, label: sku.label, kind: 'licence', level: 'warn', message });
  }
  if (!all) return { trade, notes: notes.map(({ kind: _kind, ...note }) => note) };
  const settings = await common.settingsOf(db, business);
  const { byName } = await common.molecules(db);
  const crops = await common.cropsOf(db, business);
  const tags = contact ? await buyers.tagsOf(db, business, contact.id, today) : [];
  const billCrop = readCrop(body.crop);
  let adding = 0;
  for (const skuId of skuIds) {
    const sku = skus.find((s) => Number(s.id) === skuId);
    if (!sku) continue;
    const item = classification(sku.attributes);
    const listed = listedOf(byName, item);
    const limited = wrongFormulation(listed, item);
    if (limited) notes.push({ skuId, label: sku.label, kind: 'formulation', level: 'stop', message: formulationWords(sku.label, limited, item) });
    const restricted = restrictedOf(listed, item);
    if (restricted.length && !tags.some((t) => ['pest_control_operator', 'government'].includes(t.tag))) {
      const overridable = settings.restricted_use === 'override';
      notes.push({ skuId, label: sku.label, kind: 'restricted', level: 'stop', message: restrictedWords(sku.label, restricted, overridable), ...(overridable ? { override: 'restricted_use' } : {}) });
    }
    for (const line of asked.filter((l) => l.skuId === skuId)) {
      const cropText = line.crop || billCrop;
      if (item.kind === 'pesticide' && item.approvedCrops.length && cropText && !approvedFor(crops, item, cropText, common.matchCrop(crops, cropText))) {
        notes.push({ skuId, label: sku.label, kind: 'label', level: 'warn', message: `${sku.label} is not approved on its label for ${cropText} (its label names ${listWords(item.approvedCrops)}).` });
      }
      if (item.subsidised) adding += line.quantity;
    }
  }
  const bags = await bagCheck(db, business, { location, contact, adding });
  if (bags.level === 'stop') {
    const overridable = settings.bag_limit_mode === 'override';
    notes.push({ kind: 'bags', level: 'stop', message: `${bags.message}. ${overridable ? 'Ask a manager to allow it, or bill fewer bags.' : 'Bill fewer bags.'}`, ...(overridable ? { override: 'bag_limit' } : {}) });
  } else if (bags.level === 'warn') notes.push({ kind: 'bags', level: 'warn', message: bags.message });
  return { trade, tags: tags.map((t) => t.tag), ...(contact ? { bags: { before: bags.before, after: bags.after, limit: bags.limit } } : {}), notes };
}

// Once the payments are known: a season goes on a named customer's bill that
// leaves something on credit, within the season's limit. unpaid: paise left to pay.
async function checkCredit(db, business, plan, { contact, unpaid }) {
  if (!plan?.account) return;
  if (!contact) fail('Season credit is for a named customer: choose the farmer first');
  if (plan.charge) return;
  if (unpaid <= 0) fail('This bill is paid in full: a season and its harvest due date go on a bill on credit');
  if (plan.account.credit_limit !== null) {
    const after = (await owedOnSeason(db, business, plan.account.id)) + unpaid;
    if (after > paise(plan.account.credit_limit)) {
      fail(`This bill would take ${contact.name}'s ${seasonWords(plan.account.season, plan.account.season_year)} credit to ${money(after)} owed, over its limit of `
        + `${money(paise(plan.account.credit_limit))}. Take a payment now, or raise the season's limit under Farm inputs › Season credit.`, 409);
    }
  }
}

// After the bill and its lines are saved (each prepared line has its id now).
async function recordSale(db, business, user, saved, plan) {
  for (const l of plan.lines) {
    await db.query(`INSERT INTO agri_sale_lines(business_id,line_id,document_id,sku_id,input_kind,subsidised,pos_receipt,crop,crop_code,molecules,shop_crop_id,formulation,off_label,
        restricted_by,override_id,advisory)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [business.id, l.line.id, saved.id, l.line.sku.id, l.kind, l.subsidised, l.posReceipt, l.crop, l.cropCode,
      l.molecules, l.shopCropId, l.formulation, l.offLabel, l.restrictedBy, l.overrideId, l.advisory]);
  }
  const walkIn = !saved.contact_id && (plan.buyerName || plan.village);
  const tags = plan.lines.length ? plan.tags : [];
  if (plan.season || walkIn || tags.length || plan.bagOverride) {
    await db.query(`INSERT INTO agri_bills(business_id,document_id,season,season_year,buyer_name,village,created_by,season_credit_id,buyer_tags,bag_override_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [business.id, saved.id, plan.season, plan.seasonYear, walkIn ? plan.buyerName : null, walkIn ? plan.village : null, user.id, plan.account?.id || null, tags,
      plan.bagOverride?.id || null]);
  }
  await overrides.useUp(db, business, plan.used, saved.id);
  if (!plan.lines.length && !plan.season) return;
  const receipts = [...new Set(plan.lines.filter((l) => l.subsidised).map((l) => l.posReceipt))];
  const allowed = Object.values(plan.used).map((o) => ({ kind: o.kind, overrideId: Number(o.id) }));
  await repo.audit(db, business.id, user.id, 'sale.farm_inputs', saved.id, { documentNo: saved.document_no, lines: plan.lines.length,
    ...(receipts.length ? { posReceipts: receipts } : {}), ...(plan.season ? { season: plan.season, seasonYear: plan.seasonYear, seasonCreditId: plan.account.id, dueOn: plan.account.due_on } : {}),
    ...(allowed.length ? { overrides: allowed } : {}) });
  // Subsidised fertiliser sold, for anything that later mirrors the PoS (the outbox).
  const subsidised = plan.lines.filter((l) => l.subsidised);
  if (subsidised.length) {
    await repo.event(db, business.id, user.id, 'agri.subsidised_sale', 'document', saved.id, { documentNo: saved.document_no, locationId: saved.location_id,
      ...(saved.contact_id ? { contactId: saved.contact_id } : {}),
      lines: subsidised.map((l) => ({ lineId: l.line.id, skuId: l.line.sku.id, quantity: l.line.quantity, posReceipt: l.posReceipt })) });
  }
}

// A receipt of stock: a seed lot comes in with its validity date (its
// expiry; a lot whose tag is recorded comes in at its validity). Fertiliser
// from a supplier with no certificate of source (Form O) on the location's
// authorisation warns (while Licences & registrations is on); so does an
// insecticide other than a registered household one received where food or
// feed is stored or sold (rule 10C). The warnings go back with the posted receipt.
async function checkPurchase(db, business, { prepared, contact, location }) {
  const warnings = [];
  for (const line of prepared) {
    if (classification(line.sku.attributes).kind !== 'seed' || !line.lotCode) continue;
    const tag = await repo.one(db, 'SELECT valid_until::text AS valid_until FROM agri_seed_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [business.id, line.sku.id, line.lotCode]);
    if (tag && !line.expiresOn) line.expiresOn = tag.valid_until;
    if (tag && line.expiresOn !== tag.valid_until) {
      fail(`Seed lot ${line.lotCode} of ${line.sku.label} is valid until ${dateWords(tag.valid_until)}, by its tag: give that date as its expiry, or leave it out.`);
    }
    if (!line.expiresOn) fail(`${line.sku.label} is a seed: give lot ${line.lotCode}'s validity date as its expiry (the test date on its tag plus 9 months).`);
  }
  const fertiliser = prepared.filter((line) => classification(line.sku.attributes).kind === 'fertiliser');
  if (fertiliser.length && contact && business.modules.includes('licences')) {
    const note = await records.sourceNote(db, business, { location, supplier: contact, on: await common.today(db, business) });
    if (note) warnings.push(`${listWords([...new Set(fertiliser.map((l) => l.sku.label))])}: ${note}.`);
  }
  const insecticides = prepared.filter((line) => { const item = classification(line.sku.attributes); return item.kind === 'pesticide' && !item.household; });
  if (insecticides.length && await repo.one(db, 'SELECT 1 FROM agri_food_locations WHERE business_id=$1 AND location_id=$2', [business.id, location.id])) {
    warnings.push(foodWords(location.name, [...new Set(insecticides.map((l) => l.sku.label))]));
  }
  return warnings;
}
const foodWords = (locationName, labels) => `${listWords(labels)} ${labels.length === 1 ? 'is an insecticide' : 'are insecticides'} other than a registered household one, `
  + `and ${locationName} also stores or sells food or feed: no such insecticide is stored or sold in the same building (Insecticides Rules 1971, rule 10C).`;

// What a farm-input shop's bill shows and prints: each farm-input line's
// kind, PoS receipt, crop, advisory line and who a restricted-use pesticide
// went to; the season's credit of a credit bill; the farmer (a walk-in's name
// and village, or the customer's farmer details); and the selling location's
// licences in force that day for what is on the bill.
async function invoiceExtras(db, business, doc) {
  const lines = await repo.all(db, `SELECT line_id,input_kind,subsidised,pos_receipt,crop,off_label,restricted_by,advisory FROM agri_sale_lines
    WHERE business_id=$1 AND document_id=$2 ORDER BY line_id`, [business.id, doc.id]);
  const bill = await repo.one(db, `SELECT ab.season,ab.season_year,ab.buyer_name,ab.village,ab.season_credit_id,ab.buyer_tags,s.due_on::text AS season_due_on,
      (SELECT o.reason FROM agri_overrides o WHERE o.business_id=ab.business_id AND o.id=ab.bag_override_id) AS bag_override
    FROM agri_bills ab LEFT JOIN agri_season_credits s ON s.business_id=ab.business_id AND s.id=ab.season_credit_id
    WHERE ab.business_id=$1 AND ab.document_id=$2`, [business.id, doc.id]);
  const farmer = doc.contact_id ? await repo.one(db, 'SELECT village,relative_name,farmer_id FROM agri_farmers WHERE business_id=$1 AND contact_id=$2', [business.id, doc.contact_id]) : null;
  const interest = await repo.one(db, 'SELECT worked_to::text AS worked_to,amount FROM agri_season_interest WHERE business_id=$1 AND document_id=$2', [business.id, doc.id]);
  if (!lines.length && !bill && !farmer) return null;
  const categories = [...new Set(lines.map((l) => LICENCE_FOR[l.input_kind]).filter(Boolean))];
  // In force on the bill's day for its kind of sale (wholesale for a buyer with a GSTIN), a renewal pending included.
  const held = categories.length && business.modules.includes('licences') ? await repo.all(db, `SELECT l.kind,l.name,l.licence_no,l.covers FROM business_licences l
      JOIN business_documents d ON d.business_id=l.business_id AND d.id=$3 JOIN businesses b ON b.id=d.business_id
      WHERE l.business_id=$1 AND l.location_id=d.location_id AND l.covers && $2::text[]
        AND l.sells_to IN (CASE WHEN d.buyer_gstin IS NULL THEN 'retail' ELSE 'wholesale' END,'both')
        AND business_licence_in_force(l,(d.created_at AT TIME ZONE b.timezone)::date)
      ORDER BY l.kind,l.id`, [business.id, categories, doc.id]) : [];
  return { lines, bill: bill || null, farmer: farmer || null, licences: held, interest: interest || null };
}

// --- The shop's settings ------------------------------------------------------------------------

const STATE = /^\d{2}$/;
// The settings, with the limits for the states of the shop's locations and
// the locations marked as storing or selling food or feed.
async function settings(business) {
  common.requireAgri(business);
  await access.require(business, 'agri.view');
  const db = repo.pool;
  const s = await common.settingsOf(db, business);
  const states = await repo.all(db, `SELECT DISTINCT COALESCE(l.state_code,bs.state_code) AS state_code FROM business_locations l
    LEFT JOIN business_settings bs ON bs.business_id=l.business_id WHERE l.business_id=$1 AND l.active AND COALESCE(l.state_code,bs.state_code) IS NOT NULL`, [business.id]);
  const limits = await repo.all(db, 'SELECT state_code,bags_per_month FROM agri_bag_limits WHERE business_id=$1 ORDER BY state_code', [business.id]);
  const food = await repo.all(db, 'SELECT location_id FROM agri_food_locations WHERE business_id=$1 ORDER BY location_id', [business.id]);
  const interestItem = s.interest_sku_id ? await repo.one(db, 'SELECT id,label,tax_rate FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, s.interest_sku_id]) : null;
  const codes = [...new Set([...states.map((r) => r.state_code), ...limits.map((r) => r.state_code)])].sort();
  return {
    endorsementCheck: s.endorsement_check, restrictedUse: s.restricted_use, bagLimitMode: s.bag_limit_mode, advisoryOn: s.advisory_on,
    interestSkuId: s.interest_sku_id ? Number(s.interest_sku_id) : null, interestItem,
    bagLimits: codes.map((code) => ({ stateCode: code, bagsPerMonth: Number(limits.find((r) => r.state_code === code)?.bags_per_month || common.BAG_LIMIT),
      own: limits.some((r) => r.state_code === code) })),
    defaultBagLimit: common.BAG_LIMIT, bagWarnPercent: common.BAG_WARN_PERCENT,
    foodLocations: food.map((r) => Number(r.location_id)),
  };
}

// body: any of { endorsementCheck: 'warn' | 'block' (licences.edit),
// restrictedUse, bagLimitMode: 'block' | 'override', bagLimits: [{ stateCode,
// bagsPerMonth }], interestSkuId (a service item, or null), advisoryOn,
// foodLocations: [locationId] (settings.edit) }. What is left out stays.
async function saveSettings(business, user, body) {
  common.requireAgri(business);
  const has = (key) => body[key] !== undefined;
  if (!['endorsementCheck', 'restrictedUse', 'bagLimitMode', 'bagLimits', 'interestSkuId', 'advisoryOn', 'foodLocations'].some(has)) fail('Send a setting to change');
  if (has('endorsementCheck')) await access.require(business, 'licences.edit');
  if (['restrictedUse', 'bagLimitMode', 'bagLimits', 'interestSkuId', 'advisoryOn', 'foodLocations'].some(has)) await access.require(business, 'settings.edit');
  const next = {};
  if (has('endorsementCheck')) next.endorsement_check = v.requiredEnum(body.endorsementCheck, 'Insecticides not endorsed', ['warn', 'block']);
  if (has('restrictedUse')) next.restricted_use = v.requiredEnum(body.restrictedUse, 'Restricted-use pesticides', ['block', 'override']);
  if (has('bagLimitMode')) next.bag_limit_mode = v.requiredEnum(body.bagLimitMode, 'Subsidised bags over the limit', ['block', 'override']);
  if (has('advisoryOn')) next.advisory_on = v.requiredBoolean(body.advisoryOn, 'Advisory line on bills');
  const limits = has('bagLimits') ? v.requiredArray(body.bagLimits, 'Limits by state').map((row) => {
    const stateCode = v.requiredString(row?.stateCode, 'State code', 2);
    if (!STATE.test(stateCode)) fail('A state is its two-digit GST state code');
    const bags = Number(row?.bagsPerMonth);
    if (!Number.isInteger(bags) || bags < 1 || bags > 10000) fail('A limit is a whole number of bags a month, from 1 to 10000');
    return { stateCode, bags };
  }) : null;
  if (limits && new Set(limits.map((l) => l.stateCode)).size !== limits.length) fail('Each state has one limit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const was = await common.settingsOf(db, business);
    if (has('interestSkuId')) {
      if (blank(body.interestSkuId)) next.interest_sku_id = null;
      else {
        const sku = await repo.one(db, `SELECT s.id,s.label,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
          WHERE s.business_id=$1 AND s.id=$2 AND s.active`, [business.id, v.requiredId(body.interestSkuId, 'Interest item')]);
        if (!sku) fail('Item not found', 404);
        if (sku.kind !== 'service') fail(`${sku.label} is goods: interest is billed as a service item (its own GST slab)`);
        next.interest_sku_id = Number(sku.id);
      }
    }
    const merged = { ...was, ...next };
    await db.query(`INSERT INTO agri_settings(business_id,endorsement_check,restricted_use,bag_limit_mode,interest_sku_id,advisory_on,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (business_id) DO UPDATE SET endorsement_check=EXCLUDED.endorsement_check,restricted_use=EXCLUDED.restricted_use,bag_limit_mode=EXCLUDED.bag_limit_mode,
        interest_sku_id=EXCLUDED.interest_sku_id,advisory_on=EXCLUDED.advisory_on,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, merged.endorsement_check, merged.restricted_use, merged.bag_limit_mode, merged.interest_sku_id, merged.advisory_on, user.id]);
    const changes = {};
    const words = { endorsement_check: 'endorsementCheck', restricted_use: 'restrictedUse', bag_limit_mode: 'bagLimitMode', interest_sku_id: 'interestSkuId', advisory_on: 'advisoryOn' };
    for (const [column, key] of Object.entries(words)) {
      if (String(was[column] ?? '') !== String(merged[column] ?? '')) changes[key] = { from: was[column], to: merged[column] };
    }
    if (limits) {
      const before = await repo.all(db, 'SELECT state_code,bags_per_month FROM agri_bag_limits WHERE business_id=$1 ORDER BY state_code', [business.id]);
      await db.query('DELETE FROM agri_bag_limits WHERE business_id=$1 AND NOT (state_code=ANY($2::text[]))', [business.id, limits.map((l) => l.stateCode)]);
      for (const l of limits) {
        await db.query(`INSERT INTO agri_bag_limits(business_id,state_code,bags_per_month,updated_by) VALUES($1,$2,$3,$4)
          ON CONFLICT (business_id,state_code) DO UPDATE SET bags_per_month=EXCLUDED.bags_per_month,updated_by=EXCLUDED.updated_by,updated_at=now()`, [business.id, l.stateCode, l.bags, user.id]);
      }
      const shown = (rows) => Object.fromEntries(rows.map((r) => [r.state_code ?? r.stateCode, Number(r.bags_per_month ?? r.bags)]));
      if (JSON.stringify(shown(before)) !== JSON.stringify(shown(limits))) changes.bagLimits = { from: shown(before), to: shown(limits) };
    }
    const warnings = [];
    if (has('foodLocations')) {
      const ids = [...new Set(v.requiredArray(body.foodLocations, 'Locations with food or feed').map((x) => v.requiredId(x, 'Location')))];
      const found = await repo.all(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, ids]);
      if (found.length !== ids.length) fail('Location not found', 404);
      const before = (await repo.all(db, 'SELECT location_id FROM agri_food_locations WHERE business_id=$1', [business.id])).map((r) => Number(r.location_id));
      await db.query('DELETE FROM agri_food_locations WHERE business_id=$1 AND NOT (location_id=ANY($2::bigint[]))', [business.id, ids]);
      for (const locationId of ids) {
        await db.query('INSERT INTO agri_food_locations(business_id,location_id,set_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [business.id, locationId, user.id]);
      }
      if (JSON.stringify([...before].sort((a, b) => a - b)) !== JSON.stringify([...ids].sort((a, b) => a - b))) changes.foodLocations = { from: before, to: ids };
      // Marked now, a location with such insecticides in stock says so at once.
      for (const location of found.filter((l) => !before.includes(Number(l.id)))) {
        const kept = await repo.all(db, `SELECT DISTINCT s.label FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
          WHERE l.business_id=$1 AND l.location_id=$2 AND l.quantity>0 AND s.attributes->>'inputKind'='pesticide' AND COALESCE(s.attributes->>'household','')<>'yes' ORDER BY s.label`,
        [business.id, location.id]);
        if (kept.length) warnings.push(foodWords(location.name, kept.map((k) => k.label)));
      }
    }
    if (Object.keys(changes).length) await repo.audit(db, business.id, user.id, 'agri.settings_changed', business.id, changes);
    return { changed: Object.keys(changes), warnings };
  }).then(async (result) => ({ ...(await settings(business)), ...result }));
}

module.exports = { given, applies: common.applies, checkSale, checkCredit, recordSale, checkPurchase, invoiceExtras, counterCheck, settings, saveSettings,
  bagsThisMonth, bagLimitAt, owedOnSeason, foodWords };
