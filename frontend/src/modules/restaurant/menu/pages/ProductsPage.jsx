import SellingRulesModal from "./SellingRulesModal";
import ServiceOptionsModal from './ServiceOptionsModal';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { count, money } from "../../../../services/format";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import ActionMenu from "../../../../components/ActionMenu";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  createProduct,
  deleteProduct,
  getProductUsage,
  listCategories,
  exportMenu,
  listProducts,
  listTaxRates,
  removeProductImage,
  uploadProductImage,
  setProductAvailability,
  setProductStatus,
  patchProduct,
} from "../services/menu.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage, uploadUrl } from "../../../../services/api";
import { downloadCsv } from "../../../../services/csv";
import useAuth from "../../../../hooks/useAuth";
import ProductExtrasModal from "./ProductExtrasModal";
import RecipeModal from "./RecipeModal";
import ComboModal from "./ComboModal";
import MenuImportModal from "./MenuImportModal";
import PrintMenuModal from "./PrintMenuModal";
import SheetImportModal from "../../inventory/pages/SheetImportModal";
import { getRecipeImportGuide, importRecipes } from "../services/recipe.service";
import PriceRevisionModal from "./PriceRevisionModal";
import ProductHistoryModal from "./ProductHistoryModal";
import { EMPTY_FORM, buildPatch, formToPayload, productToForm, rebaseForm, withPhoto } from "./productForm";
import "../../../../styles/menu.css";
import "../../inventory/styles/stock-pro.css";
import SearchPicker from "../../../../components/SearchPicker";
import useQueryFilter from "../../../../hooks/useQueryFilter";

const FOOD_TYPE_LABELS = { veg: "Veg", non_veg: "Non-veg", egg: "Egg" };

// The square-and-dot mark printed on Indian menus: green for veg, red for
// non-veg, amber for egg. The word sits beside it in the Type column; on a
// phone, where that column folds away, the mark carries the word itself.
function FoodMark({ type, className = "", labelled = false }) {
  const label = FOOD_TYPE_LABELS[type] || type;

  return (
    <span
      className={`mnu-food mnu-food-${type} ${className}`.trim()}
      title={label}
      {...(labelled ? { role: "img", "aria-label": label } : { "aria-hidden": "true" })}
    />
  );
}

// Why a combo's part cannot be made right now, in a few words.
const partProblem = (part) =>
  part.reason === "size_off"
    ? `${part.name} (${part.size}) switched off`
    : part.reason === "archived"
      ? `${part.name} off the menu`
      : `${part.name} sold out`;

// Which dishes the list shows. "On the menu" is the working view; sold out
// and archived are one tap away, and the tiles above double as these filters.
const VIEWS = [
  { key: "menu", label: "On the menu", test: (p) => p.status === "active" },
  { key: "soldout", label: "Sold out", test: (p) => p.status === "active" && !p.isAvailable },
  { key: "archived", label: "Archived", test: (p) => p.status !== "active" },
  // Dishes on the menu with nothing in their recipe: they never take stock
  // off the shelf, and their food cost reads ₹0 everywhere. Only with Stock &
  // recipes on.
  { key: "norecipe", label: "No recipe", test: (p) => p.status === "active" && p.hasRecipe === false, recipes: true },
  { key: "all", label: "All", test: () => true },
];

// The food-cost line the Recipe dialog draws: above 35% of the price is high.
const FOOD_COST_TARGET = 35;

