// Credit notes, refunds and voids.
// Part of bill.service.js, which re-exports these for its callers.

const billRepository = require("../../repositories/bill.repository");
const paymentTypeService = require("../../../setup/services/paymentType.service");
const AppError = require("../../../../../utils/AppError");
const { round2, toPaise, fromPaise, splitGst } = require("../../../../../utils/money");
const { legacyTaxRows, n, partOf, requireRestaurantId, returnValueOf } = require("./shape");
const { outletOf, overLimitError, requireAccountRoom, rupeesText } = require("./rules");
const { getById } = require("./raise");

// The credit note for money given back on a settled bill: rate by rate, in
// the same proportions the bill was charged — or, for dishes returned, those
// dishes' own value. Runs with the bill locked (billRepository.addRefund).
const planCreditNote = (restaurantId, data) => async (client, bill) => {
  const total = n(bill.total_amount);
  const amount = toPaise(data.amount);
  const earned = await billRepository.findEarnedPoints(client, bill.id);
  const pointsLeft = Math.max(0, earned.earned - earned.reversed);
  const pointsToReverse = total > 0 ? Math.min(pointsLeft, Math.round((earned.earned * data.amount) / total)) : 0;

  if (data.items && data.items.length > 0) {
    const lines = await billRepository.findReturnableLines(client, bill.id);
    const items = [];
    const buckets = new Map();

    for (const wanted of data.items) {
      const line = lines.find((row) => Number(row.order_item_id) === Number(wanted.orderItemId));

      if (!line) {
        return { error: "RETURN_NOT_ON_BILL" };
      }

      if (line.taxable_value === null) {
        return { error: "RETURN_LEGACY" };
      }

      const left = round2(n(line.quantity) - n(line.returned_quantity));

      if (wanted.quantity > left + 0.0001) {
        return { error: "RETURN_TOO_MANY", itemName: line.item_name, left };
      }

      const q = n(line.quantity);
      const before = n(line.returned_quantity);
      const taxable = partOf(toPaise(line.taxable_value), q, before, wanted.quantity);
      const sc = partOf(toPaise(line.service_charge_share), q, before, wanted.quantity);
      const gst = partOf(toPaise(line.tax_amount), q, before, wanted.quantity);
      const cess = partOf(toPaise(line.cess_amount), q, before, wanted.quantity);

      items.push({
        billItemId: line.bill_item_id,
        quantity: wanted.quantity,
        taxableValue: fromPaise(taxable),
        taxAmount: fromPaise(gst + cess),
        amount: fromPaise(taxable + gst + cess),
      });

      const key = `${n(line.tax_percentage)}|${n(line.cess_percentage)}`;
      const bucket = buckets.get(key) || {
        taxPercentage: n(line.tax_percentage),
        cessPercentage: n(line.cess_percentage),
        taxable: 0,
        sc: 0,
        gst: 0,
        cess: 0,
      };
      bucket.taxable += taxable;
      bucket.sc += sc;
      bucket.gst += gst;
      bucket.cess += cess;
      buckets.set(key, bucket);
    }

    const worth = items.reduce((sum, item) => sum + toPaise(item.amount), 0);

    if (worth !== amount) {
      return { error: "RETURN_AMOUNT", expected: fromPaise(worth) };
    }

    const taxes = [...buckets.values()].map((bucket) => {
      const { cgst, sgst } = splitGst(bucket.gst);

      return {
        taxPercentage: bucket.taxPercentage,
        cessPercentage: bucket.cessPercentage,
        taxableValue: fromPaise(bucket.taxable),
        serviceChargeTaxable: fromPaise(bucket.sc),
        cgstAmount: fromPaise(cgst),
        sgstAmount: fromPaise(sgst),
        cessAmount: fromPaise(bucket.cess),
      };
    });
    const taxablePaise = taxes.reduce((sum, row) => sum + toPaise(row.taxableValue), 0);

    return {
      kind: "return",
      taxableValue: fromPaise(taxablePaise),
      serviceChargeValue: fromPaise(taxes.reduce((sum, row) => sum + toPaise(row.serviceChargeTaxable), 0)),
      taxAmount: fromPaise(amount - taxablePaise),
      cessAmount: fromPaise(taxes.reduce((sum, row) => sum + toPaise(row.cessAmount), 0)),
      roundOff: 0,
      taxes,
      items,
      pointsToReverse,
    };
  }

  // Money back without dishes: every rate of the bill scaled to the amount.
  let rows = await billRepository.findBillTaxes(client, bill.id);

  if (rows.length === 0) {
    const legacyItems = await billRepository.findReturnableLines(client, bill.id);
    rows = legacyTaxRows(bill, legacyItems).map((row) => ({
      tax_percentage: row.taxPercentage,
      cess_percentage: row.cessPercentage,
      taxable_value: row.taxableValue,
      service_charge_taxable: row.serviceChargeTaxable,
      cgst_amount: row.cgst,
      sgst_amount: row.sgst,
      cess_amount: row.cess,
    }));
  }

  const share = total > 0 ? data.amount / total : 0;
  const taxes = rows.map((row) => {
    const gst = Math.round((toPaise(row.cgst_amount) + toPaise(row.sgst_amount)) * share);
    const { cgst, sgst } = splitGst(gst);

    return {
      taxPercentage: n(row.tax_percentage),
      cessPercentage: n(row.cess_percentage),
      taxableValue: fromPaise(Math.round(toPaise(row.taxable_value) * share)),
      serviceChargeTaxable: fromPaise(Math.round(toPaise(row.service_charge_taxable) * share)),
      cgstAmount: fromPaise(cgst),
      sgstAmount: fromPaise(sgst),
      cessAmount: fromPaise(Math.round(toPaise(row.cess_amount) * share)),
    };
  });

  const taxablePaise = taxes.reduce((sum, row) => sum + toPaise(row.taxableValue), 0);
  const taxPaise = taxes.reduce(
    (sum, row) => sum + toPaise(row.cgstAmount) + toPaise(row.sgstAmount) + toPaise(row.cessAmount),
    0
  );

  return {
    kind: "refund",
    taxableValue: fromPaise(taxablePaise),
    serviceChargeValue: fromPaise(taxes.reduce((sum, row) => sum + toPaise(row.serviceChargeTaxable), 0)),
    taxAmount: fromPaise(taxPaise),
    cessAmount: fromPaise(taxes.reduce((sum, row) => sum + toPaise(row.cessAmount), 0)),
    roundOff: fromPaise(amount - taxablePaise - taxPaise),
    taxes,
    items: [],
    pointsToReverse,
  };
};

