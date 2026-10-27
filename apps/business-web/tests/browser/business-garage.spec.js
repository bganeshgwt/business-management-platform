import { test, expect } from "@playwright/test";

import { GARAGE, business, signIn } from "../../../../e2e/fixture.mjs";

// The garage's screens. Signs in as the test restaurant's admin, who owns the
// test garage (e2e/test-data.mjs): engine oil and an oil filter in stock,
// service labour, a customer's car with its last reading and its insurance
// running out within the month, and a scooter due for its service.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("garage");
  // Printing and WhatsApp stay in the page: what would print, and the link that would open.
  await page.addInitScript(() => {
    window.print = () => { window.printed = (window.printed || 0) + 1; };
    window.open = (url) => { window.opened = [...(window.opened || []), String(url)]; return null; };
  });
  await signIn(page);
  await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

// Types into a search box and takes the option that starts with `text`.
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option", { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
}

test("a job card: the car found by its plate, the estimate approved by the owner, the work done, billed and delivered", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}`);
  // Job cards is a daily entry of its own.
  await expect(page.locator(".sidebar").getByRole("link", { name: "Job cards", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${shop.id}/job-cards?new=1`);
  const dialog = page.getByRole("dialog", { name: "Open a job card" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // The plate as people type it finds the car, its owner and its last reading.
  await dialog.getByLabel("Registration number").fill("ts 09 ea-4521");
  await expect(dialog.getByText(`owner ${GARAGE.owner.name}`)).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText("last reading 41,250 km")).toBeVisible();
  await dialog.getByLabel("Odometer in (km)").fill("41603");
  await dialog.getByLabel("Fuel level in").selectOption({ label: "Half" });
  await dialog.getByLabel("Complaint 1").fill("Periodic service");
  await dialog.getByRole("button", { name: "Add a complaint" }).click();
  await dialog.getByLabel("Complaint 2").fill("Brake noise at low speed");
  await page.screenshot({ path: testInfo.outputPath("job-card-dialog.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Open the job card" }).click();
  await expect(page.getByRole("heading", { name: /^Job card JC\//, level: 1 })).toBeVisible({ timeout: 15_000 });

  // The estimate: the labour, 3.5 litres of oil and the filter, at the customer's prices (GST included, rounded to the rupee).
  await page.getByRole("button", { name: "Write the estimate" }).click();
  const estimate = page.getByRole("dialog", { name: /^Estimate for JC\// });
  await expect(estimate).toBeVisible();
  await pick(page, estimate.getByRole("combobox", { name: "Labour" }), GARAGE.labour.name);
  await estimate.getByRole("button", { name: "Add a part" }).click();
  await pick(page, estimate.getByRole("combobox", { name: "Part" }), GARAGE.oil.name);
  await estimate.getByLabel("Qty (litre)").fill("3.5");
  await estimate.getByRole("button", { name: "Add a part" }).click();
  await pick(page, estimate.getByRole("combobox", { name: "Part" }).last(), GARAGE.filter.name);
  // 1,000 + 3.5 × 449.90 + 380 = 2,954.65, rounded to 2,955.
  await expect(estimate.getByText("Total ₹2,955.00")).toBeVisible({ timeout: 15_000 });
  await expect(estimate.getByText("Round-off ₹0.35")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("estimate-dialog.png"), fullPage: true });
  await estimate.getByRole("button", { name: "Save the estimate" }).click();
  await expect(estimate).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Estimate · version 1")).toBeVisible();

  // Sent to the owner, approved on WhatsApp, the work started, done and the vehicle ready.
  const step = async (button, fill) => {
    await page.getByRole("button", { name: button, exact: true }).first().click();
    const form = page.getByRole("dialog", { name: button });
    await expect(form).toBeVisible();
    if (fill) await fill(form);
    await form.getByRole("button", { name: button }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
  };
  await step("Send the estimate", (form) => form.getByLabel("Note (optional)").fill("Sent on WhatsApp"));
  await expect(page.getByText("Estimate sent", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Record the owner's approval" }).click();
  const approval = page.getByRole("dialog", { name: /^The owner's approval of JC\// });
  await expect(approval.getByLabel("Approved by")).toHaveValue(GARAGE.owner.name);
  await approval.getByLabel("How").selectOption({ label: "On WhatsApp" });
  await approval.getByRole("button", { name: "Record the approval" }).click();
  await expect(approval).toBeHidden({ timeout: 15_000 });
  await step("Start work");
  await page.getByRole("button", { name: "Record the work done" }).click();
  const work = page.getByRole("dialog", { name: /^Work done on JC\// });
  for (const box of await work.getByRole("checkbox").all()) await box.check();
  await work.getByRole("button", { name: "Save", exact: true }).click();
  await expect(work).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("3 of 3")).toBeVisible();
  await step("Work done: ready");
  await expect(page.getByText("Ready", { exact: true }).first()).toBeVisible();

  // The workshop copy has the work and never the prices; the customer copy has the estimate's total.
  await page.getByRole("button", { name: "Workshop copy" }).click();
  const printed = page.locator("#print-root");
  await expect(printed).toContainText("workshop copy");
  await expect(printed).toContainText("Brake noise at low speed");
  await expect(printed).not.toContainText("₹");
  await page.getByRole("button", { name: "Customer copy" }).click();
  await expect(printed).toContainText("₹2,955.00");

  // Billed and delivered: one bill at the estimate's prices, paid in cash; the next service set on the car.
  await page.getByRole("button", { name: "Bill and deliver" }).click();
  const bill = page.getByRole("dialog", { name: /^Bill and deliver JC\// });
  await expect(bill).toContainText("The bill comes to ₹2,955.00");
  await expect(bill.getByLabel("Next service at (km)")).toHaveValue("46603");
  await page.screenshot({ path: testInfo.outputPath("bill-dialog.png"), fullPage: true });
  await bill.getByRole("button", { name: "Post the bills and deliver" }).click();
  await expect(bill).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/bill SI\//).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("job-card-delivered.png"), fullPage: true });

  // The delivered job card leaves the board and stays in the list by date.
  await page.goto(`/business-admin/${shop.id}/job-cards`);
  await expect(page.getByRole("heading", { name: "Job cards", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "All job cards by date" }).click();
  await expect(page.getByRole("row").filter({ hasText: GARAGE.car.registrationNo }).filter({ hasText: "Delivered" })).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("vehicles: a plate found however it is typed, and the car's page with its owner and odometer log", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/vehicles`);
  await expect(page.getByRole("heading", { name: "Vehicles", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder("Plate, make or model, owner, phone or chassis").fill("ts 09 ea 4521");
  const row = page.getByRole("row").filter({ hasText: GARAGE.car.registrationNo });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row").filter({ hasText: GARAGE.scooter.registrationNo })).toHaveCount(0);
  await row.getByText(GARAGE.car.registrationNo).first().click();
  await expect(page.getByRole("heading", { name: GARAGE.car.registrationNo, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Odometer readings" })).toContainText("41,250 km");
  await expect(page.getByText(`${GARAGE.owner.name} · ${GARAGE.owner.phone}`).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("service due: the scooter due for its service and the car's insurance running out, with the reminder ready on WhatsApp", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/service-due`);
  await expect(page.getByRole("heading", { name: "Service due", level: 1 })).toBeVisible({ timeout: 30_000 });
  const scooter = page.getByRole("row").filter({ hasText: GARAGE.scooter.registrationNo });
  await expect(scooter).toContainText("in 3 days", { timeout: 15_000 });
  await expect(page.getByRole("row").filter({ hasText: GARAGE.car.registrationNo }).filter({ hasText: "Insurance" })).toBeVisible();
  await scooter.getByRole("button", { name: "WhatsApp" }).click();
  // A reminder needs the owner's consent to reminders: they are asked first, and their yes recorded in one tap.
  const ask = page.getByRole("dialog", { name: `Ask ${GARAGE.scooterOwner.name} first` });
  await expect(ask).toContainText("has not agreed to reminders");
  await ask.getByRole("button", { name: "They agree: send it" }).click();
  await expect(ask).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window.opened || []).join(" "))).toContain(`wa.me/91${GARAGE.scooterOwner.phone}`);
  await expect(scooter).toContainText("1 reminder", { timeout: 15_000 });
  // Only what is due for insurance.
  await page.getByRole("button", { name: "Insurance", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: GARAGE.scooter.registrationNo })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("row").filter({ hasText: GARAGE.car.registrationNo })).toBeVisible();
  expect(errors).toEqual([]);
});

test("garage settings: the next service after a job, and the item for the owner's share of a claim made in one go", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/garage-settings`);
  await expect(page.getByRole("heading", { name: "Garage settings", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Months after a job")).toHaveValue("6");
  await expect(page.getByText("Now 6 months or 5,000 km, whichever comes first.")).toBeVisible();
  await page.getByRole("button", { name: "Make the item" }).click();
  await expect(page.getByRole("combobox", { name: "Claim-share item" })).toHaveValue("Insurance claim: owner's share", { timeout: 15_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Garage settings saved.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^Last saved by /)).toBeVisible();
  expect(errors).toEqual([]);
});
