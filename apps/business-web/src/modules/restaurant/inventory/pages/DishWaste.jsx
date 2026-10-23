import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import TruncationNotice from "../../../../components/TruncationNotice";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import useShake from "../../../../hooks/useShake";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { dayMonth } from "@bmp/shared/dates";
import { count, money } from "@bmp/shared/format";
import {
  getDishWaste,
  getDishWasteOptions,
  listDishWaste,
  logDishWaste,
  reverseDishWaste,
} from "../services/inventoryInsight.service";
import { qty } from "./stockFormat";
import { Chip, ReasonDialog } from "./stockUi";
import "../../../../styles/backoffice.css";

// Dish wasted: a finished dish thrown away — dropped at the
// pass, made twice and billed once, left over at night, sent back — written
// off by its recipe in one entry instead of ingredient by ingredient. The
// server takes the size's recipe (a combo through its dishes, the add-ons
// picked through theirs, sub-recipes as the prepared items they are) out of
// the outlet's store at cost. Over the write-off limit a manager's PIN is
// asked for, tied to the dish, the plates and the value.

const REASON_TONES = { dropped: "warning", remade: "info", spoiled: "danger", quality: "primary" };
const MAX_PLATES = 500;

// "Main store" reads as it is; an outlet's shelf reads "Kondapur store".
const storeWords = (store) => (!store ? null : /store$/i.test(store) ? store : `${store} store`);

const sizeName = (dish, sizeId) => {
  const size = dish && sizeId ? dish.sizes.find((row) => String(row.id) === String(sizeId)) : null;
  return size ? size.name : null;
};

