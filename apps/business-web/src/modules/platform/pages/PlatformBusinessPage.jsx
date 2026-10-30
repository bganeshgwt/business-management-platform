import PlannedPage from "../../../layouts/PlannedPage";

// One business as the platform sees it (/platform/businesses/:businessId):
// its owners, plan and state, how much it is used (counts and dates only,
// never its customers, bills or patients), every period, order, payment and
// invoice, and what the platform does to it.
const PLAN = {
  title: "Business",
  icon: "store",
  lead: "One business's owners, plan, state and end date, how much it is used, and every period, order, payment and invoice.",
  coming: [
    "Its owners, type, plan, modules and applications, state and end date",
    "How much it is used: sign-ins, sales documents, users and locations, counted, never its customers or bills",
    "Giving it time or a module, changing its plan, an order, a payment, the tax invoice, switching it off or on, and its owner's password",
  ],
  today: "Platform › Businesses switches a business off and on and gives its owner a new password.",
  links: [{ to: "/platform/businesses", label: "Businesses", icon: "store" }],
};

export default function PlatformBusinessPage() {
  return <PlannedPage plan={PLAN} />;
}
