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
const { settingsOf, buybackRule, purityDeductionsOf, RULE_WORDS } = require('./jewellerySettings.service');

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
// the deduction, to the paisa; the voucher's value is rounded as the business
// rounds its bills. The deduction is the shop's buy-back rule: its own pieces
// (known by their HUID or tag) take the shop's own-piece deduction, outside
// jewellery its purity's (else the general one); a line with another
// deduction needs a manager's approval, and is audited. Photos of what came in
// are added to the voucher (jewelleryFiles.service.js). Its metal joins the
// shop's own metal at once, by purity, and goes on from there: melted, kept
// to resell as it is (a status only), sent to a refiner or bullion dealer on a
// refinery challan (jewelleryRefinery.service.js), or issued to a karigar on
// an issue challan (jewelleryKarigars.service.js).
//
// The value is then paid out in money (UPI or bank transfer first: a seller
// does not receive ₹2,00,000 or more in cash for old gold in a day or for one
// voucher, Income-tax Act 2025 section 186, and the shop may set a lower cash
// limit of its own), or used on the seller's jewellery bills as a payment by
// old gold (a credit note: no money moves), or both in parts. Several of one
// seller's vouchers can be paid out at once (from the customer's screen or the
// day's money), each checked by the cash limits as it is paid. Money paid out
// is written in the expense book, so the drawer and the day's money show it.
// When a bill old gold paid is returned, that part goes back onto the voucher
// (to be paid out or used again), not out as a refund. A voucher nothing was
// paid out or used on can be cancelled; its metal then goes back out.
// Money is integer paise and weight integer milligrams in this file.

const { fail, id } = c;
const MAX_LINES = 30;
const MAX_ON_BILL = 5;
// Vouchers of one seller paid out together.
const MAX_AT_ONCE = 10;
// A seller does not receive this much or more in cash for old gold, in a day or for one voucher.
const CASH_LIMIT = 20000000;
// A voucher worth more than this records the seller's PAN or their Form 97 declaration.
const PAN_ABOVE = 20000000;
const TEST_METHODS = { xrf: 'Karatmeter (XRF)', touchstone: 'Touchstone', acid: 'Acid test', fire_assay: 'Fire assay' };
const ID_KINDS = { aadhaar: 'Aadhaar card', voter_id: 'Voter ID', driving_licence: 'Driving licence', passport: 'Passport', pan_card: 'PAN card', other: 'Other photo ID' };
const PAYOUT_KINDS = ['cash', 'upi', 'bank'];
const PAYOUT_WORDS = { cash: 'Cash', upi: 'UPI', bank: 'Bank transfer' };
// What happens to a line's metal next.
const NEXT_WORDS = { melt: 'With the shop\'s metal, to melt', resell: 'Kept to resell as it is', refinery: 'Sent to a refiner or dealer', karigar: 'Issued to a karigar' };
// The seller's words on the voucher, signed by them.
const DECLARATION = 'I declare that the gold, silver or platinum described above is my own, and that I have the right to sell it.';
const expenses = () => require('../../core/services/businessExpenses.service');
const returns = () => require('../../core/services/businessReturns.service');
const pins = () => require('../../salon-weight/services/businessManagerPin');

const VOUCHERS_SQL = `SELECT x.*,(x.value-x.used-x.paid) AS balance,
    CASE WHEN x.cancelled_at IS NOT NULL THEN 'cancelled' WHEN x.value-x.used-x.paid>0 THEN 'open' ELSE 'settled' END AS state
  FROM (SELECT g.id,g.location_id,l.name AS location_name,g.voucher_no,g.contact_id,g.seller_name,g.seller_phone,g.id_kind,g.id_ref,g.pan,g.pan_declaration,
      g.rate_date::text AS rate_date,g.net_weight,g.fine_weight,g.round_off,g.value,g.notes,g.created_at,g.created_by,u.name AS by_name,g.cancelled_at,g.cancel_reason,
      cu.name AS cancelled_by_name,
      (SELECT count(*)::int FROM jewellery_old_gold_lines n WHERE n.business_id=g.business_id AND n.old_gold_id=g.id) AS lines,
      (SELECT string_agg(DISTINCT n.metal||':'||n.purity,' ') FROM jewellery_old_gold_lines n WHERE n.business_id=g.business_id AND n.old_gold_id=g.id) AS purities,
      (SELECT count(*)::int FROM jewellery_files f WHERE f.business_id=g.business_id AND f.old_gold_id=g.id AND f.removed_at IS NULL) AS photos,
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
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone, consents: body.customer.consents } : null;
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

// Each article as typed. Its deduction is the shop's buy-back rule unless one is typed (another needs a manager).
function readLines(value) {
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
    const typedDeduction = c.given(raw.deductionPercent) ? c.decimal(raw.deductionPercent, `${n}: deduction`, 2, 0, 99.99) : null;
    const huid = c.given(raw.huid) ? String(raw.huid).toUpperCase().replace(/\s+/g, '') : null;
    if (huid && !/^[A-Z0-9]{6}$/.test(huid)) fail(`${n}: a HUID is 6 letters and digits`);
    // The shop's own tag on the article, when it is one of its pieces.
    const tag = pieces.readTag(raw.tag, `${n}: the shop's tag`);
    return { seq: index + 1, description, pieces: count, metal, purity, fineness, testMethod, testedFineness, grossWeight, lessWeight, typedDeduction, huid, tag };
  });
}

