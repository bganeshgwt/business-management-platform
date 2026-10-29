import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { dateShort } from "@bmp/shared/format";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useDirtyGuard, useOpenBusiness } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { printTaxInvoice } from "../../core/pages/invoice";
import { SCHEME_STAGES, grams, perGram, readTags } from "./jewellery";
import { OldGoldForm } from "./OldGoldDialogs";
import "../styles/jewellery.css";
import { NewCustomerConsents } from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";

// The jewellery bill: the counter's screen for tagged pieces. Scan or type a
// tag (or a HUID): each piece is priced by the server at the latest rate of
// the day for its purity (metal, wastage, making, stones, hallmarking, then
// 3% GST) and the HUID check is made; a piece that cannot be billed says why.
// The customer (found, typed new, or a walk-in who pays in full); what is
// theirs that pays first: a gold scheme it redeems (with its discount off the
// pieces when it has one), the credit left on their returned jewellery bills,
// and the old gold they brought in (or take in here); the payments for the
// rest (one or several); and the buyer's PAN or a Form 97 declaration on a
// bill over ₹2,00,000. Posted as an ordinary sale, so cash is limited as on
// every bill; the invoice prints what BIS asks for each article. Opened from a
// custom order that is ready (?order=…) it delivers the order: its pieces at
// the rate fixed on it for the grams fixed and today's for the rest, its
// advances paying first; from an approval challan (?approval=…&tags=…) it
// sells the pieces the customer keeps. Loose stones and coins go on the same
// bill as lines of their own, at their catalogue prices and GST slabs. The
// shop's best offer on making running today comes off each piece by itself; a
// discount at the counter (by someone who may give one, with why) comes off
// the pieces' making and wastage (and the metal only where Jewellery settings
// allow it), within the business's most discount on a bill. Each prints as
// such on the invoice.

const PAY_KINDS = ["cash", "upi", "card", "bank", "cheque"];
let seq = 0;
const blankPart = (method = "upi") => ({ key: `p${(seq += 1)}`, method, amount: "" });
const itemLine = (sku) => ({ key: `i${(seq += 1)}`, skuId: sku.id, label: sku.label, tracking: sku.tracking, quantity: "1", lotCode: "" });

