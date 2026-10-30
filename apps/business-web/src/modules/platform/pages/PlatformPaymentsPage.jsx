import PlannedPage from "../../../layouts/PlannedPage";

// Platform › Payments (/platform/payments): the payments owners have entered
// with their reference, to confirm or reject, and payments recorded for
// them.
const PLAN = {
  title: "Payments",
  icon: "money",
  lead: "The payments owners make for their plans, to confirm or reject.",
  coming: [
    "Payments being checked first, each confirmed (which issues its GST invoice and extends the business) or rejected with a reason",
    "A payment recorded for a business's open order, confirmed at once",
    "Every payment by date, business and state, with a CSV",
  ],
  today: "No payment is taken or confirmed through the platform.",
  links: [{ to: "/platform/businesses", label: "Businesses", icon: "store" }],
};

export default function PlatformPaymentsPage() {
  return <PlannedPage plan={PLAN} />;
}
