import PlannedPage from "../../../layouts/PlannedPage";

// Platform › Reports (/platform/reports): the platform's sales by month,
// plan, module, application, business type and state, the renewals due and
// the orders not paid, each with a CSV.
const PLAN = {
  title: "Platform reports",
  icon: "chart",
  lead: "The platform's sales, the renewals due and the orders not paid.",
  coming: [
    "Sales by month, plan, module, application, business type and state, new or renewal, and monthly or yearly",
    "Renewals due, with their value",
    "Orders not paid, by how old they are, each report with a CSV",
  ],
  today: "Every business and restaurant is in its own list, with whether it is switched on.",
  links: [
    { to: "/platform/businesses", label: "Businesses", icon: "store" },
    { to: "/platform/restaurants", label: "Restaurants", icon: "utensils" },
  ],
};

export default function PlatformReportsPage() {
  return <PlannedPage plan={PLAN} />;
}
