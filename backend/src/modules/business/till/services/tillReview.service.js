const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');

// The manager's review of offline bills (Daily money › Offline bills): what
// was flagged, by kind, to look at and acknowledge; stock sold short, to
// settle from stock received since or as a count that was wrong; numbers that
// never arrived, to note why; voids; every offline bill by till and time; the
// cashiers' cash against what their offline bills took; each till series'
// numbers for GSTR-1 Table 13. And the bell: bills to review, a till with
// bills waiting for more than an hour, numbers missing.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

repo.addLists({
  'till-bills': {
    sql: `SELECT b.id,b.bill_no,b.kind,b.made_at,b.received_at,b.total,b.document_id,b.void_reason,b.void_lines,b.device_id,b.location_id,b.pin_rule,
        d.code AS till_code,d.name AS till_name,l.name AS location_name,m.name AS made_by_name,s.name AS sent_by_name,b.made_by<>b.sent_by AS sent_by_other,
        doc.document_no,COALESCE(doc.contact_name,(SELECT c.name FROM business_contacts c WHERE c.business_id=b.business_id AND c.id=b.contact_id)) AS contact_name,
        (SELECT count(*)::int FROM business_till_flags f WHERE f.business_id=b.business_id AND f.till_bill_id=b.id AND f.acknowledged_at IS NULL) AS open_flags,
        COALESCE((SELECT json_agg(f.kind ORDER BY f.id) FROM business_till_flags f WHERE f.business_id=b.business_id AND f.till_bill_id=b.id),'[]') AS flags,
        EXISTS (SELECT 1 FROM business_till_flags f WHERE f.business_id=b.business_id AND f.till_bill_id=b.id AND f.acknowledged_at IS NULL) AS to_review
      FROM business_till_bills b JOIN business_devices d ON d.business_id=b.business_id AND d.id=b.device_id
      JOIN business_locations l ON l.business_id=b.business_id AND l.id=b.location_id
      JOIN users m ON m.id=b.made_by JOIN users s ON s.id=b.sent_by
      LEFT JOIN business_documents doc ON doc.business_id=b.business_id AND doc.id=b.document_id
      WHERE b.business_id=$1`,
    search: ['bill_no', 'made_by_name', 'sent_by_name', 'contact_name', 'till_code', 'till_name'],
    date: 'made_at',
    filters: { kind: 'kind', device: 'device_id', location: 'location_id', review: 'to_review' },
    order: 'made_at DESC,id DESC',
  },
  'till-flags': {
    sql: `SELECT f.id,f.kind,f.details,f.created_at,f.acknowledged_at,f.note,a.name AS acknowledged_by_name,f.acknowledged_at IS NULL AS open,
        b.id AS till_bill_id,b.bill_no,b.made_at,b.total,b.device_id,b.location_id,d.code AS till_code,l.name AS location_name,m.name AS made_by_name,
        doc.id AS document_id,doc.document_no,doc.contact_name,
        (SELECT count(*)::int FROM business_till_shortfalls x WHERE x.business_id=f.business_id AND x.till_bill_id=b.id AND x.resolved_at IS NULL) AS shortfalls_open
      FROM business_till_flags f JOIN business_till_bills b ON b.business_id=f.business_id AND b.id=f.till_bill_id
      JOIN business_devices d ON d.business_id=b.business_id AND d.id=b.device_id
      JOIN business_locations l ON l.business_id=b.business_id AND l.id=b.location_id
      JOIN users m ON m.id=b.made_by LEFT JOIN users a ON a.id=f.acknowledged_by
      LEFT JOIN business_documents doc ON doc.business_id=b.business_id AND doc.id=b.document_id
      WHERE f.business_id=$1`,
    search: ['bill_no', 'made_by_name', 'contact_name', 'document_no', 'till_code'],
    date: 'made_at',
    filters: { kind: 'kind', open: 'open', device: 'device_id', location: 'location_id' },
    order: 'open DESC,made_at DESC,id DESC',
  },
  'till-shortfalls': {
    sql: `SELECT x.id,x.sku_id,x.quantity,x.created_at,x.resolved_at,x.resolution,x.note,r.name AS resolved_by_name,x.resolved_at IS NULL AS open,
        s.label,s.unit,x.location_id,l.name AS location_name,b.bill_no,b.made_at,doc.id AS document_id,doc.document_no,
        COALESCE((SELECT sum(k.quantity) FROM business_stock_lots k JOIN businesses z ON z.id=k.business_id WHERE k.business_id=x.business_id AND k.location_id=x.location_id
          AND k.sku_id=x.sku_id AND (k.expires_on IS NULL OR k.expires_on>=(now() AT TIME ZONE z.timezone)::date)),0) AS stock_now
      FROM business_till_shortfalls x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
      JOIN business_locations l ON l.business_id=x.business_id AND l.id=x.location_id
      JOIN business_till_bills b ON b.business_id=x.business_id AND b.id=x.till_bill_id
      JOIN business_documents doc ON doc.business_id=x.business_id AND doc.id=x.document_id
      LEFT JOIN users r ON r.id=x.resolved_by
      WHERE x.business_id=$1`,
    search: ['label', 'bill_no', 'document_no'],
    date: 'made_at',
    filters: { open: 'open', location: 'location_id' },
    order: 'open DESC,made_at DESC,id DESC',
  },
  'till-gaps': {
    sql: `SELECT g.id,g.bill_no,g.seq,g.state,g.found_at,g.reason,g.noted_at,g.arrived_at,u.name AS noted_by_name,g.device_id,d.code AS till_code,d.name AS till_name,
        d.location_id,l.name AS location_name,d.lost AS till_lost,d.retired_at IS NOT NULL AS till_retired,
        (n.fiscal_year=d.last_year AND g.seq=ANY(d.holding)) AS on_till
      FROM business_till_gaps g JOIN business_devices d ON d.business_id=g.business_id AND d.id=g.device_id
      JOIN business_number_series n ON n.business_id=g.business_id AND n.id=g.series_id
      JOIN business_locations l ON l.business_id=d.business_id AND l.id=d.location_id
      LEFT JOIN users u ON u.id=g.noted_by
      WHERE g.business_id=$1`,
    search: ['bill_no', 'till_code', 'till_name', 'reason'],
    date: 'found_at',
    filters: { state: 'state', device: 'device_id', location: 'location_id' },
    order: "(state='missing') DESC,found_at DESC,seq",
  },
});

