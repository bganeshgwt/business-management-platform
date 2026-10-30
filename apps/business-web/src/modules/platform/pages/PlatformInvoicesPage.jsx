import PlannedPage from "../../../layouts/PlannedPage";

// Platform › Invoices (/platform/invoices): the company's GST tax invoices,
// the register for its GST return, with the SAMPLE invoices kept apart.
const PLAN = {
  title: "Invoices",
  icon: "receipt",
  lead: "The company's GST tax invoices, one for each payment confirmed.",
  coming: [
    "The register: number, date, business, buyer's GSTIN, place of supply, taxable value, CGST, SGST, IGST and total",
    "Any period, with a CSV for the GST return, and each invoice to print",
    "SAMPLE invoices, issued while the sample GSTIN is in use, kept apart and out of the GST return",
  ],
  today: "No invoice is issued through the platform.",
  links: [{ to: "/platform/businesses", label: "Businesses", icon: "store" }],
};

export default function PlatformInvoicesPage() {
  return <PlannedPage plan={PLAN} />;
}