// Checks a refund against the bill before anyone is asked for a PIN, so a
// manager is never asked to approve something the bill will refuse: dishes
// that are not there to return, an amount that is not what they are worth,
// more money than the bill holds — or, on a bill on an account, a part
// payment handed back that would take the account over its limit.
const checkRefund = async (bill, data, restaurantId = null) => {
  if (bill.bill_status === "void") {
    throw new AppError(409, "This bill has been voided");
  }

  if (restaurantId && data.paymentTypeId) {
    if (!data.refundMethod) {
      throw new AppError(400, "Say how the money goes back before picking a payment type");
    }

    await paymentTypeService.forPayment(restaurantId, data.refundMethod, data.paymentTypeId, null, { requireReference: false });
  }

  if (data.refundMethod === "advance" && !(bill.paid_amount > 0)) {
    throw new AppError(400, "Nothing on this bill was paid from an advance");
  }

  const held = round2(n(bill.paid_amount) - n(bill.refunded_amount));

  if (held <= 0.009) {
    throw new AppError(409, "Nothing has been paid on this bill that could be given back");
  }

  if (data.items && data.items.length > 0) {
    if (bill.bill_status !== "paid") {
      throw new AppError(400, "Dishes can be returned only on a settled bill. Hand back the payment instead.");
    }

    const lines = await billRepository.findReturnableLines(null, bill.id);
    let worth = 0;

    for (const wanted of data.items) {
      const line = lines.find((row) => Number(row.order_item_id) === Number(wanted.orderItemId));

      if (!line) {
        throw refundErrors({ error: "RETURN_NOT_ON_BILL" });
      }

      if (line.taxable_value === null) {
        throw refundErrors({ error: "RETURN_LEGACY" });
      }

      const left = round2(n(line.quantity) - n(line.returned_quantity));

      if (wanted.quantity > left + 0.0001) {
        throw refundErrors({ error: "RETURN_TOO_MANY", itemName: line.item_name, left });
      }

      worth += returnValueOf(line, wanted.quantity);
    }

    if (worth !== toPaise(data.amount)) {
      throw refundErrors({ error: "RETURN_AMOUNT", expected: fromPaise(worth) });
    }
  }

  if (data.amount > held + 0.009) {
    throw new AppError(400, `Only ${held} can be refunded on this bill`);
  }

  if (restaurantId && bill.bill_status !== "paid") {
    await requireAccountRoom(
      restaurantId,
      bill,
      round2(billRepository.dueAt(bill, bill.total_amount) + data.amount),
      "Handing this back"
    );
  }
};