export default function ProductsPage() {
  const { hasPermission, hasFeature } = useAuth();
  const canManage = hasPermission("menu.manage");
  // Recipes are part of Stock & recipes (Settings -> Features).
  const recipesOn = hasFeature("stock_recipes");
  // Sold out / back on is its own permission: the kitchen and captains have
  // it without being able to change prices.
  const canSwitch = hasPermission("menu.availability");
  const canSeeHistory = hasPermission("audit.view");

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [currency, setCurrency] = useState("₹");
  const [taxRates, setTaxRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  // In the address bar, so "dishes with no recipe" on Dish profitability can
  // open this list already showing them (?show=norecipe).
  const [viewParam, setView] = useQueryFilter("show", "menu");
  const views = VIEWS.filter((item) => !item.recipes || recipesOn);
  const view = views.some((item) => item.key === viewParam) ? viewParam : "menu";

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  // Set when the save was refused because someone else changed the dish
  // meanwhile: every field they changed, and whether the manager had typed a
  // change to it too (the form keeps what was typed, and shows the rest).
  const [formClash, setFormClash] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [archiveOffer, setArchiveOffer] = useState(null);
  const [comboNotice, setComboNotice] = useState(null);
  const [switching, setSwitching] = useState(null);
  const [importing, setImporting] = useState(false);
  // Print menu (an A4 card for one outlet and service) and recipes for many
  // dishes from one spreadsheet (sweeps SW-B-20, SW-B-12).
  const [printingMenu, setPrintingMenu] = useState(false);
  const [importingRecipes, setImportingRecipes] = useState(false);
  const [revising, setRevising] = useState(false);
  // A photo belongs to a saved dish, so it is uploaded straight away rather
  // than held until the form is submitted.
  const [photoBusy, setPhotoBusy] = useState(false);
  const [extrasFor, setExtrasFor] = useState(null);
  const [sellingFor, setSellingFor] = useState(null);
  const [serviceFor, setServiceFor] = useState(null);
  const [recipeFor, setRecipeFor] = useState(null);
  const [comboFor, setComboFor] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);

  // Every list request gets a number; only the answer to the newest one is
  // shown. The search box asks once per key typed and a slow answer can land
  // after a quick one (the whole menu after one category), which would
  // otherwise leave the list showing an older filter than the one on screen.
  const latestLoad = useRef(0);
  const costFlag = recipesOn ? "true" : "";

  // Rebuilt whenever a filter changes, so the effect below re-runs the search.
  const load = useCallback(() => {
    const ticket = latestLoad.current + 1;
    latestLoad.current = ticket;
    const current = () => ticket === latestLoad.current;

    return listProducts({
      categoryId: categoryFilter || undefined,
      search: search.trim() || undefined,
      // Whether each dish has a recipe, and what a plate costs (for those
      // allowed to see recipe costs).
      withCost: costFlag || undefined,
    })
      .then((rows) => current() && setProducts(rows))
      .catch((err) => current() && setError(getErrorMessage(err)))
      .finally(() => current() && setLoading(false));
  }, [categoryFilter, search, costFlag]);

  const loadCategories = useCallback(
    () =>
      listCategories()
        .then(setCategories)
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    loadCategories();

    // Settings give the currency symbol shown against every price.
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);

    // The rate list fills the picker and decides what a new dish starts with.
    listTaxRates()
      .then(setTaxRates)
      .catch(() => setTaxRates([]));
  }, [loadCategories]);

  // Re-runs when a filter changes, so the list always matches the filters.
  useEffect(() => {
    load();
  }, [load]);

  const tallies = useMemo(
    () => ({
      menu: products.filter(VIEWS[0].test).length,
      soldout: products.filter(VIEWS[1].test).length,
      archived: products.filter(VIEWS[2].test).length,
      blocked: products.filter((p) => p.status === "active" && p.isCombo && (p.unavailableParts || []).length > 0 && p.isAvailable).length,
      norecipe: products.filter((p) => p.status === "active" && p.hasRecipe === false).length,
    }),
    [products]
  );

  const shown = useMemo(() => {
    const rule = VIEWS.find((item) => item.key === view) || VIEWS[0];
    return products.filter(rule.test);
  }, [products, view]);

  const replaceRow = (updated) =>
    setProducts((rows) => rows.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)));

  const openNew = () => {
    const fallback = taxRates.find((rate) => rate.isDefault) || taxRates[0];

    setForm({
      ...EMPTY_FORM,
      categoryId: categories[0] ? String(categories[0].id) : "",
      taxRateId: fallback ? String(fallback.id) : "",
    });
    setFormError("");
    setFormClash(null);
    setEditing({});
  };

  const openEdit = (product) => {
    setForm(productToForm(product));
    setFormError("");
    setFormClash(null);
    setEditing(product);
  };

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  // An edit sends only what the manager changed, with what those fields said
  // when the form opened (productForm.js). The kitchen marking the dish sold
  // out, or a price revision, while the form is open is therefore kept, never
  // undone by a save that did not touch it. If someone changed one of the
  // same fields meanwhile, the server refuses; the form is then brought up to
  // date (their changes shown, the manager's typing kept) and a second Save
  // sends only the manager's own changes.
  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setFormClash(null);
    setSaving(true);

    const payload = formToPayload(form);

    try {
      if (editing.id) {
        const patch = buildPatch(form, editing);

        if (Object.keys(patch.changes).length === 0) {
          setSuccess(`Nothing changed on "${editing.name}"`);
        } else {
          await patchProduct(editing.id, patch.changes, patch.original);
          setSuccess(`"${payload.name}" saved`);
        }
      } else {
        await createProduct(payload);
        setSuccess(`"${payload.name}" added to the menu`);
      }

      setEditing(null);
      load();
    } catch (err) {
      const response = err.response && err.response.data;

      if (response && response.data && response.data.reason === "changed_meanwhile" && response.data.current) {
        const current = response.data.current;
        const rebased = rebaseForm(form, editing, current);

        setForm(rebased.form);
        setEditing(current);
        replaceRow(current);
        setFormClash(rebased.meanwhile);
      } else {
        setFormError(getErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  // One line per field someone else changed while the form was open, in the
  // form's own words, and what the form does about it.
  const clashLine = (item) => {
    const rateName = (id) => {
      const rate = taxRates.find((row) => row.id === id);
      return id ? (rate ? rate.name : "another rate") : "No tax";
    };
    const categoryName = (id) => (categories.find((row) => row.id === id) || { name: "another category" }).name;
    const show = {
      price: (value) => money(value, currency),
      isAvailable: (value) => (value ? "on sale" : "sold out"),
      status: (value) => (value === "active" ? "on the menu" : "archived"),
      categoryId: categoryName,
      taxRateId: rateName,
      foodType: (value) => FOOD_TYPE_LABELS[value] || value,
      code: (value) => value || "empty",
      description: (value) => (value ? `“${value}”` : "empty"),
      name: (value) => `“${value}”`,
      sortOrder: (value) => String(value),
      kitchenName: (value) => (value ? `“${value}”` : "empty"),
    }[item.key];
    const label = {
      price: "The price",
      isAvailable: "It",
      status: "It",
      categoryId: "The category",
      taxRateId: "The tax rate",
      foodType: "It",
      code: "The short code",
      description: "The description",
      name: "The name",
      sortOrder: "The display order",
      kitchenName: "The kitchen name",
    }[item.key];
    const verb = item.key === "foodType" ? "is now marked" : "is now";
    const now = `${label} ${verb} ${show(item.now)}`;

    if (!item.mine) {
      return { key: item.key, text: `${now}. The form shows this now.`, mine: false };
    }

    if (item.typed === item.now) {
      return { key: item.key, text: `${now}, the same as you typed.`, mine: false };
    }

    return { key: item.key, text: `${now}. You typed ${show(item.typed)}.`, mine: true };
  };

  // The whole menu as a spreadsheet, in the shape the import accepts back.
  const exportToCsv = async () => {
    try {
      const data = await exportMenu();

      downloadCsv(
        [data.columns, ...data.rows.map((row) => data.columns.map((column) => row[column]))],
        `menu-${new Date().toLocaleDateString("en-CA")}.csv`
      );
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const choosePhoto = async (event) => {
    const file = event.target.files && event.target.files[0];

    // Clearing the input lets the same file be chosen again after a failure.
    event.target.value = "";

    if (!file || !editing.id) {
      return;
    }

    setFormError("");
    setPhotoBusy(true);

    try {
      const updated = await uploadProductImage(editing.id, file);
      setEditing((base) => withPhoto(base, updated));
      replaceRow(updated);
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setPhotoBusy(false);
    }
  };

  const dropPhoto = async () => {
    setFormError("");
    setPhotoBusy(true);

    try {
      const updated = await removeProductImage(editing.id);
      setEditing((base) => withPhoto(base, updated));
      replaceRow(updated);
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setPhotoBusy(false);
    }
  };

  // Sold out during service, back on later. Marking a dish sold out names the
  // combos it is part of: a thali cannot be served without its dal, so the
  // screen offers to switch those off in the same breath.
  const toggleAvailability = async (product) => {
    setError("");
    setSwitching(product.id);

    try {
      const { combos, ...updated } = await setProductAvailability(product.id, !product.isAvailable);
      replaceRow(updated);

      const affected = (combos || []).filter((combo) => combo.isAvailable && combo.status === "active");

      if (!updated.isAvailable && affected.length > 0) {
        setComboNotice({ product: updated, combos: affected });
      } else if (comboNotice && comboNotice.product.id === product.id) {
        setComboNotice(null);
      }

      // Combos' "part sold out" flags depend on this dish.
      if (combos && combos.length > 0) {
        load();
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSwitching(null);
    }
  };

  const soldOutCombos = async () => {
    const { product, combos } = comboNotice;
    setComboNotice(null);

    try {
      for (const combo of combos) {
        await setProductAvailability(combo.id, false);
      }

      setSuccess(`${combos.map((combo) => combo.name).join(", ")} marked sold out along with ${product.name}`);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const changeStatus = async (product, status) => {
    setError("");

    try {
      const result = await setProductStatus(product.id, status);
      setSuccess(result.message);
      replaceRow(result.data);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  // A dish that has been sold cannot be deleted (past bills need it), and one
  // a combo uses must come out of the combo first. Asked before the dialog
  // opens, so the choice offered is the one that will work: archive instead.
  const startDelete = async (product) => {
    setError("");

    try {
      const usage = await getProductUsage(product.id);

      if (usage.canDelete) {
        setDeleting(product);
      } else {
        setArchiveOffer({ product, message: usage.message, canArchive: usage.canArchive });
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  // The server checks again (an order may have come in since), and its
  // refusal carries the same archive offer.
  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteProduct(deleting.id);
      setSuccess(`"${deleting.name}" deleted`);
      setDeleting(null);
      load();
      loadCategories();
    } catch (err) {
      const response = err.response && err.response.data;

      if (response && response.data && response.data.reason) {
        setArchiveOffer({ product: deleting, message: response.message, canArchive: Boolean(response.data.canArchive) });
      } else {
        setError(getErrorMessage(err));
      }

      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const archiveInstead = async () => {
    const { product } = archiveOffer;
    setArchiveOffer(null);
    await changeStatus(product, "inactive");
  };


  // The figures double as the list's filters: a tap shows those dishes.
  const tiles = [
    { key: "menu", icon: "utensils", tone: "primary", label: "On the menu", value: tallies.menu, note: "active dishes" },
    {
      key: "soldout",
      icon: "ban",
      tone: tallies.soldout > 0 ? "warning" : "neutral",
      label: "Sold out now",
      value: tallies.soldout,
      note: "switched off for service",
    },
    { key: "archived", icon: "box", tone: "neutral", label: "Archived", value: tallies.archived, note: "kept for past bills" },
  ];

  const viewLabel = (VIEWS.find((item) => item.key === view) || VIEWS[0]).label.toLowerCase();
  const pickedCategory = categories.find((category) => String(category.id) === String(categoryFilter)) || null;

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew} disabled={categories.length === 0}>
      <Icon name="plus" size={16} /> Add product
    </button>
  );

  // The list's columns. Edit stays on the row; everything else is in its menu.
  const columns = [
    {
      key: "dish",
      header: "Dish",
      value: (product) => product.name,
      mobile: "title",
      pin: true,
      filter: "text",
      width: 320,
      render: (product) => {
        const archived = product.status !== "active";
        const blockedParts = product.isCombo ? product.unavailableParts || [] : [];

        return (
          <div className="product-cell">
            {product.imagePath ? (
              <img className="product-thumb" src={uploadUrl(product.imagePath)} alt="" loading="lazy" />
            ) : (
              <span className="product-thumb product-thumb-empty mnu-thumb-empty" aria-hidden="true">
                <Icon name="utensils" size={16} />
              </span>
            )}
            <span className="mnu-dish-text">
              <span className="mnu-dish-line">
                <span className="mnu-dish">{product.name}</span>
                {product.isCombo && <span className="badge badge-info mnu-tag">Combo</span>}
                {archived && <span className="badge badge-neutral mnu-tag">Archived</span>}
              </span>
              {product.code && <span className="muted small mono mnu-code">{product.code}</span>}
              {blockedParts.length > 0 && (
                <span className="mnu-part-warn">
                  <Icon name="alert" size={14} />
                  Can’t be served: {blockedParts.map(partProblem).join(", ")}
                </span>
              )}
            </span>
          </div>
        );
      },
    },
    { key: "code", header: "Short code", value: (product) => product.code, defaultHidden: true },
    {
      key: "category",
      header: "Category",
      value: (product) => product.categoryName,
      filter: "select",
      mobile: "subtitle",
    },
    {
      key: "type",
      header: "Type",
      value: (product) => product.foodType,
      filter: "select",
      filterOptions: Object.entries(FOOD_TYPE_LABELS).map(([value, label]) => ({ value, label })),
      csv: (product) => FOOD_TYPE_LABELS[product.foodType] || product.foodType,
      mobile: "show",
      render: (product) => (
        <span className="nowrap">
          <FoodMark type={product.foodType} />
          {FOOD_TYPE_LABELS[product.foodType]}
        </span>
      ),
    },
    {
      key: "price",
      header: "Price",
      type: "money",
      value: (product) => Number(product.price),
      mobile: "show",
      render: (product) => <strong>{money(product.price, currency)}</strong>,
    },
    recipesOn && {
      key: "foodcost",
      header: "Food cost",
      // Sorts by the share of the price; a dish with no recipe sorts first
      // (most in need of one), a combo last.
      value: (product) => (product.hasRecipe === false ? -1 : product.foodCostPercent ?? null),
      csv: (product) =>
        product.hasRecipe === false
          ? "No recipe"
          : product.plateCost === null || product.plateCost === undefined
            ? ""
            : `${product.plateCost} (${product.foodCostPercent ?? "—"}%)`,
      align: "left",
      width: 150,
      mobile: "show",
      render: (product) => {
        if (product.isCombo || product.hasRecipe === null || product.hasRecipe === undefined) {
          return <span className="muted">—</span>;
        }

        if (product.hasRecipe === false) {
          return (
            <button
              type="button"
              className="link-button"
              onClick={() => setRecipeFor(product)}
              title="Nothing in its recipe: it takes no stock and its food cost reads ₹0"
            >
              <span className="badge badge-warning status-badge">
                <span className="badge-dot" aria-hidden="true" />
                No recipe
              </span>
            </button>
          );
        }

        if (product.plateCost === null || product.plateCost === undefined) {
          return (
            <button type="button" className="link-button" onClick={() => setRecipeFor(product)}>
              Recipe set
            </button>
          );
        }

        const high = product.foodCostPercent !== null && product.foodCostPercent > FOOD_COST_TARGET;

        return (
          <button
            type="button"
            className={`link-button mnu-cost${high ? " is-high" : ""}`}
            onClick={() => setRecipeFor(product)}
            title={`${money(product.plateCost, currency)} of ingredients a plate at today's costs${
              high ? ` — above ${FOOD_COST_TARGET}% of the price` : ""
            }. Opens the recipe.`}
          >
            <span>{money(product.plateCost, currency)}</span>
            {product.foodCostPercent !== null && <span className="mnu-cost-pct">· {product.foodCostPercent}%</span>}
          </button>
        );
      },
    },
    {
      key: "tax",
      header: "GST",
      type: "percent",
      value: (product) => Number(product.taxPercentage),
      mobile: "hide",
      render: (product) => (
        <span className="nowrap">
          {product.taxPercentage}%
          {product.hsnCode && <div className="muted small mono">{product.hsnCode}</div>}
        </span>
      ),
    },
    {
      key: "sale",
      header: "On sale",
      // The switch and its word ("On sale" / "Sold out") side by side.
      minWidth: 130,
      // Sorts and filters by the words on the badge or switch.
      value: (product) => (product.status !== "active" ? "Off the menu" : product.isAvailable ? "On sale" : "Sold out"),
      filter: "select",
      mobile: "show",
      render: (product) => {
        const archived = product.status !== "active";

        return canSwitch && !archived ? (
          <label className={`mnu-switch${product.isAvailable ? " is-on" : ""}`}>
            <input
              type="checkbox"
              role="switch"
              checked={product.isAvailable}
              disabled={switching === product.id}
              onChange={() => toggleAvailability(product)}
              aria-label={`${product.name} on sale`}
            />
            <span className="mnu-switch-track" aria-hidden="true" />
            <span className="mnu-switch-text">{product.isAvailable ? "On sale" : "Sold out"}</span>
          </label>
        ) : (
          <span className={`badge status-badge ${archived ? "badge-neutral" : product.isAvailable ? "badge-active" : "badge-warning"}`}>
            <span className="badge-dot" aria-hidden="true" />
            {archived ? "Off the menu" : product.isAvailable ? "On sale" : "Sold out"}
          </span>
        );
      },
    },
    canManage && {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      // Editing is the common one, so it stays in reach; the rest live behind
      // the menu, which keeps Delete away from everything else.
      render: (product) => {
        const archived = product.status !== "active";

        return (
          <div className="row-actions">
            <button type="button" className="chip-button" onClick={() => openEdit(product)}>
              <Icon name="edit" size={14} /> Edit
            </button>

            <ActionMenu
              label={`More actions for ${product.name}`}
              items={[
                { label: "Sizes & add-ons", icon: "layers", onClick: () => setExtrasFor(product) },
                { label: "Prices & outlets", icon: "store", onClick: () => setSellingFor(product) },
                { label: "Serving times & combo choices", icon: "clock", onClick: () => setServiceFor(product) },
                ...(recipesOn ? [{ label: "Recipe", icon: "book", onClick: () => setRecipeFor(product) }] : []),
                { label: "Combo", icon: "cloche", onClick: () => setComboFor(product) },
                ...(canSeeHistory ? [{ label: "Change history", icon: "history", onClick: () => setHistoryFor(product) }] : []),
                { separator: true },
                archived
                  ? { label: "Bring back to the menu", icon: "undo", onClick: () => changeStatus(product, "active") }
                  : { label: "Archive", icon: "box", onClick: () => changeStatus(product, "inactive") },
                {
                  label: "Delete",
                  icon: "trash",
                  danger: true,
                  onClick: () => startDelete(product),
                },
              ]}
            />
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack mnu-page">
      <PageHeader
        icon="utensils"
        title="Products"
        description="Your dishes and drinks: price, tax, and what is on sale right now."
        action={
          <div className="header-actions">
            <button type="button" className="button button-secondary" onClick={() => setPrintingMenu(true)}>
              <Icon name="print" size={16} /> Print menu
            </button>
            {/* The whole menu in the import file's layout (to edit and import
                back); the grid's own Export CSV gives the list as shown. */}
            <button
              type="button"
              className="button button-secondary"
              onClick={exportToCsv}
              title="Every dish in the import file's layout, to edit and import back"
            >
              <Icon name="download" size={16} /> Export for import
            </button>
            {canManage && (
              <button type="button" className="button button-secondary" onClick={() => setImporting(true)}>
                <Icon name="upload" size={16} /> Import CSV
              </button>
            )}
            {canManage && recipesOn && (
              <button type="button" className="button button-secondary" onClick={() => setImportingRecipes(true)}>
                <Icon name="layers" size={16} /> Import recipes
              </button>
            )}
            {canManage && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setRevising(true)}
                disabled={categories.length === 0}
              >
                <Icon name="percent" size={16} /> Revise prices
              </button>
            )}
            {addButton}
          </div>
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {comboNotice && (
        <div className="alert alert-notice mnu-notice-row" role="status">
          <span>
            <strong>{comboNotice.product.name}</strong> is part of{" "}
            {comboNotice.combos.map((combo) => combo.name).join(", ")}, which can’t be served without it.
          </span>
          <span className="mnu-notice-actions">
            <button type="button" className="button button-secondary button-sm" onClick={soldOutCombos}>
              Mark {comboNotice.combos.length === 1 ? "it" : `all ${comboNotice.combos.length}`} sold out too
            </button>
            <button type="button" className="link-button" onClick={() => setComboNotice(null)}>
              Leave on sale
            </button>
          </span>
        </div>
      )}

      {categories.length === 0 && !loading && (
        <div className="alert">Create a category first; every product belongs to one.</div>
      )}

      {!loading && products.length > 0 && (
        <div className="stat-grid mnu-tiles">
          {tiles.map((tile) => (
            <StatTile
              key={tile.key}
              icon={tile.icon}
              tone={tile.tone}
              label={tile.label}
              value={count(tile.value)}
              note={tile.note}
              className={`mnu-pick${view === tile.key ? " is-active" : ""}`}
              title={`Show ${tile.label.toLowerCase()}`}
              onClick={() => setView(tile.key)}
            />
          ))}
          {tallies.blocked > 0 && (
            <div className="mnu-contents" role="status">
              <StatTile
                icon="alert"
                tone="danger"
                label="Combos that can’t be served"
                value={count(tallies.blocked)}
                note="a part is sold out or switched off"
                className="mnu-alarm"
              />
            </div>
          )}
        </div>
      )}

      <SectionCard
        icon="list"
        title="Dishes"
        description={
          loading
            ? undefined
            : `${count(shown.length)} ${shown.length === 1 ? "dish" : "dishes"} ${viewLabel === "all" ? "in all" : viewLabel}.${
                // Only where the switch is: archived dishes have none.
                canSwitch && (view === "menu" || view === "soldout")
                  ? " Switch On sale off when the kitchen runs out of a dish."
                  : ""
              }`
        }
        className="mnu-list"
        flush
      >
        <div className="filters mnu-toolbar">
          {/* Hundreds of categories on a big menu: type to find one. */}
          <SearchPicker
            label="Category"
            value={pickedCategory}
            onChange={(category) => setCategoryFilter(category ? String(category.id) : "")}
            options={categories}
            getLabel={(category) => category.name}
            placeholder="All categories"
            emptyText="No category by that name"
          />

          <label className="field mnu-search">
            <span>Search</span>
            <span className="input-with-icon">
              <Icon name="search" size={16} className="input-icon" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or code"
              />
            </span>
          </label>

          <div className="field mnu-show">
            <span>Show</span>
            <div className="segmented" role="tablist" aria-label="Show">
              {views.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={view === item.key}
                  className={`segment${view === item.key ? " is-active" : ""}`}
                  onClick={() => setView(item.key === "menu" ? "" : item.key)}
                  title={item.key === "norecipe" ? "Dishes on the menu with nothing in their recipe" : undefined}
                >
                  {item.label}
                  {item.key === "norecipe" && tallies.norecipe > 0 ? ` · ${count(tallies.norecipe)}` : ""}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* The filters above ask the server (category, name or code) and pick
            the view; the grid pages what they leave, 25 / 50 / 100 at a time
            (a big menu runs to thousands of dishes). */}
        <DataGrid
          id="menu-products"
          caption="Dishes"
          columns={columns}
          rows={shown}
          rowKey={(product) => product.id}
          loading={loading}
          empty={products.length === 0 ? "No products match." : "Nothing in this view."}
          emptyIcon={view === "soldout" || view === "norecipe" ? "check-circle" : view === "archived" ? "box" : "utensils"}
          emptyHint={
            view === "norecipe"
              ? "Every dish on the menu has a recipe."
              : view === "soldout"
              ? "Every dish on the menu is on sale."
              : view === "archived"
                ? "Dishes you archive stay here with their sales history."
                : products.length === 0 && (search.trim() || categoryFilter)
                  ? "Try another name or short code, or choose All categories."
                  : undefined
          }
          emptyAction={products.length === 0 && categories.length > 0 && !search.trim() && !categoryFilter ? addButton : undefined}
          rowClassName={(product) => (product.status !== "active" ? "dg-tone-muted" : "")}
          currency={currency}
          rowNoun={["dish", "dishes"]}
          search={false}
          exportName="menu-dishes"
        />
      </SectionCard>

      {editing && (
        <Modal
          title={editing.id ? "Edit product" : "Add product"}
          description={
            editing.id
              ? "Changes reach the POS and the QR menu as soon as you save."
              : "It goes on the POS and the QR menu as soon as you save."
          }
          icon={editing.id ? "edit" : "plus"}
          onClose={() => setEditing(null)}
          width={640}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />
            {formClash && (
              <div className="alert alert-notice field-wide mnu-clash" role="alert">
                <strong>Someone changed this dish while you had it open. Nothing was saved.</strong>
                <ul className="mnu-clash-list">
                  {formClash.map(clashLine).map((line) => (
                    <li key={line.key} className={line.mine ? "is-mine" : ""}>
                      {line.text}
                    </li>
                  ))}
                </ul>
                <span>
                  {formClash.map(clashLine).some((line) => line.mine)
                    ? "Save again to use what you typed, or Cancel to keep the dish as it is now."
                    : "Check the form, then Save again to apply your changes."}
                </span>
              </div>
            )}

            <p className="section-heading field-wide">Name and price</p>

            <label className="field">
              <span>Name *</span>
              <input value={form.name} onChange={change("name")} required autoFocus maxLength={150} />
            </label>

            <label className="field">
              <span>Category *</span>
              <select value={form.categoryId} onChange={change("categoryId")} required>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Price ({currency}) *</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.price}
                onChange={change("price")}
                required
              />
              {editing.id && Number(form.price) !== Number(editing.price) && form.price !== "" && (
                <small className="muted">
                  Was {money(editing.price, currency)}. Sizes keep their difference from this price.
                </small>
              )}
            </label>

            <label className="field">
              <span>Tax rate</span>
              <select value={form.taxRateId} onChange={change("taxRateId")}>
                <option value="">No tax</option>
                {taxRates
                  .filter((rate) => rate.status === "active" || String(rate.id) === form.taxRateId)
                  .map((rate) => (
                    <option key={rate.id} value={rate.id}>
                      {rate.name} — {rate.percentage}%
                      {rate.hsnCode ? ` (${rate.hsnCode})` : ""}
                      {rate.status !== "active" ? " (switched off)" : ""}
                    </option>
                  ))}
              </select>
              <small className="muted">Rates and HSN codes are set under Menu → Tax rates</small>
            </label>

            <label className="field">
              <span>Price includes tax</span>
              <select value={form.taxMode} onChange={change("taxMode")}>
                <option value="default">Use restaurant setting</option>
                <option value="inclusive">Yes, tax is included</option>
                <option value="exclusive">No, add tax</option>
              </select>
            </label>

            <label className="field">
              <span>MRP ({currency})</span>
              <input type="number" min="0" step="0.01" value={form.mrp} onChange={change("mrp")} placeholder="Optional maximum price" />
              <small className="muted">The selling price cannot exceed this amount.</small>
            </label>

            <p className="section-heading field-wide">How it shows on the menu</p>

            <label className="field">
              <span>Food type</span>
              <select value={form.foodType} onChange={change("foodType")}>
                <option value="veg">Veg</option>
                <option value="non_veg">Non-veg</option>
                <option value="egg">Egg</option>
              </select>
            </label>

            <label className="field">
              <span>Short code</span>
              <input value={form.code} onChange={change("code")} maxLength={30} placeholder="ST01" />
            </label>

            <label className="field">
              <span>Display order</span>
              <input type="number" min="0" value={form.sortOrder} onChange={change("sortOrder")} />
            </label>

            {/* Whether the dish is on the menu at all, and whether it can be
                ordered right now, side by side: they are the two switches a
                manager reaches for together. */}
            <div className="field mnu-status-field">
              <label className="field">
                <span>Status</span>
                <select value={form.status} onChange={change("status")}>
                  <option value="active">On the menu</option>
                  <option value="inactive">Archived (off the POS and QR menu)</option>
                </select>
              </label>
              <label className="checkbox mnu-onsale-line">
                <input
                  type="checkbox"
                  checked={form.isAvailable}
                  onChange={(event) => setForm({ ...form, isAvailable: event.target.checked })}
                />
                <span>
                  On sale right now <span className="muted">(untick when sold out)</span>
                </span>
              </label>
            </div>

            <label className="field">
              <span>Description</span>
              <textarea rows={3} value={form.description} onChange={change("description")} />
            </label>

            {/* SW-A-12: the name the cooks read on the KOT, in their own script. */}
            <label className="field">
              <span>Kitchen name</span>
              <input
                value={form.kitchenName}
                onChange={change("kitchenName")}
                maxLength={150}
                placeholder="e.g. पनीर टिक्का"
              />
              <small className="muted">
                Optional, in any language. Printed on KOTs and the kitchen screen; the bill keeps the name above.
              </small>
            </label>

            <div className="field">
              <span>Photo</span>
              {editing.id ? (
                <div className="photo-field mnu-photo">
                  {editing.imagePath ? (
                    <img
                      className="photo-preview"
                      src={uploadUrl(editing.imagePath)}
                      alt={`${form.name} photo`}
                    />
                  ) : (
                    <span className="photo-preview photo-preview-empty mnu-photo-empty">
                      <Icon name="utensils" size={20} />
                      No photo
                    </span>
                  )}
                  <div className="mnu-photo-side">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={choosePhoto}
                      disabled={photoBusy}
                      aria-label="Choose a photo"
                    />
                    <small className="muted">JPG, PNG or WEBP, up to 2 MB</small>
                    {editing.imagePath && (
                      <button
                        type="button"
                        className="link-button danger"
                        onClick={dropPhoto}
                        disabled={photoBusy}
                      >
                        Remove photo
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <small className="muted mnu-photo-later">
                  <Icon name="info" size={15} /> Save the dish first, then add a photo.
                </small>
              )}
            </div>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {sellingFor && <SellingRulesModal product={sellingFor} currency={currency} onClose={() => setSellingFor(null)} />}
      {serviceFor && <ServiceOptionsModal product={serviceFor} canManage={canManage} onSaved={load} onClose={()=>setServiceFor(null)} />}
      {extrasFor && (
        <ProductExtrasModal
          product={extrasFor}
          currency={currency}
          canManage={canManage}
          onClose={(changed) => {
            setExtrasFor(null);

            if (changed) {
              setSuccess(`Sizes and add-ons for "${extrasFor.name}" saved`);
            }
          }}
        />
      )}

      {recipeFor && (
        <RecipeModal
          product={recipeFor}
          currency={currency}
          canManage={canManage}
          onClose={() => {
            setRecipeFor(null);
            // The plate cost on the list follows what was just changed.
            if (recipesOn) {
              load();
            }
          }}
        />
      )}

      {comboFor && (
        <ComboModal
          product={comboFor}
          currency={currency}
          canManage={canManage}
          onClose={() => setComboFor(null)}
          onSaved={(message) => {
            setComboFor(null);
            setSuccess(message);
            load();
          }}
        />
      )}

      {historyFor && <ProductHistoryModal product={historyFor} onClose={() => setHistoryFor(null)} />}

      {importing && (
        <MenuImportModal
          currency={currency}
          onClose={() => setImporting(false)}
          onImported={(message) => {
            setImporting(false);
            setSuccess(message);
            load();
            loadCategories();
          }}
        />
      )}

      {printingMenu && <PrintMenuModal onClose={() => setPrintingMenu(false)} />}

      {importingRecipes && (
        <SheetImportModal
          title="Import recipes from a spreadsheet"
          description="One row per ingredient of a dish: what each plate uses, checked before anything changes."
          noun="recipe line"
          nounPlural="recipe lines"
          sampleName="recipes-sample.csv"
          loadGuide={getRecipeImportGuide}
          runImport={importRecipes}
          lead="A dish is found by its name or short code, a size by its name, an ingredient by its name or code. Lines in the file are added or have their quantity changed; anything the file does not mention stays as it is."
          promises={[
            {
              title: "Units are checked.",
              text: "A quantity must be in the ingredient's own unit, or grams for a kilogram item and ml for a litre item, which are converted.",
            },
          ]}
          onClose={() => setImportingRecipes(false)}
          onImported={(message) => {
            setImportingRecipes(false);
            setSuccess(message);
            load();
          }}
        />
      )}

      {revising && (
        <PriceRevisionModal
          categories={categories}
          currency={currency}
          onClose={() => setRevising(false)}
          onApplied={(message) => {
            setRevising(false);
            setSuccess(message);
            load();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete product"
          message={`Delete "${deleting.name}"? It has never been sold, so nothing else needs it. This cannot be undone.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}

      {archiveOffer && (
        <Modal
          title={archiveOffer.canArchive ? "Archive instead?" : "Can’t delete this dish"}
          icon={archiveOffer.canArchive ? "box" : "ban"}
          onClose={() => setArchiveOffer(null)}
          width={480}
        >
          <p>{archiveOffer.message}</p>
          {archiveOffer.canArchive && (
            <p className="muted small">You can bring it back any time from the Archived view.</p>
          )}
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={() => setArchiveOffer(null)}>
              {archiveOffer.canArchive ? "Keep it on the menu" : "OK"}
            </button>
            {archiveOffer.canArchive && archiveOffer.product.status === "active" && (
              <button type="button" className="button" onClick={archiveInstead}>
                Archive “{archiveOffer.product.name}”
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
