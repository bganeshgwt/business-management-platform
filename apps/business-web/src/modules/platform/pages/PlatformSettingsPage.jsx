import PlannedPage from "../../../layouts/PlannedPage";

// Platform › Settings (/platform/settings): the company's details for its
// invoices, the free trial and the grace days, the price list, and the
// payment details owners pay to.
const PLAN = {
  title: "Platform settings",
  icon: "settings",
  lead: "The company's details, the free trial, the prices and where owners pay.",
  coming: [
    "Company: its name, address, GSTIN (the sample one flagged until the real one is entered), PAN, SAC code, GST rate and invoice prefix",
    "Trial & renewal: the free trial's days, and the grace days after a plan ends; prices: each business type's plans and each module's and application's price",
    "Payment details: the UPI ID and the bank account owners pay to",
  ],
  today: "The prices and the company's details stay as the platform starts with them.",
  links: [{ to: "/platform/businesses", label: "Businesses", icon: "store" }],
};

export default function PlatformSettingsPage() {
  return <PlannedPage plan={PLAN} />;
}
