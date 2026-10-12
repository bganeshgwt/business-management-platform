import AddonGroupsEditor from "./AddonGroupsEditor";
import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import {
  createVariant,
  deleteVariant,
  getProduct,
  listModifiers,
  listProductModifiers,
  listVariants,
  setProductModifiers,
  updateVariant,
} from "../services/menu.service";
import { getErrorMessage } from "../../../../services/api";
import { money } from "../../../../services/format";
import "../../../../styles/menu.css";

const EMPTY_SIZE = { name: "", price: "", isDefault: false, kitchenName: "" };

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// A heading inside a dialog: an icon in its tone, the title, one line on
// what the part is for.
function SubHead({ icon, title, children, aside }) {
  return (
    <div className="mnu-subhead">
      <span className="mnu-subhead-icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <div className="mnu-subhead-text">
        <h3>{title}</h3>
        {children && <p className="muted small">{children}</p>}
      </div>
      {aside}
    </div>
  );
}

// One dialog for both of a product's extras: its sizes (Half / Full) and the
// add-ons a guest may choose.
//
// A size is entered and shown as the price the guest pays, which is how a
// menu prints it. The dialog loads the dish's price as it is now, and sends
// the guest price itself: the server works out the difference against the
// dish price at that moment, so a price changed elsewhere (a revision, an
// import) while the list was open cannot skew it. A size that has been sold
// cannot be deleted (past bills name it), so it is switched off instead; one
// a combo is built from must leave the combo first. The list says both.
//
// Each change sends only the fields it changes: switching a size off sends
// the status, repricing sends the price. A size someone else switched off or
// made the default meanwhile keeps that.
export default function ProductExtrasModal({ product, currency, canManage, onClose }) {
  const [dishPrice, setDishPrice] = useState(Number(product.price));
  const [variants, setVariants] = useState([]);
  const [modifiers, setModifiers] = useState([]);
  const [selectedModifierIds, setSelectedModifierIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [newSize, setNewSize] = useState(EMPTY_SIZE);
  const [editing, setEditing] = useState(null);
  const [changed, setChanged] = useState(false);
  const [addOnSearch, setAddOnSearch] = useState("");

  const base = dishPrice;

  useEffect(() => {
    Promise.all([
      getProduct(product.id),
      listVariants(product.id),
      listModifiers(),
      listProductModifiers(product.id),
    ])
      .then(([dish, variantRows, modifierRows, linkedIds]) => {
        setDishPrice(Number(dish.price));
        setVariants(variantRows);
        setModifiers(modifierRows);
        setSelectedModifierIds(linkedIds);
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [product.id]);

  const reload = async () => {
    const [dish, variantRows] = await Promise.all([getProduct(product.id), listVariants(product.id)]);
    setDishPrice(Number(dish.price));
    setVariants(variantRows);
  };

  // changes: only the fields this action changes.
  const save = async (variant, changes) => {
    setError("");
    setNotice(null);
    setSaving(true);

    try {
      await updateVariant(variant.id, changes);
      await reload();
      setEditing(null);
      setChanged(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const addSize = async (event) => {
    event.preventDefault();
    setError("");
    setNotice(null);
    setSaving(true);

    try {
      await createVariant(product.id, {
        name: newSize.name,
        price: round2(Number(newSize.price)),
        isDefault: newSize.isDefault,
        sortOrder: variants.length,
        kitchenName: newSize.kitchenName.trim() || null,
      });

      await reload();
      setNewSize(EMPTY_SIZE);
      setChanged(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // A sold size is refused by the server with the reason and an offer to
  // switch it off, which is shown here as a one-click choice.
  const removeSize = async (variant) => {
    setError("");
    setNotice(null);

    try {
      await deleteVariant(variant.id);
      await reload();
      setChanged(true);
    } catch (err) {
      const response = err.response && err.response.data;

      if (response && response.data && response.data.canArchive) {
        setNotice({ variant, message: response.message });
      } else {
        setError(getErrorMessage(err));
      }
    }
  };

  const toggleModifier = (id) =>
    setSelectedModifierIds(
      selectedModifierIds.includes(id)
        ? selectedModifierIds.filter((item) => item !== id)
        : [...selectedModifierIds, id]
    );

  const saveModifiers = async () => {
    setError("");
    setSaving(true);

    try {
      await setProductModifiers(product.id, selectedModifierIds);
      onClose(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (variant) => {
    setNotice(null);
    setError("");
    setEditing({
      id: variant.id,
      name: variant.name,
      price: String(round2(base + variant.priceDelta)),
      kitchenName: variant.kitchenName || "",
    });
  };

  // The dish's own add-ons first, then the rest. A switched-off add-on is
  // only listed when this dish already offers it: it cannot be sold anyway.
  const query = addOnSearch.trim().toLowerCase();
  const offerable = modifiers
    .filter((modifier) => modifier.status === "active" || selectedModifierIds.includes(modifier.id))
    .filter((modifier) => !query || modifier.name.toLowerCase().includes(query))
    .sort((a, b) => Number(selectedModifierIds.includes(b.id)) - Number(selectedModifierIds.includes(a.id)));

  const newPrice = Number(newSize.price);
  const newDelta = newSize.price === "" ? null : round2(newPrice - base);

  // "Save add-ons" waits for the list to load, as it always did: saving
  // before then would send an empty choice and take every add-on off the dish.
  return (
    <Modal
      title={`${product.name} — sizes & add-ons`}
      description="The portions a guest can order, and the extras offered with this dish."
      icon="layers"
      onClose={() => onClose(changed)}
      width={760}
      footer={
        loading ? null : (
          <>
            <button type="button" className="button button-secondary" onClick={() => onClose(changed)}>
              Close
            </button>
            {canManage && modifiers.length > 0 && (
              <button type="button" className="button" onClick={saveModifiers} disabled={saving}>
                {saving ? "Saving…" : "Save add-ons"}
              </button>
            )}
          </>
        )
      }
    >
      {loading ? (
        <Loading />
      ) : (
        <div className="stack mnu-extras">
          <ErrorMessage message={error} />

          {notice && (
            <div className="alert alert-notice mnu-notice-row">
              <span>{notice.message}</span>
              {canManage && (
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => save(notice.variant, { status: "inactive", isDefault: false })}
                  disabled={saving}
                >
                  Switch {notice.variant.name} off
                </button>
              )}
            </div>
          )}

          <section className="stack mnu-extras-part">
            <SubHead icon="layers" title="Sizes / portions">
              The price the guest pays for each size. The dish is {money(base, currency)}; a size can never cost less
              than zero. Switch a size off to stop selling it; one that has been sold cannot be removed.
            </SubHead>

            {variants.length === 0 ? (
              <p className="mnu-lead">
                <Icon name="info" size={16} />
                <span>No sizes: the dish sells at one price.</span>
              </p>
            ) : (
              // One line per size; the line being edited turns into inputs.
              <DataGrid
                variant="editor"
                caption={`Sizes of ${product.name}`}
                rows={variants}
                rowKey={(variant) => variant.id}
                rowNoun={["size", "sizes"]}
                currency={currency}
                rowClassName={(variant) =>
                  editing && editing.id === variant.id ? "" : variant.status !== "active" ? "dg-tone-muted" : ""
                }
                columns={[
                  {
                    key: "size",
                    header: "Size",
                    width: 200,
                    value: (variant) => variant.name,
                    render: (variant) =>
                      editing && editing.id === variant.id ? (
                        <>
                          <input
                            className="mnu-inline-input"
                            value={editing.name}
                            maxLength={100}
                            aria-label="Size name"
                            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                          />
                          {/* SW-A-12: the size's name on the KOT, in the cooks' script. */}
                          <div className="muted small">Kitchen name</div>
                          <input
                            className="mnu-inline-input"
                            value={editing.kitchenName}
                            maxLength={100}
                            aria-label="Kitchen name of the size"
                            placeholder="e.g. हाफ"
                            onChange={(event) => setEditing({ ...editing, kitchenName: event.target.value })}
                          />
                        </>
                      ) : (
                        <>
                          <span className="mnu-size-name">{variant.name}</span>
                          {variant.isDefault && <span className="badge badge-primary mnu-gap">Default</span>}
                          <div>
                            <span className={`badge status-badge ${variant.status !== "active" ? "badge-neutral" : "badge-active"}`}>
                              <span className="badge-dot" aria-hidden="true" />
                              {variant.status !== "active" ? "Switched off" : "On sale"}
                            </span>
                          </div>
                          {variant.kitchenName && (
                            <div className="muted small" title="Kitchen name: printed on KOTs">
                              KOT: {variant.kitchenName}
                            </div>
                          )}
                        </>
                      ),
                  },
                  {
                    key: "price",
                    header: "Guest pays",
                    type: "money",
                    width: 140,
                    value: (variant) => round2(base + variant.priceDelta),
                    // The difference from the dish price sits under the price.
                    render: (variant) => {
                      const delta = editing && editing.id === variant.id ? round2(Number(editing.price) - base) : variant.priceDelta;
                      const versus =
                        editing && editing.id === variant.id && editing.price === ""
                          ? "—"
                          : delta === 0
                            ? "same as the dish"
                            : `${delta > 0 ? "+" : "−"}${money(Math.abs(delta), currency)} vs dish`;

                      return editing && editing.id === variant.id ? (
                        <>
                          <input
                            className="mnu-inline-input"
                            type="number"
                            min="0"
                            step="0.01"
                            value={editing.price}
                            aria-label="Price the guest pays"
                            onChange={(event) => setEditing({ ...editing, price: event.target.value })}
                          />
                          <div className="muted small nowrap">{versus}</div>
                        </>
                      ) : (
                        <>
                          <strong>{money(round2(base + variant.priceDelta), currency)}</strong>
                          <div className="muted small nowrap">{versus}</div>
                        </>
                      );
                    },
                  },
                  {
                    key: "sold",
                    header: "Sold",
                    width: 150,
                    value: (variant) => variant.timesSold,
                    render: (variant) => {
                      if (editing && editing.id === variant.id) {
                        return (
                          <span className="muted small">
                            {variant.timesSold > 0 ? "Already sold: past bills keep their price." : "Not sold yet."}
                          </span>
                        );
                      }

                      const combos = variant.combos || [];

                      return (
                        <span className="muted small">
                          <span className="nowrap">
                            {variant.timesSold > 0
                              ? `${variant.timesSold} order${variant.timesSold === 1 ? "" : "s"}`
                              : "never"}
                          </span>
                          {combos.length > 0 && (
                            <span className="mnu-sz-combo">In {combos.map((combo) => combo.name).join(", ")}</span>
                          )}
                        </span>
                      );
                    },
                  },
                  canManage && {
                    key: "actions",
                    header: "",
                    label: "Actions",
                    type: "actions",
                    render: (variant) => {
                      const final = round2(base + variant.priceDelta);
                      const off = variant.status !== "active";
                      const combos = variant.combos || [];

                      if (editing && editing.id === variant.id) {
                        return (
                          <div className="row-actions">
                            <button
                              type="button"
                              className="chip-button mnu-save-chip"
                              disabled={saving || !editing.name.trim() || editing.price === "" || Number(editing.price) < 0}
                              onClick={() => {
                                const changes = {};

                                if (editing.name.trim() !== variant.name) {
                                  changes.name = editing.name.trim();
                                }

                                if (round2(Number(editing.price)) !== final) {
                                  changes.price = round2(Number(editing.price));
                                }

                                if ((editing.kitchenName.trim() || null) !== (variant.kitchenName || null)) {
                                  changes.kitchenName = editing.kitchenName.trim() || null;
                                }

                                if (Object.keys(changes).length === 0) {
                                  setEditing(null);
                                } else {
                                  save(variant, changes);
                                }
                              }}
                            >
                              <Icon name="check" size={14} /> Save
                            </button>
                            <button type="button" className="link-button" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </div>
                        );
                      }

                      return (
                        <div className="row-actions">
                          <button type="button" className="chip-button" onClick={() => startEdit(variant)}>
                            <Icon name="edit" size={14} /> Edit
                          </button>
                          <ActionMenu
                            label={`More actions for the ${variant.name} size`}
                            items={[
                              ...(!variant.isDefault && !off
                                ? [
                                    {
                                      label: "Make default",
                                      icon: "star",
                                      disabled: saving,
                                      onClick: () => save(variant, { isDefault: true }),
                                    },
                                  ]
                                : []),
                              {
                                label: off ? "Switch on" : "Switch off",
                                icon: off ? "check-circle" : "ban",
                                disabled: saving,
                                onClick: () =>
                                  save(variant, off ? { status: "active" } : { status: "inactive", isDefault: false }),
                              },
                              // Remove only for a size nothing needs: never
                              // sold, and in no combo (the list says which).
                              ...(variant.timesSold === 0 && combos.length === 0
                                ? [
                                    { separator: true },
                                    {
                                      label: "Remove",
                                      icon: "trash",
                                      danger: true,
                                      disabled: saving,
                                      onClick: () => removeSize(variant),
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        </div>
                      );
                    },
                  },
                ]}
              />
            )}

            {canManage && (
              <form className="mnu-add-size" onSubmit={addSize}>
                <label className="field">
                  <span>New size</span>
                  <input
                    placeholder="Half"
                    value={newSize.name}
                    onChange={(event) => setNewSize({ ...newSize, name: event.target.value })}
                    required
                    maxLength={100}
                  />
                </label>
                <label className="field">
                  <span>Kitchen name</span>
                  <input
                    placeholder="e.g. हाफ (optional)"
                    value={newSize.kitchenName}
                    onChange={(event) => setNewSize({ ...newSize, kitchenName: event.target.value })}
                    maxLength={100}
                  />
                </label>
                <label className="field">
                  <span>Guest pays ({currency})</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder={String(Math.round(base / 2))}
                    value={newSize.price}
                    onChange={(event) => setNewSize({ ...newSize, price: event.target.value })}
                    required
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={newSize.isDefault}
                    onChange={(event) => setNewSize({ ...newSize, isDefault: event.target.checked })}
                  />
                  <span>Default</span>
                </label>
                <button type="submit" className="button" disabled={saving || newSize.price === "" || newPrice < 0}>
                  <Icon name="plus" size={16} /> Add size
                </button>
                {newDelta !== null && newPrice >= 0 && (
                  <span className="muted small mnu-add-hint">
                    {newDelta === 0
                      ? "Same as the dish price"
                      : `${money(Math.abs(newDelta), currency)} ${newDelta > 0 ? "more" : "less"} than the dish`}
                  </span>
                )}
              </form>
            )}
          </section>

          <section className="stack mnu-extras-part">
            <SubHead
              icon="sliders"
              title="Add-ons (modifiers)"
              aside={
                modifiers.length > 0 && (
                  <span className="badge badge-primary mnu-subhead-count">
                    {selectedModifierIds.length} chosen
                  </span>
                )
              }
            >
              Tick the modifiers the POS and the QR menu offer with this dish. They are created and priced on
              the Modifiers page.
            </SubHead>
            {modifiers.length > 12 && (
              <span className="input-with-icon mnu-addon-search">
                <Icon name="search" size={16} className="input-icon" />
                <input
                  className="mnu-inline-input"
                  placeholder="Find a modifier"
                  aria-label="Find a modifier"
                  value={addOnSearch}
                  onChange={(event) => setAddOnSearch(event.target.value)}
                />
              </span>
            )}
            {modifiers.length === 0 ? (
              <p className="mnu-lead">
                <Icon name="info" size={16} />
                <span>No modifiers exist yet. Create them on the Modifiers page (Menu → Modifiers), then tick them here.</span>
              </p>
            ) : (
              <div className="mnu-addon-grid">
                {offerable.map((modifier) => (
                  <label className="mnu-addon" key={modifier.id}>
                    <input
                      type="checkbox"
                      checked={selectedModifierIds.includes(modifier.id)}
                      onChange={() => toggleModifier(modifier.id)}
                      disabled={!canManage}
                    />
                    <span className="mnu-addon-name">
                      {modifier.name}
                      {modifier.status !== "active" && <small className="mnu-off-tag"> switched off</small>}
                    </span>
                    <small className="mnu-addon-price">+{money(modifier.price, currency)}</small>
                  </label>
                ))}
              </div>
            )}
          </section>
          <AddonGroupsEditor productId={product.id} modifiers={modifiers.filter(m=>selectedModifierIds.includes(m.id))} canManage={canManage}/>
        </div>
      )}
    </Modal>
  );
}
