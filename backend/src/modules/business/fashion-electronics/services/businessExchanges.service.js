const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const numbering = require('../../core/services/businessNumbering');
const vouchers = require('./businessVouchers.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');

// Exchanges: goods come back and replacements are sold in one step, in one
// transaction:
//   1. a return (credit note, CN/…) on the original sale — restocked or not,
//      exactly as any return;
//   2. a new sale (SI/…) for the replacements, priced by the server like any
//      sale (offers included), at the chosen location;
//   3. the credit the return created on the original sale (what was paid
//      there beyond what is now due) is moved to the new sale: a refund on
//      the original and a payment on the new bill, both with the method
//      'credit_note' — no cash moves for it;
//   4. the difference: the customer pays what the new bill still needs
//      (a walk-in pays it all now), or is refunded the credit left over
//      (needs sales.refund) — a known customer may leave it on account.
// If any step fails, nothing is saved. Default policy: within 30 days of the sale.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const cents = (value) => Math.round(Number(value) * 100);
const money = (paise) => (paise / 100).toFixed(2);
const MONEY_METHODS = ['cash', 'card', 'upi', 'bank'];
const DEFAULT_DAYS = 30;

// A request key for each part, derived from the exchange's own key, so a
// retried exchange can never post its parts twice.
const derivedKey = (key, part) => {
  const h = crypto.createHash('sha256').update(`${key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function policy(business) {
  await access.requireAny(business, ['exchanges.view', 'exchanges.create']);
  const row = await repo.one(repo.pool, 'SELECT days_allowed,updated_at FROM business_exchange_policies WHERE business_id=$1', [business.id]);
  return { daysAllowed: row ? row.days_allowed : DEFAULT_DAYS, updatedAt: row?.updated_at || null };
}
async function savePolicy(business, user, body) {
  await access.require(business, 'settings.edit');
  if (!business.modules.includes('exchanges')) await access.require(business, 'exchanges.view');
  const days = body.daysAllowed === null || body.daysAllowed === '' ? null : core.decimal(body.daysAllowed, 'Days allowed', 0, 1, 365);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `INSERT INTO business_exchange_policies(business_id,days_allowed,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(business_id) DO UPDATE SET days_allowed=EXCLUDED.days_allowed,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [business.id, days, user.id]);
    await repo.audit(db, business.id, user.id, 'exchange.policy_updated', null, { daysAllowed: days });
    return { daysAllowed: row.days_allowed, updatedAt: row.updated_at };
  });
}

