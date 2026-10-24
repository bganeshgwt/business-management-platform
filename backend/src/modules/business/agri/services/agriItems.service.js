const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const { attributes } = require('../../core/services/businessModules');
const common = require('./agriCommon');

// Seeds, fertilisers & pesticides: what kind of farm input an item is, kept
// with the item's details (catalog_skus.attributes, keys registered in
// businessModules.js › attributes.agri) and changed on the item form while
// the module is on. The core's catalogue calls in here (business.service.js
// › createCatalog and updateCatalog), inside its own transaction:
//   inputKind    fertiliser, seed, pesticide, bio_input or other
//   subsidised   "yes" for a fertiliser sold at the subsidised price, through
//                the government's PoS device
//   seedClass    certified or truthfully_labelled; seedCrop, seedVariety
//   molecules    a pesticide's active molecules (a list of names; those of the
//                molecule master take its spelling) and its formulation
//   netKg        the weight of one unit, for registers kept in quintals
// An item made of a banned molecule is refused (and the database refuses it
// too: catalog_skus_agri_molecules). A seed or pesticide is kept by batch,
// so each lot's validity or expiry is checked when it is sold.

const { fail, INPUT_KINDS, SEED_CLASSES, normal, KIND_WORDS } = common;
const KEYS = attributes.agri;
const MAX_MOLECULES = 5;

const blank = (value) => value === undefined || value === null || value === '';
function readNetKg(value) {
  if (blank(value)) return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text) || Number(text) <= 0 || Number(text) > 100000) fail('Weight of one unit must be more than 0 kg, with at most 3 decimal places');
  return String(Number(text));
}

// The classification as given (the whole of it: `inputKind` first, the rest
// by kind), checked and written as the item keeps it. An empty inputKind
// takes the item out of the farm inputs. opening: the item's opening stock,
// when it is made with some; creating: the item is being made (its stock
// tracking can still be chosen).
async function classify(db, business, given, { kind, tracking, opening = null, creating = false }) {
  const sent = Object.keys(given || {}).filter((key) => KEYS.includes(key));
  if (!sent.length) return {};
  if (!sent.includes('inputKind')) fail('Send the item\'s whole farm-input details, starting with what kind of input it is (inputKind)');
  if (blank(given.inputKind)) {
    const left = sent.filter((key) => key !== 'inputKind' && !blank(given[key]) && given[key] !== false && !(Array.isArray(given[key]) && !given[key].length));
    if (left.length) fail('Choose what kind of farm input this is before its other details');
    return {};
  }
  const inputKind = v.requiredEnum(given.inputKind, 'Kind of farm input', INPUT_KINDS);
  if (kind === 'service') fail('Only goods are farm inputs: a service has no kind of input');
  const out = { inputKind };
  const only = (key, kinds, what) => {
    const value = given[key];
    if (blank(value) || value === false || (Array.isArray(value) && !value.length)) return false;
    if (!kinds.includes(inputKind)) fail(`${what} belongs to a ${kinds.map((k) => KIND_WORDS[k]).join(' or ')}, not a ${KIND_WORDS[inputKind]}`);
    return true;
  };
  if (only('subsidised', ['fertiliser'], 'Subsidised')) {
    if (![true, 'yes', 'true'].includes(given.subsidised)) fail('Subsidised is yes or no');
    out.subsidised = 'yes';
  }
  if (only('seedClass', ['seed'], 'The class of seed')) out.seedClass = v.requiredEnum(given.seedClass, 'Class of seed', SEED_CLASSES);
  if (only('seedCrop', ['seed'], 'The crop')) out.seedCrop = v.requiredString(given.seedCrop, 'Crop', 100);
  if (only('seedVariety', ['seed'], 'The variety')) out.seedVariety = v.requiredString(given.seedVariety, 'Variety', 100);
  if (only('formulation', ['pesticide'], 'The formulation')) out.formulation = v.requiredString(given.formulation, 'Formulation', 40);
  if (only('molecules', ['pesticide'], 'Active molecules')) {
    const list = v.requiredArray(given.molecules, 'Active molecules');
    if (list.length > MAX_MOLECULES) fail(`Name at most ${MAX_MOLECULES} active molecules`);
    const { byName } = await common.molecules(db);
    const names = [];
    for (const raw of list) {
      const typed = v.requiredString(raw, 'Active molecule', 80).replace(/\s+/g, ' ');
      if (typed.length < 2) fail('An active molecule\'s name has at least 2 letters');
      const listed = byName.get(normal(typed));
      if (listed?.status === 'banned') {
        fail(`${listed.name} is banned in India (${listed.source}): an item made of it cannot be kept for sale.`, 409);
      }
      const name = listed ? listed.name : typed;
      if (names.some((n) => normal(n) === normal(name))) fail(`${name} is named twice`);
      names.push(name);
    }
    out.molecules = names;
  }
  const netKg = readNetKg(given.netKg);
  if (netKg) out.netKg = netKg;
  // A seed lot's validity and a pesticide batch's expiry are checked at the counter.
  if (['seed', 'pesticide'].includes(inputKind) && tracking !== 'batch') {
    fail(`A ${KIND_WORDS[inputKind]} is kept by batch, so each lot's ${inputKind === 'seed' ? 'validity' : 'expiry'} is checked when it is sold. `
      + (creating ? 'Choose Batch & expiry tracking for it.' : 'This item is not kept by batch: add it as a new item with Batch & expiry tracking.'));
  }
  if (inputKind === 'seed' && opening && !opening.expiresOn) fail('A seed lot needs its validity date as its expiry: the test date on its tag plus 9 months');
  return out;
}

const pick = (attrs) => Object.fromEntries(KEYS.filter((key) => attrs?.[key] !== undefined).map((key) => [key, attrs[key]]));

// An item's classification changed on the item form: the whole of it
// replaced, written and kept in the activity log with what it was.
// current: the item (with its label and tracking); now: its details so far.
async function reclassify(db, business, user, current, now, given) {
  const next = Object.fromEntries(Object.entries(now || {}).filter(([key]) => !KEYS.includes(key)));
  Object.assign(next, await classify(db, business, given, { kind: current.tracking === 'none' ? 'service' : 'goods', tracking: current.tracking }));
  const before = pick(now), after = pick(next);
  if (JSON.stringify(before) === JSON.stringify(after)) return now;
  await db.query('UPDATE catalog_skus SET attributes=$3 WHERE business_id=$1 AND id=$2', [business.id, current.id, JSON.stringify(next)]);
  await repo.audit(db, business.id, user.id, 'catalog.classified', current.id, { label: current.label, from: before, to: after });
  return next;
}

// The molecule master and its crops (platform data, read-only to shops):
// the item form's molecule list, the counter's crop question and the Molecules screen.
async function master(business) {
  common.requireAgri(business);
  const { list, crops } = await common.molecules(repo.pool);
  return { molecules: list, crops };
}

module.exports = { KEYS, classify, reclassify, master };
