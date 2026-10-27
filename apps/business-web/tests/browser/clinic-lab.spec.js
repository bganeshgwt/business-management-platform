import { test, expect } from "@playwright/test";

import { CLINIC, business, fixture, localDate, signIn } from "../../../../e2e/fixture.mjs";

// The clinic workspace (/clinic) and the lab workspace (/lab): one patient
// from the front desk to the doctor, the lab and back, each person on a
// device of their own with every screen live (its safety net set to an hour
// with rmp_live_poll_ms), so each change must come by itself within seconds:
//   - the front desk (RECEPTION, 1280 × 800) registers a patient with their
//     consent and gives them a token for the doctor, whose queue, open on
//     their tablet (1024 × 768), shows it;
//   - the DOCTOR calls the next patient and starts the consultation from the
//     queue, which stays beside it: vitals, complaints and diagnosis, a
//     medicine, the follow-up date and a referral, a test ordered (it reaches
//     the lab's bench), the consultation completed, the prescription and the
//     referral letter printed;
//   - the LAB_TECH (1024 × 768) prints the sample's label, collects it,
//     rejects it with the reason and collects it again, receives it in the
//     lab and types the result from the worklist; the
//     PATHOLOGIST approves the report with their PIN, and it is released and
//     printed;
//   - the doctor's consultation, still open, shows the result;
//   - the front desk never sees clinical data: not on the visit, the
//     patient's page, the lab order or the lab's bench;
//   - each workspace opens from the clinic's own Business Admin menu, the
//     bare address opens the clinic (or asks which), and the screens fit a
//     phone (390 × 844) with no sideways scroll.
// What it makes ends finished: the token done, the visit completed, the
// report released.

const AN_HOUR = 3_600_000;
const QUICKLY = { timeout: 10_000 };
const DESKTOP = { width: 1280, height: 800 };
const TABLET = { width: 1024, height: 768 };
const PHONE = { width: 390, height: 844 };

// A device whose live screens read again only when told a change happened,
// and whose printer only keeps what it is given.
async function device(browser, viewport) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((ms) => {
    try {
      localStorage.setItem("rmp_live_poll_ms", String(ms));
    } catch {
      // Storage blocked: the safety net stays at a minute, still longer than any wait here.
    }
    window.print = () => {
      const root = document.getElementById("print-root");
      window.printed = [...(window.printed || []), root ? root.innerText : ""];
    };
  }, AN_HOUR);
  return context;
}

// Script errors, and API requests the server failed on.
function watch(page) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) problems.push(`${response.status()} ${response.url()}`);
  });
  return problems;
}

// A card on a screen, by its title.
const card = (page, title) => page.locator("section.section-card").filter({ has: page.getByRole("heading", { level: 2, name: title, exact: true }) });

// What the page printed last.
const lastPrinted = async (page) => page.evaluate(() => (window.printed || []).at(-1) || "");

