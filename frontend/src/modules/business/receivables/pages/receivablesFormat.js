import { escapeHtml, printDocument } from "../../../../services/print";
import { dateShort, dateTime, moneyExact } from "../../../../services/format";

// Plain helpers for the receivables screens (no components here).

export const METHODS = [["cash", "Cash"], ["upi", "UPI"], ["bank", "Bank transfer"], ["cheque", "Cheque"], ["card", "Card"]];
export const methodName = (m) => (METHODS.find(([code]) => code === m) || [m, m])[1];
// A receipt's method as taken: the business's own name (PhonePe) where one was recorded.
export const receiptMethod = (row) => row?.method_name || methodName(row?.method);

// A cheque's state in words, with the badge tone (pro pass D-02).
export const CHEQUE_STATUS = {
  received: { tone: "warning", label: "In hand" },
  deposited: { tone: "info", label: "Deposited" },
  cleared: { tone: "success", label: "Cleared" },
  bounced: { tone: "danger", label: "Bounced" },
};
export const chequeWord = (cheque, today) => {
  if (!cheque?.status) return "";
  if (cheque.status === "received" && cheque.cheque_date && today && cheque.cheque_date > today) return `Post-dated · ${dateShort(cheque.cheque_date)}`;
  return CHEQUE_STATUS[cheque.status]?.label || cheque.status;
};

// A WhatsApp link (wa.me) with the message typed in: Indian mobile numbers
// get the 91 prefix.
export function whatsappLink(phone, text) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const number = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

// The reminder a customer reads: what they owe, what is overdue, how to pay.
export function reminderText(row, biz) {
  const name = biz.settings.display_name || biz.business.name;
  const parts = [`Namaste ${row.name},`, `This is a reminder from ${name}: your balance is ${moneyExact(row.balance, biz.symbol)}`];
  if (Number(row.overdue) > 0) parts[1] += `, of which ${moneyExact(row.overdue, biz.symbol)} is past its due date`;
  parts[1] += ".";
  if (row.oldest_bill) parts.push(`Oldest unpaid bill: ${dateShort(row.oldest_bill, { year: true })}.`);
  parts.push("Please arrange the payment. Thank you.");
  return parts.join("\n");
}

export function printReceipt(receipt, biz) {
  const seller = receipt.seller || {};
  const money = (v) => escapeHtml(biz.exact(v));
  const rows = receipt.allocations.map((a) => `<tr><td>${escapeHtml(a.document_no)}</td><td>${escapeHtml(dateShort(a.bill_at, { year: true }))}</td><td class="r">${money(a.amount)}</td></tr>`).join("");
  const cheque = receipt.cheque;
  const opening = Number(receipt.opening_applied || 0);
  const advance = Number(receipt.unallocated || 0);
  printDocument({
    title: receipt.collection_no,
    styles: "body{font:13px system-ui;color:#111} h1{font-size:18px;margin:0} table{width:100%;border-collapse:collapse;margin-top:12px} td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left} .r{text-align:right} .warn{border:1px solid #b91c1c;color:#7f1d1d;padding:6px 8px;margin:8px 0}",
    body: `<h1>${escapeHtml(seller.legal_name || seller.display_name || biz.business.name)}</h1>${seller.gstin ? `<small>GSTIN ${escapeHtml(seller.gstin)}</small>` : ""}
      <p><strong>Receipt ${escapeHtml(receipt.collection_no)}</strong> · ${escapeHtml(dateTime(receipt.created_at))}<br>
      Received from ${escapeHtml(receipt.contact_name)} the sum of <strong>${money(receipt.amount)}</strong> by ${escapeHtml(receiptMethod(receipt))}${receipt.reference ? ` (${escapeHtml(receipt.reference)})` : ""}.</p>
      ${cheque ? `<p>Cheque no. ${escapeHtml(cheque.cheque_no)} dated ${escapeHtml(dateShort(cheque.cheque_date, { year: true }))}${cheque.bank ? `, ${escapeHtml(cheque.bank)}` : ""}. Subject to realisation.</p>` : ""}
      ${cheque?.status === "bounced" ? `<div class="warn">This cheque was returned unpaid on ${escapeHtml(dateShort(cheque.bounced_at, { year: true }))} (${escapeHtml(cheque.bounce_reason || "")}). The receipt no longer counts.</div>` : ""}
      ${receipt.salesperson_name ? `<p>Collected by ${escapeHtml(receipt.salesperson_name)}${receipt.route_name ? ` · ${escapeHtml(receipt.route_name)}` : ""}</p>` : ""}
      ${rows ? `<table><thead><tr><th>Against bill</th><th>Bill date</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
      ${opening ? `<p>Against the opening balance: ${money(opening)}</p>` : ""}
      ${advance ? `<p>Kept as advance: ${money(advance)}</p>` : ""}
      <p style="margin-top:40px;text-align:right">Received by</p>`,
  });
}

export const STATEMENT_KINDS = { sale: "Bill", return: "Credit note", payment: "Payment", collection: "Collection", refund: "Refund", opening: "Opening balance", bounce: "Cheque returned", bounce_charge: "Bank charge" };

// One or more statements, each on its own page (bulk: every overdue customer).
export function printStatements(statements, biz) {
  const page = (data) => {
    const seller = data.seller || {};
    const rows = data.entries.map((e) => `<tr><td>${escapeHtml(dateShort(e.day, { year: true }))}</td><td>${escapeHtml(STATEMENT_KINDS[e.kind] || e.kind)} · ${escapeHtml(e.reference)}</td><td class="r">${Number(e.debit) ? escapeHtml(biz.exact(e.debit)) : ""}</td>
      <td class="r">${Number(e.credit) ? escapeHtml(biz.exact(e.credit)) : ""}</td><td class="r">${escapeHtml(biz.exact(e.balance))}</td></tr>`).join("");
    return `<section class="page"><h1>${escapeHtml(seller.legal_name || seller.display_name || biz.business.name)}</h1>${seller.gstin ? `<small>GSTIN ${escapeHtml(seller.gstin)}</small>` : ""}
      <p><strong>Statement of account</strong> · ${escapeHtml(data.contact.name)}${data.contact.phone ? ` · ${escapeHtml(data.contact.phone)}` : ""} · ${escapeHtml(dateShort(data.from, { year: true }))} to ${escapeHtml(dateShort(data.to, { year: true }))}</p>
      <table><thead><tr><th>Date</th><th>Particulars</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead>
      <tbody><tr><td>${escapeHtml(dateShort(data.from, { year: true }))}</td><td>Brought forward</td><td></td><td></td><td class="r">${escapeHtml(biz.exact(data.opening))}</td></tr>${rows}</tbody></table>
      <p style="text-align:right"><strong>Closing balance ${escapeHtml(biz.exact(data.closing))}</strong></p></section>`;
  };
  printDocument({
    title: statements.length === 1 ? `Statement ${statements[0].contact.name}` : `${statements.length} statements`,
    styles: "body{font:13px system-ui;color:#111} h1{font-size:18px;margin:0} table{width:100%;border-collapse:collapse;margin-top:12px} td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left} .r{text-align:right} .page{page-break-after:always} .page:last-child{page-break-after:auto}",
    body: statements.map(page).join(""),
  });
}
