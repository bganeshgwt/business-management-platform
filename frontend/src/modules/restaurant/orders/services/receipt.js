// What a printed bill looks like. How it reaches the printer is print.js —
// both the POS and the Bills screen call this, so the paper is identical
// whichever screen it came from.
//
// The paper is a GST tax invoice and it adds up on paper: the dish amounts
// (before tax) add up to the subtotal; every discount, the service charge,
// CGST and SGST at their rates, cess and the round off follow, each on its
// own line; and those lines down to the total add up to the total. The
// figures are the server's, rate by rate (bill.taxes) — never worked out
// again here — so CGST + SGST is exactly the tax on the bill.
//
// Extensions are explicit here: these are plain ES modules, so they can be
// exercised by a test runner outside the bundler.
import { escapeHtml as escape, printDocument } from "../../../../services/print.js";
import { moneyExact } from "../../../../services/format.js";
import { MONTH_NAMES } from "../../../../services/dates.js";
import { billTableLink, billUpiLink, qrSvg } from "./upi.js";

// Leave room for the receipt's 4 mm page margins. Full paper width here
// overflowed the printable area on thermal rolls.
const PAPER_WIDTHS = { "58mm": 181, "80mm": 272, a4: 640 };

const METHOD_WORDS = {
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  online: "Online",
  wallet: "Wallet",
  other: "Other",
  advance: "Advance",
};

const num = (value) => Number(value || 0);
const two = (value) => num(value).toFixed(2);
const cents = (value) => Math.round(num(value) * 100);
const rate = (value) => `${Number(num(value).toFixed(3))}%`;

// A date and time the way a bill prints it: 25 Sep 2026, 7:42 pm — on the
// restaurant's clock where the settings say which that is. The month is the
// app's own short name (dates.js MONTH_NAMES): the browser's en-IN wrote
// "Sept", which no other screen or paper in the app does.
const when = (value, timezone) => {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const options = { day: "numeric", month: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true };
  let parts;

  try {
    parts = new Intl.DateTimeFormat("en-IN", timezone ? { ...options, timeZone: timezone } : options).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-IN", options).formatToParts(date);
  }

  const part = (type) => (parts.find((row) => row.type === type) || {}).value || "";
  const month = MONTH_NAMES[Number(part("month")) - 1] || "";

  return `${part("day")} ${month} ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toLowerCase()}`;
};

