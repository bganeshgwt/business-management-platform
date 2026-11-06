import { expect, test } from "@playwright/test";

import { MEMBERSHIPS, business, localDate, signIn } from "../../../../e2e/fixture.mjs";

// A gym's quotation for a walk-in: the monthly plan with its joining fee and
// a New Year discount. The quotation says its plan is sold one member at a
// time and offers no bill for it; Sell membership opens the sale on the
// quoted plan for the quoted person, at the quoted price with the joining
// fee it quoted; paid in full, the membership is listed on the quotation,
// which is billed. Signs in as the test gym's owner (e2e/test-data.mjs);
// Quotations is switched back off afterwards when it was off.

const callApi = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const { default: api } = await import("/src/services/api.js");
  return (await api[method](url, body)).data.data;
}, { method, url, body });

const rupees = (value) => `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("a gym's quotation: its plan sold as a membership at the quoted price", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const gym = business("memberships");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  const tag = Date.now().toString().slice(-5);
  const name = `Kiran Quote ${tag}`;
  const quotationsOn = (await callApi(page, "get", `/businesses/${gym.id}/modules`)).find((m) => m.code === "quotations")?.enabled;
  if (!quotationsOn) await callApi(page, "put", `/businesses/${gym.id}/modules/quotations`, { enabled: true });

  try {
    const plans = await callApi(page, "get", `/businesses/${gym.id}/member-plans/plans?active=true`);
    const monthly = (Array.isArray(plans) ? plans : plans.items).find((plan) => plan.name === MEMBERSHIPS.monthly.name);
    expect(monthly.joining_sku_id, "the monthly plan has a joining fee").toBeTruthy();
    const location = (await callApi(page, "get", `/businesses/${gym.id}/locations`)).items[0];
    const q = await callApi(page, "post", `/businesses/${gym.id}/quotations`, {
      requestKey: crypto.randomUUID(), locationId: location.id, customerName: name, customerPhone: `98480${tag}`, validUntil: localDate(7),
      lines: [{ skuId: monthly.price_sku_id, quantity: "1" }, { skuId: monthly.joining_sku_id, quantity: "1" }], discount: { amount: "200", reason: "New Year offer" },
    });

    await page.goto(`/business-admin/${gym.id}/quotations?quotation=${q.id}`);
    const detail = page.getByRole("dialog", { name: `Quotation ${q.quotation_no}` });
    await expect(detail).toBeVisible({ timeout: 30_000 });
    await expect(detail.getByText(/Membership plans on this quotation are sold one member at a time with/)).toBeVisible();
    await expect(detail.getByText("Membership plan · 0 of 1 sold")).toBeVisible();
    await expect(detail.getByText(`Joining fee of ${MEMBERSHIPS.monthly.name}: billed with its membership`)).toBeVisible();
    // The plan and its joining fee are all it holds: no bill of its own.
    await expect(detail.getByRole("button", { name: "Make the bill" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("gym-quotation.png") });

    await detail.getByRole("button", { name: "Sell membership" }).click();
    const sale = page.getByRole("dialog", { name: "Sell a membership" });
    await expect(sale).toBeVisible();
    await expect(sale.getByText(`From quotation ${q.quotation_no}: ${MEMBERSHIPS.monthly.name} at the quoted price, for one member.`)).toBeVisible();
    // The quoted person, the quoted plan; no discount or add-ons of its own.
    await expect(sale.getByLabel("Member's name")).toHaveValue(name);
    await expect(sale.getByLabel("Plan")).toBeDisabled();
    await expect(sale.getByLabel("Discount (optional)")).toHaveCount(0);
    await expect(sale.getByText("Add-ons (optional)")).toHaveCount(0);
    // The bill is the quotation's total, with the joining fee it quoted.
    await expect(sale.getByText(`${q.quotation_no} · with the joining fee it quoted`)).toBeVisible({ timeout: 15_000 });
    await expect(sale.locator(".mem-bill strong").first()).toHaveText(rupees(q.total));
    await sale.getByLabel("Paid now").fill(String(Number(q.total)));
    await page.screenshot({ path: testInfo.outputPath("gym-quotation-sale.png") });
    await sale.getByRole("button", { name: "Post the bill" }).click();
    await expect(sale).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(new RegExp(`sold from ${q.quotation_no.replace(/\//g, "\\/")}`))).toBeVisible();

    // The quotation lists the membership and is billed.
    await expect(detail.getByText("Memberships sold from it (1)")).toBeVisible({ timeout: 15_000 });
    await expect(detail.getByRole("link", { name })).toBeVisible();
    await expect(detail.getByText(/^Billed on/)).toBeVisible();
    await expect(detail.getByRole("button", { name: "Sell membership" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (!quotationsOn) await callApi(page, "put", `/businesses/${gym.id}/modules/quotations`, { enabled: false }).catch(() => {});
  }
});