function readInput(body, { quote }) {
  // No bill (a gift): the item is named instead, and the return goes on the
  // most recent sale of it within the policy (pro pass E-05).
  const noBill = body.noBill === true;
  const documentId = noBill ? null : id(body.documentId, 'Original sale');
  let returnSku = null;
  if (noBill) {
    if (!body.returnSku || typeof body.returnSku !== 'object') fail('Scan or choose the item coming back');
    returnSku = { skuId: id(body.returnSku.skuId, 'Item coming back'), quantity: core.decimal(body.returnSku.quantity ?? 1, 'Quantity coming back', 3, 0.001, 1000),
      restock: v.requiredBoolean(body.returnSku.restock, 'Back to stock', true) };
  }
  const returnLines = noBill ? [] : v.requiredArray(body.returnLines, 'Items coming back');
  if (!noBill && (!returnLines.length || returnLines.length > 100)) fail('Choose between 1 and 100 items coming back');
  const newLines = v.requiredArray(body.newLines, 'Items going out');
  if (!newLines.length || newLines.length > 100) fail('Add between 1 and 100 items going out');
  const reason = quote ? (v.optionalString(body.reason, 'Reason', 280) || 'Exchange') : v.requiredString(body.reason, 'Reason', 280);
  const locationId = body.locationId === undefined || body.locationId === null || body.locationId === '' ? null : id(body.locationId, 'Location');
  let settlement = null;
  if (!quote && body.settlement !== undefined && body.settlement !== null) {
    if (typeof body.settlement !== 'object' || Array.isArray(body.settlement)) fail('Settlement must be an object');
    settlement = {
      method: v.optionalEnum(body.settlement.method, 'How the difference is settled', [...MONEY_METHODS, 'on_account', 'voucher'], null),
      // One of the business's own payment methods, when money moves.
      methodId: body.settlement.methodId === undefined || body.settlement.methodId === null || body.settlement.methodId === '' ? null : id(body.settlement.methodId, 'Payment method'),
      amount: body.settlement.amount === undefined || body.settlement.amount === null || body.settlement.amount === '' ? null : core.decimal(body.settlement.amount, 'Amount', 2, 0),
      reference: v.optionalString(body.settlement.reference, 'Reference', 100),
      // A walk-in's name and phone, printed on a credit voucher.
      name: v.optionalString(body.settlement.name, 'Name', 150),
      phone: v.optionalString(body.settlement.phone, 'Phone', 30),
    };
  }
  return {
    documentId, reason, locationId, settlement, noBill, returnSku,
    returnLines: returnLines.map((l) => ({ lineId: id(l?.lineId, 'Line'), quantity: l.quantity, restock: v.requiredBoolean(l.restock, 'Back to stock', true),
      // Electronics: the unit is dead on arrival or faulty; it waits for the supplier (E-17).
      faulty: v.optionalEnum(l.faulty, 'Faulty', ['doa', 'faulty'], null) })),
    newLines: newLines.map((l) => {
      if (!l || typeof l !== 'object') fail('Each item going out needs an item and a quantity');
      return { skuId: l.skuId, quantity: l.quantity, ...(l.unit ? { unit: l.unit } : {}), ...(l.lotCode ? { lotCode: l.lotCode } : {}) };
    }),
  };
}

// Marker used to roll a quote back with its figures.
class Quote { constructor(result) { this.result = result; } }