// The shop's own piece each article is, known by its tag or its HUID: one the
// shop sold, of the article's metal (a HUID of a piece still in the shop is
// refused: the article is checked first).
async function ownPieces(db, business, lines) {
  const out = [];
  for (const line of lines) {
    const n = `Line ${line.seq}`;
    let own = null;
    if (line.tag) {
      own = await repo.one(db, 'SELECT id,tag_no,status,metal FROM jewellery_pieces WHERE business_id=$1 AND tag_no=$2', [business.id, line.tag]);
      if (!own) fail(`${n}: no piece of this shop has the tag ${line.tag}`, 404);
    }
    if (line.huid) {
      const marked = await repo.one(db, `SELECT p.id,p.tag_no,p.status,p.metal FROM jewellery_piece_huids h JOIN jewellery_pieces p ON p.business_id=h.business_id AND p.id=h.piece_id
        WHERE h.business_id=$1 AND h.huid=$2`, [business.id, line.huid]);
      if (own && (!marked || Number(marked.id) !== Number(own.id))) fail(`${n}: HUID ${line.huid} is not on piece ${own.tag_no}: check the article`, 409);
      own = own || marked;
    }
    if (own && own.status !== 'sold') {
      fail(`${n}: piece ${own.tag_no} is ${pieces.STATUS_WORDS[own.status]} here, not sold: check the article before buying it`, 409);
    }
    if (own && own.metal !== line.metal) fail(`${n}: piece ${own.tag_no} is ${c.METAL_WORDS[own.metal].toLowerCase()}, not ${c.METAL_WORDS[line.metal].toLowerCase()}`, 409);
    out.push({ ...line, own: own ? { id: own.id, tag: own.tag_no } : null });
  }
  return out;
}

