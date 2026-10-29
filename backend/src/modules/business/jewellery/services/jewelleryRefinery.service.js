const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const c = require('./jewelleryCommon');
const accounts = require('./jewelleryAccounts');
const oldGold = require('./jewelleryOldGold.service');

// Refinery challans (module "jewellery"): the shop's metal (melted pieces, old
// gold, scrap) sent out on a numbered challan (RF/2627/0001), purity by
// purity, out of what the location holds: to a refiner (one of the shop's
// suppliers), who gives it back refined, the metal and fineness it comes back
// at into the shop's metal and the fine metal lost shown against what went;
// or to a bullion dealer who buys it (the buyer, one of the shop's customers),
// sold on a sale bill at a rate per gram of the fine metal sent, with 3% GST
// (the metal kept in the jeweller's own books, so the bill takes no stock). A
// challan may name the lines of old gold it carries: each line's metal then
// "went to a refiner or dealer" on it. The refiner's own charges are a
// purchase from them, booked as any other. Money is integer paise and weight
// integer milligrams in this file.

const { fail, id } = c;
const MAX_LINES = 30;
const PARTY_WORDS = { refiner: 'Refiner', dealer: 'Bullion dealer' };
const OUTCOME_WORDS = { out: 'With them', back: 'Refined and back', sold: 'Sold' };

const CHALLANS_SQL = `SELECT r.id,r.challan_no,r.location_id,l.name AS location_name,r.party,r.contact_id,ct.name AS party_name,ct.gstin AS party_gstin,r.notes,r.created_at,
    u.name AS by_name,r.outcome,r.closed_at,cu.name AS closed_by_name,r.back_metal,r.back_purity,r.back_net_weight,r.back_fineness,r.back_fine_weight,r.sale_rate,
    r.document_id,d.document_no,d.total AS sale_total,
    (SELECT min(x.metal) FROM jewellery_refinery_lines x WHERE x.business_id=r.business_id AND x.challan_id=r.id) AS metal,
    (SELECT sum(x.net_weight) FROM jewellery_refinery_lines x WHERE x.business_id=r.business_id AND x.challan_id=r.id) AS net_weight,
    (SELECT sum(x.fine_weight) FROM jewellery_refinery_lines x WHERE x.business_id=r.business_id AND x.challan_id=r.id) AS fine_weight
  FROM jewellery_refinery_challans r JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
  JOIN business_contacts ct ON ct.business_id=r.business_id AND ct.id=r.contact_id JOIN users u ON u.id=r.created_by LEFT JOIN users cu ON cu.id=r.closed_by
  LEFT JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id WHERE r.business_id=$1`;
repo.addLists({
  // Every challan, newest first: what went, to whom, and what became of it.
  'jewellery-refinery': { sql: CHALLANS_SQL, search: ['challan_no', 'party_name', 'document_no'], date: 'created_at',
    filters: { outcome: 'outcome', party: 'party', location: 'location_id' }, order: 'id DESC' },
});

const shape = (row) => ({ ...row, party_words: PARTY_WORDS[row.party], outcome_words: OUTCOME_WORDS[row.outcome],
  loss_fine: row.outcome === 'back' ? (Number(row.fine_weight) - Number(row.back_fine_weight)).toFixed(3) : null,
  back_mark: row.back_metal ? c.purityMark(row.back_metal, row.back_purity) : null });