async function run(db, business, user, given, { key, hash, quote }) {
  let input = given;
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  if (!quote) {
    const old = await repo.one(db, 'SELECT * FROM business_exchanges WHERE business_id=$1 AND request_key=$2', [business.id, key]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for a different exchange', 409);
      return { exchangeId: old.id, repeated: true };
    }
  }
  const rule = await repo.one(db, 'SELECT days_allowed FROM business_exchange_policies WHERE business_id=$1', [business.id]);
  const days = rule ? rule.days_allowed : DEFAULT_DAYS;
  if (input.noBill) {
    // Without the bill a manager decides (the refund permission), and the
    // goods go back on the latest sale of that item that can still take them.
    await access.require(business, 'sales.refund');
    const match = await repo.one(db, `SELECT l.id AS line_id,l.document_id FROM business_document_lines l
      JOIN business_documents d ON d.business_id=l.business_id AND d.id=l.document_id AND d.kind='sale'
      WHERE l.business_id=$1 AND l.sku_id=$2
        AND l.quantity - COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0) >= $3
        AND ($4::int IS NULL OR ((now() AT TIME ZONE $5)::date - (d.created_at AT TIME ZONE $5)::date) <= $4)
      ORDER BY d.created_at DESC,l.id DESC LIMIT 1`, [business.id, input.returnSku.skuId, input.returnSku.quantity, days, business.timezone]);
    if (!match) fail(`No sale of this item${days !== null ? ` in the last ${days} days` : ''} can take it back, so it cannot be exchanged without the bill.`, 409);
    input = { ...input, documentId: match.document_id, returnLines: [{ lineId: match.line_id, quantity: input.returnSku.quantity, restock: input.returnSku.restock, faulty: null }] };
  }
  const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, input.documentId]);
  if (!doc || doc.kind !== 'sale') fail('Sale not found', 404);
  const age = await repo.one(db, 'SELECT ((now() AT TIME ZONE $1)::date - ($2::timestamptz AT TIME ZONE $1)::date) AS days', [business.timezone, doc.created_at]);
  if (days !== null && age.days > days) fail(`${doc.document_no} was sold ${age.days} days ago; this business allows exchanges within ${days} ${days === 1 ? 'day' : 'days'} of the sale.`, 409);

  // 1. The credit note.
  const plainLines = input.returnLines.map(({ lineId, quantity, restock }) => ({ lineId, quantity, restock }));
  const returnBody = { reason: `Exchange: ${input.reason}`, lines: plainLines };
  const faultyLines = input.returnLines.filter((l) => l.faulty);
  if (faultyLines.length) {
    if (!business.modules.includes('serials')) fail('Faulty units are tracked by serial / IMEI; switch on Serial / IMEI numbers first');
    if (faultyLines.some((l) => !l.restock)) fail('A faulty unit comes back into stock so it can go back to the supplier: keep "Back to stock" ticked');
  }
  const credit = await returns.postReturn(db, business, user, doc, {
    reason: `${input.noBill ? 'No bill. ' : ''}${returnBody.reason}`.slice(0, 300), requestKey: quote ? crypto.randomUUID() : derivedKey(key, 'return'), hash: hashOf(returnBody), lines: plainLines,
  });
  // 2. The replacement sale, to the same customer.
  const saleBody = { kind: 'sale', locationId: input.locationId || doc.location_id, contactId: doc.contact_id, lines: input.newLines,
    notes: `Exchange for ${doc.document_no} · credit note ${credit.return_no}` };
  const sale = await core.postDocument(db, business, user, saleBody, {
    kind: 'sale', requestKey: quote ? crypto.randomUUID() : derivedKey(key, 'sale'), hash: hashOf(saleBody), lines: input.newLines, paidNow: null,
  });
  // 3. Credit on the original sale after the return, moved to the new bill.
  const sums = await repo.one(db, `SELECT
    COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
    COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
    COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded`, [business.id, doc.id]);
  const available = cents(sums.paid) - cents(sums.refunded) - (cents(doc.total) - cents(sums.returned));
  const newTotal = cents(sale.total);
  const applied = Math.max(0, Math.min(available, newTotal));
  const due = newTotal - applied;
  const excess = Math.max(0, available - applied);
  const figures = {
    originalNo: doc.document_no, returnNo: credit.return_no, newNo: sale.document_no,
    returnedValue: credit.total, newValue: sale.total, newSubtotal: sale.subtotal, newTax: sale.tax, newRoundOff: sale.round_off,
    // Positive: the customer pays; negative: the customer gets money back.
    difference: money(newTotal - cents(credit.total)),
    creditAvailable: money(Math.max(available, 0)), creditApplied: money(applied), due: money(due), excess: money(excess),
    walkIn: !doc.contact_id, daysAllowed: days, saleAgeDays: age.days, noBill: input.noBill, voucherDays: vouchers.VALID_DAYS,
  };
  if (quote) {
    const lines = await repo.all(db, 'SELECT sku_id,label,lot_code,quantity,unit,unit_price,net,tax FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, sale.id]);
    throw new Quote({ ...figures, newLines: lines });
  }
  if (applied > 0) {
    const moved = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by)
      VALUES($1,$2,$3,'credit_note',$4,$5,$6) RETURNING *`, [business.id, doc.id, money(applied),
      `Credit note ${credit.return_no} used on ${sale.document_no} (exchange)`.slice(0, 300), derivedKey(key, 'credit-out'), user.id]);
    await repo.audit(db, business.id, user.id, 'sale.refunded', moved.id, { documentId: doc.id, amount: moved.amount, method: 'credit_note' });
    await repo.event(db, business.id, user.id, 'sale.refunded', 'refund', moved.id, { documentId: doc.id, documentNo: doc.document_no, amount: moved.amount, method: 'credit_note' });
    await core.recordPayment(db, business, user, sale, { amount: money(applied), method: 'credit_note', reference: credit.return_no, key: derivedKey(key, 'credit-in') });
  }
  // 4. The difference.
  const settlement = input.settlement || {};
  let collected = 0, refunded = 0, method = null, creditCollection = null, voucherAmount = 0;
  // A settlement naming one of the business's methods takes its kind and name.
  const named = settlement.methodId && (due > 0 || excess > 0)
    ? await paymentMethods.settle(db, business.id, { methodId: settlement.methodId, method: settlement.method }, 'How the difference is settled', MONEY_METHODS) : null;
  const moneyMethod = named ? named.method : settlement.method;
  const methodName = named?.methodName ?? null;
  if (due > 0) {
    const amount = settlement.amount === null || settlement.amount === undefined ? due : cents(settlement.amount);
    if (amount > due) fail(`Only ${money(due)} is due on the new bill`);
    if (!doc.contact_id && amount !== due) fail(`A walk-in customer pays the whole difference now (${money(due)}).`);
    if (amount > 0) {
      if (!MONEY_METHODS.includes(moneyMethod)) fail('Choose how the customer pays the difference: cash, card, UPI or bank');
      await access.require(business, 'sales.edit');
      await core.recordPayment(db, business, user, sale, { amount: money(amount), method: moneyMethod, methodName, reference: settlement.reference || null, key: derivedKey(key, 'collect') });
      collected = amount; method = moneyMethod;
    }
  } else if (excess > 0) {
    if (settlement.method === 'voucher') {
      // Printed as a credit voucher once the exchange is saved (below).
      method = 'voucher'; voucherAmount = excess;
    } else if (input.noBill) {
      fail('Without the bill the credit is given as a credit voucher, not money: choose "Credit voucher"');
    } else if (settlement.method === 'on_account') {
      if (!doc.contact_id) fail('Only a known customer can keep the difference on their account');
      method = 'on_account';
      // The surplus leaves the original bill (a credit-note refund) and becomes
      // the customer's advance: an unallocated collection paid by credit note,
      // which a later bill can use (useCredit below, or receivables "apply advance").
      const out = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by)
        VALUES($1,$2,$3,'credit_note',$4,$5,$6) RETURNING *`, [business.id, doc.id, money(excess),
        `Credit note ${credit.return_no}: kept on the customer's account`.slice(0, 300), derivedKey(key, 'account-out'), user.id]);
      await repo.audit(db, business.id, user.id, 'sale.refunded', out.id, { documentId: doc.id, amount: out.amount, method: 'credit_note' });
      await repo.event(db, business.id, user.id, 'sale.refunded', 'refund', out.id, { documentId: doc.id, documentNo: doc.document_no, amount: out.amount, method: 'credit_note' });
      const number = await numbering.nextNumber(db, business.id, sale.location_id, 'collection', user.id);
      const contact = await repo.one(db, 'SELECT name FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, doc.contact_id]);
      creditCollection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,'credit_note',$8,$9,$10,$11,$12) RETURNING *`, [business.id, sale.location_id, number.number, number.seriesId, doc.contact_id, contact.name,
        money(excess), credit.return_no, `Exchange credit from ${doc.document_no}, kept on account`, derivedKey(key, 'account-in'), hashOf({ exchange: key }), user.id]);
      await repo.audit(db, business.id, user.id, 'collection.recorded', creditCollection.id, { amount: creditCollection.amount, method: 'credit_note', returnNo: credit.return_no });
      await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', creditCollection.id, {
        collectionNo: creditCollection.collection_no, contactId: doc.contact_id, amount: creditCollection.amount, method: 'credit_note' });
    } else {
      if (!MONEY_METHODS.includes(moneyMethod)) fail(`The customer gets ${money(excess)} back: choose cash, card, UPI or bank, a credit voucher${doc.contact_id ? ', or keep it on their account' : ''}`);
      await access.require(business, 'sales.refund');
      const back = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by,method_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, doc.id, money(excess), moneyMethod,
        `Difference refunded on exchange (${sale.document_no})`.slice(0, 300), derivedKey(key, 'refund'), user.id, methodName]);
      await repo.audit(db, business.id, user.id, 'sale.refunded', back.id, { documentId: doc.id, amount: back.amount, method: back.method });
      await repo.event(db, business.id, user.id, 'sale.refunded', 'refund', back.id, { documentId: doc.id, documentNo: doc.document_no, amount: back.amount, method: back.method });
      refunded = excess; method = moneyMethod;
    }
  }
  const exchange = await repo.one(db, `INSERT INTO business_exchanges(business_id,location_id,original_document_id,return_id,new_document_id,contact_id,
      returned_value,new_value,credit_applied,collected,refunded,method,reason,request_key,request_hash,created_by,credit_collection_id,no_bill)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
  [business.id, sale.location_id, doc.id, credit.id, sale.id, doc.contact_id, credit.total, sale.total, money(applied), money(collected), money(refunded),
    method, input.reason, key, hash, user.id, creditCollection?.id || null, input.noBill]);
  let voucher = null;
  if (voucherAmount > 0) {
    voucher = await vouchers.issue(db, business, user, { doc, amount: voucherAmount, locationId: sale.location_id, key: (part) => derivedKey(key, part),
      name: settlement.name, phone: settlement.phone, exchangeId: exchange.id });
  }
  if (faultyLines.length) await faultyUnits().fromExchange(db, business, user, { doc, sale, exchange, lines: faultyLines, reason: input.reason });
  await repo.audit(db, business.id, user.id, 'exchange.posted', exchange.id, { ...figures, collected: money(collected), refunded: money(refunded), method });
  await repo.event(db, business.id, user.id, 'exchange.posted', 'exchange', exchange.id, {
    originalDocumentId: doc.id, originalNo: doc.document_no, returnId: credit.id, returnNo: credit.return_no, newDocumentId: sale.id, newNo: sale.document_no,
    returnedValue: credit.total, newValue: sale.total, collected: money(collected), refunded: money(refunded), method,
  });
  return { exchangeId: exchange.id, voucherId: voucher?.id || null };
}
const faultyUnits = () => require('./businessElectronicsPro.service');