async function list(business, kind, query) {
  await access.require(business, 'offline_till.view');
  const names = { bills: 'till-bills', flags: 'till-flags', shortfalls: 'till-shortfalls', gaps: 'till-gaps' };
  const name = names[kind];
  if (!name) fail('Unknown list', 404);
  const limit = query.limit === undefined ? 25 : v.requiredId(query.limit, 'Page size');
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('Invalid pagination');
  const filters = {};
  for (const key of repo.listFilters(name)) if (query[key] !== undefined && query[key] !== '') filters[key] = String(query[key]);
  if (business.location_scope && !filters.location) filters.location = String(business.location_scope);
  if (filters.location) access.requireLocation(business, filters.location);
  const from = query.from ? core.dateText(query.from, 'From') : null;
  const to = query.to ? core.dateText(query.to, 'To') : null;
  return repo.page(business.id, name, limit, offset, { search: typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : null,
    from, to, timezone: business.timezone, filters });
}

// The tiles of the review: what is open now, and the period's offline bills.
async function summary(business, query) {
  await access.require(business, 'offline_till.view');
  const location = query.location ? id(query.location, 'Location') : (business.location_scope || null);
  if (location) access.requireLocation(business, location);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(new Date());
  const from = query.from ? core.dateText(query.from, 'From') : today;
  const to = query.to ? core.dateText(query.to, 'To') : today;
  const open = await repo.all(repo.pool, `SELECT f.kind,count(*)::int AS n FROM business_till_flags f JOIN business_till_bills b ON b.business_id=f.business_id AND b.id=f.till_bill_id
    WHERE f.business_id=$1 AND f.acknowledged_at IS NULL AND ($2::bigint IS NULL OR b.location_id=$2) GROUP BY f.kind`, [business.id, location]);
  const counts = await repo.one(repo.pool, `SELECT
      (SELECT count(DISTINCT f.till_bill_id)::int FROM business_till_flags f JOIN business_till_bills b ON b.business_id=f.business_id AND b.id=f.till_bill_id
        WHERE f.business_id=$1 AND f.acknowledged_at IS NULL AND ($2::bigint IS NULL OR b.location_id=$2)) AS to_review,
      (SELECT count(*)::int FROM business_till_shortfalls WHERE business_id=$1 AND resolved_at IS NULL AND ($2::bigint IS NULL OR location_id=$2)) AS shortfalls,
      (SELECT count(*)::int FROM business_till_gaps g JOIN business_devices d ON d.business_id=g.business_id AND d.id=g.device_id
        WHERE g.business_id=$1 AND g.state='missing' AND ($2::bigint IS NULL OR d.location_id=$2)) AS missing,
      (SELECT count(*)::int FROM business_till_bills b JOIN businesses z ON z.id=b.business_id WHERE b.business_id=$1 AND b.kind='bill'
        AND (b.made_at AT TIME ZONE z.timezone)::date BETWEEN $3::date AND $4::date AND ($2::bigint IS NULL OR b.location_id=$2)) AS bills,
      (SELECT COALESCE(sum(b.total),0) FROM business_till_bills b JOIN businesses z ON z.id=b.business_id WHERE b.business_id=$1 AND b.kind='bill'
        AND (b.made_at AT TIME ZONE z.timezone)::date BETWEEN $3::date AND $4::date AND ($2::bigint IS NULL OR b.location_id=$2)) AS sales,
      (SELECT count(*)::int FROM business_till_bills b JOIN businesses z ON z.id=b.business_id WHERE b.business_id=$1 AND b.kind='void'
        AND (b.made_at AT TIME ZONE z.timezone)::date BETWEEN $3::date AND $4::date AND ($2::bigint IS NULL OR b.location_id=$2)) AS voids`,
  [business.id, location, from, to]);
  return { from, to, location, ...counts, byKind: Object.fromEntries(open.map((row) => [row.kind, row.n])), cash: await cash(business, { location, from, to }) };
}

