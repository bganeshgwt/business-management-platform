import { Link } from "react-router-dom";

// While the company's GSTIN is the sample one, every invoice it issues is a
// SAMPLE, not a tax invoice: Payments and Invoices say so at the top.
export default function SampleNotice() {
  return (
    <div className="alert alert-notice" role="status">
      <strong>Sample mode — enter your real GSTIN before taking real payments.</strong> Invoices issued now are SAMPLE invoices, not tax invoices, and stay
      out of the GST register. The real GSTIN goes in the <Link to="/platform/settings">company's details</Link>.
    </div>
  );
}
