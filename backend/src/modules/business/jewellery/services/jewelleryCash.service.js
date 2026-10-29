const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');
const { settingsOf } = require('./jewellerySettings.service');

// The cash report (module "jewellery"): the cash the shop took from and paid
// to each customer — cash paid on their bills, their cash receipts (dues,
// advances, gold scheme instalments), cash refunded to them, cash advances
// handed back, and cash paid out for their old gold — in the rolling month to
// today or any period, with a hard flag at ₹10 lakh and alerts at the shop's
// own levels below it. A dealer in precious metals and stones that carries out
// cash transactions of ₹10 lakh or more with a customer, in one operation or
// several that appear linked, is a reporting entity under the PMLA (G.S.R.
// 799(E), 28 December 2020); a reporting entity reports every month, by the
// 15th, the cash transactions above ₹10 lakh and the linked ones within a
// month adding up to more (PMLR Rule 3), to FIU-IND. Customers are linked into
// one person here when they share a PAN or a phone number, or the shop put
// them in one family group; a walk-in's bill with the buyer's PAN is that
// PAN's. Nothing is filed from here: the monthly worksheet is for the shop's
// own officer to report from. Money is integer paise in this file.

const { fail, id } = c;
// ₹10 lakh: cash with one customer from which a dealer may be a reporting entity.
const REPORTING = 100000000;
const KIND_WORDS = { bill: 'Paid on a bill', receipt: 'Receipt (dues or advance)', scheme: 'Gold scheme instalment', refund: 'Refund on a bill',
  advance_back: 'Advance handed back', old_gold: 'Old gold paid out' };
