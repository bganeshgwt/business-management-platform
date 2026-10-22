import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import {
  addRecipeLine,
  copyDishRecipeToSize,
  deleteRecipeLine,
  getRecipe,
  setSizeRecipeFactor,
  updateRecipeLine,
} from "../services/recipe.service";
import { listInventoryItems } from "../../inventory/services/inventory.service";
import { getErrorMessage } from "../../../../services/api";
import { money, moneyExact } from "@bmp/shared/format";
import { unitMoney } from "../../inventory/pages/stockFormat";
import "../../../../styles/menu.css";

const SOURCE = {
  own: { label: "Own recipe", tone: "success" },
  factor: { label: "Share of the dish", tone: "info" },
  dish: { label: "Full dish recipe", tone: "warning" },
  none: { label: "No recipe", tone: "danger" },
};

// A starting share for a size nobody has set yet, from its name. A Full plate
// is the dish; a Half is half of it. Anything else starts empty rather than
// guessed — a "Large" might be 1.5 or 2.
const SHARE_BY_NAME = [
  [/quarter|qtr/i, "0.25"],
  [/half/i, "0.5"],
  [/full|regular|standard|single/i, "1"],
];

const startingShare = (size) =>
  size.recipeFactor !== null
    ? String(size.recipeFactor)
    : (SHARE_BY_NAME.find(([pattern]) => pattern.test(size.name)) || [null, ""])[1];

