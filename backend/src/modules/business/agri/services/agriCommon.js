const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');

// What the seeds, fertilisers & pesticides services share: the type and
// module guard, the words for each kind of farm input, an item's
// classification as its details keep it, the molecule master and the crops
// it names, and the business's own date.

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

function requireAgri(business) {
  if (business.business_type !== 'agri_inputs') fail('This screen belongs to seeds, fertilisers & pesticides shops', 404);
  if (!business.modules.includes('agri')) fail('Seeds, fertilisers & pesticides is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}
// A farm-input shop with its tools on: its bills and purchases are checked.
const applies = (business) => business.business_type === 'agri_inputs' && business.modules.includes('agri');

// A name as it is compared: trimmed, single spaces, lower case.
const normal = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

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
  };
}

// The molecule master and the crops it names: platform data that changes
// only with a migration (which needs a restart), so read once per process.
// `db`: the caller's client (a transaction's own, inside one).
let master = null;
async function molecules(db) {
  if (!master) {
    // One query at a time: inside a transaction `db` is its single client.
    const rows = await repo.all(db, `SELECT m.code,m.name,m.status,m.restriction,m.source,
        COALESCE((SELECT array_agg(mc.crop_code ORDER BY c.name) FROM agri_molecule_crops mc JOIN agri_crops c ON c.code=mc.crop_code WHERE mc.molecule_code=m.code),'{}') AS crops
      FROM agri_molecules m ORDER BY m.name`);
    const crops = await repo.all(db, 'SELECT code,name,aliases FROM agri_crops ORDER BY name');
    const cropName = new Map(crops.map((c) => [c.code, c.name]));
    const list = rows.map((m) => ({ ...m, crops: m.crops.map((code) => ({ code, name: cropName.get(code) })) }));
    master = { list, crops, byName: new Map(list.map((m) => [normal(m.name), m])) };
  }
  return master;
}
// The listed crop a farmer's word names (its name, an alias or its code), or null.
function matchCrop(crops, text) {
  const said = normal(text).replace(/[()]/g, '');
  return crops.find((c) => [c.name, c.code.replace(/_/g, ' '), ...c.aliases].some((name) => normal(name).replace(/[()]/g, '') === said)) || null;
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
const daysBetween = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
// "a, b and c".
const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

module.exports = { fail, INPUT_KINDS, KIND_WORDS, LICENCE_FOR, LICENCE_WORDS, SEED_CLASSES, SEASONS, SEASON_WORDS, requireAgri, applies, normal, classification,
  molecules, matchCrop, today, readDate, daysBetween, addDays, dateWords, listWords };
