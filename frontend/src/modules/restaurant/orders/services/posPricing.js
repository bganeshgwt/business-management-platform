// Unsaved dishes in the POS cart follow the prices of the place the order
// will be charged, as the server will charge them.
//
// A dish rung up before the table was picked took the till's own prices;
// with "All outlets" selected, a table's order is charged at the table's
// outlet, whose happy hour may differ (chai ₹40 at the counter, ₹60 on the
// rooftop). A happy hour can also start or end while the cart is open. So
// whenever the price list changes, every line not yet saved is priced again:
// the happy-hour price for that dish and size when one runs there, else the
// menu price it was added at (menuPrice, the dish's price plus the size's
// difference). Add-ons stay on top, as the server charges them. A saved
// line keeps the price it was rung up at, exactly as the bill does.
//
// Kept free of React so the rule can be tested on its own.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const keyOf = (productId, variantId) => `${productId}:${variantId || ""}`;

// The cart unchanged (the same array) when no price moved, so nothing
// re-renders and no draft is written for nothing.
export const repriceCart = (cart, offers) => {
  let changed = false;

  const next = cart.map((line) => {
    // A line from before menuPrice was kept (a draft restored from an older
    // screen) keeps the price it has.
    if (line.saved || line.menuPrice === undefined || line.menuPrice === null) {
      return line;
    }

    const offer = offers ? offers.get(keyOf(line.productId, line.productVariantId)) : null;
    const unitPrice = offer ? round2(offer.price) : round2(line.menuPrice);
    const priceWindowName = offer ? offer.windowName || null : null;
    const packagingCharge=Number(offer?.packagingCharge||0);
    const oldPackaging=Number((line.modifiers||[]).find(m=>m.id===null&&m.name==='Packaging')?.price||0);
    const modifiers=(line.modifiers||[]).filter(m=>!(m.id===null&&m.name==='Packaging'));
    if(packagingCharge>0)modifiers.push({id:null,name:'Packaging',price:packagingCharge});
    const modifierTotal=round2(modifiers.reduce((sum,m)=>sum+Number(m.price),0));

    if (packagingCharge===oldPackaging && unitPrice === Number(line.unitPrice) && priceWindowName === (line.priceWindowName || null)) {
      return line;
    }

    changed = true;
    return { ...line, unitPrice, priceWindowName, modifiers, modifierTotal };
  });

  return changed ? next : cart;
};
