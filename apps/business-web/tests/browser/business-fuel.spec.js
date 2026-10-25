import { test, expect } from "@playwright/test";

import { FUEL, business, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The fuel station's screens (e2e/test-data.mjs FUEL): a shift its pump
// attendant opens from the totalisers and closes with the 5-litre test, the
// UPI takings and the cash, short against the walk-in sales; a tanker load
// whose density is checked against its invoice before it is decanted; the
// morning dip that ends a day of the stock register, flagged beyond the
// tolerance; and a fleet customer's truck filled on credit at a shift's
// close, then on the customer's statement. Readings are typed: the screens
// never talk to a dispenser or a tank gauge.
let shop = null;
test.beforeEach(async ({ page }) => {
  shop = business("fuel_station");
  // Printing stays in the page: what would print.
  await page.addInitScript(() => {
    window.print = () => { window.printed = (window.printed || 0) + 1; };
  });
});

const errorsOf = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "24 Oct 2026", as the registers write a day.
const dayText = (day) => { const [y, m, d] = day.split("-"); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };

test("a pump attendant opens a shift from the totalisers and closes it with the test, the takings and the cash: short", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page, "PUMP_ATTENDANT");
  await page.goto(`/business-admin/${shop.id}`);
  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("link", { name: "Shift & readings", exact: true })).toBeVisible({ timeout: 30_000 });
  // An attendant keeps their own shift and the dips: no fleet money, no settings.
  await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await sidebar.getByRole("link", { name: "Shift & readings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shift & readings", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("list", { name: "Prices in force" })).toContainText(`₹${FUEL.petrol.price}`, { timeout: 15_000 });
  await expect(page.getByRole("region", { name: `Dispensing unit ${FUEL.unit.unitNo}` })).toContainText("1,00,000.000");

  // The shift opens from nozzle 1's totaliser as its last close left it.
  await page.getByRole("button", { name: "Open a shift" }).click();
  const open = page.getByRole("dialog", { name: "Open a shift" });
  await open.getByRole("checkbox", { name: new RegExp(`^Nozzle ${FUEL.petrol.nozzle.nozzleNo} · ${FUEL.petrol.name}`) }).check();
  await expect(open.getByLabel(`Nozzle ${FUEL.petrol.nozzle.nozzleNo}: totaliser now`)).toHaveValue("100000.000");
  await open.getByRole("button", { name: "Open the shift" }).click();
  await expect(page.getByRole("heading", { name: /^Shift FS/, level: 1 })).toBeVisible({ timeout: 15_000 });

  // The close: 500.500 litres moved, 5 litres pumped back after the test: 495.500 litres at ₹102.12, ₹50,600.46.
  await page.getByLabel(`Nozzle ${FUEL.petrol.nozzle.nozzleNo}: closing reading`).fill("100500.5");
  await page.getByRole("button", { name: "5 L test" }).click();
  await page.getByRole("button", { name: "Add a taking" }).click();
  const taking = page.getByRole("group", { name: "Taking 1" });
  await taking.getByLabel("How it was paid").selectOption({ label: "UPI" });
  await taking.getByLabel("Amount").fill("20000");
  await page.getByLabel(/^Cash counted/).fill("30590");
  const sold = page.getByRole("table", { name: "What the meters sold" });
  await expect(sold).toContainText("495.500 L", { timeout: 15_000 });
  await expect(sold).toContainText("₹50,600.46");
  // ₹20,000.00 by UPI and ₹30,590.00 in cash against ₹50,600.46 of walk-in sales: ₹10.46 short.
  await expect(page.getByLabel("The shift's settlement")).toContainText("Short ₹10.46");
  await page.screenshot({ path: testInfo.outputPath("close.png"), fullPage: true });
  await page.getByRole("button", { name: "Close the shift" }).click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table", { name: "Readings" })).toContainText("1,00,500.500");
  await expect(page.getByText("Short ₹10.46").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("settlement.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a tanker load: the lorry's density checked against the invoice's, and the tank dipped before and after decanting", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page);
  await page.goto(`/business-admin/${shop.id}/fuel-receipts`);
  await expect(page.getByRole("heading", { name: "Tanker receipts", level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Record a tanker load" }).click();
  const load = page.getByRole("dialog", { name: "Record a tanker load" });
  await load.getByLabel("Supplier (the oil company's depot or terminal)").selectOption({ label: FUEL.supplier });
  await load.getByLabel("Invoice number").fill("INV-E2E-4417");
  await load.getByLabel("Tank lorry number").fill("TS07UA1234");
  const line = load.getByRole("group", { name: "Tank 1" });
  await line.getByLabel("Tank", { exact: true }).selectOption({ label: `Tank ${FUEL.petrol.tank.tankNo} · ${FUEL.petrol.name}` });
  await line.getByLabel("Litres on the invoice").fill("4000");
  await line.getByLabel(/^Value on the invoice/).fill("380000");
  await line.getByLabel("Invoice density at 15 °C").fill("745.0");
  // The lorry's sample 6.5 kg/m³ above the invoice's: outside the 3.0 allowed, so a manager would have to say why.
  await line.getByLabel("Lorry's density at 15 °C").fill("751.5");
  await expect(line.getByText("+6.5 kg/m³ · outside the tolerance")).toBeVisible();
  await expect(load.getByLabel("Why the load is accepted outside the tolerance")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("density-outside.png"), fullPage: true });
  // Sampled again: 2.0 above, within the tolerance; 3,960 litres came in by the dips, 40 short of the invoice.
  await line.getByLabel("Lorry's density at 15 °C").fill("747.0");
  await expect(line.getByText("+2.0 kg/m³ · within the tolerance")).toBeVisible();
  await expect(load.getByLabel("Why the load is accepted outside the tolerance")).toHaveCount(0);
  await line.getByLabel("Dip before decanting (litres)").fill("8500");
  await line.getByLabel("Dip after decanting (litres)").fill("12460");
  await expect(line).toContainText("Received 3,960.000 L by the dips, 40.000 L short of the invoice.");
  await load.getByRole("button", { name: "Accept the load" }).click();
  // Accepted: a purchase of the fuel at the invoice's value, with the density check kept.
  const detail = page.getByRole("dialog", { name: "Tanker load INV-E2E-4417" });
  await expect(detail).toContainText("Accepted", { timeout: 15_000 });
  await expect(detail).toContainText(/PR\S*\/\d+ · ₹3,80,000\.00/);
  await expect(detail.getByRole("table", { name: "Tanks of this load" })).toContainText("+2.0 · within ±3.0");
  await page.screenshot({ path: testInfo.outputPath("load.png"), fullPage: true });
  // The dialog's own button (its corner's × is named Close too).
  await detail.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByRole("table", { name: "Tanker loads" })).toContainText("INV-E2E-4417", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("the morning dip ends a day of the stock register: the diesel tank short beyond the tolerance", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page);
  await page.goto(`/business-admin/${shop.id}/fuel-dips`);
  await expect(page.getByRole("heading", { name: "Tanks & dips", level: 1 })).toBeVisible({ timeout: 30_000 });
  const tanks = page.getByRole("table", { name: "Tanks and their dips" });
  const diesel = tanks.getByRole("row", { name: new RegExp(`Tank ${FUEL.diesel.tank.tankNo}`) });
  // Yesterday's dip of 12,000 litres less the 495 the closed diesel shift sold: 11,505 by the book.
  await expect(diesel).toContainText("Not dipped", { timeout: 15_000 });
  await expect(diesel).toContainText("11,505.000 L");
  await diesel.getByRole("button", { name: "Take the dip" }).click();
  const dip = page.getByRole("dialog", { name: `Dip tank ${FUEL.diesel.tank.tankNo}` });
  await dip.getByLabel("Litres in the tank (by the dip chart)").fill("11000");
  await dip.getByLabel(/^Density at 15 °C/).fill("830.5");
  await dip.getByRole("button", { name: "Save the dip" }).click();
  await expect(dip).toBeHidden({ timeout: 15_000 });
  await expect(diesel).toContainText("11,000.000 L");

  // The register: 12,000 opening, 495 sold, a book of 11,505 against the dip of 11,000: 505 short,
  // 4.59% of the dip, beyond the 4% and the evaporation allowance.
  await page.goto(`/business-admin/${shop.id}/fuel-register`);
  await expect(page.getByRole("heading", { name: "Stock register", level: 1 })).toBeVisible({ timeout: 15_000 });
  // From yesterday (on the first of a month it is last month's).
  await page.getByLabel("From", { exact: true }).fill(localDate(-1));
  const register = page.getByRole("table", { name: `Stock register of tank ${FUEL.diesel.tank.tankNo}` });
  const day = register.getByRole("row", { name: new RegExp(dayText(localDate(-1))) });
  await expect(day).toContainText("12,000.000 L", { timeout: 15_000 });
  await expect(day).toContainText("495.000 L");
  await expect(day).toContainText("11,505.000 L");
  await expect(day).toContainText("−505.000 L (−4.59%)");
  await expect(day).toContainText("Loss beyond tolerance");
  await page.screenshot({ path: testInfo.outputPath("register.png"), fullPage: true });
  // The density register keeps the morning's sample.
  await page.getByRole("button", { name: "Density register" }).click();
  await expect(page.getByRole("table", { name: `Density register of tank ${FUEL.diesel.tank.tankNo}` })).toContainText("830.5 kg/m³", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a fleet customer's truck filled on credit at a shift's close, and on the customer's statement", async ({ page }, testInfo) => {
  const errors = errorsOf(page);
  await signIn(page);
  await page.goto(`/business-admin/${shop.id}/fuel-shifts`);
  await expect(page.getByRole("heading", { name: "Shift & readings", level: 1 })).toBeVisible({ timeout: 30_000 });
  // The owner runs the diesel nozzle, from where the set-up's shift closed it.
  await page.getByRole("button", { name: "Open a shift" }).click();
  const open = page.getByRole("dialog", { name: "Open a shift" });
  await expect(open.getByLabel("Attendant")).not.toHaveValue("");
  await open.getByRole("checkbox", { name: new RegExp(`^Nozzle ${FUEL.diesel.nozzle.nozzleNo} · ${FUEL.diesel.name}`) }).check();
  await expect(open.getByLabel(`Nozzle ${FUEL.diesel.nozzle.nozzleNo}: totaliser now`)).toHaveValue("250500.500");
  await open.getByRole("button", { name: "Open the shift" }).click();
  await expect(page.getByRole("heading", { name: /^Shift FS/, level: 1 })).toBeVisible({ timeout: 15_000 });

  // 200 litres of diesel: 150 into the truck on the driver's slip 0012, ₹14,280.00 on credit; 50 to walk-in buyers, ₹4,760.00 in cash.
  await page.getByLabel(`Nozzle ${FUEL.diesel.nozzle.nozzleNo}: closing reading`).fill("250700.5");
  await page.getByRole("button", { name: "Add a credit slip" }).click();
  const slip = page.getByRole("group", { name: "Credit slip 1" });
  await slip.getByLabel("Customer").selectOption({ label: FUEL.fleet.name });
  await slip.getByLabel("Vehicle").selectOption({ label: `${FUEL.fleet.vehicle.registration} · ${FUEL.diesel.name} · up to ${FUEL.fleet.vehicle.fillLimit}` });
  await slip.getByLabel("Quantity").fill("150");
  await slip.getByLabel("Slip number (optional)").fill("0012");
  await page.getByLabel(/^Cash counted/).fill("4760");
  const settlement = page.getByLabel("The shift's settlement");
  await expect(settlement).toContainText("₹14,280.00", { timeout: 15_000 });
  await expect(settlement).toContainText("Exact");
  await page.getByRole("button", { name: "Close the shift" }).click();
  const slips = page.getByRole("table", { name: "Credit slips" });
  await expect(slips).toContainText(FUEL.fleet.vehicle.registration, { timeout: 15_000 });
  await expect(slips).toContainText("₹14,280.00");
  await page.screenshot({ path: testInfo.outputPath("credit-close.png"), fullPage: true });

  // The fleet: the customer's month, and the statement with the truck's fill on it.
  await page.goto(`/business-admin/${shop.id}/fuel-fleet`);
  await expect(page.getByRole("heading", { name: "Fleet statements", level: 1 })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("table", { name: "Fleet customers" }).getByRole("row", { name: new RegExp(FUEL.fleet.name) }).click();
  await expect(page.getByRole("heading", { name: FUEL.fleet.name, level: 1 })).toBeVisible({ timeout: 15_000 });
  const fills = page.getByRole("table", { name: `Fills of ${FUEL.fleet.vehicle.registration}` });
  await expect(fills).toContainText("0012");
  await expect(fills).toContainText("150.000 L");
  await expect(fills).toContainText("₹14,280.00");
  await page.getByRole("button", { name: "Print the statement" }).click();
  await expect(page.locator("#print-root")).toContainText(FUEL.fleet.vehicle.registration);
  await expect(page.locator("#print-root")).toContainText("Fleet statement for");
  expect(await page.evaluate(() => window.printed)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("statement.png"), fullPage: true });
  expect(errors).toEqual([]);
});
