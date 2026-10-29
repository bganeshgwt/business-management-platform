// What a company scheme's purchases earn. Nothing here reads the database.
//
// A scheme counts the units bought of its items in its dates. Each benefit
// is reached at a quantity; of each kind, the highest reached counts:
//   per_unit    a rebate on every unit bought (quantity slabs: the slab
//               reached sets the rate for all of them)
//   target      an amount, once the quantity is reached
//   free_goods  units of an item, once the quantity is reached
//   gift        a gift, once the quantity is reached
// Money is integer paise; quantities are thousandths of a unit.

const KINDS = ['per_unit', 'target', 'free_goods', 'gift'];

// benefits: [{ kind, minQuantity (thousandths), rate (paise a unit), amount (paise), freeSkuId, freeQuantity (thousandths), gift }]
// quantity: thousandths of a unit bought.
// Returns { reached: { per_unit?, target?, free_goods?, gift? } (the benefit counted of each kind),
//   rebate (paise: per-unit rebate on every unit), targetAmount (paise), money (paise: the two),
//   freeGoods ({ freeSkuId, quantity } | null), gift (text | null),
//   next: [{ kind, minQuantity, short (thousandths still to buy) }] (the next tier of each kind) }
function earned(benefits, quantity) {
  const reached = {};
  const next = [];
  for (const kind of KINDS) {
    const tiers = benefits.filter((b) => b.kind === kind).sort((a, b) => a.minQuantity - b.minQuantity);
    const got = tiers.filter((b) => b.minQuantity <= quantity).at(-1);
    if (got) reached[kind] = got;
    const ahead = tiers.find((b) => b.minQuantity > quantity);
    if (ahead) next.push({ kind, minQuantity: ahead.minQuantity, short: ahead.minQuantity - quantity });
  }
  // The rebate on every unit: thousandths × paise a unit / 1000, half up.
  const rebate = reached.per_unit ? Number((BigInt(quantity) * BigInt(reached.per_unit.rate) * 2n + 1000n) / 2000n) : 0;
  const targetAmount = reached.target ? reached.target.amount : 0;
  return {
    reached, rebate, targetAmount, money: rebate + targetAmount,
    freeGoods: reached.free_goods ? { freeSkuId: reached.free_goods.freeSkuId, quantity: reached.free_goods.freeQuantity } : null,
    gift: reached.gift ? reached.gift.gift : null,
    next,
  };
}

// What is still due once the claims received are set against what was earned:
// money (paise) and free goods (thousandths); a gift earned and not received.
// claims: [{ kind, amount (paise) | null, quantity | null, received (bool), receivedAmount (paise), receivedQuantity }]
function due(result, claims) {
  const sum = (list, key) => list.reduce((total, c) => total + (c[key] || 0), 0);
  const money = claims.filter((c) => c.kind === 'money');
  const goods = claims.filter((c) => c.kind === 'free_goods');
  const gifts = claims.filter((c) => c.kind === 'gift');
  return {
    money: {
      earned: result.money, claimed: sum(money, 'amount'), received: sum(money.filter((c) => c.received), 'receivedAmount'),
      awaited: sum(money.filter((c) => !c.received), 'amount'),
      due: result.money - sum(money.filter((c) => c.received), 'receivedAmount'),
      unclaimed: Math.max(0, result.money - sum(money, 'amount')),
    },
    freeGoods: {
      earned: result.freeGoods ? result.freeGoods.quantity : 0, claimed: sum(goods, 'quantity'), received: sum(goods.filter((c) => c.received), 'receivedQuantity'),
      due: (result.freeGoods ? result.freeGoods.quantity : 0) - sum(goods.filter((c) => c.received), 'receivedQuantity'),
    },
    gift: { earned: result.gift, claimed: gifts.length > 0, received: gifts.some((c) => c.received) },
  };
}

module.exports = { KINDS, earned, due };
