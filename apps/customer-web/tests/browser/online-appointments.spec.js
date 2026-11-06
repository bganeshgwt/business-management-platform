import { expect, test } from "@playwright/test";
import crypto from "node:crypto";

import { account, business, fixture, ONLINE_BOOKING, SALON } from "../../../../e2e/fixture.mjs";

// Online booking on the guests' site (/appointments), on a phone 360 px wide
// in dark mode, as most guests book:
//   - the salon books at once: a haircut with its stylist the day after
//     tomorrow, its price with GST; the booking's own page; its time changed
//     once, then cancelled; and this phone's list of bookings finds it;
//   - the clinic confirms each request: a father books the paediatrician for
//     his son, seeing her fee, qualifications and registration first; his
//     page says Requested and follows it live, and turns to Booked by itself
//     within seconds of the front desk accepting it; then he cancels it.
// What a test makes it takes away again: both bookings end cancelled, so
// their times are free for other specs.

const QUICKLY = { timeout: 8_000 };
const PHONE = { viewport: { width: 360, height: 760 }, colorScheme: "dark" };

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

test.beforeAll(async () => {
  const owner = account("RESTAURANT_ADMIN");
  ownerToken = (await call("POST", "/auth/login", { identifier: owner.email, password: owner.password }, 200, null)).token;
});

// Script errors on the guest's page.
function watch(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

// Nothing runs off the side of the phone, and the page is in its dark look.
async function fitsDark(page, where) {
  const look = await page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.querySelector(".guest-app")).backgroundColor.match(/\d+/g).map(Number);
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, brightness: (r * 299 + g * 587 + b * 114) / 1000 };
  });
  expect(look.overflow, `${where}: no sideways scroll`).toBeLessThanOrEqual(0);
  expect(look.brightness, `${where}: dark`).toBeLessThan(80);
}

// The day after tomorrow in the strip of days (the first is today), and its first free time.
// The third day, and its first free time. Today's times never stand in for
// that day's while they load (TimeStep keeps each day's times to itself).
async function pickTime(page) {
  const day = page.getByRole("listbox", { name: "Days" }).getByRole("option").nth(2);
  await day.click();
  await expect(day).toHaveAttribute("aria-selected", "true");
  const first = page.locator(".ap-time-chip").first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  const label = (await first.textContent()).trim();
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  return label;
}

