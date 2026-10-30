// What a prescription is checked against: the clinic's own drug list
// (health_clinic_drugs) and the patient's known allergies. Pure: no database
// and no request, so the rules are tested on their own
// (tests/clinic-lab-rules.test.js).
//
//   A day's dose   the line's dose (a number of the medicine's form, "1 tab",
//                  or an amount, "500 mg", "5 ml"; one of the form when left
//                  out) times how often a day ("1-0-1" is the pattern's numbers
//                  added up, so two; OD, BD, TDS, QID, HS, "every 6 hours"),
//                  through the strength ("500 mg", "125 mg/5 ml") into the unit
//                  of the medicine's most a day. A dose taken as needed (SOS),
//                  or written so that no figure follows, is not checked.
//   Allergies      the patient's allergies as written ("Penicillin (rash);
//                  sulfa drugs") against the medicine's generic name, brand
//                  names and allergy group, and against the allergy group of
//                  any medicine on the list an allergy names (an allergy to
//                  aspirin, in NSAIDs on the list, warns for ibuprofen too).
//   Twice          the same medicine, or two of one allergy group, on one
//                  prescription: the later line is warned.

// --- Amounts and units ---------------------------------------------------------------

// Each unit word: its kind and its size in the kind's base (mg, ml, IU, units,
// or one of the form: a tablet, a capsule, a puff).
const UNITS = {
  mcg: ['mass', 0.001], ug: ['mass', 0.001], 'µg': ['mass', 0.001], microgram: ['mass', 0.001], micrograms: ['mass', 0.001],
  mg: ['mass', 1], milligram: ['mass', 1], milligrams: ['mass', 1], g: ['mass', 1000], gm: ['mass', 1000], gms: ['mass', 1000], gram: ['mass', 1000], grams: ['mass', 1000],
  ml: ['volume', 1], millilitre: ['volume', 1], millilitres: ['volume', 1], cc: ['volume', 1], l: ['volume', 1000], litre: ['volume', 1000], liter: ['volume', 1000],
  tsp: ['volume', 5], teaspoon: ['volume', 5], teaspoons: ['volume', 5], tbsp: ['volume', 15], tablespoon: ['volume', 15], tablespoons: ['volume', 15],
  iu: ['iu', 1], unit: ['unit', 1], units: ['unit', 1], u: ['unit', 1],
  tab: ['count', 1], tabs: ['count', 1], tablet: ['count', 1], tablets: ['count', 1], cap: ['count', 1], caps: ['count', 1], capsule: ['count', 1], capsules: ['count', 1],
  puff: ['count', 1], puffs: ['count', 1], drop: ['count', 1], drops: ['count', 1], gtt: ['count', 1], sachet: ['count', 1], sachets: ['count', 1],
  spray: ['count', 1], sprays: ['count', 1], patch: ['count', 1], patches: ['count', 1], suppository: ['count', 1], suppositories: ['count', 1],
  vial: ['count', 1], vials: ['count', 1], ampoule: ['count', 1], ampoules: ['count', 1], amp: ['count', 1], lozenge: ['count', 1], lozenges: ['count', 1],
  pessary: ['count', 1], pessaries: ['count', 1], dose: ['count', 1], doses: ['count', 1], application: ['count', 1], applications: ['count', 1],
};
// The units a medicine's most a day is kept in (the database's list too).
const MAX_UNITS = ['mg', 'g', 'mcg', 'ml', 'IU', 'units', 'tablets', 'capsules', 'puffs', 'drops', 'sachets'];

const unitOf = (word) => {
  const found = UNITS[String(word || '').toLowerCase().replace(/\.$/, '')];
  return found ? { kind: found[0], factor: found[1] } : null;
};

const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

// "1", "0.5", "½", "1½", "1 1/2", "1/2" -> a number; anything else -> null.
function quantity(text) {
  const s = String(text ?? '').trim();
  let m = /^(\d+(?:\.\d+)?)?\s*([½¼¾⅓⅔])$/.exec(s);
  if (m) return (m[1] ? Number(m[1]) : 0) + FRACTIONS[m[2]];
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (m && Number(m[3]) > 0) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(s);
  if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  return /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}

const NUMBER = '[\\d.½¼¾⅓⅔/]+(?:\\s+\\d+/\\d+)?';

