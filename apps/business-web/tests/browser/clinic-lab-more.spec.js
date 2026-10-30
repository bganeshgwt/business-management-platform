import { test, expect } from "@playwright/test";

import { CLINIC, CLINIC_LAB, business, fixture, signIn } from "../../../../e2e/fixture.mjs";

// The clinic's lab by department, its ordered tests billed later, and its
// drug list behind the prescription (e2e/test-data.mjs › CLINIC_LAB):
//   - the lab technician, who works in Haematology, finds the worklist on
//     their own department with how many wait in each, and Biochemistry's
//     test a tap away;
//   - the front desk orders a test without billing it, then bills it from
//     the order (Bill these tests): the order says billed, with its bill;
//   - the doctor picks amoxicillin from the drug list for a patient allergic
//     to penicillin: the warning shows as it is written, the save is stopped
//     until a reason is given, and the warning and the reason stay with the
//     prescription; a medicine written by hand is marked not on the list;
//   - the drug list itself, in Business Admin.

const noSidewaysScroll = async (page, what) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}: no sideways scroll`).toBe(true);

test("the lab technician's worklist opens on their department, with what waits in each", async ({ page }) => {
  const clinic = business("healthcare");
  await page.setViewportSize({ width: 1024, height: 768 });
  await signIn(page, "LAB_TECH");
  await page.goto(`${fixture().urls.staff}/lab/${clinic.id}/worklist`);
  await expect(page.getByRole("heading", { level: 1, name: "Worklist", exact: true })).toBeVisible({ timeout: 30_000 });
  const departments = page.getByRole("group", { name: "Which department" });
  const mine = departments.getByRole("button", { name: /^Your departments · \d+$/ });
  await expect(mine).toHaveAttribute("aria-pressed", "true");
  const patient = page.getByRole("row").filter({ hasText: CLINIC_LAB.worklistPatient.name });
  // Their own department: the haemoglobin, not the fasting sugar.
  await expect(patient.filter({ hasText: CLINIC.test.name })).toHaveCount(1);
  await expect(patient.filter({ hasText: CLINIC_LAB.sugar.name })).toHaveCount(0);
  await expect(patient.filter({ hasText: CLINIC.test.name })).toContainText("Haematology");
  // Biochemistry's test, one tap away; and every department.
  await departments.getByRole("button", { name: /^Biochemistry · \d+$/ }).click();
  await expect(patient.filter({ hasText: CLINIC_LAB.sugar.name })).toHaveCount(1);
  await expect(patient.filter({ hasText: CLINIC.test.name })).toHaveCount(0);
  await departments.getByRole("button", { name: /^All departments · \d+$/ }).click();
  await expect(patient).toHaveCount(2);
  await noSidewaysScroll(page, "the worklist at 1024");
});

test("the front desk orders a test without billing it, and bills it later from the order", async ({ page }) => {
  const clinic = business("healthcare");
  const problems = [];
  page.on("response", (response) => { if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`); });
  await signIn(page, "RECEPTION");
  await page.goto(`${fixture().urls.staff}/lab/${clinic.id}/orders`);
  await expect(page.getByRole("heading", { level: 1, name: "Lab orders", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New order", exact: true }).click();
  const choose = page.getByRole("dialog", { name: "New lab order" });
  await choose.getByRole("combobox", { name: "Patient" }).fill(CLINIC_LAB.billedLater.name);
  await page.getByRole("option").filter({ hasText: CLINIC_LAB.billedLater.name }).first().click();
  const order = page.getByRole("dialog", { name: `Order tests · ${CLINIC_LAB.billedLater.name}` });
  await order.getByRole("checkbox", { name: new RegExp(`^${CLINIC.test.name}`) }).check();
  // Not billed as it is ordered.
  await order.getByRole("checkbox", { name: /^Bill the tests now/ }).uncheck();
  await order.getByRole("button", { name: "Order", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`^LAB\\d+ · ${CLINIC_LAB.billedLater.name}$`) })).toBeVisible({ timeout: 30_000 });
  const strip = page.locator(".hl-strip").first();
  await expect(strip).toContainText("Not billed");
  const tests = page.locator("section.section-card").filter({ has: page.getByRole("heading", { level: 2, name: "Tests", exact: true }) });
  await expect(tests.getByRole("row").filter({ hasText: CLINIC.test.name })).toContainText("Not billed");
  // Bill these tests: the haemoglobin at its price, paid at the desk.
  await strip.getByRole("button", { name: "Bill these tests" }).click();
  const bill = page.getByRole("dialog", { name: /^Bill the tests of LAB\d+$/ });
  await expect(bill.getByRole("checkbox", { name: new RegExp(`^${CLINIC.test.name}`) })).toBeChecked();
  await expect(bill).toContainText(`₹${CLINIC.test.price.toFixed(2)}`);
  await bill.getByRole("button", { name: "Bill and take payment", exact: true }).click();
  await expect(bill).toHaveCount(0);
  await expect(strip).toContainText(/Billed \S+/);
  await expect(strip).not.toContainText("Not billed");
  await expect(strip.getByRole("button", { name: "Bill these tests" })).toHaveCount(0);
  await expect(tests.getByRole("row").filter({ hasText: CLINIC.test.name })).toContainText("Billed");
  expect(problems).toEqual([]);
});

