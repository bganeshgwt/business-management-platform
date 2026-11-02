import { expect, test } from "@playwright/test";
import crypto from "node:crypto";

import { account, business, fixture, localDate, ONLINE_BOOKING, SALON, signIn } from "../../../../e2e/fixture.mjs";

// Online booking from the desk's side (Business Admin › Online booking, and
// the salon's calendar):
//   - the salon's booking link, as its owner sees it: the QR and its poster,
//     the text to share, what shows online, and a rule changed and kept
//     (then put back); on a phone too;
//   - the clinic's requests, answered by the front desk (the RECEPTION login,
//     who answers requests but does not change the link's rules): one
//     accepted, one declined with words the guest reads; each guest's page
//     says so at once, and the Bookings tab lists both;
//   - the salon's calendar marks a booking made online, and a request still
//     waiting for an answer, which opens on Online booking (the link set to
//     confirm each booking for the test, then back to booking at once);
//   - at the clinic's front desk, a son booked online by his father on the
//     family's mobile: *Arrived: token* first shows the clinic's patients on
//     that mobile, the son and the father, beside what the guest typed, and the
//     son takes the token on his own record, with no second patient made.
// What a test makes it takes away again: its bookings end cancelled or
// declined, the son's token is cancelled, and the rules are put back.

// The API straight from the test: as the businesses' owner, or as a guest
// (no login) on the booking link. Each call names the status it expects.
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
const asGuest = (method, route, body, expected = 200) => call(method, `/public/appointments${route}`, body, expected, null);

test.beforeAll(async () => {
  const owner = account("RESTAURANT_ADMIN");
  ownerToken = (await call("POST", "/auth/login", { identifier: owner.email, password: owner.password }, 200, null)).token;
});

// A guest's booking on a link, at the `nth` free time of `date`, as the booking page sends it.
async function bookOnline(link, { services = [], person = "any", date, nth = 0, guest, details = {} }) {
  const query = new URLSearchParams({ services: services.join(","), person: String(person), date });
  const { groups } = await asGuest("GET", `/${link.token}/times?${query}`);
  const slot = groups.flatMap((group) => group.times)[nth];
  expect(slot, `a free time on ${date}`).toBeTruthy();
  const made = await asGuest("POST", `/${link.token}/bookings`, {
    clientKey: crypto.randomUUID(), services, person, date, time: slot.time, name: guest.name, mobile: guest.mobile, consents: [], ...details,
  }, 201);
  return { ...made, slot };
}
const clinicVisit = { personAge: 34, personSex: "female", visitKind: "new" };

