import { test, expect } from "@playwright/test";

import { OPTICAL, business, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The optical shop's screens. Signs in as the test restaurant's admin, who
// owns the test optical shop (e2e/test-data.mjs): a frame and a single-vision
// lens in stock, the fitting charge, a customer with today's prescription and
// one whose last eye test is over a year old. Contact-lens prescriptions, the
// workshop's steps, a booked order changed, and the contact lenses, lens
// stock and referral pages too.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("optical");
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

// Types into a search box and takes the option that starts with `text` (never
// the "Add … as a new customer" row offered while the search is still running).
async function pick(page, box, text) {
  await box.fill(text);
  await page.getByRole("option", { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
}

test("prescriptions: typed per eye, the left as the right, listed, and side by side in the customer's history", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}`);
  // Spectacle orders is a daily entry of its own.
  await expect(page.locator(".sidebar").getByRole("link", { name: "Spectacle orders", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${shop.id}/prescriptions?new=1`);
  const dialog = page.getByRole("dialog", { name: "Record a prescription" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await pick(page, dialog.getByRole("combobox", { name: "Customer" }), OPTICAL.customer.name);
  await dialog.getByLabel("Right eye, distance: SPH").fill("-2.50");
  await dialog.getByLabel("Right eye, distance: CYL").fill("-0.75");
  await dialog.getByLabel("Right eye, distance: AXIS").fill("180");
  await dialog.getByLabel("Right eye, near: ADD").fill("+1.50");
  await dialog.getByRole("button", { name: "Left eye same as right" }).click();
  await expect(dialog.getByLabel("Left eye, distance: SPH")).toHaveValue("-2.50");
  await dialog.getByLabel("Left eye, distance: AXIS").fill("90");
  await dialog.getByLabel("PD, both eyes (mm, optional)").fill("63");
  await page.screenshot({ path: testInfo.outputPath("prescription-dialog.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Save the prescription" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  // The list: the customer's latest, its powers in one line; the customers' area holds the recall list too.
  await expect(page.getByText("R -2.50 / -0.75 × 180 ADD +1.50 · L -2.50 / -0.75 × 90 ADD +1.50")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "Recall list" })).toBeVisible();
  // The history: the two tests side by side, and how the right SPH moved (-2.25 to -2.50).
  await page.getByRole("button", { name: OPTICAL.customer.name }).first().click();
  await expect(page.getByRole("heading", { name: OPTICAL.customer.name, level: 1 })).toBeVisible({ timeout: 15_000 });
  const history = page.getByRole("table", { name: "Powers at each eye test" });
  await expect(history).toContainText("R SPH");
  await expect(history.locator(".opt-change").first()).toHaveText("-0.25");
  await page.screenshot({ path: testInfo.outputPath("prescription-history.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a spectacle order: booked with an advance, through the lab and the quality check, delivered with its bill", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/spectacle-orders?new=1&prescription=${shop.prescription.id}`);
  const dialog = page.getByRole("dialog", { name: "Book a spectacle order" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // The prescription brings its customer.
  await expect(dialog.getByRole("combobox", { name: "Customer" })).toHaveValue(OPTICAL.customer.name, { timeout: 15_000 });
  await pick(page, dialog.getByRole("combobox", { name: "Frame from stock" }), OPTICAL.frame.name);
  await pick(page, dialog.getByRole("combobox", { name: "Billed as (optional)" }).first(), OPTICAL.lens.name);
  await dialog.getByRole("button", { name: "Same as the right lens" }).click();
  await dialog.getByLabel("Lab's name").fill(OPTICAL.lab);
  await dialog.getByLabel("Promised for").fill(localDate(3));
  await dialog.getByLabel("Advance taken (optional)").fill("2000");
  // The server's price: 2,499 + 1,250 + 1,250, GST included.
  await expect(dialog.getByText(/Total ₹4,999\.00 · to pay at delivery ₹2,999\.00/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("order-dialog.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Book the order" }).click();
  await expect(page.getByRole("heading", { name: /^Order SPO\//, level: 1 })).toBeVisible({ timeout: 15_000 });
  // Sent to the lab with its order number, then the quality check, passed.
  const step = async (button, fill) => {
    await page.getByRole("button", { name: button, exact: true }).first().click();
    const form = page.getByRole("dialog", { name: button });
    await expect(form).toBeVisible();
    if (fill) await fill(form);
    await form.getByRole("button", { name: button }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
  };
  await step("Send to the lab", (form) => form.getByLabel("Lab's order number (optional)").fill("CL-7781"));
  await step("Ready for the quality check");
  await step("Passed the quality check", (form) => form.getByLabel("Note (optional)").fill("Checked on the lensometer"));
  await expect(page.getByText("Ready to collect").first()).toBeVisible();
  // The job card for the lab: the prescription and the lab's order number, never the prices.
  await page.getByRole("button", { name: "Job card", exact: true }).click();
  const printed = page.locator("#print-root");
  await expect(printed).toContainText("Spectacle job card");
  await expect(printed).toContainText("CL-7781");
  await expect(printed).not.toContainText("₹");
  // Delivered: the bill at the booked prices, the advance taken off.
  await page.getByRole("button", { name: "Deliver and bill" }).click();
  const deliver = page.getByRole("dialog", { name: /^Deliver SPO\// });
  await expect(deliver).toContainText("The bill comes to ₹4,999.00, less the advance of ₹2,000.00");
  await deliver.getByRole("button", { name: "Deliver and post the bill" }).click();
  await expect(deliver).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Delivered").first()).toBeVisible();
  await expect(page.getByText(/Bill SI\//).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("order-delivered.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("the recall list: who is due for an eye test, with the reminder ready on WhatsApp", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/recall`);
  await expect(page.getByRole("heading", { name: "Recall list", level: 1 })).toBeVisible({ timeout: 30_000 });
  const row = page.getByRole("row").filter({ hasText: OPTICAL.due.name });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row").filter({ hasText: OPTICAL.customer.name })).toHaveCount(0);
  await row.getByRole("button", { name: "WhatsApp" }).click();
  // A recall reminder needs her consent to reminders: asked first, recorded in one tap.
  const ask = page.getByRole("dialog", { name: `Ask ${OPTICAL.due.name} first` });
  await ask.getByRole("button", { name: "They agree: send it" }).click();
  await expect(ask).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window.opened || []).join(" "))).toContain(`wa.me/91${OPTICAL.due.phone}`);
  await expect(row).toContainText("1 reminder", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("contact lenses: the item form makes one item for each power", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/products?new=1`);
  const dialog = page.getByRole("dialog", { name: "Add an item" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel("Product name").fill("Acuvue Oasys (box of 6)");
  await dialog.getByLabel("Stock unit").selectOption({ label: "Box" });
  await dialog.getByLabel(/Contact lenses: one item for each power/).check();
  await dialog.getByLabel("Base curve (mm)").fill("8.4");
  await dialog.getByLabel("Diameter (mm)").fill("14");
  await dialog.getByLabel("Code prefix").fill("AO6");
  // The range offered first: -0.50 to -6.00 in steps of 0.25.
  await expect(dialog.getByText("23 items made")).toBeVisible();
  await dialog.getByLabel(/^Selling price/).fill("2450");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Acuvue Oasys (box of 6): 23 powers saved.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Acuvue Oasys (box of 6) · -2.50").first()).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a contact-lens prescription: each eye's lens, listed with the contact-lens prescriptions", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/prescriptions?new=1`);
  const dialog = page.getByRole("dialog", { name: "Record a prescription" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("group", { name: "Prescription for" }).getByRole("button", { name: "Contact lenses" }).click();
  await pick(page, dialog.getByRole("combobox", { name: "Customer" }), OPTICAL.customer.name);
  await dialog.getByLabel("Right eye lens: power").fill("-2.00");
  await dialog.getByLabel("Right eye lens: base curve").fill("8.6");
  await dialog.getByLabel("Right eye lens: diameter").fill("14.2");
  await dialog.getByLabel("Right eye lens: replaced").selectOption("monthly");
  await dialog.getByRole("button", { name: "Left lens same as right" }).click();
  await expect(dialog.getByLabel("Left eye lens: base curve")).toHaveValue("8.6");
  await dialog.getByRole("button", { name: "Save the prescription" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await page.getByRole("group", { name: "Prescriptions for" }).getByRole("button", { name: "Contact lenses" }).click();
  await expect(page.getByText("R -2.00 BC 8.6 DIA 14.2 · L -2.00 BC 8.6 DIA 14.2")).toBeVisible({ timeout: 15_000 });
  // The customer's history shows it as a contact-lens test, beside the spectacle ones.
  await page.getByRole("button", { name: OPTICAL.customer.name }).first().click();
  await expect(page.getByRole("heading", { name: /^Contact-lens test of / })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: /^Contact lenses of / })).toContainText("8.6");
  expect(errors).toEqual([]);
});

test("a booked order changed, then made in the workshop step by step before the quality check", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/spectacle-orders?new=1&prescription=${shop.prescription.id}`);
  const dialog = page.getByRole("dialog", { name: "Book a spectacle order" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("combobox", { name: "Customer" })).toHaveValue(OPTICAL.customer.name, { timeout: 15_000 });
  await pick(page, dialog.getByRole("combobox", { name: "Frame from stock" }), OPTICAL.frame.name);
  await pick(page, dialog.getByRole("combobox", { name: "Billed as (optional)" }).first(), OPTICAL.lens.name);
  await dialog.getByRole("button", { name: "Same as the right lens" }).click();
  await dialog.getByLabel("Made", { exact: true }).selectOption("in_house");
  await dialog.getByLabel("Promised for").fill(localDate(2));
  await dialog.getByLabel("Frame size A (mm, optional)").fill("52");
  await dialog.getByLabel("DBL (mm, optional)").fill("18");
  await expect(dialog.getByText(/Total ₹4,999\.00/)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Book the order" }).click();
  await expect(page.getByRole("heading", { name: /^Order SPO\//, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("52 □ 18")).toBeVisible();
  // Booked: its frame and lenses change, priced again (only the right lens now).
  await page.getByRole("button", { name: "Change frame and lenses" }).click();
  const change = page.getByRole("dialog", { name: /^Change SPO\// });
  await expect(change).toBeVisible();
  await change.getByLabel("Left eye lens", { exact: true }).uncheck();
  await change.getByLabel("Why it is changed (optional)").fill("One lens only");
  await expect(change.getByText(/Total ₹3,749\.00/)).toBeVisible({ timeout: 15_000 });
  await change.getByRole("button", { name: "Save the change" }).click();
  await expect(change).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(/^Frame and lenses changed: One lens only/)).toBeVisible({ timeout: 15_000 });
  // Into the workshop: cutting, edging and fitting, each kept with who did it.
  await page.getByRole("button", { name: "Into the workshop", exact: true }).click();
  const into = page.getByRole("dialog", { name: "Into the workshop" });
  await into.getByRole("button", { name: "Into the workshop" }).click();
  await expect(into).toBeHidden({ timeout: 15_000 });
  for (const step of ["Cutting", "Edging", "Fitting"]) {
    await page.getByRole("button", { name: `${step} done`, exact: true }).click();
    const form = page.getByRole("dialog", { name: new RegExp(`^${step} done on SPO`) });
    await form.getByRole("button", { name: `${step} done` }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
  }
  await expect(page.locator(".opt-steps li")).toHaveCount(3);
  await page.getByRole("button", { name: "Ready for the quality check", exact: true }).click();
  const check = page.getByRole("dialog", { name: "Ready for the quality check" });
  await check.getByRole("button", { name: "Ready for the quality check" }).click();
  await expect(check).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("Quality check").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("contact lenses running out and on trial, their stock power by power, and the referral report open", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto(`/business-admin/${shop.id}/contact-lenses`);
  await expect(page.getByRole("heading", { name: "Contact lenses", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Nobody's lenses are running out")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Free trials" }).click();
  await expect(page.getByRole("button", { name: "Give a trial" })).toBeVisible({ timeout: 15_000 });
  await page.goto(`/business-admin/${shop.id}/lens-stock`);
  await expect(page.getByRole("heading", { name: "Contact lens stock", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.goto(`/business-admin/${shop.id}/referrals`);
  await expect(page.getByRole("heading", { name: "Referrals", level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("No referrals in these dates")).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});
