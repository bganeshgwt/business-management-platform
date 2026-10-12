// The GST machinery shared by the tax report, GST pack, day end and day book: per-bill tax breakdowns, rates, totals.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const { gstinState } = require("../../../../../utils/gstin");
const gst = require("../../../billing/services/gstBreakdown");
const { shareServiceCharge } = require("../../../billing/services/serviceChargeShare");
const { num } = require("./common");

// ---------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------

const PLACE_UNKNOWN = "Your state (add your GSTIN in Settings)";

// Place of supply for a restaurant is where the food is served: always the
// restaurant's own state, so every sale is CGST + SGST, never IGST — even for
// a company guest registered in another state.
const placeOfSupply = (gstin) => {
  const state = gstinState(gstin);
  return state ? `${String(gstin).slice(0, 2)}-${state}` : PLACE_UNKNOWN;
};

// "INV-1043" -> { prefix: "INV-", number: 1043, width: 4 }
const seriesOf = (billNumber) => {
  const match = /^(.*?)(\d+)$/.exec(String(billNumber || ""));

  if (!match) {
    return { prefix: String(billNumber || ""), number: null, width: 0 };
  }

  return { prefix: match[1], number: Number(match[2]), width: match[2].length };
};

const percentOfPaise = (paise, percent) => Math.round((paise * Number(percent || 0)) / 100);

// One GST rate of a bill (or of a credit note) split into its dishes and its
// service charge, in paise. The service charge is taxed at the rate of the
// food it was charged on — the bill shares it out dish by dish and keeps it
// per rate (bill_taxes) — so it is filed at 5% on 5% food and 18% on 18%
// drinks, never at a blended rate no law has (6.77%, 8.12%).
//
// The bill keeps the service charge's GST (scGst); a credit note does not,
// so there it is what the rate's GST holds beyond the GST on the food. Cess
// is split the same way. CGST: the food's half (the odd paisa to CGST), and
// the service charge the rest of the rate's CGST, so the two add up to
// exactly the CGST printed on the bill.
const splitRate = ({ rate, cessRate, itemsTaxable, scTaxable, gstPaise, cgstPaise, cessPaise, scGst = null }) => {
  const scTax = scTaxable > 0 ? (scGst !== null ? Math.min(scGst, gstPaise) : gstPaise - Math.min(percentOfPaise(itemsTaxable, rate), gstPaise)) : 0;
  const itemsTax = gstPaise - scTax;
  const itemsCess = scTaxable > 0 ? Math.min(percentOfPaise(itemsTaxable, cessRate), cessPaise) : cessPaise;
  const itemsCgst = Math.min(gst.halves(itemsTax).cgst, cgstPaise);

  return {
    items: { taxable: itemsTaxable, tax: itemsTax, cgst: itemsCgst, cess: itemsCess },
    serviceCharge: { taxable: scTaxable, tax: scTax, cgst: cgstPaise - itemsCgst, cess: cessPaise - itemsCess },
  };
};

const sumOfLines = (lines, key) => lines.reduce((total, line) => total + (line[key] || 0), 0);

