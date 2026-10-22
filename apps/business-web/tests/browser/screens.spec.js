import { test, expect } from "@playwright/test";
import fs from "node:fs";
import process from "node:process";

// Explicit opt-in credentials: no known default password and no guessing.
// Only signs in and reads screens; business writes belong to the isolated API suite.
const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const account = credentialsFile
  ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts.find(a => a.role === "RESTAURANT_ADMIN")
  : null;
const source = fs.readFileSync(new URL("../../src/App.jsx", import.meta.url), "utf8");
const routes = ["/", ...source.matchAll(/<Route path="([^"*:]+)"/g)]
  .map(item => typeof item === "string" ? item : "/" + item[1].replace(/^\//, ""))
  .filter(route => route !== "/login");
// The platform console belongs to the platform's own super admin; a restaurant
// admin must be turned away there, so it is checked separately below.
const platformRoutes = routes.filter(route => route.startsWith("/platform/"));
const restaurantRoutes = routes.filter(route => !route.startsWith("/platform/"));

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`all authenticated screens load at ${viewport.width}px`, async ({ page }) => {
    // Every screen at one width, on the large test database: about 3.5
    // minutes on a quiet machine. Each route is its own step, so a failure
    // still names the screen.
    test.setTimeout(600_000);
    test.skip(!account, "Set E2E_CREDENTIALS_FILE to the gitignored demo credentials file.");
    const failures = [];
    page.on("pageerror", error => failures.push(error.message));
    page.on("response", response => {
      if (response.status() >= 500) failures.push(`${response.status()} ${response.url()}`);
    });
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await page.locator('input[autocomplete="username"]').fill(account.email);
    await page.locator('input[autocomplete="current-password"]').fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    try {
      await expect(page.locator("main.content-scroll")).toBeVisible();
    } finally {
      // Keep a failed-login snapshot from containing the entered password.
      const passwordInput = page.locator('input[autocomplete="current-password"]');
      if (await passwordInput.count()) await passwordInput.fill("");
    }
    for (const route of platformRoutes) {
      await test.step(`${route} is refused to a restaurant admin`, async () => {
        await page.goto(route);
        await expect(page.locator("main.content-scroll")).toContainText(/Access denied/i);
      });
    }
    for (const route of [...restaurantRoutes,"/inventory/items?tab=batches"]) {
      await test.step(route, async () => {
        await page.goto(route);
        const content = page.locator(route === '/collection' ? 'main.col-screen' : 'main.content-scroll');
        await expect(content).toBeVisible();
        await page.waitForLoadState("networkidle");
        await expect(content).not.toContainText("Loading screen");
        expect(await content.innerText()).not.toMatch(/Internal server error|Access denied|Something went wrong/i);
        expect(failures, `Errors on ${route}`).toEqual([]);
      });
    }
    await page.goto("/menu/products");
    await page.getByRole("button",{name:/More actions for/}).first().click();
    await page.getByRole("menuitem",{name:"Prices & outlets"}).click();
    await expect(page.getByRole("button",{name:"Save rule",exact:true})).toBeVisible();
    await page.locator(".modal-close").click();
    await page.getByRole("button",{name:/More actions for/}).first().click();
    await page.getByRole("menuitem",{name:"Serving times & combo choices"}).click();
    await expect(page.getByRole("button",{name:"Add serving period",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Add combo group",exact:true})).toBeVisible();
    await page.locator(".modal-close").click();
    await page.getByRole("button",{name:/More actions for/}).first().click();
    await page.getByRole("menuitem",{name:"Sizes & add-ons"}).click();
    await expect(page.getByRole("button",{name:"Add choice group",exact:true})).toBeVisible();
    await page.locator(".modal-close").click();
    // An add-on's ingredient recipe and the production tab belong to the
    // Stock & recipes feature: with it switched off the option is hidden by
    // design, so the profile the screen reads decides what to expect.
    const profile = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/auth/me"));
    await page.goto("/menu/modifiers");
    const recipesOn = ((await (await profile).json()).data.features || []).includes("stock_recipes");
    // The list may still be settling on a slow machine: open the row's menu until it shows.
    await expect(async () => {
      await page.getByRole("button",{name:/More actions for/}).first().click();
      await expect(page.getByRole("menu")).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    if (recipesOn) {
      await page.getByRole("menuitem",{name:"Ingredient recipe"}).click();
      await expect(page.getByText("Stock used each time this add-on is sold.")).toBeVisible();
      await page.getByRole("button",{name:"Cancel",exact:true}).click();
      await page.goto("/inventory/items?tab=production");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main.content-scroll")).toBeVisible();
      await expect(page.getByText("Prepared items and sub-recipes")).toBeVisible();
    } else {
      await expect(page.getByRole("menuitem",{name:"Switch off"}).or(page.getByRole("menuitem",{name:"Switch on"}))).toBeVisible();
      await expect(page.getByRole("menuitem",{name:"Ingredient recipe"})).toHaveCount(0);
      await page.keyboard.press("Escape");
    }

    await page.waitForLoadState("networkidle");
    expect(failures).toEqual([]);
  });
}
