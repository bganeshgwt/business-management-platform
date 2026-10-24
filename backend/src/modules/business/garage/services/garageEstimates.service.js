const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const pricing = require('../../core/services/businessPricing');
const c = require('./garageCommon');
const money = require('./garageMoney');
const jobs = require('./garageJobCards.service');

// The estimate of a job card (module "garage", garages): its lines and every
// version of them.
//
//   a line     a part (an item kept in stock), labour (a service item; SAC
//              998714 for repair work) or outside work (a service item, with
//              the workshop that did it and its bill number), its quantity in
//              the item's own unit, its rate (the customer's price for the item
//              as a sale would take it, unless another is typed: a part below
//              its price is a discount, for those who may give one; labour and
//              outside work are charged as agreed), and who pays it (the
//              customer, or the insurer on a job card with a claim). Never above
//              the item's MRP.
//   a version  each save that changes the lines: the lines and totals as they
//              were, kept for good. The desk writes and revises the estimate; a
//              mechanic adds the parts they used. A revision that comes to more
//              than the owner approved goes back to the owner for approval.
//   the work   a mechanic ticks each line done (the work done, the part fitted).
//   the claim  the insurer (a customer), cashless or reimbursement, the policy
//              and claim numbers, the surveyor, the amount the insurer approved,
//              the deductible and the depreciation. Taking the claim off makes
//              every line the customer's.
// Money is integer paise; quantities integer thousandths.

const { fail, id } = c;
const MAX_LINES = 100;
const MAX_PARTS = 20;

// --- Reading a request ---------------------------------------------------------------------

function readLine(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each line must be an object');
  const n = `Line ${index + 1}`;
  const kind = v.requiredEnum(raw.kind, `${n}: kind`, c.LINE_KINDS);
  const quantity = raw.quantity === undefined || raw.quantity === null || raw.quantity === '' ? '1' : String(raw.quantity).trim();
  if (kind !== 'sublet' && (c.given(raw.vendorName) || c.given(raw.vendorBillNo))) fail(`${n}: a workshop's name and bill go with outside work`);
  return {
    lineId: c.given(raw.lineId) ? id(raw.lineId, n) : null, kind, skuId: id(raw.skuId, `${n}: item`),
    quantity: core.decimal(quantity, `${n}: quantity`, 3, 0.001, 100000), quantityText: quantity,
    unitPrice: c.given(raw.unitPrice) ? core.decimal(String(raw.unitPrice).trim(), `${n}: rate`, 2, 0, 10000000) : null,
    payer: v.optionalEnum(raw.payer, `${n}: who pays`, c.PAYERS, 'customer'),
    description: c.optionalText(raw.description, `${n}: description`, 200),
    vendorName: kind === 'sublet' ? v.requiredString(typeof raw.vendorName === 'string' ? raw.vendorName : '', `${n}: the workshop that did it`, 150) : null,
    vendorBillNo: kind === 'sublet' ? c.optionalText(raw.vendorBillNo, `${n}: the workshop's bill number`, 60) : null,
  };
}
function readLines(value) {
  const list = v.requiredArray(value, 'Lines');
  if (!list.length) fail('Put at least one part, labour or outside work on the estimate');
  if (list.length > MAX_LINES) fail(`An estimate has up to ${MAX_LINES} lines`);
  const lines = list.map(readLine);
  const ids = lines.filter((l) => l.lineId).map((l) => l.lineId);
  if (new Set(ids).size !== ids.length) fail('Each line of the estimate appears once');
  return lines;
}
// Parts a mechanic used: [{ skuId, quantity, description? }].
function readParts(value) {
  const list = v.requiredArray(value, 'Parts used');
  if (!list.length) fail('Name the part you used');
  if (list.length > MAX_PARTS) fail(`Add up to ${MAX_PARTS} parts at a time`);
  return list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each part must be an object');
    return readLine({ kind: 'part', skuId: raw.skuId, quantity: raw.quantity, description: raw.description }, index);
  });
}

