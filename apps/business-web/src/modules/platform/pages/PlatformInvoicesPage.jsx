import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import DataGrid from "../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../components/DateRangeFilter";
import StatTile from "../../../components/StatTile";
import StatusBadge from "../../../components/StatusBadge";
import { getErrorMessage } from "../../../services/api";
import { toast } from "../../../services/toast";
import { downloadCsv } from "../../../services/csv";
import { count, moneyExact } from "@bmp/shared/format";
import { monthStart, today } from "@bmp/shared/dates";
import { consoleInvoices } from "../services/console.service";
import { gstRegisterRows } from "../consoleWords";
import SampleNotice from "../SampleNotice";
import "../styles/console.css";

// Platform › Invoices (/platform/invoices): the company's GST tax invoices,
// one for each payment confirmed, as the register its GST return is filed
// from: number, date, business, buyer and GSTIN, place of supply, taxable
// value, CGST, SGST, IGST and total, for any period, with the CSV the
// accountant needs. SAMPLE invoices, issued while the GSTIN was the sample
// one, are listed apart (?sample=true) and never in the CSV. Each invoice
// opens to print.
const money = (value) => moneyExact(Number(value || 0));

export default function PlatformInvoicesPage() {
  const [params, setParams] = useSearchParams();
  const sample = params.get("sample") === "true";
  const [range, setRange] = useState(() => ({ from: monthStart(), to: today() }));
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let live = true;
    consoleInvoices({ sample, from: range.from || undefined, to: range.to || undefined, q: q.trim() || undefined })
      .then((result) => { if (live) { setData(result); setError(""); } })
      .catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [sample, range, q]);

  const showSample = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set("sample", "true");
    else next.delete("sample");
    setParams(next, { replace: true });
  };

  const columns = useMemo(() => [
    { key: "number", header: "Number", value: (i) => i.number, mobile: "title", pin: true, render: (i) => <Link className="mono" to={`/platform/invoices/${i.id}`}>{i.number}</Link> },
    { key: "issuedOn", header: "Date", type: "date", value: (i) => i.issuedOn, mobile: "subtitle" },
    { key: "business", header: "Business", value: (i) => i.businessName, render: (i) => <Link to={`/platform/businesses/${i.businessId}`}>{i.businessName}</Link> },
    { key: "buyer", header: "Buyer", value: (i) => i.buyerName || "", defaultHidden: true },
    { key: "gstin", header: "Buyer's GSTIN", value: (i) => i.buyerGstin || "", className: "mono", render: (i) => i.buyerGstin || <span className="muted">Unregistered</span> },
    { key: "place", header: "Place of supply", value: (i) => `${i.placeOfSupplyName || ""} (${i.placeOfSupplyCode})` },
    { key: "taxable", header: "Taxable value", type: "money", exact: true, value: (i) => Number(i.taxable), total: "sum" },
    { key: "cgst", header: "CGST", type: "money", exact: true, value: (i) => Number(i.cgst), total: "sum" },
    { key: "sgst", header: "SGST", type: "money", exact: true, value: (i) => Number(i.sgst), total: "sum" },
    { key: "igst", header: "IGST", type: "money", exact: true, value: (i) => Number(i.igst), total: "sum" },
    { key: "total", header: "Total", type: "money", exact: true, value: (i) => Number(i.total), total: "sum", mobile: "show" },
    ...(sample ? [{ key: "sample", header: "", label: "Sample", value: () => "SAMPLE", render: () => <StatusBadge status="sample" label="SAMPLE" tone="warning" /> }] : []),
  ], [sample]);

  // The CSV is the period's whole register of tax invoices, whatever the
  // search box holds, read again for it; a period too long for one file is
  // refused rather than cut short.
  const download = async () => {
    setDownloading(true);
    try {
      const period = await consoleInvoices({ from: range.from || undefined, to: range.to || undefined });
      if (period.truncated) {
        toast.error("More than 5,000 tax invoices in these dates. Download a shorter period, such as a month at a time.");
      } else if (period.items.length === 0) {
        toast.info("No tax invoices in these dates.");
      } else {
        downloadCsv(gstRegisterRows(period.items), `gst-register-${range.from || "start"}-to-${range.to || today()}.csv`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="stack pc-page">
      <PageHeader icon="receipt" eyebrow="Platform" title="Invoices"
        description="The company's GST tax invoices, one for each payment confirmed: the register its GST return is filed from. Open one to print it."
        primary={!sample && (
          <button type="button" className="button" disabled={!data || downloading} onClick={download}>
            <Icon name="download" size={16} /> {downloading ? "Preparing…" : "CSV for the GST return"}
          </button>
        )} />
      {data?.sampleMode && <SampleNotice />}
      <div className="segmented" role="group" aria-label="Which invoices">
        <button type="button" className={`segment ${sample ? "" : "is-active"}`} aria-pressed={!sample} onClick={() => showSample(false)}>Tax invoices</button>
        <button type="button" className={`segment ${sample ? "is-active" : ""}`} aria-pressed={sample} onClick={() => showSample(true)}>
          SAMPLE invoices{data ? ` (${count(data.sampleCount)})` : ""}
        </button>
      </div>
      {sample && (
        <div className="alert alert-info" role="status">
          SAMPLE invoices were issued while the company's GSTIN was the sample one. They are not tax invoices and are left out of the GST return; once the real
          GSTIN is saved, each such order's tax invoice is issued from its business's page.
        </div>
      )}
      {data?.truncated && (
        <div className="alert alert-notice" role="status">Only the first 5,000 invoices of these dates are shown. Choose a shorter period to see them all.</div>
      )}
      {data && (
        <div className="stat-grid">
          <StatTile size="sm" icon="file" tone="primary" label={sample ? "SAMPLE invoices" : "Tax invoices"} value={count(data.totals.count)} note="in these dates" />
          <StatTile size="sm" icon="money" tone="neutral" label="Taxable value" value={money(data.totals.taxable)} />
          <StatTile size="sm" icon="percent" tone="neutral" label="CGST + SGST" value={money(Number(data.totals.cgst) + Number(data.totals.sgst))}
            note={`${money(data.totals.cgst)} + ${money(data.totals.sgst)}`} />
          <StatTile size="sm" icon="percent" tone="neutral" label="IGST" value={money(data.totals.igst)} />
          <StatTile size="sm" icon="receipt" tone="success" label="Total" value={money(data.totals.total)} />
        </div>
      )}
      <SectionCard icon="list" title={sample ? "SAMPLE invoices" : "The GST register"} flush>
        <DataGrid id={sample ? "platform-invoices-sample" : "platform-invoices"} caption={sample ? "SAMPLE invoices" : "Tax invoices"} columns={columns}
          rows={data?.items || []} loading={!data && !error} error={error} rowNoun={["invoice", "invoices"]} search={false}
          toolbar={(
            <span className="pc-toolbar">
              <input type="search" placeholder="Number, business, buyer or GSTIN" aria-label="Search invoices" value={q} onChange={(e) => setQ(e.target.value)} />
              <DateRangeFilter from={range.from} to={range.to} label="invoice dates" onChange={setRange} />
            </span>
          )}
          empty="No invoices in these dates" emptyHint={sample ? "" : "Each payment confirmed issues one."} emptyIcon="receipt" />
      </SectionCard>
    </div>
  );
}
