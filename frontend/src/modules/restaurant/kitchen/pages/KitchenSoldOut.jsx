import { useEffect, useMemo, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { getAvailability, listMarkableDishes, setSoldOut, soldOutKey } from "../../menu/services/availability.service";

// How many search matches are listed at once: enough to find "paneer" among
// a few, short enough to read on a kitchen tablet.
const SHOWN = 12;

const timeOf = (value) =>
  value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

// "86 a dish" from the kitchen. The cook is the first to know the paneer has
// run out; the till must stop selling it straight away. The same switch the
// POS has (PATCH /api/availability), for the business day only: a dish is
// back on sale by itself when the next day opens. A dish with sizes can go
// whole, or one size at a time ("Half biryani is finished, Full is not").
//
// Cooks may mark dishes (menu.availability) without being allowed to open
// the menu, so the dishes come from the availability API, not the menu's.
export default function KitchenSoldOut({ onClose, onChanged }) {
  const [availability, setAvailability] = useState(null);
  const [dishes, setDishes] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState("");
  const [busyKey, setBusyKey] = useState(null);

  useEffect(() => {
    let current = true;

    Promise.all([getAvailability(), listMarkableDishes()])
      .then(([list, rows]) => {
        if (current) {
          setAvailability(list);
          setDishes(rows);
        }
      })
      .catch((err) => {
        if (current) {
          setError(getErrorMessage(err));
        }
      });

    return () => {
      current = false;
    };
  }, []);

  const soldOut = useMemo(
    () => new Set((availability ? availability.items : []).map((item) => soldOutKey(item.productId, item.productVariantId))),
    [availability]
  );

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();

    if (!dishes || term.length === 0) {
      return [];
    }

    return dishes.filter(
      (dish) =>
        dish.name.toLowerCase().includes(term) ||
        (dish.code && dish.code.toLowerCase() === term) ||
        dish.categoryName.toLowerCase().includes(term)
    );
  }, [dishes, search]);

  const change = async (dish, variant, out) => {
    const key = soldOutKey(dish.productId || dish.id, variant ? variant.id : null);

    setBusyKey(key);
    setError("");

    try {
      const result = await setSoldOut({
        productId: dish.productId || dish.id,
        productVariantId: variant ? variant.id : null,
        soldOut: out,
        note: out && note.trim() ? note.trim() : undefined,
      });

      setAvailability(result.data);
      setNote("");
      onChanged(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const items = availability ? availability.items : [];
  const switchedOff = availability ? availability.switchedOff : [];

  return (
    <Modal
      title="Sold out today"
      icon="ban"
      description="Mark a dish the kitchen has run out of. The tills stop selling it at once, and it is back on sale by itself when the next business day opens."
      onClose={onClose}
      width={620}
    >
      <div className="stack kds-soldout">
        <ErrorMessage message={error} />

        {!availability && !error && <Loading label="Loading what is sold out…" />}

        {availability && !availability.businessDay && (
          <p className="alert alert-notice">No business day is open, so nothing can be marked for today yet.</p>
        )}

        <label className="field kds-soldout-search">
          <span>Find a dish</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOpen(null);
            }}
            placeholder="Paneer, biryani, a dish code…"
            autoFocus
          />
        </label>

        {search.trim() && dishes && matches.length === 0 && (
          <p className="muted small">No dish on the menu matches “{search.trim()}”.</p>
        )}

        {matches.length > 0 && (
          <ul className="kds-soldout-results">
            {matches.slice(0, SHOWN).map((dish) => {
              const wholeOut = soldOut.has(soldOutKey(dish.id, null));
              const sizesOut = dish.variants.filter((variant) => soldOut.has(soldOutKey(dish.id, variant.id)));
              const expanded = open === dish.id;

              return (
                <li key={dish.id} className={wholeOut ? "is-out" : ""}>
                  <div className="kds-soldout-row">
                    <div className="kds-soldout-text">
                      <strong>{dish.name}</strong>
                      <span className="muted small">
                        {dish.categoryName}
                        {sizesOut.length > 0 && !wholeOut
                          ? ` · ${sizesOut.map((variant) => variant.name).join(", ")} sold out`
                          : ""}
                      </span>
                    </div>
                    {!dish.isAvailable ? (
                      <span className="badge badge-inactive">Off on the menu</span>
                    ) : wholeOut ? (
                      <button
                        type="button"
                        className="button button-secondary button-sm"
                        onClick={() => change(dish, null, false)}
                        disabled={busyKey !== null}
                      >
                        <Icon name="check" size={15} /> Back on sale
                      </button>
                    ) : dish.variants.length > 0 ? (
                      <button
                        type="button"
                        className={`button button-sm ${expanded ? "" : "button-secondary"}`}
                        onClick={() => setOpen(expanded ? null : dish.id)}
                        aria-expanded={expanded}
                      >
                        <Icon name="ban" size={15} /> Sold out…
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button button-danger button-sm"
                        onClick={() => change(dish, null, true)}
                        disabled={busyKey !== null}
                      >
                        <Icon name="ban" size={15} /> Sold out
                      </button>
                    )}
                  </div>

                  {expanded && (
                    <div className="kds-soldout-sizes">
                      <button
                        type="button"
                        className="button button-danger button-sm"
                        onClick={() => change(dish, null, true)}
                        disabled={busyKey !== null}
                      >
                        Whole dish
                      </button>
                      {dish.variants.map((variant) => {
                        const out = soldOut.has(soldOutKey(dish.id, variant.id));

                        return (
                          <button
                            type="button"
                            key={variant.id}
                            className={`button button-sm ${out ? "" : "button-secondary"}`}
                            onClick={() => change(dish, variant, !out)}
                            disabled={busyKey !== null}
                          >
                            {out ? `${variant.name}: back on sale` : `Only ${variant.name}`}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {matches.length > SHOWN && (
          <p className="muted small">
            {matches.length - SHOWN} more match — type a little more of the name.
          </p>
        )}

        {search.trim() && (
          <label className="field">
            <span>Why (optional, shown to the tills)</span>
            <input
              value={note}
              maxLength={120}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Paneer finished, tandoor down…"
            />
          </label>
        )}

        <section className="stack kds-soldout-now">
          <h3>
            <Icon name="ban" size={16} /> Sold out now
            {items.length > 0 && <span className="kds-soldout-count">{items.length}</span>}
          </h3>
          {availability && items.length === 0 ? (
            <EmptyState icon="check-circle" message="Nothing is sold out." hint="Find a dish above to mark it." />
          ) : (
            <ul className="kds-soldout-list">
              {items.map((item) => (
                <li key={item.id}>
                  <div className="kds-soldout-text">
                    <strong>{item.label}</strong>
                    <span className="muted small">
                      Since {timeOf(item.soldOutAt)}
                      {item.markedByName ? ` · ${item.markedByName}` : ""}
                      {item.note ? ` · ${item.note}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    onClick={() =>
                      change(
                        { productId: item.productId },
                        item.productVariantId ? { id: item.productVariantId } : null,
                        false
                      )
                    }
                    disabled={busyKey !== null}
                  >
                    <Icon name="check" size={15} /> Back on sale
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {switchedOff.length > 0 && (
          <section className="stack kds-soldout-off">
            <h3>
              <Icon name="eye-off" size={16} /> Switched off on the menu
            </h3>
            <p className="muted small">Off until a manager switches them back on under Menu → Products.</p>
            <ul className="kds-soldout-chips">
              {switchedOff.map((item) => (
                <li key={item.productId}>{item.productName}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
