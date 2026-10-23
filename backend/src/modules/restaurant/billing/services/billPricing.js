// What a bill comes to, worked out once, in whole paise, the way it is printed.
//
// Pure: no database. bill.service feeds it the lines being billed and the
// adjustments the till asked for, and stores exactly what it returns, so the
// screen, the paper and the GST return all read the same figures.
//
// The order of work, which is also the order of the lines on the paper:
//
//   dishes before tax (their amounts add up to the subtotal)
//   - a till discount on single dishes          (% or amount, each dish)
//   - the coupon                                 (on what the dishes now cost)
//   - a till discount on the whole bill          (% or amount, on what is left)
//   - points redeemed                            (on what is left)
//   + service charge                             (a % of the dishes after discount)
//   + delivery charge                            (own delivery: a trip charge, never
//                                                 discounted)
//   + CGST and SGST, rate by rate                (on the dishes AND their share of
//                                                 the service charge and of the
//                                                 delivery charge: both are part
//                                                 of the value of what is supplied)
//   + cess, where the dish's rate carries one
//   + round off to the rupee
//   = total
//
// Every discount on the bill is shared across its dishes in proportion to
// what each still costs, and the service charge in proportion to what each
// costs after discount, so each dish knows its own taxable value and GST can
// be worked out per rate exactly. CGST + SGST is always exactly the GST (an
// odd paisa goes to CGST), and every part adds up to the whole.
//
// Discounts come off the value before tax, in both tax modes: that is what
// the coupon always did, and GST then falls with them. In "inclusive" mode a
// dish's pre-tax value is its price with the tax taken out.
const { toPaise, fromPaise, percentOf, apportion, splitGst, round2 } = require("../../../../utils/money");

// A discount on an amount (paise): a percentage, or a fixed amount no bigger
// than what it comes off.
const discountOn = (paise, discount) => {
  if (!discount || !(Number(discount.value) > 0) || paise <= 0) {
    return 0;
  }

  return discount.type === "percentage"
    ? Math.min(percentOf(paise, discount.value), paise)
    : Math.min(toPaise(discount.value), paise);
};

// A line as it is billed, before any bill discount: the value before tax, the
// GST on it and the cess on it. An inclusive price with cess has both taxes
// taken out of it; the order only took the GST out, because it did not know
// about cess.
const lineBeforeDiscount = (line) => {
  const rate = Number(line.taxPercentage || 0);
  const cess = Number(line.cessPercentage || 0);

  if (line.inclusive && cess > 0) {
    const gross = toPaise(line.lineTotal);
    const net = Math.round(gross / (1 + (rate + cess) / 100));
    const gst = percentOf(net, rate);

    return { net, gst, cess: gross - net - gst, gross };
  }

  const net = toPaise(line.lineSubtotal);
  const gst = toPaise(line.lineTax);
  const cessPaise = percentOf(net, cess);

  return { net, gst, cess: cessPaise, gross: line.inclusive ? toPaise(line.lineTotal) : net + gst + cessPaise };
};

// A coupon that applies to chosen dishes only, or a buy-X-get-Y offer, as
// paise off each line (`afterItems`: what each line costs after its own till
// discount). Lines the coupon does not cover get 0.
//
//   chosen dishes   a % (or an amount, capped at what those dishes cost) off
//                   the eligible lines, shared over them by what each costs;
//   buy X get Y     every eligible unit, dearest first; of each X + Y units the
//                   cheapest Y are discounted by `percent` (100: free). The
//                   cheapest units on the bill are the ones given away, which
//                   is how every restaurant reads "buy 2 get 1".
//
// The coupon's most-off (maxDiscountAmount) caps the whole, shared back over
// the lines in proportion.
const couponOnLines = (coupon, lines, afterItems) => {
  const eligible = lines.map((line) => !coupon.lineIds || coupon.lineIds.has(Number(line.orderItemId)));
  let parts = lines.map(() => 0);

  if (coupon.buyGet) {
    const { buy, get, percent } = coupon.buyGet;
    const units = [];

    lines.forEach((line, index) => {
      const quantity = Math.floor(Number(line.quantity) + 1e-9);

      if (!eligible[index] || quantity <= 0 || afterItems[index] <= 0) {
        return;
      }

      // The line's own units at what each costs after its till discount (an
      // odd paisa goes to the first).
      apportion(afterItems[index], Array.from({ length: quantity }, () => 1)).forEach((price) =>
        units.push({ index, price })
      );
    });

    units.sort((a, b) => b.price - a.price || a.index - b.index);
    const free = Math.floor(units.length / (buy + get)) * get;

    for (const unit of units.slice(units.length - free)) {
      parts[unit.index] += percentOf(unit.price, percent);
    }
  } else {
    const weights = afterItems.map((value, index) => (eligible[index] ? value : 0));
    const base = weights.reduce((sum, value) => sum + value, 0);
    const off = Math.min(
      coupon.discountType === "percentage" ? percentOf(base, coupon.value) : toPaise(coupon.value),
      base
    );

    parts = base > 0 ? apportion(off, weights) : parts;
  }

  const total = parts.reduce((sum, value) => sum + value, 0);
  const most = coupon.maxDiscountAmount;

  if (most !== null && most !== undefined && total > toPaise(most)) {
    parts = apportion(toPaise(most), parts);
  }

  return parts;
};

