const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./garageCommon');
const money = require('./garageMoney');
const jobs = require('./garageJobCards.service');
const vehicles = require('./garageVehicles.service');
// The core's stock picking and the pricing of a line's pieces (quotations).
const quotes = () => require('../../quotations/services/businessQuotations.service');
// Parts held for the job, the claim's progress, mechanics' commission and service plans.
const work = () => require('./garageWork.service');
const claims = () => require('./garageClaims.service');
const commission = () => require('./garageCommission.service');
const plans = () => require('./garagePlans.service');

// "Bill the job" (module "garage", garages): a ready job card becomes its
// bills, posted by the core at the job card's prices with GST at each item's
// rate of the day, and is delivered.
//
//   one bill    to the customer, with every line: a job with no claim, or a
//               reimbursement claim (the owner pays the garage and claims the
//               approved amount from the insurer; the bill names the claim).
//   two bills   for a cashless claim, as CBIC Circular 217/11/2024-GST
//               describes: one to the insurer (a customer, on its own credit)
//               for exactly the amount it approved, spread over its lines; one
//               to the customer for their own lines and the owner's share of
//               the claim (the deductible, the depreciation and whatever the
//               surveyor did not allow), billed as lines of the claim-share
//               item, one for each GST slab of the insurer's lines. The two
//               come to the job's total to the paisa. A reimbursement claim
//               billed in the insurer's name is billed the same way, and the
//               customer pays the insurer's bill in full now (bill to the
//               insurer, collect from the customer).
//   stock       parts issued to a mechanic for the job left stock then: the bill
//               takes them at the cost they were issued at and takes nothing
//               again. The rest leave stock now, on whichever bill carries them
//               (batch and serial items as chosen, or the oldest expiry first); a
//               part not in usable stock at the job card's location stops the
//               billing until it is received. A garage that issues parts bills
//               a part line only once it is issued in full.
//   with it     the gate pass for the vehicle; the claim invoiced (and, paid in
//               full now, settled); each labour line's commission to its
//               mechanic, with the bill line that carries it (a credit of that
//               line takes the commission back).
//   money       the advance pays the customer's bill first; the rest is paid now
//               or left on the customer's dues. The insurer's bill waits on its
//               dues.
//   delivery    the odometer at delivery (optional) goes into the vehicle's log;
//               the next service is set on the vehicle: the day and reading given,
//               or the service plan of its model or engine (days and kilometres),
//               or else the garage's months and kilometres after this job (a job
//               card with nothing on it leaves the vehicle's as it was).
//   who         the desk (garage.edit with garage.view): a mechanic does not bill.
// Money is integer paise; quantities integer thousandths.

const { fail } = c;
const { paise, rupees } = money;
const milli = (value) => Math.round(Number(value) * 1000);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
// A bill over ₹2,00,000 records the buyer's PAN (the core checks it too).
const PAN_ABOVE_PAISE = 20000000;
// How far ahead the next service may be set.
const MAX_NEXT_SERVICE_DAYS = 5 * 366;

// Each line as it is now in the catalogue: still billed, and not above its
// MRP at the value the bill charges for it today.
function checkBillable(values) {
  for (const { line, net, tax } of values) {
    if (!line.sku_active || !line.product_active) fail(`${line.label} is switched off in the catalogue: switch it on again to bill this job card`, 409);
    if (line.internal_use) fail(`${line.label} is kept for use in services only: untick that on the item to bill this job card`, 409);
    if (line.sku_kind === 'goods' && line.mrp_now !== null && line.mrp_now !== undefined) {
      const each = roundedDivide(BigInt(net + tax) * 1000n, BigInt(milli(line.quantity)));
      if (each > paise(line.mrp_now)) {
        fail(`${line.label} is charged ${rupees(each)} a ${line.unit} with GST, above its MRP of ${Number(line.mrp_now).toFixed(2)} now. Correct the MRP, or revise the estimate.`, 409);
      }
    }
  }
}

