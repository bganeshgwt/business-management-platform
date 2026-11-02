import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import Icon from "@bmp/ui/Icon";
import { count, dateShort } from "@bmp/shared/format";
import SectionCard from "../../../../components/SectionCard";
import SettingsLayout, { SettingsSaveBar } from "../../../../components/SettingsLayout";
import StatTile from "../../../../components/StatTile";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage, uploadUrl } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { confirmAction } from "../../../../services/confirm";
import { customerWebOrigin } from "../../../../services/customerWeb";
import { printDocument } from "../../../../services/print";
import { addressProblem } from "../../../../services/qrSheet";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { whatsappLink } from "../../retail/pages/retail";
import {
  blockMobile, blockedMobiles, hiddenCategories, liftBlock, newShopLink, saveShopItem, saveShopSettings, setCategoryOnline, shopItems, shopSettings,
} from "../services/onlineShop.service";
import { POSTER, posterHtml, shareText } from "./onlineShop";
import OnlineItemFields from "./OnlineItemFields";
import "../styles/online-shop.css";

// Settings › Online shop: each location's shop link (copy, open, the QR
// poster for the counter, WhatsApp, a new link), taking orders or paused,
// how ready the shop is, and every setting: pickup and delivery (PIN codes,
// charges, slots), the orders' rules, the ways to pay, the seller's details
// and policy the shop shows on every page; then which categories and items
// show online, and the mobiles blocked from ordering.

const SECTIONS = [
  { id: "os-link", label: "Shop link" },
  { id: "os-ready", label: "How ready it is" },
  { id: "os-delivery", label: "Pickup & delivery" },
  { id: "os-orders", label: "Orders" },
  { id: "os-payments", label: "Payments" },
  { id: "os-seller", label: "Seller details & policy" },
  { id: "os-items", label: "Items online" },
  { id: "os-categories", label: "Categories online" },
  { id: "os-blocked", label: "Blocked mobiles" },
];
// The step between a category and the one inside it, as category paths are written.
const PATH_STEP = " › ";
const STATE_WORDS = { on: "Taking orders", paused: "Paused", off: "Switched off" };

// Copying needs a secure page and a willing browser; the old way is tried when the modern one is refused.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* the old way below */ }
  }
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.appendChild(box);
  box.select();
  let done = false;
  try { done = document.execCommand("copy"); } catch { done = false; }
  box.remove();
  return done;
}

const text = (value) => (value === null || value === undefined ? "" : String(value));
function formOf(link) {
  return {
    pickupEnabled: link.pickupEnabled, pickupMinutes: text(link.pickupMinutes), deliveryEnabled: link.deliveryEnabled, deliveryPins: (link.deliveryPins || []).join(", "),
    deliveryAreaNote: text(link.deliveryAreaNote), deliveryFee: text(link.deliveryFee), freeDeliveryAbove: text(link.freeDeliveryAbove), minOrder: text(link.minOrder),
    deliveryMinutes: text(link.deliveryMinutes), slotsEnabled: link.slotsEnabled, slots: (link.slots || []).map((slot) => ({ from: slot.from, to: slot.to, cap: text(slot.cap) })),
    slotCutoffMinutes: text(link.slotCutoffMinutes), takeOrdersWhenClosed: link.takeOrdersWhenClosed, hideOutOfStock: link.hideOutOfStock, lowStockBelow: text(link.lowStockBelow),
    maxOpenPerMobile: text(link.maxOpenPerMobile), autoDeclineMinutes: text(link.autoDeclineMinutes), payAtShop: link.payAtShop, cashOnDelivery: link.cashOnDelivery,
    upiOnDelivery: link.upiOnDelivery, upiId: text(link.upiId), upiPayee: text(link.upiPayee), guestNote: text(link.guestNote), carePhone: text(link.carePhone),
    careEmail: text(link.careEmail), grievanceName: text(link.grievanceName), grievanceDesignation: text(link.grievanceDesignation), grievancePhone: text(link.grievancePhone),
    grievanceEmail: text(link.grievanceEmail), fssaiLicence: text(link.fssaiLicence), policy: text(link.policy),
  };
}
const orNull = (value) => (value.trim() === "" ? null : value.trim());
function bodyOf(form) {
  return {
    ...form,
    deliveryPins: form.deliveryPins.split(/[\s,;]+/).filter(Boolean),
    deliveryAreaNote: orNull(form.deliveryAreaNote), freeDeliveryAbove: orNull(form.freeDeliveryAbove), deliveryFee: form.deliveryFee.trim() || "0", minOrder: form.minOrder.trim() || "0",
    slots: form.slots.map((slot) => ({ from: slot.from, to: slot.to, cap: Number(slot.cap) })),
    upiId: orNull(form.upiId), upiPayee: orNull(form.upiPayee), guestNote: orNull(form.guestNote), carePhone: orNull(form.carePhone), careEmail: orNull(form.careEmail),
    grievanceName: orNull(form.grievanceName), grievanceDesignation: orNull(form.grievanceDesignation), grievancePhone: orNull(form.grievancePhone),
    grievanceEmail: orNull(form.grievanceEmail), fssaiLicence: orNull(form.fssaiLicence),
  };
}

