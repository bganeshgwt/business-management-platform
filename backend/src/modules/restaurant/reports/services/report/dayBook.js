// Day book (accounting vouchers).
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const gst = require("../../../billing/services/gstBreakdown");
const { countOf } = require("./common");
const { describe, scopeFor } = require("./scope");
const { gstinFor, loadGstData, seriesOf, taxableLines } = require("./gstData");

// ---------------------------------------------------------------------------
// Day book: an accountant's / Tally import
// ---------------------------------------------------------------------------

// Money received from guests before their bill (advances and deposits): a
// liability until it is used on a bill or handed back.
const ADVANCES_LEDGER = "Advances from customers";

// Cash a rider did not hand in: owed by him (a ledger per rider, as two
// riders can share a name), or written off by a manager.
const riderLedger = (name, id) => `Rider ${name || "rider"} (owes cash, staff ${id})`;

const RIDER_WRITE_OFF_LEDGER = "Rider cash shortfall written off";

// The ledger each payment method posts to. A Tally operator maps these names
// to their own ledgers once; after that the file imports as it is.
const MODE_LEDGERS = {
  cash: "Cash",
  card: "Card receipts (bank)",
  upi: "UPI receipts (bank)",
  online: "Online payments (bank)",
  wallet: "Wallet receipts (bank)",
  bank: "Bank",
  cheque: "Bank",
  credit: "Sundry creditors",
  other: "Other receipts",
  // A bill paid from an advance, or a refund put back onto one: the guest's
  // advance is used (or owed again), no money moves.
  advance: ADVANCES_LEDGER,
};

const modeLedger = (mode, typeName = null) => {
  // An owner-named payment type (a meal card, a cheque) is a ledger of its
  // own, beside its method's: what the card company settles is checked
  // against it.
  if (typeName && mode !== "advance") {
    return `${typeName} (${mode === "cash" ? "cash" : "bank"})`;
  }

  return MODE_LEDGERS[mode] || `${String(mode || "other").replace(/^\w/, (c) => c.toUpperCase())} (bank)`;
};

