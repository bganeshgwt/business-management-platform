const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const c = require('./jewelleryCommon');
const rates = require('./jewelleryRates.service');
const accounts = require('./jewelleryAccounts');
const pieces = require('./jewelleryPieces.service');

// The metal account with suppliers (module "jewellery"): a bullion dealer or
// wholesaler gives the shop metal on a metal balance, or takes metal from it
// (old gold or scrap against what is owed: metal for metal). Each is a metal
// voucher (MV/2627/0001) in grams of a purity, with its fine weight at the
// purity's fineness; the metal comes into or goes out of the shop's own metal
// at the location. What the shop owes a supplier is kept in grams of each
// purity, beside the money the core keeps. Fixing the rate (bhav cut) turns
// grams owed into money owed, in full or in part: a purchase from the
// supplier of the grams at the rate per gram, at 3% GST, booked under the
// metal's own item (kept in grams in these books, so the purchase takes no
// stock). Money is for those who see purchases. Money is integer paise in
// this file.

const { fail, id } = c;
const KIND_WORDS = { received: 'Received', given: 'Given', fixed: 'Rate fixed (bhav cut)' };

const ENTRIES_SQL = `SELECT e.id,e.voucher_no,e.location_id,l.name AS location_name,e.contact_id,ct.name AS supplier_name,e.kind,e.metal,e.purity,e.net_weight,e.fine_weight,
    e.rate,e.amount,e.document_id,d.document_no,e.description,e.notes,e.created_at,u.name AS by_name
  FROM jewellery_supplier_metal e JOIN business_contacts ct ON ct.business_id=e.business_id AND ct.id=e.contact_id
  JOIN business_locations l ON l.business_id=e.business_id AND l.id=e.location_id JOIN users u ON u.id=e.created_by
  LEFT JOIN business_documents d ON d.business_id=e.business_id AND d.id=e.document_id WHERE e.business_id=$1`;
repo.addLists({
  'jewellery-metal-account': { sql: ENTRIES_SQL, search: ['voucher_no', 'supplier_name', 'document_no', 'description'], date: 'created_at',
    filters: { supplier: 'contact_id', kind: 'kind', metal: 'metal', purity: 'purity', location: 'location_id' }, order: 'id DESC' },
});

// What the shop owes each supplier of each purity (negative: the supplier owes it), in grams and fine grams.
async function balancesOf(db, business, contactId = null) {
  return repo.all(db, `SELECT e.contact_id,ct.name AS supplier_name,e.metal,e.purity,
      sum(CASE WHEN e.kind='received' THEN e.net_weight ELSE -e.net_weight END) AS owed,
      sum(CASE WHEN e.kind='received' THEN e.fine_weight ELSE -e.fine_weight END) AS owed_fine,
      COALESCE(sum(e.net_weight) FILTER (WHERE e.kind='received'),0) AS received,COALESCE(sum(e.net_weight) FILTER (WHERE e.kind='given'),0) AS given,
      COALESCE(sum(e.net_weight) FILTER (WHERE e.kind='fixed'),0) AS fixed,COALESCE(sum(e.amount) FILTER (WHERE e.kind='fixed'),0) AS fixed_amount
    FROM jewellery_supplier_metal e JOIN business_contacts ct ON ct.business_id=e.business_id AND ct.id=e.contact_id
    WHERE e.business_id=$1 AND ($2::bigint IS NULL OR e.contact_id=$2) GROUP BY e.contact_id,ct.name,e.metal,e.purity ORDER BY ct.name,e.metal,e.purity`, [business.id, contactId]);
}

const shapeBalance = (r) => ({ ...r, mark: c.purityMark(r.metal, r.purity), label: c.purityWords(r.metal, r.purity), owed: Number(r.owed).toFixed(3), owed_fine: Number(r.owed_fine).toFixed(3) });

async function account(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await access.require(business, 'purchasing.view');
  const rows = (await balancesOf(repo.pool, business)).map(shapeBalance);
  const suppliers = [...new Set(rows.map((r) => Number(r.contact_id)))];
  const money = suppliers.length ? await repo.all(repo.pool, `SELECT c.id,${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=ANY($2::bigint[])`,
    [business.id, suppliers]) : [];
  return { items: suppliers.map((contactId) => ({ contactId, name: rows.find((r) => Number(r.contact_id) === contactId).supplier_name,
    balances: rows.filter((r) => Number(r.contact_id) === contactId), owedMoney: Number(money.find((m) => Number(m.id) === contactId)?.balance || 0).toFixed(2) })) };
}

