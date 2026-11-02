import { useEffect, useImperativeHandle, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { getErrorMessage, uploadUrl } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { hiddenCategories, removeShopPhoto, saveShopItem, setCategoryOnline, shopItem, uploadShopPhoto } from "../services/onlineShop.service";
import { shopPhotoSizes } from "./onlineShop";
import "../styles/online-shop.css";

// The online shop's part of an item, in the item editor (Products & services,
// an item) and on Settings › Online shop: its photo, whether it shows in the
// shop, and the details the law asks a shop to show online for packaged goods
// (Legal Metrology: who made, packed or imported it and where, the country of
// origin, the net quantity, consumer care), with why a rule keeps it off if
// one does. Saved after the item itself, through the ref's save(result): the
// result of the item's own save names a new item's product. A failure here
// leaves the item saved and says so (standalone: the caller shows it).

const DETAILS = ["description", "makerName", "makerAddress", "countryOfOrigin", "genericName", "netQuantity", "consumerCare", "bestBefore"];
const EMPTY = { hidden: false, makerKind: "", ...Object.fromEntries(DETAILS.map((key) => [key, ""])) };
const formOf = (row) => (row ? { hidden: Boolean(row.hidden), makerKind: row.makerKind || "", ...Object.fromEntries(DETAILS.map((key) => [key, row[key] || ""])) } : EMPTY);
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_UPLOAD = 2 * 1024 * 1024;

export default function OnlineItemFields({ ref, productId = null, name = "", standalone = false }) {
  const biz = useOpenBusiness();
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState(null);
  const [dropPhoto, setDropPhoto] = useState(false);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (!productId) return undefined;
    let live = true;
    shopItem(biz.id, productId)
      .then((row) => { if (live) { setSaved(row); setForm(formOf(row)); } })
      .catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [biz.id, productId]);
  useEffect(() => () => { if (photo?.preview) URL.revokeObjectURL(photo.preview); }, [photo]);

  useImperativeHandle(ref, () => ({
    async save(result) {
      const id = productId || result?.product_id || result?.productId;
      if (!id) return result;
      try {
        const before = formOf(saved);
        const changed = Object.fromEntries(Object.entries(form).filter(([key, value]) => value !== before[key]));
        if (Object.keys(changed).length) await saveShopItem(biz.id, id, changed);
        if (photo) await uploadShopPhoto(biz.id, id, photo);
        else if (dropPhoto && saved?.photo) await removeShopPhoto(biz.id, id);
      } catch (err) {
        // On its own (Settings › Online shop) the dialog shows the refusal; in the item editor the item itself is saved already.
        if (standalone) throw err;
        toast.warning(`The item is saved; its online shop details are not: ${getErrorMessage(err)}`);
      }
      return result;
    },
  }), [biz.id, productId, saved, form, photo, dropPhoto, standalone]);

  const set = (key) => (event) => {
    const value = event.target.type === "checkbox" ? !event.target.checked : event.target.value;
    setForm((now) => ({ ...now, [key]: value }));
  };
  const pick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!TYPES.includes(file.type)) { setError("Choose a JPG, PNG or WEBP photo."); return; }
    setError("");
    setPreparing(true);
    try {
      const sizes = await shopPhotoSizes(file);
      if (sizes.large.size > MAX_UPLOAD) { setError("This photo is too large to send: choose one under 2 MB, or take it at a lower size."); return; }
      setPhoto({ ...sizes, preview: URL.createObjectURL(sizes.small || sizes.large) });
      setDropPhoto(false);
    } finally {
      setPreparing(false);
    }
  };

  const never = saved?.never || [];
  const shownPhoto = photo ? photo.preview : !dropPhoto && saved?.photo ? uploadUrl(saved.photo.small || saved.photo.large) : null;
  const initial = (saved?.name || name || "?").trim().charAt(0).toUpperCase();
  return (
    <fieldset className="os-item-fields field-wide">
      <legend><Icon name="store" size={16} /> Online shop</legend>
      {error && <p className="alert">{error}</p>}
      {never.length > 0 && (
        <div className="os-never" role="note">
          <Icon name="ban" size={16} />
          <div>
            <strong>Never sold online</strong>
            {never.map((rule) => <p key={rule.skuId}>{never.length > 1 ? `${rule.label}: ` : ""}{rule.words}</p>)}
          </div>
        </div>
      )}
      <div className="os-item-top">
        <div className="os-photo" aria-hidden={!shownPhoto}>
          {shownPhoto ? <img src={shownPhoto} alt={`Photo of ${saved?.name || name || "the item"}`} width="96" height="96" /> : <span className="os-photo-initial">{initial}</span>}
        </div>
        <div className="os-item-photo-actions">
          <label className={`button button-secondary button-sm ${preparing ? "is-busy" : ""}`}>
            <Icon name="upload" size={14} /> {shownPhoto ? "Change photo" : "Add a photo"}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={pick} disabled={preparing} />
          </label>
          {shownPhoto && <button type="button" className="link-button" onClick={() => { setPhoto(null); setDropPhoto(true); }}>Remove photo</button>}
          <small className="muted">A clear picture of the product on a plain background. It is made smaller on this device before it is sent.</small>
        </div>
      </div>
      {never.length === 0 && (
        <label className="checkbox bz-check">
          <input type="checkbox" checked={!form.hidden} onChange={set("hidden")} /> Show in the online shop
        </label>
      )}
      {saved?.categoryHidden && !form.hidden && <p className="muted small">Its category is kept off the online shop, so it does not show until the category shows again.</p>}
      <details className="os-details" open={DETAILS.some((key) => form[key]) || undefined}>
        <summary>Details shown online <span className="muted">(for packaged goods)</span></summary>
        <p className="muted small">What the law asks a shop to show online for packaged goods: who made, packed or imported it, the country of origin, the net quantity and consumer care.</p>
        <div className="form-grid">
          <Field label="Short description" wide><textarea rows={2} maxLength={500} value={form.description} onChange={set("description")} /></Field>
          <Field label="Made, packed or imported">
            <select value={form.makerKind} onChange={set("makerKind")}>
              <option value="">Choose</option>
              <option value="manufacturer">Manufactured by</option>
              <option value="packer">Packed by</option>
              <option value="importer">Imported by</option>
            </select>
          </Field>
          <Field label="Their name"><input maxLength={150} value={form.makerName} onChange={set("makerName")} /></Field>
          <Field label="Their address" wide><input maxLength={300} value={form.makerAddress} onChange={set("makerAddress")} /></Field>
          <Field label="Country of origin"><input maxLength={60} value={form.countryOfOrigin} placeholder="India" onChange={set("countryOfOrigin")} /></Field>
          <Field label="Common or generic name"><input maxLength={150} value={form.genericName} onChange={set("genericName")} /></Field>
          <Field label="Net quantity"><input maxLength={40} value={form.netQuantity} placeholder="500 g" onChange={set("netQuantity")} /></Field>
          <Field label="Best before"><input maxLength={100} value={form.bestBefore} placeholder="9 months from packing" onChange={set("bestBefore")} /></Field>
          <Field label="Consumer care" wide><input maxLength={200} value={form.consumerCare} placeholder="The maker's phone or email for complaints" onChange={set("consumerCare")} /></Field>
        </div>
      </details>
    </fieldset>
  );
}

