const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// What the jewellery services share: the type and module guard, the metals
// and purities a jeweller rates and sells by, reading weights and rates as the
// counter types them, request keys, and the business's own date.
// Money is integer paise and weight is integer milligrams in these files;
// dates are YYYY-MM-DD text on the business's clock.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

function requireJewellery(business) {
  if (business.business_type !== 'jewellery') fail('This screen belongs to jewellery shops', 404);
  if (!business.modules.includes('jewellery')) fail('Gold rates & jewellery is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

// The purities a jeweller rates, sells and buys by: gold in carats with its
// fineness (parts per thousand), silver and platinum by their fineness. The
// database knows the same list (jewellery_fineness).
const PURITIES = {
  gold: [{ code: '24K', fineness: 999, carat: 24 }, { code: '22K', fineness: 916, carat: 22 }, { code: '18K', fineness: 750, carat: 18 }, { code: '14K', fineness: 585, carat: 14 }],
  silver: [{ code: '999', fineness: 999 }, { code: '925', fineness: 925 }],
  platinum: [{ code: '950', fineness: 950 }],
};
const METALS = Object.keys(PURITIES);
const METAL_WORDS = { gold: 'Gold', silver: 'Silver', platinum: 'Platinum' };
const purityOf = (metal, purity) => PURITIES[metal]?.find((p) => p.code === purity) || null;
// As a hallmark and an invoice show it: 22K916 for gold, 925 for silver, 950 for platinum.
const purityMark = (metal, purity) => {
  const p = purityOf(metal, purity);
  if (!p) return purity;
  return p.carat ? `${p.carat}K${p.fineness}` : String(p.fineness);
};
// "Gold 22K916", "Silver 925".
const purityWords = (metal, purity) => `${METAL_WORDS[metal] || metal} ${purityMark(metal, purity)}`;
// Carat and fineness in words, as the invoice says them: "22 carat, 916 fineness".
const purityLong = (metal, purity) => {
  const p = purityOf(metal, purity);
  if (!p) return purity;
  return p.carat ? `${p.carat} carat, ${p.fineness} fineness` : `${p.fineness} fineness`;
};
// Every purity in the order the screens list them.
const ALL_PURITIES = METALS.flatMap((metal) => PURITIES[metal].map((p) => ({ metal, purity: p.code, fineness: p.fineness, carat: p.carat || null,
  mark: purityMark(metal, p.code), label: purityWords(metal, p.code) })));
const sortKey = (metal, purity) => {
  const index = ALL_PURITIES.findIndex((p) => p.metal === metal && p.purity === purity);
  return index < 0 ? 999 : index;
};

function readPurity(metalValue, purityValue, name = 'Purity') {
  const metal = v.requiredEnum(metalValue, 'Metal', METALS);
  const purity = String(purityValue ?? '').trim().toUpperCase();
  if (!purityOf(metal, purity)) fail(`${name} of ${METAL_WORDS[metal].toLowerCase()} is one of ${PURITIES[metal].map((p) => p.code).join(', ')}`);
  return { metal, purity };
}

const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const optionalText = (value, name, max) => v.optionalString(value === undefined || value === null ? value : String(value), name, max);
// A non-negative decimal as typed, with at most `places` decimals, between min and max.
function decimal(value, name, places = 2, min = 0, max = 100000000) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) fail(`${name} must be a number`);
  const number = Number(text);
  if (number < min || number > max || (text.split('.')[1] || '').length > places) fail(`${name} must be between ${min} and ${max}, with at most ${places} decimal places`);
  return number;
}
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const mg = (value) => Math.round(Number(value) * 1000);
const grams = (milligrams) => (milligrams / 1000).toFixed(3);
// numerator / denominator to the nearest whole number, halves up (both positive).
const roundedDivide = (numerator, denominator) => Number((BigInt(numerator) * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n));
// A rate per gram (rupees, two places).
const readRate = (value, name) => decimal(value, name, 2, 0.01, 1000000);
// A weight in grams to the milligram.
const readWeight = (value, name, min = 0.001) => decimal(value, name, 3, min, 100000);

const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
// A request key for each part of a posting, made from the posting's own key,
// so a retried posting never makes its parts twice.
const derivedKey = (key, part) => {
  const h = crypto.createHash('sha256').update(`${key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// A calendar date as typed (YYYY-MM-DD), checked.
function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// The same day of the month n months on (the month's last day when it has fewer days).
function addMonths(day, months) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
// The business's own date (its time zone), as YYYY-MM-DD.
async function today(db, business) {
  return (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone || 'Asia/Kolkata'])).day;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Money (prices, rates, values) is for those who see sales.
const seesMoney = (business) => access.can(business, 'sales.view');
async function requireMoney(business) {
  if (!seesMoney(business)) await access.require(business, 'sales.view');
}

// The business locked for a posting: one lock order for every posting (business, then its records).
const lockBusiness = (db, business) => db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
// An active location of the business that the person may work at.
async function locationRow(db, business, value, name = 'Location') {
  const locationId = id(value, name);
  access.requireLocation(business, locationId);
  const row = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
  if (!row) fail('Location not found', 404);
  return row;
}
// A contact of the business of a kind (customer or supplier), switched on.
async function contactRow(db, business, value, kind, name) {
  const row = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind=$3', [business.id, id(value, name), kind]);
  if (!row) fail(`${name} not found`, 404);
  if (!row.active) fail(`${row.name} is switched off: switch them on again first`, 409);
  return row;
}
// The fineness metal is taken at (parts in a thousand, one decimal): its purity's own unless typed.
function readFineness(value, metal, purity, name) {
  return given(value) ? decimal(value, name, 1, 0.1, 999.9) : purityOf(metal, purity).fineness;
}
// Fine metal in a weight: milligrams × fineness ÷ 1,000, to the milligram (fineness to one decimal).
const fineMg = (weightMg, fineness) => roundedDivide(BigInt(weightMg) * BigInt(Math.round(Number(fineness) * 10)), 10000);
// The business's date of a moment, as YYYY-MM-DD.
const dayOf = (business, at) => new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone || 'Asia/Kolkata' }).format(new Date(at));
// Reads one after another (a transaction's client runs one query at a time): the results in order.
async function inTurn(...steps) {
  const out = [];
  for (const step of steps) out.push(await step());
  return out;
}

module.exports = { fail, id, requireJewellery, PURITIES, METALS, METAL_WORDS, ALL_PURITIES, purityOf, purityMark, purityWords, purityLong, sortKey, readPurity,
  given, optionalText, decimal, paise, rupees, mg, grams, roundedDivide, readRate, readWeight, hashOf, derivedKey, readDate, addDays, addMonths, daysBetween,
  dateWords, today, plural, seesMoney, requireMoney, lockBusiness, locationRow, contactRow, readFineness, fineMg, dayOf, inTurn };
