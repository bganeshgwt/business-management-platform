// What each report puts in its CSV. Every file starts with the report's name,
// the period and the outlet, so a sheet opened a month later still says what
// it is; money is written as plain two-decimal numbers so Excel adds it up.
import { orderTypeLabel, paymentMethodLabel } from "../../../../services/labels.js";
import { csvHeader, csvMoney, gstDate } from "./reportFormat.js";

const m = csvMoney;

// --- GST filing pack --------------------------------------------------------
//
// The GSTR-1 tables use the column headings of the GST portal's offline tool,
// so an accountant can paste them straight in.

const stateOf = (data) => data.placeOfSupply;

const gstSections = {
  summary: (data) => ({
    name: "gstr1-summary",
    title: "GSTR-1 summary",
    rows: [
      ["Table", "Invoices", "Taxable value", "CGST", "SGST", "Cess", "Total tax"],
      [
        "B2B",
        data.b2b.summary.reduce((sum, row) => sum + row.invoiceCount, 0),
        m(data.b2b.totals.taxableValue),
        m(data.b2b.totals.cgst),
        m(data.b2b.totals.sgst),
        m(data.b2b.totals.cess),
        m(data.b2b.totals.taxAmount),
      ],
      ["B2C (others)", "", m(data.b2c.totals.taxableValue), m(data.b2c.totals.cgst), m(data.b2c.totals.sgst), m(data.b2c.totals.cess), m(data.b2c.totals.taxAmount)],
      ["Nil rated / exempt", "", m(data.nilExempt.reduce((sum, row) => sum + row.nilRatedOrExempt, 0)), 0, 0, 0, 0],
      ...(data.untaxedServiceCharge > 0
        ? [["Service charge billed without GST", "", m(data.untaxedServiceCharge), 0, 0, 0, 0]]
        : []),
      [
        "Invoices in the period",
        data.registerTotals.invoices,
        m(data.registerTotals.taxableValue),
        m(data.registerTotals.cgst),
        m(data.registerTotals.sgst),
        m(data.registerTotals.cess),
        m(data.registerTotals.taxAmount),
      ],
      [
        "Less credit notes",
        data.creditNotes.totals.count,
        m(-data.creditNotes.totals.taxableValue),
        m(-data.creditNotes.totals.cgst),
        m(-data.creditNotes.totals.sgst),
        m(-data.creditNotes.totals.cess),
        m(-data.creditNotes.totals.taxAmount),
      ],
      ["Net for the period", "", m(data.net.taxableValue), m(data.net.cgst), m(data.net.sgst), m(data.net.cess), m(data.net.taxAmount)],
    ],
  }),

  // Bill by bill: the register an accountant ties the return to.
  register: (data) => ({
    name: "sales-register",
    title: "Sales register",
    rows: [
      [
        "Invoice number",
        "Invoice date",
        "Status",
        "Order type",
        "Buyer GSTIN",
        "Buyer name",
        "Taxable value",
        "CGST",
        "SGST",
        "Cess",
        "Total tax",
        "Service charge (in taxable value)",
        "Round off",
        "Invoice value",
        "Note",
      ],
      ...data.register.map((row) => [
        row.invoiceNumber,
        gstDate(row.invoiceDate),
        row.status === "cancelled" ? "Cancelled" : "Issued",
        orderTypeLabel(row.orderType),
        row.recipientGstin || "",
        row.recipientName || "",
        m(row.taxableValue),
        m(row.cgst),
        m(row.sgst),
        m(row.cess),
        m(row.taxAmount),
        m(row.serviceCharge),
        m(row.roundOff),
        m(row.invoiceValue),
        row.status === "cancelled" ? `Voided: ${row.reason || ""} (was ${row.voidedValue})` : "",
      ]),
      [],
      [
        "Total",
        "",
        `${data.registerTotals.invoices} issued`,
        `${data.registerTotals.cancelled} cancelled`,
        "",
        "",
        m(data.registerTotals.taxableValue),
        m(data.registerTotals.cgst),
        m(data.registerTotals.sgst),
        m(data.registerTotals.cess),
        m(data.registerTotals.taxAmount),
        m(data.registerTotals.serviceCharge),
        m(data.registerTotals.roundOff),
        m(data.registerTotals.invoiceValue),
        "",
      ],
    ],
  }),

  b2b: (data) => ({
    name: "gstr1-b2b",
    title: "GSTR-1 B2B",
    plain: true,
    rows: [
      [
        "GSTIN/UIN of Recipient",
        "Receiver Name",
        "Invoice Number",
        "Invoice date",
        "Invoice Value",
        "Place Of Supply",
        "Reverse Charge",
        "Applicable % of Tax Rate",
        "Invoice Type",
        "E-Commerce GSTIN",
        "Rate",
        "Taxable Value",
        "Cess Amount",
      ],
      ...data.b2b.invoices.map((row) => [
        row.gstin,
        row.recipientName || "",
        row.invoiceNumber,
        gstDate(row.invoiceDate),
        m(row.invoiceValue),
        row.placeOfSupply,
        "N",
        "",
        "Regular B2B",
        "",
        Number(row.rate),
        m(row.taxableValue),
        m(row.cess),
      ]),
    ],
  }),

  // Filed net of the refunds given to consumers, rate by rate.
  b2c: (data) => ({
    name: "gstr1-b2cs",
    title: "GSTR-1 B2CS",
    plain: true,
    rows: [
      ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
      ...(data.b2c.net || data.b2c.rows).map((row) => [
        "OE",
        stateOf(data),
        "",
        Number(row.rate),
        m(row.taxableValue),
        m(row.cess),
        "",
      ]),
    ],
  }),

  hsn: (data) => ({
    name: "gstr1-hsn",
    title: "GSTR-1 HSN summary",
    plain: true,
    rows: [
      [
        "Supply",
        "HSN",
        "Description",
        "UQC",
        "Total Quantity",
        "Total Value",
        "Rate",
        "Taxable Value",
        "Integrated Tax Amount",
        "Central Tax Amount",
        "State/UT Tax Amount",
        "Cess Amount",
      ],
      ...data.hsn.rows.map((row) => [
        row.supply === "b2b" ? "B2B" : "B2C",
        row.hsnCode === "—" ? "" : row.hsnCode,
        row.description || "",
        row.uqc,
        row.uqc === "NA" ? 0 : row.quantity,
        m(row.totalValue),
        Number(row.rate),
        m(row.taxableValue),
        0,
        m(row.cgst),
        m(row.sgst),
        m(row.cess),
      ]),
    ],
  }),

  // To registered buyers: filed note by note (CDNR). To consumers: netted in
  // B2CS above, listed here for the record.
  credit: (data) => ({
    name: "credit-notes",
    title: "Credit notes",
    rows: [
      [
        "Supply",
        "GSTIN/UIN of Recipient",
        "Receiver Name",
        "Note reference",
        "Note Date",
        "Note Type",
        "Against invoice",
        "Invoice date",
        "Place Of Supply",
        "Note Value",
        "Taxable Value",
        "CGST",
        "SGST",
        "Cess Amount",
        "Reason",
      ],
      ...data.creditNotes.rows.map((row) => [
        row.supply === "b2b" ? "CDNR (registered)" : "B2C (netted in B2CS)",
        row.recipientGstin || "",
        row.recipientName || "",
        row.creditNoteNumber || `Refund ${row.refundId} (before credit notes; GST worked out)`,
        gstDate(row.noteDate),
        "C",
        row.invoiceNumber,
        gstDate(row.invoiceDate),
        stateOf(data),
        m(row.noteValue),
        m(row.taxableValue),
        m(row.cgst),
        m(row.sgst),
        m(row.cess),
        row.reason || "",
      ]),
    ],
  }),

  documents: (data) => ({
    name: "gstr1-docs",
    title: "GSTR-1 documents issued",
    plain: true,
    rows: [
      ["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"],
      // Invoice series, then credit-note series: GSTR-1 table 13 lists both.
      ...data.documents.map((row) => [
        row.nature || "Invoices for outward supply",
        row.fromNumber || "",
        row.toNumber || "",
        row.totalIssued,
        row.cancelled,
      ]),
    ],
  }),
};

