const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./jewelleryCommon');
const money = require('./jewelleryMoney');
const rates = require('./jewelleryRates.service');
const pieces = require('./jewelleryPieces.service');
const { settingsOf } = require('./jewellerySettings.service');

// Old gold (module "jewellery"): gold, silver or platinum a customer sells to
// the shop or gives in exchange for new jewellery, on a numbered voucher
// (OG/2627/0001) at the location that takes it in. The seller is a customer of
// the shop, with the photo ID seen (of an Aadhaar card only its last four
// digits are kept), their PAN or a Form 97 declaration when the voucher is
// worth more than ₹2,00,000, and their declaration that the metal is theirs
// to sell. Each article is tested (karatmeter (XRF), touchstone, acid or fire
// assay) and weighed: gross less stones and dirt is its net weight, the
// fineness found gives its fine weight, and it is valued at the day's latest
// buy rate for the purity it is valued as, scaled by the fineness found, less
// the deduction (melting loss or the shop's own rule), to the paisa; the
// voucher's value is rounded as the business rounds its bills. Its metal
// joins the shop's own metal at once, by purity, for melting and refining.
//
// The value is then paid out in money (UPI or bank transfer first: a seller
// does not receive ₹2,00,000 or more in cash for old gold in a day or for one
// voucher, Income-tax Act 2025 section 186, and the shop may set a lower cash
// limit of its own), or used on the seller's jewellery bills as a payment by
// old gold (a credit note: no money moves), or both in parts. Money paid out
// is written in the expense book, so the drawer and the day's money show it.
// When a bill old gold paid is returned, that part goes back onto the voucher
// (to be paid out or used again), not out as a refund. A voucher nothing was
// paid out or used on can be cancelled; its metal then goes back out.
// Money is integer paise and weight integer milligrams in this file.

const { fail, id } = c;
const MAX_LINES = 30;
const MAX_ON_BILL = 5;
// A seller does not receive this much or more in cash for old gold, in a day or for one voucher.
const CASH_LIMIT = 20000000;
// A voucher worth more than this records the seller's PAN or their Form 97 declaration.
const PAN_ABOVE = 20000000;
const TEST_METHODS = { xrf: 'Karatmeter (XRF)', touchstone: 'Touchstone', acid: 'Acid test', fire_assay: 'Fire assay' };
const ID_KINDS = { aadhaar: 'Aadhaar card', voter_id: 'Voter ID', driving_licence: 'Driving licence', passport: 'Passport', pan_card: 'PAN card', other: 'Other photo ID' };
const PAYOUT_KINDS = ['cash', 'upi', 'bank'];
const PAYOUT_WORDS = { cash: 'Cash', upi: 'UPI', bank: 'Bank transfer' };
// The seller's words on the voucher, signed by them.
const DECLARATION = 'I declare that the gold, silver or platinum described above is my own, and that I have the right to sell it.';
const expenses = () => require('../../core/services/businessExpenses.service');
const returns = () => require('../../core/services/businessReturns.service');

const VOUCHERS_SQL = `SELECT x.*,(x.value-x.used-x.paid) AS balance,
    CASE WHEN x.cancelled_at IS NOT NULL THEN 'cancelled' WHEN x.value-x.used-x.paid>0 THEN 'open' ELSE 'settled' END AS state
  FROM (SELECT g.id,g.location_id,l.name AS location_name,g.voucher_no,g.contact_id,g.seller_name,g.seller_phone,g.id_kind,g.id_ref,g.pan,g.pan_declaration,
      g.rate_date::text AS rate_date,g.net_weight,g.fine_weight,g.round_off,g.value,g.notes,g.created_at,g.created_by,u.name AS by_name,g.cancelled_at,g.cancel_reason,
      cu.name AS cancelled_by_name,
      (SELECT count(*)::int FROM jewellery_old_gold_lines n WHERE n.business_id=g.business_id AND n.old_gold_id=g.id) AS lines,
      (SELECT string_agg(DISTINCT n.metal||':'||n.purity,' ') FROM jewellery_old_gold_lines n WHERE n.business_id=g.business_id AND n.old_gold_id=g.id) AS purities,
      COALESCE((SELECT sum(s.amount) FROM jewellery_old_gold_uses s WHERE s.business_id=g.business_id AND s.old_gold_id=g.id),0) AS used,
      COALESCE((SELECT sum(p.amount) FROM jewellery_old_gold_payouts p WHERE p.business_id=g.business_id AND p.old_gold_id=g.id),0) AS paid
    FROM jewellery_old_gold g JOIN business_locations l ON l.business_id=g.business_id AND l.id=g.location_id JOIN users u ON u.id=g.created_by
    LEFT JOIN users cu ON cu.id=g.cancelled_by WHERE g.business_id=$1) x`;