// --- Pricing ---------------------------------------------------------------------------------

// The job card was priced in the business's price terms (GST included or
// not); a change of those terms needs a fresh job card.
async function checkTerms(db, business, job) {
  const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
  if ((settings?.tax_mode || 'exclusive') !== job.tax_mode) {
    fail(`Job card ${job.job_no} was priced ${job.tax_mode === 'inclusive' ? 'including' : 'before'} GST, and the business now prices ${job.tax_mode === 'inclusive' ? 'before' : 'including'} GST. Cancel it and open it again to price it afresh.`, 409);
  }
  return settings;
}

// Each line priced as charged, in the job card's price terms. `current`: the
// job card's lines now; a kept line whose rate is unchanged is not checked
// again for a discount or the MRP (billing checks the MRP of the day).
async function priceLines(db, business, job, inputs, { current = [], canDiscount = false, hasClaim = false }) {
  const priced = [];
  for (const [index, input] of inputs.entries()) {
    const n = `Line ${index + 1}`;
    const sku = await repo.one(db, `SELECT s.*,p.kind AS product_kind,p.active AS product_active,u.decimals AS unit_decimals,u.name AS unit_name FROM catalog_skus s
      JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      WHERE s.business_id=$1 AND s.id=$2`, [business.id, input.skuId]);
    if (!sku) fail(`${n}: item not found`, 404);
    const kept = input.lineId ? current.find((l) => Number(l.id) === Number(input.lineId)) : null;
    if (input.lineId && !kept) fail(`${n} is not on this job card`, 404);
    const same = kept && Number(kept.sku_id) === Number(sku.id) && input.unitPrice !== null && money.paise(input.unitPrice) === money.paise(kept.unit_price);
    if (!sku.active || !sku.product_active) fail(`${sku.label} is switched off in the catalogue: switch it on again, or take it off the estimate`, 409);
    if (sku.is_kit) fail(`${sku.label} is a kit: put its parts on the job card instead`);
    if (sku.internal_use) fail(`${sku.label} is kept for use in services only and is not billed. Untick "For use in services only" on the item to bill it.`, 409);
    if (input.kind === 'part' && sku.product_kind !== 'goods') fail(`${sku.label} is a service: a part is an item kept in stock`);
    if (input.kind !== 'part' && sku.product_kind !== 'service') fail(`${sku.label} is kept in stock: labour and outside work are service items`);
    core.requiredDecimals(input.quantityText, { decimals: sku.unit_decimals, name: sku.unit_name }, `Quantity of ${sku.label}`);
    if (input.payer === 'insurer' && !hasClaim) fail(`${sku.label}: the insurer pays a line only on a job card with an insurance claim. Record the claim first.`);
    // The customer's price for the item, as a sale would take it (their price
    // list, the branch's price, or the item's price).
    const listed = await pricing.salePrice(db, business, sku, job.contact_id, input.quantity, null, { locationId: job.location_id });
    const listPrice = Number(listed.stockPrice);
    if (input.kind === 'sublet' && (input.unitPrice === null || input.unitPrice <= 0)) fail(`Give the charge for the outside work (${sku.label})`);
    const price = input.unitPrice === null ? listPrice : input.unitPrice;
    if (!same) {
      if (input.kind === 'part' && money.paise(price) < money.paise(listPrice) && !canDiscount) {
        fail(`${sku.label} is ${listPrice.toFixed(2)}: a lower price is a discount, which your role does not give`, 403);
      }
      if (input.kind === 'part') core.checkMrp(sku.label, price, Number(sku.tax_rate), job.tax_mode, sku.mrp);
    }
    const f = money.lineFigures(price, input.quantity, Number(sku.tax_rate), job.tax_mode);
    priced.push({ ...input, sku, kept, label: sku.label, unit: sku.unit, unitPrice: price, amount: f.amount, net: f.net, tax: f.tax, rate: Number(sku.tax_rate),
      priceRuleId: input.unitPrice === null ? listed.rule?.id || null : null, hsn: sku.hsn_code || null, mrp: sku.mrp ?? null });
  }
  return priced;
}

