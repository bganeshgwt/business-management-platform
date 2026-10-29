const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const c = require('./garageCommon');
const jobs = require('./garageJobCards.service');

// The work on a job card (module "garage", garages): a mechanic's notes, the
// road test, parts issued to a mechanic and brought back, and the vehicle
// leaving on its gate pass.
//
//   note        a mechanic's (or the desk's) note in the job card's history.
//   road test   who drove it, how far, whether it passed, and remarks. A shop
//               that asks for one (Settings › Garage settings) marks a job
//               ready only after a passed road test since it last went back
//               to work.
//   parts       with "Issue parts to mechanics" on, the store issues each part
//               line's parts to a mechanic: they leave stock at once, by a
//               core stock adjustment, held for the job (batches oldest expiry
//               first, or the ones named). Parts not used are brought back the
//               same way. The bill takes the parts issued and takes nothing out
//               of stock again (garageBilling.service.js); a part line not fully
//               issued is not billed until it is. Serial-numbered parts leave
//               stock on the bill, by their numbers.
//   old parts   what became of each part line's old part (salvage): handed
//               back to the customer, kept for the insurer's surveyor, or sold
//               as scrap; while the job card is open.
//   gate pass   made when the job is billed and the vehicle handed over; the
//               vehicle leaving is recorded once.
// Quantities are integer thousandths.

