import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import Modal from "../../../../components/Modal";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field, FormError } from "./ui";
import { quantity, useOpenBusiness, useOptions, useServerList } from "./hooks";
import { inPacks, packOf } from "../../wholesale/pages/tradeFormat";
// A farm-input shop's items: what kind of input each is (seeds, fertilisers & pesticides).
import AgriItemFields from "../../agri/pages/AgriItemFields";
import { agriBody, agriFormOf, classOf, kindWord } from "../../agri/pages/agri";
// An optical shop's contact lenses: one item for each power (with Variants on);
// its spectacle lenses keep their details, picked on a spectacle order.
import PowerGridFields from "../../optical/pages/PowerGridFields";
import LensItemFields from "../../optical/pages/LensItemFields";
import { emptyGrid, gridBody, lensItemAttributes, lensItemForm, usesOptical } from "../../optical/pages/optical";
// An item's GST history: its GST rate changes by date (modules/tax-changes).
import TaxHistoryDialog from "../../../tax-changes/pages/TaxHistoryDialog";
import { shopChanges } from "../../../tax-changes/services/taxChanges.service";
import { WORDS, onDate } from "../../../tax-changes/taxChanges";
// The HSN / SAC codes to fix once 6-digit codes apply to the business's PAN (modules/gst-thresholds).
import HsnToFix from "../../../gst-thresholds/pages/HsnToFix";
// The catalogue from an Excel or CSV file, checked row by row first.
import ImportDialog from "./ImportDialog";
// An item's photo, "Show in the online shop" and its online details (modules/business/shop), saved after the item.
import OnlineItemFields from "../../shop/pages/OnlineItemFields";

// Extra details a product may carry, by the module that allows them.
const ATTRIBUTES = {
  variants: [["size", "Size"], ["color", "Colour"], ["fabric", "Fabric"]],
  books: [["isbn", "ISBN"], ["author", "Author"], ["publisher", "Publisher"]],
  serials: [["model", "Model"], ["warrantyMonths", "Warranty (months)"]],
  batches: [["manufacturer", "Manufacturer"], ["packDescription", "Pack description"]],
  // A hardware shop's tile & paint calculators read these.
  hardware_calculators: [["coverageSqftPerUnit", "Tiles: one unit covers (sq ft)"], ["coverageSqftPerLitre", "Paint: one litre covers, one coat (sq ft)"],
    ["litresPerUnit", "Paint: litres in one unit"]],
  // A paint shop's tinting: the base a paint is, which a shade must need.
  hardware_tinting: [["paintBase", "Tinting: the base it is (Pastel, Deep…)"]],
};
// Attributes that are figures; they can also be changed after the item is made.
const FIGURES = ["coverageSqftPerUnit", "coverageSqftPerLitre", "litresPerUnit"];
// Short texts that can also be changed after the item is made.
const CHANGEABLE_TEXTS = ["paintBase"];
const TRACKING = { none: "Not stocked", quantity: "Quantity", batch: "Batch & expiry", serial: "Serial / IMEI" };

// Whether the business's new items start as goods (a shop's) or as services (a
// gym's, a clinic's): its type's, from the platform's Business types.
const goodsFirst = (biz) => (biz.look?.defaultItemKind ?? "goods") === "goods";