// The bill's lines and fixed prices for a bill's values: each line from the
// stock it comes out of, at its share of the value (pricePieces keeps a split
// line adding up to the paisa), in the business's price terms now. A part
// line takes the parts held for it first (issued to a mechanic: `held` on the
// piece, its stock cost), then stock now. A claim-share line keeps the slab
// and words of the lines it comes from.
async function piecesOf(db, business, job, values, choices, mode, held, issueMode) {
  const pieces = [];
  for (const value of values) {
    const line = value.line;
    const each = (value.net + (mode === 'inclusive' ? value.tax : 0)) / 100 / Number(line.quantity);
    const priced = { sku_id: line.sku_id, quantity: line.quantity, net: rupees(value.net), tax: rupees(value.tax), discount: '0', unit_price: each.toFixed(4),
      unit_factor: null, entered_unit: null, entered_unit_price: null, price_rule_id: line.share ? null : line.price_rule_id || null };
    if (line.share) {
      for (const piece of quotes().pricePieces({ tax_mode: mode }, priced, [{ lotCode: '', quantityMilli: 1000 }])) {
        pieces.push({ ...piece, fixed: { ...piece.fixed, taxRate: Number(value.rate).toFixed(2), label: line.label }, held: null, lineId: null });
      }
      continue;
    }
    const issued = line.sku_kind === 'goods' ? held.get(Number(line.id)) || [] : [];
    const rest = milli(line.quantity) - issued.reduce((sum, p) => sum + p.quantityMilli, 0);
    if (rest < 0) fail(`More of ${line.label} is held for the job than it bills: bring back what is not used first`, 409);
    if (rest > 0 && issueMode && line.sku_kind === 'goods' && ['quantity', 'batch'].includes(line.tracking)) {
      fail(`Issue ${(rest / 1000).toString()} ${line.unit} more of ${line.label} to the mechanic before billing, or take it off the estimate`, 409);
    }
    const picks = issued.map((p) => ({ lotCode: p.lotCode, quantityMilli: p.quantityMilli, unitCost: p.unitCost }));
    if (rest > 0) {
      const stockLine = { ...line, quantity: (rest / 1000).toFixed(3), sku: { kind: line.sku_kind, tracking: line.tracking } };
      picks.push(...await quotes().stockPieces(db, business, job, stockLine, choices.get(Number(line.id))));
    }
    quotes().pricePieces({ tax_mode: mode }, priced, picks).forEach((piece, index) => {
      pieces.push({ ...piece, held: picks[index].unitCost === undefined ? null : { unitCost: picks[index].unitCost }, lineId: Number(line.id) });
    });
  }
  return pieces;
}

// The next service: as given (empty for none), or the vehicle's service plan
// (days and kilometres), or the garage's months and kilometres after this job.
function nextService(body, garage, day, baseKm, latestKm, plan) {
  const on = body.nextServiceOn !== undefined ? c.readDate(body.nextServiceOn, 'Next service on', true)
    : plan ? c.addDays(day, Number(plan.interval_days)) : c.addMonths(day, garage.service_months);
  const kmGiven = body.nextServiceKm !== undefined;
  const km = kmGiven ? c.readKm(body.nextServiceKm, 'Next service at') : baseKm === null || baseKm === undefined ? null
    : Number(baseKm) + (plan ? Number(plan.interval_km) : garage.service_km);
  if (on !== null && (on <= day || on > c.addDays(day, MAX_NEXT_SERVICE_DAYS))) fail('The next service is a day after today, within five years');
  if (km !== null && latestKm !== null && km <= latestKm) fail(`The next service is at more than ${c.km(latestKm)} km, the vehicle's reading now`);
  if (km !== null && km > 9999999) fail('Next service at must be at most 9,999,999 km');
  return { on, km };
}

