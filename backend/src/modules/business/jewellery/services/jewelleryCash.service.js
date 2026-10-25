const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');
const { settingsOf } = require('./jewellerySettings.service');

// The cash report (module "jewellery"): the cash the shop took from and paid
// to each customer — cash paid on their bills, their cash receipts (dues,
// advances, gold scheme instalments), cash refunded to them, cash advances
// handed back, and cash paid out for their old gold — in the month to today or
// any period, with a flag at ₹10 lakh. A dealer in precious metals and stones
// that carries out cash transactions of ₹10 lakh or more with a customer, in
// one operation or several that appear linked, is a reporting entity under the
// PMLA (G.S.R. 799(E), 28 December 2020); a reporting entity reports every
// month, by the 15th, the cash transactions above ₹10 lakh and the linked ones
// within a month adding up to more (PMLR Rule 3), to FIU-IND. The shop's own
// alert level comes earlier where it keeps one. Customers with the same PAN
// are one person here, and a walk-in's bill with the buyer's PAN is theirs.
// Nothing is filed from here: the monthly worksheet is for the shop's own
// officer to report from. Money is integer paise in this file.

const { fail } = c;
// ₹10 lakh: cash with one customer from which a dealer may be a reporting entity.
const REPORTING = 100000000;
const KIND_WORDS = { bill: 'Paid on a bill', receipt: 'Receipt (dues or advance)', scheme: 'Gold scheme instalment', refund: 'Refund on a bill',
  advance_back: 'Advance handed back', old_gold: 'Old gold paid out' };

const CASH_SQL = `WITH cash AS (
    SELECT d.contact_id,d.buyer_pan,p.created_at AS at,'bill' AS kind,d.document_no AS ref,p.amount AS cash_in,0::numeric AS cash_out
      FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
      WHERE p.business_id=$1 AND d.kind='sale' AND p.method='cash' AND p.collection_id IS NULL
    UNION ALL SELECT k.contact_id,NULL,k.created_at,
        CASE WHEN EXISTS (SELECT 1 FROM jewellery_scheme_instalments i WHERE i.business_id=k.business_id AND i.collection_id=k.id) THEN 'scheme' ELSE 'receipt' END,
        k.collection_no,k.amount,0
      FROM business_collections k WHERE k.business_id=$1 AND k.method='cash'
    UNION ALL SELECT d.contact_id,d.buyer_pan,f.created_at,'refund',d.document_no,0,f.amount
      FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
      WHERE f.business_id=$1 AND d.kind='sale' AND f.method='cash'
    UNION ALL SELECT f.contact_id,NULL,f.created_at,'advance_back',f.refund_no,0,f.amount
      FROM business_collection_refunds f WHERE f.business_id=$1 AND f.method='cash'
    UNION ALL SELECT g.contact_id,g.pan,p.created_at,'old_gold',g.voucher_no,0,p.amount
      FROM jewellery_old_gold_payouts p JOIN jewellery_old_gold g ON g.business_id=p.business_id AND g.id=p.old_gold_id
      WHERE p.business_id=$1 AND p.method='cash')
  SELECT x.contact_id,x.at,(x.at AT TIME ZONE $2)::date::text AS day,x.kind,x.ref,x.cash_in,x.cash_out,ct.name,ct.phone,COALESCE(ct.pan,x.buyer_pan) AS pan,
    CASE WHEN COALESCE(ct.pan,x.buyer_pan) IS NOT NULL THEN 'pan:'||COALESCE(ct.pan,x.buyer_pan) WHEN x.contact_id IS NOT NULL THEN 'contact:'||x.contact_id END AS person
  FROM cash x LEFT JOIN business_contacts ct ON ct.business_id=$1 AND ct.id=x.contact_id
  WHERE (x.at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`;

const monthWords = (day) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
const rowsIn = (db, business, from, to) => repo.all(db, `${CASH_SQL} ORDER BY x.at,x.ref`, [business.id, business.timezone, from, to]);