const rowOf = (page, text) => page.locator(".dg-row, .dg-cards > .dg-card").filter({ hasText: text });
const noSidewaysScroll = async (page, where) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${where}: no sideways scroll`).toBeLessThanOrEqual(0);

test("the salon's booking link: its QR and poster, the text to share, what shows, and its rules", async ({ page }) => {
  const salon = business("salon");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page);
  await page.goto(`/business-admin/${salon.id}/online-booking?tab=link`);
  await expect(page.getByRole("heading", { level: 1, name: "Online booking" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tab", { name: "Booking link" })).toHaveAttribute("aria-selected", "true");

  // The link, its QR (to download, or print on an A5 poster) and a message ready to share.
  const address = page.getByRole("textbox", { name: "Booking link" });
  await expect(address).toHaveValue(new RegExp(`/appointments/${salon.onlineBooking.token}$`));
  const qr = page.getByRole("img", { name: /^QR code for the .+ booking link$/ });
  await expect(qr).toBeVisible();
  expect(await qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  await expect(page.getByRole("button", { name: "Print the A5 poster" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download QR" })).toBeVisible();
  await expect(page.locator(".ob-share-text")).toContainText(salon.onlineBooking.token);
  await expect(page.getByRole("link", { name: "Share on WhatsApp" })).toHaveAttribute("href", /^https:\/\/wa\.me\/\?text=/);
  await expect(page.getByText("Taking bookings", { exact: true })).toBeVisible();

  // What shows online: the haircut with its time, and the stylist.
  const shown = page.locator(".ob-shown-list");
  await expect(shown.filter({ hasText: SALON.service.name })).toContainText(`${ONLINE_BOOKING.haircutMinutes} min`);
  await expect(page.getByRole("checkbox", { name: new RegExp(SALON.stylist.name) })).toBeChecked();

  // A rule changed is kept; then put back.
  const notice = page.getByLabel("Notice before a booking");
  await expect(notice).toHaveValue("120");
  await notice.selectOption("60");
  await page.getByRole("button", { name: "Save the rules" }).click();
  await expect(page.getByText("Online booking rules saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Notice before a booking")).toHaveValue("60", { timeout: 30_000 });
  await page.getByLabel("Notice before a booking").selectOption("120");
  await page.getByRole("button", { name: "Save the rules" }).click();
  await expect(page.getByText("Online booking rules saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Notice before a booking")).toHaveValue("120", { timeout: 30_000 });

  // On a phone: the link, the QR and the rules fit.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(qr).toBeVisible();
  await noSidewaysScroll(page, "the booking link at 390");
  expect(errors).toEqual([]);
});

test("the clinic's front desk accepts one request and declines another; each guest's page says so at once", async ({ page }) => {
  const clinic = business("healthcare");
  const link = clinic.onlineBooking;
  const date = localDate(3);
  const { accepted, declined } = ONLINE_BOOKING.guests;
  const first = await bookOnline(link, { person: link.doctor.id, date, guest: accepted, details: clinicVisit });
  const second = await bookOnline(link, { person: link.doctor.id, date, nth: 1, guest: declined, details: { ...clinicVisit, personSex: "male" } });
  expect([first.status, second.status]).toEqual(["requested", "requested"]);

  try {
    await signIn(page, "RECEPTION");
    await page.goto(`/business-admin/${clinic.id}/online-booking`);
    await expect(page.getByRole("heading", { level: 1, name: "Online booking" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name: /^Requests \(\d+\)$/ })).toHaveAttribute("aria-selected", "true");
    const one = rowOf(page, accepted.name);
    const two = rowOf(page, declined.name);
    await expect(one).toContainText(link.doctor.name);
    await expect(one).toContainText("New patient");
    await expect(two).toBeVisible();

    // Accepted: booked, and the guest's page says so.
    await one.getByRole("button", { name: "Accept" }).click();
    const accept = page.getByRole("dialog", { name: `Accept ${accepted.name}'s booking` });
    await accept.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(accept).toHaveCount(0);
    await expect(page.getByText(`${accepted.name} is booked. Their page shows it now.`)).toBeVisible();
    await expect(one).toHaveCount(0);
    expect((await asGuest("GET", `/status/${first.guestToken}`)).status).toBe("booked");

    // Declined, with words the guest reads on their page.
    await two.getByRole("button", { name: "Decline" }).click();
    const decline = page.getByRole("dialog", { name: `Decline ${declined.name}'s request` });
    await decline.getByRole("button", { name: declined.reason }).click();
    await expect(decline.getByLabel("Reason the guest reads")).toHaveValue(declined.reason);
    await decline.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(decline).toHaveCount(0);
    await expect(two).toHaveCount(0);
    const told = await asGuest("GET", `/status/${second.guestToken}`);
    expect([told.status, told.declineReason]).toEqual(["declined", declined.reason]);
    expect(told.next).toContain(declined.reason);

    // Every online booking: both, with what became of each.
    await page.getByRole("tab", { name: "Bookings" }).click();
    await expect(rowOf(page, accepted.name)).toContainText("Booked", { timeout: 30_000 });
    await expect(rowOf(page, declined.name)).toContainText("Declined");

    // The front desk answers requests; the link's rules are the owner's or a manager's.
    await page.getByRole("tab", { name: "Booking link" }).click();
    await expect(page.getByText("Only the owner or a manager changes these.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save the rules" })).toHaveCount(0);
    await expect(page.locator(".ob-doctor").filter({ hasText: `Reg. ${ONLINE_BOOKING.doctor.registrationNo}` })).toBeVisible();
  } finally {
    // The declined request holds nothing; the accepted booking is cancelled.
    await asGuest("POST", `/status/${first.guestToken}/cancel`, {}).catch(() => {});
  }
});

