import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { listProducts, listVariants } from "../services/menu.service";
import { getPriceWindow, savePriceWindowItems } from "../services/priceWindow.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { moneyExact } from "@bmp/shared/format";
import "../../../../styles/menu.css";

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// One dish in the window, with a row for every size it sells in. A dish
// without sizes has a single row. A dish with sizes has a row for each size
// and one for "Regular" (sold without a size): each gets its own price, and a
// size left blank sells at its normal price while the window is open.
const groupFor = (product, variants, items) => {
  const base = Number(product.price);
  const priceOf = (variantId) => {
    const item = items.find(
      (row) => row.productId === product.id && (row.productVariantId || null) === variantId
    );

    return item ? String(item.price) : "";
  };

  const sizes = variants
    // A switched-off size is shown only if it already has a window price, so
    // that price can be seen and removed.
    .filter((variant) => variant.status === "active" || priceOf(variant.id) !== "")
    .map((variant) => ({
      variantId: variant.id,
      name: variant.name,
      normalPrice: round2(base + Number(variant.priceDelta)),
      price: priceOf(variant.id),
      off: variant.status !== "active",
    }));

  return {
    productId: product.id,
    productName: product.name,
    hasSizes: sizes.length > 0,
    rows: [
      {
        variantId: null,
        name: sizes.length > 0 ? "Regular (no size chosen)" : "",
        normalPrice: base,
        price: priceOf(null),
        off: false,
      },
      ...sizes,
    ],
  };
};