// Pick a dish by typing a few letters of its name or short code.
function DishPicker({ dishes, value, onChange }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const matches = useMemo(() => {
    const query = text.trim().toLowerCase();
    const found = query
      ? dishes.filter(
          (row) =>
            row.name.toLowerCase().includes(query) ||
            (row.code || "").toLowerCase().includes(query) ||
            (row.category || "").toLowerCase().includes(query)
        )
      : dishes;

    // Names that start with what was typed come first, then dishes with a
    // recipe (the ones that can be written off this way).
    return [...found]
      .sort(
        (a, b) =>
          Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)) ||
          Number(b.hasRecipe) - Number(a.hasRecipe) ||
          a.name.localeCompare(b.name)
      )
      .slice(0, 8);
  }, [dishes, text]);

  if (value) {
    return (
      <div className="ii-picked">
        <span className="ii-picked-main">
          <strong>{value.name}</strong>
          <span className="muted small">
            {[value.category, value.code, value.isCombo ? "combo" : null].filter(Boolean).join(" · ") || "—"}
          </span>
        </span>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setText("");
            onChange(null);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  const pick = (row) => {
    setOpen(false);
    setText("");
    onChange(row);
  };

  return (
    <div className="ii-picker">
      <span className="ii-picker-icon" aria-hidden="true">
        <Icon name="search" size={15} />
      </span>
      <input
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls="bo-dish-list"
        aria-labelledby="bo-dish-label"
        aria-autocomplete="list"
        value={text}
        placeholder={dishes.length ? "Type a dish — paneer tikka, biryani…" : "Loading dishes…"}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setHighlight((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter" && open && matches[highlight]) {
            event.preventDefault();
            pick(matches[highlight]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul className="ii-picker-list" id="bo-dish-list" role="listbox">
          {matches.length === 0 ? (
            <li className="ii-picker-empty muted small">No dish on the menu matches “{text}”.</li>
          ) : (
            matches.map((row, index) => (
              <li
                key={row.id}
                role="option"
                aria-selected={index === highlight}
                className={index === highlight ? "is-active" : ""}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(row);
                }}
                onMouseEnter={() => setHighlight(index)}
              >
                <span>
                  <strong>{row.name}</strong>
                  {row.category && <span className="muted small"> · {row.category}</span>}
                </span>
                <span className={`small ${row.hasRecipe ? "muted" : "text-danger"}`}>
                  {row.hasRecipe ? (row.sizes.length ? `${row.sizes.length} sizes` : "recipe") : "no recipe"}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// The form inside the Log wastage card when "A finished dish" is picked.
export function DishWasteForm({ currency, limit, onLogged }) {
  const [options, setOptions] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [dish, setDish] = useState(null);
  const [sizeId, setSizeId] = useState("");
  const [plates, setPlates] = useState("1");
  const [reason, setReason] = useState("");
  const [addOns, setAddOns] = useState([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const [formRef, shake] = useShake();

  useEffect(() => {
    getDishWasteOptions()
      .then(setOptions)
      .catch((err) => setLoadError(getErrorMessage(err)));
  }, []);

  if (loadError) {
    return <ErrorMessage message={loadError} />;
  }

  if (!options) {
    return <Loading label="Loading the menu…" />;
  }

  const plateCount = Number(plates);
  const platesOk = Number.isInteger(plateCount) && plateCount >= 1 && plateCount <= MAX_PLATES;
  const noRecipe = dish && !dish.hasRecipe;

  const choose = (next) => {
    setDish(next);
    setError("");
    setSizeId(next && next.sizes.length ? String(next.sizes[0].id) : "");
  };

  const refuse = (message) => {
    setError(message);
    shake();
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setDone(null);

    if (!dish) {
      refuse("Pick the dish that was thrown away.");
      return;
    }

    if (noRecipe) {
      refuse(`${dish.name} has no recipe, so there is nothing to take out of stock. Add it under Menu → Products, or log the ingredients one by one.`);
      return;
    }

    if (!platesOk) {
      refuse(`Enter how many plates, a whole number from 1 to ${MAX_PLATES}.`);
      return;
    }

    if (!reason) {
      refuse("Pick why the dish was thrown away.");
      return;
    }

    const size = sizeName(dish, sizeId);
    setBusy(true);

    try {
      const result = await withApproval(
        (headers) =>
          logDishWaste(
            {
              productId: dish.id,
              variantId: sizeId ? Number(sizeId) : null,
              quantity: plateCount,
              reason,
              note: note.trim() || null,
              modifierIds: addOns,
            },
            headers
          ),
        `Write off ${plateCount} × ${dish.name}${size ? ` (${size})` : ""}`
      );

      setDone({ message: result.message, value: result.data.value, entry: result.data });
      setDish(null);
      setSizeId("");
      setPlates("1");
      setReason("");
      setAddOns([]);
      setNote("");
      onLogged(result.data);
    } catch (err) {
      if (!err.approvalCancelled) {
        refuse(getErrorMessage(err));
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const addOnChoices = options.addOns.filter((row) => !addOns.includes(row.id));

  return (
    <form className="ii-log-form bo-dish-form" onSubmit={submit} noValidate ref={formRef}>
      <div className="ii-log-row">
        <div className="field ii-field-item">
          <span id="bo-dish-label">Which dish</span>
          <DishPicker dishes={options.dishes} value={dish} onChange={choose} />
        </div>

        {dish && dish.sizes.length > 0 && (
          <label className="field bo-dish-size">
            <span>Size</span>
            <select value={sizeId} onChange={(event) => setSizeId(event.target.value)}>
              {dish.sizes.map((size) => (
                <option key={size.id} value={size.id}>
                  {size.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field ii-field-qty">
          <span>Plates</span>
          <div className={`ii-qty-input ${plates !== "" && !platesOk ? "is-invalid" : ""}`}>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max={MAX_PLATES}
              step="1"
              value={plates}
              onChange={(event) => setPlates(event.target.value)}
              disabled={!dish}
            />
            <span className="ii-qty-unit">{plateCount === 1 ? "plate" : "plates"}</span>
          </div>
        </label>
      </div>

      {noRecipe && (
        <p className="alert alert-notice bo-dish-warning">
          <Icon name="alert" size={15} /> {dish.name} has no recipe yet, so nothing can be taken out of stock for
          it. Add its recipe under Menu → Products, or switch to “An ingredient” and log what went in the bin.
        </p>
      )}

      <fieldset className="field ii-field-reason">
        <legend>Why</legend>
        <div className="ii-reason-picker" role="radiogroup" aria-label="Why the dish was thrown away">
          {options.reasons.map((option) => (
            <button
              type="button"
              key={option.key}
              role="radio"
              aria-checked={reason === option.key}
              className={`ii-reason-option bo-dish-reason bo-tone-${REASON_TONES[option.key] || "neutral"} ${reason === option.key ? "is-selected" : ""}`}
              onClick={() => setReason(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      {options.addOns.length > 0 && (
        <div className="field bo-dish-addons">
          <span>Add-ons in it <small className="muted">(optional — their recipes come out too)</small></span>
          <div className="bo-chips">
            {addOns.map((id) => {
              const addOn = options.addOns.find((row) => row.id === id);

              return (
                <button
                  type="button"
                  key={id}
                  className="chip-button is-on bo-addon-chip"
                  onClick={() => setAddOns((rows) => rows.filter((row) => row !== id))}
                  aria-label={`Remove ${addOn ? addOn.name : "add-on"}`}
                >
                  {addOn ? addOn.name : id} <Icon name="x" size={12} />
                </button>
              );
            })}
            {addOnChoices.length > 0 && (
              <select
                className="bo-addon-select"
                value=""
                aria-label="Add an add-on"
                onChange={(event) => {
                  const id = Number(event.target.value);

                  if (id) {
                    setAddOns((rows) => [...rows, id]);
                  }
                }}
              >
                <option value="">+ Add an add-on</option>
                {addOnChoices.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}

      <div className="ii-log-row ii-log-row-bottom">
        <label className="field ii-field-note">
          <span>
            Note <small className="muted">(optional)</small>
          </span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={300}
            placeholder="e.g. Table 6 sent it back — too salty"
          />
        </label>

        <div className="ii-log-submit">
          <div className="ii-preview" aria-live="polite">
            <span className="muted small">
              The recipe is taken out of stock at cost.
              {limit !== null && limit !== undefined
                ? ` Over ${money(limit, currency)} a manager's PIN is asked for.`
                : ""}
            </span>
          </div>
          <button type="submit" className="button ii-with-icon" disabled={busy || noRecipe}>
            <Icon name="trash" size={15} /> {busy ? "Writing off…" : "Write off the dish"}
          </button>
        </div>
      </div>

      <ErrorMessage message={error} />
      {done && !error && (
        <p className="alert alert-success ii-done" role="status">
          <Icon name="check" size={15} /> {done.message} · {money(done.value, currency)}
        </p>
      )}
    </form>
  );
}

// Dishes written off in the range: one row a dish, its ingredients a click
// away, undone as a whole by a manager within the week.
export function DishWasteList({ from, to, version, currency, canReverse, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(null);
  const [undoing, setUndoing] = useState(null);

  useEffect(() => {
    listDishWaste({ from, to, limit: 500 })
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [from, to, version, retry]);

  const openEntry = (entry) => {
    setOpen({ entry, detail: null, error: "" });
    getDishWaste(entry.id)
      .then((detail) => setOpen((current) => (current && current.entry.id === entry.id ? { ...current, detail } : current)))
      .catch((err) =>
        setOpen((current) => (current && current.entry.id === entry.id ? { ...current, error: getErrorMessage(err) } : current))
      );
  };

  // Nothing written off as a dish in these dates (or not known yet): the
  // card above says how, and an empty section would only push the page down.
  if (!error && (!data || data.total === 0)) {
    return null;
  }

  const columns = [
    {
      key: "when",
      header: "When",
      type: "date",
      value: (entry) => entry.date,
      render: (entry) => (
        <span className="nowrap">
          <strong>{dayMonth(entry.date)}</strong>
          <span className="muted small"> {dayMonth(entry.loggedAt, { time: true }).split(", ").pop()}</span>
        </span>
      ),
      mobile: "subtitle",
      width: 130,
    },
    {
      key: "dish",
      header: "Dish",
      value: (entry) => entry.itemName,
      pin: true,
      mobile: "title",
      width: 240,
      render: (entry) => (
        <span className="bo-cell-stack">
          <strong>{entry.itemName}</strong>
          {(entry.addons.length > 0 || entry.store) && (
            <span className="muted small">
              {[entry.addons.length ? `+ ${entry.addons.map((row) => row.name).join(", ")}` : null, storeWords(entry.store)]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </span>
      ),
    },
    { key: "plates", header: "Plates", type: "number", value: (entry) => entry.quantity, mobile: "show", width: 90 },
    {
      key: "reason",
      header: "Reason",
      type: "status",
      value: (entry) => entry.reasonLabel,
      render: (entry) => <Chip tone={REASON_TONES[entry.reason]}>{entry.reasonLabel}</Chip>,
      mobile: "show",
    },
    {
      key: "value",
      header: "Value at cost",
      type: "money",
      width: 130,
      value: (entry) => (entry.reversed ? 0 : entry.value),
      render: (entry) => <strong className={entry.reversed ? "bo-struck" : ""}>{money(entry.value, currency)}</strong>,
      total: "sum",
      mobile: "show",
    },
    {
      key: "ingredients",
      header: "Ingredients",
      type: "number",
      width: 120,
      value: (entry) => entry.ingredientLines,
      mobile: "hide",
    },
    {
      key: "by",
      header: "Logged by",
      value: (entry) => entry.loggedBy || "",
      render: (entry) => (
        <span className="bo-cell-stack">
          <span>{entry.loggedBy || "—"}</span>
          {entry.reversed && (
            <span className="muted small">
              Undone{entry.reversedBy ? ` by ${entry.reversedBy}` : ""}
              {entry.reversalNote ? ` — ${entry.reversalNote}` : ""}
            </span>
          )}
        </span>
      ),
    },
  ];

  if (canReverse) {
    columns.push({
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (entry) =>
        entry.reversible ? (
          <button type="button" className="chip-button ii-with-icon" onClick={() => setUndoing(entry)}>
            <Icon name="undo" size={13} /> Undo
          </button>
        ) : null,
    });
  }

  const summary = data ? data.summary : null;

  return (
    <section className="card ii-log bo-dish-list">
      <div className="ii-log-head">
        <div>
          <h2 className="ii-heading">
            <span className="section-card-icon tone-warning" aria-hidden="true">
              <Icon name="utensils" size={18} />
            </span>
            Dishes wasted
          </h2>
          <p className="muted small">
            {summary
              ? `${count(summary.plates)} plate${summary.plates === 1 ? "" : "s"} in ${count(summary.entries)} entr${summary.entries === 1 ? "y" : "ies"} · ${money(summary.value, currency)} at cost. Their ingredients are in the log above, marked “part of a dish”.`
              : "Finished dishes written off by their recipe."}
          </p>
        </div>
      </div>

      {data && <TruncationNotice shown={data.items.length} total={data.total} what="dish write-offs" hint="Narrow the dates to see the rest." />}

      <DataGrid
        id="dish-waste"
        caption="Dishes wasted"
        columns={columns}
        rows={data ? data.items : []}
        rowKey={(entry) => entry.id}
        loading={loading}
        error={error}
        onRetry={() => {
          setLoading(true);
          setRetry((value) => value + 1);
        }}
        empty="No dish written off in these dates."
        emptyIcon="utensils"
        onRowClick={openEntry}
        rowClassName={(entry) => (entry.reversed ? "dg-tone-muted" : "")}
        exportName={`dishes-wasted-${from || "week"}`}
        currency={currency}
      />

      {open && (
        <Modal
          title={`${open.entry.quantity} × ${open.entry.itemName}`}
          description={`${open.entry.reasonLabel} · ${dayMonth(open.entry.loggedAt, { time: true })}${open.entry.loggedBy ? ` · ${open.entry.loggedBy}` : ""}`}
          icon="utensils"
          onClose={() => setOpen(null)}
          width={600}
          footer={
            canReverse && open.entry.reversible ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setUndoing(open.entry);
                  setOpen(null);
                }}
              >
                <Icon name="undo" size={16} /> Undo this write-off
              </button>
            ) : null
          }
        >
          <div className="stack">
            <ErrorMessage message={open.error} />
            {open.entry.note && <p className="muted">“{open.entry.note}”</p>}
            {open.entry.reversed && (
              <p className="alert alert-notice">
                Undone{open.entry.reversedBy ? ` by ${open.entry.reversedBy}` : ""}
                {open.entry.reversalNote ? ` — ${open.entry.reversalNote}` : ""}: everything went back into stock.
              </p>
            )}
            {!open.detail && !open.error ? (
              <Loading label="Loading what it took…" />
            ) : open.detail ? (
              <DataGrid
                id="dish-waste-ingredients"
                caption="What came out of stock"
                variant="compact"
                pageSize={false}
                columns={[
                  { key: "name", header: "Ingredient", value: (line) => line.name, mobile: "title" },
                  {
                    key: "quantity",
                    header: "Quantity",
                    type: "number",
                    value: (line) => line.quantity,
                    render: (line) => qty(line.quantity, line.unit),
                  },
                  { key: "value", header: "At cost", type: "money", exact: true, value: (line) => line.value, total: "sum" },
                ]}
                rows={open.detail.ingredients}
                rowKey={(line) => line.inventoryItemId}
                currency={currency}
              />
            ) : null}
          </div>
        </Modal>
      )}

      {undoing && (
        <ReasonDialog
          title={`Undo ${undoing.quantity} × ${undoing.itemName}?`}
          message={`Every ingredient it took (${money(undoing.value, currency)} at cost) goes back into stock. The entry stays on the list, marked as undone, and leaves every total.`}
          label="Why it is being undone"
          placeholder="e.g. Logged twice by mistake"
          confirmLabel="Put it back in stock"
          danger={false}
          onCancel={() => setUndoing(null)}
          onConfirm={async (note) => {
            await reverseDishWaste(undoing.id, note);
            setUndoing(null);
            setLoading(true);
            setRetry((value) => value + 1);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