const LINK_WORDS = { pan: 'Same PAN', phone: 'Same phone number', family: 'Family group' };
const MAX_FAMILY = 30;

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
    m.family_id,fm.name AS family_name
  FROM cash x LEFT JOIN business_contacts ct ON ct.business_id=$1 AND ct.id=x.contact_id
  LEFT JOIN jewellery_cash_family_members m ON m.business_id=$1 AND m.contact_id=x.contact_id LEFT JOIN jewellery_cash_families fm ON fm.business_id=$1 AND fm.id=m.family_id
  WHERE (x.at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`;

const monthWords = (day) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
const rowsIn = (db, business, from, to) => repo.all(db, `${CASH_SQL} ORDER BY x.at,x.ref`, [business.id, business.timezone, from, to]);
// A phone number as people are matched by it: its last ten digits (none when it has fewer).
const phoneKey = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
};

// The rows linked into people: customers sharing a PAN or a phone number, or in one family group, are
// one person; a walk-in bill with a PAN is that PAN's. Each row gets its person's key ('p:' and the
// lowest customer id, else 'pan:' and the PAN), and each person how they were linked.
function linkRows(rows) {
  const parent = new Map();
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const why = new Map();
  const union = (a, b, reason) => {
    add(a); add(b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
    why.set(a, new Set([...(why.get(a) || []), reason])); why.set(b, new Set([...(why.get(b) || []), reason]));
  };
  const byKey = new Map();
  const tie = (node, key, reason) => {
    if (byKey.has(key)) union(node, byKey.get(key), reason); else { add(node); byKey.set(key, node); }
  };
  for (const r of rows) {
    const node = r.contact_id ? `c:${r.contact_id}` : r.pan ? `pan:${r.pan}` : null;
    if (!node) continue;
    add(node);
    if (r.pan) tie(node, `pan:${r.pan}`, 'pan');
    const phone = r.contact_id ? phoneKey(r.phone) : null;
    if (phone) tie(node, `phone:${phone}`, 'phone');
    if (r.family_id) tie(node, `family:${r.family_id}`, 'family');
  }
  // Each group's key: the lowest customer in it, else its PAN.
  const groups = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    groups.set(root, [...(groups.get(root) || []), node]);
  }
  const keyOf = new Map();
  for (const nodes of groups.values()) {
    const customers = nodes.filter((n) => n.startsWith('c:')).map((n) => Number(n.slice(2))).sort((a, b) => a - b);
    const key = customers.length ? `p:${customers[0]}` : nodes.find((n) => n.startsWith('pan:'));
    const reasons = new Set(nodes.flatMap((n) => [...(why.get(n) || [])]));
    for (const n of nodes) keyOf.set(n, { key, links: nodes.filter((x) => x.startsWith('c:')).length > 1 ? [...reasons] : [] });
  }
  return rows.map((r) => {
    const node = r.contact_id ? `c:${r.contact_id}` : r.pan ? `pan:${r.pan}` : null;
    const found = node ? keyOf.get(node) : null;
    return { ...r, person: found?.key || null, links: found?.links || [] };
  });
}

// Each person's cash in and out over the rows given, largest first; walk-in cash not linked to anyone apart.
// levels: the shop's alert levels (paise, lowest first).
function people(rows, levels = []) {
  const map = new Map();
  let unlinked = { count: 0, cashIn: 0, cashOut: 0 };
  for (const r of linkRows(rows)) {
    const cashIn = c.paise(r.cash_in), cashOut = c.paise(r.cash_out);
    if (!r.person) { unlinked = { count: unlinked.count + 1, cashIn: unlinked.cashIn + cashIn, cashOut: unlinked.cashOut + cashOut }; continue; }
    const p = map.get(r.person) || { key: r.person, pans: new Set(), contacts: new Map(), families: new Set(), links: new Set(), count: 0, cashIn: 0, cashOut: 0, largest: 0, last: null };
    if (r.contact_id) p.contacts.set(Number(r.contact_id), { id: Number(r.contact_id), name: r.name, phone: r.phone });
    if (r.pan) p.pans.add(r.pan);
    if (r.family_name) p.families.add(r.family_name);
    for (const link of r.links) p.links.add(link);
    p.count += 1; p.cashIn += cashIn; p.cashOut += cashOut; p.largest = Math.max(p.largest, cashIn, cashOut); p.last = r.day;
    map.set(r.person, p);
  }
  const list = [...map.values()].map((p) => {
    const total = p.cashIn + p.cashOut;
    const reached = [...levels].reverse().find((level) => total >= level) ?? null;
    const level = total >= REPORTING ? 'reporting' : reached !== null ? 'alert' : null;
    const contacts = [...p.contacts.values()];
    return { key: p.key, pan: [...p.pans].join(', ') || null, contacts, name: contacts.map((x) => x.name).join(', ') || `PAN ${[...p.pans][0]}`,
      phone: [...new Set(contacts.map((x) => x.phone).filter(Boolean))].join(', ') || null, families: [...p.families],
      links: [...p.links].map((link) => ({ link, words: LINK_WORDS[link] })), count: p.count, cashIn: c.rupees(p.cashIn), cashOut: c.rupees(p.cashOut),
      total: c.rupees(total), largest: c.rupees(p.largest), lastDay: p.last, level, alertLevel: level === 'alert' ? c.rupees(reached) : null };
  }).sort((a, b) => c.paise(b.total) - c.paise(a.total) || a.name.localeCompare(b.name));
  return { list, unlinked: { count: unlinked.count, cashIn: c.rupees(unlinked.cashIn), cashOut: c.rupees(unlinked.cashOut) } };
}

async function readPeriod(db, business, query) {
  const today = await c.today(db, business);
  // The rolling month to today: from the day after the same date last month.
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
const levelsOf = (settings) => (settings.cash_alert_levels || []).map((x) => c.paise(x)).sort((a, b) => a - b);

// Each person's cash in and out over a period (the rolling month to today unless asked), largest first, with whether
// any of their customers has a KYC document on file.
async function report(business, query = {}) {
  await guard(business);
  const period = await readPeriod(repo.pool, business, query);
  const settings = await settingsOf(repo.pool, business.id);
  const levels = levelsOf(settings);
  const { list, unlinked } = people(await rowsIn(repo.pool, business, period.from, period.to), levels);
  const kyc = await require('./jewelleryKyc.service').onFile(repo.pool, business, list.flatMap((p) => p.contacts.map((x) => x.id)));
  const shown = list.map((p) => ({ ...p, kyc: p.contacts.some((x) => kyc.has(x.id)) }));
  return { ...period, reportingLevel: c.rupees(REPORTING), alertLevels: levels.map(c.rupees), reportingEntity: settings.reporting_entity,
    reportingEntityAt: settings.reporting_entity_at, people: shown, unlinked,
    totals: { people: list.length, reporting: list.filter((p) => p.level === 'reporting').length, alert: list.filter((p) => p.level === 'alert').length,
      cashIn: c.rupees(list.reduce((s, p) => s + c.paise(p.cashIn), 0) + c.paise(unlinked.cashIn)),
      cashOut: c.rupees(list.reduce((s, p) => s + c.paise(p.cashOut), 0) + c.paise(unlinked.cashOut)) } };
}

// One person's cash transactions over the period, as recorded.
async function person(business, query = {}) {
  await guard(business);
  const key = String(query.key || '');
  if (!/^(pan:[A-Z]{5}[0-9]{4}[A-Z]|p:\d{1,18})$/.test(key)) fail('Choose a customer from the cash report');
  const period = await readPeriod(repo.pool, business, query);
  const rows = linkRows(await rowsIn(repo.pool, business, period.from, period.to)).filter((r) => r.person === key);
  return { ...period, key, transactions: rows.map((r) => ({ at: r.at, day: r.day, kind: r.kind, kindWords: KIND_WORDS[r.kind], ref: r.ref, name: r.name, cashIn: Number(r.cash_in).toFixed(2),
    cashOut: Number(r.cash_out).toFixed(2) })) };
}

// The monthly cash transactions worksheet (a calendar month; last month unless asked): each
// person whose cash that month was above ₹10 lakh, in one transaction or several linked ones, with every
// cash transaction of theirs, and when a reporting entity's report of the month is due (the 15th).
async function month(business, query = {}) {
  await guard(business);
  const today = await c.today(repo.pool, business);
  const text = c.given(query.month) ? String(query.month) : c.addMonths(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) fail('A month is written like 2026-09');
  const from = `${text}-01`;
  const to = c.addDays(c.addMonths(from, 1), -1);
  if (from > today) fail('That month has not begun');
  const rows = linkRows(await rowsIn(repo.pool, business, from, to));
  const settings = await settingsOf(repo.pool, business.id);
  const { list } = people(rows, []);
  const reported = list.filter((p) => c.paise(p.total) > REPORTING || c.paise(p.largest) > REPORTING);
  return { month: text, from, to, dueBy: `${c.addMonths(from, 1).slice(0, 7)}-15`, reportingEntity: settings.reporting_entity,
    people: reported.map((p) => ({ ...p, transactions: rows.filter((r) => r.person === p.key).map((r) => ({ at: r.at, day: r.day, kind: r.kind, kindWords: KIND_WORDS[r.kind],
      ref: r.ref, name: r.name, cashIn: Number(r.cash_in).toFixed(2), cashOut: Number(r.cash_out).toFixed(2) })) })) };
}

// --- Family groups ---------------------------------------------------------------------------------------

const familiesIn = async (db, business) => {
  const rows = await repo.all(db, `SELECT f.id,f.name,f.created_at,u.name AS by_name,
      COALESCE(json_agg(json_build_object('id',ct.id,'name',ct.name,'phone',ct.phone) ORDER BY ct.name) FILTER (WHERE ct.id IS NOT NULL),'[]') AS members
    FROM jewellery_cash_families f JOIN users u ON u.id=f.created_by LEFT JOIN jewellery_cash_family_members m ON m.business_id=f.business_id AND m.family_id=f.id
    LEFT JOIN business_contacts ct ON ct.business_id=m.business_id AND ct.id=m.contact_id WHERE f.business_id=$1 GROUP BY f.id,u.name ORDER BY lower(f.name)`, [business.id]);
  return { items: rows };
};

async function families(business) {
  await guard(business);
  return familiesIn(repo.pool, business);
}

const readContacts = (value, name) => (value === undefined || value === null ? [] : v.requiredArray(value, name).map((x) => id(x, 'Customer')));

// Customers into a family (each in one family: one already in another moves here).
async function addMembers(db, business, user, family, contactIds) {
  for (const contactId of contactIds) {
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
    if (!contact) fail('Customer not found', 404);
    const was = await repo.one(db, 'SELECT family_id FROM jewellery_cash_family_members WHERE business_id=$1 AND contact_id=$2 FOR UPDATE', [business.id, contact.id]);
    if (was && Number(was.family_id) === Number(family.id)) continue;
    if (was) await db.query('DELETE FROM jewellery_cash_family_members WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]);
    await db.query('INSERT INTO jewellery_cash_family_members(business_id,contact_id,family_id,added_by) VALUES($1,$2,$3,$4)', [business.id, contact.id, family.id, user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_cash.family_joined', family.id, { family: family.name, customerId: contact.id, ...(was ? { fromFamilyId: was.family_id } : {}) });
  }
}

// body: { name, contactIds?: [customers] }
async function createFamily(business, user, body) {
  await guard(business);
  const name = v.requiredString(body.name, 'Family name', 80);
  const contactIds = readContacts(body.contactIds, 'Customers');
  if (contactIds.length > MAX_FAMILY) fail(`A family group takes at most ${MAX_FAMILY} customers`);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    if (await repo.one(db, 'SELECT 1 FROM jewellery_cash_families WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, name])) fail(`A family group is called ${name} already`, 409);
    const family = await repo.one(db, 'INSERT INTO jewellery_cash_families(business_id,name,created_by) VALUES($1,$2,$3) RETURNING id,name', [business.id, name, user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_cash.family_created', family.id, { name });
    await addMembers(db, business, user, family, contactIds);
    return familiesIn(db, business);
  });
}

// body: { add?: [customers], remove?: [customers] }
async function changeFamily(business, user, familyId, body) {
  await guard(business);
  const add = readContacts(body.add, 'Customers to add');
  const remove = readContacts(body.remove, 'Customers to take out');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const family = await repo.one(db, 'SELECT id,name FROM jewellery_cash_families WHERE business_id=$1 AND id=$2', [business.id, id(familyId, 'Family group')]);
    if (!family) fail('Family group not found', 404);
    for (const contactId of remove) {
      const gone = await db.query('DELETE FROM jewellery_cash_family_members WHERE business_id=$1 AND contact_id=$2 AND family_id=$3', [business.id, contactId, family.id]);
      if (gone.rowCount) await repo.audit(db, business.id, user.id, 'jewellery_cash.family_left', family.id, { family: family.name, customerId: contactId });
    }
    await addMembers(db, business, user, family, add);
    const count = await repo.one(db, 'SELECT count(*)::int AS n FROM jewellery_cash_family_members WHERE business_id=$1 AND family_id=$2', [business.id, family.id]);
    if (count.n > MAX_FAMILY) fail(`A family group takes at most ${MAX_FAMILY} customers`);
    return familiesIn(db, business);
  });
}

// The bell (for whoever sees the cash report): cash with a customer at ₹10 lakh in the
// rolling month to today; past the shop's own levels; and, for a reporting entity, last month's
// worksheet due by the 15th.
async function bell(business, base) {
  if (!access.can(business, 'jewellery.export') || !c.seesMoney(business)) return [];
  const today = await c.today(repo.pool, business);
  const settings = await settingsOf(repo.pool, business.id);
  const levels = levelsOf(settings);
  const { list } = people(await rowsIn(repo.pool, business, c.addDays(c.addMonths(today, -1), 1), today), levels);
  const items = [];
  const reporting = list.filter((p) => p.level === 'reporting');
  if (reporting.length) {
    items.push({ id: `jewellery-cash:${today}`, severity: 'critical', category: 'Cash report', title: `Cash with ${c.plural(reporting.length, 'customer')} reached ₹10 lakh in a month`,
      detail: 'A jeweller with cash transactions of ₹10 lakh or more with a customer is a reporting entity under the PMLA', at: `${today}T00:00:00.000Z`, link: `${base}/cash-report` });
  }
  const alerted = list.filter((p) => p.level === 'alert');
  if (alerted.length) {
    const lowest = Math.min(...alerted.map((p) => c.paise(p.alertLevel)));
    items.push({ id: `jewellery-cash-watch:${today}`, severity: 'warning', category: 'Cash report', title: `${c.plural(alerted.length, 'customer')} past the shop's cash alert level`,
      detail: `Cash in and out with each came to ${c.rupees(lowest)} or more in the month to today`, at: `${today}T00:00:00.000Z`, link: `${base}/cash-report` });
  }
  if (settings.reporting_entity && Number(today.slice(8, 10)) <= 15) {
    const last = c.addMonths(`${today.slice(0, 7)}-01`, -1);
    const lastRows = await rowsIn(repo.pool, business, last, c.addDays(`${today.slice(0, 7)}-01`, -1));
    if (people(lastRows, []).list.some((p) => c.paise(p.total) > REPORTING || c.paise(p.largest) > REPORTING)) {
      items.push({ id: `jewellery-cash-month:${last.slice(0, 7)}`, severity: 'warning', category: 'Cash report', title: `The cash transactions of ${monthWords(last)} are reported by the 15th`,
        detail: 'Open the month\'s worksheet in the cash report', at: `${today.slice(0, 7)}-01T00:00:00.000Z`, link: `${base}/cash-report` });
    }
  }
  return items;
}

module.exports = { KIND_WORDS, LINK_WORDS, report, person, month, families, createFamily, changeFamily, bell, linkRows, people };