async function view(db, business, challanId) {
  const row = await repo.one(db, `${CHALLANS_SQL} AND r.id=$2`, [business.id, challanId]);
  if (!row) fail('Refinery challan not found', 404);
  const [lines, carried] = await c.inTurn(
    () => repo.all(db, 'SELECT * FROM jewellery_refinery_lines WHERE business_id=$1 AND challan_id=$2 ORDER BY seq', [business.id, row.id]),
    () => repo.all(db, `SELECT n.old_gold_id,g.voucher_no,n.seq,ol.description,ol.metal,ol.purity,ol.net_weight,ol.fine_weight FROM jewellery_old_gold_next n
      JOIN jewellery_old_gold g ON g.business_id=n.business_id AND g.id=n.old_gold_id
      JOIN jewellery_old_gold_lines ol ON ol.business_id=n.business_id AND ol.old_gold_id=n.old_gold_id AND ol.seq=n.seq
      WHERE n.business_id=$1 AND n.refinery_id=$2 ORDER BY g.voucher_no,n.seq`, [business.id, row.id]));
  const party = await repo.one(db, 'SELECT phone,address,gstin,pan FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, row.contact_id]);
  return { ...shape(row), party_phone: party?.phone || null, party_address: party?.address || null, party_pan: party?.pan || null,
    lines: lines.map((l) => ({ ...l, mark: c.purityMark(l.metal, l.purity), label: c.purityWords(l.metal, l.purity) })),
    old_gold: carried.map((x) => ({ ...x, mark: c.purityMark(x.metal, x.purity) })) };
}

async function detail(business, challanId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  const row = await view(repo.pool, business, id(challanId, 'Refinery challan'));
  access.requireLocation(business, row.location_id);
  return row;
}

// body: { requestKey, locationId, party ('refiner' | 'dealer'), contactId | contact: { name, phone?, gstin?, pan? } (a new supplier or customer),
//   lines: [{ metal, purity, netWeight, fineness? }] (one metal), oldGold?: [{ voucherId, seq }], notes? }
async function send(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const party = v.requiredEnum(body.party, 'Sent to', ['refiner', 'dealer']);
  const kind = party === 'refiner' ? 'supplier' : 'customer';
  const typed = body.contact && typeof body.contact === 'object' && !Array.isArray(body.contact) && c.given(body.contact.name)
    ? { kind, name: body.contact.name, phone: body.contact.phone, gstin: body.contact.gstin, pan: body.contact.pan } : null;
  if (c.given(body.contactId) && typed) fail('Choose who it goes to or type them in, not both');
  if (!c.given(body.contactId) && !typed) fail(party === 'refiner' ? 'Choose the refiner (a supplier), or add them' : 'Choose the bullion dealer who buys it (a customer), or add them');
  if (typed) await access.require(business, 'contacts.create');
  const list = v.requiredArray(body.lines, 'Metal sent');
  if (!list.length) fail('Add the metal sent, purity by purity');
  if (list.length > MAX_LINES) fail(`A challan takes at most ${MAX_LINES} lines`);
  const lines = list.map((raw, index) => {
    const n = `Line ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${n} must be an object`);
    const { metal, purity } = c.readPurity(raw.metal, raw.purity, `${n}: purity`);
    const netWeight = c.readWeight(raw.netWeight, `${n}: weight (g)`);
    return { seq: index + 1, metal, purity, netWeight, fineness: c.readFineness(raw.fineness, metal, purity, `${n}: fineness`) };
  });
  if (new Set(lines.map((l) => l.metal)).size > 1) fail('A challan sends one metal: send gold and silver on challans of their own');
  const refs = oldGold.readRefs(body.oldGold);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_refinery_challans WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await c.locationRow(db, business, body.locationId);
    const contact = typed ? await core.createContact(business, user, typed, db) : await c.contactRow(db, business, body.contactId, kind, party === 'refiner' ? 'Refiner' : 'Dealer');
    // What goes out of what the location holds of each purity.
    const byPurity = new Map();
    for (const l of lines) byPurity.set(`${l.metal}:${l.purity}`, [...(byPurity.get(`${l.metal}:${l.purity}`) || []), l]);
    for (const [key, group] of byPurity) {
      const [metal, purity] = key.split(':');
      const held = await repo.one(db, `SELECT COALESCE(sum(net_weight),0) AS net,COALESCE(sum(fine_weight),0) AS fine FROM jewellery_metal_movements
        WHERE business_id=$1 AND location_id=$2 AND metal=$3 AND purity=$4`, [business.id, location.id, metal, purity]);
      const wanted = group.reduce((s, x) => s + c.mg(x.netWeight), 0);
      const wantedFine = group.reduce((s, x) => s + c.fineMg(c.mg(x.netWeight), x.fineness), 0);
      if (wanted > c.mg(held.net) || wantedFine > c.mg(held.fine)) {
        fail(`${location.name} holds ${c.grams(c.mg(held.net))} g of ${c.purityWords(metal, purity)} (${c.grams(c.mg(held.fine))} g fine): ${c.grams(wanted)} g cannot go out`, 409);
      }
    }
    const number = await numbering.nextNumber(db, business.id, location.id, 'refinery_challan', user.id);
    const row = await repo.one(db, `INSERT INTO jewellery_refinery_challans(business_id,location_id,challan_no,series_id,party,contact_id,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [business.id, location.id, number.number, number.seriesId, party, contact.id, notes, requestKey, hash, user.id]);
    for (const l of lines) {
      const fine = c.grams(c.fineMg(c.mg(l.netWeight), l.fineness));
      await db.query(`INSERT INTO jewellery_refinery_lines(business_id,challan_id,seq,metal,purity,net_weight,fineness,fine_weight) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [business.id, row.id, l.seq, l.metal, l.purity, l.netWeight.toFixed(3), Number(l.fineness).toFixed(1), fine]);
      await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,refinery_id,refinery_seq,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,'refinery_out',$7,$8,$9,$10)`, [business.id, location.id, l.metal, l.purity, `-${l.netWeight.toFixed(3)}`, `-${fine}`, row.id, l.seq,
        `To ${contact.name} on ${number.number}`.slice(0, 300), user.id]);
    }
    const linked = await oldGold.linkNext(db, business, user, refs, { next: 'refinery', refineryId: row.id, locationId: location.id, purities: new Set(byPurity.keys()) });
    const figures = { challanNo: number.number, party, to: contact.name, lines: lines.map((l) => ({ purity: c.purityWords(l.metal, l.purity), netWeight: l.netWeight.toFixed(3),
      fineness: Number(l.fineness).toFixed(1), fineWeight: c.grams(c.fineMg(c.mg(l.netWeight), l.fineness)) })), ...(linked.length ? { oldGold: linked } : {}) };
    await repo.audit(db, business.id, user.id, 'jewellery_refinery.sent', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_refinery.sent', 'jewellery_refinery_challan', row.id, { ...figures, contactId: contact.id, locationId: location.id });
    return view(db, business, row.id);
  });
}

// Locks an open challan for its close (the business row is locked first); a retry of the same close is answered by the challan.
async function lockOpen(db, business, challanId, closeKey, closeHash) {
  const row = await repo.one(db, 'SELECT id,location_id,outcome,close_key,close_hash FROM jewellery_refinery_challans WHERE business_id=$1 AND id=$2 FOR UPDATE',
    [business.id, id(challanId, 'Refinery challan')]);
  if (!row) fail('Refinery challan not found', 404);
  access.requireLocation(business, row.location_id);
  if (row.close_key) {
    if (row.close_key !== closeKey || row.close_hash !== closeHash) fail(`This challan was closed already: ${OUTCOME_WORDS[row.outcome].toLowerCase()}`, 409);
    return { done: true, challan: await view(db, business, row.id) };
  }
  return { done: false, challan: await view(db, business, row.id) };
}

// body: { requestKey, purity (of the metal sent: the refined metal's), netWeight, fineness? (assayed; the purity's when left out) }.
// The refined metal back from the refiner into the shop's metal; what was lost is the fine metal sent less the fine metal back.
async function back(business, user, challanId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const { done, challan } = await lockOpen(db, business, challanId, requestKey, hash);
    if (done) return challan;
    if (challan.party !== 'refiner') fail(`Challan ${challan.challan_no} went to a bullion dealer: its metal is sold, not given back`, 409);
    if (challan.outcome !== 'out') fail(`Challan ${challan.challan_no} is closed: ${OUTCOME_WORDS[challan.outcome].toLowerCase()}`, 409);
    const { metal, purity } = c.readPurity(body.metal ?? challan.metal, body.purity, 'Refined metal\'s purity');
    if (metal !== challan.metal) fail(`Challan ${challan.challan_no} sent ${c.METAL_WORDS[challan.metal].toLowerCase()}: it comes back as it`, 409);
    const netWeight = c.readWeight(body.netWeight, 'Weight back (g)');
    const fineness = c.readFineness(body.fineness, metal, purity, 'Fineness assayed');
    const fine = c.fineMg(c.mg(netWeight), fineness);
    if (fine > c.mg(challan.fine_weight)) fail(`More fine metal comes back (${c.grams(fine)} g) than went (${c.grams(c.mg(challan.fine_weight))} g): check the weight and fineness`, 409);
    await db.query(`UPDATE jewellery_refinery_challans SET outcome='back',closed_by=$3,closed_at=now(),close_key=$4,close_hash=$5,back_metal=$6,back_purity=$7,back_net_weight=$8,
      back_fineness=$9,back_fine_weight=$10 WHERE business_id=$1 AND id=$2`, [business.id, challan.id, user.id, requestKey, hash, metal, purity, netWeight.toFixed(3),
      Number(fineness).toFixed(1), c.grams(fine)]);
    await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,refinery_id,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'refinery_back',$7,$8,$9)`, [business.id, challan.location_id, metal, purity, netWeight.toFixed(3), c.grams(fine), challan.id,
      `Refined, back from ${challan.party_name} on ${challan.challan_no}`.slice(0, 300), user.id]);
    const figures = { challanNo: challan.challan_no, refiner: challan.party_name, sentFine: Number(challan.fine_weight).toFixed(3), back: c.purityWords(metal, purity),
      netWeight: netWeight.toFixed(3), fineness: Number(fineness).toFixed(1), fineWeight: c.grams(fine), lossFine: c.grams(c.mg(challan.fine_weight) - fine) };
    await repo.audit(db, business.id, user.id, 'jewellery_refinery.back', challan.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_refinery.back', 'jewellery_refinery_challan', challan.id, { ...figures, contactId: challan.contact_id,
      locationId: challan.location_id });
    return view(db, business, challan.id);
  });
}

