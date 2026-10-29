import { Buffer } from "node:buffer";
import { test, expect } from "@playwright/test";

import { GARAGE, business, signIn } from "../../../../e2e/fixture.mjs";

// The garage's screens beyond the job card's first round: a mechanic's own
// screen on a phone (their job card, the work ticked done, a note), the parts
// that fit a car with the newer number offered for an old one out of stock,
// the parts fitment screen, the inspection's photos and the road test on a
// job card, and the settings' plans and commission rates with the mechanics'
// commission report. The data (e2e/build-data.mjs): the scooter's job card
// assigned to the mechanic, its work started; the oil filter and its older
// number fitting the car.
let shop = null;
test.beforeEach(() => {
  shop = business("garage");
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};
// A tiny PNG: the bytes the server checks a photo by.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("a mechanic's own screen: their job card, the work ticked done and a note, and no prices", async ({ page }, testInfo) => {
    const errors = errorsOf(page);
    await signIn(page, "MECHANIC");
    await page.goto(`/business-admin/${shop.id}/job-cards`);
    await expect(page.getByRole("heading", { name: "My job cards", level: 1 })).toBeVisible({ timeout: 30_000 });
    const card = page.getByRole("button", { name: new RegExp(GARAGE.scooter.registrationNo) });
    await expect(card).toContainText(GARAGE.mechanicJob.complaint, { timeout: 15_000 });
    await page.screenshot({ path: testInfo.outputPath("mechanic-board-375.png"), fullPage: true });
    await card.click();
    await expect(page.getByRole("heading", { name: `${GARAGE.scooter.make} ${GARAGE.scooter.model}`, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(GARAGE.mechanicJob.complaint)).toBeVisible();
    // The labour ticked done.
    const labour = page.getByRole("checkbox", { name: new RegExp(`^${GARAGE.labour.name}`) });
    // The box follows the server's answer: it is ticked once the job card comes back.
    await labour.click();
    await expect(page.getByText(`${GARAGE.labour.name}: done.`)).toBeVisible({ timeout: 15_000 });
    await expect(labour).toBeChecked();
    await expect(page.getByText(`${GARAGE.oil.name} × 1 litre`)).toBeVisible();
    // A note into the job card's history.
    await page.getByRole("textbox", { name: "Note" }).fill("Rear brake shoes worn: tell the owner");
    await page.getByRole("button", { name: "Save the note" }).click();
    await expect(page.getByText("Note added.")).toBeVisible({ timeout: 15_000 });
    // No money anywhere, and the screen fits the phone.
    await expect(page.locator("main")).not.toContainText("₹");
    const overflow = await page.evaluate(() => {
      const screen = document.querySelector(".gar-phone");
      return { inner: screen.scrollWidth - screen.clientWidth, right: Math.ceil(screen.getBoundingClientRect().right) };
    });
    expect(overflow.inner).toBeLessThanOrEqual(0);
    expect(overflow.right).toBeLessThanOrEqual(375);
    await page.screenshot({ path: testInfo.outputPath("mechanic-job-375.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
});

test.describe("at the desk", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
  });

  test("parts that fit the car, the newer number offered for the old one out of stock, and the parts fitment screen", async ({ page }) => {
    const errors = errorsOf(page);
    await page.goto(`/business-admin/${shop.id}/vehicles/${shop.car.id}`);
    const parts = page.getByRole("table", { name: "Parts that fit this vehicle" });
    await expect(parts).toContainText(GARAGE.filter.name, { timeout: 30_000 });
    const old = parts.getByRole("row").filter({ hasText: GARAGE.oldFilter.name });
    await expect(old).toContainText("none");
    await old.getByRole("button", { name: "Out of stock: substitutes" }).click();
    const offer = page.getByRole("dialog", { name: `Instead of ${GARAGE.oldFilter.name}` });
    await expect(offer).toContainText(GARAGE.filter.name, { timeout: 15_000 });
    await expect(offer).toContainText("newer number");
    await page.keyboard.press("Escape");
    await page.goto(`/business-admin/${shop.id}/garage-parts`);
    await expect(page.getByRole("heading", { name: "Parts fitment", level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("table", { name: "Parts fitment" })).toContainText(`${GARAGE.car.make} ${GARAGE.car.model}`, { timeout: 15_000 });
    await expect(page.getByRole("table", { name: "Newer numbers and groups" })).toContainText(GARAGE.oldFilter.name);
    expect(errors).toEqual([]);
  });

  test("a job card's inspection photo and road test; the settings' plans and commission rates; the commission report", async ({ page }, testInfo) => {
    const errors = errorsOf(page);
    await page.goto(`/business-admin/${shop.id}/job-cards/${shop.mechanicJob.id}`);
    await expect(page.getByRole("heading", { name: `Job card ${shop.mechanicJob.jobNo}`, level: 1 })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Area checked").fill("Front mudguard");
    await page.getByLabel("What was found (optional)").fill("Crack near the light");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Inspection item added.")).toBeVisible({ timeout: 15_000 });
    await page.locator("li").filter({ hasText: "Front mudguard" }).locator('input[type="file"]').setInputFiles({ name: "mudguard.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByText("Photo added.")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".gar-photo img").first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Record a road test" }).click();
    const road = page.getByRole("dialog", { name: `Road test of ${GARAGE.scooter.registrationNo}` });
    await road.getByLabel("Distance (km)").fill("3");
    await road.getByRole("button", { name: "Record it" }).click();
    await expect(road).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(/Passed/).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("job-card-inspection.png"), fullPage: true });

    await page.goto(`/business-admin/${shop.id}/garage-settings`);
    await expect(page.getByRole("heading", { name: "Garage settings", level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Issue parts to mechanics", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Add a plan" }).click();
    const plan = page.getByRole("dialog", { name: "A service plan" });
    await plan.getByLabel("Make").fill(GARAGE.car.make);
    await plan.getByLabel("Model").fill(GARAGE.car.model);
    await plan.getByLabel("Kilometres to the next service").fill("10000");
    await plan.getByLabel("Days to the next service").fill("365");
    await plan.getByRole("button", { name: "Save" }).click();
    await expect(plan).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole("table", { name: "Service plans" })).toContainText(`${GARAGE.car.make} ${GARAGE.car.model}`);
    await page.getByRole("button", { name: "Add a rate" }).click();
    const rate = page.getByRole("dialog", { name: "A commission rate" });
    await rate.getByRole("combobox", { name: "Labour item" }).fill(GARAGE.labour.name);
    await page.getByRole("option", { name: new RegExp(`^${GARAGE.labour.name}`) }).first().click();
    await rate.getByLabel("Commission %").fill("10");
    await rate.getByRole("button", { name: "Save" }).click();
    await expect(rate).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole("table", { name: "Commission rates" })).toContainText("10%");

    await page.goto(`/business-admin/${shop.id}/mechanic-commission`);
    await expect(page.getByRole("heading", { name: "Mechanics' commission", level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("table", { name: "Mechanics' commission by mechanic" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