function LinkCard({ link, canManage, onChanged }) {
  const biz = useOpenBusiness();
  const origin = customerWebOrigin();
  const url = link.url || `${origin}${link.path}`;
  const problem = addressProblem(link.url, origin);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(url, { width: 360, margin: 1, errorCorrectionLevel: "M" }).then((data) => { if (live) setQr(data); }).catch(() => { if (live) setQr(""); });
    return () => { live = false; };
  }, [url]);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  const state = !link.enabled ? "off" : link.paused ? "paused" : "on";
  const change = async (body, words) => {
    setBusy(true);
    try {
      onChanged(await saveShopSettings(biz.id, link.locationId, body));
      toast.success(words);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const poster = async () => {
    try {
      const big = await QRCode.toDataURL(url, { width: 900, margin: 1, errorCorrectionLevel: "M" });
      printDocument({ title: `${biz.business.name}: order online`, styles: POSTER, body: posterHtml({ name: biz.business.name, url, qrDataUrl: big }) });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const replaceLink = async () => {
    const sure = await confirmAction({ title: "Make a new shop link?", confirmLabel: "Make a new link",
      message: "The old link and its QR code stop working at once: customers who saved it see that the link has changed. Share the new link, and print a new poster." });
    if (!sure) return;
    setBusy(true);
    try {
      onChanged(await newShopLink(biz.id, link.locationId));
      toast.success("A new shop link is ready. The old one no longer works.");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card os-link" id="os-link" aria-labelledby="os-link-title">
      <div className="os-link-main">
        <div className="os-link-status">
          <span className={`os-state is-${state}`}><span className="os-state-dot" aria-hidden="true" />{STATE_WORDS[state]}</span>
          {link.waiting > 0 && <Link className="os-waiting" to={businessPath(biz.id, "online-orders")}>{count(link.waiting)} new {link.waiting === 1 ? "order" : "orders"} waiting</Link>}
          {link.today > 0 && <span className="muted small">{count(link.today)} placed today</span>}
        </div>
        <h2 id="os-link-title">{link.locationName}</h2>
        <label className="field">
          <span>Shop link</span>
          <span className="os-link-row">
            <input readOnly value={url} className="mono" onFocus={(event) => event.target.select()} />
            <button type="button" className="button button-secondary" onClick={() => copyText(url).then(setCopied)}>
              <Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copied" : "Copy"}
            </button>
          </span>
        </label>
        <div className="os-link-actions">
          <a className="button" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15} /> Open my shop page</a>
          <button type="button" className="button button-secondary" onClick={poster}><Icon name="print" size={15} /> QR poster</button>
          <a className="button button-secondary" href={whatsappLink("", shareText(biz.business.name, url))} target="_blank" rel="noopener noreferrer"><Icon name="message" size={15} /> Share on WhatsApp</a>
        </div>
        {problem && <p className="alert alert-notice">This link opens a local address (this computer or the shop's own network), which customers' phones cannot reach. The guests' site needs its public address before you share the link.</p>}
        {!link.locationActive && <p className="alert alert-notice">{link.locationName} is closed, so its shop link cannot take orders.</p>}
        {canManage && (
          <div className="os-switches">
            <label className="os-switch">
              <input type="checkbox" role="switch" checked={link.enabled} disabled={busy || (!link.locationActive && !link.enabled)}
                onChange={(event) => change({ enabled: event.target.checked }, event.target.checked ? "The shop link takes orders now." : "The shop link is switched off.")} />
              <span><strong>Take online orders</strong><small>Customers order from this link for pickup or delivery.</small></span>
            </label>
            <label className="os-switch">
              <input type="checkbox" role="switch" checked={link.paused} disabled={busy || !link.enabled}
                onChange={(event) => change({ paused: event.target.checked }, event.target.checked ? "Paused: the shop shows it is not taking orders just now." : "Taking orders again.")} />
              <span><strong>Pause new orders</strong><small>For a rush or a short break. Orders already placed carry on.</small></span>
            </label>
          </div>
        )}
        {canManage && <button type="button" className="link-button os-new-link" disabled={busy} onClick={replaceLink}>Make a new link (the old one stops working)</button>}
      </div>
      <figure className="os-link-qr">
        {qr ? <img src={qr} alt={`QR code that opens the shop link of ${link.locationName}`} width="168" height="168" /> : <span className="os-qr-blank" aria-hidden="true" />}
        <figcaption>Scan to order</figcaption>
      </figure>
    </section>
  );
}

function Readiness({ link, onPick }) {
  const ready = link.readiness;
  return (
    <SectionCard id="os-ready" icon="check-circle" title="How ready your shop is" description="What customers can order now, and what still needs a photo or its details.">
      <div className="stat-grid os-tiles">
        <StatTile icon="eye" tone="success" label="Showing online" value={count(ready.shown)} note="items customers can order" onClick={() => onPick("shown")} />
        <StatTile icon="box" tone={ready.outOfStock ? "warning" : "neutral"} label="Out of stock" value={count(ready.outOfStock)}
          note={link.hideOutOfStock ? "hidden until stock comes in" : "shown as out of stock"} />
        <StatTile icon="eye-off" label="Kept off by you" value={count(ready.hidden)} note="the item or its category" onClick={() => onPick("hidden")} />
        <StatTile icon="upload" tone={ready.withoutPhoto ? "warning" : "neutral"} label="Without a photo" value={count(ready.withoutPhoto)} note="shown with their first letter" onClick={() => onPick("no_photo")} />
        <StatTile icon="info" tone={ready.withoutMaker ? "warning" : "neutral"} label="Without maker details" value={count(ready.withoutMaker)} note="for packaged goods" onClick={() => onPick("no_maker")} />
        <StatTile icon="file" tone={ready.withoutHsn ? "warning" : "neutral"} label="Without an HSN code" value={count(ready.withoutHsn)} note="needed on the bill" />
      </div>
      {ready.neverOnline.length > 0 && (
        <div className="os-never-list">
          <h3><Icon name="ban" size={16} /> Never sold online</h3>
          <p className="muted small">The law, or the trade's own rules, keep these off every online shop, whatever the settings say. They stay on sale at the counter.</p>
          <ul>{ready.neverOnline.map((rule) => <li key={rule.code}><strong>{count(rule.count)}</strong><span>{rule.words}</span></li>)}</ul>
          <button type="button" className="link-button" onClick={() => onPick("never")}>See these items</button>
        </div>
      )}
    </SectionCard>
  );
}

function SlotRows({ slots, onChange, disabled }) {
  const put = (index, key, value) => onChange(slots.map((slot, at) => (at === index ? { ...slot, [key]: value } : slot)));
  return (
    <div className="os-slots field-wide">
      {slots.map((slot, index) => (
        <div className="os-slot" key={index} role="group" aria-label={`Slot ${index + 1}`}>
          <Field label="From"><input type="time" required value={slot.from} onChange={(event) => put(index, "from", event.target.value)} /></Field>
          <Field label="To"><input type="time" required value={slot.to} onChange={(event) => put(index, "to", event.target.value)} /></Field>
          <Field label="Orders it takes"><input type="number" min="1" max="500" step="1" required value={slot.cap} onChange={(event) => put(index, "cap", event.target.value)} /></Field>
          <button type="button" className="icon-button" aria-label={`Remove slot ${index + 1}`} disabled={disabled} onClick={() => onChange(slots.filter((_, at) => at !== index))}><Icon name="trash" size={16} /></button>
        </div>
      ))}
      <button type="button" className="button button-secondary button-sm" disabled={disabled || slots.length >= 12}
        onClick={() => onChange([...slots, { from: slots.length ? slots[slots.length - 1].to : "10:00", to: "", cap: "10" }])}>
        <Icon name="plus" size={14} /> Add a slot
      </button>
    </div>
  );
}

function SettingsForm({ link, canManage, onSaved }) {
  const biz = useOpenBusiness();
  const start = useMemo(() => formOf(link), [link]);
  const [form, setForm] = useState(start);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(start);
  const set = (key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((now) => ({ ...now, [key]: value }));
  };
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const next = await saveShopSettings(biz.id, link.locationId, bodyOf(form));
      // As the server keeps it (PIN codes in order, amounts as figures).
      setForm(formOf(next));
      setSavedAt(new Date());
      onSaved(next);
      toast.success("Online shop settings saved.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const food = ["grocery", "supermarket", "meat", "weight_retail", "general_retail"].includes(biz.type);
  return (
    <form className="stack" onSubmit={save}>
      <fieldset className="bz-plain-fieldset stack" disabled={!canManage || saving}>
        <SectionCard id="os-delivery" icon="truck" title="Pickup & delivery" description="How customers get their order. Delivery is only to the PIN codes you list.">
          <div className="form-grid">
            <label className="checkbox bz-check"><input type="checkbox" checked={form.pickupEnabled} onChange={set("pickupEnabled")} /> Pickup at the shop</label>
            <Field label="Ready for pickup in (minutes)"><input type="number" min="5" max="720" step="1" required value={form.pickupMinutes} onChange={set("pickupMinutes")} /></Field>
            <label className="checkbox bz-check"><input type="checkbox" checked={form.deliveryEnabled} onChange={set("deliveryEnabled")} /> Home delivery</label>
            <Field label="Delivered in (minutes)"><input type="number" min="10" max="1440" step="1" required value={form.deliveryMinutes} onChange={set("deliveryMinutes")} /></Field>
            <Field label="PIN codes you deliver to" wide hint="6-digit PIN codes, separated by commas or spaces. An address outside them is told delivery does not reach it.">
              <textarea rows={2} className="mono" value={form.deliveryPins} placeholder="560034, 560095" onChange={set("deliveryPins")} />
            </Field>
            <Field label="Delivery area, in words (optional)" wide><input maxLength={300} value={form.deliveryAreaNote} placeholder="Koramangala and HSR Layout, within 3 km of the shop" onChange={set("deliveryAreaNote")} /></Field>
            <Field label={`Delivery charge (${biz.symbol})`} hint="0 for free delivery. Its GST follows the goods in the order."><input type="number" min="0" max="1000" step="0.01" value={form.deliveryFee} onChange={set("deliveryFee")} /></Field>
            <Field label={`Free delivery above (${biz.symbol}, optional)`}><input type="number" min="0" step="0.01" value={form.freeDeliveryAbove} onChange={set("freeDeliveryAbove")} /></Field>
            <Field label={`Minimum order for delivery (${biz.symbol})`}><input type="number" min="0" step="0.01" value={form.minOrder} onChange={set("minOrder")} /></Field>
            <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.slotsEnabled} onChange={set("slotsEnabled")} /> Delivery in time slots the customer picks (today and tomorrow)</label>
            {form.slotsEnabled && (
              <>
                <SlotRows slots={form.slots} disabled={!canManage || saving} onChange={(slots) => setForm((now) => ({ ...now, slots }))} />
                <Field label="Stop taking a slot (minutes before it starts)"><input type="number" min="0" max="720" step="1" value={form.slotCutoffMinutes} onChange={set("slotCutoffMinutes")} /></Field>
              </>
            )}
          </div>
        </SectionCard>
        <SectionCard id="os-orders" icon="receipt" title="Orders" description="When orders come in, and how long a new one waits for you.">
          <div className="form-grid">
            <Field label="Declined by itself if not accepted within (minutes)" hint="The customer is told the shop did not respond in time.">
              <input type="number" min="10" max="240" step="1" required value={form.autoDeclineMinutes} onChange={set("autoDeclineMinutes")} />
            </Field>
            <Field label="Open orders one mobile may have" hint="Stops a mistake, or a prank, from filling your board."><input type="number" min="1" max="10" step="1" required value={form.maxOpenPerMobile} onChange={set("maxOpenPerMobile")} /></Field>
            <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.takeOrdersWhenClosed} onChange={set("takeOrdersWhenClosed")} /> Take orders while the shop is closed (they wait for you to open; the clock starts then)</label>
            <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.hideOutOfStock} onChange={set("hideOutOfStock")} /> Hide items that are out of stock (otherwise they show as out of stock)</label>
            <Field label={'Show "Only a few left" below'} hint="0 never shows it. Exact stock is never shown."><input type="number" min="0" max="1000" step="1" value={form.lowStockBelow} onChange={set("lowStockBelow")} /></Field>
            <Field label="Note for customers (optional)" wide hint="On the shop's page, above the items.">
              <textarea rows={2} maxLength={500} value={form.guestNote} placeholder="Orders after 8 pm are delivered the next morning." onChange={set("guestNote")} />
            </Field>
          </div>
        </SectionCard>
        <SectionCard id="os-payments" icon="money" title="Payments" description="Customers pay when they get their order. No money is taken online.">
          <div className="form-grid">
            <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.payAtShop} onChange={set("payAtShop")} /> Pay at the shop (pickup orders)</label>
            <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.cashOnDelivery} onChange={set("cashOnDelivery")} /> Cash on delivery</label>
            <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.upiOnDelivery} onChange={set("upiOnDelivery")} /> UPI on delivery</label>
            <Field label="UPI ID (optional)" hint="The order slip prints a QR for the exact amount, so the customer pays the right sum.">
              <input maxLength={100} className="mono" value={form.upiId} placeholder="shopname@okbank" autoComplete="off" onChange={set("upiId")} />
            </Field>
            <Field label="Name on UPI (optional)" hint="As the customer's UPI app shows it."><input maxLength={100} value={form.upiPayee} onChange={set("upiPayee")} /></Field>
          </div>
        </SectionCard>
        <SectionCard id="os-seller" icon="shield" title="Seller details & policy" description="Every page of the shop shows them: the law asks an online seller for its customer care, a grievance officer, and its returns, refunds, delivery and payment terms.">
          <div className="form-grid">
            <Field label="Customer care phone"><input maxLength={20} inputMode="tel" value={form.carePhone} onChange={set("carePhone")} /></Field>
            <Field label="Customer care email (optional)"><input type="email" maxLength={150} value={form.careEmail} onChange={set("careEmail")} /></Field>
            <Field label="Grievance officer"><input maxLength={100} value={form.grievanceName} onChange={set("grievanceName")} /></Field>
            <Field label="Designation"><input maxLength={100} value={form.grievanceDesignation} placeholder="Owner" onChange={set("grievanceDesignation")} /></Field>
            <Field label="Grievance officer's phone"><input maxLength={20} inputMode="tel" value={form.grievancePhone} onChange={set("grievancePhone")} /></Field>
            <Field label="Grievance officer's email (optional)"><input type="email" maxLength={150} value={form.grievanceEmail} onChange={set("grievanceEmail")} /></Field>
            {(food || form.fssaiLicence) && (
              <Field label="FSSAI licence number" hint="14 digits. Food sold online shows it.">
                <input maxLength={14} inputMode="numeric" pattern="[0-9]{14}" className="mono" value={form.fssaiLicence} onChange={set("fssaiLicence")} />
              </Field>
            )}
            <Field label="Returns, refunds, exchange, delivery and payment terms" wide hint="Written for your trade to start with. Change it to how your shop works.">
              <textarea rows={10} maxLength={4000} required value={form.policy} onChange={set("policy")} />
            </Field>
          </div>
        </SectionCard>
      </fieldset>
      <SettingsSaveBar dirty={dirty} saving={saving} savedAt={savedAt} error={error} disabled={!canManage} onReset={() => { setForm(start); setError(""); }} />
    </form>
  );
}