// One GST file. The portal-shaped ones (plain) carry no title block, because
// the offline tool reads the first line as its headings.
// The file name carries the GSTIN when the restaurant files more than one
// return, so two branches' files never pass for each other.
export const gstCsv = (data, section) => {
  const file = gstSections[section](data);
  const rows = file.plain ? file.rows : [...csvHeader(file.title, data), ...file.rows];
  const registration = (data.registrations || []).length > 1 && data.gstNumber ? `-${data.gstNumber}` : "";

  return { rows, name: `${file.name}${registration}-${data.from}-to-${data.to}.csv` };
};

// --- Day book (Tally) ---------------------------------------------------------

// "23-09-2026", the date form Tally's importers read.
const tallyDate = (value) => {
  const [year, month, day] = String(value).split("-");
  return `${day}-${month}-${year}`;
};

// One line per ledger entry. Both an "Amount + Dr/Cr" pair and separate
// Debit and Credit columns, so it fits either kind of Excel-to-Tally mapper.
// Every voucher number is unique; "Reference No" carries the other side's own
// number (a supplier's bill number — Tally's "Supplier Invoice No.").
export const dayBookCsv = (data) => [
  ["Date", "Voucher Type", "Voucher No", "Reference No", "Ledger Name", "Amount", "Dr/Cr", "Debit", "Credit", "Narration"],
  ...data.vouchers.flatMap((voucher) =>
    voucher.entries.map((entry, index) => [
      tallyDate(voucher.date),
      voucher.type,
      voucher.number,
      voucher.reference || "",
      entry.ledger,
      m(entry.debit || entry.credit),
      entry.debit ? "Dr" : "Cr",
      entry.debit ? m(entry.debit) : "",
      entry.credit ? m(entry.credit) : "",
      index === 0 ? voucher.narration : "",
    ])
  ),
];