repo.addLists({
  // Every voucher, newest first, with what was used and paid out on it and what is left.
  'jewellery-old-gold': { sql: VOUCHERS_SQL, search: ['voucher_no', 'seller_name', 'seller_phone'], date: 'created_at',
    filters: { state: 'state', location: 'location_id', contact: 'contact_id' }, order: 'id DESC' },
});

// --- Reading a voucher as typed ----------------------------------------------------------------------

function readSeller(body) {
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : null;
  const typed = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer) && c.given(body.customer.name)
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone } : null;
  if (contactId && typed) fail('Choose the customer or type a new one, not both');
  if (!contactId && !typed) fail('Old gold is bought from a customer: choose them, or add them');
  const idKind = v.requiredEnum(body.idKind, 'Photo ID seen', Object.keys(ID_KINDS));
  const idRef = String(body.idRef ?? '').toUpperCase().replace(/\s+/g, '');
  if (idKind === 'aadhaar' && !/^\d{4}$/.test(idRef)) fail('Keep only the last four digits of an Aadhaar number');
  if (!/^[A-Z0-9/-]{2,30}$/.test(idRef)) fail('The photo ID\'s number is 2 to 30 letters and digits');
  // A PAN card's number is the PAN.
  const pan = c.given(body.pan) ? String(body.pan).toUpperCase().replace(/\s+/g, '') : idKind === 'pan_card' ? idRef : null;
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fail('A PAN is 10 letters and digits, like ABCDE1234F');
  const declared = body.panDeclaration === undefined || body.panDeclaration === null ? false : v.requiredBoolean(body.panDeclaration, 'Form 97 declaration');
  if (body.ownerDeclared !== true) fail('The seller declares the metal is their own to sell: tick the declaration');
  return { contactId, typed, idKind, idRef, pan, panDeclaration: !pan && declared, notes: c.optionalText(body.notes, 'Notes', 300) };
}

function readLines(value, settings) {
  const list = v.requiredArray(value, 'Old gold');
  if (!list.length) fail('Add each article the customer brings in');
  if (list.length > MAX_LINES) fail(`A voucher takes at most ${MAX_LINES} lines`);
  return list.map((raw, index) => {
    const n = `Line ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    const description = pieces.plainWords(v.requiredString(raw.description, `${n}: what it is`, 150), n);
    const count = c.given(raw.pieces) ? c.decimal(raw.pieces, `${n}: how many`, 0, 1, 1000) : 1;
    const { metal, purity } = c.readPurity(raw.metal, raw.purity, `${n}: purity`);
    const fineness = c.purityOf(metal, purity).fineness;
    const testMethod = v.requiredEnum(raw.testMethod, `${n}: how it was tested`, Object.keys(TEST_METHODS));
    const testedFineness = c.given(raw.testedFineness) ? c.decimal(raw.testedFineness, `${n}: fineness found`, 1, 0.1, 999.9) : fineness;
    const grossWeight = c.readWeight(raw.grossWeight, `${n}: gross weight`);
    const lessWeight = c.given(raw.lessWeight) ? c.readWeight(raw.lessWeight, `${n}: stones and dirt taken off`, 0) : 0;
    if (c.mg(lessWeight) >= c.mg(grossWeight)) fail(`${n}: what is taken off must be less than the gross weight`);
    const deductionPercent = c.given(raw.deductionPercent) ? c.decimal(raw.deductionPercent, `${n}: deduction`, 2, 0, 99.99) : Number(settings.old_gold_deduction);
    const huid = c.given(raw.huid) ? String(raw.huid).toUpperCase().replace(/\s+/g, '') : null;
    if (huid && !/^[A-Z0-9]{6}$/.test(huid)) fail(`${n}: a HUID is 6 letters and digits`);
    return { seq: index + 1, description, pieces: count, metal, purity, fineness, testMethod, testedFineness, grossWeight, lessWeight, deductionPercent, huid };
  });
}

// Each line valued at the day's latest buy rate for its purity, with the problem that stops it (if any).
async function priceLines(db, business, lines) {
  const now = await rates.ratesNow(db, business);
  return { day: now.day, lines: lines.map((line) => {
    const rate = now.byPurity.get(`${line.metal}:${line.purity}`);
    if (!rate || !rate.buy_rate) return { ...line, problem: `The shop has no buy rate for ${c.purityWords(line.metal, line.purity)} today: set it in Today's rates` };
    const figures = money.oldGoldValue({ gross_weight: line.grossWeight, less_weight: line.lessWeight, tested_fineness: line.testedFineness,
      deduction_percent: line.deductionPercent, fineness: line.fineness }, rate.buy_rate);
    return { ...line, rate, figures, problem: null };
  }) };
}