export default function JewelleryBillPage() {
  const biz = useOpenBusiness();
  const methods = usePaymentMethods();
  const locations = biz.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""));
  const [customer, setCustomer] = useState(null);
  const [typedCustomer, setTypedCustomer] = useState(null);
  const [tags, setTags] = useState([]);
  const [scan, setScan] = useState("");
  const [quote, setQuote] = useState(null);
  const [parts, setParts] = useState([blankPart()]);
  const [pan, setPan] = useState("");
  const [declared, setDeclared] = useState(false);
  const [notes, setNotes] = useState("");
  const [requestKey, setRequestKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState(null);
  // The posted bill opened as a sale (its lines, payments, returns), on request.
  const [docOpen, setDocOpen] = useState(false);
  // The customer's old gold: their vouchers with value left, those on this bill, and taking more in.
  const [vouchers, setVouchers] = useState([]);
  const [oldGold, setOldGold] = useState([]);
  const [taking, setTaking] = useState(false);
  const [settings, setSettings] = useState(null);
  // Their gold schemes not yet redeemed and the one this bill redeems; the credit on their returned bills and the ones used here.
  const [schemes, setSchemes] = useState([]);
  const [scheme, setScheme] = useState("");
  const [creditList, setCreditList] = useState([]);
  const [credits, setCredits] = useState([]);
  const [params, setParams] = useSearchParams();
  // A custom order the bill delivers (?order=…), or an approval challan it sells from (?approval=…&tags=…): their customer is the bill's.
  const [order, setOrder] = useState(null);
  const [approval, setApproval] = useState(null);
  // Loose stones and coins, and a discount at the counter.
  const [items, setItems] = useState([]);
  const [discount, setDiscount] = useState({ amount: "", reason: "" });
  const canDiscount = biz.can("sales.discount");
  const scanRef = useRef(null);
  const canPay = biz.can("sales.edit");
  const canOldGold = canPay && biz.can("jewellery.view");
  useDirtyGuard(tags.length > 0 && !posted);
  useEffect(() => {
    if (!canOldGold) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/settings", undefined, controller.signal).then(setSettings).catch(() => {});
    return () => controller.abort();
  }, [biz.id, canOldGold]);
  useEffect(() => {
    if (!canOldGold || !customer?.id) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/old-gold", { contact: customer.id, state: "open", limit: 20 }, controller.signal)
      .then((page) => setVouchers(page.items)).catch(() => setVouchers([]));
    businessRead(biz.id, "jewellery/schemes", { contact: customer.id, limit: 20 }, controller.signal)
      .then((page) => setSchemes(page.items.filter((s) => s.status !== "redeemed"))).catch(() => setSchemes([]));
    businessRead(biz.id, "jewellery/bills/credits", { contact: customer.id }, controller.signal).then((page) => setCreditList(page.items)).catch(() => setCreditList([]));
    return () => controller.abort();
  }, [biz.id, canOldGold, customer?.id, taking]);
  const shownVouchers = customer?.id ? vouchers.filter((g) => String(g.contact_id) === String(customer.id)) : [];
  const shownSchemes = customer?.id ? schemes.filter((s) => String(s.contact_id) === String(customer.id)) : [];
  const shownCredits = customer?.id ? creditList : [];
  // Opened from a scheme's panel (?scheme=…): its member is the customer and it is redeemed here.
  const fromOrder = params.get("order");
  const fromApproval = params.get("approval");
  const approvalTags = params.get("tags");
  useEffect(() => {
    if (!fromOrder) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/orders/${fromOrder}`, undefined, controller.signal).then((o) => {
      setOrder(o);
      setCustomer({ id: o.contact_id, name: o.customer_name, phone: o.customer_phone });
      setTags(o.made.filter((p) => p.status === "in_stock").map((p) => p.tag_no));
    }).catch((err) => { if (!controller.signal.aborted) toast.error(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, fromOrder]);
  useEffect(() => {
    if (!fromApproval) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/approvals/${fromApproval}`, undefined, controller.signal).then((a) => {
      setApproval(a);
      setCustomer({ id: a.contact_id, name: a.party_name, phone: a.party_phone });
      const out = a.lines.filter((l) => l.outcome === "out").map((l) => l.tag_no);
      const wanted = readTags(approvalTags);
      setTags(wanted.length ? out.filter((t) => wanted.includes(t)) : out);
    }).catch((err) => { if (!controller.signal.aborted) toast.error(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, fromApproval, approvalTags]);
  const fromScheme = params.get("scheme");
  useEffect(() => {
    if (!fromScheme || !canOldGold) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/schemes/${fromScheme}`, undefined, controller.signal).then((s) => {
      setCustomer({ id: s.contact_id, name: s.member_name, phone: s.member_phone });
      setScheme(String(s.id));
    }).catch((err) => { if (!controller.signal.aborted) toast.error(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, fromScheme, canOldGold]);

  // Every change asks the server for the bill as it would be posted now.
  const itemsBody = useMemo(() => items.filter((i) => Number(i.quantity) > 0).map((i) => ({ skuId: i.skuId, quantity: i.quantity, ...(i.lotCode.trim() ? { lotCode: i.lotCode.trim() } : {}) })), [items]);
  const discountBody = Number(discount.amount) > 0 && discount.reason.trim() ? { amount: discount.amount, reason: discount.reason.trim() } : null;
  const discountKey = discountBody ? `${discountBody.amount}|${discountBody.reason}` : "";
  const payload = useMemo(() => ((tags.length || itemsBody.length) && locationId ? JSON.stringify({ locationId, tags, ...(itemsBody.length ? { items: itemsBody } : {}),
    ...(customer ? { contactId: customer.id } : {}), ...(order ? { order: order.id } : {}), ...(approval ? { approval: approval.id } : {}),
    ...(scheme ? { scheme } : {}), ...(credits.length ? { credits } : {}), ...(oldGold.length ? { oldGold } : {}),
    ...(discountKey ? { discount: { amount: discountKey.split("|")[0], reason: discountKey.slice(discountKey.indexOf("|") + 1) } } : {}) }) : null),
  [tags, itemsBody, locationId, customer, order, approval, scheme, credits, oldGold, discountKey]);
  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "jewellery/bills/preview", JSON.parse(payload))
        .then((data) => setQuote({ payload, data, error: "" }))
        .catch((err) => setQuote({ payload, data: null, error: getErrorMessage(err) }));
    }, 200);
    return () => clearTimeout(timer);
  }, [biz.id, payload]);
  const figures = payload && quote?.payload === payload ? quote.data : null;
  const problem = payload && quote?.payload === payload ? quote.error : "";
  // A customer with a PAN saved brings it to the bill; another customer's old gold leaves it.
  const chooseCustomer = (next) => { setCustomer(next); setOldGold([]); setScheme(""); setCredits([]); if (next?.pan) setPan(next.pan); };
  const toggleCredit = (documentId) => setCredits((all) => (all.includes(String(documentId)) ? all.filter((x) => x !== String(documentId)) : [...all, String(documentId)]));
  const toggleOldGold = (voucherId) => setOldGold((all) => (all.includes(String(voucherId)) ? all.filter((x) => x !== String(voucherId)) : [...all, String(voucherId)]));
  // Old gold taken in here: its seller is the bill's customer, and it pays this bill.
  const tookIn = (g) => {
    setTaking(false);
    const same = customer && String(customer.id) === String(g.contact_id);
    if (!same) { setCustomer({ id: g.contact_id, name: g.seller_name, phone: g.seller_phone, pan: g.pan }); setTypedCustomer(null); setScheme(""); setCredits([]); }
    if (g.pan) setPan(g.pan);
    setOldGold((all) => (same ? [...all, String(g.id)] : [String(g.id)]));
  };

  // A tag or a HUID: the piece's own tag goes on the bill.
  const addScan = async (event) => {
    event.preventDefault();
    const code = scan.trim().toUpperCase();
    if (!code) return;
    setScan("");
    try {
      const piece = await businessRead(biz.id, "jewellery/pieces/find", { code });
      if (tags.includes(piece.tag_no)) toast.info(`Piece ${piece.tag_no} is on the bill already.`);
      else setTags((all) => [...all, piece.tag_no]);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
    scanRef.current?.focus();
  };
  const reset = () => {
    setTags([]); setCustomer(null); setTypedCustomer(null); setQuote(null); setParts([blankPart()]); setPan(""); setDeclared(false); setNotes("");
    setOldGold([]); setVouchers([]); setScheme(""); setSchemes([]); setCredits([]); setCreditList([]); setRequestKey(newKey()); setPosted(null); setDocOpen(false); setError("");
    setOrder(null); setApproval(null); setItems([]); setDiscount({ amount: "", reason: "" });
    if (fromOrder || fromApproval) setParams(new URLSearchParams(), { replace: true });
  };
  // What is left to pay after the scheme, the credit and the old gold.
  const toPay = Number(figures?.toPay ?? figures?.total ?? 0);
  const fixedPaid = parts.filter((p) => p.amount !== "").reduce((s, p) => s + Number(p.amount || 0), 0);
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!figures || figures.problems.length) return setError(figures?.problems[0] || "Add the pieces to the bill");
    if (canPay && !parts.some((p) => p.amount === "") && fixedPaid > toPay + 0.004) return setError(`The payments come to more than the ${biz.exact(toPay)} to pay`);
    setBusy(true);
    try {
      // An empty amount on a part is "the rest of the bill".
      const payments = canPay && toPay > 0 ? parts.map((p) => ({ ...methods.body(p.method, PAY_KINDS), amount: p.amount === "" ? "full" : p.amount })) : [];
      const bill = await businessWrite(biz.id, "jewellery/bills", {
        requestKey, locationId, tags, ...(itemsBody.length ? { items: itemsBody } : {}), ...(discountBody ? { discount: discountBody } : {}), ...(customer ? { contactId: customer.id } : typedCustomer?.name?.trim() ? { customer: { name: typedCustomer.name.trim(), phone: typedCustomer.phone?.trim() || undefined,
          consents: consentChanges(typedCustomer.consents, []) || undefined } } : {}),
        ...(order ? { order: order.id } : {}), ...(approval ? { approval: approval.id } : {}),
        ...(scheme ? { scheme } : {}), ...(credits.length ? { credits } : {}), ...(oldGold.length ? { oldGold } : {}), ...(payments.length ? { payments } : {}), ...(figures.panNeeded ? { buyer: declared ? { panDeclaration: true } : { pan: pan.trim() } } : {}),
        notes: notes.trim() || undefined,
      });
      setPosted(bill);
      toast.success(`Bill ${bill.document_no} posted: ${biz.exact(bill.total)}.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const print = async (paper) => {
    try {
      const doc = await businessRead(biz.id, `documents/${posted.document_id}`);
      printTaxInvoice(doc, biz, { paper, ...(posted.change ? { change: posted.change } : {}) });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  if (posted) {
    return (
      <div className="stack">
        <BusinessHeader icon="receipt" title="Jewellery bill" description={`Bill ${posted.document_no} for ${posted.contact_name || "a walk-in customer"}: ${biz.exact(posted.total)}.`}
          primary={<button type="button" className="button" onClick={reset}><Icon name="plus" size={16} /> Next bill</button>} />
        <SectionCard icon="check" title={`Bill ${posted.document_no} posted`} description={posted.change ? `Change to give back: ${biz.exact(posted.change)}.` : undefined}>
          <div className="form-actions jw-left">
            {biz.can("sales.print") && <button type="button" className="button" onClick={() => print("a4")}><Icon name="print" size={16} /> Print the invoice</button>}
            {biz.can("sales.print") && <button type="button" className="button button-secondary" onClick={() => print("80mm")}>Till receipt</button>}
            <button type="button" className="button button-secondary" onClick={() => setDocOpen(true)}><Icon name="file" size={15} /> Open the bill</button>
          </div>
        </SectionCard>
        {docOpen && <DocumentDetail documentId={posted.document_id} onClose={() => setDocOpen(false)} onChanged={() => {}} />}
      </div>
    );
  }
  return (
    <>
      <form className="stack" onSubmit={submit}>
        <BusinessHeader icon="receipt" title="Jewellery bill"
          description="Scan or type each piece's tag or HUID. Each is priced at today's rate for its purity, with its wastage, making, stones and hallmarking, then 3% GST."
          secondary={<>
            {biz.can("sales.view") && <Link className="button button-secondary" to={biz.path("gold-rates")}><Icon name="tag" size={15} /> Today's rates</Link>}
            <Link className="button button-secondary" to={biz.path("pieces")}><Icon name="list" size={15} /> Pieces & tags</Link>
          </>} />
        {(order || approval) && (
          <SectionCard icon="clipboard" title={order ? `Custom order ${order.order_no}` : `Approval challan ${approval.approval_no}`}
            description={order ? (order.fixed_rate ? `${grams(order.fixed_weight)} fixed at ${perGram(biz, order.fixed_rate)} on its advance (bhav cut): those grams are priced at it, the rest at today's rate. Its advances pay first.` : "Priced at today's rate; its advances pay first.")
              : `Pieces sold from the challan come back from ${approval.party_name} and are billed to them; the rest stay out on it.`} />
        )}
        <SectionCard icon="user" title="Customer">
          <div className="jw-row">
            {order || approval ? (
              <Field label={order ? "The order's customer" : "The challan's customer"}><input readOnly value={customer?.name || ""} /></Field>
            ) : typedCustomer ? (
              <>
                <Field label="Name"><input required maxLength={150} autoFocus value={typedCustomer.name} onChange={(e) => setTypedCustomer((c) => ({ ...c, name: e.target.value }))} /></Field>
                <Field label="Phone"><input inputMode="tel" maxLength={30} value={typedCustomer.phone} onChange={(e) => setTypedCustomer((c) => ({ ...c, phone: e.target.value }))} /></Field>
                <NewCustomerConsents value={typedCustomer.consents} onChange={(consents) => setTypedCustomer((c) => ({ ...c, consents }))} />
                <button type="button" className="link-button" onClick={() => setTypedCustomer(null)}>Find a customer instead</button>
              </>
            ) : (
              <>
                <div className="field jw-grow">
                  <SearchPicker label="Customer (empty: a walk-in, who pays in full)" placeholder="Name or phone" value={customer} onChange={chooseCustomer} minChars={2}
                    search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
                    getLabel={(x) => x.name} getDescription={(x) => x.phone || ""} />
                </div>
                {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setCustomer(null); setTypedCustomer({ name: "", phone: "" }); }}><Icon name="user-plus" size={15} /> New customer</button>}
              </>
            )}
            {locations.length > 1 && <Field label="Billed at"><select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
          </div>
        </SectionCard>
        {canOldGold && shownSchemes.length > 0 && (
          <SectionCard icon="calendar" title="Gold scheme" description="A scheme the bill redeems pays all that was paid into it, with its discount off the pieces when every instalment is paid and it has matured.">
            <ul className="jw-og-choices">
              <li><label className="checkbox bz-check"><input type="radio" name="jw-scheme" checked={!scheme} onChange={() => setScheme("")} /> <span>No scheme on this bill</span></label></li>
              {shownSchemes.map((s) => (
                <li key={s.id}>
                  <label className="checkbox bz-check"><input type="radio" name="jw-scheme" checked={scheme === String(s.id)} onChange={() => setScheme(String(s.id))} />
                    <span><span className="mono">{s.scheme_no}</span> · {s.plan_name} · {biz.exact(s.paid)} paid ({s.paid_count} of {s.instalments}) · {SCHEME_STAGES[s.stage]?.label || s.stage}
                      {scheme === String(s.id) && figures?.scheme ? ` · discount ${biz.exact(figures.scheme.discount)}` : ""}</span></label>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}
        {canOldGold && shownCredits.length > 0 && (
          <SectionCard icon="receipt" title="Credit from returned bills" description="What is left of the customer's returned jewellery bills pays this one.">
            <ul className="jw-og-choices">{shownCredits.map((x) => {
              const pays = figures?.credits?.find((u) => String(u.documentId) === String(x.documentId));
              return (
                <li key={x.documentId}>
                  <label className="checkbox bz-check"><input type="checkbox" checked={credits.includes(String(x.documentId))} onChange={() => toggleCredit(x.documentId)} />
                    <span><span className="mono">{x.documentNo}</span> · {biz.exact(x.credit)} credit{pays && Number(pays.amount) > 0 ? ` · pays ${biz.exact(pays.amount)} of this bill` : ""}</span></label>
                </li>
              );
            })}</ul>
          </SectionCard>
        )}
        {canOldGold && (
          <SectionCard icon="scale" title="Old gold" description="Old gold the customer brought in pays first; the money taken is what is left."
            actions={biz.can("jewellery.create") && <button type="button" className="button button-secondary" disabled={!settings} onClick={() => setTaking(true)}><Icon name="plus" size={15} /> Take in old gold</button>}>
            {shownVouchers.length === 0 ? (
              <p className="jw-note">{customer ? `${customer.name} has no old gold with value left.` : "Choose the customer to use the old gold they brought in, or take it in here."}</p>
            ) : (
              <ul className="jw-og-choices">{shownVouchers.map((g) => {
                const pays = figures?.oldGold?.find((u) => String(u.id) === String(g.id));
                return (
                  <li key={g.id}>
                    <label className="checkbox bz-check"><input type="checkbox" checked={oldGold.includes(String(g.id))} onChange={() => toggleOldGold(g.id)} />
                      <span><span className="mono">{g.voucher_no}</span> · {grams(g.net_weight)} · {biz.exact(g.balance)} left{pays && Number(pays.amount) > 0 ? ` · pays ${biz.exact(pays.amount)} of this bill` : ""}</span></label>
                  </li>
                );
              })}</ul>
            )}
          </SectionCard>
        )}
        <SectionCard icon="tag" title="Pieces" description={figures ? `Rates of ${dateShort(figures.day, { year: true })}${figures.rules?.mandatory ? "; this location is under mandatory hallmarking" : "; this location is not under mandatory hallmarking"}${figures.rules?.turnoverExempt ? " (the business is exempt by its turnover)" : ""}.` : undefined}>
          <div className="jw-row">
            <div className="field jw-grow">
              <span>Tag or HUID</span>
              <span className="jw-scan">
                <input ref={scanRef} autoFocus className="mono" value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addScan(e); }} placeholder="Scan or type, then Enter" aria-label="Tag or HUID" />
                <button type="button" className="button button-secondary" onClick={addScan}><Icon name="plus" size={15} /> Add</button>
              </span>
            </div>
          </div>
          {tags.length === 0 ? <p className="jw-note">No pieces yet.</p> : (
            <div className="jw-bill-lines">
              {(figures?.lines || tags.map((tag) => ({ tag }))).map((l) => (
                <div key={l.tag} className={`jw-bill-line ${l.problem ? "is-problem" : ""}`}>
                  <div className="jw-bill-line-head">
                    <span className="mono"><strong>{l.tag}</strong></span>
                    <span>{l.description || ""}{l.mark ? ` · ${l.mark}` : ""}</span>
                    {l.total && <strong className="jw-bill-amount">{biz.exact(l.total)}</strong>}
                    <button type="button" className="link-button danger" onClick={() => setTags((all) => all.filter((t) => t !== l.tag))}>Remove</button>
                  </div>
                  {l.problem ? <p className="bz-due small" role="alert">{l.problem}</p> : l.rate ? (
                    <div className="jw-bill-build">
                      <span>Net {grams(l.netWeight)} <small className="muted">(gross {grams(l.grossWeight)}{Number(l.stoneWeight) ? `, stones ${grams(l.stoneWeight)}` : ""})</small></span>
                      <span>{l.purityLong}</span>
                      <span>Metal {biz.exact(l.metalValue)} <small className="muted">at {perGram(biz, l.rate)}{Number(l.fixedWeight) > 0 ? `; ${grams(l.fixedWeight)} of it at ${perGram(biz, l.fixedRate)}, fixed on the order` : ""}</small></span>
                      {Number(l.wastage) > 0 && <span>Wastage {Number(l.wastagePercent)}% ({grams(l.wastageWeight)}) {biz.exact(l.wastage)}</span>}
                      <span>Making {biz.exact(l.making)}</span>
                      {Number(l.stoneValue) > 0 && <span>Stones {biz.exact(l.stoneValue)}</span>}
                      {l.hallmarked && <span>Hallmarking {biz.exact(l.hallmarkCharge)}</span>}
                      <span>{l.huids?.length ? `HUID ${l.huids.join(", ")}` : l.basisWords}</span>
                      {Number(l.offerDiscount) > 0 && <span>{l.offer.name}: {Number(l.offer.makingPercent)}% off making {biz.exact(l.offerDiscount)}</span>}
                      {Number(l.counterDiscount) > 0 && <span>Counter discount {biz.exact(l.counterDiscount)}</span>}
                      {Number(l.schemeDiscount) > 0 && <span>Scheme discount {biz.exact(l.schemeDiscount)}</span>}
                      <span>Before GST {biz.exact(l.taxable)} · GST 3% {biz.exact(l.tax)}</span>
                    </div>
                  ) : <p className="muted small">Pricing…</p>}
                </div>
              ))}
            </div>
          )}
          {problem && <p className="bz-due small" role="alert">{problem}</p>}
        </SectionCard>
        <SectionCard icon="box" title="Loose stones and coins" description="Catalogue goods that are not tagged pieces: each at its own price and GST slab (a loose diamond at 0.25%, a coin at 3%).">
          <SearchPicker aria-label="Find a loose stone or coin" placeholder="Type a name or code" clearOnSelect minChars={2}
            search={(q, { signal }) => businessRead(biz.id, "catalog", { q, limit: 15, kind: "goods", active: "true" }, signal).then((page) => page.items)}
            getLabel={(s) => s.label} getDescription={(s) => `${s.code} · ${biz.exact(s.price)} · GST ${Number(s.tax_rate)}%`}
            onChange={(s) => { if (s) setItems((all) => [...all, itemLine(s)]); }} />
          {items.length > 0 && (
            <table className="jw-rates">
              <thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Batch or serial</th><th scope="col">GST</th><th scope="col">Amount</th><th scope="col">Action</th></tr></thead>
              <tbody>{items.map((i, index) => {
                const priced = figures?.items?.[index];
                return (
                  <tr key={i.key}>
                    <th scope="row">{i.label}{priced?.problem && <small className="bz-due bz-two-line" role="alert">{priced.problem}</small>}</th>
                    <td><input type="number" min="0.001" step="0.001" aria-label={`${i.label}: quantity`} value={i.quantity} onChange={(e) => setItems((all) => all.map((x) => (x.key === i.key ? { ...x, quantity: e.target.value } : x)))} /></td>
                    <td>{i.tracking !== "none" && i.tracking !== "quantity" ? <input className="mono" maxLength={100} aria-label={`${i.label}: batch or serial number`} value={i.lotCode}
                      onChange={(e) => setItems((all) => all.map((x) => (x.key === i.key ? { ...x, lotCode: e.target.value } : x)))} /> : <span className="muted">—</span>}</td>
                    <td>{priced?.taxRate ? `${Number(priced.taxRate)}%` : ""}</td>
                    <td>{priced && !priced.problem ? biz.exact(priced.total) : ""}</td>
                    <td><button type="button" className="link-button danger" onClick={() => setItems((all) => all.filter((x) => x.key !== i.key))}>Remove</button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </SectionCard>
        {canDiscount && tags.length > 0 && (
          <SectionCard icon="percent" title="Discount at the counter" description={`Off the pieces' making and wastage${figures?.discountOnMetal ? " and metal" : " (never the metal's value)"}, within the business's most discount on a bill; printed as a discount on the invoice.`}>
            <div className="jw-row">
              <Field label="Discount before GST (₹)"><input type="number" min="0" step="0.01" value={discount.amount} onChange={(e) => setDiscount((d) => ({ ...d, amount: e.target.value }))} /></Field>
              <Field label="Why"><input maxLength={300} required={Number(discount.amount) > 0} value={discount.reason} onChange={(e) => setDiscount((d) => ({ ...d, reason: e.target.value }))} placeholder="e.g. Regular customer" /></Field>
            </div>
          </SectionCard>
        )}
        {figures && !figures.problems.length && (
          <SectionCard icon="wallet" title="Money">
            <div className="jw-totals">
              <span>Before GST {biz.exact(figures.subtotal)}</span><span>GST {biz.exact(figures.tax)}</span>
              {Number(figures.roundOff) !== 0 && <span>Round-off {biz.exact(figures.roundOff)}</span>}
              <strong>Total {biz.exact(figures.total)}</strong>
              {Number(figures.offerDiscount) > 0 && <span>Offers {biz.exact(figures.offerDiscount)} off making</span>}
              {Number(figures.counterDiscount) > 0 && <span>Counter discount {biz.exact(figures.counterDiscount)}</span>}
              {Number(figures.schemeDiscount) > 0 && <span>Scheme discount {biz.exact(figures.schemeDiscount)} (taken off before GST)</span>}
              {Number(figures.schemePaid) > 0 && <span>Gold scheme {biz.exact(figures.schemePaid)}</span>}
              {(figures.credits || []).some((x) => Number(x.amount) > 0) && <span>Credit {biz.exact(figures.credits.reduce((s, x) => s + Number(x.amount), 0))}</span>}
              {Number(figures.orderPaid) > 0 && <span>Order advances {biz.exact(figures.orderPaid)}</span>}
              {Number(figures.oldGoldPaid) > 0 && <span>Old gold {biz.exact(figures.oldGoldPaid)}</span>}
              {Number(figures.paidBefore) > 0 && <strong>To pay {biz.exact(figures.toPay)}</strong>}
            </div>
            {canPay && toPay > 0 && (
              <div className="jw-parts">
                {parts.map((p, index) => (
                  <div key={p.key} className="jw-row">
                    <Field label={index === 0 ? "Paid by" : "And by"}>
                      <select value={methods.resolve(p.method, PAY_KINDS)} onChange={(e) => setParts((all) => all.map((x) => (x.key === p.key ? { ...x, method: e.target.value } : x)))}>
                        {methods.options(PAY_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Amount" hint={p.amount === "" ? "Empty: the rest of the bill." : undefined}>
                      <input type="number" min="0.01" step="0.01" value={p.amount} onChange={(e) => setParts((all) => all.map((x) => (x.key === p.key ? { ...x, amount: e.target.value } : x)))} />
                    </Field>
                    {parts.length > 1 && <button type="button" className="link-button danger" onClick={() => setParts((all) => all.filter((x) => x.key !== p.key))}>Remove</button>}
                  </div>
                ))}
                {parts.length < 4 && <button type="button" className="chip-button" onClick={() => setParts((all) => [...all, blankPart("cash")])}><Icon name="plus" size={13} /> Another payment</button>}
                <p className="muted small">Cash of ₹2,00,000 or more cannot be taken for one bill, or from one customer in a day (Income-tax Act 2025, section 186): take the rest by UPI, card, bank transfer or cheque. Leave the amount empty on one payment for the rest of the bill; paying less leaves the rest on the customer's dues.</p>
              </div>
            )}
            {figures.panNeeded && (
              <fieldset className="jw-row jw-pan">
                <legend>A bill over ₹2,00,000 records the buyer's PAN</legend>
                {!declared && <Field label="Buyer's PAN"><input required maxLength={10} className="mono" value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} placeholder="ABCDE1234F" /></Field>}
                <label className="checkbox bz-check"><input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} /> The buyer has no PAN and signed a declaration (Form 97)</label>
              </fieldset>
            )}
            <Field label="Notes (optional)" wide><input maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </SectionCard>
        )}
        <ErrorMessage message={error} />
        <div className="form-actions">
          {tags.length > 0 && <button type="button" className="button button-secondary" disabled={busy} onClick={reset}>Clear</button>}
          <button type="submit" className="button" disabled={busy || !figures || figures.problems.length > 0}><Icon name="check" size={16} /> {busy ? "Posting…" : figures ? `Post the bill · ${biz.exact(figures.total)}` : "Post the bill"}</button>
        </div>
      </form>
      {/* Outside the bill's form: the dialog's own form is not part of the bill's. */}
      {taking && <OldGoldForm biz={biz} settings={settings} contact={customer} onClose={() => setTaking(false)} onSaved={tookIn} />}
    </>
  );
}