// A bill broken down for GST, in paise, from the figures the bill itself
// worked out and printed (bill_taxes, rate by rate; bill_items for the HSN
// codes). Returns:
//
//   lines               dishes, by rate, cess rate and HSN/SAC code
//   serviceChargeLines  the service charge, by the rate of the food it was on
//   serviceCharge       { value, tax, cess, untaxed } — all of it, together
//   taxable             the dishes' taxable value (after discounts)
//   gst, cess, tax      GST, cess, and both (= the bill's tax)
//   roundOff, total
const storedBreakdown = (bill, taxRows, itemRows) => {
  const lines = [];
  const serviceChargeLines = [];

  for (const row of taxRows) {
    const rate = num(row.tax_percentage);
    const cessRate = num(row.cess_percentage);
    const parts = splitRate({
      rate,
      cessRate,
      // A delivery charge is taxed at its bill's food rate (a composite
      // supply) and kept apart in bill_taxes; it is filed with that rate's
      // dishes, so the rate's taxable value is the whole of it. Left out,
      // a day with deliveries had a sales voucher short by its charges.
      itemsTaxable: gst.toPaise(row.items_taxable) + gst.toPaise(row.delivery_charge_taxable || 0),
      scTaxable: gst.toPaise(row.service_charge_taxable),
      gstPaise: gst.toPaise(row.cgst_amount) + gst.toPaise(row.sgst_amount),
      cgstPaise: gst.toPaise(row.cgst_amount),
      cessPaise: gst.toPaise(row.cess_amount),
      scGst: gst.toPaise(row.service_charge_tax),
    });

    // The rate's dishes by HSN/SAC code, the rate's figures shared between
    // them by each code's own taxable value.
    let groups = itemRows.filter((item) => num(item.tax_percentage) === rate && num(item.cess_percentage) === cessRate);

    if (groups.length === 0) {
      groups = [{ hsn_code: null, quantity: 0, food_taxable: row.items_taxable }];
    }

    const weights = groups.map((group) => Math.max(0, gst.toPaise(group.food_taxable)));
    const taxable = gst.apportion(parts.items.taxable, weights);
    const tax = gst.apportion(parts.items.tax, weights);
    const cgst = gst.apportion(parts.items.cgst, weights);
    const cess = gst.apportion(parts.items.cess, weights);

    groups.forEach((group, index) => {
      lines.push({
        kind: "items",
        rate,
        cessRate,
        hsn: group.hsn_code || null,
        quantity: num(group.quantity),
        taxable: taxable[index],
        tax: tax[index],
        cgst: cgst[index],
        cess: cess[index],
      });
    });

    if (parts.serviceCharge.taxable > 0 || parts.serviceCharge.tax > 0) {
      serviceChargeLines.push({ kind: "serviceCharge", rate, cessRate, hsn: gst.SERVICE_CHARGE_SAC, quantity: 0, ...parts.serviceCharge });
    }
  }

  const all = [...lines, ...serviceChargeLines];
  const gstPaise = sumOfLines(all, "tax");
  const cessPaise = sumOfLines(all, "cess");

  return {
    lines,
    serviceChargeLines,
    serviceCharge: {
      value: sumOfLines(serviceChargeLines, "taxable"),
      tax: sumOfLines(serviceChargeLines, "tax"),
      cess: sumOfLines(serviceChargeLines, "cess"),
      untaxed: 0,
    },
    taxable: sumOfLines(lines, "taxable"),
    gst: gstPaise,
    cess: cessPaise,
    tax: gstPaise + cessPaise,
    roundOff: gst.toPaise(bill.round_off),
    total: gst.toPaise(bill.total_amount),
  };
};

// A bill priced before the tax was kept rate by rate: worked out from its
// totals and lines (services/gstBreakdown). Its service charge is shared
// over the rates of its food, as a bill priced today keeps it
// (services/serviceChargeShare) — never filed at the blended rate the two
// figures work out to (10.04% for 5% food with 18% drinks). One that carried
// no GST at all is reported apart.
const legacyBreakdown = (bill, lineRows) => {
  const b = gst.breakdownBill(bill, lineRows);
  const taxed = b.serviceCharge.value > 0 && b.serviceCharge.tax > 0;

  return {
    lines: b.lines.map((line) => ({ kind: "items", rate: line.rate, cessRate: 0, hsn: line.hsn, quantity: line.quantity, taxable: line.taxable, tax: line.tax, cgst: line.cgst, cess: 0 })),
    serviceChargeLines: taxed
      ? shareServiceCharge(b.lines, b.serviceCharge).map((part) => ({
          kind: "serviceCharge",
          rate: part.rate,
          cessRate: 0,
          hsn: gst.SERVICE_CHARGE_SAC,
          quantity: 0,
          taxable: part.value,
          tax: part.tax,
          cgst: part.cgst,
          cess: 0,
        }))
      : [],
    serviceCharge: { value: b.serviceCharge.value, tax: b.serviceCharge.tax, cess: 0, untaxed: taxed ? 0 : b.serviceCharge.value },
    taxable: b.taxable,
    gst: b.tax,
    cess: 0,
    tax: b.tax,
    roundOff: b.roundOff,
    total: b.total,
  };
};

// A credit note as it was written: its GST rate by rate (credit_note_taxes),
// the dishes' part and the service charge's part of each rate.
const noteBreakdown = (note, taxRows) => {
  const lines = [];
  const serviceChargeLines = [];

  for (const row of taxRows) {
    const rate = num(row.tax_percentage);
    const cessRate = num(row.cess_percentage);
    const scTaxable = gst.toPaise(row.service_charge_taxable);
    const parts = splitRate({
      rate,
      cessRate,
      itemsTaxable: gst.toPaise(row.taxable_value) - scTaxable,
      scTaxable,
      gstPaise: gst.toPaise(row.cgst_amount) + gst.toPaise(row.sgst_amount),
      cgstPaise: gst.toPaise(row.cgst_amount),
      cessPaise: gst.toPaise(row.cess_amount),
    });

    lines.push({ kind: "items", rate, cessRate, hsn: null, quantity: 0, ...parts.items });

    if (parts.serviceCharge.taxable > 0 || parts.serviceCharge.tax > 0) {
      serviceChargeLines.push({ kind: "serviceCharge", rate, cessRate, hsn: gst.SERVICE_CHARGE_SAC, quantity: 0, ...parts.serviceCharge });
    }
  }

  const all = [...lines, ...serviceChargeLines];
  const gstPaise = sumOfLines(all, "tax");
  const cessPaise = sumOfLines(all, "cess");

  return {
    lines,
    serviceChargeLines,
    serviceCharge: {
      value: sumOfLines(serviceChargeLines, "taxable"),
      tax: sumOfLines(serviceChargeLines, "tax"),
      cess: sumOfLines(serviceChargeLines, "cess"),
      untaxed: 0,
    },
    taxable: sumOfLines(lines, "taxable"),
    gst: gstPaise,
    cess: cessPaise,
    tax: gstPaise + cessPaise,
    roundOff: gst.toPaise(note.note_round_off),
    total: gst.toPaise(note.refund_amount),
  };
};

