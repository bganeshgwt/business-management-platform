import { test, expect } from "@playwright/test";

import { fixture, GST_THRESHOLDS, localDate, signIn } from "../../../../e2e/fixture.mjs";

// An owner's GST thresholds across their businesses (e2e/test-data.mjs ›
// GST_THRESHOLDS). As the GST owner: GST thresholds, from the business
// switcher, groups their businesses by PAN: the hardware shop and the building
// supplies store past ₹5 crore this year, so e-invoicing and 6-digit HSN / SAC
// codes apply from the next 1 April, with the hardware shop's 4-digit code to
// fix; the firm past it last year, so they apply now. The kirana with no GSTIN
// is not linked until the owner records its PAN; the warning level is the
// owner's own; the figures show their sources; Your businesses sums each PAN
// up; each bell says when its PAN's figures apply, and the firm's catalogue
// lists its code to fix now. As the hardware shop's manager: the warning on
// the bell, the PAN masked and no sums, opens the catalogue's codes to fix
// from the next 1 April, and fixing the code there clears it.

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
};
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// The financial years on the shops' clock, as the screens name them.
function years() {
  const [y, m] = localDate().split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  const label = (from) => `${from}-${String((from + 1) % 100).padStart(2, "0")}`;
  return { thisYear: label(start), lastYear: label(start - 1), nextApril: `1 April ${start + 1}`, nextAprilShort: `1 Apr ${start + 1}` };
}