// Each person's cash in and out over the rows given, largest first; walk-in cash not linked to anyone apart.
function people(rows, watch) {
  const map = new Map();
  let unlinked = { count: 0, cashIn: 0, cashOut: 0 };
  for (const r of rows) {
    const cashIn = c.paise(r.cash_in), cashOut = c.paise(r.cash_out);
    if (!r.person) { unlinked = { count: unlinked.count + 1, cashIn: unlinked.cashIn + cashIn, cashOut: unlinked.cashOut + cashOut }; continue; }
    const p = map.get(r.person) || { key: r.person, pan: r.pan || null, contacts: new Map(), count: 0, cashIn: 0, cashOut: 0, largest: 0, last: null };
    if (r.contact_id) p.contacts.set(Number(r.contact_id), { id: Number(r.contact_id), name: r.name, phone: r.phone });
    p.count += 1; p.cashIn += cashIn; p.cashOut += cashOut; p.largest = Math.max(p.largest, cashIn, cashOut); p.last = r.day;
    map.set(r.person, p);
  }
  const list = [...map.values()].map((p) => {
    const total = p.cashIn + p.cashOut;
    const level = total >= REPORTING ? 'reporting' : watch && total >= watch ? 'watch' : null;
    return { key: p.key, pan: p.pan, contacts: [...p.contacts.values()], name: [...p.contacts.values()].map((x) => x.name).join(', ') || `PAN ${p.pan}`,
      phone: [...p.contacts.values()].map((x) => x.phone).filter(Boolean).join(', ') || null, count: p.count, cashIn: c.rupees(p.cashIn), cashOut: c.rupees(p.cashOut),
      total: c.rupees(total), largest: c.rupees(p.largest), lastDay: p.last, level };
  }).sort((a, b) => c.paise(b.total) - c.paise(a.total) || a.name.localeCompare(b.name));
  return { list, unlinked: { count: unlinked.count, cashIn: c.rupees(unlinked.cashIn), cashOut: c.rupees(unlinked.cashOut) } };
}

async function readPeriod(db, business, query) {
  const today = await c.today(db, business);
  // The month to today: from the day after the same date last month.
  const from = c.given(query.from) ? core.dateText(query.from, 'From date') : c.addDays(c.addMonths(today, -1), 1);
  const to = c.given(query.to) ? core.dateText(query.to, 'To date') : today;
  if (to < from) fail('The end date is before the start date');
  if (c.daysBetween(from, to) > 366) fail('Choose up to a year for the cash report');
  return { today, from, to };
}

async function guard(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.export');
  await c.requireMoney(business);
}

// Each customer's cash in and out over a period (the month to today unless asked), largest first.
async function report(business, query = {}) {
  await guard(business);
  const period = await readPeriod(repo.pool, business, query);
  const settings = await settingsOf(repo.pool, business.id);
  const watch = settings.cash_watch_level === null || settings.cash_watch_level === undefined ? null : c.paise(settings.cash_watch_level);
  const { list, unlinked } = people(await rowsIn(repo.pool, business, period.from, period.to), watch);
  return { ...period, reportingLevel: c.rupees(REPORTING), watchLevel: watch === null ? null : c.rupees(watch), reportingEntity: settings.reporting_entity,
    reportingEntityAt: settings.reporting_entity_at, people: list, unlinked,
    totals: { people: list.length, reporting: list.filter((p) => p.level === 'reporting').length, watch: list.filter((p) => p.level === 'watch').length,
      cashIn: c.rupees(list.reduce((s, p) => s + c.paise(p.cashIn), 0) + c.paise(unlinked.cashIn)),
      cashOut: c.rupees(list.reduce((s, p) => s + c.paise(p.cashOut), 0) + c.paise(unlinked.cashOut)) } };
}

// One person's cash transactions over the period, as recorded.
async function person(business, query = {}) {
  await guard(business);
  const key = String(query.key || '');
  if (!/^(pan:[A-Z]{5}[0-9]{4}[A-Z]|contact:\d{1,18})$/.test(key)) fail('Choose a customer from the cash report');
  const period = await readPeriod(repo.pool, business, query);
  const rows = (await rowsIn(repo.pool, business, period.from, period.to)).filter((r) => r.person === key);
  return { ...period, key, transactions: rows.map((r) => ({ at: r.at, day: r.day, kind: r.kind, kindWords: KIND_WORDS[r.kind], ref: r.ref, name: r.name, cashIn: Number(r.cash_in).toFixed(2),
    cashOut: Number(r.cash_out).toFixed(2) })) };
}