//   lines            [{ orderItemId, quantity, lineSubtotal, lineTax, lineTotal,
//                       taxPercentage, cessPercentage, inclusive, hsnCode }]
//                    — rupees, for the quantity on this bill
//   itemDiscounts    Map orderItemId -> { type, value }
//   coupon           { discountType, value, maxDiscountAmount, lineIds?, buyGet? }
//                    or null (already checked). lineIds (a Set of orderItemIds):
//                    only those lines count and are discounted. buyGet
//                    { buy, get, percent } (couponOnLines).
//   manualDiscount   { type, value } or null
//   loyalty          { points, pointValue } or null
//   serviceChargePercentage   0 when none is charged (order type, waived)
//   deliveryCharge   rupees before GST; 0 when none (not own delivery, waived)
//   complimentary    true: every dish at 100% off, nothing charged
const priceBill = ({
  lines,
  itemDiscounts = new Map(),
  coupon = null,
  manualDiscount = null,
  loyalty = null,
  serviceChargePercentage = 0,
  deliveryCharge = 0,
  complimentary = false,
}) => {
  const base = lines.map(lineBeforeDiscount);
  const nets = base.map((line) => line.net);
  const subtotal = nets.reduce((sum, value) => sum + value, 0);

  // Till discounts on single dishes.
  const itemDisc = lines.map((line, index) =>
    complimentary ? 0 : discountOn(nets[index], itemDiscounts.get(Number(line.orderItemId)))
  );
  const afterItems = nets.map((net, index) => net - itemDisc[index]);
  const afterItemsTotal = afterItems.reduce((sum, value) => sum + value, 0);

  let couponPaise = 0;
  let manualPaise = 0;
  let loyaltyPaise = 0;
  let pointsUsed = 0;
  // A coupon on chosen dishes (or buy X get Y) is worked out line by line and
  // stays on those lines; any other coupon is one figure shared over the bill.
  const lineCoupon =
    !complimentary && coupon && (coupon.lineIds || coupon.buyGet) ? couponOnLines(coupon, lines, afterItems) : null;

  if (complimentary) {
    // One discount of everything, on no particular dish.
  } else {
    if (lineCoupon) {
      couponPaise = lineCoupon.reduce((sum, value) => sum + value, 0);
    } else if (coupon) {
      couponPaise =
        coupon.discountType === "percentage"
          ? percentOf(afterItemsTotal, coupon.value)
          : toPaise(coupon.value);

      if (coupon.maxDiscountAmount !== null && coupon.maxDiscountAmount !== undefined) {
        couponPaise = Math.min(couponPaise, toPaise(coupon.maxDiscountAmount));
      }

      couponPaise = Math.min(couponPaise, afterItemsTotal);
    }

    manualPaise = discountOn(afterItemsTotal - couponPaise, manualDiscount);

    if (loyalty && loyalty.points > 0) {
      const pointValue = toPaise(loyalty.pointValue);
      const left = afterItemsTotal - couponPaise - manualPaise;

      loyaltyPaise = Math.min(loyalty.points * pointValue, Math.max(0, left));
      pointsUsed = pointValue > 0 ? Math.round(loyaltyPaise / pointValue) : 0;
    }
  }

  const billDiscount = complimentary ? afterItemsTotal : couponPaise + manualPaise + loyaltyPaise;
  let shared;

  if (lineCoupon) {
    // The coupon stays on its own lines; a till discount and points are
    // shared over what each line costs after it.
    const afterCoupon = afterItems.map((value, index) => value - lineCoupon[index]);
    const rest = apportion(manualPaise + loyaltyPaise, afterCoupon);
    shared = lineCoupon.map((value, index) => value + rest[index]);
  } else {
    shared = apportion(billDiscount, afterItems);
  }

  const food = afterItems.map((value, index) => value - shared[index]);
  const foodTotal = food.reduce((sum, value) => sum + value, 0);

  const scPercent = complimentary ? 0 : Number(serviceChargePercentage || 0);
  const serviceCharge = scPercent > 0 ? percentOf(foodTotal, scPercent) : 0;
  const scShare = apportion(serviceCharge, food);

  // The delivery charge is part of a composite supply of food, so all of it
  // is taxed at the rate of the PRINCIPAL supply: the bill's largest dish
  // (by its value before tax; the first of equals), the same rule the order
  // uses for its estimate (deliveryCharge.repository). Within that rate it is
  // shared over that rate's dishes by what each costs after discount, so a
  // dish returned gives back its share. The GST pack, the HSN summary, the
  // day book and the P&L read these rows (bill_taxes.delivery_charge_taxable),
  // so they all agree with the bill to the paisa.
  const delivery = complimentary ? 0 : Math.max(0, toPaise(deliveryCharge));
  let dcShare = lines.map(() => 0);

  if (delivery > 0 && lines.length > 0) {
    const principal = nets.reduce((best, value, index) => (value > nets[best] ? index : best), 0);
    const sameRate = (index) =>
      Number(lines[index].taxPercentage || 0) === Number(lines[principal].taxPercentage || 0) &&
      Number(lines[index].cessPercentage || 0) === Number(lines[principal].cessPercentage || 0);
    const weights = lines.map((line, index) => (sameRate(index) ? food[index] : 0));
    const anyFood = weights.some((value) => value > 0);

    dcShare = apportion(delivery, anyFood ? weights : lines.map((line, index) => (index === principal ? 1 : 0)));
  }

  // Rate by rate: GST and cess on the dishes after discount plus their share
  // of the service charge, then shared back onto each dish exactly.
  const buckets = new Map();

  lines.forEach((line, index) => {
    const rate = Number(line.taxPercentage || 0);
    const cess = Number(line.cessPercentage || 0);
    const key = `${rate}|${cess}`;

    if (!buckets.has(key)) {
      buckets.set(key, { rate, cess, food: 0, sc: 0, dc: 0, members: [] });
    }

    const bucket = buckets.get(key);
    bucket.food += food[index];
    bucket.sc += scShare[index];
    bucket.dc += dcShare[index];
    bucket.members.push(index);
  });

  const lineTax = lines.map(() => 0);
  const lineCess = lines.map(() => 0);
  const taxes = [];

  for (const bucket of buckets.values()) {
    const taxable = bucket.food + bucket.sc + bucket.dc;
    const gst = percentOf(taxable, bucket.rate);
    const cess = percentOf(taxable, bucket.cess);
    const foodGst = Math.min(percentOf(bucket.food, bucket.rate), gst);
    // The GST on dishes and service charge; what is left of the rate's GST is
    // the delivery charge's, so the three parts always add up to the whole.
    const beforeDelivery = Math.min(percentOf(bucket.food + bucket.sc, bucket.rate), gst);
    const { cgst, sgst } = splitGst(gst);
    const weights = bucket.members.map((index) => food[index] + scShare[index] + dcShare[index]);
    const gstParts = apportion(gst, weights);
    const cessParts = apportion(cess, weights);

    bucket.members.forEach((index, k) => {
      lineTax[index] = gstParts[k];
      lineCess[index] = cessParts[k];
    });

    taxes.push({
      taxPercentage: bucket.rate,
      cessPercentage: bucket.cess,
      itemsTaxable: fromPaise(bucket.food),
      serviceChargeTaxable: fromPaise(bucket.sc),
      deliveryChargeTaxable: fromPaise(bucket.dc),
      taxableValue: fromPaise(taxable),
      cgstAmount: fromPaise(cgst),
      sgstAmount: fromPaise(sgst),
      serviceChargeTax: fromPaise(beforeDelivery - foodGst),
      cessAmount: fromPaise(cess),
      gstPaise: gst,
      cessPaise: cess,
      scTaxPaise: beforeDelivery - foodGst,
      dcTaxPaise: gst - beforeDelivery,
    });
  }

  taxes.sort((a, b) => a.taxPercentage - b.taxPercentage || a.cessPercentage - b.cessPercentage);

  const gstTotal = taxes.reduce((sum, row) => sum + row.gstPaise, 0);
  const cessTotal = taxes.reduce((sum, row) => sum + row.cessPaise, 0);
  const scTax = taxes.reduce((sum, row) => sum + row.scTaxPaise, 0);
  const dcTax = taxes.reduce((sum, row) => sum + row.dcTaxPaise, 0);
  const itemDiscountTotal = itemDisc.reduce((sum, value) => sum + value, 0);
  const discountTotal = itemDiscountTotal + billDiscount;
  const taxable = subtotal - discountTotal + serviceCharge + delivery;
  const tax = gstTotal + cessTotal;
  const raw = taxable + tax;
  const total = Math.round(raw / 100) * 100;

  // How big a till discount is, for a role's cap and a manager's approval:
  // the larger of its share of the bill and the deepest cut on any one dish.
  const tillPaise = manualPaise + itemDiscountTotal;
  const dishPercents = lines.map((line, index) =>
    nets[index] > 0 && itemDisc[index] > 0 ? (itemDisc[index] * 100) / nets[index] : 0
  );
  const tillPercent =
    tillPaise > 0 ? round2(Math.max(subtotal > 0 ? (tillPaise * 100) / subtotal : 0, ...dishPercents)) : 0;

  return {
    subtotal: fromPaise(subtotal),
    couponDiscount: fromPaise(couponPaise),
    manualDiscountAmount: fromPaise(manualPaise),
    itemDiscountAmount: fromPaise(itemDiscountTotal),
    loyaltyDiscount: fromPaise(loyaltyPaise),
    loyaltyPointsUsed: pointsUsed,
    discountAmount: fromPaise(discountTotal),
    serviceChargePercentage: serviceCharge > 0 ? scPercent : 0,
    serviceCharge: fromPaise(serviceCharge),
    serviceChargeTax: fromPaise(scTax),
    deliveryCharge: fromPaise(delivery),
    deliveryChargeTax: fromPaise(dcTax),
    taxAmount: fromPaise(tax),
    cessAmount: fromPaise(cessTotal),
    taxableAmount: fromPaise(taxable),
    roundOff: fromPaise(total - raw),
    totalAmount: fromPaise(total),
    tillAmount: fromPaise(tillPaise),
    tillPercent,
    lines: lines.map((line, index) => {
      const own = itemDiscounts.get(Number(line.orderItemId));

      return {
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        lineSubtotal: fromPaise(base[index].net),
        lineTax: fromPaise(base[index].gst),
        lineTotal: fromPaise(base[index].gross),
        itemDiscountType: itemDisc[index] > 0 ? own.type : null,
        itemDiscountValue: itemDisc[index] > 0 ? Number(own.value) : null,
        itemDiscountAmount: fromPaise(itemDisc[index]),
        discountAmount: fromPaise(itemDisc[index] + shared[index]),
        serviceChargeShare: fromPaise(scShare[index]),
        deliveryChargeShare: fromPaise(dcShare[index]),
        taxableValue: fromPaise(food[index] + scShare[index] + dcShare[index]),
        taxPercentage: Number(line.taxPercentage || 0),
        cessPercentage: Number(line.cessPercentage || 0),
        taxAmount: fromPaise(lineTax[index]),
        cessAmount: fromPaise(lineCess[index]),
        hsnCode: line.hsnCode || null,
      };
    }),
    taxes: taxes.map(({ gstPaise, cessPaise, scTaxPaise, dcTaxPaise, ...row }) => row),
  };
};

module.exports = { priceBill };