test("the salon's calendar marks an online booking, and a request waiting for an answer", async ({ page }) => {
  const salon = business("salon");
  const link = salon.onlineBooking;
  const date = localDate(4);
  const { calendar, request } = ONLINE_BOOKING.guests;
  const haircut = { services: [salon.service.id], person: salon.stylist.id, date, details: { adultDeclared: true } };
  const made = [];

  try {
    made.push(await bookOnline(link, { ...haircut, guest: calendar }));
    expect(made[0].status).toBe("booked");
    // For the test, the salon confirms each booking: the next one waits as a request.
    await call("PATCH", `/businesses/${salon.id}/online-booking/links/${link.linkId}`, { confirmMode: "confirm" });
    made.push(await bookOnline(link, { ...haircut, nth: 2, guest: request }));
    expect(made[1].status).toBe("requested");

    await signIn(page);
    await page.goto(`/business-admin/${salon.id}/salon-calendar?date=${date}`);
    await expect(page.getByText("to come")).toBeVisible({ timeout: 30_000 });
    const online = page.locator(".sw-appt").filter({ hasText: calendar.name });
    const waiting = page.locator(".sw-appt").filter({ hasText: request.name });
    await expect(online.locator(".ob-online-tag")).toHaveText("Online");
    await expect(waiting.locator(".ob-online-tag")).toHaveText("Request");
    await expect(waiting).toHaveClass(/is-requested/);
    await expect(page.locator(".sw-summary")).toContainText("1 online to answer");

    // The booking says who booked it online.
    await online.click();
    const booked = page.getByRole("dialog").filter({ hasText: calendar.name });
    await expect(booked).toContainText("Booked online");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The request holds its time, and is answered in Online booking.
    await waiting.click();
    const asked = page.getByRole("dialog").filter({ hasText: request.name });
    await expect(asked).toContainText("it holds this time until you answer it");
    await asked.getByRole("link", { name: "Answer it in Online booking" }).click();
    await expect(page).toHaveURL(new RegExp(`/business-admin/${salon.id}/online-booking`));
    await expect(rowOf(page, request.name)).toContainText(SALON.service.name, { timeout: 30_000 });
  } finally {
    await call("PATCH", `/businesses/${salon.id}/online-booking/links/${link.linkId}`, { confirmMode: "instant" }).catch(() => {});
    for (const booking of made) await asGuest("POST", `/status/${booking.guestToken}/cancel`, {}).catch(() => {});
  }
});

test("at the clinic's front desk, a child booked online by a parent takes the token on his own record, never a second one", async ({ page }) => {
  const clinic = business("healthcare");
  const { family } = clinic.onlineBooking;
  let tokenId = null;

  try {
    await signIn(page, "RECEPTION");
    await page.goto(`/business-admin/${clinic.id}/clinic-today`);
    await expect(page.getByRole("heading", { level: 1, name: "Today's patients" })).toBeVisible({ timeout: 30_000 });
    const row = rowOf(page, `For ${family.son.name}`);
    await expect(row).toContainText("Online");
    await row.getByRole("button", { name: "Arrived: token" }).click();

    // The clinic's patients on the family's mobile, beside what the father typed; registering comes last.
    const choose = page.getByRole("dialog", { name: `Who is ${family.son.name}?` });
    await expect(choose.locator(".ob-family-typed")).toContainText(`${family.son.name}`);
    await expect(choose.locator(".ob-family-typed")).toContainText(`by ${family.father.name}`);
    const son = choose.locator(".ob-family-row").filter({ hasText: family.son.name });
    await expect(son).toContainText(family.son.patientNo);
    await expect(son).toContainText("Same name");
    await expect(choose.locator(".ob-family-row").filter({ hasText: family.father.name })).toBeVisible();
    await expect(choose.getByRole("button", { name: "Register as a new patient" })).toBeVisible();
    await son.getByRole("button", { name: `Give ${family.son.name} the token` }).click();
    await expect(choose).toHaveCount(0);
    await expect(page.getByText(new RegExp(`^Token \\d+ for ${family.son.name}$`))).toBeVisible();

    // On his own record: the appointment is his, and no second patient by his name was made.
    const { appointments } = await call("GET", `/businesses/${clinic.id}/clinic/today`);
    const booked = appointments.find((a) => Number(a.appointment_id) === Number(family.appointmentId));
    expect(Number(booked.contact_id)).toBe(Number(family.son.contactId));
    expect(booked.token_no).toBeTruthy();
    tokenId = booked.token_id;
    expect((await call("GET", `/businesses/${clinic.id}/clinic/patients?q=${encodeURIComponent(family.son.name)}`)).total).toBe(1);
    await expect(row.getByRole("button", { name: "Arrived: token" })).toHaveCount(0);
  } finally {
    if (tokenId) await call("POST", `/businesses/${clinic.id}/clinic/tokens/${tokenId}`, { action: "cancel" }).catch(() => {});
  }
});
