const repo = require('../../core/repositories/business.repository');
const maths = require('./freeGoodsMaths');

// Free goods on a return of a dispatched order's invoice (a scheme's free
// goods, or free goods given by hand: their own order lines, free of a paid
// line). The owner's rule: free goods the customer keeps come off the credit.
//
//   On a return of paid goods that came with free goods, the free goods that
//   belong to the paid goods returned are worked out in proportion (free ×
//   paid returned ÷ paid bought, in the free goods' unit to the thousandth, the
//   core's precision). The return may take them back: they are the invoice's
//   free lines, returned like any line (back into stock, at no value, in the
//   unit's own steps). What belongs and is not taken back is kept, and charged: at one unit's value before GST (the paid
//   lines' own value per unit for free goods of the same item, the order's
//   price of the free item for another item), with GST at the paid line's
//   rate, off the credit note, as a line of its own (Free goods kept).
//   Free goods brought back after being kept give that back. Never more is
//   kept than belongs to the paid goods returned so far, and nothing is
//   charged or given back twice: the database checks both
//   (wholesale_free_goods_kept_check).
// Called by the core's returns (businessReturns.postReturn) inside the
// return's transaction, the invoice locked. Quantities in thousandths, money
// in paise.

const milli = (value) => Math.round(Number(value) * 1000);
const paise = (value) => Math.round(Number(value) * 100);
const qty = (m) => (m / 1000).toFixed(3);
const rupees = (p) => (p / 100).toFixed(2);
const plain = (m) => String(Number((Math.abs(m) / 1000).toFixed(3)));
const amount = (value) => Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

// The invoice's paid order lines that came with free goods: each with its
// lines (quantity, value, what came back), and each free order line with its
// lines, what came back of them and what was kept before (summed over earlier
// returns). [] for an invoice that is no dispatch or has no free goods.
async function groupsOf(db, businessId, documentId) {
  const lines = await repo.all(db, `SELECT bl.id,bl.sku_id,bl.label,bl.unit,bl.quantity,bl.net,bl.tax_rate,x.id AS order_line_id,x.free_of_line_id,x.list_unit_price,
      u.decimals AS unit_decimals,d.tax_mode,
      COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=bl.business_id AND rl.line_id=bl.id),0) AS returned
    FROM wholesale_dispatches w
    JOIN business_documents d ON d.business_id=w.business_id AND d.id=w.document_id
    JOIN wholesale_dispatch_lines dl ON dl.business_id=w.business_id AND dl.dispatch_id=w.id
    JOIN business_document_lines bl ON bl.business_id=dl.business_id AND bl.id=dl.document_line_id
    JOIN wholesale_order_lines x ON x.business_id=dl.business_id AND x.id=dl.order_line_id
    LEFT JOIN business_units u ON u.business_id=bl.business_id AND u.code=bl.unit
    WHERE w.business_id=$1 AND w.document_id=$2 ORDER BY bl.id`, [businessId, documentId]);
  if (!lines.some((l) => l.free_of_line_id)) return [];
  const kept = await repo.all(db, `SELECT free_line_id,sum(quantity) AS quantity,sum(net) AS net,sum(tax) AS tax FROM wholesale_free_goods_kept
    WHERE business_id=$1 AND document_id=$2 GROUP BY free_line_id`, [businessId, documentId]);
  const inclusive = lines[0].tax_mode === 'inclusive';
  const of = (orderLineId) => lines.filter((l) => String(l.order_line_id) === String(orderLineId));
  const total = (list, key, read) => list.reduce((sum, l) => sum + read(l[key]), 0);
  const groups = [];
  for (const orderLineId of new Set(lines.filter((l) => !l.free_of_line_id).map((l) => String(l.order_line_id)))) {
    const paid = of(orderLineId);
    const freeIds = [...new Set(lines.filter((l) => String(l.free_of_line_id) === orderLineId).map((l) => String(l.order_line_id)))];
    if (!freeIds.length) continue;
    const paidMilli = total(paid, 'quantity', milli);
    const paidNet = total(paid, 'net', paise);
    const free = freeIds.map((freeId) => {
      const its = of(freeId);
      const before = kept.find((k) => String(k.free_line_id) === freeId);
      // The same item as the paid goods: what a unit of them cost; another item: its price on the order.
      const sameItem = String(its[0].sku_id) === String(paid[0].sku_id);
      const price = sameItem ? { net: paidNet, milli: paidMilli } : maths.listPrice(its[0].list_unit_price, inclusive, paise(its[0].tax_rate));
      return { orderLineId: freeId, skuId: its[0].sku_id, label: its[0].label, unit: its[0].unit, decimals: its[0].unit_decimals ?? 3, sameItem, price,
        lines: its.map((l) => ({ id: l.id, quantityMilli: milli(l.quantity), backMilli: milli(l.returned) })),
        freeMilli: total(its, 'quantity', milli), backMilli: total(its, 'returned', milli),
        kept: { quantity: milli(before?.quantity || 0), net: paise(before?.net || 0), tax: paise(before?.tax || 0) } };
    });
    groups.push({ orderLineId, label: paid[0].label, unit: paid[0].unit, rate: Number(paid[0].tax_rate), rateBasis: paise(paid[0].tax_rate),
      lines: paid.map((l) => ({ id: l.id, quantityMilli: milli(l.quantity), backMilli: milli(l.returned) })),
      paidMilli, paidNet, paidBackMilli: total(paid, 'returned', milli), free });
  }
  return groups;
}

