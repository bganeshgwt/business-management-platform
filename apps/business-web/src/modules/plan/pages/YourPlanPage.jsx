import useBusiness from "../../../hooks/useBusiness";
import PlannedPage from "../../../layouts/PlannedPage";
import { businessPath } from "../../../services/businessNav";

// Your plan, for an owner: a business's (among its Settings in Business
// Admin) and the signed-in restaurant's (/plan). The plan the business pays
// for, its modules and applications, the dates its access runs to, paying for
// the next period, and the invoice for each payment.
const PLAN = {
  title: "Your plan",
  icon: "card",
  lead: "The plan this business pays for, its modules and applications, and paying for the next period.",
  coming: [
    "The plan, its modules and applications, and the date this business's access runs to",
    "Choosing the plan for the next period, monthly or yearly, and the modules and applications to add",
    "Paying by UPI or bank transfer with the payment's reference, and the GST invoice for each payment",
  ],
};

export default function YourPlanPage() {
  const { businessId } = useBusiness();
  // A business open in Business Admin; otherwise the signed-in restaurant.
  const until = businessId
    ? {
      today: "The tools this business uses are switched on and off in its Business settings.",
      links: [{ to: businessPath(businessId, "settings"), label: "Business settings", icon: "settings" }],
    }
    : {
      today: "The parts of the restaurant it uses are switched on and off in Settings › Features.",
      links: [{ to: "/restaurant/features", label: "Features", icon: "sliders" }],
    };
  return <PlannedPage plan={{ ...PLAN, ...until }} />;
}
