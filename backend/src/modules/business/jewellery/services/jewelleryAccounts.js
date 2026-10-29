const repo = require('../../core/repositories/business.repository');
const c = require('./jewelleryCommon');

// The catalogue items the jeweller's own purchases are booked under, made the
// first time each is needed, inside the posting that needs it:
//   labour       karigar labour (job work, SAC 9988), a service bought: the
//                labour invoice's lines, at 5% (1.5% for diamond work, none
//                from a karigar not registered for GST)
//   hallmarking  the hallmarking centre's charges (testing, SAC 998346), a
//                service bought, at the rate of the centre's bill
//   gold, silver, platinum  metal fixed to money on a supplier's metal account
//                (bhav cut), at 3%: goods counted in grams, but kept in the
//                jeweller's own books of metal, so the purchase takes no stock;
//                and the shop's metal sold to a bullion dealer from a refinery
//                challan (sold the same way, without stock)
// None of them is ever sold at the counter: the core refuses them on any sale
// but the one its own service posts (checkLooseSale).
// And the items a gold scheme closed on its day 364 is billed as: gold, silver
// or platinum set aside from the shop's metal as a piece held in the
// customer's safekeeping (a jewellery item of its own, at 3%, its pieces
// tagged only by the close).

const { fail } = c;
const PURPOSES = {
  labour: { name: 'Karigar labour (job work)', code: 'JWL-LABOUR', kind: 'service', unit: 'service', tracking: 'none', rate: 5, hsn: '9988' },
  hallmarking: { name: 'Hallmarking charges', code: 'JWL-HALLMARK', kind: 'service', unit: 'service', tracking: 'none', rate: 18, hsn: '998346' },
  gold: { name: 'Gold on the metal account', code: 'JWL-GOLD', kind: 'goods', unit: 'g', tracking: 'quantity', rate: 3, hsn: '7108' },
  silver: { name: 'Silver on the metal account', code: 'JWL-SILVER', kind: 'goods', unit: 'g', tracking: 'quantity', rate: 3, hsn: '7106' },
  platinum: { name: 'Platinum on the metal account', code: 'JWL-PLATINUM', kind: 'goods', unit: 'g', tracking: 'quantity', rate: 3, hsn: '7110' },
  gold_safekeeping: { name: 'Gold held for gold schemes', code: 'JWL-SAFE-GOLD', kind: 'goods', unit: 'each', tracking: 'serial', rate: 3, hsn: '7108',
    piece: { metal: 'gold', purity: '24K' } },
  silver_safekeeping: { name: 'Silver held for gold schemes', code: 'JWL-SAFE-SILVER', kind: 'goods', unit: 'each', tracking: 'serial', rate: 3, hsn: '7106',
    piece: { metal: 'silver', purity: '999' } },
  platinum_safekeeping: { name: 'Platinum held for gold schemes', code: 'JWL-SAFE-PLATINUM', kind: 'goods', unit: 'each', tracking: 'serial', rate: 3, hsn: '7110',
    piece: { metal: 'platinum', purity: '950' } },
};

// The item for a purpose, inside the caller's transaction (the business is locked).
async function accountItem(db, business, user, purpose) {
  const found = await repo.one(db, `SELECT s.* FROM jewellery_account_items a JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
    WHERE a.business_id=$1 AND a.purpose=$2`, [business.id, purpose]);
  if (found) return found;
  const spec = PURPOSES[purpose];
  const slab = await repo.one(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND rate=$2 AND active ORDER BY is_default DESC,id LIMIT 1',
    [business.id, spec.rate]);
  if (!slab) fail(`This business has no ${spec.rate}% GST slab for ${spec.name.toLowerCase()}: add one under Settings › Tax rates first`, 409);
  // A code no item has: JWL-LABOUR, else JWL-LABOUR-2, -3 …
  const taken = new Set((await repo.all(db, 'SELECT code FROM catalog_skus WHERE business_id=$1 AND code LIKE $2', [business.id, `${spec.code}%`])).map((r) => r.code));
  let code = spec.code;
  for (let n = 2; taken.has(code); n += 1) code = `${spec.code}-${n}`;
  const product = await repo.one(db, 'INSERT INTO catalog_products(business_id,name,kind) VALUES($1,$2,$3) RETURNING id', [business.id, spec.name, spec.kind]);
  const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,label,unit,price,tax_rate,tax_rate_id,tracking,hsn_code)
    VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9) RETURNING *`, [business.id, product.id, code, spec.name, spec.unit, slab.rate, slab.id, spec.tracking, spec.hsn]);
  await db.query('INSERT INTO jewellery_account_items(business_id,purpose,sku_id,created_by) VALUES($1,$2,$3,$4)', [business.id, purpose, sku.id, user.id]);
  // A safekeeping item's pieces are tagged on it: it is a jewellery item of its metal, with no wastage or making.
  if (spec.piece) {
    await db.query(`INSERT INTO jewellery_items(business_id,sku_id,metal,purity,wastage_percent,making_mode,making_value,created_by,updated_by)
      VALUES($1,$2,$3,$4,0,'flat',0,$5,$5)`, [business.id, sku.id, spec.piece.metal, spec.piece.purity, user.id]);
  }
  await repo.audit(db, business.id, user.id, 'catalog.created', sku.id, { label: spec.name, code, purpose: `Jewellery: ${purpose}` });
  return sku;
}

module.exports = { PURPOSES, accountItem };
