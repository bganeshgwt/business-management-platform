import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import PageHeader from "../../../components/PageHeader";
import { EmptyState, ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { consoleInvoice } from "../services/console.service";
import { invoiceHtml, printPlanInvoice } from "../invoiceDocument";
import { dayWords } from "../consoleWords";
import "../styles/console.css";

// One of the company's invoices (/platform/invoices/:invoiceId), as it
// prints: the sheet on screen is the same document Print sends to the
// printer on A4 (invoiceDocument.js), a SAMPLE one with its band.
export default function PlatformInvoicePage() {
  const { invoiceId } = useParams();
  // The link to an order's other invoice opens a fresh page, never the last one's.
  return <InvoiceView key={invoiceId} invoiceId={invoiceId} />;
}

function InvoiceView({ invoiceId }) {
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let live = true;
    consoleInvoice(invoiceId)
      .then((result) => { if (live) setInvoice(result); })
      .catch((err) => { if (!live) return; if (err.response?.status === 404) setMissing(true); else setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [invoiceId]);

  if (missing) {
    return (
      <div className="stack pc-page">
        <PageHeader icon="file" eyebrow="Platform" title="Invoice not found" />
        <EmptyState icon="receipt" message="There is no invoice at this address." action={<Link className="button" to="/platform/invoices">All invoices</Link>} />
      </div>
    );
  }
  if (!invoice) {
    return (
      <div className="stack pc-page">
        <PageHeader icon="file" eyebrow="Platform" title="Invoice" />
        {error ? <ErrorMessage message={error} /> : <Loading />}
      </div>
    );
  }

  const other = invoice.otherInvoice;
  return (
    <div className="stack pc-page">
      <PageHeader icon="file" eyebrow="Platform" title={`Invoice ${invoice.number}`}
        description={`${invoice.businessName} · issued ${dayWords(invoice.issuedOn)}${invoice.sample ? " · SAMPLE, not a tax invoice" : ""}`}
        primary={<button type="button" className="button" onClick={() => printPlanInvoice(invoice)}><Icon name="print" size={16} /> Print (A4)</button>}
        secondary={<Link className="button button-secondary" to={`/platform/businesses/${invoice.businessId}`}>The business</Link>} />
      {invoice.sample && (
        <div className="alert alert-notice" role="status">
          This invoice was issued while the company's GSTIN was the sample one: it is a SAMPLE, not a tax invoice, and stays out of the GST return.
          {other && !other.sample && <> Its tax invoice is <Link className="mono" to={`/platform/invoices/${other.id}`}>{other.number}</Link>.</>}
        </div>
      )}
      {!invoice.sample && other?.sample && (
        <div className="alert alert-info" role="status">
          The tax invoice for an order first invoiced as a sample, <Link className="mono" to={`/platform/invoices/${other.id}`}>{other.number}</Link>; it names the day the money came.
        </div>
      )}
      {/* invoiceHtml escapes every value it prints. */}
      <article className="pc-sheet" aria-label={`Invoice ${invoice.number}`} dangerouslySetInnerHTML={{ __html: invoiceHtml(invoice) }} />
    </div>
  );
}