test("the doctor picks from the drug list: an allergy warns, and the reason stays with the prescription", async ({ page }) => {
  const clinic = business("healthcare");
  const { allergic } = CLINIC_LAB;
  const amoxicillin = CLINIC_LAB.drugs[0];
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "DOCTOR");
  await page.goto(`${fixture().urls.staff}/clinic/${clinic.id}/visits/${clinic.lab.allergicVisit.id}`);
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`^${allergic.name} · OP`) })).toBeVisible({ timeout: 30_000 });
  // Picked from the list (offered as the doctor types): its strength, usual dose and timing filled in.
  const offered = `${amoxicillin.genericName} ${amoxicillin.strength} ${amoxicillin.form}`;
  await expect(page.locator(`datalist option[value="${offered}"]`)).toHaveCount(1, { timeout: 15_000 });
  await page.getByRole("button", { name: "Add medicine", exact: true }).click();
  await page.getByLabel("Medicine (generic), line 1").fill(offered);
  await expect(page.getByLabel("Medicine (generic), line 1")).toHaveValue(amoxicillin.genericName);
  await expect(page.getByLabel("Strength, line 1")).toHaveValue(amoxicillin.strength);
  await expect(page.getByLabel("Dose, line 1")).toHaveValue(amoxicillin.usualDose);
  await expect(page.getByLabel("When (1-0-1), line 1")).toHaveValue(amoxicillin.usualFrequency);
  const prescription = page.locator("section.section-card").filter({ has: page.getByRole("heading", { level: 2, name: "Prescription", exact: true }) });
  await expect(prescription.getByText("On the list", { exact: true })).toHaveCount(1);
  // The warning, as it is written.
  const warnings = page.locator("section.section-card").filter({ has: page.getByRole("heading", { level: 2, name: "Prescription warnings", exact: true }) });
  await expect(warnings).toContainText(`Line 1: Allergy: the patient's allergies say "${allergic.allergies}", and Amoxicillin is in Penicillins.`);
  // A line written by hand: not on the list.
  await page.getByRole("button", { name: "Add medicine", exact: true }).click();
  await page.getByLabel("Medicine (generic), line 2").fill(CLINIC_LAB.byHand);
  await expect(prescription.getByText("Not on the list", { exact: true })).toHaveCount(1);
  await expect(prescription.getByText("On the list", { exact: true })).toHaveCount(1);
  // Saved without a reason: stopped, with the warning said.
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText(/Give your reason to go on, or change the prescription\.$/)).toBeVisible();
  // With the reason, saved; the warning and the reason stay with the line.
  await warnings.getByLabel("Reason to go on, line 1").fill(CLINIC_LAB.reason);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`^${allergic.name} · OP`) })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Medicine (generic), line 1")).toHaveValue(amoxicillin.genericName);
  await expect(warnings).toContainText("Amoxicillin is in Penicillins.");
  await expect(warnings.getByLabel("Reason to go on, line 1")).toHaveValue(CLINIC_LAB.reason);
  await noSidewaysScroll(page, "the consultation at 1280");

  // The drug list itself, the doctors' in Business Admin.
  await page.goto(`${fixture().urls.staff}/business-admin/${clinic.id}/clinic-drugs`);
  await expect(page.getByRole("heading", { level: 1, name: "Drug list", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("row").filter({ hasText: `${amoxicillin.genericName} ${amoxicillin.strength}` })).toContainText(amoxicillin.allergyGroup);
  await expect(page.getByRole("navigation", { name: "Related pages" }).getByRole("link", { name: "Drug list" })).toHaveAttribute("aria-current", "page");
});
