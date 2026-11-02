import { HEALTH_WORKSPACES } from "./healthWorkspaces.js";

// The workspaces of a business that are screens of their own outside
// Business Admin: a clinic's /clinic and /lab, and a wholesaler's /sales (the
// salesperson app). What their shared frame needs to know of each
// (layouts/BusinessWorkspace.jsx, layouts/WorkspaceStart.jsx): the business
// types it belongs to, the tool that must be on, who may open it, the other
// workspace of the same business, and the words it opens and refuses with.
// Kept free of React, so the rules can be tested on their own.
//
//   types    the business types it belongs to
//   module   the tool (module) that must be switched on
//   need     the permission that opens it, or needAny: any of several
//   other    the business's other workspace, offered in its menu
//   words    what the frame says: loading, the business not found or not of
//            the type, the tool off, the start's choice of business

const clinicWords = (kind) => ({
  noun: "clinic",
  notFound: "Clinic not found",
  notFoundText: "There is no clinic here that you are a member of. Choose one of yours.",
  cannotOpen: "This clinic could not be opened",
  opening: "Opening the clinic…",
  notType: "Not a clinic",
  notTypeText: (name) => `${name} is not a clinic: ${HEALTH_WORKSPACES[kind].title.toLowerCase()} belongs to clinics and diagnostic labs.`,
  offText: (name) => `${name} does not use ${kind === "lab" ? "the laboratory" : "patient records"}. An owner can switch it on in Settings › Business tools.`,
  yours: "Your clinics",
  another: "Another clinic",
  starting: "Opening your clinic…",
  choose: "Choose the clinic",
  which: "Which clinic?",
  none: "No clinic to open",
  noneText: `None of your businesses is a clinic using ${kind === "lab" ? "the laboratory" : "patient records"}. A clinic's owner gives you a role there in Staff & access.`,
});

export const WORKSPACE_APPS = {
  clinic: { ...HEALTH_WORKSPACES.clinic, types: ["healthcare"], other: "lab", icon: "activity", words: clinicWords("clinic") },
  lab: { ...HEALTH_WORKSPACES.lab, types: ["healthcare"], other: "clinic", icon: "clipboard", words: clinicWords("lab") },
  sales: {
    title: "Salesperson app",
    module: "salesperson_app",
    needAny: ["salesperson_app.create", "salesperson_app.view"],
    lead: "A salesperson's day on the beat: the day started and ended, a visit to each shop, orders at the shop's own prices, collections and new shops, with or without the network.",
    refused: "the salesperson app",
    types: ["wholesale"],
    other: null,
    icon: "truck",
    words: {
      noun: "business",
      notFound: "Business not found",
      notFoundText: "There is no business here that you are a member of. Choose one of yours.",
      cannotOpen: "This business could not be opened",
      opening: "Opening your day…",
      notType: "Not a wholesale business",
      notTypeText: (name) => `${name} is not a wholesale business: the salesperson app belongs to distributors with salespeople on beats.`,
      offText: (name) => `${name} does not use the salesperson app. An owner adds it in Your plan, then switches it on in Settings › Business tools.`,
      yours: "Your businesses",
      another: "Another business",
      starting: "Opening your business…",
      choose: "Choose the business",
      which: "Which business?",
      none: "No business to open",
      noneText: "None of your businesses is a wholesaler using the salesperson app. The owner gives you the Salesperson role in Staff & access and links your login to you under Routes & salespeople.",
    },
  },
};

// Whether this person's role opens the workspace (can: the business's own check).
export const workspaceAllowed = (plan, can) => (plan.needAny ? plan.needAny.some((code) => can(code)) : can(plan.need));

// The businesses a workspace can open for this person: of its types, with
// its tool switched on (their role is checked as it opens), the one opened
// last first.
export function workspaceBusinesses(businesses, kind) {
  const plan = WORKSPACE_APPS[kind];
  return (businesses || [])
    .filter((business) => plan.types.includes(business.business_type) && (business.capabilities || []).includes(plan.module))
    .sort((a, b) => String(b.last_opened_at || "").localeCompare(String(a.last_opened_at || "")) || String(a.name).localeCompare(String(b.name)));
}

// The business the bare address opens: the only one, or the one chosen last;
// null when the person must choose.
export const chosenBusiness = (list) => (list.length === 1 ? list[0] : list.find((business) => business.last_opened_at) || null);