// The voucher's weights and value: its lines added up, rounded as the business rounds its bills.
function totals(lines, rounding) {
  const netMg = lines.reduce((s, l) => s + l.figures.netMg, 0);
  const fineMg = lines.reduce((s, l) => s + l.figures.fineMg, 0);
  const raw = lines.reduce((s, l) => s + l.figures.value, 0);
  const value = rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw;
  return { netMg, fineMg, raw, roundOff: value - raw, value };
}

const lineText = (l) => ({ seq: l.seq, description: l.description, pieces: l.pieces, metal: l.metal, purity: l.purity, mark: c.purityMark(l.metal, l.purity),
  testMethod: l.testMethod, testedFineness: Number(l.testedFineness).toFixed(1), grossWeight: Number(l.grossWeight).toFixed(3), lessWeight: Number(l.lessWeight).toFixed(3),
  netWeight: l.figures ? c.grams(l.figures.netMg) : null, fineWeight: l.figures ? c.grams(l.figures.fineMg) : null, deductionPercent: Number(l.deductionPercent).toFixed(2),
  huid: l.huid, buyRate: l.rate ? Number(l.rate.buy_rate).toFixed(2) : null, value: l.figures ? c.rupees(l.figures.value) : null, problem: l.problem });

// What the voucher would come to now, nothing saved.
async function preview(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const settings = await settingsOf(repo.pool, business.id);
  const priced = await priceLines(repo.pool, business, readLines(body.lines, settings));
  const ok = priced.lines.filter((l) => !l.problem);
  const shop = await repo.one(repo.pool, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const t = totals(ok, shop?.rounding);
  return { day: priced.day, lines: priced.lines.map(lineText), problems: priced.lines.filter((l) => l.problem).map((l) => l.problem),
    netWeight: c.grams(t.netMg), fineWeight: c.grams(t.fineMg), roundOff: c.rupees(t.roundOff), value: c.rupees(t.value), panNeeded: t.value > PAN_ABOVE };
}

// body: { requestKey, locationId, contactId? | customer?: { name, phone? } (with contacts.create), idKind, idRef, pan?, panDeclaration?,
//   ownerDeclared: true, lines: [{ description, pieces?, metal, purity, testMethod, testedFineness?, grossWeight, lessWeight?, deductionPercent?, huid? }], notes? }
async function create(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const seller = readSeller(body);
  if (seller.typed) await access.require(business, 'contacts.create');
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_old_gold WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    const lines = readLines(body.lines, await settingsOf(db, business.id));
    let contact;
    if (seller.contactId) {
      contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, seller.contactId]);
      if (!contact) fail('Customer not found', 404);
      if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
    } else {
      // A new customer keeps the PAN they gave (their bills then have it).
      contact = await core.createContact(business, user, { ...seller.typed, ...(seller.pan ? { pan: seller.pan } : {}) }, db);
    }
    const priced = await priceLines(db, business, lines);
    const problem = priced.lines.find((l) => l.problem);
    if (problem) fail(problem.problem, 409);
    const shop = await repo.one(db, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
    const t = totals(priced.lines, shop?.rounding);
    if (t.value <= 0) fail('The old gold comes to nothing: check the weights and the deduction');
    const pan = seller.pan || contact.pan || null;
    if (t.value > PAN_ABOVE && !pan && !seller.panDeclaration) {
      fail('Old gold worth more than ₹2,00,000 needs the seller\'s PAN: type it, or record that they have none and signed a declaration (Form 97)');
    }
    const number = await numbering.nextNumber(db, business.id, location.id, 'old_gold', user.id);
    const row = await repo.one(db, `INSERT INTO jewellery_old_gold(business_id,location_id,voucher_no,series_id,contact_id,seller_name,seller_phone,id_kind,id_ref,pan,pan_declaration,
        owner_declared,rate_date,net_weight,fine_weight,round_off,value,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, contact.phone || null, seller.idKind, seller.idRef, pan, !pan && seller.panDeclaration,
      priced.day, c.grams(t.netMg), c.grams(t.fineMg), c.rupees(t.roundOff), c.rupees(t.value), seller.notes, requestKey, hash, user.id]);
    for (const l of priced.lines) {
      await db.query(`INSERT INTO jewellery_old_gold_lines(business_id,old_gold_id,seq,description,pieces,metal,purity,test_method,tested_fineness,gross_weight,less_weight,fine_weight,
          huid,rate_sheet_id,buy_rate,deduction_percent,value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [business.id, row.id, l.seq, l.description, l.pieces, l.metal, l.purity, l.testMethod, l.testedFineness.toFixed(1), l.grossWeight.toFixed(3), l.lessWeight.toFixed(3),
        c.grams(l.figures.fineMg), l.huid, l.rate.sheet_id, l.rate.buy_rate, l.deductionPercent.toFixed(2), c.rupees(l.figures.value)]);
      await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,old_gold_id,old_gold_seq,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,'old_gold',$7,$8,$9,$10)`, [business.id, location.id, l.metal, l.purity, c.grams(l.figures.netMg), c.grams(l.figures.fineMg), row.id, l.seq,
        `Old gold ${number.number}: ${l.description}`.slice(0, 300), user.id]);
    }
    const figures = { voucherNo: number.number, seller: contact.name, value: c.rupees(t.value), netWeight: c.grams(t.netMg), fineWeight: c.grams(t.fineMg), rateDate: priced.day,
      idKind: seller.idKind, pan: Boolean(pan), panDeclaration: !pan && seller.panDeclaration,
      lines: priced.lines.map((l) => ({ description: l.description, purity: c.purityWords(l.metal, l.purity), testedFineness: l.testedFineness.toFixed(1), netWeight: c.grams(l.figures.netMg),
        fineWeight: c.grams(l.figures.fineMg), buyRate: Number(l.rate.buy_rate).toFixed(2), deduction: l.deductionPercent.toFixed(2), value: c.rupees(l.figures.value) })) };
    await repo.audit(db, business.id, user.id, 'jewellery_old_gold.taken', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_old_gold.taken', 'jewellery_old_gold', row.id, { ...figures, contactId: contact.id, locationId: location.id });
    return view(db, business, row.id);
  });
}

// --- A voucher and its settlement ----------------------------------------------------------------------

async function view(db, business, voucherId) {
  const row = await repo.one(db, `SELECT * FROM (${VOUCHERS_SQL}) w WHERE w.id=$2`, [business.id, voucherId]);
  if (!row) fail('Old gold voucher not found', 404);
  const [lines, uses, payouts] = await Promise.all([
    repo.all(db, `SELECT l.*,(SELECT p.tag_no FROM jewellery_piece_huids h JOIN jewellery_pieces p ON p.business_id=h.business_id AND p.id=h.piece_id
        WHERE h.business_id=l.business_id AND h.huid=l.huid) AS own_tag
      FROM jewellery_old_gold_lines l WHERE l.business_id=$1 AND l.old_gold_id=$2 ORDER BY l.seq`, [business.id, row.id]),
    repo.all(db, `SELECT s.id,s.document_id,d.document_no,s.amount,s.created_at,u.name AS by_name,(s.amount>0) AS used,
        d.total-COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS bill_left
      FROM jewellery_old_gold_uses s JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.document_id JOIN users u ON u.id=s.created_by
      WHERE s.business_id=$1 AND s.old_gold_id=$2 ORDER BY s.id`, [business.id, row.id]),
    repo.all(db, `SELECT p.id,p.amount,p.method,e.method_name,p.reference,p.expense_id,p.created_at,u.name AS by_name FROM jewellery_old_gold_payouts p
      JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id JOIN users u ON u.id=p.created_by
      WHERE p.business_id=$1 AND p.old_gold_id=$2 ORDER BY p.id`, [business.id, row.id]),
  ]);
  return { ...row, lines: lines.map((l) => ({ ...l, mark: c.purityMark(l.metal, l.purity), purity_words: c.purityWords(l.metal, l.purity), test_words: TEST_METHODS[l.test_method] })),
    uses, payouts: payouts.map((p) => ({ ...p, method_words: p.method_name || PAYOUT_WORDS[p.method] })), putBack: await putBackChoices(db, business, row.id),
    id_words: ID_KINDS[row.id_kind], declaration: DECLARATION, cancellable: row.state === 'open' && Number(row.used) === 0 && Number(row.paid) === 0 };
}

// The bills this voucher paid that were returned since: how much of it can go back on the voucher from each.
async function putBackChoices(db, business, voucherId) {
  const rows = await repo.all(db, `SELECT s.document_id,d.document_no,sum(s.amount) AS on_bill,
      COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
      - COALESCE((SELECT sum(f.amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0)
      - (d.total - COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)) AS credit
    FROM jewellery_old_gold_uses s JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.document_id
    WHERE s.business_id=$1 AND s.old_gold_id=$2 GROUP BY s.document_id,d.document_no,d.business_id,d.id,d.total`, [business.id, voucherId]);
  return rows.map((r) => ({ documentId: r.document_id, documentNo: r.document_no, onBill: Number(r.on_bill).toFixed(2), credit: Number(r.credit).toFixed(2),
    amount: c.rupees(Math.max(0, Math.min(c.paise(r.on_bill), c.paise(r.credit)))) })).filter((r) => c.paise(r.amount) > 0);
}

async function detail(business, voucherId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  const voucher = await view(repo.pool, business, id(voucherId, 'Voucher'));
  access.requireLocation(business, voucher.location_id);
  return voucher;
}

// Locks the voucher for a change inside the caller's transaction (the business row is locked first).
async function lockVoucher(db, business, voucherId) {
  const row = await repo.one(db, 'SELECT id,location_id FROM jewellery_old_gold WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(voucherId, 'Voucher')]);
  if (!row) fail('Old gold voucher not found', 404);
  access.requireLocation(business, row.location_id);
  return view(db, business, row.id);
}

// Cash paid out for old gold to a seller on the business's date, and on one voucher (paise).
async function cashOut(db, business, voucher) {
  const row = await repo.one(db, `SELECT
      COALESCE((SELECT sum(p.amount) FROM jewellery_old_gold_payouts p JOIN jewellery_old_gold g ON g.business_id=p.business_id AND g.id=p.old_gold_id
        WHERE p.business_id=$1 AND g.contact_id=$2 AND p.method='cash' AND (p.created_at AT TIME ZONE $4)::date=(now() AT TIME ZONE $4)::date),0) AS today,
      COALESCE((SELECT sum(amount) FROM jewellery_old_gold_payouts WHERE business_id=$1 AND old_gold_id=$3 AND method='cash'),0) AS on_voucher`,
  [business.id, voucher.contact_id, voucher.id, business.timezone]);
  return { today: c.paise(row.today), onVoucher: c.paise(row.on_voucher) };
}

// body: { requestKey, amount? (empty: all that is left), method (cash, upi, bank) | methodId, reference? }
async function payout(business, user, voucherId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const choice = paymentMethods.readChoice(body, 'Paid by', PAYOUT_KINDS);
  const amount = c.given(body.amount) ? c.paise(c.decimal(body.amount, 'Amount paid out', 2, 0.01, 100000000)) : null;
  const reference = c.optionalText(body.reference, 'Reference', 100);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT old_gold_id,request_hash FROM jewellery_old_gold_payouts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || Number(old.old_gold_id) !== Number(voucherId)) fail('This request key was already used for different data', 409);
      return view(db, business, old.old_gold_id);
    }
    const voucher = await lockVoucher(db, business, voucherId);
    if (voucher.state === 'cancelled') fail(`Old gold ${voucher.voucher_no} is cancelled`, 409);
    const left = c.paise(voucher.balance);
    if (left <= 0) fail(`Old gold ${voucher.voucher_no} has nothing left to pay out`, 409);
    const pay = amount ?? left;
    if (pay > left) fail(`Old gold ${voucher.voucher_no} has ${c.rupees(left)} left: no more is paid out`, 409);
    const method = await paymentMethods.settle(db, business.id, choice, 'Paid by', PAYOUT_KINDS);
    if (method.method === 'cash') {
      const cash = await cashOut(db, business, voucher);
      if (cash.today + pay >= CASH_LIMIT || cash.onVoucher + pay >= CASH_LIMIT) {
        fail(`A seller does not receive ₹2,00,000 or more in cash for old gold, in a day or for one voucher (Income-tax Act 2025, section 186): the cash to ${voucher.seller_name} would reach ${c.rupees(Math.max(cash.today, cash.onVoucher) + pay)}. Pay the rest by UPI or bank transfer.`, 409);
      }
      const own = (await settingsOf(db, business.id)).old_gold_cash_limit;
      if (own !== null && own !== undefined && cash.today + pay > c.paise(own)) {
        fail(`The shop pays at most ${c.rupees(c.paise(own))} in cash for old gold to one seller in a day (its own limit, in Settings › Jewellery settings): today's cash to ${voucher.seller_name} would reach ${c.rupees(cash.today + pay)}. Pay the rest by UPI or bank transfer.`, 409);
      }
    }
    const day = await c.today(db, business);
    const expense = await expenses().insertExpense(db, business, user, { locationId: voucher.location_id, spentOn: day, category: 'other',
      description: `Old gold bought: ${voucher.voucher_no} from ${voucher.seller_name}`.slice(0, 200), amount: c.rupees(pay), choice, reference, requestKey: c.derivedKey(requestKey, 'expense') });
    const row = await repo.one(db, `INSERT INTO jewellery_old_gold_payouts(business_id,old_gold_id,expense_id,amount,method,reference,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [business.id, voucher.id, expense.id, c.rupees(pay), method.method, reference, requestKey, hash, user.id]);
    const figures = { voucherNo: voucher.voucher_no, seller: voucher.seller_name, amount: c.rupees(pay), method: method.method, ...(method.methodName ? { methodName: method.methodName } : {}),
      left: c.rupees(left - pay), expenseId: expense.id };
    await repo.audit(db, business.id, user.id, 'jewellery_old_gold.paid', voucher.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_old_gold.paid', 'jewellery_old_gold', voucher.id, { ...figures, payoutId: row.id, contactId: voucher.contact_id, locationId: voucher.location_id });
    return view(db, business, voucher.id);
  });
}

// body: { reason }. A voucher nothing was paid out or used on is cancelled, and its metal goes back out.
async function cancel(business, user, voucherId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.cancel');
  await c.requireMoney(business);
  const reason = v.requiredString(body.reason, 'Why it is cancelled', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const voucher = await lockVoucher(db, business, voucherId);
    if (voucher.state === 'cancelled') return voucher;
    if (Number(voucher.used) !== 0 || Number(voucher.paid) !== 0) fail(`Old gold ${voucher.voucher_no} was paid out or used on a bill: it is not cancelled`, 409);
    await db.query('UPDATE jewellery_old_gold SET cancelled_at=now(),cancelled_by=$3,cancel_reason=$4 WHERE business_id=$1 AND id=$2', [business.id, voucher.id, user.id, reason]);
    for (const l of voucher.lines) {
      await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,old_gold_id,old_gold_seq,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,'old_gold_cancelled',$7,$8,$9,$10)`, [business.id, voucher.location_id, l.metal, l.purity, (-Number(l.net_weight)).toFixed(3),
        (-Number(l.fine_weight)).toFixed(3), voucher.id, l.seq, `Old gold ${voucher.voucher_no} cancelled: ${reason}`.slice(0, 300), user.id]);
    }
    const figures = { voucherNo: voucher.voucher_no, seller: voucher.seller_name, value: Number(voucher.value).toFixed(2), netWeight: voucher.net_weight, reason };
    await repo.audit(db, business.id, user.id, 'jewellery_old_gold.cancelled', voucher.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_old_gold.cancelled', 'jewellery_old_gold', voucher.id, { ...figures, contactId: voucher.contact_id });
    return view(db, business, voucher.id);
  });
}