test("a salon client books a haircut at once, changes its time, then cancels it", async ({ browser }) => {
  test.setTimeout(120_000);
  const salon = business("salon");
  const guest = ONLINE_BOOKING.guests.salon;
  const phone = await browser.newContext(PHONE);
  const page = await phone.newPage();
  const errors = watch(page);
  let guestToken = null;

  try {
    await page.goto(`/appointments/${salon.onlineBooking.token}`);
    await expect(page).toHaveTitle(`Book online · ${salon.name}`);
    await expect(page.getByRole("banner")).toContainText(salon.name);
    await expect(page.getByRole("heading", { level: 1, name: "Choose a service" })).toBeVisible();
    // The haircut, with its time and its price with 18% GST.
    const haircut = page.getByRole("button", { name: new RegExp(`^${SALON.service.name}`) });
    await expect(haircut).toContainText(`${ONLINE_BOOKING.haircutMinutes} min`);
    await expect(haircut).toContainText(`₹${Math.round(SALON.service.price * 1.18)}`);
    await fitsDark(page, "the services");
    await haircut.click();
    await expect(haircut).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Next" }).click();

    // The salon's one stylist.
    await expect(page.getByRole("heading", { level: 1, name: "Choose your stylist" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(SALON.stylist.name) }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Pick a day and time" })).toBeVisible();
    const booked = await pickTime(page);
    await fitsDark(page, "the days and times");
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Your details" })).toBeVisible();
    await page.getByLabel("Your name").fill(guest.name);
    await page.getByLabel("Mobile number").fill(guest.mobile);
    // Booking without the declaration is refused on the page itself.
    await page.getByRole("button", { name: "Book now" }).click();
    await expect(page.getByText("Tick this to book")).toBeVisible();
    await page.getByRole("checkbox", { name: /I am 18 or over/ }).check();
    // Reminders, agreed on the salon's privacy notice.
    await page.locator(".gs-consent input").first().check();
    await fitsDark(page, "the details");
    await page.getByRole("button", { name: "Book now" }).click();

    // The booking's own page: booked at once, at the time chosen.
    await expect(page).toHaveURL(/\/appointments\/status\/[A-Za-z0-9_-]+$/);
    guestToken = page.url().split("/").pop();
    await expect(page).toHaveTitle(`Your booking · ${salon.name}`);
    await expect(page.locator(".ap-ok")).toHaveText("You are booked.");
    await expect(page.locator(".ap-hero-label")).toHaveText("Booked");
    await expect(page.locator(".ap-hero-when")).toContainText(booked);
    await expect(page.locator(".ap-hero-who")).toContainText(SALON.stylist.name);
    await expect(page.getByRole("link", { name: "Add to calendar" })).toBeVisible();
    await fitsDark(page, "the booking");

    // A new time the same day: the last one free.
    await page.getByRole("button", { name: "Change the time" }).click();
    const change = page.getByRole("region", { name: "Change the time" });
    const last = change.locator(".ap-time-chip").last();
    await expect(last).toBeVisible({ timeout: 15_000 });
    const moved = (await last.textContent()).trim();
    expect(moved).not.toBe(booked);
    await last.click();
    await change.getByRole("button", { name: /^Move to / }).click();
    await expect(page.locator(".ap-ok")).toHaveText("Your booking has its new time.");
    await expect(page.locator(".ap-hero-when")).toContainText(moved);
    await expect(page.locator(".ap-manage")).toContainText("1 change left");

    // Cancelled: the time goes to someone else.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Cancel this booking?" }).getByRole("button", { name: "Yes, cancel" }).click();
    await expect(page.locator(".ap-hero-label")).toHaveText("Cancelled");
    await expect(page.locator(".ap-hero-next")).toHaveText("You cancelled this booking.");
    await expect(page.getByRole("link", { name: "Book again" })).toBeVisible();
    guestToken = null;

    // This phone keeps it, to find again.
    await page.goto("/appointments");
    await expect(page.getByRole("heading", { level: 1, name: "Your bookings" })).toBeVisible();
    await expect(page.locator(".ap-mine")).toContainText(SALON.service.name);
    await expect(page.locator(".ap-mine")).toContainText(salon.name);
    await fitsDark(page, "this phone's bookings");
    expect(errors).toEqual([]);
  } finally {
    if (guestToken) await call("POST", `/public/appointments/status/${guestToken}/cancel`, {}, 200, null).catch(() => {});
    await phone.close();
  }
});

test("a clinic request turns to Booked by itself when the front desk accepts it", async ({ browser }) => {
  test.setTimeout(120_000);
  const clinic = business("healthcare");
  const { doctor } = ONLINE_BOOKING;
  const guest = ONLINE_BOOKING.guests.clinic;
  const phone = await browser.newContext(PHONE);
  const page = await phone.newPage();
  const errors = watch(page);
  let guestToken = null;

  try {
    await page.goto(`/appointments/${clinic.onlineBooking.token}`);
    await expect(page.getByRole("heading", { level: 1, name: "Choose your doctor" })).toBeVisible();
    // What a patient sees before booking: the fee, the qualifications, the registration.
    const choice = page.getByRole("button", { name: new RegExp(doctor.name) });
    await expect(choice).toContainText(`${doctor.qualifications} · ${doctor.speciality}`);
    await expect(choice).toContainText(`Reg. No. ${doctor.registrationNo}, ${doctor.council}`);
    await expect(choice).toContainText(`₹${doctor.fee.price}`);
    await fitsDark(page, "the doctors");
    await choice.click();

    await expect(page.getByRole("heading", { level: 1, name: "Pick a day and time" })).toBeVisible();
    const asked = await pickTime(page);
    await page.getByRole("button", { name: "Next" }).click();

    // A father books for his son.
    await expect(page.getByRole("heading", { level: 1, name: "Your details" })).toBeVisible();
    await page.getByRole("radio", { name: "Someone else" }).check();
    await page.getByLabel("Your name").fill(guest.name);
    await page.getByLabel("Mobile number").fill(guest.mobile);
    await page.getByLabel("Patient's name").fill(guest.patient.name);
    await page.getByLabel("Patient's age").fill(guest.patient.age);
    await page.getByLabel("Sex").selectOption(guest.patient.sex);
    await page.getByRole("radio", { name: "First visit" }).check();
    await page.getByLabel(/Reason for the visit/).fill("Fever and cough for two days");
    await fitsDark(page, "the patient's details");
    await page.getByRole("button", { name: "Send request" }).click();

    // A request, followed live.
    await expect(page).toHaveURL(/\/appointments\/status\/[A-Za-z0-9_-]+$/);
    guestToken = page.url().split("/").pop();
    await expect(page.locator(".ap-hero-label")).toHaveText("Requested");
    await expect(page.locator(".ap-hero-when")).toContainText(asked);
    await expect(page.locator(".ap-hero-next")).toContainText("will confirm your booking soon");
    await expect(page.locator(".gs-live.is-live")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".ap-facts")).toContainText(guest.patient.name);
    await fitsDark(page, "the request");

    // The front desk accepts it: the page turns to Booked by itself.
    const { requests } = await call("GET", `/businesses/${clinic.id}/online-booking/requests`);
    const request = requests.find((row) => row.booker_name === guest.name);
    expect(request, "the request waits at the front desk").toBeTruthy();
    await call("POST", `/businesses/${clinic.id}/online-booking/bookings/${request.id}/accept`, { requestKey: crypto.randomUUID() });
    await expect(page.locator(".ap-hero-label")).toHaveText("Booked", QUICKLY);
    await expect(page.getByRole("list", { name: "Your booking" })).toContainText("Confirmed");
    await expect(page.locator(".ap-hero-next")).toContainText("they give you your token for the doctor");

    // He cancels it.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Cancel this booking?" }).getByRole("button", { name: "Yes, cancel" }).click();
    await expect(page.locator(".ap-hero-label")).toHaveText("Cancelled");
    guestToken = null;
    expect(errors).toEqual([]);
  } finally {
    if (guestToken) await call("POST", `/public/appointments/status/${guestToken}/cancel`, {}, 200, null).catch(() => {});
    await phone.close();
  }
});