// The rows of the bill as data, in the order they print. Every row of
// `totals` except subtotal, total, paid and due is signed (discounts are
// negative), so subtotal + those rows = total — the test the paper must pass.
export const receiptModel = (bill, { settings = {}, currency = "₹", restaurantName = "" } = {}) => {
  settings = { ...settings, ...(bill.receiptSettings || {}) };
  const invoice = bill.invoice || null;
  const seller = invoice
    ? invoice.seller
    : {
        name: restaurantName,
        address: null,
        phone: null,
        gstin: (settings && settings.gstNumber) || null,
        fssai: (settings && settings.fssaiNumber) || null,
      };
  const gstSplit = !settings || settings.gstSplit !== false;
  const totals = [];
  const row = (key, label, amount, extra = {}) =>
    totals.push({ key, label, amount: Number(num(amount).toFixed(2)), ...extra });

  row("subtotal", "Subtotal", bill.subtotal);

  if (bill.isComplimentary) {
    row(
      "complimentary",
      `Complimentary${bill.complimentaryReasonLabel ? ` (${bill.complimentaryReasonLabel})` : ""}`,
      -num(bill.discountAmount)
    );
  } else {
    const known =
      num(bill.itemDiscountAmount) +
      num(bill.couponDiscount) +
      num(bill.manualDiscount ? bill.manualDiscount.amount : 0) +
      num(bill.loyaltyDiscount);
    // A bill from before the discounts were kept apart carries one figure.
    const other = Math.max(0, cents(bill.discountAmount) - cents(known)) / 100;

    if (num(bill.itemDiscountAmount) > 0) {
      // The reason is said once: here, unless the bill-wide discount below says it.
      const why = bill.discountReasonLabel && !(bill.manualDiscount && num(bill.manualDiscount.amount) > 0);
      row("itemDiscount", `Discount on dishes${why ? ` (${bill.discountReasonLabel})` : ""}`, -num(bill.itemDiscountAmount));
    }

    if (num(bill.couponDiscount) > 0) {
      row("coupon", `Coupon ${bill.discountCode || ""}`.trim(), -num(bill.couponDiscount));
    }

    if (other > 0) {
      row("discount", `Discount ${bill.discountCode || ""}`.trim(), -other);
    }

    if (bill.manualDiscount && num(bill.manualDiscount.amount) > 0) {
      const how = bill.manualDiscount.type === "percentage" ? ` ${rate(bill.manualDiscount.value)}` : "";
      row(
        "manual",
        `Discount${how}${bill.discountReasonLabel ? ` (${bill.discountReasonLabel})` : ""}`,
        -num(bill.manualDiscount.amount)
      );
    }

    if (num(bill.loyaltyDiscount) > 0) {
      row("points", `Points redeemed (${bill.loyaltyPointsUsed || 0})`, -num(bill.loyaltyDiscount));
    }
  }

  if (num(bill.serviceCharge) > 0) {
    row(
      "serviceCharge",
      `Service charge${num(bill.serviceChargePercentage) > 0 ? ` @${rate(bill.serviceChargePercentage)}` : ""}`,
      bill.serviceCharge
    );
  }

  // Own delivery's trip charge: taxed with the food (its GST is inside the
  // rate rows below).
  if (num(bill.deliveryCharge) > 0) {
    row("deliveryCharge", "Delivery charge", bill.deliveryCharge);
  }

  const taxes = Array.isArray(bill.taxes) ? bill.taxes : [];

  if (taxes.length > 0) {
    for (const tax of taxes) {
      if (num(tax.cgst) + num(tax.sgst) > 0 || num(tax.taxPercentage) > 0) {
        if (gstSplit) {
          row("tax", `CGST @${rate(tax.cgstRate ?? num(tax.taxPercentage) / 2)}`, tax.cgst, {
            taxable: tax.taxableValue,
          });
          row("tax", `SGST @${rate(tax.sgstRate ?? num(tax.taxPercentage) / 2)}`, tax.sgst, {
            taxable: tax.taxableValue,
          });
        } else {
          row("tax", `GST @${rate(tax.taxPercentage)}`, num(tax.cgst) + num(tax.sgst), { taxable: tax.taxableValue });
        }
      }

      if (num(tax.cess) > 0) {
        row("tax", `Cess @${rate(tax.cessPercentage)}`, tax.cess);
      }
    }
  } else if (num(bill.taxAmount) > 0) {
    // A bill read from a list, without its tax lines.
    row("tax", "Tax", bill.taxAmount);
  }

  if (num(bill.roundOff) !== 0) {
    row("roundOff", "Round off", bill.roundOff);
  }

  row("total", "TOTAL", bill.totalAmount);

  if (num(bill.paidAmount) > 0) {
    row("paid", "Paid", bill.paidAmount);
  }

  if (num(bill.dueAmount) > 0 && bill.billStatus !== "void") {
    row("due", "Due", bill.dueAmount);
  }

  const items = (bill.items || []).map((item) => ({
    name: `${item.itemName}${item.variantName ? ` (${item.variantName})` : ""}`,
    quantity: num(item.quantity),
    packagingCharge: num(item.packagingCharge),
    mrp: item.mrp === null || item.mrp === undefined ? null : num(item.mrp),
    // Before tax, so the column adds up to the subtotal.
    rate: num(item.quantity) > 0 ? num(item.lineSubtotal) / num(item.quantity) : 0,
    amount: num(item.lineSubtotal),
    discount: item.itemDiscount && num(item.itemDiscount.amount) > 0 ? num(item.itemDiscount.amount) : 0,
    discountLabel:
      item.itemDiscount && num(item.itemDiscount.amount) > 0
        ? item.itemDiscount.type === "percentage"
          ? `${rate(item.itemDiscount.value)} off`
          : "Discount"
        : null,
    hsn: item.hsnCode || null,
  }));

  const notes = [];

  if (bill.taxMode === "inclusive") {
    notes.push("Menu prices include GST; this bill shows them before tax.");
  }

  if (num(bill.serviceCharge) > 0) {
    notes.push("Service charge is voluntary. Ask us and we will take it off.");
  }

  // The guest's points on this bill: earned once it is paid, and the balance
  // they had right after it (a reprint next month prints the same). Only for
  // a guest's bill that moved their points.
  const earned = Math.max(0, Math.round(num(bill.pointsEarned)));
  const balance = bill.pointsBalance === null || bill.pointsBalance === undefined ? null : Math.round(num(bill.pointsBalance));
  const points =
    bill.customerName && (earned > 0 || balance !== null)
      ? { earned, redeemed: Math.round(num(bill.loyaltyPointsUsed)), balance }
      : null;

  return {
    title: settings.documentType === "bill_of_supply" ? "Bill of Supply" : settings.documentType === "tax_invoice" ? "Tax Invoice" : invoice ? invoice.title : seller.gstin ? "Tax Invoice" : "Bill",
    seller,
    sac: invoice ? invoice.sac : "996331",
    placeOfSupply: invoice ? invoice.placeOfSupply || null : null,
    cashier: invoice ? invoice.cashier : bill.createdByName || null,
    billNumber: bill.billNumber,
    orderNumber: bill.orderNumber,
    tableNo: bill.tableNo || null,
    billedAt: bill.billedAt,
    guest: bill.customerName ? { name: bill.customerName, mobile: bill.customerMobile || null } : null,
    buyer: bill.buyer || null,
    duplicate: bill.copy === "duplicate" || num(bill.printCount) > 1,
    copyNumber: Math.max(0, num(bill.printCount) - 1),
    isVoid: bill.billStatus === "void",
    items,
    totals,
    payments: (bill.payments || []).map((payment) => ({
      method: `${METHOD_WORDS[payment.paymentMethod] || payment.paymentMethod}${
        payment.paymentTypeName ? ` · ${payment.paymentTypeName}` : ""
      }`,
      amount: num(payment.amount),
      change: num(payment.changeAmount),
      tip: num(payment.tipAmount),
      reference: payment.advanceReceiptNumber || payment.transactionRef || null,
    })),
    // Tips given with the payments: on top of the bill, for the staff.
    tips: (bill.payments || []).reduce((sum, payment) => sum + num(payment.tipAmount), 0),
    // A UPI QR for the exact amount still due (upi://pay…), and the table's
    // ordering page when the bill says to print it.
    upiLink: billUpiLink(bill),
    tableLink: billTableLink(bill, typeof window !== "undefined" && window.location ? window.location.origin : ""),
    currency,
    notes,
    points,
  };
};

