import { test } from "node:test";
import assert from "node:assert/strict";
import { billTitle, onAccount, taxInvoiceDocument } from "../src/modules/business/core/pages/invoice.js";
import { duesMessage, sentence } from "../src/modules/business/retail/pages/retail.js";
import { statementKind, statementTitle } from "../src/modules/business/receivables/pages/receivablesFormat.js";
import { defaultT, words } from "./helpers/defaultWords.js";

// A bill as each business prints it (core/pages/invoice.js): its heading as
// the law names it, from the seller's GSTIN and the bill's own taxes (CGST
// Rules 46, 46A and 49), never from the business's type; the buyer, the
// walk-in, the item column and the line under the bill in the business's
// words; and the words of dues on the till receipt, the reminder and the
// statement.

const GSTIN = "36AAACL1234F1Z5";
const line = (over = {}) => ({ id: 1, label: "General consultation", hsn_code: "999312", quantity: "1", unit: "visit", unit_price: "500.00",
  tax_rate: "0.00", net: "500.00", tax: "0.00", lot_code: "", ...over });
const bill = (over = {}) => ({
  kind: "sale", document_no: "SI/2627/0007", created_at: "2026-11-03T06:00:00Z", contact_id: null, contact_name: null, contact_gstin: null,
  location_name: "Main branch", tax_mode: "exclusive", tax: "0.00", round_off: "0.00", total: "500.00",
  lines: [line()], payments: [{ id: 1, method: "cash", amount: "500.00" }], returns: [], refunds: [],
  seller: { gstin: GSTIN, state_code: "36", legal_name: "Lifeline Family Clinic", date_format: "DD MMM YYYY" }, ...over,
});
const business = (t) => ({ t, symbol: "₹", business: { name: "Test business", timezone: "Asia/Kolkata" }, settings: {}, context: {} });
const a4 = (doc, t) => taxInvoiceDocument(doc, business(t)).body;
const receipt = (doc, t, extra) => taxInvoiceDocument(doc, business(t), { paper: "80mm", ...extra }).body;

const gym = words({ customer: ["Member", "Members"], walk_in: ["Walk-in visitor", "Walk-in visitors"], item: ["Plan or service", "Plans & services"],
  dues: ["Fees", "Fees"], "phrase.bill_note": [""] });
const clinic = words({ customer: ["Patient", "Patients"], walk_in: ["Walk-in patient", "Walk-in patients"], item: ["Service or charge", "Services & charges"],
  "phrase.bill_note": [""] });
const kirana = words({ on_account: ["Udhaar", "Udhaar"], dues: ["Udhaar", "Udhaar"], collection: ["Udhaar payment", "Udhaar payments"],
  "phrase.statement": ["Udhaar statement"] });

test("the heading is the law's: a bill of supply for exempt supplies, never a tax invoice; a bill without a GSTIN", () => {
  // A registered clinic's consultation, exempt: a bill of supply (rule 49).
  assert.equal(billTitle(bill()), "Bill of supply");
  // A gym's plan at 5% from a registered gym: a tax invoice.
  const taxed = line({ label: "Gym monthly", hsn_code: "999723", tax_rate: "5.00", net: "1500.00", tax: "75.00" });
  assert.equal(billTitle(bill({ lines: [taxed] })), "Tax invoice");
  // Taxable and exempt together: one invoice-cum-bill of supply to a buyer with no GSTIN (rule 46A), a tax invoice to one with a GSTIN.
  assert.equal(billTitle(bill({ lines: [taxed, line({ id: 2 })] })), "Invoice-cum-bill of supply");
  assert.equal(billTitle(bill({ lines: [taxed, line({ id: 2 })], contact_gstin: "29AABCT1332L1ZT" })), "Tax invoice");
  // Free goods at a rate are not exempt goods.
  assert.equal(billTitle(bill({ lines: [taxed, line({ id: 2, tax_rate: "18.00", net: "0.00", tax: "0.00" })] })), "Tax invoice");
  // A business with no GSTIN issues no GST document, whatever it sells.
  assert.equal(billTitle(bill({ seller: {} })), "Bill");
  assert.equal(billTitle(bill({ seller: {}, lines: [taxed] })), "Bill");
  assert.equal(billTitle(bill({ kind: "purchase" })), "Purchase receipt");
});

test("a clinic's exempt bill prints as a bill of supply: no GST columns, its walk-in patient, its own item column", () => {
  const html = a4(bill(), clinic);
  assert.match(html, /<h2>Bill of supply<\/h2>/);
  assert.match(html, /<b>Bill to<\/b><strong>Walk-in patient<\/strong>/);
  assert.match(html, /<th>Service or charge<\/th>/);
  for (const absent of ["Tax invoice", "CGST", "SGST", "Taxable value", "Within the state", "Unregistered (no GSTIN)", "exchange policy", "Add the GSTIN"]) {
    assert.ok(!html.includes(absent), `a bill of supply has no "${absent}"`);
  }
  // A named patient is the patient; a firm with a GSTIN is billed to.
  assert.match(a4(bill({ contact_id: 7, contact_name: "Lakshmi Narayanan" }), clinic), /<b>Patient<\/b><strong>Lakshmi Narayanan<\/strong>/);
  assert.match(a4(bill({ contact_id: 8, contact_name: "Apex Insurance", contact_gstin: "29AABCT1332L1ZT" }), clinic), /<b>Bill to<\/b><strong>Apex Insurance<\/strong>/);
});

