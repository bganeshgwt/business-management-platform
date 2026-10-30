import PlannedPage from "../../../layouts/PlannedPage";

// The platform's prices (/pricing): each business type's plans, and the
// modules and applications an owner can add, monthly or yearly, before GST,
// with the free trial before the first payment.
const PLAN = {
  title: "Pricing",
  icon: "tag",
  lead: "Each business type's plans, and the modules and applications you can add, monthly or yearly.",
  coming: [
    "The plan for each business type, with its monthly and yearly price before GST",
    "The modules and applications you can add to it, each with its own price",
    "The free trial before the first payment, with everything your business type can use",
  ],
  today: "The platform's team sets up a new business and gives its price.",
  links: [{ to: "/login", label: "Sign in", icon: "login" }],
};

export default function PricingPage() {
  return (
    <main className="page-center">
      <PlannedPage plan={PLAN} />
    </main>
  );
}