const line = (label, value, style = "") =>
  `<tr${style ? ` style="${style}"` : ""}><td>${escape(label)}</td><td class="r">${escape(value)}</td></tr>`;

// A detail of the bill (number, buyer, SAC…): the value may be long — a
// company's registered name, its address — so it wraps inside the paper
// instead of running past its edge the way an amount column would.
const detail = (label, value) =>
  `<tr><td class="k">${escape(label)}</td><td class="v">${escape(value)}</td></tr>`;

const signed = (amount) => (amount < 0 ? `-${two(-amount)}` : two(amount));

// The dish lines. On 58 mm paper (about 32 characters) four columns do not
// fit: "2 × 285.00 = 570.00" printed as "2285.00570.00". There each dish has
// a line of its own, with "quantity × rate" and the amount under it. On
// 80 mm and A4 the four columns stay, with room between them.
const itemRows = (items, narrow) =>
  items
    .map((item) => {
      const extras =
        (item.mrp !== null ? `<tr class="s"><td colspan="4">MRP: ${escape(two(item.mrp))}</td></tr>` : "") +
        (item.packagingCharge
          ? `<tr class="s"><td colspan="4">Includes packaging: ${escape(two(item.packagingCharge))} per item</td></tr>`
          : "") +
        (item.discount
          ? `<tr class="s"><td colspan="3">&nbsp;&nbsp;${escape(item.discountLabel)}</td><td class="r">-${escape(two(item.discount))}</td></tr>`
          : "");

      if (narrow) {
        return (
          `<tr><td colspan="4" class="item-name">${escape(item.name)}</td></tr>` +
          `<tr><td colspan="3" class="item-qty">${escape(item.quantity)} × ${escape(two(item.rate))}</td>` +
          `<td class="r">${escape(two(item.amount))}</td></tr>` +
          extras
        );
      }

      return (
        `<tr><td class="item-name">${escape(item.name)}</td><td class="r">${escape(item.quantity)}</td>` +
        `<td class="r">${escape(two(item.rate))}</td><td class="r">${escape(two(item.amount))}</td></tr>` +
        extras
      );
    })
    .join("");