// The figures of an exchange without saving anything: the whole exchange is
// worked out in a transaction that is then rolled back.
async function quote(business, user, body) {
  await access.require(business, 'exchanges.create');
  const input = readInput(body, { quote: true });
  try {
    await repo.transaction((db) => run(db, business, user, input, { quote: true }));
  } catch (error) {
    if (error instanceof Quote) return error.result;
    throw error;
  }
  throw new Error('An exchange quote did not finish');
}

async function create(business, user, body) {
  await access.require(business, 'exchanges.create');
  const input = readInput(body, { quote: false });
  const key = core.uuid(body.requestKey);
  const result = await repo.transaction((db) => run(db, business, user, input, { key, hash: hashOf(body), quote: false }));
  return detail(business, result.exchangeId);
}

async function detail(business, exchangeId) {
  await access.require(business, 'exchanges.view');
  const exchange = await repo.one(repo.pool, `SELECT x.*,o.document_no AS original_no,o.created_at AS original_at,n.document_no AS new_no,r.return_no,
      c.name AS customer_name,c.phone AS customer_phone,l.name AS location_name,u.name AS created_by_name
    FROM business_exchanges x
    JOIN business_documents o ON o.business_id=x.business_id AND o.id=x.original_document_id
    JOIN business_documents n ON n.business_id=x.business_id AND n.id=x.new_document_id
    JOIN business_returns r ON r.business_id=x.business_id AND r.id=x.return_id
    JOIN business_locations l ON l.business_id=x.business_id AND l.id=x.location_id
    LEFT JOIN business_contacts c ON c.business_id=x.business_id AND c.id=x.contact_id
    JOIN users u ON u.id=x.created_by WHERE x.business_id=$1 AND x.id=$2`, [business.id, id(exchangeId, 'Exchange')]);
  if (!exchange) fail('Exchange not found', 404);
  const [back, out] = await Promise.all([
    repo.all(repo.pool, `SELECT rl.quantity,rl.net,rl.tax,rl.restock,dl.label,dl.lot_code,dl.unit,dl.sku_id FROM business_return_lines rl
      JOIN business_document_lines dl ON dl.business_id=rl.business_id AND dl.id=rl.line_id WHERE rl.business_id=$1 AND rl.return_id=$2 ORDER BY rl.id`, [business.id, exchange.return_id]),
    repo.all(repo.pool, 'SELECT sku_id,label,lot_code,unit,quantity,unit_price,net,tax FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, exchange.new_document_id]),
  ]);
  const voucher = await repo.one(repo.pool, 'SELECT id,voucher_no,amount,used,expires_on FROM business_exchange_vouchers WHERE business_id=$1 AND exchange_id=$2', [business.id, exchange.id]);
  return { ...exchange, returnedLines: back, newLines: out, voucher };
}

// Finding the sale to exchange against (pro pass E-05): scan the item
// coming back (barcode, SKU code or serial / IMEI) or type the customer's
// phone; sales still inside the exchange policy come first, newest first,
// with the matching lines that can still come back.
async function findSales(business, query) {
  await access.require(business, 'exchanges.create');
  const code = typeof query.code === 'string' && query.code.trim() ? query.code.trim().slice(0, 100) : null;
  const phone = typeof query.phone === 'string' ? query.phone.replace(/\D/g, '').slice(-10) : '';
  if (!code && phone.length < 6) fail('Scan the item coming back, or type at least 6 digits of the customer\'s phone');
  const rule = await repo.one(repo.pool, 'SELECT days_allowed FROM business_exchange_policies WHERE business_id=$1', [business.id]);
  const days = rule ? rule.days_allowed : DEFAULT_DAYS;
  const sku = code ? await repo.one(repo.pool, `SELECT s.id,s.label FROM catalog_skus s WHERE s.business_id=$1 AND (s.barcode=$2 OR upper(s.code)=upper($2))
    ORDER BY (s.barcode=$2) DESC LIMIT 1`, [business.id, code]) : null;
  const rows = await repo.all(repo.pool, `SELECT d.id,d.document_no,d.created_at,d.contact_id,d.contact_name,d.total,c.phone AS contact_phone,
      ((now() AT TIME ZONE $6)::date - (d.created_at AT TIME ZONE $6)::date) AS age_days,
      json_agg(json_build_object('lineId',l.id,'skuId',l.sku_id,'label',l.label,'lotCode',l.lot_code,'quantity',l.quantity,
        'returned',COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0)) ORDER BY l.id) AS lines
    FROM business_documents d JOIN business_document_lines l ON l.business_id=d.business_id AND l.document_id=d.id
    LEFT JOIN business_contacts c ON c.business_id=d.business_id AND c.id=d.contact_id
    WHERE d.business_id=$1 AND d.kind='sale'
      AND (($2::bigint IS NOT NULL AND l.sku_id=$2) OR ($3::text IS NOT NULL AND l.lot_code=$3)
        OR ($4::text <> '' AND right(regexp_replace(COALESCE(c.phone,''),'\\D','','g'),10)=$4))
      AND ($5::int IS NULL OR ((now() AT TIME ZONE $6)::date - (d.created_at AT TIME ZONE $6)::date) <= $5)
    GROUP BY d.id,c.phone ORDER BY d.created_at DESC LIMIT 20`, [business.id, sku?.id || null, code, phone.length >= 6 ? phone : '', days, business.timezone]);
  const items = rows.map((r) => ({ ...r, lines: r.lines.filter((l) => Number(l.quantity) > Number(l.returned)) })).filter((r) => r.lines.length);
  return { sku, daysAllowed: days, items };
}

// --- Exchange credit kept on account -------------------------------------------------

// Credit-note collections not yet used, and what a customer owes on open bills.
// Works whether or not the receivables module is on.
const freeSql = `k.amount - COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0)`;
const dueSql = (d) => `(${d}.total
    - COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
    - COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
    + COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;
async function credits(business) {
  await access.requireAny(business, ['exchanges.view', 'exchanges.create']);
  return repo.all(repo.pool, `SELECT c.id AS contact_id,c.name,c.phone,x.credit,x.notes,
      COALESCE((SELECT sum(GREATEST(0,${dueSql('d')})) FROM business_documents d WHERE d.business_id=c.business_id AND d.contact_id=c.id AND d.kind='sale'),0) AS owed
    FROM (SELECT k.contact_id,sum(${freeSql}) AS credit,json_agg(json_build_object('collectionNo',k.collection_no,'reference',k.reference,'free',${freeSql}) ORDER BY k.id) AS notes
      FROM business_collections k WHERE k.business_id=$1 AND k.method='credit_note' AND ${freeSql} > 0 GROUP BY k.contact_id) x
    JOIN business_contacts c ON c.business_id=$1 AND c.id=x.contact_id ORDER BY c.name`, [business.id]);
}

// Spends a customer's exchange credit on their unpaid bills, oldest first (or
// one named bill). Each use is a credit-note payment pointing at the credit's
// collection, so balances, statements and receivables all agree.
async function useCredit(business, user, contactId, body) {
  await access.require(business, 'exchanges.create');
  await access.require(business, 'sales.edit');
  const requestKey = core.uuid(body.requestKey);
  const documentId = body.documentId ? id(body.documentId, 'Bill') : null;
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    if (await repo.one(db, 'SELECT 1 FROM business_payments WHERE business_id=$1 AND request_key=$2', [business.id, derivedKey(requestKey, 'use-0')])) return { repeated: true };
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    const notes = await repo.all(db, `SELECT k.*,${freeSql} AS free FROM business_collections k
      WHERE k.business_id=$1 AND k.contact_id=$2 AND k.method='credit_note' AND ${freeSql} > 0 ORDER BY k.id`, [business.id, contact.id]);
    const bills = await repo.all(db, `SELECT d.*,${dueSql('d')} AS due FROM business_documents d
      WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale' AND ($3::bigint IS NULL OR d.id=$3) ORDER BY d.created_at,d.id`, [business.id, contact.id, documentId]);
    if (documentId && !bills.length) fail("That bill is not one of this customer's sales", 404);
    let n = 0, used = 0;
    const payments = [];
    for (const bill of bills) {
      let due = cents(bill.due);
      for (const note of notes) {
        const free = cents(note.free);
        if (due <= 0 || free <= 0) continue;
        const take = Math.min(due, free);
        payments.push(await core.recordPayment(db, business, user, bill, { amount: money(take), method: 'credit_note', reference: note.collection_no, key: derivedKey(requestKey, `use-${n}`), collectionId: note.id }));
        note.free = money(free - take); due -= take; used += take; n += 1;
      }
    }
    if (!payments.length) fail(notes.length ? `${contact.name} has no unpaid bill to use the credit on` : `${contact.name} has no exchange credit left`, 409);
    await repo.audit(db, business.id, user.id, 'collection.applied', contact.id, { applied: money(used), payments: payments.length, source: 'exchange_credit' });
    await repo.event(db, business.id, user.id, 'collection.applied', 'contact', contact.id, {
      applied: money(used), allocations: payments.map((p) => ({ documentId: p.document_id, collectionId: p.collection_id, amount: p.amount })) });
    return { applied: money(used), payments: payments.length };
  });
}