// Each line's buy-back rule and the deduction it takes: the one typed, or the rule's.
async function ruleLines(db, business, lines) {
  const settings = await settingsOf(db, business.id);
  const deductions = await purityDeductionsOf(db, business);
  return (await ownPieces(db, business, lines)).map((line) => {
    const rule = buybackRule(settings, deductions, { metal: line.metal, purity: line.purity, ownPiece: Boolean(line.own) });
    const deductionPercent = line.typedDeduction === null ? rule.percent : line.typedDeduction;
    return { ...line, rule, deductionPercent, override: c.paise(deductionPercent) !== c.paise(rule.percent) };
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
  rule: l.rule.rule, rulePercent: l.rule.percent.toFixed(2), ruleWords: RULE_WORDS[l.rule.rule], override: l.override, ownTag: l.own?.tag || null,
  huid: l.huid, buyRate: l.rate ? Number(l.rate.buy_rate).toFixed(2) : null, value: l.figures ? c.rupees(l.figures.value) : null, problem: l.problem });

// What the voucher would come to now, nothing saved; and whether a manager approves a deduction changed from the rule.
async function preview(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const priced = await priceLines(repo.pool, business, await ruleLines(repo.pool, business, readLines(body.lines)));
  const ok = priced.lines.filter((l) => !l.problem);
  const shop = await repo.one(repo.pool, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const t = totals(ok, shop?.rounding);
  return { day: priced.day, lines: priced.lines.map(lineText), problems: priced.lines.filter((l) => l.problem).map((l) => l.problem),
    netWeight: c.grams(t.netMg), fineWeight: c.grams(t.fineMg), roundOff: c.rupees(t.roundOff), value: c.rupees(t.value), panNeeded: t.value > PAN_ABOVE,
    needsApproval: priced.lines.some((l) => l.override) };
}

// body: { requestKey, locationId, contactId? | customer?: { name, phone? } (with contacts.create), idKind, idRef, pan?, panDeclaration?,
//   ownerDeclared: true, lines: [{ description, pieces?, metal, purity, testMethod, testedFineness?, grossWeight, lessWeight?, deductionPercent?, huid?, tag? }],
//   approval?: { approverId?, pin?, reason } (a deduction other than the buy-back rule's), notes? }
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
  const lines = readLines(body.lines);
  // A deduction changed from the shop's rule: a manager approves it, with why (a retry is answered by its voucher).
  const done = await repo.one(repo.pool, 'SELECT id,request_hash FROM jewellery_old_gold WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
  const overridden = done ? [] : (await ruleLines(repo.pool, business, lines)).filter((l) => l.override);
  const approval = overridden.length ? await pins().readApproval(business, user, { ...(body.approval && typeof body.approval === 'object' ? body.approval : {}) },
    'jewellery.approve', { reasonLabel: 'Why the deduction is changed', selfWithoutPin: true }) : null;
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_old_gold WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    let contact;
    if (seller.contactId) {
      contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, seller.contactId]);
      if (!contact) fail('Customer not found', 404);
      if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
    } else {
      // A new customer keeps the PAN they gave (their bills then have it).
      contact = await core.createContact(business, user, { ...seller.typed, ...(seller.pan ? { pan: seller.pan } : {}) }, db);
    }
    const priced = await priceLines(db, business, await ruleLines(db, business, lines));
    const problem = priced.lines.find((l) => l.problem);
    if (problem) fail(problem.problem, 409);
    if (priced.lines.some((l) => l.override) && !approval) fail('The buy-back rules changed while the voucher was made: value it again', 409);
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
          huid,rate_sheet_id,buy_rate,deduction_percent,value,own_piece_id,deduction_rule,rule_percent,override_by,override_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [business.id, row.id, l.seq, l.description, l.pieces, l.metal, l.purity, l.testMethod, l.testedFineness.toFixed(1), l.grossWeight.toFixed(3), l.lessWeight.toFixed(3),
        c.grams(l.figures.fineMg), l.huid, l.rate.sheet_id, l.rate.buy_rate, l.deductionPercent.toFixed(2), c.rupees(l.figures.value), l.own?.id || null, l.rule.rule,
        l.rule.percent.toFixed(2), l.override ? approval.approver.id : null, l.override ? approval.reason : null]);
      await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,old_gold_id,old_gold_seq,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,'old_gold',$7,$8,$9,$10)`, [business.id, location.id, l.metal, l.purity, c.grams(l.figures.netMg), c.grams(l.figures.fineMg), row.id, l.seq,
        `Old gold ${number.number}: ${l.description}`.slice(0, 300), user.id]);
    }
    const figures = { voucherNo: number.number, seller: contact.name, value: c.rupees(t.value), netWeight: c.grams(t.netMg), fineWeight: c.grams(t.fineMg), rateDate: priced.day,
      idKind: seller.idKind, pan: Boolean(pan), panDeclaration: !pan && seller.panDeclaration,
      lines: priced.lines.map((l) => ({ description: l.description, purity: c.purityWords(l.metal, l.purity), testedFineness: l.testedFineness.toFixed(1), netWeight: c.grams(l.figures.netMg),
        fineWeight: c.grams(l.figures.fineMg), buyRate: Number(l.rate.buy_rate).toFixed(2), deduction: l.deductionPercent.toFixed(2), rule: l.rule.rule,
        rulePercent: l.rule.percent.toFixed(2), ...(l.own ? { ownTag: l.own.tag } : {}), value: c.rupees(l.figures.value) })) };
    await repo.audit(db, business.id, user.id, 'jewellery_old_gold.taken', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_old_gold.taken', 'jewellery_old_gold', row.id, { ...figures, contactId: contact.id, locationId: location.id });
    // Each deduction changed from the rule, in the manager's name who approved it.
    for (const l of priced.lines.filter((x) => x.override)) {
      await repo.audit(db, business.id, approval.approver.id, 'jewellery_old_gold.deduction_changed', row.id, { voucherNo: number.number, seq: l.seq, description: l.description,
        rule: l.rule.rule, rulePercent: l.rule.percent.toFixed(2), deductionPercent: l.deductionPercent.toFixed(2), reason: approval.reason, approvedBy: approval.approver.name,
        requestedBy: user.id });
    }
    return view(db, business, row.id);
  });
}

// --- A voucher and its settlement ----------------------------------------------------------------------

const LINES_SQL = `SELECT l.*,COALESCE(op.tag_no,(SELECT p.tag_no FROM jewellery_piece_huids h JOIN jewellery_pieces p ON p.business_id=h.business_id AND p.id=h.piece_id
      WHERE h.business_id=l.business_id AND h.huid=l.huid)) AS own_tag,ou.name AS override_by_name,
    COALESCE(nx.next,'melt') AS next,nx.refinery_id,rc.challan_no AS refinery_no,nx.karigar_issue_id,ki.issue_no AS karigar_issue_no,nx.note AS next_note,nx.created_at AS next_at
  FROM jewellery_old_gold_lines l LEFT JOIN jewellery_pieces op ON op.business_id=l.business_id AND op.id=l.own_piece_id LEFT JOIN users ou ON ou.id=l.override_by
  LEFT JOIN LATERAL (SELECT n.* FROM jewellery_old_gold_next n WHERE n.business_id=l.business_id AND n.old_gold_id=l.old_gold_id AND n.seq=l.seq ORDER BY n.id DESC LIMIT 1) nx ON TRUE
  LEFT JOIN jewellery_refinery_challans rc ON rc.business_id=l.business_id AND rc.id=nx.refinery_id
  LEFT JOIN jewellery_karigar_issues ki ON ki.business_id=l.business_id AND ki.id=nx.karigar_issue_id
  WHERE l.business_id=$1 AND l.old_gold_id=$2 ORDER BY l.seq`;

// The voucher with its articles (and where each one's metal went), what was used and paid out, and its photos;
// read one after another on the caller's connection (a transaction's client runs one query at a time).
async function view(db, business, voucherId) {
  const row = await repo.one(db, `SELECT * FROM (${VOUCHERS_SQL}) w WHERE w.id=$2`, [business.id, voucherId]);
  if (!row) fail('Old gold voucher not found', 404);
  const [lines, uses, payouts, photos] = await c.inTurn(
    () => repo.all(db, LINES_SQL, [business.id, row.id]),
    () => repo.all(db, `SELECT s.id,s.document_id,d.document_no,s.amount,s.created_at,u.name AS by_name,(s.amount>0) AS used,
        d.total-COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS bill_left
      FROM jewellery_old_gold_uses s JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.document_id JOIN users u ON u.id=s.created_by
      WHERE s.business_id=$1 AND s.old_gold_id=$2 ORDER BY s.id`, [business.id, row.id]),
    () => repo.all(db, `SELECT p.id,p.amount,p.method,e.method_name,p.reference,p.expense_id,p.created_at,u.name AS by_name FROM jewellery_old_gold_payouts p
      JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id JOIN users u ON u.id=p.created_by
      WHERE p.business_id=$1 AND p.old_gold_id=$2 ORDER BY p.id`, [business.id, row.id]),
    () => repo.all(db, `SELECT f.id,f.file_name,f.mime_type,f.size_bytes,f.created_at,u.name AS by_name FROM jewellery_files f JOIN users u ON u.id=f.uploaded_by
      WHERE f.business_id=$1 AND f.old_gold_id=$2 AND f.removed_at IS NULL ORDER BY f.id`, [business.id, row.id]));
  return { ...row, lines: lines.map((l) => ({ ...l, mark: c.purityMark(l.metal, l.purity), purity_words: c.purityWords(l.metal, l.purity), test_words: TEST_METHODS[l.test_method],
    rule_words: l.deduction_rule ? RULE_WORDS[l.deduction_rule] : null, next_words: NEXT_WORDS[l.next] })), uses,
  payouts: payouts.map((p) => ({ ...p, method_words: p.method_name || PAYOUT_WORDS[p.method] })), photos, putBack: await putBackChoices(db, business, row.id),
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

// One voucher's value paid out, inside the caller's transaction (the business and the voucher locked):
// the cash limits checked, written in the expense book, audited. pay: paise; method: as settled.
async function payOne(db, business, user, voucher, { pay, choice, method, reference, requestKey, hash, together = null }) {
  if (voucher.state === 'cancelled') fail(`Old gold ${voucher.voucher_no} is cancelled`, 409);
  const left = c.paise(voucher.balance);
  if (left <= 0) fail(`Old gold ${voucher.voucher_no} has nothing left to pay out`, 409);
  if (pay > left) fail(`Old gold ${voucher.voucher_no} has ${c.rupees(left)} left: no more is paid out`, 409);
  if (method.method === 'cash') {
    const cash = await cashOut(db, business, voucher);
    if (cash.today + pay >= CASH_LIMIT || cash.onVoucher + pay >= CASH_LIMIT) {
      fail(`A seller does not receive ₹2,00,000 or more in cash for old gold, in a day or for one voucher (Income-tax Act 2025, section 186): the cash to ${voucher.seller_name} would reach ${c.rupees(Math.max(cash.today, cash.onVoucher) + pay)}${together ? ` with ${voucher.voucher_no}` : ''}. Pay the rest by UPI or bank transfer.`, 409);
    }
    const own = (await settingsOf(db, business.id)).old_gold_cash_limit;
    if (own !== null && own !== undefined && cash.today + pay > c.paise(own)) {
      fail(`The shop pays at most ${c.rupees(c.paise(own))} in cash for old gold to one seller in a day (its own limit, in Settings › Jewellery settings): today's cash to ${voucher.seller_name} would reach ${c.rupees(cash.today + pay)}${together ? ` with ${voucher.voucher_no}` : ''}. Pay the rest by UPI or bank transfer.`, 409);
    }
  }
  const day = await c.today(db, business);
  const expense = await expenses().insertExpense(db, business, user, { locationId: voucher.location_id, spentOn: day, category: 'other',
    description: `Old gold bought: ${voucher.voucher_no} from ${voucher.seller_name}`.slice(0, 200), amount: c.rupees(pay), choice, reference, requestKey: c.derivedKey(requestKey, 'expense') });
  const row = await repo.one(db, `INSERT INTO jewellery_old_gold_payouts(business_id,old_gold_id,expense_id,amount,method,reference,request_key,request_hash,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [business.id, voucher.id, expense.id, c.rupees(pay), method.method, reference, requestKey, hash, user.id]);
  const figures = { voucherNo: voucher.voucher_no, seller: voucher.seller_name, amount: c.rupees(pay), method: method.method, ...(method.methodName ? { methodName: method.methodName } : {}),
    left: c.rupees(left - pay), expenseId: expense.id, ...(together ? { together } : {}) };
  await repo.audit(db, business.id, user.id, 'jewellery_old_gold.paid', voucher.id, figures);
  await repo.event(db, business.id, user.id, 'jewellery_old_gold.paid', 'jewellery_old_gold', voucher.id, { ...figures, payoutId: row.id, contactId: voucher.contact_id, locationId: voucher.location_id });
  return row;
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
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT old_gold_id,request_hash FROM jewellery_old_gold_payouts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || Number(old.old_gold_id) !== Number(voucherId)) fail('This request key was already used for different data', 409);
      return view(db, business, old.old_gold_id);
    }
    const voucher = await lockVoucher(db, business, voucherId);
    const method = await paymentMethods.settle(db, business.id, choice, 'Paid by', PAYOUT_KINDS);
    await payOne(db, business, user, voucher, { pay: amount ?? c.paise(voucher.balance), choice, method, reference, requestKey, hash });
    return view(db, business, voucher.id);
  });
}

// Several of one seller's vouchers paid out at once (from the customer's screen
// or the day's money), each its own payout and expense, each checked by the
// cash limits as it is paid, in the order given.
// body: { requestKey, contactId, vouchers: [{ id, amount? (empty: all that is left) }], method (cash, upi, bank) | methodId, reference? }
async function payoutMany(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const contactId = id(body.contactId, 'Seller');
  const choice = paymentMethods.readChoice(body, 'Paid by', PAYOUT_KINDS);
  const reference = c.optionalText(body.reference, 'Reference', 100);
  const list = v.requiredArray(body.vouchers, 'Vouchers');
  if (!list.length) fail('Choose the vouchers to pay out');
  if (list.length > MAX_AT_ONCE) fail(`At most ${MAX_AT_ONCE} vouchers are paid out at once`);
  const wanted = list.map((raw, index) => {
    const n = `Voucher ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    return { id: id(raw.id, n), amount: c.given(raw.amount) ? c.paise(c.decimal(raw.amount, `${n}: amount`, 2, 0.01, 100000000)) : null };
  });
  if (new Set(wanted.map((w) => String(w.id))).size !== wanted.length) fail('A voucher is on the list twice');
  const keyOf = (voucherId) => c.derivedKey(requestKey, `payout-${voucherId}`);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT request_hash FROM jewellery_old_gold_payouts WHERE business_id=$1 AND request_key=$2', [business.id, keyOf(wanted[0].id)]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return sellerPayouts(db, business, contactId, wanted.map((w) => w.id));
    }
    const seller = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
    if (!seller) fail('Customer not found', 404);
    const method = await paymentMethods.settle(db, business.id, choice, 'Paid by', PAYOUT_KINDS);
    const together = wanted.length > 1 ? wanted.length : null;
    for (const w of wanted) {
      const voucher = await lockVoucher(db, business, w.id);
      if (Number(voucher.contact_id) !== Number(seller.id)) fail(`Old gold ${voucher.voucher_no} was brought in by ${voucher.seller_name}, not ${seller.name}: pay one seller's vouchers together`, 409);
      await payOne(db, business, user, voucher, { pay: w.amount ?? c.paise(voucher.balance), choice, method, reference, requestKey: keyOf(w.id), hash, together });
    }
    return sellerPayouts(db, business, seller.id, wanted.map((w) => w.id));
  });
}