// What one plate of this dish uses — and each size it is sold in — what that
// costs, and what it leaves. A size either has its own recipe, uses a share
// of the dish's (Half = 0.5), or, until someone says otherwise, the whole
// dish recipe: that last one is flagged, because it is how half plates used
// to take a full plate's paneer.
export default function RecipeModal({ product, currency, canManage, onClose }) {
  const [recipe, setRecipe] = useState(null);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState("dish");
  const [form, setForm] = useState({ inventoryItemId: "", quantity: "" });
  const [factor, setFactor] = useState("");
  // "Own recipe from scratch" on a size that uses the dish's.
  const [buildingOwn, setBuildingOwn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getRecipe(product.id), canManage ? listInventoryItems().catch(() => []) : Promise.resolve([])])
      .then(([recipeData, itemRows]) => {
        setRecipe(recipeData);
        setItems(itemRows.filter((row) => row.status === "active"));
        setForm({ inventoryItemId: itemRows[0] ? String(itemRows[0].id) : "", quantity: "" });
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [product.id, canManage]);

  const size = recipe && selected !== "dish" ? recipe.sizes.find((row) => row.id === selected) : null;
  const variantId = size ? size.id : null;
  const lines = recipe ? recipe.lines.filter((line) => (line.productVariantId || null) === variantId) : [];
  const dishLines = recipe ? recipe.lines.filter((line) => !line.productVariantId) : [];
  const showCosts = recipe ? recipe.costsVisible : false;
  // A size with nothing of its own and no dish recipe to share takes nothing.
  const sourceOf = (row) => (row.source !== "own" && dishLines.length === 0 ? "none" : row.source);
  const sizeSource = size ? sourceOf(size) : null;
  // Where ingredients are typed: the dish, a size with its own recipe, and a
  // size being given one — from scratch, or because there is no dish recipe.
  const editingLines =
    selected === "dish" || (size && (size.source === "own" || buildingOwn || sizeSource === "none"));

  const run = async (work) => {
    setError("");
    setSaving(true);

    try {
      setRecipe(await work());
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const pick = (key) => {
    setSelected(key);
    setError("");
    setBuildingOwn(false);

    const picked = recipe.sizes.find((row) => row.id === key);
    setFactor(picked ? startingShare(picked) : "");
  };

  const add = async (event) => {
    event.preventDefault();

    if (
      await run(() =>
        addRecipeLine(product.id, {
          inventoryItemId: Number(form.inventoryItemId),
          productVariantId: variantId,
          quantity: Number(form.quantity),
        })
      )
    ) {
      setForm({ ...form, quantity: "" });
    }
  };

  const selectedItem = items.find((item) => String(item.id) === form.inventoryItemId);
  const costing = size || recipe;
  const flagged = ["dish", "none"].includes(sizeSource);

  return (
    <Modal
      title={`${product.name} — recipe`}
      description="What one plate uses. Ingredients leave stock automatically when the dish is billed; a dish without a recipe takes nothing."
      icon="book"
      onClose={onClose}
      width={760}
      footer={
        <button type="button" className="button button-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      {loading ? (
        <Loading />
      ) : !recipe ? (
        <ErrorMessage message={error} />
      ) : (
        <div className="stack mnu-recipe">
          <ErrorMessage message={error} />

          {recipe.sizes.length > 0 && (
            <div className="mnu-rc-tabs" role="tablist" aria-label="Recipe for">
              <button
                type="button"
                role="tab"
                aria-selected={selected === "dish"}
                className={`mnu-rc-tab ${selected === "dish" ? "is-active" : ""}`}
                onClick={() => pick("dish")}
              >
                <strong>Whole dish</strong>
                <small>
                  {money(recipe.price, currency)} · {dishLines.length} ingredient{dishLines.length === 1 ? "" : "s"}
                </small>
              </button>
              {recipe.sizes.map((row) => (
                <button
                  type="button"
                  role="tab"
                  key={row.id}
                  aria-selected={selected === row.id}
                  className={`mnu-rc-tab ${selected === row.id ? "is-active" : ""} ${["dish", "none"].includes(sourceOf(row)) ? "is-flagged" : ""}`}
                  onClick={() => pick(row.id)}
                >
                  <strong>
                    {row.name}
                    {["dish", "none"].includes(sourceOf(row)) && (
                      <Icon name="alert" size={13} className="mnu-rc-flag" title="Needs a look" />
                    )}
                  </strong>
                  <small>
                    {money(row.price, currency)} ·{" "}
                    {
                      {
                        own: "own recipe",
                        factor: `${row.recipeFactor} × dish`,
                        dish: "full dish recipe",
                        none: "no recipe yet",
                      }[sourceOf(row)]
                    }
                  </small>
                </button>
              ))}
            </div>
          )}

          {size && (
            <div className={`alert ${flagged ? "alert-notice" : "alert-info"} mnu-rc-hint`}>
              <span className={`badge badge-${SOURCE[sizeSource].tone} status-badge`}>
                <span className="badge-dot" aria-hidden="true" />
                {SOURCE[sizeSource].label}
              </span>{" "}
              {
                {
                  own: `Billing a ${size.name} takes these ${size.lineCount} ingredients.`,
                  factor: `Billing a ${size.name} takes ${size.recipeFactor} × the dish recipe.`,
                  dish: `Billing a ${size.name} takes the full dish recipe. If a ${size.name} is not the same as the dish, give it a share of the dish or its own recipe; if it is, confirm it with 1 × dish.`,
                  none: `Billing a ${size.name} takes nothing from stock yet: the dish has no whole-dish recipe to share. Give ${size.name} its own recipe below.`,
                }[sizeSource]
              }
            </div>
          )}

          {size && canManage && size.source !== "own" && dishLines.length > 0 && !buildingOwn && (
            <div className="mnu-panel stack">
              <div className="mnu-rc-share">
                <label className="field">
                  <span>{size.name} as a share of the dish recipe</span>
                  <input
                    type="number"
                    min="0.05"
                    max="10"
                    step="any"
                    value={factor}
                    placeholder="e.g. 0.5"
                    onChange={(event) => setFactor(event.target.value)}
                    aria-label={`${size.name} as a share of the dish`}
                  />
                </label>
                <button
                  type="button"
                  className="button"
                  disabled={saving || !factor || (size.source === "factor" && Number(factor) === size.recipeFactor)}
                  onClick={() => run(() => setSizeRecipeFactor(size.id, Number(factor)))}
                >
                  {size.source === "factor" && Number(factor) === size.recipeFactor
                    ? `Using ${factor} × dish`
                    : `Use ${factor || "?"} × dish`}
                </button>
                {size.source === "factor" && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={saving}
                    onClick={() => run(() => setSizeRecipeFactor(size.id, null))}
                  >
                    Use the full dish recipe
                  </button>
                )}
              </div>
              <div className="mnu-rc-share-more">
                <span className="muted small">Or give {size.name} its own recipe:</span>
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  disabled={saving || !factor}
                  onClick={() => run(() => copyDishRecipeToSize(product.id, size.id, Number(factor)))}
                >
                  Own recipe, starting at {factor || "?"} × dish
                </button>
                <button type="button" className="button button-secondary button-sm" onClick={() => setBuildingOwn(true)}>
                  Own recipe from scratch
                </button>
              </div>
              <p className="muted small">
                Half plate = 0.5, a large = 1.5. Its own recipe is better when a size is not simply smaller — a
                half biryani usually gets less rice but the same raita.
              </p>
            </div>
          )}

          {editingLines && (
            <>
              {lines.length === 0 ? (
                <EmptyState
                  icon="book"
                  message={selected === "dish" ? "No ingredients yet" : `${size.name} has no ingredients of its own yet`}
                  hint={
                    selected === "dish"
                      ? "Add what one plate uses, and billing it will take those out of stock."
                      : `Add what one ${size.name} plate uses.`
                  }
                />
              ) : (
                <DataGrid
                  variant="editor"
                  caption={selected === "dish" ? `Ingredients of one ${product.name}` : `Ingredients of one ${size.name} ${product.name}`}
                  rows={lines}
                  rowKey={(line) => line.id}
                  rowNoun={["ingredient", "ingredients"]}
                  currency={currency}
                  columns={[
                    {
                      key: "ingredient",
                      header: "Ingredient",
                      width: 170,
                      value: (line) => line.itemName,
                      render: (line) => <span className="mnu-dish">{line.itemName}</span>,
                    },
                    {
                      key: "quantity",
                      header: "Per plate",
                      type: "number",
                      width: 140,
                      value: (line) => Number(line.quantity),
                      // The unit sits beside the figure, as it always did.
                      render: (line) => (
                        <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                          {canManage ? (
                            <input
                              type="number"
                              min="0.0001"
                              step="0.0001"
                              defaultValue={line.quantity}
                              aria-label={`${line.itemName} per plate`}
                              onBlur={(event) => {
                                if (Number(event.target.value) !== line.quantity) {
                                  run(() => updateRecipeLine(line.id, Number(event.target.value)));
                                }
                              }}
                            />
                          ) : (
                            line.quantity
                          )}
                          <span className="muted">{line.unitShortName}</span>
                        </span>
                      ),
                    },
                    showCosts && {
                      key: "unitCost",
                      header: "Cost / unit",
                      type: "money",
                      width: 110,
                      value: (line) => line.lastCost,
                      render: (line) => (line.lastCost === null ? "—" : unitMoney(line.lastCost, currency)),
                    },
                    showCosts && {
                      key: "lineCost",
                      header: "Line cost",
                      type: "money",
                      width: 110,
                      exact: true,
                      value: (line) => Number(line.lineCost || 0),
                      total: "sum",
                    },
                    canManage && {
                      key: "remove",
                      header: "",
                      label: "Remove",
                      type: "actions",
                      render: (line) => (
                        <button
                          type="button"
                          className="chip-button mnu-danger-chip"
                          onClick={() => run(() => deleteRecipeLine(line.id))}
                        >
                          <Icon name="x" size={14} /> Remove
                        </button>
                      ),
                    },
                  ]}
                />
              )}

              {canManage && items.length === 0 && (
                <div className="alert">Add inventory items first, under Stock → Items &amp; stock.</div>
              )}

              {canManage && items.length > 0 && (
                <form className="inline-form mnu-picker" onSubmit={add}>
                  <select
                    value={form.inventoryItemId}
                    onChange={(event) => setForm({ ...form, inventoryItemId: event.target.value })}
                    required
                    aria-label="Ingredient"
                  >
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.unitShortName})
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    placeholder={selectedItem ? `Qty in ${selectedItem.unitShortName}` : "Quantity"}
                    value={form.quantity}
                    onChange={(event) => setForm({ ...form, quantity: event.target.value })}
                    required
                    aria-label="Quantity per plate"
                  />
                  <button type="submit" className="button" disabled={saving}>
                    <Icon name="plus" size={16} /> Add to {size ? size.name : "the dish"}
                  </button>
                  {size && buildingOwn && lines.length === 0 && (
                    <button type="button" className="button button-secondary" onClick={() => setBuildingOwn(false)}>
                      Back
                    </button>
                  )}
                </form>
              )}
            </>
          )}

          {showCosts ? (
            <div className="stat-grid mnu-rc-costs">
              <StatTile size="sm" icon="tag" label="Selling price" value={money(costing.price, currency)} />
              <StatTile size="sm" icon="box" tone="info" label="Food cost" value={moneyExact(costing.foodCost, currency)} />
              <StatTile size="sm" icon="wallet" tone="success" label="Margin" value={moneyExact(costing.margin, currency)} />
              <StatTile
                size="sm"
                icon="percent"
                tone={costing.foodCostPercentage > 35 ? "danger" : "success"}
                label="Food cost %"
                value={`${costing.foodCostPercentage}%`}
                note={costing.foodCostPercentage > 35 ? "above 35% of the price" : "35% of the price or less"}
              />
            </div>
          ) : (
            <p className="muted small mnu-lead">
              <Icon name="lock" size={15} />
              <span>Ingredient costs and margins are shown to managers only.</span>
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
