// A bill as the screens see it: reasons, tax rows (stored or rebuilt for old bills), amounts due and returned.
// Part of bill.service.js, which re-exports these for its callers.

const { breakdownBill } = require("../gstBreakdown");
const { shareServiceCharge } = require("../serviceChargeShare");
const AppError = require("../../../../../utils/AppError");
const { round2, toPaise, fromPaise, splitGst } = require("../../../../../utils/money");
const { maskMobile, formatMobile } = require("../../../../../utils/phone");
const { gstinState } = require("../../../../../utils/gstin");

// Restaurant service is SAC 996331; it heads every tax invoice.
const RESTAURANT_SAC = "996331";

// Why a discount was given at the till. A list rather than free text, so the
// owner can total "complaints" against "regulars" at the end of the month;
// "other" needs a note.
const DISCOUNT_REASONS = {
  regular: "Regular guest",
  delay: "Food or service was slow",
  complaint: "Complaint about food or service",
  birthday: "Birthday or occasion",
  bulk: "Large party or bulk order",
  promotion: "Promotion or event",
  staff: "Staff or family",
  other: "Other (write a note)",
};

// Why a bill was made no-charge.
const COMPLIMENTARY_REASONS = {
  staff_meal: "Staff meal",
  owner_guest: "Owner's or management's guest",
  complaint: "Complaint, on the house",
  tasting: "Tasting or menu trial",
  promotion: "Promotion, blogger or influencer",
  other: "Other (write a note)",
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const n = (value) => (value === null || value === undefined ? 0 : Number(value));

// What the guest still owes: the bill, less what was credited back against the
// sale, less the money held (paid less handed back).
const dueFor = (row) =>
  row.bill_status === "void"
    ? 0
    : Math.max(0, round2(n(row.total_amount) - n(row.credited_amount) - (n(row.paid_amount) - n(row.refunded_amount))));

// ------------------------------------------------------------------ tax rows

const taxRow = (row) => {
  const rate = n(row.tax_percentage);
  const cgst = n(row.cgst_amount);
  const sgst = n(row.sgst_amount);
  const cess = n(row.cess_amount);

  return {
    taxPercentage: rate,
    cessPercentage: n(row.cess_percentage),
    cgstRate: rate / 2,
    sgstRate: rate / 2,
    itemsTaxable: n(row.items_taxable),
    serviceChargeTaxable: n(row.service_charge_taxable),
    deliveryChargeTaxable: n(row.delivery_charge_taxable),
    taxableValue: n(row.taxable_value),
    cgst,
    sgst,
    cess,
    serviceChargeTax: n(row.service_charge_tax),
    taxAmount: round2(cgst + sgst + cess),
  };
};

// Bills raised before the tax was kept rate by rate: worked out from the bill
// and its lines the way the GST report does (services/gstBreakdown), so the
// paper still shows CGST and SGST that add up to the bill's tax.
const legacyTaxRows = (bill, items) => {
  const groups = new Map();

  for (const item of items) {
    const rate = n(item.order_tax_percentage ?? item.tax_percentage);
    const group = groups.get(rate) || { tax_percentage: rate, quantity: 0, subtotal: 0, tax: 0 };
    group.quantity += n(item.quantity);
    group.subtotal += n(item.line_subtotal);
    group.tax += n(item.line_tax);
    groups.set(rate, group);
  }

  const breakdown = breakdownBill(bill, [...groups.values()]);
  const byRate = new Map();

  const add = (rate, taxable, sc, gstPaise, scTax) => {
    const row = byRate.get(rate) || { tax_percentage: rate, items: 0, sc: 0, gst: 0, scTax: 0 };
    row.items += taxable;
    row.sc += sc;
    row.gst += gstPaise;
    row.scTax += scTax;
    byRate.set(rate, row);
  };

  for (const line of breakdown.lines) {
    add(line.rate, line.taxable, 0, line.tax, 0);
  }

  // The service charge at the rates of the food it was on, as the GST return
  // files it (services/serviceChargeShare) — never at a blended rate.
  if (breakdown.serviceCharge.tax > 0) {
    for (const part of shareServiceCharge(breakdown.lines, breakdown.serviceCharge)) {
      add(part.rate, 0, part.value, part.tax, part.tax);
    }
  }

  return [...byRate.values()]
    .sort((a, b) => a.tax_percentage - b.tax_percentage)
    .map((row) => {
      const { cgst, sgst } = splitGst(row.gst);
      return taxRow({
        tax_percentage: row.tax_percentage,
        cess_percentage: 0,
        items_taxable: fromPaise(row.items),
        service_charge_taxable: fromPaise(row.sc),
        taxable_value: fromPaise(row.items + row.sc),
        cgst_amount: fromPaise(cgst),
        sgst_amount: fromPaise(sgst),
        service_charge_tax: fromPaise(row.scTax),
        cess_amount: 0,
      });
    });
};

// A share of one figure when part of a line is returned: the value of units
// r+1 … r+q out of Q. Working it as "all returned so far" minus "before" means
// returning every unit, one at a time or all together, gives back exactly the
// line's own value to the paisa.
const partOf = (paise, quantity, returnedBefore, returning) =>
  Math.round((paise * (returnedBefore + returning)) / quantity) - Math.round((paise * returnedBefore) / quantity);

const returnValueOf = (item, returning) => {
  const quantity = n(item.quantity);
  const before = n(item.returned_quantity);

  return (
    partOf(toPaise(item.taxable_value), quantity, before, returning) +
    partOf(toPaise(item.tax_amount), quantity, before, returning) +
    partOf(toPaise(item.cess_amount), quantity, before, returning)
  );
};

// ------------------------------------------------------------------ shapes

const toBill = (row, { reveal = false } = {}) => {
  const guestName = row.customer_name || row.linked_customer_name || null;
  const mobile = row.customer_mobile || row.linked_customer_mobile || null;
  const sellerGstin = row.seller_gstin || row.outlet_gstin || row.settings_gstin || null;
  const items = row.items || [];
  const settled = row.bill_status === "paid";

  const taxes =
    row.taxes && row.taxes.length > 0
      ? row.taxes.map(taxRow)
      : row.items && n(row.tax_amount) > 0
        ? legacyTaxRows(row, items)
        : [];

  return {
    id: row.id,
    billNumber: row.bill_number,
    orderId: row.order_id,
    orderNumber: row.order_number,
    orderType: row.order_type,
    brandName: row.brand_name || null,
    outletId: row.outlet_id,
    outletName: row.outlet_name || null,
    businessDayId: row.business_day_id,
    businessDate: row.business_date || null,
    tableNo: row.table_no,
    customerId: row.customer_id || null,
    customerName: guestName,
    customerMobile: mobile ? (reveal ? formatMobile(mobile) : maskMobile(mobile)) : null,
    guestCount: row.guest_count ?? null,
    discountId: row.discount_id,
    discountCode: row.discount_code,
    subtotal: n(row.subtotal),
    couponDiscount: n(row.coupon_discount),
    manualDiscount: row.manual_discount_type
      ? {
          type: row.manual_discount_type,
          value: n(row.manual_discount_value),
          amount: n(row.manual_discount_amount),
        }
      : null,
    itemDiscountAmount: n(row.item_discount_amount),
    discountReason: row.discount_reason || null,
    discountReasonLabel: row.discount_reason ? DISCOUNT_REASONS[row.discount_reason] || row.discount_reason : null,
    discountNote: row.discount_note || null,
    discountGivenBy: row.discount_given_by_name || null,
    discountApprovedBy: row.discount_approved_by_name || null,
    discountAmount: n(row.discount_amount),
    taxableAmount: row.taxable_amount === null || row.taxable_amount === undefined
      ? round2(n(row.subtotal) - n(row.discount_amount) + n(row.service_charge))
      : n(row.taxable_amount),
    taxAmount: n(row.tax_amount),
    cessAmount: n(row.cess_amount),
    serviceCharge: n(row.service_charge),
    serviceChargePercentage: n(row.service_charge_percentage),
    serviceChargeTax: n(row.service_charge_tax),
    serviceChargeWaived: Boolean(row.service_charge_waived),
    serviceChargeWaiveReason: row.service_charge_waive_reason || null,
    // Own delivery's trip charge (before GST) and the GST on it; taken off
    // this bill by a manager when waived, with why.
    deliveryCharge: n(row.delivery_charge),
    deliveryChargeTax: n(row.delivery_charge_tax),
    deliveryChargeWaived: Boolean(row.delivery_charge_waived),
    deliveryChargeWaiveReason: row.delivery_charge_waive_reason || null,
    deliveryChargeWaivedBy: row.delivery_charge_waived_by_name || null,
    deliveryChargeApprovedBy: row.delivery_charge_approved_by_name || null,
    roundOff: n(row.round_off),
    totalAmount: n(row.total_amount),
    paidAmount: n(row.paid_amount),
    refundedAmount: n(row.refunded_amount),
    creditedAmount: n(row.credited_amount),
    // Money held on the bill: what could still be given back.
    heldAmount: round2(n(row.paid_amount) - n(row.refunded_amount)),
    dueAmount: dueFor(row),
    billStatus: row.bill_status,
    voidReason: row.void_reason,
    billedAt: row.billed_at,
    settledAt: row.settled_at,
    taxMode: row.tax_mode || null,
    isComplimentary: Boolean(row.is_complimentary),
    complimentaryReason: row.complimentary_reason || null,
    complimentaryReasonLabel: row.complimentary_reason
      ? COMPLIMENTARY_REASONS[row.complimentary_reason] || row.complimentary_reason
      : null,
    complimentaryNote: row.complimentary_note || null,
    complimentaryBy: row.complimentary_by_name || null,
    complimentaryApprovedBy: row.complimentary_approved_by_name || null,
    loyaltyPointsUsed: row.loyalty_points_used,
    loyaltyDiscount: n(row.loyalty_discount),
    printCount: row.print_count,
    firstPrintedAt: row.first_printed_at || null,
    lastPrintedAt: row.last_printed_at,
    lastAdjustedAt: row.last_adjusted_at || null,
    isSplit: row.is_split,
    createdByName: row.created_by_name,
    taxes,
    items: items.map((item) => {
      const returnable = round2(n(item.quantity) - n(item.returned_quantity));
      const canReturn = settled && item.taxable_value !== null && item.taxable_value !== undefined && returnable > 0;

      return {
        billItemId: item.bill_item_id,
        orderItemId: item.order_item_id,
        itemName: item.item_name,
        variantName: item.variant_name,
        quantity: n(item.quantity),
        unitPrice: n(item.unit_price),
        modifierTotal: n(item.modifier_total),
        packagingCharge: n(item.packaging_charge),
        mrp: item.mrp === null || item.mrp === undefined ? null : n(item.mrp),
        priceIncludesTax: item.price_includes_tax,
        hsnCode: item.hsn_code || null,
        taxPercentage: n(item.tax_percentage ?? item.order_tax_percentage),
        cessPercentage: n(item.cess_percentage),
        lineSubtotal: n(item.line_subtotal),
        lineTax: n(item.line_tax),
        lineTotal: n(item.line_total),
        itemDiscount: item.item_discount_type
          ? { type: item.item_discount_type, value: n(item.item_discount_value), amount: n(item.item_discount_amount) }
          : null,
        discountAmount: n(item.discount_amount),
        serviceChargeShare: n(item.service_charge_share),
        deliveryChargeShare: n(item.delivery_charge_share),
        taxableValue: item.taxable_value === null ? null : n(item.taxable_value),
        taxAmount: item.tax_amount === null ? null : n(item.tax_amount),
        cessAmount: n(item.cess_amount),
        returnedQuantity: n(item.returned_quantity),
        returnableQuantity: canReturn ? returnable : 0,
        // What one more returned is worth (value + GST + cess), to the paisa.
        returnValue: canReturn ? fromPaise(returnValueOf(item, 1)) : 0,
      };
    }),
    payments: (row.payments || []).map((payment) => ({
      id: payment.id,
      paymentMethod: payment.payment_method,
      amount: n(payment.amount),
      tenderedAmount: payment.tendered_amount === null ? null : n(payment.tendered_amount),
      changeAmount: n(payment.change_amount),
      // A tip given with the payment, on top of what it put toward the bill.
      tipAmount: n(payment.tip_amount),
      paymentTypeId: payment.payment_type_id || null,
      paymentTypeName: payment.payment_type_name || null,
      advanceId: payment.advance_id || null,
      advanceReceiptNumber: payment.advance_receipt_number || null,
      transactionRef: payment.transaction_ref,
      paymentStatus: payment.payment_status,
      paidAt: payment.paid_at,
      businessDayId: payment.business_day_id,
      // Its business day is still open, so how it was taken can be corrected.
      dayOpen: payment.day_status === "open",
      createdByName: payment.created_by_name,
    })),
    tipTotal: round2((row.payments || []).reduce((sum, payment) => sum + n(payment.tip_amount), 0)),
    // Payments whose method was corrected, oldest first.
    corrections: (row.corrections || []).map((fix) => ({
      id: fix.id,
      paymentId: fix.payment_id,
      amount: n(fix.amount),
      oldMethod: fix.old_method,
      newMethod: fix.new_method,
      oldTypeName: fix.old_type_name || null,
      newTypeName: fix.new_type_name || null,
      oldReference: fix.old_reference || null,
      newReference: fix.new_reference || null,
      reason: fix.reason,
      correctedAt: fix.corrected_at,
      correctedBy: fix.corrected_by_name || null,
      approvedBy: fix.approved_by_name || null,
    })),
    refunds: (row.refunds || []).map((refund) => ({
      id: refund.id,
      amount: n(refund.amount),
      refundMethod: refund.refund_method,
      refundKind: refund.refund_kind,
      paymentTypeName: refund.payment_type_name || null,
      advanceReceiptNumber: refund.advance_receipt_number || null,
      reason: refund.reason,
      refundedAt: refund.refunded_at,
      businessDayId: refund.business_day_id,
      creditNoteNumber: refund.credit_note_number || null,
      createdByName: refund.created_by_name,
    })),
    creditNotes: (row.credit_notes || []).map((note) => ({
      id: note.id,
      number: note.credit_note_number,
      kind: note.kind,
      reason: note.reason,
      refundMethod: note.refund_method,
      taxableValue: n(note.taxable_value),
      serviceChargeValue: n(note.service_charge_value),
      taxAmount: n(note.tax_amount),
      cessAmount: n(note.cess_amount),
      roundOff: n(note.round_off),
      totalAmount: n(note.total_amount),
      pointsReversed: note.points_reversed,
      issuedAt: note.issued_at,
      createdByName: note.created_by_name,
      taxes: (note.taxes || []).map(taxRow),
      items: (note.items || []).map((item) => ({
        itemName: item.item_name,
        variantName: item.variant_name,
        quantity: n(item.quantity),
        taxableValue: n(item.taxable_value),
        taxAmount: n(item.tax_amount),
        amount: n(item.amount),
      })),
    })),
    receiptSettings: row.receipt_settings || null,
    // Where the guest can pay by UPI (the outlet's own ID, else the
    // restaurant's): the bill and the payment screen show a QR code for the
    // exact amount due. Only the full read carries it.
    upi: row.upi_vpa ? { vpa: row.upi_vpa, payeeName: row.upi_payee_name || row.restaurant_name || null } : null,
    // The table's ordering QR, for the receipt setting that prints it.
    tableQrToken: row.order_type === "dine_in" && row.table_qr_token ? row.table_qr_token : null,
    guestWebAddress: row.guest_web_address || null,
    // A B2B invoice's buyer: name, GSTIN, address, and the state the GSTIN
    // is registered in (the invoice prints both).
    buyer: row.buyer_gstin
      ? {
          gstin: row.buyer_gstin,
          legalName: row.buyer_name,
          source: row.buyer_source,
          address: row.buyer_address || null,
          state: gstinState(row.buyer_gstin) ? `${String(row.buyer_gstin).slice(0, 2)}-${gstinState(row.buyer_gstin)}` : null,
        }
      : null,
    // The guest's or company's account the bill was put on (dues).
    accountCustomerId: row.account_customer_id || null,
    accountName: row.account_customer_id ? row.account_company || row.account_name || null : null,
    accountAt: row.account_at || null,
    accountNote: row.account_note || null,
    accountBy: row.account_by_name || null,
    accountApprovedBy: row.account_approved_by_name || null,
    // Only the full read carries who issued it and to whom.
    invoice:
      row.restaurant_name !== undefined
        ? {
            title: row.receipt_settings?.documentType === 'bill_of_supply' ? 'Bill of Supply'
              : row.receipt_settings?.documentType === 'tax_invoice' || sellerGstin ? 'Tax Invoice' : 'Bill',
            seller: {
              name: row.restaurant_name,
              outletName: row.outlet_name || null,
              address: row.outlet_address || row.restaurant_address || null,
              phone: row.outlet_phone || row.restaurant_phone || null,
              gstin: sellerGstin,
              fssai: row.fssai_number || null,
              state: gstinState(sellerGstin),
            },
            sac: RESTAURANT_SAC,
            cashier: row.created_by_name || null,
            // Where the food is served: the restaurant's own state, as
            // "37-Andhra Pradesh" (state code and name, as the invoice prints it).
            placeOfSupply: gstinState(sellerGstin) ? `${String(sellerGstin).slice(0, 2)}-${gstinState(sellerGstin)}` : null,
          }
        : undefined,
  };
};

// Someone who may not see takings or take payments (a captain: orders.view
// only) sees a bill as the guest does: its dishes, totals and status, never
// how it was paid — no payment methods, references, tips, refunds or the
// account it was put on.
const withoutPayments = (bill) => ({
  ...bill,
  payments: [],
  corrections: [],
  refunds: [],
  tipTotal: null,
  creditNotes: bill.creditNotes.map((note) => ({ ...note, refundMethod: null })),
  accountCustomerId: null,
  accountName: null,
  accountAt: null,
  accountNote: null,
  accountBy: null,
  accountApprovedBy: null,
  paymentDetailsHidden: true,
});

module.exports = {
  DISCOUNT_REASONS,
  COMPLIMENTARY_REASONS,
  requireRestaurantId,
  n,
  legacyTaxRows,
  partOf,
  returnValueOf,
  toBill,
  withoutPayments,
};
