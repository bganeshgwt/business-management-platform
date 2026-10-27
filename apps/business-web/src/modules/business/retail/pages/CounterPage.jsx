import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import Modal from "../../../../components/Modal";
import ActionMenu from "../../../../components/ActionMenu";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { businessToday, newKey, quantity as qtyText, useDirtyGuard, useOpenBusiness } from "../../core/pages/hooks";
import { methodWord, paymentWord, printReceipt } from "./retail";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { CustomerBox, PayBar, PhoneLines, ReturnFinder, VariantPicker } from "./counterParts";
import { BillerButton, BillerDialog, FinanceFields } from "./counterPay";
import { emptyFinance, financeBody, financeReady, partsSummary, takeCarry, writeCarry } from "./counterPayState";
import useAuth from "../../../../hooks/useAuth";
import { toast } from "../../../../services/toast";
import useConfirm from "../../../../hooks/useConfirm";
import { HELD_LIMIT, readHeld, readLast, udhaarRisk, useCustomerAccount, useNarrow, writeHeld, writeLast } from "./counterState";
import "../styles/business-retail.css";
import "../styles/counter-layout.css";
import CounterShelf from "./counterShelf";
import ShiftButton from "./counterShift";
// Cut to order and orders for pickup at a meat / weight shop.
import CounterWeightTools from "../../weight/pages/CounterWeightTools";
// A hardware shop's bill goes to one of the customer's sites.
import SiteField from "../../hardware/pages/SiteField";
import { usesFitters, usesSites } from "../../hardware/pages/hardware";
// A hardware shop's bill may name the fitter who brought the customer.
import FitterField from "../../hardware/pages/FitterField";
// A hardware shop's tile and paint calculator adds what an area needs.
import CalculatorDialog from "../../hardware/pages/CalculatorDialog";
import { usesCalculators } from "../../hardware/pages/calculators";
// A farm-input shop's bill: the PoS receipt, the crop, a walk-in farmer and season credit.
import AgriBillFields from "../../agri/pages/AgriBillFields";
import { agriBillBody, agriNeedsOf, agriProblem, emptyAgriBill, useMolecules, usesAgri } from "../../agri/pages/agri";

// Quick bill: the counter of every goods shop (grocery, supermarket, books,
// pharmacy, fashion, electronics, meat and other weight shops). Scan a
// barcode, a weighing-scale label, a book's ISBN or a phone's IMEI, search by
// name, or pick a style's size and colour; pick the customer for udhaar,
// points or a warranty; take cash, UPI or card, or put it on udhaar. Every
// figure is the server's quote — the same calculation that posts the bill —
// so offers, points, the counter discount, GST and round-off are never
// guessed in the browser.
//
// Keys: F2 scan · F4 customer · F6 cash · F7 UPI · F8 card · F9 udhaar ·
// F10 hold the bill · F12 or Ctrl+Enter take the payment ·
// Enter in "Cash received" takes it too. Every F-key has an Alt twin for
// laptops and browsers that keep the F-keys: Alt+S items, Alt+C customer,
// Alt+1 to Alt+4 the payment, Alt+H hold; Ctrl+Enter takes the payment.
// After a bill: Enter or F2 starts the next, P prints.
//
// One payment method per bill (or udhaar, with an optional part paid in cash).
// EMI through a financier (electronics), kits sold as their parts, and the
// shared till's biller switched by PIN (with "PIN for every bill").
// In the search list ↓ / ↑ move and Enter adds the highlighted item.
// A school set's code (bookshops) adds the whole booklist.

// Weigh buttons in grams, put into the line's unit: 250 g is 0.25 on a kg
// line and 250 on a g line. The business sets its own (Business settings ›
// Rules); these are the defaults.
const WEIGHT_STEPS = [250, 500, 1000, 2000];
const kgPerUnit = (sku) => Number(sku?.factor_to_base || 1);
const trim = (n) => String(Number(n.toFixed(3)));
const stepQuantity = (line, grams) => (line.unit === "g" ? String(grams) : trim(grams / 1000 / kgPerUnit(line.sku)));
const isWeighed = (sku) => sku?.unit_kind === "weight";
const isSerial = (sku) => sku?.tracking === "serial";
const lineKey = () => newKey();
const TENDERS = [["cash", "F6"], ["upi", "F7"], ["card", "F8"], ["udhaar", "F9"]];
// The same, as Alt + a number: laptops often send brightness or volume for
// F6–F11 unless Fn is held, and browsers keep some F-keys for themselves
// (F6 address bar, F7 caret browsing, F11 full screen).
const ALT_TENDERS = { Digit1: "cash", Digit2: "upi", Digit3: "card", Digit4: "udhaar" };
const ALT_KEY = { cash: "Alt+1", upi: "Alt+2", card: "Alt+3", udhaar: "Alt+4" };
const TENDER_WORDS = { udhaar: "Udhaar", emi: "EMI" };
// A kit's serial-numbered parts make it one kit per line.
const kitHasSerial = (line) => (line.kit || []).some((c) => c.tracking === "serial");
// Notes a customer hands over: the exact amount and the next round sums above it.
function cashChips(total) {
  if (!(total > 0)) return [];
  const ups = [10, 50, 100, 500].map((step) => Math.ceil(total / step) * step);
  return [...new Set([total, ...ups, 2000].filter((n) => n >= total))].slice(0, 5);
}

