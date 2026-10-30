import PlannedPage from "../../../layouts/PlannedPage";

// Platform › Overview (/platform), the platform super admin's home: the money
// the platform has taken, its businesses by state, the free trials, the
// renewals due and what is waiting to be done.
const PLAN = {
  title: "Platform overview",
  icon: "chart",
  lead: "The platform's sales, its businesses by state, the free trials and what needs doing.",
  coming: [
    "Money collected today, this month and this financial year, with its GST and the monthly and yearly recurring income",
    "Businesses on trial, paying, given time, in grace, with a payment being checked, ended and switched off",
    "The last 30 days' free trials, the renewals due, the payments to confirm, new enquiries and what is left before going live",
  ],
  today: "Restaurants and businesses are set up, and switched off and on, in their own lists.",
  links: [
    { to: "/platform/businesses", label: "Businesses", icon: "store" },
    { to: "/platform/restaurants", label: "Restaurants", icon: "utensils" },
  ],
};

export default function PlatformOverviewPage() {
  return <PlannedPage plan={PLAN} />;
}