export const buildReceipt = (bill, options = {}) => {
  const model = receiptModel(bill, options);
  const { seller } = model;
  const settings = { ...(options.settings || {}), ...(bill.receiptSettings || {}) };
  const timezone = settings.timezone || null;
  const narrow = (settings.printPaperWidth || "80mm") === "58mm";

  const head = [
    settings.receiptLogoPath ? `<div class="c"><img class="logo" src="${escape(settings.receiptLogoPath)}" alt="Logo" /></div>` : "",
    `<div class="c b big">${escape(seller.name || options.restaurantName || "")}</div>`,
    seller.outletName ? `<div class="c">${escape(seller.outletName)}</div>` : "",
    settings.billHeader ? `<div class="c s">${escape(settings.billHeader)}</div>` : "",
    seller.address ? `<div class="c s">${escape(seller.address)}</div>` : "",
    seller.phone ? `<div class="c s">Phone: ${escape(seller.phone)}</div>` : "",
    seller.gstin ? `<div class="c s">GSTIN: ${escape(seller.gstin)}</div>` : "",
    seller.fssai ? `<div class="c s">FSSAI: ${escape(seller.fssai)}</div>` : "",
    `<div class="c b title">${escape(model.title)}</div>`,
    model.duplicate
      ? `<div class="c b dup">DUPLICATE${model.copyNumber ? ` (copy ${escape(model.copyNumber)})` : ""}</div>`
      : "",
    model.isVoid ? `<div class="c b dup">VOID — NOT A VALID BILL</div>` : "",
  ].join("");

  // A tax invoice to a registered buyer carries the buyer's name, GSTIN,
  // address and state, and the place of supply (Rule 46).
  const meta = [
    detail("Bill No", model.billNumber),
    detail("Date", when(model.billedAt, timezone)),
    detail("Order", `${model.orderNumber || ""}${model.tableNo ? ` · Table ${model.tableNo}` : ""}`),
    model.cashier ? detail("Cashier", model.cashier) : "",
    model.guest ? detail("Guest", `${model.guest.name}${model.guest.mobile ? ` · ${model.guest.mobile}` : ""}`) : "",
    model.buyer ? detail("Buyer", model.buyer.legalName) : "",
    model.buyer ? detail("Buyer GSTIN", model.buyer.gstin) : "",
    model.buyer && model.buyer.address ? detail("Buyer address", model.buyer.address) : "",
    model.buyer && model.buyer.state ? detail("Buyer state", model.buyer.state) : "",
    model.placeOfSupply && seller.gstin ? detail("Place of supply", model.placeOfSupply) : "",
    model.sac ? detail("SAC", `${model.sac} (restaurant service)`) : "",
  ].join("");

  const items = itemRows(model.items, narrow);

  const totals = model.totals
    .map((row) => {
      if (row.key === "total") {
        return line(
          row.label,
          moneyExact(row.amount, model.currency),
          "font-weight:bold;font-size:14px;border-top:1px dashed #000"
        );
      }

      if (row.key === "subtotal") {
        return line(row.label, two(row.amount), "font-weight:bold");
      }

      return line(row.label, row.key === "paid" || row.key === "due" ? two(row.amount) : signed(row.amount));
    })
    .join("");

  const payments = model.payments.length
    ? `<table class="w t">${model.payments
        .map((payment) =>
          line(
            `Paid by ${payment.method}${payment.reference ? ` (${payment.reference})` : ""}`,
            `${two(payment.amount)}${payment.change > 0 ? ` · change ${two(payment.change)}` : ""}`
          ) + (payment.tip > 0 ? line("  Tip (for the staff)", two(payment.tip)) : "")
        )
        .join("")}</table>`
    : "";

  // Scan to pay: the exact amount due, in any UPI app. The cashier still
  // records the payment (with the UTR) when it arrives.
  const upi = model.upiLink
    ? `<div class="c qr"><div class="qr-box">${qrSvg(model.upiLink, { label: "Scan to pay by UPI" })}</div>
       <div class="s b">Scan to pay ${escape(moneyExact(bill.dueAmount, model.currency))} by UPI</div>
       <div class="s">${escape(bill.upi.vpa)}</div></div>`
    : "";

  // The table's own ordering page: the menu, calling staff, feedback.
  const tableQr = model.tableLink
    ? `<div class="c qr"><div class="qr-box">${qrSvg(model.tableLink, { label: "Table QR" })}</div>
       <div class="s">Scan for the menu, to call staff or to tell us how we did</div></div>`
    : "";

  // The guest's points, under what they paid: earned on this bill and what
  // they hold now, so the receipt is also their points statement.
  const points = model.points
    ? `<table class="w t points">${[
        model.points.earned > 0 ? line("Points earned", String(model.points.earned)) : "",
        model.points.balance !== null ? line("Points balance", String(model.points.balance)) : "",
      ].join("")}</table>`
    : "";

  const notes = [...model.notes, ...(settings.documentType === "bill_of_supply" ? [settings.compositionNote || "Composition taxable person, not eligible to collect tax on supplies"] : [])].map((note) => `<div class="c s">${escape(note)}</div>`).join("");

  const itemHead = narrow
    ? `<tr class="b"><td colspan="3">Item · Qty × Rate</td><td class="r">Amount</td></tr>`
    : `<tr class="b"><td>Item</td><td class="r">Qty</td><td class="r">Rate</td><td class="r">Amount</td></tr>`;

  return `
    <div class="paper${narrow ? " narrow" : ""}">
    ${head}
    <table class="w t meta">${meta}</table>
    <table class="w t items">
      ${itemHead}
      ${items}
    </table>
    <table class="w t">${totals}</table>
    ${payments}
    ${points}
    ${upi}
    ${tableQr}
    ${notes}
    <div class="c foot">${escape((settings && settings.billFooter) || "Thank you, please visit again")}</div>
    </div>
  `;
};

