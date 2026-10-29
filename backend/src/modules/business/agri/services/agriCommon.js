const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');

// What the seeds, fertilisers & pesticides services share: the type and
// module guard, the words for each kind of farm input, an item's
// classification as its details keep it, the molecule master and the crops
// it names (in their groups, with the shop's own crops and additions), the
// shop's settings and the business's own date.

const fail = (message, status = 400) => { throw new AppError(status, message); };

// The kinds of farm input an item can be (catalog_skus.attributes.inputKind).
const INPUT_KINDS = ['fertiliser', 'seed', 'pesticide', 'bio_input', 'other'];
const KIND_WORDS = { fertiliser: 'fertiliser', seed: 'seed', pesticide: 'pesticide', bio_input: 'bio-input', other: 'other item' };
// The licence category each kind needs at the counter (Licences & registrations),
// and the licence's name in a sentence.
const LICENCE_FOR = { fertiliser: 'fertiliser', seed: 'seed', pesticide: 'insecticide' };
const LICENCE_WORDS = { fertiliser: 'fertiliser licence (authorisation letter)', seed: 'seed licence', insecticide: 'insecticide licence' };
const SEED_CLASSES = ['certified', 'truthfully_labelled'];
const SEASONS = ['kharif', 'rabi', 'zaid'];
const SEASON_WORDS = { kharif: 'Kharif', rabi: 'Rabi', zaid: 'Zaid' };
// A buyer's tags (agri_buyer_tags): who may buy a restricted-use pesticide,
// and who counts as a bulk consumer in the Form XIII register.
const TAGS = ['pest_control_operator', 'government', 'bulk_consumer'];
const TAG_WORDS = { pest_control_operator: 'pest-control operator', government: 'government body', bulk_consumer: 'bulk consumer' };
// The molecule names of sulphur, whose buyers go in a register of their own (Insecticides Rules 1971, rule 10B).
const SULPHUR = ['sulphur', 'sulfur'];
// A farmer's subsidised bags in a month where the location's state has no limit of its own.
const BAG_LIMIT = 50;
// The bags from which the counter warns: this share of the limit.
const BAG_WARN_PERCENT = 80;

function requireAgri(business) {
  if (business.business_type !== 'agri_inputs') fail('This screen belongs to seeds, fertilisers & pesticides shops', 404);
  if (!business.modules.includes('agri')) fail('Seeds, fertilisers & pesticides is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}
// A farm-input shop with its tools on: its bills and purchases are checked.
const applies = (business) => business.business_type === 'agri_inputs' && business.modules.includes('agri');

// A name as it is compared: trimmed, single spaces, lower case.
const normal = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
// A formulation as it is compared: lower case, letters, digits and % only ("3 % C.G." is "3%cg").
const formulaKey = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9%]/g, '');

// An item's classification as its details keep it (agriItems.service.js
// writes it): the kind, and what each kind adds. Unclassified: kind null.
function classification(attributes) {
  const a = attributes || {};
  return {
    kind: INPUT_KINDS.includes(a.inputKind) ? a.inputKind : null,
    subsidised: a.inputKind === 'fertiliser' && a.subsidised === 'yes',
    seedClass: a.seedClass || null, seedCrop: a.seedCrop || null, seedVariety: a.seedVariety || null,
    molecules: Array.isArray(a.molecules) ? a.molecules.map(String) : [],
    formulation: a.formulation || null,
    netKg: a.netKg ? Number(a.netKg) : null,
    approvedCrops: Array.isArray(a.approvedCrops) ? a.approvedCrops.map(String) : [],
    household: a.inputKind === 'pesticide' && a.household === 'yes',
    dosePerAcre: a.dosePerAcre || null, safetyDays: a.safetyDays === undefined || a.safetyDays === null || a.safetyDays === '' ? null : Number(a.safetyDays),
    ppe: a.ppe || null,
  };
}