test("a gym with no GSTIN prints a bill in its words, with no exchange policy and no GSTIN nag on the buyer's copy", () => {
  const plan = line({ label: "Gym monthly", hsn_code: "999723", unit: "service", unit_price: "1500.00", net: "1500.00" });
  const html = a4(bill({ seller: { legal_name: "Fit Zone Gym" }, contact_id: 3, contact_name: "Deepa Menon", lines: [plan], total: "1500.00",
    payments: [{ id: 1, method: "upi", amount: "1500.00" }] }), gym);
  assert.match(html, /<h2>Bill<\/h2>/);
  assert.match(html, /<b>Member<\/b><strong>Deepa Menon<\/strong>/);
  assert.match(html, /<th>Plan or service<\/th>/);
  assert.match(html, /Certified that the particulars given above are true and correct\.<\/small>/);
  for (const absent of ["exchange policy", "GSTIN", "not a GST tax invoice", "Walk-in customer"]) assert.ok(!html.includes(absent), `no "${absent}"`);
});

test("a shop's bill prints its exchange policy, and a tax invoice keeps its GST columns and B2C mark", () => {
  const rice = line({ label: "Basmati rice 1 kg", hsn_code: "1006", unit: "each", unit_price: "145.00", tax_rate: "5.00", net: "145.00", tax: "7.25" });
  const html = a4(bill({ seller: { gstin: GSTIN, state_code: "36", legal_name: "Sri Ganesh Kirana Stores" }, lines: [rice], tax: "7.25", total: "152.25",
    payments: [{ id: 1, method: "cash", amount: "152.25" }] }), defaultT);
  assert.match(html, /<h2>Tax invoice<\/h2>/);
  assert.ok(html.includes("true and correct. Goods once sold are subject to the shop's exchange policy."));
  assert.match(html, /<b>Bill to<\/b><strong>Walk-in customer<\/strong>/);
  assert.match(html, /<th>Product<\/th>/);
  for (const present of ["CGST", "SGST", "Taxable value", "Within the state: CGST + SGST", "Unregistered (no GSTIN)"]) assert.ok(html.includes(present), `a tax invoice has "${present}"`);
});

test("the till receipt's dues lines are the business's: udhaar at a kirana, dues and on account elsewhere", () => {
  const dues = { earlier: 300, thisBill: 152.25, total: 452.25 };
  const doc = bill({ contact_id: 5, contact_name: "Ravi", payments: [] });
  const kiranaReceipt = receipt(doc, kirana, { dues });
  for (const text of ["Earlier udhaar", "This bill on udhaar", "Total udhaar now"]) assert.ok(kiranaReceipt.includes(text), text);
  const garageReceipt = receipt(doc, defaultT, { dues });
  for (const text of ["Earlier dues", "This bill on account", "Total dues now"]) assert.ok(garageReceipt.includes(text), text);
  // A bill of supply on the till: no taxable value or GST lines either.
  assert.match(garageReceipt, /BILL OF SUPPLY/);
  assert.ok(!garageReceipt.includes("Taxable value"));
});

test("dues in a business's words: on account, a reminder, a statement", () => {
  assert.equal(onAccount(kirana), "on udhaar");
  assert.equal(onAccount(defaultT), "on account");
  assert.equal(onAccount(words({ on_account: ["Credit", "Credit"] })), "on credit");
  assert.equal(sentence(defaultT.a("walk_in")), "A walk-in customer");
  const message = duesMessage(kirana, { name: "Ravi", shop: "Sri Ganesh Kirana Stores", balance: "₹452.25" });
  assert.match(message, /your udhaar balance with us is ₹452\.25\./);
  assert.match(message, /You can pay at the counter or by UPI\./);
  assert.match(duesMessage(gym, { name: "Deepa", shop: "Fit Zone", balance: "₹1,500.00", phone: "98450 11111" }), /your fees balance with us is ₹1,500\.00\.\nPlease clear it at your earliest convenience\.\nYou can pay at the counter or by UPI\. For any question call 98450 11111\./);
  assert.equal(statementTitle(kirana), "Udhaar statement");
  assert.equal(statementTitle(defaultT), "Statement of account");
  assert.equal(statementTitle(words({ "phrase.statement": [""] })), "Statement of account");
  assert.equal(statementKind(kirana, "collection"), "Udhaar payment");
  assert.equal(statementKind(words({ collection: ["Fee payment", "Fee payments"] }), "collection"), "Fee payment");
  assert.equal(statementKind(defaultT, "sale"), "Bill");
});
