// The day-end "Z report" on the receipt printer: the paper a manager signs
// and files every night. Same figures as the Day end tab, laid out for a
// 58 or 80 mm roll (Settings → Printing), with signature lines at the foot.
import { escapeHtml, printDocument } from "../../../../services/print.js";
import { moneyExact } from "../../../../services/format.js";
import { paymentMethodLabel, orderTypeLabel } from "../../../../services/labels.js";
import { clockTime, dayAndDate, printedAt } from "./reportFormat.js";

const PAPER_WIDTHS = { "58mm": 220, "80mm": 300, a4: 640 };


const row = (label, value, strong) =>
  `<tr${strong ? ' class="strong"' : ""}><td>${escapeHtml(label)}</td><td class="r">${escapeHtml(value)}</td></tr>`;

const rule = '<tr><td colspan="2"><div class="rule"></div></td></tr>';

const heading = (text) => `<tr><td colspan="2" class="h">${escapeHtml(text)}</td></tr>`;

export const buildZReport = (data, { restaurantName = "", settings = null, currency = "₹", printedBy = "" } = {}) => {
  const money = (value) => moneyExact(value, currency);
  const lines = [];

  lines.push(heading("SALES"));
  lines.push(row("Bills", String(data.billCount)));
  if (data.firstBill) {
    lines.push(row("Invoice nos", `${data.firstBill} – ${data.lastBill}`));
  }
  lines.push(row("Gross (before tax)", money(data.grossSales)));
  if (data.discounts) {
    lines.push(row("Discounts", `-${money(data.discounts)}`));
  }
  if (data.serviceCharge) {
    lines.push(row("Service charge", money(data.serviceCharge)));
  }
  if (data.gstSplit) {
    lines.push(row("CGST", money(data.cgst)));
    lines.push(row("SGST", money(data.sgst)));
    // Cess is its own line, never part of CGST or SGST.
    if (data.cess) {
      lines.push(row("Cess", money(data.cess)));
    }
  } else {
    lines.push(row("Tax", money(data.tax)));
  }
  if (data.roundOff) {
    // A plain hyphen: receipt printers' fonts often have no minus sign.
    lines.push(row("Round off", data.roundOff < 0 ? `-${money(-data.roundOff)}` : money(data.roundOff)));
  }
  lines.push(row("NET SALES", money(data.netSales), true));

  if (data.byOrderType.length) {
    lines.push(rule, heading("BY ORDER TYPE"));
    for (const type of data.byOrderType) {
      lines.push(row(`${orderTypeLabel(type.orderType)} (${type.billCount})`, money(type.netSales)));
    }
  }

  if (data.covers) {
    lines.push(row("Covers (dine-in)", String(data.covers)));
    lines.push(row("Per head (dine-in)", money(data.perHead)));
  }

  lines.push(rule, heading("PAYMENTS"));
  if (data.byMethod.length === 0) {
    lines.push(row("Nothing collected", ""));
  }
  for (const method of data.byMethod) {
    lines.push(row(paymentMethodLabel(method.paymentMethod), money(method.amount)));
  }
  lines.push(row("Refunds given", `-${money(data.totalRefunds)}`));

  // Tips, by how they were given: on top of the payments above, never in the
  // sales or the GST (REQ-ACCESS-DAYEND-TIPS).
  const tips = data.tips || { total: 0, byMethod: [] };
  if (tips.total > 0) {
    lines.push(rule, heading("TIPS COLLECTED"));
    for (const tip of tips.byMethod) {
      lines.push(row(`${paymentMethodLabel(tip.paymentMethod)} (${tip.count})`, money(tip.amount)));
    }
    lines.push(row("Tips in all", money(tips.total), true));
  }

  lines.push(rule, heading("CONTROLS"));
  lines.push(row(`Voided bills (${data.voidCount})`, money(data.voidValue)));
  lines.push(row(`Cancelled orders (${data.cancelledOrders})`, money(data.cancelledValue)));
  lines.push(row(`Refunds (${data.refundCount})`, money(data.totalRefunds)));

  const verdict = (variance) =>
    row(
      variance === 0 ? "Difference" : variance > 0 ? "OVER" : "SHORT",
      variance === 0 ? "matches" : money(Math.abs(variance)),
      true
    );
  const drawerLines = (drawer) => {
    if (drawer.firstBill && drawer.billCount !== undefined) {
      lines.push(row(`Bills (${drawer.billCount})`, `${drawer.firstBill} – ${drawer.lastBill}`));
    }
    lines.push(row("Opening cash", money(drawer.openingCash)));
    lines.push(row("+ Cash sales", money(drawer.cashSales)));
    if (drawer.cashTips) {
      lines.push(row("+ Cash tips", money(drawer.cashTips)));
    }
    lines.push(row("- Cash refunds", money(drawer.cashRefunds)));
    lines.push(row("- Cash expenses", money(drawer.cashExpenses)));
    if (drawer.supplierCash) {
      lines.push(row("- Paid to suppliers", money(drawer.supplierCash)));
    }
    if (drawer.riderShortfall) {
      lines.push(row("- Riders short", money(drawer.riderShortfall)));
    }
    if (drawer.riderRepaid) {
      lines.push(row("+ Rider shortfall repaid", money(drawer.riderRepaid)));
    }
    if (drawer.cashAdvances) {
      lines.push(row("+ Advances in cash", money(drawer.cashAdvances)));
    }
    if (drawer.cashAdvancesReturned) {
      lines.push(row("- Advances handed back", money(drawer.cashAdvancesReturned)));
    }
    lines.push(row("EXPECTED", money(drawer.expectedCash), true));
    lines.push(row("Counted", drawer.closingCash === null ? "not closed" : money(drawer.closingCash)));
    if (drawer.variance !== null && drawer.variance !== undefined) {
      lines.push(verdict(drawer.variance));
    }
  };
  const drawers = data.drawers || [];
  // All outlets with no date picked adds up the days being traded; a counter
  // left open on an older date is on its own date, and its drawer says so.
  const dates = Array.isArray(data.businessDates) && data.businessDates.length > 0 ? data.businessDates : [data.businessDate];
  const manyDates = dates.length > 1;

  if (data.wholeDrawer && drawers.length > 1) {
    // Every counter keeps its own drawer: each is counted on its own.
    for (const drawer of drawers) {
      lines.push(rule, heading(`CASH DRAWER · ${drawer.label.toUpperCase()}`));
      if (manyDates && drawer.businessDate) {
        lines.push(row("Business day", dayAndDate(drawer.businessDate)));
      }
      drawerLines(drawer);
    }
    lines.push(rule, heading("ALL DRAWERS"));
    lines.push(row("EXPECTED", money(data.expectedCash), true));
    lines.push(row("Counted", data.closingCash === null ? "not all closed" : money(data.closingCash)));
    if (data.variance !== null) {
      lines.push(verdict(data.variance));
    }
  } else if (data.wholeDrawer) {
    lines.push(rule, heading("CASH DRAWER"));
    // Its invoice numbers are already under SALES.
    drawerLines({ ...data, firstBill: null });
  } else {
    lines.push(rule, heading("CASH DRAWER"));
    lines.push(row("Cash taken here", money(data.cashSales)));
    lines.push(row("Drawer", "the main counter's"));
  }

  // Riders' cash (SW-X-RIDER-DRAWER) and what they still owe.
  const owe = data.ridersOwe || { amount: 0, count: 0 };
  if (data.riderCash || data.riderShortfall || data.riderRepaid || owe.amount) {
    lines.push(rule, heading("RIDER CASH"));
    lines.push(row("Handed in (in cash sales)", money(data.riderCash || 0)));
    lines.push(row("Short on settlement", money(data.riderShortfall || 0)));
    lines.push(row("Shortfalls handed over", money(data.riderRepaid || 0)));
    lines.push(row("Riders still owe", money(owe.amount), true));
  }

  // The day's notes, kept apart (SW-B-07), and the shift log book's entries.
  const notes = data.notes || [];
  const logbook = data.logbook || [];
  if (notes.length || logbook.length) {
    lines.push(rule, heading("NOTES"));
    const note = (text) => `<tr><td colspan="2" class="note">${escapeHtml(text)}</td></tr>`;
    for (const day of notes) {
      const where = notes.length > 1 ? `${day.label}: ` : "";
      if (day.openingNotes) {
        lines.push(note(`${where}Opening (${day.openedByName || "-"}): ${day.openingNotes}`));
      }
      if (day.closingNotes) {
        lines.push(note(`${where}Closing (${day.closedByName || "-"}): ${day.closingNotes}`));
      }
    }
    for (const entry of logbook) {
      lines.push(note(`${clockTime(entry.at, data.timezone)} ${entry.byName || "-"}: ${entry.body}`));
    }
  }

  const status = data.dayStatus === "open" ? "DAY STILL OPEN — X report" : "Z REPORT — DAY CLOSED";
  // An outlet registered for GST on its own prints its own GSTIN.
  const gstin = data.gstNumber || (settings && settings.gstNumber) || null;

  return `
    <div class="c">
      <div class="name">${escapeHtml(restaurantName)}</div>
      ${gstin ? `<div>GSTIN ${escapeHtml(gstin)}</div>` : ""}
      ${data.outletName ? `<div>${escapeHtml(data.outletName)}</div>` : ""}
      <div class="title">${escapeHtml(status)}</div>
      <div>${manyDates ? `Business days ${escapeHtml(dates.map((date) => dayAndDate(date)).join(" + "))}` : `Business day ${escapeHtml(dayAndDate(data.businessDate))} ${escapeHtml(String(data.businessDate).slice(0, 4))}`}</div>
      <div>Opened ${escapeHtml(clockTime(data.openedAt, data.timezone))}${data.openedByName ? ` by ${escapeHtml(data.openedByName)}` : ""}</div>
      ${data.closedAt ? `<div>Closed ${escapeHtml(clockTime(data.closedAt, data.timezone))}${data.closedByName ? ` by ${escapeHtml(data.closedByName)}` : ""}</div>` : ""}
    </div>
    <table>${rule}${lines.join("")}${rule}</table>
    <div class="sign">
      <div>Cashier ____________________</div>
      <div>Manager ____________________</div>
    </div>
    <div class="c small">Printed ${escapeHtml(printedAt(data.timezone))}${printedBy ? ` by ${escapeHtml(printedBy)}` : ""}</div>
  `;
};

export const printZReport = (data, options = {}) => {
  const settings = options.settings || null;
  const paper = (settings && settings.printPaperWidth) || "80mm";
  const width = PAPER_WIDTHS[paper] || PAPER_WIDTHS["80mm"];

  printDocument({
    title: `Z report ${data.businessDate}`,
    styles: `
      body {
        font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
        font-size: 12px;
        width: ${width}px;
        margin: 0 auto;
        color: #000;
      }
      table { border-collapse: collapse; width: 100%; }
      td { padding: 1px 0; vertical-align: top; }
      .r { text-align: right; white-space: nowrap; padding-left: 8px; }
      .strong td { font-weight: bold; font-size: 13px; }
      .h { font-weight: bold; padding-top: 6px; letter-spacing: 0.04em; }
      .rule { border-top: 1px dashed #000; margin: 4px 0; }
      .note { padding: 2px 0; white-space: pre-line; overflow-wrap: anywhere; }
      .c { text-align: center; }
      .name { font-size: 15px; font-weight: bold; }
      .title { font-weight: bold; margin: 6px 0 2px; }
      .sign { margin-top: 18px; line-height: 2.2; }
      .small { font-size: 10px; margin-top: 8px; }
    `,
    body: buildZReport(data, options),
  });
};
