import { expect, test } from "@playwright/test";
import crypto from "node:crypto";

import { account, business, fixture, localDate, MEMBERSHIPS, signIn } from "../../../../e2e/fixture.mjs";

// The Overview, the bookings, the activity log and the profile in each
// business's own words (services/terms.js), as its owner meets them:
//   - the gym: bills, members and fees on its Overview, its sessions today and
//     its trainers' day, its plans & services on top, and its first actions
//     (Collect fees, Book a session, Add a member contact); a member who
//     promised to pay today, the line opening the gym's own Member dues (never
//     the shop's Udhaar), and the fees collected among the money in; no udhaar
//     anywhere. Its Sessions: the page, the button and the dialog in its words,
//     a session booked and cancelled; one missed, in the activity log as
//     "Member did not come"; its Trainers & studios with the gym's example; and
//     quick access suggesting the gym's own pages;
//   - the clinic: Patients owe, Appointments today, Doctors today and its first
//     actions on the Overview; its Appointments asking for the patient; a
//     task's line about the doctors and rooms with no login;
//   - My profile, with no business open: the PIN unlocks a shared screen.
// What a test makes it takes away again: the member's dues are collected, the
// session booked is cancelled, and the one missed holds no time.
test.describe.configure({ mode: "serial" });

// The API as the businesses' owner, straight from the test.
let ownerToken = null;
async function call(method, route, body, expected = 200) {
  const response = await fetch(fixture().urls.api + route, {
    method,
    headers: { "Content-Type": "application/json", ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = await response.json().catch(() => ({}));
  expect(response.status, `${method} ${route}: ${answer.message}`).toBe(expected);
  return answer.data;
}

test.beforeAll(async () => {
  const owner = account("RESTAURANT_ADMIN");
  ownerToken = (await call("POST", "/auth/login", { identifier: owner.email, password: owner.password })).token;
});

// The parts of the Overview this business's words fill.
const card = (page, title) => page.locator(".section-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
const overview = (page) => ({
  tiles: page.locator(".bz-stat-grid"),
  todo: card(page, "Needs doing today"),
  actions: card(page, "Start here"),
  people: page.locator(".bz-ov-people"),
  picture: page.locator(".bz-ov-grid"),
});
// No shop's or restaurant's words where the business's own belong.
const NOT_OURS = /udhaar|best sellers|sales today|guest|customer/i;
const notOurs = async (view) => {
  for (const part of Object.values(view)) await expect(part).not.toContainText(NOT_OURS);
};
const rowOf = (page, text) => page.locator(".dg-row, .dg-cards > .dg-card").filter({ hasText: text });
// The whole Overview in one picture: its pane scrolls, so the window is made
// tall enough to show all of it, then put back.
async function overviewShot(page, testInfo, name) {
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width, height: 2400 });
  await page.screenshot({ path: testInfo.outputPath(name) });
  await page.setViewportSize(size);
}

test("the gym's Overview: members, fees and sessions, a promise to pay opening Member dues", async ({ page }, testInfo) => {
  const gym = business("memberships");
  const B = (path) => `/businesses/${gym.id}/${path}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A member who owes the joining fee, and promised at the desk to pay it today.
  const joining = (await call("GET", B("catalog?kind=service&active=true&limit=100"))).items.find((item) => item.label === MEMBERSHIPS.joining.name);
  const member = await call("POST", B("contacts"), { kind: "customer", name: `Kiran Rao ${crypto.randomInt(1000, 9999)}`, phone: `98765${crypto.randomInt(10000, 99999)}` }, 201);
  const bill = await call("POST", B("documents"), {
    kind: "sale", requestKey: crypto.randomUUID(), locationId: gym.locationId, contactId: member.id, lines: [{ skuId: joining.id, quantity: "1" }],
  }, 201);
  let paid = false;
  try {
    await call("POST", B(`udhaar/${member.id}/reminders`), { channel: "visit", promisedOn: localDate(0) }, 201);

    await signIn(page);
    await page.goto(`/business-admin/${gym.id}`);
    const view = overview(page);
    await expect(view.tiles.locator(".stat-tile-label")).toContainText(["Bills today", "Money in today", "Members owe", "Sessions today"], { timeout: 30_000 });
    await expect(view.actions.locator(".bz-action")).toContainText(["Check a member in", "Sell a membership", "Collect fees", "New bill", "Book a session", "Add to plans & services", "Add a member contact"]);
    // The trainers' day, and the plans & services billed most.
    await expect(view.people.getByRole("heading", { name: "Trainers today" })).toBeVisible({ timeout: 30_000 });
    await expect(view.picture.getByRole("heading", { name: /^Top plans & services (today|this week)$/ })).toBeVisible();
    await expect(view.picture.getByRole("heading", { name: "Bills, last 14 days" })).toBeVisible();
    const promised = view.todo.getByRole("link", { name: /^\d+ members? promised to pay today$/ });
    await expect(promised).toBeVisible();
    await notOurs(view);
    await overviewShot(page, testInfo, "gym-overview.png");

    // The promise opens the gym's own dues list, over the Overview.
    await promised.click();
    const dues = page.getByRole("dialog", { name: "Member dues" });
    await expect(dues).toBeVisible({ timeout: 30_000 });
    await expect(dues).not.toContainText("Not available for this business type");
    await expect(dues).toContainText(member.name, { timeout: 30_000 });
    await dues.getByRole("button", { name: "Close" }).click();

    // Paid at the desk: the fees collected count among the money in.
    await call("POST", B(`udhaar/${member.id}/collections`), { requestKey: crypto.randomUUID(), amount: String(bill.total), method: "cash", locationId: gym.locationId }, 201);
    paid = true;
    await page.reload();
    await expect(page.locator(".stat-tile").filter({ hasText: "Money in today" })).toContainText("fees collected", { timeout: 30_000 });
    expect(errors).toEqual([]);
  } finally {
    if (!paid) await call("POST", B(`udhaar/${member.id}/collections`), { requestKey: crypto.randomUUID(), amount: String(bill.total), method: "cash", locationId: gym.locationId }, 201).catch(() => {});
  }
});

test("the gym's sessions: booked and cancelled in its words, a missed one in the activity log, its trainers & studios", async ({ page }, testInfo) => {
  const gym = business("memberships");
  const B = (path) => `/businesses/${gym.id}/${path}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A time of its own, so a second try never meets the first's booking.
  const day = localDate(crypto.randomInt(3, 25));
  const time = `${String(crypto.randomInt(8, 19)).padStart(2, "0")}:${["00", "15", "30", "45"][crypto.randomInt(0, 4)]}`;
  try {
    await signIn(page);
    await page.goto(`/business-admin/${gym.id}/appointments`);
    await expect(page.getByRole("heading", { level: 1, name: "Sessions" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Sessions this month and the next 30 days" })).toBeVisible();
    await expect(page.getByText("The same trainer or studio cannot be double-booked.")).toBeVisible();
    await page.getByRole("button", { name: "Book a session" }).click();
    const book = page.getByRole("dialog", { name: "Book a session" });
    await expect(book).toBeVisible({ timeout: 15_000 });
    await expect(book.getByLabel("Member", { exact: true }).locator("option", { hasText: gym.member.name })).toHaveCount(1, { timeout: 15_000 });
    await book.getByLabel("Member", { exact: true }).selectOption(String(gym.member.id));
    await book.getByLabel("Service", { exact: true }).selectOption({ index: 1 });
    await book.getByLabel("With", { exact: true }).selectOption(String(gym.trainer.id));
    await book.getByLabel("Date", { exact: true }).fill(day);
    await book.getByLabel("Starts at", { exact: true }).fill(time);
    await page.screenshot({ path: testInfo.outputPath("gym-book-a-session.png") });
    await book.getByRole("button", { name: "Book", exact: true }).click();
    await expect(book).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("Session booked.")).toBeVisible();
    const row = rowOf(page, gym.member.name).filter({ hasText: gym.trainer.name }).filter({ hasText: "Booked" });
    await expect(row.first()).toBeVisible({ timeout: 30_000 });
    await row.first().getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText(`${gym.member.name}'s session marked cancelled.`)).toBeVisible({ timeout: 15_000 });

    // A session the member missed, marked as the desk marks it: the activity log says so in the gym's words.
    const skus = (await call("GET", B("catalog?kind=service&active=true&limit=100"))).items;
    const starts = Date.now() - crypto.randomInt(26, 70) * 3600_000;
    const missed = await call("POST", B("appointments"), {
      contactId: gym.member.id, skuId: skus[0].id, resourceId: gym.trainer.id, startsAt: new Date(starts).toISOString(), endsAt: new Date(starts + 30 * 60_000).toISOString(),
    }, 201);
    await call("PATCH", B(`appointments/${missed.id}`), { status: "no_show" });
    await page.goto(`/business-admin/${gym.id}/activity`);
    await expect(page.getByRole("heading", { level: 1, name: "Activity log" })).toBeVisible({ timeout: 30_000 });
    await page.locator(".dg-search input").fill("appointment");
    await expect(rowOf(page, "Member did not come").first()).toBeVisible({ timeout: 30_000 });
    await expect(rowOf(page, "Session booked").first()).toBeVisible();
    await expect(rowOf(page, "Session cancelled").first()).toBeVisible();

    // The people and rooms it books, with the gym's own example.
    await page.goto(`/business-admin/${gym.id}/resources`);
    await expect(page.getByRole("heading", { level: 1, name: "Trainers & studios" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add a trainer or studio" });
    await expect(add.getByLabel("Name", { exact: true })).toHaveAttribute("placeholder", "e.g. Coach Arjun or Studio 2");
    await add.getByRole("button", { name: "Cancel", exact: true }).click();

    // Quick access suggests the gym's own pages.
    await page.getByRole("button", { name: "Customize quick access" }).click();
    const quick = page.getByRole("dialog", { name: "Customize quick access" });
    await expect(quick.getByRole("searchbox", { name: "Find a page" })).toHaveAttribute("placeholder", "Try check-in, members or renewals");
    await quick.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(errors).toEqual([]);
  } finally {
    // A booking left by a failed try is cancelled.
    const left = await call("GET", B(`appointments?status=booked&from=${day}&to=${day}&limit=100`)).catch(() => ({ items: [] }));
    for (const booking of left.items.filter((a) => Number(a.contact_id) === Number(gym.member.id))) {
      await call("PATCH", B(`appointments/${booking.id}`), { status: "cancelled" }).catch(() => {});
    }
  }
});

test("the clinic's Overview, appointments and tasks speak of patients and doctors", async ({ page }, testInfo) => {
  const clinic = business("healthcare");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto(`/business-admin/${clinic.id}`);
  const view = overview(page);
  await expect(view.tiles.locator(".stat-tile-label")).toContainText(["Bills today", "Money in today", "Patients owe", "Appointments today"], { timeout: 30_000 });
  await expect(view.actions.locator(".bz-action")).toContainText(["New bill", "Book an appointment", "Add to services & charges", "Add a billing contact"]);
  await expect(view.people.getByRole("heading", { name: "Doctors today" })).toBeVisible({ timeout: 30_000 });
  await expect(view.picture.getByRole("heading", { name: /^Top services & charges (today|this week)$/ })).toBeVisible();
  await notOurs(view);
  await overviewShot(page, testInfo, "clinic-overview.png");

  // Its appointments: booked for a patient.
  await page.goto(`/business-admin/${clinic.id}/appointments`);
  await expect(page.getByRole("heading", { level: 1, name: "Appointments" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The same doctor or room cannot be double-booked.")).toBeVisible();
  await page.getByRole("button", { name: "Book an appointment" }).click();
  const book = page.getByRole("dialog", { name: "Book an appointment" });
  await expect(book.getByLabel("Patient", { exact: true })).toBeVisible({ timeout: 15_000 });
  await book.getByRole("button", { name: "Cancel", exact: true }).click();

  // A task given to several people: the doctors and rooms with no login are ticked by a manager.
  await page.goto(`/business-admin/${clinic.id}/tasks`);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("menuitem", { name: "Task" }).click();
  const task = page.getByRole("dialog", { name: "New task" });
  await expect(task.getByText("A doctor or room without a login is done for by a manager.")).toBeVisible({ timeout: 15_000 });
  await task.getByRole("button", { name: "Close" }).click();

  // My profile, with no business open: neutral words.
  await page.goto("/profile");
  await expect(page.getByText(/It unlocks a shared screen and lets you take it over from someone else/)).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