const snapshot = (p, lineId) => ({ lineId: Number(lineId), kind: p.kind, payer: p.payer, skuId: Number(p.sku.id), label: p.label, unit: p.unit, quantity: Number(p.quantity).toFixed(3),
  unitPrice: Number(p.unitPrice).toFixed(2), amount: money.rupees(p.amount), net: money.rupees(p.net), tax: money.rupees(p.tax), taxRate: p.rate.toFixed(2),
  description: p.description, vendorName: p.vendorName, vendorBillNo: p.vendorBillNo });
// Whether a kept line is asked as it is.
const unchanged = (p) => p.kept && p.kind === p.kept.kind && p.payer === p.kept.payer && Number(p.sku.id) === Number(p.kept.sku_id)
  && Math.round(Number(p.quantity) * 1000) === Math.round(Number(p.kept.quantity) * 1000) && money.paise(p.unitPrice) === money.paise(p.kept.unit_price)
  && (p.description || null) === (p.kept.description || null) && (p.vendorName || null) === (p.kept.vendor_name || null) && (p.vendorBillNo || null) === (p.kept.vendor_bill_no || null)
  && p.net === money.paise(p.kept.net) && p.tax === money.paise(p.kept.tax);

// Writes the lines as priced and, when anything changed, a new version. A
// version that comes to more than the owner last approved sends the job card
// back to them. Returns whether anything changed.
async function applyVersion(db, business, user, job, current, priced, { source, note, requestKey, hash, rounding }) {
  const removed = current.filter((l) => !priced.some((p) => p.kept && Number(p.kept.id) === Number(l.id)));
  if (!removed.length && priced.every(unchanged) && priced.length === current.length) return false;
  for (const line of removed) await db.query('DELETE FROM garage_job_card_lines WHERE business_id=$1 AND id=$2', [business.id, line.id]);
  const ids = [];
  for (const p of priced) {
    const values = [p.kind, p.payer, p.sku.id, p.label, p.unit, Number(p.quantity).toFixed(3), Number(p.unitPrice).toFixed(2), money.rupees(p.amount), p.rate.toFixed(2),
      money.rupees(p.net), money.rupees(p.tax), p.priceRuleId, p.hsn, p.mrp, p.description, p.vendorName, p.vendorBillNo];
    if (p.kept) {
      // New work (another item, or another quantity) is not done yet.
      const sameWork = Number(p.sku.id) === Number(p.kept.sku_id) && Math.round(Number(p.quantity) * 1000) === Math.round(Number(p.kept.quantity) * 1000);
      await db.query(`UPDATE garage_job_card_lines SET kind=$3,payer=$4,sku_id=$5,label=$6,unit=$7,quantity=$8,unit_price=$9,amount=$10,tax_rate=$11,net=$12,tax=$13,
          price_rule_id=$14,hsn_code=$15,mrp=$16,description=$17,vendor_name=$18,vendor_bill_no=$19,
          done=CASE WHEN $20 THEN done ELSE false END,done_by=CASE WHEN $20 THEN done_by END,done_at=CASE WHEN $20 THEN done_at END
        WHERE business_id=$1 AND id=$2`, [business.id, p.kept.id, ...values, sameWork]);
      ids.push(p.kept.id);
    } else {
      const row = await repo.one(db, `INSERT INTO garage_job_card_lines(business_id,job_card_id,kind,payer,sku_id,label,unit,quantity,unit_price,amount,tax_rate,net,tax,
          price_rule_id,hsn_code,mrp,description,vendor_name,vendor_bill_no,added_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`, [business.id, job.id, ...values, user.id]);
      ids.push(row.id);
    }
  }
  const totals = money.figures(priced, rounding);
  const insurerLines = priced.filter((p) => p.payer === 'insurer').reduce((sum, p) => sum + p.net + p.tax, 0);
  const version = Number(job.estimate_version) + 1;
  await db.query(`INSERT INTO garage_estimate_versions(business_id,job_card_id,version,subtotal,tax,round_off,total,insurer_lines,lines,source,note,request_key,request_hash,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [business.id, job.id, version, money.rupees(totals.subtotal), money.rupees(totals.tax), money.rupees(totals.roundOff),
    money.rupees(totals.total), money.rupees(insurerLines), JSON.stringify(priced.map((p, i) => snapshot(p, ids[i]))), source, note ? String(note).slice(0, 300) : null, requestKey, hash, user.id]);
  // More than the owner approved: back to them.
  const approval = await repo.one(db, 'SELECT amount FROM garage_estimate_approvals WHERE business_id=$1 AND job_card_id=$2 ORDER BY id DESC LIMIT 1', [business.id, job.id]);
  const above = approval && totals.total > money.paise(approval.amount);
  const status = above && ['approved', 'in_progress', 'waiting_parts', 'ready'].includes(job.status) ? 'estimate_sent' : job.status;
  await db.query(`UPDATE garage_job_cards SET estimate_version=$3,subtotal=$4,tax=$5,round_off=$6,total=$7,status=$8,updated_by=$9,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, job.id, version, money.rupees(totals.subtotal), money.rupees(totals.tax), money.rupees(totals.roundOff), money.rupees(totals.total), status, user.id]);
  // The history names no amounts: a mechanic reads it too.
  const words = source === 'parts' ? `Estimate version ${version}: parts used` : source === 'claim' ? `Estimate version ${version}: the claim taken off` : `Estimate version ${version}`;
  await jobs.history(db, business, user, job, job.status, status, [words, note, status !== job.status ? 'more than the owner approved: ask the owner again' : null].filter(Boolean).join(' · '));
  await repo.audit(db, business.id, user.id, 'job_card.estimate_revised', job.id, { jobNo: job.job_no, version, source, totalBefore: job.total, totalAfter: money.rupees(totals.total),
    lines: priced.length, ...(status !== job.status ? { backToOwner: true } : {}) });
  await repo.event(db, business.id, user.id, 'job_card.estimate_revised', 'job_card', job.id, { jobNo: job.job_no, version, source, total: money.rupees(totals.total),
    insurerLines: money.rupees(insurerLines), ...(status !== job.status ? { from: job.status, to: status } : {}) });
  return true;
}

