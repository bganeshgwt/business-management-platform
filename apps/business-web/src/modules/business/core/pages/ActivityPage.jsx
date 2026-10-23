import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { BusinessHeader, PeriodFilter } from "./ui";
import { useOpenBusiness, useServerList } from "./hooks";

// What each entry says, in a shop owner's words (not "sale.posted" read as
// "Sale posted", or "catalog.price_changed" as "Catalog price changed").
const WORDS = {
  "sale.posted": "Sale billed", "purchase.posted": "Purchase received", "payment.recorded": "Payment recorded",
  "sale.returned": "Goods taken back", "purchase.returned": "Goods returned to supplier", "sale.refunded": "Customer refunded", "purchase.refunded": "Refund from supplier",
  "collection.recorded": "Money collected from customer", "collection.applied": "Advance put against bills", "supplier.paid": "Supplier paid",
  "udhaar.reminded": "Udhaar reminder sent", "catalog.created": "Item added", "catalog.updated": "Item changed", "catalog.price_changed": "Selling price changed",
  "catalog.barcodes_assigned": "In-store barcodes given", "catalog.scale_code_set": "Scale code set", "catalog.scale_code_removed": "Scale code removed",
  "catalog.variants_created": "Style added with sizes and colours", "catalog.variants_added": "Sizes or colours added", "catalog.variant_prices_set": "Size prices changed",
  "contact.created": "Contact added", "contact.updated": "Contact changed", "settings.updated": "Business settings changed",
  "stock.adjusted": "Stock corrected", "stock_count.started": "Stock count started", "stock_count.posted": "Stock count approved", "stock_count.cancelled": "Stock count cancelled",
  "stock_transfer.dispatched": "Stock sent to another location", "stock_transfer.received": "Stock transfer received", "stock_transfer.cancelled": "Stock transfer cancelled",
  "offer.created": "Offer created", "offer.updated": "Offer changed", "loyalty.adjusted": "Points corrected", "loyalty.rules_updated": "Loyalty rules changed",
  "warranty.registered": "Warranty registered", "warranty.cancelled": "Warranty cancelled", "repair.received": "Device taken in for repair", "repair.status_changed": "Repair status changed",
  "repair.delivered": "Repaired device handed over", "repair.cancelled": "Repair cancelled", "exchange.posted": "Exchange done",
  "sales_order.placed": "Sales order taken", "sales_order.dispatched": "Order dispatched", "role.created": "Role created", "role.updated": "Role changed",
  "module.enabled": "Module switched on", "module.disabled": "Module switched off", "location.created": "Location added", "location.updated": "Location changed",
  "tax_rate.created": "GST slab added", "tax_rate.updated": "GST slab changed", "number_series.created": "Number series added", "number_series.updated": "Number series changed",
  "appointment.booked": "Appointment booked", "appointment.completed": "Appointment done", "appointment.cancelled": "Appointment cancelled", "appointment.no_show": "Client did not come",
  "wastage.recorded": "Wastage recorded", "processing.posted": "Cutting batch recorded", "member.added": "Staff access given",
  "catalog.barcode_changed": "Barcode changed", "book.updated": "Book details changed", "book_set.created": "School set added", "book_set.updated": "School set changed",
  "book_order.created": "Book order taken", "book_order.arrived": "Ordered book arrived", "book_order.collected": "Ordered book collected", "book_order.cancelled": "Book order cancelled",
};
const words = (action) => WORDS[action] || action.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());

// Detail keys a person reads; record IDs are left out.
const LABELS = {
  documentNo: "Bill", collectionNo: "Receipt", paymentNo: "Voucher", total: "Total", amount: "Amount", allocated: "Put against bills", label: "Item",
  from: "Was", to: "Now", mrpFrom: "MRP was", mrpTo: "MRP now", supplier: "Supplier", channel: "By", promisedOn: "Promised for", balance: "Owed",
  reason: "Reason", serial: "Serial", endsOn: "Until", points: "Points", taxMode: "Prices", rounding: "Rounding", module: "Module", name: "Name", rate: "Rate",
  maxBillDiscountPercent: "Most discount %", walkInCredit: "Walk-in may owe", status: "Status",
  barcodeFrom: "Barcode was", barcodeTo: "now", isbn: "ISBN", orderNo: "Order", title: "Book", customer: "Customer", advance: "Advance", advanceKept: "Advance kept on account",
  code: "Code", items: "Items", quantity: "Quantity",
};
const MONEY = new Set(["total", "amount", "allocated", "from", "to", "mrpFrom", "mrpTo", "balance", "advance", "advanceKept"]);
function detailText(details, biz) {
  return Object.entries(details || {})
    .filter(([k, v]) => v !== null && v !== undefined && typeof v !== "object" && LABELS[k])
    .map(([k, v]) => `${LABELS[k]} ${MONEY.has(k) && !Number.isNaN(Number(v)) ? biz.exact(v) : k === "walkInCredit" ? (v ? "yes" : "no") : String(v).replace(/_/g, " ")}`)
    .join(" · ");
}

// Who did what in this business, written in the same transaction as the change.
export default function ActivityPage() {
  const biz = useOpenBusiness();
  const list = useServerList("audit", { gridId: "business-activity", period: true });
  const columns = [
    { key: "created_at", header: "When", type: "datetime", value: (a) => a.created_at, mobile: "subtitle" },
    { key: "action", header: "What happened", value: (a) => words(a.action), mobile: "title", pin: true },
    { key: "actor_name", header: "Who", value: (a) => a.actor_name, mobile: "show" },
    { key: "details", header: "Details", value: (a) => detailText(a.details, biz), render: (a) => <span className="muted small">{detailText(a.details, biz) || "—"}</span> },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="history" title="Activity log" description="Every change made in this business, by whom and when. Entries cannot be edited or removed." />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Activity in this period">
        <DataGrid {...list.gridProps} caption="Activity log" columns={columns} rowNoun={["entry", "entries"]} toolbar={<PeriodFilter list={list} />}
          exportName={biz.can("audit.export") ? `${biz.business.code}-activity` : undefined} empty="Nothing happened in these dates" emptyIcon="history" />
      </SectionCard>
    </div>
  );
}