const FILTERS = [
  { value: "", label: "All" }, { value: "shown", label: "Showing" }, { value: "hidden", label: "Kept off" },
  { value: "no_photo", label: "No photo" }, { value: "no_maker", label: "No maker details" }, { value: "never", label: "Never online" },
];

function ItemDialog({ item, onClose, onSaved }) {
  const fields = useRef(null);
  return (
    <FormDialog title={`${item.name} online`} icon="store" width={680} submitLabel="Save" onClose={onClose} onSaved={onSaved}
      onSubmit={() => fields.current.save({ productId: item.productId })}>
      <OnlineItemFields ref={fields} productId={item.productId} name={item.name} standalone />
    </FormDialog>
  );
}

function ItemsCard({ link, filter, onFilter, canEdit, onChanged }) {
  const biz = useOpenBusiness();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      shopItems(biz.id, { location: link.locationId, q: q.trim() || undefined, state: filter || undefined, page }, controller.signal)
        .then((next) => { setData(next); setError(""); })
        .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    }, q ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [biz.id, link.locationId, q, filter, page, version]);
  const toggle = async (item) => {
    setBusy(item.skuId);
    try {
      await saveShopItem(biz.id, item.productId, { hidden: !item.hidden });
      toast.success(item.hidden ? `${item.name} shows online again.` : `${item.name} is kept off the online shop.`);
      setVersion((now) => now + 1);
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;
  return (
    <SectionCard id="os-items" icon="box" title="Items online" description="Every item for sale here, with whether customers see it. A photo and the maker's details make an item easier to choose.">
      <div className="os-items-tools">
        <label className="field os-search">
          <span>Search</span>
          <input type="search" value={q} placeholder="Name, code, brand or category" onChange={(event) => { setQ(event.target.value); setPage(1); }} />
        </label>
        <Segmented label="Show" value={filter} options={FILTERS} onChange={(value) => { onFilter(value); setPage(1); }} />
      </div>
      <ErrorMessage message={error} />
      {!data && !error && <Loading label="Reading the items…" />}
      {data && !data.items.length && <EmptyState icon="box" message={q || filter ? "No items match." : "No goods for sale yet."} hint={q || filter ? "Try another search or filter." : "Add items under Products & services."} />}
      {data && data.items.length > 0 && (
        <ul className="os-items">
          {data.items.map((item) => (
            <li key={item.skuId} className={`os-item ${item.shown ? "" : "is-off"}`}>
              <span className="os-item-thumb" aria-hidden="true">
                {item.photo ? <img src={uploadUrl(item.photo.small)} alt="" width="48" height="48" loading="lazy" /> : <span>{item.name.trim().charAt(0).toUpperCase()}</span>}
              </span>
              <span className="os-item-main">
                <strong>{item.name}{item.label && item.label !== item.name ? <span className="muted"> · {item.label}</span> : null}</strong>
                <span className="muted small">{item.code}{item.category ? ` · ${item.category}` : ""} · {biz.exact(item.price)} · {count(item.stock)} {item.unit} in stock</span>
                {item.never && <span className="os-item-why"><Icon name="ban" size={12} /> {item.neverWords}</span>}
                {!item.never && item.categoryHidden && <span className="os-item-why">Its category is kept off the online shop.</span>}
                {!item.never && item.shown && (!item.photo || !item.hasMaker) && <span className="os-item-todo">{[!item.photo && "No photo", !item.hasMaker && "no maker details"].filter(Boolean).join(", ")}</span>}
              </span>
              <span className="os-item-side">
                <Badge tone={item.shown ? "success" : item.never ? "danger" : "neutral"} label={item.shown ? "Showing" : item.never ? "Never online" : "Kept off"} />
                {canEdit && !item.never && (
                  <span className="row-actions">
                    <button type="button" className="chip-button" disabled={busy === item.skuId} onClick={() => toggle(item)}>{item.hidden ? "Show online" : "Keep off"}</button>
                    <button type="button" className="chip-button" onClick={() => setEditing(item)}>Photo & details</button>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && pages > 1 && (
        <div className="os-pager">
          <button type="button" className="button button-secondary button-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted small">Page {page} of {pages} · {count(data.total)} items</span>
          <button type="button" className="button button-secondary button-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
      {editing && <ItemDialog item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast.success("Saved."); setVersion((now) => now + 1); onChanged(); }} />}
    </SectionCard>
  );
}

function CategoriesCard({ canEdit, onChanged }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["categories?active=true"]);
  const [hidden, setHidden] = useState(null);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let live = true;
    hiddenCategories(biz.id).then((flags) => { if (live) setHidden(new Set(flags.hidden)); }).catch((err) => { if (live) setProblem(getErrorMessage(err)); });
    return () => { live = false; };
  }, [biz.id]);
  const list = options?.["categories?active=true"] || [];
  const hiddenRows = list.filter((row) => hidden?.has(Number(row.id)));
  const toggle = async (category, show) => {
    setBusy(category.id);
    try {
      await setCategoryOnline(biz.id, category.id, !show);
      setHidden((now) => { const next = new Set(now); if (show) next.delete(Number(category.id)); else next.add(Number(category.id)); return next; });
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <SectionCard id="os-categories" icon="layers" title="Categories online" description="A category kept off hides every item in it, and in the categories inside it.">
      <ErrorMessage message={error || problem} />
      {(!options || !hidden) && !error && !problem && <Loading />}
      {options && hidden && !list.length && <p className="muted">No categories yet.</p>}
      {options && hidden && list.length > 0 && (
        <ul className="os-category-list">
          {list.map((category) => {
            const parent = hiddenRows.find((row) => row.id !== category.id && String(category.path).startsWith(row.path + PATH_STEP));
            return (
              <li key={category.id}>
                <label className="checkbox">
                  <input type="checkbox" checked={!hidden.has(Number(category.id))} disabled={!canEdit || busy === category.id} onChange={(event) => toggle(category, event.target.checked)} />
                  <span>{category.path}</span>
                </label>
                {parent && !hidden.has(Number(category.id)) && <small className="muted">kept off with {parent.name}</small>}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

function BlockedCard({ canManage }) {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ mobile: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => blockedMobiles(biz.id).then((next) => { setRows(next.blocked); setError(""); }).catch((err) => setError(getErrorMessage(err))), [biz.id]);
  useEffect(() => { load(); }, [load]);
  const block = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await blockMobile(biz.id, { mobile: form.mobile, reason: form.reason.trim() });
      toast.success("Blocked from ordering online.");
      setForm({ mobile: "", reason: "" });
      load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const lift = async (row) => {
    const sure = await confirmAction({ title: `Let ${row.mobile} order again?`, message: "They can place online orders from the shop link again.", confirmLabel: "Let them order", tone: "primary" });
    if (!sure) return;
    try {
      await liftBlock(biz.id, row.id);
      toast.success(`${row.mobile} can order online again.`);
      load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  return (
    <SectionCard id="os-blocked" icon="ban" title="Blocked mobiles" description="A mobile that keeps placing orders it never takes cannot order online until you let it again. They can still buy at the shop.">
      {canManage && (
        <form className="os-block-form" onSubmit={block}>
          <Field label="Mobile"><input required inputMode="tel" maxLength={14} value={form.mobile} placeholder="98xxxxxxxx" onChange={(event) => setForm({ ...form, mobile: event.target.value })} /></Field>
          <Field label="Reason"><input required maxLength={300} value={form.reason} placeholder="Three orders not collected" onChange={(event) => setForm({ ...form, reason: event.target.value })} /></Field>
          <button type="submit" className="button button-secondary" disabled={busy}><Icon name="ban" size={15} /> Block</button>
        </form>
      )}
      <ErrorMessage message={error} />
      {rows && !rows.length && <p className="muted">No mobile is blocked.</p>}
      {rows && rows.length > 0 && (
        <ul className="os-blocked">
          {rows.map((row) => (
            <li key={row.id}>
              <strong className="mono">{row.mobile}</strong>
              <span>{row.reason}</span>
              <span className="muted small">{count(row.orders)} online {row.orders === 1 ? "order" : "orders"} · blocked by {row.blockedBy} on {dateShort(row.blockedAt, { year: true })}</span>
              {canManage && <button type="button" className="link-button" onClick={() => lift(row)}>Let them order again</button>}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export default function OnlineShopSettingsPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const load = useCallback(() => shopSettings(biz.id).then((next) => { setData(next); setError(""); }).catch((err) => setError(getErrorMessage(err))), [biz.id]);
  useEffect(() => { load(); }, [load]);
  const links = data?.links || [];
  const chosen = links.find((row) => String(row.locationId) === params.get("location")) || links[0];
  const canManage = biz.can("online_shop.manage");
  const canEditItems = canManage || biz.can("catalog.edit");
  // A saved change: the link as saved now, then the counts read again.
  const replace = (next) => {
    setData((now) => ({ ...now, links: now.links.map((row) => (row.id === next.id ? { ...row, ...next } : row)) }));
    load();
  };
  const pick = (state) => {
    setFilter(state);
    document.getElementById("os-items")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <div className="stack os-page">
      <BusinessHeader icon="store" title="Online shop"
        description="Your own shop link: customers order from it for pickup or home delivery, and pay when they get their order. New orders arrive under Online orders." />
      <ErrorMessage message={error} />
      {!data && !error && <Loading label="Opening the online shop…" />}
      {data && !links.length && <EmptyState icon="store" message="No open location yet." hint="The online shop sells the stock of one of your locations. Add a location under Settings › Locations." />}
      {chosen && (
        <SettingsLayout sections={SECTIONS}>
          {links.length > 1 && (
            <Segmented label="Shop link of" value={String(chosen.locationId)} options={links.map((row) => ({ value: String(row.locationId), label: row.locationName }))}
              onChange={(value) => setParams({ location: value }, { replace: true })} />
          )}
          <LinkCard link={chosen} canManage={canManage} onChanged={replace} />
          <Readiness link={chosen} onPick={pick} />
          <SettingsForm key={chosen.id} link={chosen} canManage={canManage} onSaved={replace} />
          <ItemsCard link={chosen} filter={filter} onFilter={setFilter} canEdit={canEditItems} onChanged={load} />
          <CategoriesCard canEdit={canEditItems} onChanged={load} />
          <BlockedCard canManage={canManage} />
        </SettingsLayout>
      )}
    </div>
  );
}