// Which dishes this window covers and what they sell for while it is open,
// size by size. Saved whole, so the window is never half-priced.
export default function PriceWindowItemsModal({ window: priceWindow, canManage, onClose, onSaved }) {
  const [groups, setGroups] = useState([]);
  const [choices, setChoices] = useState([]);
  const [pick, setPick] = useState("");
  const [currency, setCurrency] = useState("₹");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      getPriceWindow(priceWindow.id),
      listProducts({ status: "active" }),
      getSettings().catch(() => null),
    ])
      .then(async ([windowData, productRows, settings]) => {
        const productIds = [...new Set(windowData.items.map((item) => item.productId))];
        const variantLists = await Promise.all(productIds.map((id) => listVariants(id)));
        const byId = new Map(productRows.map((row) => [row.id, row]));

        setGroups(
          productIds.map((id, index) => {
            const item = windowData.items.find((row) => row.productId === id);
            // A dish switched off since it was put in the window still shows,
            // priced from what the window remembers.
            const product = byId.get(id) || {
              id,
              name: item.productName,
              price: item.basePrice,
            };

            return groupFor(product, variantLists[index], windowData.items);
          })
        );
        setChoices(productRows);

        if (settings) {
          setCurrency(settings.currencySymbol);
        }
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [priceWindow.id]);

  const addDish = async () => {
    const chosen = choices.find((row) => String(row.id) === pick);

    if (!chosen) {
      return;
    }

    if (groups.some((group) => group.productId === chosen.id)) {
      setError(`"${chosen.name}" is already in this window — change its prices below.`);
      return;
    }

    setError("");
    setAdding(true);

    try {
      const variants = await listVariants(chosen.id);
      setGroups([...groups, groupFor(chosen, variants, [])]);
      setPick("");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const changePrice = (productId, variantId, price) =>
    setGroups(
      groups.map((group) =>
        group.productId === productId
          ? {
              ...group,
              rows: group.rows.map((row) => (row.variantId === variantId ? { ...row, price } : row)),
            }
          : group
      )
    );

  const removeDish = (productId) => setGroups(groups.filter((group) => group.productId !== productId));

  const save = async () => {
    setError("");

    const empty = groups.find((group) => group.rows.every((row) => row.price === ""));

    if (empty) {
      setError(`Give "${empty.productName}" a price for at least one size, or remove it.`);
      return;
    }

    const bad = groups.find((group) => group.rows.some((row) => row.price !== "" && !(Number(row.price) >= 0)));

    if (bad) {
      setError(`A price for "${bad.productName}" is not a number of rupees.`);
      return;
    }

    setSaving(true);

    try {
      await savePriceWindowItems(
        priceWindow.id,
        groups.flatMap((group) =>
          group.rows
            .filter((row) => row.price !== "")
            .map((row) => ({
              productId: group.productId,
              productVariantId: row.variantId,
              price: Number(row.price),
            }))
        )
      );
      onSaved("Prices saved");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const available = choices.filter((row) => !groups.some((group) => group.productId === row.id));

  // The grid's lines: every size of every dish, the dish's first line
  // carrying its name, its warning and Remove dish.
  const lines = groups.flatMap((group) => {
    const onlyRegular =
      group.hasSizes && group.rows[0].price !== "" && group.rows.slice(1).every((row) => row.price === "");

    return group.rows.map((row, index) => ({
      key: `${group.productId}-${row.variantId || "base"}`,
      group,
      row,
      first: index === 0,
      onlyRegular,
    }));
  });

  // The buttons appear once the window has loaded, as they always did: Save
  // before then would save an empty list over the window's dishes.
  return (
    <Modal
      title={`${priceWindow.name} — dishes`}
      description={`${priceWindow.startTime}–${priceWindow.endTime}${
        priceWindow.outletName ? ` at ${priceWindow.outletName} only` : " at every outlet"
      }. Everything not listed sells as usual.`}
      icon="tag"
      onClose={onClose}
      width={760}
      footer={
        loading ? null : (
          <>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Close
            </button>
            {canManage && (
              <button type="button" className="button" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save prices"}
              </button>
            )}
          </>
        )
      }
    >
      <div className="stack mnu-hh-items">
        <ErrorMessage message={error} />

        {loading ? (
          <Loading />
        ) : (
          <>
            <p className="mnu-lead">
              <Icon name="info" size={16} />
              <span>
                Each size has its own price; a size left blank sells at its normal price while the window is
                open.
              </span>
            </p>

            {groups.length === 0 ? (
              <EmptyState
                icon="tag"
                message="No dishes in this window yet"
                hint={
                  canManage
                    ? "Pick a dish below and give it a window price."
                    : "Every dish sells at its menu price while this window is open."
                }
              />
            ) : (
              // A line per size, the dish named on its first line (with Remove dish).
              <DataGrid
                variant="editor"
                caption="Window prices, dish by dish and size by size"
                rows={lines}
                rowKey={(line) => line.key}
                rowNoun={["price", "prices"]}
                currency={currency}
                columns={[
                  {
                    key: "dish",
                    header: "Dish",
                    width: 180,
                    value: (line) => line.group.productName,
                    render: (line, ctx) =>
                      line.first ? (
                        <>
                          <strong>{line.group.productName}</strong>
                          {line.onlyRegular && (
                            <div className="mnu-hh-warn">
                              Only "Regular" has a price.{" "}
                              {line.group.rows.slice(1).map((row) => row.name).join(", ")} sell
                              {line.group.rows.length === 2 ? "s" : ""} at the normal price
                              {/* Only someone who can set a price is told to set one. */}
                              {canManage ? ` unless you give ${line.group.rows.length === 2 ? "it" : "them"} one` : ""}.
                            </div>
                          )}
                        </>
                      ) : ctx.card ? (
                        <span className="muted">{line.group.productName}</span>
                      ) : null,
                  },
                  {
                    key: "size",
                    header: "Size",
                    width: 100,
                    value: (line) => line.row.name || "Price",
                    render: (line) => (
                      <>
                        {line.row.name || "Price"}
                        {line.row.off && <span className="muted small"> · switched off</span>}
                      </>
                    ),
                  },
                  {
                    key: "normal",
                    header: "Normal price",
                    width: 110,
                    type: "money",
                    exact: true,
                    value: (line) => line.row.normalPrice,
                    render: (line) => <span className="muted">{moneyExact(line.row.normalPrice, currency)}</span>,
                  },
                  {
                    key: "price",
                    header: "Window price",
                    width: 120,
                    type: "money",
                    exact: true,
                    value: (line) => (line.row.price === "" ? null : Number(line.row.price)),
                    render: (line) => {
                      const dearer = line.row.price !== "" && Number(line.row.price) > line.row.normalPrice;

                      return (
                        <>
                          {canManage ? (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={line.row.price}
                              placeholder="normal"
                              aria-label={`${line.group.productName} ${line.row.name || ""} price in this window`}
                              onChange={(event) => changePrice(line.group.productId, line.row.variantId, event.target.value)}
                            />
                          ) : line.row.price !== "" ? (
                            moneyExact(line.row.price, currency)
                          ) : (
                            <span className="muted">normal</span>
                          )}
                          {dearer && <div className="mnu-hh-warn">dearer than normal</div>}
                        </>
                      );
                    },
                  },
                  canManage && {
                    key: "remove",
                    header: "",
                    label: "Remove",
                    type: "actions",
                    render: (line) =>
                      line.first ? (
                        <button
                          type="button"
                          className="chip-button mnu-danger-chip"
                          onClick={() => removeDish(line.group.productId)}
                        >
                          <Icon name="x" size={14} /> Remove dish
                        </button>
                      ) : null,
                  },
                ]}
              />
            )}

            {canManage && (
              <div className="inline-form mnu-picker">
                <select value={pick} onChange={(event) => setPick(event.target.value)} aria-label="Dish to add">
                  <option value="">Add a dish…</option>
                  {available.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} — {moneyExact(row.price, currency)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={addDish}
                  disabled={!pick || adding}
                >
                  <Icon name="plus" size={16} /> {adding ? "Adding…" : "Add"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
