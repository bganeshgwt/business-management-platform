// The X report on the receipt printer: a mid-shift reading of one cashier's
// drawer (or of one cashier's whole day when no shifts are kept). It changes
// nothing — the Z report (Reports → Day end) is the day's own, signed at close.
import { escapeHtml, printDocument } from "../../../../services/print.js";
import { moneyExact } from "@bmp/shared/format";
import { clockTime, dayAndDate, printedAt } from "../../reports/pages/reportFormat.js";
import { METHOD_WORDS } from "./cashMath.js";

const PAPER_WIDTHS = { "58mm": 220, "80mm": 300, a4: 640 };

const row = (label, value, strong) =>
  `<tr${strong ? ' class="strong"' : ""}><td>${escapeHtml(label)}</td><td class="r">${escapeHtml(value)}</td></tr>`;

const rule = '<tr><td colspan="2"><div class="rule"></div></td></tr>';

const heading = (text) => `<tr><td colspan="2" class="h">${escapeHtml(text)}</td></tr>`;

// A plain hyphen: receipt printers' fonts often have no minus sign.
const minus = (money, value) => `-${money(value)}`;

// Tips collected, by method: on top of the payments, never in the sales.
const tipLines = (lines, tips, money) => {
  if (!tips || tips.length === 0) {
    return;
  }

  lines.push(rule, heading("TIPS COLLECTED"));

  for (const tip of tips) {
    lines.push(row(METHOD_WORDS[tip.method] || tip.method, money(tip.amount)));
  }

  lines.push(row("Tips in all", money(tips.reduce((sum, tip) => sum + tip.amount, 0)), true));
};

const methodLines = (lines, methods, money) => {
  lines.push(rule, heading("TAKEN BY METHOD"));

  if (!methods || methods.length === 0) {
    lines.push(row("Nothing taken yet", ""));
    return;
  }

  for (const method of methods) {
    const word = METHOD_WORDS[method.method] || method.method;
    lines.push(row(`${word} (${method.payments})`, money(method.taken)));

    if (method.refunded > 0) {
      lines.push(row(`  ${word} refunded`, minus(money, method.refunded)));
    }
  }
};

const billLines = (lines, bills, money) => {
  lines.push(rule, heading("BILLS"));
  lines.push(row("Bills raised", String(bills.count)));

  if (bills.sales !== null && bills.sales !== undefined) {
    lines.push(row("Billed", money(bills.sales)));
  }

  if (bills.discounts) {
    lines.push(row("Discounts given", minus(money, bills.discounts)));
  }

  if (bills.voids) {
    lines.push(row("Voided bills", String(bills.voids)));
  }
};