// What one return changes in the free goods kept on its invoice, from the
// core's prepared return lines ({ line, quantity }): { charges, charged,
// earlier }: each change of a free line's kept goods, what they take off this
// credit note (paise, with GST; less than nothing gives back), and what the
// invoice's earlier credit notes took off. null when the invoice has none.
async function forReturn(db, business, doc, prepared) {
  const groups = await groupsOf(db, business.id, doc.id);
  if (!groups.length) return null;
  const now = new Map(prepared.map((p) => [String(p.line.id), milli(p.quantity)]));
  const backNow = (list) => list.reduce((sum, l) => sum + (now.get(String(l.id)) || 0), 0);
  const charges = [];
  let earlier = 0;
  for (const group of groups) {
    const paidNow = backNow(group.lines);
    for (const free of group.free) {
      earlier += free.kept.net + free.kept.tax;
      const freeNow = backNow(free.lines);
      if (!paidNow && !freeNow) continue;
      const belongs = maths.belongs(free.freeMilli, group.paidBackMilli + paidNow, group.paidMilli);
      const keptNow = maths.keptOf(belongs, free.backMilli + freeNow);
      const delta = maths.change(free.kept, keptNow, free.price, group.rateBasis);
      if (delta.quantity === 0) continue;
      charges.push({ group, free, ...delta, belongs, keptNow });
    }
  }
  return { charges, charged: charges.reduce((sum, c) => sum + c.net + c.tax, 0), earlier };
}

// A kept row in words, as the credit note shows it.
const wordsOf = (row) => `${Number(row.quantity) > 0 ? 'Free goods kept' : 'Free goods brought back'}: ${plain(milli(row.quantity))} × ₹${amount(row.unit_value)}`;
const shape = (row) => ({ return_id: row.return_id, free_line_id: row.free_line_id, order_line_id: row.order_line_id, label: row.label, unit: row.unit, quantity: row.quantity,
  unit_value: row.unit_value, net: row.net, tax: row.tax, tax_rate: row.tax_rate, words: wordsOf(row) });

// The charges of a return saved (its lines are in, so the database's own
// check sees them): returns them as the credit note shows them.
async function record(db, business, saved, doc, charges) {
  const rows = [];
  for (const c of charges) {
    const row = await repo.one(db, `INSERT INTO wholesale_free_goods_kept(business_id,return_id,document_id,order_line_id,free_line_id,quantity,unit_value,net,tax,tax_rate)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [business.id, saved.id, doc.id, c.group.orderLineId, c.free.orderLineId, qty(c.quantity),
      maths.unitValue(c.free.price).toFixed(4), rupees(c.net), rupees(c.tax), c.group.rate.toFixed(2)]);
    rows.push(shape({ ...row, label: c.free.label, unit: c.free.unit }));
  }
  return rows;
}

// For the invoice's screen: each paid line's free goods (to take back with a
// return), and what each credit note charged or gave back for free goods kept.
async function extras(db, businessId, documentId) {
  const groups = await groupsOf(db, businessId, documentId);
  if (!groups.length) return { free_goods: [], kept: [] };
  const kept = await repo.all(db, `SELECT k.*,s.label,s.unit FROM wholesale_free_goods_kept k
    JOIN wholesale_order_lines x ON x.business_id=k.business_id AND x.id=k.free_line_id
    JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
    WHERE k.business_id=$1 AND k.document_id=$2 ORDER BY k.id`, [businessId, documentId]);
  return {
    free_goods: groups.map((g) => ({
      paid_line_ids: g.lines.map((l) => l.id), label: g.label, unit: g.unit, tax_rate: g.rate.toFixed(2), paid_quantity: qty(g.paidMilli), paid_returned: qty(g.paidBackMilli),
      free: g.free.map((f) => ({ order_line_id: f.orderLineId, label: f.label, unit: f.unit, unit_decimals: f.decimals, same_item: f.sameItem,
        lines: f.lines.map((l) => ({ id: l.id, quantity: qty(l.quantityMilli), returned: qty(l.backMilli) })), quantity: qty(f.freeMilli), returned: qty(f.backMilli),
        kept: qty(f.kept.quantity), unit_value: maths.unitValue(f.price).toFixed(4) })),
    })),
    kept: kept.map(shape),
  };
}

module.exports = { groupsOf, forReturn, record, extras, wordsOf };