// body: { requestKey, documentId, amount? (empty: all that can go back) }. A bill this voucher
// paid was returned: that part of the bill's credit goes back on the voucher, by credit note.
async function putBack(business, user, voucherId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const documentId = id(body.documentId, 'Bill');
  const amount = c.given(body.amount) ? c.paise(c.decimal(body.amount, 'Amount', 2, 0.01, 100000000)) : null;
  return repo.transaction(async (db) => {
    // The bill is locked as the core locks a refund (business, then document), by someone who may refund it.
    const doc = await returns().lockDocument(db, business, documentId, 'refund');
    const refundKey = c.derivedKey(requestKey, 'put-back');
    const done = await repo.one(db, 'SELECT id,document_id,amount FROM business_refunds WHERE business_id=$1 AND request_key=$2', [business.id, refundKey]);
    const voucher = await lockVoucher(db, business, voucherId);
    if (done) {
      if (Number(done.document_id) !== Number(doc.id) || (amount !== null && c.paise(done.amount) !== amount)) fail('This request key was already used for different data', 409);
      return voucher;
    }
    const choice = voucher.putBack.find((p) => Number(p.documentId) === Number(doc.id));
    if (!choice) fail(`Nothing of old gold ${voucher.voucher_no} can go back from ${doc.document_no}: take the piece back on the bill's credit note first`, 409);
    const most = c.paise(choice.amount);
    const back = amount ?? most;
    if (back > most) fail(`At most ${c.rupees(most)} of old gold ${voucher.voucher_no} goes back from ${doc.document_no}`, 409);
    const refund = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by)
      VALUES($1,$2,$3,'credit_note',$4,$5,$6) RETURNING *`, [business.id, doc.id, c.rupees(back), `Old gold ${voucher.voucher_no} put back on its voucher`, refundKey, user.id]);
    await repo.audit(db, business.id, user.id, 'sale.refunded', refund.id, { documentId: doc.id, amount: refund.amount, method: 'credit_note' });
    await repo.event(db, business.id, user.id, 'sale.refunded', 'refund', refund.id, { documentId: doc.id, documentNo: doc.document_no, amount: refund.amount, method: 'credit_note' });
    await db.query('INSERT INTO jewellery_old_gold_uses(business_id,old_gold_id,document_id,refund_id,amount,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [business.id, voucher.id, doc.id, refund.id, c.rupees(-back), user.id]);
    const figures = { voucherNo: voucher.voucher_no, documentNo: doc.document_no, amount: c.rupees(back), left: c.rupees(c.paise(voucher.balance) + back) };
    await repo.audit(db, business.id, user.id, 'jewellery_old_gold.put_back', voucher.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_old_gold.put_back', 'jewellery_old_gold', voucher.id, { ...figures, documentId: doc.id, refundId: refund.id });
    return view(db, business, voucher.id);
  });
}

// --- Old gold on a jewellery bill ----------------------------------------------------------------------

function readForBill(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Old gold');
  if (list.length > MAX_ON_BILL) fail(`A bill takes old gold from at most ${MAX_ON_BILL} vouchers`);
  const ids = list.map((x) => id(x, 'Old gold voucher'));
  if (new Set(ids.map(String)).size !== ids.length) fail('An old gold voucher is on the bill twice');
  return ids;
}

// The vouchers a bill takes old gold from (locked when posting): each open, with value left, all brought in by one customer.
async function vouchersFor(db, business, ids, { lock = false } = {}) {
  const found = [];
  for (const voucherId of ids) {
    if (lock) await repo.one(db, 'SELECT id FROM jewellery_old_gold WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, voucherId]);
    const row = await repo.one(db, `SELECT * FROM (${VOUCHERS_SQL}) w WHERE w.id=$2`, [business.id, voucherId]);
    if (!row) fail('Old gold voucher not found', 404);
    if (row.state === 'cancelled') fail(`Old gold ${row.voucher_no} is cancelled`, 409);
    if (c.paise(row.balance) <= 0) fail(`Old gold ${row.voucher_no} has nothing left on it`, 409);
    if (found.length && Number(found[0].contact_id) !== Number(row.contact_id)) fail(`Old gold ${row.voucher_no} was brought in by ${row.seller_name}, not ${found[0].seller_name}: a bill takes one customer's old gold`, 409);
    found.push(row);
  }
  return found;
}