export default function CounterPage() {
  const biz = useOpenBusiness();
  const { switchUser } = useAuth();
  // A bill carried over from before the till was switched to this person.
  const [carried] = useState(() => takeCarry(biz.id));
  const confirm = useConfirm();
  const narrow = useNarrow();
  // Only locations that sell at the counter are tills (a warehouse is not);
  // the till chosen is remembered on this device.
  const active = biz.locations.filter((l) => l.active);
  const tills = active.filter((l) => l.sells_at_counter !== false);
  const locations = tills.length ? tills : active;
  const tillKey = `counter-location-${biz.id}`;
  const [locationId, setLocationId] = useState(() => {
    let saved = "";
    try { saved = localStorage.getItem(tillKey) || ""; } catch { /* storage blocked */ }
    return locations.some((l) => String(l.id) === saved) ? saved : String(locations[0]?.id || "");
  });
  const [lines, setLines] = useState(() => carried?.lines || []);
  const [customer, setCustomer] = useState(() => carried?.customer || null);
  const [siteId, setSiteId] = useState("");
  const [fitterId, setFitterId] = useState("");
  const [agriBill, setAgriBill] = useState(emptyAgriBill);
  const agriMaster = useMolecules(biz);
  const [buyer, setBuyer] = useState({ name: "", phone: "", pan: "", panDeclaration: false });
  const [redeem, setRedeem] = useState(() => carried?.redeem || "");
  const [discount, setDiscount] = useState(() => carried?.discount || { mode: "amount", value: "", reason: "" });
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [method, setMethod] = useState("cash");
  // Udhaar asked for before a customer is picked: the customer box is opened
  // and the bill goes on udhaar as soon as they are chosen.
  const [wantUdhaar, setWantUdhaar] = useState(false);
  const chooseTender = (m) => {
    if (!["cash", "upi", "card", "udhaar", "emi"].includes(m)) return;
    if (m === "udhaar" && !customer) {
      setWantUdhaar(true);
      document.getElementById("counter-customer")?.focus();
      return;
    }
    setWantUdhaar(false);
    setMethod(m);
  };
  useEffect(() => {
    if (wantUdhaar && customer) { setMethod("udhaar"); setWantUdhaar(false); }
  }, [wantUdhaar, customer]);
  // The business's own methods (PhonePe, Sodexo…): which one of a kind the
  // cash / UPI / card button takes, when the kind has several.
  const methods = usePaymentMethods();
  const [methodKeys, setMethodKeys] = useState({});
  const [received, setReceived] = useState("");
  const [partPaid, setPartPaid] = useState("");
  const [finance, setFinance] = useState(emptyFinance);
  // "Ask the PIN for every bill": the PIN dialog, and why it was asked again.
  const [askPin, setAskPin] = useState(null);
  const [requestKey, setRequestKey] = useState(newKey);
  const [posting, setPosting] = useState(false);
  // The items the last bill sold: the shelf counts just those again.
  const [sold, setSold] = useState(null);
  const [postError, setPostError] = useState("");
  const [posted, setPosted] = useState(null);
  const [scanError, setScanError] = useState("");
  const [scanTip, setScanTip] = useState("");
  // What is typed in the item box: the shelf below it narrows to match.
  const [shelfQuery, setShelfQuery] = useState("");
  const changeSearch = useCallback((query) => { setShelfQuery(query); setScanError(""); }, []);
  const [held, setHeld] = useState(() => readHeld(biz.id));
  const [picking, setPicking] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [lastOpen, setLastOpen] = useState(null);
  const [returning, setReturning] = useState(false);
  const [returnId, setReturnId] = useState(null);
  // An exchange credit voucher (fashion / electronics) pays first.
  const [voucher, setVoucher] = useState(null);
  const [voucherCode, setVoucherCode] = useState("");
  const [voucherError, setVoucherError] = useState("");
  // A coupon code given by the customer: sent with the quote and the bill; the server checks it.
  const [coupon, setCoupon] = useState("");
  const [couponText, setCouponText] = useState("");
  const scanRef = useRef(null);
  useDirtyGuard(lines.length > 0 && !posted);
  const account = useCustomerAccount(biz, customer);
  const weightTools = useRef(null);

  const canPay = biz.can("sales.edit");
  const canEmi = canPay && biz.has("finance") && biz.can("finance.create");
  const pinEveryBill = Boolean(biz.settings.counter_pin_every_bill);
  const canRedeem = biz.can("loyalty.create");
  const canDiscount = biz.can("sales.discount");
  const fashion = biz.has("variants");
  const warranties = biz.has("warranties");
  const walkInCredit = Boolean(biz.settings.walk_in_credit);
  const scanWords = [biz.has("books") && "ISBN", biz.has("serials") && "IMEI / serial", biz.has("weight") && "scale label"].filter(Boolean);

  const discountBody = canDiscount && Number(discount.value) > 0 && discount.reason.trim()
    ? { discount: { [discount.mode]: discount.value, reason: discount.reason.trim() } } : {};
  // What the server is asked to price: lines with a usable quantity only.
  const payload = useMemo(() => {
    const usable = lines.filter((l) => Number(l.quantity) > 0);
    if (!usable.length || !locationId) return null;
    return JSON.stringify({
      locationId, contactId: customer?.id || null,
      lines: usable.map((l) => ({ skuId: l.sku.id, quantity: l.quantity, ...(l.unit && l.unit !== l.sku.unit ? { unit: l.unit } : {}), ...(l.lotCode ? { lotCode: l.lotCode } : {}),
        ...(l.kit ? { components: l.kit.filter((c) => l.picks?.[c.skuId]).map((c) => ({ skuId: c.skuId, lotCode: l.picks[c.skuId] })) } : {}) })),
      ...(Number(redeem) > 0 ? { loyalty: { redeemPoints: redeem } } : {}),
      ...(coupon ? { coupon } : {}),
      ...discountBody,
    });
    // discountBody is derived from discount; listed through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, customer, redeem, locationId, discount, canDiscount, coupon]);

  useEffect(() => {
    if (!payload) return undefined;
    const timer = setTimeout(() => {
      businessWrite(biz.id, "retail/quote", JSON.parse(payload))
        .then((data) => { setQuote({ payload, data }); setQuoteError(null); })
        .catch((err) => setQuoteError({ payload, message: getErrorMessage(err) }));
    }, 250);
    return () => clearTimeout(timer);
  }, [biz.id, payload]);

  const bill = payload && quote ? quote.data : null;
  const stale = Boolean(payload && quote && quote.payload !== payload);
  const problem = quoteError && quoteError.payload === payload ? quoteError.message : "";
  const total = bill ? Number(bill.total) : 0;
  // The server's line(s) for a bill line: a kit comes back as its parts.
  const quoteLine = (line) => {
    if (!bill) return null;
    const index = lines.filter((l) => Number(l.quantity) > 0).indexOf(line);
    if (index < 0) return null;
    const mine = bill.lines.filter((x, i) => (x.inputIndex ?? i) === index);
    if (mine.length <= 1) return mine[0] || null;
    const add = (key) => mine.reduce((s, x) => s + Number(x[key] || 0), 0);
    return { ...mine[0], unitPrice: (add("net") + add("tax") + add("discount")) / Number(line.quantity || 1), net: add("net"), tax: add("tax"), discount: add("discount"),
      offers: mine.flatMap((x) => x.offers || []), parts: mine };
  };
  const waiting = lines.filter((l) => !(Number(l.quantity) > 0));

  // --- Adding items ---------------------------------------------------------
  function addScanned(result, count = 1) {
    const { sku, lots } = result;
    const many = Number(count) > 0 ? Number(count) : 1;
    setScanError("");
    // A kit: its parts, with a serial chosen for each serial-numbered part.
    if (result.kit) {
      setLines((all) => {
        const taken = new Set(all.flatMap((l) => Object.values(l.picks || {})).concat(all.map((l) => l.lotCode)).filter(Boolean));
        const picks = {};
        for (const part of result.kit.components) {
          if (part.tracking !== "serial") continue;
          const lot = part.lots.find((x) => !taken.has(x.lot_code));
          if (!lot) { setScanError(`No ${part.label} left in stock here for ${sku.label}.`); return all; }
          picks[part.skuId] = lot.lot_code; taken.add(lot.lot_code);
        }
        const serial = result.kit.components.some((c) => c.tracking === "serial");
        const same = !serial && all.find((l) => l.sku.id === sku.id);
        if (same) return all.map((l) => (l === same ? { ...l, quantity: String(Number(l.quantity || 0) + many) } : l));
        return [...all, { key: lineKey(), sku, quantity: serial ? "1" : String(many), lotCode: "", lots: [], kit: result.kit.components, picks }];
      });
      return;
    }
    setLines((all) => {
      const weighed = isWeighed(sku);
      const scaleQuantity = result.quantity !== null && result.quantity !== undefined ? String(result.quantity) : null;
      // A serial unit is its own line: the scanned one, or the next unit not on the bill yet.
      if (isSerial(sku)) {
        const taken = new Set(all.filter((l) => l.sku.id === sku.id).map((l) => l.lotCode));
        const lot = (lots || []).find((l) => !taken.has(l.lot_code));
        if (!lot) { setScanError(result.serial ? `${result.serial} is already on this bill.` : `No more units of ${sku.label} in stock here.`); return all; }
        return [...all, { key: lineKey(), sku, quantity: "1", lotCode: lot.lot_code, lots: [], serial: lot.lot_code }];
      }
      // Earliest expiry first; the next batch takes over once one runs out.
      const lot = lots?.find((l) => Number(l.quantity) > 0);
      const same = all.find((l) => l.sku.id === sku.id && !scaleQuantity && !weighed && (!lot || l.lotCode === lot.lot_code));
      if (same) {
        const next = String(Number(same.quantity || 0) + many);
        const fits = !same.lots?.length || Number(same.lots.find((x) => x.lot_code === same.lotCode)?.quantity || 0) >= Number(next);
        if (fits) return all.map((l) => (l === same ? { ...l, quantity: next } : l));
        const nextLot = same.lots.find((x) => x.lot_code !== same.lotCode && Number(x.quantity) > 0);
        if (nextLot) return [...all, { key: lineKey(), sku, quantity: String(many), lotCode: nextLot.lot_code, lots }];
        return all.map((l) => (l === same ? { ...l, quantity: next } : l));
      }
      // A weighed item waits for its weight (nothing is billed as 1 kg by itself).
      const start = scaleQuantity || (weighed ? (count !== 1 ? String(count) : "") : String(many));
      return [...all, { key: lineKey(), sku, quantity: start, lotCode: lot?.lot_code || "", lots: lots || [], scale: Boolean(scaleQuantity) && !result.fromOrder, focus: weighed && !scaleQuantity }];
    });
  }
  // quiet: the search list has matches, so a code that is not found is not an
  // error (Enter then adds the highlighted match instead).
  async function lookUp(code, { quiet = false } = {}) {
    const text = String(code || "").trim();
    if (!text) return false;
    setScanTip("");
    // A key name typed into the box ("f6") is what the person meant to press:
    // do what the key does, and say how to press it next time.
    const typed = /^f(\d{1,2})$/i.exec(text);
    if (typed) {
      const key = `F${typed[1]}`;
      const tender = { F6: "cash", F7: "upi", F8: "card", F9: "udhaar" }[key];
      if (tender) chooseTender(tender);
      else if (key === "F4") document.getElementById("counter-customer")?.focus();
      setScanError("");
      setScanTip(`${key} is a key at the top of your keyboard: press it instead of typing "${text}".${tender ? ` Payment set to ${TENDER_WORDS[tender] || methods.label(tender)}.` : ""}`);
      return true;
    }
    try {
      const found = await businessRead(biz.id, "retail/scan", { code: text, locationId });
      if (found.set) await addSet(found.set);
      else addScanned(found);
      return true;
    } catch (err) {
      if (quiet) return false;
      // Nothing has that code: say what can be typed or scanned instead.
      setScanError(err?.response?.status === 404
        ? `Nothing matches "${text}". Type at least 2 letters of an item's name to see matches, or scan its barcode${scanWords.length ? `, ${scanWords.join(", ")}` : ""}.`
        : getErrorMessage(err));
      return false;
    }
  }
  // From the tile and paint calculator: each item as if scanned, with its quantity.
  async function addCalculated(picks) {
    setScanError("");
    try {
      for (const { sku, quantity: count } of picks) addScanned(await businessRead(biz.id, "retail/scan", { code: sku.barcode || sku.code, locationId }), count);
    } catch (err) {
      setScanError(getErrorMessage(err));
    }
  }
  // A school set: every book and item on its list, with its quantity.
  async function addSet(set) {
    setScanError("");
    for (const item of set.items) {
      const found = await businessRead(biz.id, "retail/scan", { code: item.barcode || item.code, locationId });
      addScanned(found, Number(item.quantity));
    }
  }
  async function changeTill(next) {
    if (next === locationId) return;
    if (lines.length && !(await confirm({ title: "Change the till?", message: "Stock and batches differ by location, so the bill being built is cleared.", confirmLabel: "Change and clear", cancelLabel: "Keep this bill", tone: "primary" }))) return;
    setLocationId(next); setLines([]);
    try { localStorage.setItem(tillKey, next); } catch { /* storage blocked */ }
  }
  const setLine = (key, changes) => { setPostError(""); setLines((all) => all.map((l) => (l.key === key ? { ...l, ...changes } : l))); };
  const removeLine = (key) => { setPostError(""); setLines((all) => all.filter((l) => l.key !== key)); };
  // "₹200 worth": the weight that comes to that amount at the shelf price.
  function worth(line, amount) {
    const rupees = Number(amount);
    if (!(rupees > 0)) return;
    const shelf = biz.settings.tax_mode === "inclusive" ? Number(line.sku.price) : Number(line.sku.price) * (1 + Number(line.sku.tax_rate) / 100);
    if (!(shelf > 0)) return;
    const units = rupees / shelf;
    setLine(line.key, { quantity: line.unit === "g" ? String(Math.round(units * 1000 * kgPerUnit(line.sku))) : trim(units) });
  }

  const reset = useCallback(() => {
    setLines([]); setCustomer(null); setRedeem(""); setReceived(""); setPartPaid(""); setMethod("cash"); setFinance(emptyFinance()); setAskPin(null);
    setDiscount({ mode: "amount", value: "", reason: "" }); setBuyer({ name: "", phone: "", pan: "", panDeclaration: false }); setSiteId(""); setFitterId("");
    setAgriBill(emptyAgriBill());
    setQuote(null); setPosted(null); setPostError(""); setScanError(""); setRequestKey(newKey()); setVoucher(null); setVoucherCode(""); setVoucherError(""); setCoupon(""); setCouponText("");
    setTimeout(() => scanRef.current?.focus(), 0);
  }, []);

  // --- Hold and recall ---------------------------------------------------------
  function hold() {
    if (!lines.length) return;
    if (held.length >= HELD_LIMIT) { setScanError(`At most ${HELD_LIMIT} bills can be held. Recall one first.`); return; }
    const next = [{ id: newKey(), at: new Date().toISOString(), lines, customer, discount, redeem, total: bill ? bill.total : null }, ...held];
    setHeld(next); writeHeld(biz.id, next);
    reset();
  }
  function recall(entry) {
    const rest = held.filter((h) => h.id !== entry.id);
    const next = lines.length ? [{ id: newKey(), at: new Date().toISOString(), lines, customer, discount, redeem, total: bill ? bill.total : null }, ...rest] : rest;
    setHeld(next); writeHeld(biz.id, next);
    reset();
    setLines(entry.lines); setCustomer(entry.customer);
    if (entry.discount) setDiscount(entry.discount);
    if (entry.redeem) setRedeem(entry.redeem);
  }

  // --- Paying ------------------------------------------------------------------
  const udhaar = method === "udhaar";
  const emi = method === "emi";
  // What the voucher covers, and what is left to pay by cash, UPI or card.
  const fromVoucher = voucher ? Math.min(Number(voucher.balance), total) : 0;
  const toPay = Math.round((total - fromVoucher) * 100) / 100;
  const downSum = partsSummary(finance.down);
  const paidNow = !canPay ? 0 : udhaar ? Number(partPaid || 0) : toPay;
  const change = emi ? downSum.change : method === "cash" && Number(received) > toPay ? Number(received) - toPay : 0;
  const short = method === "cash" && received !== "" && Number(received) < toPay;
  const risk = customer ? udhaarRisk(customer, account, biz) : null;
  const onCredit = udhaar ? Math.max(0, toPay - paidNow) : 0;
  const warnings = [];
  if (udhaar && risk) {
    if (risk.overdue > 0.004) warnings.push(`${biz.exact(risk.overdue)} is already overdue.`);
    if (risk.promise?.broken) warnings.push(`The promise to pay by ${dateShort(risk.promise.on)} was broken.`);
    if (risk.limitLeft !== null && onCredit > risk.limitLeft) warnings.push(`This bill takes them over their limit (${biz.exact(Math.max(0, risk.limitLeft))} left).`);
  }
  const walkInUnpaid = !customer && !walkInCredit && !canPay;
  const serialLines = lines.filter((l) => isSerial(l.sku));
  const kitSerials = lines.some((l) => kitHasSerial(l));
  // The buyer's name and phone: for a warranty, and an EMI needs them too.
  const needsBuyer = ((warranties && (serialLines.length > 0 || kitSerials)) || emi) && !customer;
  // The financier needs the buyer: a customer chosen, or a walk-in's name (a phone is never a condition).
  const emiOk = !emi || (financeReady(finance, toPay) && (customer || buyer.name.trim()));
  // A bill over ₹2,00,000 records the buyer's PAN, unless the customer has
  // their PAN or GSTIN saved; a buyer with no PAN signs a declaration (Form 97).
  const panNeeded = total > 200000 && !(customer?.pan || customer?.gstin);
  const panText = buyer.pan.trim().toUpperCase();
  const panOk = !panNeeded || buyer.panDeclaration || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panText);
  // A farm-input shop's bill: what its fertilisers, seeds and pesticides need first (agri).
  const agriNeeds = usesAgri(biz) ? agriNeedsOf(lines, agriMaster) : null;
  const agriCredit = udhaar && Boolean(customer) && onCredit > 0;
  const agriStop = agriProblem(agriNeeds, agriBill, agriMaster, { credit: agriCredit, today: businessToday(biz.business.timezone) });
  const ready = !posted && bill && !stale && !problem && !posting && !waiting.length && (!udhaar || customer) && !short && !walkInUnpaid && emiOk && panOk && !agriStop;

  async function applyVoucher() {
    setVoucherError("");
    try {
      const found = await businessRead(biz.id, `vouchers/by-number/${encodeURIComponent(voucherCode.trim())}`);
      if (found.state !== "open") throw Object.assign(new Error(), { response: { data: { message: found.state === "used" ? `${found.voucher_no} has been used up.` : `${found.voucher_no} expired on ${dateShort(found.expires_on, { year: true })}.` } } });
      setVoucher(found);
    } catch (err) { setVoucherError(getErrorMessage(err)); }
  }

  // What is taken now, as the server takes it (one payment, or an EMI).
  function payBody() {
    if (!canPay) return {};
    const by = (kind) => methods.body(methodKeys[kind] || kind, [kind]);
    if (emi) return financeBody(finance, methods);
    if (udhaar) return paidNow > 0 ? { payment: { amount: paidNow.toFixed(2), ...by("cash") } } : {};
    if (toPay <= 0) return {};
    if (method === "cash") return { payments: [{ ...by("cash"), amount: "full", ...(Number(received) > toPay ? { tendered: Number(received).toFixed(2) } : {}) }] };
    return { payment: { amount: "full", ...by(method) } };
  }
  async function post(pin = null) {
    if (!ready) return;
    // The biller's PIN for every bill, when the business asks for it.
    if (pinEveryBill && !pin) { setAskPin({ error: "" }); return; }
    setPosting(true);
    setPostError("");
    try {
      const body = JSON.parse(payload);
      const before = risk ? risk.owes : 0;
      // A walk-in farmer's name goes on a farm-input bill (the insecticide register names them).
      const farmerName = !customer && agriNeeds?.any ? agriBill.farmerName.trim() : "";
      const buyerBody = {
        ...(needsBuyer && buyer.name.trim() ? { name: buyer.name.trim() } : farmerName ? { name: farmerName } : {}),
        ...(needsBuyer && buyer.phone.trim() ? { phone: buyer.phone.trim() } : {}),
        ...(panNeeded && buyer.panDeclaration ? { panDeclaration: true } : panNeeded && panText ? { pan: panText } : {}),
      };
      const doc = await businessWrite(biz.id, "documents", {
        ...body, kind: "sale", requestKey, channel: "counter", ...(pin ? { counterPin: pin } : {}),
        ...(Object.keys(buyerBody).length ? { buyer: buyerBody } : {}),
        ...(voucher && fromVoucher > 0 ? { voucher: { code: voucher.voucher_no } } : {}),
        ...(siteId && customer ? { siteId } : {}),
        ...(fitterId && usesFitters(biz) ? { fitterId } : {}),
        ...agriBillBody(agriNeeds, agriBill, { customer, credit: agriCredit }),
        ...payBody(),
      });
      setAskPin(null);
      const detail = await businessRead(biz.id, `documents/${doc.id}`);
      const paid = detail.payments.reduce((s, p) => s + Number(p.amount), 0);
      const thisBill = Math.max(0, Number(detail.total) - paid);
      const udhaarLines = customer && (thisBill > 0.004 || before > 0.004) ? { earlier: before, thisBill, total: before + thisBill } : null;
      writeLast(biz.id, doc.id);
      weightTools.current?.posted(doc.id);
      setPosted({ doc: { ...detail, warranties: doc.warranties || [] }, change: doc.change !== undefined ? Number(doc.change) : change, udhaar: udhaarLines });
      setSold({ skuIds: [...new Set(lines.flatMap((l) => [l.sku.id, ...(l.kit || []).map((c) => c.skuId)]).map(String))] });
    } catch (err) {
      const reason = err?.response?.data?.data?.reason;
      // Asked for the PIN (the setting was just switched on), or a wrong one: ask again.
      if (reason === "pin_required" || (pin && ["wrong_pin", "pin_locked", "too_many_attempts", "no_pin"].includes(reason))) setAskPin((was) => ({ error: getErrorMessage(err), n: (was?.n || 0) + 1 }));
      else { setAskPin(null); setPostError(getErrorMessage(err)); }
    } finally {
      setPosting(false);
    }
  }
  const printPosted = () => posted && printReceipt(posted.doc, biz, { change: posted.change, udhaar: posted.udhaar });

  // Keyboard: the counter is run from the keyboard and the scanner.
  const keys = useRef({});
  keys.current = { post, hold, ready, customer, posted, printPosted, reset, chooseTender };
  useEffect(() => {
    function onKey(event) {
      const k = keys.current;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || "");
      if (k.posted) {
        if ((event.key === "p" || event.key === "P") && !typing && biz.can("sales.print")) { event.preventDefault(); k.printPosted(); }
        // F2 (or Enter, away from a button) closes the confirmation and prepares the next customer's bill.
        const onControl = /^(BUTTON|A)$/.test(event.target?.tagName || "");
        if (event.key === "F2" || (event.altKey && event.code === "KeyS") || (event.key === "Enter" && !typing && !onControl)) { event.preventDefault(); k.reset(); }
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        // Alt + a letter or number: the same as the F-keys, on any keyboard.
        if (ALT_TENDERS[event.code]) {
          event.preventDefault();
          k.chooseTender(ALT_TENDERS[event.code]);
          return;
        }
        if (event.code === "KeyS") { event.preventDefault(); scanRef.current?.focus(); return; }
        if (event.code === "KeyC") { event.preventDefault(); document.getElementById("counter-customer")?.focus(); return; }
        if (event.code === "KeyH") { event.preventDefault(); k.hold(); return; }
      }
      const map = { F6: "cash", F7: "upi", F8: "card", F9: "udhaar" };
      if (event.key === "F2") { event.preventDefault(); scanRef.current?.focus(); }
      else if (event.key === "F4") { event.preventDefault(); document.getElementById("counter-customer")?.focus(); }
      else if (map[event.key]) { event.preventDefault(); k.chooseTender(map[event.key]); }
      else if (event.key === "F10") { event.preventDefault(); k.hold(); }
      else if (event.key === "F12" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); if (k.ready) k.post(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [biz]);

  const columns = [
    { key: "item", header: "Item", minWidth: 200, render: (l) => {
      const q = quoteLine(l);
      const mrp = Number(l.sku.mrp || 0);
      const price = Number(q?.unitPrice ?? l.sku.price);
      return (
        <div className="rt-item">
          <strong>{l.sku.label}</strong>
          <small className="muted">
            {biz.exact(price)} / {l.sku.unit}{q?.priceKind === "member" ? " · member price" : q?.priceKind === "branch" ? " · this branch's price" : ""}{mrp > price ? <> · <s>MRP {biz.exact(mrp)}</s></> : ""}{l.serial ? <> · <span className="mono">{l.serial}</span></> : ""}{l.scale ? " · from scale label" : ""}
          </small>
          {l.kit && (
            <span className="rt-kit-parts">
              {l.kit.map((c) => (
                <span key={c.skuId} className="rt-kit-part">
                  {c.tracking === "serial" ? (
                    <select aria-label={`Serial of ${c.label} in ${l.sku.label}`} value={l.picks?.[c.skuId] || ""}
                      onChange={(e) => setLine(l.key, { picks: { ...l.picks, [c.skuId]: e.target.value } })}>
                      {c.lots.map((lot) => <option key={lot.id} value={lot.lot_code}>{c.label} · {lot.lot_code}</option>)}
                    </select>
                  ) : <small className="muted">+ {Number(c.quantity) > 1 ? `${Number(c.quantity)} × ` : ""}{c.label}</small>}
                </span>
              ))}
              {q?.parts && <small className="muted">GST on each part: {q.parts.map((x) => `${Number(x.taxRate)}%`).join(" + ")}</small>}
            </span>
          )}
          {l.lots?.length > 1 && !isWeighed(l.sku) && !isSerial(l.sku) && (
            <select aria-label={`Batch for ${l.sku.label}`} value={l.lotCode} onChange={(e) => setLine(l.key, { lotCode: e.target.value })}>
              {l.lots.map((lot) => <option key={lot.id} value={lot.lot_code}>{lot.expires_on ? `Use by ${dateShort(lot.expires_on)}` : "Batch"} · {qtyText(lot.quantity, l.sku.unit)} left · {lot.lot_code}</option>)}
            </select>
          )}
          {q?.offers?.length > 0 && (
            <span className="rt-offer-chips">
              {q.offers.map((o) => <span key={`${o.label}-${o.source}`} className={`rt-offer-chip ${o.source === "points" ? "is-points" : ""}`}><Icon name={o.source === "points" ? "star" : "gift"} size={12} /> {o.label} −{biz.exact(o.amount)}</span>)}
            </span>
          )}
        </div>
      );
    } },
    { key: "quantity", header: "Qty", type: "number", width: lines.some((l) => isWeighed(l.sku) && !l.scale) ? 256 : 176, value: (l) => Number(l.quantity) || 0, render: (l, ctx) => {
      if (isSerial(l.sku) || kitHasSerial(l)) return <span>1 {l.kit ? "kit" : l.sku.unit}</span>;
      if (!isWeighed(l.sku)) {
        return (
          <div className="rt-qty rt-stepper">
            <button type="button" className="chip-button" aria-label={`One less ${l.sku.label}`} onClick={() => (Number(l.quantity) > 1 ? setLine(l.key, { quantity: String(Number(l.quantity) - 1) }) : removeLine(l.key))}>−</button>
            <input aria-label={ctx.label} type="number" inputMode="numeric" min="1" step="1" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />
            <button type="button" className="chip-button" aria-label={`One more ${l.sku.label}`} onClick={() => setLine(l.key, { quantity: String(Number(l.quantity || 0) + 1) })}>+</button>
          </div>
        );
      }
      return (
        <div className={`rt-qty rt-weigh ${Number(l.quantity) > 0 ? "has-weight" : ""}`}>
          <span className="rt-weigh-row">
            <input aria-label={ctx.label} type="number" inputMode="decimal" min="0.001" step="any" placeholder="Weight" autoFocus={l.focus}
              className={!(Number(l.quantity) > 0) ? "is-missing" : ""} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value, focus: false })} />
            {l.sku.unit === "kg" && !l.scale ? (
              <select aria-label={`Unit, ${ctx.label}`} value={l.unit || "kg"}
                onChange={(e) => {
                  const unit = e.target.value;
                  const q = Number(l.quantity) || 0;
                  setLine(l.key, { unit, quantity: q ? (unit === "g" ? trim(q * 1000) : trim(q / 1000)) : l.quantity });
                }}>
                <option value="kg">kg</option><option value="g">g</option>
              </select>
            ) : <span className="muted small">{l.unit || l.sku.unit}</span>}
          </span>
          {!l.scale && (
            <span className="rt-steps">
              {(biz.settings.weight_buttons_grams?.length ? biz.settings.weight_buttons_grams : WEIGHT_STEPS).map((g) => <button key={g} type="button" className="chip-button" onClick={() => setLine(l.key, { quantity: stepQuantity(l, g) })}>{g < 1000 ? `${g} g` : `${g / 1000} kg`}</button>)}
              <input className="rt-worth" aria-label={`Amount worth of ${l.sku.label}`} type="number" inputMode="decimal" min="1" placeholder={`${biz.symbol} worth`}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); worth(l, e.currentTarget.value); } }} onBlur={(e) => worth(l, e.currentTarget.value)} />
            </span>
          )}
        </div>
      );
    } },
    { key: "saved", header: "Saved", type: "money", exact: true, value: (l) => Number(quoteLine(l)?.discount || 0), total: "sum", defaultHidden: true },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => { const q = quoteLine(l); return q ? Number(q.net) + Number(q.tax) : 0; }, total: "sum" },
    { key: "remove", header: "", label: "Remove", type: "actions", render: (l) => (
      <button type="button" className="link-button danger" onClick={() => removeLine(l.key)} aria-label={`Remove ${l.sku.label}`}>Remove</button>
    ) },
  ];

  // The till switched to another person: the bill being built goes with it.
  function switched(session) {
    if (lines.length) writeCarry(biz.id, { lines, customer, discount, redeem });
    toast.success(`${session.user.name} is billing now`);
    switchUser(session);
  }

  const lastId = readLast(biz.id);
  const moreActions = biz.can("sales.refund")
    ? [{ label: "Return", icon: "undo", onClick: () => setReturning(true) }]
    : [];
  const headerActions = (
    <>
      {biz.can("sales.create") && <BillerButton biz={biz} onSwitch={switched} />}
      {biz.can("sales.create") && <ShiftButton key={`${locationId}`} biz={biz} locationId={locationId} />}
      {lastId && <button type="button" className="button button-secondary" onClick={() => setLastOpen(lastId)}><Icon name="receipt" size={15} /> Last bill</button>}
      {biz.can("sales.view") && <Link className="button button-secondary" to={businessPath(biz.id, "day-close")}><Icon name="clock" size={15} /> Daily money</Link>}
      {biz.has("weight")
        ? <CounterWeightTools biz={biz} locationId={locationId} onAdd={addScanned} onCustomer={setCustomer} toolsRef={weightTools} additionalActions={moreActions} />
        : <ActionMenu text="More" label="More counter actions" items={moreActions} />}
    </>
  );

  const paid = posted?.doc.payments.reduce((sum, payment) => sum + Number(payment.amount), 0) || 0;
  const earned = posted?.doc.retail?.loyalty?.find((entry) => entry.kind === "earn");
  const savedConfirmation = posted && (
    <Modal title={`Bill ${posted.doc.document_no} saved`} icon="check" onClose={reset} width={680}>
          <div className="rt-done">
            <div><span className="muted">Total</span><strong>{biz.exact(posted.doc.total)}</strong></div>
            <div><span className="muted">Paid</span><strong>{biz.exact(paid)}{posted.doc.payments.length === 1 ? ` · ${paymentWord(posted.doc.payments[0])}` : ""}</strong></div>
            {posted.doc.payments.length > 1 && posted.doc.payments.map((p) => (
              <div key={p.id} className="rt-done-part"><span className="muted">{p.method === "finance" ? `EMI · ${posted.doc.finance?.[0]?.financier_name || "financier"}` : paymentWord(p)}</span><strong>{biz.exact(p.amount)}</strong></div>
            ))}
            {posted.doc.finance?.map((f) => <div key={f.id}><span className="muted">EMI loan</span><strong>{f.financier_name} · {f.loan_no}{f.do_no ? ` · DO ${f.do_no}` : ""}</strong></div>)}
            {posted.change > 0 && <div className="rt-change"><span>Give back</span><strong>{biz.exact(posted.change)}</strong></div>}
            {posted.udhaar && posted.udhaar.thisBill > 0.004 && <div><span className="muted">On {posted.doc.contact_name}'s udhaar</span><strong>{biz.exact(posted.udhaar.thisBill)} · now owes {biz.exact(posted.udhaar.total)}</strong></div>}
            {Number(posted.doc.retail?.savings || 0) > 0 && <div><span className="muted">Customer saved</span><strong>{biz.exact(posted.doc.retail.savings)}</strong></div>}
            {earned && <div><span className="muted">Points earned</span><strong>{earned.points}</strong></div>}
            {posted.doc.warranties.map((w) => <div key={w.id}><span className="muted">Warranty registered</span><strong>{w.serial} · until {dateShort(w.ends_on, { year: true })}</strong></div>)}
          </div>
          <div className="form-actions bz-start">
            <button type="button" className="button" data-autofocus onClick={reset}><Icon name="plus" size={15} /> Next bill <kbd>Enter</kbd></button>
            {biz.can("sales.print") && <button type="button" className="button button-secondary" onClick={printPosted}><Icon name="print" size={15} /> Print receipt <kbd>P</kbd></button>}
            {biz.can("sales.print") && <button type="button" className="button button-secondary" onClick={() => setLastOpen(posted.doc.id)}><Icon name="file" size={15} /> Tax invoice (A4)</button>}
          </div>
    </Modal>
  );

  return (
    <div className={`stack rt-counter-page ${narrow && lines.length ? "has-paybar" : ""}`}>
      <BusinessHeader icon="receipt" title="Quick bill" actions={headerActions} />
      <div className="rt-counter">
        <div className="stack rt-counter-main">
          <SectionCard icon="search" title="1 · Add items" description="Click an item below, type part of its name, or scan its barcode." actions={(fashion || usesCalculators(biz)) && (
            <>
              {fashion && <button type="button" className="button button-secondary button-sm" onClick={() => setPicking(true)}><Icon name="tag" size={14} /> Size & colour</button>}
              {usesCalculators(biz) && <button type="button" className="button button-secondary button-sm" onClick={() => setCalculating(true)}><Icon name="grid" size={14} /> Tile & paint calculator</button>}
            </>
          )}>
            <ScanBox biz={biz} inputRef={scanRef} onCode={lookUp} onPick={(sku) => lookUp(sku.barcode || sku.code)} onQuery={changeSearch}
              placeholder={`Scan a barcode${scanWords.length ? `, ${scanWords.join(", ")}` : ""} or type a name  (F2 or Alt+S)`} />
            <ErrorMessage message={scanError} />
            {scanTip && <p className="small muted rt-scan-tip" role="status">{scanTip}</p>}
            {locations.length > 1 && (
              <Field label="Selling from">
                <select value={locationId} onChange={(e) => changeTill(e.target.value)}>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            )}
            {held.length > 0 && (
              <div className="rt-held" aria-label="Held bills">
                <span className="muted small">Held:</span>
                {held.map((h, i) => (
                  <button key={h.id} type="button" className="chip-button" onClick={() => recall(h)} title="Recall this bill">
                    Held {i + 1}{h.customer ? ` · ${h.customer.name}` : ""}{h.total ? ` · ${biz.exact(h.total)}` : ` · ${h.lines.length} items`}
                  </button>
                ))}
              </div>
            )}
            <CounterShelf key={`${biz.id}:${locationId}`} biz={biz} locationId={locationId} query={shelfQuery} sold={sold}
              onAdd={(sku) => { lookUp(sku.barcode || sku.code); scanRef.current?.focus(); }} />
          </SectionCard>
        </div>
        <div className="stack rt-counter-side">
          <div className="stack rt-counter-summary">
          <SectionCard flush icon="list" title="2 · Bill" className="rt-bill"
            actions={lines.length > 0 && (
              <span className="rt-bill-actions">
                <button type="button" className="button button-secondary button-sm" onClick={hold} title="Put this bill aside and serve the next customer (F10 or Alt+H)">Hold <kbd>F10</kbd></button>
                <button type="button" className="button button-secondary button-sm" onClick={() => setLines([])}>Clear</button>
              </span>
            )}>
            {lines.length === 0
              ? <p className="muted rt-empty">Nothing on the bill yet. Click items on the {narrow ? "list above" : "left"}{fashion ? ", pick a size and colour" : ""}, or type a name.</p>
              : <PhoneLines biz={biz} lines={lines} onRemove={removeLine} renderItem={columns.find((c) => c.key === "item").render} renderQuantity={columns.find((c) => c.key === "quantity").render} amountOf={columns.find((c) => c.key === "amount").value} />}
          </SectionCard>
          <CustomerBox biz={biz} customer={customer} account={account}
            onChange={(c) => { setCustomer(c); setRedeem(""); setSiteId(""); if (!c && method === "udhaar") setMethod("cash"); if (!c) setWantUdhaar(false); }} />
          {usesSites(biz) && customer && (
            <SectionCard icon="map-pin" title="Site">
              <SiteField biz={biz} contactId={customer.id} value={siteId} onChange={setSiteId} label="Goes to site" />
            </SectionCard>
          )}
          {usesFitters(biz) && (
            <SectionCard icon="users" title="Fitted by">
              <FitterField biz={biz} value={fitterId} onChange={setFitterId} label="Fitter who brought the customer" />
            </SectionCard>
          )}
          {agriNeeds && <AgriBillFields biz={biz} needs={agriNeeds} value={agriBill} onChange={setAgriBill} master={agriMaster} customer={customer} credit={agriCredit} />}
          {needsBuyer && (
            <SectionCard icon="shield" title={emi ? "Buyer" : "Warranty for"} description={emi ? "Name and phone of the buyer, for the financier and the warranty." : "Name and phone of the buyer, so the warranty is registered with this bill."}>
              <div className="rt-inline">
                <Field label="Name"><input maxLength={150} value={buyer.name} onChange={(e) => setBuyer((b) => ({ ...b, name: e.target.value }))} /></Field>
                <Field label="Phone (optional)"><input maxLength={30} inputMode="tel" value={buyer.phone} onChange={(e) => setBuyer((b) => ({ ...b, phone: e.target.value }))} /></Field>
              </div>
            </SectionCard>
          )}
          {panNeeded && (
            <SectionCard icon="shield" title="Buyer's PAN" description="A bill over ₹2,00,000 records the buyer's PAN. Save it with the customer to skip this next time.">
              <div className="rt-inline">
                <Field label="PAN"><input maxLength={10} className="mono" placeholder="ABCDE1234F" disabled={buyer.panDeclaration} value={buyer.pan}
                  onChange={(e) => setBuyer((b) => ({ ...b, pan: e.target.value.toUpperCase() }))} /></Field>
              </div>
              <label className="checkbox"><input type="checkbox" checked={buyer.panDeclaration}
                onChange={(e) => setBuyer((b) => ({ ...b, panDeclaration: e.target.checked, pan: e.target.checked ? "" : b.pan }))} /> The buyer has no PAN and signed a declaration (Form 97)</label>
            </SectionCard>
          )}
          {bill?.loyalty && (
            <SectionCard icon="star" title="Loyalty points">
              <p className="rt-points">
                <strong>{bill.loyalty.balance}</strong> points{bill.loyalty.balance > 0 ? ` (worth ${biz.exact(bill.loyalty.balance * bill.loyalty.pointValue)})` : ""} · this bill earns <strong>{bill.loyalty.earns}</strong>
              </p>
              {canRedeem && (bill.loyalty.maxRedeem >= bill.loyalty.minRedeem || Number(redeem) > 0) && (
                <div className="rt-inline">
                  <Field label="Redeem points" hint={`From ${bill.loyalty.minRedeem}, up to ${bill.loyalty.maxRedeem} on this bill`}>
                    <input type="number" min="0" step="1" value={redeem} onChange={(e) => setRedeem(e.target.value)} />
                  </Field>
                  <button type="button" className="button button-secondary button-sm" onClick={() => setRedeem(String(bill.loyalty.maxRedeem))}>Use {bill.loyalty.maxRedeem}</button>
                </div>
              )}
            </SectionCard>
          )}
          </div>
          <SectionCard icon="wallet" title="3 · Take payment" className="rt-pay" id="counter-pay">
            {/* The total first and large; tax is one quiet line under it (a
                cashier reads the amount to the customer, not the GST). */}
            <div className="rt-totals rt-totals-large" aria-live="polite">
              <div className="rt-grand"><span>To pay{lines.length ? <small className="muted"> · {lines.length} {lines.length === 1 ? "item" : "items"}</small> : null}</span><strong>{bill ? biz.exact(bill.total) : biz.exact(0)}</strong></div>
              <p className="small muted rt-tax-line">{!bill
                ? (lines.length ? "Working out the total…" : "Add items to see the total.")
                : Number(bill.tax) === 0 && bill.lines.every((x) => Number(x.taxRate) === 0)
                  ? "No GST on these items."
                  : `${biz.settings.tax_mode === "inclusive" ? `Includes GST ${biz.exact(bill.tax)}` : `${biz.exact(bill.subtotal)} + GST ${biz.exact(bill.tax)}`}${Number(bill.roundOff) !== 0 ? ` · round-off ${biz.exact(bill.roundOff)}` : ""}`}</p>
              {bill && Number(bill.savings) > 0 && <p className="small rt-saving rt-tax-line">Customer saves {biz.exact(bill.savings)}</p>}
              {stale && <small className="muted">Updating…</small>}
            </div>
            {canDiscount && lines.length > 0 && (
              <details className="rt-discount" open={Number(discount.value) > 0}>
                <summary>Discount on this bill <small className="muted">(up to {Number(biz.settings.max_bill_discount_percent ?? 10)}%)</small></summary>
                <div className="rt-inline">
                  <select aria-label="Discount as" value={discount.mode} onChange={(e) => setDiscount((d) => ({ ...d, mode: e.target.value }))}>
                    <option value="amount">{biz.symbol} off</option><option value="percent">% off</option>
                  </select>
                  <input aria-label="Discount" type="number" min="0" step="0.01" value={discount.value} onChange={(e) => setDiscount((d) => ({ ...d, value: e.target.value }))} />
                  <input aria-label="Reason for the discount" maxLength={120} placeholder="Reason (needed)" value={discount.reason} onChange={(e) => setDiscount((d) => ({ ...d, reason: e.target.value }))} />
                </div>
                {Number(discount.value) > 0 && !discount.reason.trim() && <small className="muted">Give a reason to apply it.</small>}
              </details>
            )}
            {biz.has("offers") && lines.length > 0 && (
              <details className="rt-discount" open={Boolean(coupon || couponText)}>
                <summary>Coupon {coupon && <small className="muted">({coupon}{bill?.coupon ? (bill.coupon.applied ? " · applied" : " · not applied") : ""})</small>}</summary>
                {coupon ? (
                  <div className="rt-inline">
                    <span className="small">{bill?.coupon?.name || coupon}{bill?.coupon && !bill.coupon.applied ? ": a better offer is already on this bill, or its item is not on it" : ""}</span>
                    <button type="button" className="link-button danger" onClick={() => { setCoupon(""); setCouponText(""); }}>Remove</button>
                  </div>
                ) : (
                  <div className="rt-inline">
                    <input aria-label="Coupon code" className="mono" placeholder="e.g. DIWALI100" maxLength={20} value={couponText}
                      onChange={(e) => setCouponText(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (couponText.length >= 3) setCoupon(couponText); } }} />
                    <button type="button" className="button button-secondary button-sm" disabled={couponText.length < 3} onClick={() => setCoupon(couponText)}>Apply</button>
                  </div>
                )}
              </details>
            )}
            {biz.has("exchanges") && canPay && lines.length > 0 && (
              <details className="rt-discount" open={Boolean(voucher || voucherCode)}>
                <summary>Credit voucher {voucher && <small className="muted">({voucher.voucher_no} · {biz.exact(fromVoucher)} off)</small>}</summary>
                {voucher ? (
                  <div className="rt-inline">
                    <span className="small">{voucher.voucher_no}: {biz.exact(voucher.balance)} left{voucher.customer_name ? ` · ${voucher.customer_name}` : ""}</span>
                    <button type="button" className="link-button danger" onClick={() => { setVoucher(null); setVoucherCode(""); }}>Remove</button>
                  </div>
                ) : (
                  <div className="rt-inline">
                    <input aria-label="Voucher number" placeholder="Scan or type CV…" value={voucherCode} onChange={(e) => setVoucherCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyVoucher(); } }} />
                    <button type="button" className="button button-secondary button-sm" disabled={!voucherCode.trim()} onClick={applyVoucher}>Apply</button>
                  </div>
                )}
                {voucherError && <small className="rt-warn">{voucherError}</small>}
              </details>
            )}
            {voucher && fromVoucher > 0 && <div className="rt-totals"><div><span>Voucher {voucher.voucher_no}</span><span>−{biz.exact(fromVoucher)}</span></div><div className="rt-grand"><span>Left to pay</span><strong>{biz.exact(toPay)}</strong></div></div>}
            {problem && <ErrorMessage message={problem} />}
            {waiting.length > 0 && <p className="small rt-warn">Enter the weight of {waiting.map((l) => l.sku.label).join(", ")}.</p>}
            {agriStop && lines.length > 0 && <p className="small rt-warn" role="status">{agriStop}</p>}
            <div className="segmented rt-tender rt-tender-grid" role="group" aria-label="Paid by">
              {[...TENDERS, ...(canEmi ? [["emi", ""]] : [])].map(([m, key]) => {
                // A kind the business has switched every method of off is not offered.
                const off = !TENDER_WORDS[m] && methods.ready && !methods.has(m);
                const word = m === "card" ? "Card" : TENDER_WORDS[m] || methods.label(m);
                return (
                  <button key={m} type="button" className={`segment ${method === m ? "is-active" : ""}`} aria-pressed={method === m}
                    disabled={off} title={m === "udhaar" && !customer ? "Udhaar: pick the customer who will pay later" : off ? `No ${methodWord(m)} method is switched on (Settings › Payment methods)` : m === "emi" ? "EMI / finance through a financier" : `${word} (${key} or ${ALT_KEY[m]})`}
                    onClick={() => chooseTender(m)}>{word} {key && <kbd>{key}</kbd>}</button>
                );
              })}
            </div>
            {wantUdhaar && !customer && (
              <p className="small rt-warn" role="status">Udhaar: pick the customer who will pay later in the Customer box below (F4 or Alt+C). The bill goes on their udhaar as soon as you pick them.</p>
            )}
            <details className="small rt-key-hint">
              <summary className="muted">Keyboard shortcuts</summary>
              <dl className="rt-keys">
                <dt>Find an item</dt><dd><kbd>F2</kbd> or <kbd>Alt+S</kbd></dd>
                <dt>Customer</dt><dd><kbd>F4</kbd> or <kbd>Alt+C</kbd></dd>
                <dt>Cash, UPI, card, udhaar</dt><dd><kbd>F6</kbd>–<kbd>F9</kbd> or <kbd>Alt+1</kbd>–<kbd>Alt+4</kbd></dd>
                <dt>Hold the bill</dt><dd><kbd>F10</kbd> or <kbd>Alt+H</kbd></dd>
                <dt>Take the payment</dt><dd><kbd>F12</kbd> or <kbd>Ctrl+Enter</kbd></dd>
              </dl>
              <p className="muted">On a laptop the F-keys may need <kbd>Fn</kbd>; the Alt keys always work.</p>
            </details>
            {["cash", "upi", "card"].includes(method) && methods.options([method]).length > 1 && (
              <Field label={`Which ${methodWord(method) === "UPI" ? "UPI" : methodWord(method).toLowerCase()}`}>
                <select value={methods.resolve(methodKeys[method] || method, [method])} onChange={(e) => setMethodKeys((k) => ({ ...k, [method]: e.target.value }))}>
                  {methods.options([method]).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                </select>
              </Field>
            )}
            <form className="stack rt-pay-form" onSubmit={(e) => { e.preventDefault(); post(); }}>
              {method === "cash" && canPay && (
                <>
                  <Field label="Cash received" hint={change > 0 ? `Give back ${biz.exact(change)}` : short ? "Less than the bill" : "Leave empty for the exact amount · Enter takes it"}>
                    <input type="number" inputMode="decimal" min="0" step="0.01" value={received} onChange={(e) => setReceived(e.target.value)} />
                  </Field>
                  {toPay > 0 && (
                    <div className="rt-cash-chips" role="group" aria-label="Notes received">
                      {cashChips(toPay).map((n) => <button key={n} type="button" className={`chip-button ${Number(received) === n ? "is-active" : ""}`} onClick={() => setReceived(String(n))}>{n === toPay ? "Exact" : biz.amount(n)}</button>)}
                    </div>
                  )}
                </>
              )}
              {emi && <FinanceFields biz={biz} value={finance} onChange={setFinance} toPay={toPay} />}
              {emi && !customer && <p className="small muted">The financier needs the customer: pick them, or give the buyer's name below.</p>}
              {udhaar && customer && (
                <>
                  <p className="small">The unpaid amount goes on <strong>{customer.name}</strong>'s udhaar.</p>
                  {warnings.length > 0 && <div className="rt-warn" role="alert"><Icon name="alert" size={14} /> {warnings.join(" ")}</div>}
                  {canPay && <Field label="Paid now in cash (optional)"><input type="number" min="0" step="0.01" value={partPaid} onChange={(e) => setPartPaid(e.target.value)} /></Field>}
                </>
              )}
              {!canPay && <p className="muted small">Your role records bills but not payments{customer ? "; the bill stays to collect." : walkInCredit ? "." : ". A walk-in pays in full, so pick the customer or ask someone who takes payments."}</p>}
              <ErrorMessage message={postError} />
              <button type="submit" className="button rt-post" disabled={!ready}>
                {posting ? "Saving…" : udhaar ? `Put ${biz.exact(onCredit)} on udhaar` : toPay <= 0 && fromVoucher > 0 ? "Pay with the voucher"
                  : emi ? `Take ${biz.exact(downSum.paid)} · ${biz.exact(Math.max(0, toPay - downSum.paid))} on EMI`
                  : `Take ${biz.exact(toPay)}${method !== "cash" ? ` by ${methods.name(methodKeys[method] || method, [method])}` : ""}`} <kbd>F12</kbd>
              </button>
            </form>
          </SectionCard>

        </div>
      </div>
      {narrow && lines.length > 0 && (
        <PayBar biz={biz} total={toPay} lines={lines.length} ready={ready} label={`Take ${biz.exact(toPay)}`}
          onPay={() => {
            const card = document.getElementById("counter-pay");
            card?.scrollIntoView({ behavior: "smooth", block: "start" });
            card?.querySelector(".rt-tender button.is-active, .rt-post")?.focus({ preventScroll: true });
          }} />
      )}
      {savedConfirmation}
      {askPin && <BillerDialog key={askPin.n || 0} biz={biz} mode="confirm" error={askPin.error} onClose={() => setAskPin(null)} onConfirm={(pin) => post(pin)} onSwitched={switched} />}
      {picking && <VariantPicker biz={biz} locationId={locationId} onClose={() => setPicking(false)} onPick={(v) => { lookUp(v.barcode || v.code); }} />}
      {calculating && <CalculatorDialog biz={biz} target="bill" onAdd={addCalculated} onClose={() => setCalculating(false)} />}
      {lastOpen && <DocumentDetail documentId={lastOpen} onClose={() => setLastOpen(null)} onChanged={() => {}} />}
      {returning && <ReturnFinder biz={biz} onClose={() => setReturning(false)} onPick={(d) => { setReturning(false); setReturnId(d.id); }} />}
      {returnId && <DocumentDetail documentId={returnId} initialAction="returns" onClose={() => setReturnId(null)} onChanged={() => {}} />}
    </div>
  );
}