const currentLines = (db, business, job) => repo.all(db, 'SELECT * FROM garage_job_card_lines WHERE business_id=$1 AND job_card_id=$2 ORDER BY id FOR UPDATE', [business.id, job.id]);
const hasClaim = async (db, business, job) => Boolean(await repo.one(db, 'SELECT 1 FROM garage_claims WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]));
// A kept line as an input, as it stands.
const asInput = (l, payer = l.payer) => ({ lineId: Number(l.id), kind: l.kind, skuId: Number(l.sku_id), quantity: Number(l.quantity), quantityText: String(Number(l.quantity)),
  unitPrice: Number(l.unit_price), payer, description: l.description, vendorName: l.vendor_name, vendorBillNo: l.vendor_bill_no });

// --- The estimate ------------------------------------------------------------------------------

// The figures for lines being typed (the estimate dialog), nothing saved.
// body: { lines: [...] }
async function preview(business, user, jobId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  await access.require(business, 'sales.create');
  const inputs = readLines(body.lines);
  return repo.transaction(async (db) => {
    const job = await repo.one(db, 'SELECT * FROM garage_job_cards WHERE business_id=$1 AND id=$2', [business.id, id(jobId, 'Job card')]);
    if (!job) fail('Job card not found', 404);
    access.requireLocation(business, job.location_id);
    jobs.requireOpen(job);
    const settings = await checkTerms(db, business, job);
    const current = await repo.all(db, 'SELECT * FROM garage_job_card_lines WHERE business_id=$1 AND job_card_id=$2 ORDER BY id', [business.id, job.id]);
    const priced = await priceLines(db, business, job, inputs, { current, canDiscount: access.can(business, 'sales.discount'), hasClaim: await hasClaim(db, business, job) });
    const totals = money.figures(priced, settings?.rounding);
    return { taxMode: job.tax_mode, ...money.figuresText(totals),
      insurer_lines: money.rupees(priced.filter((p) => p.payer === 'insurer').reduce((sum, p) => sum + p.net + p.tax, 0)),
      lines: priced.map((p) => ({ lineId: p.lineId, kind: p.kind, skuId: Number(p.sku.id), label: p.label, unit: p.unit, quantity: Number(p.quantity).toFixed(3),
        unitPrice: Number(p.unitPrice).toFixed(2), amount: money.rupees(p.amount), net: money.rupees(p.net), tax: money.rupees(p.tax), taxRate: p.rate.toFixed(2), payer: p.payer })) };
  });
}

// body: { requestKey, lines: [{ lineId?, kind, skuId, quantity, unitPrice?, payer?, description?, vendorName?, vendorBillNo? }], note? }
// The lines as they are to be: a line left out is taken off.
async function save(business, user, jobId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = jobs.hashOf({ ...body, jobId: String(jobId) });
  const inputs = readLines(body.lines);
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    const done = await repo.one(db, 'SELECT job_card_id,request_hash FROM garage_estimate_versions WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.job_card_id) !== Number(job.id)) fail('This request key was already used for different data', 409);
      return jobs.shape(business, await jobs.load(db, business, job.id));
    }
    jobs.requireOpen(job);
    const settings = await checkTerms(db, business, job);
    const current = await currentLines(db, business, job);
    const priced = await priceLines(db, business, job, inputs, { current, canDiscount: access.can(business, 'sales.discount'), hasClaim: await hasClaim(db, business, job) });
    await applyVersion(db, business, user, job, current, priced, { source: 'estimate', note, requestKey, hash, rounding: settings?.rounding });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// Parts a mechanic used, added to the estimate at the customer's price for
// each (they see no prices); a new version. body: { requestKey, parts: [{ skuId, quantity, description? }], note? }
async function addParts(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = jobs.hashOf({ ...body, jobId: String(jobId) });
  const parts = readParts(body.parts);
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    const done = await repo.one(db, 'SELECT job_card_id,request_hash FROM garage_estimate_versions WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.job_card_id) !== Number(job.id)) fail('This request key was already used for different data', 409);
      return jobs.shape(business, await jobs.load(db, business, job.id));
    }
    jobs.requireOpen(job);
    if (job.status === 'estimate_sent') fail(`Job card ${job.job_no} waits for the owner's approval: add parts once the work goes on`, 409);
    const settings = await checkTerms(db, business, job);
    const current = await currentLines(db, business, job);
    if (current.length + parts.length > MAX_LINES) fail(`An estimate has up to ${MAX_LINES} lines`);
    const priced = await priceLines(db, business, job, [...current.map((l) => asInput(l)), ...parts], { current, hasClaim: await hasClaim(db, business, job) });
    const added = priced.slice(current.length).map((p) => `${p.label} × ${Number(p.quantity)}`);
    await applyVersion(db, business, user, job, current, priced, { source: 'parts', note: [c.listWords(added), note].filter(Boolean).join(' · '), requestKey, hash, rounding: settings?.rounding });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// The work done: each line ticked (the work done, the part fitted) or not.
// body: { lines: [{ lineId, done }], note? }
async function recordWork(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  const marks = v.requiredArray(body.lines ?? [], 'Lines').map((m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) fail('Each line must be an object');
    return { lineId: id(m.lineId, 'Line'), done: v.requiredBoolean(m.done, 'Done') };
  });
  if (marks.length > MAX_LINES) fail(`An estimate has up to ${MAX_LINES} lines`);
  const note = c.optionalText(body.note, 'Note', 300);
  if (!marks.length && !note) fail('Tick the work done, or write a note');
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    const current = await currentLines(db, business, job);
    const doneNow = [], undone = [];
    for (const mark of marks) {
      const line = current.find((l) => Number(l.id) === mark.lineId);
      if (!line) fail('That line is not on this job card', 404);
      if (line.done === mark.done) continue;
      await db.query(`UPDATE garage_job_card_lines SET done=$3,done_by=CASE WHEN $3 THEN $4::bigint END,done_at=CASE WHEN $3 THEN now() END WHERE business_id=$1 AND id=$2`,
        [business.id, line.id, mark.done, user.id]);
      (mark.done ? doneNow : undone).push(line.label);
    }
    if (!doneNow.length && !undone.length && !note) return jobs.shape(business, await jobs.load(db, business, job.id));
    await db.query('UPDATE garage_job_cards SET updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, job.id, user.id]);
    await jobs.history(db, business, user, job, job.status, job.status, [doneNow.length ? `Done: ${c.listWords(doneNow)}` : null,
      undone.length ? `Not done after all: ${c.listWords(undone)}` : null, note].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'job_card.work_recorded', job.id, { jobNo: job.job_no, done: doneNow, undone, ...(note ? { note } : {}) });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// --- The claim ---------------------------------------------------------------------------------

function readAmount(value, name) {
  if (!c.given(value)) return null;
  return core.decimal(String(value).trim(), name, 2, 0, 100000000);
}

// body: { insurerId, mode: cashless | reimbursement, policyNo, claimNo?, surveyorName?, surveyorPhone?, approvedAmount?, deductible?, depreciation? }
async function saveClaim(business, user, jobId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  const insurerId = id(body.insurerId, 'Insurer');
  const mode = v.requiredEnum(body.mode, 'Claim', ['cashless', 'reimbursement']);
  const policyNo = v.requiredString(typeof body.policyNo === 'string' ? body.policyNo : '', 'Policy number', 60);
  const claimNo = c.optionalText(body.claimNo, 'Claim number', 60);
  const surveyorName = c.optionalText(body.surveyorName, 'Surveyor', 150);
  const surveyorPhone = c.optionalText(body.surveyorPhone, 'Surveyor\'s phone', 30);
  // Amounts left out stay as they are (someone who sees no money changes the rest).
  const given = (key) => body[key] !== undefined;
  const approvedAsked = given('approvedAmount') ? readAmount(body.approvedAmount, 'Amount the insurer approved') : undefined;
  if (approvedAsked === 0) fail('The amount the insurer approved is more than 0; leave it empty until the surveyor approves');
  const deductibleAsked = given('deductible') ? readAmount(body.deductible, 'Deductible') ?? 0 : undefined;
  const depreciationAsked = given('depreciation') ? readAmount(body.depreciation, 'Depreciation') ?? 0 : undefined;
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    const insurer = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, insurerId]);
    if (!insurer) fail('Choose the insurer from your customers (add the insurance company as a customer, with its GSTIN)', 404);
    if (Number(insurer.id) === Number(job.contact_id)) fail('The insurer is not the job card\'s own customer: choose the insurance company');
    const before = await repo.one(db, 'SELECT * FROM garage_claims WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]);
    const approved = approvedAsked !== undefined ? approvedAsked : before?.approved_amount ? Number(before.approved_amount) : null;
    const deductible = deductibleAsked !== undefined ? deductibleAsked : Number(before?.deductible || 0);
    const depreciation = depreciationAsked !== undefined ? depreciationAsked : Number(before?.depreciation || 0);
    const settings = await repo.one(db, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
    if (approved !== null && settings?.rounding === 'nearest_rupee' && money.paise(approved) % 100 !== 0) {
      fail('The amount the insurer approved is in whole rupees: this business rounds its bills to the rupee');
    }
    // Checked against the insurer's lines once there are some (billing checks again).
    const covered = (await repo.one(db, "SELECT COALESCE(sum(net+tax),0) AS total FROM garage_job_card_lines WHERE business_id=$1 AND job_card_id=$2 AND payer='insurer'",
      [business.id, job.id])).total;
    if (approved !== null && money.paise(covered) > 0) {
      if (money.paise(approved) > money.paise(covered)) fail(`The insurer approved ${approved.toFixed(2)}, more than its lines on the job card (${Number(covered).toFixed(2)})`);
      if (money.paise(approved) + money.paise(deductible) + money.paise(depreciation) > money.paise(covered)) {
        fail(`The approved amount, deductible and depreciation come to more than the insurer's lines (${Number(covered).toFixed(2)})`);
      }
    }
    await db.query(`INSERT INTO garage_claims(business_id,job_card_id,insurer_id,mode,policy_no,claim_no,surveyor_name,surveyor_phone,approved_amount,deductible,depreciation,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
      ON CONFLICT (business_id,job_card_id) DO UPDATE SET insurer_id=EXCLUDED.insurer_id,mode=EXCLUDED.mode,policy_no=EXCLUDED.policy_no,claim_no=EXCLUDED.claim_no,
        surveyor_name=EXCLUDED.surveyor_name,surveyor_phone=EXCLUDED.surveyor_phone,approved_amount=EXCLUDED.approved_amount,deductible=EXCLUDED.deductible,
        depreciation=EXCLUDED.depreciation,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, job.id, insurer.id, mode, policyNo, claimNo, surveyorName, surveyorPhone, approved === null ? null : approved.toFixed(2), deductible.toFixed(2), depreciation.toFixed(2), user.id]);
    await db.query('UPDATE garage_job_cards SET updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, job.id, user.id]);
    // The history names the claim, not its amounts.
    await jobs.history(db, business, user, job, job.status, job.status, `${before ? 'Claim changed' : 'Claim recorded'}: ${insurer.name}, policy ${policyNo}${claimNo ? `, claim ${claimNo}` : ''} (${mode})`);
    await repo.audit(db, business.id, user.id, before ? 'job_card.claim_changed' : 'job_card.claim_recorded', job.id, { jobNo: job.job_no, insurer: insurer.name, mode, policyNo, claimNo,
      approvedAmount: approved === null ? null : approved.toFixed(2), deductible: deductible.toFixed(2), depreciation: depreciation.toFixed(2),
      ...(before ? { before: { insurerId: Number(before.insurer_id), mode: before.mode, approvedAmount: before.approved_amount, deductible: before.deductible, depreciation: before.depreciation } } : {}) });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// The claim taken off: every line the insurer was to pay becomes the
// customer's (a new version of the estimate when there were any).
async function removeClaim(business, user, jobId) {
  c.requireGarage(business);
  await c.requireDesk(business);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    const claim = await repo.one(db, 'SELECT g.*,k.name AS insurer_name FROM garage_claims g JOIN business_contacts k ON k.business_id=g.business_id AND k.id=g.insurer_id WHERE g.business_id=$1 AND g.job_card_id=$2',
      [business.id, job.id]);
    if (!claim) fail(`Job card ${job.job_no} has no claim`, 404);
    const current = await currentLines(db, business, job);
    if (current.some((l) => l.payer === 'insurer')) {
      const settings = await checkTerms(db, business, job);
      const priced = await priceLines(db, business, job, current.map((l) => asInput(l, 'customer')), { current, hasClaim: true });
      await applyVersion(db, business, user, job, current, priced, { source: 'claim', note: null, requestKey: crypto.randomUUID(), hash: jobs.hashOf({ jobId, claim: 'removed' }),
        rounding: settings?.rounding });
    }
    await db.query('DELETE FROM garage_claims WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]);
    const after = await repo.one(db, 'SELECT status FROM garage_job_cards WHERE business_id=$1 AND id=$2', [business.id, job.id]);
    await jobs.history(db, business, user, job, after.status, after.status, `Claim taken off (${claim.insurer_name}, policy ${claim.policy_no}): every line is the customer's`);
    await repo.audit(db, business.id, user.id, 'job_card.claim_removed', job.id, { jobNo: job.job_no, insurer: claim.insurer_name, policyNo: claim.policy_no, claimNo: claim.claim_no });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

module.exports = { preview, save, addParts, recordWork, saveClaim, removeClaim };
