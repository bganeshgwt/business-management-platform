import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import { ErrorMessage, EmptyState } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { setSoldOut, soldOutKey } from "../../menu/services/availability.service";
import { setProductAvailability } from "../../menu/services/menu.service";
import { dayMonth } from "../../../../services/floorTables";

const timeOf = (value) =>
  value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

// The second tap of "86 a dish": what exactly is gone. The whole dish, or one
// size of it ("Half biryani is finished, Full is not"), for today only. A
// dish already out comes back with one tap.
export function DishAvailability({ product, soldOut, loadVariants, onClose, onChanged }) {
  const [variants, setVariants] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    let current = true;

    loadVariants(product.id)
      .then((rows) => {
        if (current) {
          setVariants(rows.filter((row) => row.status === "active"));
        }
      })
      .catch(() => {
        if (current) {
          setVariants([]);
        }
      });

    return () => {
      current = false;
    };
  }, [loadVariants, product.id]);

  const wholeOut = soldOut.has(soldOutKey(product.id, null));

  const change = async (variant, out) => {
    setBusy(true);
    setError("");

    try {
      const result = await setSoldOut({
        productId: product.id,
        productVariantId: variant ? variant.id : null,
        soldOut: out,
        note: out && note.trim() ? note.trim() : undefined,
      });

      onChanged(result.data, result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // A dish switched off on the menu itself is back only when someone
  // switches it on there; staff allowed to may do it from here.
  const switchOn = async () => {
    setBusy(true);
    setError("");

    try {
      await setProductAvailability(product.id, true);
      onChanged(null, `${product.name} is switched on again`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={product.name}
      icon="ban"
      description="Whether it can be ordered today."
      onClose={onClose}
      width={440}
    >
      <div className="stack pos-avail">
        <span className={`badge status-badge pos-avail-now ${!product.isAvailable ? "badge-neutral" : wholeOut ? "badge-danger" : "badge-success"}`}>
          <span className="badge-dot" />
          {!product.isAvailable ? "Switched off on the menu" : wholeOut ? "Sold out today" : "On sale now"}
        </span>
        <ErrorMessage message={error} />

        {!product.isAvailable ? (
          <>
            <p className="muted small">
              This dish is switched off on the menu, so it stays off until someone switches it on.
            </p>
            <button type="button" className="button button-lg" onClick={switchOn} disabled={busy}>
              <Icon name="check" size={17} />
              Switch it back on
            </button>
          </>
        ) : wholeOut ? (
          <>
            <p className="muted small">Sold out for today. It is back on sale by itself when the next business day opens.</p>
            <button type="button" className="button button-lg" onClick={() => change(null, false)} disabled={busy}>
              <Icon name="check" size={17} />
              {busy ? "Saving…" : "Back on sale now"}
            </button>
          </>
        ) : (
          <>
            <p className="muted small">
              Sold out for today only. Nobody can order it until it is put back, and it comes back on sale by itself
              when the next business day opens.
            </p>
            <label className="field">
              <span>Why (optional)</span>
              <input
                value={note}
                maxLength={120}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Paneer finished, tandoor down…"
              />
            </label>
            <div className="pos-avail-options">
              <button type="button" className="button button-danger button-lg" onClick={() => change(null, true)} disabled={busy}>
                <Icon name="ban" size={17} />
                {busy ? "Saving…" : "Whole dish sold out"}
              </button>
              {(variants || []).map((variant) => {
                const out = soldOut.has(soldOutKey(product.id, variant.id));

                return (
                  <button
                    type="button"
                    key={variant.id}
                    className={`button ${out ? "" : "button-secondary"}`}
                    onClick={() => change(variant, !out)}
                    disabled={busy}
                  >
                    <Icon name={out ? "check" : "ban"} size={16} />
                    {out ? `${variant.name}: back on sale` : `Only ${variant.name} sold out`}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// Everything that cannot be sold right now, in one place: tonight's sold-out
// list (with who marked each and when), dishes switched off on the menu, and
// what came back on earlier today.
export function SoldOutPanel({ availability, canSwitch, onClose, onChanged }) {
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState("");

  const backOn = async (item) => {
    const key = soldOutKey(item.productId, item.productVariantId);

    setBusyKey(key);
    setError("");

    try {
      const result = await setSoldOut({
        productId: item.productId,
        productVariantId: item.productVariantId,
        soldOut: false,
      });

      onChanged(result.data, result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const items = availability ? availability.items : [];
  const switchedOff = availability ? availability.switchedOff : [];
  const restored = availability ? availability.backOnToday : [];

  return (
    <Modal
      title="Sold out today"
      icon="ban"
      description={`Marked from the POS or the kitchen. Everything here is back on sale by itself when the next business day opens${
        availability && availability.businessDay ? ` (today is ${dayMonth(availability.businessDay.businessDate)})` : ""
      }.`}
      onClose={onClose}
      width={580}
    >
      <div className="stack pos-soldout">
        <ErrorMessage message={error} />

        {items.length === 0 ? (
          <EmptyState icon="check-circle" message="Nothing is sold out." hint="Tap the ⊘ on a dish to mark it sold out for today." />
        ) : (
          <ul className="pos-soldout-list">
            {items.map((item) => (
              <li key={item.id}>
                <span className="pos-soldout-mark" aria-hidden="true">
                  <Icon name="ban" size={16} />
                </span>
                <div className="pos-soldout-text">
                  <strong>{item.label}</strong>
                  <div className="muted small">
                    Since {timeOf(item.soldOutAt)}
                    {item.markedByName ? ` · ${item.markedByName}` : ""}
                    {item.note ? ` · ${item.note}` : ""}
                  </div>
                </div>
                {canSwitch && (
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    onClick={() => backOn(item)}
                    disabled={busyKey === soldOutKey(item.productId, item.productVariantId)}
                  >
                    <Icon name="check" size={15} />
                    Back on sale
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {switchedOff.length > 0 && (
          <section className="stack pos-soldout-section">
            <h3>
              <Icon name="eye-off" size={16} />
              Switched off on the menu
            </h3>
            <p className="muted small">Off until someone switches them back on (Menu → Products, or the ⊘ on the dish).</p>
            <ul className="pos-soldout-chips">
              {switchedOff.map((item) => (
                <li key={item.productId}>{item.productName}</li>
              ))}
            </ul>
          </section>
        )}

        {restored.length > 0 && (
          <section className="stack pos-soldout-section">
            <h3>
              <Icon name="history" size={16} />
              Back on earlier today
            </h3>
            <ul className="pos-soldout-history">
              {restored.map((item) => (
                <li key={item.id} className="muted small">
                  <strong>{item.label}</strong> out {timeOf(item.soldOutAt)}, back {timeOf(item.backOnAt)}
                  {item.backOnByName ? ` (${item.backOnByName})` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
