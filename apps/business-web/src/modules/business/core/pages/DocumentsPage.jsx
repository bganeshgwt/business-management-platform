import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { printTaxInvoice } from "./invoice";
import { businessPath, word } from "../../../../services/businessNav";
import SearchPicker from "../../../../components/SearchPicker";
import { toast } from "../../../../services/toast";
import FormDialog from "./FormDialog";
import { BusinessHeader, Badge, Field, FormError, PeriodFilter } from "./ui";
import { businessToday, dateTime, newKey, quantity, useOpenBusiness, useOptions, useServerList } from "./hooks";
import { GOODS_TYPES, methodWord, printReceipt } from "../../retail/pages/retail";
import { usePaymentMethods } from "./paymentMethods";
// The kinds taken on a bill here (and a refund never goes out by cheque).
const PAY_KINDS = ["cash", "upi", "card", "bank"];
// The one collection form and wholesale delivery words.
import { CollectionDialog } from "../../receivables/pages/receivablesParts";
import { DELIVERY } from "../../wholesale/pages/deliveryFormat";
// A hardware shop's sites: on a new sale, as a Sales history filter, and on a bill;
// and the fitter a new sale names, shown on the bill with their commission.
import SiteField, { SiteDialog } from "../../hardware/pages/SiteField";
import FitterField from "../../hardware/pages/FitterField";
import { tradeWord, usesSites } from "../../hardware/pages/hardware";

// Sales or purchases of one business: the list for a period, a new
// document, and each document's payments, returns and refunds.

// A rate as stored: two places, or up to four when a share of a wholesale
// order made it a fraction of a paisa (50 × ₹7.3334 = ₹366.67).
const RATE = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const rateText = (biz, value) => `${biz.symbol}${RATE.format(Number(value || 0))}`;

const balanceOf = (d) => Number(d.total) - Number(d.returned || 0) - Number(d.paid || 0) + Number(d.refunded || 0);
function paymentState(d) {
  const balance = balanceOf(d);
  if (balance > 0.004 && Number(d.paid) > 0) return ["warning", "Part paid"];
  if (balance > 0.004) return ["danger", "Due"];
  if (balance < -0.004) return ["info", "Credit"];
  return ["active", "Settled"];
}

