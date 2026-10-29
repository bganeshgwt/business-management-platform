const crypto = require('node:crypto');
const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const money = require('./taxChangesMoney');
const changes = require('./taxChanges.service');

// A GST notification's list, pasted or uploaded: HSN / SAC codes, each with
// its new rate. A code of 4 or 6 digits stands for every code that starts
// with it (a chapter heading or sub-heading); one of 8 digits for itself. The
// preview shows the items each line finds, the codes that found nothing, and
// the items two lines give different rates (the list is refused until that is
// put right). Scheduled, it becomes one GST rate change per new rate, or more
// than one when a rate moves more items than one change holds (2,000), all in
// one go and named by the list they came from.
//
// The world is the one taxChanges.service.js works from, with:
//   targets(db)           the rates items may move to: [{ id, name, rate }] (active)
//   rateWhere             where a rate is added ('Settings › Tax rates')
//   documents(db, ids)    open quotations and sales orders holding these items (a shop), or []

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// The most lines a list may have, and the most items it may move in one go.
const MAX_LINES = 5000;
const MAX_ITEMS = 20000;
// What the preview lists of each line's items, and of those left out.
const SHOWN = 100;

function readDate(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail('Start date must be a valid date');
  return text;
}
const readKeeps = (value) => (value === undefined || value === null || value === '' ? 'total' : v.requiredEnum(value, 'What a price that includes GST keeps', ['total', 'net']));

// The list: [{ code, rate }]. A code is written with or without spaces and
// dots ("1905 31 00", "1905.31"); a rate with or without its "%".
function readList(value) {
  const list = v.requiredArray(value, 'The list');
  if (!list.length) fail('The list has no codes in it');
  if (list.length > MAX_LINES) fail(`A list has at most ${MAX_LINES} lines: split it in two`);
  const seen = new Map();
  const lines = [];
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`Line ${index + 1} must be a code and a rate`);
    const code = String(entry.code ?? '').replace(/[\s.]/g, '');
    if (!/^(\d{4}|\d{6}|\d{8})$/.test(code)) fail(`Line ${index + 1}: "${String(entry.code ?? '').slice(0, 20)}" is not an HSN or SAC code of 4, 6 or 8 digits`);
    const rateText = String(entry.rate ?? '').replace(/%/g, '').trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(rateText) || Number(rateText) > 100) fail(`Line ${index + 1}: "${String(entry.rate ?? '').slice(0, 20)}" is not a GST rate`);
    const rate = Number(rateText).toFixed(2);
    const before = seen.get(code);
    if (before !== undefined) {
      if (before !== rate) fail(`Code ${code} is in the list twice, at ${money.rateWords(before)} and at ${money.rateWords(rate)}: keep the one the notification gives`);
      continue;
    }
    seen.set(code, rate);
    lines.push({ code, rate });
  }
  return lines;
}

// Every item the list finds, what each becomes and which change it goes in.
async function plan(world, db, { lines, startsOn, keeps }) {
  const today = await world.today(db);
  const targets = await world.targets(db);
  const targetOf = new Map();
  for (const target of targets) if (!targetOf.has(money.basis(target.rate))) targetOf.set(money.basis(target.rate), target);
  // Switched-off items too: one switched on again later sells at the new rate.
  const rows = await world.candidates(db, { filters: { codes: lines.map((line) => line.code), inactive: true }, limit: MAX_ITEMS + 1 });
  if (rows.length > MAX_ITEMS) fail(`The list finds more than ${MAX_ITEMS.toLocaleString('en-IN')} ${world.words.items}: split it into two lists`);
  const shown = lines.map((line) => {
    const target = targetOf.get(money.basis(line.rate)) || null;
    return { ...line, target: target && { id: Number(target.id), name: target.name, rate: Number(target.rate).toFixed(2) }, found: 0, items: [],
      problem: target ? null : `No ${world.words.rate} at ${money.rateWords(line.rate)}: add it under ${world.rateWhere} first` };
  });
  const conflicts = [];
  const moving = [];
  const leftOut = [];
  let leftOutCount = 0;
  for (const row of rows) {
    const hsn = String(row.hsn_code || '');
    const mine = shown.filter((line) => hsn.startsWith(line.code));
    if (!mine.length) continue;
    for (const line of mine) {
      line.found += 1;
      if (line.items.length < SHOWN) line.items.push({ id: Number(row.id), label: row.label, code: row.code || null, hsn: row.hsn_code || null });
    }
    const rates = [...new Set(mine.map((line) => line.rate))];
    if (rates.length > 1) {
      conflicts.push({ id: Number(row.id), label: row.label, code: row.code || null, hsn: row.hsn_code || null,
        lines: mine.map((line) => ({ code: line.code, rate: line.rate })) });
      continue;
    }
    const line = mine[0];
    if (!line.target) continue;
    const item = changes.previewOf(world, row, line.target, startsOn, keeps);
    if (item.problem || item.same) {
      leftOutCount += 1;
      if (leftOut.length < SHOWN * 2) leftOut.push({ id: item.id, label: item.label, hsn: item.hsn, problem: item.problem || `At ${line.target.name} on ${money.dateWords(startsOn)} already` });
      continue;
    }
    moving.push({ ...item, targetId: line.target.id });
  }
  // One change per rate, of at most 2,000 items each.
  const groups = [];
  for (const target of shown.filter((line) => line.target).map((line) => line.target)) {
    if (groups.some((group) => group.target.id === target.id)) continue;
    const ids = moving.filter((item) => item.targetId === target.id).map((item) => item.id);
    for (let start = 0; start < ids.length; start += changes.MAX_ITEMS) groups.push({ target, ids: ids.slice(start, start + changes.MAX_ITEMS) });
  }
  return {
    startsOn, today, keeps, dateProblem: money.startProblem(startsOn, today, world.words.fromToday),
    lines: shown.map((line) => ({ ...line, more: Math.max(0, line.found - line.items.length) })),
    unmatched: shown.filter((line) => !line.found).map((line) => line.code),
    conflicts, leftOut, leftOutCount,
    moving: moving.length,
    changes: groups.map((group) => ({ target: group.target, items: group.ids.length })),
    groups,
    movingIds: moving.map((item) => item.id),
  };
}