// Which Tally group each ledger belongs in, for creating the masters.
const LEDGER_GROUPS = [
  [/^Sales @/, "Sales Accounts"],
  [/^Sales returns @/, "Sales Accounts"],
  [/^Service charge/, "Sales Accounts"],
  [/^Output (CGST|SGST|tax|cess)/, "Duties & Taxes"],
  [/^Input (CGST|SGST|IGST|tax)/, "Duties & Taxes"],
  [/^Round off/, "Indirect Expenses"],
  [/^Rider .*\(owes cash/, "Loans & Advances (Asset)"],
  [/^Rider cash shortfall written off$/, "Indirect Expenses"],
  [/^Cash$|\(cash\)$/, "Cash-in-Hand"],
  [/^Advances from customers$/, "Current Liabilities"],
  [/\(bank\)$|^Bank$/, "Bank Accounts"],
  [/^Counter sales/, "Sundry Debtors"],
  [/^Purchases|^Purchase returns/, "Purchase Accounts"],
  [/^Salaries/, "Indirect Expenses"],
];

const ratePart = (rate) => `${Number(rate)}%`;

// Adds an entry, merging it with one to the same ledger on the same side.
// `reference`: the other side's document number (a supplier's own bill
// number), which Tally keeps apart from the voucher number.
const voucher = (date, type, number, party, narration, reference = null) => {
  const entries = new Map();

  return {
    debit(ledger, paise) {
      if (paise === 0) {
        return;
      }

      const entry = entries.get(ledger) || { ledger, debit: 0, credit: 0 };
      entry.debit += paise;
      entries.set(ledger, entry);
    },
    credit(ledger, paise) {
      if (paise === 0) {
        return;
      }

      const entry = entries.get(ledger) || { ledger, debit: 0, credit: 0 };
      entry.credit += paise;
      entries.set(ledger, entry);
    },
    // Negative amounts swap sides: a negative round off is a debit.
    post(ledger, paise, side) {
      if (paise < 0) {
        this[side === "debit" ? "credit" : "debit"](ledger, -paise);
      } else {
        this[side](ledger, paise);
      }
    },
    done() {
      const list = [...entries.values()].map((entry) => {
        // One side per ledger line, as Tally expects.
        const net = entry.debit - entry.credit;
        return { ledger: entry.ledger, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      }).filter((entry) => entry.debit !== 0 || entry.credit !== 0);

      // The voucher's amount is what the party's ledger moved by: a ₹271.00
      // invoice is a ₹271.00 sales voucher even though its −0.13 round off
      // makes the debit side ₹271.13. The debit side is the fallback for a
      // voucher whose party is not one of its ledgers.
      const partyLine = list.find((entry) => entry.ledger === party);
      const amount = partyLine
        ? partyLine.debit + partyLine.credit
        : list.reduce((sum, entry) => sum + entry.debit, 0);

      return { date, type, number, reference, party, narration, amount, entries: list };
    },
  };
};

const postSales = (entry, breakdown, side = "credit", prefix = "Sales") => {
  for (const line of breakdown.lines) {
    entry.post(`${prefix} @ ${ratePart(line.rate)}`, line.taxable, side);
  }

  entry.post(prefix === "Sales" ? "Service charge" : "Service charge (returned)", breakdown.serviceCharge.value, side);

  // GST by rate, the service charge's GST at the rate of the food it was on,
  // and cess on a ledger of its own — the same per-line figures the GST pack
  // files, so the ledgers match it.
  for (const line of taxableLines(breakdown)) {
    if (line.tax !== 0) {
      entry.post(`Output CGST @ ${ratePart(line.rate / 2)}`, line.cgst, side);
      entry.post(`Output SGST @ ${ratePart(line.rate / 2)}`, line.tax - line.cgst, side);
    }

    if (line.cess) {
      entry.post(`Output cess @ ${ratePart(line.cessRate)}`, line.cess, side);
    }
  }

  entry.post("Round off", breakdown.roundOff, side);
};

const COUNTER = "Counter sales (walk-in guests)";

// The ledger a bill's money is posted to, from the bill itself (so a sale,
// the money collected for it on any later day, and a credit note against it
// all meet in one ledger):
//   a B2B invoice      its buyer, with the GSTIN       "Bluewave Tech Pvt Ltd (37AAGCB7383J1Z7)"
//   on an account      that guest's or company's own   "Arjun Rao (account 912)"
//   anything else      the walk-in guests' ledger      "Counter sales (walk-in guests)"
// An account's ledger carries the guest's number because two regulars can
// share a name, and one ledger for both would mix up what each owes.
const partyOfBill = (row) =>
  row.recipient_gstin
    ? `${row.recipient_name || "Company guest"} (${row.recipient_gstin})`
    : row.account_customer_id
      ? `${row.account_name || "Guest"} (account ${row.account_customer_id})`
      : COUNTER;

// "Day's sales to walk-in guests: 33 bills, VC-0001 to VC-0016, VC-BR-0001 to
// VC-BR-0012": each invoice series its own first and last number. Outlets
// number their own series, so one "first to last" across them said nothing.
const billRangeText = (series) =>
  [...series.values()]
    .map((one) => (one.first === one.last ? one.first : `${one.first} to ${one.last}`))
    .join(", ");

const dayBook = async (
  restaurantId,
  range,
  { outletId = null, canSeePayroll = false, canSeePurchases = false } = {}
) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const [data, money] = await Promise.all([
    loadGstData(context),
    reportRepository.dayBook(context.scope, { withPayroll: canSeePayroll, withPurchases: canSeePurchases }),
  ]);

  const restaurantState = String(gstinFor(context) || "").slice(0, 2);
  const vouchers = [];
  const partyOf = new Map();
  const dayVouchers = new Map();

  // --- Sales ---------------------------------------------------------
  // One voucher per day for walk-in guests; one per invoice for a company
  // guest with a GSTIN, because their invoice is filed on its own, and for a
  // bill put on a guest's or company's account, because what they owe is
  // theirs and must stay on their own ledger until they pay it.
  for (const bill of data.bills) {
    if (bill.bill_status === "void") {
      continue;
    }

    const breakdown = data.breakdownOf(bill);
    const party = partyOfBill(bill);
    partyOf.set(Number(bill.id), party);

    if (party !== COUNTER) {
      const entry = voucher(
        bill.business_date,
        "Sales",
        bill.bill_number,
        party,
        bill.recipient_gstin
          ? `Tax invoice ${bill.bill_number} to ${party}`
          : `Bill ${bill.bill_number} on ${bill.account_name || "the guest"}'s account`
      );
      entry.debit(party, breakdown.total);
      postSales(entry, breakdown);
      vouchers.push(entry.done());
      continue;
    }

    if (!dayVouchers.has(bill.business_date)) {
      dayVouchers.set(bill.business_date, {
        entry: voucher(bill.business_date, "Sales", `S-${bill.business_date.replace(/-/g, "")}`, COUNTER, ""),
        count: 0,
        series: new Map(),
      });
    }

    const day = dayVouchers.get(bill.business_date);
    day.entry.debit(COUNTER, breakdown.total);
    postSales(day.entry, breakdown);
    day.count += 1;

    // Each series' lowest and highest number among the day's bills.
    const { prefix, number } = seriesOf(bill.bill_number);
    const one = day.series.get(prefix);

    if (!one) {
      day.series.set(prefix, { first: bill.bill_number, last: bill.bill_number, low: number, high: number });
    } else {
      if (number !== null && (one.low === null || number < one.low)) {
        one.low = number;
        one.first = bill.bill_number;
      }

      if (number !== null && (one.high === null || number > one.high)) {
        one.high = number;
        one.last = bill.bill_number;
      }
    }
  }

  for (const day of dayVouchers.values()) {
    const done = day.entry.done();
    done.narration =
      day.count === 1
        ? `Day's sales to walk-in guests: 1 bill, ${billRangeText(day.series)}`
        : `Day's sales to walk-in guests: ${day.count} bills, ${billRangeText(day.series)}`;
    vouchers.push(done);
  }

  // Money collected in the range for bills sold before it (dues, a company's
  // monthly account): who those bills were sold to, so the money clears the
  // ledger the sale went to and not the walk-in guests'.
  const outside = [...new Set(money.receipts.map((row) => Number(row.bill_id)))].filter((id) => !partyOf.has(id));

  for (const row of await reportRepository.billParties(restaurantId, outside)) {
    partyOf.set(Number(row.bill_id), partyOfBill(row));
  }

  // --- Receipts: money in, by method -----------------------------------
  const receiptGroups = new Map();

  for (const row of money.receipts) {
    const party = partyOf.get(Number(row.bill_id)) || COUNTER;
    const typeName = row.payment_type_name || null;
    const key = `${row.voucher_date}|${row.payment_method}|${typeName || ""}|${party}`;

    if (!receiptGroups.has(key)) {
      receiptGroups.set(key, { date: row.voucher_date, method: row.payment_method, typeName, party, amount: 0, count: 0 });
    }

    const group = receiptGroups.get(key);
    group.amount += gst.toPaise(row.amount);
    group.count += row.payment_count;
  }

  // One receipt per day, method and party. Numbered per day and method, the
  // walk-in guests' first and each company guest after it: numbered by day
  // and method alone, a company's card payment and the walk-ins' shared one
  // number, and an Excel-to-Tally mapper — which groups rows by voucher
  // number — merged them.
  const receiptList = [...receiptGroups.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      String(a.method).localeCompare(String(b.method)) ||
      (a.party === COUNTER ? -1 : b.party === COUNTER ? 1 : a.party.localeCompare(b.party))
  );
  const receiptSeries = new Map();

  for (const group of receiptList) {
    const base = `R-${group.date.replace(/-/g, "")}-${String(group.method).toUpperCase()}`;
    const seen = (receiptSeries.get(base) || 0) + 1;
    receiptSeries.set(base, seen);

    const entry = voucher(
      group.date,
      "Receipt",
      seen === 1 ? base : `${base}-${seen}`,
      group.party,
      group.method === "advance"
        ? `${countOf(group.count, "bill", "bills")} paid from advances`
        : `${countOf(group.count, `${group.typeName || group.method} payment`, `${group.typeName || group.method} payments`)} received`
    );
    entry.debit(modeLedger(group.method, group.typeName), group.amount);
    entry.credit(group.party, group.amount);
    vouchers.push(entry.done());
  }

  // --- Advances: received (owed to the guest), and handed back -----------
  for (const row of money.advances || []) {
    const amount = gst.toPaise(row.amount);
    const entry = voucher(
      row.voucher_date,
      "Receipt",
      row.receipt_number,
      ADVANCES_LEDGER,
      `Advance from ${row.customer_name} by ${row.payment_type_name || row.payment_method}${row.purpose ? ` — ${row.purpose}` : ""}`
    );
    entry.debit(modeLedger(row.payment_method, row.payment_type_name), amount);
    entry.credit(ADVANCES_LEDGER, amount);
    vouchers.push(entry.done());
  }

  for (const row of money.advanceRefunds || []) {
    const amount = gst.toPaise(row.amount);
    const entry = voucher(
      row.voucher_date,
      "Payment",
      `ADVR-${row.id}`,
      ADVANCES_LEDGER,
      `Advance ${row.receipt_number} handed back to ${row.customer_name} by ${row.payment_type_name || row.refund_method} — ${row.reason}`
    );
    entry.debit(ADVANCES_LEDGER, amount);
    entry.credit(modeLedger(row.refund_method, row.payment_type_name), amount);
    vouchers.push(entry.done());
  }

  // --- Rider cash short, and handed over later -------------------------
  // The receipts took each cash bill a rider settled in full; the drawer got
  // only what he handed in. The difference leaves Cash for what the rider
  // owes (his own ledger), or for a write-off; when he hands it over, it
  // comes back into Cash on the day it went into a drawer.
  for (const row of money.riders || []) {
    const amount = gst.toPaise(row.amount);
    const owedLedger = riderLedger(row.rider_name, row.rider_id);

    if (row.kind === "repaid") {
      const entry = voucher(
        row.voucher_date,
        "Receipt",
        `RDR-${row.id}`,
        owedLedger,
        `Cash short on rider settlement ${row.id} handed over by ${row.rider_name}`
      );
      entry.debit(modeLedger("cash"), amount);
      entry.credit(owedLedger, amount);
      vouchers.push(entry.done());
      continue;
    }

    const writtenOff = row.shortfall_action === "written_off";
    const entry = voucher(
      row.voucher_date,
      "Journal",
      `RDS-${row.id}`,
      writtenOff ? RIDER_WRITE_OFF_LEDGER : owedLedger,
      `Cash short on rider settlement ${row.id} by ${row.rider_name}${writtenOff ? ", written off" : ", owed by the rider"}${
        row.shortfall_reason ? ` — ${row.shortfall_reason}` : ""
      }`
    );
    entry.debit(writtenOff ? RIDER_WRITE_OFF_LEDGER : owedLedger, amount);
    entry.credit(modeLedger("cash"), amount);
    vouchers.push(entry.done());
  }

  // --- Credit notes: the sale given back, with exactly its own GST --------
  for (const row of data.creditNotes) {
    const note = row.breakdown;
    const party = partyOfBill(row);
    const reason = row.refund_reason ? ` — ${row.refund_reason}` : "";

    const credit = voucher(
      row.refund_date,
      "Credit Note",
      row.credit_note_number || `CN-${row.refund_id}`,
      party,
      `${row.note_kind === "return" ? "Dishes returned" : "Refund"} against ${row.bill_number}${reason}`
    );
    postSales(credit, note, "debit", "Sales returns");
    credit.credit(party, note.total);
    vouchers.push(credit.done());
  }

  // --- Money paid back: every refund, credit note or not. A part payment
  // handed back on a bill not yet settled is only money going back out; the
  // sale is unchanged, so it has no credit note.
  for (const row of money.refunds) {
    const amount = gst.toPaise(row.amount);
    const party = partyOfBill(row);
    const paid = voucher(
      row.voucher_date,
      "Payment",
      `RF-${row.id}`,
      party,
      row.refund_kind === "payment_reversal"
        ? `Part payment handed back on ${row.bill_number} by ${row.refund_method}`
        : `Refund paid on ${row.bill_number}${row.credit_note_number ? ` (${row.credit_note_number})` : ""} by ${row.refund_method}`
    );
    paid.debit(party, amount);
    paid.credit(modeLedger(row.refund_method), amount);
    vouchers.push(paid.done());
  }

  // --- Expenses --------------------------------------------------------
  for (const row of money.expenses) {
    const words = [row.notes, row.reference_no && `Ref ${row.reference_no}`, row.supplier_name && `to ${row.supplier_name}`]
      .filter(Boolean)
      .join(" · ");
    const entry = voucher(row.voucher_date, "Payment", `EXP-${row.id}`, row.category_name, words || row.category_name);
    const amount = gst.toPaise(row.amount);
    entry.debit(row.category_name, amount);
    entry.credit(modeLedger(row.payment_mode), amount);
    vouchers.push(entry.done());
  }

  // --- Purchases, returns and supplier payments -------------------------
  const inputTax = (entry, taxPaise, supplierGstin, side) => {
    if (taxPaise === 0) {
      return;
    }

    const sameState = !supplierGstin || !restaurantState || String(supplierGstin).slice(0, 2) === restaurantState;

    if (sameState) {
      const { cgst, sgst } = gst.halves(taxPaise);
      entry.post("Input CGST", cgst, side);
      entry.post("Input SGST", sgst, side);
    } else {
      entry.post("Input IGST", taxPaise, side);
    }
  };

  for (const row of money.purchases) {
    const total = gst.toPaise(row.total_amount);
    const taxable = gst.toPaise(row.taxable_amount);
    const taxPaise = gst.toPaise(row.tax_amount);
    // Numbered by our own goods-received number, which no two bills share;
    // the supplier's bill number goes in as the reference (Tally's
    // "Supplier Invoice No."). Two suppliers both numbering their bill
    // "101" would otherwise have been one voucher.
    const entry = voucher(
      row.voucher_date,
      "Purchase",
      row.receipt_number,
      row.supplier_name,
      `Supplier bill ${row.bill_number || "(no number)"} · ${row.receipt_number}`,
      row.bill_number || null
    );
    entry.debit("Purchases", taxable);
    inputTax(entry, taxPaise, row.supplier_gstin, "debit");
    // Whatever the supplier rounded their bill by.
    entry.post("Round off", total - taxable - taxPaise, "debit");
    entry.credit(row.supplier_name, total);
    vouchers.push(entry.done());
  }

  for (const row of money.returns) {
    const total = gst.toPaise(row.total_amount);
    const taxable = gst.toPaise(row.taxable_amount);
    const taxPaise = gst.toPaise(row.tax_amount);
    // Older returns carry only a total.
    const base = taxable === 0 && taxPaise === 0 ? total : taxable;
    const entry = voucher(
      row.voucher_date,
      "Debit Note",
      row.return_number,
      row.supplier_name,
      `Goods returned${row.reason ? ` — ${row.reason}` : ""}`
    );
    entry.debit(row.supplier_name, total);
    entry.credit("Purchase returns", base);
    inputTax(entry, taxPaise, row.supplier_gstin, "credit");
    entry.post("Round off", total - base - taxPaise, "credit");
    vouchers.push(entry.done());
  }

  for (const row of money.supplierPayments) {
    const amount = gst.toPaise(row.amount);
    const entry = voucher(
      row.voucher_date,
      "Payment",
      `SP-${row.id}`,
      row.supplier_name,
      `Paid to ${row.supplier_name}${row.reference_no ? ` · Ref ${row.reference_no}` : ""}`
    );
    entry.debit(row.supplier_name, amount);
    entry.credit(modeLedger(row.payment_method), amount);
    vouchers.push(entry.done());
  }

  for (const row of money.salaries) {
    const amount = gst.toPaise(row.amount);
    const entry = voucher(
      row.voucher_date,
      "Payment",
      `SAL-${row.id}`,
      "Salaries",
      `Salary to ${row.employee_name}, ${row.period_from} to ${row.period_to}`
    );
    entry.debit("Salaries", amount);
    entry.credit(modeLedger(row.payment_method), amount);
    vouchers.push(entry.done());
  }

  const TYPE_ORDER = ["Sales", "Receipt", "Credit Note", "Payment", "Purchase", "Debit Note"];

  vouchers.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      String(a.number).localeCompare(String(b.number), undefined, { numeric: true })
  );

  // A voucher number is a voucher's identity in an import — mappers group
  // the rows by it — so no two may share one, whatever the documents they
  // came from were numbered.
  const taken = new Set();

  for (const item of vouchers) {
    let number = String(item.number);

    for (let copy = 2; taken.has(number); copy += 1) {
      number = `${item.number}-${copy}`;
    }

    taken.add(number);
    item.number = number;
  }

  const ledgers = new Map();
  const byType = new Map();
  let debit = 0;
  let credit = 0;
  let unbalanced = 0;

  const out = vouchers.map((item) => {
    const voucherDebit = item.entries.reduce((sum, entry) => sum + entry.debit, 0);
    const voucherCredit = item.entries.reduce((sum, entry) => sum + entry.credit, 0);

    debit += voucherDebit;
    credit += voucherCredit;

    if (voucherDebit !== voucherCredit) {
      unbalanced += 1;
    }

    const typeTotal = byType.get(item.type) || { type: item.type, count: 0, amount: 0 };
    typeTotal.count += 1;
    typeTotal.amount += item.amount;
    byType.set(item.type, typeTotal);

    for (const entry of item.entries) {
      if (!ledgers.has(entry.ledger)) {
        const group = LEDGER_GROUPS.find(([pattern]) => pattern.test(entry.ledger));
        ledgers.set(entry.ledger, {
          ledger: entry.ledger,
          group: group
            ? group[1]
            : item.type === "Purchase" || item.type === "Debit Note" || (item.type === "Payment" && item.number.startsWith("SP-"))
              ? "Sundry Creditors"
              : item.type === "Payment" && item.number.startsWith("EXP-")
                ? "Indirect Expenses"
                : "Sundry Debtors",
        });
      }
    }

    return {
      ...item,
      amount: gst.rupees(item.amount),
      entries: item.entries.map((entry) => ({
        ledger: entry.ledger,
        debit: gst.rupees(entry.debit),
        credit: gst.rupees(entry.credit),
      })),
    };
  });

  return {
    ...describe(context),
    vouchers: out,
    totals: {
      vouchers: out.length,
      debit: gst.rupees(debit),
      credit: gst.rupees(credit),
      unbalanced,
      byType: [...byType.values()].map((row) => ({ ...row, amount: gst.rupees(row.amount) })),
    },
    ledgers: [...ledgers.values()].sort((a, b) => a.group.localeCompare(b.group) || a.ledger.localeCompare(b.ledger)),
    salariesIncluded: canSeePayroll,
    purchasesIncluded: canSeePurchases,
    // What this book leaves out, said on screen so a partial book is never
    // posted as the whole one.
    notes: [
      !canSeePurchases &&
        "Supplier bills, goods returned and supplier payments are left out: your role cannot see purchasing.",
      !canSeePayroll && "Salaries paid are left out: your role cannot see salaries.",
      context.scope.outletId &&
        `Only ${context.outlet.name}'s own vouchers: expenses, supplier bills and salaries recorded for the whole restaurant are in the All outlets day book, which is the one to post to Tally.`,
    ].filter(Boolean),
  };
};

module.exports = {
  dayBook,
};