// Each cashier shift of the period with offline cash in it: what its close
// expected and counted, and the cash of offline bills made inside it that
// arrived only after it was closed (the drawer held it; the close could not
// know). Expected now = expected at close + that cash.
async function cash(business, { location, from, to }) {
  const rows = await repo.all(repo.pool, `SELECT s.id,s.location_id,l.name AS location_name,u.name AS cashier_name,s.opened_at,s.closed_at,s.expected_cash,s.counted_cash,s.difference,
      COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
        JOIN business_till_bills b ON b.business_id=d.business_id AND b.document_id=d.id
        WHERE p.business_id=s.business_id AND p.method='cash' AND p.created_by=s.user_id AND d.location_id=s.location_id
          AND p.created_at>=s.opened_at AND (s.closed_at IS NULL OR p.created_at<s.closed_at)),0) AS offline_cash,
      COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
        JOIN business_till_bills b ON b.business_id=d.business_id AND b.document_id=d.id
        WHERE p.business_id=s.business_id AND p.method='cash' AND p.created_by=s.user_id AND d.location_id=s.location_id
          AND s.closed_at IS NOT NULL AND p.created_at>=s.opened_at AND p.created_at<s.closed_at AND b.received_at>s.closed_at),0) AS arrived_after_close
    FROM business_counter_shifts s JOIN users u ON u.id=s.user_id JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id
    JOIN businesses z ON z.id=s.business_id
    WHERE s.business_id=$1 AND ($2::bigint IS NULL OR s.location_id=$2) AND (s.opened_at AT TIME ZONE z.timezone)::date BETWEEN $3::date AND $4::date
    ORDER BY s.opened_at DESC`, [business.id, location, from, to]);
  const paise = (value) => Math.round(Number(value || 0) * 100);
  return rows.filter((row) => paise(row.offline_cash) > 0).map((row) => {
    const late = paise(row.arrived_after_close);
    const expectedNow = row.closed_at ? paise(row.expected_cash) + late : null;
    return { ...row, expected_now: expectedNow === null ? null : (expectedNow / 100).toFixed(2),
      difference_now: expectedNow === null ? null : ((paise(row.counted_cash) - expectedNow) / 100).toFixed(2) };
  });
}

