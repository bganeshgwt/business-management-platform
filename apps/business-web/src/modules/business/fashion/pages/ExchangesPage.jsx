import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "../../core/pages/ui";
import { dateTime, newKey, quantity, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
// The difference is settled in money by the business's own methods of these kinds.
const MONEY_KINDS = ["cash", "upi", "card", "bank"];
const CREDIT = ["voucher", "on_account"];
import { VariantPicker } from "../../retail/pages/counterParts";
import { methodWord, refuse } from "./feFormat";
import { printBill, printVoucherById } from "./feDocuments";
import CustomerCredit from "./CustomerCredit";
import { Segmented } from "./shared";

// Exchanges: goods come back on a credit note and replacements go out on a
// new bill, in one step. The credit pays the new bill first; the customer
// pays any difference, or gets the rest back as money, a credit voucher or
// (a known customer) credit on account. Pro pass: find the sale by scanning
// the item or by phone, a gift with no bill, swap the size in one tap,
// faulty / DOA units for electronics, and the new bill printed on save.
export default function ExchangesPage() {
  const biz = useOpenBusiness();
  const list = useServerList("exchanges", { gridId: "business-exchanges", period: true });
  const vouchers = useServerList("vouchers", { gridId: "business-vouchers", params: { state: "open" } });
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policy, setPolicy] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "exchanges/policy", undefined, controller.signal).then(setPolicy).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);

  const columns = useMemo(() => [
    { key: "created_at", header: "When", type: "datetime", value: (x) => x.created_at, mobile: "subtitle" },
    { key: "original_no", header: "Original bill", value: (x) => x.original_no, mobile: "title", pin: true,
      render: (x) => <span className="bz-two-line"><strong className="mono">{x.original_no}</strong><small className="muted mono">{x.return_no}{x.no_bill ? " · no bill" : ""}</small></span> },
    { key: "return_no", header: "Credit note", value: (x) => x.return_no, className: "mono", defaultHidden: true },
    { key: "new_no", header: "New bill", value: (x) => x.new_no, className: "mono" },
    { key: "customer", header: "Customer", value: (x) => x.customer_name || "Walk-in", mobile: "show" },
    { key: "returned_value", header: "Came back", type: "money", exact: true, value: (x) => Number(x.returned_value), total: "sum" },
    { key: "new_value", header: "Went out", type: "money", exact: true, value: (x) => Number(x.new_value), total: "sum" },
    { key: "difference", header: "Difference", type: "money", exact: true, value: (x) => Number(x.difference), total: "sum", mobile: "show" },
    { key: "settled", header: "Settled", value: (x) => settledText(x, biz), filter: "select", minWidth: 150 },
    { key: "reason", header: "Reason", value: (x) => x.reason, defaultHidden: true },
    { key: "location", header: "Location", value: (x) => x.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "by", header: "By", value: (x) => x.created_by_name, defaultHidden: true },
  ], [biz]);

  const saved = (x) => {
    setCreating(false); setVersion((n) => n + 1); list.reload(); vouchers.reload(); setOpened(x.id);
    toast.success(`Exchanged: new bill ${x.new_no}. ${settledText(x, biz)}.`, { action: { label: "Print bill", onClick: () => printBill(biz, x.new_document_id).catch((e) => toast.error(getErrorMessage(e))) } });
    // The new bill prints, then the voucher (one print dialog after the other).
    printBill(biz, x.new_document_id).then(() => (x.voucher ? printVoucherById(biz, x.voucher.id) : null)).catch(() => {});
  };

  return (
    <div className="stack">
      <BusinessHeader icon="refresh" title="Exchanges"
        description="Take goods back and sell the replacements in one step. Scan the item, or find the bill by number or phone. The credit pays the new bill first; only the difference changes hands."
        primary={biz.can("exchanges.create") && <button type="button" className="button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New exchange</button>} />
      <ErrorMessage message={list.error} />
      {policy && (
        <div className="fe-policy">
          <Icon name="clock" size={16} />
          <span>{policy.daysAllowed ? `Exchanges are allowed within ${policy.daysAllowed} day${policy.daysAllowed === 1 ? "" : "s"} of the sale.` : "Exchanges are allowed at any time after the sale."} Credit vouchers are valid for 90 days.</span>
          {biz.can("settings.edit") && <button type="button" className="link-button" onClick={() => setPolicyOpen(true)}>Change</button>}
        </div>
      )}
      <CustomerCredit onUsed={(message) => toast.success(message)} version={version} />
      <SectionCard flush icon="refresh" title="Exchanges">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Bill, credit note, customer or reason" }} caption="Exchanges" columns={columns}
          currency={biz.symbol} rowNoun={["exchange", "exchanges"]} toolbar={<PeriodFilter list={list} />} onRowClick={(x) => setOpened(x.id)}
          exportName={biz.can("exchanges.export") ? `${biz.business.code}-exchanges` : undefined}
          empty="No exchanges in these dates" emptyHint="Pick other dates, or start a new exchange." emptyIcon="refresh" />
      </SectionCard>
      {(vouchers.gridProps.rows?.length > 0 || vouchers.gridProps.search?.value) && (
        <SectionCard flush icon="receipt" title="Open credit vouchers" description="Credit given on an exchange as a printed voucher. Scan or type the number at Quick bill to spend it.">
          <DataGrid {...vouchers.gridProps} search={{ ...vouchers.gridProps.search, placeholder: "Voucher, name, phone or bill" }} caption="Open credit vouchers" currency={biz.symbol}
            rowNoun={["voucher", "vouchers"]} columns={[
              { key: "voucher_no", header: "Voucher", value: (r) => r.voucher_no, className: "mono", mobile: "title", pin: true },
              { key: "customer", header: "For", value: (r) => r.customer_name || r.contact_name || "Walk-in", mobile: "subtitle" },
              { key: "balance", header: "Left", type: "money", exact: true, value: (r) => Number(r.balance), total: "sum", mobile: "show" },
              { key: "amount", header: "Issued", type: "money", exact: true, value: (r) => Number(r.amount) },
              { key: "expires_on", header: "Valid until", type: "date", value: (r) => r.expires_on, mobile: "show" },
              { key: "source_no", header: "From bill", value: (r) => r.source_no, className: "mono", defaultHidden: true },
              { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
                <button type="button" className="chip-button" onClick={() => printVoucherById(biz, r.id).catch((e) => toast.error(getErrorMessage(e)))}><Icon name="print" size={14} /> Print</button>
              ) },
            ]} empty="No open vouchers" emptyIcon="receipt" />
        </SectionCard>
      )}
      {creating && <NewExchangeDialog policy={policy} onClose={() => setCreating(false)} onSaved={saved} />}
      {opened && <ExchangeDetail exchangeId={opened} onClose={() => setOpened(null)} />}
      {policyOpen && <PolicyDialog policy={policy} onClose={() => setPolicyOpen(false)}
        onSaved={() => { setPolicyOpen(false); toast.success("Exchange policy saved."); setVersion((n) => n + 1); }} />}
    </div>
  );
}