// What one seller was paid on the vouchers paid out together, and what is left on each.
async function sellerPayouts(db, business, contactId, voucherIds) {
  const seller = await repo.one(db, 'SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, contactId]);
  const vouchers = [];
  for (const voucherId of voucherIds) vouchers.push(await view(db, business, voucherId));
  return { seller, vouchers, paid: c.rupees(vouchers.reduce((s, g) => s + c.paise(g.payouts.length ? g.payouts[g.payouts.length - 1].amount : 0), 0)) };
}

// body: { reason }. A voucher nothing was paid out or used on is cancelled, and its metal goes back out.
async function cancel(business, user, voucherId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.cancel');
  await c.requireMoney(business);
  const reason = v.requiredString(body.reason, 'Why it is cancelled', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const voucher = await lockVoucher(db, business, voucherId);
    if (voucher.state === 'cancelled') return voucher;
    if (Number(voucher.used) !== 0 || Number(voucher.paid) !== 0) fail(`Old gold ${voucher.voucher_no} was paid out or used on a bill: it is not cancelled`, 409);
    if (voucher.lines.some((l) => ['refinery', 'karigar'].includes(l.next))) fail(`Old gold ${voucher.voucher_no}'s metal went on to a refiner, dealer or karigar: it is not cancelled`, 409);
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

// --- What happens to its metal next --------------------------------------------------------------------

// body: { seq, next: 'melt' | 'resell', note? }. A line's metal stays with the shop's metal to melt, or is
// kept aside to resell as it is (a status: the metal is counted where it was); sent out only on a challan.
async function setNext(business, user, voucherId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await c.requireMoney(business);
  const seq = c.decimal(body.seq, 'Line', 0, 1, MAX_LINES);
  const next = v.requiredEnum(body.next, 'What happens next', ['melt', 'resell']);
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const voucher = await lockVoucher(db, business, voucherId);
    const line = voucher.lines.find((l) => Number(l.seq) === seq);
    if (!line) fail('Line not found', 404);
    if (voucher.state === 'cancelled') fail(`Old gold ${voucher.voucher_no} is cancelled`, 409);
    if (['refinery', 'karigar'].includes(line.next)) {
      fail(`Old gold ${voucher.voucher_no}'s ${line.description} went ${line.next === 'refinery' ? `to a refiner or dealer on ${line.refinery_no}` : `to a karigar on ${line.karigar_issue_no}`}`, 409);
    }
    if (line.next === next) return voucher;
    await db.query('INSERT INTO jewellery_old_gold_next(business_id,old_gold_id,seq,next,note,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [business.id, voucher.id, seq, next, note, user.id]);
    const figures = { voucherNo: voucher.voucher_no, seq, description: line.description, from: line.next, to: next, ...(note ? { note } : {}) };
    await repo.audit(db, business.id, user.id, 'jewellery_old_gold.next_set', voucher.id, figures);
    return view(db, business, voucher.id);
  });
}

// The old gold a challan names as carrying it: [{ voucherId, seq }] as typed (none: the challan names none).
function readRefs(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Old gold it carries');
  if (list.length > 50) fail('A challan names at most 50 lines of old gold');
  const refs = list.map((raw, index) => {
    const n = `Old gold ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    return { voucherId: id(raw.voucherId, `${n}: voucher`), seq: c.decimal(raw.seq, `${n}: line`, 0, 1, MAX_LINES) };
  });
  if (new Set(refs.map((r) => `${r.voucherId}:${r.seq}`)).size !== refs.length) fail('A line of old gold is named twice');
  return refs;
}

// Inside a challan's own transaction: each line of old gold it names goes on with it (to a refiner or dealer,
// or a karigar), from the challan's location, of a purity the challan sends. where: { next, refineryId?, karigarIssueId?, locationId, purities: Set('metal:purity'), number }
async function linkNext(db, business, user, refs, where) {
  const linked = [];
  for (const ref of refs) {
    const voucher = await repo.one(db, 'SELECT id,voucher_no,location_id,cancelled_at FROM jewellery_old_gold WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, ref.voucherId]);
    if (!voucher) fail('Old gold voucher not found', 404);
    const line = (await repo.all(db, LINES_SQL, [business.id, voucher.id])).find((l) => Number(l.seq) === ref.seq);
    if (!line) fail(`Old gold ${voucher.voucher_no} has no line ${ref.seq}`, 404);
    if (voucher.cancelled_at) fail(`Old gold ${voucher.voucher_no} is cancelled`, 409);
    if (Number(voucher.location_id) !== Number(where.locationId)) fail(`Old gold ${voucher.voucher_no} was taken in at another location: its metal is there`, 409);
    if (!where.purities.has(`${line.metal}:${line.purity}`)) fail(`Old gold ${voucher.voucher_no}'s ${line.description} is ${c.purityWords(line.metal, line.purity)}: the challan sends none of it`, 409);
    if (['refinery', 'karigar'].includes(line.next)) fail(`Old gold ${voucher.voucher_no}'s ${line.description} went on already (${line.refinery_no || line.karigar_issue_no})`, 409);
    await db.query('INSERT INTO jewellery_old_gold_next(business_id,old_gold_id,seq,next,refinery_id,karigar_issue_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [business.id, voucher.id, ref.seq, where.next, where.refineryId || null, where.karigarIssueId || null, user.id]);
    linked.push({ voucherNo: voucher.voucher_no, seq: ref.seq, description: line.description });
  }
  return linked;
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
// held: the vouchers a custom order holds, on its own bill (one with nothing left is passed over);
// orderId: the order the bill delivers (a voucher held for another open order pays only that order's bill).
async function vouchersFor(db, business, ids, { lock = false, held = false, orderId = null } = {}) {
  const found = [];
  for (const voucherId of ids) {
    if (lock) await repo.one(db, 'SELECT id FROM jewellery_old_gold WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, voucherId]);
    const row = await repo.one(db, `SELECT * FROM (${VOUCHERS_SQL}) w WHERE w.id=$2`, [business.id, voucherId]);
    if (!row) fail('Old gold voucher not found', 404);
    if (row.state === 'cancelled') fail(`Old gold ${row.voucher_no} is cancelled`, 409);
    if (held && c.paise(row.balance) <= 0) continue;
    if (c.paise(row.balance) <= 0) fail(`Old gold ${row.voucher_no} has nothing left on it`, 409);
    if (!held) {
      const order = await repo.one(db, `SELECT o.id,o.order_no FROM jewellery_order_advances a JOIN jewellery_orders o ON o.business_id=a.business_id AND o.id=a.order_id
        WHERE a.business_id=$1 AND a.old_gold_id=$2 AND o.status NOT IN ('delivered','cancelled')`, [business.id, row.id]);
      if (order && Number(order.id) !== Number(orderId)) fail(`Old gold ${row.voucher_no} is held for custom order ${order.order_no}: it pays that order's bill`, 409);
    }
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

module.exports = { TEST_METHODS, ID_KINDS, PAYOUT_KINDS, DECLARATION, CASH_LIMIT, NEXT_WORDS, preview, create, detail, view, payout, payoutMany, cancel, putBack, setNext,
  readRefs, linkNext, readForBill, vouchersFor, applyTo, recordUses, bell };