export const ledgerCsv = (data) => [
  ["Ledger Name", "Under (group)"],
  ...data.ledgers.map((row) => [row.ledger, row.group]),
];

// --- Profit & loss, expenses ------------------------------------------------------

export const profitLossCsv = (data) => [
  ...csvHeader(`Profit & loss (food cost from ${data.basis === "purchases" ? "supplier bills" : "stock used"})`, data),
  ["Line", ...data.months.map((month) => month.label + (month.partial ? " (part)" : "")), "Total"],
  ...data.lines.map((line) => [line.label, ...line.byMonth.map(m), m(line.amount)]),
  [],
  ...(data.warnings || []).map((warning) => [warning]),
  ...data.notes.map((note) => [note]),
];

export const expenseCsv = (data) => [
  ...csvHeader("Expenses by category (approved)", data),
  ["Category", "Entries", ...data.months.map((month) => month.label), "Total", "Share %"],
  ...data.categories.map((row) => [row.categoryName, row.count, ...row.byMonth.map(m), m(row.amount), row.share]),
  ["Total", data.approvedCount, ...data.byMonth.map((month) => m(month.amount)), m(data.total), 100],
  [],
  ["Waiting for approval", data.pending.count, m(data.pending.amount)],
  ["Rejected", data.rejected.count, m(data.rejected.amount)],
  // One outlet picked: the restaurant-wide expenses and its share of them,
  // as the P&L charges them.
  ...(data.shared
    ? [
        [],
        [`Recorded for the whole restaurant — ${data.outletName}'s share (${data.shared.percent}%)`],
        ["Category", "Entries", "Whole restaurant", "Share"],
        ...data.shared.categories.map((row) => [row.categoryName, row.count, m(row.amount), m(row.share)]),
        ["Total", data.shared.count, m(data.shared.total), m(data.shared.share)],
        ...(data.shared.notes || []).map((note) => [note]),
      ]
    : []),
];

