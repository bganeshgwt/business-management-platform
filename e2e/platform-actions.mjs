// What the platform's super admin does in Your plan's browser test, run with
// the platform's own code (backend/src) on the run's own database: the
// company's details an invoice needs and how owners pay it, in sample mode
// (the company's settings), and confirming a payment an owner entered
// (subscriptions.service applyPayment, the one routine that makes a payment
// count, which the console's Confirm runs). Each runs in a short Node process
// of its own in backend/, so the API's code and its database settings stay
// out of the test's process; it reads the database server from backend/.env,
// as the global set-up does, and is given the run's database by name.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { account, fixture } from "./fixture.mjs";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "backend");
// Every database a run makes is named like this (global-setup.mjs), and no other is written to.
const DATABASE_NAME = /^rmp_test_e2e_[a-f0-9]{16}$/;

// Runs a CommonJS script from backend/ with `input` (as RUN_INPUT) on the
// run's database. The script prints its answer on a line of its own after
// "ANSWER ".
function runBackend(script, input) {
  const { database } = fixture();

  if (!DATABASE_NAME.test(database)) {
    throw new Error(`Refusing to write to "${database}": it is not a browser-test database.`);
  }

  const run = spawnSync(process.execPath, ["-e", script], {
    cwd: BACKEND,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", DB_NAME: database, JWT_SECRET: crypto.randomBytes(48).toString("hex"), RUN_INPUT: JSON.stringify(input) },
  });
  const answer = String(run.stdout || "").split(/\r?\n/).filter((line) => line.startsWith("ANSWER ")).pop();

  if (run.status !== 0 || !answer) {
    throw new Error(`The platform's step did not finish: ${String(run.stderr || run.error?.message || "").trim().slice(-800)}`);
  }

  return JSON.parse(answer.slice("ANSWER ".length));
}

// The settings these steps change, and the names a test gives them.
const COMPANY_COLUMNS = {
  gstin: "gstin", legalName: "legal_name", addressLine1: "address_line1", city: "city", postalCode: "postal_code", upiId: "upi_id",
  upiPayee: "upi_payee_name", bankName: "bank_name", bankAccountName: "bank_account_name", bankAccountNumber: "bank_account_number", bankIfsc: "bank_ifsc",
};

// Sets the company's settings given (the sample GSTIN when none is given) and
// answers with what they were.
const SET_COMPANY = [
  'const pool = require("./src/config/database");',
  'const { SAMPLE_GSTIN } = require("./src/modules/platform/services/planMath");',
  "const { columns, values } = JSON.parse(process.env.RUN_INPUT);",
  "const names = Object.keys(columns);",
  "(async () => {",
  '  const before = (await pool.query("SELECT " + names.map((name) => columns[name] + " AS \\"" + name + "\\"").join(",") + " FROM platform_settings WHERE id=1")).rows[0];',
  "  const next = { gstin: SAMPLE_GSTIN, ...values };",
  '  await pool.query("UPDATE platform_settings SET " + names.map((name, i) => columns[name] + "=$" + (i + 1)).join(",") + ",updated_at=now() WHERE id=1",',
  "    names.map((name) => (name in next ? next[name] : before[name])));",
  '  console.log("ANSWER " + JSON.stringify(before));',
  "})().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());",
].join("\n");

const CONFIRM_PAYMENT = [
  'const pool = require("./src/config/database");',
  'const subscriptions = require("./src/modules/platform/services/subscriptions.service");',
  "const { paymentId, email } = JSON.parse(process.env.RUN_INPUT);",
  "(async () => {",
  '  const admin = (await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [email])).rows[0];',
  "  const result = await subscriptions.applyPayment(admin ? { id: admin.id } : null, paymentId);",
  '  console.log("ANSWER " + JSON.stringify({ invoice: result.invoice ? result.invoice.number : null, orderId: result.order.id }));',
  "})().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());",
].join("\n");

// The company's legal name, address, UPI ID and bank account (YOUR_PLAN.company)
// with the sample GSTIN, so invoices are samples from the sample series.
// Answers with the settings as they were, for restoreCompany.
export const setCompany = (company) => runBackend(SET_COMPANY, { columns: COMPANY_COLUMNS, values: company });

// The company's settings put back as setCompany found them.
export const restoreCompany = (before) => runBackend(SET_COMPANY, { columns: COMPANY_COLUMNS, values: before });

// The super admin confirms an owner's payment: { invoice, orderId }.
export const confirmPayment = (paymentId) => runBackend(CONFIRM_PAYMENT, { paymentId: Number(paymentId), email: account("SUPER_ADMIN").email });