// A dose as written: "1 tab", "2 puffs", "500 mg", "5 ml", "1-2 tabs" (the
// most of a range), "½". Blank: one of the form. null: no figure follows.
function parseDose(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/,/g, '');
  if (!s) return { quantity: 1, kind: 'count', factor: 1 };
  const m = new RegExp(`^(${NUMBER})(?:\\s*(?:-|–|to)\\s*(${NUMBER}))?\\s*([a-zµ]+\\.?)?$`).exec(s);
  if (!m) return null;
  const amount = quantity(m[2] ?? m[1]);
  if (amount === null || amount <= 0) return null;
  if (!m[3]) return { quantity: amount, kind: 'count', factor: 1 };
  const unit = unitOf(m[3]);
  return unit ? { quantity: amount, ...unit } : null;
}

// A strength as written: "500 mg", "650mg", "125 mg/5 ml", "10 mg/ml",
// "100 mcg/puff". null when it holds no single amount ("0.5%", "500 mg + 125 mg").
function parseStrength(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/,/g, '');
  const m = /^(\d+(?:\.\d+)?)\s*([a-zµ]+)\.?(?:\s*(?:\/|per)\s*(\d+(?:\.\d+)?)?\s*([a-zµ]+)\.?)?$/.exec(s);
  if (!m) return null;
  const unit = unitOf(m[2]);
  if (!unit || unit.kind === 'count' || unit.kind === 'volume') return null;
  const strength = { amount: Number(m[1]), ...unit, base: Number(m[1]) * unit.factor, per: null };
  if (m[4]) {
    const per = unitOf(m[4]);
    const amount = m[3] === undefined ? 1 : Number(m[3]);
    if (!per || amount <= 0 || (per.kind !== 'volume' && per.kind !== 'count')) return null;
    strength.per = { amount, ...per, base: amount * per.factor };
  }
  return strength;
}

// How many doses a day "how often" says: a pattern ("1-0-1", "½-0-½", "1-1-1-1")
// adds up its numbers; OD, BD, TDS, QID, HS, "every 8 hours", weekly, on
// alternate days. null: as needed (SOS), or not a frequency the check knows.
function perDay(text) {
  const raw = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '');
  // "b.d." is "bd"; a dot between digits stays ("1.5-0-1.5").
  const s = raw.replace(/(?<=[a-z])\.|\.(?=[a-z])/g, '');
  if (!s) return null;
  if (/^[\d.½¼¾⅓⅔/]+(\s*[-–]\s*[\d.½¼¾⅓⅔/]+){1,5}$/.test(s)) {
    const parts = s.split(/\s*[-–]\s*/).map(quantity);
    if (parts.some((part) => part === null)) return null;
    const sum = parts.reduce((total, part) => total + part, 0);
    return sum > 0 ? sum : null;
  }
  if (/^(sos|prn|as needed|as required|when required|if needed|when needed)$/.test(s)) return null;
  if (/^(od|qd|once|once (a|per) day|once daily|daily|every day|hs|qhs|at bed ?time|bed ?time|nocte|mane|qam|qpm|stat|in the morning|at night)$/.test(s)) return 1;
  if (/^(bd|bid|twice|twice (a|per) day|twice daily|morning and night)$/.test(s)) return 2;
  if (/^(tds|tid|thrice|thrice (a|per) day|thrice daily|three times (a|per) day|three times daily)$/.test(s)) return 3;
  if (/^(qid|qds|four times (a|per) day|four times daily)$/.test(s)) return 4;
  let m = /^(?:every|q)\s?(\d{1,2})\s?(?:h|hr|hrs|hour|hours|hourly)$/.exec(s) || /^(\d{1,2})[ -]?(?:hourly|hrly)$/.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return 24 / Number(m[1]);
  if (/^(weekly|once (a|per) week|every week)$/.test(s)) return 1 / 7;
  if (/^(alternate days?|on alternate days|every other day)$/.test(s)) return 0.5;
  m = /^(\d) times (a|per) day$/.exec(s);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

// The most a day of a medicine: { amount, unit, kind, factor }, or null.
function maxOf(drug) {
  if (!drug || drug.max_daily_amount === null || drug.max_daily_amount === undefined || !drug.max_daily_unit) return null;
  const amount = Number(drug.max_daily_amount);
  const unit = unitOf(drug.max_daily_unit);
  return Number.isFinite(amount) && amount > 0 && unit ? { amount, unit: drug.max_daily_unit, ...unit } : null;
}

