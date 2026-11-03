import fs from "node:fs";
import { expect, test } from "@playwright/test";

import { account, business, fixture } from "../../../../e2e/fixture.mjs";

// A business's guest page in its own look (words and looks per business
// type), in the light and the dark look:
//   - the site's own address and a cut-off link never speak of a restaurant's
//     tables, while a table's QR code link still asks for the table's code;
//   - a gym's booking page names the gym in the tab and says nothing of tables;
//   - with its card carrying the gym's look (its type's icon and accent, as
//     Platform › Business types sets them), the band and the browser tab wear
//     the gym's mark, white on its accent. The card is given its look here, in
//     the page's API answer, as the API is to send it (guestBusinessCard).
// The gym's booking link is made here, as Online booking › Booking link makes
// one, and switched off again at the end.

const ACCENTS = Object.fromEntries([...fs.readFileSync(new URL("../../../../packages/ui/src/businessIcons.jsx", import.meta.url), "utf8")
  .matchAll(/(\w+): "(#[0-9a-f]{6})"/g)].map((match) => [match[1], match[2]]));

// The API straight from the test, as the businesses' owner. Each call names the status it expects.
let ownerToken = null;
async function call(method, route, body, expected = 200, token = ownerToken) {
  const response = await fetch(fixture().urls.api + route, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await response.json().catch(() => ({}));
  expect(response.status, `${method} ${route}: ${answer.message}`).toBe(expected);
  return answer.data;
}

let gym = null;
let link = null;
// The gym's booking link, switched on: made once, found again on a rerun.
test.beforeAll(async () => {
  const owner = account("RESTAURANT_ADMIN");
  ownerToken = (await call("POST", "/auth/login", { identifier: owner.email, password: owner.password }, 200, null)).token;
  gym = business("memberships");
  const { locations } = await call("GET", `/businesses/${gym.id}/online-booking`);
  const made = locations.find((entry) => entry.location.id === gym.locationId)?.link;
  link = made
    ? await call("PATCH", `/businesses/${gym.id}/online-booking/links/${made.id}`, { enabled: true })
    : await call("POST", `/businesses/${gym.id}/online-booking/links`, { locationId: gym.locationId }, 201);
});

test.afterAll(async () => {
  if (link) await call("PATCH", `/businesses/${gym.id}/online-booking/links/${link.id}`, { enabled: false }).catch(() => {});
});

const TABLES = /\btables?\b/i;

for (const colorScheme of ["light", "dark"]) {
  test(`a gym's booking page speaks of no tables and wears the gym's mark from its card (${colorScheme})`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ colorScheme, viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    try {
      // The site's own address and a cut-off link: open the business's link again.
      await page.goto(`${fixture().urls.guests}/`);
      await expect(page.getByRole("heading", { name: "Order or book from your link" })).toBeVisible();
      await expect(page.locator("main")).not.toContainText(TABLES);
      await page.goto(`${fixture().urls.guests}/some/old/address`);
      await expect(page.getByRole("heading", { name: "This link isn't complete" })).toBeVisible();
      await expect(page.locator("main")).not.toContainText(TABLES);
      // A table's QR code link cut short still asks for the table's code.
      await page.goto(`${fixture().urls.guests}/order`);
      await expect(page.locator("main")).toContainText("QR code on your table");

      // The gym's booking page, as served.
      const bookingPage = `${fixture().urls.guests}/appointments/${link.token}`;
      await page.goto(bookingPage);
      const band = page.getByRole("banner");
      await expect(band).toContainText(gym.name, { timeout: 15_000 });
      await expect(page).toHaveTitle(`Book online · ${gym.name}`);
      await expect(page.locator("body")).not.toContainText(TABLES);

      // Its card carrying the gym's look: the band's mark and the tab's, in the gym's accent.
      const types = (await call("GET", "/site/pricing", undefined, 200, null)).types;
      const { icon, accent } = types.find((type) => type.code === gym.type);
      await page.route((url) => url.pathname.endsWith(`/public/appointments/${link.token}`), async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        json.data.card = { ...json.data.card, look: { icon, accent } };
        await route.fulfill({ response, json });
      });
      await page.goto(bookingPage);
      const mark = band.locator(".gs-mark");
      await expect(mark).toBeVisible({ timeout: 15_000 });
      await expect(mark.locator("svg")).toHaveCount(1);
      expect(await mark.getAttribute("style")).toContain(`--gs-mark: ${ACCENTS[accent]}`);
      const tabIcon = await page.locator('link[rel="icon"]').getAttribute("href");
      expect(decodeURIComponent(tabIcon)).toContain(`fill="${ACCENTS[accent]}"`);
      await page.screenshot({ path: testInfo.outputPath(`gym-booking-${colorScheme}.png`) });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
