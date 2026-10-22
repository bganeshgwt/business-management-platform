// GST reports: tax report, GST pack (GSTR-1 tables, document series) and a bill's recipient GSTIN.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const outletRepository = require("../../../setup/repositories/outlet.repository");
const AppError = require("../../../../../utils/AppError");
const { round2 } = require("../../../../../utils/money");
const { gstinState, readGstin } = require("../../../../../utils/gstin");
const gst = require("../../../billing/services/gstBreakdown");
const { countOf, num, requireRestaurantId, rupeeText } = require("./common");
const { describe, scopeFor } = require("./scope");
const tradingDayRules = require("../../../business-day/services/tradingDay");
const { MONEY_FIELDS, cgstOf, gstinFor, loadGstData, moneyOut, placeOfSupply, rateLabel, seriesOf, sumOfLines, tally, taxableLines, totalOf } = require("./gstData");

// The rate-wise tax summary (the Tax tab and its CSV). CGST + SGST + cess add
// up to the tax on every line and in the total; service charge is a line of
// its own at each rate it was charged at.
const taxReport = async (restaurantId, range, outletId = null) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const data = await loadGstData(context);
  const split = Boolean(context.settings.gst_split);
  const byRate = tally();
  let untaxedServiceCharge = 0;

  for (const bill of data.bills) {
    if (bill.bill_status === "void") {
      continue;
    }

    const breakdown = data.breakdownOf(bill);

    for (const line of taxableLines(breakdown)) {
      const hsn = line.kind === "serviceCharge" ? gst.SERVICE_CHARGE_SAC : line.hsn || "—";
      const key = `${line.kind}|${line.rate}|${line.cessRate}|${hsn}`;

      byRate.add(
        key,
        { rate: line.rate, cessRate: line.cessRate, hsn, kind: line.kind },
        { quantity: line.quantity, taxable: line.taxable, tax: line.tax, cgst: line.cgst, cess: line.cess }
      );
    }

    untaxedServiceCharge += breakdown.serviceCharge.untaxed;
  }

  const rows = byRate
    .rows()
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.rate - b.rate ||
        a.cessRate - b.cessRate ||
        String(a.hsn).localeCompare(String(b.hsn))
    );

  const lines = rows.map((row) => ({
    taxPercentage: row.rate,
    cessPercentage: row.cessRate,
    rateLabel: rateLabel(row.rate, row.cessRate),
    hsnCode: row.hsn,
    description: row.kind === "serviceCharge" ? "Service charge" : data.nameOf(row.hsn, row.rate, row.cessRate),
    isServiceCharge: row.kind === "serviceCharge",
    quantity: round2(row.quantity),
    ...moneyOut(row, split),
  }));

  return {
    ...describe(context),
    gstNumber: gstinFor(context),
    gstSplit: split,
    lines,
    totals: totalOf(lines),
    // Service charge billed with no GST on it: a liability the owner should
    // know about, shown apart rather than folded in at 0%.
    untaxedServiceCharge: gst.rupees(untaxedServiceCharge),
  };
};