// A line's dose a day, in the unit of its medicine's most a day:
// { amount, unit, max, over }, or null when it cannot be worked out.
function dailyDose(line, drug) {
  const max = maxOf(drug);
  const times = perDay(line.frequency);
  const dose = parseDose(line.dose);
  if (!max || !times || !dose) return null;
  const strength = parseStrength(line.strength || drug.strength);
  // One of the form holds this much (a tablet of 500 mg; 100 mcg a puff).
  const perUnit = strength && (!strength.per || strength.per.kind === 'count') ? strength.base / (strength.per ? strength.per.base : 1) : null;
  const doses = dose.quantity * times;
  let amount = null;
  if (dose.kind === max.kind) amount = (doses * dose.factor) / max.factor;
  else if (dose.kind === 'count' && perUnit !== null && strength.kind === max.kind) amount = (doses * perUnit) / max.factor;
  else if (dose.kind === 'volume' && strength?.per?.kind === 'volume' && strength.kind === max.kind) amount = ((doses * dose.factor) / strength.per.base) * strength.base / max.factor;
  else if (max.kind === 'count' && perUnit && dose.kind === strength.kind) amount = (doses * dose.factor) / perUnit;
  if (amount === null || !Number.isFinite(amount)) return null;
  return { amount, unit: max.unit, max: max.amount, over: amount > max.amount * (1 + 1e-9) };
}

const figure = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(n);

// --- Allergies ----------------------------------------------------------------------

// Words that never say which medicine: how an allergy is written, forms, and
// "none known".
const WRITING = new Set(['allergy', 'allergie', 'allergic', 'and', 'with', 'the', 'known', 'history', 'reaction', 'rash', 'hive', 'itching', 'swelling',
  'severe', 'mild', 'moderate', 'drug', 'medicine', 'medication', 'tablet', 'tab', 'capsule', 'cap', 'syrup', 'injection', 'cream', 'ointment', 'group',
  'class', 'family', 'type', 'intolerance', 'intolerant', 'sensitivity', 'sensitive', 'anaphylaxis', 'none', 'nil', 'nkda', 'nka', 'not', 'any']);
// Salts and the like: they say which medicine only when nothing else does
// (calcium carbonate), never beside its name (diclofenac sodium is diclofenac).
const SALTS = new Set(['sodium', 'potassium', 'calcium', 'magnesium', 'hydrochloride', 'hcl', 'acid', 'salt', 'sulfate', 'maleate', 'citrate', 'phosphate',
  'acetate', 'bromide', 'chloride', 'mesylate', 'besylate', 'succinate', 'tartrate', 'fumarate', 'gluconate', 'carbonate', 'oxide', 'trihydrate',
  'monohydrate', 'dihydrate']);
const SAME_AS = { sulfa: 'sulfonamide', sulfonamides: 'sulfonamide', nsaids: 'nsaid' };

const stem = (word) => {
  let w = word.replace(/^sulph/, 'sulf');
  if (SAME_AS[w]) return SAME_AS[w];
  if (w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return SAME_AS[w] || w;
};

// The words of a name or an allergy that say which medicine: lower case,
// singular, salts and forms left out.
function significant(text) {
  const words = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/non[- ]?steroidal anti[- ]?inflammatory( drugs?)?/g, ' nsaid ')
    .split(/[^a-z0-9]+/).filter(Boolean).map(stem).filter((w) => w.length >= 3 && !WRITING.has(w));
  const named = words.filter((w) => !SALTS.has(w));
  return named.length ? named : words;
}

const within = (outer, inner) => inner.length > 0 && inner.every((w) => outer.includes(w));
const meets = (a, b) => a.length > 0 && b.length > 0 && (within(a, b) || within(b, a));

// The patient's allergies as written, one term each: split at commas,
// semicolons, slashes, new lines and "and"; terms saying nothing are left out.
function allergyTerms(text) {
  return String(text ?? '').split(/[,;/\n]|\band\b|&|\+/i).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .map((part) => ({ text: part, words: significant(part) })).filter((term) => term.words.length);
}

