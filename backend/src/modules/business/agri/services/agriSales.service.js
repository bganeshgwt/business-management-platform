const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const common = require('./agriCommon');
const licences = require('../../licences/services/businessLicences.service');

// A seeds, fertilisers & pesticides shop's bill, inside the sale's own
// posting (business.service.js › postDocument, which calls here for a sale of
// a farm-input shop with its tools on):
//   checkSale    before anything is saved: every fertiliser, seed, pesticide
//                and bio-input line is checked, and what the bill keeps is
//                worked out (a line refused refuses the whole bill)
//   checkCredit  once the payments are known: a season goes on a named
//                customer's bill on credit
//   recordSale   after the bill and its lines are saved: agri_sale_lines,
//                agri_bills, the activity log and the outbox
// and checkPurchase for a receipt of stock, and invoiceExtras for what the
// bill shows and prints.
//
// Each line, by the kind of input its item is:
//   - an item made of a banned molecule is never sold;
//   - a fertiliser, seed or pesticide needs a licence in force covering it at
//     the selling location today, while Licences & registrations is on;
//   - a seed lot past its validity (its batch's expiry), or any other batch
//     past its expiry, is not sold;
//   - a molecule barred on some crops needs the crop the farmer is buying for
//     (the line's own, or the bill's), and is refused for a barred crop;
//   - a subsidised fertiliser needs the receipt number the government's PoS
//     device printed (the line's own, or the bill's). No Aadhaar number is
//     ever asked for or kept.
// The database repeats these rules where the line is kept (agri_sale_line_check).

const { fail, SEASONS, LICENCE_FOR, LICENCE_WORDS, KIND_WORDS, normal, classification, dateWords, listWords } = common;
const RECEIPT = /^[A-Za-z0-9/-]{3,40}$/;
const blank = (value) => value === undefined || value === null || value === '';

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
// gives none of its own; a credit bill's season, its year and the harvest
// due date; a walk-in farmer's village.
function readBill(body, contact, today) {
  const raw = body.agri;
  const none = { posReceipt: null, crop: null, season: null, seasonYear: null, dueOn: null, village: null };
  if (blank(raw)) return none;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('The farm-input details must be an object');
  const season = blank(raw.season) ? null : v.requiredEnum(raw.season, 'Season', SEASONS);
  const parts = [season, raw.seasonYear, raw.dueOn].filter((x) => !blank(x));
  if (parts.length && parts.length < 3) fail('Give the season, its year and the harvest due date together');
  let seasonYear = null, dueOn = null;
  if (season) {
    seasonYear = v.requiredId(raw.seasonYear, 'Season year');
    const year = Number(today.slice(0, 4));
    if (seasonYear < year - 1 || seasonYear > year + 1) fail(`The season's year is ${year - 1}, ${year} or ${year + 1}`);
    dueOn = common.readDate(raw.dueOn, 'Harvest due date');
    if (dueOn < today) fail('The harvest due date is today or later');
    if (common.daysBetween(today, dueOn) > 400) fail('The harvest due date is at most 400 days away');
  }
  const village = blank(raw.village) ? null : v.requiredString(raw.village, 'Village', 100);
  if (village && contact) fail('A named customer\'s village is kept with their farmer details, not on the bill');
  return { posReceipt: readReceipt(raw.posReceipt), crop: readCrop(raw.crop), season, seasonYear, dueOn, village };
}