// --- Theft control -------------------------------------------------------------

export const theftCsv = (data) => [
  ...csvHeader("Theft control", data),
  [
    "Staff member",
    "Voids",
    "Void value",
    "Refunds",
    "Refund value",
    "Large discounts",
    "Discount value",
    "Bills reprinted",
    "Extra prints",
    "Dishes off after KOT",
    "Value off after KOT",
    "Of which served",
    "Days closed short",
    "Cash short",
    "Money at stake",
  ],
  ...data.staff.map((row) => [
    row.userName,
    row.voids.count,
    m(row.voids.value),
    row.refunds.count,
    m(row.refunds.value),
    row.discounts.count,
    m(row.discounts.value),
    row.reprints.bills,
    row.reprints.prints,
    row.removedAfterKot.count,
    m(row.removedAfterKot.value),
    row.removedAfterKot.served,
    row.cashShort.days,
    m(row.cashShort.amount),
    m(row.exposure),
  ]),
  [],
  ["Voided bills (latest)"],
  ["Bill", "Business day", "Value", "Reason", "By", "Approved by", "Voided after day closed"],
  ...data.voids.map((row) => [
    row.billNumber,
    row.businessDate,
    m(row.amount),
    row.reason || "",
    row.byName || "",
    row.approvedBy || "",
    row.afterClose ? "Yes" : "",
  ]),
  [],
  ["Dishes taken off after the KOT (latest)"],
  ["Order", "Dish", "Qty", "Value", "Kitchen stage", "Reason", "By", "Approved by", "Part of voided bill"],
  ...data.removed.map((row) => [
    row.orderNumber,
    row.itemName,
    row.quantity,
    m(row.amount),
    row.kitchenStage || "",
    row.reasonNote || row.reasonCode || "",
    row.byName || "",
    row.approvedBy || "",
    // Counted once, under voids; not in the totals above.
    row.coveredByVoid ? row.voidedBill : "",
  ]),
];

// --- The older reports ------------------------------------------------------------

export const salesCsv = (data) => [
  ...csvHeader("Sales summary", data),
  ["Date", "Bills", "Net sales", "Discounts", "Average bill"],
  ...data.byDay.map((row) => [row.businessDate, row.billCount, m(row.netSales), m(row.discounts), m(row.averageBill)]),
  [],
  ["Covers (dine-in guests)", data.summary.covers],
  ["Spend per head (dine-in)", m(data.summary.perHead)],
  ["Delivery charges (before tax)", m(data.summary.deliveryCharges || 0)],
  ["GST on delivery charges", m(data.summary.deliveryChargeTax || 0)],
  ["Tips given on top (not sales)", m(data.summary.tips || 0)],
  [],
  ["Payment method", "Payments", "Amount", "Tips"],
  ...data.byPaymentMode.map((row) => [row.paymentMethod, row.paymentCount, m(row.amount), m(row.tips || 0)]),
  ...((data.byPaymentType || []).length
    ? [[], ["Payment type", "Method", "Payments", "Amount"], ...data.byPaymentType.map((row) => [row.paymentTypeName, row.paymentMethod, row.paymentCount, m(row.amount)])]
    : []),
];