const RECEIPT_STYLES = (width) => `
  body {
    font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: ${width < 200 ? 10 : 12}px;
    width: ${width}px;
    margin: 0 auto;
    color: #000;
  }
  @page { margin: 4mm; }
  table { border-collapse: collapse; width: 100%; }
  .items td:first-child { overflow-wrap: anywhere; }
  td { padding: 1px 0; vertical-align: top; }
  .w { width: 100%; }
  .t { border-top: 1px dashed #000; margin-top: 4px; padding-top: 2px; }
  .items td:first-child { padding-right: 4px; }
  .items td + td { padding-left: 6px; }
  .r { text-align: right; white-space: nowrap; }
  .meta { table-layout: fixed; }
  .meta .k { width: 34%; padding-right: 4px; }
  .meta .v { text-align: right; overflow-wrap: anywhere; word-break: break-word; }
  .narrow .meta .k { width: 40%; }
  .narrow .item-name { font-weight: bold; padding-top: 3px; }
  .narrow .item-qty { padding-left: 8px; }
  .c { text-align: center; }
  .b { font-weight: bold; }
  .s { font-size: 11px; }
  .big { font-size: 15px; }
  .logo { max-width: 70%; max-height: 60px; object-fit: contain; }
  .title { margin-top: 6px; letter-spacing: 1px; text-transform: uppercase; }
  .dup { margin: 4px 0; font-size: 14px; border: 1px solid #000; padding: 2px; }
  .foot { margin-top: 10px; }
  .qr { margin-top: 8px; border-top: 1px dashed #000; padding-top: 6px; }
  .qr-box { width: ${width < 200 ? 120 : width < 300 ? 150 : 170}px; margin: 0 auto 2px; }
  .qr-box svg { display: block; width: 100%; height: auto; }
`;

