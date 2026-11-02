import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../components/Feedback";
import { businessRead } from "../../services/business.service";
import { toast } from "../../services/toast";
import { useSales } from "./salesContext";
import { DAY_NAMES } from "./salesRules";
import { locate } from "./salesLocation";

// A shop that is not a customer yet, added in the field: checked against the
// shops on this phone (and, with the network, every customer) by mobile and
// GSTIN; made with no credit — cash on delivery — and marked "added from the
// field", waiting for the office to approve it and set its credit. Its place
// is the phone's, when the day has started and the business records places.
// Consent to bills on WhatsApp is asked, never ticked for them.
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const digitsOf = (value) => String(value || "").replace(/\D/g, "").slice(-10);

export default function SalesNewShopPage() {
  const sales = useSales();
  const navigate = useNavigate();
  const beats = sales.pack?.beats || [];
  const [form, setForm] = useState({ name: "", contactPerson: "", phone: "", gstin: "", address: "", beatId: String(sales.beats.today[0]?.id || "") });
  const [usePlace, setUsePlace] = useState(true);
  const [consent, setConsent] = useState(false);
  const [checked, setChecked] = useState({ key: "", rows: [] });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: key === "gstin" ? e.target.value.toUpperCase() : e.target.value }));
  const phone = digitsOf(form.phone);
  const gstin = form.gstin.trim();
  const canPlace = sales.settings?.record_places !== false && sales.started && !sales.ended;

  // The same shop on this phone already, by mobile or GSTIN.
  const local = useMemo(() => sales.shops.filter((s) => (phone.length === 10 && digitsOf(s.phone) === phone) || (gstin.length === 15 && String(s.gstin || "").toUpperCase() === gstin)), [sales.shops, phone, gstin]);
  // ...and, with the network, every customer of the business.
  const checkKey = `${phone.length === 10 ? phone : ""}|${gstin.length === 15 ? gstin : ""}`;
  const remote = checked.key === checkKey ? checked.rows : [];
  useEffect(() => {
    if (!sales.online || checkKey === "|") return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const [byPhone, byGstin] = checkKey.split("|");
      businessRead(sales.businessId, "sales/shops/check", { ...(byPhone ? { phone: byPhone } : {}), ...(byGstin ? { gstin: byGstin } : {}) }, controller.signal)
        .then((rows) => setChecked({ key: checkKey, rows })).catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sales.online, sales.businessId, checkKey]);
  const same = [...local, ...remote.filter((r) => !local.some((l) => l.id === r.id))];

  const issue = !form.name.trim() ? "Enter the shop's name"
    : form.phone.trim() && !/^[6-9]\d{9}$/.test(phone) ? "Enter a 10-digit mobile that starts with 6, 7, 8 or 9, or leave it empty"
      : gstin && !GSTIN.test(gstin) ? "A GSTIN has 15 characters, like 27AAPFU0939F1ZV"
        : !form.address.trim() ? "Enter the address with a landmark" : same.length ? "This shop is already a customer" : null;

  const save = async (event) => {
    event.preventDefault();
    if (issue) return;
    setBusy(true);
    setProblem("");
    try {
      const place = canPlace && usePlace ? await locate() : null;
      const entry = await sales.actions.addShop({
        name: form.name.trim(), address: form.address.trim(), ...(form.contactPerson.trim() ? { contactPerson: form.contactPerson.trim() } : {}),
        ...(phone ? { phone } : {}), ...(gstin ? { gstin } : {}), ...(form.beatId ? { beatId: Number(form.beatId) } : {}),
        ...(place?.latitude ? { place } : {}), ...(sales.pack?.settings?.privacy_notice ? { consents: { bills_digital: consent } } : {}),
      });
      toast.success(`${form.name.trim()} added: cash only until the office approves it`);
      navigate(`/sales/${sales.businessId}/shops/n${entry.id}`, { replace: true });
    } catch (err) {
      setProblem(err?.message || "The shop could not be kept on this phone.");
      setBusy(false);
    }
  };

  return (
    <form className="sl-page" onSubmit={save} noValidate>
      <div className="sl-shop-head">
        <Link to={`/sales/${sales.businessId}/shops`} className="sl-back" aria-label="Back to shops"><Icon name="undo" size={18} /></Link>
        <div>
          <h1 className="sl-title">Add a new shop</h1>
          <p className="muted small">The office approves it and sets its credit; until then it buys for cash.</p>
        </div>
      </div>
      <label className="field"><span>Shop name</span><input value={form.name} onChange={set("name")} maxLength={150} autoComplete="off" required /></label>
      <label className="field"><span>Owner or contact person</span><input value={form.contactPerson} onChange={set("contactPerson")} maxLength={100} autoComplete="off" /></label>
      <div className="sl-two">
        <label className="field"><span>Mobile (optional)</span><input inputMode="tel" value={form.phone} onChange={set("phone")} maxLength={16} autoComplete="off" /></label>
        <label className="field"><span>GSTIN (optional)</span><input value={form.gstin} onChange={set("gstin")} maxLength={15} autoComplete="off" /></label>
      </div>
      {same.length > 0 && (
        <div className="alert alert-notice" role="alert">
          Already a customer: {same.map((s) => (
            <Link key={s.id || s.ref} to={`/sales/${sales.businessId}/shops/${s.ref || `c${s.id}`}`}>{s.name}{s.beat_name ? ` (${s.beat_name})` : ""}</Link>
          )).reduce((all, link, i) => (i ? [...all, ", ", link] : [link]), [])}. Visit that shop instead.
        </div>
      )}
      <label className="field"><span>Address with a landmark</span><textarea rows={2} value={form.address} onChange={set("address")} maxLength={500} required /></label>
      <label className="field">
        <span>Beat</span>
        <select value={form.beatId} onChange={set("beatId")}>
          <option value="">Not on a beat yet</option>
          {beats.map((b) => <option key={b.id} value={b.id}>{b.name}{b.visit_day ? ` · ${DAY_NAMES[b.visit_day - 1]}` : ""}</option>)}
        </select>
      </label>
      {canPlace && (
        <label className="checkbox sl-check">
          <input type="checkbox" checked={usePlace} onChange={(e) => setUsePlace(e.target.checked)} />
          <span>Save where I am as the shop&apos;s place<small className="muted">Only if you are at the shop now.</small></span>
        </label>
      )}
      {sales.pack?.settings?.privacy_notice && (
        <label className="checkbox sl-check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>The shop agrees to get its bills and receipts on WhatsApp<small className="muted">Ask them, after showing the business&apos;s privacy notice.</small></span>
        </label>
      )}
      {issue && (form.name || form.address) && <p className="sl-issue" role="status">{issue}</p>}
      <ErrorMessage message={problem} />
      <button type="submit" className="button sl-wide" disabled={busy || Boolean(issue)}><Icon name="plus" size={17} /> {busy ? "Adding…" : "Add the shop"}</button>
    </form>
  );
}