// prepared: the bill's lines (each with its item, its stock-unit quantity
// and batch); location: the selling location; contact: the customer, or null.
async function checkSale(db, business, { prepared, body, location, contact }) {
  const today = await common.today(db, business);
  const bill = readBill(body, contact, today);
  const { byName, crops } = await common.molecules(db);
  const licencesOn = business.modules.includes('licences');
  const standings = new Map();
  const lines = [];
  for (const line of prepared) {
    const item = classification(line.sku.attributes);
    const input = (Array.isArray(body.lines) && body.lines[line.inputIndex]) || {};
    const ownCrop = readCrop(input.crop), ownReceipt = readReceipt(input.posReceipt);
    if (!item.kind || item.kind === 'other') {
      if (ownCrop || ownReceipt) fail(`${line.sku.label} is not a fertiliser, seed or pesticide: a crop or a PoS receipt goes on a farm input's line`);
      continue;
    }
    const listed = item.molecules.map((name) => byName.get(normal(name))).filter(Boolean);
    const banned = listed.find((m) => m.status === 'banned');
    if (banned) fail(`${line.sku.label} contains ${banned.name}, banned in India (${banned.source}). It cannot be sold.`, 409);
    const category = LICENCE_FOR[item.kind];
    if (category && licencesOn) {
      if (!standings.has(category)) standings.set(category, await licences.standing(db, business, { locationId: location.id, category, on: today }));
      const held = standings.get(category);
      if (!held?.in_force) {
        fail(`${line.sku.label} is a ${KIND_WORDS[item.kind]}, and ${licences.whyNot(held, LICENCE_WORDS[category], location.name)}. Add or renew it under Settings › Licences, then bill it.`, 409);
      }
    }
    if (line.lotCode) {
      const lot = await repo.one(db, 'SELECT expires_on FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4',
        [business.id, location.id, line.sku.id, line.lotCode]);
      if (lot?.expires_on && lot.expires_on < today) {
        fail(item.kind === 'seed' ? `Seed lot ${line.lotCode} of ${line.sku.label} was valid until ${dateWords(lot.expires_on)}: it cannot be sold.`
          : `Batch ${line.lotCode} of ${line.sku.label} expired on ${dateWords(lot.expires_on)}: it cannot be sold. Keep it apart, marked not for sale.`, 409);
      }
    }
    const cropText = ownCrop || bill.crop;
    const crop = cropText ? common.matchCrop(crops, cropText) : null;
    const barred = listed.filter((m) => m.status === 'crop_restricted');
    if (barred.length && !cropText) {
      fail(`${line.sku.label} contains ${listWords(barred.map((m) => m.name))}, which must not be used on some crops: give the crop the farmer is buying it for.`);
    }
    const pair = crop && barred.find((m) => m.crops.some((c) => c.code === crop.code));
    if (pair) fail(`${pair.name} must not be used on ${crop.name.toLowerCase()}: ${line.sku.label} cannot be sold for it (${pair.source}).`, 409);
    const receipt = item.subsidised ? ownReceipt || bill.posReceipt : null;
    if (item.subsidised && !receipt) fail(`${line.sku.label} is a subsidised fertiliser: give the receipt number the PoS device printed for this sale.`);
    if (!item.subsidised && ownReceipt) fail(`${line.sku.label} is not a subsidised fertiliser: a PoS receipt goes on a subsidised fertiliser's line`);
    lines.push({ line, kind: item.kind, subsidised: item.subsidised, posReceipt: receipt, crop: cropText, cropCode: crop?.code || null, molecules: item.molecules });
  }
  if (bill.posReceipt && !lines.some((l) => l.subsidised)) fail('A PoS receipt goes on a bill with a subsidised fertiliser on it');
  if (bill.village && !lines.length) fail('A walk-in farmer\'s village goes on a bill with farm inputs on it');
  const buyerName = contact ? null : v.optionalString(body.buyer?.name, 'Buyer name', 150);
  return { ...bill, today, lines, buyerName: lines.length ? buyerName : null };
}

// Once the payments are known: a season goes on a named customer's bill
// that leaves something on credit. unpaid: paise left to pay.
function checkCredit(plan, { contact, unpaid }) {
  if (!plan?.season) return;
  if (!contact) fail('Season credit is for a named customer: choose the farmer first');
  if (unpaid <= 0) fail('This bill is paid in full: a season and its harvest due date go on a bill on credit');
}