const printPaper = (title, receipt, settings) => {
  const paper = (settings && settings.printPaperWidth) || "80mm";
  const width = PAPER_WIDTHS[paper] || PAPER_WIDTHS["80mm"];
  const copies = Math.min(Math.max((settings && settings.printCopies) || 1, 1), 5);

  // Copies are repeated inside one document with a page break between, so the
  // till shows a single print dialog and the printer does the rest. Calling
  // print() twice would ask the cashier twice.
  const body = Array.from({ length: copies })
    .map(
      (ignored, index) =>
        `<section${index > 0 ? ' style="break-before:page;page-break-before:always"' : ""}>${receipt}</section>`
    )
    .join("");

  printDocument({ title, styles: RECEIPT_STYLES(width), body });
};

// Prints a bill. Every print must be counted first (bill.service
// registerPrint, or printCountedBill in services/billPrint.js), so what is
// printed carries its print count and says DUPLICATE on a reprint.
export const printBill = (bill, options = {}) => {
  if (!bill || !Array.isArray(bill.items)) {
    return;
  }

  printPaper(bill.billNumber, buildReceipt(bill, options), options.settings || null);
};

// A credit note, printed for the guest who got money back.
export const buildCreditNote = (bill, note, options = {}) => {
  const settings = options.settings || {};
  const model = receiptModel(bill, options);
  const { seller } = model;
  const gstSplit = settings.gstSplit !== false;

  const taxes = (note.taxes || [])
    .map((tax) => {
      const rows = [];

      if (gstSplit) {
        rows.push(line(`CGST @${rate(tax.cgstRate ?? num(tax.taxPercentage) / 2)}`, two(tax.cgst)));
        rows.push(line(`SGST @${rate(tax.sgstRate ?? num(tax.taxPercentage) / 2)}`, two(tax.sgst)));
      } else {
        rows.push(line(`GST @${rate(tax.taxPercentage)}`, two(num(tax.cgst) + num(tax.sgst))));
      }

      if (num(tax.cess) > 0) {
        rows.push(line(`Cess @${rate(tax.cessPercentage)}`, two(tax.cess)));
      }

      return rows.join("");
    })
    .join("");

  const items = (note.items || [])
    .map((item) =>
      line(`${item.itemName}${item.variantName ? ` (${item.variantName})` : ""} × ${item.quantity}`, two(item.amount))
    )
    .join("");

  return `
    <div class="c b big">${escape(seller.name || "")}</div>
    ${seller.address ? `<div class="c s">${escape(seller.address)}</div>` : ""}
    ${seller.gstin ? `<div class="c s">GSTIN: ${escape(seller.gstin)}</div>` : ""}
    <div class="c b title">CREDIT NOTE</div>
    <table class="w t meta">
      ${detail("Credit note", note.number)}
      ${detail("Date", when(note.issuedAt, settings.timezone))}
      ${detail("Against bill", `${bill.billNumber} of ${when(bill.billedAt, settings.timezone)}`)}
      ${model.buyer ? detail("Buyer", model.buyer.legalName) : ""}
      ${model.buyer ? detail("Buyer GSTIN", model.buyer.gstin) : ""}
      ${detail("Reason", note.reason)}
    </table>
    ${items ? `<table class="w t">${items}</table>` : ""}
    <table class="w t">
      ${line("Taxable value", two(note.taxableValue))}
      ${taxes}
      ${num(note.roundOff) !== 0 ? line("Round off", signed(num(note.roundOff))) : ""}
      ${line("TOTAL CREDITED", moneyExact(note.totalAmount, model.currency), "font-weight:bold;font-size:14px;border-top:1px dashed #000")}
      ${note.refundMethod ? line("Paid back by", METHOD_WORDS[note.refundMethod] || note.refundMethod) : ""}
    </table>
  `;
};

export const printCreditNote = (bill, note, options = {}) => {
  if (!bill || !note) {
    return;
  }

  printPaper(note.number, buildCreditNote(bill, note, options), { ...(options.settings || {}), printCopies: 1 });
};