const refundErrors = (result) => {
  switch (result.error) {
    case "NOT_FOUND":
      return new AppError(404, "Bill not found");
    case "VOID":
      return new AppError(409, "This bill has been voided");
    case "NOT_PAID":
      return new AppError(409, "Nothing has been paid on this bill that could be given back");
    case "TOO_MUCH":
      return new AppError(400, `Only ${result.refundable} can be refunded on this bill`);
    case "NO_DAY":
      return new AppError(409, "Open the business day first. A refund comes out of the day's drawer, and no day is open.");
    case "METHOD_NEEDED":
      return new AppError(
        400,
        `This bill was paid ${result.methods.length ? `by ${result.methods.join(" and ")}` : "in more than one way"}. Say how the money went back: cash, card or UPI.`
      );
    case "RETURN_NOT_SETTLED":
      return new AppError(400, "Dishes can be returned only on a settled bill. Hand back the payment instead.");
    case "RETURN_NOT_ON_BILL":
      return new AppError(400, "A dish being returned is not on this bill");
    case "RETURN_LEGACY":
      return new AppError(400, "This bill is older than dish returns. Refund an amount instead.");
    case "RETURN_TOO_MANY":
      return new AppError(400, `Only ${result.left} of "${result.itemName}" is left to return`);
    case "RETURN_AMOUNT":
      return new AppError(400, `The dishes returned come to ${result.expected.toFixed(2)}. Refund that amount.`);
    case "OVER_LIMIT":
      return overLimitError(result, "Handing this back");
    case "BUSY":
      return new AppError(409, "This bill was changed at another till a moment ago. Open it again and retry.");
    case "ADVANCE_BACK_TOO_MUCH":
      return new AppError(
        400,
        result.left > 0
          ? `Only ${rupeesText(result.left)} of this bill was paid from an advance, so at most that can go back onto it`
          : "Nothing on this bill was paid from an advance. Give the money back another way."
      );
    default:
      return new AppError(400, "That refund could not be recorded");
  }
};

const addRefund = async (restaurantId, billId, data, userId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const result = await billRepository.addRefund(
    restaurantId,
    billId,
    outletOf(ctx),
    data,
    planCreditNote(restaurantId, data),
    userId
  );

  if (result.error) {
    throw refundErrors(result);
  }

  return { bill: await getById(restaurantId, billId, ctx), result };
};

// Voiding is for a bill raised by mistake, before any money is held on it.
const checkVoid = (bill) => {
  if (bill.bill_status === "void") {
    throw new AppError(409, "This bill is already void");
  }

  const held = round2(n(bill.paid_amount) - n(bill.refunded_amount));

  if (held > 0.009) {
    throw new AppError(409, `This bill still holds ${held} paid. Give it back first (Refund), then void it.`);
  }

  if (bill.bill_status === "paid") {
    throw new AppError(409, "A settled bill cannot be voided. Give money back with a refund instead.");
  }

  // A bill put on a guest's or company's account closed its order and freed
  // the table; voiding it would reopen an order whose guests have gone.
  if (bill.account_customer_id || bill.order_status === "completed") {
    throw new AppError(
      409,
      "This bill went on an account, so its guests have left and the table is free; it cannot be voided. Collect it on the account, then give money back with a credit note if it was wrong."
    );
  }
};

const voidBill = async (restaurantId, billId, reason, userId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const result = await billRepository.voidBill(restaurantId, billId, outletOf(ctx), reason, userId);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Bill not found");
  }

  if (result.error === "ALREADY_VOID") {
    throw new AppError(409, "This bill is already void");
  }

  if (result.error === "HAS_PAYMENTS") {
    throw new AppError(409, `This bill still holds ${result.held} paid. Give it back first (Refund), then void it.`);
  }

  if (result.error === "SETTLED") {
    throw new AppError(409, "A settled bill cannot be voided. Give money back with a refund instead.");
  }

  if (result.error === "ON_ACCOUNT") {
    throw new AppError(
      409,
      "This bill went on an account, so its guests have left and the table is free; it cannot be voided. Collect it on the account, then give money back with a credit note if it was wrong."
    );
  }

  return getById(restaurantId, billId, ctx);
};

module.exports = {
  checkRefund,
  addRefund,
  checkVoid,
  voidBill,
};