async function supplierAccount(business, contactId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await access.require(business, 'purchasing.view');
  const supplier = await repo.one(repo.pool, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, id(contactId, 'Supplier')]);
  if (!supplier) fail('Supplier not found', 404);
  const [balances, entries, money] = await Promise.all([
    balancesOf(repo.pool, business, supplier.id),
    repo.all(repo.pool, `${ENTRIES_SQL} AND e.contact_id=$2 ORDER BY e.id DESC LIMIT 200`, [business.id, supplier.id]),
    repo.one(repo.pool, `SELECT ${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, supplier.id]),
  ]);
  return { supplier: { id: supplier.id, name: supplier.name, gstin: supplier.gstin, phone: supplier.phone }, balances: balances.map(shapeBalance),
    entries: entries.map((e) => ({ ...e, kind_words: KIND_WORDS[e.kind], mark: c.purityMark(e.metal, e.purity) })), owedMoney: Number(money.balance).toFixed(2) };
}

// body: { requestKey, kind (received, given), contactId, locationId, metal, purity, netWeight, description?, notes? }
async function move(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.edit');
  await access.require(business, 'purchasing.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const kind = v.requiredEnum(body.kind, 'Received or given', ['received', 'given']);
  const { metal, purity } = c.readPurity(body.metal, body.purity);
  const netWeight = c.readWeight(body.netWeight, 'Weight (g)');
  const description = pieces.plainWords(c.optionalText(body.description, 'What it is', 150), 'What it is');
  const notes = c.optionalText(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,contact_id,request_hash FROM jewellery_supplier_metal WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return supplierAccountIn(db, business, old.contact_id);
    }
    const supplier = await c.contactRow(db, business, body.contactId, 'supplier', 'Supplier');
    const location = await c.locationRow(db, business, body.locationId);
    const netMg = c.mg(netWeight);
    const fineMg = c.fineMg(netMg, c.purityOf(metal, purity).fineness);
    if (kind === 'given') {
      const held = await repo.one(db, `SELECT COALESCE(sum(net_weight),0) AS net,COALESCE(sum(fine_weight),0) AS fine FROM jewellery_metal_movements
        WHERE business_id=$1 AND location_id=$2 AND metal=$3 AND purity=$4`, [business.id, location.id, metal, purity]);
      if (netMg > c.mg(held.net) || fineMg > c.mg(held.fine)) {
        fail(`${location.name} holds ${c.grams(c.mg(held.net))} g of ${c.purityWords(metal, purity)} (${c.grams(c.mg(held.fine))} g fine): ${c.grams(netMg)} g cannot go out`, 409);
      }
    }
    const number = await numbering.nextNumber(db, business.id, location.id, 'metal_voucher', user.id);
    const row = await repo.one(db, `INSERT INTO jewellery_supplier_metal(business_id,location_id,voucher_no,series_id,contact_id,kind,metal,purity,net_weight,fine_weight,description,notes,
        request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [business.id, location.id, number.number, number.seriesId, supplier.id, kind, metal, purity, c.grams(netMg), c.grams(fineMg), description, notes, requestKey, hash, user.id]);
    const sign = kind === 'received' ? '' : '-';
    await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,supplier_entry_id,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [business.id, location.id, metal, purity, `${sign}${c.grams(netMg)}`, `${sign}${c.grams(fineMg)}`,
      kind === 'received' ? 'supplier_in' : 'supplier_out', row.id, `${kind === 'received' ? 'From' : 'To'} ${supplier.name} on ${number.number}`.slice(0, 300), user.id]);
    const figures = { voucherNo: number.number, supplier: supplier.name, kind, purity: c.purityWords(metal, purity), netWeight: c.grams(netMg), fineWeight: c.grams(fineMg) };
    await repo.audit(db, business.id, user.id, `jewellery_metal.${kind}`, row.id, figures);
    await repo.event(db, business.id, user.id, `jewellery_metal.${kind}`, 'jewellery_supplier_metal', row.id, { ...figures, contactId: supplier.id, locationId: location.id });
    return supplierAccountIn(db, business, supplier.id);
  });
}

