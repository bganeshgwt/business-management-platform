// What an online shop never shows, whatever its settings say (BUSINESS_RULES.md,
// the online shop: never online). One function decides it for every place an
// item can reach a guest: the shop's lists and search, an item's page, the
// cart check and placing an order (shopCatalog.service.js builds each of them
// on it), and staff see the same reason beside the item.
//
//   neverOnlineSql({ sku, product, words })
//     → a SQL expression that is NULL for an item that may be shown, or the
//       code of the first rule that keeps it off. `sku` and `product` are the
//       aliases of catalog_skus and catalog_products in the query; `words` is
//       an SQL expression holding the item's category path as text (its
//       category and every parent), or NULL.
//   NEVER_ONLINE[code]
//     → why, in words for staff.
//
// The rules, in the order they are asked:
//   service         a service, not goods
//   internal_use    kept for use in services only, never sold
//   kit             a kit or bundle (sold at the counter, as its parts)
//   special_type    an item a trade sells through its own screen: a jeweller's
//                   pieces, a rental's hire, a fuel, a room's nights, a gym's plan
//   prescription    a Schedule H, H1 or X or narcotic medicine: only on a
//                   registered doctor's prescription, by or under a registered
//                   pharmacist (Drugs Rules r.65), never sold online
//   tobacco         HSN 2401 to 2403, heated tobacco and nicotine for inhaling
//                   (2404 11, 12, 19), e-cigarettes (8543 40; banned outright
//                   by PECA 2019 s.4); an item with no HSN code whose name or
//                   category says tobacco, cigarettes, bidi, gutkha, vape …
//   alcohol         HSN 2203 to 2208 (beer, wine, spirits); an item with no HSN
//                   code whose name or category says beer, wine, whisky …
//   contact_lens    a contact lens: sold only against the customer's
//                   contact-lens prescription under the MD-42 registration
//   subsidised_fertiliser
//                   sold only through the government's PoS device, with the
//                   farmer's own authentication at the counter
//   restricted_pesticide
//                   a pesticide with a molecule banned, restricted to approved
//                   users, barred on some crops, or allowed in one formulation
//                   only (the agri molecule master)
//
// A name or category alone never keeps off an item that has its HSN code: a
// "Rum & raisin cake" with its bakery HSN code shows; one with no code waits
// for its code.

const SCHEDULED = ['H', 'H1', 'X', 'narcotic'];
const TOBACCO_HSN = '^(240[123]|24041[129]|854340)';
const ALCOHOL_HSN = '^220[3-8]';
const TOBACCO_WORDS = ['cigarettes?', 'cigars?', 'cigarillos?', 'bidis?', 'beedis?', 'gutkha', 'gutka', 'khaini', 'zarda', 'tobacco', 'hookahs?',
  'e-?cigarettes?', 'e-?cigs?', 'vapes?', 'vaping'];
const ALCOHOL_WORDS = ['beers?', 'wines?', 'whisky', 'whiskey', 'whiskies', 'vodka', 'rum', 'brandy', 'gin', 'liquors?', 'toddy', 'arrack', 'feni',
  'tequila', 'champagne'];
// The same words as JavaScript and PostgreSQL patterns: whole words, any case.
const wordsPattern = (words) => `(${words.join('|')})`;
const TOBACCO_RE = new RegExp(`\\b${wordsPattern(TOBACCO_WORDS)}\\b`, 'i');
const ALCOHOL_RE = new RegExp(`\\b${wordsPattern(ALCOHOL_WORDS)}\\b`, 'i');
const pgWords = (words) => `'\\m${wordsPattern(words)}\\M'`;

const NEVER_ONLINE = {
  service: 'A service, not goods: services are not sold in the online shop.',
  internal_use: 'Kept for use in services only, never sold.',
  kit: 'A kit or bundle: it is sold at the counter, as its parts.',
  special_type: 'Sold only from its own screen (jewellery pieces, hire, fuel, room nights, membership plans).',
  prescription: 'A Schedule H, H1 or X or narcotic medicine: sold only against a doctor\'s prescription at the counter.',
  tobacco: 'Tobacco, nicotine or an e-cigarette: never sold online. Give the item its HSN code if it is none of these.',
  alcohol: 'An alcoholic drink: never sold online. Give the item its HSN code if it is not one.',
  contact_lens: 'A contact lens: sold only against the customer\'s contact-lens prescription at the counter.',
  subsidised_fertiliser: 'A subsidised fertiliser: sold only through the PoS device, with the farmer\'s authentication at the counter.',
  restricted_pesticide: 'A pesticide with a banned or restricted molecule: never sold online.',
};