// The scan / search box. Enter looks the code up; typing a name shows matches,
// which ↓ / ↑ move through and Enter adds (the first one unless another is
// highlighted). A typed name that is not a code never shows "not found"
// while there are matches to pick from.
function ScanBox({ biz, inputRef, onCode, onPick, placeholder, onQuery }) {
  const [text, setText] = useState("");
  useEffect(() => { onQuery?.(text); }, [text, onQuery]);
  // The matches and the text they were found for: a list left from earlier
  // typing is never picked from (a fast scanner gets a lookup instead).
  const [found, setFound] = useState({ q: "", items: [] });
  const [active, setActive] = useState(0);
  const [moved, setMoved] = useState(false);
  const query = text.trim();
  const searching = query.length >= 2 && !/^\d{8,}$/.test(query);
  const businessId = biz.id;
  const listId = "counter-matches";
  // With several shops the list's stock is the business's; the shelf below shows this shop's.
  const allShops = (biz.allLocations || []).filter((l) => l.active).length > 1;

  useEffect(() => {
    if (!searching) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Goods only: services are not sold over the counter.
      businessRead(businessId, "catalog", { q: query, active: "true", kind: "goods", limit: 8 }, controller.signal)
        .then((page) => { setFound({ q: query, items: page.items }); setActive(0); setMoved(false); })
        .catch(() => {});
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [businessId, query, searching]);

  const shown = searching && found.q === query ? found.items : [];
  const setMatches = (items) => setFound({ q: "", items });
  const current = shown[Math.min(active, shown.length - 1)];
  const pick = (item) => { onPick(item); setText(""); setMatches([]); inputRef.current?.focus(); };
  async function submit(event) {
    event.preventDefault();
    if (!query) return;
    // Moved through the list with the arrows: that item.
    if (moved && current) { pick(current); return; }
    // The text is a match's own code or barcode, or a name with matches
    // showing: pick from the list (no lookup, so never "not found").
    const exact = shown.find((s) => String(s.code).toUpperCase() === query.toUpperCase() || s.barcode === query);
    if (exact || current) { pick(exact || current); return; }
    // A scanned code (the list has not opened for it): look it up.
    if (await onCode(query)) { setText(""); setMatches([]); }
  }
  function onKeyDown(event) {
    if (event.key === "Escape") { setText(""); return; }
    if (!shown.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setMoved(true);
    setActive((at) => {
      if (event.key === "Home") return 0;
      if (event.key === "End") return shown.length - 1;
      return (at + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
    });
  }
  return (
    <form className="rt-scan" onSubmit={submit} role="search">
      <Icon name="search" size={18} />
      <input ref={inputRef} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder}
        aria-label="Scan or type an item" autoComplete="off" onKeyDown={onKeyDown}
        role="combobox" aria-autocomplete="list" aria-expanded={shown.length > 0} aria-controls={shown.length ? listId : undefined}
        aria-activedescendant={shown.length && current ? `${listId}-${current.id}` : undefined} />
      <button type="submit" className="button button-sm">Add to bill</button>
      {shown.length > 0 && (
        <ul className="rt-matches" role="listbox" id={listId} aria-label="Matching items">
          {shown.map((s) => (
            <li key={s.id} role="none">
              <button type="button" role="option" id={`${listId}-${s.id}`} aria-selected={s === current} className={s === current ? "is-active" : ""}
                tabIndex={-1} onMouseEnter={() => setActive(shown.indexOf(s))} onClick={() => pick(s)}>
                <span><strong>{s.label}</strong> <small className="muted mono">{s.code}</small></span>
                <span>{biz.exact(s.price)}<small className="muted"> /{s.unit} · {qtyText(s.stock, s.unit)} {allShops ? "in all shops" : "in stock"}</small></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
