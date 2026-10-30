import PlannedPage from "../../../layouts/PlannedPage";

// A business the platform sets up for a customer (/platform/businesses/new):
// any type, a restaurant through the restaurant's own set-up, with its owner,
// its plan and how long it may be used.
const PLAN = {
  title: "New business",
  icon: "plus",
  lead: "A business of any type set up for a customer, with its plan and how long it may be used.",
  coming: [
    "Its owner: a new sign-in, or someone who already has one (a restaurant always gets a new one)",
    "Its plan with the modules and applications added, or everything its type can use",
    "Free until a date, with no end date, or a free trial, each with its reason",
  ],
  today: "Platform › Businesses sets up a business of any type but a restaurant, and Platform › Restaurants a restaurant.",
  links: [
    { to: "/platform/businesses", label: "Businesses", icon: "store" },
    { to: "/platform/restaurants", label: "Restaurants", icon: "utensils" },
  ],
};

export default function PlatformNewBusinessPage() {
  return <PlannedPage plan={PLAN} />;
}