// The item's facts every rule reads: aliases of catalog_skus (s) and
// catalog_products (p), and the category path as text.
function neverOnlineSql({ sku = 's', product = 'p', words = 'NULL' } = {}) {
  const s = sku, p = product;
  // The item's own words for the keyword rules: its product's name, its label and its category path.
  const text = `concat_ws(' ',${p}.name,${s}.label,${words})`;
  const noHsn = `NULLIF(btrim(COALESCE(${s}.hsn_code,'')),'') IS NULL`;
  const molecule = `lower(regexp_replace(btrim(x.name),'\\s+',' ','g'))`;
  const formulaKey = (expression) => `regexp_replace(lower(COALESCE(${expression},'')),'[^a-z0-9%]','','g')`;
  return `CASE
    WHEN ${p}.kind <> 'goods' THEN 'service'
    WHEN ${s}.internal_use THEN 'internal_use'
    WHEN ${s}.is_kit THEN 'kit'
    WHEN EXISTS (SELECT 1 FROM jewellery_items j WHERE j.business_id=${s}.business_id AND j.sku_id=${s}.id)
      OR EXISTS (SELECT 1 FROM jewellery_account_items j WHERE j.business_id=${s}.business_id AND j.sku_id=${s}.id)
      OR EXISTS (SELECT 1 FROM rental_items r WHERE r.business_id=${s}.business_id AND r.sku_id=${s}.id)
      OR EXISTS (SELECT 1 FROM fuel_products f WHERE f.business_id=${s}.business_id AND f.sku_id=${s}.id)
      OR EXISTS (SELECT 1 FROM lodging_room_types t WHERE t.business_id=${s}.business_id AND t.sku_id=${s}.id)
      OR EXISTS (SELECT 1 FROM member_plan_types m WHERE m.business_id=${s}.business_id AND m.price_sku_id=${s}.id) THEN 'special_type'
    WHEN EXISTS (SELECT 1 FROM pharmacy_drugs d WHERE d.business_id=${s}.business_id AND d.sku_id=${s}.id
      AND d.schedule IN (${SCHEDULED.map((x) => `'${x}'`).join(',')})) THEN 'prescription'
    WHEN ${s}.hsn_code ~ '${TOBACCO_HSN}' OR (${noHsn} AND ${text} ~* ${pgWords(TOBACCO_WORDS)}) THEN 'tobacco'
    WHEN ${s}.hsn_code ~ '${ALCOHOL_HSN}' OR (${noHsn} AND ${text} ~* ${pgWords(ALCOHOL_WORDS)}) THEN 'alcohol'
    WHEN NULLIF(btrim(COALESCE(${s}.attributes->>'baseCurve','')),'') IS NOT NULL THEN 'contact_lens'
    WHEN ${s}.attributes->>'inputKind'='fertiliser' AND ${s}.attributes->>'subsidised'='yes' THEN 'subsidised_fertiliser'
    WHEN jsonb_typeof(${s}.attributes->'molecules')='array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${s}.attributes->'molecules') AS x(name)
      JOIN agri_molecules m ON lower(regexp_replace(btrim(m.name),'\\s+',' ','g'))=${molecule}
      WHERE m.status IN ('banned','crop_restricted') OR m.users_only
        OR (m.only_formulation IS NOT NULL AND ${formulaKey('m.only_formulation')}<>${formulaKey(`${s}.attributes->>'formulation'`)})) THEN 'restricted_pesticide'
  END`;
}

// The keyword rules as JavaScript (staff screens' hint, the unit tests): the
// rule an item with no HSN code would meet by its words, or null.
function keywordRule(text) {
  const words = String(text || '');
  if (TOBACCO_RE.test(words)) return 'tobacco';
  if (ALCOHOL_RE.test(words)) return 'alcohol';
  return null;
}

module.exports = { neverOnlineSql, NEVER_ONLINE, SCHEDULED, TOBACCO_HSN, ALCOHOL_HSN, TOBACCO_WORDS, ALCOHOL_WORDS, keywordRule };