// The molecule master and the platform's crops in their groups: platform
// data that changes only with a migration (which needs a restart), so read
// once per process. `db`: the caller's client (a transaction's own, inside one).
let master = null;
async function molecules(db) {
  if (!master) {
    // One query at a time: inside a transaction `db` is its single client.
    const rows = await repo.all(db, `SELECT m.code,m.name,m.status,m.restriction,m.source,m.users_only,m.users_formulation,m.only_formulation,
        COALESCE((SELECT array_agg(mc.crop_code ORDER BY c.name) FROM agri_molecule_crops mc JOIN agri_crops c ON c.code=mc.crop_code WHERE mc.molecule_code=m.code),'{}') AS crops
      FROM agri_molecules m ORDER BY m.name`);
    const crops = await repo.all(db, `SELECT c.code,c.name,c.aliases,c.is_group,
        COALESCE((SELECT array_agg(g.group_code ORDER BY g.group_code) FROM agri_crop_groups g WHERE g.crop_code=c.code),'{}') AS groups
      FROM agri_crops c ORDER BY c.is_group,c.name`);
    const cropName = new Map(crops.map((c) => [c.code, c.name]));
    const list = rows.map((m) => ({ ...m, crops: m.crops.map((code) => ({ code, name: cropName.get(code) })) }));
    master = { list, crops, byName: new Map(list.map((m) => [normal(m.name), m])) };
  }
  return master;
}

// The crops a farmer's word is matched against at this shop: the platform's
// (with the other names and groups the shop added to them) and the shop's own.
// Each: { code (the platform's) | shopCropId, name, aliases, groups (codes), isGroup }.
async function cropsOf(db, business) {
  const { crops } = await molecules(db);
  const own = await repo.all(db, 'SELECT id,crop_code,name,aliases,groups FROM agri_shop_crops WHERE business_id=$1 AND active ORDER BY id', [business.id]);
  const added = new Map(own.filter((s) => s.crop_code).map((s) => [s.crop_code, s]));
  return [
    ...crops.map((c) => {
      const extra = added.get(c.code);
      return { code: c.code, shopCropId: null, name: c.name, aliases: [...c.aliases, ...(extra?.aliases || [])],
        groups: [...new Set([...c.groups, ...(extra?.groups || [])])], isGroup: c.is_group };
    }),
    ...own.filter((s) => !s.crop_code).map((s) => ({ code: null, shopCropId: Number(s.id), name: s.name, aliases: s.aliases, groups: s.groups, isGroup: false })),
  ];
}
const groupNames = (entries, codes) => codes.map((code) => entries.find((c) => c.code === code)?.name).filter(Boolean);

// The crop a farmer's word names (its name, an alias or a platform crop's code), or null.
function matchCrop(entries, text) {
  const said = normal(text).replace(/[()]/g, '');
  if (!said) return null;
  return entries.find((c) => [c.name, ...(c.code ? [c.code.replace(/_/g, ' ')] : []), ...c.aliases].some((name) => normal(name).replace(/[()]/g, '') === said)) || null;
}
// Every name the crop answers to, and its groups' names: what a label's approved crops are compared with.
const cropNames = (entries, crop) => [crop.name, ...crop.aliases, ...crop.groups.flatMap((code) => {
  const group = entries.find((c) => c.code === code);
  return group ? [group.name, ...group.aliases] : [];
})];

// The shop's settings (agri_settings; defaults when none is saved).
const SETTING_DEFAULTS = { endorsement_check: 'warn', restricted_use: 'block', bag_limit_mode: 'block', interest_sku_id: null, advisory_on: false };
async function settingsOf(db, business) {
  const row = await repo.one(db, 'SELECT endorsement_check,restricted_use,bag_limit_mode,interest_sku_id,advisory_on FROM agri_settings WHERE business_id=$1', [business.id]);
  return { ...SETTING_DEFAULTS, ...(row || {}) };
}

// The business's own date (its time zone), as YYYY-MM-DD.
async function today(db, business) {
  return (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone || 'Asia/Kolkata'])).day;
}
// A calendar date as typed (YYYY-MM-DD), checked.
function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const { daysBetween, addDays, addMonths, dateWords } = require('./agriDates');
// "a, b and c".
const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
// Integer paise from rupees, and back.
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);

module.exports = { fail, INPUT_KINDS, KIND_WORDS, LICENCE_FOR, LICENCE_WORDS, SEED_CLASSES, SEASONS, SEASON_WORDS, TAGS, TAG_WORDS, SULPHUR, BAG_LIMIT, BAG_WARN_PERCENT,
  requireAgri, applies, normal, formulaKey, classification, molecules, cropsOf, groupNames, matchCrop, cropNames, settingsOf, today, readDate, daysBetween, addDays,
  addMonths, dateWords, listWords, paise, rupees };