const { fail, id } = c;
const milli = (value) => Math.round(Number(value) * 1000);
const qty = (m) => (m / 1000).toFixed(3);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const derivedKey = (base, n) => {
  const h = crypto.createHash('sha256').update(`${base}:part:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-9${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// --- Notes ---------------------------------------------------------------------------------------

// body: { note }
async function note(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  const text = c.optionalText(body.note, 'Note', 500);
  if (!text) fail('Write the note');
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    await jobs.history(db, business, user, job, job.status, job.status, text);
    await db.query('UPDATE garage_job_cards SET updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, job.id, user.id]);
    await repo.audit(db, business.id, user.id, 'job_card.note_added', job.id, { jobNo: job.job_no });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// --- The road test --------------------------------------------------------------------------------

// Whether the job card has a passed road test since it last went back to work.
async function roadTested(db, business, job) {
  const row = await repo.one(db, `SELECT 1 FROM garage_road_tests t WHERE t.business_id=$1 AND t.job_card_id=$2 AND t.passed
    AND t.created_at > COALESCE((SELECT max(e.created_at) FROM garage_job_card_events e WHERE e.business_id=$1 AND e.job_card_id=$2 AND e.from_status='ready'
      AND e.to_status IN ('in_progress','waiting_parts','estimate_sent')),'-infinity')`, [business.id, job.id]);
  return Boolean(row);
}

// body: { testedBy? (a member who works on job cards; the person themselves), km, passed, remarks? }
async function roadTest(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  const km = String(body.km ?? '').trim();
  if (!/^\d{1,3}(\.\d)?$/.test(km) || Number(km) <= 0 || Number(km) > 500) fail('The road test is 0.1 to 500 km');
  const passed = v.requiredBoolean(body.passed, 'Passed');
  const remarks = c.optionalText(body.remarks, 'Remarks', 300);
  if (!passed && !remarks) fail('Say what the road test found');
  const testedBy = c.given(body.testedBy) ? id(body.testedBy, 'Who drove') : Number(user.id);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    if (!['received', 'approved', 'in_progress', 'waiting_parts', 'ready'].includes(job.status)) {
      fail(`Job card ${job.job_no} is ${c.STATUS_WORDS[job.status]}: the road test comes with the work`, 409);
    }
    const driver = (await c.mechanics(db, business)).find((m) => Number(m.id) === Number(testedBy));
    if (!driver) fail('Who drove is a member whose role works on job cards', 404);
    await db.query('INSERT INTO garage_road_tests(business_id,job_card_id,tested_by,distance_km,passed,remarks,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [business.id, job.id, driver.id, km, passed, remarks, user.id]);
    await jobs.history(db, business, user, job, job.status, job.status, [`Road test by ${driver.name}, ${Number(km)} km: ${passed ? 'passed' : 'not passed'}`, remarks].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'job_card.road_tested', job.id, { jobNo: job.job_no, testedBy: driver.name, km: Number(km), passed, ...(remarks ? { remarks } : {}) });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// --- Parts issued to the job -------------------------------------------------------------------------

// Each part line's parts held now (issued less brought back), by stock lot.
async function heldOf(db, business, jobId) {
  return repo.all(db, `SELECT i.line_id,i.lot_id,i.lot_code,
      sum(CASE WHEN i.kind='issue' THEN i.quantity ELSE -i.quantity END) AS held,
      sum(CASE WHEN i.kind='issue' THEN i.quantity ELSE 0 END) AS issued,
      sum(CASE WHEN i.kind='issue' THEN i.quantity * i.unit_cost ELSE 0 END) AS cost
    FROM garage_part_issues i WHERE i.business_id=$1 AND i.job_card_id=$2 GROUP BY i.line_id,i.lot_id,i.lot_code ORDER BY min(i.id)`, [business.id, jobId]);
}
// Held quantity per line (thousandths).
async function heldByLine(db, business, jobId) {
  const map = new Map();
  for (const row of await heldOf(db, business, jobId)) map.set(Number(row.line_id), (map.get(Number(row.line_id)) || 0) + milli(row.held));
  return map;
}
// What the bill takes of a line from its parts held: [{ lotCode, quantityMilli, unitCost }] (cost: the
// average of what was issued from that lot).
async function heldPicks(db, business, jobId) {
  const picks = new Map();
  for (const row of await heldOf(db, business, jobId)) {
    const held = milli(row.held);
    if (held <= 0) continue;
    const unitCost = Number(row.issued) > 0 ? Number(row.cost) / Number(row.issued) : 0;
    const list = picks.get(Number(row.line_id)) || [];
    list.push({ lotCode: row.lot_code, quantityMilli: held, unitCost });
    picks.set(Number(row.line_id), list);
  }
  return picks;
}

async function issueSetting(db, business) {
  const row = await repo.one(db, 'SELECT issue_parts FROM garage_settings WHERE business_id=$1', [business.id]);
  return Boolean(row?.issue_parts);
}

// body: { requestKey, mechanicId, lines: [{ lineId, quantity, lotCode? }], note? }
async function issue(business, user, jobId, body) {
  c.requireGarage(business);
  await access.requireAny(business, ['garage.view', 'garage.edit']);
  await access.require(business, 'inventory.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, jobId: String(jobId) });
  const mechanicId = id(body.mechanicId, 'Mechanic');
  const asked = v.requiredArray(body.lines, 'Parts').map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each part must be an object');
    return { lineId: id(raw.lineId, 'Line'), quantity: core.decimal(raw.quantity, 'Quantity', 3, 0.001, 100000), lotCode: c.optionalText(raw.lotCode, 'Batch', 100) };
  });
  if (!asked.length) fail('Choose the parts to issue');
  if (asked.length > 50) fail('Issue up to 50 parts at a time');
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    const done = await repo.one(db, 'SELECT job_card_id,request_hash FROM garage_part_issues WHERE business_id=$1 AND request_key=$2 LIMIT 1', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.job_card_id) !== Number(job.id)) fail('This request key was already used for different data', 409);
      return jobs.shape(business, await jobs.load(db, business, job.id));
    }
    jobs.requireOpen(job);
    if (!(await issueSetting(db, business))) fail('This garage takes parts out of stock when the job is billed. To issue them to mechanics, switch it on in Settings › Garage settings.', 409);
    if (job.status === 'estimate_sent') fail(`Job card ${job.job_no} waits for the owner's approval: parts are issued once the work goes on`, 409);
    const mechanic = (await c.mechanics(db, business)).find((m) => Number(m.id) === mechanicId);
    if (!mechanic) fail('Parts are issued to a member whose role works on job cards', 404);
    const lines = await repo.all(db, `SELECT x.*,s.tracking FROM garage_job_card_lines x JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
      WHERE x.business_id=$1 AND x.job_card_id=$2`, [business.id, job.id]);
    const held = await heldByLine(db, business, job.id);
    const words = [];
    let n = 0;
    for (const ask of asked) {
      const line = lines.find((l) => Number(l.id) === ask.lineId);
      if (!line) fail('That line is not on this job card', 404);
      if (line.kind !== 'part') fail(`${line.label} is ${line.kind === 'labour' ? 'labour' : 'outside work'}: only parts are issued`);
      if (line.tracking === 'serial') fail(`${line.label} is serial-numbered: it leaves stock on the bill, by its number`);
      if (line.tracking === 'none') fail(`${line.label} is not kept in stock`);
      const left = milli(line.quantity) - (held.get(Number(line.id)) || 0);
      if (milli(ask.quantity) > left) fail(`${line.label}: ${qty(Math.max(0, left)).replace(/\.?0+$/, '') || '0'} ${line.unit} is left to issue on this job card`, 409);
      // The stock it comes from: the batch named, or the oldest expiry first.
      const lots = await repo.all(db, `SELECT l.id FROM business_stock_lots l WHERE l.business_id=$1 AND l.sku_id=$2 AND l.location_id=$3 AND l.quantity>0
        AND (l.expires_on IS NULL OR l.expires_on >= (now() AT TIME ZONE $4)::date) AND ($5::text IS NULL OR l.lot_code=$5) ORDER BY l.expires_on NULLS LAST,l.id`,
      [business.id, line.sku_id, job.location_id, business.timezone || 'Asia/Kolkata', line.tracking === 'batch' ? ask.lotCode : null]);
      let want = milli(ask.quantity);
      for (const found of lots) {
        if (want <= 0) break;
        const lot = await returns.lockLot(db, business.id, found.id);
        const take = Math.min(want, milli(lot.quantity));
        if (take <= 0) continue;
        n += 1;
        const reason = `Issued for job card ${job.job_no} to ${mechanic.name}`.slice(0, 300);
        const adjustment = await returns.applyAdjustment(db, business, user, lot, -take / 1000, reason, derivedKey(requestKey, n));
        await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id, { lotId: lot.id, skuId: lot.sku_id, locationId: lot.location_id, quantity: -take / 1000, reason });
        await db.query(`INSERT INTO garage_part_issues(business_id,job_card_id,line_id,sku_id,lot_id,lot_code,kind,quantity,unit_cost,mechanic_id,adjustment_id,request_key,request_hash,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'issue',$7,$8,$9,$10,$11,$12,$13)`, [business.id, job.id, line.id, line.sku_id, lot.id, lot.lot_code, qty(take), lot.unit_cost, mechanic.id, adjustment.id,
          requestKey, hash, user.id]);
        want -= take;
      }
      if (want > 0) fail(`Only ${qty(milli(ask.quantity) - want).replace(/\.?0+$/, '') || '0'} ${line.unit} of ${line.label}${ask.lotCode ? ` (batch ${ask.lotCode})` : ''} is in usable stock here`, 409);
      held.set(Number(line.id), (held.get(Number(line.id)) || 0) + milli(ask.quantity));
      words.push(`${line.label} × ${Number(ask.quantity)}`);
    }
    await jobs.history(db, business, user, job, job.status, job.status, [`Parts issued to ${mechanic.name}: ${c.listWords(words)}`, note].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'job_card.parts_issued', job.id, { jobNo: job.job_no, mechanic: mechanic.name, parts: words });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// Parts not used, back into stock. body: { requestKey, lines: [{ lineId, quantity }], note? }
async function bringBack(business, user, jobId, body) {
  c.requireGarage(business);
  await access.requireAny(business, ['garage.view', 'garage.edit']);
  await access.require(business, 'inventory.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, jobId: String(jobId), back: true });
  const asked = v.requiredArray(body.lines, 'Parts').map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each part must be an object');
    return { lineId: id(raw.lineId, 'Line'), quantity: core.decimal(raw.quantity, 'Quantity', 3, 0.001, 100000) };
  });
  if (!asked.length) fail('Choose the parts brought back');
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    const done = await repo.one(db, 'SELECT job_card_id,request_hash FROM garage_part_issues WHERE business_id=$1 AND request_key=$2 LIMIT 1', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.job_card_id) !== Number(job.id)) fail('This request key was already used for different data', 409);
      return jobs.shape(business, await jobs.load(db, business, job.id));
    }
    jobs.requireOpen(job);
    const rows = await heldOf(db, business, job.id);
    const lines = await repo.all(db, 'SELECT id,label,unit FROM garage_job_card_lines WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]);
    const words = [];
    let n = 0;
    for (const ask of asked) {
      const line = lines.find((l) => Number(l.id) === ask.lineId);
      if (!line) fail('That line is not on this job card', 404);
      // The stock issued last comes back first.
      const lots = rows.filter((r) => Number(r.line_id) === ask.lineId && milli(r.held) > 0).reverse();
      const held = lots.reduce((sum, r) => sum + milli(r.held), 0);
      if (milli(ask.quantity) > held) fail(`${line.label}: ${qty(held).replace(/\.?0+$/, '') || '0'} ${line.unit} is held for this job card`, 409);
      let want = milli(ask.quantity);
      for (const row of lots) {
        if (want <= 0) break;
        const take = Math.min(want, milli(row.held));
        const lot = await returns.lockLot(db, business.id, row.lot_id);
        n += 1;
        const reason = `Brought back unused from job card ${job.job_no}`;
        const adjustment = await returns.applyAdjustment(db, business, user, lot, take / 1000, reason, derivedKey(requestKey, `back:${n}`));
        await repo.event(db, business.id, user.id, 'stock.adjusted', 'stock_adjustment', adjustment.id, { lotId: lot.id, skuId: lot.sku_id, locationId: lot.location_id, quantity: take / 1000, reason });
        await db.query(`INSERT INTO garage_part_issues(business_id,job_card_id,line_id,sku_id,lot_id,lot_code,kind,quantity,unit_cost,adjustment_id,request_key,request_hash,created_by)
          SELECT $1,$2,$3,sku_id,$4,$5,'return',$6,$7,$8,$9,$10,$11 FROM garage_job_card_lines WHERE business_id=$1 AND id=$3`,
        [business.id, job.id, line.id, lot.id, lot.lot_code, qty(take), lot.unit_cost, adjustment.id, requestKey, hash, user.id]);
        row.held = qty(milli(row.held) - take);
        want -= take;
      }
      words.push(`${line.label} × ${Number(ask.quantity)}`);
    }
    await jobs.history(db, business, user, job, job.status, job.status, [`Parts brought back unused: ${c.listWords(words)}`, note].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'job_card.parts_returned', job.id, { jobNo: job.job_no, parts: words });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// --- Old parts (salvage) -------------------------------------------------------------------------------

const OLD_PART_WORDS = { returned: 'handed back to the customer', surveyor: 'kept for the surveyor', scrap: 'sold as scrap' };

// What became of each part line's old part. body: { lines: [{ lineId, oldPart: returned | surveyor | scrap | null }] }
async function oldParts(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  const marks = v.requiredArray(body.lines, 'Lines').map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each line must be an object');
    return { lineId: id(raw.lineId, 'Line'), oldPart: v.optionalEnum(c.given(raw.oldPart) ? raw.oldPart : null, 'Old part', Object.keys(OLD_PART_WORDS), null) };
  });
  if (!marks.length || marks.length > 100) fail('Give the old part of 1 to 100 lines');
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    const lines = await repo.all(db, 'SELECT id,kind,label,old_part FROM garage_job_card_lines WHERE business_id=$1 AND job_card_id=$2 FOR UPDATE', [business.id, job.id]);
    const words = [];
    for (const mark of marks) {
      const line = lines.find((l) => Number(l.id) === mark.lineId);
      if (!line) fail('That line is not on this job card', 404);
      if (line.kind !== 'part') fail(`${line.label} is not a part: only a part has an old part`);
      if ((line.old_part || null) === mark.oldPart) continue;
      await db.query('UPDATE garage_job_card_lines SET old_part=$3 WHERE business_id=$1 AND id=$2', [business.id, line.id, mark.oldPart]);
      words.push(`${line.label}: ${mark.oldPart ? OLD_PART_WORDS[mark.oldPart] : 'not recorded'}`);
    }
    if (words.length) {
      await jobs.history(db, business, user, job, job.status, job.status, `Old parts: ${words.join('; ')}`);
      await repo.audit(db, business.id, user.id, 'job_card.old_parts_recorded', job.id, { jobNo: job.job_no, lines: marks });
    }
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// --- The gate pass ------------------------------------------------------------------------------------

// The vehicle leaving. body: { note? } (who drove it out)
async function vehicleLeft(business, user, jobId, body) {
  c.requireGarage(business);
  await access.requireAny(business, ['garage.view', 'garage.edit']);
  const text = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    const pass = await repo.one(db, 'SELECT * FROM garage_gate_passes WHERE business_id=$1 AND job_card_id=$2 FOR UPDATE', [business.id, job.id]);
    if (!pass) fail(`Job card ${job.job_no} has no gate pass: it is made when the job is billed`, 409);
    if (pass.left_at) return jobs.shape(business, await jobs.load(db, business, job.id));
    await db.query('UPDATE garage_gate_passes SET left_at=now(),left_recorded_by=$3,left_note=$4 WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id, user.id, text]);
    await repo.audit(db, business.id, user.id, 'job_card.vehicle_left', job.id, { jobNo: job.job_no, registrationNo: job.registration_no, ...(text ? { note: text } : {}) });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

module.exports = { note, roadTest, roadTested, heldOf, heldByLine, heldPicks, issueSetting, issue, bringBack, oldParts, vehicleLeft };