// "Show in the online shop" on a category (with its sub-categories), in the
// category editor. Saved after the category itself, through the ref.
export function OnlineCategoryField({ ref, categoryId = null }) {
  const biz = useOpenBusiness();
  const [hidden, setHidden] = useState(categoryId ? null : false);
  const [was, setWas] = useState(false);
  useEffect(() => {
    if (!categoryId) return undefined;
    let live = true;
    hiddenCategories(biz.id)
      .then((flags) => { if (live) { const now = flags.hidden.includes(Number(categoryId)); setWas(now); setHidden(now); } })
      .catch(() => { if (live) setHidden(false); });
    return () => { live = false; };
  }, [biz.id, categoryId]);
  useImperativeHandle(ref, () => ({
    async save(result) {
      const id = categoryId || result?.id;
      if (id && hidden !== null && hidden !== was) {
        try { await setCategoryOnline(biz.id, id, hidden); } catch (err) { toast.warning(`The category is saved; whether it shows online is not: ${getErrorMessage(err)}`); }
      }
      return result;
    },
  }), [biz.id, categoryId, hidden, was]);
  return (
    <label className="checkbox bz-check field-wide">
      <input type="checkbox" checked={hidden === false} disabled={hidden === null} onChange={(event) => setHidden(!event.target.checked)} /> Show in the online shop, with its sub-categories
    </label>
  );
}