// Dish profitability (SW-B-15), dish by dish, with the totals.
export const profitabilityCsv = (data) => [
  ...csvHeader("Dish profitability", data),
  ["Dish", "Size", "Has recipe", "Sold", "Sales before GST", "Cost a plate", "Food cost", "Food cost %", "Left a plate", "Left in all"],
  ...data.dishes.map((row) => [
    row.itemName,
    row.variantName || "",
    row.hasRecipe ? "yes" : "no",
    row.quantity,
    m(row.sales),
    m(row.costPerPortion),
    m(row.foodCost),
    row.foodCostPercent === null ? "" : row.foodCostPercent,
    m(row.contributionPerPortion),
    m(row.contribution),
  ]),
  ["Total", "", "", "", m(data.totals.sales), "", m(data.totals.foodCost), data.totals.foodCostPercent ?? "", "", m(data.totals.contribution)],
];

export const itemsCsv = (data) => [
  ...csvHeader("Item & category sales", data),
  ["Item", "Category", "Price", "Plates", "Orders", "Revenue", "Last sold"],
  ...data.menu.map((row) => [
    row.itemName,
    row.categoryName,
    m(row.price),
    row.quantity,
    row.orderCount,
    m(row.grossSales),
    row.lastSold || "never",
  ]),
  [],
  ["Item", "Category", "Quantity", "Net sales", "Tax", "Gross sales"],
  ...data.items.map((row) => [row.itemName, row.categoryName, row.quantity, m(row.netSales), m(row.tax), m(row.grossSales)]),
  [
    `Total (${data.itemTotals.lines} ${data.itemTotals.lines === 1 ? "line" : "lines"})`,
    "",
    data.itemTotals.quantity,
    m(data.itemTotals.netSales),
    m(data.itemTotals.tax),
    m(data.itemTotals.grossSales),
  ],
  [],
  ["Add-on", "Plates with it", "Bills", "Value sold"],
  ...(data.addons || []).map((row) => [row.addonName, row.quantity, row.billCount, m(row.value)]),
];

export const staffCsv = (data) => [
  ...csvHeader("Staff: who took the orders, who billed them", data),
  ["Captain / waiter (order taken by)", "Orders", "Covers", "Per head", "Plates", "Net sales", "Dine-in", "Takeaway", "Delivery", "Dishes off after KOT", "Value off", "Off with a voided bill (not counted)"],
  ...data.waiters.rows.map((row) => [
    row.userName,
    row.orderCount,
    row.covers,
    m(row.perHead),
    row.plates,
    m(row.netSales),
    m(row.dineInSales),
    m(row.takeawaySales),
    m(row.deliverySales),
    row.removedAfterKot,
    m(row.removedValue),
    row.removedWithVoid || 0,
  ]),
  [],
  ["Cashier (bill raised by)", "Bills", "Net sales", "Average bill"],
  ...data.rows.map((row) => [row.userName, row.billCount, m(row.netSales), m(row.averageBill)]),
];

export const outletsCsv = (data) => [
  ...csvHeader("Outlet comparison", { ...data, outletName: "All outlets (always)" }),
  ["Outlet", "Code", "Bills", "Covers", "Per head", "Net sales", "Share %", "Tax", "Discounts", "Average bill"],
  ...data.outlets.map((row) => [
    row.outletName,
    row.outletCode || "",
    row.billCount,
    row.guests,
    m(row.perHead),
    m(row.netSales),
    row.share,
    m(row.tax),
    m(row.discounts),
    m(row.averageBill),
  ]),
];

// What took the money off a bill, as the Discounts report groups it.
export const DISCOUNT_KINDS = {
  coupon: "Coupon",
  till: "Given at the till",
  points: "Points redeemed",
  complimentary: "No charge",
  other: "Older bill",
};

export const discountsCsv = (data) => [
  ...csvHeader("Discounts", data),
  ["Kind", "Discount", "Bills", "Points", "Discount total", "Sales on those bills"],
  ...data.rows.map((row) => [
    DISCOUNT_KINDS[row.kind] || "Discount",
    row.label || row.discountCode,
    row.timesUsed,
    row.kind === "points" ? row.points : "",
    m(row.discountTotal),
    m(row.netSales),
  ]),
];