export default function CatalogPage() {
  const biz = useOpenBusiness();
  const { t } = biz;
  const [params, setParams] = useSearchParams();
  const [category, setCategory] = useState("");
  const { options } = useOptions(["categories?active=true"]);
  const categories = options?.["categories?active=true"] || [];
  const list = useServerList("catalog", { gridId: "business-catalog", params: category ? { category } : {} });
  const [editing, setEditing] = useState(() => (params.get("new") === "1" && biz.can("catalog.create") ? {} : null));
  const [notice, setNotice] = useState("");
  const [pricing, setPricing] = useState(null);
  const [history, setHistory] = useState(null);
  const [importing, setImporting] = useState(false);
  // Counts the items saved, so the codes to fix follow the fixes.
  const [saved, setSaved] = useState(0);
  const taxChanges = useMemo(() => shopChanges(biz.id), [biz.id]);
  // A branch may sell at its own price once there is more than one.
  const branches = biz.locations.filter((l) => l.active).length > 1;
  const title = t("catalog", "many");
  // Goods kept in stock come with Stock. Their columns (MRP, shelf, stock)
  // show where new items start as goods, and where they start as services
  // once there are goods (a gym's products for sale); until then they wait in
  // the column menu.
  const keepsGoods = biz.has("inventory");
  const startsAsGoods = goodsFirst(biz);
  const [hasGoods, setHasGoods] = useState(false);
  useEffect(() => {
    if (!keepsGoods || startsAsGoods) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "catalog", { kind: "goods", limit: 1 }, controller.signal)
      .then((page) => setHasGoods(page.total > 0)).catch(() => {});
    return () => controller.abort();
  }, [biz.id, keepsGoods, startsAsGoods, saved]);
  const goodsShown = keepsGoods && (startsAsGoods || hasGoods);
  useEffect(() => {
    if (params.get("new")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);

  const columns = useMemo(() => [
    { key: "label", header: t("item"), value: (s) => s.label, mobile: "title", pin: true,
      render: (s) => <span className="bz-two-line"><strong>{s.label}</strong>{s.internal_use ? <small className="muted">Used in services · not sold</small> : s.product_name !== s.label && <small className="muted">{s.product_name}</small>}</span> },
    { key: "code", header: t("item_code"), value: (s) => s.code, className: "mono", mobile: "subtitle" },
    keepsGoods && { key: "barcode", header: "Barcode", value: (s) => s.barcode || "", className: "mono", defaultHidden: true },
    { key: "category", header: "Category", value: (s) => s.category || "" },
    { key: "price", header: biz.settings.tax_mode === "inclusive" ? "Price (incl. tax)" : "Price", type: "money", exact: true, value: (s) => Number(s.price), mobile: "show" },
    keepsGoods && { key: "mrp", header: "MRP", type: "money", exact: true, value: (s) => (s.mrp === null || s.mrp === undefined ? null : Number(s.mrp)), defaultHidden: !goodsShown },
    biz.has("loyalty") && { key: "member_price", header: "Member price", type: "money", exact: true, value: (s) => (s.member_price === null || s.member_price === undefined ? null : Number(s.member_price)) },
    // Its slab now, and a GST rate change still to come.
    { key: "tax", header: "GST", value: (s) => s.tax_rate_name || `${Number(s.tax_rate)}%`,
      render: (s) => <>{s.tax_rate_name || `${Number(s.tax_rate)}%`}{s.tax_change && <small className="txc-next">{s.tax_change.name} from {onDate(s.tax_change.startsOn)}</small>}</> },
    biz.has("agri") && { key: "input_kind", header: "Farm input", value: (s) => kindWord(classOf(s).kind),
      render: (s) => (classOf(s).kind ? `${kindWord(classOf(s).kind)}${classOf(s).subsidised ? " · subsidised" : ""}` : <span className="muted">—</span>) },
    keepsGoods && { key: "shelf", header: "Shelf", value: (s) => s.shelf_location || "", render: (s) => s.shelf_location || <span className="muted">—</span>, defaultHidden: !goodsShown },
    { key: "hsn", header: "HSN / SAC", value: (s) => s.hsn_code || "", className: "mono", defaultHidden: true },
    { key: "unit", header: "Unit", value: (s) => s.unit_name || s.unit },
    keepsGoods && { key: "tracking", header: "Stock tracking", value: (s) => TRACKING[s.tracking], defaultHidden: true },
    keepsGoods && { key: "stock", header: "In stock", type: "number", value: (s) => (s.kind === "service" ? null : Number(s.stock)), defaultHidden: !goodsShown,
      render: (s) => (s.kind === "service" ? <span className="muted">{t("service")}</span> : quantity(s.stock, s.unit)), mobile: "show" },
    // The case price and stock in cases, for goods sold by the pack.
    { key: "case_price", header: "Pack price", type: "money", exact: true, defaultHidden: !biz.has("sales_orders"),
      value: (s) => (packOf(s) ? Number(s.price) * packOf(s).factor : null), render: (s) => (packOf(s) ? `${biz.exact(Number(s.price) * packOf(s).factor)} / ${packOf(s).unit}` : <span className="muted">—</span>) },
    { key: "in_packs", header: "In packs", defaultHidden: !biz.has("sales_orders"), value: (s) => (packOf(s) ? inPacks(s.stock, s.unit, packOf(s).unit, packOf(s).factor) : ""),
      render: (s) => (packOf(s) && s.kind !== "service" ? inPacks(s.stock, s.unit, packOf(s).unit, packOf(s).factor) : <span className="muted">—</span>) },
    { key: "active", header: "Status", type: "status", value: (s) => (s.active ? "active" : "inactive"), render: (s) => <ActiveBadge active={s.active} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => (
      <span className="bz-row-actions">
        {biz.can("catalog.edit") && <button type="button" className="chip-button" onClick={() => setEditing(s)}>Edit</button>}
        {biz.can("catalog.edit") && branches && <button type="button" className="chip-button" onClick={() => setPricing(s)}>Branch prices</button>}
        {!s.is_kit && <button type="button" className="chip-button" onClick={() => setHistory(s)}>GST history</button>}
      </span>
    ) },
  ], [biz, branches, t, keepsGoods, goodsShown]);

  return (
    <div className="stack">
      <BusinessHeader icon="tag" title={title}
        description={`Your ${t.lower("catalog")}: every ${t.lower("item")} with its price, GST slab${keepsGoods ? ", category and stock" : " and category"}. Changing a price never changes a bill already posted.`}
        secondary={biz.can("catalog.create") && <button type="button" className="button button-secondary" onClick={() => setImporting(true)}><Icon name="upload" size={16} /> Import from Excel or CSV</button>}
        primary={biz.can("catalog.create") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add {t.lower("item")}</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <HsnToFix onEdit={setEditing} refreshKey={saved} />
      <SectionCard flush icon="list" title={`All ${t.lower("item", "many")}`}>
        <DataGrid {...list.gridProps} caption={title} columns={columns.filter(Boolean)} currency={biz.symbol}
          toolbar={categories.length > 0 && (
            <label className="field">
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
              </select>
            </label>
          )}
          exportName={biz.can("catalog.export") ? `${biz.business.code}-catalogue` : undefined}
          rowClassName={(s) => (!s.active ? "dg-tone-muted" : s.kind === "goods" && Number(s.reorder_level) > 0 && Number(s.stock) <= Number(s.reorder_level) ? "dg-tone-warning" : "")}
          empty={`Nothing in your ${t.lower("catalog")} yet`} emptyIcon="tag" />
      </SectionCard>
      {editing && <CatalogDialog sku={editing} onClose={() => setEditing(null)}
        onSaved={(s) => { setEditing(null); setNotice(`${s.label} saved.`); list.reload(); setSaved((n) => n + 1); }} />}
      {pricing && <BranchPricesDialog sku={pricing} onClose={() => setPricing(null)}
        onSaved={(n) => { setPricing(null); setNotice(n ? `${pricing.label}: ${n === 1 ? "one branch price" : `${n} branch prices`} changed.` : "No branch price changed."); }} />}
      {history && <TaxHistoryDialog api={taxChanges} words={WORDS.shop} itemId={history.id} label={history.label} canEdit={biz.can("catalog.edit")} currency={biz.symbol}
        onClose={() => setHistory(null)} onChanged={() => list.reload()} />}
      {importing && <ImportDialog kind="products" onClose={() => setImporting(false)}
        onImported={(message) => { setImporting(false); setNotice(message); list.reload(); setSaved((n) => n + 1); }} />}
    </div>
  );
}

function CatalogDialog({ sku, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { t } = biz;
  const editing = Boolean(sku.id);
  const { options, error } = useOptions(["units?active=true", "tax-rates?active=true", "categories?active=true", ...(biz.has("variants") && !editing ? ["catalog"] : [])]);
  // The online shop's part of the item, when the shop is on (its save follows the item's own).
  const online = useRef(null);
  const units = options?.["units?active=true"] || [];
  const slabs = options?.["tax-rates?active=true"] || [];
  const categories = options?.["categories?active=true"] || [];
  // The kinds a new item may be, the one it starts as first: goods kept in
  // stock (with Stock on) in the business's own word for them, and services.
  const kinds = [biz.has("inventory") && ["goods", `${t("goods")} (kept in stock)`], ["service", t("service")]].filter(Boolean);
  if (!goodsFirst(biz)) kinds.reverse();
  const [form, setForm] = useState(() => ({
    name: "", productId: "", label: sku.label || "", code: "", barcode: sku.barcode || "", kind: sku.kind || kinds[0][0], unit: kinds[0][0] === "service" ? "service" : "each",
    // Medicines, seeds and pesticides are sold by batch (lot, expiry).
    tracking: ["pharmacy", "agri_inputs"].includes(biz.type) ? "batch" : "quantity", price: sku.price || "", taxRateId: sku.tax_rate_id ? String(sku.tax_rate_id) : "",
    categoryId: sku.category_id ? String(sku.category_id) : "", brand: "", reorderLevel: sku.reorder_level ? String(Number(sku.reorder_level)) : "", active: sku.active ?? true,
    mrp: sku.mrp ? String(Number(sku.mrp)) : "", hsnCode: sku.hsn_code || "",
    shelfLocation: sku.shelf_location || "", memberPrice: sku.member_price ? String(Number(sku.member_price)) : "",
    internalUse: Boolean(sku.internal_use),
    ...Object.fromEntries([...FIGURES, ...CHANGEABLE_TEXTS].map((key) => [key, sku.attributes?.[key] ? String(sku.attributes[key]) : ""])),
    agri: agriFormOf(sku),
    lensGrid: emptyGrid(),
    lensItem: lensItemForm(sku),
    // Stock already on the shelf when the item is added.
    openingQuantity: "", openingCost: "", openingLocation: String(biz.locations.find((l) => l.active)?.id || ""), openingLot: "", openingExpiry: "",
  }));
  const canOpening = !editing && biz.has("inventory") && biz.can("inventory.edit");
  // A business whose items start as services, or that books appointments,
  // keeps some stock only to use in them (its consumables).
  const usedInServices = !goodsFirst(biz) || biz.has("appointments");
  const set = (name) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [name]: value, ...(name === "kind" ? { unit: value === "service" ? "service" : "each" } : {}) }));
  };
  const defaultSlab = slabs.find((slab) => slab.is_default);
  const taxRateId = form.taxRateId || (editing ? "" : String(defaultSlab?.id || ""));
  const attributeFields = biz.context.capabilities.flatMap((cap) => ATTRIBUTES[cap] || []);
  // The details that may change after the item is made: figures and a few short texts.
  const figureFields = attributeFields.filter(([key]) => FIGURES.includes(key) || CHANGEABLE_TEXTS.includes(key));
  const unitChoices = units.filter((u) => (form.kind === "service" ? ["time", "service"].includes(u.kind) : !["time", "service"].includes(u.kind)));
  const products = [...new Map((options?.catalog || []).map((s) => [s.product_id, s.product_name])).entries()];
  // A farm-input shop's goods carry what kind of input they are (the whole classification, every save).
  const agri = biz.has("agri") && form.kind === "goods";
  const agriAttributes = agri ? agriBody(form.agri) : {};
  const { agri: _agriForm, lensGrid: _lensGrid, lensItem: _lensItem, ...fields } = form;
  // A contact lens made as one item for each power (an optical shop with Variants on).
  const lensGridOffered = !editing && form.kind === "goods" && usesOptical(biz) && biz.has("variants");
  const grid = lensGridOffered && form.lensGrid.on;
  // A spectacle lens's details (an optical shop's goods; not a contact lens made by powers).
  const lensItemOffered = form.kind === "goods" && usesOptical(biz) && !grid && !sku.attributes?.baseCurve;
  const lensAttributes = lensItemOffered ? lensItemAttributes(form.lensItem, { editing, was: lensItemForm(sku) }) : {};
  // A service carries none of the goods' details, even ones typed before its kind was changed.
  const goodsDetails = form.kind === "goods" ? {} : { barcode: "", brand: "", mrp: "", shelfLocation: "", reorderLevel: 0 };
  const examples = { name: t.ex("item_name"), variant: t.ex("variant"), shelf: t.ex("shelf"), consumables: t.ex("consumables"),
    service: t.ex("service_item"), goods: t.ex("goods_item") };
  // What each kind means, in the business's own examples.
  const kindHints = {
    service: `Work you do or time you sell. Nothing is counted in stock.${examples.service ? ` e.g. ${examples.service}` : ""}`,
    goods: `Something you sell from the shelf. Stock goes down with each sale.${examples.goods ? ` e.g. ${examples.goods}` : ""}`,
  };
  // The code in the business's word, but goods at a business whose items are
  // services (a gym's protein powder) take a plain "Item code", not "Plan code".
  const codeLabel = goodsFirst(biz) || form.kind === "service" ? t("item_code") : "Item code";
  // The name's example: the first of the chosen kind's, else the business's item.
  const nameExample = examples[form.kind]?.split(",")[0].trim() || examples.name;
  const namePlaceholder = nameExample ? `e.g. ${nameExample}` : undefined;
  // A gym's, studio's or coaching centre's plans are made in Membership plans, not here.
  const plansElsewhere = !editing && biz.type === "memberships" && biz.can("member_plans.view");

  const submit = () => (grid
    ? businessWrite(biz.id, "optical/power-grid", gridBody(form, taxRateId)).then((r) => ({ ...r, label: `${r.product.name}: ${r.created} ${r.created === 1 ? "power" : "powers"}` }))
    : editing
    ? businessWrite(biz.id, `catalog/${sku.id}`, { label: form.label, price: form.price, taxRateId: taxRateId || undefined, taxRate: taxRateId ? undefined : sku.tax_rate,
      categoryId: form.categoryId || null, reorderLevel: form.reorderLevel || 0, active: form.active, mrp: form.mrp, hsnCode: form.hsnCode, barcode: form.barcode,
      shelfLocation: form.shelfLocation, ...(biz.has("loyalty") ? { memberPrice: form.memberPrice } : {}), ...(usedInServices ? { internalUse: form.internalUse } : {}),
      ...(figureFields.length || agri || Object.keys(lensAttributes).length ? { attributes: { ...Object.fromEntries(figureFields.map(([key]) => [key, form[key] || ""])), ...agriAttributes, ...lensAttributes } } : {}) }, "patch")
    : businessWrite(biz.id, "catalog", {
      ...fields, taxRateId: taxRateId || undefined, categoryId: form.categoryId || undefined, productId: form.productId || undefined, reorderLevel: form.reorderLevel || 0, ...goodsDetails,
      attributes: { ...Object.fromEntries(attributeFields.map(([key]) => [key, form[key] || ""])), ...agriAttributes, ...lensAttributes },
      ...(canOpening && form.kind === "goods" && form.tracking !== "serial" && Number(form.openingQuantity) > 0 ? { openingStock: {
        quantity: form.openingQuantity, unitCost: form.openingCost || "0", locationId: form.openingLocation,
        ...(form.tracking === "batch" ? { lotCode: form.openingLot, expiresOn: form.openingExpiry || undefined } : {}),
      } } : {}),
    }));

  return (
    <FormDialog title={editing ? `Edit ${sku.label}` : `Add ${t.a("item")}`} icon="tag" width={720} onClose={onClose} onSaved={onSaved} onSubmit={() => submit().then((saved) => (online.current ? online.current.save(saved) : saved))} disabled={!options}>
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      {plansElsewhere && (
        <p className="bz-note field-wide">
          <Icon name="idCard" size={16} />
          <span>
            <strong>Selling a membership?</strong> Plans with their months, sessions, freezes and renewals are made in{" "}
            {biz.can("member_plans.edit") ? <Link to={biz.path("member-plans")}>Settings › Membership plans</Link> : "Settings › Membership plans"}.
            Add here the other things you charge for{examples.service ? `: ${examples.service}` : ""}{biz.has("inventory") && examples.goods ? `, and what you sell: ${examples.goods}` : ""}.
          </span>
        </p>
      )}
      {!editing && (
        <>
          <Field label={`${t("item")} name`} wide>
            <input required maxLength={150} value={form.name} onChange={set("name")} placeholder={namePlaceholder} />
          </Field>
          {/* The kind first, each with what it means: the fields below follow it. */}
          <fieldset className="bz-kinds field-wide">
            <legend>What is it?</legend>
            {kinds.map(([value, label]) => (
              <label key={value} className={`bz-kind${form.kind === value ? " is-on" : ""}`}>
                <input type="radio" name="item-kind" value={value} checked={form.kind === value} onChange={set("kind")} />
                <span className="bz-two-line">
                  <span>{label}</span>
                  <small className="muted">{kindHints[value]}</small>
                </span>
              </label>
            ))}
            {!biz.has("inventory") && <small className="muted">To sell {t.lower("goods", "many")} kept in stock, an owner switches Stock on under Settings › Business tools.</small>}
          </fieldset>
          <Field label={form.kind === "service" ? "Charged per" : "Stock counted in"}
            hint={form.kind === "service" ? "How the price is counted: once, an hour, a session or a month." : "How you count it in stock: Each (piece) for packs and bottles, Kilogram or Litre for loose goods."}>
            <select required value={form.unit} onChange={set("unit")}>
              {unitChoices.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}
            </select>
          </Field>
          {biz.has("variants") && products.length > 0 && (
            <Field label="Variant of (optional)" hint={`Pick ${t.a("item")} to add this as one of its variants.`} wide>
              <select value={form.productId} onChange={set("productId")}>
                <option value="">A new {t.lower("item")}</option>
                {products.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </Field>
          )}
          {lensGridOffered && <PowerGridFields value={form.lensGrid} adding={Boolean(form.productId)} onChange={(next) => setForm((f) => ({ ...f, lensGrid: next }))} />}
          {!grid && (
            <Field label="Name on the bill (optional)" hint={biz.has("variants") && examples.variant ? `For a variant: e.g. “${examples.variant}”.` : undefined}>
              <input maxLength={150} value={form.label} onChange={set("label")} />
            </Field>
          )}
          {grid
            ? <Field label="Code prefix" hint="Each power's code: the prefix and the power (AO6-M250 for -2.50)."><input required={!form.productId} maxLength={20} value={form.code} onChange={set("code")} className="mono" /></Field>
            : <Field label={codeLabel} hint="A short code of your own, to find it fast when billing.">
              <input required maxLength={60} value={form.code} onChange={set("code")} className="mono" />
            </Field>}
          {!grid && form.kind === "goods" && <Field label="Barcode (optional)"><input maxLength={80} value={form.barcode} onChange={set("barcode")} className="mono" /></Field>}
          {form.kind === "goods" && (
            <Field label="Stock tracking">
              <select value={form.tracking} onChange={set("tracking")}>
                <option value="quantity">Quantity only</option>
                {biz.has("batches") && <option value="batch">Batch & expiry</option>}
                {biz.has("serials") && <option value="serial">Serial / IMEI number</option>}
              </select>
            </Field>
          )}
          {form.kind === "goods" && <Field label="Brand (optional)"><input maxLength={100} value={form.brand} onChange={set("brand")} /></Field>}
        </>
      )}
      {editing && <Field label="Name on the bill" wide><input required maxLength={150} value={form.label} onChange={set("label")} /></Field>}
      {editing && sku.kind !== "service" && (
        <Field label="Barcode (optional)" hint={sku.barcode ? "Change it to the code printed on the pack, or clear it. Two items never share one." : "The code printed on the pack; scanning it bills this item."}>
          <input maxLength={80} value={form.barcode} onChange={set("barcode")} className="mono" />
        </Field>
      )}
      <Field label={biz.settings.tax_mode === "inclusive" ? "Selling price (including GST)" : "Selling price (before GST)"}
        hint={editing && packOf(sku) && Number(form.price) > 0 ? `${biz.exact(Number(form.price) * packOf(sku).factor)} a ${packOf(sku).unit} of ${packOf(sku).factor}` : undefined}>
        <input required type="number" min="0" step="0.01" value={form.price} onChange={set("price")} />
      </Field>
      {form.kind === "goods" && (
        <Field label="MRP (optional)" hint="Printed on the pack, GST included. The item is never billed above it.">
          <input type="number" min="0" step="0.01" value={form.mrp} onChange={set("mrp")} />
        </Field>
      )}
      <Field label="GST slab">
        <select value={taxRateId} onChange={set("taxRateId")}>
          {editing && !sku.tax_rate_id && <option value="">{Number(sku.tax_rate)}% (no slab)</option>}
          {slabs.map((slab) => <option key={slab.id} value={slab.id}>{slab.name}</option>)}
        </select>
      </Field>
      <Field label={form.kind === "service" ? "SAC code (optional)" : "HSN code (optional)"} hint="4, 6 or 8 digits, printed on the tax invoice.">
        <input inputMode="numeric" pattern="[0-9]{4}([0-9]{2}){0,2}" title="4, 6 or 8 digits" maxLength={8} value={form.hsnCode} onChange={set("hsnCode")} className="mono" />
      </Field>
      <Field label="Category">
        <select value={form.categoryId} onChange={set("categoryId")}>
          <option value="">None</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
        </select>
      </Field>
      {form.kind === "goods" && <Field label="Reorder level" hint="Shown as low on stock at or below this; purchase orders suggest topping up to it."><input type="number" min="0" step="0.001" value={form.reorderLevel} onChange={set("reorderLevel")} /></Field>}
      {form.kind === "goods" && (
        <Field label="Shelf location (optional)" hint={examples.shelf ? `Where it sits, e.g. “${examples.shelf}”.` : "Where it sits."}>
          <input maxLength={40} value={form.shelfLocation} onChange={set("shelfLocation")} />
        </Field>
      )}
      {biz.has("loyalty") && (
        <Field label="Member price (optional)" hint={`What a loyalty ${t.lower("customer")} pays when the bill names them. Below the selling price.`}>
          <input type="number" min="0" step="0.01" value={form.memberPrice} onChange={set("memberPrice")} />
        </Field>
      )}
      {canOpening && form.kind === "goods" && form.tracking !== "serial" && !grid && (
        <div className="bz-opening" role="group" aria-labelledby="opening-stock-title">
          <p className="bz-opening-title" id="opening-stock-title"><strong>Opening stock</strong> <span className="muted">(optional)</span></p>
          <p className="muted small">What is already on the shelf. It goes into stock at once, with “Opening stock” as the reason in the stock movements.</p>
          <div className="bz-opening-grid">
            <Field label={`Quantity (${form.unit})`}><input type="number" min="0" step="0.001" value={form.openingQuantity} onChange={set("openingQuantity")} /></Field>
            <Field label="Cost price (each, optional)" hint="What you paid; it values the stock."><input type="number" min="0" step="0.01" value={form.openingCost} onChange={set("openingCost")} /></Field>
            {biz.locations.filter((l) => l.active).length > 1 && (
              <Field label="At">
                <select value={form.openingLocation} onChange={set("openingLocation")}>
                  {biz.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            )}
            {form.tracking === "batch" && (
              <>
                <Field label="Batch number"><input maxLength={100} required={Number(form.openingQuantity) > 0} value={form.openingLot} onChange={set("openingLot")} className="mono" /></Field>
                <Field label="Expiry date (optional)"><input type="date" value={form.openingExpiry} onChange={set("openingExpiry")} /></Field>
              </>
            )}
          </div>
        </div>
      )}
      {agri && <AgriItemFields biz={biz} value={form.agri} onChange={(next) => setForm((f) => ({ ...f, agri: next }))} tracking={editing ? sku.tracking : form.tracking} />}
      {lensItemOffered && <LensItemFields value={form.lensItem} onChange={(next) => setForm((f) => ({ ...f, lensItem: next }))} />}
      {(editing ? figureFields : grid ? [] : attributeFields).map(([key, label]) => (
        <Field key={key} label={label}>
          {FIGURES.includes(key)
            ? <input type="number" inputMode="decimal" min="0.01" step="0.01" value={form[key] || ""} onChange={set(key)} />
            : <input maxLength={150} value={form[key] || ""} onChange={set(key)} />}
        </Field>
      ))}
      {usedInServices && form.kind === "goods" && (
        <label className="checkbox bz-check field-wide">
          <input type="checkbox" checked={form.internalUse} onChange={set("internalUse")} /> For use in services only, not sold{examples.consumables ? ` (e.g. ${examples.consumables})` : ""}. It stays out of the bill.
        </label>
      )}
      {biz.has("online_shop") && (biz.can("catalog.edit") || biz.can("online_shop.manage")) && form.kind === "goods" && !grid && (
        <OnlineItemFields ref={online} productId={editing ? sku.product_id : null} name={editing ? sku.product_name || sku.label : form.name} />
      )}
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active (switched-off items cannot be sold)</label>}
    </FormDialog>
  );
}

