import { businessPath } from "./businessNav";

// Workspaces the platform will have that are not built yet (see
// docs/ARCHITECTURE.md › Every address). Their addresses already work
// (App.jsx): each opens a page that says what is coming and what to use until
// then, never "Page not found", so a bookmark or a tablet set up today keeps
// working. When one is built, its real screen takes the route and its entry
// here is deleted.
//
// today and links may be functions of { clinic }: the signed-in person's
// clinic (a healthcare business), or null.

const clinicLinks = (clinic, sections) =>
  clinic
    ? sections.map(([section, label, icon]) => ({ to: businessPath(clinic.id, section), label, icon }))
    : [{ to: "/business-admin?all", label: "Open Business Admin", icon: "store" }];

const inClinic = (clinic, what) =>
  clinic
    ? `${what} is in Business Admin today, in ${clinic.name}'s own menu.`
    : `${what} is in Business Admin today, in the clinic's own menu.`;

export const PLANNED_WORKSPACES = {
  clinic: {
    title: "Clinic workspace",
    icon: "activity",
    lead: "One screen for the reception desk and the doctors.",
    coming: [
      "Registration and the token queue at the front desk",
      "The consultation: history, notes, prescription and tests in one place",
      "Follow-ups and referrals without leaving the queue",
    ],
    today: ({ clinic }) => inClinic(clinic, "Clinic work"),
    links: ({ clinic }) =>
      clinicLinks(clinic, [
        ["clinic-queue", "Token queue", "clock"],
        ["clinic-today", "Today's patients", "calendar"],
        ["patients", "Patients", "users"],
      ]),
  },
  lab: {
    title: "Lab workspace",
    icon: "clipboard",
    lead: "One screen for the people who collect samples and run the tests.",
    coming: [
      "Sample collection, and where each sample is",
      "Worklists, result entry and approval",
      "Reports released to the doctor and the patient, every version kept",
    ],
    today: ({ clinic }) => inClinic(clinic, "Lab work"),
    links: ({ clinic }) =>
      clinicLinks(clinic, [
        ["lab-orders", "Lab orders", "clipboard"],
        ["lab-tests", "Tests & panels", "list"],
      ]),
  },
};