// What each voucher pays of a bill's total (paise): in the order given, each up to what is left on it.
function applyTo(vouchers, total) {
  let applied = 0;
  return vouchers.map((voucher) => {
    const amount = Math.min(c.paise(voucher.balance), total - applied);
    if (amount <= 0) fail(`The bill is paid in full before old gold ${voucher.voucher_no}: take it off the bill`, 409);
    applied += amount;
    return { voucher, amount };
  });
}

// After the bill's sale is posted with its payments by old gold: each is recorded as the voucher's use.
async function recordUses(db, business, user, document, uses, keyOf) {
  for (const use of uses) {
    const payment = await repo.one(db, 'SELECT id FROM business_payments WHERE business_id=$1 AND request_key=$2', [business.id, keyOf(use)]);
    await db.query('INSERT INTO jewellery_old_gold_uses(business_id,old_gold_id,document_id,payment_id,amount,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [business.id, use.voucher.id, document.id, payment.id, c.rupees(use.amount), user.id]);
    const figures = { voucherNo: use.voucher.voucher_no, documentNo: document.document_no, amount: c.rupees(use.amount), left: c.rupees(c.paise(use.voucher.balance) - use.amount) };
    await repo.audit(db, business.id, user.id, 'jewellery_old_gold.used', use.voucher.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_old_gold.used', 'jewellery_old_gold', use.voucher.id, { ...figures, documentId: document.id, paymentId: payment.id });
  }
}

// The bell: vouchers taken in before today with value still to pay out or use (for whoever pays out).
async function bell(business, base) {
  if (!access.can(business, 'jewellery.approve') || !c.seesMoney(business)) return [];
  const day = await c.today(repo.pool, business);
  const row = await repo.one(repo.pool, `SELECT count(*)::int AS n,COALESCE(sum(balance),0) AS waiting,min(created_at) AS since FROM (${VOUCHERS_SQL}) w
    WHERE w.state='open' AND (w.created_at AT TIME ZONE $2)::date<$3::date AND ($4::bigint IS NULL OR w.location_id=$4)`, [business.id, business.timezone, day, business.location_scope || null]);
  if (!row.n) return [];
  return [{ id: `jewellery-old-gold:${day}`, severity: 'warning', category: 'Old gold', title: `${c.plural(row.n, 'old gold voucher')} with value left`,
    detail: `${c.rupees(c.paise(row.waiting))} taken in before today is not yet paid out or used on a bill`, at: new Date(row.since).toISOString(), link: `${base}/old-gold` }];
}

module.exports = { TEST_METHODS, ID_KINDS, PAYOUT_KINDS, DECLARATION, CASH_LIMIT, preview, create, detail, view, payout, cancel, putBack, readForBill, vouchersFor, applyTo,
  recordUses, bell };