// A price per branch: a branch left empty sells at the item's own price.
function BranchPricesDialog({ sku, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `catalog/${sku.id}/branch-prices`, undefined, controller.signal)
      .then((data) => setRows(data.branches.map((b) => ({ ...b, value: b.price ? String(Number(b.price)) : "" }))))
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, sku.id]);
  const save = async () => {
    setSaving(true); setError("");
    try {
      const result = await businessWrite(biz.id, `catalog/${sku.id}/branch-prices`, { prices: rows.map((r) => ({ locationId: r.location_id, price: r.value })) }, "put");
      onSaved(result.changed);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally { setSaving(false); }
  };
  return (
    <Modal title={`Branch prices · ${sku.label}`} icon="tag" width={520} onClose={onClose}
      description={`Each branch sells at ${biz.exact(sku.price)} unless it has its own price. Offers, member prices and customer prices still apply.`}
      footer={<>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="button" onClick={save} disabled={!rows || saving}>{saving ? "Saving…" : "Save prices"}</button>
      </>}>
      <ErrorMessage message={error} />
      {!rows && !error && <Loading />}
      {rows && (
        <div className="form-grid">
          {rows.map((r) => (
            <Field key={r.location_id} label={r.location_name} hint={r.value ? "Its own price" : `Sells at ${biz.exact(sku.price)}`}>
              <input type="number" min="0" step="0.01" placeholder={String(Number(sku.price))} value={r.value}
                onChange={(e) => setRows((all) => all.map((x) => (x.location_id === r.location_id ? { ...x, value: e.target.value } : x)))} />
            </Field>
          ))}
        </div>
      )}
    </Modal>
  );
}