const buildXReport = (data, { restaurantName = "", printedBy = "" } = {}) => {
  const money = (value) => moneyExact(value, data.currency || "₹");
  const zone = data.timezone;
  const lines = [];
  let title;
  let who;
  let when = [];

  if (data.kind === "drawer") {
    const drawer = data.drawer;
    const f = drawer.figures || {};

    title = drawer.status === "open" ? "X REPORT — SHIFT IN PROGRESS" : "SHIFT REPORT — DRAWER CLOSED";
    who = `${drawer.cashierName}${drawer.label ? ` · ${drawer.label}` : ""}`;
    when = [
      `Business day ${dayAndDate(drawer.businessDate)} ${String(drawer.businessDate).slice(0, 4)}`,
      `Shift from ${clockTime(drawer.openedAt, zone)}${drawer.closedAt ? ` to ${clockTime(drawer.closedAt, zone)}` : ""}`,
    ];

    lines.push(heading("CASH DRAWER"));
    lines.push(row("Opening float", money(f.openingFloat)));

    if (f.cashTaken !== null && f.cashTaken !== undefined) {
      lines.push(row("+ Cash taken", money(f.cashTaken)));
    }

    // Cash tips stay in the drawer until they are shared out.
    if (f.cashTips) {
      lines.push(row("+ Cash tips", money(f.cashTips)));
    }

    // A rider's cash short never reached the drawer; an owed one repaid did.
    if (f.riderShortfall) {
      lines.push(row("- Riders short", money(f.riderShortfall)));
    }

    if (f.riderRepaid) {
      lines.push(row("+ Rider shortfall repaid", money(f.riderRepaid)));
    }

    // Advances and deposits taken in cash; unused ones handed back in cash.
    if (f.cashAdvances) {
      lines.push(row("+ Advances in cash", money(f.cashAdvances)));
    }

    if (f.cashAdvancesReturned) {
      lines.push(row("- Advances handed back", money(f.cashAdvancesReturned)));
    }

    if (f.cashRefunded) {
      lines.push(row("- Cash refunds", money(f.cashRefunded)));
    }

    if (f.pettyCash) {
      lines.push(row("- Petty cash paid", money(f.pettyCash)));
    }

    if (f.supplierCash) {
      lines.push(row("- Paid to suppliers", money(f.supplierCash)));
    }

    if (f.otherExpenses) {
      lines.push(row("- Other cash expenses", money(f.otherExpenses)));
    }

    if (f.dropped) {
      lines.push(row("- Dropped to the safe", money(f.dropped)));
    }

    if (f.paidIn) {
      lines.push(row("+ Float top-ups", money(f.paidIn)));
    }

    // A counted drawer prints what it was signed against at its count.
    const signed = drawer.status === "closed" && drawer.expectedAtClose !== null && drawer.expectedAtClose !== undefined;
    const shouldHold = signed ? drawer.expectedAtClose : f.expectedCash;

    if (data.blind) {
      lines.push(row("SHOULD HOLD", "blind count", true));
    } else if (shouldHold !== null && shouldHold !== undefined) {
      lines.push(row(signed ? "SHOULD HAVE HELD" : "SHOULD HOLD", money(shouldHold), true));
    }

    if (drawer.status === "closed") {
      lines.push(row("Counted", money(drawer.countedCash)));

      if (drawer.variance !== null && drawer.variance !== undefined) {
        lines.push(
          row(
            drawer.variance === 0 ? "Difference" : drawer.variance > 0 ? "OVER" : "SHORT",
            drawer.variance === 0 ? "matches" : money(Math.abs(drawer.variance)),
            true
          )
        );
      }

      if (drawer.varianceReason) {
        lines.push(row("Reason", drawer.varianceReason));
      }
    }

    methodLines(lines, f.methods, money);
    tipLines(lines, f.tips, money);
    billLines(lines, f.bills || { count: 0 }, money);

    if (data.movements && data.movements.length) {
      lines.push(rule, heading("CASH IN AND OUT"));

      for (const move of data.movements) {
        const sign = move.type === "paid_in" ? "+" : "-";
        const label = `${clockTime(move.createdAt, zone)} ${move.typeLabel}${move.status === "cancelled" ? " (cancelled)" : ""}`;
        lines.push(row(label, move.status === "cancelled" ? "0.00" : `${sign}${money(move.amount)}`));
      }
    }
  } else {
    title = "X REPORT — CASHIER'S DAY";
    who = data.cashier.name;
    when = [`Business day ${dayAndDate(data.day.businessDate)} ${String(data.day.businessDate).slice(0, 4)}`, "No shift kept: the whole day"];
    methodLines(lines, data.methods, money);
    tipLines(lines, data.tips, money);
    billLines(lines, data.bills, money);
  }

  return `
    <div class="c">
      <div class="name">${escapeHtml(restaurantName)}</div>
      <div class="title">${escapeHtml(title)}</div>
      <div>${escapeHtml(who)}</div>
      ${when.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
    </div>
    <table>${rule}${lines.join("")}${rule}</table>
    <div class="sign">
      <div>Cashier ____________________</div>
      <div>Manager ____________________</div>
    </div>
    <div class="c small">Printed ${escapeHtml(printedAt(zone))}${printedBy ? ` by ${escapeHtml(printedBy)}` : ""}</div>
  `;
};

export const printXReport = (data, options = {}) => {
  const paper = (options.settings && options.settings.printPaperWidth) || "80mm";
  const width = PAPER_WIDTHS[paper] || PAPER_WIDTHS["80mm"];

  printDocument({
    title: "X report",
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
      .c { text-align: center; }
      .name { font-size: 15px; font-weight: bold; }
      .title { font-weight: bold; margin: 6px 0 2px; }
      .sign { margin-top: 18px; line-height: 2.2; }
      .small { font-size: 10px; margin-top: 8px; }
    `,
    body: buildXReport(data, options),
  });
};