// body: { requestKey, rate (per gram of the fine metal sent), payment? | payments? (what the dealer pays now), buyer?: { pan?, panDeclaration? }, notes? }.
// The metal sold to the bullion dealer: a sale bill to them of the fine metal at the rate, with 3% GST, taking no stock.
async function sell(business, user, challanId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await access.require(business, 'sales.create');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const rate = c.readRate(body.rate, 'Rate per gram of fine metal');
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const { done, challan } = await lockOpen(db, business, challanId, requestKey, hash);
    if (done) return challan;
    if (challan.party !== 'dealer') fail(`Challan ${challan.challan_no} went to a refiner: its metal comes back refined`, 409);
    if (challan.outcome !== 'out') fail(`Challan ${challan.challan_no} is closed: ${OUTCOME_WORDS[challan.outcome].toLowerCase()}`, 409);
    const fineMg = c.mg(challan.fine_weight);
    const amount = c.roundedDivide(BigInt(fineMg) * BigInt(c.paise(rate)), 1000);
    const tax = core.lineTax(amount, 3);
    const sku = await accounts.accountItem(db, business, user, challan.metal);
    const quantity = c.grams(fineMg);
    const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
    const inclusive = settings?.tax_mode === 'inclusive';
    const lines = [{ skuId: sku.id, quantity }];
    const fixed = [{ price: (amount + (inclusive ? tax : 0)) / 100 / (fineMg / 1000), net: amount, tax, taxRate: '3.00', priceRuleId: null, enteredPrice: null,
      label: `${c.METAL_WORDS[challan.metal]} sold: ${quantity} g fine at ₹${rate.toFixed(2)} a gram (challan ${challan.challan_no})`.slice(0, 150) }];
    const documentBody = { kind: 'sale', locationId: challan.location_id, contactId: challan.contact_id, lines,
      notes: [`Metal sold on refinery challan ${challan.challan_no}`, c.optionalText(body.notes, 'Notes', 300)].filter(Boolean).join(' · ').slice(0, 500),
      buyer: { pan: buyer.pan, panDeclaration: buyer.panDeclaration } };
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'sale'), hash: c.hashOf(documentBody),
      lines, paidNow: parts, fixed, jewellery: true, noStock: true });
    await db.query(`UPDATE jewellery_refinery_challans SET outcome='sold',closed_by=$3,closed_at=now(),close_key=$4,close_hash=$5,sale_rate=$6,document_id=$7
      WHERE business_id=$1 AND id=$2`, [business.id, challan.id, user.id, requestKey, hash, rate.toFixed(2), document.id]);
    const figures = { challanNo: challan.challan_no, dealer: challan.party_name, fineWeight: quantity, rate: rate.toFixed(2), amount: c.rupees(amount), tax: c.rupees(tax),
      documentNo: document.document_no, total: document.total };
    await repo.audit(db, business.id, user.id, 'jewellery_refinery.sold', challan.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_refinery.sold', 'jewellery_refinery_challan', challan.id, { ...figures, documentId: document.id,
      contactId: challan.contact_id, locationId: challan.location_id });
    return view(db, business, challan.id);
  });
}

module.exports = { PARTY_WORDS, OUTCOME_WORDS, detail, send, back, sell };