async function supplierAccountIn(db, business, contactId) {
  const [balances, entries] = await c.inTurn(() => balancesOf(db, business, contactId),
    () => repo.all(db, `${ENTRIES_SQL} AND e.contact_id=$2 ORDER BY e.id DESC LIMIT 200`, [business.id, contactId]));
  const supplier = await repo.one(db, 'SELECT id,name,gstin,phone FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, contactId]);
  const money = await repo.one(db, `SELECT ${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, contactId]);
  return { supplier, balances: balances.map(shapeBalance), entries: entries.map((e) => ({ ...e, kind_words: KIND_WORDS[e.kind], mark: c.purityMark(e.metal, e.purity) })),
    owedMoney: Number(money.balance).toFixed(2) };
}

// body: { requestKey, contactId, locationId, metal, purity, netWeight? (all that is owed when left out), rate? (the day's selling rate when left out), supplierBillNo?, supplierBillDate?, notes? }
async function fix(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await access.require(business, 'purchasing.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const { metal, purity } = c.readPurity(body.metal, body.purity);
  const typedWeight = c.given(body.netWeight) ? c.readWeight(body.netWeight, 'Grams fixed') : null;
  const typedRate = c.given(body.rate) ? c.readRate(body.rate, 'Rate per gram') : null;
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,contact_id,request_hash FROM jewellery_supplier_metal WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return supplierAccountIn(db, business, old.contact_id);
    }
    const supplier = await c.contactRow(db, business, body.contactId, 'supplier', 'Supplier');
    const location = await c.locationRow(db, business, body.locationId);
    const owed = c.mg((await repo.one(db, `SELECT COALESCE(sum(CASE WHEN kind='received' THEN net_weight ELSE -net_weight END),0) AS owed FROM jewellery_supplier_metal
      WHERE business_id=$1 AND contact_id=$2 AND metal=$3 AND purity=$4`, [business.id, supplier.id, metal, purity])).owed);
    if (owed <= 0) fail(`The shop owes ${supplier.name} no ${c.purityWords(metal, purity)}`, 409);
    const netMg = typedWeight === null ? owed : c.mg(typedWeight);
    if (netMg > owed) fail(`The shop owes ${supplier.name} only ${c.grams(owed)} g of ${c.purityWords(metal, purity)}: no more is fixed`, 409);
    let rate = typedRate;
    if (rate === null) {
      const now = await rates.ratesNow(db, business);
      const today = now.byPurity.get(`${metal}:${purity}`);
      if (!today) fail(`${c.purityWords(metal, purity)} has no rate today: type the rate per gram the supplier fixes`, 409);
      rate = Number(today.sell_rate);
    }
    const amount = c.roundedDivide(BigInt(netMg) * BigInt(c.paise(rate)), 1000);
    const tax = c.roundedDivide(BigInt(amount) * 300n, 10000);
    const sku = await accounts.accountItem(db, business, user, metal);
    const quantity = c.grams(netMg);
    const lines = [{ skuId: sku.id, quantity }];
    const fixed = [{ price: rate, net: amount, tax, taxRate: '3.00', priceRuleId: null, enteredPrice: null,
      label: `${c.purityWords(metal, purity)}: ${quantity} g at ₹${rate.toFixed(2)} a gram (bhav cut)`.slice(0, 150) }];
    const documentBody = { kind: 'purchase', locationId: location.id, contactId: supplier.id, lines, supplierBillNo: c.given(body.supplierBillNo) ? body.supplierBillNo : undefined,
      supplierBillDate: c.given(body.supplierBillDate) ? body.supplierBillDate : undefined,
      notes: [`Rate fixed on the metal account: ${quantity} g of ${c.purityWords(metal, purity)}`, c.optionalText(body.notes, 'Notes', 300)].filter(Boolean).join(' · ').slice(0, 500) };
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'purchase', requestKey: c.derivedKey(requestKey, 'purchase'), hash: c.hashOf(documentBody),
      lines, paidNow: null, fixed, noStock: true });
    const row = await repo.one(db, `INSERT INTO jewellery_supplier_metal(business_id,location_id,contact_id,kind,metal,purity,net_weight,fine_weight,rate,amount,document_id,notes,
        request_key,request_hash,created_by) VALUES($1,$2,$3,'fixed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [business.id, location.id, supplier.id, metal, purity, quantity, c.grams(c.fineMg(netMg, c.purityOf(metal, purity).fineness)), rate.toFixed(2), c.rupees(amount), document.id,
      c.optionalText(body.notes, 'Notes', 300), requestKey, hash, user.id]);
    const figures = { supplier: supplier.name, purity: c.purityWords(metal, purity), netWeight: quantity, rate: rate.toFixed(2), amount: c.rupees(amount), documentNo: document.document_no,
      full: netMg === owed, owedLeft: c.grams(owed - netMg) };
    await repo.audit(db, business.id, user.id, 'jewellery_metal.fixed', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_metal.fixed', 'jewellery_supplier_metal', row.id, { ...figures, contactId: supplier.id, documentId: document.id });
    return supplierAccountIn(db, business, supplier.id);
  });
}

module.exports = { KIND_WORDS, account, supplierAccount, move, fix };