// A refund from before credit notes were kept: the bill's own shares of
// value, service charge and tax, scaled to the money given back. Whatever
// paise the scaling leaves over is round-off, so it adds up to the money.
const scaledBreakdown = (breakdown, amountRupees) => {
  const amount = gst.toPaise(amountRupees);
  const share = breakdown.total > 0 ? Math.min(1, amount / breakdown.total) : 0;
  const scale = (line) => {
    const tax = Math.round(line.tax * share);
    return { ...line, quantity: 0, taxable: Math.round(line.taxable * share), tax, cgst: gst.halves(tax).cgst, cess: Math.round(line.cess * share) };
  };
  const lines = breakdown.lines.map(scale);
  const serviceChargeLines = breakdown.serviceChargeLines.map(scale);
  const untaxed = Math.round(breakdown.serviceCharge.untaxed * share);
  const all = [...lines, ...serviceChargeLines];
  const gstPaise = sumOfLines(all, "tax");
  const cessPaise = sumOfLines(all, "cess");
  const parts = sumOfLines(all, "taxable") + untaxed + gstPaise + cessPaise;

  return {
    lines,
    serviceChargeLines,
    serviceCharge: {
      value: sumOfLines(serviceChargeLines, "taxable") + untaxed,
      tax: sumOfLines(serviceChargeLines, "tax"),
      cess: sumOfLines(serviceChargeLines, "cess"),
      untaxed,
    },
    taxable: sumOfLines(lines, "taxable"),
    gst: gstPaise,
    cess: cessPaise,
    tax: gstPaise + cessPaise,
    roundOff: amount - parts,
    total: amount,
  };
};

const groupBy = (rows, key) => {
  const map = new Map();

  for (const row of rows) {
    const id = Number(row[key]);

    if (!map.has(id)) {
      map.set(id, []);
    }

    map.get(id).push(row);
  }

  return map;
};

// The GST breakdown of each of these bills: from what the bill stored, or —
// for a bill priced before that — worked out from its totals.
const breakdownsFor = async (restaurantId, bills) => {
  const ids = [...new Set(bills.map((bill) => Number(bill.id)))];
  const [taxRows, itemRows] = await Promise.all([
    reportRepository.billTaxRows(ids),
    reportRepository.billItemTaxRows(ids),
  ]);
  const taxByBill = groupBy(taxRows, "bill_id");
  const itemsByBill = groupBy(itemRows, "bill_id");
  const legacyIds = ids.filter((id) => !taxByBill.has(id));
  const legacyLines = groupBy(await reportRepository.billTaxLines(restaurantId, legacyIds), "bill_id");
  const done = new Map();

  return (bill) => {
    const id = Number(bill.id);

    if (!done.has(id)) {
      done.set(
        id,
        taxByBill.has(id)
          ? storedBreakdown(bill, taxByBill.get(id), itemsByBill.get(id) || [])
          : legacyBreakdown(bill, legacyLines.get(id) || [])
      );
    }

    return done.get(id);
  };
};

// What each HSN/SAC code is called, by code, rate and cess: the tax rate
// that sells it. One code can be sold at two rates (a soft drink at 18%,
// another at 5% plus cess), so the code alone does not say which.
const hsnNamer = (rows) => {
  const exact = new Map();
  const byCode = new Map();

  for (const row of rows) {
    const key = `${row.hsn_code}|${num(row.percentage)}|${num(row.cess_percentage)}`;

    if (!exact.has(key)) {
      exact.set(key, row.name);
    }

    byCode.set(row.hsn_code, [...(byCode.get(row.hsn_code) || []), row]);
  }

  return (hsn, rate, cessRate) => {
    if (!hsn || hsn === "—") {
      return null;
    }

    const hit = exact.get(`${hsn}|${num(rate)}|${num(cessRate)}`);

    if (hit) {
      return hit;
    }

    const sameRate = (byCode.get(hsn) || []).filter((row) => num(row.percentage) === num(rate));

    if (sameRate.length > 0) {
      return sameRate[0].name;
    }

    return `HSN ${hsn} at ${num(rate)}%${num(cessRate) > 0 ? ` + ${num(cessRate)}% cess` : ""}`;
  };
};

