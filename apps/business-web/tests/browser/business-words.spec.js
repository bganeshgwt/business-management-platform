import { expect, test } from "@playwright/test";

import { business, signIn } from "../../../../e2e/fixture.mjs";

// Words and looks per business type, as an owner and the platform meet them:
//   - the gym's switcher mark in its colour; its menu in its words;
//   - the owner renames members to clients in Business settings › Words, and
//     the bills and the members' tabs follow; back to the type's words;
//   - the platform changes the gym type's bookable people in Platform ›
//     Business types, and the gym's screen follows at once.
// What it changes it puts back through the API, whatever happens: other
// specs share the run's gym.
test.describe.configure({ mode: "serial" });

let gym = null;
test.beforeEach(() => {
  gym = business("memberships");
});

// A call to the API as the signed-in person, through the app's own client.
const callApi = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const { default: api } = await import("/src/services/api.js");
  return (await api[method](url, body)).data.data;
}, { method, url, body });

test("the owner's words: members renamed to clients, and back to the gym's", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  try {
    await page.goto(`/business-admin/${gym.id}`);
    await expect(page.locator("main.content-scroll")).toBeVisible({ timeout: 30_000 });
    // The gym's mark, in its colour.
    await expect(page.locator(".bsw-trigger .bsw-type")).toHaveClass(/type-accent-rose/);
    await expect(page.locator(".bsw-trigger .bsw-type svg")).toHaveCount(1);

    await page.goto(`/business-admin/${gym.id}/settings`);
    const words = page.locator("#bz-settings-words");
    await expect(words.getByRole("heading", { name: "Words" })).toBeVisible({ timeout: 30_000 });
    await expect(words.getByLabel("Kind of business")).toContainText("Coaching & tuition centre");
    await expect(words.locator(".words-preview")).toContainText("Member contacts");
    await words.getByLabel("The people you serve: the word").fill("Client");
    await words.getByLabel("The people you serve: its plural").fill("Clients");
    await words.getByLabel("Your list of the people you bill: the word").fill("Client contact");
    await words.getByLabel("Your list of the people you bill: its plural").fill("Client contacts");
    await expect(words.locator(".words-preview")).toContainText("Client contacts");
    await words.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("words-section.png"), fullPage: true });
    await words.getByRole("button", { name: "Save words" }).click();
    await expect(page.getByText("Words saved. Every screen uses them now.")).toBeVisible({ timeout: 15_000 });

    // The bills and the members' tabs say it.
    await page.goto(`/business-admin/${gym.id}/sales`);
    const heading = (name) => page.locator("thead th .dg-head-label").getByText(name, { exact: true });
    await expect(heading("Client")).toBeVisible({ timeout: 30_000 });
    await page.goto(`/business-admin/${gym.id}/members`);
    await expect(page.getByRole("navigation", { name: "Related pages" }).getByRole("link", { name: "Client contacts" })).toBeVisible({ timeout: 30_000 });

    // Back to the gym's own words.
    await page.goto(`/business-admin/${gym.id}/settings`);
    await expect(words.getByRole("button", { name: "Use “Member”" })).toBeVisible({ timeout: 30_000 });
    await words.getByRole("button", { name: "Use “Member”" }).click();
    await words.getByRole("button", { name: "Use “Member contact”" }).click();
    await words.getByRole("button", { name: "Save words" }).click();
    await expect(page.getByText("Words saved. Every screen uses them now.")).toBeVisible({ timeout: 15_000 });
    await page.goto(`/business-admin/${gym.id}/sales`);
    await expect(heading("Member")).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  } finally {
    await callApi(page, "put", `/businesses/${gym.id}/words`, { words: { customer: null, customer_list: null } }).catch(() => {});
  }
});

test("the platform changes a gym's bookable people, and the gym follows", async ({ page, browser }, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, "SUPER_ADMIN");
  try {
    await page.goto("/platform/business-types");
    await expect(page.getByRole("heading", { level: 1, name: "Business types" })).toBeVisible({ timeout: 30_000 });
    const card = page.getByRole("link", { name: /Gyms, studios & coaching/ });
    await expect(card).toContainText("Yoga studio");
    await page.screenshot({ path: testInfo.outputPath("business-types.png"), fullPage: true });
    await card.click();
    await expect(page.getByRole("heading", { level: 1, name: "Gyms, studios & coaching" })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("What can be booked: the word").fill("Coach or studio");
    await page.getByLabel("What can be booked: its plural").fill("Coaches & studios");
    await expect(page.locator(".bt-preview")).toContainText("Coaches & studios");
    await page.screenshot({ path: testInfo.outputPath("business-type.png"), fullPage: true });
    await page.getByRole("button", { name: "Save the type" }).click();
    await expect(page.getByText("Saved. Every business of this type sees it now.")).toBeVisible({ timeout: 15_000 });

    // The gym's owner sees it on the bookable list at once.
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await signIn(ownerPage);
    await ownerPage.goto(`${new URL(page.url()).origin}/business-admin/${gym.id}/resources`);
    await expect(ownerPage.getByRole("heading", { level: 1, name: "Coaches & studios" })).toBeVisible({ timeout: 30_000 });
    await owner.close();

    // A kind's own words are edited apart from the type's.
    await page.getByRole("button", { name: "Yoga studio" }).click();
    await expect(page.getByLabel("Who serves at a booking: the word")).toHaveValue("Teacher");
    expect(errors).toEqual([]);
  } finally {
    await callApi(page, "put", "/users/platform/business-types/memberships", { words: { resource: { one: "Trainer or studio", many: "Trainers & studios" } } }).catch(() => {});
  }
});