export default function DocumentsPage({ kind }) {
  const biz = useOpenBusiness();
  const sale = kind === "sale";
  const area = sale ? "sales" : "purchasing";
  const [params, setParams] = useSearchParams();
  const [walkInDue, setWalkInDue] = useState(false);
  const navigate = useNavigate();
  // Wholesale invoices carry their order, salesperson, route and delivery.
  const trade = sale && biz.has("sales_orders") && biz.can("sales_orders.view");
  const [filters, setFilters] = useState({ unpaid: false, source: "", salesperson: "", route: "", paid_by: "", created_by: "", location: "", site: "" });
  const sited = sale && usesSites(biz);
  // Who billed it (needs the staff list) and where.
  const seeStaff = sale && biz.can("access.view");
  const { options: tradeOptions } = useOptions([...(trade ? ["salespeople", "routes"] : []), ...(seeStaff ? ["members"] : []), ...(sited ? ["hardware/sites"] : [])]);
  const tradeParams = Object.fromEntries(Object.entries({ ...filters, unpaid: filters.unpaid ? "true" : "" }).filter(([, v]) => v));
  // A shop's sales open on today (the counter's day); Quick pick still offers the month.
  const counterShop = sale && GOODS_TYPES.includes(biz.type);
  const list = useServerList("documents", { gridId: `business-${kind}s`, params: { kind, ...(walkInDue ? { walk_in_due: "true" } : {}), ...(sale ? tradeParams : {}) }, period: counterShop ? "today" : true });
  const [creating, setCreating] = useState(() => params.get("new") === "1" && biz.can(`${area}.create`));
  const [openId, setOpenId] = useState(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (params.get("new")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);

  const columns = useMemo(() => [
    { key: "document_no", header: sale ? "Invoice" : "Receipt", value: (d) => d.document_no, mobile: "title", pin: true,
      render: (d) => <button type="button" className="link-button mono" onClick={() => setOpenId(d.id)}>{d.document_no}</button> },
    { key: "created_at", header: "Date", type: "datetime", value: (d) => d.created_at, mobile: "subtitle" },
    { key: "contact_name", header: sale ? word(biz.type, "customers", "Customer").replace(/s$/, "") : "Supplier", value: (d) => d.contact_name || (sale ? "Walk-in" : "—"), mobile: "show" },
    !sale && { key: "supplier_bill_no", header: "Supplier bill", value: (d) => d.supplier_bill_no || "", render: (d) => (d.supplier_bill_no ? <span>{d.supplier_bill_no}{d.supplier_bill_date ? <small className="muted"> · {String(d.supplier_bill_date).slice(0, 10)}</small> : null}</span> : <span className="muted">—</span>) },
    { key: "location_name", header: "Location", value: (d) => d.location_name, defaultHidden: biz.locations.length < 2 },
    sale && { key: "created_by_name", header: "Billed by", value: (d) => d.created_by_name || "", defaultHidden: !GOODS_TYPES.includes(biz.type) },
    sale && { key: "paid_by", header: "Paid by", value: (d) => (d.paid_by === "mixed" ? "Mixed" : d.paid_by ? methodWord(d.paid_by) : ""),
      render: (d) => (d.paid_by ? <span>{d.paid_by === "mixed" ? "Mixed" : methodWord(d.paid_by)}</span> : <span className="muted">{Number(d.total) > 0 ? "Not paid" : "—"}</span>) },
    { key: "total", header: "Total", type: "money", exact: true, value: (d) => Number(d.total), total: "sum", mobile: "show" },
    { key: "paid", header: "Paid", type: "money", exact: true, value: (d) => Number(d.paid), total: "sum" },
    { key: "returned", header: "Returned", type: "money", exact: true, value: (d) => Number(d.returned), defaultHidden: true },
    { key: "balance", header: sale ? "To collect" : "To pay", type: "money", exact: true, value: balanceOf, total: "sum", mobile: "show" },
    { key: "state", header: "Status", type: "status", value: (d) => paymentState(d)[1], render: (d) => <Badge tone={paymentState(d)[0]} label={paymentState(d)[1]} /> },
    { key: "due_on", header: "Due on", type: "date", value: (d) => d.due_on, defaultHidden: !sale },
    sited && { key: "site", header: "Site", value: (d) => d.site_name || "", render: (d) => d.site_name || <span className="muted">—</span> },
    trade && { key: "order_no", header: "Order", value: (d) => d.order_no || "", render: (d) => (d.order_no ? <span className="mono">{d.order_no}</span> : <span className="muted">Counter</span>) },
    trade && { key: "salesperson", header: "Salesperson", value: (d) => d.salesperson_name || "" },
    trade && { key: "route", header: "Route", value: (d) => d.route_name || "", defaultHidden: true },
    trade && { key: "delivery", header: "Delivery", type: "status", value: (d) => d.delivery_status || "",
      render: (d) => (d.delivery_status ? <Badge tone={DELIVERY[d.delivery_status]?.tone} label={DELIVERY[d.delivery_status]?.label} /> : <span className="muted">—</span>) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (d) => <button type="button" className="chip-button" onClick={() => setOpenId(d.id)} title={`Open ${d.document_no}`}>View</button> },
  ].filter(Boolean), [biz.locations.length, biz.type, sale, trade, sited]);
  const setFilter = (name) => (e) => setFilters((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  return (
    <div className="stack">
      <BusinessHeader
        icon={sale ? "receipt" : "truck"}
        title={sale ? word(biz.type, "sales", "Sales") : "Purchases"}
        description={sale
          ? "Every sale with what was collected and what is still due. Prices and tax come from the product list; returns and refunds are recorded on the sale."
          : "Goods received from suppliers. Receiving adds the stock at once; supplier payments and returns are recorded on the receipt."}
        actions={biz.can(`${area}.create`) && (sale && (GOODS_TYPES.includes(biz.type) || biz.type === "salon")
          ? <Link className="button" to={businessPath(biz.id, biz.type === "salon" ? "salon-bill" : biz.type === "pharmacy" && biz.has("pharmacy") ? "rx-sale" : "counter")}><Icon name="plus" size={16} /> New bill</Link>
          : <button type="button" className="button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> {sale ? "New bill" : "Receive purchase"}</button>)}
      />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title={sale ? "Sales in this period" : "Purchases in this period"}>
        <DataGrid {...list.gridProps} caption={sale ? "Sales" : "Purchases"} columns={columns} currency={biz.symbol}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              {sale && <label className="checkbox bz-check"><input type="checkbox" checked={filters.unpaid} onChange={setFilter("unpaid")} /> Unpaid only</label>}
              {sale && <label className="checkbox bz-check"><input type="checkbox" checked={walkInDue} onChange={(e) => setWalkInDue(e.target.checked)} /> Walk-in bills not fully paid</label>}
              {sale && (
                <label className="field"><span>Paid by</span>
                  <select value={filters.paid_by} onChange={setFilter("paid_by")}>
                    <option value="">Any way</option>
                    {["cash", "upi", "card", "bank"].map((m) => <option key={m} value={m}>{methodWord(m)}</option>)}
                    <option value="mixed">Mixed</option>
                  </select>
                </label>
              )}
              {seeStaff && (tradeOptions?.members || []).length > 1 && (
                <label className="field"><span>Billed by</span>
                  <select value={filters.created_by} onChange={setFilter("created_by")}>
                    <option value="">Anyone</option>
                    {(tradeOptions?.members || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
              )}
              {sale && biz.locations.length > 1 && (
                <label className="field"><span>Location</span>
                  <select value={filters.location} onChange={setFilter("location")}>
                    <option value="">All locations</option>
                    {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              )}
              {sited && (tradeOptions?.["hardware/sites"] || []).length > 0 && (
                <label className="field"><span>Site</span>
                  <select value={filters.site} onChange={setFilter("site")}>
                    <option value="">Every site</option>
                    {(tradeOptions?.["hardware/sites"] || []).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.customer_name}</option>)}
                  </select>
                </label>
              )}
              {trade && (
                <>
                  <label className="field"><span>From</span>
                    <select value={filters.source} onChange={setFilter("source")}><option value="">Orders and counter</option><option value="order">Sales orders</option><option value="counter">Counter sales</option></select>
                  </label>
                  <label className="field"><span>Salesperson</span>
                    <select value={filters.salesperson} onChange={setFilter("salesperson")}><option value="">Anyone</option>{(tradeOptions?.salespeople || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                  </label>
                  <label className="field"><span>Route</span>
                    <select value={filters.route} onChange={setFilter("route")}><option value="">All routes</option>{(tradeOptions?.routes || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                  </label>
                </>
              )}
            </>
          )}
          rowNoun={sale ? ["sale", "sales"] : ["purchase", "purchases"]}
          exportName={biz.can(`${area}.export`) ? `${biz.business.code}-${kind}s` : undefined}
          empty={sale ? "No sales in these dates" : "No purchases in these dates"}
          emptyHint="Pick other dates above, or record one." emptyIcon="receipt"
          rowClassName={(d) => (balanceOf(d) > 0.004 && d.due_on && d.due_on < list.anchor ? "dg-tone-danger" : "")} />
      </SectionCard>
      {creating && (
        <NewDocumentDialog kind={kind} onClose={() => setCreating(false)}
          onSaved={(doc) => {
            setCreating(false); setNotice(""); list.reload(); setOpenId(doc.id);
            // What arrived can go straight onto barcode labels.
            if (!sale && doc.labels?.length && biz.has("inventory") && biz.can("catalog.print")) {
              toast.success(`${doc.document_no} saved.`, { duration: 12000, action: { label: `Print ${doc.labels.reduce((n, l) => n + Number(l.copies), 0)} labels`, onClick: () => navigate(businessPath(biz.id, "labels"), { state: { labels: doc.labels } }) } });
            } else toast.success(`${doc.document_no} saved.`);
          }} />
      )}
      {openId && <DocumentDetail documentId={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </div>
  );
}

const emptyLine = () => ({ key: newKey(), skuId: "", unit: "", quantity: "1", unitPrice: "", freeQuantity: "", discountPercent: "", lotCode: "", expiresOn: "", sellingPrice: "", mrp: "" });

function NewDocumentDialog({ kind, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const sale = kind === "sale";
  const contactKind = sale ? "customer" : "supplier";
  // Sales pick a batch from the stock list when the person may see stock.
  const pickLots = sale && biz.can("inventory.view");
  const { options, error } = useOptions(["catalog?active=true", `contacts?kind=${contactKind}&active=true`, "units", ...(pickLots ? ["stock"] : [])]);
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  // `form.method`: one of the business's own methods (paymentMethods.js).
  const methods = usePaymentMethods();
  const [form, setForm] = useState({ locationId: String(locations[0]?.id || ""), contactId: "", notes: "", paidNow: "", method: "cash", reference: "",
    supplierBillNo: "", supplierBillDate: businessToday(biz.business.timezone), buyerPan: "", panDeclaration: false, siteId: "", fitterId: "" });
  const [lines, setLines] = useState([emptyLine()]);
  const [repricing, setRepricing] = useState(false);
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState("");
  const canReprice = !sale && biz.can("catalog.edit");
  // A goods shop's walk-in pays the whole bill (the server holds to it too).
  const walkInPays = sale && GOODS_TYPES.includes(biz.type) && !form.contactId && !biz.settings.walk_in_credit;
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const items = (options?.["catalog?active=true"] || []).filter((s) => sale || s.kind === "goods");
  const [added, setAdded] = useState([]);
  const contacts = [...added, ...(options?.[`contacts?kind=${contactKind}&active=true`] || [])];
  const [newSupplier, setNewSupplier] = useState(false);
  const units = options?.units || [];
  const lots = options?.stock || [];
  const skuOf = (line) => items.find((s) => String(s.id) === String(line.skuId));
  // A receipt is entered in the item's pack (cases of 12) when it has one.
  const packUnit = (skuId) => (sale ? "" : items.find((s) => String(s.id) === String(skuId))?.pack_sizes?.[0]?.unit_code || "");
  const setLine = (key, name, value) => setLines((all) => {
    const next = all.map((l) => (l.key === key ? { ...l, [name]: value, ...(name === "skuId" ? { unit: packUnit(value), lotCode: "" } : {}) } : l));
    // Picking an item on the last line opens the next empty one.
    return name === "skuId" && value && next[next.length - 1].key === key ? [...next, emptyLine()] : next;
  });
  // The empty line waiting at the end is left out of the bill.
  const filled = lines.filter((l) => l.skuId);
  // Scan a barcode (or type a code) to add a line, or one more of a line already there.
  async function scanAdd(event) {
    event.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScanError("");
    try {
      const found = await businessRead(biz.id, "retail/scan", { code, locationId: form.locationId });
      const skuId = String(found.sku.id);
      setLines((all) => {
        const same = all.find((l) => String(l.skuId) === skuId && !["batch", "serial"].includes(found.sku.tracking));
        if (same) return all.map((l) => (l === same ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l));
        const blank = all.find((l) => !l.skuId);
        const line = { ...(blank || emptyLine()), skuId, unit: packUnit(skuId), lotCode: found.serial || "" };
        const next = blank ? all.map((l) => (l === blank ? line : l)) : [...all, line];
        return next.some((l) => !l.skuId) ? next : [...next, emptyLine()];
      });
      setScan("");
    } catch (err) {
      setScanError(getErrorMessage(err));
    }
  }

  // Units a line may be entered in: the stock unit, its pack sizes, and
  // units of the same kind (g for a kg item).
  const unitChoices = (sku) => {
    if (!sku) return [];
    const base = units.find((u) => u.code === sku.unit);
    const root = base?.base_unit_code || sku.unit;
    const related = units.filter((u) => u.active && u.code !== sku.unit && u.kind === base?.kind && (u.base_unit_code || u.code) === root);
    return [
      { code: sku.unit, label: base?.name || sku.unit, factor: 1 },
      ...(sku.pack_sizes || []).map((p) => ({ code: p.unit_code, label: `${units.find((u) => u.code === p.unit_code)?.name || p.unit_code} of ${Number(p.quantity_in_base)}`, factor: Number(p.quantity_in_base) })),
      ...related.filter((u) => !(sku.pack_sizes || []).some((p) => p.unit_code === u.code)).map((u) => ({
        code: u.code, label: u.name, factor: (u.base_unit_code ? Number(u.factor_to_base) : 1) / (base?.base_unit_code ? Number(base.factor_to_base) : 1),
      })),
    ];
  };
  const preview = (line) => {
    const sku = skuOf(line);
    if (!sku) return 0;
    const factor = unitChoices(sku).find((u) => u.code === (line.unit || sku.unit))?.factor || 1;
    // A purchase is charged for the paid quantity at the rate, less the trade discount (free units cost nothing).
    const amount = sale ? Number(sku.price) * factor * Number(line.quantity || 0)
      : Number(line.unitPrice || 0) * Number(line.quantity || 0) * (1 - Math.min(Number(line.discountPercent || 0), 99.99) / 100);
    return biz.settings.tax_mode === "inclusive" && sale ? amount : amount * (1 + Number(sku.tax_rate) / 100);
  };
  const estimate = lines.reduce((sum, l) => sum + preview(l), 0);
  // A sale over ₹2,00,000 records the buyer's PAN, unless the customer has their PAN or GSTIN saved.
  const chosen = contacts.find((c) => String(c.id) === form.contactId);
  const panNeeded = sale && estimate > 200000 && !(chosen?.pan || chosen?.gstin);

  const submit = async () => {
    const doc = await businessWrite(biz.id, "documents", {
      kind, locationId: form.locationId, contactId: form.contactId || null, notes: form.notes || undefined, requestKey,
      ...(sale && form.contactId && form.siteId ? { siteId: form.siteId } : {}),
      ...(sale && form.fitterId ? { fitterId: form.fitterId } : {}),
      ...(panNeeded ? { buyer: form.panDeclaration ? { panDeclaration: true } : { pan: form.buyerPan.trim().toUpperCase() || undefined } } : {}),
      ...(walkInPays ? { payment: { amount: "full", ...methods.body(form.method, PAY_KINDS), reference: form.reference || undefined } }
        : Number(form.paidNow) > 0 ? { payment: { amount: form.paidNow, ...methods.body(form.method, PAY_KINDS), reference: form.reference || undefined } } : {}),
      ...(sale ? {} : { supplierBillNo: form.supplierBillNo, supplierBillDate: form.supplierBillDate || undefined }),
      lines: filled.map((l) => {
        const sku = skuOf(l);
        return { skuId: l.skuId, quantity: l.quantity, ...(l.unit && l.unit !== sku?.unit ? { unit: l.unit } : {}),
          ...(sale ? {} : { unitPrice: l.unitPrice }),
          ...(!sale && Number(l.freeQuantity) > 0 ? { freeQuantity: l.freeQuantity } : {}),
          ...(!sale && Number(l.discountPercent) > 0 ? { discountPercent: l.discountPercent } : {}), ...(["batch", "serial"].includes(sku?.tracking) ? { lotCode: l.lotCode } : {}),
          ...(!sale && sku?.tracking === "batch" && l.expiresOn ? { expiresOn: l.expiresOn } : {}),
          ...(repricing && l.sellingPrice ? { sellingPrice: l.sellingPrice } : {}), ...(repricing && l.mrp ? { mrp: l.mrp } : {}) };
      }),
    });
    // Labels for what arrived: one per piece counted in the stock unit.
    const labels = sale ? [] : filled.map((l) => {
      const sku = skuOf(l);
      if (!sku || Number(sku.unit_decimals) > 0) return null;
      const factor = unitChoices(sku).find((u) => u.code === (l.unit || sku.unit))?.factor || 1;
      // Free units arrive too and need their labels.
      const pieces = Math.round((Number(l.quantity) + Number(l.freeQuantity || 0)) * factor);
      return pieces > 0 && pieces <= 500 ? { id: sku.id, label: sku.label, code: sku.code, barcode: sku.barcode, price: repricing && l.sellingPrice ? l.sellingPrice : sku.price,
        mrp: repricing && l.mrp ? l.mrp : sku.mrp, unit: sku.unit, copies: String(pieces) } : null;
    }).filter(Boolean);
    return { ...doc, labels };
  };

  // Batch and expiry columns only once a line needs them.
  const needsLot = lines.some((l) => ["batch", "serial"].includes(skuOf(l)?.tracking));
  const needsExpiry = lines.some((l) => skuOf(l)?.tracking === "batch");
  const lineColumns = [
    { key: "item", header: "Item", minWidth: sale ? 250 : 200, render: (l, ctx) => (
      <SearchPicker aria-label={ctx.label} required={Boolean(l.skuId) || filled.length === 0} options={items} value={skuOf(l) || null} placeholder="Name, code or barcode"
        getLabel={(s) => s.label} getKeywords={(s) => `${s.code} ${s.barcode || ""} ${s.product_name || ""}`}
        getDescription={(s) => `${s.code} · ${biz.exact(s.price)}${s.mrp ? ` · MRP ${biz.exact(s.mrp)}` : ""} · ${quantity(s.stock, s.unit)} in stock`}
        onChange={(s) => setLine(l.key, "skuId", s ? String(s.id) : "")} />
    ) },
    { key: "unit", header: "Unit", width: 120, render: (l, ctx) => {
      const choices = unitChoices(skuOf(l));
      return (
        <select aria-label={ctx.label} value={l.unit || skuOf(l)?.unit || ""} disabled={!choices.length} onChange={(e) => setLine(l.key, "unit", e.target.value)}>
          {choices.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
        </select>
      );
    } },
    { key: "quantity", header: "Qty", type: "number", width: 90, value: (l) => Number(l.quantity) || 0, render: (l, ctx) => (
      <input aria-label={ctx.label} required type="number" min="0.001" step="0.001" value={l.quantity} onChange={(e) => setLine(l.key, "quantity", e.target.value)} />
    ) },
    // Free units on a scheme ("10 + 1 free"), in the same unit as Qty: they go into stock at no cost.
    !sale && { key: "free", header: "Free", type: "number", width: 84, value: (l) => Number(l.freeQuantity) || 0, render: (l, ctx) => (
      <input aria-label={ctx.label} type="number" min="0" step="0.001" placeholder="0" value={l.freeQuantity} onChange={(e) => setLine(l.key, "freeQuantity", e.target.value)} />
    ) },
    !sale && { key: "cost", header: "Rate", type: "money", width: 110, value: (l) => Number(l.unitPrice) || 0, render: (l, ctx) => (
      <input aria-label={ctx.label} required={Boolean(l.skuId)} type="number" min="0" step="0.01" value={l.unitPrice} onChange={(e) => setLine(l.key, "unitPrice", e.target.value)} />
    ) },
    // The supplier's trade discount on the rate.
    !sale && { key: "discount", header: "Disc %", type: "number", width: 84, value: (l) => Number(l.discountPercent) || 0, render: (l, ctx) => (
      <input aria-label={ctx.label} type="number" min="0" max="99.99" step="0.01" placeholder="0" value={l.discountPercent} onChange={(e) => setLine(l.key, "discountPercent", e.target.value)} />
    ) },
    needsLot && { key: "lot", header: "Batch / serial", width: 130, render: (l, ctx) => {
      const sku = skuOf(l);
      if (!["batch", "serial"].includes(sku?.tracking)) return <span className="muted">—</span>;
      if (pickLots) {
        const available = lots.filter((lot) => String(lot.sku_id) === String(sku.id) && String(lot.location_id) === form.locationId && Number(lot.quantity) > 0 && !lot.expired);
        return (
          <select aria-label={ctx.label} required value={l.lotCode} onChange={(e) => setLine(l.key, "lotCode", e.target.value)}>
            <option value="">Choose…</option>
            {available.map((lot) => <option key={lot.id} value={lot.lot_code}>{lot.lot_code} · {quantity(lot.quantity, sku.unit)}{lot.expires_on ? ` · exp ${lot.expires_on}` : ""}</option>)}
          </select>
        );
      }
      return <input aria-label={ctx.label} required value={l.lotCode} placeholder={sku.tracking === "serial" ? "Serial / IMEI" : "Batch no."} onChange={(e) => setLine(l.key, "lotCode", e.target.value)} />;
    } },
    !sale && repricing && { key: "reprice", header: "New selling price / MRP", render: (l, ctx) => {
      const sku = skuOf(l);
      if (!sku) return <span className="muted">—</span>;
      return (
        <span className="bz-reprice">
          <input aria-label={`New selling price, ${ctx.label}`} type="number" min="0" step="0.01" placeholder={Number(sku.price).toFixed(2)} value={l.sellingPrice} onChange={(e) => setLine(l.key, "sellingPrice", e.target.value)} />
          <input aria-label={`New MRP, ${ctx.label}`} type="number" min="0" step="0.01" placeholder={sku.mrp ? `MRP ${Number(sku.mrp).toFixed(2)}` : "MRP"} value={l.mrp} onChange={(e) => setLine(l.key, "mrp", e.target.value)} />
        </span>
      );
    } },
    !sale && needsExpiry && { key: "expiry", header: "Expiry", render: (l, ctx) => (skuOf(l)?.tracking === "batch"
      ? <input aria-label={ctx.label} type="date" required={biz.type === "pharmacy"} value={l.expiresOn} onChange={(e) => setLine(l.key, "expiresOn", e.target.value)} />
      : <span className="muted">—</span>) },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => preview(l), total: "sum" },
    { key: "remove", header: "", label: "Remove", type: "actions", render: (l) => lines.length > 1 && l.skuId && (
      <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>
    ) },
  ];

  return (
    <FormDialog title={sale ? "New sale" : "Receive a purchase"} icon={sale ? "receipt" : "truck"} width={sale ? 1040 : 1320}
      description={sale
        ? `Prices and tax come from the product list${biz.settings.tax_mode === "inclusive" ? " (prices include tax)" : ""}. Posting reduces stock.`
        : "Enter costs before tax. Receiving adds the stock at this location straight away."}
      submitLabel={sale ? "Post sale" : "Post receipt"} onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}>
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading label="Loading products and contacts…" /></div>}
      <Field label="Location">
        <select required value={form.locationId} onChange={set("locationId")}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      {sale ? (
        <Field label={`${word(biz.type, "customers", "Customers").replace(/s$/, "")} (optional)`}>
          <select value={form.contactId} onChange={(e) => setForm((f) => ({ ...f, contactId: e.target.value, siteId: "" }))}>
            <option value="">Walk-in</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.credit_limit ? ` · limit ${biz.amount(c.credit_limit)}` : ""}</option>)}
          </select>
        </Field>
      ) : (
        <div className="field bz-supplier-field">
          <SearchPicker label="Supplier" required options={contacts} value={contacts.find((c) => String(c.id) === form.contactId) || null}
            getKey={(c) => c.id} getLabel={(c) => c.name} getKeywords={(c) => `${c.phone || ""} ${c.gstin || ""}`}
            getDescription={(c) => [c.phone, c.gstin && `GSTIN ${c.gstin}`].filter(Boolean).join(" · ")}
            placeholder="Type the supplier's name" onChange={(c) => setForm((f) => ({ ...f, contactId: c ? String(c.id) : "" }))} />
          {biz.can("contacts.create") && <button type="button" className="link-button small" onClick={() => setNewSupplier(true)}>+ New supplier</button>}
        </div>
      )}
      {sale && <SiteField biz={biz} contactId={form.contactId} value={form.siteId} onChange={(siteId) => setForm((f) => ({ ...f, siteId }))} />}
      {sale && <FitterField biz={biz} value={form.fitterId} onChange={(fitterId) => setForm((f) => ({ ...f, fitterId }))} />}
      {!sale && (
        <>
          <Field label="Supplier's bill number" hint="As printed on their invoice; the same bill cannot be entered twice.">
            <input required maxLength={60} value={form.supplierBillNo} onChange={set("supplierBillNo")} />
          </Field>
          <Field label="Supplier's bill date"><input type="date" required max={businessToday(biz.business.timezone)} value={form.supplierBillDate} onChange={set("supplierBillDate")} /></Field>
        </>
      )}
      <div className="field-wide bz-scan-line">
        <input aria-label="Scan a barcode to add a line" placeholder="Scan a barcode or type a code, then Enter" value={scan} autoComplete="off"
          onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") scanAdd(e); }} />
        <button type="button" className="button button-secondary button-sm" onClick={scanAdd}>Add</button>
        {canReprice && <label className="checkbox bz-check"><input type="checkbox" checked={repricing} onChange={(e) => setRepricing(e.target.checked)} /> Update selling price / MRP from this bill</label>}
        {scanError && <small className="bz-due">{scanError}</small>}
      </div>
      <div className="field-wide bz-lines">
        <DataGrid variant="editor" caption="Lines" rows={lines} rowKey={(l) => l.key} columns={lineColumns.filter(Boolean)} currency={biz.symbol} />
        <div className="bz-lines-foot">
          <button type="button" className="button button-secondary" disabled={lines.length >= 100} onClick={() => setLines((all) => [...all, emptyLine()])}>
            <Icon name="plus" size={15} /> Add line
          </button>
          <span className="muted small">Estimated total {biz.exact(estimate)} — the server works out the exact figures.</span>
        </div>
      </div>
      {walkInPays && biz.can("sales.edit") && (
        <>
          <p className="field-wide small muted">A walk-in pays the whole bill now. To give udhaar, choose the customer above.</p>
          <Field label="Paid by">
            <select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>
              {methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
            </select>
          </Field>
        </>
      )}
      {walkInPays && !biz.can("sales.edit") && <p className="field-wide bz-due small">A walk-in pays the whole bill, and your role does not take payments. Choose the customer, or ask someone who takes payments.</p>}
      {!walkInPays && biz.can(`${sale ? "sales" : "purchasing"}.edit`) && (
        <>
          <Field label={sale ? "Collected now (optional)" : "Paid now (optional)"} hint="Leave empty to record the payment later.">
            <input type="number" min="0" step="0.01" value={form.paidNow} onChange={set("paidNow")} />
          </Field>
          <Field label="Paid by">
            <select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")} disabled={!Number(form.paidNow)}>
              {methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
            </select>
          </Field>
        </>
      )}
      {panNeeded && (
        <>
          <Field label="Buyer's PAN" hint="A bill over ₹2,00,000 records the buyer's PAN; save it with the customer to skip this.">
            <input maxLength={10} className="mono" placeholder="ABCDE1234F" disabled={form.panDeclaration} value={form.buyerPan}
              onChange={(e) => setForm((f) => ({ ...f, buyerPan: e.target.value.toUpperCase() }))} />
          </Field>
          <label className="checkbox bz-check"><input type="checkbox" checked={form.panDeclaration}
            onChange={(e) => setForm((f) => ({ ...f, panDeclaration: e.target.checked, buyerPan: e.target.checked ? "" : f.buyerPan }))} /> The buyer has no PAN and signed a declaration (Form 97)</label>
        </>
      )}
      <Field label="Notes" wide><input value={form.notes} maxLength={500} onChange={set("notes")} /></Field>
      {newSupplier && <NewSupplierDialog onClose={() => setNewSupplier(false)}
        onSaved={(c) => { setNewSupplier(false); setAdded((list) => [c, ...list]); setForm((f) => ({ ...f, contactId: String(c.id) })); }} />}
    </FormDialog>
  );
}

// Also opened from other screens (the salon calendar and bill).
// initialAction: "returns" opens Take back items as soon as the bill is read
// (Quick bill's Return button).
export function DocumentDetail({ documentId, onClose, onChanged, initialAction = null }) {
  const biz = useOpenBusiness();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState(initialAction);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `documents/${documentId}`, undefined, controller.signal)
      .then((d) => { setDoc(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, documentId, version]);

  const area = doc?.kind === "purchase" ? "purchasing" : "sales";
  const paid = doc ? doc.payments.reduce((s, p) => s + Number(p.amount), 0) : 0;
  const returned = doc ? doc.returns.reduce((s, r) => s + Number(r.total), 0) : 0;
  const refunded = doc ? doc.refunds.reduce((s, r) => s + Number(r.amount), 0) : 0;
  const balance = doc ? Number(doc.total) - returned - paid + refunded : 0;
  const changed = () => { setAction(null); setVersion((n) => n + 1); onChanged(); };

  return (
    <>
    <Modal title={doc ? `${doc.kind === "sale" ? "Sale" : "Purchase"} ${doc.document_no}` : "Loading…"} icon="receipt" width={900} onClose={() => { if (!action) onClose(); }}
      description={doc ? `${doc.contact_name || "Walk-in customer"} · ${doc.location_name} · ${dateTime(doc.created_at)}` : undefined}>
      <ErrorMessage message={error} />
      {!doc && !error && <Loading />}
      {doc && (
        <div className="stack bz-detail">
          <DataGrid variant="compact" id="business-document-lines" caption="Lines" rows={doc.lines} currency={biz.symbol} rowNoun={["line", "lines"]} columns={[
            { key: "label", header: "Item", mobile: "title" },
            { key: "quantity", header: "Qty", value: (l) => Number(l.entered_quantity || l.quantity), render: (l) => (l.entered_unit ? `${quantity(l.entered_quantity, l.entered_unit)} (${quantity(l.quantity, l.unit)})` : quantity(l.quantity, l.unit)) },
            { key: "unit_price", header: "Rate", type: "money", exact: true, value: (l) => Number(l.entered_unit_price || l.unit_price), render: (l) => rateText(biz, l.entered_unit_price || l.unit_price) },
            { key: "lot_code", header: "Batch / serial", value: (l) => l.lot_code || "", defaultHidden: !doc.lines.some((l) => l.lot_code) },
            // A supplier's scheme on a received line: free units and the trade discount.
            doc.kind === "purchase" && doc.lines.some((l) => Number(l.free_quantity) || Number(l.discount_percent)) && { key: "scheme", header: "Scheme",
              value: (l) => [Number(l.free_quantity) ? `${Number(l.free_quantity)} free` : "", Number(l.discount_percent) ? `${Number(l.discount_percent)}% off` : ""].filter(Boolean).join(" · ") },
            { key: "net", header: "Before tax", type: "money", exact: true, value: (l) => Number(l.net), total: "sum" },
            { key: "tax", header: `Tax`, type: "money", exact: true, value: (l) => Number(l.tax), total: "sum" },
            { key: "returned", header: "Returned", type: "number", value: (l) => Number(l.returned_quantity), defaultHidden: !doc.returns.length },
            // Offers and redeemed points (retail): what came off each line before tax.
            doc.retail?.discounts?.length > 0 && { key: "saved", header: "Offers", value: (l) => doc.retail.discounts.filter((x) => x.line_id === l.id).reduce((s, x) => s + Number(x.amount), 0),
              type: "money", exact: true, total: "sum", render: (l) => {
                const given = doc.retail.discounts.filter((x) => x.line_id === l.id);
                if (!given.length) return "—";
                return <span className="bz-two-line"><span>−{biz.exact(given.reduce((s, x) => s + Number(x.amount), 0))}</span><small className="muted">{given.map((x) => x.label).join(", ")}</small></span>;
              } },
          ].filter(Boolean)} />
          {doc.hardware?.site && <p className="small">Site <strong>{doc.hardware.site.name}</strong>{doc.hardware.site.address ? ` · ${doc.hardware.site.address}` : ""}</p>}
          {doc.hardware?.fitter && (
            <p className="small">Fitted by <strong>{doc.hardware.fitter.name}</strong> ({tradeWord(doc.hardware.fitter.trade).toLowerCase()})
              {doc.hardware.fitter.commission !== undefined && ` · commission ${biz.exact(doc.hardware.fitter.commission)}${Number(doc.hardware.fitter.taken_back) > 0 ? `, ${biz.exact(doc.hardware.fitter.taken_back)} of it taken back for goods returned` : ""}`}</p>
          )}
          <div className="bz-totals">
            <span>Before tax <strong>{biz.exact(doc.subtotal)}</strong></span>
            <span>Tax <strong>{biz.exact(doc.tax)}</strong></span>
            {Number(doc.round_off) !== 0 && <span>Round-off <strong>{biz.exact(doc.round_off)}</strong></span>}
            {Number(doc.retail?.savings || 0) > 0 && <span>Offers & points saved <strong>{biz.exact(doc.retail.savings)}</strong></span>}
            <span>Total <strong>{biz.exact(doc.total)}</strong></span>
            <span>Paid <strong>{biz.exact(paid - refunded)}</strong></span>
            {returned > 0 && <span>Returned <strong>{biz.exact(returned)}</strong></span>}
            <span className={balance > 0.004 ? "bz-due" : ""}>{balance < -0.004 ? "Credit" : doc.kind === "sale" ? "To collect" : "To pay"} <strong>{biz.exact(Math.abs(balance))}</strong></span>
          </div>
          {(doc.payments.length > 0 || doc.returns.length > 0 || doc.refunds.length > 0) && (
            <ul className="bz-history">
              {doc.payments.map((p) => <li key={`p${p.id}`}><Badge status="completed" label="Payment" /> {biz.exact(p.amount)} by {p.method === "credit_note" ? "credit note" : p.method === "finance" ? "EMI (owed by the financier)" : p.method_name || p.method.toUpperCase()} {p.reference ? `· ${p.reference}` : ""}{p.tendered && Number(p.tendered) > Number(p.amount) ? ` · ${biz.exact(p.tendered)} handed over, ${biz.exact(Number(p.tendered) - Number(p.amount))} change` : ""} · {dateTime(p.created_at)}</li>)}
              {(doc.finance || []).map((f) => <li key={`emi${f.id}`}><Badge status={f.status === "pending" ? "pending" : f.status === "settled" ? "completed" : "cancelled"} label="EMI" /> {f.financier_name} · loan {f.loan_no}{f.do_no ? ` · DO ${f.do_no}` : ""} · financed {biz.exact(f.financed_amount)} · down payment {biz.exact(f.down_payment)}{f.status === "pending" ? " · awaiting payout" : f.status === "settled" ? " · paid out" : " · cancelled"}</li>)}
              {doc.returns.map((r) => <li key={`r${r.id}`}><Badge status="no_show" label="Return" /> {r.return_no || `#${r.id}`} · {biz.exact(r.total)} · {r.reason} · {dateTime(r.created_at)}</li>)}
              {doc.refunds.map((r) => <li key={`f${r.id}`}><Badge status="cancelled" label="Refund" /> {biz.exact(r.amount)} by {r.method === "credit_note" ? "credit note" : r.method === "finance" ? "EMI reversed (financier)" : r.method_name || r.method.toUpperCase()} · {r.reason} · {dateTime(r.created_at)}</li>)}
            </ul>
          )}
          <div className="form-actions bz-start">
            {doc.kind === "sale" && doc.contact_id && biz.has("receivables") && biz.can("receivables.create") && balance > 0.004
              ? <button type="button" className="button" onClick={() => setAction("collect")}>Record collection</button>
              : biz.can(`${area}.edit`) && balance > 0.004 && <button type="button" className="button" onClick={() => setAction("payments")}>{doc.kind === "sale" ? "Record collection" : "Record payment"}</button>}
            {biz.can(`${area}.refund`) && <button type="button" className="button button-secondary" onClick={() => setAction("returns")}>{doc.kind === "sale" ? "Take back items" : "Return to supplier"}</button>}
            {biz.can(`${area}.refund`) && balance < -0.004 && <button type="button" className="button button-secondary" onClick={() => setAction("refunds")}>{doc.kind === "sale" ? "Refund customer" : "Record supplier refund"}</button>}
            {biz.can(`${area}.print`) && <button type="button" className="button button-secondary" onClick={() => printTaxInvoice(doc, biz)}><Icon name="print" size={15} /> {doc.kind === "sale" ? "Print invoice (A4)" : "Print"}</button>}
            {biz.can(`${area}.print`) && doc.kind === "sale" && GOODS_TYPES.includes(biz.type) && <button type="button" className="button button-secondary" onClick={() => printReceipt(doc, biz)}><Icon name="receipt" size={15} /> Till receipt (80 mm)</button>}
            {doc.kind === "sale" && doc.contact_id && usesSites(biz) && biz.can("hardware_sites.edit") && <button type="button" className="button button-secondary" onClick={() => setAction("site")}><Icon name="map-pin" size={15} /> {doc.hardware?.site ? "Change the site" : "Set the site"}</button>}
          </div>
        </div>
      )}
    </Modal>
    {action === "collect" && doc && <CollectionDialog contactId={doc.contact_id} documentId={doc.id} onClose={() => setAction(null)}
      onSaved={(c) => { toast.success(`Receipt ${c.collection_no} saved for ${biz.exact(c.amount)}`); changed(); }} />}
    {action === "site" && doc && <SiteDialog biz={biz} title={`Site of ${doc.document_no}`} contactId={doc.contact_id} current={doc.hardware?.site} path={`hardware/bills/${doc.id}/site`}
      onClose={() => setAction(null)} onSaved={(r) => { toast.success(r.site ? `${doc.document_no} goes to ${r.site.name}.` : `${doc.document_no} has no site now.`); changed(); }} />}
    {action && !["collect", "site"].includes(action) && doc && <DocumentAction doc={doc} action={action} balance={balance} onClose={() => setAction(null)} onSaved={changed} />}
    </>
  );
}

function DocumentAction({ doc, action, balance, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const open = doc.lines.filter((l) => Number(l.quantity) > Number(l.returned_quantity));
  const methods = usePaymentMethods();
  const [form, setForm] = useState({ amount: action === "payments" ? balance.toFixed(2) : action === "refunds" ? Math.abs(balance).toFixed(2) : "", method: "cash", reference: "", reason: "", lineId: String(open[0]?.id || ""), quantity: "", restock: true });
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const submit = () => businessWrite(biz.id, `documents/${doc.id}/${action}`, action === "returns"
    ? { reason: form.reason, requestKey, lines: [{ lineId: form.lineId, quantity: form.quantity, ...(doc.kind === "sale" ? { restock: form.restock } : {}) }] }
    : { amount: form.amount, ...methods.body(form.method, PAY_KINDS), ...(action === "payments" ? { reference: form.reference || undefined } : { reason: form.reason }), requestKey });
  const titles = { payments: doc.kind === "sale" ? "Record a collection" : "Record a supplier payment", returns: doc.kind === "sale" ? "Take back items" : "Return goods to the supplier", refunds: doc.kind === "sale" ? "Refund the customer" : "Record a refund from the supplier" };
  return (
    <FormDialog title={titles[action]} icon={action === "returns" ? "undo" : "wallet"} width={560} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={action === "returns" ? "Post return" : "Save"}
      description={action === "returns" ? "Returned lines use the original price and tax. A credit note number is given." : action === "refunds" ? `Refunds are limited to the credit left after returns and payments.${Number(doc.retail?.heldBack || 0) > 0 ? ` ${biz.exact(doc.retail.heldBack)} is kept back for loyalty points from this bill that were already spent.` : ""}` : `Outstanding: ${biz.exact(balance)}`}>
      {action === "returns" ? (
        <>
          <Field label="Line" wide>
            <select required value={form.lineId} onChange={set("lineId")}>
              {open.map((l) => <option key={l.id} value={l.id}>{l.label}{l.lot_code ? ` (${l.lot_code})` : ""} · {quantity(Number(l.quantity) - Number(l.returned_quantity), l.unit)} left</option>)}
            </select>
          </Field>
          <Field label="Quantity"><input required type="number" min="0.001" step="0.001" value={form.quantity} onChange={set("quantity")} /></Field>
          {doc.kind === "sale" && (
            <label className="checkbox bz-check"><input type="checkbox" checked={form.restock} onChange={set("restock")} /> Put back into stock (untick for damaged goods)</label>
          )}
        </>
      ) : (
        <>
          <Field label="Amount"><input required type="number" min="0.01" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
          <Field label="Method">
            <select value={methods.resolve(form.method, PAY_KINDS)} onChange={set("method")}>{methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
          </Field>
          {action === "payments" && <Field label="Reference (optional)" wide><input value={form.reference} maxLength={100} onChange={set("reference")} /></Field>}
        </>
      )}
      {action !== "payments" && <Field label="Reason" wide><input required value={form.reason} maxLength={300} onChange={set("reason")} /></Field>}
    </FormDialog>
  );
}

// A supplier added from the purchase form: name, phone and GSTIN; the rest
// can be filled in later under Suppliers.
function NewSupplierDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ name: "", phone: "", gstin: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: name === "gstin" ? e.target.value.toUpperCase() : e.target.value }));
  return (
    <FormDialog title="New supplier" icon="truck" width={480} onClose={onClose} onSaved={onSaved} submitLabel="Add supplier"
      onSubmit={() => businessWrite(biz.id, "contacts", { kind: "supplier", name: form.name.trim(), phone: form.phone.trim() || undefined, gstin: form.gstin.trim() || undefined })}>
      <Field label="Name" wide><input required autoFocus maxLength={150} value={form.name} onChange={set("name")} placeholder="e.g. Sri Murugan Medical Agencies" /></Field>
      <Field label="Phone (optional)"><input maxLength={30} inputMode="tel" value={form.phone} onChange={set("phone")} /></Field>
      <Field label="GSTIN (optional)"><input className="mono" maxLength={15} value={form.gstin} onChange={set("gstin")} /></Field>
    </FormDialog>
  );
}