// body: { requestKey, payment? | payments? ({ amount | "full", method | methodId, reference?, tendered? }),
//   insurerPayment?: { method | methodId, reference? } (a bill in the insurer's name, paid in full by the customer now),
//   lines?: [{ lineId, lots: [{ lotCode, quantity }] | serials: [code] }], buyer?: { pan?, panDeclaration? },
//   odometerOutKm?, odometerApproval?, nextServiceOn?, nextServiceKm?, note? }
async function bill(business, user, jobId, body) {
  c.requireGarage(business);
  // Billing and delivery are the desk's: a mechanic takes no money and hands no vehicle over.
  await c.requireDesk(business);
  const billKey = core.uuid(body.requestKey);
  const hash = jobs.hashOf({ ...body, jobId: String(jobId) });
  const parts = core.readPayments(body);
  const insurerParts = body.insurerPayment ? core.readPayments({ payment: { ...body.insurerPayment, amount: 'full' } }) : [];
  const choices = quotes().readStockChoices(body);
  const note = c.optionalText(body.note, 'Note', 300);
  const outKm = c.readKm(body.odometerOutKm, 'Odometer at delivery');
  const approval = await vehicles.readLowerApproval(business, user, body.odometerApproval);
  const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    // A retry gives the same bills; the same key with other data is refused.
    if (job.status === 'delivered' && job.bill_key === billKey) {
      const docs = await repo.all(db, 'SELECT request_hash FROM business_documents WHERE business_id=$1 AND request_key=ANY($2::uuid[])',
        [business.id, [jobs.derivedKey(billKey, 'insurer'), jobs.derivedKey(billKey, 'customer')]]);
      if (docs.some((d) => d.request_hash !== hash)) fail('This request key was already used for different data', 409);
      return jobs.shape(business, await jobs.load(db, business, job.id));
    }
    jobs.requireOpen(job);
    if (job.status !== 'ready') fail(`Job card ${job.job_no} is ${c.STATUS_WORDS[job.status]}: it is billed once the work is ready`, 409);
    const lines = await jobs.linesOf(db, business, job);
    for (const lineId of choices.keys()) if (!lines.some((l) => Number(l.id) === lineId && l.sku_kind === 'goods')) fail('That line is not a part on this job card', 404);
    if (lines.length) await access.require(business, 'sales.create');
    if (parts.length || insurerParts.length) await access.require(business, 'sales.edit');
    const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
    const mode = settings?.tax_mode || 'exclusive';
    const claim = await jobs.claimOf(db, business, job.id);
    const garage = await jobs.settingsOf(db, business);
    const plan = money.plan(job, lines, claim, settings?.rounding, garage.share);
    if (plan.problem) fail(plan.problem, 409);
    checkBillable(money.todayValues(job, lines));
    if (plan.insurerNamed && plan.insurer && !insurerParts.length) fail('The customer pays the bill in the insurer\'s name now: choose how they pay it', 400);
    if (insurerParts.length && !plan.insurerNamed) fail('Only a reimbursement claim billed in the insurer\'s name is paid by the customer on the insurer\'s bill');
    // Parts issued for the job, and whether this garage issues them.
    const held = await work().heldPicks(db, business, job.id);
    const issueMode = await work().issueSetting(db, business);
    const words = [`Job card ${job.job_no}`, job.registration_no];
    // Which bill line carries each job card line (each piece's item, in the bill's order): the
    // commission a labour line earns is taken back when its bill line is credited.
    const billLines = new Map();
    const carry = async (doc, pieces) => {
      const docLines = await repo.all(db, 'SELECT id,sku_id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]);
      const taken = new Set();
      for (const piece of pieces) {
        const found = docLines.find((l) => !taken.has(String(l.id)) && String(l.sku_id) === String(piece.input.skuId));
        if (!found) continue;
        taken.add(String(found.id));
        if (piece.lineId) billLines.set(piece.lineId, Number(found.id));
      }
    };
    // The insurer's bill: what it approved, on its own credit.
    let insurerDoc = null;
    if (plan.insurer) {
      if (!claim.insurer_active) fail(`${claim.insurer_name} is switched off among the customers: switch it on again to bill the claim`, 409);
      if (plan.insurer.figures.total > PAN_ABOVE_PAISE && !claim.insurer_pan && !claim.insurer_gstin) {
        fail(`The insurer's bill is over ₹2,00,000: save ${claim.insurer_name}'s GSTIN or PAN on its customer record first`, 409);
      }
      const pieces = await piecesOf(db, business, job, plan.insurer.values, choices, mode, held, issueMode);
      const documentBody = { kind: 'sale', locationId: job.location_id, contactId: claim.insurer_id, lines: pieces.map((p) => p.input),
        notes: [...words, `claim ${claim.claim_no} (policy ${claim.policy_no})`, plan.insurerNamed ? `reimbursement, paid by ${job.customer_name}` : 'cashless',
          `owner: ${job.customer_name}`].join(' · ').slice(0, 500) };
      insurerDoc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: jobs.derivedKey(billKey, 'insurer'), hash, lines: documentBody.lines,
        paidNow: plan.insurerNamed ? insurerParts.map((p) => ({ ...p, reference: p.reference || `paid by ${job.customer_name}`.slice(0, 100) })) : null,
        fixed: pieces.map((p) => p.fixed), issued: pieces.map((p) => p.held) });
      if (paise(insurerDoc.total) !== plan.insurer.figures.total) {
        fail(`The insurer's bill would come to ${insurerDoc.total}, not the ${rupees(plan.insurer.figures.total)} it approved. Try again.`, 409);
      }
      await carry(insurerDoc, pieces);
    }
    // The customer's bill: the advance first, then what is paid now.
    let customerDoc = null, advanceUse = 0;
    if (plan.customer) {
      const total = plan.customer.figures.total;
      if (job.advance_collection_id) {
        const free = await repo.one(db, `SELECT ${jobs.FREE_SQL('k')} AS free FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, job.advance_collection_id]);
        advanceUse = Math.min(Math.max(0, paise(free.free)), total);
      }
      const due = total - advanceUse;
      const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((sum, p) => sum + paise(p.amount), 0);
      if (fixedPaid > due) fail(`Only ${rupees(due)} is left to pay after the advance`);
      const paidNow = parts.map((p) => (p.amount === 'full' ? { ...p, amount: Number(rupees(due - fixedPaid)) } : p)).filter((p) => paise(p.amount) > 0);
      const pieces = await piecesOf(db, business, job, plan.customer.values, choices, mode, held, issueMode);
      const share = plan.customer.values.some((x) => x.line.share)
        ? `owner's share of claim ${claim.claim_no}: deductible ₹${plan.claim.deductible}, depreciation ₹${plan.claim.depreciation}` : null;
      const reimbursement = claim && claim.mode === 'reimbursement' && !plan.insurerNamed ? `claim ${claim.claim_no || `on policy ${claim.policy_no}`} with ${claim.insurer_name} (reimbursement)` : null;
      const documentBody = { kind: 'sale', locationId: job.location_id, contactId: job.contact_id, lines: pieces.map((p) => p.input),
        notes: [...words, share, reimbursement, note].filter(Boolean).join(' · ').slice(0, 500), buyer: { pan: buyer.pan, panDeclaration: buyer.panDeclaration } };
      customerDoc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: jobs.derivedKey(billKey, 'customer'), hash, lines: documentBody.lines,
        paidNow, fixed: pieces.map((p) => p.fixed), issued: pieces.map((p) => p.held) });
      if (paise(customerDoc.total) !== total) fail(`The bill would come to ${customerDoc.total}, not the ${rupees(total)} worked out for the job card. Try again.`, 409);
      await carry(customerDoc, pieces);
      if (advanceUse > 0) {
        const receipt = await repo.one(db, 'SELECT collection_no,method FROM business_collections WHERE business_id=$1 AND id=$2', [business.id, job.advance_collection_id]);
        await core.recordPayment(db, business, user, customerDoc, { amount: rupees(advanceUse), method: receipt.method, reference: receipt.collection_no,
          key: jobs.derivedKey(billKey, 'advance'), collectionId: job.advance_collection_id });
      }
    } else if (parts.length) {
      fail(plan.insurer ? 'The insurer pays the whole job: there is nothing for the customer to pay now' : 'Nothing on this job card is billed, so there is nothing to pay');
    }
    // The two bills are the job, to the paisa.
    const billed = (insurerDoc ? paise(insurerDoc.total) : 0) + (customerDoc ? paise(customerDoc.total) : 0);
    if (lines.length && billed !== plan.job.total) fail(`The bills would come to ${rupees(billed)}, not the job card's ${rupees(plan.job.total)}. Try again.`, 409);
    // The odometer at delivery, and the next service.
    const vehicle = await vehicles.lockVehicle(db, business, job.vehicle_id);
    if (outKm !== null) await vehicles.recordReading(db, business, user, vehicle, outKm, { source: 'job_out', jobCardId: job.id, approval });
    const day = await c.today(db, business);
    const latestKm = outKm ?? (vehicle.odometer_km === null ? null : Number(vehicle.odometer_km));
    // A job with work on it sets the next service; a job card with nothing on it
    // leaves the vehicle's as it was, unless one is given.
    const setNext = lines.length > 0 || body.nextServiceOn !== undefined || body.nextServiceKm !== undefined;
    const servicePlan = setNext ? await plans().planFor(db, business, vehicle) : null;
    const next = setNext ? nextService(body, garage, day, outKm ?? job.odometer_in, latestKm, servicePlan) : { on: null, km: null };
    if (setNext) {
      await db.query('UPDATE garage_vehicles SET next_service_on=$3,next_service_km=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2',
        [business.id, vehicle.id, next.on, next.km, user.id]);
    }
    await db.query(`UPDATE garage_job_cards SET status='delivered',document_id=$3,insurer_document_id=$4,bill_key=$5,next_service_on=$6,next_service_km=$7,
      delivered_by=$8,delivered_at=now(),updated_by=$8,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, job.id, customerDoc?.id || null, insurerDoc?.id || null, billKey, next.on, next.km, user.id]);
    // The gate pass for the vehicle; the claim invoiced (settled when the customer paid the insurer's bill now); each labour line's commission.
    await db.query('INSERT INTO garage_gate_passes(business_id,job_card_id,issued_by) VALUES($1,$2,$3)', [business.id, job.id, user.id]);
    if (claim) await claims().invoiced(db, business, user, job, day, { settled: Boolean(plan.insurerNamed && insurerDoc) });
    const earned = lines.length ? await commission().earn(db, business, job, money.todayValues(job, lines), day, billLines) : [];
    // The history names the bills, not their amounts.
    await jobs.history(db, business, user, job, job.status, 'delivered', [customerDoc ? `Bill ${customerDoc.document_no}` : null,
      insurerDoc ? `insurer's bill ${insurerDoc.document_no}` : null, advanceUse > 0 ? 'the advance taken off' : null,
      !customerDoc && !insurerDoc ? 'Nothing to bill' : null, note].filter(Boolean).join(' · '));
    const figures = { documentNo: customerDoc?.document_no || null, insurerDocumentNo: insurerDoc?.document_no || null, total: rupees(billed),
      customerTotal: customerDoc ? customerDoc.total : '0.00', insurerTotal: insurerDoc ? insurerDoc.total : '0.00', advanceUsed: rupees(advanceUse) };
    await repo.audit(db, business.id, user.id, 'job_card.billed', job.id, { jobNo: job.job_no, ...figures, nextServiceOn: next.on, nextServiceKm: next.km,
      ...(servicePlan ? { servicePlanId: Number(servicePlan.id) } : {}), ...(earned.length ? { commission: earned } : {}) });
    await repo.event(db, business.id, user.id, 'job_card.billed', 'job_card', job.id, { jobNo: job.job_no, documentId: customerDoc?.id || null,
      insurerDocumentId: insurerDoc?.id || null, ...figures });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

module.exports = { bill };
