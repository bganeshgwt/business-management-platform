import PlannedPage from "../../../layouts/PlannedPage";

// One of the company's tax invoices (/platform/invoices/:invoiceId), laid out
// to print or save as PDF.
const PLAN = {
  title: "Invoice",
  icon: "print",
  lead: "One GST tax invoice, laid out to print or save as PDF.",
  coming: [
    "The company's name, address and GSTIN, the invoice's number and date, the buyer and the place of supply",
    "Each line with its SAC code, then CGST and SGST or IGST, the total and the amount in words",
    "A SAMPLE band, not a tax invoice, while the sample GSTIN is in use",
  ],
  today: "No invoice is issued through the platform.",
  links: [{ to: "/platform/businesses", label: "Businesses", icon: "store" }],
};

export default function PlatformInvoicePage() {
  return <PlannedPage plan={PLAN} />;
}