test("an owner sees their businesses grouped by PAN, records a PAN, sets the warning level, and a manager is warned on the bell", async ({ page, browser }, testInfo) => {
  const shops = fixture().gstThresholds;
  const { pan, hardware, supplies, firm, kirana } = GST_THRESHOLDS;
  const { thisYear, lastYear, nextApril, nextAprilShort } = years();
  // Passed this year so far: from the next 1 April. Passed last year: now.
  const PASSED = `Turnover has passed ₹5 crore in ${thisYear} so far: from ${nextApril}, e-invoicing and 6-digit HSN / SAC codes on invoices apply`;
  const APPLIES_NOW = `Turnover passed ₹5 crore in ${lastYear}: e-invoicing and 6-digit HSN / SAC codes on invoices apply`;
  const errors = errorsOf(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "GST_OWNER");
  // An owner of shops only lands in one of them.
  await expect(page).toHaveURL(/\/business-admin\/\d+$/, { timeout: 30_000 });

  // From the switcher, beside All businesses.
  await page.getByRole("button", { name: /Switch business$/ }).click();
  await page.getByRole("link", { name: "GST thresholds", exact: true }).click();
  await expect(page).toHaveURL(/\/business-admin\/gst-thresholds$/);
  await expect(page.getByRole("heading", { level: 1, name: "GST thresholds" })).toBeVisible({ timeout: 30_000 });

  // The PAN's group: two businesses past ₹5 crore together this year, each
  // from its GSTIN; what applies there applies from the next 1 April.
  const group = page.locator("section.gst-group").filter({ has: page.getByRole("heading", { name: `PAN ${pan}` }) });
  await expect(group).toContainText("2 businesses");
  await expect(group).toContainText(PASSED);
  await expect(group.getByText(`Applies from ${nextAprilShort}`).first()).toBeVisible();
  await expect(group.getByText("Applies now")).toHaveCount(0);
  await expect(group).toContainText(`carries a 6-digit HSN / SAC code from ${nextApril}`);
  await expect(group.getByRole("row").filter({ hasText: hardware.name })).toContainText(`From its GSTIN ${hardware.gstin}`);
  await expect(group.getByRole("row").filter({ hasText: supplies.name })).toContainText(`From its GSTIN ${supplies.gstin}`);
  await expect(group.getByRole("row").filter({ hasText: hardware.name }).getByRole("link", { name: "1 to fix" })).toHaveAttribute("href", `/business-admin/${shops.hardware.id}/products`);
  await expect(group.getByRole("row").filter({ hasText: supplies.name })).toContainText("None");

  // The firm's own PAN: past ₹5 crore last year, so it applies now.
  const firmGroup = page.locator("section.gst-group").filter({ has: page.getByRole("heading", { name: `PAN ${firm.pan}` }) });
  await expect(firmGroup).toContainText("1 business");
  await expect(firmGroup).toContainText(APPLIES_NOW);
  await expect(firmGroup.getByText("Applies now").first()).toBeVisible();
  await expect(firmGroup).toContainText("carries a 6-digit HSN / SAC code now");
  await expect(firmGroup.getByRole("row").filter({ hasText: firm.name }).getByRole("link", { name: "1 to fix" })).toHaveAttribute("href", `/business-admin/${shops.firm.id}/products`);

  // The kirana has no GSTIN: not linked until its PAN is recorded.
  const unlinked = page.locator("section").filter({ has: page.getByRole("heading", { name: "Not linked to a PAN" }) });
  await expect(unlinked.getByRole("row").filter({ hasText: kirana.name })).toContainText("No GSTIN, and no PAN recorded");
  await unlinked.getByRole("row").filter({ hasText: kirana.name }).getByRole("button", { name: "Record PAN" }).click();
  const dialog = page.getByRole("dialog", { name: `The PAN ${kirana.name} trades under` });
  await dialog.getByLabel("PAN", { exact: true }).fill(pan.toLowerCase());
  await dialog.getByRole("button", { name: "Save PAN" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`${kirana.name} counts under PAN ${pan}.`)).toBeVisible();
  await expect(group).toContainText("3 businesses");
  await expect(group.getByRole("row").filter({ hasText: kirana.name })).toContainText("Recorded by you");
  await expect(page.getByRole("heading", { name: "Not linked to a PAN" })).toHaveCount(0);

  // The owner's own warning level.
  const warn = page.locator("form").filter({ has: page.getByRole("heading", { name: "When to warn" }) });
  await expect(warn.getByLabel("Warn from (% of a figure)")).toHaveValue("80");
  await warn.getByLabel("Warn from (% of a figure)").fill("90");
  await warn.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("You are warned from 90% of each figure.")).toBeVisible();
  await expect(warn.getByLabel("Warn from (% of a figure)")).toHaveValue("90");

  // The figures, each with its source.
  const figures = page.getByRole("table", { name: "The figures for GST thresholds" });
  await expect(figures).toContainText("ClearTax");
  await expect(figures).toContainText("₹10 crore or more");
  await expect(figures).toContainText("From 1 Apr 2025");
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("gst-thresholds.png"), fullPage: true });

  // Your businesses sums each PAN up.
  await page.goto("/business-admin?all=1");
  const summary = page.locator(".gst-summary-card");
  await expect(summary).toContainText(`PAN ${pan}`, { timeout: 30_000 });
  await expect(summary).toContainText(PASSED);
  await expect(summary.getByRole("listitem").filter({ hasText: `PAN ${pan}` })).toContainText(`Applies from ${nextAprilShort}`);
  await expect(summary.getByRole("listitem").filter({ hasText: `PAN ${firm.pan}` })).toContainText(APPLIES_NOW);
  await expect(summary.getByRole("link", { name: "Open GST thresholds" })).toHaveAttribute("href", "/business-admin/gst-thresholds");

  // The owner's bell in the hardware shop: the PAN in full, from the next 1 April.
  await page.goto(`/business-admin/${shops.hardware.id}`);
  await page.getByRole("button", { name: /^Notifications, \d+ unread, \d+ critical$/ }).click({ timeout: 30_000 });
  const ownerBell = page.getByRole("dialog", { name: "Notifications" });
  await expect(ownerBell).toContainText(PASSED);
  await expect(ownerBell).toContainText(`PAN ${pan} · ₹5.1 crore`);
  await page.keyboard.press("Escape");

  // In the firm: the bell says it applies now, from last year's turnover, and
  // the catalogue lists the code to fix now.
  await page.goto(`/business-admin/${shops.firm.id}`);
  await page.getByRole("button", { name: /^Notifications, \d+ unread, \d+ critical$/ }).click({ timeout: 30_000 });
  const firmBell = page.getByRole("dialog", { name: "Notifications" });
  await expect(firmBell).toContainText(APPLIES_NOW);
  await expect(firmBell).toContainText(`PAN ${firm.pan} · ₹6 crore in ${lastYear}, across 1 business`);
  await page.keyboard.press("Escape");
  await page.goto(`/business-admin/${shops.firm.id}/products`);
  const firmToFix = page.locator("section").filter({ has: page.getByRole("heading", { name: "HSN / SAC codes to fix" }) });
  await expect(firmToFix).toContainText("This applies to this business's invoices now", { timeout: 30_000 });
  await expect(firmToFix).toContainText(firm.item.name);
  await expect(firmToFix).toContainText(firm.item.sac);
  expect(errors).toEqual([]);

  // The hardware shop's manager: the warning, the PAN masked, no sums.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();
  const phoneErrors = errorsOf(phone);
  try {
    await signIn(phone, "GST_MANAGER");
    await expect(phone).toHaveURL(new RegExp(`/business-admin/${shops.hardware.id}$`), { timeout: 30_000 });
    await phone.getByRole("button", { name: /^Notifications, \d+ unread, \d+ critical$/ }).click({ timeout: 30_000 });
    const bell = phone.getByRole("dialog", { name: "Notifications" });
    const line = bell.getByRole("button").filter({ hasText: PASSED });
    await expect(line).toContainText("PAN ••••••234K · the businesses under this PAN together");
    await expect(bell).not.toContainText(pan);
    // No sums: neither the PAN's turnover nor its share of the figure.
    await expect(bell).not.toContainText("₹5.1 crore");
    await expect(bell).not.toContainText("% of ₹5 crore");
    // It opens the catalogue, with the codes to fix before the next 1 April.
    await line.click();
    await expect(phone).toHaveURL(new RegExp(`/business-admin/${shops.hardware.id}/products$`));
    const toFix = phone.locator("section").filter({ has: phone.getByRole("heading", { name: "HSN / SAC codes to fix" }) });
    await expect(toFix).toContainText("6 digits", { timeout: 30_000 });
    await expect(toFix).toContainText(`This applies to this business's invoices from ${nextApril}`);
    await expect(toFix).toContainText(hardware.item.name);
    await expect(toFix).toContainText(hardware.item.sac);
    await toFix.getByRole("button", { name: "Edit", exact: true }).click();
    const item = phone.getByRole("dialog", { name: `Edit ${hardware.item.name}` });
    await item.getByLabel("SAC code (optional)").fill(GST_THRESHOLDS.fixedSac);
    await item.getByRole("button", { name: "Save", exact: true }).click();
    await expect(item).toHaveCount(0);
    await expect(phone.getByRole("heading", { name: "HSN / SAC codes to fix" })).toHaveCount(0);
    // A manager who owns no business has no GST thresholds of their own.
    await phone.goto(`${fixture().urls.staff}/business-admin/gst-thresholds`);
    await expect(phone.getByRole("heading", { name: "For a business's owner" })).toBeVisible({ timeout: 30_000 });
    expect(await noSideScroll(phone)).toBe(true);
    expect(phoneErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