// GSTR-1 Table 13 for the tills' own series: for each series, the numbers
// used on bills and voids made in the period, the first and last, how many,
// how many voided (cancelled) and how many never arrived (noted or not).
async function numbers(business, query) {
  await access.require(business, 'offline_till.view');
  const from = core.dateText(query.from, 'From');
  const to = core.dateText(query.to, 'To');
  if (to < from) fail('The period ends before it starts');
  const rows = await repo.all(repo.pool, `SELECT n.id,n.prefix,n.fiscal_year,d.code AS till_code,d.name AS till_name,l.name AS location_name,
      min(b.seq) AS first_seq,max(b.seq) AS last_seq,count(b.id)::int AS received,count(b.id) FILTER (WHERE b.kind='void')::int AS voided,
      (SELECT count(*)::int FROM business_till_gaps g WHERE g.business_id=n.business_id AND g.series_id=n.id AND g.state<>'arrived'
        AND g.seq BETWEEN min(b.seq) AND max(b.seq)) AS missing
    FROM business_number_series n JOIN business_devices d ON d.business_id=n.business_id AND d.id=n.device_id
    JOIN business_locations l ON l.business_id=d.business_id AND l.id=d.location_id
    JOIN businesses z ON z.id=n.business_id
    JOIN business_till_bills b ON b.business_id=n.business_id AND b.series_id=n.id AND (b.made_at AT TIME ZONE z.timezone)::date BETWEEN $2::date AND $3::date
    WHERE n.business_id=$1 AND n.device_id IS NOT NULL
    GROUP BY n.id,n.prefix,n.fiscal_year,d.code,d.name,l.name ORDER BY n.prefix`, [business.id, from, to]);
  const pad = (seq) => String(seq).padStart(5, '0');
  return { from, to, series: rows.map((row) => {
    const total = Number(row.last_seq) - Number(row.first_seq) + 1;
    return { prefix: row.prefix, fiscalYear: row.fiscal_year, tillCode: row.till_code, tillName: row.till_name, locationName: row.location_name,
      first: `${row.prefix}${pad(row.first_seq)}`, last: `${row.prefix}${pad(row.last_seq)}`, total, voided: row.voided, missing: row.missing,
      issued: total - row.voided };
  }) };
}

const readNote = (value, name, required) => {
  const text = required ? v.requiredString(value, name, 300).trim() : v.optionalString(value, name, 300)?.trim() || null;
  if (required && !text) fail(`${name} is needed`);
  return text;
};

