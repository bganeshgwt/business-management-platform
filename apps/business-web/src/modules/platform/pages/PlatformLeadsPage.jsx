import PlannedPage from "../../../layouts/PlannedPage";

// Platform › Leads & trials (/platform/leads): the trial funnel (requests to
// be called back, free trials started, those who went on to pay and those
// who stopped), each number opening its list, and every lead with its
// follow-up.
const PLAN = {
  title: "Leads & trials",
  icon: "users",
  lead: "Who asked to be called back, who started a free trial, who went on to pay and who stopped.",
  coming: [
    "Requests to be called back, free trials started, still on trial, continued (paid) and stopped, for any dates",
    "Each number by business type, state and where the visitor came from, opening its list",
    "Every lead with its follow-up (new, contacted, not interested), notes and a CSV",
  ],
  today: "Every business and restaurant is in its own list, with the day it was set up.",
  links: [
    { to: "/platform/businesses", label: "Businesses", icon: "store" },
    { to: "/platform/restaurants", label: "Restaurants", icon: "utensils" },
  ],
};

export default function PlatformLeadsPage() {
  return <PlannedPage plan={PLAN} />;
}