// The GST registrations with invoices or credit notes in the pack's range —
// the restaurant's own GSTIN, and each branch registered on its own — with
// the counters that bill under each, and the one this pack is filed for.
//
// GSTR-1 is filed once per registration. With All outlets picked the pack
// used to carry every branch's invoices under the restaurant's GSTIN: an
// accountant filing for that number would have filed two other
// registrations' sales with it. Now the pack is always ONE registration's:
// the one asked for (`asked`, "none" for bills issued with no GSTIN at all),
// else the outlet's or restaurant's own when it has documents in the range,
// else the first that has.
const registrationsOf = (data, context, outlets, asked) => {
  const names = new Map(outlets.map((outlet) => [Number(outlet.id), outlet.name]));
  const own = context.settings.gst_number || null;
  const found = new Map();
  const note = (row, field) => {
    const key = row.registration || null;

    if (!found.has(key)) {
      found.set(key, { gstin: key, counters: new Set(), invoiceCount: 0, creditNoteCount: 0 });
    }

    const entry = found.get(key);
    entry.counters.add(row.outlet_id ? names.get(Number(row.outlet_id)) || "Another outlet" : "Main counter");
    entry[field] += 1;
  };

  data.bills.forEach((bill) => note(bill, "invoiceCount"));
  data.creditNotes.forEach((row) => note(row, "creditNoteCount"));

  const preferred = gstinFor(context);
  const wanted =
    asked === null || asked === undefined || asked === ""
      ? undefined
      : String(asked).toLowerCase() === "none"
        ? null
        : String(asked).trim().toUpperCase();
  // The restaurant's own registration first, then the branches' by name.
  const order = [...found.values()].sort(
    (a, b) =>
      (a.gstin === own ? 0 : 1) - (b.gstin === own ? 0 : 1) ||
      (a.gstin === null ? 1 : 0) - (b.gstin === null ? 1 : 0) ||
      [...a.counters].join(", ").localeCompare([...b.counters].join(", "))
  );
  const selected =
    wanted !== undefined
      ? wanted
      : found.has(preferred || null)
        ? preferred || null
        : order.length > 0
          ? order[0].gstin
          : preferred || null;

  if (!found.has(selected)) {
    order.push({ gstin: selected, counters: new Set(), invoiceCount: 0, creditNoteCount: 0 });
  }

  return {
    selected,
    registrations: order.map((entry) => ({
      gstin: entry.gstin,
      state: gstinState(entry.gstin),
      counters: [...entry.counters],
      invoiceCount: entry.invoiceCount,
      creditNoteCount: entry.creditNoteCount,
      isRestaurant: entry.gstin !== null && entry.gstin === own,
      selected: entry.gstin === selected,
    })),
  };
};

// "BA6144-0012" -> the series "BA6144-", for the documents table. Every
// document numbered in it, with how many were cancelled and how many numbers
// inside the range this pack does not hold.
const documentSeries = (rows, numberOf, isCancelled, kind) => {
  const series = new Map();

  for (const row of rows) {
    const text = numberOf(row);

    if (!text) {
      continue;
    }

    const { prefix, number, width } = seriesOf(text);

    if (!series.has(prefix)) {
      series.set(prefix, { prefix, width, numbers: [], issued: 0, cancelled: 0 });
    }

    const run = series.get(prefix);
    run.width = Math.max(run.width, width);
    run.issued += 1;

    if (number !== null) {
      run.numbers.push(number);
    }

    if (isCancelled(row)) {
      run.cancelled += 1;
    }
  }

  return [...series.values()].map((run) => {
    const sorted = [...run.numbers].sort((a, b) => a - b);
    const pad = (value) => `${run.prefix}${String(value).padStart(run.width, "0")}`;
    const first = sorted.length ? sorted[0] : null;
    const last = sorted.length ? sorted[sorted.length - 1] : null;
    const distinct = new Set(sorted).size;

    return {
      kind,
      // GSTR-1's own words for the document type (table 13).
      nature: kind === "credit_note" ? "Credit note" : "Invoices for outward supply",
      series: run.prefix || "(no prefix)",
      fromNumber: first === null ? null : pad(first),
      toNumber: last === null ? null : pad(last),
      totalIssued: run.issued,
      cancelled: run.cancelled,
      netIssued: run.issued - run.cancelled,
      missingNumbers: first === null ? 0 : last - first + 1 - distinct,
    };
  });
};