const lists = {
  exchanges: { sql: `SELECT x.*,o.document_no AS original_no,n.document_no AS new_no,r.return_no,c.name AS customer_name,l.name AS location_name,u.name AS created_by_name,
      (SELECT v.voucher_no FROM business_exchange_vouchers v WHERE v.business_id=x.business_id AND v.exchange_id=x.id) AS voucher_no,
      (x.new_value - x.returned_value) AS difference
    FROM business_exchanges x
    JOIN business_documents o ON o.business_id=x.business_id AND o.id=x.original_document_id
    JOIN business_documents n ON n.business_id=x.business_id AND n.id=x.new_document_id
    JOIN business_returns r ON r.business_id=x.business_id AND r.id=x.return_id
    JOIN business_locations l ON l.business_id=x.business_id AND l.id=x.location_id
    LEFT JOIN business_contacts c ON c.business_id=x.business_id AND c.id=x.contact_id
    JOIN users u ON u.id=x.created_by WHERE x.business_id=$1`,
  search: ['original_no', 'new_no', 'return_no', 'customer_name', 'reason'], date: 'created_at', filters: { location: 'location_id', contact: 'contact_id' }, order: 'id DESC' },
};

module.exports = { policy, savePolicy, quote, create, detail, credits, useCredit, findSales, lists };