function PolicyDialog({ policy, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [days, setDays] = useState(policy?.daysAllowed ? String(policy.daysAllowed) : "");
  return (
    <FormDialog title="Exchange policy" icon="clock" width={480} onClose={onClose} onSaved={onSaved}
      description="Older sales can still be returned under Sales; this limit is for exchanges."
      onSubmit={() => businessWrite(biz.id, "exchanges/policy", { daysAllowed: days === "" ? null : days }, "put")}>
      <Field label="Days after the sale" hint="Leave empty for no limit."><input type="number" min="1" max="365" step="1" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
    </FormDialog>
  );
}

function settledText(x, biz) {
  if (Number(x.collected) > 0) return `${biz.exact(x.collected)} in · ${methodWord(x.method)}`;
  if (Number(x.refunded) > 0) return `${biz.exact(x.refunded)} back · ${methodWord(x.method)}`;
  if (x.method === "voucher") return `Credit voucher${x.voucher_no || x.voucher?.voucher_no ? ` ${x.voucher_no || x.voucher.voucher_no}` : ""}`;
  if (x.method === "on_account") return "Credit kept";
  return "Even exchange";
}

const FIND_MODES = [
  { value: "scan", label: "Scan the item" },
  { value: "phone", label: "Customer phone" },
  { value: "bill", label: "Bill number" },
];

// One line going out: an item (picked, scanned or a size swap) and its quantity.
const outLine = (sku, lotCode = "") => ({ key: newKey(), skuId: sku.id ?? sku.sku_id, label: sku.label, price: Number(sku.price), tracking: sku.tracking, quantity: "1", lotCode });

function NewExchangeDialog({ policy, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const electronics = biz.type === "electronics" || biz.has?.("serials");
  const sizes = biz.has?.("variants");
  const canNoBill = biz.can("sales.refund");
  const [requestKey] = useState(newKey);
  const [mode, setMode] = useState("scan");
  const [search, setSearch] = useState("");
  const [found, setFound] = useState(null);
  const [preset, setPreset] = useState(null);
  const [sale, setSale] = useState(null);
  const [gift, setGift] = useState(null);
  const [back, setBack] = useState({});
  const [out, setOut] = useState([]);
  const [scan, setScan] = useState("");
  const [swap, setSwap] = useState(null);
  // `form.method`: "voucher", "on_account", or one of the business's own payment methods.
  const [form, setForm] = useState({ reason: "", locationId: String(biz.locations.find((l) => l.active)?.id || ""), method: "cash", amount: "", reference: "", name: "", phone: "" });
  const methods = usePaymentMethods();
  const settleBy = () => (CREDIT.includes(form.method) ? { method: form.method } : methods.body(form.method, MONEY_KINDS));
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (e) => { setForm((f) => ({ ...f, [name]: e.target.value })); if (name === "locationId") setQuote(null); };
  const stale = () => setQuote(null);

  const find = async (event) => {
    event?.preventDefault();
    setError(""); setFound(null);
    const text = search.trim();
    if (!text) return;
    try {
      if (mode === "gift") {
        const scanned = await businessRead(biz.id, "retail/scan", { code: text, locationId: form.locationId });
        setGift({ sku: scanned.sku, quantity: "1", restock: true }); setSale(null); setQuote(null);
        return;
      }
      if (mode === "bill") {
        const result = await businessRead(biz.id, "documents", { kind: "sale", q: text, limit: 8 });
        setFound(result.items.map((d) => ({ ...d, lines: [] })));
      } else {
        const result = await businessRead(biz.id, "exchanges/find", mode === "scan" ? { code: text } : { phone: text });
        setFound(result.items);
        // One sale for the item scanned: open it straight away.
        if (mode === "scan" && result.items.length === 1) await choose(result.items[0]);
      }
    } catch (err) { setError(getErrorMessage(err)); }
  };
  const choose = async (doc) => {
    setError("");
    try {
      const detail = await businessRead(biz.id, `documents/${doc.id}`);
      setSale(detail); setGift(null); setQuote(null);
      // The item that was scanned comes back: one piece already ticked.
      const match = (doc.lines || []).filter((l) => Number(l.quantity) > Number(l.returned));
      setBack(mode === "scan" && match.length ? { [match[0].lineId]: { quantity: "1", restock: true } } : {});
      setPreset(mode === "scan" && match.length ? match[0] : null);
      setForm((f) => ({ ...f, locationId: String(detail.location_id) }));
    } catch (err) { setError(getErrorMessage(err)); }
  };
  const returnable = (sale?.lines || []).filter((l) => Number(l.quantity) > Number(l.returned_quantity));
  const setLine = (key, name, value) => { setOut((all) => all.map((l) => (l.key === key ? { ...l, [name]: value } : l))); stale(); };
  const addScanned = async (event) => {
    event?.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setError("");
    try {
      const result = await businessRead(biz.id, "retail/scan", { code, locationId: form.locationId });
      setOut((all) => [...all, outLine(result.sku, result.serial || (result.lots?.length === 1 && result.sku.tracking === "serial" ? result.lots[0].lot_code : ""))]);
      setScan(""); stale();
    } catch (err) { setError(getErrorMessage(err)); }
  };
  // Same style, another size or colour: the line comes back and the pick goes out.
  const openSwap = async (line) => {
    setError("");
    try {
      const page = await businessRead(biz.id, "catalog", { q: line.label, limit: 5 });
      const sku = page.items.find((s) => String(s.id) === String(line.sku_id));
      if (!sku) throw refuse("This item is no longer in the catalogue.");
      setSwap({ line, product: { id: sku.product_id, name: sku.product_name } });
    } catch (err) { setError(getErrorMessage(err)); }
  };
  const swapped = (variant) => {
    const line = swap.line;
    setBack((all) => ({ ...all, [line.id]: { ...all[line.id], quantity: all[line.id]?.quantity || "1", restock: all[line.id]?.restock !== false } }));
    setOut((all) => [...all, outLine({ id: variant.sku_id, label: variant.label, price: variant.price, tracking: variant.tracking })]);
    setSwap(null); stale();
  };

  const body = () => (gift ? {
    noBill: true, returnSku: { skuId: gift.sku.id, quantity: gift.quantity, restock: gift.restock },
  } : {
    documentId: sale.id,
    returnLines: returnable.filter((l) => Number(back[l.id]?.quantity) > 0).map((l) => ({ lineId: l.id, quantity: back[l.id].quantity, restock: back[l.id].restock !== false,
      ...(back[l.id].faulty ? { faulty: back[l.id].faulty } : {}) })),
  });
  const full = () => ({ ...body(), reason: form.reason || undefined, locationId: form.locationId || undefined,
    newLines: out.map((l) => ({ skuId: l.skuId, quantity: l.quantity, ...(l.lotCode ? { lotCode: l.lotCode } : {}) })) });
  const workOut = async () => {
    setBusy(true); setError("");
    try {
      if (!out.length) throw refuse("Scan or pick what goes out first.");
      const result = await businessWrite(biz.id, "exchanges/quote", full());
      setQuote(result);
      setForm((f) => ({ ...f, amount: Number(result.due) > 0 ? result.due : "", method: Number(result.excess) > 0 && (gift || result.walkIn) ? "voucher" : f.method === "voucher" ? "cash" : f.method }));
    } catch (err) { setError(getErrorMessage(err)); setQuote(null); } finally { setBusy(false); }
  };
  const due = Number(quote?.due || 0), excess = Number(quote?.excess || 0);
  const refundBlocked = excess > 0 && !biz.can("sales.refund") && !["on_account", "voucher"].includes(form.method);
  const submit = async () => {
    if (!sale && !gift) throw refuse("Find the sale, or scan the gift, first.");
    if (!quote) throw refuse("Work out the difference first, so you can see what the customer pays or gets back.");
    if (!form.reason.trim()) throw refuse("Give a reason for the exchange.");
    if (refundBlocked) throw refuse("Giving money back needs the refund permission. Give a credit voucher, or ask a manager.");
    const settlement = due > 0 ? { ...settleBy(), amount: form.amount, reference: form.reference || undefined }
      : excess > 0 ? { ...settleBy(), reference: form.reference || undefined, ...(form.method === "voucher" ? { name: form.name || undefined, phone: form.phone || undefined } : {}) } : undefined;
    return businessWrite(biz.id, "exchanges", { ...full(), reason: form.reason, requestKey, ...(settlement ? { settlement } : {}) });
  };

  const backColumns = [
    { key: "label", header: "Sold item", value: (l) => l.label, render: (l) => <span className="bz-two-line"><strong>{l.label}</strong><small className="muted">{l.lot_code || ""} {biz.exact(Number(l.net) + Number(l.tax))} for {quantity(l.quantity, l.unit)}</small></span> },
    { key: "left", header: "Can come back", type: "number", value: (l) => Number(l.quantity) - Number(l.returned_quantity) },
    { key: "qty", header: "Coming back", type: "number", value: (l) => Number(back[l.id]?.quantity || 0), total: "sum",
      render: (l, ctx) => <input aria-label={ctx.label} type="number" min="0" max={Number(l.quantity) - Number(l.returned_quantity)} step="1" value={back[l.id]?.quantity ?? ""} placeholder="0"
        onChange={(e) => { setBack((all) => ({ ...all, [l.id]: { ...all[l.id], quantity: e.target.value } })); stale(); }} /> },
    { key: "restock", header: "Back to stock", label: "Back to stock", render: (l, ctx) => <input aria-label={ctx.label} type="checkbox" checked={back[l.id]?.restock !== false}
      onChange={(e) => { setBack((all) => ({ ...all, [l.id]: { ...all[l.id], restock: e.target.checked } })); stale(); }} /> },
    electronics && { key: "faulty", header: "Condition", label: "Condition", render: (l, ctx) => (l.lot_code ? (
      <select aria-label={ctx.label} value={back[l.id]?.faulty || ""} onChange={(e) => { setBack((all) => ({ ...all, [l.id]: { ...all[l.id], faulty: e.target.value || undefined, restock: true } })); stale(); }}>
        <option value="">Working</option><option value="doa">Dead on arrival</option><option value="faulty">Faulty</option>
      </select>) : <span className="muted">—</span>) },
    sizes && { key: "swap", header: "", label: "Swap", type: "actions", render: (l) => <button type="button" className="chip-button" onClick={() => openSwap(l)}><Icon name="refresh" size={14} /> Swap size / colour</button> },
  ].filter(Boolean);
  const outColumns = [
    { key: "item", header: "Going out", value: (l) => l.label, render: (l) => <span className="bz-two-line"><strong>{l.label}</strong>{l.lotCode && <small className="muted mono">{l.lotCode}</small>}</span> },
    { key: "qty", header: "Qty", type: "number", value: (l) => Number(l.quantity) || 0, render: (l, ctx) => (l.tracking === "serial" ? "1"
      : <input aria-label={ctx.label} type="number" min="1" step="1" value={l.quantity} onChange={(e) => setLine(l.key, "quantity", e.target.value)} />) },
    { key: "lot", header: "IMEI / serial", render: (l, ctx) => (l.tracking === "serial" && !l.lotCode
      ? <input aria-label={ctx.label} className="mono" placeholder="Scan the box" value={l.lotCode} onChange={(e) => setLine(l.key, "lotCode", e.target.value.trim())} />
      : <span className="muted">{l.lotCode ? "Scanned" : "—"}</span>) },
    { key: "price", header: biz.settings.tax_mode === "inclusive" ? "Price" : "Price before GST", type: "money", exact: true, value: (l) => l.price * Number(l.quantity || 0) },
    { key: "remove", header: "", label: "Remove", type: "actions", render: (l) => <button type="button" className="link-button danger" onClick={() => { setOut((all) => all.filter((x) => x.key !== l.key)); stale(); }}>Remove</button> },
  ];

  return (
    <FormDialog title="New exchange" icon="refresh" width={1040} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={!quote ? "Work out the difference first" : due > 0 ? `Exchange and collect ${biz.exact(form.amount || 0)}` : excess > 0 ? (form.method === "voucher" ? `Exchange, print a voucher for ${biz.exact(excess)}` : form.method === "on_account" ? "Exchange, keep on account" : `Exchange and refund ${biz.exact(excess)}`) : "Exchange"}
      description={policy?.daysAllowed ? `Sales from the last ${policy.daysAllowed} days can be exchanged. The new bill prints when you save.` : "The new bill prints when you save."}>
      <FormError message={error} />
      {!sale && !gift ? (
        <div className="field-wide stack">
          <Segmented label="Find the sale by" options={[...FIND_MODES, ...(canNoBill ? [{ value: "gift", label: "No bill (gift)" }] : [])]} value={mode}
            onChange={(m) => { setMode(m); setFound(null); setSearch(""); setError(""); }} />
          <div className="fe-find">
            <label className="field"><span>{mode === "scan" ? "Scan the item coming back" : mode === "phone" ? "Customer's phone" : mode === "bill" ? "Bill number or customer name" : "Scan the gift"}</span>
              <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} inputMode={mode === "phone" ? "tel" : undefined}
                placeholder={mode === "scan" || mode === "gift" ? "Barcode, SKU code or IMEI" : mode === "phone" ? "e.g. 98450 12345" : "e.g. SI/2627/0029"}
                onKeyDown={(e) => { if (e.key === "Enter") find(e); }} /></label>
            <button type="button" className="button button-secondary" onClick={find}><Icon name="search" size={15} /> Find</button>
          </div>
          {mode === "gift" && <p className="muted small">No bill: the item goes back on the most recent sale of it within the policy, at the price it was sold for. Any credit is given as a voucher, never cash.</p>}
          {found && (
            <DataGrid variant="compact" id="exchange-find" caption="Sales found" rows={found} currency={biz.symbol} rowNoun={["sale", "sales"]}
              empty="No sale found" emptyHint={mode === "scan" ? "No sale of this item inside the exchange policy. Try the bill number." : "Check what you typed."}
              columns={[
                { key: "document_no", header: "Bill", value: (d) => d.document_no, className: "mono", mobile: "title" },
                { key: "created_at", header: "Date", type: "datetime", value: (d) => d.created_at },
                { key: "customer", header: "Customer", value: (d) => d.contact_name || "Walk-in", mobile: "show" },
                { key: "lines", header: "Item", value: (d) => (d.lines || []).map((l) => l.label).join(", ") },
                { key: "total", header: "Total", type: "money", exact: true, value: (d) => Number(d.total), mobile: "show" },
                { key: "pick", header: "", label: "Choose", type: "actions", render: (d) => <button type="button" className="chip-button" onClick={() => choose(d)}>Choose</button> },
              ]} />
          )}
        </div>
      ) : (
        <>
          <div className="field-wide fe-sale-head">
            {gift
              ? <span><Badge tone="warning" label="No bill" /> <strong>{gift.sku.label}</strong> · goes back on its latest sale within the policy</span>
              : <span><strong className="mono">{sale.document_no}</strong> · {sale.contact_name || "Walk-in customer"} · {dateTime(sale.created_at)} · {biz.exact(sale.total)}{preset ? ` · scanned: ${preset.label}` : ""}</span>}
            <button type="button" className="link-button" onClick={() => { setSale(null); setGift(null); setQuote(null); setOut([]); }}>Start again</button>
          </div>
          <div className="field-wide">
            <h3 className="fe-subhead"><Icon name="undo" size={15} /> Coming back</h3>
            {gift ? (
              <div className="fe-inline-row">
                <Field label="Quantity"><input type="number" min="1" step="1" value={gift.quantity} onChange={(e) => { setGift((g) => ({ ...g, quantity: e.target.value })); stale(); }} /></Field>
                <label className="checkbox bz-check"><input type="checkbox" checked={gift.restock} onChange={(e) => { setGift((g) => ({ ...g, restock: e.target.checked })); stale(); }} /> Back to stock</label>
                {sizes && <button type="button" className="chip-button" onClick={() => setSwap({ line: null, product: { id: gift.sku.product_id, name: gift.sku.product_name } })}><Icon name="refresh" size={14} /> Swap size / colour</button>}
              </div>
            ) : <DataGrid variant="editor" caption="Items coming back" rows={returnable} rowKey={(l) => l.id} columns={backColumns} currency={biz.symbol} />}
          </div>
          <div className="field-wide">
            <h3 className="fe-subhead"><Icon name="arrow-right" size={15} /> Going out</h3>
            <div className="fe-find">
              <label className="field"><span>Scan a barcode or IMEI</span><input value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Barcode, SKU code or IMEI"
                onKeyDown={(e) => { if (e.key === "Enter") addScanned(e); }} /></label>
              <button type="button" className="button button-secondary" disabled={!scan.trim()} onClick={addScanned}>Add</button>
            </div>
            <SearchPicker aria-label="Or find an item" placeholder="Or type a name to find an item" clearOnSelect minChars={2}
              search={(q, { signal }) => businessRead(biz.id, "catalog", { q, limit: 15, kind: "goods", active: "true" }, signal).then((page) => page.items)}
              getLabel={(s) => s.label} getDescription={(s) => `${s.code} · ${Number(s.stock)} in stock · ${biz.exact(s.price)}`} isDisabled={(s) => Number(s.stock) <= 0}
              onChange={(s) => { if (s) { setOut((all) => [...all, outLine(s)]); stale(); } }} />
            {out.length > 0 && <DataGrid variant="editor" caption="Items going out" rows={out} rowKey={(l) => l.key} columns={outColumns} currency={biz.symbol} />}
          </div>
          {biz.locations.length > 1 && (
            <Field label="Replacements leave from">
              <select value={form.locationId} onChange={set("locationId")}>{biz.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
            </Field>
          )}
          <Field label="Reason" wide><input maxLength={280} value={form.reason} onChange={set("reason")} placeholder={electronics ? "e.g. Does not power on" : "e.g. Size too small"} list="fe-exchange-reasons" /></Field>
          <datalist id="fe-exchange-reasons">{(electronics ? ["Dead on arrival", "Does not power on", "Screen defect", "Customer changed mind"] : ["Size too small", "Size too big", "Colour", "Gift", "Defect"]).map((r) => <option key={r} value={r} />)}</datalist>
          <div className="field-wide">
            <button type="button" className="button button-secondary" disabled={busy} onClick={workOut}><Icon name="refresh" size={15} /> {busy ? "Working out…" : "Work out the difference"}</button>
          </div>
          {quote && (
            <>
              <div className="field-wide bz-totals">
                <span>Coming back <strong>{biz.exact(quote.returnedValue)}</strong></span>
                <span>Going out <strong>{biz.exact(quote.newValue)}</strong></span>
                <span>Credit used on the new bill <strong>{biz.exact(quote.creditApplied)}</strong></span>
                {due > 0 && <span className="bz-due">Customer pays <strong>{biz.exact(quote.due)}</strong></span>}
                {excess > 0 && <span>Customer gets back <strong>{biz.exact(quote.excess)}</strong></span>}
                {due === 0 && excess === 0 && <span>Nothing to pay <strong>{biz.exact(0)}</strong></span>}
              </div>
              {(due > 0 || excess > 0) && (
                <>
                  <Field label={due > 0 ? "Paid by" : "Given back as"}>
                    <select value={CREDIT.includes(form.method) ? form.method : methods.resolve(form.method, MONEY_KINDS)} onChange={set("method")}>
                      {excess > 0 && <option value="voucher">Credit voucher (valid {quote.voucherDays || 90} days)</option>}
                      {(due > 0 || !gift) && methods.options(MONEY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                      {excess > 0 && sale?.contact_id && <option value="on_account">Keep on the customer's account</option>}
                    </select>
                  </Field>
                  {due > 0 && (
                    <Field label="Amount collected now" hint={quote.walkIn ? "A walk-in customer pays the whole difference now." : "Leave less to put the rest on their account."}>
                      <input type="number" min="0" max={quote.due} step="0.01" value={form.amount} disabled={quote.walkIn} onChange={set("amount")} />
                    </Field>
                  )}
                  {form.method === "voucher" && !sale?.contact_id && (
                    <>
                      <Field label="Name on the voucher (optional)"><input maxLength={150} value={form.name} onChange={set("name")} /></Field>
                      <Field label="Phone (optional)"><input maxLength={30} inputMode="tel" value={form.phone} onChange={set("phone")} /></Field>
                    </>
                  )}
                  {form.method !== "voucher" && <Field label="Reference (optional)"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>}
                </>
              )}
              {refundBlocked && <p className="field-wide fe-warn"><Icon name="lock" size={15} /> Giving money back needs the refund permission. Give a credit voucher, or ask a manager.</p>}
            </>
          )}
        </>
      )}
      {swap && (
        <VariantPicker biz={biz} locationId={form.locationId} initialProduct={swap.product} onClose={() => setSwap(null)}
          title={`Swap: ${swap.product.name}`} description="Tap the size and colour going out. The piece coming back is ticked for you."
          onPick={(variant) => (swap.line ? swapped(variant) : (setOut((all) => [...all, outLine({ id: variant.sku_id, label: variant.label, price: variant.price, tracking: variant.tracking })]), setSwap(null), stale()))} />
      )}
    </FormDialog>
  );
}

function ExchangeDetail({ exchangeId, onClose }) {
  const biz = useOpenBusiness();
  const [x, setX] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `exchanges/${exchangeId}`, undefined, controller.signal).then(setX).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, exchangeId]);
  const print = (paper) => printBill(biz, x.new_document_id, paper).catch((e) => toast.error(getErrorMessage(e)));
  return (
    <Modal title={x ? `Exchange on ${x.original_no}` : "Exchange"} icon="refresh" width={820} onClose={onClose}
      description={x ? `${x.customer_name || "Walk-in customer"} · ${x.location_name} · ${dateTime(x.created_at)} · by ${x.created_by_name}${x.no_bill ? " · no bill" : ""}` : undefined}>
      <ErrorMessage message={error} />
      {!x && !error && <Loading />}
      {x && (
        <div className="stack">
          <div className="bz-totals">
            <span>Credit note <strong className="mono">{x.return_no}</strong></span>
            <span>New bill <strong className="mono">{x.new_no}</strong></span>
            <span>Came back <strong>{biz.exact(x.returned_value)}</strong></span>
            <span>Went out <strong>{biz.exact(x.new_value)}</strong></span>
            <span>Credit used <strong>{biz.exact(x.credit_applied)}</strong></span>
            <span>{settledText(x, biz)}</span>
          </div>
          {x.voucher && (
            <p className="fe-policy"><Icon name="receipt" size={16} /> Voucher <strong className="mono">{x.voucher.voucher_no}</strong> for {biz.exact(x.voucher.amount)}, valid until {dateShort(x.voucher.expires_on, { year: true })}{Number(x.voucher.used) > 0 ? ` · ${biz.exact(x.voucher.used)} used` : ""}.</p>
          )}
          <DataGrid variant="compact" id="exchange-back" caption="Came back" rows={x.returnedLines} rowKey={(l, i) => `b${i}`} currency={biz.symbol} columns={[
            { key: "label", header: "Came back", value: (l) => l.label, mobile: "title", render: (l) => <span className="bz-two-line"><span>{l.label}</span>{l.lot_code && <small className="muted mono">{l.lot_code}</small>}</span> },
            { key: "quantity", header: "Qty", type: "number", value: (l) => Number(l.quantity) },
            { key: "value", header: "Value", type: "money", exact: true, value: (l) => Number(l.net) + Number(l.tax), total: "sum" },
            { key: "restock", header: "To stock", value: (l) => (l.restock ? "Yes" : "No"), render: (l) => <Badge status={l.restock ? "active" : "inactive"} label={l.restock ? "Back in stock" : "Not restocked"} /> },
          ]} />
          <DataGrid variant="compact" id="exchange-out" caption="Went out" rows={x.newLines} rowKey={(l, i) => `o${i}`} currency={biz.symbol} columns={[
            { key: "label", header: "Went out", value: (l) => l.label, mobile: "title", render: (l) => <span className="bz-two-line"><span>{l.label}</span>{l.lot_code && <small className="muted mono">{l.lot_code}</small>}</span> },
            { key: "quantity", header: "Qty", type: "number", value: (l) => Number(l.quantity) },
            { key: "value", header: "Value", type: "money", exact: true, value: (l) => Number(l.net) + Number(l.tax), total: "sum" },
          ]} />
          <p className="muted small">Reason: {x.reason}</p>
          <div className="form-actions bz-start">
            <button type="button" className="button" onClick={() => print("80mm")}><Icon name="print" size={15} /> Print new bill</button>
            <button type="button" className="button button-secondary" onClick={() => print("a4")}>A4 invoice</button>
            {x.voucher && <button type="button" className="button button-secondary" onClick={() => printVoucherById(biz, x.voucher.id).catch((e) => toast.error(getErrorMessage(e)))}><Icon name="receipt" size={15} /> Print voucher</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}