// The names a medicine is known by: its generic name and each brand name.
const namesOf = (drug) => [drug.generic_name || drug.drugName || '', ...String(drug.brand_names || '').split(/[,;/]/)].map(significant).filter((w) => w.length);

// Which allergy groups the patient's allergies point to through the list: an
// allergy naming a medicine of the list (aspirin) points to its group (NSAIDs).
function relatedGroups(terms, list) {
  const groups = [];
  for (const term of terms) {
    for (const drug of list || []) {
      const group = significant(drug.allergy_group);
      if (!group.length || groups.some((g) => g.term === term && g.words.join(' ') === group.join(' '))) continue;
      if (namesOf(drug).some((name) => meets(name, term.words))) groups.push({ term, words: group, group: drug.allergy_group, via: drug.generic_name });
    }
  }
  return groups;
}

// Whether a medicine meets one of the patient's allergies: { kind, term,
// group } (kind generic, group or related), or null.
function allergyMatch(terms, related, drug) {
  for (const term of terms) if (namesOf(drug).some((name) => meets(name, term.words))) return { kind: 'generic', term: term.text };
  const group = significant(drug.allergy_group);
  if (!group.length) return null;
  for (const term of terms) if (meets(group, term.words)) return { kind: 'group', term: term.text, group: drug.allergy_group };
  const name = significant(drug.generic_name || drug.drugName);
  for (const r of related) {
    if (r.words.join(' ') === group.join(' ') && !meets(significant(r.via), name)) return { kind: 'related', term: r.term.text, group: drug.allergy_group };
  }
  return null;
}

// --- The prescription -----------------------------------------------------------------

const KINDS = ['allergy', 'same_medicine', 'same_group', 'dose_over_max'];

// Each warning of a prescription: lines [{ drugName, strength, dose,
// frequency, drug (the list's row, or null for a line written by hand) }],
// the patient's allergies as written, and the clinic's list (for the groups
// an allergy points to). Returns [{ line (from 0), kind, message }], at most
// one of a kind on a line, in the lines' order.
function checkPrescription(lines, { allergies = '', list = [] } = {}) {
  const terms = allergyTerms(allergies);
  const related = relatedGroups(terms, list);
  const named = (line) => (line.drug ? { ...line.drug, drugName: line.drugName } : { generic_name: line.drugName, brand_names: null, allergy_group: null });
  const nameOf = (line) => line.drug?.generic_name || line.drugName;
  const warnings = [];
  lines.forEach((line, index) => {
    const drug = named(line);
    const name = nameOf(line);
    const hit = allergyMatch(terms, related, drug);
    if (hit) {
      const said = `the patient's allergies say "${hit.term}"`;
      warnings.push({ line: index, kind: 'allergy', message: hit.kind === 'generic' ? `Allergy: ${said}, and this is ${name}.`
        : hit.kind === 'group' ? `Allergy: ${said}, and ${name} is in ${hit.group}.` : `Allergy: ${said}, a medicine in ${hit.group}, and ${name} is in ${hit.group} too.` });
    }
    const mine = significant(name);
    const earlier = lines.slice(0, index).findIndex((other) => meets(significant(nameOf(other)), mine));
    if (earlier >= 0) warnings.push({ line: index, kind: 'same_medicine', message: `${name} is on line ${earlier + 1} already.` });
    else {
      const group = significant(drug.allergy_group);
      const twin = group.length ? lines.slice(0, index).findIndex((other) => other.drug && significant(other.drug.allergy_group).join(' ') === group.join(' ')) : -1;
      if (twin >= 0) warnings.push({ line: index, kind: 'same_group', message: `${name} and ${nameOf(lines[twin])} (line ${twin + 1}) are both ${drug.allergy_group}.` });
    }
    const daily = line.drug ? dailyDose(line, line.drug) : null;
    if (daily?.over) {
      const how = [line.dose || 'one', line.frequency].filter(Boolean).join(' ');
      warnings.push({ line: index, kind: 'dose_over_max', message: `${name}: ${how} is ${figure(daily.amount)} ${daily.unit} a day, more than the most of ${figure(daily.max)} ${daily.unit} a day.` });
    }
  });
  return warnings;
}

module.exports = { MAX_UNITS, KINDS, quantity, parseDose, parseStrength, perDay, dailyDose, significant, allergyTerms, relatedGroups, allergyMatch, checkPrescription, figure };