const noSidewaysScroll = async (page, what) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}: no sideways scroll`).toBe(true);

// Signed in, on a workspace (the bare address opens the clinic), live.
async function openWorkspace(page, role, address, heading) {
  await signIn(page, role);
  await page.goto(`${fixture().urls.staff}${address}`);
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".ws-bar .live-indicator")).toHaveAttribute("data-live", "live", { timeout: 30_000 });
}

test("a patient from the front desk to the doctor, the lab and back, and the front desk sees no clinical data", async ({ browser }, testInfo) => {
  test.setTimeout(480_000);
  const clinic = business("healthcare");
  const { walkIn } = CLINIC;
  const base = fixture().urls.staff;
  const deskDevice = await device(browser, DESKTOP);
  const doctorTablet = await device(browser, TABLET);
  const labTablet = await device(browser, TABLET);
  const pathologistDevice = await device(browser, DESKTOP);
  try {
    const desk = await deskDevice.newPage();
    const doctor = await doctorTablet.newPage();
    const lab = await labTablet.newPage();
    const pathologist = await pathologistDevice.newPage();
    const problems = [desk, doctor, lab, pathologist].map(watch);
    const queueOf = (page) => page.getByRole("region", { name: `${CLINIC.doctor.resource}'s queue` });

    // Each opens from the clinic's own Business Admin menu, shown to those who may open it.
    await signIn(desk, "RECEPTION");
    await desk.goto(`${base}/business-admin/${clinic.id}`);
    const menu = desk.locator(".sidebar");
    await expect(menu.getByRole("link", { name: "Clinic workspace", exact: true })).toHaveAttribute("href", `/clinic/${clinic.id}`, { timeout: 30_000 });
    await expect(menu.getByRole("link", { name: "Lab workspace", exact: true })).toHaveAttribute("href", `/lab/${clinic.id}`);
    await menu.getByRole("link", { name: "Clinic workspace", exact: true }).click();
    await expect(desk).toHaveURL(new RegExp(`/clinic/${clinic.id}$`));
    await expect(desk.getByRole("heading", { level: 1, name: "Clinic desk", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(desk.locator(".ws-bar .live-indicator")).toHaveAttribute("data-live", "live", { timeout: 30_000 });
    // Someone who works in several clinics chooses one; the bare address opens the one chosen.
    await desk.goto(`${base}/clinic?choose`);
    await desk.getByRole("button", { name: new RegExp(`^${clinic.name}`) }).click();
    await expect(desk.getByRole("heading", { level: 1, name: "Clinic desk", exact: true })).toBeVisible({ timeout: 30_000 });
    await desk.goto(`${base}/clinic`);
    await expect(desk).toHaveURL(new RegExp(`/clinic/${clinic.id}$`), { timeout: 30_000 });
    await expect(desk.locator(".ws-bar .live-indicator")).toHaveAttribute("data-live", "live", { timeout: 30_000 });

    // The doctor's own queue, open on their tablet before the patient arrives.
    await openWorkspace(doctor, "DOCTOR", "/clinic", "Your queue");
    await expect(queueOf(doctor)).toContainText("Your queue");
    await expect(queueOf(doctor)).not.toContainText(walkIn.name);

    // The front desk registers the patient, with their consent, and gives a token for the doctor.
    await desk.getByRole("button", { name: "Register a new patient", exact: true }).click();
    const register = desk.getByRole("dialog", { name: "Register a patient" });
    await register.getByLabel("Full name").fill(walkIn.name);
    await register.getByLabel("Mobile").fill(walkIn.phone);
    await register.getByLabel("Sex").selectOption("female");
    await register.getByLabel("Age (years)").fill(String(walkIn.ageYears));
    await register.getByLabel(/was shown this notice and agreed/).check();
    await register.getByRole("button", { name: "Register", exact: true }).click();
    await expect(register).toHaveCount(0);
    const atDesk = desk.getByRole("group", { name: `${walkIn.name} at the desk` });
    await expect(atDesk).toContainText("Consent given");
    await atDesk.getByRole("button", { name: "Give a token", exact: true }).click();
    const token = desk.getByRole("dialog", { name: "Give a token" });
    await token.getByLabel("Doctor").selectOption({ label: CLINIC.doctor.resource });
    await token.getByRole("button", { name: "Give token", exact: true }).click();
    await expect(token).toHaveCount(0);
    await expect(queueOf(desk)).toContainText(walkIn.name);
    await expect(atDesk).toContainText(`· ${CLINIC.doctor.resource} · Waiting`);
    await noSidewaysScroll(desk, "the desk at 1280");
    await desk.screenshot({ path: testInfo.outputPath("clinic-desk-1280.png") });

    // On the doctor's tablet within seconds, with how long they have waited.
    await expect(queueOf(doctor)).toContainText(walkIn.name, QUICKLY);
    await expect(queueOf(doctor)).toContainText("waiting");
    await noSidewaysScroll(doctor, "the doctor's queue at 1024");
    await doctor.screenshot({ path: testInfo.outputPath("clinic-queue-1024.png") });
    await queueOf(doctor).getByRole("button", { name: "Next patient", exact: true }).click();
    await expect(queueOf(doctor).locator(".hl-queue-now")).toContainText(walkIn.name);
    await queueOf(doctor).getByRole("button", { name: "Start", exact: true }).click();
    await expect(doctor).toHaveURL(new RegExp(`/clinic/${clinic.id}/visits/\\d+$`));
    const visitId = doctor.url().split("/").pop();
    await expect(doctor.getByRole("heading", { level: 1, name: new RegExp(`^${walkIn.name} · OP`) })).toBeVisible({ timeout: 30_000 });
    // The queue stays beside the consultation, and the history (a first visit).
    await expect(queueOf(doctor).locator(".hl-queue-now")).toContainText("With the doctor");
    await expect(doctor.getByRole("heading", { name: "History", exact: true })).toBeVisible();
    await expect(doctor.getByText(`${walkIn.name} · first visit`)).toBeVisible();

    // The consultation: vitals, what was found, the medicine, follow-up and referral.
    const { consultation, medicine, referral } = walkIn;
    await doctor.getByLabel("BP systolic (mmHg)").fill(consultation.bpSystolic);
    await doctor.getByLabel("BP diastolic (mmHg)").fill(consultation.bpDiastolic);
    await doctor.getByLabel("Complaints").fill(consultation.complaints);
    await doctor.getByLabel("Diagnosis", { exact: true }).fill(consultation.diagnosis);
    await doctor.getByRole("button", { name: "Add medicine", exact: true }).click();
    await doctor.getByLabel("Medicine (generic), line 1").fill(medicine.drugName);
    await doctor.getByLabel("Strength, line 1").fill(medicine.strength);
    await doctor.getByLabel("When (1-0-1), line 1").fill(medicine.frequency);
    await doctor.getByLabel("For, line 1").fill(medicine.duration);
    await doctor.getByLabel("Follow-up on").fill(localDate(14));
    await doctor.getByLabel("Referred to").fill(referral.referredTo);
    await doctor.getByLabel("Reason for the referral").fill(referral.reason);
    await doctor.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(doctor.getByText("Saved", { exact: true })).toBeVisible();
    await expect(doctor.locator(".hl-strip")).toContainText(`Referred to ${referral.referredTo}`);

    // A test ordered from the consultation reaches the lab; the consultation stays open.
    await doctor.getByRole("button", { name: "More", exact: true }).click();
    await doctor.getByRole("menuitem", { name: "Order tests" }).click();
    const order = doctor.getByRole("dialog", { name: `Order tests · ${walkIn.name}` });
    await order.getByLabel(new RegExp(`^${CLINIC.test.name}`)).check();
    // A doctor does not bill: the front desk does.
    await expect(order.getByText("Bill the tests now")).toHaveCount(0);
    await order.getByRole("button", { name: "Order", exact: true }).click();
    await expect(order).toHaveCount(0);
    const ordered = doctor.getByText(/^LAB\d+ ordered$/);
    await expect(ordered).toBeVisible();
    const orderNo = (await ordered.innerText()).split(" ")[0];
    await expect(doctor).toHaveURL(new RegExp(`/visits/${visitId}$`));
    await expect(card(doctor, "Lab orders")).toContainText(orderNo);
    await expect(card(doctor, "Lab orders")).toContainText("Ordered");

    await doctor.getByRole("button", { name: "Complete consultation", exact: true }).first().click();
    await expect(doctor.getByText("Consultation completed", { exact: true })).toBeVisible();
    await expect(doctor.locator(".hl-strip")).toContainText("Completed");
    await doctor.getByRole("button", { name: "More", exact: true }).click();
    await doctor.getByRole("menuitem", { name: "Print prescription" }).click();
    await expect.poll(() => lastPrinted(doctor)).toContain(medicine.drugName);
    const prescription = await lastPrinted(doctor);
    expect(prescription).toContain(CLINIC.doctor.registrationNo);
    expect(prescription).toContain(`Referred to: ${referral.referredTo}`);
    await doctor.getByRole("button", { name: "More", exact: true }).click();
    await doctor.getByRole("menuitem", { name: "Print referral letter" }).click();
    await expect.poll(() => lastPrinted(doctor)).toContain("REFERRAL LETTER");
    const letter = await lastPrinted(doctor);
    expect(letter).toContain(referral.reason);
    expect(letter).toContain(consultation.diagnosis);
    await noSidewaysScroll(doctor, "the consultation at 1024");
    await doctor.screenshot({ path: testInfo.outputPath("clinic-consultation-1024.png"), fullPage: true });
    // The doctor's queue: done with this patient.
    await expect(queueOf(doctor).locator(".hl-queue-now")).not.toContainText(walkIn.name);

    // The lab: the sample to collect, its label, collected and received.
    await openWorkspace(lab, "LAB_TECH", "/lab", "Sample collection");
    const toCollect = card(lab, "To collect").getByRole("row").filter({ hasText: walkIn.name });
    await expect(toCollect).toHaveCount(1);
    await toCollect.getByRole("button", { name: `Labels for ${orderNo}` }).click();
    await expect.poll(() => lastPrinted(lab)).toContain(walkIn.name);
    const barcode = (await lastPrinted(lab)).match(/S\d{7}/)[0];
    await noSidewaysScroll(lab, "the collection desk at 1024");
    await lab.screenshot({ path: testInfo.outputPath("lab-collection-1024.png") });
    await toCollect.getByRole("button", { name: `Collected: ${barcode}` }).click();
    await expect(lab.getByText(`Sample ${barcode} collected`)).toBeVisible();
    const toReceive = card(lab, "Collected, to receive in the lab").getByRole("row").filter({ hasText: walkIn.name });
    // Rejected with the reason, it is to collect again, the reason beside it.
    await toReceive.getByRole("button", { name: `Reject ${barcode}` }).click();
    const reject = lab.getByRole("dialog", { name: `Reject sample ${barcode}` });
    await reject.getByLabel("Why").fill("Haemolysed");
    await reject.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(reject).toHaveCount(0);
    await expect(toCollect).toContainText("Rejected: Haemolysed");
    await toCollect.getByRole("button", { name: `Collect again: ${barcode}` }).click();
    await expect(toReceive).toHaveCount(1);
    await toReceive.getByRole("button", { name: `Received in lab: ${barcode}` }).click();
    await expect(lab.getByText(`Sample ${barcode} received in the lab`)).toBeVisible();
    await expect(toReceive).toHaveCount(0);

    // The worklist by test: the result typed against the patient's range.
    await lab.getByRole("link", { name: /^Worklist/ }).click();
    const work = lab.getByRole("row").filter({ hasText: walkIn.name });
    await expect(work).toContainText(CLINIC.test.name);
    await work.click();
    await expect(lab.getByRole("heading", { level: 1, name: `${orderNo} · ${walkIn.name}` })).toBeVisible({ timeout: 30_000 });
    await lab.getByLabel("Result, line 1").fill(walkIn.haemoglobin);
    await expect(lab.getByRole("row").filter({ hasText: CLINIC.test.name }).filter({ hasText: "Low" })).toHaveCount(1);
    await lab.getByRole("button", { name: "Save results", exact: true }).click();
    await expect(lab.getByText("All results entered: ready for the pathologist")).toBeVisible();

    // The pathologist approves it with their PIN; it is released, and printed for the patient.
    await openWorkspace(pathologist, "PATHOLOGIST", `/lab/${clinic.id}/approval`, "Waiting for approval");
    await pathologist.getByRole("row").filter({ hasText: walkIn.name }).click();
    await expect(pathologist.getByRole("heading", { level: 1, name: `${orderNo} · ${walkIn.name}` })).toBeVisible({ timeout: 30_000 });
    await pathologist.getByRole("button", { name: "Approve report", exact: true }).click();
    const approve = pathologist.getByRole("dialog", { name: `Approve ${orderNo}` });
    await approve.getByLabel("Pathologist", { exact: true }).selectOption(String(clinic.pathologist.signatoryId));
    await approve.getByLabel("Pathologist's PIN").fill(clinic.pathologist.pin);
    await approve.getByRole("button", { name: "Approve report", exact: true }).click();
    await expect(pathologist.getByText("Report approved: ready to print")).toBeVisible();
    await pathologist.getByRole("link", { name: /^Released/ }).click();
    const released = pathologist.getByRole("row").filter({ hasText: walkIn.name });
    await expect(released).toContainText("Report ready");
    await released.getByRole("button", { name: `Print report ${orderNo}` }).click();
    await expect.poll(() => lastPrinted(pathologist)).toContain("LABORATORY REPORT");
    const report = await lastPrinted(pathologist);
    expect(report).toContain(walkIn.haemoglobin);
    expect(report).toContain(CLINIC.pathologist.signedName);
    // The lab's bench heard it, on the lab's own tablet: a report released today.
    await expect(lab.getByRole("link", { name: /^Released · \d+$/ })).toBeVisible(QUICKLY);

    // The doctor's consultation, still open, shows the result within seconds.
    const results = card(doctor, "Lab results (approved)");
    await expect(results).toContainText(walkIn.haemoglobin, QUICKLY);
    await expect(results).toContainText("Low");

    // The front desk: the visit, the patient, the lab order and the bench, and no clinical data.
    await desk.getByRole("link", { name: "Visits", exact: true }).click();
    await desk.getByRole("row").filter({ hasText: walkIn.name }).first().click();
    await expect(desk).toHaveURL(new RegExp(`/clinic/${clinic.id}/visits/${visitId}$`));
    await expect(desk.getByText("The consultation notes are for doctors only.", { exact: false })).toBeVisible({ timeout: 30_000 });
    for (const secret of [consultation.diagnosis, consultation.complaints, medicine.drugName, referral.referredTo, walkIn.haemoglobin]) {
      await expect(desk.getByText(secret, { exact: false })).toHaveCount(0);
    }
    await expect(desk.getByRole("heading", { name: "History", exact: true })).toHaveCount(0);
    await expect(desk.locator(".hl-strip")).toContainText("Report ready");
    await desk.getByRole("link", { name: "Patient", exact: true }).click();
    await expect(desk.getByText("Clinical notes are for doctors only.", { exact: false })).toBeVisible({ timeout: 30_000 });
    await desk.goto(`${base}/lab/${clinic.id}/released`);
    await expect(desk.getByRole("heading", { level: 1, name: "Released today", exact: true })).toBeVisible({ timeout: 30_000 });
    const deskRow = desk.getByRole("row").filter({ hasText: walkIn.name });
    await expect(deskRow).toBeVisible();
    // The front desk does not print reports (lab.print), and reads no value.
    await expect(deskRow.getByRole("button", { name: /^Print report/ })).toHaveCount(0);
    await deskRow.getByRole("link", { name: orderNo }).click();
    await expect(desk.getByText("Results are clinical data, for the lab and the doctors.", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(desk.getByText(walkIn.haemoglobin, { exact: false })).toHaveCount(0);

    // A phone: the desk, the lab's bench and the consultation fit, with no sideways scroll.
    await desk.setViewportSize(PHONE);
    for (const address of [`/clinic/${clinic.id}`, `/clinic/${clinic.id}/today`, `/lab/${clinic.id}`, `/lab/${clinic.id}/worklist`]) {
      await desk.goto(`${base}${address}`);
      await expect(desk.locator("main.ws-main h1").first()).toBeVisible({ timeout: 30_000 });
      await noSidewaysScroll(desk, `${address} at 390`);
    }
    await desk.screenshot({ path: testInfo.outputPath("lab-worklist-390.png") });
    await doctor.setViewportSize(PHONE);
    await expect(doctor.getByRole("heading", { level: 1, name: new RegExp(`^${walkIn.name} · OP`) })).toBeVisible();
    await noSidewaysScroll(doctor, "the consultation at 390");
    await doctor.screenshot({ path: testInfo.outputPath("clinic-consultation-390.png") });

    expect(problems.flat()).toEqual([]);
  } finally {
    await deskDevice.close();
    await doctorTablet.close();
    await labTablet.close();
    await pathologistDevice.close();
  }
});