// Looked at: a flag acknowledged, with an optional note. Stock short is
// settled on its own (each shortfall), and its flag follows.
async function acknowledge(business, user, flagId, body) {
  await access.require(business, 'offline_till.review');
  const note = readNote(body.note, 'Note', false);
  return repo.transaction(async (db) => {
    const flag = await repo.one(db, `SELECT f.*,b.location_id,b.bill_no FROM business_till_flags f JOIN business_till_bills b ON b.business_id=f.business_id AND b.id=f.till_bill_id
      WHERE f.business_id=$1 AND f.id=$2 FOR UPDATE OF f`, [business.id, id(flagId, 'Flag')]);
    if (!flag) fail('Flag not found', 404);
    access.requireLocation(business, flag.location_id);
    if (flag.acknowledged_at) fail('This was already looked at', 409);
    if (flag.kind === 'stock') {
      const left = await repo.one(db, 'SELECT count(*)::int AS n FROM business_till_shortfalls WHERE business_id=$1 AND till_bill_id=$2 AND resolved_at IS NULL', [business.id, flag.till_bill_id]);
      if (left.n) fail(`Settle the stock sold short on ${flag.bill_no} first: from stock received since, or as a count that was wrong`, 409, { reason: 'shortfalls_open' });
    }
    const row = await repo.one(db, 'UPDATE business_till_flags SET acknowledged_at=now(),acknowledged_by=$3,note=$4 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, flag.id, user.id, note]);
    await reviewed(db, business, user, flag.till_bill_id);
    await repo.audit(db, business.id, user.id, 'till_flag.acknowledged', flag.till_bill_id, { kind: flag.kind, billNo: flag.bill_no, ...(note ? { note } : {}) });
    return row;
  });
}

// A bill with every flag looked at is reviewed.
async function reviewed(db, business, user, tillBillId) {
  const left = await repo.one(db, 'SELECT count(*)::int AS n FROM business_till_flags WHERE business_id=$1 AND till_bill_id=$2 AND acknowledged_at IS NULL', [business.id, tillBillId]);
  if (!left.n) await db.query('UPDATE business_till_bills SET reviewed_at=now(),reviewed_by=$3 WHERE business_id=$1 AND id=$2 AND reviewed_at IS NULL', [business.id, tillBillId, user.id]);
}

// Stock sold short, settled: `received` takes it now from the usable stock
// there (stock received since), as the bill's own movements; `adjusted` says
// the books were wrong (the goods were there) and takes nothing.
async function resolveShortfall(business, user, shortfallId, body) {
  await access.require(business, 'offline_till.review');
  const how = v.requiredEnum(body.how, 'How it is settled', ['received', 'adjusted']);
  const note = readNote(body.note, how === 'adjusted' ? 'Why the count was wrong' : 'Note', how === 'adjusted');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const short = await repo.one(db, `SELECT x.*,s.label,b.bill_no FROM business_till_shortfalls x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
      JOIN business_till_bills b ON b.business_id=x.business_id AND b.id=x.till_bill_id WHERE x.business_id=$1 AND x.id=$2 FOR UPDATE OF x`, [business.id, id(shortfallId, 'Stock short')]);
    if (!short) fail('Stock short not found', 404);
    access.requireLocation(business, short.location_id);
    if (short.resolved_at) fail('This was already settled', 409);
    if (how === 'received') {
      await core.takeStock(db, business, { locationId: short.location_id, skuId: short.sku_id, quantity: short.quantity, documentId: short.document_id, label: short.label });
    }
    const row = await repo.one(db, 'UPDATE business_till_shortfalls SET resolved_at=now(),resolved_by=$3,resolution=$4,note=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, short.id, user.id, how, note]);
    // The stock flag of the bill is looked at once all of its shortfalls are settled.
    const left = await repo.one(db, 'SELECT count(*)::int AS n FROM business_till_shortfalls WHERE business_id=$1 AND till_bill_id=$2 AND resolved_at IS NULL', [business.id, short.till_bill_id]);
    if (!left.n) {
      await db.query(`UPDATE business_till_flags SET acknowledged_at=now(),acknowledged_by=$3,note='Stock sold short settled'
        WHERE business_id=$1 AND till_bill_id=$2 AND kind='stock' AND acknowledged_at IS NULL`, [business.id, short.till_bill_id, user.id]);
      await reviewed(db, business, user, short.till_bill_id);
    }
    await repo.audit(db, business.id, user.id, 'till_shortfall.settled', short.document_id, { billNo: short.bill_no, skuId: short.sku_id, quantity: short.quantity, how, ...(note ? { note } : {}) });
    if (how === 'received') {
      await repo.event(db, business.id, user.id, 'sale.stock_taken', 'document', short.document_id, { locationId: short.location_id, skuId: short.sku_id, quantity: short.quantity });
    }
    return row;
  });
}