export const consumptionCsv = (data) => [
  ...csvHeader("Stock consumption", data),
  ["Item", "Unit", "Purchased", "Purchase value", "Used", "Used value", "Wasted", "Waste value", "In stock"],
  ...data.rows.map((row) => [
    row.itemName,
    row.unitShortName,
    row.purchased,
    m(row.purchaseValue),
    row.consumed,
    m(row.consumedValue),
    row.wasted,
    m(row.wastedValue),
    row.currentStock,
  ]),
];

export const cancellationsCsv = (data) => [
  ...csvHeader("Cancellations & voids", data),
  ["Type", "Reference", "Order", "Business day", "Value", "Reason", "By", "Approved by", "When"],
  ...data.cancelledOrders.map((row) => [
    "Cancelled order",
    row.orderNumber,
    orderTypeLabel(row.orderType),
    row.businessDate,
    m(row.amount),
    row.reason || "",
    row.byName || "",
    row.approvedBy || "",
    row.cancelledAt,
  ]),
  ...data.voidedBills.map((row) => [
    "Voided bill",
    row.billNumber,
    row.orderNumber,
    row.businessDate,
    m(row.amount),
    row.reason || "",
    row.byName || "",
    row.approvedBy || "",
    row.voidedAt,
  ]),
];

export const dayEndCsv = (data) => [
  ["Day end", data.businessDate],
  ["Outlet", data.outletName || "All outlets"],
  ["Status", data.dayStatus],
  [],
  ["Line", "Amount"],
  ["Bills", data.billCount],
  ["Invoice numbers", `${data.firstBill || ""} to ${data.lastBill || ""}`],
  ["Gross sales (before tax)", m(data.grossSales)],
  ["Discounts", m(data.discounts)],
  ["Service charge", m(data.serviceCharge)],
  ["CGST", m(data.cgst)],
  ["SGST", m(data.sgst)],
  ["Cess", m(data.cess)],
  ["Total tax", m(data.tax)],
  ["Round off", m(data.roundOff)],
  ["Net sales", m(data.netSales)],
  ["Refunds", m(data.totalRefunds)],
  ["Voided bills", data.voidCount, m(data.voidValue)],
  ["Cancelled orders", data.cancelledOrders, m(data.cancelledValue)],
  ["Covers", data.covers],
  ["Per head (dine-in)", m(data.perHead)],
  ["Expenses", m(data.totalExpenses)],
  [],
  ...(data.wholeDrawer
    ? [
        ["Cash drawer", "Opening", "Cash sales", "Cash refunds", "Cash expenses", "Paid to suppliers", "Expected", "Counted", "Difference"],
        ...(data.drawers && data.drawers.length ? data.drawers : [{ ...data, label: data.outletName || "Main counter" }]).map((drawer) => [
          drawer.label,
          m(drawer.openingCash),
          m(drawer.cashSales),
          m(drawer.cashRefunds),
          m(drawer.cashExpenses),
          m(drawer.supplierCash),
          m(drawer.expectedCash),
          drawer.closingCash === null ? "not closed" : m(drawer.closingCash),
          drawer.closingCash === null ? "" : m(drawer.variance),
        ]),
        ...(data.drawers && data.drawers.length > 1
          ? [
              [
                "All drawers",
                m(data.openingCash),
                m(data.cashSales),
                m(data.cashRefunds),
                m(data.cashExpenses),
                m(data.supplierCash),
                m(data.expectedCash),
                data.closingCash === null ? "not all closed" : m(data.closingCash),
                data.closingCash === null ? "" : m(data.variance),
              ],
            ]
          : []),
      ]
    : [["Cash drawer", "Amount"], ["Cash taken at this outlet", m(data.cashSales)]]),
  [],
  ["Method", "Amount"],
  ...data.byMethod.map((row) => [paymentMethodLabel(row.paymentMethod), m(row.amount)]),
];

