const repo = require('../repositories/business.repository');

// Selling price of one sale or order line, worked out on the server.
//
// Without the wholesale module a line sells at the item's list price. With
// it, price rules (business_price_rules) may lower the price:
//   1. a rule for this customer beats a rule for all customers;
//   2. a rule set for the pack the line is entered in ("5 cases or more:
//      Rs 2,050 a case") beats a per-unit rule;
//   3. within those, the highest slab the line reaches wins, and it prices
//      every unit on the line.
// A pack rule's minimum counts packs; a per-unit rule's minimum counts stock
// units. Amounts are integer paise; quantities integer thousandths.
//
// Without a rule, the list price is the branch's own price for the item
// (business_sku_location_prices) or the item's price; a loyalty customer
// pays the member price instead when it is lower.

const paise = (number) => Math.round(Number(number) * 100);
const milli = (number) => Math.round(Number(number) * 1000);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);

// sku: the catalogue row (price, unit). quantity: stock units. entered:
// { unit, quantity, factorMicro } when the line was typed in another unit.
// Returns { rule, net (paise), stockPrice (rupees, up to 4 places),
// enteredPrice (paise per entered unit, or null), priceKind ('list' |
// 'branch' | 'member' | 'rule') }. where: { locationId, member } — the
// selling location, and whether the customer gets member prices.
async function salePrice(db, business, sku, contactId, quantity, entered, where = {}) {
  let rule = null;
  if (business.capabilities.includes('wholesale')) {
    rule = await repo.one(db, `SELECT * FROM business_price_rules WHERE business_id=$1 AND sku_id=$2 AND active
      AND (contact_id IS NULL OR contact_id=$3)
      AND ((unit_code IS NULL AND minimum_quantity<=$4) OR (unit_code IS NOT NULL AND unit_code=$5 AND minimum_quantity<=$6))
      ORDER BY (contact_id IS NOT NULL) DESC,(unit_code IS NOT NULL) DESC,minimum_quantity DESC LIMIT 1`,
    [business.id, sku.id, contactId || null, quantity, entered?.unit || null, entered?.quantity ?? 0]);
  }
  if (rule?.unit_code && entered) {
    // Priced per pack: the pack price is exact; the stock-unit price follows.
    const enteredPrice = paise(rule.unit_price);
    const net = roundedDivide(BigInt(enteredPrice) * BigInt(milli(entered.quantity)), 1000n);
    const stockPrice = Number(((enteredPrice / 100) / (entered.factorMicro / 1e6)).toFixed(4));
    return { rule, net, stockPrice, enteredPrice, priceKind: 'rule' };
  }
  let price = Number(sku.price), priceKind = 'list';
  if (rule) { price = Number(rule.unit_price); priceKind = 'rule'; }
  else {
    if (where.locationId) {
      const branch = await repo.one(db, 'SELECT price FROM business_sku_location_prices WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [business.id, sku.id, where.locationId]);
      if (branch) { price = Number(branch.price); priceKind = 'branch'; }
    }
    if (where.member && sku.member_price !== null && sku.member_price !== undefined && Number(sku.member_price) < price) { price = Number(sku.member_price); priceKind = 'member'; }
  }
  const net = roundedDivide(BigInt(paise(price)) * BigInt(milli(quantity)), 1000n);
  const enteredPrice = entered ? roundedDivide(BigInt(paise(price)) * BigInt(entered.factorMicro), 1000000n) : null;
  return { rule, net, stockPrice: price, enteredPrice, priceKind };
}

module.exports = { salePrice };
