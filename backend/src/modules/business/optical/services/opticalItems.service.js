// The database layer, loaded on first use: the readers here load no database.
const repo = () => require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const { attributes } = require('../../core/services/businessModules');
const c = require('./opticalCommon');

// The optical details an item keeps (module "optical"; businessModules.js
// attributes.optical), checked here when an item is made or changed:
//   a spectacle lens   its design (single vision, bifocal, progressive),
//                      index, material, coatings (several) and tint: a
//                      spectacle order billed as the item takes them, so they
//                      are picked on the order instead of typed
//   a contact lens     its power, base curve and diameter (together), a
//                      toric's CYL and AXIS (together), a multifocal's ADD, a
//                      cosmetic lens's colour, how often it is replaced
//                      (modality) and how many lenses one unit holds: the
//                      counter checks it against the customer's contact-lens
//                      prescription, and the replacement reminders count its
//                      lenses. The power grid writes them for each power.
// An item is a spectacle lens or a contact lens, not both.

const { fail } = c;
const blank = (value) => value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
// Millimetres as the power grid keeps them: 8.4, 14.0, 8.65.
const mmText = (value, name, min, max) => {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be from ${min} to ${max} mm, with at most two decimal places`);
  return Number(text).toFixed(2).replace(/0$/, '');
};

function readOne(key, value) {
  switch (key) {
    case 'lensDesign': return v.requiredEnum(value, 'Lens design', c.LENS_TYPES);
    case 'lensIndex': return c.readIndex(value, 'Lens index');
    case 'lensMaterial': return v.requiredEnum(value, 'Lens material', c.MATERIALS);
    case 'coatings': return c.readCoatings(value, 'Coatings');
    case 'tint': return c.optionalText(value, 'Tint', 60);
    case 'power': return c.readPower(value, 'Contact lens power', { plano: true });
    case 'baseCurve': return mmText(value, 'Base curve', 6, 10);
    case 'diameter': return mmText(value, 'Diameter', 8, 25);
    case 'cyl': {
      const cyl = c.readPower(value, 'Contact lens CYL');
      if (cyl !== null && Number(cyl) === 0) fail('Contact lens CYL: leave it empty for a lens that is not toric');
      return cyl;
    }
    case 'axis': { const axis = c.readAxis(value, 'Contact lens AXIS'); return axis === null ? null : String(axis); }
    case 'add': return c.readPower(value, 'Contact lens ADD', { min: 0.25, max: 4 });
    case 'colour': return c.optionalText(value, 'Contact lens colour', 40);
    case 'modality': return v.requiredEnum(value, 'Contact lens replaced', c.MODALITIES);
    case 'lensesPerPack': {
      const text = String(value).trim();
      if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > 1000) fail('Lenses in one unit must be a whole number from 1 to 1000');
      return text;
    }
    default: return fail(`Unsupported attribute: ${key}`);
  }
}

// The optical details together make one kind of lens.
function check(details) {
  const spectacle = c.LENS_ITEM_KEYS.some((key) => details[key] !== undefined);
  const contact = c.CONTACT_LENS_KEYS.some((key) => details[key] !== undefined);
  if (spectacle && contact) fail('An item is a spectacle lens or a contact lens, not both');
  if (contact && ['power', 'baseCurve', 'diameter'].some((key) => details[key] === undefined)) fail('A contact lens keeps its power, base curve and diameter together');
  if ((details.cyl === undefined) !== (details.axis === undefined)) fail('A toric contact lens keeps its CYL and AXIS together');
}
const opticalOf = (all) => Object.fromEntries(Object.entries(all || {}).filter(([key]) => attributes.optical.includes(key)));

// A new item's optical details, from what was given (empty ones left out).
function classify(given) {
  const out = {};
  for (const key of attributes.optical) {
    if (blank(given?.[key])) continue;
    const value = readOne(key, given[key]);
    if (!blank(value)) out[key] = value;
  }
  check(out);
  return out;
}

// An item's optical details changed: those given (an empty one removed),
// kept in the activity log with what was and what is.
async function reclassify(db, business, user, current, now, given) {
  const next = { ...now };
  for (const key of attributes.optical) {
    if (!(key in given)) continue;
    const value = blank(given[key]) ? null : readOne(key, given[key]);
    if (blank(value)) delete next[key];
    else next[key] = value;
  }
  check(opticalOf(next));
  const from = opticalOf(current.attributes), to = opticalOf(next);
  if (JSON.stringify(from) === JSON.stringify(to)) return now;
  await db.query('UPDATE catalog_skus SET attributes=$3 WHERE business_id=$1 AND id=$2', [business.id, current.id, JSON.stringify(next)]);
  await repo().audit(db, business.id, user.id, 'catalog.lens_details_changed', current.id, { label: current.label, from, to });
  return next;
}

module.exports = { classify, reclassify, mmText };
