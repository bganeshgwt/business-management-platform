import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { clearCombo, getCombo, listProducts, saveCombo } from "../services/menu.service";
import { getErrorMessage } from "../../../../services/api";
import { money } from "../../../../services/format";
import "../../../../styles/menu.css";

// Which dishes make up a set-price item, and what the guest saves by taking it.
// The list is saved whole, so the combo is never briefly half-defined.
//
// Combos are one level deep: a combo cannot hold another combo, and a dish
// that is already inside a combo cannot become one (stock is only taken one
// level down). A part that is sold out or archived is shown, because the
// combo cannot be served without it.
export default function ComboModal({ product, currency, canManage, onClose, onSaved }) {
  const [combo, setCombo] = useState(null);
  const [choices, setChoices] = useState([]);
  const [lines, setLines] = useState([]);
  const [pick, setPick] = useState({ productId: "", quantity: "1" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getCombo(product.id), listProducts({ status: "active" })])
      .then(([comboData, productRows]) => {
        setCombo(comboData);
        setLines(
          comboData.items.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            variantName: item.variantName,
            productVariantId: item.productVariantId,
            quantity: item.quantity,
            partPrice: item.partPrice,
            unitPrice: item.quantity > 0 ? item.partPrice / item.quantity : 0,
            isAvailable: item.isAvailable,
            soldOut: item.soldOut,
            archived: item.archived,
            sizeOff: item.sizeOff,
          }))
        );
        // A combo cannot hold itself or another combo.
        setChoices(productRows.filter((row) => row.id !== product.id && !row.isCombo));
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [product.id]);

  const addLine = () => {
    const chosen = choices.find((row) => String(row.id) === pick.productId);
    const quantity = Number(pick.quantity);

    if (!chosen || !(quantity > 0)) {
      return;
    }

    if (lines.some((line) => line.productId === chosen.id && !line.productVariantId)) {
      setError(`"${chosen.name}" is already in this combo — change its quantity instead.`);
      return;
    }

    setError("");
    setLines([
      ...lines,
      {
        productId: chosen.id,
        productName: chosen.name,
        variantName: null,
        productVariantId: null,
        quantity,
        unitPrice: chosen.price,
        partPrice: Math.round(chosen.price * quantity * 100) / 100,
        isAvailable: chosen.isAvailable,
        soldOut: !chosen.isAvailable,
        archived: false,
        sizeOff: false,
      },
    ]);
    setPick({ productId: "", quantity: "1" });
  };

  const changeQuantity = (index, quantity) =>
    setLines(
      lines.map((line, at) =>
        at === index
          ? {
              ...line,
              quantity,
              partPrice: Math.round(line.unitPrice * Number(quantity || 0) * 100) / 100,
            }
          : line
      )
    );

  const removeLine = (index) => setLines(lines.filter((_line, at) => at !== index));

  const save = async () => {
    setError("");
    setSaving(true);

    try {
      const result =
        lines.length === 0
          ? await clearCombo(product.id)
          : await saveCombo(
              product.id,
              lines.map((line) => ({
                productId: line.productId,
                productVariantId: line.productVariantId || undefined,
                quantity: Number(line.quantity),
              }))
            );

      setCombo(result);
      onSaved(lines.length === 0 ? "Combo cleared" : "Combo saved");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const partsTotal = lines.reduce((sum, line) => sum + Number(line.partPrice || 0), 0);
  const saving_ = Math.round((partsTotal - (combo ? combo.price : 0)) * 100) / 100;
  const blocked = combo && combo.partOf && combo.partOf.length > 0 && combo.items.length === 0;
  const unavailable = lines.filter((line) => !line.isAvailable);
  const ready = !loading && Boolean(combo);

  const why = (line) =>
    line.archived ? "archived" : line.soldOut ? "sold out" : line.sizeOff ? `${line.variantName} switched off` : "";

  // "Dal Bukhara is sold out", but "the Small Sweet Lassi is switched off":
  // it is the size, not the dish, that is off.
  const problemLine = (line) =>
    !line.archived && !line.soldOut && line.sizeOff
      ? `the ${line.variantName} ${line.productName} is switched off`
      : `${line.productName} is ${why(line)}`;

  // The buttons wait for the combo to load, as they always did: Save on an
  // empty, unloaded list would clear the combo.
  return (
    <Modal
      title={`Combo — ${product.name}`}
      description="A set-price dish made of other dishes."
      icon="cloche"
      onClose={onClose}
      width={720}
      footer={
        ready ? (
          <>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Close
            </button>
            {canManage && !blocked && (
              <button type="button" className="button" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save combo"}
              </button>
            )}
          </>
        ) : null
      }
    >
      <div className="stack">
        <ErrorMessage message={error} />

        {!ready ? (
          <Loading />
        ) : (
          <>
            {blocked && (
              <div className="alert alert-notice">
                “{product.name}” is part of the combo{" "}
                {combo.partOf.map((row) => `“${row.name}”`).join(", ")}, so it cannot become a combo itself. Combos
                are one level deep, so every part’s ingredients come out of stock. Take it out of that combo first.
              </div>
            )}

            {unavailable.length > 0 && (
              <div className="alert mnu-combo-warn" role="status">
                <strong>This combo cannot be served right now.</strong>{" "}
                {unavailable
                  .map(problemLine)
                  .map((text, index) => (index === 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text))
                  .join("; ")}
                . Mark the combo sold out
                too, or swap the part, until {unavailable.length === 1 ? "it is" : "they are"} back.
              </div>
            )}

            <div className="alert alert-info">
              This dish sells for <strong>{money(combo.price, currency)}</strong> as one line on the bill. The dishes
              listed here are only used to take the right ingredients out of stock — they are not priced separately.
            </div>

            {lines.length === 0 ? (
              <EmptyState
                icon="cloche"
                message="Nothing in this combo yet"
                hint={
                  canManage && !blocked
                    ? "Add the dishes that go on the plate, with how many of each."
                    : "This dish is sold on its own, not as a combo."
                }
              />
            ) : (
              <DataGrid
                variant="editor"
                caption={`Dishes in the combo ${product.name}`}
                rows={lines}
                rowKey={(line) => `${line.productId}-${line.productVariantId || ""}`}
                rowClassName={(line) => (line.isAvailable ? "" : "dg-tone-danger")}
                rowNoun={["dish", "dishes"]}
                currency={currency}
                columns={[
                  {
                    key: "dish",
                    header: "Dish",
                    value: (line) => line.productName,
                    render: (line) => (
                      <>
                        <span className="mnu-dish">{line.productName}</span>
                        {line.variantName && <span className="muted"> · {line.variantName}</span>}
                        {!line.isAvailable && (
                          <span className="badge badge-danger status-badge mnu-gap">
                            <span className="badge-dot" aria-hidden="true" />
                            {why(line)}
                          </span>
                        )}
                      </>
                    ),
                  },
                  {
                    key: "quantity",
                    header: "Quantity",
                    type: "number",
                    value: (line) => Number(line.quantity) || 0,
                    render: (line) =>
                      canManage ? (
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={line.quantity}
                          aria-label={`Quantity of ${line.productName}`}
                          onChange={(event) => changeQuantity(lines.indexOf(line), event.target.value)}
                        />
                      ) : (
                        line.quantity
                      ),
                  },
                  {
                    key: "price",
                    header: "If bought alone",
                    type: "money",
                    value: (line) => Number(line.partPrice || 0),
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
                        onClick={() => removeLine(lines.indexOf(line))}
                      >
                        <Icon name="x" size={14} /> Remove
                      </button>
                    ),
                  },
                ]}
                // Two closing lines: what the parts cost one by one, and what the
                // guest saves (or pays extra) by taking the combo.
                footer={(ctx) => {
                  const summary = [
                    { key: "parts", label: "Parts total", amount: partsTotal, tone: "" },
                    {
                      key: "saving",
                      label: saving_ >= 0 ? "Guest saves" : "Combo costs more by",
                      amount: Math.abs(saving_),
                      tone: saving_ >= 0 ? "text-success" : "text-danger",
                    },
                  ];

                  if (ctx.cards) {
                    return (
                      <div className="dg-card dg-card-total" role="group" aria-label="Combo totals">
                        <p className="dg-card-title">Totals</p>
                        <dl className="dg-card-fields">
                          {summary.map((line) => (
                            <div key={line.key} className="dg-card-field align-right">
                              <dt>{line.label}</dt>
                              <dd>
                                <strong className={line.tone || undefined}>{money(line.amount, currency)}</strong>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    );
                  }

                  return summary.map((line) => (
                    <tr key={line.key} className="dg-total-row">
                      {Array.from({ length: ctx.leading }, (_, at) => (
                        <td key={`lead-${at}`} />
                      ))}
                      {ctx.columns.map((column) =>
                        column.key === "dish" ? (
                          <th key={column.key} scope="row" className="dg-total-label">
                            {line.label}
                          </th>
                        ) : column.key === "price" ? (
                          <td key={column.key} className="align-right">
                            <strong className={line.tone || undefined}>{money(line.amount, currency)}</strong>
                          </td>
                        ) : (
                          <td key={column.key} />
                        )
                      )}
                    </tr>
                  ));
                }}
              />
            )}

            {canManage && !blocked && (
              <div className="inline-form mnu-picker mnu-combo-add">
                <select
                  value={pick.productId}
                  onChange={(event) => setPick({ ...pick, productId: event.target.value })}
                  aria-label="Dish to add"
                >
                  <option value="">Add a dish…</option>
                  {choices.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} — {money(row.price, currency)}
                      {row.isAvailable ? "" : " (sold out)"}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  className="inline-number"
                  value={pick.quantity}
                  aria-label="Quantity"
                  onChange={(event) => setPick({ ...pick, quantity: event.target.value })}
                />
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={addLine}
                  disabled={!pick.productId}
                >
                  <Icon name="plus" size={16} /> Add
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