// The monthly cash transactions worksheet (a calendar month; last month unless asked): each
// person whose cash that month was above ₹10 lakh, in one transaction or several, with every
// cash transaction of theirs, and when a reporting entity's report of the month is due (the 15th).
async function month(business, query = {}) {
  await guard(business);
  const today = await c.today(repo.pool, business);
  const text = c.given(query.month) ? String(query.month) : c.addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) fail('A month is written like 2026-09');
  const from = `${text}-01`;
  const to = c.addDays(c.addMonths(from, 1), -1);
  if (from > today) fail('That month has not begun');
  const rows = await rowsIn(repo.pool, business, from, to);
  const settings = await settingsOf(repo.pool, business.id);
  const { list } = people(rows, null);
  const reported = list.filter((p) => c.paise(p.total) > REPORTING || c.paise(p.largest) > REPORTING);
  return { month: text, from, to, dueBy: `${c.addMonths(from, 1).slice(0, 7)}-15`, reportingEntity: settings.reporting_entity,
    people: reported.map((p) => ({ ...p, transactions: rows.filter((r) => r.person === p.key).map((r) => ({ at: r.at, day: r.day, kind: r.kind, kindWords: KIND_WORDS[r.kind],
      ref: r.ref, name: r.name, cashIn: Number(r.cash_in).toFixed(2), cashOut: Number(r.cash_out).toFixed(2) })) })) };
}

// The bell (for whoever sees the cash report): cash with a customer at ₹10 lakh in the
// month to today; past the shop's own level; and, for a reporting entity, last month's
// worksheet due by the 15th.
async function bell(business, base) {
  if (!access.can(business, 'jewellery.export') || !c.seesMoney(business)) return [];
  const today = await c.today(repo.pool, business);
  const settings = await settingsOf(repo.pool, business.id);
  const watch = settings.cash_watch_level === null || settings.cash_watch_level === undefined ? null : c.paise(settings.cash_watch_level);
  const { list } = people(await rowsIn(repo.pool, business, c.addDays(c.addMonths(today, -1), 1), today), watch);
  const items = [];
  const reporting = list.filter((p) => p.level === 'reporting');
  if (reporting.length) {
    items.push({ id: `jewellery-cash:${today}`, severity: 'critical', category: 'Cash report', title: `Cash with ${c.plural(reporting.length, 'customer')} reached ₹10 lakh in a month`,
      detail: 'A jeweller with cash transactions of ₹10 lakh or more with a customer is a reporting entity under the PMLA', at: `${today}T00:00:00.000Z`, link: `${base}/cash-report` });
  }
  const watched = list.filter((p) => p.level === 'watch');
  if (watched.length) {
    items.push({ id: `jewellery-cash-watch:${today}`, severity: 'warning', category: 'Cash report', title: `${c.plural(watched.length, 'customer')} past the shop's cash alert level`,
      detail: `Cash in and out with each came to ${c.rupees(watch)} or more in the month to today`, at: `${today}T00:00:00.000Z`, link: `${base}/cash-report` });
  }
  if (settings.reporting_entity && Number(today.slice(8, 10)) <= 15) {
    const last = c.addMonths(`${today.slice(0, 7)}-01`, -1);
    const lastRows = await rowsIn(repo.pool, business, last, c.addDays(`${today.slice(0, 7)}-01`, -1));
    if (people(lastRows, null).list.some((p) => c.paise(p.total) > REPORTING || c.paise(p.largest) > REPORTING)) {
      items.push({ id: `jewellery-cash-month:${last.slice(0, 7)}`, severity: 'warning', category: 'Cash report', title: `The cash transactions of ${monthWords(last)} are reported by the 15th`,
        detail: 'Open the month\'s worksheet in the cash report', at: `${today.slice(0, 7)}-01T00:00:00.000Z`, link: `${base}/cash-report` });
    }
  }
  return items;
}

module.exports = { KIND_WORDS, report, person, month, bell };