// The list, and what it would do, nothing saved.
async function preview(world, body) {
  await world.requireEdit();
  const startsOn = readDate(body.startsOn);
  const keeps = readKeeps(body.keeps);
  const lines = readList(body.lines);
  return repo.transaction(async (db) => {
    await world.applyDue(db);
    const result = await plan(world, db, { lines, startsOn, keeps });
    const documents = result.movingIds.length ? await world.documents(db, result.movingIds) : [];
    const { groups, movingIds, ...shown } = result;
    return { ...shown, documents };
  });
}

// A key of its own for each change a list makes: the list's key and the change's place in it.
function keyFor(requestKey, index) {
  const hex = crypto.createHash('sha256').update(`${requestKey}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// body: { requestKey, startsOn, keeps?, reason, lines: [{ code, rate }] }
async function schedule(world, user, body) {
  await world.requireEdit();
  if (!UUID.test(String(body.requestKey || ''))) fail('A valid request key is required');
  const hash = sha256(body);
  const startsOn = readDate(body.startsOn);
  const keeps = readKeeps(body.keeps);
  const reason = v.requiredString(body.reason, 'Reason', 300);
  const lines = readList(body.lines);
  return repo.transaction(async (db) => {
    const businessId = await world.businessId(db, true);
    await world.lock(db);
    const old = await repo.one(db, 'SELECT id,request_hash FROM business_tax_change_imports WHERE business_id=$1 AND request_key=$2', [businessId, body.requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return made(db, world, businessId, old.id);
    }
    await world.applyDue(db);
    const result = await plan(world, db, { lines, startsOn, keeps });
    if (result.dateProblem) fail(result.dateProblem);
    const noRate = result.lines.find((line) => line.problem && line.found);
    if (noRate) fail(noRate.problem, 409, { reason: 'no_rate', code: noRate.code });
    if (result.conflicts.length) {
      const first = result.conflicts[0];
      fail(`${first.label} (${first.hsn}) is found by ${first.lines.map((l) => `${l.code} at ${money.rateWords(l.rate)}`).join(' and by ')}${result.conflicts.length > 1 ? `, and ${result.conflicts.length - 1} more ${result.conflicts.length === 2 ? world.words.item : world.words.items} the same way` : ''}: put the list right so each ${world.words.item} has one rate`,
        409, { reason: 'import_conflicts', items: result.conflicts });
    }
    if (!result.groups.length) fail(`The list moves no ${world.words.item}: none of its codes finds one that changes`, 409, { reason: 'nothing_moves' });
    const saved = await repo.one(db, `INSERT INTO business_tax_change_imports(business_id,lines,items,changes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [businessId, JSON.stringify(lines), result.moving, result.groups.length, body.requestKey, hash, user.id]);
    for (const [index, group] of result.groups.entries()) {
      const change = await repo.one(db, `INSERT INTO business_tax_changes(business_id,starts_on,${world.targetColumn},rate,keeps,reason,request_key,request_hash,created_by,import_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [businessId, startsOn, group.target.id, group.target.rate, keeps, reason,
        keyFor(body.requestKey, index), hash, user.id, saved.id]);
      await db.query(`INSERT INTO business_tax_change_items(business_id,change_id,starts_on,${world.itemColumn}) SELECT $1,$2,$3,unnest($4::bigint[])`,
        [businessId, change.id, startsOn, group.ids]);
    }
    await world.audit(db, 'tax_change.imported', saved.id, { startsOn, keeps, reason, codes: lines.length, [world.words.items]: result.moving,
      changes: result.groups.map((group) => ({ to: group.target.name, [world.words.items]: group.ids.length })) });
    return made(db, world, businessId, saved.id);
  });
}

// A list as it was scheduled: the changes it became.
async function made(db, world, businessId, importId) {
  const row = await repo.one(db, 'SELECT id,items,changes,lines,created_at FROM business_tax_change_imports WHERE business_id=$1 AND id=$2', [businessId, importId]);
  const ids = (await repo.all(db, 'SELECT id FROM business_tax_changes WHERE business_id=$1 AND import_id=$2 ORDER BY id', [businessId, importId])).map((c) => c.id);
  const list = [];
  for (const changeId of ids) {
    const change = await changes.detailIn(db, world, businessId, changeId);
    list.push({ id: change.id, starts_on: change.starts_on, rate_name: change.rate_name, rate: change.rate, items: change.items.length, state: change.state });
  }
  return { id: Number(row.id), codes: row.lines.length, items: row.items, created_at: row.created_at, changes: list };
}

module.exports = { preview, schedule, readList, MAX_LINES, MAX_ITEMS };