// Every bill in the range broken down, the credit notes issued in it, the
// money given back in it, and the names of the HSN codes. The building block
// of the GST pack, the tax summary and the day book.
const loadGstData = async (context) => {
  const { scope } = context;

  const [bills, notes, descriptions] = await Promise.all([
    reportRepository.gstBills(scope),
    reportRepository.gstCreditNotes(scope),
    reportRepository.hsnDescriptions(scope.restaurantId),
  ]);

  const live = bills.filter((bill) => bill.bill_status !== "void");
  const legacyNoteBills = notes.filter((note) => note.legacy);
  const breakdownOf = await breakdownsFor(scope.restaurantId, [...live, ...legacyNoteBills]);
  const noteTaxes = groupBy(
    await reportRepository.creditNoteTaxRows(notes.filter((note) => !note.legacy).map((note) => Number(note.credit_note_id))),
    "credit_note_id"
  );

  const creditNotes = notes.map((note) => ({
    ...note,
    breakdown: note.legacy
      ? scaledBreakdown(breakdownOf(note), note.refund_amount)
      : noteBreakdown(note, noteTaxes.get(Number(note.credit_note_id)) || []),
  }));

  return { bills, creditNotes, breakdownOf, nameOf: hsnNamer(descriptions) };
};

// Every per-rate line of a breakdown: the dishes, then the service charge at
// each rate it was taxed at. Service charge with no GST on it (an old bill)
// is left out and reported apart.
const taxableLines = (breakdown) => [...breakdown.lines, ...breakdown.serviceChargeLines];

// A running total in paise, keyed by whatever groups it.
const tally = () => {
  const rows = new Map();

  return {
    add(key, seed, figures) {
      if (!rows.has(key)) {
        rows.set(key, { ...seed, count: 0, quantity: 0, taxable: 0, tax: 0, cgst: 0, cess: 0, value: 0 });
      }

      const row = rows.get(key);
      row.count += figures.count || 0;
      row.quantity += figures.quantity || 0;
      row.taxable += figures.taxable || 0;
      row.tax += figures.tax || 0;
      row.cgst += figures.cgst || 0;
      row.cess += figures.cess || 0;
      row.value += figures.value || 0;
    },
    rows: () => [...rows.values()],
  };
};

// Paise to the rupee figures the screens show. `tax` is GST, cess is its own
// column — never folded into CGST and SGST. CGST is the sum of the per-line
// halves, SGST the rest of the GST, so the two always add up to the GST.
// taxAmount is GST and cess together, as the bill's tax is.
const moneyOut = (row, split) => {
  const cgst = row.cgst === undefined ? gst.halves(row.tax).cgst : row.cgst;
  const cess = row.cess || 0;

  return {
    taxableValue: gst.rupees(row.taxable),
    cgst: split ? gst.rupees(cgst) : 0,
    sgst: split ? gst.rupees(row.tax - cgst) : 0,
    cess: gst.rupees(cess),
    taxAmount: gst.rupees(row.tax + cess),
  };
};

const cgstOf = (lines) => lines.reduce((sum, line) => sum + (line.cgst || 0), 0);

// The total row of a table: the sum of the rows as shown, in paise, so a
// column always adds up to its own total — CGST included.
const MONEY_FIELDS = ["taxableValue", "cgst", "sgst", "cess", "taxAmount"];

const totalOf = (rows, fields = MONEY_FIELDS) =>
  Object.fromEntries(
    fields.map((field) => [field, gst.rupees(rows.reduce((sum, row) => sum + gst.toPaise(row[field]), 0))])
  );

const rateLabel = (rate, cessRate) => `${num(rate)}%${num(cessRate) > 0 ? ` + ${num(cessRate)}% cess` : ""}`;

// The GSTIN a pack is filed under: the outlet's own, when the switcher is on
// an outlet registered separately; otherwise the restaurant's.
const gstinFor = (context) =>
  (context.outlet && context.outlet.gst_number) || context.settings.gst_number || null;

module.exports = {
  placeOfSupply,
  seriesOf,
  sumOfLines,
  breakdownsFor,
  loadGstData,
  taxableLines,
  tally,
  moneyOut,
  cgstOf,
  MONEY_FIELDS,
  totalOf,
  rateLabel,
  gstinFor,
};