// A number that never arrived, noted with why (for GSTR-1's documents issued).
async function noteGap(business, user, gapId, body) {
  await access.require(business, 'offline_till.review');
  const reason = readNote(body.reason, 'Why the number never arrived', true);
  return repo.transaction(async (db) => {
    const gap = await repo.one(db, `SELECT g.*,d.location_id FROM business_till_gaps g JOIN business_devices d ON d.business_id=g.business_id AND d.id=g.device_id
      WHERE g.business_id=$1 AND g.id=$2 FOR UPDATE OF g`, [business.id, id(gapId, 'Number')]);
    if (!gap) fail('Number not found', 404);
    access.requireLocation(business, gap.location_id);
    if (gap.state !== 'missing') fail(gap.state === 'arrived' ? 'This bill has arrived since' : 'This number was already noted', 409);
    const row = await repo.one(db, "UPDATE business_till_gaps SET state='noted',reason=$3,noted_by=$4,noted_at=now() WHERE business_id=$1 AND id=$2 RETURNING *",
      [business.id, gap.id, reason, user.id]);
    await repo.audit(db, business.id, user.id, 'till_number.noted', gap.id, { billNo: gap.bill_no, reason });
    return row;
  });
}

// The bell (businessNotifications.service.js): bills to review, a till whose
// bills have waited more than an hour, numbers that never arrived.
async function bell(business, base) {
  const nowIso = new Date().toISOString();
  const items = [];
  const scope = business.location_scope || business.member_location_id || null;
  const counts = await repo.one(repo.pool, `SELECT
      (SELECT count(DISTINCT f.till_bill_id)::int FROM business_till_flags f JOIN business_till_bills b ON b.business_id=f.business_id AND b.id=f.till_bill_id
        WHERE f.business_id=$1 AND f.acknowledged_at IS NULL AND ($2::bigint IS NULL OR b.location_id=$2)) AS to_review,
      (SELECT max(f.created_at) FROM business_till_flags f WHERE f.business_id=$1 AND f.acknowledged_at IS NULL) AS latest,
      (SELECT count(*)::int FROM business_till_gaps g JOIN business_devices d ON d.business_id=g.business_id AND d.id=g.device_id
        WHERE g.business_id=$1 AND g.state='missing' AND ($2::bigint IS NULL OR d.location_id=$2)) AS missing`, [business.id, scope]);
  if (counts.to_review > 0) {
    items.push({ id: `till-review:${counts.to_review}:${new Date(counts.latest).getTime()}`, severity: 'warning', category: 'Offline till',
      title: `${counts.to_review} offline ${counts.to_review === 1 ? 'bill' : 'bills'} to review`,
      detail: 'Prices, stock or credit that changed while a till billed offline', at: new Date(counts.latest).toISOString(), link: `${base}/offline-bills` });
  }
  if (counts.missing > 0) {
    items.push({ id: `till-missing:${counts.missing}`, severity: 'critical', category: 'Offline till',
      title: `${counts.missing} offline bill ${counts.missing === 1 ? 'number has' : 'numbers have'} not arrived`,
      detail: 'Note why for GSTR-1, or send them from the till', at: nowIso, link: `${base}/offline-bills?tab=numbers` });
  }
  const late = await repo.all(repo.pool, `SELECT id,code,name,pending_count+attention_count AS waiting,oldest_pending_at FROM business_devices
    WHERE business_id=$1 AND retired_at IS NULL AND pending_count+attention_count>0 AND oldest_pending_at < now() - interval '1 hour'
    AND ($2::bigint IS NULL OR location_id=$2) ORDER BY oldest_pending_at`, [business.id, scope]);
  for (const till of late) {
    items.push({ id: `till-waiting:${till.id}:${new Date(till.oldest_pending_at).getTime()}`, severity: 'warning', category: 'Offline till',
      title: `Till ${till.code} (${till.name}) has had bills waiting for more than an hour`,
      detail: `${till.waiting} ${Number(till.waiting) === 1 ? 'bill waits' : 'bills wait'} to be sent: connect it, or press Send now on it`,
      at: new Date(till.oldest_pending_at).toISOString(), link: `${base}/tills` });
  }
  return items;
}

module.exports = { list, summary, numbers, acknowledge, resolveShortfall, noteGap, bell, cash };