// After the bill and its lines are saved (each prepared line has its id now).
async function recordSale(db, business, user, saved, plan) {
  for (const l of plan.lines) {
    await db.query(`INSERT INTO agri_sale_lines(business_id,line_id,document_id,sku_id,input_kind,subsidised,pos_receipt,crop,crop_code,molecules)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [business.id, l.line.id, saved.id, l.line.sku.id, l.kind, l.subsidised, l.posReceipt, l.crop, l.cropCode, l.molecules]);
  }
  const walkIn = !saved.contact_id && (plan.buyerName || plan.village);
  if (plan.season || walkIn) {
    await db.query(`INSERT INTO agri_bills(business_id,document_id,season,season_year,buyer_name,village,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [business.id, saved.id, plan.season, plan.seasonYear, walkIn ? plan.buyerName : null, walkIn ? plan.village : null, user.id]);
  }
  if (!plan.lines.length && !plan.season) return;
  const receipts = [...new Set(plan.lines.filter((l) => l.subsidised).map((l) => l.posReceipt))];
  await repo.audit(db, business.id, user.id, 'sale.farm_inputs', saved.id, { documentNo: saved.document_no, lines: plan.lines.length,
    ...(receipts.length ? { posReceipts: receipts } : {}), ...(plan.season ? { season: plan.season, seasonYear: plan.seasonYear, dueOn: plan.dueOn } : {}) });
  // Subsidised fertiliser sold, for anything that later mirrors the PoS (the outbox).
  const subsidised = plan.lines.filter((l) => l.subsidised);
  if (subsidised.length) {
    await repo.event(db, business.id, user.id, 'agri.subsidised_sale', 'document', saved.id, { documentNo: saved.document_no, locationId: saved.location_id,
      lines: subsidised.map((l) => ({ lineId: l.line.id, skuId: l.line.sku.id, quantity: l.line.quantity, posReceipt: l.posReceipt })) });
  }
}

// A receipt of stock: a seed lot comes in with its validity date (its expiry).
function checkPurchase(prepared) {
  for (const line of prepared) {
    if (classification(line.sku.attributes).kind === 'seed' && line.lotCode && !line.expiresOn) {
      fail(`${line.sku.label} is a seed: give lot ${line.lotCode}'s validity date as its expiry (the test date on its tag plus 9 months).`);
    }
  }
}

// What a farm-input shop's bill shows and prints: each farm-input line's
// kind, PoS receipt and crop; the season of a credit bill; the farmer (a
// walk-in's name and village, or the customer's farmer details); and the
// selling location's licences in force that day for what is on the bill.
async function invoiceExtras(db, business, doc) {
  const lines = await repo.all(db, 'SELECT line_id,input_kind,subsidised,pos_receipt,crop FROM agri_sale_lines WHERE business_id=$1 AND document_id=$2 ORDER BY line_id', [business.id, doc.id]);
  const bill = await repo.one(db, 'SELECT season,season_year,buyer_name,village FROM agri_bills WHERE business_id=$1 AND document_id=$2', [business.id, doc.id]);
  const farmer = doc.contact_id ? await repo.one(db, 'SELECT village,relative_name,farmer_id FROM agri_farmers WHERE business_id=$1 AND contact_id=$2', [business.id, doc.contact_id]) : null;
  if (!lines.length && !bill && !farmer) return null;
  const categories = [...new Set(lines.map((l) => LICENCE_FOR[l.input_kind]).filter(Boolean))];
  const held = categories.length && business.modules.includes('licences') ? await repo.all(db, `SELECT l.kind,l.name,l.licence_no,l.covers FROM business_licences l
      JOIN business_documents d ON d.business_id=l.business_id AND d.id=$3 JOIN businesses b ON b.id=d.business_id
      WHERE l.business_id=$1 AND l.location_id=d.location_id AND l.active AND l.covers && $2::text[]
        AND l.valid_from <= (d.created_at AT TIME ZONE b.timezone)::date AND (l.valid_until IS NULL OR l.valid_until >= (d.created_at AT TIME ZONE b.timezone)::date)
      ORDER BY l.kind,l.id`, [business.id, categories, doc.id]) : [];
  return { lines, bill: bill || null, farmer: farmer || null, licences: held };
}

module.exports = { given, applies: common.applies, checkSale, checkCredit, recordSale, checkPurchase, invoiceExtras };