// The GST filing pack for a period: everything an accountant needs to file
// GSTR-1 without rebuilding it from bills by hand. Every figure is the one
// the bill (or the credit note) stored and printed, rate by rate.
//
//   register        every invoice number, bill by bill (cancelled ones marked)
//   b2b             invoices to registered buyers, by GSTIN
//   b2c             everything else, by rate (place of supply: own state)
//   nilExempt       0% supplies
//   hsn             HSN/SAC summary, split B2B / B2C as the return asks
//   creditNotes     credit notes issued (money given back against a sale)
//   documents       invoice and credit-note series: first and last number,
//                   total, cancelled
//   checks          the pack tied back to the bills themselves
//
// One GST registration per pack (registrationsOf): `registrations` lists
// every registration with documents in the range, and `gstin` picks one.
const gstPack = async (restaurantId, range, outletId = null, { gstin: asked = null } = {}) => {
  const context = await scopeFor(restaurantId, range, outletId);
  const everything = await loadGstData(context);
  const split = Boolean(context.settings.gst_split);
  const { registrations, selected } = registrationsOf(
    everything,
    context,
    await outletRepository.findAll(restaurantId),
    asked
  );
  const ofRegistration = (row) => (row.registration || null) === selected;
  const data = {
    ...everything,
    bills: everything.bills.filter(ofRegistration),
    creditNotes: everything.creditNotes.filter(ofRegistration),
  };
  const gstin = selected;
  const place = placeOfSupply(gstin);

  const register = [];
  const b2bInvoices = [];
  const b2bByGstin = tally();
  const b2c = tally();
  const nil = tally();
  const hsn = tally();
  const totals = { taxable: 0, tax: 0, cess: 0, serviceCharge: 0, roundOff: 0, value: 0, count: 0 };
  // What the bills themselves say, to check the pack against.
  const onBills = { tax: 0, cess: 0, value: 0 };
  let untaxedServiceCharge = 0;
  let untaxedServiceChargeBills = 0;
  // The dates those bills fall on, and a few of their numbers, so the pack
  // can say whether they are old bills (before the till kept GST rate by
  // rate, when service charge could go untaxed) or new ones.
  let untaxedFirst = null;
  let untaxedLast = null;
  const untaxedNumbers = [];
  let missingHsnLines = 0;

  for (const bill of data.bills) {
    if (bill.bill_status === "void") {
      register.push({
        billId: bill.id,
        invoiceNumber: bill.bill_number,
        invoiceDate: bill.business_date,
        billedAt: bill.billed_at,
        status: "cancelled",
        reason: bill.void_reason,
        orderType: bill.order_type,
        recipientGstin: null,
        recipientName: null,
        recipientSource: null,
        taxableValue: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
        taxAmount: 0,
        serviceCharge: 0,
        roundOff: 0,
        invoiceValue: 0,
        // What the bill said before it was voided, for reference only.
        voidedValue: num(bill.total_amount),
      });
      continue;
    }

    const breakdown = data.breakdownOf(bill);
    const lines = taxableLines(breakdown);
    const isB2b = Boolean(bill.recipient_gstin);
    const supply = isB2b ? "b2b" : "b2c";
    const invoiceTaxable = breakdown.taxable + breakdown.serviceCharge.value;
    const invoiceCgst = cgstOf(lines);

    if (breakdown.serviceCharge.untaxed > 0) {
      untaxedServiceCharge += breakdown.serviceCharge.untaxed;
      untaxedServiceChargeBills += 1;
      const day = bill.business_date ? String(bill.business_date).slice(0, 10) : null;

      if (day && (!untaxedFirst || day < untaxedFirst)) {
        untaxedFirst = day;
      }

      if (day && (!untaxedLast || day > untaxedLast)) {
        untaxedLast = day;
      }

      if (untaxedNumbers.length < 20) {
        untaxedNumbers.push(bill.bill_number);
      }
    }

    totals.taxable += invoiceTaxable;
    totals.tax += breakdown.tax;
    totals.cess += breakdown.cess;
    totals.serviceCharge += breakdown.serviceCharge.value;
    totals.roundOff += breakdown.roundOff;
    totals.value += breakdown.total;
    totals.count += 1;
    onBills.tax += gst.toPaise(bill.tax_amount);
    onBills.cess += gst.toPaise(bill.cess_amount);
    onBills.value += gst.toPaise(bill.total_amount);

    register.push({
      billId: bill.id,
      invoiceNumber: bill.bill_number,
      invoiceDate: bill.business_date,
      billedAt: bill.billed_at,
      status: bill.bill_status,
      reason: null,
      orderType: bill.order_type,
      recipientGstin: bill.recipient_gstin || null,
      recipientName: bill.recipient_name || null,
      recipientSource: bill.recipient_source || null,
      taxableValue: gst.rupees(invoiceTaxable),
      cgst: split ? gst.rupees(invoiceCgst) : 0,
      sgst: split ? gst.rupees(breakdown.gst - invoiceCgst) : 0,
      cess: gst.rupees(breakdown.cess),
      taxAmount: gst.rupees(breakdown.tax),
      serviceCharge: gst.rupees(breakdown.serviceCharge.value),
      roundOff: gst.rupees(breakdown.roundOff),
      invoiceValue: gst.rupees(breakdown.total),
      voidedValue: null,
    });

    for (const line of lines) {
      const code = line.hsn || null;

      if (!code) {
        missingHsnLines += 1;
      }

      hsn.add(
        `${supply}|${code || "—"}|${line.rate}|${line.cessRate}`,
        { supply, hsn: code || "—", rate: line.rate, cessRate: line.cessRate, kind: line.kind },
        {
          quantity: gst.isServiceCode(code) ? 0 : line.quantity,
          taxable: line.taxable,
          tax: line.tax,
          cgst: line.cgst,
          cess: line.cess,
          value: line.taxable + line.tax + line.cess,
        }
      );

      if (line.rate === 0) {
        nil.add(supply, { supply }, { taxable: line.taxable, count: 0 });
        continue;
      }

      if (isB2b) {
        b2bInvoices.push({
          gstin: bill.recipient_gstin,
          recipientName: bill.recipient_name,
          recipientSource: bill.recipient_source,
          invoiceNumber: bill.bill_number,
          invoiceDate: bill.business_date,
          invoiceValue: gst.rupees(breakdown.total),
          placeOfSupply: place,
          rate: line.rate,
          cessRate: line.cessRate,
          isServiceCharge: line.kind === "serviceCharge",
          ...moneyOut(line, split),
        });
      } else {
        b2c.add(String(line.rate), { rate: line.rate }, { taxable: line.taxable, tax: line.tax, cgst: line.cgst, cess: line.cess });
      }
    }

    // The B2B table holds the invoice's taxed supplies only, line for line
    // the invoice-by-invoice rows above: its 0% lines are filed as nil rated
    // and service charge billed with no GST on it has a row of its own.
    // Taking the whole invoice's taxable value counted that service charge
    // twice — here and in its own row — while the self-check, which read the
    // lines, still passed.
    const taxedLines = lines.filter((line) => line.rate > 0);

    if (isB2b && taxedLines.length > 0) {
      b2bByGstin.add(
        bill.recipient_gstin,
        { gstin: bill.recipient_gstin, recipientName: bill.recipient_name },
        {
          count: 1,
          taxable: sumOfLines(taxedLines, "taxable"),
          tax: sumOfLines(taxedLines, "tax"),
          cgst: cgstOf(taxedLines),
          cess: sumOfLines(taxedLines, "cess"),
          value: breakdown.total,
        }
      );
    }
  }

  // Credit notes, each set against its own invoice, with exactly the GST it
  // took off when it was issued.
  const creditNotes = [];
  const creditByRate = tally();
  const creditTotals = { tax: 0, cess: 0, value: 0 };

  for (const row of data.creditNotes) {
    const note = row.breakdown;
    const noteLines = taxableLines(note);
    const noteCgst = cgstOf(noteLines);
    const noteTaxable = note.taxable + note.serviceCharge.value;
    // Split by who the buyer was: a credit note to a registered buyer is
    // filed on its own (CDNR); one to a consumer is netted off that rate's
    // B2C figure, as GSTR-1 asks for small B2C sales.
    const noteSupply = row.recipient_gstin ? "b2b" : "b2c";

    for (const line of noteLines) {
      creditByRate.add(
        `${noteSupply}|${line.rate}`,
        { supply: noteSupply, rate: line.rate },
        { taxable: line.taxable, tax: line.tax, cgst: line.cgst, cess: line.cess }
      );
    }

    if (note.serviceCharge.untaxed > 0) {
      creditByRate.add(`${noteSupply}|0`, { supply: noteSupply, rate: 0 }, { taxable: note.serviceCharge.untaxed });
    }

    creditTotals.tax += note.tax;
    creditTotals.cess += note.cess;
    creditTotals.value += note.total;

    creditNotes.push({
      creditNoteId: row.credit_note_id || null,
      creditNoteNumber: row.credit_note_number || null,
      kind: row.note_kind || "refund",
      // A refund from before credit notes were written: its GST is worked
      // out from the bill, and the screen says so.
      estimated: Boolean(row.legacy),
      refundId: row.refund_id,
      noteDate: row.refund_date,
      refundedAt: row.refunded_at,
      invoiceNumber: row.bill_number,
      invoiceDate: row.business_date,
      recipientGstin: row.recipient_gstin || null,
      recipientName: row.recipient_name || null,
      supply: noteSupply,
      reason: row.refund_reason,
      refundMethod: row.refund_method,
      refundedBy: row.refunded_by,
      taxableValue: gst.rupees(noteTaxable),
      cgst: split ? gst.rupees(noteCgst) : 0,
      sgst: split ? gst.rupees(note.gst - noteCgst) : 0,
      cess: gst.rupees(note.cess),
      taxAmount: gst.rupees(note.tax),
      roundOff: gst.rupees(note.roundOff),
      noteValue: gst.rupees(note.total),
    });
  }

  // GSTR-1's "documents issued": each invoice series, then each credit-note
  // series (a branch numbers its own of both). Gaps are numbers inside the
  // range that no document in this pack carries — another period's, or one
  // skipped — and need a look.
  const documents = [
    ...documentSeries(data.bills, (bill) => bill.bill_number, (bill) => bill.bill_status === "void", "invoice"),
    ...documentSeries(data.creditNotes, (row) => row.credit_note_number, () => false, "credit_note"),
  ];

  const b2cRows = b2c
    .rows()
    .sort((a, b) => a.rate - b.rate)
    .map((row) => ({ rate: row.rate, placeOfSupply: place, supplyType: "Intra-state", ...moneyOut(row, split) }));

  const b2bSummaryRows = b2bByGstin
    .rows()
    .sort((a, b) => b.value - a.value)
    .map((row) => ({
      gstin: row.gstin,
      recipientName: row.recipientName,
      state: gstinState(row.gstin),
      invoiceCount: row.count,
      invoiceValue: gst.rupees(row.value),
      ...moneyOut(row, split),
    }));

  const hsnRows = hsn
    .rows()
    .sort(
      (a, b) =>
        a.supply.localeCompare(b.supply) ||
        String(a.hsn).localeCompare(String(b.hsn)) ||
        a.rate - b.rate ||
        a.cessRate - b.cessRate
    )
    .map((row) => ({
      supply: row.supply,
      hsnCode: row.hsn,
      description:
        row.kind === "serviceCharge"
          ? "Service charge (restaurant service)"
          : row.hsn === "—"
            ? "No HSN/SAC code on the dish"
            : data.nameOf(row.hsn, row.rate, row.cessRate),
      uqc: gst.isServiceCode(row.hsn) ? "NA" : "NOS",
      quantity: round2(row.quantity),
      rate: row.rate,
      cessRate: row.cessRate,
      totalValue: gst.rupees(row.value),
      ...moneyOut(row, split),
    }));

  const nilRows = nil.rows().map((row) => ({
    supply: row.supply,
    description: row.supply === "b2b" ? "Nil rated or exempt, to registered buyers" : "Nil rated or exempt, to consumers",
    nilRatedOrExempt: gst.rupees(row.taxable),
    nonGst: 0,
  }));

  // Where GST was charged on the service charge, its rate and value are
  // already in the B2B/B2C tables above; where it was not, it is here. The
  // check adds up the tables exactly as the Summary shows them.
  const b2cTotal = b2c.rows().reduce((sum, row) => sum + row.taxable, 0);
  const b2bTotal = b2bByGstin.rows().reduce((sum, row) => sum + row.taxable, 0);
  const nilTotal = nil.rows().reduce((sum, row) => sum + row.taxable, 0);
  const tablesTaxable = b2cTotal + b2bTotal + nilTotal + untaxedServiceCharge;

  const inr = (paise) =>
    `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const billsTax = onBills.tax;
  const billsCess = onBills.cess;
  const billsValue = onBills.value;

  const checks = [
    {
      key: "tax",
      label: "Tax in this pack equals the tax on the bills",
      ok: totals.tax === billsTax,
      detail: `${inr(totals.tax)} here, ${inr(billsTax)} on the bills`,
    },
    {
      key: "cess",
      label: "Cess in this pack equals the cess on the bills",
      ok: totals.cess === billsCess,
      detail: `${inr(totals.cess)} here, ${inr(billsCess)} on the bills`,
    },
    {
      key: "value",
      label: "Invoice values add up to the sales on the bills",
      ok: totals.value === billsValue,
      detail: `${inr(totals.value)} here, ${inr(billsValue)} on the bills`,
    },
    {
      key: "tables",
      label: "B2B + B2C + nil-rated (+ untaxed service charge) equal the register's taxable value",
      ok: tablesTaxable === totals.taxable,
      detail: `${inr(tablesTaxable)} in the tables, ${inr(totals.taxable)} in the register`,
    },
    {
      key: "halves",
      label: "CGST + SGST + cess equal the tax",
      ok:
        !split ||
        register.every(
          (row) => gst.toPaise(row.cgst) + gst.toPaise(row.sgst) + gst.toPaise(row.cess) === gst.toPaise(row.taxAmount)
        ),
      detail: split ? "on every invoice and in every total" : "tax is shown as one figure (Settings)",
    },
  ];

  const warnings = [];

  if (!gstin) {
    warnings.push("No GSTIN is set. Add it under Settings → GST and invoice (or on the outlet) before filing.");
  }

  if (untaxedServiceCharge > 0) {
    // At the most common restaurant rate; the accountant decides.
    const atFive = Math.round(untaxedServiceCharge * 0.05);
    const span =
      untaxedFirst && untaxedLast
        ? untaxedFirst === untaxedLast
          ? ` (all on ${tradingDayRules.sayDate(untaxedFirst)})`
          : ` (from ${tradingDayRules.sayDate(untaxedFirst)} to ${tradingDayRules.sayDate(untaxedLast)})`
        : "";
    warnings.push(
      `${countOf(untaxedServiceChargeBills, "bill", "bills")}${span} carried service charge of ${rupeeText(gst.rupees(untaxedServiceCharge))} with no GST on it. ` +
        "These are older bills, raised before the till kept GST rate by rate; every bill raised now charges GST on the service charge at the rate of the food. " +
        `Service charge is part of the restaurant's supply for GST; at 5% that is about ${rupeeText(gst.rupees(atFive))} of tax. Ask your accountant how to treat it.`
    );
  }

  if (missingHsnLines > 0) {
    warnings.push(
      `${countOf(missingHsnLines, "bill line has", "bill lines have")} no HSN/SAC code. Set the code on the tax rate (Menu → Tax rates); restaurant service is 996331.`
    );
  }

  const estimated = creditNotes.filter((row) => row.estimated).length;

  if (estimated > 0) {
    warnings.push(
      `${countOf(estimated, "refund was", "refunds were")} given before credit notes were kept; ${estimated === 1 ? "its" : "their"} GST is worked out from the bill.`
    );
  }

  // B2C sales less the credit notes given to consumers, rate by rate.
  const b2cCredit = new Map(
    creditByRate
      .rows()
      .filter((row) => row.supply === "b2c")
      .map((row) => [row.rate, row])
  );
  const b2cNetRows = [...new Set([...b2c.rows().map((row) => row.rate), ...b2cCredit.keys()])]
    .filter((rate) => rate > 0)
    .sort((a, b) => a - b)
    .map((rate) => {
      const sold = b2c.rows().find((row) => row.rate === rate) || { taxable: 0, tax: 0, cgst: 0, cess: 0 };
      const back = b2cCredit.get(rate) || { taxable: 0, tax: 0, cgst: 0, cess: 0 };

      return {
        rate,
        placeOfSupply: place,
        ...moneyOut(
          {
            taxable: sold.taxable - back.taxable,
            tax: sold.tax - back.tax,
            cgst: sold.cgst - back.cgst,
            cess: sold.cess - back.cess,
          },
          split
        ),
      };
    });

  const registerTotals = totalOf(register.filter((row) => row.status !== "cancelled"), [
    ...MONEY_FIELDS,
    "serviceCharge",
    "roundOff",
    "invoiceValue",
  ]);
  const creditTotalsOut = totalOf(creditNotes, [...MONEY_FIELDS, "roundOff", "noteValue"]);

  return {
    ...describe(context),
    gstNumber: gstin,
    state: gstinState(gstin),
    placeOfSupply: place,
    gstSplit: split,
    // Every registration with documents in the range, and which counters
    // bill under each; this pack is the one marked selected. A restaurant
    // with branches registered on their own files one return for each.
    registrations,
    register,
    registerTotals: {
      invoices: totals.count,
      cancelled: register.filter((row) => row.status === "cancelled").length,
      ...registerTotals,
    },
    b2b: {
      summary: b2bSummaryRows,
      invoices: b2bInvoices,
      totals: { ...totalOf(b2bSummaryRows), invoiceValue: totalOf(b2bSummaryRows, ["invoiceValue"]).invoiceValue },
    },
    b2c: {
      rows: b2cRows,
      totals: totalOf(b2cRows),
      net: b2cNetRows,
      netTotals: totalOf(b2cNetRows),
    },
    nilExempt: nilRows,
    hsn: { rows: hsnRows, totals: totalOf(hsnRows, [...MONEY_FIELDS, "totalValue"]) },
    creditNotes: {
      rows: creditNotes,
      byRate: creditByRate
        .rows()
        .sort((a, b) => a.supply.localeCompare(b.supply) || a.rate - b.rate)
        .map((row) => ({ supply: row.supply, rate: row.rate, ...moneyOut(row, split) })),
      totals: { count: creditNotes.length, ...creditTotalsOut },
    },
    // The period's sales less its credit notes: what the tax is finally paid on.
    net: Object.fromEntries(
      MONEY_FIELDS.map((field) => [
        field,
        gst.rupees(gst.toPaise(registerTotals[field]) - gst.toPaise(creditTotalsOut[field])),
      ])
    ),
    documents,
    // GSTR-1 tables 11A and 11B: advances received in the period and not
    // billed in it (tax is due on them now), and advances received earlier
    // and used on this period's bills (that tax is adjusted). Read from the
    // advances themselves (customerAdvanceService.gstSummary). Advances are
    // the restaurant's, not a branch's: they are filed with the restaurant's
    // own registration and left out of a branch registered on its own.
    advances:
      !context.outlet && (!gstin || gstin === (context.settings.gst_number || null))
        ? await require("../../../billing/services/customerAdvance.service").gstSummary(restaurantId, { from: context.scope.from, to: context.scope.to })
        : null,
    untaxedServiceCharge: gst.rupees(untaxedServiceCharge),
    checks,
    warnings,
  };
};

// Marks one bill as a B2B invoice (or changes whose it is): the buyer's GSTIN,
// registered name and address. Checked in full, so a typo is caught here
// rather than by the buyer's accountant a month later.
//
// `outletId`: staff pinned to an outlet find only that outlet's bills, as on
// the Bills screen — another outlet's bill (or one raised with no outlet) is
// "not found", so it cannot be turned into someone's B2B invoice from there.
const setBillRecipient = async (restaurantId, billId, data, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const bill = await reportRepository.findBill(restaurantId, billId, outletId);

  if (!bill) {
    throw new AppError(404, "Bill not found");
  }

  if (bill.bill_status === "void") {
    throw new AppError(409, `${bill.bill_number} is void. A cancelled invoice cannot be issued to a buyer.`);
  }

  const gstin = readGstin(data.gstin, "The buyer's GSTIN");

  if (!gstin) {
    throw new AppError(400, "Enter the buyer's GSTIN, like 27AAPFU0939F1ZV");
  }

  await reportRepository.setBillRecipient(
    restaurantId,
    billId,
    { gstin, legalName: data.legalName, address: data.address || null },
    userId
  );

  return reportRepository.findBill(restaurantId, billId, outletId);
};

const clearBillRecipient = async (restaurantId, billId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const bill = await reportRepository.findBill(restaurantId, billId, outletId);

  if (!bill) {
    throw new AppError(404, "Bill not found");
  }

  const removed = await reportRepository.clearBillRecipient(restaurantId, billId);

  if (!removed) {
    throw new AppError(404, `${bill.bill_number} has no GSTIN written on it`);
  }

  return reportRepository.findBill(restaurantId, billId, outletId);
};

module.exports = {
  taxReport,
  gstPack,
  setBillRecipient,
  clearBillRecipient,
};
